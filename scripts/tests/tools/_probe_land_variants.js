// 探针（1-b · 方案对拍，2026-10-24）：三种"载荷构造"写法的净成本，用来选实现、不靠猜。
//   A. 现状：6 个容器各自 JSON 往返（在 Vue 代理上读）
//   B. 单次往返：容器先 toRaw，整体 JSON 往返一次
//   C. 零拷贝：容器 toRaw + 浅拷贝外壳，值直传（只量成本，不改产品）
// 由 `_probe_jank_real.py _probe_land_variants.js __VAR` 驱动。
window.__VAR = { stage: 'boot', out: {}, fails: [] };
window.confirm = () => true;
window.alert = () => {};
(async () => {
  const J = window.__VAR;
  const OUT = J.out;
  const app = document.querySelector('#app').__vue_app__;
  const s = app._instance.setupState.store;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));
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
  const NAME = '对拍底图';
  s.importFromScenariosJson(AP.buildScenariosJson(AP.parseMapFile(text), NAME, '当前'));
  await tick(2200);
  let sm = sc();
  sm.baseMapKey = NAME;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await tick(900);
  if (typeof sm.fitToView === 'function') sm.fitToView();
  await tick(400);

  // toRaw（Vite 预打包的 vue）
  let toRaw = (x) => x;
  {
    const hit = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\/deps\/vue\.js/.test(n));
    if (hit) { const V = await import(hit); if (typeof V.toRaw === 'function') toRaw = V.toRaw; }
  }
  const RE = PS.jsonSafeReplacer;
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

  J.stage = 'variants';
  const se = () => s.scenarioEditingModule || null;
  const containers = () => ({
    hyperlanes: s.hyperlanes,
    mapData: s.mapData,
    editor: {},
    baseMaps: s.baseMaps,
    scenarios: s.scenarios,
    slicePoints: [],
  });

  // A = 现状（geodata.buildProjectPayload 的同形写法）
  OUT.A_current = bench((i) => {
    const c = containers();
    JSON.parse(JSON.stringify(c.hyperlanes || []));
    JSON.parse(JSON.stringify(c.mapData || {}, RE));
    JSON.parse(JSON.stringify(c.editor || {}, RE));
    JSON.parse(JSON.stringify(c.baseMaps || {}, RE));
    JSON.parse(JSON.stringify(c.scenarios || {}, RE));
    JSON.parse(JSON.stringify(c.slicePoints || []));
  }, 4);

  // B = 单次往返（toRaw + 一次 stringify/parse）
  OUT.B_single = bench((i) => {
    const c = containers();
    const shape = {
      hyperlanes: toRaw(c.hyperlanes) || [],
      maps: { mapData: toRaw(c.mapData) || {}, editor: toRaw(c.editor) || {} },
      scenarios: { version: 2, baseMaps: toRaw(c.baseMaps) || {}, scenarios: toRaw(c.scenarios) || {}, slicePoints: toRaw(c.slicePoints) || [] },
    };
    JSON.parse(JSON.stringify(shape, RE));
  }, 4);

  // B2 = 单次往返但**不 toRaw**（验证"钱确实在代理读上"）
  OUT.B2_single_noraw = bench((i) => {
    const c = containers();
    const shape = {
      hyperlanes: c.hyperlanes || [],
      maps: { mapData: c.mapData || {}, editor: c.editor || {} },
      scenarios: { version: 2, baseMaps: c.baseMaps || {}, scenarios: c.scenarios || {}, slicePoints: c.slicePoints || [] },
    };
    JSON.parse(JSON.stringify(shape, RE));
  }, 3);

  // C = 零拷贝（只浅拷贝外壳）
  OUT.C_zero = bench((i) => {
    const c = containers();
    return {
      hyperlanes: (toRaw(c.hyperlanes) || []).map((h) => ({ ...h })),
      maps: { mapData: { ...(toRaw(c.mapData) || {}) }, editor: { ...(toRaw(c.editor) || {}) } },
      scenarios: { version: 2, baseMaps: { ...(toRaw(c.baseMaps) || {}) }, scenarios: { ...(toRaw(c.scenarios) || {}) }, slicePoints: [...(toRaw(c.slicePoints) || [])] },
    };
  }, 4);

  // D = 现状在项目侧落盘的两笔（toIpcPlain / pushSnapshot），raw vs 代理
  J.stage = 'save-side';
  {
    const { useProjectStore } = await import('/src/store/projectStore.js');
    const ps = useProjectStore(app.config.globalProperties.$pinia);
    OUT.save_side = {
      toIpcPlain_proxy: bench(() => PS.toIpcPlain(ps.project), 2),
      toIpcPlain_raw: bench(() => PS.toIpcPlain(toRaw(ps.project)), 2),
      pushSnapshot_proxy: bench(() => PS.pushSnapshot(ps.project, { label: '探针' }), 2),
      pushSnapshot_raw: bench(() => PS.pushSnapshot(toRaw(ps.project), { label: '探针' }), 2),
    };
    OUT.snapBytes = PS.snapshotBytes(ps.project.snapshots || []);
    OUT.projectBytes = JSON.stringify(PS.toIpcPlain(ps.project)).length;
  }

  J.stage = 'done';
})().catch((e) => {
  window.__VAR.fails.push('probe: ' + String((e && e.stack) || e).slice(0, 600));
  window.__VAR.stage = 'done';
});
'kicked'
