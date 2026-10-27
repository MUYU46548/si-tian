// utils/scenarioTextPlacement.js — 剧本侧「城镇名 / 河流名」的取数与分级（纯函数，2026-10-25）
//
// 为什么单独一层：617 个城镇、160 条河，全画名字就是一张糊掉的图。分级规则必须
// 画布与导出**共用**，否则「画布上只标首都、导出图里标了 617 个」这种不一致不会报错，
// 只会让成品图没法用。
//
// 分级（按缩放，刻度是「屏幕像素/世界单位」）：
//   · 城镇：<1 只标首都；1~2 首都 + 人口前 40；≥2 全部（上限 150）
//   · 河流：<1.2 不标；1.2~2 流量前 30；≥2 全部（上限 80）
// 导出是固定分辨率图，用**出版档**：首都 + 流量前 12 的河（`EXPORT_*`）。
//
// 纯函数：不碰 DOM / store；Node 可直接测。

export const BURG_TIERS = Object.freeze({
  /** 缩放 <1：只标首都 */
  capitalOnly: 0,
  /** 1~2：首都 + 人口前 40 */
  major: 1,
  /** ≥2：全部（可见范围内，上限 150） */
  all: 2,
});

export function burgLabelTier(scale) {
  const s = Number(scale) || 0;
  if (s >= 2) return BURG_TIERS.all;
  if (s >= 1) return BURG_TIERS.major;
  return BURG_TIERS.capitalOnly;
}

export function riverLabelTier(scale) {
  const s = Number(scale) || 0;
  if (s >= 2) return 2;
  if (s >= 1.2) return 1;
  return -1;   // 画布：低缩放不标河名（导出用 0 档）
}

const MAX_BURG_LABELS = Object.freeze({ 0: 30, 1: 80, 2: 150 });
const MAX_RIVER_LABELS = Object.freeze({ 0: 0, 1: 30, 2: 80 });

/** 出图档：全图只标首都 + 流量前 12 的河 */
export const EXPORT_BURG_TIER = BURG_TIERS.capitalOnly;
export const EXPORT_RIVER_TIER = 0;

function inRect(x, y, rect) {
  if (!rect) return true;
  return x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY;
}

function isCapital(b) {
  return !!(b && (b.capital || b.group === 'capital'));
}

function populationOf(b) {
  const n = Number(b && b.population);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 城镇名候选。
 * @param {Array} burgs `baseMap.burgs`
 * @param {{tier?:number, rect?:{minX,maxX,minY,maxY}, max?:number}} opts
 * @returns {Array<{id,name,x,y,capital:boolean,population:number}>}
 */
export function collectBurgLabels(burgs, { tier = BURG_TIERS.capitalOnly, rect = null, max = null } = {}) {
  const list = (Array.isArray(burgs) ? burgs : [])
    .filter((b) => b && b.name && Number.isFinite(b.x) && Number.isFinite(b.y))
    .filter((b) => inRect(b.x, b.y, rect));
  let picked;
  if (tier <= BURG_TIERS.capitalOnly) {
    picked = list.filter(isCapital);
  } else if (tier === BURG_TIERS.major) {
    const caps = list.filter(isCapital);
    const rest = list.filter((b) => !isCapital(b))
      .sort((a, b) => (populationOf(b) - populationOf(a)) || String(a.name).localeCompare(String(b.name), 'zh'))
      .slice(0, 40);
    picked = [...caps, ...rest];
  } else {
    picked = list.slice().sort((a, b) => {
      const ca = isCapital(a) ? 1 : 0, cb = isCapital(b) ? 1 : 0;
      if (ca !== cb) return cb - ca;
      return (populationOf(b) - populationOf(a)) || String(a.name).localeCompare(String(b.name), 'zh');
    });
  }
  const cap = Number(max) > 0 ? Number(max) : (MAX_BURG_LABELS[tier] || MAX_BURG_LABELS[0]);
  return picked.slice(0, cap).map((b) => ({
    id: b.id, name: b.name, x: b.x, y: b.y,
    capital: isCapital(b), population: populationOf(b),
  }));
}

/** 折线按长度取中点（河流名落点） */
export function polylineMidpoint(points) {
  const pts = (Array.isArray(points) ? points : [])
    .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!pts.length) return null;
  if (pts.length === 1) return { x: pts[0].x, y: pts[0].y };
  let total = 0;
  const seg = [];
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    seg.push(d);
    total += d;
  }
  if (!(total > 0)) return { x: pts[0].x, y: pts[0].y };
  let acc = 0;
  const half = total / 2;
  for (let i = 0; i < seg.length; i++) {
    if (acc + seg[i] >= half) {
      const t = seg[i] > 0 ? (half - acc) / seg[i] : 0;
      return {
        x: pts[i].x + (pts[i + 1].x - pts[i].x) * t,
        y: pts[i].y + (pts[i + 1].y - pts[i].y) * t,
      };
    }
    acc += seg[i];
  }
  return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
}

function riverWeight(r) {
  const d = Number(r && r.discharge);
  if (Number.isFinite(d)) return d;
  const w = Number(r && r.width);
  return Number.isFinite(w) ? w : 0;
}

/**
 * 河流名候选（只取有名字的；没名字不臆造）。
 * @param {Array} rivers `baseMap.rivers`
 * @param {{tier?:number, rect?:{minX,maxX,minY,maxY}, max?:number}} opts
 */
export function collectRiverLabels(rivers, { tier = 0, rect = null, max = null } = {}) {
  if (tier < 0) return [];
  // 河名沿河（2026-10-27）：把折线一并带出来 —— 画布/导出要按走向排字，
  // 只给一个中点锚点就只能写水平字（"名字横跨河湾"）。points 是**原数组引用**，
  // 不做拷贝：160 条河 × 上百点，每帧复制一遍不值得（读侧只读不改）。
  const withPath = (r, mid) => ({
    id: r.id, name: r.name, x: mid.x, y: mid.y, weight: riverWeight(r),
    path: Array.isArray(r.points) && r.points.length >= 2 ? r.points : null,
  });
  if (tier === 0) {
    // 出图档：全图只标流量前 12 的河
    const list = (Array.isArray(rivers) ? rivers : [])
      .filter((r) => r && r.name)
      .sort((a, b) => riverWeight(b) - riverWeight(a));
    return list.slice(0, Number(max) > 0 ? Number(max) : 12).map((r) => {
      const mid = polylineMidpoint(r.points);
      return mid ? withPath(r, mid) : null;
    }).filter(Boolean);
  }
  const list = (Array.isArray(rivers) ? rivers : [])
    .filter((r) => r && r.name)
    .map((r) => {
      const mid = polylineMidpoint(r.points);
      if (!mid || !inRect(mid.x, mid.y, rect)) return null;
      return withPath(r, mid);
    })
    .filter(Boolean)
    .sort((a, b) => b.weight - a.weight);
  const cap = Number(max) > 0 ? Number(max) : (MAX_RIVER_LABELS[tier] || 30);
  return list.slice(0, cap);
}
