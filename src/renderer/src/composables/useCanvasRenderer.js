import { onUnmounted, reactive } from 'vue';

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
  // viewTransform 用 reactive：组件中读它构建的 computed（如鹰眼 viewBounds）才能自动跟随镜头
  const viewTransform = reactive({ x: 0, y: 0, scale: 1 });
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
    // 仅当调用方未提供自定义 onDragStart 管线时启用内置绘制（PlanetMap 自带
    // onDragStart/onDragMove/onDragEnd 完整管线，若此处拦截会短路其 isDrawingActive，
    // 且松手时只调 onDrawComplete 而 PlanetMap 未传 → 地形静默丢失）
    if ((mode === 'draw' || mode === 'region') && drawMode && drawMode.value && !onDragStart) {
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
    
    // 拖手模式：先尝试顶点拖拽（选中多边形/区域/路线时点击顶点），否则平移画布
    // panTry=true 表示仅做顶点检测（pan 模式试顶点），组件应避免其他副作用
    if (mode === 'pan') {
      const world = screenToWorld(mx, my);
      if (onDragStart) {
        const result = onDragStart(world.x, world.y, e.button, e.shiftKey, e.ctrlKey, true);
        if (result && typeof result === 'object' && result.mode === 'vertex') {
          isDraggingVertex = true;
          draggingVertexInfo = result.vertexInfo;
          vertexDragStart = { x: world.x, y: world.y };
          panSuppressed = true;
          return;
        }
        // pan 模式下组件可能返回 false 抑制平移（如 Shift+框选，2026-08-16 P0-1）
        if (result === false) {
          panSuppressed = true;
          return;
        }
      }
      isPanning = true;
      return;
    }
    
    const world = screenToWorld(mx, my);

    if (onDragStart) {
      const result = onDragStart(world.x, world.y, e.button, e.shiftKey, e.ctrlKey);
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
      const hit = onHitTest ? onHitTest(world.x, world.y) : null;
      onDblClick(hit, world.x, world.y);
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
    Object.assign(viewTransform, { x: 0, y: 0, scale: 1 });
    requestRender();
  }

  function focusOn(wx, wy, scale = 1) {
    viewTransform.scale = scale;
    viewTransform.x = -wx * scale;
    viewTransform.y = -wy * scale;
    requestRender();
  }

  /**
   * 设置缩放级别（保持视口中心，clamp 到 minScale/maxScale）
   * 滑条/按钮/快捷键与滚轮共用的统一缩放入口，避免百分比显示不同步
   */
  function setScale(newScale) {
    const cvs = canvasRef.value;
    if (!cvs) return viewTransform.scale;
    newScale = Math.max(minScale, Math.min(maxScale, newScale));
    // 以视口中心为锚点（等价于鼠标停在画布中心的 wheel 缩放）
    const cx = -viewTransform.x / viewTransform.scale;
    const cy = -viewTransform.y / viewTransform.scale;
    viewTransform.scale = newScale;
    viewTransform.x = -cx * newScale;
    viewTransform.y = -cy * newScale;
    requestRender();
    return viewTransform.scale;
  }

  /**
   * 适屏：将给定世界边界适配到画布（带 padding），缩放并居中
   */
  function fitView(bounds, padding = 0.1) {
    const cvs = canvasRef.value;
    if (!cvs) return viewTransform.scale;
    if (!bounds) return viewTransform.scale;
    const w = (bounds.maxX || 0) - (bounds.minX || 0);
    const h = (bounds.maxY || 0) - (bounds.minY || 0);
    if (w <= 0 || h <= 0) return viewTransform.scale;
    const pad = 1 + padding * 2;
    const scale = Math.max(minScale, Math.min(maxScale,
      Math.min(cvs.clientWidth / (w * pad), cvs.clientHeight / (h * pad))
    ));
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    viewTransform.scale = scale;
    viewTransform.x = -cx * scale;
    viewTransform.y = -cy * scale;
    requestRender();
    return viewTransform.scale;
  }

  onUnmounted(cleanupCanvas);

  return {
    viewTransform, // reactive 对象本体（组件 computed 直接读它才能响应镜头变化，如鹰眼 viewBounds）
    getViewTransform: () => ({ ...viewTransform }),
    isFastMode: () => fastMode,
    getCurrentHit: () => currentHit,
    isDraggingVertex: () => isDraggingVertex,
    requestRender,
    resetView,
    focusOn,
    setScale,
    fitView,
    screenToWorld,
    initCanvas,
    cleanupCanvas,
    getPerfStats: () => ({ ...perfStats }),
    startAnimation,
    stopAnimation,
  };
}
