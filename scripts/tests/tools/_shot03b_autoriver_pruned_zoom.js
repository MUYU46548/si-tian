// _shot03b_autoriver_pruned_zoom.js —— 补充图 03b「自动河-剪枝后-放大」
//
// 与 02b **同一份地形、同一档缩放（0.8）、同一段相机代码**（都对准"真闸门下流量最大的那一段"），
// 唯一差别 = 不碰闸门（走真实分位剪枝）。
// 03（看全图 0.267）与 03b（看清线 0.8）的分工同 02/02b：全图那档线宽只有 0.35px，
// 只能看出"有没有一层纹路"；要看清"河道 vs 网格"必须放大到 0.8（线宽 ≈0.96px）。
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
  out.drawnReported = sc.autoRiverDrawn;
  out.statusMsg = String(sc.provinceHint || '').slice(0, 200);
  const cvs = sc.canvas;
  const rc = cvs.getBoundingClientRect();
  const net = (typeof sc.getAutoRiverNetwork === 'function') ? sc.getAutoRiverNetwork() : (sc.autoRiverSegments || []);
  const gate = (typeof sc.riverFlowGate === 'function') ? sc.riverFlowGate(sc.autoRiverMaxFlow, sc.autoRiverSegments) : null;
  const pruned = (typeof sc.pruneRiverNetwork === 'function') ? sc.pruneRiverNetwork(net, gate).kept : net;
  out.netSegments = net.length;
  out.gate = gate;
  out.kept = pruned.length;
  // 与 02b 同一段代码 → 同一台相机
  const byFlow = pruned.slice().sort((a, b) => (b.flow || 0) - (a.flow || 0));
  const target = byFlow[0] || { x0: CXW, y0: CYW, x1: CXW + SP, y1: CYW, flow: 0 };
  const tx = (target.x0 + target.x1) / 2, ty = (target.y0 + target.y1) / 2;
  out.zoom = ZOOM;
  out.cellPx = SP * ZOOM;
  out.cameraCenter = [Math.round(tx), Math.round(ty)];
  out.targetFlow = target.flow;
  const mwn = (typeof sc.riverMinWidthForNet === 'function') ? sc.riverMinWidthForNet() : null;
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
  sc.provinceHint = `真闸门 ${gate} → 只画河道 ${out.kept}/${out.netSegments} 段`
    + ` · 缩放 ${ZOOM} · 一格 ${SP * ZOOM}px（对照 02b：全部段都画）`;
  revealOverlays(); sc.render(); await tick(350); revealOverlays();
  out.riverPixels = countRiverPixels();
  out.riverPixelRatioPct = Math.round((out.riverPixels / Math.max(1, cvs.width * cvs.height)) * 10000) / 100;
  revealOverlays(); sc.render(); await tick(250); revealOverlays();
  return JSON.stringify(out);
})()
