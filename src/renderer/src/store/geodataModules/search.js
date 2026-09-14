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
  const wikilinkMatchIds = ref(new Set()); // 靠正文提及命中的结果 id（UI 徽标用）

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

  // 正文 wikilink 命中（“提及”关系，即反向链接）：一个词条名可能只出现在别人的正文里
  // 这类命中排在同名直配之后（见 performSearch），并用徽标区分，避免淹没直接命名的结果。
  // tag: 前缀查询不参与（用户明确在搜标签，不是搜正文提及）。
  function matchWikilink(node, query, layerFilter, placeTypeFilter) {
    if (!query || query.startsWith('tag:')) return false;
    if (layerFilter && layerFilter.length > 0 && !layerFilter.includes(node.layer)) return false;
    if (placeTypeFilter && placeTypeFilter.length > 0) {
      if (!node.placeType || !placeTypeFilter.includes(node.placeType)) return false;
    }
    const q = query.toLowerCase();
    return node.wikilinks?.some(w => String(w).toLowerCase().includes(q)) ?? false;
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
      wikilinkMatchIds.value = new Set();
      return;
    }
    const q = query.trim();
    const filters = [searchLayerFilter.value, searchPlaceTypeFilter.value];
    // 两段式：名称/标签直配优先，正文提及（wikilinks）随后 —— 结果顺序既保证
    // 「搜索词条名直达该词条」（第 1 条即目标），又不丢失反向链接价值。
    const direct = [];
    const linked = [];
    for (const n of nodes.value) {
      if (matchNode(n, q, filters[0], filters[1])) {
        direct.push(n.id);
      } else if (matchWikilink(n, q, filters[0], filters[1])) {
        linked.push(n.id);
      }
    }
    searchResults.value = [...direct, ...linked];
    wikilinkMatchIds.value = new Set(linked);
    searchMatchIndex.value = searchResults.value.length > 0 ? 0 : -1;
  }

  function cycleSearchMatch() {
    if (searchResults.value.length === 0) return;
    searchMatchIndex.value = (searchMatchIndex.value + 1) % searchResults.value.length;
  }

  function clearSearch() {
    searchQuery.value = '';
    searchResults.value = [];
    searchMatchIndex.value = 0;
    wikilinkMatchIds.value = new Set();
  }

  /** 该结果是否靠「正文提及」命中（UI 用徽标区分，不参与导航逻辑） */
  function isWikilinkMatch(nodeId) {
    return wikilinkMatchIds.value.has(nodeId);
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
    currentMatchNode, wikilinkMatchIds,
    toggleLayerFilter, togglePlaceTypeFilter, toggleIncludeScenarios,
    performSearch, cycleSearchMatch, clearSearch,
    matchNode, matchWikilink, matchScenario,
    isNodeMatched, isCurrentMatch, isWikilinkMatch,
  };
}
