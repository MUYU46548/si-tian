// 探针（第 1 件基线 · 抬手落库归因，2026-10-23）：自由绘制**松手那一下 421ms** 花在哪。
// 由 `_probe_jank_real.py _probe_land_cost.js __LAND` 驱动。
// 只测量、不改产品代码；数据落在 harness mock 项目里（不碰 415 孤本）。
window.__LAND = { stage: 'boot', out: {}, fails: [] };
window.confirm = () => true;
window.alert = () => {};
(async () => {
  const J = window.__LAND;
  const OUT = J.out;
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));
  const sc = () => document.querySelector('.scenario-map-container').__vueParentComponent.setupState;

  const bench = (label, fn, n) => {
    const arr = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      try { fn(i); } catch (e) { J.fails.push(label + ': ' + String(e).slice(0, 160)); }
      arr.push(performance.now() - t0);
    }
    arr.sort((a, b) => a - b);
    return { n, avg: +(arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length)).toFixed(1),
      p50: +arr[Math.floor(arr.length / 2)].toFixed(1), max: +arr[arr.length - 1].toFixed(1) };
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
  const NAME = '落库底图';
  s.importFromScenariosJson(AP.buildScenariosJson(AP.parseMapFile(text), NAME, '当前'));
  await tick(2200);
  let sm = sc();
  sm.baseMapKey = NAME;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await tick(900);
  if (typeof sm.fitToView === 'function') sm.fitToView();
  await tick(400);

  const b = sm.canvas.getBoundingClientRect();
  OUT.data = { provinces: (s.baseMaps[NAME].terrain || []).length, canvas: { w: Math.round(b.width), h: Math.round(b.height) } };

  // 造一条与真实拖笔同规模的手迹（1788 点 = 30s × 60fps 的采样量级）
  const makeTrace = (dx) => {
    const cx = b.width * 0.5 + dx, cy = b.height * 0.5;
    const rr = Math.min(b.width, b.height) * 0.16;
    const out = [];
    for (let i = 0; i < 1788; i++) {
      const a = (i / 1788) * Math.PI * 2;
      out.push(sm.screenToWorld(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.7));
    }
    return out;
  };

  // ── ① 各段单独计时 ──────────────────────────────────────────────────────
  J.stage = 'parts';
  OUT.trace_ring = bench('freeTraceRing', () => sm.freeTraceRing(makeTrace(0), { snap: true }), 3);
  OUT.export_payload = bench('exportCanvasToProject', () => s.exportCanvasToProject(), 3);
  let payload = s.exportCanvasToProject();
  OUT.stringify = bench('JSON.stringify', () => JSON.stringify(payload), 3);
  OUT.save_scenarios = bench('saveScenarios', () => s.saveScenarios(), 3);
  OUT.add_province_no_gate = bench('addBaseProvince(no gate)', (i) => s.addBaseProvince(NAME, {
    id: '__probe_land_' + i, name: '探针' + i, kind: 'land',
    points: [{ x: 50000 + i * 10, y: 50000 }, { x: 50100 + i * 10, y: 50000 }, { x: 50100 + i * 10, y: 50100 }, { x: 50000 + i * 10, y: 50100 }],
  }, { checkOverlap: false }), 3);

  // ── ② 整条路：commitFreeTrace（与鼠标松手走同一个函数）────────────────────
  J.stage = 'commit';
  const n0 = (s.baseMaps[NAME].terrain || []).length;
  OUT.commit_free_trace = bench('commitFreeTrace', (i) => sm.commitFreeTrace(makeTrace(i * 40), false), 3);
  await tick(600);
  OUT.commit_created = (s.baseMaps[NAME].terrain || []).length - n0;

  // ── ③ 落库后一次"完整保存"（IPC 气体）：由 saveScenarios 触发，量同步段 ────
  J.stage = 'save_after';
  OUT.save_after_commit = bench('saveScenarios(after)', () => s.saveScenarios(), 2);

  J.stage = 'done';
})().catch((e) => {
  window.__LAND.fails.push('probe: ' + String((e && e.stack) || e).slice(0, 600));
  window.__LAND.stage = 'done';
});
'kicked'
