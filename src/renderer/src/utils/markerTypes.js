// utils/markerTypes.js — 标记类型系统（P1-4 Marker Types）
//
// 目标：把「标记只有坐标+名称+颜色」升级成有类型语义的数据模型：
//   每种类型 = 图标 + 颜色 + 中文名；标记可以选择类型并继承之，也可单个覆盖。
//
// 单一事实来源：此前 type 定义硬编码在 composables/useMarkerEditor.js 的 MARKER_TYPES 里
// （界面能改，但无法增删/排序/持久化）。本模块把它收敛成可编辑、可落盘的注册表。
//
// 数据兼容（重要）：
//   旧数据里的 type 是 chest / teleport / boss / npc / flag —— 这 5 个**保留为内置类型**，
//   否则老地图的标记会集体掉进 custom 兜底、图标颜色全变。新数据集在此基础上补齐
//   interest / settlement / battle / resource / danger / custom 六种（提示词要求的默认集）。
//   type 为空/未知 → 一律解析为 custom。
//
// 持久化：.sitian/config/marker-types.json（经 IPC，不直接碰文件系统）+ localStorage 镜像。
import { ref } from 'vue';

/** 自定义类型可选的图标池（均在 Icon.vue / canvasIcon.js 中有定义） */
export const MARKER_ICON_POOL = [
  'map-pin', 'target', 'home', 'swords', 'gem', 'alert-triangle', 'flag', 'star',
  'package', 'spiral', 'skull', 'user', 'crosshair', 'anchor', 'zap', 'flame',
  'droplet', 'mountain', 'tree', 'rock', 'cactus', 'castle', 'building', 'shield',
  'compass', 'navigation', 'sparkles', 'clock', 'bookmark', 'trash',
];

export const MARKER_COLORS = [
  '#E74C3C', '#E67E22', '#F1C40F', '#2ECC71', '#1ABC9C', '#3498DB',
  '#9B59B6', '#FF6B6B', '#FFD700', '#32CD32', '#95A5A6', '#E91E63',
];

/** 内置类型：6 种默认（提示词要求）+ 5 种历史类型（数据兼容） */
export const BUILTIN_MARKER_TYPES = [
  // ---- 提示词要求的 6 种默认类型 ----
  { type: 'interest', label: '兴趣点', icon: 'target', color: '#E74C3C', note: '红色准星' },
  { type: 'settlement', label: '前哨/定居', icon: 'home', color: '#2ECC71', note: '绿色圆点' },
  { type: 'battle', label: '战斗地点', icon: 'swords', color: '#FF6B6B', note: '交叉剑' },
  { type: 'resource', label: '资源标记', icon: 'gem', color: '#3498DB', note: '蓝色水晶' },
  { type: 'danger', label: '危险区域', icon: 'alert-triangle', color: '#F1C40F', note: '黄色警示' },
  { type: 'custom', label: '自定义', icon: 'map-pin', color: '#95A5A6', note: '兜底类型' },
  // ---- 历史类型（老数据仍在用，保留以免图标/颜色集体变味）----
  { type: 'chest', label: '宝箱（旧）', icon: 'package', color: '#FFD700', legacy: true },
  { type: 'teleport', label: '传送点（旧）', icon: 'spiral', color: '#9B59B6', legacy: true },
  { type: 'boss', label: 'Boss（旧）', icon: 'skull', color: '#E74C3C', legacy: true },
  { type: 'npc', label: 'NPC（旧）', icon: 'user', color: '#2ECC71', legacy: true },
  { type: 'flag', label: '旗帜（旧）', icon: 'flag', color: '#E67E22', legacy: true },
];

export const FALLBACK_MARKER_TYPE = 'custom';

const STORAGE_KEY = 'sitian-marker-types';
const CONFIG_NAME = 'markerTypes';

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function builtinsDeep() {
  // 注意：必须显式打上 builtin:true —— 「内置类型不可删除」的判断依赖它
  return BUILTIN_MARKER_TYPES.map(t => ({ ...clone(t), builtin: true }));
}

/** 规整一个类型定义（非法字段回落到 custom 的对应值） */
export function normalizeMarkerType(raw) {
  const base = BUILTIN_MARKER_TYPES.find(t => t.type === 'custom');
  if (!raw || typeof raw !== 'object') return clone(base);
  const type = typeof raw.type === 'string' && raw.type.trim() ? raw.type.trim() : base.type;
  const builtin = BUILTIN_MARKER_TYPES.find(t => t.type === type);
  return {
    type,
    label: (typeof raw.label === 'string' && raw.label.trim()) ? raw.label.trim() : (builtin?.label || type),
    icon: MARKER_ICON_POOL.includes(raw.icon) ? raw.icon : (builtin?.icon || base.icon),
    color: /^#[0-9a-f]{6}$/i.test(raw.color || '') ? raw.color : (builtin?.color || base.color),
    note: typeof raw.note === 'string' ? raw.note : (builtin?.note || ''),
    builtin: !!builtin,
    legacy: !!(builtin && builtin.legacy),
  };
}

/** 响应式类型表（画布/面板每帧读取） */
export const markerTypes = ref(builtinsDeep());

/** 广播类型变更（画布监听后 requestRender） */
export function notifyMarkerTypesChanged() {
  window.dispatchEvent(new CustomEvent('sitian:marker-types-changed'));
}

function mirror() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(markerTypes.value)); } catch (e) { /* ignore */ }
}

async function persist() {
  try { await window.sitianAPI?.setSitianConfig?.(CONFIG_NAME, markerTypes.value); } catch (e) { /* ignore */ }
}

function applyLoaded(raw) {
  if (!Array.isArray(raw)) return false;
  const out = builtinsDeep();
  for (const item of raw) {
    const t = normalizeMarkerType(item);
    const i = out.findIndex(x => x.type === t.type);
    if (i >= 0) {
      // 内置类型的 type 不可被外部改名，但 label/icon/color 允许自定义
      out[i] = { ...out[i], label: t.label, icon: t.icon, color: t.color, note: t.note };
    } else {
      out.push(t);
    }
  }
  markerTypes.value = out;
  return true;
}

/** 启动时装载：localStorage 镜像（同步）→ .sitian/config（异步覆盖） */
export function initMarkerTypes() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) applyLoaded(JSON.parse(raw));
  } catch (e) { /* ignore */ }
  loadMarkerTypesFromVault();
}

export async function loadMarkerTypesFromVault() {
  try {
    const res = await window.sitianAPI?.getSitianConfig?.(CONFIG_NAME);
    if (res?.success && Array.isArray(res.data) && res.data.length) {
      applyLoaded(res.data);
      mirror();
      notifyMarkerTypesChanged();
    }
  } catch (e) { /* 无 IPC/无文件 → 用内置默认 */ }
}

// ===== 查询 =====

/** 按 type 取类型定义（未知/为空 → custom） */
export function resolveMarkerType(type) {
  const key = typeof type === 'string' && type ? type : FALLBACK_MARKER_TYPE;
  return markerTypes.value.find(t => t.type === key)
    || markerTypes.value.find(t => t.type === FALLBACK_MARKER_TYPE)
    || { ...clone(BUILTIN_MARKER_TYPES.find(t => t.type === FALLBACK_MARKER_TYPE)), builtin: true };
}

/**
 * 计算某个标记最终生效的图标与颜色：
 * 标记自身写了 icon/color 则优先（单点覆盖），否则继承类型默认值。
 */
export function effectiveMarkerStyle(marker) {
  const t = resolveMarkerType(marker?.type);
  return {
    type: t.type,
    label: t.label,
    icon: marker?.icon || t.icon,
    color: marker?.color || t.color,
    inherited: { icon: !marker?.icon, color: !marker?.color },
  };
}

// ===== 增删改 / 排序 =====

export function addMarkerType({ label, icon, color }) {
  const base = 'custom';
  let type = `m-${Date.now().toString(36)}`;
  if (markerTypes.value.some(t => t.type === type)) type = `${type}-${Math.floor(Math.random() * 1000)}`;
  const item = normalizeMarkerType({
    type,
    label: label || '新类型',
    icon: icon || 'map-pin',
    color: color || '#95A5A6',
  });
  markerTypes.value = markerTypes.value.concat([item]);
  mirror(); persist(); notifyMarkerTypesChanged();
  return item;
}

export function updateMarkerType(type, patch) {
  markerTypes.value = markerTypes.value.map(t =>
    t.type === type ? normalizeMarkerType({ ...t, ...patch, type: t.type }) : t);
  mirror(); persist(); notifyMarkerTypesChanged();
  return resolveMarkerType(type);
}

export function removeMarkerType(type) {
  const t = resolveMarkerType(type);
  if (t.builtin) return { removed: false, reason: '内置类型不可删除（可改名/改色）' };
  markerTypes.value = markerTypes.value.filter(x => x.type !== type);
  mirror(); persist(); notifyMarkerTypesChanged();
  return { removed: true };
}

/** 是否存在引用该类型的标记（删除前提示用） */
export function countMarkersOfType(mapData, type) {
  let n = 0;
  for (const key of Object.keys(mapData || {})) {
    for (const m of (mapData[key]?.markers || [])) {
      if (resolveMarkerType(m.type).type === type) n++;
    }
  }
  return n;
}

export function moveMarkerType(type, delta) {
  const list = markerTypes.value.slice();
  const i = list.findIndex(t => t.type === type);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return false;
  const [item] = list.splice(i, 1);
  list.splice(j, 0, item);
  markerTypes.value = list;
  mirror(); persist(); notifyMarkerTypesChanged();
  return true;
}

export function resetMarkerTypes() {
  markerTypes.value = builtinsDeep();
  mirror(); persist(); notifyMarkerTypesChanged();
}

// ===== 导入 / 导出 =====

export function exportMarkerTypes() {
  return {
    app: 'SiTian',
    type: 'marker-types',
    schema: 1,
    exportedAt: new Date().toISOString(),
    markerTypes: clone(markerTypes.value),
  };
}

export function importMarkerTypes(raw) {
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.markerTypes) ? raw.markerTypes : null);
  if (!list) throw new Error('不是有效的标记类型文件');
  applyLoaded(list);
  mirror(); persist(); notifyMarkerTypesChanged();
  return markerTypes.value.length;
}
