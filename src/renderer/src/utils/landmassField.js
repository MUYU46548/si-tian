// utils/landmassField.js — **造陆地形场引擎**（纯函数，零 DOM/Vue，Node 可测；2026-10-25）
//
// ── 这一层在做什么 ────────────────────────────────────────────────────────
//   `landmass.js` 要的是"海岸线"，而海岸线 = **地形被海水淹到的位置**。所以先把地形铺出来：
//   高度场（0..100，海平面 20），再由等值线取海岸。地形由三种**有成因含义的体元**叠加：
//
//     ① **陆核（blob）**：平顶 + 二次衰减的丘/盆。`H·(1-d²)²`，d=0 处最平（高原面），
//        d=1 处高度与斜率同时归零 —— 等值线在丘的边缘自然收口，不会拖出长尾巴。
//        半径 `radius` 是**影响半径**（格），海岸线大致落在 0.85·radius 处。
//     ② **脊线（ridge）**：一条蜿蜒的折线（贪心走向 + 15% 随机分叉），沿线盖章：
//        每点一个 `(1-d)²` 的窄脊，高度沿脊线向末端衰减。**山脊的尾巴就是半岛**；
//        取负号就是海槽（从海里切进来的海湾/峡湾）。
//     ③ **海峡（carve）**：沿一条贯穿图幅的路径把高度**压到海平面以下**（取 min，不是相减）。
//        相减会被叠加出来的高山抵消（100-40 仍是山），只有取 min 才真的切得开。
//
//   再叠 **fBm 粗糙度**（全幅低频）+ **海岸带细节**（只在水陆交界的一圈高频扰动），
//   最后按目标陆地占比**整体平移高度**（二分），让"陆地占比"这个滑杆是准的。
//
// ── 为什么不照抄 Azgaar 的指数扩散 ────────────────────────────────────────
//   隔壁 `SP-1025/planet-map` 移植的 Azgaar 高度图工具链是 `h^(p^step)` 的指数扩散 +
//   Uint8 量化。在 115 格的世界图上它长得很好；但本项目场网格更大（长边 200+ 格），
//   同一个指数从峰值跌到海平面只占半径的 ~19%，于是陆地变成**细丝/蜘蛛腿**
//   （实测：先试过这一版，场图上全是触须，海岸出现跨图幅的直线段）。体元模型没有这个
//   尺度依赖：半径是格数，衰减到 0 为止，换分辨率只改细节多少，不改地貌。
//
// ── 纪律 ──────────────────────────────────────────────────────────────────
//   ① **确定性**：随机只来自注入的 `rng`（`makeRng(seed)`），本文件没有 `Math.random`；
//   ② **同参数同结果**：步骤顺序固定，每步只读/写自己的高度；
//   ③ 只产出高度场，不碰 Vue / store / 磁盘。

import { makeRng } from './voronoiBatch';

/** 海平面（高度 <= 此值即水面） */
export const SEA_LEVEL = 20;
/** 高度上限 */
export const HEIGHT_MAX = 100;

const lim = (v) => (v < 0 ? 0 : v > HEIGHT_MAX ? HEIGHT_MAX : v);

/** 建一个高度场（全 0 = 全海） */
export function createField({ cols, rows, seed = 7 }) {
  const c = Math.max(8, Math.floor(cols));
  const r = Math.max(8, Math.floor(rows));
  return {
    cols: c,
    rows: r,
    heights: new Float32Array(c * r),
    rng: makeRng(Math.max(0, Math.floor(seed)) * 2654435761 + 17),
    seed: Math.max(0, Math.floor(seed)),
  };
}

// ── 分形噪声（决定海岸的"毛糙"与陆核的轮廓抖动）──────────────────────────
function hash2(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) % 100000) / 100000;
}
const smoothT = (t) => t * t * (3 - 2 * t);
function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const tx = smoothT(x - xi), ty = smoothT(y - yi);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  const top = a + (b - a) * tx;
  const bot = c + (d - c) * tx;
  return top + (bot - top) * ty;
}
/** 分形噪声：每层旋转 37°（避免值噪声把栅格方向印到海岸上）；返回 [-1,1] */
export function fbm(x, y, seed, octaves = 4) {
  let sum = 0, amp = 1, norm = 0, f = 1, rot = 0;
  for (let o = 0; o < octaves; o++) {
    const r = (rot * Math.PI) / 180;
    const c = Math.cos(r), s = Math.sin(r);
    const nx = (x * c - y * s) * f, ny = (x * s + y * c) * f;
    sum += (valueNoise(nx + 13.7, ny - 7.3, seed + o * 101) - 0.5) * 2 * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.02;
    rot += 37;
  }
  return norm > 0 ? sum / norm : 0;
}

// 陆核的轮廓抖动：低频噪声按"格"采样，波长 ~25 格 —— 让丘的边缘不是完美圆
const WOBBLE_FREQ = 1 / 25;

/**
 * 陆核：平顶 + 二次衰减的丘（`sign=+1`）或盆地（`sign=-1`）。多块会**叠加**。
 * @param {{count:[number,number], height:[number,number], xr:[number,number], yr:[number,number],
 *          radius:number, sign?:1|-1, squash?:number, wobble?:number, jitter?:number}} spec
 *        `radius` 影响半径（格）；`squash` 把 y 方向压扁（<1 = 横向长条）；
 *        `wobble` 轮廓抖动幅度（0 = 正圆）；`jitter` 中心额外随机偏移（格）。
 */
export function addBlob(ctx, spec) {
  const { heights, cols, rows, rng } = ctx;
  const sign = spec.sign === -1 ? -1 : 1;
  const radius = Math.max(2, Number(spec.radius) || Math.min(cols, rows) * 0.1);
  const squash = Math.max(0.15, Math.min(3, Number(spec.squash) || 1));
  const wobble = Math.max(0, Math.min(0.8, spec.wobble == null ? 0.22 : spec.wobble));
  const jitter = Math.max(0, Number(spec.jitter) || 0);
  const count = Math.max(0, Math.round(spec.count[0] + (spec.count[1] - spec.count[0]) * rng()));
  const wobbleSeed = ctx.seed + 3301;

  for (let k = 0; k < count; k++) {
    let h = spec.height[0] + (spec.height[1] - spec.height[0]) * rng();
    h = Math.max(0, Math.min(HEIGHT_MAX, h));
    // 中心落点：xr/yr 是百分比区间；jitter 再抖一下（格）
    const cx = (spec.xr[0] + (spec.xr[1] - spec.xr[0]) * rng()) / 100 * (cols - 1)
      + (rng() - 0.5) * 2 * jitter;
    const cy = (spec.yr[0] + (spec.yr[1] - spec.yr[0]) * rng()) / 100 * (rows - 1)
      + (rng() - 0.5) * 2 * jitter;
    const rx = radius;
    const ry = Math.max(2, radius * squash);
    const i0 = Math.max(0, Math.floor(cx - rx * 1.15));
    const i1 = Math.min(cols - 1, Math.ceil(cx + rx * 1.15));
    const j0 = Math.max(0, Math.floor(cy - ry * 1.15));
    const j1 = Math.min(rows - 1, Math.ceil(cy + ry * 1.15));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = (i - cx) / rx;
        const dy = (j - cy) / ry;
        let d = Math.sqrt(dx * dx + dy * dy);
        if (d >= 1.15) continue;
        // 轮廓抖动：d 被低频噪声揉一下 → 边缘出现宽窄不一的海湾/岬角
        if (wobble > 0) d *= 1 + wobble * fbm(i * WOBBLE_FREQ + 5.1, j * WOBBLE_FREQ - 2.7, wobbleSeed, 3);
        if (d >= 1) continue;
        const f = (1 - d * d) ** 2;
        const idx = j * cols + i;
        heights[idx] = lim(heights[idx] + sign * h * f);
      }
    }
  }
}

/** 贪心走到终点（15% 概率把距离减半 → 脊线有分叉感） */
function walkTo(ctx, start, end, used, randomness) {
  const { cols, rows, rng } = ctx;
  const ex = end % cols, ey = (end / cols) | 0;
  const range = [start];
  used[start] = 1;
  let cur = start;
  let guard = 0;
  while (cur !== end && guard++ < cols * rows) {
    const cx = cur % cols, cy = (cur / cols) | 0;
    let best = Infinity;
    let next = -1;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
        const c = y * cols + x;
        if (used[c]) continue;
        let d = (ex - x) ** 2 + (ey - y) ** 2;
        if (rng() > 1 - randomness) d /= 2;
        if (d < best) { best = d; next = c; }
      }
    }
    if (next < 0) break;
    range.push(next);
    used[next] = 1;
    cur = next;
  }
  return range;
}

/**
 * 脊线：一条蜿蜒的折线，沿线盖章成窄脊；高度沿脊线向末端衰减（尾巴尖 = 半岛尖端）。
 * `sign=-1` 时是海槽（切出海湾/峡湾）。
 * @param {{count:[number,number], height:[number,number], xr:[number,number], yr:[number,number],
 *          radius:number, sign?:1|-1, taper?:number, randomness?:number}} spec
 */
export function addRidge(ctx, spec) {
  const { heights, cols, rows, rng } = ctx;
  const sign = spec.sign === -1 ? -1 : 1;
  const width = Math.max(1.2, Number(spec.radius) || Math.min(cols, rows) * 0.06);
  const taper = Math.max(0, Math.min(1, spec.taper == null ? 0.55 : spec.taper));
  const randomness = spec.randomness == null ? 0.15 : spec.randomness;
  const count = Math.max(0, Math.round(spec.count[0] + (spec.count[1] - spec.count[0]) * rng()));

  for (let k = 0; k < count; k++) {
    const used = new Uint8Array(cols * rows);
    let h = spec.height[0] + (spec.height[1] - spec.height[0]) * rng();
    h = Math.max(2, Math.min(HEIGHT_MAX, h));

    let start = -1;
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = (spec.xr[0] + (spec.xr[1] - spec.xr[0]) * rng()) / 100 * (cols - 1);
      const y = (spec.yr[0] + (spec.yr[1] - spec.yr[0]) * rng()) / 100 * (rows - 1);
      start = Math.round(y) * cols + Math.round(x);
      if (sign < 0 || heights[start] >= SEA_LEVEL) break;
    }
    if (start < 0) continue;

    // 终点：与起点保持 W/8 ~ W/2.6 的距离（太短没有脊，太长横穿整张图）
    const sx = start % cols, sy = (start / cols) | 0;
    let end = -1;
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = (0.08 + 0.84 * rng()) * cols;
      const y = (0.12 + 0.76 * rng()) * rows;
      const d = Math.abs(y - sy) + Math.abs(x - sx);
      if (d >= cols / 9 && d <= cols / 2.6) { end = Math.round(y) * cols + Math.round(x); break; }
    }
    if (end < 0) end = Math.round((0.12 + 0.76 * rng()) * rows) * cols + Math.round((0.08 + 0.84 * rng()) * cols);

    const range = walkTo(ctx, start, end, used, randomness);
    if (range.length < 3) continue;

    // 沿线盖章：每点一个圆盘，取 max（相加会让脊线鼓包）
    const n = range.length;
    for (let p = 0; p < n; p++) {
      const t = p / (n - 1);
      const hp = h * (1 - taper * t);
      const wp = Math.max(1.1, width * (1 - 0.45 * t));
      const px = range[p] % cols, py = (range[p] / cols) | 0;
      const i0 = Math.max(0, Math.floor(px - wp)), i1 = Math.min(cols - 1, Math.ceil(px + wp));
      const j0 = Math.max(0, Math.floor(py - wp)), j1 = Math.min(rows - 1, Math.ceil(py + wp));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const d = Math.hypot(i - px, j - py) / wp;
          if (d >= 1) continue;
          const f = (1 - d) ** 2;
          const idx = j * cols + i;
          const v = sign > 0
            ? Math.max(heights[idx], hp * f)          // 山脊取 max：不把已有高地再叠高
            : Math.min(heights[idx], SEA_LEVEL - hp * f); // 海槽直接压到海平面以下
          heights[idx] = lim(v);
        }
      }
    }
  }
}

/**
 * 海峡：沿一条贯穿图幅的路径把高度压到海平面以下（取 min），真把大陆切开。
 * @param {{width:[number,number], depth?:number, direction?:'vertical'|'horizontal'}} spec
 */
export function addStrait(ctx, spec) {
  const { heights, cols, rows, rng } = ctx;
  const width = Math.max(1, Math.round(spec.width[0] + (spec.width[1] - spec.width[0]) * rng()));
  const depth = Math.max(3, Number(spec.depth) || 12);
  const vert = (spec.direction || 'vertical') === 'vertical';
  const startX = vert ? Math.floor(rng() * cols * 0.4 + cols * 0.3) : 2;
  const startY = vert ? 2 : Math.floor(rng() * rows * 0.4 + rows * 0.3);
  const endX = vert ? Math.floor(cols - startX - cols * 0.1 + rng() * cols * 0.2) : cols - 3;
  const endY = vert ? rows - 3 : Math.floor(rows - startY - rows * 0.1 + rng() * rows * 0.2);
  const start = Math.max(0, Math.min(cols * rows - 1, startY * cols + startX));
  const end = Math.max(0, Math.min(cols * rows - 1, endY * cols + endX));
  const range = walkTo(ctx, start, end, new Uint8Array(cols * rows), 0.2);
  for (const cell of range) {
    const px = cell % cols, py = (cell / cols) | 0;
    const i0 = Math.max(0, px - width), i1 = Math.min(cols - 1, px + width);
    const j0 = Math.max(0, py - width), j1 = Math.min(rows - 1, py + width);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(i - px, j - py) / width;
        if (d >= 1) continue;
        const idx = j * cols + i;
        heights[idx] = Math.min(heights[idx], SEA_LEVEL - depth * (1 - d) ** 2);
      }
    }
  }
}

/**
 * 边缘淡出：只在**贴边的一圈**（距边框 0~14%）把高度压到 0，图幅内部不动。
 * 🔴 早先用 `(1-nx²)(1-ny²)^p` 全图相乘，等于把 30% 的图幅压成 0 —— 分位数海平面
 *    因此落在 1~3 高度点，海岸退化成"陆块脚印"。这里改成边带淡出 + 边框硬归零。
 */
export function maskField(ctx, power = 1.6) {
  const { heights, cols, rows } = ctx;
  const band = 0.14;
  const p = Math.max(0.3, Number(power) || 1);
  for (let j = 0; j < rows; j++) {
    const ny = (2 * j) / (rows - 1) - 1;
    for (let i = 0; i < cols; i++) {
      const nx = (2 * i) / (cols - 1) - 1;
      const t = Math.min(1 - Math.abs(nx), 1 - Math.abs(ny));   // 0=边框，1=中心
      const x = Math.min(1, t / band);
      const fade = x * x * (3 - 2 * x);                          // smoothstep
      const idx = j * cols + i;
      heights[idx] = lim(heights[idx] * Math.pow(fade, p));
    }
  }
  // 边框硬性归零（双保险：插值上也不许有等值线穿出图幅）
  for (let i = 0; i < cols; i++) {
    heights[i] = 0;
    heights[(rows - 1) * cols + i] = 0;
  }
  for (let j = 0; j < rows; j++) {
    heights[j * cols] = 0;
    heights[j * cols + cols - 1] = 0;
  }
}

/**
 * 纵向带状窗：把 `|y-中心| > half` 的部分平滑压到 0（用于"长条大陆"）。
 * 只压纵向、不动横向 —— 长条要的是"窄带"，不是"把整张图缩小"。
 * @param {number} centerFrac 中心（0~1 的图幅高度比例）
 * @param {number} halfFrac 半高（0~0.5）
 */
export function bandField(ctx, centerFrac = 0.5, halfFrac = 0.34) {
  const { heights, cols, rows } = ctx;
  const c = Math.max(0, Math.min(1, centerFrac));
  const half = Math.max(0.08, Math.min(0.5, halfFrac));
  for (let j = 0; j < rows; j++) {
    const t = Math.abs(j / Math.max(1, rows - 1) - c) / half;   // 0=中心，1=带边
    const x = Math.min(1, Math.max(0, 1 - t));
    const fade = x * x * (3 - 2 * x);                            // smoothstep
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;
      heights[idx] = lim(heights[idx] * fade);
    }
  }
}

/**
 * 区间平移/缩放：range = 'land' | 'all' | 'min-max'。
 * land 的语义是"高度 ≥ 海平面"，缩放围绕海平面做（否则会把陆地压进海里）。
 */
export function modifyField(ctx, { range = 'all', add = 0, mult = 1 } = {}) {
  const { heights } = ctx;
  const isLand = range === 'land';
  let min = 0, max = HEIGHT_MAX;
  if (!isLand && range !== 'all') {
    const [a, b] = String(range).split('-').map(Number);
    min = Number.isFinite(a) ? a : 0;
    max = Number.isFinite(b) ? b : HEIGHT_MAX;
  }
  for (let i = 0; i < heights.length; i++) {
    let h = heights[i];
    if (h < min || h > max) continue;
    if (isLand && h < SEA_LEVEL) continue;
    if (add) h = isLand ? Math.max(h + add, SEA_LEVEL) : h + add;
    if (mult !== 1) h = isLand ? (h - SEA_LEVEL) * mult + SEA_LEVEL : h * mult;
    heights[i] = lim(h);
  }
}

/**
 * 粗糙度：把 fBm 细节叠到高度上（陆地全幅、海里只留 35%，避免海面起伏又造出岛）。
 * @param {number} roughness 0..1
 */
export function applyRoughness(ctx, roughness, seed) {
  const r = Math.max(0, Math.min(1, Number(roughness) || 0));
  if (r <= 0) return;
  const { heights, cols, rows } = ctx;
  const amplitude = 2.5 + 13 * r;                   // 峰值高度差（高度点）
  const baseFreq = (3.0 + 4.0 * r) / Math.max(cols, rows); // 整幅 3~7 个大波
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const n = fbm(i * baseFreq, j * baseFreq, seed, 6);
      const idx = j * cols + i;
      const land = heights[idx] >= SEA_LEVEL;
      heights[idx] = lim(heights[idx] + n * amplitude * (land ? 1 : 0.35));
    }
  }
}

/**
 * 近岸压平：把海平面附近的**坡度**压缓（远处不动）。
 * 海岸线的"碎"取决于 `噪声幅度 / 局部坡度`：坡度越陡，同样幅度的噪声只能把等值线推 1~2 格，
 * 海岸就还是光滑的。压平后同一个噪声能推出十几格 —— 浅海、滩涂、泻湖、碎岛都从这里来。
 * @param {number} level 当前海平面（动态分位数）
 * @param {number} factor 近岸坡度保留比例（0.35~0.6；越小海岸越碎、内陆越陡）
 * @param {number} softness 压平带宽（高度点）
 */
export function flattenCoast(ctx, level, factor = 0.45, softness = 22) {
  const { heights } = ctx;
  const f = Math.max(0.05, Math.min(1, Number(factor) || 0.45));
  const band = Math.max(4, Number(softness) || 22);
  for (let i = 0; i < heights.length; i++) {
    const d = heights[i] - level;
    const w = Math.exp(-(d * d) / (2 * band * band));
    heights[i] = lim(level + d * (1 - w * (1 - f)));
  }
}

/**
 * 海岸带细节：只在水陆交界的一圈（|h-海平面| 小）叠高频 fBm，制造小海湾/小岬角/碎岛。
 * 内陆与深海不动 —— 否则全图会变成噪声地毯。
 * @param {number} strength 峰值高度差（高度点，建议 5~12）
 * @param {number} level 当前海平面（**动态分位数**；不传就退回 20）
 */
export function addCoastDetail(ctx, strength, seed, level = SEA_LEVEL) {
  const s = Math.max(0, Number(strength) || 0);
  if (s <= 0) return;
  const { heights, cols, rows } = ctx;
  const band = Math.max(3, s * 1.4);
  const freq = 1 / 14;   // 基波长 ~14 格（50px 量级）；5 个八度 → 细到 ~1 格
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;
      const d = heights[idx] - level;
      if (d < -band * 2 || d > band * 2) continue;
      const w = Math.exp(-(d * d) / (2 * band * band));
      if (w < 0.02) continue;
      const n = fbm(i * freq, j * freq, seed, 5);
      heights[idx] = lim(heights[idx] + n * s * w);
    }
  }
}

/**
 * 覆盖率校准：整体平移高度，二分逼近目标陆地占比（18 轮，误差 < 1 个高度点）。
 * 返回平移量与最终占比。
 */
export function calibrateCoverage(ctx, targetRatio) {
  const { heights } = ctx;
  const target = Math.max(0.01, Math.min(0.95, targetRatio));
  const ratioAt = (add) => {
    let land = 0;
    for (let i = 0; i < heights.length; i++) if (lim(heights[i] + add) >= SEA_LEVEL) land++;
    return land / heights.length;
  };
  let lo = -120, hi = 120;
  if (ratioAt(0) >= target) hi = 0; else lo = 0;
  for (let round = 0; round < 18; round++) {
    const mid = Math.round((lo + hi) / 2);
    if (mid === lo) break;
    if (ratioAt(mid) < target) lo = mid; else hi = mid;
  }
  const shift = Math.round((lo + hi) / 2);
  for (let i = 0; i < heights.length; i++) heights[i] = lim(heights[i] + shift);
  let land = 0;
  for (let i = 0; i < heights.length; i++) if (heights[i] >= SEA_LEVEL) land++;
  return { shift, ratio: land / heights.length };
}

/** 高度场统计（调试/回执） */
export function fieldStats(ctx) {
  const { heights } = ctx;
  let land = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    if (h >= SEA_LEVEL) land++;
    if (h < min) min = h;
    if (h > max) max = h;
  }
  return { landRatio: land / heights.length, min, max };
}
