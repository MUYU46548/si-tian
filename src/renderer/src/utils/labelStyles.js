// utils/labelStyles.js — 标签样式预设系统（P0-2 Aesthetic Labels）
//
// 目标：把散落在各画布里的「写死字号 + 写死颜色」的文本渲染，收敛成一套可配置的预设：
//   · 6 种内置预设（city / town / village / region / building / custom），视觉上明显区分
//   · 每种预设：字体族 / 字号 / 粗细 / 颜色 / 描边 / 阴影（外发光）/ 背景条 / 是否锁定屏幕像素
//   · 用户改过的预设落盘到 .sitian/config/label-presets.json（经 IPC，不直接碰文件系统）
//   · 支持导出 / 导入 JSON，支持保存当前样式为新预设
//
// 约定（与 AGENTS.md 一致）：
//   · 本模块是纯工具 + 一个响应式预设表，不持有画布状态
//   · 改动预设后广播 sitian:label-styles-changed，各画布监听到后 requestRender（不依赖深度 watch）
import { ref } from 'vue';

// 单一写闸门（writeGate #5）：无项目只读态下 saveToVault 不得写库内 .sitian/config
import { guardWrite } from '../store/writeGate';

/** 描边默认值（关闭态；开启后由预设补 color/width） */
const NO_STROKE = { enabled: false, color: '#101820', width: 2 };
const NO_SHADOW = { enabled: false, color: 'rgba(0,0,0,0.6)', blur: 6 };
const NO_BG = { enabled: false, color: '#000000', opacity: 0.4, padding: 3 };

/** 6 种内置预设 —— 视觉上刻意拉开差距（提示词「6 种预设可切换，视觉效果明显区分」） */
export const BUILTIN_PRESETS = {
  city: {
    key: 'city',
    name: '城市',
    fontFamily: 'serif',
    fontSize: 15,
    weight: 'bold',
    color: '#F2C94C',
    stroke: { enabled: true, color: '#3A2A00', width: 3 },
    shadow: { enabled: true, color: 'rgba(242,201,76,0.75)', blur: 8 },
    background: { ...NO_BG },
    lockScreenSize: false,
    builtin: true,
  },
  town: {
    key: 'town',
    name: '城镇',
    fontFamily: 'sans-serif',
    fontSize: 13,
    weight: 'bold',
    color: '#FFFFFF',
    stroke: { enabled: true, color: '#1F2933', width: 3 },
    shadow: { ...NO_SHADOW },
    background: { ...NO_BG },
    lockScreenSize: false,
    builtin: true,
  },
  village: {
    key: 'village',
    name: '村庄',
    fontFamily: 'sans-serif',
    fontSize: 11,
    weight: 'normal',
    color: '#B9C4D0',
    stroke: { ...NO_STROKE },
    shadow: { ...NO_SHADOW },
    background: { ...NO_BG },
    lockScreenSize: false,
    builtin: true,
  },
  region: {
    key: 'region',
    name: '区域',
    fontFamily: 'serif',
    fontSize: 16,
    weight: 'normal',
    color: '#F5F0E6',
    stroke: { ...NO_STROKE },
    shadow: { ...NO_SHADOW },
    // 半透明大字 + 背景条（提示词明确要求）
    background: { enabled: true, color: '#000000', opacity: 0.34, padding: 5 },
    lockScreenSize: false,
    builtin: true,
  },
  building: {
    key: 'building',
    name: '建筑/设施',
    fontFamily: 'sans-serif',
    fontSize: 10,
    weight: 'normal',
    color: '#D7DEE8',
    stroke: { ...NO_STROKE },
    shadow: { ...NO_SHADOW },
    background: { ...NO_BG },
    lockScreenSize: false,
    builtin: true,
  },
  custom: {
    key: 'custom',
    name: '自定义',
    fontFamily: 'sans-serif',
    fontSize: 16,
    weight: 'normal',
    color: '#2D3436',
    stroke: { ...NO_STROKE },
    shadow: { ...NO_SHADOW },
    // 浮动文本（textLabels）历史观感：白底深字，保持向后兼容
    background: { enabled: true, color: '#FFFFFF', opacity: 0.75, padding: 6 },
    lockScreenSize: false,
    builtin: true,
  },
};

export const PRESET_KEYS = ['city', 'town', 'village', 'region', 'building', 'custom'];

/** 节点层级 → 预设键（提示词 6 类映射） */
export const LAYER_TO_PRESET = {
  city: 'city',
  town: 'town',
  village: 'village',
  region: 'region',
  building: 'building',
  facility: 'building',
  location: 'building',
  planet: 'region',
  moon: 'village',
  star: 'region',
  unknown: 'custom',
};

export const FONT_FAMILIES = [
  { value: 'serif', label: '衬线 serif' },
  { value: 'sans-serif', label: '无衬线 sans-serif' },
  { value: 'monospace', label: '等宽 mono' },
];

const STORAGE_KEY = 'sitian-label-presets';
const CONFIG_NAME = 'labelPresets';

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function builtinsDeep() {
  const out = {};
  for (const k of Object.keys(BUILTIN_PRESETS)) out[k] = clone(BUILTIN_PRESETS[k]);
  return out;
}

/** 把任意输入规整成合法预设（缺字段回落到 builtin 或 custom） */
export function normalizePreset(raw, key) {
  const base = clone(BUILTIN_PRESETS[key] || BUILTIN_PRESETS.custom);
  if (!raw || typeof raw !== 'object') return base;
  const out = { ...base };
  if (typeof raw.name === 'string' && raw.name.trim()) out.name = raw.name.trim();
  if (FONT_FAMILIES.some(f => f.value === raw.fontFamily)) out.fontFamily = raw.fontFamily;
  if (Number.isFinite(raw.fontSize)) out.fontSize = Math.min(32, Math.max(8, Math.round(raw.fontSize)));
  if (raw.weight === 'bold' || raw.weight === 'normal') out.weight = raw.weight;
  if (typeof raw.color === 'string') out.color = raw.color;
  out.stroke = normalizePart(raw.stroke, base.stroke);
  out.shadow = normalizePart(raw.shadow, base.shadow);
  out.background = normalizePart(raw.background, base.background, 'opacity');
  out.lockScreenSize = !!raw.lockScreenSize;
  out.key = key;
  out.builtin = !!BUILTIN_PRESETS[key];
  return out;
}

function normalizePart(rawPart, basePart, extraNumKey) {
  const out = { ...basePart };
  if (!rawPart || typeof rawPart !== 'object') return out;
  out.enabled = !!rawPart.enabled;
  if (typeof rawPart.color === 'string') out.color = rawPart.color;
  if (Number.isFinite(rawPart.width)) out.width = Math.min(8, Math.max(1, rawPart.width));
  if (Number.isFinite(rawPart.blur)) out.blur = Math.min(24, Math.max(0, rawPart.blur));
  if (Number.isFinite(rawPart.padding)) out.padding = Math.min(16, Math.max(0, rawPart.padding));
  if (extraNumKey && Number.isFinite(rawPart[extraNumKey])) {
    out[extraNumKey] = Math.min(1, Math.max(0, rawPart[extraNumKey]));
  }
  return out;
}

// ===== 响应式预设表（画布每帧读取；设置面板编辑后即时生效） =====
export const labelPresets = ref(builtinsDeep());

/** 取预设（不存在则回落 custom） */
export function getPreset(key) {
  const k = PRESET_KEYS.includes(key) || labelPresets.value[key] ? key : 'custom';
  return labelPresets.value[k] || labelPresets.value.custom || BUILTIN_PRESETS.custom;
}

/** 节点层级 → 预设对象 */
export function getPresetForLayer(layer) {
  return getPreset(LAYER_TO_PRESET[layer] || 'custom');
}

/** 广播样式变更（画布监听后 requestRender） */
export function notifyLabelStylesChanged() {
  window.dispatchEvent(new CustomEvent('sitian:label-styles-changed'));
}

/**
 * 局部更新一个预设（patch 为浅合并；stroke/shadow/background 逐项合并）
 * @param {string} key
 * @param {object} patch
 * @param {{persist?: boolean}} [opts] persist=false 时只更新内存 + 广播（滑块拖动中避免 IPC 风暴），
 *                                     松手（@change）再以 persist=true 落盘
 */
export function updatePreset(key, patch, opts = {}) {
  const { persist = true } = opts;
  const cur = clone(getPreset(key));
  const next = { ...cur, ...patch };
  for (const part of ['stroke', 'shadow', 'background']) {
    if (patch[part]) next[part] = { ...cur[part], ...patch[part] };
  }
  labelPresets.value = { ...labelPresets.value, [key]: normalizePreset(next, key) };
  if (persist) {
    mirrorToLocalStorage();
    saveToVault();
  }
  notifyLabelStylesChanged();
  return labelPresets.value[key];
}

/** 以当前样式另存为新预设（提示词「支持保存当前样式为预设」） */
export function saveAsPreset(name, style) {
  const key = `user-${Date.now().toString(36)}`;
  const preset = normalizePreset({ ...style, name }, key);
  preset.key = key;
  preset.name = String(name || '未命名预设').trim();
  preset.builtin = false;
  labelPresets.value = { ...labelPresets.value, [key]: preset };
  mirrorToLocalStorage();
  saveToVault();
  notifyLabelStylesChanged();
  return preset;
}

export function removePreset(key) {
  if (BUILTIN_PRESETS[key]) {
    // 内置预设不允许删除，只重置
    labelPresets.value = { ...labelPresets.value, [key]: clone(BUILTIN_PRESETS[key]) };
  } else {
    const next = { ...labelPresets.value };
    delete next[key];
    labelPresets.value = next;
  }
  mirrorToLocalStorage();
  saveToVault();
  notifyLabelStylesChanged();
}

export function resetAllPresets() {
  labelPresets.value = builtinsDeep();
  mirrorToLocalStorage();
  saveToVault();
  notifyLabelStylesChanged();
}

// ===== 持久化 =====
function mirrorToLocalStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(labelPresets.value));
  } catch (e) { /* ignore */ }
}

function readLocalStorageMirror() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/** 从镜像合并预设施加（保留内置键的键集，允许用户新增键） */
function applyLoaded(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const next = builtinsDeep();
  for (const [k, v] of Object.entries(raw)) {
    next[k] = normalizePreset(v, k);
  }
  labelPresets.value = next;
  return true;
}

/** 启动时同步装载：localStorage 镜像 → 异步拉 .sitian/config/label-presets.json 覆盖 */
export function initLabelPresets() {
  const mirror = readLocalStorageMirror();
  if (mirror) applyLoaded(mirror);
  loadFromVault();
}

export async function loadFromVault() {
  try {
    const res = await window.sitianAPI?.getSitianConfig?.(CONFIG_NAME);
    if (res?.success && res.data) {
      applyLoaded(res.data);
      mirrorToLocalStorage();
      notifyLabelStylesChanged();
    }
  } catch (e) { /* 无 IPC / 无文件 → 用内置默认 */ }
}

export async function saveToVault() {
  // 落盘守卫（writeGate #5）：无项目只读态下不得把预设写进 <vault>/.sitian/config
  if (!guardWrite('保存标签样式预设').ok) return;
  try {
    await window.sitianAPI?.setSitianConfig?.(CONFIG_NAME, labelPresets.value);
  } catch (e) { /* 忽略：localStorage 镜像已保底 */ }
}

// ===== 导入 / 导出（JSON） =====
export function exportPresets() {
  return {
    app: 'SiTian',
    type: 'label-presets',
    schema: 1,
    exportedAt: new Date().toISOString(),
    presets: clone(labelPresets.value),
  };
}

/** 只接受白名单字段的预设，避免导入脏数据破坏渲染 */
export function importPresets(raw) {
  const incoming = raw && typeof raw === 'object' && raw.presets && typeof raw.presets === 'object'
    ? raw.presets
    : raw;
  if (!incoming || typeof incoming !== 'object') throw new Error('不是有效的预设文件');
  const keys = Object.keys(incoming).filter(k => incoming[k] && typeof incoming[k] === 'object');
  if (!keys.length) throw new Error('未找到可识别的预设');
  const next = { ...labelPresets.value };
  for (const k of keys) next[k] = normalizePreset(incoming[k], k);
  labelPresets.value = next;
  mirrorToLocalStorage();
  saveToVault();
  notifyLabelStylesChanged();
  return keys;
}

// ===== 渲染 =====
/**
 * 组装 CSS font 字符串
 * @param {object} style 预设
 * @param {number} screenScale 画布当前缩放（lockScreenSize 时用于抵消）
 */
export function fontString(style, screenScale = 1) {
  const size = effectiveFontSize(style, screenScale);
  const family = style.fontFamily === 'serif'
    ? 'Georgia, "Songti SC", "SimSun", serif'
    : style.fontFamily === 'monospace'
      ? 'Consolas, "SFMono-Regular", monospace'
      : '"Microsoft YaHei", "PingFang SC", sans-serif';
  return `${style.weight || 'normal'} ${size}px ${family}`;
}

/** lockScreenSize=true 时把屏幕字号换算回世界坐标字号（画布已被 ctx.scale 缩放） */
export function effectiveFontSize(style, screenScale = 1) {
  const size = Number(style?.fontSize) || 12;
  if (!style?.lockScreenSize) return size;
  const s = Number(screenScale) || 1;
  return size / s;
}

/**
 * 统一标签渲染入口（所有画布共用）
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {object} style 预设对象
 * @param {object} [opts]
 * @param {string} [opts.align]     默认 center
 * @param {string} [opts.baseline]  默认 middle
 * @param {number} [opts.screenScale] 当前缩放（lockScreenSize 用）
 * @param {boolean} [opts.highlight] 选中态：加金色强调描边
 * @param {number} [opts.alpha]
 * @returns {number} 文本宽度（世界单位）
 */
export function drawStyledLabel(ctx, text, x, y, style, opts = {}) {
  if (!style || text === undefined || text === null || text === '') return 0;
  const {
    align = 'center',
    baseline = 'middle',
    screenScale = 1,
    highlight = false,
    alpha = 1,
  } = opts;

  const fontSize = effectiveFontSize(style, screenScale);
  const pad = (style.background?.padding ?? 3);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = fontString(style, screenScale);
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  const width = ctx.measureText(String(text)).width;

  // 背景条（半透明底衬）
  if (style.background?.enabled) {
    const padY = pad;
    const padX = pad * 1.4;
    let bx = x - width / 2 - padX;
    if (align === 'left') bx = x - padX;
    else if (align === 'right') bx = x - width - padX;
    let by = y - fontSize / 2 - padY / 2;
    if (baseline === 'top') by = y - padY / 2;
    else if (baseline === 'bottom') by = y - fontSize - padY / 2;
    ctx.save();
    ctx.globalAlpha = alpha * (style.background.opacity ?? 0.35);
    ctx.fillStyle = style.background.color || '#000000';
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(bx, by, width + padX * 2, fontSize + padY, Math.max(2, fontSize * 0.3));
    } else {
      ctx.rect(bx, by, width + padX * 2, fontSize + padY);
    }
    ctx.fill();
    ctx.restore();
  }

  // 阴影 / 外发光
  if (style.shadow?.enabled) {
    ctx.shadowColor = style.shadow.color || 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = style.shadow.blur ?? 6;
  }

  const txt = String(text);
  // 描边（先描后填，保证文字轮廓清晰）
  if (style.stroke?.enabled) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = style.stroke.width || 2;
    ctx.strokeStyle = style.stroke.color || '#101820';
    ctx.strokeText(txt, x, y);
  }
  if (highlight) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = (style.stroke?.width || 2) + 1.5;
    ctx.strokeStyle = '#FFD700';
    ctx.strokeText(txt, x, y);
  }
  ctx.shadowBlur = 0;
  ctx.fillStyle = style.color || '#E6EDF3';
  ctx.fillText(txt, x, y);
  ctx.restore();

  return width;
}

/** 生成一行「预览用」的样式摘要（设置面板展示） */
export function describePreset(style) {
  if (!style) return '';
  const bits = [
    style.fontFamily,
    `${style.fontSize}px`,
    style.weight === 'bold' ? '粗体' : '常规',
  ];
  if (style.stroke?.enabled) bits.push('描边');
  if (style.shadow?.enabled) bits.push('外发光');
  if (style.background?.enabled) bits.push('背景条');
  if (style.lockScreenSize) bits.push('锁定屏幕像素');
  return bits.join(' · ');
}
