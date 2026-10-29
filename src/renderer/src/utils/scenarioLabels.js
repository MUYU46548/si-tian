import {
  aggregateTerritories, ringAreaCentroid, labelTextFor, labelFitsOnScreen, LABEL_MIN_AREA_PX,
  isPlaceholderProvinceName,
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
  // C3（2026-10-29）：只显示**已命名**的省。判据（`isPlaceholderProvinceName`）本来就只有一份，
  // 之前只有导出链在用；画布这边加个开关，用户才能在 415 个「新省份 N」里看清自己起过名的那些。
  skipPlaceholderProvinces = false,
}) {
  const out = [];
  if (!Array.isArray(provinces) || !provinces.length) return out;

  // ── 势力名 / 简称：**每一档都画** ──────────────────────────────────────────
  // 🔴 2026-10-27（用户实测「放大后看不到省名、也看不到势力名」）：
  //    旧实现在最详档**只**返回省名（势力名被 `labelTextFor(..., 'province')` 返回 ''）
  //    → 放大到能看省名的那一刻，整张图的国家名集体消失。
  //    Paradox/EU4 的读法是「国家名永远在，省名放大才加」——所以这里不再互斥。
  const polityTier = tier === 'province' ? 'polity' : tier;
  if (polityTier !== 'province') {
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
      const text = labelTextFor(polityOfEra ? polityOfEra(era, owner) : null, polityTier);
      if (!text) continue;                          // 查不到势力 → 静默跳过（绝不画 id 上去）
      out.push({
        kind: 'polity', text, x: st.cx, y: st.cy, owner, era,
        // 领土**世界面积**（2026-10-27）：画布按它给字号（EU4 的大国名/小国名层次）
        area: st.area,
        highlight: !!highlightOwnerId && highlightOwnerId === owner,
      });
    }
  }

  // ── 最详档：再叠一层省名（海域不挂名字，与 `drawProvinces` 的 `rp.kind === 'sea'` 同口径）──
  if (tier === 'province') {
    for (const prov of provinces) {
      if (!prov) continue;
      const name = String(prov.name || '').trim();
      if (!name) continue;
      if (skipPlaceholderProvinces && isPlaceholderProvinceName(name)) continue;
      const ring = mainRing(prov);
      if (!ring || ring.kind === 'sea') continue;
      const { area, cx, cy } = ringAreaCentroid(ring.points);
      if (!labelFitsOnScreen(area, scale, minAreaPx.province)) continue;
      out.push({ kind: 'province', text: name, x: cx, y: cy, owner: null, era: -1, highlight: false });
    }
  }
  return out;
}
