// P0 第一张图（200 省真实底图）探针：选势力 → 涂归属 → 选时间点 → 导 PNG。
// 产物不落盘：在页面里 buildScenarioSVG + rasterizeSvg，直接读像素与文本，
// 避免 CDP 一次搬几 MB dataUrl 撞 15s 读超时。
//
// 驱动：_probe_jank_real.py _probe_p0_first_map.js __P0
window.__P0 = { stage: 'boot', out: {}, fails: [] };
window.confirm = () => true;
window.alert = () => {};
(async () => {
  const J = window.__P0;
  const OUT = J.out;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    J.stage = 'import';
    const app = document.querySelector('#app').__vue_app__;
    const s = app._instance.setupState.store;
    const AP = await import('/src/utils/azgaar-parser.js');
    const text = await (await fetch('/__real_desite.map')).text();
    const NAME = 'P0真实底图';
    s.importFromScenariosJson(AP.buildScenariosJson(AP.parseMapFile(text), NAME, '当前'));
    await sleep(2600);
    const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
    sm.baseMapKey = NAME;
    if (sm.onBaseMapChange) await sm.onBaseMapChange();
    await sleep(1400);
    if (sm.fitToView) sm.fitToView();
    await sleep(500);
    const terrain = s.baseMaps[NAME].terrain || [];
    OUT.terrain = terrain.length;

    J.stage = 'scenario';
    // 清掉 harness 里的旧剧本，建一个“当前”剧本，把全部省份划给一个势力
    for (const k of Object.keys(s.scenarios || {})) s.removeScenario(k);
    const ownership = {};
    for (const p of terrain) ownership[p.id] = 'P0';
    s.createScenario(NAME + '/当前', {
      ownerKey: NAME, name: 'P0 第一张图', order: 1,
      era: { roman: 'I', label: '第一', startYear: '2026', endYear: '2030' },
      polities: [{ id: 'P0', name: '测试势力', color: '#c23b3b' }],
      ownership,
    });
    sm.baseMapKey = NAME;
    if (sm.onBaseMapChange) await sm.onBaseMapChange();
    const ids = sm.timeline.scenarios.map((x) => x.id);
    sm.tlEra = ids.indexOf(NAME + '/当前');
    sm.tlDate = { y: 2026, m: 6, d: 1 };
    sm.selectedPolity = null;
    await sleep(600);

    J.stage = 'svg';
    const exp = sm.scenarioExport;
    const built = exp.buildScenarioSVG();
    OUT.svgWidth = built.width;
    OUT.svgHeight = built.height;
    OUT.svgHasTitle = built.svg.includes('P0 第一张图');
    OUT.svgHasLegend = built.svg.includes('势力') && built.svg.includes('测试势力');
    OUT.svgHasScale = built.svg.includes('比例尺') && built.svg.includes('单位');
    OUT.svgBytes = built.svg.length;
    OUT.polityFills = (built.svg.match(/#c23b3b/gi) || []).length;
    OUT.provincePaths = (built.svg.match(/<path /g) || []).length;

    J.stage = 'png';
    const SE = await import('/src/utils/svgExport.js');
    const t0 = performance.now();
    const dataUrl = await SE.rasterizeSvg(built.svg, 2);
    OUT.pngMs = +(performance.now() - t0).toFixed(1);
    OUT.dataUrlLen = dataUrl.length;
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let nonBg = 0, polity = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
      if (a < 10) continue;
      if (Math.abs(r - 26) + Math.abs(g - 42) + Math.abs(b - 58) > 24) nonBg += 1;
      // 势力色 #c23b3b，允许 12 级抗锯齿
      if (Math.abs(r - 194) < 14 && Math.abs(g - 59) < 14 && Math.abs(b - 59) < 14) polity += 1;
    }
    OUT.pngW = img.width; OUT.pngH = img.height;
    OUT.nonBgRatio = +(nonBg / (cv.width * cv.height)).toFixed(3);
    OUT.polityPixels = polity;
    J.stage = 'done';
  } catch (e) {
    J.fails.push(String((e && e.stack) || e).slice(0, 600));
    J.stage = 'done';
  }
})();
'kicked'
