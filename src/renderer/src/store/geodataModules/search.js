// store/geodataModules/search.js — 搜索与过滤领域模块
// ctx: { nodes, scenarios }（ref 引用，保持响应式）
import { ref, computed } from 'vue';

export function createSearchModule(ctx) {
  const { nodes, scenarios } = ctx;

  // ===== 搜索状态 =====
  const searchQuery = ref('');
  const searchResults = ref([]);
  const searchMatchIndex = ref(0);
  const searchLayerFilter = ref([]); // 选中的层级类型过滤
  const searchPlaceTypeFilter = ref([]); // 选中的地点类型过滤（第二维度）
  const isFilterOpen = ref(false); // 过滤面板是否展开
  const includeScenarios = ref(false); // 含剧本地点（默认关）

  // 当前匹配的节点对象（用于搜索结果高亮/导航）
  const currentMatchNode = computed(() => {
    if (searchResults.value.length === 0) return null;
    const nodeId = searchResults.value[searchMatchIndex.value];
    return nodes.value.find(n => n.id === nodeId) || null;
  });

  function toggleLayerFilter(layer) {
    const idx = searchLayerFilter.value.indexOf(layer);
    if (idx === -1) {
      searchLayerFilter.value.push(layer);
    } else {
      searchLayerFilter.value.splice(idx, 1);
    }
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

  function toggleIncludeScenarios() {
    includeScenarios.value = !includeScenarios.value;
    if (searchQuery.value.trim()) {
      performSearch(searchQuery.value);
    }
  }

  function matchNode(node, query, layerFilter, placeTypeFilter) {
    if (layerFilter && layerFilter.length > 0 && !layerFilter.includes(node.layer)) {
      return false;
    }
    if (placeTypeFilter && placeTypeFilter.length > 0) {
      if (!node.placeType || !placeTypeFilter.includes(node.placeType)) return false;
    }
    if (!query) return false;

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

  // Match scenario labels/markers (historical places)
  function matchScenario(query) {
    if (!query || !includeScenarios.value) return [];
    const q = query.toLowerCase();
    const results = [];

    for (const scenario of Object.values(scenarios.value || {})) {
      for (const label of (scenario.labels || [])) {
        if (label.text?.toLowerCase().includes(q)) {
          results.push({
            type: 'scenario-label',
            scenarioId: scenario.id,
            scenarioName: scenario.name,
            label: label,
            nodeId: `scenario-label-${label.id}`,
          });
        }
      }
      for (const marker of (scenario.markers || [])) {
        if (marker.name?.toLowerCase().includes(q)) {
          results.push({
            type: 'scenario-marker',
            scenarioId: scenario.id,
            scenarioName: scenario.name,
            marker: marker,
            nodeId: `scenario-marker-${marker.id}`,
          });
        }
      }
    }

    return results;
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

  return {
    searchQuery, searchResults, searchMatchIndex,
    searchLayerFilter, searchPlaceTypeFilter, isFilterOpen, includeScenarios,
    currentMatchNode,
    toggleLayerFilter, togglePlaceTypeFilter, toggleIncludeScenarios,
    performSearch, cycleSearchMatch, clearSearch,
    matchNode, matchScenario,
    isNodeMatched, isCurrentMatch,
  };
}
