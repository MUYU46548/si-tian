(async () => {
  const out = {};
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const KEY = 'labCase103';
  // ⚠️ 复刻 test_103 的地形：**斜地形**（沿 x 递减），不是圆丘
  const sp = 14.4, cols = 75, rows = 75, pts = [], h = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    pts.push({ x: i * sp, y: j * sp });
    const v = 100 - (i / (cols - 1)) * 100;
    h.push(Math.max(0, Math.min(100, Math.round(v))));
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
  out.scale = Math.round(sc.cameraScale * 1000) / 1000;
  out.spacingPx = Math.round(sp * sc.cameraScale * 100) / 100;
  out.netMinPx = Math.round(sc.riverMinWidthForNet() * 100) / 100;
  sc.generateAndShowRivers();
  await new Promise(r => setTimeout(r, 500));
  out.rivers = (sc.autoRivers || []).length;
  out.segs = (sc.autoRiverSegments || []).length;
  out.drawn = sc.autoRiverDrawn;
  out.gate = Math.round(sc.riverFlowGate(sc.autoRiverMaxFlow, sc.autoRiverSegments) * 10) / 10;
  out.scaleAfter = Math.round(sc.cameraScale * 1000) / 1000;
  out.spacingPxAfter = Math.round(sp * sc.cameraScale * 100) / 100;
  out.netMinPxAfter = Math.round(sc.riverMinWidthForNet() * 100) / 100;
  out.hint = String(sc.provinceHint || '').slice(0, 140);
  // 全画布统计河色（#5d97bb 附近，与 test_103 同口径但更宽）
  sc.render();
  await new Promise(r => setTimeout(r, 120));
  const ctx2 = cvs.getContext('2d');
  const W = cvs.width, H = cvs.height;
  const img = ctx2.getImageData(0, 0, W, H).data;
  let hit = 0, near = 0, sample = null;
  for (let i = 0; i < img.length; i += 4) {
    const r = img[i], g = img[i + 1], b = img[i + 2];
    const d = Math.abs(r - 93) + Math.abs(g - 151) + Math.abs(b - 187);
    if (d < 60) { near++; if (!sample) sample = [r, g, b]; }
    if (r === 93 && g === 151 && b === 187) hit++;
  }
  out.exactHit = hit;
  out.nearHit = near;
  out.nearSample = sample;
  out.canvas = [W, H];
  return JSON.stringify(out, null, 1);
})()
