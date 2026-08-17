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
  const currentArea = ref(null); // 当前下钻区域（城市/地点节点）
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
  const searchPlaceTypeFilter = ref([]); // 选中的地点类型过滤（第二维度）
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
    // 行星地图只显示聚落（城市/城镇/村庄）+ 地点，不显示设施/区域/地形
    return nodes.value.filter(p =>
      p.parentId === currentPlanet.value.id &&
      ['city', 'town', 'village', 'location'].includes(p.layer)
    );
  });

  // 区域地图（下钻视图）：显示当前区域/聚落的子节点（设施/建筑/小区等）
  const currentAreaPlaces = computed(() => {
    if (!currentArea.value) return [];
    return nodes.value.filter(p => p.parentId === currentArea.value.id);
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

  // 当前 vault 中存在的地点类型（第二维度过滤选项）
  const availablePlaceTypes = computed(() => {
    const types = new Set(nodes.value.map(n => n.placeType).filter(Boolean));
    return ['自然', '宗教', '皇室', '商业', '工业', '居住', '公共', '特殊'].filter(t => types.has(t));
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
  // 多世界坐标缓存隔离（P2-2）：写盘 key = worldId/planetId（如 幻境/乐园星），
  // 防止未来允许跨世界同名时 mapdata.json key 覆盖；内存索引仍用 planetId（全局唯一）
  function getWorldIdForNode(nodeId) {
    const visited = new Set();
    let cur = nodes.value.find(n => n.id === nodeId);
    while (cur && cur.id && !visited.has(cur.id)) {
      visited.add(cur.id);
      if (cur.layer === 'world') return cur.id;
      cur = nodes.value.find(n => n.id === cur.parentId);
    }
    return '';
  }

  function getMapDataKey(planetId) {
    const w = getWorldIdForNode(planetId);
    return w ? `${w}/${planetId}` : planetId;
  }

  async function loadMapData(planetId) {
    try {
      const key = getMapDataKey(planetId);
      const result = await window.sitianAPI.getMapData(key);
      let data = result.success ? result.data : null;
      // 兼容迁移：新 key（worldId/planetId）无数据时读旧 key（纯 planetId）并迁移
      if (!data && key !== planetId) {
        const legacy = await window.sitianAPI.getMapData(planetId);
        if (legacy.success && legacy.data) {
          data = legacy.data;
          await saveMapData(planetId, data);
        }
      }
      if (data) {
        migrateReferenceImages(planetId, data);
        // 创建新对象触发 Vue 3 ref 的响应式更新（直接设置嵌套属性在某些情况下不触发 computed）
        mapData.value = { ...mapData.value, [planetId]: data };
        return data;
      }
    } catch (e) {
      console.error('loadMapData failed:', e);
    }
    return null;
  }

  async function saveMapData(planetId, data) {
    try {
      // 深拷贝去除 Vue reactive Proxy（仅用于 IPC 传输）
      const cloned = JSON.parse(JSON.stringify(data));
      const result = await window.sitianAPI.saveMapData(getMapDataKey(planetId), cloned);
      // 注意：不再 mapData.value[planetId] = cloned —— 替换对象会让已入栈的
      // undo/redo 闭包与 selectedProvince 等选中引用全部失效（2026-08-16 修复：
      // autoSave 触发后撤销失灵、选中对象与数据分离的存量根因）
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
    mapData.value[planetId].updatedAt = new Date().toISOString();
    // execute() 会立即调用 redo 完成首次写入，这里不再手动 push（避免双写）
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

  // ===== 省份拆分/合并（2026-08-16，原子操作：一次 undo 恢复全部） =====
  // 注意：execute 会立即调用 redo，这里不能先手动 splice（见 undo.js execute 双写陷阱）
  // 注意：闭包内每次访问 mapData.value[planetId]（不捕获 data 引用，防止对象被替换后失效）
  function splitTerrainPolygon(planetId, oldId, newA, newB) {
    const data = mapData.value[planetId];
    if (!data) return;
    const idx = data.terrain.findIndex(t => t.id === oldId);
    if (idx === -1) return;
    const oldPoly = data.terrain[idx];
    data.updatedAt = new Date().toISOString();
    execute({
      type: 'split-terrain',
      label: '拆分省份',
      undo: () => {
        const cur = mapData.value[planetId];
        cur.terrain = cur.terrain.filter(t => t.id !== newA.id && t.id !== newB.id);
        cur.terrain.splice(idx, 0, oldPoly);
      },
      redo: () => {
        const cur = mapData.value[planetId];
        cur.terrain = cur.terrain.filter(t => t.id !== oldId);
        cur.terrain.push(newA, newB);
      },
    });
    scheduleAutoSaveMap(planetId);
  }

  function mergeTerrainPolygons(planetId, idA, idB, merged) {
    const data = mapData.value[planetId];
    if (!data) return;
    const idxA = data.terrain.findIndex(t => t.id === idA);
    const idxB = data.terrain.findIndex(t => t.id === idB);
    if (idxA === -1 || idxB === -1) return;
    const polyA = data.terrain[idxA];
    const polyB = data.terrain[idxB];
    data.updatedAt = new Date().toISOString();
    execute({
      type: 'merge-terrain',
      label: '合并省份',
      undo: () => {
        const cur = mapData.value[planetId];
        cur.terrain = cur.terrain.filter(t => t.id !== merged.id);
        const insert = (i, poly) => cur.terrain.splice(Math.min(i, cur.terrain.length), 0, poly);
        if (idxA <= idxB) { insert(idxA, polyA); insert(idxB + 1, polyB); }
        else { insert(idxB, polyB); insert(idxA + 1, polyA); }
      },
      redo: () => {
        const cur = mapData.value[planetId];
        cur.terrain = cur.terrain.filter(t => t.id !== idA && t.id !== idB);
        cur.terrain.push(merged);
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
    mapData.value[planetId].updatedAt = new Date().toISOString();
    // execute() 的 redo 完成首次写入（避免双写）
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

  function updateRegion(planetId, regionId, updates, oldSnapshot = null) {
    if (!mapData.value[planetId]?.regions) return;
    const region = mapData.value[planetId].regions.find(r => r.id === regionId);
    if (!region) return;

    const oldState = {};
    if (oldSnapshot) {
      Object.assign(oldState, oldSnapshot);
    } else {
      for (const key of Object.keys(updates)) {
        // oldSnapshot 缺失时采集当前值（拖拽类操作应传 onDragStart 记录的快照）
        oldState[key] = Array.isArray(region[key]) ? region[key].map(p => ({ ...p })) : region[key];
      }
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

  function updateTerrainPolygon(planetId, polygonId, updates, oldSnapshot = null) {
    if (!mapData.value[planetId]) return;
    const polygon = mapData.value[planetId].terrain.find(t => t.id === polygonId);
    if (!polygon) return;

    const oldState = {};
    if (oldSnapshot) {
      Object.assign(oldState, oldSnapshot);
    } else {
      for (const key of Object.keys(updates)) {
        // oldSnapshot 缺失时采集当前值（拖拽类操作应传 onDragStart 记录的快照）
        oldState[key] = Array.isArray(polygon[key]) ? polygon[key].map(p => ({ ...p })) : polygon[key];
      }
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

  // ===== 路线 CRUD =====
  function addRoute(planetId, route) {
    if (!mapData.value[planetId]) {
      mapData.value[planetId] = { planetId, version: 1, terrain: [], regions: [], markers: [] };
    }
    if (!mapData.value[planetId].routes) {
      mapData.value[planetId].routes = [];
    }
    mapData.value[planetId].updatedAt = new Date().toISOString();
    // execute() 的 redo 完成首次写入（避免双写）
    execute({
      type: 'add-route',
      label: '绘制路线',
      undo: () => {
        mapData.value[planetId].routes = mapData.value[planetId].routes.filter(r => r.id !== route.id);
      },
      redo: () => {
        mapData.value[planetId].routes.push(route);
      },
    });
    scheduleAutoSaveMap(planetId);
  }

  function removeRoute(planetId, routeId) {
    if (!mapData.value[planetId]?.routes) return;
    const idx = mapData.value[planetId].routes.findIndex(r => r.id === routeId);
    if (idx === -1) return;
    const removed = mapData.value[planetId].routes[idx];
    mapData.value[planetId].routes.splice(idx, 1);
    mapData.value[planetId].updatedAt = new Date().toISOString();
    execute({
      type: 'remove-route',
      label: '删除路线',
      undo: () => {
        mapData.value[planetId].routes.splice(idx, 0, removed);
      },
      redo: () => {
        mapData.value[planetId].routes = mapData.value[planetId].routes.filter(r => r.id !== routeId);
      },
    });
    scheduleAutoSaveMap(planetId);
  }

  function updateRoute(planetId, routeId, updates, oldSnapshot = null) {
    if (!mapData.value[planetId]?.routes) return;
    const route = mapData.value[planetId].routes.find(r => r.id === routeId);
    if (!route) return;

    const oldState = {};
    if (oldSnapshot) {
      Object.assign(oldState, oldSnapshot);
    } else {
      for (const key of Object.keys(updates)) {
        // oldSnapshot 缺失时采集当前值（拖拽类操作应传 onDragStart 记录的快照）
        oldState[key] = Array.isArray(route[key]) ? route[key].map(p => ({ ...p })) : route[key];
      }
    }
    Object.assign(route, updates);
    mapData.value[planetId].updatedAt = new Date().toISOString();
    execute({
      type: 'update-route',
      label: '编辑路线',
      undo: () => {
        Object.assign(route, oldState);
      },
      redo: () => {
        Object.assign(route, updates);
      },
    });
    scheduleAutoSaveMap(planetId);
  }

  // ===== 浮动文本标签 CRUD =====
  function addTextLabel(planetId, label) {
    if (!mapData.value[planetId]) {
      mapData.value[planetId] = { planetId, version: 1, terrain: [], regions: [], markers: [] };
    }
    if (!mapData.value[planetId].textLabels) {
      mapData.value[planetId].textLabels = [];
    }
    mapData.value[planetId].updatedAt = new Date().toISOString();
    // execute() 的 redo 完成首次写入（避免双写）
    execute({
      type: 'add-text-label',
      label: '添加文本',
      undo: () => {
        mapData.value[planetId].textLabels = mapData.value[planetId].textLabels.filter(l => l.id !== label.id);
      },
      redo: () => {
        mapData.value[planetId].textLabels.push(label);
      },
    });
    scheduleAutoSaveMap(planetId);
  }

  function removeTextLabel(planetId, labelId) {
    if (!mapData.value[planetId]?.textLabels) return;
    const idx = mapData.value[planetId].textLabels.findIndex(l => l.id === labelId);
    if (idx === -1) return;
    const removed = mapData.value[planetId].textLabels[idx];
    mapData.value[planetId].textLabels.splice(idx, 1);
    mapData.value[planetId].updatedAt = new Date().toISOString();
    execute({
      type: 'remove-text-label',
      label: '删除文本',
      undo: () => {
        mapData.value[planetId].textLabels.splice(idx, 0, removed);
      },
      redo: () => {
        mapData.value[planetId].textLabels = mapData.value[planetId].textLabels.filter(l => l.id !== labelId);
      },
    });
    scheduleAutoSaveMap(planetId);
  }

  function updateTextLabel(planetId, labelId, updates, oldSnapshot = null) {
    if (!mapData.value[planetId]?.textLabels) return;
    const label = mapData.value[planetId].textLabels.find(l => l.id === labelId);
    if (!label) return;

    const oldState = {};
    if (oldSnapshot) {
      Object.assign(oldState, oldSnapshot);
    } else {
      for (const key of Object.keys(updates)) {
        // oldSnapshot 缺失时采集当前值（拖拽类操作应传 onDragStart 记录的快照）
        oldState[key] = label[key];
      }
    }
    Object.assign(label, updates);
    mapData.value[planetId].updatedAt = new Date().toISOString();
    execute({
      type: 'update-text-label',
      label: '编辑文本',
      undo: () => {
        Object.assign(label, oldState);
      },
      redo: () => {
        Object.assign(label, updates);
      },
    });
    scheduleAutoSaveMap(planetId);
  }

  // ===== 标记 CRUD（带 undo） =====
  function addMarker(planetId, marker) {
    if (!mapData.value[planetId]) {
      mapData.value[planetId] = { planetId, version: 1, terrain: [], regions: [], markers: [] };
    }
    if (!mapData.value[planetId].markers) {
      mapData.value[planetId].markers = [];
    }
    mapData.value[planetId].updatedAt = new Date().toISOString();
    // execute() 的 redo 完成首次写入（避免双写）
    execute({
      type: 'add-marker',
      label: '放置标记',
      undo: () => {
        mapData.value[planetId].markers = mapData.value[planetId].markers.filter(m => m.id !== marker.id);
      },
      redo: () => {
        mapData.value[planetId].markers.push(marker);
      },
    });
    scheduleAutoSaveMap(planetId);
  }

  function removeMarker(planetId, markerId) {
    if (!mapData.value[planetId]?.markers) return;
    const idx = mapData.value[planetId].markers.findIndex(m => m.id === markerId);
    if (idx === -1) return;
    const removed = mapData.value[planetId].markers[idx];
    mapData.value[planetId].markers.splice(idx, 1);
    mapData.value[planetId].updatedAt = new Date().toISOString();
    execute({
      type: 'remove-marker',
      label: '删除标记',
      undo: () => {
        mapData.value[planetId].markers.splice(idx, 0, removed);
      },
      redo: () => {
        mapData.value[planetId].markers = mapData.value[planetId].markers.filter(m => m.id !== markerId);
      },
    });
    scheduleAutoSaveMap(planetId);
  }

  function updateMarker(planetId, markerId, updates, oldSnapshot = null) {
    if (!mapData.value[planetId]?.markers) return;
    const marker = mapData.value[planetId].markers.find(m => m.id === markerId);
    if (!marker) return;

    const oldState = {};
    if (oldSnapshot) {
      Object.assign(oldState, oldSnapshot);
    } else {
      for (const key of Object.keys(updates)) {
        // oldSnapshot 缺失时采集当前值（拖拽类操作应传 onDragStart 记录的快照）
        oldState[key] = marker[key];
      }
    }
    Object.assign(marker, updates);
    mapData.value[planetId].updatedAt = new Date().toISOString();
    execute({
      type: 'update-marker',
      label: '编辑标记',
      undo: () => {
        Object.assign(marker, oldState);
      },
      redo: () => {
        Object.assign(marker, updates);
      },
    });
    scheduleAutoSaveMap(planetId);
  }

  // ===== 参考图底图（P2 多图：referenceImages 数组，按 id 更新兼容 active 语义）=====
  function updateReferenceImage(planetId, refImage) {
    if (!mapData.value[planetId]) {
      mapData.value[planetId] = { planetId, version: 1, terrain: [], regions: [], markers: [] };
    }
    const map = mapData.value[planetId];
    // 数组结构：按 id 更新（现有调用传完整对象含 id）
    if (Array.isArray(map.referenceImages)) {
      const idx = map.referenceImages.findIndex(r => r.id === refImage?.id);
      if (idx >= 0) {
        map.referenceImages[idx] = { ...map.referenceImages[idx], ...refImage };
      } else if (refImage?.id) {
        map.referenceImages.push(refImage);
      }
    } else {
      // 旧单图结构兜底
      map.referenceImage = refImage;
    }
    map.updatedAt = new Date().toISOString();
    scheduleAutoSaveMap(planetId);
  }

  function removeReferenceImageById(planetId, refId) {
    const map = mapData.value[planetId];
    if (!map?.referenceImages) return;
    map.referenceImages = map.referenceImages.filter(r => r.id !== refId);
    map.updatedAt = new Date().toISOString();
    scheduleAutoSaveMap(planetId);
  }

  // 旧单图结构迁移到数组（loadMapData 时调用）
  function migrateReferenceImages(planetId, map) {
    if (!map) return;
    if (map.referenceImage && !Array.isArray(map.referenceImages)) {
      map.referenceImages = [{ ...map.referenceImage, id: `ref_${Date.now()}` }];
      delete map.referenceImage;
    }
    if (!Array.isArray(map.referenceImages)) map.referenceImages = [];
  }

  // ===== 地图版本快照（P2）=====
  function addMapSnapshot(planetId, name = '') {
    const map = mapData.value[planetId];
    if (!map) return null;
    // 深拷贝当前地图数据（排除 snapshots 自身避免递归）
    const { snapshots, ...rest } = map;
    const count = (map.snapshots?.length || 0) + 1;
    const snapshot = {
      id: `snap_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      name: name.trim() || `快照 ${count}`,
      createdAt: new Date().toISOString(),
      data: JSON.parse(JSON.stringify(rest)),
    };
    if (!map.snapshots) map.snapshots = [];
    map.snapshots.push(snapshot);
    map.updatedAt = new Date().toISOString();
    scheduleAutoSaveMap(planetId);
    return snapshot;
  }

  function removeMapSnapshot(planetId, snapshotId) {
    const map = mapData.value[planetId];
    if (!map?.snapshots) return;
    map.snapshots = map.snapshots.filter(s => s.id !== snapshotId);
    map.updatedAt = new Date().toISOString();
    scheduleAutoSaveMap(planetId);
  }

  function restoreMapSnapshot(planetId, snapshotId) {
    const map = mapData.value[planetId];
    const snapshot = map?.snapshots?.find(s => s.id === snapshotId);
    if (!snapshot) return false;
    const oldMap = JSON.parse(JSON.stringify(map));
    const restored = {
      ...snapshot.data,
      planetId,
      version: map.version || 1,
      snapshots: map.snapshots,
      updatedAt: new Date().toISOString(),
    };
    // 走 undo：恢复可撤销
    execute({
      type: 'restore-snapshot',
      label: `恢复快照「${snapshot.name}」`,
      undo: () => { mapData.value[planetId] = oldMap; },
      redo: () => { mapData.value[planetId] = restored; },
    });
    scheduleAutoSaveMap(planetId);
    return true;
  }

  function clearReferenceImage(planetId) {
    if (!mapData.value[planetId]) return;
    delete mapData.value[planetId].referenceImage;
    mapData.value[planetId].updatedAt = new Date().toISOString();
    scheduleAutoSaveMap(planetId);
  }

  // ===== 地点簇 CRUD =====
  // cluster: { id, name, memberIds: [nodeId...], color, collapsed }
  function addCluster(planetId, cluster) {
    if (!mapData.value[planetId]) {
      mapData.value[planetId] = { planetId, version: 1, terrain: [], regions: [], markers: [] };
    }
    if (!mapData.value[planetId].clusters) {
      mapData.value[planetId].clusters = [];
    }
    mapData.value[planetId].updatedAt = new Date().toISOString();
    // execute() 的 redo 完成首次写入（避免双写）
    execute({
      type: 'add-cluster',
      label: '创建地点簇',
      undo: () => {
        mapData.value[planetId].clusters = mapData.value[planetId].clusters.filter(c => c.id !== cluster.id);
      },
      redo: () => {
        mapData.value[planetId].clusters.push(cluster);
      },
    });
    scheduleAutoSaveMap(planetId);
  }

  function removeCluster(planetId, clusterId) {
    if (!mapData.value[planetId]?.clusters) return;
    const idx = mapData.value[planetId].clusters.findIndex(c => c.id === clusterId);
    if (idx === -1) return;
    const removed = mapData.value[planetId].clusters[idx];
    mapData.value[planetId].clusters.splice(idx, 1);
    mapData.value[planetId].updatedAt = new Date().toISOString();
    execute({
      type: 'remove-cluster',
      label: '解散地点簇',
      undo: () => {
        mapData.value[planetId].clusters.splice(idx, 0, removed);
      },
      redo: () => {
        mapData.value[planetId].clusters = mapData.value[planetId].clusters.filter(c => c.id !== clusterId);
      },
    });
    scheduleAutoSaveMap(planetId);
  }

  function updateCluster(planetId, clusterId, updates) {
    if (!mapData.value[planetId]?.clusters) return;
    const cluster = mapData.value[planetId].clusters.find(c => c.id === clusterId);
    if (!cluster) return;

    const oldState = {};
    for (const key of Object.keys(updates)) {
      oldState[key] = cluster[key];
    }
    Object.assign(cluster, updates);
    mapData.value[planetId].updatedAt = new Date().toISOString();
    execute({
      type: 'update-cluster',
      label: '编辑地点簇',
      undo: () => {
        Object.assign(cluster, oldState);
      },
      redo: () => {
        Object.assign(cluster, updates);
      },
    });
    scheduleAutoSaveMap(planetId);
  }

  // 统一移动簇内地点（保持相对位置）
  function moveClusterMembers(planetId, clusterId, dx, dy) {
    const cluster = mapData.value[planetId]?.clusters?.find(c => c.id === clusterId);
    if (!cluster) return;
    const moved = [];
    cluster.memberIds.forEach(memberId => {
      const node = nodes.value.find(n => n.id === memberId);
      if (node && node.coordinate?.x !== null && node.coordinate?.x !== undefined) {
        moved.push({
          id: memberId,
          oldX: node.coordinate.x,
          oldY: node.coordinate.y,
          newX: node.coordinate.x + dx,
          newY: node.coordinate.y + dy,
        });
        node.coordinate.x += dx;
        node.coordinate.y += dy;
        node.userMoved = true;
      }
    });
    if (moved.length === 0) return;
    execute({
      type: 'move-cluster',
      label: '移动地点簇',
      undo: () => {
        moved.forEach(m => {
          const n = nodes.value.find(nn => nn.id === m.id);
          if (n) { n.coordinate.x = m.oldX; n.coordinate.y = m.oldY; }
        });
      },
      redo: () => {
        moved.forEach(m => {
          const n = nodes.value.find(nn => nn.id === m.id);
          if (n) { n.coordinate.x = m.newX; n.coordinate.y = m.newY; }
        });
      },
    });
    scheduleAutoSave();
  }

  function updateNodePosition(id, x, y) {
    const node = nodes.value.find(n => n.id === id);
    if (node) {
      node.coordinate.x = x;
      node.coordinate.y = y;
      scheduleAutoSave();
    }
  }

  // 切换节点锁定（锁定后不可拖拽/微调）
  function toggleNodeLock(id) {
    const node = nodes.value.find(n => n.id === id);
    if (node) {
      node.locked = !node.locked;
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
    // 标记为用户手动放置的坐标，布局重算时优先保留
    node.userMoved = true;
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

  // ===== 多节点拖拽撤销支持（多选批量移动：一次拖动 = 一个 undo 步骤） =====
  let dragStartMap = null;

  function beginMultiNodePositionCapture(ids) {
    dragStartMap = new Map();
    for (const id of ids) {
      const node = nodes.value.find(n => n.id === id);
      if (node && node.coordinate && node.coordinate.x !== null && node.coordinate.y !== null) {
        dragStartMap.set(id, { x: node.coordinate.x, y: node.coordinate.y });
      }
    }
  }

  function endMultiNodePositionCapture() {
    if (!dragStartMap || dragStartMap.size === 0) return;
    const startMap = dragStartMap;
    const endMap = new Map();
    for (const id of startMap.keys()) {
      const node = nodes.value.find(n => n.id === id);
      if (node && node.coordinate) {
        endMap.set(id, { x: node.coordinate.x, y: node.coordinate.y });
        node.userMoved = true;
      }
    }
    execute({
      type: 'move-nodes',
      label: `移动 ${startMap.size} 个节点`,
      undo: () => {
        for (const [id, coord] of startMap) {
          const n = nodes.value.find(nn => nn.id === id);
          if (n && n.coordinate) { n.coordinate.x = coord.x; n.coordinate.y = coord.y; }
        }
      },
      redo: () => {
        for (const [id, coord] of endMap) {
          const n = nodes.value.find(nn => nn.id === id);
          if (n && n.coordinate) { n.coordinate.x = coord.x; n.coordinate.y = coord.y; }
        }
      },
    });
    dragStartMap = null;
    scheduleAutoSave();
  }

  function updateAllCoordinates(updatedNodes) {
    updatedNodes.forEach(updated => {
      const node = nodes.value.find(n => n.id === updated.id);
      if (node) {
        node.coordinate.x = updated.coordinate.x;
        node.coordinate.y = updated.coordinate.y;
        node.userMoved = true;
      }
    });
    scheduleAutoSave();
  }

  // ===== 节点 CRUD（使用通用 UndoStore） =====

  function addNode(node) {
    const newNode = { ...node, tags: Array.isArray(node.tags) ? [...node.tags] : [] };
    // execute() 的 redo 完成首次写入（避免双写）
    execute({
      type: 'add-node',
      label: '添加节点',
      category: 'property',
      undo: () => {
        nodes.value = nodes.value.filter(n => n.id !== newNode.id);
      },
      redo: () => {
        nodes.value.push(newNode);
      },
    });
    scheduleAutoSave();
    return newNode;
  }

  function removeNode(nodeId) {
    const idx = nodes.value.findIndex(n => n.id === nodeId);
    if (idx === -1) return null;

    const removed = nodes.value[idx];
    // 关联航道（指向该节点的全部删除）
    const relatedHyperlanes = hyperlanes.value.filter(h => h.fromId === nodeId || h.toId === nodeId);
    // 直接子节点：暂存原 parentId，删除后置空，避免产生孤立引用
    const childBackup = nodes.value
      .filter(n => n.parentId === nodeId)
      .map(c => ({ id: c.id, parentId: c.parentId }));

    nodes.value.splice(idx, 1);
    hyperlanes.value = hyperlanes.value.filter(h => h.fromId !== nodeId && h.toId !== nodeId);
    childBackup.forEach(cb => {
      const child = nodes.value.find(n => n.id === cb.id);
      if (child) child.parentId = null;
    });

    execute({
      type: 'remove-node',
      label: '删除节点',
      category: 'property',
      undo: () => {
        nodes.value.splice(idx, 0, removed);
        childBackup.forEach(cb => {
          const child = nodes.value.find(n => n.id === cb.id);
          if (child) child.parentId = cb.parentId;
        });
        hyperlanes.value.push(...relatedHyperlanes);
      },
      redo: () => {
        nodes.value = nodes.value.filter(n => n.id !== nodeId);
        hyperlanes.value = hyperlanes.value.filter(h => h.fromId !== nodeId && h.toId !== nodeId);
        childBackup.forEach(cb => {
          const child = nodes.value.find(n => n.id === cb.id);
          if (child) child.parentId = null;
        });
      },
    });
    scheduleAutoSave();
    return removed;
  }

  function updateNode(nodeId, updates) {
    const node = nodes.value.find(n => n.id === nodeId);
    if (!node) return null;

    const oldState = {};
    for (const key of Object.keys(updates)) {
      oldState[key] = node[key];
    }
    Object.assign(node, updates);
    execute({
      type: 'update-node',
      label: '编辑节点',
      category: 'property',
      undo: () => {
        Object.assign(node, oldState);
      },
      redo: () => {
        Object.assign(node, updates);
      },
    });
    scheduleAutoSave();
    return node;
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
    // execute() 的 redo 完成首次写入（避免双写）
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
    currentArea.value = null;
    viewLevel.value = 'planet';
    selectedNode.value = null;
  }

  // 进入区域地图（下钻到聚落/地点的子视图）
  function selectArea(areaNode) {
    currentArea.value = areaNode;
    viewLevel.value = 'area';
    selectedNode.value = null;
  }

  function backToWorld() {
    currentWorld.value = null;
    currentDomain.value = null;
    currentSystem.value = null;
    currentPlanet.value = null;
    currentArea.value = null;
    viewLevel.value = 'world';
    selectedNode.value = null;
    clearSearch();
  }

  function backToDomain() {
    currentSystem.value = null;
    currentPlanet.value = null;
    currentArea.value = null;
    viewLevel.value = 'domain';
    selectedNode.value = null;
  }

  function backToSystem() {
    currentPlanet.value = null;
    currentArea.value = null;
    viewLevel.value = 'system';
    selectedNode.value = null;
  }

  // 从区域地图返回行星地图
  function backToPlanet() {
    currentArea.value = null;
    viewLevel.value = 'planet';
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
    nodes, hyperlanes, tree, currentWorld, currentDomain, currentSystem, currentPlanet, currentArea, viewLevel,
    selectedNode, searchQuery, searchResults, searchMatchIndex, currentMatchNode,
    worlds, starDomains, galaxies, planets, locations,
    currentWorldDomains, currentDomainGalaxies, currentSystemPlanets, currentPlanetPlaces, currentAreaPlaces, currentDomainAllGalaxies,
    currentDomainHyperlanes, getHyperlanesByNode, getHyperlanesForNode,
    isSearching,
    availableLayers, layerLabels, searchLayerFilter,
    availablePlaceTypes, searchPlaceTypeFilter, togglePlaceTypeFilter,
    toggleLayerFilter, isFilterOpen,
    canUndo, canRedo, undoLabel, mapData, domainBorderOverrides,
    loadGeodata, reextract, saveGeodata,
      updateNodePosition, updateAllCoordinates,
      addNode, removeNode, updateNode,
      addHyperlane, removeHyperlane, updateHyperlane, getHyperlaneById,
      selectNode, clearSelection, selectPlanetOrNode,
      performSearch, cycleSearchMatch, clearSearch, isNodeMatched, isCurrentMatch,
      undo, redo,
      selectWorld, selectDomain, selectSystem, selectPlanet, selectArea, backToWorld, backToDomain, backToSystem, backToPlanet,
      handleNodeUpdated, handleNodeRemoved,
      scheduleAutoSave, scheduleAutoSaveMap, flushSave, autoSaveEnabled,
      loadMapData, saveMapData, getMapDataKey, addTerrainPolygon, removeTerrainPolygon, updateTerrainPolygon, updateControlPoint, saveMapDataImmediate,
      splitTerrainPolygon, mergeTerrainPolygons,
      beginNodePositionCapture, endNodePositionCapture, beginMultiNodePositionCapture, endMultiNodePositionCapture, toggleNodeLock,
      addRegion, removeRegion, updateRegion,
      addRoute, removeRoute, updateRoute,
      addTextLabel, removeTextLabel, updateTextLabel,
      addMarker, removeMarker, updateMarker,
      addCluster, removeCluster, updateCluster, moveClusterMembers,
      updateReferenceImage, clearReferenceImage, removeReferenceImageById,
      addMapSnapshot, removeMapSnapshot, restoreMapSnapshot,
    };
});
