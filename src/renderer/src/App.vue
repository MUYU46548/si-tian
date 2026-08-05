<template>
  <div class="app-layout">
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
          >{{ store.currentWorld?.name }}</button>
          <span v-if="store.currentDomain && store.viewLevel === 'system'" class="separator">›</span>
          <button 
            v-if="store.currentDomain && store.viewLevel === 'system'"
            class="active"
          >{{ store.currentDomain?.name }}</button>
          <span v-if="store.currentPlanet" class="separator">›</span>
          <button 
            v-if="store.currentPlanet" 
            class="active"
          >{{ store.currentPlanet?.name }}</button>
        </nav>
        <button @click="store.undo" :disabled="!store.canUndo" :title="undoTooltip">↶</button>
        <button @click="store.redo" :disabled="!store.canRedo" title="重做 (Ctrl+Y)">↷</button>
        <button @click="reextract" title="重新提取">↻</button>
        <button @click="saveData" :disabled="!dirty" title="保存">💾</button>
        <button @click="showExportMenu = !showExportMenu" title="导出">📥</button>
        <span class="status">{{ statusText }}</span>
      </div>
    </header>

    <!-- 导出菜单 -->
    <div v-if="showExportMenu" class="export-menu" @click.self="showExportMenu = false">
      <button @click="handleExportPNG">导出 PNG (当前视图)</button>
      <button @click="handleExportSVG">导出 SVG (当前视图)</button>
      <button @click="handleExportFullPNG">导出 PNG (全图)</button>
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
      </main>
    </div>

    <node-detail-panel />
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
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useGeodataStore } from './store/geodata';
import WorldSelector from './components/WorldSelector.vue';
import GalaxyMap from './components/GalaxyMap.vue';
import SystemView from './components/SystemView.vue';
import PlanetMap from './components/PlanetMap.vue';
import NodeDetailPanel from './components/NodeDetailPanel.vue';
import SearchBar from './components/SearchBar.vue';
import TreeNavigation from './components/TreeNavigation.vue';

const store = useGeodataStore();
const dirty = ref(false);
const statusText = ref('');
const searchBar = ref(null);
const galaxyMapRef = ref(null);
const systemViewRef = ref(null);
const showExportMenu = ref(false);
const perfVisible = ref(false);
const perfStats = ref({});
const undoTooltip = computed(() => {
  const label = store.undoLabel;
  return label ? `撤销: ${label} (Ctrl+Z)` : '撤销 (Ctrl+Z)';
});
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
  
  showExportMenu.value = false;
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
    circles += `<text x="${n.coordinate.x + 8}" y="${n.coordinate.y + 4}" fill="#e2e8f0" font-size="10">${n.name}</text>`;
  });

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${width} ${height}" width="${width}" height="${height}">
  <rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="#0d1117"/>
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
  showExportMenu.value = false;
}

async function handleExportFullPNG() {
  statusText.value = '正在导出全图...';
  
  const nodes = store.nodes;
  const hyperlanes = store.hyperlanes;
  if (nodes.length === 0) return;
  
  const xs = nodes.map(n => n.coordinate?.x || 0).filter(x => x !== null);
  const ys = nodes.map(n => n.coordinate?.y || 0).filter(y => y !== null);
  
  if (xs.length === 0 || ys.length === 0) return;
  
  const minX = Math.min(...xs) - 100;
  const minY = Math.min(...ys) - 100;
  const maxX = Math.max(...xs) + 100;
  const maxY = Math.max(...ys) + 100;
  const width = maxX - minX;
  const height = maxY - minY;

  const tmpCanvas = document.createElement('canvas');
  const dpr = 2; // 2x for high quality
  tmpCanvas.width = width * dpr;
  tmpCanvas.height = height * dpr;
  const ctx = tmpCanvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.translate(-minX, -minY);
  
  // 背景
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(minX, minY, width, height);
  
  // 航道
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  hyperlanes.forEach(h => {
    const from = nodeMap.get(h.fromId);
    const to = nodeMap.get(h.toId);
    if (!from || !to) return;
    ctx.strokeStyle = h.type === 'cross_domain' ? 'rgba(150, 100, 255, 0.5)' : 'rgba(100, 200, 255, 0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(from.coordinate.x, from.coordinate.y);
    ctx.lineTo(to.coordinate.x, to.coordinate.y);
    ctx.stroke();
  });

  // 节点
  nodes.forEach(n => {
    const color = getNodeColor(n.layer);
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(n.coordinate.x, n.coordinate.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    
    // 名称
    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(n.name, n.coordinate.x + 10, n.coordinate.y + 4);
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
  
  showExportMenu.value = false;
}

function getNodeColor(layer) {
  const colors = {
    world: '#d2a8ff', star_domain: '#7c7cff', galaxy: '#ffd700',
    planet: '#5cb85c', city: '#f0ad4e', town: '#d9853b', location: '#888',
  };
  return colors[layer] || '#888';
}

onMounted(async () => {
  statusText.value = '正在加载数据...';
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
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeydown);
  window.removeEventListener('keydown', handlePerfKeydown);
  cleanupNodeUpdated?.();
  cleanupNodeRemoved?.();
  if (perfUpdateTimer) clearInterval(perfUpdateTimer);
});

function handleGlobalKeydown(e) {
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
    showExportMenu.value = false;
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
</script>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #0d1117;
  color: #e2e8f0;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: #161b22;
  border-bottom: 1px solid #30363d;
  gap: 16px;
  position: relative;
}

.toolbar h1 {
  font-size: 16px;
  color: #58a6ff;
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
  border: 1px solid #30363d;
  border-radius: 4px;
  background: #21262d;
  color: #c9d1d9;
  cursor: pointer;
  font-size: 12px;
}

.toolbar-actions button:hover {
  background: #30363d;
}

.toolbar-actions button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
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
  color: #8b949e;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
}

.level-indicator button:hover {
  color: #58a6ff;
  background: #21262d;
}

.level-indicator button.active {
  color: #58a6ff;
  background: #388bfd22;
}

.separator {
  color: #484f58;
  font-size: 14px;
}

.status {
  font-size: 11px;
  color: #8b949e;
  white-space: nowrap;
}

.main-content {
  flex: 1;
  overflow: hidden;
}

.app-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* 导出菜单 */
.export-menu {
  position: absolute;
  top: 50px;
  right: 16px;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  z-index: 200;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
}

.export-menu button {
  padding: 8px 16px;
  border: none;
  border-radius: 4px;
  background: #21262d;
  color: #c9d1d9;
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
  text-align: left;
}

.export-menu button:hover {
  background: #30363d;
}

/* 性能统计面板 */
.perf-panel {
  position: fixed;
  bottom: 20px;
  left: 20px;
  background: rgba(13, 17, 23, 0.95);
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 10px 14px;
  font-size: 11px;
  color: #c9d1d9;
  font-family: 'SFMono-Regular', Consolas, monospace;
  z-index: 300;
  backdrop-filter: blur(8px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  min-width: 180px;
}

.perf-title {
  font-size: 10px;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
  border-bottom: 1px solid #30363d;
  padding-bottom: 4px;
}

.perf-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 3px;
}

.perf-row b {
  color: #58a6ff;
}
</style>
