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
      <div
        v-if="contextMenu.visible"
        class="context-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
        @mousedown.stop
      >
        <div v-if="contextMenu.target?.type === 'planet'" class="menu-item danger" @click="ctxDeleteNode">🗑 删除该节点</div>
        <div v-if="contextMenu.target?.type === 'space-marker'" class="menu-item danger" @click="ctxDeleteSpaceMarker">🗑 删除标记</div>
        <div v-if="contextMenu.target?.type === 'fleet-card'" class="menu-item danger" @click="ctxDeleteFleetCard">🗑 删除部队卡片</div>
        <div v-if="!contextMenu.target" class="menu-item" @click="ctxAddBodyHere">＋ 添加天体（此位置）</div>
        <div v-if="!contextMenu.target" class="menu-item" @click="ctxAddSpaceMarkerHere">◈ 添加太空标记（此位置）</div>
        <div v-if="!contextMenu.target" class="menu-item" @click="ctxAddFleetCardHere">⚑ 添加部队卡片（此位置）</div>
      </div>
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
import { planetOrbitLayout, ORBIT_RING_START, ORBIT_RING_STEP, getPlanetColor, getPlanetRadius, sortPlanetsByOrbit } from '../composables/systemOrbit';
import { drawDeepSpaceBackground } from '../composables/spaceBackground';
import { SPACE_MARKER_TYPES, FLEET_KINDS } from '../store/geodataModules/spaceEditing';
import PanelShell from './PanelShell.vue';

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
const contextMenu = ref({ visible: false, x: 0, y: 0, target: null, worldX: 0, worldY: 0 });
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

// ===== 行星布局（恒星在原点） =====
const planetLayouts = computed(() => {
  if (!props.system) return [];
  const sysCoord = props.system.coordinate;
  // 轨道顺序按标准化命名罗马数字（衡佑Ⅲ < 津廊Ⅵ），无数字保持原序
  return sortPlanetsByOrbit(store.currentSystemPlanets).map((planet, pIdx) => {
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
    };
  });
});

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

function openContextMenu(wx, wy, target) {
  const pos = worldToScreen(wx, wy);
  const wrapper = canvas.value?.parentElement;
  // 空白菜单最多 3 项（天体/太空标记/部队卡片），预留 ~140px 高度防溢出
  const maxX = wrapper ? wrapper.clientWidth - 180 : pos.x;
  const maxY = wrapper ? wrapper.clientHeight - 140 : pos.y;
  contextMenu.value = {
    visible: true,
    x: Math.max(4, Math.min(pos.x, maxX)),
    y: Math.max(4, Math.min(pos.y, maxY)),
    target,
    worldX: wx,
    worldY: wy,
  };
}

function closeContextMenu() {
  contextMenu.value.visible = false;
}

// ===== 天体 CRUD =====
// 类型选择：window.prompt 数字序（1=行星 2=卫星 3=空间站），取消返回 null（中止创建）
function promptBodyType() {
  const input = window.prompt('天体类型：1=行星 2=卫星 3=空间站（输入数字）', '1');
  if (input == null) return null;
  const idx = parseInt(String(input).trim(), 10) - 1;
  return BODY_TYPES[idx] || BODY_TYPES[0];
}

// 在系内相对坐标 (wx, wy) 处创建天体（存储层换算回域地图绝对坐标）
function createBodyAt(wx, wy) {
  if (!props.system) return null;
  const type = promptBodyType();
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

// ===== 太空标记 CRUD（B6）：右键占位交互，类型/名称经 window.prompt =====
// 类型选择：数字序（1=异常 2=资源点 3=古战场 4=太空兽群），取消返回 null（中止创建）
function promptSpaceMarkerType() {
  const input = window.prompt('标记类型：1=异常 2=资源点 3=古战场 4=太空兽群（输入数字）', '1');
  if (input == null) return null;
  const idx = parseInt(String(input).trim(), 10) - 1;
  return SPACE_MARKER_TYPES[idx] || SPACE_MARKER_TYPES[0];
}

// 在系内相对坐标 (wx, wy) 处创建太空标记（x/y 即相对恒星坐标，无域地图换算）
function createSpaceMarkerAt(wx, wy) {
  if (!props.system) return null;
  const type = promptSpaceMarkerType();
  if (!type) return null;
  const name = window.prompt('标记名称：', `新${type.label}`);
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
// 类型选择：1=太空舰队 2=行星军，再输名称/阵营；任一步取消即中止
function promptFleetKind() {
  const input = window.prompt('部队类型：1=太空舰队 2=行星军（输入数字）', '1');
  if (input == null) return null;
  return String(parseInt(String(input).trim(), 10)) === '2' ? FLEET_KINDS[1] : FLEET_KINDS[0];
}

function createFleetCardAt(wx, wy) {
  if (!props.system) return null;
  const kind = promptFleetKind();
  if (!kind) return null;
  const name = window.prompt('部队名称：', `新${kind.label}`);
  if (name == null) return null;
  const faction = window.prompt('所属阵营（可留空）：', '') ?? '';
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
  const { worldX, worldY } = contextMenu.value;
  closeContextMenu();
  createBodyAt(worldX, worldY);
}

function ctxAddSpaceMarkerHere() {
  const { worldX, worldY } = contextMenu.value;
  closeContextMenu();
  createSpaceMarkerAt(worldX, worldY);
}

function ctxAddFleetCardHere() {
  const { worldX, worldY } = contextMenu.value;
  closeContextMenu();
  createFleetCardAt(worldX, worldY);
}

function ctxDeleteNode() {
  const node = contextMenu.value.target?.node;
  closeContextMenu();
  if (node) deleteBodyById(node.id);
}

function ctxDeleteSpaceMarker() {
  const marker = contextMenu.value.target?.marker;
  closeContextMenu();
  if (marker) deleteSpaceMarkerById(marker.id);
}

function ctxDeleteFleetCard() {
  const card = contextMenu.value.target?.card;
  closeContextMenu();
  if (card) deleteFleetCardById(card.id);
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
  if (layers.isVisible('system_detail', 'nodes')) {
    for (const planet of planetLayouts.value) {
      const dx = wx - planet.x;
      const dy = wy - planet.y;
      const rad = getPlanetRadius(planet.layer) + 5;
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

  ctx.shadowColor = '#ffd700';
  ctx.shadowBlur = 20;
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 60);
  gradient.addColorStop(0, 'rgba(255, 220, 90, 0.95)');
  gradient.addColorStop(0.3, 'rgba(255, 170, 50, 0.45)');
  gradient.addColorStop(1, 'rgba(255, 120, 50, 0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, 60, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = matched ? (isCurrent ? '#fff' : '#ffd700') : '#ffd700';
  ctx.beginPath();
  ctx.arc(0, 0, matched ? 18 : 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.fillStyle = '#e2e8f0';
  // 字号按"目标屏幕字号 / scale"稳定（世界坐标被 scale 放大，字号需反比抵消）
  const scale = renderer.getViewTransform().scale;
  const font = Math.min(70, Math.max(6, Math.round(15 / scale)));
  ctx.font = `bold ${font}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(props.system.displayName || props.system.name, 0, font * 1.9);
}

function drawPlanets(ctx) {
  const scale = renderer.getViewTransform().scale;
  for (const planet of planetLayouts.value) {
    const matched = store.isNodeMatched(planet.id);
    const isCurrent = store.isCurrentMatch(planet.id);
    const isHovered = hoveredPlanetId === planet.id;

    if (matched) {
      ctx.fillStyle = isCurrent ? '#ffd700' : '#ffaa00';
      ctx.shadowColor = isCurrent ? 'rgba(255, 200, 50, 0.8)' : 'rgba(255, 170, 0, 0.6)';
      ctx.shadowBlur = isCurrent ? 15 : 8;
    } else if (isHovered) {
      ctx.fillStyle = '#7affb4';
      ctx.shadowColor = 'rgba(100, 255, 180, 0.6)';
      ctx.shadowBlur = 10;
    } else {
      ctx.fillStyle = getPlanetColor(planet.layer);
    }
    const r = getPlanetRadius(planet.layer) + (matched ? 2 : 0) + 1;
    ctx.beginPath();
    ctx.arc(planet.x, planet.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (!renderer.isFastMode()) {
      ctx.fillStyle = '#8b949e';
      const pFont = Math.min(55, Math.max(5, Math.round(11 / scale)));
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
}

// ===== Canvas Renderer =====
const renderer = useCanvasRenderer(canvas, {
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
    // 命中行星（未锁定）→ 轨道编辑拖拽；锁定节点不可拖（仍可平移/选中）
    if (hit?.type === 'planet' && !hit.node.locked) {
      store.beginNodePositionCapture(hit.node.id);
      dragPlanet.value = { nodeId: hit.node.id, x: hit.node.x, y: hit.node.y };
      return { mode: 'node', nodeId: hit.node.id };
    }
    return true;
  },
  onDragMove: (wx, wy, dragInfo) => {
    if (dragInfo.mode !== 'node') return;
    if (!dragPlanet.value || dragPlanet.value.nodeId !== dragInfo.nodeId) return;
    // 系内相对坐标 (wx, wy) → 域地图绝对坐标（换算基准 system.coordinate）
    dragPlanet.value = { nodeId: dragInfo.nodeId, x: wx, y: wy };
    const base = sysBase();
    store.updateNodePosition(dragInfo.nodeId, base.x + wx, base.y + wy);
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

onMounted(() => {
  renderer.initCanvas();
  canvas.value?.addEventListener('mouseleave', onCanvasMouseLeave);
  fitSystem();
  renderer.requestRender();
});

onUnmounted(() => {
  canvas.value?.removeEventListener('mouseleave', onCanvasMouseLeave);
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
.context-menu {
  position: absolute;
  z-index: 30;
  min-width: 150px;
  padding: 4px 0;
  border: 1px solid var(--map-header-border);
  border-radius: var(--radius-md);
  background: var(--map-header-bg);
  box-shadow: var(--shadow-md);
  user-select: none;
}
.context-menu .menu-item {
  padding: 7px 14px;
  font-size: 12px;
  color: var(--map-btn-text);
  cursor: pointer;
  white-space: nowrap;
}
.context-menu .menu-item:hover { background: rgba(100, 150, 200, 0.15); }
.context-menu .menu-item.danger { color: #ff7b72; }
.context-menu .menu-item.danger:hover { background: rgba(255, 123, 114, 0.12); }
</style>
