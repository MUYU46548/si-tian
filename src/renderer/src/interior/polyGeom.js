// interior/polyGeom.js — 平面几何小工具（凸包 / 最小外接矩形）
//
// ## 为什么单独一个文件（2026-11-16）
//
// 这两个函数原来在 `buildShell.js` 里，但 `buildFootprint`（墙矩形并集）也要用它们，
// 而 `buildFootprint` 现在被 **屋顶** 用（异形平面按矩形拆分，见 `buildShell.js` 的屋顶段）。
// 留在 buildShell 里就会形成 `buildShell → footprint → buildShell` 的循环 import。
// 抽到这一层之后依赖是单向的：`footprint / buildingSymbol / buildShell → polyGeom`。
//
// 纯函数：不 import 任何东西、不碰 DOM、不用随机数。

export function convexHull(points) {
  const pts = [...points].sort((a, b) => (a.x - b.x) || (a.y - b.y));
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-6) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-6) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/**
 * 最小面积外接矩形（旋转卡壳）。返回 { cx, cy, ux, uy, halfW, halfD }：
 * 中心、长轴单位向量、沿长轴的半长、垂直长轴的半宽（cm）。
 */
export function minAreaRect(hull) {
  const n = hull.length;
  if (n < 3) return null;
  let best = null;
  for (let i = 0; i < n; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-6)) continue;
    const ux = dx / len;
    const uy = dy / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const pu = p.x * ux + p.y * uy;
      const pv = -p.x * uy + p.y * ux;
      minU = Math.min(minU, pu); maxU = Math.max(maxU, pu);
      minV = Math.min(minV, pv); maxV = Math.max(maxV, pv);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area - 1e-6) {
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = {
        area,
        // 反投影回平面坐标：p = u * cu + v * cv
        cx: cu * ux - cv * uy,
        cy: cu * uy + cv * ux,
        ux, uy,
        halfU: (maxU - minU) / 2,
        halfV: (maxV - minV) / 2,
      };
    }
  }
  if (!best) return null;
  // 长轴统一：让 ux,uy 指长边方向
  if (best.halfU < best.halfV) {
    return {
      cx: best.cx, cy: best.cy,
      ux: -best.uy, uy: best.ux,
      halfW: best.halfV, halfD: best.halfU,
    };
  }
  return { cx: best.cx, cy: best.cy, ux: best.ux, uy: best.uy, halfW: best.halfU, halfD: best.halfV };
}
