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

/** 视图挂载时登记“精修完成后要做什么”（通常是重画一帧）；传 null 注销 */
export function setRasterRefineHandler(fn) {
  if (typeof window === 'undefined') return;
  window[HANDLER_KEY] = typeof fn === 'function' ? fn : null;
}

/** 用例/真机演练用：切成“一律同步烘”（确定性优先，牺牲首帧流畅） */
export function setRasterSyncMode(on) {
  if (typeof window === 'undefined') return false;
  window.__SITIAN_RASTER_SYNC__ = !!on;
  return window.__SITIAN_RASTER_SYNC__;
}
