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
  };
}
