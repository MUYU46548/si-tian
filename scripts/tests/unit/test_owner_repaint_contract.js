#!/usr/bin/env node
/**
 * Node 单元测试：涂归属一笔**不再重复整图重绘**（A4，2026-11-05）
 *
 * 为什么值得单独守：
 *   ① 松手同步段的 51ms 里，真正属于写数据的只有 3.3ms —— 剩下是**两遍整图重绘**
 *      （pointer 里一次 + `watch(sortedScenarios)` 同帧 pre-flush 再一次）。这一刀很容易被
 *      “顺手加回一行 render()” 打回原形，而且**不会报错**：只是慢。
 *   ② 时间轴重算加了纯函数缓存（`groupMap` 按 ownership 引用、`normalizeScenarioDates` 按剧本对象）。
 *      缓存写错不会报错，只会“改了一段、另一段还是旧值”这种**静默错数据** —— 必须有负向探针。
 *
 * 用法：node scripts/tests/unit/test_owner_repaint_contract.js
 * 退出码：0 = 全通过。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const DEPS = ['scenarioDates.js', 'scenarioTimeline.js'];

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
/** 读源码并归一化换行（index 是 LF、工作树是 CRLF —— 不归一化切片会失败 → 假红） */
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
    try {
      fs.mkdirSync(c, { recursive: true });
      fs.accessSync(c, fs.constants.W_OK);
      return c;
    } catch (_) { /* 换下一个 */ }
  }
  return null;
}
function stage(tmp) {
  const fixExt = (src) => src.replace(/from '\.\/([A-Za-z0-9_-]+)(?:\.js)?'/g, "from './$1.js'");
  for (const f of DEPS) {
    fs.writeFileSync(path.join(tmp, f), fixExt(fs.readFileSync(path.join(SRC_DIR, f), 'utf8')));
  }
}
function scen(id, start, end, ownership, polities) {
  return {
    id, name: id, order: start, era: { roman: '', label: id, startYear: String(start), endYear: String(end) },
    polities: polities || [], ownership: ownership || {},
  };
}

async function main() {
  const root = pickTmpRoot();
  if (!root) throw new Error('找不到可写的临时目录');
  const tmp = fs.mkdtempSync(path.join(root, 'sitian-owner-repaint-'));
  stage(tmp);
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const D = await import(pathToFileURL(path.join(tmp, 'scenarioDates.js')).href);
  const T = await import(pathToFileURL(path.join(tmp, 'scenarioTimeline.js')).href);
  const { groupMap, buildTimeline } = T;
  const { normalizeScenarioDates } = D;

  // ── 源码契约：松手后不许再同步重绘 ─────────────────────────────────────────
  const pointer = read('src/renderer/src/scenario/interaction/pointer.js');

  check('p1 🔴 涂归属松手：数据变了就交给 watch(sortedScenarios) 重绘，不许再自己画一遍', () => {
    const at = pointer.indexOf('if (st.ownerStrokeActive) {');
    assert(at >= 0, '找不到涂归属的松手分支');
    const body = pointer.slice(at, at + 900);
    assert(/if \(!res \|\| res\.success === false \|\| res\.noop\) render\(\);/.test(body),
      '没按“只有 noop/失败/空笔才补一帧”来写（数据变了会重复整图重绘）');
    // 负向：分支里再多一行无条件 render() 就是回退（会多画一整帧 ~50ms）
    const bare = body.match(/^\s{4}render\(\);\s*$/m) || [];
    eq(bare.length, 0, '涂归属分支里还有无条件 render()（重复整图重绘回来了）');
    return '只有 noop/失败/空笔补帧';
  });

  // ── 缓存（时间轴重算）────────────────────────────────────────────────────
  const tlSrc = read('src/renderer/src/utils/scenarioTimeline.js');
  const dtSrc = read('src/renderer/src/utils/scenarioDates.js');

  check('p2 时间轴重算的缓存：groupMap 按 ownership 引用、normalizeScenarioDates 按剧本对象', () => {
    assert(/const groupMapCache = new WeakMap\(\)/.test(tlSrc), 'groupMap 没有 WeakMap 缓存');
    assert(/groupMapCache\.get\(own\)/.test(tlSrc), 'groupMap 没按 ownership 引用查缓存');
    assert(/groupMapCache\.set\(own, g\)/.test(tlSrc), 'groupMap 没写缓存');
    assert(/const normalizeDatesCache = new WeakMap\(\)/.test(dtSrc), 'normalizeScenarioDates 没有缓存');
    assert(dtSrc.includes('normalizeDatesCache.get(scenario)'), '日期归一没按剧本对象查缓存');
    return '两处 WeakMap';
  });

  // ── 实测：缓存生效 + 不串味 + 不阻碍更新 ────────────────────────────────
  check('p3 groupMap 缓存确实命中（同一 ownership → 同一对象；不同 → 不同对象）', () => {
    const A = scen('A', 100, 200, { p1: 'X', p2: 'X' }, [{ id: 'X', name: 'X' }]);
    const B = scen('B', 200, 300, { p1: 'Y', p2: 'X' }, [{ id: 'X', name: 'X' }, { id: 'Y', name: 'Y' }]);
    const g1 = groupMap(A);
    const g1b = groupMap(A);
    const g2 = groupMap(B);
    assert(g1 === g1b, '同一 ownership 两次 groupMap 不是同一对象 —— 缓存没生效');
    assert(g1 !== g2, '不同 ownership 复用了同一个缓存对象 —— 串味（会看到别的剧本的归属）');
    eq(g1.X.length, 2, 'A 的 X 集团省数');
    eq(g2.Y.length, 1, 'B 的 Y 集团省数');
    eq(g2.X.length, 1, 'B 的 X 集团省数');
    return '命中 + 不串味';
  });

  check('p4 🔴 缓存不阻碍更新：换掉一段的 ownership 后，时间轴必须反映新归属', () => {
    const A = scen('A', 100, 200, { p1: 'X', p2: 'X' }, [{ id: 'X', name: 'X' }]);
    const B1 = scen('B', 200, 300, { p1: 'Y', p2: 'X' }, [{ id: 'X', name: 'X' }, { id: 'Y', name: 'Y' }]);
    const tl1 = buildTimeline([A, B1]);
    const changed1 = (tl1.eraChg[1] && tl1.eraChg[1].changed) || [];
    assert(changed1.includes('p1'), '第一代到第二代 p1 应算变化省');
    assert(!changed1.includes('p2'), 'p2 两代同主，不该算变化省');
    // 只换 B 的 ownership 对象（写口就是这么做的：换引用，不原地改）
    const B2 = { ...B1, ownership: { p1: 'X', p2: 'X' } };
    const tl2 = buildTimeline([A, B2]);
    const changed2 = (tl2.eraChg[1] && tl2.eraChg[1].changed) || [];
    eq(changed2.length, 0, '归属全部相同后变化省应为 0（缓存吞掉了新值？）');
    return '换引用后立刻生效';
  });

  check('p5 🔴 两段剧本的缓存互不影响（改 A 不会让 B 的颜色/集团表变旧）', () => {
    const A1 = scen('A', 100, 200, { p1: 'X', p2: 'X' }, [{ id: 'X', name: 'X' }]);
    const B = scen('B', 200, 300, { p1: 'Y', p2: 'X' }, [{ id: 'X', name: 'X' }, { id: 'Y', name: 'Y' }]);
    const tl1 = buildTimeline([A1, B]);
    const gB1 = groupMap(tl1.scenarios[1]);
    // A 换一份 ownership（X 全面接手 p1/p2 → 集团映射变了）
    const A2 = { ...A1, ownership: { p1: 'X', p2: 'X', p3: 'X' } };
    const tl2 = buildTimeline([A2, B]);
    const gB2 = groupMap(tl2.scenarios[1]);
    assert(gB1 === gB2, 'B 的 ownership 没变，集团映射却被重算/换对象了（缓存键用错）');
    eq(groupMap(tl2.scenarios[0]).X.length, 3, 'A 的新集团映射没生效');
    return 'B 命中旧缓存、A 立即更新';
  });

  check('p6 normalizeScenarioDates：同一剧本对象缓存命中，不同剧本各算各的', () => {
    const s1 = { id: 's1', changeEvents: { p1: [{ y: 100, m: null, d: null, owner: 'X' }] } };
    const r1 = normalizeScenarioDates(s1);
    const r2 = normalizeScenarioDates(s1);
    assert(r1 === r2, '同一对象两次归一不是同一引用（缓存没生效）');
    // 已经是新格式 → 幂等快路径返回入参本身
    assert(r1 === s1, '新格式剧本应原样返回入参（幂等）');
    // 另一个剧本不受影响
    const s2 = { id: 's2', changeEvents: { p2: [{ y: 200, m: null, d: null, owner: 'Y' }] } };
    assert(normalizeScenarioDates(s2) === s2, '第二个剧本没被独立处理');
    // 负向：旧的 changeYears 仍会被迁移（缓存不吞迁移）
    const s3 = { id: 's3', changeYears: { p1: 1993 } };
    const r3 = normalizeScenarioDates(s3);
    assert(r3 !== s3, '旧格式剧本应被迁移成新对象');
    assert(r3.changeEvents && r3.changeEvents.p1, '迁移后应有 changeEvents');
    assert(!('changeYears' in r3), '迁移后不该留 changeYears');
    return '命中 + 幂等 + 迁移仍生效';
  });

  // ── 汇总 ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log('=== 涂归属不重复重绘 + 时间轴缓存（A4）Node 单元测试 ===');
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
