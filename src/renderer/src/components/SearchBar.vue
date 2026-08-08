<template>
  <div class="search-bar-container">
    <div class="search-input-wrapper">
      <span class="search-icon">🔍</span>
      <input
        ref="input"
        v-model="query"
        type="text"
        placeholder="搜索节点... (Ctrl+F)"
        @input="onInput"
        @keydown.enter="onEnter"
        @keydown.esc="onEsc"
        @focus="showResults = true"
      />
      <span v-if="query" class="match-count" :class="{ 'no-results': showNoResults }">
        {{ store.searchResults.length > 0 ? `${store.searchMatchIndex + 1}/${store.searchResults.length}` : (showNoResults ? '无结果' : '0') }}
        <span v-if="filterCount > 0" class="filter-badge">{{ filterCount }}</span>
      </span>
      <button v-if="query" class="clear-btn" @click="clear">×</button>
      <button 
        class="filter-btn" 
        :class="{ active: store.searchLayerFilter.length > 0 }"
        @click="store.isFilterOpen = !store.isFilterOpen"
        title="类型过滤"
      >⚲</button>
    </div>

    <!-- 浮动搜索结果面板 -->
    <div v-if="showResults && query && store.searchResults.length > 0" class="search-results-panel" @click.stop>
      <div class="results-header">
        <span>搜索结果</span>
        <span class="results-count">{{ store.searchResults.length }} 个结果</span>
      </div>
      <div class="results-list">
        <!-- 按层级分组显示 -->
        <div v-for="group in groupedResults" :key="group.layer" class="result-group">
          <div class="result-group-header">
            <span class="result-group-label">{{ group.label }}</span>
            <span class="result-group-count">{{ group.items.length }}</span>
          </div>
          <div 
            v-for="item in group.items" 
            :key="item.nodeId"
            class="result-item"
            :class="{ current: item.index === store.searchMatchIndex }"
            @click="selectResult(item.nodeId, item.index)"
            @mouseenter="store.searchMatchIndex = item.index"
          >
            <div class="result-name">{{ getNodeName(item.nodeId) }}</div>
            <div class="result-meta">
              <span v-if="getNodeFaction(item.nodeId)" class="result-faction" :style="{ color: getNodeFactionColor(item.nodeId) }">
                {{ getNodeFaction(item.nodeId) }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 类型过滤面板 -->
    <div v-if="store.isFilterOpen" class="filter-panel" @click.stop>
      <div class="filter-header">类型过滤</div>
      <div class="filter-options">
        <label 
          v-for="layer in store.availableLayers" 
          :key="layer" 
          class="filter-option"
          :class="{ active: store.searchLayerFilter.includes(layer) }"
        >
          <input 
            type="checkbox" 
            :checked="store.searchLayerFilter.includes(layer)"
            @change="store.toggleLayerFilter(layer)"
          />
          <span>{{ store.layerLabels[layer] || layer }}</span>
        </label>
      </div>
      <div class="filter-footer">
        <button class="filter-clear" @click="store.searchLayerFilter = []; if (store.searchQuery.trim()) store.performSearch(store.searchQuery)">清除</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useGeodataStore } from '../store/geodata';

const store = useGeodataStore();
const query = ref('');
const input = ref(null);
const showResults = ref(false);

const hasResults = computed(() => query.value.trim().length > 0 && store.searchResults.length === 0);
const showNoResults = computed(() => hasResults.value && query.value.trim().length > 0);
const filterCount = computed(() => store.searchLayerFilter.length);

// 按层级分组搜索结果
const groupedResults = computed(() => {
  const groups = new Map();
  const layerOrder = ['world', 'star_domain', 'galaxy', 'planet', 'city', 'town', 'location'];
  
  store.searchResults.forEach((nodeId, index) => {
    const node = store.nodes.find(n => n.id === nodeId);
    if (!node) return;
    
    const layer = node.layer || 'unknown';
    if (!groups.has(layer)) {
      groups.set(layer, {
        layer,
        label: store.layerLabels[layer] || layer,
        order: layerOrder.indexOf(layer) !== -1 ? layerOrder.indexOf(layer) : 99,
        items: [],
      });
    }
    groups.get(layer).items.push({ nodeId, index });
  });
  
  return Array.from(groups.values())
    .sort((a, b) => a.order - b.order);
});

function getNodeName(nodeId) {
  const node = store.nodes.find(n => n.id === nodeId);
  return node?.name || nodeId;
}

function getNodeFaction(nodeId) {
  const node = store.nodes.find(n => n.id === nodeId);
  return node?.faction || '';
}

function getNodeFactionColor(nodeId) {
  const node = store.nodes.find(n => n.id === nodeId);
  if (!node?.faction) return '';
  return store.getFactionColor(node.faction);
}

function selectResult(nodeId, index) {
  store.searchMatchIndex = index;
  const node = store.currentMatchNode;
  if (node && node.coordinate.x !== null) {
    autoNavigateToNode(node);
    window.dispatchEvent(new CustomEvent('sitian:focus-node', { detail: node }));
  }
  showResults = false;
}

function onInput() {
  store.performSearch(query.value);
  if (query.value.trim().length > 0 && store.searchResults.length > 0) {
    showResults.value = true;
  } else {
    showResults.value = false;
  }
}

function onEnter() {
  if (store.searchResults.length > 0) {
    store.cycleSearchMatch();
    const node = store.currentMatchNode;
    if (node && node.coordinate.x !== null) {
      autoNavigateToNode(node);
      window.dispatchEvent(new CustomEvent('sitian:focus-node', { detail: node }));
    }
  }
}

function onEsc() {
  showResults.value = false;
  clear();
  input.value?.blur();
}

function clear() {
  query.value = '';
  store.clearSearch();
}

function focus() {
  input.value?.select();
}

function autoNavigateToNode(node) {
  const layer = node.layer;
  
  if (store.viewLevel === 'world' && layer !== 'world') {
    const world = findAncestorByLayer(node, 'world');
    if (world) store.selectWorld(world);
  }
  
  if (store.viewLevel === 'domain' && ['planet', 'city', 'town', 'location', 'region'].includes(layer)) {
    const domain = findAncestorByLayer(node, 'star_domain');
    if (domain) store.selectDomain(domain);
  }
}

function findAncestorByLayer(node, targetLayer) {
  let current = node;
  const visited = new Set();
  while (current && current.id) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    if (current.layer === targetLayer) return current;
    current = store.nodes.find(n => n.id === current.parentId);
  }
  return null;
}

onMounted(() => {
  window.addEventListener('keydown', handleGlobalKeydown);
  document.addEventListener('click', closeFilterPanel);
  window.addEventListener('sitian:search-tag', handleSearchTag);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeydown);
  document.removeEventListener('click', closeFilterPanel);
  window.removeEventListener('sitian:search-tag', handleSearchTag);
});

function handleSearchTag(e) {
  const tag = e.detail;
  if (tag) {
    query.value = `tag:${tag}`;
    store.performSearch(query.value);
    focus();
  }
}

function closeFilterPanel(e) {
  const searchBar = input.value?.closest('.search-bar-container');
  if (searchBar && !searchBar.contains(e.target)) {
    store.isFilterOpen = false;
    showResults.value = false;
  }
}

function handleGlobalKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    focus();
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
    e.preventDefault();
    focus();
    store.isFilterOpen = true;
    return;
  }
  if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
    e.preventDefault();
    focus();
  }
}

defineExpose({ focus });
</script>

<style scoped>
.search-bar-container {
  display: flex;
  align-items: center;
  position: relative;
}

.search-input-wrapper {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 4px;
  padding: 4px 8px;
  min-width: 240px;
}

.search-input-wrapper:focus-within {
  border-color: var(--accent);
}

.search-icon {
  font-size: 12px;
  color: var(--text-tertiary);
}

input {
  flex: 1;
  background: none;
  border: none;
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
  min-width: 0;
}

input::placeholder {
  color: var(--separator);
}

.match-count {
  font-size: 11px;
  color: var(--text-tertiary);
  white-space: nowrap;
  min-width: 40px;
  text-align: center;
}

.match-count.no-results {
  color: #ff7b72;
  background: rgba(255, 123, 114, 0.1);
  padding: 1px 6px;
  border-radius: 3px;
}

.filter-badge {
  display: inline-block;
  background: rgba(88, 166, 255, 0.2);
  color: var(--accent);
  font-size: 10px;
  padding: 0 4px;
  border-radius: 3px;
  margin-left: 4px;
  font-weight: 600;
}

.clear-btn {
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 4px;
}

.clear-btn:hover {
  color: var(--text-primary);
}

.filter-btn {
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 4px;
}

.filter-btn:hover {
  color: var(--text-primary);
}

.filter-btn.active {
  color: var(--accent);
}

.search-results-panel {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  margin-top: 6px;
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  max-height: 350px;
  overflow-y: auto;
  z-index: 200;
}

.results-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--panel-border);
  font-size: 12px;
  color: var(--text-tertiary);
}

.results-count {
  font-size: 11px;
  color: var(--separator);
}

.results-list {
  padding: 4px 0;
}

.result-group {
  margin-bottom: 4px;
}

.result-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  background: rgba(48, 54, 61, 0.3);
}

.theme-light .result-group-header {
  background: rgba(208, 215, 222, 0.3);
}

.result-group-label {
  font-size: 10px;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.result-group-count {
  font-size: 10px;
  color: var(--separator);
  background: var(--btn-bg);
  padding: 0 6px;
  border-radius: 8px;
}

.result-item {
  padding: 6px 12px 6px 20px;
  cursor: pointer;
  transition: background 0.15s;
}

.result-item:hover,
.result-item.current {
  background: var(--accent-bg);
}

.result-name {
  font-size: 13px;
  color: var(--text-primary);
  font-weight: 500;
}

.result-meta {
  display: flex;
  gap: 8px;
  margin-top: 2px;
}

.result-faction {
  font-size: 11px;
  font-weight: 500;
}

.filter-panel {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 6px;
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  padding: 10px;
  min-width: 160px;
  z-index: 200;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.filter-header {
  font-size: 11px;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
}

.filter-options {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 240px;
  overflow-y: auto;
}

.filter-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-primary);
}

.filter-option:hover {
  background: var(--btn-bg);
}

.filter-option.active {
  background: var(--accent-bg);
  color: var(--accent);
}

.filter-option input[type="checkbox"] {
  accent-color: var(--accent);
}

.filter-footer {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--panel-border);
  display: flex;
  justify-content: flex-end;
}

.filter-clear {
  background: none;
  border: none;
  color: var(--text-tertiary);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 6px;
}

.filter-clear:hover {
  color: var(--text-primary);
}
</style>
