/**
 * **地形注记的自动生成与合并**（2026-11-04，生成阶段做全内容第一刀）。
 *
 * 背景（暮雨）：“编辑器是用户少量微调精修才用的，不要指望着用户一条一条全部手动改，
 * 在生成阶段就搞定绝大部分内容。” —— 地形注记（山系 / 海域 / 平原的名字）以前只能
 * 在面板里点“检测山脊”再逐条起名，等于把一整个制图工序留给用户手点。
 *
 * 本文件负责两件事，都是**纯函数**（Node 单测：`scripts/tests/unit/test_terrain_labels.js`）：
 *   ① `buildAutoTerrainLabels(hm, opts)` —— 从一份高度图里**确定性**地生出带名字的注记；
 *      同 seed + 同高度图 = 同名字、同顺序、同 id（不读 Date.now / Math.random）。
 *   ② `mergeAutoTerrainLabels(existing, generated, opts)` —— 生成时**只补空**的合并口径：
 *      某一种注记（range / sea / plain）只要已有条目，这一种就一条都不加（用户的地图解释优先）。
 *
 * 几何检测**不在这里重新写**：山脊仍走 `utils/ridges.js#detectRidges`，平滑/抽稀仍走
 * `polylineSmooth` / `contour`（与“地形注记”面板同一份实现）。
 */
import { detectRidges } from './ridges';
import { smoothPolyline } from './polylineSmooth';
import { simplifyContour } from './contour';
import { makeRng } from './voronoiBatch';

export const TERRAIN_LABEL_VERSION = 1;
export const TERRAIN_LABEL_KINDS = Object.freeze(['range', 'sea', 'plain']);

// ── 命名字库（确定性取名用；与用户可改的名字同一字段，不另建体系）─────────────
const RANGE_A = Object.freeze(['苍', '玄', '雪', '雾', '铁', '青', '赤', '寒', '昆', '崇', '白', '乌', '岚', '霜', '祁', '峻']);
const RANGE_B = Object.freeze(['岚', '岩', '屏', '脊', '崖', '峰', '峨', '峦', '岑', '嶂']);
const RANGE_TAIL = Object.freeze(['山脉', '山系', '岭', '群山']);
const SEA_A = Object.freeze(['幽', '碧', '沧', '玄', '镜', '潮', '星', '霜', '澜', '暮', '晴', '远']);
const SEA_B = Object.freeze(['澜', '溟', '涛', '潮', '渊', '汐', '波', '沙', '霞', '浦']);
const SEA_TAIL = Object.freeze(['海', '海', '洋', '海']);
const PLAIN_A = Object.freeze(['丰', '沃', '平', '青', '长', '广', '嘉', '禾', '安', '阳', '润', '原']);
const PLAIN_B = Object.freeze(['禾', '川', '野', '畴', '浦', '泽', '陇', '原', '坪', '甸']);
const PLAIN_TAIL = Object.freeze(['原', '川', '平原', '野']);

const SALT = { range: 11, sea: 23, plain: 37 };

const worldOf = (p) => (Array.isArray(p)
  ? { x: Number(p[0]) || 0, y: Number(p[1]) || 0 }
  : { x: Number(p && p.x) || 0, y: Number(p && p.y) || 0 });

/** 确定性取名（同 seed / 同 kind / 同序号 = 同名；**词干**重了就换一个再试） */
function pickName(kind, seed, index, used, stems) {
  const bank = kind === 'sea'
    ? [SEA_A, SEA_B, SEA_TAIL]
    : (kind === 'plain' ? [PLAIN_A, PLAIN_B, PLAIN_TAIL] : [RANGE_A, RANGE_B, RANGE_TAIL]);
  const [A, B, TAIL] = bank;
  // 只避“全名重复”不够：同一张图上出现“雾峦山脉”+“雾峦群山”时，读图的人会以为
  // 是同一个地方的两个名字（两块大字叠在一起时尤其糊）。所以**词干也避重**。
  for (let attempt = 0; attempt < 48; attempt++) {
    const rng = makeRng(((seed + 1) * 2654435761 + SALT[kind] * 7919 + index * 131 + attempt * 17) >>> 0);
    const a = A[Math.floor(rng() * A.length) % A.length];
    const b = B[Math.floor(rng() * B.length) % B.length];
    const tail = TAIL[Math.floor(rng() * TAIL.length) % TAIL.length];
    const stem = `${a}${b}`;
    const name = `${stem}${tail}`;
    if (!used.has(name) && !stems.has(stem)) {
      used.add(name);
      stems.add(stem);
      return name;
    }
  }
  for (let i = 0; i < A.length; i++) {
    const stem = `${A[i]}${B[(index + i) % B.length]}`;
    const name = `${stem}${TAIL[0]}`;
    if (!used.has(name) && !stems.has(stem)) {
      used.add(name);
      stems.add(stem);
      return name;
    }
  }
  const fallback = `${A[index % A.length]}${B[index % B.length]}${TAIL[0]}${index + 1}`;
  used.add(fallback);
  return fallback;
}

/**
 * 4 邻域连通组。只返回面积达标的分量，按面积降序（确定性：并列时取下标小的）。
 * @param {Uint8Array} mask 0/1
 * @returns {Array<{cells:number[], area:number, touchesBorder:boolean, cx:number, cy:number}>}
 */
function components(mask, cols, rows, minArea) {
  const n = cols * rows;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const out = [];
  for (let start = 0; start < n; start++) {
    if (!mask[start] || seen[start]) continue;
    let top = 0;
    let area = 0;
    let sx = 0;
    let sy = 0;
    let touchesBorder = false;
    const cells = [];
    stack[top++] = start;
    seen[start] = 1;
    while (top > 0) {
      const i = stack[--top];
      const x = i % cols;
      const y = (i / cols) | 0;
      cells.push(i);
      area++;
      sx += x;
      sy += y;
      if (x === 0 || y === 0 || x === cols - 1 || y === rows - 1) touchesBorder = true;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < cols - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && mask[i - cols] && !seen[i - cols]) { seen[i - cols] = 1; stack[top++] = i - cols; }
      if (y < rows - 1 && mask[i + cols] && !seen[i + cols]) { seen[i + cols] = 1; stack[top++] = i + cols; }
    }
    if (area < minArea) continue;
    out.push({ cells, area, touchesBorder, cx: sx / area, cy: sy / area });
  }
  out.sort((a, b) => (b.area - a.area) || (a.cells[0] - b.cells[0]));
  return out;
}

/**
 * 一片水域/低地的**主轴线段**（海域注记沿它排字）。
 * 用单元中心坐标做 2×2 协方差 → 主轴方向 → 投影取两端，返回值是**世界坐标**两点。
 */
function axisSegment(comp, grid, cols) {
  const pts = grid.points || [];
  const sp = Number(grid.spacing) || 10;
  let sx = 0, sy = 0, m = 0;
  const xs = [];
  const ys = [];
  for (const i of comp.cells) {
    const p = pts[i] ? worldOf(pts[i]) : { x: (i % cols) * sp, y: ((i / cols) | 0) * sp };
    xs.push(p.x); ys.push(p.y);
    sx += p.x; sy += p.y; m++;
  }
  if (!m) return null;
  const mx = sx / m;
  const my = sy / m;
  let cxx = 0, cyy = 0, cxy = 0;
  for (let k = 0; k < m; k++) {
    const dx = xs[k] - mx;
    const dy = ys[k] - my;
    cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
  }
  cxx /= m; cyy /= m; cxy /= m;
  // 主轴方向：θ = ½·atan2(2·cxy, cxx − cyy)
  const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < m; k++) {
    const t = (xs[k] - mx) * ux + (ys[k] - my) * uy;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return [{ x: mx + ux * lo, y: my + uy * lo }, { x: mx + ux * hi, y: my + uy * hi }];
}

/**
 * 从高度图**确定性**生成一版地形注记（山系 / 海域 / 平原）。
 *
 * @param {{h:ArrayLike<number>, grid:{cellsX:number, cellsY:number, points:Array, spacing?:number}}} hm
 * @param {object} [opts]
 * @param {number} [opts.seed=7] 与地形同种子（同 seed 同名字）
 * @param {number} [opts.seaLevel=20]
 * @param {number} [opts.maxRanges=6] 山系最多几条（按脊线长度降序）
 * @param {number} [opts.maxSeas=2] 海域最多几片（按面积降序，只取通到图边的）
 * @param {number} [opts.maxPlains=2] 平原最多几块（低海拔连通块，按面积降序）
 * @param {string[]} [opts.usedNames] 已有的名字（自动避重）
 * @returns {{labels:Array<{id:string,kind:string,name:string,points:Array<{x:number,y:number}>,origin:'auto'}>,
 *            stats:{ranges:number, seas:number, plains:number}}}
 */
export function buildAutoTerrainLabels(hm, opts = {}) {
  const empty = { labels: [], stats: { ranges: 0, seas: 0, plains: 0 } };
  const grid = hm && hm.grid;
  const h = hm && hm.h;
  if (!grid || !h || !h.length || !grid.points) return empty;
  const cols = grid.cellsX | 0;
  const rows = grid.cellsY | 0;
  const n = cols * rows;
  if (!(cols > 2) || !(rows > 2) || n > h.length) return empty;

  const seaLevel = Number.isFinite(opts.seaLevel) ? opts.seaLevel : 20;
  const spacing = Number(grid.spacing) > 0 ? Number(grid.spacing) : 10;
  const seed = Math.max(0, Math.floor(Number(opts.seed) || 7));
  const maxRanges = Math.max(0, Math.floor(Number.isFinite(opts.maxRanges) ? opts.maxRanges : 6));
  const maxSeas = Math.max(0, Math.floor(Number.isFinite(opts.maxSeas) ? opts.maxSeas : 2));
  const maxPlains = Math.max(0, Math.floor(Number.isFinite(opts.maxPlains) ? opts.maxPlains : 2));
  const used = new Set((Array.isArray(opts.usedNames) ? opts.usedNames : []).map((s) => String(s || '').trim()).filter(Boolean));
  // 词干也避重（同图上“雾峦山脉”+“雾峦群山”会被读成一个地方的两个名字）
  const stems = new Set();
  const labels = [];
  let ranges = 0, seas = 0, plains = 0;

  // ① 山系：脊线检测 + 抽稀（与面板同一份几何实现）
  if (maxRanges) {
    let ridges = [];
    try {
      ridges = detectRidges(
        { h, grid },
        { seaLevel, maxRidges: Math.max(3, maxRanges * 2), smooth: (pts) => smoothPolyline(pts, 2) },
      );
    } catch (e) {
      ridges = [];
    }
    const eps = Math.max(3, spacing * 0.35);
    for (const r of ridges) {
      if (ranges >= maxRanges) break;
      const raw = Array.isArray(r.points) ? r.points : [];
      if (raw.length < 2) continue;
      let points = [];
      try {
        points = simplifyContour(raw, eps);
      } catch (e) {
        points = [];
      }
      if (points.length < 2) points = raw;
      if (points.length < 2) continue;
      labels.push({
        id: `auto_range_${seed}_${ranges}`,
        kind: 'range',
        name: pickName('range', seed, ranges, used, stems),
        points: points.map(worldOf),
        origin: 'auto',
      });
      ranges++;
    }
  }

  // ② 海域：水格连通块里**通到图边**的那些（湖不算海域），按面积取前几
  if (maxSeas) {
    const water = new Uint8Array(n);
    for (let i = 0; i < n; i++) water[i] = ((h[i] || 0) < seaLevel) ? 1 : 0;
    const minArea = Math.max(8, Math.round(n * 0.004));
    const seaComps = components(water, cols, rows, minArea).filter((c) => c.touchesBorder);
    for (const comp of seaComps) {
      if (seas >= maxSeas) break;
      const seg = axisSegment(comp, grid, cols);
      if (!seg) continue;
      labels.push({
        id: `auto_sea_${seed}_${seas}`,
        kind: 'sea',
        name: pickName('sea', seed, seas, used, stems),
        points: seg,
        origin: 'auto',
      });
      seas++;
    }
  }

  // ③ 平原：低海拔陆格连通块（海平面往上一个带），按面积取前几，落成**一个点**
  if (maxPlains) {
    let maxH = seaLevel;
    for (let i = 0; i < n; i++) { const v = Number(h[i]) || 0; if (v > maxH) maxH = v; }
    const band = Math.max(6, Math.round((maxH - seaLevel) * 0.16));
    const low = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const v = Number(h[i]) || 0;
      low[i] = (v >= seaLevel && v <= seaLevel + band) ? 1 : 0;
    }
    const minArea = Math.max(10, Math.round(n * 0.01));
    const plainComps = components(low, cols, rows, minArea);
    for (const comp of plainComps) {
      if (plains >= maxPlains) break;
      const pts = grid.points;
      const i = comp.cells[Math.floor(comp.cells.length / 2)];
      const p = pts[i] ? worldOf(pts[i]) : { x: comp.cx * spacing, y: comp.cy * spacing };
      labels.push({
        id: `auto_plain_${seed}_${plains}`,
        kind: 'plain',
        name: pickName('plain', seed, plains, used, stems),
        points: [p],
        origin: 'auto',
      });
      plains++;
    }
  }

  return { labels, stats: { ranges, seas, plains } };
}

/**
 * **只补空**的合并口径（生成时用）：用户认过的注记优先，机器过去生成的可被新地形替换。
 *
 * 三条规则：
 *   ① `origin: 'user'`（手画/面板里新建的）**原样保留**，且它占住的那种注记一条都不再加；
 *   ② `origin: 'auto'`（上一次生成/检测出来的）**默认丢掉重算**（`replaceAuto: false` 可留）——
 *      地形换了、旧名字还指着一座已经不在的山，比没有名字更糟；
 *   ③ 新生成的条目避开已有名字（同图叠字）。
 *
 * @param {Array} existing 落盘里的 `terrainLabels`
 * @param {Array} generated `buildAutoTerrainLabels` 的 labels
 * @param {object} [opts]
 * @param {boolean} [opts.onlyFillKinds=true] 关掉 = 每种都追加（只避重名）
 * @param {boolean} [opts.replaceAuto=true] 关掉 = 保留旧的自动注记（不重算）
 * @param {number} [opts.maxLabels=24] 上限（防极端地形堆到几十条）
 * @returns {Array} 合并后的整表（不修改入参）
 */
export function mergeAutoTerrainLabels(existing, generated, opts = {}) {
  const onlyFillKinds = opts.onlyFillKinds !== false;
  const replaceAuto = opts.replaceAuto !== false;
  const maxLabels = Math.max(1, Math.floor(Number.isFinite(opts.maxLabels) ? opts.maxLabels : 24));
  const out = [];
  const names = new Set();
  const kinds = new Set();
  const stems = new Set();
  for (const it of (Array.isArray(existing) ? existing : [])) {
    if (!it || typeof it !== 'object') continue;
    const name = String(it.name || '').trim();
    if (!name) continue;
    const kind = TERRAIN_LABEL_KINDS.indexOf(it.kind) >= 0 ? it.kind : 'range';
    const points = (Array.isArray(it.points) ? it.points : []).map(worldOf);
    if (points.length < (kind === 'plain' ? 1 : 2)) continue;
    const origin = it.origin === 'auto' ? 'auto' : 'user';
    if (origin === 'auto' && replaceAuto) continue;   // 旧的自动注记：让位给这一版地形
    out.push({ id: String(it.id || `tl_${out.length}`), kind, name, points, origin });
    names.add(name);
    kinds.add(kind);
    stems.add(name.slice(0, 2));
  }
  for (const g of (Array.isArray(generated) ? generated : [])) {
    if (out.length >= maxLabels) break;
    if (!g || TERRAIN_LABEL_KINDS.indexOf(g.kind) < 0) continue;
    if (onlyFillKinds && kinds.has(g.kind)) continue;
    const name = String(g.name || '').trim();
    if (!name || names.has(name) || stems.has(name.slice(0, 2))) continue;
    const points = (Array.isArray(g.points) ? g.points : []).map(worldOf);
    if (points.length < (g.kind === 'plain' ? 1 : 2)) continue;
    out.push({ id: String(g.id || `auto_${out.length}`), kind: g.kind, name, points, origin: 'auto' });
    names.add(name);
    stems.add(name.slice(0, 2));
  }
  return out;
}
