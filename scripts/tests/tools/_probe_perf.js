(async () => {
  const out = {};
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const KEY = 'labPerf';
  // 复刻 test_103 规模：75×75 斜地形 + 全量河网
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
  const time = (fn, n) => {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn();
    return Math.round(((performance.now() - t0) / n) * 100) / 100;
  };

  // A) 无自动河：一次全量 render 的耗时
  sc.autoRivers = []; sc.autoRiverSegments = [];
  out.renderNoRiverMs = time(() => sc.render(), 60);

  // B) 生成自动河后再量（含河网绘制）
  sc.generateAndShowRivers();
  await new Promise(r => setTimeout(r, 500));
  out.segs = (sc.autoRiverSegments || []).length;
  out.drawnSegs = sc.autoRiverDrawn;
  out.renderWithRiverMs = time(() => sc.render(), 60);
  out.renderWithRiverMs_prunedOnly = (() => {
    // 对照：如果不剪枝（全部段都画）会多慢
    const saved = sc.riverFlowGate;
    sc.riverFlowGate = () => 0;
    const ms = time(() => sc.render(), 30);
    sc.riverFlowGate = saved;
    return ms;
  })();

  // C) 拖动一条手画河时，每次 mousemove 的真实成本
  const R = () => cvs.getBoundingClientRect();
  const mk = (t, x, y) => { const r = R(); return new MouseEvent(t, { clientX: r.left + x, clientY: r.top + y, button: 0, buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true }); };
  sc.setTool('river');
  await new Promise(r => setTimeout(r, 60));
  cvs.dispatchEvent(mk('mousedown', 200, 200));
  const t0 = performance.now();
  let moves = 0;
  for (let i = 1; i <= 40; i++) { cvs.dispatchEvent(mk('mousemove', 200 + i * 14, 200 + Math.sin(i / 4) * 30)); moves++; }
  const drawMs = performance.now() - t0;
  out.strokeTotalMs = Math.round(drawMs * 10) / 10;
  out.strokePerMoveMs = Math.round((drawMs / moves) * 100) / 100;
  cvs.dispatchEvent(mk('mouseup', 200 + 40 * 14, 200));
  cvs.dispatchEvent(mk('click', 200 + 40 * 14, 200));
  await new Promise(r => setTimeout(r, 60));
  out.strokeNodes = (s.baseMaps[KEY].rivers || []).length ? s.baseMaps[KEY].rivers[0].points.length : 0;
  out.draftPointsCollected = moves;
  return JSON.stringify(out, null, 1);
})()
