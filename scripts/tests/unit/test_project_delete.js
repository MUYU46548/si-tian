#!/usr/bin/env node
/**
 * Node 单元测试：**删除项目 + 撤回**（`projectHandler.js`）
 *
 * 用户拍板两次（2026-11-24）：
 *   ① 「删除项目这个功能必须要有，默认移到回收站，否则整个软件都不完整。」
 *   ② 「还原没做，因为司天内根本没还原按钮。你难道指望用户去回收站自己找（可能有几千个文件）？
 *       另外可以学同系列产品弄个输入项目名全名再确认删除。」
 *
 * 所以口径是**应用自有回收站**：`<项目目录>/.sitian-trash/<时间戳>/`，
 * 删完在应用里点"撤回"就原样搬回原位。这条用例守的就是"搬得走、也搬得回来"，
 * 以及"中途失败不许留半删状态"。
 *
 * 判据（每条对应一个具体的翻车方式）：
 *   a. 正常删除：主文件与备份目录都从原位移走，且出现在回收站里
 *   b. **撤回**：文件与备份都回到原位、内容逐字节一致、回收站条目被清掉
 *   c. keepBackups：只搬主文件，备份目录留在原地
 *   d. **中途失败必须回滚**：模拟第二步失败 → 第一步搬走的要搬回来，不留半删
 *   e. 白名单：非 .sitian 一律拒绝
 *   f. 不存在时明确报错（不谎报成功）
 *   g. hard:true 被拒绝（不做永久删除）
 *   h. 只删一个动作 = 一个条目；多个项目各删一次 = 两个条目，撤回最近的那个
 *   i. 主文件已被用户手删、只剩备份目录时也能收
 *   j. 原位置已存在同名文件时，撤回**拒绝覆盖**（数据安全）
 *   k. 回收站轮转：超过 TRASH_KEEP 份只留最近的
 *   l. 接线：preload / store / 面板三处齐备，且"先关项目再删"的顺序没被打乱
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
const fs = require('fs');
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

/** 造一个「项目文件 + 备份目录（1 份备份 + 会话基线）」的真实现场 */
async function makeFixture(name, content = null) {
  const filePath = path.join(DIR, `${name}.sitian`);
  const backupDir = H.backupDirFor(filePath);
  const body = content || JSON.stringify({ meta: { name }, entities: { a: { id: 'a', name } } });
  await fsp.writeFile(filePath, body, 'utf-8');
  await fsp.mkdir(backupDir, { recursive: true });
  await fsp.writeFile(path.join(backupDir, `${name}-2026-01-01.sitian`), '{"backup":true}', 'utf-8');
  await fsp.writeFile(path.join(backupDir, `${name}.session-baseline.sitian`), '{"baseline":true}', 'utf-8');
  return { filePath, backupDir, name, body };
}

async function main() {
  await resolveTmpRoot();

  // ── a + b：删得走，也搬得回来 ─────────────────────────────────────────────
  await check('a/b 删除 → 进应用回收站；撤回 → 原样回到原位（逐字节一致）', async () => {
    const fx = await makeFixture('alpha');
    const before = await fsp.readFile(fx.filePath, 'utf-8');

    const res = await H.deleteProjectFile({ filePath: fx.filePath });
    eq(res.success, true, 'success');
    eq(res.mode, 'app-trash', 'mode');
    assert(!(await exists(fx.filePath)), '主文件仍在原位——没删掉');
    assert(!(await exists(fx.backupDir)), '备份目录仍在原位——只删了主文件');
    assert(await exists(res.trashDir), '回收站条目目录没建出来');
    assert(await exists(path.join(res.trashDir, 'meta.json')), '回收站条目缺 meta.json（撤回就不知道原位了）');

    // 撤回
    const back = await H.restoreDeletedProject({ filePath: fx.filePath });
    eq(back.success, true, '撤回 success');
    assert(await exists(fx.filePath), '撤回后主文件没回来');
    assert(await exists(fx.backupDir), '撤回后备份目录没回来');
    const after = await fsp.readFile(fx.filePath, 'utf-8');
    eq(after, before, '撤回后内容与删除前不一致');
    assert(!(await exists(res.trashDir)), '撤回后回收站条目没被清掉（会越积越多）');
    return '删除→撤回，内容逐字节一致';
  });

  // ── c：keepBackups ────────────────────────────────────────────────────────
  await check('c keepBackups：只搬主文件，备份历史留在原地', async () => {
    const fx = await makeFixture('beta');
    const res = await H.deleteProjectFile({ filePath: fx.filePath, keepBackups: true });
    eq(res.success, true, 'success');
    assert(!(await exists(fx.filePath)), '主文件仍在原位');
    assert(await exists(fx.backupDir), '备份目录被搬走了（keepBackups=true 时应留下）');
    eq(res.keptBackups.length, 1, 'keptBackups 长度');
    return '备份目录留存';
  });

  // ── d：中途失败必须回滚 ───────────────────────────────────────────────────
  await check('d 第二步失败 → 第一步搬走的东西必须搬回来（不留半删）', async () => {
    const fx = await makeFixture('gamma');
    // 让备份目录"搬不动"：把它的父目录权限拿掉不现实（Windows），
    // 改用**占位目标**：预先在回收站里放一个同名备份目录，让 rename 失败。
    const root = H.trashRootFor(fx.filePath);
    // 先删一次拿到 entryId 的生成方式不可预知，改为：直接让 backupDir 变成一个删不掉的东西
    // —— 更稳的做法：把 backups 目录替换成一个**只读文件**，rename 一个目录到"已存在的文件"上会失败。
    // 这里用最直接的一招：在记账前把 backupDir 改名成别的，制造"存在判定通过但搬不动"的竞态太脆，
    // 所以改成显式打桩：让 fs.rename 对 backups 路径抛错。
    const realRename = fsp.rename;
    let threw = null;
    const original = fsp.rename;
    // 只拦 backups 目录的 rename
    fsp.rename = async (from, to) => {
      if (String(from).endsWith('.sitian.backups')) {
        const e = new Error('ENOTEMPTY: 模拟搬不动');
        e.code = 'ENOTEMPTY';
        throw e;
      }
      return original.call(fsp, from, to);
    };
    let err = null;
    try {
      await H.deleteProjectFile({ filePath: fx.filePath });
    } catch (e) {
      err = e;
    } finally {
      fsp.rename = original;
    }
    assert(err, '备份目录搬不动却没抛错');
    // 回滚判据：主文件必须还在原位（第一步已搬走，应被搬回）
    assert(await exists(fx.filePath), '回滚失败：主文件没搬回原位（这就是"删了一半"）');
    const body = await fsp.readFile(fx.filePath, 'utf-8');
    assert(body.length > 0, '回滚后主文件是空的');
    return '失败后回滚：主文件完好回到原位';
  });

  // ── e：白名单 ────────────────────────────────────────────────────────────
  await check('e 非 .sitian 路径一律拒绝', async () => {
    const mdPath = path.join(DIR, '笔记.md');
    await fsp.writeFile(mdPath, '# 我不想被删', 'utf-8');
    let caught = null;
    try { await H.deleteProjectFile({ filePath: mdPath }); } catch (e) { caught = e; }
    assert(caught, '.md 路径没被拒绝');
    assert(/不是司天项目文件/.test(caught.message), `拒绝原因不清晰：${caught.message}`);
    assert(await exists(mdPath), '用户的 md 被删了');
    return '拒绝 + 文件完好';
  });

  // ── f：不存在 ────────────────────────────────────────────────────────────
  await check('f 文件不存在时明确报错（不谎报成功）', async () => {
    const ghost = path.join(DIR, 'ghost.sitian');
    let caught = null;
    try { await H.deleteProjectFile({ filePath: ghost }); } catch (e) { caught = e; }
    assert(caught, '不存在的文件却返回成功');
    assert(/不存在/.test(caught.message), `报错不清：${caught.message}`);
    return '明确报错';
  });

  // ── g：硬删被拒 ──────────────────────────────────────────────────────────
  await check('g hard:true 被拒绝（不做永久删除）', async () => {
    const fx = await makeFixture('delta');
    let caught = null;
    try { await H.deleteProjectFile({ filePath: fx.filePath, hard: true }); } catch (e) { caught = e; }
    assert(caught, 'hard:true 没被拒');
    assert(/永久删除/.test(caught.message), `拒绝理由不清：${caught.message}`);
    assert(await exists(fx.filePath), '被拒绝了却把文件删了');
    return '拒绝 + 文件完好';
  });

  // ── h：多个条目，撤回最近的那个 ───────────────────────────────────────────
  await check('h 两次删除 = 两个条目；默认撤回**最近**那个', async () => {
    const d2 = path.join(TMP, 'proj2');
    await fsp.mkdir(d2, { recursive: true });
    const oldDir = DIR;
    DIR = d2;
    const first = await makeFixture('first');
    await H.deleteProjectFile({ filePath: first.filePath });
    await new Promise((r) => setTimeout(r, 20));   // 确保时间戳不同（目录名是 ms 级）
    const second = await makeFixture('second');
    const r2 = await H.deleteProjectFile({ filePath: second.filePath });

    const list = await H.listDeletedProjects({ dir: d2 });
    assert(list.items.length === 2, `回收站条目数 期望 2，实际 ${list.items.length}`);

    // 不复位 DIR 就会被 makeFixture 写进 d2 —— 这里撤回第二个
    const back = await H.restoreDeletedProject({ filePath: second.filePath });
    eq(back.entryId, r2.entryId, '撤回的不是最近那条');
    assert(await exists(second.filePath), '最近那条没搬回来');
    assert(!(await exists(first.filePath)), '旧的那条不该被搬回');
    DIR = oldDir;
    return '两个条目，撤回最近那条';
  });

  // ── i：只剩备份目录 ──────────────────────────────────────────────────────
  await check('i 主文件已被手删、只剩备份目录 → 也能收（并登记）', async () => {
    const fx = await makeFixture('zeta');
    await fsp.unlink(fx.filePath);
    const res = await H.deleteProjectFile({ filePath: fx.filePath });
    eq(res.success, true, 'success');
    assert(!(await exists(fx.backupDir)), '孤儿备份没被收走');
    return '孤儿备份被收进回收站';
  });

  // ── j：撤回不覆盖 ────────────────────────────────────────────────────────
  await check('j 原位已有同名文件时，撤回**拒绝覆盖**（数据安全）', async () => {
    const fx = await makeFixture('eta');
    await H.deleteProjectFile({ filePath: fx.filePath });
    // 用户在原位又建了一个同名项目
    await fsp.writeFile(fx.filePath, '{"new":"project"}', 'utf-8');
    let caught = null;
    try { await H.restoreDeletedProject({ filePath: fx.filePath }); } catch (e) { caught = e; }
    assert(caught, '同名冲突却没报错（会静默覆盖用户的新项目）');
    assert(/不能覆盖/.test(caught.message), `拒绝理由不清：${caught.message}`);
    const now = await fsp.readFile(fx.filePath, 'utf-8');
    eq(now, '{"new":"project"}', '用户的新项目被覆盖了');
    return '拒绝覆盖 + 新项目完好';
  });

  // ── k：轮转 ──────────────────────────────────────────────────────────────
  await check('k 回收站轮转：超过 TRASH_KEEP 份只留最近的', async () => {
    const d3 = path.join(TMP, 'proj3');
    await fsp.mkdir(d3, { recursive: true });
    const oldDir = DIR;
    DIR = d3;
    const keep = H.TRASH_KEEP;
    assert(typeof keep === 'number' && keep > 0, 'TRASH_KEEP 不是正数');
    // 造 keep + 3 次删除
    for (let i = 0; i < keep + 3; i++) {
      const fx = await makeFixture('rot' + i);
      await H.deleteProjectFile({ filePath: fx.filePath });
      await new Promise((r) => setTimeout(r, 5));
    }
    const list = await H.listDeletedProjects({ dir: d3 });
    assert(list.items.length <= keep, `回收站条目数 ${list.items.length} 超过上限 ${keep}（没轮转）`);
    DIR = oldDir;
    return `轮转生效：留 ${list.items.length} 份 ≤ ${keep}`;
  });

  // ── l：接线与顺序 ────────────────────────────────────────────────────────
  await check('l 接线：preload + store + 面板齐备，且"先关项目再删"顺序没乱', async () => {
    const preload = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'index.js'), 'utf-8');
    assert(/projectDelete:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('project-delete'/.test(preload),
      'preload 没暴露 projectDelete');
    assert(/projectRestoreDeleted:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('project-restore-deleted'/.test(preload),
      'preload 没暴露 projectRestoreDeleted（撤回按钮调不到）');
    const store = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'store', 'projectStore.js'), 'utf-8');
    assert(/async function deleteProject\(/.test(store), 'projectStore 没有 deleteProject');
    assert(/async function restoreDeletedProject\(/.test(store), 'projectStore 没有 restoreDeletedProject');
    // 🔴 关键：关项目必须在删文件之前（否则下一次自动保存会把文件写回来）
    const closeIdx = store.indexOf('await closeProject()');
    const delIdx = store.indexOf('a.projectDelete(');
    assert(closeIdx > 0 && delIdx > 0 && closeIdx < delIdx, 'store 里"先关项目、再删文件"的顺序被打乱了');
    const panel = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'components', 'ProjectPanel.vue'), 'utf-8');
    assert(/askDeleteProject/.test(panel) && /confirmDeleteProject/.test(panel), '面板没有删除入口/确认');
    assert(/restoreDeletedProject/.test(panel), '面板没有"撤回"入口');
    assert(/pp-delete-confirm-btn/.test(panel), '面板缺确认按钮（data-testid）');
    return 'preload / store / 面板齐备；先关后删顺序正确';
  });

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
