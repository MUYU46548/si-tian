/**
 * footprintField.js —— 节点上的“建筑占地”派生字段（台账 A21，2026-11-16）
 *
 * ## 为什么节点上要存这个字段
 *
 * `buildingSymbol.buildFootprint(floors)` 每次都要对**全部墙**做一次布尔并集，
 * 产出的是一整圈轮廓（ring / polygons / rect / bbox）。区域图要画符号，所以必须算；
 * 但其它地方要的只是**尺寸**（长 × 宽 / 面积）：整栋信息条、轴测图注、将来的世界叠加。
 * 为它们每问一次就重算一遍没有意义，所以把尺寸**写回节点**：
 * `entity.footprint = { w, h, area, stamp }`（单位厘米，与内部数据同一口径）。
 *
 * ## 派生字段怎么不陈旧（本条目唯一真正的问题）
 *
 * 三条一起用，缺一条就会出现“地图上是 9 米、信息条上是 12 米”：
 *
 * ① **带指纹**：`stamp` 是墙几何（id + 端点 + 厚度）的 FNV-1a 指纹。
 *    颜色 / 高度 / 名字这些不影响平面的字段进不去，所以给墙换个颜色不会让字段失效。
 * ② **唯一刷新点**：楼层几何一变（画墙 / 拖端点 / 删墙 / 删楼层 / 撤销 / 重做），
 *    store 的 `notifyFloorChanged` 就把整栋重算一遍写回节点 —— 它不进 undo 栈：
 *    派生缓存不该单独占一条命令，撤销时同一条路径会把它算回旧值。
 * ③ **读侧兜底**：`readFootprint()` 先比对指纹，一致才用缓存；不一致**现算**
 *    （`stale: true`）。外部改过的项目文件、旧版本写下的字段、手改 JSON 的字段，
 *    永远不会被当真 —— 宁可多算一次，也不显示一个没人能验证的数字。
 *
 * 口径：`w` 是**最小外接矩形的长边**、`h` 是短边（都含墙厚外扩），不是地图 AABB。
 * AABB 会随房子朝向变化（同一个 8×6 米的房，转 45° 就成 10×10），那不是“建筑尺寸”。
 */

import { buildFootprint } from './buildingSymbol.js';

/** 展示与指纹共用的取整：0.1cm（比 mm 粗，比 cm 细，够表达墙厚对尺寸的影响） */
function round1(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

/** FNV-1a 32 位（与仓里 scenarioThumb / loreBinding 同一套手法，输出 8 位十六进制） */
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 墙几何指纹。**只吃影响平面的字段**：
 *   · 端点（0.1cm 取整）、墙厚 —— 决定墙矩形；
 *   · 墙 id —— 区分“同样是 4 面墙但换了一面”；
 *   · 不含颜色 / 高度 / 层名 / 标高 —— 改这些不该让占地失效。
 *
 * 墙按字符串排序后再拼：布尔并集与输入顺序无关，所以数组顺序变化不该算“变了”
 * （重排一次数组就重算一次，纯属浪费，还会让快照多出无意义的 diff）。
 *
 * @param {Array<object>} floors
 * @returns {string} 8 位十六进制
 */
export function footprintStamp(floors) {
  const list = Array.isArray(floors) ? floors : [];
  const parts = [];
  for (const floor of list) {
    const walls = (floor && floor.walls) || [];
    for (const w of walls) {
      if (!w || !w.start || !w.end) continue;
      const t = Number(w.thickness);
      parts.push([
        w.id || '',
        round1(w.start.x), round1(w.start.y),
        round1(w.end.x), round1(w.end.y),
        Number.isFinite(t) && t > 0 ? round1(t) : 12,
      ].join(','));
    }
  }
  parts.sort();
  return fnv1a(parts.join('|'));
}

/**
 * 从楼层数据算出**要落盘的字段**（不含轮廓：字段只服务“尺寸”这一件事）。
 *
 * @param {Array<object>} floors
 * @returns {null | {w:number, h:number, area:number, stamp:string}}
 *   `w` / `h` = 最小外接矩形长边 / 短边（cm）；`area` = 外轮廓面积（cm²，屋顶盖住的面积，
 *   院子洞已按 buildFootprint 的默认口径填掉）。没有任何墙返回 null —— 调用方应**删掉**字段，
 *   而不是留一个 0×0 的占位（与 stripEmptyEntityValues 同一条纪律）。
 */
export function footprintField(floors) {
  const list = Array.isArray(floors) ? floors : [];
  const fp = buildFootprint(list);
  if (!fp || !fp.rect) return null;
  const w = round1(fp.rect.long);
  const h = round1(fp.rect.short);
  if (!(w > 0) || !(h > 0)) return null;
  return {
    w,
    h,
    area: Math.max(0, Math.round(Number(fp.area) || 0)),
    stamp: footprintStamp(list),
  };
}

/**
 * 读取建筑占地：**先用节点上的字段**（指纹一致才作数），否则现算。
 *
 * 这个函数的语义是“问一栋楼多大”，永远给正确答案 —— 字段新鲜时省一次布尔并集，
 * 字段陈旧时多算一次但结果一样。**它不写任何东西**（写回是 store 的事，见模块头 ②）。
 *
 * @param {object|null} node 画布节点（读 `node.footprint`）
 * @param {Array<object>} floors `interiorData[buildingId].floors`
 * @returns {null | {w:number, h:number, area:number, stamp:string,
 *                   source:'field'|'computed', stale:boolean}}
 */
export function readFootprint(node, floors) {
  const list = Array.isArray(floors) ? floors : [];
  if (!list.length) return null;
  const stamp = footprintStamp(list);
  const cur = node && node.footprint;
  const cacheOk = cur
    && typeof cur === 'object'
    && cur.stamp === stamp
    && Number(cur.w) > 0
    && Number(cur.h) > 0;
  if (cacheOk) {
    return {
      w: Number(cur.w),
      h: Number(cur.h),
      area: Math.max(0, Number(cur.area) || 0),
      stamp,
      source: 'field',
      stale: false,
    };
  }
  const fp = buildFootprint(list);
  if (!fp || !fp.rect) return null;
  const w = round1(fp.rect.long);
  const h = round1(fp.rect.short);
  if (!(w > 0) || !(h > 0)) return null;
  return {
    w,
    h,
    area: Math.max(0, Math.round(Number(fp.area) || 0)),
    stamp,
    source: 'computed',
    // 字段存在但对不上 = 陈旧（旧版本写的 / 手改过 / 外部编辑过）
    stale: !!cur,
  };
}

/**
 * 给人看的一行：`9.1 × 6.6 m · 60.4 ㎡`。
 * 没有尺寸（没画墙 / 数据坏了）返回空串 —— 调用方据此不显示整块，而不是显示 0。
 *
 * @param {{w:number,h:number,area:number}|null} fp
 * @returns {string}
 */
export function describeFootprint(fp) {
  if (!fp) return '';
  const w = Number(fp.w);
  const h = Number(fp.h);
  if (!(w > 0) || !(h > 0)) return '';
  const meters = (cm) => (cm / 100).toFixed(1);
  const areaM2 = Number(fp.area) > 0 ? (Number(fp.area) / 10000) : 0;
  const size = `${meters(w)} × ${meters(h)} m`;
  return areaM2 > 0 ? `${size} · ${areaM2.toFixed(1)} ㎡` : size;
}
