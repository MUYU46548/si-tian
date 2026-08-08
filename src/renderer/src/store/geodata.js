import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { execute, undo as undoCmd, redo as redoCmd, canUndo as undoCanUndo, canRedo as undoCanRedo, getLastCommandLabel } from './undo';

const AUTO_SAVE_DELAY = 800;

export const useGeodataStore = defineStore('geodata', () => {
  const nodes = ref([]);
  const hyperlanes = ref([]);
  const currentWorld = ref(null);
  const currentDomain = ref(null);
  const currentSystem = ref(null);
  const currentPlanet = ref(null);
  const viewLevel = ref('world');
  const selectedNode = ref(null);

  const autoSaveEnabled = ref(true);

  // ===== 边界覆盖持久化 =====
  const domainBorderOverrides = ref({});

  // ===== 地图数据 =====
  const mapData = ref({});

  // ===== 计算属性 =====
  const canUndo = undoCanUndo;
  const canRedo = undoCanRedo;

  // 获取最近一次操作的 label（用于 tooltip）
  const undoLabel = computed(() => getLastCommandLabel());

  // ===== 搜索状态 =====
  const searchQuery = ref('');
  const searchResults = ref([]);
  const searchMatchIndex = ref(0);
  const searchLayerFilter = ref([]); // 选中的层级类型过滤
  const isFilterOpen = ref(false); // 过滤面板是否展开

  const worlds = computed(() => nodes.value.filter(n => n.layer === 'world'));
  const starDomains = computed(() => nodes.value.filter(n => n.layer === 'star_domain'));
  const galaxies = computed(() => nodes.value.filter(n => n.layer === 'galaxy'));
  const planets = computed(() => nodes.value.filter(n => n.layer === 'planet'));
  const locations = computed(() => nodes.value.filter(n => n.layer === 'location' || n.layer === 'city' || n.layer === 'town'));

  // 默认势力颜色表
  const FACTION_COLORS = {
    '蓝镜帝国': '#4A90D9',
    '绿野联邦': '#5CB85C',
    '赤焰王国': '#E74C3C',
    '紫晶商会': '#9B59B6',
    '金辉共和国': '#F39C12',
    '青霜联盟': '#1ABC9C',
    '橙光同盟': '#E67E22',
    '银月帝国': '#95A5A6',
  };

  function getFactionColor(faction) {
    if (!faction) return '#6b5b95';
    if (FACTION_COLORS[faction]) return FACTION_COLORS[faction];
    // 根据 faction 字符串生成确定性颜色
    let hash = 0;
    for (let i = 0; i < faction.length; i++) {
      hash = faction.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 60%)`;
  }

  const currentWorldDomains = computed(() => {
    if (!currentWorld.value) return [];
    return starDomains.value.filter(d => d.parentId === currentWorld.value.id).map(d => ({
      ...d,
      factionColor: d.factionColor || getFactionColor(d.faction),
    }));
  });

  const currentDomainGalaxies = computed(() => {
    if (!currentDomain.value) return [];
    return galaxies.value.filter(g => g.parentId === currentDomain.value.id);
  });

  const currentSystemPlanets = computed(() => {
    if (!currentSystem.value) return [];
    return [...planets.value, ...locations.value].filter(p => p.parentId === currentSystem.value.id);
  });

  const currentPlanetPlaces = computed(() => {
    if (!currentPlanet.value) return [];
    return [...planets.value, ...locations.value].filter(p => p.parentId === currentPlanet.value.id);
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

  // 当前 vault 中存在的层级类型（用于过滤选项）
  const availableLayers = computed(() => {
    const layers = new Set(nodes.value.map(n => n.layer));
    const order = ['world', 'star_domain', 'galaxy', 'star', 'planet', 'moon', 'region', 'city', 'town', 'village', 'facility', 'location'];
    return order.filter(l => layers.has(l));
  });

  const layerLabels = {
    world: '世界', star_domain: '星域', galaxy: '星系', star: '恒星',
    planet: '行星', moon: '卫星', region: '区域', city: '城市',
    town: '城镇', village: '村庄', facility: '设施', location: '地点', unknown: '未知'
  };

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

  function matchNode(node, query, layerFilter) {
    // 类型过滤
    if (layerFilter && layerFilter.length > 0 && !layerFilter.includes(node.layer)) {
      return false;
    }
    if (!query) return false;
  
    // tag: 前缀搜索
    if (query.startsWith('tag:')) {
      const tag = query.slice(4).trim().toLowerCase();
      return node.tags?.some(t => t.toLowerCase() === tag) ?? false;
    }
  
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
    const results = nodes.value.filter(n => matchNode(n, query.trim(), searchLayerFilter.value)).map(n => n.id);
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
      domainBorderOverrides.value = result.data.domainBorderOverrides || {};
    } else {
      console.error('Failed to load geodata:', result.error);
      nodes.value = [];
      hyperlanes.value = [];
      domainBorderOverrides.value = {};
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
    // 深拷贝去除 Vue reactive Proxy，否则 Electron IPC 会报 "An object could not be cloned"
    const data = JSON.parse(JSON.stringify({
      nodes: nodes.value,
      hyperlanes: hyperlanes.value,
      domainBorderOverrides: domainBorderOverrides.value,
      updatedAt: new Date().toISOString()
    }));
    await window.sitianAPI.saveGeodata(data);
  }

  // ===== 自动保存 =====
  let autoSaveTimer = null;
  let autoSaveMapTimer = null;

  function scheduleAutoSave() {
    if (!autoSaveEnabled.value) return;
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(async () => {
      await saveGeodata();
      autoSaveTimer = null;
    }, AUTO_SAVE_DELAY);
  }

  function scheduleAutoSaveMap(planetId) {
    if (!autoSaveEnabled.value) return;
    if (autoSaveMapTimer) clearTimeout(autoSaveMapTimer);
    autoSaveMapTimer = setTimeout(async () => {
      if (mapData.value[planetId]) {
        await saveMapData(planetId, mapData.value[planetId]);
      }
      autoSaveMapTimer = null;
    }, AUTO_SAVE_DELAY);
  }

  async function flushSave() {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
      await saveGeodata();
    }
    if (autoSaveMapTimer) {
      clearTimeout(autoSaveMapTimer);
      autoSaveMapTimer = null;
    }
  }

  // ===== 地图数据持久化 =====
  async function loadMapData(planetId) {
    try {
      const result = await window.sitianAPI.getMapData(planetId);
      if (result.success) {
        mapData.value[planetId] = result.data;
        return result.data;
      }
    } catch (e) {
      console.error('loadMapData failed:', e);
    }
    return null;
  }

  async function saveMapData(planetId, data) {
    try {
      // 深拷贝去除 Vue reactive Proxy
      const cloned = JSON.parse(JSON.stringify(data));
      const result = await window.sitianAPI.saveMapData(planetId, cloned);
      if (result.success) {
        mapData.value[planetId] = cloned;
      }
      return result;
    } catch (e) {
      console.error('saveMapData failed:', e);
      return { success: false, error: e.message };
    }
  }

  // ===== 地形多边形 CRUD =====
  function addTerrainPolygon(planetId, polygon) {
    if (!mapData.value[planetId]) {
      mapData.value[planetId] = { planetId, version: 1, terrain: [], regions: [], markers: [] };
    }
    mapData.value[planetId].terrain.push(polygon);
    mapData.value[planetId].updatedAt = new Date().toISOString();
    execute({
      type: 'add-terrain',
      label: '绘制地形',
      undo: () => {
        mapData.value[planetId].terrain = mapData.value[planetId].terrain.filter(t => t.id !== polygon.id);
      },
      redo: () => {
        mapData.value[planetId].terrain.push(polygon);
      },
    });
    scheduleAutoSaveMap(planetId);
  }

  function removeTerrainPolygon(planetId, polygonId) {
    if (!mapData.value[planetId]) return;
    const idx = mapData.value[planetId].terrain.findIndex(t => t.id === polygonId);
    if (idx === -1) return;
    const removed = mapData.value[planetId].terrain[idx];
    mapData.value[planetId].terrain.splice(idx, 1);
    mapData.value[planetId].updatedAt = new Date().toISOString();
    execute({
      type: 'remove-terrain',
      label: '删除地形',
      undo: () => {
        mapData.value[planetId].terrain.splice(idx, 0, removed);
      },
      redo: () => {
        mapData.value[planetId].terrain = mapData.value[planetId].terrain.filter(t => t.id !== polygonId);
      },
    });
    scheduleAutoSaveMap(planetId);
  }

  function updateControlPoint(planetId, polygonId, cpIndex, newPos) {
    if (!mapData.value[planetId]) return;
    const polygon = mapData.value[planetId].terrain.find(t => t.id === polygonId);
    if (!polygon || !polygon.controlPoints || cpIndex >= polygon.controlPoints.length) return;
    const oldPos = { ...polygon.controlPoints[cpIndex] };
    polygon.controlPoints[cpIndex] = newPos;
    mapData.value[planetId].updatedAt = new Date().toISOString();
    execute({
      type: 'move-control-point',
      label: '调整控制点',
      undo: () => {
        polygon.controlPoints[cpIndex] = oldPos;
      },
      redo: () => {
        polygon.controlPoints[cpIndex] = newPos;
      },
    });
  }

  // ===== 区域多边形 CRUD =====
  function addRegion(planetId, region) {
    if (!mapData.value[planetId]) {
      mapData.value[planetId] = { planetId, version: 1, terrain: [], regions: [], markers: [] };
    }
    if (!mapData.value[planetId].regions) {
      mapData.value[planetId].regions = [];
    }
    mapData.value[planetId].regions.push(region);
    mapData.value[planetId].updatedAt = new Date().toISOString();
    execute({
      type: 'add-region',
      label: '绘制区域',
      undo: () => {
        mapData.value[planetId].regions = mapData.value[planetId].regions.filter(r => r.id !== region.id);
      },
      redo: () => {
        mapData.value[planetId].regions.push(region);
      },
    });
    scheduleAutoSaveMap(planetId);
  }

  function removeRegion(planetId, regionId) {
    if (!mapData.value[planetId]?.regions) return;
    const idx = mapData.value[planetId].regions.findIndex(r => r.id === regionId);
    if (idx === -1) return;
    const removed = mapData.value[planetId].regions[idx];
    mapData.value[planetId].regions.splice(idx, 1);
    mapData.value[planetId].updatedAt = new Date().toISOString();
    execute({
      type: 'remove-region',
      label: '删除区域',
      undo: () => {
        mapData.value[planetId].regions.splice(idx, 0, removed);
      },
      redo: () => {
        mapData.value[planetId].regions = mapData.value[planetId].regions.filter(r => r.id !== regionId);
      },
    });
    scheduleAutoSaveMap(planetId);
  }

  function updateRegion(planetId, regionId, updates) {
    if (!mapData.value[planetId]?.regions) return;
    const region = mapData.value[planetId].regions.find(r => r.id === regionId);
    if (!region) return;

    const oldState = {};
    for (const key of Object.keys(updates)) {
      oldState[key] = region[key];
    }
    Object.assign(region, updates);
    mapData.value[planetId].updatedAt = new Date().toISOString();
    execute({
      type: 'update-region',
      label: '编辑区域',
      undo: () => {
        Object.assign(region, oldState);
      },
      redo: () => {
        Object.assign(region, updates);
      },
    });
    scheduleAutoSaveMap(planetId);
  }

  function updateTerrainPolygon(planetId, polygonId, updates) {
    if (!mapData.value[planetId]) return;
    const polygon = mapData.value[planetId].terrain.find(t => t.id === polygonId);
    if (!polygon) return;

    const oldState = {};
    for (const key of Object.keys(updates)) {
      oldState[key] = polygon[key];
    }
    Object.assign(polygon, updates);
    mapData.value[planetId].updatedAt = new Date().toISOString();
    execute({
      type: 'update-terrain',
      label: '编辑省份属性',
      undo: () => {
        Object.assign(polygon, oldState);
      },
      redo: () => {
        Object.assign(polygon, updates);
      },
    });
    scheduleAutoSaveMap(planetId);
  }

  function saveMapDataImmediate(planetId) {
    if (!mapData.value[planetId]) return;
    window.sitianAPI.saveMapData(planetId, mapData.value[planetId]);
  }

  function updateNodePosition(id, x, y) {
    const node = nodes.value.find(n => n.id === id);
    if (node) {
      node.coordinate.x = x;
      node.coordinate.y = y;
      scheduleAutoSave();
    }
  }

  // ===== 节点拖拽撤销支持 =====
  let dragStartCoord = null;
  let dragStartId = null;

  function beginNodePositionCapture(id) {
    const node = nodes.value.find(n => n.id === id);
    if (node) {
      dragStartId = id;
      dragStartCoord = { x: node.coordinate.x, y: node.coordinate.y };
    }
  }

  function endNodePositionCapture() {
    if (!dragStartId || !dragStartCoord) return;
    const node = nodes.value.find(n => n.id === dragStartId);
    if (!node) { dragStartId = null; dragStartCoord = null; return; }
    const endCoord = { x: node.coordinate.x, y: node.coordinate.y };
    const startCoord = { ...dragStartCoord };
    const nodeId = dragStartId;
    execute({
      type: 'move-node',
      label: '移动节点',
      undo: () => {
        const n = nodes.value.find(nn => nn.id === nodeId);
        if (n) { n.coordinate.x = startCoord.x; n.coordinate.y = startCoord.y; }
      },
      redo: () => {
        const n = nodes.value.find(nn => nn.id === nodeId);
        if (n) { n.coordinate.x = endCoord.x; n.coordinate.y = endCoord.y; }
      },
    });
    dragStartId = null;
    dragStartCoord = null;
    scheduleAutoSave();
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

  // ===== 航道 CRUD（使用通用 UndoStore） =====

  function undo() {
    undoCmd();
  }

  function redo() {
    redoCmd();
  }

  function addHyperlane(fromId, toId, type = 'local') {
    const exists = hyperlanes.value.some(h =>
      (h.fromId === fromId && h.toId === toId) ||
      (h.fromId === toId && h.toId === fromId)
    );
    if (exists) return null;

    const id = `hyperlane_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const hyperlane = { id, fromId, toId, type, controlPoints: [] };
    hyperlanes.value.push(hyperlane);
    execute({
      type: 'add-hyperlane',
      label: '添加航道',
      undo: () => {
        hyperlanes.value = hyperlanes.value.filter(h => h.id !== id);
      },
      redo: () => {
        hyperlanes.value.push(hyperlane);
      },
    });
    scheduleAutoSave();
    return hyperlane;
  }

  function removeHyperlane(id) {
    const idx = hyperlanes.value.findIndex(h => h.id === id);
    if (idx === -1) return;

    const removed = hyperlanes.value[idx];
    hyperlanes.value.splice(idx, 1);
    execute({
      type: 'remove-hyperlane',
      label: '删除航道',
      undo: () => {
        hyperlanes.value.splice(idx, 0, removed);
      },
      redo: () => {
        hyperlanes.value = hyperlanes.value.filter(h => h.id !== id);
      },
    });
    scheduleAutoSave();
  }

  function updateHyperlane(id, updates) {
    const h = hyperlanes.value.find(h => h.id === id);
    if (!h) return;

    const oldUpdates = {};
    for (const key of Object.keys(updates)) {
      oldUpdates[key] = h[key];
    }
    Object.assign(h, updates);
    execute({
      type: 'update-hyperlane',
      label: '更新航道',
      undo: () => {
        Object.assign(h, oldUpdates);
      },
      redo: () => {
        Object.assign(h, updates);
      },
    });
    scheduleAutoSave();
  }

  function getHyperlaneById(id) {
    return hyperlanes.value.find(h => h.id === id);
  }

  function selectNode(node) {
    selectedNode.value = node;
  }

  function selectPlanetOrNode(node) {
    if (node && node.layer === 'planet') {
      selectPlanet(node);
    } else {
      selectedNode.value = node;
    }
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
    currentPlanet.value = null;
    selectedNode.value = null;
  }

  function selectPlanet(planet) {
    currentPlanet.value = planet;
    viewLevel.value = 'planet';
    selectedNode.value = null;
  }

  function backToWorld() {
    currentWorld.value = null;
    currentDomain.value = null;
    currentSystem.value = null;
    currentPlanet.value = null;
    viewLevel.value = 'world';
    selectedNode.value = null;
    clearSearch();
  }

  function backToDomain() {
    currentSystem.value = null;
    currentPlanet.value = null;
    viewLevel.value = 'domain';
    selectedNode.value = null;
  }

  function backToSystem() {
    currentPlanet.value = null;
    viewLevel.value = 'system';
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
    nodes, hyperlanes, tree, currentWorld, currentDomain, currentSystem, currentPlanet, viewLevel,
    selectedNode, searchQuery, searchResults, searchMatchIndex, currentMatchNode,
    worlds, starDomains, galaxies, planets, locations,
    currentWorldDomains, currentDomainGalaxies, currentSystemPlanets, currentPlanetPlaces, currentDomainAllGalaxies,
    currentDomainHyperlanes, getHyperlanesByNode, getHyperlanesForNode,
    isSearching,
    availableLayers, layerLabels, searchLayerFilter,
    toggleLayerFilter, isFilterOpen,
    canUndo, canRedo, undoLabel, mapData, domainBorderOverrides,
    loadGeodata, reextract, saveGeodata,
      updateNodePosition, updateAllCoordinates,
      addHyperlane, removeHyperlane, updateHyperlane, getHyperlaneById,
      selectNode, clearSelection, selectPlanetOrNode,
      performSearch, cycleSearchMatch, clearSearch, isNodeMatched, isCurrentMatch,
      undo, redo,
      selectWorld, selectDomain, selectSystem, selectPlanet, backToWorld, backToDomain, backToSystem,
      handleNodeUpdated, handleNodeRemoved,
      scheduleAutoSave, scheduleAutoSaveMap, flushSave, autoSaveEnabled,
      loadMapData, saveMapData, addTerrainPolygon, removeTerrainPolygon, updateTerrainPolygon, updateControlPoint, saveMapDataImmediate,
      beginNodePositionCapture, endNodePositionCapture,
      addRegion, removeRegion, updateRegion,
    };
});
