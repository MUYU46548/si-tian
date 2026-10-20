// T7-spike（H1b，2026-10-19）：在真实 desite.map 上试 perfect-freehand。
//
// 量四件事：
//   ① 120 点笔迹 getStroke 的 p50/p95（预览每帧要算一次）；
//   ② 连续 1.5s 每帧算一次时 rAF 的 p95（会不会把帧吃穿）；
//   ③ 轮廓点数 / 速度→宽度是否单调；
//   ④ 画一条对照图：上=perfect-freehand，下=等宽折线（截图给人看）。
//
// 前提：`src/renderer/public/__real_desite.map` 存在（_probe_jank_real.py 会加载）。
// 结果：window.__STROKE；驱动 `_probe_jank_real.py _probe_stroke_spike.js __STROKE`。
window.__STROKE = { stage: 'boot', out: {}, fails: [] };
window.confirm = () => true;
window.alert = () => {};
(async () => {
  const J = window.__STROKE;
  const OUT = J.out;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pct = (arr, p) => {
    const s = arr.slice().sort((a, b) => a - b);
    return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2) : -1;
  };
  try {
    J.stage = 'import';
    const E = await import('/src/utils/strokeEngine.js');
    const S = await import('/src/utils/strokeMath.js');
    // 真实 200 省底图（帧预算要在真实数据上量，合成工程太轻）
    const app = document.querySelector('#app').__vue_app__;
    const s = app._instance.setupState.store;
    const AP = await import('/src/utils/azgaar-parser.js');
    const text = await (await fetch('/__real_desite.map')).text();
    const NAME = 'H1b真实底图';
    s.importFromScenariosJson(AP.buildScenariosJson(AP.parseMapFile(text), NAME, '当前'));
    await sleep(2600);
    const sc = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
    sc.baseMapKey = NAME;
    if (sc.onBaseMapChange) await sc.onBaseMapChange();
    await sleep(1400);
    if (sc.fitToView) sc.fitToView();
    await sleep(500);
    OUT.terrain = (s.baseMaps[NAME].terrain || []).length;

    const pts = [];
    for (let i = 0; i < 120; i++) {
      const t = i / 119;
      pts.push({ x: 100 + t * 620, y: 150 + Math.sin(t * Math.PI * 2.2) * 70 });
    }

    J.stage = 'warmup';
    for (let i = 0; i < 5; i++) E.strokePolygon(pts, { size: 12 });

    J.stage = 'stroke-cost';
    const times = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      const outline = E.strokePolygon(pts, { size: 12, thinning: 0.55, streamline: 0.45, smoothing: 0.5 });
      times.push(performance.now() - t0);
      if (i === 0) OUT.outlinePoints = outline.length;
    }
    OUT.strokeP50 = pct(times, 0.5);
    OUT.strokeP95 = pct(times, 0.95);
    OUT.strokeMax = pct(times, 1);

    J.stage = 'smooth-cost';
    const smoothTimes = [];
    let smoothed = null;
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      smoothed = E.smoothStrokePoints(pts, { size: 12, streamline: 0.45 });
      smoothTimes.push(performance.now() - t0);
    }
    OUT.smoothP50 = pct(smoothTimes, 0.5);
    OUT.smoothP95 = pct(smoothTimes, 0.95);
    OUT.smoothedPoints = smoothed ? smoothed.length : -1;

    J.stage = 'widths';
    const slow = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }, { x: 6, y: 0 }, { x: 8, y: 0 }];
    const fast = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 40, y: 0 }, { x: 60, y: 0 }, { x: 80, y: 0 }];
    const wSlow = S.widthsBySpeed(slow, { base: 10 });
    const wFast = S.widthsBySpeed(fast, { base: 10 });
    OUT.widthSlow = wSlow;
    OUT.widthFast = wFast;
    OUT.widthMonotonic = wFast.every((w, i) => i === 0 || w >= wFast[i - 1] - 1e-9);

    J.stage = 'frame-p95';
    const deltas = [];
    let last = performance.now();
    let stop = false;
    const loop = () => {
      const now = performance.now();
      deltas.push(now - last);
      last = now;
      E.strokePolygon(pts, { size: 12 });
      if (!stop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    await sleep(1500);
    stop = true;
    OUT.frames = deltas.length;
    OUT.frameP50 = pct(deltas, 0.5);
    OUT.frameP95 = pct(deltas, 0.95);
    OUT.framesOver33 = deltas.filter((d) => d > 33).length;

    J.stage = 'overlay';
    const r = sc.canvas.getBoundingClientRect();
    let ov = document.getElementById('__stroke_spike_overlay');
    if (!ov) {
      ov = document.createElement('canvas');
      ov.id = '__stroke_spike_overlay';
      ov.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:9000';
      document.body.appendChild(ov);
    }
    ov.width = Math.round(window.innerWidth);
    ov.height = Math.round(window.innerHeight);
    ov.style.width = window.innerWidth + 'px';
    ov.style.height = window.innerHeight + 'px';
    const ctx = ov.getContext('2d');
    ctx.clearRect(0, 0, ov.width, ov.height);
    const ox = r.left + 60;
    const oy = r.top + 40;

    const shift = (arr, dx, dy) => arr.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    const pfPts = shift(pts, ox, oy);
    const outline = E.strokeOutline(pfPts, { size: 12, thinning: 0.55, streamline: 0.45, smoothing: 0.5 });
    const d = E.outlineToSvgPath(outline, true);
    ctx.fillStyle = 'rgba(108,182,255,0.62)';
    ctx.strokeStyle = 'rgba(200,230,255,0.9)';
    ctx.lineWidth = 1.2;
    const path = new Path2D(d);
    ctx.fill(path);
    ctx.stroke(path);
    ctx.fillStyle = '#cfe6ff';
    ctx.font = '13px system-ui';
    ctx.fillText('perfect-freehand（轮廓 + 压感/笔锋）', ox, oy - 14);
    ctx.fillText(`120 点 → ${outline.length} 轮廓点 · p95 ${OUT.strokeP95}ms`, ox, oy - 0);

    const linePts = shift(pts, ox, oy + 210);
    ctx.beginPath();
    ctx.moveTo(linePts[0].x, linePts[0].y);
    for (let i = 1; i < linePts.length; i++) ctx.lineTo(linePts[i].x, linePts[i].y);
    ctx.strokeStyle = 'rgba(212,168,87,0.85)';
    ctx.lineWidth = 12;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.fillStyle = '#d4a857';
    ctx.fillText('当前写法：等宽折线（无压感/无笔锋）', ox, oy + 190);

    J.stage = 'done';
  } catch (e) {
    J.fails.push(String((e && e.stack) || e).slice(0, 500));
    J.stage = 'done';
  }
})();
'kicked'
