(async () => {
  const el = document.querySelector('.scenario-map-container');
  if (!el) return JSON.stringify({ error: 'no scenario-map-container', fails: [] });
  const sm = el.__vueParentComponent.setupState;
  const bm = sm.baseMap || {};
  const hm = bm.heightmap || {};
  const grid = hm.grid || {};
  await new Promise((r) => setTimeout(r, 300));
  return JSON.stringify({
    baseMapKey: sm.baseMapKey,
    basemapNames: Object.keys(sm.store.baseMaps || {}),
    rivers: (bm.rivers || []).length,
    handRivers: (typeof sm.handDrawnRivers === 'function' ? sm.handDrawnRivers() : []).length,
    terrain: (bm.terrain || []).length,
    terrainPts: (bm.terrain || []).reduce((a, t) => a + ((t.points || []).length), 0),
    heightCells: Array.isArray(hm.h) ? hm.h.length : (hm.h ? hm.h.length : 0),
    gridPts: (grid.points || []).length,
    cellsX: grid.cellsX, cellsY: grid.cellsY, spacing: grid.spacing,
    routes: (bm.routes || []).length,
    markers: (bm.markers || []).length,
    labels: (bm.labels || []).length,
    vertexHandles: (typeof sm.vertexHandles === 'function' ? String(sm.vertexHandles()).slice(0, 40) : 'n/a'),
    tool: sm.tool,
    cameraScale: sm.cameraScale,
    showRivers: sm.showRivers, riverSource: sm.riverSource,
    readOnly: !!(sm.store && sm.store.isReadOnly),
    exposedDrawFns: Object.keys(sm).filter((k) => /^draw/.test(k)),
    fails: [],
  }, null, 1);
})()
