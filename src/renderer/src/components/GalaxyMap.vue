<template>
  <div class="galaxy-map-container">
    <div class="map-header">
      <div class="header-left">
        <div class="header-title-row">
          <button class="back-btn" @click="$emit('back')" title="返回世界选择">← 返回</button>
          <h2>{{ world?.name }} — 星域总览</h2>
        </div>
        <p class="hint">
          <span v-if="!editMode">点击恒星进入 · 滚动缩放 · 拖拽空白处平移 · <b>“移动”工具下拖拽恒星或星域编辑坐标</b>（默认拖手模式防误触）</span>
          <span v-else class="edit-hint">编辑模式：拖拽恒星间创建航道 · 右键航道删除 · 拖拽边界顶点编辑势力范围 · 点击空白取消</span>
        </p>
      </div>
      <div class="header-actions">
        <!-- 浏览态的两种拖拽语义（与 SystemView 同一形态）：默认拖手防误触，“移动”才改坐标。
             这条 UI 以前根本不存在，而提示文案却写着"拖拽恒星编辑坐标"（骗人，见 §bug1）。 -->
        <template v-if="!editMode">
          <button
            :class="{ active: interactionMode === 'pan' }"
            @click="interactionMode = 'pan'"
            title="拖手模式：拖拽空白处平移，恒星只选中不移动（防误触）"
          ><Icon name="hand" :size="14"/> 拖手</button>
          <button
            :class="{ active: interactionMode === 'move' }"
            @click="interactionMode = 'move'"
            title="移动模式：拖拽恒星或星域调整坐标（位置会持久化；星域的恒星跟着走）"
            data-testid="galaxy-move-tool"
          ><Icon name="move" :size="14"/> 移动</button>
        </template>
        <select 
          v-if="editMode"
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
        ><Icon name="filter" :size="14"/> 筛选</button>
        <button 
          :class="{ active: editMode }" 
          @click="toggleEditMode"
        >
          <template v-if="editMode"><Icon name="check" :size="14"/> 完成编辑</template><template v-else><Icon name="pencil" :size="14"/> 编辑地图</template>
        </button>
        <button 
          v-if="editMode"
          @click="createGalaxy"
          title="在当前视图中心创建恒星"
        >＋ 恒星</button>
        <!-- 生成示例星系（2026-11-02）：原型 SP-1025 的 generator/topology/metrics 整包用起来 ——
             一次 undo 造出 N 星域 / M 恒星 / kNN 航道。给"想看银河该长什么样"和"要一份能改的样例"用。 -->
        <button
          data-testid="gen-sample-galaxy"
          :disabled="store.isReadOnly"
          :title="store.isReadOnly ? (store.readOnlyReason || '只读：未打开项目') : '按原型生成器造一份示例星系（4 星域 / 120 恒星 / 航道网；一次 Ctrl+Z 可整体撤回）'"
          @click="generateSample"
        ><Icon name="sparkles" :size="14"/> 示例星系</button>
      </div>
    </div>

    <!-- 右键菜单 → U3 统一框架（ContextMenu 组件挂在 canvas-wrapper 内） -->

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
    
    <!-- 势力图例：色板改的是**星域自己的颜色**（落库到节点 factionColor），
         所以键必须是 domain.id —— 老实现用 `domain.faction` 当键，真实库该值是 undefined，
         于是所有星域共用一个键“undefined”：改一个色 = 改全部（见 §bug2）。 -->
    <div class="faction-legend">
      <span 
        v-for="domain in domains" 
        :key="domain.id"
        class="legend-item"
        :style="{ '--faction-color': resolveDomainColor(domain) }"
      >
        <input 
          type="color" 
          class="legend-color-picker"
          :value="toHex6(resolveDomainColor(domain)) || '#6b5b95'"
          @input="previewFactionColor(domain, $event.target.value)"
          @change="commitFactionColor(domain, $event.target.value)"
          @click.stop
          title="点击修改势力颜色"
        />
        <span class="legend-dot"></span>
        <!-- 势力名 = `faction` 字段的**唯一写入入口**（§faction 写入路径）。
             它决定图例/画布/边界的默认配色（`getFactionColor` 按名字推色）：真实库原先**没有任何写入口**
             → 所有星域都落在同一个默认色 #6b5b95，"势力区分"能力为零。 -->
        <input
          type="text"
          class="legend-faction-input"
          :value="domain.faction || ''"
          placeholder="势力名"
          title="所属势力（决定默认配色；留空 = 未归属）"
          @change="commitFaction(domain, $event.target.value)"
          @click.stop
        />
        {{ domain.name }}
      </span>
    </div>
    
    <div class="canvas-wrapper">
      <canvas ref="canvas"></canvas>
      <transition name="skeleton-fade"><canvas-skeleton v-if="!skeletonReady" /></transition>
      <eagle-eye
        :view-bounds="galaxyViewBounds"
        :elements="galaxyEyeElements"
        :world-bounds="galaxyWorldBounds"
        @navigate="handleGalaxyEagleNavigate"
      />
      <zoom-controls :renderer="renderer" :on-fit-all="fitAllGalaxy" />
      <context-menu :state="ctxMenu.state" @close="closeCtxMenu" />
    </div>
  </div>
</template>

<script setup>
import Icon from './Icon.vue';
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useGeodataStore } from '../store/geodata';
import { useLayersStore } from '../store/layers';
// 叙事状态淡化（2026-09-24）：已毁灭/荒废/封印/失联的实体在画布上降视觉权重
import { fadedAlpha } from '../utils/entityStatus';
import { withAlpha, toHex6 } from '../utils/colorUtil';
// 布局 / 凸包 / 配色 / 航道色：与“导出 PNG(全图)”**共用同一份实现**
// （§bug 导出与画布不同源：这些原先在 App.vue 里各有一份，两边结果不一致且不报错）
import {
  getFactionColor, resolveDomainColor as resolveDomainColorShared,
  layoutDomains, layoutGalaxies, factionBorders, hyperlaneColor, sparsifyHyperlanes,
} from '../utils/galaxyLayout';
// 星系绘制美术（**吸收自 SP-1025 原型**，2026-11-01）：背景资产 / 恒星色温与归属环 / LOD 标签。
// 🔴 这三件同时被“导出 PNG(全图)”（App.vue）调用 —— 同一份实现，不许各画一套。
import { paintGalaxySky, GALAXY_SKY_RECT } from '../galaxy/sky';
import { paintDomainBorders } from '../galaxy/domainPaint';
import { distanceToLoop } from '../galaxy/territory';
import { paintStar } from '../galaxy/starArt';
import { collectStarLabels, cullStarLabels, paintStarLabels, labelLodFor } from '../galaxy/labels';
import { useCanvasRenderer } from '../composables/useCanvasRenderer';
import { useContextMenu } from '../composables/useContextMenu';
import { showStatusBar, hideStatusBar, setStatusThrottled, setStatus } from '../composables/useStatusBar';
import { useTheme } from '../composables/useTheme';
import CanvasSkeleton from './CanvasSkeleton.vue';
import EagleEye from './EagleEye.vue';
import ZoomControls from './ZoomControls.vue';
import ContextMenu from './ContextMenu.vue';

const props = defineProps({
  world: { type: Object, default: null },
  domains: { type: Array, default: () => [] },
  galaxies: { type: Array, default: () => [] }
});

const emit = defineEmits(['select', 'enter-system', 'back', 'dirty', 'select-node']);

const store = useGeodataStore();
const layers = useLayersStore();
// 星域色块的浓度按主题分档（深底要更亮才看得出领土，浅底要更淡才不糊）
const { currentTheme } = useTheme();

const canvas = ref(null);
// U4: 骨架屏显隐——首帧渲染后淡出
const skeletonReady = ref(false);
let domainNodes = [];
const galaxyNodes = ref([]);
const selectedNodeIds = ref(new Set());
// U3: 右键菜单迁移到统一框架；ctxTarget 保存命中对象供菜单动作读取
const ctxMenu = useContextMenu();
const ctxTarget = ref(null);

function closeCtxMenu() {
  ctxMenu.close();
  ctxTarget.value = null;
}

// ===== 右键菜单 =====
function worldToScreen(wx, wy) {
  const vt = renderer.getViewTransform();
  const cvs = canvas.value;
  return {
    x: wx * vt.scale + vt.x + cvs.clientWidth / 2,
    y: wy * vt.scale + vt.y + cvs.clientHeight / 2,
  };
}

function openContextMenu(wx, wy, target) {
  ctxTarget.value = target;
  const items = [];
  if (!target || target.type === 'galaxy') {
    items.push({ key: 'create-galaxy', label: '在此创建恒星', icon: 'plus', action: () => ctxCreateGalaxyHere(wx, wy) });
  }
  if (target?.type === 'galaxy' || target?.type === 'domain') {
    items.push({ key: 'delete-node', label: '删除该节点', icon: 'trash', danger: true, action: ctxDeleteNode });
  }
  if (target?.type === 'hyperlane') {
    items.push({ key: 'delete-cp', label: '删除控制点', icon: 'scissors', action: ctxDeleteControlPoint });
    items.push({ key: 'delete-lane', label: '删除航道', icon: 'trash', danger: true, action: ctxDeleteHyperlane });
  }
  const pos = worldToScreen(wx, wy);
  ctxMenu.open(items, pos, canvas.value?.parentElement);
}

function ctxCreateGalaxyHere(wx, wy) {
  createGalaxyAt(wx, wy);
  closeCtxMenu();
}

function ctxDeleteNode() {
  const node = ctxTarget.value?.node;
  if (node) {
    store.removeNode(node.id);
    galaxyNodes.value = galaxyNodes.value.filter(g => g.id !== node.id);
    if (selectedNodeIds.value.has(node.id)) selectedNodeIds.value.delete(node.id);
    emit('dirty', true);
    renderer.requestRender();
  }
  closeCtxMenu();
}

function ctxDeleteHyperlane() {
  const hl = ctxTarget.value?.hyperlane;
  if (hl) {
    store.removeHyperlane(hl.id);
    emit('dirty', true);
    renderer.requestRender();
  }
  closeCtxMenu();
}

function ctxDeleteControlPoint() {
  const hl = ctxTarget.value?.hyperlane;
  const cpIndex = ctxTarget.value?.controlPointIndex;
  if (hl && cpIndex !== undefined && hl.controlPoints && hl.controlPoints.length > 0) {
    hl.controlPoints.splice(cpIndex, 1);
    store.updateHyperlane(hl.id, { controlPoints: hl.controlPoints });
    emit('dirty', true);
    renderer.requestRender();
  }
  closeCtxMenu();
}

// U2: 适配全部 — 以恒星+星域节点集合 bbox 适屏
function fitAllGalaxy() {
  const all = [...galaxyNodes.value, ...domainNodes];
  if (!all.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of all) {
    if (typeof n.x !== 'number' || typeof n.y !== 'number') continue;
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y);
  }
  if (minX === Infinity) return;
  renderer.fitView({ minX, minY, maxX, maxY });
}

// ===== 框选状态 =====
let isBoxSelecting = false;
let boxSelectStart = { x: 0, y: 0 };
let boxSelectEnd = { x: 0, y: 0 };
let isDraggingMultiple = false;
let dragMultipleStart = { x: 0, y: 0 };
// 正在被拖动的星域 id（拖动期让布局认它的实时坐标 —— 见 applyStableLayout 的注释）
let draggingDomainId = null;

// ===== 航道编辑状态 =====
const editMode = ref(false);
// 浏览态的拖拽语义：'pan'（默认，防误触）/ 'move'（拖恒星改坐标）。
// 与 SystemView / SystemDetailView 同一套语义（那两处早就有，只有这里漏了 ——
// 而提示文案却一直写着"拖拽恒星编辑坐标"，属"文案承诺了不存在的能力"）。
const interactionMode = ref('pan');
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
// ⚠️ `getBorderPoints`（读覆盖点）已删：读取现在由 `utils/galaxyLayout.js#factionBorders` 统一做
//    （`overrides` 传进去），组件里再留一个读口就是第二份口径。

/**
 * 提交边界覆盖点 —— **必须走 store 的唯一写口**（§2026-10-18 第十一修）。
 *
 * 旧写法是 `store.domainBorderOverrides[domainId] = points`（组件直接改 store 的 ref）：
 * 没有闸门、没有 undo —— 只读态拖顶点会**静默改内存**（看着生效，保存时才被拒），而且撤不回来。
 * 现在 `setDomainBorderPoints` 里有 `guardWrite` + `execute`（一条 undo），被拒时返回 null。
 * @param {boolean} [preview] 拖动期的起始快照（过闸门但不进 undo 栈，见 store 里该函数的注释）
 * @returns {boolean} 是否真的写入（false = 被拒/参数非法）
 */
function setBorderPoints(domainId, points, preview) {
  const r = store.setDomainBorderPoints(domainId, points, preview ? { preview: true } : undefined);
  if (!r) {
    setStatus('编辑势力边界被拒：当前是只读态（打开项目后可编辑）', 'warn');
    return false;
  }
  return true;
}

// ===== 势力边界编辑状态 =====
const editingBoundary = ref(null);
const hoveredBoundaryVertex = ref(null);

// ===== 时间 =====
let animationTime = 0;

// ===== 势力颜色 =====
// ⚠️ `FACTION_COLORS` / `getFactionColor` 现在只有一份实现（`utils/galaxyLayout.js`），
//    import 在上面 —— 本组件与“导出 PNG(全图)”共用它（原先两处各有一份同形表）。

/**
 * **星域当前颜色的唯一解析口**（图例 / 布局 / 边界 / 鹰眼 / 导出五处共用）。
 * 优先级：① 本组件内的即时预览覆盖（按 **domain.id** 存，见 §bug2 的“undefined 共用键”）
 *        ② 节点自己持久化的 `factionColor`（用户改过色 → 落库 → 重开还在）
 *        ③ 按势力名推的默认色（`FACTION_COLORS` 表 → 名字哈希 hsl）
 *
 * ⚠️ `factionColorOverrides` 是**运行期预览**，不是真相：真相在节点上（`store.updateNode`）。
 *    它存在的唯一理由是 `input` 事件连续触发时别把 undo 栈刷爆（落库在 `change` 时做一次）。
 */
function resolveDomainColor(domain) {
  return resolveDomainColorShared(domain, factionColorOverrides.value);
}

/** 预览（`input` 事件，频繁）：只改内存 + 重排 + 重绘，**不落库、不进 undo** */
function previewFactionColor(domain, color) {
  if (!domain) return;
  factionColorOverrides.value[domain.id] = color;
  // ⚠️ 这两句缺一不可，各有判据守：
  //    · `applyStableLayout()` —— 渲染恒星读的是布局期副本（只重绘会让"画布变了、颜色还是旧的"）；
  //    · `requestRender()` —— 不重绘就是"拖了色板没反应"。
  //    （反向验证实测：抽掉任一句，`test_116` f2 的对应断言各自红。）
  applyStableLayout();
  renderer.requestRender();
}

/**
 * 落库（`change` 事件，用户松开色板时一次）：走 `store.updateNode`（有 `guardWrite` + 一条 undo），
 * 把 `factionColor` 写进节点 → 由 `entityExtras()` 原样带进项目文件（不必动 schema）。
 *
 * 🔴 为什么必须落库：老实现只写组件局部 ref —— 切走视图颜色就没了，
 *    而且真实库里所有星域的 `faction` 都是 undefined → 图例/画布/鹰眼/导出全是同一个默认色
 *    （`#6b5b95`），"势力区分"能力实际为零。
 */
function commitFactionColor(domain, color) {
  if (!domain) return;
  factionColorOverrides.value[domain.id] = color;
  // `updateNode` 只在**被拒**或节点不存在时返回 null（成功返回节点本身）→ 拒绝必须有回音
  const r = store.updateNode(domain.id, { factionColor: color });
  if (!r) setStatus('改势力颜色没生效：当前是只读态，或这个星域节点不存在', 'warn');
  applyStableLayout();
  renderer.requestRender();
  emit('dirty', true);
}

/**
 * 写 `faction`（势力名）—— 这是**该字段的唯一写入路径**。
 *
 * 为什么必须在这里给入口：`faction` 此前**没有任何写口**（提取器不产、建笔记不写、store 无 setter），
 * 于是 `getFactionColor()` 永远走 `!faction → '#6b5b95'` —— 图例/画布/鹰眼/全图导出**全是同一个默认色**，
 * "势力区分"能力为零。现在从图例直接填名字：走 `updateNode`（有闸门 + **一条 undo**），
 * 而 `faction` 不在 `ENTITY_SHAPE_KEYS` 白名单里 → 由 `entityExtras()` 原样进项目文件（不必动 schema）。
 */
function commitFaction(domain, value) {
  if (!domain) return;
  const next = String(value == null ? '' : value).trim();
  const prev = domain.faction || '';
  if (next === prev) return;                     // 同值 = 空操作，不压栈（与省份批量指派同一纪律）
  const r = store.updateNode(domain.id, { faction: next || undefined });
  if (!r) {
    setStatus('改势力没生效：当前是只读态，或这个星域节点不存在', 'warn');
    return;
  }
  applyStableLayout();
  renderer.requestRender();
  emit('dirty', true);
}

// ===== 布局计算 =====
// 具体数学在 `utils/galaxyLayout.js`（与“导出 PNG(全图)”共用同一份 —— §bug 导出与画布不同源）。
// 本函数只负责：把"当前组件的输入"喂进去 + 把结果存进组件的布局副本。
function applyStableLayout() {
  // 星域：只有 `userMoved`（或正在拖动）才采信 `coordinate`——遗留 coordinate 会让老项目全部错位（§bug3）
  domainNodes = layoutDomains(props.domains, {
    draggingId: draggingDomainId,
    overrides: factionColorOverrides.value,
  });

  // 星系：按 parentId 一次分组摆进各自星域（O(n)；原先每星系 filter 是 O(n²)）
  galaxyNodes.value = layoutGalaxies(props.galaxies, domainNodes, {});
}

// ===== 计算势力边界（凸包 / 覆盖点 / 正多边形）=====
// 同样走共享实现：**星系数 < 3 的星域也必须画**（导出原先在这里 `continue` → 星域凭空消失）
function computeFactionBorders() {
  return factionBorders({
    domainNodes,
    galaxyNodes: galaxyNodes.value,
    overrides: store.domainBorderOverrides,
  });
}

// ===== 布局计算（旧实现已删：数学搬进 utils/galaxyLayout.js，见上）=====
void 0;

// ===== 命中测试 =====
function hitTest(wx, wy) {
  if (!layers.isVisible('domain', 'nodes')) return null;
  
  const nodes = filteredGalaxyNodes.value;
  for (const galaxy of nodes) {
    const dx = wx - galaxy.x;
    const dy = wy - galaxy.y;
    if (dx * dx + dy * dy < 16 * 16) return { type: 'galaxy', node: galaxy };
  }
  
  // 星域名称标签命中（非编辑模式）→ 点击进入域内总览
  if (!editMode.value) {
    const scale = renderer.getViewTransform().scale;
    const fontSize = Math.min(70, Math.max(7, Math.round(15 / scale)));
    for (const border of computeFactionBorders()) {
      if (border.points.length < 3) continue;
      const w = border.name.length * fontSize + 20;
      const h = fontSize + 8;
      if (Math.abs(wx - border.center.x) <= w / 2 && Math.abs(wy - border.center.y) <= h / 2) {
        const d = domainNodes.find(dd => dd.id === border.domainId);
        if (d) return { type: 'domain-label', node: d };
      }
    }
  }

  if (editMode.value) {
    const borders = computeFactionBorders();
    // 命中半径一律**屏幕恒定**（÷scale）：软轮廓的手柄在远景只有几个像素，
    // 用固定的 12 世界单位会出现“看得见的点拖不动、看不见的地方反而拖得动”。
    const scale = renderer.getViewTransform().scale || 1;
    const hitR = 12 / Math.max(0.2, scale);
    for (const border of borders) {
      for (let i = 0; i < border.points.length; i++) {
        const p = border.points[i];
        const dx = wx - p.x;
        const dy = wy - p.y;
        if (dx * dx + dy * dy < hitR * hitR) {
          return { type: 'boundary-vertex', border, vertexIndex: i };
        }
      }
    }
    // 软轮廓（场派生、用户还没接管）：**点在边界线上**也算命中 —— 以最近的手柄接管。
    // 没有这条，14 个稀疏手柄里必须先精确点中一个才能开始改边界（旧凸包 5~10 点时代的老问题）。
    const lineR = 8 / Math.max(0.2, scale);
    for (const border of borders) {
      if (!border.soft) continue;
      const loop = border.loops && border.loops.length ? border.loops[0] : border.points;
      if (distanceToLoop(loop, wx, wy) > lineR) continue;
      let bi = 0;
      let bd = Infinity;
      border.points.forEach((p, i) => {
        const d = Math.hypot(p.x - wx, p.y - wy);
        if (d < bd) { bd = d; bi = i; }
      });
      return { type: 'boundary-vertex', border, vertexIndex: bi, soft: true };
    }
    // 🔴 星域本身必须**可命中**（§bug5）：`domain-label` 那条分支被 `!editMode` 门控，
    //    而编辑模式下又只判边界顶点 → 星域在编辑模式里"看得见、点不到"，
    //    连带 `type === 'domain'` 的四处消费（锁定判断 / 选中 / 右键目标 / 删除菜单项）**全是死代码**。
    //    这里按"点落在势力边界多边形内"补一条 → 四处一起复活。
    for (const border of borders) {
      if (border.points.length >= 3 && pointInPolygon(wx, wy, border.points)) {
        const d = domainNodes.find(dd => dd.id === border.domainId);
        if (d) return { type: 'domain', node: d, border };
      }
    }
  }
  
  return null;
}

/**
 * 点是否在多边形内（射线法；边界上的点按内处理）。
 * ⚠️ 只读几何判定、只用于命中：星域边界是凸包或用户覆盖点（几十个点），
 *    与 `utils/coastline.js#pointInRing` 同法；这里不参与任何数据写入。
 */
function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// ===== 当前视图可见航道 =====
// 注意：不能依赖 store.currentDomainHyperlanes —— 它在 domain 视图下 currentDomain 为 null 时返回空数组，
// 导致首次进入星域总览不显示任何航道（用户需离开再回来才显示）。
// 这里直接基于本视图的 galaxyNodes 过滤：两端节点都在当前视图内才显示。
const visibleHyperlanes = computed(() => {
  const ids = new Set(galaxyNodes.value.map(g => g.id));
  return store.hyperlanes.filter(h => ids.has(h.fromId) && ids.has(h.toId));
});

/**
 * **真正画出来的**航道（2026-11-02 稀疏化）。
 * 画与命中必须用同一份 —— 否则“看得见的点不到 / 看不见的反而点得到”。
 * 稀疏化只改渲染，不改 `store.hyperlanes`（数据一条不删）。
 */
const _laneCache = { key: '', list: [] };
function hyperlanesToDraw() {
  const vt = renderer.getViewTransform();
  const scale = vt.scale || 1;
  const lod = Math.min(1, Math.max(0, (scale - 0.3) / 0.7));
  const key = `${Math.round(scale * 100)}:${editMode.value}:${store.hyperlanes.length}:${hoveredHyperlane}:${visibleHyperlanes.value.length}`;
  if (_laneCache.key === key) return _laneCache.list;
  const list = sparsifyHyperlanes(visibleHyperlanes.value, {
    nodeById: new Map(galaxyNodes.value.map(g => [g.id, g])),
    domainOf: new Map(galaxyNodes.value.map(g => [g.id, g.domainId])),
    lod,
    editMode: editMode.value,
    pinned: new Set(hoveredHyperlane ? [hoveredHyperlane] : []),
  });
  _laneCache.key = key;
  _laneCache.list = list;
  return list;
}

function hitTestHyperlane(wx, wy) {
  const hyperlanes = hyperlanesToDraw();
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

  // 绘制定位高亮
  if (focusHighlightNode) {
    drawFocusHighlight(ctx, focusHighlightNode);
  }
}

// ===== 背景 =====
// ===== 背景（吸收自 SP-1025 原型：星云 / 尘埃带 / 三层星场 / 暗角，一次生成存资产）=====
// 原先这里是“径向渐变 + 200 世界单位的坐标网格 + 谐波点子”——网格像坐标纸、点子成斜纹。
// 现在整片天由 `galaxy/sky.js` 生成（同 seed 恒同），画布与“导出 PNG(全图)”共用这份。
function drawStarfield(ctx) {
  paintGalaxySky(ctx, GALAXY_SKY_RECT);
}
// ===== 势力边界（2026-11-02：所有权场 φ 软融合；画法在 `galaxy/domainPaint.js`，导出共用）=====
function drawFactionBorders(ctx, lod) {
  paintDomainBorders(ctx, computeFactionBorders(), {
    scale: renderer.getViewTransform().scale,
    isDark: currentTheme.value !== 'light',
    lod,
    editingId: editingBoundary.value?.domainId || null,
    hoveredId: hoveredBoundaryVertex.value?.domainId || null,
    labelAlpha: 1,
  });
}

// ===== 航道（静态线段：无阴影、无动画，保证性能与对比度） =====
function drawHyperlanes(ctx) {
  const hyperlanes = hyperlanesToDraw();
  const nodeMap = new Map(galaxyNodes.value.map(g => [g.id, g]));

  // 批次C2：视口裁剪——端点+控制点的包围盒与视口不相交的航道整条跳过
  // （bezier/quadratic 曲线必在控制点凸包内，此测试不会漏画穿屏曲线）
  const vt = renderer.getViewTransform();
  const cvs = canvas.value;
  let vp = null;
  if (cvs) {
    const hw = cvs.clientWidth / 2 / vt.scale;
    const hh = cvs.clientHeight / 2 / vt.scale;
    const cx = -vt.x / vt.scale;
    const cy = -vt.y / vt.scale;
    vp = { minX: cx - hw, minY: cy - hh, maxX: cx + hw, maxY: cy + hh };
  }

  hyperlanes.forEach(h => {
    const from = nodeMap.get(h.fromId);
    const to = nodeMap.get(h.toId);
    if (!from || !to) return;

    if (vp && h.controlPoints?.length) {
      let minX = Math.min(from.x, to.x), maxX = Math.max(from.x, to.x);
      let minY = Math.min(from.y, to.y), maxY = Math.max(from.y, to.y);
      for (const cp of h.controlPoints) {
        if (cp.x < minX) minX = cp.x;
        if (cp.x > maxX) maxX = cp.x;
        if (cp.y < minY) minY = cp.y;
        if (cp.y > maxY) maxY = cp.y;
      }
      if (maxX < vp.minX || minX > vp.maxX || maxY < vp.minY || minY > vp.maxY) return;
    } else if (vp) {
      if ((from.x < vp.minX && to.x < vp.minX) || (from.x > vp.maxX && to.x > vp.maxX)
        || (from.y < vp.minY && to.y < vp.minY) || (from.y > vp.maxY && to.y > vp.maxY)) return;
    }

    const isHovered = hoveredHyperlane === h.id;
    const isUserCreated = !h.id.startsWith('auto_');
    
    // 单层静态样式：类型区分靠颜色 + 虚线样式，hover 提亮加粗
    // ⚠️ 颜色取自 `utils/galaxyLayout.js` 的 `hyperlaneColor`（**唯一实现**）——
    //    导出 PNG(全图) 也调它，否则"画布 4 类 / 导出 3 类"（§bug 导出与画布不同源）
    const color = hyperlaneColor(h, { isDark: true, hovered: isHovered });
    // 线宽收细（2026-11-01）：原先跨域线 2px 紫虚线在远景把整幅图铺成"紫色乱麻"（原型 README 点名过的病）。
    // 现在：跨域 1.2px、跳跃 1.3px、用户建 1.6px、自动 1.0px —— 细线 + 暗色，星与领土才是主角。
    let lineWidth, dash = null;
    if (h.type === 'cross_domain') {
      lineWidth = isHovered ? 2.4 : 1.2;
      dash = [5, 6];
    } else if (h.type === 'hyperjump') {
      lineWidth = isHovered ? 2.4 : 1.3;
      dash = [9, 5];
    } else if (isUserCreated) {
      lineWidth = isHovered ? 2.2 : 1.6;
    } else {
      lineWidth = isHovered ? 1.8 : 1.0;
      dash = [4, 6];
    }
    // 远景再压一档透明度：`scale < 0.5` 时线是背景，不该比星还抢眼
    const laneAlpha = vt.scale < 0.5 ? 0.62 : 1;
    
    // 🔴 线宽/虚线一律**屏幕像素 ÷ scale**（原型口径“缩放不变粗”）：
    //    旧实现写死世界单位 → 放大后航道变成粗管子、缩小后细到看不见。
    const px = 1 / (vt.scale || 1);
    ctx.save();
    // 光晕底衬（原型做法：单独一条更宽的半透明线，比 shadowBlur 便宜得多）
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.16;
    ctx.lineWidth = Math.max(1.5 * px, lineWidth * px + 3 * px);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
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
    ctx.globalAlpha = laneAlpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth * px;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (dash) ctx.setLineDash(dash.map(d => d * px));
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
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.restore();
    
    if (editMode.value && isHovered) {
      const midX = (from.x + to.x) / 2;
      const midY = (from.y + to.y) / 2;
      
      if (!h.controlPoints || h.controlPoints.length === 0) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.beginPath();
        ctx.arc(midX, midY, 6, 0, Math.PI * 2);
        ctx.fill();
      }
      
      if (h.controlPoints && h.controlPoints.length > 0) {
        h.controlPoints.forEach((cp, i) => {
          ctx.fillStyle = 'rgba(255, 200, 50, 0.95)';
          ctx.beginPath();
          ctx.arc(cp.x, cp.y, 7, 0, Math.PI * 2);
          ctx.fill();
          
          ctx.strokeStyle = 'rgba(255, 200, 50, 0.5)';
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
          ctx.strokeStyle = 'rgba(255, 200, 50, 0.5)';
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
// 每个节点连了几条航道（枢纽判据：度数 ≥ 4 在近景出四向短芒 / 中景也留名字）
function hyperlaneDegreeMap() {
  const m = new Map();
  for (const h of store.hyperlanes || []) {
    m.set(h.fromId, (m.get(h.fromId) || 0) + 1);
    m.set(h.toId, (m.get(h.toId) || 0) + 1);
  }
  return m;
}

// ===== 恒星节点（吸收自 SP-1025 `nodes.ts`：色温分级 + 光晕 + 归属环 + LOD 图元）=====
// 与旧实现的差别（用户 2026-11-01 报障“星域总览还是一坨”）：
//   · 旧：统一白色=势力色圆点 + 白核，远景与近景一样糊；名字一律挂深色底框。
//   · 新：色温按 id 哈希分五档（同一颗星恒定）、归属色退成细环 + 低透明光晕底衬、
//        远景只留点、枢纽才出短芒、名字走 LOD + 贪心避让（无底框）。
function drawGalaxyNodes(ctx, lod) {
  const nodes = filteredGalaxyNodes.value;
  const scale = renderer.getViewTransform().scale;
  const degreeOf = hyperlaneDegreeMap();
  const hit = renderer.getCurrentHit();
  const hoveredId = hit && hit.node ? hit.node.id : null;
  const stars = [];

  nodes.forEach(galaxy => {
    const isSource = editMode.value && dragSourceNode && dragSourceNode.id === galaxy.id;
    const isTarget = editMode.value && targetNode && targetNode.id === galaxy.id;
    const matched = store.isNodeMatched(galaxy.id);
    const isCurrent = store.isCurrentMatch(galaxy.id);
    // 叙事状态淡化（2026-09-24）：**降视觉权重，不隐藏、不删数据**
    const fade = fadedAlpha(galaxy.status, { focused: isSource || isTarget || matched });
    const star = {
      id: galaxy.id,
      x: galaxy.x,
      y: galaxy.y,
      name: galaxy.displayName || galaxy.name,
      factionColor: galaxy.factionColor || getFactionColor(galaxy.faction),
      degree: degreeOf.get(galaxy.id) || 0,
      matched,
      current: isCurrent,
      hovered: hoveredId === galaxy.id,
      selected: selectedNodeIds.value.has(galaxy.id),
      fade,
    };
    paintStar(ctx, star, { scale, lod, time: animationTime, exportMode: false });
    stars.push(star);
  });

  // 标签最后画（压在所有星点之上）：远景不出名字，中景只留枢纽/匹配项，近景全量 + 避让
  const { band, fontPx } = labelLodFor(scale);
  if (band !== 'none') {
    const kept = cullStarLabels(collectStarLabels(stars, { scale }), ctx, { fontPx });
    paintStarLabels(ctx, kept, { scale, fontPx, isDark: true });
  }
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
  // 编辑辅助（锚点/手柄）仅编辑模式绘制，避免"看得到却拖不动"的困惑
  if (!editMode.value) return;
  const borders = computeFactionBorders();
  const editingId = editingBoundary.value?.domainId || null;
  const hoveredId = hoveredBoundaryVertex.value?.domainId || null;
  const scale = renderer.getViewTransform().scale;

  for (const border of borders) {
    // 软轮廓（场派生）有 14 个手柄，但它**还没被用户接管** —— 只在鼠标靠近这条边界
    // 或正在编辑它时才亮手柄，否则编辑态满屏都是圆点（14 × 星域数）。
    const active = editingId === border.domainId || hoveredId === border.domainId;
    if (border.soft && !active) continue;
    // 手柄一律屏幕恒定（÷scale），缩放时不变胖
    const r = 6.5 / Math.max(0.2, scale);
    const rHover = 9 / Math.max(0.2, scale);
    for (let i = 0; i < border.points.length; i++) {
      const p = border.points[i];
      const isHovered = hoveredBoundaryVertex.value?.domainId === border.domainId
        && hoveredBoundaryVertex.value?.vertexIndex === i;
      const rr = isHovered ? rHover : r;

      ctx.save();
      ctx.shadowColor = isHovered ? '#FF6B6B' : border.color;
      ctx.shadowBlur = isHovered ? 15 : 8;
      ctx.fillStyle = isHovered ? '#FF6B6B' : border.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.6 / Math.max(0.2, scale);
      ctx.beginPath();
      ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
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

function drawFocusHighlight(ctx, node) {
  const x = node.x;
  const y = node.y;
  const time = Date.now() / 1000;
  const pulse = Math.sin(time * 4) * 0.5 + 0.5;

  ctx.save();
  ctx.strokeStyle = '#FFD700';
  ctx.lineWidth = 3;
  ctx.shadowColor = '#FFD700';
  ctx.shadowBlur = 10 + pulse * 10;
  ctx.beginPath();
  ctx.arc(x, y, 20 + pulse * 8, 0, Math.PI * 2);
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(255, 215, 0, 0.3)';
  ctx.beginPath();
  ctx.arc(x, y, 16, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#FFD700';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - 24, y);
  ctx.lineTo(x - 12, y);
  ctx.moveTo(x + 12, y);
  ctx.lineTo(x + 24, y);
  ctx.moveTo(x, y - 24);
  ctx.lineTo(x, y - 12);
  ctx.moveTo(x, y + 12);
  ctx.lineTo(x, y + 24);
  ctx.stroke();
  ctx.restore();
}

// ===== Canvas Renderer =====
const renderer = useCanvasRenderer(canvas, {
  onRender,
  onHitTest: (wx, wy) => hitTest(wx, wy),
  onPointerMove: (wx, wy) => {
    // E11: 状态栏坐标/缩放/选中数（rAF 节流，不进渲染循环）
    setStatusThrottled({
      mouseWorld: { x: wx, y: wy },
      zoom: renderer.viewTransform.scale * 100,
      selectionCount: selectedNodeIds.value.size,
    });
  },
  onHover: (hit, wx, wy) => {
    if (editMode.value) {
      const prevHovered = hoveredHyperlane;
      const hitResult = hitTestHyperlane(wx, wy);
      hoveredHyperlane = hitResult?.hyperlane?.id || null;
      if (prevHovered !== hoveredHyperlane) {
        canvas.value.style.cursor = hoveredHyperlane ? 'pointer' : 'default';
      }
    }
    
    // 浏览态光标反馈（与 SystemView 同语义）：移动工具下可拖的恒星显示 move，拖手模式显示 grab
    if (!editMode.value && canvas.value) {
      if (interactionMode.value === 'move' && hit?.type === 'galaxy') {
        canvas.value.style.cursor = 'move';
      } else if (interactionMode.value === 'move') {
        canvas.value.style.cursor = 'default';
      } else {
        canvas.value.style.cursor = 'grab';
      }
    }

    if (hit?.type === 'boundary-vertex') {
      hoveredBoundaryVertex.value = { domainId: hit.border.domainId, vertexIndex: hit.vertexIndex };
      canvas.value.style.cursor = 'pointer';
    } else if (hit?.type !== 'galaxy') {
      hoveredBoundaryVertex.value = null;
    }
  },
  onDragStart: (wx, wy, button, shiftKey, ctrlKey, panTry) => {
    if (button !== 0) return true;
    
    // panTry=true：pan 模式的顶点试探，本组件无顶点拖拽，直接允许平移
    if (panTry) return true;
    
    // 控制点拖拽（最高优先级）
    if (editMode.value) {
      const hit = hitTestHyperlane(wx, wy);
      if (hit?.controlPointIndex !== undefined) {
        draggedControlPoint = { hyperlaneId: hit.hyperlane.id, cpIndex: hit.controlPointIndex, startX: wx, startY: wy };
        // 🔴 这里原有一句 `panSuppressed = true;` —— 该变量**全文件只有这两处赋值、没有任何读取**
        //    （由 test_93 的静态守卫抓出）。模块作用域是严格模式，赋值一个未声明标识符会当场
        //    `ReferenceError`，即“一拖航道控制点就报错”。抑制平移的语义已经由紧邻的
        //    `return false`（= 本组件接管这次拖动）完整表达，所以删除死赋值而不是补声明。
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
    
    // 锁定节点不可拖拽（仍可选中）
    if ((hit.type === 'galaxy' || hit.type === 'domain' || hit.type === 'domain-label') && hit.node.locked) {
      return true;
    }
    
    if (editMode.value && hit.type === 'boundary-vertex') {
      // 先落"起始覆盖点"（走 store 唯一写口：只读态会被拒 → 这次编辑**根本不开始**，
      // 而不是先把 override 写进内存、拖完才在保存时被拒）
      if (!store.domainBorderOverrides[hit.border.domainId]) {
        if (!setBorderPoints(hit.border.domainId, [...hit.border.points], true)) return true;  // 被拒 = 归画布平移
      }
      editingBoundary.value = { domainId: hit.border.domainId, vertexIndex: hit.vertexIndex };
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
      // 浏览态：先按旧语义选中（防误触），是否**移动**由工具决定。
      if (hit.type === 'galaxy' || hit.type === 'domain') {
        if (!selectedNodeIds.value.has(hit.node.id)) {
          selectedNodeIds.value.clear();
          selectedNodeIds.value.add(hit.node.id);
        }
        emit('select-node', hit.node);
      }
      if (interactionMode.value === 'pan') return true;   // 拖手模式：本次拖动仍归画布平移
      // “移动”工具（§bug1 的接通）：拖恒星 / 星域 = 改坐标。
      // ✅ 星域**现在也能拖**了（§bug3 落地）：拖动写 `coordinate` 并在松手时置 `userMoved`，
      //    布局从此认它；星域的**恒星**由 `applyStableLayout` 按父星域位置重算（未手动摆过的会跟着走）。
      // ⚠️ 浏览态下"星域的手柄"是它中心的**名称标签**（`domain-label`），编辑态才是 `domain`（多边形命中）——
      //    两个都要接，否则鼠标落在域中心时拖动会走成平移。
      const isDomainHandle = hit.type === 'domain' || hit.type === 'domain-label';
      if (hit.type !== 'galaxy' && !isDomainHandle) return true;
      if (!hit.node.coordinate || !Number.isFinite(hit.node.coordinate.x)) {
        setStatus('这个节点还没有坐标，先“编辑地图”里点一次“完成编辑”让它落到布局上', 'info');
        return true;
      }
      // 多选状态下的拖动 = 整批移动（一次 undo）—— 这也是 `isDraggingMultiple` 这条死分支的接活点
      const ids = (selectedNodeIds.value.has(hit.node.id) && selectedNodeIds.value.size > 1)
        ? [...selectedNodeIds.value] : [hit.node.id];
      if (ids.length > 1) {
        store.beginMultiNodePositionCapture(ids);
        isDraggingMultiple = true;
      } else {
        store.beginNodePositionCapture(hit.node.id);
      }
      if (isDomainHandle) draggingDomainId = hit.node.id;
      dragMultipleStart = { x: wx, y: wy };
      return { mode: 'node', nodeId: hit.node.id };
    }
  },
  onDragMove: (wx, wy, dragInfo) => {
    // 星域边界顶点拖拽（最高优先级：拖住锚点时其他拖拽逻辑全部短路）
    if (editingBoundary.value) {
      const points = store.domainBorderOverrides[editingBoundary.value.domainId];
      if (points && points[editingBoundary.value.vertexIndex]) {
        points[editingBoundary.value.vertexIndex] = { x: wx, y: wy };
        renderer.requestRender();
      }
      return;
    }
    
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
        return;
      }
      // 星域拖动：写 store 坐标 → **重排**（它的恒星按父星域位置重算，于是整簇跟着走）
      if (draggingDomainId === dragInfo.nodeId) {
        store.updateNodePosition(dragInfo.nodeId, wx, wy);
        applyStableLayout();
        const dn = domainNodes.find(d => d.id === dragInfo.nodeId);
        if (dn) { dn.x = wx; dn.y = wy; }   // 双保险：props 回流前也画在对的位置
        renderer.requestRender();
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
    // 拖动期预览开关先清掉：此后布局一律以 `userMoved`（由 endNodePositionCapture 写入）为准
    draggingDomainId = null;
    // 星域边界顶点拖拽结束：提交 override 并标记脏
    if (editingBoundary.value) {
      const domainId = editingBoundary.value.domainId;
      const points = store.domainBorderOverrides[domainId];
      if (points) {
        setBorderPoints(domainId, points.map(p => ({ ...p })));
        emit('dirty', true);
      }
      editingBoundary.value = null;
      return;
    }
    
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
      store.endMultiNodePositionCapture();
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
    closeCtxMenu();
    if (hit?.node) {
      // 点击节点 → 清空旧选择并单选（多选由 Shift 框选产生）
      if (!selectedNodeIds.value.has(hit.node.id)) {
        selectedNodeIds.value.clear();
        selectedNodeIds.value.add(hit.node.id);
      }
      emit('select-node', hit.node);
    } else if (!hit) {
      // 点击空白 → 清空多选
      if (selectedNodeIds.value.size > 0) {
        selectedNodeIds.value.clear();
        renderer.requestRender();
      }
    }
    
    // 编辑模式下不自动进入下一级地图（防止误操作）
    if (editMode.value) return;
    
    if (hit?.type === 'galaxy') {
      emit('enter-system', hit.node);
    } else if (hit?.type === 'domain-label') {
      // 点击星域名称标签 → 进入域内恒星系总览
      emit('select', hit.node);
    } else if (hit?.type === 'boundary-vertex') {
      editingBoundary.value = { domainId: hit.border.domainId, vertexIndex: hit.vertexIndex };
    }
  },
  onContextMenu: (wx, wy) => {
    // 🔴 浏览态不许弹菜单（§bug6）：菜单里的“在此创建恒星 / 删除该节点 / 删除航道 / 删除控制点”
    //    全是**写操作**。此前没有这道门 → 浏览态右键就能改数据（与“编辑地图”这个显式入口自相矛盾）。
    //    写法照抄 `SystemDetailView.vue` 的既有闸门（那一层早就修好了，这里是漏网的之一）。
    if (!editMode.value) return;
    const hit = hitTest(wx, wy);
    let target = null;
    if (hit?.type === 'galaxy' || hit?.type === 'domain') {
      target = { type: hit.type, node: hit.node };
    } else if (hit?.type === 'boundary-vertex') {
      // 边界顶点右键 → 保留原编辑语义（进入顶点编辑）；起始覆盖点同样走 store 写口（只读态被拒则不进入）
      if (editMode.value) {
        if (!store.domainBorderOverrides[hit.border.domainId]) {
          if (!setBorderPoints(hit.border.domainId, [...hit.border.points], true)) return;
        }
        editingBoundary.value = { domainId: hit.border.domainId, vertexIndex: hit.vertexIndex };
      }
      return;
    } else {
      const h = hitTestHyperlane(wx, wy);
      if (h) {
        target = {
          type: 'hyperlane',
          hyperlane: h.hyperlane,
          controlPointIndex: h.controlPointIndex,
        };
      }
    }
    openContextMenu(wx, wy, target);
  },
});

// ===== 监听聚焦节点事件 =====
let focusHighlightNode = null;
let focusHighlightTimer = null;

function onFocusNode(e) {
  const node = e.detail;
  if (!node) return;
  const galaxy = galaxyNodes.value.find(g => g.id === node.id);
  if (galaxy) {
    renderer.focusOn(galaxy.x, galaxy.y, 1.5);
    showFocusHighlight(galaxy);
    return;
  }
  const domain = domainNodes.find(d => d.id === node.id);
  if (domain) {
    renderer.focusOn(domain.x, domain.y, 1.2);
    showFocusHighlight(domain);
    return;
  }
}

function showFocusHighlight(node) {
  focusHighlightNode = node;
  if (focusHighlightTimer) clearTimeout(focusHighlightTimer);
  focusHighlightTimer = setTimeout(() => {
    focusHighlightNode = null;
    renderer.requestRender();
  }, 2000);
  renderer.requestRender();
}

// ===== 监听节点移除事件（NodeDetailPanel 删除后同步布局） =====
// 注意：store.nodes 变化会触发下方 deep watch → applyStableLayout 重建布局，
// 这里只需过滤本地缓存并请求渲染，避免二次布局重算。
function onNodeRemovedFromMap(e) {
  const nodeId = e.detail;
  if (!nodeId) return;
  const removedCount = galaxyNodes.value.length;
  galaxyNodes.value = galaxyNodes.value.filter(g => g.id !== nodeId);
  if (galaxyNodes.value.length !== removedCount) {
    renderer.requestRender();
  }
}

// ===== 键盘删除选中节点（Delete 键，多选时批量删除） =====
function handleGlobalKeydown(e) {
  if (e.target.closest('input, textarea, select')) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedNodeIds.value.size > 0) {
    e.preventDefault();
    const ids = [...selectedNodeIds.value];
    const msg = ids.length === 1
      ? `确定从地图移除该节点吗？（可撤销）`
      : `确定从地图移除选中的 ${ids.length} 个节点吗？（可撤销）`;
    if (!confirm(msg)) return;
    ids.forEach(id => {
      store.removeNode(id);
      galaxyNodes.value = galaxyNodes.value.filter(g => g.id !== id);
    });
    selectedNodeIds.value.clear();
    emit('dirty', true);
    renderer.requestRender();
  }
}

// ===== 生命周期 =====
// E2: 撤销历史跳转后重绘画布（历史面板广播）
function onHistoryJump() {
  renderer.requestRender();
}

onMounted(() => {
  renderer.initCanvas();
  applyStableLayout();
  renderer.requestRender();
  requestAnimationFrame(() => requestAnimationFrame(() => { skeletonReady.value = true; }));
  showStatusBar('星域地图');
  setStatus({ toolLabel: '浏览' });
  window.addEventListener('sitian:focus-node', onFocusNode);
  window.addEventListener('sitian:history-jump', onHistoryJump);
  window.addEventListener('sitian:node-removed-from-map', onNodeRemovedFromMap);
  window.addEventListener('keydown', handleGlobalKeydown);
});

onUnmounted(() => {
  renderer.cleanupCanvas();
  hideStatusBar();
  window.removeEventListener('sitian:focus-node', onFocusNode);
  window.removeEventListener('sitian:history-jump', onHistoryJump);
  window.removeEventListener('sitian:node-removed-from-map', onNodeRemovedFromMap);
  window.removeEventListener('keydown', handleGlobalKeydown);
});

// props 数组来自 store computed（节点更新是对象替换 → computed 重算 → 数组引用变化），
// 浅 watch 即可触发重布局；deep 遍历全部节点对象属无谓开销（批次A3）
watch([() => props.galaxies, () => props.domains], () => {
  applyStableLayout();
  renderer.requestRender();
});

watch(visibleHyperlanes, () => {
  renderer.requestRender();
});

// 叙事状态变更 → 重绘（2026-09-24）。
// ⚠️ 必须走这个指纹：`updateNode` 是 `Object.assign(node, …)` **就地改字段** —— 既不换数组引用、
//    也不换节点对象，所以基于“数组/对象引用”的浅 watch 全都捕捉不到 status 变化。
// 这里 extra 要重建布局：`galaxyNodes` 是**本地副本**（`{...galaxy, x, y}` 展开而来），
// 副本里的 status 是拷贝时的旧值 —— 只 requestRender 会一直画旧状态。
watch(() => store.statusRevision, () => {
  applyStableLayout();
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
function createGalaxyAt(wx, wy) {
  // 归属到最近的星域（保证恒星进入星域聚簇，可点击进入 system 视图）
  let targetDomain = null;
  let minDist = Infinity;
  for (const d of domainNodes) {
    const dist = Math.hypot(wx - d.x, wy - d.y);
    if (dist < minDist) { minDist = dist; targetDomain = d; }
  }
  const parentDomain = targetDomain || props.world;
  
  const id = `galaxy_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const newGalaxy = {
    id,
    name: `新恒星_${Date.now() % 1000}`,
    layer: 'galaxy',
    parentId: parentDomain?.id || null,
    tags: ['新创建'],
    sourcePath: '',
    coordinate: { x: Math.round(wx), y: Math.round(wy) },
    userMoved: true, // 创建位置即用户意图，布局重算时保留
  };
  store.addNode(newGalaxy);
  galaxyNodes.value.push({
    ...newGalaxy,
    x: wx,
    y: wy,
    domainId: parentDomain?.id || null,
    factionColor: parentDomain?.factionColor || '#4a90d9',
  });
  selectedNodeIds.value.clear();
  selectedNodeIds.value.add(newGalaxy.id);
  emit('dirty', true);
  renderer.requestRender();
}

function createGalaxy() {
  const vt = renderer.getViewTransform();
  createGalaxyAt(-vt.x / vt.scale, -vt.y / vt.scale);
}

/**
 * 生成示例星系（2026-11-02）：调 store 的唯一写口 `generateSampleGalaxy`（一条 undo），
 * 成功后重算布局 + 适应全图 + 重绘，并把回执写进状态栏（星域/恒星/航道/指标）。
 */
function generateSample() {
  const r = store.generateSampleGalaxy({ worldId: props.world?.id });
  if (!r || r.ok === false) {
    setStatus((r && r.message) || '生成失败：未知原因', 'warn');
    return;
  }
  applyStableLayout();
  setTimeout(() => { try { fitAllGalaxy(); } catch (e) { /* 视图还没挂上就只重绘 */ } }, 0);
  const m = r.metrics || {};
  setStatus(
    `已生成示例星系：${r.domains} 星域 / ${r.stars} 恒星 / ${r.lanes} 条航道`
    + `（跨域 ${r.crossDomainLanes}；重叠对 ${m.overlapPairs ?? '?'} · 最大度 ${m.maxDegree ?? '?'} · 分量 ${m.components ?? '?'}）`
    + ` —— 一次 Ctrl+Z 可整体撤回`,
    'info',
  );
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
  const vt = renderer.viewTransform;
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
  
  const hyperlanes = visibleHyperlanes.value;
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
  // 修复：getViewTransform() 返回浅拷贝，改 vt 无效。改为 focusOn 直接设置内部 viewTransform
  renderer.focusOn(world.x, world.y, renderer.getViewTransform().scale);
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
.header-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.header-title-row h2 { margin-bottom: 0; }
.back-btn {
  padding: 3px 10px;
  border: 1px solid var(--map-btn-border);
  border-radius: var(--radius-sm);
  background: var(--map-btn-bg);
  color: var(--map-btn-text);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s;
}
.back-btn:hover { background: var(--map-btn-hover); }

.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.hyperlane-type-select {
  padding: 5px 10px;
  border: 1px solid var(--map-btn-border);
  border-radius: var(--radius-sm);
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
  border-radius: var(--radius-sm);
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

/* 势力名输入（`faction` 的唯一写入入口）—— 窄、透明底，不抢图例的视觉 */
.legend-faction-input {
  width: 68px;
  padding: 1px 4px;
  font-size: 11px;
  font-family: inherit;
  color: var(--map-btn-text);
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 4px;
}
.legend-faction-input::placeholder {
  color: rgba(255, 255, 255, 0.35);
}
.legend-faction-input:focus {
  outline: none;
  border-color: var(--faction-color);
}

.filter-panel-galaxy {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 8px;
  background: var(--map-header-bg);
  border: 1px solid var(--map-header-border);
  border-radius: var(--radius-md);
  padding: 12px;
  min-width: 220px;
  z-index: 200;
  box-shadow: var(--shadow-md);
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
  border-radius: var(--radius-xl);
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
  border-radius: var(--radius-sm);
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
/* ===== 右键菜单已迁移到统一 ContextMenu 组件（U3） ===== */
</style>
