// src/renderer/src/composables/useRegionEditor.js
// 区域属性编辑状态 + 函数

import { ref, watch } from 'vue';

const REGION_COLORS = ['#FF6B6B', '#FFA500', '#FFD700', '#32CD32', '#4169E1', '#9B59B6'];

export function useRegionEditor({ store, props, emit, selectedRegion }) {
  const editingRegionName = ref('');
  const editingRegionDescription = ref('');
  const regionColor = ref('#FF6B6B');

  watch(selectedRegion, (region) => {
    editingRegionName.value = region?.name || '';
    editingRegionDescription.value = region?.description || '';
    regionColor.value = region?.color || '#FF6B6B';
  });

  function updateRegionName() {
    if (!selectedRegion.value || !editingRegionName.value.trim()) return;
    store.updateRegion(props.planet.id, selectedRegion.value.id, {
      name: editingRegionName.value.trim(),
    });
    emit('dirty', true);
  }

  function updateRegionColor(color) {
    if (!selectedRegion.value) return;
    store.updateRegion(props.planet.id, selectedRegion.value.id, { color });
    emit('dirty', true);
  }

  function updateRegionDescription() {
    if (!selectedRegion.value) return;
    store.updateRegion(props.planet.id, selectedRegion.value.id, {
      description: editingRegionDescription.value,
    });
    emit('dirty', true);
  }

  return {
    editingRegionName,
    editingRegionDescription,
    regionColor,
    REGION_COLORS,
    updateRegionName,
    updateRegionColor,
    updateRegionDescription,
  };
}
