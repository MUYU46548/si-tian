// scenario/layers/provinces.js — 剧本视图「省界」层（N1 刀 1，2026-10-30）
//
// 从 `ScenarioMap.vue` 搬出来：**省份填色/描边（含 EU4 斜线、选中描边）** 与 **省界两遍法**。
// 口径原样保留（改观感的事不在这一刀里）：
//   · 地形/温度/降水这类**栅格图层**打开时，省份只描边不填色（`fills:false`）；
//   · 海域省由 `landsea` 栅格的深度色带负责，不再盖 SEA_FILL，只留虚线海界；
//   · 同色 1.6px 描边抹掉相邻两省在共享弧上的亚像素缝；不填色时省界必须自己画出来；
//   · EU4 斜线底色用**旧主**色、斜线用**新主**色（不引入新色相）；
//   · 省界**两遍**：先全部普通界（不透明统一线宽），再叠选中/多选/合并目标。
//
// `view` 字段（由 `ScenarioMap.makeLayerView()` 提供）：
//   baseMap, rasterLayer, altStraight, px, SEA_EDGE, BORDER_COLOR,
//   PROVINCE_BORDER_COLOR, PROVINCE_BORDER_PX,
//   rawTerrain(), rawProvOf(prov), provincePathFor(rp, altStraight), getProvinceColor(rp),
//   timeline, eraIndex, date, diffMode, mode, isStriped(tl, k, id, at), polityColor(sc, owner),
//   provinceBBox(rp), selectedProvince, multiSelect, mergeProvId

/** 颜色是否不透明（半透明色描边会变成可见的深色轮廓线） */
export function isOpaqueColor(col) {
  if (typeof col !== 'string') return false;
  const m = col.match(/^rgba?\(([^)]+)\)$/i);
  if (!m) return true;                       // #rrggbb / 命名色 / hsl() → 当作不透明
  const parts = m[1].split(',').map((s) => s.trim());
  return parts.length < 4 || Number(parts[3]) >= 1;
}

export function drawProvincesLayer(c, view, opts = {}) {
  if (!view.baseMap || !view.baseMap.terrain) return;
  const fills = opts.fills !== false;
  const tl = view.timeline;
  const k = view.eraIndex;
  // 归属查询必须吃**日期**（月日精度）：同一年内 6 月前后归主不同
  const at = view.date;
  const scenarioMode = view.mode === 'scenario' && tl.scenarios.length > 0;

  view.rawTerrain().forEach(prov => {
    const rp = view.rawProvOf(prov);
    // 路径按省缓存（Path2D）：几何不变时每帧只做 fill/stroke，不再重描 2.4 万个顶点
    const path = view.provincePathFor(rp, view.altStraight);
    if (!path) return;
    const fillCol = view.getProvinceColor(rp);
    // 政治档的海面由 `landsea` 栅格画**深度色带**；海域省再盖 SEA_FILL 会把青绿浅滩压成深蓝
    const seaFromRaster = rp.kind === 'sea' && view.rasterLayer === 'landsea';
    if (fills && !seaFromRaster) {
      c.fillStyle = fillCol;
      // 多环实体：一条路径覆盖所有环；evenodd 与命中口径一致 → 洞真空、飞地真画
      c.fill(path, 'evenodd');
    }
    // 同色描边（~1px）：抹掉相邻省份之间的**亚像素缝**（共享弧两端 Chaikin 邻域不同）
    if (rp.kind === 'sea') {
      // 海界 = 淡虚线（实线是陆地省界，虚线一眼区分水陆）
      c.setLineDash([view.px(6), view.px(4)]);
      c.strokeStyle = view.SEA_EDGE;
      c.lineWidth = view.px(1.2);
      c.stroke(path);
      c.setLineDash([]);
    } else if (fills && isOpaqueColor(fillCol)) {
      c.strokeStyle = fillCol;
      // 1.6px：相邻两省各 0.8px 正好把 1~3px 的白点/针孔盖住
      c.lineWidth = view.px(1.6);
      c.stroke(path);
    } else if (!fills) {
      // 不填色时，省界**必须**自己画出来（否则"没有省份"和"有省份"看起来一样）
      c.strokeStyle = view.BORDER_COLOR;
      c.lineWidth = view.px(0.9);
      c.stroke(path);
    }

    // EU4 式斜线占领：底色是**旧主**色（上面刚填的），斜线用**新主**色
    if (scenarioMode && view.diffMode === 'eu4' && view.isStriped(tl, k, rp.id, at)) {
      const newCol = view.polityColor(tl.scenarios[k], tl.scenarios[k].ownership?.[rp.id]);
      const b = view.provinceBBox(rp);
      const dy = b.maxY - b.minY;
      const step = view.px(8.5);
      c.save();
      c.clip(path);                   // 复用缓存路径做裁剪
      c.globalAlpha = 0.92;
      c.strokeStyle = newCol;
      c.lineWidth = view.px(3.2);
      for (let t = b.minX - dy - 20; t < b.maxX + 20; t += step) {
        c.beginPath();
        c.moveTo(t, b.minY - 20);
        c.lineTo(t + dy + 40, b.maxY + 20);
        c.stroke();
      }
      c.restore();
      c.save();
      c.lineWidth = view.px(1.4);
      c.strokeStyle = newCol;
      c.stroke(path);
      c.restore();
    } else if (scenarioMode && view.diffMode === 'outline'
               && k > 0 && (tl.eraChg[k]?.changed || []).includes(rp.id)) {
      c.save();
      c.lineWidth = view.px(2);
      c.strokeStyle = '#ffffff';
      c.stroke(path);
      c.restore();
    }
  });
}

/**
 * 省份边界（**两遍**：先全部、再高亮）。
 * 逐省一遍 + 半透明会让**共边被描两次**（颜色更深，观感发灰）；0.6px 在 1080 宽画布上几乎看不见。
 */
export function drawProvinceBordersLayer(c, view) {
  if (!view.baseMap || !view.baseMap.terrain) return;
  const multi = view.multiSelect;
  const terrain = view.rawTerrain();
  // ── 第一遍：普通边界（不透明、统一线宽 —— 共边叠加也还是同一个色）────────
  c.save();
  c.strokeStyle = view.PROVINCE_BORDER_COLOR;
  c.lineWidth = view.px(view.PROVINCE_BORDER_PX);
  for (const prov of terrain) {
    const rp = view.rawProvOf(prov);
    // 边界与填充共用同一份 Path2D 缓存：每帧不再重描 2.4 万顶点
    const path = view.provincePathFor(rp, view.altStraight);
    if (!path) continue;
    c.stroke(path);
  }
  c.restore();
  // ── 第二遍：选中 / 多选 / 合并目标（只画这几个，顺序=层叠顺序）──────────────
  for (const prov of terrain) {
    const isSelected = view.selectedProvince && view.selectedProvince.id === prov.id;
    const isMulti = multi.has(prov.id);
    const isMergeTarget = view.mergeProvId === prov.id;
    if (!isSelected && !isMulti && !isMergeTarget) continue;
    const rp = view.rawProvOf(prov);
    const path = view.provincePathFor(rp, view.altStraight);
    if (!path) continue;
    // 多选描边用**青色 + 更粗**：单选白色 1.5px，两者叠在一起也看得出"这些是批量对象"
    c.strokeStyle = isMergeTarget ? '#ffd700' : (isMulti ? '#22d3ee' : '#ffffff');
    c.lineWidth = isMulti ? view.px(2.5) : view.px(1.5);
    c.stroke(path);
  }
}
