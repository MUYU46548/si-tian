(async () => {
  const out = {};
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const KEY = 'labSelfBuilt';
  // 🔴 模拟"用户在司天里自己画的大陆"：**完全没有高度图**，只有省份多边形。
  //    这是一个不规则大陆（不是圆 —— 圆会掩盖"放射状"这个老毛病）。
  const mkRing = (cx, cy, r, n, wobble, seed) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const w = 1 + Math.sin(a * 3 + seed) * wobble + Math.sin(a * 7 + seed * 2) * wobble * 0.5;
      pts.push({ x: cx + Math.cos(a) * r * w, y: cy + Math.sin(a) * r * w * 0.72 });
    }
    return pts;
  };
  const mainland = { id: 'p1', name: '大陆', kind: 'land', color: '#c9a06a',
    points: mkRing(0, 0, 900, 90, 0.16, 1.2) };
  // 一个半岛（造出"海岸线内凹"的地方，河流会往那里汇）
  const peninsula = { id: 'p2', name: '半岛', kind: 'land', color: '#a8b98a',
    points: mkRing(600, 380, 330, 50, 0.2, 2.7) };
  s.baseMaps = { ...s.baseMaps, [KEY]: {
    id: KEY, name: KEY, terrain: [mainland, peninsula], referenceImages: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } };
  const sc = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  sc.baseMapKey = KEY; sc.onBaseMapChange?.();
  await new Promise(r => setTimeout(r, 350));

  out.hasHeightmapBefore = !!s.getHeightmapFor(KEY)?.grid;

  // ① 先看旧路径：没有高度图时直接点自动河流会怎样
  const before = s.generateRivers(KEY, {});
  out.genericBefore = { ok: before.ok, reason: before.reason || null,
    rivers: (before.rivers || []).length, synthesized: !!before.synthesized };

  // ② 走"按轮廓生成地形"（用户点按钮）
  const syn = s.synthesizeBaseMapTerrain(KEY);
  out.synthesize = { ok: syn.ok, reason: syn.reason || null, cellCount: syn.cellCount,
    spacing: syn.spacing, message: (syn.message || '').slice(0, 160) };
  const hm = s.getHeightmapFor(KEY);
  out.hasHeightmapAfter = !!hm?.grid;
  if (hm?.h) {
    let mn = Infinity, mx = -Infinity, sum = 0, land = 0;
    for (const v of hm.h) { if (v < mn) mn = v; if (v > mx) mx = v; sum += v; if (v >= 20) land++; }
    out.heightStats = { min: Math.round(mn), max: Math.round(mx), mean: Math.round(sum / hm.h.length),
      landCells: land, total: hm.h.length,
      grid: `${hm.grid.cellsX}x${hm.grid.cellsY}` };
  }

  // ③ 现在再点自动河流（有推演地形了）
  const t0 = performance.now();
  const after = s.generateRivers(KEY, {});
  const ms = Math.round(performance.now() - t0);
  out.riversAfter = { ok: after.ok, rivers: (after.rivers || []).length,
    segs: (after.segments || []).length, segMaxFlow: after.segMaxFlow || 0, ms };
  // 最长河链长度（"有没有长河"的唯一硬判据）
  const lens = (after.rivers || []).map(r => (r.points || []).length).sort((a, b) => b - a);
  out.pathLenMax = lens[0] || 0;
  out.pathLenP50 = lens[Math.floor(lens.length / 2)] || 0;

  // ④ 河网 → 河链（画出来的那个结构）
  try {
    const mod = await import('/src/utils/riverChains.js');
    const gate = sc.riverFlowGate(after.segMaxFlow, after.segments);
    const pruned = sc.pruneRiverNetwork(after.segments, gate);
    const paths = mod.buildRiverPaths(pruned.kept, { minFlow: gate, minLen: 5, maxPaths: 900 });
    out.chains = paths.length;
    const cl = paths.map(p => p.points.length).sort((a, b) => b - a);
    out.chainLenMax = cl[0] || 0;
    out.chainLenP50 = cl[Math.floor(cl.length / 2)] || 0;
    out.gate = Math.round(gate * 100) / 100;
  } catch (e) { out.chainErr = String(e).slice(0, 160); }

  // ⑤ 相机：看全图 + 截图
  const cvs = sc.canvas, wrap = cvs.parentElement;
  const reveal = () => { for (const fx of [0.25,0.4,0.55,0.7,0.85]) for (const fy of [0.3,0.45,0.6,0.75]) {
    const el = document.elementFromPoint(innerWidth*fx, innerHeight*fy);
    if (!el || el.tagName === 'CANVAS') continue;
    let n = el, d = 0;
    while (n && n !== document.body && d < 8) { const cs = getComputedStyle(n);
      if (cs.position === 'absolute' || cs.position === 'fixed') { n.style.display = 'none'; break; } n = n.parentElement; d++; } } };
  reveal();
  sc.autoRivers = after.rivers; sc.autoRiverSegments = after.segments;
  sc.autoRiverMaxFlow = after.segMaxFlow; sc.autoRiverDrawn = (after.segments || []).length;
  sc.rasterLayer = 'none'; sc.showBorders = false;
  sc.cameraScale = Math.min(wrap.clientWidth / 2600, wrap.clientHeight / 2100);
  sc.cameraX = wrap.clientWidth / 2; sc.cameraY = wrap.clientHeight / 2;
  sc.render(); await new Promise(r => setTimeout(r, 250));
  return JSON.stringify(out, null, 1);
})()
