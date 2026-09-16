<template>
  <!-- 关闭状态：迷你展开按钮 -->
  <button v-if="!visible" class="eagle-eye-toggle" @click="open" title="显示小地图导航"><Icon name="map" :size="14"/></button>
  <!-- 打开状态：小地图主体 -->
  <div v-else class="eagle-eye minimap" data-testid="minimap" :style="{ width: size + 'px' }">
    <div class="minimap-header">
      <span class="minimap-title"><Icon name="navigation" :size="12"/> 小地图</span>
      <div class="minimap-actions">
        <button class="minimap-btn" :title="`缩小到 ${nextSmaller}px`" @click="cycleSize">▣</button>
        <button class="minimap-close" title="隐藏小地图" @click="close">×</button>
      </div>
    </div>
    <div class="minimap-body" :style="{ width: size + 'px', height: size + 'px' }">
      <canvas
        ref="canvas"
        data-testid="minimap-canvas"
        @click="onCanvasClick"
      ></canvas>
      <!-- 视口遮罩：半透明白色，可拖动 = 平移画布 -->
      <div
        v-if="mask"
        class="minimap-mask"
        data-testid="minimap-mask"
        :data-x="Math.round(mask.x)"
        :data-y="Math.round(mask.y)"
        :data-w="Math.round(mask.w)"
        :data-h="Math.round(mask.h)"
        :style="{ left: mask.x + 'px', top: mask.y + 'px', width: mask.w + 'px', height: mask.h + 'px' }"
        title="拖动遮罩平移画布"
        @mousedown.stop.prevent="onMaskDown"
        @click.stop
      ></div>
    </div>
    <div class="eagle-eye-label" data-testid="minimap-label">
      视口 {{ viewLabel }}<span v-if="dragging"> · 拖动中</span>
    </div>
  </div>
</template>

<script setup>
import Icon from './Icon.vue';
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';

/**
 * P0-4 小地图 / 缩略图导航（原 EagleEye 升级）
 *
 * 能力：
 *   1. 缩略图：离屏数据（elements）按 worldBounds 等比绘制（多边形/圆/节点/线段/文本）
 *   2. 视口遮罩：半透明白色矩形，位置由 viewBounds 世界范围换算，随画布实时更新
 *   3. 拖动遮罩 = 平移画布（按 mousemove 增量发 navigate，等价于拖拽平移）
 *   4. 点击非遮罩区域 = 画布跳转到该世界坐标（居中）
 *   5. 可折叠（关闭后留一个 34×30 的展开按钮，localStorage 记住偏好）
 *
 * 向后兼容：原 EagleEye 的 props（viewBounds/elements/worldBounds）与 @navigate 语义不变。
 * 性能：渲染走 rAF 节流 + dirty 标记（拖动遮罩时每帧最多画一次）。
 */

const props = defineProps({
  /** 当前视图的世界坐标范围 */
  viewBounds: { type: Object, required: true },
  /** 要绘制的元素（多边形/圆/节点/线段/文本） */
  elements: { type: Array, default: () => [] },
  /** 整体地图边界 */
  worldBounds: { type: Object, default: () => ({ minX: -500, maxX: 500, minY: -500, maxY: 500 }) },
  /** 边长（px），默认 200（提示词「尺寸约 200x200px（可配置）」） */
  size: { type: Number, default: 200 },
});

const emit = defineEmits(['navigate']);

// ===== 显隐（localStorage 持久化，跨会话保留） =====
const visible = ref(true);
try {
  if (localStorage.getItem('sitian-eagle-eye') === '0') visible.value = false;
} catch (e) { /* ignore */ }

function close() {
  visible.value = false;
  try { localStorage.setItem('sitian-eagle-eye', '0'); } catch (e) { /* ignore */ }
}

function open() {
  visible.value = true;
  try { localStorage.setItem('sitian-eagle-eye', '1'); } catch (e) { /* ignore */ }
  // v-if 重建 canvas 后需重新初始化
  nextTick(() => { initCanvas(); scheduleRender(); });
}

// ===== 尺寸档位（可配置：点击标题栏 ▣ 循环） =====
const SIZE_STEPS = [160, 200, 260];
const sizeOverride = ref(0);
const size = computed(() => sizeOverride.value || props.size || 200);
const nextSmaller = computed(() => {
  const idx = SIZE_STEPS.indexOf(size.value);
  return SIZE_STEPS[(idx + 1) % SIZE_STEPS.length];
});
function cycleSize() {
  const idx = SIZE_STEPS.indexOf(size.value);
  sizeOverride.value = SIZE_STEPS[(idx + 1) % SIZE_STEPS.length];
  nextTick(() => { initCanvas(); scheduleRender(); });
}

const canvas = ref(null);
let ctx = null;
const PADDING = 6;

// ===== 坐标换算 =====
const scale = computed(() => {
  const { minX, maxX, minY, maxY } = props.worldBounds;
  const worldW = (maxX - minX) || 1000;
  const worldH = (maxY - minY) || 1000;
  const inner = Math.max(20, size.value - PADDING * 2);
  return Math.min(inner / worldW, inner / worldH);
});

function worldToScreen(wx, wy) {
  const { minX, minY } = props.worldBounds;
  const s = scale.value;
  return { x: PADDING + (wx - minX) * s, y: PADDING + (wy - minY) * s };
}

function screenToWorld(sx, sy) {
  const { minX, minY } = props.worldBounds;
  const s = scale.value || 1;
  return { x: (sx - PADDING) / s + minX, y: (sy - PADDING) / s + minY };
}

/** 视口遮罩在小地图上的矩形（px）；viewBounds 非法时返回 null → 不渲染遮罩 */
const mask = computed(() => {
  const vb = props.viewBounds;
  if (!vb || ![vb.minX, vb.maxX, vb.minY, vb.maxY].every(Number.isFinite)) return null;
  const tl = worldToScreen(vb.minX, vb.minY);
  const br = worldToScreen(vb.maxX, vb.maxY);
  const max = size.value;
  const x = Math.max(0, Math.min(tl.x, max));
  const y = Math.max(0, Math.min(tl.y, max));
  const w = Math.max(4, Math.min(br.x, max) - x);
  const h = Math.max(4, Math.min(br.y, max) - y);
  return { x, y, w, h };
});

const viewLabel = computed(() => {
  const vb = props.viewBounds;
  if (!vb || ![vb.minX, vb.maxX].every(Number.isFinite)) return '—';
  return `${Math.round(vb.maxX - vb.minX)}×${Math.round(vb.maxY - vb.minY)}`;
});

// ===== 绘制（rAF 节流 + dirty） =====
let rafId = 0;
let dirty = true;

function scheduleRender() {
  dirty = true;
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (!dirty) return;
    dirty = false;
    render();
  });
}

function render() {
  if (!ctx || !canvas.value) return;
  const S = size.value;
  ctx.clearRect(0, 0, S, S);

  // 背景（半透明深色，不抢画布焦点）
  ctx.fillStyle = 'rgba(13, 17, 23, 0.82)';
  ctx.fillRect(0, 0, S, S);

  for (const el of props.elements) {
    if (el.type === 'polygon' && el.points && el.points.length >= 3) {
      ctx.fillStyle = el.color || '#A3C4BC';
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      const first = worldToScreen(el.points[0].x, el.points[0].y);
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < el.points.length; i++) {
        const pt = worldToScreen(el.points[i].x, el.points[i].y);
        ctx.lineTo(pt.x, pt.y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    } else if (el.type === 'circle' && el.x !== undefined) {
      const pos = worldToScreen(el.x, el.y);
      ctx.fillStyle = el.color || '#4a90d9';
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, el.r || 3, 0, Math.PI * 2);
      ctx.fill();
    } else if (el.type === 'node' && el.x !== undefined) {
      const pos = worldToScreen(el.x, el.y);
      const r = el.r || 4;
      if (el.glow) {
        ctx.shadowColor = el.color || '#ffd700';
        ctx.shadowBlur = 4;
      }
      ctx.fillStyle = el.color || '#4a90d9';
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    } else if (el.type === 'line' && el.from && el.to) {
      const p1 = worldToScreen(el.from.x, el.from.y);
      const p2 = worldToScreen(el.to.x, el.to.y);
      ctx.strokeStyle = el.color || 'rgba(100,200,255,0.4)';
      ctx.lineWidth = el.lineWidth || 0.5;
      if (el.dashed) ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (el.type === 'label' && el.x !== undefined) {
      const pos = worldToScreen(el.x, el.y);
      ctx.fillStyle = el.color || '#8b949e';
      ctx.font = `${el.size || 6}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(el.text || '', pos.x, pos.y);
    }
  }

  // 地图外框
  ctx.strokeStyle = 'rgba(139, 148, 158, 0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, S - 1, S - 1);
}

// ===== 交互 =====
const dragging = ref(false);

function localPoint(e) {
  const rect = canvas.value.getBoundingClientRect();
  // canvas 逻辑尺寸 = size；CSS 尺寸 = size（无 DPR 缩放），直接换算即可
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

/** 点击非遮罩区域 → 画布跳转到该世界坐标 */
function onCanvasClick(e) {
  const { x, y } = localPoint(e);
  emit('navigate', screenToWorld(x, y));
}

/** 拖动遮罩 → 按世界增量平移画布 */
function onMaskDown(e) {
  if (!mask.value) return;
  const s = scale.value || 1;
  const start = { x: e.clientX, y: e.clientY };
  const vb = props.viewBounds;
  const startCenter = {
    x: (vb.minX + vb.maxX) / 2,
    y: (vb.minY + vb.maxY) / 2,
  };
  dragging.value = true;

  function onMove(ev) {
    const dxWorld = (ev.clientX - start.x) / s;
    const dyWorld = (ev.clientY - start.y) / s;
    let cx = startCenter.x + dxWorld;
    let cy = startCenter.y + dyWorld;
    // 钳制在地图范围内，遮罩不会被拖出地图
    const { minX, maxX, minY, maxY } = props.worldBounds;
    const halfW = (vb.maxX - vb.minX) / 2;
    const halfH = (vb.maxY - vb.minY) / 2;
    if (maxX - minX > halfW * 2) {
      cx = Math.min(Math.max(cx, minX + halfW), maxX - halfW);
      cy = Math.min(Math.max(cy, minY + halfH), maxY - halfH);
    }
    emit('navigate', { x: cx, y: cy });
  }
  function onUp() {
    dragging.value = false;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function initCanvas() {
  if (!canvas.value) return;
  const S = size.value;
  canvas.value.width = S;
  canvas.value.height = S;
  canvas.value.style.width = S + 'px';
  canvas.value.style.height = S + 'px';
  ctx = canvas.value.getContext('2d');
  render();
}

onMounted(() => { initCanvas(); });

onUnmounted(() => {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
});

watch(
  [() => props.elements, () => props.viewBounds, () => props.worldBounds, () => size.value],
  () => { scheduleRender(); },
  { deep: true }
);
</script>

<style scoped>
.eagle-eye {
  position: absolute;
  right: 14px;
  /* 右下角，避开底部的缩放控件条（zoom-controls 占 bottom 14~40px） */
  bottom: 96px;
  z-index: 20;
  background: rgba(13, 17, 23, 0.82);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-sm);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  overflow: hidden;
  backdrop-filter: blur(2px);
}

.minimap-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 3px 6px;
  border-bottom: 1px solid var(--panel-border);
  background: rgba(22, 27, 34, 0.9);
  cursor: move;
  user-select: none;
}

.minimap-title {
  font-size: 10.5px;
  color: var(--text-tertiary);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.minimap-actions {
  display: flex;
  gap: 2px;
  align-items: center;
}

.minimap-btn,
.minimap-close {
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 3px;
}
.minimap-btn:hover,
.minimap-close:hover {
  background: var(--btn-bg-hover);
  color: var(--text-primary);
}

.minimap-body {
  position: relative;
  overflow: hidden;
}

.minimap-body canvas {
  display: block;
  cursor: crosshair;
}

/* 视口遮罩：半透明白色，可拖动 */
.minimap-mask {
  position: absolute;
  box-sizing: border-box;
  background: rgba(255, 255, 255, 0.16);
  border: 1.5px solid rgba(255, 255, 255, 0.85);
  border-radius: 2px;
  cursor: move;
  transition: background 0.12s ease;
}
.minimap-mask:hover {
  background: rgba(255, 255, 255, 0.26);
}

.eagle-eye-toggle {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 20;
  width: 34px;
  height: 30px;
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-sm);
  background: var(--panel-bg);
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 14px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}
.eagle-eye-toggle:hover {
  color: var(--text-primary);
  border-color: var(--accent);
}

.eagle-eye-label {
  font-size: 10px;
  color: var(--text-tertiary);
  text-align: center;
  padding: 2px 4px;
  background: rgba(22, 27, 34, 0.9);
  border-top: 1px solid var(--panel-border);
  font-variant-numeric: tabular-nums;
}
</style>
