// utils/roadStyles.js — 道路样式预设（P1-2）
//
// 4 种道路样式：官道 / 普通道路 / 山路 / 小径。
// 数据落点：mapData[planetId].routes[].style（字符串 key）。
// 渲染时 style 优先于 route.color / route.dashed —— 但**旧数据没有 style 字段，
// 仍按自身 color/dashed 渲染**（向后兼容，不改变既有地图观感）。
export const ROAD_STYLES = {
  highway: {
    key: 'highway',
    label: '官道',
    color: '#D4A017',
    width: 3,
    dashed: false,
    note: '金色 3px 实线，重要干线（可加名称标注）',
  },
  road: {
    key: 'road',
    label: '普通道路',
    color: '#8B5E3C',
    width: 2,
    dashed: false,
    note: '棕色 2px 实线',
  },
  path: {
    key: 'path',
    label: '山路',
    color: '#9AA5B1',
    width: 1,
    dashed: false,
    note: '灰色细实线，沿等高线绕行',
  },
  trail: {
    key: 'trail',
    label: '小径',
    color: '#9AA5B1',
    width: 1,
    dashed: true,
    note: '灰色虚线',
  },
};

export const ROAD_STYLE_KEYS = ['highway', 'road', 'path', 'trail'];

export const DEFAULT_ROAD_STYLE = 'road';

/** 取样式定义；无 style 字段时返回 null（表示沿用路线自身的 color/dashed） */
export function resolveRoadStyle(route) {
  const key = route?.style;
  if (!key) return null;
  return ROAD_STYLES[key] || null;
}

/**
 * 汇总一条路线的最终绘制参数。
 * style 存在 → 用样式；否则回落到路线自身字段（旧数据）。
 */
export function roadDrawParams(route) {
  const st = resolveRoadStyle(route);
  if (st) {
    return { color: st.color, width: st.width, dashed: st.dashed, styled: true, label: st.label };
  }
  return {
    color: route?.color || '#E67E22',
    width: 2,
    dashed: !!route?.dashed,
    styled: false,
    label: '未分类',
  };
}
