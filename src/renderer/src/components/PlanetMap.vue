<template>
  <div class="planet-map-container">
    <div class="map-header">
      <div class="header-left">
        <h2>{{ planet?.name }} — 行星地图</h2>
        <p class="hint">
          <template v-if="!editMode">
            点击省份选中 · 点击地点查看详情 · 双击在 Obsidian 打开 · 滚动缩放 · 拖拽平移 · <a href="#" @click.prevent="enterEditMode">编辑地图</a>
          </template>
          <template v-else>
            <strong>编辑模式</strong> — 
            {{ isDrawing ? '正在绘制...' : '按住拖动绘制省份边界，松开自动闭合' }}
            · <a href="#" @click.prevent="exitEditMode">退出编辑</a>
          </template>
        </p>
      </div>
    </div>
    
    <!-- 编辑工具栏 -->
    <div v-if="editMode" class="edit-toolbar">
      <button :class="{ active: interactionMode === 'pan' }" @click="interactionMode = 'pan'" title="拖动画布 (空格临时切换)">🤚 拖手</button>
      <button :class="{ active: interactionMode === 'draw' }" @click="interactionMode = 'draw'" title="绘制省份">✏️ 绘制</button>
      <button :class="{ active: interactionMode === 'region' }" @click="interactionMode = 'region'" title="圈画区域">🗺️ 区域</button>
      <button :class="{ active: interactionMode === 'marker' }" @click="interactionMode = 'marker'" title="放置标记">📍 标记</button>
      <button class="separator-btn" disabled></button>
      
      <template v-if="interactionMode === 'draw'">
        <button :class="{ active: drawMode && !floodFillMode }" @click="drawMode = true; floodFillMode = false" title="按住拖动绘制">✏️ 自由绘制</button>
        <button :class="{ active: !drawMode && !floodFillMode }" @click="drawMode = false; floodFillMode = false" title="点击放置顶点">📐 点击描点</button>
        <button :class="{ active: floodFillMode }" @click="floodFillMode = !floodFillMode" title="点击空白处生成区域">🪣 区域填充</button>
        <button class="separator-btn" disabled></button>
      </template>
      
      <template v-if="interactionMode === 'region'">
        <button :class="{ active: drawMode && !floodFillMode }" @click="drawMode = true; floodFillMode = false" title="按住拖动绘制区域">✏️ 自由绘制</button>
        <button :class="{ active: !drawMode && !floodFillMode }" @click="drawMode = false; floodFillMode = false" title="点击放置顶点">📐 点击描点</button>
        <button :class="{ active: floodFillMode }" @click="floodFillMode = !floodFillMode" title="点击空白处自动生成区域">🪣 区域填充</button>
        <button class="separator-btn" disabled></button>
      </template>
      
      <button v-if="interactionMode === 'draw'" :class="{ active: snapEnabled }" @click="snapEnabled = !snapEnabled" title="边缘吸附到相邻省份">🧲 吸附</button>
      
      <button @click="deleteSelected" :disabled="!selectedProvince && !selectedRegion && !selectedMarker" title="删除选中省份/区域/标记 (Del)">🗑 删除</button>
      <button v-if="selectedProvince || selectedRegion" @click="smoothPolygonBoundary" title="平滑边界为贝塞尔曲线">〰️ 平滑</button>
      <button class="separator-btn" disabled></button>
      <button @click="undo" :disabled="!store.canUndo" :title="'撤销: ' + undoLabel">↶ 撤销</button>
      <button @click="redo" :disabled="!store.canRedo">↷ 重做</button>
      <button class="separator-btn" disabled></button>
      <button @click="saveMap" title="保存地图">💾 保存</button>
      <button @click="confirmClear" title="清空所有省份">🧹 清空</button>
    </div>
    
    <!-- 地形类型选择器 -->
    <div v-if="editMode && interactionMode === 'draw'" class="terrain-picker">
      <span class="picker-label">省份地形：</span>
      <button 
        v-for="t in terrainTypes" 
        :key="t.type"
        :class="{ active: selectedTerrain === t.type }"
        :style="{ background: t.color }"
        @click="selectedTerrain = t.type"
      >{{ t.label }}</button>
    </div>
    
    <!-- 区域颜色选择器 -->
    <div v-if="editMode && interactionMode === 'region'" class="terrain-picker">
      <span class="picker-label">区域颜色：</span>
      <button 
        v-for="c in REGION_COLORS" 
        :key="c"
        :class="{ active: regionColor === c }"
        :style="{ background: c }"
        @click="regionColor = c"
        class="color-btn"
      ></button>
    </div>
    
    <!-- 标记类型选择器 -->
    <div v-if="editMode && interactionMode === 'marker'" class="terrain-picker">
      <span class="picker-label">标记类型：</span>
      <button 
        v-for="m in markerTypes" 
        :key="m.type"
        :class="{ active: selectedMarkerType === m.type }"
        @click="selectedMarkerType = m.type"
      ><span class="marker-icon">{{ m.icon }}</span> {{ m.label }}</button>
    </div>
    
    <div class="canvas-wrapper">
      <canvas ref="canvas"></canvas>
      <eagle-eye
        :view-bounds="viewBounds"
        :elements="eagleEyeElements"
        :world-bounds="worldBounds"
        @navigate="handleEagleEyeNavigate"
      />
    </div>
    
    <!-- 选中省份的属性编辑面板 -->
    <div v-if="editMode && selectedProvince" class="province-editor">
      <div class="editor-header">
        <h3>编辑省份</h3>
        <button class="close-btn" @click="selectedProvince = null">×</button>
      </div>
      <div class="editor-field">
        <label>名称</label>
        <input 
          v-model="editingName" 
          @input="updateProvinceName" 
          placeholder="省份名称"
        />
      </div>
      <div class="editor-field">
        <label>地形</label>
        <div class="terrain-selector">
          <button 
            v-for="t in terrainTypes" 
            :key="t.type"
            :class="{ active: selectedProvince?.type === t.type }"
            :style="{ background: t.color }" 
            @click="updateTerrainType(t.type)"
          >{{ t.label }}</button>
        </div>
      </div>
      <div class="editor-field">
        <label>描述</label>
        <textarea 
          v-model="editingDescription" 
          @input="updateProvinceDescription" 
          placeholder="省份描述（可选）"
          rows="3"
        ></textarea>
      </div>
    </div>
    
    <!-- 选中区域的属性编辑面板 -->
    <div v-if="editMode && selectedRegion" class="province-editor region-editor">
      <div class="editor-header">
        <h3>编辑区域</h3>
        <button class="close-btn" @click="selectedRegion = null">×</button>
      </div>
      <div class="editor-field">
        <label>名称</label>
        <input 
          v-model="editingRegionName" 
          @input="updateRegionName" 
          placeholder="区域名称"
        />
      </div>
      <div class="editor-field">
        <label>颜色</label>
        <div class="terrain-selector">
          <button 
            v-for="c in REGION_COLORS" 
            :key="c"
            :class="{ active: selectedRegion?.color === c }"
            :style="{ background: c }" 
            @click="updateRegionColor(c)"
            class="color-btn"
          ></button>
        </div>
      </div>
      <div class="editor-field">
        <label>描述</label>
        <textarea 
          v-model="editingRegionDescription" 
          @input="updateRegionDescription" 
          placeholder="区域描述（可选）"
          rows="3"
        ></textarea>
      </div>
      <div class="editor-field" v-if="selectedRegion?.members?.length">
        <label>包含地点 ({{ selectedRegion.members.length }})</label>
        <div class="members-list">
          <span v-for="memberId in selectedRegion.members" :key="memberId" class="member-tag">
            {{ getPlaceName(memberId) }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useGeodataStore } from '../store/geodata';
import { useLayersStore } from '../store/layers';
import { useCanvasRenderer } from '../composables/useCanvasRenderer';
import { getLastCommandLabel, execute } from '../store/undo';
import { getTexturePattern } from '../utils/textures';
import { snapPolygonToNeighbors } from '../utils/snap';
import { createProvinceByFloodFill } from '../utils/floodfill';
import { validatePolygon, pointInPolygon as geoPointInPolygon } from '../utils/geometry';
import EagleEye from './EagleEye.vue';

const store = useGeodataStore();
const layers = useLayersStore();

const props = defineProps({
  planet: { type: Object, default: null },
});

const emit = defineEmits(['back', 'select-node', 'dirty']);

const canvas = ref(null);
const drawMode = ref(true);
const floodFillMode = ref(false);
const currentPath = ref([]);
const hoveredNode = ref(null);
const floodPreview = ref(null);

// ===== 编辑状态 =====
const editMode = ref(false);
const selectedTerrain = ref('land');
const selectedProvince = ref(null);
const drawingPolygon = ref(null);

// ===== 顶点编辑状态 =====
const editingVertex = ref(null);
const hoveredVertex = ref(null);

// ===== 区域绘制状态 =====
const selectedRegion = ref(null);
const regionColor = ref('#FF6B6B');
const REGION_COLORS = ['#FF6B6B', '#FFA500', '#FFD700', '#32CD32', '#4169E1', '#9B59B6'];

// ===== 交互模式 =====
const interactionMode = ref('pan');
const isSpacebarDown = ref(false);
const snapEnabled = ref(true);

// ===== 属性编辑 =====
const editingName = ref('');
const editingDescription = ref('');
const editingRegionName = ref('');
const editingRegionDescription = ref('');

watch(selectedProvince, (poly) => {
  editingName.value = poly?.name || '';
  editingDescription.value = poly?.description || '';
});

watch(selectedRegion, (region) => {
  editingRegionName.value = region?.name || '';
  editingRegionDescription.value = region?.description || '';
});

function updateProvinceName() {
  if (!selectedProvince.value || !editingName.value.trim()) return;
  store.updateTerrainPolygon(props.planet.id, selectedProvince.value.id, {
    name: editingName.value.trim(),
  });
  emit('dirty', true);
}

function updateTerrainType(type) {
  if (!selectedProvince.value) return;
  store.updateTerrainPolygon(props.planet.id, selectedProvince.value.id, { type });
  emit('dirty', true);
}

function updateProvinceDescription() {
  if (!selectedProvince.value) return;
  store.updateTerrainPolygon(props.planet.id, selectedProvince.value.id, {
    description: editingDescription.value,
  });
  emit('dirty', true);
}

// ===== 区域属性更新 =====
function updateRegionName() {
  if (!selectedRegion.value || !editingRegionName.value.trim()) return;
  store.updateRegion(props.planet.id, selectedRegion.value.id, {
    name: editingRegionName.value.trim(),
  });
  emit('dirty', true);
}

function updateRegionColor(color) {
  if (!selectedRegion.value) return;
  store.updateRegion(props.planet.id, selectedRegion.value.id, { color });
  emit('dirty', true);
}

function updateRegionDescription() {
  if (!selectedRegion.value) return;
  store.updateRegion(props.planet.id, selectedRegion.value.id, {
    description: editingRegionDescription.value,
  });
  emit('dirty', true);
}

function getPlaceName(placeId) {
  const place = places.value.find(p => p.id === placeId);
  return place?.name || placeId;
}

const terrainTypes = [
  { type: 'ocean', label: '海洋', color: '#2E86AB' },
  { type: 'land', label: '陆地', color: '#A3C4BC' },
  { type: 'forest', label: '森林', color: '#2D6A4F' },
  { type: 'desert', label: '沙漠', color: '#E9C46A' },
  { type: 'mountain', label: '山脉', color: '#8B7355' },
  { type: 'snow', label: '雪地', color: '#E8E8E8' },
  { type: 'lake', label: '湖泊', color: '#457B9D' },
];

// ===== 标记系统 =====
const selectedMarkerType = ref('chest');
const selectedMarker = ref(null);

const markerTypes = [
  { type: 'chest', label: '宝箱', icon: '📦', color: '#FFD700' },
  { type: 'teleport', label: '传送点', icon: '🌀', color: '#9B59B6' },
  { type: 'boss', label: 'Boss', icon: '💀', color: '#E74C3C' },
  { type: 'resource', label: '资源', icon: '💎', color: '#3498DB' },
  { type: 'npc', label: 'NPC', icon: '👤', color: '#2ECC71' },
  { type: 'flag', label: '旗帜', icon: '🚩', color: '#E67E22' },
];

// ===== 当前地图数据 =====
const currentMapData = computed(() => {
  if (!props.planet) return null;
  return store.mapData[props.planet.id] || { planetId: props.planet.id, version: 1, terrain: [], regions: [] };
});

// ===== 地点集合 =====
const places = computed(() => {
  if (!props.planet) return [];
  return [...store.planets, ...store.locations].filter(p => p.parentId === props.planet.id);
});

// ===== 节点样式 =====
const NODE_COLORS = { city: '#5B8DEF', town: '#4ECDC4', location: '#95E1D3' };
const NODE_RADIUS = { city: 10, town: 7, location: 5 };
const LABEL_SIZE = { city: 13, town: 12, location: 11 };
const LABEL_WEIGHT = { city: 'bold', town: 'normal', location: 'normal' };

function getNodeColor(layer) { return NODE_COLORS[layer] || '#95E1D3'; }
function getNodeRadius(layer) { return NODE_RADIUS[layer] || 5; }
function getLabelSize(layer) { return LABEL_SIZE[layer] || 11; }
function getLabelWeight(layer) { return LABEL_WEIGHT[layer] || 'normal'; }

// ===== 命中测试 =====
function hitTest(wx, wy) {
  if (!layers.isVisible('planet', 'terrain') && 
      !layers.isVisible('planet', 'markers') && 
      !layers.isVisible('planet', 'places') &&
      !layers.isVisible('planet', 'regions')) return null;
  
  if (layers.isVisible('planet', 'markers')) {
    const markerHit = hitTestMarker(wx, wy);
    if (markerHit) return markerHit;
  }
  
  if (layers.isVisible('planet', 'regions') && currentMapData.value?.regions) {
    for (let i = currentMapData.value.regions.length - 1; i >= 0; i--) {
      const region = currentMapData.value.regions[i];
      if (geoPointInPolygon(wx, wy, region.points)) {
        return { type: 'region', region };
      }
    }
  }
  
  if (layers.isVisible('planet', 'places')) {
    for (const place of places.value) {
      const dx = wx - (place.coordinate?.x || 0);
      const dy = wy - (place.coordinate?.y || 0);
      const r = getNodeRadius(place.layer) + 4;
      if (dx * dx + dy * dy < r * r) return { type: 'place', node: place };
    }
  }
  
  if (layers.isVisible('planet', 'terrain') && currentMapData.value) {
    for (let i = currentMapData.value.terrain.length - 1; i >= 0; i--) {
      const poly = currentMapData.value.terrain[i];
      if (pointInPolygon(wx, wy, poly.points)) {
        return { type: 'province', polygon: poly };
      }
    }
  }
  
  return null;
}

// ===== 顶点命中测试 =====
function hitTestVertex(wx, wy) {
  const selectedPoly = selectedProvince.value || selectedRegion.value;
  if (!selectedPoly || !editMode.value) return null;
  
  const points = selectedPoly.points;
  for (let i = 0; i < points.length; i++) {
    const dx = wx - points[i].x;
    const dy = wy - points[i].y;
    if (dx * dx + dy * dy < 8 * 8) {
      return { vertexIndex: i };
    }
  }
  return null;
}

// ===== 边命中测试 =====
function hitTestEdge(wx, wy) {
  const selectedPoly = selectedProvince.value || selectedRegion.value;
  if (!selectedPoly || !editMode.value) return null;
  
  const points = selectedPoly.points;
  const n = points.length;
  
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const dist = perpendicularDistance({ x: wx, y: wy }, a, b);
    if (dist < 8) {
      const distToA = Math.hypot(wx - a.x, wy - a.y);
      const distToB = Math.hypot(wx - b.x, wy - b.y);
      const edgeLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (distToA > 10 && distToB > 10 && edgeLen > 20) {
        return { insertIndex: i + 1 };
      }
    }
  }
  return null;
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function hitTestMarker(wx, wy) {
  if (!currentMapData.value?.markers) return null;
  for (let i = currentMapData.value.markers.length - 1; i >= 0; i--) {
    const marker = currentMapData.value.markers[i];
    const dx = wx - marker.x;
    const dy = wy - marker.y;
    if (dx * dx + dy * dy < 64) {
      return { type: 'marker', marker };
    }
  }
  return null;
}

// ===== 路径简化（Douglas-Peucker）=====
function simplifyPath(points, tolerance) {
  if (points.length <= 2) return points;
  let maxDist = 0;
  let maxIdx = 0;
  const end = points.length - 1;
  for (let i = 1; i < end; i++) {
    const dist = perpendicularDistance(points[i], points[0], points[end]);
    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
  }
  if (maxDist > tolerance) {
    const left = simplifyPath(points.slice(0, maxIdx + 1), tolerance);
    const right = simplifyPath(points.slice(maxIdx), tolerance);
    return left.slice(0, -1).concat(right);
  } else {
    return [points[0], points[end]];
  }
}

function perpendicularDistance(point, lineStart, lineEnd) {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(point.x - lineStart.x, point.y - lineStart.y);
  const t = ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / (len * len);
  const projX = lineStart.x + t * dx;
  const projY = lineStart.y + t * dy;
  return Math.hypot(point.x - projX, point.y - projY);
}

// ===== Undo/Redo label =====
const undoLabel = computed(() => getLastCommandLabel());

// ===== 绘制中的多边形状态 =====
const isDrawing = computed(() => currentPath.value.length > 0);

// ===== LOD =====
const lodRef = ref(1);

// ===== 鹰眼导航数据 =====
const worldBounds = computed(() => {
  if (!currentMapData.value?.terrain?.length) {
    return { minX: -300, maxX: 300, minY: -300, maxY: 300 };
  }
  
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const poly of currentMapData.value.terrain) {
    if (!poly.points) continue;
    for (const p of poly.points) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
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

const viewBounds = computed(() => {
  const vt = renderer.getViewTransform();
  const cvs = canvas.value;
  if (!cvs) return worldBounds.value;
  
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

const eagleEyeElements = computed(() => {
  const elements = [];
  
  for (const poly of currentMapData.value?.terrain || []) {
    elements.push({
      type: 'polygon',
      points: poly.points,
      color: terrainTypes.find(t => t.type === poly.type)?.color || '#A3C4BC',
      id: poly.id,
    });
  }
  
  for (const region of currentMapData.value?.regions || []) {
    elements.push({
      type: 'polygon',
      points: region.points,
      color: region.color || '#FF6B6B',
      id: region.id,
    });
  }
  
  for (const place of places.value) {
    elements.push({
      type: 'node',
      x: place.coordinate?.x || 0,
      y: place.coordinate?.y || 0,
      r: getNodeRadius(place.layer),
      color: getNodeColor(place.layer),
      glow: false,
    });
  }
  
  for (const marker of currentMapData.value?.markers || []) {
    elements.push({
      type: 'marker',
      x: marker.x,
      y: marker.y,
      r: 6,
      color: markerTypes.find(m => m.type === marker.type)?.color || '#FFD700',
      glow: true,
    });
  }
  
  return elements;
});

function handleEagleEyeNavigate(world) {
  const vt = renderer.getViewTransform();
  vt.x = -world.x * vt.scale;
  vt.y = -world.y * vt.scale;
  renderer.requestRender();
}

// ===== 绘制逻辑 =====
function onRender(ctx, w, h) {
  const scale = renderer.getViewTransform().scale;
  lodRef.value = Math.min(1, Math.max(0, (scale - 0.5) / 0.5));
  
  drawBackground(ctx, w, h);
  
  if (layers.isVisible('planet', 'terrain')) {
    drawTerrain(ctx);
  }
  
  if (layers.isVisible('planet', 'regions')) {
    drawRegions(ctx);
  }
  
  if (layers.isVisible('planet', 'places')) {
    drawPlaces(ctx);
  }
  
  if (layers.isVisible('planet', 'markers')) {
    drawMarkers(ctx);
  }
  
  if (editMode.value) {
    drawEditHelpers(ctx);
  }
  
  drawSelectedHighlight(ctx);
}

function drawBackground(ctx, w, h) {
  const bgGradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1500);
  bgGradient.addColorStop(0, '#E8F4F8');
  bgGradient.addColorStop(0.5, '#C8E6C9');
  bgGradient.addColorStop(1, '#FFF9C4');
  ctx.fillStyle = bgGradient;
  ctx.fillRect(-2000, -2000, 4000, 4000);
  
  ctx.strokeStyle = 'rgba(150, 180, 200, 0.15)';
  ctx.lineWidth = 0.5;
  const gridSize = 100;
  for (let gx = -2000; gx <= 2000; gx += gridSize) {
    ctx.beginPath();
    ctx.moveTo(gx, -2000);
    ctx.lineTo(gx, 2000);
    ctx.stroke();
  }
  for (let gy = -2000; gy <= 2000; gy += gridSize) {
    ctx.beginPath();
    ctx.moveTo(-2000, gy);
    ctx.lineTo(2000, gy);
    ctx.stroke();
  }
}

function drawTerrain(ctx) {
  const terrain = currentMapData.value?.terrain || [];
  
  terrain.forEach(poly => {
    if (!poly.points || poly.points.length < 3) return;
    
    const terrainColor = terrainTypes.find(t => t.type === poly.type)?.color || '#A3C4BC';
    const isSelected = selectedProvince.value?.id === poly.id;
    
    ctx.beginPath();
    ctx.moveTo(poly.points[0].x, poly.points[0].y);
    for (let i = 1; i < poly.points.length; i++) {
      ctx.lineTo(poly.points[i].x, poly.points[i].y);
    }
    ctx.closePath();
    
    // 填充
    ctx.fillStyle = terrainColor;
    ctx.globalAlpha = isSelected ? 0.9 : 0.75;
    ctx.fill();
    ctx.globalAlpha = 1;
    
    // 边界线
    ctx.strokeStyle = isSelected ? '#FFD700' : darkenColor(terrainColor, 20);
    ctx.lineWidth = isSelected ? 3 : 1.5;
    ctx.stroke();
    
    // 名称标签
    if (poly.name && lodRef.value > 0.3) {
      const center = getPolygonCenter(poly.points);
      ctx.font = `${getLabelWeight(poly.layer)} ${getLabelSize(poly.layer)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = getContrastColor(terrainColor);
      ctx.fillText(poly.name, center.x, center.y);
    }
  });
}

function drawRegions(ctx) {
  const regions = currentMapData.value?.regions || [];
  
  regions.forEach(region => {
    if (!region.points || region.points.length < 3) return;
    
    const color = region.color || '#FF6B6B';
    const isSelected = selectedRegion.value?.id === region.id;
    
    ctx.beginPath();
    ctx.moveTo(region.points[0].x, region.points[0].y);
    for (let i = 1; i < region.points.length; i++) {
      ctx.lineTo(region.points[i].x, region.points[i].y);
    }
    ctx.closePath();
    
    ctx.fillStyle = color;
    ctx.globalAlpha = isSelected ? 0.5 : 0.3;
    ctx.fill();
    ctx.globalAlpha = 1;
    
    ctx.strokeStyle = color;
    ctx.lineWidth = isSelected ? 3 : 2;
    ctx.setLineDash([5, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    
    if (region.name && lodRef.value > 0.3) {
      const center = getPolygonCenter(region.points);
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = color;
      ctx.fillText(region.name, center.x, center.y);
    }
  });
}

function drawPlaces(ctx) {
  places.value.forEach(place => {
    const x = place.coordinate?.x || 0;
    const y = place.coordinate?.y || 0;
    const color = getNodeColor(place.layer);
    const radius = getNodeRadius(place.layer);
    const isHovered = hoveredNode.value?.id === place.id;
    
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = isHovered ? 12 : 6;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    
    ctx.fillStyle = '#FFFFFF';
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(x, y, radius * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    
    if (place.name && lodRef.value > 0.4) {
      ctx.font = `${getLabelWeight(place.layer)} ${getLabelSize(place.layer)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#2D3436';
      ctx.fillText(place.name, x, y + radius + 4);
    }
  });
}

function drawMarkers(ctx) {
  if (!currentMapData.value?.markers) return;
  
  currentMapData.value.markers.forEach(marker => {
    const color = markerTypes.find(m => m.type === marker.type)?.color || '#FFD700';
    const icon = markerTypes.find(m => m.type === marker.type)?.icon || '📍';
    const isSelected = selectedMarker.value?.id === marker.id;
    
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(marker.x, marker.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(icon, marker.x, marker.y);
    
    if (isSelected) {
      ctx.strokeStyle = '#FFD700';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(marker.x, marker.y, 10, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
}

function drawEditHelpers(ctx) {
  // 绘制中的路径
  if (isDrawing.value) {
    ctx.strokeStyle = terrainTypes.find(t => t.type === selectedTerrain.value)?.color || '#000';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(currentPath.value[0].x, currentPath.value[0].y);
    for (let i = 1; i < currentPath.value.length; i++) {
      ctx.lineTo(currentPath.value[i].x, currentPath.value[i].y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    
    currentPath.value.forEach(p => {
      ctx.fillStyle = '#FF6B6B';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  
  // 选中省份的顶点
  if (selectedProvince.value || selectedRegion.value) {
    const poly = selectedProvince.value || selectedRegion.value;
    poly.points.forEach((p, i) => {
      const isHovered = hoveredVertex.value?.vertexIndex === i;
      ctx.fillStyle = isHovered ? '#FF6B6B' : '#FFD700';
      ctx.beginPath();
      ctx.arc(p.x, p.y, isHovered ? 8 : 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }
  
  // 选中省份的边（用于插入顶点）
  if ((selectedProvince.value || selectedRegion.value) && hoveredVertex.value === null) {
    const poly = selectedProvince.value || selectedRegion.value;
    const n = poly.points.length;
    for (let i = 0; i < n; i++) {
      const a = poly.points[i];
      const b = poly.points[(i + 1) % n];
      ctx.strokeStyle = selectedRegion.value ? (selectedRegion.value.color || '#FF6B6B') : 'rgba(255, 215, 0, 0.3)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

function drawSelectedHighlight(ctx) {
  if (selectedProvince.value) {
    const poly = selectedProvince.value;
    ctx.strokeStyle = '#FFD700';
    ctx.lineWidth = 3;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(poly.points[0].x, poly.points[0].y);
    for (let i = 1; i < poly.points.length; i++) {
      ctx.lineTo(poly.points[i].x, poly.points[i].y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ===== 工具函数 =====
function getPolygonCenter(points) {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function darkenColor(hex, amount) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, (num >> 16) - amount);
  const g = Math.max(0, ((num >> 8) & 0x00FF) - amount);
  const b = Math.max(0, (num & 0x0000FF) - amount);
  return `#${(r << 16 | g << 8 | b).toString(16).padStart(6, '0')}`;
}

function getContrastColor(hex) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = num >> 16;
  const g = (num >> 8) & 0xFF;
  const b = num & 0xFF;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#2D3436' : '#FFFFFF';
}

function screenToWorldFunc(sx, sy) {
  const cvs = canvas.value;
  if (!cvs) return { x: 0, y: 0 };
  const vt = renderer.getViewTransform();
  return {
    x: (sx - cvs.clientWidth / 2 - vt.x) / vt.scale,
    y: (sy - cvs.clientHeight / 2 - vt.y) / vt.scale,
  };
}

// ===== Canvas Renderer =====
const renderer = useCanvasRenderer(canvas, {
  onRender,
  onHitTest: (wx, wy) => hitTest(wx, wy),
  onHover: (hit) => {
    hoveredNode.value = hit?.type === 'place' ? hit.node : null;
    if (hit?.type !== 'vertex') {
      hoveredVertex.value = null;
    }
  },
  onDragStart: (wx, wy, button) => {
    if (button !== 0) return true;
    
    const mode = isSpacebarDown.value ? 'pan' : interactionMode.value;
    
    // 绘制模式：开始绘制
    if ((mode === 'draw' || mode === 'region') && drawMode.value) {
      isDrawingActive = true;
      currentPath.value = [screenToWorldFunc(wx, wy)];
      return false;
    }
    
    if (mode === 'marker') {
      return false;
    }
    
    const hit = hitTest(wx, wy);
    if (!hit) return true; // 空白处平移
    
    if (mode === 'pan') return true;
    
    return false;
  },
  onDragMove: (wx, wy, dragInfo) => {
    if (isDrawingActive) {
      const last = currentPath.value[currentPath.value.length - 1];
      const world = screenToWorldFunc(wx, wy);
      if (!last || Math.hypot(world.x - last.x, world.y - last.y) > 3) {
        currentPath.value.push(world);
        renderer.requestRender();
      }
    }
  },
  onDragEnd: () => {
    if (isDrawingActive) {
      isDrawingActive = false;
      if (currentPath.value.length > 2) {
        finishDrawing();
      }
      currentPath.value = [];
    }
  },
  onWheel: (e, newScale) => {
    if (onWheelCallback) onWheelCallback(e, newScale);
  },
  drawMode,
  currentPath,
  interactionMode,
  isSpacebarDown,
});

let isDrawingActive = false;

let onWheelCallback = null;

function finishDrawing() {
  const simplified = simplifyPath(currentPath.value, 2);
  const polygon = {
    id: `poly_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    points: simplified,
    type: interactionMode.value === 'region' ? 'region' : selectedTerrain.value,
    name: '',
    description: '',
    color: interactionMode.value === 'region' ? regionColor.value : undefined,
  };
  
  if (interactionMode.value === 'region') {
    store.addRegion(props.planet.id, polygon);
  } else {
    store.addTerrainPolygon(props.planet.id, polygon);
  }
  
  emit('dirty', true);
}

function deleteSelected() {
  if (selectedProvince.value) {
    store.removeTerrainPolygon(props.planet.id, selectedProvince.value.id);
    selectedProvince.value = null;
    emit('dirty', true);
  }
  if (selectedRegion.value) {
    store.removeRegion(props.planet.id, selectedRegion.value.id);
    selectedRegion.value = null;
    emit('dirty', true);
  }
  if (selectedMarker.value) {
    // 删除标记
    const markers = currentMapData.value?.markers || [];
    const idx = markers.findIndex(m => m.id === selectedMarker.value.id);
    if (idx !== -1) {
      markers.splice(idx, 1);
    }
    selectedMarker.value = null;
    emit('dirty', true);
  }
}

function smoothPolygonBoundary() {
  const poly = selectedProvince.value || selectedRegion.value;
  if (!poly || poly.points.length < 3) return;
  
  const smoothed = [];
  const points = poly.points;
  const n = points.length;
  
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    
    smoothed.push({
      x: curr.x * 0.5 + (prev.x + next.x) * 0.25,
      y: curr.y * 0.5 + (prev.y + next.y) * 0.25,
    });
  }
  
  if (selectedProvince.value) {
    store.updateTerrainPolygon(props.planet.id, poly.id, { points: smoothed });
  } else {
    store.updateRegion(props.planet.id, poly.id, { points: smoothed });
  }
  emit('dirty', true);
}

function saveMap() {
  store.saveMapDataImmediate(props.planet.id);
}

function confirmClear() {
  if (confirm('确定要清空所有省份、区域和标记吗？此操作不可撤销。')) {
    store.mapData[props.planet.id] = {
      planetId: props.planet.id,
      version: 1,
      terrain: [],
      regions: [],
      markers: [],
    };
    selectedProvince.value = null;
    selectedRegion.value = null;
    selectedMarker.value = null;
    emit('dirty', true);
  }
}

function enterEditMode() {
  editMode.value = true;
  interactionMode.value = 'draw';
  drawMode.value = true;
}

function exitEditMode() {
  editMode.value = false;
  isDrawingActive = false;
  currentPath.value = [];
  selectedProvince.value = null;
  selectedRegion.value = null;
  selectedMarker.value = null;
}

function undo() {
  store.undo();
}

function redo() {
  store.redo();
}

// ===== 生命周期 =====
onMounted(() => {
  renderer.initCanvas();
  renderer.requestRender();
});

onUnmounted(() => {
  renderer.cleanupCanvas();
});

watch(() => store.mapData[props.planet?.id], () => {
  renderer.requestRender();
}, { deep: true });
</script>

<style scoped>
.planet-map-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--planet-bg);
}

.map-header {
  padding: 12px 20px;
  background: var(--planet-header-bg);
  border-bottom: 1px solid var(--planet-header-border);
}

.header-left {
  display: flex;
  align-items: baseline;
  gap: 16px;
}

.map-header h2 {
  font-size: 16px;
  color: var(--planet-text);
  margin: 0;
}

.hint {
  font-size: 12px;
  color: var(--planet-text-secondary);
  margin: 0;
}

.hint a {
  color: var(--planet-text-link);
  text-decoration: none;
}

.hint a:hover {
  text-decoration: underline;
}

.edit-toolbar {
  display: flex;
  gap: 4px;
  padding: 8px 20px;
  background: rgba(255,255,255,0.8);
  border-bottom: 1px solid var(--planet-header-border);
  flex-wrap: wrap;
}

.edit-toolbar button {
  padding: 6px 12px;
  border: 1px solid var(--planet-btn-border);
  border-radius: 4px;
  background: var(--planet-btn-bg);
  cursor: pointer;
  font-size: 12px;
  color: var(--planet-text);
}

.edit-toolbar button:hover {
  background: var(--planet-btn-hover);
}

.edit-toolbar button.active {
  background: var(--planet-btn-active-bg);
  color: white;
  border-color: var(--planet-btn-active-border);
}

.edit-toolbar button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.edit-toolbar button.separator-btn {
  width: 1px;
  padding: 0;
  border: none;
  background: transparent;
  pointer-events: none;
}

.terrain-picker {
  display: flex;
  gap: 6px;
  padding: 8px 20px;
  background: rgba(255,255,255,0.6);
  border-bottom: 1px solid var(--planet-header-border);
  align-items: center;
  flex-wrap: wrap;
}

.picker-label {
  font-size: 12px;
  color: var(--planet-text-secondary);
}

.terrain-picker button {
  padding: 4px 10px;
  border: 2px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  color: white;
  text-shadow: 0 1px 2px rgba(0,0,0,0.3);
}

.terrain-picker button.active {
  border-color: #FFD700;
  box-shadow: 0 0 6px rgba(255,215,0,0.5);
}

.color-btn {
  width: 28px;
  height: 28px;
  border-radius: 50% !important;
  padding: 0 !important;
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
}

.province-editor {
  position: absolute;
  right: 16px;
  top: 120px;
  width: 280px;
  background: var(--planet-editor-bg);
  border-radius: 8px;
  border: 1px solid var(--planet-editor-border);
  box-shadow: 0 4px 16px rgba(0,0,0,0.12);
  z-index: 10;
}
.editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid #eee;
}
.editor-header h3 {
  margin: 0;
  font-size: 13px;
  color: var(--planet-text);
  font-weight: 600;
}
.close-btn {
  background: none;
  border: none;
  font-size: 18px;
  cursor: pointer;
  color: #999;
  line-height: 1;
  padding: 0 4px;
}
.close-btn:hover { color: #333; }
.editor-field {
  padding: 10px 14px;
  border-bottom: 1px solid #f0f0f0;
}
.editor-field:last-child { border-bottom: none; }
.editor-field label {
  display: block;
  font-size: 11px;
  color: #888;
  margin-bottom: 4px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.editor-field input,
.editor-field textarea {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--planet-input-border);
  border-radius: 4px;
  font-size: 12px;
  font-family: "Microsoft YaHei", sans-serif;
  background: var(--planet-input-bg);
  transition: border-color 0.15s;
}
.editor-field input:focus,
.editor-field textarea:focus {
  border-color: var(--planet-input-focus);
  outline: none;
}
.editor-field textarea { resize: vertical; }
.terrain-selector {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
}
.terrain-selector button {
  padding: 4px 0;
  border: 2px solid transparent;
  border-radius: 3px;
  color: #fff;
  font-size: 10px;
  cursor: pointer;
  opacity: 0.85;
  transition: all 0.15s;
}
.terrain-selector button:hover { opacity: 1; }
.terrain-selector button.active {
  opacity: 1;
  border-color: #FFD700;
  box-shadow: 0 0 0 2px rgba(255,215,0,0.3);
}
.marker-icon {
  font-size: 14px;
  margin-right: 2px;
}

/* 区域编辑器样式 */
.region-editor .members-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.member-tag {
  display: inline-block;
  padding: 2px 8px;
  background: var(--planet-tag-bg);
  border: 1px solid var(--planet-tag-border);
  border-radius: 12px;
  font-size: 11px;
  color: var(--planet-text);
}
</style>
