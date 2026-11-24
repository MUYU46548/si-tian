#!/usr/bin/env node
/**
 * Node 单元测试：**删除项目文件**（`projectHandler.js#deleteProjectFile`）
 *
 * 为什么单独一条（2026-11-24）：
 *   用户原话：“‘删除项目’这个功能必须要有，默认移到回收站，否则整个软件都不完整。”
 *   在这之前，产品**没有任何删除项目文件的入口** —— 做完测试项目后只能在资源管理器里
 *   翻 `Documents/SiTianProjects/` 手删。而"删除"是本仓最危险的一类动作
 *   （用户的手绘时间全在里面），所以它必须有**真实落盘**的判据，不能只靠 CDP 用例
 *   （渲染层的 `window.sitianAPI` 是 mock，永远测不到真实文件 I/O）。
 *
 * 判据（每条都对应一个具体的翻车方式）：
 *   a. 正常删除：主文件真的不在原位了 + **备份目录也一起走**（只删主文件会留下孤儿备份，
 *      用户看到的就是"删了还在"）；
 *   b. **必须走回收站**：注入的 `trashItem` 被调用（不是 `unlink`）—— 删错了能捞回来；
 *   c. **keepBackups**：只删主文件、备份目录留存（有人只想清当前文件、历史留底还想留）；
 *   d. **永不静默降级**：`trashItem` 抛错（网络盘/权限）时**原样抛出**，
 *      主文件不许被删掉 —— 绝不"回收失败就换个更狠的删法"；
 *   e. 白名单：不是 `.sitian` 的路径一律拒绝（防路径穿越/误删用户的 md）；
 *   f. 不存在时明确报错（不返回成功让 UI 以为删了）；
 *   g. **硬删被拒**：`hard: true` 不给做（避免误操作；确需彻底删请去回收站清空）；
 *   h. 删完自证：主文件若仍在原位（被占用）→ 报错而不是谎报成功。
 *
 * 用法：node scripts/tests/unit/test_project_delete.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 *
 * 纪律：只在临时目录里写文件（不碰真实库、不碰仓库）。
 */
'use strict';

const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const H = require(path.join(ROOT, 'src', 'main', 'handlers', 'projectHandler.js'));

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => { results.push({ name, ok: true, detail: detail || '' }); })
    .catch((err) => { results.push({ name, ok: false, detail: err && err.message ? err.message : String(err) }); });
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

// 临时目录：逐候选试探（TMP/TEMP 未设时 os.tmpdir() 可能返回 C:\WINDOWS，实测 EPERM）
const TMP_CANDIDATES = [
  process.env.SITIAN_TEST_TMP,
  process.env.TEMP,
  process.env.TMP,
  (() => { try { return os.tmpdir(); } catch (e) { return ''; } })(),
  path.join(os.homedir(), 'AppData', 'Local', 'Temp'),
  path.join(os.homedir(), '.sitian-test-tmp'),
].filter(Boolean);

let TMP = '';
let DIR = '';

async function resolveTmpRoot() {
  const tried = [];
  for (const base of TMP_CANDIDATES) {
    const dir = path.join(base, `sitian-projdel-${Date.now()}-${Math.floor(Math.random() * 1e4)}`);
    try {
      await fsp.mkdir(dir, { recursive: true });
      const probe = path.join(dir, '.write-probe');
      await fsp.writeFile(probe, 'ok', 'utf-8');
      await fsp.unlink(probe);
      TMP = dir;
      DIR = path.join(dir, 'projects');
      await fsp.mkdir(DIR, { recursive: true });
      return;
    } catch (e) {
      tried.push(`${base} → ${e.code || e.message}`);
    }
  }
  throw new Error('找不到可写的临时目录。候选：' + tried.join(' | '));
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch (e) { return false; }
}

/** 造一个「项目文件 + 备份目录（含 1 份备份 + 会话基线）」的真实现场 */
async function makeFixture(name) {
  const filePath = path.join(DIR, `${name}.sitian`);
  const backupDir = H.backupDirFor(filePath);
  await fsp.writeFile(filePath, JSON.stringify({ meta: { name }, entities: {} }), 'utf-8');
  await fsp.mkdir(backupDir, { recursive: true });
  await fsp.writeFile(path.join(backupDir, `${name}-2026-01-01.sitian`), '{}', 'utf-8');
  await fsp.writeFile(path.join(backupDir, `${name}.session-baseline.sitian`), '{}', 'utf-8');
  return { filePath, backupDir, name };
}

/** 假的回收站：把路径记下来，并把文件真的挪进一个"回收站目录"（模拟删除后的状态） */
function makeTrash(binDir) {
  const calls = [];
  const trashItem = async (p) => {
    calls.push(p);
    const dest = path.join(binDir, path.basename(p) + '-' + calls.length);
    await fsp.rename(p, dest);      // rename 目录也成立；跨盘时真实 shell.trashItem 才需要特殊处理
  };
  return { trashItem, calls };
}

async function main() {
  await resolveTmpRoot();
  const binDir = path.join(TMP, 'recycle-bin');
  await fsp.mkdir(binDir, { recursive: true });

  // ── a + b：正常删除 → 主文件与备份目录一起走，且确实走的是 trashItem ──────────
  await check('a/b 正常删除：主文件 + 备份目录都进回收站（不是 unlink）', async () => {
    const fx = await makeFixture('alpha');
    const trash = makeTrash(binDir);
    const res = await H.deleteProjectFile({ filePath: fx.filePath }, trash.trashItem);
    eq(res.success, true, 'success');
    eq(res.mode, 'trash', 'mode');
    assert(!(await exists(fx.filePath)), '主文件仍在原位——没删掉');
    assert(!(await exists(fx.backupDir)), '备份目录仍在原位——只删了主文件，会留下孤儿备份');
    eq(trash.calls.length, 2, 'trashItem 调用次数（主文件 + 备份目录）');
    assert(trash.calls.includes(fx.filePath), 'trashItem 没收到主文件路径');
    assert(trash.calls.includes(fx.backupDir), 'trashItem 没收到备份目录路径');
    return '两个路径都进了回收站';
  });

  // ── c：keepBackups ────────────────────────────────────────────────────────
  await check('c keepBackups：只删主文件，备份历史保留', async () => {
    const fx = await makeFixture('beta');
    const trash = makeTrash(binDir);
    const res = await H.deleteProjectFile({ filePath: fx.filePath, keepBackups: true }, trash.trashItem);
    eq(res.success, true, 'success');
    assert(!(await exists(fx.filePath)), '主文件仍在原位');
    assert(await exists(fx.backupDir), '备份目录被删了（keepBackups=true 时应保留）');
    eq(res.keptBackups.length, 1, 'keptBackups 长度');
    eq(trash.calls.length, 1, 'trashItem 只应被调 1 次');
    return '备份目录留存';
  });

  // ── d：永不静默降级 ───────────────────────────────────────────────────────
  await check('d 回收站失败时原样报错，且主文件不许被删', async () => {
    const fx = await makeFixture('gamma');
    const boom = async () => { throw new Error('EBUSY: 资源被占用（模拟网络盘/权限不足）'); };
    let caught = null;
    try {
      await H.deleteProjectFile({ filePath: fx.filePath }, boom);
    } catch (e) { caught = e; }
    assert(caught, 'trashItem 失败却没抛错（会谎报成功）');
    assert(/EBUSY/.test(caught.message), `错误信息没透出原始原因：${caught.message}`);
    assert(await exists(fx.filePath), '回收失败却把主文件删了——违背"绝不静默降级成真删"');
    return '原样抛出 + 文件还在';
  });

  // ── e：白名单 ────────────────────────────────────────────────────────────
  await check('e 非 .sitian 路径一律拒绝', async () => {
    const mdPath = path.join(DIR, '笔记.md');
    await fsp.writeFile(mdPath, '# 我不想被删', 'utf-8');
    const trash = makeTrash(binDir);
    let caught = null;
    try {
      await H.deleteProjectFile({ filePath: mdPath }, trash.trashItem);
    } catch (e) { caught = e; }
    assert(caught, '.md 路径没被拒绝');
    assert(/不是司天项目文件/.test(caught.message), `拒绝原因不清晰：${caught.message}`);
    assert(await exists(mdPath), '用户的 md 被删了');
    eq(trash.calls.length, 0, 'trashItem 不该被调用');
    return '拒绝 + 文件完好';
  });

  // ── f：不存在 ────────────────────────────────────────────────────────────
  await check('f 文件不存在时明确报错（不谎报成功）', async () => {
    const ghost = path.join(DIR, 'ghost.sitian');
    const trash = makeTrash(binDir);
    let caught = null;
    try {
      await H.deleteProjectFile({ filePath: ghost }, trash.trashItem);
    } catch (e) { caught = e; }
    assert(caught, '不存在的文件却返回成功');
    assert(/不存在/.test(caught.message), `报错不清：${caught.message}`);
    return '明确报错';
  });

  // ── g：硬删被拒 ──────────────────────────────────────────────────────────
  await check('g hard:true 被拒绝（不做永久删除）', async () => {
    const fx = await makeFixture('delta');
    const trash = makeTrash(binDir);
    let caught = null;
    try {
      await H.deleteProjectFile({ filePath: fx.filePath, hard: true }, trash.trashItem);
    } catch (e) { caught = e; }
    assert(caught, 'hard:true 没被拒');
    assert(/永久删除/.test(caught.message), `拒绝理由不清：${caught.message}`);
    assert(await exists(fx.filePath), '被拒绝了却把文件删了');
    eq(trash.calls.length, 0, 'trashItem 不该被调用');
    return '拒绝 + 文件完好';
  });

  // ── h：删完自证（trashItem 假装成功但文件没动）────────────────────────────
  await check('h trashItem 没真删时不许谎报成功', async () => {
    const fx = await makeFixture('epsilon');
    const noop = async () => { /* 假装成功：什么都没做 */ };
    let caught = null;
    try {
      await H.deleteProjectFile({ filePath: fx.filePath }, noop);
    } catch (e) { caught = e; }
    assert(caught, '文件还在原位却返回成功（UI 会显示已删，下一次保存又写回来）');
    assert(/仍在原位/.test(caught.message), `报错不清：${caught.message}`);
    return '自证抓到"假删"';
  });

  // ── 只有备份目录时也能删（主文件已被用户手删的现场）──────────────────────
  await check('i 主文件已不在、只剩备份目录 → 仍然可以清掉', async () => {
    const fx = await makeFixture('zeta');
    await fsp.unlink(fx.filePath);            // 模拟"用户已经在资源管理器里删了主文件"
    const trash = makeTrash(binDir);
    const res = await H.deleteProjectFile({ filePath: fx.filePath }, trash.trashItem);
    eq(res.success, true, 'success');
    assert(!(await exists(fx.backupDir)), '剩下那坨孤儿备份没被清掉');
    eq(trash.calls.length, 1, '只该处理备份目录');
    return '孤儿备份被清';
  });

  // ── 渲染层接线（静态）：preload / store / UI 三处都在 ──────────────────────
  await check('j 接线：preload + store + 面板三处齐备', async () => {
    const preload = require('fs').readFileSync(path.join(ROOT, 'src', 'preload', 'index.js'), 'utf-8');
    assert(/projectDelete:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('project-delete'/.test(preload),
      'preload 没暴露 projectDelete');
    const store = require('fs').readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'store', 'projectStore.js'), 'utf-8');
    assert(/async function deleteProject\(/.test(store), 'projectStore 没有 deleteProject');
    assert(/refreshProjectList, chooseProjectDir, revealProject, deleteProject/.test(store),
      'deleteProject 没导出（面板调不到）');
    // 🔴 关键：关项目必须在删文件之前（否则下一次自动保存会把文件写回来）
    const closeIdx = store.indexOf('await closeProject()');
    const delIdx = store.indexOf('a.projectDelete(');
    assert(closeIdx > 0 && delIdx > 0 && closeIdx < delIdx, 'store 里"先关项目、再删文件"的顺序被打乱了');
    const panel = require('fs').readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'components', 'ProjectPanel.vue'), 'utf-8');
    assert(/askDeleteProject/.test(panel) && /confirmDeleteProject/.test(panel), '面板没有删除入口/确认');
    assert(/pp-delete-confirm-btn/.test(panel), '面板缺确认按钮（data-testid）');
    return 'preload / store / 面板 齐备，且顺序正确';
  });

  // 清理
  try { await fsp.rm(TMP, { recursive: true, force: true }); } catch (e) { /* 清不掉不影响结论 */ }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ 测试自身失败：', err);
  process.exit(1);
});
