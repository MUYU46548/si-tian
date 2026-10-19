// _shot03_autoriver_pruned.js —— 交付图 03「自动河-剪枝后」（真闸门 = 只画河道）
//
// 这一张与 02 是**同一份地形、同一段相机代码**，唯一差别 = 不碰闸门（走真实分位剪枝）。
// 并排看：02 是一整片平行斜线网格，03 是稀疏的河道（树枝状主干 + 少量支流）。
//
// 复现口径：与 _shot02_autoriver_unpruned.js 逐字相同的地形/掩膜/rasterLayer/相机，
//   只少了"强制不剪枝"那一段。
(async () => {
  const out = {};
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const sc = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));
  const KEY = 'labShotMound';   // 与 01/02/04/05/06 同一份合成地形（同一底图键）
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
  // 🔴 右下角小地图是**画在画布上**的（`drawMinimap`）→ 关掉它；像素计数再按右下角矩形兜底排除
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

  const net = (typeof sc.getAutoRiverNetwork === 'function') ? sc.getAutoRiverNetwork() : (sc.autoRiverSegments || []);
  out.netSegments = net.length;
  const gate = (typeof sc.riverFlowGate === 'function') ? sc.riverFlowGate(sc.autoRiverMaxFlow, sc.autoRiverSegments) : null;
  out.gate = gate;
  out.kept = (typeof sc.pruneRiverNetwork === 'function') ? sc.pruneRiverNetwork(net, gate).kept.length : null;
  out.keptRatioPct = out.kept ? Math.round((out.kept / Math.max(1, out.netSegments)) * 1000) / 10 : null;
  // 闸门分位口径的现场读数：段流量的分位分布（解释"闸门为什么是这个数"）
  const flows = (sc.autoRiverSegments || []).map((x) => Number(x && x.flow)).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (flows.length) {
    const q = (p) => flows[Math.max(0, Math.min(flows.length - 1, Math.floor(flows.length * p)))];
    out.flowQuantiles = { n: flows.length, min: flows[0], p50: q(0.5), p88: q(0.88), max: flows[flows.length - 1] };
  }

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
  revealOverlays(); sc.render(); await tick(300);
  out.riverPixels = countRiverPixels();
  out.riverPixelRatioPct = Math.round((out.riverPixels / Math.max(1, cvs.width * cvs.height)) * 10000) / 100;
  revealOverlays(); sc.render(); await tick(250); revealOverlays();
  return JSON.stringify(out);
})()
