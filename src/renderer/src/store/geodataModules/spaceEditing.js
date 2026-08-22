// store/geodataModules/spaceEditing.js — 单恒星系视图的太空实体编辑数据（批次 B6/B7）
// - spaceMarkers 太空标记：异常/资源点/古战场/太空兽群（菱形图标，B6）
// - fleetCards  部队卡片：太空舰队/行星军（信息提示卡片，无策略玩法，B7）
// 两者均为扁平数组（区别于 areaEditing 的按 areaId 分桶），坐标为「相对恒星」的系内偏移。
// 所有 CRUD 走 store/undo.js 的 execute()（undo 栈），模式镜像 areaEditing.js。
// ctx: { execute, scheduleAutoSave }
import { ref } from 'vue';

// 太空标记类型表（确定性颜色，渲染端绘制与类型提示共用）
export const SPACE_MARKER_TYPES = [
  { key: 'anomaly', label: '异常', color: '#a78bfa' },      // 紫
  { key: 'resource', label: '资源点', color: '#e8b93e' },   // 金
  { key: 'ruin', label: '古战场', color: '#e8705f' },       // 橙红
  { key: 'beast', label: '太空兽群', color: '#3ecfb0' },    // 青绿
];

// 部队卡片类型（fleet=太空舰队 / army=行星军）
export const FLEET_KINDS = [
  { key: 'fleet', label: '太空舰队', icon: '⛱' },
  { key: 'army', label: '行星军', icon: '🛡' },
];

// 加载缺字段兼容：过滤无 id/systemId 的脏数据，补齐类型/数值默认值
export function normalizeSpaceMarkers(raw) {
  if (!Array.isArray(raw)) return [];
  const validTypes = new Set(SPACE_MARKER_TYPES.map(t => t.key));
  return raw
    .filter(m => m && m.id && m.systemId)
    .map(m => ({
      id: m.id,
      systemId: m.systemId,
      x: typeof m.x === 'number' && isFinite(m.x) ? m.x : null,
      y: typeof m.y === 'number' && isFinite(m.y) ? m.y : null,
      type: validTypes.has(m.type) ? m.type : 'anomaly',
      label: typeof m.label === 'string' ? m.label : '',
    }));
}

export function normalizeFleetCards(raw) {
  if (!Array.isArray(raw)) return [];
  const validKinds = new Set(FLEET_KINDS.map(k => k.key));
  return raw
    .filter(c => c && c.id && c.systemId)
    .map(c => ({
      id: c.id,
      systemId: c.systemId,
      x: typeof c.x === 'number' && isFinite(c.x) ? c.x : null,
      y: typeof c.y === 'number' && isFinite(c.y) ? c.y : null,
      name: typeof c.name === 'string' ? c.name : '未命名部队',
      kind: validKinds.has(c.kind) ? c.kind : 'fleet',
      faction: typeof c.faction === 'string' ? c.faction : '',
      note: typeof c.note === 'string' ? c.note : '',
    }));
}

export function createSpaceEditingModule(ctx) {
  const { execute, scheduleAutoSave } = ctx;

  // ===== B6 太空标记 =====
  const spaceMarkers = ref([]);

  function addSpaceMarker(marker) {
    execute({
      type: 'add-space-marker',
      label: '添加太空标记',
      category: 'marker',
      undo: () => { spaceMarkers.value = spaceMarkers.value.filter(m => m.id !== marker.id); },
      redo: () => { spaceMarkers.value.push(marker); },
    });
    scheduleAutoSave();
    return marker;
  }

  function removeSpaceMarker(markerId) {
    const idx = spaceMarkers.value.findIndex(m => m.id === markerId);
    if (idx === -1) return;
    const removed = spaceMarkers.value[idx];
    execute({
      type: 'remove-space-marker',
      label: '删除太空标记',
      category: 'marker',
      undo: () => { spaceMarkers.value.splice(idx, 0, removed); },
      redo: () => { spaceMarkers.value = spaceMarkers.value.filter(m => m.id !== markerId); },
    });
    scheduleAutoSave();
    return removed;
  }

  function updateSpaceMarker(markerId, updates) {
    const marker = spaceMarkers.value.find(m => m.id === markerId);
    if (!marker) return;
    const oldState = { ...marker };
    execute({
      type: 'update-space-marker',
      label: '编辑太空标记',
      category: 'marker',
      undo: () => { Object.assign(marker, oldState); },
      redo: () => { Object.assign(marker, updates); },
    });
    scheduleAutoSave();
    return marker;
  }

  // ===== B7 部队卡片（仅信息提示，无策略行为） =====
  const fleetCards = ref([]);

  function addFleetCard(card) {
    execute({
      type: 'add-fleet-card',
      label: '添加部队卡片',
      category: 'marker',
      undo: () => { fleetCards.value = fleetCards.value.filter(c => c.id !== card.id); },
      redo: () => { fleetCards.value.push(card); },
    });
    scheduleAutoSave();
    return card;
  }

  function removeFleetCard(cardId) {
    const idx = fleetCards.value.findIndex(c => c.id === cardId);
    if (idx === -1) return;
    const removed = fleetCards.value[idx];
    execute({
      type: 'remove-fleet-card',
      label: '删除部队卡片',
      category: 'marker',
      undo: () => { fleetCards.value.splice(idx, 0, removed); },
      redo: () => { fleetCards.value = fleetCards.value.filter(c => c.id !== cardId); },
    });
    scheduleAutoSave();
    return removed;
  }

  function updateFleetCard(cardId, updates) {
    const card = fleetCards.value.find(c => c.id === cardId);
    if (!card) return;
    const oldState = { ...card };
    execute({
      type: 'update-fleet-card',
      label: '编辑部队卡片',
      category: 'marker',
      undo: () => { Object.assign(card, oldState); },
      redo: () => { Object.assign(card, updates); },
    });
    scheduleAutoSave();
    return card;
  }

  return {
    spaceMarkers,
    fleetCards,
    addSpaceMarker,
    removeSpaceMarker,
    updateSpaceMarker,
    addFleetCard,
    removeFleetCard,
    updateFleetCard,
  };
}
