// utils/terrainSynthesis.js — **按陆地轮廓推导一份可用的地形高度图**（纯函数，Node 可测；2026-10-17）
//
// ── 为什么必须有它（暮雨 2026-10-17 的原话，直接决定方向）──────────────────────
//   「用户甚至不是必须用外部软件导出地图再放进司天做历史剧本的，司天自身的编辑能力必须过硬，
//     **不要指望靠用户导出高度数据地图来救河流生成**。」
//
//   而我此前的实现与结论都建立在"有一份外部导入的高度图"之上：
//     · `generateRivers` 遇到 `!hasGrid(hm)` 直接返回 `no-heightmap`（**自建底图直接没有河流**）；
//     · 就算有，也是 Azgaar 最小档 133×75 —— 我拿这个当"数据瓶颈"去解释长河不存在，
//       **等于把责任推给用户用的外部工具**。这是错的定位：司天自己画的地，就该能长出河。
//
// ── 做法（不依赖任何外部数据，只用司天自己已有的东西）────────────────────────
//   输入 = **陆地多边形**（`terrain[]`，用户用「自由绘制 / 套索 / 省份」画出来的那块地）。
//   输出 = 一份标准形态的高度图（与 Azgaar 导入的那份**同构**：`h` + `grid{points,cellsX,cellsY,spacing}`），
//          可直接喂给 `traceRivers`。
//
//   **v1（2026-10-17 第八修）**：离岸距离场 + 三段旋转噪声 + 洼地填平（priority-flood）。
//   **v2（2026-10-18 第九修，本文件现在这版）**：用户对 v1 的判词是
//     「自动生成的高度图还不如我原来自带的高度图」→ 并点名缺三样：
//     **山脉走向 / 高原面 / 裂谷**。据实说，v1 只有"内陆高、海岸低 + 噪声"，
//     那份地形**没有排水结构可言**（每处坡面都差不多）→ 河只能碎着长。
//
//   v2 在同一个骨架（离岸距离场 + 洼地填平）上叠三种**真实地形成因**：
//     ① **山脉走向**（各向异性脊线）：脊线噪声沿一个**主导走向**拉长、再叠一条次要走向
//        （真实造山带很少只有一条方向）。做法是采样时把坐标按走向旋转、并让**垂直走向的频率
//        远高于沿走向的频率** —— 于是等值线被拉成"骨状"，而不是各向同性的疙瘩。
//     ② **高原面**：一块低频场圈出连片区域，区域内高度被压向同一个面、只留很小的起伏
//        （真高原的特征是"大面积同一高度"，这是坡面场给不出来的）。
//     ③ **裂谷**：1~2 条确定性折线，沿线的下切剖面（越靠轴线越深）**切穿高原**
//        —— 它同时是一条真实的水系走廊（裂谷是天然河道）。
//     三种结构都由 `seed` 决定方向/位置/条数 → **同一份输入永远同一份地形**（可复现，能写用例）。
//
//   ⚠️ **只读推演，不写数据**：本模块是纯函数；要不要把结果落进 `commitHeightmap`（进 undo 栈）
//      由调用方决定。默认行为是"临时用来算河"，回执里明确告知。
//
//   ⚠️ **判据在 `scripts/tests/unit/test_terrain_structure.js`**：里面量的是**结构**本身
//      （高频残差上的各向异性 / 最大连片平高块 / 裂谷走廊带的相对下切）与**排水**改善
//      （最长主河、汇流上界），不是"看着像不像" —— 本仓模型没有图像输入，
//      观感类结论只能落成几何数值判据。每条判据都带 v1 反向对照（证明它有判别力）。

/** 版本标记（探针/用例可读）：改了推演口径就 +1 —— 用来确认"页面跑的是不是这份代码" */
export const TERRAIN_SYNTHESIS_VERSION = 2;

/** 结构参数（**单一事实源**：用例按同一份口径取阈值，不许在用例里另抄一组数） */
export const TERRAIN_STRUCTURE = {
  /** 主导走向（度）。`null` = 由 seed 推（同一份输入仍确定） */
  rangeAxisDeg: null,
  /** 主走向脊线权重 */
  rangeWeight: 0.26,
  /** 次走向脊线权重（避免整张图只有一条方向 —— 那反而不像真地形） */
  crossRangeWeight: 0.12,
  /** 高原面权重（把高原区域内的 v 拉向 `plateauLevel`）—— 必须够大，否则"平"不出来 */
  plateauWeight: 0.92,
  /** 高原面高度（v 尺度 0..1）。⚠️ 它必须**明显高于**周边的坡面+山脉（否则不叫高原），
   *  但又不能顶到 1.0（否则整张图只有高原）。 */
  plateauLevel: 0.56,
  /** 裂谷下切深度（v 尺度） */
  riftDepth: 0.26,
  /** 裂谷半宽（归一化到长边） */
  riftWidth: 0.055,
  /** 域扭曲强度（让走向蜿蜒，不是直尺画的） */
  warp: 0.16,
};

/** 简单的 32 位整数哈希 → [0,1)（确定性噪声，同一份输入永远同一份地形） */
function hash2(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}

function smoothstep(t) {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/** 分段平滑（做 mask 用）：`x <= e0` → 0，`x >= e1` → 1 */
function smoothstep01(e0, e1, x) {
  const d = e1 - e0;
  if (!(d > 0)) return x >= e1 ? 1 : 0;
  return smoothstep((x - e0) / d);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 二维旋转（度）：把坐标转到"走向坐标系"里采样 —— 各向异性的来源 */
function rot2(x, y, deg) {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [x * c - y * s, x * s + y * c];
}

/** 二叉最小堆（priority-flood 要用；按 `key` 上升出堆） */
function makeHeap() {
  const keys = [];
  const vals = [];
  return {
    push(k, v) {
      keys.push(k); vals.push(v);
      let i = keys.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (keys[p] <= keys[i]) break;
        [keys[p], keys[i]] = [keys[i], keys[p]];
        [vals[p], vals[i]] = [vals[i], vals[p]];
        i = p;
      }
    },
    pop() {
      const topK = keys[0], topV = vals[0];
      const lastK = keys.pop(), lastV = vals.pop();
      if (keys.length) {
        keys[0] = lastK; vals[0] = lastV;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < keys.length && keys[l] < keys[m]) m = l;
          if (r < keys.length && keys[r] < keys[m]) m = r;
          if (m === i) break;
          [keys[m], keys[i]] = [keys[i], keys[m]];
          [vals[m], vals[i]] = [vals[i], vals[m]];
          i = m;
        }
      }
      return [topK, topV];
    },
    get size() { return keys.length; },
  };
}

/**
 * **洼地填平（priority-flood）** —— 保证每个陆格都有一条**严格下降**的路通向海。
 *
 * 🔴 为什么必须有它（2026-10-17 实测两次才定位）：
 *   我先是只加低频起伏 → 画面上是一排排等距竖线（"梳齿"）。我以为原因是距离变换用
 *   4 邻域 BFS（等距线是菱形），换成 chamfer 近似欧氏之后 **梳齿更多了** —— 因为
 *   距离场更光滑 = **同高度的格子更多** = 更并列。
 *   真正的根因是：**任何光滑的高度场都会产生大片"同高层"，水在平层上只能平行流**。
 *   治本只有一条：让水**永远有唯一的、严格更低的下游**。做这件事的标准算法就是
 *   priority-flood（Barnes 2014）：从海格起，由低到高"漫灌"，每个陆格的高度被抬到
 *   `max(自身高度, 已访问邻格 + ε)`。结果是：没有洼地、没有平层，处处可排水。
 *   代价是低洼盆地会被抬平 —— 那正是真实湖泊/沼泽的成因，视觉上是合理的。
 *
 * B④（2026-10-29）：**导出**给 `utils/fmg/index.js` 复用 —— FMG 模板地形本身带大量封闭洼地，
 * 不填平的话司天的自动河流在 8k 格上一**条**都长不出来（实测：水只能停在盆里）。填平是纯函数、
 * 与地形从哪来无关，所以只留这一份实现（不要再抄一份到 fmg/）。
 */
export function fillDepressions(h, land, cols, rows, seaLevel, epsilon) {  const n = cols * rows;
  const visited = new Uint8Array(n);
  const out = Float64Array.from(h);
  const heap = makeHeap();
  // 种子：海格 + 网格边界（它们的水"已经出得去"）
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;
      const edge = i === 0 || j === 0 || i === cols - 1 || j === rows - 1;
      if (!land[idx] || edge) {
        visited[idx] = 1;
        heap.push(out[idx], idx);
      }
    }
  }
  const nbr = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
  while (heap.size) {
    const [elev, cur] = heap.pop();
    const ci = cur % cols, cj = (cur - ci) / cols;
    for (const [di, dj] of nbr) {
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
      const nidx = nj * cols + ni;
      if (visited[nidx]) continue;
      visited[nidx] = 1;
      // 抬到"能流出去"的最低高度；ε 保证严格下降（不产生新的平层）
      const raised = Math.max(out[nidx], elev + epsilon);
      out[nidx] = raised;
      heap.push(raised, nidx);
    }
  }
  void seaLevel;
  return out;
}

/** 二维值噪声（双线性 + smoothstep），返回 [0,1) */
function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const tx = smoothstep(x - xi), ty = smoothstep(y - yi);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  const top = a + (b - a) * tx;
  const bot = c + (d - c) * tx;
  return top + (bot - top) * ty;
}

/** 分形噪声（几个八度叠加），返回 [0,1) */
function fbm(x, y, seed, octaves = 3) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * freq, y * freq, seed + o * 101) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return norm > 0 ? sum / norm : 0.5;
}

/**
 * **脊线噪声（ridged multifractal）** —— 山脉走向的几何本体。
 *
 * 普通 fbm 的等值线是"疙瘩"，做不出"一条山脊"。脊线噪声的标准做法是把噪声折起来
 * （`1 - |2n - 1|`，把 0.5 附近的等值线变成脊），再平方强化、逐八度叠加。
 *
 * 🔴 **各向异性是这里唯一的关键**：`freqX` 与 `freqY` 取不同值 —— 垂直走向采样得更快
 *    （频率更高）→ 沿走向被拉长。`freqY / freqX ≈ 3` 时观感是"骨状山脉"；
 *    两者相等就退化成各向同性的碎丘（那就又回到 v1 的"粗糙噪声"了）。
 *
 * 判据：`test_terrain_structure.js` 用结构张量量**各向异性**（λ1-λ2)/(λ1+λ2)，
 *       以及主导方向与 `rangeAxisDeg` 的一致性。改这里的频率比会让那两条红。
 */
function ridgeNoise(x, y, seed, octaves, freqX, freqY) {
  let sum = 0, amp = 1, f = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = valueNoise(x * freqX * f, y * freqY * f, seed + o * 211);
    const r = 1 - Math.abs(2 * n - 1);      // 折起来 → 脊
    sum += r * r * amp;                     // 平方 → 脊更细、更连续
    norm += amp;
    amp *= 0.5;
    f *= 2.05;
  }
  return norm > 0 ? sum / norm : 0;
}

/** 点到线段的距离（归一化坐标里用，量纲与 `nx/ny` 一致） */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * **裂谷折线** —— 由 `seed` 决定（同一 seed 同一条裂谷，可复现、能写用例）。
 *
 * 为什么用"折线 + 距离剖面"而不是再来一层噪声：裂谷的本质是**一条线状下切**，
 * 用噪声做出来的只会是又一片碎坑；折线能保证"长、窄、连通"——那才是水系走廊。
 *
 * 🔴 走向必须**跟着山脉走**（`axisDeg ± 15°`）：真实的裂谷多是沿造山带张裂的，
 *    而且从判据角度也必须这样 —— 第一版让裂谷自己随机取方向，于是
 *    "结构张量量出来的主导走向"变成"山脉与裂谷的加权平均"，与 `rangeAxisDeg`
 *    能差 49°（实测），判据直接失效。让两者同向之后，走向才是一个可判的量。
 * @param {number} seed
 * @param {number} [axisDeg] 主导走向（度）；不传则按 seed 推
 * @param {number} [aspect] 地形包围盒的 **高/长**（`spanY/spanX`，≤1）。⚠️ 归一化坐标里
 *   `ny` 只能到 `aspect` —— 第一版按 `cy=0.5` 放，在扁长地形上把裂谷放到了陆地**外面**
 *   （实测 seed=23：走廊 0 格），于是"裂谷判据"量的是空气。
 * @returns {Array<{ax:number,ay:number,bx:number,by:number}>} 归一化坐标的线段
 */
export function makeRiftSegments(seed, axisDeg, aspect) {
  const s = Number.isFinite(seed) ? Math.floor(seed) : 7;
  const base = Number.isFinite(axisDeg) ? axisDeg : rangeAxisFromSeed(s);
  const asp = Number.isFinite(aspect) && aspect > 0 ? Math.min(1, aspect) : 1;
  const rnd = (k) => hash2(k * 13 + 1, k * 29 + 5, s + k * 97);
  const count = rnd(1) > 0.42 ? 2 : 1;
  const out = [];
  for (let k = 0; k < count; k++) {
    const ang = ((base + (rnd(k * 5 + 2) - 0.5) * 30) * Math.PI) / 180;   // 与主走向同向 ±15°
    // 垂直于走向偏移，让两条裂谷不叠在一起（沿走向穿过陆地中心附近）
    const off = (k === 0 ? -0.11 : 0.11) * (0.6 + rnd(k * 5 + 6) * 0.8);
    const cx = 0.5 + Math.cos(ang + Math.PI / 2) * off * asp;
    const cy = asp * 0.5 + Math.sin(ang + Math.PI / 2) * off;
    const half = 0.46 + rnd(k * 5 + 5) * 0.22;                            // 半长（归一化到长边）
    const dx = Math.cos(ang) * half, dy = Math.sin(ang) * half;
    out.push({ ax: cx - dx, ay: cy - dy, bx: cx + dx, by: cy + dy });
  }
  return out;
}

/** 由 seed 推主导走向（度）。用哈希而不是 `seed*37%180`，避免相邻 seed 给出相邻角度 */
export function rangeAxisFromSeed(seed) {
  const s = Number.isFinite(seed) ? Math.floor(seed) : 7;
  return Math.round(hash2(3, 11, s + 17) * 180);
}

/**
 * 从陆地多边形推演一份高度图。
 *
 * @param {Array} terrain 省份/陆地多边形数组（`provinceRings` 能取到环的那种）
 * @param {{isLand?:(x:number,y:number)=>boolean, cellSize?:number, maxCells?:number,
 *          seaLevel?:number, relief?:number, seed?:number, structure?:boolean}} [opts]
 *   `isLand`   —— 陆地判定（**强烈建议传产品自己的 `buildLandMask`**：与渲染/裁剪同一口径）；
 *                 不传时会在采样点里"只要落进任何一个环就算陆"（慢，仅兜底）。
 *   `cellSize` —— 目标格距（世界单位）。不传则按包围盒长边 / `cellsAcross` 自动定，夹在 [2, 40]。
 *   `cellsAcross` —— 不传 `cellSize` 时的"长边格数"（默认 96 = 0.4.0 的旧口径）。
 *   `maxCells` —— 格数上限（默认 60000，防止把一张巨大的地图算成几百万格卡死）。
 *   `structureOverrides` —— P0-1 参数面板的**唯一注入点**：在 `TERRAIN_STRUCTURE` 上做覆盖
 *                 （`rangeWeight / crossRangeWeight / plateauWeight / riftDepth` …）。
 *                 默认不传 → 与 0.4.0 逐字节一致（`test_terrain_params.js` 用黄金值守）。
 *   `structure` —— **默认 true**：叠山脉走向 / 高原面 / 裂谷（v2）。
 *                 传 `false` 得到 v1 的"坡面 + 噪声"（**只给对照组用**：用例靠它证明
 *                 "结构真的改变了地形"，产品路径不许用它）。
 * @returns {{h:number[], grid:{points:Array<[number,number]>, cellsX:number, cellsY:number,
 *            spacing:number}, synthesized:true, cellCount:number, landCells:number,
 *            effectiveCellSize:number, structure?:{version:number,rangeAxisDeg:number,
 *            rifts:number,plateauLevel:number}}|null}
 */
export function synthesizeHeightmapFromTerrain(terrain, opts = {}) {
  const list = Array.isArray(terrain) ? terrain.filter(Boolean) : [];
  if (!list.length) return null;

  const seaLevel = Number.isFinite(opts.seaLevel) ? opts.seaLevel : 20;
  const relief = Number.isFinite(opts.relief) ? opts.relief : 1;
  const seed = Number.isFinite(opts.seed) ? Math.floor(opts.seed) : 7;
  // 结构开关：默认开。`false` 只用于对照组（见 opts 注释）
  const useStructure = opts.structure !== false;
  // 参数覆盖（P0-1，2026-10-25）：面板滑杆只改这里，**不碰** TERRAIN_STRUCTURE 本体 ——
  // 它是用例与实现的共同口径（`test_terrain_structure.js` 按它取阈值），改了常量会连带改测试语义。
  // 不传 overrides 时 `st === TERRAIN_STRUCTURE`（引用相同 → 数值逐字节不变）。
  const st = opts.structureOverrides && typeof opts.structureOverrides === 'object'
    ? { ...TERRAIN_STRUCTURE, ...opts.structureOverrides }
    : TERRAIN_STRUCTURE;
  const rangeAxisDeg = Number.isFinite(opts.rangeAxisDeg) ? opts.rangeAxisDeg
    : (st.rangeAxisDeg != null ? st.rangeAxisDeg : rangeAxisFromSeed(seed));

  // ── 包围盒：从地形对象自己的几何取（不依赖渲染侧状态）──────────────────────────
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eachPoint = (fn) => {
    for (const t of list) {
      const rings = Array.isArray(t && t.rings) ? t.rings
        : Array.isArray(t && t.points) ? [t.points] : [];
      for (const ring of rings) {
        for (const p of ring || []) {
          const x = Array.isArray(p) ? p[0] : (p && p.x);
          const y = Array.isArray(p) ? p[1] : (p && p.y);
          if (Number.isFinite(x) && Number.isFinite(y)) fn(x, y);
        }
      }
    }
  };
  eachPoint((x, y) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  });
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || maxX <= minX || maxY <= minY) return null;

  const spanX = maxX - minX, spanY = maxY - minY;
  const longSide = Math.max(spanX, spanY);
  // 裂谷位置要用"高/长"比（见 `makeRiftSegments` 的 aspect 注释）
  const rifts = useStructure ? makeRiftSegments(seed, rangeAxisDeg, spanY / longSide) : [];
  // 格距：默认让长边约 96 格（比外部最小档 133 略粗但**可控**；可用 cellSize / cellsAcross 调细）
  const cellsAcross = Number.isFinite(opts.cellsAcross) && opts.cellsAcross >= 8
    ? Math.floor(opts.cellsAcross)
    : 96;
  let cellSize = Number.isFinite(opts.cellSize) && opts.cellSize > 0
    ? opts.cellSize
    : Math.max(2, Math.min(40, longSide / cellsAcross));
  const maxCells = Number.isFinite(opts.maxCells) && opts.maxCells > 0 ? opts.maxCells : 60000;
  // 格数超限时自动放粗格距（宁可粗，也不要卡死）
  let cols = Math.max(3, Math.ceil(spanX / cellSize) + 1);
  let rows = Math.max(3, Math.ceil(spanY / cellSize) + 1);
  while (cols * rows > maxCells) {
    cellSize *= 1.25;
    cols = Math.max(3, Math.ceil(spanX / cellSize) + 1);
    rows = Math.max(3, Math.ceil(spanY / cellSize) + 1);
  }

  // 四周留一格边（海格），让"最外圈是海"这件事明确存在 → 水一定流得出去
  const pad = cellSize;
  const ox = minX - pad, oy = minY - pad;
  const n = cols * rows;

  // ── 陆地掩膜：产品自己的判定优先（与渲染/裁剪同口径）────────────────────────────
  const isLand = typeof opts.isLand === 'function' ? opts.isLand : null;
  const land = new Uint8Array(n);
  const px = new Float64Array(n), py = new Float64Array(n);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;
      const x = ox + i * cellSize, y = oy + j * cellSize;
      px[idx] = x; py[idx] = y;
      land[idx] = isLand ? (isLand(x, y) ? 1 : 0) : 0;
    }
  }
  let landCells = 0;
  for (let i = 0; i < n; i++) landCells += land[i];
  // 没有任何陆格（多边形的点都在掩膜外，或没传 isLand 又取不到几何）→ 放弃
  if (!landCells) return null;

  // ── ① 离岸距离场（**chamfer 3-4 距离变换**，近似欧氏）──────────────────────────
  // 🔴 2026-10-17 实测（第一版用 4 邻域 BFS）：等距线是**菱形**（曼哈顿距离），
  //    于是坡面上出现大量"同一高度"的格子 → 水**平行**下流 → 画面上是一排排等距竖线
  //    （"梳齿"）。换成 3-4 chamfer（横竖走一步记 3、斜走记 4，最后除以 3）之后，
  //    等距线接近正圆 → 坡向连续变化 → 水才会**斜着并到一起**。
  //    这是图像处理里的标准近似（O(n) 两遍扫描，比 Dijkstra 快一个量级，误差 < 3%）。
  const INF = 0x7fffffff;
  const dist = new Int32Array(n).fill(INF);
  const A = 3, B = 4;      // 横竖 = 3，斜 = 4（≈ 4/3 = 1.33，接近 √2 = 1.414）
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;
      if (!land[idx]) { dist[idx] = 0; continue; }     // 海格 = 距离源
      if (i === 0 || j === 0 || i === cols - 1 || j === rows - 1) dist[idx] = A;  // 网格边界也算岸
    }
  }
  // 正向扫描（左上 → 右下）
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;
      if (dist[idx] === 0) continue;
      let d = dist[idx];
      if (i > 0) d = Math.min(d, dist[idx - 1] + A);
      if (j > 0) d = Math.min(d, dist[idx - cols] + A);
      if (i > 0 && j > 0) d = Math.min(d, dist[idx - cols - 1] + B);
      if (i < cols - 1 && j > 0) d = Math.min(d, dist[idx - cols + 1] + B);
      dist[idx] = d;
    }
  }
  // 反向扫描（右下 → 左上）
  for (let j = rows - 1; j >= 0; j--) {
    for (let i = cols - 1; i >= 0; i--) {
      const idx = j * cols + i;
      if (dist[idx] === 0) continue;
      let d = dist[idx];
      if (i < cols - 1) d = Math.min(d, dist[idx + 1] + A);
      if (j < rows - 1) d = Math.min(d, dist[idx + cols] + A);
      if (i < cols - 1 && j < rows - 1) d = Math.min(d, dist[idx + cols + 1] + B);
      if (i > 0 && j < rows - 1) d = Math.min(d, dist[idx + cols - 1] + B);
      dist[idx] = d;
    }
  }
  // chamfer 单位是 1/3 格：换算回"格"，并求最内陆距离
  let maxDist = 1;
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue;
    const cells = dist[i] / A;
    if (cells > maxDist) maxDist = cells;
  }

  // ── ②b 高原面掩膜：**按分位圈地**（覆盖约 1/4 陆地）──────────────────────────────
  //    🔴 2026-10-18 实测教训：第一版用固定阈值 `smoothstep01(0.50, 0.62, pf)`，
  //    在这份地形上 **64% 的陆地都落进掩膜** → 陆地中位高度被抬到高原面上 →
  //    不仅判据量不出"高原"，观感上也变成"整张图就是一块高原"。
  //    改用**数据自己的 p70~p85 分位**：阈值随地形自动落位，覆盖比例由构造保证，
  //    不依赖任何魔法常数（换一份高度预算也不会失效）。
  let plateauQ70 = 0.58, plateauQ85 = 0.70;
  if (useStructure) {
    const pfs = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const idx = j * cols + i;
        if (!land[idx]) continue;
        pfs.push(fbm(((px[idx] - ox) / longSide) * 1.35 + 11.3,
          ((py[idx] - oy) / longSide) * 1.35 - 4.7, seed + 331, 2));
      }
    }
    if (pfs.length) {
      pfs.sort((a, b) => a - b);
      const qp = (p) => pfs[Math.min(pfs.length - 1, Math.round((pfs.length - 1) * p))];
      plateauQ70 = qp(0.62);
      plateauQ85 = qp(0.80);
    }
  }

  // ── 合成高度 ────────────────────────────────────────────────────────────────
  const h = new Array(n);
  const landSpan = 100 - seaLevel;
  const invMax = maxDist > 0 ? 1 / maxDist : 0;
  let plateauCells = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;
      if (!land[idx]) { h[idx] = seaLevel - 8; continue; }   // 海：明确低于海平面
      // `dist` 的量纲是 1/3 格（chamfer 权重 3），换算回格
      const dc = dist[idx] / A;
      const d = dc > 0 ? dc : 0.34;
      // ① 离岸距离 → 0..1（平方根：靠岸一段保持低平，内陆才抬起来 —— 大陆架感）
      const t = Math.sqrt(Math.min(1, d * invMax));
      // ② 起伏：**两个频段**，缺一个就会长出"梳齿"。
      //    🔴 2026-10-17 实测（只用一个低频起伏时）：坡面上所有格高度几乎相同 →
      //       水只会**平行**下流 → 画面上是一排排等距的竖线（"梳子"），永远汇不起来。
      //    低频（约 2 个波）决定"哪半边更高"；中频（约 7 个波）制造局部的脊与谷，
      //    让相邻的水道**分到不同方向、并在谷里相遇** —— 这才是树枝状汇流的成因。
      const nx = (px[idx] - ox) / longSide;
      const ny = (py[idx] - oy) / longSide;
      // 🔴 2026-10-17 第八修·再修（用户实测：「全变成烤牛排了，结果是毁灭性的」）：
      //    上一版用了 2.1 / 6.7 / **20** 三段**轴对齐**的值噪声。高频段（20 波长）的格点
      //    正好落在 x/y 网格方向上 → 整片地形长出**规则的斜向沟槽网** → 水沿沟槽平行下流
      //    → 画面上是整齐的斜条纹（"烤牛排"）。
      //    这是"值噪声在整数格点上做双线性插值"的固有缺陷（栅格方向会被印出来）。
      //    修法：**每个频段把自己的坐标旋转一个角度**（35° / -22° / 61°），格点方向就不再
      //    与流向或屏幕轴对齐；同时把最高频从 20 降到 13，并压低其权重。
      //    ⚠️ 判据：旋转只改"纹路方向"，不改"内高外低"这个主导场。
      const rot = (x, y, deg) => {
        const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
        return [x * c - y * s, x * s + y * c];
      };
      const [ax, ay] = rot(nx, ny, 35);
      const [bx, by] = rot(nx, ny, -22);
      const [cx2, cy2] = rot(nx, ny, 61);
      const lowFreq = (fbm(ax * 2.1, ay * 2.1, seed, 2) - 0.5) * 2;         // -1..1
      const midFreq = (fbm(bx * 6.7, by * 6.7, seed + 41, 3) - 0.5) * 2;    // -1..1
      const highFreq = (fbm(cx2 * 13, cy2 * 13, seed + 83, 2) - 0.5) * 2;   // -1..1
      const undulate = lowFreq * 0.44 + midFreq * 0.36 + highFreq * 0.20;

      let v;
      if (!useStructure) {
        // ── v1 口径（对照组）：坡面 + 三段起伏。产品路径不用它 ────────────────────
        // ③ 合成：距离主导 + 三段起伏。高频段只负责"打破平层"，权重压到 0.2。
        v = t * (0.60 + 0.44 * undulate * relief);
      } else {
        // ── v2 口径：坡面 + **山脉走向** + **高原面** − **裂谷** ─────────────────────
        // 域扭曲：把采样坐标先揉一下，山脊/裂谷才不是直尺画的（真实走向是蜿蜒的）
        const wAmp = st.warp;
        const wxm = nx + wAmp * (fbm(nx * 1.6 + 7.3, ny * 1.6 - 2.1, seed + 401, 2) - 0.5) * 2;
        const wym = ny + wAmp * (fbm(nx * 1.6 - 3.7, ny * 1.6 + 5.9, seed + 433, 2) - 0.5) * 2;
        // 内陆权重：山脉 / 高原 / 裂谷都只长在内陆（海岸带保持低平，水才出得去）
        const interior = Math.pow(t, 0.45);
        // ① 山脉走向：主导走向 + 次走向（真实造山带不止一条方向，但主走向占优）
        const [rx, ry] = rot2(wxm, wym, -rangeAxisDeg);
        const ridgeMain = ridgeNoise(rx, ry, seed + 101, 4, 2.6, 8.5);
        const [qx, qy] = rot2(wxm, wym, -(rangeAxisDeg + 65));
        const ridgeCross = ridgeNoise(qx, qy, seed + 211, 3, 3.0, 7.0);
        const crossW = st.crossRangeWeight;
        const ranges = ridgeMain * (1 - crossW) + ridgeCross * crossW;
        // ② 高原面：低频场圈出连片区域（阈值取 p70~p85），区域内高度压向同一个面
        const pf = fbm(nx * 1.35 + 11.3, ny * 1.35 - 4.7, seed + 331, 2);
        const plateauMask = useStructure ? smoothstep01(plateauQ70, plateauQ85, pf) : 0;
        // ③ 裂谷：沿线状折线下切（不是噪声碎坑 —— 裂谷要"长、窄、连通"）
        let trench = 0;
        for (const rf of rifts) {
          const ds = segDist(nx, ny, rf.ax, rf.ay, rf.bx, rf.by);
          const w = st.riftWidth;
          if (ds < w) { const u = 1 - ds / w; trench += u * u; }
        }
        if (trench > 1) trench = 1;
        // 合成：坡面为主干，山脉抬升，高原压平，裂谷下切
        // ⚠️ **高度预算**：这里不许把整张图抬高 —— 下游的「源头高度闸门」是一个**绝对高度**
        //    （`TRACE_SOURCE_HEIGHT = 60`）。实测第一版（0.72/0.46 + 高原 0.66）把陆地均值从
        //    45.6 抬到 63.1 → **85% 的陆格都在闸门之上** → 一点自动河流就是 2400 个源头。
        //    现值（0.62/0.36 + 高原 0.60）实测均值 ≈ 50、>60 占比 ≈ 20%（与 v1 同量级）。
        const base = t * (0.52 + 0.34 * undulate * relief);
        const mountain = clamp01(ranges * interior * 1.15);
        v = 0.50 * base + st.rangeWeight * mountain;
        const pw = plateauMask * st.plateauWeight;
        // 高原面内部：高度 = 面高度 + 极小的起伏（`0.015` → 约 ±1.2 高度单位 ——
        // 再大就不叫"面"了；坑洼填平的 ε 还会给一点点倾斜，那正是"能排水"所需）
        if (pw > 0) {
          const flat = st.plateauLevel + 0.015 * (undulate * 0.6 + highFreq * 0.4);
          v = v * (1 - pw) + flat * pw;
        }
        v -= trench * st.riftDepth * interior;
        if (plateauMask > 0.5) plateauCells++;
      }
      v = Math.max(0, Math.min(1, v));
      // 海岸格（d ≤ 2）压到刚过海平面，保证"能出河口、不悬空"
      let elev = seaLevel + v * landSpan;
      if (d <= 2) elev = Math.min(elev, seaLevel + 1.5);
      h[idx] = Math.max(seaLevel + 0.5, Math.round(elev * 100) / 100);
    }
  }

  // ── ④ 洼地填平：保证每格都有一条**严格下降**的路通向海 ─────────────────────────
  //    ε 取 landSpan 的 1/2000（≈0.04 高度单位）—— 小到不影响观感，
  //    大到足以让"同高邻居"变成"严格更低的下游"，从而消掉平流（梳齿）。
  const filled = fillDepressions(h, land, cols, rows, seaLevel, Math.max(1e-3, landSpan / 2000));
  for (let i = 0; i < n; i++) {
    h[i] = land[i] ? Math.round(filled[i] * 100) / 100 : (seaLevel - 8);
  }

  const points = new Array(n);
  for (let i = 0; i < n; i++) points[i] = [px[i], py[i]];

  return {
    h,
    grid: { points, cellsX: cols, cellsY: rows, spacing: cellSize },
    synthesized: true,
    cellCount: n,
    landCells,
    effectiveCellSize: Math.round(cellSize * 1000) / 1000,
    maxInlandCells: maxDist,
    // 结构自述（回执/用例读它；`structure:false` 时不给这个字段）
    ...(useStructure ? {
      structure: {
        version: TERRAIN_SYNTHESIS_VERSION,
        rangeAxisDeg,
        rifts: rifts.length,
        plateauLevel: st.plateauLevel,
        plateauCells,
      },
    } : {}),
  };
}
