<template>
  <!-- 关闭状态：迷你展开按钮 -->
  <button v-if="!visible" class="eagle-eye-toggle" @click="open" title="显示鹰眼导航">🗺</button>
  <!-- 打开状态：鹰眼主体 -->
  <div v-else class="eagle-eye" ref="container">
    <button class="eagle-eye-close" @click="close" title="隐藏鹰眼">×</button>
    <canvas ref="canvas" @click="handleClick"></canvas>
    <div class="eagle-eye-label">鹰眼导航</div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';

const props = defineProps({
  // 当前视图的世界坐标范围
  viewBounds: { type: Object, required: true },
  // 所有要绘制的元素
  elements: { type: Array, default: () => [] },
  // 整体地图边界
  worldBounds: { type: Object, default: () => ({ minX: -500, maxX: 500, minY: -500, maxY: 500 }) },
});

const emit = defineEmits(['navigate']);

// 独立开关（localStorage 持久化，跨会话保留）
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
  nextTick(initCanvas);
}

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
  ctx.fillStyle = '#0D1117';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  
  // 绘制所有元素
  for (const el of props.elements) {
    if (el.type === 'polygon' && el.points && el.points.length >= 3) {
      // 多边形（省份）
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
      // 圆形（节点/星域/星系/行星）
      const pos = worldToScreen(el.x, el.y);
      ctx.fillStyle = el.color || '#4a90d9';
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, el.r || 3, 0, Math.PI * 2);
      ctx.fill();
    } else if (el.type === 'node' && el.x !== undefined) {
      // 节点（带光晕）
      const pos = worldToScreen(el.x, el.y);
      const r = el.r || 4;
      
      // 光晕
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
      // 线段（航道/连接线）
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
      // 文本标签
      const pos = worldToScreen(el.x, el.y);
      ctx.fillStyle = el.color || '#8b949e';
  ctx.font = `${el.size || 6}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(el.text || '', pos.x, pos.y);
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
    ctx.fillStyle = 'rgba(255, 107, 107, 0.1)';
    ctx.fillRect(
      topLeft.x,
      topLeft.y,
      bottomRight.x - topLeft.x,
      bottomRight.y - topLeft.y
    );
  }
  
  // 边框
  ctx.strokeStyle = '#30363d';
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
  canvas.value.width = WIDTH;
  canvas.value.height = HEIGHT;
  ctx = canvas.value.getContext('2d');
  render();
}

onMounted(() => {
  initCanvas();
});

watch([() => props.elements, () => props.viewBounds, () => props.worldBounds], () => {
  render();
}, { deep: true });

</script>

<style scoped>
.eagle-eye {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 20;
  background: rgba(13, 17, 23, 0.95);
  border: 1px solid #30363d;
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  overflow: hidden;
}

.eagle-eye-close {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  color: #8b949e;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  z-index: 2;
  border-radius: 3px;
}
.eagle-eye-close:hover {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
}

.eagle-eye-toggle {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 20;
  width: 34px;
  height: 30px;
  border: 1px solid #30363d;
  border-radius: 4px;
  background: rgba(13, 17, 23, 0.9);
  color: #8b949e;
  cursor: pointer;
  font-size: 14px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}
.eagle-eye-toggle:hover {
  color: #fff;
  border-color: #58a6ff;
}

canvas {
  display: block;
  cursor: pointer;
  width: 160px;
  height: 120px;
}

.eagle-eye-label {
  font-size: 10px;
  color: #8b949e;
  text-align: center;
  padding: 2px 0;
  background: #161b22;
  border-top: 1px solid #30363d;
}
</style>
