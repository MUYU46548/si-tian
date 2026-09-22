/**
 * 程序化地形纹理（确定性 · 柔和底纹）
 *
 * 用途：PlanetMap 的「地形多边形」在 lodRef > 0.55（scale > 0.775）时叠一层 texture pattern，
 * 让省份色块不至于死板。
 *
 * 🔴 2026-09-22 重写。起因——用户实测：「行星地图的绘制功能不太好，依然是马赛克方块填色（地形），
 *    不是自然的笔刷」。CDP 实测归因（scale=1.0，画布 900×600 的唯一色数）：
 *      全开 14720 → 只关绘制网格 3030 → 多边形层 + 网格都关 717
 *    即多边形纹理贡献约 2300 色。旧实现是 64×64 瓦片里撒上百个小圆点/短线（草叶、树冠、砂粒、碎石…）
 *    再平铺；真实缩放下每颗斑点只有 1~3 屏幕像素，整屏就被读成「细密马赛克像素画」。
 *    而且那些点全部用 `Math.random()` 生成（文件头却写着「全部确定性」），
 *    每次重建纹理（切主题 / 清缓存）画面颜色都会变。
 *
 * 现行做法：**只留大尺度柔和明暗** —— 低频 fbm 底噪 + 少量大半径柔光斑（瓦片的 1/6~1/3 半径）
 * + 极淡的带状起伏（山脊/沙丘/水波/等高线感）。全部走确定性 PRNG，同 seed 同结果。
 * 🔴 纪律：不要在这类平铺纹理里加逐像素级别的随机元素 —— 叠在色块上就是马赛克观感。
 *    要质感就加大尺度、低对比的明暗层次。
 */

const TEXTURE_SIZE = 64;      // 纹理单元大小（像素）
const NOISE_GRID = 8;         // 周期化格点数（整除 64 → 无缝平铺）
const textureCache = new Map();

// ===== 确定性 PRNG（mulberry32）：取代旧实现的 Math.random =====
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ===== 确定性 value noise + fbm（周期化 → 无缝平铺） =====
function hash2D(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

function periodicCell(x) {
  return ((Math.floor(x) % NOISE_GRID) + NOISE_GRID) % NOISE_GRID;
}

function valueNoise(x, y, seed) {
  const ix = periodicCell(x), iy = periodicCell(y);
  const fx = x - Math.floor(x), fy = y - Math.floor(y);
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const v00 = hash2D(ix, iy, seed), v10 = hash2D((ix + 1) % NOISE_GRID, iy, seed);
  const v01 = hash2D(ix, (iy + 1) % NOISE_GRID, seed), v11 = hash2D((ix + 1) % NOISE_GRID, (iy + 1) % NOISE_GRID, seed);
  const a = v00 + (v10 - v00) * ux;
  const b = v01 + (v11 - v01) * ux;
  return a + (b - a) * uy;
}

function fbmNoise(x, y, seed, octaves = 3) {
  let v = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < octaves; i++) {
    v += amp * valueNoise(x * freq, y * freq, seed + i * 131);
    amp *= 0.5;
    freq *= 2;
  }
  return v / 0.875; // 归一化 0~1
}

function hexToRgb(hex) {
  const h = String(hex || '#888888').replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

function createOffscreenCanvas(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

/**
 * 低频底噪：整块瓦片按 fbm 做整体明暗（无逐像素斑点）
 * @param {number} amp 明暗幅度（0.07 = 整体 ±7% 亮度）
 * @param {number} brightness 亮度偏移（<0 偏暗，用于森林/山地）
 */
function paintNoiseBase(ctx, baseColor, seed, amp, brightness = 0) {
  const { r, g, b } = hexToRgb(baseColor);
  const img = ctx.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  const data = img.data;
  for (let y = 0; y < TEXTURE_SIZE; y++) {
    for (let x = 0; x < TEXTURE_SIZE; x++) {
      const n = fbmNoise(x / NOISE_GRID, y / NOISE_GRID, seed);
      const delta = (n - 0.5) * 2 * amp + brightness;
      const idx = (y * TEXTURE_SIZE + x) * 4;
      data[idx] = Math.max(0, Math.min(255, Math.round(r * (1 + delta))));
      data[idx + 1] = Math.max(0, Math.min(255, Math.round(g * (1 + delta))));
      data[idx + 2] = Math.max(0, Math.min(255, Math.round(b * (1 + delta))));
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * 大半径柔光斑：**绘制 9 次（含四周包裹）**保证平铺无缝。
 * 半径取瓦片的 1/6~1/3 —— 大就是关键，小斑点会立刻回到「马赛克」观感。
 */
function paintSoftBlobs(ctx, rng, { count = 5, minR = 12, maxR = 24, rgb = [255, 255, 255], alpha = 0.09 }) {
  const size = TEXTURE_SIZE;
  for (let i = 0; i < count; i++) {
    const bx = rng() * size, by = rng() * size;
    const r = minR + rng() * (maxR - minR);
    const a = alpha * (0.6 + rng() * 0.8);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const x = bx + ox * size, y = by + oy * size;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a.toFixed(3)})`);
        g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

/**
 * 极淡带状起伏（山脊 / 沙丘 / 水波 / 等高线感）。
 * 波长取整数周期 → 左右上下都能接上。
 */
function paintSoftBands(ctx, { periods = 3, rgb = [255, 255, 255], alpha = 0.06, vertical = false, wobble = 0.6 }) {
  const size = TEXTURE_SIZE;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  ctx.lineWidth = 1.6;
  for (let k = 0; k < periods; k++) {
    ctx.beginPath();
    for (let t = 0; t <= size; t += 2) {
      const phase = (t / size) * periods * Math.PI * 2;
      const off = Math.sin(phase + k * 1.7) * wobble + Math.sin(phase * 2 + k) * wobble * 0.35;
      const base = (k + 0.5) * (size / periods);
      if (t === 0) {
        if (vertical) ctx.moveTo(base + off, t); else ctx.moveTo(t, base + off);
      } else if (vertical) ctx.lineTo(base + off, t); else ctx.lineTo(t, base + off);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * 每种地形的纹理配方：只调「底噪幅度 / 柔光斑 / 带状起伏」三样，不再撒小元素。
 * seed 固定 → 同类型每次生成完全一致（不再随机闪烁）。
 */
const TYPE_RECIPES = {
  ocean: { seed: 11, amp: 0.06, blobs: 2, blobRgb: [190, 225, 255], blobAlpha: 0.05, bands: 4, bandRgb: [200, 230, 255], bandAlpha: 0.05, bandWobble: 1.2 },
  land: { seed: 23, amp: 0.07, blobs: 6, blobRgb: [235, 255, 220], blobAlpha: 0.08 },
  forest: { seed: 37, amp: 0.07, brightness: -0.05, blobs: 7, blobRgb: [20, 60, 25], blobAlpha: 0.1, minR: 10, maxR: 22 },
  rainforest: { seed: 41, amp: 0.07, brightness: -0.08, blobs: 8, blobRgb: [10, 45, 20], blobAlpha: 0.1, minR: 10, maxR: 20 },
  grassland: { seed: 53, amp: 0.07, brightness: 0.03, blobs: 5, blobRgb: [230, 245, 170], blobAlpha: 0.08 },
  desert: { seed: 67, amp: 0.06, brightness: 0.02, blobs: 3, blobRgb: [255, 240, 200], blobAlpha: 0.07, bands: 4, bandRgb: [230, 195, 130], bandAlpha: 0.07, bandWobble: 1.6 },
  coast: { seed: 71, amp: 0.06, blobs: 5, blobRgb: [250, 240, 210], blobAlpha: 0.08 },
  wetland: { seed: 83, amp: 0.07, brightness: -0.03, blobs: 7, blobRgb: [120, 170, 175], blobAlpha: 0.09, bands: 2, bandRgb: [180, 215, 220], bandAlpha: 0.05, bandWobble: 1.4 },
  mountain: { seed: 97, amp: 0.07, brightness: -0.02, blobs: 4, blobRgb: [60, 45, 30], blobAlpha: 0.09, bands: 5, bandRgb: [235, 225, 210], bandAlpha: 0.06, vertical: true, bandWobble: 0.9 },
  volcano: { seed: 103, amp: 0.07, brightness: -0.06, blobs: 5, blobRgb: [140, 30, 10], blobAlpha: 0.11 },
  barren: { seed: 113, amp: 0.06, brightness: 0.02, blobs: 5, blobRgb: [200, 200, 200], blobAlpha: 0.07 },
  tundra: { seed: 127, amp: 0.05, blobs: 5, blobRgb: [200, 210, 195], blobAlpha: 0.07 },
  snow: { seed: 131, amp: 0.04, brightness: 0.03, blobs: 4, blobRgb: [255, 255, 255], blobAlpha: 0.08 },
  lake: { seed: 139, amp: 0.05, blobs: 3, blobRgb: [200, 235, 250], blobAlpha: 0.06, bands: 3, bandRgb: [225, 245, 255], bandAlpha: 0.05, bandWobble: 1.0 },
};

/** 未登记类型不叠纹理（宁可不叠，也不要随机噪声） */
function generateSoftTexture(baseColor, recipe) {
  const c = createOffscreenCanvas(TEXTURE_SIZE);
  const ctx = c.getContext('2d');
  const r = recipe || {};
  paintNoiseBase(ctx, baseColor, r.seed === undefined ? 149 : r.seed, r.amp === undefined ? 0.06 : r.amp, r.brightness || 0);
  const rng = makeRng((r.seed === undefined ? 149 : r.seed) * 7919 + 17);
  if (r.bands) {
    paintSoftBands(ctx, {
      periods: r.bands,
      rgb: r.bandRgb || [255, 255, 255],
      alpha: r.bandAlpha === undefined ? 0.06 : r.bandAlpha,
      vertical: !!r.vertical,
      wobble: r.bandWobble === undefined ? 0.6 : r.bandWobble,
    });
  }
  paintSoftBlobs(ctx, rng, {
    count: r.blobs === undefined ? 4 : r.blobs,
    minR: r.minR === undefined ? 12 : r.minR,
    maxR: r.maxR === undefined ? 24 : r.maxR,
    rgb: r.blobRgb || [255, 255, 255],
    alpha: r.blobAlpha === undefined ? 0.07 : r.blobAlpha,
  });
  return c;
}

/**
 * 获取指定地形类型的纹理图案
 * @param {string} terrainType - 地形类型
 * @param {string} baseColor - 基础颜色
 * @param {CanvasRenderingContext2D} ctx - 用于创建 pattern 的渲染上下文
 * @returns {CanvasPattern|null}
 */
export function getTexturePattern(terrainType, baseColor, ctx) {
  const cacheKey = `${terrainType}_${baseColor}`;
  if (textureCache.has(cacheKey)) return textureCache.get(cacheKey);
  const recipe = TYPE_RECIPES[terrainType];
  if (!recipe) return null;
  if (!ctx || typeof document === 'undefined') return null;
  const pattern = ctx.createPattern(generateSoftTexture(baseColor, recipe), 'repeat');
  textureCache.set(cacheKey, pattern);
  return pattern;
}

/** 清除纹理缓存（主题切换时调用）。纹理本身确定性 → 重生成结果与之前完全一致。 */
export function clearTextureCache() {
  textureCache.clear();
}

/** 预生成纹理（数据加载完成后调用，避免首帧卡顿） */
export function prewarmTextures(terrainTypes, ctx) {
  if (!ctx) return;
  const colors = {
    ocean: '#2E86AB', land: '#A3C4BC', forest: '#2D6A4F',
    rainforest: '#1B5E20', grassland: '#8BC34A',
    desert: '#E9C46A', coast: '#C2B280', wetland: '#5D737E',
    mountain: '#8B7355', volcano: '#5D4037',
    barren: '#9E9E9E', tundra: '#78909C',
    snow: '#E8E8E8', lake: '#6FB3C8',
  };
  terrainTypes.forEach(type => {
    const color = colors[type];
    if (color) getTexturePattern(type, color, ctx);
  });
}
