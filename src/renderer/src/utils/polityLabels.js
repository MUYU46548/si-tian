// utils/polityLabels.js — 历史剧本「势力标注」纯函数层（A8，2026-09-26）
//
// 为什么需要独立一层：**势力名与省名是同一批数据的两种呈现，取舍只由缩放决定**。
// 画布渲染 / 导出 / 命中提示若各写一套 if，就是又一个「改一处另两处不变」的双源
// （与 `terrainRepresentation.js` 同类问题，且同样**不会报错**）。
//
// 分级依据刻意**不用绝对缩放值**，而用「视口可见世界宽度 ÷ 地图世界宽度」：
// 绝对 scale 依赖数据量纲（FMG 导入 ≈ 1.0 量级、合成 fixture ≈ 0.2 量级），
// 换一份数据阈值就整体失准；比例则与量纲无关 —— 同一个「看得到地图的几成」在任何数据下同档。
//
// 参考实现：EU4 —— 放大看省名，缩小只留势力名（可简称），全名只在点开省份详情时给。
//
// 本模块是纯函数（不碰 store / DOM / 响应式），Node 侧可直接测。

/**
 * 档位阈值。`visibleRatio = 视口可见世界宽度 / 地图世界宽度`。
 * ≤0.35 → 放大（只看得到三分之一以内的地图）→ 省名
 * ≤1.2  → 中档（大致整图 ~ 略超整图）    → 势力名
 * >1.2  → 缩小（地图只占视口一小块）      → 势力简称
 */
export const POLITY_LABEL_THRESHOLDS = Object.freeze({
  provinceVisibleRatio: 0.35,
  polityVisibleRatio: 1.2,
});

/** 屏上面积门槛（px²）：比这更小的省份/势力不挂标签，否则碎块会把画布糊满 */
export const LABEL_MIN_AREA_PX = Object.freeze({
  province: 900,
  polity: 2500,
});

export const LABEL_TIERS = Object.freeze(['province', 'polity', 'abbr']);

/**
 * 视口比例 → 标签档位。
 * @param {number} visibleRatio 视口可见世界宽度 ÷ 地图世界宽度
 * @param {{provinceVisibleRatio:number, polityVisibleRatio:number}} [th]
 * @returns {'province'|'polity'|'abbr'}
 */
export function polityLabelTier(visibleRatio, th = POLITY_LABEL_THRESHOLDS) {
  const r = Number(visibleRatio);
  const v = Number.isFinite(r) && r > 0 ? r : 1;
  if (v <= th.provinceVisibleRatio) return 'province';
  if (v <= th.polityVisibleRatio) return 'polity';
  return 'abbr';
}

const px = (p) => (Array.isArray(p) ? Number(p[0]) : Number(p && p.x));
const py = (p) => (Array.isArray(p) ? Number(p[1]) : Number(p && p.y));

/**
 * 环（点集）的面积与形心。
 * · 面积用鞋带公式（绝对值，与绕向无关）；
 * · 形心用面积加权形心 `Σ(x_i+x_j)·cross / (3·Σcross)` —— 有向面积在分子分母同时变号，
 *   所以顺时针环也得到同一结果；
 * · 退化（< 3 点 / 面积≈0 / 含非有限值）→ `area = 0`、形心回落为点均值。
 *   **不能返回 NaN**：NaN 坐标会让 `fillText` 静默不画（不报错），
 *   表现为「有些势力的名字凭空消失」—— 最难查的那种。
 * @returns {{area:number, cx:number, cy:number}}
 */
export function ringAreaCentroid(points) {
  const pts = Array.isArray(points) ? points.filter((p) => Number.isFinite(px(p)) && Number.isFinite(py(p))) : [];
  const n = pts.length;
  if (!n) return { area: 0, cx: 0, cy: 0 };
  if (n < 3) {
    let sx = 0, sy = 0;
    for (const p of pts) { sx += px(p); sy += py(p); }
    return { area: 0, cx: sx / n, cy: sy / n };
  }
  let a2 = 0, cx = 0, cy = 0;
  for (let i = 0; i < n; i++) {
    const x0 = px(pts[i]), y0 = py(pts[i]);
    const x1 = px(pts[(i + 1) % n]), y1 = py(pts[(i + 1) % n]);
    const cross = x0 * y1 - x1 * y0;
    a2 += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  const area = Math.abs(a2) / 2;
  if (area < 1e-9 || Math.abs(a2) < 1e-9) {
    let sx = 0, sy = 0;
    for (const p of pts) { sx += px(p); sy += py(p); }
    return { area: 0, cx: sx / n, cy: sy / n };
  }
  return { area, cx: cx / (3 * a2), cy: cy / (3 * a2) };
}

/**
 * 省份集合 → 按 key 聚合的领土统计（**面积加权质心**）。
 *
 * 为什么必须面积加权：不加权时，一个势力的标签会被「数量多的小碎省」拽到边境线上，
 * 而它的实际重心在大省那边 —— 标签跑到别的势力地界里去（EU4 里也会被骂的那种）。
 *
 * @param {Array<{points:Array}>} items 每个元素 = 一个已解析的省份（须带 `points`）
 * @param {(item:any)=>string|null|undefined} keyOf 取聚合键；返回假值则跳过该省
 * @returns {Map<string, {count:number, area:number, cx:number, cy:number}>}
 */
export function aggregateTerritories(items, keyOf = (it) => it && it.owner) {
  const acc = new Map();
  for (const it of items || []) {
    if (!it) continue;
    const key = keyOf(it);
    if (!key) continue;
    const { area, cx, cy } = ringAreaCentroid(it.points);
    const cur = acc.get(key) || { count: 0, area: 0, sx: 0, sy: 0, wsum: 0 };
    cur.count += 1;
    cur.area += area;
    // 面积为 0（退化环）时用权 1，保证它至少能贡献一个位置，而不是把质心拉向 (0,0)
    const w = area > 0 ? area : 1;
    cur.sx += cx * w;
    cur.sy += cy * w;
    cur.wsum += w;
    acc.set(key, cur);
  }
  const out = new Map();
  for (const [k, a] of acc) {
    out.set(k, {
      count: a.count,
      area: a.area,
      cx: a.wsum ? a.sx / a.wsum : 0,
      cy: a.wsum ? a.sy / a.wsum : 0,
    });
  }
  return out;
}

/**
 * 档位 → 势力标签文本。
 * · `'province'` 档不画势力标签（那一档看的是省名）→ 返回 `''`
 * · `'abbr'` 档优先用用户自定义的 `abbr`；**没填就回落全名**，绝不自动截断
 *   （截断会造出「大明帝国 → 大明」这类看似合理、实则是机器臆造的名字）
 * @param {{name?:string, abbr?:string}} polity
 * @param {'province'|'polity'|'abbr'} tier
 */
export function labelTextFor(polity, tier) {
  if (!polity || tier === 'province') return '';
  const name = String(polity.name || '').trim();
  const abbr = String(polity.abbr || '').trim();
  if (tier === 'abbr') return abbr || name;
  return name;
}

/**
 * 世界面积 × 缩放 → 屏幕面积是否够大，值得挂标签。
 * @param {number} areaWorld 世界单位²
 * @param {number} scale 画布缩放
 * @param {number} minAreaPx 屏幕 px² 门槛
 */
export function labelFitsOnScreen(areaWorld, scale, minAreaPx) {
  const a = Number(areaWorld);
  const s = Number(scale);
  if (!Number.isFinite(a) || a <= 0) return false;
  if (!Number.isFinite(s) || s <= 0) return false;
  return a * s * s >= minAreaPx;
}

/** 两个本地样式：与用户预设解耦（预设被调成全透明时「势力名整片消失」是查不出来的） */
export const POLITY_LABEL_STYLE = Object.freeze({
  key: 'polity-name',
  name: '势力名',
  fontFamily: 'serif',
  fontSize: 15,
  weight: 'bold',
  color: '#F7F3E8',
  stroke: { enabled: true, color: '#1B2130', width: 3 },
  shadow: { enabled: true, color: 'rgba(0,0,0,0.55)', blur: 6 },
  background: { enabled: true, color: '#000000', opacity: 0.32, padding: 4 },
  lockScreenSize: true,
});

export const PROVINCE_LABEL_STYLE = Object.freeze({
  key: 'province-name',
  name: '省名',
  fontFamily: 'sans-serif',
  fontSize: 12,
  weight: 'normal',
  color: '#FFFFFF',
  stroke: { enabled: true, color: '#1F2933', width: 3 },
  shadow: { enabled: false, color: 'rgba(0,0,0,0.6)', blur: 6 },
  background: { enabled: false, color: '#000000', opacity: 0.4, padding: 3 },
  lockScreenSize: true,
});
