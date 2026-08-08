import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

/**
 * 图层可见性管理 store
 * 每个视图（domain/system/planet）有独立的图层栈
 */
export const useLayersStore = defineStore('layers', () => {
  // 图层定义：视图 -> 图层ID -> { visible, label, order }
  const layers = ref({
    domain: {
      background: { visible: true, label: '势力边界', order: 0 },
      nodes: { visible: true, label: '恒星', order: 1 },
      hyperlanes: { visible: true, label: '航道', order: 2 },
      editHelpers: { visible: true, label: '编辑辅助', order: 3 },
    },
    system: {
      orbits: { visible: true, label: '轨道', order: 0 },
      nodes: { visible: true, label: '节点', order: 1 },
      hyperlanes: { visible: true, label: '航道', order: 2 },
      editHelpers: { visible: true, label: '编辑辅助', order: 3 },
    },
    planet: {
      terrain: { visible: true, label: '地形', order: 0 },
      regions: { visible: true, label: '区域', order: 1 },
      markers: { visible: true, label: '标记', order: 2 },
      places: { visible: true, label: '地点', order: 3 },
      editHelpers: { visible: true, label: '编辑辅助', order: 4 },
    },
  });

  // 面板是否展开
  const panelOpen = ref(false);

  // 切换图层可见性
  function toggleLayer(view, layerId) {
    const v = layers.value[view];
    if (v && v[layerId]) {
      v[layerId].visible = !v[layerId].visible;
    }
  }

  // 检查图层是否可见
  function isVisible(view, layerId) {
    return layers.value[view]?.[layerId]?.visible ?? false;
  }

  // 获取视图的图层列表（按 order 排序）
  function getViewLayers(view) {
    const v = layers.value[view];
    if (!v) return [];
    return Object.entries(v)
      .map(([id, cfg]) => ({ id, ...cfg }))
      .sort((a, b) => a.order - b.order);
  }

  // 切换面板
  function togglePanel() {
    panelOpen.value = !panelOpen.value;
  }

  return {
    layers,
    panelOpen,
    toggleLayer,
    isVisible,
    getViewLayers,
    togglePanel,
  };
});
