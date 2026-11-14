// utils/roomDetection.js — 从墙自动围合出房间（纯函数，2026-11-13）
//
// 来源：theLodgeBots/open3dFloorplan v0.9.0 `src/lib/utils/roomDetection.ts`（MIT）。
// 算法照抄，**改了四处**（原实现的教训都写在下面，别改回去）：
//   ① 环遍历步数上限：原版写死 `step < 20` → 超过 20 面墙的房间**永远检测不出来**（大宅/宫殿必踩）。
//      改为 `edges.length * 2`，与图形规模挂钩。
//   ② 面积上限：原版 `area > 1e7`（=1000㎡）直接丢 —— 宫殿 300×200m = 60000㎡ 会被整个丢掉。
//      改为默认**不设上限**，只过滤下限（< minArea）。
//   ③ 去重：原版只比"墙集合完全相同"，套间（两间共用三道墙）可能判重。改为墙集合 + 质心距离双判据。
//   ④ 吸附容差：原版写死 `EPSILON = 5`（cm 口径）。改为由调用方按建筑尺寸给（我们支持宫殿与茅屋，量纲差 37 倍）。
//
// 纪律：
//   · 本文件**不 import 任何项目模块**（纯数学），Node 侧可直测（`unit/test_room_detection.js`）。
//   · 房间存 `walls: string[]` + `polygon: Point[]`（顶点序）。**顶点序只能由最小环遍历给出**：
//     只存墙 id 再"从墙重拼"时，T 交点处会挑错相邻墙 —— 2026-11-13 截图实测：两间房都绕成外框、
//     面积都变成 12㎡、标签叠在中心。墙一改就重新检测，所以不会留下双源。
//
// 坐标系：世界单位 = 厘米（见 `docs/plan/INTERIOR_COPYPLAN_20261113.md` §十一）。

/** 默认吸附容差（cm）。宫殿级别应由调用方传更大的值 */
export const DEFAULT_EPS = 2;

/**
 * 两点在容差内视为同一点。
 * 用菱形距离（|dx|+|dy|），比平方根快，且对"一格半格"的抖动足够。
 */
export function ptEq(a, b, eps = DEFAULT_EPS) {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
}

/** 鞋带公式（有符号面积） */
export function shoelace(pts) {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    sum += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return sum / 2;
}

/** 多边形面积（绝对值，cm²） */
export function polygonArea(pts) {
  return Math.abs(shoelace(Array.isArray(pts) ? pts : []));
}

/** 顶点算术平均（不是真正的面积质心，但足够做标签落点与去重） */
/**
 * 点是否在多边形内（射线法；**落在边界上算在内**）。
 *
 * 2026-11-14（台账 A28 房间双击改名）：双击要判断"点中的是哪一间"。
 * 边界算命中很重要 —— 平面图上用户经常点在墙内侧那一条线上，判成"外面"就点不中。
 *
 * @param {{x:number,y:number}} pt
 * @param {Array<{x:number,y:number}>} polygon
 * @param {number} [eps=1e-6]
 */
export function pointInPolygon(pt, polygon, eps = 1e-6) {
  const n = Array.isArray(polygon) ? polygon.length : 0;
  if (!pt || n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (!a || !b) continue;
    // 边界判定：叉积为 0 且落在包围盒里
    const cross = (b.x - a.x) * (pt.y - a.y) - (b.y - a.y) * (pt.x - a.x);
    const inBox = pt.x >= Math.min(a.x, b.x) - eps && pt.x <= Math.max(a.x, b.x) + eps
      && pt.y >= Math.min(a.y, b.y) - eps && pt.y <= Math.max(a.y, b.y) + eps;
    if (Math.abs(cross) <= eps && inBox) return true;
    if (((a.y > pt.y) !== (b.y > pt.y))
      && (pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x)) {
      inside = !inside;
    }
  }
  return inside;
}

export function roomCentroid(polygon) {
  const pts = Array.isArray(polygon) ? polygon : [];
  if (!pts.length) return { x: 0, y: 0 };
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  return { x: sx / pts.length, y: sy / pts.length };
}

/**
 * 把 T 型交点打断成子段。
 *
 * 为什么必须做：共享墙的两个房间，如果不在交点处打断，邻接图会把它们连成一个环，
 * 结果"两间房被认成一间"。原实现用"其它墙的端点投影到本墙内部"来判交点。
 */
export function splitWallsAtTJunctions(walls, eps = DEFAULT_EPS) {
  const list = Array.isArray(walls) ? walls.filter((w) => w && w.start && w.end) : [];
  if (!list.length) return [];

  // 所有墙端点（用于投影）
  const endpoints = [];
  for (const w of list) { endpoints.push(w.start, w.end); }

  const splitWalls = list.map((w) => ({
    wallId: w.id,
    start: w.start,
    end: w.end,
    splitPoints: [],
  }));

  for (let wi = 0; wi < list.length; wi++) {
    const w = list[wi];
    const dx = w.end.x - w.start.x;
    const dy = w.end.y - w.start.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq <= eps * eps) continue;             // 退化墙（零长）不参与
    const len = Math.sqrt(lenSq);

    for (const ep of endpoints) {
      if (ptEq(ep, w.start, eps) || ptEq(ep, w.end, eps)) continue;
      const t = ((ep.x - w.start.x) * dx + (ep.y - w.start.y) * dy) / lenSq;
      // 端点太靠近墙的两端时不算 T 交点（那就是角接，交给顶点聚合）
      if (t <= eps / len || t >= 1 - eps / len) continue;
      const projX = w.start.x + t * dx;
      const projY = w.start.y + t * dy;
      const dist = Math.hypot(ep.x - projX, ep.y - projY);
      if (dist > eps) continue;
      const already = splitWalls[wi].splitPoints.some((sp) => ptEq(sp.point, ep, eps));
      if (!already) splitWalls[wi].splitPoints.push({ point: { x: ep.x, y: ep.y }, t });
    }
  }

  const edges = [];
  for (const sw of splitWalls) {
    if (!sw.splitPoints.length) {
      edges.push({ wallId: sw.wallId, start: sw.start, end: sw.end });
      continue;
    }
    sw.splitPoints.sort((a, b) => a.t - b.t);
    let prev = sw.start;
    for (const sp of sw.splitPoints) {
      edges.push({ wallId: sw.wallId, start: prev, end: sp.point });
      prev = sp.point;
    }
    edges.push({ wallId: sw.wallId, start: prev, end: sw.end });
  }
  return edges;
}

/**
 * 从墙围合出房间。
 *
 * @param {Array<{id:string,start:{x,y},end:{x,y}}>} walls
 * @param {object} [opts]
 * @param {number} [opts.eps]     吸附容差（cm）
 * @param {number} [opts.minArea] 面积下限（cm²），默认 1000 = 0.1㎡
 * @param {number} [opts.maxArea] 面积上限（cm²），默认 Infinity（宫殿也要）
 * @param {number} [opts.maxRooms] 防御上限，默认 500
 * @returns {Array<{id:string,name:string,walls:string[],polygon:Array,centroid,area:number}>}
 *   注意 `walls` 是墙 id 去重列表；`polygon`/`centroid`/`area` 是**派生值**，
 *   写回数据时只存 `walls`（其余每次现算），这里返回出来是给调用方省一次计算。
 */
export function detectRooms(walls, opts = {}) {
  const eps = Number.isFinite(opts.eps) && opts.eps > 0 ? opts.eps : DEFAULT_EPS;
  const minArea = Number.isFinite(opts.minArea) ? opts.minArea : 1000;
  const maxArea = Number.isFinite(opts.maxArea) ? opts.maxArea : Infinity;
  const maxRooms = Number.isFinite(opts.maxRooms) ? opts.maxRooms : 500;

  const list = Array.isArray(walls) ? walls.filter((w) => w && w.start && w.end) : [];
  if (list.length < 3) return [];

  const splitEdges = splitWallsAtTJunctions(list, eps);

  // ── 顶点聚合 + 邻接表 ──────────────────────────────────────────────
  const vertices = [];
  function findOrAddVertex(p) {
    for (let i = 0; i < vertices.length; i++) {
      if (ptEq(vertices[i], p, eps)) return i;
    }
    vertices.push({ x: p.x, y: p.y });
    return vertices.length - 1;
  }

  const edges = [];
  for (const e of splitEdges) {
    const si = findOrAddVertex(e.start);
    const ei = findOrAddVertex(e.end);
    if (si !== ei) edges.push({ wallId: e.wallId, si, ei });
  }
  if (edges.length < 3) return [];

  const adj = new Map();
  for (const e of edges) {
    const a1 = Math.atan2(vertices[e.ei].y - vertices[e.si].y, vertices[e.ei].x - vertices[e.si].x);
    const a2 = Math.atan2(vertices[e.si].y - vertices[e.ei].y, vertices[e.si].x - vertices[e.ei].x);
    if (!adj.has(e.si)) adj.set(e.si, []);
    if (!adj.has(e.ei)) adj.set(e.ei, []);
    adj.get(e.si).push({ to: e.ei, wallId: e.wallId, angle: a1 });
    adj.get(e.ei).push({ to: e.si, wallId: e.wallId, angle: a2 });
  }
  for (const [, neighbors] of adj) neighbors.sort((a, b) => a.angle - b.angle);

  // ── 最小环遍历（leftmost turn）────────────────────────────────────
  // 修正①：步数上限随边数走，原版写死 20 会让大房间永远找不到。
  const stepCap = edges.length * 2 + 4;
  const usedDirected = new Set();
  const cand = [];          // 先收集，最后统一滤掉"外表面"
  let idx = 0;

  for (const e of edges) {
    for (const [from, to] of [[e.si, e.ei], [e.ei, e.si]]) {
      if (usedDirected.has(`${from}-${to}`)) continue;

      const cycle = [from];
      const wallIds = [];
      let cur = from;
      let next = to;
      let valid = true;

      for (let step = 0; step < stepCap; step++) {
        const dk = `${cur}-${next}`;
        if (usedDirected.has(dk)) { valid = false; break; }
        usedDirected.add(dk);
        cycle.push(next);

        const curAdj = adj.get(cur) || [];
        const edgeInfo = curAdj.find((n) => n.to === next);
        if (edgeInfo) wallIds.push(edgeInfo.wallId);

        if (next === from && cycle.length > 3) break;   // 闭合

        // ── 半边面遍历（2026-11-13 修正）────────────────────────────
        // 原版用"角度差最小"选下一跳，并额外跳过回头边。实测那两条规则在 T 交点（度 3 顶点）
        // 会**翻转绕向**，导致同一层里有的内部面是正环、有的是负环 —— 于是"用正负过滤外表面"
        // 时好时坏（单测 t2 过、t3 只出 1 间）。
        // 改成 DCEL 的标准走法：邻接表已按角度升序排好，取"来处那条边的前一个邻居"，
        // 等价于每次固定往同一侧转。这样**每个面恰好被遍历一次且绕向恒定**。
        const nbrs = adj.get(next) || [];
        if (!nbrs.length) { valid = false; break; }
        const back = nbrs.findIndex((n) => n.to === cur);
        if (back < 0) { valid = false; break; }
        const pick = (back - 1 + nbrs.length) % nbrs.length;
        cur = next;
        next = nbrs[pick].to;
      }

      if (!valid || cycle[cycle.length - 1] !== from || cycle.length < 4) continue;

      const polygon = cycle.slice(0, -1).map((i) => vertices[i]);
      // 修正⑤（2026-11-13 单测抓出来的）：最小环遍历会得到 n 个面，其中**有一个是外表面**
      //   （墙外那一片"无穷远"）。原版靠 `area > 1e7` 顺带把它滤掉，一旦放开上限
      //   （宫殿必须放开）它就会冒出来当成第 3 间房。
      //   判据用**有符号面积**：leftmost-turn 走出来的内部面恒为逆时针（正），外表面为顺时针（负）。
      //   不依赖输入墙的绕向（按几何走，不看点序）。
      const signed = shoelace(polygon);
      const area = Math.abs(signed);
      if (!(area >= minArea) || area > maxArea) continue;

      const uniqueWalls = Array.from(new Set(wallIds));
      if (uniqueWalls.length < 3) continue;

      // 修正③：同墙集 + 质心距离双判据（套间防误判）
      const centroid = roomCentroid(polygon);
      const dup = cand.some((r) => {
        if (r.walls.length !== uniqueWalls.length) return false;
        const rs = new Set(r.walls);
        if (!uniqueWalls.every((w) => rs.has(w))) return false;
        return Math.hypot(r.centroid.x - centroid.x, r.centroid.y - centroid.y) <= eps * 2;
      });
      if (dup) continue;

      idx++;
      cand.push({
        id: `room_${idx}`,
        name: '',
        walls: uniqueWalls,
        polygon,
        centroid,
        area,
        signed,
      });
      if (cand.length >= maxRooms) break;
    }
    if (cand.length >= maxRooms) break;
  }

  // 收敛外表面：有正环就只留正环；全负时（坐标系被镜像等极端情形）退化为只丢最大的那个，
  // 宁可多一间也不整层没有房间。
  const positives = cand.filter((r) => r.signed > 0);
  let keep = positives;
  if (!positives.length) {
    let maxIdx = 0;
    for (let i = 1; i < cand.length; i++) if (cand[i].area > cand[maxIdx].area) maxIdx = i;
    keep = cand.filter((_, i) => i !== maxIdx);
  }
  return keep.map(({ signed: _s, ...rest }) => rest);
}

/**
 * 把一次检测结果与**已存在的房间**合并，保住用户起过的名与选过的地面材质。
 *
 * 为什么不能直接覆盖：用户把"卧室"改好名、铺了木地板，一挪墙重新检测，
 * 若按新结果整份替换，名字和材质全没了 —— 这是"自动生成把用户编辑冲掉"的典型事故。
 *
 * 匹配三级：
 *   ① 墙集合完全相同（最可靠，纯挪端点不换墙时走这条）
 *   ② 质心距离 < tol（拆墙/加墙导致墙集合变了，但房间还在原地）
 *   ③ 都不中 → 当新房间
 *
 * @param {Array} prevRooms 已存在（含 name / floorTexture / color / roomType / cx / cy）
 * @param {Array} detected  detectRooms 的结果（含 centroid）
 * @param {{tol?:number}} [opts] 质心匹配容差（cm），默认 200
 */
export function mergeDetectedRooms(prevRooms, detected, opts = {}) {
  const tol = Number.isFinite(opts.tol) ? opts.tol : 200;
  const prev = Array.isArray(prevRooms) ? prevRooms.filter(Boolean) : [];
  const list = Array.isArray(detected) ? detected : [];
  const used = new Set();
  const keyOf = (walls) => (Array.isArray(walls) ? walls.slice().sort().join('|') : '');

  const byKey = new Map();
  for (const r of prev) {
    if (r && Array.isArray(r.walls)) byKey.set(keyOf(r.walls), r);
  }

  return list.map((d, i) => {
    const base = {
      id: (d && d.id) || `room_${i + 1}`,
      name: '',
      walls: (d && d.walls) || [],
      // 🔴 顶点序必须一起存（2026-11-13 截图抓出来的）：只存墙 id 的话，
      //    `getRoomPolygon` 在 T 交点处会挑错相邻墙，把两间房都绕成外框 ——
      //    表现是"两间房的面积都变成整个外框、标签叠在中心"。最小环遍历拿到的
      //    顶点顺序是唯一正确的，存下来；墙一改就会重新检测，所以不会留下双源。
      polygon: (d && Array.isArray(d.polygon)) ? d.polygon.map((p) => ({ x: p.x, y: p.y })) : [],
      floorTexture: 'wood',
      color: undefined,
      roomType: undefined,
      cx: d && d.centroid ? d.centroid.x : 0,
      cy: d && d.centroid ? d.centroid.y : 0,
    };

    // ① 墙集合精确匹配
    const hitExact = byKey.get(keyOf(base.walls));
    if (hitExact && !used.has(hitExact)) {
      used.add(hitExact);
      return { ...base, id: hitExact.id || base.id, name: hitExact.name || '',
        floorTexture: hitExact.floorTexture || 'wood', color: hitExact.color,
        roomType: hitExact.roomType };
    }

    // ② 质心最近
    let best = null;
    let bestD = Infinity;
    for (const r of prev) {
      if (!r || used.has(r)) continue;
      const rx = Number.isFinite(r.cx) ? r.cx : null;
      const ry = Number.isFinite(r.cy) ? r.cy : null;
      if (rx === null || ry === null) continue;
      const dist = Math.hypot(rx - base.cx, ry - base.cy);
      if (dist < bestD) { bestD = dist; best = r; }
    }
    if (best && bestD <= tol) {
      used.add(best);
      return { ...base, id: best.id || base.id, name: best.name || '',
        floorTexture: best.floorTexture || 'wood', color: best.color, roomType: best.roomType };
    }

    // ③ 新房间
    return base;
  });
}

/**
 * 由房间的墙 id 列表还原多边形（世界坐标）。
 * 数据里只存墙 id，这是唯一的"现算"入口 —— 画布、面积、导出都必须走它。
 */
export function getRoomPolygon(room, walls) {
  // 优先用检测时存下的顶点序（唯一正确的绕序；由最小环遍历给出）
  const stored = room && Array.isArray(room.polygon) ? room.polygon : null;
  if (stored && stored.length >= 3) {
    return stored.map((p) => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 }));
  }
  // 回退：只有墙 id 的老数据按邻接重拼（T 交点处可能挑错墙，仅作兜底）
  const ids = room && Array.isArray(room.walls) ? room.walls : [];
  const list = Array.isArray(walls) ? walls : [];
  const roomWalls = ids.map((id) => list.find((w) => w && w.id === id)).filter(Boolean);
  if (roomWalls.length < 3) return [];

  const out = [];
  const used = new Set();
  let cur = roomWalls[0];
  out.push(cur.start);
  used.add(cur.id);
  let tip = cur.end;

  for (let i = 0; i < roomWalls.length - 1; i++) {
    out.push(tip);
    const next = roomWalls.find((w) => !used.has(w.id) && (ptEq(w.start, tip) || ptEq(w.end, tip)));
    if (!next) break;
    used.add(next.id);
    tip = ptEq(next.start, tip) ? next.end : next.start;
    cur = next;
  }
  // 去掉首尾重合点（闭合多边形的重复顶点会让面积算大一点）
  if (out.length > 2 && ptEq(out[0], out[out.length - 1])) out.pop();
  return out;
}
