// src/renderer/src/composables/useAutoRegions.js
// 自动区域生成：基于 region 节点的子地点凸包

import { ref, computed } from 'vue';
import { convexHull, expandPolygon, pointInPolygon as geoPointInPolygon } from '../utils/geometry';

export function useAutoRegions({ store, props, emit, renderer, currentMapData }) {
  const autoRegions = ref([]);
  const autoRegionsGenerated = ref(false);

  // 迷雾：仅在地图完全未绘制（无地形且无区域）且非编辑模式时显示
  const fogMode = computed(() => {
    if (!currentMapData.value) return false;
    const hasContent = (currentMapData.value.terrain?.length > 0) || (currentMapData.value.regions?.length > 0);
    return !hasContent;
  });

  // 为当前行星生成初始区域多边形（基于 region 节点的子地点凸包）
  function generateAutoRegions() {
    if (!props.planet || autoRegionsGenerated.value) return;
    autoRegionsGenerated.value = true;

    const planetId = props.planet.id;
    // 该行星的 region 节点
    const planetRegions = store.nodes.filter(n => n.layer === 'region' && n.parentId === planetId);
    if (planetRegions.length === 0) return;

    const planetPlaces = store.nodes.filter(p => ['location', 'city', 'town', 'village', 'facility'].includes(p.layer) && p.parentId === planetId);
    const newRegions = [];

    planetRegions.forEach(region => {
      // 通过 tags 匹配该区域下的地点
      const members = planetPlaces.filter(p => (p.tags || []).includes(region.name));
      const points = members
        .map(m => ({ x: m.coordinate?.x, y: m.coordinate?.y }))
        .filter(p => p.x !== null && p.x !== undefined);

      if (points.length >= 3) {
        const hull = convexHull(points);
        const expanded = expandPolygon(hull, 60);
        newRegions.push({
          id: `auto_region_${region.id}`,
          name: region.name,
          points: expanded,
          color: '#FF6B6B',
          type: 'region',
          auto: true,
          regionNodeId: region.id,
          members: members.map(m => m.id),
        });
      } else if (region.coordinate?.x !== null && region.coordinate?.x !== undefined) {
        // 地点不足时，用 region 节点自身坐标生成一个圆
        const cx = region.coordinate.x;
        const cy = region.coordinate.y;
        const circle = [];
        for (let i = 0; i < 12; i++) {
          const angle = (i / 12) * Math.PI * 2;
          circle.push({ x: cx + Math.cos(angle) * 120, y: cy + Math.sin(angle) * 120 });
        }
        newRegions.push({
          id: `auto_region_${region.id}`,
          name: region.name,
          points: circle,
          color: '#FF6B6B',
          type: 'region',
          auto: true,
          regionNodeId: region.id,
          members: members.map(m => m.id),
        });
      }
    });

    autoRegions.value = newRegions;
  }

  // 采用自动生成的区域为正式区域
  function adoptAutoRegions() {
    if (autoRegions.value.length === 0) return;
    if (!confirm(`将把 ${autoRegions.value.length} 个自动生成的区域边界转为正式区域？\n\n转换后可继续编辑边界、改色、删除。`)) return;

    autoRegions.value.forEach(auto => {
      const { auto: _a, regionNodeId, ...regionData } = auto;
      store.addRegion(props.planet.id, {
        ...regionData,
        id: `region_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: auto.name,
        type: 'region',
        auto: false,
      });
    });
    autoRegions.value = [];
    emit('dirty', true);
  }

  // 重新生成自动区域
  function regenerateAutoRegions() {
    autoRegionsGenerated.value = false;
    autoRegions.value = [];
    generateAutoRegions();
    renderer.requestRender();
  }

  // 地点归属区域
  const placeRegionMap = computed(() => {
    const map = new Map();
    if (!props.planet) return map;

    const regionPolys = [
      ...(currentMapData.value?.regions || []),
      ...autoRegions.value,
    ].filter(r => r.points && r.points.length >= 3);

    // 预计算各区域包围盒
    const polysWithBBox = regionPolys.map(r => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of r.points) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      return { poly: r, minX, minY, maxX, maxY };
    });

    const places = store.nodes.filter(p => ['location', 'city', 'town', 'village', 'facility'].includes(p.layer) && p.parentId === props.planet.id);
    for (const place of places) {
      const x = place.coordinate?.x;
      const y = place.coordinate?.y;
      if (x === null || x === undefined) continue;
      for (const { poly, minX, minY, maxX, maxY } of polysWithBBox) {
        if (x < minX || x > maxX || y < minY || y > maxY) continue;
        if (geoPointInPolygon(x, y, poly.points)) {
          map.set(place.id, poly);
          break;
        }
      }
    }
    return map;
  });

  return {
    autoRegions,
    autoRegionsGenerated,
    fogMode,
    placeRegionMap,
    generateAutoRegions,
    adoptAutoRegions,
    regenerateAutoRegions,
  };
}
