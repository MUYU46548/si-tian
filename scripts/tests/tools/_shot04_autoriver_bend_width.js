// _shot04_autoriver_bend_width.js —— 交付图 04「自动河-放大看弯与粗细」
//
// 这一张要证明两件事（都是用户原话）：
//   · 「不会弯吗？」→ 河是**弯的**，不是小棍拼的；
//   · 「河流并没有越往下游越宽」→ 有可见的粗细变化。
//
// 固定参数：
//   · 与 02/03 **同一份圆丘地形**（121×121 / spacing 20 / 圆形陆地掩膜）
//   · 真闸门剪枝（不强制），`rasterLayer='none'`
//   · 相机：`cameraScale = 1.0`，对准**流量最大那一段**（= 河道密集处/干流），
//     可视世界窗口 = 1280×800（= 64×40 格）
//
// 数值判据（写进文档）：
//   · 弯：对保留下来的段调用**产品自己的** `sc.riverMeanderControl(seg)`，
//     算控制点相对段中点的偏移（世界单位×缩放=屏幕像素）；二次贝塞尔在中点的
//     实际偏离 ≈ 控制点偏移的一半，所以两个数都给。
//   · 粗细：在高流量段与低流量段上各取若干段，沿**法线**扫 ±8px 数河色像素（真值），
//     并给出产品 `basemapRiverWidthPx` 的"意图宽度"作对照。
(async () => {
  const out = {};
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const sc = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));
  const KEY = 'labShotMound';   // 与 01/02/03/05/06 同一份合成地形（同一底图键）
  const isRiver = (r, g, b) => (b > r + 18) && (b > 90) && (g > r) && (r < 160);
  const revealOverlays = () => {
    for (const fx of [0.25, 0.4, 0.55, 0.7, 0.85]) for (const fy of [0.3, 0.45, 0.6, 0.75]) {
      const el = document.elementFromPoint(innerWidth * fx, innerHeight * fy);
      if (!el || el.tagName === 'CANVAS') continue;
      let n = el, d = 0;
      while (n && n !== document.body && d < 8) {
        const cs = getComputedStyle(n);
        if (cs.position === 'absolute' || cs.position === 'fixed') { n.style.display = 'none'; break; }
        n = n.parentElement; d++;
      }
    }
  };
  try { document.querySelectorAll('.panel-close, [data-testid="panel-close"]').forEach((b) => b.click()); } catch (e) { /* 关不掉不致命 */ }

  const SP = 20, COLS = 121, ROWS = 121, GX0 = -2000, GY0 = -2000;
  const CXW = GX0 + 60 * SP, CYW = GY0 + 60 * SP;
  const ISLAND_R = 63.6 * SP;
  const gpts = [], h = [];
  for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
    gpts.push({ x: GX0 + i * SP, y: GY0 + j * SP });
    const d = Math.hypot(i - 60, j - 60);
    h.push(Math.max(0, Math.min(100, Math.round(90 - d * 1.1))));
  }
  const hm = { h, grid: { points: gpts, cellsX: COLS, cellsY: ROWS, spacing: SP } };
  const landPts = [];
  for (let k = 0; k < 90; k++) {
    const a = (k / 90) * Math.PI * 2;
    landPts.push({ x: CXW + Math.cos(a) * ISLAND_R, y: CYW + Math.sin(a) * ISLAND_R });
  }
  const land = { id: 'L1', name: '陆地', kind: 'land', color: '#c98a5b', points: landPts };
  s.baseMaps = { ...s.baseMaps, [KEY]: { id: KEY, name: KEY, terrain: [land], referenceImages: [],
    heightmap: hm, rivers: [], routes: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } };
  sc.baseMapKey = KEY;
  if (typeof sc.onBaseMapChange === 'function') await sc.onBaseMapChange();
  await tick(300);
  sc.rasterLayer = 'none';
  sc.showRivers = true;
  sc.riverSource = 'both';
  sc.riverSmooth = false;
  await tick(80);
  // 🔴 右下角小地图是**画在画布上**的（`drawMinimap`）→ 关掉它；像素扫描再按右下角矩形兜底排除
  sc.showMinimap = false;
  // 🔴 写 setupState 上的 ref 到底生没生効，读回来留证（本项目在"探针写 ref 假红"上踩过）
  out.stateEcho = { rasterLayer: sc.rasterLayer, showRivers: sc.showRivers, riverSource: sc.riverSource,
    riverSmooth: sc.riverSmooth, showMinimap: sc.showMinimap };
  const minWidthNet = () => (typeof sc.riverMinWidthForNet === 'function' ? sc.riverMinWidthForNet() : null);

  sc.generateAndShowRivers();
  await tick(600);
  out.autoRivers = (sc.autoRivers || []).length;
  out.segments = (sc.autoRiverSegments || []).length;
  out.maxFlow = sc.autoRiverMaxFlow;
  out.drawnReported = sc.autoRiverDrawn;
  out.statusMsg = String(sc.provinceHint || '').slice(0, 200);

  const net = (typeof sc.getAutoRiverNetwork === 'function') ? sc.getAutoRiverNetwork() : (sc.autoRiverSegments || []);
  const gate = (typeof sc.riverFlowGate === 'function') ? sc.riverFlowGate(sc.autoRiverMaxFlow, sc.autoRiverSegments) : 0;
  const kept = (typeof sc.pruneRiverNetwork === 'function') ? sc.pruneRiverNetwork(net, gate).kept : net;
  out.gate = gate;
  out.netSegments = net.length;
  out.kept = kept.length;
  if (!kept.length) {
    out.fail = '没有留下来的段 —— 这一张拍不出河道（据实报）';
    revealOverlays(); sc.render(); await tick(200);
    return JSON.stringify(out);
  }

  // ── 相机：scale 1，对准流量最大那一段的中点（= 河道密集处/干流）──
  // 🔴 顺序很重要：`riverMeanderControl` 内部读 `cameraScale`，所以**必须先定相机再量弯**——
  //    第一版在定相机之前量，量到的是"上一档缩放下"的弯曲幅度（3.39 世界单位），
  //    而 scale=1 时它被 `RIVER_MEANDER_MAX_PX=1.8` 夹到 1.8 —— 两个数是两回事。
  const byFlowAll = kept.slice().sort((a, b) => (b.flow || 0) - (a.flow || 0));
  const target = byFlowAll[0];
  const tx = (target.x0 + target.x1) / 2, ty = (target.y0 + target.y1) / 2;
  const cvs = sc.canvas;
  const rc = cvs.getBoundingClientRect();
  sc.cameraScale = 1.0;
  sc.cameraX = rc.width / 2 - tx;
  sc.cameraY = rc.height / 2 - ty;
  out.camera = { scale: sc.cameraScale, x: Math.round(sc.cameraX), y: Math.round(sc.cameraY),
    centerWorld: [Math.round(tx), Math.round(ty)], targetFlow: target.flow };
  out.canvas = [cvs.width, cvs.height];
  out.rect = [Math.round(rc.width), Math.round(rc.height)];
  const mwn = minWidthNet();
  out.netMinPx = mwn === null ? null : Math.round(mwn * 100) / 100;
  out.cellPx = SP * 1;
  await tick(60);

  // 🔴 必须**先筛出"落在可视窗口里"的段**再取前 N —— 第一版直接取全局流量前 12，
  //    其中 10 段的屏幕位置根本在画布外（实测 screen x=1450 / 2940），法线扫描读到 0，
  //    中位数就成了 0（假读数）。判据：段中点落在画布内（留 20px 余量）。
  const screenOf = (wx, wy) => [sc.cameraX + wx * sc.cameraScale, sc.cameraY + wy * sc.cameraScale];
  const segMid = (g) => [(g.x0 + g.x1) / 2, (g.y0 + g.y1) / 2];
  const inView = kept.filter((g) => {
    const [mx, my] = segMid(g);
    const [sx, sy] = screenOf(mx, my);
    return sx >= 20 && sy >= 20 && sx < rc.width - 20 && sy < rc.height - 20;
  });
  out.keptInView = inView.length;
  out.keptInViewPct = Math.round((inView.length / Math.max(1, kept.length)) * 1000) / 10;
  if (!inView.length) {
    out.fail = '可视窗口里没有保留下来的段 —— 拍不出（据实报）';
    revealOverlays(); sc.render(); await tick(200);
    return JSON.stringify(out);
  }
  const inViewByFlow = inView.slice().sort((a, b) => (b.flow || 0) - (a.flow || 0));

  // ── 弯：产品自己的 riverMeanderControl（**在 scale=1 下定相机之后**量）──
  const meanderAt = (seg) => {
    if (typeof sc.riverMeanderControl !== 'function') return null;
    const c = sc.riverMeanderControl(seg);
    if (!c) return 0;
    const [mx, my] = segMid(seg);
    return Math.hypot(c.x - mx, c.y - my);           // 世界单位
  };
  const top200 = inViewByFlow.slice(0, 200);
  const offs = top200.map(meanderAt).filter((v) => v !== null).sort((a, b) => a - b);
  const segLens = top200.map((g) => Math.hypot(g.x1 - g.x0, g.y1 - g.y0)).sort((a, b) => a - b);
  if (offs.length) {
    const q = (arr, p) => arr[Math.max(0, Math.min(arr.length - 1, Math.floor(arr.length * p)))];
    out.meanderWorld = { p50: Math.round(q(offs, 0.5) * 1000) / 1000, max: Math.round(offs[offs.length - 1] * 1000) / 1000,
      note: 'scale=1 下 riverMeanderControl 的返回偏移（世界单位）' };
    out.segLenWorld = { p50: Math.round(q(segLens, 0.5) * 100) / 100, max: Math.round(segLens[segLens.length - 1] * 100) / 100 };
    out.meanderPxAtScale1 = { controlOffsetP50: Math.round(q(offs, 0.5) * 1000) / 1000,
      controlOffsetMax: Math.round(offs[offs.length - 1] * 1000) / 1000,
      curveDeviationApproxP50: Math.round((q(offs, 0.5) / 2) * 1000) / 1000,
      note: 'scale=1 → 世界单位 = 屏幕像素；控制点偏移的 1/2 ≈ 二次贝塞尔在中点的实际偏离',
      capBinds: q(offs, 0.5) >= (sc.RIVER_MEANDER_MAX_PX || 1.8) - 1e-6 };
  } else {
    out.meanderPxAtScale1 = null;
  }
  revealOverlays(); sc.render(); await tick(250); revealOverlays();

  // ── 像素真值：法线扫描量线宽 ──
  const dpr = cvs.width / rc.width;
  const img = cvs.getContext('2d').getImageData(0, 0, cvs.width, cvs.height).data;
  const at = (X, Y) => { const i = (Y * cvs.width + X) * 4; return [img[i], img[i + 1], img[i + 2]]; };
  const MMX = Math.round((rc.width - 170) * dpr), MMY = Math.round((rc.height - 170) * dpr);
  const masked = (X, Y) => X >= MMX && Y >= MMY;
  const widthOf = (seg, halfPx) => {
    const mx = (seg.x0 + seg.x1) / 2, my = (seg.y0 + seg.y1) / 2;
    const dx = seg.x1 - seg.x0, dy = seg.y1 - seg.y0;
    const nl = Math.hypot(dx, dy) || 1;
    const nx = -dy / nl, ny = dx / nl;
    const cx0 = Math.round((sc.cameraX + mx * sc.cameraScale) * dpr);
    const cy0 = Math.round((sc.cameraY + my * sc.cameraScale) * dpr);
    let hits = 0, runs = 0, inRun = false;
    for (let t = -halfPx; t <= halfPx; t += 1) {
      const X = Math.round(cx0 + nx * t * dpr), Y = Math.round(cy0 + ny * t * dpr);
      if (X < 0 || Y < 0 || X >= cvs.width || Y >= cvs.height || masked(X, Y)) continue;
      const p = at(X, Y);
      const isHit = isRiver(p[0], p[1], p[2]);
      if (isHit) { hits++; if (!inRun) { runs++; inRun = true; } } else inRun = false;
    }
    return { hits, runs };
  };
  const med = (arr) => { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
  // 🔴 诊断：段中点附近 41×41 里找最近的河色像素，报告**偏移量**。
  //    第一版扫描在 12 个最高流量段里有 10 个读到 0 —— 必须分清是"我的屏幕映射有系统性偏差"
  //    还是"河确实不在段中点"（前者是我量错，后者才是产品口径问题）。
  const midProbe = (seg) => {
    const mx = (seg.x0 + seg.x1) / 2, my = (seg.y0 + seg.y1) / 2;
    const cx0 = Math.round((sc.cameraX + mx * sc.cameraScale) * dpr);
    const cy0 = Math.round((sc.cameraY + my * sc.cameraScale) * dpr);
    let found = 0, best = null, bestD = Infinity;
    for (let oy = -20; oy <= 20; oy++) for (let ox = -20; ox <= 20; ox++) {
      const X = cx0 + ox, Y = cy0 + oy;
      if (X < 0 || Y < 0 || X >= cvs.width || Y >= cvs.height || masked(X, Y)) continue;
      const p = at(X, Y);
      if (!isRiver(p[0], p[1], p[2])) continue;
      found++;
      const d = Math.hypot(ox, oy);
      if (d < bestD) { bestD = d; best = [ox, oy, p]; }
    }
    const center = at(cx0, cy0);
    return { screen: [cx0, cy0], world: [Math.round(mx), Math.round(my)], foundIn41x41: found,
      nearestOffset: best ? [best[0], best[1]] : null, nearestDist: best ? Math.round(bestD * 10) / 10 : null,
      nearestColor: best ? best[2] : null, centerColor: center || null, flow: seg.flow, endInSea: !!seg.endInSea };
  };
  out.midpointProbe = inViewByFlow.slice(0, 3).map(midProbe);
  const hi = inViewByFlow.slice(0, 12).map((g) => widthOf(g, 8));
  const lo = inViewByFlow.slice(Math.max(0, inViewByFlow.length - 12)).map((g) => widthOf(g, 8));
  out.widthPxTop12 = { medianHits: med(hi.map((x) => x.hits)), samples: hi.map((x) => x.hits) };
  out.widthPxBottom12 = { medianHits: med(lo.map((x) => x.hits)), samples: lo.map((x) => x.hits) };
  out.widthRatioMedian = (out.widthPxBottom12.medianHits ? Math.round((out.widthPxTop12.medianHits / out.widthPxBottom12.medianHits) * 100) / 100 : null);
  // 产品口径的"意图宽度"（同一条公式的现场读数，供解释像素读数）
  if (typeof sc.basemapRiverWidthPx === 'function' && typeof sc.flowToDischargeEquivalent === 'function') {
    const intend = (g) => Math.max(mwn === null ? 1.2 : mwn,
      sc.basemapRiverWidthPx({ width: 0.2, discharge: sc.flowToDischargeEquivalent(g.flow, sc.autoRiverMaxFlow) }));
    out.intendedWidthPx = { top: Math.round(intend(inViewByFlow[0]) * 100) / 100,
      bottom: Math.round(intend(inViewByFlow[inViewByFlow.length - 1]) * 100) / 100,
      note: '同一份产品公式（width=0.2 + flow 折算 discharge）在可视窗口里最高/最低流量段上的取值' };
  }
  // 再给一档更中性的口径：可视窗口内流量最高/最低段的**汇流量**（解释粗细差来自哪里）
  out.inViewFlowRange = { max: inViewByFlow[0].flow, min: inViewByFlow[inViewByFlow.length - 1].flow };
  revealOverlays(); sc.render(); await tick(250); revealOverlays();
  return JSON.stringify(out);
})()
