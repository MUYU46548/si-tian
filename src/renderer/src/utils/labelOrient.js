// utils/labelOrient.js — 导演字号**走向与折行**的纯函数层（C2，2026-10-29）
//
// ── 为什么需要 ────────────────────────────────────────────────────────────────
// 超大国名横排时会横穿省界/整片海洋：真实 415 省项目里「甲午王朝」这类 4 字名还好，
// 一旦是「西境联合总督区」这种长名，整行字就压过好几个省。而国名的天然走向是**领土主轴**
// （EU4/Vic 的国家名要么横着、要么顺着国土长轴），从来不该是"永远水平"。
//
// ── 两条判据（都在这里，画布与导出共用）──────────────────────────────────────
//   ① **主轴旋转**：领土的形状主成分方向（面积加权的第二阶矩）。只有**明显细长**才转
//      （elongation ≥ 1.6），且夹在 ±30° —— 转太多字会"倒着读"，人也认不出那是国名。
//   ② **超宽折行**：一行字的估算宽度超过领土近似宽度时折成两行（CJK 按字、拉丁按空格）。
//      估算不 measureText：这一层是纯函数（Node 可测、SVG 导出也能用），
//      字宽用"CJK ≈ 1em / 其它 ≈ 0.55em"的经验值 —— 只用来决定"折不折"，不用来排版。
//
// 不碰 Vue / DOM / store；`unit/test_label_orient.js` 守。

const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

/** 单字宽度估计（em）：CJK 方块字按 1.0，西文按 0.55（只用于"要不要折行"的判断） */
export function charWidthEm(ch) {
  return CJK_RE.test(ch) ? 1 : 0.55;
}

/** 文本估算宽度（px） */
export function estimateTextWidth(text, fontSize) {
  const s = String(text == null ? '' : text);
  const fs = Number(fontSize) > 0 ? Number(fontSize) : 12;
  let em = 0;
  for (const ch of s) em += charWidthEm(ch);
  return em * fs;
}

/**
 * 协方差 → 主轴角与细长比（`principalAxisAngle` 与 `aggregateTerritories` 共用一份数学）。
 * @param {number} vxx Σ(x-cx)² 的加权平均
 * @param {number} vyy Σ(y-cy)² 的加权平均
 * @param {number} vxy Σ(x-cx)(y-cy) 的加权平均
 * @returns {{angle:number, elongation:number}}
 */
export function axisFromMoments(vxx, vyy, vxy) {
  const a = Number(vxx) || 0, b = Number(vyy) || 0, c = Number(vxy) || 0;
  const tr = a + b;
  const det = a * b - c * c;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  const l2 = Math.max(1e-9, tr / 2 - disc);
  const elongation = Math.sqrt(Math.max(1, l1 / l2));
  // 主轴角：cov 矩阵最大特征向量的方向；atan2 给出 (-90°,90°]，正好不会倒写字
  let angle = 0.5 * Math.atan2(2 * c, a - b);
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle <= -Math.PI / 2) angle += Math.PI;
  return { angle, elongation };
}

/**
 * 形状主轴：面积加权的第二阶矩 → 主轴角（弧度，规范到 (-90°, 90°]，保证字不倒着写）。
 * @param {Array<{x:number,y:number}|[number,number]>} points 环顶点
 * @returns {{angle:number, elongation:number}} `elongation` = 长轴/短轴比（≥1，圆的 ≈1）
 */
export function principalAxisAngle(points) {
  const pts = Array.isArray(points) ? points : [];
  const n = pts.length;
  if (n < 3) return { angle: 0, elongation: 1 };
  let sx = 0, sy = 0, cnt = 0;
  for (const p of pts) {
    const x = Array.isArray(p) ? Number(p[0]) : Number(p && p.x);
    const y = Array.isArray(p) ? Number(p[1]) : Number(p && p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sx += x; sy += y; cnt += 1;
  }
  if (cnt < 3) return { angle: 0, elongation: 1 };
  const mx = sx / cnt, my = sy / cnt;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) {
    const x = (Array.isArray(p) ? Number(p[0]) : Number(p && p.x)) - mx;
    const y = (Array.isArray(p) ? Number(p[1]) : Number(p && p.y)) - my;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sxx += x * x; syy += y * y; sxy += x * y;
  }
  return axisFromMoments(sxx / cnt, syy / cnt, sxy / cnt);
}

/**
 * 折行：把文本切成最多 `maxLines` 行，使每行估算宽度 ≤ `maxWidthPx`。
 * · 有空格 → 优先在空格处断（英文名不会被切在词中间）；
 * · 全是 CJK → 按字断（字与字之间没有空格可断）；
 * · 实在放不下 → 返回能放下的行（不硬塞第三行：国名变成一段话比横穿更糟）。
 * @param {string} text
 * @param {number} maxWidthPx
 * @param {number} fontSize
 * @param {{maxLines?:number}} [opts]
 * @returns {string[]}
 */
export function splitLabelLines(text, maxWidthPx, fontSize, opts = {}) {
  const s = String(text == null ? '' : text).trim();
  const maxLines = Math.max(1, Math.min(3, Math.floor(Number(opts.maxLines) || 2)));
  const limit = Number(maxWidthPx);
  if (!s) return [];
  if (!(limit > 0) || estimateTextWidth(s, fontSize) <= limit) return [s];
  if (maxLines === 1) return [s];

  // 先按"词"分组：有空格就词组，否则单字
  const words = s.includes(' ') ? s.split(/\s+/) : Array.from(s);
  const sep = s.includes(' ') ? ' ' : '';
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur}${sep}${w}` : w;
    if (cur && estimateTextWidth(next, fontSize) > limit && lines.length < maxLines - 1) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** 旋转夹持：±30°（转太多就"倒着读"了） */
export const POLITY_MAX_ROTATE = Math.PI / 6;
/** 转不转的判据：细长比 ≥ 1.6 才认为是"有走向"的国土 */
export const POLITY_ROTATE_ELONGATION = 1.6;

/**
 * 导演字号**形状决策**（画布与导出共用）：
 * @param {{text:string, fontSize:number, maxWidthPx:number, axis?:number, elongation?:number}} o
 * @returns {{lines:string[], rotate:number, widthPx:number}}
 *          `widthPx` = 折行后**最长一行**的估算宽度（调用方按它算排布盒子）
 */
export function planPolityShape(o) {
  const text = String((o && o.text) || '').trim();
  const fontSize = Number(o && o.fontSize) > 0 ? Number(o.fontSize) : 22;
  const maxWidthPx = Number(o && o.maxWidthPx);
  const elongation = Number(o && o.elongation);
  const axis = Number(o && o.axis);
  const rotate = (Number.isFinite(elongation) && elongation >= POLITY_ROTATE_ELONGATION && Number.isFinite(axis))
    ? Math.max(-POLITY_MAX_ROTATE, Math.min(POLITY_MAX_ROTATE, axis))
    : 0;
  const lines = splitLabelLines(text, maxWidthPx, fontSize, { maxLines: 2 });
  let widthPx = 0;
  for (const l of lines) widthPx = Math.max(widthPx, estimateTextWidth(l, fontSize));
  return { lines: lines.length ? lines : [text], rotate, widthPx };
}
