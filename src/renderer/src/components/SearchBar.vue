<template>
  <div class="search-bar">
    <div class="search-input-wrapper">
      <span class="search-icon">🔍</span>
      <input
        ref="input"
        v-model="query"
        type="text"
        placeholder="搜索节点... (Ctrl+F 聚焦, Esc 清除, Enter 跳转)"
        @input="onInput"
        @keydown.enter="onEnter"
        @keydown.esc="onEsc"
      />
      <span v-if="query" class="match-count" :class="{ 'no-results': showNoResults }">
        {{ store.searchResults.length > 0 ? `${store.searchMatchIndex + 1}/${store.searchResults.length}` : (showNoResults ? '无结果' : '0') }}
      </span>
      <button v-if="query" class="clear-btn" @click="clear">×</button>
      <button 
        class="filter-btn" 
        :class="{ active: store.searchLayerFilter.length > 0 }"
        @click="store.isFilterOpen = !store.isFilterOpen"
        title="类型过滤"
      >⚲</button>
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

const hasResults = computed(() => query.value.trim().length > 0 && store.searchResults.length === 0);
const showNoResults = computed(() => hasResults.value && query.value.trim().length > 0);

function onInput() {
  store.performSearch(query.value);
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

/**
 * 根据节点层级自动切换视图级别
 */
function autoNavigateToNode(node) {
  const layer = node.layer;
  
  // 搜索的是星系/星域/行星级节点，但当前在世界视图
  if (store.viewLevel === 'world' && layer !== 'world') {
    const world = findAncestorByLayer(node, 'world');
    if (world) store.selectWorld(world);
  }
  
  // 搜索的是行星/城市/地点，但当前在域视图
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
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeydown);
  document.removeEventListener('click', closeFilterPanel);
});

function closeFilterPanel(e) {
  if (!e.target.closest('.filter-panel') && !e.target.closest('.filter-btn')) {
    store.isFilterOpen = false;
  }
}

function handleGlobalKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    focus();
  }
  if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
    e.preventDefault();
    focus();
  }
}

defineExpose({ focus });
</script>

<style scoped>
.search-bar {
  display: flex;
  align-items: center;
  position: relative;
}

.search-input-wrapper {
  display: flex;
  align-items: center;
  gap: 6px;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 4px 8px;
  min-width: 240px;
}

.search-input-wrapper:focus-within {
  border-color: #58a6ff;
}

.search-icon {
  font-size: 12px;
  color: #8b949e;
}

input {
  flex: 1;
  background: none;
  border: none;
  color: #e2e8f0;
  font-size: 12px;
  outline: none;
  min-width: 0;
}

input::placeholder {
  color: #484f58;
}

.match-count {
  font-size: 11px;
  color: #8b949e;
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

.clear-btn {
  background: none;
  border: none;
  color: #8b949e;
  cursor: pointer;
  font-size: 14px;
  padding: 2px 4px;
}

.clear-btn:hover {
  color: #e2e8f0;
}

/* 类型过滤按钮 */
.filter-btn {
  background: none;
  border: none;
  color: #8b949e;
  cursor: pointer;
  font-size: 14px;
  padding: 2px 4px;
}

.filter-btn:hover {
  color: #e2e8f0;
}

.filter-btn.active {
  color: #58a6ff;
}

/* 类型过滤面板 */
.filter-panel {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 6px;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 10px;
  min-width: 160px;
  z-index: 200;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.filter-header {
  font-size: 11px;
  color: #8b949e;
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
  color: #e2e8f0;
}

.filter-option:hover {
  background: #21262d;
}

.filter-option.active {
  background: rgba(88, 166, 255, 0.15);
  color: #58a6ff;
}

.filter-option input[type="checkbox"] {
  accent-color: #58a6ff;
}

.filter-footer {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #30363d;
  display: flex;
  justify-content: flex-end;
}

.filter-clear {
  background: none;
  border: none;
  color: #8b949e;
  font-size: 11px;
  cursor: pointer;
  padding: 2px 6px;
}

.filter-clear:hover {
  color: #e2e8f0;
}
</style>
