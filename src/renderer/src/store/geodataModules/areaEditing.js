// store/geodataModules/areaEditing.js — 区域地图编辑数据（区域多边形/道路/标记/文本）
// ctx: { execute, scheduleAutoSave }
import { ref } from 'vue';

export function createAreaEditingModule(ctx) {
  const { execute, scheduleAutoSave } = ctx;

  // ===== 区域地图数据（区域多边形） =====
  const areaZones = ref({});

  // ===== 区域地图编辑数据（道路、标记、文本） =====
  const areaRoutes = ref({});
  const areaMarkers = ref({});
  const areaTextLabels = ref({});

  function addAreaZone(areaId, zone) {
    execute({
      type: 'add-area-zone',
      label: '绘制区域',
      undo: () => {
        areaZones.value[areaId] = areaZones.value[areaId].filter(z => z.id !== zone.id);
      },
      redo: () => {
        if (!areaZones.value[areaId]) areaZones.value[areaId] = [];
        areaZones.value[areaId].push(zone);
      },
    });
    scheduleAutoSave();
  }

  function removeAreaZone(areaId, zoneId) {
    if (!areaZones.value[areaId]) return;
    const idx = areaZones.value[areaId].findIndex(z => z.id === zoneId);
    if (idx === -1) return;
    const removed = areaZones.value[areaId][idx];
    execute({
      type: 'remove-area-zone',
      label: '删除区域',
      undo: () => { areaZones.value[areaId].splice(idx, 0, removed); },
      redo: () => { areaZones.value[areaId] = areaZones.value[areaId].filter(z => z.id !== zoneId); },
    });
    scheduleAutoSave();
  }

  function updateAreaZone(areaId, zoneId, updates, oldSnapshot = null) {
    if (!areaZones.value[areaId]) return;
    const zone = areaZones.value[areaId].find(z => z.id === zoneId);
    if (!zone) return;
    const oldState = {};
    if (oldSnapshot) {
      Object.assign(oldState, oldSnapshot);
    } else {
      for (const key of Object.keys(updates)) {
        oldState[key] = Array.isArray(zone[key]) ? zone[key].map(p => ({...p})) : zone[key];
      }
    }
    execute({
      type: 'update-area-zone',
      label: '编辑区域',
      undo: () => { Object.assign(zone, oldState); },
      redo: () => { Object.assign(zone, updates); },
    });
    scheduleAutoSave();
  }

  // ===== 区域地图道路管理 =====
  function addAreaRoute(areaId, route) {
    execute({
      type: 'add-area-route',
      label: '绘制道路',
      undo: () => { areaRoutes.value[areaId] = areaRoutes.value[areaId].filter(r => r.id !== route.id); },
      redo: () => {
        if (!areaRoutes.value[areaId]) areaRoutes.value[areaId] = [];
        areaRoutes.value[areaId].push(route);
      },
    });
    scheduleAutoSave();
  }

  function removeAreaRoute(areaId, routeId) {
    if (!areaRoutes.value[areaId]) return;
    const idx = areaRoutes.value[areaId].findIndex(r => r.id === routeId);
    if (idx === -1) return;
    const removed = areaRoutes.value[areaId][idx];
    execute({
      type: 'remove-area-route',
      label: '删除道路',
      undo: () => { areaRoutes.value[areaId].splice(idx, 0, removed); },
      redo: () => { areaRoutes.value[areaId] = areaRoutes.value[areaId].filter(r => r.id !== routeId); },
    });
    scheduleAutoSave();
  }

  function updateAreaRoute(areaId, routeId, updates) {
    if (!areaRoutes.value[areaId]) return;
    const route = areaRoutes.value[areaId].find(r => r.id === routeId);
    if (!route) return;
    const oldState = { ...route };
    execute({
      type: 'update-area-route',
      label: '编辑道路',
      undo: () => { Object.assign(route, oldState); },
      redo: () => { Object.assign(route, updates); },
    });
    scheduleAutoSave();
  }

  // ===== 区域地图标记管理 =====
  function addAreaMarker(areaId, marker) {
    execute({
      type: 'add-area-marker',
      label: '放置标记',
      undo: () => { areaMarkers.value[areaId] = areaMarkers.value[areaId].filter(m => m.id !== marker.id); },
      redo: () => {
        if (!areaMarkers.value[areaId]) areaMarkers.value[areaId] = [];
        areaMarkers.value[areaId].push(marker);
      },
    });
    scheduleAutoSave();
  }

  function removeAreaMarker(areaId, markerId) {
    if (!areaMarkers.value[areaId]) return;
    const idx = areaMarkers.value[areaId].findIndex(m => m.id === markerId);
    if (idx === -1) return;
    const removed = areaMarkers.value[areaId][idx];
    execute({
      type: 'remove-area-marker',
      label: '删除标记',
      undo: () => { areaMarkers.value[areaId].splice(idx, 0, removed); },
      redo: () => { areaMarkers.value[areaId] = areaMarkers.value[areaId].filter(m => m.id !== markerId); },
    });
    scheduleAutoSave();
  }

  function updateAreaMarker(areaId, markerId, updates) {
    if (!areaMarkers.value[areaId]) return;
    const marker = areaMarkers.value[areaId].find(m => m.id === markerId);
    if (!marker) return;
    const oldState = { ...marker };
    execute({
      type: 'update-area-marker',
      label: '编辑标记',
      undo: () => { Object.assign(marker, oldState); },
      redo: () => { Object.assign(marker, updates); },
    });
    scheduleAutoSave();
  }

  // ===== 区域地图文本管理 =====
  function addAreaTextLabel(areaId, label) {
    execute({
      type: 'add-area-text',
      label: '放置文本',
      undo: () => { areaTextLabels.value[areaId] = areaTextLabels.value[areaId].filter(l => l.id !== label.id); },
      redo: () => {
        if (!areaTextLabels.value[areaId]) areaTextLabels.value[areaId] = [];
        areaTextLabels.value[areaId].push(label);
      },
    });
    scheduleAutoSave();
  }

  function removeAreaTextLabel(areaId, labelId) {
    if (!areaTextLabels.value[areaId]) return;
    const idx = areaTextLabels.value[areaId].findIndex(l => l.id === labelId);
    if (idx === -1) return;
    const removed = areaTextLabels.value[areaId][idx];
    execute({
      type: 'remove-area-text',
      label: '删除文本',
      undo: () => { areaTextLabels.value[areaId].splice(idx, 0, removed); },
      redo: () => { areaTextLabels.value[areaId] = areaTextLabels.value[areaId].filter(l => l.id !== labelId); },
    });
    scheduleAutoSave();
  }

  function updateAreaTextLabel(areaId, labelId, updates) {
    if (!areaTextLabels.value[areaId]) return;
    const label = areaTextLabels.value[areaId].find(l => l.id === labelId);
    if (!label) return;
    const oldState = { ...label };
    execute({
      type: 'update-area-text',
      label: '编辑文本',
      undo: () => { Object.assign(label, oldState); },
      redo: () => { Object.assign(label, updates); },
    });
    scheduleAutoSave();
  }

  return {
    areaZones,
    areaRoutes,
    areaMarkers,
    areaTextLabels,
    addAreaZone,
    removeAreaZone,
    updateAreaZone,
    addAreaRoute,
    removeAreaRoute,
    updateAreaRoute,
    addAreaMarker,
    removeAreaMarker,
    updateAreaMarker,
    addAreaTextLabel,
    removeAreaTextLabel,
    updateAreaTextLabel,
  };
}
