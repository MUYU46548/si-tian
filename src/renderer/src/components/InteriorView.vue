<template>
  <div class="interior-container">
    <div class="map-header">
      <div class="header-left">
        <div class="header-title-row">
          <button class="back-btn" @click="store.backToArea()" title="返回区域地图">← 返回</button>
          <h2>{{ buildingNode?.name }} — 建筑内部</h2>
        </div>
        <p class="hint">
          <span v-if="!editMode">
            点击家具选中 · 拖拽移动 · 滚动缩放 · 拖拽空白处平移 ·
            <a href="#" @click.prevent="enterEditMode">编辑</a>
          </span>
          <span v-else class="edit-hint">
            <strong>编辑模式</strong> —
            {{ interactionMode === 'pan' ? '拖拽家具移动 / 点击选中' : '' }}
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

    <!-- 选中家具详情浮窗 -->
    <div v-if="selectedFurniture && !editMode" class="node-detail-popover">
      <div class="popover-header">
        <h4>{{ selectedFurniture.name }}</h4>
        <button class="close-btn" @click="selectedFurniture = null">×</button>
      </div>
      <div class="popover-body">
        <div class="detail-row">
          <span class="detail-label">类型</span>
          <span class="detail-value">{{ getFurnitureTypeLabel(selectedFurniture.type) }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">位置</span>
          <span class="detail-value">X: {{ Math.round(selectedFurniture.x) }}, Y: {{ Math.round(selectedFurniture.y) }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">尺寸</span>
          <span class="detail-value">{{ selectedFurniture.width }} × {{ selectedFurniture.height }}</span>
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
];

const selectedFurnitureType = ref('generic');

// 添加家具对话框
const addFurnitureDialogOpen = ref(false);
const newFurnitureName = ref('');
const newFurnitureType = ref('generic');
const newFurnitureWidth = ref(60);
const newFurnitureHeight = ref(40);
const addFurnitureWorldPos = ref({ x: 0, y: 0 });

// 当前楼层列表
const floors = computed(() => {
  if (!props.buildingNode) return [];
  const data = store.interiorData[props.buildingNode.id];
  return data?.floors || [];
});

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
  onMouseDown: handleCanvasMouseDown,
  onMouseMove: handleCanvasMouseMove,
  onMouseUp: handleCanvasMouseUp,
  onWheel: handleWheel,
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
    const color = getFurnitureColor(item.type);

    ctx.save();
    ctx.translate(item.x + item.width / 2, item.y + item.height / 2);
    if (item.rotation) ctx.rotate((item.rotation * Math.PI) / 180);

    // 家具矩形
    ctx.fillStyle = color;
    ctx.shadowColor = isSelected ? '#FFD700' : 'rgba(0,0,0,0.3)';
    ctx.shadowBlur = isSelected ? 8 : 4;
    ctx.fillRect(-item.width / 2, -item.height / 2, item.width, item.height);
    ctx.shadowBlur = 0;

    // 选中高亮
    if (isSelected) {
      ctx.strokeStyle = '#FFD700';
      ctx.lineWidth = 2;
      ctx.strokeRect(-item.width / 2 - 2, -item.height / 2 - 2, item.width + 4, item.height + 4);
    }

    // 边框
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(-item.width / 2, -item.height / 2, item.width, item.height);

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

// ===== 交互 =====
function handleCanvasMouseDown(e) {
  const world = renderer.screenToWorld(e.offsetX, e.offsetY);

  if (interactionMode.value === 'add_furniture') {
    addFurnitureWorldPos.value = gridSnapEnabled.value ? snapPoint(world) : world;
    newFurnitureName.value = '';
    newFurnitureType.value = selectedFurnitureType.value;
    newFurnitureWidth.value = 60;
    newFurnitureHeight.value = 40;
    addFurnitureDialogOpen.value = true;
    return;
  }

  // pan 模式：检测是否点击了家具
  const hit = hitTest(world.x, world.y);
  if (hit) {
    selectedFurniture.value = hit;
    renderer.requestRender();
  } else {
    selectedFurniture.value = null;
    renderer.requestRender();
  }
}

function handleCanvasMouseMove(e) {
  // 拖拽家具逻辑（简化版：pan模式下拖拽选中的家具）
}

function handleCanvasMouseUp(e) {
  // 拖拽结束逻辑
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
  if (e.key === 'Delete' && selectedFurniture.value) {
    deleteSelected();
  }
  if (e.key === 'Escape') {
    if (editMode.value) exitEditMode();
    else selectedFurniture.value = null;
    renderer.requestRender();
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
  background: rgba(220, 53, 69, 0.2);
  border-color: #dc3545;
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
  width: 220px;
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
