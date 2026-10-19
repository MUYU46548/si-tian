// _shot07_handriver_handles.js —— 交付图 07「手画河-节点手柄」（放大到 ≥1.2 才看得见手柄）
//
// 这一张与 01 分工：
//   · 01（cameraScale = 1.0）证明"河是一条连续曲线、不是一串圆点"—— 注意 1.0 下产品
//     **按闸门根本不画节点手柄**（`RIVER_HANDLE_MIN_ZOOM = 1.2`），所以 01 证不出手柄那一半；
//   · 07（cameraScale = 1.6 ≥ 1.2）证明"放大后手柄**稀疏**出现，且河身之间仍是连续的线
//     （不是一堆圆点糊成的虚线）"。
//
// 固定参数：
//   · 底图 labShotMound（与其余 6 张同一份合成地形），自动河清空，`rasterLayer='none'`
//   · 同一笔画法：画河时相机 0.90（世界长度 ≈1138），落库后相机 **1.6**、对准河中点
//   · `selectedRiverId` = 该河 id；`riverActiveNode = -1`（不突出活动节点，看全部手柄的均匀性）
//
// 数值判据：
//   · 手柄闸门：`nodes ≤ RIVER_HANDLE_MAX(120)` 且 `scale ≥ RIVER_HANDLE_MIN_ZOOM(1.2)` → 画全部
//   · 手柄直径(px) 与相邻节点屏幕间距(px) 之比（"稀疏"的量化：比值小 = 不糊成虚线）
//   · 在节点屏幕位置逐一探测"这里有没有画手柄"（暗填充/亮描边）→ 命中数
//   · **手柄与手柄之间**的河身连续性（排除每个节点 ±10px 邻域后再取像素）
(async () => {
  const out = {};
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const sc = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));
  const KEY = 'labShotMound';
  const HANDLE_SCALE = 1.6;
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
  sc.autoRivers = [];
  sc.autoRiverSegments = [];
  sc.autoRiverMaxFlow = 0;
  sc.autoRiverDrawn = 0;
  sc.showMinimap = false;      // 右下角小地图画在画布上（板岩灰会被河色分类器误判）→ 关掉
  sc.setTool('river');
  await tick(100);
  out.stateEcho = { rasterLayer: sc.rasterLayer, autoRivers: (sc.autoRivers || []).length,
    autoSegments: (sc.autoRiverSegments || []).length, tool: sc.tool, showMinimap: sc.showMinimap };

  const cvs = sc.canvas;
  const rc = cvs.getBoundingClientRect();
  const DRAW_SCALE = 0.90;
  sc.cameraScale = DRAW_SCALE;
  sc.cameraX = rc.width / 2 - CXW * DRAW_SCALE;
  sc.cameraY = rc.height / 2 - CYW * DRAW_SCALE;
  sc.render();
  await tick(120);

  const mk = (t, x, y) => new MouseEvent(t, {
    clientX: rc.left + x, clientY: rc.top + y, button: 0,
    buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true,
  });
  cvs.dispatchEvent(mk('mousedown', rc.width * 0.10, rc.height * 0.34));
  for (let i = 1; i <= 70; i++) {
    const x = rc.width * 0.10 + rc.width * 0.80 * (i / 70);
    const y = rc.height * 0.34 + Math.sin(i / 8) * rc.height * 0.16;
    cvs.dispatchEvent(mk('mousemove', x, y));
  }
  cvs.dispatchEvent(mk('mouseup', rc.width * 0.90, rc.height * 0.34));
  cvs.dispatchEvent(mk('click', rc.width * 0.90, rc.height * 0.34));
  await tick(200);

  const rivers = (s.baseMaps[KEY] && s.baseMaps[KEY].rivers) || [];
  const r0 = rivers.filter((r) => String(r.id).indexOf('river_') === 0)[0];
  out.rivers = rivers.length;
  if (!r0) {
    out.fail = '手画河没有落库 —— 这一张拍不出来（据实报，不硬说成功）';
    revealOverlays(); sc.render(); await tick(200);
    return JSON.stringify(out);
  }
  sc.selectedRiverId = r0.id;
  sc.riverActiveNode = -1;                 // 不突出活动节点：看全部手柄的均匀性
  await tick(60);
  const pts = (r0.points || []).map((p) => ({ x: p.x, y: p.y }));
  out.riverId = r0.id;
  out.selectedRiverFound = !!sc.selectedRiver;
  out.nodes = pts.length;
  out.widthField = r0.width;
  if (pts.length < 2) {
    out.fail = '落库的河点数 <2 —— 拍不出来';
    revealOverlays(); sc.render(); await tick(200);
    return JSON.stringify(out);
  }

  // ── 相机 = 1.6（≥ RIVER_HANDLE_MIN_ZOOM）──
  const mi = Math.floor(pts.length / 2);
  sc.cameraScale = HANDLE_SCALE;
  sc.cameraX = rc.width / 2 - pts[mi].x * HANDLE_SCALE;
  sc.cameraY = rc.height / 2 - pts[mi].y * HANDLE_SCALE;
  await tick(60);
  out.camera = { scale: sc.cameraScale, x: Math.round(sc.cameraX), y: Math.round(sc.cameraY) };
  out.canvas = [cvs.width, cvs.height];
  out.rect = [Math.round(rc.width), Math.round(rc.height)];

  let minGapW = Infinity, sumGapW = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    minGapW = Math.min(minGapW, d); sumGapW += d;
  }
  const showAll = (pts.length <= (sc.RIVER_HANDLE_MAX || 120)) && (HANDLE_SCALE >= (sc.RIVER_HANDLE_MIN_ZOOM || 1.2));
  // 手柄半径 = px(3.2)（产品在 drawInteractionOverlay 里写的），px(v)=v/scale → 屏幕半径 = 3.2
  const handleRadiusPx = 3.2;
  out.handleGate = {
    nodes: pts.length, RIVER_HANDLE_MAX: sc.RIVER_HANDLE_MAX, RIVER_HANDLE_MIN_ZOOM: sc.RIVER_HANDLE_MIN_ZOOM,
    scale: HANDLE_SCALE, showAll,
    handlesShown: showAll ? pts.length : 1,
  };
  out.spacing = {
    minGapWorld: Math.round(minGapW * 10) / 10,
    minGapPxAt16: Math.round(minGapW * HANDLE_SCALE * 10) / 10,
    avgGapPxAt16: Math.round((sumGapW / Math.max(1, pts.length - 1)) * HANDLE_SCALE * 10) / 10,
    handleDiameterPx: Math.round(handleRadiusPx * 2 * 10) / 10,
    diameterOverSpacingPct: Math.round(((handleRadiusPx * 2) / (minGapW * HANDLE_SCALE)) * 1000) / 10,
    note: 'px(v) = v / cameraScale → 手柄屏幕半径恒为 3.2px；比值小 = 手柄稀疏、不糊成虚线',
  };
  out.visibleNodes = null;

  revealOverlays();
  sc.render();
  await tick(250);
  revealOverlays();

  // ── 像素判据 ──
  const dpr = cvs.width / rc.width;
  out.dpr = Math.round(dpr * 100) / 100;
  const img = cvs.getContext('2d').getImageData(0, 0, cvs.width, cvs.height).data;
  const at = (X, Y) => { const i = (Y * cvs.width + X) * 4; return [img[i], img[i + 1], img[i + 2]]; };
  const screenOf = (wx, wy) => [
    Math.round((sc.cameraX + wx * sc.cameraScale) * dpr),
    Math.round((sc.cameraY + wy * sc.cameraScale) * dpr),
  ];
  const inBounds = (X, Y, m) => X >= m && Y >= m && X < cvs.width - m && Y < cvs.height - m;
  // 右下角小地图兜底排除
  const MMX = Math.round((rc.width - 170) * dpr), MMY = Math.round((rc.height - 170) * dpr);
  const masked = (X, Y) => X >= MMX && Y >= MMY;
  out.maskCornerPx = [MMX, MMY];
  const nodeScreen = pts.map((p) => screenOf(p.x, p.y)).filter((p) => inBounds(p[0], p[1], 6) && !masked(p[0], p[1]));
  out.nodesInFrame = nodeScreen.length;
  out.visibleNodes = nodeScreen.length;
  // 手柄探测：节点中心周围 5×5 里应有"暗填充"(#0b1220) 或"亮描边"(#e2e8f0)
  const isHandlePixel = (r, g, b) => (r + g + b < 170) || (r > 190 && g > 190 && b > 190);
  let handlesFound = 0;
  for (const [X0, Y0] of nodeScreen) {
    let found = false;
    for (let oy = -2; oy <= 2 && !found; oy++) for (let ox = -2; ox <= 2 && !found; ox++) {
      const X = X0 + ox, Y = Y0 + oy;
      if (!inBounds(X, Y, 0)) continue;
      const p = at(X, Y);
      if (isHandlePixel(p[0], p[1], p[2])) found = true;
    }
    if (found) handlesFound++;
  }
  out.handlesDetected = handlesFound;
  out.handlesDetectPct = nodeScreen.length ? Math.round((handlesFound / nodeScreen.length) * 1000) / 10 : null;

  // ── 手柄与手柄之间的河身连续性（排除每个节点 ±10px 邻域）──
  const curve = (typeof sc.catmullRomPoints === 'function') ? sc.catmullRomPoints(pts, 7) : pts;
  out.curvePoints = curve.length;
  const keep = [];
  for (let i = 1; i + 1 < curve.length; i++) {
    const [X, Y] = screenOf(curve[i].x, curve[i].y);
    if (!inBounds(X, Y, 24) || masked(X, Y)) continue;
    let dmin = Infinity;
    for (const [NX, NY] of nodeScreen) dmin = Math.min(dmin, Math.hypot(NX - X, NY - Y));
    if (dmin >= 10) keep.push({ i, X, Y });
  }
  let hitN = 0, missRun = 0, maxMissRun = 0;
  for (const k of keep) {
    let hit = false;
    for (let oy = -1; oy <= 1 && !hit; oy++) for (let ox = -1; ox <= 1 && !hit; ox++) {
      const X = k.X + ox, Y = k.Y + oy;
      if (!inBounds(X, Y, 0)) continue;
      const p = at(X, Y);
      if (isRiver(p[0], p[1], p[2])) hit = true;
    }
    if (hit) { hitN++; missRun = 0; }
    else { missRun++; if (missRun > maxMissRun) maxMissRun = missRun; }
  }
  out.betweenHandlesContinuity = {
    sampled: keep.length, hit: hitN,
    pct: keep.length ? Math.round((hitN / keep.length) * 1000) / 10 : null,
    maxMissRunPts: maxMissRun,
    note: '排除每个节点 ±10 屏幕像素后的河身取样：手柄本身会盖住河（那里必然不是河色）',
  };

  revealOverlays();
  sc.render();
  await tick(250);
  revealOverlays();
  return JSON.stringify(out);
})()
