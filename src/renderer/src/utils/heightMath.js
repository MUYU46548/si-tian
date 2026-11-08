/**
 * heightMath.js — 高度图 / 温度 / 降水 / 生物群系 计算纯函数
 * 
 * 所有函数无副作用、无响应式依赖，可被 composable 和 Worker 复用。
 * 与 SITIAN_V2_BLUEPRINT.md §3.3 的派生规则一致。
 */

export const SEA_LEVEL = 20;

// ── 温度 ──────────────────────────────────────────────
// 2026-11-08 重做（卡「气候模型没有干旱轴」）：旧口径 `30 - |lat|·0.6` 是线性，
//   27° 纬度只有 13.8℃ —— 现实里副热带年均 20–24℃，于是"又热又干"的格子在生成地形里
//   **一格都不存在**（hot_desert / savanna / 盐湖全部结构性不可达）。
//   现在改成**现实地球的纬向年均温表**（分段线性插值；抄的是实测曲线，不是拍脑袋的斜率）：
//     | 纬度   |  0  | 10  | 20  | 30   | 40 | 50  | 60  | 70  | 80   | 90   |
//     | 年均℃ |26.5 | 26  |24.5 |20.5  |14  | 8.5 | 1.5 | -8  | -17  | -25  |
//   高度惩罚不变（每升 1 个高度单位降 0.5℃；山高 55 单位 ≈ 降 27℃，与旧口径一致）。
export const LATITUDE_TEMP_TABLE = Object.freeze([
  [0, 26.5], [10, 26], [20, 24.5], [30, 20.5], [40, 14],
  [50, 8.5], [60, 1.5], [70, -8], [80, -17], [90, -25],
]);

/** 纬度 → 海平面处的年均温（℃）。表外按端点取值，不抛错。 */
export function baseTemperatureAtLatitude(latitude) {
  const l = Math.min(90, Math.abs(Number(latitude) || 0));
  const T = LATITUDE_TEMP_TABLE;
  for (let i = 0; i + 1 < T.length; i++) {
    const l0 = T[i][0], t0 = T[i][1], l1 = T[i + 1][0], t1 = T[i + 1][1];
    if (l <= l1) return t0 + (t1 - t0) * ((l - l0) / (l1 - l0));
  }
  return T[T.length - 1][1];
}

export function temperatureAtIndex(height, latitude) {
  // 基础温度：按纬度查表（赤道 26.5℃，两极 -25℃）
  const baseTemp = baseTemperatureAtLatitude(latitude);
  // 高度惩罚：海拔每升 1 个高度单位，降温 0.5℃
  const heightPenalty = Math.max(0, height - SEA_LEVEL) * 0.5;
  return baseTemp - heightPenalty;
}

// ── 降水 ──────────────────────────────────────────────
// 2026-11-08 重做（同一张卡）：旧口径只有"暖 60 / 冷 20 + 近海加分"，
//   暖区**最低也有 60** —— 判盐湖要 <40、热荒漠要 <25，暖区一个都够不着。
//   现在按现实的三圈环流补三条**纬度带**（其余部分保持原样，改动面最小）：
//     · 副热带高压带（≈20–35°）：下沉气流 → 沙漠带，最干；
//     · 赤道辐合带（≈0–13°）：上升气流 → 雨林带，最湿；
//     · 极地（≈75°）：冷 + 干（冷海水蒸发少），但冷区本来就由温度主导。
//   单位仍是 FMG 的 0…100 标尺，`lakes.js` 的门槛（<40）继续有效。
export const ARIDITY_BANDS = Object.freeze({
  subtropicalDrop: 0.66, subtropicalCenter: 27, subtropicalWidth: 10,
  polarDrop: 0.28, polarCenter: 75, polarWidth: 16,
  equatorialBoost: 0.12, equatorialWidth: 13,
  floor: 0.22, cap: 1.1,
});

/** 纬度 → 干湿因子（1 = 湿带、≈0.34 = 副热带沙漠带、极地下限 0.22） */
export function aridityFactorAtLatitude(latitude) {
  const l = Math.abs(Number(latitude) || 0);
  const B = ARIDITY_BANDS;
  const subtropical = Math.exp(-Math.pow((l - B.subtropicalCenter) / B.subtropicalWidth, 2));
  const polar = Math.exp(-Math.pow((l - B.polarCenter) / B.polarWidth, 2));
  const equatorial = Math.exp(-Math.pow(l / B.equatorialWidth, 2));
  const f = 1 - B.subtropicalDrop * subtropical - B.polarDrop * polar + B.equatorialBoost * equatorial;
  return Math.max(B.floor, Math.min(B.cap, f));
}

export function precipitationAtIndex(temperature, oceanDistance, latitude = 0) {
  const basePrecip = temperature > 0 ? 60 : 20;
  // 靠近海洋降水多（距离单位：网格步数）
  const oceanBonus = Math.max(0, 50 - oceanDistance * 2);
  // 纬度干旱轴：同一条海岸线上，27° 比赤道干一半以上（现实：撒哈拉 vs 亚马逊）
  const wet = (basePrecip + oceanBonus) * aridityFactorAtLatitude(latitude);
  return Math.max(0, Math.min(100, wet));
}

// ── 气候输入（P0-3，2026-10-25）─────────────────────────
// 🔴 为什么必须有它：`deriveLayers(h, pts, null, null)` 把纬度与离岸距离都当成 0/100 ——
//    温度只剩"赤道 30°C − 海拔惩罚"、降水只剩底噪，**群系于是只由高度决定**
//    （热带雨林与寒带针叶林会出现在同一个纬度上）。这不是参数不全，是气候层没有地理意义。
//    这里把两样补齐：纬度按网格行号线性给（北为上），离岸距离用**格数**的 BFS 距离。
//    两者都是网格的确定性函数 → 同高度图重复派生结果一致（P0-3 验收项）。
export const DEFAULT_LATITUDE_SPAN_DEG = 120;

/**
 * 网格 → 气候输入。
 * @param {number[]|Float32Array} heightmap
 * @param {{points:Array<[number,number]>, cellsX:number, cellsY:number}} grid
 * @param {{latitudeSpanDeg?:number}} [opts] 上下两端跨越的纬度（默认 120°，即 ±60°）
 * @returns {{lat:Float32Array|null, ocean:Float32Array|null, latitudeSpanDeg:number,
 *            maxOceanCells:number, reason?:string}}
 */
export function buildClimateInputs(heightmap, grid, opts = {}) {
  const n = heightmap ? heightmap.length : 0;
  const span = Number.isFinite(opts.latitudeSpanDeg) && opts.latitudeSpanDeg > 0
    ? Number(opts.latitudeSpanDeg)
    : DEFAULT_LATITUDE_SPAN_DEG;
  if (!n || !grid || !Array.isArray(grid.points) || grid.points.length !== n) {
    return { lat: null, ocean: null, latitudeSpanDeg: span, maxOceanCells: 0, reason: 'no-grid' };
  }
  const cols = grid.cellsX | 0;
  const rows = grid.cellsY | 0;
  if (!cols || !rows || cols * rows !== n) {
    return { lat: null, ocean: null, latitudeSpanDeg: span, maxOceanCells: 0, reason: 'grid-mismatch' };
  }
  // 纬度：第 0 行 = 北端（+span/2），最后一行 = 南端（−span/2）。与画布 y 向下一致。
  const lat = new Float32Array(n);
  for (let j = 0; j < rows; j++) {
    const t = rows === 1 ? 0.5 : j / (rows - 1);
    const v = (0.5 - t) * span;
    for (let i = 0; i < cols; i++) lat[j * cols + i] = v;
  }
  const oceanInfo = buildOceanDistanceCells(heightmap, cols, rows);
  return {
    lat,
    ocean: oceanInfo.dist,
    latitudeSpanDeg: span,
    maxOceanCells: oceanInfo.max,
    ...(oceanInfo.noOcean ? { reason: 'no-ocean' } : {}),
  };
}

/** 离岸距离（格数）：海格 = 0，陆格 = 到最近海格的 8 邻域 BFS 步数；全陆图给"很远" */
function buildOceanDistanceCells(heightmap, cols, rows) {
  const n = cols * rows;
  // ⚠️ 用 -1 当"未访问"：Float32/Int32 的默认 0 会和"海格距离 0"混为一谈 ——
  //    第一版就是因此把所有陆格当成海格跳过（距离全 0 → 降水处处吃满海洋奖励）。
  const dist = new Int32Array(n).fill(-1);
  const q = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    if (heightmap[i] < SEA_LEVEL) { dist[i] = 0; q[tail++] = i; }
  }
  if (!tail) {
    // 整张图都是陆地（没有海岸）：降水不该被"海边"奖励 —— 统一按很远处理
    const out = new Float32Array(n).fill(999);
    return { dist: out, max: 999, noOcean: true };
  }
  while (head < tail) {
    const cur = q[head++];
    const cj = Math.floor(cur / cols);
    const ci = cur - cj * cols;
    const nd = dist[cur] + 1;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
        const idx = nj * cols + ni;
        if (dist[idx] >= 0) continue;
        dist[idx] = nd;
        q[tail++] = idx;
      }
    }
  }
  let max = 0;
  for (let i = 0; i < n; i++) if (dist[i] > max) max = dist[i];
  return { dist: Float32Array.from(dist), max, noOcean: false };
}

// ── 生物群系分类 ───────────────────────────────────────
// 基于高度 + 温度 + 降水 → 13 种生物群系 key
export function classifyBiome(height, temperature, precipitation) {
  if (height < SEA_LEVEL) return 'ocean';
  // 2026-11-08：冰川改成真的够得着 —— 旧规则是 `height > 80`，而生成地形的高度上限只有
  // 70 出头（`height > 80` 永远不成立），于是 `glacier` 在生成地图里**一次都没出现过**。
  // 现在按温度判：低于 -15℃ = 冰盖（极地/高纬），-15…0℃ = 苔原（寒带），0℃ 以上才谈得上森林。
  if (height > 80 || temperature < -15) return 'glacier';
  if (temperature < 0) return 'tundra';
  if (temperature < 5 && precipitation < 30) return 'cold_desert';
  if (temperature > 20 && precipitation > 70) return 'tropical_rainforest';
  if (temperature > 20 && precipitation > 40) return 'tropical_seasonal';
  if (temperature > 20 && precipitation < 25) return 'hot_desert';
  // 温带雨林（2026-11-08）：旧规则里这一档**从来不会被返回**（13 种里第二个死档）——
  //   现实里它 = 凉 + 极湿（太平洋西北、智利南部、新西兰南岛），门槛按“温度 2–20℃ 且降水 >85”给。
  //   放在 `temperate_deciduous` 之前：同样 >50 的降水，更湿的那一头才是雨林。
  if (temperature > 2 && temperature <= 20 && precipitation > 85) return 'temperate_rainforest';
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

/**
 * 湖泊工具的**平底高度**（2026-10-27，SP-1025 语义）：真实湖面是平的。
 * 权重 1（盆心）→ 18（水下 2 档），权重 0（边缘）→ 19（浅缘）；统一低于海平面 20。
 * 单一实现：行星笔刷与剧本底图笔刷都调它（`unit/test_lake_height.js`）。
 */
export function lakeHeightForWeight(weight) {
  const w = Number.isFinite(weight) ? Math.max(0, Math.min(1, weight)) : 0;
  return 18 + Math.round(1 - w);
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
    const p = precipitationAtIndex(t, ocean, lat);
    temp[i] = t;
    prec[i] = p;
    biome[i] = h < SEA_LEVEL ? BIOME_OCEAN : biomeIndex(h, t, p);
  }
  
  return { temperature: temp, precipitation: prec, biome };
}

// 生物群系 key → Uint8 编码（用于 TypedArray）；与 BIOME_KEYS 顺序严格对应
export const BIOME_KEYS = [
  'ocean', 'hot_desert', 'cold_desert', 'savanna', 'grassland',
  'tropical_seasonal', 'temperate_deciduous', 'tropical_rainforest',
  'temperate_rainforest', 'taiga', 'tundra', 'glacier', 'wetland',
];

export function biomeIndex(height, temperature, precipitation) {
  const key = classifyBiome(height, temperature, precipitation);
  const idx = BIOME_KEYS.indexOf(key);
  return idx >= 0 ? idx : 0;
}

// 生物群系 key → 编码下标（笔刷写入用）
export function biomeKeyIndex(key) {
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
