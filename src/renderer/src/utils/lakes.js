// utils/lakes.js — **湖的唯一实现**（2026-11-04：从 `utils/fmg/index.js` 搬出）
//
// 为什么搬：湖现在有两处要**产出**（FMG 模板地形 `fmg/index.js` 与按轮廓推演
// `terrainSynthesis.js`），而后者不能 import 前者（`fmg/index` 已经 import 了
// `terrainSynthesis.fillDepressions` → 会成环）。判据逻辑一份、两条生成路径共用。
//
// 🔴 关键口径（2026-10-29 定，别改）：**不动高度场**。湖是 `hm.lakes` 这份
// **渲染层水面标记**（`{level, cells}`），高度仍然是"填平之后、处处可排水"的那份。
// 把湖格挖成 18/19 会在高度场上造出**没有出水口**的盆地 → 河流在湖边断头
// （本项目明令禁止的形态）。保留可排水高度 + 单独标记水面，等于"湖是水面，不是地形洞"
// —— 河照样从湖里穿过去、从出口出来（`utils/fmg/rivers.js` 按 `lakeOf` 处理）。

/**
 * 被洼地填平**抬起来**的连通块 → 湖。
 *
 * 判定：抬升量 ≥ `minDepth` 的陆格按 8 邻居聚成连通块，面积 ≥ `minArea` 的才算湖；
 * 水位取块内**最高的填充高度**（≈ 溢出口高度）。
 *
 * 🔴 为什么要 `minDepth`：priority-flood 会沿"排水通道"把整条平坦路径一格一档地抬（ε≈0.04），
 * 实测 974 个抬高格里 **p50 = 0.00 / p90 = 0.04** —— 绝大多数是通道噪声，不是盆地。
 * 不设深度门槛会把整条流路当成一个"488 格的湖"（实测），水位还被算到 97（接近峰顶）。
 *
 * @param {Float32Array|Float64Array} filled 填洼后的高度
 * @param {Array<{i:number,before:number,after:number}>} basins `fillDepressions` 记下的抬高格
 * @param {number} cellsX @param {number} cellsY
 * @param {{minArea?:number, minDepth?:number, maxLakes?:number, maxCells?:number}} [opts]
 * @returns {Array<{level:number, cells:number[]}>} 按面积从大到小
 */
export function detectBasinLakes(filled, basins, cellsX, cellsY, opts = {}) {
  const n = filled ? filled.length : 0;
  if (!n || cellsX < 2 || cellsY < 2) return [];
  const minArea = Math.max(4, Math.floor(Number(opts.minArea) || 8));
  const minDepth = Number.isFinite(opts.minDepth) ? Math.max(0, Number(opts.minDepth)) : 0.5;
  const maxLakes = Math.max(1, Math.floor(Number(opts.maxLakes) || 40));
  const maxCells = Math.max(100, Math.floor(Number(opts.maxCells) || 6000));

  const raised = new Uint8Array(n);
  for (const b of (basins || [])) {
    if (!b || !Number.isInteger(b.i) || b.i < 0 || b.i >= n) continue;
    if (Number(b.after) - Number(b.before) >= minDepth) raised[b.i] = 1;
  }
  const seen = new Uint8Array(n);
  const out = [];
  for (let start = 0; start < n; start++) {
    if (!raised[start] || seen[start]) continue;
    const comp = [];
    const queue = [start];
    seen[start] = 1;
    let level = -Infinity;
    while (queue.length) {
      const cur = queue.pop();
      comp.push(cur);
      if (filled[cur] > level) level = filled[cur];
      const ci = cur % cellsX;
      const cj = (cur - ci) / cellsX;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = ci + di;
          const nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= cellsX || nj >= cellsY) continue;
          const idx = nj * cellsX + ni;
          if (!raised[idx] || seen[idx]) continue;
          seen[idx] = 1;
          queue.push(idx);
        }
      }
    }
    if (comp.length >= minArea) {
      comp.sort((a, b) => a - b);
      out.push({ level: Math.round(level * 100) / 100, cells: comp });
    }
  }
  out.sort((a, b) => (b.cells.length - a.cells.length) || (a.cells[0] - b.cells[0]));
  // 体积上限：湖是**元数据**，最大的一条也可能是几百格；只留最大的若干条 + 总格数封顶
  const kept = [];
  let budget = maxCells;
  for (const lake of out) {
    if (kept.length >= maxLakes || lake.cells.length > budget) continue;
    budget -= lake.cells.length;
    kept.push(lake);
  }
  return kept;
}

// ── 气候判湖（2026-11-08，卡「干旱盆地（playa/盐湖）：判湖要读降水」）────────────────
//
// 病灶：上面那套判定只看**几何**（被填平的面积 + 深度），与气候无关 —— 于是
//   · 雨林里一个浅坑成湖，沙漠里一个更深的盆地反而不成湖（没有“水从哪来”这一层）；
//   · 干旱区的洼地在真实地图上应该是**盐湖 / playa / 干盐湖**，现在要么画成湖，要么什么都没有。
//
// 口径（三条，改之前先读）：
//   ① **只做降级与分类，不新建湖**：干旱区不许“凭空多出湖”，只把已有的湖判成 saline 或丢掉；
//   ② **淡水湖一个不动**：`prec ≥ minPrec` 的湖一律原样保留，连 `saline` 字段都不加
//      （老项目/老裁据的载荷因此逐字节不变）；
//   ③ **干旱区不是“没有水”**：面积够大的盆地仍然是湖（现实里的盐湖/playa 就是这么来的），
//      只是要更大的面积门槛 —— 门槛随干旱程度放大，`salineAreaFactor` 是上限倍数。
//
// ⚠️ 降水标尺是 FMG 的 0…100（`utils/heightMath.js#precipitationAtIndex`），不是毫米。
//    默认 `minPrec = 40` 落在“温带森林 / 草原”的分界。
//
// 🔴 **必须同时看温度**（2026-11-08 真机抓到）：本项目的降水口径里 `basePrecip = temperature > 0 ? 60 : 20`
//    —— 也就是说**高寒地区天生“降水低”**。只按降水判，会把高原上的冰川湖判成盐湖甚至直接删掉，
//    而现实里恰恰相反：盐湖出现在**又热又干**的地方（蒸发 > 流入），高寒湖泊是淡的（蒸发几乎为零）。
//    所以“干旱”= `降水 < minPrec` **且** `温度 > minTemp`。冷区的湖一律按淡水处理。

/** 气候判湖的默认口径（改它就要重立像素基线：湖色分档会改观感） */
export const LAKE_CLIMATE = { minPrec: 40, minTemp: 5, salineAreaFactor: 2.5, wetPrec: 60, minArea: 8 };

/** 一条湖的平均降水量（只取湖格；`prec` 缺 / 长度不对 → null） */
export function lakeMeanPrecipitation(lake, prec) {
  return meanOverCells(lake, prec);
}

/** 一条湖的平均温度（同上；`temp` 缺 → null） */
export function lakeMeanTemperature(lake, temp) {
  return meanOverCells(lake, temp);
}

function meanOverCells(lake, values) {
  if (!lake || !Array.isArray(lake.cells) || !values || !values.length) return null;
  let sum = 0;
  let n = 0;
  for (const i of lake.cells) {
    if (!Number.isInteger(i) || i < 0 || i >= values.length) continue;
    const v = Number(values[i]);
    if (!Number.isFinite(v)) continue;
    sum += v;
    n += 1;
  }
  return n ? sum / n : null;
}

/**
 * 按气候把湖分档（淡水 / 盐湖）并降级**又热又干**的小湖。
 *
 * @param {Array<{level:number, cells:number[]}>} lakes `detectBasinLakes` 的产物
 * @param {number[]|Float32Array|null} prec 每格降水（FMG 0…100）；**不给就原样返回**
 * @param {{temp?:number[]|Float32Array|null, minPrec?:number, minTemp?:number,
 *          salineAreaFactor?:number, minArea?:number}} [opts]
 *   `temp` 给了才做“冷区豁免”（冷区不下盐）；不给就按“暖区”处理（老调用方的行为不变）
 * @returns {{lakes:Array, dropped:number, saline:number, fresh:number,
 *            coldKept:number}}
 *   `coldKept` = 因为冷区豁免而保持淡水的条数（排障口要能读到，别靠猜）
 */
export function classifyLakesByClimate(lakes, prec, opts = {}) {
  const list = Array.isArray(lakes) ? lakes : [];
  if (!list.length) return { lakes: list, dropped: 0, saline: 0, fresh: 0, coldKept: 0 };
  if (!prec || !prec.length) return { lakes: list, dropped: 0, saline: 0, fresh: 0, coldKept: 0 };
  const minPrec = Number.isFinite(opts.minPrec) ? Number(opts.minPrec) : LAKE_CLIMATE.minPrec;
  const minTemp = Number.isFinite(opts.minTemp) ? Number(opts.minTemp) : LAKE_CLIMATE.minTemp;
  const factor = Number.isFinite(opts.salineAreaFactor) && opts.salineAreaFactor >= 1
    ? Number(opts.salineAreaFactor) : LAKE_CLIMATE.salineAreaFactor;
  const minArea = Math.max(4, Math.floor(Number(opts.minArea) || LAKE_CLIMATE.minArea));
  const temp = opts.temp && opts.temp.length ? opts.temp : null;
  const out = [];
  let dropped = 0;
  let saline = 0;
  let fresh = 0;
  let coldKept = 0;
  for (const lake of list) {
    if (!lake || !Array.isArray(lake.cells) || !lake.cells.length) { out.push(lake); continue; }
    const mean = meanOverCells(lake, prec);
    if (mean === null || mean >= minPrec) { out.push(lake); fresh += 1; continue; }
    // 冷区豁免：蒸发几乎为零的高寒湖是**淡的**。这里的“降水低”只是温度口径的副作用
    // （`basePrecip` 在 0℃ 以下直接给 20），把它当干旱处理会删掉整片高原湖。
    if (temp) {
      const t = meanOverCells(lake, temp);
      if (t !== null && t <= minTemp) { out.push(lake); fresh += 1; coldKept += 1; continue; }
    }
    // 又热又干：**面积门槛按缺水量放大** —— “雨少几倍，面积就要大几倍才撑得起一湖水”。
    //   ratio = minPrec / max(mean, minPrec / factor)，夹在 [1, factor]：
    //     · 刚好到门槛（mean → minPrec）→ 门槛就还是 minArea；
    //     · 最干（mean → 0）→ 门槛封顶在 minArea × factor（再大就没湖了，那不真实）；
    // 用比值而不是线性插值：线性的在 mean 稍微低于门槛时几乎不动门槛，等于没判。
    const ratio = Math.max(1, Math.min(factor, minPrec / Math.max(mean, minPrec / factor)));
    const need = Math.round(minArea * ratio);
    if (lake.cells.length < need) { dropped += 1; continue; }
    out.push({ ...lake, saline: true, meanPrec: Math.round(mean * 10) / 10 });
    saline += 1;
  }
  return { lakes: out, dropped, saline, fresh, coldKept };
}
