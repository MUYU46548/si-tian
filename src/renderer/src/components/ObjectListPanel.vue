<template>
  <PanelShell class="object-panel" title="对象列表" :open="open" @close="$emit('close')">
    <div class="panel-body">
      <div class="tab-bar">
        <button
          v-for="t in tabs"
          :key="t.key"
          class="tab-btn"
          :class="{ active: tab === t.key }"
          @click="tab = t.key"
        >
          {{ t.label }}
          <span v-if="counts[t.key] > 0" class="tab-count">{{ counts[t.key] }}</span>
        </button>
      </div>

      <!-- 地形 -->
      <div v-if="tab === 'terrain'" class="list">
        <div v-if="terrainItems.length === 0" class="empty-hint">暂无地形<br /><span class="sub">✏️ 绘制 → 选择地形类型 → 按住拖动绘制省份</span></div>
        <div
          v-for="poly in terrainItems"
          :key="poly.id"
          class="row"
          :class="{ active: activeObjectId === poly.id }"
        >
          <span class="row-color" :style="{ background: terrainColor(poly.type) }"></span>
          <span class="row-name" :title="poly.name || '未命名'" @click="$emit('focus-object', { type: 'terrain', id: poly.id })">
            {{ poly.name || '未命名' }}
          </span>
          <span class="row-tag">{{ terrainLabel(poly.type) }}</span>
          <div class="row-actions">
            <button class="mini-btn" @click="startRename('terrain', poly)" title="重命名">✎</button>
            <button class="mini-btn danger" @click="$emit('delete-object', { type: 'terrain', id: poly.id })" title="删除">🗑</button>
          </div>
        </div>
      </div>

      <!-- 标记 -->
      <div v-if="tab === 'markers'" class="list">
        <div v-if="markerItems.length === 0" class="empty-hint">暂无标记<br /><span class="sub">📍 标记模式 → 点击地图放置</span></div>
        <div
          v-for="m in markerItems"
          :key="m.id"
          class="row"
          :class="{ active: activeObjectId === m.id }"
        >
          <span class="row-icon">{{ markerIcon(m) }}</span>
          <span class="row-name" :title="m.name || markerLabel(m.type)" @click="$emit('focus-object', { type: 'marker', id: m.id })">
            {{ m.name || markerLabel(m.type) }}
          </span>
          <div class="row-actions">
            <button class="mini-btn" @click="startRename('marker', m)" title="重命名">✎</button>
            <button class="mini-btn danger" @click="$emit('delete-object', { type: 'marker', id: m.id })" title="删除">🗑</button>
          </div>
        </div>
      </div>

      <!-- 路线 -->
      <div v-if="tab === 'routes'" class="list">
        <div v-if="routeItems.length === 0" class="empty-hint">暂无路线<br /><span class="sub">🛣️ 路线模式 → 点击放置顶点 → 双击完成</span></div>
        <div
          v-for="r in routeItems"
          :key="r.id"
          class="row"
          :class="{ active: activeObjectId === r.id }"
        >
          <span class="row-color" :style="{ background: r.color || '#E67E22' }"></span>
          <span class="row-name" :title="r.name || '未命名'" @click="$emit('focus-object', { type: 'route', id: r.id })">
            {{ r.name || '未命名' }}
            <span class="row-sub">{{ r.points?.length || 0 }} 点</span>
          </span>
          <span class="row-tag">{{ r.dashed ? '虚线' : '实线' }}</span>
          <div class="row-actions">
            <button class="mini-btn" @click="startRename('route', r)" title="重命名">✎</button>
            <button class="mini-btn danger" @click="$emit('delete-object', { type: 'route', id: r.id })" title="删除">🗑</button>
          </div>
        </div>
      </div>

      <!-- 文本 -->
      <div v-if="tab === 'texts'" class="list">
        <div v-if="textItems.length === 0" class="empty-hint">暂无浮动文本<br /><span class="sub">🔤 文本模式 → 点击地图放置</span></div>
        <div
          v-for="t in textItems"
          :key="t.id"
          class="row"
          :class="{ active: activeObjectId === t.id }"
        >
          <span class="row-color" :style="{ background: t.color || '#58A6FF' }"></span>
          <span class="row-name" :title="t.text" @click="$emit('focus-object', { type: 'text', id: t.id })">
            {{ t.text || '文本' }}
          </span>
          <div class="row-actions">
            <button class="mini-btn" @click="startRename('text', t)" title="重命名">✎</button>
            <button class="mini-btn danger" @click="$emit('delete-object', { type: 'text', id: t.id })" title="删除">🗑</button>
          </div>
        </div>
      </div>

      <!-- 内联改名输入框 -->
      <div v-if="renaming" class="rename-bar">
        <input
          ref="renameInput"
          v-model="renameValue"
          @keydown.enter="commitRename"
          @keydown.esc="renaming = null"
          @blur="commitRename"
          :placeholder="renameHint"
        />
      </div>
    </div>
  </PanelShell>
</template>

<script setup>
import { ref, computed, nextTick } from 'vue';
import PanelShell from './PanelShell.vue';
import { useGeodataStore } from '../store/geodata';

const store = useGeodataStore();

const props = defineProps({
  planet: { type: Object, default: null },
  open: { type: Boolean, default: false },
  activeObjectId: { type: String, default: null },
});

const emit = defineEmits(['close', 'focus-object', 'rename-object', 'delete-object']);

const TERRAIN_META = {
  ocean: { label: '海洋', color: '#2E86AB' },
  land: { label: '陆地', color: '#A3C4BC' },
  forest: { label: '森林', color: '#2D6A4F' },
  desert: { label: '沙漠', color: '#E9C46A' },
  mountain: { label: '山脉', color: '#8B7355' },
  snow: { label: '雪地', color: '#E8E8E8' },
  lake: { label: '湖泊', color: '#457B9D' },
};

const MARKER_META = {
  chest: { label: '宝箱', icon: '📦', color: '#FFD700' },
  teleport: { label: '传送点', icon: '🌀', color: '#9B59B6' },
  boss: { label: 'Boss', icon: '💀', color: '#E74C3C' },
  resource: { label: '资源', icon: '💎', color: '#3498DB' },
  npc: { label: 'NPC', icon: '👤', color: '#2ECC71' },
  flag: { label: '旗帜', icon: '🚩', color: '#E67E22' },
};

const tabs = [
  { key: 'terrain', label: '地形' },
  { key: 'markers', label: '标记' },
  { key: 'routes', label: '路线' },
  { key: 'texts', label: '文本' },
];

const tab = ref('terrain');

const mapData = computed(() => (props.planet ? store.mapData[props.planet.id] : null));

const terrainItems = computed(() => mapData.value?.terrain || []);
const markerItems = computed(() => mapData.value?.markers || []);
const routeItems = computed(() => mapData.value?.routes || []);
const textItems = computed(() => mapData.value?.textLabels || []);

const counts = computed(() => ({
  terrain: terrainItems.value.length,
  markers: markerItems.value.length,
  routes: routeItems.value.length,
  texts: textItems.value.length,
}));

function terrainColor(type) {
  return TERRAIN_META[type]?.color || '#A3C4BC';
}
function terrainLabel(type) {
  return TERRAIN_META[type]?.label || type;
}
function markerIcon(m) {
  return m.icon || MARKER_META[m.type]?.icon || '📍';
}
function markerLabel(type) {
  return MARKER_META[type]?.label || type;
}

// ===== 内联改名 =====
const renaming = ref(null); // { type, obj }
const renameValue = ref('');
const renameInput = ref(null);
const renameHint = ref('');

function startRename(type, obj) {
  renaming.value = { type, obj };
  renameValue.value = type === 'text' ? (obj.text || '') : (obj.name || '');
  renameHint.value = type === 'text' ? '文本内容' : '名称';
  nextTick(() => renameInput.value?.focus());
}

function commitRename() {
  if (!renaming.value) return;
  const { type, obj } = renaming.value;
  const val = renameValue.value.trim();
  if (val && val !== (type === 'text' ? obj.text : obj.name)) {
    emit('rename-object', { type, id: obj.id, name: val });
  }
  renaming.value = null;
}
</script>

<style scoped>
/* 定位与尺寸由本类提供，外观/拖拽/折叠/关闭由 PanelShell 统一处理 */
.object-panel {
  position: absolute;
  left: 8px;
  bottom: 8px;
  z-index: 31;
  min-width: 240px;
  max-width: 300px;
  max-height: 360px;
}

.panel-body {
  overflow-y: auto;
  padding: 6px;
}

.tab-bar {
  display: flex;
  gap: 2px;
  margin-bottom: 6px;
}

.tab-btn {
  flex: 1;
  background: #161b22;
  border: 1px solid #30363d;
  color: #8b949e;
  font-size: 11px;
  padding: 4px 2px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.tab-btn.active {
  background: #21262d;
  color: #f0f6fc;
  border-color: #58a6ff;
}

.tab-count {
  background: #30363d;
  color: #8b949e;
  font-size: 9px;
  padding: 0 5px;
  border-radius: 8px;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  color: #c9d1d9;
  cursor: default;
}

.row:hover {
  background: #21262d;
}

.row.active {
  background: rgba(88, 166, 255, 0.15);
  border: 1px solid rgba(88, 166, 255, 0.4);
  padding: 3px 5px;
}

.row-color {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex-shrink: 0;
}

.row-icon {
  font-size: 12px;
  width: 14px;
  text-align: center;
  flex-shrink: 0;
}

.row-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}

.row-name:hover {
  color: #f0f6fc;
}

.row-sub {
  color: #484f58;
  font-size: 10px;
  margin-left: 4px;
}

.row-tag {
  background: #21262d;
  color: #8b949e;
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 8px;
  flex-shrink: 0;
}

.row-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
  flex-shrink: 0;
}

.row:hover .row-actions {
  opacity: 1;
}

.mini-btn {
  background: none;
  border: 1px solid #30363d;
  color: #8b949e;
  cursor: pointer;
  font-size: 10px;
  width: 19px;
  height: 19px;
  border-radius: 3px;
  line-height: 1;
}

.mini-btn:hover {
  color: #f0f6fc;
  background: #21262d;
}

.mini-btn.danger:hover {
  color: #f85149;
  border-color: #f85149;
}

.empty-hint {
  padding: 14px 10px;
  text-align: center;
  font-size: 11px;
  color: #8b949e;
  line-height: 1.6;
}

.empty-hint .sub {
  font-size: 10px;
  color: #484f58;
}

.rename-bar {
  margin-top: 6px;
}

.rename-bar input {
  width: 100%;
  background: #0d1117;
  border: 1px solid #58a6ff;
  color: #f0f6fc;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  outline: none;
}
</style>
