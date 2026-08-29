/**
 * composables/planetInteractions.js — 行星地图交互状态机（批次 3：从 PlanetMap.vue 拆分）
 *
 * 交互回调（onDragStart/onDragMove/onDragEnd/handleCanvasClick）从巨型组件迁移至此。
 * 双通道设计：
 *  - getState()  读通道：每次回调执行时惰性调用，返回组件解包后的最新状态
 *    （ref 解包值；数组/对象内部修改（push/字段赋值）直接生效——reactive 引用写回）
 *  - actions     写通道：ref 整体赋值 / store 调用 / 组件私有函数（finishDrawing 等）
 *    由组件注入 lambda，交互模块不直接触碰 ref 或组件私有函数
 *
 * 迁移历史：2026-08-16 P0-2（方案 P0-2），配合 P0-1 交互专项测试护航。
 * 第三批增强：E4 旋转/缩放手柄、E5 智能参考线磁吸、E7 批量选择拖动。
 */
import { buildSnapCandidates, computeSmartSnap, SMART_SNAP_PX } from '../utils/smartGuides';

export function createPlanetInteractions(getState, actions) {

// E5：拖拽对象的对齐磁吸（网格吸附之后应用，命中轴覆盖网格结果）
// 返回 { x, y }；参考线经 actions.setSmartGuides 交给绘制层
function applySmartSnap(s, pos, exclude) {
  if (!s.smartGuidesEnabled) {
    actions.setSmartGuides([]);
    return pos;
  }
  const candidates = buildSnapCandidates({
    markers: s.currentMapData?.markers || [],
    textLabels: s.currentMapData?.textLabels || [],
    places: s.places || [],
    regions: s.currentMapData?.regions || [],
  }, exclude);
  const threshold = SMART_SNAP_PX / (s.zoom || 1);
  const snapped = computeSmartSnap(pos, candidates, threshold);
  actions.setSmartGuides(snapped.guides);
  return { x: snapped.x, y: snapped.y };
}

function onDragStart(wx, wy, button, shiftKey, ctrlKey, panTry) {
  const s = getState();
  if (button !== 0) return true;

  // 拆分/合并模式：屏蔽顶点/节点/参考图拖拽（选点优先，点击由 onClick 收集；
  // 否则点击锚点会被顶点拖拽拦截导致无法选点，2026-08-16 用户反馈）
  if (s.splitSelectMode || s.mergeSelectMode) return true;

  // E4：选中标记/文本的旋转/缩放手柄（悬浮于对象之上，任意模式优先命中）
  // 采用状态驱动（与 move 拖拽一致）：返回 false 抑制平移，变换信息存组件 state
  if (s.editMode && (s.selectedMarker || s.selectedTextLabel)) {
    const handleHit = s.hitTestSelectionHandle(wx, wy);
    if (handleHit) {
      const sel = s.selectedMarker
        ? { kind: 'marker', obj: s.selectedMarker }
        : { kind: 'textLabel', obj: s.selectedTextLabel };
      actions.setTransformDrag({
        handle: handleHit.handle,
        kind: sel.kind,
        id: sel.obj.id,
        center: { x: sel.obj.x, y: sel.obj.y },
        old: { rotation: sel.obj.rotation || 0, scale: sel.obj.scale || 1 },
        startAngle: Math.atan2(wy - sel.obj.y, wx - sel.obj.x),
        startDist: Math.max(Math.hypot(wx - sel.obj.x, wy - sel.obj.y), 1e-6),
      });
      return false;
    }
  }

  const mode = s.isSpacebarDown ? 'pan' : s.interactionMode;

  // panTry=true：pan 模式下的顶点试探，只做顶点检测，不做其他副作用
  if (panTry) {
    if (s.editMode && (s.selectedProvince || s.selectedRegion || s.selectedRoute)) {
      const vertexHit = s.hitTestVertex(wx, wy);
      if (vertexHit) {
        const kind = s.selectedRoute ? 'route' : (s.selectedRegion ? 'region' : 'province');
        actions.setVertexDrag(kind, s.captureVertexSnapshot(kind));
        return { mode: 'vertex', vertexInfo: { kind, vertexIndex: vertexHit.vertexIndex } };
      }
    }
    // Shift+拖动：pan 模式下的框选（原框选分支在非 panTry 路径不可达，
    // 2026-08-16 P0-1 交互测试发现回归——panTry 协议引入后 Shift 框选失效）
    if (shiftKey && s.editMode) {
      const hit = s.hitTest(wx, wy);
      if (!hit) {
        actions.startBoxSelect({ x: wx, y: wy });
        return false;
      }
    }
    return true; // 非顶点 → 允许平移
  }

  // 参考图拖动模式：拖动画布移动底图
  if (s.refDragMode && s.referenceImage && !s.referenceImage.locked) {
    actions.setRefDragStart({ x: s.referenceImage.offsetX, y: s.referenceImage.offsetY }, { x: wx, y: wy });
    return false;
  }

  // 顶点拖拽（选中多边形/区域/路线时，pan 模式或任意模式下点击顶点）
  if (s.editMode && (s.selectedProvince || s.selectedRegion || s.selectedRoute)) {
    const vertexHit = s.hitTestVertex(wx, wy);
    if (vertexHit) {
      const kind = s.selectedRoute ? 'route' : (s.selectedRegion ? 'region' : 'province');
      actions.setVertexDrag(kind, s.captureVertexSnapshot(kind));
      return { mode: 'vertex', vertexInfo: { kind, vertexIndex: vertexHit.vertexIndex } };
    }
  }

  // 地形笔刷：开始涂抹（优先于自由绘制）
  if (mode === 'draw' && s.brushMode) {
    actions.startBrush({ x: wx, y: wy });
    return false;
  }

  // 绘制模式：开始绘制（笔刷模式不进入）
  // 注意：wx/wy 已是世界坐标（useCanvasRenderer 已 screenToWorld），直接用，
  // 不要再次 screenToWorldFunc —— 双重转换会导致图案偏移到画笔右侧
  if ((mode === 'draw' || mode === 'region') && s.drawMode && !s.brushMode) {
    actions.startDrawing(s.snapDrawPoint({ x: wx, y: wy }));
    return false;
  }

  // cluster 模式：框选起点
  if (mode === 'cluster') {
    actions.setClusterBox({ x: wx, y: wy });
    return false;
  }

  // route/text/marker 模式：点击处理，禁止拖拽平移（用空格临时平移）
  if (mode === 'marker' || mode === 'route' || mode === 'text') {
    return false;
  }

  const hit = s.hitTest(wx, wy);
  if (!hit) {
    // Shift+拖动：框选多个地点
    if (shiftKey && s.editMode && mode === 'pan') {
      actions.startBoxSelect({ x: wx, y: wy });
      return false;
    }
    return true; // 空白处平移
  }

  // 移动工具：拖动 marker/textLabel/region；place 落到下方分支；其余平移
  if (mode === 'move') {
    if (hit.type === 'marker') {
      // E7：Shift+点击 → 切换批量选择成员（不启动拖拽）
      if (shiftKey) {
        actions.shiftSelect('marker', hit.marker);
        actions.requestRender();
        return false;
      }
      // E7：点击批量组成员 → 整组拖动（保留组，selectOnly 会清组，故用 KeepGroup 变体）
      if (s.multiSel && s.multiSel.length > 1 && s.multiSel.some(m => m.type === 'marker' && m.id === hit.marker.id)) {
        actions.beginMultiObjectDrag({ x: wx, y: wy });
        actions.selectOnlyKeepGroup('marker', hit.marker);
        return false;
      }
      actions.setMoveObject({ type: 'marker', id: hit.marker.id, marker: hit.marker, old: { x: hit.marker.x, y: hit.marker.y } });
      actions.selectOnly('marker', hit.marker);
      return false;
    }
    if (hit.type === 'textLabel') {
      if (shiftKey) {
        actions.shiftSelect('textLabel', hit.label);
        actions.requestRender();
        return false;
      }
      if (s.multiSel && s.multiSel.length > 1 && s.multiSel.some(m => m.type === 'textLabel' && m.id === hit.label.id)) {
        actions.beginMultiObjectDrag({ x: wx, y: wy });
        actions.selectOnlyKeepGroup('textLabel', hit.label);
        return false;
      }
      actions.setMoveObject({ type: 'textLabel', id: hit.label.id, label: hit.label, old: { x: hit.label.x, y: hit.label.y } });
      actions.selectOnly('textLabel', hit.label);
      return false;
    }
    if (hit.type === 'region') {
      actions.setMoveObject({ type: 'region', id: hit.region.id, region: hit.region, old: hit.region.points.map(p => ({ ...p })) });
      actions.setDragRegionAnchor(s.snapPoint({ x: wx, y: wy }));
      actions.selectOnly('region', hit.region);
      return false;
    }
    if (hit.type !== 'place') return true; // 省份等 → 平移
  }

  // 选中地点：点击已选中地点且多选 → 批量拖拽；否则启动单地点拖拽
  if (hit.type === 'place') {
    if (s.selectedPlaceIds.has(hit.node.id) && s.selectedPlaceIds.size > 1) {
      actions.startPlacesDrag({ x: wx, y: wy }, [...s.selectedPlaceIds]);
      return false;
    }
    // 单选：清空多选并启动单地点拖拽
    // （原实现 return true 会走画布平移 → 用户"点来点去拖不动地点"）
    actions.selectOnly('place', hit.node.id);
    actions.startPlacesDrag({ x: wx, y: wy }, [hit.node.id]);
    return false;
  }

  if (mode === 'pan') return true;

  return false;
}

function onDragMove(wx, wy, dragInfo) {
  const s = getState();
  const mode = s.isSpacebarDown ? 'pan' : s.interactionMode;

  // E4：旋转/缩放手柄拖拽（角度/距离围绕对象中心，本地改字段，松手一次提交）
  if (s.transformDrag) {
    const info = s.transformDrag;
    const list = info.kind === 'marker' ? s.currentMapData?.markers : s.currentMapData?.textLabels;
    const target = list?.find(o => o.id === info.id);
    if (target) {
      if (info.handle === 'rotate') {
        const deltaDeg = (Math.atan2(wy - info.center.y, wx - info.center.x) - info.startAngle) * 180 / Math.PI;
        let deg = info.old.rotation + deltaDeg;
        deg = ((deg % 360) + 540) % 360 - 180; // 归一化到 (-180, 180]
        target.rotation = Math.round(deg * 10) / 10;
      } else {
        const dist = Math.hypot(wx - info.center.x, wy - info.center.y);
        const scale = info.old.scale * (dist / info.startDist);
        target.scale = Math.round(Math.min(5, Math.max(0.2, scale)) * 100) / 100;
      }
      actions.requestRender();
    }
    return;
  }

  // 移动工具：marker/textLabel/region 本地平移（松手一次提交，避免 undo 栈爆炸；网格吸附对齐）
  if (mode === 'move' && s.dragObject) {
    const obj = s.dragObject;
    if (obj.type === 'marker') {
      const sp = applySmartSnap(s, s.snapPoint({ x: wx, y: wy }), { type: 'marker', id: obj.id });
      obj.marker.x = sp.x; obj.marker.y = sp.y;
    }
    else if (obj.type === 'textLabel') {
      const sp = applySmartSnap(s, s.snapPoint({ x: wx, y: wy }), { type: 'textLabel', id: obj.id });
      obj.label.x = sp.x; obj.label.y = sp.y;
    }
    else if (obj.type === 'multi') {
      // E7：批量拖动（成员位置 = 起始快照 + 指针位移，保持相对布局）
      const dx = wx - obj.start.x;
      const dy = wy - obj.start.y;
      obj.members.forEach(m => {
        m.obj.x = m.old.x + dx;
        m.obj.y = m.old.y + dy;
      });
    }
    else if (obj.type === 'region' && s.dragRegionAnchor) {
      const sp = s.snapPoint({ x: wx, y: wy });
      const dx = sp.x - s.dragRegionAnchor.x;
      const dy = sp.y - s.dragRegionAnchor.y;
      obj.region.points = obj.old.map(p => ({ x: Math.round(p.x + dx), y: Math.round(p.y + dy) }));
      // E5：区域按中心点对齐磁吸（调整位移量使中心落到参考线上）
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      obj.old.forEach(p => {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      });
      const oldCx = (minX + maxX) / 2, oldCy = (minY + maxY) / 2;
      const snapped = applySmartSnap(s, { x: oldCx + dx, y: oldCy + dy }, { type: 'region', id: obj.id });
      if (snapped.x !== oldCx + dx || snapped.y !== oldCy + dy) {
        const sdx = snapped.x - oldCx, sdy = snapped.y - oldCy;
        obj.region.points = obj.old.map(p => ({ x: Math.round(p.x + sdx), y: Math.round(p.y + sdy) }));
      }
    }
    actions.requestRender();
    return;
  }

  // 绘制模式：追加路径点（wx/wy 已是世界坐标；边缘吸附优先，网格吸附其次，跳过重复点）
  if (s.isDrawingActive) {
    const last = s.currentPath[s.currentPath.length - 1];
    const snapped = s.snapDrawPoint({ x: wx, y: wy });
    if (!last || snapped.x !== last.x || snapped.y !== last.y) {
      s.currentPath.push(snapped);
      actions.requestRender();
    }
    return;
  }

  // 顶点拖拽：本地修改选中对象的顶点坐标（网格吸附；松手时一次提交 undo，
  // 避免每帧 update 入栈 + 先改后提交导致 undo 采集到新值，2026-08-16 P0-1）
  if (dragInfo?.mode === 'vertex') {
    const { kind, vertexIndex } = dragInfo.vertexInfo;
    const sp = s.snapPoint({ x: wx, y: wy });
    const target = kind === 'route' ? s.selectedRoute : (kind === 'region' ? s.selectedRegion : s.selectedProvince);
    if (target?.points?.[vertexIndex]) {
      target.points[vertexIndex].x = sp.x;
      target.points[vertexIndex].y = sp.y;
    }
    actions.requestRender();
    return;
  }

  // 框选拖拽：更新选框
  if (s.isBoxSelecting && s.boxSelectStart) {
    actions.setBoxSelectEnd({ x: wx, y: wy });
    actions.requestRender();
    return;
  }

  // 批量拖拽：移动所有选中地点
  if (s.isDraggingPlaces && s.placesDragStart) {
    const dx = wx - s.placesDragStart.x;
    const dy = wy - s.placesDragStart.y;
    s.selectedPlaceIds.forEach(id => {
      const node = s.places.find(p => p.id === id);
      if (node && !node.locked) {
        node.coordinate.x = (node.coordinate.x || 0) + dx;
        node.coordinate.y = (node.coordinate.y || 0) + dy;
        s.store.updateNodePosition(id, node.coordinate.x, node.coordinate.y);
      }
    });
    actions.setPlacesDragStart({ x: wx, y: wy });
    actions.requestRender();
    return;
  }

  // cluster 框选拖拽
  if (s.interactionMode === 'cluster' && s.clusterBoxStart) {
    actions.setClusterBoxEnd({ x: wx, y: wy });
    actions.requestRender();
    return;
  }

  // 地形笔刷拖拽：间隔落点
  if (s.isBrushing && s.brushMode) {
    const last = s.brushLastPoint;
    if (last && Math.hypot(wx - last.x, wy - last.y) >= s.brushSize * 0.25) {
      s.brushStrokePoints.push({ x: wx, y: wy });
      actions.setBrushLastPoint({ x: wx, y: wy });
      actions.requestRender();
    }
    return;
  }

  // 参考图拖动
  if (s.refDragStart && s.refDragMode && s.referenceImage && !s.referenceImage.locked) {
    // wx/wy 已是世界坐标，直接使用（refDragStartWorld 同为世界坐标）
    s.store.updateReferenceImage(s.planetId, {
      ...s.referenceImage,
      offsetX: s.refDragStart.x + (wx - s.refDragStartWorld.x),
      offsetY: s.refDragStart.y + (wy - s.refDragStartWorld.y),
    });
    actions.requestRender();
    return;
  }
}

function onDragEnd(wx, wy, dragInfo) {
  const s = getState();
  const mode = s.isSpacebarDown ? 'pan' : s.interactionMode;

  // E4：旋转/缩放松手 → 一次提交 undo（old 快照来自 onDragStart）
  if (s.transformDrag) {
    actions.clearSmartGuides();
    actions.commitTransform();
    actions.requestRender();
    return;
  }

  // 移动工具松手：一次提交（入一次 undo，避免拖动期间 undo 栈爆炸；
  // 传 onDragStart 记录的旧快照，否则 store 采集到已修改值 → undo 失效）
  if (mode === 'move' && s.dragObject) {
    actions.commitMove();
    actions.clearSmartGuides();
    actions.requestRender();
    return;
  }

  actions.clearSmartGuides();

  // 自由绘制/描点收尾：先完成绘制（内部读 currentPath.value）再清空，
  // 顺序颠倒会读到空路径 → 空多边形或直接失败（2026-08-16 P0-2 迁移发现）
  if (s.isDrawingActive) {
    if (s.currentPath.length > 2) {
      actions.finishDraw();
    }
    actions.clearDrawing();
  }

  // 框选结束：确定选中地点集合
  if (s.isBoxSelecting) {
    const start = s.boxSelectStart;
    const end = s.boxSelectEnd || { x: wx, y: wy };
    actions.clearBoxSelect();
    if (start) {
      const minX = Math.min(start.x, end.x);
      const maxX = Math.max(start.x, end.x);
      const minY = Math.min(start.y, end.y);
      const maxY = Math.max(start.y, end.y);
      const selected = new Set();
      s.places.forEach(p => {
        const x = p.coordinate?.x;
        const y = p.coordinate?.y;
        if (x === null || x === undefined) return;
        if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
          selected.add(p.id);
        }
      });
      actions.setSelectedPlaces(selected);
      actions.requestRender();
    }
  }

  // 批量拖拽结束：结束节点坐标捕获（一次拖动 = 一个 undo 步骤）
  if (s.isDraggingPlaces) {
    actions.endPlacesDrag();
  }

  // 地形笔刷结束：先完成（finishBrushStroke 内部读并清空 brushStrokePoints）再清理，
  // 顺序颠倒会读到空落点 → 不创建多边形（2026-08-16 P0-2 迁移发现）
  if (s.isBrushing) {
    actions.finishBrush();
    actions.clearBrush();
  }

  // cluster 框选结束
  if (s.interactionMode === 'cluster' && s.clusterBoxStart) {
    actions.finishCluster(wx, wy);
  }

  actions.clearRefDragStart();

  // 顶点拖拽松手：一次提交 undo（传 onDragStart 记录的旧快照）
  if (dragInfo?.mode === 'vertex') {
    actions.commitVertexDrag();
  }
}

function handleCanvasClick(hit, wx, wy) {
  const s = getState();

  // 拆分模式：点击收集切割线两点（第一点起点，第二点执行拆分）
  if (s.splitSelectMode) {
    if (s.splitPoints.length === 0) {
      actions.setSplitPoint({ x: wx, y: wy });
      actions.requestRender();
    } else {
      actions.doSplit(s.splitPoints[0], { x: wx, y: wy });
    }
    return;
  }

  // 合并模式：点击第二个要合并的省份
  if (s.mergeSelectMode) {
    if (hit?.type === 'province' && hit.polygon && hit.polygon.id !== s.mergeTargetId) {
      actions.doMerge(s.mergeTargetId, hit.polygon.id);
    } else {
      actions.setStatus('点击一个相邻省份完成合并（Esc 取消）');
    }
    return;
  }

  const mode = s.isSpacebarDown ? 'pan' : s.interactionMode;

  // cluster 模式：点击选中簇成员/空白清除
  if (mode === 'cluster') {
    actions.clusterClick(wx, wy);
    return;
  }

  // route 模式：点击放置顶点
  if (mode === 'route') {
    actions.routeClick(wx, wy);
    return;
  }

  // text 模式：点击放置浮动文本
  if (mode === 'text') {
    const sp = s.snapPoint({ x: wx, y: wy });
    const textCount = (s.currentMapData?.textLabels?.length || 0) + 1;
    const label = {
      id: `text_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      x: sp.x,
      y: sp.y,
      text: `文本 ${textCount}`,
      fontSize: s.textFontSize,
      color: s.textColor,
    };
    actions.addTextLabel(label);
    return;
  }

  // marker 模式：点击放置标记
  if (mode === 'marker') {
    if (hit?.type === 'marker') {
      actions.selectOnly('marker', hit.marker);
      actions.requestRender();
      return;
    }
    const sp = s.snapPoint({ x: wx, y: wy });
    const markerTypeMeta = s.markerTypes.find(m => m.type === s.selectedMarkerType);
    const markerCount = (s.currentMapData?.markers?.filter(m => m.type === s.selectedMarkerType).length || 0) + 1;
    const marker = {
      id: `marker_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: s.selectedMarkerType,
      x: sp.x,
      y: sp.y,
      name: `${markerTypeMeta?.label || '标记'} ${markerCount}`,
      description: '',
    };
    actions.addMarker(marker);
    return;
  }

  // draw/region 描点模式（drawMode=false）：点击放置顶点
  if ((mode === 'draw' || mode === 'region') && !s.drawMode && !s.brushMode) {
    actions.pointClick(wx, wy, mode);
    return;
  }

  // 其他模式：常规选择
  if (!hit) {
    actions.selectOnly('none');
    actions.requestRender();
    return;
  }

  switch (hit.type) {
    case 'province':
      actions.selectOnly('province', hit.polygon);
      break;
    case 'region':
      actions.selectOnly('region', hit.region);
      break;
    case 'marker':
      // E7：Shift 切换后紧跟的 onClick 不改选区（否则移出成员会被误清组）；
      // 点击批量组成员（移动工具下）保留组，其余单选并清组
      if (s.isShiftToggled(hit.marker.id, 'marker')) break;
      if (mode === 'move' && s.multiSel && s.multiSel.length >= 1 && s.multiSel.some(m => m.type === 'marker' && m.id === hit.marker.id)) {
        actions.selectOnlyKeepGroup('marker', hit.marker);
      } else {
        actions.selectOnly('marker', hit.marker);
      }
      break;
    case 'route':
    case 'route-endpoint':
      actions.selectOnly('route', hit.route);
      break;
    case 'textLabel':
      if (s.isShiftToggled(hit.label.id, 'textLabel')) break;
      if (mode === 'move' && s.multiSel && s.multiSel.length >= 1 && s.multiSel.some(m => m.type === 'textLabel' && m.id === hit.label.id)) {
        actions.selectOnlyKeepGroup('textLabel', hit.label);
      } else {
        actions.selectOnly('textLabel', hit.label);
      }
      break;
    case 'place':
      // 点击地点 → 单选 + 打开详情面板（原 switch 缺此 case → 点击无反应）
      actions.selectOnly('place', hit.node.id);
      actions.emitSelectNode(hit.node);
      break;
  }
  actions.requestRender();
}

return { onDragStart, onDragMove, onDragEnd, handleCanvasClick };
}
