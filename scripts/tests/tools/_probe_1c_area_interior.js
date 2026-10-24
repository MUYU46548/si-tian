// 探针（第 1 件 · 1-c「AreaMap / InteriorView 先量再定」，2026-10-24）。
// 判据照第 1 件：**连画 30 秒零帧 >50ms**（这里是 20s，两者都不是主战场）；量不出 >50ms 帧就记「不需要做」。
//   A. 区域地图：**区域笔刷**（凸包合并那条链）连涂 20 秒 —— 指南 03 说它「走凸包」。
//   B. 室内：**拖家具**连拖 10 秒（DOM 之外唯一的连续手势）。
// 由 `_probe_jank_real.py _probe_1c_area_interior.js __C1` 驱动。只测量，不改产品代码。
window.__C1 = { stage: 'boot', out: {}, fails: [] };
window.confirm = () => true;
window.alert = () => {};
(async () => {
  const J = window.__C1;
  const OUT = J.out;
  const app = document.querySelector('#app').__vue_app__;
  const s = app._instance.setupState.store;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 120 : ms));
  const waitFor = async (fn, ms = 6000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) { if (fn()) return true; await tick(50); }
    return false;
  };

  // 帧统计（与既有探针同口径）
  const frameStats = (ms, perFrame) => new Promise((resolve) => {
    const deltas = [];
    const spikes = [];              // >50ms 的帧 + 它在窗口内的相对时刻（判断"是不是开场尖峰"）
    const t0 = performance.now();
    let last = performance.now();
    let stop = false;
    let handlerMs = 0;
    let evs = 0;
    const loop = () => {
      const now = performance.now();
      deltas.push(now - last);
      if (now - last > 50) spikes.push({ at: Math.round(now - t0), dur: +(now - last).toFixed(1) });
      last = now;
      if (perFrame) {
        try { handlerMs += (perFrame() || 0); evs += 1; } catch (e) { J.fails.push('perFrame: ' + String(e).slice(0, 160)); }
      }
      if (!stop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    setTimeout(() => { stop = true; }, ms);
    setTimeout(() => {
      const d = deltas.slice(1).sort((a, b) => a - b);
      const q = (p) => (d.length ? +d[Math.min(d.length - 1, Math.floor(d.length * p))].toFixed(1) : -1);
      resolve({
        frames: d.length, p50: q(0.5), p95: q(0.95), max: d.length ? +d[d.length - 1].toFixed(1) : -1,
        over33: d.filter((v) => v > 33).length, over50: d.filter((v) => v > 50).length,
        spikes,
        handlerMsPerEvent: evs ? +(handlerMs / evs).toFixed(2) : -1,
      });
    }, ms + 250);
  });

  // ══ A. 区域地图：区域笔刷连涂 ═══════════════════════════════════════════
  J.stage = 'area-open';
  const region = (s.nodes || []).find((n) => n.layer === 'region');
  if (!region) { J.fails.push('没有 region 节点，A 段跳过'); }
  else {
    s.focusEntityOnCanvas(region.id);
    const okEl = await waitFor(() => !!document.querySelector('.area-map-container canvas'));
    OUT.area = { region: region.id, mounted: okEl, viewLevel: s.viewLevel };
    if (!okEl) J.fails.push('AreaMap 没挂上');
    else {
      const el = document.querySelector('.area-map-container');
      const am = el.__vueParentComponent.setupState;
      const cvs = el.querySelector('canvas');
      // 进编辑模式 + 区域笔刷（与用户点「编辑 → 区域 → 笔刷」同一条状态）
      if (typeof am.enterEditMode === 'function') am.enterEditMode();
      await tick(200);
      am.interactionMode = 'zone';
      am.zoneBrushMode = true;
      await tick(200);
      if (typeof am.fitToView === 'function') am.fitToView();
      await tick(200);
      const b = cvs.getBoundingClientRect();
      OUT.area.canvas = { w: Math.round(b.width), h: Math.round(b.height) };
      const mk = (t, x, y) => new MouseEvent(t, {
        clientX: b.left + x, clientY: b.top + y, button: 0,
        buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true,
      });
      const zones0 = ((s.areaZones || {})[region.id] || []).length;
      const cx = b.width * 0.5, cy = b.height * 0.5;
      const rx = b.width * 0.18, ry = b.height * 0.18;
      cvs.dispatchEvent(mk('mousedown', cx - rx, cy));
      await tick(60);
      J.stage = 'area-drag';
      let i = 0;
      OUT.area.drag = await frameStats(20000, () => {
        i += 1;
        const a = i / 22;
        const t0 = performance.now();
        cvs.dispatchEvent(mk('mousemove', cx + Math.cos(a * 1.3) * rx, cy + Math.sin(a * 1.7) * ry));
        return performance.now() - t0;
      });
      const tUp = performance.now();
      cvs.dispatchEvent(mk('mouseup', cx + rx, cy));
      OUT.area.landMs = +(performance.now() - tUp).toFixed(1);
      await tick(600);
      const zones1 = ((s.areaZones || {})[region.id] || []).length;
      OUT.area.zones = { before: zones0, after: zones1, changed: zones1 !== zones0 };
      OUT.area.strokePoints = (am.zoneStrokePoints || []).length;
      if (!OUT.area.zones.changed) J.fails.push('区域笔刷这一涂没建出区域（读数仅供参考）');
    }
  }

  // ══ B. 室内：拖家具 ════════════════════════════════════════════════════
  J.stage = 'interior-open';
  try {
    const host = region || (s.nodes || []).find((n) => n.layer === 'city') || (s.nodes || []).find((n) => n.layer === 'planet');
    const bid = '__c1_building';
    if (!(s.nodes || []).some((n) => n.id === bid)) {
      s.addNode({ id: bid, name: '探针屋', layer: 'building', parentId: host ? host.id : null, tags: [] });
      s.addFloor(bid, '一层');
    }
    s.focusEntityOnCanvas(bid);
    const okEl = await waitFor(() => !!document.querySelector('.interior-container canvas'));
    OUT.interior = { building: bid, mounted: okEl, viewLevel: s.viewLevel };
    if (!okEl) J.fails.push('InteriorView 没挂上');
    else {
      const el = document.querySelector('.interior-container');
      const iv = el.__vueParentComponent.setupState;
      if (typeof iv.enterEditMode === 'function') iv.enterEditMode();
      await tick(250);
      const data = (s.interiorData || {})[bid];
      const floor = data && data.floors && data.floors[0];
      const cvs = el.querySelector('canvas');
      const b = cvs.getBoundingClientRect();
      const center = iv.renderer.screenToWorld(b.width / 2, b.height / 2);
      if (!floor) J.fails.push('没有楼层，B 段跳过');
      else {
        if (!floor.furniture || !floor.furniture.length) {
          s.addFurniture(bid, floor.id, {
            name: '探针桌', x: center.x - 20, y: center.y - 20, width: 40, height: 40, color: '#8B8B8B',
          });
        }
        await tick(300);
        const item = (s.interiorData[bid].floors[0].furniture || [])[0];
        // ⚠️ 必须先把坐标**抄成数字**：item 是响应式代理，拖拽就地改的就是这一个对象，
        //    拿它前后对比永远是 0（本轮第一版就栽在这 —— 读数显示"没移动"，其实动了）。
        const x0 = item ? item.x : null;
        const y0 = item ? item.y : null;
        OUT.interior.furniture = item ? { id: item.id, x0, y0 } : null;
        if (!item) J.fails.push('家具没放进去');
        else {
          // 世界 → 屏幕：renderer 只暴露 screenToWorld，反解：screen = world*scale + t + 画布/2
          //（与 useCanvasRenderer.screenToWorld 同一口径：`x = (sx - w/2 - tx)/scale`）
          const t = iv.renderer.getViewTransform();
          const sx = item.x * t.scale + t.x + cvs.clientWidth / 2;
          const sy = item.y * t.scale + t.y + cvs.clientHeight / 2;
          const centerSx = sx + 20 * t.scale;
          const centerSy = sy + 20 * t.scale;
          const mk = (t2, x, y) => new MouseEvent(t2, {
            clientX: b.left + x, clientY: b.top + y, button: 0,
            buttons: t2 === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true,
          });
          const startX = centerSx, startY = centerSy;
          cvs.dispatchEvent(mk('mousedown', startX, startY));
          await tick(60);
          OUT.interior.dragStarted = !!(iv.isDraggingFurniture);
          OUT.interior.aim = { world: { x: item.x, y: item.y }, screen: { x: Math.round(startX), y: Math.round(startY) }, scale: +t.scale.toFixed(3) };
          if (!OUT.interior.dragStarted) J.fails.push('家具没抓住（dragStarted=false）');
          await tick(500);            // 开场预热：排除"进场首帧/首次拖动"的建帧成本
          J.stage = 'interior-drag';
          let i = 0;
          OUT.interior.drag = await frameStats(10000, () => {
            i += 1;
            const t0 = performance.now();
            cvs.dispatchEvent(mk('mousemove', startX + Math.sin(i / 9) * 60, startY + Math.cos(i / 11) * 40));
            return performance.now() - t0;
          });
          cvs.dispatchEvent(mk('mouseup', startX + 20, startY + 10));
          await tick(400);
          const item1 = (s.interiorData[bid].floors[0].furniture || [])[0];
          OUT.interior.moved = item1 ? +Math.hypot(item1.x - x0, item1.y - y0).toFixed(1) : -1;
          OUT.interior.after = item1 ? { x: item1.x, y: item1.y } : null;
          if (!(OUT.interior.moved > 0)) J.fails.push('家具没真的移动（读数无效）');

          // 对照：同样密度的 mousemove，但**不拖任何东西**（分离"环境噪声/GC"与"拖拽真成本"）
          await tick(400);
          J.stage = 'interior-control';
          let ci = 0;
          OUT.interior.control = await frameStats(10000, () => {
            ci += 1;
            const t3 = performance.now();
            cvs.dispatchEvent(mk('mousemove', startX + Math.sin(ci / 9) * 60, startY + Math.cos(ci / 11) * 40));
            return performance.now() - t3;
          });
        }
      }
    }
  } catch (e) {
    J.fails.push('interior: ' + String((e && e.message) || e).slice(0, 240));
  }

  J.stage = 'done';
})().catch((e) => {
  window.__C1.fails.push('probe: ' + String((e && e.stack) || e).slice(0, 600));
  window.__C1.stage = 'done';
});
'kicked'
