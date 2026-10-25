// utils/terrainParams.js — **地形生成参数模型**（纯函数，零 DOM / 零 Vue，Node 可测；2026-10-25）
//
// ── 为什么单独一个文件（P0-1）──────────────────────────────────────────────
//   `terrainSynthesis.js` 的推演口径里有十几个"魔法数"（山脉权重 / 高原压平力度 / 裂谷深度…）。
//   用户在面板上拖的是滑杆，算法读的是常量 —— 只要两处各写一份数字，就必然出现
//   「面板显示山脉 1.4，实际算的还是 1.0」这类**静默不一致**（本项目反复踩过的那类）。
//   所以：**参数的字段、范围、默认值、夹取规则、中文标签、预设**只有这一份。
//
// ── 三条纪律 ──────────────────────────────────────────────────────────────
//   ① **默认参数 = 旧行为逐字节不变**：默认值一律取 `TERRAIN_STRUCTURE` 里的原始常量
//      并乘以 1.0，不许在这里另立一组"看起来差不多"的数。`test_terrain_params.js` 用
//      改版前抓的 sha256 黄金值守这条（默认参数跑出来的 h 必须与 0.4.0 完全一致）。
//   ② **同 seed + 同参数 = 同结果**：`toSynthesisOptions()` 是纯映射，不含时间/随机。
//   ③ **归一化必须留痕**：越界/非数字被夹取时返回 `warnings`，UI 要能说出来，
//      不许悄悄把用户的 5.0 变成 1.6 还装作没发生。
//
// ── 与 P0-2（造陆）的关系 ─────────────────────────────────────────────────
//   `landRatio / continentCount / plateCount` 属于「生成陆地轮廓」的参数，而当前入口是
//   「按**已画好的**陆地轮廓推演地形」（用户用自由绘制/套索画大陆）。造陆落地的轮次再往
//   本文件加 `LAND_PARAM_FIELDS` 一组，**不要**把两套参数混在一起：它们的消费者不同
//   （一个喂 `generateLandmass()`，一个喂 `synthesizeHeightmapFromTerrain()`）。

import { TERRAIN_STRUCTURE } from './terrainSynthesis';

/**
 * 参数表（**唯一事实源**）。UI 直接遍历它生成控件，Node 用例直接遍历它做边界检查。
 * kind：`int` 整数滑杆 / `float` 小数滑杆 / `choice` 离散档位 / `optional-int` 可"随种子"
 */
export const TERRAIN_PARAM_FIELDS = Object.freeze([
  {
    key: 'seed', label: '随机种子', kind: 'int', min: 0, max: 999999, step: 1, def: 7,
    hint: '同种子 + 同参数 = 同一份地形；换种子只改走向/裂谷/起伏的落点',
  },
  {
    key: 'relief', label: '起伏强度', kind: 'float', min: 0.2, max: 2, step: 0.05, def: 1,
    hint: '低频/中频/高频三段起伏的总幅度（1.0 = 默认）',
  },
  {
    key: 'mountainStrength', label: '山脉强度', kind: 'float', min: 0, max: 1.6, step: 0.05, def: 1,
    hint: '主走向 + 次走向脊线的抬升权重（0 = 没有山脉，只留坡面）',
  },
  {
    key: 'plateauStrength', label: '高原面', kind: 'float', min: 0, max: 1.5, step: 0.05, def: 1,
    hint: '高原区域内把高度压向同一平面的力度（0 = 不生成高原；1.0 = 默认）',
  },
  {
    key: 'riftDepth', label: '裂谷深度', kind: 'float', min: 0, max: 0.6, step: 0.01,
    def: TERRAIN_STRUCTURE.riftDepth,
    hint: '沿裂谷轴线的下切深度（裂谷同时是天然河道）',
  },
  {
    key: 'rangeAxisDeg', label: '山脉走向', kind: 'optional-int', min: 0, max: 179, step: 1, def: null,
    hint: '留空 = 随种子推；填 0~179 强制一个方向（度）',
  },
  {
    key: 'cellsAcross', label: '网格精度', kind: 'choice', options: [64, 96, 128, 160], def: 96,
    hint: '长边格数。越大越细，越费内存/时间（96 = 旧默认）',
  },
  {
    key: 'latitudeSpanDeg', label: '纬度跨度', kind: 'float', min: 40, max: 180, step: 10, def: 120,
    hint: '地图上下两端跨越的纬度（度）。只影响气候派生（温度/降水/群系），不影响高度',
  },
]);

/** 默认参数（**必须与 0.4.0 的硬编码行为逐字节等价**） */
export const DEFAULT_TERRAIN_PARAMS = Object.freeze(
  TERRAIN_PARAM_FIELDS.reduce((acc, f) => { acc[f.key] = f.def; return acc; }, {}),
);

/** 预设（只是参数的几组起点；用户可继续拖） */
export const TERRAIN_PRESETS = Object.freeze([
  { id: 'default', name: '默认大陆', params: { ...DEFAULT_TERRAIN_PARAMS } },
  {
    id: 'rugged', name: '群山纵横',
    params: { ...DEFAULT_TERRAIN_PARAMS, relief: 1.1, mountainStrength: 1.45, riftDepth: 0.34 },
  },
  {
    id: 'plain', name: '平缓低地',
    params: { ...DEFAULT_TERRAIN_PARAMS, relief: 0.65, mountainStrength: 0.3, plateauStrength: 0.35, riftDepth: 0.12 },
  },
  {
    id: 'plateau', name: '高原广布',
    params: { ...DEFAULT_TERRAIN_PARAMS, relief: 0.85, mountainStrength: 0.8, plateauStrength: 1.4 },
  },
]);

const FIELD_BY_KEY = new Map(TERRAIN_PARAM_FIELDS.map((f) => [f.key, f]));

/** 稳定 id 用：把浮点截到 4 位（`1.0000000000000002` 这类噪声不许影响 key） */
function tidy(v, step) {
  if (!Number.isFinite(v)) return 0;
  const s = Number.isFinite(step) && step > 0 ? step : 0.01;
  return Number((Math.round(v / s) * s).toFixed(4));
}

/**
 * 归一化：夹取到范围内、按 step 对齐、非数字回默认值；**每一处被改动都留 warning**。
 * @returns {{params: Record<string, number|null>, warnings: Array<{key:string,reason:string,from?:number,to?:number}>}}
 */
export function normalizeTerrainParams(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const params = {};
  const warnings = [];
  for (const f of TERRAIN_PARAM_FIELDS) {
    const v = src[f.key];
    if (f.kind === 'optional-int') {
      if (v === undefined || v === null || v === '' || v === 'auto') { params[f.key] = null; continue; }
      const n = Number(v);
      if (!Number.isFinite(n)) {
        params[f.key] = null;
        warnings.push({ key: f.key, reason: 'invalid', to: null });
        continue;
      }
      const c = Math.min(f.max, Math.max(f.min, Math.round(n)));
      if (c !== n) warnings.push({ key: f.key, reason: 'clamped', from: n, to: c });
      params[f.key] = c;
      continue;
    }
    const n = Number(v);
    if (v === undefined || v === null || v === '' || !Number.isFinite(n)) {
      params[f.key] = f.def;
      if (v !== undefined && v !== null && v !== '') warnings.push({ key: f.key, reason: 'invalid', to: f.def });
      continue;
    }
    let c;
    if (f.kind === 'choice') {
      const opts = f.options || [f.def];
      c = opts.reduce((best, o) => (Math.abs(o - n) < Math.abs(best - n) ? o : best), opts[0]);
    } else if (f.kind === 'int') {
      c = Math.round(n);
    } else {
      c = tidy(n, f.step);
    }
    if (Number.isFinite(f.min) && Number.isFinite(f.max)) c = Math.min(f.max, Math.max(f.min, c));
    if (c !== n) warnings.push({ key: f.key, reason: 'clamped', from: n, to: c });
    params[f.key] = c;
  }
  return { params, warnings };
}

/** 参数 → `synthesizeHeightmapFromTerrain()` 的 opts（**唯一映射口**，别在调用处另拼一份） */
export function toSynthesisOptions(params, extra = {}) {
  const p = normalizeTerrainParams(params).params;
  const st = TERRAIN_STRUCTURE;
  // ⚠️ 默认值全部是 `原常量 × 1.0` —— 这是"默认参数 = 旧行为"的物理保证。
  const structureOverrides = {
    rangeWeight: st.rangeWeight * p.mountainStrength,
    crossRangeWeight: st.crossRangeWeight * p.mountainStrength,
    plateauWeight: st.plateauWeight * p.plateauStrength,
    riftDepth: p.riftDepth,
  };
  const opts = {
    seed: p.seed,
    relief: p.relief,
    cellsAcross: p.cellsAcross,
    structureOverrides,
    ...extra,
  };
  // `null` = 随种子：传 undefined 才会让推演回落到 `rangeAxisFromSeed(seed)`
  if (p.rangeAxisDeg != null) opts.rangeAxisDeg = p.rangeAxisDeg;
  return opts;
}

/** 参数 → 气候派生 opts（纬度跨度；离岸距离由网格自己算，不需要参数） */
export function toClimateOptions(params) {
  const p = normalizeTerrainParams(params).params;
  return { latitudeSpanDeg: p.latitudeSpanDeg };
}

/** 稳定 key：同参数同 key（UI 缓存 / 用例断言用；字段顺序固定，不受对象字面量顺序影响） */
export function terrainParamsKey(params) {
  const p = normalizeTerrainParams(params).params;
  return TERRAIN_PARAM_FIELDS.map((f) => `${f.key}=${p[f.key] === null ? 'auto' : p[f.key]}`).join('|');
}

/** 中文摘要（回执 / 面板底部一行） */
export function describeTerrainParams(params) {
  const p = normalizeTerrainParams(params).params;
  const axis = p.rangeAxisDeg == null ? '随种子' : `${p.rangeAxisDeg}°`;
  return `种子 ${p.seed} · 起伏 ${p.relief.toFixed(2)} · 山脉 ${p.mountainStrength.toFixed(2)}`
    + ` · 高原 ${p.plateauStrength.toFixed(2)} · 裂谷 ${p.riftDepth.toFixed(2)}`
    + ` · ${p.cellsAcross} 格 · 走向 ${axis} · 纬度跨度 ${Math.round(p.latitudeSpanDeg)}°`;
}

/**
 * 候选种子：第 i 个候选用一个**与基准确定性错开**的种子。
 * ⚠️ 不许用 `Math.random()`：候选必须是"同参数永远同三张"，否则用户选中的那张
 *    在应用时就算不出来了（预览 → 应用对不上 = 最坏的体验）。
 */
export function candidateSeed(seed, index = 0) {
  const s = Number.isFinite(Number(seed)) ? Math.floor(Number(seed)) : 7;
  const i = Math.max(0, Math.floor(Number(index) || 0));
  if (i === 0) return ((s % 1000000) + 1000000) % 1000000;
  const mixed = (Math.imul(s + 1, 2654435761) ^ Math.imul(i + 1, 40503)) >>> 0;
  const v = mixed % 1000000;
  return v === ((s % 1000000) + 1000000) % 1000000 ? (v + 1) % 1000000 : v;
}

/** 🎲 换种子：由当前种子确定性推进（同一个"骰子"按顺序点是可复现的，用例能测） */
export function rollSeed(seed) {
  const s = Number.isFinite(Number(seed)) ? Math.floor(Number(seed)) : 7;
  const next = (Math.imul(s + 1, 1664525) + 1013904223) >>> 0;
  return next % 1000000;
}

/** 给 UI 用：按 key 取字段定义（拿 min/max/step/label） */
export function terrainParamField(key) {
  return FIELD_BY_KEY.get(key) || null;
}

// ══════════════════════════════════════════════════════════════════════════
// 造陆参数（P0-2，2026-10-25）—— **另一组**，不要与上面混
//   上面那组喂 `synthesizeHeightmapFromTerrain()`（按已有轮廓推地形）；
//   这一组喂 `generateLandmass()`（生成轮廓本身）。消费者不同，字段也不重叠。
// ══════════════════════════════════════════════════════════════════════════

export const LAND_PARAM_FIELDS = Object.freeze([
  {
    key: 'seed', label: '随机种子', kind: 'int', min: 0, max: 999999, step: 1, def: 7,
    hint: '同种子 + 同参数 = 同一组大陆；换种子只改位置/形状落点',
  },
  {
    key: 'continentCount', label: '陆块数', kind: 'int', min: 1, max: 8, step: 1, def: 3,
    hint: '生成几块大陆（群岛模式下每块再拆成 2~4 个岛）',
  },
  {
    key: 'landRatio', label: '陆地占比', kind: 'float', min: 0.05, max: 0.55, step: 0.01, def: 0.32,
    hint: '目标陆地面积 / 区域面积。⚠️ 不重叠的多块大陆上限约 35%（再多就装不下，实际值会如实回低）',
  },
  {
    key: 'shape', label: '形状', kind: 'enum', options: ['continent', 'elongated', 'archipelago'], def: 'continent',
    hint: '圆润大陆 / 长条大陆 / 群岛',
  },
  {
    key: 'roughness', label: '海岸崎岖度', kind: 'float', min: 0, max: 1, step: 0.05, def: 0.45,
    hint: '0 = 光滑椭圆；越大海岸线越碎（环采样点也更多）',
  },
  {
    key: 'sizeVariance', label: '大小差异', kind: 'float', min: 0, max: 1, step: 0.05, def: 0.4,
    hint: '0 = 各陆块一样大；1 = 最大块约是最小块的 4 倍',
  },
  {
    key: 'provinceCount', label: '铺底块数', kind: 'int', min: 20, max: 600, step: 10, def: 180,
    hint: '造陆后用现有 Voronoi 铺底切成多少省（415 省量级请填 400+，会走分批让帧）',
  },
]);

export const DEFAULT_LAND_PARAMS = Object.freeze(
  LAND_PARAM_FIELDS.reduce((acc, f) => { acc[f.key] = f.def; return acc; }, {}),
);

export const LAND_PRESETS = Object.freeze([
  { id: 'continent', name: '大陆世界', params: { ...DEFAULT_LAND_PARAMS } },
  {
    id: 'archipelago', name: '群岛世界',
    params: { ...DEFAULT_LAND_PARAMS, continentCount: 2, shape: 'archipelago', landRatio: 0.24, roughness: 0.6 },
  },
  {
    id: 'coast', name: '狭长海岸',
    params: { ...DEFAULT_LAND_PARAMS, continentCount: 2, shape: 'elongated', landRatio: 0.28 },
  },
]);

const LAND_FIELD_BY_KEY = new Map(LAND_PARAM_FIELDS.map((f) => [f.key, f]));

/** 归一化造陆参数（夹取留 warning；enum 只认白名单） */
export function normalizeLandParams(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const params = {};
  const warnings = [];
  for (const f of LAND_PARAM_FIELDS) {
    const v = src[f.key];
    if (f.kind === 'enum') {
      params[f.key] = f.options.includes(v) ? v : f.def;
      if (v !== undefined && v !== params[f.key]) warnings.push({ key: f.key, reason: 'invalid', to: params[f.key] });
      continue;
    }
    const n = Number(v);
    if (v === undefined || v === null || v === '' || !Number.isFinite(n)) {
      params[f.key] = f.def;
      if (v !== undefined && v !== null && v !== '') warnings.push({ key: f.key, reason: 'invalid', to: f.def });
      continue;
    }
    let c = f.kind === 'int' ? Math.round(n) : tidy(n, f.step);
    c = Math.min(f.max, Math.max(f.min, c));
    if (c !== n) warnings.push({ key: f.key, reason: 'clamped', from: n, to: c });
    params[f.key] = c;
  }
  return { params, warnings };
}

/** 造陆参数 → `generateLandmass(params, bbox)` 的入参（唯一映射口） */
export function toLandmassOptions(params) {
  return normalizeLandParams(params).params;
}

/** 中文摘要（回执 / 面板一行） */
export function describeLandParams(params) {
  const p = normalizeLandParams(params).params;
  const label = { continent: '圆润大陆', elongated: '长条大陆', archipelago: '群岛' }[p.shape] || p.shape;
  return `种子 ${p.seed} · ${p.continentCount} 陆块 · ${label} · 占比 ${(p.landRatio * 100).toFixed(0)}%`
    + ` · 崎岖 ${p.roughness.toFixed(2)} · 大小差 ${p.sizeVariance.toFixed(2)} · 铺 ${p.provinceCount} 省`;
}

/** 稳定 key（候选缓存 / 用例断言） */
export function landParamsKey(params) {
  const p = normalizeLandParams(params).params;
  return LAND_PARAM_FIELDS.map((f) => `${f.key}=${p[f.key]}`).join('|');
}

export function landParamField(key) {
  return LAND_FIELD_BY_KEY.get(key) || null;
}

// ══════════════════════════════════════════════════════════════════════════
// 文化 / 宗教 / 势力派生参数（P0-4，2026-10-25）
// ══════════════════════════════════════════════════════════════════════════

export const CULTURE_PARAM_FIELDS = Object.freeze([
  {
    key: 'seed', label: '随机种子', kind: 'int', min: 0, max: 999999, step: 1, def: 7,
    hint: '同种子 + 同参数 = 同一套文化/宗教/势力落点',
  },
  {
    key: 'cultureCount', label: '文化数', kind: 'int', min: 1, max: 12, step: 1, def: 5,
    hint: '逐格文化用最远点采样选中心，每格归最近中心 → 连续文化区',
  },
  {
    key: 'religionCount', label: '宗教数', kind: 'int', min: 1, max: 12, step: 1, def: 4,
    hint: '每个文化中心优先配一个宗教中心（宗教沿文化扩散），不足再补',
  },
  {
    key: 'polityCount', label: '势力数', kind: 'int', min: 1, max: 12, step: 1, def: 4,
    hint: '按文化区分组，一组一个势力；势力多于文化时同一文化按形心再切',
  },
]);

export const DEFAULT_CULTURE_PARAMS = Object.freeze(
  CULTURE_PARAM_FIELDS.reduce((acc, f) => { acc[f.key] = f.def; return acc; }, {}),
);

const CULTURE_FIELD_BY_KEY = new Map(CULTURE_PARAM_FIELDS.map((f) => [f.key, f]));

export function normalizeCultureParams(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const params = {};
  const warnings = [];
  for (const f of CULTURE_PARAM_FIELDS) {
    const n = Number(src[f.key]);
    if (!Number.isFinite(n)) {
      params[f.key] = f.def;
      if (src[f.key] !== undefined && src[f.key] !== null && src[f.key] !== '') {
        warnings.push({ key: f.key, reason: 'invalid', to: f.def });
      }
      continue;
    }
    const c = Math.min(f.max, Math.max(f.min, Math.round(n)));
    if (c !== n) warnings.push({ key: f.key, reason: 'clamped', from: n, to: c });
    params[f.key] = c;
  }
  return { params, warnings };
}

export function describeCultureParams(params) {
  const p = normalizeCultureParams(params).params;
  return `种子 ${p.seed} · ${p.cultureCount} 文化 · ${p.religionCount} 宗教 · ${p.polityCount} 势力`;
}

export function cultureParamField(key) {
  return CULTURE_FIELD_BY_KEY.get(key) || null;
}
