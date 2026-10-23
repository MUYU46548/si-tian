// 探针（第 1 件基线，2026-10-23）：**PlanetMap 高度笔刷连画 30 秒**的帧分布。
// 判据口径照指南 02（B1）：全程零帧 >50ms。这里**只量，不修**。
// 由 `_probe_baseline_planet_brush.py` 驱动（30s > CDP 15s 读超时 → 结果写 window.__PLBASE，Python 轮询）。
//
// 三个读数（同一台机器、同一次会话，才有可比性）：
//   ① control_hover：不按鼠标、只 hover 5s（分离"空转成本"）
//   ② height_drag   ：按住高度笔连画 30s（第 1 件要修的那条）
//   ③ land_ms       ：抬手那一下（endHeightStroke = 一条 undo）阻塞多久
window.__PLBASE = { stage: 'boot', out: {}, fails: [] };
window.confirm = () => true;
window.alert = () => {};
window.prompt = (q, d) => d;
(async () => {
  const J = window.__PLBASE;
  const OUT = J.out;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 80 : ms));

  const el = document.querySelector('.planet-map-container');
  if (!el) throw new Error('没有 .planet-map-container —— 没进行星视图');
  const pm = el.__vueParentComponent.setupState;
  const cv = el.querySelector('canvas');
  if (!cv) throw new Error('行星画布不存在');
  const R = () => cv.getBoundingClientRect();

  // ── 数据就绪：高度图必须真在（重建会覆盖用户地形，探针要如实记下来）──
  J.stage = 'data';
  const st = pm.store;
  OUT.gate = {
    hasEnterEditMode: typeof pm.enterEditMode === 'function',
    editMode: !!pm.editMode,
    isReadOnly: !!(st && st.isReadOnly),
    writeMode: st ? (st.writeMode && (st.writeMode.value !== undefined ? st.writeMode.value : st.writeMode)) : null,
  };
  // 🔴 2026-10-23 实测踩到：只调 setInteractionMode('height') 是**空的** ——
  //    笔刷落笔的守卫是 `mode === 'height' && s.editMode`；编辑模式没开，30s 拖拽一个格都不涂，
  //    量出来的是"空转帧"（p50 16.7 / 零卡顿），会得出一条假结论。所以这里显式开编辑模式并**验证真的涂上了**。
  if (!pm.editMode) {
    if (typeof pm.enterEditMode === 'function') pm.enterEditMode();
    await tick(250);
  }
  OUT.gate.editModeAfter = !!pm.editMode;
  if (!pm.editMode) {
    J.fails.push('编辑模式打不开（isReadOnly=' + OUT.gate.isReadOnly + ' / writeMode=' + OUT.gate.writeMode + '）——本次读数无效');
    J.stage = 'done';
    return;
  }

  const hm = pm.planetHeightBrush.ensureHeightmap();
  const pid = pm.currentMapData && pm.currentMapData.planetId;
  const box = R();
  // 采样校验和：每 37 格取一个（2.7 万格 → 约 727 次读，成本可忽略），用于证明"真的涂上了"
  const checksum = () => {
    const a = hm && hm.h;
    if (!a) return null;
    let s = 0;
    for (let i = 0; i < a.length; i += 37) s += a[i];
    return +s.toFixed(3);
  };
  OUT.data = {
    planetId: pid || null,
    cells: hm && hm.h ? hm.h.length : -1,
    cellsX: hm && hm.grid ? hm.grid.cellsX : -1,
    cellsY: hm && hm.grid ? hm.grid.cellsY : -1,
    spacing: hm && hm.grid ? hm.grid.spacing : -1,
    canvas: { w: Math.round(box.width), h: Math.round(box.height) },
    dpr: window.devicePixelRatio || 1,
    editMode: !!pm.editMode,
    tool: pm.interactionMode,
    heightTool: pm.heightTool,
    radius: pm.planetHeightBrush.brushRadius.value,
    strength: pm.planetHeightBrush.brushStrength.value,
  };
  if (!hm) throw new Error('ensureHeightmap() 返回空 —— 这颗行星没有高度图，基线无从量起');

  const mk = (t, x, y, buttons) => {
    const r = R();
    return new MouseEvent(t, {
      clientX: r.left + x, clientY: r.top + y,
      button: 0, buttons: buttons === undefined ? (t === 'mouseup' ? 0 : 1) : buttons,
      bubbles: true, cancelable: true,
    });
  };

  // ── 帧统计（与 _probe_jank_real.js 同口径：rAF 间隔 + 每帧 handler 阻塞）──
  const frameStats = (ms, perFrame) => new Promise((resolve) => {
    const deltas = [];
    let last = performance.now();
    let stop = false;
    let handlerMs = 0;
    let evs = 0;
    const windows = [];   // 每 5s 一段，看有没有越画越卡
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
          from: Math.round(winStart),
          frames: d.length,
          p50: d.length ? +d[Math.floor(d.length * 0.5)].toFixed(1) : -1,
          p95: d.length ? +d[Math.min(d.length - 1, Math.floor(d.length * 0.95))].toFixed(1) : -1,
          max: d.length ? +d[d.length - 1].toFixed(1) : -1,
        });
        winStart = now;
        winDeltas = [];
      }
      try {
        if (perFrame) { handlerMs += (perFrame() || 0); evs += 1; }
      } catch (e) {
        J.fails.push('perFrame: ' + String(e).slice(0, 160));
      }
      if (!stop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    setTimeout(() => { stop = true; }, ms);
    setTimeout(() => {
      const d = deltas.slice(1).sort((a, b) => a - b);
      const q = (p) => (d.length ? +d[Math.min(d.length - 1, Math.floor(d.length * p))].toFixed(1) : -1);
      resolve({
        frames: d.length,
        p50: q(0.5), p95: q(0.95), max: d.length ? +d[d.length - 1].toFixed(1) : -1,
        over33: d.filter((v) => v > 33).length,
        over50: d.filter((v) => v > 50).length,
        over100: d.filter((v) => v > 100).length,
        handlerMsPerEvent: evs ? +(handlerMs / evs).toFixed(2) : -1,
        windows,
      });
    }, ms + 200);
  });

  // ── ① 对照：只 hover（不按键），5s ──────────────────────────────────────
  J.stage = 'control';
  pm.setInteractionMode('height');
  pm.heightTool = 'raise';
  await tick(200);
  {
    let i = 0;
    OUT.control_hover = await frameStats(5000, () => {
      i += 1;
      const b = R();
      const x = b.width * 0.5 + Math.cos(i / 9) * b.width * 0.12;
      const y = b.height * 0.5 + Math.sin(i / 7) * b.height * 0.12;
      const t0 = performance.now();
      cv.dispatchEvent(new MouseEvent('mousemove', {
        clientX: b.left + x, clientY: b.top + y, button: 0, buttons: 0,
        bubbles: true, cancelable: true,
      }));
      return performance.now() - t0;
    });
  }

  // ── ② 主角：按住高度笔连画 30s（每帧一个 mousemove，走"抬高"）──────────────
  J.stage = 'height_30s';
  pm.setInteractionMode('height');
  pm.heightTool = 'raise';
  pm.planetHeightBrush.brushMode.value = 'raise';
  await tick(200);
  {
    const b = R();
    const cx = b.width * 0.5, cy = b.height * 0.5;
    const rx = Math.min(b.width, b.height) * 0.22;
    const ry = Math.min(b.width, b.height) * 0.16;
    // 按下点 = 轨迹起点（参数 t=0）
    const startX = cx + rx, startY = cy;
    const hmSum0 = checksum();
    const tDown = performance.now();
    cv.dispatchEvent(mk('mousedown', startX, startY));
    OUT.mousedown_ms = +(performance.now() - tDown).toFixed(1);
    OUT.isBrushing = !!pm.planetHeightBrush.isBrushing.value;
    await tick(60);
    let i = 0;
    OUT.height_drag = await frameStats(30000, () => {
      i += 1;
      const t = i / 60;                       // 约 60 帧/秒
      const a = t * Math.PI * 2 * 0.9;
      const x = cx + Math.cos(a) * rx;
      const y = cy + Math.sin(a * 1.7) * ry;
      const t0 = performance.now();
      cv.dispatchEvent(mk('mousemove', x, y));
      return performance.now() - t0;
    });
    OUT.heightStrokeCells = hm.h.length;
    const tUp = performance.now();
    cv.dispatchEvent(mk('mouseup', cx, cy));
    OUT.land_ms = +(performance.now() - tUp).toFixed(1);
    await tick(700);
    // 🔴 "真的涂上了吗"：不校验这一条，读数可能是空转帧（本探针第一版就是这么翻车的）
    const hmSum1 = checksum();
    OUT.heightPaint = { before: hmSum0, after: hmSum1, changed: hmSum0 !== hmSum1 };
    if (!OUT.heightPaint.changed) J.fails.push('高度笔 30s 一个格都没改（读数无效）');
  }

  // ── ③ 顺带：散布笔（第 2 件的对象）同一套量 10s，先留个数 ─────────────────
  J.stage = 'relief_10s';
  try {
    if (pm.reliefBrush && typeof pm.setInteractionMode === 'function') {
      pm.setInteractionMode('relief');
      await tick(200);
      const iconsBefore = ((pm.store.mapData || {})[pid] || {}).reliefIcons || [];
      const b = R();
      const cx = b.width * 0.5, cy = b.height * 0.5;
      cv.dispatchEvent(mk('mousedown', cx, cy));
      await tick(50);
      let i = 0;
      OUT.relief_drag = await frameStats(10000, () => {
        i += 1;
        const a = (i / 60) * Math.PI * 2;
        const x = cx + Math.cos(a) * 140;
        const y = cy + Math.sin(a) * 90;
        const t0 = performance.now();
        cv.dispatchEvent(mk('mousemove', x, y));
        return performance.now() - t0;
      });
      const tUp = performance.now();
      cv.dispatchEvent(mk('mouseup', cx, cy));
      OUT.relief_land_ms = +(performance.now() - tUp).toFixed(1);
      await tick(500);
      const iconsAfter = ((pm.store.mapData || {})[pid] || {}).reliefIcons || [];
      OUT.reliefPaint = { before: iconsBefore.length, after: iconsAfter.length, changed: iconsAfter.length !== iconsBefore.length };
      if (!OUT.reliefPaint.changed) OUT.relief_note = '散布笔这一笔没落下图标（读数仅供参考）';
    } else {
      OUT.relief_drag = { skipped: '没有 reliefBrush / setInteractionMode' };
    }
  } catch (e) {
    J.fails.push('relief: ' + String(e).slice(0, 200));
  }

  pm.setInteractionMode('pan');
  J.stage = 'done';
})().catch((e) => {
  window.__PLBASE.fails.push('probe: ' + String((e && e.stack) || e).slice(0, 600));
  window.__PLBASE.stage = 'done';
});
'kicked'
