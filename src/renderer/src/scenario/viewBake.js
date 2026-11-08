// scenario/viewBake.js — **视口烘焙**（2026-11-08，A 计划的第 2 步）
//
// 解决的事：整幅底图按“世界宽 × 缩放”定分辨率时，放大一档就要烘整张（2816 宽 ≈ 4.7 百万像素
// ≈ 4 秒单核满载）。可是屏幕上一次只看得到一小块 —— 那就只烘那一块。
//
// 做法（一个视口 = 一块，够用且不引入瓦片调度）：
//   · 相机静止 260ms 且**没有手势在进行**（复用 `utils/interactionGate`）才开烘；
//   · 烘的范围 = 当前可见世界矩形（外扩 4%），输出像素 = 该矩形在屏幕上的像素数（≤ `PATCH_MAX_PX`）；
//   · 烘完叠在整幅底图之上（同一坐标系，`drawImage` 一次）；
//   · 相机或数据一变就作废。
//
// 为什么不做成“1024px 瓦片阵列”：一屏 1080 宽的画布本来就只有 1–2 块瓦片，
// 多块管理（LRU、跨块缝合、半块边缘）换来的是“平移时能复用邻居”，
// 而现在的口径是“平移/缩放期间显示上一档（略模糊），停下才重烘” —— 手感与成本都够。
// 真到需要跨块复用时再升级，接口不变（`viewPatchFor()` 返回一块）。
//
// 排障口：`window.__SITIAN_VIEW_BAKE__ = { state, lastMs, patches, skipped }`

import { buildHeightmapRaster } from '../utils/heightmapRaster';
import { isInteractionActive } from '../utils/interactionGate';
import { rasterProgressiveOpts, bakeWidthFor, worldWidthOf, notifyRerender, bakeHeightmap } from './rasterRefine';

/** 浮雕底的取色参数（与 `ScenarioMap#getReliefRaster` 同一份 —— 不许各写一份） */
export const RELIEF_BAKE_OPTS = Object.freeze({ shade: 0.85, min: 0.9, max: 1.02 });

const IDLE_MS = 260;        // 相机静止多久才开烘
const PATCH_MAX_PX = 2048;  // 视口块的最大边长（像素）
const MAX_AGE_MS = 1200;    // 交互还没停就别一直等：超过这个时长不再推迟（宁可慢一点也不至于永远模糊）

const state = {
  patch: null,        // { kind, canvas, rect:{minX,minY,w,h}, hm }
  key: '',            // 上次排过的相机键
  timer: null,
  busy: false,
  deferredSince: 0,
  lastMs: 0,
  patches: 0,
  skipped: 0,
};

// 「重画 + 取高度图」两个回调由 `rasterRefine.setRasterRefineHandler(fn, getHm)` 一起登记，
// 所以本模块**不需要第二个安装点**（ScenarioMap 的 6,120 行闸门：能少一行是一行）。

export function invalidateViewPatch() {
  state.patch = null;
  state.key = '';
}

/** 图层里取当前视口块（没有 / 不匹配就返回 null，调用方什么都不画） */
export function viewPatchFor(kind, view) {
  const p = state.patch;
  if (!p || !p.canvas) return null;
  if (kind && p.kind !== kind) return null;
  // 🔴 必须**同时校验相机**：块是按某个机位烘的，机位一变（缩放/平移）就作废。
  //    只校验高度图的话，缩回远景时会把“上一档的清晰块”盖在糊底图上，画面出现一条边界。
  if (view && p.key !== cameraKey(view)) return null;
  const hm = bakeHeightmap();
  if (hm !== p.hm) return null;      // 高度图换了（涂抹/撤销/重生成）→ 旧块不能用
  return p;
}

function cameraKey(view) {
  return [
    Math.round(view.cameraX), Math.round(view.cameraY),
    Number(view.cameraScale).toFixed(3), view.w, view.h,
  ].join('|');
}

/** 算可见世界矩形（外扩 4%） */
function visibleRect(view) {
  const tl = view.screenToWorld(0, 0);
  const br = view.screenToWorld(view.w, view.h);
  const w = Math.max(1, br.x - tl.x);
  const h = Math.max(1, br.y - tl.y);
  const padX = w * 0.04, padY = h * 0.04;
  return { minX: tl.x - padX, minY: tl.y - padY, w: w + padX * 2, h: h + padY * 2 };
}

function bake(view, rect) {
  const hm = bakeHeightmap();
  if (!hm || !hm.grid || !Array.isArray(hm.grid.points)) return;
  // 输出像素 = 这块世界矩形在屏幕上的像素数（不放大到看不见的精度）
  const scale = Number(view.cameraScale) || 1;
  const pxW = Math.max(128, Math.min(PATCH_MAX_PX, Math.ceil(rect.w * scale)));
  const pxH = Math.max(96, Math.min(PATCH_MAX_PX, Math.ceil(pxW * (rect.h / rect.w))));
  // 整幅底图已经够清晰时不必再烘一块：比较的是**每世界单位的像素数**（不是像素总数！
  // 第一版拿 pxW 和 baseW 直接比，等于拿“视口宽度”和“整图宽度”比，永远判成“够清晰”→ 一块都没烘）。
  const basePpu = bakeWidthFor(hm, scale) / worldWidthOf(hm);
  if (scale <= basePpu * 1.25) { state.skipped += 1; return; }
  state.busy = true;
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  try {
    const built = buildHeightmapRaster(hm, 'relief', {
      ...RELIEF_BAKE_OPTS,
      view: rect,
      bakeWidth: pxW,
      progressive: {
        ...rasterProgressiveOpts(16),
        onDone: () => {
          state.lastMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
          state.busy = false;
          state.patches += 1;
          notifyRerender();
        },
      },
    });
    if (!built || !built.canvas) { state.busy = false; state.skipped += 1; return; }
    state.patch = { kind: 'relief', canvas: built.canvas, rect, hm, key: cameraKey(view) };
    // 粗档已经铺进去了，先重画一次（比等精修完更早看到“这一块”）——不能省，否则静止后仍是一张糊图
    notifyRerender();
  } catch (e) {
    state.busy = false;
    state.skipped += 1;
  }
}

/**
 * 每帧调用（幂等、极轻）：相机变了就安排一次视口烘焙；手势期间只记着，不动手。
 * 由 `drawRelief()` 在画完底色后调用 —— 那里正好已经算过相机与可见范围。
 */
export function noteView(view) {
  if (!patchEnabled()) return;          // 默认关：连烘焙都不安排，别白烧 CPU
  if (!view || !view.showRelief) return;
  const key = cameraKey(view);
  if (key === state.key) return;
  state.key = key;
  if (state.timer) clearTimeout(state.timer);
  // 手势期间不烘（这就是用户听到风扇满转的那一段）；但别无限推迟：超过 MAX_AGE_MS 就照烘
  const now = Date.now();
  if (!state.deferredSince) state.deferredSince = now;
  const wait = (isInteractionActive() && now - state.deferredSince < MAX_AGE_MS) ? 180 : IDLE_MS;
  state.timer = setTimeout(() => {
    state.timer = null;
    state.deferredSince = 0;
    if (isInteractionActive()) { state.skipped += 1; return; }   // 还在拖 → 下一帧再来
    bake(view, visibleRect(view));
  }, wait);
}

/** 把当前视口块画上去（世界坐标，与整幅底图同一坐标系） */
export function drawViewPatch(c, kind, view) {
  // ⚠️ 2026-11-08 晚：视口块**默认关**（`window.__SITIAN_VIEW_PATCH__ = true` 才开）。
  //    打开时主帧整张都变了（27 万像素 / 最大通道差 437），成因还在查；
  //    关着时这条路径一行都不执行，行为与像素基线 v20261108j 逐像素一致。
  if (!patchEnabled()) return;
  const p = viewPatchFor(kind, view);
  if (!p) return;
  c.drawImage(p.canvas, p.rect.minX, p.rect.minY, p.rect.w, p.rect.h);
}

/** 视口块是否启用（默认关，见上） */
function patchEnabled() {
  return typeof window !== 'undefined' && window && window.__SITIAN_VIEW_PATCH__;
}

/**
 * 图层侧的**唯一入口**（`makeLayerView().reliefPatch`）：先安排“相机静止后烘一块”，再把已有的块画上去。
 * 为什么要这样一个合成回调：`scenario/layers/*` 的纪律是“依赖一律从 view 取”，
 * 层里直接 import 渲染模块会把那条纪律破掉（`unit/test_scenario_relief.js` 当场红 —— 实测踩过）。
 */
export function reliefPatchPass(c, view) {
  noteView(view);
  drawViewPatch(c, 'relief', view);
}

if (typeof window !== 'undefined' && window) {
  window.__SITIAN_VIEW_BAKE__ = state;
}
