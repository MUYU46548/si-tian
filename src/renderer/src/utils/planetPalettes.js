/**
 * 本机配色库（2026-11-25，B 方案的前半段：DIY）
 *
 * 用户问过「后续有多种颜色可以选吗？甚至 DIY？」——A 是"逐颗改色"（已落地），
 * B 是"自己造一套配色，存起来、以后能选"。这个文件就是 B 的**存储层**。
 *
 * ## 为什么先落 localStorage 而不是项目文件
 *
 * 项目文件（`.sitian`）是**世界事实**：别人打开这个项目应该看到同一颗行星的颜色，
 * 所以"逐颗改色"（`node.planetColors`）必须进项目文件 —— 那条已经做了。
 * 而"我的配色库"是**作者自己的调色习惯**，跟哪个项目无关（做第二个世界时还想用）。
 * 这类东西放 localStorage 更合适：不污染世界数据、不需要 schema 迁移、不会因为
 * 项目文件格式变化而失效。要"多人共享同一套类别"再升级成项目级数据。
 *
 * ## 纪律
 *
 * · 纯函数 + 一个薄存取口；所有读写都 try/catch（隐私模式 / 配额满 / 被禁用时**不许炸渲染**）；
 * · 上限 `MAX_PRESETS` 条（超了丢最旧的）：localStorage 只有几 MB，不能当数据库用；
 * · 存的是"覆盖补丁"（`{ base, land, cap, atmosphere }`），不是整套类别定义 ——
 *   这样类别默认值将来改了，老配色仍然跟着新默认走没覆盖的部分。
 */

const KEY = 'sitian.planetPalettes.v1';
/** 最多存多少套（超了丢最旧的） */
export const MAX_PRESETS = 24;

/** 只留合法的覆盖项：脏值不进库（进库就会被 paletteForClass 静默丢掉，白占地方） */
const HEX6 = /^#[0-9a-fA-F]{6}$/;
export function sanitizeColors(colors) {
  const o = colors && typeof colors === 'object' ? colors : {};
  const out = {};
  for (const k of ['base', 'cap', 'atmosphere']) {
    if (typeof o[k] === 'string' && HEX6.test(o[k])) out[k] = o[k];
  }
  const land = Array.isArray(o.land) ? o.land.filter((x) => typeof x === 'string' && HEX6.test(x)) : [];
  if (land.length) out.land = land;
  return out;
}

/** 一套配色是否有内容（全空的不许存：存了也是"什么都不改"，只会让列表变脏） */
export function hasAnyColor(colors) {
  const c = sanitizeColors(colors);
  return !!(c.base || c.cap || c.atmosphere || (c.land && c.land.length));
}

/**
 * 读整库（**永远返回数组**：读坏了就返回空，绝不抛）。
 * @returns {Array<{ id:string, name:string, colors:object, classId?:string, at:number }>}
 */
export function loadPresets() {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list
      .filter((x) => x && typeof x === 'object' && typeof x.id === 'string')
      .map((x) => ({
        id: x.id,
        name: typeof x.name === 'string' && x.name.trim() ? x.name.trim() : '未命名配色',
        classId: typeof x.classId === 'string' ? x.classId : '',
        colors: sanitizeColors(x.colors),
        at: Number.isFinite(x.at) ? x.at : 0,
      }))
      // 越新越靠前（列表里第一条就是刚存的）
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

function write(list) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/**
 * 存一套配色。同名同色视为重复（更新 name/at，不新增），超过上限丢最旧的。
 * @returns {{ ok: boolean, list: Array<object>, id: string|null }}
 */
export function savePreset({ name, colors, classId }) {
  const clean = sanitizeColors(colors);
  if (!hasAnyColor(clean)) return { ok: false, list: loadPresets(), id: null };
  const label = String(name || '').trim() || '未命名配色';
  const key = JSON.stringify(clean);
  const list = loadPresets();
  const dup = list.find((x) => JSON.stringify(x.colors) === key);
  const id = dup ? dup.id : `pal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const next = [
    { id, name: label, classId: String(classId || ''), colors: clean, at: Date.now() },
    ...list.filter((x) => x.id !== id),
  ].slice(0, MAX_PRESETS);
  return { ok: write(next), list: next, id };
}

/** 删一套（按 id）。返回剩下的列表。 */
export function removePreset(id) {
  const next = loadPresets().filter((x) => x.id !== id);
  write(next);
  return next;
}
