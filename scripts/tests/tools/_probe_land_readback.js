// 探针（1-b · 读盘判据，2026-10-24）：保存 → **重开** → 数据真变（不是"内存里变了"）。
// harness 的 projectSave 会把载荷过 `structuredClone`（模拟 V8 边界）再存进 `window.__projects`，
// projectOpen 从那里读回来 —— 所以"关闭项目 → 重开"读到的就是**过 IPC 的那一份**。
// 由 `_probe_jank_real.py _probe_land_readback.js __RB` 驱动。只测量，不改产品代码。
window.__RB = { stage: 'boot', out: {}, fails: [] };
window.confirm = () => true;
window.alert = () => {};
(async () => {
  const J = window.__RB;
  const OUT = J.out;
  const app = document.querySelector('#app').__vue_app__;
  const s = app._instance.setupState.store;
  const pinia = app.config.globalProperties.$pinia;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));
  const sc = () => document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const { useProjectStore } = await import('/src/store/projectStore.js');
  const ps = useProjectStore(pinia);
  const filePath = ps.filePath;

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
  const NAME = '读盘底图';
  s.importFromScenariosJson(AP.buildScenariosJson(AP.parseMapFile(text), NAME, '当前'));
  await tick(2200);
  let sm = sc();
  sm.baseMapKey = NAME;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await tick(900);
  if (typeof sm.fitToView === 'function') sm.fitToView();
  await tick(400);

  // 造两处改动：① 建一个省（几何）② 给这个省一个明显不同的名字 + 一个剧本归属字段
  J.stage = 'mutate';
  const b = sm.canvas.getBoundingClientRect();
  const cx = b.width * 0.4, cy = b.height * 0.5, rr = Math.min(b.width, b.height) * 0.08;
  const ev = (t, x, y) => new MouseEvent(t, {
    clientX: b.left + x, clientY: b.top + y, button: 0,
    buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true,
  });
  const before = (s.baseMaps[NAME].terrain || []).length;
  sm.setTool('draw');
  sm.canvas.dispatchEvent(ev('mousedown', cx + rr, cy));
  for (let i = 1; i <= 50; i++) {
    const a = (i / 50) * Math.PI * 2;
    sm.canvas.dispatchEvent(ev('mousemove', cx + Math.cos(a) * rr, cy + Math.sin(a) * rr));
  }
  await tick(200);
  const tUp = performance.now();
  sm.canvas.dispatchEvent(ev('mouseup', cx + rr, cy));
  OUT.landMs = +(performance.now() - tUp).toFixed(1);
  await tick(400);
  const after = (s.baseMaps[NAME].terrain || []).length;
  const created = (s.baseMaps[NAME].terrain || [])[after - 1] || null;
  OUT.created = { before, after, id: created && created.id, name: created && created.name, points: created && (created.points || []).length };
  if (!created || after === before) { J.fails.push('这一笔没建出省（读盘判据无从谈起）'); }

  // 改一个显眼的字段（走产品写口：renameProvince 若存在就用它，否则直接 store 改名）
  const stamp = 'READBACK-' + Date.now();
  if (created) {
    if (typeof s.renameProvince === 'function') s.renameProvince(NAME, created.id, stamp);
    else if (typeof s.updateBaseProvince === 'function') s.updateBaseProvince(NAME, created.id, { name: stamp });
    else { created.name = stamp; s.saveScenarios(); }
  }
  await tick(1600);        // 800ms 防抖落盘
  OUT.savedCount = (window.__savedProject || []).length;
  {
    const last = (window.__savedProject || []).slice(-1)[0] || null;
    const p = last && last.project;
    const bm = p && p.scenarios && p.scenarios.baseMaps && p.scenarios.baseMaps[NAME];
    const savedProv = bm && (bm.terrain || []).find((x) => x && x.id === (created && created.id));
    OUT.inPayload = {
      provinces: bm ? (bm.terrain || []).length : -1,
      found: !!savedProv,
      name: savedProv && savedProv.name,
      named: !!(savedProv && savedProv.name === stamp),
      payloadBytes: p ? JSON.stringify(p).length : -1,
      // 载荷里不能有代理/不可序列化物：能 JSON 往返就说明是纯值
      jsonRoundTripOk: (() => { try { return JSON.stringify(JSON.parse(JSON.stringify(p))) === JSON.stringify(p); } catch (e) { return false; } })(),
    };
  }

  // 落盘状态（诚实口径）
  OUT.status = { dirty: ps.dirty, saveStatus: ps.saveStatus, error: ps.lastError || '' };

  // ── 重开：close（会先 flush）→ open ──────────────────────────────────────
  J.stage = 'reopen';
  const closed = await ps.closeProject();
  OUT.close = { ok: !!(closed && closed.success), saved: !!(closed && closed.saved) };
  await tick(400);
  const opened = await ps.openProject(filePath);
  OUT.reopen = { ok: !!(opened && opened.success), error: (opened && opened.error) || '' };
  await tick(900);
  // 重开之后画布从项目文件装回来（applyProjectToCanvas），直接读 store
  const bm2 = s.baseMaps[NAME];
  const reProv = bm2 && (bm2.terrain || []).find((x) => x && x.id === (created && created.id));
  OUT.afterReopen = {
    source: s.canvasSource,
    provinces: bm2 ? (bm2.terrain || []).length : -1,
    found: !!reProv,
    name: reProv && reProv.name,
    named: !!(reProv && reProv.name === stamp),
    points: reProv && (reProv.points || []).length,
    // 决定性判据：重开后的省 = 建出来的那个（名字与点数都对得上）
  };
  if (!OUT.afterReopen.named) J.fails.push('读盘判据失败：重开之后没有那个改动（' + OUT.afterReopen.name + '）');

  J.stage = 'done';
})().catch((e) => {
  window.__RB.fails.push('probe: ' + String((e && e.stack) || e).slice(0, 600));
  window.__RB.stage = 'done';
});
'kicked'
