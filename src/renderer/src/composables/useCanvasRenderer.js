import { onUnmounted } from 'vue';

/**
 * useCanvasRenderer - Canvas 渲染与交互共享逻辑
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
    onWheel = null,
    onContextMenu = null,
    minScale = 0.2,
    maxScale = 3,
    fastModeThreshold = 5,
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

  function initCanvas() {
    const canvas = canvasRef.value;
    if (!canvas) return false;

    ctx = canvas.getContext('2d');
    resizeCanvas();

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
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
    canvas.removeEventListener('wheel', handleWheel);
    canvas.removeEventListener('contextmenu', onContextMenuEvent);
    canvas.removeEventListener('mouseleave', onMouseLeave);
    window.removeEventListener('resize', resizeCanvas);

    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
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

    const canvas = canvasRef.value;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2 + viewTransform.x, h / 2 + viewTransform.y);
    ctx.scale(viewTransform.scale, viewTransform.scale);

    onRender(ctx, w, h);

    ctx.restore();
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

    const world = screenToWorld(mx, my);

    if (onDragStart) {
      const result = onDragStart(world.x, world.y, e.button);
      if (result === false) {
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

    isPanning = false;
    panSuppressed = false;
    dragNodeId = null;

    if (isDragOperation) {
      isDragOperation = false;
      fastMode = false;
      requestRender();
    }

    if (onDragEnd && (wasPanning || wasSuppressed)) {
      const rect = canvasRef.value.getBoundingClientRect();
      const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const dragInfo = endedDragNodeId
        ? { mode: 'node', nodeId: endedDragNodeId, didPan }
        : { mode: 'pan', didPan };
      onDragEnd(world.x, world.y, dragInfo);
    }

    if (!didPan && !wasSuppressed && onClick && onHitTest) {
      const rect = canvasRef.value.getBoundingClientRect();
      const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const hit = onHitTest(world.x, world.y);
      if (hit) {
        onClick(hit, world.x, world.y);
      }
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
    requestRender,
    resetView,
    focusOn,
    screenToWorld,
    initCanvas,
    cleanupCanvas,
  };
}
