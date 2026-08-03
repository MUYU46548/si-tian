import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

const MAX_HISTORY = 50;
const AUTO_SAVE_DELAY = 800;

export const useGeodataStore = defineStore('geodata', () => {
  const nodes = ref([]);
  const hyperlanes = ref([]);
  const currentWorld = ref(null);
  const currentDomain = ref(null);
  const currentSystem = ref(null);
  const viewLevel = ref('world');
  const selectedNode = ref(null);

  // ===== 历史栈 =====
  const history = ref([]);
  const future = ref([]);
  let isUndoRedo = false;
  let autoSaveTimer = null;
  const autoSaveEnabled = ref(true);

  function snapshot() {
    if (isUndoRedo) return;
    history.value.push({
      nodes: JSON.parse(JSON.stringify(nodes.value)),
      hyperlanes: JSON.parse(JSON.stringify(hyperlanes.value)),
    });
    if (history.value.length > MAX_HISTORY) {
      history.value.shift();
    }
    future.value = [];
  }

  function undo() {
    if (history.value.length === 0) return;
    const prev = history.value.pop();
    future.value.push({
      nodes: JSON.parse(JSON.stringify(nodes.value)),
      hyperlanes: JSON.parse(JSON.stringify(hyperlanes.value)),
    });
    isUndoRedo = true;
    nodes.value = prev.nodes;
    hyperlanes.value = prev.hyperlanes;
    isUndoRedo = false;
  }

  function redo() {
    if (future.value.length === 0) return;
    const next = future.value.pop();
    history.value.push({
      nodes: JSON.parse(JSON.stringify(nodes.value)),
      hyperlanes: JSON.parse(JSON.stringify(hyperlanes.value)),
    });
    isUndoRedo = true;
    nodes.value = next.nodes;
    hyperlanes.value = next.hyperlanes;
    isUndoRedo = false;
  }

  const canUndo = computed(() => history.value.length > 0);
  const canRedo = computed(() => future.value.length > 0);

  // ===== 搜索状态 =====
  const searchQuery = ref('');
  const searchResults = ref([]);
  const searchMatchIndex = ref(0);

  const worlds = computed(() => nodes.value.filter(n => n.layer === 'world'));
  const starDomains = computed(() => nodes.value.filter(n => n.layer === 'star_domain'));
  const galaxies = computed(() => nodes.value.filter(n => n.layer === 'galaxy'));
  const planets = computed(() => nodes.value.filter(n => n.layer === 'planet'));
  const locations = computed(() => nodes.value.filter(n => n.layer === 'location' || n.layer === 'city' || n.layer === 'town'));

  const currentWorldDomains = computed(() => {
    if (!currentWorld.value) return [];
    return starDomains.value.filter(d => d.parentId === currentWorld.value.id);
  });

  const currentDomainGalaxies = computed(() => {
    if (!currentDomain.value) return [];
    return galaxies.value.filter(g => g.parentId === currentDomain.value.id);
  });

  const currentSystemPlanets = computed(() => {
    if (!currentSystem.value) return [];
    return [...planets.value, ...locations.value].filter(p => p.parentId === currentSystem.value.id);
  });

  const currentDomainAllGalaxies = computed(() => {
    if (!currentDomain.value) return [];
    const domainGalaxies = galaxies.value.filter(g => g.parentId === currentDomain.value.id);
    return domainGalaxies;
  });

  const getHyperlanesByNode = computed(() => {
    return (nodeId) => hyperlanes.value.filter(h => h.fromId === nodeId || h.toId === nodeId);
  });

  const currentDomainHyperlanes = computed(() => {
    if (!currentDomain.value) return [];
    const domainGalaxyIds = new Set(currentDomainGalaxies.value.map(g => g.id));
    return hyperlanes.value.filter(h => {
      if (domainGalaxyIds.has(h.fromId) && domainGalaxyIds.has(h.toId)) return true;
      return domainGalaxyIds.has(h.fromId) || domainGalaxyIds.has(h.toId);
    });
  });

  const getHyperlanesForNode = computed(() => {
    return (nodeId) => hyperlanes.value.filter(h => h.fromId === nodeId || h.toId === nodeId);
  });

  const isSearching = computed(() => searchQuery.value.trim().length > 0);

  function matchNode(node, query) {
    if (!query) return false;
    const q = query.toLowerCase();
    const name = node.name.toLowerCase();
    if (name.includes(q)) return true;
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
    const results = nodes.value.filter(n => matchNode(n, query.trim())).map(n => n.id);
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

  const tree = computed(() => {
    const map = new Map();
    nodes.value.forEach(n => map.set(n.id, { ...n, children: [] }));
    const roots = [];
    nodes.value.forEach(n => {
      if (n.parentId && map.has(n.parentId)) {
        map.get(n.parentId).children.push(map.get(n.id));
      } else if (!n.parentId) {
        roots.push(map.get(n.id));
      }
    });
    const layerOrder = ['world', 'star_domain', 'galaxy', 'planet', 'region', 'city', 'town', 'location', 'unknown'];
    const sortByLayer = (node) => {
      if (node.children) {
        node.children.sort((a, b) =>
          layerOrder.indexOf(a.layer) - layerOrder.indexOf(b.layer)
        );
        node.children.forEach(sortByLayer);
      }
    };
    roots.forEach(sortByLayer);
    return roots;
  });

  async function loadGeodata() {
    const result = await window.sitianAPI.getGeodata();
    if (result.success) {
      nodes.value = validateNodes(result.data.nodes || []);
      hyperlanes.value = result.data.hyperlanes || [];
    } else {
      console.error('Failed to load geodata:', result.error);
      nodes.value = [];
      hyperlanes.value = [];
    }
  }

  /**
   * 校验并清理节点数据，防止异常坐标导致渲染错误
   */
  function validateNodes(rawNodes) {
    const COORD_MIN = -10000;
    const COORD_MAX = 10000;
    
    return rawNodes.map(node => {
      const coord = node.coordinate || {};
      let x = coord.x;
      let y = coord.y;
      
      // 校验坐标范围
      if (typeof x !== 'number' || !isFinite(x)) x = null;
      if (typeof y !== 'number' || !isFinite(y)) y = null;
      if (x !== null && (x < COORD_MIN || x > COORD_MAX)) {
        console.warn(`[Geodata] 节点 "${node.name}" 的 X 坐标 ${x} 超出范围，已重置`);
        x = null;
      }
      if (y !== null && (y < COORD_MIN || y > COORD_MAX)) {
        console.warn(`[Geodata] 节点 "${node.name}" 的 Y 坐标 ${y} 超出范围，已重置`);
        y = null;
      }
      
      // 校验 parentId 是否存在
      if (node.parentId && !rawNodes.some(n => n.id === node.parentId)) {
        console.warn(`[Geodata] 节点 "${node.name}" 的 parentId "${node.parentId}" 不存在`);
        node.parentId = null;
      }
      
      return {
        ...node,
        coordinate: { x, y },
        tags: Array.isArray(node.tags) ? node.tags : [],
      };
    });
  }

  async function reextract() {
    const result = await window.sitianAPI.reextractGeodata();
    if (result.success) {
      nodes.value = result.data.nodes || [];
      const autoHyperlanes = result.data.hyperlanes || [];
      const userHyperlanes = hyperlanes.value.filter(h => !h.id.startsWith('auto_'));
      hyperlanes.value = [...autoHyperlanes, ...userHyperlanes];
    }
  }

  async function saveGeodata() {
    const data = {
      nodes: nodes.value,
      hyperlanes: hyperlanes.value,
      updatedAt: new Date().toISOString()
    };
    await window.sitianAPI.saveGeodata(data);
  }

  // ===== 自动保存 =====
  function scheduleAutoSave() {
    if (!autoSaveEnabled.value) return;
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(async () => {
      await saveGeodata();
      autoSaveTimer = null;
    }, AUTO_SAVE_DELAY);
  }

  async function flushSave() {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
      await saveGeodata();
    }
  }

  function updateNodePosition(id, x, y) {
    const node = nodes.value.find(n => n.id === id);
    if (node) {
      node.coordinate.x = x;
      node.coordinate.y = y;
      scheduleAutoSave();
    }
  }

  function updateAllCoordinates(updatedNodes) {
    updatedNodes.forEach(updated => {
      const node = nodes.value.find(n => n.id === updated.id);
      if (node) {
        node.coordinate.x = updated.coordinate.x;
        node.coordinate.y = updated.coordinate.y;
      }
    });
    scheduleAutoSave();
  }

  // ===== 航道 CRUD（带快照） =====

  function addHyperlane(fromId, toId, type = 'local') {
    const exists = hyperlanes.value.some(h =>
      (h.fromId === fromId && h.toId === toId) ||
      (h.fromId === toId && h.toId === fromId)
    );
    if (exists) return null;

    snapshot();

    const id = `hyperlane_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const hyperlane = { id, fromId, toId, type, controlPoints: [] };
    hyperlanes.value.push(hyperlane);
    scheduleAutoSave();
    return hyperlane;
  }

  function removeHyperlane(id) {
    const idx = hyperlanes.value.findIndex(h => h.id === id);
    if (idx === -1) return;

    snapshot();
    hyperlanes.value.splice(idx, 1);
    scheduleAutoSave();
  }

  function updateHyperlane(id, updates) {
    const h = hyperlanes.value.find(h => h.id === id);
    if (h) {
      snapshot();
      Object.assign(h, updates);
      scheduleAutoSave();
    }
  }

  function getHyperlaneById(id) {
    return hyperlanes.value.find(h => h.id === id);
  }

  function selectNode(node) {
    selectedNode.value = node;
  }

  function clearSelection() {
    selectedNode.value = null;
  }

  function selectWorld(world) {
    currentWorld.value = world;
    currentDomain.value = null;
    currentSystem.value = null;
    viewLevel.value = 'domain';
    selectedNode.value = null;
    clearSearch();
  }

  function selectDomain(domain) {
    currentDomain.value = domain;
    currentSystem.value = null;
    viewLevel.value = 'system';
    selectedNode.value = null;
  }

  function selectSystem(system) {
    currentSystem.value = system;
    selectedNode.value = null;
  }

  function backToWorld() {
    currentWorld.value = null;
    currentDomain.value = null;
    currentSystem.value = null;
    viewLevel.value = 'world';
    selectedNode.value = null;
    clearSearch();
  }

  function backToDomain() {
    currentSystem.value = null;
    viewLevel.value = 'domain';
    selectedNode.value = null;
  }

  // ===== Vault 监听事件 =====
  function handleNodeUpdated(node) {
    const idx = nodes.value.findIndex(n => n.id === node.id);
    if (idx !== -1) {
      const existingCoord = nodes.value[idx].coordinate;
      nodes.value[idx] = { ...node, coordinate: existingCoord };
    } else {
      nodes.value.push(node);
    }
  }

  function handleNodeRemoved(nodeId) {
    nodes.value = nodes.value.filter(n => n.id !== nodeId);
  }

  return {
    nodes, hyperlanes, tree, currentWorld, currentDomain, currentSystem, viewLevel,
    selectedNode, searchQuery, searchResults, searchMatchIndex, currentMatchNode,
    worlds, starDomains, galaxies, planets, locations,
    currentWorldDomains, currentDomainGalaxies, currentSystemPlanets, currentDomainAllGalaxies,
    currentDomainHyperlanes, getHyperlanesByNode, getHyperlanesForNode,
    isSearching,
    history, future, canUndo, canRedo,
    loadGeodata, reextract, saveGeodata,
    updateNodePosition, updateAllCoordinates,
    addHyperlane, removeHyperlane, updateHyperlane, getHyperlaneById,
    selectNode, clearSelection,
    performSearch, cycleSearchMatch, clearSearch, isNodeMatched, isCurrentMatch,
    undo, redo,
    selectWorld, selectDomain, selectSystem, backToWorld, backToDomain,
    handleNodeUpdated, handleNodeRemoved,
    scheduleAutoSave, flushSave, autoSaveEnabled,
  };
});
