// scenario/renderProfile.js — 渲染分层计时口（2026-11-08）
//
// 为什么要有它：用户问“整图重绘 105ms 到底花在哪”，靠猜是不行的。以前只有
// `window.__SITIAN_FRAME_LOG__` 的**整帧**耗时（知道慢，不知道慢在哪一层）。
// 这里给注册表里的每一层单独计时，并把本帧总耗时挂在同一条记录上，
// 于是“层内 / 层外（河流、注记、小地图）”当场能对账。
//
// 用法（真机）：
//   window.__SITIAN_RENDER_PROFILE__ = true
//   ……触发一次重绘……
//   window.__SITIAN_RENDER_STAGES__   // 最近 8 帧：[{ t, px, layers:{层id:ms}, total }]
//
// 纪律：
//   · 默认关（`__SITIAN_RENDER_PROFILE__` 未设）→ 返回 null，调用方不传 hooks，
//     注册表那条路径不取时间、不分配对象，行为与没有它时**一字不差**；
//   · 只保留最近 8 帧（有界，不参与渲染语义）；
//   · 不改任何绘制结果。

const MAX_FRAMES = 8;

function clock() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

/** 开一个计时器；没开排障口就返回 null（调用方据此跳过一切额外工作） */
export function renderProfiler() {
  if (typeof window === 'undefined' || !window || !window.__SITIAN_RENDER_PROFILE__) return null;
  const layers = {};
  return {
    /** 给 `scenarioRenderLayers.run(ctx, view, state, hooks)` 用 */
    hooks: {
      onLayer: (id, ms) => { layers[id] = Math.round(ms * 10) / 10; },
    },
    /** 本帧结束：落一条（像素尺寸随画布变化，出问题时要能看出是不是尺寸惹的） */
    flush(px) {
      const log = (window.__SITIAN_RENDER_STAGES__ = window.__SITIAN_RENDER_STAGES__ || []);
      log.push({ t: Math.round(clock()), px, layers });
      if (log.length > MAX_FRAMES) log.splice(0, log.length - MAX_FRAMES);
    },
  };
}

/** 帧日志那侧算完总耗时后调它，把 `total` 挂到最近一条记录上（层内 + 层外 = 整帧） */
export function attachFrameTotal(totalMs) {
  if (typeof window === 'undefined' || !window || !window.__SITIAN_RENDER_PROFILE__) return;
  const log = window.__SITIAN_RENDER_STAGES__;
  if (!Array.isArray(log) || !log.length) return;
  log[log.length - 1].total = Math.round(Number(totalMs) * 10) / 10;
}
