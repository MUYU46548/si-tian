/**
 * 程序化纹理生成模块
 * 为每种地形类型生成无缝平铺的程序纹理
 * 不依赖外部图片资源，无限缩放无像素化
 */

const TEXTURE_SIZE = 64; // 纹理单元大小（像素）
const textureCache = new Map();

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

  // 波浪线
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (let y = 4; y < TEXTURE_SIZE; y += 8) {
    ctx.beginPath();
    for (let x = 0; x <= TEXTURE_SIZE; x += 2) {
      const yOffset = Math.sin((x + y) * 0.3) * 2;
      if (x === 0) ctx.moveTo(x, y + yOffset);
      else ctx.lineTo(x, y + yOffset);
    }
    ctx.stroke();
  }

  // 细微噪点
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * TEXTURE_SIZE;
    const y = Math.random() * TEXTURE_SIZE;
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.06})`;
    ctx.fillRect(x, y, 1, 1);
  }

  return c;
}

/**
 * * 生成草地纹理：稀疏草叶斑点
 */
function generateLandTexture(baseColor) {
  const c = createOffscreenCanvas(TEXTURE_SIZE);
  const ctx = c.getContext('2d');

  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  // 草叶斑点
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * TEXTURE_SIZE;
    const y = Math.random() * TEXTURE_SIZE;
    const shade = Math.random() > 0.5 ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)';
    ctx.fillStyle = shade;
    ctx.fillRect(x, y, 2, 1);
  }

  // 偶尔的深绿点
  for (let i = 0; i < 12; i++) {
    const x = Math.random() * TEXTURE_SIZE;
    const y = Math.random() * TEXTURE_SIZE;
    ctx.fillStyle = 'rgba(34,80,40,0.12)';
    ctx.beginPath();
    ctx.arc(x, y, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  return c;
}

/**
 * 生成森林纹理：密集小树形
 */
function generateForestTexture(baseColor) {
  const c = createOffscreenCanvas(TEXTURE_SIZE);
  const ctx = c.getContext('2d');

  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  // 小树形（三角形）
  for (let i = 0; i < 15; i++) {
    const x = Math.random() * TEXTURE_SIZE;
    const y = Math.random() * TEXTURE_SIZE;
    const size = 2 + Math.random() * 3;
    ctx.fillStyle = `rgba(20,60,30,${0.15 + Math.random() * 0.15})`;
    ctx.beginPath();
    ctx.moveTo(x, y - size);
    ctx.lineTo(x - size * 0.6, y + size * 0.5);
    ctx.lineTo(x + size * 0.6, y + size * 0.5);
    ctx.closePath();
    ctx.fill();
  }

  // 深色斑点
  for (let i = 0; i < 25; i++) {
    const x = Math.random() * TEXTURE_SIZE;
    const y = Math.random() * TEXTURE_SIZE;
    ctx.fillStyle = 'rgba(0,0,0,0.05)';
    ctx.beginPath();
    ctx.arc(x, y, 1 + Math.random(), 0, Math.PI * 2);
    ctx.fill();
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

  // 沙粒点
  for (let i = 0; i < 80; i++) {
    const x = Math.random() * TEXTURE_SIZE;
    const y = Math.random() * TEXTURE_SIZE;
    const shade = Math.random() > 0.5 ? 'rgba(180,150,80,0.15)' : 'rgba(255,240,200,0.1)';
    ctx.fillStyle = shade;
    ctx.fillRect(x, y, 1, 1);
  }

  // 风纹（水平短线）
  ctx.strokeStyle = 'rgba(180,150,80,0.08)';
  ctx.lineWidth = 0.5;
  for (let i = 0; i < 6; i++) {
    const y = Math.random() * TEXTURE_SIZE;
    const startX = Math.random() * TEXTURE_SIZE * 0.5;
    ctx.beginPath();
    ctx.moveTo(startX, y);
    ctx.lineTo(startX + 10 + Math.random() * 15, y + (Math.random() - 0.5) * 2);
    ctx.stroke();
  }

  return c;
}

/**
 * 生成山脉纹理：山峰三角形
 */
function generateMountainTexture(baseColor) {
  const c = createOffscreenCanvas(TEXTURE_SIZE);
  const ctx = c.getContext('2d');

  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  // 山峰
  for (let i = 0; i < 8; i++) {
    const x = Math.random() * TEXTURE_SIZE;
    const y = TEXTURE_SIZE * 0.4 + Math.random() * TEXTURE_SIZE * 0.6;
    const size = 4 + Math.random() * 6;
    ctx.fillStyle = `rgba(60,40,20,${0.1 + Math.random() * 0.12})`;
    ctx.beginPath();
    ctx.moveTo(x, y - size);
    ctx.lineTo(x - size * 0.8, y + size * 0.3);
    ctx.lineTo(x + size * 0.8, y + size * 0.3);
    ctx.closePath();
    ctx.fill();

    // 雪顶
    if (Math.random() > 0.5) {
      ctx.fillStyle = 'rgba(220,220,230,0.15)';
      ctx.beginPath();
      ctx.moveTo(x, y - size);
      ctx.lineTo(x - size * 0.25, y - size * 0.4);
      ctx.lineTo(x + size * 0.25, y - size * 0.4);
      ctx.closePath();
      ctx.fill();
    }
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

  // 冰晶点
  for (let i = 0; i < 30; i++) {
    const x = Math.random() * TEXTURE_SIZE;
    const y = Math.random() * TEXTURE_SIZE;
    ctx.fillStyle = `rgba(200,210,230,${0.08 + Math.random() * 0.1})`;
    ctx.beginPath();
    ctx.arc(x, y, 0.5 + Math.random(), 0, Math.PI * 2);
    ctx.fill();
  }

  // 偶尔的亮斑
  for (let i = 0; i < 8; i++) {
    const x = Math.random() * TEXTURE_SIZE;
    const y = Math.random() * TEXTURE_SIZE;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
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

  // 同心圆波纹
  for (let i = 0; i < 4; i++) {
    const x = Math.random() * TEXTURE_SIZE;
    const y = Math.random() * TEXTURE_SIZE;
    for (let r = 3; r < 12; r += 3) {
      ctx.strokeStyle = `rgba(255,255,255,${0.04 + Math.random() * 0.04})`;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
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
  desert: generateDesertTexture,
  mountain: generateMountainTexture,
  snow: generateSnowTexture,
  lake: generateLakeTexture,
};

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
