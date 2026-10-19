(async () => {
  const out = {};
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const KEY = 'labCls';
  // 复刻 test_103 的斜地形（75×75 / spacing 14.4）
  const sp = 14.4, cols = 75, rows = 75, pts = [], h = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    pts.push({ x: i * sp, y: j * sp });
    h.push(Math.max(0, Math.min(100, Math.round(100 - (i / (cols - 1)) * 100))));
  }
  const hm = { h, grid: { points: pts, cellsX: cols, cellsY: rows, spacing: sp } };
  const land = { id: 'L1', name: '陆地', kind: 'land', color: '#c98a5b',
    points: [{ x: 0, y: 0 }, { x: cols * sp, y: 0 }, { x: cols * sp, y: rows * sp }, { x: 0, y: rows * sp }] };
  s.baseMaps = { ...s.baseMaps, [KEY]: { id: KEY, name: KEY, terrain: [land], referenceImages: [], heightmap: hm,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } };
  const cont = document.querySelector('.scenario-map-container');
  const sc = cont.__vueParentComponent.setupState;
  sc.baseMapKey = KEY;
  if (typeof sc.onBaseMapChange === 'function') sc.onBaseMapChange();
  await new Promise(r => setTimeout(r, 250));
  const cvs = sc.canvas;
  const W = cvs.width, H = cvs.height;
  const c = cvs.getContext('2d');
  const snap = () => {
    sc.render();
    return c.getImageData(0, 0, W, H).data.slice();
  };
  // A) 没有自动河
  sc.autoRivers = []; sc.autoRiverSegments = [];
  const A = snap();
  // B) 有自动河
  sc.generateAndShowRivers();
  await new Promise(r => setTimeout(r, 400));
  const B = snap();
  out.scale = Math.round(sc.cameraScale * 1000) / 1000;
  out.drawn = sc.autoRiverDrawn;
  out.W = W; out.H = H;
  const bi = ((H - 4) * W + 4) * 4;   // 画布左下角（可能是画布外的网格）

  // 基准色：地形（取**画布内靠中部**的一个点 —— 左下角是画布外的网格，不是地形！）
  const ti = (Math.floor(H * 0.5) * W + Math.floor(W * 0.5)) * 4;
  const bg = [A[ti], A[ti + 1], A[ti + 2]];
  out.bg = bg;
  out.bgCorner = [A[bi], A[bi + 1], A[bi + 2]];
  const RIVER = [0x5d, 0x97, 0xbb];
  const dist = (r, g, b, t) => Math.abs(r - t[0]) + Math.abs(g - t[1]) + Math.abs(b - t[2]);
  out.bgToRiver = dist(bg[0], bg[1], bg[2], RIVER);

  // 真值：A/B 两张图**真的变了**的像素（这就是"画出来了"的定义）
  let diff = 0, diffSum = 0;
  for (let i = 0; i < A.length; i += 4) {
    const dd = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
    if (dd > 8) { diff++; diffSum += dd; }
  }
  out.diffPixels = diff;
  out.diffMean = diff ? Math.round(diffSum / diff * 10) / 10 : 0;

  // 各种分类器在 B 上的读数（要找的是**接近 diffPixels** 的那个）
  const variants = {
    closer: (r, g, b) => dist(r, g, b, RIVER) < dist(r, g, b, bg),
    closer15: (r, g, b) => dist(r, g, b, RIVER) * 1.15 < dist(r, g, b, bg),
    closer25: (r, g, b) => dist(r, g, b, RIVER) * 1.25 < dist(r, g, b, bg),
    blueshift: (r, g, b) => (b - r) > (bg[2] - bg[0]) + 20,
    blueStrong: (r, g, b) => (b - r) > 45 && b > 100,
  };
  out.variantHits = {};
  for (const k of Object.keys(variants)) {
    let n = 0;
    for (let i = 0; i < B.length; i += 4) if (variants[k](B[i], B[i + 1], B[i + 2])) n++;
    out.variantHits[k] = n;
  }
  // 真值像素里，各分类器**盖住多少**（召回）与**多算了多少**（精确度）
  out.recall = {};
  for (const k of Object.keys(variants)) {
    let tp = 0, fp = 0;
    for (let i = 0; i < A.length; i += 4) {
      const dd = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
      const isTrue = dd > 8;
      const isHit = variants[k](B[i], B[i + 1], B[i + 2]);
      if (isTrue && isHit) tp++;
      else if (!isTrue && isHit) fp++;
    }
    out.recall[k] = { tp, fp, recallPct: diff ? Math.round(tp / diff * 1000) / 10 : 0 };
  }
  return JSON.stringify(out, null, 1);
})()
