/**
 * 程序化纹理生成模块
 * 为每种地形类型生成无缝平铺的程序纹理
 * 不依赖外部图片资源，无限缩放无像素化
 * 
 * 2026-08-16 增强：细节密度 ×1.7、对比度 alpha ×2（用户反馈纹理过弱）
 */

const TEXTURE_SIZE = 64; // 纹理单元大小（像素）
const textureCache = new Map();

// ===== 确定性 value noise（2026-08-16 视觉重设计） =====
// 有机地形底纹：柔和明暗斑块（fbm 分形叠加），替代"随机散布小元素"的脏感。
// 全部确定性（无 Math.random），同 seed 同结果。

function hash2D(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

// 周期化格点（NOISE_GRID 整除 64 → 无缝平铺）
const NOISE_GRID = 8;
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
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

/**
 * 生成柔和噪声底纹（明暗斑块），写入画布
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} baseColor - 基础色
 * @param {number} seed - 确定性种子
 * @param {number} amp - 明暗幅度（如 0.06 = 整体 ±6% 亮度变化，柔和）
 * @param {number} brightness - 亮度偏移（>0 偏亮，<0 偏暗，用于森林等）
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
 * 创建离屏画布用于纹理生成
 */
function createOffscreenCanvas(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

/**
 * 生成海洋纹理：波浪线 + 细微噪点
 */
function generateOceanTexture(baseColor) {
  const c = createOffscreenCanvas(TEXTURE_SIZE);
  const ctx = c.getContext('2d');

  // 基色填充
  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  // 波浪线（白色高光 + 深色阴影双线，增强水感）
  ctx.lineWidth = 1;
  for (let y = 4; y < TEXTURE_SIZE; y += 6) {
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath();
    for (let x = 0; x <= TEXTURE_SIZE; x += 2) {
      const yOffset = Math.sin((x + y) * 0.3) * 2;
      if (x === 0) ctx.moveTo(x, y + yOffset);
      else ctx.lineTo(x, y + yOffset);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,40,70,0.12)';
    ctx.beginPath();
    for (let x = 0; x <= TEXTURE_SIZE; x += 2) {
      const yOffset = Math.sin((x + y) * 0.3) * 2 + 1.5;
      if (x === 0) ctx.moveTo(x, y + yOffset);
      else ctx.lineTo(x, y + yOffset);
    }
    ctx.stroke();
  }

  // 细微噪点
  for (let i = 0; i < 100; i++) {
    const x = Math.random() * TEXTURE_SIZE;
    const y = Math.random() * TEXTURE_SIZE;
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.12})`;
    ctx.fillRect(x, y, 1, 1);
  }

  return c;
}

/**
 * * 生成草地纹理：柔和噪声底纹 + 稀疏草叶（2026-08-16 视觉重设计）
 * 草地本身应该是干净的：大块有机明暗变化 + 零星的草叶，而非密集噪点
 */
function generateLandTexture(baseColor) {
  const c = createOffscreenCanvas(TEXTURE_SIZE);
  const ctx = c.getContext('2d');

  // 有机噪声底纹（很淡，提供自然明暗层次）
  paintNoiseBase(ctx, baseColor, 11, 0.05);

  // 稀疏草叶（弯曲弧线，数量少、间距大）
  for (let i = 0; i < 9; i++) {
    const x = 4 + Math.random() * (TEXTURE_SIZE - 8);
    const y = 4 + Math.random() * (TEXTURE_SIZE - 8);
    const len = 3 + Math.random() * 3;
    const bend = (Math.random() - 0.5) * 2.5;
    ctx.strokeStyle = Math.random() > 0.5 ? 'rgba(70,130,80,0.22)' : 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + len * 0.4, y - len * 0.6, x + len * 0.9 + bend, y - len * 1.2);
    ctx.stroke();
  }

  return c;
}

/**
 * 生成森林纹理：噪声底纹 + 稀疏大树冠（2026-08-16 视觉重设计）
 * 树冠用大而清晰的圆点簇（3 圆构成），间距大，避免密集噪点
 */
function generateForestTexture(baseColor) {
  const c = createOffscreenCanvas(TEXTURE_SIZE);
  const ctx = c.getContext('2d');

  // 有机噪声底纹（略暗，模拟林下阴影）
  paintNoiseBase(ctx, baseColor, 23, 0.06, -0.03);

  // 稀疏大树冠（每棵 = 主圆 + 高光 + 次圆）
  for (let i = 0; i < 7; i++) {
    const x = 6 + Math.random() * (TEXTURE_SIZE - 12);
    const y = 6 + Math.random() * (TEXTURE_SIZE - 12);
    const r = 4 + Math.random() * 3;
    // 主树冠
    ctx.fillStyle = `rgba(10,45,20,${0.3 + Math.random() * 0.18})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // 高光（左上）
    ctx.fillStyle = 'rgba(150,210,140,0.2)';
    ctx.beginPath();
    ctx.arc(x - r * 0.3, y - r * 0.35, r * 0.5, 0, Math.PI * 2);
    ctx.fill();
    // 相邻次树冠（一侧）
    if (Math.random() > 0.35) {
      ctx.fillStyle = `rgba(10,45,20,${0.22 + Math.random() * 0.14})`;
      ctx.beginPath();
      ctx.arc(x + r * 1.1, y + r * 0.7, r * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return c;
}

/**
 * 生成沙漠纹理：沙粒点 + 风纹
 */
function generateDesertTexture(baseColor) {
  const c = createOffscreenCanvas(TEXTURE_SIZE);
  const ctx = c.getContext('2d');

  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  // 沙粒点（明暗双色）
  for (let i = 0; i < 140; i++) {
    const x = Math.random() * TEXTURE_SIZE;
    const y = Math.random() * TEXTURE_SIZE;
    const shade = Math.random() > 0.5 ? 'rgba(180,150,80,0.28)' : 'rgba(255,240,200,0.2)';
    ctx.fillStyle = shade;
    ctx.fillRect(x, y, 1, 1);
  }

  // 风纹（水平短线，明暗双色）
  ctx.lineWidth = 0.6;
  for (let i = 0; i < 10; i++) {
    const y = Math.random() * TEXTURE_SIZE;
    const startX = Math.random() * TEXTURE_SIZE * 0.5;
    ctx.strokeStyle = 'rgba(180,150,80,0.16)';
    ctx.beginPath();
    ctx.moveTo(startX, y);
    ctx.lineTo(startX + 10 + Math.random() * 15, y + (Math.random() - 0.5) * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,240,200,0.1)';
    ctx.beginPath();
    ctx.moveTo(startX + 2, y + 1);
    ctx.lineTo(startX + 10 + Math.random() * 15, y + 1 + (Math.random() - 0.5) * 2);
    ctx.stroke();
  }

  return c;
}

/**
 * 生成山脉纹理：噪声底纹 + 少量清晰山峰（2026-08-16 视觉重设计）
 * 移除浅色山脊折线（用户反馈像粉笔划痕）；山峰减少数量、加大尺寸、柔和层次
 */
function generateMountainTexture(baseColor) {
  const c = createOffscreenCanvas(TEXTURE_SIZE);
  const ctx = c.getContext('2d');

  // 有机噪声底纹（略暗，山体基调）
  paintNoiseBase(ctx, baseColor, 37, 0.07, -0.02);

  // 少量清晰山峰（大三角 + 柔和阴影 + 雪顶）
  for (let i = 0; i < 4; i++) {
    const x = 8 + Math.random() * (TEXTURE_SIZE - 16);
    const y = 10 + Math.random() * (TEXTURE_SIZE - 20);
    const size = 6 + Math.random() * 5;
    // 山峰阴影（偏移的深色三角，营造立体感）
    ctx.fillStyle = `rgba(50,35,20,${0.16 + Math.random() * 0.1})`;
    ctx.beginPath();
    ctx.moveTo(x + 1.5, y - size + 2);
    ctx.lineTo(x - size * 0.75 + 1.5, y + size * 0.35 + 2);
    ctx.lineTo(x + size * 0.75 + 1.5, y + size * 0.35 + 2);
    ctx.closePath();
    ctx.fill();
    // 山峰主体
    ctx.fillStyle = `rgba(95,70,40,${0.3 + Math.random() * 0.18})`;
    ctx.beginPath();
    ctx.moveTo(x, y - size);
    ctx.lineTo(x - size * 0.75, y + size * 0.35);
    ctx.lineTo(x + size * 0.75, y + size * 0.35);
    ctx.closePath();
    ctx.fill();
    // 雪顶（向阳面）
    ctx.fillStyle = 'rgba(235,230,220,0.32)';
    ctx.beginPath();
    ctx.moveTo(x, y - size);
    ctx.lineTo(x - size * 0.25, y - size * 0.38);
    ctx.lineTo(x + size * 0.25, y - size * 0.38);
    ctx.closePath();
    ctx.fill();
  }

  return c;
}

/**
 * 生成雪地纹理：白色 + 细微冰晶
 */
function generateSnowTexture(baseColor) {
  const c = createOffscreenCanvas(TEXTURE_SIZE);
  const ctx = c.getContext('2d');

  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  // 冰晶点（明暗双色）
  for (let i = 0; i < 50; i++) {
    const x = Math.random() * TEXTURE_SIZE;
    const y = Math.random() * TEXTURE_SIZE;
    ctx.fillStyle = `rgba(160,180,210,${0.16 + Math.random() * 0.18})`;
    ctx.beginPath();
    ctx.arc(x, y, 0.5 + Math.random(), 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 20; i++) {
    const x = Math.random() * TEXTURE_SIZE;
    const y = Math.random() * TEXTURE_SIZE;
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.beginPath();
    ctx.arc(x, y, 0.5 + Math.random() * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }

  // 亮斑
  for (let i = 0; i < 12; i++) {
    const x = Math.random() * TEXTURE_SIZE;
    const y = Math.random() * TEXTURE_SIZE;
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(x, y, 2, 1);
  }

  return c;
}

/**
 * 生成湖泊纹理：同心波纹
 */
function generateLakeTexture(baseColor) {
  const c = createOffscreenCanvas(TEXTURE_SIZE);
  const ctx = c.getContext('2d');

  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  // 同心圆波纹（明暗双线）
  for (let i = 0; i < 7; i++) {
    const x = Math.random() * TEXTURE_SIZE;
    const y = Math.random() * TEXTURE_SIZE;
    for (let r = 3; r < 14; r += 3) {
      ctx.strokeStyle = `rgba(255,255,255,${0.1 + Math.random() * 0.08})`;
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = `rgba(0,40,60,${0.06 + Math.random() * 0.06})`;
      ctx.beginPath();
      ctx.arc(x + 0.8, y + 0.8, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  return c;
}

// 地形类型到生成函数的映射
const textureGenerators = {
  ocean: generateOceanTexture,
  land: generateLandTexture,
  forest: generateForestTexture,
  rainforest: generateRainforestTexture,
  grassland: generateGrasslandTexture,
  desert: generateDesertTexture,
  coast: generateCoastTexture,
  wetland: generateWetlandTexture,
  mountain: generateMountainTexture,
  volcano: generateVolcanoTexture,
  barren: generateBarrenTexture,
  tundra: generateTundraTexture,
  snow: generateSnowTexture,
  lake: generateLakeTexture,
};

/**
 * 生成雨林纹理：深绿底 + 密集的树冠 + 雾气感
 */
function generateRainforestTexture(baseColor) {
  const c = createOffscreenCanvas(TEXTURE_SIZE);
  const ctx = c.getContext('2d');
  paintNoiseBase(ctx, baseColor, 41, 0.08, -0.05);

  // 密集多层树冠（大小不一，营造雨林层次）
  for (let i = 0; i < 18; i++) {
    const x = 2 + Math.random() * (TEXTURE_SIZE - 4);
    const y = 2 + Math.random() * (TEXTURE_SIZE - 4);
    const r = 2 + Math.random() * 5;
    ctx.fillStyle = `rgba(5,35,15,${0.15 + Math.random() * 0.2})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // 偶尔加高光（阳光穿透树冠）
    if (Math.random() > 0.7) {
      ctx.fillStyle = 'rgba(180,220,120,0.18)';
      ctx.beginPath();
      ctx.arc(x - r*0.2, y - r*0.3, r*0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return c;
}

/**
 * 生成草原纹理：柔和绿地 + 小花 + 浅草纹
 */
function generateGrasslandTexture(baseColor) {
  const c = createOffscreenCanvas(TEXTURE_SIZE);
  const ctx = c.getContext('2d');
  paintNoiseBase(ctx, baseColor, 53, 0.06, 0.02);

  // 细小的草叶纹
  ctx.lineWidth = 0.7;
  for (let i = 0; i < 20; i++) {
    const x = Math.random() * TEXTURE_SIZE;
    const y = Math.random() * TEXTURE_SIZE;
    const len = 2 + Math.random() * 3;
    ctx.strokeStyle = Math.random() > 0.5 ? 'rgba(80,140,60,0.2)' : 'rgba(180,210,100,0.18)';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random()-0.5)*2, y - len);
    ctx.stroke();
  }

  // 零星小花（小白点/小黄点）
  for (let i = 0; i < 8; i++) {
    const x = Math.random() * TEXTURE_SIZE;
    const y = Math.random() * TEXTURE_SIZE;
    ctx.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,200,0.5)' : 'rgba(255,200,100,0.4)';
    ctx.beginPath();
    ctx.arc(x, y, 1, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

/**
 * 生成海岸纹理：沙滩颗粒 + 潮汐线
 */
function generateCoastTexture(baseColor) {
  const c = createOffscreenCanvas(TEXTURE_SIZE);
  const ctx = c.getContext('2d');
  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  // 沙粒
  for (let i = 0; i < 80; i++) {
    const x = Math.random() * TEXTURE_SIZE;
    const y = Math.random() * TEXTURE_SIZE;
    ctx.fillStyle = Math.random() > 0.5 ? 'rgba(210,190,140,0.3)' : 'rgba(180,160,110,0.25)';
    ctx.fillRect(x, y, 1, 1);
  }

  // 潮汐线（横向不规则条纹）
  for (let i = 0; i < 5; i++) {
    const y = 8 + i * 12 + Math.random() * 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= TEXTURE_SIZE; x += 4) {
      ctx.lineTo(x, y + Math.sin(x * 0.2) * 2);
    }
    ctx.stroke();
  }
  return c;
}

/**
 * 生成湿地纹理：水洼 + 泥泞 + 枯草
 */
function generateWetlandTexture(baseColor) {
  const c = createOffscreenCanvas(TEXTURE_SIZE);
  const ctx = c.getContext('2d');
  paintNoiseBase(ctx, baseColor, 67, 0.07, -0.02);

  // 水洼（暗色圆斑）
  for (let i = 0; i < 6; i++) {
    const x = 5 + Math.random() * (TEXTURE_SIZE - 10);
    const y = 5 + Math.random() * (TEXTURE_SIZE - 10);
    const r = 2 + Math.random() * 4;
    ctx.fillStyle = `rgba(30,50,40,${0.2 + Math.random() * 0.15})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // 水洼高光
    ctx.fillStyle = 'rgba(200,220,230,0.15)';
    ctx.beginPath();
    ctx.arc(x - r*0.2, y - r*0.3, r*0.3, 0, Math.PI * 2);
    ctx.fill();
  }

  // 枯草（短褐线）
  for (let i = 0; i < 10; i++) {
    const x = Math.random() * TEXTURE_SIZE;
    const y = Math.random() * TEXTURE_SIZE;
    ctx.strokeStyle = 'rgba(120,90,50,0.25)';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random()-0.5)*4, y - 2 - Math.random()*3);
    ctx.stroke();
  }
  return c;
}

/**
 * 生成火山纹理：暗色岩石 + 熔岩裂纹 + 火山口
 */
function generateVolcanoTexture(baseColor) {
  const c = createOffscreenCanvas(TEXTURE_SIZE);
  const ctx = c.getContext('2d');
  paintNoiseBase(ctx, baseColor, 71, 0.08, -0.05);

  // 熔岩裂纹（暗红/橙色细线）
  for (let i = 0; i < 5; i++) {
    const startX = Math.random() * TEXTURE_SIZE;
    const startY = Math.random() * TEXTURE_SIZE;
    ctx.strokeStyle = Math.random() > 0.5 ? 'rgba(200,60,20,0.4)' : 'rgba(255,140,0,0.3)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    let x = startX, y = startY;
    for (let s = 0; s < 8; s++) {
      x += (Math.random() - 0.5) * 12;
      y += (Math.random() - 0.5) * 12;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // 火山口（暗圆 + 红边）
  for (let i = 0; i < 3; i++) {
    const x = 8 + Math.random() * (TEXTURE_SIZE - 16);
    const y = 8 + Math.random() * (TEXTURE_SIZE - 16);
    const r = 2 + Math.random() * 3;
    ctx.fillStyle = 'rgba(80,15,5,0.6)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,80,0,0.4)';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  return c;
}

/**
 * 生成石漠纹理：灰色碎石 + 干裂纹
 */
function generateBarrenTexture(baseColor) {
  const c = createOffscreenCanvas(TEXTURE_SIZE);
  const ctx = c.getContext('2d');
  paintNoiseBase(ctx, baseColor, 83, 0.08, 0);

  // 碎石（不规则多边形的浅色点）
  for (let i = 0; i < 15; i++) {
    const x = 2 + Math.random() * (TEXTURE_SIZE - 4);
    const y = 2 + Math.random() * (TEXTURE_SIZE - 4);
    const r = 1 + Math.random() * 2;
    ctx.fillStyle = Math.random() > 0.5 ? 'rgba(160,160,160,0.4)' : 'rgba(120,120,120,0.35)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 干裂纹（暗色折线）
  for (let i = 0; i < 3; i++) {
    ctx.strokeStyle = 'rgba(60,60,60,0.2)';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    let x = Math.random() * TEXTURE_SIZE;
    let y = Math.random() * TEXTURE_SIZE;
    ctx.moveTo(x, y);
    for (let s = 0; s < 6; s++) {
      x += (Math.random() - 0.5) * 15;
      y += (Math.random() - 0.5) * 15;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return c;
}

/**
 * 生成苔原纹理：浅灰绿底 + 斑块状地衣 + 偶尔融雪
 */
function generateTundraTexture(baseColor) {
  const c = createOffscreenCanvas(TEXTURE_SIZE);
  const ctx = c.getContext('2d');
  paintNoiseBase(ctx, baseColor, 97, 0.05, 0);

  // 地衣斑块（不规则浅色圆斑）
  for (let i = 0; i < 8; i++) {
    const x = 5 + Math.random() * (TEXTURE_SIZE - 10);
    const y = 5 + Math.random() * (TEXTURE_SIZE - 10);
    const r = 3 + Math.random() * 5;
    ctx.fillStyle = Math.random() > 0.5 ? 'rgba(140,160,130,0.25)' : 'rgba(180,190,170,0.2)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 融白斑（白色小圆，表示未化尽的雪）
  for (let i = 0; i < 5; i++) {
    const x = 8 + Math.random() * (TEXTURE_SIZE - 16);
    const y = 8 + Math.random() * (TEXTURE_SIZE - 16);
    const r = 1 + Math.random() * 3;
    ctx.fillStyle = 'rgba(240,245,250,0.5)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
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
  
  if (textureCache.has(cacheKey)) {
    return textureCache.get(cacheKey);
  }

  const generator = textureGenerators[terrainType];
  if (!generator) return null;

  const textureCanvas = generator(baseColor);
  const pattern = ctx.createPattern(textureCanvas, 'repeat');
  textureCache.set(cacheKey, pattern);
  return pattern;
}

/**
 * 清除纹理缓存（主题切换时调用）
 */
export function clearTextureCache() {
  textureCache.clear();
}

/**
 * 预生成纹理（数据加载完成后调用，避免首帧卡顿）
 */
export function prewarmTextures(terrainTypes, ctx) {
  if (!ctx) return;
  terrainTypes.forEach(type => {
    const colors = {
      ocean: '#2E86AB', land: '#A3C4BC', forest: '#2D6A4F',
      rainforest: '#1B5E20', grassland: '#8BC34A',
      desert: '#E9C46A', coast: '#C2B280', wetland: '#5D737E',
      mountain: '#8B7355', volcano: '#5D4037',
      barren: '#9E9E9E', tundra: '#78909C',
      snow: '#E8E8E8', lake: '#6FB3C8'
    };
    const color = colors[type];
    if (color) getTexturePattern(type, color, ctx);
  });
}
