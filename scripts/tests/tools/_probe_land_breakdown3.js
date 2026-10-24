// 探针（第 1 件 1-b · 第三刀：**消融实验**，2026-10-24）。
// 目的：把「松手 287ms」里"深拷贝占多少"用一个不靠拆段的办法量出来 ——
// 临时把 JSON.stringify/parse 的打桩，让 buildProjectPayload 的 6 次深拷贝空转（消融），
// 其余一切照旧，再量同一个 mouseup。差值 = 深拷贝在松手里的净成本；余量 = 还要修的别的。
// 打桩只活在本次测量里（测完立刻还原），产品代码一行不改。
// 由 `_probe_jank_real.py _probe_land_breakdown3.js __BREAK3` 驱动。
window.__BREAK3 = { stage: 'boot', out: {}, fails: [] };
window.confirm = () => true;
window.alert = () => {};
(async () => {
  const J = window.__BREAK3;
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
  const NAME = '消融底图';
  s.importFromScenariosJson(AP.buildScenariosJson(AP.parseMapFile(text), NAME, '当前'));
  await tick(2200);
  let sm = sc();
  sm.baseMapKey = NAME;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await tick(900);
  if (typeof sm.fitToView === 'function') sm.fitToView();
  if (!sm.editMode && typeof sm.enterEditMode === 'function') sm.enterEditMode();
  await tick(600);
  const b = sm.canvas.getBoundingClientRect();

  // toRaw：从 Vite 预打包的 vue 里拿（能拿到才量得出"代理读"的净成本）
  let toRaw = (x) => x;
  try {
    const hit = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\/deps\/vue\.js/.test(n));
    if (hit) {
      const V = await import(hit);
      if (typeof V.toRaw === 'function') { toRaw = V.toRaw; OUT.vueFrom = hit; }
    }
  } catch (e) { J.fails.push('vue import: ' + String(e).slice(0, 120)); }

  // 底图上的「代理读 vs 原始读」（这次 toRaw 真的生效）
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
  J.stage = 'raw-vs-proxy';
  {
    const bm = s.baseMaps[NAME];
    const raw = toRaw(bm);
    OUT.rawIsRaw = raw !== bm;
    OUT.clone_tests = {
      proxy_stringify: bench(() => JSON.stringify(bm), 3),
      raw_stringify: bench(() => JSON.stringify(raw), 3),
      proxy_clone: bench(() => JSON.parse(JSON.stringify(bm)), 3),
      raw_clone: bench(() => JSON.parse(JSON.stringify(raw)), 3),
    };
    const hm = raw.heightmap || {};
    OUT.heightmap = {
      keys: Object.keys(hm),
      h_type: hm.h && hm.h.constructor && hm.h.constructor.name,
      h_len: hm.h && hm.h.length,
    };
  }

  // ── 同一个 mouseup：先原样量 3 次，再消融量 3 次 ─────────────────────────
  const OJSON = window.JSON;
  const mkTrace = (cx, cy, rr) => {
    const pts = [];
    for (let i = 1; i <= 50; i++) {
      const a = (i / 50) * Math.PI * 2;
      pts.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
    }
    return pts;
  };
  const runLand = async (label) => {
    const out = [];
    for (let k = 0; k < 3; k++) {
      const cx = b.width * (0.30 + k * 0.10), cy = b.height * 0.54;
      const rr = Math.min(b.width, b.height) * 0.07;
      const ev = (t, x, y) => new MouseEvent(t, {
        clientX: b.left + x, clientY: b.top + y, button: 0,
        buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true,
      });
      sm.setTool('draw');
      sm.canvas.dispatchEvent(ev('mousedown', cx + rr, cy));
      for (const p of mkTrace(cx, cy, rr)) sm.canvas.dispatchEvent(ev('mousemove', p.x, p.y));
      await tick(2400);            // 等上一次的 800ms 防抖落盘彻底跑完（不叠在这次的读数上）
      const t0 = performance.now();
      sm.canvas.dispatchEvent(ev('mouseup', cx + rr, cy));
      out.push(+(performance.now() - t0).toFixed(1));
      await tick(2400);
    }
    out.sort((a, b) => a - b);
    return { label, n: out.length, all: out, p50: out[Math.floor(out.length / 2)] };
  };

  J.stage = 'land-real';
  OUT.land_real = await runLand('原样');
  J.stage = 'land-ablated';
  // 消融：让「对象/数组的 stringify」直接返回空壳（parse 照旧）→ 6 次深拷贝只剩遍历外壳
  window.JSON = Object.assign(Object.create(OJSON), {
    stringify: (v, r) => {
      if (v && typeof v === 'object') return Array.isArray(v) ? '[]' : '{}';
      return OJSON.stringify(v, r);
    },
    parse: (t) => (t === '[]' ? [] : (t === '{}' ? {} : OJSON.parse(t))),
  });
  OUT.land_ablated = await runLand('消融(深拷贝空转)');
  window.JSON = OJSON;
  OUT.json_restored = window.JSON === OJSON;

  // 还原后立刻确认数据没被消融污染（省份还在）
  OUT.terrain_after = (s.baseMaps[NAME].terrain || []).length;

  J.stage = 'done';
})().catch((e) => {
  if (window.__JSON0) window.JSON = window.__JSON0;
  window.__BREAK3.fails.push('probe: ' + String((e && e.stack) || e).slice(0, 600));
  window.__BREAK3.stage = 'done';
});
'kicked'
