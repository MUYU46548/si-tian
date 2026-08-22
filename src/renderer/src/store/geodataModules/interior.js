// store/geodataModules/interior.js — 建筑内部数据（第三层：楼层 + 家具）
// ctx: { execute, scheduleAutoSave }
// 注意：interiorData ref 由本模块持有，geodata.js 通过返回值取用（load/saveGeodata、selectBuilding 等）
import { ref } from 'vue';

export function createInteriorModule(ctx) {
  const { execute, scheduleAutoSave } = ctx;

  const interiorData = ref({});

  // 添加楼层到建筑
  function addFloor(buildingId, floorName = '', position = 0) {
    if (!interiorData.value[buildingId]) {
      interiorData.value[buildingId] = { buildingId, floors: [] };
    }
    const data = interiorData.value[buildingId];
    const newFloor = {
      id: `floor_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: floorName || `楼层 ${data.floors.length + 1}`,
      level: data.floors.length,
      furniture: [],
      createdAt: new Date().toISOString(),
    };
    data.floors.push(newFloor);
    scheduleAutoSave();
    return newFloor;
  }

  // 移除楼层
  function removeFloor(buildingId, floorId) {
    const data = interiorData.value[buildingId];
    if (!data) return;
    const idx = data.floors.findIndex(f => f.id === floorId);
    if (idx === -1) return;
    data.floors.splice(idx, 1);
    // 重新编号
    data.floors.forEach((f, i) => f.level = i);
    scheduleAutoSave();
  }

  // 更新楼层属性
  function updateFloor(buildingId, floorId, updates) {
    const data = interiorData.value[buildingId];
    if (!data) return;
    const floor = data.floors.find(f => f.id === floorId);
    if (!floor) return;
    Object.assign(floor, updates);
    floor.updatedAt = new Date().toISOString();
    scheduleAutoSave();
  }

  // 添加家具到楼层
  function addFurniture(buildingId, floorId, furniture) {
    const data = interiorData.value[buildingId];
    if (!data) return;
    const floor = data.floors.find(f => f.id === floorId);
    if (!floor) return;
    if (!floor.furniture) floor.furniture = [];
    const item = {
      id: `furniture_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: furniture.name || '新物品',
      type: furniture.type || 'generic',
      x: furniture.x ?? 0,
      y: furniture.y ?? 0,
      width: furniture.width ?? 40,
      height: furniture.height ?? 40,
      rotation: furniture.rotation ?? 0,
      color: furniture.color || '#8B8B8B',
    };
    floor.furniture.push(item);
    scheduleAutoSave();
    return item;
  }

  // 移除家具
  function removeFurniture(buildingId, floorId, furnitureId) {
    const data = interiorData.value[buildingId];
    if (!data) return;
    const floor = data.floors.find(f => f.id === floorId);
    if (!floor || !floor.furniture) return;
    floor.furniture = floor.furniture.filter(f => f.id !== furnitureId);
    scheduleAutoSave();
  }

  // 更新家具属性（支持 undo：传 oldSnapshot 记录变更前的值）
  function updateFurniture(buildingId, floorId, furnitureId, updates, oldSnapshot = null) {
    const data = interiorData.value[buildingId];
    if (!data) return;
    const floor = data.floors.find(f => f.id === floorId);
    if (!floor || !floor.furniture) return;
    const item = floor.furniture.find(f => f.id === furnitureId);
    if (!item) return;
    const oldState = {};
    if (oldSnapshot) {
      Object.assign(oldState, oldSnapshot);
    } else {
      for (const key of Object.keys(updates)) {
        oldState[key] = item[key];
      }
    }
    Object.assign(item, updates);
    execute({
      type: 'update-furniture',
      label: '移动家具',
      undo: () => { Object.assign(item, oldState); },
      redo: () => { Object.assign(item, updates); },
    });
    scheduleAutoSave();
  }

  // ===== 家具多选拖拽撤销支持 =====
  // 模块级可变状态：家具多选拖拽的起始坐标捕获（归属 interior 域，随模块工厂实例化）
  let furnitureDragStartMap = null;

  function beginMultiFurnitureCapture(buildingId, floorId, furnitureIds) {
    const data = interiorData.value[buildingId];
    if (!data) return;
    const floor = data.floors.find(f => f.id === floorId);
    if (!floor) return;
    furnitureDragStartMap = new Map();
    for (const id of furnitureIds) {
      const item = floor.furniture.find(f => f.id === id);
      if (item) {
        furnitureDragStartMap.set(id, { x: item.x, y: item.y });
      }
    }
  }

  function endMultiFurnitureCapture(buildingId, floorId) {
    if (!furnitureDragStartMap || furnitureDragStartMap.size === 0) return;
    const startMap = furnitureDragStartMap;
    const data = interiorData.value[buildingId];
    if (!data) { furnitureDragStartMap = null; return; }
    const floor = data.floors.find(f => f.id === floorId);
    if (!floor) { furnitureDragStartMap = null; return; }
    const endMap = new Map();
    for (const id of startMap.keys()) {
      const item = floor.furniture.find(f => f.id === id);
      if (item) {
        endMap.set(id, { x: item.x, y: item.y });
      }
    }
    execute({
      type: 'move-furnitures',
      label: `移动 ${startMap.size} 件家具`,
      undo: () => {
        const start = startMap;
        for (const [id, coord] of start) {
          const item = floor.furniture.find(f => f.id === id);
          if (item) { item.x = coord.x; item.y = coord.y; }
        }
      },
      redo: () => {
        for (const [id, coord] of endMap) {
          const item = floor.furniture.find(f => f.id === id);
          if (item) { item.x = coord.x; item.y = coord.y; }
        }
      },
    });
    furnitureDragStartMap = null;
    scheduleAutoSave();
  }

  return {
    interiorData,
    addFloor,
    removeFloor,
    updateFloor,
    addFurniture,
    removeFurniture,
    updateFurniture,
    beginMultiFurnitureCapture,
    endMultiFurnitureCapture,
  };
}
