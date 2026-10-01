import {
  aggregateTerritories, ringAreaCentroid, labelTextFor, labelFitsOnScreen, LABEL_MIN_AREA_PX,
} from './polityLabels';

/**
 * 剧本标签的**唯一判定**（2026-10-01）—— 回答「该写哪些字、写在哪个坐标、多大档位」，
 * 不碰任何渲染 API。因此画布（Canvas `fillText`）与 SVG 导出（`<text>`）能共用同一份结论。
 *
 * 为什么需要它：A8 的势力标注此前只在画布上实现（`ScenarioMap.drawPolityLabels`），
 * SVG 导出链**完全没有**它 —— 于是「导出图里一个字都没有」（真实数据 21 个省份名里 20 个是
 * FMG 的 `Province N`、会被导出链按"无意义名"跳过）。而势力名恰恰是历史剧本的主要读物。
 * test_73 的 f0 守卫已经在守「分级判定的单源 + 两处渲染入口都要接」，本模块是把
 * **第三条路径（导出）**也接上同一份判定的落点。
 *
 * 输入刻意做成"渲染端已经准备好的环顶点"（调用方各自决定要不要平滑、裁不裁视口）：
 * @param {object}   o
 * @param {Array}    o.provinces  [{ id, name, rings:[{kind, points}] }]（rings 已按渲染口径给出）
 * @param {'province'|'polity'|'abbr'} o.tier 档位（由 `polityLabelTier(visibleRatio)` 给出）
 * @param {number}   o.scale      当前缩放（屏幕像素/世界单位）；用于最小可见面积门槛
 * @param {Function} o.ownerRefOf (provinceId) => { owner, era } | null
 * @param {Function} o.polityOfEra (era, ownerId) => polity | null
 * @param {string?}  o.highlightOwnerId 选中势力（画布高亮用；导出不传）
 * @returns {Array<{kind:'province'|'polity', text:string, x:number, y:number, owner:(string|null), era:number, highlight:boolean}>}
 */

/** 只取**主环**算面积与形心：多环省份里洞/飞地面积很小，算进来反而把名字往边界推 */
function mainRing(prov) {
  const r = prov && Array.isArray(prov.rings) ? prov.rings[0] : null;
  if (!r || !Array.isArray(r.points) || r.points.length < 3) return null;
  return r;
}

export function collectScenarioLabels({
  provinces, tier, scale, ownerRefOf, polityOfEra, highlightOwnerId = null,
  minAreaPx = LABEL_MIN_AREA_PX,
}) {
  const out = [];
  if (!Array.isArray(provinces) || !provinces.length) return out;

  // ── 放大档：省名（海域不挂名字，与 `drawProvinces` 的 `rp.kind === 'sea'` 同口径）──
  if (tier === 'province') {
    for (const prov of provinces) {
      if (!prov) continue;
      const name = String(prov.name || '').trim();
      if (!name) continue;
      const ring = mainRing(prov);
      if (!ring || ring.kind === 'sea') continue;
      const { area, cx, cy } = ringAreaCentroid(ring.points);
      if (!labelFitsOnScreen(area, scale, minAreaPx.province)) continue;
      out.push({ kind: 'province', text: name, x: cx, y: cy, owner: null, era: -1, highlight: false });
    }
    return out;
  }

  // ── 中/小档：势力名 / 简称（领土聚合 → **面积加权**质心）──
  const items = [];
  for (const prov of provinces) {
    if (!prov) continue;
    const ref = ownerRefOf ? ownerRefOf(prov.id) : null;
    if (!ref || !ref.owner) continue;
    const ring = mainRing(prov);
    if (!ring || ring.kind === 'sea') continue;   // 海不是谁的领土
    items.push({ key: `${ref.era}|${ref.owner}`, points: ring.points });
  }
  const agg = aggregateTerritories(items, (it) => it.key);
  for (const [key, st] of agg) {
    if (!labelFitsOnScreen(st.area, scale, minAreaPx.polity)) continue;
    const sep = key.indexOf('|');
    const era = Number(key.slice(0, sep));
    const owner = key.slice(sep + 1);
    const text = labelTextFor(polityOfEra ? polityOfEra(era, owner) : null, tier);
    if (!text) continue;                          // 查不到势力 → 静默跳过（绝不画 id 上去）
    out.push({
      kind: 'polity', text, x: st.cx, y: st.cy, owner, era,
      highlight: !!highlightOwnerId && highlightOwnerId === owner,
    });
  }
  return out;
}
