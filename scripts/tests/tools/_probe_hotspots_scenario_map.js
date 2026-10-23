// 探针（第 1 件基线 · 热点归因，2026-10-23）：在**真实 200 省底图**上量"到底是什么在花时间"。
// 由 `_probe_jank_real.py _probe_hotspots_scenario_map.js __HOT` 驱动。
//
// 背景：基线帧统计（`_probe_baseline_scenario_map.js`）量出两处真实卡顿 ——
//   ① 涂归属每 mousemove handler 34.45ms（p95 117ms，72/222 帧 >50ms）
//   ② 自由绘制抬手落库 421ms
// 这份探针**只做归因**（纯测量、不改数据）：把候选函数按次耗时摊开，指出该优化谁。
window.__HOT = { stage: 'boot', out: {}, fails: [] };
window.confirm = () => true;
window.alert = () => {};
(async () => {
  const J = window.__HOT;
  const OUT = J.out;
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));
  const sc = () => document.querySelector('.scenario-map-container').__vueParentComponent.setupState;

  const bench = (label, fn, n) => {
    const arr = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      try { fn(i); } catch (e) { J.fails.push(label + ': ' + String(e).slice(0, 120)); }
      arr.push(performance.now() - t0);
    }
    arr.sort((a, b) => a - b);
    return {
      n, avg: +(arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length)).toFixed(2),
      p50: +arr[Math.floor(arr.length / 2)].toFixed(2),
      p95: +arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.95))].toFixed(2),
      max: +arr[arr.length - 1].toFixed(2),
    };
  };

  // ── 装真实底图（同基线探针；换名避免与上一次导入撞 key）───────────────
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
  const NAME = '热点底图';
  s.importFromScenariosJson(AP.buildScenariosJson(AP.parseMapFile(text), NAME, '当前'));
  await tick(2200);
  let sm = sc();
  sm.baseMapKey = NAME;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await tick(900);
  if (typeof sm.fitToView === 'function') sm.fitToView();
  await tick(400);

  const bm = s.baseMaps[NAME] || {};
  const terr = bm.terrain || [];
  const b = sm.canvas.getBoundingClientRect();
  OUT.data = {
    provinces: terr.length,
    skeletonPts: terr.reduce((a, p) => a + ((p.points || []).length), 0),
    ringsPerCall: typeof sm.provinceRings === 'function',
    canvas: { w: Math.round(b.width), h: Math.round(b.height) },
  };

  // 世界坐标采样点：画布内均匀取，保证落在各个省上（不保证每次命中，命中率也记下来）
  const pts = [];
  for (let gy = 0; gy < 6; gy++) {
    for (let gx = 0; gx < 10; gx++) {
      const x = (b.width * (gx + 0.5)) / 10;
      const y = (b.height * (gy + 0.5)) / 6;
      pts.push(sm.screenToWorld(x, y));
    }
  }
  OUT.data.samplePoints = pts.length;

  // ── ① findProvinceAt：全表线性扫描（每个 mousemove × 5 偏移都会走它）────
  J.stage = 'findProvinceAt';
  let hits = 0;
  OUT.findProvinceAt = bench('findProvinceAt', (i) => {
    const p = pts[i % pts.length];
    if (sm.findProvinceAt(p.x, p.y)) hits++;
  }, 120);
  OUT.findProvinceAt.hitRate = +(hits / 120).toFixed(2);

  // ── ② ownerHitProvinceIds：一次 hover 要付的成本（5 个偏移 × 全表扫描）──
  J.stage = 'ownerHitProvinceIds';
  if (typeof sm.ownerHitProvinceIds === 'function') {
    OUT.ownerHitProvinceIds = bench('ownerHitProvinceIds', (i) => {
      const p = pts[i % pts.length];
      sm.ownerHitProvinceIds(p.x, p.y);
    }, 60);
  } else {
    OUT.ownerHitProvinceIds = { skipped: '没有暴露 ownerHitProvinceIds' };
  }

  // ── ③ provinceRings：每次命中判定都会调它（看是否每次新建数组）─────────
  J.stage = 'provinceRings';
  if (typeof sm.provinceRings === 'function') {
    const p0 = terr[0];
    const a = sm.provinceRings(p0);
    const b2 = sm.provinceRings(p0);
    OUT.provinceRings = {
      ...bench('provinceRings', () => sm.provinceRings(p0), 200),
      sameRef: a === b2,          // 同一省连调两次返回同一数组？false = 每次都新建（分配压力）
    };
  }

  // ── ④ pointInProvince：单省命中测试的底价 ───────────────────────────────
  J.stage = 'pointInProvince';
  if (typeof sm.pointInProvince === 'function') {
    const p = pts[0];
    OUT.pointInProvince = bench('pointInProvince', (i) => {
      sm.pointInProvince(p.x, p.y, terr[i % terr.length]);
    }, 200);
  }

  // ── ⑤ 压叠闸门（抬手 421ms 的头号嫌疑）：度量一次新省 vs 现有 200 省 ────
  J.stage = 'overlapGate';
  try {
    const OV = await import('/src/utils/provinceOverlap.js');
    const probeProv = { id: '__probe__', name: '探针省', kind: 'land',
      points: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 200 }, { x: 0, y: 200 }] };
    OUT.measureProvinceOverlap = bench('measureProvinceOverlap', () => {
      OV.measureProvinceOverlap(probeProv, terr, {});
    }, 5);
  } catch (e) {
    OUT.measureProvinceOverlap = { err: String(e).slice(0, 160) };
  }

  // ── ⑥ 自由绘制简化/贴骨架（抬手 421ms 的二号嫌疑）──────────────────────
  J.stage = 'freeTraceRing';
  if (typeof sm.freeTraceRing === 'function') {
    const cx = b.width * 0.5, cy = b.height * 0.5;
    const rr = Math.min(b.width, b.height) * 0.22;
    const trace = [];
    for (let i = 0; i < 1788; i++) {
      const a = (i / 1788) * Math.PI * 2;
      trace.push(sm.screenToWorld(cx + Math.cos(a) * rr + (i % 3), cy + Math.sin(a) * rr * 0.7));
    }
    OUT.freeTraceRing = {
      ...bench('freeTraceRing', () => sm.freeTraceRing(trace, { snap: true }), 3),
      tracePoints: trace.length,
    };
  }

  // ── ⑦ 保存载荷：导出 + 序列化（每次自动保存都要付）──────────────────────
  J.stage = 'payload';
  {
    const t0 = performance.now();
    const payload = s.exportCanvasToProject();
    OUT.payload_build_ms = +(performance.now() - t0).toFixed(1);
    const t1 = performance.now();
    const json = JSON.stringify(payload);
    OUT.payload_stringify_ms = +(performance.now() - t1).toFixed(1);
    OUT.payload_bytes = json.length;
    OUT.payload_hasScenarios = !!(payload && payload.scenarios);
    OUT.payload_provinces = payload && payload.scenarios && payload.scenarios.baseMaps && payload.scenarios.baseMaps[NAME]
      ? (payload.scenarios.baseMaps[NAME].terrain || []).length : -1;
  }

  J.stage = 'done';
})().catch((e) => {
  window.__HOT.fails.push('probe: ' + String((e && e.stack) || e).slice(0, 600));
  window.__HOT.stage = 'done';
});
'kicked'
