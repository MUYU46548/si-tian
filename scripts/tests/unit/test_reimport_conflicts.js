#!/usr/bin/env node
/**
 * Node 单元测试：并省冲突的“逐条裁决”（B3，2026-11-05）
 *
 * 为什么值得单独守：
 *   ① 以前多个旧省并成一个新省时只能**整单拒绝** —— 用户没出路。现在给了三条出路
 *      （保留某一个旧省的归属 / 合并 / 都不要），但**默认仍然拒绝**（不替用户选）。
 *      这条“默认拒绝”一旦被谁顺手改成“默认合并”，数据在用户不知情时就被覆盖了，而且不报错。
 *   ② 裁决要改 `mapping.byOld` —— 改错了不会崩，只会**把别的省的地也丢掉**（拆省一人多新时尤其隐蔽）。
 *
 * 用法：node scripts/tests/unit/test_reimport_conflicts.js
 * 退出码：0 = 全通过。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
// 与 test_basemap_identity 同一份依赖清单（少一个文件 → ERR_MODULE_NOT_FOUND，表现为“无输出”）
const DEPS = ['basemapIdentity.js', 'provinceShape.js', 'geometry.js', 'gridOutline.js',
  'polylineSmooth.js', 'labelOrient.js', 'polityLabels.js'];

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function deepEq(actual, expected, label) {
  const a = JSON.stringify(actual); const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: 期望 ${b}，实际 ${a}`);
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}
function pickTmpRoot() {
  const cands = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : '',
    os.tmpdir(), process.env.TEMP, process.env.TMP, os.homedir(),
  ];
  for (const c of cands) {
    if (!c || !path.isAbsolute(c)) continue;
    if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(c)) continue;
    try { fs.mkdirSync(c, { recursive: true }); fs.accessSync(c, fs.constants.W_OK); return c; } catch (_) { /* 下一个 */ }
  }
  return null;
}

/** 一份典型映射：n1 是“两个旧省并成一个新省”（冲突）；o3 是“一个旧省拆成两个新省”（允许） */
function baseMapping() {
  return {
    byOld: { o1: ['n1'], o2: ['n1'], o3: ['n2', 'n3'] },
    byNew: { n1: ['o1', 'o2'], n2: ['o3'], n3: ['o3'] },
    exact: [],
    conflicts: [{ newId: 'n1', oldIds: ['o1', 'o2'] }],
    unmappedOld: [],
    unmappedNew: [],
  };
}

async function main() {
  const root = pickTmpRoot();
  if (!root) throw new Error('找不到可写的临时目录');
  const tmp = fs.mkdtempSync(path.join(root, 'sitian-reimport-conflicts-'));
  for (const f of DEPS) {
    fs.writeFileSync(path.join(tmp, f), fs.readFileSync(path.join(SRC_DIR, f), 'utf8')
      .replace(/from '\.\/([A-Za-z0-9_-]+)(?:\.js)?'/g, "from './$1.js'"));
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const M = await import(pathToFileURL(path.join(tmp, 'basemapIdentity.js')).href);
  const {
    unresolvedConflicts, applyConflictChoices, describeConflicts,
    CONFLICT_MERGE, CONFLICT_DROP,
  } = M;

  // ── 默认仍然是拒绝（不替用户选）────────────────────────────────────────
  check('c1 🔴 一条都没选 → 全部算未决（默认拒绝，不许悄悄合并）', () => {
    const map = baseMapping();
    deepEq(unresolvedConflicts(map, {}), ['n1'], '空 choices');
    deepEq(unresolvedConflicts(map, null), ['n1'], 'null choices');
    // 没有冲突时永远是空（不影响正常重导）
    deepEq(unresolvedConflicts({ conflicts: [] }, {}), [], '无冲突');
    return '空/无冲突';
  });

  check('c2 三种裁决都算“已决”；瞎写的值不算', () => {
    const map = baseMapping();
    deepEq(unresolvedConflicts(map, { n1: 'o2' }), [], '保留某个旧省');
    deepEq(unresolvedConflicts(map, { n1: CONFLICT_MERGE }), [], '合并');
    deepEq(unresolvedConflicts(map, { n1: CONFLICT_DROP }), [], '都不要');
    deepEq(unresolvedConflicts(map, { n1: 'not-a-real-old' }), ['n1'], '非法旧省 id → 仍算未决');
    return '3 已决 + 1 非法';
  });

  // ── 裁决改写映射 ────────────────────────────────────────────────────────
  check('c3 保留某一个旧省：只留它 → 新省；其它旧省不再映射到这省（其余映射不动）', () => {
    const map = baseMapping();
    const out = applyConflictChoices(map, { n1: 'o2' });
    deepEq(out.byNew.n1, ['o2'], 'n1 只留 o2');
    deepEq(out.byOld.o1, [], 'o1 不再映射到 n1');
    deepEq(out.byOld.o2, ['n1'], 'o2 保留');
    deepEq(out.byOld.o3, ['n2', 'n3'], '🔴 拆省的映射一个字都不许动');
    deepEq(out.byNew.n2, ['o3'], 'n2 不动');
    return 'n1←o2，拆省不变';
  });

  check('c4 都不要：新省无主；所有旧省都不再指向它', () => {
    const map = baseMapping();
    const out = applyConflictChoices(map, { n1: CONFLICT_DROP });
    deepEq(out.byNew.n1, [], 'n1 无来源');
    deepEq(out.byOld.o1, [], 'o1 丢弃');
    deepEq(out.byOld.o2, [], 'o2 丢弃');
    deepEq(out.byOld.o3, ['n2', 'n3'], '拆省照旧');
    return 'n1 清空';
  });

  check('c5 合并 / 未选：映射原样（历史语义：后者覆盖前者）', () => {
    const map = baseMapping();
    deepEq(applyConflictChoices(map, { n1: CONFLICT_MERGE }).byNew.n1, ['o1', 'o2'], '合并');
    deepEq(applyConflictChoices(map, {}).byNew.n1, ['o1', 'o2'], '未选 = 原样');
    return '2 例';
  });

  check('c6 🔴 纯函数：入参 mapping 不许被改（调用方还要拿原表做展示）', () => {
    const map = baseMapping();
    const snapshot = JSON.stringify(map);
    applyConflictChoices(map, { n1: 'o1' });
    applyConflictChoices(map, { n1: CONFLICT_DROP });
    eq(JSON.stringify(map), snapshot, 'mapping 被原地改了');
    return '入参零改动';
  });

  check('c7 describeConflicts：名字缺省回 id（绝不空串）', () => {
    const rows = describeConflicts(baseMapping().conflicts, (id) => (id === 'o1' ? '旧甲' : ''), () => '新乙');
    eq(rows.length, 1, '一条冲突');
    eq(rows[0].newName, '新乙', '新省名');
    eq(rows[0].candidates[0].name, '旧甲', '旧省名');
    eq(rows[0].candidates[1].name, 'o2', '空名字回 id');
    return '名字回退';
  });

  // ── 接线：三处必须共用同一份判据 ────────────────────────────────────────
  const store = read('src/renderer/src/store/geodataModules/scenarioEditing.js');
  const helpers = read('src/renderer/src/scenario/interaction/helpers.js');
  const dlg = read('src/renderer/src/components/ReimportDialog.vue');

  check('c8 store：先拦未决、再应用裁决（两处都走纯函数）', () => {
    assert(/unresolvedConflicts\(mapping0, choices\)/.test(store), 'store 没有用 unresolvedConflicts 拦');
    assert(store.includes('applyConflictChoices(mapping0, choices)'), 'store 没有用 applyConflictChoices 应用');
    assert(store.includes('conflictChoices'), 'store 没接收 conflictChoices');
    return '拦 + 应用';
  });

  check('c9 helpers：应用前也查同一份未决（不许绕过对话框直接写）', () => {
    assert(helpers.includes('unresolvedConflicts('), 'helpers 没查未决');
    assert(/conflictChoices: d\.conflictChoices/.test(helpers), 'helpers 没把裁决传给 store');
    assert(helpers.includes('function setReimportConflictChoice('), 'helpers 没有裁决写点');
    return '同一判据';
  });

  check('c10 对话框：只 emit，不直接改 props / 不碰 store', () => {
    for (const ev of ['apply', 'close', 'choose', 'toggle-reference']) {
      assert(dlg.includes(`'${ev}'`), `defineEmits 缺 ${ev}`);
    }
    assert(!/store\./.test(dlg), '对话框里直接用了 store（应只 emit）');
    assert(!/props\.state\.[a-zA-Z]+\s*=/.test(dlg), '对话框直接改 props.state（应 emit 给父级）');
    assert(dlg.includes('data-testid="reimport-dialog"'), '对话框缺 data-testid="reimport-dialog"（用例/守卫靠它）');
    return '只转发';
  });

  // ── 汇总 ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log('=== 并省冲突逐条裁决（B3）Node 单元测试 ===');
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('单元测试运行器异常:', err);
  process.exit(1);
});
