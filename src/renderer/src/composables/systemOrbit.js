/**
 * 单恒星系行星轨道布局（确定性算法，批次 B4 抽取为共享 composable）
 *
 * 与原 SystemView.applyLayout / createPlanet 内联公式逐一等价：
 *   orbit = floor(pIdx / 3) + 1        每圈 3 颗，轨道号从 1 起
 *   posInOrbit = pIdx % 3
 *   angle = (posInOrbit / 3) * 2π + orbit * 0.4
 *   orbitRadius = 40 + orbit * 35
 *
 * 禁止在此引入随机数（渲染抖动红线）。
 */

export function planetOrbitLayout(pIdx) {
  const orbit = Math.floor(pIdx / 3) + 1;
  const posInOrbit = pIdx % 3;
  const angle = (posInOrbit / 3) * Math.PI * 2 + orbit * 0.4;
  const orbitRadius = 40 + orbit * 35;
  return { orbit, posInOrbit, angle, orbitRadius };
}

// 轨道环绘制参数（与 SystemView.drawSystemOrbits 一致：40 起步、步长 35）
export const ORBIT_RING_START = 40;
export const ORBIT_RING_STEP = 35;

// 行星配色/半径（与原 SystemView 本地常量一致，抽取共享避免两视图漂移）
const PLANET_COLORS = { planet: '#5cb85c', city: '#f0ad4e', town: '#d9853b', location: '#888888' };
const PLANET_RADII = { planet: 7, city: 5, town: 4, location: 3 };

export function getPlanetColor(layer) {
  return PLANET_COLORS[layer] || '#888888';
}

export function getPlanetRadius(layer) {
  return PLANET_RADII[layer] || 3;
}
