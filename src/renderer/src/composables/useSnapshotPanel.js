// src/renderer/src/composables/useSnapshotPanel.js
// 版本快照面板：拍摄/恢复/删除快照

import { ref, computed } from 'vue';

export function useSnapshotPanel({ store, props, emit, renderer, currentMapData }) {
  const snapshotPanelOpen = ref(false);
  const mapSnapshots = computed(() => currentMapData.value?.snapshots || []);
  const saveStatus = ref('');
  let saveStatusTimer = null;

  function takeSnapshot(name) {
    const snap = store.addMapSnapshot(props.planet.id, name || '');
    if (snap) {
      emit('dirty', true);
      renderer.requestRender();
      saveStatus.value = `✓ 已拍摄快照「${snap.name}」`;
      if (saveStatusTimer) clearTimeout(saveStatusTimer);
      saveStatusTimer = setTimeout(() => { saveStatus.value = ''; }, 2500);
    }
  }

  function restoreSnapshot(snap) {
    if (!confirm(`确定恢复快照「${snap.name}」？\n当前地图内容将被快照替换（可撤销）。`)) return;
    store.restoreMapSnapshot(props.planet.id, snap.id);
    emit('dirty', true);
    renderer.requestRender();
    saveStatus.value = `✓ 已恢复快照「${snap.name}」`;
    if (saveStatusTimer) clearTimeout(saveStatusTimer);
    saveStatusTimer = setTimeout(() => { saveStatus.value = ''; }, 2500);
  }

  function removeSnapshot(snap) {
    if (!confirm(`删除快照「${snap.name}」？`)) return;
    store.removeMapSnapshot(props.planet.id, snap.id);
    emit('dirty', true);
    renderer.requestRender();
  }

  function clearSaveStatusTimer() {
    if (saveStatusTimer) clearTimeout(saveStatusTimer);
  }

  return {
    snapshotPanelOpen,
    mapSnapshots,
    saveStatus,
    saveStatusTimer,
    takeSnapshot,
    restoreSnapshot,
    removeSnapshot,
    clearSaveStatusTimer,
  };
}
