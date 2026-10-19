// _shot05_three_rivers_one_color.js —— 交付图 05「颜色统一」
//
// 这一张要证明：同一张底图上**同时**画出来的三条河（导入河 / 手画河 / 自动河）
// 是**同一种蓝**（唯一河色 #5d97bb），不再有第二种蓝。
//
// 固定参数：
//   · 与 01~04/06 同一份合成地形（圆丘 121×121 / spacing 20 / 圆形陆地掩膜）
//   · `rasterLayer='none'`，相机 = `scale = 1.0`，对准流量最大那一段（夹到岛内半径 ≤820，保证两条手工河都在掩膜里）
//   · 导入河 `{id:'imported_x', width:0.26, discharge:600}`（id 不以 `river_` 开头 → 走 `drawRivers`）
//   · 手画河 `{id:'river_x', width:0.6}`（id 前缀 `river_` → 走 `drawRiverPaths`）
//   · 自动河 = `sc.generateAndShowRivers()`
//
// 🔴 颜色采样分两步（**归属**要干净，否则"在导入河上采到的其实是自动河"）：
//   A. 先把自动河**藏掉**（`autoRivers=[] / autoRiverSegments=[]`）再采 → 这两条河的点上
//      只可能是它们自己画的像素（归属无歧义）；
//   B. 再把自动河恢复，采 5 个自动河段的中点 → 然后**在这个状态截图**（三条都在）。
//   两次采样比的是同一种画法（strokeStyle），所以"同色"这个结论不受影响。
//
// 🔴 判据口径：#5d97bb 是**唯一**河色；`RIVER_COLOR = '#3B82F6'`（utils/rivers.js）
//   只作为**数据里的默认值**存在，不再被任何描边路径使用。
(async () => {
  const out = {};
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const sc = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));
  const KEY = 'labShotMound';
  const TARGET = [93, 151, 187];   // #5d97bb
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
  sc.riverSource = 'both';       // 两套都画（默认档；这样导入河与自动河同屏）
  sc.riverSmooth = false;
  await tick(80);
  // 🔴 右下角小地图是**画在画布上**的（`drawMinimap`）→ 关掉它（它的板岩灰会被河色分类器误判）；
  //    采样再按右下角矩形兜底排除
  sc.showMinimap = false;
  // 🔴 写 setupState 上的 ref 到底生没生効，读回来留证（本项目在"探针写 ref 假红"上踩过）
  out.stateEcho = { rasterLayer: sc.rasterLayer, showRivers: sc.showRivers, riverSource: sc.riverSource,
    showMinimap: sc.showMinimap };

  sc.generateAndShowRivers();
  await tick(600);
  out.autoRivers = (sc.autoRivers || []).length;
  out.segments = (sc.autoRiverSegments || []).length;
  out.maxFlow = sc.autoRiverMaxFlow;
  out.drawnReported = sc.autoRiverDrawn;

  const net = (typeof sc.getAutoRiverNetwork === 'function') ? sc.getAutoRiverNetwork() : (sc.autoRiverSegments || []);
  const gate = (typeof sc.riverFlowGate === 'function') ? sc.riverFlowGate(sc.autoRiverMaxFlow, sc.autoRiverSegments) : 0;
  const kept = (typeof sc.pruneRiverNetwork === 'function') ? sc.pruneRiverNetwork(net, gate).kept : net;
  out.gate = gate;
  out.netSegments = net.length;
  out.kept = kept.length;

  // ── 相机：scale 1，对准干流那一段，但夹到岛内（否则两条手工河会被海岸线裁掉）──
  const byFlow = kept.slice().sort((a, b) => (b.flow || 0) - (a.flow || 0));
  const target = byFlow[0] || { x0: CXW, y0: CYW, x1: CXW + 20, y1: CYW, flow: 0 };
  let tx = (target.x0 + target.x1) / 2, ty = (target.y0 + target.y1) / 2;
  const CLAMP_R = 820;
  const ddx = tx - CXW, ddy = ty - CYW, dd = Math.hypot(ddx, ddy);
  if (dd > CLAMP_R) { tx = CXW + (ddx / dd) * CLAMP_R; ty = CYW + (ddy / dd) * CLAMP_R; }
  const cvs = sc.canvas;
  const rc = cvs.getBoundingClientRect();
  sc.cameraScale = 1.0;
  sc.cameraX = rc.width / 2 - tx;
  sc.cameraY = rc.height / 2 - ty;
  out.camera = { scale: 1, x: Math.round(sc.cameraX), y: Math.round(sc.cameraY),
    centerWorld: [Math.round(tx), Math.round(ty)], clampedFrom: [Math.round((target.x0 + target.x1) / 2), Math.round((target.y0 + target.y1) / 2)],
    clampR: CLAMP_R, targetFlow: target.flow };
  out.canvas = [cvs.width, cvs.height];
  out.rect = [Math.round(rc.width), Math.round(rc.height)];

  // ── 两条手工河（都在岛内：|Δ| ≤ ~1250 < 1272，导入河不会被裁掉）──
  // 两条手工河各自带一个基线偏移（否则两条正弦会在 y=ty 处反复交叉、看着像一条）
  const wave = (base, amp, n, phase) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      pts.push({ x: tx - 400 + 800 * t, y: ty + base + amp * Math.sin(t * Math.PI * phase) });
    }
    return pts;
  };
  const importedRiver = { id: 'imported_x', points: wave(-170, 55, 28, 3), width: 0.26, discharge: 600 };
  const handRiver = { id: 'river_x', points: wave(170, 70, 36, 4), width: 0.6 };
  out.importedPoints = importedRiver.points.length;
  out.handPoints = handRiver.points.length;
  out.importedIdPrefixOk = String(importedRiver.id).indexOf('river_') !== 0;   // 走 drawRivers
  out.handIdPrefixOk = String(handRiver.id).indexOf('river_') === 0;           // 走 drawRiverPaths

  const bm = s.baseMaps[KEY];
  bm.rivers = [importedRiver, handRiver];
  s.baseMaps = { ...s.baseMaps, [KEY]: { ...bm } };   // 换引用 → 画布侧按引用缓存的两个 cache 一定失效
  await tick(150);

  // ── 采样工具 ──
  const dpr = cvs.width / rc.width;
  const screenOf = (wx, wy) => [
    Math.round((sc.cameraX + wx * sc.cameraScale) * dpr),
    Math.round((sc.cameraY + wy * sc.cameraScale) * dpr),
  ];
  const grab = () => cvs.getContext('2d').getImageData(0, 0, cvs.width, cvs.height).data;
  const MMX = Math.round((rc.width - 170) * dpr), MMY = Math.round((rc.height - 170) * dpr);
  const masked = (X, Y) => X >= MMX && Y >= MMY;
  const bestIn = (img, wx, wy, rad) => {
    const [cx0, cy0] = screenOf(wx, wy);
    // 取**离目标色最近**的那个像素（不是"最蓝"的 —— 小地图/板岩灰也很蓝）
    let best = null, bestD = Infinity;
    for (let oy = -rad; oy <= rad; oy++) for (let ox = -rad; ox <= rad; ox++) {
      const X = cx0 + ox, Y = cy0 + oy;
      if (X < 0 || Y < 0 || X >= cvs.width || Y >= cvs.height || masked(X, Y)) continue;
      const i = (Y * cvs.width + X) * 4;
      const r = img[i], g = img[i + 1], b = img[i + 2];
      if (!isRiver(r, g, b)) continue;
      const d = Math.max(Math.abs(r - TARGET[0]), Math.abs(g - TARGET[1]), Math.abs(b - TARGET[2]));
      if (d < bestD) { bestD = d; best = [r, g, b]; }
    }
    return best;
  };
  const devOf = (p) => (p ? Math.max(Math.abs(p[0] - TARGET[0]), Math.abs(p[1] - TARGET[1]), Math.abs(p[2] - TARGET[2])) : null);
  const spread = (arr, k) => {
    if (arr.length <= k) return arr.slice();
    const step = Math.floor(arr.length / k);
    const o = [];
    for (let i = 0; i < arr.length && o.length < k; i += step) o.push(arr[i]);
    return o;
  };

  // ── A. 藏掉自动河 → 采两条手工河（归属无歧义）──
  const savedRivers = sc.autoRivers;
  const savedSegs = sc.autoRiverSegments;
  sc.autoRivers = [];
  sc.autoRiverSegments = [];
  revealOverlays(); sc.render(); await tick(250);
  let img = grab();
  // 🔴 采样位置很关键：手画河的线宽从源头 0.35px 涨到河口 1.6px，
  //    **细段的像素全是抗锯齿混色**（没有纯色像素）→ 在细段采样会读到 30+ 的假偏差。
  //    所以主判据取"厚的那半段"（65%~97%）；整条铺开采一次只作为"细段长什么样"的记录。
  const atFrac = (points, f) => points[Math.max(0, Math.min(points.length - 1, Math.round((points.length - 1) * f)))];
  const THICK = [0.65, 0.75, 0.85, 0.92, 0.97];
  const importedSamples = THICK.map((f) => bestIn(img, atFrac(importedRiver.points, f).x, atFrac(importedRiver.points, f).y, 4));
  const handSamples = THICK.map((f) => bestIn(img, atFrac(handRiver.points, f).x, atFrac(handRiver.points, f).y, 4));
  const handSpreadSamples = spread(handRiver.points, 5).map((p) => bestIn(img, p.x, p.y, 4));
  out.importedFracs = THICK;
  out.handFracs = THICK;
  out.importedColors = importedSamples;
  out.handColors = handSamples;
  out.handColorsFullSpread = handSpreadSamples;
  out.importedDev = importedSamples.map(devOf);
  out.handDev = handSamples.map(devOf);
  out.handDevFullSpread = handSpreadSamples.map(devOf);
  out.importedFound = importedSamples.filter(Boolean).length;
  out.handFound = handSamples.filter(Boolean).length;
  out.noteA = 'A 阶段自动河已藏（autoRivers=[] / autoRiverSegments=[]）→ 这两条河的点上只可能是它们自己画的像素';

  // ── B. 恢复自动河 → 采 5 个自动河段中点 ──
  sc.autoRivers = savedRivers;
  sc.autoRiverSegments = savedSegs;
  revealOverlays(); sc.render(); await tick(250);
  img = grab();
  const inWin = kept.filter((g) => {
    const mx = (g.x0 + g.x1) / 2, my = (g.y0 + g.y1) / 2;
    return Math.abs(mx - tx) < 560 && Math.abs(my - ty) < 320;
  }).sort((a, b) => (b.flow || 0) - (a.flow || 0));
  const autoPicked = spread(inWin, 5);
  const autoSamples = autoPicked.map((g) => bestIn(img, (g.x0 + g.x1) / 2, (g.y0 + g.y1) / 2, 4));
  out.autoKeptInWindow = inWin.length;
  out.autoColors = autoSamples;
  out.autoDev = autoSamples.map(devOf);
  out.autoFound = autoSamples.filter(Boolean).length;
  out.autoFlows = autoPicked.map((g) => g.flow);

  const allDev = [].concat(out.importedDev || [], out.handDev || [], out.autoDev || []).filter((v) => v !== null);
  out.maxColorDevAll = allDev.length ? Math.max(...allDev) : null;
  out.targetColor = '#5d97bb (93,151,187)';
  out.note = 'A 阶段（自动河藏掉）采的两条手工河 = 归属无歧义；B 阶段采自动河段中点；两张都同一套 strokeStyle';

  revealOverlays(); sc.render(); await tick(300);
  revealOverlays();
  return JSON.stringify(out);
})()
