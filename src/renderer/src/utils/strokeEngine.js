// utils/strokeEngine.js — perfect-freehand 的薄封装（T7，2026-10-19）
//
// 只做三件事：把司天点转成库输入、取平滑中心线、取笔迹轮廓多边形。
// 纯计算在 `strokeMath.js`（Node 可测）；本文件由 Vite/CDP 覆盖（裸模块解析）。
//
// 口径：
//   · `smoothStrokePoints` 给“河流中心线 / 自由轮廓”做稳定与重采样（替代自写 Chaikin + 抽稀）；
//   · `strokeOutline` / `strokePolygon` 给“像手画的线”用：输出是**带自交的轮廓**，
//     需要填色时交给 polygon-clipping 压平（司天已有该依赖）；
//   · 不在这里改数据、不碰 store —— 组件决定把结果写到哪里。
import { getStroke, getStrokePoints } from 'perfect-freehand';
import { toStrokeInput, widthsBySpeed, outlineToSvgPath, outlineLength } from './strokeMath';

export const STROKE_DEFAULTS = {
  size: 8,
  thinning: 0.5,
  smoothing: 0.5,
  streamline: 0.5,
  simulatePressure: true,
  last: true,
};

/** 平滑中心线：返回 [{x,y,pressure,distance,runningLength}]（点数与输入同量级） */
export function smoothStrokePoints(points, opts = {}) {
  const input = toStrokeInput(points, opts.pressure);
  if (input.length < 2) {
    return (points || []).map((p) => ({ x: Number(p.x), y: Number(p.y), pressure: 0.5 }));
  }
  const out = getStrokePoints(input, { ...STROKE_DEFAULTS, ...opts });
  return out.map((p) => ({
    x: p.point[0],
    y: p.point[1],
    pressure: p.pressure,
    distance: p.distance,
    runningLength: p.runningLength,
  }));
}

/** 笔迹轮廓：返回 [[x,y], ...]（可能自交；填色前用 polygon-clipping.union([outline]) 压平） */
export function strokeOutline(points, opts = {}) {
  const input = toStrokeInput(points, opts.pressure);
  if (input.length < 2) return [];
  return getStroke(input, { ...STROKE_DEFAULTS, ...opts });
}

/** 笔迹轮廓 → 司天点（便于 Canvas path 或后续布尔） */
export function strokePolygon(points, opts = {}) {
  return strokeOutline(points, opts).map(([x, y]) => ({ x, y }));
}

export { widthsBySpeed, outlineToSvgPath, outlineLength };
