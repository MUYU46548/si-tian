import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { execute, undo as undoCmd, redo as redoCmd, canUndo as undoCanUndo, canRedo as undoCanRedo, getLastCommandLabel } from './undo';
// 单一写闸门（Phase 2）：本文件是「世界观数据落盘」的主要入口，所有 save*/re-extract 必须先过 guardWrite。
// 无项目只读态下这些调用会被拒绝（不写散文件、不写回 Obsidian）。见 store/writeGate.js 的入口清单。
import {
  guardWrite, isReadOnly as gateIsReadOnly, writeMode as gateWriteMode,
  writeModeReason as gateWriteModeReason, WRITE_BLOCKED_HINT,
} from './writeGate';
import { createSearchModule } from './geodataModules/search';
import { createMapDataEditingModule } from './geodataModules/mapDataEditing';
import { createInteriorModule } from './geodataModules/interior';
import { createAreaEditingModule } from './geodataModules/areaEditing';
import { createSpaceEditingModule, normalizeSpaceMarkers, normalizeFleetCards } from './geodataModules/spaceEditing';
import { createScenarioEditingModule } from './geodataModules/scenarioEditing';
// 项目文件接线（Phase 2.4）：画布事实源可在「知识库缓存」与「.sitian 项目文件」之间切换。
// 与 projectStore 之间**不互相 import**，只经本注册表通信（防循环依赖，见该文件头注释）。
import { setCanvasAdapter, getProjectSink } from './canvasBridge';
// 纯函数：实体的规范化构造（保证写进项目文件的实体形状统一；不引入任何 IO）
import { createEntity as createProjectEntity } from '../utils/projectSchema';

const AUTO_SAVE_DELAY = 800;

// JSON.stringify 的 TypedArray 兜底：结构化克隆/深拷贝后 Float32Array 会变成
// {"0":..}（无 length），读回 new Float32Array(obj) 即空数组 → 高度图/地形网格静默丢失。
// 缓存的浮点保留 3 位小数以控制 mapdata.json 体积。
export function jsonSafeReplacer(key, value) {
  if (ArrayBuffer.isView(value) && typeof value.length === 'number') {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const n = value[i];
      out[i] = typeof n === 'number' ? Math.round(n * 1000) / 1000 : n;
    }
    return out;
  }
  return value;
}

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
  // 注意：scenarioEditingModule 必须在 searchModule 之前创建（search 需要引用 scenarios）
  const scenarioEditingModule = createScenarioEditingModule({ execute, scheduleAutoSave, saveScenarios, scheduleAutoSaveScenarios, mapData, scheduleAutoSaveMap });
  const searchModule = createSearchModule({ nodes, scenarios: scenarioEditingModule.scenarios });
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
    isFilterOpen, currentMatchNode, clearSearch, performSearch, includeScenarios,
    toggleLayerFilter, togglePlaceTypeFilter, toggleIncludeScenarios,
    cycleSearchMatch, isNodeMatched, isCurrentMatch, isWikilinkMatch,
  } = searchModule;
  const { interiorData, interiorReferenceImages } = interiorModule;
  const { areaZones, areaRoutes, areaMarkers, areaTextLabels, areaReferenceImages } = areaEditingModule;
  const { spaceMarkers, fleetCards } = spaceEditingModule;
  const { scenarios } = scenarioEditingModule; // 转正 id 级联需改写 ownership（省份归属）键

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
   *
   * @param {Array} rawNodes 要校验的节点
   * @param {Set<string>} [knownIds] 额外可见的节点 id 集合 —— 「增量新增」时必须传：
   *   只校验新增节点时，它们的父级（既有节点）不在 rawNodes 里，会误判为「parentId 不存在」而置空
   *   （实测：项目面板新建的实体在画布上被摘掉父子关系，实体树缩进全变成 0 级）。
   */
  function validateNodes(rawNodes, knownIds = null) {
    const COORD_MIN = -10000;
    const COORD_MAX = 10000;
    const idVisible = (id) => rawNodes.some(n => n.id === id) || (knownIds ? knownIds.has(id) : false);

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
      if (node.parentId && !idVisible(node.parentId)) {
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

    // 循环引用检测：A → B → C → A
    detectCycles(cleaned);

    // B1 越级校验：子节点 layer 必须比父节点 layer 在 LAYER_ORDER 更深（严格大于）。
    // 未知层级（indexOf === -1）无法比较，跳过不判。
    const violations = countLayerOrderViolations(cleaned);
    return { nodes: cleaned, violations };
  }

  /**
   * 检测并打破循环引用（A → B → C → A）
   */
  function detectCycles(nodes) {
    const byId = new Map(nodes.map(n => [n.id, n]));
    const visited = new Set();
    const inStack = new Set();
    const cycles = [];

    function dfs(nodeId, path) {
      if (inStack.has(nodeId)) {
        // 发现循环
        const cycleStart = path.indexOf(nodeId);
        const cycle = path.slice(cycleStart).concat(nodeId);
        cycles.push(cycle);
        return;
      }
      if (visited.has(nodeId)) return;
      
      const node = byId.get(nodeId);
      if (!node || !node.parentId) return;

      visited.add(nodeId);
      inStack.add(nodeId);
      path.push(nodeId);
      
      dfs(node.parentId, path);
      
      path.pop();
      inStack.delete(nodeId);
    }

    for (const node of nodes) {
      if (!visited.has(node.id)) {
        dfs(node.id, []);
      }
    }

    // 打破循环：将循环中最后一个节点的 parentId 置空
    for (const cycle of cycles) {
      const breakNodeId = cycle[cycle.length - 2]; // 最后一个边的起点
      const breakNode = byId.get(breakNodeId);
      if (breakNode) {
        console.warn(`[Geodata] 检测到循环引用: ${cycle.map(id => byId.get(id)?.name || id).join(' → ')}，已打破（${breakNode.name} 的 parentId 置空）`);
        breakNode.parentId = null;
      }
    }

    return cycles;
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
    // 重提取会整库重写 <vault>/.sitian/geodata.json → 属落盘写，只读态必须拒绝
    const gate = guardWrite('重新提取');
    if (!gate.ok) return gate;
    // Phase 2.4：已打开项目时画布的事实源是项目文件 —— 重提取会把知识库数据倒进当前画布，
    // 与「有项目用项目」直接冲突。明确拒绝并给出可行做法（不是静默失败）。
    if (canvasSourceRef.value === 'project') {
      return { ok: false, error: '已打开项目：画布数据来自项目文件，重提取请先关闭项目' };
    }
    const result = await window.sitianAPI.reextractGeodata();
    if (result.success) {
      nodes.value = result.data.nodes || [];
      const autoHyperlanes = result.data.hyperlanes || [];
      const userHyperlanes = hyperlanes.value.filter(h => !h.id.startsWith('auto_'));
      hyperlanes.value = [...autoHyperlanes, ...userHyperlanes];
      // 保留仅存在于缓存中的编辑器数据（提取结果不含这些字段）
      // interiorData / areaZones / areaMarkers 等不受影响，因为它们不走提取
    }
  }

  async function saveGeodata() {
    const gate = guardWrite('保存地理数据');
    if (!gate.ok) return gate;
    // Phase 2.4：已打开项目 → 落盘去向是项目文件（projectStore 是项目文件的唯一写者）
    if (canvasSourceRef.value === 'project') return syncCanvasToProject('保存地理数据');
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

  // ===== 剧本地图持久化（独立文件 scenarios.json）=====
  const saveStatus = ref('idle'); // 'idle' | 'saving' | 'saved' | 'error'
  let saveStatusTimer = null;

  async function saveScenarios() {
    if (!scenarioEditingModule) return;
    const gate = guardWrite('保存剧本');
    if (!gate.ok) return gate;
    // Phase 2.4：已打开项目 → 剧本随项目文件落盘（同一份 saveStatus 反馈照旧给用户）
    if (canvasSourceRef.value === 'project') {
      saveStatus.value = 'saving';
      const r = syncCanvasToProject('保存剧本');
      saveStatus.value = r.ok ? 'saved' : 'error';
      if (saveStatusTimer) clearTimeout(saveStatusTimer);
      saveStatusTimer = setTimeout(() => {
        if (saveStatus.value === 'saved') saveStatus.value = 'idle';
      }, 3000);
      return r;
    }
    saveStatus.value = 'saving';
    try {
      const data = JSON.parse(JSON.stringify({
        version: 2,
        baseMaps: scenarioEditingModule.baseMaps.value,
        scenarios: scenarioEditingModule.scenarios.value,
        updatedAt: new Date().toISOString()
      }));
      await window.sitianAPI.saveScenarios(data);
      saveStatus.value = 'saved';
      if (saveStatusTimer) clearTimeout(saveStatusTimer);
      saveStatusTimer = setTimeout(() => {
        if (saveStatus.value === 'saved') saveStatus.value = 'idle';
      }, 3000);
    } catch (err) {
      saveStatus.value = 'error';
      if (saveStatusTimer) clearTimeout(saveStatusTimer);
      saveStatusTimer = setTimeout(() => {
        if (saveStatus.value === 'error') saveStatus.value = 'idle';
      }, 5000);
    }
  }

  // 防抖保存剧本（笔刷拖拽时避免频繁写盘）
  let scenarioSaveTimer = null;
  function scheduleAutoSaveScenarios() {
    if (gateIsReadOnly.value) return;
    if (scenarioSaveTimer) clearTimeout(scenarioSaveTimer);
    scenarioSaveTimer = setTimeout(() => {
      scenarioSaveTimer = null;
      saveScenarios();
    }, 300);
  }

  // ===== 自动保存 =====
  // 模块级可变状态：自动保存定时器（geodata 域持有，经 ctx 以函数引用方式供各子模块调度）
  let autoSaveTimer = null;
  let autoSaveMapTimer = null;

  function scheduleAutoSave() {
    if (!autoSaveEnabled.value) return;
    if (gateIsReadOnly.value) return; // 只读态：不起自动保存定时器（落盘必被拒，省无谓的定时器与报错）
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(async () => {
      await saveGeodata();
      autoSaveTimer = null;
    }, AUTO_SAVE_DELAY);
  }

  function scheduleAutoSaveMap(planetId) {
    if (!autoSaveEnabled.value) return;
    if (gateIsReadOnly.value) return;
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
    const gate = guardWrite('保存行星地图');
    if (!gate.ok) return gate;
    // Phase 2.4：已打开项目 → 地图数据落进项目文件（mapData 已在内存态更新，这里只触发项目侧落盘）
    if (canvasSourceRef.value === 'project') {
      syncCanvasToProject(`保存行星地图 ${planetId || ''}`.trim());
      return { success: true, source: 'project' };
    }
    try {
      // 深拷贝去除 Vue reactive Proxy（仅用于 IPC 传输）。
      // TypedArray 必须显式转普通数组：JSON.stringify(new Float32Array(3)) → {"0":..}
      // （无 length），读回 new Float32Array(obj) 得到空数组 —— 高度图/地形网格曾被静默清空。
      const cloned = JSON.parse(JSON.stringify(data, jsonSafeReplacer));
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
    // 必须走 saveMapData：它负责 ① 世界前缀化 key（旧实现直写 planetId = 重新制造旧 key）
    // ② TypedArray → 普通数组的 JSON replacer（直传 TypedArray 会被 stringify 成无 length 的对象）
    return saveMapData(planetId, mapData.value[planetId]);
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

  // ===== 工具函数 =====
  function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // ===== 节点 CRUD（使用通用 UndoStore） =====

  function addNode(node) {
    const newNode = { 
      ...node, 
      tags: Array.isArray(node.tags) ? [...node.tags] : [],
      uuid: node.uuid || generateUUID(),
    };
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

  // ===== 节点 id 变更（Draft 转正 id 连续性，2026-09-16） =====
  // 转正后节点 id 由随机 id（`node_<ts>_<rand>`）切换为 normalizeId(文件名)，与
  // scripts/extract-data.js 的提取结果对齐 —— 否则重提取会产出第二个节点（新 id），
  // 而子节点的 parentId、地图数据、剧本归属仍指向那张"消失了的脸"（幽灵引用）。
  //
  // ★ 引用清单（新增任何以节点 id 为「值」或为「键」的结构时必须在此登记，漏一处 = 幽灵引用）
  //   值槽（字段值 === 旧 id → 改写为新 id）：
  //     nodes[].parentId                      子节点归属
  //     hyperlanes[].fromId / toId             航道端点
  //     spaceMarkers[].systemId                太空标记所属恒星系（B6）
  //     fleetCards[].systemId                  部队卡片所属恒星系（B7）
  //     mapData[*].planetId                    行星地图自引用字段
  //     mapData[*].{regions,markers,routes,textLabels,places}[].nodeId   地图对象绑定节点
  //     interiorData[*].buildingId             建筑内部自引用字段
  //     areaZones / areaRoutes / areaMarkers / areaTextLabels 内的 nodeId / areaId / buildingId
  //   数组槽（逐元素改写）：
  //     mapData[*].clusters[].memberIds[]      聚簇成员 id 数组
  //   字典键（键 === 旧 id → 改名）：
  //     mapData（行星 id）、domainBorderOverrides（星域 id）
  //     areaZones|areaRoutes|areaMarkers|areaTextLabels|areaReferenceImages（区域 id）
  //     interiorData|interiorReferenceImages（建筑 id）
  //     scenarios[*].ownership（省份/区域归属键）
  //   不参与级联（已知例外，刻意排除）：
  //     scenarios.baseMaps —— 其键语义混用（既可能是行星**名称**又可能是 id，
  //     如真实数据里并存 `德斯特星` 与 `desite`），按 id 改名会误伤，故不列入；
  //     底图与节点本就非同源（来自 azgaar 导入），重提取不受影响。
  const ID_REF_VALUE_FIELDS = ['nodeId', 'parentId', 'fromId', 'toId', 'systemId', 'areaId', 'buildingId', 'planetId'];
  const ID_REF_ARRAY_FIELDS = ['memberIds'];
  // 深度遍历跳过的重字段（大数组，不可能承载节点 id 字符串引用）
  const ID_REF_SKIP_KEYS = new Set(['terrainGrid', 'heightmap', 'data', 'points', 'grid']);

  // 深度收集「值槽 / 数组槽」——显式记录旧值，undo 直接回填（不做反向推断）
  function collectIdRefSlots(root, oldId, slots, seen) {
    if (!root || typeof root !== 'object' || seen.has(root)) return;
    seen.add(root);
    if (Array.isArray(root)) {
      for (const item of root) collectIdRefSlots(item, oldId, slots, seen);
      return;
    }
    for (const key of Object.keys(root)) {
      const val = root[key];
      if (ID_REF_VALUE_FIELDS.includes(key)) {
        if (val === oldId) slots.push({ container: root, key, old: oldId });
        continue;
      }
      if (ID_REF_ARRAY_FIELDS.includes(key)) {
        if (Array.isArray(val)) {
          val.forEach((v, i) => { if (v === oldId) slots.push({ container: val, key: i, old: oldId }); });
        }
        continue;
      }
      if (ID_REF_SKIP_KEYS.has(key)) continue;
      collectIdRefSlots(val, oldId, slots, seen);
    }
  }

  // 以节点 id 为「字典键」的容器集合（改名而非改字段值）
  function idRefDicts() {
    const dicts = [
      mapData.value,
      domainBorderOverrides.value,
      areaZones.value, areaRoutes.value, areaMarkers.value, areaTextLabels.value, areaReferenceImages.value,
      interiorData.value, interiorReferenceImages.value,
    ];
    const sc = scenarios.value || {};
    for (const key of Object.keys(sc)) {
      const item = sc[key];
      if (item && item.ownership && typeof item.ownership === 'object') dicts.push(item.ownership);
    }
    return dicts;
  }

  /**
   * 同步变更节点 id 并级联更新全部引用（入 undo 栈，可撤销/重做）。
   *
   * @param {string} oldId 当前节点 id
   * @param {string} newId 目标 id（通常为 normalizeId(笔记文件名)）
   * @returns {{success: boolean, changed?: boolean, oldId?: string, newId?: string,
   *            reason?: string, collidesWith?: string, refs?: number, dictKeys?: number, warnings?: string[]}}
   *   冲突（目标 id 已存在）时返回 success:false —— 调用方应降级为「只回填 sourcePath，id 不变」，不阻断转正。
   */
  function changeNodeId(oldId, newId) {
    const node = nodes.value.find(n => n.id === oldId);
    if (!node) return { success: false, reason: '节点不存在' };
    if (!newId) return { success: false, reason: '目标 id 为空' };
    if (oldId === newId) return { success: true, changed: false, oldId, newId };
    if (nodes.value.some(n => n.id === newId)) {
      return { success: false, reason: '目标 id 已存在', collidesWith: newId };
    }

    // ---- 采集阶段：一次性把所有被修改的位置与旧值记录下来（undo 闭包只做回填） ----
    const seen = new Set();
    const slots = [];
    collectIdRefSlots(nodes.value, oldId, slots, seen);
    collectIdRefSlots(hyperlanes.value, oldId, slots, seen);
    collectIdRefSlots(spaceMarkers.value, oldId, slots, seen);
    collectIdRefSlots(fleetCards.value, oldId, slots, seen);
    collectIdRefSlots(mapData.value, oldId, slots, seen);
    collectIdRefSlots(areaZones.value, oldId, slots, seen);
    collectIdRefSlots(areaRoutes.value, oldId, slots, seen);
    collectIdRefSlots(areaMarkers.value, oldId, slots, seen);
    collectIdRefSlots(areaTextLabels.value, oldId, slots, seen);
    collectIdRefSlots(areaReferenceImages.value, oldId, slots, seen);
    collectIdRefSlots(interiorData.value, oldId, slots, seen);
    collectIdRefSlots(interiorReferenceImages.value, oldId, slots, seen);

    const dicts = idRefDicts();
    const keyHits = dicts.filter(d => d && Object.prototype.hasOwnProperty.call(d, oldId));
    const mapDataRenamed = keyHits.includes(mapData.value);

    const writeValues = (value) => {
      for (const s of slots) s.container[s.key] = value;
    };
    const writeOldValues = () => {
      for (const s of slots) s.container[s.key] = s.old;
    };
    const renameKeys = (from, to) => {
      for (const d of keyHits) {
        if (!Object.prototype.hasOwnProperty.call(d, from)) continue;
        d[to] = d[from];
        delete d[from];
      }
    };

    // 写入全部在 execute 的 redo 内完成（undo 纪律：execute 前不得手动改数据）
    execute({
      type: 'change-node-id',
      label: `同步节点 id（${oldId} → ${newId}）`,
      category: 'property',
      undo: () => {
        renameKeys(newId, oldId);
        writeOldValues();
        node.id = oldId;
      },
      redo: () => {
        renameKeys(oldId, newId);
        writeValues(newId);
        node.id = newId;
      },
    });

    const warnings = [];
    if (mapDataRenamed) {
      // 内存索引与磁盘 key 必须一致：按新 key 重新落盘，旧 key 的缓存文件成为孤儿（不自动删除）
      scheduleAutoSaveMap(newId);
      warnings.push('行星地图已迁移到新 id 的 key，旧 key 的缓存文件为孤儿文件（可手动清理）');
    }
    scheduleAutoSave();
    scheduleAutoSaveScenarios();
    return {
      success: true, changed: true, oldId, newId,
      refs: slots.length, dictKeys: keyHits.length, warnings,
    };
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
  // ===== 并发编辑保护 =====
  let isDragging = false;
  let pendingNodeUpdates = [];

  function setDragging(state) {
    isDragging = state;
    if (!state && pendingNodeUpdates.length > 0) {
      // 拖拽结束后应用挂起的更新
      for (const node of pendingNodeUpdates) {
        applyNodeUpdate(node);
      }
      pendingNodeUpdates = [];
    }
  }

  function handleNodeUpdated(node) {
    if (isDragging) {
      // 拖拽期间暂存更新，避免打断用户操作
      const idx = pendingNodeUpdates.findIndex(n => n.id === node.id);
      if (idx !== -1) pendingNodeUpdates[idx] = node;
      else pendingNodeUpdates.push(node);
      return;
    }
    applyNodeUpdate(node);
  }

  function applyNodeUpdate(node) {
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

  // ===== 项目文件接线（Phase 2.4）=============================================
  // 决策：有项目文件 → 画布的事实源 = 项目文件（实体树 / 航道 / 地图 / 剧本）；
  //       无项目 → 知识库缓存（legacy，行为与接线前一致）。
  // 实现要点：
  //   · geodata 仍是**唯一工作内存** —— 七层视图与全部编辑器一行不改，只切换「装载来源」与「落盘去向」；
  //   · 与 projectStore 之间不互相 import，只经 store/canvasBridge.js 注册表通信（防循环依赖）；
  //   · 打开项目时把打开前的知识库工作态**留底**，关闭项目时原样恢复
  //     （否则用户关掉项目后画布会变空 —— 那是数据看起来"丢了"的最坏观感）。
  const canvasSourceRef = ref('vault');   // 'vault' | 'project'
  let vaultSnapshot = null;                // 打开项目前的知识库工作态留底

  /** 编辑器容器（不进 nodes/hyperlanes，但同样属于世界观数据，必须随事实源一起切换） */
  function readEditorContainers() {
    return {
      domainBorderOverrides: JSON.parse(JSON.stringify(domainBorderOverrides.value, jsonSafeReplacer)),
      interiorData: JSON.parse(JSON.stringify(interiorData.value, jsonSafeReplacer)),
      areaZones: JSON.parse(JSON.stringify(areaZones.value, jsonSafeReplacer)),
      areaRoutes: JSON.parse(JSON.stringify(areaRoutes.value, jsonSafeReplacer)),
      areaMarkers: JSON.parse(JSON.stringify(areaMarkers.value, jsonSafeReplacer)),
      areaTextLabels: JSON.parse(JSON.stringify(areaTextLabels.value, jsonSafeReplacer)),
      areaReferenceImages: JSON.parse(JSON.stringify(areaReferenceImages.value, jsonSafeReplacer)),
      interiorReferenceImages: JSON.parse(JSON.stringify(interiorReferenceImages.value, jsonSafeReplacer)),
      spaceMarkers: normalizeSpaceMarkers(spaceMarkers.value),
      fleetCards: normalizeFleetCards(fleetCards.value),
    };
  }

  function writeEditorContainers(src = {}) {
    domainBorderOverrides.value = src.domainBorderOverrides || {};
    interiorData.value = src.interiorData || {};
    areaZones.value = src.areaZones || {};
    areaRoutes.value = src.areaRoutes || {};
    areaMarkers.value = src.areaMarkers || {};
    areaTextLabels.value = src.areaTextLabels || {};
    areaReferenceImages.value = src.areaReferenceImages || {};
    interiorReferenceImages.value = src.interiorReferenceImages || {};
    spaceMarkers.value = normalizeSpaceMarkers(src.spaceMarkers);
    fleetCards.value = normalizeFleetCards(src.fleetCards);
  }

  function takeVaultSnapshot() {
    return {
      nodes: nodes.value.map(n => ({ ...n })),
      hyperlanes: hyperlanes.value.map(h => ({ ...h })),
      mapData: JSON.parse(JSON.stringify(mapData.value, jsonSafeReplacer)),
      editor: readEditorContainers(),
      scenarios: scenarioEditingModule ? {
        baseMaps: JSON.parse(JSON.stringify(scenarioEditingModule.baseMaps.value, jsonSafeReplacer)),
        scenarios: JSON.parse(JSON.stringify(scenarioEditingModule.scenarios.value, jsonSafeReplacer)),
      } : null,
    };
  }

  const numOrNull = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

  /** 实体结构的「已知字段」；之外的字段是画布侧的编辑数据，必须随实体一起往返。 */
  const ENTITY_SHAPE_KEYS = new Set([
    'id', 'name', 'layer', 'layerLabel', 'parentId', 'tags', 'coordinate',
    'origin', 'sourcePath', 'uuid', 'createdAt', 'updatedAt',
  ]);

  /**
   * 取出实体上「项目 schema 不认识」的字段（placeType / wikilinks / population / cultureId /
   * sizeScale / locked …）。
   *
   * 🔴 为什么必须显式往返：这些字段丢了**不会报任何错**，只会让项目模式下的能力静默退化 ——
   *   丢 `placeType` → 行星图/区域图上聚落与地点的图标、配色全部退化；
   *   丢 `population` → 聚落图标不按人口分级；丢 `wikilinks` → 搜索的「提及」命中整块消失。
   *   本仓真实数据（ROSA 121 节点）里 117 个带 placeType、120 个带 wikilinks，一开项目就全丢。
   */
  function entityExtras(e) {
    const out = {};
    for (const [k, v] of Object.entries(e || {})) {
      if (!ENTITY_SHAPE_KEYS.has(k)) out[k] = v;
    }
    return out;
  }

  /** 项目实体 → 画布节点（GeoNode 同形；项目实体没有 Obsidian 词条 → sourcePath 为空即 draft） */
  function entityToNode(e) {
    const c = (e && e.coordinate) || {};
    return {
      ...entityExtras(e),               // placeType / wikilinks / population …（先铺，后面用标准字段覆盖）
      id: e.id,
      name: e.name,
      layer: e.layer,
      layerLabel: e.layerLabel || layerLabels[e.layer] || e.layer,
      parentId: e.parentId || null,
      tags: Array.isArray(e.tags) ? [...e.tags] : [],
      sourcePath: e.sourcePath || '',
      wikilinks: Array.isArray(e.wikilinks) ? [...e.wikilinks] : [],
      coordinate: { x: numOrNull(c.x), y: numOrNull(c.y) },
      uuid: e.uuid || '',
      origin: e.origin || 'project',
      draft: !e.sourcePath,            // 无词条 = 暂存节点（虚线边框 + 可转正）
      createdAt: e.createdAt || '',
    };
  }

  /** 画布节点 → 项目实体（走 schema 的 createEntity 保证形状统一；显式传 id/uuid 不重新生成） */
  function nodeToProjectEntity(n, now) {
    const entity = createProjectEntity({
      id: n.id,
      name: n.name,
      layer: n.layer,
      parentId: n.parentId || null,
      tags: n.tags || [],
      coordinate: { x: numOrNull(n.coordinate && n.coordinate.x), y: numOrNull(n.coordinate && n.coordinate.y) },
      origin: 'canvas',
      sourcePath: n.sourcePath || '',
      uuid: n.uuid || '',
      now,
    });
    // 画布侧的编辑字段原样带走（见 entityExtras 的说明）。`draft` 由 sourcePath 派生，不落库。
    for (const [k, v] of Object.entries(n)) {
      if (k === 'draft' || k in entity) continue;
      entity[k] = v;
    }
    return entity;
  }

  /** 画布 → 项目文件载荷（唯一写者仍是 projectStore；本函数只产出，不落盘） */
  function exportCanvasToProject() {
    const now = new Date().toISOString();
    const entities = {};
    for (const n of nodes.value) entities[n.id] = nodeToProjectEntity(n, now);
    return {
      entities,
      hyperlanes: JSON.parse(JSON.stringify(hyperlanes.value)),
      // maps 不进快照（体积），另有整文件备份兜底；editor 放这里也一样（快照回滚不覆盖编辑器容器，
      // 这条限制写在 projectSchema 的头部注释里）
      maps: {
        mapData: JSON.parse(JSON.stringify(mapData.value, jsonSafeReplacer)),
        editor: readEditorContainers(),
      },
      scenarios: scenarioEditingModule ? {
        version: 2,
        baseMaps: JSON.parse(JSON.stringify(scenarioEditingModule.baseMaps.value, jsonSafeReplacer)),
        scenarios: JSON.parse(JSON.stringify(scenarioEditingModule.scenarios.value, jsonSafeReplacer)),
      } : undefined,
    };
  }

  /** 打开/新建项目后调用：把画布切到项目文件 */
  function applyProjectToCanvas(project) {
    if (!project) return { ok: false, error: '没有项目' };
    if (!vaultSnapshot) vaultSnapshot = takeVaultSnapshot();
    const list = Object.values(project.entities || {}).map(entityToNode);
    nodes.value = validateNodes(list).nodes;
    hyperlanes.value = Array.isArray(project.hyperlanes) ? project.hyperlanes.map(h => ({ ...h })) : [];
    mapData.value = (project.maps && project.maps.mapData)
      ? JSON.parse(JSON.stringify(project.maps.mapData, jsonSafeReplacer)) : {};
    // 区域/建筑/太空等编辑器容器（项目文件里存于 maps.editor；老项目没有 → 一律清空）
    writeEditorContainers((project.maps && project.maps.editor) || {});
    if (scenarioEditingModule) {
      const sc = project.scenarios || {};
      scenarioEditingModule.baseMaps.value = sc.baseMaps ? JSON.parse(JSON.stringify(sc.baseMaps)) : {};
      scenarioEditingModule.scenarios.value = sc.scenarios ? JSON.parse(JSON.stringify(sc.scenarios)) : {};
    }
    canvasSourceRef.value = 'project';
    backToWorld();   // 别停在项目里不存在的节点上
    return { ok: true, source: 'project', nodes: nodes.value.length, hyperlanes: hyperlanes.value.length };
  }

  /**
   * 实体 → 画布节点上「可被项目侧覆盖」的字段集（与 entityToNode 同形，但**不含坐标** —— 坐标以画布为准）。
   */
  function entityNodeFields(e) {
    const fields = entityToNode(e);
    delete fields.coordinate;
    return fields;
  }

  /**
   * 项目侧实体变更 → 同步画布（按 id 双向补齐：项目里改名的更新画布节点、新增的补进画布、
   * 已删除的从画布移除）。**坐标以画布为准**（项目实体里的坐标可能落后于用户刚拖动的值）。
   * 由 projectStore 在 entities 变化时调用（含 undo/redo —— 否则撤销后画布会与项目脱节，
   * 下一次画布保存会把撤销结果覆盖掉）。
   *
   * 🔴 两个不变量，都踩过（症状全是静默的）：
   *   ① **就地更新，绝不重建节点对象**。本函数挂在「项目实体变化」的 watch 上，而**画布每次保存
   *      都会改项目实体** → 调用频率极高。若重建对象，`store.selectedNode` / `currentPlanet` /
   *      AreaMap 的本地选中…… 一切按**对象引用**持有的「当前节点」立刻变成脱离数组的旧对象：
   *      · 详情面板显示陈旧数据（实测：文化下拉选中后色块不出现）；
   *      · 转正按钮更狠 —— `promoteDraft` 里 `changeNodeId(n.id, newId)` 之后写
   *        `updateNode(n.id, {sourcePath})` 靠的是「n 是同一个对象、id 已被就地改掉」，
   *        对象一旦脱钩，`updateNode` 就打在**已不存在的旧 id** 上 → sourcePath 静默没回填。
   *   ② 新增节点才走 `validateNodes`（旧节点进画布时已校验过；重建它们等于放弃 ①）。
   */
  function refreshEntitiesFromProject(entities) {
    const byId = new Map(Object.values(entities || {}).map(e => [e.id, e]));
    const kept = [];
    for (const n of nodes.value) {
      const e = byId.get(n.id);
      if (!e) continue;                     // 项目里已删除 → 画布同步移除
      byId.delete(n.id);
      const next = entityNodeFields(e);
      for (const k of Object.keys(n)) {
        if (k === 'coordinate') continue;   // 坐标以画布为准，本函数不碰（entityNodeFields 已摘掉它）
        if (!(k in next)) delete n[k];      // 实体上已没有的字段也要跟着消失（否则留下陈旧值）
      }
      Object.assign(n, next);
      kept.push(n);
    }
    const added = [...byId.values()].map(entityToNode);   // 项目里新增 → 画布补上
    // ⚠️ 新增节点单独校验时必须把既有节点 id 一并告知（knownIds），否则它们的父级「看不见」
    //    会被判成「parentId 不存在」而置空 —— 实体树层级会整片塌成 0 级（实测踩过）。
    const knownIds = new Set([...kept.map(n => n.id), ...added.map(n => n.id)]);
    nodes.value = added.length ? [...kept, ...validateNodes(added, knownIds).nodes] : kept;
    return { ok: true, nodes: nodes.value.length };
  }

  /** 关闭项目后调用：恢复打开前的知识库工作态 */
  function releaseProjectFromCanvas() {
    const snap = vaultSnapshot;
    canvasSourceRef.value = 'vault';
    if (!snap) return { ok: true, restored: false };
    nodes.value = snap.nodes;
    hyperlanes.value = snap.hyperlanes;
    mapData.value = snap.mapData;
    if (snap.editor) writeEditorContainers(snap.editor);
    if (scenarioEditingModule && snap.scenarios) {
      scenarioEditingModule.baseMaps.value = snap.scenarios.baseMaps;
      scenarioEditingModule.scenarios.value = snap.scenarios.scenarios;
    }
    backToWorld();
    return { ok: true, restored: true };
  }

  /** 画布 → 项目（转交 projectStore 落盘；本函数不写磁盘） */
  function syncCanvasToProject(reason = '画布保存') {
    const s = getProjectSink();
    if (!s || typeof s.syncFromCanvas !== 'function') {
      return { ok: false, error: '项目接线未就绪（projectStore 未装载）' };
    }
    s.syncFromCanvas(exportCanvasToProject(), reason);
    return { ok: true, source: 'project' };
  }

  // 注册适配器：projectStore 在 打开/保存/关闭 项目 时回调这里
  setCanvasAdapter({
    source: () => canvasSourceRef.value,
    applyProject: applyProjectToCanvas,
    releaseProject: releaseProjectFromCanvas,
    refreshEntities: refreshEntitiesFromProject,
    exportCanvas: exportCanvasToProject,
    describe: () => ({
      attached: true,
      source: canvasSourceRef.value,
      nodes: nodes.value.length,
      hasVaultSnapshot: !!vaultSnapshot,
    }),
  });

  return {
    nodes, hyperlanes, tree, currentWorld, currentDomain, currentSystem, currentPlanet, currentArea, viewLevel,
    selectedNode, searchQuery, searchResults, searchMatchIndex, currentMatchNode, isWikilinkMatch,
    worlds, starDomains, galaxies, planets, locations,
    currentWorldDomains, currentDomainGalaxies, currentSystemPlanets, currentPlanetPlaces, currentAreaPlaces, currentDomainAllGalaxies,
    currentDomainHyperlanes, getHyperlanesByNode, getHyperlanesForNode,
    currentBuilding, currentBuildingFurniture,
    isSearching,
    availableLayers, layerLabels, searchLayerFilter,
    availablePlaceTypes, searchPlaceTypeFilter, togglePlaceTypeFilter,
    toggleLayerFilter, isFilterOpen,
    canUndo, canRedo, undoLabel, mapData, domainBorderOverrides,
    // 单一写闸门状态（Phase 2）：UI 侧据此做灰禁与「只读」提示
    isReadOnly: gateIsReadOnly, writeMode: gateWriteMode, readOnlyReason: gateWriteModeReason,
    writeBlockedHint: WRITE_BLOCKED_HINT,
    loadGeodata, reextract, saveGeodata, validateNodes, saveScenarios,
    saveStatus,
    FACTION_COLORS, getFactionColor,
      updateNodePosition, updateAllCoordinates,
      addNode, removeNode, updateNode, changeNodeId, reparentNode, reparentNodes,
      addHyperlane, removeHyperlane, updateHyperlane, getHyperlaneById,
      selectNode, clearSelection, selectPlanetOrNode,
      performSearch, cycleSearchMatch, clearSearch, isNodeMatched, isCurrentMatch,
      undo, redo,
      selectWorld, selectDomain, selectSystem, enterSystemDetail, selectPlanet, selectArea, selectBuilding, backToWorld, backToDomain, backToSystem, backToPlanet, backToArea,
      handleNodeUpdated, handleNodeRemoved, setDragging,
      scheduleAutoSave, scheduleAutoSaveMap, flushSave, autoSaveEnabled,
      loadMapData, saveMapData, getMapDataKey, saveMapDataImmediate,
      beginNodePositionCapture, endNodePositionCapture, beginMultiNodePositionCapture, endMultiNodePositionCapture, toggleNodeLock,
      getBuildingsInArea,
      // 项目文件接线（Phase 2.4）：画布事实源 + 画布↔项目 同步（测试与 UI 都读这里）
      canvasSource: canvasSourceRef, applyProjectToCanvas, releaseProjectFromCanvas,
      refreshEntitiesFromProject, exportCanvasToProject, syncCanvasToProject,
    ...searchModule,
    ...mapDataEditingModule,
    ...interiorModule,
    ...areaEditingModule,
    ...spaceEditingModule,
    ...scenarioEditingModule,
  };
});
