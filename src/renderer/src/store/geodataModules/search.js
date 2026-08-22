// store/geodataModules/search.js — 搜索与过滤领域模块
// ctx: { nodes }（ref 引用，保持响应式）
import { ref, computed } from 'vue';

export function createSearchModule(ctx) {
  const { nodes } = ctx;

  // ===== 搜索状态 =====
  const searchQuery = ref('');
  const searchResults = ref([]);
  const searchMatchIndex = ref(0);
  const searchLayerFilter = ref([]); // 选中的层级类型过滤
  const searchPlaceTypeFilter = ref([]); // 选中的地点类型过滤（第二维度）
  const isFilterOpen = ref(false); // 过滤面板是否展开

  function toggleLayerFilter(layer) {
    const idx = searchLayerFilter.value.indexOf(layer);
    if (idx === -1) {
      searchLayerFilter.value.push(layer);
    } else {
      searchLayerFilter.value.splice(idx, 1);
    }
    // 重新执行搜索
    if (searchQuery.value.trim()) {
      performSearch(searchQuery.value);
    }
  }

  function togglePlaceTypeFilter(type) {
    const idx = searchPlaceTypeFilter.value.indexOf(type);
    if (idx === -1) {
      searchPlaceTypeFilter.value.push(type);
    } else {
      searchPlaceTypeFilter.value.splice(idx, 1);
    }
    if (searchQuery.value.trim()) {
      performSearch(searchQuery.value);
    }
  }

  function matchNode(node, query, layerFilter, placeTypeFilter) {
    // 层级过滤
    if (layerFilter && layerFilter.length > 0 && !layerFilter.includes(node.layer)) {
      return false;
    }
    // 地点类型过滤（激活时排除无 placeType 的节点）
    if (placeTypeFilter && placeTypeFilter.length > 0) {
      if (!node.placeType || !placeTypeFilter.includes(node.placeType)) return false;
    }
    if (!query) return false;

    // tag: 前缀搜索
    if (query.startsWith('tag:')) {
      const tag = query.slice(4).trim().toLowerCase();
      return node.tags?.some(t => t.toLowerCase() === tag) ?? false;
    }

    const q = query.toLowerCase();
    const name = node.name.toLowerCase();
    const displayName = node.displayName?.toLowerCase() || '';
    if (name.includes(q)) return true;
    if (displayName.includes(q)) return true;
    if (node.tags?.some(t => t.toLowerCase().includes(q))) return true;
    return false;
  }

  function performSearch(query) {
    searchQuery.value = query;
    if (!query.trim()) {
      searchResults.value = [];
      searchMatchIndex.value = 0;
      return;
    }
    const results = nodes.value
      .filter(n => matchNode(n, query.trim(), searchLayerFilter.value, searchPlaceTypeFilter.value))
      .map(n => n.id);
    searchResults.value = results;
    searchMatchIndex.value = results.length > 0 ? 0 : -1;
  }

  function cycleSearchMatch() {
    if (searchResults.value.length === 0) return;
    searchMatchIndex.value = (searchMatchIndex.value + 1) % searchResults.value.length;
  }

  function clearSearch() {
    searchQuery.value = '';
    searchResults.value = [];
    searchMatchIndex.value = 0;
  }

  function isNodeMatched(nodeId) {
    return searchResults.value.includes(nodeId);
  }

  function isCurrentMatch(nodeId) {
    return searchResults.value[searchMatchIndex.value] === nodeId;
  }

  const currentMatchNode = computed(() => {
    if (searchResults.value.length === 0) return null;
    const id = searchResults.value[searchMatchIndex.value];
    return nodes.value.find(n => n.id === id) || null;
  });

  return {
    searchQuery,
    searchResults,
    searchMatchIndex,
    searchLayerFilter,
    searchPlaceTypeFilter,
    isFilterOpen,
    toggleLayerFilter,
    togglePlaceTypeFilter,
    matchNode,
    performSearch,
    cycleSearchMatch,
    clearSearch,
    isNodeMatched,
    isCurrentMatch,
    currentMatchNode,
  };
}
