// _shot02_autoriver_unpruned.js —— 交付图 02「自动河-剪枝前」（强制"全部段都画"）
//
// 这一张要证明：不剪枝时自动河网就是**一整片平行斜线网格**（每格一根小棍铺满全图），
// 与 03（真闸门 = 只画河道）并排看，差异一眼可见。
//
// 固定参数（与 03 完全同地形/同相机）：
//   · 圆丘地形 121×121 / spacing 20（与 _probe_auto_river_visual.js 同一份合成地形）
//   · 圆形陆地掩膜（半径 = h≥20 等值线 ≈ 1272 世界单位）—— 让"陆地判定"与真实底图同形
//   · `rasterLayer='none'`（避免 landsea 的海色 #c9d6e4 被河色分类器算进去，也去掉底噪）
//   · 相机 = 把整幅网格（2400×2400）装进画布，5% 余量（与 03 逐字同一段代码）
//
// 🔴 怎么"强制不剪枝"（任务书给的第一条路不保证生效，所以两条都试、据实记录）：
//   ① 任务书建议：`sc.riverFlowGate = () => 0`。渲染侧读的可能是**闭包里的**那个函数
//      （`<script setup>` 的编译产物），此时覆盖 setupState 上的同名属性**不生効** ——
//      所以这里先覆盖、再用"河色像素数是否显著变多"判定它到底有没有生效。
//   ② 保底路（走产品自己的既有契约）：把每一段的 `flow` 清成 `undefined` + 段流量上界清 0 →
//      `riverFlowGateByQuantile` 无流量数据返回 0 → `riverFlowGate` 兜底也算不出 → 返回 0 →
//      `pruneRiverNetwork(_, 0)` 走 `if (!(th > 0)) { kept = 全部 }` = **不剪枝**。
//      这正是产品注释里写的"无数据时 0 = 不剪"。
//      ⚠️ 代价（文档里必须说）：流量清空后线宽一律落到下限 `netMinPx`（1.2px），
//         比真实的"不剪枝"少了干流那一档更粗的线 —— 但真实分布里 88% 的段本来就是细支流。
(async () => {
  const out = {};
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const sc = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));
  const KEY = 'labShotMound';   // 与 01/03/04/05/06 同一份合成地形（同一底图键）
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

  // ── 圆丘地形 + 圆形陆地掩膜 ──
  const SP = 20, COLS = 121, ROWS = 121, GX0 = -2000, GY0 = -2000;
  const CXW = GX0 + 60 * SP, CYW = GY0 + 60 * SP;      // 圆丘中心 (-800, -800)
  const ISLAND_R = 63.6 * SP;                          // h = 90 - d*1.1 = 20 → d = 63.6 格
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
  sc.riverSmooth = false;                 // 与 03 同参数：不开平滑（开平滑要同时降源头闸门，那是另一组对照）
  await tick(80);
  // 🔴 右下角小地图是**画在画布上**的（`drawMinimap`，150×150 + pad 12）→ 关掉它；
  //    像素计数再按右下角矩形兜底排除（它的板岩灰会被河色分类器算进"河色像素"）
  sc.showMinimap = false;
  // 🔴 写 setupState 上的 ref 到底生没生効，读回来留证（本项目在"探针写 ref 假红"上踩过）
  out.stateEcho = { rasterLayer: sc.rasterLayer, showRivers: sc.showRivers, riverSource: sc.riverSource,
    riverSmooth: sc.riverSmooth, showMinimap: sc.showMinimap };
  const minWidthNet = () => (typeof sc.riverMinWidthForNet === 'function' ? sc.riverMinWidthForNet() : null);

  // ── 生成自动河流 ──
  sc.generateAndShowRivers();
  await tick(600);
  out.autoRivers = (sc.autoRivers || []).length;
  out.segments = (sc.autoRiverSegments || []).length;
  out.maxFlow = sc.autoRiverMaxFlow;
  out.drawnReported = sc.autoRiverDrawn;
  out.statusMsg = String(sc.provinceHint || '').slice(0, 200);

  // ── 相机：装下整幅网格（与 03 逐字同一段）──
  const cvs = sc.canvas;
  const rc = cvs.getBoundingClientRect();
  const spanX = (COLS - 1) * SP, spanY = (ROWS - 1) * SP;
  const fit = Math.min(rc.width / (spanX * 1.05), rc.height / (spanY * 1.05));
  sc.cameraScale = fit;
  sc.cameraX = rc.width / 2 - CXW * fit;
  sc.cameraY = rc.height / 2 - CYW * fit;
  out.fitScale = Math.round(fit * 1000) / 1000;
  out.cellPx = Math.round(SP * fit * 100) / 100;
  const mwn = minWidthNet();
  out.netMinPx = mwn === null ? null : Math.round(mwn * 100) / 100;
  out.netMinPxOnScreen = mwn === null ? null : Math.round(mwn * fit * 100) / 100;
  out.canvas = [cvs.width, cvs.height];
  out.rect = [Math.round(rc.width), Math.round(rc.height)];

  // ── 真闸门读数（与 03 对照的那两个数）──
  const net = (typeof sc.getAutoRiverNetwork === 'function') ? sc.getAutoRiverNetwork() : (sc.autoRiverSegments || []);
  out.netSegments = net.length;
  const gateReal = (typeof sc.riverFlowGate === 'function') ? sc.riverFlowGate(sc.autoRiverMaxFlow, sc.autoRiverSegments) : null;
  out.gateReal = gateReal;
  out.keptReal = (typeof sc.pruneRiverNetwork === 'function') ? sc.pruneRiverNetwork(net, gateReal).kept.length : null;

  const countRiverPixels = () => {
    const img = cvs.getContext('2d').getImageData(0, 0, cvs.width, cvs.height).data;
    const mx = Math.round((rc.width - 170) * (cvs.width / rc.width));
    const my = Math.round((rc.height - 170) * (cvs.height / rc.height));
    let n = 0;
    for (let i = 0; i < img.length; i += 4) {
      const k = i / 4;
      const X = k % cvs.width, Y = Math.floor(k / cvs.width);
      if (X >= mx && Y >= my) continue;                  // 右下角小地图兜底排除
      if (isRiver(img[i], img[i + 1], img[i + 2])) n++;
    }
    return n;
  };
  revealOverlays(); sc.render(); await tick(200); revealOverlays();
  out.riverPixelsRealGate = countRiverPixels();

  // ── ① 任务书那条路：覆盖 setupState 上的 riverFlowGate ──
  // 先把**真的**那个函数留一份引用：覆盖之后如果没生效，读数仍要用真函数算（否则量的是我的假函数）
  const realGateFn = sc.riverFlowGate;
  const realPruneFn = sc.pruneRiverNetwork;
  let overrideEffective = false;
  try {
    sc.riverFlowGate = () => 0;
    revealOverlays(); sc.render(); await tick(200);
    out.riverPixelsAfterOverride = countRiverPixels();
    overrideEffective = out.riverPixelsAfterOverride > out.riverPixelsRealGate * 1.5;
  } catch (e) {
    out.overrideError = String((e && e.message) || e);
  }
  out.overrideEffective = overrideEffective;

  // ── ② 保底路：flow 清空 → 闸门 0 → 不剪枝 ──
  if (!overrideEffective) {
    for (const seg of (sc.autoRiverSegments || [])) seg.flow = undefined;
    sc.autoRiverMaxFlow = 0;
    sc.autoRivers = (sc.autoRivers || []).slice();      // 换引用 → getAutoRiverNetwork 的按引用缓存失效
    out.autoRiverDrawn = (sc.autoRiverSegments || []).length;
  }
  out.mode = overrideEffective ? 'override-sc.riverFlowGate' : 'flow-cleared(闸门0=不剪)';
  const netAfter = (typeof sc.getAutoRiverNetwork === 'function') ? sc.getAutoRiverNetwork() : (sc.autoRiverSegments || []);
  // ⚠️ 读数一律走**真的**那个闸门函数（覆盖没生效时它才是渲染实际用的那个）
  const gateAfter = (typeof realGateFn === 'function') ? realGateFn(sc.autoRiverMaxFlow, sc.autoRiverSegments) : null;
  out.gateAfter = gateAfter;
  out.gateAfterFromFakeProperty = (typeof sc.riverFlowGate === 'function') ? sc.riverFlowGate(sc.autoRiverMaxFlow, sc.autoRiverSegments) : null;
  out.netAfter = netAfter.length;
  out.keptAfter = (typeof realPruneFn === 'function') ? realPruneFn(netAfter, gateAfter).kept.length : null;
  out.allSegmentsDrawn = out.keptAfter === out.netAfter;

  revealOverlays(); sc.render(); await tick(300);
  out.riverPixelsFinal = countRiverPixels();
  out.riverPixelsRatioVsPruned = Math.round((out.riverPixelsFinal / Math.max(1, out.riverPixelsRealGate)) * 100) / 100;
  // 🔴 状态栏那行字是 `generateAndShowRivers()` 写的（说的是"只画 2903/11225 段"）——
  //    与本图实际画的（全部段）**矛盾**。截图会把它一起拍进去，所以必须改写成真话
  //    （`statusMsg()` 写的就是这个 ref）。
  sc.provinceHint = `【探针强制不剪枝】全部 ${out.netAfter} 段都画（闸门 0）`
    + ` · 真闸门本会是 ${gateReal} → 只画 ${out.keptReal} 段 · 缩放 ${out.fitScale}`;
  out.statusMsgAfter = String(sc.provinceHint || '');
  revealOverlays(); sc.render(); await tick(250); revealOverlays();
  return JSON.stringify(out);
})()
