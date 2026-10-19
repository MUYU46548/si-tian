// 探针：真实底图（docs/mockups/desite.map）上的**卡顿定位** —— 分层计时 + 交互帧统计。
// 由 `_probe_jank_real.py` 驱动（**不是** `_lab.py run`：整段要跑 40s+，单次 eval 会撞 CDP 15s 读超时）。
// 结果写进 `window.__JANK`（Python 侧轮询）。前提：`src/renderer/public/__real_desite.map` 存在。
window.__JANK = { stage: 'boot', out: {}, fails: [] };
// 🔴 探针必须先掐掉 modal：真实底图（415 省满铺）上「圈个地」松手会撞**压叠闸门**的
//    `window.confirm`；无 dialog handler 的 headless 页面会**永久阻塞**在对话框上
//    （第一版实测：整整 180s 连 `Page.enable` 都不回）。探针要量的是"落库那条链多长"，
//    不是"人在对话框前坐多久" —— 所以这里把 confirm 一律当"确认"。
window.confirm = () => true;
window.alert = () => {};
window.prompt = (q, d) => d;
(async () => {
  const J = window.__JANK;
  const OUT = J.out;
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));
  const sc = () => {
    const el = document.querySelector('.scenario-map-container');
    return el ? el.__vueParentComponent.setupState : null;
  };
  const timeit = (fn, n) => {
    const arr = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      fn(i);
      arr.push(performance.now() - t0);
    }
    arr.sort((a, b) => a - b);
    return { p50: +arr[Math.floor(arr.length / 2)].toFixed(2), max: +arr[arr.length - 1].toFixed(2) };
  };

  // ── ① 装真实底图（走产品导入链）────────────────────────────────────────
  J.stage = 'import';
  const AP = await import('/src/utils/azgaar-parser.js');
  const text = await (await fetch('/__real_desite.map')).text();
  OUT.mapBytes = text.length;
  const parsed = AP.parseMapFile(text);
  const NAME = '德斯特';
  const json = AP.buildScenariosJson(parsed, NAME, '当前');
  s.importFromScenariosJson(json);
  await tick(2500);
  let sm = sc();
  sm.baseMapKey = NAME;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await tick(1000);
  if (typeof sm.fitToView === 'function') sm.fitToView();
  await tick(600);
  const bm = s.baseMaps[NAME] || {};
  const hm = bm.heightmap || {};
  const grid = hm.grid || {};
  OUT.data = {
    terrain: (bm.terrain || []).length,
    rivers: (bm.rivers || []).length,
    riverNodes: (bm.rivers || []).reduce((a, r) => a + ((r.points || []).length), 0),
    heightCells: Array.isArray(hm.h) ? hm.h.length : -1,
    cellsX: grid.cellsX, cellsY: grid.cellsY, spacing: grid.spacing,
    routes: (bm.routes || []).length, markers: (bm.markers || []).length, labels: (bm.labels || []).length,
    minimap: sm.showMinimap, showLabels: sm.showLabels, showRivers: sm.showRivers,
    riverSource: sm.riverSource, rasterLayer: sm.rasterLayer,
  };

  // ── ② 分层计时（每层独立调用；zoom 1 / 2 / 4）──────────────────────────
  J.stage = 'layers';
  const cvs = sm.canvas;
  const DRAW_FNS = ['drawBackground', 'drawBiomeBackground', 'drawProvinces', 'drawProvinceBorders',
    'drawRivers', 'drawRiverPaths', 'drawSelectedRiverHighlight', 'drawRoutes', 'drawLabels',
    'drawPolityLabels', 'drawReliefIcons', 'drawScenarioMarkers', 'drawBurgs', 'drawBurgTooltip',
    'drawMinimap', 'drawDataChart', 'drawPreviewOverlay'];
  OUT.layers = {};
  for (const zoom of [1, 2, 4]) {
    sm.cameraScale = zoom;
    sm.render();
    await tick(60);
    const per = { __render: timeit(() => sm.render(), 10) };
    for (const fn of DRAW_FNS) {
      if (typeof sm[fn] !== 'function') continue;
      try { per[fn] = timeit(() => sm[fn](sm.ctx), 6); } catch (e) { per[fn] = { err: String(e).slice(0, 60) }; }
    }
    OUT.layers['z' + zoom] = per;
  }
  sm.cameraScale = 1;
  sm.rasterLayer = 'height';
  sm.render();
  await tick(80);
  OUT.layers.heightRaster_render = timeit(() => sm.render(), 10);
  try { OUT.layers.heightRaster_drawRaster = timeit(() => sm.drawRasterLayer(sm.ctx, 'height', 0.45), 6); } catch (e) { OUT.layers.heightRaster_drawRaster = { err: String(e).slice(0, 60) }; }
  sm.rasterLayer = 'none';
  sm.render();
  await tick(80);
  OUT.layers.noneRaster_render = timeit(() => sm.render(), 10);

  // ── ③ 命中判定（每次 mousemove 都要付）────────────────────────────────
  J.stage = 'hit';
  const rect0 = cvs.getBoundingClientRect();
  const hit = { n: 0, riverMs: 0, provinceMs: 0, perRiver: 0, perProvince: 0 };
  let t0 = performance.now();
  for (let y = 20; y < rect0.height - 20; y += 40) {
    for (let x = 20; x < rect0.width - 20; x += 40) {
      const w = sm.screenToWorld(x, y);
      if (typeof sm.hitBaseMapRiver === 'function') sm.hitBaseMapRiver(w.x, w.y);
      if (typeof sm.hitRiverNodeIndex === 'function') sm.hitRiverNodeIndex(w.x, w.y);
      hit.n++;
    }
  }
  hit.riverMs = +(performance.now() - t0).toFixed(1);
  hit.perRiver = +(hit.riverMs / Math.max(1, hit.n)).toFixed(3);
  if (typeof sm.hitTest === 'function') {
    t0 = performance.now();
    for (let y = 20; y < rect0.height - 20; y += 40) for (let x = 20; x < rect0.width - 20; x += 40) sm.hitTest(x, y);
    hit.provinceMs = +(performance.now() - t0).toFixed(1);
    hit.perProvince = +(hit.provinceMs / Math.max(1, hit.n)).toFixed(3);
  }
  OUT.hit = hit;

  // ── ④ 交互帧统计：每帧派发一次真实 MouseEvent，量**帧间隔**与**handler 阻塞**──
  J.stage = 'interactions';
  const R = () => cvs.getBoundingClientRect();
  const mk = (t, x, y) => {
    const r = R();
    return new MouseEvent(t, {
      clientX: r.left + x, clientY: r.top + y, button: 0,
      buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true,
    });
  };
  const frameStats = (ms, perFrame) => new Promise((resolve) => {
    const deltas = []; let last = performance.now(); let stop = false; let handlerMs = 0; let evs = 0;
    const loop = () => {
      const now = performance.now();
      deltas.push(now - last); last = now;
      try { handlerMs += perFrame ? (perFrame() || 0) : 0; evs += perFrame ? 1 : 0; } catch (e) { J.fails.push('perFrame: ' + String(e).slice(0, 120)); }
      if (!stop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    setTimeout(() => { stop = true; }, ms);
    setTimeout(() => {
      const d = deltas.slice(1).sort((a, b) => a - b);
      const q = (p) => d.length ? +d[Math.min(d.length - 1, Math.floor(d.length * p))].toFixed(1) : -1;
      resolve({
        frames: d.length, p50: q(0.5), p95: q(0.95), max: d.length ? +d[d.length - 1].toFixed(1) : -1,
        over33: d.filter((v) => v > 33).length, over100: d.filter((v) => v > 100).length,
        handlerMsPerEvent: evs ? +(handlerMs / evs).toFixed(2) : -1,
      });
    }, ms + 150);
  });
  OUT.interactions = {};

  sm.setTool('select');
  await tick(120);
  { let i = 0; OUT.interactions.hover_select = await frameStats(1500, () => { i++; const r = R(); const x = 60 + (i * 7) % Math.max(40, r.width - 120); const y = 60 + (i * 11) % Math.max(40, r.height - 120); const t = performance.now(); cvs.dispatchEvent(mk('mousemove', x, y)); return performance.now() - t; }); }
  J.stage = 'interactions:river-hover';
  sm.setTool('river');
  await tick(150);
  { let i = 0; OUT.interactions.hover_river = await frameStats(1500, () => { i++; const r = R(); const x = 60 + (i * 7) % Math.max(40, r.width - 120); const y = 60 + (i * 11) % Math.max(40, r.height - 120); const t = performance.now(); cvs.dispatchEvent(mk('mousemove', x, y)); return performance.now() - t; }); }
  J.stage = 'interactions:river-trace';
  {
    const r = R();
    cvs.dispatchEvent(mk('mousedown', 120, 120));
    await tick(60);
    let i = 0;
    OUT.interactions.river_trace = await frameStats(1800, () => { i++; const x = 120 + i * 3; const y = 120 + Math.sin(i / 6) * 40; const t = performance.now(); cvs.dispatchEvent(mk('mousemove', x % (r.width - 40), y % (r.height - 40))); return performance.now() - t; });
    OUT.interactions.river_draftPts = (sm.riverDraft || []).length;
    const t1 = performance.now();
    cvs.dispatchEvent(mk('mouseup', 200, 160));
    OUT.interactions.river_land_ms = +(performance.now() - t1).toFixed(1);
    await tick(900);
    OUT.interactions.river_after_land = s.baseMaps[NAME] ? (s.baseMaps[NAME].rivers || []).length : -1;
  }
  J.stage = 'interactions:node-drag';
  sm.setTool('river');
  await tick(120);
  const firstRiver = (s.baseMaps[NAME].rivers || [])[0];
  if (firstRiver && typeof sm.setRiverSelection === 'function') {
    sm.setRiverSelection([firstRiver.id], firstRiver.id);
    sm.render();
    await tick(120);
    const nodes = firstRiver.points || [];
    const node = nodes[Math.floor(nodes.length / 2)] || { x: 0, y: 0 };
    const p = sm.worldToScreen(node.x, node.y);
    const r = R();
    if (p && p.x > 5 && p.y > 5 && p.x < r.width - 5 && p.y < r.height - 5) {
      cvs.dispatchEvent(mk('mousedown', p.x, p.y));
      await tick(80);
      OUT.interactions.nodeDragStarted = !!sm.riverDrag;
      let i = 0;
      OUT.interactions.node_drag = await frameStats(1500, () => { i++; const t = performance.now(); cvs.dispatchEvent(mk('mousemove', p.x + (i % 11) - 5, p.y + (i % 7) - 3)); return performance.now() - t; });
      const t2 = performance.now();
      cvs.dispatchEvent(mk('mouseup', p.x, p.y));
      OUT.interactions.node_drag_commit_ms = +(performance.now() - t2).toFixed(1);
      await tick(600);
    } else { J.fails.push('节点在屏幕外，跳过拖节点测量'); }
  }
  J.stage = 'interactions:pan';
  sm.setTool('pan');
  await tick(120);
  {
    const r = R();
    cvs.dispatchEvent(mk('mousedown', r.width / 2, r.height / 2));
    await tick(40);
    let i = 0;
    OUT.interactions.pan = await frameStats(1200, () => { i++; const t = performance.now(); cvs.dispatchEvent(mk('mousemove', r.width / 2 + (i % 30), r.height / 2 + (i % 20))); return performance.now() - t; });
    cvs.dispatchEvent(mk('mouseup', r.width / 2, r.height / 2));
  }
  // ── ⑤ 省份自由绘制 + 落库（**放最后**：落库是重链，量完它探针就该结束了）──────
  J.stage = 'interactions:prov-draw';
  sm.setTool('draw');
  await tick(150);
  {
    const r = R();
    const cx = r.width * 0.35, cy = r.height * 0.45, Rr = Math.min(r.width, r.height) * 0.12;
    cvs.dispatchEvent(mk('mousedown', cx + Rr, cy));
    await tick(60);
    let i = 0;
    OUT.interactions.prov_draw = await frameStats(1800, () => { i++; const a = (i / 40) * Math.PI * 2; const t = performance.now(); cvs.dispatchEvent(mk('mousemove', cx + Math.cos(a) * Rr, cy + Math.sin(a) * Rr)); return performance.now() - t; });
    OUT.interactions.freeTracePts = (sm.freeTrace || []).length;
    // 落库：同步 handler 阻塞时长（这一步会把主线程占住；Python 侧轮询会因此超时 → 靠重连续读）
    const t0 = performance.now();
    J.stage = 'interactions:prov-land';
    try { cvs.dispatchEvent(mk('mouseup', cx + Rr, cy)); } catch (e) { J.fails.push('land: ' + String(e).slice(0, 200)); }
    OUT.interactions.prov_land_ms = +(performance.now() - t0).toFixed(1);
    OUT.interactions.prov_after = (s.baseMaps[NAME] ? (s.baseMaps[NAME].terrain || []).length : -1);
  }
  sm.setTool('select');
  J.stage = 'done';
})().catch((e) => {
  window.__JANK.fails.push('probe: ' + String((e && e.stack) || e).slice(0, 500));
  window.__JANK.stage = 'done';
});
'kicked'
