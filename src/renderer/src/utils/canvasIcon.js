// canvasIcon.js — Canvas 端矢量图标（P1.1 批次 B）
//
// 背景：Canvas context 无法挂载 Vue 组件，此前用 emoji + ctx.fillText 绘制图标，
// 导致图标随系统 emoji 字体变形、无法用 currentColor 主题化。此处以 Path2D
// 复刻 Icon.vue 中同名图标在 24×24 viewBox 下的描边几何，供 Canvas 同步绘制。
//
// 约束：
// - 几何必须与 components/Icon.vue 中同名图标一致（单一视觉来源，新增时同步两处）。
// - 纯同步实现（Path2D），不使用 Image/data-URI 异步栅格化，避免首帧丢图标。
// - 用户历史数据中的 emoji 自定义图标仍走 fillText 回退，保证向后兼容。

// 24×24 viewBox 下的描边路径（stroke-width 2，fill none）
export const CANVAS_ICON_PATHS = {
  'map-pin': [
    'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z',
    'M12 7a3 3 0 1 0 0.01 0z'
  ],
  pin: [
    'M12 17v5',
    'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z'
  ],
  package: [
    'M16.5 9.4 7.5 4.21',
    'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z',
    'M3.27 6.96 12 12.01 20.73 6.96',
    'M12 22.08V12'
  ],
  spiral: [
    'M12 12a2.5 2.5 0 1 1 2.5 2.5A4.5 4.5 0 0 1 10 10a6.5 6.5 0 0 1 6.5-6.5A8.5 8.5 0 0 1 20.5 12a10 10 0 1 1-10 10'
  ],
  skull: [
    'M8 20v2h8v-2',
    'M12.5 17l-.5-1-.5 1z',
    'M16 20a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20',
    'M9 11a1 1 0 1 0 0.01 0z',
    'M15 11a1 1 0 1 0 0.01 0z'
  ],
  gem: [
    'M6 3h12l4 6-10 13L2 9Z',
    'M11 3 8 9l4 13 4-13-3-6',
    'M2 9h20'
  ],
  user: [
    'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2',
    'M12 3a4 4 0 1 0 0.01 0z'
  ],
  flag: [
    'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z',
    'M4 22v-7'
  ],
  mountain: [
    'M8 3h8',
    'M4 21l5-12 4 6 3-6 5 12'
  ],
  church: [
    'M10 9h4',
    'M12 5v4',
    'M6 21V12l6-4 6 4v9',
    'M3 21h18',
    'M10 21v-4a2 2 0 0 1 4 0v4'
  ],
  castle: [
    'M4 21V9l2-3 2 3 2-3 2 3 2-3 2 3 2-3 2 3v12',
    'M3 21h18',
    'M10 21v-4a2 2 0 0 1 4 0v4'
  ],
  shop: [
    'M3 9l1-4h16l1 4',
    'M5 9v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9',
    'M9 9V5a3 3 0 0 1 6 0v4'
  ],
  factory: [
    'M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z',
    'M17 18h1',
    'M12 18h1',
    'M7 18h1'
  ],
  home: [
    'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    'M9 22V12h6v10'
  ],
  building: [
    'M4 2h16a2 2 0 0 1 2 2v18H2V4a2 2 0 0 1 2-2z',
    'M9 22v-6h6v6',
    'M8 6h1',
    'M11 6h1',
    'M14 6h1',
    'M8 10h1',
    'M11 10h1',
    'M14 10h1',
    'M8 14h1',
    'M11 14h1',
    'M14 14h1'
  ],
  sparkles: [
    'M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z',
    'M18 14l.75 2.25L21 17l-2.25.75L18 20l-.75-2.25L15 17l2.25-.75L18 14z',
    'M5 14l.75 2.25L8 17l-2.25.75L5 20l-.75-2.25L2 17l2.25-.75L5 14z'
  ],
  layers: [
    'M12 2 2 7l10 5 10-5-10-5z',
    'M2 17l10 5 10-5',
    'M2 12l10 5 10-5'
  ],
  rocket: [
    'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z',
    'M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z',
    'M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0',
    'M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5'
  ],
  shield: [
    'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'
  ],
  star: [
    'M12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2z'
  ],
  crosshair: [
    'M12 2a10 10 0 1 0 0.01 0z',
    'M22 12h-4',
    'M6 12H2',
    'M12 6V2',
    'M12 22v-4'
  ]
};

// 已缓存的 Path2D 实例（避免每帧重复解析路径字符串）
const pathCache = new Map();

function getPaths(name) {
  let cached = pathCache.get(name);
  if (cached) return cached;
  const raw = CANVAS_ICON_PATHS[name];
  if (!raw) return null;
  cached = raw.map((d) => new Path2D(d));
  pathCache.set(name, cached);
  return cached;
}

/**
 * 是否为已知的矢量图标名（区别于用户自定义 emoji）
 */
export function isCanvasIcon(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(CANVAS_ICON_PATHS, name);
}

/**
 * 在 (cx, cy) 处居中绘制 size×size 的矢量图标。
 * @returns {boolean} 命中已知图标返回 true（已绘制），否则 false（调用方自行回退）
 */
export function drawCanvasIcon(ctx, name, cx, cy, size, color = '#FFFFFF') {
  const paths = getPaths(name);
  if (!paths) return false;
  const s = size / 24;
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(s, s);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (const p of paths) ctx.stroke(p);
  ctx.restore();
  return true;
}

/**
 * 兼容入口：传入值为已知图标名时画矢量图标；
 * 否则按历史数据（用户自定义 emoji）用 fillText 回退，保证旧缓存可正常显示。
 * @returns {boolean} 是否以矢量图标绘制
 */
export function drawIconOrEmoji(ctx, value, cx, cy, size, color = '#FFFFFF') {
  if (drawCanvasIcon(ctx, value, cx, cy, size, color)) return true;
  if (typeof value === 'string' && value) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = `${size}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(value, cx, cy);
    ctx.restore();
  }
  return false;
}
