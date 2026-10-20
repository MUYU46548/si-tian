// utils/strokeMath.js — 笔迹纯函数层（T7，2026-10-19）
//
// 为什么单独一层：perfect-freehand 是 ESM 裸模块，Node 单测的 data: 导入解析不到；
// 把「点格式转换 / 速度→宽度 / outline→SVG」这些纯函数放这里，Node 可直接单测，
// `strokeEngine.js` 只做对 perfect-freehand 的薄封装（由 Vite/CDP 覆盖）。

/** 司天点（{x,y,pressure?} 或 [x,y,p]）→ perfect-freehand 输入点 */
export function toStrokeInput(points, defaultPressure = 0.5) {
  const out = [];
  for (const p of points || []) {
    if (!p) continue;
    const x = Array.isArray(p) ? Number(p[0]) : Number(p.x);
    const y = Array.isArray(p) ? Number(p[1]) : Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const raw = Array.isArray(p) ? p[2] : p.pressure;
    const pressure = Number.isFinite(Number(raw)) ? Number(raw) : defaultPressure;
    out.push([x, y, Math.max(0, Math.min(1, pressure))]);
  }
  return out;
}

/**
 * 速度 → 宽度（0.4~2 倍），返回与 points 等长的数组。
 * 没有时间戳，用**相邻采样点间距**当速度代理：拖得越快，采样越稀。
 * 🔴 用**绝对参考间距**（默认 8px），不要用本次笔迹的中位数归一化 ——
 *    中位数会把“整条都很快”和“整条都很慢”都归一成 1，宽度就恒定了（T7-spike 实测踩到）。
 * @param {Array} points
 * @param {{base?:number,min?:number,max?:number,speedScale?:number,referenceGap?:number}} [opts]
 */
export function widthsBySpeed(points, opts = {}) {
  const base = Number.isFinite(opts.base) ? opts.base : 1;
  const min = Number.isFinite(opts.min) ? opts.min : 0.4;
  const max = Number.isFinite(opts.max) ? opts.max : 2;
  const speedScale = Number.isFinite(opts.speedScale) ? opts.speedScale : 1.6;
  const reference = Number.isFinite(opts.referenceGap) && opts.referenceGap > 0 ? opts.referenceGap : 8;
  const pts = (points || []).filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)));
  if (!pts.length) return [];
  const gaps = [];
  for (let i = 1; i < pts.length; i++) {
    gaps.push(Math.hypot(Number(pts[i].x) - Number(pts[i - 1].x), Number(pts[i].y) - Number(pts[i - 1].y)));
  }
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const gap = i === 0 ? (gaps[0] || 0) : gaps[i - 1];
    const norm = Math.min(2, gap / reference);
    const w = base * (min + (max - min) * Math.min(1, norm / speedScale));
    out[i] = +Math.max(base * min, Math.min(base * max, w)).toFixed(3);
  }
  return out;
}

/**
 * 把一串标量按弧长线性重采样到 count 个（河宽因子从手迹点映射到落库节点）。
 * 输入不足 2 个时用首值/1 填满；不产生 NaN。
 */
export function resampleSeries(values, count) {
  const n = Math.max(0, Number(count) || 0);
  const src = (values || []).map(Number).filter((v) => Number.isFinite(v));
  if (!n) return [];
  if (!src.length) return new Array(n).fill(1);
  if (src.length === 1) return new Array(n).fill(src[0]);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : (i / (n - 1)) * (src.length - 1);
    const lo = Math.floor(t);
    const hi = Math.min(src.length - 1, lo + 1);
    const k = t - lo;
    out[i] = src[lo] * (1 - k) + src[hi] * k;
  }
  return out;
}

/** outline 点数组（[x,y][]）→ SVG path（README 的 midpoint 二次曲线写法） */export function outlineToSvgPath(points, closed = true) {
  const avg = (a, b) => (a + b) / 2;
  const len = (points || []).length;
  if (len < 4) return '';
  let a = points[0];
  let b = points[1];
  const c = points[2];
  let result = `M${a[0].toFixed(2)},${a[1].toFixed(2)} Q${b[0].toFixed(2)},${b[1].toFixed(2)} `
    + `${avg(b[0], c[0]).toFixed(2)},${avg(b[1], c[1]).toFixed(2)} T`;
  for (let i = 2; i < len - 1; i++) {
    a = points[i];
    b = points[i + 1];
    result += `${avg(a[0], b[0]).toFixed(2)},${avg(a[1], b[1]).toFixed(2)} `;
  }
  return closed ? result + 'Z' : result.trim();
}

/** outline 总长度（诊断用：确认笔锋/轮廓没被压扁） */
export function outlineLength(points) {
  let s = 0;
  for (let i = 1; i < (points || []).length; i++) {
    s += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return s;
}
