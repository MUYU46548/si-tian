// _shot01_handriver_node_dots.js —— 交付图 01「手画河-点串问题」
//
// 这一张要证明：手画河画出来是**一条连续、有粗细变化的曲线**，不是"一串圆点"；
// 节点手柄在 100% 缩放下按闸门不铺满河身（只有"放大"才画）。
//
// 固定参数（可复现）：
//   · 底图 labShotMound：**与 02~06 同一份合成地形**（圆丘 121×121 / spacing 20 / 圆形陆地掩膜）
//   · 自动河全部清掉（`autoRivers=[]` / `autoRiverSegments=[]`）—— 这一张只讲手画河
//   · 画河时相机 0.90（让整条河的世界长度 ≈ 1138，100% 下正好装进画布），
//     落库后相机改成 **1.0（100%）** 并对准河中点
//   · `selectedRiverId` = 刚落库那条河的 id（节点手柄的绘制入口条件）
//
// 数值判据（写进 docs/RIVER_VISUAL_FIX_20261017.md）：
//   · 控制点数 / 相邻控制点最小屏幕间距(px)
//   · 连续性：沿**产品自己的** `catmullRomPoints(points, 7)` 逐点取画布像素，
//     统计"落在河色上"的比例与最长连续未命中长度（"一串圆点"会给出很长的未命中段）
//   · 横截面：沿法线扫 ±40px，河色像素应连成 **1 段**（不是很多段）
//   · 源头/河口宽度（法线方向的河色像素数）—— 粗细变化的量化
(async () => {
  const out = {};
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const sc = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));
  const KEY = 'labShotMound';
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

  // ── 同一份合成地形：圆丘 121×121 / spacing 20 + 圆形陆地掩膜（半径 = h≥20 等值线）──
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
  // 🔴 右下角小地图是**画在画布上**的（`drawMinimap`，150×150 + pad 12，板岩灰底）——
  //    它的颜色会被"河色分类器"误判成河（实测把 45px 的扫描段算成河宽），所以关掉它；
  //    后面的像素扫描再按右下角矩形兜底排除一次（万一这个开关没生効）。
  sc.showMinimap = false;
  // 🔴 这一张只讲手画河：自动河全部清掉（否则河网上来会盖住要看的线）
  sc.autoRivers = [];
  sc.autoRiverSegments = [];
  sc.autoRiverMaxFlow = 0;
  sc.autoRiverDrawn = 0;
  sc.setTool('river');
  await tick(100);
  out.tool = sc.tool;
  // 🔴 写 setupState 上的 ref 到底生没生効，读回来留证（本项目在"探针写 ref 假红"上踩过）
  out.stateEcho = { rasterLayer: sc.rasterLayer, autoRivers: (sc.autoRivers || []).length,
    autoSegments: (sc.autoRiverSegments || []).length, tool: sc.tool, showMinimap: sc.showMinimap };

  const cvs = sc.canvas;
  const rc = cvs.getBoundingClientRect();
  // 画河时用 0.90 缩放：横跨 80% 画布 ≈ 1138 世界单位 → 100% 下正好整条装进画布
  const DRAW_SCALE = 0.90;
  sc.cameraScale = DRAW_SCALE;
  sc.cameraX = rc.width / 2 - CXW * DRAW_SCALE;
  sc.cameraY = rc.height / 2 - CYW * DRAW_SCALE;
  sc.render();
  await tick(100);

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
  out.rawDraftPts = (sc.riverDraft || []).length;
  cvs.dispatchEvent(mk('mouseup', rc.width * 0.90, rc.height * 0.34));
  cvs.dispatchEvent(mk('click', rc.width * 0.90, rc.height * 0.34));
  await tick(200);

  const rivers = (s.baseMaps[KEY] && s.baseMaps[KEY].rivers) || [];
  out.rivers = rivers.length;
  if (!rivers.length) {
    out.fail = '手画河没有落库 —— 这一张拍不出来（据实报，不硬说成功）';
    revealOverlays(); sc.render(); await tick(200);
    return JSON.stringify(out);
  }
  // 手画河（id 前缀 river_）—— 只取这一条，其余不参与
  const r0 = rivers.filter((r) => String(r.id).indexOf('river_') === 0)[0] || rivers[0];
  sc.selectedRiverId = r0.id;
  sc.riverActiveNode = -1;
  await tick(60);
  const pts = (r0.points || []).map((p) => ({ x: p.x, y: p.y }));
  out.riverId = r0.id;
  out.selectedRiverId = sc.selectedRiverId;
  out.selectedRiverFound = !!sc.selectedRiver;
  out.nodes = pts.length;
  out.widthField = r0.width;
  if (pts.length < 2) {
    out.fail = '落库的河点数 <2 —— 拍不出来';
    revealOverlays(); sc.render(); await tick(200);
    return JSON.stringify(out);
  }

  // ── 相机 = 100%，对准河中点 ──
  const mi = Math.floor(pts.length / 2);
  sc.cameraScale = 1.0;
  sc.cameraX = rc.width / 2 - pts[mi].x;
  sc.cameraY = rc.height / 2 - pts[mi].y;
  await tick(60);
  out.camera = { scale: sc.cameraScale, x: Math.round(sc.cameraX), y: Math.round(sc.cameraY) };
  out.canvas = [cvs.width, cvs.height];
  out.rect = [Math.round(rc.width), Math.round(rc.height)];
  out.drawScale = DRAW_SCALE;

  // ── 相邻控制点的屏幕间距（此图 scale = 1 → 世界单位 = 屏幕像素）──
  let minGap = Infinity, sumGap = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    minGap = Math.min(minGap, d); sumGap += d;
  }
  out.minGapPx = Math.round(minGap * 10) / 10;
  out.avgGapPx = Math.round((sumGap / Math.max(1, pts.length - 1)) * 10) / 10;
  out.riverWorldLen = Math.round(sumGap);
  out.handleGate = {
    nodes: pts.length,
    RIVER_HANDLE_MAX: sc.RIVER_HANDLE_MAX,
    RIVER_HANDLE_MIN_ZOOM: sc.RIVER_HANDLE_MIN_ZOOM,
    showAllAtScale1: (pts.length <= (sc.RIVER_HANDLE_MAX || 120)) && (1.0 >= (sc.RIVER_HANDLE_MIN_ZOOM || 1.2)),
    showAllAtScale12: (pts.length <= (sc.RIVER_HANDLE_MAX || 120)) && (1.2 >= (sc.RIVER_HANDLE_MIN_ZOOM || 1.2)),
  };

  revealOverlays();
  sc.render();
  await tick(250);
  revealOverlays();

  // ── 像素判据 ──
  const dpr = cvs.width / rc.width;
  out.dpr = Math.round(dpr * 100) / 100;
  const img = cvs.getContext('2d').getImageData(0, 0, cvs.width, cvs.height).data;
  const at = (X, Y) => { const i = (Y * cvs.width + X) * 4; return [img[i], img[i + 1], img[i + 2]]; };
  // 右下角小地图兜底排除（`showMinimap=false` 已关，但开关失效时这里必须还拦得住）
  const MM = [Math.round((rc.width - 170) * dpr), Math.round((rc.height - 170) * dpr)];
  const masked = (X, Y) => X >= MM[0] && Y >= MM[1];
  out.maskCornerPx = MM;
  const screenOf = (wx, wy) => [
    Math.round((sc.cameraX + wx * sc.cameraScale) * dpr),
    Math.round((sc.cameraY + wy * sc.cameraScale) * dpr),
  ];
  const hitAt = (wx, wy, rad) => {
    const [cx, cy] = screenOf(wx, wy);
    for (let oy = -rad; oy <= rad; oy++) for (let ox = -rad; ox <= rad; ox++) {
      const X = cx + ox, Y = cy + oy;
      if (X < 0 || Y < 0 || X >= cvs.width || Y >= cvs.height || masked(X, Y)) continue;
      const p = at(X, Y);
      if (isRiver(p[0], p[1], p[2])) return true;
    }
    return false;
  };
  // 沿产品自己的曲线实现取点（不是我另写一份曲线 —— 量产品口径要用产品的实现）
  const curve = (typeof sc.catmullRomPoints === 'function') ? sc.catmullRomPoints(pts, 7) : pts;
  out.curveImpl = (typeof sc.catmullRomPoints === 'function') ? 'sc.catmullRomPoints(points, 7)' : 'points(原折线)';
  out.curvePoints = curve.length;
  // 只统计**落在画布内**的曲线点（画布外取不到像素，统计进去只会假红）
  const M = 24;
  const inFrame = [];
  for (let i = 1; i + 1 < curve.length; i++) {
    const [X, Y] = screenOf(curve[i].x, curve[i].y);
    if (X >= M && Y >= M && X < cvs.width - M && Y < cvs.height - M && !masked(X, Y)) inFrame.push(i);
  }
  out.curvePtsInFrame = inFrame.length;
  let hitN = 0, missRun = 0, maxMissRun = 0, firstMiss = -1;
  for (const i of inFrame) {
    if (hitAt(curve[i].x, curve[i].y, 1)) { hitN++; missRun = 0; }
    else { missRun++; if (missRun > maxMissRun) maxMissRun = missRun; if (firstMiss < 0) firstMiss = i; }
  }
  out.continuity = {
    sampled: inFrame.length, hit: hitN,
    pct: inFrame.length ? Math.round((hitN / inFrame.length) * 1000) / 10 : null,
    maxMissRunPts: maxMissRun, firstMissIdx: firstMiss,
    note: '沿 catmullRomPoints(points,7) 逐点取样；未命中在"一串圆点"下会连成很长的段',
  };
  // 源头 10% 因为线宽只有零点几像素、抗锯齿后可能取不到色 —— 这一栏排除源头再看一次
  const startIdx = Math.floor(curve.length * 0.10);
  let h2 = 0, s2 = 0;
  for (const i of inFrame) {
    if (i < startIdx) continue;
    s2++;
    if (hitAt(curve[i].x, curve[i].y, 1)) h2++;
  }
  out.continuityExHead10Pct = { sampled: s2, hit: h2, pct: s2 ? Math.round((h2 / s2) * 1000) / 10 : null };

  const crossSection = (wx, wy, tx, ty, halfPx) => {
    const nl = Math.hypot(tx, ty) || 1;
    const nx = -ty / nl, ny = tx / nl;
    const [cx0, cy0] = screenOf(wx, wy);
    let runs = 0, inRun = false, hits = 0;
    for (let t = -halfPx; t <= halfPx; t += 1) {
      const X = Math.round(cx0 + nx * t * dpr), Y = Math.round(cy0 + ny * t * dpr);
      if (X < 0 || Y < 0 || X >= cvs.width || Y >= cvs.height || masked(X, Y)) continue;
      const p = at(X, Y);
      const isHit = isRiver(p[0], p[1], p[2]);
      if (isHit) { hits++; if (!inRun) { runs++; inRun = true; } } else inRun = false;
    }
    return { runs, widthPx: hits };
  };
  const tanAt = (i) => [curve[i + 1].x - curve[i - 1].x, curve[i + 1].y - curve[i - 1].y];
  const xs = [];
  for (const frac of [0.15, 0.35, 0.55, 0.75, 0.9]) {
    const i = inFrame.length
      ? inFrame[Math.max(0, Math.min(inFrame.length - 1, Math.floor(inFrame.length * frac)))]
      : Math.max(1, Math.min(curve.length - 2, Math.floor(curve.length * frac)));
    xs.push(crossSection(curve[i].x, curve[i].y, tanAt(i)[0], tanAt(i)[1], 40));
  }
  out.crossSections = xs;
  out.crossSectionRuns = xs.map((t) => t.runs);
  out.crossSectionAllSingleRun = xs.every((t) => t.runs === 1);
  // 源头 / 河口宽度（世界单位 → 屏幕像素 = 世界 * scale，此图 scale = 1）
  const hi = inFrame.length ? inFrame[2] || inFrame[0] : 1;
  const mo = inFrame.length ? inFrame[inFrame.length - 3] || inFrame[inFrame.length - 1] : curve.length - 2;
  const hw = crossSection(curve[hi].x, curve[hi].y, tanAt(hi)[0], tanAt(hi)[1], 12);
  const mw = crossSection(curve[mo].x, curve[mo].y, tanAt(mo)[0], tanAt(mo)[1], 12);
  out.taper = { headWidthPx: hw.widthPx, mouthWidthPx: mw.widthPx,
    ratio: hw.widthPx > 0 ? Math.round((mw.widthPx / hw.widthPx) * 100) / 100 : null,
    headCurveIdx: hi, mouthCurveIdx: mo,
    note: '法线扫描按整数像素计数（细端会量化到 0/1px），所以下面同时给"产品口径的意图宽度"' };
  // 产品自己的逐点宽度序列（`riverWidthsFor`：源头细 → 河口粗 + 屏幕像素下限）
  if (typeof sc.riverWidthsFor === 'function') {
    const w = sc.riverWidthsFor(r0, curve.length);
    const ww = Array.from(w || []);
    if (ww.length) {
      const mid = ww[Math.floor(ww.length / 2)];
      out.intendedWidths = {
        head: Math.round(ww[0] * 1000) / 1000,
        mid: Math.round(mid * 1000) / 1000,
        mouth: Math.round(ww[ww.length - 1] * 1000) / 1000,
        gainHeadToMouth: Math.round((ww[ww.length - 1] / Math.max(1e-6, ww[0])) * 100) / 100,
        count: ww.length,
        note: 'riverWidthsFor 的返回值是**世界单位**；此图 scale=1 → 数值即屏幕像素',
      };
    }
  }

  // 颜色：**河身中段**取 5 点，与 #5d97bb 的最大通道偏差
  // ⚠️ 刻意避开最靠近源头的那一段：那里线宽不到 1 像素，画布上根本不存在"纯色像素"
  //    （整条线都是抗锯齿混色），拿它当判据会得到 20+ 的假偏差。源头那一点单独记一栏。
  const colorAt = (frac) => {
    const i = inFrame.length
      ? inFrame[Math.max(0, Math.min(inFrame.length - 1, Math.floor(inFrame.length * frac)))]
      : Math.max(0, Math.min(curve.length - 1, Math.floor(curve.length * frac)));
    const p = curve[i];
    const [cx0, cy0] = screenOf(p.x, p.y);
    // 取**离目标色最近**的那个像素（不是"最蓝"的那个 —— 小地图/网格之类的板岩灰也很"蓝"）
    let best = null, bestD = Infinity;
    for (let oy = -4; oy <= 4; oy++) for (let ox = -4; ox <= 4; ox++) {
      const X = cx0 + ox, Y = cy0 + oy;
      if (X < 0 || Y < 0 || X >= cvs.width || Y >= cvs.height || masked(X, Y)) continue;
      const q = at(X, Y);
      if (!isRiver(q[0], q[1], q[2])) continue;
      const d = Math.max(Math.abs(q[0] - 93), Math.abs(q[1] - 151), Math.abs(q[2] - 187));
      if (d < bestD) { bestD = d; best = q; }
    }
    return best;
  };
  const samples = [0.35, 0.5, 0.65, 0.8, 0.9].map(colorAt);
  out.sampleFracs = [0.35, 0.5, 0.65, 0.8, 0.9];
  out.sampleColors = samples;
  out.riverColorDev = samples.map((p) => (p ? Math.max(Math.abs(p[0] - 93), Math.abs(p[1] - 151), Math.abs(p[2] - 187)) : null));
  const devs = out.riverColorDev.filter((v) => v !== null);
  out.maxColorDev = devs.length ? Math.max(...devs) : null;
  const headThin = colorAt(0.12);
  out.thinHead = { frac: 0.12, color: headThin,
    dev: headThin ? Math.max(Math.abs(headThin[0] - 93), Math.abs(headThin[1] - 151), Math.abs(headThin[2] - 187)) : null,
    note: '最靠近源头那一段线宽 <1px → 画布上没有纯色像素；dev 大是抗锯齿混色，不是"第二种蓝"' };
  out.targetColor = '#5d97bb (93,151,187)';
  out.alphaNote = '手画河水面 alpha 0.95 + 岸线 0.55 → 纯色像素的理论偏差下限 ≈4（不是 0）';

  revealOverlays();
  sc.render();
  await tick(250);
  revealOverlays();
  return JSON.stringify(out);
})()
