// 探针（2026-10-24 · 落盘 tick 归因）：`saveProject` 那一段现在还剩什么。
// 由 `_probe_jank_real.py _probe_save_tick.js __ST` 驱动。只测量，不改产品代码。
window.__ST = { stage: 'boot', out: {}, fails: [] };
window.confirm = () => true;
(async () => {
  const J = window.__ST;
  const OUT = J.out;
  const app = document.querySelector('#app').__vue_app__;
  const s = app._instance.setupState.store;
  const pinia = app.config.globalProperties.$pinia;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 90 : ms));
  const sc = () => document.querySelector('.scenario-map-container').__vueParentComponent.setupState;

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
  const PS = await import('/src/utils/projectSchema.js');
  const NAME = '落盘底图';
  s.importFromScenariosJson(AP.buildScenariosJson(AP.parseMapFile(text), NAME, '当前'));
  await tick(2200);
  const sm = sc();
  sm.baseMapKey = NAME;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await tick(900);
  const { useProjectStore } = await import('/src/store/projectStore.js');
  const ps = useProjectStore(pinia);

  const bench = (fn, n) => {
    const arr = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      try { fn(i); } catch (e) { J.fails.push('bench: ' + String(e).slice(0, 160)); }
      arr.push(performance.now() - t0);
    }
    arr.sort((a, b) => a - b);
    return { p50: +arr[Math.floor(arr.length / 2)].toFixed(1), max: +arr[arr.length - 1].toFixed(1) };
  };

  J.stage = 'parts';
  const payload = s.exportCanvasToProject();
  const merged = { ...ps.project };
  OUT.parts = {
    export: bench(() => s.exportCanvasToProject(), 3),
    pushSnapshot: bench(() => PS.pushSnapshot(ps.project, { label: 'probe' }), 2),
    toIpcJson: bench(() => PS.toIpcJson(merged), 3),
    // mock 的 projectSave（含 JSON.parse 3.6MB / 写 mock 库）——生产里换成"主进程直接写盘"
    mockSave: null,
  };
  {
    const json = PS.toIpcJson(merged);
    const arr = [];
    for (let i = 0; i < 2; i++) {
      const t0 = performance.now();
      await window.sitianAPI.projectSave({ filePath: 'probe/save-tick.sitian', projectJson: json });
      arr.push(performance.now() - t0);
    }
    arr.sort((a, b) => a - b);
    OUT.parts.mockSave = { p50: +arr[Math.floor(arr.length / 2)].toFixed(1), max: +arr[arr.length - 1].toFixed(1) };
    delete (window.__projects || {})['probe/save-tick.sitian'];
    OUT.jsonBytes = json.length;
  }

  J.stage = 'full';
  {
    const arr = [];
    for (let i = 0; i < 2; i++) {
      await tick(400);
      ps.dirty = true;
      const t0 = performance.now();
      await ps.saveProject({ label: 'probe' });
      arr.push(performance.now() - t0);
      await tick(400);
    }
    arr.sort((a, b) => a - b);
    OUT.full = { p50: +arr[Math.floor(arr.length / 2)].toFixed(1), max: +arr[arr.length - 1].toFixed(1) };
  }

  // 长任务：落盘那一下主线程被占多久（用户真正感觉到的是这个）
  J.stage = 'longtask';
  {
    const tasks = [];
    const po = new PerformanceObserver((list) => { for (const e of list.getEntries()) tasks.push(+e.duration.toFixed(1)); });
    po.observe({ entryTypes: ['longtask'] });
    await tick(300);
    const before = tasks.length;
    ps.dirty = true;
    await ps.saveProject({ label: 'longtask' });
    await tick(600);
    OUT.longtasks = tasks.slice(before);
  }

  J.stage = 'done';
})().catch((e) => {
  window.__ST.fails.push('probe: ' + String((e && e.stack) || e).slice(0, 600));
  window.__ST.stage = 'done';
});
'kicked'
