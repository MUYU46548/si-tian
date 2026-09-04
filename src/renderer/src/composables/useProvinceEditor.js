// src/renderer/src/composables/useProvinceEditor.js
// 省份（地形）属性编辑状态 + 函数

import { ref, watch } from 'vue';

const TERRAIN_TYPES = [
  { type: 'ocean', label: '海洋', color: '#2E86AB' },
  { type: 'land', label: '陆地', color: '#A3C4BC' },
  { type: 'forest', label: '森林', color: '#2D6A4F' },
  { type: 'rainforest', label: '雨林', color: '#1B5E20' },
  { type: 'grassland', label: '草原', color: '#8BC34A' },
  { type: 'desert', label: '沙漠', color: '#E9C46A' },
  { type: 'coast', label: '海岸', color: '#C2B280' },
  { type: 'wetland', label: '湿地', color: '#5D737E' },
  { type: 'mountain', label: '山脉', color: '#8B7355' },
  { type: 'volcano', label: '火山', color: '#5D4037' },
  { type: 'barren', label: '石漠', color: '#9E9E9E' },
  { type: 'tundra', label: '苔原', color: '#78909C' },
  { type: 'snow', label: '雪地', color: '#E8E8E8' },
  { type: 'lake', label: '湖泊', color: '#6FB3C8' },
];

export function useProvinceEditor({ store, props, emit, selectedProvince }) {
  const editingName = ref('');
  const editingDescription = ref('');

  watch(selectedProvince, (poly) => {
    editingName.value = poly?.name || '';
    editingDescription.value = poly?.description || '';
  });

  function updateProvinceName() {
    if (!selectedProvince.value || !editingName.value.trim()) return;
    store.updateTerrainPolygon(props.planet.id, selectedProvince.value.id, {
      name: editingName.value.trim(),
    });
    emit('dirty', true);
  }

  function updateTerrainType(type) {
    if (!selectedProvince.value) return;
    store.updateTerrainPolygon(props.planet.id, selectedProvince.value.id, { type });
    emit('dirty', true);
  }

  function updateProvinceDescription() {
    if (!selectedProvince.value) return;
    store.updateTerrainPolygon(props.planet.id, selectedProvince.value.id, {
      description: editingDescription.value,
    });
    emit('dirty', true);
  }

  function updateTerrainField(field, value) {
    if (!selectedProvince.value) return;
    store.updateTerrainPolygon(props.planet.id, selectedProvince.value.id, {
      [field]: value,
    });
    emit('dirty', true);
  }

  return {
    editingName,
    editingDescription,
    terrainTypes: TERRAIN_TYPES,
    updateProvinceName,
    updateTerrainType,
    updateProvinceDescription,
    updateTerrainField,
  };
}
