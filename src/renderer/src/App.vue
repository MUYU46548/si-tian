<template>
  <div class="app-layout" :class="`theme-${currentTheme}`">
    <header class="toolbar">
      <h1>SiTian</h1>
      <div class="toolbar-center">
        <search-bar ref="searchBar" />
      </div>
      <div class="toolbar-actions">
        <nav class="level-indicator">
          <button 
            :class="{ active: store.viewLevel === 'world' }" 
            @click="store.backToWorld()"
          >世界</button>
          <span v-if="store.currentWorld" class="separator">›</span>
          <button 
            v-if="store.currentWorld" 
            :class="{ active: store.viewLevel === 'domain' }"
            @click="store.backToDomain()"
          >{{ store.currentWorld?.displayName || store.currentWorld?.name }}</button>
          <span v-if="store.currentDomain && (store.viewLevel === 'system' || store.viewLevel === 'planet')" class="separator">›</span>
          <button 
            v-if="store.currentDomain && (store.viewLevel === 'system' || store.viewLevel === 'planet')"
            :class="{ active: store.viewLevel === 'system' }"
            @click="handleBreadcrumbDomain"
            :title="store.viewLevel === 'planet' ? '返回域内恒星系总览' : ''"
          >{{ store.currentDomain?.displayName || store.currentDomain?.name }}</button>
          <span v-if="store.currentPlanet" class="separator">›</span>
          <button 
            v-if="store.currentPlanet"
            :class="{ active: store.viewLevel === 'planet' }"
            @click="store.backToPlanet"
          >{{ store.currentPlanet?.displayName || store.currentPlanet?.name }}</button>
          <span v-if="store.currentArea" class="separator">›</span>
          <button 
            v-if="store.currentArea"
            :class="{ active: store.viewLevel === 'area' }"
            @click="store.backToArea"
          >{{ store.currentArea?.displayName || store.currentArea?.name }}</button>
          <span v-if="store.currentBuilding" class="separator">›</span>
          <button 
            v-if="store.currentBuilding"
            class="active"
          >{{ store.currentBuilding?.displayName || store.currentBuilding?.name }}</button>
        </nav>
        <span class="toolbar-divider"></span>
        <button @click="store.undo" :disabled="!store.canUndo" :title="undoTooltip">↶</button>
        <button @click="store.redo" :disabled="!store.canRedo" title="重做 (Ctrl+Y)">↷</button>
        <button @click="reextract" title="重新提取">↻</button>
        <button @click="saveData" :disabled="!dirty" title="保存">💾</button>
        <span class="toolbar-divider"></span>
        <button v-if="store.viewLevel !== 'world'" @click="toggleLayersPanel" title="图层面板 (L)" :class="{ active: layersStore.panelOpen }">☷</button>
        <button v-if="store.viewLevel !== 'world'" @click="panelsStore.toggle('bookmarks')" title="视口书签" :class="{ active: panelsStore.isOpen('bookmarks') }">📌</button>
        <span class="toolbar-divider"></span>
        <button @click="panelsStore.toggle('export')" title="导出">📥</button>
        <span class="toolbar-divider"></span>
        <button @click="settingsPanelRef?.open()" title="设置">⚙️</button>
        <button @click="aboutPanelRef?.open()" title="帮助 (F1)">?</button>
        <button @click="keyboardShortcutsRef?.open()" title="快捷键 (Ctrl+?)">⌨</button>
        <button @click="changeLogRef?.open()" title="变更日志">📋</button>
        <button @click="validateDataIntegrity" title="数据检查">🔍</button>
        <button @click="toggleTheme" :title="`切换到${currentTheme === 'dark' ? '亮色' : '暗色'}主题`">{{ currentTheme === 'dark' ? '🌙' : '☀️' }}</button>
        <span class="status">{{ statusText }}</span>
      </div>
    </header>

    <!-- 导出菜单 -->
    <div v-if="panelsStore.isOpen('export')" class="export-menu" @click.self="panelsStore.close('export')">
      <button @click="handleExportPNG">导出 PNG (当前视图)</button>
      <button @click="handleExportSVG">导出 SVG (当前视图)</button>
      <button @click="handleExportFullPNG">导出 PNG (全图)</button>
      <div class="export-divider"></div>
      <button @click="handleExportMapConfig">导出地图配置 (JSON)</button>
      <button @click="handleImportMapConfig">导入地图配置...</button>
    </div>
    
    <div class="app-body">
      <tree-navigation />
      <main class="main-content">
        <world-selector
          v-if="store.viewLevel === 'world'"
          :worlds="store.worlds"
          :domains="store.starDomains"
          :galaxies="store.galaxies"
          :planets="store.planets"
          :locations="store.locations"
          @select="store.selectWorld"
          @create-world="handleCreateWorld"
          @delete-world="handleDeleteWorld"
          @reextract="reextract"
        />
        
        <galaxy-map
          v-if="store.viewLevel === 'domain'"
          ref="galaxyMapRef"
          :world="store.currentWorld"
          :domains="store.currentWorldDomains"
          :galaxies="store.galaxies"
          @select="store.selectDomain"
          @back="store.backToWorld"
          @dirty="dirty = true"
          @select-node="store.selectNode"
        />
        
        <system-view
          v-if="store.viewLevel === 'system'"
          ref="systemViewRef"
          :domain="store.currentDomain"
          :systems="store.currentDomainGalaxies"
          :planets="store.planets"
          :locations="store.locations"
          @back="store.backToDomain"
          @select-node="store.selectPlanetOrNode"
        />
        
        <planet-map
          v-if="store.viewLevel === 'planet'"
          ref="planetMapRef"
          :planet="store.currentPlanet"
          @back="store.backToSystem"
          @select-node="store.selectNode"
          @dirty="dirty = true"
        />
        
        <area-map
          v-if="store.viewLevel === 'area'"
          ref="areaMapRef"
          :area-node="store.currentArea"
          @back="store.backToPlanet"
          @select-node="store.selectNode"
          @dirty="dirty = true"
        />
        
        <interior-view
          v-if="store.viewLevel === 'interior'"
          ref="interiorViewRef"
          :building-node="store.currentBuilding"
        />
      </main>
    </div>

    <node-detail-panel />
    <layer-panel />
    <about-panel ref="aboutPanelRef" />
    <batch-import-panel ref="batchImportPanelRef" />
    <settings-panel ref="settingsPanelRef" />
    <onboarding-guide />
    <recovery-panel />
    <keyboard-shortcuts ref="keyboardShortcutsRef" />
    <change-log ref="changeLogRef" />
    <bookmark-panel
      v-if="panelsStore.isOpen('bookmarks')"
      :bookmarks="bookmarks"
      :current-index="currentIndex"
      @close="panelsStore.close('bookmarks')"
      @navigate="handleBookmarkNavigate"
      @add="handleAddBookmark"
      @remove="handleRemoveBookmark"
      @clear="handleClearBookmarks"
    />
    <!-- 性能统计面板 -->
    <div v-if="perfVisible" class="perf-panel">
      <div class="perf-title">性能统计 (开发模式)</div>
      <div class="perf-row">FPS: <b>{{ perfStats.fps || 0 }}</b></div>
      <div class="perf-row">帧时间: <b>{{ perfStats.lastFrameTime?.toFixed(2) || 0 }}ms</b></div>
      <div class="perf-row">平均: <b>{{ perfStats.avgFrameTime?.toFixed(2) || 0 }}ms</b></div>
      <div class="perf-row">峰值: <b>{{ perfStats.peakFrameTime?.toFixed(2) || 0 }}ms</b></div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useGeodataStore } from './store/geodata';
import { usePanelsStore } from './store/panels';
import WorldSelector from './components/WorldSelector.vue';
import GalaxyMap from './components/GalaxyMap.vue';
import SystemView from './components/SystemView.vue';
import PlanetMap from './components/PlanetMap.vue';
import AreaMap from './components/AreaMap.vue';
import InteriorView from './components/InteriorView.vue';
import NodeDetailPanel from './components/NodeDetailPanel.vue';
import SearchBar from './components/SearchBar.vue';
import TreeNavigation from './components/TreeNavigation.vue';
import LayerPanel from './components/LayerPanel.vue';
import AboutPanel from './components/AboutPanel.vue';
import BatchImportPanel from './components/BatchImportPanel.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import OnboardingGuide from './components/OnboardingGuide.vue';
import RecoveryPanel from './components/RecoveryPanel.vue';
import KeyboardShortcuts from './components/KeyboardShortcuts.vue';
import BookmarkPanel from './components/BookmarkPanel.vue';
import ChangeLog from './components/ChangeLog.vue';
import { useLayersStore } from './store/layers';
import { useTheme } from './composables/useTheme';
import { useBookmarks } from './composables/useBookmarks';
import { measurePerformance, cleanupTestNodes } from './utils/stressTest';

const store = useGeodataStore();
const layersStore = useLayersStore();
const panelsStore = usePanelsStore();
const { currentTheme, toggleTheme, initTheme } = useTheme();
const { bookmarks, currentIndex, addBookmark, removeBookmark, clearAll } = useBookmarks();
const dirty = ref(false);
const statusText = ref('');
const searchBar = ref(null);
const galaxyMapRef = ref(null);
const systemViewRef = ref(null);
const perfVisible = ref(false);
const perfStats = ref({});
const aboutPanelRef = ref(null);
const batchImportPanelRef = ref(null);
const settingsPanelRef = ref(null);
const keyboardShortcutsRef = ref(null);
const changeLogRef = ref(null);

// ===== 面板互斥（P0-2）：图层面板接入全局面板注册表 =====
function toggleLayersPanel() {
  layersStore.togglePanel();
  if (layersStore.panelOpen) panelsStore.open('layers');
  else panelsStore.closeAll();
}

// 其他浮层面板打开时，自动关闭图层面板
watch(() => panelsStore.openPanelId, (id) => {
  if (id !== 'layers' && layersStore.panelOpen) {
    layersStore.panelOpen = false;
  }
});
const undoTooltip = computed(() => {
  const label = store.undoLabel;
  return label ? `撤销: ${label} (Ctrl+Z)` : '撤销 (Ctrl+Z)';
});

// 面包屑点击星域：行星地图/区域地图/建筑内部 → 返回域内恒星系总览（system 视图）
function handleBreadcrumbDomain() {
  if (store.viewLevel === 'planet' || store.viewLevel === 'area' || store.viewLevel === 'interior') {
    store.backToSystem();
  }
}
let cleanupNodeUpdated = null;
let cleanupNodeRemoved = null;
let perfUpdateTimer = null;

// 获取当前活动的 renderer ref
function getActiveRenderer() {
  if (store.viewLevel === 'domain') {
    return galaxyMapRef.value?.renderer;
  } else if (store.viewLevel === 'system') {
    return systemViewRef.value?.renderer;
  }
  return null;
}

// 获取当前活动的 canvas ref
function getActiveCanvas() {
  if (store.viewLevel === 'domain') {
    return galaxyMapRef.value?.canvas;
  } else if (store.viewLevel === 'system') {
    return systemViewRef.value?.canvas;
  }
  return null;
}

// 导出功能已内联实现，无需 useMapExport

async function handleExportPNG() {
  const canvas = getActiveCanvas();
  if (!canvas) return;
  
  statusText.value = '正在导出...';
  
  // 创建临时 canvas，HiDPI 适配
  const tmpCanvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  tmpCanvas.width = canvas.clientWidth * dpr;
  tmpCanvas.height = canvas.clientHeight * dpr;
  const ctx = tmpCanvas.getContext('2d');
  ctx.drawImage(canvas, 0, 0, tmpCanvas.width, tmpCanvas.height);
  
  tmpCanvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sitian-${store.viewLevel}-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(url);
    statusText.value = '导出完成';
  });
  
  panelsStore.close('export');
}

async function handleExportSVG() {
  statusText.value = '正在导出 SVG...';
  
  const nodes = store.nodes;
  const hyperlanes = store.hyperlanes;
  const canvas = getActiveCanvas();
  if (!canvas || nodes.length === 0) return;

  const xs = nodes.map(n => n.coordinate?.x || 0).filter(x => x !== null);
  const ys = nodes.map(n => n.coordinate?.y || 0).filter(y => y !== null);
  
  if (xs.length === 0 || ys.length === 0) return;
  
  const minX = Math.min(...xs) - 100;
  const minY = Math.min(...ys) - 100;
  const maxX = Math.max(...xs) + 100;
  const maxY = Math.max(...ys) + 100;
  const width = maxX - minX;
  const height = maxY - minY;
  
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  
  // 背景色跟随当前主题
  const isDark = currentTheme.value !== 'light';
  const bgColor = isDark ? '#0d1117' : '#ffffff';
  const textColor = isDark ? '#e2e8f0' : '#1f2328';
  
  let paths = '';
  hyperlanes.forEach(h => {
    const from = nodeMap.get(h.fromId);
    const to = nodeMap.get(h.toId);
    if (!from || !to) return;
    paths += `<line x1="${from.coordinate.x}" y1="${from.coordinate.y}" x2="${to.coordinate.x}" y2="${to.coordinate.y}" stroke="rgba(100,200,255,0.5)" stroke-width="2"/>`;
  });
  
  let circles = '';
  nodes.forEach(n => {
    const color = getNodeColor(n.layer);
    circles += `<circle cx="${n.coordinate.x}" cy="${n.coordinate.y}" r="6" fill="${color}"/>`;
    circles += `<text x="${n.coordinate.x + 8}" y="${n.coordinate.y + 4}" fill="${textColor}" font-size="10">${n.name}</text>`;
  });
  
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${width} ${height}" width="${width}" height="${height}">
  <rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="${bgColor}"/>
  ${paths}
  ${circles}
</svg>`;
  
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sitian-${store.viewLevel}-${Date.now()}.svg`;
  a.click();
  URL.revokeObjectURL(url);
  
  statusText.value = '导出完成';
  panelsStore.close('export');
}

async function handleExportFullPNG() {
  statusText.value = '正在导出全图...';
  
  const nodes = store.nodes;
  const hyperlanes = store.hyperlanes;
  if (nodes.length === 0) return;
  
  const xs = nodes.map(n => n.coordinate?.x || 0).filter(x => x !== null);
  const ys = nodes.map(n => n.coordinate?.y || 0).filter(y => y !== null);
  
  if (xs.length === 0 || ys.length === 0) return;
  
  const minX = Math.min(...xs) - 150;
  const minY = Math.min(...ys) - 150;
  const maxX = Math.max(...xs) + 150;
  const maxY = Math.max(...ys) + 150;
  const width = maxX - minX;
  const height = maxY - minY;
  
  const tmpCanvas = document.createElement('canvas');
  const dpr = 2; // 2x for high quality
  tmpCanvas.width = width * dpr;
  tmpCanvas.height = height * dpr;
  const ctx = tmpCanvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.translate(-minX, -minY);
  
  // 背景色跟随当前主题
  const isDark = currentTheme.value !== 'light';
  const textColor = isDark ? '#e8edf6' : '#1f2328';
  
  // 1. 背景渐变（暗色：深蓝灰径向；亮色：浅灰线性）
  if (isDark) {
    const bg = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(width, height) * 0.72);
    bg.addColorStop(0, '#151b2e');
    bg.addColorStop(0.5, '#0f1424');
    bg.addColorStop(1, '#0a0e1a');
    ctx.fillStyle = bg;
  } else {
    const bg = ctx.createLinearGradient(0, minY, 0, maxY);
    bg.addColorStop(0, '#f8fafc');
    bg.addColorStop(1, '#eef2f7');
    ctx.fillStyle = bg;
  }
  ctx.fillRect(minX, minY, width, height);
  
  // 2. 星云 + 星尘（仅暗色主题，保证导出图有太空氛围）
  if (isDark) {
    const nebulae = [
      { x: minX + width * 0.3, y: minY + height * 0.4, r: width * 0.25, color: 'rgba(70, 100, 190, 0.07)' },
      { x: minX + width * 0.7, y: minY + height * 0.6, r: width * 0.2, color: 'rgba(140, 70, 170, 0.06)' },
    ];
    for (const neb of nebulae) {
      const g = ctx.createRadialGradient(neb.x, neb.y, 0, neb.x, neb.y, neb.r);
      g.addColorStop(0, neb.color);
      g.addColorStop(0.6, neb.color.replace('0.', '0.0'));
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.fillRect(neb.x - neb.r, neb.y - neb.r, neb.r * 2, neb.r * 2);
    }
    ctx.fillStyle = 'rgba(220, 230, 245, 0.12)';
    for (let i = 0; i < 300; i++) {
      const x = minX + ((i * 97 + 23) % Math.floor(width));
      const y = minY + ((i * 61 + 41) % Math.floor(height));
      ctx.beginPath();
      ctx.arc(x, y, (i % 3) * 0.4 + 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  
  // 3. 势力边界（星域分组 → 星系凸包 → 半透明染色 + 边界线 + 星域名标签）
  const domainGalaxyMap = new Map();
  nodes.filter(n => n.layer === 'galaxy').forEach(g => {
    if (g.coordinate?.x === null || g.coordinate?.x === undefined) return;
    if (!domainGalaxyMap.has(g.parentId)) domainGalaxyMap.set(g.parentId, []);
    domainGalaxyMap.get(g.parentId).push(g);
  });
  for (const [domainId, galaxies] of domainGalaxyMap) {
    const domain = nodeMap.get(domainId);
    if (!domain || galaxies.length < 3) continue;
    const pts = galaxies.map(g => ({ x: g.coordinate.x, y: g.coordinate.y })).filter(p => p.x !== null && p.y !== null);
    if (pts.length < 3) continue;
    const hull = convexHullForExport(pts);
    if (hull.length < 3) continue;
    const cx = hull.reduce((s, p) => s + p.x, 0) / hull.length;
    const cy = hull.reduce((s, p) => s + p.y, 0) / hull.length;
    const expanded = hull.map(p => {
      const dx = p.x - cx, dy = p.y - cy;
      const dist = Math.hypot(dx, dy) || 1;
      return { x: p.x + (dx / dist) * 25, y: p.y + (dy / dist) * 25 };
    });
    const color = getDomainColorForExport(domain.displayName || domain.name);
    ctx.beginPath();
    ctx.moveTo(expanded[0].x, expanded[0].y);
    for (let i = 1; i < expanded.length; i++) ctx.lineTo(expanded[i].x, expanded[i].y);
    ctx.closePath();
    ctx.fillStyle = color.replace('hsl(', 'hsla(').replace(')', isDark ? ', 0.15)' : ', 0.10)');
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
    // 星域名标签（带衬底，保证可读）
    const label = domain.displayName || domain.name;
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const m = ctx.measureText(label);
    ctx.fillStyle = isDark ? 'rgba(10, 14, 26, 0.72)' : 'rgba(255, 255, 255, 0.8)';
    ctx.beginPath();
    ctx.roundRect(cx - m.width / 2 - 8, cy - 12, m.width + 16, 24, 5);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(label, cx, cy + 1);
  }
  
  // 4. 航道（分类型颜色 + 辉光，跨域虚线）
  hyperlanes.forEach(h => {
    const from = nodeMap.get(h.fromId);
    const to = nodeMap.get(h.toId);
    if (!from || !to || from.coordinate?.x === null || to.coordinate?.x === null) return;
    const color = h.type === 'cross_domain'
      ? (isDark ? 'rgba(190, 130, 255, 0.75)' : 'rgba(110, 70, 200, 0.55)')
      : h.type === 'hyperjump'
        ? (isDark ? 'rgba(255, 120, 120, 0.7)' : 'rgba(200, 70, 70, 0.5)')
        : (isDark ? 'rgba(120, 210, 255, 0.6)' : 'rgba(60, 140, 200, 0.5)');
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.strokeStyle = color;
    ctx.lineWidth = h.type === 'cross_domain' ? 2.5 : 2;
    if (h.type === 'cross_domain') ctx.setLineDash([8, 5]);
    ctx.beginPath();
    ctx.moveTo(from.coordinate.x, from.coordinate.y);
    ctx.lineTo(to.coordinate.x, to.coordinate.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  });
  
  // 5. 节点 + 光晕 + 亮核 + 带衬底名称标签（导出可读性核心）
  nodes.forEach(n => {
    if (n.coordinate?.x === null || n.coordinate?.x === undefined) return;
    const color = getNodeColor(n.layer);
    const r = n.layer === 'world' ? 10 : n.layer === 'star_domain' ? 9 : n.layer === 'galaxy' ? 7 : 5;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(n.coordinate.x, n.coordinate.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.arc(n.coordinate.x - 1, n.coordinate.y - 1, r * 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    
    const label = n.displayName || n.name;
    ctx.font = (n.layer === 'world' || n.layer === 'star_domain' ? 'bold ' : '') + '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const m = ctx.measureText(label);
    const pad = 4;
    ctx.fillStyle = isDark ? 'rgba(8, 12, 22, 0.65)' : 'rgba(255, 255, 255, 0.75)';
    ctx.beginPath();
    ctx.roundRect(n.coordinate.x + r + 4, n.coordinate.y - 7, m.width + pad * 2, 14, 3);
    ctx.fill();
    ctx.fillStyle = textColor;
    ctx.fillText(label, n.coordinate.x + r + 4 + pad, n.coordinate.y + 1);
  });
  
  tmpCanvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sitian-full-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(url);
    statusText.value = '导出完成';
  });
  
  panelsStore.close('export');
}

function getNodeColor(layer) {
  const colors = {
    world: '#d2a8ff', star_domain: '#7c7cff', galaxy: '#ffd700',
    planet: '#5cb85c', city: '#f0ad4e', town: '#d9853b', location: '#888',
  };
  return colors[layer] || '#888';
}

// ===== 全图导出辅助（Stellaris 风格） =====

function convexHullForExport(points) {
  if (points.length < 3) return points;
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (O, A, B) => (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function getDomainColorForExport(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 62%, 58%)`;
}

// ===== 导入/导出地图配置 =====

function handleExportMapConfig() {
  const config = {
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    viewLevel: store.viewLevel,
    currentWorld: store.currentWorld?.id || null,
    currentDomain: store.currentDomain?.id || null,
    nodes: store.nodes.map(n => ({
      id: n.id,
      name: n.name,
      layer: n.layer,
      coordinate: n.coordinate,
      tags: n.tags,
    })),
    hyperlanes: store.hyperlanes,
  };
  
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sitian-map-config-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  
  panelsStore.close('export');
  statusText.value = '地图配置已导出';
}

function handleImportMapConfig() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    try {
      const text = await file.text();
      const config = JSON.parse(text);
      
      if (!config.version || !config.nodes || !config.hyperlanes) {
        alert('无效的地图配置文件格式');
        return;
      }
      
      // 导入节点坐标
      config.nodes.forEach(importedNode => {
        const existingNode = store.nodes.find(n => n.id === importedNode.id);
        if (existingNode) {
          existingNode.coordinate = importedNode.coordinate;
        }
      });
      
      // 导入航道
      config.hyperlanes.forEach(importedH => {
        const exists = store.hyperlanes.some(h => h.id === importedH.id);
        if (!exists) {
          store.hyperlanes.push(importedH);
        }
      });
      
      statusText.value = `已导入 ${config.nodes.length} 个节点和 ${config.hyperlanes.length} 条航道`;
      dirty.value = true;
    } catch (err) {
      alert('导入失败: ' + err.message);
    }
  };
  input.click();
  
  panelsStore.close('export');
}

// ===== 压力测试 =====

function runStressTest() {
  if (window.__stressTestResults) {
    console.log('[压力测试] 清理之前的测试数据...');
    window.cleanupStressTest();
  }
  
  const results = measurePerformance(store, 400);
  window.__stressTestResults = results;
  
  console.log('[压力测试] 完成！使用 window.cleanupStressTest() 清理测试数据。');
  return results;
}

function cleanupStressTest() {
  if (!window.__stressTestResults) {
    console.log('[压力测试] 没有测试数据需要清理');
    return;
  }
  
  const count = window.__stressTestResults.nodeCount;
  cleanupTestNodes(store);
  
  console.log(`[压力测试] 已清理测试节点`);
  window.__stressTestResults = null;
  store.scheduleAutoSave();
}

// ===== 世界管理（WorldSelector） =====

function handleCreateWorld() {
  const id = `world_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  store.addNode({
    id,
    name: `新世界${Date.now() % 1000}`,
    layer: 'world',
    parentId: null,
    tags: ['世界', '新创建'],
    sourcePath: '',
    coordinate: { x: null, y: null },
  });
  dirty.value = true;
  statusText.value = `已创建「新世界${Date.now() % 1000}」，可在左侧树中选中后重命名`;
  setTimeout(() => { statusText.value = ''; }, 4000);
}

function handleDeleteWorld(world) {
  const childCount = store.starDomains.filter(d => d.parentId === world.id).length;
  const msg = `确定删除世界「${world.name}」吗？\n\n` +
    (childCount > 0 ? `该世界下有 ${childCount} 个星域（及其星系/行星）将失去上级关联。\n` : '') +
    `仅从地图缓存移除，不删除 Obsidian 文件。可撤销。`;
  if (!confirm(msg)) return;
  store.removeNode(world.id);
  dirty.value = true;
  statusText.value = `世界「${world.name}」已从地图移除`;
  setTimeout(() => { statusText.value = ''; }, 4000);
}

// ===== 书签管理 =====

function handleAddBookmark() {
  const renderer = getActiveRenderer();
  if (!renderer) return;
  
  const vt = renderer.getViewTransform();
  const layerState = layersStore.layers;
  addBookmark(`书签 ${bookmarks.value.length + 1}`, vt, store.viewLevel, layerState);
  statusText.value = '书签已添加';
}

function handleBookmarkNavigate(bm) {
  const renderer = getActiveRenderer();
  if (!renderer) return;
  
  renderer.focusOn(
    -bm.viewTransform.x / bm.viewTransform.scale,
    -bm.viewTransform.y / bm.viewTransform.scale,
    bm.viewTransform.scale
  );
  
  // 恢复图层状态
  if (bm.layerState) {
    Object.entries(bm.layerState).forEach(([view, layers]) => {
      Object.entries(layers).forEach(([layerId, cfg]) => {
        if (layersStore.layers[view]?.[layerId]) {
          layersStore.layers[view][layerId].visible = cfg.visible;
        }
      });
    });
  }
  
  // 切换视图级别
  if (bm.viewLevel && bm.viewLevel !== store.viewLevel) {
    if (bm.viewLevel === 'domain') {
      store.backToDomain();
    } else if (bm.viewLevel === 'system') {
      store.backToSystem();
    } else if (bm.viewLevel === 'planet') {
      store.backToSystem();
    }
  }
  
  panelsStore.close('bookmarks');
}

function handleRemoveBookmark(id) {
  removeBookmark(id);
  statusText.value = '书签已删除';
}

function handleClearBookmarks() {
  clearAll();
  statusText.value = '所有书签已清除';
}

// 暴露到全局
window.runStressTest = runStressTest;
window.cleanupStressTest = cleanupStressTest;

onMounted(async () => {
  statusText.value = '正在加载数据...';
  initTheme();
  await store.loadGeodata();
  statusText.value = `已加载 ${store.nodes.length} 个节点`;
  window.addEventListener('keydown', handleGlobalKeydown);
  window.addEventListener('keydown', handlePerfKeydown);

  // Vault 监听事件
  cleanupNodeUpdated = window.sitianAPI.onNodeUpdated((data) => {
    store.handleNodeUpdated(data.node);
    statusText.value = `已更新: ${data.node.name}`;
  });
  cleanupNodeRemoved = window.sitianAPI.onNodeRemoved((data) => {
    store.handleNodeRemoved(data.nodeId);
    statusText.value = `已删除节点`;
  });

  // 性能面板定时更新
  perfUpdateTimer = setInterval(() => {
    if (perfVisible.value) {
      const renderer = getActiveRenderer();
      if (renderer?.getPerfStats) {
        perfStats.value = renderer.getPerfStats();
      }
    }
  }, 250);

  // 设置面板事件
  window.addEventListener('sitian:reextract', () => {
    reextract();
  });
  window.addEventListener('sitian:validate-data', () => {
    validateDataIntegrity();
  });
  window.addEventListener('sitian:backup-cache', () => {
    performBackup();
  });
  window.addEventListener('sitian:open-batch-import', () => {
    batchImportPanelRef.value?.open();
  });
  window.addEventListener('sitian:clear-cache', () => {
    clearCoordinateCache();
  });
  // PlanetMap 本地面板打开时，关闭 App 层浮层面板（面板互斥）
  window.addEventListener('sitian:panel-open', closeAppPanels);

  // 启动时静默备份 .sitian/ 缓存（P1-2 数据安全；主进程已自动备份，这里兜底确认）
  if (window.sitianAPI?.backupSitianCache) {
    window.sitianAPI.backupSitianCache().catch(() => {});
  }
});

function closeAppPanels() {
  panelsStore.closeAll();
}

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeydown);
  window.removeEventListener('keydown', handlePerfKeydown);
  cleanupNodeUpdated?.();
  cleanupNodeRemoved?.();
  if (perfUpdateTimer) clearInterval(perfUpdateTimer);
  window.removeEventListener('sitian:panel-open', closeAppPanels);
});

function handleGlobalKeydown(e) {
  if (e.key === 'F1') {
    e.preventDefault();
    aboutPanelRef.value?.open();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    store.undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
    e.preventDefault();
    store.redo();
    return;
  }
  if (e.key === 'Escape') {
    panelsStore.closeAll();
  }
  if (e.key === 'l' || e.key === 'L') {
    if (store.viewLevel === 'domain' || store.viewLevel === 'system' || store.viewLevel === 'planet') {
      e.preventDefault();
      toggleLayersPanel();
    }
  }
}

function handlePerfKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'D') {
    e.preventDefault();
    perfVisible.value = !perfVisible.value;
  }
}

async function reextract() {
  statusText.value = '正在重新提取...';
  await store.reextract();
  dirty.value = false;
  statusText.value = `已更新 ${store.nodes.length} 个节点`;
}

async function saveData() {
  await store.saveGeodata();
  dirty.value = false;
  statusText.value = '已保存';
}

// ===== 数据备份（P1-2）：.sitian/ → .sitian/backups/ 带时间戳 =====
async function performBackup() {
  if (!window.sitianAPI?.backupSitianCache) return;
  statusText.value = '正在备份数据...';
  try {
    const result = await window.sitianAPI.backupSitianCache();
    if (result?.success) {
      statusText.value = result.count > 0
        ? `✓ 已备份 ${result.count} 个文件 → ${result.backupDir}`
        : '备份完成（当前无缓存文件）';
    } else {
      statusText.value = `✗ 备份失败: ${result?.error || '未知错误'}`;
    }
  } catch (e) {
    statusText.value = '✗ 备份失败';
  }
}

// ===== 数据完整性检查 =====
function validateDataIntegrity() {
  const nodes = store.nodes;
  const issues = [];
  
  // 孤立节点（parentId 指向不存在的节点）
  const nodeIds = new Set(nodes.map(n => n.id));
  for (const node of nodes) {
    if (node.parentId && !nodeIds.has(node.parentId)) {
      issues.push({ type: 'broken-parent', node: node.name, detail: `parentId "${node.parentId}" 不存在` });
    }
  }
  
  // 重复 ID
  const idCounts = {};
  for (const node of nodes) {
    idCounts[node.id] = (idCounts[node.id] || 0) + 1;
  }
  for (const [id, count] of Object.entries(idCounts)) {
    if (count > 1) {
      issues.push({ type: 'duplicate-id', detail: `ID "${id}" 出现 ${count} 次` });
    }
  }
  
  // 坐标异常
  for (const node of nodes) {
    const x = node.coordinate?.x;
    const y = node.coordinate?.y;
    if (x !== null && (typeof x !== 'number' || !isFinite(x) || Math.abs(x) > 10000)) {
      issues.push({ type: 'invalid-coord', node: node.name, detail: `X 坐标异常: ${x}` });
    }
    if (y !== null && (typeof y !== 'number' || !isFinite(y) || Math.abs(y) > 10000)) {
      issues.push({ type: 'invalid-coord', node: node.name, detail: `Y 坐标异常: ${y}` });
    }
  }
  
  // 显示结果
  if (issues.length === 0) {
    alert('✅ 数据完整性检查通过，未发现问题。');
    statusText.value = '数据检查完成：无问题';
  } else {
    const summary = `发现 ${issues.length} 个问题:\n\n` + issues.slice(0, 10).map(i => `• [${i.type}] ${i.node ? i.node + ' - ' : ''}${i.detail}`).join('\n');
    alert(summary);
    statusText.value = `数据检查完成：${issues.length} 个问题`;
  }
}

// ===== 清除坐标缓存 =====
async function clearCoordinateCache() {
  // 删除 geodata.json 和 mapdata.json 的缓存
  // 通过主进程 API 删除文件
  try {
    await window.sitianAPI.clearCoordinateCache();
    // 重新加载
    await store.loadGeodata();
    statusText.value = '坐标缓存已清除，数据已重新提取';
    dirty.value = false;
  } catch (e) {
    console.error('Failed to clear cache:', e);
    alert('清除缓存失败: ' + e.message);
  }
}
</script>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--app-bg);
  color: var(--text-primary);
}

.theme-dark {
  --app-bg: #0d1117;
  --toolbar-bg: #161b22;
  --toolbar-border: #30363d;
  --nav-bg: #161b22;
  --nav-border: #30363d;
  --btn-bg: #21262d;
  --btn-bg-hover: #30363d;
  --text-primary: #e2e8f0;
  --text-secondary: #c9d1d9;
  --text-tertiary: #8b949e;
  --accent: #58a6ff;
  --accent-bg: #388bfd22;
  --separator: #484f58;
  --panel-bg: #161b22;
  --panel-border: #30363d;
  --input-bg: #0d1117;
  --input-border: #30363d;
  /* GalaxyMap / SystemView shared */
  --map-bg: #0c1020;
  --map-header-bg: #101828;
  --map-header-border: #1e2d45;
  --map-btn-bg: #1a2540;
  --map-btn-border: #2a3a55;
  --map-btn-hover: #253555;
  --map-btn-text: #d0d8e8;
  --map-text-heading: #f0f6fc;
  --map-text-hint: #8b9ab0;
  --map-accent-green: #7affb4;
  --map-accent-green-bg: #0d4718;
  --map-accent-green-border: #2ea043;
  --map-accent-blue: #58a6ff;
  --map-panel-shadow: rgba(0,0,0,0.5);
  --map-filter-border: #3a4a65;
  /* PlanetMap */
  --planet-bg: #E8F4F8;
  --planet-header-bg: rgba(255,255,255,0.6);
  --planet-header-border: #C8E6C9;
  --planet-text: #2D3436;
  --planet-text-secondary: #636E72;
  --planet-text-link: #5B8DEF;
  --planet-btn-bg: white;
  --planet-btn-border: #C8E6C9;
  --planet-btn-hover: #F0F7F4;
  --planet-btn-active-bg: #4ECDC4;
  --planet-btn-active-border: #4ECDC4;
  --planet-editor-bg: rgba(255,255,255,0.95);
  --planet-editor-border: #e0e0e0;
  --planet-input-bg: #fff;
  --planet-input-border: #ddd;
  --planet-input-focus: #5B8DEF;
  --planet-tag-bg: #E8F4F8;
  --planet-tag-border: #C8E6C9;
  /* ===== 设计令牌（P0-1）：间距/圆角/阴影/z-index/玻璃面板 ===== */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 10px;
  --radius-xl: 12px;
  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.2);
  --shadow-md: 0 4px 16px rgba(0, 0, 0, 0.35);
  --shadow-lg: 0 12px 40px rgba(0, 0, 0, 0.5);
  --z-eagle: 20;
  --z-panel: 30;
  --z-context-menu: 100;
  --z-modal: 900;
  --panel-glass: rgba(255, 255, 255, 0.8);
  --panel-glass-strong: rgba(255, 255, 255, 0.95);
  --panel-glass-soft: rgba(255, 255, 255, 0.6);
}

.theme-light {
  --app-bg: #ffffff;
  --toolbar-bg: #f6f8fa;
  --toolbar-border: #d0d7de;
  --nav-bg: #f6f8fa;
  --nav-border: #d0d7de;
  --btn-bg: #f6f8fa;
  --btn-bg-hover: #eaeef2;
  --text-primary: #1f2328;
  --text-secondary: #656d76;
  --text-tertiary: #8c959f;
  --accent: #0969da;
  --accent-bg: #ddf4ff;
  --separator: #d0d7de;
  --panel-bg: #ffffff;
  --panel-border: #d0d7de;
  --input-bg: #ffffff;
  --input-border: #d0d7de;
  /* GalaxyMap / SystemView shared */
  --map-bg: #f0f4f8;
  --map-header-bg: #ffffff;
  --map-header-border: #e2e8f0;
  --map-btn-bg: #f6f8fa;
  --map-btn-border: #d0d7de;
  --map-btn-hover: #eaeef2;
  --map-btn-text: #1f2328;
  --map-text-heading: #1f2328;
  --map-text-hint: #656d76;
  --map-accent-green: #2ea043;
  --map-accent-green-bg: #dafbe1;
  --map-accent-green-border: #2ea043;
  --map-accent-blue: #0969da;
  --map-panel-shadow: rgba(0,0,0,0.1);
  --map-filter-border: #d0d7de;
  /* PlanetMap */
  --planet-bg: #E8F4F8;
  --planet-header-bg: rgba(255,255,255,0.6);
  --planet-header-border: #C8E6C9;
  --planet-text: #2D3436;
  --planet-text-secondary: #636E72;
  --planet-text-link: #5B8DEF;
  --planet-btn-bg: white;
  --planet-btn-border: #C8E6C9;
  --planet-btn-hover: #F0F7F4;
  --planet-btn-active-bg: #4ECDC4;
  --planet-btn-active-border: #4ECDC4;
  --planet-editor-bg: rgba(255,255,255,0.95);
  --planet-editor-border: #e0e0e0;
  --planet-input-bg: #fff;
  --planet-input-border: #ddd;
  --planet-input-focus: #5B8DEF;
  --planet-tag-bg: #E8F4F8;
  --planet-tag-border: #C8E6C9;
  /* ===== 设计令牌（P0-1）：与暗色主题一致 ===== */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 10px;
  --radius-xl: 12px;
  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.15);
  --shadow-md: 0 4px 16px rgba(0, 0, 0, 0.18);
  --shadow-lg: 0 12px 40px rgba(0, 0, 0, 0.25);
  --z-eagle: 20;
  --z-panel: 30;
  --z-context-menu: 100;
  --z-modal: 900;
  --panel-glass: rgba(255, 255, 255, 0.8);
  --panel-glass-strong: rgba(255, 255, 255, 0.95);
  --panel-glass-soft: rgba(255, 255, 255, 0.6);
}

.app-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.main-content {
  flex: 1;
  overflow: hidden;
}

/* 视图切换进入动画（P2-3）：v-if 重新挂载时淡入 + 轻微上移，一次触发不影响交互 */
.main-content > * {
  animation: view-fade-in 0.28s ease-out;
}
@keyframes view-fade-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: var(--toolbar-bg);
  border-bottom: 1px solid var(--toolbar-border);
  gap: 16px;
  position: relative;
}

.toolbar h1 {
  font-size: 16px;
  color: var(--accent);
  min-width: 60px;
}

.toolbar-center {
  flex: 1;
  display: flex;
  justify-content: center;
}

.toolbar-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 280px;
  justify-content: flex-end;
}

.toolbar-actions button {
  padding: 5px 10px;
  border: 1px solid var(--toolbar-border);
  border-radius: var(--radius-sm);
  background: var(--btn-bg);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
}

.toolbar-actions button:hover {
  background: var(--btn-bg-hover);
}

.toolbar-actions button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 工具栏分组分隔线（P0-1） */
.toolbar-divider {
  width: 1px;
  height: 18px;
  background: var(--toolbar-border);
  margin: 0 2px;
  flex-shrink: 0;
}

.level-indicator {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 13px;
}

.level-indicator button {
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
}

.level-indicator button:hover {
  color: var(--accent);
  background: var(--btn-bg);
}

.level-indicator button.active {
  color: var(--accent);
  background: var(--accent-bg);
}

.separator {
  color: var(--separator);
  font-size: 14px;
}

.status {
  font-size: 11px;
  color: var(--text-tertiary);
  white-space: nowrap;
}

/* 导出菜单 */
.export-menu {
  position: absolute;
  top: 50px;
  right: 16px;
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-md);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  z-index: var(--z-context-menu);
  box-shadow: var(--shadow-md);
}

.export-menu button {
  padding: 8px 16px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--btn-bg);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
  text-align: left;
}

.export-divider {
  height: 1px;
  background: var(--panel-border);
  margin: 4px 0;
}

.export-menu button:hover {
  background: var(--btn-bg-hover);
}

/* 性能统计面板 */
.perf-panel {
  position: fixed;
  bottom: 16px;
  right: 16px;
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-md);
  padding: 12px;
  font-size: 11px;
  color: var(--text-secondary);
  z-index: 100;
  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
}

.perf-title {
  font-weight: bold;
  margin-bottom: 8px;
  color: var(--text-primary);
}

.perf-row {
  margin-bottom: 4px;
}

.perf-row b {
  color: var(--accent);
}
</style>

<!-- 全局面板动画（P1-3）：非 scoped，供所有浮层面板组件引用 -->
<style>
@keyframes sitian-panel-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
/* 浮层面板统一入场动画 + 统一阴影由各面板组件各自 box-shadow 令牌控制 */
.export-menu,
.bookmarks-panel,
.layer-panel,
.cluster-panel,
.object-panel,
.snapshot-panel,
.province-editor,
.context-menu,
.search-results-panel,
.no-results-panel,
.filter-panel,
.filter-panel-galaxy,
.perf-panel {
  animation: sitian-panel-in 0.15s ease-out;
}
</style>
