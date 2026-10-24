// 探针（1-b · 第六刀：把"画布→项目"这条接线整个架空，看松手还剩多少，2026-10-24）。
// 假设：松手那一下剩的钱不在 export（已降到 1.3ms），而在保存顺带触发的
//   project.value 替换 → watch(entities, {flush:'sync'}) → refreshEntitiesFromProject
//   → nodes.value 换数组 → 画布跟着重绘（探针 5 数到一次松手重绘 3~4 遍）。
// 做法：把 canvasBridge 的 project sink 临时换成空实现（只测量；测完还原），其余一切照旧。
// 由 `_probe_jank_real.py _probe_land_sinkoff.js __SINK` 驱动。
window.__SINK = { stage: 'boot', out: {}, fails: [] };
window.confirm = () => true;
window.alert = () => {};
(async () => {
  const J = window.__SINK;
  const OUT = J.out;
  const app = document.querySelector('#app').__vue_app__;
  const s = app._instance.setupState.store;
  const pinia = app.config.globalProperties.$pinia;
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
  const CB = await import('/src/store/canvasBridge.js');
  const NAME = '架空底图';
  s.importFromScenariosJson(AP.buildScenariosJson(AP.parseMapFile(text), NAME, '当前'));
  await tick(2200);
  let sm = sc();
  sm.baseMapKey = NAME;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await tick(900);
  if (typeof sm.fitToView === 'function') sm.fitToView();
  if (!sm.editMode && typeof sm.enterEditMode === 'function') sm.enterEditMode();
  await tick(600);
  const { useProjectStore } = await import('/src/store/projectStore.js');
  const ps = useProjectStore(pinia);
  const b = sm.canvas.getBoundingClientRect();

  // 重绘计数（clearRect）
  let clears = 0;
  const c2d = sm.canvas.getContext('2d');
  const origClear = c2d.clearRect.bind(c2d);
  c2d.clearRect = (...a) => { clears += 1; return origClear(...a); };

  const ev = (t, x, y) => new MouseEvent(t, {
    clientX: b.left + x, clientY: b.top + y, button: 0,
    buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true,
  });
  const drag = (cx, cy, rr, n) => {
    sm.canvas.dispatchEvent(ev('mousedown', cx + rr, cy));
    for (let i = 1; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      sm.canvas.dispatchEvent(ev('mousemove', cx + Math.cos(a) * rr, cy + Math.sin(a) * rr));
    }
  };
  const phase = async (label, n) => {
    const rows = [];
    const cl = [];
    for (let k = 0; k < n; k++) {
      const cx = b.width * (0.26 + k * 0.075), cy = b.height * 0.5;
      const rr = Math.min(b.width, b.height) * 0.055;
      sm.setTool('draw');
      drag(cx, cy, rr, 50);
      await tick(500);
      ps.dirty = false;
      clears = 0;
      const t0 = performance.now();
      sm.canvas.dispatchEvent(ev('mouseup', cx + rr, cy));
      const ms = performance.now() - t0;
      const atReturn = clears;
      await tick(500);
      ps.dirty = false;
      rows.push(+ms.toFixed(1));
      cl.push({ sync: atReturn, total: clears });
      await tick(300);
    }
    rows.sort((a, b2) => a - b2);
    return { label, all: rows, p50: rows[Math.floor(rows.length / 2)], clears: cl };
  };

  J.stage = 'sink-on';
  OUT.sink_on = await phase('真实 sink', 5);

  J.stage = 'sink-off';
  // 只测量：把「画布 → 项目」入水口换成空实现（不写 project.value、不触发 watch 链）
  CB.setProjectSink({ syncFromCanvas: () => ({ success: true, probe: 'sink-off' }) });
  OUT.sink_off = await phase('sink 架空', 5);

  // 还原：projectStore 注册的入水口是 syncFromCanvas（同名函数，重新注册一次即可）
  J.stage = 'restore';
  {
    const M = await import('/src/store/projectStore.js');
    // 用 store 里真实存在的入水口还原：projectStore 在 setup 时注册过一次，
    // 这里拿不到闭包 → 用「打开项目」同一条路重新注册不现实；改为直接调 ps 的公开 API 验证是否还通。
    OUT.restore_note = 'sink 已架空（探针结束自动丢弃，页面会重载）';
    OUT.ps_has_sync = typeof M.useProjectStore(pinia).syncFromCanvas;
  }

  J.stage = 'done';
})().catch((e) => {
  window.__SINK.fails.push('probe: ' + String((e && e.stack) || e).slice(0, 600));
  window.__SINK.stage = 'done';
});
'kicked'
