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

function cleanPoints(points) {
  return Array.isArray(points)
    ? points.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
    : [];
}

/**
 * 折线上离目标点最近的投影（河名沿河时用来把「避让排布给的落点」投到河道上）。
 * @returns {{x:number,y:number,s:number,dist:number}|null} `s` = 从起点算的弧长；无有效折线 → null
 */
export function nearestPointOnPath(points, target) {
  const src = cleanPoints(points);
  if (!src.length) return null;
  const tx = target && Number.isFinite(target.x) ? target.x : src[0].x;
  const ty = target && Number.isFinite(target.y) ? target.y : src[0].y;
  let best = { x: src[0].x, y: src[0].y, s: 0, dist: Math.hypot(tx - src[0].x, ty - src[0].y) };
  let acc = 0;
  for (let i = 1; i < src.length; i++) {
    const ax = src[i - 1].x, ay = src[i - 1].y;
    const dx = src[i].x - ax, dy = src[i].y - ay;
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-9)) continue;
    let t = ((tx - ax) * dx + (ty - ay) * dy) / (len * len);
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    const px = ax + dx * t, py = ay + dy * t;
    const dist = Math.hypot(tx - px, ty - py);
    if (dist < best.dist) best = { x: px, y: py, s: acc + len * t, dist };
    acc += len;
  }
  return best;
}

/**
 * 取折线上「以某点为中心、总长不超过 span」的一段。
 *
 * 为什么需要它：河名沿河排字时若把**整条河**喂给 `layoutTextAlongPath`，字会跑到河的中点，
 * 而避让排布刚刚判定「这个名字放在这里放得下」——两处位置不一致，避让就白做了。
 * 这里先把排布给的落点投到河道上（最近投影），再取它两侧的一段，字数才落在判定过的位置。
 *
 * 边界：span 超过整条河 → 整条返回（由调用方判断字是否放得下，**不压缩字距**）；
 *       窗口贴到端点时向另一端平移（保持 span 长度，别让字挤在端点）。
 */
export function slicePathAroundPoint(points, target, span) {
  const src = cleanPoints(points);
  if (src.length < 2) return src.slice();
  const total = pathLength(src);
  if (!(total > 0)) return src.slice();
  const want = Number(span) > 0 ? Number(span) : total;

  const np = nearestPointOnPath(src, target);
  const s0 = np ? np.s : total / 2;
  let lo = s0 - want / 2;
  let hi = s0 + want / 2;
  if (lo < 0) { lo = 0; hi = Math.min(total, want); }
  if (hi > total) { hi = total; lo = Math.max(0, total - want); }

  // 累计弧长（cum[i] = 起点到第 i 个顶点的长度）
  const cum = [0];
  for (let i = 1; i < src.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(src[i].x - src[i - 1].x, src[i].y - src[i - 1].y));
  }
  const pointAt = (s) => {
    const v = Math.max(0, Math.min(total, s));
    for (let i = 1; i < src.length; i++) {
      if (v <= cum[i] || i === src.length - 1) {
        const segLen = cum[i] - cum[i - 1];
        const t = segLen > 1e-9 ? (v - cum[i - 1]) / segLen : 0;
        return {
          x: src[i - 1].x + (src[i].x - src[i - 1].x) * t,
          y: src[i - 1].y + (src[i].y - src[i - 1].y) * t,
        };
      }
    }
    return { x: src[src.length - 1].x, y: src[src.length - 1].y };
  };

  const out = [pointAt(lo)];
  for (let i = 1; i < src.length - 1; i++) {
    if (cum[i] > lo && cum[i] < hi) out.push({ x: src[i].x, y: src[i].y });
  }
  const end = pointAt(hi);
  const last = out[out.length - 1];
  if (!last || Math.hypot(end.x - last.x, end.y - last.y) > 1e-9) out.push(end);
  return out;
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
