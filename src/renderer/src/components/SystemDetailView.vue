<template>
  <div class="system-detail-container">
    <div class="map-header">
      <div class="header-left">
        <div class="header-title-row">
          <button class="back-btn" @click="$emit('back')" title="返回星域地图">← 返回</button>
          <h2>{{ system?.displayName || system?.name || '未知恒星系' }} — 恒星系</h2>
        </div>
        <p class="hint">
          <span v-if="!editMode">点击行星进入行星地图 · 点击箭头跳转相邻恒星系 · 点击标记/部队卡看信息 · 滚动缩放 · 拖拽空白处平移</span>
          <span v-else class="edit-hint">编辑模式：拖拽行星编辑轨道 · 头部「＋ 天体」落下一轨道槽 · 右键空白处在原地添加天体/太空标记/部队卡片 · 右键天体/标记/卡片删除</span>
        </p>
      </div>
      <div class="header-actions">
        <button :class="{ active: neighborPanelOpen }" @click="neighborPanelOpen = !neighborPanelOpen" title="邻近恒星系列表（含未显示航道）">
          🧭 邻系 ({{ allNeighbors.length }})
        </button>
        <button :class="{ active: editMode }" @click="toggleEditMode" :title="editMode ? '退出编辑模式' : '编辑系内天体（拖拽轨道/添加/删除）'">
          {{ editMode ? '✓ 完成编辑' : '✎ 编辑地图' }}
        </button>
        <button v-if="editMode" title="在下一轨道槽添加天体（行星/卫星/空间站）" @click="createBody">
          ＋ 天体
        </button>
      </div>
    </div>
    <div class="canvas-wrapper">
      <canvas ref="canvas"></canvas>
      <!-- U3: 右键菜单迁移到统一 ContextMenu 组件 -->
      <context-menu :state="ctxMenu.state" @close="closeContextMenu" />
      <PanelShell
        class="system-neighbor-panel"
        title="邻近恒星系"
        :open="neighborPanelOpen"
        @close="neighborPanelOpen = false"
      >
        <div class="neighbor-list">
          <div v-if="allNeighbors.length === 0" class="neighbor-empty">暂无航道连接的相邻恒星系</div>
          <div v-if="omittedCount > 0" class="neighbor-omitted">航道过密：画布仅显示最近 {{ arrowsLimit }} 条箭头，其余 {{ omittedCount }} 条见此列表</div>
          <div
            v-for="n in allNeighbors"
            :key="n.id"
            class="neighbor-row"
            @click="jumpTo(n.neighborId)"
          >
            <span class="neighbor-badge" :class="{ cross: n.crossDomain }">{{ n.crossDomain ? '跨域' : '同域' }}</span>
            <span class="neighbor-name" :title="n.neighborName">{{ n.neighborName }}</span>
            <span class="neighbor-dist">{{ Math.round(n.dist) }}</span>
          </div>
        </div>
      </PanelShell>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useGeodataStore } from '../store/geodata';
import { useLayersStore } from '../store/layers';
import { useCanvasRenderer } from '../composables/useCanvasRenderer';
import { useContextMenu } from '../composables/useContextMenu';
import { planetOrbitLayout, ORBIT_RING_START, ORBIT_RING_STEP, getPlanetColor, getPlanetRadius, getStarRadius, getStarColor, sortPlanetsByOrbit } from '../composables/systemOrbit';
import { drawDeepSpaceBackground } from '../composables/spaceBackground';
import { SPACE_MARKER_TYPES, FLEET_KINDS } from '../store/geodataModules/spaceEditing';
import { usePromptDialog } from '../composables/usePromptDialog';
import PanelShell from './PanelShell.vue';
import ContextMenu from './ContextMenu.vue';

/**
 * 单恒星系详情视图（批次 B4 + B5 + B3 编辑 + B6/B7 太空实体）
 * - 恒星居中（原点），行星按确定性轨道公式环绕（共享 systemOrbit composable）
 * - 行星手动坐标以"相对恒星偏移"保留（坐标缓存是域地图绝对坐标，此处取相对量）
 * - 邻系箭头基于真实 hyperlanes 邻接（B5）：静态指向 + 点击跳转相邻系
 * - 系内编辑（B3）：编辑模式拖拽行星改轨道（相对坐标 ↔ 域地图绝对坐标换算基准 system.coordinate）、
 *   头部「＋ 天体」落下一轨道槽、右键原地添加/删除（layer:'planet'，类型记入 tags 第二项）
 * - 太空标记（B6）：菱形图标（确定性颜色表），坐标为相对恒星偏移，CRUD 走 undo execute
 * - 部队卡片（B7）：圆角矩形小卡片（阵营色边框 + kind 图标），仅信息提示、无任何策略行为
 */
const store = useGeodataStore();
const layers = useLayersStore();

const props = defineProps({
  system: { type: Object, default: null },
});

const emit = defineEmits(['back', 'select-node', 'dirty']);

const canvas = ref(null);
const neighborPanelOpen = ref(false);
// ===== 编辑模式状态（B3） =====
const editMode = ref(false);
// 拖拽中的行星显示位置（系内相对坐标）：非 userMoved 行星改 store 坐标不会立刻反映到
// 公式位布局，需此覆盖层提供拖拽跟手反馈；mouseup 落盘 userMoved 后由 saved 路径接管
const dragPlanet = ref(null); // { nodeId, x, y } | null
// U3: 统一右键菜单框架。contextMenu computed 别名保留 setupState/expose 兼容（测试读取 visible）。
const ctxMenu = useContextMenu();
const ctxTarget = ref(null);
const ctxPickHostFor = ref(null);
const ctxWorld = ref({ x: 0, y: 0 });
let lastMenuPos = { x: 0, y: 0 };
const contextMenu = computed(() => ({
  visible: ctxMenu.state.visible,
  target: ctxTarget.value,
  pickHostFor: ctxPickHostFor.value,
  worldX: ctxWorld.value.x,
  worldY: ctxWorld.value.y,
}));
// 模态输入（批次D1）：天体/标记/部队的类型与名称录入，替代 Electron 不支持的 window.prompt
const usePromptDialogState = usePromptDialog();
let hoveredArrowId = null;
let hoveredPlanetId = null;

// 箭头防重叠参数：画布最多显示 arrowsLimit 条（按距离取最近），标签角距至少 MIN_GAP 弧度
const arrowsLimit = 10;
const ARROW_MIN_GAP = 0.42;

// 太空标记菱形半边长（B6）
const MARKER_HALF = 9;
const MARKER_HIT_R = 14;

// 部队卡片尺寸参数（B7）：宽度随名称长度自适应（确定性，无随机）
const CARD_FONT_TARGET = 11;
const CARD_MIN_W = 64;

// ===== 添加天体类型（B3）：layer 统一 'planet'（行星级天体），类型记入 tags 第二项 =====
const BODY_TYPES = [
  { key: 'planet', label: '行星', prefix: '新行星' },
  { key: 'moon', label: '卫星', prefix: '新卫星' },
  { key: 'station', label: '空间站', prefix: '新空间站' },
];

// 系内相对坐标 ↔ 域地图绝对坐标 的换算基准（本视图恒星画在原点，行星坐标是相对量；
// 坐标缓存层存的却是域地图绝对坐标，故加减 system.coordinate；null 时按 0,0）
function sysBase() {
  const c = props.system?.coordinate;
  return { x: c?.x ?? 0, y: c?.y ?? 0 };
}

// ===== 行星布局（恒星在原点）+ 卫星绕行（批次D5） =====
// 卫星 = layer 'moon' + parentId 指向系内行星：锚定母行星渲染，不占恒星轨道槽。
// A3: 恒星名称（优先取主恒星节点名称，无则兜底系统名）
const starName = computed(() => {
  const primary = systemBodies.value.primaryStar;
  if (primary) {
    return primary.displayName || primary.name;
  }
  return null;
});
const systemBodies = computed(() => {
  if (!props.system) return { stars: [], primaryStar: null, binaryStars: [], planets: [], moons: [] };
  const children = store.currentSystemPlanets;
  const stars = children.filter(n => n.layer === 'star');
  // B3：双星系统 — 区分主恒星（无 parentStar）与子恒星（parentStar 指向主恒星）
  const primaryStar = stars.find(s => !s.parentStar) || stars[0] || null;
  const binaryStars = stars.filter(s => s.parentStar && s.parentStar !== s.id);
  const planets = children.filter(n => n.layer !== 'star');
  const planetIds = new Set(planets.map(p => p.id));
  const moons = store.nodes.filter(n => n.layer === 'moon' && planetIds.has(n.parentId));
  return { stars, primaryStar, binaryStars, planets, moons };
});

const planetLayouts = computed(() => {
  if (!props.system) return [];
  const sysCoord = props.system.coordinate;
  // 第一轮：恒星直接子行星，轨道顺序按标准化命名罗马数字（衡佑Ⅲ < 津廊Ⅵ），无数字保持原序
  const layouts = sortPlanetsByOrbit(systemBodies.value.planets).map((planet, pIdx) => {
    const { angle, orbitRadius } = planetOrbitLayout(pIdx);
    // 手动坐标 → 相对恒星偏移（保留用户在域地图上的相对布局意图）；否则用公式位
    const saved = planet.userMoved && planet.coordinate?.x != null && sysCoord?.x != null;
    const dragging = dragPlanet.value && dragPlanet.value.nodeId === planet.id;
    return {
      ...planet,
      x: dragging ? dragPlanet.value.x : saved ? planet.coordinate.x - sysCoord.x : Math.cos(angle) * orbitRadius,
      y: dragging ? dragPlanet.value.y : saved ? planet.coordinate.y - sysCoord.y : Math.sin(angle) * orbitRadius,
      orbitRadius,
      angle,
      isMoon: false,
    };
  });
  // 第二轮：卫星绕母行星——确定性槽位（半径随卫星序递增、角度均匀分布，无随机）。
  // 卫星不参与拖拽/userMoved：位置始终由母行星锚定推导（母星被拖动时卫星跟随）。
  const moonsByParent = new Map();
  for (const moon of systemBodies.value.moons) {
    if (!moonsByParent.has(moon.parentId)) moonsByParent.set(moon.parentId, []);
    moonsByParent.get(moon.parentId).push(moon);
  }
  const planetCount = layouts.length;
  for (let pi = 0; pi < planetCount; pi++) {
    const planet = layouts[pi];
    const moons = moonsByParent.get(planet.id);
    if (!moons) continue;
    moons.forEach((moon, mIdx) => {
      const r = getPlanetRadius(planet.layer) * 2 + 12 + mIdx * 9;
      const a = (Math.PI * 2 * (mIdx + 1)) / (moons.length + 1) + 0.7;
      layouts.push({
        ...moon,
        x: planet.x + Math.cos(a) * r,
        y: planet.y + Math.sin(a) * r,
        orbitRadius: null,
        angle: a,
        isMoon: true,
        moonOrbitRadius: r,
        hostX: planet.x,
        hostY: planet.y,
      });
    });
  }
  return layouts;
});

// 「设为卫星」母行星候选：系内恒星直接子，排除自身（卫星不能绕自己）
const pickHostCandidates = computed(() =>
  systemBodies.value.planets.filter(p => p.id !== ctxPickHostFor.value)
);

// 最外圈轨道半径（箭头环的基准）
const maxOrbitRadius = computed(() =>
  planetLayouts.value.reduce((max, p) => Math.max(max, p.orbitRadius || ORBIT_RING_START), ORBIT_RING_START)
);

// ===== 太空实体数据（B6 标记 / B7 部队卡片）：只取当前恒星系的（只渲染当前层级） =====
// null 坐标（缓存缺字段）落回恒星原点，避免 NaN 破坏绘制/命中
const systemSpaceMarkers = computed(() => {
  if (!props.system) return [];
  return store.spaceMarkers
    .filter(m => m.systemId === props.system.id)
    .map(m => ({ ...m, x: m.x ?? 0, y: m.y ?? 0 }));
});

const systemFleetCards = computed(() => {
  if (!props.system) return [];
  return store.fleetCards
    .filter(c => c.systemId === props.system.id)
    .map(c => ({ ...c, x: c.x ?? 0, y: c.y ?? 0 }));
});

// 类型样式查询（未知类型回退首项，确定性、无随机）
function spaceMarkerStyle(type) {
  return SPACE_MARKER_TYPES.find(t => t.key === type) || SPACE_MARKER_TYPES[0];
}
function fleetKindStyle(kind) {
  return FLEET_KINDS.find(k => k.key === kind) || FLEET_KINDS[0];
}

// 部队卡片包围盒（绘制与命中共用同一公式，避免两处宽度不一致）
function fleetCardBox(card, font) {
  const name = `${fleetKindStyle(card.kind).icon} ${card.name}`;
  const w = Math.max(CARD_MIN_W, name.length * font * 0.9 + 20);
  const h = font + 12;
  return { x: card.x - w / 2, y: card.y - h / 2, w, h, name };
}

// ===== 邻系数据（B5：真实 hyperlanes 邻接） =====
// 全量邻接（面板数据源 + 距离排序依据）
const allNeighbors = computed(() => {
  if (!props.system) return [];
  const sys = props.system;
  const sysCoord = sys.coordinate;
  const nodeMap = new Map(store.nodes.map(n => [n.id, n]));
  const lanes = store.hyperlanes.filter(h => h.fromId === sys.id || h.toId === sys.id);
  const list = lanes.map(h => {
    const neighborId = h.fromId === sys.id ? h.toId : h.fromId;
    const neighbor = nodeMap.get(neighborId);
    const nCoord = neighbor?.coordinate;
    const dist = nCoord?.x != null && sysCoord?.x != null
      ? Math.hypot(nCoord.x - sysCoord.x, nCoord.y - sysCoord.y)
      : Infinity;
    let angle = null;
    if (nCoord?.x != null && sysCoord?.x != null && (nCoord.x !== sysCoord.x || nCoord.y !== sysCoord.y)) {
      angle = Math.atan2(nCoord.y - sysCoord.y, nCoord.x - sysCoord.x);
    }
    return {
      id: h.id,
      neighborId,
      neighborName: neighbor?.displayName || neighbor?.name || neighborId,
      crossDomain: h.type === 'cross_domain' || (neighbor ? neighbor.parentId !== sys.parentId : false),
      dist,
      idealAngle: angle,
      sortDist: dist === Infinity ? Number.MAX_SAFE_INTEGER : dist,
    };
  });
  // 确定性排序：距离升序，同距按 id
  list.sort((a, b) => (a.sortDist - b.sortDist) || (a.id < b.id ? -1 : 1));
  return list;
});

const omittedCount = computed(() => Math.max(0, allNeighbors.value.length - arrowsLimit));

// 圆上确定性角距分离：保持理想方位的环形顺序，仅把过近的相邻对推开到 MIN_GAP
function spreadAngles(angles) {
  const n = angles.length;
  if (n < 2) return angles.slice();
  const TWO_PI = Math.PI * 2;
  if (n * ARROW_MIN_GAP >= TWO_PI) {
    // 过密兜底：均分圆周（确定性）
    return angles.map((_, i) => (i * TWO_PI) / n - Math.PI / 2);
  }
  const arr = angles.slice().sort((a, b) => a - b);
  for (let iter = 0; iter < 24; iter++) {
    let moved = false;
    for (let i = 1; i < n; i++) {
      if (arr[i] - arr[i - 1] < ARROW_MIN_GAP) {
        const mid = (arr[i] + arr[i - 1]) / 2;
        arr[i - 1] = mid - ARROW_MIN_GAP / 2;
        arr[i] = mid + ARROW_MIN_GAP / 2;
        moved = true;
      }
    }
    if (!moved) break;
  }
  arr.sort((a, b) => a - b);
  return arr.map(a => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2));
}

// 画布显示的箭头子集（最近 arrowsLimit 条；角度经防重叠分离）
const neighborArrows = computed(() => {
  const shown = allNeighbors.value.slice(0, arrowsLimit);
  if (!shown.length) return [];
  const fallbackAngles = shown.map((_, i) => (i / shown.length) * Math.PI * 2 - Math.PI / 2);
  const ideal = shown.map((n, i) => n.idealAngle == null ? fallbackAngles[i] : n.idealAngle);
  // 按理想角排序后逐一分离，再按同序回填（保持各自大致方位）
  const order = ideal.map((a, i) => ({ a, i })).sort((x, y) => x.a - y.a);
  const spread = spreadAngles(order.map(o => o.a));
  const finalAngles = [];
  order.forEach((o, k) => { finalAngles[o.i] = spread[k]; });

  const r0 = maxOrbitRadius.value + 40;
  const r1 = maxOrbitRadius.value + 120;
  return shown.map((n, i) => ({
    ...n,
    angle: finalAngles[i],
    r0,
    r1,
    x: Math.cos(finalAngles[i]) * r1,
    y: Math.sin(finalAngles[i]) * r1,
  }));
});

// 面板/箭头共用：跳转到相邻恒星系
function jumpTo(neighborId) {
  const neighbor = store.nodes.find(n => n.id === neighborId);
  if (neighbor) store.selectSystem(neighbor);
}

// ===== 编辑模式（B3） =====
function toggleEditMode() {
  editMode.value = !editMode.value;
  closeContextMenu();
  // 边界兜底：切出编辑时若仍有未收尾的拖拽（如鼠标已离开画布），补齐撤销记录
  if (!editMode.value) finalizePlanetDrag();
  if (canvas.value) canvas.value.style.cursor = editMode.value ? 'default' : 'grab';
  renderer.requestRender();
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

function buildMenuItems() {
  // 「选择母行星」模式：菜单切换为系内行星列表（批次D5）
  if (ctxPickHostFor.value) {
    const items = [{ key: 'pick-header', header: true, label: '选择母行星', icon: '🛰' }];
    for (const p of pickHostCandidates.value) {
      items.push({ key: 'host-' + p.id, label: p.displayName || p.name, icon: '🪐', action: () => ctxSetMoonHost(p.id) });
    }
    items.push({ key: 'pick-cancel', label: '返回', icon: '↩', action: ctxCancelPickHost, keepOpen: true });
    return items;
  }
  const t = ctxTarget.value;
  const items = [];
  if (t?.type === 'planet' || t?.type === 'star' || t?.type === 'space-marker' || t?.type === 'fleet-card') {
    items.push({ key: 'view', label: '查看信息', icon: 'ℹ', action: ctxViewNode });
  }
  if (t?.type === 'planet' && !t.node.isMoon) {
    items.push({ key: 'pick-host', label: '设为卫星…', icon: '🛰', action: ctxBeginPickHost, keepOpen: true });
  }
  if (t?.type === 'planet' && t.node.isMoon) {
    items.push({ key: 'unset-moon', label: '取消卫星（回到独立轨道）', icon: '↩', action: ctxUnsetMoon });
  }
  if (t?.type === 'planet') {
    items.push({ key: 'del-node', label: '删除该节点', icon: '🗑', danger: true, action: ctxDeleteNode });
  }
  if (t?.type === 'space-marker') {
    items.push({ key: 'del-marker', label: '删除标记', icon: '🗑', danger: true, action: ctxDeleteSpaceMarker });
  }
  if (t?.type === 'fleet-card') {
    items.push({ key: 'del-card', label: '删除部队卡片', icon: '🗑', danger: true, action: ctxDeleteFleetCard });
  }
  if (!t) {
    items.push({ key: 'add-body', label: '添加天体（此位置）', icon: '＋', action: ctxAddBodyHere });
    items.push({ key: 'add-marker', label: '添加太空标记（此位置）', icon: '◈', action: ctxAddSpaceMarkerHere });
    items.push({ key: 'add-fleet', label: '添加部队卡片（此位置）', icon: '⚑', action: ctxAddFleetCardHere });
  }
  return items;
}

function openContextMenu(wx, wy, target) {
  ctxTarget.value = target;
  ctxPickHostFor.value = null; // 批次D5：每次打开重置「选择母行星」模式
  ctxWorld.value = { x: wx, y: wy };
  lastMenuPos = worldToScreen(wx, wy);
  ctxMenu.open(buildMenuItems(), lastMenuPos, canvas.value?.parentElement);
}

function closeContextMenu() {
  ctxMenu.close();
  ctxTarget.value = null;
  ctxPickHostFor.value = null;
}

// ===== 天体 CRUD =====
// 类型选择：模态选项列表（批次D1：window.prompt 在 Electron 渲染进程不被支持，
// 此前「＋ 天体」点击即抛 "prompt() is and will not be supported" 静默失效），取消返回 null（中止创建）
async function promptBodyType() {
  // askChoice 原样返回选项对象（含 prefix），取消返回 null
  return usePromptDialogState.askChoice({ title: '选择天体类型', options: BODY_TYPES });
}

// 在系内相对坐标 (wx, wy) 处创建天体（存储层换算回域地图绝对坐标）
async function createBodyAt(wx, wy) {
  if (!props.system) return null;
  const type = await promptBodyType();
  if (!type) return null;
  const base = sysBase();
  const newBody = {
    id: `planet_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    name: `${type.prefix}${Date.now() % 1000}`,
    layer: 'planet',
    parentId: props.system.id,
    tags: ['新创建', type.label],
    sourcePath: '',
    coordinate: {
      x: Math.round(base.x + wx),
      y: Math.round(base.y + wy),
    },
    userMoved: true, // 创建位置即用户意图，布局重算时保留
  };
  store.addNode(newBody);
  emit('dirty', true);
  renderer.requestRender();
  return newBody;
}

// 头部「＋ 天体」：落下一轨道槽公式位（与 planetLayouts 布局公式一致，无随机）
function createBody() {
  if (!props.system) return null;
  const sorted = sortPlanetsByOrbit(store.currentSystemPlanets);
  const { angle, orbitRadius } = planetOrbitLayout(sorted.length);
  return createBodyAt(Math.cos(angle) * orbitRadius, Math.sin(angle) * orbitRadius);
}

function deleteBodyById(nodeId) {
  if (!nodeId) return;
  store.removeNode(nodeId);
  if (dragPlanet.value?.nodeId === nodeId) dragPlanet.value = null;
  emit('dirty', true);
  renderer.requestRender();
}

// ===== 太空标记 CRUD（B6）：右键占位交互，类型/名称经模态对话框（批次D1 去 window.prompt）=====
// 类型选择：选项列表，取消返回 null（中止创建）
async function promptSpaceMarkerType() {
  return usePromptDialogState.askChoice({ title: '选择太空标记类型', options: SPACE_MARKER_TYPES });
}

// 在系内相对坐标 (wx, wy) 处创建太空标记（x/y 即相对恒星坐标，无域地图换算）
async function createSpaceMarkerAt(wx, wy) {
  if (!props.system) return null;
  const type = await promptSpaceMarkerType();
  if (!type) return null;
  const name = await usePromptDialogState.askText({ title: '标记名称', label: type.label, defaultValue: `新${type.label}` });
  if (name == null) return null;
  const marker = {
    id: `space_marker_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    systemId: props.system.id,
    x: Math.round(wx),
    y: Math.round(wy),
    type: type.key,
    label: name.trim() || `新${type.label}`,
  };
  store.addSpaceMarker(marker);
  emit('dirty', true);
  renderer.requestRender();
  return marker;
}

function deleteSpaceMarkerById(markerId) {
  if (!markerId) return;
  store.removeSpaceMarker(markerId);
  emit('dirty', true);
  renderer.requestRender();
}

// ===== 部队卡片 CRUD（B7）：信息提示卡片，无任何策略行为 =====
// 类型选择：选项列表 + 名称/阵营输入，任一步取消即中止（批次D1 去 window.prompt）
async function promptFleetKind() {
  return usePromptDialogState.askChoice({ title: '选择部队类型', options: FLEET_KINDS });
}

async function createFleetCardAt(wx, wy) {
  if (!props.system) return null;
  const kind = await promptFleetKind();
  if (!kind) return null;
  const name = await usePromptDialogState.askText({ title: '部队名称', label: kind.label, defaultValue: `新${kind.label}` });
  if (name == null) return null;
  const faction = await usePromptDialogState.askText({ title: '所属阵营', label: '可留空', defaultValue: '' }) ?? '';
  const card = {
    id: `fleet_card_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    systemId: props.system.id,
    x: Math.round(wx),
    y: Math.round(wy),
    name: name.trim() || `新${kind.label}`,
    kind: kind.key,
    faction: faction.trim(),
    note: '',
  };
  store.addFleetCard(card);
  emit('dirty', true);
  renderer.requestRender();
  return card;
}

function deleteFleetCardById(cardId) {
  if (!cardId) return;
  store.removeFleetCard(cardId);
  emit('dirty', true);
  renderer.requestRender();
}

// ===== 右键菜单操作 =====
function ctxAddBodyHere() {
  const { x: worldX, y: worldY } = ctxWorld.value;
  closeContextMenu();
  createBodyAt(worldX, worldY);
}

function ctxAddSpaceMarkerHere() {
  const { x: worldX, y: worldY } = ctxWorld.value;
  closeContextMenu();
  createSpaceMarkerAt(worldX, worldY);
}

function ctxAddFleetCardHere() {
  const { x: worldX, y: worldY } = ctxWorld.value;
  closeContextMenu();
  createFleetCardAt(worldX, worldY);
}

function ctxDeleteNode() {
  const node = ctxTarget.value?.node;
  closeContextMenu();
  if (node) deleteBodyById(node.id);
}

function ctxDeleteSpaceMarker() {
  const marker = ctxTarget.value?.marker;
  closeContextMenu();
  if (marker) deleteSpaceMarkerById(marker.id);
}

function ctxDeleteFleetCard() {
  const card = ctxTarget.value?.card;
  closeContextMenu();
  if (card) deleteFleetCardById(card.id);
}

// ===== 右键菜单扩展（批次D5）：查看信息 / 设为卫星 / 取消卫星 =====
// 查看信息：把节点/标记/卡片交给 NodeDetailPanel（与浏览模式点击选中同通道）
function ctxViewNode() {
  const target = ctxTarget.value;
  closeContextMenu();
  if (!target) return;
  if (target.type === 'planet' || target.type === 'planet-moon') {
    if (target.node) emit('select-node', target.node);
  } else if (target.type === 'star') {
    if (target.node) emit('select-node', target.node);
  } else if (target.type === 'space-marker') {
    const m = target.marker;
    const style = spaceMarkerStyle(m.type);
    emit('select-node', {
      id: m.id,
      name: m.label || style.label,
      layer: 'space_marker',
      layerLabel: '太空标记',
      tags: [style.label, m.systemId].filter(Boolean),
      sourcePath: '',
    });
  } else if (target.type === 'fleet-card') {
    const c = target.card;
    const kind = fleetKindStyle(c.kind);
    emit('select-node', {
      id: c.id,
      name: c.name,
      layer: 'fleet_card',
      layerLabel: '部队卡片',
      tags: [kind.label, c.faction].filter(Boolean),
      sourcePath: '',
    });
  }
}

// 进入「选择母行星」模式：菜单切换为系内行星列表（排除自身）
function ctxBeginPickHost() {
  const node = ctxTarget.value?.node;
  if (!node) return;
  ctxPickHostFor.value = node.id;
  ctxMenu.open(buildMenuItems(), lastMenuPos, canvas.value?.parentElement);
}

function ctxCancelPickHost() {
  ctxPickHostFor.value = null;
  ctxMenu.open(buildMenuItems(), lastMenuPos, canvas.value?.parentElement);
}

// 设为卫星：layer → moon、parentId → 母行星（一次 updateNode 事务，入 undo 栈）。
// userMoved 置 false：卫星布局始终由母行星锚定推导，不读保存坐标。
function ctxSetMoonHost(hostId) {
  const moonId = ctxPickHostFor.value;
  closeContextMenu();
  if (!moonId || !hostId || moonId === hostId) return;
  store.updateNode(moonId, { parentId: hostId, layer: 'moon', userMoved: false });
  emit('dirty', true);
  renderer.requestRender();
}

// 取消卫星：回到恒星独立轨道（公式槽位），名称/坐标保留
function ctxUnsetMoon() {
  const node = ctxTarget.value?.node;
  closeContextMenu();
  if (!node || !props.system) return;
  store.updateNode(node.id, { parentId: props.system.id, layer: node.layer === 'moon' ? 'planet' : node.layer, userMoved: false });
  emit('dirty', true);
  renderer.requestRender();
}

// ===== 行星拖拽收尾 =====
function finalizePlanetDrag() {
  if (!dragPlanet.value) return;
  dragPlanet.value = null;
  store.endNodePositionCapture();
  emit('dirty', true);
  renderer.requestRender();
}

// 边界兜底：鼠标拖拽途中离开画布时 renderer 不派发 onDragEnd，此处补收尾（含撤销记录）
function onCanvasMouseLeave() {
  finalizePlanetDrag();
}

// ===== 命中测试 =====
function hitTest(wx, wy) {
  const bodies = systemBodies.value;
  // B3：双星 — 子恒星命中（优先于主恒星，子恒星在轨道上）
  if (bodies.binaryStars.length > 0) {
    for (let i = 0; i < bodies.binaryStars.length; i++) {
      const a = (i / bodies.binaryStars.length) * Math.PI * 2 + 0.5;
      const bx = Math.cos(a) * 30;
      const by = Math.sin(a) * 30;
      const dxB = wx - bx;
      const dyB = wy - by;
      if (dxB * dxB + dyB * dyB < 12 * 12) {
        return { type: 'star', node: bodies.binaryStars[i] };
      }
    }
  }
  if (layers.isVisible('system_detail', 'nodes')) {
    // 恒星命中（B2：优先于行星，恒星半径较大）
    const starR = getStarRadius(bodies.primaryStar || props.system);
    const dxStar = wx - 0;
    const dyStar = wy - 0;
    if (dxStar * dxStar + dyStar * dyStar < (starR + 5) * (starR + 5)) {
      return { type: 'star', node: bodies.primaryStar || props.system };
    }
    for (const planet of planetLayouts.value) {
      const dx = wx - planet.x;
      const dy = wy - planet.y;
      const rad = getPlanetRadius(planet.layer, planet) + 5;
      if (dx * dx + dy * dy < rad * rad) return { type: 'planet', node: planet };
    }
  }
  // 部队卡片（矩形包围盒，外扩 4px 命中）
  if (layers.isVisible('system_detail', 'fleetCards')) {
    const font = Math.min(55, Math.max(5, Math.round(CARD_FONT_TARGET / renderer.getViewTransform().scale)));
    for (const card of systemFleetCards.value) {
      const box = fleetCardBox(card, font);
      if (wx >= box.x - 4 && wx <= box.x + box.w + 4 && wy >= box.y - 4 && wy <= box.y + box.h + 4) {
        return { type: 'fleet-card', card };
      }
    }
  }
  // 太空标记（菱形，圆形命中域）
  if (layers.isVisible('system_detail', 'markers')) {
    for (const marker of systemSpaceMarkers.value) {
      const dx = wx - marker.x;
      const dy = wy - marker.y;
      if (dx * dx + dy * dy < MARKER_HIT_R * MARKER_HIT_R) return { type: 'space-marker', marker };
    }
  }
  if (layers.isVisible('system_detail', 'hyperlanes')) {
    for (const arrow of neighborArrows.value) {
      const dx = wx - arrow.x;
      const dy = wy - arrow.y;
      if (dx * dx + dy * dy < 28 * 28) return { type: 'jump-arrow', arrow };
    }
  }
  return null;
}

// ===== 绘制 =====
// C2: 拖拽轨道 — 轨道半径吸附（拖拽行星时吸附到最近的标准轨道槽）
const ORBIT_SNAP_THRESHOLD = 12;
function snapOrbitRadius(r) {
  const n = Math.round((r - ORBIT_RING_START) / ORBIT_RING_STEP);
  return Math.max(ORBIT_RING_START, ORBIT_RING_START + Math.max(0, n) * ORBIT_RING_STEP);
}

function drawOrbitDragPreview(ctx) {
  if (!dragPlanet.value) return;
  const px = dragPlanet.value.x;
  const py = dragPlanet.value.y;
  const dist = Math.sqrt(px * px + py * py);
  const snapped = snapOrbitRadius(dist);
  const scale = renderer.getViewTransform().scale;

  ctx.strokeStyle = 'rgba(110, 200, 255, 0.4)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.arc(0, 0, snapped, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = 'rgba(110, 200, 255, 0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(px, py);
  ctx.stroke();

  ctx.fillStyle = '#a0e1ff';
  const font = Math.min(40, Math.max(5, Math.round(11 / scale)));
  ctx.font = `${font}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(`r=${snapped}`, px, py - 8);
}

function drawOrbitRings(ctx) {
  ctx.strokeStyle = 'rgba(110, 170, 230, 0.22)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  for (let r = ORBIT_RING_START; r <= maxOrbitRadius.value + 30; r += ORBIT_RING_STEP) {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

function drawStar(ctx) {
  const matched = store.isNodeMatched(props.system.id);
  const isCurrent = store.isCurrentMatch(props.system.id);
  const bodies = systemBodies.value;
  const primary = bodies.primaryStar;
  // B1: 光谱类型配色（默认 G 型，与之前金色一致，向后兼容）
  const starColor = getStarColor(primary?.starType);

  // B3：双星系统 — 主恒星居中，子恒星绕行（预留：仅渲染子恒星标记，暂不实现质心轨道）
  const binaryStars = bodies.binaryStars;
  if (binaryStars.length > 0) {
    // 子恒星小轨道（虚线环，提示双星系统存在）
    ctx.strokeStyle = 'rgba(255, 170, 50, 0.25)';
    ctx.lineWidth = 0.8;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.arc(0, 0, 30, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // 子恒星（固定角度，按索引均分圆周，确定性无随机）
    binaryStars.forEach((bs, i) => {
      const a = (i / binaryStars.length) * Math.PI * 2 + 0.5;
      const bx = Math.cos(a) * 30;
      const by = Math.sin(a) * 30;
      const bsColor = getStarColor(bs.starType);
      ctx.shadowColor = bsColor.glow;
      ctx.shadowBlur = 10;
      ctx.fillStyle = bsColor.center;
      ctx.beginPath();
      ctx.arc(bx, by, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#e2e8f0';
      const scale = renderer.getViewTransform().scale;
      const font = Math.min(40, Math.max(5, Math.round(9 / scale)));
      ctx.font = `${font}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(bs.displayName || bs.name, bx, by + 14);
    });
  }

  ctx.shadowColor = starColor.glow;
  ctx.shadowBlur = 20;
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 60);
  gradient.addColorStop(0, starColor.center + 'F2');
  gradient.addColorStop(0.3, starColor.mid + '73');
  gradient.addColorStop(1, starColor.outer + '00');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, 60, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = matched ? (isCurrent ? '#fff' : starColor.glow) : starColor.center;
  const starR = getStarRadius(primary || props.system);
  ctx.beginPath();
  ctx.arc(0, 0, matched ? starR + 2 : starR, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.fillStyle = '#e2e8f0';
  // 字号按"目标屏幕字号 / scale"稳定（世界坐标被 scale 放大，字号需反比抵消）
  const scale = renderer.getViewTransform().scale;
  const font = Math.min(70, Math.max(6, Math.round(15 / scale)));
  ctx.font = `bold ${font}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(starName.value || props.system.displayName || props.system.name, 0, font * 1.9);
}

function drawPlanets(ctx) {
  const scale = renderer.getViewTransform().scale;
  for (const planet of planetLayouts.value) {
    const matched = store.isNodeMatched(planet.id);
    const isCurrent = store.isCurrentMatch(planet.id);
    const isHovered = hoveredPlanetId === planet.id;

    // 卫星：绕母行星的虚线小轨道 + 小号天体（批次D5）
    if (planet.isMoon) {
      ctx.strokeStyle = 'rgba(139, 148, 158, 0.35)';
      ctx.lineWidth = 0.8;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.arc(planet.hostX, planet.hostY, planet.moonOrbitRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (matched) {
      ctx.fillStyle = isCurrent ? '#ffd700' : '#ffaa00';
      ctx.shadowColor = isCurrent ? 'rgba(255, 200, 50, 0.8)' : 'rgba(255, 170, 0, 0.6)';
      ctx.shadowBlur = isCurrent ? 15 : 8;
    } else if (isHovered) {
      ctx.fillStyle = '#7affb4';
      ctx.shadowColor = 'rgba(100, 255, 180, 0.6)';
      ctx.shadowBlur = 10;
    } else {
      ctx.fillStyle = planet.isMoon ? '#c9d1d9' : getPlanetColor(planet.layer);
    }
    const r = (planet.isMoon ? 3 : getPlanetRadius(planet.layer, planet) + (matched ? 2 : 0) + 1);
    // C1: 图标优化 — 空间站绘制为方块（区别于行星圆点），标签在 tags 第二项
    const isStation = planet.tags && planet.tags.includes('空间站');
    if (isStation) {
      ctx.beginPath();
      ctx.rect(planet.x - r, planet.y - r, r * 2, r * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(planet.x, planet.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (!renderer.isFastMode()) {
      ctx.fillStyle = '#8b949e';
      const pFont = planet.isMoon
        ? Math.min(45, Math.max(4, Math.round(9 / scale)))
        : Math.min(55, Math.max(5, Math.round(11 / scale)));
      ctx.font = `${pFont}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(planet.displayName || planet.name, planet.x, planet.y + r + pFont * 1.2);
    }
  }
}

// ===== B6 太空标记绘制：菱形图标 + 名称（确定性颜色表） =====
function drawSpaceMarkers(ctx) {
  const scale = renderer.getViewTransform().scale;
  const font = Math.min(55, Math.max(5, Math.round(11 / scale)));
  for (const marker of systemSpaceMarkers.value) {
    const style = spaceMarkerStyle(marker.type);
    ctx.beginPath();
    ctx.moveTo(marker.x, marker.y - MARKER_HALF);
    ctx.lineTo(marker.x + MARKER_HALF, marker.y);
    ctx.lineTo(marker.x, marker.y + MARKER_HALF);
    ctx.lineTo(marker.x - MARKER_HALF, marker.y);
    ctx.closePath();
    ctx.fillStyle = style.color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
    if (!renderer.isFastMode() && marker.label) {
      ctx.fillStyle = style.color;
      ctx.font = `${font}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(marker.label, marker.x, marker.y + MARKER_HALF + font * 1.1);
    }
  }
}

// ===== B7 部队卡片绘制：圆角矩形 + 阵营色边 + kind 图标（仅信息展示，无策略行为） =====
function drawFleetCards(ctx) {
  const scale = renderer.getViewTransform().scale;
  const font = Math.min(55, Math.max(5, Math.round(CARD_FONT_TARGET / scale)));
  for (const card of systemFleetCards.value) {
    const box = fleetCardBox(card, font);
    const color = store.getFactionColor(card.faction);
    // 圆角矩形（手动路径，兼容无 ctx.roundRect 的环境）
    const r = 5;
    ctx.beginPath();
    ctx.moveTo(box.x + r, box.y);
    ctx.lineTo(box.x + box.w - r, box.y);
    ctx.arcTo(box.x + box.w, box.y, box.x + box.w, box.y + r, r);
    ctx.lineTo(box.x + box.w, box.y + box.h - r);
    ctx.arcTo(box.x + box.w, box.y + box.h, box.x + box.w - r, box.y + box.h, r);
    ctx.lineTo(box.x + r, box.y + box.h);
    ctx.arcTo(box.x, box.y + box.h, box.x, box.y + box.h - r, r);
    ctx.lineTo(box.x, box.y + r);
    ctx.arcTo(box.x, box.y, box.x + r, box.y, r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(13, 20, 36, 0.88)';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // 左侧阵营色条
    ctx.fillStyle = color;
    ctx.fillRect(box.x, box.y + r, 3.5, box.h - r * 2);
    // kind 图标 + 名称
    if (!renderer.isFastMode()) {
      ctx.fillStyle = '#dce6f5';
      ctx.font = `bold ${font}px sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(box.name, box.x + 9, box.y + box.h / 2);
      ctx.textBaseline = 'alphabetic';
    }
  }
}

function drawJumpArrows(ctx) {
  const scale = renderer.getViewTransform().scale;
  const font = Math.min(60, Math.max(6, Math.round(11 / scale)));
  for (const a of neighborArrows.value) {
    const hovered = hoveredArrowId === a.id;
    const color = hovered ? 'rgba(160, 225, 255, 0.95)' : (a.crossDomain ? 'rgba(190, 140, 255, 0.75)' : 'rgba(120, 190, 240, 0.75)');

    ctx.strokeStyle = color;
    ctx.lineWidth = hovered ? 2.5 : 1.8;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(Math.cos(a.angle) * a.r0, Math.sin(a.angle) * a.r0);
    ctx.lineTo(a.x, a.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // 箭头头部（燕尾双线，指向角度方向）
    const headLen = 16;
    ctx.lineWidth = hovered ? 3 : 2.2;
    for (const spread of [Math.PI * 0.82, -Math.PI * 0.82]) {
      const a2 = a.angle + spread;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(a.x + Math.cos(a2) * headLen, a.y + Math.sin(a2) * headLen);
      ctx.stroke();
    }

    // 邻系名（沿方向外移，避免压住箭头）
    const lx = a.x + Math.cos(a.angle) * (font + 14);
    const ly = a.y + Math.sin(a.angle) * (font + 14);
    ctx.fillStyle = hovered ? '#a0e1ff' : (a.crossDomain ? 'rgba(200, 160, 255, 0.9)' : 'rgba(150, 200, 245, 0.9)');
    ctx.font = `${font}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(a.neighborName, lx, ly);
    ctx.textBaseline = 'alphabetic';
  }
}

function onRender(ctx) {
  if (!props.system) return;
  drawDeepSpaceBackground(ctx);
  if (layers.isVisible('system_detail', 'orbits') && !renderer.isFastMode()) {
    drawOrbitRings(ctx);
  }
  if (layers.isVisible('system_detail', 'hyperlanes')) {
    drawJumpArrows(ctx);
  }
  if (layers.isVisible('system_detail', 'nodes')) {
    drawStar(ctx);
    drawPlanets(ctx);
  }
  // 太空实体绘制在最上层（B6/B7），与命中测试共用同一 isVisible 门控
  if (layers.isVisible('system_detail', 'markers')) {
    drawSpaceMarkers(ctx);
  }
  if (layers.isVisible('system_detail', 'fleetCards')) {
    drawFleetCards(ctx);
  }
  // C2: 拖拽轨道预览（吸附轨道环 + 径向指示线）
  if (editMode.value && dragPlanet.value) {
    drawOrbitDragPreview(ctx);
  }
}

// ===== Canvas Renderer =====
// A5: 单系视图允许更大缩放（看清行星细节），缩放到 5x，最小 0.1
const renderer = useCanvasRenderer(canvas, {
  minScale: 0.1,
  maxScale: 5,
  onRender,
  onHitTest: (wx, wy) => hitTest(wx, wy),
  onHover: (hit) => {
    hoveredArrowId = hit?.type === 'jump-arrow' ? hit.arrow.id : null;
    hoveredPlanetId = hit?.type === 'planet' ? hit.node.id : null;
    if (canvas.value) {
      // 编辑模式下可拖拽行星显示 move 光标
      if (editMode.value && hit?.type === 'planet' && !hit.node.locked) {
        canvas.value.style.cursor = 'move';
      } else {
        canvas.value.style.cursor = hit ? 'pointer' : 'grab';
      }
    }
  },
  onDragStart: (wx, wy, button, shiftKey, ctrlKey, panTry) => {
    if (button !== 0) return true;
    // 浏览模式：纯平移（本视图节点拖拽仅在编辑模式开放）
    if (!editMode.value) return true;
    // panTry 顶点试探：本视图无顶点编辑，直接允许平移
    if (panTry) return true;
    const hit = hitTest(wx, wy);
    // 命中行星（未锁定且非卫星）→ 轨道编辑拖拽；锁定节点不可拖（仍可平移/选中）；
    // 卫星位置由母行星锚定推导，不可拖（批次D5）
    if (hit?.type === 'planet' && !hit.node.locked && !hit.node.isMoon) {
      store.beginNodePositionCapture(hit.node.id);
      dragPlanet.value = { nodeId: hit.node.id, x: hit.node.x, y: hit.node.y };
      return { mode: 'node', nodeId: hit.node.id };
    }
    return true;
  },
  onDragMove: (wx, wy, dragInfo) => {
    if (dragInfo.mode !== 'node') return;
    if (!dragPlanet.value || dragPlanet.value.nodeId !== dragInfo.nodeId) return;
    // C2: 拖拽轨道 — 拖拽位置吸附到最近的标准轨道槽
    const dist = Math.sqrt(wx * wx + wy * wy);
    const snapped = snapOrbitRadius(dist);
    let sx = wx, sy = wy;
    if (Math.abs(dist - snapped) < ORBIT_SNAP_THRESHOLD && dist > 0) {
      // 吸附：保持角度，半径替换为标准轨道
      const ratio = snapped / dist;
      sx = wx * ratio;
      sy = wy * ratio;
    }
    dragPlanet.value = { nodeId: dragInfo.nodeId, x: sx, y: sy };
    const base = sysBase();
    store.updateNodePosition(dragInfo.nodeId, base.x + sx, base.y + sy);
  },
  onDragEnd: (wx, wy, dragInfo) => {
    if (dragInfo.mode === 'node') {
      finalizePlanetDrag();
    }
  },
  onClick: (hit) => {
    closeContextMenu();
    // 编辑模式：点击不导航（防误触下钻/跳系），仅清理菜单
    if (editMode.value) return;
    if (hit?.type === 'planet') {
      emit('select-node', hit.node);
    } else if (hit?.type === 'star') {
      // B2：点击恒星 → 选中恒星节点（展示详情面板）
      emit('select-node', hit.node);
    } else if (hit?.type === 'jump-arrow') {
      // B5：点击箭头 → 跳转相邻恒星系（仍停留单系视图）
      const neighbor = store.nodes.find(n => n.id === hit.arrow.neighborId);
      if (neighbor) store.selectSystem(neighbor);
    } else if (hit?.type === 'space-marker') {
      // B6：点击标记 → 仅信息提示（伪节点交给 NodeDetailPanel 展示，无导航/策略）
      const style = spaceMarkerStyle(hit.marker.type);
      emit('select-node', {
        id: hit.marker.id,
        name: hit.marker.label || style.label,
        layer: 'space_marker',
        layerLabel: '太空标记',
        tags: [style.label],
        sourcePath: '',
      });
    } else if (hit?.type === 'fleet-card') {
      // B7：点击部队卡片 → 仅信息提示（名称/阵营/类型，无任何策略行为）
      const kind = fleetKindStyle(hit.card.kind);
      emit('select-node', {
        id: hit.card.id,
        name: hit.card.name,
        layer: 'fleet_card',
        layerLabel: '部队卡片',
        tags: [kind.label, hit.card.faction].filter(Boolean),
        sourcePath: '',
      });
    }
  },
  onContextMenu: (wx, wy) => {
    // 右键菜单仅编辑模式开放（浏览模式保持原生行为，不弹菜单）
    if (!editMode.value) return;
    const hit = hitTest(wx, wy);
    let target = null;
    if (hit?.type === 'planet') target = { type: 'planet', node: hit.node };
    else if (hit?.type === 'star') target = { type: 'star', node: hit.node };
    else if (hit?.type === 'space-marker') target = { type: 'space-marker', marker: hit.marker };
    else if (hit?.type === 'fleet-card') target = { type: 'fleet-card', card: hit.card };
    openContextMenu(wx, wy, target);
  },
});

// ===== 生命周期与联动 =====
let fitSystemId = props.system?.id || null;

// 视野自适应：恒星居中，缩放到完整覆盖最外圈轨道 + 箭头环（小视口也能点到箭头）
function fitSystem() {
  const cvs = canvas.value;
  if (!cvs) return;
  const needRadius = maxOrbitRadius.value + 180;
  const scale = Math.min(cvs.clientWidth, cvs.clientHeight) / (needRadius * 2.2);
  renderer.focusOn(0, 0, Math.max(0.2, Math.min(2, scale)));
}

// E2: 撤销历史跳转后重绘画布（历史面板广播）
function onHistoryJump() {
  renderer.requestRender();
}

onMounted(() => {
  renderer.initCanvas();
  canvas.value?.addEventListener('mouseleave', onCanvasMouseLeave);
  fitSystem();
  renderer.requestRender();
  window.addEventListener('sitian:history-jump', onHistoryJump);
});

onUnmounted(() => {
  canvas.value?.removeEventListener('mouseleave', onCanvasMouseLeave);
  window.removeEventListener('sitian:history-jump', onHistoryJump);
  renderer.cleanupCanvas();
});

// 切换恒星系（箭头跳转/面包屑切换）或数据变化时重绘；换系后重新自适应视野
watch(() => [props.system?.id, store.currentSystemPlanets, store.hyperlanes, store.searchResults, store.searchMatchIndex, store.spaceMarkers, store.fleetCards], () => {
  if (props.system?.id !== fitSystemId) {
    fitSystemId = props.system?.id || null;
    fitSystem();
  }
  renderer.requestRender();
}, { deep: true });

defineExpose({
  canvas, renderer, neighborArrows, planetLayouts, allNeighbors, omittedCount, jumpTo,
  // 编辑模式（B3，供测试/父组件访问）
  editMode, toggleEditMode, createBody, createBodyAt, deleteBodyById, contextMenu, dragPlanet,
  // 卫星轨道（批次D5，供测试访问）
  systemBodies, ctxSetMoonHost, ctxUnsetMoon,
  // 太空实体（B6/B7，供测试/父组件访问）
  systemSpaceMarkers, systemFleetCards,
  createSpaceMarkerAt, deleteSpaceMarkerById, createFleetCardAt, deleteFleetCardById,
});
</script>

<style scoped>
.system-detail-container { display: flex; flex-direction: column; height: 100%; }
.map-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--map-header-border);
  background: var(--map-header-bg);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.header-left { display: flex; flex-direction: column; }
.header-title-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
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
.map-header h2 { font-size: 14px; color: var(--map-text-heading); margin-bottom: 4px; }
.hint { font-size: 11px; color: var(--map-text-hint); }
.edit-hint { color: var(--map-accent-green); }
.header-actions { display: flex; gap: 8px; }
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
.header-actions button:hover { background: var(--map-btn-hover); }
.header-actions button.active {
  background: var(--map-accent-green-bg);
  border-color: var(--map-accent-green-border);
  color: var(--map-accent-green);
}
.canvas-wrapper { flex: 1; position: relative; overflow: hidden; }
canvas { display: block; width: 100%; height: 100%; background: var(--map-bg); }

/* 邻系跳转面板（PanelShell 提供外观/拖拽/关闭） */
.system-neighbor-panel {
  right: 12px;
  top: 12px;
  z-index: 30;
  min-width: 200px;
  max-width: 260px;
  max-height: 300px;
}
.neighbor-list { padding: 6px; }
.neighbor-empty { padding: 14px 10px; text-align: center; font-size: 11px; color: var(--text-tertiary); }
.neighbor-omitted { padding: 4px 8px 8px; font-size: 10px; color: #d29922; }
.neighbor-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
}
.neighbor-row:hover { background: var(--accent-bg); color: var(--text-primary); }
.neighbor-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  border: 1px solid var(--panel-border);
  color: var(--accent);
  background: var(--accent-bg);
  flex-shrink: 0;
}
.neighbor-badge.cross { color: #d2a8ff; background: rgba(210, 168, 255, 0.1); }
.neighbor-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.neighbor-dist { font-size: 10px; color: var(--text-tertiary); }

/* ===== 右键菜单（编辑模式，样式与 SystemView 一致） ===== */
/* 右键菜单样式已迁移到统一 ContextMenu 组件（U3）；长列表滚动由其全局样式承担 */
</style>
