<template>
  <div class="scenario-map-container">
    <!-- 顶栏：工具 + 模式切换 -->
    <div class="scenario-toolbar">
      <button @click="$emit('exit')" title="返回世界选择" class="back-btn">← 返回</button>
      <div class="tool-group">
        <button 
          :class="{ active: tool === 'select' }" 
          @click="setTool('select')"
          title="选择 (V)"
        >↖</button>
        <button 
          :class="{ active: tool === 'draw' }" 
          @click="setTool('draw')"
          title="绘制省份 (B)"
        >✎</button>
        <button 
          :class="{ active: tool === 'split' }" 
          @click="setTool('split')"
          title="拆分省份 (X)"
        >✂</button>
        <button 
          :class="{ active: tool === 'merge' }" 
          @click="setTool('merge')"
          title="合并省份 (M)"
        >⊕</button>
        <button 
          v-if="viewMode === 'scenario'"
          :class="{ active: tool === 'paint' }" 
          @click="setTool('paint')"
          title="势力油漆桶 (P)"
        >🎨</button>
        <button 
          v-if="viewMode === 'scenario'"
          :class="{ active: tool === 'label' }" 
          @click="setTool('label')"
          title="历史地名 (T)"
        >🏷</button>
      </div>
      <div class="tool-group">
        <button @click="addReferenceImage" title="添加参考图">🖼</button>
        <button @click="handleUndo" :disabled="!canUndo" title="撤销 (Ctrl+Z)">↶</button>
        <button @click="handleRedo" :disabled="!canRedo" title="重做 (Ctrl+Y)">↷</button>
      </div>
      <div class="tool-group">
        <label>模式：</label>
        <select v-model="viewMode" @change="onModeChange">
          <option value="base">底图编辑</option>
          <option value="scenario">剧本模式</option>
        </select>
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
      <canvas ref="canvas" @click="onCanvasClick"></canvas>
    </div>

    <!-- 状态栏 -->
    <div class="scenario-status-bar">
      <span>{{ statusText }}</span>
      <span v-if="viewMode === 'scenario' && selectedScenario">剧本：{{ selectedScenario.name }}</span>
      <span v-if="selectedPolity" class="selected-polity">已选势力：<span class="polity-dot" :style="{ background: selectedPolity.color }"></span>{{ selectedPolity.name }}</span>
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

const store = useGeodataStore();

const canvas = ref(null);
const canvasWrap = ref(null);
const tool = ref('select');
const viewMode = ref('base');
const baseMapKey = ref('德斯特星');
const selectedScenario = ref(null);
const selectedPolity = ref(null);
const ctx = ref(null);
const canUndo = ref(false);
const canRedo = ref(false);
const showScenarioManager = ref(false);

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

const scenarios = computed(() => {
  return store.getScenariosByOwner?.(baseMapKey.value) || [];
});

const sortedScenarios = computed(() => {
  return [...scenarios.value].sort((a, b) => (a.order || 0) - (b.order || 0));
});

const statusText = computed(() => {
  if (!baseMap.value) return '未加载底图';
  return `${baseMap.value.terrain?.length || 0} 省份 | ${baseMap.value.referenceImages?.length || 0} 参考图`;
});

function setTool(t) {
  tool.value = t;
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

function onCanvasClick(event) {
  if (viewMode.value !== 'scenario' || !selectedScenario.value) return;
  
  const rect = canvas.value.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  
  if (tool.value === 'paint' && selectedPolity.value) {
    // Find clicked province and assign polity
    const prov = findProvinceAt(x, y);
    if (prov) {
      store.setOwnership(selectedScenario.value.id, prov.id, selectedPolity.value.id);
      render();
    }
  } else if (tool.value === 'label') {
    // Add historical label at click position
    const text = prompt('输入地名：');
    if (text) {
      store.addScenarioLabel(selectedScenario.value.id, { x, y, text });
      render();
    }
  }
}

function findProvinceAt(x, y) {
  // Simple hit test: check if point is inside any province polygon
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

async function addReferenceImage() {
  const result = await window.sitianAPI.selectReferenceImage();
  if (result?.success) {
    store.addBaseReferenceImage(baseMapKey.value, {
      name: result.name,
      dataUrl: result.dataUrl,
    });
    render();
  }
}

function handleUndo() {
  // TODO: undo integration
}

function handleRedo() {
  // TODO: redo integration
}

function createNewScenario() {
  const baseScenarioId = newScenario.value.inherit && sortedScenarios.value.length > 0
    ? sortedScenarios.value[sortedScenarios.value.length - 1].id
    : null;
  
  const scenarioId = `${baseMapKey.value}/${newScenario.value.name}`;
  
  if (baseScenarioId) {
    store.inheritScenario(scenarioId, baseScenarioId, {
      name: newScenario.value.name,
      era: {
        roman: newScenario.value.roman,
        label: newScenario.value.label,
        startYear: newScenario.value.startYear,
        endYear: newScenario.value.endYear,
      },
      description: newScenario.value.description,
    });
  } else {
    store.createScenario(scenarioId, {
      ownerKey: baseMapKey.value,
      name: newScenario.value.name,
      era: {
        roman: newScenario.value.roman,
        label: newScenario.value.label,
        startYear: newScenario.value.startYear,
        endYear: newScenario.value.endYear,
      },
      description: newScenario.value.description,
    });
  }
  
  // Reset form
  newScenario.value = { name: '', roman: '', label: '', startYear: '', endYear: '', description: '', inherit: true };
  showScenarioManager.value = false;
  
  // Select the new scenario
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

function render() {
  if (!ctx.value) return;
  const cvs = canvas.value;
  const w = cvs.width;
  const h = cvs.height;
  
  ctx.value.clearRect(0, 0, w, h);
  drawBackground(ctx.value, w, h);
  drawProvinces(ctx.value);
  drawLabels(ctx.value);
}

function drawBackground(ctx, w, h) {
  ctx.fillStyle = '#1a2a3a';
  ctx.fillRect(0, 0, w, h);
  
  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  const step = 50;
  for (let x = 0; x < w; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
}

function drawProvinces(c) {
  if (!baseMap.value?.terrain) return;
  
  baseMap.value.terrain.forEach(prov => {
    c.fillStyle = getProvinceColor(prov);
    c.strokeStyle = '#8d8a82';
    c.lineWidth = 0.6;
    
    if (prov.points && Array.isArray(prov.points) && prov.points.length > 2) {
      c.beginPath();
      c.moveTo(prov.points[0].x || prov.points[0][0], prov.points[0].y || prov.points[0][1]);
      for (let i = 1; i < prov.points.length; i++) {
        c.lineTo(prov.points[i].x || prov.points[i][0], prov.points[i].y || prov.points[i][1]);
      }
      c.closePath();
      c.fill();
      c.stroke();
    }
  });
}

function getProvinceColor(prov) {
  if (viewMode.value === 'scenario' && selectedScenario.value) {
    const owner = selectedScenario.value.ownership?.[prov.id];
    if (owner) {
      const polity = selectedScenario.value.polities?.find(p => p.id === owner);
      return polity?.color || '#6b7280';
    }
    return '#4a5568'; // Unowned in scenario mode
  }
  return prov.biomeColor || '#bccda0';
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

let resizeObserver = null;

onMounted(() => {
  const cvs = canvas.value;
  const wrap = canvasWrap.value;
  cvs.width = wrap.clientWidth;
  cvs.height = wrap.clientHeight;
  ctx.value = cvs.getContext('2d');
  
  // Initialize base map if not exists
  if (!store.baseMaps?.[baseMapKey.value]) {
    store.addBaseMap(baseMapKey.value, { name: '德斯特星' });
  }
  
  render();
  
  resizeObserver = new ResizeObserver(handleResize);
  resizeObserver.observe(wrap);
});

onUnmounted(() => {
  if (resizeObserver) {
    resizeObserver.disconnect();
  }
});

watch(baseMap, () => render(), { deep: true });
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
  gap: 16px;
  padding: 8px 12px;
  background: #1e293b;
  border-bottom: 1px solid #334155;
  flex-wrap: wrap;
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

.back-btn:hover {
  background: #475569;
}

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

.tool-group button:hover {
  background: #475569;
}

.tool-group button.active {
  background: #5b21b6;
  border-color: #7c3aed;
}

.tool-group button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 时间轴条 */
.scenario-timeline {
  background: #172033;
  border-bottom: 1px solid #334155;
  padding: 6px 12px;
  overflow-x: auto;
}

.timeline-scroll {
  display: flex;
  gap: 6px;
}

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

.timeline-btn:hover {
  background: #334155;
}

.timeline-btn.active {
  background: #5b21b6;
  border-color: #7c3aed;
  color: #fff;
}

.era-roman {
  font-size: 14px;
  font-weight: 600;
}

.era-label {
  font-size: 10px;
  opacity: 0.8;
}

/* 势力色板 */
.polity-palette {
  display: flex;
  gap: 4px;
  padding: 6px 12px;
  background: #172033;
  border-bottom: 1px solid #334155;
  flex-wrap: wrap;
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
}

.polity-swatch:hover {
  transform: scale(1.1);
}

.polity-swatch.active {
  border-color: #ffd700;
  box-shadow: 0 0 6px rgba(255, 215, 0, 0.5);
}

.polity-swatch.clear {
  background: #475569;
  border-color: #64748b;
}

/* 画布 */
.scenario-canvas-wrap {
  flex: 1;
  position: relative;
  overflow: hidden;
}

.scenario-canvas-wrap canvas {
  width: 100%;
  height: 100%;
  display: block;
  cursor: crosshair;
}

/* 状态栏 */
.scenario-status-bar {
  padding: 6px 12px;
  background: #1e293b;
  border-top: 1px solid #334155;
  color: #94a3b8;
  font-size: 11px;
  display: flex;
  gap: 16px;
}

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

.modal-dialog h3 {
  margin: 0 0 16px;
  font-size: 16px;
}

.scenario-list {
  margin-bottom: 20px;
}

.scenario-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid #334155;
}

.item-era {
  font-weight: 600;
  color: #7c3aed;
  min-width: 20px;
}

.item-name {
  flex: 1;
  font-size: 13px;
}

.item-years {
  font-size: 11px;
  color: #64748b;
}

.item-delete {
  background: none;
  border: none;
  cursor: pointer;
  opacity: 0.5;
}

.item-delete:hover {
  opacity: 1;
}

.new-scenario-form {
  border-top: 1px solid #334155;
  padding-top: 16px;
}

.new-scenario-form h4 {
  margin: 0 0 12px;
  font-size: 14px;
}

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

.form-row input[type="text"],
.form-row textarea {
  flex: 1;
  background: #334155;
  border: 1px solid #475569;
  border-radius: 4px;
  padding: 6px 8px;
  color: #e2e8f0;
  font-size: 12px;
}

.form-row input.short-input {
  max-width: 60px;
}

.form-row.checkbox label {
  min-width: auto;
}

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

.form-actions button:first-child {
  background: #5b21b6;
  border-color: #7c3aed;
}

.form-actions button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
