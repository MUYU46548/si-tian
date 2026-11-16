// interior/floorView.js — “只看某一层”的过滤口径（纯函数，2026-11-15，A20 余）
//
// ── 为什么需要它 ──────────────────────────────────────────────────────────
// 两层楼的整体轴测里，一层被二层楼板压着（楼板是实体，物理上正确），
// 于是“我想看看一层的床、桌、柜摆成什么样”在整体视图里根本看不到 —— 只能把楼上删掉。
// 删数据不该是看图的代价，所以加一个**只看某一层**的视图口径：
//
//   · 只保留选中那一层；
//   · 该层的 `elevation` **归零**（否则二层会浮在 3 m 高的空中）；
//   · 该层的 `stairs` 清空 —— 楼梯是跨层构件，单层视图里没有“上一层”，
//     留着它会按默认层高画出一跑半截悬空的踏步，比不画更误导。
//
// ── 为什么单独一层文件 ────────────────────────────────────────────────────
// 组件里写一段 `floors.filter(...)` 也能跑，但那样 Node 单测碰不到（要起浏览器）。
// 这里保持纯函数：不 import vue / three，也不碰 store，`unit/test_floor_view.js` 直接测。
//
// ── 一条纪律 ──────────────────────────────────────────────────────────────
// `pick` 为“全部”或指向已删除的楼层时，**原样返回入参数组本身**（同一引用）。
// 这样组件里 `watch(viewFloors)` 不会因为“内容一样但是新数组”而白白重建 3D 场景。

import { orderFloorsByElevation } from './stairs.js';
import { formatLength } from '../utils/interiorUnits.js';

/** “全部楼层”的取值（与 <select> 的 value 一致） */
export const ALL_FLOORS = 'all';

/**
 * 楼层下拉的选项（按标高升序，与平面图楼层条同一口径）。
 * @param {Array} floors store 里的 floors
 * @returns {Array<{id:string, label:string, elevation:number}>}
 */
export function floorViewOptions(floors) {
  const list = orderFloorsByElevation(Array.isArray(floors) ? floors.filter(Boolean) : []);
  return list.map((f, i) => {
    const name = String(f.name || '').trim() || `第 ${i + 1} 层`;
    const el = Number.isFinite(Number(f.elevation)) ? Number(f.elevation) : 0;
    return { id: String(f.id), label: `${name} · 地面 ${formatLength(el)}`, elevation: el };
  });
}

/**
 * 按“只看某一层”的口径过滤楼层。
 *
 * @param {Array} floors 全部楼层
 * @param {string} pick 'all' 或某一层的 id
 * @returns {Array} 原数组（同一引用）或只有一个元素的新数组
 */
export function floorsForView(floors, pick) {
  const list = Array.isArray(floors) ? floors : [];
  if (!pick || pick === ALL_FLOORS) return list;
  const hit = list.find((f) => f && String(f.id) === String(pick));
  if (!hit) return list;
  return [{
    ...hit,
    // 归零：单层视图里“这一层的地面”就是地面
    elevation: 0,
    // 跨层构件在单层视图里没有意义（见文件头）
    stairs: [],
  }];
}

/**
 * 这一层在单层视图里被叫做什么（给统计条/回执用）。取不到就返回空串。
 * @param {Array} floors
 * @param {string} pick
 * @returns {string}
 */
export function floorViewLabel(floors, pick) {
  if (!pick || pick === ALL_FLOORS) return '';
  const hit = floorViewOptions(floors).find((o) => o.id === String(pick));
  return hit ? hit.label : '';
}

/**
 * 这一层的名字本身（不带“地面 3.00 m”那段补充说明）。
 * 图注这类短字段用它 —— 一整条 `二层 · 地面 3.00 m` 塞进一行会挤掉别的字。
 * @param {Array} floors
 * @param {string} pick
 * @returns {string}
 */
export function floorViewName(floors, pick) {
  const label = floorViewLabel(floors, pick);
  return label ? label.split(' · ')[0] : '';
}
