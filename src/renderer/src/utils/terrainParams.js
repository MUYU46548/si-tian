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
