// scenario/rasterRefine.js — 底档烘焙的“先粗后精”接线（2026-11-08）
//
// 背景：底档烘焙宽度改成固定的 4096（用户拍板），实测 ≈ 9.9 百万像素 ≈ 8–9 秒 CPU。
// 同步烘 = 打开项目/改一次地形就冻 9 秒，所以 `heightmapRaster` 支持 `progressive`：
// 先铺一张 1/6 宽的粗档，再按 24ms 预算逐带精修。
//
// 这个模块只干一件事：**精修完成时通知视图重画一帧**（画布对象是同一个，重画就能看到清晰版）。
// 为什么不写在 ScenarioMap 里：那个文件有 6,120 行闸门，接线越薄越好；而且 Raster 的排障口
// 要能被真机脚本单独调用。
//
// 排障口：
//   window.__SITIAN_RASTER_SYNC__ = true   → 一律同步烘到底（用例/导出要确定性，不要“半精修”的截图）
//   canvas.__sitianBake = { done, progress } → 单张画布的进度

const HANDLER_KEY = '__sitianRasterRefineHandler';

// 视图侧的“重画 + 取高度图”两个回调（2026-11-08）：合成一条注册口，
// 因为 `ScenarioMap` 有 6,120 行闸门，多一行就要挤掉别的东西。
// 视口块（`scenario/viewBake.js`）从这里取，不需要第二个注册点。
let _rerender = () => {};
let _getHm = () => null;

/** 视图挂载时登记：精修完成要做什么 + 高度图从哪儿取（唯一读取口 = store.getHeightmapFor） */
export function setRasterRefineHandler(fn, getHm) {
  _rerender = typeof fn === 'function' ? fn : () => {};
  if (typeof getHm === 'function') _getHm = getHm;
  if (typeof window !== 'undefined') window[HANDLER_KEY] = _rerender;
}

/** 供视口块用：重画一帧 */
export function notifyRerender() {
  try { _rerender(); } catch (e) { /* 渲染护栏自己记 */ }
}

/** 供视口块用：当前底图的高度图（没有 / 已换都返回 null 语义由调用方判） */
export function bakeHeightmap() {
  try { return _getHm(); } catch (e) { return null; }
}

/** 高度图覆盖的世界宽度（含一格 padding；与 `heightmapRaster` 内部同一口径） */
// 🔴 2026-11-08 晚（3000 省 / 15.4 万格压测）：这个函数**每帧被调 2~3 次**（`bakeWidthFor`
//    → `getReliefRaster` / `getRaster`），而它要遍历全部格点求 min/max X。15.4 万格 × 每帧 2 次
//    实测占整帧 **21%（≈63ms/帧）**，CPU 采样里 `worldWidthOf` 排第二、Vue 响应式 `get` 排第四
//    —— 那 63ms 全部是"每帧重算一个永远不变的常量"。
//    世界宽度只随**高度图对象**变（换图/重采样/涂抹都会换对象）→ 按对象记忆化，一次算完。
//    口径不变（同一个返回值的纯函数），只是不再重复算。
const worldWidthCache = new WeakMap();

export function worldWidthOf(hm) {
  if (!hm || !hm.grid) return 1;
  const cached = worldWidthCache.get(hm);
  if (cached) return cached;
  const pts = hm.grid && hm.grid.points;
  if (!Array.isArray(pts) || !pts.length) return 1;
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const x = pts[i][0];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  const sp = Number(hm.grid.spacing) || 8;
  const w = Math.max(1, maxX - minX + 2 * sp);
  worldWidthCache.set(hm, w);
  return w;
}

/**
 * **烘焙宽度按当前缩放定**（2026-11-08 第二版，用户反馈“风扇转得很快”后的修正）。
 *
 * 为什么不能一律 4096：固定的 4096 = 9.9 百万像素 ≈ **7 秒单核满载 / 张**，
 * 一次开图要烘两张（浮雕层 + 底图档）＝ 14 秒满载，而且**小图也一样**（原来 72 省的示例只要 0.3 秒）。
 * 用户实际用到多少像素，就该烘多少：
 *   `需要宽度 = 世界宽 × 当前缩放 × 1.15 余量` → 向上取 1024 的整数倍，夹在 1024…4096。
 * 于是：整幅适屏（scale≈0.6）烘 1024（≈0.5 秒）；放大到 400% 才需要 4096（那时是用户主动放大）。
 *
 * @param {{grid?:{points?:Array, spacing?:number}}} hm
 * @param {number} scale 当前相机缩放（世界单位 → 屏幕像素）
 */
export function bakeWidthFor(hm, scale) {
  const worldW = worldWidthOf(hm);
  const s = Number(scale);
  const need = worldW * (Number.isFinite(s) && s > 0 ? s : 1) * 1.15;
  const steps = Math.max(1, Math.ceil(need / 128));      // 128 一档：别为了取整把像素量翻倍
  // 上限：**整幅底图只负责“铺底”**，放大后的清晰度由视口块（`scenario/viewBake.js`）负责。
  //   · 视口块开着（默认）→ 1,152：与适屏档同一个数，于是**适屏帧逐像素不变**，放大时底图也不再跟着涨；
  //   · 视口块关掉（`__SITIAN_VIEW_PATCH__ = false`）→ 1,536：没有块可用，只能让底图自己扛一点。
  // 这刀是 2026-11-08 晚的实测结论：整幅底图跟着缩放到 2816 宽时一次 4.7 百万像素 ≈ 4 秒满载，
  // 而且要与视口块**抢同一颗核** —— 两件事都在烘，界面就一直在热。
  const patchOn = typeof window === 'undefined' || !window || window.__SITIAN_VIEW_PATCH__ !== false;
  const cap = patchOn ? 1152 : 1536;
  return Math.max(512, Math.min(cap, steps * 128));
}

/** 给 `buildHeightmapRaster(opts.progressive)` 用：预算 + 完成回调 */
export function rasterProgressiveOpts(budgetMs = 24) {
  return {
    budgetMs,
    onDone: () => {
      try {
        const fn = typeof window !== 'undefined' ? window[HANDLER_KEY] : null;
        if (typeof fn === 'function') fn();
      } catch (e) { /* 非浏览器 / 回调出错都不影响烘焙结果 */ }
    },
  };
}

/** 用例/真机演练用：切成“一律同步烘”（确定性优先，牺牲首帧流畅） */
export function setRasterSyncMode(on) {
  if (typeof window === 'undefined') return false;
  window.__SITIAN_RASTER_SYNC__ = !!on;
  return window.__SITIAN_RASTER_SYNC__;
}
