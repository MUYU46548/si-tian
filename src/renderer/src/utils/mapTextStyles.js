// utils/mapTextStyles.js — 剧本地图「非省名/势力名」文字层的样式单源（2026-10-25）
//
// 背景：文本标注专项第一刀。省名/势力名已经走 `polityLabels` 的 `PROVINCE/POLITY_LABEL_STYLE`，
// 但**用户地名**与**标记名**仍是两套：
//   · 画布：地名默认浅色、描边可选；标记名用标记颜色、无描边；
//   · 导出：地名默认 `#3c4150` 深灰、无描边；标记名写死 `#e2e8f0`。
// 结果就是「画布上是浅字、导出图上是深字」「标记在画布上有颜色、导出变白」——不报错，只对不上。
//
// 本模块只做三件事：
//   ① 两层的默认值（颜色/字号/描边）集中一处；
//   ② 把用户数据（label / marker）解析成 `drawStyledLabel` 能吃的 style；
//   ③ 把同一份 style 转成 SVG `<text>` 属性 —— 画布与导出共用同一份常量。
// 不做：拖拽编辑、重叠避让（下一刀）。

/** 用户地名（scenario.labels）：浅色字 + 深色描边，落在任何势力色上都读得出 */
export const SCENARIO_LABEL_DEFAULTS = Object.freeze({
  color: '#e2e8f0',
  size: 12,
  haloColor: '#1B2130',
  haloWidth: 2.5,
  fontFamily: 'sans-serif',
});

/** 标记名（scenario.markers）：比地名小一号，优先用标记自身颜色 */
export const MARKER_LABEL_DEFAULTS = Object.freeze({
  color: '#e2e8f0',
  size: 11,
  haloColor: '#1B2130',
  haloWidth: 2.5,
  fontFamily: 'sans-serif',
});

/** 城镇名（baseMap.burgs）：比地名小，首都要更醒目 */
export const BURG_LABEL_DEFAULTS = Object.freeze({
  color: '#f8fafc',
  size: 10,
  haloColor: '#0b1220',
  haloWidth: 2.5,
  fontFamily: 'sans-serif',
});

/** 河流名（baseMap.rivers）：淡蓝字，避免和城镇名抢 */
export const RIVER_LABEL_DEFAULTS = Object.freeze({
  color: '#dbeafe',
  size: 10,
  haloColor: '#0b1220',
  haloWidth: 2.5,
  fontFamily: 'sans-serif',
});

/**
 * 地形注记（`baseMap.terrainLabels` 的 range/sea/plain）：serif 深棕字 + 浅色描边。
 *
 * 为什么单独一档而不是复用城镇/河名样式：地形注记是**底图层**的名字（山系/海域/平原），
 * 要印在红/绿/蓝的省份底色与深色海面上都读得出，所以用「深字 + 浅描边」
 * （与省名的「浅字 + 深描边」相反）；衬线体也更像地图册。
 * 画布（`ScenarioMap.drawTerrainLabels`）与导出（`useScenarioExport`）**共用这一份**常量。
 */
export const TERRAIN_LABEL_DEFAULTS = Object.freeze({
  color: '#3f3222',
  size: 14,
  haloColor: 'rgba(248, 244, 232, 0.92)',
  haloWidth: 2.0,
  fontFamily: 'serif',
});


function haloOf(kind, style) {
  if (style && style.stroke) {
    return { enabled: true, color: style.stroke, width: Number(style.strokeWidth) || 2 };
  }
  const d = kind === 'marker' ? MARKER_LABEL_DEFAULTS : SCENARIO_LABEL_DEFAULTS;
  return { enabled: true, color: d.haloColor, width: d.haloWidth };
}

/**
 * `scenario.labels[]` → `drawStyledLabel` style。
 * 坐标是**世界坐标**、字号也是世界单位（`lockScreenSize:false`）—— 与旧画布的 `fillText` 一致。
 */
export function scenarioLabelTextStyle(label = {}) {
  const d = SCENARIO_LABEL_DEFAULTS;
  return {
    key: 'scenario-label',
    fontFamily: d.fontFamily,
    fontSize: Number(label.size) > 0 ? Number(label.size) : d.size,
    weight: label.bold ? 'bold' : 'normal',
    color: label.color || d.color,
    stroke: haloOf('label', label),
    shadow: { enabled: false },
    background: { enabled: false },
    lockScreenSize: false,
  };
}

/** `scenario.markers[]` → `drawStyledLabel` style（标记名优先用标记色） */
export function markerLabelTextStyle(marker = {}) {
  const d = MARKER_LABEL_DEFAULTS;
  return {
    key: 'marker-label',
    fontFamily: d.fontFamily,
    fontSize: Number(marker.labelSize) > 0 ? Number(marker.labelSize) : d.size,
    weight: 'normal',
    color: marker.color || d.color,
    stroke: haloOf('marker', marker),
    shadow: { enabled: false },
    background: { enabled: false },
    // 标记名在旧画布里是**屏幕像素**（缩放时不变）—— 保持不变，避免缩小时名字消失
    lockScreenSize: true,
  };
}

/** `baseMap.burgs[]` → 城镇名样式（首都加粗、字大一号） */
export function burgLabelTextStyle(burg = {}) {
  const d = BURG_LABEL_DEFAULTS;
  const capital = !!(burg.capital || burg.group === 'capital');
  return {
    key: 'burg-label',
    fontFamily: d.fontFamily,
    fontSize: capital ? d.size + 1 : d.size,
    weight: capital ? 'bold' : 'normal',
    color: d.color,
    stroke: { enabled: true, color: d.haloColor, width: d.haloWidth },
    shadow: { enabled: false },
    background: { enabled: false },
    lockScreenSize: true,
  };
}

/** `baseMap.rivers[]` → 河流名样式 */
export function riverLabelTextStyle() {
  const d = RIVER_LABEL_DEFAULTS;
  return {
    key: 'river-label',
    fontFamily: d.fontFamily,
    fontSize: d.size,
    weight: 'normal',
    color: d.color,
    stroke: { enabled: true, color: d.haloColor, width: d.haloWidth },
    shadow: { enabled: false },
    background: { enabled: false },
    // 河流名跟着河道走，缩放时保持屏幕字号（与城镇名一致）
    lockScreenSize: true,
  };
}

/**
 * `baseMap.terrainLabels[]` → 地形注记样式（kind 只影响画布上的字距/排法，样式同一份）。
 * `lockScreenSize: true`：画布上字不随缩放变大变小（与城镇/河名一致）；
 * 导出是固定分辨率图，`svgTextAttrsFromStyle` 直接用 `fontSize` 当世界单位。
 */
export function terrainLabelTextStyle() {
  const d = TERRAIN_LABEL_DEFAULTS;
  return {
    key: 'terrain-label',
    fontFamily: d.fontFamily,
    fontSize: d.size,
    weight: 'normal',
    color: d.color,
    stroke: { enabled: true, color: d.haloColor, width: d.haloWidth },
    shadow: { enabled: false },
    background: { enabled: false },
    lockScreenSize: true,
  };
}

/** 与 `labelStyles.fontString` 同一套字体映射（导出侧不能引用 canvas 的 fontString） */
export function fontFamilyCss(style) {
  return style && style.fontFamily === 'serif'
    ? 'Georgia, "Songti SC", "SimSun", serif'
    : '"Microsoft YaHei", "PingFang SC", sans-serif';
}

/**
 * style → SVG `<text>` 属性。画布与导出**必须**用同一份字号/颜色/描边。
 * `lockScreenSize` 只影响画布（导出是固定分辨率图，不存在"屏幕像素"）。
 */
export function svgTextAttrsFromStyle(style, extra = {}) {
  const stroke = style.stroke || {};
  return {
    fill: style.color,
    'font-size': style.fontSize,
    'font-family': fontFamilyCss(style),
    'font-weight': style.weight || 'normal',
    ...(stroke.enabled
      ? {
        stroke: stroke.color,
        'stroke-width': stroke.width,
        'stroke-linejoin': 'round',
        // 先描边后填字，与 drawStyledLabel 的顺序一致
        'paint-order': 'stroke',
      }
      : {}),
    ...extra,
  };
}
