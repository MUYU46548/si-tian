// _probe_river_highlight.js —— 选中河流高亮的**屏幕宽度**：1× / 2× / 4× 三档实测
//
// 要回答的问题（2026-10-17 第三轮）：上一轮把光晕/亮芯的线宽增量从"世界单位 +8"改成
// "屏幕像素 px(3.5)"，理由是「放大 4 倍时 +8 世界单位 = +32 屏幕像素的大白虫」。
// 那个理由对不对、改完到底多粗，**必须量**（暮雨还没确认过观感）。
//
// 量法（与地形底色无关）：同一相机、同一缩放下
//   ① 选中 → 抓一条**沿河法线**的像素串；
//   ② 清掉选中（只改 selectedRiverId 这一枚状态，为的是拿到"没有高亮时"的同一像素）；
//   ③ 两次逐像素比对，"有差异"的像素数 = 高亮在该处的屏幕宽度。
// 取**段中点**（不是节点）并对 8 段取 min/median：节点处另有选中态标记，取节点会量出假宽度。
//
// ⚠️ 探针必须**读回**相机状态：本项目在"写 setupState 上的 ref 到底生没生效"上踩过
//   （写了没生效 → 三档量出来一模一样）。所以每档都回读 cameraScale 与若干节点的屏幕坐标。
(async () => {
  const out = { rows: [] };
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const el = document.querySelector('.scenario-map-container');
  const sm = el.__vueParentComponent.setupState;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));
  const KEY = 'hlProbe';
  const GX0 = -1000, GY0 = -600;

  // 一张小底图（不需要好看，只需要有陆地底色让高亮看得见）
  const w = 2400, h = 1400;
  const prov = { id: 'land1', name: '陆地', kind: 'land', color: '#7d8a5a',
    points: [{ x: GX0, y: GY0 }, { x: GX0 + w, y: GY0 }, { x: GX0 + w, y: GY0 + h }, { x: GX0, y: GY0 + h }] };
  s.baseMaps = { ...s.baseMaps, [KEY]: { id: KEY, name: KEY, terrain: [prov], referenceImages: [],
    rivers: [], routes: [], burgs: [] } };
  sm.baseMapKey = KEY;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await tick(400);

  const rv = { id: 'rv_hl', name: '高亮测试河', width: 1,
    points: Array.from({ length: 24 }, (_, k) => ({
      x: GX0 + 200 + k * 80, y: GY0 + 700 + Math.sin(k / 2.2) * 110 })) };
  s.baseMaps[KEY].rivers = [rv];
  sm.setTool('select');
  sm.showMinimap = false;
  sm.autoRivers = []; sm.autoRiverSegments = [];
  sm.showRivers = true;
  sm.rasterLayer = 'none';
  await tick(250);

  const cvs = sm.canvas;
  const rc = cvs.getBoundingClientRect();
  out.canvas = { rect: [Math.round(rc.width), Math.round(rc.height)], size: [cvs.width, cvs.height],
                 dpr: cvs.width / rc.width, cssScale: sm.cameraScale };
  const midW = rv.points[12];

  const aim = (scale) => {
    sm.cameraScale = scale;
    sm.cameraX = rc.width / 2 - midW.x * scale;
    sm.cameraY = rc.height / 2 - midW.y * scale;
    sm.render();
  };
  /** 世界坐标 → 画布像素坐标（用探针自己的换算，与组件 `screenToWorld` 对称） */
  const toPx = (p) => [Math.round(sm.cameraX + p.x * sm.cameraScale),
                       Math.round(sm.cameraY + p.y * sm.cameraScale)];

  // 先选中（真鼠标 mousedown：选择工具下按下就判河 —— 上一轮刚改的口径）
  aim(1);
  await tick(300);
  const c = toPx(midW);
  const mk = (t) => new MouseEvent(t, { clientX: rc.left + c[0], clientY: rc.top + c[1],
    button: 0, buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true });
  cvs.dispatchEvent(mk('mousedown'));
  await tick(120);
  cvs.dispatchEvent(mk('mouseup'));
  await tick(250);
  out.selected = sm.selectedRiverId;
  out.selectedByRealMouse = sm.selectedRiverId === 'rv_hl';
  if (!out.selectedByRealMouse) return JSON.stringify(out);

  /** 沿法线数"选中 vs 未选中"的差异像素（步长 1 屏幕像素） */
  const diffWidthAt = (wx, wy, nx, ny) => {
    const ctx = cvs.getContext('2d');
    const dpr = cvs.width / rc.width;
    const sx = sm.cameraX + wx * sm.cameraScale;
    const sy = sm.cameraY + wy * sm.cameraScale;
    const half = 30;
    const at = [];
    for (let t = -half; t <= half; t += 1) {
      at.push([Math.round((sx + nx * t) * dpr), Math.round((sy + ny * t) * dpr)]);
    }
    const grab = () => at.map(([X, Y]) => {
      if (X < 0 || Y < 0 || X >= cvs.width || Y >= cvs.height) return null;
      const d = ctx.getImageData(X, Y, 1, 1).data;
      return [d[0], d[1], d[2]];
    });
    sm.selectedRiverId = 'rv_hl'; sm.render();
    const on = grab();
    sm.selectedRiverId = null; sm.render();
    const off = grab();
    sm.selectedRiverId = 'rv_hl'; sm.render();
    let n = 0;
    for (let i = 0; i < at.length; i++) {
      if (!on[i] || !off[i]) continue;
      const d = Math.abs(on[i][0] - off[i][0]) + Math.abs(on[i][1] - off[i][1]) + Math.abs(on[i][2] - off[i][2]);
      if (d > 10) n += 1;
    }
    return n;
  };

  // 河宽（屏幕像素）——产品口径：basemapRiverWidthPx
  let wpx = null;
  try {
    const rr = await import('/src/utils/riverRender.js');
    wpx = rr.basemapRiverWidthPx(rv);
    out.riverWidthPx = wpx;
    out.riverWidthWorld = rr.basemapRiverWidthWorld(rv, sm.cameraScale);
  } catch (e) { out.riverWidthPxErr = String(e); }

  for (const scale of [1, 2, 4]) {
    aim(scale);
    await tick(320);
    const widths = [];
    for (const i of [8, 9, 10, 11, 12, 13, 14, 15]) {
      const a = rv.points[i], b = rv.points[i + 1];
      const tx = b.x - a.x, ty = b.y - a.y;
      const L = Math.hypot(tx, ty) || 1;
      widths.push(diffWidthAt((a.x + b.x) / 2, (a.y + b.y) / 2, -ty / L, tx / L));
    }
    const sorted = widths.slice().sort((x, y) => x - y);
    const onScreen = widths.filter((x) => x > 0).length;
    out.rows.push({
      scale,
      echo: { cameraScale: sm.cameraScale, cameraX: Math.round(sm.cameraX), cameraY: Math.round(sm.cameraY) },
      // 三个节点的屏幕坐标（证明这一档真的换了相机）
      screenPts: [8, 12, 16].map((i) => toPx(rv.points[i])),
      widths,
      nonzero: onScreen,
      min: sorted[0], median: sorted[Math.floor(sorted.length / 2)],
      // 理论上界：河宽 + 光晕 3.5px（+抗锯齿 ≈1）
      expectedPx: wpx == null ? null : Math.round((wpx + 3.5) * 10) / 10,
    });
  }
  // 1× / 4× 的 median 比 —— 屏幕像素口径应 ≈1；世界单位口径会 ≈4
  const r1 = out.rows[0], r4 = out.rows[2];
  out.verdict = {
    '1x median': r1.median, '2x median': out.rows[1].median, '4x median': r4.median,
    '4x/1x': r1.median ? Math.round((r4.median / r1.median) * 100) / 100 : null,
    note: '屏幕像素口径 → 比值 ≈1；若按世界单位加常数，4× 会接近 4 倍',
  };
  return JSON.stringify(out);
})()
