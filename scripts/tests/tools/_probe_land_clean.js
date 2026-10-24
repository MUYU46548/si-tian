// 探针（1-b · 第五刀：把"松手"从"保存后的 GC 余波"里剥出来量，2026-10-24）。
// 两个问题：① 松手那一下（不含防抖落盘）到底多少毫秒；② 一次松手重绘了几遍（同步 render + deep watch）。
// 做法：每次松手后立刻把项目 dirty 清掉（= 让 800ms 防抖保存不触发），这样相邻样本之间没有
//       3.6MB 字符串/解析分配，读数就是手势本身；另用 clearRect 计数数"重绘了几遍"。
// 由 `_probe_jank_real.py _probe_land_clean.js __CLEAN` 驱动。只测量，不改产品代码。
window.__CLEAN = { stage: 'boot', out: {}, fails: [] };
window.confirm = () => true;
window.alert = () => {};
(async () => {
  const J = window.__CLEAN;
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
  const NAME = '净测底图';
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

  // 重绘计数：数 clearRect（每遍 renderFrame 都会清一次）
  let clears = 0;
  const c2d = sm.canvas.getContext('2d');
  const origClear = c2d.clearRect.bind(c2d);
  c2d.clearRect = (...a) => { clears += 1; return origClear(...a); };

  const ev = (t, x, y) => new MouseEvent(t, {
    clientX: b.left + x, clientY: b.top + y, button: 0,
    buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true,
  });
  const shape = (cx, cy, rr, n) => {
    sm.canvas.dispatchEvent(ev('mousedown', cx + rr, cy));
    const pts = [];
    for (let i = 1; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const p = { x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr };
      pts.push(p);
      sm.canvas.dispatchEvent(ev('mousemove', p.x, p.y));
    }
    return pts;
  };

  J.stage = 'clean-land';
  {
    const rows = [];
    const counts = [];
    for (let k = 0; k < 5; k++) {
      const cx = b.width * (0.28 + k * 0.09), cy = b.height * 0.52;
      const rr = Math.min(b.width, b.height) * 0.06;
      sm.setTool('draw');
      shape(cx, cy, rr, 50);
      await tick(500);                       // 让预览帧收一收
      ps.dirty = false;                      // 防抖保存不触发（下一次 syncFromCanvas 会重新置 true）
      clears = 0;
      const t0 = performance.now();
      sm.canvas.dispatchEvent(ev('mouseup', cx + rr, cy));
      const landMs = performance.now() - t0;
      const clearsAtReturn = clears;
      await tick(400);                       // 等这一帧的 watcher 重绘跑完
      ps.dirty = false;
      rows.push(+landMs.toFixed(1));
      counts.push({ sync: clearsAtReturn, total: clears });
      await tick(300);
    }
    rows.sort((a, b2) => a - b2);
    OUT.land_clean = { all: rows, p50: rows[Math.floor(rows.length / 2)] };
    OUT.render_passes = counts;
  }

  // 落盘那一段（真实触发一次防抖保存，量整段 + 长任务）
  J.stage = 'save-tick';
  {
    const tasks = [];
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) tasks.push(+e.duration.toFixed(1));
      });
      po.observe({ entryTypes: ['longtask'] });
    } catch (e) { /* ignore */ }
    const before = tasks.length;
    const cx = b.width * 0.4, cy = b.height * 0.62;
    const rr = Math.min(b.width, b.height) * 0.06;
    sm.setTool('draw');
    shape(cx, cy, rr, 50);
    await tick(300);
    const t0 = performance.now();
    sm.canvas.dispatchEvent(ev('mouseup', cx + rr, cy));
    const landMs = +(performance.now() - t0).toFixed(1);
    const t1 = performance.now();
    await tick(2500);                        // 800ms 防抖 + 落盘
    OUT.save_tick = {
      landMs, waitMs: +(performance.now() - t1).toFixed(1),
      longtasks: tasks.slice(before),
      savedCount: (window.__savedProject || []).length,
      dirty: ps.dirty,
      status: ps.saveStatus,
    };
  }

  J.stage = 'done';
})().catch((e) => {
  window.__CLEAN.fails.push('probe: ' + String((e && e.stack) || e).slice(0, 600));
  window.__CLEAN.stage = 'done';
});
'kicked'
