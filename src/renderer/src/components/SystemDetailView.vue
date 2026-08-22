<template>
  <div class="system-detail-container">
    <div class="map-header">
      <div class="header-left">
        <div class="header-title-row">
          <button class="back-btn" @click="$emit('back')" title="返回星域地图">← 返回</button>
          <h2>{{ system?.displayName || system?.name || '未知恒星系' }} — 恒星系</h2>
        </div>
        <p class="hint">点击行星进入行星地图 · 点击箭头跳转相邻恒星系 · 滚动缩放 · 拖拽空白处平移</p>
      </div>
    </div>
    <div class="canvas-wrapper">
      <canvas ref="canvas"></canvas>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useGeodataStore } from '../store/geodata';
import { useLayersStore } from '../store/layers';
import { useCanvasRenderer } from '../composables/useCanvasRenderer';
import { planetOrbitLayout, ORBIT_RING_START, ORBIT_RING_STEP, getPlanetColor, getPlanetRadius } from '../composables/systemOrbit';
import { drawDeepSpaceBackground } from '../composables/spaceBackground';

/**
 * 单恒星系详情视图（批次 B4 + B5）
 * - 恒星居中（原点），行星按确定性轨道公式环绕（共享 systemOrbit composable）
 * - 行星手动坐标以"相对恒星偏移"保留（坐标缓存是域地图绝对坐标，此处取相对量）
 * - 邻系箭头基于真实 hyperlanes 邻接（B5）：静态指向 + 点击跳转相邻系
 */
const store = useGeodataStore();
const layers = useLayersStore();

const props = defineProps({
  system: { type: Object, default: null },
});

const emit = defineEmits(['back', 'select-node']);

const canvas = ref(null);
let hoveredArrowId = null;
let hoveredPlanetId = null;

// ===== 行星布局（恒星在原点） =====
const planetLayouts = computed(() => {
  if (!props.system) return [];
  const sysCoord = props.system.coordinate;
  return store.currentSystemPlanets.map((planet, pIdx) => {
    const { angle, orbitRadius } = planetOrbitLayout(pIdx);
    // 手动坐标 → 相对恒星偏移（保留用户在域地图上的相对布局意图）；否则用公式位
    const saved = planet.userMoved && planet.coordinate?.x != null && sysCoord?.x != null;
    return {
      ...planet,
      x: saved ? planet.coordinate.x - sysCoord.x : Math.cos(angle) * orbitRadius,
      y: saved ? planet.coordinate.y - sysCoord.y : Math.sin(angle) * orbitRadius,
      orbitRadius,
      angle,
    };
  });
});

// 最外圈轨道半径（箭头环的基准）
const maxOrbitRadius = computed(() =>
  planetLayouts.value.reduce((max, p) => Math.max(max, p.orbitRadius || ORBIT_RING_START), ORBIT_RING_START)
);

// ===== 邻系跳转箭头（B5：真实 hyperlanes 邻接） =====
const neighborArrows = computed(() => {
  if (!props.system) return [];
  const sys = props.system;
  const sysCoord = sys.coordinate;
  const lanes = store.hyperlanes.filter(h => h.fromId === sys.id || h.toId === sys.id);
  const r = maxOrbitRadius.value + 120;
  const nodeMap = new Map(store.nodes.map(n => [n.id, n]));
  return lanes.map((h, idx) => {
    const neighborId = h.fromId === sys.id ? h.toId : h.fromId;
    const neighbor = nodeMap.get(neighborId);
    // 方向：优先用两系在星域地图上的真实相对方位；缺坐标时按索引确定性均分圆周
    let angle;
    const nCoord = neighbor?.coordinate;
    if (nCoord?.x != null && sysCoord?.x != null && (nCoord.x !== sysCoord.x || nCoord.y !== sysCoord.y)) {
      angle = Math.atan2(nCoord.y - sysCoord.y, nCoord.x - sysCoord.x);
    } else {
      angle = (idx / lanes.length) * Math.PI * 2 - Math.PI / 2;
    }
    return {
      id: h.id,
      hyperlane: h,
      neighborId,
      neighborName: neighbor?.displayName || neighbor?.name || neighborId,
      crossDomain: h.type === 'cross_domain' || (neighbor ? neighbor.parentId !== sys.parentId : false),
      angle,
      r0: maxOrbitRadius.value + 40,
      r1: r,
      x: Math.cos(angle) * r,
      y: Math.sin(angle) * r,
    };
  });
});

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
}

// ===== Canvas Renderer =====
const renderer = useCanvasRenderer(canvas, {
  onRender,
  onHitTest: (wx, wy) => hitTest(wx, wy),
  onHover: (hit) => {
    hoveredArrowId = hit?.type === 'jump-arrow' ? hit.arrow.id : null;
    hoveredPlanetId = hit?.type === 'planet' ? hit.node.id : null;
    if (canvas.value) {
      canvas.value.style.cursor = hit ? 'pointer' : 'grab';
    }
  },
  onDragStart: () => true, // 全部允许平移（本视图无节点拖拽编辑）
  onClick: (hit) => {
    if (hit?.type === 'planet') {
      emit('select-node', hit.node);
    } else if (hit?.type === 'jump-arrow') {
      // B5：点击箭头 → 跳转相邻恒星系（仍停留单系视图）
      const neighbor = store.nodes.find(n => n.id === hit.arrow.neighborId);
      if (neighbor) store.selectSystem(neighbor);
    }
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
  fitSystem();
  renderer.requestRender();
});

onUnmounted(() => {
  renderer.cleanupCanvas();
});

// 切换恒星系（箭头跳转/面包屑切换）或数据变化时重绘；换系后重新自适应视野
watch(() => [props.system?.id, store.currentSystemPlanets, store.hyperlanes, store.searchResults, store.searchMatchIndex], () => {
  if (props.system?.id !== fitSystemId) {
    fitSystemId = props.system?.id || null;
    fitSystem();
  }
  renderer.requestRender();
}, { deep: true });

defineExpose({ canvas, renderer, neighborArrows, planetLayouts });
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
.canvas-wrapper { flex: 1; position: relative; overflow: hidden; }
canvas { display: block; width: 100%; height: 100%; background: var(--map-bg); }
</style>
