// 探针（第 1 件基线 · 剧本侧，2026-10-23）：**真实 200 省底图上的连续绘制**。
// 由 `_probe_jank_real.py <本文件> __SCBASE` 驱动（它会导航 + 打开 harness 项目 + 进剧本视图）。
//
// 为什么另起一份而不是改 `_probe_jank_real.js`：那一份是"分层计时 + 全手势普查"（40s+，结果多到没人数），
// 这一份只回答一个问题——**B1 判据（连画 30 秒零帧 >50ms）在真实底图上过不过**。
// 另外老探针的前提 `src/renderer/public/__real_desite.map` 在本仓已不存在，这里改用 `docs/mockups/desite.map`（仓内 4.3MB 真件）。
window.__SCBASE = { stage: 'boot', out: {}, fails: [] };
window.confirm = () => true;
window.alert = () => {};
window.prompt = (q, d) => d;
(async () => {
  const J = window.__SCBASE;
  const OUT = J.out;
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));
  const sc = () => {
    const el = document.querySelector('.scenario-map-container');
    return el ? el.__vueParentComponent.setupState : null;
  };

  // ── ① 装真实底图（走产品导入链，不是塞数据）────────────────────────────
  J.stage = 'import';
  let text = null;
  // 🔴 顺序有讲究：Vite 的 SPA fallback 对**任何**未知路径都回 index.html（25KB，r.ok=true），
  //    所以"能 fetch 到"不等于"拿到了地图"——必须按大小/内容验真。
  for (const url of ['/__real_desite.map', '/docs/mockups/desite.map']) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const t = await r.text();
      if (t.length < 1000000 || !t.includes('feature')) {
        OUT['skip_' + url] = { bytes: t.length, why: '不是 .map（多半是 index.html 兜底）' };
        continue;
      }
      text = t; OUT.mapUrl = url; break;
    } catch (e) { /* 试下一个 */ }
  }
  if (!text) throw new Error('拿不到 desite.map（先把它放到 src/renderer/public/__real_desite.map，已在 .gitignore）');
  OUT.mapBytes = text.length;
  const AP = await import('/src/utils/azgaar-parser.js');
  const parsed = AP.parseMapFile(text);
  const NAME = '基线底图';
  const sc2 = AP.buildScenariosJson(parsed, NAME, '当前');
  s.importFromScenariosJson(sc2);
  await tick(2500);
  let sm = sc();
  sm.baseMapKey = NAME;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await tick(1200);
  if (typeof sm.fitToView === 'function') sm.fitToView();
  await tick(600);
  if (!sm.editMode && typeof sm.enterEditMode === 'function') sm.enterEditMode();
  await tick(200);
  const bm = s.baseMaps[NAME] || {};
  const cv = sm.canvas;
  const R = () => cv.getBoundingClientRect();
  OUT.data = {
    provinces: (bm.terrain || []).length,
    rivers: (bm.rivers || []).length,
    skeletonPts: (bm.terrain || []).reduce((a, p) => a + ((p.points || []).length), 0),
    heightCells: bm.heightmap && bm.heightmap.h ? bm.heightmap.h.length : -1,
    canvas: { w: Math.round(R().width), h: Math.round(R().height) },
    cameraScale: sm.cameraScale,
    editMode: !!sm.editMode,
  };
  if (!OUT.data.provinces) throw new Error('底图没导进来（省份 0）');

  const mk = (t, x, y, buttons) => {
    const r = R();
    return new MouseEvent(t, {
      clientX: r.left + x, clientY: r.top + y,
      button: 0, buttons: buttons === undefined ? (t === 'mouseup' ? 0 : 1) : buttons,
      bubbles: true, cancelable: true,
    });
  };

  // ── 帧统计（与其它探针同口径）──────────────────────────────────────────
  const frameStats = (ms, perFrame) => new Promise((resolve) => {
    const deltas = [];
    let last = performance.now();
    let stop = false;
    let handlerMs = 0;
    let evs = 0;
    const windows = [];
    let winStart = last;
    let winDeltas = [];
    const loop = () => {
      const now = performance.now();
      deltas.push(now - last);
      winDeltas.push(now - last);
      last = now;
      if (now - winStart >= 5000) {
        const d = winDeltas.slice(1).sort((a, b) => a - b);
        windows.push({
          from: Math.round(winStart), frames: d.length,
          p50: d.length ? +d[Math.floor(d.length * 0.5)].toFixed(1) : -1,
          p95: d.length ? +d[Math.min(d.length - 1, Math.floor(d.length * 0.95))].toFixed(1) : -1,
          max: d.length ? +d[d.length - 1].toFixed(1) : -1,
        });
        winStart = now;
        winDeltas = [];
      }
      try {
        if (perFrame) { handlerMs += (perFrame() || 0); evs += 1; }
      } catch (e) { J.fails.push('perFrame: ' + String(e).slice(0, 160)); }
      if (!stop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    setTimeout(() => { stop = true; }, ms);
    setTimeout(() => {
      const d = deltas.slice(1).sort((a, b) => a - b);
      const q = (p) => (d.length ? +d[Math.min(d.length - 1, Math.floor(d.length * p))].toFixed(1) : -1);
      resolve({
        frames: d.length, p50: q(0.5), p95: q(0.95), max: d.length ? +d[d.length - 1].toFixed(1) : -1,
        over33: d.filter((v) => v > 33).length,
        over50: d.filter((v) => v > 50).length,
        over100: d.filter((v) => v > 100).length,
        handlerMsPerEvent: evs ? +(handlerMs / evs).toFixed(2) : -1,
        windows,
      });
    }, ms + 250);
  });

  // ── ② 对照：hover 5s ────────────────────────────────────────────────────
  J.stage = 'control';
  sm.setTool('select');
  await tick(200);
  {
    let i = 0;
    OUT.control_hover = await frameStats(5000, () => {
      i += 1;
      const b = R();
      const x = 60 + (i * 7) % Math.max(40, b.width - 120);
      const y = 60 + (i * 11) % Math.max(40, b.height - 120);
      const t0 = performance.now();
      cv.dispatchEvent(new MouseEvent('mousemove', {
        clientX: b.left + x, clientY: b.top + y, button: 0, buttons: 0, bubbles: true, cancelable: true,
      }));
      return performance.now() - t0;
    });
  }

  // ── ③ 主角：省份自由绘制连画 30s（B1 判据）──────────────────────────────
  J.stage = 'draw_30s';
  sm.setTool('draw');
  await tick(250);
  {
    const b = R();
    const cx = b.width * 0.5, cy = b.height * 0.5;
    const rx = Math.min(b.width, b.height) * 0.22;
    const ry = Math.min(b.width, b.height) * 0.16;
    const n0 = (s.baseMaps[NAME].terrain || []).length;
    cv.dispatchEvent(mk('mousedown', cx + rx, cy));
    await tick(80);
    let i = 0;
    OUT.draw_drag = await frameStats(30000, () => {
      i += 1;
      const a = (i / 60) * Math.PI * 2 * 0.9;
      const x = cx + Math.cos(a) * rx;
      const y = cy + Math.sin(a * 1.7) * ry;
      const t0 = performance.now();
      cv.dispatchEvent(mk('mousemove', x, y));
      return performance.now() - t0;
    });
    OUT.tracePoints = (sm.freeTrace || []).length;
    const tUp = performance.now();
    cv.dispatchEvent(mk('mouseup', cx + rx, cy));
    OUT.land_ms = +(performance.now() - tUp).toFixed(1);
    await tick(900);
    const n1 = (s.baseMaps[NAME].terrain || []).length;
    OUT.drawPaint = { before: n0, after: n1, changed: n1 !== n0 };
    if (!OUT.drawPaint.changed) J.fails.push('这一笔没建出省（读数无效）');
  }

  // ── ④ 涂归属 10s（第 4 件的对象，先留个数）──────────────────────────────
  J.stage = 'owner_10s';
  try {
    const scn = sm.selectedScenario || (s.scenarios && Object.values(s.scenarios)[0]) || null;
    const pol = scn && (scn.polities || [])[0];
    if (sm.setTool && pol) {
      if (typeof sm.selectPolity === 'function') sm.selectPolity(pol);
      sm.setTool('ownerBrush');
      await tick(250);
      const b = R();
      const cx = b.width * 0.5, cy = b.height * 0.5;
      const own0 = JSON.stringify(scn.ownership || {});
      cv.dispatchEvent(mk('mousedown', cx - 120, cy));
      await tick(60);
      let i = 0;
      OUT.owner_drag = await frameStats(10000, () => {
        i += 1;
        const x = cx - 120 + (i % 240);
        const y = cy + Math.sin(i / 12) * 30;
        const t0 = performance.now();
        cv.dispatchEvent(mk('mousemove', x, y));
        return performance.now() - t0;
      });
      const tUp = performance.now();
      cv.dispatchEvent(mk('mouseup', cx + 120, cy));
      OUT.owner_land_ms = +(performance.now() - tUp).toFixed(1);
      await tick(600);
      const own1 = JSON.stringify((sm.selectedScenario || scn).ownership || {});
      OUT.ownerPaint = { changed: own0 !== own1 };
      if (!OUT.ownerPaint.changed) J.fails.push('涂归属一笔没改任何归属（读数仅供参考）');
    } else {
      OUT.owner_drag = { skipped: pol ? '没有 setTool' : '这个剧本没有势力' };
    }
  } catch (e) {
    J.fails.push('owner: ' + String(e).slice(0, 200));
  }

  sm.setTool('select');
  J.stage = 'done';
})().catch((e) => {
  window.__SCBASE.fails.push('probe: ' + String((e && e.stack) || e).slice(0, 600));
  window.__SCBASE.stage = 'done';
});
'kicked'
