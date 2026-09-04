// src/renderer/src/composables/useBatchArrange.js
// 批量排列/对齐/分布/移入区域

import { ref, computed } from 'vue';
import { alignItems, distributeItems, diffPositions } from '../utils/align';

export function useBatchArrange({ store, props, emit, renderer, currentMapData, batchSelection }) {
  // ===== 批量排列 =====
  const arrangeDialogOpen = ref(false);
  const arrangeMode = ref('grid');
  const arrangeCols = ref(4);
  const arrangeSpacing = ref(500);

  function openArrangeDialog(selectedPlaceIds) {
    if (selectedPlaceIds.size < 2) return;
    arrangeMode.value = 'grid';
    arrangeCols.value = Math.ceil(Math.sqrt(selectedPlaceIds.size));
    arrangeSpacing.value = 500;
    arrangeDialogOpen.value = true;
  }

  function getSelectedNodesCenter(selectedPlaceIds) {
    const ids = Array.from(selectedPlaceIds);
    let sumX = 0, sumY = 0, count = 0;
    for (const id of ids) {
      const node = store.nodes.find(n => n.id === id);
      if (node && node.coordinate) {
        sumX += node.coordinate.x || 0;
        sumY += node.coordinate.y || 0;
        count++;
      }
    }
    if (count === 0) return { x: 0, y: 0 };
    return { x: sumX / count, y: sumY / count };
  }

  // 位置批量应用统一走此函数：一次拖动/排列/对齐 = 一个 undo 步骤
  function applyPositions(positions) {
    const valid = positions.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
    if (!valid.length) return;
    store.beginMultiNodePositionCapture(valid.map(p => p.id));
    for (const pos of valid) {
      store.updateNodePosition(pos.id, pos.x, pos.y);
    }
    store.endMultiNodePositionCapture();
    emit('dirty', true);
    renderer.requestRender();
  }

  function confirmArrange(selectedPlaceIds) {
    const ids = Array.from(selectedPlaceIds);
    if (ids.length < 2) return;

    const spacing = arrangeSpacing.value;
    const center = getSelectedNodesCenter(selectedPlaceIds);
    let positions = [];

    switch (arrangeMode.value) {
      case 'grid': {
        const cols = Math.max(1, arrangeCols.value);
        const rows = Math.ceil(ids.length / cols);
        const startX = center.x - ((cols - 1) * spacing) / 2;
        const startY = center.y - ((rows - 1) * spacing) / 2;
        for (let i = 0; i < ids.length; i++) {
          const col = i % cols;
          const row = Math.floor(i / cols);
          positions.push({
            id: ids[i],
            x: Math.round(startX + col * spacing),
            y: Math.round(startY + row * spacing),
          });
        }
        break;
      }
      case 'circle': {
        const radius = spacing;
        for (let i = 0; i < ids.length; i++) {
          const angle = (i / ids.length) * Math.PI * 2 - Math.PI / 2;
          positions.push({
            id: ids[i],
            x: Math.round(center.x + Math.cos(angle) * radius),
            y: Math.round(center.y + Math.sin(angle) * radius),
          });
        }
        break;
      }
      case 'line_h': {
        const startX = center.x - ((ids.length - 1) * spacing) / 2;
        for (let i = 0; i < ids.length; i++) {
          positions.push({
            id: ids[i],
            x: Math.round(startX + i * spacing),
            y: Math.round(center.y),
          });
        }
        break;
      }
      case 'line_v': {
        const startY = center.y - ((ids.length - 1) * spacing) / 2;
        for (let i = 0; i < ids.length; i++) {
          positions.push({
            id: ids[i],
            x: Math.round(center.x),
            y: Math.round(startY + i * spacing),
          });
        }
        break;
      }
    }

    applyPositions(positions);
    arrangeDialogOpen.value = false;
  }

  // ===== 对齐与分布（多选地点） =====
  function getSelectedPlaceItems(selectedPlaceIds) {
    const items = [];
    for (const id of selectedPlaceIds) {
      const node = store.nodes.find(n => n.id === id);
      if (node?.coordinate?.x != null) {
        items.push({ id: node.id, x: node.coordinate.x, y: node.coordinate.y });
      }
    }
    return items;
  }

  function alignSelected(mode, selectedPlaceIds) {
    const items = getSelectedPlaceItems(selectedPlaceIds);
    if (items.length < 2) return;
    applyPositions(diffPositions(items, alignItems(items, mode)));
  }

  function distributeSelected(axis, selectedPlaceIds) {
    const items = getSelectedPlaceItems(selectedPlaceIds);
    if (items.length < 3) return;
    applyPositions(diffPositions(items, distributeItems(items, axis)));
  }

  // ===== 批量移入区域 =====
  const reparentDialogOpen = ref(false);
  const reparentTargetId = ref('');

  const reparentCandidates = computed(() => {
    return store.nodes.filter(n =>
      n.parentId === props.planet.id &&
      ['city', 'town', 'village'].includes(n.layer)
    );
  });

  function openReparentDialog(selectedPlaceIds) {
    if (selectedPlaceIds.size === 0) return;
    reparentTargetId.value = '';
    reparentDialogOpen.value = true;
  }

  function confirmReparent(selectedPlaceIds) {
    if (!reparentTargetId.value || selectedPlaceIds.size === 0) return;
    const ids = Array.from(selectedPlaceIds);
    const results = store.reparentNodes(ids, reparentTargetId.value);
    const failed = results.filter(r => !r.success);
    if (failed.length > 0) {
      alert(`${failed.length} 个节点迁移失败：${failed.map(f => `${f.id} (${f.reason})`).join(', ')}`);
    }
    selectedPlaceIds.clear();
    reparentDialogOpen.value = false;
    emit('dirty', true);
    renderer.requestRender();
  }

  return {
    arrangeDialogOpen,
    arrangeMode,
    arrangeCols,
    arrangeSpacing,
    openArrangeDialog,
    confirmArrange,
    alignSelected,
    distributeSelected,
    reparentDialogOpen,
    reparentTargetId,
    reparentCandidates,
    openReparentDialog,
    confirmReparent,
    applyPositions,
    getSelectedPlaceItems,
  };
}
