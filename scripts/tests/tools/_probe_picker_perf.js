// _probe_picker_perf.js —— 卡片墙「第二次进墙仍然要 1.2 秒」到底花在哪（量，不猜）
//
// 来历：`_shot_story_20261017.py` 的读数里，缩略图成品缓存命中 10/10、`bakingLeft=0`，
// 但「点换剧本 → 卡片墙可用」仍花了 1247ms。所以瓶颈**不在烘焙**了，得找出来。
// 本探针把卡片墙这条路上的每一段分别计时（都用产品自己的实现，不另写一份）：
//   ① 省份净面积全量（`provinceNetArea` × 400 省）
//   ② `buildTimeline` 一组
//   ③ `openingSituation` 一条 / 十条
//   ④ 真正的「点换剧本 → 卡片 DOM 齐」墙钟（rAF 计时）
(async () => {
  const out = {};
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));
  const KEY = 'perfMap';
  // RecoveryPanel（全屏 + backdrop-filter，z-index 1100）：上一次页面被强杀 → 必弹，
  // 它的合成开销会混进本页所有耗时读数。先关掉再计时。
  {
    const b = Array.from(document.querySelectorAll('button'))
      .find((x) => (x.textContent || '').includes('丢弃备份'));
    if (b) { b.click(); await tick(500); }
  }

  // ── 造数据：400 省 × 100 点 + 10 条剧本（与故事线同量级）──
  const provs = [], gpts = [], h = [];
  const COLS = 100, ROWS = 60, SP = 20, GX0 = -1000, GY0 = -600;
  for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
    gpts.push({ x: GX0 + i * SP, y: GY0 + j * SP });
    h.push(Math.max(0, Math.round(80 - Math.hypot(i - 50, j - 30) * 1.6)));
  }
  for (let j = 0; j < 20; j++) for (let i = 0; i < 20; i++) {
    const x0 = GX0 + i * 100, y0 = GY0 + j * 60;
    const pts = [];
    for (let k = 0; k < 100; k++) {
      const a = (k / 100) * Math.PI * 2;
      pts.push({ x: x0 + 50 + Math.cos(a) * 44, y: y0 + 30 + Math.sin(a) * 26 });
    }
    provs.push({ id: 'q' + j + '_' + i, name: '省' + j + '-' + i, kind: 'land', points: pts });
  }
  s.baseMaps = { ...s.baseMaps, [KEY]: { id: KEY, name: KEY, terrain: provs, referenceImages: [],
    heightmap: { h, grid: { points: gpts, cellsX: COLS, cellsY: ROWS, spacing: SP } },
    rivers: [], routes: [], burgs: [] } };
  for (let i = 0; i < 10; i++) {
    const id = KEY + '/e' + i;
    if (s.scenarios[id]) s.removeScenario(id);
    s.createScenario(id, { ownerKey: KEY, name: '时代' + (i + 1), order: i + 1,
      era: { roman: 'Ⅰ', label: 't', startYear: String(1000 + i * 50), endYear: String(1500 + i * 50) },
      polities: [{ id: 'P' + i, name: 'P' + i, color: '#c23b3b' }],
      ownership: Object.fromEntries(provs.filter((p, k) => k % 4 === i % 4).map((p) => [p.id, 'P' + i])) });
  }
  out.data = { provinces: provs.length, scenarios: Object.keys(s.scenarios).filter((k) => k.startsWith(KEY)).length };

  const C = await import('/src/utils/scenarioCards.js');
  const TL = await import('/src/utils/scenarioTimeline.js');
  const PS = await import('/src/utils/provinceShape.js');
  const bm = s.baseMaps[KEY];
  const list = Object.entries(s.scenarios).filter(([k]) => k.startsWith(KEY)).map(([id, v]) => ({ ...v, id }));

  let t = performance.now();
  let sum = 0;
  for (const p of bm.terrain) sum += PS.provinceNetArea(p);
  out.provinceNetAreaAll = Math.round((performance.now() - t) * 10) / 10;

  t = performance.now();
  const tl = TL.buildTimeline(list);
  out.buildTimeline = Math.round((performance.now() - t) * 10) / 10;

  t = performance.now();
  C.openingSituation(tl, 0, bm.terrain);
  out.openingSituation1 = Math.round((performance.now() - t) * 10) / 10;

  t = performance.now();
  for (let k = 0; k < tl.scenarios.length; k++) C.openingSituation(tl, k, bm.terrain);
  out.openingSituationAll = Math.round((performance.now() - t) * 10) / 10;

  // ③b 共享面积索引（2026-10-17 第三轮的修法）：同一件事应当快一个量级
  t = performance.now();
  const areaIdx = C.provinceAreaIndex(bm.terrain);
  out.provinceAreaIndex = Math.round((performance.now() - t) * 10) / 10;
  t = performance.now();
  for (let k = 0; k < tl.scenarios.length; k++) C.openingSituation(tl, k, bm.terrain, { areaOf: areaIdx });
  out.openingSituationAllSharedIndex = Math.round((performance.now() - t) * 10) / 10;
  out.speedup = Math.round((out.openingSituationAll / Math.max(0.01, out.openingSituationAllSharedIndex)) * 10) / 10;

  // ── 真·墙钟：进编辑器 → 点「换剧本」→ 卡片 DOM 齐 + 缩略图全非空 ──
  const clickText = (txt) => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').includes(txt));
    if (b) { b.click(); return true; }
    return false;
  };
  const back = document.querySelector('.scenario-toolbar .back-btn');
  if (back) back.click();
  await tick(400);
  window.__SKIP_SCENARIO_PICKER = false;
  clickText('历史剧本');
  // 第一次（必烘）：量到卡片齐 + 缩略图不空
  const firstMs = await new Promise((res) => {
    const t0 = performance.now();
    const step = () => {
      const cvs = Array.from(document.querySelectorAll('[data-testid="sp-cards"] .sp-thumb canvas'));
      const done = cvs.length >= 10 && !document.querySelector('.sp-baking');
      if (done || performance.now() - t0 > 20000) return res(Math.round(performance.now() - t0));
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  out.firstEntryMs = firstMs;
  // 进编辑器
  const cards = Array.from(document.querySelectorAll('[data-testid="sp-cards"] .sp-card'));
  if (cards[1]) cards[1].click();
  await tick(1200);
  // 第二次（应纯命中缓存）
  const secondMs = await new Promise((res) => {
    const t0 = performance.now();
    const b = document.querySelector('[data-testid="slp-picker"]');
    if (!b) return res(-1);
    b.click();
    const step = () => {
      const cvs = Array.from(document.querySelectorAll('[data-testid="sp-cards"] .sp-thumb canvas'));
      const done = cvs.length >= 10 && !document.querySelector('.sp-baking');
      if (done || performance.now() - t0 > 20000) return res(Math.round(performance.now() - t0));
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  out.secondEntryMs = secondMs;
  const mod = await import('/src/utils/scenarioThumb.js');
  out.cache = mod.thumbCacheStats();
  return JSON.stringify(out);
})()
