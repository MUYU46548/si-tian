/**
 * interior/rectDecompose.js —— 异形平面的**矩形拆分**（2026-11-16，建筑地图队列最后一项）
 *
 * ## 这一层解决什么
 *
 * 屋顶在地图上不能只有“一条中线”。矩形楼好办（一条直脊 + 四角斜脊），
 * 但 L 形 / 凹形 / 三合院的楼是**几条臂拼起来的**：真实做法是每条臂各一条屋脊，
 * 臂与臂交接处是垂脊（天沟）。以前是靠 `skeletonRidge` 沿轮廓分带取中点近似 ——
 * 折线会在臂里拐弯、也能跨过凹口，画出来像“一条乱走的线”。
 *
 * 现在：先把轮廓**切成若干矩形**（每个矩形 = 一条臂），再让每个矩形各画一条标准屋脊。
 *
 * ## 怎么切（只切正交轮廓）
 *
 * 1) 在占地自己的**局部坐标**里做（长轴 u / 短轴 v，见 `footprint.rect`）——
 *    楼可以是斜着摆的，在世界轴里切会切出斜边。
 * 2) **有一根斜边就整块不拆**（曲线墙 / 斜角）：那种形状拆出来是一堆锯齿小条，
 *    比骨架更难看；这种情况退回 `skeletonRidge`（本模块返回空数组，调用方自己回落）。
 * 3) 切法：所有顶点的 s / t 坐标当切割线 → 网格 → 逐格判“格子中心是否在轮廓内
 *    （且不在院洞里）” → 贪心合并成极大矩形。正交轮廓下这是**精确**的，
 *    面积守恒（单测按这条判）。
 * 4) 太细的条（< `minSideCm`）丢掉，最多留 `maxCount` 块（按面积从大到小）——
 *    符号最小只有 34px，切太碎在这个尺度上就是一团黑。
 *
 * ## 纪律
 * 纯函数：不 import three / 不碰 DOM / 不用随机数；不改入参（返回新对象）。
 */

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** footprint 的地块列表（与 buildingSymbol 同一口径；这里内联一份，避免循环 import） */
function polygonsOf(fp) {
  if (fp && Array.isArray(fp.polygons) && fp.polygons.length) return fp.polygons;
  return [{ outer: (fp && fp.ring) || [], holes: [] }];
}

// ── 局部坐标 ────────────────────────────────────────────────────────────

function frameOf(rect) {
  const u = rect && rect.u ? rect.u : { x: 1, y: 0 };
  const v = rect && rect.v ? rect.v : { x: 0, y: 1 };
  const cx = num(rect && rect.cx);
  const cy = num(rect && rect.cy);
  return {
    cx,
    cy,
    u,
    v,
    toS: (p) => (num(p.x) - cx) * u.x + (num(p.y) - cy) * u.y,
    toT: (p) => (num(p.x) - cx) * v.x + (num(p.y) - cy) * v.y,
    toWorld: (s, t) => ({ x: cx + u.x * s + v.x * t, y: cy + u.y * s + v.y * t }),
  };
}

/** 点是否在环内（射线法，闭区间边界算在内） */
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x;
    const yi = ring[i].y;
    const xj = ring[j].x;
    const yj = ring[j].y;
    const hit = (yi > pt.y) !== (yj > pt.y)
      && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi || 1e-12) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

/**
 * 这个轮廓在**局部坐标里**是不是正交的（每条边都平行于 u 或 v）。
 * 允许 `tolDeg` 的偏差（墙厚/取整带来的一点点歪）。
 */
export function isOrthogonalInFrame(ring, rect, tolDeg = 8) {
  const list = Array.isArray(ring) ? ring : [];
  if (list.length < 4) return false;
  const f = frameOf(rect);
  const cosTol = Math.cos((Math.max(0.5, num(tolDeg, 8)) * Math.PI) / 180);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const b = list[(i + 1) % list.length];
    const dx = num(b.x) - num(a.x);
    const dy = num(b.y) - num(a.y);
    const len = Math.hypot(dx, dy);
    if (len < 1) continue;                       // 重合点
    const cu = Math.abs((dx * f.u.x + dy * f.u.y) / len);
    const cv = Math.abs((dx * f.v.x + dy * f.v.y) / len);
    if (Math.max(cu, cv) < cosTol) return false; // 既不沿 u 也不沿 v → 有斜边
  }
  return true;
}

function uniqueSorted(values, eps = 0.5) {
  const out = [];
  for (const v of [...values].sort((a, b) => a - b)) {
    if (!out.length || Math.abs(v - out[out.length - 1]) > eps) out.push(v);
  }
  return out;
}

/**
 * 一个正交轮廓 → 若干矩形（局部坐标里切，结果换回世界坐标）。
 *
 * @param {Array<{x:number,y:number}>} ring 外环
 * @param {Array<Array<{x:number,y:number}>>} holes 院洞
 * @param {object} rect `footprint.rect`
 * @param {object} [opts] { minSideCm, maxCount }
 * @returns {Array<{cx:number,cy:number,u:object,v:object,halfU:number,halfV:number,
 *                  long:number,short:number,area:number,corners:Array}>}
 */
export function decomposeRing(ring, holes, rect, opts = {}) {
  const f = frameOf(rect);
  const list = (Array.isArray(ring) ? ring : []).filter((p) => Number.isFinite(Number(p && p.x)));
  if (list.length < 4) return [];
  const minSide = Math.max(5, num(opts.minSideCm, 60));
  const maxCount = Math.max(1, Math.round(num(opts.maxCount, 6)));

  const local = list.map((p) => ({ s: f.toS(p), t: f.toT(p) }));
  const holeLocal = (Array.isArray(holes) ? holes : [])
    .map((h) => (Array.isArray(h) ? h : []).map((p) => ({ s: f.toS(p), t: f.toT(p) })))
    .filter((h) => h.length >= 3);

  const sCuts = uniqueSorted(local.map((p) => p.s));
  const tCuts = uniqueSorted(local.map((p) => p.t));
  if (sCuts.length < 2 || tCuts.length < 2) return [];
  const ns = sCuts.length - 1;
  const nt = tCuts.length - 1;

  // 逐格判“在不在楼里”：中心点在外环内、且不在任何院洞里
  const filled = [];
  for (let i = 0; i < ns; i++) {
    filled.push(new Array(nt).fill(false));
    for (let j = 0; j < nt; j++) {
      const sc = (sCuts[i] + sCuts[i + 1]) / 2;
      const tc = (tCuts[j] + tCuts[j + 1]) / 2;
      const w = f.toWorld(sc, tc);
      if (!pointInRing(w, list)) continue;
      let inHole = false;
      for (const h of holeLocal) {
        if (pointInRing(w, h)) { inHole = true; break; }
      }
      filled[i][j] = !inHole;
    }
  }

  // 贪心合并成极大矩形：先向右拉满同一行，再整行一起向下拉
  const used = [];
  for (let i = 0; i < ns; i++) used.push(new Array(nt).fill(false));
  const out = [];
  for (let i = 0; i < ns; i++) {
    for (let j = 0; j < nt; j++) {
      if (!filled[i][j] || used[i][j]) continue;
      let i2 = i;
      while (i2 + 1 < ns && filled[i2 + 1][j] && !used[i2 + 1][j]) i2++;
      let j2 = j;
      for (;;) {
        if (j2 + 1 >= nt) break;
        let okRow = true;
        for (let k = i; k <= i2; k++) {
          if (!filled[k][j2 + 1] || used[k][j2 + 1]) { okRow = false; break; }
        }
        if (!okRow) break;
        j2++;
      }
      for (let k = i; k <= i2; k++) {
        for (let m = j; m <= j2; m++) used[k][m] = true;
      }
      const s0 = sCuts[i];
      const s1 = sCuts[i2 + 1];
      const t0 = tCuts[j];
      const t1 = tCuts[j2 + 1];
      const w = s1 - s0;
      const h = t1 - t0;
      if (w < minSide || h < minSide) continue;   // 细条在 34px 的符号上就是一坨黑
      out.push({
        cx: f.toWorld((s0 + s1) / 2, (t0 + t1) / 2).x,
        cy: f.toWorld((s0 + s1) / 2, (t0 + t1) / 2).y,
        u: f.u,
        v: f.v,
        halfU: w / 2,
        halfV: h / 2,
        long: Math.max(w, h),
        short: Math.min(w, h),
        area: w * h,
        // 局部区间与"哪条边被邻居接住"：屋脊方向靠它们定（见 ridgeOfRect）
        local: { s0, s1, t0, t1 },
        attach: { uPlus: 0, uMinus: 0, vPlus: 0, vMinus: 0 },
        corners: [
          f.toWorld(s0, t0), f.toWorld(s1, t0), f.toWorld(s1, t1), f.toWorld(s0, t1),
        ],
      });
    }
  }
  out.sort((a, b) => b.area - a.area);
  const kept = out.slice(0, maxCount);
  markAttachments(kept);
  return kept;
}

/**
 * 标出每块**哪条边被邻居整条接住**（attach 比例 0~1）。
 *
 * 为什么需要它：L 形两臂一样宽时（都是 3 米），"沿长边"这条规则会失效 ——
 * 竖臂的外接矩形是 312×300，长边还是横的，于是两臂的脊都画成横的，
 * 看着像"一条长屋加一个方块"。真实做法：竖臂的脊要**垂直于它和横臂的接口**。
 */
function markAttachments(blocks) {
  const eps = 1.5;
  const add = (a, key, a0, a1, b0, b1) => {
    const lo = Math.max(a0, b0);
    const hi = Math.min(a1, b1);
    if (hi - lo <= 1) return;
    a.attach[key] = Math.min(1, a.attach[key] + (hi - lo) / Math.max(1, a1 - a0));
  };
  for (const a of blocks) {
    const la = a.local;
    for (const b of blocks) {
      if (a === b) continue;
      const lb = b.local;
      if (Math.abs(la.s1 - lb.s0) < eps) add(a, 'uPlus', la.t0, la.t1, lb.t0, lb.t1);
      if (Math.abs(la.s0 - lb.s1) < eps) add(a, 'uMinus', la.t0, la.t1, lb.t0, lb.t1);
      if (Math.abs(la.t1 - lb.t0) < eps) add(a, 'vPlus', la.s0, la.s1, lb.s0, lb.s1);
      if (Math.abs(la.t0 - lb.t1) < eps) add(a, 'vMinus', la.s0, la.s1, lb.s0, lb.s1);
    }
  }
}

/**
 * 一座楼 → 若干矩形（按面积从大到小）。
 *
 * 返回空数组 = **不拆**：要么不是正交轮廓（有斜边/曲线），要么切不出够大的块。
 * 调用方据此退回 `skeletonRidge`。
 *
 * @param {object} fp `buildFootprint` 的结果
 * @param {object} [opts] { tolDeg, minSideCm, maxCount }
 */
export function decomposeFootprint(fp, opts = {}) {
  if (!fp || !fp.rect) return [];
  const tolDeg = num(opts.tolDeg, 8);
  const out = [];
  for (const poly of polygonsOf(fp)) {
    const ring = (poly && poly.outer) || [];
    if (ring.length < 4) continue;
    if (!isOrthogonalInFrame(ring, fp.rect, tolDeg)) return [];
    out.push(...decomposeRing(ring, poly.holes, fp.rect, opts));
  }
  return out;
}

/**
 * 一个矩形块的屋脊：沿**长边**一条直脊。
 * 双坡贯穿整块；四坡只占中间 60%（两端留斜脊，地图上才像“一栋房子”）。
 *
 * @param {object} r `decomposeRing / decomposeFootprint` 的一个元素
 * @param {'gable'|'hip'} kind
 * @returns {Array<{x:number,y:number}>} 两个端点
 */
export function ridgeOfRect(r, kind = 'hip') {
  const alongU = ridgeAlongU(r);
  const dir = alongU ? r.u : r.v;
  const half = (alongU ? r.halfU : r.halfV) * (kind === 'gable' ? 1 : 0.6);
  return [
    { x: r.cx - dir.x * half, y: r.cy - dir.y * half },
    { x: r.cx + dir.x * half, y: r.cy + dir.y * half },
  ];
}

/**
 * 屋脊沿哪根轴：**先看接口方向，再看谁长**。
 *
 *   · 一条边被邻居整条接住（比例 ≥ 0.85）→ 脊**垂直于**那条接口（这条臂是往接口外面伸的）；
 *   · 两条边的接口方向互相垂直（夹在中间的横条）→ 退回"沿长边"；
 *   · 没有接口（独立的一块）→ 沿长边。
 *
 * 为什么不能只沿长边：L 形两臂一样宽（3 米）时，竖臂的外接矩形 312×300 长边还是横的，
 * 照"沿长边"会把两臂的脊都画成横的，交接处像"长屋 + 一个方块"而不是 L 的两条腿。
 */
function ridgeAlongU(r) {
  const at = (r && r.attach) || {};
  const FULL = 0.85;
  const tEdge = Math.max(num(at.vPlus), num(at.vMinus)) >= FULL;   // t=const 的边被接住
  const sEdge = Math.max(num(at.uPlus), num(at.uMinus)) >= FULL;   // s=const 的边被接住
  if (tEdge && !sEdge) return false;   // 接口在 t 方向 → 脊沿 u
  if (sEdge && !tEdge) return true;    // 接口在 s 方向 → 脊沿 v
  return r.halfU >= r.halfV;           // 没接口 / 两边都接住 → 沿长边
}

/**
 * 矩形块的四条“斜脊”（脊端点 → 最近的两个角）。
 * 只给出几何：[{ from, to }]；哪一头该画（角在楼的外轮廓上）由绘制层判 ——
 * 两个矩形共用的那条边上的角不该有斜脊，否则那块地方会出现一堆假线。
 *
 * @returns {Array<{from:{x:number,y:number}, to:{x:number,y:number}}>}
 */
export function hipsOfRect(r, ridge) {
  const ends = Array.isArray(ridge) && ridge.length === 2 ? ridge : [];
  if (!ends.length) return [];
  const pairs = [];
  for (const end of ends) {
    const sorted = r.corners.slice().sort((a, b) => (
      Math.hypot(a.x - end.x, a.y - end.y) - Math.hypot(b.x - end.x, b.y - end.y)
    ));
    for (const corner of sorted.slice(0, 2)) pairs.push({ from: end, to: corner });
  }
  return pairs;
}
