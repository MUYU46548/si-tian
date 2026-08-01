<template>
  <div class="galaxy-map-container">
    <div class="map-header">
      <div class="header-left">
        <h2>{{ world?.name }} — 银河系图</h2>
        <p class="hint">
          <span v-if="!editMode">点击星域进入 · 滚动缩放 · 拖拽空白处平移</span>
          <span v-else class="edit-hint">编辑模式：拖拽星系间创建航道 · 右键航道删除 · 点击空白取消</span>
        </p>
      </div>
      <div class="header-actions">
        <button 
          :class="{ active: editMode }" 
          @click="toggleEditMode"
        >
          {{ editMode ? '✓ 完成编辑' : '✎ 编辑航道' }}
        </button>
      </div>
    </div>
    <div class="canvas-wrapper">
      <canvas ref="canvas"></canvas>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useGeodataStore } from '../store/geodata';

const props = defineProps({
  world: { type: Object, default: null },
  domains: { type: Array, default: () => [] },
  galaxies: { type: Array, default: () => [] }
});

const emit = defineEmits(['select', 'back']);

const store = useGeodataStore();

const canvas = ref(null);
let ctx = null;
let viewTransform = { x: 0, y: 0, scale: 1 };
let isPanning = false;
let mouseDownPos = { x: 0, y: 0 };
let isDragOperation = false;

let domainNodes = [];
let galaxyNodes = [];
let rafId = null;
let needsRender = true;
let fastMode = false;

// ===== 航道编辑状态 =====
const editMode = ref(false);
let dragSourceNode = null;      // 拖拽创建航道的源节点
let dragMousePos = { x: 0, y: 0 };  // 当前鼠标世界坐标
let hoveredHyperlane = null;    // 鼠标悬停的航道
let targetNode = null;          // 当前拖拽目标节点

onMounted(() => {
  initCanvas();
  applyStableLayout();
  requestRender();
  window.addEventListener('resize', resizeCanvas);
});

onUnmounted(() => {
  window.removeEventListener('resize', resizeCanvas);
  removeCanvasListeners();
  if (rafId) cancelAnimationFrame(rafId);
});

// 监听 props 变化，重新计算布局
watch(() => [props.galaxies, props.domains], () => {
  applyStableLayout();
  requestRender();
}, { deep: true });

function initCanvas() {
  ctx = canvas.value.getContext('2d');
  resizeCanvas();
  canvas.value.addEventListener('mousedown', onMouseDown);
  canvas.value.addEventListener('mousemove', onMouseMove);
  canvas.value.addEventListener('mouseup', onMouseUp);
  canvas.value.addEventListener('wheel', onWheel, { passive: false });
  canvas.value.addEventListener('contextmenu', onContextMenu);
  canvas.value.addEventListener('mouseleave', onMouseLeave);
}

function removeCanvasListeners() {
  if (!canvas.value) return;
  canvas.value.removeEventListener('mousedown', onMouseDown);
  canvas.value.removeEventListener('mousemove', onMouseMove);
  canvas.value.removeEventListener('mouseup', onMouseUp);
  canvas.value.removeEventListener('wheel', onWheel);
  canvas.value.removeEventListener('contextmenu', onContextMenu);
  canvas.value.removeEventListener('mouseleave', onMouseLeave);
}

function resizeCanvas() {
  const parent = canvas.value.parentElement;
  canvas.value.width = parent.clientWidth;
  canvas.value.height = parent.clientHeight;
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

function applyStableLayout() {
  const domainCount = props.domains.length;
  const spacing = 500;
  
  domainNodes = props.domains.map((domain, idx) => {
    const angle = (idx / Math.max(domainCount, 1)) * Math.PI * 2 - Math.PI / 2;
    const radius = domainCount > 1 ? spacing * 0.7 : 0;
    return {
      ...domain,
      x: domainCount > 1 ? Math.cos(angle) * radius : 0,
      y: domainCount > 1 ? Math.sin(angle) * radius : 0,
      radius: 220
    };
  });
  
  galaxyNodes = [];
  const domainMap = new Map(domainNodes.map(d => [d.id, d]));
  
  props.galaxies.forEach(galaxy => {
    const parentDomain = domainMap.get(galaxy.parentId);
    if (parentDomain) {
      const domainGalaxies = props.galaxies.filter(g => g.parentId === galaxy.parentId);
      const idx = domainGalaxies.indexOf(galaxy);
      const total = domainGalaxies.length;
      const angle = (idx / Math.max(total, 1)) * Math.PI * 2 + 0.3;
      const dist = 70 + (idx % 3) * 40;
      galaxyNodes.push({
        ...galaxy,
        x: parentDomain.x + Math.cos(angle) * dist,
        y: parentDomain.y + Math.sin(angle) * dist,
        domainId: galaxy.parentId
      });
    }
  });
}

function render() {
  if (!ctx || !canvas.value) return;
  const w = canvas.value.width;
  const h = canvas.value.height;
  
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2 + viewTransform.x, h / 2 + viewTransform.y);
  ctx.scale(viewTransform.scale, viewTransform.scale);
  
  drawDomainBackgrounds();
  drawHyperlanes();
  drawDragPreview();
  drawDomainNodes();
  drawGalaxyNodes();
  
  ctx.restore();
}

function drawDomainBackgrounds() {
  domainNodes.forEach(domain => {
    const gradient = ctx.createRadialGradient(domain.x, domain.y, 30, domain.x, domain.y, domain.radius);
    gradient.addColorStop(0, 'rgba(74, 144, 217, 0.12)');
    gradient.addColorStop(0.6, 'rgba(74, 144, 217, 0.04)');
    gradient.addColorStop(1, 'rgba(74, 144, 217, 0.01)');
    
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(domain.x, domain.y, domain.radius, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.strokeStyle = 'rgba(100, 180, 255, 0.4)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    
    ctx.fillStyle = '#a0aec0';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(domain.name, domain.x, domain.y - domain.radius - 12);
  });
}

// ===== 航道绘制 =====
function drawHyperlanes() {
  const hyperlanes = store.currentDomainHyperlanes;
  const nodeMap = new Map(galaxyNodes.map(g => [g.id, g]));
  
  hyperlanes.forEach(h => {
    const from = nodeMap.get(h.fromId);
    const to = nodeMap.get(h.toId);
    if (!from || !to) return;
    
    const isHovered = hoveredHyperlane === h.id;
    const isUserCreated = !h.id.startsWith('auto_');
    
    // 样式规则
    if (h.type === 'cross_domain') {
      ctx.strokeStyle = isHovered ? 'rgba(200, 100, 255, 0.9)' : 'rgba(150, 100, 255, 0.5)';
      ctx.lineWidth = isHovered ? 2.5 : 1.5;
      ctx.setLineDash([3, 6]);
    } else if (h.type === 'hyperjump') {
      ctx.strokeStyle = isHovered ? 'rgba(255, 100, 100, 0.9)' : 'rgba(255, 100, 100, 0.4)';
      ctx.lineWidth = isHovered ? 2.5 : 1.5;
      ctx.setLineDash([6, 3]);
    } else {
      // local
      if (isUserCreated) {
        ctx.strokeStyle = isHovered ? 'rgba(100, 255, 180, 0.9)' : 'rgba(100, 255, 180, 0.45)';
        ctx.lineWidth = isHovered ? 2 : 1.2;
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = isHovered ? 'rgba(100, 200, 255, 0.6)' : 'rgba(100, 150, 200, 0.25)';
        ctx.lineWidth = isHovered ? 1.5 : 1;
        ctx.setLineDash([]);
      }
    }
    
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    
    // 如果有控制点，使用贝塞尔曲线
    if (h.controlPoints && h.controlPoints.length > 0) {
      if (h.controlPoints.length === 1) {
        ctx.quadraticCurveTo(h.controlPoints[0].x, h.controlPoints[0].y, to.x, to.y);
      } else {
        ctx.bezierCurveTo(
          h.controlPoints[0].x, h.controlPoints[0].y,
          h.controlPoints[1].x, h.controlPoints[1].y,
          to.x, to.y
        );
      }
    } else {
      ctx.lineTo(to.x, to.y);
    }
    ctx.stroke();
    
    // 编辑模式下在航道中点显示小圆点（表示可交互）
    if (editMode && isHovered) {
      const midX = (from.x + to.x) / 2;
      const midY = (from.y + to.y) / 2;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.beginPath();
      ctx.arc(midX, midY, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  ctx.setLineDash([]);
}

// ===== 拖拽预览线 =====
function drawDragPreview() {
  if (!editMode || !dragSourceNode) return;
  
  ctx.strokeStyle = 'rgba(100, 255, 180, 0.6)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(dragSourceNode.x, dragSourceNode.y);
  ctx.lineTo(dragMousePos.x, dragMousePos.y);
  ctx.stroke();
  ctx.setLineDash([]);
  
  // 源节点高亮圈
  ctx.strokeStyle = 'rgba(100, 255, 180, 0.8)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(dragSourceNode.x, dragSourceNode.y, 14, 0, Math.PI * 2);
  ctx.stroke();
  
  // 目标节点高亮圈
  if (targetNode) {
    ctx.strokeStyle = 'rgba(100, 255, 180, 0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(targetNode.x, targetNode.y, 14, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawDomainNodes() {
  domainNodes.forEach(domain => {
    if (fastMode) {
      ctx.fillStyle = '#6b5b95';
      ctx.beginPath();
      ctx.arc(domain.x, domain.y, 18, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.shadowColor = 'rgba(107, 91, 149, 0.6)';
      ctx.shadowBlur = 10;
      ctx.fillStyle = '#6b5b95';
      ctx.beginPath();
      ctx.arc(domain.x, domain.y, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#9b8bb5';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  });
}

function drawGalaxyNodes() {
  galaxyNodes.forEach(galaxy => {
    const isSource = editMode && dragSourceNode && dragSourceNode.id === galaxy.id;
    const isTarget = editMode && targetNode && targetNode.id === galaxy.id;
    
    ctx.fillStyle = isSource || isTarget ? '#7affb4' : '#4a90d9';
    if (!fastMode) {
      ctx.shadowColor = isSource || isTarget ? 'rgba(100, 255, 180, 0.5)' : 'rgba(74, 144, 217, 0.4)';
      ctx.shadowBlur = 5;
    }
    ctx.beginPath();
    ctx.arc(galaxy.x, galaxy.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    
    ctx.fillStyle = '#ffd700';
    ctx.beginPath();
    ctx.arc(galaxy.x, galaxy.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    
    if (!fastMode) {
      ctx.fillStyle = isSource || isTarget ? '#7affb4' : '#8b949e';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(galaxy.name, galaxy.x, galaxy.y + 14);
    }
  });
}

// ===== 坐标转换 =====
function screenToWorld(sx, sy) {
  return {
    x: (sx - canvas.value.width / 2 - viewTransform.x) / viewTransform.scale,
    y: (sy - canvas.value.height / 2 - viewTransform.y) / viewTransform.scale
  };
}

// ===== 命中测试 =====
function hitTest(wx, wy) {
  // 增大命中半径到 18px
  for (const galaxy of galaxyNodes) {
    const dx = wx - galaxy.x;
    const dy = wy - galaxy.y;
    if (dx * dx + dy * dy < 18 * 18) return { type: 'galaxy', node: galaxy };
  }
  for (const domain of domainNodes) {
    const dx = wx - domain.x;
    const dy = wy - domain.y;
    if (dx * dx + dy * dy < 22 * 22) return { type: 'domain', node: domain };
  }
  return null;
}

// 航道命中测试：点到线段距离
function hitTestHyperlane(wx, wy) {
  const hyperlanes = store.currentDomainHyperlanes;
  const nodeMap = new Map(galaxyNodes.map(g => [g.id, g]));
  
  for (const h of hyperlanes) {
    const from = nodeMap.get(h.fromId);
    const to = nodeMap.get(h.toId);
    if (!from || !to) continue;
    
    const dist = pointToSegmentDist(wx, wy, from.x, from.y, to.x, to.y);
    if (dist < 6) return h;
  }
  return null;
}

function pointToSegmentDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const closestX = x1 + t * dx;
  const closestY = y1 + t * dy;
  return Math.hypot(px - closestX, py - closestY);
}

// ===== 鼠标事件 =====
function onMouseDown(e) {
  const rect = canvas.value.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  mouseDownPos = { x: mx, y: my };
  
  if (editMode) {
    // 编辑模式下：左键拖拽创建航道
    if (e.button === 0) {
      const world = screenToWorld(mx, my);
      const hit = hitTest(world.x, world.y);
      if (hit && hit.type === 'galaxy') {
        // 开始拖拽创建航道
        dragSourceNode = hit.node;
        dragMousePos = world;
        isDragOperation = true;
      } else {
        // 空白处拖拽 = 平移
        isPanning = true;
        isDragOperation = false;
      }
    }
  } else {
    isPanning = true;
    isDragOperation = false;
  }
}

function onMouseMove(e) {
  const rect = canvas.value.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  
  if (editMode) {
    const world = screenToWorld(mx, my);
    dragMousePos = world;
    
    // 悬停检测航道
    const prevHovered = hoveredHyperlane;
    hoveredHyperlane = hitTestHyperlane(world.x, world.y)?.id || null;
    if (prevHovered !== hoveredHyperlane) {
      canvas.value.style.cursor = hoveredHyperlane ? 'pointer' : 'default';
      requestRender();
    }
    
    // 拖拽时检测目标节点
    if (dragSourceNode) {
      const hit = hitTest(world.x, world.y);
      const newTarget = (hit && hit.type === 'galaxy' && hit.node.id !== dragSourceNode.id) ? hit.node : null;
      if (newTarget?.id !== targetNode?.id) {
        targetNode = newTarget;
        canvas.value.style.cursor = targetNode ? 'pointer' : 'default';
      }
      requestRender();
      return;
    }
  }
  
  if (!isPanning) return;
  
  const dx = mx - mouseDownPos.x;
  const dy = my - mouseDownPos.y;
  
  if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
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

function onMouseUp(e) {
  isPanning = false;
  
  if (editMode && dragSourceNode) {
    // 拖拽创建航道
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    const hit = hitTest(world.x, world.y);
    
    if (hit && hit.type === 'galaxy' && hit.node.id !== dragSourceNode.id) {
      // 创建航道
      const result = store.addHyperlane(dragSourceNode.id, hit.node.id);
      if (result) {
        // 标记 dirty
        emit('dirty', true);
      }
    }
    
    dragSourceNode = null;
    targetNode = null;
    isDragOperation = false;
    requestRender();
    return;
  }
  
  if (!isDragOperation) {
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    const hit = hitTest(world.x, world.y);
    if (hit) {
      if (hit.type === 'domain') {
        emit('select', hit.node);
      } else if (hit.type === 'galaxy') {
        const parentDomain = domainNodes.find(d => d.id === hit.node.domainId);
        if (parentDomain) emit('select', parentDomain);
      }
    }
  } else {
    fastMode = false;
    requestRender();
  }
  isDragOperation = false;
}

function onMouseLeave() {
  dragSourceNode = null;
  targetNode = null;
  hoveredHyperlane = null;
  isPanning = false;
  isDragOperation = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  needsRender = true;
  requestRender();
}

function onContextMenu(e) {
  e.preventDefault();
  if (!editMode) return;
  
  const rect = canvas.value.getBoundingClientRect();
  const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  const hyperlane = hitTestHyperlane(world.x, world.y);
  
  if (hyperlane) {
    store.removeHyperlane(hyperlane.id);
    emit('dirty', true);
    requestRender();
  }
}

function onWheel(e) {
  e.preventDefault();
  const rect = canvas.value.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  const newScale = Math.max(0.2, Math.min(3, viewTransform.scale * delta));
  
  const wx = (mx - canvas.value.width / 2 - viewTransform.x) / viewTransform.scale;
  const wy = (my - canvas.value.height / 2 - viewTransform.y) / viewTransform.scale;
  
  viewTransform.x = mx - canvas.value.width / 2 - wx * newScale;
  viewTransform.y = my - canvas.value.height / 2 - wy * newScale;
  viewTransform.scale = newScale;
  
  requestRender();
}

// ===== 编辑模式切换 =====
function toggleEditMode() {
  editMode.value = !editMode.value;
  dragSourceNode = null;
  targetNode = null;
  hoveredHyperlane = null;
  canvas.value.style.cursor = 'default';
  requestRender();
}

// 当数据变化时重绘
watch(() => store.currentDomainHyperlanes, () => {
  requestRender();
});
</script>

<style scoped>
.galaxy-map-container { display: flex; flex-direction: column; height: 100%; }
.map-header { 
  padding: 12px 16px; 
  border-bottom: 1px solid #30363d; 
  background: #161b22; 
  display: flex; 
  justify-content: space-between; 
  align-items: center;
}
.header-left { display: flex; flex-direction: column; }
.header-actions { display: flex; gap: 8px; }
.header-actions button {
  padding: 6px 14px;
  border: 1px solid #30363d;
  border-radius: 4px;
  background: #21262d;
  color: #c9d1d9;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s;
}
.header-actions button:hover { background: #30363d; }
.header-actions button.active {
  background: #0d4718;
  border-color: #2ea043;
  color: #7affb4;
}
.map-header h2 { font-size: 14px; color: #f0f6fc; margin-bottom: 4px; }
.hint { font-size: 11px; color: #8b949e; }
.edit-hint { color: #7affb4; }
.canvas-wrapper { flex: 1; position: relative; overflow: hidden; }
canvas { display: block; width: 100%; height: 100%; }
</style>