import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

/**
 * 图层可见性管理 store
 * 每个视图（domain/system/planet）有独立的图层栈
 * 支持跨视图共享图层状态
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
    system_detail: {
      orbits: { visible: true, label: '轨道', order: 0 },
      nodes: { visible: true, label: '节点', order: 1 },
      hyperlanes: { visible: true, label: '邻系航道', order: 2 },
      markers: { visible: true, label: '太空标记', order: 3 },     // B6：异常/资源点/古战场/太空兽群
      fleetCards: { visible: true, label: '部队卡片', order: 4 },  // B7：太空舰队/行星军（信息卡片）
    },
    planet: {
      terrain: { visible: true, label: '地形', order: 0 },
      terrainLabels: { visible: true, label: '地形名称', order: 1 },
      regions: { visible: true, label: '区域', order: 2 },
      routes: { visible: true, label: '路线', order: 3 },
      markers: { visible: true, label: '标记', order: 4 },
      places: { visible: true, label: '聚落地点', order: 5 },
      clusters: { visible: true, label: '地点簇', order: 6 },
      textLabels: { visible: true, label: '文本', order: 7 },
      referenceImage: { visible: true, label: '参考底图', order: 8 },
      editHelpers: { visible: true, label: '编辑辅助', order: 9 },
    },
    area: {
      zones: { visible: true, label: '区域多边形', order: 0 },
      places: { visible: true, label: '地点节点', order: 1 },
      grid: { visible: true, label: '网格', order: 2 },
      editHelpers: { visible: true, label: '编辑辅助', order: 3 },
    },
    interior: {
      furniture: { visible: true, label: '家具', order: 0 },
      grid: { visible: true, label: '网格', order: 1 },
      editHelpers: { visible: true, label: '编辑辅助', order: 2 },
    },
  });

  // 是否启用跨视图共享
  const shareAcrossViews = ref(true);

  // 面板是否展开
  const panelOpen = ref(false);

  // 切换图层可见性
  function toggleLayer(view, layerId) {
    const v = layers.value[view];
    if (v && v[layerId]) {
      v[layerId].visible = !v[layerId].visible;
      
      // 跨视图共享
      if (shareAcrossViews.value) {
        syncLayerToOtherViews(view, layerId, v[layerId].visible);
      }
    }
  }

  // 同步图层状态到其他视图
  function syncLayerToOtherViews(sourceView, layerId, visible) {
    // 定义图层映射关系
    const layerMapping = {
      domain: {
        hyperlanes: [['system', 'hyperlanes'], ['system_detail', 'hyperlanes']],
        editHelpers: [['system', 'editHelpers'], ['area', 'editHelpers'], ['interior', 'editHelpers']],
      },
      system: {
        hyperlanes: [['domain', 'hyperlanes'], ['system_detail', 'hyperlanes']],
        orbits: [['system_detail', 'orbits']],
        nodes: [['system_detail', 'nodes']],
        editHelpers: [['domain', 'editHelpers'], ['area', 'editHelpers'], ['interior', 'editHelpers']],
      },
      system_detail: {
        hyperlanes: [['domain', 'hyperlanes'], ['system', 'hyperlanes']],
        orbits: [['system', 'orbits']],
        nodes: [['system', 'nodes']],
      },
      area: {
        editHelpers: [['domain', 'editHelpers'], ['system', 'editHelpers'], ['interior', 'editHelpers']],
      },
      interior: {
        editHelpers: [['domain', 'editHelpers'], ['system', 'editHelpers'], ['area', 'editHelpers']],
      },
    };

    const mappings = layerMapping[sourceView]?.[layerId];
    if (mappings) {
      for (const [targetView, targetLayerId] of mappings) {
        if (layers.value[targetView]?.[targetLayerId]) {
          layers.value[targetView][targetLayerId].visible = visible;
        }
      }
    }
  }

  // 检查图层是否可见
  function isVisible(view, layerId) {
    return layers.value[view]?.[layerId]?.visible ?? false;
  }

  // 检查图层是否锁定
  function isLocked(view, layerId) {
    return layers.value[view]?.[layerId]?.locked ?? false;
  }

  // 切换图层锁定
  function toggleLayerLock(view, layerId) {
    const v = layers.value[view];
    if (v && v[layerId]) {
      v[layerId].locked = !v[layerId].locked;
    }
  }

  // 检查图层是否可交互（可见且未锁定）
  function isEditable(view, layerId) {
    const cfg = layers.value[view]?.[layerId];
    if (!cfg) return false;
    return cfg.visible && !cfg.locked;
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

  // 切换跨视图共享
  function toggleShareAcrossViews() {
    shareAcrossViews.value = !shareAcrossViews.value;
  }

  return {
    layers,
    panelOpen,
    shareAcrossViews,
    toggleLayer,
    isVisible,
    isLocked,
    toggleLayerLock,
    isEditable,
    getViewLayers,
    togglePanel,
    toggleShareAcrossViews,
  };
});
