// composables/useMarkerEditor.js
// 标记属性编辑状态 + 函数
//
// P1-4：类型定义已迁到 utils/markerTypes.js（可编辑、可排序、落盘 .sitian/config）。
// 此处的 markerTypes 是模块级响应式注册表的**引用**，类型增删改后这里自动跟随，
// 不需要再维护一份硬编码副本（此前那份是"界面能改但改不完"的根源）。

import { ref, computed, watch } from 'vue';
import {
  markerTypes as markerTypeRegistry,
  resolveMarkerType,
  effectiveMarkerStyle,
  MARKER_COLORS,
} from '../utils/markerTypes';

export function useMarkerEditor({ store, props, emit, selectedMarker }) {
  const selectedMarkerType = ref('interest');
  const editingMarkerName = ref('');
  const editingMarkerDesc = ref('');
  const editingMarkerIcon = ref('');

  // 类型注册表（响应式，随设置面板的增删改实时更新）
  const markerTypes = computed(() => markerTypeRegistry.value);

  watch(selectedMarker, (marker) => {
    editingMarkerName.value = marker?.name || '';
    editingMarkerDesc.value = marker?.description || '';
    const style = effectiveMarkerStyle(marker || {});
    editingMarkerIcon.value = style.icon;
    if (marker?.type) selectedMarkerType.value = resolveMarkerType(marker.type).type;
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

  /** 选择类型 → 继承该类型的默认图标 + 颜色（P1-4「选择 type 后自动继承」） */
  function updateMarkerType(type) {
    if (!selectedMarker.value) return;
    const preset = resolveMarkerType(type);
    store.updateMarker(props.planet.id, selectedMarker.value.id, {
      type: preset.type,
      icon: preset.icon,
      color: preset.color,
    });
    editingMarkerIcon.value = preset.icon;
    emit('dirty', true);
  }

  /** 单点覆盖图标（覆盖后不再跟随类型，保存后不丢） */
  function updateMarkerIcon() {
    if (!selectedMarker.value) return;
    store.updateMarker(props.planet.id, selectedMarker.value.id, { icon: editingMarkerIcon.value || 'map-pin' });
    emit('dirty', true);
  }

  function updateMarkerColor(color) {
    if (!selectedMarker.value) return;
    store.updateMarker(props.planet.id, selectedMarker.value.id, { color });
    emit('dirty', true);
  }

  /** 恢复为类型的默认图标/颜色（清掉单点覆盖） */
  function resetMarkerToType() {
    if (!selectedMarker.value) return;
    const preset = resolveMarkerType(selectedMarker.value.type);
    store.updateMarker(props.planet.id, selectedMarker.value.id, { icon: preset.icon, color: preset.color });
    editingMarkerIcon.value = preset.icon;
    emit('dirty', true);
  }

  return {
    selectedMarkerType,
    editingMarkerName,
    editingMarkerDesc,
    editingMarkerIcon,
    markerTypes,
    MARKER_COLORS,
    updateMarkerName,
    updateMarkerDesc,
    updateMarkerType,
    updateMarkerIcon,
    updateMarkerColor,
    resetMarkerToType,
  };
}
