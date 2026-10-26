// utils/textOnPath.js — 沿路径排字（纯几何；2026-10-26）
//
// ── 为什么需要它 ────────────────────────────────────────────────────────────
// 参考图的"山系名沿山脊、河名沿河、海名沿湾"是**制图惯例**：字沿着地物的走向排，
// 读者一眼就知道"这个名字属于哪条线"。我们所有标签都是水平字 —— 一张图上
// 山名横着压在山脊上，等于没标。
//
// ── 口径 ────────────────────────────────────────────────────────────────────
// · 只算**每个字的位置与旋转角**，不碰 canvas（画法在 `labelStyles.drawTextAlongPath`）；
// · 输入是**屏幕坐标**的折线 + 字宽序列（调用方量好字宽 / 给出估算）；
// · 字距均匀、整段文字**居中**放在路径中段（参考图的山名几乎都居中在脊线上）；
// · 路径不够长 → `ok:false`、`placed:[]`（调用方据此换小字号或放弃，**绝不压缩字距**）；
// · 路径整体朝左 → 先把点反序，保证字不倒着读；
// · 单字切线过陡（> `maxTiltDeg`）→ 该字跳过（避免竖起来的字），其余照排。
//
// 纯函数：不碰 DOM / store，Node 可直接测（`scripts/tests/unit/test_text_on_path.js`）。

/** 折线总长（屏幕单位） */
export function pathLength(points) {
  const src = Array.isArray(points) ? points : [];
  let total = 0;
  for (let i = 1; i < src.length; i++) {
    total += Math.hypot(src[i].x - src[i - 1].x, src[i].y - src[i - 1].y);
  }
  return total;
}

/** 估算字宽（没有 measure 时的兜底：CJK / 全角按 1em，拉丁按 0.55em） */
export function estimateCharWidth(ch, fontSize) {
  const size = Number(fontSize) > 0 ? fontSize : 12;
  const code = String(ch).codePointAt(0) || 0;
  // CJK 统一表意文字 / 假名 / 全角标点 / 韩文
  const wide = (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xff60);
  return wide ? size : size * 0.55;
}

/**
 * 沿折线排字。
 *
 * @param {string} text
 * @param {Array<{x:number,y:number}>} points 屏幕坐标折线
 * @param {object} [opts]
 * @param {(ch:string)=>number} [opts.measure] 单字宽度（默认 `estimateCharWidth`）
 * @param {number} [opts.fontSize=12] 字高（只用于默认字宽估算）
 * @param {number} [opts.letterSpacing=1] 字间额外间距（屏幕单位）
 * @param {number} [opts.maxTiltDeg=70] 切线超过这个角度就跳过该字
 * @returns {{placed:Array<{ch:string,x:number,y:number,angle:number}>, ok:boolean,
 *            width:number, pathLength:number}}
 */
export function layoutTextAlongPath(text, points, opts = {}) {
  const src = Array.isArray(points) ? points.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)) : [];
  const chars = Array.from(String(text == null ? '' : text));
  const empty = { placed: [], ok: false, width: 0, pathLength: pathLength(src) };
  if (!chars.length || src.length < 2) return empty;

  const fontSize = Number(opts.fontSize) > 0 ? opts.fontSize : 12;
  const spacing = Number.isFinite(opts.letterSpacing) ? opts.letterSpacing : 1;
  const maxTilt = (Number.isFinite(opts.maxTiltDeg) ? opts.maxTiltDeg : 70) * Math.PI / 180;
  const measure = typeof opts.measure === 'function'
    ? opts.measure
    : (ch) => estimateCharWidth(ch, fontSize);

  const widths = chars.map((ch) => {
    const w = Number(measure(ch));
    return w > 0 ? w : estimateCharWidth(ch, fontSize);
  });
  const width = widths.reduce((a, b) => a + b, 0) + spacing * Math.max(0, chars.length - 1);

  // 统一从左到右：整条路径朝左就把点反序（否则字会倒着读）
  let pts = src;
  const netX = pts[pts.length - 1].x - pts[0].x;
  if (netX < 0) pts = pts.slice().reverse();

  const total = pathLength(pts);
  if (!(total > 0) || width > total) {
    return { placed: [], ok: false, width, pathLength: total };
  }

  // 预计算逐段累计长度
  const segs = [];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    const len = Math.hypot(dx, dy);
    segs.push({ x0: pts[i - 1].x, y0: pts[i - 1].y, dx, dy, len, start: acc });
    acc += len;
  }

  const at = (s) => {
    const v = Math.max(0, Math.min(total, s));
    // 线性找段（一条脊线几十个点，二分不值得）
    for (const g of segs) {
      if (v <= g.start + g.len || g === segs[segs.length - 1]) {
        const t = g.len > 1e-9 ? (v - g.start) / g.len : 0;
        return {
          x: g.x0 + g.dx * t,
          y: g.y0 + g.dy * t,
          angle: Math.atan2(g.dy, g.dx),
        };
      }
    }
    const g = segs[segs.length - 1];
    return { x: g.x0 + g.dx, y: g.y0 + g.dy, angle: Math.atan2(g.dy, g.dx) };
  };

  const placed = [];
  let cursor = (total - width) / 2;
  for (let i = 0; i < chars.length; i++) {
    const center = cursor + widths[i] / 2;
    const p = at(center);
    let angle = p.angle;
    // 归一化到 (-π/2, π/2]：倒着的字翻正（只是旋转，不换位置）
    if (angle > Math.PI / 2) angle -= Math.PI;
    if (angle <= -Math.PI / 2) angle += Math.PI;
    if (Math.abs(angle) <= maxTilt) {
      placed.push({ ch: chars[i], x: p.x, y: p.y, angle });
    }
    cursor += widths[i] + spacing;
  }
  return { placed, ok: placed.length > 0, width, pathLength: total };
}
