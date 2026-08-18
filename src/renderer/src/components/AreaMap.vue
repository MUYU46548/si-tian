<template>
  <div class="area-map-container">
    <div class="map-header">
      <div class="header-left">
        <div class="header-title-row">
          <button class="back-btn" @click="store.backToPlanet()" title="返回行星地图">← 返回</button>
          <h2>{{ areaNode?.name }} — 区域地图</h2>
        </div>
        <p class="hint">
          <span v-if="!editMode">
            点击节点查看详情 · 双击进入子视图 · 滚动缩放 · 拖拽空白处平移 ·
            <a href="#" @click.prevent="enterEditMode">编辑</a>
          </span>
          <span v-else class="edit-hint">
            <strong>编辑模式</strong> —
            {{ interactionMode === 'pan' ? '拖拽平移 / 点击选中 / Shift+点击多选 / Shift+拖拽框选' : '' }}
            {{ interactionMode === 'add_place' ? '点击空白处添加地点（自动网格对齐）' : '' }}
            {{ interactionMode === 'zone' ? '拖拽绘制区域 · 松开闭合' : '' }}
            · <a href="#" @click.prevent="exitEditMode">退出</a>
          </span>
        </p>
      </div>
      <div class="header-actions">
        <template v-if="!editMode">
          <button class="adopt-btn edit-entry-btn" @click="enterEditMode" title="进入编辑模式：添加地点/绘制区域">✏️ 编辑</button>
        </template>
      </div>
    </div>

    <!-- 编辑工具栏 -->
    <div v-if="editMode" class="edit-toolbar-wrap">
      <div class="edit-toolbar">
        <div class="toolbar-group" title="工具">
          <button :class="{ active: interactionMode === 'pan' }" @click="interactionMode = 'pan'" title="拖拽平移 / 点击选中">🤚 拖手</button>
          <button :class="{ active: interactionMode === 'add_place' }" @click="interactionMode = 'add_place'" title="点击空白处添加地点">➕ 地点</button>
          <button :class="{ active: interactionMode === 'zone' }" @click="interactionMode = 'zone'" title="拖拽绘制区域">🗺️ 区域</button>
        </div>

        <div class="toolbar-group" title="绘制辅助">
          <button :class="{ active: gridSnapEnabled }" @click="gridSnapEnabled = !gridSnapEnabled" title="网格对齐（绘制/放置自动吸附）">⊞ 网格</button>
          <template v-if="gridSnapEnabled">
            <span class="toolbar-label">间距</span>
            <button v-for="s in [20, 50, 100]" :key="s" :class="{ active: gridSize === s }" @click="gridSize = s">{{ s }}</button>
          </template>
        </div>

        <div class="toolbar-group" title="操作">
          <button @click="deleteSelected" :disabled="!selectedNode" title="删除选中节点 (Del)">🗑 删除</button>
          <button @click="undo" :disabled="!store.canUndo">↶ 撤销</button>
          <button @click="redo" :disabled="!store.canRedo">↷ 重做</button>
        </div>

        <div class="toolbar-group toolbar-group-exit">
          <button class="toolbar-close" @click="exitEditMode" title="退出编辑模式">✓ 退出</button>
        </div>
      </div>
    </div>

    <!-- 区域颜色选择器 -->
    <div v-if="editMode && interactionMode === 'zone'" class="terrain-picker">
      <span class="picker-label">区域颜色：</span>
      <button
        v-for="c in ZONE_COLORS"
        :key="c"
        :class="{ active: zoneColor === c }"
        :style="{ background: c }"
        @click="zoneColor = c"
        class="color-btn"
      ></button>
    </div>

    <div class="canvas-wrapper">
      <canvas ref="canvas"></canvas>
      <eagle-eye
        :view-bounds="viewBounds"
        :elements="eyeElements"
        :world-bounds="worldBounds"
        @navigate="handleEagleEyeNavigate"
      />
    </div>

    <!-- 选中节点详情浮窗 -->
    <div v-if="selectedNode && !editMode" class="node-detail-popover">
      <div class="popover-header">
        <h4>{{ selectedNode.displayName || selectedNode.name }}</h4>
        <button class="close-btn" @click="selectedNode = null">×</button>
      </div>
      <div class="popover-body">
        <div class="detail-row">
          <span class="detail-label">类型</span>
          <span class="detail-value">{{ layerLabels[selectedNode.layer] || selectedNode.layer }}</span>
        </div>
        <div class="detail-row" v-if="selectedNode.placeType">
          <span class="detail-label">地点类型</span>
          <span class="detail-value">{{ selectedNode.placeType }}</span>
        </div>
        <div class="detail-row" v-if="selectedNode.tags?.length">
          <span class="detail-label">标签</span>
          <span class="detail-value">{{ selectedNode.tags.join(', ') }}</span>
        </div>
        <div class="popover-actions">
          <button class="adopt-btn" @click="enterChildArea" v-if="hasChildNodes">🔍 进入子视图</button>
          <button class="adopt-btn" @click="enterBuildingInterior" v-if="isSelectedBuilding">🏠 建筑内部</button>
          <button class="adopt-btn ghost" @click="openInObsidian" v-if="selectedNode.sourcePath">📄 Obsidian 打开</button>
          <button class="adopt-btn ghost" @click="reparentNodeToPlanet" v-if="props.areaNode?.parentId">⬇ 移出区域</button>
        </div>
      </div>
    </div>

    <!-- 添加地点对话框 -->
    <div v-if="addPlaceDialogOpen" class="modal-overlay" @click.self="addPlaceDialogOpen = false">
      <div class="modal-dialog">
        <h3>添加地点</h3>
        <div class="form-row">
          <label>名称</label>
          <input v-model="newPlaceName" placeholder="地点名称" @keyup.enter="confirmAddPlace" />
        </div>
        <div class="form-row">
          <label>层级</label>
          <select v-model="newPlaceLayer">
            <option value="facility">设施</option>
            <option value="location">地点</option>
            <option value="building">建筑</option>
          </select>
        </div>
        <div class="modal-actions">
          <button class="adopt-btn" @click="confirmAddPlace">添加</button>
          <button class="adopt-btn ghost" @click="addPlaceDialogOpen = false">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, reactive } from 'vue';
import { useGeodataStore } from '../store/geodata';
import { useLayersStore } from '../store/layers';
import { useCanvasRenderer } from '../composables/useCanvasRenderer';
import EagleEye from './EagleEye.vue';

const props = defineProps({
  areaNode: { type: Object, default: null },
});

const store = useGeodataStore();
const layers = useLayersStore();

const canvas = ref(null);
const editMode = ref(false);
const interactionMode = ref('pan');
const selectedNode = ref(null);
const selectedNodeIds = ref([]); // 多选节点 ID 列表
const gridSnapEnabled = ref(true);
const gridSize = ref(50);
const ZONE_COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8'];

// 添加地点对话框
const addPlaceDialogOpen = ref(false);
const newPlaceName = ref('');
const newPlaceLayer = ref('facility');
const addPlaceWorldPos = ref({ x: 0, y: 0 });

// 区域绘制
const zoneColor = ref('#FF6B6B');
const zoneDraftPoints = ref([]);
const isDrawingZone = ref(false);

// 撤销/重做 label
const undoLabel = computed(() => store.undoLabel);

// 层级标签
const layerLabels = {
  world: '世界', star_domain: '星域', galaxy: '星系', star: '恒星',
  planet: '行星', moon: '卫星', region: '区域', city: '城市',
  town: '城镇', village: '村庄', facility: '设施', location: '地点',
  building: '建筑', unknown: '未知'
};

// 当前区域子节点
const areaPlaces = computed(() => {
  if (!props.areaNode) return [];
  return store.currentAreaPlaces;
});

// 是否有子节点（用于显示"进入子视图"按钮）
const hasChildNodes = computed(() => {
  if (!selectedNode.value) return false;
  return store.nodes.some(n => n.parentId === selectedNode.value.id);
});

// 是否为建筑节点（用于显示"进入建筑内部"按钮）
const isSelectedBuilding = computed(() => {
  return selectedNode.value?.layer === 'building';
});

// 当前区域多边形列表
const areaZones = computed(() => {
  if (!props.areaNode) return [];
  return store.areaZones[props.areaNode.id] || [];
});

// 选中区域
const selectedZone = ref(null);

// ===== Canvas Renderer (new drag interface) =====
const renderer = useCanvasRenderer(canvas, {
  onRender: (ctx, w, h) => {
    // 背景
    const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
    bg.addColorStop(0, '#1a1a2e');
    bg.addColorStop(1, '#16213e');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // 网格（编辑模式开启时显示）
    if (editMode.value && gridSnapEnabled.value) {
      drawGrid(ctx, w, h);
    }

    // 绘制区域多边形（在节点下方作为背景）
    drawZones(ctx);

    // 绘制子节点
    drawNodes(ctx);

    // 绘制区域绘制中的草稿
    if (isDrawingZone.value && zoneDraftPoints.value.length > 0) {
      drawZoneDraft(ctx);
    }
  },
  onDragStart: handleDragStart,
  onDragMove: handleDragMove,
  onDragEnd: handleDragEnd,
  onHitTest: hitTest,
  onClick: handleCanvasClick,
  onBoxSelect: handleBoxSelect,
  onWheel: handleWheel,
  onDblClick: handleDblClick,
  interactionMode: interactionMode,
});

function handleDblClick(hit, worldX, worldY) {
  if (hit && hit.layer === 'building') {
    store.selectBuilding(hit);
  } else if (hit && hasChildNodesCheck(hit)) {
    store.selectArea(hit);
  }
}

function hasChildNodesCheck(node) {
  return store.nodes.some(n => n.parentId === node.id);
}

// ===== 绘制函数 =====
function drawGrid(ctx, w, h) {
  const vt = renderer.getViewTransform();
  const cvs = canvas.value;
  const centerX = cvs.clientWidth / 2 + vt.x;
  const centerY = cvs.clientHeight / 2 + vt.y;
  const worldLeft = -centerX / vt.scale;
  const worldTop = -centerY / vt.scale;
  const worldRight = (cvs.clientWidth - centerX) / vt.scale;
  const worldBottom = (cvs.clientHeight - centerY) / vt.scale;

  const step = gridSize.value;
  const startX = Math.floor(worldLeft / step) * step;
  const startY = Math.floor(worldTop / step) * step;

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = startX; x <= worldRight; x += step) {
    const sx = (x - worldLeft) * vt.scale;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, cvs.clientHeight);
  }
  for (let y = startY; y <= worldBottom; y += step) {
    const sy = (y - worldTop) * vt.scale;
    ctx.moveTo(0, sy);
    ctx.lineTo(cvs.clientWidth, sy);
  }
  ctx.stroke();
}

function drawNodes(ctx) {
  const nodes = areaPlaces.value;
  nodes.forEach(node => {
    const x = node.coordinate?.x || 0;
    const y = node.coordinate?.y || 0;
    const isSelected = selectedNode.value?.id === node.id;
    const isMultiSelected = selectedNodeIds.value.includes(node.id);
    const isDraft = node.draft === true;
    const color = getNodeColor(node.layer);

    // 节点圆点
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = isSelected ? 12 : 6;
    ctx.beginPath();
    ctx.arc(x, y, isSelected ? 8 : 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // 暂存节点虚线边框
    if (isDraft) {
      ctx.strokeStyle = '#888888';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 选中高亮
    if (isSelected || isMultiSelected) {
      ctx.strokeStyle = isSelected ? '#FFD700' : '#58a6ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 12, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 名称标签
    const label = node.displayName || node.name;
    if (label) {
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(label, x, y + 12);
    }
  });
}

function drawZones(ctx) {
  const zones = areaZones.value;
  zones.forEach(zone => {
    if (!zone.points || zone.points.length < 3) return;
    const color = zone.color || '#FF6B6B';
    const isSelected = selectedZone.value?.id === zone.id;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(zone.points[0].x, zone.points[0].y);
    for (let i = 1; i < zone.points.length; i++) {
      ctx.lineTo(zone.points[i].x, zone.points[i].y);
    }
    ctx.closePath();

    ctx.fillStyle = color;
    ctx.globalAlpha = isSelected ? 0.35 : 0.18;
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.strokeStyle = color;
    ctx.lineWidth = isSelected ? 2.5 : 1.5;
    ctx.setLineDash(isSelected ? [] : [4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    if (zone.name) {
      const cx = zone.points.reduce((s, p) => s + p.x, 0) / zone.points.length;
      const cy = zone.points.reduce((s, p) => s + p.y, 0) / zone.points.length;
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(zone.name, cx, cy);
    }

    ctx.restore();
  });
}

function drawZoneDraft(ctx) {
  if (zoneDraftPoints.value.length < 2) return;
  ctx.strokeStyle = zoneColor.value;
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(zoneDraftPoints.value[0].x, zoneDraftPoints.value[0].y);
  for (let i = 1; i < zoneDraftPoints.value.length; i++) {
    ctx.lineTo(zoneDraftPoints.value[i].x, zoneDraftPoints.value[i].y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function getNodeColor(layer) {
  const colors = {
    facility: '#4ECDC4',
    location: '#45B7D1',
    building: '#96CEB4',
    city: '#FFD93D',
    town: '#FF8C42',
    village: '#98D8C8',
  };
  return colors[layer] || '#95A5A6';
}

// ===== 拖拽状态 =====
const dragStartPos = ref(null);
const dragStartNodePos = ref(null);
const isDraggingNode = ref(false);
const multiDragStartMap = ref(null); // Map<id, {x,y}>

// ===== 交互 =====
function handleDragStart(wx, wy, button, shiftKey, ctrlKey, panTry) {
  if (interactionMode.value === 'add_place') {
    return false;
  }

  if (interactionMode.value === 'zone') {
    isDrawingZone.value = true;
    zoneDraftPoints.value = [{ x: wx, y: wy }];
    return false;
  }

  // pan 模式：检测是否点击了节点
  const hit = hitTest(wx, wy);
  if (hit) {
    // 多选模式：Shift/Ctrl+点击
    if (shiftKey || ctrlKey) {
      const idx = selectedNodeIds.value.indexOf(hit.id);
      if (idx === -1) {
        selectedNodeIds.value.push(hit.id);
      } else {
        selectedNodeIds.value.splice(idx, 1);
      }
      selectedNode.value = hit;
    } else {
      // 单选：如果点击的节点不在多选列表中，清空多选
      if (!selectedNodeIds.value.includes(hit.id)) {
        selectedNodeIds.value = [hit.id];
      }
      selectedNode.value = hit;
    }
    dragStartPos.value = { x: wx, y: wy };
    dragStartNodePos.value = { x: hit.coordinate?.x || 0, y: hit.coordinate?.y || 0 };
    isDraggingNode.value = true;

    // 记录多选拖拽起始位置
    if (selectedNodeIds.value.length > 1) {
      multiDragStartMap.value = new Map();
      for (const id of selectedNodeIds.value) {
        const n = areaPlaces.value.find(p => p.id === id);
        if (n) {
          multiDragStartMap.value.set(id, { x: n.coordinate?.x || 0, y: n.coordinate?.y || 0 });
        }
      }
    }

    renderer.requestRender();
    return { mode: 'node', nodeId: hit.id };
  }

  // 空白处
  if (!shiftKey && !ctrlKey) {
    selectedNode.value = null;
    selectedNodeIds.value = [];
    renderer.requestRender();
  }
  return true; // 允许平移
}

function handleDragMove(wx, wy, info) {
  if (isDraggingZone.value) {
    zoneDraftPoints.value.push({ x: wx, y: wy });
    renderer.requestRender();
    return;
  }

  if (isDraggingNode.value && selectedNode.value) {
    const dx = wx - dragStartPos.value.x;
    const dy = wy - dragStartPos.value.y;

    if (selectedNodeIds.value.length > 1 && multiDragStartMap.value) {
      // 多选拖拽：移动所有选中节点
      for (const [id, startPos] of multiDragStartMap.value) {
        const n = areaPlaces.value.find(p => p.id === id);
        if (n) {
          const newX = startPos.x + dx;
          const newY = startPos.y + dy;
          if (gridSnapEnabled.value) {
            const step = gridSize.value;
            n.coordinate.x = Math.round(newX / step) * step;
            n.coordinate.y = Math.round(newY / step) * step;
          } else {
            n.coordinate.x = newX;
            n.coordinate.y = newY;
          }
        }
      }
    } else {
      // 单选拖拽
      const newX = dragStartNodePos.value.x + dx;
      const newY = dragStartNodePos.value.y + dy;
      if (gridSnapEnabled.value) {
        const step = gridSize.value;
        selectedNode.value.coordinate.x = Math.round(newX / step) * step;
        selectedNode.value.coordinate.y = Math.round(newY / step) * step;
      } else {
        selectedNode.value.coordinate.x = newX;
        selectedNode.value.coordinate.y = newY;
      }
    }
    renderer.requestRender();
  }
}

function handleDragEnd(wx, wy, info) {
  if (isDraggingZone.value) {
    isDraggingZone.value = false;
    finishZoneDrawing();
    return;
  }

  if (isDraggingNode.value && selectedNode.value && info.didPan) {
    if (selectedNodeIds.value.length > 1 && multiDragStartMap.value) {
      // 多选拖拽结束：批量更新
      const ids = [...selectedNodeIds.value];
      const startMap = multiDragStartMap.value;
      for (const id of ids) {
        const n = areaPlaces.value.find(p => p.id === id);
        if (n) {
          n.userMoved = true;
        }
      }
      store.beginMultiNodePositionCapture(ids);
      store.endMultiNodePositionCapture();
    } else {
      // 单选拖拽结束
      const n = selectedNode.value;
      n.userMoved = true;
      store.beginNodePositionCapture(n.id);
      store.endNodePositionCapture();
    }
  }
  isDraggingNode.value = false;
  dragStartPos.value = null;
  dragStartNodePos.value = null;
  multiDragStartMap.value = null;
}

function handleCanvasClick(hit, wx, wy) {
  if (interactionMode.value === 'add_place') {
    addPlaceWorldPos.value = gridSnapEnabled.value ? snapPoint({ x: wx, y: wy }) : { x: wx, y: wy };
    newPlaceName.value = '';
    newPlaceLayer.value = 'facility';
    addPlaceDialogOpen.value = true;
    return;
  }

  if (hit) {
    selectedNode.value = hit;
    if (!selectedNodeIds.value.includes(hit.id)) {
      selectedNodeIds.value = [hit.id];
    }
  } else {
    selectedNode.value = null;
    selectedNodeIds.value = [];
  }
  renderer.requestRender();
}

function handleBoxSelect(box, shiftKey) {
  // 框选：选中框内所有节点
  const nodes = areaPlaces.value;
  const inBox = nodes.filter(n => {
    const x = n.coordinate?.x || 0;
    const y = n.coordinate?.y || 0;
    return x >= box.x1 && x <= box.x2 && y >= box.y1 && y <= box.y2;
  });

  if (shiftKey) {
    // Shift+框选：追加到多选列表
    for (const n of inBox) {
      if (!selectedNodeIds.value.includes(n.id)) {
        selectedNodeIds.value.push(n.id);
      }
    }
  } else {
    selectedNodeIds.value = inBox.map(n => n.id);
  }

  if (inBox.length > 0) {
    selectedNode.value = inBox[inBox.length - 1];
  }
  renderer.requestRender();
}

function handleWheel(e) {
  e.preventDefault();
  const delta = e.deltaY > 0 ? -10 : 10;
  const current = renderer.getViewTransform().scale;
  renderer.setScale(Math.max(0.1, Math.min(5, current + delta / 100)));
}

function hitTest(wx, wy) {
  const nodes = areaPlaces.value;
  for (const node of nodes) {
    const dx = wx - (node.coordinate?.x || 0);
    const dy = wy - (node.coordinate?.y || 0);
    if (dx * dx + dy * dy < 14 * 14) return node;
  }
  return null;
}

function snapPoint(world) {
  const step = gridSize.value;
  return {
    x: Math.round(world.x / step) * step,
    y: Math.round(world.y / step) * step,
  };
}

function finishZoneDrawing() {
  if (zoneDraftPoints.value.length < 3) {
    zoneDraftPoints.value = [];
    return;
  }
  // 创建正式区域对象
  const zone = {
    id: `zone_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    name: '',
    color: zoneColor.value,
    points: [...zoneDraftPoints.value],
    parentId: props.areaNode.id,
    createdAt: new Date().toISOString(),
  };
  store.addAreaZone(props.areaNode.id, zone);
  zoneDraftPoints.value = [];
  renderer.requestRender();
}

// ===== 操作 =====
function confirmAddPlace() {
  if (!newPlaceName.value.trim()) return;

  const pos = addPlaceWorldPos.value;
  const newNode = {
    id: `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    name: newPlaceName.value.trim(),
    layer: newPlaceLayer.value,
    parentId: props.areaNode.id,
    tags: [],
    sourcePath: '',
    coordinate: { x: Math.round(pos.x), y: Math.round(pos.y) },
    draft: true, // 标记为暂存（无 Obsidian 词条）
  };

  store.addNode(newNode);
  addPlaceDialogOpen.value = false;
  renderer.requestRender();
}

function deleteSelected() {
  if (!selectedNode.value) return;
  if (!confirm(`确定删除「${selectedNode.value.name}」？`)) return;
  store.removeNode(selectedNode.value.id);
  selectedNode.value = null;
  renderer.requestRender();
}

function enterChildArea() {
  if (!selectedNode.value) return;
  store.selectArea(selectedNode.value);
}

function enterBuildingInterior() {
  if (!selectedNode.value) return;
  store.selectBuilding(selectedNode.value);
}

function openInObsidian() {
  if (selectedNode.value?.sourcePath) {
    const fullPath = `E:/图书馆/ROSA/${selectedNode.value.sourcePath}`;
    window.sitianAPI?.openExternal(`obsidian://open?vault=ROSA&file=${encodeURIComponent(selectedNode.value.sourcePath)}`);
  }
}

// 将节点从区域移回行星（修改 parentId 为行星 ID）
function reparentNodeToPlanet() {
  if (!selectedNode.value || !props.areaNode?.parentId) return;
  const node = selectedNode.value;
  const planetId = props.areaNode.parentId;
  const result = store.reparentNode(node.id, planetId);
  if (result.success) {
    selectedNode.value = null;
    renderer.requestRender();
  } else {
    alert('移出失败：' + result.reason);
  }
}

function undo() {
  store.undo();
  renderer.requestRender();
}

function redo() {
  store.redo();
  renderer.requestRender();
}

// ===== 编辑模式 =====
function enterEditMode() {
  editMode.value = true;
  interactionMode.value = 'pan';
}

function exitEditMode() {
  editMode.value = false;
  isDrawingZone.value = false;
  zoneDraftPoints.value = [];
}

// ===== 面包屑与视图边界 =====
const viewBounds = computed(() => {
  const nodes = areaPlaces.value;
  if (nodes.length === 0) return { minX: -500, minY: -500, maxX: 500, maxY: 500 };
  const xs = nodes.map(n => n.coordinate?.x || 0);
  const ys = nodes.map(n => n.coordinate?.y || 0);
  const padding = 200;
  return {
    minX: Math.min(...xs) - padding,
    minY: Math.min(...ys) - padding,
    maxX: Math.max(...xs) + padding,
    maxY: Math.max(...ys) + padding,
  };
});

const worldBounds = computed(() => viewBounds.value);

const eyeElements = computed(() => {
  return areaPlaces.value.map(n => ({
    x: n.coordinate?.x || 0,
    y: n.coordinate?.y || 0,
    radius: 6,
  }));
});

function handleEagleEyeNavigate(world) {
  renderer.focusOn(world.x, world.y, renderer.getViewTransform().scale);
}

// ===== 生命周期 =====
onMounted(() => {
  renderer.initCanvas();
  renderer.requestRender();
  window.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  renderer.cleanupCanvas();
  window.removeEventListener('keydown', handleKeydown);
});

function handleKeydown(e) {
  if (e.key === 'Delete') {
    if (selectedNodeIds.value.length > 1) {
      if (confirm(`确定删除选中的 ${selectedNodeIds.value.length} 个节点？`)) {
        for (const id of [...selectedNodeIds.value]) {
          store.removeNode(id);
        }
        selectedNodeIds.value = [];
        selectedNode.value = null;
        renderer.requestRender();
      }
    } else if (selectedNode.value) {
      deleteSelected();
    }
  }
  if (e.key === 'Escape') {
    if (editMode.value) exitEditMode();
    else {
      selectedNode.value = null;
      selectedNodeIds.value = [];
    }
    renderer.requestRender();
  }
}

// 监听节点变化自动重绘
watch(areaPlaces, () => {
  renderer.requestRender();
});
</script>

<style scoped>
.area-map-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-primary);
}

.map-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 16px;
  border-bottom: 1px solid var(--nav-border);
  background: var(--toolbar-bg);
}

.header-left {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.header-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.back-btn {
  background: none;
  border: 1px solid var(--nav-border);
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  font-size: 12px;
}

.back-btn:hover {
  background: var(--btn-bg);
}

.area-map-container h2 {
  font-size: 14px;
  color: var(--text-primary);
  margin: 0;
}

.hint {
  font-size: 11px;
  color: var(--text-tertiary);
  margin: 0;
}

.hint a {
  color: var(--accent);
  text-decoration: none;
}

.hint a:hover {
  text-decoration: underline;
}

.edit-hint {
  color: var(--accent);
}

.header-actions {
  display: flex;
  gap: 8px;
}

.adopt-btn {
  padding: 5px 10px;
  border: 1px solid var(--nav-border);
  background: var(--btn-bg);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 11px;
}

.adopt-btn:hover {
  background: var(--btn-hover);
  color: var(--text-primary);
}

.adopt-btn.ghost {
  background: transparent;
}

.edit-entry-btn {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}

.edit-toolbar-wrap {
  border-bottom: 1px solid var(--nav-border);
  background: var(--toolbar-bg);
  padding: 6px 16px;
}

.edit-toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}

.toolbar-group {
  display: flex;
  gap: 4px;
  align-items: center;
}

.toolbar-group button {
  padding: 4px 8px;
  border: 1px solid var(--nav-border);
  background: var(--btn-bg);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 11px;
}

.toolbar-group button.active {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}

.toolbar-group button:hover:not(.active) {
  background: var(--btn-hover);
}

.toolbar-group button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.toolbar-label {
  font-size: 10px;
  color: var(--text-tertiary);
  margin-left: 4px;
}

.toolbar-group-exit {
  margin-left: auto;
}

.toolbar-close {
  background: #2ea043 !important;
  color: white !important;
  border-color: #2ea043 !important;
}

.terrain-picker {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 16px;
  background: var(--toolbar-bg);
  border-bottom: 1px solid var(--nav-border);
}

.picker-label {
  font-size: 11px;
  color: var(--text-tertiary);
}

.color-btn {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
}

.color-btn.active {
  border-color: white;
  box-shadow: 0 0 4px rgba(255, 255, 255, 0.5);
}

.canvas-wrapper {
  flex: 1;
  position: relative;
  overflow: hidden;
}

.canvas-wrapper canvas {
  display: block;
  width: 100%;
  height: 100%;
}

/* 节点详情浮窗 */
.node-detail-popover {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 240px;
  background: var(--panel-bg);
  border: 1px solid var(--nav-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  z-index: 30;
}

.popover-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--nav-border);
}

.popover-header h4 {
  margin: 0;
  font-size: 13px;
  color: var(--text-primary);
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 16px;
}

.close-btn:hover {
  color: var(--text-primary);
}

.popover-body {
  padding: 10px 12px;
}

.detail-row {
  display: flex;
  gap: 8px;
  margin-bottom: 6px;
}

.detail-label {
  font-size: 11px;
  color: var(--text-tertiary);
  min-width: 60px;
}

.detail-value {
  font-size: 11px;
  color: var(--text-primary);
}

.popover-actions {
  display: flex;
  gap: 6px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--nav-border);
}

.popover-actions .adopt-btn {
  flex: 1;
  text-align: center;
}

/* 添加地点对话框 */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 900;
}

.modal-dialog {
  background: var(--panel-bg);
  border: 1px solid var(--nav-border);
  border-radius: var(--radius-lg);
  padding: 20px;
  width: 320px;
  box-shadow: var(--shadow-lg);
}

.modal-dialog h3 {
  margin: 0 0 16px 0;
  font-size: 15px;
  color: var(--text-primary);
}

.form-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
}

.form-row label {
  font-size: 12px;
  color: var(--text-secondary);
  min-width: 50px;
}

.form-row input,
.form-row select {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid var(--nav-border);
  background: var(--bg-primary);
  color: var(--text-primary);
  border-radius: var(--radius-sm);
  font-size: 12px;
}

.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 16px;
}
</style>
