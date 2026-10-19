(async () => {
  const out = {};
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const KEY = 'labRiverG';
  // 造一张有陆地色的底图，贴近用户截图（橙色地形 + 几条省界）
  const land = { id: 'L1', name: '陆地', kind: 'land', color: '#c98a5b',
    points: [{ x: -2000, y: -1500 }, { x: 3000, y: -1500 }, { x: 3000, y: 2500 }, { x: -2000, y: 2500 }] };
  s.baseMaps = { ...s.baseMaps, [KEY]: { id: KEY, name: KEY, terrain: [land], referenceImages: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } };
  const cont = document.querySelector('.scenario-map-container');
  const sc = cont.__vueParentComponent.setupState;
  // 🔴 探针自己也要"看得到画布"：进入剧本模式会自动打开剧本面板，
  //    它盖住左半边 → 截图上看到的不是画布而是面板（我上一版就栽在这）。
  try {
    const ps = document.querySelector('#app').__vue_app__._instance.setupState.panelsStore
      || document.querySelector('#app').__vue_app__._instance.setupState.projectStore;
    if (typeof sc.closePanel === 'function') sc.closePanel();
    document.querySelectorAll('.panel-close, [data-testid="panel-close"]').forEach((b) => b.click());
  } catch (e) { /* 面板关不掉不致命 */ }
  sc.baseMapKey = KEY;
  if (typeof sc.onBaseMapChange === 'function') sc.onBaseMapChange();
  await new Promise(r => setTimeout(r, 200));
  const cvs = sc.canvas;
  const R = () => cvs.getBoundingClientRect();
  const mk = (t, x, y) => { const r = R(); return new MouseEvent(t, { clientX: r.left + x, clientY: r.top + y, button: 0, buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true }); };
  const rivers = () => (s.baseMaps[KEY].rivers || []);

  sc.setTool('river');
  await new Promise(r => setTimeout(r, 80));
  out.tool = sc.tool;
  out.camera = JSON.stringify({ x: sc.cameraX, y: sc.cameraY, s: sc.cameraScale });

  // ① 画一条长河（真鼠标事件，模拟用户横穿画布拖一笔）
  const r0 = R();
  const W = r0.width, H = r0.height;
  cvs.dispatchEvent(mk('mousedown', W * 0.08, H * 0.22));
  for (let i = 1; i <= 60; i++) {
    const x = W * 0.08 + (W * 0.84) * (i / 60);
    const y = H * 0.22 + Math.sin(i / 9) * H * 0.10;
    cvs.dispatchEvent(mk('mousemove', x, y));
  }
  out.rawDraft = sc.riverDraft.length;
  cvs.dispatchEvent(mk('mouseup', W * 0.92, H * 0.3));
  cvs.dispatchEvent(mk('click', W * 0.92, H * 0.3));
  await new Promise(r => setTimeout(r, 60));
  out.rivers = rivers().length;
  out.nodes = rivers().length ? rivers()[0].points.length : 0;
  out.widthField = rivers().length ? rivers()[0].width : null;
  out.selected = !!sc.selectedRiver;
  if (!rivers().length) return JSON.stringify(out);

  // ② 关键：**节点间距 vs 屏幕像素** —— "一堆点"的判据
  const pts = rivers()[0].points;
  let minGapPx = Infinity, sumGap = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y) * sc.cameraScale;
    minGapPx = Math.min(minGapPx, d); sumGap += d;
  }
  out.minGapPx = Math.round(minGapPx * 10) / 10;
  out.avgGapPx = Math.round((sumGap / (pts.length - 1)) * 10) / 10;
  out.handleGate = { max: sc.RIVER_HANDLE_MAX, minZoom: sc.RIVER_HANDLE_MIN_ZOOM, showAll: pts.length <= 120 && sc.cameraScale >= 1.2 };

  // ③ 像素判据：河身中段是不是**连续的线**（沿法线扫一行，看有几个"河"的像素块）
  sc.render();
  await new Promise(r => setTimeout(r, 30));
  const ctx2 = cvs.getContext('2d');
  const dpr = cvs.width / r0.width;
  const isRiver = (r, g, b) => {
    // 水面 #5d97bb 及其抗锯齿：蓝通道明显大于红通道、且不太暗
    return b > r + 18 && b > 90 && g > r;
  };
  // 取河中段一个控制点，沿它的法线扫描
  const mid = pts[Math.floor(pts.length / 2)];
  const before = pts[Math.floor(pts.length / 2) - 1];
  const nx = -(mid.y - before.y), ny = (mid.x - before.x);
  const nl = Math.hypot(nx, ny) || 1;
  const sx = (sc.cameraX + mid.x * sc.cameraScale) * dpr;
  const sy = (sc.cameraY + mid.y * sc.cameraScale) * dpr;
  const stepPx = 1;
  const dirx = (nx / nl), diry = (ny / nl);
  let runs = 0, inRun = false, hitCount = 0;
  for (let t = -40; t <= 40; t += stepPx) {
    const px2 = Math.round(sx + dirx * t * dpr);
    const py2 = Math.round(sy + diry * t * dpr);
    if (px2 < 0 || py2 < 0 || px2 >= cvs.width || py2 >= cvs.height) continue;
    const d = ctx2.getImageData(px2, py2, 1, 1).data;
    const hit = isRiver(d[0], d[1], d[2]);
    if (hit) { hitCount++; if (!inRun) { runs++; inRun = true; } } else inRun = false;
  }
  out.crossSection = { runs, hitCount };

  // ④ 沿河身**采样 5 个点**：画面里到底有没有河色（颜色一致性）
  const sampleColors = [];
  for (const frac of [0.15, 0.35, 0.55, 0.75, 0.9]) {
    const p = pts[Math.floor(pts.length * frac)];
    const q = pts[Math.min(pts.length - 1, Math.floor(pts.length * frac) + 1)];
    const cx = (sc.cameraX + (p.x + q.x) / 2 * sc.cameraScale) * dpr;
    const cy = (sc.cameraY + (p.y + q.y) / 2 * sc.cameraScale) * dpr;
    const d = ctx2.getImageData(Math.round(cx), Math.round(cy), 1, 1).data;
    sampleColors.push([d[0], d[1], d[2]]);
  }
  out.sampleColors = sampleColors;
  out.allRiverColor = sampleColors.every(([r, g, b]) => isRiver(r, g, b));
  // 与目标色 #5d97bb = (93,151,187) 的偏差
  out.maxColorDev = Math.max(...sampleColors.map(([r, g, b]) =>
    Math.max(Math.abs(r - 93), Math.abs(g - 151), Math.abs(b - 187))));
  return JSON.stringify(out);
})()
