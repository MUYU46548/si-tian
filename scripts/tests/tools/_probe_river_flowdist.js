(async () => {
  const out = {};
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const KEY = 'labFlow';
  const land = { id: 'L1', name: '陆地', kind: 'land', color: '#c98a5b',
    points: [{ x: -4000, y: -3000 }, { x: 4000, y: -3000 }, { x: 4000, y: 3000 }, { x: -4000, y: 3000 }] };
  const sp = 20, cols = 121, rows = 121, pts = [], h = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    pts.push({ x: -2000 + i * sp, y: -2000 + j * sp });
    const d = Math.hypot(i - 60, j - 60);
    h.push(Math.max(0, Math.min(100, Math.round(90 - d * 1.1))));
  }
  const hm = { h, grid: { points: pts, cellsX: cols, cellsY: rows, spacing: sp } };
  s.baseMaps = { ...s.baseMaps, [KEY]: { id: KEY, name: KEY, terrain: [land], referenceImages: [], heightmap: hm,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } };
  const cont = document.querySelector('.scenario-map-container');
  const sc = cont.__vueParentComponent.setupState;
  sc.baseMapKey = KEY;
  if (typeof sc.onBaseMapChange === 'function') sc.onBaseMapChange();
  await new Promise(r => setTimeout(r, 250));
  sc.generateAndShowRivers();
  await new Promise(r => setTimeout(r, 500));
  const segs = (sc.autoRiverSegments || []).slice();
  const flows = segs.map(x => x.flow).sort((a, b) => a - b);
  const q = (p) => flows[Math.min(flows.length - 1, Math.floor(flows.length * p))] || 0;
  out.segCount = segs.length;
  out.flowDist = { min: flows[0], p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9), p99: q(0.99), max: flows[flows.length - 1] };
  out.segMaxFlow = sc.autoRiverMaxFlow;
  out.pathFlowDist = (() => {
    const pf = (sc.autoRivers || []).map(r => r.flow || 0).sort((a, b) => a - b);
    const qq = (p) => pf[Math.min(pf.length - 1, Math.floor(pf.length * p))] || 0;
    return { n: pf.length, p50: qq(0.5), p75: qq(0.75), p90: qq(0.9), max: pf[pf.length - 1] };
  })();
  return JSON.stringify(out, null, 1);
})()
