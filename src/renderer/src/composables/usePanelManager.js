// src/renderer/src/composables/usePanelManager.js
// 面板管理：本地面板单开互斥 + 与 App 层浮层互斥

import { watch } from 'vue';

export function usePanelManager({ panelsStore, clusterEditor, objectPanelOpen, snapshotPanelOpen, referenceImage, renderer }) {
  // 本地四个面板单开互斥 + 与 App 层浮层互斥
  function openPlanetPanel(panelName) {
    const alreadyOpen =
      (panelName === 'cluster' && clusterEditor.clusterPanelOpen) ||
      (panelName === 'object' && objectPanelOpen.value) ||
      (panelName === 'snapshot' && snapshotPanelOpen.value) ||
      (panelName === 'refimage' && referenceImage.showRefImagePanel);
    // 通知 App 层关闭导出/书签/图层面板
    window.dispatchEvent(new CustomEvent('sitian:panel-open'));
    clusterEditor.clusterPanelOpen = panelName === 'cluster' && !alreadyOpen;
    objectPanelOpen.value = panelName === 'object' && !alreadyOpen;
    snapshotPanelOpen.value = panelName === 'snapshot' && !alreadyOpen;
    referenceImage.showRefImagePanel = panelName === 'refimage' && !alreadyOpen;
    renderer.requestRender();
  }

  // App 层打开其他浮层（export/bookmarks/layers）时，关闭本地面板
  watch(() => panelsStore.openPanelId, (id) => {
    if (id !== null && !['planet-cluster', 'planet-object', 'planet-snapshot', 'planet-refimage'].includes(id)) {
      clusterEditor.clusterPanelOpen = false;
      objectPanelOpen.value = false;
      snapshotPanelOpen.value = false;
      referenceImage.showRefImagePanel = false;
    }
  });

  return { openPlanetPanel };
}
