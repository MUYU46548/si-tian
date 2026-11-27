// scenario/openFast.js — 开图快路径（原型，2026-11-27）
//
// 目标（`task-20261116-003`）：开图先出“省色块 + 边界”，把浮雕 / 海深 / 等深线这些重层
// 延到首帧之后。本文件只做**开关与一次跳帧**，默认关；打开方式：
//   `window.__SITIAN_OPEN_FAST__ = true`
//
// 为什么默认关：首帧会短暂缺浮雕与海岸带；要先用探针量出“首帧提前多少 / 全量晚多少”，
// 再决定是否翻默认（翻默认必须同步测试等待口径与像素基线）。
//
// 用法（层里）：
//   if (openFastSkipHeavy()) return;   // 首帧跳过这一层
//
// 跳过一次后由本模块安排一次全量重绘，并写 `window.__SITIAN_OPEN_STAGES__`：
//   { t0, firstFrameStart, fullStart }
// ⚠️ `firstFrameStart` / `fullStart` 是**代码开始 / 开始触发全量**的墙钟，不是“已上屏”：
//    浏览器真正把帧画出来还要等当前任务结束（这个区别正是本轮原型暴露出来的）。

const STAGES_KEY = '__SITIAN_OPEN_STAGES__';
const FRAME_WINDOW_MS = 30;   // 同一帧里多个重层都算“首帧”（它们都在 render 开头几毫秒内被调）
const REFULL_DELAY_MS = 50;   // 全量重绘推迟到首帧之后；必须大于 FRAME_WINDOW_MS

let skipped = false;
let fastUntil = 0;
let scheduled = false;

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

function stages() {
  if (typeof window === 'undefined') return null;
  if (!window[STAGES_KEY]) window[STAGES_KEY] = { t0: nowMs(), firstFrameStart: null, fullStart: null };
  return window[STAGES_KEY];
}

/** 开关是否打开（默认关；探针/实验显式设置） */
export function openFastArmed() {
  return typeof window !== 'undefined' && window.__SITIAN_OPEN_FAST__ === true;
}

/**
 * 首帧是否跳过“重层”。同一帧内重复调用返回 true；跳过一次后返回 false（后续帧全量）。
 * 第一次返回 true 时会安排一次全量重绘（`window.__SITIAN_RENDER__`）。
 */
export function openFastSkipHeavy() {
  if (!openFastArmed()) return false;
  const st = stages();
  if (!st) return false;
  const t = nowMs();
  if (t <= fastUntil) return true;          // 同一帧的后续重层
  if (skipped) return false;                // 只跳一次
  skipped = true;
  fastUntil = t + FRAME_WINDOW_MS;
  st.firstFrameStart = t;
  if (!scheduled) {
    scheduled = true;
    setTimeout(() => {
      if (typeof window === 'undefined') return;
      const s = stages();
      if (s) s.fullStart = nowMs();
      if (typeof window.__SITIAN_RENDER__ === 'function') window.__SITIAN_RENDER__();
    }, REFULL_DELAY_MS);
  }
  return true;
}

/** 换项目/底图重新开图时调用（本轮原型只在首开用；保留给下一步接线） */
export function openFastReset() {
  skipped = false;
  fastUntil = 0;
  scheduled = false;
}
