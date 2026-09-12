/**
 * heightMath.js — 高度图 / 温度 / 降水 / 生物群系 计算纯函数
 * 
 * 所有函数无副作用、无响应式依赖，可被 composable 和 Worker 复用。
 * 与 SITIAN_V2_BLUEPRINT.md §3.3 的派生规则一致。
 */

export const SEA_LEVEL = 20;

// ── 温度 ──────────────────────────────────────────────
// 基于高度 + 纬度（FMG 温度范围 -40…20°C，映射到 0…100 索引）
export function temperatureAtIndex(height, latitude) {
  // 基础温度：赤道 30°C，向两极递减
  const baseTemp = 30 - Math.abs(latitude) * 0.6;
  // 高度惩罚：海拔每升 10 单位，降温 5°C
  const heightPenalty = Math.max(0, height - SEA_LEVEL) * 0.5;
  return baseTemp - heightPenalty;
}

// ── 降水 ──────────────────────────────────────────────
// 基于温度 + 海洋距离（FMG 降水标尺 0…100）
export function precipitationAtIndex(temperature, oceanDistance) {
  const basePrecip = temperature > 0 ? 60 : 20;
  // 靠近海洋降水多（距离单位：网格步数）
  const oceanBonus = Math.max(0, 50 - oceanDistance * 2);
  return Math.min(100, basePrecip + oceanBonus);
}

// ── 生物群系分类 ───────────────────────────────────────
// 基于高度 + 温度 + 降水 → 13 种生物群系 key
export function classifyBiome(height, temperature, precipitation) {
  if (height < SEA_LEVEL) return 'ocean';
  if (height > 80) return 'glacier';
  if (temperature < -10) return 'tundra';
  if (temperature < 5 && precipitation < 30) return 'cold_desert';
  if (temperature > 20 && precipitation > 70) return 'tropical_rainforest';
  if (temperature > 20 && precipitation > 40) return 'tropical_seasonal';
  if (temperature > 20 && precipitation < 25) return 'hot_desert';
  if (temperature > 10 && precipitation > 50) return 'temperate_deciduous';
  if (temperature > 10 && precipitation < 30) return 'grassland';
  if (temperature > 10 && precipitation >= 30 && precipitation <= 50) return 'savanna';
  if (temperature > 5 && precipitation < 20) return 'cold_desert';
  if (height > 60) return 'taiga';
  return 'grassland';
}

// 生物群系 key → 显示色（与 ScenarioMap.vue BIOME_COLORS 一致）
export function biomeColor(biome) {
  const map = {
    ocean: '#2E86AB',
    hot_desert: '#E9C46A',
    cold_desert: '#B5B887',
    savanna: '#D2D082',
    grassland: '#C8D68F',
    tropical_seasonal: '#B6D95D',
    temperate_deciduous: '#29BC56',
    tropical_rainforest: '#7DCB35',
    temperate_rainforest: '#409C43',
    taiga: '#4B6B32',
    tundra: '#967847',
    glacier: '#D5E7EB',
    wetland: '#0B9131',
  };
  return map[biome] || '#bccda0';
}

// ── 笔刷衰减 ───────────────────────────────────────────
// 高斯软边缘：距笔刷中心 r 的相对距离 t = r/radius → 强度系数
export function brushFalloff(radius, dist) {
  if (dist >= radius) return 0;
  const t = dist / radius;
  // 高斯衰减（σ = 0.5 使边缘柔和）
  return Math.exp(-(t * t) / (2 * 0.5 * 0.5));
}

// ── 高度图重算 ─────────────────────────────────────────
// 给定全量高度图 + 纬度/海洋距离，返回派生图层
export function deriveLayers(heightmap, gridPoints, latitudeFn, oceanDistFn) {
  const n = heightmap.length;
  const temp = new Float32Array(n);
  const prec = new Float32Array(n);
  const biome = new Uint8Array(n);
  const BIOME_OCEAN = 0;
  
  for (let i = 0; i < n; i++) {
    const h = heightmap[i];
    const lat = latitudeFn ? latitudeFn(gridPoints[i], i) : 0;
    const ocean = oceanDistFn ? oceanDistFn(gridPoints[i], i) : 100;
    const t = temperatureAtIndex(h, lat);
    const p = precipitationAtIndex(t, ocean);
    temp[i] = t;
    prec[i] = p;
    biome[i] = h < SEA_LEVEL ? BIOME_OCEAN : biomeIndex(h, t, p);
  }
  
  return { temperature: temp, precipitation: prec, biome };
}

// 生物群系 key → Uint8 编码（用于 TypedArray）
const BIOME_KEYS = [
  'ocean', 'hot_desert', 'cold_desert', 'savanna', 'grassland',
  'tropical_seasonal', 'temperate_deciduous', 'tropical_rainforest',
  'temperate_rainforest', 'taiga', 'tundra', 'glacier', 'wetland',
];

export function biomeIndex(height, temperature, precipitation) {
  const key = classifyBiome(height, temperature, precipitation);
  const idx = BIOME_KEYS.indexOf(key);
  return idx >= 0 ? idx : 0;
}

export function biomeKeyFromIndex(idx) {
  return BIOME_KEYS[idx] || 'ocean';
}

// ── 平滑滤波 ───────────────────────────────────────────
// 3x3 均值平滑（用于"双击平滑"操作）
export function smoothHeightmap(heightmap, grid, radius = 1) {
  const pts = grid.points;
  const n = heightmap.length;
  const out = new Float32Array(n);
  const spacing = grid.spacing || 14.4;
  const cellR = Math.ceil(radius);
  
  for (let i = 0; i < n; i++) {
    const [cx, cy] = pts[i];
    let sum = 0, count = 0;
    for (let j = 0; j < n; j++) {
      const [px, py] = pts[j];
      const dx = px - cx, dy = py - cy;
      if (Math.abs(dx) < spacing * cellR && Math.abs(dy) < spacing * cellR) {
        sum += heightmap[j];
        count++;
      }
    }
    out[i] = count > 0 ? sum / count : heightmap[i];
  }
  return out;
}

// ── 河流生成 ───────────────────────────────────────────
// 沿高度梯度从高向低追踪（简化版：每个 >60 高度点找最低邻居流向海洋）
export function generateRivers(heightmap, grid) {
  const pts = grid.points;
  const n = heightmap.length;
  const rivers = [];
  const visited = new Set();
  
  // 找到所有高地起点（高度 > 60）
  const sources = [];
  for (let i = 0; i < n; i++) {
    if (heightmap[i] > 60) sources.push(i);
  }
  
  for (const src of sources) {
    if (visited.has(src)) continue;
    const river = [src];
    let current = src;
    let steps = 0;
    while (heightmap[current] >= SEA_LEVEL && steps < 200) {
      visited.add(current);
      const [cx, cy] = pts[current];
      let lowest = -1, lowestH = heightmap[current];
      for (let j = 0; j < n; j++) {
        if (j === current) continue;
        const [px, py] = pts[j];
        const d = Math.hypot(px - cx, py - cy);
        if (d < (grid.spacing || 14.4) * 1.5 && heightmap[j] < lowestH) {
          lowestH = heightmap[j];
          lowest = j;
        }
      }
      if (lowest < 0) break; // 局部最低点
      river.push(lowest);
      current = lowest;
      steps++;
    }
    if (river.length > 3) rivers.push(river);
  }
  
  return rivers;
}
