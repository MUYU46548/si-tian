// store/geodataModules/scenarioEditing.js — 剧本地图 store 模块
// ctx: { execute, scheduleAutoSave, saveScenarios }
// 所有 mutation 走 execute（redo 内写入，防双写铁律）
import { ref } from 'vue';
import {
  temperatureAtIndex, precipitationAtIndex, classifyBiome, biomeColor,
  brushFalloff, deriveLayers, smoothHeightmap, SEA_LEVEL,
} from '../../utils/heightMath';

export function createScenarioEditingModule(ctx) {
  const { execute, scheduleAutoSave, saveScenarios } = ctx;

  const baseMaps = ref({});
  const scenarios = ref({});

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
  
  function setOwnership(scenarioId, provinceId, polityId) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;
    
    const oldOwner = scenario.ownership?.[provinceId] || null;
    
    execute({
      type: 'set-ownership',
      label: '指派势力',
      undo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...scenarios.value[scenarioId],
            ownership: { ...scenarios.value[scenarioId].ownership, [provinceId]: oldOwner },
          },
        };
      },
      redo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...scenarios.value[scenarioId],
            ownership: { ...scenarios.value[scenarioId].ownership, [provinceId]: polityId },
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    
    saveScenarios();
  }

  function clearOwnership(scenarioId, provinceId) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;
    
    const oldOwner = scenario.ownership?.[provinceId];
    if (!oldOwner) return;
    
    execute({
      type: 'clear-ownership',
      label: '清除归属',
      undo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...scenarios.value[scenarioId],
            ownership: { ...scenarios.value[scenarioId].ownership, [provinceId]: oldOwner },
          },
        };
      },
      redo: () => {
        const { [provinceId]: _, ...rest } = scenarios.value[scenarioId].ownership;
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...scenarios.value[scenarioId],
            ownership: rest,
            updatedAt: new Date().toISOString(),
          },
        };
      },
    });
    
    saveScenarios();
  }

  function batchSetOwnership(scenarioId, provinceIds, polityId) {
    const scenario = scenarios.value[scenarioId];
    if (!scenario) return;
    
    const oldOwnership = { ...scenario.ownership };
    const newOwnership = { ...scenario.ownership };
    provinceIds.forEach(id => { newOwnership[id] = polityId; });
    
    execute({
      type: 'batch-ownership',
      label: '批量指派',
      undo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: { ...scenarios.value[scenarioId], ownership: oldOwnership },
        };
      },
      redo: () => {
        scenarios.value = {
          ...scenarios.value,
          [scenarioId]: {
            ...scenarios.value[scenarioId],
            ownership: newOwnership,
            updatedAt: new Date().toISOString(),
          },
        };
      },
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

    for (let i = 0; i < pts.length; i++) {
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

    // 重新派生温度/降水/生物群系
    const derived = deriveLayers(newH, pts, null, null);
    const oldH = new Float32Array(hm.h);
    const oldTemp = hm.temp ? new Float32Array(hm.temp) : null;
    const oldPrec = hm.prec ? new Float32Array(hm.prec) : null;
    const oldBiome = hm.biome ? new Uint8Array(hm.biome) : null;

    execute({
      type: 'height-brush',
      label: mode === 'raise' ? '抬高地形' : mode === 'lower' ? '降低地形' : '平滑地形',
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
      },
    });

    saveScenarios();
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

    execute({
      type: 'biome-brush',
      label: '生物群系笔刷',
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
    });

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
  function getHeightAt(baseMapKey, worldX, worldY) {
    const baseMap = baseMaps.value[baseMapKey];
    if (!baseMap?.heightmap?.grid?.points) return null;
    const pts = baseMap.heightmap.grid.points;
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

  return {
    baseMaps, scenarios,
    addBaseMap, removeBaseMap, addBaseProvince, updateBaseProvince, removeBaseProvince,
    splitBaseProvince, mergeBaseProvinces,
    addBaseReferenceImage, updateBaseReferenceImage, removeBaseReferenceImage,
    createScenario, updateScenario, removeScenario, inheritScenario,
    setOwnership, clearOwnership, batchSetOwnership,
    addScenarioLabel, removeScenarioLabel, addScenarioMarker, removeScenarioMarker,
    importFromScenariosJson, loadScenarioState,
    applyHeightBrush, applyBiomeBrush, getHeightAt,
    getBaseMap, getScenario, getScenariosByOwner, getBaseMapsList, getAllScenarios,
  };
}
