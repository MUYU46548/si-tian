import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { execute, undo as undoCmd, redo as redoCmd, canUndo as undoCanUndo, canRedo as undoCanRedo, getLastCommandLabel } from './undo';
import { createSearchModule } from './geodataModules/search';
import { createMapDataEditingModule } from './geodataModules/mapDataEditing';
import { createInteriorModule } from './geodataModules/interior';
import { createAreaEditingModule } from './geodataModules/areaEditing';
import { createSpaceEditingModule, normalizeSpaceMarkers, normalizeFleetCards } from './geodataModules/spaceEditing';

const AUTO_SAVE_DELAY = 800;

// 层级深度顺序（B1 越级校验用）——与 scripts/extract-data.js 的 LAYER_ORDER 保持同步，
// 两处同步修改；renderer 侧不直接 import 提取脚本（Node 脚本无法进浏览器 bundle）
const LAYER_ORDER = ['world', 'star_domain', 'galaxy', 'star', 'planet', 'moon', 'region', 'city', 'town', 'village', 'building', 'facility', 'location', 'unknown'];

export const useGeodataStore = defineStore('geodata', () => {
  const nodes = ref([]);
  const hyperlanes = ref([]);
  const currentWorld = ref(null);
  const currentDomain = ref(null);
  const currentSystem = ref(null);
  const currentPlanet = ref(null);
  const currentArea = ref(null); // 当前下钻区域（城市/地点节点）
  const currentBuilding = ref(null); // 当前下钻建筑（第三层）

  // ===== 未来视图扩展点预留（批次 B2，仅注释、零副作用）=====
  // 现有 viewLevel: 'world' | 'domain' | 'system' | 'system_detail' | 'planet' | 'area' | 'interior'
  // 预留三个扩展方向（接入前不要提前建状态/路由，保持零副作用）：
  // 1. 'universe' 宇宙总览 —— 多世界之上的宏观层。接入步骤：
  //    a. App.vue 增加 v-if="store.viewLevel === 'universe'" 路由分支（新组件 UniverseView）
  //    b. 面包屑最左插入「宇宙」段；store 增加 currentUniverse ref
  //    c. layers.js 新增 universe 图层栈（各世界卡片/世界间连线）
  //    d. select 动作：UniverseView 点击世界 → selectWorld（现有链路直接复用）
  // 2. 'timeline' 时间维度 —— 同一地理在不同时代的切片。推荐做成现有视图的横切过滤而非新视图级：
  //    a. store 增加 currentEra ref + geodata/mapdata 增加 era 维度（或独立 timeline 缓存文件）
  //    b. 顶栏加时代切换器；各视图组件按 era 过滤节点/坐标
  //    c. 若确需独立视图：App.vue 路由分支 + TimelineView + layers.js 的 timeline 图层栈
  // 3. 'scene' 场景视图 —— 地点特写（城市场景/室内场景的延伸，比 area 更深一级）：
  //    a. App.vue 增加 v-if="store.viewLevel === 'scene'" 路由分支（新组件 SceneView）
  //    b. 面包屑在 area 段后顺延一段；store 增加 currentScene ref
  //    c. layers.js 新增 scene 图层栈；select 动作：AreaMap 点击场景地点 → selectScene(node)
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

  // ===== 领域子模块组装 =====
  // 各模块通过 ctx 拿到所需的 refs/函数引用（ref 传引用保持响应式）
  const searchModule = createSearchModule({ nodes });
  const interiorModule = createInteriorModule({ execute, scheduleAutoSave });
  const areaEditingModule = createAreaEditingModule({ execute, scheduleAutoSave });
  // 太空实体编辑（B6 太空标记 / B7 部队卡片）：扁平数组，坐标系为「相对恒星」的系内偏移
  const spaceEditingModule = createSpaceEditingModule({ execute, scheduleAutoSave });
  const mapDataEditingModule = createMapDataEditingModule({
    mapData, nodes, execute, scheduleAutoSave, scheduleAutoSaveMap,
  });

  // 从模块解构常用 state（保持原 store 内引用）
  const {
    searchQuery, searchResults, searchMatchIndex, searchLayerFilter, searchPlaceTypeFilter,
    isFilterOpen, currentMatchNode, clearSearch, performSearch,
    toggleLayerFilter, togglePlaceTypeFilter,
    cycleSearchMatch, isNodeMatched, isCurrentMatch,
  } = searchModule;
  const { interiorData, interiorReferenceImages } = interiorModule;
  const { areaZones, areaRoutes, areaMarkers, areaTextLabels, areaReferenceImages } = areaEditingModule;
  const { spaceMarkers, fleetCards } = spaceEditingModule;

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

  // 建筑内部：当前建筑的家具/物品列表
  const currentBuildingFurniture = computed(() => {
    if (!currentBuilding.value) return [];
    const data = interiorData.value[currentBuilding.value.id];
    return data?.floors || [];
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
    const order = ['world', 'star_domain', 'galaxy', 'star', 'planet', 'moon', 'region', 'city', 'town', 'village', 'building', 'facility', 'location'];
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
    town: '城镇', village: '村庄', building: '建筑', facility: '设施', location: '地点', unknown: '未知'
  };

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
      const validated = validateNodes(result.data.nodes || []);
      nodes.value = validated.nodes;
      hyperlanes.value = result.data.hyperlanes || [];
      domainBorderOverrides.value = result.data.domainBorderOverrides || {};
      interiorData.value = result.data.interiorData || {};
      areaZones.value = result.data.areaZones || {};
      areaRoutes.value = result.data.areaRoutes || {};
      areaMarkers.value = result.data.areaMarkers || {};
      areaTextLabels.value = result.data.areaTextLabels || {};
      areaReferenceImages.value = result.data.areaReferenceImages || {};
      interiorReferenceImages.value = result.data.interiorReferenceImages || {};
      // B6/B7 太空实体：缺字段兼容（无 id/systemId 的脏数据被过滤，类型/数值补默认值）
      spaceMarkers.value = normalizeSpaceMarkers(result.data.spaceMarkers);
      fleetCards.value = normalizeFleetCards(result.data.fleetCards);
    } else {
      console.error('Failed to load geodata:', result.error);
      nodes.value = [];
      hyperlanes.value = [];
      domainBorderOverrides.value = {};
      interiorData.value = {};
      areaZones.value = {};
      areaRoutes.value = {};
      areaMarkers.value = {};
      areaTextLabels.value = {};
      areaReferenceImages.value = {};
      interiorReferenceImages.value = {};
      spaceMarkers.value = [];
      fleetCards.value = [];
    }
  }

  /**
   * 校验并清理节点数据，防止异常坐标导致渲染错误
   * 返回 { nodes: 清理后的节点数组, violations: 层级越级违规数 }（B1）
   */
  function validateNodes(rawNodes) {
    const COORD_MIN = -10000;
    const COORD_MAX = 10000;

    const cleaned = rawNodes.map(node => {
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

      // 自引用父级（parentId 指向自身）视为无效父级：
      // 会造成树构建自嵌套（tree computed 的 children 循环引用），与"parentId 不存在"同类的数据脏污，直接置空
      if (node.parentId && node.parentId === node.id) {
        console.warn(`[Geodata] 节点 "${node.name}" 的 parentId 指向自身，已置空`);
        node.parentId = null;
      }

      return {
        ...node,
        coordinate: { x, y },
        tags: Array.isArray(node.tags) ? node.tags : [],
      };
    });

    // B1 越级校验：子节点 layer 必须比父节点 layer 在 LAYER_ORDER 更深（严格大于）。
    // 未知层级（indexOf === -1）无法比较，跳过不判。
    const violations = countLayerOrderViolations(cleaned);
    return { nodes: cleaned, violations };
  }

  /**
   * 统计层级越级违规（B1）：console.warn 列出并返回违规数
   */
  function countLayerOrderViolations(cleanedNodes) {
    const byId = new Map(cleanedNodes.map(n => [n.id, n]));
    let violations = 0;
    for (const node of cleanedNodes) {
      if (!node.parentId) continue;
      const parent = byId.get(node.parentId);
      if (!parent) continue;
      const childIdx = LAYER_ORDER.indexOf(node.layer);
      const parentIdx = LAYER_ORDER.indexOf(parent.layer);
      if (childIdx === -1 || parentIdx === -1) continue;
      if (childIdx < parentIdx) {
        violations++;
        console.warn(
          `[Geodata] 越级节点 "${node.name}"(layer=${node.layer}) 的父级 "${parent.name}"(layer=${parent.layer}) 层级不比其更深`
        );
      }
    }
    return violations;
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
      interiorData: interiorData.value,
      areaZones: areaZones.value,
      areaRoutes: areaRoutes.value,
      areaMarkers: areaMarkers.value,
      areaTextLabels: areaTextLabels.value,
      areaReferenceImages: areaReferenceImages.value,
      spaceMarkers: spaceMarkers.value,
      fleetCards: fleetCards.value,
      updatedAt: new Date().toISOString()
    }));
    await window.sitianAPI.saveGeodata(data);
  }

  // ===== 自动保存 =====
  // 模块级可变状态：自动保存定时器（geodata 域持有，经 ctx 以函数引用方式供各子模块调度）
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
      // 内存缓存命中直接返回（批次A3：避免每次进入行星视图都重走 IPC+JSON 解析；
      // 清除坐标缓存时 App 侧会整体重置 mapData，不会供旧数据）
      if (mapData.value[planetId]) return mapData.value[planetId];
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

  function saveMapDataImmediate(planetId) {
    if (!mapData.value[planetId]) return;
    window.sitianAPI.saveMapData(planetId, mapData.value[planetId]);
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
  // 模块级可变状态：节点拖拽起始坐标捕获（节点域持有）
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
  // 模块级可变状态：多节点拖拽起始坐标捕获（节点域持有）
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

  // ===== 节点层级迁移（含循环检测） =====
  // 安全地将节点迁移到新的父节点下
  // 返回 { success: boolean, reason?: string }
  function reparentNode(nodeId, newParentId) {
    const node = nodes.value.find(n => n.id === nodeId);
    if (!node) return { success: false, reason: '节点不存在' };

    // null 表示移到根层（行星下）
    if (newParentId === null) {
      const oldParentId = node.parentId;
      updateNode(nodeId, { parentId: null });
      return { success: true, oldParentId };
    }

    const newParent = nodes.value.find(n => n.id === newParentId);
    if (!newParent) return { success: false, reason: '目标父节点不存在' };

    // 不能将自己设为自己的父节点
    if (newParentId === nodeId) return { success: false, reason: '不能将节点设为自己的父节点' };

    // 循环检测：新父节点不能是当前节点的后代（避免形成环）
    let cursor = newParent;
    while (cursor) {
      if (cursor.id === nodeId) return { success: false, reason: '不能将节点移到自己的子树下（会形成循环）' };
      cursor = cursor.parentId ? nodes.value.find(n => n.id === cursor.parentId) : null;
    }

    const oldParentId = node.parentId;
    updateNode(nodeId, { parentId: newParentId });
    return { success: true, oldParentId };
  }

  // 批量迁移多个节点到同一父节点
  function reparentNodes(nodeIds, newParentId) {
    const results = [];
    for (const id of nodeIds) {
      const res = reparentNode(id, newParentId);
      results.push({ id, ...res });
    }
    return results;
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

  // 进入单恒星系详情视图（批次 B4：点击恒星系亮点下钻，Stellaris 式单系地图）
  function selectSystem(system) {
    currentSystem.value = system;
    currentPlanet.value = null;
    viewLevel.value = 'system_detail';
    selectedNode.value = null;
  }

  // 从星域地图点击恒星系亮点进入单系视图：顺带补齐 currentDomain（面包屑第三/四段依赖）
  function enterSystemDetail(system) {
    const domain = nodes.value.find(n => n.id === system.parentId && n.layer === 'star_domain');
    if (domain) currentDomain.value = domain;
    selectSystem(system);
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

  // 进入建筑内部（第三层下钻）
  function selectBuilding(buildingNode) {
    currentBuilding.value = buildingNode;
    viewLevel.value = 'interior';
    selectedNode.value = null;
    // 初始化建筑的内部数据结构（如不存在）
    if (!interiorData.value[buildingNode.id]) {
      interiorData.value[buildingNode.id] = {
        buildingId: buildingNode.id,
        floors: [],
      };
    }
  }

  function backToWorld() {
    currentWorld.value = null;
    currentDomain.value = null;
    currentSystem.value = null;
    currentPlanet.value = null;
    currentArea.value = null;
    currentBuilding.value = null;
    viewLevel.value = 'world';
    selectedNode.value = null;
    clearSearch();
  }

  function backToDomain() {
    currentSystem.value = null;
    currentPlanet.value = null;
    currentArea.value = null;
    currentBuilding.value = null;
    viewLevel.value = 'domain';
    selectedNode.value = null;
  }

  function backToSystem() {
    currentPlanet.value = null;
    currentArea.value = null;
    currentBuilding.value = null;
    viewLevel.value = 'system';
    selectedNode.value = null;
  }

  // 从建筑内部返回区域地图
  function backToArea() {
    currentBuilding.value = null;
    viewLevel.value = 'area';
    selectedNode.value = null;
  }

  // 从区域地图返回行星地图
  function backToPlanet() {
    currentArea.value = null;
    currentBuilding.value = null;
    viewLevel.value = 'planet';
    selectedNode.value = null;
  }

  // 获取当前区域内的所有建筑（用于建筑间跳转）
  function getBuildingsInArea(areaId) {
    return nodes.value.filter(n => n.parentId === areaId && n.layer === 'building');
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
    currentBuilding, currentBuildingFurniture,
    isSearching,
    availableLayers, layerLabels, searchLayerFilter,
    availablePlaceTypes, searchPlaceTypeFilter, togglePlaceTypeFilter,
    toggleLayerFilter, isFilterOpen,
    canUndo, canRedo, undoLabel, mapData, domainBorderOverrides,
    loadGeodata, reextract, saveGeodata, validateNodes,
    FACTION_COLORS, getFactionColor,
      updateNodePosition, updateAllCoordinates,
      addNode, removeNode, updateNode, reparentNode, reparentNodes,
      addHyperlane, removeHyperlane, updateHyperlane, getHyperlaneById,
      selectNode, clearSelection, selectPlanetOrNode,
      performSearch, cycleSearchMatch, clearSearch, isNodeMatched, isCurrentMatch,
      undo, redo,
      selectWorld, selectDomain, selectSystem, enterSystemDetail, selectPlanet, selectArea, selectBuilding, backToWorld, backToDomain, backToSystem, backToPlanet, backToArea,
      handleNodeUpdated, handleNodeRemoved,
      scheduleAutoSave, scheduleAutoSaveMap, flushSave, autoSaveEnabled,
      loadMapData, saveMapData, getMapDataKey, saveMapDataImmediate,
      beginNodePositionCapture, endNodePositionCapture, beginMultiNodePositionCapture, endMultiNodePositionCapture, toggleNodeLock,
      getBuildingsInArea,
    ...searchModule,
    ...mapDataEditingModule,
    ...interiorModule,
    ...areaEditingModule,
    ...spaceEditingModule,
  };
});
