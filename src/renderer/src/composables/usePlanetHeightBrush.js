/**
 * usePlanetHeightBrush.js — PlanetMap 高度图笔刷 composable
 * 
 * 提供高度笔刷（抬高/降低/平滑）、生物群系笔刷。
 * 接线模式遵循 PlanetMap 既有 composable 工厂模式。
 */

import { ref } from 'vue';
import { useGeodataStore } from '../store/geodata';
import { deriveLayers, brushFalloff } from '../utils/heightMath';

export function usePlanetHeightBrush({ store, renderer, currentMapData }) {
  const brushRadius = ref(80);
  const brushStrength = ref(3);
  const brushBiome = ref('grassland');
  const isBrushing = ref(false);
  const brushPreview = ref(null); // { x, y, radius }
  const brushMode = ref('raise'); // 'raise' | 'lower' | 'smooth' | 'biome'

  const BIOME_KEY_INDEX = {
    ocean: 0, hot_desert: 1, cold_desert: 2, savanna: 3, grassland: 4,
    tropical_seasonal: 5, temperate_deciduous: 6, tropical_rainforest: 7,
    temperate_rainforest: 8, taiga: 9, tundra: 10, glacier: 11, wetland: 12,
  };

  function ensureHeightmap() {
    const planetId = currentMapData.value?.planetId;
    if (!planetId || !store.mapData[planetId]) return null;
    const md = store.mapData[planetId];
    if (!md.heightmap) {
      // 初始化高度图（从 terrain 生成或默认）
      md.heightmap = createDefaultHeightmap(md.terrain || []);
    }
    return md.heightmap;
  }

  function createDefaultHeightmap(terrain) {
    const spacing = 14.4;
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
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1000; maxY = 1000; }
    const pad = spacing * 2;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const colsX = Math.ceil((maxX - minX) / spacing) + 1;
    const colsY = Math.ceil((maxY - minY) / spacing) + 1;
    const count = colsX * colsY;
    const h = new Float32Array(count);
    const points = [];
    for (let j = 0; j < colsY; j++) {
      for (let i = 0; i < colsX; i++) {
        const idx = j * colsX + i;
        points.push([minX + i * spacing, minY + j * spacing]);
        h[idx] = 20;
      }
    }
    // 从 terrain 填充
    for (let i = 0; i < points.length; i++) {
      const [px, py] = points[i];
      for (const poly of terrain) {
        if (!poly.points || poly.points.length < 3) continue;
        if (isPointInPolygon(px, py, poly.points)) {
          const elevMap = { '深海': 5, '浅海': 15, '平原': 30, '丘陵': 50, '高原': 70, '山地': 85, '高山': 95 };
          h[i] = elevMap[poly.elevation] ?? 30;
          break;
        }
      }
    }
    const derived = deriveLayers(h, points, null, null);
    return { h, temp: derived.temperature, prec: derived.precipitation, biome: derived.biome, grid: { points, spacing, cellsX: colsX, cellsY: colsY, count } };
  }

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

  function applyHeightBrush(planetId, worldX, worldY) {
    const heightmap = ensureHeightmap();
    if (!heightmap) return;
    const pts = heightmap.grid.points;
    const spacing = heightmap.grid.spacing || 14.4;
    const radius = brushRadius.value;
    const strength = brushStrength.value;
    const mode = brushMode.value;

    // 空间索引优化
    const cellSize = spacing * 2;
    let minX = Infinity, minY = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
      const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
      if (px < minX) minX = px;
      if (py < minY) minY = py;
    }
    const cellMap = new Map();
    for (let i = 0; i < pts.length; i++) {
      const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
      const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
      const cxi = Math.floor((px - minX) / cellSize);
      const cyi = Math.floor((py - minY) / cellSize);
      const key = `${cxi},${cyi}`;
      if (!cellMap.has(key)) cellMap.set(key, []);
      cellMap.get(key).push(i);
    }

    const minCx = Math.floor((worldX - radius - minX) / cellSize);
    const maxCx = Math.floor((worldX + radius - minX) / cellSize);
    const minCy = Math.floor((worldY - radius - minY) / cellSize);
    const maxCy = Math.floor((worldY + radius - minY) / cellSize);

    const newH = new Float32Array(heightmap.h);
    for (let ci = minCx; ci <= maxCx; ci++) {
      for (let cj = minCy; cj <= maxCy; cj++) {
        const cell = cellMap.get(`${ci},${cj}`);
        if (!cell) continue;
        for (const i of cell) {
          const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
          const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
          const dx = px - worldX;
          const dy = py - worldY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist >= radius) continue;
          const falloff = brushFalloff(radius, dist);
          const delta = strength * falloff;
          if (mode === 'raise') {
            newH[i] = Math.min(100, newH[i] + delta);
          } else if (mode === 'lower') {
            newH[i] = Math.max(0, newH[i] - delta);
          } else if (mode === 'smooth') {
            let sum = 0, count = 0;
            for (let j = 0; j < pts.length; j++) {
              const qx = Array.isArray(pts[j]) ? pts[j][0] : pts[j].x;
              const qy = Array.isArray(pts[j]) ? pts[j][1] : pts[j].y;
              const ddx = qx - px, ddy = qy - py;
              if (Math.abs(ddx) < spacing * 1.5 && Math.abs(ddy) < spacing * 1.5) {
                sum += heightmap.h[j]; count++;
              }
            }
            newH[i] = count > 0 ? sum / count : newH[i];
          }
        }
      }
    }

    const derived = deriveLayers(newH, pts, null, null);
    const oldH = heightmap.h;
    const oldTemp = heightmap.temp;
    const oldPrec = heightmap.prec;
    const oldBiome = heightmap.biome;

    store.execute({
      type: 'height-brush',
      label: mode === 'raise' ? '抬高地形' : mode === 'lower' ? '降低地形' : '平滑地形',
      undo: () => {
        heightmap.h = oldH;
        heightmap.temp = oldTemp;
        heightmap.prec = oldPrec;
        heightmap.biome = oldBiome;
      },
      redo: () => {
        heightmap.h = newH;
        heightmap.temp = derived.temperature;
        heightmap.prec = derived.precipitation;
        heightmap.biome = derived.biome;
      },
    });

    store.scheduleAutoSaveMap(planetId);
  }

  function applyBiomeBrush(planetId, worldX, worldY) {
    const heightmap = ensureHeightmap();
    if (!heightmap) return;
    const pts = heightmap.grid.points;
    const spacing = heightmap.grid.spacing || 14.4;
    const radius = brushRadius.value;
    const idx = BIOME_KEY_INDEX[brushBiome.value] ?? 0;

    const newBiome = new Uint8Array(heightmap.biome);
    for (let i = 0; i < pts.length; i++) {
      const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
      const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
      const dist = Math.hypot(px - worldX, py - worldY);
      if (dist >= radius) continue;
      const falloff = brushFalloff(radius, dist);
      if (falloff < 0.1) continue;
      newBiome[i] = idx;
    }

    const oldBiome = heightmap.biome;
    store.execute({
      type: 'biome-brush',
      label: '生物群系笔刷',
      undo: () => { heightmap.biome = oldBiome; },
      redo: () => { heightmap.biome = newBiome; },
    });
    store.scheduleAutoSaveMap(planetId);
  }

  return {
    brushRadius,
    brushStrength,
    brushBiome,
    isBrushing,
    brushPreview,
    brushMode,
    ensureHeightmap,
    applyHeightBrush,
    applyBiomeBrush,
  };
}
