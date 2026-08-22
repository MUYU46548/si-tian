import { nextTick } from 'vue';
import { useGeodataStore } from '../store/geodata';

// 地点类 layer（可拖入行星地图 / 可作为区域下钻进 AreaMap）
const PLACE_LAYERS = ['location', 'city', 'town', 'village', 'facility', 'region'];

/**
 * 节点 → 对应视图的统一跳转逻辑（批次A4 抽取自 SearchBar.autoNavigateToNode，
 * 补全 star_domain/galaxy 深层下钻与 area/interior 层）。
 * SearchBar 与 TreeNavigation 共用，避免两处复制漂移。
 *
 * 层级 → 视图映射：
 *   world → domain（星域总览）；star_domain → system（星系总览）；galaxy → system_detail（单系详情）
 *   planet → planet（行星地图）；building → interior（建筑内部）
 *   地点类 → 有子节点作为区域下钻(area)，叶子地点跳所属行星地图(planet)
 */
export function useNodeNavigation() {
  const store = useGeodataStore();

  function findAncestorByLayer(node, targetLayer) {
    let current = node;
    const visited = new Set();
    while (current && current.id) {
      if (visited.has(current.id)) break;
      visited.add(current.id);
      if (current.layer === targetLayer) return current;
      current = store.nodes.find(n => n.id === current.parentId);
    }
    return null;
  }

  function navigateToNode(node) {
    const layer = node.layer;

    if (layer === 'world') {
      store.selectWorld(node);
      return;
    }

    // 先定位到所属世界，保证面包屑链完整
    const world = findAncestorByLayer(node, 'world');
    if (world) store.selectWorld(world);

    if (layer === 'star_domain') {
      store.selectDomain(node);
      return;
    }
    if (layer === 'galaxy') {
      // enterSystemDetail 自动按 parentId 补齐 currentDomain（面包屑依赖）
      store.enterSystemDetail(node);
      return;
    }

    // 行星及以下：先进入所属星域
    const domain = findAncestorByLayer(node, 'star_domain');
    if (domain) store.selectDomain(domain);

    if (layer === 'planet') {
      store.selectPlanet(node);
      return;
    }
    if (layer === 'building') {
      store.selectBuilding(node);
      return;
    }

    if (PLACE_LAYERS.includes(layer)) {
      // 有子节点的地点 → 作为区域下钻(AreaMap)；叶子地点 → 跳所属行星地图
      if (node.children && node.children.length > 0) {
        store.selectArea(node);
      } else {
        const planet = findAncestorByLayer(node, 'planet');
        if (planet) store.selectPlanet(planet);
      }
      return;
    }

    // 未知层级：尽量跳到所属行星
    const planet = findAncestorByLayer(node, 'planet');
    if (planet) store.selectPlanet(planet);
  }

  /**
   * 跳转 + 镜头聚焦 + 恢复详情面板选中。
   * select* 动作会清空 selectedNode，跳转后重新选中让面板继续显示该节点；
   * 无坐标节点只跳转不聚焦（沿用 SearchBar 约定，各视图 onFocusNode 也会静默忽略）。
   */
  function jumpToNode(node) {
    navigateToNode(node);
    store.selectNode(node);
    if (node && node.coordinate && node.coordinate.x !== null) {
      nextTick(() => window.dispatchEvent(new CustomEvent('sitian:focus-node', { detail: node })));
    }
  }

  return { findAncestorByLayer, navigateToNode, jumpToNode };
}
