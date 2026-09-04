// src/renderer/src/composables/useRouteEditor.js
// 路线属性编辑状态 + 函数

import { ref, watch } from 'vue';

const ROUTE_COLORS = ['#E67E22', '#D35400', '#C0392B', '#16A085', '#2C3E50', '#8E44AD', '#34495E', '#B7950B'];

export function useRouteEditor({ store, props, emit, selectedRoute, renderer }) {
  const routeDashed = ref(false);
  const routeColor = ref('#E67E22');
  const routeDraftPoints = ref([]);
  const editingRouteName = ref('');
  const editingRouteLabel = ref('');
  const editingRouteDesc = ref('');
  const editingRouteOffsetX = ref(0);
  const editingRouteOffsetY = ref(0);

  watch(selectedRoute, (route) => {
    editingRouteName.value = route?.name || '';
    editingRouteLabel.value = route?.label || '';
    editingRouteDesc.value = route?.description || '';
    editingRouteOffsetX.value = route?.labelOffsetX || 0;
    editingRouteOffsetY.value = route?.labelOffsetY || 0;
    routeDashed.value = !!route?.dashed;
    routeColor.value = route?.color || '#E67E22';
  });

  function updateRouteName() {
    if (!selectedRoute.value) return;
    store.updateRoute(props.planet.id, selectedRoute.value.id, { name: editingRouteName.value.trim() });
    emit('dirty', true);
  }

  function updateRouteLabel() {
    if (!selectedRoute.value) return;
    store.updateRoute(props.planet.id, selectedRoute.value.id, { label: editingRouteLabel.value });
    emit('dirty', true);
  }

  function updateRouteDesc() {
    if (!selectedRoute.value) return;
    store.updateRoute(props.planet.id, selectedRoute.value.id, { description: editingRouteDesc.value });
    emit('dirty', true);
  }

  function updateRouteOffset() {
    if (!selectedRoute.value) return;
    store.updateRoute(props.planet.id, selectedRoute.value.id, {
      labelOffsetX: editingRouteOffsetX.value || 0,
      labelOffsetY: editingRouteOffsetY.value || 0,
    });
    emit('dirty', true);
    renderer.requestRender();
  }

  function resetRouteOffset() {
    editingRouteOffsetX.value = 0;
    editingRouteOffsetY.value = 0;
    updateRouteOffset();
  }

  function updateRouteDashed(dashed) {
    if (!selectedRoute.value) return;
    store.updateRoute(props.planet.id, selectedRoute.value.id, { dashed });
    emit('dirty', true);
  }

  function updateRouteColor(color) {
    if (!selectedRoute.value) return;
    store.updateRoute(props.planet.id, selectedRoute.value.id, { color });
    emit('dirty', true);
  }

  return {
    routeDashed,
    routeColor,
    routeDraftPoints,
    editingRouteName,
    editingRouteLabel,
    editingRouteDesc,
    editingRouteOffsetX,
    editingRouteOffsetY,
    ROUTE_COLORS,
    updateRouteName,
    updateRouteLabel,
    updateRouteDesc,
    updateRouteOffset,
    resetRouteOffset,
    updateRouteDashed,
    updateRouteColor,
  };
}
