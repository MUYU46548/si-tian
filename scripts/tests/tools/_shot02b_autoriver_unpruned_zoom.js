// _shot02b_autoriver_unpruned_zoom.js —— 补充图 02b「自动河-剪枝前-放大」
//
// 为什么要这一张：02 是**看全图**（相机缩放 0.267）—— 那时一格的屏幕尺寸只有 5.3px，
// 而线宽 = `max(netMinPx, …) × 缩放` ≈ **0.35px**，整片河网在图上只是一层很淡的纹路
// （实测"河色像素"只有 294 个 / 727k，占 0.04%）。"看全图"与"看清线"需要两个比例尺，
// 这一张取 0.8（一格 16px、线宽 ≈0.96px），对准**流量最大那一段**（干流附近，河道最密处）。
//
// 强制不剪枝的手段**与 02 逐字相同**：02 已实测 `sc.riverFlowGate = () => 0` **不生効**
// （河色像素数一模一样 294 → 渲染读的是 `<script setup>` 闭包/`$setup` 绑定，不是 setupState 属性），
// 所以这里直接用生效的那条：把每段 `flow` 清成 `undefined` + 段流量上界清 0 →
// `riverFlowGateByQuantile` 无数据返回 0 → `riverFlowGate` 兜底也算不出 → 0 →
// `pruneRiverNetwork(_, 0)` 走 `if (!(th > 0)) { kept = 全部 }`。
// ⚠️ 代价：线宽一律落到下限（干流那一档更粗的线没了）。
(async () => {
  const out = {};
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const sc = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));
  const KEY = 'labShotMound';
  const ZOOM = 0.8;
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
  sc.showMinimap = false;
  await tick(80);
  out.stateEcho = { rasterLayer: sc.rasterLayer, showRivers: sc.showRivers, riverSource: sc.riverSource, showMinimap: sc.showMinimap };

  sc.generateAndShowRivers();
  await tick(600);
  out.autoRivers = (sc.autoRivers || []).length;
  out.segments = (sc.autoRiverSegments || []).length;
  out.maxFlow = sc.autoRiverMaxFlow;
  const cvs = sc.canvas;
  const rc = cvs.getBoundingClientRect();
  const net = (typeof sc.getAutoRiverNetwork === 'function') ? sc.getAutoRiverNetwork() : (sc.autoRiverSegments || []);
  const gateReal = (typeof sc.riverFlowGate === 'function') ? sc.riverFlowGate(sc.autoRiverMaxFlow, sc.autoRiverSegments) : null;
  const realPruneFn = sc.pruneRiverNetwork;
  out.netSegments = net.length;
  out.gateReal = gateReal;
  const prunedReal = (typeof realPruneFn === 'function') ? realPruneFn(net, gateReal).kept : net;
  out.keptReal = prunedReal.length;
  const byFlow = prunedReal.slice().sort((a, b) => (b.flow || 0) - (a.flow || 0));
  const target = byFlow[0] || { x0: CXW, y0: CYW, x1: CXW + SP, y1: CYW, flow: 0 };
  const tx = (target.x0 + target.x1) / 2, ty = (target.y0 + target.y1) / 2;
  out.zoom = ZOOM;
  out.cellPx = SP * ZOOM;
  out.cameraCenter = [Math.round(tx), Math.round(ty)];
  out.targetFlow = target.flow;

  // ── 强制不剪枝（02 已证明 override 不生効 → 直接走生效的那条）──
  for (const seg of (sc.autoRiverSegments || [])) seg.flow = undefined;
  sc.autoRiverMaxFlow = 0;
  sc.autoRivers = (sc.autoRivers || []).slice();
  const netAfter = (typeof sc.getAutoRiverNetwork === 'function') ? sc.getAutoRiverNetwork() : (sc.autoRiverSegments || []);
  const mwn = (typeof sc.riverMinWidthForNet === 'function') ? sc.riverMinWidthForNet() : null;
  out.gateAfter = (typeof sc.riverFlowGate === 'function') ? sc.riverFlowGate(0, sc.autoRiverSegments) : null;
  out.netAfter = netAfter.length;
  out.keptAfter = (typeof realPruneFn === 'function') ? realPruneFn(netAfter, 0).kept.length : null;
  out.allSegmentsDrawn = out.keptAfter === out.netAfter;
  out.netMinPx = mwn === null ? null : Math.round(mwn * 100) / 100;
  out.onScreenMinPx = mwn === null ? null : Math.round(mwn * ZOOM * 100) / 100;
  out.canvas = [cvs.width, cvs.height];
  out.rect = [Math.round(rc.width), Math.round(rc.height)];

  sc.cameraScale = ZOOM;
  sc.cameraX = rc.width / 2 - tx * ZOOM;
  sc.cameraY = rc.height / 2 - ty * ZOOM;
  const dpr = cvs.width / rc.width;
  const MMX = Math.round((rc.width - 170) * dpr), MMY = Math.round((rc.height - 170) * dpr);
  const countRiverPixels = () => {
    const img = cvs.getContext('2d').getImageData(0, 0, cvs.width, cvs.height).data;
    let n = 0;
    for (let i = 0; i < img.length; i += 4) {
      const k = i / 4;
      if ((k % cvs.width) >= MMX && Math.floor(k / cvs.width) >= MMY) continue;
      if (isRiver(img[i], img[i + 1], img[i + 2])) n++;
    }
    return n;
  };
  sc.provinceHint = `【探针强制不剪枝】全部 ${out.netAfter} 段都画（闸门 0）`
    + ` · 真闸门本会是 ${gateReal} → 只画 ${out.keptReal} 段 · 缩放 ${ZOOM} · 一格 ${SP * ZOOM}px`;
  revealOverlays(); sc.render(); await tick(350); revealOverlays();
  out.riverPixels = countRiverPixels();
  out.riverPixelRatioPct = Math.round((out.riverPixels / Math.max(1, cvs.width * cvs.height)) * 10000) / 100;
  revealOverlays(); sc.render(); await tick(250); revealOverlays();
  return JSON.stringify(out);
})()
