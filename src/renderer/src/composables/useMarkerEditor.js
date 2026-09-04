// src/renderer/src/composables/useMarkerEditor.js
// 标记属性编辑状态 + 函数

import { ref, watch } from 'vue';

const MARKER_TYPES = [
  { type: 'chest', label: '宝箱', icon: '📦', color: '#FFD700' },
  { type: 'teleport', label: '传送点', icon: '🌀', color: '#9B59B6' },
  { type: 'boss', label: 'Boss', icon: '💀', color: '#E74C3C' },
  { type: 'resource', label: '资源', icon: '💎', color: '#3498DB' },
  { type: 'npc', label: 'NPC', icon: '👤', color: '#2ECC71' },
  { type: 'flag', label: '旗帜', icon: '🚩', color: '#E67E22' },
];

const MARKER_COLORS = ['#FFD700', '#9B59B6', '#E74C3C', '#3498DB', '#2ECC71', '#E67E22', '#FF6B6B', '#32CD32'];

export function useMarkerEditor({ store, props, emit, selectedMarker }) {
  const selectedMarkerType = ref('chest');
  const editingMarkerName = ref('');
  const editingMarkerDesc = ref('');
  const editingMarkerIcon = ref('');

  watch(selectedMarker, (marker) => {
    editingMarkerName.value = marker?.name || '';
    editingMarkerDesc.value = marker?.description || '';
    const preset = MARKER_TYPES.find(m => m.type === marker?.type);
    editingMarkerIcon.value = marker?.icon || preset?.icon || '📍';
  });

  function updateMarkerName() {
    if (!selectedMarker.value) return;
    store.updateMarker(props.planet.id, selectedMarker.value.id, { name: editingMarkerName.value.trim() });
    emit('dirty', true);
  }

  function updateMarkerDesc() {
    if (!selectedMarker.value) return;
    store.updateMarker(props.planet.id, selectedMarker.value.id, { description: editingMarkerDesc.value });
    emit('dirty', true);
  }

  function updateMarkerType(type) {
    if (!selectedMarker.value) return;
    const preset = MARKER_TYPES.find(m => m.type === type);
    store.updateMarker(props.planet.id, selectedMarker.value.id, {
      type,
      icon: preset?.icon || '📍',
      color: preset?.color || '#FFD700',
    });
    editingMarkerIcon.value = preset?.icon || '📍';
    emit('dirty', true);
  }

  function updateMarkerIcon() {
    if (!selectedMarker.value) return;
    store.updateMarker(props.planet.id, selectedMarker.value.id, { icon: editingMarkerIcon.value || '📍' });
    emit('dirty', true);
  }

  function updateMarkerColor(color) {
    if (!selectedMarker.value) return;
    store.updateMarker(props.planet.id, selectedMarker.value.id, { color });
    emit('dirty', true);
  }

  return {
    selectedMarkerType,
    editingMarkerName,
    editingMarkerDesc,
    editingMarkerIcon,
    markerTypes: MARKER_TYPES,
    MARKER_COLORS,
    updateMarkerName,
    updateMarkerDesc,
    updateMarkerType,
    updateMarkerIcon,
    updateMarkerColor,
  };
}
