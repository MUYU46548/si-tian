// scenario/interaction/eraFade.js — 演变过渡的状态机（A2，2026-11-05）
//
// 从 `ScenarioMap.vue` 搬出来（组件体量有 ≤7,000 行的闸门 `unit/test_scenario_map_split.js`）。
// 它只管三件事：什么时候开始过渡、这一帧该取到多少进度、没在播放时谁把过渡画完。
// 颜色怎么混、进度曲线怎么走、时长读哪里 —— 全在 `utils/eraTransition.js`（纯函数）。
//
// 🔴 为什么要“每次换代现读时长”：真机判据（`drill_era_smooth.py`）第一跑读到 `dur` 一直是
//    默认 320 —— 因为时长被缓存成了模块级常量，页面里再改 `__SITIAN_ERA_FADE_MS__` 要等重载
//    才生效，读起来像“覆盖口没接上”。现在 `start()` 里现读，改完下一次换代就生效。

import { eraFadeMs, eraFadeProgress } from '../../utils/eraTransition';

/**
 * @param {{tlEra: {value:number}, render: Function}} deps
 *   `render` = 组件的整图重绘（过渡驱动每帧调一次）
 */
export function createEraFade({ tlEra, render }) {
  /** 进行中的过渡：`{ fromEra, start, dur }`；null = 没有过渡（绝大多数帧） */
  let fade = null;
  let loopOn = false;

  /** 排障/演练读数口（只写小对象；不参与渲染语义） */
  function writeProbe(t) {
    if (typeof window === 'undefined') return;
    window.__SITIAN_ERA_FADE__ = {
      active: !!fade,
      fromEra: fade ? fade.fromEra : null,
      toEra: fade ? tlEra.value : null,
      dur: fade ? fade.dur : eraFadeMs(),
      t: Math.round(t * 1000) / 1000,
    };
  }

  /**
   * 换代：启动一次过渡。
   * `fromEra < 0`（第一次装载）/ 时长 0（用户关掉）/ 同代 → 不启动（没有“上一代”可淡出）。
   */
  function start(fromEra) {
    const from = Number(fromEra);
    const dur = eraFadeMs();
    if (!(dur > 0) || !Number.isFinite(from) || from < 0 || from === tlEra.value) {
      fade = null;
      return;
    }
    fade = {
      fromEra: from,
      start: (typeof performance !== 'undefined' ? performance.now() : Date.now()),
      dur,
    };
    writeProbe(0);
    ensureLoop();
  }

  /** 当前过渡（读取时按时间算进度，不另存“第二真源”）；结束/没有 → null。 */
  function current() {
    if (!fade) return null;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const t = eraFadeProgress(now - fade.start, fade.dur);
    if (t >= 1) {
      fade = null;
      writeProbe(1);
      return null;
    }
    writeProbe(t);
    return { t, fromEra: fade.fromEra };
  }

  /** 自驱动：非播放时（拖时间轴跨代）也要把过渡画完；播放时由 `tlFrame` 每帧 render，不必再开环。 */
  function ensureLoop() {
    if (loopOn) return;
    loopOn = true;
    const tick = () => {
      render();
      if (current()) requestAnimationFrame(tick);
      else loopOn = false;
    };
    requestAnimationFrame(tick);
  }

  return { start, current };
}
