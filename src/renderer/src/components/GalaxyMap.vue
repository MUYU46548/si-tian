<template>
  <div class="galaxy-map-container">
    <div class="map-header">
      <div class="header-left">
        <h2>{{ world?.name }} — 银河系图</h2>
        <p class="hint">
          <span v-if="!editMode">点击星域进入 · 滚动缩放 · 拖拽空白处平移 · 拖拽节点编辑坐标</span>
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
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { useGeodataStore } from '../store/geodata';
import { useCanvasRenderer } from '../composables/useCanvasRenderer';

const props = defineProps({
  world: { type: Object, default: null },
  domains: { type: Array, default: () => [] },
  galaxies: { type: Array, default: () => [] }
});

const emit = defineEmits(['select', 'back', 'dirty', 'select-node']);

const store = useGeodataStore();

const canvas = ref(null);
let domainNodes = [];
let galaxyNodes = [];

// ===== 航道编辑状态 =====
const editMode = ref(false);
let dragSourceNode = null;
let dragMousePos = { x: 0, y: 0 };
let hoveredHyperlane = null;
let targetNode = null;

// ===== 布局计算 =====
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

// ===== 命中测试 =====
function hitTest(wx, wy) {
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

// ===== 绘制逻辑 =====
function onRender(ctx) {
  drawDomainBackgrounds(ctx);
  drawHyperlanes(ctx);
  drawDragPreview(ctx);
  drawDomainNodes(ctx);
  drawGalaxyNodes(ctx);
}

function drawDomainBackgrounds(ctx) {
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

function drawHyperlanes(ctx) {
  const hyperlanes = store.currentDomainHyperlanes;
  const nodeMap = new Map(galaxyNodes.map(g => [g.id, g]));
  
  hyperlanes.forEach(h => {
    const from = nodeMap.get(h.fromId);
    const to = nodeMap.get(h.toId);
    if (!from || !to) return;
    
    const isHovered = hoveredHyperlane === h.id;
    const isUserCreated = !h.id.startsWith('auto_');
    
    if (h.type === 'cross_domain') {
      ctx.strokeStyle = isHovered ? 'rgba(200, 100, 255, 0.9)' : 'rgba(150, 100, 255, 0.5)';
      ctx.lineWidth = isHovered ? 2.5 : 1.5;
      ctx.setLineDash([3, 6]);
    } else if (h.type === 'hyperjump') {
      ctx.strokeStyle = isHovered ? 'rgba(255, 100, 100, 0.9)' : 'rgba(255, 100, 100, 0.4)';
      ctx.lineWidth = isHovered ? 2.5 : 1.5;
      ctx.setLineDash([6, 3]);
    } else {
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

function drawDragPreview(ctx) {
  if (!editMode || !dragSourceNode) return;
  
  ctx.strokeStyle = 'rgba(100, 255, 180, 0.6)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(dragSourceNode.x, dragSourceNode.y);
  ctx.lineTo(dragMousePos.x, dragMousePos.y);
  ctx.stroke();
  ctx.setLineDash([]);
  
  ctx.strokeStyle = 'rgba(100, 255, 180, 0.8)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(dragSourceNode.x, dragSourceNode.y, 14, 0, Math.PI * 2);
  ctx.stroke();
  
  if (targetNode) {
    ctx.strokeStyle = 'rgba(100, 255, 180, 0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(targetNode.x, targetNode.y, 14, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawDomainNodes(ctx) {
  domainNodes.forEach(domain => {
    const matched = store.isNodeMatched(domain.id);
    const isCurrent = store.isCurrentMatch(domain.id);
    
    if (renderer.isFastMode() && !matched) {
      ctx.fillStyle = '#6b5b95';
      ctx.beginPath();
      ctx.arc(domain.x, domain.y, 18, 0, Math.PI * 2);
      ctx.fill();
    } else {
      if (matched) {
        ctx.shadowColor = 'rgba(255, 200, 50, 0.8)';
        ctx.shadowBlur = isCurrent ? 20 : 12;
        ctx.fillStyle = isCurrent ? '#ffd700' : '#ffaa00';
      } else {
        ctx.shadowColor = 'rgba(107, 91, 149, 0.6)';
        ctx.shadowBlur = 10;
        ctx.fillStyle = '#6b5b95';
      }
      ctx.beginPath();
      ctx.arc(domain.x, domain.y, matched ? 20 : 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#9b8bb5';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  });
}

function drawGalaxyNodes(ctx) {
  galaxyNodes.forEach(galaxy => {
    const isSource = editMode && dragSourceNode && dragSourceNode.id === galaxy.id;
    const isTarget = editMode && targetNode && targetNode.id === galaxy.id;
    const matched = store.isNodeMatched(galaxy.id);
    const isCurrent = store.isCurrentMatch(galaxy.id);
    
    ctx.fillStyle = isSource || isTarget ? '#7affb4' : '#4a90d9';
    if (matched) {
      ctx.fillStyle = isCurrent ? '#ffd700' : '#ffaa00';
    }
    if (!renderer.isFastMode()) {
      ctx.shadowColor = isSource || isTarget ? 'rgba(100, 255, 180, 0.5)' : 'rgba(74, 144, 217, 0.4)';
      if (matched) {
        ctx.shadowColor = isCurrent ? 'rgba(255, 200, 50, 0.8)' : 'rgba(255, 170, 0, 0.6)';
      }
      ctx.shadowBlur = matched ? 12 : 5;
    }
    ctx.beginPath();
    ctx.arc(galaxy.x, galaxy.y, matched ? 9 : 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    
    ctx.fillStyle = '#ffd700';
    ctx.beginPath();
    ctx.arc(galaxy.x, galaxy.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    
    if (!renderer.isFastMode()) {
      ctx.fillStyle = isSource || isTarget ? '#7affb4' : '#8b949e';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(galaxy.name, galaxy.x, galaxy.y + 14);
    }
  });
}

// ===== Canvas Renderer =====
const renderer = useCanvasRenderer(canvas, {
  onRender,
  onHitTest: (wx, wy) => hitTest(wx, wy),
  onHover: (hit, wx, wy) => {
    if (editMode) {
      const prevHovered = hoveredHyperlane;
      hoveredHyperlane = hitTestHyperlane(wx, wy)?.id || null;
      if (prevHovered !== hoveredHyperlane) {
        canvas.value.style.cursor = hoveredHyperlane ? 'pointer' : 'default';
      }
    }
  },
  onDragStart: (wx, wy, button) => {
    if (button !== 0) return true;
    
    const hit = hitTest(wx, wy);
    if (!hit) return true;
    
    if (editMode) {
      if (hit.type === 'galaxy') {
        dragSourceNode = hit.node;
        dragMousePos = { x: wx, y: wy };
        return false;
      }
      return true;
    } else {
      return { mode: 'node', nodeId: hit.node.id };
    }
  },
  onDragMove: (wx, wy, dragInfo) => {
    if (dragInfo.mode === 'node') {
      const galaxy = galaxyNodes.find(g => g.id === dragInfo.nodeId);
      if (galaxy) {
        galaxy.x = wx;
        galaxy.y = wy;
        store.updateNodePosition(dragInfo.nodeId, wx, wy);
      }
      return;
    }
    
    if (editMode && dragSourceNode) {
      dragMousePos = { x: wx, y: wy };
      const hit = hitTest(wx, wy);
      targetNode = (hit && hit.type === 'galaxy' && hit.node.id !== dragSourceNode.id) ? hit.node : null;
    }
  },
  onDragEnd: (wx, wy, dragInfo) => {
    if (dragInfo.mode === 'node') {
      store.snapshot();
      emit('dirty', true);
      return;
    }
    
    if (editMode && dragSourceNode) {
      const hit = hitTest(wx, wy);
      if (hit && hit.type === 'galaxy' && hit.node.id !== dragSourceNode.id) {
        const result = store.addHyperlane(dragSourceNode.id, hit.node.id);
        if (result) {
          emit('dirty', true);
        }
      }
      dragSourceNode = null;
      targetNode = null;
    }
  },
  onClick: (hit) => {
    emit('select-node', hit.node);
    
    if (hit.type === 'domain') {
      emit('select', hit.node);
    } else if (hit.type === 'galaxy') {
      const parentDomain = domainNodes.find(d => d.id === hit.node.domainId);
      if (parentDomain) emit('select', parentDomain);
    }
  },
  onContextMenu: (wx, wy) => {
    if (!editMode) return;
    const hyperlane = hitTestHyperlane(wx, wy);
    if (hyperlane) {
      store.removeHyperlane(hyperlane.id);
      emit('dirty', true);
    }
  },
});

// ===== 监听聚焦节点事件 =====
function onFocusNode(e) {
  const node = e.detail;
  if (!node) return;
  const galaxy = galaxyNodes.find(g => g.id === node.id);
  if (galaxy) {
    renderer.focusOn(galaxy.x, galaxy.y, 1.5);
    return;
  }
  const domain = domainNodes.find(d => d.id === node.id);
  if (domain) {
    renderer.focusOn(domain.x, domain.y, 1.2);
    return;
  }
}

// ===== 生命周期 =====
onMounted(() => {
  renderer.initCanvas();
  applyStableLayout();
  renderer.requestRender();
  window.addEventListener('sitian:focus-node', onFocusNode);
});

onUnmounted(() => {
  renderer.cleanupCanvas();
  window.removeEventListener('sitian:focus-node', onFocusNode);
});

// ===== 监听 props 变化 =====
watch(() => [props.galaxies, props.domains], () => {
  applyStableLayout();
  renderer.requestRender();
}, { deep: true });

// ===== 监听 store 航道变化 =====
watch(() => store.currentDomainHyperlanes, () => {
  renderer.requestRender();
});

// ===== 编辑模式切换 =====
function toggleEditMode() {
  editMode.value = !editMode.value;
  dragSourceNode = null;
  targetNode = null;
  hoveredHyperlane = null;
  if (canvas.value) canvas.value.style.cursor = 'default';
  renderer.requestRender();
}

defineExpose({ canvas });
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
