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
  const pts = hm && hm.grid && hm.grid.points;
  if (!Array.isArray(pts) || !pts.length) return 1024;
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const x = pts[i][0];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  const sp = Number(hm.grid.spacing) || 8;
  const worldW = Math.max(1, maxX - minX + 2 * sp);
  const s = Number(scale);
  const need = worldW * (Number.isFinite(s) && s > 0 ? s : 1) * 1.15;
  const steps = Math.max(1, Math.ceil(need / 128));      // 128 一档：别为了取整把像素量翻倍
  // 上限 1,536：**整幅底图只负责“铺底”**，放大后的清晰度由视口块（`scenario/viewBake.js`）负责。
  // 这刀是 2026-11-08 晚的实测结论：整幅底图跟着缩放到 2816 宽时，一次 4.7 百万像素
  // ≈ 4 秒满载，而且要和视口块**抢同一颗核** —— 两件事都在烘，界面就一直在热。
  return Math.max(512, Math.min(1536, steps * 128));
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
