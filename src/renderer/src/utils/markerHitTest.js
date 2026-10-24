// utils/markerHitTest.js — 剧本标记（ScenarioMap 的 markers）命中判定的**唯一实现**（只读）
//
// 为什么要有这个文件（2026-10-24，第 5 件补「点标记」）：
//   在此之前标记是"只画不收"的一层——放下时 `askText` 问个名字，之后**点不到它**
//   （没有命中测试、没有编辑面板）。要挂"点标记看资料"，前置就是这份判定。
//
// 口径（与 `utils/provinceHit.js` / `hitTestRiver` 同一套纪律，不另造一套）：
//   · **从后往前**找：`drawScenarioMarkers` 按数组顺序画，后画的在上 → 命中从末尾向前，
//     叠在一起时**看得见的那一条**被选中；
//   · 容差由调用方换算：调用方传"世界单位"的 tol（= 屏幕 px / 缩放），
//     这样缩得越小命中范围越大——与用户手感一致（`hitTestRiver` 同一条换算）；
//   · **纯函数、只读**：不改 markers、不读 DOM、不碰 store；坐标不是有限数的条目直接跳过
//     （历史 `.map` 导入的数据里出现过 `null` / 字符串坐标，判命中时不能抛）；
//   · 不做空间索引：标记是"几十条"量级（省份是几百条、高度图近万格），
//     全表扫一遍比维护索引更便宜也更少出错；真正的热点（涂归属每 mousemove 5 次）在省份那边。

/** 标记图标的命中半径（屏幕 px）。16px 图标 + 名字标签贴在图下方，取 12 比较顺手。 */
export const MARKER_HIT_RADIUS_PX = 12;

/**
 * 坐标取值：只认有限数字与数字字符串。
 * 🔴 `Number(null) === 0`（`Number('') === 0` 同）—— 若只写 `Number.isFinite(Number(v))`，
 *    历史数据里 `{x:null,y:null}` 的坏标记会变成"世界原点上的可点标记"：点地图左上角
 *    凭空选中一个看不见的标记。这里显式把 null / '' / 布尔 / 对象全部判为无效。
 */
function coordNum(v) {
  if (v === null || v === undefined || v === '') return NaN;
  const t = typeof v;
  if (t !== 'number' && t !== 'string') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * 世界坐标命中最上层的标记。
 * @param {Array<object>} markers 剧本 `markers`（可能含无 id 的导入条目）
 * @param {number} x 世界坐标 x
 * @param {number} y 世界坐标 y
 * @param {number} tol 容差（**世界单位**；调用方用 `px / scale` 换算）
 * @returns {{ marker: object, index: number } | null} 命中返回**下标**（无 id 的导入标记靠它定位）
 */
export function hitMarker(markers, x, y, tol) {
  if (!Array.isArray(markers) || !markers.length) return null;
  const cx = coordNum(x);
  const cy = coordNum(y);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  const r = Number(tol);
  if (!Number.isFinite(r) || r < 0) return null;
  const r2 = r * r;
  for (let i = markers.length - 1; i >= 0; i--) {
    const m = markers[i];
    if (!m || typeof m !== 'object') continue;
    const mx = coordNum(m.x);
    const my = coordNum(m.y);
    if (!Number.isFinite(mx) || !Number.isFinite(my)) continue;
    const dx = mx - cx;
    const dy = my - cy;
    if (dx * dx + dy * dy <= r2) return { marker: m, index: i };
  }
  return null;
}

/**
 * 标记的"句柄"：有 id 用 id，没有（FMG `.map` 导入的标记只有 `{x,y,name,type}`）用下标。
 * 🔴 无 id 的条目**必须**返回下标：`undefined === undefined` 会让"删第 3 条"命中第 1 条
 *    （`removeScenarioMarker` 的注释记着这次事故），选/改/删同理。
 */
export function markerIdentity(marker, index) {
  return (marker && marker.id != null) ? marker.id : index;
}

/**
 * 按句柄（id 或下标）找标记下标。
 * @returns {number} 找不到返回 -1（`undefined` 句柄也返回 -1 —— 绝不当成"第一条无 id 的标记"）
 */
export function markerIndexOf(markers, ref) {
  if (!Array.isArray(markers) || ref == null) return -1;
  if (typeof ref === 'number') {
    return (Number.isInteger(ref) && ref >= 0 && ref < markers.length) ? ref : -1;
  }
  return markers.findIndex((m) => m && m.id === ref);
}
