// scenario/reliefRasterSlot.js — 浮雕整幅栅格的「只长不缩」槽（2026-11-08）
//
// 背景（3000 省 / 15.4 万格压测，用户：“放大一下就卡两秒”）：浮雕栅格的缓存键里带
// `bakeWidthFor(hm, cameraScale)` —— 那是**按当前缩放算的烘焙宽度**，于是
//   ① 开图时相机变一次（适屏）就重烘整张（实测多付 1.1s）；
//   ② 滚轮放大跨过一档（1.6×）就重烘整张，实测 **2.76s 一帧**。
// 这两笔都不是“数据变了”，而是“同一个高度图换了个尺寸重画”。
//
// 口径：**只长不缩**。手里的画布宽度 ≥ 当前需要的宽度 → 直接复用（放大时 `drawImage`
// 双线性放大，清晰度由视口块 `viewBake.js` 补）；只有需要**更宽**（真的放大超过了已有精度）
// 或高度图换对象（涂抹 / 撤销 / 重采样 / 换图都会换对象）时才重烘。
// 观感只在“缩回去”时略有不同：原来是重烘一张更小的，现在用大图缩下来 —— 更清晰，不会更糊。
//
// 为什么单独一个模块：`ScenarioMap.vue` 有 6,120 行闸门（`unit/test_scenario_map_split.js` m1），
// 这段解释与状态放进去就要挤掉别的代码。

let slot = { hm: null, width: 0, raster: null };

/**
 * 取（必要时烘）浮雕整幅栅格。
 * @param {object} hm 高度图（**对象引用**就是缓存键：换对象 = 内容变了）
 * @param {number} need 当前缩放需要的烘焙宽度（`bakeWidthFor` 算出来的）
 * @param {(width:number)=>object} build 烘焙函数（返回 `{canvas,minX,minY,w,h}`）
 * @returns {object|null}
 */
export function reliefRasterFor(hm, need, build) {
  if (!hm) return null;
  if (slot.hm === hm && slot.raster && slot.width >= need) return slot.raster;
  const built = build(need);
  if (built) slot = { hm, width: need, raster: built };
  return built;
}

/** 排障口：当前槽里那张的宽度 / 是不是有货（`window.__SITIAN_RELIEF_SLOT__`） */
export function reliefSlotInfo() {
  return { hasRaster: !!(slot.raster && slot.raster.canvas), width: slot.width, hm: slot.hm ? 'obj' : null };
}

// 排障口挂到 window（2026-11-16）：注释里一直写着 `window.__SITIAN_RELIEF_SLOT__`，但从没挂上过 ——
// 真机探针读到的永远是 null，看起来像“没烘过”，实际是“没人挂”。烘焙宽度/命中与否要靠它判。
if (typeof window !== 'undefined' && window) window.__SITIAN_RELIEF_SLOT__ = reliefSlotInfo;
