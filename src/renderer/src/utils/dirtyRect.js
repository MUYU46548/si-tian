/**
 * utils/dirtyRect.js — 笔刷脏矩形追踪（P2-3）
 *
 * 背景：PlanetMap 的笔刷渲染此前是**每帧全画布重绘**（clearRect(0,0,w,h) → 重绘所有层）。
 * 网格密（>200×200）或图标/标记多时，一次涂抹的绝大部分时间花在重绘与落点无关的区域。
 *
 * 做法：笔刷拖动时把「受影响矩形」交给 DirtyRectTracker，渲染器只清脏区 + 在脏区裁剪内
 * 重绘场景。因为场景绘制是确定性的、不做跨区域累加，所以「清脏区 + 裁剪重绘」的结果与
 * 全画布重绘在该区域内**逐像素等价**（不会出现接缝/残影）。
 *
 * 坐标约定：本模块存的是**世界坐标**矩形（笔刷天然知道世界半径）。渲染器在变换后
 * （translate+scale）直接 clearRect/clip 该矩形。面积占比判断需要换算到画布像素，
 * 因此 shouldFullRedraw 需要传当前 scale。
 *
 * 安全兜底（宁可多画一帧，不可画错）：
 *  - 脏矩形总面积 > 画布 50% → 回退全画布
 *  - 合并后的包围盒 > 画布 60% → 回退全画布（避免为了省一点面积去裁剪一个大框）
 *  - 缩放/平移（viewTransform 变化）或 fastMode 切换 → 由渲染器强制全画布
 */

/** 归一化矩形（负宽高转正）；非法/零面积返回 null */
export function normalizeRect(r) {
  if (!r) return null;
  const x1 = Math.min(r.x, r.x + r.w);
  const y1 = Math.min(r.y, r.y + r.h);
  const x2 = Math.max(r.x, r.x + r.w);
  const y2 = Math.max(r.y, r.y + r.h);
  if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) return null;
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function rectArea(r) {
  return r ? Math.max(0, r.w) * Math.max(0, r.h) : 0;
}

/** 相交或相切（含容差 epsilon）都算需要合并 —— 相切的矩形合并后能少一次 clip 切换 */
export function rectsOverlap(a, b, epsilon = 0) {
  if (!a || !b) return false;
  return a.x - epsilon < b.x + b.w && b.x - epsilon < a.x + a.w
      && a.y - epsilon < b.y + b.h && b.y - epsilon < a.y + a.h;
}

export function unionRect(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x1 = Math.min(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.w, b.x + b.w);
  const y2 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** 反复合并所有相交/相切的矩形，直到稳定。n 很小（笔刷一次拖动通常 1~10 个） */
export function mergeRects(rects, epsilon = 0) {
  let out = (rects || []).filter(Boolean).map(r => ({ ...r }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (rectsOverlap(out[i], out[j], epsilon)) {
          out[i] = unionRect(out[i], out[j]);
          out.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  return out;
}

/**
 * 笔刷从 a 滑到 b 时覆盖的世界矩形（两端各含 radius 半径）。
 * 必须**同时**包含上一个落点：只报新落点会把上一帧的笔迹/光标环留在画布上（拖尾）。
 */
export function brushSegmentRect(a, b, radius) {
  const r = Math.max(1, radius || 0);
  const xs = [];
  const ys = [];
  if (a && Number.isFinite(a.x)) { xs.push(a.x); ys.push(a.y); }
  if (b && Number.isFinite(b.x)) { xs.push(b.x); ys.push(b.y); }
  if (!xs.length) return null;
  const minX = Math.min(...xs) - r;
  const maxX = Math.max(...xs) + r;
  const minY = Math.min(...ys) - r;
  const maxY = Math.max(...ys) + r;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export class DirtyRectTracker {
  /**
   * @param {object} opts
   *   marginPx     安全边距（屏幕像素，防止边缘接缝/抗锯齿溢出），默认 3
   *   maxRects     合并后矩形数上限，超出则并成包围盒，默认 16
   *   fullRedrawRatio  脏面积 / 画布面积 超过该比例即回退全画布，默认 0.5
   *   bboxRatio    包围盒 / 画布面积 超过该比例即回退全画布，默认 0.6
   */
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    this.marginPx = opts.marginPx ?? 3;
    this.maxRects = opts.maxRects ?? 16;
    this.fullRedrawRatio = opts.fullRedrawRatio ?? 0.5;
    this.bboxRatio = opts.bboxRatio ?? 0.6;
    this._rects = [];
    this._scale = 1;
    this._full = false;      // 显式要求一次全画布
    this.addCount = 0;       // 诊断用：累计 add 次数
  }

  /** 渲染器每帧同步当前缩放：边距是世界单位，必须按 scale 折算 */
  setScale(scale) {
    const s = Number(scale);
    if (Number.isFinite(s) && s > 0) this._scale = s;
  }

  get marginWorld() {
    return this.marginPx / this._scale;
  }

  /** 请求一次全画布重绘（缩放/平移/图层样式变化等） */
  markFull() {
    this._full = true;
    this._rects = [];
  }

  get fullRequested() {
    return this._full;
  }

  add(rect) {
    if (!this.enabled || this._full) return this;
    const r = normalizeRect(rect);
    if (!r) return this;
    const m = this.marginWorld;
    this._rects.push({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });
    this.addCount++;
    // 攒太多就即时合并一次，避免数组无限增长（长按涂抹会 add 上千次）
    if (this._rects.length > this.maxRects * 2) this.merge();
    return this;
  }

  /** 圆形笔刷落点 → 外接正方形（省掉每帧三角函数） */
  addCircle(cx, cy, radius) {
    const r = Math.max(1, radius || 0);
    return this.add({ x: cx - r, y: cy - r, w: 2 * r, h: 2 * r });
  }

  /** 合并当前所有脏矩形（就地），返回合并后的数组 */
  merge() {
    this._rects = mergeRects(this._rects, 0);
    if (this._rects.length > this.maxRects) {
      const bb = this.boundingBox();
      this._rects = bb ? [bb] : [];
    }
    return this._rects;
  }

  getRects() {
    return this._rects;
  }

  get count() {
    return this._rects.length;
  }

  get isEmpty() {
    return this._rects.length === 0;
  }

  clear() {
    this._rects = [];
    this._full = false;
  }

  /** 合并后的脏矩形总面积（世界单位²） */
  totalArea() {
    const rects = this.merge();
    let a = 0;
    for (const r of rects) a += rectArea(r);
    return a;
  }

  /** 合并后的包围盒（世界坐标）；空时返回 null */
  boundingBox() {
    const rects = this._rects;
    if (!rects.length) return null;
    let out = { ...rects[0] };
    for (let i = 1; i < rects.length; i++) out = unionRect(out, rects[i]);
    return out;
  }

  /**
   * 是否应回退全画布重绘。
   * @param {number} canvasW 画布宽（像素）
   * @param {number} canvasH 画布高（像素）
   * @param {number} scale   当前缩放（世界 → 屏幕）
   */
  shouldFullRedraw(canvasW, canvasH, scale) {
    if (this._full) return true;
    if (!this._rects.length) return false;
    const px = Number.isFinite(scale) && scale > 0 ? scale : this._scale;
    const canvasArea = canvasW * canvasH;
    if (!(canvasArea > 0)) return true;
    const dirtyArea = this.totalArea() * px * px;
    if (dirtyArea > canvasArea * this.fullRedrawRatio) return true;
    const bb = this.boundingBox();
    if (bb && rectArea(bb) * px * px > canvasArea * this.bboxRatio) return true;
    return false;
  }
}
