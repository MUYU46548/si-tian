// _shot06_handriver_preview_taper.js —— 交付图 06「手画河-预览与变宽」
//
// 这一张要证明：手画河工具**按住拖动到一半**时，屏幕上的预览**就是曲线**（不是折线/虚线），
// 而且预览已经带上"源头细 → 笔尖粗"的宽度变化。
//
// 固定参数：
//   · 与 01~05 同一份合成地形（圆丘 121×121 / spacing 20 / 圆形陆地掩膜），`rasterLayer='none'`
//   · 自动河清掉（与 01 同口径：这一张只讲手画这条预览）
//   · 真鼠标事件：`mousedown` + 60 次 `mousemove`，**不派发 `mouseup`**（拖动进行中）
//   · 拖动时相机 0.90（整个世界长度 ≈1138），拍之前把相机改成 **1.0** 并对准草稿中点
//     （草稿是世界坐标，改相机不影响它；100% 下整条预览正好装进画布）
//
// 数值判据：
//   · 预览点列 = **产品自己的** `sc.smoothWhileDrawing(riverDraft, 1, 18)`；
//     画出来的曲线 = `sc.catmullRomPoints(预览点列, 7)`（与 `drawOneHandRiver` 内部同一条路）
//   · 连续性：沿该曲线逐点取像素，命中率应接近 100%、最长未命中段应很短
//     （旧的"虚线折线预览"会给出长断裂）
//   · 平滑度：**同一窗口宽度**（8 世界单位弧长重采样）下，原始手势折线 vs 预览曲线的最大转角
//   · 粗细：源头（预览首点）与笔尖（预览末点）的法线扫描宽度
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
  // 🔴 写 setupState 上的 ref 到底生没生効，读回来留证（本项目在"探针写 ref 假红"上踩过）
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
  // 🔴 按住拖动到一半：**不派发 mouseup** → 预览留在画布上
  cvs.dispatchEvent(mk('mousedown', rc.width * 0.10, rc.height * 0.40));
  for (let i = 1; i <= 60; i++) {
    const x = rc.width * 0.10 + rc.width * 0.80 * (i / 60);
    const y = rc.height * 0.40 + Math.sin(i / 6) * rc.height * 0.20;
    cvs.dispatchEvent(mk('mousemove', x, y));
  }
  await tick(150);
  const draft = (sc.riverDraft || []).map((p) => ({ x: p.x, y: p.y }));
  out.draftPoints = draft.length;
  out.tool = sc.tool;
  out.mouseUpDispatched = false;
  out.riversInStore = ((s.baseMaps[KEY] && s.baseMaps[KEY].rivers) || []).length;
  if (draft.length < 3) {
    out.fail = '拖动没有采到草稿点（<3）—— 这一张拍不出来（据实报）';
    revealOverlays(); sc.render(); await tick(200);
    return JSON.stringify(out);
  }

  // ── 相机 = 100%，对准草稿中点 ──
  const mid = draft[Math.floor(draft.length / 2)];
  sc.cameraScale = 1.0;
  sc.cameraX = rc.width / 2 - mid.x;
  sc.cameraY = rc.height / 2 - mid.y;
  out.camera = { scale: 1, x: Math.round(sc.cameraX), y: Math.round(sc.cameraY) };
  out.canvas = [cvs.width, cvs.height];
  out.rect = [Math.round(rc.width), Math.round(rc.height)];
  out.drawScale = DRAW_SCALE;
  revealOverlays();
  sc.render();
  await tick(250);
  revealOverlays();

  // ── 预览点列 / 曲线（都走产品实现）──
  const previewCtrl = (typeof sc.smoothWhileDrawing === 'function') ? sc.smoothWhileDrawing(draft, 1, 18) : draft;
  const curve = (typeof sc.catmullRomPoints === 'function') ? sc.catmullRomPoints(previewCtrl, 7) : previewCtrl;
  out.previewImpl = (typeof sc.smoothWhileDrawing === 'function')
    ? 'smoothWhileDrawing(riverDraft, 1, 18) → catmullRomPoints(…, 7)（与 drawOneHandRiver 内部同一条路）'
    : '产品函数未暴露 —— 退化成原始草稿点';
  out.previewCtrlPoints = previewCtrl.length;
  out.curvePoints = curve.length;

  // ── 像素判据 ──
  const dpr = cvs.width / rc.width;
  const img = cvs.getContext('2d').getImageData(0, 0, cvs.width, cvs.height).data;
  const at = (X, Y) => { const i = (Y * cvs.width + X) * 4; return [img[i], img[i + 1], img[i + 2]]; };
  // 右下角小地图兜底排除（`showMinimap=false` 已关，开关失效时这里必须还拦得住）
  const MMX = Math.round((rc.width - 170) * dpr), MMY = Math.round((rc.height - 170) * dpr);
  const masked = (X, Y) => X >= MMX && Y >= MMY;
  out.maskCornerPx = [MMX, MMY];
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
    note: '虚线折线预览会在这里出现长断裂；实心曲线应接近 100%',
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

  // ── 平滑度：同一窗口宽度（8 世界单位弧长重采样）下的最大转角 ──
  const resample = (arr, step) => {
    const outP = [];
    if (!arr || arr.length < 2) return outP;
    const cum = [0];
    for (let i = 0; i + 1 < arr.length; i++) {
      cum.push(cum[i] + Math.hypot(arr[i + 1].x - arr[i].x, arr[i + 1].y - arr[i].y));
    }
    const total = cum[cum.length - 1];
    if (!(total > 0)) return outP;
    let seg = 0;
    for (let d = 0; d <= total; d += step) {
      while (seg + 2 < cum.length && cum[seg + 1] < d) seg++;
      const segLen = cum[seg + 1] - cum[seg];
      const t = segLen > 0 ? Math.max(0, Math.min(1, (d - cum[seg]) / segLen)) : 0;
      outP.push({
        x: arr[seg].x + (arr[seg + 1].x - arr[seg].x) * t,
        y: arr[seg].y + (arr[seg + 1].y - arr[seg].y) * t,
      });
    }
    return outP;
  };
  const maxTurn = (arr) => {
    let mx = 0;
    for (let i = 1; i + 1 < arr.length; i++) {
      const a1 = Math.atan2(arr[i].y - arr[i - 1].y, arr[i].x - arr[i - 1].x);
      const a2 = Math.atan2(arr[i + 1].y - arr[i].y, arr[i + 1].x - arr[i].x);
      let d = Math.abs(a2 - a1);
      if (d > Math.PI) d = 2 * Math.PI - d;
      if (d > mx) mx = d;
    }
    return Math.round((mx * 180) / Math.PI * 10) / 10;
  };
  const STEP = 8;   // 世界单位（此图 scale=1 → 也是屏幕像素）
  out.maxTurnDegPer8Units = {
    rawGesture: maxTurn(resample(draft, STEP)),
    previewCurve: maxTurn(resample(curve, STEP)),
    step: STEP,
    note: '同一弧长窗口下的最大转角：折线在拐角处会明显更大',
  };

  // ── 粗细：源头（预览首点）vs 笔尖（预览末点）──
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
  const tanOf = (arr, i) => [arr[Math.min(arr.length - 1, i + 1)].x - arr[Math.max(0, i - 1)].x,
                             arr[Math.min(arr.length - 1, i + 1)].y - arr[Math.max(0, i - 1)].y];
  const headIdx = inFrame.length ? inFrame[2] || inFrame[0] : 2;
  const tipIdx = inFrame.length ? inFrame[inFrame.length - 3] || inFrame[inFrame.length - 1] : curve.length - 3;
  const hs = crossSection(curve[headIdx].x, curve[headIdx].y, tanOf(curve, headIdx)[0], tanOf(curve, headIdx)[1], 12);
  const ts = crossSection(curve[tipIdx].x, curve[tipIdx].y, tanOf(curve, tipIdx)[0], tanOf(curve, tipIdx)[1], 12);
  out.previewTaper = { headWidthPx: hs.widthPx, tipWidthPx: ts.widthPx,
    ratio: hs.widthPx > 0 ? Math.round((ts.widthPx / hs.widthPx) * 100) / 100 : null,
    headCurveIdx: headIdx, tipCurveIdx: tipIdx,
    note: '笔尖 = 草稿末点 = 预览的宽端（drawOneHandRiver 的 mouth）' };
  // 中段横截面连成几段（应为 1）
  const midX = [];
  for (const frac of [0.2, 0.4, 0.6, 0.8]) {
    const i = inFrame.length ? inFrame[Math.floor(inFrame.length * frac)] : Math.floor(curve.length * frac);
    midX.push(crossSection(curve[i].x, curve[i].y, tanOf(curve, i)[0], tanOf(curve, i)[1], 40));
  }
  out.crossSections = midX;
  out.crossSectionAllSingleRun = midX.every((x) => x.runs === 1);

  revealOverlays();
  sc.render();
  await tick(250);
  revealOverlays();
  return JSON.stringify(out);
})()
