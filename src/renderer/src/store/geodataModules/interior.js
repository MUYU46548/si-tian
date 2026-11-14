// store/geodataModules/interior.js — 建筑内部数据（第三层：楼层 + 家具）
// ctx: { execute, scheduleAutoSave }
// 注意：interiorData ref 由本模块持有，geodata.js 通过返回值取用（load/saveGeodata、selectBuilding 等）
import { ref } from 'vue';
// 内存编辑闸门：本模块有 7 个“不经 undo 守卫”的写点，只读态必须同样拦（改了不落盘 = 静默丢数据）：
//   addFloor / removeFloor / updateFloor（楼层，直接改内存）
//   removeFurniture（直接改内存）/ updateFurniture（先改内存后 execute）
//   updateInteriorReferenceImage / removeInteriorReferenceImage（参考图）
import { guardWrite } from '../writeGate';

export function createInteriorModule(ctx) {
  const { execute, scheduleAutoSave } = ctx;

  const interiorData = ref({});
  const interiorReferenceImages = ref({});

  // 添加楼层到建筑
  function addFloor(buildingId, floorName = '', position = 0) {
    if (!guardWrite('添加楼层').ok) return null;
    if (!interiorData.value[buildingId]) {
      interiorData.value[buildingId] = { buildingId, floors: [] };
    }
    const data = interiorData.value[buildingId];
    // elevation = 本层离地高度（cm）。新层默认叠在上一层之上 300cm（常见层高）。
    // 不用入参 `position` —— 那是历史遗留的未使用参数，语义是"插入位置"，别借来做高度。
    const prevFloor = data.floors[data.floors.length - 1];
    const elevation = prevFloor ? (Number(prevFloor.elevation) || 0) + 300 : 0;
    const newFloor = {
      id: `floor_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: floorName || `楼层 ${data.floors.length + 1}`,
      level: data.floors.length,
      elevation,
      walls: [],
      rooms: [],
      doors: [],
      windows: [],
      furniture: [],
      createdAt: new Date().toISOString(),
    };
    data.floors.push(newFloor);
    scheduleAutoSave();
    return newFloor;
  }

  // ── 墙 / 门窗 / 房间（2026-11-13，建筑内部地图第 1 刀）────────────────
  // 口径：坐标与尺寸一律**厘米**（见 docs/plan/INTERIOR_COPYPLAN_20261113.md §十一）。
  // 每个写口都过 guardWrite + 一条 undo（与 addFurniture 同一套纪律：
  // 直接改内存而不入栈，会让"点撤销撤掉的是上一条命令"）。

  function findFloor(buildingId, floorId) {
    const data = interiorData.value[buildingId];
    if (!data || !Array.isArray(data.floors)) return null;
    return data.floors.find((f) => f.id === floorId) || null;
  }

  /** 老数据兜底：缺哪个数组补哪个（只补空，不动已有内容） */
  function ensureFloorArrays(floor) {
    if (!floor) return floor;
    if (!Array.isArray(floor.walls)) floor.walls = [];
    if (!Array.isArray(floor.rooms)) floor.rooms = [];
    if (!Array.isArray(floor.doors)) floor.doors = [];
    if (!Array.isArray(floor.windows)) floor.windows = [];
    if (!Array.isArray(floor.furniture)) floor.furniture = [];
    if (!Number.isFinite(floor.elevation)) floor.elevation = 0;
    return floor;
  }

  /** 画一面墙（端点单位 cm） */
  function addWall(buildingId, floorId, wall = {}) {
    if (!guardWrite('画墙').ok) return null;
    const floor = ensureFloorArrays(findFloor(buildingId, floorId));
    if (!floor) return null;
    const item = {
      id: `wall_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      start: { x: Number(wall.start?.x) || 0, y: Number(wall.start?.y) || 0 },
      end: { x: Number(wall.end?.x) || 0, y: Number(wall.end?.y) || 0 },
      thickness: Number(wall.thickness) > 0 ? Number(wall.thickness) : 12,   // 默认 12cm（半砖墙）
      height: Number(wall.height) > 0 ? Number(wall.height) : 280,           // 默认 280cm 层高
      color: wall.color || '#8d7f6e',
      ...(wall.curvePoint ? { curvePoint: { x: Number(wall.curvePoint.x) || 0, y: Number(wall.curvePoint.y) || 0 } } : {}),
    };
    execute({
      type: 'add-wall',
      label: '画墙',
      undo: () => {
        const f = findFloor(buildingId, floorId);
        if (f && Array.isArray(f.walls)) f.walls = f.walls.filter((w) => w.id !== item.id);
        notifyFloorChanged(buildingId, floorId);
      },
      redo: () => {
        const f = ensureFloorArrays(findFloor(buildingId, floorId));
        if (f) f.walls.push({ ...item });
        notifyFloorChanged(buildingId, floorId);
      },
    });
    scheduleAutoSave();
    return item;
  }

  /** 改墙（拖端点 / 改厚度 / 改颜色）。`oldSnapshot` 给了就用它做 undo 的还原值 */
  function updateWall(buildingId, floorId, wallId, patch = {}, oldSnapshot = null) {
    if (!guardWrite('修改墙体').ok) return;
    const floor = ensureFloorArrays(findFloor(buildingId, floorId));
    if (!floor) return;
    const wall = floor.walls.find((w) => w.id === wallId);
    if (!wall) return;
    const before = oldSnapshot ? JSON.parse(JSON.stringify(oldSnapshot)) : JSON.parse(JSON.stringify(wall));
    const after = { ...JSON.parse(JSON.stringify(wall)), ...JSON.parse(JSON.stringify(patch)), id: wallId };
    execute({
      type: 'update-wall',
      label: '修改墙体',
      undo: () => {
        const f = findFloor(buildingId, floorId);
        const w = f && f.walls.find((x) => x.id === wallId);
        if (w) Object.assign(w, before);
        notifyFloorChanged(buildingId, floorId);
      },
      redo: () => {
        const f = findFloor(buildingId, floorId);
        const w = f && f.walls.find((x) => x.id === wallId);
        if (w) Object.assign(w, after);
        notifyFloorChanged(buildingId, floorId);
      },
    });
    scheduleAutoSave();
  }

  /**
   * 房间改名（2026-11-14，台账 A28）。房间是派生数据（由墙围合），但**名字是人给的**，
   * 所以改名必须进一条 undo，且不能被下次重算冲掉（`mergeDetectedRooms` 按墙集继承名字）。
   */
  function renameRoom(buildingId, floorId, roomId, name) {
    if (!guardWrite('房间改名').ok) return;
    const floor = ensureFloorArrays(findFloor(buildingId, floorId));
    if (!floor) return;
    const idx = floor.rooms.findIndex((r) => r.id === roomId);
    if (idx === -1) return;
    const trimmed = String(name == null ? '' : name).trim();
    if ((floor.rooms[idx].name || '') === trimmed) return;
    const before = JSON.parse(JSON.stringify(floor.rooms));
    const after = JSON.parse(JSON.stringify(floor.rooms));
    after[idx].name = trimmed;
    const apply = (list) => {
      const f = findFloor(buildingId, floorId);
      if (!f) return;
      // 只换 rooms（不动 walls）→ 不触发 recalcRooms，避免"改完名立刻重算"把名字洗掉
      f.rooms = JSON.parse(JSON.stringify(list));
    };
    execute({ type: 'rename-room', label: '房间改名', undo: () => apply(before), redo: () => apply(after) });
    scheduleAutoSave();
  }

  /**
   * 批量改墙（2026-11-14，台账 A13 墙联动）：**一条 undo 覆盖多面墙**。
   *
   * 为什么需要它：拖动一个墙角时，所有共用这个端点的墙都要跟着走。
   * 如果逐条调 `updateWall`，一次拖动会在撤销栈里留下 3~4 条 —— 用户要按 4 次撤销才能退回。
   *
   * @param {Array<{wallId:string, patch?:object, oldSnapshot?:object}>} patches
   */
  function updateWalls(buildingId, floorId, patches = []) {
    if (!guardWrite('修改墙体').ok) return;
    const floor = ensureFloorArrays(findFloor(buildingId, floorId));
    if (!floor) return;
    const before = [];
    const after = [];
    for (const p of patches) {
      const w = floor.walls.find((x) => x.id === p.wallId);
      if (!w) continue;
      const snap = p.oldSnapshot ? JSON.parse(JSON.stringify(p.oldSnapshot)) : JSON.parse(JSON.stringify(w));
      before.push({ wallId: p.wallId, snap });
      // 🔴 after 必须取**当前内存里的墙**（拖动期间已经改成新值），不能拿 oldSnapshot + patch 拼：
      //    拖拽路径 patch 是空的，那样拼出来的 after 还是旧值 —— execute 立刻执行 redo
      //    会把墙"拖回原位"（2026-11-14 实测：拖完不动，坐标还是旧的）。
      after.push({
        wallId: p.wallId,
        snap: { ...JSON.parse(JSON.stringify(w)), ...JSON.parse(JSON.stringify(p.patch || {})) },
      });
    }
    if (!before.length) return;
    const applyAll = (list) => {
      const f = findFloor(buildingId, floorId);
      if (!f) return;
      for (const it of list) {
        const w = (f.walls || []).find((x) => x.id === it.wallId);
        if (w) Object.assign(w, JSON.parse(JSON.stringify(it.snap)));
      }
      notifyFloorChanged(buildingId, floorId);
    };
    // 拖拽期间内存里已经是新值 → 这里只入栈（与 updateWall 的"patch 传空"同一套纪律）
    execute({
      type: 'update-walls',
      label: '拖动墙体',
      undo: () => applyAll(before),
      redo: () => applyAll(after),
    });
    scheduleAutoSave();
  }

  /** 删墙。挂在它上面的门/窗一起删（否则留下指不到墙的孤儿） */
  function removeWall(buildingId, floorId, wallId) {
    if (!guardWrite('删除墙体').ok) return;
    const floor = ensureFloorArrays(findFloor(buildingId, floorId));
    if (!floor) return;
    const idx = floor.walls.findIndex((w) => w.id === wallId);
    if (idx === -1) return;
    const removedWall = JSON.parse(JSON.stringify(floor.walls[idx]));
    const removedDoors = (floor.doors || []).filter((d) => d.wallId === wallId).map((d) => ({ ...d }));
    const removedWindows = (floor.windows || []).filter((d) => d.wallId === wallId).map((d) => ({ ...d }));
    execute({
      type: 'remove-wall',
      label: '删除墙体',
      undo: () => {
        const f = ensureFloorArrays(findFloor(buildingId, floorId));
        if (!f) return;
        f.walls.splice(Math.min(idx, f.walls.length), 0, removedWall);
        f.doors.push(...removedDoors);
        f.windows.push(...removedWindows);
        notifyFloorChanged(buildingId, floorId);
      },
      redo: () => {
        const f = findFloor(buildingId, floorId);
        if (!f) return;
        f.walls = f.walls.filter((w) => w.id !== wallId);
        f.doors = (f.doors || []).filter((d) => d.wallId !== wallId);
        f.windows = (f.windows || []).filter((d) => d.wallId !== wallId);
        // 挂在被删墙上的房间不再成立，一并清掉（下次检测会重建）
        f.rooms = (f.rooms || []).filter((r) => !(r.walls || []).includes(wallId));
        notifyFloorChanged(buildingId, floorId);
      },
    });
    scheduleAutoSave();
  }

  /** 门 / 窗共用：挂在某面墙上的开口（kind = 'doors' | 'windows'） */
  function addOpening(kind, buildingId, floorId, opening = {}) {
    if (!guardWrite(kind === 'doors' ? '加门' : '加窗').ok) return null;
    const floor = ensureFloorArrays(findFloor(buildingId, floorId));
    if (!floor) return null;
    if (!floor.walls.some((w) => w.id === opening.wallId)) return null;   // 必须挂在一面存在的墙上
    const isDoor = kind === 'doors';
    const item = {
      id: `${isDoor ? 'door' : 'win'}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      wallId: opening.wallId,
      position: Math.min(1, Math.max(0, Number(opening.position) || 0.5)),
      width: Number(opening.width) > 0 ? Number(opening.width) : (isDoor ? 90 : 120),
      height: Number(opening.height) > 0 ? Number(opening.height) : (isDoor ? 200 : 140),
      ...(isDoor
        ? { type: opening.type || 'single', swingDirection: opening.swingDirection || 'left', flipSide: !!opening.flipSide }
        : { type: opening.type || 'standard', sillHeight: Number(opening.sillHeight) || 90 }),
    };
    execute({
      type: isDoor ? 'add-door' : 'add-window',
      label: isDoor ? '加门' : '加窗',
      undo: () => {
        const f = findFloor(buildingId, floorId);
        if (f) f[kind] = f[kind].filter((o) => o.id !== item.id);
      },
      redo: () => {
        const f = ensureFloorArrays(findFloor(buildingId, floorId));
        if (f) f[kind].push({ ...item });
      },
    });
    scheduleAutoSave();
    return item;
  }

  function updateOpening(kind, buildingId, floorId, openingId, patch = {}) {
    if (!guardWrite(kind === 'doors' ? '改门' : '改窗').ok) return;
    const floor = ensureFloorArrays(findFloor(buildingId, floorId));
    if (!floor) return;
    const item = floor[kind].find((o) => o.id === openingId);
    if (!item) return;
    const before = JSON.parse(JSON.stringify(item));
    const after = { ...before, ...JSON.parse(JSON.stringify(patch)), id: openingId };
    execute({
      type: kind === 'doors' ? 'update-door' : 'update-window',
      label: kind === 'doors' ? '改门' : '改窗',
      undo: () => {
        const f = findFloor(buildingId, floorId);
        const o = f && f[kind].find((x) => x.id === openingId);
        if (o) Object.assign(o, before);
      },
      redo: () => {
        const f = findFloor(buildingId, floorId);
        const o = f && f[kind].find((x) => x.id === openingId);
        if (o) Object.assign(o, after);
      },
    });
    scheduleAutoSave();
  }

  function removeOpening(kind, buildingId, floorId, openingId) {
    if (!guardWrite(kind === 'doors' ? '删门' : '删窗').ok) return;
    const floor = ensureFloorArrays(findFloor(buildingId, floorId));
    if (!floor) return;
    const idx = floor[kind].findIndex((o) => o.id === openingId);
    if (idx === -1) return;
    const removed = { ...floor[kind][idx] };
    execute({
      type: kind === 'doors' ? 'remove-door' : 'remove-window',
      label: kind === 'doors' ? '删门' : '删窗',
      undo: () => {
        const f = ensureFloorArrays(findFloor(buildingId, floorId));
        if (f) f[kind].splice(Math.min(idx, f[kind].length), 0, removed);
      },
      redo: () => {
        const f = findFloor(buildingId, floorId);
        if (f) f[kind] = f[kind].filter((o) => o.id !== openingId);
      },
    });
    scheduleAutoSave();
  }

  /**
   * 写入一次房间检测结果。
   *
   * 🔴 **不入 undo 栈**（2026-11-13 用例 167 抓出来的）：房间是**派生数据**，
   * 它的还原应该跟着墙走。若这里也压一条命令，用户画一面墙后按一次撤销只会撤掉
   * "房间重算"这一步（墙上还在、房间没了），必须按两次才真正撤掉墙 —— 手感是错的。
   * 所以：墙的写口在 undo/redo 之后通过 `floorChangeHook` 触发重算，rooms 不单独入栈。
   *
   * `detected` = `utils/roomDetection.js` 的 `detectRooms()` 输出；
   * 名字/材质走 `mergeDetectedRooms` 继承（不能整份替换，否则用户改过的房间名会被冲掉）。
   */
  function setFloorRooms(buildingId, floorId, nextRooms = []) {
    if (!guardWrite('更新房间').ok) return;
    const floor = findFloor(buildingId, floorId);
    if (!floor) return;
    floor.rooms = JSON.parse(JSON.stringify(nextRooms || []));
    scheduleAutoSave();
  }

  // 墙几何变化后的回调（UI 注册 → 重算房间）。数据层不做检测（纯函数在 utils）。
  let floorChangeHook = null;
  function setFloorChangeHook(fn) { floorChangeHook = typeof fn === 'function' ? fn : null; }
  function notifyFloorChanged(buildingId, floorId) {
    if (!floorChangeHook) return;
    try { floorChangeHook(buildingId, floorId); } catch (e) { /* 重算失败不影响主操作 */ }
  }

  // 移除楼层
  function removeFloor(buildingId, floorId) {
    if (!guardWrite('移除楼层').ok) return;
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
    if (!guardWrite('更新楼层').ok) return;
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
    // 走 undo 栈：与 addFurnitureBatch / transferFurnitureBatch 一致。
    // 此前这里直接 push，命令不入栈 → 放一件家具后点撤销，撤掉的是**上一条**命令
    // （典型表现：把刚放的一整间房间/上一批家具撤没了），本次用例 37-c 抓到该缺口。
    // 注意 execute() 内部会立即调用 redo() 完成首次写入，这里不能再手动 push（防双写）。
    execute({
      type: 'add-furniture',
      label: `放置家具 ${item.name}`,
      undo: () => {
        const fl = interiorData.value[buildingId]?.floors?.find(f => f.id === floorId);
        if (fl && fl.furniture) fl.furniture = fl.furniture.filter(f => f.id !== item.id);
      },
      redo: () => {
        const fl = interiorData.value[buildingId]?.floors?.find(f => f.id === floorId);
        if (!fl) return;
        if (!fl.furniture) fl.furniture = [];
        fl.furniture.push({ ...item });
      },
    });
    scheduleAutoSave();
    return item;
  }

  // 批量放置家具（房间模板）：一次操作 = 一条 undo（R5-1）
  // 与 addFurniture 的区别：整组当作一个原子操作，撤销一次回到放置前；
  // 家具以副本入栈，撤销时按 id 过滤移除（不用闭包下标，避免中途增删错位）
  function addFurnitureBatch(buildingId, floorId, items = []) {
    const data = interiorData.value[buildingId];
    if (!data) return [];
    const floor = data.floors.find(f => f.id === floorId);
    if (!floor) return [];
    if (!floor.furniture) floor.furniture = [];

    const built = (items || []).map(f => ({
      id: `furniture_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: f.name || '新物品',
      type: f.type || 'generic',
      x: f.x ?? 0,
      y: f.y ?? 0,
      width: f.width ?? 40,
      height: f.height ?? 40,
      rotation: f.rotation ?? 0,
      color: f.color || '#8B8B8B',
    }));
    if (!built.length) return [];

    const label = items[0]?.templateLabel ? `放置${items[0].templateLabel}` : `放置 ${built.length} 件家具`;
    execute({
      type: 'add-furniture-batch',
      label,
      undo: () => {
        const ids = new Set(built.map(b => b.id));
        const fl = interiorData.value[buildingId]?.floors?.find(f => f.id === floorId);
        if (fl && fl.furniture) fl.furniture = fl.furniture.filter(f => !ids.has(f.id));
      },
      redo: () => {
        const fl = interiorData.value[buildingId]?.floors?.find(f => f.id === floorId);
        if (fl) {
          if (!fl.furniture) fl.furniture = [];
          fl.furniture.push(...built.map(b => ({ ...b })));
        }
      },
    });
    scheduleAutoSave();
    return built;
  }

  // 跨楼层批量复制/移动家具（R5-3）：整批 = 一条 undo
  // 全部用“快照 + 按 id 过滤重建”，不用闭包下标（中途增删不会错位）
  function transferFurnitureBatch(buildingId, fromFloorId, toFloorId, furnitureIds = [], mode = 'copy') {
    const data = interiorData.value[buildingId];
    if (!data) return [];
    const from = data.floors.find(f => f.id === fromFloorId);
    const to = data.floors.find(f => f.id === toFloorId);
    if (!from || !to || fromFloorId === toFloorId) return [];
    const ids = new Set(furnitureIds);
    const moving = (from.furniture || []).filter(f => ids.has(f.id));
    if (!moving.length) return [];

    const beforeSource = (from.furniture || []).map(f => ({ ...f }));
    const beforeTarget = (to.furniture || []).map(f => ({ ...f }));
    const placed = moving.map(f => ({
      ...f,
      id: mode === 'copy' ? `furniture_${Date.now()}_${Math.random().toString(36).substr(2, 9)}` : f.id,
    }));
    const afterSource = mode === 'move'
      ? beforeSource.filter(f => !ids.has(f.id))
      : beforeSource.map(f => ({ ...f }));
    const afterTarget = [...beforeTarget.map(f => ({ ...f })), ...placed];

    const setFloors = (sourceList, targetList) => {
      const d = interiorData.value[buildingId];
      const fs = d?.floors?.find(f => f.id === fromFloorId);
      const ts = d?.floors?.find(f => f.id === toFloorId);
      if (fs) fs.furniture = sourceList.map(f => ({ ...f }));
      if (ts) ts.furniture = targetList.map(f => ({ ...f }));
    };

    execute({
      type: mode === 'copy' ? 'copy-furniture-across-floors' : 'move-furniture-across-floors',
      label: mode === 'copy' ? `复制 ${placed.length} 件到其他楼层` : `移动 ${placed.length} 件到其他楼层`,
      undo: () => setFloors(beforeSource, beforeTarget),
      redo: () => setFloors(afterSource, afterTarget),
    });
    scheduleAutoSave();
    return placed;
  }

  // 移除家具
  function removeFurniture(buildingId, floorId, furnitureId) {
    if (!guardWrite('移除家具').ok) return;
    const data = interiorData.value[buildingId];
    if (!data) return;
    const floor = data.floors.find(f => f.id === floorId);
    if (!floor || !floor.furniture) return;
    floor.furniture = floor.furniture.filter(f => f.id !== furnitureId);
    scheduleAutoSave();
  }

  // 更新家具属性（支持 undo：传 oldSnapshot 记录变更前的值）
  function updateFurniture(buildingId, floorId, furnitureId, updates, oldSnapshot = null) {
    // ⚠️ 本函数**先改内存、后 execute**（Object.assign 在 execute 之前）→ 必须守函数首行，
    //    否则只读态下“拒绝”发生在数据已经改完之后（test_54 点名的危险形态）
    if (!guardWrite('更新家具').ok) return;
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

  // ===== 参考图底图 =====
  function updateInteriorReferenceImage(buildingId, refImage) {
    if (!guardWrite('更新内部参考图').ok) return null;
    if (!interiorReferenceImages.value[buildingId]) {
      interiorReferenceImages.value[buildingId] = [];
    }
    const list = interiorReferenceImages.value[buildingId];
    const idx = list.findIndex(r => r.id === refImage?.id);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...refImage };
    } else if (refImage?.id) {
      list.push(refImage);
    }
    scheduleAutoSave();
  }

  function removeInteriorReferenceImage(buildingId, refId) {
    if (!guardWrite('移除内部参考图').ok) return null;
    if (!interiorReferenceImages.value[buildingId]) return;
    interiorReferenceImages.value[buildingId] = interiorReferenceImages.value[buildingId].filter(r => r.id !== refId);
    scheduleAutoSave();
  }

  return {
    interiorData,
    interiorReferenceImages,
    addFloor,
    removeFloor,
    updateFloor,
    // 建筑内部第 1 刀（2026-11-13）：墙 / 门窗 / 房间
    addWall,
    updateWall,
    updateWalls,
    renameRoom,
    removeWall,
    addDoor: (b, f, o) => addOpening('doors', b, f, o),
    updateDoor: (b, f, id, p) => updateOpening('doors', b, f, id, p),
    removeDoor: (b, f, id) => removeOpening('doors', b, f, id),
    addWindow: (b, f, o) => addOpening('windows', b, f, o),
    updateWindow: (b, f, id, p) => updateOpening('windows', b, f, id, p),
    removeWindow: (b, f, id) => removeOpening('windows', b, f, id),
    setFloorRooms,
    setFloorChangeHook,
    ensureFloorArrays,
    addFurniture,
    addFurnitureBatch,
    transferFurnitureBatch,
    removeFurniture,
    updateFurniture,
    beginMultiFurnitureCapture,
    endMultiFurnitureCapture,
    updateInteriorReferenceImage,
    removeInteriorReferenceImage,
  };
}
