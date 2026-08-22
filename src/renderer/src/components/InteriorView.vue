<template>
  <div class="interior-container">
    <div class="map-header">
      <div class="header-left">
        <div class="header-title-row">
          <button class="back-btn" @click="store.backToArea()" title="返回区域地图">← 返回</button>
          <h2>{{ buildingNode?.name }} — 建筑内部</h2>
          <!-- 相邻建筑切换器 -->
          <div v-if="sameAreaBuildings.length > 1" class="building-switcher">
            <button class="building-switch-btn" @click="showBuildingMenu = !showBuildingMenu" title="切换同区域建筑">
              🏛 {{ sameAreaBuildings.length }}
            </button>
            <div v-if="showBuildingMenu" class="building-menu" @click.stop>
              <div 
                v-for="b in sameAreaBuildings" 
                :key="b.id" 
                :class="{ current: b.id === buildingNode?.id }"
                @click="switchBuilding(b)"
              >{{ b.displayName || b.name }}</div>
            </div>
          </div>
        </div>
        <p class="hint">
          <span v-if="!editMode">
            点击家具选中 · 拖拽移动 · 滚动缩放 · 拖拽空白处平移 ·
            <a href="#" @click.prevent="enterEditMode">编辑</a>
          </span>
          <span v-else class="edit-hint">
            <strong>编辑模式</strong> —
            {{ interactionMode === 'pan' ? '拖拽家具移动 / 点击选中 / Shift+点击多选 / Shift+拖拽框选' : '' }}
            {{ interactionMode === 'add_furniture' ? '点击空白处放置家具' : '' }}
            · <a href="#" @click.prevent="exitEditMode">退出</a>
          </span>
        </p>
      </div>
      <div class="header-actions">
        <template v-if="!editMode">
          <button class="adopt-btn edit-entry-btn" @click="enterEditMode" title="进入编辑模式">✏️ 编辑</button>
        </template>
      </div>
    </div>

    <!-- 楼层切换栏 -->
    <div class="floor-bar">
      <div class="floor-tabs">
        <button
          v-for="floor in floors"
          :key="floor.id"
          :class="['floor-tab', { active: currentFloorId === floor.id }]"
          @click="selectFloor(floor.id)"
          :title="`${floor.name} (${floor.furniture?.length || 0} 物品)`"
        >
          <span class="floor-level">{{ floor.level + 1 }}F</span>
          <span class="floor-name">{{ floor.name }}</span>
        </button>
      </div>
      <div class="floor-actions">
        <button class="floor-btn" @click="addFloor" title="添加楼层">➕ 楼层</button>
        <button class="floor-btn" @click="renameFloor" :disabled="floors.length <= 1" title="重命名楼层">✎ 命名</button>
        <button class="floor-btn danger" @click="removeFloor" :disabled="floors.length <= 1" title="删除当前楼层">🗑 删除</button>
      </div>
    </div>

    <!-- 编辑工具栏 -->
    <div v-if="editMode" class="edit-toolbar-wrap">
      <div class="edit-toolbar">
        <div class="toolbar-group" title="工具">
          <button :class="{ active: interactionMode === 'pan' }" @click="interactionMode = 'pan'" title="拖拽平移 / 选中家具">🤚 拖手</button>
          <button :class="{ active: interactionMode === 'add_furniture' }" @click="interactionMode = 'add_furniture'" title="点击空白处放置家具">🪑 家具</button>
        </div>

        <div class="toolbar-group" title="家具类型" v-if="interactionMode === 'add_furniture'">
          <span class="toolbar-label">类型</span>
          <button
            v-for="ft in FURNITURE_TYPES"
            :key="ft.type"
            :class="{ active: selectedFurnitureType === ft.type }"
            @click="selectedFurnitureType = ft.type"
            :title="ft.label"
          >{{ ft.icon }} {{ ft.label }}</button>
        </div>

        <div class="toolbar-group" title="绘制辅助">
          <button :class="{ active: gridSnapEnabled }" @click="gridSnapEnabled = !gridSnapEnabled" title="网格对齐">⊞ 网格</button>
          <template v-if="gridSnapEnabled">
            <span class="toolbar-label">间距</span>
            <button v-for="s in [20, 40, 80]" :key="s" :class="{ active: gridSize === s }" @click="gridSize = s">{{ s }}</button>
          </template>
        </div>

        <div class="toolbar-group" title="操作">
          <button @click="deleteSelected" :disabled="!selectedFurniture" title="删除选中家具 (Del)">🗑 删除</button>
          <button @click="rotateSelected" :disabled="!selectedFurniture" title="旋转选中家具 (R)">↻ 旋转</button>
          <button @click="undo" :disabled="!store.canUndo">↶ 撤销</button>
          <button @click="redo" :disabled="!store.canRedo">↷ 重做</button>
        </div>

        <div class="toolbar-group toolbar-group-exit">
          <button class="toolbar-close" @click="exitEditMode" title="退出编辑模式">✓ 退出</button>
        </div>
      </div>
    </div>

    <div class="canvas-wrapper">
      <canvas ref="canvas"></canvas>
      <eagle-eye
        v-if="viewBounds"
        :view-bounds="viewBounds"
        :elements="eyeElements"
        :world-bounds="worldBounds"
        @navigate="handleEagleEyeNavigate"
      />
    </div>

    <!-- 选中家具详情浮窗（可编辑） -->
    <div v-if="selectedFurniture && !editMode" class="node-detail-popover">
      <div class="popover-header">
        <h4 v-if="!editingPopover">{{ selectedFurniture.name }}</h4>
        <input v-else v-model="editForm.name" class="popover-title-input" placeholder="家具名称" />
        <div class="popover-header-actions">
          <button v-if="!editingPopover" class="edit-btn" @click="startEditPopover" title="编辑">✎</button>
          <button class="close-btn" @click="cancelEditPopover">×</button>
        </div>
      </div>
      <div class="popover-body">
        <div class="detail-row">
          <span class="detail-label">类型</span>
          <select v-if="editingPopover" v-model="editForm.type" class="popover-select">
            <option v-for="ft in FURNITURE_TYPES" :key="ft.type" :value="ft.type">{{ ft.icon }} {{ ft.label }}</option>
          </select>
          <span v-else class="detail-value">{{ getFurnitureTypeLabel(selectedFurniture.type) }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">位置</span>
          <span class="detail-value">X: {{ Math.round(selectedFurniture.x) }}, Y: {{ Math.round(selectedFurniture.y) }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">尺寸</span>
          <div v-if="editingPopover" class="size-inputs">
            <input type="number" v-model.number="editForm.width" min="10" max="500" class="size-input" />
            <span class="size-sep">×</span>
            <input type="number" v-model.number="editForm.height" min="10" max="500" class="size-input" />
          </div>
          <span v-else class="detail-value">{{ selectedFurniture.width }} × {{ selectedFurniture.height }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">旋转</span>
          <div v-if="editingPopover" class="rotation-input">
            <input type="number" v-model.number="editForm.rotation" min="0" max="359" step="1" class="popover-number" />
            <span class="unit-label">°</span>
          </div>
          <span v-else class="detail-value">{{ selectedFurniture.rotation || 0 }}°</span>
        </div>
        <div v-if="editingPopover" class="popover-actions">
          <button class="adopt-btn" @click="saveEditPopover">保存</button>
          <button class="adopt-btn ghost" @click="cancelEditPopover">取消</button>
        </div>
      </div>
    </div>

    <!-- 添加家具对话框 -->
    <div v-if="addFurnitureDialogOpen" class="modal-overlay" @click.self="addFurnitureDialogOpen = false">
      <div class="modal-dialog">
        <h3>放置家具</h3>
        <div class="form-row">
          <label>名称</label>
          <input v-model="newFurnitureName" placeholder="家具名称" @keyup.enter="confirmAddFurniture" />
        </div>
        <div class="form-row">
          <label>类型</label>
          <select v-model="newFurnitureType">
            <option v-for="ft in FURNITURE_TYPES" :key="ft.type" :value="ft.type">{{ ft.icon }} {{ ft.label }}</option>
          </select>
        </div>
        <div class="form-row">
          <label>宽度</label>
          <input type="number" v-model.number="newFurnitureWidth" min="10" max="500" />
        </div>
        <div class="form-row">
          <label>高度</label>
          <input type="number" v-model.number="newFurnitureHeight" min="10" max="500" />
        </div>
        <div class="modal-actions">
          <button class="adopt-btn" @click="confirmAddFurniture">放置</button>
          <button class="adopt-btn ghost" @click="addFurnitureDialogOpen = false">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, reactive } from 'vue';
import { useGeodataStore } from '../store/geodata';
import { useCanvasRenderer } from '../composables/useCanvasRenderer';
import EagleEye from './EagleEye.vue';

const props = defineProps({
  buildingNode: { type: Object, default: null },
});

const store = useGeodataStore();

const canvas = ref(null);
const editMode = ref(false);
const interactionMode = ref('pan');
const selectedFurniture = ref(null);
const selectedFurnitureIds = ref([]); // 多选家具 ID 列表
const gridSnapEnabled = ref(true);
const gridSize = ref(40);

// 家具类型
const FURNITURE_TYPES = [
  { type: 'generic', label: '通用', icon: '📦', color: '#8B8B8B' },
  { type: 'table', label: '桌子', icon: '🪑', color: '#A0522D' },
  { type: 'chair', label: '椅子', icon: '💺', color: '#CD853F' },
  { type: 'bed', label: '床', icon: '🛏', color: '#4682B4' },
  { type: 'chest', label: '柜子', icon: '🗄', color: '#8B4513' },
  { type: 'decoration', label: '装饰', icon: '🏺', color: '#DAA520' },
  { type: 'door', label: '门', icon: '🚪', color: '#696969' },
  { type: 'window', label: '窗', icon: '🪟', color: '#87CEEB' },
  // 区域类型（院落/园林）
  { type: 'courtyard', label: '院落', icon: '🏡', color: '#4CAF50', isArea: true },
  { type: 'garden', label: '园林', icon: '🌿', color: '#2E7D32', isArea: true },
  { type: 'corridor', label: '走廊', icon: '🛤', color: '#FF9800', isArea: true },
  { type: 'pond', label: '水池', icon: '💧', color: '#2196F3', isArea: true },
  { type: 'wall', label: '围墙', icon: '🧱', color: '#795548', isArea: true },
];

// 判断是否为区域类型
function isAreaType(type) {
  const ft = FURNITURE_TYPES.find(t => t.type === type);
  return ft?.isArea || false;
}

const selectedFurnitureType = ref('generic');

// 添加家具对话框
const addFurnitureDialogOpen = ref(false);
const newFurnitureName = ref('');
const newFurnitureType = ref('generic');
const newFurnitureWidth = ref(60);
const newFurnitureHeight = ref(40);
const addFurnitureWorldPos = ref({ x: 0, y: 0 });

// 根据类型获取默认尺寸
function getDefaultSize(type) {
  const defaults = {
    generic: { w: 60, h: 40 },
    table: { w: 80, h: 60 },
    chair: { w: 40, h: 40 },
    bed: { w: 100, h: 80 },
    chest: { w: 60, h: 40 },
    decoration: { w: 30, h: 30 },
    door: { w: 40, h: 10 },
    window: { w: 60, h: 10 },
    courtyard: { w: 200, h: 200 },
    garden: { w: 240, h: 180 },
    corridor: { w: 160, h: 60 },
    pond: { w: 120, h: 100 },
    wall: { w: 200, h: 20 },
  };
  return defaults[type] || { w: 60, h: 40 };
}

// 类型变化时自动调整默认尺寸
watch(newFurnitureType, (type) => {
  const size = getDefaultSize(type);
  newFurnitureWidth.value = size.w;
  newFurnitureHeight.value = size.h;
});

// 家具详情浮窗编辑
const editingPopover = ref(false);
const editForm = reactive({
  name: '',
  type: 'generic',
  width: 40,
  height: 40,
  rotation: 0,
});

// 当前楼层列表
const floors = computed(() => {
  if (!props.buildingNode) return [];
  const data = store.interiorData[props.buildingNode.id];
  return data?.floors || [];
});

// 同区域建筑列表（用于建筑间跳转）
const sameAreaBuildings = computed(() => {
  if (!props.buildingNode?.parentId) return [];
  return store.getBuildingsInArea(props.buildingNode.parentId);
});
const showBuildingMenu = ref(false);

// 切换到相邻建筑
function switchBuilding(building) {
  if (building.id !== props.buildingNode?.id) {
    store.selectBuilding(building);
  }
  showBuildingMenu.value = false;
}

// 当前选中楼层 ID
const currentFloorId = ref(null);

// 当前楼层的家具列表
const currentFurniture = computed(() => {
  const floor = floors.value.find(f => f.id === currentFloorId.value);
  return floor?.furniture || [];
});

// 楼层切换
function selectFloor(floorId) {
  currentFloorId.value = floorId;
  selectedFurniture.value = null;
  renderer.requestRender();
}

function addFloor() {
  if (!props.buildingNode) return;
  const newFloor = store.addFloor(props.buildingNode.id, `楼层 ${floors.value.length + 1}`);
  currentFloorId.value = newFloor.id;
  renderer.requestRender();
}

function renameFloor() {
  if (!currentFloorId.value) return;
  const floor = floors.value.find(f => f.id === currentFloorId.value);
  if (!floor) return;
  const newName = prompt('楼层名称', floor.name);
  if (newName && newName.trim()) {
    store.updateFloor(props.buildingNode.id, currentFloorId.value, { name: newName.trim() });
  }
}

function removeFloor() {
  if (floors.value.length <= 1) return;
  if (!confirm('确定删除当前楼层及其上的所有家具？')) return;
  store.removeFloor(props.buildingNode.id, currentFloorId.value);
  // 切换到第一个楼层
  if (floors.value.length > 0) {
    currentFloorId.value = floors.value[0].id;
  }
  renderer.requestRender();
}

// ===== Canvas Renderer =====
const renderer = useCanvasRenderer(canvas, {
  onRender: (ctx, w, h) => {
    // 背景
    const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
    bg.addColorStop(0, '#2a2a3e');
    bg.addColorStop(1, '#1a1a2e');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // 网格（编辑模式开启时显示）
    if (editMode.value && gridSnapEnabled.value) {
      drawGrid(ctx, w, h);
    }

    // 绘制家具
    drawFurniture(ctx);
  },
  onDragStart: handleDragStart,
  onDragMove: handleDragMove,
  onDragEnd: handleDragEnd,
  onHitTest: hitTest,
  onClick: handleCanvasClick,
  onBoxSelect: handleBoxSelect,
  onWheel: handleWheel,
  interactionMode: interactionMode,
});

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

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
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

function drawFurniture(ctx) {
  const items = currentFurniture.value;
  items.forEach(item => {
    const isSelected = selectedFurniture.value?.id === item.id;
    const isMultiSelected = selectedFurnitureIds.value.includes(item.id);
    const color = getFurnitureColor(item.type);
    const isArea = isAreaType(item.type);

    ctx.save();
    ctx.translate(item.x + item.width / 2, item.y + item.height / 2);
    if (item.rotation) ctx.rotate((item.rotation * Math.PI) / 180);

    if (isArea) {
      // 区域类型：半透明填充 + 虚线边框 + 图标
      ctx.fillStyle = color + '33';
      ctx.fillRect(-item.width / 2, -item.height / 2, item.width, item.height);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(-item.width / 2, -item.height / 2, item.width, item.height);
      ctx.setLineDash([]);
      const ft = FURNITURE_TYPES.find(t => t.type === item.type);
      const icon = ft?.icon || '📍';
      ctx.font = `${Math.min(item.width, item.height) * 0.4}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(icon, 0, 0);
    } else {
      // 家具类型：实心矩形
      ctx.fillStyle = color;
      ctx.shadowColor = isSelected ? '#FFD700' : 'rgba(0,0,0,0.3)';
      ctx.shadowBlur = isSelected ? 8 : 4;
      ctx.fillRect(-item.width / 2, -item.height / 2, item.width, item.height);
      ctx.shadowBlur = 0;
    }

    // 选中高亮
    if (isSelected) {
      ctx.strokeStyle = '#FFD700';
      ctx.lineWidth = 2;
      ctx.strokeRect(-item.width / 2 - 2, -item.height / 2 - 2, item.width + 4, item.height + 4);
    } else if (isMultiSelected) {
      ctx.strokeStyle = '#58a6ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(-item.width / 2 - 2, -item.height / 2 - 2, item.width + 4, item.height + 4);
    }

    // 边框（仅家具类型）
    if (!isArea) {
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 1;
      ctx.strokeRect(-item.width / 2, -item.height / 2, item.width, item.height);
    }

    ctx.restore();

    // 名称标签
    if (item.name) {
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(item.name, item.x + item.width / 2, item.y + item.height + 4);
    }
  });
}

function getFurnitureColor(type) {
  const ft = FURNITURE_TYPES.find(t => t.type === type);
  return ft?.color || '#8B8B8B';
}

function getFurnitureTypeLabel(type) {
  const ft = FURNITURE_TYPES.find(t => t.type === type);
  return ft?.label || type;
}

// ===== 拖拽状态 =====
const dragStartPos = ref(null);
const dragStartFurniturePos = ref(null);
const isDraggingFurniture = ref(false);
const multiFurnitureStartMap = ref(null); // Map<id, {x,y}>

// ===== 交互 =====
function handleDragStart(wx, wy, button, shiftKey, ctrlKey, panTry) {
  if (interactionMode.value === 'add_furniture') {
    return false;
  }

  const hit = hitTest(wx, wy);
  if (hit) {
    // 多选模式：Shift/Ctrl+点击
    if (shiftKey || ctrlKey) {
      const idx = selectedFurnitureIds.value.indexOf(hit.id);
      if (idx === -1) {
        selectedFurnitureIds.value.push(hit.id);
      } else {
        selectedFurnitureIds.value.splice(idx, 1);
      }
      selectedFurniture.value = hit;
    } else {
      // 单选：如果点击的家具不在多选列表中，清空多选
      if (!selectedFurnitureIds.value.includes(hit.id)) {
        selectedFurnitureIds.value = [hit.id];
      }
      selectedFurniture.value = hit;
    }
    dragStartPos.value = { x: wx, y: wy };
    dragStartFurniturePos.value = { x: hit.x, y: hit.y };
    isDraggingFurniture.value = true;

    // 记录多选拖拽起始位置
    if (selectedFurnitureIds.value.length > 1) {
      multiFurnitureStartMap.value = new Map();
      for (const id of selectedFurnitureIds.value) {
        const item = currentFurniture.value.find(f => f.id === id);
        if (item) {
          multiFurnitureStartMap.value.set(id, { x: item.x, y: item.y });
        }
      }
    }

    renderer.requestRender();
    return { mode: 'node', nodeId: hit.id };
  }

  selectedFurniture.value = null;
  if (!shiftKey && !ctrlKey) {
    selectedFurnitureIds.value = [];
  }
  renderer.requestRender();
  return true;
}

function handleDragMove(wx, wy, info) {
  if (isDraggingFurniture.value && selectedFurniture.value) {
    const dx = wx - dragStartPos.value.x;
    const dy = wy - dragStartPos.value.y;

    if (selectedFurnitureIds.value.length > 1 && multiFurnitureStartMap.value) {
      // 多选拖拽：移动所有选中家具
      for (const [id, startPos] of multiFurnitureStartMap.value) {
        const item = currentFurniture.value.find(f => f.id === id);
        if (item) {
          const newX = startPos.x + dx;
          const newY = startPos.y + dy;
          if (gridSnapEnabled.value) {
            const step = gridSize.value;
            item.x = Math.round(newX / step) * step;
            item.y = Math.round(newY / step) * step;
          } else {
            item.x = newX;
            item.y = newY;
          }
        }
      }
    } else {
      // 单选拖拽
      const newX = dragStartFurniturePos.value.x + dx;
      const newY = dragStartFurniturePos.value.y + dy;
      if (gridSnapEnabled.value) {
        const step = gridSize.value;
        selectedFurniture.value.x = Math.round(newX / step) * step;
        selectedFurniture.value.y = Math.round(newY / step) * step;
      } else {
        selectedFurniture.value.x = newX;
        selectedFurniture.value.y = newY;
      }
    }
    renderer.requestRender();
  }
}

function handleDragEnd(wx, wy, info) {
  if (isDraggingFurniture.value && selectedFurniture.value && info.didPan) {
    if (selectedFurnitureIds.value.length > 1 && multiFurnitureStartMap.value) {
      // 多选拖拽结束：批量更新
      const ids = [...selectedFurnitureIds.value];
      store.beginMultiFurnitureCapture(props.buildingNode.id, currentFloorId.value, ids);
      store.endMultiFurnitureCapture(props.buildingNode.id, currentFloorId.value);
    } else {
      // 单选拖拽结束
      const item = selectedFurniture.value;
      const oldX = dragStartFurniturePos.value.x;
      const oldY = dragStartFurniturePos.value.y;
      if (oldX !== item.x || oldY !== item.y) {
        store.updateFurniture(
          props.buildingNode.id,
          currentFloorId.value,
          item.id,
          { x: item.x, y: item.y },
          { x: oldX, y: oldY }
        );
      }
    }
  }
  isDraggingFurniture.value = false;
  dragStartPos.value = null;
  dragStartFurniturePos.value = null;
  multiFurnitureStartMap.value = null;
}

function handleCanvasClick(hit, wx, wy) {
  if (interactionMode.value === 'add_furniture') {
    addFurnitureWorldPos.value = gridSnapEnabled.value ? snapPoint({ x: wx, y: wy }) : { x: wx, y: wy };
    newFurnitureName.value = '';
    newFurnitureType.value = selectedFurnitureType.value;
    newFurnitureWidth.value = 60;
    newFurnitureHeight.value = 40;
    addFurnitureDialogOpen.value = true;
    return;
  }

  if (hit) {
    selectedFurniture.value = hit;
    if (!selectedFurnitureIds.value.includes(hit.id)) {
      selectedFurnitureIds.value = [hit.id];
    }
  } else {
    selectedFurniture.value = null;
    selectedFurnitureIds.value = [];
  }
  renderer.requestRender();
}

function handleBoxSelect(box, shiftKey) {
  // 框选：选中框内所有家具
  const items = currentFurniture.value;
  const inBox = items.filter(item => {
    const cx = item.x + item.width / 2;
    const cy = item.y + item.height / 2;
    return cx >= box.x1 && cx <= box.x2 && cy >= box.y1 && cy <= box.y2;
  });

  if (shiftKey) {
    for (const item of inBox) {
      if (!selectedFurnitureIds.value.includes(item.id)) {
        selectedFurnitureIds.value.push(item.id);
      }
    }
  } else {
    selectedFurnitureIds.value = inBox.map(i => i.id);
  }

  if (inBox.length > 0) {
    selectedFurniture.value = inBox[inBox.length - 1];
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
  const items = currentFurniture.value;
  // 反向遍历，优先选中后绘制的（视觉上层）
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (wx >= item.x && wx <= item.x + item.width &&
        wy >= item.y && wy <= item.y + item.height) {
      return item;
    }
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

function confirmAddFurniture() {
  if (!newFurnitureName.value.trim() || !currentFloorId.value) return;

  const pos = addFurnitureWorldPos.value;
  store.addFurniture(
    props.buildingNode.id,
    currentFloorId.value,
    {
      name: newFurnitureName.value.trim(),
      type: newFurnitureType.value,
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      width: newFurnitureWidth.value,
      height: newFurnitureHeight.value,
    }
  );
  addFurnitureDialogOpen.value = false;
  renderer.requestRender();
}

function deleteSelected() {
  if (!selectedFurniture.value || !currentFloorId.value) return;
  if (!confirm(`确定删除「${selectedFurniture.value.name}」？`)) return;
  store.removeFurniture(props.buildingNode.id, currentFloorId.value, selectedFurniture.value.id);
  selectedFurniture.value = null;
  renderer.requestRender();
}

function rotateSelected() {
  if (!selectedFurniture.value || !currentFloorId.value) return;
  const item = selectedFurniture.value;
  const oldRotation = item.rotation || 0;
  const newRotation = (oldRotation + 90) % 360;
  store.updateFurniture(
    props.buildingNode.id,
    currentFloorId.value,
    item.id,
    { rotation: newRotation },
    { rotation: oldRotation }
  );
  renderer.requestRender();
}

// ===== 家具详情浮窗编辑 =====
function startEditPopover() {
  if (!selectedFurniture.value) return;
  const item = selectedFurniture.value;
  editForm.name = item.name;
  editForm.type = item.type;
  editForm.width = item.width;
  editForm.height = item.height;
  editForm.rotation = item.rotation || 0;
  editingPopover.value = true;
}

function cancelEditPopover() {
  editingPopover.value = false;
  selectedFurniture.value = null;
}

function saveEditPopover() {
  if (!selectedFurniture.value || !currentFloorId.value) return;
  const item = selectedFurniture.value;
  const updates = {};
  const oldSnapshot = {};

  if (editForm.name !== item.name) {
    updates.name = editForm.name;
    oldSnapshot.name = item.name;
  }
  if (editForm.type !== item.type) {
    updates.type = editForm.type;
    oldSnapshot.type = item.type;
  }
  if (editForm.width !== item.width) {
    updates.width = editForm.width;
    oldSnapshot.width = item.width;
  }
  if (editForm.height !== item.height) {
    updates.height = editForm.height;
    oldSnapshot.height = item.height;
  }
  if (editForm.rotation !== (item.rotation || 0)) {
    updates.rotation = editForm.rotation;
    oldSnapshot.rotation = item.rotation || 0;
  }

  if (Object.keys(updates).length > 0) {
    store.updateFurniture(
      props.buildingNode.id,
      currentFloorId.value,
      item.id,
      updates,
      oldSnapshot
    );
  }
  editingPopover.value = false;
  renderer.requestRender();
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
}

// ===== 面包屑与视图边界 =====
const viewBounds = computed(() => {
  const items = currentFurniture.value;
  if (items.length === 0) return { minX: -500, minY: -500, maxX: 500, maxY: 500 };
  const xs = items.flatMap(f => [f.x, f.x + f.width]);
  const ys = items.flatMap(f => [f.y, f.y + f.height]);
  const padding = 100;
  return {
    minX: Math.min(...xs) - padding,
    minY: Math.min(...ys) - padding,
    maxX: Math.max(...xs) + padding,
    maxY: Math.max(...ys) + padding,
  };
});

const worldBounds = computed(() => viewBounds.value);

const eyeElements = computed(() => {
  return currentFurniture.value.map(f => ({
    x: f.x + f.width / 2,
    y: f.y + f.height / 2,
    radius: Math.max(f.width, f.height) / 2,
  }));
});

function handleEagleEyeNavigate(world) {
  renderer.focusOn(world.x, world.y, renderer.getViewTransform().scale);
}

// ===== 生命周期 =====
onMounted(() => {
  renderer.initCanvas();
  window.addEventListener('keydown', handleKeydown);

  // 初始化：如果没有楼层则创建一个
  if (props.buildingNode && floors.value.length === 0) {
    const newFloor = store.addFloor(props.buildingNode.id, '一楼');
    currentFloorId.value = newFloor.id;
  } else if (floors.value.length > 0) {
    currentFloorId.value = floors.value[0].id;
  }
});

onUnmounted(() => {
  renderer.cleanupCanvas();
  window.removeEventListener('keydown', handleKeydown);
});

function handleKeydown(e) {
  const tag = document.activeElement?.tagName;
  const isEditingInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  if (!isEditingInput && selectedFurniture.value && editMode.value) {
    // 方向键微调家具位置
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      const step = e.shiftKey ? gridSize.value * 5 : gridSize.value;
      let dx = 0, dy = 0;
      if (e.key === 'ArrowLeft') dx = -step;
      if (e.key === 'ArrowRight') dx = step;
      if (e.key === 'ArrowUp') dy = -step;
      if (e.key === 'ArrowDown') dy = step;
      
      const item = selectedFurniture.value;
      const oldX = item.x;
      const oldY = item.y;
      item.x += dx;
      item.y += dy;
      store.updateFurniture(
        props.buildingNode.id,
        currentFloorId.value,
        item.id,
        { x: item.x, y: item.y },
        { x: oldX, y: oldY }
      );
      renderer.requestRender();
      return;
    }
  }
  
  if (e.key === 'Delete' && !isEditingInput) {
    if (selectedFurnitureIds.value.length > 1) {
      if (confirm(`确定删除选中的 ${selectedFurnitureIds.value.length} 件家具？`)) {
        for (const id of [...selectedFurnitureIds.value]) {
          store.removeFurniture(props.buildingNode.id, currentFloorId.value, id);
        }
        selectedFurnitureIds.value = [];
        selectedFurniture.value = null;
        renderer.requestRender();
      }
    } else if (selectedFurniture.value) {
      deleteSelected();
    }
  }
  if (e.key === 'Escape' && !isEditingInput) {
    if (editMode.value) exitEditMode();
    else {
      selectedFurniture.value = null;
      selectedFurnitureIds.value = [];
    }
    renderer.requestRender();
  }
  if (e.key === 'r' && selectedFurniture.value && editMode.value) {
    rotateSelected();
  }
}

// 监听楼层变化自动重绘
watch(currentFurniture, () => {
  renderer.requestRender();
});
</script>

<style scoped>
.interior-container {
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

.interior-container h2 {
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

/* 楼层切换栏 */
.floor-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--nav-border);
  background: var(--toolbar-bg);
}

.floor-tabs {
  display: flex;
  gap: 4px;
  flex: 1;
  overflow-x: auto;
}

.floor-tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--nav-border);
  background: var(--btn-bg);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 11px;
  white-space: nowrap;
}

.floor-tab.active {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}

.floor-tab:hover:not(.active) {
  background: var(--btn-hover);
}

.floor-level {
  font-weight: bold;
  font-size: 10px;
}

.floor-actions {
  display: flex;
  gap: 4px;
}

.floor-btn {
  padding: 4px 8px;
  border: 1px solid var(--nav-border);
  background: var(--btn-bg);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 11px;
}

.floor-btn:hover:not(:disabled) {
  background: var(--btn-hover);
}

.floor-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.floor-btn.danger:hover:not(:disabled) {
  background: rgba(255, 0, 0, 0.1);
  color: #ff6b6b;
}

/* 相邻建筑切换器 */
.building-switcher {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.building-switch-btn {
  padding: 4px 8px;
  border: 1px solid var(--nav-border);
  background: var(--btn-bg);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 11px;
  transition: background 0.1s ease;
}

.building-switch-btn:hover {
  background: var(--btn-hover);
  color: var(--text-primary);
}

.building-menu {
  position: absolute;
  top: 100%;
  left: 0;
  min-width: 160px;
  max-height: 240px;
  overflow-y: auto;
  background: var(--nav-bg, #1c2128);
  border: 1px solid var(--nav-border, #30363d);
  border-radius: var(--radius-md);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  z-index: 1000;
  margin-top: 4px;
  padding: 4px 0;
}

.building-menu div {
  padding: 6px 12px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary);
}

.building-menu div:hover {
  background: var(--btn-hover, #30363d);
  color: var(--text-primary);
}

.building-menu div.current {
  color: var(--accent);
  background: var(--accent-bg, rgba(88, 166, 255, 0.1));
  font-weight: 600;
}

/* 编辑工具栏 */
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
  animation: pulse-glow 2s ease-in-out infinite;
}

@keyframes pulse-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(88, 166, 255, 0.4); }
  50% { box-shadow: 0 0 0 6px rgba(88, 166, 255, 0); }
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

/* 家具详情浮窗 */
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

.popover-header-actions {
  display: flex;
  gap: 4px;
  align-items: center;
}

.edit-btn {
  background: none;
  border: 1px solid var(--nav-border);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  line-height: 1;
}

.edit-btn:hover {
  background: var(--btn-bg);
  color: var(--text-primary);
}

.popover-title-input {
  flex: 1;
  background: var(--bg-primary);
  border: 1px solid var(--nav-border);
  color: var(--text-primary);
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 600;
}

.popover-select,
.popover-number {
  flex: 1;
  background: var(--bg-primary);
  border: 1px solid var(--nav-border);
  color: var(--text-primary);
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  font-size: 11px;
}

.size-inputs {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
}

.size-input {
  width: 50px;
  background: var(--bg-primary);
  border: 1px solid var(--nav-border);
  color: var(--text-primary);
  padding: 3px 5px;
  border-radius: var(--radius-sm);
  font-size: 11px;
}

.size-sep {
  color: var(--text-tertiary);
  font-size: 11px;
}

.rotation-input {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
}

.unit-label {
  color: var(--text-tertiary);
  font-size: 11px;
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
  min-width: 50px;
}

.detail-value {
  font-size: 11px;
  color: var(--text-primary);
}

/* 添加家具对话框 */
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
