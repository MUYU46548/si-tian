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
            {{ interactionMode === 'route' ? '点击放置道路顶点 · 双击完成 · 右键取消' : '' }}
            {{ interactionMode === 'marker' ? '点击放置标记' : '' }}
            {{ interactionMode === 'text' ? '点击放置文本标签' : '' }}
            {{ interactionMode === 'zone' ? '拖拽绘制区域 · 松开闭合' : '' }}
            {{ interactionMode === 'building' ? '点击放置建筑' : '' }}
            · <a href="#" @click.prevent="exitEditMode">退出</a>
          </span>
        </p>
      </div>
      <div class="header-actions">
        <template v-if="!editMode">
          <button class="adopt-btn edit-entry-btn" @click="enterEditMode" title="进入编辑模式：绘制区域/道路/标记等">✏️ 编辑地图</button>
        </template>
      </div>
    </div>

    <!-- 编辑工具栏 -->
    <div v-if="editMode" class="edit-toolbar-wrap">
      <div class="edit-toolbar">
        <div class="toolbar-group" title="工具">
          <button :class="{ active: interactionMode === 'pan' }" @click="interactionMode = 'pan'" title="拖拽平移 / 点击选中">🤚 拖手</button>
          <button :class="{ active: interactionMode === 'add_place' }" @click="interactionMode = 'add_place'" title="点击空白处添加地点">➕ 地点</button>
          <button :class="{ active: interactionMode === 'route' }" @click="interactionMode = 'route'" title="绘制道路">🛣️ 道路</button>
          <button :class="{ active: interactionMode === 'marker' }" @click="interactionMode = 'marker'" title="放置标记">📍 标记</button>
          <button :class="{ active: interactionMode === 'text' }" @click="interactionMode = 'text'" title="浮动文本">🔤 文本</button>
          <button :class="{ active: interactionMode === 'zone' }" @click="interactionMode = 'zone'" title="绘制区域">🗺️ 区域</button>
          <button :class="{ active: interactionMode === 'building' }" @click="interactionMode = 'building'" title="放置建筑">🏛️ 建筑</button>
        </div>

        <div class="toolbar-group" title="绘制辅助">
          <button :class="{ active: gridSnapEnabled }" @click="gridSnapEnabled = !gridSnapEnabled" title="网格对齐（绘制/放置自动吸附）">⊞ 网格</button>
          <template v-if="gridSnapEnabled">
            <span class="toolbar-label">间距</span>
            <button v-for="s in [20, 50, 100]" :key="s" :class="{ active: gridSize === s }" @click="gridSize = s">{{ s }}</button>
          </template>
        </div>

        <!-- 道路绘制时的操作按钮 -->
        <div class="toolbar-group" v-if="interactionMode === 'route'">
          <button class="route-confirm-btn" @click="finishRouteDraft" :disabled="routeDraftPoints.length < 2" title="完成道路绘制（至少需要2个顶点）">✅ 完成</button>
          <button class="route-cancel-btn" @click="cancelRouteDraft" title="放弃当前绘制">🚫 取消</button>
          <button @click="undoLastRoutePoint" :disabled="routeDraftPoints.length === 0" title="删除最后一个顶点">⌫ 撤销点</button>
          <span v-if="routeDraftPoints.length === 0" class="toolbar-hint">点击空白处放置第一个顶点</span>
        </div>

        <div class="toolbar-group" title="操作">
          <button @click="deleteSelected" :disabled="!selectedNode" title="删除选中节点 (Del)">🗑 删除</button>
          <button @click="undo" :disabled="!store.canUndo">↶ 撤销</button>
          <button @click="redo" :disabled="!store.canRedo">↷ 重做</button>
        </div>

        <div class="toolbar-group" title="视图">
          <button :class="{ active: showRefImagePanel }" @click="showRefImagePanel = !showRefImagePanel" title="参考底图">🖼 参考图</button>
          <button :class="{ active: compassVisible }" @click="compassVisible = !compassVisible" title="指北针">🧭</button>
          <button :class="{ active: scaleBarVisible }" @click="scaleBarVisible = !scaleBarVisible" title="比例尺">📐</button>
        </div>

        <div class="toolbar-group toolbar-group-exit">
          <button class="toolbar-close" @click="exitEditMode" title="退出编辑模式">✓ 退出</button>
        </div>
      </div>
    </div>

    <!-- 参考图控制面板 -->
    <div v-if="editMode && showRefImagePanel" class="province-editor refimage-editor">
      <div class="editor-header">
        <h3>参考底图</h3>
        <button class="close-btn" @click="showRefImagePanel = false">×</button>
      </div>
      <div class="editor-field">
        <label>导入草图 / 区域轮廓</label>
        <button class="adopt-btn" style="width:100%" @click="importReferenceImage" :disabled="refImageLoading">
          {{ refImageLoading ? '加载中...' : (referenceImages.length > 0 ? '➕ 添加底图' : '📂 选择图片') }}
        </button>
      </div>
      <div class="editor-field" v-if="referenceImages.length > 0">
        <label>底图列表（{{ referenceImages.length }}）</label>
        <div class="ref-list">
          <div v-for="(img, idx) in referenceImages" :key="img.id" class="ref-item"
            :class="{ active: idx === activeRefIndex }" @click="activeRefIndex = idx">
            <span class="ref-item-name">{{ img.name || '底图 ' + (idx + 1) }}</span>
            <button class="ref-item-del" @click.stop="removeRefListItem(idx)" title="删除该底图">×</button>
          </div>
        </div>
      </div>
      <template v-if="referenceImage">
        <div class="editor-field">
          <label>透明度</label>
          <input type="range" min="0.05" max="1" step="0.05" v-model.number="refOpacity" @input="updateRefOpacity" />
          <span class="ref-value">{{ Math.round(refOpacity * 100) }}%</span>
        </div>
        <div class="editor-field">
          <label>缩放</label>
          <input type="range" min="0.05" max="5" step="0.05" v-model.number="refScale" @input="updateRefScale" />
          <span class="ref-value">{{ Math.round(refScale * 100) }}%</span>
        </div>
        <div class="editor-field">
          <label>方向</label>
          <div class="line-style-row">
            <button class="adopt-btn" @click="rotateRefImage" title="顺时针旋转 90°">↻ 旋转</button>
            <button class="adopt-btn" @click="flipRefImageH" title="水平镜像">⇋ 镜像</button>
          </div>
        </div>
        <div class="editor-field">
          <label>锁定</label>
          <div class="line-style-row">
            <button :class="{ active: referenceImage.locked }" @click="toggleRefLocked">🔒 已锁定</button>
            <button :class="{ active: !referenceImage.locked }" @click="toggleRefLocked">🔓 可拖动</button>
          </div>
        </div>
        <div class="editor-field" v-if="!referenceImage.locked">
          <button class="adopt-btn" style="width:100%" @click="refDragMode = !refDragMode" :class="{ 'active-btn': refDragMode }">
            {{ refDragMode ? '✅ 拖动模式已开启' : '🧲 开启拖动模式' }}
          </button>
        </div>
        <div class="editor-field">
          <label>校准</label>
          <button class="adopt-btn" style="width:100%" @click="startCalibration" :class="{ 'active-btn': calibrationMode }">
            {{ calibrationMode ? `📐 校准中 (${calibrationPoints.length}/2)` : '📏 两点校准' }}
          </button>
          <div v-if="calibrationMode" class="calibration-input">
            <span class="toolbar-label">距离</span>
            <input type="number" v-model.number="calibrationDist" min="0.1" step="0.1" style="width:50px" />
            <span class="toolbar-label">km</span>
          </div>
        </div>
        <div class="editor-field" v-if="referenceImage.calibrated">
          <label>状态</label>
          <span class="ref-value" style="color:#3fb950">✓ 已校准</span>
        </div>
        <div class="editor-field">
          <label>移除</label>
          <button class="adopt-btn ghost" style="width:100%" @click="removeReferenceImage">🗑 移除</button>
        </div>
      </template>
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

    <!-- 道路样式选择器 -->
    <div v-if="editMode && interactionMode === 'route'" class="terrain-picker">
      <span class="picker-label">道路样式：</span>
      <button :class="{ active: !routeDashed }" @click="routeDashed = false" title="实线（道路/边界）">➖ 实线</button>
      <button :class="{ active: routeDashed }" @click="routeDashed = true" title="虚线（航线/秘密路线）">〰️ 虚线</button>
      <span class="picker-label">颜色：</span>
      <button
        v-for="c in ROUTE_COLORS"
        :key="c"
        :class="{ active: routeColor === c }"
        :style="{ background: c }"
        @click="routeColor = c"
        class="color-btn"
      ></button>
      <span class="picker-label" v-if="routeDraftPoints.length > 0">{{ routeDraftPoints.length }} 个顶点</span>
    </div>

    <!-- 标记图标选择器 -->
    <div v-if="editMode && interactionMode === 'marker'" class="terrain-picker">
      <span class="picker-label">标记图标：</span>
      <button
        v-for="m in MARKER_ICONS"
        :key="m.icon"
        :class="{ active: markerIcon === m.icon }"
        @click="markerIcon = m.icon"
        class="marker-btn"
      >{{ m.icon }}</button>
      <span class="picker-label">名称</span>
      <input v-model="markerName" class="marker-name-input" placeholder="标记名称（可选）" />
    </div>

    <!-- 文本样式选择器 -->
    <div v-if="editMode && interactionMode === 'text'" class="terrain-picker">
      <span class="picker-label">字号</span>
      <button v-for="s in [12, 16, 22, 30]" :key="s" :class="{ active: textFontSize === s }" @click="textFontSize = s">{{ s }}px</button>
      <button
        v-for="c in TEXT_COLORS"
        :key="c"
        :class="{ active: textColor === c }"
        :style="{ background: c }"
        @click="textColor = c"
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

    <!-- 通用输入对话框 -->
    <div v-if="inputDialogOpen" class="modal-overlay" @click.self="inputDialogOpen = false">
      <div class="modal-dialog">
        <h3>{{ inputDialogTitle }}</h3>
        <div class="form-row">
          <label>{{ inputDialogLabel }}</label>
          <input v-model="inputDialogValue" :placeholder="inputDialogPlaceholder" @keyup.enter="confirmInputDialog" />
        </div>
        <div class="modal-actions">
          <button class="adopt-btn primary" @click="confirmInputDialog">确定</button>
          <button class="adopt-btn ghost" @click="inputDialogOpen = false">取消</button>
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
import { ref, computed, watch, reactive, onMounted, onUnmounted } from 'vue';
import { useGeodataStore } from '../store/geodata';
import { useLayersStore } from '../store/layers';
import { useCanvasRenderer } from '../composables/useCanvasRenderer';
import { pointsBBox, bboxInViewport, pointInViewport } from '../utils/geometry';
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
const selectedNodeIds = ref([]);
const gridSnapEnabled = ref(true);
const gridSize = ref(100);
const ZONE_COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8'];
const ROUTE_COLORS = ['#F39C12', '#E74C3C', '#3498DB', '#2ECC71', '#9B59B6', '#1ABC9C'];
const MARKER_ICONS = [
  { icon: '📍', name: '标记' },
  { icon: '⭐', name: '星标' },
  { icon: '⚔️', name: '战斗' },
  { icon: '💰', name: '宝藏' },
  { icon: '🏰', name: '城堡' },
  { icon: '🗡️', name: '危险' },
  { icon: '🏪', name: '商店' },
  { icon: '🚪', name: '入口' },
];
const TEXT_COLORS = ['#FFFFFF', '#FFD700', '#58a6ff', '#f85149', '#3fb950'];

// 添加地点对话框
const addPlaceDialogOpen = ref(false);
const newPlaceName = ref('');
const newPlaceLayer = ref('facility');
const addPlaceWorldPos = ref({ x: 0, y: 0 });

// 通用输入对话框
const inputDialogOpen = ref(false);
const inputDialogTitle = ref('');
const inputDialogLabel = ref('');
const inputDialogPlaceholder = ref('');
const inputDialogValue = ref('');
const inputDialogCallback = ref(null);

// 区域绘制
const zoneColor = ref('#FF6B6B');
const zoneDraftPoints = ref([]);
const isDrawingZone = ref(false);

// 道路绘制
const routeColor = ref('#F39C12');
const routeDashed = ref(false);
const routeDraftPoints = ref([]);

// 标记放置
const markerIcon = ref('📍');
const markerName = ref('');

// 文本放置
const textFontSize = ref(16);

// ===== 参考图底图 =====
const showRefImagePanel = ref(false);
const refImageLoading = ref(false);
const refDragMode = ref(false);
const refOpacity = ref(0.5);
const refScale = ref(1);
const referenceImages = computed(() => store.areaReferenceImages[props.areaNode?.id] || []);
const activeRefIndex = ref(0);
const referenceImage = computed(() => referenceImages.value[activeRefIndex.value] || null);
const refImageObjs = reactive({});

// ===== 两点校准 =====
const calibrationMode = ref(false);
const calibrationPoints = ref([]);
const calibrationDist = ref(5);
const textColor = ref('#FFFFFF');

// ===== 指北针/比例尺 =====
const compassVisible = ref(true);
const scaleBarVisible = ref(true);
try {
  if (localStorage.getItem('sitian-area-compass') === '0') compassVisible.value = false;
  if (localStorage.getItem('sitian-area-scalebar') === '0') scaleBarVisible.value = false;
} catch(e) {}
watch(compassVisible, (v) => { try { localStorage.setItem('sitian-area-compass', v ? '1' : '0'); } catch(e) {} });
watch(scaleBarVisible, (v) => { try { localStorage.setItem('sitian-area-scalebar', v ? '1' : '0'); } catch(e) {} });

function niceStepArea(raw) {
  if (!isFinite(raw) || raw <= 0) return 100;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const rem = raw / pow;
  let n;
  if (rem <= 1) n = 1;
  else if (rem <= 2) n = 2;
  else if (rem <= 5) n = 5;
  else n = 10;
  return n * pow;
}

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

// 是否有子节点
const hasChildNodes = computed(() => {
  if (!selectedNode.value) return false;
  return store.nodes.some(n => n.parentId === selectedNode.value.id);
});

// 是否为建筑节点
const isSelectedBuilding = computed(() => {
  return selectedNode.value?.layer === 'building';
});

// 当前区域多边形列表
const areaZones = computed(() => {
  if (!props.areaNode) return [];
  return store.areaZones[props.areaNode.id] || [];
});

// 当前区域道路列表
const areaRoutes = computed(() => {
  if (!props.areaNode) return [];
  return store.areaRoutes[props.areaNode.id] || [];
});

// 当前区域标记列表
const areaMarkers = computed(() => {
  if (!props.areaNode) return [];
  return store.areaMarkers[props.areaNode.id] || [];
});

// 当前区域文本列表
const areaTexts = computed(() => {
  if (!props.areaNode) return [];
  return store.areaTextLabels[props.areaNode.id] || [];
});

// 选中区域
const selectedZone = ref(null);

// 定位高亮
const focusHighlightNode = ref(null);
const focusHighlightTimer = ref(null);

// ===== Canvas Renderer =====
// 世界坐标视口（批次C2）：各绘制循环裁剪用；canvas 未就绪时返回 null（不过滤）
function getViewport() {
  const cvs = canvas.value;
  if (!cvs) return null;
  const tl = renderer.screenToWorld(0, 0);
  const br = renderer.screenToWorld(cvs.clientWidth, cvs.clientHeight);
  return {
    minX: Math.min(tl.x, br.x), minY: Math.min(tl.y, br.y),
    maxX: Math.max(tl.x, br.x), maxY: Math.max(tl.y, br.y),
  };
}
// 背景渐变缓存（批次C2）：仅画布尺寸变化时重建，平移/缩放复用同一 gradient 对象
let _bgGradient = { key: '', grad: null };

const renderer = useCanvasRenderer(canvas, {
  onRender: (ctx, w, h) => {
    // 背景（城镇尺度：调亮的深蓝渐变）
    const bgKey = w + 'x' + h;
    if (_bgGradient.key !== bgKey || !_bgGradient.grad) {
      const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
      bg.addColorStop(0, '#2a2a4a');
      bg.addColorStop(1, '#1e2a4a');
      _bgGradient = { key: bgKey, grad: bg };
    }
    ctx.fillStyle = _bgGradient.grad;
    ctx.fillRect(0, 0, w, h);

    // 参考图底图（最底层，地形之下）
    if (editMode.value) {
      drawReferenceImage(ctx);
    }

    // 网格（编辑模式开启时显示）
    if (editMode.value && gridSnapEnabled.value) {
      drawGrid(ctx, w, h);
    }

    const vp = getViewport();

    // 绘制区域多边形
    drawZones(ctx, vp);

    // 绘制道路
    drawRoutes(ctx, vp);

    // 绘制子节点
    drawNodes(ctx, vp);

    // 绘制标记
    drawMarkers(ctx, vp);

    // 绘制文本
    drawTexts(ctx, vp);

    // 绘制区域绘制中的草稿
    if (isDrawingZone.value && zoneDraftPoints.value.length > 0) {
      drawZoneDraft(ctx);
    }

    // 绘制道路草稿
    if (interactionMode.value === 'route' && routeDraftPoints.value.length > 0) {
      drawRouteDraft(ctx);
    }

    // 绘制定位高亮
    if (focusHighlightNode.value) {
      drawFocusHighlight(ctx, focusHighlightNode.value);
    }

    // 绘制校准点
    if (calibrationPoints.value.length > 0) {
      calibrationPoints.value.forEach((p, idx) => {
        ctx.save();
        ctx.strokeStyle = '#FFD700';
        ctx.fillStyle = 'rgba(255, 215, 0, 0.3)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(p.x - 12, p.y);
        ctx.lineTo(p.x + 12, p.y);
        ctx.moveTo(p.x, p.y - 12);
        ctx.lineTo(p.x, p.y + 12);
        ctx.stroke();
        ctx.font = 'bold 12px sans-serif';
        ctx.fillStyle = '#FFD700';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`P${idx + 1}`, p.x + 10, p.y - 10);
        ctx.restore();
      });
    }

    // 指北针（右上角，固定位置）
    if (compassVisible.value) {
      const vt = renderer.getViewTransform();
      const cvs = canvas.value;
      const centerX = cvs.clientWidth / 2 + vt.x;
      const centerY = cvs.clientHeight / 2 + vt.y;
      const worldRight = (cvs.clientWidth - centerX) / vt.scale;
      const worldTop = -centerY / vt.scale;
      
      const compassX = worldRight - 30;
      const compassY = worldTop + 35;
      const compassR = 18;
      ctx.save();
      ctx.fillStyle = 'rgba(10, 14, 24, 0.75)';
      ctx.strokeStyle = 'rgba(120, 160, 190, 0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(compassX, compassY, compassR + 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.font = 'bold 10px sans-serif';
      ctx.fillStyle = '#e2e8f0';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('N', compassX, compassY - compassR + 6);
      ctx.fillText('S', compassX, compassY + compassR - 6);
      ctx.fillText('E', compassX + compassR - 6, compassY);
      ctx.fillText('W', compassX - compassR + 6, compassY);
      ctx.fillStyle = '#f85149';
      ctx.beginPath();
      ctx.moveTo(compassX, compassY - compassR + 1);
      ctx.lineTo(compassX - 5, compassY);
      ctx.lineTo(compassX - 2, compassY);
      ctx.lineTo(compassX - 2, compassY + compassR - 2);
      ctx.lineTo(compassX + 2, compassY + compassR - 2);
      ctx.lineTo(compassX + 2, compassY);
      ctx.lineTo(compassX + 5, compassY);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(226, 232, 240, 0.5)';
      ctx.beginPath();
      ctx.moveTo(compassX, compassY + compassR - 1);
      ctx.lineTo(compassX - 3, compassY + compassR - 6);
      ctx.lineTo(compassX + 3, compassY + compassR - 6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // 比例尺（右下角，固定位置）
    if (scaleBarVisible.value) {
      const vt = renderer.getViewTransform();
      const cvs = canvas.value;
      const centerX = cvs.clientWidth / 2 + vt.x;
      const centerY = cvs.clientHeight / 2 + vt.y;
      const worldRight = (cvs.clientWidth - centerX) / vt.scale;
      const worldBottom = (cvs.clientHeight - centerY) / vt.scale;
      
      const scaleX = worldRight - 120;
      const scaleY = worldBottom - 18;
      const targetPx = 80;
      const worldStep = niceStepArea(targetPx / (cvs.clientWidth / (worldRight - (-centerX / vt.scale))));
      const barPx = worldStep * (cvs.clientWidth / (worldRight - (-centerX / vt.scale)));
      ctx.save();
      ctx.fillStyle = 'rgba(10, 14, 24, 0.75)';
      ctx.fillRect(scaleX - 10, scaleY - 14, barPx + 20, 28);
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(scaleX, scaleY);
      ctx.lineTo(scaleX + barPx, scaleY);
      ctx.moveTo(scaleX, scaleY - 5);
      ctx.lineTo(scaleX, scaleY + 5);
      ctx.moveTo(scaleX + barPx, scaleY - 5);
      ctx.lineTo(scaleX + barPx, scaleY + 5);
      ctx.stroke();
      ctx.font = '11px sans-serif';
      ctx.fillStyle = '#e2e8f0';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const scaleLabel = worldStep >= 1000 ? (worldStep / 1000) + 'km' : worldStep + 'm';
      ctx.fillText(scaleLabel, scaleX + barPx / 2, scaleY + 8);
      ctx.restore();
    }
  },
  onDragStart: handleDragStart,
  onDragMove: handleDragMove,
  onDragEnd: handleDragEnd,
  onHitTest: hitTest,
  onClick: (hit, wx, wy) => {
    if (calibrationMode.value && handleCalibrationClick(wx, wy)) return;
    handleCanvasClick(hit, wx, wy);
  },
  onBoxSelect: handleBoxSelect,
  onWheel: handleWheel,
  onDblClick: handleDblClick,
  interactionMode: interactionMode,
});

function handleDblClick(hit, worldX, worldY) {
  // 道路绘制模式：双击完成
  if (interactionMode.value === 'route' && routeDraftPoints.value.length >= 2) {
    finishRouteDraft();
    return;
  }
  if (hit && hit.layer === 'building') {
    store.selectBuilding(hit);
  } else if (hit && hasChildNodesCheck(hit)) {
    store.selectArea(hit);
  }
}

function hasChildNodesCheck(node) {
  return store.nodes.some(n => n.parentId === node.id);
}

// ===== 定位高亮 =====
function showFocusHighlight(node) {
  focusHighlightNode.value = node;
  if (focusHighlightTimer.value) clearTimeout(focusHighlightTimer.value);
  focusHighlightTimer.value = setTimeout(() => {
    focusHighlightNode.value = null;
    renderer.requestRender();
  }, 2000);
  renderer.requestRender();
}

function drawFocusHighlight(ctx, node) {
  const x = node.coordinate?.x || 0;
  const y = node.coordinate?.y || 0;
  const time = Date.now() / 1000;
  const pulse = Math.sin(time * 4) * 0.5 + 0.5;

  // 外层脉冲光圈
  ctx.save();
  ctx.strokeStyle = '#FFD700';
  ctx.lineWidth = 3;
  ctx.shadowColor = '#FFD700';
  ctx.shadowBlur = 10 + pulse * 10;
  ctx.beginPath();
  ctx.arc(x, y, 18 + pulse * 8, 0, Math.PI * 2);
  ctx.stroke();

  // 内层实心高亮
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(255, 215, 0, 0.3)';
  ctx.beginPath();
  ctx.arc(x, y, 14, 0, Math.PI * 2);
  ctx.fill();

  // 十字标记
  ctx.strokeStyle = '#FFD700';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - 22, y);
  ctx.lineTo(x - 10, y);
  ctx.moveTo(x + 10, y);
  ctx.lineTo(x + 22, y);
  ctx.moveTo(x, y - 22);
  ctx.lineTo(x, y - 10);
  ctx.moveTo(x, y + 10);
  ctx.lineTo(x, y + 22);
  ctx.stroke();
  ctx.restore();
}

// ===== 参考图绘制 =====
function drawReferenceImage(ctx) {
  const refs = referenceImages.value;
  if (!refs || refs.length === 0) return;
  
  refs.forEach((refImg) => {
    if (!refImg || !refImg.dataUrl) return;
    const img = refImageObjs[refImg.id];
    if (!img) return;
    
    const w = (refImg.width || img.width) * (refImg.scale || 1);
    const h = (refImg.height || img.height) * (refImg.scale || 1);
    const rot = (refImg.rotation || 0) % 4;
    const flipH = !!refImg.flipH;
    const cx = refImg.offsetX;
    const cy = refImg.offsetY;
    const drawW = rot % 2 === 0 ? w : h;
    const drawH = rot % 2 === 0 ? h : w;
    
    ctx.save();
    ctx.globalAlpha = refImg.opacity ?? 0.5;
    ctx.translate(cx, cy);
    ctx.rotate(rot * Math.PI / 2);
    if (flipH) ctx.scale(-1, 1);
    ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();
  });
}

// ===== 参考图操作 =====
watch(referenceImages, (list) => {
  if (activeRefIndex.value >= list.length) {
    activeRefIndex.value = Math.max(0, list.length - 1);
  }
  list.forEach(ref => {
    if (ref.dataUrl && refImageObjs[ref.id]?.src !== ref.dataUrl) {
      const img = new Image();
      img.onload = () => { refImageObjs[ref.id] = img; renderer.requestRender(); };
      img.src = ref.dataUrl;
    }
  });
}, { deep: true, immediate: true });

async function importReferenceImage() {
  if (!props.areaNode) return;
  refImageLoading.value = true;
  try {
    const result = await window.sitianAPI.selectReferenceImage();
    if (result?.success && result.dataUrl) {
      const img = new Image();
      img.onload = () => {
        const scale = 500 / img.width;
        const cx = renderer.getViewTransform();
        const center = { x: -cx.x / cx.scale, y: -cx.y / cx.scale };
        const list = referenceImages.value || [];
        const refImage = {
          id: `ref_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
          name: `底图 ${list.length + 1}`,
          dataUrl: result.dataUrl,
          opacity: refOpacity.value,
          locked: false,
          offsetX: center.x,
          offsetY: center.y,
          scale,
          width: img.width,
          height: img.height,
        };
        store.updateAreaReferenceImage(props.areaNode.id, refImage);
        activeRefIndex.value = (referenceImages.value || []).length - 1;
        refImageObjs[refImage.id] = img;
        refImageLoading.value = false;
      };
      img.onerror = () => { refImageLoading.value = false; };
      img.src = result.dataUrl;
    } else {
      refImageLoading.value = false;
    }
  } catch (e) {
    refImageLoading.value = false;
  }
}

function updateRefOpacity() {
  if (!referenceImage.value) return;
  store.updateAreaReferenceImage(props.areaNode.id, {
    ...referenceImage.value,
    opacity: refOpacity.value,
  });
}

function updateRefScale() {
  if (!referenceImage.value) return;
  store.updateAreaReferenceImage(props.areaNode.id, {
    ...referenceImage.value,
    scale: refScale.value,
  });
}

function rotateRefImage() {
  if (!referenceImage.value) return;
  store.updateAreaReferenceImage(props.areaNode.id, {
    ...referenceImage.value,
    rotation: ((referenceImage.value.rotation || 0) + 1) % 4,
  });
}

function flipRefImageH() {
  if (!referenceImage.value) return;
  store.updateAreaReferenceImage(props.areaNode.id, {
    ...referenceImage.value,
    flipH: !referenceImage.value.flipH,
  });
}

function toggleRefLocked() {
  if (!referenceImage.value) return;
  store.updateAreaReferenceImage(props.areaNode.id, {
    ...referenceImage.value,
    locked: !referenceImage.value.locked,
  });
  if (referenceImage.value.locked) refDragMode.value = false;
}

function removeReferenceImage() {
  const ref = referenceImage.value;
  if (!ref) return;
  store.removeAreaReferenceImage(props.areaNode.id, ref.id);
  delete refImageObjs[ref.id];
  refDragMode.value = false;
}

function removeRefListItem(idx) {
  const ref = referenceImages.value[idx];
  if (!ref) return;
  store.removeAreaReferenceImage(props.areaNode.id, ref.id);
  delete refImageObjs[ref.id];
  if (activeRefIndex.value >= referenceImages.value.length) {
    activeRefIndex.value = Math.max(0, referenceImages.value.length - 1);
  }
  refDragMode.value = false;
}

// ===== 两点校准 =====
function startCalibration() {
  if (!referenceImage.value) return;
  calibrationMode.value = !calibrationMode.value;
  calibrationPoints.value = [];
}

function handleCalibrationClick(worldX, worldY) {
  if (!calibrationMode.value) return false;
  calibrationPoints.value.push({ x: worldX, y: worldY });
  renderer.requestRender();
  if (calibrationPoints.value.length >= 2) {
    const p1 = calibrationPoints.value[0];
    const p2 = calibrationPoints.value[1];
    const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    const targetPxPerKm = 100;
    const targetScale = (calibrationDist.value * targetPxPerKm) / dist;
    const ref = referenceImage.value;
    const oldScale = ref.scale || 1;
    const newScale = oldScale * targetScale;
    const midWorldX = (p1.x + p2.x) / 2;
    const midWorldY = (p1.y + p2.y) / 2;
    const oldCx = ref.offsetX;
    const oldCy = ref.offsetY;
    store.updateAreaReferenceImage(props.areaNode.id, {
      ...ref,
      scale: newScale,
      offsetX: oldCx + (midWorldX - oldCx) * (1 - targetScale),
      offsetY: oldCy + (midWorldY - oldCy) * (1 - targetScale),
      ppm: targetPxPerKm,
      calibrated: true,
    });
    calibrationMode.value = false;
    calibrationPoints.value = [];
  }
  return true;
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

  // 网格线
  ctx.strokeStyle = 'rgba(150, 180, 200, 0.18)';
  ctx.lineWidth = 0.5;
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
  
  // 坐标轴（0 线）加粗
  ctx.strokeStyle = 'rgba(150, 180, 200, 0.4)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, worldBottom);
  ctx.moveTo(0, 0);
  ctx.lineTo(worldRight, 0);
  ctx.stroke();
  
  // 网格标签（每 1000 单位或每 step 标注一次，避免拥挤）
  const labelEvery = step >= 1000 ? step : Math.max(1000, Math.ceil(1000 / step) * step);
  ctx.font = '10px sans-serif';
  ctx.fillStyle = 'rgba(150, 180, 200, 0.7)';
  for (let x = startX; x <= worldRight; x += step) {
    if (x !== 0 && x % labelEvery === 0) {
      const sx = (x - worldLeft) * vt.scale;
      const label = x >= 1000 ? (x / 1000) + 'km' : x + 'm';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(label, sx, 2);
    }
  }
  for (let y = startY; y <= worldBottom; y += step) {
    if (y !== 0 && y % labelEvery === 0) {
      const sy = (y - worldTop) * vt.scale;
      const label = y >= 1000 ? (y / 1000) + 'km' : y + 'm';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 2, sy);
    }
  }
}

function drawNodes(ctx, vp) {
  const nodes = areaPlaces.value;
  const fast = renderer.isFastMode(); // 批次C2：拖拽中跳过光晕与名称标签
  nodes.forEach(node => {
    const x = node.coordinate?.x || 0;
    const y = node.coordinate?.y || 0;
    if (!pointInViewport(x, y, vp, 100)) return; // margin 覆盖标签与选中圈
    const isSelected = selectedNode.value?.id === node.id;
    const isMultiSelected = selectedNodeIds.value.includes(node.id);
    const isDraft = node.draft === true;
    const color = getNodeColor(node.layer);

    ctx.fillStyle = color;
    if (!fast) {
      ctx.shadowColor = color;
      ctx.shadowBlur = isSelected ? 12 : 6;
    }
    ctx.beginPath();
    ctx.arc(x, y, isSelected ? 8 : 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    if (isDraft) {
      ctx.strokeStyle = '#888888';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (isSelected || isMultiSelected) {
      ctx.strokeStyle = isSelected ? '#FFD700' : '#58a6ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 12, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (!fast) {
      const label = node.displayName || node.name;
      if (label) {
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#e2e8f0';
        ctx.fillText(label, x, y + 12);
      }
    }
  });
}

function drawZones(ctx, vp) {
  const zones = areaZones.value;
  const fast = renderer.isFastMode();
  zones.forEach(zone => {
    if (!zone.points || zone.points.length < 3) return;
    if (!bboxInViewport(pointsBBox(zone.points), vp)) return; // 批次C2：视口外整块跳过
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

    if (zone.name && !fast) {
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

function drawRoutes(ctx, vp) {
  const routes = areaRoutes.value;
  const fast = renderer.isFastMode(); // 批次C2：拖拽中跳过顶点圆与名称
  routes.forEach(route => {
    if (!route.points || route.points.length < 2) return;
    if (!bboxInViewport(pointsBBox(route.points), vp, 40)) return;
    const color = route.color || '#F39C12';

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (route.dashed) {
      ctx.setLineDash([6, 4]);
    }

    ctx.beginPath();
    ctx.moveTo(route.points[0].x, route.points[0].y);
    for (let i = 1; i < route.points.length; i++) {
      ctx.lineTo(route.points[i].x, route.points[i].y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // 顶点圆合并为单次 fill（批次C2）：此前每顶点独立 beginPath+arc+fill
    if (!fast) {
      ctx.fillStyle = color;
      ctx.beginPath();
      route.points.forEach(p => {
        ctx.moveTo(p.x + 4, p.y);
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      });
      ctx.fill();
    }

    if (route.name && !fast) {
      const midIdx = Math.floor(route.points.length / 2);
      const mid = route.points[midIdx];
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(route.name, mid.x, mid.y - 8);
    }

    ctx.restore();
  });
}

function drawMarkers(ctx, vp) {
  const markers = areaMarkers.value;
  const fast = renderer.isFastMode(); // 批次C2：拖拽中 emoji 字形退化为色点
  markers.forEach(marker => {
    const x = marker.x;
    const y = marker.y;
    if (!pointInViewport(x, y, vp, 80)) return;

    if (fast) {
      ctx.fillStyle = '#FFD700';
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(marker.icon || '📍', x, y);

    if (marker.name) {
      ctx.font = '10px sans-serif';
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(marker.name, x, y + 22);
    }
  });
}

function drawTexts(ctx, vp) {
  const texts = areaTexts.value;
  const fast = renderer.isFastMode(); // 批次C2：拖拽中跳过描边（3 倍文字成本），保留正文
  texts.forEach(label => {
    const x = label.x;
    const y = label.y;
    if (!pointInViewport(x, y, vp, 300)) return; // margin 覆盖长文本
    const fontSize = label.fontSize || 16;
    const color = label.color || '#FFFFFF';

    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (!fast) {
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.lineWidth = 3;
      ctx.strokeText(label.text, x, y);
    }

    ctx.fillStyle = color;
    ctx.fillText(label.text, x, y);
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

function drawRouteDraft(ctx) {
  if (routeDraftPoints.value.length < 1) return;
  ctx.strokeStyle = routeColor.value;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  if (routeDashed.value) {
    ctx.setLineDash([6, 4]);
  }

  ctx.beginPath();
  ctx.moveTo(routeDraftPoints.value[0].x, routeDraftPoints.value[0].y);
  for (let i = 1; i < routeDraftPoints.value.length; i++) {
    ctx.lineTo(routeDraftPoints.value[i].x, routeDraftPoints.value[i].y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  routeDraftPoints.value.forEach(p => {
    ctx.fillStyle = routeColor.value;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
  });
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
const multiDragStartMap = ref(null);

// ===== 交互 =====
function handleDragStart(wx, wy, button, shiftKey, ctrlKey, panTry) {
  if (interactionMode.value === 'add_place') {
    return false;
  }

  if (interactionMode.value === 'building') {
    return false;
  }

  if (interactionMode.value === 'marker' || interactionMode.value === 'text') {
    return false;
  }

  if (interactionMode.value === 'route') {
    return false;
  }

  if (interactionMode.value === 'zone') {
    isDrawingZone.value = true;
    zoneDraftPoints.value = [{ x: wx, y: wy }];
    return false;
  }

  const hit = hitTest(wx, wy);
  if (hit) {
    if (shiftKey || ctrlKey) {
      const idx = selectedNodeIds.value.indexOf(hit.id);
      if (idx === -1) {
        selectedNodeIds.value.push(hit.id);
      } else {
        selectedNodeIds.value.splice(idx, 1);
      }
      selectedNode.value = hit;
    } else {
      if (!selectedNodeIds.value.includes(hit.id)) {
        selectedNodeIds.value = [hit.id];
      }
      selectedNode.value = hit;
    }
    dragStartPos.value = { x: wx, y: wy };
    dragStartNodePos.value = { x: hit.coordinate?.x || 0, y: hit.coordinate?.y || 0 };
    isDraggingNode.value = true;

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

  if (!shiftKey && !ctrlKey) {
    selectedNode.value = null;
    selectedNodeIds.value = [];
    renderer.requestRender();
  }
  return true;
}

function handleDragMove(wx, wy, info) {
  if (isDrawingZone.value) {
    // 批次C2：手绘抽稀——与上一点距离过近不落点，避免一条 zone 累积上千冗余顶点
    const last = zoneDraftPoints.value[zoneDraftPoints.value.length - 1];
    if (!last || Math.hypot(wx - last.x, wy - last.y) >= 3) {
      zoneDraftPoints.value.push({ x: wx, y: wy });
      renderer.requestRender();
    }
    return;
  }

  if (isDraggingNode.value && selectedNode.value) {
    const dx = wx - dragStartPos.value.x;
    const dy = wy - dragStartPos.value.y;

    if (selectedNodeIds.value.length > 1 && multiDragStartMap.value) {
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
  if (isDrawingZone.value) {
    isDrawingZone.value = false;
    finishZoneDrawing();
    return;
  }

  if (isDraggingNode.value && selectedNode.value && info.didPan) {
    if (selectedNodeIds.value.length > 1 && multiDragStartMap.value) {
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
  const snappedPos = gridSnapEnabled.value ? snapPoint({ x: wx, y: wy }) : { x: wx, y: wy };

  if (interactionMode.value === 'add_place') {
    addPlaceWorldPos.value = snappedPos;
    newPlaceName.value = '';
    newPlaceLayer.value = 'facility';
    addPlaceDialogOpen.value = true;
    return;
  }

  if (interactionMode.value === 'route') {
    routeDraftPoints.value.push({ x: snappedPos.x, y: snappedPos.y });
    renderer.requestRender();
    return;
  }

  if (interactionMode.value === 'marker') {
    const marker = {
      id: `marker_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      icon: markerIcon.value,
      name: markerName.value || '',
      x: snappedPos.x,
      y: snappedPos.y,
    };
    store.addAreaMarker(props.areaNode.id, marker);
    markerName.value = '';
    renderer.requestRender();
    return;
  }

  if (interactionMode.value === 'text') {
    showInputDialog({
      title: '放置文本',
      label: '文本内容',
      placeholder: '请输入文本内容...',
      value: '',
      onConfirm: (text) => {
        if (text && text.trim()) {
          const label = {
            id: `text_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            text: text.trim(),
            x: snappedPos.x,
            y: snappedPos.y,
            fontSize: textFontSize.value,
            color: textColor.value,
          };
          store.addAreaTextLabel(props.areaNode.id, label);
          renderer.requestRender();
        }
      }
    });
    return;
  }

  if (interactionMode.value === 'building') {
    showInputDialog({
      title: '放置建筑',
      label: '建筑名称',
      placeholder: '请输入建筑名称...',
      value: '',
      onConfirm: (name) => {
        if (name && name.trim()) {
          const newNode = {
            id: `node_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            name: name.trim(),
            layer: 'building',
            parentId: props.areaNode.id,
            tags: [],
            sourcePath: '',
            coordinate: { x: Math.round(snappedPos.x), y: Math.round(snappedPos.y) },
            draft: true,
          };
          store.addNode(newNode);
          renderer.requestRender();
        }
      }
    });
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
  const nodes = areaPlaces.value;
  const inBox = nodes.filter(n => {
    const x = n.coordinate?.x || 0;
    const y = n.coordinate?.y || 0;
    return x >= box.x1 && x <= box.x2 && y >= box.y1 && y <= box.y2;
  });

  if (shiftKey) {
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

function finishRouteDraft() {
  if (routeDraftPoints.value.length < 2) {
    routeDraftPoints.value = [];
    return;
  }
  const route = {
    id: `route_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    points: routeDraftPoints.value.map(p => ({ x: p.x, y: p.y })),
    dashed: routeDashed.value,
    color: routeColor.value,
    name: `道路 ${(areaRoutes.value.length) + 1}`,
  };
  store.addAreaRoute(props.areaNode.id, route);
  routeDraftPoints.value = [];
  renderer.requestRender();
}

function cancelRouteDraft() {
  routeDraftPoints.value = [];
  renderer.requestRender();
}

function undoLastRoutePoint() {
  if (routeDraftPoints.value.length > 0) {
    routeDraftPoints.value.pop();
    renderer.requestRender();
  }
}

// 通用输入对话框
function showInputDialog({ title, label, placeholder, value, onConfirm }) {
  inputDialogTitle.value = title;
  inputDialogLabel.value = label;
  inputDialogPlaceholder.value = placeholder;
  inputDialogValue.value = value;
  inputDialogCallback.value = onConfirm;
  inputDialogOpen.value = true;
}

function confirmInputDialog() {
  if (inputDialogCallback.value) {
    inputDialogCallback.value(inputDialogValue.value);
  }
  inputDialogOpen.value = false;
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
    draft: true,
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
    window.sitianAPI?.openExternal(`obsidian://open?vault=ROSA&file=${encodeURIComponent(selectedNode.value.sourcePath)}`);
  }
}

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

function enterEditMode() {
  editMode.value = true;
  interactionMode.value = 'pan';
}

function exitEditMode() {
  editMode.value = false;
  isDrawingZone.value = false;
  zoneDraftPoints.value = [];
  routeDraftPoints.value = [];
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
  initNodeCoordinates();
  renderer.fitView(viewBounds.value);
  renderer.requestRender();
  window.addEventListener('keydown', handleKeydown);
  window.addEventListener('sitian:focus-node', onFocusNode);
});

function onFocusNode(e) {
  const node = e.detail;
  if (!node) return;
  const place = areaPlaces.value.find(p => p.id === node.id);
  if (place && place.coordinate?.x !== null && place.coordinate?.x !== undefined) {
    renderer.focusOn(place.coordinate.x, place.coordinate.y, Math.max(renderer.getViewTransform().scale, 1.2));
    showFocusHighlight(place);
    renderer.requestRender();
  }
}

function initNodeCoordinates() {
  const nodes = areaPlaces.value;
  const needsInit = nodes.filter(n => n.coordinate.x === null || n.coordinate.y === null || n.coordinate.x === undefined || n.coordinate.y === undefined);
  if (needsInit.length === 0) return;

  const step = gridSize.value;
  const cols = Math.ceil(Math.sqrt(needsInit.length));
  needsInit.forEach((n, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    n.coordinate = { x: col * step, y: row * step };
  });
  renderer.requestRender();
}

onUnmounted(() => {
  renderer.cleanupCanvas();
  window.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('sitian:focus-node', onFocusNode);
  if (focusHighlightTimer.value) clearTimeout(focusHighlightTimer.value);
});

function handleKeydown(e) {
  const tag = document.activeElement?.tagName;
  const isEditingInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  if (e.key === 'Delete' && !isEditingInput) {
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
  if (e.key === 'Escape' && !isEditingInput) {
    if (editMode.value) exitEditMode();
    else {
      selectedNode.value = null;
      selectedNodeIds.value = [];
    }
    renderer.requestRender();
  }
}

watch(areaPlaces, () => {
  renderer.requestRender();
});
</script>

<style scoped>
/* 复用之前定义的所有样式 */
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
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 13px;
  padding: 4px 8px;
}

.back-btn:hover {
  color: var(--text-primary);
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

.edit-hint {
  color: var(--accent);
}

.edit-hint a {
  color: var(--text-secondary);
  text-decoration: none;
}

.header-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

/* 与行星地图同款按钮基底（批次D4：此前缺失导致编辑入口退化为浏览器默认按钮样式） */
.adopt-btn {
  padding: 6px 12px;
  border: 1px solid var(--nav-border);
  background: var(--btn-bg);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s;
}

.adopt-btn:hover {
  background: var(--btn-bg-hover);
  color: var(--text-primary);
}

.adopt-btn.ghost {
  background: transparent;
}

.edit-entry-btn {
  padding: 6px 14px;
  font-size: 12px;
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 600;
}

.edit-entry-btn:hover {
  background: var(--accent);
  color: #fff;
  filter: brightness(1.15);
}

.edit-toolbar-wrap {
  background: var(--toolbar-bg);
  border-bottom: 1px solid var(--nav-border);
  padding: 6px 12px;
  overflow-x: auto;
}

.edit-toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  min-width: max-content;
}

.toolbar-group {
  display: flex;
  gap: 4px;
  align-items: center;
}

.toolbar-group + .toolbar-group {
  padding-left: 12px;
  border-left: 1px solid var(--nav-border);
}

.toolbar-group button {
  padding: 4px 10px;
  border: 1px solid var(--nav-border);
  background: var(--btn-bg);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 11px;
  white-space: nowrap;
}

.toolbar-group button.active {
  background: var(--accent);
  color: var(--panel-bg);
  border-color: var(--accent);
  animation: pulse-glow 2s ease-in-out infinite;
}

@keyframes pulse-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(88, 166, 255, 0.4); }
  50% { box-shadow: 0 0 0 6px rgba(88, 166, 255, 0); }
}

.toolbar-group button:hover:not(.active) {
  background: var(--btn-bg-hover);
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
  background: #238636 !important;
  border-color: #2ea043 !important;
  color: white !important;
}

.route-confirm-btn {
  background: #238636 !important;
  border-color: #2ea043 !important;
  color: white !important;
}

.route-confirm-btn:disabled {
  background: #1a472a !important;
  border-color: #238636 !important;
  color: var(--text-tertiary) !important;
  cursor: not-allowed !important;
}

.route-cancel-btn {
  background: #da3633 !important;
  border-color: #f85149 !important;
  color: white !important;
}

.toolbar-hint {
  font-size: 10px;
  color: var(--text-tertiary);
  font-style: italic;
}

.terrain-picker {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 6px 12px;
  background: var(--toolbar-bg);
  border-bottom: 1px solid var(--nav-border);
}

.picker-label {
  font-size: 11px;
  color: var(--text-tertiary);
  white-space: nowrap;
}

.color-btn {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
}

.color-btn.active {
  border-color: white;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.3);
}

.marker-btn {
  padding: 4px 8px;
  border: 1px solid var(--nav-border);
  background: var(--btn-bg);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 14px;
}

.marker-btn.active {
  background: var(--accent);
  border-color: var(--accent);
}

.marker-name-input {
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--nav-border);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 11px;
  outline: none;
}

.marker-name-input:focus {
  border-color: var(--accent);
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

.node-detail-popover {
  position: absolute;
  top: 8px;
  right: 8px;
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  min-width: 200px;
  z-index: 20;
}

.popover-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--panel-border);
}

.popover-header h4 {
  font-size: 13px;
  margin: 0;
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 16px;
}

.popover-body {
  padding: 8px 12px;
}

.detail-row {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
}

.detail-label {
  font-size: 10px;
  color: var(--text-tertiary);
  text-transform: uppercase;
  min-width: 50px;
}

.detail-value {
  font-size: 11px;
  color: var(--text-primary);
}

.popover-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.adopt-btn {
  padding: 4px 10px;
  border: 1px solid var(--nav-border);
  background: var(--btn-bg);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 11px;
  white-space: nowrap;
}

.adopt-btn:hover {
  background: var(--btn-bg-hover);
}

.adopt-btn.ghost {
  background: transparent;
}

.adopt-btn.primary {
  background: var(--accent);
  color: var(--panel-bg);
  border-color: var(--accent);
}

.adopt-btn.danger {
  border-color: #f85149;
  color: #f85149;
}

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
  z-index: 100;
}

.modal-dialog {
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-md);
  padding: 20px;
  min-width: 300px;
}

.modal-dialog h3 {
  margin: 0 0 16px 0;
  font-size: 14px;
}

.form-row {
  margin-bottom: 12px;
}

.form-row label {
  display: block;
  font-size: 11px;
  color: var(--text-tertiary);
  margin-bottom: 4px;
}

.form-row input,
.form-row select {
  width: 100%;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--input-border);
  background: var(--input-bg);
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
}

.form-row input:focus,
.form-row select:focus {
  border-color: var(--accent);
}

.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
