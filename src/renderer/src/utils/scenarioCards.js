/**
 * scenarioCards.js —— 剧本卡片墙（选剧本界面）的纯函数层。
 *
 * 设计约束（2026-10-17 P0）：
 * ① **纯函数**：只依赖另外两个纯函数模块（scenarioTimeline / provinceShape），无 store 无 IO → Node 可单测。
 * ② **归属查询必须走 `currentOwnerRef`**（scenarioTimeline 的唯一实现）——
 *    开局年早于第一条易主日时，真实主是**上一代**的势力（era = k-1），
 *    自己再写一套「看 ownership 就好」的口径必然错（跨代 polity id 不通用，颜色会全查成灰）。
 * ③ **势力名/色必须在 owner 所属的那个剧本里查**（聚合键带 era），同上一条根因。
 * ④ 海域（kind==='sea'）不进任何统计 —— 海不参与归属（P4 既定口径）。
 */
import { currentOwnerRef, polityOf } from './scenarioTimeline.js';
import { provinceNetArea } from './provinceShape.js';

/**
 * 一次性算好「每个省的净面积」（`provId -> area`）。
 *
 * 🔴 为什么需要它（2026-10-17 第三轮实测，量出来的不是猜的）：
 *    卡片墙有 N 条剧本、每条都要算一遍开局态势，而态势里的 `area` 是**逐省现算**的
 *    （`provinceNetArea` 要走一遍环几何）。实测 400 省 × 10 条剧本：
 *    `openingSituation` 合计 **597.7ms**（其中 `provinceNetArea` 全量 **60.6ms**）——
 *    也就是同一份面积被算了 10 遍。第二次进卡片墙（缩略图已全命中缓存）仍要 1 秒，
 *    瓶颈就在这里，不在烘焙。
 *    现在调用方算一次索引、逐条剧本复用（`openingSituation(tl, k, terrain, { areaOf })`）。
 *    ⚠️ 索引由调用方在**每次算卡片时**重建（不跨渲染缓存）—— 缓存索引会把"改了省份几何"
 *       变成"面积悄悄是旧的"，而那种失效看不出来。
 *
 * @param {Array} terrain 底图省份数组
 * @returns {Map<string, number>} 省 id → 净面积（无 id 的省不进表，按 0 处理）
 */
export function provinceAreaIndex(terrain) {
  const idx = new Map();
  for (const prov of Array.isArray(terrain) ? terrain : []) {
    if (!prov || !prov.id) continue;
    try { idx.set(prov.id, provinceNetArea(prov) || 0); } catch { idx.set(prov.id, 0); }
  }
  return idx;
}

/**
 * 开局态势：该剧本**起始年**各势力控制的省数与面积。
 *
 * @param {object} tl      buildTimeline(...) 的产物
 * @param {number} k       剧本在 tl.scenarios 里的下标
 * @param {Array}  terrain 底图省份数组（baseMap.terrain；几何只在这里有）
 * @param {object} [opts]  `{ areaOf }` —— 预先算好的面积索引（`provinceAreaIndex` 的产物）
 *   或 `Map`/函数。给了它就**不再逐省读几何**：多条剧本共用一份索引（见 `provinceAreaIndex`）。
 * @returns {{
 *   total: number, totalArea: number,
 *   byPolity: Array<{era:number, owner:string|null, name:string, color:string, provinces:number, area:number, pct:number}>,
 *   top: object|null, empty: boolean
 * }}
 * - `total` = 参与统计的陆地省数；`empty` = 一条归属都没有（卡片上不画态势条）。
 * - `pct` 按**省数**计（面积另给，UI 想用哪个用哪个：面积受"万点大省"主导，省数更平稳）。
 */
export function openingSituation(tl, k, terrain, opts = {}) {
  const sc = tl?.scenarios?.[k];
  const provs = Array.isArray(terrain) ? terrain : [];
  if (!sc) return { total: 0, totalArea: 0, byPolity: [], top: null, empty: true };

  // 开局 = 起始年 1 月 1 日（m/d 为 null 的语义与 scenarioDates 一致：缺省按 1 月 1 日）
  const y = Number(sc.era?.startYear);
  const at = Number.isFinite(y) ? { y, m: null, d: null } : null;
  const areaOf = opts.areaOf || null;

  /** key = `${era}|${owner}` —— era 必须进键：同名 polity id 跨代不通用 */
  const agg = new Map();
  let total = 0, totalArea = 0, owned = 0;

  for (const prov of provs) {
    if (!prov || prov.kind === 'sea' || !prov.id) continue;
    total += 1;
    let area = 0;
    if (areaOf) {
      area = (typeof areaOf === 'function' ? areaOf(prov) : areaOf.get(prov.id)) || 0;
    } else {
      try { area = provinceNetArea(prov) || 0; } catch { area = 0; }
    }
    totalArea += area;

    const ref = at ? currentOwnerRef(tl, k, prov.id, at) : { owner: sc.ownership?.[prov.id], era: k };
    if (!ref.owner) continue;          // 无主不进态势条（但计入 total）
    owned += 1;
    const key = `${ref.era}|${ref.owner}`;
    let row = agg.get(key);
    if (!row) {
      row = { era: ref.era, owner: ref.owner, name: '', color: '', provinces: 0, area: 0, pct: 0 };
      agg.set(key, row);
    }
    row.provinces += 1;
    row.area += area;
  }

  // 跨代查名/色：去 owner 所属的那个剧本里查（polityOf/polityColor 的口径）
  const byPolity = [...agg.values()].map((r) => {
    const p = polityOf(tl.scenarios[r.era], r.owner);
    return {
      ...r,
      name: p?.name || r.owner,
      color: p?.color || '#4a5568',
      pct: total > 0 ? r.provinces / total : 0,
    };
  }).sort((a, b) => b.provinces - a.provinces || b.area - a.area);

  return {
    total, totalArea,
    byPolity,
    top: byPolity[0] || null,
    empty: owned === 0,
  };
}

/**
 * 卡片标题行的年份文本：`1220 – 1450`（负年原样带 - 号；缺省给 ?）。
 * 不做历法前缀 —— 「历年」这种纪年名属于世界观，schema 里没有，不许编。
 */
export function cardYearsText(scenario) {
  const a = scenario?.era?.startYear, b = scenario?.era?.endYear;
  const fa = (a === '' || a == null) ? '?' : String(a);
  const fb = (b === '' || b == null) ? '?' : String(b);
  return `${fa} – ${fb}`;
}

/**
 * 钩子文案：优先 hook，回落空串（**不回落 description** —— description 是长注记，
 * 整段塞进两行卡片会把卡片撑破；用户没写 hook 就是没写，如实显示空）。
 */
export function cardHookText(scenario) {
  return typeof scenario?.hook === 'string' ? scenario.hook.trim() : '';
}
