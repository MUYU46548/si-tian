/**
 * interior/rectDecompose.js 单测（2026-11-16）
 *
 * 这一层只做一件事：把异形平面切成**矩形**，好让每条臂各得一条标准屋脊。
 * 判据里最硬的一条是**面积守恒**（切出来的块加起来 = 原多边形）——
 * 它能一次抓住“漏掉一条臂”“块叠在一起”“把凹口也切进去”三种错。
 *
 * 另有一条边界：**有斜边的形状一律不拆**（返回空数组 → 调用方退回骨架折线）。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.cwd());
const mod = await import(pathToFileURL(path.join(ROOT, 'src/renderer/src/interior/rectDecompose.js')).href);
const { decomposeFootprint, decomposeRing, ridgeOfRect, hipsOfRect, isOrthogonalInFrame } = mod;
const bsm = await import(pathToFileURL(path.join(ROOT, 'src/renderer/src/interior/buildingSymbol.js')).href);
const { buildFootprint } = bsm;

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

/** 环面积（鞋带） */
function ringArea(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}
const sumArea = (blocks) => blocks.reduce((n, b) => n + b.area, 0);

// 四面墙的矩形房
const rect = (w, d, t = 12) => ([
  { start: { x: 0, y: 0 }, end: { x: w, y: 0 }, thickness: t, height: 280 },
  { start: { x: w, y: 0 }, end: { x: w, y: d }, thickness: t, height: 280 },
  { start: { x: w, y: d }, end: { x: 0, y: d }, thickness: t, height: 280 },
  { start: { x: 0, y: d }, end: { x: 0, y: 0 }, thickness: t, height: 280 },
]);
// L 形：600×600 去掉右上角 300×300
const L_WALLS = [
  { start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, thickness: 12, height: 280 },
  { start: { x: 600, y: 0 }, end: { x: 600, y: 300 }, thickness: 12, height: 280 },
  { start: { x: 600, y: 300 }, end: { x: 300, y: 300 }, thickness: 12, height: 280 },
  { start: { x: 300, y: 300 }, end: { x: 300, y: 600 }, thickness: 12, height: 280 },
  { start: { x: 300, y: 600 }, end: { x: 0, y: 600 }, thickness: 12, height: 280 },
  { start: { x: 0, y: 600 }, end: { x: 0, y: 0 }, thickness: 12, height: 280 },
];
// 三合院：800×600，中间 420×300 的院子空着（不是洞，是轮廓凹进去的 U）
const U_WALLS = [
  { start: { x: 0, y: 0 }, end: { x: 800, y: 0 }, thickness: 12, height: 280 },
  { start: { x: 800, y: 0 }, end: { x: 800, y: 600 }, thickness: 12, height: 280 },
  { start: { x: 800, y: 600 }, end: { x: 640, y: 600 }, thickness: 12, height: 280 },
  { start: { x: 640, y: 600 }, end: { x: 640, y: 300 }, thickness: 12, height: 280 },
  { start: { x: 640, y: 300 }, end: { x: 160, y: 300 }, thickness: 12, height: 280 },
  { start: { x: 160, y: 300 }, end: { x: 160, y: 600 }, thickness: 12, height: 280 },
  { start: { x: 160, y: 600 }, end: { x: 0, y: 600 }, thickness: 12, height: 280 },
  { start: { x: 0, y: 600 }, end: { x: 0, y: 0 }, thickness: 12, height: 280 },
];

// ── 切出来的块对不对 ───────────────────────────────────────────────────

check('r1 矩形平面：切成 1 块，面积等于占地的净面积', () => {
  const fp = buildFootprint([{ walls: rect(900, 650) }]);
  const blocks = decomposeFootprint(fp);
  assert(blocks.length === 1, `矩形应切成 1 块，实际 ${blocks.length}`);
  near(blocks[0].area, fp.areaNet, fp.areaNet * 0.02, '一块的面积应≈占地净面积');
  return `1 块 · ${(blocks[0].area / 1e4).toFixed(1)} ㎡`;
});

check('r2 L 形：切成 2 块，**面积守恒**（漏一臂 / 块重叠都会被这条抓住）', () => {
  const fp = buildFootprint([{ walls: L_WALLS }]);
  const blocks = decomposeFootprint(fp);
  assert(blocks.length === 2, `L 形应切成 2 块，实际 ${blocks.length}`);
  near(sumArea(blocks), fp.areaNet, fp.areaNet * 0.02, '两块面积和应≈占地净面积');
  return `2 块 / 合计 ${(sumArea(blocks) / 1e4).toFixed(1)} ㎡（占地 ${(fp.areaNet / 1e4).toFixed(1)}）`;
});

check('r3 三合院（凹口朝一边）：切成 3 块（横臂 + 两条竖臂），面积守恒', () => {
  const fp = buildFootprint([{ walls: U_WALLS }]);
  const blocks = decomposeFootprint(fp);
  assert(blocks.length === 3, `U 形应切成 3 块，实际 ${blocks.length}`);
  near(sumArea(blocks), fp.areaNet, fp.areaNet * 0.03, '三块面积和应≈占地净面积');
  return `3 块 / 合计 ${(sumArea(blocks) / 1e4).toFixed(1)} ㎡`;
});

check('r4 每块都在轮廓内（取块的四个角逐一验，不许有一角伸出楼外）', () => {
  const fp = buildFootprint([{ walls: L_WALLS }]);
  const blocks = decomposeFootprint(fp);
  for (const b of blocks) {
    for (const c of b.corners) {
      // 角本来就应该落在轮廓边上（块的边界=轮廓的一部分），所以判“离轮廓足够近”，
      // 而不是“严格在内部”—— 后者会把每一个正确的角都判成越界。
      const d = distToRingLoosely(fp, c);
      assert(d < 2.5, `块的角离轮廓 ${d.toFixed(1)}cm —— 说明这块伸出去了`);
    }
  }
  return `${blocks.length} 块 ×4 角`;
});

function distToRingLoosely(fp, pt) {
  const polys = (fp.polygons && fp.polygons.length) ? fp.polygons : [{ outer: fp.ring, holes: [] }];
  let best = Infinity;
  for (const p of polys) {
    const ring = p.outer || [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / L2)) : 0;
      const q = { x: a.x + dx * t, y: a.y + dy * t };
      best = Math.min(best, Math.hypot(pt.x - q.x, pt.y - q.y));
    }
  }
  return best;
}

// ── 屋脊 ────────────────────────────────────────────────────────────────

check('r5 每块一条脊：长度 = 那根轴的长度 ×（双坡 100% / 四坡 60%），且平行于某条边', () => {
  const fp = buildFootprint([{ walls: L_WALLS }]);
  const blocks = decomposeFootprint(fp);
  for (const b of blocks) {
    const gable = ridgeOfRect(b, 'gable');
    const hip = ridgeOfRect(b, 'hip');
    const len = (r) => Math.hypot(r[1].x - r[0].x, r[1].y - r[0].y);
    const dx = (gable[1].x - gable[0].x) / len(gable);
    const dy = (gable[1].y - gable[0].y) / len(gable);
    const alongU = Math.abs(dx * b.u.x + dy * b.u.y) > Math.abs(dx * b.v.x + dy * b.v.y);
    const axisLen = alongU ? b.halfU * 2 : b.halfV * 2;
    near(len(gable), axisLen, 0.6, '双坡脊应贯穿那块');
    near(len(hip), axisLen * 0.6, 0.6, '四坡脊应是那块长边的 60%');
  }
  return `${blocks.length} 条脊`;
});

check('r5b L 形两臂的脊**互相垂直**（都沿长边的话，竖臂也会画成横脊 —— 这是本项的核心）', () => {
  const fp = buildFootprint([{ walls: L_WALLS }]);
  const blocks = decomposeFootprint(fp);
  assert(blocks.length === 2, `L 形应切 2 块，实际 ${blocks.length}`);
  const dirs = blocks.map((b) => {
    const r = ridgeOfRect(b, 'hip');
    const len = Math.hypot(r[1].x - r[0].x, r[1].y - r[0].y);
    return { x: (r[1].x - r[0].x) / len, y: (r[1].y - r[0].y) / len, attach: b.attach };
  });
  const dot = Math.abs(dirs[0].x * dirs[1].x + dirs[0].y * dirs[1].y);
  assert(dot < 0.05, `两臂的脊应互相垂直，实际夹角余弦 ${dot.toFixed(3)}`);
  // 竖直那一条必须是"接口那条边"接住的那块（v 方向被整条接住 → 脊沿 u… 反过来也一样）
  const hit = blocks.find((b) => Math.max(b.attach.vPlus, b.attach.vMinus) > 0.9);
  assert(hit, '竖臂应有一条边被整条接住（attach ≥ 0.9）');
  return `夹角余弦 ${dot.toFixed(3)}`;
});

check('r5c U 形：两臂的脊竖、横条的脊横（三块拼接的经典画法）', () => {
  const fp = buildFootprint([{ walls: U_WALLS }]);
  const blocks = decomposeFootprint(fp);
  assert(blocks.length === 3, `U 形应切 3 块，实际 ${blocks.length}`);
  const vertical = [];
  const horizontal = [];
  for (const b of blocks) {
    const r = ridgeOfRect(b, 'hip');
    const len = Math.hypot(r[1].x - r[0].x, r[1].y - r[0].y);
    const dx = Math.abs((r[1].x - r[0].x) / len);
    const dy = Math.abs((r[1].y - r[0].y) / len);
    if (dx > dy) horizontal.push(b); else vertical.push(b);
  }
  assert(vertical.length === 2 && horizontal.length === 1,
    `应是两条竖脊 + 一条横脊，实际 竖 ${vertical.length} / 横 ${horizontal.length}`);
  return `竖 ${vertical.length} / 横 ${horizontal.length}`;
});

check('r6 四坡的斜脊：每块 4 条（两端各两个角），且都从脊端点出发', () => {
  const fp = buildFootprint([{ walls: L_WALLS }]);
  const blocks = decomposeFootprint(fp);
  for (const b of blocks) {
    const ridge = ridgeOfRect(b, 'hip');
    const hips = hipsOfRect(b, ridge);
    assert(hips.length === 4, `每块应 4 条斜脊，实际 ${hips.length}`);
    for (const h of hips) {
      assert(ridge.some((p) => Math.hypot(p.x - h.from.x, p.y - h.from.y) < 1e-6), '斜脊必须从脊端点出发');
    }
  }
  return '4 条/块';
});

// ── 不拆的情况（回落骨架）──────────────────────────────────────────────

check('r7 有斜边的形状一律不拆（硬拆是一堆锯齿小条，比骨架更难看）', () => {
  const walls = [
    { start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, thickness: 12, height: 280 },
    { start: { x: 600, y: 0 }, end: { x: 480, y: 420 }, thickness: 12, height: 280 },
    { start: { x: 480, y: 420 }, end: { x: 0, y: 600 }, thickness: 12, height: 280 },
    { start: { x: 0, y: 600 }, end: { x: 0, y: 0 }, thickness: 12, height: 280 },
  ];
  const fp = buildFootprint([{ walls }]);
  assert(!isOrthogonalInFrame(fp.ring, fp.rect, 8), '这个轮廓不该被判成正交');
  assert(decomposeFootprint(fp).length === 0, '不拆时应返回空数组（调用方回落骨架）');
  return '空数组';
});

check('r8 细条被丢掉（34px 的符号上，窄条就是一坨黑）', () => {
  const fp = buildFootprint([{ walls: L_WALLS }]);
  const wide = decomposeFootprint(fp, { minSideCm: 40 });
  const strict = decomposeFootprint(fp, { minSideCm: 400 });
  assert(wide.length === 2, `阈值 40 时应 2 块，实际 ${wide.length}`);
  assert(strict.length === 0 || strict.length < wide.length, '阈值放大后应更少');
  return `40cm→${wide.length} 块，400cm→${strict.length} 块`;
});

check('r9 块数上限：切成很多块时只留最大的几块', () => {
  const fp = buildFootprint([{ walls: U_WALLS }]);
  const all = decomposeFootprint(fp, { maxCount: 10 });
  const top2 = decomposeFootprint(fp, { maxCount: 2 });
  assert(top2.length <= 2, '上限 2 应只给 2 块');
  if (all.length > 2) assert(top2[0].area >= top2[1].area, '应按面积从大到小');
  return `${all.length} → ${top2.length}`;
});

// ── 退化与确定性 ────────────────────────────────────────────────────────

check('r10 退化解法：空占地 / 没有 rect / 环太短 → 空数组，不抛错', () => {
  assert(decomposeFootprint(null).length === 0, 'null 应空');
  assert(decomposeFootprint({}).length === 0, '没有 rect 应空');
  assert(decomposeRing([], [], { cx: 0, cy: 0, u: { x: 1, y: 0 }, v: { x: 0, y: 1 } }).length === 0, '空环应空');
  return '3 种退化';
});

check('r11 确定性：同一份占地切两次，块数与每块面积都一样', () => {
  const fp = buildFootprint([{ walls: U_WALLS }]);
  const a = decomposeFootprint(fp);
  const b = decomposeFootprint(fp);
  assert(a.length === b.length, '块数应一致');
  for (let i = 0; i < a.length; i++) near(a[i].area, b[i].area, 1e-9, `第 ${i} 块面积`);
  return `${a.length} 块`;
});

check('r12 不改入参：切完之后占地的外环点数与面积都没变', () => {
  const fp = buildFootprint([{ walls: L_WALLS }]);
  const before = fp.ring.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(';');
  const area = fp.areaNet;
  decomposeFootprint(fp);
  const after = fp.ring.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(';');
  assert(before === after, '外环被改了');
  near(fp.areaNet, area, 1e-9, '面积被改了');
  return '未改入参';
});

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? '❌' : '✅'} rectDecompose 单测：${results.length - bad.length}/${results.length} 通过`);
process.exit(bad.length ? 1 : 0);
