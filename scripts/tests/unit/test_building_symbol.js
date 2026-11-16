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
const { SYMBOL_COLORS, buildFootprint, roofPlan, drawBuildingSymbol, symbolScreenSize, footprintContains, skeletonRidge,
  insetFootprint, topInsetFor } = mod;

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


/** L 形外墙（中心线）：(0,0)-(600,0)-(600,300)-(300,300)-(300,600)-(0,600)-(0,0) */
const L_WALLS = [
  { start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, thickness: 12, height: 280 },
  { start: { x: 600, y: 0 }, end: { x: 600, y: 300 }, thickness: 12, height: 280 },
  { start: { x: 600, y: 300 }, end: { x: 300, y: 300 }, thickness: 12, height: 280 },
  { start: { x: 300, y: 300 }, end: { x: 300, y: 600 }, thickness: 12, height: 280 },
  { start: { x: 300, y: 600 }, end: { x: 0, y: 600 }, thickness: 12, height: 280 },
  { start: { x: 0, y: 600 }, end: { x: 0, y: 0 }, thickness: 12, height: 280 },
];

/** 点到轮廓最短距离（测试侧独立实现，不复用被测代码） */
function distToRing(fp, q) {
  let best = Infinity;
  for (const poly of fp.polygons) {
    const ring = poly.outer;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L2 = dx * dx + dy * dy;
      if (!(L2 > 0)) continue;
      const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / L2));
      const d = Math.hypot(q.x - (a.x + dx * t), q.y - (a.y + dy * t));
      if (d < best) best = d;
    }
  }
  return best;
}

/** 点是否贴在某条轮廓边上（tol cm 内）—— 描边点本来就压在边界上 */
function nearRing(fp, q, tol) {
  for (const p of fp.polygons) {
    for (let i = 0; i < p.outer.length; i++) {
      const a = p.outer[i];
      const b = p.outer[(i + 1) % p.outer.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L2 = dx * dx + dy * dy;
      if (!(L2 > 0)) continue;
      const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / L2));
      if (Math.hypot(q.x - (a.x + dx * t), q.y - (a.y + dy * t)) <= tol) return true;
    }
  }
  return false;
}

/** 记录调用序列的假 ctx（只需要 drawBuildingSymbol 用到的那部分） */
function fakeCtx() {
  const ops = [];
  const paths = [];            // 每次 fill / stroke 时当前路径的包围盒（断言"哪一块画了多大"用）
  let lw = 1;
  let cur = null;
  const box = () => ({ minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
  const add = (x, y) => {
    if (!cur) cur = box();
    if (x < cur.minX) cur.minX = x;
    if (x > cur.maxX) cur.maxX = x;
    if (y < cur.minY) cur.minY = y;
    if (y > cur.maxY) cur.maxY = y;
  };
  const rec = (name) => (...args) => { ops.push({ name, args }); };
  const onFill = (kind) => (...args) => {
    ops.push({ name: kind, args });
    if (cur && Number.isFinite(cur.minX)) paths.push({ kind, ...cur, w: cur.maxX - cur.minX, h: cur.maxY - cur.minY });
  };
  return {
    ops,
    paths,
    get lineWidth() { return lw; },
    set lineWidth(v) { lw = v; ops.push({ name: 'lineWidth', args: [v] }); },
    fillStyle: '', strokeStyle: '', shadowColor: '', shadowBlur: 0,
    save: rec('save'), restore: rec('restore'),
    beginPath: () => { ops.push({ name: 'beginPath', args: [] }); cur = box(); },
    closePath: rec('closePath'),
    moveTo: (x, y) => { ops.push({ name: 'moveTo', args: [x, y] }); add(x, y); },
    lineTo: (x, y) => { ops.push({ name: 'lineTo', args: [x, y] }); add(x, y); },
    fill: onFill('fill'), stroke: onFill('stroke'),
    translate: rec('translate'),
    count(name) { return ops.filter((o) => o.name === name).length; },
    widths() { return ops.filter((o) => o.name === 'lineWidth').map((o) => o.args[0]); },
    fills() { return paths.filter((p) => p.kind === 'fill'); },
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

check('y12 L 形不再被填平：走布尔并集（exact）、外环点数 > 4、凹口真的空着', () => {
  const fp = buildFootprint([{ walls: L_WALLS }]);
  assert(fp.exact === true, '应走精确并集（不是凸包兜底）');
  assert(fp.ring.length >= 6, `L 形外环至少 6 点，实际 ${fp.ring.length}`);
  // 凸包会认 (450,450) 在内（它落在 (0,0)(600,0)(600,300)(300,600)(0,600) 围出的凸包里），L 形不该
  assert(footprintContains(fp, { x: 450, y: 450 }) === false, '凹口里的点不该算在占地内');
  assert(footprintContains(fp, { x: 150, y: 450 }) === true, '竖臂内部应算在占地内');
  assert(footprintContains(fp, { x: 450, y: 150 }) === true, '横臂内部应算在占地内');
  return `外环 ${fp.ring.length} 点，${(fp.area / 1e4).toFixed(1)} m²`;
});

check('y13 房间的墙围成一圈时，中间的洞要**填掉**（否则房子画成空心框）', () => {
  const fp = buildFootprint(room());
  assert(fp.polygons.length === 1, `应只有一块，实际 ${fp.polygons.length}`);
  assert(fp.polygons[0].holes.length === 0, `默认不保留洞，实际 ${fp.polygons[0].holes.length}`);
  assert(Math.abs(fp.areaNet - fp.area) < 1, '默认面积 = 外轮廓面积（屋顶盖满）');
  return `洞 ${fp.polygons[0].holes.length} / 面积 ${(fp.area / 1e4).toFixed(1)} m²`;
});

check('y14 courtyard:true 时才留院子：够大的洞保留、面积扣掉', () => {
  const fp = buildFootprint([{ walls: L_WALLS }], { courtyard: true });
  assert(fp.polygons[0].holes.length === 1, `应保留 1 个洞，实际 ${fp.polygons[0].holes.length}`);
  assert(fp.areaNet < fp.area - 1000, `扣洞后面积应变小：${fp.area.toFixed(0)} → ${fp.areaNet.toFixed(0)}`);
  return `洞 ${(fp.area - fp.areaNet).toFixed(0)} cm²`;
});

check('y15 引擎炸了要退回凸包，不许整张地图画不出来', () => {
  const boom = { union() { throw new Error('boom'); } };
  const fp = buildFootprint(room(), { engine: boom });
  assert(fp !== null, '引擎异常时仍应给出轮廓');
  assert(fp.exact === false, '应标记 exact=false（走了兜底）');
  assert(fp.ring.length >= 3, '兜底轮廓应可用');
  return `兜底 ${fp.ring.length} 点`;
});

check('y16 两栋不相连的楼 → 两块地块，不是一个大外接框', () => {
  const a = [
    { start: { x: 0, y: 0 }, end: { x: 300, y: 0 } },
    { start: { x: 300, y: 0 }, end: { x: 300, y: 300 } },
    { start: { x: 300, y: 300 }, end: { x: 0, y: 300 } },
    { start: { x: 0, y: 300 }, end: { x: 0, y: 0 } },
  ];
  const b = a.map((w) => ({
    start: { x: w.start.x + 2000, y: w.start.y },
    end: { x: w.end.x + 2000, y: w.end.y },
  }));
  const fp = buildFootprint([{ walls: [...a, ...b] }]);
  assert(fp.polygons.length === 2, `应两块地块，实际 ${fp.polygons.length}`);
  assert(fp.ring.length >= 4, '主轮廓取面积最大的那块');
  const ctx = fakeCtx();
  drawBuildingSymbol(ctx, fp, { zoom: 1 });
  assert(ctx.count('closePath') >= 4, `两块 × (投影+屋顶) 至少 4 次闭合，实际 ${ctx.count('closePath')}`);
  return `2 块`;
});

check('y17 骨架脊线：L 形的每一笔都落在轮廓内', () => {
  const fp = buildFootprint([{ walls: L_WALLS }]);
  const ctx = fakeCtx();
  drawBuildingSymbol(ctx, fp, { zoom: 1, roof: 'gable' });
  const pts = ctx.ops.filter((o) => o.name === 'moveTo' || o.name === 'lineTo').map((o) => ({ x: o.args[0], y: o.args[1] }));
  // 脊线端点的容差放宽到 2cm：裁剪是按采样切的，边界上会有不到半个采样的误差
  const stray = pts.filter((q) => !footprintContains(fp, q)
    && !nearRing(fp, q, 2));
  assert(stray.length === 0, `有 ${stray.length} 个点落在轮廓外：${JSON.stringify(stray.slice(0, 3).map((q) => [Math.round(q.x), Math.round(q.y)]))}`);
  return `脊线全在轮廓内（${pts.length} 点）`;
});

check('y18 骨架脊线：L 形两臂各得一条，且不许贴着轮廓边（会看成双线）', () => {
  const fp = buildFootprint([{ walls: L_WALLS }]);
  const runs = skeletonRidge(fp.polygons, fp.rect);
  assert(runs.length >= 2, `L 形应至少 2 段骨架，实际 ${runs.length}`);
  const gap = Math.min(fp.rect.long, fp.rect.short) * 0.10;
  for (const run of runs) {
    assert(run.length >= 2, '每段至少 2 点');
    for (const p of run) {
      assert(footprintContains(fp, p), `骨架点 ${JSON.stringify([Math.round(p.x), Math.round(p.y)])} 落在轮廓外`);
      assert(distToRing(fp, p) >= gap - 1e-6, `骨架点离轮廓仅 ${distToRing(fp, p).toFixed(1)}cm（阈值 ${gap.toFixed(0)}cm），会看成双线`);
    }
  }
  return `${runs.length} 段 / 共 ${runs.reduce((n, r) => n + r.length, 0)} 点`;
});

check('y19 矩形平面不走骨架：直脊只画一条（骨架是给异形用的）', () => {
  const fp = buildFootprint([{ walls: L_WALLS }]);
  const rectFp = buildFootprint(room());
  const a = fakeCtx();
  const b = fakeCtx();
  drawBuildingSymbol(a, fp, { zoom: 1, roof: 'gable' });
  drawBuildingSymbol(b, rectFp, { zoom: 1, roof: 'gable' });
  const movesOf = (c) => c.ops.filter((o) => o.name === 'moveTo').length;
  assert(movesOf(a) > movesOf(b), `L 形的脊线笔数应多于矩形：${movesOf(a)} vs ${movesOf(b)}`);
  return `L ${movesOf(a)} 笔 / 矩形 ${movesOf(b)} 笔`;
});

// ── 屋顶随层数变化（2026-11-16，A-屋顶）──────────────────────────────────
// 之前两层楼与一层楼画得一模一样：地图上"这家是楼"读不出来。
// 口径：顶层面按层数内缩一圈，外面那圈是下一层的腰檐；一层楼走原路径（逐像素不变）。

check('y20 topInsetFor：一层不内缩、每层缩 12%、有下限（不许缩成另一个小房子）', () => {
  near(topInsetFor(1), 1, 1e-9, '一层');
  near(topInsetFor(2), 0.88, 1e-9, '两层');
  near(topInsetFor(3), 0.76, 1e-9, '三层');
  near(topInsetFor(5), 0.66, 1e-9, '五层（下限）');
  // 负向：0 / NaN / 负数都按一层处理，别把房子缩没了
  near(topInsetFor(0), 1, 1e-9, '0 层');
  near(topInsetFor(NaN), 1, 1e-9, 'NaN');
  return '1→1 / 2→0.88 / 3→0.76 / 5→0.66';
});

check('y21 insetFootprint：以包围盒中心等比内缩，长宽按比例缩，且不改入参', () => {
  const fp = buildFootprint(room());
  const cx = (fp.bbox.minX + fp.bbox.maxX) / 2;
  const cy = (fp.bbox.minY + fp.bbox.maxY) / 2;
  const before = JSON.stringify(fp.ring);
  const small = insetFootprint(fp, 0.8);
  // 中心不变
  near((small.bbox.minX + small.bbox.maxX) / 2, cx, 1e-9, '中心 x');
  near((small.bbox.minY + small.bbox.maxY) / 2, cy, 1e-9, '中心 y');
  // 尺寸按比例缩
  near(small.bbox.maxX - small.bbox.minX, (fp.bbox.maxX - fp.bbox.minX) * 0.8, 1e-6, '宽');
  near(small.bbox.maxY - small.bbox.minY, (fp.bbox.maxY - fp.bbox.minY) * 0.8, 1e-6, '高');
  near(small.rect.long, fp.rect.long * 0.8, 1e-6, '长轴');
  // 入参没被改（纯函数）
  assert(JSON.stringify(fp.ring) === before, '入参的 ring 被改了');
  // 1.0 直接返回同一个对象（一层楼零开销、零改动）
  assert(insetFootprint(fp, 1) === fp, 'factor=1 应原样返回');
  return `宽 ${Math.round(fp.bbox.maxX - fp.bbox.minX)} → ${Math.round(small.bbox.maxX - small.bbox.minX)}`;
});

check('y22 两层楼：先铺下层屋面、再压内缩的顶层面（fill 两次），脊线也随之变短', () => {
  const fp = buildFootprint(room());
  const one = fakeCtx();
  const two = fakeCtx();
  drawBuildingSymbol(one, fp, { zoom: 1, roof: 'hip', shadow: false });
  drawBuildingSymbol(two, fp, { zoom: 1, roof: 'hip', shadow: false, floors: 2 });
  assert(one.count('fill') === 1, `一层楼应只 fill 一次，实际 ${one.count('fill')}`);
  assert(two.count('fill') === 2, `两层楼应 fill 两次（下层屋面 + 顶层面），实际 ${two.count('fill')}`);
  // 轮廓描边：一层 1 次、两层 2 次（外边 + 顶层面内边）
  assert(one.count('stroke') < two.count('stroke'), `两层应多描一圈：${one.count('stroke')} vs ${two.count('stroke')}`);
  // 两次 fill 的盒子：第一次 = 整块轮廓（下层屋面），第二次 = 内缩后的顶层面
  const f2 = two.fills();
  assert(f2.length === 2, `两层楼的 fill 盒子应记到 2 个，实际 ${f2.length}`);
  assert(f2[1].w < f2[0].w && f2[1].h < f2[0].h,
    `顶层面应比下层小：${f2[1].w.toFixed(1)}×${f2[1].h.toFixed(1)} vs ${f2[0].w.toFixed(1)}×${f2[0].h.toFixed(1)}`);
  const ratio = f2[1].w / f2[0].w;
  near(ratio, 0.88, 0.02, '两层顶面比例');
  return `fill ${one.count('fill')} → ${two.count('fill')}，顶面 ${(ratio * 100).toFixed(0)}%`;
});

check('y23 一层楼走原路径（回归探针）：不传 floors 与传 1 的调用序列逐项相同', () => {
  const fp = buildFootprint(room());
  const a = fakeCtx();
  const b = fakeCtx();
  drawBuildingSymbol(a, fp, { zoom: 1, roof: 'hip' });
  drawBuildingSymbol(b, fp, { zoom: 1, roof: 'hip', floors: 1 });
  const sig = (c) => JSON.stringify(c.ops.map((o) => [o.name, o.args]));
  assert(sig(a) === sig(b), '传 floors:1 竟然改变了绘制序列');
  return `${a.ops.length} 个绘制调用完全一致`;
});

check('y24 三层及以上：顶面比两层更小，但不会缩到看不见（下限 66%）', () => {
  const fp = buildFootprint(room());
  const w = {};
  for (const n of [2, 3, 6]) {
    const c = fakeCtx();
    drawBuildingSymbol(c, fp, { zoom: 1, roof: 'hip', shadow: false, floors: n });
    const fills = c.fills();
    assert(fills.length === 2, `${n} 层应 fill 两次，实际 ${fills.length}`);
    w[n] = fills[1].w;             // 第二个 fill = 顶层面
  }
  assert(w[3] < w[2], `三层顶面应小于两层：${w[3].toFixed(1)} vs ${w[2].toFixed(1)}`);
  assert(w[6] <= w[3], '层数更多时顶面不应变大');
  // 下限：6 层的顶面宽度 ≥ 轮廓宽 × 0.72
  const full = fp.bbox.maxX - fp.bbox.minX;
  assert(w[6] >= full * 0.66 * 0.95, `6 层顶面缩过头了：${w[6].toFixed(1)} < ${(full * 0.66).toFixed(1)}`);
  return `顶面宽 2层 ${w[2].toFixed(0)} / 3层 ${w[3].toFixed(0)} / 6层 ${w[6].toFixed(0)}（轮廓 ${full.toFixed(0)}）`;
});

check('y25 层数来源：有墙的楼层才计数（没墙那层不参与占地，也就不会把屋顶画成两层）', () => {
  const f1 = { id: 'f1', walls: room()[0].walls, elevation: 0 };
  const f2 = { id: 'f2', walls: room()[0].walls, elevation: 300 };
  const empty = { id: 'f3', walls: [], elevation: 600 };
  const two = buildFootprint([f1, f2]);
  const twoPlusEmpty = buildFootprint([f1, f2, empty]);
  assert(two.floors === 2, `两层应有墙楼层 = 2，实际 ${two.floors}`);
  assert(twoPlusEmpty.floors === 2, `空的三层不应计数，实际 ${twoPlusEmpty.floors}`);
  // 画出来也确实是两层（fill 两次）
  const c = fakeCtx();
  drawBuildingSymbol(c, two, { zoom: 1, roof: 'hip', shadow: false });
  assert(c.count('fill') === 2, `两层楼应 fill 两次，实际 ${c.count('fill')}`);
  return `floors ${two.floors} / 加个空层仍 ${twoPlusEmpty.floors}`;
});

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? '❌' : '✅'} buildingSymbol 单测：${results.length - bad.length}/${results.length} 通过`);
process.exit(bad.length ? 1 : 0);
