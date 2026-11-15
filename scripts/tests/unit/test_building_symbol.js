/**
 * interior/buildingSymbol.js 单测（2026-11-15）
 *
 * 这一层决定"地图上的建筑长什么样"。错了的两种表现：
 *   ① 轮廓比实际占地小一圈（只用墙端点、没按墙厚外扩）→ 相邻两栋楼贴在一起；
 *   ② 屋顶脊线方向不对（长轴算反）→ 一看就是斜的。
 * 所以既验数值，也验**调用序列**（画了几次 fill / 线宽多少）。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.cwd());
const mod = await import(pathToFileURL(path.join(ROOT, 'src/renderer/src/interior/buildingSymbol.js')).href);
const { SYMBOL_COLORS, buildFootprint, roofPlan, drawBuildingSymbol, symbolScreenSize } = mod;

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

/** 一间 900×650 的房（墙厚 12），四面墙 */
function room(w = 900, d = 650, t = 12) {
  return [{
    id: 'f1', elevation: 0,
    walls: [
      { start: { x: 0, y: 0 }, end: { x: w, y: 0 }, thickness: t, height: 280 },
      { start: { x: w, y: 0 }, end: { x: w, y: d }, thickness: t, height: 280 },
      { start: { x: w, y: d }, end: { x: 0, y: d }, thickness: t, height: 280 },
      { start: { x: 0, y: d }, end: { x: 0, y: 0 }, thickness: t, height: 280 },
    ],
  }];
}

/** 记录调用序列的假 ctx（只需要 drawBuildingSymbol 用到的那部分） */
function fakeCtx() {
  const ops = [];
  let lw = 1;
  const rec = (name) => (...args) => { ops.push({ name, args }); };
  return {
    ops,
    get lineWidth() { return lw; },
    set lineWidth(v) { lw = v; ops.push({ name: 'lineWidth', args: [v] }); },
    fillStyle: '', strokeStyle: '', shadowColor: '', shadowBlur: 0,
    save: rec('save'), restore: rec('restore'),
    beginPath: rec('beginPath'), closePath: rec('closePath'),
    moveTo: rec('moveTo'), lineTo: rec('lineTo'),
    fill: rec('fill'), stroke: rec('stroke'),
    translate: rec('translate'),
    count(name) { return ops.filter((o) => o.name === name).length; },
    widths() { return ops.filter((o) => o.name === 'lineWidth').map((o) => o.args[0]); },
  };
}

check('y1 四面墙 → 轮廓按墙厚外扩（900+12 × 650+12），不是 900×650', () => {
  const fp = buildFootprint(room());
  const w = fp.bbox.maxX - fp.bbox.minX;
  const d = fp.bbox.maxY - fp.bbox.minY;
  near(w, 912, 0.5, '占地宽应含墙厚');
  near(d, 662, 0.5, '占地深应含墙厚');
  assert(fp.ring.length === 4, `矩形轮廓应为 4 点，实际 ${fp.ring.length}`);
  return `${w.toFixed(0)}×${d.toFixed(0)}`;
});

check('y2 面积 = 轮廓鞋带面积（用于地图上标占地）', () => {
  const fp = buildFootprint(room());
  const w = fp.bbox.maxX - fp.bbox.minX;
  const d = fp.bbox.maxY - fp.bbox.minY;
  near(fp.area, w * d, 1, '面积应为 宽×深');
  return `${(fp.area / 1e4).toFixed(1)} m²`;
});

check('y3 没有墙 / 全是退化墙 → null（调用方回落到旧色点）', () => {
  assert(buildFootprint([]) === null, '空楼层应 null');
  assert(buildFootprint(null) === null, 'null 应 null');
  assert(buildFootprint([{ walls: [] }]) === null, '无墙应 null');
  assert(buildFootprint([{ walls: [{ start: { x: 1, y: 1 }, end: { x: 1, y: 1 } }] }]) === null, '零长墙应被忽略');
  return '4 种空数据';
});

check('y4 最小外接矩形：长轴沿长边（900 那条），长短比 ≈ 1.38', () => {
  const fp = buildFootprint(room());
  near(fp.rect.long, 912, 0.5, '长轴');
  near(fp.rect.short, 662, 0.5, '短轴');
  near(Math.hypot(fp.rect.u.x, fp.rect.u.y), 1, 1e-9, '长轴必须是单位向量');
  near(fp.rect.u.x * fp.rect.v.x + fp.rect.u.y * fp.rect.v.y, 0, 1e-9, 'u 与 v 必须垂直');
  return `${fp.rect.long.toFixed(0)}×${fp.rect.short.toFixed(0)}`;
});

check('y5 脊线：双坡贯穿两端、四坡只占中间 60%，且都平行长轴', () => {
  const fp = buildFootprint(room());
  const gable = roofPlan(fp, 'gable');
  const hip = roofPlan(fp, 'hip');
  assert(gable.ridge && hip.ridge, '两种坡顶都要有脊线');
  near(Math.hypot(gable.ridge[1].x - gable.ridge[0].x, gable.ridge[1].y - gable.ridge[0].y),
    fp.rect.long, 0.5, '双坡脊线应贯穿（= 长轴）');
  near(Math.hypot(hip.ridge[1].x - hip.ridge[0].x, hip.ridge[1].y - hip.ridge[0].y),
    fp.rect.long * 0.6, 0.5, '四坡脊线 = 长轴 × 0.6');
  const [a, b] = hip.ridge;
  near((a.x + b.x) / 2, fp.rect.cx, 0.5, '中点 x 应在外接矩形中心');
  near((a.y + b.y) / 2, fp.rect.cy, 0.5, '中点 y 应在外接矩形中心');
  // 方向与长轴平行：叉积为 0
  const cross = (b.x - a.x) * fp.rect.u.y - (b.y - a.y) * fp.rect.u.x;
  near(cross, 0, 1e-6, '脊线必须平行长轴');
  return `双坡 ${fp.rect.long.toFixed(0)} / 四坡 ${(fp.rect.long * 0.6).toFixed(0)}cm`;
});

check('y6 平顶没有脊线（否则地图上会多一条莫名其妙的线）', () => {
  const fp = buildFootprint(room());
  assert(roofPlan(fp, 'flat').ridge === null, '平顶不该有脊线');
  assert(roofPlan(null, 'gable').ridge === null, '空 footprint 不该炸');
  return 'flat=null';
});

check('y7 画符号：投影 + 屋顶 fill + 轮廓 stroke 都在，且线段闭合', () => {
  const fp = buildFootprint(room());
  const ctx = fakeCtx();
  assert(drawBuildingSymbol(ctx, fp, { zoom: 2 }) === true, '应返回 true');
  assert(ctx.count('fill') >= 2, `至少 2 次 fill（投影 + 屋顶），实际 ${ctx.count('fill')}`);
  assert(ctx.count('stroke') >= 1, '至少 1 次 stroke（轮廓）');
  assert(ctx.count('closePath') >= 2, '投影与屋顶都要闭合');
  assert(ctx.count('lineTo') >= 8, `四边形至少 8 次 lineTo，实际 ${ctx.count('lineTo')}`);
  return `fill ${ctx.count('fill')} / stroke ${ctx.count('stroke')}`;
});

check('y8 线宽随 zoom 反比（屏幕恒定）：zoom 2 时轮廓 ≈ 0.8', () => {
  const fp = buildFootprint(room());
  const c1 = fakeCtx();
  drawBuildingSymbol(c1, fp, { zoom: 2 });
  const c2 = fakeCtx();
  drawBuildingSymbol(c2, fp, { zoom: 4 });
  const w1 = Math.max(...c1.widths());
  const w2 = Math.max(...c2.widths());
  near(w1, 0.8, 1e-6, 'zoom=2 主轮廓 1.6/2');
  near(w2, 0.4, 1e-6, 'zoom=4 主轮廓 1.6/4');
  return `${w1} → ${w2}`;
});

check('y9 选中态线更粗 + 多画一圈亮边', () => {
  const fp = buildFootprint(room());
  const normal = fakeCtx();
  drawBuildingSymbol(normal, fp, { zoom: 1 });
  const sel = fakeCtx();
  drawBuildingSymbol(sel, fp, { zoom: 1, selected: true });
  assert(sel.count('stroke') > normal.count('stroke'), '选中应多一次描边');
  assert(Math.max(...sel.widths()) > Math.max(...normal.widths()), '选中线应更粗');
  return `stroke ${normal.count('stroke')} → ${sel.count('stroke')}`;
});

check('y10 shadow:false 时只画一次 fill（屋顶），不画投影', () => {
  const fp = buildFootprint(room());
  const ctx = fakeCtx();
  drawBuildingSymbol(ctx, fp, { zoom: 1, shadow: false });
  assert(ctx.count('translate') === 0, '不该有投影位移');
  assert(ctx.count('fill') === 1, `只应有屋顶 1 次 fill，实际 ${ctx.count('fill')}`);
  return '1 次 fill';
});

check('y11 symbolScreenSize：按 zoom 换算屏幕像素（缩得太小时调用方可回落圆点）', () => {
  const fp = buildFootprint(room());
  const s1 = symbolScreenSize(fp, 0.1);
  const s2 = symbolScreenSize(fp, 0.2);
  near(s2.w, s1.w * 2, 1e-6, 'zoom 翻倍 → 屏幕宽翻倍');
  assert(symbolScreenSize(null, 1).w === 0, 'null 应返回 0');
  return `${s1.w.toFixed(1)}px @0.1`;
});

check('y12 已知限制：L 形（凹）建筑会被凸包填平（写成断言，避免以后当 bug 修）', () => {
  // L 形：外墙走 (0,0)-(600,0)-(600,300)-(300,300)-(300,600)-(0,600)
  const walls = [
    { start: { x: 0, y: 0 }, end: { x: 600, y: 0 } },
    { start: { x: 600, y: 0 }, end: { x: 600, y: 300 } },
    { start: { x: 600, y: 300 }, end: { x: 300, y: 300 } },
    { start: { x: 300, y: 300 }, end: { x: 300, y: 600 } },
    { start: { x: 300, y: 600 }, end: { x: 0, y: 600 } },
    { start: { x: 0, y: 600 }, end: { x: 0, y: 0 } },
  ];
  const fp = buildFootprint([{ walls }]);
  // 凸包把凹角 (300,300) 之外的区域也围进来了：面积 > L 形真实面积（600*300 + 300*300 = 270000）
  assert(fp.area > 270000 + 1000, `应被填平（凸包面积更大），实际 ${fp.area.toFixed(0)}`);
  return `凸包 ${(fp.area / 1e4).toFixed(1)} m²（真实 27 m²）`;
});

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? '❌' : '✅'} buildingSymbol 单测：${results.length - bad.length}/${results.length} 通过`);
process.exit(bad.length ? 1 : 0);
