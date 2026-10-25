// utils/landmass.js — **造陆**：按参数生成大陆/群岛轮廓（纯函数，零 DOM/Vue，Node 可测；2026-10-25）
//
// ── v2 重写（2026-10-25 用户实测判词：「像几坨面团，怎么摇种子都很丑」）────────────
//   v1 是"每块大陆一个径向噪声圆" —— 无论噪声多碎，轮廓都围绕一个圆心，得到的必然是
//   汤圆/面团；真实海岸线不是这样长的。v2 换成**标量场 + 等值线**：
//     ① **大陆掩膜**：N 个"平顶 + 缓坡"椭圆凸起（位置由确定性抖动网格给，长条/群岛改形状与数量）；
//     ② **分形噪声**：5~6 个八度的值噪声（每层旋转坐标，避免栅格纹）+ **域扭曲**
//        （用另一层噪声把采样坐标揉一下）—— 这是"半岛、海湾、岬角"的来源；
//     ③ **按目标占比取分位数**定阈值：陆地占比不再是"大概"，而是**精确**到 ±0.5%；
//     ④ **marching squares** 沿等值线取闭合环（线性插值 → 不是方块边），再 Chaikin 平滑
//        + RDP 简化；**湖泊（洞）挂到包含它的陆块环上**（省份模型支持多环带洞）。
//   判据（`test_landmass.js`）：同参数可复现、占比命中、不重叠、不出界、
//   海岸复杂度（周长/√面积）随 roughness 上升、长条/群岛的形状口径。
//
//   ⚠️ 随机只来自 `makeRng(seed)`（位置/相位）与整数哈希噪声（场）—— 同 seed 同结果。

import { makeRng } from './voronoiBatch';

export const LANDMASS_VERSION = 2;

export const LAND_SHAPES = Object.freeze([
  { id: 'continent', name: '圆润大陆', aspect: 0.78, spread: 0.36, noiseAmp: 0.42, freq: 2.6 },
  { id: 'elongated', name: '长条大陆', aspect: 0.45, spread: 0.30, noiseAmp: 0.40, freq: 2.2 },
  { id: 'archipelago', name: '群岛', aspect: 0.92, spread: 0.30, noiseAmp: 0.62, freq: 4.2 },
]);

const shapeOf = (id) => LAND_SHAPES.find((s) => s.id === id) || LAND_SHAPES[0];

// ── 噪声 ──────────────────────────────────────────────────────────────────
function hash2(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}
const smooth = (t) => t * t * (3 - 2 * t);
function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const tx = smooth(x - xi), ty = smooth(y - yi);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  const top = a + (b - a) * tx;
  const bot = c + (d - c) * tx;
  return top + (bot - top) * ty;
}
/** 分形噪声：每层旋转 37°，避免值噪声把栅格方向印到海岸上；返回 [-1,1] */
function fbm(x, y, seed, octaves = 5) {
  let sum = 0, amp = 1, norm = 0, f = 1, rot = 0;
  for (let o = 0; o < octaves; o++) {
    const r = rot * (Math.PI / 180);
    const c = Math.cos(r), s = Math.sin(r);
    const nx = (x * c - y * s) * f, ny = (x * s + y * c) * f;
    sum += (valueNoise(nx + 13.7, ny - 7.3, seed + o * 101) - 0.5) * 2 * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.02;
    rot += 37;
  }
  return norm > 0 ? sum / norm : 0;
}

// ── 场地形 ────────────────────────────────────────────────────────────────
/**
 * 生成标量场（0..1，越高越"内陆"）：N 个椭圆高斯凸起 × 分形噪声。
 * @returns {{field:Float32Array, cols:number, rows:number, box:object, spacing:number, level:number}}
 */
function buildField(params, bbox) {
  const seed = Math.max(0, Math.floor(Number(params.seed) || 7));
  const count = Math.max(1, Math.min(8, Math.floor(Number(params.continentCount) || 3)));
  const landRatio = Math.max(0.05, Math.min(0.75, Number(params.landRatio) || 0.32));
  const roughness = Math.max(0, Math.min(1, Number(params.roughness) || 0.45));
  const sizeVariance = Math.max(0, Math.min(1, Number(params.sizeVariance) || 0.4));
  const shape = shapeOf(params.shape);

  const W = Math.max(1, bbox.maxX - bbox.minX);
  const H = Math.max(1, bbox.maxY - bbox.minY);
  const longSide = Math.max(W, H);
  // 场分辨率：长边 ~360 格（海岸细节与耗时的折中；marching squares 后还会被平滑/简化）
  const spacing = longSide / 360;
  const cols = Math.max(24, Math.ceil(W / spacing) + 1);
  const rows = Math.max(24, Math.ceil(H / spacing) + 1);
  const n = cols * rows;
  const rng = makeRng(seed * 2654435761 + 17);

  // ① 大陆凸起：抖动网格给位置；椭圆半径按"目标面积 / 块数"反推
  const cx0 = (bbox.minX + bbox.maxX) / 2;
  const cy0 = (bbox.minY + bbox.maxY) / 2;
  const gcols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const grows = Math.max(1, Math.ceil(count / gcols));
  const targetArea = W * H * landRatio;
  const weights = [];
  for (let i = 0; i < count; i++) weights.push(1 + (rng() - 0.5) * 2 * sizeVariance * 1.4);
  const wsum = weights.reduce((a, b) => a + b, 0);

  const bumps = [];
  for (let i = 0; i < count; i++) {
    const area = targetArea * (weights[i] / wsum);
    // 椭圆面积 π·rx·ry；ry = rx·aspect → rx = sqrt(area/(π·aspect))
    const rx0 = Math.sqrt(area / (Math.PI * shape.aspect));
    const ry0 = rx0 * shape.aspect;
    // 槽位内缩：半径不超过格子的 42% —— 陆块才不会贴到地图边框（贴边会被裁成"直边"）
    const cellW = W / gcols, cellH = H / grows;
    const rx = Math.max(spacing * 2, Math.min(rx0, cellW * 0.42));
    const ry = Math.max(spacing * 2, Math.min(ry0, cellH * 0.42));
    const cc = i % gcols, cr = Math.floor(i / gcols);
    const jx = (rng() - 0.5) * 0.45, jy = (rng() - 0.5) * 0.45;
    bumps.push({
      x: bbox.minX + (cc + 0.5 + jx) * (W / gcols),
      y: bbox.minY + (cr + 0.5 + jy) * (H / grows),
      // ⚠️ 半径 = **面积椭圆本身**（不再 ×1.35）。之前的高斯尾巴让 0.5 等值线缩到 0.7r，
      //    为了凑占比只能把底半径放大 → 超出槽位高度 → 3 块大陆在竖直方向必然粘连成一块。
      rx: Math.max(spacing * 2, rx),
      ry: Math.max(spacing * 2, ry),
      rot: shape.id === 'elongated'
        ? (rng() - 0.5) * 0.25
        : (rng() - 0.5) * 0.7,
    });
  }
  // 群岛：每个大陆凸起再散 4~6 个更小的凸起（主凸起缩到 0.45），并提高噪声频率去"打碎"
  if (shape.id === 'archipelago') {
    const extra = [];
    for (const b of bumps) {
      const k = 4 + Math.floor(rng() * 3);
      for (let j = 0; j < k; j++) {
        const ang = rng() * Math.PI * 2;
        const off = 1.2 + rng() * 0.9;
        extra.push({
          x: b.x + Math.cos(ang) * b.rx * off,
          y: b.y + Math.sin(ang) * b.ry * off,
          rx: b.rx * (0.16 + rng() * 0.16),
          ry: b.ry * (0.16 + rng() * 0.16),
          rot: rng() * Math.PI,
        });
      }
      b.rx *= 0.45;
      b.ry *= 0.45;
    }
    bumps.push(...extra);
  }

  // 内陆湖：在几个大陆凸起内部挖 2~4 个高斯凹坑（等值线会提取成"洞"，
  // 预览与铺底都会把它当水面 —— 没有湖的地图看起来才像面团）
  const lakes = [];
  {
    const k = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < k && bumps.length; i++) {
      const b = bumps[Math.floor(rng() * Math.min(bumps.length, Math.max(1, count)))];
      const ang = rng() * Math.PI * 2;
      const off = 0.15 + rng() * 0.35;
      lakes.push({
        x: b.x + Math.cos(ang) * b.rx * off,
        y: b.y + Math.sin(ang) * b.ry * off,
        rx: Math.max(spacing * 3, b.rx * (0.10 + rng() * 0.10)),
        ry: Math.max(spacing * 3, b.ry * (0.10 + rng() * 0.10)),
        depth: 0.55 + rng() * 0.45,
      });
    }
  }

  // ② 场值：凸起（取并集近似）+ 域扭曲的分形噪声
  //   ⚠️ 频率口径：`nx/ny` 归一化到 [-0.5, 0.5]（以长边为尺），freq = "整幅图几个波"。
  //   第一版写成 `x/长边*600` 又把 freq 乘上 2~4 → 每格一个波，marching squares 切出来
  //   全是 4 点的碎渣（实测 155 个环、面积个位数）—— 那是"沙子"，不是大陆。
  const field = new Float32Array(n);
  // 噪声口径（2026-10-25 第三版）：低频 3~7 个波、4 个八度、持久度 0.5。
  //   v2 第一版把频率拉到 15~21 个波 → 阈值 32% 时噪声把陆地打成"纸屑"（实测 60+ 碎块）。
  //   海岸要的是"大尺度蜿蜒 + 中小尺度锯齿"，不是满屏碎渣。
  const amp = shape.noiseAmp * (1.1 + roughness * 2.1) * (shape.id === 'archipelago' ? 0.9 : 1);
  const freq = (3.2 + roughness * 3.6) * (shape.id === 'archipelago' ? 1.5 : 1) * (shape.id === 'elongated' ? 0.8 : 1);
  const warpAmp = 0.05 + roughness * 0.09;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = bbox.minX + i * spacing;
      const y = bbox.minY + j * spacing;
      // 归一化坐标（长边为尺）+ **域扭曲**：
      // 🔴 扭曲必须作用在**掩膜取样坐标**上，而不只是噪声采样 —— 第一/二版只揉噪声，
      //    海岸仍然严格跟着椭圆走，所以看起来就是"面团"。揉坐标才会长出半岛与海湾。
      const nx = (x - cx0) / longSide;
      const ny = (y - cy0) / longSide;
      const wx = nx + warpAmp * fbm(nx * 1.7 + 3.1, ny * 1.7 - 1.7, seed + 311, 4)
        + warpAmp * 0.45 * fbm(nx * 4.1 - 2.3, ny * 4.1 + 5.9, seed + 512, 3);
      const wy = ny + warpAmp * fbm(nx * 1.7 - 5.9, ny * 1.7 + 8.3, seed + 733, 4)
        + warpAmp * 0.45 * fbm(nx * 4.1 + 7.7, ny * 4.1 - 3.1, seed + 811, 3);
      const xw = cx0 + wx * longSide;
      const yw = cy0 + wy * longSide;
      // 凸起并集：**平顶 + 宽缓坡**（smoothstep）。缓坡带里由扭曲+噪声决定海岸线。
      let keep = 1;
      for (const b of bumps) {
        const c = Math.cos(b.rot), s = Math.sin(b.rot);
        const dx = (xw - b.x) * c + (yw - b.y) * s;
        const dy = -(xw - b.x) * s + (yw - b.y) * c;
        const rr = Math.sqrt((dx / b.rx) ** 2 + (dy / b.ry) ** 2);
        const bump = 1 - smooth(Math.min(1, Math.max(0, (rr - 0.55) / 0.6)));
        keep *= 1 - bump;
      }
      const mask = 1 - keep;                       // 0..1
      const detail = fbm(wx * freq, wy * freq, seed + 97, 5);   // [-1,1]
      // 边缘衰减：域扭曲可能把陆块推到框外；衰减带宽度带低频起伏（否则内陆掩膜饱和时，
      // 海岸会沿等距线走出**笔直的边**）。掩膜与噪声一起乘衰减，等值线才会自然收口。
      const wob = fbm(nx * 3.1 + 9.7, ny * 3.1 - 4.3, seed + 917, 3);
      const m = longSide * (0.045 + 0.03 * (wob * 0.5 + 0.5));
      const nz = fbm(nx * 5.3 + 1.7, ny * 5.3 - 2.9, seed + 1201, 3);
      const dEdge = Math.min(x - bbox.minX, bbox.maxX - x, y - bbox.minY, bbox.maxY - y) / (1 + 0.55 * nz);
      const edge = smooth(Math.min(1, Math.max(0, dEdge / m)));
      let v = mask * edge - 0.5 + detail * amp * (0.45 + 0.55 * mask * edge) * edge;
      // 内陆湖：高斯凹坑（只在 mask 高的地方生效，避免在海里挖出"负海"）
      for (const lk of lakes) {
        const dx = (x - lk.x) / lk.rx, dy = (y - lk.y) / lk.ry;
        const d2 = dx * dx + dy * dy;
        if (d2 < 6) v -= lk.depth * Math.exp(-d2 * 1.6) * Math.min(1, mask * 1.4);
      }
      field[j * cols + i] = v;
    }
  }
  // 边界强制为海（保证等值线闭合、不会从图边漏出去）
  for (let i = 0; i < cols; i++) {
    field[i] = -1;
    field[(rows - 1) * cols + i] = -1;
  }
  for (let j = 0; j < rows; j++) {
    field[j * cols] = -1;
    field[j * cols + cols - 1] = -1;
  }

  // ③ 按分位数定阈值 → 陆地占比精确命中
  //   ⚠️ 阈值必须**避开与格值相等**：直接取分位数会让一批格恰好 v === level，
  //   等值线在这些格上退化（多条边交于一点 → 环被切成一堆碎链；实测 12k 个陆格只提出 106k 面积）。
  const vals = Array.from(field).sort((a, b) => a - b);
  const idx = Math.min(vals.length - 1, Math.max(0, Math.round((1 - landRatio) * (vals.length - 1))));
  const span = Math.max(1e-6, vals[vals.length - 1] - vals[0]);
  const level = vals[idx] + span * 1e-4;

  return { field, cols, rows, box: bbox, spacing, level, seed, landRatio, shape, roughness, count };
}

// ── marching squares（带线性插值）──────────────────────────────────────────
function interp(v0, v1, level) {
  const d = v1 - v0;
  return Math.abs(d) < 1e-9 ? 0.5 : Math.min(1, Math.max(0, (level - v0) / d));
}

function contoursOf(F) {
  const { field, cols, rows, level } = F;
  const at = (i, j) => field[j * cols + i];
  const segs = [];
  const push = (x1, y1, x2, y2) => segs.push({ x1, y1, x2, y2 });
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const v00 = at(i, j), v10 = at(i + 1, j), v11 = at(i + 1, j + 1), v01 = at(i, j + 1);
      const b = (v00 >= level ? 1 : 0) | (v10 >= level ? 2 : 0) | (v11 >= level ? 4 : 0) | (v01 >= level ? 8 : 0);
      if (b === 0 || b === 15) continue;
      const top = () => ({ x: i + interp(v00, v10, level), y: j });
      const right = () => ({ x: i + 1, y: j + interp(v10, v11, level) });
      const bottom = () => ({ x: i + interp(v01, v11, level), y: j + 1 });
      const left = () => ({ x: i, y: j + interp(v00, v01, level) });
      const add = (p, q) => push(p.x, p.y, q.x, q.y);
      switch (b) {
        case 1: add(left(), top()); break;
        case 2: add(top(), right()); break;
        case 3: add(left(), right()); break;
        case 4: add(right(), bottom()); break;
        case 5: {
          const c = (v00 + v10 + v11 + v01) / 4;
          if (c >= level) { add(left(), bottom()); add(top(), right()); }
          else { add(left(), top()); add(right(), bottom()); }
          break;
        }
        case 6: add(top(), bottom()); break;
        case 7: add(left(), bottom()); break;
        case 8: add(bottom(), left()); break;
        case 9: add(bottom(), top()); break;
        case 10: {
          const c = (v00 + v10 + v11 + v01) / 4;
          if (c >= level) { add(left(), top()); add(right(), bottom()); }
          else { add(left(), bottom()); add(top(), right()); }
          break;
        }
        case 11: add(bottom(), right()); break;
        case 12: add(right(), left()); break;
        case 13: add(top(), right()); break;
        case 14: add(left(), top()); break;
        default: break;
      }
    }
  }
  F.segCount = segs.length;
  F.segs = segs;
  return stitch(segs);
}

/** 端点量化 → 邻接表 → 串成闭合环 */
function stitch(segs) {
  const key = (x, y) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
  const byKey = new Map();
  segs.forEach((s, idx) => {
    for (const k of [key(s.x1, s.y1), key(s.x2, s.y2)]) {
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(idx);
    }
  });
  const used = new Uint8Array(segs.length);
  const loops = [];
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    const loop = [];
    let cur = s;
    let entry = key(segs[s].x1, segs[s].y1);
    let guard = 0;
    while (cur != null && !used[cur] && guard++ < segs.length + 2) {
      used[cur] = 1;
      const sg = segs[cur];
      // 🔴 必须按**进入端**决定走向：相邻两段可能同向也可能反向（ambiguous case 会反向）。
      //    第一版总是 push(x1,y1) 并从 (x2,y2) 继续 → 遇到反向段就跳到图外，
      //    环被切成碎链（实测 764 段只串出 401 个点）。
      const head = key(sg.x1, sg.y1) === entry;
      const px = head ? sg.x1 : sg.x2;
      const py = head ? sg.y1 : sg.y2;
      loop.push({ x: px, y: py });
      const nx = head ? sg.x2 : sg.x1;
      const ny = head ? sg.y2 : sg.y1;
      entry = key(nx, ny);
      const cand = (byKey.get(entry) || []).find((i) => !used[i]);
      cur = cand == null ? null : cand;
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

function signedArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  return a / 2;
}
function chaikin(pts, iters = 2) {
  let cur = pts;
  for (let k = 0; k < iters; k++) {
    const out = [];
    for (let i = 0; i < cur.length; i++) {
      const a = cur[i], b = cur[(i + 1) % cur.length];
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    cur = out;
  }
  return cur;
}
function rdp(pts, eps) {
  if (pts.length <= 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const p = pts[a], q = pts[b];
    const dx = q.x - p.x, dy = q.y - p.y;
    const len = Math.hypot(dx, dy) || 1e-9;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i].x - p.x) * dy - (pts[i].y - p.y) * dx) / len;
      if (d > best) { best = d; bi = i; }
    }
    if (best > eps && bi > 0) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function pointInRing(pt, pts) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (((yi > pt.y) !== (yj > pt.y)) && (pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi)) c = !c;
  }
  return c;
}

/** 把格坐标环 → 世界坐标环；返回 {points, area} */
function toWorld(loop, F) {
  const { box, spacing } = F;
  const pts = loop.map((p) => ({ x: box.minX + p.x * spacing, y: box.minY + p.y * spacing }));
  return { points: pts, area: Math.abs(signedArea(pts)) };
}

/**
 * 生成一组大陆环。
 * @param {object} params 见 `terrainParams.normalizeLandParams`
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} bbox
 * @returns {{version:number, seed:number, bbox:object, shape:string,
 *            rings:Array<{id:string, points:Array, holes:Array<Array>, area:number, center:object}>,
 *            stats:object}}
 */
export function generateLandmass(params, bbox) {
  const F = buildField(params || {}, bbox);
  const loops = contoursOf(F);
  const minArea = (F.box.maxX - F.box.minX) * (F.box.maxY - F.box.minY) * 0.0012;
  const simpleEps = F.spacing * 0.12;

  const outers = [];
  const holes = [];
  for (const loop of loops) {
    const smoothed = rdp(chaikin(loop, 2), simpleEps);
    // 小湖可能只有 4~5 个平滑点 —— 用面积兜底，不能按点数一刀切（实测 4.7k 面积的湖被丢）
    if (smoothed.length < 4) continue;
    const world = toWorld(smoothed, F);
    if (world.area < minArea) continue;
    // 朝向统一：外环面积为正（与 `signedArea` 的符号约定一致），洞反向
    const ccw = signedArea(world.points) > 0 ? world.points : world.points.slice().reverse();
    const rec = { points: ccw, area: world.area };
    // 判断是陆还是湖：在环内取几个候选点**投票**（形心/顶点均值/顶点与均值的中点）。
    // 🔴 只用"形心与首点的中点"在凹形湖/海湾上会判错（实测湖环被整段丢掉）。
    const avg = rec.points.reduce((acc, p) => ({ x: acc.x + p.x / rec.points.length, y: acc.y + p.y / rec.points.length }), { x: 0, y: 0 });
    let cx = 0, cy = 0, a2 = 0;
    for (let i = 0, j = rec.points.length - 1; i < rec.points.length; j = i++) {
      const cr = rec.points[j].x * rec.points[i].y - rec.points[i].x * rec.points[j].y;
      a2 += cr;
      cx += (rec.points[j].x + rec.points[i].x) * cr;
      cy += (rec.points[j].y + rec.points[i].y) * cr;
    }
    const areaC = a2 !== 0 ? { x: cx / (3 * a2), y: cy / (3 * a2) } : avg;
    const cands = [
      areaC, avg,
      { x: (rec.points[0].x + avg.x) / 2, y: (rec.points[0].y + avg.y) / 2 },
      { x: (rec.points[1 % rec.points.length].x + avg.x) / 2, y: (rec.points[1 % rec.points.length].y + avg.y) / 2 },
      { x: (rec.points[Math.floor(rec.points.length / 2)].x + avg.x) / 2, y: (rec.points[Math.floor(rec.points.length / 2)].y + avg.y) / 2 },
    ];
    const insideCands = cands.filter((pt) => pointInRing(pt, rec.points));
    if (!insideCands.length) continue;
    const fieldAt = (pt) => {
      const gi = Math.max(0, Math.min(F.cols - 1, Math.round((pt.x - F.box.minX) / F.spacing)));
      const gj = Math.max(0, Math.min(F.rows - 1, Math.round((pt.y - F.box.minY) / F.spacing)));
      return F.field[gj * F.cols + gi];
    };
    const landVotes = insideCands.filter((pt) => fieldAt(pt) >= F.level).length;
    if (landVotes * 2 >= insideCands.length) outers.push(rec); else holes.push(rec);
  }
  outers.sort((a, b) => b.area - a.area);
  // 洞挂到包含它的陆块（取面积最小的包含者）
  for (const h of holes) {
    const sample = h.points[0];
    let parent = null;
    for (const o of outers) {
      if (o.area <= h.area) continue;
      if (!pointInRing(sample, o.points)) continue;
      if (!parent || o.area < parent.area) parent = o;
    }
    if (parent && h.area > minArea * 2) {
      const ring = signedArea(h.points) > 0 ? h.points.slice().reverse() : h.points;
      (parent.holes || (parent.holes = [])).push(ring);
    }
  }

  const rings = outers.map((r, i) => ({
    id: `land_${F.seed}_${i}`,
    points: r.points,
    holes: r.holes || [],
    area: r.area,
    center: r.points.reduce((acc, p) => ({ x: acc.x + p.x / r.points.length, y: acc.y + p.y / r.points.length }), { x: 0, y: 0 }),
  }));
  const landArea = rings.reduce((a, r) => a + r.area - (r.holes || []).reduce((b, h) => b + Math.abs(signedArea(h)), 0), 0);
  const boxArea = (F.box.maxX - F.box.minX) * (F.box.maxY - F.box.minY);

  return {
    version: LANDMASS_VERSION,
    seed: F.seed,
    bbox: F.box,
    shape: F.shape.id,
    rings,
    stats: {
      continentCount: F.count,
      ringCount: rings.length,
      holeCount: rings.reduce((a, r) => a + (r.holes || []).length, 0),
      bboxArea: boxArea,
      landArea,
      landRatio: boxArea > 0 ? landArea / boxArea : 0,
      targetRatio: F.landRatio,
      aspect: F.shape.aspect,
      roughness: F.roughness,
      fieldCells: F.cols * F.rows,
      spacing: F.spacing,
    },
  };
}
