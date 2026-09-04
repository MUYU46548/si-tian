// src/renderer/src/composables/useClusterEditor.js
// 地点簇交互状态管理

import { ref } from 'vue';

const CLUSTER_COLORS = ['#FF6B6B', '#FFA500', '#FFD700', '#32CD32', '#4169E1', '#9B59B6', '#E91E63', '#00BCD4'];

export function useClusterEditor({ store, props, emit, renderer, places, interactionMode }) {
  // ===== 地点簇状态 =====
  const clusterPanelOpen = ref(false);
  const activeClusterId = ref(null);
  const hoverMemberId = ref(null);
  const clusterEditorOpen = ref(false);
  const editingCluster = ref(null);
  const editingClusterName = ref('');
  const editingClusterColor = ref('#FF6B6B');
  const clusterSelectMode = ref(false);
  const clusterBoxStart = ref(null);
  const clusterBoxEnd = ref(null);
  const clusterDraftMembers = ref([]);

  function getClusters() {
    return store.mapData[props.planet.id]?.clusters || [];
  }

  function getClusterMembers(cluster) {
    return cluster.memberIds
      .map(id => places.value.find(p => p.id === id))
      .filter(Boolean);
  }

  function enterClusterMode() {
    interactionMode.value = 'cluster';
    clusterSelectMode.value = true;
    clusterDraftMembers.value = [];
    renderer.requestRender();
  }

  // 框选结束：收集框内地点，弹出创建对话框
  function finishClusterBox(wx, wy) {
    const start = clusterBoxStart.value;
    if (!start) { clusterBoxStart.value = null; return; }
    const minX = Math.min(start.x, wx);
    const maxX = Math.max(start.x, wx);
    const minY = Math.min(start.y, wy);
    const maxY = Math.max(start.y, wy);

    const members = places.value.filter(p => {
      const x = p.coordinate?.x;
      const y = p.coordinate?.y;
      if (x === null || x === undefined) return false;
      return x >= minX && x <= maxX && y >= minY && y <= maxY;
    });

    clusterBoxStart.value = null;
    clusterBoxEnd.value = null;

    if (members.length === 0) {
      clusterSelectMode.value = false;
      interactionMode.value = 'pan';
      renderer.requestRender();
      return;
    }

    clusterDraftMembers.value = members.map(m => m.id);
    editingCluster.value = null;
    editingClusterName.value = `簇_${Date.now() % 10000}`;
    editingClusterColor.value = CLUSTER_COLORS[clusterDraftMembers.value.length % CLUSTER_COLORS.length];
    clusterEditorOpen.value = true;
    clusterSelectMode.value = false;
    renderer.requestRender();
  }

  function saveCluster() {
    const planetId = props.planet.id;
    if (editingCluster.value) {
      store.updateCluster(planetId, editingCluster.value.id, {
        name: editingClusterName.value.trim() || editingCluster.value.name,
        color: editingClusterColor.value,
      });
    } else {
      if (clusterDraftMembers.value.length === 0) return;
      const cluster = {
        id: `cluster_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: editingClusterName.value.trim() || '未命名簇',
        memberIds: [...clusterDraftMembers.value],
        color: editingClusterColor.value,
        collapsed: false,
      };
      store.addCluster(planetId, cluster);
      activeClusterId.value = cluster.id;
    }
    clusterEditorOpen.value = false;
    clusterDraftMembers.value = [];
    clusterSelectMode.value = false;
    interactionMode.value = 'pan';
    emit('dirty', true);
    renderer.requestRender();
  }

  function focusCluster(clusterId) {
    const cluster = getClusters().find(c => c.id === clusterId);
    if (!cluster) return;
    activeClusterId.value = clusterId;
    const members = getClusterMembers(cluster);
    if (members.length === 0) return;
    let cx = 0, cy = 0;
    members.forEach(m => { cx += m.coordinate.x; cy += m.coordinate.y; });
    cx /= members.length;
    cy /= members.length;
    renderer.focusOn(cx, cy, renderer.getViewTransform().scale);
    renderer.requestRender();
  }

  function toggleClusterCollapse(clusterId) {
    const cluster = getClusters().find(c => c.id === clusterId);
    if (!cluster) return;
    store.updateCluster(props.planet.id, clusterId, { collapsed: !cluster.collapsed });
    renderer.requestRender();
  }

  function openClusterEditor(clusterId) {
    const cluster = getClusters().find(c => c.id === clusterId);
    if (!cluster) return;
    editingCluster.value = cluster;
    editingClusterName.value = cluster.name;
    editingClusterColor.value = cluster.color || '#FF6B6B';
    clusterEditorOpen.value = true;
  }

  function disbandCluster(clusterId) {
    if (!confirm('确定解散该地点簇？成员地点将恢复独立（位置和属性保留）。')) return;
    store.removeCluster(props.planet.id, clusterId);
    if (activeClusterId.value === clusterId) activeClusterId.value = null;
    clusterEditorOpen.value = false;
    emit('dirty', true);
    renderer.requestRender();
  }

  function selectClusterMember(memberId) {
    const place = places.value.find(p => p.id === memberId);
    if (!place) return;
    emit('select-node', place);
    renderer.focusOn(place.coordinate.x, place.coordinate.y, renderer.getViewTransform().scale);
    renderer.requestRender();
  }

  // 在画布点击簇内成员时选中
  function handleClusterCanvasClick(wx, wy) {
    if (interactionMode.value === 'cluster' && !clusterSelectMode.value) {
      activeClusterId.value = null;
      renderer.requestRender();
    }
  }

  return {
    clusterPanelOpen,
    activeClusterId,
    hoverMemberId,
    clusterEditorOpen,
    editingCluster,
    editingClusterName,
    editingClusterColor,
    CLUSTER_COLORS,
    clusterSelectMode,
    clusterBoxStart,
    clusterBoxEnd,
    clusterDraftMembers,
    getClusters,
    getClusterMembers,
    enterClusterMode,
    finishClusterBox,
    saveCluster,
    focusCluster,
    toggleClusterCollapse,
    openClusterEditor,
    disbandCluster,
    selectClusterMember,
    handleClusterCanvasClick,
  };
}
