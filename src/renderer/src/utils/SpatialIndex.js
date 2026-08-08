/**
 * SimpleGridIndex - 均匀网格空间索引
 * 用于加速命中测试和视口裁剪
 */
export class SimpleGridIndex {
  constructor(cellSize = 200) {
    this.cellSize = cellSize;
    this.cells = new Map();
    this.itemMap = new Map(); // itemId -> { minX, minY, maxX, maxY, data }
  }

  _key(cx, cy) {
    return `${cx},${cy}`;
  }

  clear() {
    this.cells.clear();
    this.itemMap.clear();
  }

  insert(id, minX, minY, maxX, maxY, data) {
    this.remove(id);
    
    const cs = this.cellSize;
    const cx0 = Math.floor(minX / cs);
    const cy0 = Math.floor(minY / cs);
    const cx1 = Math.floor(maxX / cs);
    const cy1 = Math.floor(maxY / cs);

    const item = { minX, minY, maxX, maxY, data, cells: [] };
    this.itemMap.set(id, item);

    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const key = this._key(cx, cy);
        if (!this.cells.has(key)) {
          this.cells.set(key, []);
        }
        this.cells.get(key).push(id);
        item.cells.push(key);
      }
    }
  }

  remove(id) {
    const item = this.itemMap.get(id);
    if (!item) return;
    
    for (const key of item.cells) {
      const cell = this.cells.get(key);
      if (cell) {
        const idx = cell.indexOf(id);
        if (idx !== -1) cell.splice(idx, 1);
        if (cell.length === 0) this.cells.delete(key);
      }
    }
    this.itemMap.delete(id);
  }

  query(minX, minY, maxX, maxY) {
    const cs = this.cellSize;
    const cx0 = Math.floor(minX / cs);
    const cy0 = Math.floor(minY / cs);
    const cx1 = Math.floor(maxX / cs);
    const cy1 = Math.floor(maxY / cs);

    const results = new Set();
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const cell = this.cells.get(this._key(cx, cy));
        if (cell) {
          for (const id of cell) {
            results.add(id);
          }
        }
      }
    }
    return results;
  }

  queryPoint(x, y) {
    const cs = this.cellSize;
    const cx = Math.floor(x / cs);
    const cy = Math.floor(y / cs);
    const cell = this.cells.get(this._key(cx, cy));
    if (!cell) return [];
    return [...cell];
  }

  getAll() {
    return [...this.itemMap.keys()];
  }
}
