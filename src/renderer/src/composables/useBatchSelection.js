// src/renderer/src/composables/useBatchSelection.js
// 批量选择与变换状态管理

import { ref, computed } from 'vue';
import { alignItems, distributeItems } from '../utils/align';

export function useBatchSelection({ store, props, emit, renderer, currentMapData, exportStatus }) {
  // ===== E7 批量选择（marker/textLabel，Shift+点击累加）+ E5 智能参考线状态 =====
  const multiSel = ref([]);            // [{ type: 'marker'|'textLabel', id }]
  const smartGuides = ref([]);         // 拖拽中的对齐参考线 [{ axis: 'v'|'h', coord }]
  const smartGuidesEnabled = ref(true);
  // E4：旋转/缩放手柄拖拽中的变换信息（onDragStart 写入，松手提交后清空）
  const transformDrag = ref(null);
  // E7：刚被 Shift 切换的成员（onClick 守卫，600ms 窗口）
  const lastShiftToggle = ref(null);

  // E7：批量组成员对象解析（供面板/计数使用）
  const multiSelObjs = computed(() => {
    const data = currentMapData.value;
    return multiSel.value
      .map(m => {
        const obj = m.type === 'marker'
          ? data?.markers?.find(o => o.id === m.id)
          : data?.textLabels?.find(o => o.id === m.id);
        return obj ? { type: m.type, id: m.id, obj } : null;
      })
      .filter(Boolean);
  });

  const multiMarkers = computed(() => multiSelObjs.value.filter(o => o.type === 'marker'));
  const multiLabels = computed(() => multiSelObjs.value.filter(o => o.type === 'textLabel'));

  // P1：批量面板与侧栏属性面板共用 .province-editor 定位槽（right:16 top:120）
  // 同时可见会完全重叠——批量面板出现时侧栏 marker/text 编辑器让位
  const batchPanelVisible = computed(() => multiSel.value.length >= 2 && multiSelObjs.value.length >= 2);

  function isShiftToggleActive(id, type) {
    const t = lastShiftToggle.value;
    return !!(t && t.id === id && t.type === type && Date.now() - t.t < 600);
  }

  // ===== E7 批量属性应用（统一类型/颜色/字号；单条 undo 命令）=====
  function batchApply(kind, updates) {
    const entries = (kind === 'marker' ? multiMarkers.value : multiLabels.value)
      .map(({ id, obj }) => {
        const old = {};
        for (const key of Object.keys(updates)) old[key] = obj[key];
        return { kind, id, updates: { ...updates }, old };
      });
    if (entries.length === 0) return;
    store.batchUpdateMapObjects(props.planet.id, entries);
    if (exportStatus) exportStatus.value = `已批量更新 ${entries.length} 个${kind === 'marker' ? '标记' : '文本'}`;
    emit('dirty', true);
    renderer.requestRender();
  }

  // E7：重置批量成员的旋转/缩放（配合 E4）
  function batchResetTransform() {
    const entries = multiSelObjs.value
      .filter(({ obj }) => obj.rotation || (obj.scale && obj.scale !== 1))
      .map(({ kind, id, obj }) => ({ kind, id, updates: { rotation: 0, scale: 1 }, old: { rotation: obj.rotation || 0, scale: obj.scale || 1 } }));
    if (entries.length === 0) return;
    store.batchUpdateMapObjects(props.planet.id, entries);
    if (exportStatus) exportStatus.value = `已重置 ${entries.length} 个对象的变换`;
    emit('dirty', true);
    renderer.requestRender();
  }

  // P2：批量组（markers/textLabels 混合）对齐与分布 — 与 E3 地点对齐共用
  // utils/align 纯函数，位置变更经 batchUpdateMapObjects 合并为单条 undo
  function getMultiSelItems() {
    return multiSelObjs.value.map(({ id, obj }) => ({ id, x: obj.x, y: obj.y }));
  }

  function applyMultiTargets(targets) {
    const map = new Map(multiSelObjs.value.map(o => [o.id, o]));
    const entries = targets
      .map(t => {
        const o = map.get(t.id);
        if (!o || (o.obj.x === t.x && o.obj.y === t.y)) return null;
        return { kind: o.type, id: t.id, updates: { x: t.x, y: t.y }, old: { x: o.obj.x, y: o.obj.y } };
      })
      .filter(Boolean);
    if (!entries.length) return;
    store.batchUpdateMapObjects(props.planet.id, entries);
    emit('dirty', true);
    renderer.requestRender();
  }

  function alignMultiSel(mode) {
    const items = getMultiSelItems();
    if (items.length < 2) return;
    applyMultiTargets(alignItems(items, mode));
  }

  function distributeMultiSel(axis) {
    const items = getMultiSelItems();
    if (items.length < 3) return;
    applyMultiTargets(distributeItems(items, axis));
  }

  return {
    multiSel,
    smartGuides,
    smartGuidesEnabled,
    transformDrag,
    lastShiftToggle,
    multiSelObjs,
    multiMarkers,
    multiLabels,
    batchPanelVisible,
    isShiftToggleActive,
    batchApply,
    batchResetTransform,
    getMultiSelItems,
    applyMultiTargets,
    alignMultiSel,
    distributeMultiSel,
  };
}
