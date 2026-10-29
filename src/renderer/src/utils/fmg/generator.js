// utils/fmg/generator.js — 高度图模板解释器（B 阶段 2 第一步，2026-10-29）
//
// 逐工具移植 SP-1025/Upstream Azgaar 的 `heightmap-generator.ts`（MIT，见文件头），
// 唯一实质改动 = **所有随机从显式 `rng` 来**（上游靠全局 `Math.random = alea(seed)`，见 `rng.js` 的说明）。
//
// ── 为什么用"类"而不是纯函数 ──────────────────────────────────────────────────
// 模板是**有状态的脚本**（heights 被一步一步改）。上游是 class；这里保留同样形态，
// 但实例只在一次生成里活（`generateHeightmap` 内部 new），不导出全局单例 —— 并发/重复调用互不影响。
//
// ── 与上游的差异（必须写清，别让后人以为"逐字节同构"）──────────────────────────
//   ① 邻居表：这里是规则方阵的 **8 邻居**（`lattice.buildAdjacency`），上游是 Voronoi 邻接。
//      → 同一模板画出来的地貌**长得像**，但不是逐字节相同。判据只保证**本实现**同 seed 一致。
//   ② `heights` 用 Uint8Array（与上游一致）：`change` 数组的中间值会被截断成整数 ——
//      这是上游的真实行为，不要"顺手修成浮点"，那会改变所有模板的观感。
//
// 许可：Azgaar MIT。

/*
 * Copyright 2017-2024 Max Haniyeu (Azgaar)
 * SPDX-License-Identifier: MIT
 * Source: Azgaar/Fantasy-Map-Generator @ 67d555b8, src/model/physical/heightmap-generator.ts
 * Modifications: options/map singletons replaced with explicit seed & config (this port:
 *                 explicit rng); fromPrecreated (image templates, needs DOM) dropped; logger dropped.
 */

import { clampHeight, numberInRange } from './rng';
import { findSlot } from './lattice';

const BLOB_POWER_MAP = {
  1000: 0.93, 2000: 0.95, 5000: 0.97, 10000: 0.98, 20000: 0.99, 30000: 0.991,
  40000: 0.993, 50000: 0.994, 60000: 0.995, 70000: 0.9955, 80000: 0.996,
  90000: 0.9964, 100000: 0.9973,
};
const LINE_POWER_MAP = {
  1000: 0.75, 2000: 0.77, 5000: 0.79, 10000: 0.81, 20000: 0.82, 30000: 0.83,
  40000: 0.84, 50000: 0.86, 60000: 0.87, 70000: 0.88, 80000: 0.91,
  90000: 0.92, 100000: 0.93,
};

const blobPowerFor = (cells) => BLOB_POWER_MAP[cells] || 0.98;
const linePowerFor = (cells) => LINE_POWER_MAP[cells] || 0.81;

const meanOf = (arr) => {
  let total = 0;
  let count = 0;
  for (const v of arr) {
    if (Number.isNaN(v)) continue;
    total += v;
    count++;
  }
  return count ? total / count : NaN;
};

/** d3 `leastIndex` 等价（找比较函数下最小者的下标） */
function leastIndex(array, compare) {
  if (!array || !array.length) return undefined;
  let best = 0;
  for (let i = 1; i < array.length; i++) if (compare(array[i], array[best]) < 0) best = i;
  return best;
}

export class HeightmapGenerator {
  constructor(lattice, rng, opts = {}) {
    this.lattice = lattice;          // { cellsX, cellsY, spacing, points, c }
    this.rng = rng;
    this.width = Number(opts.width) || 0;
    this.height = Number(opts.height) || 0;
    this.cellsDesired = Number(opts.cellsDesired) || lattice.cellsX * lattice.cellsY;
    this.blobPower = blobPowerFor(this.cellsDesired);
    this.linePower = linePowerFor(this.cellsDesired);
    this.heights = null;
  }

  /** 落点（百分比区间 → 世界坐标）；`rangeX/rangeY` 形如 `"20-80"` */
  pointInRange(range, length) {
    if (typeof range !== 'string') return undefined;
    const min = parseInt(range.split('-')[0], 10) / 100 || 0;
    const max = parseInt(range.split('-')[1], 10) / 100 || min;
    return this.rng.range(min * length, max * length);
  }

  cellAt(x, y) {
    return findSlot(x, y, this.lattice);
  }

  addHill(count, height, rangeX, rangeY) {
    const addOneHill = () => {
      const grid = this.lattice;
      if (!this.heights) return;
      const change = new Uint8Array(this.heights.length);
      let limit = 0;
      let start;
      const h = clampHeight(numberInRange(height, this.rng));

      do {
        const x = this.pointInRange(rangeX, this.width);
        const y = this.pointInRange(rangeY, this.height);
        if (x === undefined || y === undefined) return;
        start = this.cellAt(x, y);
        limit++;
      } while (this.heights[start] + h > 90 && limit < 50);
      change[start] = h;
      const queue = [start];
      while (queue.length) {
        const q = queue.shift();
        for (const c of grid.c[q]) {
          if (change[c]) continue;
          change[c] = change[q] ** this.blobPower * (this.rng.next() * 0.2 + 0.9);
          if (change[c] > 1) queue.push(c);
        }
      }
      this.heights = this.heights.map((hh, i) => clampHeight(hh + change[i]));
    };

    const desired = numberInRange(count, this.rng);
    for (let i = 0; i < desired; i++) addOneHill();
  }

  addPit(count, height, rangeX, rangeY) {
    const addOnePit = () => {
      const grid = this.lattice;
      if (!this.heights) return;
      const used = new Uint8Array(this.heights.length);
      let limit = 0;
      let start;
      let h = clampHeight(numberInRange(height, this.rng));

      do {
        const x = this.pointInRange(rangeX, this.width);
        const y = this.pointInRange(rangeY, this.height);
        if (x === undefined || y === undefined) return;
        start = this.cellAt(x, y);
        limit++;
      } while (this.heights[start] < 20 && limit < 50);

      const queue = [start];
      while (queue.length) {
        const q = queue.shift();
        h = h ** this.blobPower * (this.rng.next() * 0.2 + 0.9);
        if (h < 1) return;
        for (const c of grid.c[q]) {
          if (used[c] || !this.heights) continue;
          this.heights[c] = clampHeight(this.heights[c] - h * (this.rng.next() * 0.2 + 0.9));
          used[c] = 1;
          queue.push(c);
        }
      }
    };

    const desired = numberInRange(count, this.rng);
    for (let i = 0; i < desired; i++) addOnePit();
  }

  /**
   * 山脊 / 海槽（**同一份实现**，`sign=+1` 山脊、`sign=-1` 海槽）。
   * 上游是两段几乎逐字相同的代码（addRange / addTrough）—— 这里合成一份：
   * 差别只有"加还是减"，合成后不会再出现"修了山脊忘了海槽"。
   */
  addRidge({ count, height, rangeX, rangeY, sign = 1, randomness = 0.2, maxDistRatio = 1 / 3 }) {
    const addOne = () => {
      const grid = this.lattice;
      if (!this.heights) return;
      const used = new Uint8Array(this.heights.length);
      let h = clampHeight(numberInRange(height, this.rng));

      const getRange = (from, to) => {
        const range = [from];
        const p = grid.points;
        used[from] = 1;
        let cur = from;
        while (cur !== to) {
          let min = Infinity;
          for (const e of grid.c[cur]) {
            if (used[e]) continue;
            let diff = (p[to][0] - p[e][0]) ** 2 + (p[to][1] - p[e][1]) ** 2;
            if (this.rng.next() > 1 - randomness) diff /= 2;
            if (diff < min) {
              min = diff;
              cur = e;
            }
          }
          if (min === Infinity) return range;
          range.push(cur);
          used[cur] = 1;
        }
        return range;
      };

      let startCell;
      let endCell;
      if (rangeX && rangeY) {
        const startX = this.pointInRange(rangeX, this.width);
        const startY = this.pointInRange(rangeY, this.height);
        if (startX === undefined || startY === undefined) return;
        startCell = this.cellAt(startX, startY);
        // 海槽的上游多一条"起点必须在陆地上"的重试
        let limit = 0;
        while (sign < 0 && this.heights[startCell] < 20 && limit < 50) {
          const x = this.pointInRange(rangeX, this.width);
          const y = this.pointInRange(rangeY, this.height);
          if (x === undefined || y === undefined) return;
          startCell = this.cellAt(x, y);
          limit++;
        }
        let dist = 0;
        let endX;
        let endY;
        let tries = 0;
        do {
          endX = this.rng.next() * this.width * 0.8 + this.width * 0.1;
          endY = this.rng.next() * this.height * 0.7 + this.height * 0.15;
          dist = Math.abs(endY - startY) + Math.abs(endX - startX);
          tries++;
        } while ((dist < this.width / 8 || dist > this.width * maxDistRatio) && tries < 50);
        endCell = this.cellAt(endX, endY);
      } else {
        return;
      }

      const range = getRange(startCell, endCell);
      let queue = range.slice();
      let i = 0;
      while (queue.length) {
        const frontier = queue.slice();
        queue = [];
        i++;
        for (const idx of frontier) {
          if (!this.heights) return;
          this.heights[idx] = clampHeight(this.heights[idx] + sign * h * (this.rng.next() * 0.3 + 0.85));
        }
        h = h ** this.linePower - 1;
        if (h < 2) break;
        for (const f of frontier) {
          for (const idx of grid.c[f]) {
            if (used[idx]) continue;
            queue.push(idx);
            used[idx] = 1;
          }
        }
      }

      // 山嘴/支脉：沿脊线每 6 格往下切一条
      for (let d = 0; d < range.length; d += 6) {
        let cur = range[d];
        for (let l = 0; l < i; l++) {
          const index = leastIndex(grid.c[cur], (a, b) => this.heights[a] - this.heights[b]);
          if (index === undefined) continue;
          const min = grid.c[cur][index];
          this.heights[min] = (this.heights[cur] * 2 + this.heights[min]) / 3;
          cur = min;
        }
      }
    };

    const desired = numberInRange(count, this.rng);
    for (let i = 0; i < desired; i++) addOne();
  }

  addStrait(width, direction = 'vertical') {
    const grid = this.lattice;
    if (!this.heights) return;
    const desiredWidth = Math.min(numberInRange(width, this.rng), grid.cellsX / 3);
    if (desiredWidth < 1) return;
    const used = new Uint8Array(this.heights.length);
    const vert = direction !== 'horizontal';
    const startX = vert ? Math.floor(this.rng.next() * this.width * 0.4 + this.width * 0.3) : 5;
    const startY = vert ? 5 : Math.floor(this.rng.next() * this.height * 0.4 + this.height * 0.3);
    const endX = vert
      ? Math.floor(this.width - startX - this.width * 0.1 + this.rng.next() * this.width * 0.2)
      : this.width - 5;
    const endY = vert
      ? this.height - 5
      : Math.floor(this.height - startY - this.height * 0.1 + this.rng.next() * this.height * 0.2);

    const start = this.cellAt(startX, startY);
    const end = this.cellAt(endX, endY);

    const getRange = (from, to) => {
      const range = [];
      const p = grid.points;
      let cur = from;
      let guard = 0;
      while (cur !== to && guard++ < 4000) {
        let min = Infinity;
        let next = cur;
        for (const e of grid.c[cur]) {
          let diff = (p[to][0] - p[e][0]) ** 2 + (p[to][1] - p[e][1]) ** 2;
          if (this.rng.next() > 0.8) diff /= 2;
          if (diff < min) {
            min = diff;
            next = e;
          }
        }
        if (next === cur) break;
        cur = next;
        range.push(cur);
      }
      return range;
    };

    let range = getRange(start, end);
    let query = [];
    const step = 0.1 / Math.max(1, desiredWidth);

    for (let i = 0; i < desiredWidth; i++) {
      const remaining = desiredWidth - i;
      const exp = 0.9 - step * remaining;
      for (const r of range) {
        for (const e of grid.c[r]) {
          if (used[e]) continue;
          used[e] = 1;
          query.push(e);
          this.heights[e] **= exp;
          if (this.heights[e] > 100) this.heights[e] = 5;
        }
      }
      range = query.slice();
      query = [];
    }
  }

  /** `Add` / `Multiply`（上游 `modify`） */
  modify(range, add, mult, power) {
    if (!this.heights) return;
    const min = range === 'land' ? 20 : range === 'all' ? 0 : +String(range).split('-')[0];
    const max = range === 'land' || range === 'all' ? 100 : +String(range).split('-')[1];
    const isLand = min === 20;

    this.heights = this.heights.map((h) => {
      if (h < min || h > max) return h;
      let v = h;
      if (add) v = isLand ? Math.max(v + add, 20) : v + add;
      if (mult !== 1) v = isLand ? (v - 20) * mult + 20 : v * mult;
      if (power) v = isLand ? (v - 20) ** power + 20 : v ** power;
      return clampHeight(v);
    });
  }

  smooth(fr = 2, add = 0) {
    const grid = this.lattice;
    if (!this.heights) return;
    this.heights = this.heights.map((h, i) => {
      const a = [h];
      for (const c of grid.c[i]) a.push(this.heights[c]);
      if (fr === 1) return meanOf(a) + add;
      return clampHeight((h * (fr - 1) + meanOf(a) + add) / fr);
    });
  }

  mask(power = 1) {
    const grid = this.lattice;
    if (!this.heights) return;
    const fr = power ? Math.abs(power) : 1;
    this.heights = this.heights.map((h, i) => {
      const [x, y] = grid.points[i];
      const nx = (2 * x) / this.width - 1;
      const ny = (2 * y) / this.height - 1;
      let distance = (1 - nx ** 2) * (1 - ny ** 2);
      if (power < 0) distance = 1 - distance;
      const masked = h * distance;
      return clampHeight((h * (fr - 1) + masked) / fr);
    });
  }

  invert(count, axes) {
    if (!this.rng.chance(count) || !this.heights) return;
    const invertX = axes !== 'y';
    const invertY = axes !== 'x';
    const { cellsX, cellsY } = this.lattice;
    const src = this.heights;
    const inverted = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const x = i % cellsX;
      const y = Math.floor(i / cellsX);
      const nx = invertX ? cellsX - x - 1 : x;
      const ny = invertY ? cellsY - y - 1 : y;
      inverted[i] = src[nx + ny * cellsX];
    }
    this.heights = inverted;
  }

  addStep(tool, a2, a3, a4, a5) {
    switch (tool) {
      case 'Hill': return this.addHill(a2, a3, a4, a5);
      case 'Pit': return this.addPit(a2, a3, a4, a5);
      case 'Range': return this.addRidge({ count: a2, height: a3, rangeX: a4, rangeY: a5, sign: 1, randomness: 0.15, maxDistRatio: 1 / 3 });
      case 'Trough': return this.addRidge({ count: a2, height: a3, rangeX: a4, rangeY: a5, sign: -1, randomness: 0.2, maxDistRatio: 1 / 2 });
      case 'Strait': return this.addStrait(a2, a3);
      case 'Mask': return this.mask(+a2);
      case 'Invert': return this.invert(+a2, a3);
      case 'Add': return this.modify(a3, +a2, 1);
      case 'Multiply': return this.modify(a3, 0, +a2);
      case 'Smooth': return this.smooth(+a2);
      default:
        throw new Error(`高度图模板：未知工具「${tool}」`);
    }
  }

  /**
   * 执行模板脚本。
   * @param {Uint8Array} initialHeights 起始高度（全 0 = 全海；上游从 map 的当前高度开始）
   * @param {string} script
   * @returns {Uint8Array}
   */
  run(initialHeights, script) {
    this.heights = Uint8Array.from(initialHeights);
    const steps = String(script).split('\n');
    if (!steps.length) throw new Error('高度图模板：没有步骤');
    for (const line of steps) {
      const text = line.trim();
      if (!text) continue;
      const el = text.split(/\s+/);
      if (el.length < 2) throw new Error(`高度图模板：步骤字段不足 ——「${text}」`);
      this.addStep(el[0], el[1], el[2] ?? '0', el[3] ?? '0', el[4] ?? '0');
    }
    return this.heights || new Uint8Array(initialHeights.length);
  }
}
