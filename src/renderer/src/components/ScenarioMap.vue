<template>
  <div class="scenario-map-container">
    <!-- 顶栏：工具 + 模式切换 -->
    <div class="scenario-toolbar">
      <button @click="$emit('exit')" title="返回世界选择" class="back-btn">← 返回</button>
      <div class="tool-group">
        <button 
          :class="{ active: tool === 'select' }" 
          @click="setTool('select')"
          title="选择 (V) — 拖动平移画布，点击选中省份"
        >✋</button>
        <button 
          :class="{ active: tool === 'draw' }" 
          @click="setTool('draw')"
          title="绘制省份 (B) — 点击添加顶点，双击完成"
        >✎</button>
        <button 
          :class="{ active: tool === 'vertex' }" 
          @click="setTool('vertex')"
          title="顶点编辑 (G) — 拖拽省份顶点调整形状，点击边插入顶点"
        >⬡</button>
        <button 
          :class="{ active: tool === 'split' }" 
          @click="setTool('split')"
          title="拆分省份 (X) — 点击两个点定义分割线"
        >✂</button>
        <button 
          :class="{ active: tool === 'merge' }" 
          @click="setTool('merge')"
          title="合并省份 (M) — 依次点击两个省份"
        >⊕</button>
        <button 
          :class="{ active: tool === 'paint' }" 
          @click="setTool('paint')"
          title="势力油漆桶 (P) — 点击省份指派势力"
        >🎨</button>
        <button 
          :class="{ active: tool === 'label' }" 
          @click="setTool('label')"
          title="历史地名 (T) — 点击放置文字标记"
        >🏷</button>
        <button 
          :class="{ active: tool === 'erase' }" 
          @click="setTool('erase')"
          title="删除 (E) — 点击省份删除"
        >🗑</button>
      </div>
      <div class="tool-group">
        <button @click="triggerMapImport" title="导入 .map 底图">🗺</button>
        <button @click="fitToView" title="适应画布 (F)">⊞</button>
        <button @click="exportPNG" title="导出 PNG 图片">📥</button>
        <button @click="manualSave" title="保存到磁盘" :class="{ 'saving': store.saveStatus.value === 'saving' }">
          {{ store.saveStatus.value === 'saving' ? '⏳' : (store.saveStatus.value === 'saved' ? '✅' : '💾') }}
        </button>
      </div>
      <div class="tool-group">
        <label>模式：</label>
        <select v-model="viewMode" @change="onModeChange">
          <option value="base">底图编辑</option>
          <option value="scenario">剧本模式</option>
        </select>
      </div>
      <div class="tool-group">
        <label>吸附：</label>
        <label class="check-label" title="绘制/顶点编辑时对齐到 50px 网格（按住 Shift 临时禁用）">
          <input type="checkbox" v-model="snapToGridEnabled" /> 网格吸附
        </label>
      </div>
      <div class="tool-group">
        <label>图层：</label>
        <label class="check-label"><input type="checkbox" v-model="showBiomes" /> 生物群系</label>
        <label class="check-label"><input type="checkbox" v-model="showBorders" /> 边界</label>
        <label class="check-label"><input type="checkbox" v-model="showBurgs" /> 城镇</label>
        <label class="check-label"><input type="checkbox" v-model="showLabels" /> 标签</label>
      </div>
      <div class="tool-group">
        <button @click="showScenarioManager = true" title="剧本管理">📜</button>
      </div>
    </div>

    <!-- 剧本时间轴条 -->
    <div v-if="viewMode === 'scenario'" class="scenario-timeline">
      <div class="timeline-scroll">
        <button 
          v-for="scenario in sortedScenarios" 
          :key="scenario.id"
          class="timeline-btn"
          :class="{ active: selectedScenario?.id === scenario.id }"
          @click="selectScenario(scenario)"
          :title="scenario.name"
        >
          <span class="era-roman">{{ scenario.era?.roman || '·' }}</span>
          <span class="era-label">{{ scenario.name }}</span>
        </button>
      </div>
    </div>

    <!-- 势力色板（剧本模式） -->
    <div v-if="viewMode === 'scenario' && selectedScenario" class="polity-palette">
      <span class="palette-title">势力：</span>
      <div 
        v-for="polity in selectedScenario.polities" 
        :key="polity.id"
        class="polity-swatch"
        :class="{ active: selectedPolity?.id === polity.id }"
        :style="{ background: polity.color }"
        @click="selectPolity(polity)"
        :title="polity.name"
      >
        {{ polity.name?.charAt(0) || '?' }}
        <span class="polity-name">{{ polity.name }}</span>
      </div>
      <div 
        class="polity-swatch clear"
        :class="{ active: !selectedPolity }"
        @click="selectPolity(null)"
        title="清除归属"
      >✕</div>
    </div>

    <!-- 画布 -->
    <div class="scenario-canvas-wrap" ref="canvasWrap">
      <canvas ref="canvas"></canvas>
    </div>

    <!-- 状态栏 -->
    <div class="scenario-status-bar">
      <span>{{ statusText }}</span>
      <span>缩放: {{ (cameraScale * 100).toFixed(0) }}%</span>
      <span v-if="selectedProvince" class="selected-province">已选：{{ selectedProvince.name }}（{{ selectedProvince.biome || '未分类' }}）</span>
      <span v-if="drawPoints.length > 0" class="draw-hint">绘制中: {{ drawPoints.length }} 个点 (双击完成, Esc 取消)</span>
      <span v-if="splitStep > 0" class="draw-hint">拆分: 点击第 {{ splitStep + 1 }} 个点</span>
      <span v-if="mergeStep > 0" class="draw-hint">合并: 点击第 {{ mergeStep + 1 }} 个省份</span>
      <span v-if="vertexEditMode" class="draw-hint">顶点编辑：拖拽顶点 | 点击边插入 | 右键顶点删除</span>
      <span v-if="snapToGridEnabled && (tool === 'draw' || tool === 'vertex')" class="draw-hint">吸附：50px 网格（Shift 临时禁用）</span>
      <span v-if="selectedBurg" class="selected-burg">城镇：{{ selectedBurg.name }}（人口 {{ formatPopulation(selectedBurg.population) }}）</span>
      <span v-if="viewMode === 'scenario' && selectedScenario">剧本：{{ selectedScenario.name }}</span>
      <span v-if="selectedPolity" class="selected-polity">已选势力：<span class="polity-dot" :style="{ background: selectedPolity.color }"></span>{{ selectedPolity.name }}</span>
      <span class="save-status" :class="store.saveStatus.value">
        <template v-if="store.saveStatus.value === 'saving'">💾 保存中...</template>
        <template v-else-if="store.saveStatus.value === 'saved'">✅ 已保存</template>
        <template v-else-if="store.saveStatus.value === 'error'">❌ 保存失败</template>
        <template v-else>💾 自动保存</template>
      </span>
    </div>

    <!-- 省份右键菜单 -->
    <div v-if="contextMenu.show" class="context-menu" :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }">
      <div class="ctx-item" @click="ctxRenameProvince">✎ 重命名</div>
      <div class="ctx-item" @click="ctxChangeBiome">🎨 更改生物群系</div>
      <div class="ctx-item" @click="ctxDuplicateProvince">⧉ 复制省份</div>
      <div class="ctx-item danger" @click="ctxDeleteProvince">🗑 删除</div>
      <div class="ctx-divider"></div>
      <div class="ctx-item disabled" v-if="selectedProvince">
        {{ selectedProvince.name }} · {{ selectedProvince.biome || '未分类' }}
      </div>
    </div>

    <!-- 省份属性面板 -->
    <div v-if="selectedProvince && showProps" class="province-props">
      <div class="props-header">
        <input v-model="selectedProvince.name" @input="onProvinceNameChange" class="props-name" />
        <button @click="showProps = false" class="props-close">✕</button>
      </div>
      <div class="props-row">
        <label>生物群系：</label>
        <select v-model="selectedProvince.biome" @change="onProvinceBiomeChange">
          <option value="">未分类</option>
          <option value="ocean">海洋</option>
          <option value="hot_desert">热沙漠</option>
          <option value="cold_desert">冷沙漠</option>
          <option value="savanna">热带草原</option>
          <option value="grassland">草原</option>
          <option value="tropical_seasonal">热带季雨林</option>
          <option value="temperate_deciduous">温带落叶林</option>
          <option value="tropical_rainforest">热带雨林</option>
          <option value="temperate_rainforest">温带雨林</option>
          <option value="taiga">针叶林</option>
          <option value="tundra">冻原</option>
          <option value="glacier">冰川</option>
          <option value="wetland">湿地</option>
        </select>
      </div>
      <div class="props-row">
        <label>文化：</label>
        <input v-model="selectedProvince.culture" @input="onProvinceCultureChange" placeholder="文化名称" />
      </div>
      <div class="props-row">
        <label>海岸：</label>
        <input type="checkbox" v-model="selectedProvince.coast" @change="onProvinceCoastChange" />
      </div>
      <div class="props-stats">
        顶点数: {{ selectedProvince.points?.length || 0 }}
      </div>
    </div>

    <!-- 剧本管理对话框 -->
    <div v-if="showScenarioManager" class="modal-overlay" @click.self="showScenarioManager = false">
      <div class="modal-dialog scenario-manager">
        <h3>剧本管理</h3>
        <div class="scenario-list">
          <div v-for="s in sortedScenarios" :key="s.id" class="scenario-item">
            <span class="item-era">{{ s.era?.roman || '·' }}</span>
            <span class="item-name">{{ s.name }}</span>
            <span class="item-years">{{ s.era?.startYear || '?' }} – {{ s.era?.endYear || '?' }}</span>
            <button class="item-delete" @click="deleteScenario(s)" title="删除">🗑</button>
          </div>
        </div>
        <div class="new-scenario-form">
          <h4>新建剧本</h4>
          <div class="form-row">
            <label>名称：</label>
            <input v-model="newScenario.name" placeholder="如：第一时代·黑暗时代" />
          </div>
          <div class="form-row">
            <label>罗马数字：</label>
            <input v-model="newScenario.roman" placeholder="如：Ⅰ" class="short-input" />
          </div>
          <div class="form-row">
            <label>时代标签：</label>
            <input v-model="newScenario.label" placeholder="如：黑暗时代" />
          </div>
          <div class="form-row">
            <label>起始年：</label>
            <input v-model="newScenario.startYear" placeholder="如：乐园星历2006" />
          </div>
          <div class="form-row">
            <label>结束年：</label>
            <input v-model="newScenario.endYear" placeholder="如：乐园星历2008" />
          </div>
          <div class="form-row">
            <label>描述：</label>
            <textarea v-model="newScenario.description" placeholder="可选说明" rows="2"></textarea>
          </div>
          <div class="form-row checkbox">
            <label>继承上一时代：</label>
            <input type="checkbox" v-model="newScenario.inherit" />
          </div>
          <div class="form-actions">
            <button @click="createNewScenario" :disabled="!newScenario.name">创建</button>
            <button @click="showScenarioManager = false">关闭</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch, computed } from 'vue';
import { useGeodataStore } from '../store/geodata';
import { parseMapFile, buildScenariosJson } from '../utils/azgaar-parser';

const store = useGeodataStore();

const canvas = ref(null);
const canvasWrap = ref(null);
const tool = ref('select');
const viewMode = ref('base');
const baseMapKey = ref('德斯特星');
const selectedScenario = ref(null);
const selectedPolity = ref(null);
const ctx = ref(null);
const showScenarioManager = ref(false);

// 图层可见性
const showBiomes = ref(true);
const showBorders = ref(true);
const showLabels = ref(true);
const showBurgs = ref(true);

// 摄像机（pan/zoom）
const cameraX = ref(0);
const cameraY = ref(0);
const cameraScale = ref(1);

// 绘制/拆分/合并状态
const drawPoints = ref([]);
const splitStep = ref(0);
const splitPoints = ref([]);
const mergeStep = ref(0);
const mergeProvId = ref(null);

// 顶点编辑状态
const vertexEditMode = ref(false);
const draggingVertex = ref(null); // { provId, vertexIdx }
const hoveredVertex = ref(null);
// 拖拽中的临时顶点（仅做渲染预览，不写 store → undo 快照保持正确）
const dragPreview = ref(null); // { provId, points }

// 网格吸附（P0-T3）
const GRID_STEP = 50;                // 世界坐标网格间距，与 drawBackground 网格线一致
const snapToGridEnabled = ref(true); // 工具栏开关，默认开启
const snapMarker = ref(null);        // { x, y } 最近吸附点，用于十字标记
let snapMarkerTimer = null;
let lastFitKey = '';                 // 自动适屏：上次适配的底图键
let lastFitCount = 0;                // 自动适屏：上次适配时的省份数

// 城镇标记（P1-T4）
const BURG_HIT_RADIUS = 10;          // 命中半径（屏幕像素）
const hoveredBurg = ref(null);
const selectedBurg = ref(null);

// 右键菜单
const contextMenu = ref({ show: false, x: 0, y: 0, provId: null });
const showProps = ref(false);
const selectedProvince = ref(null);

// 生物群系颜色
const BIOME_COLORS = {
  ocean: '#2E86AB',
  hot_desert: '#E9C46A',
  cold_desert: '#B5B887',
  savanna: '#D2D082',
  grassland: '#C8D68F',
  tropical_seasonal: '#B6D95D',
  temperate_deciduous: '#29BC56',
  tropical_rainforest: '#7DCB35',
  temperate_rainforest: '#409C43',
  taiga: '#4B6B32',
  tundra: '#96784B',
  glacier: '#D5E7EB',
  wetland: '#0B9131',
  land: '#A3C4BC',
};

const newScenario = ref({
  name: '',
  roman: '',
  label: '',
  startYear: '',
  endYear: '',
  description: '',
  inherit: true,
});

const baseMap = computed(() => store.baseMaps?.[baseMapKey.value]);

// 城镇数据：优先取 .map 导入的 burgs，兼容旧数据（早期导入只把首都写进剧本 markers）
const burgs = computed(() => {
  const list = baseMap.value?.burgs;
  if (Array.isArray(list) && list.length) return list;
  return (selectedScenario.value?.markers || []).map((m, i) => ({
    id: `marker_${i}`,
    name: m.name || '',
    x: m.x,
    y: m.y,
    capital: 1,
    population: 0,
  }));
});

const scenarios = computed(() => {
  return store.getScenariosByOwner?.(baseMapKey.value) || [];
});

const sortedScenarios = computed(() => {
  return [...scenarios.value].sort((a, b) => (a.order || 0) - (b.order || 0));
});

const statusText = computed(() => {
  if (!baseMap.value) return '未加载底图';
  return `${baseMap.value.terrain?.length || 0} 省份 | ${baseMap.value.heightmap?.biomes?.length || 0} 生物群系`;
});

function setTool(t) {
  tool.value = t;
  drawPoints.value = [];
  splitStep.value = 0;
  splitPoints.value = [];
  mergeStep.value = 0;
  mergeProvId.value = null;
  vertexEditMode.value = (t === 'vertex');
  draggingVertex.value = null;
  dragPreview.value = null;
  hoveredBurg.value = null;
  clearSnapMarker();
  updateCursor();
}

function updateCursor() {
  if (!canvas.value) return;
  if (tool.value === 'select') canvas.value.style.cursor = 'grab';
  else if (tool.value === 'draw') canvas.value.style.cursor = 'crosshair';
  else if (tool.value === 'vertex') canvas.value.style.cursor = 'move';
  else if (tool.value === 'split') canvas.value.style.cursor = 'cell';
  else if (tool.value === 'merge') canvas.value.style.cursor = 'pointer';
  else if (tool.value === 'paint') canvas.value.style.cursor = 'copy';
  else if (tool.value === 'label') canvas.value.style.cursor = 'text';
  else if (tool.value === 'erase') canvas.value.style.cursor = 'not-allowed';
  else canvas.value.style.cursor = 'default';
}

function onModeChange() {
  if (viewMode.value === 'scenario') {
    if (sortedScenarios.value.length > 0 && !selectedScenario.value) {
      selectScenario(sortedScenarios.value[0]);
    }
  }
}

function selectScenario(s) {
  selectedScenario.value = s;
  render();
}

function selectPolity(p) {
  selectedPolity.value = p;
}

// ═══════════════════════════════════════════
// 网格吸附（P0-T3）
// ═══════════════════════════════════════════
/** 对齐到最近网格点；bypass（按住 Shift）或关闭开关时原样返回 */
function snapToGrid(world, bypass = false) {
  if (!snapToGridEnabled.value || bypass) return { x: world.x, y: world.y, snapped: false };
  return {
    x: Math.round(world.x / GRID_STEP) * GRID_STEP,
    y: Math.round(world.y / GRID_STEP) * GRID_STEP,
    snapped: true,
  };
}

function setSnapMarker(x, y) {
  snapMarker.value = { x, y };
  if (snapMarkerTimer) { clearTimeout(snapMarkerTimer); snapMarkerTimer = null; }
}

/** delay > 0 时延时自动清除（绘制点击后短暂显示），否则立即清除 */
function clearSnapMarker(delay = 0) {
  if (snapMarkerTimer) { clearTimeout(snapMarkerTimer); snapMarkerTimer = null; }
  if (delay <= 0) { snapMarker.value = null; return; }
  snapMarkerTimer = setTimeout(() => {
    snapMarkerTimer = null;
    snapMarker.value = null;
    render();
  }, delay);
}

/** 拖拽中返回临时预览点集，避免渲染读到未提交的修改 */
function resolvePoints(prov) {
  if (dragPreview.value && dragPreview.value.provId === prov.id) return dragPreview.value.points;
  return prov.points;
}

/** 选中省份始终指向 store 中的最新对象（updateBaseProvince 会生成新对象） */
function currentProvince() {
  const sp = selectedProvince.value;
  if (!sp) return null;
  return baseMap.value?.terrain?.find(p => p.id === sp.id) || sp;
}

// ═══════════════════════════════════════════
// 坐标转换
// ═══════════════════════════════════════════
function screenToWorld(sx, sy) {
  return {
    x: (sx - cameraX.value) / cameraScale.value,
    y: (sy - cameraY.value) / cameraScale.value,
  };
}

// ═══════════════════════════════════════════
// Pan & Zoom
// ═══════════════════════════════════════════
let isPanning = false;
let panStart = { x: 0, y: 0 };

function onMouseDown(event) {
  if (event.button === 2) return; // 右键留给 context menu
  if (event.button === 0 && (tool.value === 'select' || tool.value === 'vertex')) {
    // 顶点编辑模式：检查是否点到顶点
    if (tool.value === 'vertex' && selectedProvince.value) {
      const rect = canvas.value.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      const world = screenToWorld(sx, sy);
      const prov = currentProvince();
      const threshold = 8 / cameraScale.value;
      const points = prov && prov.points ? resolvePoints(prov) : null;
      if (points) {
        for (let i = 0; i < points.length; i++) {
          const p = points[i];
          const dx = (p.x || p[0]) - world.x;
          const dy = (p.y || p[1]) - world.y;
          if (Math.sqrt(dx * dx + dy * dy) < threshold) {
            draggingVertex.value = { provId: prov.id, vertexIdx: i };
            canvas.value.style.cursor = 'grabbing';
            return;
          }
        }
      }
    }
    isPanning = true;
    panStart = { x: event.clientX, y: event.clientY };
    canvas.value.style.cursor = 'grabbing';
  }
}

function onMouseMove(event) {
  if (draggingVertex.value) {
    const rect = canvas.value.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const world = screenToWorld(sx, sy);
    const { provId, vertexIdx } = draggingVertex.value;
    const prov = baseMap.value?.terrain?.find(p => p.id === provId);
    if (prov && prov.points && prov.points[vertexIdx]) {
      // 顶点编辑拖拽同样吸附网格
      const snapped = snapToGrid(world, event.shiftKey);
      if (snapped.snapped) setSnapMarker(snapped.x, snapped.y);
      // 只更新临时预览，不写 store（拖拽结束再一次性提交，保证 undo 可回滚）
      dragPreview.value = {
        provId,
        points: resolvePoints(prov).map((p, i) => (
          i === vertexIdx ? { x: snapped.x, y: snapped.y } : { x: p.x ?? p[0], y: p.y ?? p[1] }
        )),
      };
      render();
    }
    return;
  }
  if (!isPanning) {
    updateBurgHover(event);
    return;
  }
  const dx = event.clientX - panStart.x;
  const dy = event.clientY - panStart.y;
  cameraX.value += dx;
  cameraY.value += dy;
  panStart = { x: event.clientX, y: event.clientY };
  render();
}

function onMouseUp() {
  if (isPanning) {
    isPanning = false;
    updateCursor();
  }
  if (draggingVertex.value) {
    const { provId } = draggingVertex.value;
    const preview = dragPreview.value;
    draggingVertex.value = null;
    dragPreview.value = null;
    clearSnapMarker();
    // 拖拽结束后一次性写入 store：redo 写坐标、undo 回滚到拖拽前
    if (preview && preview.provId === provId) {
      store.updateBaseProvince(baseMapKey.value, provId, { points: preview.points });
    }
    render();
    updateCursor();
  }
}

function onCanvasMouseLeave() {
  onMouseUp();
  if (hoveredBurg.value) {
    hoveredBurg.value = null;
    render();
  }
}

function onWheel(event) {
  event.preventDefault();
  const rect = canvas.value.getBoundingClientRect();
  const mx = event.clientX - rect.left;
  const my = event.clientY - rect.top;
  const worldBefore = screenToWorld(mx, my);
  const zoomFactor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
  cameraScale.value = Math.max(0.1, Math.min(50, cameraScale.value * zoomFactor));
  const worldAfter = screenToWorld(mx, my);
  cameraX.value += (worldAfter.x - worldBefore.x) * cameraScale.value;
  cameraY.value += (worldAfter.y - worldBefore.y) * cameraScale.value;
  render();
}

function fitToView() {
  if (!baseMap.value?.terrain?.length) return;
  const terrain = baseMap.value.terrain;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const prov of terrain) {
    if (!prov.points) continue;
    for (const p of prov.points) {
      const px = p.x || p[0] || 0;
      const py = p.y || p[1] || 0;
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
  }
  if (!isFinite(minX)) return;
  const w = canvasWrap.value.clientWidth;
  const h = canvasWrap.value.clientHeight;
  const padding = 40;
  const bw = maxX - minX || 1;
  const bh = maxY - minY || 1;
  cameraScale.value = Math.min((w - padding * 2) / bw, (h - padding * 2) / bh);
  cameraX.value = padding + (w - padding * 2 - bw * cameraScale.value) / 2 - minX * cameraScale.value;
  cameraY.value = padding + (h - padding * 2 - bh * cameraScale.value) / 2 - minY * cameraScale.value;
  render();
}

// ═══════════════════════════════════════════
// 鼠标交互
// ═══════════════════════════════════════════
function onCanvasClick(event) {
  if (event.button === 2) {
    // 右键菜单
    const rect = canvas.value.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const world = screenToWorld(sx, sy);
    const prov = findProvinceAt(world.x, world.y);
    if (prov) {
      selectedProvince.value = prov;
      contextMenu.value = { show: true, x: event.clientX - rect.left, y: event.clientY - rect.top, provId: prov.id };
    }
    return;
  }
  
  const rect = canvas.value.getBoundingClientRect();
  const sx = event.clientX - rect.left;
  const sy = event.clientY - rect.top;
  const world = screenToWorld(sx, sy);

  if (tool.value === 'erase') {
    const prov = findProvinceAt(world.x, world.y);
    if (prov && confirm(`确定删除省份「${prov.name}」？`)) {
      store.removeBaseProvince(baseMapKey.value, prov.id);
      render();
    }
    return;
  }

  if (tool.value === 'vertex') {
    // 选中省份
    const prov = findProvinceAt(world.x, world.y);
    if (prov) {
      selectedProvince.value = prov;
      showProps.value = true;
    }
    render();
    return;
  }

  if (tool.value === 'draw') {
    // 绘制顶点对齐网格（Shift 临时禁用）
    const snapped = snapToGrid(world, event.shiftKey);
    drawPoints.value = [...drawPoints.value, { x: snapped.x, y: snapped.y }];
    if (snapped.snapped) {
      setSnapMarker(snapped.x, snapped.y);
      clearSnapMarker(600);
    }
    render();
    return;
  }

  if (tool.value === 'split') {
    handleSplitClick(world);
    return;
  }

  if (tool.value === 'merge') {
    handleMergeClick(world);
    return;
  }

  // 选择模式：城镇点击优先（标记支持选中，为后续编辑预留），否则选中省份
  if (tool.value === 'select') {
    const burg = showBurgs.value ? findBurgAt(sx, sy) : null;
    selectedBurg.value = burg;
    if (!burg) {
      const prov = findProvinceAt(world.x, world.y);
      selectedProvince.value = prov;
      showProps.value = !!prov;
    }
    render();
    return;
  }

  if (viewMode.value !== 'scenario' || !selectedScenario.value) return;

  if (tool.value === 'paint' && selectedPolity.value) {
    const prov = findProvinceAt(world.x, world.y);
    if (prov) {
      store.setOwnership(selectedScenario.value.id, prov.id, selectedPolity.value.id);
      render();
    }
  } else if (tool.value === 'label') {
    const text = prompt('输入地名：');
    if (text) {
      store.addScenarioLabel(selectedScenario.value.id, { x: world.x, y: world.y, text });
      render();
    }
  }
}

function onCanvasDblClick(event) {
  if (tool.value === 'draw' && drawPoints.value.length >= 3) {
    finishDraw();
  }
}

function onKeyDown(event) {
  if (event.key === 'Escape') {
    drawPoints.value = [];
    splitStep.value = 0;
    splitPoints.value = [];
    mergeStep.value = 0;
    mergeProvId.value = null;
    contextMenu.value.show = false;
    selectedBurg.value = null;
    dragPreview.value = null;
    clearSnapMarker();
    render();
  }
  if (event.key === 'Enter' && tool.value === 'draw' && drawPoints.value.length >= 3) {
    finishDraw();
  }
  if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;
  if (event.key === 'v' || event.key === 'V') setTool('select');
  else if (event.key === 'b' || event.key === 'B') setTool('draw');
  else if (event.key === 'g' || event.key === 'G') setTool('vertex');
  else if (event.key === 'x' || event.key === 'X') setTool('split');
  else if (event.key === 'm' || event.key === 'M') setTool('merge');
  else if (event.key === 'p' || event.key === 'P') setTool('paint');
  else if (event.key === 't' || event.key === 'T') setTool('label');
  else if (event.key === 'e' || event.key === 'E') setTool('erase');
  else if (event.key === 'f' || event.key === 'F') fitToView();
}

function finishDraw() {
  const id = `prov_${Date.now()}`;
  const points = drawPoints.value.map(p => ({ x: p.x, y: p.y }));
  store.addBaseProvince(baseMapKey.value, {
    id,
    name: `新省份 ${baseMap.value?.terrain?.length + 1 || 1}`,
    points,
  });
  drawPoints.value = [];
  render();
}

function handleSplitClick(world) {
  if (splitStep.value === 0) {
    splitPoints.value = [world];
    splitStep.value = 1;
    render();
  } else {
    const p1 = splitPoints.value[0];
    const p2 = world;
    const terrain = baseMap.value?.terrain || [];
    let targetProv = null;
    for (const prov of terrain) {
      if (prov.points && prov.points.length > 2) {
        if (isPointInPolygon(p1.x, p1.y, prov.points) || isPointInPolygon(p2.x, p2.y, prov.points)) {
          targetProv = prov;
          break;
        }
      }
    }
    if (targetProv) {
      const newProvs = splitProvinceByLine(targetProv, p1, p2);
      if (newProvs) {
        store.splitBaseProvince(baseMapKey.value, targetProv.id, newProvs[0], newProvs[1]);
      }
    }
    splitStep.value = 0;
    splitPoints.value = [];
    render();
  }
}

function handleMergeClick(world) {
  const prov = findProvinceAt(world.x, world.y);
  if (!prov) return;
  if (mergeStep.value === 0) {
    mergeProvId.value = prov.id;
    mergeStep.value = 1;
    render();
  } else {
    if (mergeProvId.value && mergeProvId.value !== prov.id) {
      const terrain = baseMap.value?.terrain || [];
      const provA = terrain.find(p => p.id === mergeProvId.value);
      const provB = prov;
      if (provA && provB) {
        const hull = convexHull([...provA.points, ...provB.points]);
        const id = `prov_${Date.now()}`;
        store.mergeBaseProvinces(baseMapKey.value, [mergeProvId.value, provB.id], {
          id,
          name: `${provA.name}+${provB.name}`,
          points: hull.map(p => ({ x: p.x || p[0], y: p.y || p[1] })),
        });
      }
    }
    mergeStep.value = 0;
    mergeProvId.value = null;
    render();
  }
}

// ═══════════════════════════════════════════
// 右键菜单
// ═══════════════════════════════════════════
function ctxRenameProvince() {
  const name = prompt('省份名称：', selectedProvince.value?.name);
  if (name && selectedProvince.value) {
    selectedProvince.value.name = name;
    store.updateBaseProvince(baseMapKey.value, selectedProvince.value.id, { name });
    render();
  }
  contextMenu.value.show = false;
}

function ctxChangeBiome() {
  const biomes = Object.keys(BIOME_COLORS);
  const biome = prompt(`生物群系（${biomes.join('/')}）：`, selectedProvince.value?.biome || '');
  if (biome && selectedProvince.value) {
    selectedProvince.value.biome = biome;
    store.updateBaseProvince(baseMapKey.value, selectedProvince.value.id, { biome });
    render();
  }
  contextMenu.value.show = false;
}

function ctxDuplicateProvince() {
  if (!selectedProvince.value) return;
  const prov = selectedProvince.value;
  const offset = 20 / cameraScale.value;
  const newPoints = prov.points.map(p => ({ x: (p.x || p[0]) + offset, y: (p.y || p[1]) + offset }));
  const id = `prov_${Date.now()}`;
  store.addBaseProvince(baseMapKey.value, { id, name: prov.name + ' 副本', points: newPoints, biome: prov.biome, culture: prov.culture });
  render();
  contextMenu.value.show = false;
}

function ctxDeleteProvince() {
  if (selectedProvince.value && confirm(`确定删除省份「${selectedProvince.value.name}」？`)) {
    store.removeBaseProvince(baseMapKey.value, selectedProvince.value.id);
    selectedProvince.value = null;
    showProps.value = false;
    render();
  }
  contextMenu.value.show = false;
}

function onProvinceNameChange() {
  if (selectedProvince.value) {
    store.updateBaseProvince(baseMapKey.value, selectedProvince.value.id, { name: selectedProvince.value.name });
  }
}

function onProvinceBiomeChange() {
  if (selectedProvince.value) {
    store.updateBaseProvince(baseMapKey.value, selectedProvince.value.id, { biome: selectedProvince.value.biome });
    render();
  }
}

function onProvinceCultureChange() {
  if (selectedProvince.value) {
    store.updateBaseProvince(baseMapKey.value, selectedProvince.value.id, { culture: selectedProvince.value.culture });
  }
}

function onProvinceCoastChange() {
  if (selectedProvince.value) {
    store.updateBaseProvince(baseMapKey.value, selectedProvince.value.id, { coast: selectedProvince.value.coast });
  }
}

// ═══════════════════════════════════════════
// 几何工具
// ═══════════════════════════════════════════
function findProvinceAt(x, y) {
  if (!baseMap.value?.terrain) return null;
  for (const prov of baseMap.value.terrain) {
    if (prov.points && isPointInPolygon(x, y, prov.points)) {
      return prov;
    }
  }
  return null;
}

function isPointInPolygon(px, py, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x || points[i][0];
    const yi = points[i].y || points[i][1];
    const xj = points[j].x || points[j][0];
    const yj = points[j].y || points[j][1];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function splitProvinceByLine(prov, p1, p2) {
  const points = prov.points.map(p => ({ x: p.x || p[0], y: p.y || p[1] }));
  const side = [];
  for (const p of points) {
    const cross = (p2.x - p1.x) * (p.y - p1.y) - (p2.y - p1.y) * (p.x - p1.x);
    side.push(cross >= 0 ? 1 : -1);
  }
  const poly1 = [];
  const poly2 = [];
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    if (side[i] >= 0) poly1.push(points[i]);
    else poly2.push(points[i]);
    if (side[i] !== side[j]) {
      const denom = (points[j].x - points[i].x) * (p1.y - p2.y) - (points[j].y - points[i].y) * (p1.x - p2.x);
      if (Math.abs(denom) > 1e-10) {
        const t = ((p1.x - points[i].x) * (p1.y - p2.y) - (p1.y - points[i].y) * (p1.x - p2.x)) / denom;
        if (t >= 0 && t <= 1) {
          const ix = points[i].x + t * (points[j].x - points[i].x);
          const iy = points[i].y + t * (points[j].y - points[i].y);
          poly1.push({ x: ix, y: iy });
          poly2.push({ x: ix, y: iy });
        }
      }
    }
  }
  if (poly1.length < 3 || poly2.length < 3) return null;
  return [
    { id: `prov_${Date.now()}_a`, name: prov.name + ' (A)', points: poly1 },
    { id: `prov_${Date.now()}_b`, name: prov.name + ' (B)', points: poly2 },
  ];
}

function convexHull(points) {
  const pts = points.map(p => ({ x: p.x || p[0], y: p.y || p[1] })).filter(p => isFinite(p.x) && isFinite(p.y));
  if (pts.length < 3) return pts;
  pts.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (O, A, B) => (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (const p of pts.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

// ═══════════════════════════════════════════
// 导入
// ═══════════════════════════════════════════
async function triggerMapImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.map';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseMapFile(text);
      const name = file.name.replace(/\.map$/, '').replace(/\s*\d{4}-\d{2}-\d{2}.*$/, '');
      const json = buildScenariosJson(parsed, name, '当前');
      store.importFromScenariosJson(json);
      baseMapKey.value = name;
      if (json.scenarios[name + '/当前']) {
        selectedScenario.value = json.scenarios[name + '/当前'];
        viewMode.value = 'scenario';
      }
      setTimeout(fitToView, 50);
    } catch (err) {
      alert('导入失败: ' + err.message);
    }
  };
  input.click();
}

function manualSave() {
  store.saveScenarios();
}

// ═══════════════════════════════════════════
// 剧本管理
// ═══════════════════════════════════════════
function createNewScenario() {
  const baseScenarioId = newScenario.value.inherit && sortedScenarios.value.length > 0
    ? sortedScenarios.value[sortedScenarios.value.length - 1].id
    : null;
  const scenarioId = `${baseMapKey.value}/${newScenario.value.name}`;
  if (baseScenarioId) {
    store.inheritScenario(scenarioId, baseScenarioId, {
      name: newScenario.value.name,
      era: { roman: newScenario.value.roman, label: newScenario.value.label, startYear: newScenario.value.startYear, endYear: newScenario.value.endYear },
      description: newScenario.value.description,
    });
  } else {
    store.createScenario(scenarioId, {
      ownerKey: baseMapKey.value,
      name: newScenario.value.name,
      era: { roman: newScenario.value.roman, label: newScenario.value.label, startYear: newScenario.value.startYear, endYear: newScenario.value.endYear },
      description: newScenario.value.description,
    });
  }
  newScenario.value = { name: '', roman: '', label: '', startYear: '', endYear: '', description: '', inherit: true };
  showScenarioManager.value = false;
  const newS = store.getScenario(scenarioId);
  if (newS) selectScenario(newS);
}

function deleteScenario(s) {
  if (confirm(`确定删除剧本「${s.name}」？`)) {
    store.removeScenario(s.id);
    if (selectedScenario.value?.id === s.id) {
      selectedScenario.value = sortedScenarios.value[0] || null;
    }
    render();
  }
}

// ═══════════════════════════════════════════
// 渲染
// ═══════════════════════════════════════════
function render() {
  if (!ctx.value) return;
  const cvs = canvas.value;
  const w = cvs.width;
  const h = cvs.height;
  ctx.value.clearRect(0, 0, w, h);

  ctx.value.save();
  ctx.value.translate(cameraX.value, cameraY.value);
  ctx.value.scale(cameraScale.value, cameraScale.value);

  drawBackground(ctx.value);
  if (showBiomes.value) drawBiomeBackground(ctx.value);
  drawProvinces(ctx.value);
  if (showBorders.value) drawProvinceBorders(ctx.value);
  drawVertexHandles(ctx.value);
  if (showBurgs.value) drawBurgs(ctx.value);
  drawPreviewOverlay(ctx.value);
  if (showLabels.value) drawLabels(ctx.value);

  ctx.value.restore();

  // 城镇信息浮层画在屏幕坐标系：字号与命中不受缩放影响
  drawBurgTooltip(ctx.value);
}

function drawBackground(ctx) {
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(canvas.value.width, canvas.value.height);
  ctx.fillStyle = '#1a2a3a';
  ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1 / cameraScale.value;
  const step = GRID_STEP;
  const startX = Math.floor(tl.x / step) * step;
  const startY = Math.floor(tl.y / step) * step;
  const endX = br.x + step;
  const endY = br.y + step;
  for (let x = startX; x <= endX; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, startY);
    ctx.lineTo(x, endY);
    ctx.stroke();
  }
  for (let y = startY; y <= endY; y += step) {
    ctx.beginPath();
    ctx.moveTo(startX, y);
    ctx.lineTo(endX, y);
    ctx.stroke();
  }
}

function drawBiomeBackground(ctx) {
  // 如果有生物群系数据，用半透明色块显示
  const biomes = baseMap.value?.heightmap?.biomes;
  if (!biomes || !biomes.length) return;
  
  // 绘制生物群系图例（右下角）
  const legendX = screenToWorld(canvas.value.width - 150, canvas.value.height - 300).x;
  const legendY = screenToWorld(canvas.value.width - 150, canvas.value.height - 300).y;
  ctx.font = `${11}px "PingFang SC", sans-serif`;
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(legendX - 5, legendY - 15, 140, biomes.length * 18 + 20);
  ctx.fillStyle = '#fff';
  ctx.fillText('生物群系', legendX, legendY);
  biomes.forEach((b, i) => {
    if (i < 10) {
      ctx.fillStyle = b.color || '#888';
      ctx.fillRect(legendX, legendY + 5 + i * 18, 12, 12);
      ctx.fillStyle = '#ccc';
      ctx.fillText(b.name || `Biome ${i}`, legendX + 16, legendY + 15 + i * 18);
    }
  });
}

function drawProvinces(c) {
  if (!baseMap.value?.terrain) return;
  baseMap.value.terrain.forEach(prov => {
    const color = getProvinceColor(prov);
    const points = resolvePoints(prov);
    c.fillStyle = color;
    c.strokeStyle = 'transparent';
    c.lineWidth = 0;
    
    if (points && Array.isArray(points) && points.length > 2) {
      c.beginPath();
      c.moveTo(points[0].x || points[0][0], points[0].y || points[0][1]);
      for (let i = 1; i < points.length; i++) {
        c.lineTo(points[i].x || points[i][0], points[i].y || points[i][1]);
      }
      c.closePath();
      c.fill();
    }
  });
}

function drawProvinceBorders(c) {
  if (!baseMap.value?.terrain) return;
  baseMap.value.terrain.forEach(prov => {
    const isSelected = selectedProvince.value?.id === prov.id;
    const isMergeTarget = mergeProvId.value === prov.id;
    const points = resolvePoints(prov);
    c.strokeStyle = isMergeTarget ? '#ffd700' : (isSelected ? '#ffffff' : 'rgba(141,138,130,0.6)');
    c.lineWidth = isSelected ? 1.5 / cameraScale.value : 0.6 / cameraScale.value;
    
    if (points && Array.isArray(points) && points.length > 2) {
      c.beginPath();
      c.moveTo(points[0].x || points[0][0], points[0].y || points[0][1]);
      for (let i = 1; i < points.length; i++) {
        c.lineTo(points[i].x || points[i][0], points[i].y || points[i][1]);
      }
      c.closePath();
      c.stroke();
    }
  });
}

function drawVertexHandles(c) {
  if (!vertexEditMode.value || !selectedProvince.value) return;
  const prov = currentProvince();
  const points = prov ? resolvePoints(prov) : null;
  if (!points) return;
  const r = 4 / cameraScale.value;
  points.forEach((p, i) => {
    const px = p.x || p[0];
    const py = p.y || p[1];
    c.fillStyle = draggingVertex.value?.vertexIdx === i ? '#ffd700' : '#a78bfa';
    c.strokeStyle = '#fff';
    c.lineWidth = 1 / cameraScale.value;
    c.beginPath();
    c.arc(px, py, r, 0, Math.PI * 2);
    c.fill();
    c.stroke();
  });
}

function getProvinceColor(prov) {
  // 优先使用生物群系颜色
  if (prov.biome && BIOME_COLORS[prov.biome]) {
    return BIOME_COLORS[prov.biome];
  }
  if (viewMode.value === 'scenario' && selectedScenario.value) {
    const owner = selectedScenario.value.ownership?.[prov.id];
    if (owner) {
      const polity = selectedScenario.value.polities?.find(p => p.id === owner);
      return polity?.color || '#6b7280';
    }
    return '#4a5568';
  }
  return prov.biomeColor || '#bccda0';
}

function drawPreviewOverlay() {
  const c = ctx.value;
  if (tool.value === 'draw' && drawPoints.value.length > 0) {
    c.strokeStyle = '#7c3aed';
    c.fillStyle = 'rgba(124, 58, 237, 0.15)';
    c.lineWidth = 2 / cameraScale.value;
    c.beginPath();
    c.moveTo(drawPoints.value[0].x, drawPoints.value[0].y);
    for (let i = 1; i < drawPoints.value.length; i++) {
      c.lineTo(drawPoints.value[i].x, drawPoints.value[i].y);
    }
    if (drawPoints.value.length >= 3) c.closePath();
    c.fill();
    c.stroke();
    for (const p of drawPoints.value) {
      c.fillStyle = '#a78bfa';
      c.beginPath();
      c.arc(p.x, p.y, 3 / cameraScale.value, 0, Math.PI * 2);
      c.fill();
    }
  }

  // 网格吸附十字标记（P0-T3）
  if (snapMarker.value) {
    const mx = snapMarker.value.x;
    const my = snapMarker.value.y;
    const arm = 7 / cameraScale.value;
    c.strokeStyle = '#34d399';
    c.lineWidth = 1.5 / cameraScale.value;
    c.beginPath();
    c.moveTo(mx - arm, my);
    c.lineTo(mx + arm, my);
    c.moveTo(mx, my - arm);
    c.lineTo(mx, my + arm);
    c.stroke();
    c.beginPath();
    c.arc(mx, my, 2.5 / cameraScale.value, 0, Math.PI * 2);
    c.stroke();
  }

  if (tool.value === 'split' && splitStep.value === 1 && splitPoints.value.length === 1) {
    c.fillStyle = '#fbbf24';
    c.beginPath();
    c.arc(splitPoints.value[0].x, splitPoints.value[0].y, 5 / cameraScale.value, 0, Math.PI * 2);
    c.fill();
  }
}

// ═══════════════════════════════════════════
// 城镇图层（P1-T4）
// ═══════════════════════════════════════════
/** 屏幕坐标命中城镇；首都优先（避免小城镇遮住首都） */
function findBurgAt(sx, sy) {
  const list = burgs.value;
  if (!list.length) return null;
  const r2 = BURG_HIT_RADIUS * BURG_HIT_RADIUS;
  let best = null;
  let bestD = Infinity;
  for (let pass = 1; pass >= 0; pass--) {
    for (const b of list) {
      if ((b.capital ? 1 : 0) !== pass) continue;
      const dx = cameraX.value + b.x * cameraScale.value - sx;
      const dy = cameraY.value + b.y * cameraScale.value - sy;
      const d = dx * dx + dy * dy;
      if (d <= r2 && d < bestD) { bestD = d; best = b; }
    }
    if (best) return best;
  }
  return null;
}

/** 选择工具下 hover 命中城镇；仅状态变化时重绘，避免 mousemove 刷屏 */
function updateBurgHover(event) {
  if (tool.value !== 'select' || !showBurgs.value) {
    if (hoveredBurg.value) { hoveredBurg.value = null; render(); }
    return;
  }
  const rect = canvas.value.getBoundingClientRect();
  const hit = findBurgAt(event.clientX - rect.left, event.clientY - rect.top);
  const prevId = hoveredBurg.value ? hoveredBurg.value.id : null;
  const nextId = hit ? hit.id : null;
  if (prevId === nextId) return;
  hoveredBurg.value = hit;
  canvas.value.style.cursor = hit ? 'pointer' : 'grab';
  render();
}

/** 首都：金色星形 */
function drawCapitalStar(c, x, y, r) {
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.42;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = x + Math.cos(a) * rad;
    const py = y + Math.sin(a) * rad;
    if (i === 0) c.moveTo(px, py);
    else c.lineTo(px, py);
  }
  c.closePath();
  c.fillStyle = '#ffd700';
  c.fill();
  c.strokeStyle = 'rgba(20,24,34,0.65)';
  c.lineWidth = 1 / cameraScale.value;
  c.stroke();
}

function drawBurgs(c) {
  const list = burgs.value;
  if (!list.length) return;
  // 视口裁剪：只画可见范围（含边距）
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(canvas.value.width, canvas.value.height);
  const pad = 24 / cameraScale.value;
  const minX = tl.x - pad, maxX = br.x + pad;
  const minY = tl.y - pad, maxY = br.y + pad;
  const dotR = 2.5 / cameraScale.value;
  const starR = 5.5 / cameraScale.value;
  const hoverId = hoveredBurg.value ? hoveredBurg.value.id : null;
  const selectedId = selectedBurg.value ? selectedBurg.value.id : null;

  // 两趟绘制（普通城镇在下、首都在上）；不新建数组，避免渲染循环内分配
  for (let pass = 0; pass <= 1; pass++) {
    for (const b of list) {
      if ((b.capital ? 1 : 0) !== pass) continue;
      if (b.x < minX || b.x > maxX || b.y < minY || b.y > maxY) continue;
      if (pass === 1) {
        drawCapitalStar(c, b.x, b.y, starR);
      } else {
        c.fillStyle = 'rgba(214,219,228,0.85)';
        c.beginPath();
        c.arc(b.x, b.y, dotR, 0, Math.PI * 2);
        c.fill();
      }
      if (b.id === selectedId || b.id === hoverId) {
        c.strokeStyle = b.id === selectedId ? '#34d399' : '#ffffff';
        c.lineWidth = 1.5 / cameraScale.value;
        c.beginPath();
        c.arc(b.x, b.y, starR * 1.8, 0, Math.PI * 2);
        c.stroke();
      }
    }
  }
}

/** FMG 的 population 为原始数值（不做单位换算，避免臆造量纲） */
function formatPopulation(pop) {
  if (!pop) return '—';
  return pop >= 100 ? String(Math.round(pop)) : pop.toFixed(1);
}

/** 悬停/选中的城镇信息浮层（屏幕坐标系，字号不随缩放变化） */
function drawBurgTooltip(c) {
  if (!showBurgs.value) return;
  const b = hoveredBurg.value || selectedBurg.value;
  if (!b) return;
  const sx = cameraX.value + b.x * cameraScale.value;
  const sy = cameraY.value + b.y * cameraScale.value;
  const title = b.name || '未命名城镇';
  const sub = `${b.capital ? '首都 · ' : ''}人口 ${formatPopulation(b.population)}`;
  c.font = '12px "PingFang SC", sans-serif';
  const w = Math.max(c.measureText(title).width, c.measureText(sub).width) + 18;
  const h = 36;
  let tx = sx + 12;
  let ty = sy - h - 6;
  if (tx + w > canvas.value.width) tx = sx - w - 12;
  if (ty < 0) ty = sy + 12;
  c.fillStyle = 'rgba(15,26,46,0.94)';
  c.strokeStyle = b.capital ? '#ffd700' : '#475569';
  c.lineWidth = 1;
  c.beginPath();
  if (typeof c.roundRect === 'function') c.roundRect(tx, ty, w, h, 6);
  else c.rect(tx, ty, w, h);
  c.fill();
  c.stroke();
  c.fillStyle = '#e2e8f0';
  c.font = '12px "PingFang SC", sans-serif';
  c.fillText(title, tx + 9, ty + 15);
  c.fillStyle = '#94a3b8';
  c.font = '11px "PingFang SC", sans-serif';
  c.fillText(sub, tx + 9, ty + 28);
}

function drawLabels(c) {
  if (viewMode.value !== 'scenario' || !selectedScenario.value?.labels) return;
  selectedScenario.value.labels.forEach(label => {
    c.font = `${label.size || 12}px "PingFang SC", sans-serif`;
    c.fillStyle = label.color || '#e2e8f0';
    c.fillText(label.text, label.x, label.y);
  });
}

function handleResize() {
  if (!canvas.value || !canvasWrap.value) return;
  canvas.value.width = canvasWrap.value.clientWidth;
  canvas.value.height = canvasWrap.value.clientHeight;
  render();
}

async function exportPNG() {
  const cvs = canvas.value;
  const scale = 2;
  const offscreen = document.createElement('canvas');
  offscreen.width = cvs.width * scale;
  offscreen.height = cvs.height * scale;
  const ctx = offscreen.getContext('2d');
  ctx.scale(scale, scale);
  ctx.translate(cameraX.value, cameraY.value);
  ctx.scale(cameraScale.value, cameraScale.value);
  drawBackground(ctx);
  drawProvinces(ctx);
  if (showBurgs.value) drawBurgs(ctx);
  drawLabels(ctx);
  ctx.font = '14px "PingFang SC", sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  const scenarioName = selectedScenario?.value?.name || '未命名剧本';
  const eraLabel = selectedScenario?.value?.era?.roman || '';
  const watermark = eraLabel ? `${eraLabel} · ${scenarioName}` : scenarioName;
  ctx.fillText(watermark, 10, cvs.height / scale - 10);
  offscreen.toBlob(async (blob) => {
    if (!blob) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result;
      const result = await window.sitianAPI.saveExportFile({ dataUrl, defaultName: `scenario-${Date.now()}.png` });
      if (!result?.success) {
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = `scenario-${Date.now()}.png`;
        a.click();
      }
    };
    reader.readAsDataURL(blob);
  }, 'image/png');
}

let resizeObserver = null;

onMounted(() => {
  const cvs = canvas.value;
  const wrap = canvasWrap.value;
  cvs.width = wrap.clientWidth;
  cvs.height = wrap.clientHeight;
  ctx.value = cvs.getContext('2d');

  if (!store.baseMaps?.[baseMapKey.value]) {
    store.addBaseMap(baseMapKey.value, { name: '德斯特星' });
  }

  cvs.addEventListener('mousedown', onMouseDown);
  cvs.addEventListener('mousemove', onMouseMove);
  cvs.addEventListener('mouseup', onMouseUp);
  cvs.addEventListener('mouseleave', onCanvasMouseLeave);
  cvs.addEventListener('click', onCanvasClick);
  cvs.addEventListener('dblclick', onCanvasDblClick);
  cvs.addEventListener('wheel', onWheel, { passive: false });
  cvs.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('click', () => { contextMenu.value.show = false; });

  render();
  resizeObserver = new ResizeObserver(handleResize);
  resizeObserver.observe(wrap);

  lastFitKey = baseMapKey.value;
  lastFitCount = baseMap.value?.terrain?.length || 0;
  if (baseMap.value?.terrain?.length) {
    setTimeout(fitToView, 100);
  }
});

onUnmounted(() => {
  if (resizeObserver) resizeObserver.disconnect();
  window.removeEventListener('keydown', onKeyDown);
});

// 关闭城镇图层时同时收起悬停/选中态（避免残留浮层）
watch(showBurgs, (visible) => {
  if (!visible) {
    hoveredBurg.value = null;
    selectedBurg.value = null;
  }
  render();
});

// 换图或省份增删时自动适应视图；编辑顶点/改名不打断当前镜头
watch([baseMapKey, () => baseMap.value?.terrain?.length || 0], ([key, count]) => {
  if (!count) return;
  if (key === lastFitKey && count === lastFitCount) return;
  lastFitKey = key;
  lastFitCount = count;
  setTimeout(fitToView, 50);
});

watch(baseMap, () => {
  // updateBaseProvince 会生成新对象，重新对齐选中引用，避免读到旧数据
  const sp = selectedProvince.value;
  if (sp) {
    const fresh = baseMap.value?.terrain?.find(p => p.id === sp.id);
    if (fresh && fresh !== sp) selectedProvince.value = fresh;
  }
  render();
}, { deep: true });
</script>

<style scoped>
.scenario-map-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #0f1a2e;
}

.scenario-toolbar {
  display: flex;
  gap: 12px;
  padding: 8px 12px;
  background: #1e293b;
  border-bottom: 1px solid #334155;
  flex-wrap: wrap;
  align-items: center;
}

.back-btn {
  padding: 6px 12px;
  border: 1px solid #475569;
  background: #334155;
  color: #e2e8f0;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  margin-right: 8px;
}

.back-btn:hover { background: #475569; }

.tool-group {
  display: flex;
  gap: 4px;
  align-items: center;
}

.tool-group label {
  color: #94a3b8;
  font-size: 11px;
}

.tool-group select {
  background: #334155;
  color: #e2e8f0;
  border: 1px solid #475569;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
}

.check-label {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: #94a3b8;
  cursor: pointer;
}

.tool-group button {
  width: 32px;
  height: 32px;
  border: 1px solid #475569;
  background: #334155;
  color: #e2e8f0;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
}

.tool-group button:hover { background: #475569; }
.tool-group button.active { background: #5b21b6; border-color: #7c3aed; }
.tool-group button:disabled { opacity: 0.4; cursor: not-allowed; }
.tool-group button.saving { animation: pulse 1s infinite; }

.scenario-timeline {
  background: #172033;
  border-bottom: 1px solid #334155;
  padding: 6px 12px;
  overflow-x: auto;
}

.timeline-scroll { display: flex; gap: 6px; }

.timeline-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 6px 12px;
  border: 1px solid #475569;
  background: #1e293b;
  color: #cbd5e1;
  border-radius: 6px;
  cursor: pointer;
  font-size: 11px;
  white-space: nowrap;
  min-width: 60px;
}

.timeline-btn:hover { background: #334155; }
.timeline-btn.active { background: #5b21b6; border-color: #7c3aed; color: #fff; }

.era-roman { font-size: 14px; font-weight: 600; }
.era-label { font-size: 10px; opacity: 0.8; }

.polity-palette {
  display: flex;
  gap: 4px;
  padding: 6px 12px;
  background: #172033;
  border-bottom: 1px solid #334155;
  flex-wrap: wrap;
  align-items: center;
}

.palette-title {
  color: #94a3b8;
  font-size: 11px;
  margin-right: 4px;
}

.polity-swatch {
  width: 28px;
  height: 28px;
  border-radius: 4px;
  border: 2px solid transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #fff;
  font-weight: 600;
  text-shadow: 0 1px 2px rgba(0,0,0,0.5);
  position: relative;
}

.polity-swatch:hover { transform: scale(1.1); }
.polity-swatch.active { border-color: #ffd700; box-shadow: 0 0 6px rgba(255, 215, 0, 0.5); }

.polity-name {
  display: none;
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  background: #1e293b;
  color: #e2e8f0;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11px;
  white-space: nowrap;
  z-index: 100;
  border: 1px solid #475569;
}

.polity-swatch:hover .polity-name { display: block; }

.polity-swatch.clear { background: #475569; border-color: #64748b; }

.scenario-canvas-wrap {
  flex: 1;
  position: relative;
  overflow: hidden;
}

.scenario-canvas-wrap canvas {
  width: 100%;
  height: 100%;
  display: block;
  cursor: grab;
}

.scenario-status-bar {
  padding: 6px 12px;
  background: #1e293b;
  border-top: 1px solid #334155;
  color: #94a3b8;
  font-size: 11px;
  display: flex;
  gap: 16px;
}

.draw-hint { color: #a78bfa; font-weight: 600; }
.selected-provity { color: #fbbf24; }
.selected-burg { color: #ffd700; font-weight: 600; }

.selected-polity {
  display: flex;
  align-items: center;
  gap: 4px;
}

.polity-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}

.save-status { margin-left: auto; }
.save-status.saved { color: #4ade80; }
.save-status.error { color: #f87171; }
.save-status.saving { color: #fbbf24; }

/* 右键菜单 */
.context-menu {
  position: absolute;
  background: #1e293b;
  border: 1px solid #475569;
  border-radius: 8px;
  padding: 4px 0;
  z-index: 1000;
  min-width: 160px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}

.ctx-item {
  padding: 8px 16px;
  color: #e2e8f0;
  font-size: 12px;
  cursor: pointer;
}

.ctx-item:hover { background: #334155; }
.ctx-item.danger { color: #f87171; }
.ctx-item.disabled { color: #64748b; cursor: default; }

.ctx-divider {
  height: 1px;
  background: #334155;
  margin: 4px 0;
}

/* 省份属性面板 */
.province-props {
  position: absolute;
  top: 100px;
  right: 16px;
  width: 280px;
  background: #1e293b;
  border: 1px solid #475569;
  border-radius: 12px;
  padding: 16px;
  z-index: 100;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}

.props-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.props-name {
  flex: 1;
  background: #334155;
  border: 1px solid #475569;
  border-radius: 4px;
  padding: 6px 8px;
  color: #e2e8f0;
  font-size: 14px;
  font-weight: 600;
}

.props-close {
  background: none;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  font-size: 14px;
}

.props-close:hover { color: #e2e8f0; }

.props-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.props-row label {
  min-width: 70px;
  font-size: 12px;
  color: #94a3b8;
}

.props-row input[type="text"], .props-row select {
  flex: 1;
  background: #334155;
  border: 1px solid #475569;
  border-radius: 4px;
  padding: 4px 8px;
  color: #e2e8f0;
  font-size: 12px;
}

.props-stats {
  font-size: 11px;
  color: #64748b;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #334155;
}

/* 模态框 */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
}

.modal-dialog {
  background: #1e293b;
  border: 1px solid #475569;
  border-radius: 12px;
  padding: 20px;
  max-width: 500px;
  width: 90%;
  max-height: 80vh;
  overflow-y: auto;
  color: #e2e8f0;
}

.modal-dialog h3 { margin: 0 0 16px; font-size: 16px; }

.scenario-list { margin-bottom: 20px; }

.scenario-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid #334155;
}

.item-era { font-weight: 600; color: #7c3aed; min-width: 20px; }
.item-name { flex: 1; font-size: 13px; }
.item-years { font-size: 11px; color: #64748b; }

.item-delete {
  background: none;
  border: none;
  cursor: pointer;
  opacity: 0.5;
}

.item-delete:hover { opacity: 1; }

.new-scenario-form {
  border-top: 1px solid #334155;
  padding-top: 16px;
}

.new-scenario-form h4 { margin: 0 0 12px; font-size: 14px; }

.form-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.form-row label {
  min-width: 80px;
  font-size: 12px;
  color: #94a3b8;
}

.form-row input[type="text"], .form-row textarea {
  flex: 1;
  background: #334155;
  border: 1px solid #475569;
  border-radius: 4px;
  padding: 6px 8px;
  color: #e2e8f0;
  font-size: 12px;
}

.form-row input.short-input { max-width: 60px; }
.form-row.checkbox label { min-width: auto; }

.form-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 12px;
}

.form-actions button {
  padding: 6px 16px;
  border: 1px solid #475569;
  background: #334155;
  color: #e2e8f0;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}

.form-actions button:first-child { background: #5b21b6; border-color: #7c3aed; }
.form-actions button:disabled { opacity: 0.4; cursor: not-allowed; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
</style>
