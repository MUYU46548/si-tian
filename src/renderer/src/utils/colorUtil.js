// utils/colorUtil.js — **颜色 → 带透明度 CSS 值**的唯一实现（纯函数，Node 可测；2026-10-18）
//
// ── 为什么必须有它（真缺陷，不是洁癖）────────────────────────────────────────
// 星域边界的绘制里写着 `ctx.fillStyle = border.color + '12'`（8 位十六进制带 alpha）。
// 这对 **6 位 hex** 成立；但 `getFactionColor()` 对**不在 `FACTION_COLORS` 表里**的势力名返回
// `hsl(h, 70%, 60%)` —— 于是拼出来是 `hsl(210, 70%, 60%)12`：
//   · **非法 CSS**，给 `fillStyle` / `strokeStyle` / `addColorStop` 赋值会被**静默忽略**
//     （沿用上一个颜色，不报错、不抛异常）；
//   · 表现 = 星域色块/描边用**上一个**星域的颜色画 —— "颜色串了"，而且没人能看出原因。
// 真实库里的势力名当然不在那张硬编码表里 → 这条路径**必然**走到。
//
// ⚠️ `InteriorView.vue` 也有一处 `color + '33'`（同族写法），一并改走本模块。
//
// ── 口径 ───────────────────────────────────────────────────────────────────
//   · 接受 `#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()` / `hsl()` / `hsla()`；
//   · 返回 `rgba(r, g, b, a)`；
//   · **解析不了就原样返回**（不抛、不猜）—— 与"赋值被忽略"的旧行为一致，
//     但调用方可以用 `parseColor()` 自己判 null（别让"未知格式"变成另一个静默）。
//
// 判据：`scripts/tests/unit/test_color_util.js`

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** CSS 里的 alpha 分量**永远是十进制**（`rgba(…, 0.4)` / `50%`）—— 不许按十六进制读 */
function cssAlpha(tok) {
  const s = String(tok).trim();
  if (s.endsWith('%')) return clamp01(parseFloat(s) / 100);
  const f = parseFloat(s);
  return Number.isFinite(f) ? clamp01(f) : 1;
}

/** 把 0~1 的 alpha 或 `'12'`/`'FF'`/`'0.5'` 这类**历史写法**统一成 0~1 的数 */
function toAlpha(alpha) {
  if (typeof alpha === 'number' && Number.isFinite(alpha)) return clamp01(alpha);
  if (typeof alpha === 'string') {
    const s = alpha.trim();
    if (!s) return 1;
    // 🔴 先判十进制（'0' / '1' / '0.5'）：它们同时也是"合法的单字符十六进制"，
    //    先判 hex 会把 `'1'` 读成 1/15 = 6.7%（实测踩到：`withAlpha('#000000','FF')`
    //    得到 `rgba(0,0,0,1)` 之后，parseColor 再把那个 `1` 读成 0.067）。
    if (s === '0' || s === '1' || /^\d*\.\d+$/.test(s)) return clamp01(parseFloat(s));
    // 历史写法是**两位十六进制**（'12' = 0x12/255 ≈ 7%）
    if (/^[0-9a-fA-F]{1,2}$/.test(s)) {
      const n = parseInt(s, 16);
      return clamp01(s.length === 1 ? n / 15 : n / 255);
    }
    const f = parseFloat(s);
    if (Number.isFinite(f)) return clamp01(f);
  }
  return 1;
}

/** hsl → rgb（h 单位度、s/l 单位百分数），返回 [r,g,b] 0~255 */
function hslToRgb(h, s, l) {
  const hh = ((h % 360) + 360) % 360 / 360;
  const ss = Math.max(0, Math.min(1, s / 100));
  const ll = Math.max(0, Math.min(1, l / 100));
  if (ss === 0) { const v = Math.round(ll * 255); return [v, v, v]; }
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const hue2rgb = (t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [
    Math.round(hue2rgb(hh + 1 / 3) * 255),
    Math.round(hue2rgb(hh) * 255),
    Math.round(hue2rgb(hh - 1 / 3) * 255),
  ];
}

/**
 * 解析颜色 → `{ r, g, b, a }`（a 为 0~1）；解析不了返回 `null`。
 * @param {string} color
 * @returns {{r:number,g:number,b:number,a:number}|null}
 */
export function parseColor(color) {
  if (typeof color !== 'string') return null;
  const s = color.trim();
  if (!s) return null;

  // #rgb / #rgba / #rrggbb / #rrggbbaa
  const hex = s.match(/^#([0-9a-fA-F]{3,8})$/);
  if (hex) {
    const h = hex[1];
    const exp = (c) => parseInt(c + c, 16);
    if (h.length === 3 || h.length === 4) {
      const r = exp(h[0]), g = exp(h[1]), b = exp(h[2]);
      const a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1;
      return { r, g, b, a };
    }
    if (h.length === 6 || h.length === 8) {
      const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
    return null;
  }

  // rgb() / rgba()
  const rgb = s.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const num = (p) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
    const r = Math.round(num(parts[0])), g = Math.round(num(parts[1])), b = Math.round(num(parts[2]));
    if (![r, g, b].every(Number.isFinite)) return null;
    const a = parts.length > 3 ? cssAlpha(parts[3]) : 1;
    return { r, g, b, a };
  }

  // hsl() / hsla()
  const hsl = s.match(/^hsla?\(([^)]+)\)$/i);
  if (hsl) {
    const parts = hsl[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const h = parseFloat(parts[0]);
    const sat = parseFloat(parts[1]);
    const lig = parseFloat(parts[2]);
    if (![h, sat, lig].every(Number.isFinite)) return null;
    const [r, g, b] = hslToRgb(h, sat, lig);
    const a = parts.length > 3 ? cssAlpha(parts[3]) : 1;
    return { r, g, b, a };
  }

  return null;
}

/**
 * 给任意颜色加一层透明度（**唯一实现**）：`withAlpha('#4A90D9', '12')` → `rgba(74,144,217,0.071)`。
 *
 * ⚠️ `alpha` 的历史写法是**两位十六进制字符串**（`'12'` ≈ 7%、`'FF'` = 100%），
 *    这里两种都吃（也吃 0~1 的小数），所以旧调用点可以逐字替换。
 * ⚠️ 解析不了的颜色**原样返回**（与旧行为一致），但**不会再拼出非法 CSS**。
 *
 * @param {string} color
 * @param {number|string} [alpha] 0~1 的小数，或两位十六进制字符串
 * @returns {string}
 */
export function withAlpha(color, alpha = 1) {
  const c = parseColor(color);
  if (!c) return color;
  const a = toAlpha(alpha) * c.a;
  const a3 = Math.round(a * 1000) / 1000;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a3})`;
}

/**
 * 把颜色规范成 `#rrggbb`（用作 canvas 颜色 / 8 位 hex 拼接的输入）。
 * 解析不了返回 `null` —— 调用方自己决定回退色（**别静默拼字符串**）。
 */
export function toHex6(color) {
  const c = parseColor(color);
  if (!c) return null;
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}
