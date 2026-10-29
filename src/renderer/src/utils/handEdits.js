// utils/handEdits.js — 地形特征级锁定（纯函数；2026-10-27，移植自 SP-1025）
//
// ── 为什么按坐标而不是按格下标 ────────────────────────────────────────────────
// 高度图重生成后 `grid.points` 会重建（分辨率/原点/种子都可能变），**下标全变**。
// 但同一个世界坐标仍然是同一块地 —— 所以手绘登记用 `x,y` 的量化键，重生成时按坐标写回。
// 换 seed = 全新世界：坐标仍然对得上，但语义上不该保留（调用方用 `genSeed` 判断后丢弃）。
//
// ── 条目形状 ────────────────────────────────────────────────────────────────
// `{ x, y, h }`：世界坐标 + 手绘高度。数组可直接进 `.sitian`（JSON），不需要 TypedArray。
//
// ── 两条写回路径（别混用）────────────────────────────────────────────────────
//   · `reapplyHandEdits`：**同一张网格**重推（地形面板「重新生成」）→ 逐点同坐标。
//   · `transferHandEdits`：**整张图换掉**（造陆）→ 网格/包围盒都变，按图幅相对位置搬 + 吸附。
//
// 纯函数：不碰 Vue / DOM / store；Node 侧直接测（`unit/test_hand_edits.js`）。

/** 坐标量化键：1e-2 精度（FMG 网格 spacing 通常 ≥7，远大于此） */
export function handEditKey(x, y) {
  return `${Math.round(Number(x) * 100) / 100},${Math.round(Number(y) * 100) / 100}`;
}

/**
 * 手绘登记的软上限。超过就**按网格抽稀**（不是丢最新的）：
 * 真到几万条时（大图长时间编辑），文件体积与每次重生成的对齐开销都开始拖人；
 * 抽稀保留"每一片区域至少还有一格手绘"，形状轮廓不会整块消失。
 *
 * 为什么不是简单 slice：slice 会把用户最后画的那片（通常是正在改的地方）整块丢掉。
 */
export const HAND_EDITS_SOFT_MAX = 20000;

/**
 * 超上限时按逐渐变粗的网格抽稀（确定性：同一输入 → 同一输出；同格后者覆盖前者）。
 * @param {Array<{x:number,y:number,h:number}>} edits
 * @param {number} [max]
 * @returns {Array<{x:number,y:number,h:number}>}
 */
export function thinHandEdits(edits, max = HAND_EDITS_SOFT_MAX) {
  const list = (Array.isArray(edits) ? edits : []).filter(
    (e) => e && Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.h),
  );
  if (list.length <= max) return list;
  let step = 0.5;
  let out = list;
  for (let round = 0; round < 10; round++) {
    const map = new Map();
    // 从**最新**往里填（倒序 + 先到先得）：抽稀时同格保留最后画的那一条，
    // 而不是被更早的条目覆盖 —— 用户正在改的地方不该因为抽稀变成旧值。
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      const key = `${Math.round(e.x / step)},${Math.round(e.y / step)}`;
      if (!map.has(key)) map.set(key, e);
    }
    out = [...map.values()];
    if (out.length <= max) return out;
    step *= 2;
  }
  // 极端情况（所有点落在同一格附近）：保留前 max 条，保证不返回超大数组
  return out.slice(0, max);
}

/** 合并旧登记 + 本笔触及格（同坐标后者覆盖）；脏条目丢弃；超上限自动抽稀 */
export function mergeHandEdits(oldEdits, touched) {
  const map = new Map();
  // 🔴 覆盖时先 delete 再 set：Map 的 set 对已存在键**保留原插入位置**，而抽稀按
  //    "从最新往里填"决定同格留哪条 —— 不 delete 的话"刚画的那格"会被当成最旧的丢掉
  //    （2026-10-28 实测：h6 抽稀用例第一版就红在这里）。
  const put = (e) => {
    const k = handEditKey(e.x, e.y);
    if (map.has(k)) map.delete(k);
    map.set(k, { x: e.x, y: e.y, h: e.h });
  };
  for (const e of (Array.isArray(oldEdits) ? oldEdits : [])) {
    if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.y) || !Number.isFinite(e.h)) continue;
    put(e);
  }
  for (const e of (Array.isArray(touched) ? touched : [])) {
    if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.y) || !Number.isFinite(e.h)) continue;
    put(e);
  }
  return thinHandEdits([...map.values()]);
}

function pointXY(p) {
  return Array.isArray(p) ? [p[0], p[1]] : [p && p.x, p && p.y];
}

/** 旧图上**仍然有效**的手绘：当前 h 与登记值一致才保留（撤销/改回过的自然出局） */
export function activeHandEdits(hm) {
  const edits = Array.isArray(hm && hm.handEdits) ? hm.handEdits : [];
  const pts = hm && hm.grid && Array.isArray(hm.grid.points) ? hm.grid.points : null;
  if (!edits.length || !pts || !hm.h || hm.h.length !== pts.length) return [];
  const byKey = new Map();
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pointXY(pts[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    byKey.set(handEditKey(x, y), i);
  }
  const out = [];
  for (const e of edits) {
    if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
    const i = byKey.get(handEditKey(e.x, e.y));
    if (i === undefined) continue;
    if (Math.abs(Number(hm.h[i]) - Number(e.h)) > 0.01) continue;
    out.push({ x: e.x, y: e.y, h: Number(hm.h[i]) });
  }
  return out;
}

/** 一份高度图 `grid.points` 的包围盒（世界坐标）；没有点就返回 null */
export function gridBBox(hm) {
  const pts = hm && hm.grid && Array.isArray(hm.grid.points) ? hm.grid.points : null;
  if (!pts || !pts.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pointXY(pts[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * **整张高度图换掉**（造陆 `generateLandmass` 这类路径）时，把旧手绘搬到新网格。
 *
 * ── 为什么不直接用 `reapplyHandEdits` ────────────────────────────────────────
 * 那条路要求**逐点同坐标**（同 seed + 同布局）。造陆重建的不是"同一张网格"：
 *   · 包围盒由「现有省份包围盒外扩 4%」推出来（`landmassBBox`），重跑一次就会挪几格；
 *   · 格距来自 `170 + 崎岖度×30` 格，改一个滑杆就变。
 * 于是绝对坐标几乎一定对不上（实测：同种子重跑一次，逐点命中率接近 0），
 * 但**同一块地在图幅里的相对位置没变** —— 所以按包围盒归一化搬：
 *   `x' = newMinX + (x - oldMinX) / oldSpanX * newSpanX`，再吸附到最近的格。
 *
 * ── 什么时候不搬 ────────────────────────────────────────────────────────────
 * ① 换 seed = 全新世界（调用方按 `genSeed` 判断后不调用本函数）；
 * ② 搬过去落在**新图的海里**、而这条手绘又是"抬高"（把山搬进大洋 = 凭空冒出一座孤岛）→ 丢；
 *    反过来"压低"的手绘（手挖湖）落在海里无害，保留（它本来就该是水）。
 *
 * @param {object} nextHm 新高度图（会被改写 `h`）
 * @param {object} prevHm 旧高度图（只用它的 `h` / `grid.points` 定图幅）
 * @param {Array<{x:number,y:number,h:number}>} edits 旧手绘（建议先过 `activeHandEdits`）
 * @param {{maxSnap?:number, seaLevel?:number, dropSeaOrphans?:boolean}} [opts]
 *        `maxSnap` 吸附半径（世界单位，默认 0.75 格）；超出的如实丢弃。
 * @returns {{applied:number, kept:Array, dropped:number, maxSnap:number, snapped:number}}
 *          返回的 `kept` 用的是**新格坐标**（之后 `activeHandEdits` 才能再认出它们）
 */
export function transferHandEdits(nextHm, prevHm, edits, opts = {}) {
  const list = (Array.isArray(edits) ? edits : []).filter(
    (e) => e && Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.h),
  );
  const pts = nextHm && nextHm.grid && Array.isArray(nextHm.grid.points) ? nextHm.grid.points : null;
  const fail = { applied: 0, kept: [], dropped: list.length, maxSnap: 0, snapped: 0 };
  if (!list.length || !pts || !pts.length || !nextHm.h || nextHm.h.length !== pts.length) return fail;

  const nb = gridBBox(nextHm);
  const pb = gridBBox(prevHm) || nb;
  if (!nb || !pb) return fail;
  const rawSpacing = Number(nextHm.grid && nextHm.grid.spacing);
  const spacing = Number.isFinite(rawSpacing) && rawSpacing > 0
    ? rawSpacing
    : (Number.isFinite(nextHm.effectiveCellSize) && nextHm.effectiveCellSize > 0
      ? nextHm.effectiveCellSize
      : Math.max(1, (nb.maxX - nb.minX) / Math.max(1, (nextHm.grid.cellsX || 1) - 1)));
  const maxSnap = Number.isFinite(opts.maxSnap) && opts.maxSnap > 0 ? opts.maxSnap : Math.max(0.5, spacing * 0.75);
  const seaLevel = Number.isFinite(opts.seaLevel) ? opts.seaLevel : 20;
  const dropSeaOrphans = opts.dropSeaOrphans !== false;

  const pSpanX = pb.maxX - pb.minX, pSpanY = pb.maxY - pb.minY;
  const nSpanX = nb.maxX - nb.minX, nSpanY = nb.maxY - nb.minY;
  const mapX = (x) => (pSpanX > 1e-9 && nSpanX > 1e-9 ? nb.minX + ((x - pb.minX) / pSpanX) * nSpanX : x);
  const mapY = (y) => (pSpanY > 1e-9 && nSpanY > 1e-9 ? nb.minY + ((y - pb.minY) / pSpanY) * nSpanY : y);

  // 桶索引（格 = 吸附半径）：命中一定落在同格或相邻 8 格 → 只需看 3×3
  const cell = Math.max(maxSnap, 1e-6);
  const buckets = new Map();
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pointXY(pts[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const k = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    let arr = buckets.get(k);
    if (!arr) buckets.set(k, arr = []);
    arr.push(i);
  }

  const hit = new Map();   // 新格下标 → 手绘值（多点吸到同一格时后者覆盖）
  let dropped = 0, snapped = 0, worst = 0;
  for (const e of list) {
    const tx = mapX(e.x), ty = mapY(e.y);
    const bx = Math.floor(tx / cell), by = Math.floor(ty / cell);
    let best = -1, bestD2 = Infinity;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const arr = buckets.get(`${bx + ox},${by + oy}`);
        if (!arr) continue;
        for (const i of arr) {
          const [x, y] = pointXY(pts[i]);
          const dx = x - tx, dy = y - ty;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) { bestD2 = d2; best = i; }
        }
      }
    }
    if (best < 0) { dropped++; continue; }
    const dist = Math.sqrt(bestD2);
    if (dist > maxSnap) { dropped++; continue; }
    if (dropSeaOrphans && e.h >= seaLevel && !(Number(nextHm.h[best]) >= seaLevel)) {
      dropped++;   // 抬高型手绘落到新图的海里 = 凭空孤岛 → 丢
      continue;
    }
    if (dist > worst) worst = dist;
    if (dist > 1e-6) snapped++;
    hit.set(best, e.h);
  }

  const kept = [];
  for (const [i, h] of hit) {
    const [x, y] = pointXY(pts[i]);
    nextHm.h[i] = h;
    kept.push({ x, y, h });
  }
  return { applied: kept.length, kept, dropped, maxSnap, snapped, worst };
}

/**
 * 把旧图手绘按坐标写回新高度图。
 * 同 seed + 同布局 → 坐标逐点匹配；分辨率/原点变了 → 匹配不上的如实丢弃。
 * @returns {{applied:number, kept:Array}} 实际写回数与保留条目
 */
export function reapplyHandEdits(nextHm, edits) {
  const pts = nextHm && nextHm.grid && Array.isArray(nextHm.grid.points) ? nextHm.grid.points : null;
  if (!pts || !nextHm.h || nextHm.h.length !== pts.length || !Array.isArray(edits) || !edits.length) {
    return { applied: 0, kept: [] };
  }
  const byKey = new Map();
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pointXY(pts[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    byKey.set(handEditKey(x, y), i);
  }
  const kept = [];
  for (const e of edits) {
    if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.y) || !Number.isFinite(e.h)) continue;
    const i = byKey.get(handEditKey(e.x, e.y));
    if (i === undefined) continue;
    nextHm.h[i] = e.h;
    kept.push({ x: e.x, y: e.y, h: e.h });
  }
  return { applied: kept.length, kept };
}
