/**
 * interior/alignment.js 单测（2026-11-15，台账 A26 对齐与正交）
 *
 * 这一层错了的表现是"画墙时莫名跳一下"或"天花板画出来不闭合"，比崩溃更难查。
 * 所以每条都要把**优先级**断言清楚：正交 > 端点 > 轴线 > 网格。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.cwd());
const mod = await import(pathToFileURL(path.join(ROOT, 'src/renderer/src/interior/alignment.js')).href);
const { collectTargets, resolveSnap, projectOrthogonal } = mod;

const results = [];
function check(name, fn) {
  try {
    const note = fn();
    results.push({ name, ok: true, note });
    console.log(`  ✅ ${name}${note ? ` —— ${note}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, note: e && e.message });
    console.log(`  ❌ ${name} —— ${e && e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function near(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) throw new Error(`${msg}：期望 ${b}，实际 ${a}`);
}

/** 一间 400×300 的房（左上 -200,-150），四面墙 */
const WALLS = [
  { id: 'w0', start: { x: -200, y: -150 }, end: { x: 200, y: -150 } },
  { id: 'w1', start: { x: 200, y: -150 }, end: { x: 200, y: 150 } },
  { id: 'w2', start: { x: 200, y: 150 }, end: { x: -200, y: 150 } },
  { id: 'w3', start: { x: -200, y: 150 }, end: { x: -200, y: -150 } },
];

check('n1 collectTargets：8 个端点、去重后的 x/y 集合', () => {
  const t = collectTargets(WALLS);
  assert(t.points.length === 8, `端点数应为 8，实际 ${t.points.length}`);
  assert(t.xs.length === 2 && t.ys.length === 2, `轴线应各 2 条，实际 x=${t.xs.length} y=${t.ys.length}`);
  return '8 点 / 2 x / 2 y';
});

check('n2 collectTargets：excludeIds 排除自己（拖墙时不能吸到自己的端点）', () => {
  const t = collectTargets(WALLS, ['w0']);
  assert(t.points.length === 6, `应剩 6 点，实际 ${t.points.length}`);
  assert(!t.points.some((p) => p.wallId === 'w0'), '不许包含被排除的墙');
  return '6 点';
});

check('n3 端点吸附：距离 tol 内贴到端点，并给出两条参考线', () => {
  const t = collectTargets(WALLS, ['w0']);
  const r = resolveSnap({ x: 203, y: 148 }, t, { tol: 8 });
  assert(r.used === true, '应判定为吸附');
  near(r.x, 200, 1e-9, 'x 贴到端点');
  near(r.y, 150, 1e-9, 'y 贴到端点');
  assert(r.guides.x === 200 && r.guides.y === 150, '两条参考线都要给（画出来是十字）');
  assert(r.snapPoint !== null, '应报告吸附点');
  return '(203,148) → (200,150)';
});

check('n4 端点吸附有半径：超出 tol 就只做轴线吸附', () => {
  const t = collectTargets(WALLS, ['w0']);
  // x 离 200 只有 3 → 会吸轴线；y 离 150 有 20 → 不吸
  const r = resolveSnap({ x: 203, y: 130 }, t, { tol: 8 });
  near(r.x, 200, 1e-9, 'x 应吸到轴线 200');
  near(r.y, 130, 1e-9, 'y 不该被动');
  assert(r.guides.x === 200 && r.guides.y === null, '只有纵向参考线');
  assert(r.snapPoint === null, '不该说吸到了端点');
  return '仅轴线';
});

check('n5 正交：水平位移大 → y 钉在起点，横向参考线只在起点 y', () => {
  const t = collectTargets(WALLS);
  const r = resolveSnap({ x: 350, y: -120 }, t, { tol: 8, orthogonal: true, from: { x: 200, y: -150 } });
  near(r.y, -150, 1e-9, 'y 钉回起点');
  near(r.x, 350, 1e-9, 'x 保留');
  assert(r.orthogonal === true && r.guides.y === -150, '参考线在起点 y');
  return '水平';
});

check('n6 正交：垂直位移大 → x 钉在起点', () => {
  const t = collectTargets(WALLS);
  const r = resolveSnap({ x: 210, y: 260 }, t, { tol: 8, orthogonal: true, from: { x: 200, y: 150 } });
  near(r.x, 200, 1e-9, 'x 钉回起点');
  near(r.y, 260, 1e-9, 'y 保留');
  return '垂直';
});

check('n7 正交优先于端点吸附（否则方向会被掰弯）', () => {
  const t = collectTargets(WALLS, ['w0']);
  // 起点 (-200,-150)，往右画；(203,148) 附近有端点 (200,150)，但正交必须走水平线 y=-150
  const r = resolveSnap({ x: 203, y: 148 }, t, { tol: 8, orthogonal: true, from: { x: -200, y: -150 } });
  near(r.y, -150, 1e-9, '必须留在水平线上');
  assert(r.snapPoint === null, '正交时不许报端点吸附');
  return '不掰弯';
});

check('n8 都不命中 → 按网格取整（给了 grid）', () => {
  const t = collectTargets(WALLS);
  const r = resolveSnap({ x: 733, y: 917 }, t, { tol: 8, grid: 40 });
  assert(r.used === false, '不该有吸附');
  near(r.x, 720, 1e-9, 'x 取整到 40 的倍数');
  near(r.y, 920, 1e-9, 'y 取整到 40 的倍数');
  return '(733,917) → (720,920)';
});

check('n9 吸附优先于网格（网格不许把吸附结果拉歪）', () => {
  const t = collectTargets(WALLS, ['w0']);
  // 端点 (200,150)，网格 40：若网格先跑会把 200 拉成 200（本就对齐），y 150 → 160，就错了
  const r = resolveSnap({ x: 202, y: 152 }, t, { tol: 8, grid: 40 });
  near(r.y, 150, 1e-9, 'y 必须是 150，不是网格的 160');
  return '150 而非 160';
});

check('n10 projectOrthogonal：只钉离得更近的那一轴', () => {
  const a = projectOrthogonal({ x: 195, y: 60 }, { x: 200, y: 150 }, 8);
  near(a.x, 200, 1e-9, 'x 近 → 钉 x');
  near(a.y, 60, 1e-9, 'y 不动');
  const b = projectOrthogonal({ x: 60, y: 145 }, { x: 200, y: 150 }, 8);
  near(b.x, 60, 1e-9, 'x 不动');
  near(b.y, 150, 1e-9, 'y 近 → 钉 y');
  const c = projectOrthogonal({ x: 60, y: 60 }, { x: 200, y: 150 }, 8);
  near(c.x, 60, 1e-9, '都远 → 不钉 x');
  near(c.y, 60, 1e-9, '都远 → 不钉 y');
  return '3 种情形';
});

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? '❌' : '✅'} alignment 单测：${results.length - bad.length}/${results.length} 通过`);
process.exit(bad.length ? 1 : 0);
