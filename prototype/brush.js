/**
 * TerrainBrush - 地形笔刷引擎
 * 核心思想：笔刷不是"放置顶点"，而是"在画布上涂抹"
 */
class TerrainBrush {
  constructor() {
    this.size = 30;        // 笔刷直径（像素）
    this.hardness = 0.5;   // 边缘硬度（0=柔和, 1=硬边）
    this.terrainType = 2;  // 当前绘制的地形类型索引（默认草地）
    this.minSize = 5;
    this.maxSize = 100;
  }

  getWeight(dx, dy) {
    const dist = Math.sqrt(dx * dx + dy * dy);
    const radius = this.size / 2;
    if (dist >= radius) return 0;
    const normalizedDist = dist / radius;
    if (this.hardness === 0) return 1 - normalizedDist;
    return Math.pow(1 - normalizedDist, 1 / (this.hardness * 0.99 + 0.01));
  }

  paint(grid, gridWidth, gridHeight, centerX, centerY, cellSize) {
    const radius = this.size / 2;
    const startCol = Math.max(0, Math.floor((centerX - radius) / cellSize));
    const endCol = Math.min(gridWidth - 1, Math.ceil((centerX + radius) / cellSize));
    const startRow = Math.max(0, Math.floor((centerY - radius) / cellSize));
    const endRow = Math.min(gridHeight - 1, Math.ceil((centerY + radius) / cellSize));
    
    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        const cellCenterX = col * cellSize + cellSize / 2;
        const cellCenterY = row * cellSize + cellSize / 2;
        const dx = cellCenterX - centerX;
        const dy = cellCenterY - centerY;
        const weight = this.getWeight(dx, dy);
        if (weight > 0.15) {
          grid[row * gridWidth + col] = this.terrainType;
        }
      }
    }
    
    return {
      x: startCol * cellSize,
      y: startRow * cellSize,
      width: (endCol - startCol + 1) * cellSize,
      height: (endRow - startRow + 1) * cellSize
    };
  }

  paintInterpolated(grid, gridWidth, gridHeight, x1, y1, x2, y2, cellSize) {
    const dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
    const steps = Math.max(1, Math.floor(dist / (this.size / 4)));
    let bounds = null;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x1 + (x2 - x1) * t;
      const y = y1 + (y2 - y1) * t;
      const b = this.paint(grid, gridWidth, gridHeight, x, y, cellSize);
      if (!bounds) bounds = b;
      else {
        bounds.x = Math.min(bounds.x, b.x);
        bounds.y = Math.min(bounds.y, b.y);
        bounds.width = Math.max(bounds.x + bounds.width, b.x + b.width) - bounds.x;
        bounds.height = Math.max(bounds.y + bounds.height, b.y + b.height) - bounds.y;
      }
    }
    return bounds;
  }
}

/**
 * TerrainRenderer - 地形渲染器（简化版，避免 createPattern 兼容性问题）
 */
class TerrainRenderer {
  constructor(canvas, gridWidth, gridHeight) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.gridWidth = gridWidth;
    this.gridHeight = gridHeight;
    this.cellSize = canvas.width / gridWidth;
    
    this.terrains = [
      { name: '海洋', base: [41, 98, 168], texture: [30, 80, 140] },
      { name: '沙滩', base: [210, 190, 140], texture: [190, 170, 120] },
      { name: '草地', base: [86, 150, 70], texture: [70, 130, 55] },
      { name: '森林', base: [34, 100, 34], texture: [20, 80, 20] },
      { name: '沙漠', base: [210, 180, 120], texture: [190, 160, 100] },
      { name: '山脉', base: [130, 110, 90], texture: [100, 85, 70] },
      { name: '雪地', base: [230, 235, 240], texture: [210, 215, 220] },
      { name: '岩石', base: [100, 100, 100], texture: [80, 80, 80] }
    ];
  }

  /**
   * 获取地形颜色（带轻微噪点纹理）
   */
  getTerrainColor(terrainIdx, x, y) {
    const t = this.terrains[terrainIdx] || this.terrains[0];
    // 基于坐标生成确定性噪点
    const noise = ((x * 7 + y * 13) % 5) - 2;
    return [
      Math.max(0, Math.min(255, t.base[0] + noise)),
      Math.max(0, Math.min(255, t.base[1] + noise)),
      Math.max(0, Math.min(255, t.base[2] + noise))
    ];
  }

  render(grid) {
    const ctx = this.ctx;
    const cellSize = this.cellSize;
    
    for (let row = 0; row < this.gridHeight; row++) {
      for (let col = 0; col < this.gridWidth; col++) {
        const terrainIdx = grid[row * this.gridWidth + col];
        const color = this.getTerrainColor(terrainIdx, col, row);
        ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
        ctx.fillRect(col * cellSize, row * cellSize, cellSize + 0.5, cellSize + 0.5);
      }
    }
  }

  renderRegion(grid, region) {
    const ctx = this.ctx;
    const cellSize = this.cellSize;
    const startCol = Math.max(0, Math.floor(region.x / cellSize));
    const startRow = Math.max(0, Math.floor(region.y / cellSize));
    const endCol = Math.min(this.gridWidth - 1, Math.floor((region.x + region.width) / cellSize));
    const endRow = Math.min(this.gridHeight - 1, Math.floor((region.y + region.height) / cellSize));
    
    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        const terrainIdx = grid[row * this.gridWidth + col];
        const color = this.getTerrainColor(terrainIdx, col, row);
        ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
        ctx.fillRect(col * cellSize, row * cellSize, cellSize + 0.5, cellSize + 0.5);
      }
    }
  }
}

/**
 * UndoManager - 撤销管理器（基于网格快照）
 */
class UndoManager {
  constructor(maxSteps = 50) {
    this.maxSteps = maxSteps;
    this.undoStack = [];
    this.redoStack = [];
    this.gridSnapshot = null;
  }

  beginStroke(grid, width, height) {
    this.gridSnapshot = new Uint8Array(grid);
  }

  endStroke() {
    if (this.gridSnapshot === null) return;
    this.undoStack.push({ snapshot: this.gridSnapshot });
    this.gridSnapshot = null;
    this.redoStack = [];
    if (this.undoStack.length > this.maxSteps) this.undoStack.shift();
  }

  undo() {
    if (this.undoStack.length === 0) return null;
    const state = this.undoStack.pop();
    this.redoStack.push(state);
    return state;
  }

  redo() {
    if (this.redoStack.length === 0) return null;
    const state = this.redoStack.pop();
    this.undoStack.push(state);
    return state;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.gridSnapshot = null;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
}

/**
 * LayerManager - 图层管理器
 */
class LayerManager {
  constructor() {
    this.layers = [
      { id: 'terrain', name: '基础地形', visible: true },
      { id: 'features', name: '特征覆盖', visible: true },
      { id: 'labels', name: '标签', visible: true },
      { id: 'grid', name: '网格', visible: false }
    ];
    this.activeLayer = 'terrain';
  }

  toggle(layerId) {
    const layer = this.layers.find(l => l.id === layerId);
    if (layer) layer.visible = !layer.visible;
  }

  isVisible(layerId) {
    const layer = this.layers.find(l => l.id === layerId);
    return layer ? layer.visible : false;
  }
}
