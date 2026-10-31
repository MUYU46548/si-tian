// scenario/interaction/pointer.js — 剧本视图指针手势（N1 第三阶段，2026-10-31）
//
// 从 `ScenarioMap.vue` 搬出的**抬手收口**（原 235 行）。指针三件里它最独立：
// 不读鼠标位移、只负责"把手势结算成一条 undo / 一次选择"。
//
// 状态约定（与 keyboard.js 同一套）：
//   · Vue 的 ref / 函数：`ctx` 按值传（对象身份不变）；
//   · 手势期的普通 `let`（18 个旗标/句柄）：组件侧做成带 get/set 的 `st` 对象再传进来 ——
//     直接传值只会拷一份，组件那边永远不更新（这条在 keyboard 那刀已经踩过一次）。

export function createPointerHandlers(ctx) {
  const { st, ...rest } = ctx;
  const {
    FREE_TRACE_MIN_POINTS,
    activeRingIdx,
    applyRiverPick,
    baseMap,
    canvas,
    clearSnapMarker,
    coincidentIndexFor,
    collectLinkedPatches,
    commitFreeTrace,
    commitOutlineTrace,
    commitOwnerStroke,
    commitRiverDrag,
    commitRiverErase,
    confirmVertexBatchOverlap,
    confirmVertexMoveOverlap,
    currentProvince,
    dragPreview,
    draggingHandle,
    draggingVertex,
    endInteraction,
    endStrokeBase,
    findLinkedVertices,
    finishRiverDraft,
    lockCoast,
    normalizeBox,
    provBrushTarget,
    provBrushTool,
    provIdxOf,
    provLassoPoints,
    provinceBrush,
    render,
    resolvePoints,
    riverDraft,
    riverDrag,
    riverEraseStroke,
    riverMarquee,
    riversInBox,
    selectedProvince,
    setRiverSelection,
    statusMsg,
    store,
    terrainLabelPick,
    tool,
    updateCursor,
    vertexMarquee,
    vertexSelection,
    baseMapKey,
    verticesInBox,
    writeRingPoints,
  } = rest;

  function onMouseUp(event) {
  // 手势闸门：抬手 = 「人离开画布了」→ 顺延中的保存会在静默窗口后立刻补上（见 interactionGate.js）
  if (st.canvasGateArmed) {
    endInteraction('scenario-canvas');
    st.canvasGateArmed = false;
  }
  // 手势结束 → 手势期基帧作废（**必须无条件写在最前面**：任何一条 return 路径漏掉它，
  // 都会让"贴图帧"泄漏到手势之外，那正是"改了数据画面不动"这类事故的配方）
  endStrokeBase();
  // ── 地形注记手绘（2026-10-27）：抬手 = 这一条线画完（平原在 mousedown 就已成点） ──
  if (terrainLabelPick.value) {
    const p = terrainLabelPick.value;
    if (p.dragging) {
      const n = p.points.length;
      terrainLabelPick.value = { ...p, dragging: false, finished: n >= 1 };
      statusMsg(p.kind === 'plain'
        ? '已落点：点面板「完成」再命名'
        : (n >= 2 ? `已取 ${n} 点：点面板「完成」再命名` : '线太短 —— 重拖一条（至少要起点和终点）'));
      render();
    }
    st.suppressTerrainPickClick = true;   // 紧随的 click 不要落到别的工具上
    return;
  }
  // ── 河流**框选**（第五轮）：先结算框，再谈其它手势 ────────────────────────────
  if (riverMarquee.value) {
    const box = normalizeBox(riverMarquee.value);
    riverMarquee.value = null;
    if (canvas.value) canvas.value.style.cursor = '';
    const picked = riversInBox(box);
    if (!picked.length) {
      statusMsg(box.w * box.h < 4
        ? '框选河流：没有拖动（按住 Shift 拖出一个矩形再松手）'
        : `框选河流：框里没有河（框住 ${Math.round(box.w)}×${Math.round(box.h)} 世界单位）`
          + ' —— 河很细，框稍微画大一点，或直接点河身');
    } else {
      setRiverSelection(picked, picked[picked.length - 1]);
      statusMsg(`已框选 ${picked.length} 条河流 —— Delete 一次删掉，或点「裁到海岸线」（都是一条撤销）`);
    }
    render();
    return;
  }
  // ── 河流（2026-10-17）：先收拖动，再落笔迹 ────────────────────────────────────
  // 顺序不能反：拖节点时 `riverDraft` 是空的（mousedown 里已清），
  // 反过来先跑 finishRiverDraft 会白白清一遍状态并打一条误导的回执。
  // 「按下记候选、松手结算」（2026-10-27）：位移 ≤4px 才算点选；拖动 = 平移，不选中
  if (st.pendingRiverPick) {
    const pick = st.pendingRiverPick;
    st.pendingRiverPick = null;
    const moved = Math.hypot(event.clientX - pick.x, event.clientY - pick.y);
    if (moved <= 4) {
      st.riverPressHandled = true;   // 随后的 click 不要再当成"点空白/选省"
      applyRiverPick(pick.id, pick.shift);
    }
  }
  if (tool.value === 'river') {
    if (riverDrag.value) {
      commitRiverDrag();
      if (canvas.value) canvas.value.style.cursor = 'crosshair';
      return;                       // 拖完不落库笔迹
    }
    if (riverDraft.value.length) {
      // 🔴 用户要的是"松手成河"：以前只有**双击**才会落库（而画布提示写着"按住拖"）。
      finishRiverDraft(true);
      st.suppressRiverClick = true;    // 紧随的 click 不再落一个孤立点
      return;
    }
  }
  // P1：框选收口 —— 命中的顶点进选中集（不做任何写入）
  if (st.vertexMarqueeStart) {
    const box = vertexMarquee.value;
    st.vertexMarqueeStart = null;
    vertexMarquee.value = null;
    const prov = currentProvince();
    const points = prov ? resolvePoints(prov) : null;
    if (prov && points && box) {
      const picked = verticesInBox(points, box).filter((i) => i >= 0 && i < points.length);
      vertexSelection.value = picked;
      if (picked.length) {
        const terrain = baseMap.value?.terrain || [];
        const found = findLinkedVertices(
          terrain, { provIdx: provIdxOf(prov), ringIdx: activeRingIdx.value }, picked, coincidentIndexFor(terrain),
        );
        statusMsg(`框选到 ${picked.length} 个顶点`
          + (found.sharedCount ? `，其中 ${found.sharedCount} 个与邻省共边 —— 拖动它们时邻省的边界会跟着一起走` : '（都不与邻省共边，拖动只改这一个省）')
          + '；Esc 取消选择');
      } else {
        // 🔴 框里没顶点时**必须说清为什么**（用户实测「Shift 没什么作用」很可能就是这一条）：
        //    框选只作用于**当前选中的省份** —— 在别的省身上、或还没点过省份，框都是空的，
        //    而旧文案「要框住紫色圆点」在"根本没画紫色圆点（没选省）"时等于没说。
        statusMsg(prov
          ? `框选：这一框里没有「${prov.name || '当前省'}」的顶点 —— 框选只作用于当前选中的省（紫色圆点）`
          : '框选只作用于**当前选中的省份**：先用「选择 (V)」点一下要精修的省，再按 Shift 拖框');
      }
    }
    render();
    return;
  }
  if (st.freeTraceActive) {
    st.freeTraceActive = false;
    const pts = st.freeTrace || [];
    st.freeTrace = null;
    // 够长才算「一笔成型」；否则让随后的 click 走描点分支（落一个顶点）
    const beforeTrace = baseMap.value;
    if (pts.length >= FREE_TRACE_MIN_POINTS) {
      st.suppressDrawClick = true;
      const okTrace = tool.value === 'outline'
        ? commitOutlineTrace(pts)
        : commitFreeTrace(pts, !!(event && event.shiftKey));
      if (!okTrace) st.suppressDrawClick = false;
    }
    // 🔴 2026-10-24（1-b 收口）：**数据真变了就不再在这里同步重绘**。
    //    几何一变，`baseMap` 计算属性就换了对象引用 → 下面那个 `watch(baseMap)` 会在**同一帧**
    //    （pre flush，绘制之前）重画一遍；这里再画一次等于同一份内容画两遍
    //    —— 实测一次松手 3~4 遍全量重绘、冷帧 35ms（暖帧 8ms），其中一遍纯属重复。
    //    只在「没换引用 = 数据没变」时才必须补这一帧：笔迹预览层画在主画布上，
    //    没有一次全量重绘就擦不掉（拒绝分支 / 太短 / 用户取消压叠确认都走这里）。
    if (!pts.length || baseMap.value === beforeTrace) render();
  }
  if (st.ownerStrokeActive) {
    commitOwnerStroke();
    render();
  }
  // 笔刷建省：抬手 → 整笔长成一个省（一笔 = 一条撤销；拒绝分支零副作用）
  if (st.provPaintActive) {
    st.provPaintActive = false;
    const res = store.endProvinceStroke('笔刷建省', {});
    provinceBrush.invalidateBorders();
    if (res && res.blocked) statusMsg(res.message);
    else if (res && res.rejected) statusMsg(`${res.label || '笔刷建省'}：${res.message}`);
    else if (res && res.changed) {
      statusMsg(`${res.label}：${res.detail} · 一笔 = 1 条撤销`);
      const prov = (baseMap.value?.terrain || []).find((p) => p.id === res.provinceId);
      if (prov) selectedProvince.value = prov;      // 建完即选中：接着用「改省界」精修
    } else statusMsg((res && res.message) || '笔刷建省：这一笔没有建出省');
    render();
  }
  if (st.provStrokeActive) {
    st.provStrokeActive = false;
    const label = provBrushTool.value === 'erase' ? '省份笔刷抹除'
      : (provBrushTool.value === 'smooth' ? '省份笔刷平滑' : '省份笔刷划归');
    const res = store.endProvinceStroke(label, { lockCoast: lockCoast.value });
    provinceBrush.invalidateBorders();
    if (res && res.detail) statusMsg(`${res.label}：${res.detail} · 整笔 = 1 条撤销`);
    else if (res) statusMsg(`${res.label}（整笔 = 1 条撤销）`);
    render();
  }
  if (st.provLassoActive) {
    st.provLassoActive = false;
    const poly = provLassoPoints.value;
    provLassoPoints.value = [];
    const res = store.applyProvinceLasso(baseMapKey.value, poly, provBrushTarget.value, '自由轮廓划归', { lockCoast: lockCoast.value });
    provinceBrush.invalidateBorders();
    // 拒绝分支必须排在「changed」之前 —— 与点击填充同一条协议（{rejected, message}）
    if (res && res.blocked) statusMsg(res.message);
    else if (res && res.rejected) statusMsg(res.message || '自由轮廓被拒绝');
    else if (res && res.changed) {
      const simp = res.simplified && res.simplified.to < res.simplified.from
        ? `（轨迹 ${res.simplified.from} → ${res.simplified.to} 点）` : '';
      statusMsg(`自由轮廓：${res.detail || '已改边界'}${simp} · 一笔成形 = 1 条撤销`);
    } else statusMsg((res && res.detail) || '自由轮廓：圈内没有省份');
    render();
  }
  if (riverEraseStroke.value.length) {
    commitRiverErase();
  }
  if (st.isPanning) {
    st.isPanning = false;
    updateCursor();
  }
  // 相机停稳：补一帧全量（标签/聚落/小地图在移动期是跳过的）
  if (st.cameraMotion || st.cameraSettleTimer) {
    if (st.cameraSettleTimer) { clearTimeout(st.cameraSettleTimer); st.cameraSettleTimer = null; }
    st.cameraMotion = false;
    render();
  }
  if (st.isBrushing) {
    st.isBrushing = false;
  }
  if (draggingHandle.value) {
    const { provId } = draggingHandle.value;
    const preview = dragPreview.value;
    draggingHandle.value = null;
    dragPreview.value = null;
    if (preview && preview.provId === provId) {
      const prov = baseMap.value?.terrain?.find(p => p.id === provId);
      const patch = prov ? writeRingPoints(prov, activeRingIdx.value, preview.points) : null;
      if (patch) store.updateBaseProvince(baseMapKey.value, provId, patch);
    }
    render();
    updateCursor();
    return;
  }
  if (draggingVertex.value) {
    const { provId } = draggingVertex.value;
    const preview = dragPreview.value;
    draggingVertex.value = null;
    dragPreview.value = null;
    clearSnapMarker();
    const linkCtx = st.vertexLinkCtx;
    st.vertexLinkCtx = null;
    // 拖拽结束后一次性写入 store：redo 写坐标、undo 回滚到拖拽前
    if (preview && preview.provId === provId) {
      const prov = baseMap.value?.terrain?.find(p => p.id === provId);
      const patch = prov ? writeRingPoints(prov, activeRingIdx.value, preview.points) : null;
      // P1（2026-10-13）：跟随移动的邻省补丁 —— 与目标省**同一条命令**（一次拖动 = 一条 undo）
      const linkedPatches = collectLinkedPatches(preview);
      // ① 邻省先过闸门：它们只会"涨"，但仍可能涨到**第三个**省身上（罕见）。
      //    顺序不能反 —— 目标省那道闸门会当场回一句「已应用顶点移动」，
      //    先过后拒会留下自相矛盾的两句话。
      const linkedOk = !linkedPatches.length || confirmVertexBatchOverlap(linkedPatches);
      // ② 目标省的压叠闸门（2026-10-11 收口「顶点编辑造成的压叠不在任何闸门范围内」）：
      //    判据放在**写之前** —— 拖到一半弹窗更坏（手还在拖），但写完之后再问就得靠撤销兜底；
      //    在抬手这一帧先量、问过再写，用户说"不"就什么都不发生，形状原地保持拖动前。
      if (linkedOk && patch && confirmVertexMoveOverlap(prov, { ...prov, ...patch })) {
        const patches = [{ id: provId, patch }]
          .concat(linkedPatches.map((x) => ({ id: x.provId, patch: x.patch })));
        const movedCount = (linkCtx && linkCtx.selection.length) || 1;
        const r = store.updateProvincesBatch(baseMapKey.value, patches, {
          label: patches.length > 1
            ? `移动 ${movedCount} 个顶点（共边邻省 ${patches.length - 1} 个跟随）`
            : `移动 ${movedCount} 个顶点`,
        });
        if (r && r.changed && patches.length > 1) {
          statusMsg(`已移动 ${movedCount} 个顶点：${patches.length - 1} 个邻省的共边跟着一起走（边界整体移动，`
            + '无缝无压叠）—— 一次 Ctrl+Z 一并撤回'
            + (linkCtx && linkCtx.truncated ? ' ⚠️ 共边顶点过多，只联动了前 24 个' : ''));
        } else if (r && r.changed === 0 && r.message) {
          statusMsg(`省界没改成：${r.message}`);
        }
      }
    }
    render();
    updateCursor();
  }
}

  return { onMouseUp };
}
