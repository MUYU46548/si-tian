// src/renderer/src/composables/useProvinceSplitMerge.js
// 省份拆分/合并状态管理

import { ref } from 'vue';
import { splitPolygon, mergePolygons } from '../utils/geometry';

export function useProvinceSplitMerge({ store, props, emit, renderer, currentMapData, exportStatus }) {
  const splitSelectMode = ref(false);
  const splitPoints = ref([]);
  const mergeSelectMode = ref(false);
  const mergeTargetId = ref(null);

  function startSplitMode(selectedProvince) {
    if (!selectedProvince.value) return;
    splitSelectMode.value = !splitSelectMode.value;
    mergeSelectMode.value = false;
    splitPoints.value = [];
    if (splitSelectMode.value) {
      exportStatus.value = '拆分模式：点击省份内两点画切割线（Esc 取消）';
    } else {
      exportStatus.value = '';
    }
    renderer.requestRender();
  }

  function startMergeMode(selectedProvince) {
    if (!selectedProvince.value) return;
    mergeSelectMode.value = !mergeSelectMode.value;
    splitSelectMode.value = false;
    splitPoints.value = [];
    if (mergeSelectMode.value) {
      mergeTargetId.value = selectedProvince.value.id;
      exportStatus.value = '合并模式：再点击一个要合并的省份（Esc 取消）';
    } else {
      mergeTargetId.value = null;
      exportStatus.value = '';
    }
    renderer.requestRender();
  }

  function performSplit(pA, pB, selectedProvince) {
    const poly = selectedProvince.value;
    splitSelectMode.value = false;
    splitPoints.value = [];
    if (!poly || !poly.points || poly.points.length < 4) return;
    const result = splitPolygon(poly.points, pA, pB);
    if (!result) {
      exportStatus.value = '拆分失败：切割线需穿过省份边界（两点在多边形两侧）';
      setTimeout(() => { exportStatus.value = ''; }, 3500);
      renderer.requestRender();
      return;
    }
    const [pa, pb] = result;
    const base = poly.name || '省份';
    const mkId = () => `poly_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const newA = { ...poly, id: mkId(), points: pa, controlPoints: null, name: `${base} 1` };
    const newB = { ...poly, id: mkId(), points: pb, controlPoints: null, name: `${base} 2` };
    store.splitTerrainPolygon(props.planet.id, poly.id, newA, newB);
    selectedProvince.value = null;
    emit('dirty', true);
    renderer.requestRender();
    exportStatus.value = `已拆分「${base}」为两个省份`;
    setTimeout(() => { exportStatus.value = ''; }, 3000);
  }

  function performMerge(idA, idB, selectedProvince) {
    const list = currentMapData.value?.terrain || [];
    const polyA = list.find(t => t.id === idA);
    const polyB = list.find(t => t.id === idB);
    mergeSelectMode.value = false;
    mergeTargetId.value = null;
    if (!polyA || !polyB) return;
    const merged = mergePolygons(polyA.points, polyB.points);
    if (!merged) {
      exportStatus.value = '合并失败：多边形无效';
      setTimeout(() => { exportStatus.value = ''; }, 3500);
      renderer.requestRender();
      return;
    }
    const mergedNameRaw = `${polyA.name || '省份'} + ${polyB.name || '省份'}`;
    // 多次合并会让名字疯长（"陆地 1 2 + 陆地 1 1 1 + ..."），超过 20 字符截断
    const mergedName = mergedNameRaw.length > 20 ? mergedNameRaw.slice(0, 20) + '…' : mergedNameRaw;
    const newPoly = {
      ...polyA,
      id: `poly_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      points: merged,
      controlPoints: null,
      name: mergedName,
    };
    store.mergeTerrainPolygons(props.planet.id, idA, idB, newPoly);
    selectedProvince.value = newPoly;
    emit('dirty', true);
    renderer.requestRender();
    exportStatus.value = '已合并省份';
    setTimeout(() => { exportStatus.value = ''; }, 3000);
  }

  function clearSplitMerge() {
    splitSelectMode.value = false;
    splitPoints.value = [];
    mergeSelectMode.value = false;
    mergeTargetId.value = null;
  }

  return {
    splitSelectMode,
    splitPoints,
    mergeSelectMode,
    mergeTargetId,
    startSplitMode,
    startMergeMode,
    performSplit,
    performMerge,
    clearSplitMerge,
  };
}
