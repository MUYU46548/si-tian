// interior/triangulate.js — 多边形三角化（纯函数，2026-11-15，A23/A15）
//
// ── 为什么需要它 ──────────────────────────────────────────────────────────
// 3D 里要给「每个房间」铺一块地面 / 吊顶面，而房间是**多边形**（可能是 L 形、带凹角），
// 不是矩形。现有 3D 只认两种东西：轴对齐盒（`boxes`）和三角面（屋顶 `roof.tris`）。
// 房间面要走「三角面」这条路，就得先把多边形切成三角形 —— 否则只能拿包围盒近似，
// L 形房间会多出一大块铺到隔壁去（比不铺更错）。
//
// ── 算法 ──────────────────────────────────────────────────────────────────
// 耳切法（ear clipping）。够用、无依赖、可预测：
//   · 顺/逆时针自动判定（统一成逆时针再切）；
//   · 退化（共线）顶点直接跳过，切不动的点留到最后并丢弃；
//   · **不处理自交多边形**（房间由墙围合而来，正常不会自交；自交时结果为近似）。
//
// ── 纪律 ──────────────────────────────────────────────────────────────────
// 纯函数：不 import 任何项目模块、不碰 DOM / three / store，Node 侧可直测
// （`unit/test_triangulate.js`）。

const EPS = 1e-9;

function shoelace2(pts) {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    sum += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return sum / 2;
}

function cross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointInTriangle(p, a, b, c) {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const hasNeg = d1 < -EPS || d2 < -EPS || d3 < -EPS;
  const hasPos = d1 > EPS || d2 > EPS || d3 > EPS;
  return !(hasNeg && hasPos);
}

/**
 * 把多边形切成三角形。
 *
 * @param {Array<{x:number,y:number}>} polygon 顶点（顺/逆时针都行；首尾不必重复）
 * @returns {Array<Array<{x:number,y:number}>>} 三角形数组；无法切分时尽量返回已切出的部分
 */
export function earClip(polygon) {
  const src = Array.isArray(polygon) ? polygon : [];
  const pts = [];
  for (const p of src) {
    const x = Number(p && p.x);
    const y = Number(p && p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    pts.push({ x, y });
  }
  if (pts.length < 3) return [];

  // 去掉首尾重复点（调用方常把闭合点多写一次）
  while (pts.length > 3) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS) pts.pop();
    else break;
  }
  if (pts.length < 3) return [];

  const ccw = shoelace2(pts) > 0;
  const idx = pts.map((_, i) => i);
  if (!ccw) idx.reverse();

  const out = [];
  let guard = idx.length * idx.length + 32;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const iPrev = (i + idx.length - 1) % idx.length;
      const iNext = (i + 1) % idx.length;
      const a = pts[idx[iPrev]];
      const b = pts[idx[i]];
      const c = pts[idx[iNext]];
      if (cross(a, b, c) <= EPS) continue;          // 凹角 / 共线
      let blocked = false;
      for (let j = 0; j < idx.length; j++) {
        if (j === iPrev || j === i || j === iNext) continue;
        if (pointInTriangle(pts[idx[j]], a, b, c)) { blocked = true; break; }
      }
      if (blocked) continue;
      out.push([{ ...a }, { ...b }, { ...c }]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;                            // 退化（自交 / 全共线）—— 不再死循环
  }
  if (idx.length === 3) out.push(idx.map((k) => ({ ...pts[k] })));
  return out;
}

/** 三角形面积和（验收用：应与多边形的鞋带面积一致） */
export function trianglesArea(tris) {
  let sum = 0;
  for (const t of Array.isArray(tris) ? tris : []) {
    if (!t || t.length < 3) continue;
    sum += Math.abs(cross(t[0], t[1], t[2])) / 2;
  }
  return sum;
}

/** 多边形面积（无符号；带脏点容错） */
export function polygonAreaOf(polygon) {
  const pts = (Array.isArray(polygon) ? polygon : [])
    .map((p) => ({ x: Number(p && p.x) || 0, y: Number(p && p.y) || 0 }));
  if (pts.length < 3) return 0;
  return Math.abs(shoelace2(pts));
}

/**
 * 把多边形朝质心内缩一段距离（吊顶注记的虚线框用）。
 * 退化（内缩过头）时返回空数组 —— 调用方据此不画，绝不画个反向的框。
 */
export function insetPolygon(polygon, inset = 12) {
  const pts = (Array.isArray(polygon) ? polygon : [])
    .map((p) => ({ x: Number(p && p.x) || 0, y: Number(p && p.y) || 0 }));
  if (pts.length < 3) return [];
  const d = Number(inset);
  if (!Number.isFinite(d) || d <= 0) return pts.map((p) => ({ ...p }));
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const out = pts.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    const k = Math.max(0, (len - d) / len);
    return { x: cx + dx * k, y: cy + dy * k };
  });
  // 内缩后面积必须仍是正的且明显变小，否则算失败
  const a0 = polygonAreaOf(pts);
  const a1 = polygonAreaOf(out);
  if (!(a1 > a0 * 0.05)) return [];
  return out;
}
