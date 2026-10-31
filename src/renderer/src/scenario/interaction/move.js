// scenario/interaction/move.js — 剧本视图交互（N1 第三阶段，2026-10-31）
//
// 由 `build/_extract_fn.mjs` 从 ScenarioMap.vue 的 `onMouseMove` 原样搬出（口径未改）。
// 依赖约定：
//   · `st`：手势期的普通 `let`（旗标/句柄）—— 组件侧是带 get/set 的对象，读写同一份；
//   · 其余：Vue ref / const / 函数 —— 按值传，对象身份不变；
//   · 纯函数工具：**直接 import**（同一份实现，不经 ctx 转手）。

import { shiftPoints } from '../../utils/vertexSharing';

export function createMoveHandlers(ctx) {
  const { st, ...rest } = ctx;
  const {
    OWNER_BRUSH_SAMPLE_PX,
    PROVINCE_GRID_TOOLS,
    RIVER_BRANCH_SNAP_PX,
    RIVER_ERASE_MIN_STEP_PX,
    RIVER_MAX_DRAFT_POINTS,
    TERRAIN_PICK_MIN_STEP,
    baseMap,
    baseMapKey,
    brushBiome,
    brushCulture,
    brushPreview,
    brushRadius,
    brushReligion,
    brushStrength,
    buildLinkedPreview,
    cameraScale,
    cameraX,
    cameraY,
    canvas,
    dragPreview,
    draggingHandle,
    draggingVertex,
    effectiveVertexSelection,
    handDrawnRivers,
    hitRiverNodeIndex,
    markCameraMotion,
    moveRiverNodeTo,
    ownerStrokeSample,
    placeSmartBurg,
    pokeCapsule,
    polySplitHover,
    provBrushPreview,
    provBrushWorldRadius,
    provLassoPoints,
    provinceBrush,
    provinceBrushOpts,
    px,
    render,
    renderCoalesced,
    resolvePoints,
    resolveSnapPoint,
    riverActiveNode,
    riverDraft,
    riverDraftParentId,
    riverDrag,
    riverEraseStroke,
    riverMarquee,
    roadPath,
    roadStart,
    screenToWorld,
    setSnapMarker,
    snapMarker,
    snapToEdge,
    snapToEdgeEnabled,
    snapToPolyline,
    statusMsg,
    store,
    terrainLabelPick,
    tool,
    updateBurgHover,
    vertexMarquee,
    vx,
    vy,
  } = rest;

function onMouseMove(event) {
  // 沉浸模式：画布上任何移动都唤醒底部胶囊（pokeCapsule 自带非沉浸态早退，代价 = 一次布尔判断）
  pokeCapsule();
  // 地形注记手绘（2026-10-27）：拖动中按**屏幕像素**抽稀（世界阈值会随缩放差几十倍）
  if (terrainLabelPick.value && terrainLabelPick.value.dragging) {
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    const p = terrainLabelPick.value;
    const last = p.points[p.points.length - 1];
    if (!last || Math.hypot(world.x - last.x, world.y - last.y) * cameraScale.value >= TERRAIN_PICK_MIN_STEP) {
      terrainLabelPick.value = { ...p, points: [...p.points, { x: world.x, y: world.y }] };
      renderCoalesced();
    }
    return;
  }
  // 🔴 第五轮：河流**框选**（Shift+拖动）—— 与顶点框选同款，只画框不碰数据，抬手才结算
  if (riverMarquee.value) {
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    riverMarquee.value = { ...riverMarquee.value, x1: world.x, y1: world.y };
    render();
    return;
  }
  // P1：框选顶点（Shift + 空白处拖动）—— 只画框，不碰数据；抬手时才算命中了哪些顶点
  if (st.vertexMarqueeStart) {
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    vertexMarquee.value = {
      x0: st.vertexMarqueeStart.x, y0: st.vertexMarqueeStart.y, x1: world.x, y1: world.y,
    };
    render();
    return;
  }
  // A：折线切割的橡皮筋（只画一段虚线，不做布尔 —— 预览的布尔只在"点了一个点"后算一次）
  if (tool.value === 'polySplit') {
    const rect = canvas.value.getBoundingClientRect();
    polySplitHover.value = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    render();
    return;
  }
  // 「绘制」/「描轮廓」的自由绘制采样：按**屏幕像素**间距取样（世界单位随缩放差几十倍，
  // 用世界阈值会在大缩放时采得过密、小缩放时采得过疏）
  if (st.freeTraceActive && (tool.value === 'draw' || tool.value === 'outline')) {
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    const last = st.freeTrace[st.freeTrace.length - 1];
    if (!last || Math.hypot(world.x - last.x, world.y - last.y) > px(2)) {
      st.freeTrace.push(world);
      // 拖笔采样是**高频手势**（一秒几十次）→ 帧合并；松手时 `commitFreeTrace` 用同步 `render()` 收口。
      // 与河流拖笔/顶点拖动/平移同一条纪律：`render()` 本身仍是同步语义，只有明确的高频手势合并。
      renderCoalesced();
    }
    return;
  }

  // 涂归属（2026-10-20）：拖动期只做只读命中（不写 store）→ 抬手一次落库。
  if (tool.value === 'ownerBrush') {
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    provBrushPreview.value = { x: world.x, y: world.y };
    if (st.ownerStrokeActive) {
      const last = st.ownerLastSample;
      if (!last || Math.hypot(world.x - last.x, world.y - last.y) >= px(OWNER_BRUSH_SAMPLE_PX)) {
        st.ownerLastSample = { x: world.x, y: world.y };
        ownerStrokeSample(world.x, world.y);
      }
    }
    renderCoalesced();
    return;
  }

  // 笔刷建省：拖动期连续采点（与「改省界」同一套抽稀），落库仍在抬手
  if (tool.value === 'provincePaint') {
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    provBrushPreview.value = { x: world.x, y: world.y };
    if (st.provPaintActive) {
      store.applyProvinceStroke(baseMapKey.value, {
        x: world.x, y: world.y,
        radius: provBrushWorldRadius.value,
        tool: 'provincePaint',
        target: 0,
      });
    }
    renderCoalesced();
    return;
  }

  // Phase 3：省份笔刷涂抹 / 套索描轨迹
  if (PROVINCE_GRID_TOOLS.has(tool.value)) {
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    provBrushPreview.value = { x: world.x, y: world.y };
    if (st.provStrokeActive) {
      store.applyProvinceStroke(baseMapKey.value, { x: world.x, y: world.y, ...provinceBrushOpts() });
      provinceBrush.invalidateBorders();
    } else if (st.provLassoActive) {
      const last = provLassoPoints.value[provLassoPoints.value.length - 1];
      if (!last || Math.hypot(world.x - last.x, world.y - last.y) > 1e-6) provLassoPoints.value.push(world);
    }
    // 涂抹/套索同样是高频手势（每次 mousemove 都写 store）→ 帧合并；抬手处的同步 `render()` 收口
    renderCoalesced();
    return;
  }

  // 笔刷预览更新
  if (['height', 'lake', 'biome', 'culture', 'religion'].includes(tool.value)) {
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    brushPreview.value = { x: world.x, y: world.y, radius: brushRadius.value };

    // 拖动中应用笔刷
    if (st.isBrushing) {
      if (tool.value === 'height' || tool.value === 'lake') {
        store.applyHeightBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushStrength.value, st.brushMode);
      } else if (tool.value === 'biome') {
        store.applyBiomeBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushBiome.value);
      } else if (tool.value === 'culture') {
        store.applyCultureBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushCulture.value);
      } else if (tool.value === 'religion') {
        store.applyReligionBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushReligion.value);
      }
    }
    render();
    return;
  }

  if (tool.value === 'road' && roadStart.value) {
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    // 实时预览：从 roadStart 到当前鼠标的直线（松开时计算实际路径）
    roadPath.value = [roadStart.value, world];
    render();
    return;
  }

  if (tool.value === 'burg') {
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    placeSmartBurg(world);
    render();
    return;
  }

  // 河流橡皮：拖动期只收轨迹（按屏幕像素间距，免得一次拖动攒上千点）
  if (tool.value === 'riverErase' && riverEraseStroke.value.length) {
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    const last = riverEraseStroke.value[riverEraseStroke.value.length - 1];
    if (!last || Math.hypot(world.x - last.x, world.y - last.y) >= px(RIVER_ERASE_MIN_STEP_PX)) {
      riverEraseStroke.value.push(world);
      renderCoalesced();
    }
    return;
  }

  // ── 河流编辑器：拖动期**连续采点**（2026-10-17 补；第六修调参）──────────────
  // 🔴 这一段此前**根本不存在**：`onMouseDown` 每按一次就 push 一个点，
  //    而移动过程完全不采点 → "按住拖出笔迹"是画不出来的（只有一连串孤立的点）。
  // 🔴 第六修的两条硬闸门（用户报"性能问题极其严重，还不能防用户乱画"）：
  //    ① 最小间距**跟着缩放走**（`max(12px, 2 世界单位)`）—— 放得越大采得越密是手感，
  //       但"采到每个像素一个点"是纯浪费：那些点在落库前都会被压成 48 个控制点；
  //    ② **笔迹上限** `RIVER_MAX_DRAFT_POINTS` —— 长按慢拖/画圈不再能把内存和每帧
  //       采样成本顶到天花板（到顶就明确说一句，并停止收点）。
  if (tool.value === 'river') {
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    if (riverDrag.value) { moveRiverNodeTo(world); return; }
    // 悬停高亮：`Delete` 删的是"当前活动的那一个"，没有这条反馈用户不知道会删哪个
    const hoverIdx = hitRiverNodeIndex(world.x, world.y);
    if (hoverIdx !== riverActiveNode.value) {
      riverActiveNode.value = hoverIdx;
      if (canvas.value) canvas.value.style.cursor = hoverIdx >= 0 ? 'grab' : 'crosshair';
      render();
    }
    if (!riverDraft.value.length) return;
    const minStep = Math.max(px(12), 2);
    const last = riverDraft.value[riverDraft.value.length - 1];
    if (last && Math.hypot(world.x - last.x, world.y - last.y) < minStep) return;
    // 支流：把笔迹**吸附到母河**（长出支流的那一段），而不是让用户手抖留个缝隙 ——
    // 缝隙在放大后就是"支流和干流没接上"，而用户没有任何办法对准。
    const parent = riverDraftParentId.value ? handDrawnRivers().find((r) => r && r.id === riverDraftParentId.value) : null;
    const snapped = parent ? snapToPolyline(world, parent.points || []) : null;
    const toPush = snapped && snapped.dist <= px(RIVER_BRANCH_SNAP_PX) ? snapped.point : world;
    if (last && Math.hypot(toPush.x - last.x, toPush.y - last.y) < minStep) return;
    if (riverDraft.value.length >= RIVER_MAX_DRAFT_POINTS) {
      if (!st.riverDraftCapped) {
        st.riverDraftCapped = true;
        statusMsg(`这一笔已经很长了（${RIVER_MAX_DRAFT_POINTS} 点）—— 松手即成形；还想更长请分两条画`);
      }
      return;
    }
    riverDraft.value.push(toPush);
    // 高频手势 → 帧合并（一秒几十次采样，同帧只画一次）；`render()` 本身仍保持同步语义
    renderCoalesced();
    return;
  }

  if (draggingHandle.value) {
    const rect = canvas.value.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const world = screenToWorld(sx, sy);
    const { provId, vertexIdx, which } = draggingHandle.value;
    const prov = baseMap.value?.terrain?.find(p => p.id === provId);
    if (prov && prov.points && prov.points[vertexIdx]) {
      const src = resolvePoints(prov);
      const target = src[vertexIdx];
      // 切线偏移 = 光标 - 顶点；对称约束（拖一端，另一端镜像）
      const off = { x: world.x - vx(target), y: world.y - vy(target) };
      dragPreview.value = {
        provId,
        points: src.map((p, i) => {
          const base = { x: vx(p), y: vy(p) };
          if (i !== vertexIdx) {
            return p.controlIn || p.controlOut
              ? { x: base.x, y: base.y, controlIn: p.controlIn, controlOut: p.controlOut }
              : base;
          }
          return which === 'out'
            ? { x: base.x, y: base.y, controlOut: off, controlIn: { x: -off.x, y: -off.y } }
            : { x: base.x, y: base.y, controlIn: off, controlOut: { x: -off.x, y: -off.y } };
        }),
      };
      render();
    }
    return;
  }
  if (draggingVertex.value) {
    const rect = canvas.value.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const world = screenToWorld(sx, sy);
    const { provId, vertexIdx } = draggingVertex.value;
    const prov = baseMap.value?.terrain?.find(p => p.id === provId);
    if (prov && prov.points && prov.points[vertexIdx]) {
      // 顶点编辑拖拽同样吸附（边界 > 网格；Shift 禁用）
      const snapped = resolveSnapPoint(world, event.shiftKey);
      if (snapped.snapped) setSnapMarker(snapped.x, snapped.y, snapped.kind);
      // 只更新临时预览，不写 store（拖拽结束再一次性提交，保证 undo 可回滚）
      //
      // P1（2026-10-13）：**按下时是哪几个顶点被选中，就整组一起平移**；
      // 选中里那些与邻省共边的顶点，邻省的同位顶点按同一 Δ 跟走（方案甲）。
      // 基准点取 `mousedown` 那一刻的快照（`st.vertexLinkCtx.basePoints`）——
      // 不能用 `resolvePoints()`，拖动中它返回的就是上一帧的预览，会把位移累加。
      const base = (st.vertexLinkCtx && st.vertexLinkCtx.provId === provId)
        ? st.vertexLinkCtx.basePoints
        : resolvePoints(prov);
      const baseP = base[vertexIdx];
      const delta = { x: snapped.x - vx(baseP), y: snapped.y - vy(baseP) };
      const sel = effectiveVertexSelection(vertexIdx);
      dragPreview.value = {
        provId,
        points: shiftPoints(base, sel.map((i) => ({ idx: i, dx: delta.x, dy: delta.y }))),
        linked: buildLinkedPreview(prov, delta),
      };
      render();
    }
    return;
  }
  if (!st.isPanning) {
    updateBurgHover(event);
    // 绘制模式下实时预览吸附点（只在命中变化时重绘）
    if (tool.value === 'draw' && snapToEdgeEnabled.value && !event.shiftKey) {
      const rect = canvas.value.getBoundingClientRect();
      const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
      const e = snapToEdge(world);
      const cur = snapMarker.value;
      const changed = !!e !== !!cur || (e && cur && (e.x !== cur.x || e.y !== cur.y || cur.kind !== 'edge'));
      if (changed) {
        if (e) setSnapMarker(e.x, e.y, 'edge');
        else { snapMarker.value = null; }
        render();
      }
    }
    return;
  }
  const dx = event.clientX - st.panStart.x;
  const dy = event.clientY - st.panStart.y;
  cameraX.value += dx;
  cameraY.value += dy;
  st.panStart = { x: event.clientX, y: event.clientY };
  markCameraMotion();
  // 平移也是高频手势：一帧内多次移动只画一次（画布尺寸不变，不会出现"尺寸不一致"）
  renderCoalesced();
}

  return { onMouseMove };
}
