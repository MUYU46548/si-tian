// utils/settlement.js — 聚落规模 / 人口 / 文化归属（P1-3 Burg Editor）
//
// 参考 Azgaar 的 Burg editor：
//   · 人口用**对数滑块**（100 ~ 1,000,000），线性滑块在低段几乎动不了
//   · 人口决定聚落分级（小村庄/村庄/城镇/城市），分级决定地图图标尺寸
//   · 文化归属：cultureId，-1（或 null）= 无归属，显示文化名 + 主色
//
// 数据落点（与本仓库既有架构一致，非提示词里假设的 mapData.burgs）：
//   聚落本体是 Obsidian 词条 → GeoNode；人口/文化写在**节点**上
//   （与既有的 placeType / tags 同一套机制：updateNode → undo 一条命令 → 随 geodata.json 落盘）。
//   文化列表是行星级共享数据，放 mapData[planetId].cultures。
export const POP_MIN = 100;
export const POP_MAX = 1000000;

/** 分级阈值（人口 → tier）。doc 明确：<1k 小村庄 / 1k~10k 村庄 / 10k~100k 城镇 / 100k+ 城市 */
export const SETTLEMENT_TIERS = [
  { key: 'hamlet', label: '小村庄', min: 0, max: 1000, scale: 0.78, color: '#8B98A5' },
  { key: 'village', label: '村庄', min: 1000, max: 10000, scale: 0.92, color: '#4ECDC4' },
  { key: 'town', label: '城镇', min: 10000, max: 100000, scale: 1.15, color: '#4ECDC4' },
  { key: 'city', label: '城市', min: 100000, max: Infinity, scale: 1.45, color: '#5B8DEF' },
];

export const CULTURE_NONE_ID = -1;

/** 文化调色板（新建文化时轮转取色） */
export const CULTURE_COLORS = [
  '#E74C3C', '#E67E22', '#F1C40F', '#2ECC71', '#1ABC9C',
  '#3498DB', '#9B59B6', '#E91E63', '#FF6B6B', '#32CD32',
];

export function clampPop(pop) {
  const n = Number(pop);
  if (!Number.isFinite(n)) return POP_MIN;
  return Math.round(Math.min(POP_MAX, Math.max(POP_MIN, n)));
}

/**
 * 人口 ↔ 对数滑块（0–100）。
 * 滑块 0 → POP_MIN，滑块 100 → POP_MAX；中段近似几何级数。
 */
export function popToSlider(pop) {
  const p = clampPop(pop);
  const lo = Math.log(POP_MIN);
  const hi = Math.log(POP_MAX);
  return Math.round(((Math.log(p) - lo) / (hi - lo)) * 100);
}

export function sliderToPop(v) {
  const t = Math.min(100, Math.max(0, Number(v) || 0)) / 100;
  const lo = Math.log(POP_MIN);
  const hi = Math.log(POP_MAX);
  const raw = Math.exp(lo + (hi - lo) * t);
  // 取整到"人类可读"的档位（100 以下不留零头）
  if (raw < 1000) return Math.round(raw / 50) * 50;
  if (raw < 10000) return Math.round(raw / 100) * 100;
  if (raw < 100000) return Math.round(raw / 1000) * 1000;
  return Math.round(raw / 10000) * 10000;
}

/** 人口 → 分级 */
export function tierOf(pop) {
  const p = clampPop(pop);
  return SETTLEMENT_TIERS.find(t => p >= t.min && p < t.max) || SETTLEMENT_TIERS[SETTLEMENT_TIERS.length - 1];
}

export function tierLabelOf(pop) {
  const t = tierOf(pop);
  return `${t.label}（${formatPop(clampPop(pop))} 人）`;
}

/**
 * 地图上聚落图标的半径：layer 基准半径 × 分级系数。
 * 没有 population 的聚落保持原样（向后兼容旧数据）。
 */
export function settlementRadius(baseRadius, population) {
  if (!Number.isFinite(population) || population <= 0) return baseRadius;
  return Math.round(baseRadius * tierOf(population).scale * 10) / 10;
}

/** 人口 → 带宽度的可读文本：1.2万 / 8500 */
export function formatPop(pop) {
  const p = clampPop(pop);
  if (p >= 10000) {
    const w = p / 10000;
    return `${w >= 100 ? Math.round(w) : Math.round(w * 10) / 10}万`;
  }
  return String(p);
}

/** 取文化对象（-1 / null / 找不到 → null 表示无归属） */
export function resolveCulture(cultures, cultureId) {
  if (cultureId === null || cultureId === undefined || cultureId === CULTURE_NONE_ID) return null;
  return (cultures || []).find(c => c.id === cultureId) || null;
}

/** 聚落编辑用的默认值（新建聚落 / 首次打开编辑器） */
export function defaultSettlementMeta(layer) {
  const base = layer === 'city' ? 200000 : layer === 'town' ? 20000 : 1200;
  return { population: base, cultureId: CULTURE_NONE_ID };
}

export function isSettlementLayer(layer) {
  return layer === 'city' || layer === 'town' || layer === 'village';
}
