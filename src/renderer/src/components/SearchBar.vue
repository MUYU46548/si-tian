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
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeydown);
});

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
</style>
