/**
 * utils/placeTypes.js — 「地点类型（placeType）」的**唯一判定与选项实现**（A-3 中文点选糙版）
 *
 * 背景（`docs/ROADMAP_NEXT.md` 线 A A-3 + 2026-09-28 在线审查补刀线审查补刀①②）：
 *   搬家线把「层级 / 上层挂靠 / 地点类型」从笔记 frontmatter 收进 `.sitian` 之后，
 *   笔记里**本来就没写**的空白只有这个点选界面能填。审查补刀两条硬要求：
 *     ① 下拉选项 = 8 枚举 ∪ 实体当前值 —— 笔记手写可能冒出第 9 种枚举外值，
 *        下拉只给 8 枚举会**一打开就静默改值**（本仓刚防完 A-2 的静默覆盖，同族缺陷）；
 *     ② 「只看空白」过滤必须**按层级判空白** —— 2026-09-29 拿真 ROSA 缓存实测：
 *        placeType 空 45 个里 **39 个是 world/star_domain/galaxy/planet 宇宙层**
 *        （这些层级本来就不该有地点类型），聚落 5 个按约定也不标（有独立渲染样式），
 *        真正该填的只有 region/facility/location；parentId 空 9 个里 4 个是 world（本来就该顶层）。
 *        不分层就过滤 = 用户点开「类型为空」看到 39 行无意义噪音，过滤器等于没做。
 *
 * 本模块纯函数、无 DOM / 无 store 依赖 → Node 层可直接跑（test_place_types.js）。
 * 单源纪律：ProjectPanel / NodeDetailPanel / geodata 的枚举与层级判定**都从这里取**，
 * 组件里再写一份 `['自然', '宗教', …]` 就是第二套事实源（由 test_76 f0 静态守卫）。
 */

/** 8 枚举（与提取器 / `add-place-type-frontmatter.js` 同源；CJS 侧那份由 test_76 比对） */
export const PLACE_TYPES = ['自然', '宗教', '皇室', '商业', '工业', '居住', '公共', '特殊'];

/**
 * 哪些层级**应该**有地点类型。
 * ⚠️ 与 NodeDetailPanel 原 `isPlaceNode` 同口径：聚落（城市/城镇/村庄）有独立渲染样式，
 *    提取器 `add-place-type-frontmatter.js` 明确跳过它们；宇宙层（world/star_domain/galaxy/planet）
 *    与建筑内部层级从不携带该字段。
 */
export const PLACE_TYPE_LAYERS = ['facility', 'location', 'region'];

/** 该实体是否**应当**有地点类型（= 「类型为空」过滤的计数口径） */
export function expectsPlaceType(entity) {
  return !!(entity && PLACE_TYPE_LAYERS.includes(entity.layer));
}

/** 该实体的地点类型是否是「该填却没填」的空白 */
export function missingPlaceType(entity) {
  return expectsPlaceType(entity) && !(entity && entity.placeType);
}

/**
 * 挂靠空白：非世界级实体没有父级 = 孤儿（世界级本来就在顶层，不算）。
 * 真 ROSA 实测：空 9 个里 4 个是 world（合法），facility 3 + city 1 + location 1 才是真孤儿。
 */
export function missingParent(entity) {
  return !!(entity && entity.layer !== 'world' && !entity.parentId);
}

/** 该实体行是否显示类型下拉：该填的层级 **或** 已经带着值的（保住枚举外现存值的可见性） */
export function showsPlaceTypeControl(entity) {
  return expectsPlaceType(entity) || !!(entity && entity.placeType);
}

/**
 * 下拉选项 = 8 枚举 ∪ 实体当前值（补刀①）。
 * 当前值是枚举外的第 9 种时原样列在末尾 —— **绝不静默吞掉**，
 * 否则用户一打开下拉再随手一选，笔记手写值就没了。
 */
export function placeTypeOptions(current) {
  const opts = PLACE_TYPES.slice();
  if (current && !opts.includes(current)) opts.push(current);
  return opts;
}

/** 过滤器可选值（文案单源，组件与测试共用同一套说法） */
export const GAP_MODES = [
  { value: 'all', label: '全部' },
  { value: 'type', label: '类型为空' },
  { value: 'parent', label: '挂靠为空' },
  { value: 'any', label: '任一为空' },
];

/** 「只看空白」过滤判定（mode 见 GAP_MODES；all 恒真 = 显示整棵树） */
export function matchesGap(entity, mode) {
  if (mode === 'type') return missingPlaceType(entity);
  if (mode === 'parent') return missingParent(entity);
  if (mode === 'any') return missingPlaceType(entity) || missingParent(entity);
  return true;
}
