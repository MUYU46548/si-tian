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
        <button v-if="editMode" title="在当前星域创建恒星系（视图中心）" @click="createSystem">
          ＋ 恒星系
        </button>
        <button v-if="editMode" title="在选中恒星系下创建行星（无选中则归属最近恒星系）" @click="createPlanet">
          ＋ 行星
        </button>
      </div>
    </div>
    <div class="canvas-wrapper">
      <canvas ref="canvas"></canvas>
      <div
        v-if="contextMenu.visible"
        class="context-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
        @mousedown.stop
      >
        <div v-if="contextMenu.target?.type === 'star'" class="menu-item" @click="ctxAddPlanet">＋ 添加行星</div>
        <div v-if="contextMenu.target?.type === 'star' || contextMenu.target?.type === 'planet'" class="menu-item danger" @click="ctxDeleteNode">🗑 删除该节点</div>
        <div v-if="contextMenu.target?.type === 'hyperlane'" class="menu-item danger" @click="ctxDeleteHyperlane">🗑 删除航道</div>
        <div v-if="!contextMenu.target" class="menu-item" @click="ctxCreateSystemHere">＋ 在此创建恒星系</div>
      </div>
      <eagle-eye
        :view-bounds="systemViewBounds"
        :elements="systemEyeElements"
        :world-bounds="systemWorldBounds"
        @navigate="handleSystemEagleNavigate"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useGeodataStore } from '../store/geodata';
import { useLayersStore } from '../store/layers';
import { useCanvasRenderer } from '../composables/useCanvasRenderer';
import EagleEye from './EagleEye.vue';

const store = useGeodataStore();
const layers = useLayersStore();

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

// ===== 右键菜单与选中状态 =====
const selectedSystemId = ref(null);
const contextMenu = ref({ visible: false, x: 0, y: 0, target: null, worldX: 0, worldY: 0 });

function worldToScreen(wx, wy) {
  const vt = renderer.getViewTransform();
  const cvs = canvas.value;
  return {
    x: wx * vt.scale + vt.x + cvs.clientWidth / 2,
    y: wy * vt.scale + vt.y + cvs.clientHeight / 2,
  };
}

function openContextMenu(wx, wy, target) {
  const pos = worldToScreen(wx, wy);
  const wrapper = canvas.value?.parentElement;
  const maxX = wrapper ? wrapper.clientWidth - 170 : pos.x;
  const maxY = wrapper ? wrapper.clientHeight - 110 : pos.y;
  contextMenu.value = {
    visible: true,
    x: Math.max(4, Math.min(pos.x, maxX)),
    y: Math.max(4, Math.min(pos.y, maxY)),
    target,
    worldX: wx,
    worldY: wy,
  };
}

function closeContextMenu() {
  contextMenu.value.visible = false;
}

function createSystemAt(wx, wy, namePrefix = '新恒星系') {
  const newSystem = {
    id: `galaxy_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    name: `${namePrefix}${Date.now() % 1000}`,
    layer: 'galaxy',
    parentId: props.domain?.id || null,
    tags: ['新创建'],
    sourcePath: '',
    coordinate: { x: Math.round(wx), y: Math.round(wy) },
    userMoved: true, // 创建位置即用户意图，布局重算时保留
  };
  store.addNode(newSystem);
  selectedSystemId.value = newSystem.id;
  emit('dirty', true);
  renderer.requestRender();
}

function createSystem() {
  const vt = renderer.getViewTransform();
  const cx = -vt.x / vt.scale;
  const cy = -vt.y / vt.scale;
  createSystemAt(cx, cy);
}

function getTargetSystemId() {
  if (selectedSystemId.value && systemLayouts.some(s => s.id === selectedSystemId.value)) {
    return selectedSystemId.value;
  }
  // 无选中 → 最近视图中心的恒星系
  const vt = renderer.getViewTransform();
  const cx = -vt.x / vt.scale;
  const cy = -vt.y / vt.scale;
  let best = null;
  let minD = Infinity;
  for (const s of systemLayouts) {
    const d = Math.hypot(s.x - cx, s.y - cy);
    if (d < minD) { minD = d; best = s; }
  }
  return best?.id || null;
}

function createPlanet() {
  const parentId = getTargetSystemId();
  if (!parentId) {
    // 无任何恒星系 → 先创建一个
    createSystem();
    return;
  }
  const parent = systemLayouts.find(s => s.id === parentId);
  // 轨道位置（与 applyLayout 的 orbit 算法一致，首次布局即落在轨道上）
  const siblings = allBodies.value.filter(b => b.parentId === parentId);
  const pIdx = siblings.length;
  const orbit = Math.floor(pIdx / 3) + 1;
  const posInOrbit = pIdx % 3;
  const angle = (posInOrbit / 3) * Math.PI * 2 + orbit * 0.4;
  const orbitRadius = 40 + orbit * 35;
  const newPlanet = {
    id: `planet_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    name: `新行星${Date.now() % 1000}`,
    layer: 'planet',
    parentId,
    tags: ['新创建'],
    sourcePath: '',
    coordinate: {
      x: Math.round(parent.x + Math.cos(angle) * orbitRadius),
      y: Math.round(parent.y + Math.sin(angle) * orbitRadius),
    },
    userMoved: true,
  };
  store.addNode(newPlanet);
  emit('dirty', true);
  renderer.requestRender();
}

function deleteNodeById(nodeId) {
  store.removeNode(nodeId);
  // 本地布局缓存同步过滤（store 变化通过 watch 触发 applyLayout 兜底）
  systemLayouts = systemLayouts.filter(s => s.id !== nodeId);
  for (const s of systemLayouts) {
    s.planets = s.planets.filter(p => p.id !== nodeId);
  }
  if (selectedSystemId.value === nodeId) selectedSystemId.value = null;
  emit('dirty', true);
  renderer.requestRender();
}

// ===== 右键菜单操作 =====
function ctxAddPlanet() {
  const sys = contextMenu.value.target?.node;
  if (sys) {
    selectedSystemId.value = sys.id;
    createPlanet();
  }
  closeContextMenu();
}

function ctxDeleteNode() {
  const node = contextMenu.value.target?.node;
  if (node) deleteNodeById(node.id);
  closeContextMenu();
}

function ctxDeleteHyperlane() {
  const hl = contextMenu.value.target?.hyperlane;
  if (hl) {
    store.removeHyperlane(hl.id);
    emit('dirty', true);
    renderer.requestRender();
  }
  closeContextMenu();
}

function ctxCreateSystemHere() {
  createSystemAt(contextMenu.value.worldX, contextMenu.value.worldY, '新恒星系');
  closeContextMenu();
}

const allBodies = computed(() => props.planets);

// ===== 布局计算 =====
function applyLayout() {
  const systems = props.systems;
  const gridSize = Math.ceil(Math.sqrt(systems.length));
  const spacing = 500;
  
  systemLayouts = systems.map((system, idx) => {
    const col = idx % gridSize;
    const row = Math.floor(idx / gridSize);
    const gridX = (col - (gridSize - 1) / 2) * spacing;
    const gridY = (row - (gridSize - 1) / 2) * spacing;
    // 用户手动放置过的恒星系坐标优先保留
    const sysSaved = system.userMoved && system.coordinate?.x !== null && system.coordinate?.x !== undefined;
    const sysX = sysSaved ? system.coordinate.x : gridX;
    const sysY = sysSaved ? system.coordinate.y : gridY;
    
    const systemPlanets = allBodies.value.filter(b => b.parentId === system.id);
    
    const planetLayouts = systemPlanets.map((planet, pIdx) => {
      const orbit = Math.floor(pIdx / 3) + 1;
      const posInOrbit = pIdx % 3;
      const angle = (posInOrbit / 3) * Math.PI * 2 + orbit * 0.4;
      const orbitRadius = 40 + orbit * 35;
      // 行星同样保留手动坐标
      const plSaved = planet.userMoved && planet.coordinate?.x !== null && planet.coordinate?.x !== undefined;
      return {
        ...planet,
        x: plSaved ? planet.coordinate.x : sysX + Math.cos(angle) * orbitRadius,
        y: plSaved ? planet.coordinate.y : sysY + Math.sin(angle) * orbitRadius,
        orbitRadius,
        angle
      };
    });
    
    return { ...system, x: sysX, y: sysY, planets: planetLayouts };
  });
}

// ===== 命中测试 =====
function hitTest(wx, wy) {
  if (!layers.isVisible('system', 'nodes')) return null;
  
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
function drawDeepSpaceBackground(ctx) {
  // 深空渐变背景（以原点为亮核，覆盖视图范围）
  const bg = ctx.createRadialGradient(0, 0, 0, 0, 0, 1800);
  bg.addColorStop(0, '#161d33');
  bg.addColorStop(0.5, '#101527');
  bg.addColorStop(1, '#0a0e1c');
  ctx.fillStyle = bg;
  ctx.fillRect(-3000, -3000, 6000, 6000);

  // 星云（2 个，确定性位置）
  const nebulae = [
    { x: -500, y: -300, r: 420, color: 'rgba(80, 110, 200, 0.07)' },
    { x: 400, y: 250, r: 380, color: 'rgba(130, 70, 160, 0.06)' },
  ];
  for (const neb of nebulae) {
    const g = ctx.createRadialGradient(neb.x, neb.y, 0, neb.x, neb.y, neb.r);
    g.addColorStop(0, neb.color);
    g.addColorStop(0.6, neb.color.replace('0.', '0.0'));
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.fillRect(neb.x - neb.r, neb.y - neb.r, neb.r * 2, neb.r * 2);
  }

  // 星尘 3 层（确定性随机，避免渲染抖动）
  for (let layer = 0; layer < 3; layer++) {
    const alpha = 0.1 + layer * 0.05;
    const count = 150 + layer * 60;
    const sizeBase = 0.4 + layer * 0.3;
    ctx.fillStyle = `rgba(220, 230, 245, ${alpha})`;
    for (let i = layer * 200; i < count; i++) {
      const x = ((i * 97 + 23) % 2500) - 1250;
      const y = ((i * 61 + 41) % 2500) - 1250;
      const size = sizeBase + (i % 4) * 0.25;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 导航星（少量明亮白星）
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  for (let i = 0; i < 10; i++) {
    const x = ((i * 137 + 53) % 2200) - 1100;
    const y = ((i * 89 + 67) % 2200) - 1100;
    ctx.beginPath();
    ctx.arc(x, y, 1.3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function onRender(ctx) {
  drawDeepSpaceBackground(ctx);
  if (layers.isVisible('system', 'orbits')) {
    if (!renderer.isFastMode()) {
      systemLayouts.forEach(system => drawSystemOrbits(ctx, system));
    }
  }
  if (layers.isVisible('system', 'hyperlanes')) {
    drawHyperlanes(ctx);
  }
  if (layers.isVisible('system', 'nodes')) {
    systemLayouts.forEach(system => drawSystemStar(ctx, system));
    systemLayouts.forEach(system => drawSystemPlanets(ctx, system));
  }
  if (layers.isVisible('system', 'editHelpers')) {
    drawDragPreview(ctx);
  }
}

function drawSystemOrbits(ctx, system) {
  ctx.strokeStyle = 'rgba(110, 170, 230, 0.22)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  const maxOrbit = system.planets.reduce((max, p) => Math.max(max, p.orbitRadius || 40), 40);
  for (let r = 40; r <= maxOrbit + 30; r += 35) {
    ctx.beginPath();
    ctx.arc(system.x, system.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);
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
  ctx.fillText(system.displayName || system.name, system.x, system.y + 20);

  // 选中恒星系 → 金色虚线环
  if (selectedSystemId.value === system.id) {
    ctx.strokeStyle = 'rgba(255, 215, 0, 0.9)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.arc(system.x, system.y, 32, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
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
      ctx.fillText(planet.displayName || planet.name, planet.x, planet.y + getPlanetRadius(planet.layer) + 10);
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
  onDragStart: (wx, wy, button, shiftKey, ctrlKey, panTry) => {
    if (button !== 0) return true;
    
    // panTry=true：pan 模式的顶点试探，本组件无顶点拖拽，直接允许平移
    if (panTry) return true;
    
    const hit = hitTest(wx, wy);
    if (!hit) return true;
    
    // 锁定节点不可拖拽（仍可选中）
    if ((hit.type === 'star' || hit.type === 'planet') && hit.node.locked) {
      return true;
    }
    
    if (editMode) {
      if (hit.type === 'star') {
        dragSourceNode = hit.node;
        dragMousePos = { x: wx, y: wy };
        return false;
      }
      return true;
    } else {
      if (hit.type === 'star' || hit.type === 'planet') {
        store.beginNodePositionCapture(hit.node.id);
      }
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
      store.endNodePositionCapture();
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
    closeContextMenu();
    if (hit?.node) {
      if (hit.type === 'star') selectedSystemId.value = hit.node.id;
      if (hit.type === 'planet') {
        const parent = systemLayouts.find(s => s.id === hit.node.parentId);
        if (parent) selectedSystemId.value = parent.id;
      }
      emit('select-node', hit.node);
    }
  },
  onContextMenu: (wx, wy) => {
    const hit = hitTest(wx, wy);
    let target = null;
    if (hit?.type === 'star' || hit?.type === 'planet') {
      target = { type: hit.type, node: hit.node };
    } else {
      const hyperlane = hitTestHyperlane(wx, wy);
      if (hyperlane) {
        target = { type: 'hyperlane', hyperlane };
      }
    }
    openContextMenu(wx, wy, target);
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

// ===== 监听节点移除事件（NodeDetailPanel 删除后同步布局） =====
function onNodeRemovedFromMap(e) {
  const nodeId = e.detail;
  if (!nodeId) return;
  if (selectedSystemId.value === nodeId) selectedSystemId.value = null;
  // 从本地布局缓存中过滤（store.nodes 变化会触发 deep watch 重建布局）
  systemLayouts = systemLayouts.filter(s => s.id !== nodeId);
  for (const s of systemLayouts) {
    s.planets = s.planets.filter(p => p.id !== nodeId);
  }
  renderer.requestRender();
}

// ===== 生命周期 =====
onMounted(() => {
  renderer.initCanvas();
  applyLayout();
  renderer.requestRender();
  window.addEventListener('sitian:focus-node', onFocusNode);
  window.addEventListener('sitian:node-removed-from-map', onNodeRemovedFromMap);
});

onUnmounted(() => {
  renderer.cleanupCanvas();
  window.removeEventListener('sitian:focus-node', onFocusNode);
  window.removeEventListener('sitian:node-removed-from-map', onNodeRemovedFromMap);
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
  closeContextMenu();
  if (canvas.value) canvas.value.style.cursor = 'default';
  renderer.requestRender();
}

// ===== 鹰眼导航 =====
const systemWorldBounds = computed(() => {
  if (!systemLayouts.length) {
    return { minX: -500, maxX: 500, minY: -500, maxY: 500 };
  }
  
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  
  for (const s of systemLayouts) {
    minX = Math.min(minX, s.x - 40);
    maxX = Math.max(maxX, s.x + 40);
    minY = Math.min(minY, s.y - 40);
    maxY = Math.max(maxY, s.y + 40);
    for (const p of s.planets) {
      minX = Math.min(minX, p.x - 10);
      maxX = Math.max(maxX, p.x + 10);
      minY = Math.min(minY, p.y - 10);
      maxY = Math.max(maxY, p.y + 10);
    }
  }
  
  const padding = 50;
  return {
    minX: minX - padding,
    maxX: maxX + padding,
    minY: minY - padding,
    maxY: maxY + padding,
  };
});

const systemViewBounds = computed(() => {
  const vt = renderer.getViewTransform();
  const cvs = canvas.value;
  if (!cvs) return systemWorldBounds.value;
  
  const w = cvs.clientWidth / vt.scale;
  const h = cvs.clientHeight / vt.scale;
  const cx = -vt.x / vt.scale;
  const cy = -vt.y / vt.scale;
  
  return {
    minX: cx - w / 2,
    maxX: cx + w / 2,
    minY: cy - h / 2,
    maxY: cy + h / 2,
  };
});

const systemEyeElements = computed(() => {
  const elements = [];
  
  // 恒星系节点（金色大点）
  for (const s of systemLayouts) {
    elements.push({
      type: 'node',
      x: s.x,
      y: s.y,
      r: 4,
      color: '#ffd700',
      glow: false,
    });
  }
  
  // 行星节点（彩色小点）
  for (const s of systemLayouts) {
    for (const p of s.planets) {
      const color = getPlanetColor(p.layer);
      elements.push({
        type: 'node',
        x: p.x,
        y: p.y,
        r: 2,
        color: color,
        glow: false,
      });
    }
  }
  
  // 航道（虚线）
  for (let i = 0; i < systemLayouts.length; i++) {
    for (let j = i + 1; j < systemLayouts.length; j++) {
      const s1 = systemLayouts[i];
      const s2 = systemLayouts[j];
      const dist = Math.hypot(s1.x - s2.x, s1.y - s2.y);
      if (dist < 450) {
        elements.push({
          type: 'line',
          from: { x: s1.x, y: s1.y },
          to: { x: s2.x, y: s2.y },
          color: 'rgba(100, 150, 200, 0.3)',
          lineWidth: 0.5,
          dashed: true,
        });
      }
    }
  }
  
  return elements;
});

function handleSystemEagleNavigate(world) {
  const vt = renderer.getViewTransform();
  vt.x = -world.x * vt.scale;
  vt.y = -world.y * vt.scale;
  renderer.requestRender();
}

defineExpose({ canvas, renderer });
</script>

<style scoped>
.system-view-container { display: flex; flex-direction: column; height: 100%; }
.map-header { 
  padding: 12px 16px; 
  border-bottom: 1px solid var(--map-header-border); 
  background: var(--map-header-bg); 
  display: flex; 
  justify-content: space-between;
  align-items: center;
}
.header-left { display: flex; flex-direction: column; }
.header-actions { display: flex; gap: 8px; }
.header-actions button {
  padding: 6px 14px;
  border: 1px solid var(--map-btn-border);
  border-radius: 4px;
  background: var(--map-btn-bg);
  color: var(--map-btn-text);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s;
}
.header-actions button:hover { background: var(--map-btn-hover); }
.header-actions button.active {
  background: var(--map-accent-green-bg);
  border-color: var(--map-accent-green-border);
  color: var(--map-accent-green);
}
.map-header h2 { font-size: 14px; color: var(--map-text-heading); margin-bottom: 4px; }
.hint { font-size: 11px; color: var(--map-text-hint); }
.edit-hint { color: var(--map-accent-green); }
.canvas-wrapper { flex: 1; position: relative; overflow: hidden; }
canvas { display: block; width: 100%; height: 100%; background: var(--map-bg); }

/* ===== 右键菜单 ===== */
.context-menu {
  position: absolute;
  z-index: 30;
  min-width: 150px;
  padding: 4px 0;
  border: 1px solid var(--map-header-border, #2a3550);
  border-radius: 6px;
  background: var(--map-header-bg, #151c2e);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
  user-select: none;
}
.context-menu .menu-item {
  padding: 7px 14px;
  font-size: 12px;
  color: var(--map-btn-text, #c9d4e8);
  cursor: pointer;
  white-space: nowrap;
}
.context-menu .menu-item:hover { background: rgba(100, 150, 200, 0.15); }
.context-menu .menu-item.danger { color: #ff7b72; }
.context-menu .menu-item.danger:hover { background: rgba(255, 123, 114, 0.12); }
</style>
