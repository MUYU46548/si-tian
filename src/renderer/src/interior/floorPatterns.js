// interior/floorPatterns.js — 房间地面 / 吊顶材质目录（纯函数，2026-11-15，A23/A15）
//
// ── 为什么单独一个文件 ────────────────────────────────────────────────────
// 材质要同时出现在三个地方：平面图（2D 填充 + 纹理线）、3D（房间地面 / 吊顶面）、UI 下拉。
// 三处各写一份色表 = 迟早漂移（本项目已有先例：`BIOME_COLORS` 两份定义已经漂过一次）。
// 这里只放**数据 + 纯计算**：不 import 任何项目模块，也不碰 canvas / three / store，
// 所以 `unit/test_floor_patterns.js` 能在 Node 里直测。
//
// ── 两个口径 ──────────────────────────────────────────────────────────────
// ① **世界单位 = 厘米**：纹理线的间距（板宽 18cm、瓷砖 30cm）都是厘米，跟着缩放走，
//    不随屏幕像素变 —— 否则放大到 8 倍时木地板会变成一堆细线。
// ② **渲染线宽按屏幕给**：`lineWidth = 0.8 / zoom`，缩放时线粗细不变。
//
// ── 一条纪律（照抄 terrain 那轮的教训）────────────────────────────────────
// 纹理里**不许有逐像素随机**：`Math.random()` 会让每次重绘的纹理都变，用户会觉得画面在抖。
// 这里全部是确定性规则（板缝相位由行号算），同一房间任何时候画出来一模一样。

/** 地面材质目录（顺序即下拉顺序；`none` 必须排第一 = 默认值） */
export const FLOOR_TEXTURES = Object.freeze([
  { id: 'none', label: '纯色', pattern: 'none', base: '', line: '', three: '#d8d3c8' },
  {
    id: 'wood', label: '木地板', pattern: 'plank',
    base: '#c9a97e', line: '#9c7845', three: '#c2a076',
    unit: 18,      // 板宽（cm）
    span: 110,     // 板长 / 错缝间隔（cm）
  },
  {
    id: 'tile', label: '瓷砖', pattern: 'grid',
    base: '#dfe6ea', line: '#aab8c2', three: '#d6dde2',
    unit: 30, span: 30,
  },
  {
    id: 'stone', label: '石材', pattern: 'offset',
    base: '#cfc9bf', line: '#9c9485', three: '#c6c0b6',
    unit: 45, span: 70,
  },
  {
    id: 'carpet', label: '地毯', pattern: 'weave',
    base: '#b9c3cc', line: '#8f9ca8', three: '#b1bbc4',
    unit: 9, span: 9,
  },
  {
    id: 'concrete', label: '水泥', pattern: 'grid',
    base: '#c6c5c0', line: '#a09f98', three: '#bebdb8',
    unit: 60, span: 60,
  },
]);

/** 吊顶材质目录（`none` = 不设吊顶，房间里就没有 ceiling 字段） */
export const CEILING_TEXTURES = Object.freeze([
  { id: 'none', label: '无吊顶' },
  { id: 'plaster', label: '石膏板', base: '#eceae4', three: '#e8e5de' },
  { id: 'wood', label: '木饰面', base: '#cbb08d', three: '#c4a982' },
  { id: 'grid', label: '铝扣板', base: '#dfe3e7', three: '#d7dbdf' },
]);

/** 吊顶高度允许区间（cm）。下限 200 是"再矮就不是房间了"，上限 800 防手滑多打一个 0 */
export const CEILING_MIN_CM = 200;
export const CEILING_MAX_CM = 800;

const FLOOR_IDS = FLOOR_TEXTURES.map((t) => t.id);
const CEILING_IDS = CEILING_TEXTURES.map((t) => t.id);

/** 规整地面材质 id：不认识的一律回落到 `wood`（历史数据里 `floorTexture` 默认就是 'wood'） */
export function normalizeFloorTexture(id) {
  const s = typeof id === 'string' ? id.trim() : '';
  return FLOOR_IDS.includes(s) ? s : 'wood';
}

/** 取地面材质描述（永不返回 undefined） */
export function floorTextureOf(id) {
  const s = normalizeFloorTexture(id);
  return FLOOR_TEXTURES.find((t) => t.id === s) || FLOOR_TEXTURES[0];
}

/** 规整吊顶材质 id：不认识的回落到 `plaster`（用户明确设了吊顶，就别悄悄变成"没有"） */
export function normalizeCeilingTexture(id) {
  const s = typeof id === 'string' ? id.trim() : '';
  if (!s || s === 'none') return 'none';
  return CEILING_IDS.includes(s) ? s : 'plaster';
}

export function ceilingTextureOf(id) {
  const s = normalizeCeilingTexture(id);
  return CEILING_TEXTURES.find((t) => t.id === s) || CEILING_TEXTURES[0];
}

/**
 * 规整房间的 `ceiling` 字段。
 *   · `null` / `undefined` / `{texture:'none'}` → `null`（= 没有吊顶，字段不落盘）
 *   · 高度缺省或越界 → 夹到 [200, 800]
 * @returns {{texture:string, height:number}|null}
 */
export function normalizeCeiling(ceiling) {
  if (!ceiling || typeof ceiling !== 'object') return null;
  const texture = normalizeCeilingTexture(ceiling.texture);
  if (texture === 'none') return null;
  const raw = Number(ceiling.height);
  const height = Number.isFinite(raw)
    ? Math.min(CEILING_MAX_CM, Math.max(CEILING_MIN_CM, Math.round(raw)))
    : 260;                       // 常见住宅净高（层高 300 − 楼板/吊顶 40）
  return { texture, height };
}

/** 2D 用色：打印态（白纸）把底色往白里调，深色主题原样 —— 纸上太深的底色会盖住墙线 */
export function floorTextureCss(id, theme = 'dark') {
  const t = floorTextureOf(id);
  if (t.pattern === 'none' || !t.base) return '';
  return theme === 'print' ? mixHex(t.base, '#ffffff', 0.42) : t.base;
}

/** 2D 纹理线用色（打印态再淡一档） */
export function floorTextureLineCss(id, theme = 'dark') {
  const t = floorTextureOf(id);
  if (t.pattern === 'none' || !t.line) return '';
  return theme === 'print' ? mixHex(t.line, '#ffffff', 0.3) : t.line;
}

/** 3D 用色（three 里受光照影响，这里给的是材质本色） */
export function floorTextureThree(id) {
  const t = floorTextureOf(id);
  return t.three || t.base || '#c9a97e';
}

export function ceilingTextureThree(id) {
  const t = ceilingTextureOf(id);
  return t.three || t.base || '#e8e5de';
}

export function ceilingTextureCss(id) {
  const t = ceilingTextureOf(id);
  return t.base || '#eceae4';
}

/**
 * 生成纹理线（世界坐标）。
 *
 * @param {string} id 材质 id
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} rect 要铺的范围（通常是房间包围盒）
 * @param {{maxLines?:number}} [opts] 线数上限（防止超大房间生成十万条线）
 * @returns {Array<{x1:number,y1:number,x2:number,y2:number}>}
 */
export function floorPatternSegments(id, rect, opts = {}) {
  const t = floorTextureOf(id);
  if (t.pattern === 'none' || !rect) return [];
  const minX = Number(rect.minX);
  const minY = Number(rect.minY);
  const maxX = Number(rect.maxX);
  const maxY = Number(rect.maxY);
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return [];
  const w = maxX - minX;
  const h = maxY - minY;
  if (!(w > 0) || !(h > 0)) return [];

  const maxLines = Math.max(40, Math.min(6000, Number(opts.maxLines) || 2200));
  let unit = Math.max(2, Number(t.unit) || 30);
  let span = Math.max(unit, Number(t.span) || unit);

  // 房间太大时把间距整体放大，保证线数有界（宁可纹理变粗，也别画十万条线卡住画布）
  const estimate = () => (h / unit + 1) + (w / span + 1) + (t.pattern === 'grid' ? (w / unit + 1) : 0);
  let guard = 8;
  while (estimate() > maxLines && guard-- > 0) { unit *= 1.6; span *= 1.6; }

  const out = [];
  const push = (x1, y1, x2, y2) => out.push({ x1, y1, x2, y2 });

  if (t.pattern === 'plank') {
    // 横缝：每 unit 一条（板宽）
    for (let y = minY + unit; y < maxY; y += unit) push(minX, y, maxX, y);
    // 板端：每 span 一条，隔行错半个 span（真木地板就是这么铺的）
    let r = 0;
    for (let y = minY; y < maxY; y += unit, r++) {
      const offset = (r % 2) ? span / 2 : 0;
      for (let x = minX + offset; x < maxX; x += span) push(x, y, x, Math.min(maxY, y + unit));
    }
    return out;
  }

  if (t.pattern === 'offset') {
    // 石材：行高 span，行内竖缝每 unit、隔行错半格
    let r = 0;
    for (let y = minY; y < maxY; y += span, r++) {
      push(minX, y, maxX, y);
      const offset = (r % 2) ? unit / 2 : 0;
      for (let x = minX + offset; x < maxX; x += unit) push(x, y, x, Math.min(maxY, y + span));
    }
    return out;
  }

  // grid / weave：横竖都要
  for (let y = minY + unit; y < maxY; y += unit) push(minX, y, maxX, y);
  for (let x = minX + unit; x < maxX; x += unit) push(x, minY, x, maxY);
  return out;
}

/**
 * 纹理线的透明度和线宽（屏幕像素口径）。
 * 地毯是"密而淡"，木材/石材是"疏而清"。
 */
export function floorPatternStyle(id, theme = 'dark') {
  const t = floorTextureOf(id);
  if (t.pattern === 'weave') return { alpha: theme === 'print' ? 0.18 : 0.32, widthPx: 0.5 };
  return { alpha: theme === 'print' ? 0.35 : 0.6, widthPx: 0.8 };
}

/** #rrggbb 混色（t=0 → a，t=1 → b） */
export function mixHex(a, b, t) {
  const pa = parseHex(a);
  const pb = parseHex(b);
  if (!pa || !pb) return a || b || '#000000';
  const k = Math.min(1, Math.max(0, Number(t) || 0));
  const ch = (i) => Math.round(pa[i] + (pb[i] - pa[i]) * k);
  return '#' + [ch(0), ch(1), ch(2)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function parseHex(v) {
  const s = String(v || '').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) return null;
  return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
}
