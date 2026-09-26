// utils/svgExport.js
// 地图 → SVG 矢量序列化。
//
// 为什么走 SVG：PNG 只能看，SVG 能进 Illustrator / Inkscape 继续加工，且无损放大。
// 曲线约定与 ScenarioMap 的 traceShapePath 保持一致：
//   线段 prev→cur 用 `prev.controlOut`（相对 prev 的偏移）与 `cur.controlIn`（相对 cur 的偏移），
//   **两者都在**才走三次贝塞尔，否则退化为直线。

export function escXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const PX = (p) => (p && p.x !== undefined ? p.x : (p ? p[0] : 0));
const PY = (p) => (p && p.y !== undefined ? p.y : (p ? p[1] : 0));

const num = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);

/**
 * 顶点数组 → SVG path 的 d 属性。
 * @param {Array} points 顶点（{x,y} 或 [x,y]，可带 controlOut/controlIn）
 * @param {{closed?:boolean, straight?:boolean}} opts
 */
export function svgPathD(points, opts = {}) {
  const { closed = true, straight = false } = opts;
  const n = points?.length || 0;
  if (n < 2) return '';
  const out = [`M ${num(PX(points[0]))} ${num(PY(points[0]))}`];
  const last = closed ? n : n - 1;
  for (let i = 1; i <= last; i++) {
    const prev = points[(i - 1) % n];
    const cur = points[i % n];
    const o = prev.controlOut;
    const k = cur.controlIn;
    if (!straight && o && k) {
      out.push(
        `C ${num(PX(prev) + o.x)} ${num(PY(prev) + o.y)}` +
        ` ${num(PX(cur) + k.x)} ${num(PY(cur) + k.y)}` +
        ` ${num(PX(cur))} ${num(PY(cur))}`
      );
    } else {
      out.push(`L ${num(PX(cur))} ${num(PY(cur))}`);
    }
  }
  if (closed) out.push('Z');
  return out.join(' ');
}

/** 一组多边形的世界包围盒 */
export function boundsOf(polys) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let any = false;
  for (const pts of polys) {
    for (const p of pts || []) {
      const x = PX(p), y = PY(p);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      any = true;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!any) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  return { minX, minY, maxX, maxY };
}

const attr = (o) => Object.entries(o)
  .filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([k, v]) => `${k}="${typeof v === 'number' ? num(v) : escXml(v)}"`)
  .join(' ');

export const svgRect = (x, y, w, h, o = {}) => `<rect ${attr({ x, y, width: w, height: h, ...o })}/>`;
export const svgPath = (d, o = {}) => (d ? `<path ${attr({ d, ...o })}/>` : '');
export const svgCircleEl = (cx, cy, r, o = {}) => `<circle ${attr({ cx, cy, r, ...o })}/>`;
export const svgLine = (x1, y1, x2, y2, o = {}) =>
  `<line ${attr({ x1, y1, x2, y2, ...o })}/>`;
export const svgTextEl = (x, y, text, o = {}) =>
  `<text ${attr({ x, y, ...o })}>${escXml(text)}</text>`;
export const svgImageEl = (x, y, w, h, href, o = {}) =>
  `<image ${attr({ x, y, width: w, height: h, href, preserveAspectRatio: 'none', ...o })}/>`;

/**
 * 参考底图 → SVG `<g>` 组（内联位图 + 旋转 / 翻转 / 90° 宽高互换）。
 *
 * 🔴 **几何必须与画布绘制（`planetDrawing.drawReferenceImage`）逐字一致**，
 *    否则「导出的底图角度、占位和画布不一样」—— 而这类不一致**不会报错**。
 *    画布侧的约定（三处视图 AreaMap / InteriorView / PlanetMap 都一样）：
 *      · `rotation` 是**象限索引 0/1/2/3**（不是弧度！）→ 角度 = `rot × 90`
 *      · 90/270 时**交换绘制宽高**（`drawW/drawH`）—— 保持用户校准好的占位框
 *      · `flipH` 在 `rotate` **之后**镜像（顺序不能换）
 *
 * ⚠️ 抽出这一处的直接原因：此前两处导出各写一份，且都写成
 *    `rotation * 180 / Math.PI`（把象限索引当弧度）→ 转 1 次导出成 57°，
 *    还都漏了 `flipH` 与宽高互换。
 *
 * @param {object} r 参考图记录（`{ dataUrl, width, height, scale, rotation, flipH, offsetX, offsetY, opacity }`）
 * @returns {string} 可 push 进 SVG body 的片段（无有效尺寸时返回空串）
 */
export function refImageSvgGroup(r) {
  if (!r || !r.dataUrl) return '';
  const w = (r.width || 0) * (r.scale || 1);
  const h = (r.height || 0) * (r.scale || 1);
  if (!w || !h) return '';
  const rot = (((r.rotation || 0) % 4) + 4) % 4;      // 归一化到 0..3（负数也安全）
  const drawW = rot % 2 === 0 ? w : h;
  const drawH = rot % 2 === 0 ? h : w;
  const cx = r.offsetX ?? 0;
  const cy = r.offsetY ?? 0;
  const flip = r.flipH ? ' scale(-1,1)' : '';
  return `<g transform="translate(${num(cx)},${num(cy)}) rotate(${num(rot * 90)})${flip}">`
    + svgImageEl(-drawW / 2, -drawH / 2, drawW, drawH, r.dataUrl, { opacity: r.opacity ?? 0.6 })
    + '</g>';
}

/**
 * 参考底图在**世界坐标**下的包围盒（已含旋转 —— 90/270 时宽高互换）。
 * 导出算边界时必须用它，否则旋转过的底图会被裁掉一角。
 */
export function refImageWorldBounds(r) {
  if (!r) return null;
  const w = (r.width || 0) * (r.scale || 1);
  const h = (r.height || 0) * (r.scale || 1);
  if (!w || !h) return null;
  const rot = (((r.rotation || 0) % 4) + 4) % 4;
  const bw = rot % 2 === 0 ? w : h;
  const bh = rot % 2 === 0 ? h : w;
  const cx = r.offsetX ?? 0;
  const cy = r.offsetY ?? 0;
  return { minX: cx - bw / 2, minY: cy - bh / 2, maxX: cx + bw / 2, maxY: cy + bh / 2 };
}

/**
 * 斜线纹理图案（EU4 式占领）。
 * 同一颜色只生成一次 def；fill 用 `url(#id)`。
 */
export function hatchPatternDef(color, { id, size = 9, width = 3.2, angle = 45 } = {}) {
  const pid = id || `hatch-${String(color).replace(/[^a-zA-Z0-9]/g, '')}-${size}-${width}`;
  const s = size;
  const d = `M 0 0 L ${s} 0 M -${s / 4} ${s / 4} L ${s / 4} -${s / 4} M ${(3 * s) / 4} ${(3 * s) / 4} L ${(5 * s) / 4} ${-s / 4}`;
  const def = `<pattern id="${escXml(pid)}" width="${num(s)}" height="${num(s)}" patternUnits="userSpaceOnUse" patternTransform="rotate(${num(angle)})">` +
    `<path ${attr({ d, stroke: color, 'stroke-width': width, fill: 'none', 'stroke-linecap': 'square' })}/>` +
    '</pattern>';
  return { id: pid, def };
}

/**
 * 组装完整 SVG 文档。
 * @param {{width:number,height:number,background?:string,defs?:string[],body:string[]}} o
 */
export function serializeSvg({ width, height, background, defs = [], body = [] }) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const bg = background
    ? `<rect x="0" y="0" width="${w}" height="${h}" fill="${escXml(background)}"/>`
    : '';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    defs.length ? `<defs>${defs.join('')}</defs>` : '',
    bg,
    ...body,
    '</svg>',
  ].filter(Boolean).join('\n');
}

/** SVG 字符串 → Blob URL（浏览器回退下载用） */
export function svgToBlobUrl(svg) {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  return URL.createObjectURL(blob);
}

/**
 * 把 SVG 光栅化为 PNG dataURL（用于「同一份矢量资产顺带出 PNG」，保证与 SVG 完全一致）。
 * @param {string} svg
 * @param {number} scale 2 = 2 倍分辨率
 */
export function rasterizeSvg(svg, scale = 2) {
  return new Promise((resolve, reject) => {
    const m = svg.match(/width="(\d+)"\s+height="(\d+)"/);
    const w = m ? Number(m[1]) : 1200;
    const h = m ? Number(m[2]) : 800;
    const img = new Image();
    const url = svgToBlobUrl(svg);
    img.onload = () => {
      try {
        const cv = document.createElement('canvas');
        cv.width = Math.round(w * scale);
        cv.height = Math.round(h * scale);
        const cx = cv.getContext('2d');
        cx.drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        resolve(cv.toDataURL('image/png'));
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG 光栅化失败')); };
    img.src = url;
  });
}

/** 时间戳文件名片段：20260917-1930 */
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
