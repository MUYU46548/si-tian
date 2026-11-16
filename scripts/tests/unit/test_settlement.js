/**
 * interior/settlement.js 单测（2026-11-16）
 *
 * 聚落鸟瞰最容易错的三件事，全在这一层：
 *   ① **单位**：地图上是米、建筑内部是 cm —— 少乘或多乘 100，整张图就成“芝麻和西瓜”；
 *   ② **摆位**：占地的中心必须落到节点位置上（否则所有房子叠在地图原点）；
 *   ③ **路面**：折线按段画盒子会在每个拐点多一条横线 —— 必须是偏移出来的一整条带。
 *
 * 这里测纯函数；出图长什么样由 `scripts/tests/drill_settlement_axo.py` 判。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.cwd());
// 量与摆位对不对要看真占地，所以直接借 buildFootprint（同一个实现，不另写一份）
const mod = await import(pathToFileURL(path.join(ROOT, 'src/renderer/src/interior/settlement.js')).href);
const {
  MAP_UNIT_CM, SETTLEMENT_DEFAULTS,
  roadRibbon, collectSettlement, plainShell, settlementBounds,
  settlementScaleBar, scaleBarTicks, settlementCaptionModel,
} = mod;

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

/** 多边形面积（鞋带，取绝对值） */
function polyArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** 一间 900×650 cm 的房（四面墙），给 buildFootprint 用 */
function rectFloors(w = 900, h = 650, elevation = 0) {
  return [{
    id: 'f1', name: '一层', elevation,
    walls: [
      { id: 'w1', start: { x: 0, y: 0 }, end: { x: w, y: 0 }, thickness: 12, height: 280 },
      { id: 'w2', start: { x: w, y: 0 }, end: { x: w, y: h }, thickness: 12, height: 280 },
      { id: 'w3', start: { x: w, y: h }, end: { x: 0, y: h }, thickness: 12, height: 280 },
      { id: 'w4', start: { x: 0, y: h }, end: { x: 0, y: 0 }, thickness: 12, height: 280 },
    ],
    doors: [], windows: [], rooms: [], stairs: [],
  }];
}

// ── 路面 ────────────────────────────────────────────────────────────────

check('s1 一条直路：带子面积 = 长 × 宽，长度按折线累计', () => {
  const r = roadRibbon([{ x: 0, y: 0 }, { x: 1000, y: 0 }], 300);
  assert(r && r.poly.length === 4, `应是四点多边形，实际 ${r && r.poly.length}`);
  near(polyArea(r.poly), 1000 * 300, 1, '面积应等于长×宽');
  near(r.lengthCm, 1000, 0.5, '长度');
  near(Math.abs(r.left[0].y), 150, 1e-6, '半边宽 150');
  return `${r.poly.length} 点 · ${r.lengthCm}cm`;
});

check('s2 直角拐弯：外侧点按 miter 拉长到 √2 倍（不是各画一个盒子）', () => {
  const r = roadRibbon([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }], 200);
  assert(r && r.poly.length === 6, '三点折线 → 六点带子');
  // 拐点 (1000,0) 的**相邻**两个偏移点：直角下都应距拐点 hw*√2（不是 hw）
  const hw = 100;
  const dL = Math.hypot(r.left[1].x - 1000, r.left[1].y - 0);
  const dR = Math.hypot(r.right[1].x - 1000, r.right[1].y - 0);
  near(dL, hw * Math.SQRT2, 0.5, '左侧拐点应拉长 √2');
  near(dR, hw * Math.SQRT2, 0.5, '右侧拐点应拉长 √2');
  return `${dL.toFixed(0)} / ${dR.toFixed(0)} cm`;
});

check('s3 180° 折返不会甩出尖角（miter 夹在 3 倍半宽内）', () => {
  const r = roadRibbon([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 0, y: 0 }], 200);
  assert(r, '折返也该画出东西');
  let far = 0;
  for (const p of r.poly) far = Math.max(far, Math.hypot(p.x - 500, p.y));
  assert(far < 500 + 100 * 3 + 1, `离中线太远（${far.toFixed(0)}cm），说明 miter 没夹住`);
  return `最远 ${far.toFixed(0)}cm`;
});

check('s4b 路面多边形一律逆时针（顺指针的话三角面朝下，会被整片剔掉只剩两条线）', () => {
  const area = (poly) => {
    let sum = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      sum += a.x * b.y - b.x * a.y;
    }
    return sum / 2;
  };
  const rtl = roadRibbon([{ x: 1000, y: 0 }, { x: 0, y: 0 }], 300);   // 反向画的那条
  assert(area(rtl.poly) > 0, `反向路也必须是逆时针，实际 ${area(rtl.poly)}`);
  const curve = roadRibbon([{ x: 0, y: 0 }, { x: 500, y: 400 }, { x: 1000, y: 0 }], 200);
  assert(area(curve.poly) > 0, `折线也必须是逆时针，实际 ${area(curve.poly)}`);
  return `${area(rtl.poly).toFixed(0)} / ${area(curve.poly).toFixed(0)}`;
});

check('s4 少于两个点 / 全是坏点 → 不画（null），不许抛错', () => {
  assert(roadRibbon([], 300) === null, '空列表应为 null');
  assert(roadRibbon([{ x: 0, y: 0 }], 300) === null, '一个点应为 null');
  assert(roadRibbon([{ x: 0, y: 0 }, { x: NaN, y: 0 }], 300) === null, '坏点应被过滤成 null');
  return '3 种退化';
});

// ── 采集 ────────────────────────────────────────────────────────────────

const PLACES = [
  { id: 'b1', name: '有内部图的楼', layer: 'building', coordinate: { x: 10, y: 20 } },
  { id: 'b2', name: '只有体块', layer: 'building', coordinate: { x: -5, y: 30 }, footprint: { w: 1200, h: 800 } },
  { id: 'b3', name: '默认尺寸的体块', layer: 'building', coordinate: { x: 40, y: -10 } },
  { id: 'x1', name: '不是建筑', layer: 'location', coordinate: { x: 1, y: 1 } },
];
const INTERIOR = { b1: { floors: rectFloors() } };
const ROUTES = [
  { id: 'r1', points: [{ x: 0, y: 0 }, { x: 30, y: 10 }, { x: 60, y: 0 }] },
  { id: 'r2', points: [{ x: 5, y: 5 }] },
];

check('s5 地图单位 = 米：坐标 (10, 20) → 世界 (1000, 0, 2000) cm', () => {
  near(MAP_UNIT_CM, 100, 1e-9, '一个地图单位应为 100cm');
  const s = collectSettlement({ places: PLACES, routes: ROUTES, interiorData: INTERIOR });
  const b1 = s.buildings.find((b) => b.id === 'b1');
  near(b1.at[0], 1000, 0.01, 'x');
  near(b1.at[1], 0, 1e-9, '地面 y=0');
  near(b1.at[2], 2000, 0.01, 'z（平面 y → 世界 z）');
  return `${b1.at.join(',')}`;
});

check('s6 有内部图的楼：偏移把**占地中心**挪到节点位置', () => {
  const s = collectSettlement({ places: PLACES, routes: ROUTES, interiorData: INTERIOR });
  const b = s.buildings.find((x) => x.id === 'b1');
  assert(b.wired === true, 'b1 应是有内部图的');
  // 真判据：占地 bbox 中心 + offset == 节点位置（几何一定要落在节点上）
  const fp = buildFootprint(INTERIOR.b1.floors);
  const cx = (fp.bbox.minX + fp.bbox.maxX) / 2;
  const cy = (fp.bbox.minY + fp.bbox.maxY) / 2;
  near(cx + b.offset[0], b.at[0], 1e-6, 'x 没对上节点');
  near(cy + b.offset[2], b.at[2], 1e-6, 'z 没对上节点');
  near(b.offset[1], 0, 1e-9, '竖向不偏移');
  return `offset ${b.offset.map((v) => v.toFixed(1)).join(',')}`;
});

check('s7 没内部图的楼：有 footprint 字段就用它，没有就 8×6 m', () => {
  const s = collectSettlement({ places: PLACES, routes: ROUTES, interiorData: INTERIOR });
  const b2 = s.buildings.find((x) => x.id === 'b2');
  const b3 = s.buildings.find((x) => x.id === 'b3');
  assert(b2.wired === false && b2.floors.length === 0, 'b2 应为体块');
  near(b2.widthCm, 1200, 0.01, 'b2 宽应取 footprint 字段');
  near(b2.depthCm, 800, 0.01, 'b2 深应取 footprint 字段');
  near(b3.widthCm, SETTLEMENT_DEFAULTS.plainWidth, 0.01, 'b3 宽应为默认 800');
  near(b3.depthCm, SETTLEMENT_DEFAULTS.plainDepth, 0.01, 'b3 深应为默认 600');
  assert(b2.heightCm > 0, '体块要有高度');
  return `b2 ${b2.widthCm}×${b2.depthCm} / b3 ${b3.widthCm}×${b3.depthCm}`;
});

check('s8 只收建筑；不到两个点的路不算一条路', () => {
  const s = collectSettlement({ places: PLACES, routes: ROUTES, interiorData: INTERIOR });
  assert(s.buildings.length === 3, `应只有 3 栋建筑（location 不算），实际 ${s.buildings.length}`);
  assert(s.roads.length === 1, `只有 r1 算路，实际 ${s.roads.length}`);
  return '3 栋 / 1 条';
});

check('s9 统计数字与图注用的一致', () => {
  const s = collectSettlement({ places: PLACES, routes: ROUTES, interiorData: INTERIOR });
  assert(s.stats.buildings === 3, '建筑 3');
  assert(s.stats.wired === 1 && s.stats.plain === 2, `内部图 1 / 体块 2，实际 ${s.stats.wired}/${s.stats.plain}`);
  assert(s.stats.roads === 1, '道路 1');
  assert(s.stats.roadLengthCm > 0, '总长 > 0');
  return JSON.stringify(s.stats);
});

// ── 包围盒 ──────────────────────────────────────────────────────────────

check('s10 包围盒：楼的 bounds 按 offset 平移后并起来，路也算进去，pad 生效', () => {
  const items = [
    { bounds: { min: [0, 0, 0], max: [100, 300, 100], size: [100, 300, 100] }, offset: [1000, 0, 2000] },
    { bounds: { min: [0, 0, 0], max: [200, 300, 200], size: [200, 300, 200] }, offset: [-500, 0, -500] },
  ];
  const roads = [{ poly: [{ x: 3000, y: 3000 }, { x: 4000, y: 3000 }] }];
  const b = settlementBounds(items, roads);
  near(b.min[0], -500, 1e-6, 'x 最小应来自第二栋的平移');
  near(b.max[0], 4000, 1e-6, 'x 最大应来自路');
  near(b.max[1], 300, 1e-6, 'y 最大 = 楼高');
  const padded = settlementBounds(items, roads, 500);
  near(padded.min[0], -1000, 1e-6, 'pad 应往外扩');
  assert(settlementBounds([], []) === null, '什么都没有应为 null');
  return `${b.size.map((v) => Math.round(v)).join(' × ')}`;
});

// ── 比例尺与图注 ────────────────────────────────────────────────────────

check('s11 比例尺是算出来的：像素长 = cm × 渲染宽 / 取景宽（不是拍的）', () => {
  const bar = settlementScaleBar({ spanWCm: 100000, renderWidthPx: 3600 });
  const exact = bar.cm * (3600 / 100000);
  near(bar.px, Math.round(exact), 1, '尺长应与换算一致');
  assert(bar.px <= 3600 * 0.12 + 1, `尺子不该超过目标长度（${bar.px}px）`);
  assert(/m$|km$/.test(bar.label), `标签应是米或公里：${bar.label}`);
  const tiny = settlementScaleBar({ spanWCm: 2000, renderWidthPx: 3600 });
  assert(tiny.cm >= 100, '小镇也不该只有半米');
  const ticks = scaleBarTicks(bar);
  assert(ticks.length === 3, '三格刻度');
  near(ticks[2].px, bar.px, 1e-6, '最后一格 = 全长');
  return `${bar.label}（${bar.px}px）`;
});

check('s12 图注：五格齐全、说明行交代“几栋有内部图”、没有工程术语', () => {
  const s = collectSettlement({ places: PLACES, routes: ROUTES, interiorData: INTERIOR });
  const bar = settlementScaleBar({ spanWCm: 100000, renderWidthPx: 3600 });
  const m = settlementCaptionModel({
    name: '示例镇',
    stats: s.stats,
    extentCm: { w: 12000, h: 8500 },
    projection: '等轴测 45°/35.26°',
    preset: 'iso',
    scaleBar: { ...bar, ticks: scaleBarTicks(bar) },
    date: '2026-11-16',
    version: '0.5.19',
  });
  const labels = m.cells.map((c) => c.label);
  for (const want of ['建筑', '道路', '镇域', '投影', '方位']) {
    assert(labels.includes(want), `缺“${want}”：${labels.join('/')}`);
  }
  assert(m.title === '示例镇', '图名应是区域名');
  assert(/3 栋/.test(m.cells[0].value), `建筑格应写 3 栋，实际 ${m.cells[0].value}`);
  assert(/120 × 85 m/.test(m.cells[2].value), `镇域应换算成米，实际 ${m.cells[2].value}`);
  assert(/1 栋有内部图/.test(m.note) && /2 栋只有体块/.test(m.note), `说明行没交代清楚：${m.note}`);
  assert(m.scaleBar && m.scaleBar.px > 0, '图注应带比例尺');
  const jargon = /provenance|落库|单源|格距|回执|幂等|φ|N3a/;
  const all = [m.title, m.subtitle, m.note, m.footer].concat(m.cells.map((c) => `${c.label}${c.value}`)).join(' ');
  assert(!jargon.test(all), `图注里有工程术语：${all}`);
  return m.cells.length + ' 格';
});

check('s13 空区域：不编数字（“还没有建筑 / 镇域 —”）', () => {
  const m = settlementCaptionModel({ name: '', stats: { buildings: 0, roads: 0 }, extentCm: null });
  assert(m.title === '聚落', '没名字回落“聚落”');
  assert(/还没有建筑/.test(m.cells[0].value), m.cells[0].value);
  assert(m.cells[2].value === '—', `镇域应为破折号，实际 ${m.cells[2].value}`);
  assert(/还没有道路/.test(m.cells[1].value), m.cells[1].value);
  return 'ok';
});

// ── 体块外壳 ────────────────────────────────────────────────────────────

check('s14 体块外壳与 buildShell 同构：1 个盒子、包围盒尺寸对得上', () => {
  const shell = plainShell({ at: [1000, 0, 2000], widthCm: 800, depthCm: 600, heightCm: 320 }, { color: '#d6cfc0' });
  assert(Array.isArray(shell.boxes) && shell.boxes.length === 1, '应只有一个盒子');
  assert(shell.roof === null && shell.surfaces.length === 0, '体块没有屋顶面与房间面');
  near(shell.bounds.size[0], 800, 1e-6, '宽');
  near(shell.bounds.size[1], 320, 1e-6, '高');
  near(shell.bounds.center[0], 1000, 1e-6, '中心在节点位置');
  assert(shell.boxes[0].color === '#d6cfc0', '颜色应透传');
  return `${shell.bounds.size.map((v) => Math.round(v)).join('×')}`;
});

check('s15 负向探针：places 为 null / 非数组时不炸，返回空聚落', () => {
  const s = collectSettlement({ places: null, routes: null, interiorData: null });
  assert(s.buildings.length === 0 && s.roads.length === 0, '应返回空');
  assert(s.stats.buildings === 0, '统计为 0');
  return '空聚落';
});

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? '❌' : '✅'} settlement 单测：${results.length - bad.length}/${results.length} 通过`);
process.exit(bad.length ? 1 : 0);
