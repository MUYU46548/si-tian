<template>
  <div class="eagle-eye" ref="container">
    <canvas ref="canvas" @click="handleClick"></canvas>
    <div class="eagle-eye-label">鹰眼导航</div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';

const props = defineProps({
  // 当前视图的世界坐标范围
  viewBounds: { type: Object, required: true },
  // 所有要绘制的元素
  elements: { type: Array, default: () => [] },
  // 整体地图边界
  worldBounds: { type: Object, default: () => ({ minX: -500, maxX: 500, minY: -500, maxY: 500 }) },
});

const emit = defineEmits(['navigate']);

const container = ref(null);
const canvas = ref(null);
let ctx = null;

// 缩略图尺寸
const WIDTH = 160;
const HEIGHT = 120;
const PADDING = 10;

// 计算世界坐标到缩略图坐标的映射
const scale = computed(() => {
  const { minX, maxX, minY, maxY } = props.worldBounds;
  const worldW = maxX - minX || 1000;
  const worldH = maxY - minY || 1000;
  const scaleX = (WIDTH - PADDING * 2) / worldW;
  const scaleY = (HEIGHT - PADDING * 2) / worldH;
  return Math.min(scaleX, scaleY);
});

function worldToScreen(wx, wy) {
  const { minX, minY } = props.worldBounds;
  const s = scale.value;
  return {
    x: PADDING + (wx - minX) * s,
    y: PADDING + (wy - minY) * s,
  };
}

function screenToWorld(sx, sy) {
  const { minX, minY } = props.worldBounds;
  const s = scale.value;
  return {
    x: (sx - PADDING) / s + minX,
    y: (sy - PADDING) / s + minY,
  };
}

function render() {
  if (!ctx) return;
  
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  
  // 背景
  ctx.fillStyle = '#F5F5F5';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  
  // 绘制所有元素（简化）
  for (const el of props.elements) {
    if (el.type === 'polygon' && el.points && el.points.length >= 3) {
      ctx.fillStyle = el.color || '#A3C4BC';
      ctx.beginPath();
      const first = worldToScreen(el.points[0].x, el.points[0].y);
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < el.points.length; i++) {
        const pt = worldToScreen(el.points[i].x, el.points[i].y);
        ctx.lineTo(pt.x, pt.y);
      }
      ctx.closePath();
      ctx.fill();
    }
  }
  
  // 绘制当前视图矩形
  if (props.viewBounds) {
    const { minX, maxX, minY, maxY } = props.viewBounds;
    const topLeft = worldToScreen(minX, minY);
    const bottomRight = worldToScreen(maxX, maxY);
    
    ctx.strokeStyle = '#FF6B6B';
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.strokeRect(
      topLeft.x,
      topLeft.y,
      bottomRight.x - topLeft.x,
      bottomRight.y - topLeft.y
    );
    
    // 视图矩形半透明填充
    ctx.fillStyle = 'rgba(255, 107, 107, 0.15)';
    ctx.fillRect(
      topLeft.x,
      topLeft.y,
      bottomRight.x - topLeft.x,
      bottomRight.y - topLeft.y
    );
  }
  
  // 边框
  ctx.strokeStyle = '#DDD';
  ctx.lineWidth = 1;
  ctx.strokeRect(0, 0, WIDTH, HEIGHT);
}

function handleClick(e) {
  const rect = canvas.value.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const world = screenToWorld(sx, sy);
  emit('navigate', world);
}

function initCanvas() {
  if (!canvas.value) return;
  ctx = canvas.value.getContext('2d');
  render();
}

onMounted(() => {
  initCanvas();
});

watch([() => props.elements, () => props.viewBounds], () => {
  render();
}, { deep: true });

</script>

<style scoped>
.eagle-eye {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 20;
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid #DDD;
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  overflow: hidden;
}

canvas {
  display: block;
  cursor: pointer;
}

.eagle-eye-label {
  font-size: 10px;
  color: #999;
  text-align: center;
  padding: 2px 0;
  background: #FAFAFA;
  border-top: 1px solid #EEE;
}
</style>
