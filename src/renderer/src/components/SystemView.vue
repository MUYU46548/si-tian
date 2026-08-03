<template>
  <div class="system-view-container">
    <div class="map-header">
      <div class="header-left">
        <h2>{{ domain?.name }} — 域内恒星系总览</h2>
        <p class="hint">
          <span v-if="!editMode">点击节点查看详情 · 滚动缩放 · 拖拽空白处平移 · 拖拽节点编辑坐标</span>
          <span v-else class="edit-hint">编辑模式：拖拽恒星间创建航道 · 右键航道删除 · 点击空白取消</span>
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
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useGeodataStore } from '../store/geodata';
import { useCanvasRenderer } from '../composables/useCanvasRenderer';

const store = useGeodataStore();

const props = defineProps({
  domain: { type: Object, default: null },
  systems: { type: Array, default: () => [] },
  planets: { type: Array, default: () => [] },
  locations: { type: Array, default: () => [] }
});

const emit = defineEmits(['back', 'select-node', 'dirty']);

const canvas = ref(null);
let systemLayouts = [];
let hoveredNode = null;
const editMode = ref(false);
let dragSourceNode = null;
let dragMousePos = { x: 0, y: 0 };
let targetNode = null;

const allBodies = computed(() => [...props.planets, ...props.locations]);

// ===== 布局计算 =====
function applyLayout() {
  const systems = props.systems;
  const gridSize = Math.ceil(Math.sqrt(systems.length));
  const spacing = 500;
  
  systemLayouts = systems.map((system, idx) => {
    const col = idx % gridSize;
    const row = Math.floor(idx / gridSize);
    const x = (col - (gridSize - 1) / 2) * spacing;
    const y = (row - (gridSize - 1) / 2) * spacing;
    
    const systemPlanets = allBodies.value.filter(b => b.parentId === system.id);
    
    const planetLayouts = systemPlanets.map((planet, pIdx) => {
      const orbit = Math.floor(pIdx / 3) + 1;
      const posInOrbit = pIdx % 3;
      const angle = (posInOrbit / 3) * Math.PI * 2 + orbit * 0.4;
      const orbitRadius = 40 + orbit * 35;
      return {
        ...planet,
        x: x + Math.cos(angle) * orbitRadius,
        y: y + Math.sin(angle) * orbitRadius,
        orbitRadius,
        angle
      };
    });
    
    return { ...system, x, y, planets: planetLayouts };
  });
}

// ===== 命中测试 =====
function hitTest(wx, wy) {
  for (const system of systemLayouts) {
    const dx = wx - system.x;
    const dy = wy - system.y;
    if (dx * dx + dy * dy < 12 * 12) return { type: 'star', node: system };
  }
  for (const system of systemLayouts) {
    for (const planet of system.planets) {
      const dx = wx - planet.x;
      const dy = wy - planet.y;
      const r = getPlanetRadius(planet.layer) + 3;
      if (dx * dx + dy * dy < r * r) return { type: 'planet', node: planet };
    }
  }
  return null;
}

function hitTestHyperlane(wx, wy) {
  for (let i = 0; i < systemLayouts.length; i++) {
    for (let j = i + 1; j < systemLayouts.length; j++) {
      const s1 = systemLayouts[i];
      const s2 = systemLayouts[j];
      const dist = Math.hypot(s1.x - s2.x, s1.y - s2.y);
      if (dist < 450) {
        const d = pointToSegmentDist(wx, wy, s1.x, s1.y, s2.x, s2.y);
        if (d < 6) return { fromId: s1.id, toId: s2.id };
      }
    }
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

function getPlanetColor(layer) {
  return { planet: '#5cb85c', city: '#f0ad4e', town: '#d9853b', location: '#888888' }[layer] || '#888888';
}

function getPlanetRadius(layer) {
  return { planet: 7, city: 5, town: 4, location: 3 }[layer] || 3;
}

// ===== 绘制逻辑 =====
function onRender(ctx) {
  if (!renderer.isFastMode()) {
    systemLayouts.forEach(system => drawSystemOrbits(ctx, system));
  }
  drawHyperlanes(ctx);
  drawDragPreview(ctx);
  systemLayouts.forEach(system => drawSystemStar(ctx, system));
  systemLayouts.forEach(system => drawSystemPlanets(ctx, system));
}

function drawSystemOrbits(ctx, system) {
  ctx.strokeStyle = 'rgba(100, 150, 200, 0.15)';
  ctx.lineWidth = 1;
  const maxOrbit = system.planets.reduce((max, p) => Math.max(max, p.orbitRadius || 40), 40);
  for (let r = 40; r <= maxOrbit + 30; r += 35) {
    ctx.beginPath();
    ctx.arc(system.x, system.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawHyperlanes(ctx) {
  ctx.setLineDash([3, 5]);
  for (let i = 0; i < systemLayouts.length; i++) {
    for (let j = i + 1; j < systemLayouts.length; j++) {
      const s1 = systemLayouts[i];
      const s2 = systemLayouts[j];
      const dist = Math.hypot(s1.x - s2.x, s1.y - s2.y);
      if (dist < 450) {
        ctx.strokeStyle = 'rgba(100, 150, 200, 0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(s1.x, s1.y);
        ctx.lineTo(s2.x, s2.y);
        ctx.stroke();
      }
    }
  }
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

function drawSystemStar(ctx, system) {
  const matched = store.isNodeMatched(system.id);
  const isCurrent = store.isCurrentMatch(system.id);
  const isHovered = hoveredNode && hoveredNode.id === system.id;
  const isSource = editMode && dragSourceNode && dragSourceNode.id === system.id;
  const isTarget = editMode && targetNode && targetNode.id === system.id;
  
  if (renderer.isFastMode() && !matched && !isHovered) {
    ctx.fillStyle = '#ffd700';
    ctx.beginPath();
    ctx.arc(system.x, system.y, 7, 0, Math.PI * 2);
    ctx.fill();
  } else {
    if (matched) {
      ctx.shadowColor = isCurrent ? 'rgba(255, 200, 50, 0.9)' : 'rgba(255, 170, 0, 0.7)';
      ctx.shadowBlur = isCurrent ? 25 : 15;
    } else if (isHovered || isSource || isTarget) {
      ctx.shadowColor = 'rgba(100, 255, 180, 0.7)';
      ctx.shadowBlur = 15;
    } else {
      ctx.shadowColor = '#ffd700';
      ctx.shadowBlur = 8;
    }
    const gradient = ctx.createRadialGradient(system.x, system.y, 0, system.x, system.y, 25);
    if (matched) {
      gradient.addColorStop(0, isCurrent ? 'rgba(255, 220, 80, 1)' : 'rgba(255, 180, 50, 0.9)');
      gradient.addColorStop(0.3, 'rgba(255, 160, 50, 0.5)');
      gradient.addColorStop(1, 'rgba(255, 120, 50, 0)');
    } else {
      gradient.addColorStop(0, 'rgba(255, 200, 50, 0.8)');
      gradient.addColorStop(0.3, 'rgba(255, 150, 50, 0.4)');
      gradient.addColorStop(1, 'rgba(255, 100, 50, 0)');
    }
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(system.x, system.y, 25, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.fillStyle = matched ? (isCurrent ? '#fff' : '#ffd700') : '#ffd700';
    ctx.beginPath();
    ctx.arc(system.x, system.y, matched ? 9 : 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  
  ctx.fillStyle = '#e2e8f0';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(system.name, system.x, system.y + 20);
}

function drawSystemPlanets(ctx, system) {
  system.planets.forEach(planet => {
    const matched = store.isNodeMatched(planet.id);
    const isCurrent = store.isCurrentMatch(planet.id);
    const isHovered = hoveredNode && hoveredNode.id === planet.id;
    
    if (matched) {
      ctx.fillStyle = isCurrent ? '#ffd700' : '#ffaa00';
      ctx.shadowColor = isCurrent ? 'rgba(255, 200, 50, 0.8)' : 'rgba(255, 170, 0, 0.6)';
      ctx.shadowBlur = isCurrent ? 15 : 8;
    } else if (isHovered) {
      ctx.fillStyle = '#7affb4';
      ctx.shadowColor = 'rgba(100, 255, 180, 0.6)';
      ctx.shadowBlur = 10;
    } else {
      ctx.fillStyle = getPlanetColor(planet.layer);
    }
    ctx.beginPath();
    ctx.arc(planet.x, planet.y, matched ? getPlanetRadius(planet.layer) + 2 : getPlanetRadius(planet.layer), 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();
    
    if (!renderer.isFastMode()) {
      ctx.fillStyle = '#8b949e';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(planet.name, planet.x, planet.y + getPlanetRadius(planet.layer) + 10);
    }
  });
}

// ===== Canvas Renderer =====
const renderer = useCanvasRenderer(canvas, {
  onRender,
  onHitTest: (wx, wy) => hitTest(wx, wy),
  onHover: (hit, wx, wy) => {
    hoveredNode = hit?.node || null;
    if (editMode && dragSourceNode) {
      const h = hitTest(wx, wy);
      targetNode = (h && h.type === 'star' && h.node.id !== dragSourceNode.id) ? h.node : null;
    }
  },
  onDragStart: (wx, wy, button) => {
    if (button !== 0) return true;
    
    const hit = hitTest(wx, wy);
    if (!hit) return true;
    
    if (editMode) {
      if (hit.type === 'star') {
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
      const system = systemLayouts.find(s => s.id === dragInfo.nodeId);
      if (system) {
        system.x = wx;
        system.y = wy;
        store.updateNodePosition(dragInfo.nodeId, wx, wy);
      } else {
        for (const s of systemLayouts) {
          const planet = s.planets.find(p => p.id === dragInfo.nodeId);
          if (planet) {
            planet.x = wx;
            planet.y = wy;
            store.updateNodePosition(dragInfo.nodeId, wx, wy);
            break;
          }
        }
      }
      return;
    }
    
    if (editMode && dragSourceNode) {
      dragMousePos = { x: wx, y: wy };
      const hit = hitTest(wx, wy);
      targetNode = (hit && hit.type === 'star' && hit.node.id !== dragSourceNode.id) ? hit.node : null;
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
      if (hit && hit.type === 'star' && hit.node.id !== dragSourceNode.id) {
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
    if (hit.node) {
      emit('select-node', hit.node);
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
  const sys = systemLayouts.find(s => s.id === node.id);
  if (sys) {
    renderer.focusOn(sys.x, sys.y, 1.5);
  } else {
    for (const s of systemLayouts) {
      const p = s.planets.find(p => p.id === node.id);
      if (p) {
        renderer.focusOn(p.x, p.y, 2);
        break;
      }
    }
  }
}

// ===== 生命周期 =====
onMounted(() => {
  renderer.initCanvas();
  applyLayout();
  renderer.requestRender();
  window.addEventListener('sitian:focus-node', onFocusNode);
});

onUnmounted(() => {
  renderer.cleanupCanvas();
  window.removeEventListener('sitian:focus-node', onFocusNode);
});

// ===== 监听 props 变化 =====
watch(() => [props.systems, props.planets, props.locations], () => {
  applyLayout();
  renderer.requestRender();
}, { deep: true });

// ===== 监听搜索状态变化 =====
watch(() => [store.searchResults, store.searchMatchIndex], () => {
  renderer.requestRender();
}, { deep: true });

// ===== 编辑模式切换 =====
function toggleEditMode() {
  editMode.value = !editMode.value;
  dragSourceNode = null;
  targetNode = null;
  if (canvas.value) canvas.value.style.cursor = 'default';
  renderer.requestRender();
}

defineExpose({ canvas });
</script>

<style scoped>
.system-view-container { display: flex; flex-direction: column; height: 100%; }
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
