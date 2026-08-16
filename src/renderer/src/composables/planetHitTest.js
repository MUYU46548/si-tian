/**
 * composables/planetHitTest.js — 行星地图命中检测（批次 2c：从 PlanetMap.vue 拆分）
 *
 * 只读命中检测：createPlanetHitTest(getState) 工厂，每次命中测试取最新解包状态。
 * 依赖 geometry 的 pointInPolygon / perpendicularDistance（纯函数）。
 */
import { pointInPolygon, perpendicularDistance } from '../utils/geometry';

export function createPlanetHitTest(getState) {

function hitTest(wx, wy) {
  const s = getState();
  if (!s.layers.isEditable('planet', 'terrain') && 
      !s.layers.isEditable('planet', 'markers') && 
      !s.layers.isEditable('planet', 'places') &&
      !s.layers.isEditable('planet', 'regions')) return null;
  
  if (s.layers.isEditable('planet', 'markers')) {
    const markerHit = hitTestMarker(wx, wy);
    if (markerHit) return markerHit;
  }
  
  // 浮动文本（优先级在标记之后、区域之前）
  if (s.layers.isEditable('planet', 'textLabels') && s.currentMapData?.textLabels) {
    const textHit = hitTestTextLabel(wx, wy);
    if (textHit) return textHit;
  }
  
  // 路线（线命中）
  if (s.layers.isEditable('planet', 'routes') && s.currentMapData?.routes) {
    const routeHit = hitTestRoute(wx, wy);
    if (routeHit) return routeHit;
  }
  
  if (s.layers.isEditable('planet', 'regions') && s.currentMapData?.regions) {
    for (let i = s.currentMapData.regions.length - 1; i >= 0; i--) {
      const region = s.currentMapData.regions[i];
      if (geoPointInPolygon(wx, wy, region.points)) {
        return { type: 'region', region };
      }
    }
  }
  
  if (s.layers.isEditable('planet', 'places')) {
    for (const place of s.places) {
      const dx = wx - (place.coordinate?.x || 0);
      const dy = wy - (place.coordinate?.y || 0);
      const r = s.getNodeRadius(place.layer) + 4;
      if (dx * dx + dy * dy < r * r) return { type: 'place', node: place };
    }
  }
  
  if (s.layers.isEditable('planet', 'terrain') && s.currentMapData) {
    for (let i = s.currentMapData.terrain.length - 1; i >= 0; i--) {
      const poly = s.currentMapData.terrain[i];
      if (pointInPolygon(wx, wy, poly.points)) {
        return { type: 'province', polygon: poly };
      }
    }
  }
  
  return null;
}
function hitTestRoute(wx, wy) {
  const s = getState();
  if (!s.currentMapData?.routes) return null;
  const routes = s.currentMapData.routes;
  for (let i = routes.length - 1; i >= 0; i--) {
    const route = routes[i];
    if (!route.points || route.points.length < 2) continue;
    // 先检查端点（优先级更高）
    for (let j = 0; j < route.points.length; j++) {
      const p = route.points[j];
      const dx = wx - p.x;
      const dy = wy - p.y;
      if (dx * dx + dy * dy < 64) {
        return { type: 'route-endpoint', route, pointIndex: j };
      }
    }
    // 再检查线段
    for (let j = 0; j < route.points.length - 1; j++) {
      const a = route.points[j];
      const b = route.points[j + 1];
      const dist = perpendicularDistance({ x: wx, y: wy }, a, b);
      if (dist < 8) {
        return { type: 'route', route };
      }
    }
  }
  return null;
}
function hitTestTextLabel(wx, wy) {
  const s = getState();
  if (!s.currentMapData?.textLabels) return null;
  const labels = s.currentMapData.textLabels;
  for (let i = labels.length - 1; i >= 0; i--) {
    const label = labels[i];
    if (!label?.text) continue;
    const fontSize = label.fontSize || 16;
    const w = (label.text.length * fontSize * 0.9) / 2 + 8;
    const h = fontSize + 10;
    if (Math.abs(wx - label.x) < w && Math.abs(wy - label.y) < h / 2) {
      return { type: 'textLabel', label };
    }
  }
  return null;
}
function hitTestVertex(wx, wy) {
  const s = getState();
  // 多边形/区域顶点
  const selectedPoly = s.selectedProvince || s.selectedRegion;
  if (selectedPoly && s.editMode) {
    const points = selectedPoly.points;
    for (let i = 0; i < points.length; i++) {
      const dx = wx - points[i].x;
      const dy = wy - points[i].y;
      if (dx * dx + dy * dy < 8 * 8) {
        return { vertexIndex: i };
      }
    }
  }
  
  // 路线顶点（开放折线）
  if (s.selectedRoute && s.editMode) {
    const points = s.selectedRoute.points;
    if (points) {
      for (let i = 0; i < points.length; i++) {
        const dx = wx - points[i].x;
        const dy = wy - points[i].y;
        if (dx * dx + dy * dy < 8 * 8) {
          return { vertexIndex: i };
        }
      }
    }
  }
  
  return null;
}
function hitTestEdge(wx, wy) {
  const s = getState();
  const selectedPoly = s.selectedProvince || s.selectedRegion;
  if (!selectedPoly || !s.editMode) return null;
  
  const points = selectedPoly.points;
  const n = points.length;
  
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const dist = perpendicularDistance({ x: wx, y: wy }, a, b);
    if (dist < 8) {
      const distToA = Math.hypot(wx - a.x, wy - a.y);
      const distToB = Math.hypot(wx - b.x, wy - b.y);
      const edgeLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (distToA > 10 && distToB > 10 && edgeLen > 20) {
        return { insertIndex: i + 1 };
      }
    }
  }
  return null;
}
function hitTestMarker(wx, wy) {
  const s = getState();
  if (!s.currentMapData?.markers) return null;
  for (let i = s.currentMapData.markers.length - 1; i >= 0; i--) {
    const marker = s.currentMapData.markers[i];
    const dx = wx - marker.x;
    const dy = wy - marker.y;
    if (dx * dx + dy * dy < 64) {
      return { type: 'marker', marker };
    }
  }
  return null;
}

  return {
    hitTest,
    hitTestRoute,
    hitTestTextLabel,
    hitTestVertex,
    hitTestEdge,
    hitTestMarker,
  };
}
