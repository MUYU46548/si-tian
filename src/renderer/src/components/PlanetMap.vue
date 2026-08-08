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
const drawMode = ref(true); // true=自由绘制, false=点击描点
const floodFillMode = ref(false); // true=区域填充模式
const currentPath = ref([]);
const hoveredNode = ref(null);
const floodPreview = ref(null); // hover 时预览 flood-fill 结果

// ===== 编辑状态 =====
const editMode = ref(false);
const selectedTerrain = ref('land');
const selectedProvince = ref(null);
const drawingPolygon = ref(null);

// ===== 顶点编辑状态 =====
const editingVertex = ref(null); // { polygonType, polygonId, vertexIndex }
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
  
  // 区域命中（在 terrain 之上）
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

// ===== 边命中测试（用于右键插入顶点）=====
function hitTestEdge(wx, wy) {
  const selectedPoly = selectedProvince.value || selectedRegion.value;
  if (!selectedPoly || !editMode.value) return null;
  
  const points = selectedPoly.points;
  const n = points.length;
  
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const dist = perpendicularDistance({ x: wx, y: wy }, a, b);
    // 检查点是否在线段附近（8px 阈值）且在端点之间
    if (dist < 8) {
      // 检查是否不在端点附近（避免与顶点删除冲突）
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

// ===== LOD（Level of Detail）计算 =====
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
  if (!currentMapData.value?.terrain) return [];
  
  return currentMapData.value.terrain.map(poly => {
    const terrainColor = terrainTypes.find(t => t.type === poly.type)?.color || '#A3C4BC';
    return {
      type: 'polygon',
      points: poly.points,
      color: terrainColor,
      id: poly.id,
    };
  });
});

function handleEagleEyeNavigate(world) {
  const vt = renderer.getViewTransform();
  vt.x = -world.x * vt.scale;
  vt.y = -world.y * vt.scale;
  renderer.requestRender();
}

// ===== 标记聚合 =====
const clusteredMarkers = computed(() => {
  if (!currentMapData.value?.markers) return [];
  const markers = currentMapData.value.markers;
  const lod = lodRef.value;
  
  if (lod < 0.6 && markers.length > 5) {
    const gridSize = 80 / lod;
    const grids = new Map();
    
    for (const m of markers) {
      const gx = Math.floor(m.x / gridSize);
      const gy = Math.floor(m.y / gridSize);
      const key = `${gx}_${gy}`;
      if (!grids.has(key)) grids.set(key, []);
      grids.get(key).push(m);
    }
    
    const result = [];
    for (const [, group] of grids) {
      if (group.length > 1) {
        const avgX = group.reduce((s, m) => s + m.x, 0) / group.length;
        const avgY = group.reduce((s, m) => s + m.y, 0) / group.length;
        result.push({
          id: 'cluster_' + group[0].id,
          type: 'cluster',
          x: avgX,
          y: avgY,
          count: group.length,
          markers: group,
        });
      } else {
        result.push(group[0]);
      }
    }
    return result;
  }
  
  return markers;
});

// ===== 背景渐变缓存 =====
let bgGradient = null;
let bgGradientWidth = 0;
let bgGradientHeight = 0;

function getBackgroundGradient(ctx, w, h) {
  if (!bgGradient || bgGradientWidth !== w || bgGradientHeight !== h) {
    bgGradient = ctx.createLinearGradient(0, 0, 0, h);
    bgGradient.addColorStop(0, '#E8F4F8');
    bgGradient.addColorStop(0.5, '#C8E6C9');
    bgGradient.addColorStop(1, '#FFF9C4');
    bgGradientWidth = w;
    bgGradientHeight = h;
  }
  return bgGradient;
}

// ===== 渲染逻辑 =====
function onRender(ctx, w, h) {
  ctx._animationTime = performance.now() / 1000;
  
  // 计算 LOD
  const scale = renderer.getViewTransform().scale;
  lodRef.value = Math.min(1, Math.max(0, (scale - 0.3) / 0.7));
  const lod = lodRef.value;
  
  // 背景渐变（缓存复用）— 始终绘制作为画布底色
  ctx.fillStyle = getBackgroundGradient(ctx, w, h);
  ctx.fillRect(-5000, -5000, 10000, 10000);
  
  // 省份多边形
  if (layers.isVisible('planet', 'terrain') && currentMapData.value) {
    for (const poly of currentMapData.value.terrain) {
      drawProvince(ctx, poly, lod);
    }
  }
  
  // 区域层（半透明叠加在地形之上）
  if (layers.isVisible('planet', 'regions') && currentMapData.value?.regions) {
    for (const region of currentMapData.value.regions) {
      drawRegion(ctx, region, lod);
    }
  }
  
  // 标记点（带聚合）
  if (layers.isVisible('planet', 'markers')) {
    const markersToRender = clusteredMarkers.value;
    for (const item of markersToRender) {
      if (item.type === 'cluster') {
        drawCluster(ctx, item);
      } else {
        drawMarker(ctx, item, lod);
      }
    }
  }
  
  // 地点节点（带 LOD）
  if (layers.isVisible('planet', 'places')) {
    for (const place of places.value) {
      drawPlace(ctx, place, lod);
    }
  }
  
  // 编辑辅助线
  if (editMode.value && layers.isVisible('planet', 'editHelpers')) {
    drawEditHelpers(ctx);
    drawMemberHighlight(ctx, lod);
  }
  
  // 区域填充预览
  if (floodPreview.value && floodPreview.value.length >= 3) {
    const isRegionMode = interactionMode.value === 'region';
    const terrainColor = terrainTypes.find(t => t.type === selectedTerrain.value)?.color || '#A3C4BC';
    const previewColor = isRegionMode ? regionColor.value : terrainColor;
    ctx.fillStyle = previewColor + '40'; // 半透明
    ctx.strokeStyle = previewColor;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(floodPreview.value[0].x, floodPreview.value[0].y);
    for (let i = 1; i < floodPreview.value.length; i++) {
      ctx.lineTo(floodPreview.value[i].x, floodPreview.value[i].y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ===== 成员地点高亮 =====
function drawMemberHighlight(ctx, lod) {
  if (!selectedRegion.value?.members?.length || lod < 0.3) return;
  
  const memberIds = new Set(selectedRegion.value.members);
  const regionColor = selectedRegion.value.color || '#FF6B6B';
  
  for (const place of places.value) {
    if (!memberIds.has(place.id)) continue;
    const x = place.coordinate?.x;
    const y = place.coordinate?.y;
    if (x === null || y === null || x === undefined || y === undefined) continue;
    
    // 高亮光环
    ctx.strokeStyle = regionColor + '80';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(x, y, getNodeRadius(place.layer) + 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // 小圆点指示
    ctx.fillStyle = regionColor;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCluster(ctx, cluster) {
  const x = cluster.x;
  const y = cluster.y;
  const count = cluster.count;
  
  ctx.fillStyle = 'rgba(100,100,100,0.7)';
  ctx.beginPath();
  ctx.arc(x, y, 12 + Math.min(count * 2, 10), 0, Math.PI * 2);
  ctx.fill();
  
  ctx.fillStyle = 'white';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(count.toString(), x, y);
}

function drawMarker(ctx, marker, lod) {
  const x = marker.x;
  const y = marker.y;
  const markerType = markerTypes.find(m => m.type === marker.type) || markerTypes[0];
  const color = markerType.color;
  const isSelected = selectedMarker.value?.id === marker.id;
  const time = ctx._animationTime || 0;

  if (lod < 0.5) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  const pulseSize = 12 + Math.sin(time * 3) * 3;
  ctx.fillStyle = `${color}20`;
  ctx.beginPath();
  ctx.arc(x, y, pulseSize, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 8, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fill();

  if (isSelected) {
    ctx.strokeStyle = '#FFD700';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawProvince(ctx, poly, lod) {
  if (!poly.points || poly.points.length < 3) return;
  
  const terrainColor = terrainTypes.find(t => t.type === poly.type)?.color || '#A3C4BC';
  const isSelected = selectedProvince.value?.poly?.id === poly.id || selectedProvince.value?.id === poly.id;
  
  ctx.beginPath();
  ctx.moveTo(poly.points[0].x, poly.points[0].y);
  
  if (poly.controlPoints && poly.controlPoints.length >= poly.points.length) {
    for (let i = 0; i < poly.points.length; i++) {
      const nextIdx = (i + 1) % poly.points.length;
      const cp = poly.controlPoints[i];
      const next = poly.points[nextIdx];
      ctx.quadraticCurveTo(cp.x, cp.y, next.x, next.y);
    }
  } else {
    for (let i = 1; i < poly.points.length; i++) {
      ctx.lineTo(poly.points[i].x, poly.points[i].y);
    }
  }
  
  ctx.closePath();
  
  // 填充：LOD 低时简化为纯色
  if (lod < 0.3) {
    ctx.fillStyle = terrainColor;
  } else {
    const texturePattern = getTexturePattern(poly.type, terrainColor, ctx);
    ctx.fillStyle = texturePattern || terrainColor;
  }
  ctx.fill();
  
  if (isSelected) {
    ctx.fillStyle = 'rgba(255,215,0,0.15)';
    ctx.fill();
  }
  
  // 边界
  const time = ctx._animationTime || 0;
  if (isSelected) {
    ctx.strokeStyle = '#FFD700';
    ctx.lineWidth = 3;
    ctx.setLineDash([]);
  } else {
    ctx.strokeStyle = terrainColor;
    ctx.lineWidth = 1.5;
    if (lod > 0.5) {
      ctx.setLineDash([6, 4]);
      ctx.lineDashOffset = -time * 0.5;
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);
  
  // 阶段 C：省份名称标签（LOD > 0.5 且缩放足够）
  if (lod > 0.5 && poly.name) {
    drawProvinceLabel(ctx, poly, lod);
  }
}

function drawProvinceLabel(ctx, poly, lod) {
  // 计算多边形质心
  let cx = 0, cy = 0;
  for (const p of poly.points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= poly.points.length;
  cy /= poly.points.length;
  
  const text = poly.name;
  ctx.font = `${Math.round(12 * lod)}px "Microsoft YaHei", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  
  const metrics = ctx.measureText(text);
  const padding = 4;
  const textWidth = metrics.width;
  const textHeight = Math.round(12 * lod);
  
  // 半透明背景（保证可读性）
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(
    cx - textWidth / 2 - padding,
    cy - textHeight / 2 - 2,
    textWidth + padding * 2,
    textHeight + 4
  );
  
  // 文字描边（增强对比）
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 3;
  ctx.strokeText(text, cx, cy);
  
  // 文字
  ctx.fillStyle = '#2D3436';
  ctx.fillText(text, cx, cy);
}

function drawRegion(ctx, region, lod) {
  if (!region.points || region.points.length < 3) return;
  
  const isSelected = selectedRegion.value?.id === region.id;
  const color = region.color || '#FF6B6B';
  
  ctx.beginPath();
  ctx.moveTo(region.points[0].x, region.points[0].y);
  
  if (region.controlPoints && region.controlPoints.length >= region.points.length) {
    for (let i = 0; i < region.points.length; i++) {
      const nextIdx = (i + 1) % region.points.length;
      const cp = region.controlPoints[i];
      const next = region.points[nextIdx];
      ctx.quadraticCurveTo(cp.x, cp.y, next.x, next.y);
    }
  } else {
    for (let i = 1; i < region.points.length; i++) {
      ctx.lineTo(region.points[i].x, region.points[i].y);
    }
  }
  
  ctx.closePath();
  
  // 半透明填充
  ctx.fillStyle = color + '40';
  ctx.fill();
  
  // 流动虚线边界
  const time = ctx._animationTime || 0;
  ctx.strokeStyle = color;
  ctx.lineWidth = isSelected ? 3 : 2;
  ctx.setLineDash([8, 4]);
  ctx.lineDashOffset = -time * 15;
  ctx.stroke();
  ctx.setLineDash([]);
  
  // 区域名称标签
  if (lod > 0.4 && region.name) {
    drawRegionLabel(ctx, region, color, lod);
  }
}

function drawRegionLabel(ctx, region, color, lod) {
  let cx = 0, cy = 0;
  for (const p of region.points) { cx += p.x; cy += p.y; }
  cx /= region.points.length;
  cy /= region.points.length;
  
  const text = region.name;
  ctx.font = `bold ${Math.round(13 * lod)}px "Microsoft YaHei", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  
  const metrics = ctx.measureText(text);
  const padding = 6;
  
  ctx.fillStyle = color + 'CC';
  ctx.beginPath();
  ctx.roundRect(
    cx - metrics.width / 2 - padding,
    cy - 10 * lod,
    metrics.width + padding * 2,
    20 * lod,
    4
  );
  ctx.fill();
  
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(text, cx, cy);
}

function drawPlace(ctx, place, lod) {
  const x = place.coordinate?.x || 0;
  const y = place.coordinate?.y || 0;
  const layer = place.layer;
  const color = getNodeColor(layer);
  const radius = getNodeRadius(layer);
  const isHovered = hoveredNode.value?.id === place.id;
  const isSelected = store.selectedNode?.id === place.id;

  // LOD 策略
  if (lod < 0.3) {
    if (layer !== 'city') return;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  
  if (lod < 0.6) {
    if (layer === 'location') return;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, radius * 0.8, 0, Math.PI * 2);
    ctx.fill();
    if (layer === 'city') {
      ctx.font = '10px sans-serif';
      ctx.fillStyle = '#2D3436';
      ctx.textAlign = 'center';
      ctx.fillText(place.name, x, y - radius - 2);
    }
    return;
  }

  ctx.shadowColor = isSelected ? '#FFD700' : 'rgba(255,255,255,0.8)';
  ctx.shadowBlur = isSelected ? 20 : 10;

  const size = (radius + 2) * (isHovered ? 1.2 : 1);
  drawPlaceIcon(ctx, x, y, size, color, layer);

  if (isSelected) {
    ctx.strokeStyle = '#FFD700';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, radius + 4, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.shadowBlur = 0;

  const fontSize = getLabelSize(layer);
  ctx.font = `${getLabelWeight(layer)} ${fontSize}px "Microsoft YaHei", sans-serif`;
  ctx.fillStyle = '#2D3436';
  ctx.textAlign = 'center';
  
  const text = place.name;
  const metrics = ctx.measureText(text);
  const padding = 3;
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillRect(
    x - metrics.width / 2 - padding,
    y - fontSize - radius - 6,
    metrics.width + padding * 2,
    fontSize + 4
  );
  
  ctx.fillStyle = '#2D3436';
  ctx.fillText(text, x, y - radius - 4);
}

function drawPlaceIcon(ctx, x, y, size, color, layer) {
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = 1;

  switch (layer) {
    case 'city':
      ctx.beginPath();
      ctx.rect(x - size * 0.7, y - size * 0.7, size * 1.4, size * 1.4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.beginPath();
      ctx.arc(x, y, size * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x - size * 0.4, y - size * 0.7);
      ctx.lineTo(x, y - size * 1.1);
      ctx.lineTo(x + size * 0.4, y - size * 0.7);
      ctx.closePath();
      ctx.fill();
      break;

    case 'town':
      ctx.beginPath();
      ctx.roundRect(x - size * 0.6, y - size * 0.6, size * 1.2, size * 1.2, 2);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y - size * 0.35);
      ctx.lineTo(x, y + size * 0.35);
      ctx.moveTo(x - size * 0.35, y);
      ctx.lineTo(x + size * 0.35, y);
      ctx.stroke();
      break;

    case 'location':
    default:
      ctx.beginPath();
      ctx.moveTo(x, y - size);
      ctx.lineTo(x + size, y);
      ctx.lineTo(x, y + size);
      ctx.lineTo(x - size, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath();
      ctx.arc(x, y, size * 0.25, 0, Math.PI * 2);
      ctx.fill();
      break;
  }
}

function drawEditHelpers(ctx) {
  if (currentPath.value.length > 1) {
    ctx.beginPath();
    ctx.moveTo(currentPath.value[0].x, currentPath.value[0].y);
    for (let i = 1; i < currentPath.value.length; i++) {
      ctx.lineTo(currentPath.value[i].x, currentPath.value[i].y);
    }
    ctx.strokeStyle = terrainTypes.find(t => t.type === selectedTerrain.value)?.color || '#000';
    if (interactionMode.value === 'region') {
      ctx.strokeStyle = regionColor.value;
    }
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    
    for (const p of currentPath.value) {
      ctx.fillStyle = '#FF6B6B';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  
  if (drawingPolygon.value && drawingPolygon.value.points.length > 0) {
    ctx.beginPath();
    ctx.moveTo(drawingPolygon.value.points[0].x, drawingPolygon.value.points[0].y);
    for (let i = 1; i < drawingPolygon.value.points.length; i++) {
      ctx.lineTo(drawingPolygon.value.points[i].x, drawingPolygon.value.points[i].y);
    }
    ctx.strokeStyle = terrainTypes.find(t => t.type === selectedTerrain.value)?.color || '#000';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    
    for (const p of drawingPolygon.value.points) {
      ctx.fillStyle = '#FF6B6B';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  
  // 绘制选中省份/区域的可拖拽顶点
  const selectedPoly = selectedProvince.value || selectedRegion.value;
  if (selectedPoly && !drawingPolygon.value) {
    // 绘制边界辅助线
    ctx.strokeStyle = selectedRegion.value ? (selectedRegion.value.color || '#FF6B6B') : 'rgba(255, 215, 0, 0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(selectedPoly.points[0].x, selectedPoly.points[0].y);
    for (let i = 1; i < selectedPoly.points.length; i++) {
      ctx.lineTo(selectedPoly.points[i].x, selectedPoly.points[i].y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    
    for (let i = 0; i < selectedPoly.points.length; i++) {
      const p = selectedPoly.points[i];
      const isHovered = hoveredVertex.value?.vertexIndex === i;
      ctx.fillStyle = isHovered ? '#FF6B6B' : '#FFD700';
      ctx.beginPath();
      ctx.arc(p.x, p.y, isHovered ? 7 : 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ===== 编辑模式切换 =====
function enterEditMode() {
  editMode.value = true;
  drawMode.value = true;
  interactionMode.value = 'pan';
  renderer.requestRender();
}

function exitEditMode() {
  editMode.value = false;
  selectedProvince.value = null;
  selectedRegion.value = null;
  drawingPolygon.value = null;
  currentPath.value = [];
  interactionMode.value = 'pan';
  renderer.requestRender();
}

// ===== 完成绘制（自由绘制模式）=====
function handleDrawComplete(rawPoints) {
  const simplified = simplifyPath(rawPoints, 8);
  if (simplified.length >= 3) {
    // 拓扑校验
    const validation = validatePolygon(simplified);
    if (!validation.valid) {
      const criticalErrors = validation.errors.filter(e => e.type !== 'self-intersecting');
      if (criticalErrors.length > 0) {
        console.warn('[Topology] Polygon validation failed:', criticalErrors);
      }
    }
    
    const isRegionMode = interactionMode.value === 'region';
    let polygon;
    
    if (isRegionMode) {
      // 自动检测包含的地点
      const members = places.value
        .filter(place => {
          const px = place.coordinate?.x;
          const py = place.coordinate?.y;
          return px !== null && py !== null && geoPointInPolygon(px, py, simplified);
        })
        .map(p => p.id);
      
      polygon = {
        id: 'region_' + Date.now(),
        name: '新区域',
        points: simplified,
        color: regionColor.value,
        description: '',
        members,
      };
      store.addRegion(props.planet.id, polygon);
    } else {
      polygon = {
        id: 'terrain_' + Date.now(),
        type: selectedTerrain.value,
        points: simplified,
        controlPoints: null,
      };
      
      if (snapEnabled.value && currentMapData.value?.terrain?.length > 0) {
        const { polygon: snappedPolygon } = snapPolygonToNeighbors(
          polygon,
          currentMapData.value.terrain,
          { vertexThreshold: 12, edgeThreshold: 8, insertVertices: true }
        );
        polygon = snappedPolygon;
      }
      
      store.addTerrainPolygon(props.planet.id, polygon);
    }
    
    emit('dirty', true);
  }
}

// ===== 点击描点模式 =====
function startNewProvince() {
  drawingPolygon.value = {
    id: 'terrain_' + Date.now(),
    type: selectedTerrain.value,
    points: [],
    controlPoints: null,
  };
}

function cancelDrawing() {
  drawingPolygon.value = null;
  renderer.requestRender();
}

function addVertex(wx, wy) {
  if (drawingPolygon.value) {
    drawingPolygon.value.points.push({ x: wx, y: wy });
    renderer.requestRender();
  }
}

function finishPolygon() {
  if (drawingPolygon.value && drawingPolygon.value.points.length >= 3) {
    let polygon = { ...drawingPolygon.value };
    
    if (snapEnabled.value && currentMapData.value?.terrain?.length > 0) {
      const { polygon: snappedPolygon } = snapPolygonToNeighbors(
        polygon,
        currentMapData.value.terrain,
        { vertexThreshold: 12, edgeThreshold: 8, insertVertices: true }
      );
      polygon = snappedPolygon;
    }
    
    store.addTerrainPolygon(props.planet.id, polygon);
    drawingPolygon.value = null;
    renderer.requestRender();
    emit('dirty', true);
  }
}

// ===== 选择/删除省份 =====
function selectProvince(poly) {
  selectedProvince.value = poly;
  selectedRegion.value = null;
  renderer.requestRender();
}

// ===== 区域选择/删除 =====
function selectRegion(region) {
  selectedRegion.value = region;
  selectedProvince.value = null;
  renderer.requestRender();
}

function deleteSelected() {
  if (selectedMarker.value) {
    deleteMarker(selectedMarker.value);
    selectedMarker.value = null;
    renderer.requestRender();
    emit('dirty', true);
  } else if (selectedRegion.value) {
    store.removeRegion(props.planet.id, selectedRegion.value.id);
    selectedRegion.value = null;
    renderer.requestRender();
    emit('dirty', true);
  } else if (selectedProvince.value) {
    store.removeTerrainPolygon(props.planet.id, selectedProvince.value.id);
    selectedProvince.value = null;
    renderer.requestRender();
    emit('dirty', true);
  }
}

function deleteMarker(marker) {
  if (!store.mapData[props.planet.id]) return;
  const idx = store.mapData[props.planet.id].markers.findIndex(m => m.id === marker.id);
  if (idx === -1) return;
  const removed = store.mapData[props.planet.id].markers[idx];
  store.mapData[props.planet.id].markers.splice(idx, 1);
  execute({
    type: 'remove-marker',
    label: '删除标记',
    undo: () => {
      store.mapData[props.planet.id].markers.splice(idx, 0, removed);
    },
    redo: () => {
      store.mapData[props.planet.id].markers = store.mapData[props.planet.id].markers.filter(m => m.id !== marker.id);
    },
  });
  if (selectedMarker.value?.id === marker.id) {
    selectedMarker.value = null;
  }
  emit('dirty', true);
  store.scheduleAutoSaveMap(props.planet.id);
}

function addMarker(wx, wy) {
  if (!store.mapData[props.planet.id]) {
    store.mapData[props.planet.id] = { planetId: props.planet.id, version: 1, terrain: [], regions: [], markers: [] };
  }
  if (!store.mapData[props.planet.id].markers) {
    store.mapData[props.planet.id].markers = [];
  }
  const marker = {
    id: 'marker_' + Date.now(),
    type: selectedMarkerType.value,
    x: wx,
    y: wy,
  };
  store.mapData[props.planet.id].markers.push(marker);
  execute({
    type: 'add-marker',
    label: '放置标记',
    undo: () => {
      store.mapData[props.planet.id].markers = store.mapData[props.planet.id].markers.filter(m => m.id !== marker.id);
    },
    redo: () => {
      store.mapData[props.planet.id].markers.push(marker);
    },
  });
  emit('dirty', true);
  store.scheduleAutoSaveMap(props.planet.id);
}

// ===== 地点拖拽 =====
let draggingPlace = null;

function startDragPlace(node) {
  draggingPlace = node;
  store.beginNodePositionCapture(node.id);
}

function dragPlace(wx, wy) {
  if (draggingPlace) {
    store.updateNodePosition(draggingPlace.id, wx, wy);
    renderer.requestRender();
  }
}

function endDragPlace() {
  draggingPlace = null;
  store.endNodePositionCapture();
  emit('dirty', true);
}

// ===== Undo/Redo =====
function undo() {
  store.undo();
  renderer.requestRender();
}

function redo() {
  store.redo();
  renderer.requestRender();
}

// ===== 保存/清空 =====
async function saveMap() {
  if (props.planet) {
    store.saveMapDataImmediate(props.planet.id);
    emit('dirty', false);
  }
}

async function confirmClear() {
  if (!confirm('确定要清空所有省份和标记吗？此操作不可恢复。')) return;
  if (!currentMapData.value) return;
  for (const poly of [...currentMapData.value.terrain]) {
    store.removeTerrainPolygon(props.planet.id, poly.id);
  }
  if (currentMapData.value.markers) {
    for (const marker of [...currentMapData.value.markers]) {
      deleteMarker(marker);
    }
  }
  selectedProvince.value = null;
  selectedMarker.value = null;
  renderer.requestRender();
  emit('dirty', true);
}

// ===== Canvas Renderer =====
const renderer = useCanvasRenderer(canvas, {
  onRender,
  onHitTest: (wx, wy) => hitTest(wx, wy),
  onHover: (hit, wx, wy) => {
    hoveredNode.value = hit?.type === 'place' ? hit.node : null;
    
    // 更新悬停顶点
    if (editMode.value && (selectedProvince.value || selectedRegion.value)) {
      hoveredVertex.value = hitTestVertex(wx, wy);
    } else {
      hoveredVertex.value = null;
    }
    
    // 区域填充模式：hover 时预览
    if (editMode.value && (interactionMode.value === 'draw' || interactionMode.value === 'region') && floodFillMode.value) {
      // 根据模式决定填充的占用图层
      const isRegionMode = interactionMode.value === 'region';
      const occupiedPolygons = isRegionMode
        ? [...(currentMapData.value.terrain || []), ...(currentMapData.value.regions || [])]
        : (currentMapData.value?.terrain || []);
      
      const points = createProvinceByFloodFill(
        wx, wy,
        occupiedPolygons,
        { gridSize: isRegionMode ? 32 : 32, maxFillRatio: 0.25, simplifyTolerance: 15 }
      );
      floodPreview.value = points;
    } else {
      floodPreview.value = null;
    }
    
    renderer.requestRender();
  },
  onDragStart: (wx, wy, button) => {
    if (button !== 0) return true;
    
    const mode = isSpacebarDown.value ? 'pan' : (interactionMode.value || 'draw');
    
    // 顶点拖拽优先
    if (editMode.value && (selectedProvince.value || selectedRegion.value) && mode === 'pan') {
      const vertexHit = hitTestVertex(wx, wy);
      if (vertexHit) {
        const polygonType = selectedRegion.value ? 'region' : 'terrain';
        const polygonId = (selectedRegion.value || selectedProvince.value).id;
        return {
          mode: 'vertex',
          vertexInfo: { polygonType, polygonId, vertexIndex: vertexHit.vertexIndex }
        };
      }
    }
    
    if (mode !== 'pan') return true;
    
    const hit = hitTest(wx, wy);
    if (hit?.type === 'place') {
      startDragPlace(hit.node);
      return { mode: 'node', nodeId: hit.node.id };
    }
    
    return true;
  },
  onDragMove: (wx, wy, dragInfo) => {
    if (draggingPlace) {
      dragPlace(wx, wy);
      return;
    }
    
    // 顶点拖拽
    if (dragInfo?.mode === 'vertex') {
      const { polygonType, polygonId, vertexIndex } = dragInfo.vertexInfo;
      const collection = polygonType === 'region' 
        ? currentMapData.value?.regions 
        : currentMapData.value?.terrain;
      const polygon = collection?.find(p => p.id === polygonId);
      if (polygon) {
        polygon.points[vertexIndex] = { x: wx, y: wy };
        renderer.requestRender();
      }
    }
  },
  onDragEnd: (wx, wy, dragInfo) => {
    if (draggingPlace) {
      endDragPlace();
    }
    draggingPlace = null;
    
    // 顶点拖拽结束
    if (dragInfo?.mode === 'vertex') {
      const { polygonType, polygonId, vertexIndex } = dragInfo.vertexInfo;
      const collection = polygonType === 'region' 
        ? currentMapData.value?.regions 
        : currentMapData.value?.terrain;
      const polygon = collection?.find(p => p.id === polygonId);
      if (polygon) {
        const endPos = { x: polygon.points[vertexIndex].x, y: polygon.points[vertexIndex].y };
        polygon.points[vertexIndex] = { x: wx, y: wy };
        
        execute({
          type: 'move-vertex',
          label: '移动顶点',
          undo: () => { polygon.points[vertexIndex] = endPos; },
          redo: () => { polygon.points[vertexIndex] = { x: wx, y: wy }; },
        });
        emit('dirty', true);
      }
    }
  },
  onClick: (hit, wx, wy) => {
    if (editMode.value && interactionMode.value === 'draw' && floodFillMode.value) {
      // 区域填充模式：点击生成新省份/区域
      const points = createProvinceByFloodFill(
        wx, wy,
        currentMapData.value?.terrain || [],
        { gridSize: 64, maxFillRatio: 0.25, simplifyTolerance: 10 }
      );
      
      if (points && points.length >= 3) {
        const isRegionMode = interactionMode.value === 'region';
        if (isRegionMode) {
          const region = {
            id: 'region_' + Date.now(),
            name: '新区域',
            points,
            color: regionColor.value,
            description: '',
            members: [],
          };
          store.addRegion(props.planet.id, region);
        } else {
          const polygon = {
            id: 'terrain_' + Date.now(),
            type: selectedTerrain.value,
            points,
            controlPoints: null,
            name: '新' + (terrainTypes.find(t => t.type === selectedTerrain.value)?.label || '省份'),
          };
          store.addTerrainPolygon(props.planet.id, polygon);
        }
        emit('dirty', true);
      }
      return;
    }
    
    if (editMode.value && interactionMode.value === 'marker') {
      addMarker(wx, wy);
      return;
    }
    
    if (editMode.value && (interactionMode.value === 'pan' || interactionMode.value === 'region')) {
      if (hit?.type === 'place') {
        emit('select-node', hit.node);
      } else if (hit?.type === 'province') {
        selectProvince(hit.polygon);
      } else if (hit?.type === 'region') {
        selectRegion(hit.region);
      } else if (hit?.type === 'marker') {
        selectedMarker.value = hit.marker;
        renderer.requestRender();
      }
      return;
    }
    
    if (editMode.value && interactionMode.value === 'draw') {
      if (!drawMode.value) {
        if (drawingPolygon.value) {
          addVertex(wx, wy);
        } else if (hit?.type === 'province') {
          selectProvince(hit.polygon);
        } else if (hit?.type === 'place') {
          emit('select-node', hit.node);
        } else if (hit?.type === 'marker') {
          selectedMarker.value = hit.marker;
          renderer.requestRender();
        } else if (hit?.type === 'region') {
          selectRegion(hit.region);
        } else {
          startNewProvince();
          addVertex(wx, wy);
        }
      } else {
        if (hit?.type === 'province') {
          selectProvince(hit.polygon);
        } else if (hit?.type === 'region') {
          selectRegion(hit.region);
        } else if (hit?.type === 'place') {
          emit('select-node', hit.node);
        } else if (hit?.type === 'marker') {
          selectedMarker.value = hit.marker;
          renderer.requestRender();
        }
      }
    } else {
      if (hit?.type === 'place') {
        emit('select-node', hit.node);
      } else if (hit?.type === 'province') {
        selectProvince(hit.polygon);
      } else if (hit?.type === 'region') {
        selectRegion(hit.region);
      } else if (hit?.type === 'marker') {
        selectedMarker.value = hit.marker;
        renderer.requestRender();
      }
    }
  },
  onDblClick: (hit, wx, wy) => {
    if (editMode.value && !drawMode.value && drawingPolygon.value) {
      finishPolygon();
    } else if (hit?.node?.sourcePath) {
      const url = `obsidian://open?vault=${encodeURIComponent('ROSA')}&file=${encodeURIComponent(hit.node.sourcePath)}`;
      window.sitianAPI.openExternal(url);
    }
  },
  onContextMenu: (wx, wy) => {
    if (!editMode.value) return;
    
    // 右键点击顶点 → 删除顶点
    const vertexHit = hitTestVertex(wx, wy);
    if (vertexHit) {
      deleteVertexAt(wx, wy);
      return;
    }
    
    // 右键点击边 → 插入顶点
    const edgeHit = hitTestEdge(wx, wy);
    if (edgeHit) {
      insertVertexOnEdge(wx, wy);
      return;
    }
  },
  onDrawComplete: handleDrawComplete,
  drawMode,
  currentPath,
  animate: true,
  interactionMode,
  isSpacebarDown,
});

// ===== 键盘事件 =====
function handleKeydown(e) {
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selectedProvince.value || selectedRegion.value) {
      e.preventDefault();
      deleteSelected();
    }
  }
  if (e.key === 'Escape') {
    if (drawingPolygon.value) {
      cancelDrawing();
    } else if (selectedProvince.value) {
      selectedProvince.value = null;
      renderer.requestRender();
    } else if (selectedRegion.value) {
      selectedRegion.value = null;
      renderer.requestRender();
    }
  }
  if (e.key === ' ') {
    if (!isSpacebarDown.value) {
      isSpacebarDown.value = true;
      canvas.value.style.cursor = 'grab';
    }
  }
}

function handleKeyup(e) {
  if (e.key === ' ') {
    isSpacebarDown.value = false;
    updateCursor();
  }
}

// ===== 顶点右键菜单操作 =====
function deleteSelectedVertex() {
  const selectedPoly = selectedProvince.value || selectedRegion.value;
  if (!selectedPoly || selectedPoly.points.length <= 3) return false;
  
  const polygonType = selectedRegion.value ? 'region' : 'terrain';
  const polygonId = selectedPoly.id;
  const collection = polygonType === 'region'
    ? currentMapData.value?.regions
    : currentMapData.value?.terrain;
  const polygon = collection?.find(p => p.id === polygonId);
  if (!polygon || polygon.points.length <= 3) return false;
  
  // 找最近的顶点
  let nearestIdx = -1;
  let nearestDist = Infinity;
  // 使用当前鼠标位置（需要从事件获取）
  // 由于此函数由 contextmenu 触发，我们需要在事件处理中计算
  
  return true;
}

function insertVertexOnEdge(wx, wy) {
  const selectedPoly = selectedProvince.value || selectedRegion.value;
  if (!selectedPoly) return;
  
  const polygonType = selectedRegion.value ? 'region' : 'terrain';
  const polygonId = selectedPoly.id;
  const collection = polygonType === 'region'
    ? currentMapData.value?.regions
    : currentMapData.value?.terrain;
  const polygon = collection?.find(p => p.id === polygonId);
  if (!polygon) return;
  
  const edgeHit = hitTestEdge(wx, wy);
  if (!edgeHit) return;
  
  const newPoint = { x: wx, y: wy };
  const insertIdx = edgeHit.insertIndex;
  const oldPoints = [...polygon.points];
  
  polygon.points.splice(insertIdx, 0, newPoint);
  
  execute({
    type: 'insert-vertex',
    label: '插入顶点',
    undo: () => { polygon.points = oldPoints; },
    redo: () => { polygon.points.splice(insertIdx, 0, newPoint); },
  });
  
  emit('dirty', true);
  renderer.requestRender();
}

function deleteVertexAt(wx, wy) {
  const selectedPoly = selectedProvince.value || selectedRegion.value;
  if (!selectedPoly || selectedPoly.points.length <= 3) return;
  
  const polygonType = selectedRegion.value ? 'region' : 'terrain';
  const polygonId = selectedPoly.id;
  const collection = polygonType === 'region'
    ? currentMapData.value?.regions
    : currentMapData.value?.terrain;
  const polygon = collection?.find(p => p.id === polygonId);
  if (!polygon || polygon.points.length <= 3) return;
  
  const vertexHit = hitTestVertex(wx, wy);
  if (!vertexHit) return;
  
  const removed = polygon.points[vertexHit.vertexIndex];
  const idx = vertexHit.vertexIndex;
  const oldPoints = [...polygon.points];
  
  polygon.points.splice(idx, 1);
  
  execute({
    type: 'remove-vertex',
    label: '删除顶点',
    undo: () => { polygon.points = oldPoints; },
    redo: () => { polygon.points.splice(idx, 1); },
  });
  
  emit('dirty', true);
  renderer.requestRender();
}

// ===== 贝塞尔曲线边界平滑 =====
function smoothPolygonBoundary() {
  const selectedPoly = selectedRegion.value || selectedProvince.value;
  if (!selectedPoly || selectedPoly.points.length < 3) return;
  
  const polygonType = selectedRegion.value ? 'region' : 'terrain';
  const polygonId = selectedPoly.id;
  const collection = polygonType === 'region'
    ? currentMapData.value?.regions
    : currentMapData.value?.terrain;
  const polygon = collection?.find(p => p.id === polygonId);
  if (!polygon || polygon.points.length < 3) return;
  
  const oldPoints = [...polygon.points];
  const oldControlPoints = polygon.controlPoints ? [...polygon.controlPoints] : null;
  
  // 生成平滑曲线：使用中点法生成控制点
  const n = polygon.points.length;
  const controlPoints = [];
  
  for (let i = 0; i < n; i++) {
    const prev = polygon.points[(i - 1 + n) % n];
    const curr = polygon.points[i];
    const next = polygon.points[(i + 1) % n];
    
    // 控制点为前后点的中点（简单的平滑策略）
    controlPoints.push({
      x: (prev.x + next.x) / 2,
      y: (prev.y + next.y) / 2,
    });
  }
  
  polygon.controlPoints = controlPoints;
  
  execute({
    type: 'smooth-boundary',
    label: '平滑边界',
    undo: () => {
      polygon.points = oldPoints;
      polygon.controlPoints = oldControlPoints;
    },
    redo: () => {
      polygon.controlPoints = controlPoints;
    },
  });
  
  emit('dirty', true);
  renderer.requestRender();
}

function updateCursor() {
  if (!canvas.value) return;
  if (isSpacebarDown.value) {
    canvas.value.style.cursor = 'grab';
  } else if (interactionMode.value === 'pan') {
    canvas.value.style.cursor = 'grab';
  } else if (interactionMode.value === 'region') {
    canvas.value.style.cursor = 'crosshair';
  } else if (interactionMode.value === 'draw') {
    canvas.value.style.cursor = 'crosshair';
  } else if (interactionMode.value === 'marker') {
    canvas.value.style.cursor = 'cell';
  }
}

// ===== 生命周期 =====
onMounted(() => {
  renderer.initCanvas();
  renderer.requestRender();
  if (props.planet) {
    store.loadMapData(props.planet.id);
  }
  window.addEventListener('keydown', handleKeydown);
  window.addEventListener('keyup', handleKeyup);
  if (renderer.startAnimation) renderer.startAnimation();
  updateCursor();
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('keyup', handleKeyup);
  if (renderer.stopAnimation) renderer.stopAnimation();
});

watch(interactionMode, () => {
  updateCursor();
});

watch(() => props.planet, (newPlanet) => {
  if (newPlanet) {
    store.loadMapData(newPlanet.id);
  }
  renderer.requestRender();
});

watch(() => store.mapData, () => {
  renderer.requestRender();
}, { deep: true });

defineExpose({ canvas, renderer });
</script>

<style scoped>
.planet-map-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #E8F4F8;
}

.map-header {
  padding: 12px 20px;
  background: rgba(255,255,255,0.6);
  border-bottom: 1px solid #C8E6C9;
}

.header-left {
  display: flex;
  align-items: baseline;
  gap: 16px;
}

.map-header h2 {
  font-size: 16px;
  color: #2D3436;
  margin: 0;
}

.hint {
  font-size: 12px;
  color: #636E72;
  margin: 0;
}

.hint a {
  color: #5B8DEF;
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
  border-bottom: 1px solid #C8E6C9;
  flex-wrap: wrap;
}

.edit-toolbar button {
  padding: 6px 12px;
  border: 1px solid #C8E6C9;
  border-radius: 4px;
  background: white;
  cursor: pointer;
  font-size: 12px;
  color: #2D3436;
}

.edit-toolbar button:hover {
  background: #F0F7F4;
}

.edit-toolbar button.active {
  background: #4ECDC4;
  color: white;
  border-color: #4ECDC4;
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
  border-bottom: 1px solid #C8E6C9;
  align-items: center;
  flex-wrap: wrap;
}

.picker-label {
  font-size: 12px;
  color: #636E72;
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
  border-color: '#FFD700';
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
  background: rgba(255,255,255,0.95);
  border-radius: 8px;
  border: 1px solid #e0e0e0;
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
  color: #2D3436;
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
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 12px;
  font-family: "Microsoft YaHei", sans-serif;
  background: #fff;
  transition: border-color 0.15s;
}
.editor-field input:focus,
.editor-field textarea:focus {
  border-color: #5B8DEF;
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
  background: #E8F4F8;
  border: 1px solid #C8E6C9;
  border-radius: 12px;
  font-size: 11px;
  color: #2D3436;
}
</style>
