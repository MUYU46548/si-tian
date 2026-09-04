// src/renderer/src/composables/useObjectPanel.js
// 对象列表面板事件：聚焦/重命名/删除地形、标记、路线、文本

export function useObjectPanel({ store, props, emit, renderer, drawing, currentMapData, selectedProvince, selectedRegion, selectedMarker, selectedRoute, selectedTextLabel }) {
  // 聚焦：选中对象并平移画布到对象中心
  function focusObject({ type, id }) {
    const data = currentMapData.value;
    if (!data) return;
    let center = null;
    // 清空其他选中
    selectedProvince.value = null;
    selectedRegion.value = null;
    selectedMarker.value = null;
    selectedRoute.value = null;
    selectedTextLabel.value = null;

    if (type === 'terrain') {
      const poly = (data.terrain || []).find(p => p.id === id);
      if (!poly) return;
      selectedProvince.value = poly;
      if (poly.points?.length) center = drawing.getPolygonCenter(poly.points);
    } else if (type === 'marker') {
      const m = (data.markers || []).find(x => x.id === id);
      if (!m) return;
      selectedMarker.value = m;
      center = { x: m.x, y: m.y };
    } else if (type === 'route') {
      const r = (data.routes || []).find(x => x.id === id);
      if (!r || !r.points?.length) return;
      selectedRoute.value = r;
      center = r.points[Math.floor(r.points.length / 2)];
    } else if (type === 'text') {
      const t = (data.textLabels || []).find(x => x.id === id);
      if (!t) return;
      selectedTextLabel.value = t;
      center = { x: t.x, y: t.y };
    }

    if (center) {
      renderer.focusOn(center.x, center.y, renderer.getViewTransform().scale);
    }
    renderer.requestRender();
  }

  // 重命名对象（文本对象改 text 字段，其余改 name）
  function renameObject({ type, id, name }) {
    const planetId = props.planet.id;
    if (type === 'terrain') store.updateTerrainPolygon(planetId, id, { name });
    else if (type === 'marker') store.updateMarker(planetId, id, { name });
    else if (type === 'route') store.updateRoute(planetId, id, { name });
    else if (type === 'text') store.updateTextLabel(planetId, id, { text: name });
    emit('dirty', true);
    renderer.requestRender();
  }

  // 删除对象（走 undo store + 清选中）
  function deleteObject({ type, id }) {
    if (!confirm('确定删除该对象吗？')) return;
    const planetId = props.planet.id;
    if (type === 'terrain') {
      store.removeTerrainPolygon(planetId, id);
      if (selectedProvince.value?.id === id) selectedProvince.value = null;
    } else if (type === 'marker') {
      store.removeMarker(planetId, id);
      if (selectedMarker.value?.id === id) selectedMarker.value = null;
    } else if (type === 'route') {
      store.removeRoute(planetId, id);
      if (selectedRoute.value?.id === id) selectedRoute.value = null;
    } else if (type === 'text') {
      store.removeTextLabel(planetId, id);
      if (selectedTextLabel.value?.id === id) selectedTextLabel.value = null;
    }
    emit('dirty', true);
    renderer.requestRender();
  }

  return { focusObject, renameObject, deleteObject };
}
