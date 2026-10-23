// utils/brushProvince.js — 「笔刷建省」的纯几何层（2026-10-22）
//
// ── 为什么需要这一层 ──────────────────────────────────────────────────────
// 用户的诉求（原话）：「按住左键像涂色一样抹，松手自动把抹过的范围长成一个省
//   （不用闭合、不会出现一团自交线，涂抹过程就是最终形状）」。
//
// 「画省份（自由绘制）」是**描轮廓**：要闭合、要自交净化、要贴骨架 —— 那是"套索/多边形"
// 工具，不是笔。这一层做的是另一件事：**笔迹扫过的范围本身就是省**。
//
//   笔迹点 → 每点一个圆盘 + 每段一个胶囊矩形（`traceBrushRings`，与「改省界」笔刷同一条管线）
//          → 并成一个实心 MultiPolygon
//          → **减掉已有省份**（新省只长在空地上）
//
// 🔴 为什么必须减掉已有省份：省份之间没有排他约束，压叠的后果是三重的（点选命中口径与视觉
//    不一致 / 归属上色看不出谁是谁 / 势力标签质心被拽走）—— 见 `scenarioEditing.addBaseProvince`
//    的压叠闸门。描点/自由绘制那条路上是"画完问人一句"，而**笔刷每笔弹一个确认框等于不能用**，
//    所以这里改用法：不覆盖，**只占空地**（用户看到的是"已有省份的地涂不上"，
//    要改那块地的形状就用「改省界」）。
//
// ⚠️ 本文件**不 import 任何裸模块**：布尔引擎由调用方注入（与 `polygonBool.js` 同约定），
//    这样 Node 单测可以直接把真引擎（polygon-clipping）注进来跑几何断言。

import {
  traceBrushRings, ringsToMulti, unionMulti, robustOp,
  provinceToMulti, multiBBox, multiNetArea, isEmptyMulti,
} from './polygonBool';

/**
 * 新省至少要留下的面积（单位：半径² 的倍数）。
 * 0.3·r² ≈ 一个半径 r 的圆的 10% —— 再小就是"刮下来的一条头发丝"，不如不建。
 */
export const BRUSH_KEEP_MIN_R2 = 0.3;
/**
 * 笔迹被已有省份切掉多少才算「几乎没长出东西」（按画出来的面积比例）。
 * 5%：贴着海岸线往外糊一大片时通常还剩 30%~90%，远高于它；只有"整笔压在别人地盘上"才触发。
 */
export const BRUSH_KEEP_MIN_SHARE = 0.05;
/** 面积比较的浮点容差（世界单位²）—— 布尔结果的边界会带 1e-9 级残差 */
const AREA_EPS = 1e-6;

const bboxHit = (a, b) => !!a && !!b
  && !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);

/**
 * 一条笔迹 → 一块实心形状（圆盘 ∪ 胶囊，已并干净）。
 *
 * @param clip 布尔引擎（polygon-clipping；注入）
 * @param {Array<{x:number,y:number}>} path 笔迹采样点（世界坐标）
 * @param {number} radius 笔刷半径（**世界单位**）
 * @param {{onWarn?:Function}} [opts]
 * @returns {{multi?:Array, rings?:number, rejected?:string, message?:string}}
 */
export function brushStrokeMulti(clip, path, radius, opts = {}) {
  const onWarn = typeof opts.onWarn === 'function' ? opts.onWarn : null;
  const r = Number.isFinite(radius) && radius > 0 ? radius : 1;
  const pts = (path || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!pts.length) {
    return { rejected: 'empty-stroke', message: '这一笔没有落点（按住左键拖动再松手）' };
  }
  const rings = traceBrushRings(pts, r);
  const parts = ringsToMulti(rings);
  if (!parts.length) {
    return { rejected: 'empty-stroke', message: '这一笔太短，围不出形状' };
  }
  // 一次并：第一个圆盘当底，其余圆盘/胶囊全部 add 进去。
  // ⚠️ 返回值一律是 **MultiPolygon**（`parts[0]` 是 Polygon，必须再包一层 ——
  //    下游的 `isEmptyMulti` / `multiNetArea` / `multiToShape` 都按"Polygon 的数组"遍历，
  //    少包这一层会让**单击（只有一个圆盘）**被判成"空几何"而拒绝）。
  // `unionMulti` 自带兜底（先自交净化 → 逐个并 → 失败回报，不抛异常）。
  const merged = parts.length === 1
    ? [parts[0]]
    : unionMulti(clip, parts[0], parts.slice(1), {
      onFail: (info) => { if (onWarn) onWarn(`笔迹合并降级：${info.label}`); },
    });
  if (!merged || isEmptyMulti(merged)) {
    return { rejected: 'geometry-failed', message: '这一笔的形状算不出来（几何引擎失败），请重画一笔' };
  }
  return { multi: merged, rings: rings.length };
}

/**
 * 从画出来的形状里**减掉已有省份**（新省只长在空地上）。
 *
 * 逐省差集；包围盒预筛（真实数据里一笔只碰到 0~3 个省），单个省算失败**只跳过它**，
 * 不让整笔炸掉（与 `applyRegionToTerrain` 同一条纪律：宁可少减一块，也不能整笔失败）。
 *
 * @returns {{multi:Array, cut:number, failed:number}} cut = 被切掉的省数
 */
export function subtractProvinces(clip, paintedMulti, provinces, opts = {}) {
  const onWarn = typeof opts.onWarn === 'function' ? opts.onWarn : null;
  let acc = paintedMulti;
  let cut = 0, failed = 0;
  if (!acc || isEmptyMulti(acc)) return { multi: [], cut, failed };
  for (const p of provinces || []) {
    if (!p) continue;
    const box = multiBBox(acc);
    if (!box) break;
    const own = provinceToMulti(p);
    if (!own.length) continue;
    const ownBox = multiBBox(own);
    if (!bboxHit(box, ownBox)) continue;                  // 包围盒不相交 → 整省跳过（省掉一次差集）
    const res = robustOp(clip, 'difference', acc, own);
    if (!res.multi) {
      failed++;
      if (onWarn) onWarn(`「${p.name || p.id || '省份'}」差集失败，这一笔可能压到它`);
      continue;
    }
    acc = res.multi;
    cut++;
    if (isEmptyMulti(acc)) return { multi: [], cut, failed };
  }
  return { multi: acc, cut, failed };
}

/**
 * 一笔 → 一个**新省**的形状（完整判据都在这里，store 只负责落库）。
 *
 * @param clip 布尔引擎（注入）
 * @param {Array<{x,y}>} path 笔迹
 * @param {number} radius 笔刷半径（世界单位）
 * @param {Array} provinces 该底图**已有**的省份（terrain[]）
 * @param {{onWarn?:Function}} [opts]
 * @returns {{
 *   multi?:Array, paintedArea?:number, area?:number, cutRatio?:number, cut?:number,
 *   points?:number, strokes?:number, warnings?:string[],
 *   rejected?:string, message?:string
 * }}
 *   `rejected` 非空时**一定零副作用**（调用方直接回执即可）。
 *   `cutRatio` = 被已有省份吃掉的比例（0.35 = 画出来的 35% 压在别人地盘上）。
 */
export function paintProvinceShape(clip, path, radius, provinces, opts = {}) {
  const warnings = [];
  const onWarn = (m) => {
    if (typeof opts.onWarn === 'function') opts.onWarn(m);
    if (m) warnings.push(m);
  };
  const r = Number.isFinite(radius) && radius > 0 ? radius : 1;
  const painted = brushStrokeMulti(clip, path, r, { onWarn });
  if (painted.rejected) return { rejected: painted.rejected, message: painted.message, warnings };

  const paintedArea = Math.abs(multiNetArea(painted.multi));
  const carved = subtractProvinces(clip, painted.multi, provinces, { onWarn });
  const area = Math.abs(multiNetArea(carved.multi));
  const cutRatio = paintedArea > AREA_EPS ? Math.max(0, 1 - area / paintedArea) : 0;

  if (isEmptyMulti(carved.multi) || area <= AREA_EPS) {
    return {
      rejected: 'all-covered', paintedArea, area: 0, cutRatio: 1, cut: carved.cut, warnings,
      message: '这一笔整个压在已有省份上了 —— 新省只长在空地上（已有省份的地不会被抢）。'
        + '要改已有省份的边界，用「底图编辑 → 改省界」；要改归属，用「涂归属」。',
    };
  }
  const minArea = Math.max(r * r * BRUSH_KEEP_MIN_R2, paintedArea * BRUSH_KEEP_MIN_SHARE);
  if (area < minArea) {
    return {
      rejected: 'too-thin', paintedArea, area, cutRatio, cut: carved.cut, warnings,
      message: `这一笔只有 ${Math.round((area / Math.max(paintedArea, AREA_EPS)) * 100)}% 落在空地上，`
        + '剩下都被已有省份占着 —— 没有建省（免得造出头发丝细的怪省）。'
        + '要改那块地的形状请用「改省界」。',
    };
  }
  return {
    multi: carved.multi, paintedArea, area, cutRatio, cut: carved.cut,
    strokes: (path || []).length, warnings,
  };
}
