// utils/eraTransition.js — 剧本演变过渡的纯函数层（A2，2026-11-05）
//
// 解决的问题（用户原话：“演变动画不平滑”）：
//   播放演变 / 拖时间轴跨过剧本边界时，整张地图的颜色是**一帧硬跳** —— 旧剧本的归属色
//   瞬间换成新剧本的归属色，中间什么都没有。月日精度只让“年内月份”连续，**换代那一刀**
//   仍然是离散的（`ScenarioMap` 的 `tlEra` 一变，`getProvinceColor` 立刻返回新主的颜色）。
//
// 本模块只做三件纯函数的事（不碰 Vue / canvas / store，可直接单测）：
//   ① 过渡时长口径（含运行时覆盖口 `window.__SITIAN_ERA_FADE_MS__`，0 = 关）；
//   ② 过渡进度曲线（smoothstep 缓动，端点精确 0/1）；
//   ③ 两个 CSS 颜色之间的 sRGB 线性混合（换代期间每个省在“旧主色 → 新主色”之间取样）。
//
// 🔴 口径边界（写在这里，防止下一轮把它挪到别处）：
//   · 过渡**只影响画布一帧的颜色**，不改任何数据：`ownership` / `changeEvents` 一个字节不动，
//     也不是“新势力”—— 过渡色只是两端颜色之间的插值，判据里必须能证明“过渡结束 = 新主色”。
//   · 导出（`exportPNG` / 切片）走 `surface: 'snapshot'`，**永不带过渡**：导出的图必须是确定态，
//     否则同一份数据导两次会得到不同像素（这是“保存/导出诚实”的一条延伸）。

/** 过渡默认时长（毫秒）。320ms ≈ 播放时一代（1300ms）的四分之一，肉眼是“渐变”而不是“闪”。 */
export const ERA_FADE_MS = 320;

/** 运行时覆盖的上限：再长就不像过渡，而像“卡住了”。 */
export const ERA_FADE_MS_MAX = 3000;

/**
 * 过渡时长（毫秒）。
 * 覆盖口：`window.__SITIAN_ERA_FADE_MS__`（排障/演练用，与 `__SITIAN_SCENARIO_RELIEF__` 同一套约定）。
 *   0 → 关闭过渡（退回 2026-11-05 之前的硬跳，观感对比用）；
 *   非法 / 负数 → 用默认值（不许静默把动画关掉）。
 * @param {object} [win] 可注入的 window（单测用）
 */
export function eraFadeMs(win) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  const raw = w ? w.__SITIAN_ERA_FADE_MS__ : undefined;
  if (raw === undefined || raw === null || raw === '') return ERA_FADE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return ERA_FADE_MS;
  return Math.min(ERA_FADE_MS_MAX, n);
}

/**
 * 过渡进度：0 → 旧色，1 → 新色。
 * 曲线用 smoothstep（3x²−2x³）：两端速度为 0，换代瞬间不会“哐”一下起步。
 * @param {number} elapsed 已过毫秒
 * @param {number} duration 总时长（<=0 视为“没有过渡”，直接 1）
 */
export function eraFadeProgress(elapsed, duration) {
  const dur = Number(duration);
  if (!(dur > 0)) return 1;
  const e = Number(elapsed);
  if (!(e > 0)) return 0;
  if (e >= dur) return 1;
  const x = e / dur;
  return x * x * (3 - 2 * x);
}

function clampByte(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(255, v));
}
function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/**
 * CSS 颜色 → `[r, g, b, a]`。识别不了返回 `null`（调用方自己决定回退）。
 * 支持 `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` / `rgb(...)` / `rgba(...)`
 * （逗号或空格分隔都收；`hsl()` 等不支持 —— 宁可回退也不猜）。
 */
export function parseCssColor(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;
  if (s.charAt(0) === '#') {
    const h = s.slice(1);
    if (/^[0-9a-f]{3}$/i.test(h)) {
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), 1];
    }
    if (/^[0-9a-f]{4}$/i.test(h)) {
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16),
        clamp01(parseInt(h[3] + h[3], 16) / 255)];
    }
    if (/^[0-9a-f]{6}$/i.test(h)) {
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
    }
    if (/^[0-9a-f]{8}$/i.test(h)) {
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16),
        clamp01(parseInt(h.slice(6, 8), 16) / 255)];
    }
    return null;
  }
  const m = s.match(/^rgba?\(([^)]*)\)$/i);
  if (!m) return null;
  const nums = m[1].split(/[,\s/]+/).filter((x) => x !== '').map(Number);
  if (nums.length < 3) return null;
  if (!nums.slice(0, 3).every((n) => Number.isFinite(n))) return null;
  const a = nums.length >= 4 && Number.isFinite(nums[3]) ? clamp01(nums[3]) : 1;
  return [clampByte(nums[0]), clampByte(nums[1]), clampByte(nums[2]), a];
}

/**
 * 两色线性混合：`t = 0` 全 a，`t = 1` 全 b。
 * 任一端解析不了 → 按 `t >= 0.5` 取整色（宁可少一次过渡，也不许把省画成透明/黑色）。
 * alpha = 1 时返回 `#rrggbb`（省界层据此判“不透明”，rgba 会退化成可见描边）。
 */
export function mixCssColor(a, b, t) {
  const k = clamp01(t);
  const pa = parseCssColor(a);
  const pb = parseCssColor(b);
  if (!pa || !pb) {
    // 回退也必须给回**一个字符串**：两端都不可解析时返回兜底省色，
    // 绝不许把 `null` 交给 canvas（`fillStyle = null` 会被忽略，画出来是上一层的颜色）。
    const pick = k >= 0.5 ? b : a;
    if (typeof pick === 'string' && pick) return pick;
    const other = k >= 0.5 ? a : b;
    if (typeof other === 'string' && other) return other;
    return '#bccda0';
  }
  const ch = (i) => Math.round(pa[i] + (pb[i] - pa[i]) * k);
  const alpha = pa[3] + (pb[3] - pa[3]) * k;
  const r = ch(0), g = ch(1), bl = ch(2);
  if (alpha >= 1) {
    const hex = ((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0');
    return `#${hex}`;
  }
  return `rgba(${r}, ${g}, ${bl}, ${Math.round(alpha * 1000) / 1000})`;
}
