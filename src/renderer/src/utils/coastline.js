// utils/coastline.js — 「这条折线是不是在陆地上」+ 把折线裁到海岸线（纯函数，Node 可测；2026-10-14）
//
// ── 它解决什么（用户 2026-10-14 报的第 2 条）────────────────────────────────
// 「河流的界限似乎有问题，有好几条过度延伸到海洋中。」
//
// 真实底图实测（`绒花计划.sitian` 的 desite 底图，415 省 / 160 条导入河）：
//   · 每条河**最长连续出陆段**（对省份多边形判定）：中位 **3 个顶点**，90 分位 4，最大 **37**；
//   · **142 / 160 条河的末端落在省份多边形之外** —— 也就是河"咬着"海面画出去一截。
//   · 同一批数据里道路更糟：496 条里 2068/5617 个顶点（36.8%）在陆外，最长一段 184 个点。
//
// 为什么会这样（不是画错了，是**两个来源**拼在一起）：省份轮廓是**后来**按新底图重建的
// （见 AGENTS「按新 .map 的海岸线重建省份外环」），而河流/道路还是**当时那次导入**留下的。
// 新海岸线比旧的更"收"（湾区、河口被切成陆地），于是旧几何的尾段就暴露在海面上了。
//
// ── 判据用哪一份「陆地」─────────────────────────────────────────────────────
// 用**省份多边形**（= 画布上真正画出来的那块陆地）。
// 实测两份掩膜高度一致：随机 3000 点里「只在省份」6 点 / 「只在 landFeatures」41 点 —— 
// 所以不存在"用错了掩膜"的风险；而省份多边形是**用户看得见的那份**，
// 用别的判据去裁，就会出现"看着还在海里"（这正是本模块要消灭的观感）。
//
// ⚠️ 本模块**只做几何**：不写盘、不改数据、不走 undo。调用方拿到裁剪后的折线要放哪
//    （渲染缓存 / 落库 / 导出）由调用方决定。

/**
 * 建「陆地掩膜」索引。
 *
 * 只做两件便宜的事：① 每个环的包围盒；② 把环按包围盒**盖到的桶**登记一次。
 * 不做逐格栅格化 —— 栅格化会把"桶的判定"变成最终判定（窄峡湾会被填死），
 * 而这里桶只是**候选筛选**，真正的判定仍是精确的射线法。
 *
 * @param {Array<{points:Array, kind?:string}>} provinces 省份多边形（`baseMap.terrain`）
 * @param {{bucketSize?:number}} [opts]
 * @returns {{ringCount:number, bucketCount:number, bucketSize:number,
 *            lookup(x:number,y:number):boolean}}
 */
export function buildLandMask(provinces, opts = {}) {
  const bucketSize = Number.isFinite(opts.bucketSize) && opts.bucketSize > 0 ? opts.bucketSize : 24;
  const rings = [];
  for (const poly of (provinces || [])) {
    // 海域（`kind: 'sea'`）是水，不是陆地 —— 判成陆地会让河流照旧画到海上去
    if (poly && poly.kind === 'sea') continue;
    const raw = (poly && poly.points) || [];
    if (raw.length < 3) continue;
    const pts = new Array(raw.length);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < raw.length; i++) {
      const p = raw[i];
      const x = Array.isArray(p) ? p[0] : p.x;
      const y = Array.isArray(p) ? p[1] : p.y;
      pts[i] = [x, y];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    rings.push({ pts, minX, minY, maxX, maxY });
  }

  const grid = new Map();
  for (let r = 0; r < rings.length; r++) {
    const g = rings[r];
    const c0 = Math.floor(g.minX / bucketSize), c1 = Math.floor(g.maxX / bucketSize);
    const r0 = Math.floor(g.minY / bucketSize), r1 = Math.floor(g.maxY / bucketSize);
    for (let ci = c0; ci <= c1; ci++) {
      for (let cj = r0; cj <= r1; cj++) {
        const key = ci + ',' + cj;
        const b = grid.get(key);
        if (b) b.push(r); else grid.set(key, [r]);
      }
    }
  }

  function lookup(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const b = grid.get(Math.floor(x / bucketSize) + ',' + Math.floor(y / bucketSize));
    if (!b) return false;
    for (let k = 0; k < b.length; k++) {
      const g = rings[b[k]];
      if (x < g.minX || x > g.maxX || y < g.minY || y > g.maxY) continue;
      if (pointInRing(g.pts, x, y)) return true;
    }
    return false;
  }

  return { ringCount: rings.length, bucketCount: grid.size, bucketSize, lookup };
}

/**
 * 把**一条线段**（河网段）裁到陆地上 —— 只保留陆地那一截。
 *
 * 🔴 为什么需要它（2026-10-14 第四修，用户实测截图：「依然过度延伸到海洋部分」）：
 *    自动河流的河网段有一端是**海格中心**（水追到海就停），而画出来的海岸线在格与格
 *    之间 —— 照原样画，每一段入海都是"越过岸线插进海里"。用 `clipPolylineToCoast`
 *    （它按折线设计、要 `points` 数组、还会回插交点）去处理 1717 条两点的段，
 *    既绕又要构造大量临时对象。这里给出**段**版本，**共用同一个 `crossingPoint`** ——
 *    与导入河/手画河的裁剪是同一份几何口径（两处各写一套二分就会出现
 *    "进口河不出界、自动河出界"这种最难查的不一致）。
 *
 * 返回 `null` 表示这一段整段都在水里（应当丢弃）。
 * ⚠️ 判定抛错时**保守当陆地**（与 `clipPolylineToCoast` 同口径）：宁可不裁，
 *    也不要把整条河删掉 —— 删掉是不报错的数据缺失。
 *
 * @param {{x0:number,y0:number,x1:number,y1:number,flow:number,endInSea?:boolean}} seg
 * @param {(x:number,y:number)=>boolean} isLand
 * @param {{keepOvershoot?:number}} [opts] `keepOvershoot` = 允许保留的入海长度（世界单位）
 * @returns {{x0:number,y0:number,x1:number,y1:number,flow:number,endInSea:boolean}|null}
 */
export function clipSegmentToLand(seg, isLand, opts = {}) {
  if (!seg) return null;
  const keep = Number.isFinite(opts.keepOvershoot) ? Math.max(0, opts.keepOvershoot) : 0;
  const land = (x, y) => {
    try { return !!isLand(x, y); } catch (_) { return true; }
  };
  const a = { x: seg.x0, y: seg.y0 };
  const b = { x: seg.x1, y: seg.y1 };
  const aLand = land(a.x, a.y);
  const bLand = land(b.x, b.y);
  if (aLand && bLand) return { ...seg, endInSea: false };
  if (!aLand && !bLand) return null;              // 整段在水里 → 丢弃
  // 一端陆、一端水：求岸线交点，保留陆地那一侧（+ 可选咬进海面一点点）
  const from = aLand ? b : a;                     // 水端
  const to = aLand ? a : b;                       // 陆端
  const cross = crossingPoint(to, from, (p) => land(p.x, p.y));
  let end = cross;
  if (keep > 0) {
    const d = Math.hypot(from.x - cross.x, from.y - cross.y);
    const k = d > 1e-9 ? Math.min(1, keep / d) : 0;
    end = { x: cross.x + (from.x - cross.x) * k, y: cross.y + (from.y - cross.y) * k };
  }
  return aLand
    ? { ...seg, x1: end.x, y1: end.y, endInSea: true }
    : { ...seg, x0: end.x, y0: end.y, endInSea: false };
}

/** 射线法（奇偶规则）。环不闭合也能算（最后一点与第一点之间视为一条边）。 */
export function pointInRing(pts, x, y) {
  let inside = false;
  const n = pts.length;
  if (n < 3) return false;
  let j = n - 1;
  for (let i = 0; i < n; i++) {
    const xi = pts[i][0], yi = pts[i][1];
    const xj = pts[j][0], yj = pts[j][1];
    if ((yi > y) !== (yj > y)) {
      const xc = (xj - xi) * (y - yi) / (yj - yi) + xi;
      if (x < xc) inside = !inside;
    }
    j = i;
  }
  return inside;
}

/**
 * 把一条折线裁到「陆地上」。
 *
 * 规则（**只裁两端，不动中间**）：
 *   · 尾部连续的水段砍掉，再补一个**入海交点**（二分 12 次）→ 河正好停在岸线上；
 *   · 头部同理（源头落在水里）；
 *   · **中间**的水段一律保留 —— 那是**湖**。把湖也挖掉会把一条过湖的河切成两截，
 *     看起来是"河流凭空断了一节"，比原来的毛病更难解释、也更难查。
 *   · `keepOvershoot`（世界单位，默认 0）允许越过岸线一小段，让河口"咬"住海面 ——
 *     河口贴死在岸线上会显得河没入海（观感问题，不是数据问题，所以做成参数）。
 *
 * @param {Array<{x:number,y:number}>} points
 * @param {(x:number,y:number)=>boolean} isLand
 * @param {{keepOvershoot?:number}} [opts]
 * @returns {{points:Array<{x:number,y:number}>, trimmed:boolean, dropped:boolean}}
 */
export function clipPolylineToCoast(points, isLand, opts = {}) {
  const src = Array.isArray(points) ? points : [];
  const keep = Number.isFinite(opts.keepOvershoot) ? Math.max(0, opts.keepOvershoot) : 0;
  if (src.length < 2) return { points: src.slice(), trimmed: false, dropped: false };

  const landAt = (p) => {
    try { return !!isLand(p.x, p.y); } catch (_) { return true; }   // 判定抛错 → 当陆地（宁可不裁）
  };

  let cut = src;
  let trimmed = false;

  // ── 尾部：src[end] 是最后一个陆点，其后全是水
  let end = src.length - 1;
  while (end >= 0 && !landAt(src[end])) end--;
  if (end < 0) return { points: [], trimmed: false, dropped: true };
  if (end < src.length - 1) {
    const a = src[end], b = src[end + 1];
    const cross = crossingPoint(a, b, landAt);
    cut = src.slice(0, end + 1);
    if (keep > 0) {
      const d = Math.hypot(b.x - cross.x, b.y - cross.y);
      const k = d > 1e-9 ? Math.min(1, keep / d) : 0;
      cut.push({ x: cross.x + (b.x - cross.x) * k, y: cross.y + (b.y - cross.y) * k });
    } else {
      cut.push(cross);
    }
    trimmed = true;
  }

  // ── 头部：cut[0] 之前全是水
  let start = 0;
  while (start < cut.length && !landAt(cut[start])) start++;
  if (start >= cut.length) return { points: [], trimmed: false, dropped: true };
  if (start > 0) {
    const a = cut[start - 1], b = cut[start];
    const cross = crossingPoint({ x: b.x, y: b.y }, { x: a.x, y: a.y }, landAt);
    cut = [cross, ...cut.slice(start)];
    trimmed = true;
  }

  return { points: cut, trimmed, dropped: false };
}

/**
 * 求出 a（陆）→ b（水）之间**岸线上那一点**。
 *
 * 🔴 两个容易踩的细节（都是实测出来的）：
 *   ① 二分 12 次后 t 会落在"水那一侧"一个极小的 ε 上（例如 x=100.0036）——
 *      把它直接当端点，这个点按判定标准**还是水**，于是"裁剪后的折线全都落在陆地上"
 *      这条不变量就不成立（后续任何"再裁一次"的调用都会把它当水继续啃）。
 *      所以交点要**沿线段往陆侧回一点点**（`1e-6` 的线段长，视觉上不可见）。
 *   ② 头部调用时把参数**倒过来传**（水点当 a、陆点当 b），判定顺序才与尾部一致。
 */
function crossingPoint(a, b, landAt) {
  let lo = 0, hi = 1;                       // lo 端是陆，hi 端是水
  for (let it = 0; it < 12; it++) {
    const mid = (lo + hi) / 2;
    if (landAt({ x: a.x + (b.x - a.x) * mid, y: a.y + (b.y - a.y) * mid })) lo = mid; else hi = mid;
  }
  const t = Math.max(0, lo - 1e-6);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * 一次性裁一批折线（河流 / 道路）。
 *
 * @param {Array<{points:Array}>} list 折线列表（原对象不会被改）
 * @param {(x:number,y:number)=>boolean} isLand
 * @param {{keepOvershoot?:number}} [opts]
 * @returns {{list:Array, trimmed:number, dropped:number, unchanged:number}}
 */
export function clipPolylinesToCoast(list, isLand, opts = {}) {
  const out = [];
  let trimmed = 0, dropped = 0, unchanged = 0;
  for (const item of (list || [])) {
    const pts = (item && item.points) || [];
    if (pts.length < 2) { unchanged++; continue; }
    const r = clipPolylineToCoast(pts, isLand, opts);
    if (r.dropped) { dropped++; continue; }
    if (r.trimmed) {
      trimmed++;
      out.push({ ...item, points: r.points });
    } else {
      unchanged++;
      out.push(item);
    }
  }
  return { list: out, trimmed, dropped, unchanged };
}
