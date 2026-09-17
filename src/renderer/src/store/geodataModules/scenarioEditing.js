// store/geodataModules/scenarioEditing.js — 剧本地图 store 模块
// ctx: { execute, scheduleAutoSave, saveScenarios }
// 所有 mutation 走 execute（redo 内写入，防双写铁律）


import { ref } from 'vue';
import {
  brushFalloff, deriveLayers, SEA_LEVEL,
} from '../../utils/heightMath';
import {
  scheduleDerive, isWorkerAvailable, getAsyncThreshold, getDeriveStats,
} from '../../utils/deriveClient';

export function createScenarioEditingModule(ctx) {
  const { execute, scheduleAutoSave, saveScenarios, scheduleAutoSaveScenarios, mapData, scheduleAutoSaveMap } = ctx;

  const baseMaps = ref({});
  const scenarios = ref({});

  // P2-4：派生计算世代号。异步派生回来时必须确认「这仍是当前这条命令的结果」，
  // 否则会把旧 h 的派生值写到新 h 上（脏写）。
  const deriveEpoch = {};

  // 底图级笔刷的 merge 谓词必须带上 baseMapKey —— 否则在两张底图上交替涂抹会被合并成
  // 同一条命令（merge 无 key 判定），撤销时按"最旧那条的 undo"回滚，把另一张底图的
  // 高度图一起改掉。test_39-e 用交叉涂抹复现过这个坑。

  // ============================================================
  // BaseMaps CRUD（全走 execute，undo 支持）
  // ============================================================
  
  function addBaseMap(baseMapKey, baseMap) {
    const newMap = {
      id: baseMapKey,
      name: baseMap.name || baseMapKey,
      terrain: [],
      referenceImages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...baseMap,
    };
    
    execute({
      type: 'add-basemap',
      label: '新建底图',
      undo: () => {
        const { [baseMapKey]: _, ...rest } = baseMaps.value;
        baseMaps.value = rest;
      },
      redo: () => {
        baseMaps.value = { ...baseMaps.value, [baseMapKey]: newMap };
      },
    });
    
    saveScenarios();
  }

  function removeBaseMap(baseMapKey) {
    const oldMap = baseMaps.value[baseMapKey];
    if (!oldMap) return;
    
    const associatedScenarios = Object.fromEntries(
      Object.entries(scenarios.value).filter(([_, s]) => s.ownerKey === baseMapKey)
    );
    
    execute({
      type: 'remove-basemap',
      label: '删除底图',
      undo: () => {
        baseMaps.value = { ...baseMaps.value, [baseMapKey]: oldMap };
        scenarios.value = { ...scenarios.value, ...associatedScenarios };
      },
      redo: () => {
        const { [baseMapKey]: _, ...rest } = baseMaps.value;
        baseMaps.value = rest;
        scenarios.value = Object.fromEntries(
          Object.entries(scenarios.value).filter(([_, s]) => s.ownerKey !== baseMapKey)
        );
      },
    });
    
    saveScenarios();
  }

  function addBaseProvince(baseMapKey, province) {
    const baseMap = baseMaps.value[baseMapKey];
    if (!baseMap) return;
    
    const newProv = {
      id: province.id || `prov_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: province.name || 'New Province',
      type: 'polygon',
      points: province.points || province.d || [],
      biome: province.biome || 'temperate',
      culture: province.culture || '未分类',
      coast: province.coast ?? true,
      ...province,
    };
    
    execute({
      type: 'add-province',
      label: '绘制省份',
      undo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            terrain: baseMaps.value[baseMapKey].terrain.filter(p => p.id !== newProv.id),
          },
        };
      },
      redo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            terrain: [...baseMaps.value[baseMapKey].terrain, newProv],
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    
    saveScenarios();
  }

  function updateBaseProvince(baseMapKey, provinceId, updates) {
    const baseMap = baseMaps.value[baseMapKey];
    if (!baseMap) return;
    
    const oldProv = baseMap.terrain.find(p => p.id === provinceId);
    if (!oldProv) return;
    
    execute({
      type: 'update-province',
      label: '编辑省份',
      undo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            terrain: baseMaps.value[baseMapKey].terrain.map(p =>
              p.id === provinceId ? oldProv : p
            ),
          },
        };
      },
      redo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            terrain: baseMaps.value[baseMapKey].terrain.map(p =>
              p.id === provinceId ? { ...p, ...updates } : p
            ),
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    
    saveScenarios();
  }

  function removeBaseProvince(baseMapKey, provinceId) {
    const baseMap = baseMaps.value[baseMapKey];
    if (!baseMap) return;
    
    const oldProv = baseMap.terrain.find(p => p.id === provinceId);
    if (!oldProv) return;
    
    execute({
      type: 'remove-province',
      label: '删除省份',
      undo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            terrain: [...baseMaps.value[baseMapKey].terrain, oldProv],
          },
        };
      },
      redo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            terrain: baseMaps.value[baseMapKey].terrain.filter(p => p.id !== provinceId),
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    
    saveScenarios();
  }

  function splitBaseProvince(baseMapKey, originalId, poly1, poly2) {
    const baseMap = baseMaps.value[baseMapKey];
    if (!baseMap) return;
    
    const original = baseMap.terrain.find(p => p.id === originalId);
    if (!original) return;
    
    const newProv1 = { ...original, id: poly1.id || `prov_${Date.now()}_a`, name: poly1.name || original.name + ' A', points: poly1.points || poly1.d, area: poly1.area };
    const newProv2 = { ...original, id: poly2.id || `prov_${Date.now()}_b`, name: poly2.name || original.name + ' B', points: poly2.points || poly2.d, area: poly2.area };
    
    execute({
      type: 'split-province',
      label: '拆分省份',
      undo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            terrain: baseMaps.value[baseMapKey].terrain
              .filter(p => p.id !== newProv1.id && p.id !== newProv2.id)
              .concat([original]),
          },
        };
      },
      redo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            terrain: baseMaps.value[baseMapKey].terrain
              .filter(p => p.id !== originalId)
              .concat([newProv1, newProv2]),
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    
    saveScenarios();
  }

  function mergeBaseProvinces(baseMapKey, provinceIds, mergedProvince) {
    const baseMap = baseMaps.value[baseMapKey];
    if (!baseMap) return;
    
    const oldProvinces = baseMap.terrain.filter(p => provinceIds.includes(p.id));
    if (oldProvinces.length === 0) return;
    
    const merged = {
      id: mergedProvince.id || `prov_${Date.now()}`,
      name: mergedProvince.name || 'Merged Province',
      type: 'polygon',
      points: mergedProvince.points || mergedProvince.d || [],
      biome: mergedProvince.biome || 'temperate',
      culture: mergedProvince.culture || '未分类',
      coast: mergedProvince.coast ?? true,
      area: mergedProvince.area || 0,
    };
    
    execute({
      type: 'merge-provinces',
      label: '合并省份',
      undo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            terrain: baseMaps.value[baseMapKey].terrain
              .filter(p => p.id !== merged.id)
              .concat(oldProvinces),
          },
        };
      },
      redo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            terrain: baseMaps.value[baseMapKey].terrain
              .filter(p => !provinceIds.includes(p.id))
              .concat([merged]),
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    
    saveScenarios();
  }

  function addBaseReferenceImage(baseMapKey, refImage) {
    const baseMap = baseMaps.value[baseMapKey];
    if (!baseMap) return;
    
    const newRef = {
      id: refImage.id || `ref_${Date.now()}`,
      name: refImage.name || 'Reference',
      dataUrl: refImage.dataUrl || '',
      opacity: refImage.opacity ?? 0.5,
      locked: refImage.locked ?? false,
      offsetX: refImage.offsetX ?? 0,
      offsetY: refImage.offsetY ?? 0,
      scale: refImage.scale ?? 1,
      rotation: refImage.rotation ?? 0,
      flipH: refImage.flipH ?? false,
      width: refImage.width || 0,
      height: refImage.height || 0,
      ppm: refImage.ppm || 0,
      calibrated: refImage.calibrated ?? false,
    };
    
    execute({
      type: 'add-refimage',
      label: '添加参考图',
      undo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            referenceImages: baseMaps.value[baseMapKey].referenceImages.filter(r => r.id !== newRef.id),
          },
        };
      },
      redo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            referenceImages: [...(baseMaps.value[baseMapKey].referenceImages || []), newRef],
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    
    saveScenarios();
  }

  function updateBaseReferenceImage(baseMapKey, refId, updates) {
    const baseMap = baseMaps.value[baseMapKey];
    if (!baseMap) return;
    
    const oldRef = (baseMap.referenceImages || []).find(r => r.id === refId);
    if (!oldRef) return;
    
    execute({
      type: 'update-refimage',
      label: '编辑参考图',
      undo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            referenceImages: baseMaps.value[baseMapKey].referenceImages.map(r =>
              r.id === refId ? oldRef : r
            ),
          },
        };
      },
      redo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            referenceImages: baseMaps.value[baseMapKey].referenceImages.map(r =>
              r.id === refId ? { ...r, ...updates } : r
            ),
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    
    saveScenarios();
  }

  function removeBaseReferenceImage(baseMapKey, refId) {
    const baseMap = baseMaps.value[baseMapKey];
    if (!baseMap) return;
    
    const oldRef = (baseMap.referenceImages || []).find(r => r.id === refId);
    if (!oldRef) return;
    
    execute({
      type: 'remove-refimage',
      label: '删除参考图',
      undo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            referenceImages: [...(baseMaps.value[baseMapKey].referenceImages || []), oldRef],
          },
        };
      },
      redo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            referenceImages: (baseMaps.value[baseMapKey].referenceImages || []).filter(r => r.id !== refId),
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    
    saveScenarios();
  }

  // ============================================================
  // Scenarios CRUD
  // ============================================================
  
  function createScenario(scenarioId, scenario) {
    const now = new Date().toISOString();
    const newScenario = {
      id: scenarioId,
      ownerKey: scenario.ownerKey,
      name: scenario.name || 'New Scenario',
      era: scenario.era || { roman: '', label: '', startYear: '', endYear: '' },
      order: scenario.order || Object.keys(scenarios.value).length + 1,
      description: scenario.description || '',
      sourceNote: scenario.sourceNote || '',
      polities: scenario.polities || [],
      ownership: scenario.ownership || {},
      labels: scenario.labels || [],
      markers: scenario.markers || [],
      createdAt: now,
      updatedAt: now,
      ...scenario,
    };
    
    execute({
      type: 'create-scenario',
      label: '创建剧本',
      undo: () => {
        const { [scenarioId]: _, ...rest } = scenarios.value;
        scenarios.value = rest;
      },
      redo: () => {
        scenarios.value = { ...scenarios.value, [scenarioId]: newScenario };
      },
    });
    
    saveScenarios();
  }

  function updateScenario(scenarioId, updates) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;
    
    execute({
      type: 'update-scenario',
      label: '编辑剧本',
      undo: () => {
        scenarios.value = { ...scenarios.value, [scenarioId]: scenario };
      },
      redo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: { ...scenario, ...updates, updatedAt: new Date().toISOString() },
        };
      },
    });
    
    saveScenarios();
  }

  function removeScenario(scenarioId) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;
    
    execute({
      type: 'remove-scenario',
      label: '删除剧本',
      undo: () => {
        scenarios.value = { ...scenarios.value, [scenarioId]: scenario };
      },
      redo: () => {
        const { [scenarioId]: _, ...rest } = scenarios.value;
        scenarios.value = rest;
      },
    });
    
    saveScenarios();
  }

  function inheritScenario(newScenarioId, baseScenarioId, overrides = {}) {
    const base = scenarios.value[baseScenarioId];
    const now = new Date().toISOString();
    
    const newScenario = {
      id: newScenarioId,
      ownerKey: base?.ownerKey || overrides.ownerKey,
      name: overrides.name || 'New Era',
      era: overrides.era || { roman: '', label: '', startYear: '', endYear: '' },
      order: (base?.order || 0) + 1,
      description: overrides.description || '',
      sourceNote: overrides.sourceNote || '',
      polities: overrides.polities || base?.polities || [],
      ownership: JSON.parse(JSON.stringify(base?.ownership || {})),
      labels: JSON.parse(JSON.stringify(base?.labels || [])),
      markers: JSON.parse(JSON.stringify(base?.markers || [])),
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
    
    execute({
      type: 'inherit-scenario',
      label: '继承剧本',
      undo: () => {
        const { [newScenarioId]: _, ...rest } = scenarios.value;
        scenarios.value = rest;
      },
      redo: () => {
        scenarios.value = { ...scenarios.value, [newScenarioId]: newScenario };
      },
    });
    
    saveScenarios();
  }

  // ============================================================
  // Ownership（EU4 省份染色）
  // ============================================================
  
  /**
   * 指派势力。可选 changeYear：把「易主年份」一并记为显式值 ——
   * 这是 changeYear 最自然的录入路径：把游标拖到某年再上色 = 该年易主。
   */
  function setOwnership(scenarioId, provinceId, polityId, changeYear) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;

    const oldOwner = scenario.ownership?.[provinceId] || null;
    const oldCY = scenario.changeYears?.[provinceId];
    const hadOldCY = oldCY !== undefined;
    const writeCY = typeof changeYear === 'number' && Number.isFinite(changeYear);

    execute({
      type: 'set-ownership',
      label: writeCY ? '指派势力（含易主年份）' : '指派势力',
      undo: () => {
        const sc = scenarios.value[scenarioId];
        const changeYears = { ...(sc.changeYears || {}) };
        if (hadOldCY) changeYears[provinceId] = oldCY; else delete changeYears[provinceId];
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...sc,
            ownership: { ...sc.ownership, [provinceId]: oldOwner },
            changeYears,
          },
        };
      },
      redo: () => {
        const sc = scenarios.value[scenarioId];
        const changeYears = { ...(sc.changeYears || {}) };
        if (writeCY) changeYears[provinceId] = changeYear;
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...sc,
            ownership: { ...sc.ownership, [provinceId]: polityId },
            changeYears,
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });

    saveScenarios();
  }

  function clearOwnership(scenarioId, provinceId, changeYear) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;

    const oldOwner = scenario.ownership?.[provinceId];
    if (!oldOwner) return;

    const oldCY = scenario.changeYears?.[provinceId];
    const hadOldCY = oldCY !== undefined;
    const writeCY = typeof changeYear === 'number' && Number.isFinite(changeYear);

    execute({
      type: 'clear-ownership',
      label: '清除归属',
      undo: () => {
        const sc = scenarios.value[scenarioId];
        const changeYears = { ...(sc.changeYears || {}) };
        if (hadOldCY) changeYears[provinceId] = oldCY; else delete changeYears[provinceId];
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...sc,
            ownership: { ...sc.ownership, [provinceId]: oldOwner },
            changeYears,
          },
        };
      },
      redo: () => {
        const sc = scenarios.value[scenarioId];
        const { [provinceId]: _, ...rest } = sc.ownership;
        const changeYears = { ...(sc.changeYears || {}) };
        if (writeCY) changeYears[provinceId] = changeYear;
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...sc,
            ownership: rest,
            changeYears,
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });

    saveScenarios();
  }

  function batchSetOwnership(scenarioId, provinceIds, polityId, changeYear) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;

    const oldOwnership = { ...scenario.ownership };
    const oldChangeYears = { ...(scenario.changeYears || {}) };
    const newOwnership = { ...scenario.ownership };
    provinceIds.forEach(id => { newOwnership[id] = polityId; });
    const writeCY = typeof changeYear === 'number' && Number.isFinite(changeYear);
    const newChangeYears = { ...oldChangeYears };
    if (writeCY) provinceIds.forEach(id => { newChangeYears[id] = changeYear; });

    execute({
      type: 'batch-ownership',
      label: '批量指派',
      undo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: { ...scenarios.value[scenarioId], ownership: oldOwnership, changeYears: oldChangeYears },
        };
      },
      redo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...scenarios.value[scenarioId],
            ownership: newOwnership,
            changeYears: newChangeYears,
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });

    saveScenarios();
  }

  // ============================================================
  // 势力谱系（P2：时间轴的人工纠正入口）
  // ============================================================

  /**
   * 设置势力的谱系信息（走 undo）。
   * successorOf: 承自某**前代势力**的 polity id（语义最自然，推荐）
   * lineage:     显式谱系标签（同名即同谱系）
   * 传空字符串 / null 表示清除该项。
   */
  function setPolityLineage(scenarioId, polityId, { successorOf, lineage } = {}) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;
    const idx = (scenario.polities || []).findIndex(p => p.id === polityId);
    if (idx < 0) return;

    const oldPolities = JSON.parse(JSON.stringify(scenario.polities));
    const next = scenario.polities.map(p => {
      if (p.id !== polityId) return p;
      const np = { ...p };
      if (successorOf !== undefined) {
        if (successorOf) np.successorOf = successorOf; else delete np.successorOf;
      }
      if (lineage !== undefined) {
        if (lineage) np.lineage = lineage; else delete np.lineage;
      }
      return np;
    });

    execute({
      type: 'set-polity-lineage',
      label: '设置势力谱系',
      undo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: { ...scenarios.value[scenarioId], polities: oldPolities },
        };
      },
      redo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: { ...scenarios.value[scenarioId], polities: next, updatedAt: new Date().toISOString() },
        };
      },
    });

    saveScenarios();
  }

  /** 显式设置/清除某省的易主年份（走 undo）。year=null 表示删除显式值（回到自动推算） */
  function setProvinceChangeYear(scenarioId, provinceId, year) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;

    const oldCY = scenario.changeYears?.[provinceId];
    const hadOldCY = oldCY !== undefined;
    const write = typeof year === 'number' && Number.isFinite(year);

    execute({
      type: 'set-change-year',
      label: '设置易主年份',
      undo: () => {
        const sc = scenarios.value[scenarioId];
        const changeYears = { ...(sc.changeYears || {}) };
        if (hadOldCY) changeYears[provinceId] = oldCY; else delete changeYears[provinceId];
        scenarios.value = { ...scenarios.value, [scenarioId]: { ...sc, changeYears } };
      },
      redo: () => {
        const sc = scenarios.value[scenarioId];
        const changeYears = { ...(sc.changeYears || {}) };
        if (write) changeYears[provinceId] = year; else delete changeYears[provinceId];
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: { ...sc, changeYears, updatedAt: new Date().toISOString() },
        };
      },
    });

    saveScenarios();
  }

  // ============================================================
  // 导出 / 导入（P0）
  // ============================================================

  /**
   * 导出为 .sitian/scenarios.json 同构的载荷。
   * ownerKey 为空则导出全部底图与剧本。
   */
  function exportScenariosPayload(ownerKey = null) {
    if (!ownerKey) {
      return {
        version: 1,
        baseMaps: JSON.parse(JSON.stringify(baseMaps.value || {})),
        scenarios: JSON.parse(JSON.stringify(scenarios.value || {})),
        updatedAt: new Date().toISOString(),
      };
    }
    const bm = {};
    if (baseMaps.value?.[ownerKey]) bm[ownerKey] = JSON.parse(JSON.stringify(baseMaps.value[ownerKey]));
    const sc = {};
    for (const [k, v] of Object.entries(scenarios.value || {})) {
      if (v?.ownerKey === ownerKey || String(k).startsWith(ownerKey + '/')) {
        sc[k] = JSON.parse(JSON.stringify(v));
      }
    }
    return { version: 1, baseMaps: bm, scenarios: sc, updatedAt: new Date().toISOString() };
  }

  /** 导出前体检：返回给人看的警告清单 */
  function auditScenariosPayload(payload) {
    const warns = [];
    const scen = payload?.scenarios || {};
    const maps = payload?.baseMaps || {};
    const keys = Object.keys(scen);
    if (!keys.length) warns.push('没有任何剧本');
    if (!Object.keys(maps).length) warns.push('没有任何底图（剧本将没有省份可渲染）');
    for (const [k, s] of Object.entries(scen)) {
      const owner = s?.ownerKey;
      if (!owner) { warns.push(`剧本「${s?.name || k}」缺 ownerKey`); continue; }
      if (!maps[owner]) warns.push(`剧本「${s?.name || k}」指向的底图「${owner}」不在导出范围内`);
      if (!Array.isArray(s?.polities) || !s.polities.length) warns.push(`剧本「${s?.name || k}」没有势力`);
      const own = Object.keys(s?.ownership || {}).length;
      if (!own) warns.push(`剧本「${s?.name || k}」没有省份归属`);
      if (s?.era?.startYear === undefined || s?.era?.startYear === '') warns.push(`剧本「${s?.name || k}」缺起始年份`);
    }
    return warns;
  }

  /**
   * 导入 scenarios.json 载荷。
   * mode='merge'（默认）按 key 合并；mode='replace' 整体替换 baseMaps/scenarios。
   * 整个导入是**一条 undo**（快照 + 整体替换，见铁律 #108）。
   */
  function importScenariosPayload(data, { mode = 'merge' } = {}) {
    if (!data || typeof data !== 'object') return { success: false, error: '不是合法的 JSON 对象' };
    const inMaps = data.baseMaps && typeof data.baseMaps === 'object' ? data.baseMaps : null;
    const inScen = data.scenarios && typeof data.scenarios === 'object' ? data.scenarios : null;
    if (!inMaps && !inScen) return { success: false, error: '缺少 baseMaps / scenarios 字段' };

    const snapMaps = JSON.parse(JSON.stringify(baseMaps.value || {}));
    const snapScen = JSON.parse(JSON.stringify(scenarios.value || {}));
    const nextMaps = mode === 'replace'
      ? JSON.parse(JSON.stringify(inMaps || {}))
      : { ...snapMaps, ...JSON.parse(JSON.stringify(inMaps || {})) };
    const nextScen = mode === 'replace'
      ? JSON.parse(JSON.stringify(inScen || {}))
      : { ...snapScen, ...JSON.parse(JSON.stringify(inScen || {})) };

    const addedMaps = Object.keys(nextMaps).filter(k => !snapMaps[k]).length;
    const addedScen = Object.keys(nextScen).filter(k => !snapScen[k]).length;

    execute({
      type: 'import-scenarios',
      label: mode === 'replace' ? '导入剧本（替换）' : '导入剧本（合并）',
      undo: () => {
        baseMaps.value = snapMaps;
        scenarios.value = snapScen;
      },
      redo: () => {
        baseMaps.value = nextMaps;
        scenarios.value = nextScen;
      },
    });

    saveScenarios();
    return {
      success: true,
      mode,
      baseMaps: Object.keys(nextMaps).length,
      scenarios: Object.keys(nextScen).length,
      addedMaps,
      addedScenarios: addedScen,
    };
  }

  /** 清空全部剧本（保留底图）—— 替换式导入前的显式动作 */
  function removeAllScenarios() {
    const snap = JSON.parse(JSON.stringify(scenarios.value || {}));
    execute({
      type: 'remove-all-scenarios',
      label: '清空剧本',
      undo: () => { scenarios.value = snap; },
      redo: () => { scenarios.value = {}; },
    });
    saveScenarios();
  }

  // ============================================================
  // Labels & Markers
  // ============================================================
  
  function addScenarioLabel(scenarioId, label) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;
    
    const newLabel = {
      id: label.id || `label_${Date.now()}`,
      x: label.x,
      y: label.y,
      text: label.text || '',
      size: label.size || 12,
      color: label.color || '#3c4150',
    };
    
    execute({
      type: 'add-label',
      label: '添加地名',
      undo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...scenarios.value[scenarioId],
            labels: scenarios.value[scenarioId].labels.filter(l => l.id !== newLabel.id),
          },
        };
      },
      redo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...scenarios.value[scenarioId],
            labels: [...(scenarios.value[scenarioId].labels || []), newLabel],
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    
    saveScenarios();
  }

  function removeScenarioLabel(scenarioId, labelId) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;
    
    const oldLabel = (scenario.labels || []).find(l => l.id === labelId);
    if (!oldLabel) return;
    
    execute({
      type: 'remove-label',
      label: '删除地名',
      undo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...scenarios.value[scenarioId],
            labels: [...(scenarios.value[scenarioId].labels || []), oldLabel],
          },
        };
      },
      redo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...scenarios.value[scenarioId],
            labels: (scenarios.value[scenarioId].labels || []).filter(l => l.id !== labelId),
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    
    saveScenarios();
  }

  function addScenarioMarker(scenarioId, marker) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;
    
    const newMarker = {
      id: marker.id || `marker_${Date.now()}`,
      x: marker.x,
      y: marker.y,
      name: marker.name || '',
      type: marker.type || 'default',
    };
    
    execute({
      type: 'add-marker',
      label: '添加标记',
      undo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...scenarios.value[scenarioId],
            markers: scenarios.value[scenarioId].markers.filter(m => m.id !== newMarker.id),
          },
        };
      },
      redo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...scenarios.value[scenarioId],
            markers: [...(scenarios.value[scenarioId].markers || []), newMarker],
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    
    saveScenarios();
  }

  function removeScenarioMarker(scenarioId, markerId) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;
    
    const oldMarker = (scenario.markers || []).find(m => m.id === markerId);
    if (!oldMarker) return;
    
    execute({
      type: 'remove-marker',
      label: '删除标记',
      undo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...scenarios.value[scenarioId],
            markers: [...(scenarios.value[scenarioId].markers || []), oldMarker],
          },
        };
      },
      redo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...scenarios.value[scenarioId],
            markers: (scenarios.value[scenarioId].markers || []).filter(m => m.id !== markerId),
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    
    saveScenarios();
  }

  // ============================================================
  // Import/Load
  // ============================================================
  
  function importFromScenariosJson(data) {
    if (data.baseMaps) {
      baseMaps.value = { ...baseMaps.value, ...data.baseMaps };
    }
    if (data.scenarios) {
      scenarios.value = { ...scenarios.value, ...data.scenarios };
    }
    saveScenarios();
  }

  /**
   * 将 Azgaar .map 中的政治/文化/宗教数据同步到指定行星的 mapData
   * 供 PlanetMap 渲染参考图层使用
   */
  function importPlanetLayerData(planetId, data) {
    if (!planetId || !data) return;
    const map = mapData.value?.[planetId];
    if (!map) return;

    // 补充省份多边形（按政治实体/文化/宗教分组）
    if (data.provinces && Array.isArray(data.provinces)) {
      map.azgaarProvinces = data.provinces.map(p => ({
        id: p.id,
        name: p.name || '',
        points: p.points || [],
        stateId: p.stateId || 0,
        cultureId: p.cultureId || 0,
        religionId: p.religionId || 0,
        color: p.color || p.stateColor || p.cultureColor || '#888888',
      }));
    }

    // 补充政治实体数据
    if (data.states && Array.isArray(data.states)) {
      map.azgaarStates = data.states.map(s => ({
        id: s.id || s.i,
        name: s.name || ('State ' + (s.id || s.i)),
        color: s.color || '#888888',
      }));
    }

    // 补充文化数据
    if (data.cultures && Array.isArray(data.cultures)) {
      map.azgaarCultures = data.cultures.map(c => ({
        id: c.id || c.i,
        name: c.name || ('Culture ' + (c.id || c.i)),
        color: c.color || '#888888',
      }));
    }

    // 补充宗教数据
    if (data.religions && Array.isArray(data.religions)) {
      map.azgaarReligions = data.religions.map(r => ({
        id: r.id || r.i,
        name: r.name || ('Religion ' + (r.id || r.i)),
        color: r.color || '#888888',
      }));
    }

    // 触发响应式更新
    mapData.value = { ...mapData.value, [planetId]: { ...map } };
    scheduleAutoSaveMap(planetId);
  }

  function loadScenarioState(data) {
    if (data.baseMaps) baseMaps.value = data.baseMaps;
    if (data.scenarios) scenarios.value = data.scenarios;
  }

  // ============================================================
  // Height Map Brush (v2 data-driven editing)
  // ============================================================

  function applyHeightBrush(baseMapKey, cx, cy, radius, strength, mode) {
    const baseMap = baseMaps.value[baseMapKey];
    if (!baseMap?.heightmap?.grid?.points) return;

    const hm = baseMap.heightmap;
    const grid = hm.grid;
    const pts = grid.points;
    const spacing = grid.spacing || 14.4;
    const newH = new Float32Array(hm.h);

    // 性能优化：空间索引（构建一次，复用多次）
    if (!hm._spatialIndex) {
      const cellSize = spacing * 2;
      let minX = Infinity, minY = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
        const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
        if (px < minX) minX = px;
        if (py < minY) minY = py;
      }
      const cellMap = new Map();
      for (let i = 0; i < pts.length; i++) {
        const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
        const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
        const cxi = Math.floor((px - minX) / cellSize);
        const cyi = Math.floor((py - minY) / cellSize);
        const key = `${cxi},${cyi}`;
        if (!cellMap.has(key)) cellMap.set(key, []);
        cellMap.get(key).push(i);
      }
      hm._spatialIndex = { cellSize, minX, minY, cellMap };
    }

    const idx = hm._spatialIndex;
    const minCx = Math.floor((cx - radius - idx.minX) / idx.cellSize);
    const maxCx = Math.floor((cx + radius - idx.minX) / idx.cellSize);
    const minCy = Math.floor((cy - radius - idx.minY) / idx.cellSize);
    const maxCy = Math.floor((cy + radius - idx.minY) / idx.cellSize);

    for (let ci = minCx; ci <= maxCx; ci++) {
      for (let cj = minCy; cj <= maxCy; cj++) {
        const cell = idx.cellMap.get(`${ci},${cj}`);
        if (!cell) continue;
        for (const i of cell) {
          const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
          const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
          const dx = px - cx;
          const dy = py - cy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist >= radius) continue;

          const falloff = brushFalloff(radius, dist);
          const delta = strength * falloff;

          if (mode === 'raise') {
            newH[i] = Math.min(100, newH[i] + delta);
          } else if (mode === 'lower') {
            newH[i] = Math.max(0, newH[i] - delta);
          } else if (mode === 'smooth') {
            let sum = 0, count = 0;
            for (let j = 0; j < pts.length; j++) {
              const qx = Array.isArray(pts[j]) ? pts[j][0] : pts[j].x;
              const qy = Array.isArray(pts[j]) ? pts[j][1] : pts[j].y;
              const ddx = qx - px, ddy = qy - py;
              if (Math.abs(ddx) < spacing * 1.5 && Math.abs(ddy) < spacing * 1.5) {
                sum += hm.h[j];
                count++;
              }
            }
            newH[i] = count > 0 ? sum / count : newH[i];
          }
        }
      }
    }

    // 重新派生温度/降水/生物群系
    // P2-4：小网格同步（一次 postMessage 往返的开销 ≥ 计算量本身），大网格把派生挪到 Worker。
    // 大网格时本帧先复用「上一条命令的派生数组」（派生是 h 的纯函数，短时陈旧无害），
    // 真值由 redo 里的 scheduleDerive 在 300ms 防抖后回写，主线程不再被 O(n) 循环占住。
    const canDefer = newH.length > getAsyncThreshold()
      && isWorkerAvailable()
      && !!(hm.temp && hm.prec && hm.biome)
      && hm.temp.length === newH.length
      && hm.prec.length === newH.length
      && hm.biome.length === newH.length;
    const derived = canDefer
      ? { temperature: hm.temp, precipitation: hm.prec, biome: hm.biome }
      : deriveLayers(newH, pts, null, null);
    const oldH = new Float32Array(hm.h);
    const oldTemp = hm.temp ? new Float32Array(hm.temp) : null;
    const oldPrec = hm.prec ? new Float32Array(hm.prec) : null;
    const oldBiome = hm.biome ? new Uint8Array(hm.biome) : null;

    const cmd = {
      type: 'height-brush',
      baseMapKey,
      mode,
      label: mode === 'raise' ? '抬高地形' : mode === 'lower' ? '降低地形' : '平滑地形',
      merge: (prev) => prev.type === 'height-brush' && prev.mode === mode && prev.baseMapKey === baseMapKey,
      undo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            heightmap: { ...hm, h: oldH, temp: oldTemp, prec: oldPrec, biome: oldBiome },
          },
        };
      },
      redo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            heightmap: {
              ...hm,
              h: new Float32Array(newH),
              temp: derived.temperature,
              prec: derived.precipitation,
              biome: derived.biome,
            },
            updatedAt: new Date().toISOString(),
          },
        };
        // P2-4：异步派生挂在 redo 内 —— execute() 首帧与后续 redo 都会走到，
        // 所以「撤销后再重做」同样能拿回正确派生值（否则重做会留下陈旧图层）。
        if (canDefer) {
          const epoch = (deriveEpoch[baseMapKey] = (deriveEpoch[baseMapKey] || 0) + 1);
          scheduleDerive(newH, (res) => {
            if (!res || deriveEpoch[baseMapKey] !== epoch) return; // 已被更新的命令取代
            const cur = baseMaps.value[baseMapKey] && baseMaps.value[baseMapKey].heightmap;
            if (!cur || !cur.h || cur.h.length !== res.n) return;
            // 派生数组直接回写（不进 undo 栈：它是 h 的纯函数、可随时重算；
            // undo/redo 闭包里各自持有自己那一代的值，回写只影响"当前"这一代）
            cur.temp = res.temperature;
            cur.prec = res.precipitation;
            cur.biome = res.biome;
            scheduleAutoSaveScenarios();
          });
        }
      },
    };
    execute(cmd);

    scheduleAutoSaveScenarios();
  }

  // 生物群系 key → Uint8 编码
  const BIOME_KEY_INDEX = {
    ocean: 0, hot_desert: 1, cold_desert: 2, savanna: 3, grassland: 4,
    tropical_seasonal: 5, temperate_deciduous: 6, tropical_rainforest: 7,
    temperate_rainforest: 8, taiga: 9, tundra: 10, glacier: 11, wetland: 12,
  };

  function applyBiomeBrush(baseMapKey, cx, cy, radius, biomeKey) {
    const baseMap = baseMaps.value[baseMapKey];
    if (!baseMap?.heightmap?.grid?.points) return;

    const hm = baseMap.heightmap;
    const pts = hm.grid.points;
    const oldBiome = hm.biome ? new Uint8Array(hm.biome) : new Uint8Array(pts.length);
    const newBiome = new Uint8Array(oldBiome);
    const idx = BIOME_KEY_INDEX[biomeKey] ?? 0;

    for (let i = 0; i < pts.length; i++) {
      const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
      const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
      const dist = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
      if (dist >= radius) continue;
      const falloff = brushFalloff(radius, dist);
      if (falloff < 0.1) continue;
      newBiome[i] = idx;
    }

    const cmd = {
      type: 'biome-brush',
      baseMapKey,
      biomeKey,
      label: '生物群系笔刷',
      merge: (prev) => prev.type === 'biome-brush' && prev.biomeKey === biomeKey && prev.baseMapKey === baseMapKey,
      undo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            heightmap: { ...hm, biome: oldBiome },
          },
        };
      },
      redo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            heightmap: { ...hm, biome: new Uint8Array(newBiome) },
            updatedAt: new Date().toISOString(),
          },
        };
      },
    };
    execute(cmd);

    saveScenarios();
  }



  // ============================================================
  // Getters
  // ============================================================
  
  function getBaseMap(baseMapKey) { return baseMaps.value[baseMapKey]; }
  function getScenario(scenarioId) { return scenarios.value[scenarioId]; }
  function getScenariosByOwner(ownerKey) { return Object.values(scenarios.value).filter(s => s.ownerKey === ownerKey); }
  function getBaseMapsList() { return Object.values(baseMaps.value); }
  function getAllScenarios() { return Object.values(scenarios.value); }

  // ── 高度查询：取最近网格点 ──
  function addBaseMapBurg(baseMapKey, burg) {
  const baseMap = baseMaps.value[baseMapKey];
  if (!baseMap) return;

  execute({
    type: 'add-burg',
    label: '放置聚落',
    undo: () => {
      baseMaps.value = {
        ...baseMaps.value,
        [baseMapKey]: {
          ...baseMap,
          burgs: (baseMap.burgs || []).filter(b => b.id !== burg.id),
        },
      };
    },
    redo: () => {
      baseMaps.value = {
        ...baseMaps.value,
        [baseMapKey]: {
          ...baseMap,
          burgs: [...(baseMap.burgs || []), burg],
          updatedAt: new Date().toISOString(),
        },
      };
    },
  });
  saveScenarios();
}

function applyCultureBrush(baseMapKey, cx, cy, radius, cultureKey) {
  const baseMap = baseMaps.value[baseMapKey];
  if (!baseMap?.heightmap?.grid?.points) return;

  const hm = baseMap.heightmap;
  const pts = hm.grid.points;
  const oldCultures = hm.culture ? new Uint8Array(hm.culture) : new Uint8Array(pts.length);
  const newCultures = new Uint8Array(oldCultures);
  const idx = parseInt(cultureKey, 10) || 0;

  for (let i = 0; i < pts.length; i++) {
    const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
    const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
    const dist = Math.hypot(px - cx, py - cy);
    if (dist >= radius) continue;
    const falloff = brushFalloff(radius, dist);
    if (falloff < 0.1) continue;
    newCultures[i] = idx;
  }

  execute({
    type: 'culture-brush',
    baseMapKey,
    cultureKey,
    label: '文化笔刷',
    merge: (prev) => prev.type === 'culture-brush' && prev.cultureKey === cultureKey && prev.baseMapKey === baseMapKey,
    undo: () => {
      baseMaps.value = {
        ...baseMaps.value,
        [baseMapKey]: {
          ...baseMap,
          heightmap: { ...hm, culture: oldCultures },
        },
      };
    },
    redo: () => {
      baseMaps.value = {
        ...baseMaps.value,
        [baseMapKey]: {
          ...baseMap,
          heightmap: { ...hm, culture: new Uint8Array(newCultures) },
          updatedAt: new Date().toISOString(),
        },
      };
    },
  });
  saveScenarios();
}

function applyReligionBrush(baseMapKey, cx, cy, radius, religionKey) {
  const baseMap = baseMaps.value[baseMapKey];
  if (!baseMap?.heightmap?.grid?.points) return;

  const hm = baseMap.heightmap;
  const pts = hm.grid.points;
  const oldReligions = hm.religion ? new Uint8Array(hm.religion) : new Uint8Array(pts.length);
  const newReligions = new Uint8Array(oldReligions);
  const idx = parseInt(religionKey, 10) || 0;

  for (let i = 0; i < pts.length; i++) {
    const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
    const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
    const dist = Math.hypot(px - cx, py - cy);
    if (dist >= radius) continue;
    const falloff = brushFalloff(radius, dist);
    if (falloff < 0.1) continue;
    newReligions[i] = idx;
  }

  execute({
    type: 'religion-brush',
    baseMapKey,
    religionKey,
    label: '宗教笔刷',
    merge: (prev) => prev.type === 'religion-brush' && prev.religionKey === religionKey && prev.baseMapKey === baseMapKey,
    undo: () => {
      baseMaps.value = {
        ...baseMaps.value,
        [baseMapKey]: {
          ...baseMap,
          heightmap: { ...hm, religion: oldReligions },
        },
      };
    },
    redo: () => {
      baseMaps.value = {
        ...baseMaps.value,
        [baseMapKey]: {
          ...baseMap,
          heightmap: { ...hm, religion: new Uint8Array(newReligions) },
          updatedAt: new Date().toISOString(),
        },
      };
    },
  });
  saveScenarios();
}

  function getHeightAt(baseMapKey, worldX, worldY) {
    const baseMap = baseMaps.value[baseMapKey];
    const spacing = baseMap.heightmap.grid.spacing || 14.4;
    const h = baseMap.heightmap.h;
    let bestI = -1;
    let bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
      const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
      const d = Math.hypot(px - worldX, py - worldY);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    if (bestI < 0 || bestD > spacing) return null;
    return {
      h: h[bestI],
      temp: baseMap.heightmap.temp?.[bestI],
      prec: baseMap.heightmap.prec?.[bestI],
      biome: baseMap.heightmap.biome?.[bestI],
    };
  }

  // ============================================================
  // River Generation (v2)
  // ============================================================

  function generateRivers(baseMapKey) {
    const baseMap = baseMaps.value[baseMapKey];
    if (!baseMap?.heightmap?.grid?.points) return [];
    const hm = baseMap.heightmap;
    const pts = hm.grid.points;
    const n = pts.length;
    const rivers = [];
    const visited = new Set();

    const sources = [];
    for (let i = 0; i < n; i++) {
      if (hm.h[i] > 60) sources.push(i);
    }

    for (const src of sources) {
      if (visited.has(src)) continue;
      const river = [src];
      let current = src;
      let steps = 0;
      while (hm.h[current] >= SEA_LEVEL && steps < 200) {
        visited.add(current);
        const cx = Array.isArray(pts[current]) ? pts[current][0] : pts[current].x;
        const cy = Array.isArray(pts[current]) ? pts[current][1] : pts[current].y;
        let lowest = -1, lowestH = hm.h[current];
        for (let j = 0; j < n; j++) {
          if (j === current) continue;
          const qx = Array.isArray(pts[j]) ? pts[j][0] : pts[j].x;
          const qy = Array.isArray(pts[j]) ? pts[j][1] : pts[j].y;
          const d = Math.hypot(qx - cx, qy - cy);
          if (d < (hm.grid.spacing || 14.4) * 1.5 && hm.h[j] < lowestH) {
            lowestH = hm.h[j];
            lowest = j;
          }
        }
        if (lowest < 0) break;
        river.push(lowest);
        current = lowest;
        steps++;
      }
      if (river.length > 3) rivers.push(river.map(i => ({ x: pts[i][0], y: pts[i][1] })));
    }

    return rivers;
  }

  function deriveAllLayers(baseMapKey) {
    const baseMap = baseMaps.value[baseMapKey];
    if (!baseMap?.heightmap?.grid?.points) return null;
    const hm = baseMap.heightmap;
    const pts = hm.grid.points;
    const oldTemp = hm.temp ? new Float32Array(hm.temp) : null;
    const oldPrec = hm.prec ? new Float32Array(hm.prec) : null;
    const oldBiome = hm.biome ? new Uint8Array(hm.biome) : null;
    const derived = deriveLayers(hm.h, pts, null, null);

    execute({
      type: 'derive-layers',
      label: '重算派生图层',
      undo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            heightmap: { ...hm, temp: oldTemp, prec: oldPrec, biome: oldBiome },
          },
        };
      },
      redo: () => {
        baseMaps.value = {
          ...baseMaps.value,
          [baseMapKey]: {
            ...baseMaps.value[baseMapKey],
            heightmap: { ...hm, temp: derived.temperature, prec: derived.precipitation, biome: derived.biome },
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    saveScenarios();
    return derived;
  }

  return {
    baseMaps, scenarios,
    addBaseMap, removeBaseMap, addBaseProvince, updateBaseProvince, removeBaseProvince,
    splitBaseProvince, mergeBaseProvinces,
    addBaseReferenceImage, updateBaseReferenceImage, removeBaseReferenceImage,
    createScenario, updateScenario, removeScenario, inheritScenario,
    setOwnership, clearOwnership, batchSetOwnership,
    setPolityLineage, setProvinceChangeYear,
    exportScenariosPayload, auditScenariosPayload, importScenariosPayload, removeAllScenarios,
    addScenarioLabel, removeScenarioLabel, addScenarioMarker, removeScenarioMarker,
    importFromScenariosJson, importPlanetLayerData, loadScenarioState,
    applyHeightBrush, applyBiomeBrush, getHeightAt, generateRivers, deriveAllLayers,
    getDeriveStats,
    addBaseMapBurg, applyCultureBrush, applyReligionBrush,
    getBaseMap, getScenario, getScenariosByOwner, getBaseMapsList, getAllScenarios,
  };
}
