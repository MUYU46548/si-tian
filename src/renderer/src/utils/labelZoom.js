// utils/labelZoom.js — 画布文字「缩放 → 详略档位 / 字号」的唯一判定（纯函数；2026-10-27）
//
// ── 为什么要它（用户 2026-10-27 的原话）────────────────────────────────────
// 「文本大小需要自动适应缩放，确保无论缩放到什么程度都能看得清晰（甚至展示不同层级的文本），
//   参照 Paradox 系列：放大清晰显示省份名，缩小只看见势力名称」。
//
// 我们此前三件事各走各的：
//   · 势力名/省名按「可见比例」分档（`polityLabels.polityLabelTier`，EU4 口径，正确）；
//   · 城镇名/河名却按**绝对 cameraScale** 分档（`burgLabelTier` / `riverLabelTier`）——
//     绝对 scale 依赖数据量纲（FMG 导入 ≈1.0、合成图 ≈0.2），换一份数据阈值就整体失准；
//   · 字号一律 `lockScreenSize`（恒定屏幕像素）—— 放大到 4× 时字相对地图越来越小。
//
// 本模块把三件事收成一处：**用同一个 ratio 决定档位表，并给出字号系数**。
//
// ── ratio ──────────────────────────────────────────────────────────────────
// `ratio = 视口可见世界宽 ÷ 地图世界宽`（越大 = 越缩小）。
// 与 `polityLabels` 同一口径，与数据量纲无关：同一个「看得到地图的几成」在任何数据下同档。
//
// ── 档位（与 EU4 的观感一致）───────────────────────────────────────────────
//   close (≤0.35)：只看到地图三分之一以内 → 省名 + 全部城镇 + 河名全开 + 地形注记
//   near  (≤0.6) ：再缩小一点         → 势力名 + 首都 + 大河名 + 地形注记
//   mid   (≤2.2) ：整图可见（地图占视口 ≥45%）→ 势力名 + 首都（+ 地形注记）
//   far   (>2.2) ：地图只占视口一小块 → **只剩势力名**（城镇/河流/地形注记全隐）
//
// ── 滞回（hysteresis）─────────────────────────────────────────────────────
// 档位切换若用单阈值，滚轮停在边界上会**逐帧抖档**（字一会儿有一会儿没，用户会以为卡了）。
// 这里给出 12% 的死区：进一档要真的越过阈值 12%，退一档要越过另一侧 12%。
//
// 纯函数：不碰 DOM / store；Node 直接测（`scripts/tests/unit/test_label_zoom.js`）。

/** 档位（由细到粗）——顺序即等级，别改 */
export const ZOOM_DETAILS = Object.freeze(['close', 'near', 'mid', 'far']);

/**
 * 档位阈值（ratio 上沿）：
 * `close ≤0.35 < near ≤0.6 < mid ≤2.2 < far`。
 * `close` 与 `polityLabels.POLITY_LABEL_THRESHOLDS.provinceVisibleRatio` 同一数值 ——
 * 「省名出现」与「最详档」本来就该是同一刻。
 *
 * ⚠️ mid 的上沿取 2.2（而不是 1.6）：地图占视口 62%（ratio 1.62）时仍然"整图看得见"，
 *    这时候还把首都名一起收掉就太激进了（`test_149` 的适屏刚好落在 1.62，当场红）。
 *    2.2 = 地图只占视口 45% 以下才算"远看"。
 */
export const ZOOM_DETAIL_THRESHOLDS = Object.freeze({
  close: 0.35,
  near: 0.6,
  mid: 2.2,
});

/**
 * 档位 → 各文字层的上限。
 *   · `burgs`：BURG_TIERS 数值（0=只首都 / 1=首都+人口前 40 / 2=全部）；**-1 = 不标**
 *   · `rivers`：河名档（0=出版档前 12 / 1=前 30 / 2=全部）；**-1 = 不标**
 *   · `terrainNames`：地形注记（山系/海域/平原）是否显示
 */
export const DETAIL_CAPS = Object.freeze({
  close: Object.freeze({ burgs: 2, rivers: 2, terrainNames: true }),
  near: Object.freeze({ burgs: 1, rivers: 1, terrainNames: true }),
  mid: Object.freeze({ burgs: 0, rivers: -1, terrainNames: true }),
  far: Object.freeze({ burgs: -1, rivers: -1, terrainNames: false }),
});

const DETAIL_INDEX = Object.freeze(
  ZOOM_DETAILS.reduce((acc, k, i) => { acc[k] = i; return acc; }, {}),
);

function cleanRatio(ratio) {
  const r = Number(ratio);
  return Number.isFinite(r) && r > 0 ? r : 1;
}

/** 不带滞回的裸档位（给测试与"换底图/首次计算"用） */
export function rawZoomDetail(ratio) {
  const r = cleanRatio(ratio);
  if (r <= ZOOM_DETAIL_THRESHOLDS.close) return 'close';
  if (r <= ZOOM_DETAIL_THRESHOLDS.near) return 'near';
  if (r <= ZOOM_DETAIL_THRESHOLDS.mid) return 'mid';
  return 'far';
}

/**
 * 档位（带滞回）。
 * @param {number} ratio 可见比例（越大越缩小）
 * @param {'close'|'near'|'mid'|'far'|null} [prev] 上一帧档位；null = 首次
 * @param {number} [hysteresis=0.12] 死区比例（0 = 关掉滞回）
 */
export function zoomDetail(ratio, prev = null, hysteresis = 0.12) {
  const r = cleanRatio(ratio);
  const raw = rawZoomDetail(r);
  if (!prev || !(hysteresis > 0) || prev === raw) return raw;
  const prevIdx = DETAIL_INDEX[prev];
  const rawIdx = DETAIL_INDEX[raw];
  if (prevIdx === undefined) return raw;
  // 🔴 跨越的是**两档之间的那条边界**（= 更细那一档的上沿），不是「prev 档的上沿」。
  //    写错成后者时：从 mid 放大到 0.58（near 的上沿是 0.6）会拿 mid 的上沿 1.6 去比，
  //    永远满足 → 滞回等于没做（第一版就是这么错的，z3 当场抓到）。
  const finer = rawIdx < prevIdx ? raw : prev;
  const boundary = ZOOM_DETAIL_THRESHOLDS[finer];
  if (rawIdx < prevIdx) {
    // 变得更精细（放大）→ 要真的低于边界 12%
    return r <= boundary * (1 - hysteresis) ? raw : prev;
  }
  // 变得更粗（缩小）→ 要真的超过边界 12%
  return r >= boundary * (1 + hysteresis) ? raw : prev;
}

export function detailCaps(detail) {
  return DETAIL_CAPS[detail] || DETAIL_CAPS.mid;
}

/**
 * 字号系数：放大时**小幅**变大（不是按比例放大 —— 那会把画布撑爆）。
 *
 * 基准 ratio=0.6（near 上沿）→ 1.00；ratio=0.1（放大 6 倍）→ ≈1.38；ratio=0.02 → 上限 1.75。
 * **下限 1.00**（2026-10-27）：旧值 0.95 会让"缩小后只剩势力名"的那一档再缩 5% ——
 * 而势力名正是缩小时唯一的读物（用户实测「缩小后几乎看不清字」）。
 * 缩小时**绝不缩小字号**，只减少层数。
 */
export function labelFontScale(ratio) {
  const r = cleanRatio(ratio);
  const k = Math.pow(ZOOM_DETAIL_THRESHOLDS.near / r, 0.2);
  return Math.min(1.75, Math.max(1, k));
}
