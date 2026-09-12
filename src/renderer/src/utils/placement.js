/**
 * placement.js — 智能放置算法（聚落 / 道路）
 * 
 * 基于高度图数据计算最佳聚落位置和道路路径。
 * 纯函数，无副作用。
 */
import { SEA_LEVEL } from './heightMath';

/**
 * 计算网格点坡度（基于邻居高度差）
 */
export function calculateSlope(heightmap, grid, index) {
  const pts = grid.points;
  const spacing = grid.spacing || 14.4;
  const h = heightmap[index];
  const px = Array.isArray(pts[index]) ? pts[index][0] : pts[index].x;
  const py = Array.isArray(pts[index]) ? pts[index][1] : pts[index].y;
  let maxDiff = 0;
  let count = 0;
  for (let j = 0; j < pts.length; j++) {
    if (j === index) continue;
    const qx = Array.isArray(pts[j]) ? pts[j][0] : pts[j].x;
    const qy = Array.isArray(pts[j]) ? pts[j][1] : pts[j].y;
    const d = Math.hypot(qx - px, qy - py);
    if (d < spacing * 1.5) {
      const diff = Math.abs(heightmap[j] - h);
      if (diff > maxDiff) maxDiff = diff;
      count++;
    }
  }
  return count > 0 ? maxDiff / count : 0;
}

/**
 * 找最近水源（海洋或河流）的距离
 */
export function distanceToWater(heightmap, grid, index) {
  const pts = grid.points;
  const spacing = grid.spacing || 14.4;
  const px = Array.isArray(pts[index]) ? pts[index][0] : pts[index].x;
  const py = Array.isArray(pts[index]) ? pts[index][1] : pts[index].y;
  let minDist = Infinity;
  for (let j = 0; j < pts.length; j++) {
    if (heightmap[j] < SEA_LEVEL) {
      const qx = Array.isArray(pts[j]) ? pts[j][0] : pts[j].x;
      const qy = Array.isArray(pts[j]) ? pts[j][1] : pts[j].y;
      const d = Math.hypot(qx - px, qy - py);
      if (d < minDist) minDist = d;
    }
  }
  return minDist === Infinity ? 999 : minDist / spacing; // 返回步数
}

/**
 * 智能聚落放置：点击某点，找附近最优位置
 * 规则：避开海洋(h<20)和高山(h>70)，偏好中等海拔，靠近水源
 */
export function findOptimalBurgPosition(heightmap, grid, clickX, clickY) {
  const pts = grid.points;
  const spacing = grid.spacing || 14.4;
  const searchRadius = 100; // 世界坐标像素
  let best = null;
  let bestScore = -Infinity;

  for (let i = 0; i < pts.length; i++) {
    const h = heightmap[i];
    if (h < SEA_LEVEL || h > 70) continue; // 避开海洋和高山

    const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
    const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
    const clickDist = Math.hypot(px - clickX, py - clickY);
    if (clickDist > searchRadius) continue;

    // 评分
    let score = 0;
    score -= Math.abs(h - 40) * 0.1; // 偏好中等海拔
    const waterDist = distanceToWater(heightmap, grid, i);
    if (waterDist < 5) score += (5 - waterDist) * 8; // 靠近水源加分
    const slope = calculateSlope(heightmap, grid, i);
    score -= slope * 0.5; // 避开陡坡
    score -= clickDist * 0.05; // 偏好靠近点击点

    if (score > bestScore) {
      bestScore = score;
      best = { index: i, x: px, y: py, h, score };
    }
  }
  return best;
}

/**
 * 简化版道路生成：A* 路径（沿等高线偏好）
 * 从 start 到 end，优先选择高度变化小的路径
 */
export function generateRoadPath(heightmap, grid, startIdx, endIdx) {
  const pts = grid.points;
  const spacing = grid.spacing || 14.4;
  const n = pts.length;
  const maxStep = spacing * 1.5;

  // 邻居查找：预计算邻接表
  const neighbors = new Array(n);
  for (let i = 0; i < n; i++) {
    neighbors[i] = [];
    const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
    const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const qx = Array.isArray(pts[j]) ? pts[j][0] : pts[j].x;
      const qy = Array.isArray(pts[j]) ? pts[j][1] : pts[j].y;
      const d = Math.hypot(qx - px, qy - py);
      if (d < maxStep) neighbors[i].push(j);
    }
  }

  // A* 简化（贪心，不做完整优先队列，网格小够用）
  const cameFrom = new Int32Array(n).fill(-1);
  const gScore = new Float32Array(n).fill(Infinity);
  const fScore = new Float32Array(n).fill(Infinity);
  const closed = new Uint8Array(n);
  const open = [startIdx];
  gScore[startIdx] = 0;
  const ex = Array.isArray(pts[endIdx]) ? pts[endIdx][0] : pts[endIdx].x;
  const ey = Array.isArray(pts[endIdx]) ? pts[endIdx][1] : pts[endIdx].y;
  const sx = Array.isArray(pts[startIdx]) ? pts[startIdx][0] : pts[startIdx].x;
  const sy = Array.isArray(pts[startIdx]) ? pts[startIdx][1] : pts[startIdx].y;
  fScore[startIdx] = Math.hypot(ex - sx, ey - sy);

  while (open.length > 0) {
    // 取 f 最小
    let bestI = 0;
    for (let i = 1; i < open.length; i++) {
      if (fScore[open[i]] < fScore[open[bestI]]) bestI = i;
    }
    const current = open[bestI];
    open.splice(bestI, 1);

    if (current === endIdx) {
      // 回溯
      const path = [];
      let c = endIdx;
      while (c !== -1) { path.push(c); c = cameFrom[c]; }
      return path.reverse();
    }

    closed[current] = 1;
    const cx = Array.isArray(pts[current]) ? pts[current][0] : pts[current].x;
    const cy = Array.isArray(pts[current]) ? pts[current][1] : pts[current].y;

    for (const nb of neighbors[current]) {
      if (closed[nb]) continue;
      const hDiff = Math.abs(heightmap[nb] - heightmap[current]);
      if (hDiff > 15) continue; // 避开陡峭
      const dist = Math.hypot(
        (Array.isArray(pts[nb]) ? pts[nb][0] : pts[nb].x) - cx,
        (Array.isArray(pts[nb]) ? pts[nb][1] : pts[nb].y) - cy
      );
      const tentative = gScore[current] + dist + hDiff * 2;
      if (tentative < gScore[nb]) {
        cameFrom[nb] = current;
        gScore[nb] = tentative;
        const nx = Array.isArray(pts[nb]) ? pts[nb][0] : pts[nb].x;
        const ny = Array.isArray(pts[nb]) ? pts[nb][1] : pts[nb].y;
        fScore[nb] = tentative + Math.hypot(ex - nx, ey - ny);
        if (!open.includes(nb)) open.push(nb);
      }
    }
  }
  return []; // 无路径
}

/**
 * 最近聚落/网格点查找
 */
export function findNearestGridPoint(heightmap, grid, worldX, worldY) {
  const pts = grid.points;
  let bestI = -1;
  let bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
    const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
    const d = Math.hypot(px - worldX, py - worldY);
    if (d < bestD) { bestD = d; bestI = i; }
  }
  return bestI;
}
