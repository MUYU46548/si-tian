import { onUnmounted } from 'vue';

/**
 * useCanvasRenderer - Canvas 渲染与交互共享逻辑
 * 支持绘制模式（自由绘制多边形）、顶点拖拽编辑
 */
export function useCanvasRenderer(canvasRef, options = {}) {
  const {
    onHitTest = null,
    onRender = null,
    onHover = null,
    onDragStart = null,
    onDragEnd = null,
    onDragMove = null,
    onClick = null,
    onDblClick = null,
    onWheel = null,
    onContextMenu = null,
    onDrawComplete = null,
    minScale = 0.2,
    maxScale = 3,
    fastModeThreshold = 5,
    drawMode = null,        // ref(boolean)
    currentPath = null,     // ref(array)
    animate = false,        // 是否启用持续动画循环
    interactionMode = null, // ref('pan' | 'draw' | 'marker' | 'region')
    isSpacebarDown = null,  // ref(boolean)
  } = options;

  let ctx = null;
  let viewTransform = { x: 0, y: 0, scale: 1 };
  let isPanning = false;
  let panSuppressed = false;
  let mouseDownPos = { x: 0, y: 0 };
  let isDragOperation = false;
  let rafId = null;
  let needsRender = true;
  let fastMode = false;
  let currentHit = null;
  let dragNodeId = null;
  let animationFrameId = null; // 持续动画循环的 rAF ID

  // ===== 顶点拖拽状态 =====
  let isDraggingVertex = false;
  let draggingVertexInfo = null; // { polygonId, vertexIndex }
  let vertexDragStart = null;    // 拖拽起始位置

  // ===== 绘制状态 =====
  let isDrawing = false;

  // ===== 性能统计 =====
  const perfStats = {
    frameCount: 0,
    lastFrameTime: 0,
    avgFrameTime: 0,
    fps: 0,
    peakFrameTime: 0,
    _lastFpsUpdate: 0,
    _frameTimes: [],
  };

  function initCanvas() {
    const canvas = canvasRef.value;
    if (!canvas) return false;

    ctx = canvas.getContext('2d');
    resizeCanvas();

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('dblclick', handleDblClick);
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenuEvent);
    canvas.addEventListener('mouseleave', onMouseLeave);
    window.addEventListener('resize', resizeCanvas);
    return true;
  }

  function cleanupCanvas() {
    const canvas = canvasRef.value;
    if (!canvas) return;

    canvas.removeEventListener('mousedown', onMouseDown);
    canvas.removeEventListener('mousemove', onMouseMove);
    canvas.removeEventListener('mouseup', onMouseUp);
    canvas.removeEventListener('dblclick', handleDblClick);
    canvas.removeEventListener('wheel', handleWheel);
    canvas.removeEventListener('contextmenu', onContextMenuEvent);
    canvas.removeEventListener('mouseleave', onMouseLeave);
    window.removeEventListener('resize', resizeCanvas);

    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    stopAnimation();
  }

  function resizeCanvas() {
    const canvas = canvasRef.value;
    if (!canvas) return;

    const parent = canvas.parentElement;
    if (!parent) return;

    const dpr = window.devicePixelRatio || 1;
    const w = parent.clientWidth;
    const h = parent.clientHeight;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.scale(dpr, dpr);

    requestRender();
  }

  function requestRender() {
    needsRender = true;
    if (!rafId) {
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (needsRender) {
          needsRender = false;
          render();
        }
      });
    }
  }

  function render() {
    if (!ctx || !canvasRef.value || !onRender) return;

    const frameStart = performance.now();

    const canvas = canvasRef.value;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2 + viewTransform.x, h / 2 + viewTransform.y);
    ctx.scale(viewTransform.scale, viewTransform.scale);

    onRender(ctx, w, h);

    ctx.restore();

    // 性能统计
    const frameTime = performance.now() - frameStart;
    perfStats.lastFrameTime = frameTime;
    perfStats.frameCount++;
    perfStats.peakFrameTime = Math.max(perfStats.peakFrameTime, frameTime);

    perfStats._frameTimes.push(frameTime);
    if (perfStats._frameTimes.length > 60) perfStats._frameTimes.shift();
    perfStats.avgFrameTime = perfStats._frameTimes.reduce((a, b) => a + b, 0) / perfStats._frameTimes.length;

    if (frameStart - perfStats._lastFpsUpdate > 1000) {
      perfStats.fps = perfStats.frameCount;
      perfStats.frameCount = 0;
      perfStats._lastFpsUpdate = frameStart;
    }
  }

  function startAnimation() {
    if (animationFrameId) return;
    const loop = () => {
      render();
      animationFrameId = requestAnimationFrame(loop);
    };
    loop();
  }

  function stopAnimation() {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
  }

  function screenToWorld(sx, sy) {
    const canvas = canvasRef.value;
    if (!canvas) return { x: 0, y: 0 };
    return {
      x: (sx - canvas.clientWidth / 2 - viewTransform.x) / viewTransform.scale,
      y: (sy - canvas.clientHeight / 2 - viewTransform.y) / viewTransform.scale,
    };
  }

  function onMouseDown(e) {
    const rect = canvasRef.value.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    mouseDownPos = { x: mx, y: my };
    isDragOperation = false;
    panSuppressed = false;
    dragNodeId = null;
    isDraggingVertex = false;
    draggingVertexInfo = null;
    vertexDragStart = null;
    
    // 确定实际交互模式（空格键临时覆盖为拖手）
    const mode = isSpacebarDown?.value ? 'pan' : (interactionMode?.value || 'draw');
    
    // 绘制模式：按住拖动绘制
    if ((mode === 'draw' || mode === 'region') && drawMode && drawMode.value) {
      isDrawing = true;
      currentPath.value = [screenToWorld(mx, my)];
      return;
    }
    
    // 标记模式：不处理拖拽（点击放置标记）
    if (mode === 'marker') {
      return;
    }
    
    // 区域模式的非绘制状态下，不自动进入绘制
    if (mode === 'region' && (!drawMode || !drawMode.value)) {
      return;
    }
    
    // 拖手模式：直接平移画布（跳过 onDragStart 命中测试）
    if (mode === 'pan') {
      isPanning = true;
      return;
    }
    
    const world = screenToWorld(mx, my);

    if (onDragStart) {
      const result = onDragStart(world.x, world.y, e.button);
      if (result === false) {
        panSuppressed = true;
      } else if (result && typeof result === 'object' && result.mode === 'vertex') {
        // 顶点拖拽
        isDraggingVertex = true;
        draggingVertexInfo = result.vertexInfo;
        vertexDragStart = { x: world.x, y: world.y };
        panSuppressed = true;
      } else if (result && typeof result === 'object' && result.mode === 'node') {
        panSuppressed = true;
        dragNodeId = result.nodeId;
      } else {
        isPanning = true;
      }
    } else {
      isPanning = true;
    }
  }

  function onMouseMove(e) {
    const rect = canvasRef.value.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const world = screenToWorld(mx, my);
    
    // 绘制模式：追加点到路径
    if (isDrawing) {
      const last = currentPath.value[currentPath.value.length - 1];
      if (!last || Math.hypot(world.x - last.x, world.y - last.y) > 3) {
        currentPath.value.push({ x: world.x, y: world.y });
        requestRender();
      }
      return;
    }
    
    // 顶点拖拽
    if (isDraggingVertex && onDragMove) {
      onDragMove(world.x, world.y, { mode: 'vertex', vertexInfo: draggingVertexInfo });
      requestRender();
      return;
    }
    
    if (onHitTest && !isPanning && !panSuppressed) {
      const hit = onHitTest(world.x, world.y);
      if (hit !== currentHit) {
        currentHit = hit;
        if (onHover) onHover(hit, world.x, world.y);
        requestRender();
      }
    }
    
    if (dragNodeId && onDragMove) {
      const dx = mx - mouseDownPos.x;
      const dy = my - mouseDownPos.y;
      if (Math.abs(dx) > fastModeThreshold || Math.abs(dy) > fastModeThreshold) {
        isDragOperation = true;
        fastMode = true;
      }
      onDragMove(world.x, world.y, { mode: 'node', nodeId: dragNodeId, dx, dy });
      requestRender();
      return;
    }
    
    if (isPanning) {
      const dx = mx - mouseDownPos.x;
      const dy = my - mouseDownPos.y;

      if (Math.abs(dx) > fastModeThreshold || Math.abs(dy) > fastModeThreshold) {
        isDragOperation = true;
        fastMode = true;
      }

      if (isDragOperation) {
        viewTransform.x += dx;
        viewTransform.y += dy;
        mouseDownPos = { x: mx, y: my };
        requestRender();
      }
    }

    // panSuppressed 模式下也需要回调 onDragMove（用于航道拖拽预览等）
    if ((isPanning || panSuppressed) && onDragMove) {
      const dx = mx - mouseDownPos.x;
      const dy = my - mouseDownPos.y;
      onDragMove(world.x, world.y, { mode: 'pan', dx, dy });
    }
  }

  function onMouseUp(e) {
    const wasPanning = isPanning;
    const wasSuppressed = panSuppressed;
    const didPan = isDragOperation;
    const endedDragNodeId = dragNodeId;
    const wasDraggingVertex = isDraggingVertex;
    const endedVertexInfo = draggingVertexInfo;
    
    // 绘制模式松开：完成绘制
    if (isDrawing) {
      isDrawing = false;
      if (onDrawComplete && currentPath.value.length > 2) {
        onDrawComplete([...currentPath.value]);
      }
      currentPath.value = [];
      requestRender();
      return;
    }
    
    isPanning = false;
    panSuppressed = false;
    dragNodeId = null;
    isDraggingVertex = false;
    draggingVertexInfo = null;

    if (isDragOperation) {
      isDragOperation = false;
      fastMode = false;
      requestRender();
    }
    
    if (onDragEnd && (wasPanning || wasSuppressed)) {
      const rect = canvasRef.value.getBoundingClientRect();
      const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const dragInfo = wasDraggingVertex
        ? { mode: 'vertex', vertexInfo: endedVertexInfo }
        : endedDragNodeId
          ? { mode: 'node', nodeId: endedDragNodeId, didPan }
          : { mode: 'pan', didPan };
      onDragEnd(world.x, world.y, dragInfo);
    }
    
    // 点击判断：当没有发生拖拽且不是顶点拖拽结束时，触发 onClick
    if (!didPan && !wasDraggingVertex && onClick && onHitTest) {
      const rect = canvasRef.value.getBoundingClientRect();
      const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const hit = onHitTest(world.x, world.y);
      onClick(hit, world.x, world.y);
    }
  }

  function handleWheel(e) {
    e.preventDefault();
    const rect = canvasRef.value.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(minScale, Math.min(maxScale, viewTransform.scale * delta));

    const wx = (mx - canvasRef.value.clientWidth / 2 - viewTransform.x) / viewTransform.scale;
    const wy = (my - canvasRef.value.clientHeight / 2 - viewTransform.y) / viewTransform.scale;

    viewTransform.x = mx - canvasRef.value.clientWidth / 2 - wx * newScale;
    viewTransform.y = my - canvasRef.value.clientHeight / 2 - wy * newScale;
    viewTransform.scale = newScale;

    requestRender();

    if (onWheel) onWheel(e, newScale);
  }

  function onContextMenuEvent(e) {
    e.preventDefault();
    if (onContextMenu) {
      const rect = canvasRef.value.getBoundingClientRect();
      const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      onContextMenu(world.x, world.y);
    }
  }

  function handleDblClick(e) {
    if (onDblClick) {
      const rect = canvasRef.value.getBoundingClientRect();
      const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const hit = onHitTest(world.x, world.y);
      if (hit) {
        onDblClick(hit, world.x, world.y);
      }
    }
  }

  function onMouseLeave() {
    isPanning = false;
    panSuppressed = false;
    isDragOperation = false;
    fastMode = false;
    dragNodeId = null;
    currentHit = null;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    needsRender = true;
    requestRender();
  }

  function resetView() {
    viewTransform = { x: 0, y: 0, scale: 1 };
    requestRender();
  }

  function focusOn(wx, wy, scale = 1) {
    viewTransform.scale = scale;
    viewTransform.x = -wx * scale;
    viewTransform.y = -wy * scale;
    requestRender();
  }

  onUnmounted(cleanupCanvas);

  return {
    getViewTransform: () => ({ ...viewTransform }),
    isFastMode: () => fastMode,
    getCurrentHit: () => currentHit,
    isDraggingVertex: () => isDraggingVertex,
    requestRender,
    resetView,
    focusOn,
    screenToWorld,
    initCanvas,
    cleanupCanvas,
    getPerfStats: () => ({ ...perfStats }),
    startAnimation,
    stopAnimation,
  };
}
