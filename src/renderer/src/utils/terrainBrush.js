/**
 * utils/terrainBrush.js — 地形笔刷引擎
 * 核心思想：笔刷不是"放置顶点"，而是"在画布上涂抹"
 * 
 * 从 prototype/brush.js 迁移，适配司天架构：
 * - 地形类型索引对应 TERRAIN_TYPES 常量
 * - 支持硬度渐变（幂函数衰减）
 * - 支持速度插值（快速移动时填补空隙）
 */

// 8 种地形类型（与 prototype 一致）
export const TERRAIN_TYPES = [
  { id: 0, name: '海洋', base: [41, 98, 168], texture: [30, 80, 140] },
  { id: 1, name: '沙滩', base: [210, 190, 140], texture: [190, 170, 120] },
  { id: 2, name: '草地', base: [86, 150, 70], texture: [70, 130, 55] },
  { id: 3, name: '森林', base: [34, 100, 34], texture: [20, 80, 20] },
  { id: 4, name: '沙漠', base: [210, 180, 120], texture: [190, 160, 100] },
  { id: 5, name: '山脉', base: [130, 110, 90], texture: [100, 85, 70] },
  { id: 6, name: '雪地', base: [230, 235, 240], texture: [210, 215, 220] },
  { id: 7, name: '岩石', base: [100, 100, 100], texture: [80, 80, 80] },
];

export class TerrainBrush {
  constructor(options = {}) {
    this.size = options.size || 30;        // 笔刷直径（像素）
    this.hardness = options.hardness || 0.5; // 边缘硬度（0=柔和, 1=硬边）
    this.terrainType = options.terrainType || 2; // 当前绘制的地形类型索引（默认草地）
    this.minSize = 5;
    this.maxSize = 100;
  }

  /**
   * 获取笔刷在指定位置的影响权重（0-1）
   */
  getWeight(dx, dy) {
    const dist = Math.sqrt(dx * dx + dy * dy);
    const radius = this.size / 2;
    if (dist >= radius) return 0;
    const normalizedDist = dist / radius;
    if (this.hardness === 0) return 1 - normalizedDist;
    return Math.pow(1 - normalizedDist, 1 / (this.hardness * 0.99 + 0.01));
  }

  /**
   * 枚举一个笔刷落点**会碰到**的格子（**不写数据**）。
   *
   * 🔴 这是"将涂格高亮"与"落笔写格"的**同一份枚举**（2026-10-24 第 4 件）：
   *    预览自己再写一遍扫描逻辑，迟早出现"高亮的格子和真正涂上的格子不一样"——
   *    那种偏差只在边角（半径边缘 / 插值步数）露一点，肉眼很难抓，但用户会觉得"笔不听话"。
   *
   * @param {number} gridWidth  -1 = 不裁列（预览用无界格点）
   * @param {number} gridHeight
   * @param {number} centerX 笔刷中心（与 `cellSize` 同一坐标系）
   * @param {number} centerY
   * @param {number} cellSize
   * @param {(row:number, col:number, weight:number)=>void} cb
   * @returns {{x:number,y:number,width:number,height:number}|null} 覆盖矩形（像素坐标）
   */
  forEachCell(gridWidth, gridHeight, centerX, centerY, cellSize, cb) {
    const radius = this.size / 2;
    const unbounded = gridWidth < 0 || gridHeight < 0;
    const startCol = unbounded ? Math.floor((centerX - radius) / cellSize)
      : Math.max(0, Math.floor((centerX - radius) / cellSize));
    const endCol = unbounded ? Math.ceil((centerX + radius) / cellSize)
      : Math.min(gridWidth - 1, Math.ceil((centerX + radius) / cellSize));
    const startRow = unbounded ? Math.floor((centerY - radius) / cellSize)
      : Math.max(0, Math.floor((centerY - radius) / cellSize));
    const endRow = unbounded ? Math.ceil((centerY + radius) / cellSize)
      : Math.min(gridHeight - 1, Math.ceil((centerY + radius) / cellSize));
    if (startCol > endCol || startRow > endRow) return null;

    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        const cellCenterX = col * cellSize + cellSize / 2;
        const cellCenterY = row * cellSize + cellSize / 2;
        const dx = cellCenterX - centerX;
        const dy = cellCenterY - centerY;
        const weight = this.getWeight(dx, dy);
        if (weight > 0.15) cb(row, col, weight);
      }
    }

    return {
      x: startCol * cellSize,
      y: startRow * cellSize,
      width: (endCol - startCol + 1) * cellSize,
      height: (endRow - startRow + 1) * cellSize,
    };
  }

  /**
   * 笔刷涂抹到网格
   * @param {Uint8Array} grid - 地形网格数据
   * @param {number} gridWidth - 网格宽度
   * @param {number} gridHeight - 网格高度
   * @param {number} centerX - 笔刷中心X（像素坐标）
   * @param {number} centerY - 笔刷中心Y（像素坐标）
   * @param {number} cellSize - 每个格子的像素大小
   * @returns {Object} 受影响的区域边界 { x, y, width, height }
   */
  paint(grid, gridWidth, gridHeight, centerX, centerY, cellSize) {
    const type = this.terrainType;
    return this.forEachCell(gridWidth, gridHeight, centerX, centerY, cellSize, (row, col) => {
      grid[row * gridWidth + col] = type;
    });
  }

  /**
   * 枚举两点之间插值落点会碰到的格子（**不写数据**；与 `paintInterpolated` 同一份采样）。
   */
  forEachInterpolatedCell(x1, y1, x2, y2, cellSize, cb) {
    const dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
    const steps = Math.max(1, Math.floor(dist / (this.size / 4)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      cb(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
    }
  }

  /**
   * 在两个点之间插值涂抹（用于快速移动时填补空隙）
   */
  paintInterpolated(grid, gridWidth, gridHeight, x1, y1, x2, y2, cellSize) {
    let bounds = null;
    this.forEachInterpolatedCell(x1, y1, x2, y2, cellSize, (x, y) => {
      const b = this.paint(grid, gridWidth, gridHeight, x, y, cellSize);
      if (!b) return;
      if (!bounds) bounds = b;
      else {
        const maxX = Math.max(bounds.x + bounds.width, b.x + b.width);
        const maxY = Math.max(bounds.y + bounds.height, b.y + b.height);
        bounds.x = Math.min(bounds.x, b.x);
        bounds.y = Math.min(bounds.y, b.y);
        bounds.width = maxX - bounds.x;
        bounds.height = maxY - bounds.y;
      }
    });
    return bounds;
  }
}

/**
 * 获取地形颜色（带轻微噪点纹理）
 */
export function getTerrainColor(terrainIdx, x, y) {
  const t = TERRAIN_TYPES[terrainIdx] || TERRAIN_TYPES[0];
  // 基于坐标生成确定性噪点
  const noise = ((x * 7 + y * 13) % 5) - 2;
  return [
    Math.max(0, Math.min(255, t.base[0] + noise)),
    Math.max(0, Math.min(255, t.base[1] + noise)),
    Math.max(0, Math.min(255, t.base[2] + noise))
  ];
}
