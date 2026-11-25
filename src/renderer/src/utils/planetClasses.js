/**
 * 自定义行星类别（2026-11-25 第六轮，B 方案的后半段）
 *
 * 用户原话：“后续有多种颜色可以选吗？甚至 DIY？”——A 是**逐颗改色**（已落地），
 * B 是“自己造一套配色，存起来、以后能选”。前半段把配色存进了本机库（`planetPalettes.js`），
 * 这一层把它变成**类别**：出现在类型下拉里、写进项目文件（`.sitian`）、换台机器打开同一个项目也在。
 *
 * ## 为什么类别必须进项目文件，而配色库留在 localStorage
 *
 * 逐颗改色与自定义类别都是**世界事实**：别人打开这个项目，应该看到同一颗行星是“熔金星球”、
 * 同一套颜色。所以它们在 `.sitian` 里。而“我的配色”是作者自己的调色习惯（做第二个世界还想用），
 * 与哪个项目无关 —— 那一层留在本机（见 `planetPalettes.js` 的头注释）。
 *
 * ## 一条自定义类别长什么样
 *
 * 它**不是**“只改颜色”的补丁，而是一份完整的类别定义（与 `planetArt.js` 的 `PlanetClassDef` 同形）：
 * `{ id, label, kind, base, land?, cap?, clouds, atmosphere, atmo, seed, bands?, night?, grid?, lava?, swirl? }`。
 *
 * 两个刻意的取舍：
 *   · **自带全部字段**（不存“基于某内置类别的补丁”）：内置类别将来调整观感不搬迁用户的世界；
 *     代价是以后想批量改旧类别没有捷径 —— 但“用户的世界不该被别人改样”更重要。
 *   · **`seed` 记住祖类别的 id**：纹理的随机构图（陆块位置）由 `hash(seed)` 决定，颜色由 `base/land` 决定。
 *     这样“从这颗行星存为类别”再选回来时，**陆块还是那些陆块**，只换了颜色 —— 不是一张陌生的新贴图。
 *
 * ## 纪律（都有单测）
 *
 * · id 必须是 `cp-*`（不能撞内置 id：`continental` / `gasGiant` 这些是代码里的常量）；
 * · 脏值一律不进城：颜色不是 `#rrggbb`、`kind` 不认、label 空 → 整条丢弃（`normalizePlanetClass`）；
 * · 上限 32 条：每条都是一张 512×256 的贴图（用到的才建），但项目文件不能无限长；
 * · **纯函数**：本文件不碰 DOM、不碰 store、不碰 localStorage —— 项目文件校验（`projectSchema`）
 *   与渲染层（`planetArt`）共用同一份规范化实现，避免两边各判一套。
 */

import { sanitizeColors } from './planetPalettes.js';

/** 一个项目最多存多少条自定义类别（够用且不会把卡片下拉撑爆） */
export const MAX_CUSTOM_PLANET_CLASSES = 32;
/** 类别名长度上限（下拉里一行放得下） */
export const MAX_CLASS_LABEL = 24;

const HEX6 = /^#[0-9a-fA-F]{6}$/;
/** 自定义类别 id 的**唯一**形态：`cp-*`。碰内置 id（camelCase）必须在入口就被拒 */
const ID_RE = /^cp-[a-z0-9][a-z0-9-]{2,47}$/;
const SEED_RE = /^[A-Za-z0-9_-]{1,32}$/;
const KINDS = ['terra', 'dead', 'bands'];

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (v, fallback) => (typeof v === 'number' && isFinite(v) ? v : fallback);
const hex = (v) => (typeof v === 'string' && HEX6.test(v) ? v.toLowerCase() : '');

/** 往白（t>0）或黑（t<0）混一点；返回 `#rrggbb` */
function shade(color, t) {
  const h = hex(color) || '#888888';
  const k = clamp(num(t, 0), -1, 1);
  const target = k >= 0 ? 255 : 0;
  const mix = Math.abs(k);
  const ch = (i) => {
    const v = parseInt(h.slice(i, i + 2), 16);
    return Math.round(v + (target - v) * mix).toString(16).padStart(2, '0');
  };
  return `#${ch(1)}${ch(3)}${ch(5)}`;
}

/**
 * 气巨的条带色：**由配色推导**。
 *
 * 为什么不能照抄祖类别的 `bands`：A 方案的逐颗改色只覆盖 base/land/cap/atmosphere，
 * 而气巨的贴图只看 `def.bands` —— 否则“把气巨存成类别”之后，用户在拾色器里改主色
 * 会发现球一点不变（那正是 A 方案在气巨上的已知空缺）。这里让自定义气巨真的吃自己的颜色：
 * 主色 + 陆色（有就拿来当一条亮带）派生 6 条，暗-主-亮-主-暗-亮，读起来还是气巨的带。
 */
export function bandsFromPalette(base, land = []) {
  const b = hex(base) || '#c9a06b';
  const l = (Array.isArray(land) ? land : []).map(hex).filter(Boolean);
  const bright = l[0] || shade(b, 0.3);
  const deep = l[1] || l[0] || shade(b, -0.22);
  return [shade(b, -0.28), b, bright, b, deep, shade(b, 0.16)];
}

/**
 * 统一出口：**键顺序固定**。
 *
 * 为什么重要：渲染层的纹理缓存键会带这份定义的指纹（`JSON.stringify(def)` 的散列）。
 * 如果同一个类别从文件读回来时键序不同，指纹就变了 → 每次打开项目都重建一遍贴图。
 */
function finalize({
  id, label, kind, base, land, cap, clouds, atmosphere, atmo, seed, bands,
  night, grid, lava, swirl,
}) {
  const out = { id, label, kind, base };
  if (Array.isArray(land) && land.length) out.land = land;
  if (cap) out.cap = cap;
  out.clouds = clouds;
  out.atmosphere = atmosphere;
  out.atmo = atmo;
  out.seed = seed;
  if (Array.isArray(bands) && bands.length >= 2) out.bands = bands;
  if (night) out.night = true;
  if (grid) out.grid = true;
  if (lava) out.lava = true;
  if (swirl) out.swirl = swirl;
  return out;
}

/** 生成一个不会撞内置 id 的类别 id（调用方仍要查重：同一毫秒内也可能撞） */
export function nextPlanetClassId(now = Date.now()) {
  return `cp-${Number(now).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 名字净化：折叠空白、去首尾、截断（空串返回 ''，由调用方决定是拒绝还是给默认名） */
export function sanitizeClassName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CLASS_LABEL);
}

/** 同名时补 “ 2 / 3 …”（类别列表里两个同名项没法选） */
export function uniquePlanetClassLabel(label, list = []) {
  const base = sanitizeClassName(label) || '自定义星球';
  const used = new Set((Array.isArray(list) ? list : []).map((c) => sanitizeClassName(c && c.label).toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  let i = 2;
  while (used.has(`${base} ${i}`.toLowerCase())) i += 1;
  return `${base} ${i}`;
}

/**
 * 把一份“可能是文件里读回来的 / 可能是 UI 造的”类别定义规范化。
 * 认不出就返回 `null`（整条丢弃，不修修补补 —— 半条类别比没有更糟）。
 * @returns {object|null}
 */
export function normalizePlanetClass(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!ID_RE.test(id)) return null;
  const label = sanitizeClassName(raw.label);
  if (!label) return null;
  const kind = KINDS.includes(raw.kind) ? raw.kind : '';
  if (!kind) return null;

  // 颜色统一走配色库的同一个净化口（它只管 base/cap/atmosphere/land 四个键）
  const colors = sanitizeColors(raw);
  const base = hex(colors.base);
  if (!base) return null;
  const atmosphere = hex(colors.atmosphere) || base;
  const land = Array.isArray(colors.land)
    ? [...new Set(colors.land.map(hex).filter(Boolean))].slice(0, 4)
    : [];
  const cap = hex(colors.cap);

  const clouds = clamp(num(raw.clouds, 0), 0, 0.85);
  // 大气浓淡：0.2~1.2 与 planetArt 的 ATMO_STRENGTH 同口径（存下来是为了“存成类别”观感不变）
  const atmo = clamp(num(raw.atmo, 0.6), 0.2, 1.2);

  let seed = typeof raw.seed === 'string' ? raw.seed.trim() : '';
  if (!SEED_RE.test(seed)) seed = 'continental';

  let bands = null;
  if (kind === 'bands') {
    const arr = Array.isArray(raw.bands) ? raw.bands.map(hex).filter(Boolean) : [];
    bands = arr.length >= 2 ? arr.slice(0, 8) : bandsFromPalette(base, land);
  }

  return finalize({
    id,
    label,
    kind,
    base,
    land,
    cap,
    clouds,
    atmosphere,
    atmo,
    seed,
    bands,
    night: raw.night === true,
    grid: raw.grid === true,
    lava: raw.lava === true,
    swirl: hex(raw.swirl),
  });
}

/** 规范化一整个列表：坏条目丢弃、id 重复保留第一条、超上限截断。**永远返回数组**。 */
export function normalizePlanetClassList(list, max = MAX_CUSTOM_PLANET_CLASSES) {
  const out = [];
  if (!Array.isArray(list)) return out;
  const seen = new Set();
  for (const raw of list) {
    if (out.length >= max) break;
    const def = normalizePlanetClass(raw);
    if (!def || seen.has(def.id)) continue;
    seen.add(def.id);
    out.push(def);
  }
  return out;
}

/**
 * 由一颗行星的**当前观感**造一个类别（祖类别给 `baseDef`，颜色给 `palette`）。
 *
 * `baseDef` 由调用方传（`planetArt.planetClassDef`）—— 本文件刻意不 import 渲染层，
 * 否则 `planetArt → planetClasses → planetArt` 成环，Node 单测与打包都会踩到。
 *
 * @param {{ name?: string, baseDef: object, palette?: object, atmo?: number }} input
 * @returns {object|null}
 */
export function createPlanetClass({ name = '', baseDef, palette, atmo } = {}) {
  if (!baseDef || typeof baseDef !== 'object') return null;
  const kind = KINDS.includes(baseDef.kind) ? baseDef.kind : 'terra';
  const colors = sanitizeColors(palette || {});
  const base = hex(colors.base) || hex(baseDef.base);
  if (!base) return null;

  const pickedLand = Array.isArray(colors.land)
    ? [...new Set(colors.land.map(hex).filter(Boolean))].slice(0, 4)
    : [];
  const baseLand = Array.isArray(baseDef.land) ? baseDef.land.map(hex).filter(Boolean) : [];
  // 没覆盖就沿用祖类别的陆色：类别的颜色必须**自洽**（不能出现“有陆块但没颜色”）
  const land = pickedLand.length ? pickedLand : baseLand;
  const cap = hex(colors.cap) || hex(baseDef.cap);
  const atmosphere = hex(colors.atmosphere) || hex(baseDef.atmosphere) || base;

  const seedRaw = String(baseDef.seed || baseDef.id || '');
  const seed = SEED_RE.test(seedRaw) ? seedRaw : 'continental';

  return finalize({
    id: nextPlanetClassId(),
    // 名字留空时用祖类别 label（“大陆星球 2”），由调用方再查重
    label: sanitizeClassName(name) || sanitizeClassName(baseDef.label) || '自定义星球',
    kind,
    base,
    land,
    cap,
    clouds: clamp(num(baseDef.clouds, 0), 0, 0.85),
    atmosphere,
    atmo: clamp(num(atmo, 0.6), 0.2, 1.2),
    seed,
    bands: kind === 'bands' ? bandsFromPalette(base, land) : null,
    // 观感特征跟着祖类别走（都市夜灯 / 机械网格 / 熔岩裂纹 / 剧毒漩涡）
    night: baseDef.night === true,
    grid: baseDef.grid === true,
    lava: baseDef.lava === true,
    swirl: hex(baseDef.swirl),
  });
}
