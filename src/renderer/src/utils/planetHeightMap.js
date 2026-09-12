/**
 * planetHeightMap.js — PlanetMap 高度图生成与操作
 * 
 * 从 terrain 多边形生成初始高度图，提供高度图 CRUD 操作。
 * 与 ScenarioMap 的 heightMath.js 共享派生函数。
 */

import { deriveLayers, classifyBiome, biomeIndex, SEA_LEVEL } from './heightMath';

/**
 * 从 terrain 多边形生成初始高度图
 * 算法：对每个网格点，找包含它的多边形，用多边形的 elevation 字段插值
 * 无多边形覆盖的点用默认值 20（海平面）
 */
export function generateHeightmapFromTerrain(terrain, bounds, spacing) {
  const { minX, minY, maxX, maxY } = bounds;
  const colsX = Math.ceil((maxX - minX) / spacing) + 1;
  const colsY = Math.ceil((maxY - minY) / spacing) + 1;
  const count = colsX * colsY;
  
  const h = new Float32Array(count);
  const points = [];
  
  // 生成网格点
  for (let j = 0; j < colsY; j++) {
    for (let i = 0; i < colsX; i++) {
      const idx = j * colsX + i;
      points.push([minX + i * spacing, minY + j * spacing]);
      h[idx] = 20; // 默认海平面
    }
  }
  
  // 从 terrain 多边形填充高度
  if (terrain && terrain.length) {
    for (let i = 0; i < points.length; i++) {
      const [px, py] = points[i];
      for (const poly of terrain) {
        if (!poly.points || poly.points.length < 3) continue;
        if (isPointInPolygon(px, py, poly.points)) {
          // 根据 elevation 字段设置高度
          const elevMap = {
            '深海': 5, '浅海': 15, '平原': 30, '丘陵': 50,
            '高原': 70, '山地': 85, '高山': 95
          };
          h[i] = elevMap[poly.elevation] ?? 30;
          break;
        }
      }
    }
  }
  
  // 派生温度/降水/生物群系
  const derived = deriveLayers(h, points, null, null);
  
  return {
    h,
    temp: derived.temperature,
    prec: derived.precipitation,
    biome: derived.biome,
    grid: {
      points,
      spacing,
      cellsX: colsX,
      cellsY: colsY,
      count
    }
  };
}

/**
 * 计算 terrain 多边形的包围盒
 */
export function computeTerrainBounds(terrain, padding = 50) {
  if (!terrain || !terrain.length) {
    return { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of terrain) {
    if (!poly.points) continue;
    for (const p of poly.points) {
      const px = p.x || p[0] || 0;
      const py = p.y || p[1] || 0;
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
  return { minX: minX - padding, minY: minY - padding, maxX: maxX + padding, maxY: maxY + padding };
}

/**
 * 判断点是否在多边形内（射线法）
 */
function isPointInPolygon(px, py, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x || points[i][0];
    const yi = points[i].y || points[i][1];
    const xj = points[j].x || points[j][0];
    const yj = points[j].y || points[j][1];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * 获取指定世界坐标处的高度
 */
export function getHeightAt(heightmap, worldX, worldY) {
  const pts = heightmap.grid.points;
  const spacing = heightmap.grid.spacing || 14.4;
  let bestI = -1;
  let bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
    const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
    const d = Math.hypot(px - worldX, py - worldY);
    if (d < bestD) { bestD = d; bestI = i; }
  }
  if (bestI < 0 || bestD > spacing) return null;
  return {
    h: heightmap.h[bestI],
    temp: heightmap.temp?.[bestI],
    prec: heightmap.prec?.[bestI],
    biome: heightmap.biome?.[bestI],
  };
}

/**
 * 获取指定世界坐标处的最近网格点索引
 */
export function getNearestGridIndex(heightmap, worldX, worldY) {
  const pts = heightmap.grid.points;
  const spacing = heightmap.grid.spacing || 14.4;
  let bestI = -1;
  let bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
    const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
    const d = Math.hypot(px - worldX, py - worldY);
    if (d < bestD) { bestD = d; bestI = i; }
  }
  if (bestI < 0 || bestD > spacing * 1.5) return null;
  return bestI;
}

export { classifyBiome, biomeIndex, SEA_LEVEL };
