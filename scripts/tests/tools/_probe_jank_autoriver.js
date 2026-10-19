// 探针（之二）：**自动河流在场时**的每帧成本 —— 用来验证「卡顿发生在方方面面」的假说：
//   `renderFrame` 里那段自动河几何（`getAutoRiverNetwork` → `riverFlowGate` → `pruneRiverNetwork`
//   → `buildRiverPaths` → `thinRiverPath` → **`buildLandMask` + `clipPolylinesToCoast`**）
//   有没有按帧缓存。若无，则**只要画过自动河**，此后每一次拖动（省份/河流/平移）都要付这笔钱。
// 结果写进 `window.__JANK`；confirm 已掐掉（见之一）。
window.__JANK = { stage: 'boot', out: {}, fails: [] };
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
  const importReal = async () => {
    const AP = await import('/src/utils/azgaar-parser.js');
    const text = await (await fetch('/__real_desite.map')).text();
    const parsed = AP.parseMapFile(text);
    const NAME = '德斯特';
    const json = AP.buildScenariosJson(parsed, NAME, '当前');
    s.importFromScenariosJson(json);
    await tick(2500);
    const sm = sc();
    sm.baseMapKey = NAME;
    if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
    await tick(1000);
    if (typeof sm.fitToView === 'function') sm.fitToView();
    await tick(600);
    return { sm, NAME };
  };
  try {
    J.stage = 'import';
    const { sm, NAME } = await importReal();
    const cvs = sm.canvas;
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
    // ── 自动河流生成（真实底图 + 真实地形）──────────────────────────────
    J.stage = 'auto-rivers';
    OUT.autoRivers = { before: (sm.autoRivers || []).length, showRiverAuto: sm.showRiverAuto };
    const t0 = performance.now();
    sm.generateAndShowRivers();
    OUT.autoRivers.genMs = +(performance.now() - t0).toFixed(1);
    await tick(1500);
    OUT.autoRivers.count = (sm.autoRivers || []).length;
    OUT.autoRivers.segments = (sm.autoRiverSegments || []).length;
    OUT.autoRivers.drawn = sm.autoRiverDrawn;
    OUT.autoRivers.maxFlow = sm.autoRiverMaxFlow;
    // ── 每帧成本：render() 与「分段单独测」────────────────────────────────
    J.stage = 'auto-render';
    for (const zoom of [1, 2, 4]) {
      sm.cameraScale = zoom;
      sm.render();
      await tick(80);
      OUT['render_autoriver_z' + zoom] = timeit(() => sm.render(), 12);
    }
    sm.cameraScale = 1;
    sm.render();
    await tick(100);
    // 拆开量：这两块是不是每帧都在重算？
    for (const fn of ['getAutoRiverNetwork', 'riverFlowGate', 'pruneRiverNetwork', 'buildRiverPaths']) {
      if (typeof sm[fn] !== 'function') { OUT['fn_' + fn] = 'not exposed'; continue; }
      try {
        if (fn === 'getAutoRiverNetwork') OUT.fn_getAutoRiverNetwork = timeit(() => sm.getAutoRiverNetwork(), 12);
        else if (fn === 'riverFlowGate') OUT.fn_riverFlowGate = timeit(() => sm.riverFlowGate(sm.autoRiverMaxFlow, sm.autoRiverSegments), 12);
        else if (fn === 'pruneRiverNetwork') OUT.fn_pruneRiverNetwork = timeit(() => sm.pruneRiverNetwork(sm.autoRiverSegments, sm.riverFlowGate(sm.autoRiverMaxFlow, sm.autoRiverSegments)), 8);
      } catch (e) { OUT['fn_' + fn] = { err: String(e).slice(0, 80) }; }
    }
    // 真要确认"每帧重算"，看 `_probe` 里量不到的内部件：直接用 CDP 抓 render 内部耗时不可行，
    // 改量**同一帧里的反复调用**是否等价：连调两次 render，若第二次显著更快 = 有缓存。
    const r1 = [], r2 = [];
    for (let i = 0; i < 8; i++) { const a = performance.now(); sm.render(); r1.push(performance.now() - a); }
    for (let i = 0; i < 8; i++) { const a = performance.now(); sm.render(); r2.push(performance.now() - a); }
    r1.sort((a, b) => a - b); r2.sort((a, b) => a - b);
    OUT.renderFirst = +r1[4].toFixed(2);
    OUT.renderSecond = +r2[4].toFixed(2);
    // ── 交互（自动河在场）────────────────────────────────────────────────
    J.stage = 'auto-interactions';
    OUT.interactions = {};
    sm.setTool('select');
    await tick(120);
    { let i = 0; OUT.interactions.hover_select = await frameStats(1500, () => { i++; const r = R(); const t = performance.now(); cvs.dispatchEvent(mk('mousemove', 60 + (i * 7) % Math.max(40, r.width - 120), 60 + (i * 11) % Math.max(40, r.height - 120))); return performance.now() - t; }); }
    J.stage = 'auto-interactions:pan';
    sm.setTool('pan');
    await tick(120);
    { const r = R(); cvs.dispatchEvent(mk('mousedown', r.width / 2, r.height / 2)); await tick(40); let i = 0; OUT.interactions.pan = await frameStats(1500, () => { i++; const t = performance.now(); cvs.dispatchEvent(mk('mousemove', r.width / 2 + (i % 30), r.height / 2 + (i % 20))); return performance.now() - t; }); cvs.dispatchEvent(mk('mouseup', r.width / 2, r.height / 2)); }
    J.stage = 'auto-interactions:river-trace';
    sm.setTool('river');
    await tick(150);
    { const r = R(); cvs.dispatchEvent(mk('mousedown', 120, 120)); await tick(60); let i = 0; OUT.interactions.river_trace = await frameStats(1800, () => { i++; const t = performance.now(); cvs.dispatchEvent(mk('mousemove', (120 + i * 3) % (r.width - 40), (120 + Math.sin(i / 6) * 40 + 400) % (r.height - 40))); return performance.now() - t; }); cvs.dispatchEvent(mk('mouseup', 200, 160)); await tick(400); }
    J.stage = 'auto-interactions:prov-draw';
    sm.setTool('draw');
    await tick(150);
    { const r = R(); const cx = r.width * 0.35, cy = r.height * 0.45, Rr = Math.min(r.width, r.height) * 0.12; cvs.dispatchEvent(mk('mousedown', cx + Rr, cy)); await tick(60); let i = 0; OUT.interactions.prov_draw = await frameStats(1800, () => { i++; const a = (i / 40) * Math.PI * 2; const t = performance.now(); cvs.dispatchEvent(mk('mousemove', cx + Math.cos(a) * Rr, cy + Math.sin(a) * Rr)); return performance.now() - t; }); OUT.interactions.freeTracePts = (sm.freeTrace || []).length; J.stage = 'auto-interactions:prov-land'; const t0b = performance.now(); try { cvs.dispatchEvent(mk('mouseup', cx + Rr, cy)); } catch (e) { J.fails.push('land: ' + String(e).slice(0, 200)); } OUT.interactions.prov_land_ms = +(performance.now() - t0b).toFixed(1); }
    sm.setTool('select');
    J.stage = 'done';
  } catch (e) {
    J.fails.push('probe: ' + String((e && e.stack) || e).slice(0, 500));
    J.stage = 'done';
  }
})();
'kicked'
