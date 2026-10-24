// 探针（第 1 件 1-b · 松手 370ms 归因，2026-10-24）：把松手那条链按段拆开，找出"未归因"的 188ms。
// 由 `_probe_jank_real.py _probe_land_breakdown.js __BREAK` 驱动。
// 只测量、不改产品代码；数据落在 harness mock 项目里（不碰 415 孤本）。
window.__BREAK = { stage: 'boot', out: {}, fails: [] };
window.confirm = () => true;
window.alert = () => {};
(async () => {
  const J = window.__BREAK;
  const OUT = J.out;
  const app = document.querySelector('#app').__vue_app__;
  const s = app._instance.setupState.store;
  const pinia = app.config.globalProperties.$pinia;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));
  const sc = () => document.querySelector('.scenario-map-container').__vueParentComponent.setupState;

  const bench = (label, fn, n) => {
    const arr = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      try { fn(i); } catch (e) { J.fails.push(label + ': ' + String(e).slice(0, 200)); }
      arr.push(performance.now() - t0);
    }
    arr.sort((a, b) => a - b);
    return { n, p50: +arr[Math.floor(arr.length / 2)].toFixed(1), max: +arr[arr.length - 1].toFixed(1) };
  };
  const benchAsync = async (label, fn, n) => {
    const arr = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      try { await fn(i); } catch (e) { J.fails.push(label + ': ' + String(e).slice(0, 200)); }
      arr.push(performance.now() - t0);
    }
    arr.sort((a, b) => a - b);
    return { n, p50: +arr[Math.floor(arr.length / 2)].toFixed(1), max: +arr[arr.length - 1].toFixed(1) };
  };

  J.stage = 'import';
  let text = null;
  for (const url of ['/__real_desite.map', '/docs/mockups/desite.map']) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const t = await r.text();
      if (t.length < 1000000 || !t.includes('feature')) continue;
      text = t; break;
    } catch (e) { /* next */ }
  }
  if (!text) throw new Error('拿不到 desite.map');
  const AP = await import('/src/utils/azgaar-parser.js');
  const NAME = '归因底图';
  s.importFromScenariosJson(AP.buildScenariosJson(AP.parseMapFile(text), NAME, '当前'));
  await tick(2200);
  let sm = sc();
  sm.baseMapKey = NAME;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await tick(900);
  if (typeof sm.fitToView === 'function') sm.fitToView();
  if (!sm.editMode && typeof sm.enterEditMode === 'function') sm.enterEditMode();
  await tick(500);

  const b = sm.canvas.getBoundingClientRect();
  const bm = s.baseMaps[NAME];
  OUT.data = {
    provinces: (bm.terrain || []).length,
    canvas: { w: Math.round(b.width), h: Math.round(b.height) },
    source: s.canvasSource,
    projectEntities: Object.keys((await import('/src/store/projectStore.js')).useProjectStore(pinia).project?.entities || {}).length,
  };

  // 载荷各容器的体积（clone 成本的来源）
  {
    const p = s.exportCanvasToProject();
    const sz = (v) => { try { return (JSON.stringify(v, (k, x) => x) || '').length; } catch (e) { return -1; } };
    OUT.sizes = {
      payload: sz(p),
      entities: sz(p.entities),
      hyperlanes: sz(p.hyperlanes),
      mapData: sz(p.maps && p.maps.mapData),
      editor: sz(p.maps && p.maps.editor),
      baseMaps: sz(p.scenarios && p.scenarios.baseMaps),
      scenarios: sz(p.scenarios && p.scenarios.scenarios),
      slicePoints: sz(p.scenarios && p.scenarios.slicePoints),
    };
  }

  // ── ① 各段单独计时 ──────────────────────────────────────────────────────
  J.stage = 'parts';
  OUT.export = bench('exportCanvasToProject', () => s.exportCanvasToProject(), 5);
  OUT.sync = bench('syncCanvasToProject', () => s.syncCanvasToProject('探针'), 5);
  OUT.merge_only = +(OUT.sync.p50 - OUT.export.p50).toFixed(1);
  const payload = s.exportCanvasToProject();
  OUT.stringify = bench('JSON.stringify(payload)', () => JSON.stringify(payload), 5);
  OUT.parse = bench('JSON.parse', () => JSON.parse(JSON.stringify(payload)), 5);
  OUT.save_scenarios = bench('saveScenarios', () => s.saveScenarios(), 5);
  OUT.add_province_no_gate = bench('addBaseProvince(no gate)', (i) => s.addBaseProvince(NAME, {
    id: '__probe_break_' + i, name: '探针' + i, kind: 'land',
    points: [{ x: 50000 + i * 10, y: 50000 }, { x: 50100 + i * 10, y: 50000 }, { x: 50100 + i * 10, y: 50100 }, { x: 50000 + i * 10, y: 50100 }],
  }, { checkOverlap: false }), 5);
  OUT.add_province_with_gate = bench('addBaseProvince(gate)', (i) => s.addBaseProvince(NAME, {
    id: '__probe_breakg_' + i, name: '探针g' + i, kind: 'land',
    points: [{ x: 70000 + i * 10, y: 70000 }, { x: 70100 + i * 10, y: 70000 }, { x: 70100 + i * 10, y: 70100 }, { x: 70000 + i * 10, y: 70100 }],
  }), 5);
  OUT.overlap_gate_only = +(OUT.add_province_with_gate.p50 - OUT.add_province_no_gate.p50).toFixed(1);
  if (typeof sm.render === 'function') OUT.render = bench('render()', () => sm.render(), 5);
  if (typeof sm.freeTraceRing === 'function') {
    const mk = (dx) => {
      const cx = b.width * 0.5 + dx, cy = b.height * 0.5, rr = Math.min(b.width, b.height) * 0.16;
      const out = [];
      for (let i = 0; i < 1788; i++) { const a = (i / 1788) * Math.PI * 2; out.push(sm.screenToWorld(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.7)); }
      return out;
    };
    OUT.trace_ring = bench('freeTraceRing', () => sm.freeTraceRing(mk(0), { snap: true }), 3);
  }

  // ── ② 松手整条（真实鼠标事件，3 次取 p50）───────────────────────────────
  J.stage = 'land';
  {
    const ups = [];
    for (let k = 0; k < 3; k++) {
      const cx = b.width * (0.32 + k * 0.12), cy = b.height * 0.5;
      const rr = Math.min(b.width, b.height) * 0.09;
      const ev = (t, x, y) => new MouseEvent(t, {
        clientX: b.left + x, clientY: b.top + y, button: 0,
        buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true,
      });
      sm.setTool('draw');
      sm.canvas.dispatchEvent(ev('mousedown', cx + rr, cy));
      for (let i = 1; i <= 50; i++) {
        const a = (i / 50) * Math.PI * 2;
        sm.canvas.dispatchEvent(ev('mousemove', cx + Math.cos(a) * rr, cy + Math.sin(a) * rr));
      }
      await tick(120);
      const t0 = performance.now();
      sm.canvas.dispatchEvent(ev('mouseup', cx + rr, cy));
      ups.push(performance.now() - t0);
      await tick(900);
    }
    ups.sort((a, b) => a - b);
    OUT.land_ms = { n: ups.length, p50: +ups[Math.floor(ups.length / 2)].toFixed(1), max: +ups[ups.length - 1].toFixed(1) };
  }

  // ── ③ 落盘那一段（800ms 防抖之后真正写盘）────────────────────────────────
  J.stage = 'save';
  {
    const { useProjectStore } = await import('/src/store/projectStore.js');
    const ps = useProjectStore(pinia);
    OUT.save_project = await benchAsync('saveProject', () => ps.saveProject({ label: '探针' }), 2);
    OUT.saveStatus = { dirty: ps.dirty, status: ps.saveStatus, bytes: ps.lastSavedBytes || null };
  }

  J.stage = 'done';
})().catch((e) => {
  window.__BREAK.fails.push('probe: ' + String((e && e.stack) || e).slice(0, 600));
  window.__BREAK.stage = 'done';
});
'kicked'
