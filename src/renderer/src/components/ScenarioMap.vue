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
        ><Icon name="hand" :size="15"/></button>
        <button 
          :class="{ active: tool === 'draw' }" 
          @click="setTool('draw')"
          title="绘制省份 (B) — 点击添加顶点，双击完成"
        ><Icon name="pencil" :size="15"/></button>
        <button 
          :class="{ active: tool === 'vertex' }" 
          @click="setTool('vertex')"
          title="顶点编辑 (G) — 拖拽省份顶点调整形状，点击边插入顶点"
        >⬡</button>
        <button 
          :class="{ active: tool === 'split' }" 
          @click="setTool('split')"
          title="拆分省份 (X) — 点击两个点定义分割线"
        ><Icon name="scissors" :size="15"/></button>
        <button 
          :class="{ active: tool === 'merge' }" 
          @click="setTool('merge')"
          title="合并省份 (M) — 依次点击两个省份"
        >⊕</button>
        <button 
          :class="{ active: tool === 'paint' }" 
          @click="setTool('paint')"
          title="势力油漆桶 (P) — 点击省份指派势力"
        ><Icon name="palette" :size="15"/></button>
        <button 
          :class="{ active: tool === 'river' }" 
          @click="setTool('river')"
          title="河流编辑器 (W) — 手动绘制河流路径"
        ><Icon name="droplets" :size="15"/></button>
        <button 
          :class="{ active: tool === 'relief' }" 
          @click="setTool('relief')"
          title="Relief 图标 (I) — 放置山脉/树木/沙漠等自然特征"
        ><Icon name="mountain" :size="15"/></button>
        <button 
          :class="{ active: tool === 'label' }" 
          @click="setTool('label')"
          title="历史地名 (T) — 点击放置文字标记"
        ><Icon name="tag" :size="15"/></button>
        <select v-if="tool === 'label'" v-model="selectedLabelPreset" class="brush-biome-select" title="标签样式预设">
          <option v-for="preset in LABEL_PRESETS" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
        </select>
        <select v-if="tool === 'relief'" v-model="selectedReliefIcon" class="brush-biome-select" title="Relief 图标">
          <option v-for="icon in RELIEF_ICONS" :key="icon.id" :value="icon.id">{{ icon.name }}</option>
        </select>
        <select v-if="tool === 'road'" v-model="selectedRoadStyle" class="brush-biome-select" title="道路样式">
          <option v-for="style in ROAD_STYLES" :key="style.id" :value="style.id">{{ style.name }}</option>
        </select>
        <select v-if="tool === 'marker'" v-model="selectedMarkerType" class="brush-biome-select" title="标记类型">
          <option v-for="type in MARKER_TYPES" :key="type.id" :value="type.id">{{ type.name }}</option>
        </select>
        <button 
          :class="{ active: tool === 'erase' }" 
          @click="setTool('erase')"
          title="删除 (E) — 点击省份删除"
        ><Icon name="trash" :size="15"/></button>
        <button 
          :class="{ active: tool === 'height' }" 
          @click="setTool('height')"
          title="高度笔刷 (H) — 左键抬高/右键降低地形"
        ><Icon name="trending-up" :size="15"/></button>
        <button 
          :class="{ active: tool === 'biome' }" 
          @click="setTool('biome')"
          title="生物群系笔刷 (N) — 涂抹生物群系"
        ><Icon name="palette" :size="15"/></button>
        <button 
          :class="{ active: tool === 'burg' }" 
          @click="setTool('burg')"
          title="智能聚落 (U) — 点击放置，自动贴合地形"
        ><Icon name="home" :size="15"/></button>
        <button 
          :class="{ active: tool === 'river' }" 
          @click="generateAndShowRivers"
          title="自动生成河流 — 沿高度梯度从高地流向海洋"
        ><Icon name="waves" :size="15"/></button>
        <button 
          :class="{ active: tool === 'derive' }" 
          @click="deriveLayers"
          title="重算派生图层 — 基于高度重算温度/降水/生物群系"
        ><Icon name="refresh-cw" :size="15"/></button>
      </div>
        <button 
          :class="{ active: tool === 'culture' }" 
          @click="setTool('culture')"
          title="文化笔刷 (C) — 涂抹文化区域"
        ><Icon name="users" :size="15"/></button>
        <button 
          :class="{ active: tool === 'religion' }" 
          @click="setTool('religion')"
          title="宗教笔刷 (R) — 涂抹宗教区域"
        ><Icon name="church" :size="15"/></button>
        <button 
          :class="{ active: tool === 'marker' }" 
          @click="setTool('marker')"
          title="标记 (K) — 点击放置标记"
        ><Icon name="map-pin" :size="15"/></button>
        <button 
          :class="{ active: tool === 'road' }" 
          @click="setTool('road')"
          title="道路 (J) — 两点连线，自动生成沿等高线路径"
        ><Icon name="git-branch" :size="15"/></button>
      </div>
      <!-- 笔刷设置 -->
      <div class="tool-group brush-settings" v-if="['height','biome','culture','religion'].includes(tool)">
        <label>笔刷：</label>
        <label class="check-label" title="笔刷半径（滚轮调节）">
          半径
          <input type="range" v-model.number="brushRadius" min="20" max="300" step="10" class="brush-slider" />
          {{ brushRadius }}
        </label>
        <label class="check-label" v-if="tool === 'height'" title="笔刷强度（Shift+滚轮调节）">
          强度
          <input type="range" v-model.number="brushStrength" min="0.5" max="10" step="0.5" class="brush-slider" />
          {{ brushStrength }}
        </label>
        <label class="check-label" v-if="tool === 'biome'">
          群系
          <select v-model="brushBiome" class="brush-biome-select">
            <option v-for="(color, key) in BIOME_COLORS" :key="key" :value="key">{{ key }}</option>
          </select>
        </label>
        <label class="check-label" v-if="tool === 'culture'">
          文化
          <select v-model="brushCulture" class="brush-biome-select">
            <option v-for="c in availableCultures" :key="c.id" :value="String(c.id)">{{ c.name }}</option>
          </select>
        </label>
        <label class="check-label" v-if="tool === 'religion'">
          宗教
          <select v-model="brushReligion" class="brush-biome-select">
            <option v-for="r in availableReligions" :key="r.id" :value="String(r.id)">{{ r.name }}</option>
          </select>
        </label>
      </div>
      <div class="tool-group">
        <button @click="triggerMapImport" title="导入 .map 底图"><Icon name="map" :size="15"/></button>
        <button @click="fitToView" title="适应画布 (F)">⊞</button>
        <button @click="exportPNG" title="导出 PNG 图片"><Icon name="download" :size="15"/></button>
        <button @click="manualSave" title="保存到磁盘" :class="{ 'saving': store.saveStatus.value === 'saving' }">
          <Icon v-if="store.saveStatus.value === 'saving'" name="loader" :size="15"/>
          <Icon v-else-if="store.saveStatus.value === 'saved'" name="check-circle" :size="15"/>
          <Icon v-else name="save" :size="15"/>
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
        <label class="check-label" title="绘制时顶点吸附到已有省份边界（按住 Shift 临时禁用）">
          <input type="checkbox" v-model="snapToEdgeEnabled" /> 海岸线吸附
        </label>
      </div>
      <div class="tool-group">
        <label>图层：</label>
        <label class="check-label"><input type="checkbox" v-model="showBiomes" /> 生物群系</label>
        <label class="check-label"><input type="checkbox" v-model="showBorders" /> 边界</label>
        <label class="check-label"><input type="checkbox" v-model="showBurgs" /> 城镇</label>
        <label class="check-label"><input type="checkbox" v-model="showLabels" /> 标签</label>
        <button @click="showLayerPanel = !showLayerPanel" title="图层锁定设置" :class="{ active: showLayerPanel }"><Icon name="lock" :size="13"/></button>
      </div>
      <div class="tool-group">
        <label>底图图层：</label>
        <select v-model="rasterLayer" title="网格数据图层（一次只渲染一层，避免叠加失真）">
          <option value="none">无</option>
          <option value="landsea">陆海底色</option>
          <option value="height">地形高度</option>
          <option value="temp">温度</option>
          <option value="prec">降水</option>
        </select>
        <label class="check-label"><input type="checkbox" v-model="showRivers" /> 河流</label>
        <label class="check-label"><input type="checkbox" v-model="showRoutes" /> 道路</label>
      </div>
      <div class="tool-group">
        <label>着色：</label>
        <select v-model="colorMode">
          <option value="default">默认</option>
          <option value="culture">文化</option>
          <option value="religion">宗教</option>
        </select>
      </div>
      <div class="tool-group">
        <button @click="showScenarioManager = true" title="剧本管理"><Icon name="file-text" :size="15"/></button>
        <button @click="showHistoryPanel = !showHistoryPanel" title="撤销历史" :class="{ active: showHistoryPanel }"><Icon name="history" :size="15"/></button>
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
      ><Icon name="x" :size="14"/></div>
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
      <span v-if="snapFeedback" class="snap-feedback" :class="{ edge: snapFeedback === '吸附到边界' }">{{ snapFeedback }}</span>
      <span v-if="tool === 'vertex' && activeVertexIdx >= 0" class="draw-hint">切线手柄：拖拽圆点调曲率（Alt 临时直线）</span>
      <span v-if="baseMap?.source?.warnings?.length" class="layer-warn" :title="baseMap.source.warnings.join('\n')">
        <Icon name="alert-triangle" :size="13"/> {{ baseMap.source.warnings.length }} 条图层提示
      </span>
      <span v-if="selectedBurg" class="selected-burg">城镇：{{ selectedBurg.name }}（人口 {{ formatPopulation(selectedBurg.population) }}）</span>
      <span v-if="viewMode === 'scenario' && selectedScenario">剧本：{{ selectedScenario.name }}</span>
      <span v-if="selectedPolity" class="selected-polity">已选势力：<span class="polity-dot" :style="{ background: selectedPolity.color }"></span>{{ selectedPolity.name }}</span>
      <span class="save-status" :class="store.saveStatus.value">
        <template v-if="store.saveStatus.value === 'saving'"><Icon name="loader" :size="13"/> 保存中...</template>
        <template v-else-if="store.saveStatus.value === 'saved'"><Icon name="check-circle" :size="13"/> 已保存</template>
        <template v-else-if="store.saveStatus.value === 'error'"><Icon name="x-circle" :size="13"/> 保存失败</template>
        <template v-else><Icon name="save" :size="13"/> 自动保存</template>
      </span>
    </div>

    <!-- 省份右键菜单 -->
    <div v-if="contextMenu.show" class="context-menu" :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }">
      <div class="ctx-item" @click="ctxRenameProvince"><Icon name="pencil" :size="13"/> 重命名</div>
      <div class="ctx-item" @click="ctxChangeBiome"><Icon name="palette" :size="13"/> 更改生物群系</div>
      <div class="ctx-item" @click="ctxDuplicateProvince">⧉ 复制省份</div>
      <div class="ctx-item danger" @click="ctxDeleteProvince"><Icon name="trash" :size="13"/> 删除</div>
      <div class="ctx-divider"></div>
      <div class="ctx-item disabled" v-if="selectedProvince">
        {{ selectedProvince.name }} · {{ selectedProvince.biome || '未分类' }}
      </div>
    </div>

    <!-- 省份属性面板 -->
    <div v-if="selectedProvince && showProps" class="province-props">
      <div class="props-header">
        <input v-model="selectedProvince.name" @input="onProvinceNameChange" class="props-name" />
        <button @click="showProps = false" class="props-close"><Icon name="x" :size="13"/></button>
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
            <button class="item-delete" @click="deleteScenario(s)" title="删除"><Icon name="trash" :size="15"/></button>
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

    <!-- 图层锁定面板 -->
    <div v-if="showLayerPanel" class="layer-lock-panel">
      <div class="layer-lock-header">
        <span>图层锁定</span>
        <button @click="showLayerPanel = false" class="layer-lock-close"><Icon name="x" :size="13"/></button>
      </div>
      <div class="layer-lock-list">
        <div v-for="(layer, id) in scenarioLayers" :key="id" class="layer-lock-row">
          <span class="layer-lock-label">{{ layer.label }}</span>
          <button
            class="layer-lock-btn"
            :class="{ locked: layer.locked }"
            :title="layer.locked ? '解锁图层' : '锁定图层（不可编辑）'"
            @click="toggleLayerLock(id)"
          >
            <Icon :name="layer.locked ? 'lock' : 'unlock'" :size="13"/>
          </button>
        </div>
      </div>
    </div>

    <!-- 撤销历史面板 -->
    <HistoryPanel v-if="showHistoryPanel" :open="showHistoryPanel" @close="showHistoryPanel = false" />
</template>

<script setup>
import Icon from './Icon.vue';
import { ref, onMounted, onUnmounted, watch, computed } from 'vue';
import { useGeodataStore } from '../store/geodata';
import { useLayersStore } from '../store/layers';
import { parseMapFile, buildScenariosJson } from '../utils/azgaar-parser';
import { generateRoadPath } from '../utils/placement';
import HistoryPanel from './HistoryPanel.vue';

const store = useGeodataStore();
const layers = useLayersStore();

const canvas = ref(null);
const canvasWrap = ref(null);
const tool = ref('select');
const viewMode = ref('base');
const baseMapKey = ref('德斯特星');
const selectedScenario = ref(null);
const selectedPolity = ref(null);
const ctx = ref(null);
const showScenarioManager = ref(false);
const showLayerPanel = ref(false);
const showHistoryPanel = ref(false);

// 图层锁定（P0 图层锁定迁移）
const scenarioLayers = ref({
  terrain: { visible: true, label: '省份', locked: false, order: 0 },
  biomes: { visible: true, label: '生物群系', locked: false, order: 1 },
  borders: { visible: true, label: '边界', locked: false, order: 2 },
  burgs: { visible: true, label: '城镇', locked: false, order: 3 },
  labels: { visible: true, label: '标签', locked: false, order: 4 },
  rivers: { visible: true, label: '河流', locked: false, order: 5 },
  routes: { visible: false, label: '道路', locked: false, order: 6 },
  raster: { visible: true, label: '底图数据', locked: false, order: 7 },
});

function isLayerLocked(layerId) {
  return scenarioLayers.value[layerId]?.locked ?? false;
}

function toggleLayerLock(layerId) {
  const layer = scenarioLayers.value[layerId];
  if (layer) {
    layer.locked = !layer.locked;
  }
}

function isLayerEditable(layerId) {
  const layer = scenarioLayers.value[layerId];
  if (!layer) return false;
  return layer.visible && !layer.locked;
}

// 图层可见性（保留旧 ref 兼容模板）
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
const draggingHandle = ref(null); // { provId, vertexIdx, which: 'in'|'out' }（P0-T1 切线手柄）
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

// 笔刷状态（v2 高度图编辑）
const brushRadius = ref(80);         // 世界坐标像素
const brushStrength = ref(3);        // 高度变化强度
const brushBiome = ref('grassland'); // 当前选中生物群系
const brushCulture = ref('1');       // 当前选中文化 ID
const brushReligion = ref('1');      // 当前选中宗教 ID
let isBrushing = false;              // 是否正在笔刷拖动中
let brushMode = 'raise';             // 'raise' | 'lower' | 'smooth'
const brushPreview = ref(null);      // { x, y, radius } 笔刷预览（hover 显示）

// 笔刷性能优化：空间索引（网格快速定位，避免全量遍历）
let gridSpatialIndex = null;

function buildSpatialIndex(pts, spacing) {
  if (!pts || !pts.length) return null;
  const cellSize = spacing * 2;
  const cellMap = new Map();
  let minX = Infinity, minY = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
    const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
    if (px < minX) minX = px;
    if (py < minY) minY = py;
  }
  for (let i = 0; i < pts.length; i++) {
    const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
    const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
    const cx = Math.floor((px - minX) / cellSize);
    const cy = Math.floor((py - minY) / cellSize);
    const key = `${cx},${cy}`;
    if (!cellMap.has(key)) cellMap.set(key, []);
    cellMap.get(key).push(i);
  }
  return { cellSize, minX, minY, cellMap };
}

function getNearbyIndices(worldX, worldY, radius, spatialIndex) {
  if (!spatialIndex) return null;
  const { cellSize, minX, minY, cellMap } = spatialIndex;
  const minCx = Math.floor((worldX - radius - minX) / cellSize);
  const maxCx = Math.floor((worldX + radius - minX) / cellSize);
  const minCy = Math.floor((worldY - radius - minY) / cellSize);
  const maxCy = Math.floor((worldY + radius - minY) / cellSize);
  const result = [];
  for (let cx = minCx; cx <= maxCx; cx++) {
    for (let cy = minCy; cy <= maxCy; cy++) {
      const cell = cellMap.get(`${cx},${cy}`);
      if (cell) result.push(...cell);
    }
  }
  return result;
}

// 笔刷性能优化：派生节流（拖拽中每 3 帧派生一次）
let brushFrameCount = 0;
let pendingDerive = false;
// 文化/宗教选项
const availableCultures = computed(() => {
  const hm = baseMap.value?.heightmap;
  return hm?.cultures?.filter(c => c.i > 0) || [{ id: 1, name: '未分类' }];
});

const availableReligions = computed(() => {
  const hm = baseMap.value?.heightmap;
  return hm?.religions?.filter(r => r.i > 0) || [{ id: 1, name: '未分类' }];
});

const autoRivers = ref([]);          // {x,y}[] 生成的河流路径

// Relief icons (P1-T1 山脉/树木/沙漠等自然特征)
const RELIEF_ICONS = [
  { id: 'mountain', name: '山脉', icon: '⛰️', color: '#8B7355' },
  { id: 'forest', name: '森林', icon: '🌲', color: '#228B22' },
  { id: 'desert', name: '沙漠', icon: '🏜️', color: '#EDC9AF' },
  { id: 'volcano', name: '火山', icon: '🌋', color: '#FF4500' },
  { id: 'lake', name: '湖泊', icon: '💧', color: '#4A90D9' },
  { id: 'cactus', name: '仙人掌', icon: '🌵', color: '#5F7A4A' },
  { id: 'palm', name: '棕榈', icon: '🌴', color: '#228B22' },
  { id: 'snow', name: '雪地', icon: '❄️', color: '#F0F8FF' },
];

const selectedReliefIcon = ref('mountain');
const reliefIcons = ref([]); // { id, iconId, x, y, icon, color }

// 道路编辑器（P1-T3 道路样式预设）
const ROAD_STYLES = [
  { id: 'highway', name: '公路', width: 1.5, dash: null, color: '#d06324' },
  { id: 'road', name: '道路', width: 1.0, dash: null, color: '#d06324' },
  { id: 'trail', name: '小径', width: 0.7, dash: [3, 3], color: '#d06324' },
  { id: 'path', name: '步道', width: 0.5, dash: [1.5, 3], color: '#d06324' },
  { id: 'searoute', name: '海路', width: 0.8, dash: [2, 4], color: '#ffffff' },
];

const selectedRoadStyle = ref('road');

// 标记类型系统（P1-T5 多种标记类型）
const MARKER_TYPES = [
  { id: 'city', name: '城市', icon: '🏰', color: '#ffd700' },
  { id: 'port', name: '港口', icon: '⚓', color: '#4A90D9' },
  { id: 'battlefield', name: '战场', icon: '⚔️', color: '#f87171' },
  { id: 'ruin', name: '遗迹', icon: '🏛️', color: '#a78bfa' },
  { id: 'resource', name: '资源', icon: '💎', color: '#34d399' },
  { id: 'danger', name: '危险', icon: '☠️', color: '#f87171' },
  { id: 'custom', name: '自定义', icon: '📍', color: '#94a3b8' },
];

const selectedMarkerType = ref('city');

// 河流编辑器（P1-T2 手动编辑河流路径）
const riverDraft = ref([]); // {x, y}[] 当前绘制中的河流路径
const riverPaths = ref([]); // {x, y}[][] 已完成的河流路径
const LABEL_PRESETS = [
  { id: 'default', name: '默认', font: '12px "PingFang SC"', color: '#e2e8f0', stroke: 'rgba(0,0,0,0.7)', strokeWidth: 3 },
  { id: 'title', name: '标题', font: 'bold 18px "PingFang SC"', color: '#ffd700', stroke: 'rgba(0,0,0,0.8)', strokeWidth: 4 },
  { id: 'subtitle', name: '副标题', font: '14px "PingFang SC"', color: '#94a3b8', stroke: 'rgba(0,0,0,0.6)', strokeWidth: 2 },
  { id: 'culture', name: '文化', font: 'italic 13px "PingFang SC"', color: '#c4b5fd', stroke: 'rgba(0,0,0,0.6)', strokeWidth: 2 },
  { id: 'danger', name: '危险', font: 'bold 13px "PingFang SC"', color: '#f87171', stroke: 'rgba(0,0,0,0.7)', strokeWidth: 3 },
];

const selectedLabelPreset = ref('default');
const roadStart = ref(null);         // {x, y} 道路起点
const roadPath = ref([]);            // {x, y}[] 道路路径预览

// 城镇标记（P1-T4）
const BURG_HIT_RADIUS = 10;          // 命中半径（屏幕像素）
const hoveredBurg = ref(null);
const selectedBurg = ref(null);

// ── 底图数据图层（FMG .map 解析产物：网格高度/温度/降水 + 河流/道路 + 文化/宗教）──
const rasterLayer = ref('landsea');  // none | landsea | height | temp | prec（互斥单选）
const showRivers = ref(true);
const showRoutes = ref(false);
const colorMode = ref('default');    // default | culture | religion

// 顶点切线手柄当前选中顶点（P0-T1）；-1 = 未选中
const activeVertexIdx = ref(-1);
// Alt 临时直线（P0-T1）；不参与响应式，只在绘制时读取
let altStraight = false;

// 海岸线吸附（P0-T2）
const snapToEdgeEnabled = ref(true);
const SNAP_EDGE_THRESHOLD = 10;      // 世界坐标像素
const snapFeedback = ref('');
let snapFeedbackTimer = null;

// 底图数据图层的离屏预渲染缓存（键：layerKey -> {canvas,minX,minY,w,h}）
const rasterCache = new Map();

// 分层设色盘（低→高；海洋/陆地分段）
const HYPSO_WATER = ['#12314f', '#1d4a70', '#2b6b93', '#3f8fb0', '#63b0c9'];
const HYPSO_LAND = ['#6f9f5a', '#8fb063', '#c3c46c', '#d8bf7a', '#b59468', '#8f7a5c', '#d9d2c6'];
const TEMP_RAMP = ['#313695', '#4575b4', '#74add1', '#abd9e9', '#e0f3f8', '#fee090', '#fdae61', '#f46d43', '#d73027'];
const PREC_RAMP = ['#fff7bc', '#fee391', '#fec44f', '#c7e9b4', '#7fcdbb', '#41b6c4', '#1d91c0', '#225ea8'];
const LAND_BASE_COLOR = [220, 216, 207];   // #dcd8cf 无主省份本色
const SEA_BASE_COLOR = [201, 214, 228];    // #c9d6e4 海洋底

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
  const la = layerAvailability.value;
  const bits = [`${baseMap.value.terrain?.length || 0} 省份`];
  if (la.cells) bits.push(`${la.cells} 网格`);
  if (la.rivers) bits.push(`${la.rivers} 河流`);
  if (la.routes) bits.push(`${la.routes} 道路`);
  if (la.cultures > 1) bits.push(`${la.cultures - 1} 文化`);
  if (la.religions > 1) bits.push(`${la.religions - 1} 宗教`);
  return bits.join(' | ');
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
  draggingHandle.value = null;
  activeVertexIdx.value = -1;
  dragPreview.value = null;
  hoveredBurg.value = null;
  brushPreview.value = null;
  isBrushing = false;
  roadStart.value = null;
  roadPath.value = [];
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
  else if (tool.value === 'height' || tool.value === 'biome') canvas.value.style.cursor = 'none';
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

function setSnapMarker(x, y, kind = 'grid') {
  snapMarker.value = { x, y, kind };
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

  // 笔刷工具：左键抬高 / 右键降低
  if (tool.value === 'height' && (event.button === 0 || event.button === 2)) {
    isBrushing = true;
    brushMode = event.button === 0 ? 'raise' : 'lower';
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    store.applyHeightBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushStrength.value, brushMode);
    return;
  }
  if (tool.value === 'biome' && event.button === 0) {
    isBrushing = true;
    brushMode = 'biome';
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    store.applyBiomeBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushBiome.value);
    return;
  }
  if (tool.value === 'culture' && event.button === 0) {
    isBrushing = true;
    brushMode = 'culture';
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    store.applyCultureBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushCulture.value);
    return;
  }
  if (tool.value === 'religion' && event.button === 0) {
    isBrushing = true;
    brushMode = 'religion';
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    store.applyReligionBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushReligion.value);
    return;
  }
  // marker 和 road 在 onCanvasClick 处理

  if (event.button === 0 && (tool.value === 'select' || tool.value === 'vertex')) {
    // 顶点编辑模式：先判切线手柄，再判顶点
    if (tool.value === 'vertex' && selectedProvince.value) {
      const rect = canvas.value.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      const world = screenToWorld(sx, sy);
      const prov = currentProvince();
      const threshold = 8 / cameraScale.value;
      const points = prov && prov.points ? resolvePoints(prov) : null;
      if (points) {
        // P0-T1：切线手柄命中（仅当前选中顶点）
        const ai = activeVertexIdx.value;
        if (ai >= 0 && ai < points.length && !altStraight) {
          const ap = points[ai];
          const hR = 10 / cameraScale.value;
          const out = ap.controlOut;
          const inn = ap.controlIn;
          if (out && Math.hypot(vx(ap) + out.x - world.x, vy(ap) + out.y - world.y) < hR) {
            draggingHandle.value = { provId: prov.id, vertexIdx: ai, which: 'out' };
            canvas.value.style.cursor = 'crosshair';
            return;
          }
          if (inn && Math.hypot(vx(ap) + inn.x - world.x, vy(ap) + inn.y - world.y) < hR) {
            draggingHandle.value = { provId: prov.id, vertexIdx: ai, which: 'in' };
            canvas.value.style.cursor = 'crosshair';
            return;
          }
        }
        for (let i = 0; i < points.length; i++) {
          const p = points[i];
          const dx = vx(p) - world.x;
          const dy = vy(p) - world.y;
          if (Math.sqrt(dx * dx + dy * dy) < threshold) {
            draggingVertex.value = { provId: prov.id, vertexIdx: i };
            activeVertexIdx.value = i;
            // 旧数据没有控制点：首次选中顶点时自动生成平滑切线（走 undo 栈）
            if (!p.controlIn && !p.controlOut) {
              store.updateBaseProvince(baseMapKey.value, prov.id, {
                points: withBezierControls(resolvePoints(prov).map(q => ({ x: vx(q), y: vy(q) }))),
              });
              showSnapFeedback('已生成贝塞尔切线');
            }
            render();
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
  // 笔刷预览更新
  if (['height', 'biome', 'culture', 'religion'].includes(tool.value)) {
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    brushPreview.value = { x: world.x, y: world.y, radius: brushRadius.value };

    // 拖动中应用笔刷
    if (isBrushing) {
      if (tool.value === 'height') {
        store.applyHeightBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushStrength.value, brushMode);
      } else if (tool.value === 'biome') {
        store.applyBiomeBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushBiome.value);
      } else if (tool.value === 'culture') {
        store.applyCultureBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushCulture.value);
      } else if (tool.value === 'religion') {
        store.applyReligionBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushReligion.value);
      }
    }
    render();
    return;
  }

  if (tool.value === 'road' && roadStart.value) {
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    // 实时预览：从 roadStart 到当前鼠标的直线（松开时计算实际路径）
    roadPath.value = [roadStart.value, world];
    render();
    return;
  }

  if (tool.value === 'burg') {
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    placeSmartBurg(world);
    render();
    return;
  }

  if (draggingHandle.value) {
    const rect = canvas.value.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const world = screenToWorld(sx, sy);
    const { provId, vertexIdx, which } = draggingHandle.value;
    const prov = baseMap.value?.terrain?.find(p => p.id === provId);
    if (prov && prov.points && prov.points[vertexIdx]) {
      const src = resolvePoints(prov);
      const target = src[vertexIdx];
      // 切线偏移 = 光标 - 顶点；对称约束（拖一端，另一端镜像）
      const off = { x: world.x - vx(target), y: world.y - vy(target) };
      dragPreview.value = {
        provId,
        points: src.map((p, i) => {
          const base = { x: vx(p), y: vy(p) };
          if (i !== vertexIdx) {
            return p.controlIn || p.controlOut
              ? { x: base.x, y: base.y, controlIn: p.controlIn, controlOut: p.controlOut }
              : base;
          }
          return which === 'out'
            ? { x: base.x, y: base.y, controlOut: off, controlIn: { x: -off.x, y: -off.y } }
            : { x: base.x, y: base.y, controlIn: off, controlOut: { x: -off.x, y: -off.y } };
        }),
      };
      render();
    }
    return;
  }
  if (draggingVertex.value) {
    const rect = canvas.value.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const world = screenToWorld(sx, sy);
    const { provId, vertexIdx } = draggingVertex.value;
    const prov = baseMap.value?.terrain?.find(p => p.id === provId);
    if (prov && prov.points && prov.points[vertexIdx]) {
      // 顶点编辑拖拽同样吸附（边界 > 网格；Shift 禁用）
      const snapped = resolveSnapPoint(world, event.shiftKey);
      if (snapped.snapped) setSnapMarker(snapped.x, snapped.y, snapped.kind);
      // 只更新临时预览，不写 store（拖拽结束再一次性提交，保证 undo 可回滚）
      dragPreview.value = {
        provId,
        points: resolvePoints(prov).map((p, i) => {
          if (i !== vertexIdx) return p;
          const next = { x: snapped.x, y: snapped.y };
          if (p.controlIn) next.controlIn = p.controlIn;
          if (p.controlOut) next.controlOut = p.controlOut;
          return next;
        }),
      };
      render();
    }
    return;
  }
  if (!isPanning) {
    updateBurgHover(event);
    // 绘制模式下实时预览吸附点（只在命中变化时重绘）
    if (tool.value === 'draw' && snapToEdgeEnabled.value && !event.shiftKey) {
      const rect = canvas.value.getBoundingClientRect();
      const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
      const e = snapToEdge(world);
      const cur = snapMarker.value;
      const changed = !!e !== !!cur || (e && cur && (e.x !== cur.x || e.y !== cur.y || cur.kind !== 'edge'));
      if (changed) {
        if (e) setSnapMarker(e.x, e.y, 'edge');
        else { snapMarker.value = null; }
        render();
      }
    }
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
  if (isBrushing) {
    isBrushing = false;
  }
  if (draggingHandle.value) {
    const { provId } = draggingHandle.value;
    const preview = dragPreview.value;
    draggingHandle.value = null;
    dragPreview.value = null;
    if (preview && preview.provId === provId) {
      store.updateBaseProvince(baseMapKey.value, provId, { points: preview.points });
    }
    render();
    updateCursor();
    return;
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
  if (brushPreview.value) {
    brushPreview.value = null;
    render();
  }
}

function onWheel(event) {
  // 笔刷工具下：滚轮调半径，Shift+滚轮调强度
  if (tool.value === 'height' || tool.value === 'biome') {
    event.preventDefault();
    const delta = event.deltaY < 0 ? 1 : -1;
    if (event.shiftKey && tool.value === 'height') {
      brushStrength.value = Math.max(0.5, Math.min(10, brushStrength.value + delta * 0.5));
    } else {
      brushRadius.value = Math.max(20, Math.min(300, brushRadius.value + delta * 10));
    }
    return;
  }
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
    // 选中省份（顶点/手柄命中已在 mousedown 处理）
    const prov = findProvinceAt(world.x, world.y);
    if (prov) {
      if (selectedProvince.value?.id !== prov.id) activeVertexIdx.value = -1;
      selectedProvince.value = prov;
      showProps.value = true;
    }
    render();
    return;
  }

  if (tool.value === 'draw') {
    // 绘制顶点吸附：P0-T2 省份边界 > P0-T3 网格；Shift 临时禁用（验收：阈劀10px）
    const snapped = resolveSnapPoint(world, event.shiftKey);
    drawPoints.value = [...drawPoints.value, { x: snapped.x, y: snapped.y }];
    if (snapped.snapped) {
      setSnapMarker(snapped.x, snapped.y, snapped.kind);
      clearSnapMarker(600);
      showSnapFeedback(snapped.kind === 'edge' ? '吸附到边界' : '吸附到网格');
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
      const preset = LABEL_PRESETS.find(p => p.id === selectedLabelPreset.value) || LABEL_PRESETS[0];
      store.addScenarioLabel(selectedScenario.value.id, {
        x: world.x,
        y: world.y,
        text,
        font: preset.font,
        color: preset.color,
        stroke: preset.stroke,
        strokeWidth: preset.strokeWidth,
        preset: preset.id,
      });
      render();
    }
  } else if (tool.value === 'marker') {
    // 点击放置标记（P1-T5 标记类型系统）
    if (viewMode.value === 'scenario' && selectedScenario.value) {
      const name = prompt('标记名称：');
      if (name) {
        const typeDef = MARKER_TYPES.find(t => t.id === selectedMarkerType.value) || MARKER_TYPES[0];
        store.addScenarioMarker(selectedScenario.value.id, {
          x: world.x,
          y: world.y,
          name,
          type: selectedMarkerType.value,
          icon: typeDef.icon,
          color: typeDef.color,
        });
        render();
      }
    } else {
      alert('请先在剧本模式下使用标记工具');
    }
  } else if (tool.value === 'relief') {
    // Relief 图标放置（P1-T1）
    const iconDef = RELIEF_ICONS.find(i => i.id === selectedReliefIcon.value);
    if (iconDef) {
      reliefIcons.value.push({
        id: `relief_${Date.now()}`,
        iconId: iconDef.id,
        x: world.x,
        y: world.y,
        icon: iconDef.icon,
        color: iconDef.color,
      });
      render();
    }
  } else if (tool.value === 'river') {
    // 河流编辑器（P1-T2 手动绘制河流路径）
    riverDraft.value.push({ x: world.x, y: world.y });
    render();
  } else if (tool.value === 'road') {
    if (!roadStart.value) {
      roadStart.value = world;
      roadPath.value = [world];
    } else {
      // 两点完成道路：用 generateRoadPath 算实际路径
      const baseMapData = baseMap.value;
      if (baseMapData?.heightmap?.grid?.points) {
        const hm = baseMapData.heightmap;
        const pts = hm.grid.points;
        const spacing = hm.grid.spacing || 14.4;
        // 找最近网格点作为起终点
        let startIdx = -1, startDist = Infinity;
        let endIdx = -1, endDist = Infinity;
        for (let i = 0; i < pts.length; i++) {
          const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
          const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
          const sd = Math.hypot(px - roadStart.value.x, py - roadStart.value.y);
          if (sd < startDist) { startDist = sd; startIdx = i; }
          const ed = Math.hypot(px - world.x, py - world.y);
          if (ed < endDist) { endDist = ed; endIdx = i; }
        }
        if (startIdx >= 0 && endIdx >= 0 && startIdx !== endIdx) {
          const path = generateRoadPath(hm.h, hm.grid, startIdx, endIdx);
          if (path.length > 0) {
            const roadPoints = path.map(i => ({ x: pts[i][0], y: pts[i][1] }));
            const style = ROAD_STYLES.find(s => s.id === selectedRoadStyle.value) || ROAD_STYLES[1];
            const newRoute = {
              id: `road_${Date.now()}`,
              group: 'roads',
              name: `道路 ${Date.now()}`,
              points: roadPoints,
              style: style.id,
              width: style.width,
              dash: style.dash,
              color: style.color,
            };
            if (!baseMapData.routes) baseMapData.routes = [];
            baseMapData.routes.push(newRoute);
            store.baseMaps = {
              ...store.baseMaps,
              [baseMapKey.value]: {
                ...baseMapData,
                routes: [...baseMapData.routes],
                updatedAt: new Date().toISOString(),
              },
            };
          }
        }
      }
      roadStart.value = null;
      roadPath.value = [];
      render();
    }
  }
}

function onCanvasDblClick(event) {
  if (tool.value === 'draw' && drawPoints.value.length >= 3) {
    finishDraw();
  }
  if (tool.value === 'river' && riverDraft.value.length >= 2) {
    finishRiverDraft();
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
    draggingHandle.value = null;
    activeVertexIdx.value = -1;
    clearSnapMarker();
    render();
  }
  // P0-T1：Alt 临时直线段（按下即重绘，松开恢复曲线）
  if (event.key === 'Alt' && !altStraight) {
    altStraight = true;
    event.preventDefault();
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
  else if (event.key === 'h' || event.key === 'H') setTool('height');
  else if (event.key === 'n' || event.key === 'N') setTool('biome');
  else if (event.key === 'u' || event.key === 'U') setTool('burg');
  else if (event.key === 'c' || event.key === 'C') setTool('culture');
  else if (event.key === 'r' || event.key === 'R') setTool('religion');
  else if (event.key === 'k' || event.key === 'K') setTool('marker');
  else if (event.key === 'j' || event.key === 'J') setTool('road');
  else if (event.key === 'w' || event.key === 'W') setTool('river');
  else if (event.key === 'i' || event.key === 'I') setTool('relief');
  else if (event.key === 'f' || event.key === 'F') fitToView();
}

function onKeyUp(event) {
  if (event.key === 'Alt' && altStraight) {
    altStraight = false;
    render();
  }
}

function finishDraw() {
  const id = `prov_${Date.now()}`;
  // P0-T1 验收：新绘制省份自动生成平滑贝塞尔曲线（控制点 = 相邻顶点连线的 1/3）
  const points = withBezierControls(drawPoints.value.map(p => ({ x: p.x, y: p.y })));
  store.addBaseProvince(baseMapKey.value, {
    id,
    name: `新省份 ${baseMap.value?.terrain?.length + 1 || 1}`,
    points,
  });
  drawPoints.value = [];
  render();
}

function finishRiverDraft() {
  if (riverDraft.value.length >= 2) {
    riverPaths.value.push([...riverDraft.value]);
    riverDraft.value = [];
    render();
  }
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
// ══════════════════════════════════════
// 贝塞尔边界（P0-T1）
// ══════════════════════════════════════
/** 顶点坐标读取（兼容 {x,y} 与 [x,y]） */
function vx(p) { return p.x !== undefined ? p.x : p[0]; }
function vy(p) { return p.y !== undefined ? p.y : p[1]; }

/**
 * 为顶点批量生成平滑切线（验收：控制点位于相邻顶点连线的 1/3 处）。
 * 已带控制点的顶点原样保留（不覆盖手工调过的曲线）。
 */
function withBezierControls(points) {
  const n = points.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = points[i];
    if (p.controlIn && p.controlOut) { out[i] = p; continue; }
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    const dx = (vx(next) - vx(prev)) / 3;
    const dy = (vy(next) - vy(prev)) / 3;
    out[i] = { x: vx(p), y: vy(p), controlOut: { x: dx, y: dy }, controlIn: { x: -dx, y: -dy } };
  }
  return out;
}

/**
 * 描绘闭合/开口路径：有控制点且未按 Alt 时走 bezierCurveTo，否则退化直线段。
 * 红线：渲染循环内不创建新数组——本函数只读不分配。
 */
function traceShapePath(c, points, close = true) {
  const n = points.length;
  if (n < 2) return;
  c.moveTo(vx(points[0]), vy(points[0]));
  const last = close ? n : n - 1;
  for (let i = 1; i <= last; i++) {
    const prev = points[(i - 1) % n];
    const cur = points[i % n];
    const o = prev.controlOut;
    const k = cur.controlIn;
    if (!altStraight && o && k) {
      c.bezierCurveTo(vx(prev) + o.x, vy(prev) + o.y, vx(cur) + k.x, vy(cur) + k.y, vx(cur), vy(cur));
    } else {
      c.lineTo(vx(cur), vy(cur));
    }
  }
}

// ══════════════════════════════════════
// 海岸线吸附（P0-T2）
// ══════════════════════════════════════
/** 点到线段的最近投影 */
function projectOnSegment(world, a, b) {
  const ax = vx(a), ay = vy(a), bx = vx(b), by = vy(b);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 1e-9 ? ((world.x - ax) * dx + (world.y - ay) * dy) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const x = ax + t * dx;
  const y = ay + t * dy;
  const ddx = world.x - x, ddy = world.y - y;
  return { x, y, dist: Math.sqrt(ddx * ddx + ddy * ddy), t };
}

/**
 * 在已有省份边界上找最近吸附点（阈值默认 10px 世界坐标）。
 * 只在绘制/顶点编辑时调用；200 省 × ~30 边 ≈ 6000 次投影，单次调用微秒级。
 */
function snapToEdge(world, threshold = SNAP_EDGE_THRESHOLD) {
  const terrain = baseMap.value?.terrain;
  if (!terrain || !terrain.length) return null;
  let best = null;
  for (const prov of terrain) {
    const pts = resolvePoints(prov);
    if (!pts || pts.length < 2) continue;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const r = projectOnSegment(world, pts[j], pts[i]);
      if (r.dist <= threshold && (!best || r.dist < best.dist)) {
        best = { x: r.x, y: r.y, dist: r.dist, provId: prov.id, t: r.t, edgeIndex: i };
      }
    }
  }
  return best;
}

function showSnapFeedback(text, ms = 1000) {
  snapFeedback.value = text;
  if (snapFeedbackTimer) { clearTimeout(snapFeedbackTimer); snapFeedbackTimer = null; }
  snapFeedbackTimer = setTimeout(() => {
    snapFeedbackTimer = null;
    snapFeedback.value = '';
  }, ms);
}

/** 输入点 → 吸附结果（优先级：省份边界 > 网格；Shift 同时禁用两者） */
function resolveSnapPoint(world, shiftKey) {
  if (!shiftKey && snapToEdgeEnabled.value) {
    const e = snapToEdge(world);
    if (e) return { x: e.x, y: e.y, kind: 'edge', snapped: true };
  }
  const g = snapToGrid(world, shiftKey);
  return { x: g.x, y: g.y, kind: g.snapped ? 'grid' : 'none', snapped: g.snapped };
}

// ══════════════════════════════════════
// 底图数据图层（P1-T1 地形 / P1-T2 温度降水 / 陆海底色）
// ══════════════════════════════════════
function hexToRgb(hex) {
  const h = hex.charAt(0) === '#' ? hex.slice(1) : hex;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const HYPSO_WATER_RGB = HYPSO_WATER.map(hexToRgb);
const HYPSO_LAND_RGB = HYPSO_LAND.map(hexToRgb);
const TEMP_RGB = TEMP_RAMP.map(hexToRgb);
const PREC_RGB = PREC_RAMP.map(hexToRgb);

function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }

/** 色带采样（线性插值，返回 [r,g,b]） */
function sampleRamp(rgbList, t) {
  const u = clamp01(t);
  if (u <= 0) return rgbList[0];
  if (u >= 1) return rgbList[rgbList.length - 1];
  const f = u * (rgbList.length - 1);
  const i = Math.floor(f);
  const k = f - i;
  const a = rgbList[i];
  const b = rgbList[i + 1] || a;
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** 网格单元 → 颜色（kind: landsea | height | temp | prec） */
function cellColor(kind, i, hm) {
  if (kind === 'landsea') {
    return hm.h[i] >= 20 ? LAND_BASE_COLOR : SEA_BASE_COLOR;
  }
  if (kind === 'temp') {
    return sampleRamp(TEMP_RGB, (hm.temp[i] + 40) / 60);   // 实测范围 -40…20 °C
  }
  if (kind === 'prec') {
    return sampleRamp(PREC_RGB, hm.prec[i] / 100);        // FMG 降水标尺 0…100
  }
  const h = hm.h[i];
  return h < 20
    ? sampleRamp(HYPSO_WATER_RGB, h / 19)
    : sampleRamp(HYPSO_LAND_RGB, (h - 20) / 80);
}

function fillPixelBlock(data, w, h, x0, y0, x1, y1, rgb) {
  let ix0 = Math.floor(x0), iy0 = Math.floor(y0);
  let ix1 = Math.ceil(x1), iy1 = Math.ceil(y1);
  if (ix0 < 0) ix0 = 0;
  if (iy0 < 0) iy0 = 0;
  if (ix1 > w) ix1 = w;
  if (iy1 > h) iy1 = h;
  const r = rgb[0] | 0, g = rgb[1] | 0, b = rgb[2] | 0;
  for (let y = iy0; y < iy1; y++) {
    let p = (y * w + ix0) * 4;
    for (let x = ix0; x < ix1; x++) {
      data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
      p += 4;
    }
  }
}

/**
 * 把网格数据预渲染为离屏图层（红线：大数据量必须预渲染，不逐帧重绘）。
 * 每个网格单元画一个 spacing × spacing 的方块——网格点在 spacing/2 内抖动，方块拼接即完整覆盖。
 */
function buildCellRaster(kind) {
  const hm = baseMap.value?.heightmap;
  const pts = hm?.grid?.points;
  if (!hm || !pts || !pts.length) return null;
  const values = kind === 'temp' ? hm.temp : kind === 'prec' ? hm.prec : hm.h;
  if (!values || !values.length) return null;

  const spacing = hm.grid.spacing || 14.4;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const x = pts[i][0], y = pts[i][1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const pad = spacing;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const w = Math.max(1, Math.ceil(maxX - minX));
  const h = Math.max(1, Math.ceil(maxY - minY));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const rc = canvas.getContext('2d');
  const img = rc.createImageData(w, h);
  const data = img.data;
  const half = spacing / 2;

  for (let i = 0; i < pts.length && i < values.length; i++) {
    const rgb = cellColor(kind, i, hm);
    const cx = pts[i][0] - minX;
    const cy = pts[i][1] - minY;
    fillPixelBlock(data, w, h, cx - half, cy - half, cx + half, cy + half, rgb);
  }
  rc.putImageData(img, 0, 0);
  return { canvas, minX, minY, w, h };
}

function getRaster(kind) {
  const key = baseMapKey.value + '|' + kind;
  const hit = rasterCache.get(key);
  if (hit) return hit;
  const built = buildCellRaster(kind);
  if (built) rasterCache.set(key, built);
  return built;
}

function drawRasterLayer(c, kind, alpha) {
  const r = getRaster(kind);
  if (!r) return;
  c.save();
  c.globalAlpha = alpha;
  c.imageSmoothingEnabled = false;
  c.drawImage(r.canvas, r.minX, r.minY, r.w, r.h);
  c.restore();
}

// ══════════════════════════════════════
// 河流 / 道路图层（P1-T3）
// ══════════════════════════════════════
/** 折线是否与当前视口相交（含 pad） */
function polylineInView(pts, minX, minY, maxX, maxY) {
  for (let i = 0; i < pts.length; i++) {
    const x = vx(pts[i]), y = vy(pts[i]);
    if (x >= minX && x <= maxX && y >= minY && y <= maxY) return true;
  }
  return false;
}

function drawRivers(c) {
  const list = baseMap.value?.rivers;
  if (!list || !list.length) return;
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(canvas.value.width, canvas.value.height);
  const pad = 40 / cameraScale.value;
  const minX = tl.x - pad, maxX = br.x + pad, minY = tl.y - pad, maxY = br.y + pad;

  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.strokeStyle = '#5d97bb';
  for (const r of list) {
    const pts = r.points;
    if (!pts || pts.length < 2) continue;
    if (!polylineInView(pts, minX, minY, maxX, maxY)) continue;
    // 线宽走世界坐标（随缩放变粗），并用 discharge 做量级区分
    const scaleW = r.discharge ? Math.sqrt(Math.max(r.discharge, 1)) / 14 : 1;
    c.lineWidth = Math.max(0.7, Math.min(4, (r.width || 0.2) * 6 * Math.max(scaleW, 0.6)));
    c.beginPath();
    c.moveTo(vx(pts[0]), vy(pts[0]));
    for (let i = 1; i < pts.length; i++) c.lineTo(vx(pts[i]), vy(pts[i]));
    c.stroke();
  }
  c.restore();
}

/** 配色/样式对齐 Azgaar FMG 默认：道路棕色实线、小径棕色虚线、海路白色虚线 */
const ROUTE_STYLES = {
  roads: { color: '#d06324', width: 0.9, dash: null, alpha: 0.95 },
  trails: { color: '#d06324', width: 0.5, dash: [2, 3], alpha: 0.85 },
  searoutes: { color: '#ffffff', width: 0.5, dash: [1.5, 3], alpha: 0.5 },
};

function drawRoutes(c) {
  const list = baseMap.value?.routes;
  if (!list || !list.length) return;
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(canvas.value.width, canvas.value.height);
  const pad = 40 / cameraScale.value;
  const minX = tl.x - pad, maxX = br.x + pad, minY = tl.y - pad, maxY = br.y + pad;

  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  for (const r of list) {
    const pts = r.points;
    if (!pts || pts.length < 2) continue;
    if (!polylineInView(pts, minX, minY, maxX, maxY)) continue;
    // 优先使用道路自带样式（P1-T3），回退到 group 默认
    const st = r.color ? { color: r.color, width: r.width || 1, dash: r.dash || null, alpha: 0.95 } : ROUTE_STYLES[r.group] || ROUTE_STYLES.roads;
    c.globalAlpha = st.alpha;
    c.strokeStyle = st.color;
    c.lineWidth = st.width;
    c.setLineDash(st.dash || []);
    c.beginPath();
    c.moveTo(vx(pts[0]), vy(pts[0]));
    for (let i = 1; i < pts.length; i++) c.lineTo(vx(pts[i]), vy(pts[i]));
    c.stroke();
  }
  c.setLineDash([]);
  c.restore();
}

function drawRiverPaths(c) {
  if (!riverPaths.value.length) return;
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(canvas.value.width, canvas.value.height);
  const pad = 40 / cameraScale.value;
  const minX = tl.x - pad, maxX = br.x + pad, minY = tl.y - pad, maxY = br.y + pad;
  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.strokeStyle = '#5d97bb';
  for (const path of riverPaths.value) {
    if (path.length < 2) continue;
    c.lineWidth = Math.max(1, 2 / cameraScale.value);
    c.beginPath();
    c.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) c.lineTo(path[i].x, path[i].y);
    c.stroke();
  }
  c.restore();
}

// ══════════════════════════════════════
// 文化/宗教图例（P1-T5，屏幕坐标系右下角）
// ══════════════════════════════════════
function drawCultureLegend(c) {
  const hm = baseMap.value?.heightmap;
  const src = colorMode.value === 'culture' ? hm?.cultures : hm?.religions;
  if (!src || !src.length) return;
  const rows = src.filter(x => x && x.i > 0 && x.color);
  if (!rows.length) return;

  const rowH = 15;
  const shown = rows.slice(0, 22);
  c.font = '11px "PingFang SC", sans-serif';
  let maxW = 40;
  for (const r of shown) maxW = Math.max(maxW, c.measureText(r.name || '').width);
  const boxW = Math.min(250, maxW + 34);
  const boxH = shown.length * rowH + 12;
  const bx = canvas.value.width - boxW - 12;
  const by = canvas.value.height - boxH - 12;

  c.save();
  c.fillStyle = 'rgba(15,26,46,0.86)';
  c.strokeStyle = 'rgba(148,163,184,0.5)';
  c.lineWidth = 1;
  c.beginPath();
  if (typeof c.roundRect === 'function') c.roundRect(bx, by, boxW, boxH, 6);
  else c.rect(bx, by, boxW, boxH);
  c.fill();
  c.stroke();
  for (let i = 0; i < shown.length; i++) {
    const y = by + 6 + i * rowH;
    c.fillStyle = shown[i].color;
    c.fillRect(bx + 8, y + 3, 10, 10);
    c.fillStyle = '#cbd5e1';
    c.fillText(shown[i].name || '', bx + 24, y + 12);
  }
  c.restore();
}

/** 当前底图可用的数据图层清单（状态栏显示） */
const layerAvailability = computed(() => {
  const hm = baseMap.value?.heightmap;
  return {
    cells: hm?.grid?.points?.length || 0,
    temp: (hm?.temp?.length || 0) > 0,
    prec: (hm?.prec?.length || 0) > 0,
    rivers: (baseMap.value?.rivers?.length || 0),
    routes: (baseMap.value?.routes?.length || 0),
    cultures: (hm?.cultures?.length || 0),
    religions: (hm?.religions?.length || 0),
  };
});

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

  // 底图数据图层：陆海底色铺底（补足省份多边形之外的海岸缝隙）
  if (rasterLayer.value === 'landsea') drawRasterLayer(ctx.value, 'landsea', 1);

  if (showBiomes.value) drawBiomeBackground(ctx.value);
  drawProvinces(ctx.value);

  // 地形/温度/降水：半透明叠加在省份之上（验收：alpha ≈ 0.4，不影响点击选中）
  if (rasterLayer.value === 'height') drawRasterLayer(ctx.value, 'height', 0.45);
  else if (rasterLayer.value === 'temp') drawRasterLayer(ctx.value, 'temp', 0.5);
  else if (rasterLayer.value === 'prec') drawRasterLayer(ctx.value, 'prec', 0.5);

  if (showRoutes.value) drawRoutes(ctx.value);
  if (showRivers.value) drawRivers(ctx.value);
  drawRiverPaths(ctx.value);

  // v2: 自动生成的河流
  if (autoRivers.value.length > 0 && showRivers.value) {
    ctx.save();
    ctx.strokeStyle = '#5d97bb';
    ctx.lineWidth = 1 / cameraScale.value;
    for (const river of autoRivers.value) {
      if (river.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(river[0].x, river[0].y);
      for (let i = 1; i < river.length; i++) {
        ctx.lineTo(river[i].x, river[i].y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
  if (showBorders.value) drawProvinceBorders(ctx.value);
  drawVertexHandles(ctx.value);
  if (showBurgs.value) drawBurgs(ctx.value);
  drawPreviewOverlay(ctx.value);
  if (showLabels.value) drawLabels(ctx.value);
  drawReliefIcons(ctx.value);
  drawScenarioMarkers(ctx.value);

  ctx.value.restore();

  // 以下浮层画在屏幕坐标系：字号与命中不受缩放影响
  drawBurgTooltip(ctx.value);
  drawCultureLegend(ctx.value);
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
    const points = resolvePoints(prov);
    if (!points || points.length < 3) return;
    c.fillStyle = getProvinceColor(prov);
    c.beginPath();
    // P0-T1：有控制点时走贝塞尔曲线；Alt 时退化直线
    traceShapePath(c, points, true);
    c.closePath();
    c.fill();
  });
}

function drawProvinceBorders(c) {
  if (!baseMap.value?.terrain) return;
  baseMap.value.terrain.forEach(prov => {
    const isSelected = selectedProvince.value?.id === prov.id;
    const isMergeTarget = mergeProvId.value === prov.id;
    const points = resolvePoints(prov);
    if (!points || points.length < 3) return;
    c.strokeStyle = isMergeTarget ? '#ffd700' : (isSelected ? '#ffffff' : 'rgba(141,138,130,0.6)');
    c.lineWidth = isSelected ? 1.5 / cameraScale.value : 0.6 / cameraScale.value;
    c.beginPath();
    traceShapePath(c, points, true);
    c.closePath();
    c.stroke();
  });
}

function drawVertexHandles(c) {
  if (!vertexEditMode.value || !selectedProvince.value) return;
  const prov = currentProvince();
  const points = prov ? resolvePoints(prov) : null;
  if (!points) return;
  const r = 4 / cameraScale.value;
  const hR = 3.5 / cameraScale.value;
  const active = activeVertexIdx.value;

  // P0-T1：仅对当前选中顶点画切线手柄（大省份全画会遮满屏幕）
  if (active >= 0 && active < points.length && !altStraight) {
    const p = points[active];
    const cx = vx(p), cy = vy(p);
    const out = p.controlOut;
    const inn = p.controlIn;
    if (out || inn) {
      c.save();
      c.setLineDash([3 / cameraScale.value, 3 / cameraScale.value]);
      c.strokeStyle = 'rgba(167,139,250,0.8)';
      c.lineWidth = 1 / cameraScale.value;
      if (out) { c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + out.x, cy + out.y); c.stroke(); }
      if (inn) { c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + inn.x, cy + inn.y); c.stroke(); }
      c.setLineDash([]);
      c.fillStyle = '#38bdf8';
      c.strokeStyle = '#ffffff';
      if (out) { c.beginPath(); c.arc(cx + out.x, cy + out.y, hR, 0, Math.PI * 2); c.fill(); c.stroke(); }
      if (inn) { c.beginPath(); c.arc(cx + inn.x, cy + inn.y, hR, 0, Math.PI * 2); c.fill(); c.stroke(); }
      c.restore();
    }
  }

  points.forEach((p, i) => {
    const px = vx(p);
    const py = vy(p);
    c.fillStyle = draggingVertex.value?.vertexIdx === i ? '#ffd700' : (i === active ? '#f472b6' : '#a78bfa');
    c.strokeStyle = '#fff';
    c.lineWidth = 1 / cameraScale.value;
    c.beginPath();
    c.arc(px, py, r, 0, Math.PI * 2);
    c.fill();
    c.stroke();
  });
}

function getProvinceColor(prov) {
  // P1-T5：文化/宗教着色（颜色取自 .map 的 cultures/religions 定义，归属来自 province → burg → culture）
  if (colorMode.value === 'culture' && prov.cultureColor) return prov.cultureColor;
  if (colorMode.value === 'religion' && prov.religionColor) return prov.religionColor;

  // 剧本模式：优先势力归属色
  if (viewMode.value === 'scenario' && selectedScenario.value) {
    const owner = selectedScenario.value.ownership?.[prov.id];
    if (owner) {
      const polity = selectedScenario.value.polities?.find(p => p.id === owner);
      if (polity?.color) return polity.color;
    }
  }

  // 生物群系图层开启时按群系染色
  if (showBiomes.value && prov.biome && BIOME_COLORS[prov.biome]) return BIOME_COLORS[prov.biome];

  if (viewMode.value === 'scenario' && selectedScenario.value) return '#4a5568';
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

  // 吸附标记（P0-T3 网格绿十字 / P0-T2 边界青环）
  if (snapMarker.value) {
    const mx = snapMarker.value.x;
    const my = snapMarker.value.y;
    const isEdge = snapMarker.value.kind === 'edge';
    const arm = 7 / cameraScale.value;
    c.strokeStyle = isEdge ? '#22d3ee' : '#34d399';
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
    if (isEdge) {
      c.beginPath();
      c.arc(mx, my, 6 / cameraScale.value, 0, Math.PI * 2);
      c.stroke();
    }
  }

  // 笔刷预览（hover 时显示）
  if (brushPreview.value && ['height', 'biome', 'culture', 'religion'].includes(tool.value)) {
    const bp = brushPreview.value;
    c.beginPath();
    c.arc(bp.x, bp.y, bp.radius, 0, Math.PI * 2);
    let color = 'rgba(74, 158, 255, 0.8)';
    if (tool.value === 'biome') color = 'rgba(255, 107, 107, 0.8)';
    else if (tool.value === 'culture') color = 'rgba(255, 215, 0, 0.8)';
    else if (tool.value === 'religion') color = 'rgba(167, 139, 250, 0.8)';
    c.strokeStyle = color;
    c.lineWidth = 2 / cameraScale.value;
    c.setLineDash([5 / cameraScale.value, 5 / cameraScale.value]);
    c.stroke();
    c.setLineDash([]);
    c.fillStyle = color.replace('0.8', '0.1');
    c.fill();
  }

  // 道路预览
  if (tool.value === 'road' && roadPath.value.length >= 2) {
    c.strokeStyle = '#ffd700';
    c.lineWidth = 2 / cameraScale.value;
    c.setLineDash([4 / cameraScale.value, 4 / cameraScale.value]);
    c.beginPath();
    c.moveTo(roadPath.value[0].x, roadPath.value[0].y);
    for (let i = 1; i < roadPath.value.length; i++) {
      c.lineTo(roadPath.value[i].x, roadPath.value[i].y);
    }
    c.stroke();
    c.setLineDash([]);
    // 起终点标记
    c.fillStyle = '#ffd700';
    c.beginPath();
    c.arc(roadPath.value[0].x, roadPath.value[0].y, 4 / cameraScale.value, 0, Math.PI * 2);
    c.fill();
    c.beginPath();
    c.arc(roadPath.value[roadPath.value.length - 1].x, roadPath.value[roadPath.value.length - 1].y, 4 / cameraScale.value, 0, Math.PI * 2);
    c.fill();
  }

  if (tool.value === 'split' && splitStep.value === 1 && splitPoints.value.length === 1) {
    c.fillStyle = '#fbbf24';
    c.beginPath();
    c.arc(splitPoints.value[0].x, splitPoints.value[0].y, 5 / cameraScale.value, 0, Math.PI * 2);
    c.fill();
  }

  // 河流编辑器预览（P1-T2）
  if (tool.value === 'river' && riverDraft.value.length > 0) {
    c.strokeStyle = '#5d97bb';
    c.lineWidth = 2 / cameraScale.value;
    c.setLineDash([4 / cameraScale.value, 4 / cameraScale.value]);
    c.beginPath();
    c.moveTo(riverDraft.value[0].x, riverDraft.value[0].y);
    for (let i = 1; i < riverDraft.value.length; i++) {
      c.lineTo(riverDraft.value[i].x, riverDraft.value[i].y);
    }
    c.stroke();
    c.setLineDash([]);
    for (const p of riverDraft.value) {
      c.fillStyle = '#5d97bb';
      c.beginPath();
      c.arc(p.x, p.y, 3 / cameraScale.value, 0, Math.PI * 2);
      c.fill();
    }
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
    c.font = label.font || `${label.size || 12}px "PingFang SC", sans-serif`;
    c.fillStyle = label.color || '#e2e8f0';
    // 描边（提升可读性，Wonderdraft 风格）
    if (label.stroke && label.strokeWidth > 0) {
      c.strokeStyle = label.stroke;
      c.lineWidth = label.strokeWidth;
      c.lineJoin = 'round';
      c.strokeText(label.text, label.x, label.y);
    }
    c.fillText(label.text, label.x, label.y);
  });
}

function drawReliefIcons(c) {
  if (!reliefIcons.value.length) return;
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(canvas.value.width, canvas.value.height);
  const pad = 30 / cameraScale.value;
  const minX = tl.x - pad, maxX = br.x + pad, minY = tl.y - pad, maxY = br.y + pad;
  const fontSize = Math.max(12, 16 / cameraScale.value);
  c.font = `${fontSize}px "PingFang SC", sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  for (const r of reliefIcons.value) {
    if (r.x < minX || r.x > maxX || r.y < minY || r.y > maxY) continue;
    c.fillText(r.icon, r.x, r.y);
  }
  c.textAlign = 'start';
  c.textBaseline = 'alphabetic';
}

function drawScenarioMarkers(c) {
  if (viewMode.value !== 'scenario' || !selectedScenario.value?.markers?.length) return;
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(canvas.value.width, canvas.value.height);
  const pad = 30 / cameraScale.value;
  const minX = tl.x - pad, maxX = br.x + pad, minY = tl.y - pad, maxY = br.y + pad;
  const fontSize = Math.max(12, 14 / cameraScale.value);
  c.font = `${fontSize}px "PingFang SC", sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  for (const m of selectedScenario.value.markers) {
    if (m.x < minX || m.x > maxX || m.y < minY || m.y > maxY) continue;
    // 图标
    c.fillText(m.icon || '📍', m.x, m.y);
    // 名称标签
    c.font = `${Math.max(10, 11 / cameraScale.value)}px "PingFang SC", sans-serif`;
    c.fillStyle = m.color || '#e2e8f0';
    c.fillText(m.name, m.x, m.y + fontSize * 0.8);
  }
  c.textAlign = 'start';
  c.textBaseline = 'alphabetic';
}

function handleResize() {
  if (!canvas.value || !canvasWrap.value) return;
  canvas.value.width = canvasWrap.value.clientWidth;
  canvas.value.height = canvasWrap.value.clientHeight;
  render();
}

// ═══════════════════════════════════════════
// v2 智能放置与派生
// ═══════════════════════════════════════════

function placeSmartBurg(world) {
  const baseMapData = baseMap.value;
  if (!baseMapData?.heightmap?.grid?.points) return;
  const hm = baseMapData.heightmap;
  const pts = hm.grid.points;
  const spacing = hm.grid.spacing || 14.4;
  const searchRadius = 100;
  let bestI = -1;
  let bestScore = -Infinity;

  for (let i = 0; i < pts.length; i++) {
    const h = hm.h[i];
    if (h < 20 || h > 70) continue;
    const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
    const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
    const clickDist = Math.hypot(px - world.x, py - world.y);
    if (clickDist > searchRadius) continue;

    let score = -Math.abs(h - 40) * 0.1 - clickDist * 0.05;
    // 靠近已有 burg 则减分（避免堆叠）
    for (const b of burgs.value) {
      const bd = Math.hypot(b.x - px, b.y - py);
      if (bd < spacing * 3) score -= 10;
    }

    if (score > bestScore) {
      bestScore = score;
      bestI = i;
    }
  }

  if (bestI >= 0) {
    const px = Array.isArray(pts[bestI]) ? pts[bestI][0] : pts[bestI].x;
    const py = Array.isArray(pts[bestI]) ? pts[bestI][1] : pts[bestI].y;
    const burgId = `burg_${Date.now()}`;
    if (!baseMapData.burgs) {
      baseMapData.burgs = [];
    }
    const newBurg = { id: burgId, name: `新聚落 ${baseMapData.burgs.length + 1}`, x: px, y: py, capital: 0, population: 5 };
    store.addBaseMapBurg(baseMapKey.value, newBurg);
  }
}

function generateAndShowRivers() {
  const rivers = store.generateRivers(baseMapKey.value);
  autoRivers.value = rivers;
  render();
}

function deriveLayers() {
  store.deriveAllLayers(baseMapKey.value);
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
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('click', () => { contextMenu.value.show = false; });
  window.addEventListener('sitian:history-jump', onHistoryJump);

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
  window.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('sitian:history-jump', onHistoryJump);
  if (snapMarkerTimer) { clearTimeout(snapMarkerTimer); snapMarkerTimer = null; }
  if (snapFeedbackTimer) { clearTimeout(snapFeedbackTimer); snapFeedbackTimer = null; }
  rasterCache.clear();
});

function onHistoryJump() {
  // 撤销/重做后重新对齐选中引用（updateBaseProvince 会生成新对象）
  const sp = selectedProvince.value;
  if (sp) {
    const fresh = baseMap.value?.terrain?.find(p => p.id === sp.id);
    if (fresh && fresh !== sp) selectedProvince.value = fresh;
  }
  render();
}
watch([rasterLayer, showRivers, showRoutes, colorMode, showBiomes, showBorders, showLabels], () => render());

// 切换底图 → 作废离屏栅格缓存（不同地图的网格数据不同）
watch(baseMapKey, () => {
  rasterCache.clear();
  render();
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

/* 笔刷设置 */
.brush-settings {
  gap: 8px;
}
.brush-settings .check-label {
  gap: 4px;
}
.brush-slider {
  width: 80px;
  vertical-align: middle;
}
.brush-biome-select {
  background: #334155;
  color: #e2e8f0;
  border: 1px solid #475569;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 11px;
  vertical-align: middle;
}

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
.snap-feedback { color: #34d399; font-weight: 600; }
.snap-feedback.edge { color: #22d3ee; }
.layer-warn { color: #fbbf24; cursor: help; }
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

/* 图层锁定面板 */
.layer-lock-panel {
  position: absolute;
  top: 100px;
  right: 16px;
  width: 200px;
  background: #1e293b;
  border: 1px solid #475569;
  border-radius: 12px;
  padding: 12px;
  z-index: 100;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}

.layer-lock-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #e2e8f0;
}

.layer-lock-close {
  background: none;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  padding: 4px;
}

.layer-lock-close:hover { color: #e2e8f0; }

.layer-lock-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.layer-lock-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 6px;
  border-radius: 4px;
}

.layer-lock-row:hover { background: #334155; }

.layer-lock-label {
  font-size: 12px;
  color: #cbd5e1;
}

.layer-lock-btn {
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px;
  opacity: 0.5;
  color: #94a3b8;
}

.layer-lock-btn:hover { opacity: 1; }

.layer-lock-btn.locked {
  opacity: 1;
  color: #fbbf24;
}

/* 撤销历史面板（覆盖 HistoryPanel 默认定位） */
.history-panel {
  top: 100px !important;
  left: 12px !important;
}
</style>
