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

// ===== 罗马数字轨道排序（标准化命名 衡佑Ⅲ / 津廊Ⅵd / 衡佑Ⅲa） =====
// 轨道顺序应来自世界观数据（罗马数字），而非文件扫描顺序；无数字者保持原序（稳定排序）
const ROMAN_CHARS = { 'Ⅰ': 1, 'Ⅱ': 2, 'Ⅲ': 3, 'Ⅳ': 4, 'Ⅴ': 5, 'Ⅵ': 6, 'Ⅶ': 7, 'Ⅷ': 8, 'Ⅸ': 9, 'Ⅹ': 10, 'Ⅺ': 11, 'Ⅻ': 12 };

function asciiRomanValue(tok) {
  const V = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  let total = 0;
  for (let i = 0; i < tok.length; i++) {
    const v = V[tok[i]];
    const next = V[tok[i + 1]] || 0;
    total += v < next ? -v : v;
  }
  return total;
}

// 从 displayName/name/tags 提取轨道序号（首个罗马数字）；无则 Infinity
export function planetOrbitOrderKey(node) {
  const sources = [node.displayName, node.name, ...(node.tags || [])];
  for (const s of sources) {
    if (!s) continue;
    for (const ch of s) {
      if (ROMAN_CHARS[ch]) return ROMAN_CHARS[ch];
    }
  }
  for (const s of sources) {
    if (!s) continue;
    const m = s.match(/(?:^|[^A-Za-z])([IVXLC]{1,6})(?![A-Za-z])/);
    if (m) {
      const v = asciiRomanValue(m[1]);
      if (v > 0) return v;
    }
  }
  return Infinity;
}

// 稳定排序：按轨道序号升序，同号（含卫星 Ⅲa）保持原相对顺序
export function sortPlanetsByOrbit(list) {
  return list
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (planetOrbitOrderKey(a.p) - planetOrbitOrderKey(b.p)) || (a.i - b.i))
    .map(x => x.p);
}
