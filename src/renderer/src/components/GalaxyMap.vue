<template>
  <div class="galaxy-map-container">
    <div class="map-header">
      <div class="header-left">
        <h2>{{ world?.name }} — 银河系图</h2>
        <p class="hint">
          <span v-if="!editMode">点击恒星进入 · 滚动缩放 · 拖拽空白处平移 · 拖拽恒星编辑坐标</span>
          <span v-else class="edit-hint">编辑模式：拖拽恒星间创建航道 · 右键航道删除 · 拖拽边界顶点编辑势力范围 · 点击空白取消</span>
        </p>
      </div>
      <div class="header-actions">
        <select 
          v-model="nextHyperlaneType" 
          class="hyperlane-type-select"
          title="选择要创建的航道类型"
        >
          <option value="local">域内航道</option>
          <option value="cross_domain">跨域航道</option>
          <option value="hyperjump">超空间跳跃</option>
        </select>
        <button 
          :class="{ active: filterPanelOpen }" 
          @click="filterPanelOpen = !filterPanelOpen"
          title="节点筛选"
        >⚡ 筛选</button>
        <button 
          :class="{ active: editMode }" 
          @click="toggleEditMode"
        >
          {{ editMode ? '✓ 完成编辑' : '✎ 编辑航道' }}
        </button>
        <button 
          v-if="editMode"
          @click="createGalaxy"
          title="在当前视图中心创建恒星"
        >＋ 恒星</button>
      </div>
    </div>

    <!-- 节点筛选面板 -->
    <div v-if="filterPanelOpen" class="filter-panel-galaxy">
      <div class="filter-section">
        <div class="filter-section-title">按层级显示</div>
        <label v-for="layer in availableFilterLayers" :key="layer" class="filter-chip" :class="{ active: layerFilter.includes(layer) }">
          <input type="checkbox" :value="layer" v-model="layerFilter" />
          <span>{{ layerLabels[layer] || layer }}</span>
        </label>
      </div>
      <div class="filter-section" v-if="availableFilterTags.length > 0">
        <div class="filter-section-title">按标签显示</div>
        <label v-for="tag in availableFilterTags" :key="tag" class="filter-chip" :class="{ active: tagFilter.includes(tag) }">
          <input type="checkbox" :value="tag" v-model="tagFilter" />
          <span>{{ tag }}</span>
        </label>
      </div>
      <div class="filter-section">
        <button class="filter-reset" @click="layerFilter = []; tagFilter = []">重置</button>
      </div>
    </div>
    
    <!-- 势力图例 -->
    <div class="faction-legend">
      <span 
        v-for="domain in domains" 
        :key="domain.id"
        class="legend-item"
        :style="{ '--faction-color': domain.factionColor || getFactionColor(domain.faction) }"
      >
        <input 
          type="color" 
          class="legend-color-picker"
          :value="getFactionColor(domain.faction)"
          @input="setFactionColor(domain.faction, $event.target.value)"
          @click.stop
          title="点击修改势力颜色"
        />
        <span class="legend-dot"></span>
        {{ domain.name }}
      </span>
    </div>
    
    <div class="canvas-wrapper">
      <canvas ref="canvas"></canvas>
      <eagle-eye
        :view-bounds="galaxyViewBounds"
        :elements="galaxyEyeElements"
        :world-bounds="galaxyWorldBounds"
        @navigate="handleGalaxyEagleNavigate"
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

const props = defineProps({
  world: { type: Object, default: null },
  domains: { type: Array, default: () => [] },
  galaxies: { type: Array, default: () => [] }
});

const emit = defineEmits(['select', 'back', 'dirty', 'select-node']);

const store = useGeodataStore();
const layers = useLayersStore();

const canvas = ref(null);
let domainNodes = [];
const galaxyNodes = ref([]);
const selectedNodeIds = ref(new Set());

// ===== 框选状态 =====
let isBoxSelecting = false;
let boxSelectStart = { x: 0, y: 0 };
let boxSelectEnd = { x: 0, y: 0 };
let isDraggingMultiple = false;
let dragMultipleStart = { x: 0, y: 0 };

// ===== 航道编辑状态 =====
const editMode = ref(false);
let dragSourceNode = null;
let dragMousePos = { x: 0, y: 0 };
let hoveredHyperlane = null;
let targetNode = null;
const nextHyperlaneType = ref('local');
const filterPanelOpen = ref(false);
const layerFilter = ref([]);
const tagFilter = ref([]);
const factionColorOverrides = ref({});
let draggedHyperlaneMidpoint = null;
let draggedControlPoint = null;

// ===== 可用过滤选项 =====
const availableFilterLayers = computed(() => {
  const layers = new Set();
  galaxyNodes.value.forEach(g => { if (g.layer) layers.add(g.layer); });
  return Array.from(layers).sort();
});

const availableFilterTags = computed(() => {
  const tags = new Set();
  galaxyNodes.value.forEach(g => (g.tags || []).forEach(t => tags.add(t)));
  return Array.from(tags).sort();
});

const layerLabels = {
  world: '世界', star_domain: '星域', galaxy: '星系', star: '恒星',
  planet: '行星', moon: '卫星', region: '区域', city: '城市',
  town: '城镇', village: '村庄', facility: '设施', location: '地点', unknown: '未知'
};

// ===== 过滤后的节点列表 =====
const filteredGalaxyNodes = computed(() => {
  return galaxyNodes.value.filter(g => {
    if (layerFilter.value.length > 0 && !layerFilter.value.includes(g.layer)) return false;
    if (tagFilter.value.length > 0 && !tagFilter.value.some(t => g.tags?.includes(t))) return false;
    return true;
  });
});

// ===== 势力边界编辑 =====
// 注意：直接访问 store.domainBorderOverrides 保持响应式（Pinia 自动解包 ref）
function getBorderPoints(domainId) {
  const overrides = store.domainBorderOverrides;
  if (overrides && overrides[domainId]) {
    return overrides[domainId];
  }
  return null;
}

function setBorderPoints(domainId, points) {
  store.domainBorderOverrides[domainId] = points;
}

function resetBorderOverride(domainId) {
  if (store.domainBorderOverrides[domainId]) {
    delete store.domainBorderOverrides[domainId];
  }
}

// ===== 势力边界编辑状态 =====
const editingBoundary = ref(null);
const hoveredBoundaryVertex = ref(null);

// ===== 时间 =====
let animationTime = 0;

// ===== 势力颜色 =====
const FACTION_COLORS = {
  '蓝镜帝国': '#4A90D9',
  '绿野联邦': '#5CB85C',
  '赤焰王国': '#E74C3C',
  '紫晶商会': '#9B59B6',
  '金辉共和国': '#F39C12',
  '青霜联盟': '#1ABC9C',
  '橙光同盟': '#E67E22',
  '银月帝国': '#95A5A6',
};

function getFactionColor(faction) {
  if (!faction) return '#6b5b95';
  if (factionColorOverrides.value[faction]) return factionColorOverrides.value[faction];
  if (FACTION_COLORS[faction]) return FACTION_COLORS[faction];
  let hash = 0;
  for (let i = 0; i < faction.length; i++) {
    hash = faction.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 60%)`;
}

function setFactionColor(faction, color) {
  factionColorOverrides.value[faction] = color;
}

// ===== 凸包算法（Graham Scan）=====
function convexHull(points) {
  if (points.length < 3) return points;
  
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (O, A, B) => (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
  
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// ===== 布局计算 =====
function applyStableLayout() {
  const domainCount = props.domains.length;
  const spacing = 700;
  
  domainNodes = props.domains.map((domain, idx) => {
    const angle = (idx / Math.max(domainCount, 1)) * Math.PI * 2 - Math.PI / 2;
    const radius = domainCount > 1 ? spacing * 0.9 : 0;
    return {
      ...domain,
      x: domainCount > 1 ? Math.cos(angle) * radius : 0,
      y: domainCount > 1 ? Math.sin(angle) * radius : 0,
      factionColor: domain.factionColor || getFactionColor(domain.faction),
      radius: 350
    };
  });
  
  galaxyNodes.value = [];
  const domainMap = new Map(domainNodes.map(d => [d.id, d]));
  
  props.galaxies.forEach(galaxy => {
    const parentDomain = domainMap.get(galaxy.parentId);
    if (parentDomain) {
      const domainGalaxies = props.galaxies.filter(g => g.parentId === galaxy.parentId);
      const idx = domainGalaxies.indexOf(galaxy);
      const total = domainGalaxies.length;
      const angle = (idx / Math.max(total, 1)) * Math.PI * 2 + 0.3;
      const dist = 100 + (idx % 4) * 60;
      galaxyNodes.value.push({
        ...galaxy,
        x: parentDomain.x + Math.cos(angle) * dist,
        y: parentDomain.y + Math.sin(angle) * dist,
        domainId: galaxy.parentId,
        factionColor: parentDomain.factionColor
      });
    }
  });
}

// ===== 计算势力边界（凸包）=====
function computeFactionBorders() {
  const borders = [];
  const domainGalaxyMap = new Map();
  
  for (const galaxy of galaxyNodes.value) {
    if (!domainGalaxyMap.has(galaxy.domainId)) {
      domainGalaxyMap.set(galaxy.domainId, []);
    }
    domainGalaxyMap.get(galaxy.domainId).push(galaxy);
  }
  
  for (const domain of domainNodes) {
    const galaxies = domainGalaxyMap.get(domain.id);
    const override = getBorderPoints(domain.id);
    
    if (override) {
      borders.push({
        domainId: domain.id,
        name: domain.name,
        color: domain.factionColor,
        points: override,
        center: { x: domain.x, y: domain.y },
      });
      continue;
    }
    
    if (!galaxies || galaxies.length < 3) {
      const center = { x: domain.x, y: domain.y };
      const radius = domain.radius || 200;
      const circlePoints = [];
      const segments = 12;
      for (let i = 0; i < segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        circlePoints.push({
          x: center.x + Math.cos(angle) * radius,
          y: center.y + Math.sin(angle) * radius,
        });
      }
      borders.push({
        domainId: domain.id,
        name: domain.name,
        color: domain.factionColor,
        points: circlePoints,
        center,
      });
      continue;
    }
    
    const points = galaxies.map(g => ({ x: g.x, y: g.y }));
    const hull = convexHull(points);
    
    const center = { x: 0, y: 0 };
    for (const p of hull) { center.x += p.x; center.y += p.y; }
    center.x /= hull.length;
    center.y /= hull.length;
    
    const expandedHull = hull.map(p => {
      const dx = p.x - center.x;
      const dy = p.y - center.y;
      const dist = Math.hypot(dx, dy) || 1;
      return {
        x: p.x + (dx / dist) * 50,
        y: p.y + (dy / dist) * 50,
      };
    });
    
    borders.push({
      domainId: domain.id,
      name: domain.name,
      color: domain.factionColor,
      points: expandedHull,
      center,
    });
  }
  
  return borders;
}

// ===== 命中测试 =====
function hitTest(wx, wy) {
  if (!layers.isVisible('domain', 'nodes')) return null;
  
  const nodes = filteredGalaxyNodes.value;
  for (const galaxy of nodes) {
    const dx = wx - galaxy.x;
    const dy = wy - galaxy.y;
    if (dx * dx + dy * dy < 16 * 16) return { type: 'galaxy', node: galaxy };
  }
  
  if (editMode.value) {
    const borders = computeFactionBorders();
    for (const border of borders) {
      for (let i = 0; i < border.points.length; i++) {
        const p = border.points[i];
        const dx = wx - p.x;
        const dy = wy - p.y;
        if (dx * dx + dy * dy < 12 * 12) {
          return { type: 'boundary-vertex', border, vertexIndex: i };
        }
      }
    }
  }
  
  return null;
}

function hitTestHyperlane(wx, wy) {
  const hyperlanes = store.currentDomainHyperlanes;
  const nodeMap = new Map(galaxyNodes.value.map(g => [g.id, g]));
  
  let closest = null;
  let closestDist = 10;
  
  for (const h of hyperlanes) {
    const from = nodeMap.get(h.fromId);
    const to = nodeMap.get(h.toId);
    if (!from || !to) continue;
    
    if (editMode.value && h.controlPoints && h.controlPoints.length > 0) {
      for (let i = 0; i < h.controlPoints.length; i++) {
        const cp = h.controlPoints[i];
        const dx = wx - cp.x;
        const dy = wy - cp.y;
        if (dx * dx + dy * dy < 10 * 10) {
          return { hyperlane: h, controlPointIndex: i };
        }
      }
    }
    
    const dist = pointToSegmentDist(wx, wy, from.x, from.y, to.x, to.y);
    if (dist < closestDist) {
      closestDist = dist;
      closest = { hyperlane: h };
    }
  }
  return closest;
}

function getHyperlaneMidpoint(h) {
  const nodeMap = new Map(galaxyNodes.value.map(g => [g.id, g]));
  const from = nodeMap.get(h.fromId);
  const to = nodeMap.get(h.toId);
  if (!from || !to) return null;
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
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
function onRender(ctx, w, h) {
  const scale = renderer.getViewTransform().scale;
  const lod = Math.min(1, Math.max(0, (scale - 0.3) / 0.7));
  animationTime = performance.now() / 1000;
  
  drawStarfield(ctx, w, h);
  
  if (layers.isVisible('domain', 'background')) {
    drawFactionBorders(ctx, lod);
  }
  
  if (layers.isVisible('domain', 'hyperlanes')) {
    drawHyperlanes(ctx);
  }
  
  if (layers.isVisible('domain', 'nodes')) {
    drawGalaxyNodes(ctx, lod);
  }
  
  if (layers.isVisible('domain', 'editHelpers')) {
    drawDragPreview(ctx);
    drawBoundaryEditHelpers(ctx);
    drawBoxSelect(ctx);
  }
  
  // 绘制选中节点高亮
  drawSelectedNodes(ctx);
}

// ===== 背景 =====
function drawStarfield(ctx, w, h) {
  const bgGradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 3500);
  bgGradient.addColorStop(0, '#1a2035');
  bgGradient.addColorStop(0.4, '#141828');
  bgGradient.addColorStop(0.7, '#0e1220');
  bgGradient.addColorStop(1, '#0a0e18');
  ctx.fillStyle = bgGradient;
  ctx.fillRect(-5000, -5000, 10000, 10000);
  
  const nebulae = [
    { x: 300, y: -200, r: 600, color: 'rgba(60, 90, 180, 0.08)' },
    { x: -400, y: 300, r: 500, color: 'rgba(120, 60, 150, 0.07)' },
    { x: 100, y: 400, r: 400, color: 'rgba(60, 150, 120, 0.06)' },
    { x: -200, y: -350, r: 450, color: 'rgba(150, 100, 60, 0.05)' },
  ];
  
  for (const neb of nebulae) {
    const nebGradient = ctx.createRadialGradient(neb.x, neb.y, 0, neb.x, neb.y, neb.r);
    nebGradient.addColorStop(0, neb.color);
    nebGradient.addColorStop(0.5, neb.color.replace('0.', '0.0'));
    nebGradient.addColorStop(1, 'transparent');
    ctx.fillStyle = nebGradient;
    ctx.fillRect(neb.x - neb.r, neb.y - neb.r, neb.r * 2, neb.r * 2);
  }
  
  ctx.strokeStyle = 'rgba(60, 80, 120, 0.18)';
  ctx.lineWidth = 0.5;
  const gridSize = 200;
  for (let gx = -2500; gx <= 2500; gx += gridSize) {
    ctx.beginPath();
    ctx.moveTo(gx, -2500);
    ctx.lineTo(gx, 2500);
    ctx.stroke();
  }
  for (let gy = -2500; gy <= 2500; gy += gridSize) {
    ctx.beginPath();
    ctx.moveTo(-2500, gy);
    ctx.lineTo(2500, gy);
    ctx.stroke();
  }
  
  for (let layer = 0; layer < 4; layer++) {
    const alpha = 0.12 + layer * 0.06;
    const count = 200 + layer * 80;
    const sizeBase = 0.5 + layer * 0.4;
    ctx.fillStyle = `rgba(220, 230, 245, ${alpha})`;
    for (let i = layer * 300; i < count; i++) {
      const x = ((i * 97 + 23) % 3500) - 1750;
      const y = ((i * 61 + 41) % 3500) - 1750;
      const size = sizeBase + (i % 4) * 0.3;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  
  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
  for (let i = 0; i < 15; i++) {
    const x = ((i * 137 + 53) % 3000) - 1500;
    const y = ((i * 89 + 67) % 3000) - 1500;
    ctx.beginPath();
    ctx.arc(x, y, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ===== 势力边界 =====
function drawFactionBorders(ctx, lod) {
  const borders = computeFactionBorders();
  
  for (const border of borders) {
    if (border.points.length < 3) continue;
    
    const isEditing = editingBoundary.value?.domainId === border.domainId;
    
    ctx.save();
    ctx.shadowColor = border.color;
    ctx.shadowBlur = isEditing ? 50 : 35;
    ctx.beginPath();
    ctx.moveTo(border.points[0].x, border.points[0].y);
    for (let i = 1; i < border.points.length; i++) {
      ctx.lineTo(border.points[i].x, border.points[i].y);
    }
    ctx.closePath();
    ctx.fillStyle = border.color + '12';
    ctx.fill();
    ctx.restore();
    
    const gradient = ctx.createRadialGradient(
      border.center.x, border.center.y, 0,
      border.center.x, border.center.y, 400
    );
    gradient.addColorStop(0, border.color + '35');
    gradient.addColorStop(0.5, border.color + '22');
    gradient.addColorStop(1, border.color + '10');
    
    ctx.beginPath();
    ctx.moveTo(border.points[0].x, border.points[0].y);
    for (let i = 1; i < border.points.length; i++) {
      ctx.lineTo(border.points[i].x, border.points[i].y);
    }
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
    
    ctx.strokeStyle = border.color + '60';
    ctx.lineWidth = isEditing ? 8 : 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(border.points[0].x, border.points[0].y);
    for (let i = 1; i < border.points.length; i++) {
      ctx.lineTo(border.points[i].x, border.points[i].y);
    }
    ctx.closePath();
    ctx.stroke();
    
    ctx.strokeStyle = border.color + (isEditing ? 'FF' : 'CC');
    ctx.lineWidth = isEditing ? 3.5 : 2.5;
    ctx.beginPath();
    ctx.moveTo(border.points[0].x, border.points[0].y);
    for (let i = 1; i < border.points.length; i++) {
      ctx.lineTo(border.points[i].x, border.points[i].y);
    }
    ctx.closePath();
    ctx.stroke();
    
    if (lod > 0.4) {
      const cx = border.center.x;
      const cy = border.center.y;
      
      ctx.font = `bold ${Math.round(14 * lod)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      
      const text = border.name;
      const metrics = ctx.measureText(text);
      const padding = 10;
      
      ctx.fillStyle = border.color + 'EE';
      ctx.beginPath();
      ctx.roundRect(
        cx - metrics.width / 2 - padding,
        cy - 14 * lod,
        metrics.width + padding * 2,
        28 * lod,
        8
      );
      ctx.fill();
      
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.6;
      ctx.stroke();
      ctx.globalAlpha = 1.0;
      
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(text, cx, cy);
    }
  }
}

// ===== 航道 =====
function drawHyperlanes(ctx) {
  const hyperlanes = store.currentDomainHyperlanes;
  const nodeMap = new Map(galaxyNodes.value.map(g => [g.id, g]));
  
  hyperlanes.forEach(h => {
    const from = nodeMap.get(h.fromId);
    const to = nodeMap.get(h.toId);
    if (!from || !to) return;
    
    const isHovered = hoveredHyperlane === h.id;
    const isUserCreated = !h.id.startsWith('auto_');
    
    let baseColor, glowColor, lineWidth;
    
    if (h.type === 'cross_domain') {
      baseColor = isHovered ? 'rgba(230, 160, 255, 1.0)' : 'rgba(200, 140, 255, 0.65)';
      glowColor = 'rgba(200, 140, 255, 0.4)';
      lineWidth = isHovered ? 3 : 2;
    } else if (h.type === 'hyperjump') {
      baseColor = isHovered ? 'rgba(255, 130, 130, 1.0)' : 'rgba(255, 110, 110, 0.55)';
      glowColor = 'rgba(255, 110, 110, 0.4)';
      lineWidth = isHovered ? 3 : 2;
    } else {
      if (isUserCreated) {
        baseColor = isHovered ? 'rgba(100, 255, 200, 1.0)' : 'rgba(100, 255, 180, 0.7)';
        glowColor = 'rgba(100, 255, 180, 0.4)';
        lineWidth = isHovered ? 2.5 : 2;
      } else {
        baseColor = isHovered ? 'rgba(130, 210, 255, 0.9)' : 'rgba(100, 200, 255, 0.5)';
        glowColor = 'rgba(100, 200, 255, 0.3)';
        lineWidth = isHovered ? 2 : 1.5;
      }
    }
    
    ctx.save();
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = isHovered ? 20 : 12;
    ctx.strokeStyle = glowColor;
    ctx.lineWidth = lineWidth + 6;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    if (h.controlPoints && h.controlPoints.length === 1) {
      ctx.quadraticCurveTo(h.controlPoints[0].x, h.controlPoints[0].y, to.x, to.y);
    } else if (h.controlPoints && h.controlPoints.length >= 2) {
      ctx.bezierCurveTo(
        h.controlPoints[0].x, h.controlPoints[0].y,
        h.controlPoints[1].x, h.controlPoints[1].y,
        to.x, to.y
      );
    } else {
      ctx.lineTo(to.x, to.y);
    }
    ctx.stroke();
    ctx.restore();
    
    ctx.strokeStyle = baseColor;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    
    if (h.type === 'cross_domain') {
      ctx.setLineDash([5, 10]);
      ctx.lineDashOffset = -animationTime * 25;
    } else if (h.type === 'hyperjump') {
      ctx.setLineDash([10, 5]);
      ctx.lineDashOffset = -animationTime * 35;
    } else if (isUserCreated) {
      ctx.setLineDash([]);
    } else {
      ctx.setLineDash([4, 8]);
      ctx.lineDashOffset = -animationTime * 15;
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
    ctx.setLineDash([]);
    
    if (editMode.value && isHovered) {
      const midX = (from.x + to.x) / 2;
      const midY = (from.y + to.y) / 2;
      
      if (!h.controlPoints || h.controlPoints.length === 0) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.shadowColor = 'rgba(255, 255, 255, 0.9)';
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(midX, midY, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      
      if (h.controlPoints && h.controlPoints.length > 0) {
        h.controlPoints.forEach((cp, i) => {
          ctx.fillStyle = 'rgba(255, 200, 50, 0.95)';
          ctx.shadowColor = 'rgba(255, 200, 50, 0.9)';
          ctx.shadowBlur = 12;
          ctx.beginPath();
          ctx.arc(cp.x, cp.y, 7, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
          
          ctx.strokeStyle = 'rgba(255, 200, 50, 0.4)';
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 2]);
          ctx.beginPath();
          if (i === 0) {
            ctx.moveTo(from.x, from.y);
          } else {
            ctx.moveTo(h.controlPoints[i-1].x, h.controlPoints[i-1].y);
          }
          ctx.lineTo(cp.x, cp.y);
          ctx.stroke();
          ctx.setLineDash([]);
        });
        
        if (h.controlPoints.length === 1) {
          ctx.strokeStyle = 'rgba(255, 200, 50, 0.4)';
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 2]);
          ctx.beginPath();
          ctx.moveTo(h.controlPoints[0].x, h.controlPoints[0].y);
          ctx.lineTo(to.x, to.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
  });
}

// ===== 恒星节点 =====
function drawGalaxyNodes(ctx, lod) {
  const nodes = filteredGalaxyNodes.value;
  nodes.forEach(galaxy => {
    const isSource = editMode.value && dragSourceNode && dragSourceNode.id === galaxy.id;
    const isTarget = editMode.value && targetNode && targetNode.id === galaxy.id;
    const matched = store.isNodeMatched(galaxy.id);
    const isCurrent = store.isCurrentMatch(galaxy.id);
    
    const baseColor = galaxy.factionColor || '#4a90d9';
    const isHighlighted = isSource || isTarget || matched;
    
    let starColor = baseColor;
    if (isSource || isTarget) starColor = '#7affb4';
    if (matched) starColor = isCurrent ? '#ffd700' : '#ffaa00';
    
    const baseRadius = matched ? 8 : 6;
    
    if (lod < 0.35) {
      ctx.fillStyle = starColor;
      ctx.shadowColor = starColor;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(galaxy.x, galaxy.y, baseRadius + 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      return;
    }
    
    const flicker = 0.88 + Math.sin(animationTime * 4 + galaxy.x * 0.05) * 0.12;
    
    const glowRadius = baseRadius * (matched ? 12 : 8) * flicker;
    const glowGradient = ctx.createRadialGradient(
      galaxy.x, galaxy.y, 0,
      galaxy.x, galaxy.y, glowRadius
    );
    glowGradient.addColorStop(0, starColor + 'CC');
    glowGradient.addColorStop(0.25, starColor + '66');
    glowGradient.addColorStop(0.5, starColor + '22');
    glowGradient.addColorStop(0.75, starColor + '08');
    glowGradient.addColorStop(1, 'transparent');
    ctx.fillStyle = glowGradient;
    ctx.beginPath();
    ctx.arc(galaxy.x, galaxy.y, glowRadius, 0, Math.PI * 2);
    ctx.fill();
    
    if (lod > 0.45 && isHighlighted) {
      const spikeLength = glowRadius * 1.8 * flicker;
      const spikeWidth = 1.5;
      ctx.strokeStyle = starColor + '50';
      ctx.lineWidth = spikeWidth;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(galaxy.x - spikeLength, galaxy.y);
      ctx.lineTo(galaxy.x + spikeLength, galaxy.y);
      ctx.moveTo(galaxy.x, galaxy.y - spikeLength);
      ctx.lineTo(galaxy.x, galaxy.y + spikeLength);
      ctx.stroke();
      
      const diagLength = spikeLength * 0.5;
      ctx.strokeStyle = starColor + '30';
      ctx.lineWidth = spikeWidth * 0.7;
      ctx.beginPath();
      ctx.moveTo(galaxy.x - diagLength, galaxy.y - diagLength);
      ctx.lineTo(galaxy.x + diagLength, galaxy.y + diagLength);
      ctx.moveTo(galaxy.x + diagLength, galaxy.y - diagLength);
      ctx.lineTo(galaxy.x - diagLength, galaxy.y + diagLength);
      ctx.stroke();
    }
    
    ctx.fillStyle = starColor;
    ctx.beginPath();
    ctx.arc(galaxy.x, galaxy.y, baseRadius, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.fillStyle = '#FFFFFF';
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.arc(galaxy.x, galaxy.y, baseRadius * 0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1.0;
    
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(galaxy.x - 1.5, galaxy.y - 1.5, baseRadius * 0.3, 0, Math.PI * 2);
    ctx.fill();
    
    if (lod > 0.65 && galaxy.name) {
      const labelY = galaxy.y + baseRadius + 12;
      
      ctx.font = `${matched ? 'bold ' : ''}10px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      
      const text = galaxy.name;
      const metrics = ctx.measureText(text);
      const padding = 5;
      
      ctx.fillStyle = 'rgba(15, 22, 35, 0.85)';
      ctx.fillRect(
        galaxy.x - metrics.width / 2 - padding,
        labelY - 2,
        metrics.width + padding * 2,
        14
      );
      
      ctx.fillStyle = isHighlighted ? starColor : 'rgba(230, 240, 255, 0.95)';
      ctx.fillText(text, galaxy.x, labelY);
    }
  });
}

function drawDragPreview(ctx) {
  if (!editMode.value || !dragSourceNode) return;
  
  ctx.save();
  ctx.shadowColor = 'rgba(100, 255, 180, 0.6)';
  ctx.shadowBlur = 15;
  ctx.strokeStyle = 'rgba(100, 255, 180, 0.8)';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(dragSourceNode.x, dragSourceNode.y);
  ctx.lineTo(dragMousePos.x, dragMousePos.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
  
  ctx.save();
  ctx.shadowColor = 'rgba(100, 255, 180, 0.9)';
  ctx.shadowBlur = 20;
  ctx.strokeStyle = 'rgba(100, 255, 180, 1.0)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(dragSourceNode.x, dragSourceNode.y, 14, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  
  if (targetNode) {
    ctx.save();
    ctx.shadowColor = 'rgba(100, 255, 180, 0.9)';
    ctx.shadowBlur = 20;
    ctx.strokeStyle = 'rgba(100, 255, 180, 1.0)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(targetNode.x, targetNode.y, 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawBoundaryEditHelpers(ctx) {
  const borders = computeFactionBorders();
  
  for (const border of borders) {
    for (let i = 0; i < border.points.length; i++) {
      const p = border.points[i];
      const isHovered = hoveredBoundaryVertex.value?.domainId === border.domainId && 
                        hoveredBoundaryVertex.value?.vertexIndex === i;
      
      ctx.save();
      ctx.shadowColor = isHovered ? '#FF6B6B' : border.color;
      ctx.shadowBlur = isHovered ? 15 : 8;
      ctx.fillStyle = isHovered ? '#FF6B6B' : border.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, isHovered ? 10 : 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, isHovered ? 10 : 7, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function drawBoxSelect(ctx) {
  if (!isBoxSelecting) return;
  
  const minX = Math.min(boxSelectStart.x, boxSelectEnd.x);
  const maxX = Math.max(boxSelectStart.x, boxSelectEnd.x);
  const minY = Math.min(boxSelectStart.y, boxSelectEnd.y);
  const maxY = Math.max(boxSelectStart.y, boxSelectEnd.y);
  
  ctx.save();
  ctx.strokeStyle = 'rgba(88, 166, 255, 0.8)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
  ctx.setLineDash([]);
  
  ctx.fillStyle = 'rgba(88, 166, 255, 0.1)';
  ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
  ctx.restore();
}

function drawSelectedNodes(ctx) {
  if (selectedNodeIds.value.size === 0) return;
  
  galaxyNodes.value.forEach(g => {
    if (!selectedNodeIds.value.has(g.id)) return;
    
    ctx.save();
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(g.x, g.y, 18, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  });
}

// ===== Canvas Renderer =====
const renderer = useCanvasRenderer(canvas, {
  onRender,
  onHitTest: (wx, wy) => hitTest(wx, wy),
  onHover: (hit, wx, wy) => {
    if (editMode.value) {
      const prevHovered = hoveredHyperlane;
      const hitResult = hitTestHyperlane(wx, wy);
      hoveredHyperlane = hitResult?.hyperlane?.id || null;
      if (prevHovered !== hoveredHyperlane) {
        canvas.value.style.cursor = hoveredHyperlane ? 'pointer' : 'default';
      }
    }
    
    if (hit?.type === 'boundary-vertex') {
      hoveredBoundaryVertex.value = { domainId: hit.border.domainId, vertexIndex: hit.vertexIndex };
      canvas.value.style.cursor = 'pointer';
    } else if (hit?.type !== 'galaxy') {
      hoveredBoundaryVertex.value = null;
    }
  },
  onDragStart: (wx, wy, button, shiftKey, ctrlKey) => {
    if (button !== 0) return true;
    
    // 控制点拖拽（最高优先级）
    if (editMode.value) {
      const hit = hitTestHyperlane(wx, wy);
      if (hit?.controlPointIndex !== undefined) {
        draggedControlPoint = { hyperlaneId: hit.hyperlane.id, cpIndex: hit.controlPointIndex, startX: wx, startY: wy };
        panSuppressed = true;
        return false;
      }
      
      // 拖拽航道中点生成控制点
      if (hit?.hyperlane) {
        const mid = getHyperlaneMidpoint(hit.hyperlane);
        if (mid) {
          const dx = wx - mid.x;
          const dy = wy - mid.y;
          if (dx * dx + dy * dy < 12 * 12) {
            draggedHyperlaneMidpoint = { hyperlaneId: hit.hyperlane.id, startX: wx, startY: wy };
            panSuppressed = true;
            return false;
          }
        }
      }
    }
    
    const hit = hitTest(wx, wy);
    if (!hit) {
      // Shift+拖动触发框选，默认空白处拖动为平移
      if (shiftKey && !editMode.value) {
        isBoxSelecting = true;
        boxSelectStart = { x: wx, y: wy };
        boxSelectEnd = { x: wx, y: wy };
        return false;
      }
      return true;
    }
    
    if (editMode.value && hit.type === 'boundary-vertex') {
      editingBoundary.value = { domainId: hit.border.domainId, vertexIndex: hit.vertexIndex };
      if (!store.domainBorderOverrides[hit.border.domainId]) {
        setBorderPoints(hit.border.domainId, [...hit.border.points]);
      }
      return false;
    }
    
    if (editMode.value) {
      if (hit.type === 'galaxy') {
        dragSourceNode = hit.node;
        dragMousePos = { x: wx, y: wy };
        return false;
      }
      return true;
    } else {
      // 普通模式：节点拖拽
      if (hit.type === 'galaxy' || hit.type === 'domain') {
        // 如果点击的节点已选中，开始多节点拖拽
        if (selectedNodeIds.value.has(hit.node.id) && selectedNodeIds.value.size > 1) {
          isDraggingMultiple = true;
          dragMultipleStart = { x: wx, y: wy };
          store.beginNodePositionCapture(hit.node.id);
          return false;
        }
        
        store.beginNodePositionCapture(hit.node.id);
      }
      return { mode: 'node', nodeId: hit.node.id };
    }
  },
  onDragMove: (wx, wy, dragInfo) => {
    if (isBoxSelecting) {
      boxSelectEnd = { x: wx, y: wy };
      renderer.requestRender();
      return;
    }
    
    if (isDraggingMultiple) {
      const dx = wx - dragMultipleStart.x;
      const dy = wy - dragMultipleStart.y;
      
      selectedNodeIds.value.forEach(nodeId => {
        const galaxy = galaxyNodes.value.find(g => g.id === nodeId);
        if (galaxy) {
          galaxy.x += dx;
          galaxy.y += dy;
          store.updateNodePosition(nodeId, galaxy.x, galaxy.y);
        }
      });
      
      dragMultipleStart = { x: wx, y: wy };
      renderer.requestRender();
      return;
    }
    
    if (draggedControlPoint) {
      const h = store.getHyperlaneById(draggedControlPoint.hyperlaneId);
      if (h && h.controlPoints && h.controlPoints[draggedControlPoint.cpIndex]) {
        h.controlPoints[draggedControlPoint.cpIndex] = { x: wx, y: wy };
        renderer.requestRender();
      }
      return;
    }
    
    if (draggedHyperlaneMidpoint) {
      const h = store.getHyperlaneById(draggedHyperlaneMidpoint.hyperlaneId);
      if (h) {
        if (!h.controlPoints) h.controlPoints = [];
        if (h.controlPoints.length === 0) {
          h.controlPoints.push({ x: wx, y: wy });
        } else {
          h.controlPoints[0] = { x: wx, y: wy };
        }
        renderer.requestRender();
      }
      return;
    }
    
    if (dragInfo?.mode === 'node') {
      const galaxy = galaxyNodes.value.find(g => g.id === dragInfo.nodeId);
      if (galaxy) {
        galaxy.x = wx;
        galaxy.y = wy;
        store.updateNodePosition(dragInfo.nodeId, wx, wy);
      }
      return;
    }
    
    if (editMode.value && dragSourceNode) {
      dragMousePos = { x: wx, y: wy };
      const hit = hitTest(wx, wy);
      targetNode = (hit && hit.type === 'galaxy' && hit.node.id !== dragSourceNode.id) ? hit.node : null;
    }
  },
  onDragEnd: (wx, wy, dragInfo) => {
    if (isBoxSelecting) {
      isBoxSelecting = false;
      // 选择框内所有节点
      const minX = Math.min(boxSelectStart.x, boxSelectEnd.x);
      const maxX = Math.max(boxSelectStart.x, boxSelectEnd.x);
      const minY = Math.min(boxSelectStart.y, boxSelectEnd.y);
      const maxY = Math.max(boxSelectStart.y, boxSelectEnd.y);
      
      galaxyNodes.value.forEach(g => {
        if (g.x >= minX && g.x <= maxX && g.y >= minY && g.y <= maxY) {
          selectedNodeIds.value.add(g.id);
        }
      });
      
      renderer.requestRender();
      return;
    }
    
    if (isDraggingMultiple) {
      isDraggingMultiple = false;
      store.endNodePositionCapture();
      emit('dirty', true);
      return;
    }
    
    if (draggedControlPoint) {
      const h = store.getHyperlaneById(draggedControlPoint.hyperlaneId);
      if (h) {
        const cp = h.controlPoints[draggedControlPoint.cpIndex];
        if (cp) {
          store.updateHyperlane(h.id, { controlPoints: h.controlPoints });
          emit('dirty', true);
        }
      }
      draggedControlPoint = null;
      return;
    }
    
    if (draggedHyperlaneMidpoint) {
      const h = store.getHyperlaneById(draggedHyperlaneMidpoint.hyperlaneId);
      if (h) {
        if (!h.controlPoints || h.controlPoints.length === 0) {
          const mid = getHyperlaneMidpoint(h);
          if (mid) {
            h.controlPoints = [{ x: mid.x, y: mid.y - 50 }];
          }
        }
        store.updateHyperlane(h.id, { controlPoints: h.controlPoints });
        emit('dirty', true);
      }
      draggedHyperlaneMidpoint = null;
      return;
    }
    
    if (dragInfo?.mode === 'node') {
      store.endNodePositionCapture();
      emit('dirty', true);
      return;
    }
    
    if (editMode.value && dragSourceNode) {
      const hit = hitTest(wx, wy);
      if (hit && hit.type === 'galaxy' && hit.node.id !== dragSourceNode.id) {
        const result = store.addHyperlane(dragSourceNode.id, hit.node.id, nextHyperlaneType.value);
        if (result) {
          emit('dirty', true);
        }
      }
      dragSourceNode = null;
      targetNode = null;
    }
  },
  onClick: (hit) => {
    if (hit?.node) {
      emit('select-node', hit.node);
    }
    
    // 编辑模式下不自动进入下一级地图（防止误操作）
    if (editMode.value) return;
    
    if (hit?.type === 'galaxy') {
      const parentDomain = domainNodes.find(d => d.id === hit.node.domainId);
      if (parentDomain) emit('select', parentDomain);
    } else if (hit?.type === 'boundary-vertex') {
      editingBoundary.value = { domainId: hit.border.domainId, vertexIndex: hit.vertexIndex };
    }
  },
  onContextMenu: (wx, wy) => {
    if (!editMode.value) return;
    const hit = hitTestHyperlane(wx, wy);
    if (hit) {
      if (hit.controlPointIndex !== undefined) {
        const h = hit.hyperlane;
        if (h.controlPoints && h.controlPoints.length > 0) {
          h.controlPoints.splice(hit.controlPointIndex, 1);
          store.updateHyperlane(h.id, { controlPoints: h.controlPoints });
          emit('dirty', true);
        }
      } else {
        store.removeHyperlane(hit.hyperlane.id);
        emit('dirty', true);
      }
    }
  },
});

// ===== 监听聚焦节点事件 =====
function onFocusNode(e) {
  const node = e.detail;
  if (!node) return;
  const galaxy = galaxyNodes.value.find(g => g.id === node.id);
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

watch(() => [props.galaxies, props.domains], () => {
  applyStableLayout();
  renderer.requestRender();
}, { deep: true });

watch(() => store.currentDomainHyperlanes, () => {
  renderer.requestRender();
});

// ===== 编辑模式切换 =====
function toggleEditMode() {
  editMode.value = !editMode.value;
  dragSourceNode = null;
  targetNode = null;
  hoveredHyperlane = null;
  editingBoundary.value = null;
  hoveredBoundaryVertex.value = null;
  if (canvas.value) canvas.value.style.cursor = 'default';
  renderer.requestRender();
}

// ===== 创建恒星 =====
function createGalaxy() {
  const vt = renderer.getViewTransform();
  const cx = -vt.x / vt.scale;
  const cy = -vt.y / vt.scale;
  const id = `galaxy_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const newGalaxy = {
    id,
    name: `新恒星_${Date.now() % 1000}`,
    layer: 'galaxy',
    parentId: props.world?.id || null,
    tags: ['新创建'],
    sourcePath: '',
    coordinate: { x: cx, y: cy },
  };
  store.nodes.push(newGalaxy);
  galaxyNodes.value.push({
    ...newGalaxy,
    x: cx,
    y: cy,
    domainId: props.world?.id || null,
    factionColor: '#4a90d9',
  });
  store.scheduleAutoSave();
  emit('dirty', true);
  renderer.requestRender();
}

// ===== 鹰眼导航 =====
const galaxyWorldBounds = computed(() => {
  if (!domainNodes.length && !galaxyNodes.value.length) {
    return { minX: -500, maxX: 500, minY: -500, maxY: 500 };
  }
  
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  
  for (const d of domainNodes) {
    minX = Math.min(minX, d.x - d.radius);
    maxX = Math.max(maxX, d.x + d.radius);
    minY = Math.min(minY, d.y - d.radius);
    maxY = Math.max(maxY, d.y + d.radius);
  }
  for (const g of galaxyNodes.value) {
    minX = Math.min(minX, g.x - 25);
    maxX = Math.max(maxX, g.x + 25);
    minY = Math.min(minY, g.y - 25);
    maxY = Math.max(maxY, g.y + 25);
  }
  
  const padding = 80;
  return {
    minX: minX - padding,
    maxX: maxX + padding,
    minY: minY - padding,
    maxY: maxY + padding,
  };
});

const galaxyViewBounds = computed(() => {
  const vt = renderer.getViewTransform();
  const cvs = canvas.value;
  if (!cvs) return galaxyWorldBounds.value;
  
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

const galaxyEyeElements = computed(() => {
  const elements = [];
  
  for (const g of filteredGalaxyNodes.value) {
    elements.push({
      type: 'node',
      x: g.x,
      y: g.y,
      r: 5,
      color: g.factionColor || '#4a90d9',
      glow: true,
    });
  }
  
  const hyperlanes = store.currentDomainHyperlanes;
  const nodeMap = new Map(galaxyNodes.value.map(g => [g.id, g]));
  
  for (const h of hyperlanes) {
    const from = nodeMap.get(h.fromId);
    const to = nodeMap.get(h.toId);
    if (!from || !to) continue;
    
    elements.push({
      type: 'line',
      from: { x: from.x, y: from.y },
      to: { x: to.x, y: to.y },
      color: h.type === 'cross_domain' ? 'rgba(200,140,255,0.6)' : 'rgba(100,200,255,0.5)',
      lineWidth: 1.5,
      dashed: h.type === 'cross_domain',
    });
  }
  
  const borders = computeFactionBorders();
  for (const border of borders) {
    if (border.points.length < 3) continue;
    elements.push({
      type: 'polygon',
      points: border.points,
      color: border.color,
      id: border.domainId,
    });
  }
  
  return elements;
});

function handleGalaxyEagleNavigate(world) {
  const vt = renderer.getViewTransform();
  vt.x = -world.x * vt.scale;
  vt.y = -world.y * vt.scale;
  renderer.requestRender();
}

defineExpose({ canvas, renderer });
</script>

<style scoped>
.galaxy-map-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--map-bg);
}

.map-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--map-header-border);
  background: var(--map-header-bg);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-left {
  display: flex;
  flex-direction: column;
}

.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.hyperlane-type-select {
  padding: 5px 10px;
  border: 1px solid var(--map-btn-border);
  border-radius: 4px;
  background: var(--map-btn-bg);
  color: var(--map-btn-text);
  cursor: pointer;
  font-size: 12px;
  outline: none;
}

.hyperlane-type-select:focus {
  border-color: var(--map-accent-blue);
}

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

.header-actions button:hover {
  background: var(--map-btn-hover);
}

.header-actions button.active {
  background: var(--map-accent-green-bg);
  border-color: var(--map-accent-green-border);
  color: var(--map-accent-green);
}

.map-header h2 {
  font-size: 14px;
  color: var(--map-text-heading);
  margin-bottom: 4px;
}

.hint {
  font-size: 11px;
  color: var(--map-text-hint);
}

.edit-hint {
  color: var(--map-accent-green);
}

/* 势力图例 */
.faction-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  padding: 10px 16px;
  background: var(--map-header-bg);
  border-bottom: 1px solid var(--map-header-border);
  font-size: 12px;
  color: var(--map-btn-text);
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 7px;
  text-shadow: 0 0 10px var(--faction-color);
  font-weight: 500;
}

.legend-color-picker {
  width: 14px;
  height: 14px;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  padding: 0;
  background: none;
  -webkit-appearance: none;
  appearance: none;
  overflow: hidden;
}

.legend-color-picker::-webkit-color-swatch-wrapper {
  padding: 0;
}

.legend-color-picker::-webkit-color-swatch {
  border: none;
  border-radius: 50%;
}

.legend-color-picker::-moz-color-swatch {
  border: none;
  border-radius: 50%;
}

.legend-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--faction-color);
  box-shadow: 0 0 10px var(--faction-color), 0 0 20px var(--faction-color);
}

.filter-panel-galaxy {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 8px;
  background: var(--map-header-bg);
  border: 1px solid var(--map-header-border);
  border-radius: 6px;
  padding: 12px;
  min-width: 220px;
  z-index: 200;
  box-shadow: 0 8px 24px var(--map-panel-shadow);
  max-height: 400px;
  overflow-y: auto;
}

.filter-section {
  margin-bottom: 12px;
}

.filter-section:last-child {
  margin-bottom: 0;
}

.filter-section-title {
  font-size: 11px;
  color: var(--map-text-hint);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
}

.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  margin: 3px;
  border-radius: 12px;
  background: var(--map-btn-bg);
  border: 1px solid var(--map-btn-border);
  color: var(--map-btn-text);
  font-size: 11px;
  cursor: pointer;
  user-select: none;
  transition: all 0.15s;
}

.filter-chip:hover {
  background: var(--map-btn-hover);
}

.filter-chip.active {
  background: rgba(88, 166, 255, 0.2);
  border-color: var(--map-accent-blue);
  color: var(--map-accent-blue);
}

.filter-chip input {
  display: none;
}

.filter-reset {
  background: none;
  border: 1px solid var(--map-filter-border);
  color: var(--map-text-hint);
  font-size: 11px;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
  width: 100%;
  text-align: center;
  transition: all 0.15s;
}

.filter-reset:hover {
  border-color: var(--map-accent-blue);
  color: var(--map-accent-blue);
}

.canvas-wrapper {
  flex: 1;
  position: relative;
  overflow: hidden;
}

canvas {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--map-bg);
}
</style>
