// store/geodataModules/mapDataEditing.js — mapData 域 CRUD（地形/区域/路线/文本/标记/参考图/快照/地点簇）
// ctx: { mapData, nodes, execute, scheduleAutoSave, scheduleAutoSaveMap }
export function createMapDataEditingModule(ctx) {
  const { mapData, nodes, execute, scheduleAutoSave, scheduleAutoSaveMap } = ctx;

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

  // E7 批量属性/位置更新：一次 execute 合并多个对象的修改（单条 undo 步骤）
  // entries: [{ kind: 'marker'|'textLabel', id, updates: {...}, old: {...} }]
  function batchUpdateMapObjects(planetId, entries) {
    const data = mapData.value[planetId];
    if (!data) return;
    const applied = [];
    for (const entry of entries || []) {
      const list = entry.kind === 'marker' ? data.markers : (entry.kind === 'textLabel' ? data.textLabels : null);
      if (!list) continue;
      const obj = list.find(o => o.id === entry.id);
      if (!obj) continue;
      const updates = { ...entry.updates };
      const oldState = {};
      for (const key of Object.keys(updates)) {
        oldState[key] = entry.old && entry.old[key] !== undefined ? entry.old[key] : obj[key];
      }
      Object.assign(obj, updates);
      applied.push({ obj, updates, oldState });
    }
    if (applied.length === 0) return;
    mapData.value[planetId].updatedAt = new Date().toISOString();
    execute({
      type: 'batch-update-objects',
      label: `批量编辑 ${applied.length} 个对象`,
      category: 'property',
      undo: () => {
        applied.forEach(a => Object.assign(a.obj, a.oldState));
      },
      redo: () => {
        applied.forEach(a => Object.assign(a.obj, a.updates));
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

  function clearReferenceImage(planetId) {
    if (!mapData.value[planetId]) return;
    delete mapData.value[planetId].referenceImage;
    mapData.value[planetId].updatedAt = new Date().toISOString();
    scheduleAutoSaveMap(planetId);
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

  // ===== P0-1 Relief Icons：一次笔刷拖动 = 一条 undo（增/删合并成单条命令）=====
  /**
   * @param {string} planetId
   * @param {Array} added   本次拖动新增的图标
   * @param {Array<string>} removedIds 本次拖动擦除的图标 id
   */
  function applyReliefStroke(planetId, added = [], removedIds = []) {
    if (!mapData.value[planetId]) return;
    if (!Array.isArray(mapData.value[planetId].reliefIcons)) {
      mapData.value[planetId].reliefIcons = [];
    }
    const removeSet = new Set(removedIds);
    const before = mapData.value[planetId].reliefIcons.slice();
    const after = before.filter(it => !removeSet.has(it.id)).concat(added);
    if (before.length === after.length && added.length === 0) return;

    const label = added.length && removedIds.length
      ? '修整地貌图标'
      : (added.length ? '散布地貌图标' : '擦除地貌图标');

    // 快照式 undo：只换数组内容，不逐个记忆下标（下标会随增删漂移）
    execute({
      type: 'relief-stroke',
      label,
      category: 'region',
      undo: () => { mapData.value[planetId].reliefIcons = before.slice(); },
      redo: () => { mapData.value[planetId].reliefIcons = after.slice(); },
    });
    mapData.value[planetId].updatedAt = new Date().toISOString();
    scheduleAutoSaveMap(planetId);
  }

  /** 清空全部地貌图标（单条 undo） */
  function clearReliefIcons(planetId) {
    if (!mapData.value[planetId]?.reliefIcons?.length) return;
    const before = mapData.value[planetId].reliefIcons.slice();
    execute({
      type: 'clear-relief',
      label: '清空地貌图标',
      category: 'region',
      undo: () => { mapData.value[planetId].reliefIcons = before.slice(); },
      redo: () => { mapData.value[planetId].reliefIcons = []; },
    });
    scheduleAutoSaveMap(planetId);
  }

  // ===== P1-1 河流图层（节点带 h 高度，供流向校验）=====
  function ensureRivers(planetId) {
    if (!mapData.value[planetId]) return null;
    if (!Array.isArray(mapData.value[planetId].rivers)) mapData.value[planetId].rivers = [];
    return mapData.value[planetId].rivers;
  }

  /** 新增整条河流（一次创建 = 一条 undo） */
  function addRiver(planetId, river) {
    if (!ensureRivers(planetId)) return null;
    const item = JSON.parse(JSON.stringify(river));
    execute({
      type: 'add-river',
      label: '绘制河流',
      category: 'region',
      undo: () => { mapData.value[planetId].rivers = mapData.value[planetId].rivers.filter(r => r.id !== item.id); },
      redo: () => { if (!mapData.value[planetId].rivers.some(r => r.id === item.id)) mapData.value[planetId].rivers.push(item); },
    });
    scheduleAutoSaveMap(planetId);
    return item;
  }

  function removeRiver(planetId, riverId) {
    const list = mapData.value[planetId]?.rivers;
    if (!Array.isArray(list)) return;
    const before = list.slice();
    const after = before.filter(r => r.id !== riverId);
    if (after.length === before.length) return;
    execute({
      type: 'remove-river',
      label: '删除河流',
      category: 'region',
      undo: () => { mapData.value[planetId].rivers = before.slice(); },
      redo: () => { mapData.value[planetId].rivers = after.slice(); },
    });
    scheduleAutoSaveMap(planetId);
  }

  /**
   * 更新河流（路径/线宽/名称）。
   * @param {object} oldSnapshot 拖动类操作必须传"操作前"的快照，否则 undo 会采集到已改后的值
   */
  function updateRiver(planetId, riverId, updates, oldSnapshot = null) {
    const list = mapData.value[planetId]?.rivers;
    if (!Array.isArray(list)) return;
    const river = list.find(r => r.id === riverId);
    if (!river) return;
    const old = oldSnapshot ? JSON.parse(JSON.stringify(oldSnapshot)) : {};
    if (!oldSnapshot) { for (const k of Object.keys(updates)) old[k] = river[k]; }
    const next = JSON.parse(JSON.stringify(updates));
    execute({
      type: 'update-river',
      label: '编辑河流',
      category: 'region',
      undo: () => { Object.assign(river, JSON.parse(JSON.stringify(old))); },
      redo: () => { Object.assign(river, JSON.parse(JSON.stringify(next))); },
    });
    scheduleAutoSaveMap(planetId);
  }

  // ===== P1-2 道路样式（style 字段 + 同步 color/dashed 以保持与旧渲染路径一致）=====
  function setRouteStyle(planetId, routeId, style, styleMeta = null) {
    const list = mapData.value[planetId]?.routes;
    if (!Array.isArray(list)) return;
    const route = list.find(r => r.id === routeId);
    if (!route) return;
    const old = { style: route.style, color: route.color, dashed: route.dashed };
    const next = {
      style,
      color: styleMeta?.color || route.color,
      dashed: styleMeta?.dashed !== undefined ? styleMeta.dashed : route.dashed,
    };
    execute({
      type: 'set-route-style',
      label: '道路样式',
      category: 'property',
      undo: () => { Object.assign(route, old); },
      redo: () => { Object.assign(route, next); },
    });
    scheduleAutoSaveMap(planetId);
  }

  // ===== P1-3 文化列表（行星级共享数据，供聚落"文化归属"下拉使用）=====
  function addCulture(planetId, culture) {
    if (!mapData.value[planetId]) return null;
    if (!Array.isArray(mapData.value[planetId].cultures)) mapData.value[planetId].cultures = [];
    const list = mapData.value[planetId].cultures;
    const item = { id: culture.id, name: culture.name, color: culture.color, note: culture.note || '' };
    execute({
      type: 'add-culture',
      label: '新建文化',
      category: 'property',
      undo: () => { mapData.value[planetId].cultures = mapData.value[planetId].cultures.filter(c => c.id !== item.id); },
      redo: () => { if (!mapData.value[planetId].cultures.some(c => c.id === item.id)) mapData.value[planetId].cultures.push(item); },
    });
    scheduleAutoSaveMap(planetId);
    return item;
  }

  function removeCulture(planetId, cultureId) {
    const list = mapData.value[planetId]?.cultures;
    if (!Array.isArray(list)) return;
    const before = list.slice();
    const after = before.filter(c => c.id !== cultureId);
    if (after.length === before.length) return;
    execute({
      type: 'remove-culture',
      label: '删除文化',
      category: 'property',
      undo: () => { mapData.value[planetId].cultures = before.slice(); },
      redo: () => { mapData.value[planetId].cultures = after.slice(); },
    });
    scheduleAutoSaveMap(planetId);
  }

  function updateCulture(planetId, cultureId, patch) {
    const list = mapData.value[planetId]?.cultures;
    if (!Array.isArray(list)) return;
    const idx = list.findIndex(c => c.id === cultureId);
    if (idx < 0) return;
    const old = { ...list[idx] };
    const next = { ...old, ...patch };
    execute({
      type: 'update-culture',
      label: '编辑文化',
      category: 'property',
      undo: () => { mapData.value[planetId].cultures = mapData.value[planetId].cultures.map(c => (c.id === cultureId ? old : c)); },
      redo: () => { mapData.value[planetId].cultures = mapData.value[planetId].cultures.map(c => (c.id === cultureId ? next : c)); },
    });
    scheduleAutoSaveMap(planetId);
  }

  return {
    addTerrainPolygon,
    removeTerrainPolygon,
    updateTerrainPolygon,
    updateControlPoint,
    splitTerrainPolygon,
    mergeTerrainPolygons,
    addRegion,
    removeRegion,
    updateRegion,
    addRoute,
    removeRoute,
    updateRoute,
    addTextLabel,
    removeTextLabel,
    updateTextLabel,
    addMarker,
    removeMarker,
    updateMarker,
    batchUpdateMapObjects,
    updateReferenceImage,
    clearReferenceImage,
    removeReferenceImageById,
    addMapSnapshot,
    removeMapSnapshot,
    restoreMapSnapshot,
    addCluster,
    removeCluster,
    updateCluster,
    moveClusterMembers,
    applyReliefStroke,
    clearReliefIcons,
    addCulture,
    removeCulture,
    updateCulture,
    setRouteStyle,
    addRiver,
    removeRiver,
    updateRiver,
  };
}
