// utils/loreBinding.js — 「库内笔记 ↔ 画布节点」的**稳定身份绑定**纯函数层（N3a-3，2026-11-02）
//
// ── 为什么需要这一层 ──────────────────────────────────────────────────────
// 今天节点与笔记的关联只有 `sourcePath`（相对路径）。Obsidian 里改一次名 / 挪一次目录，
// 路径就变了 —— 节点 id 是 `normalizeId(文件名)`，于是**同一篇笔记变成另一个实体**，
// 坐标、地图数据、剧本归属全留在旧 id 上，用户看到的是「多了一个、少了一个」。
// 本模块不写任何数据，只回答三个问题：
//   · 这篇笔记的**身份**是什么（`bindingKey` / `fingerprintOf`）；
//   · 上一轮的绑定在新索引里还对不对得上、哪条其实是**改名**、哪条**认不出来**（`reconcileBindings`）；
//   · 把一条候选变成节点草稿要长什么样、id 怎么算才**不会导两次变两个**（`candidateToNodeDraft`）。
//
// ── 三条纪律（都不许破）──
//   ① 纯函数：无 DOM、无 IPC、无文件系统、**不读当前时间**（`noteRefOf` 的时间戳由调用方传入）；
//      所以可以直接在 Node 单测里跑（`scripts/tests/unit/test_lore_binding.js`）。
//   ② 不猜：指纹不唯一就进 `lost`，**绝不**按「名字像」去配 —— 乱认一条比不认更坏
//      （用户会照单全收，等于让机器替他认错亲；与「认不出就进待人工」同一条纪律）。
//   ③ 确定：同样的输入永远产出同样的键 / 指纹 / 节点 id；`candidateToNodeDraft` 导两次必须同 id。
//
// ── bindingKey 的优先级（**就是**这份清单，改它等于改数据契约）────────────────
//   1. **显式稳定 id**：frontmatter 的 `sitian-id` / `sitian_id` / `sitianId`（索引条目上是 `sitianId`）
//      → `id:<值>`。这是唯一「改名 + 移动都不变」的身份；真实库里几乎没人写，但位置先留好。
//   2. **库内相对路径**（统一 `/`、去 `./`、去重斜杠）→ `path:<路径>`。索引里本来就有且唯一，
//      是当前默认档 —— 代价是**改名/移动即换键**（这一档靠 `fingerprintOf` 兜底认亲）。
//   3. **标题** → `title:<标题>`。只有"没有路径的合成条目"（用例 / 外部调用）才会落到这一档。
//   都没有 → `''`，= **不可识别**。调用方必须把它当"不能绑定"，不许兜底成名字相近。
//   ⚠️ 别名（`aliases`）**不参与 key**：别名是用户随时可改的显示名，把可变值当键 =
//      "加个别名，链接就断了"。它只用在指纹里（见 `fingerprintOf`）。
//
// ── 与既有实现的关系（「同一能力只许一份实现」）──
//   · 路径归一化：复用 `utils/vaultRelink.js` 的 `normalizeRelPath`（断线对账用的同一份）；
//   · 节点 id 规范化：复用 `utils/normalizeId.js`（提取器 / 转正 / 本模块同一个口径）；
//   · 归类（"这条候选是不是地图实体"）：**不在本模块**做决定，只读主进程索引给的 `kind`/`layer`
//     （唯一实现是 `scripts/lib/vaultClassify.js`）。这里只负责身份，不负责"它是什么"。
//   · `node.notePaths`（关联资料：可挂多篇、只有路径）**不是**本模块的 `node.lore`
//     （主词条绑定：一篇、带稳定身份）；两者是两种能力，见 store/geodataModules/loreBinding.js。
import { normalizeRelPath } from './vaultRelink';
import { normalizeId } from './normalizeId';

/** 导入候选建的节点都带这个标签（可反查、可在画布上筛出来） */
export const VAULT_IMPORT_TAG = 'vault-import';

/** frontmatter 里被认作「显式稳定 id」的字段名（顺序 = 优先级） */
const EXPLICIT_ID_KEYS = ['sitianId', 'sitian-id', 'sitian_id', 'uid', 'UID'];

function asText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) {
    for (const x of v) {
      const t = asText(x);
      if (t) return t;
    }
    return '';
  }
  return String(v).replace(/\[\[|\]\]/g, '').trim();
}

/** 标题归一（去双链括号 / 去 `.md` / 折叠空白）；不做大小写折叠（中文标题没有大小写） */
function cleanTitle(v) {
  return asText(v).replace(/\.md$/i, '').replace(/\s+/g, ' ').trim();
}

/** 显式稳定 id（没有则 `''`）—— 索引条目优先 `sitianId`，也容忍直接喂 frontmatter 的调用方 */
export function explicitIdOf(entry) {
  const e = entry || {};
  for (const k of EXPLICIT_ID_KEYS) {
    const t = asText(e[k]);
    if (t) return t;
  }
  const fm = e.fm && typeof e.fm === 'object' ? e.fm : null;
  if (fm) {
    for (const k of EXPLICIT_ID_KEYS) {
      const t = asText(fm[k]);
      if (t) return t;
    }
  }
  return '';
}

/** 条目标题（依次取 title / name / 路径文件名主干） */
export function titleOf(entry) {
  const e = entry || {};
  const direct = cleanTitle(e.title) || cleanTitle(e.name);
  if (direct) return direct;
  const p = normalizeRelPath(e.path);
  if (!p) return '';
  const seg = p.split('/').pop() || '';
  return cleanTitle(seg);
}

/** 别名清单（排序后去重 → 指纹才是确定的；`['乙','甲']` 与 `['甲','乙']` 必须同指纹） */
export function aliasesOf(entry) {
  const raw = (entry && entry.aliases) || [];
  const list = (Array.isArray(raw) ? raw : [raw])
    .map((x) => cleanTitle(x))
    .filter(Boolean);
  return [...new Set(list)].sort((a, b) => a.localeCompare(b, 'zh'));
}

/**
 * 这篇笔记「如果成为地图节点会用的 id」—— 与提取器同一口径（`normalizeId(文件名)`）。
 *
 * 为什么单独留一个字段：它告诉你"这篇笔记现在对应哪个实体"，方便 UI 说人话
 * （「这篇笔记就是节点『雾隐城』」）。但它**不能当绑定键** —— 改文件名它就变了，
 * 而"改名不掉线"正是本模块要解决的问题。
 */
export function noteIdOf(entry) {
  const e = entry || {};
  const p = normalizeRelPath(e.path);
  const base = p ? (p.split('/').pop() || '').replace(/\.md$/i, '') : '';
  return explicitIdOf(e) || normalizeId(base || titleOf(e));
}

/**
 * 绑定键（优先级见文件头）。确定性：同样的条目永远同样的字符串；认不出来返回 `''`。
 * @returns {string} `id:<…>` | `path:<…>` | `title:<…>` | `''`
 */
export function bindingKey(entry) {
  const id = explicitIdOf(entry);
  if (id) return `id:${id}`;
  const p = normalizeRelPath(entry && entry.path);
  if (p) return `path:${p}`;
  const title = titleOf(entry);
  if (title) return `title:${title}`;
  return '';
}

/**
 * 指纹 = **与位置无关**的身份，用来认「同一篇笔记换了 path」。
 *
 * 组成：显式 id（若有）→ `id:<…>`；否则 `标题 + 排序后的别名`。
 *
 * 🔴 为什么**不用** size / mtime：
 *   · `mtime` 每次保存、每次同步都变 —— 拿它当身份，改一个字就被判成"另一篇笔记"；
 *   · `size` 也随编辑变（改一个标点就变），同样会把"编辑过"误判成"另一篇"。
 *   这正是施工单点名的禁区（"mtime bucket is NOT allowed"），这里显式写下来防后人加回去。
 * 🔴 为什么可以不含 path：要认的正是"换了 path 的同一篇笔记"。
 *
 * 诚实的边界（必须让用户知道，也必须让 UI 说）：**标题和别名都改了**的笔记，
 * 指纹对不上 → 进 `lost` → **需要人工重绑**。本模块不按"名字像"去猜 ——
 * 机器认亲只在身份证据充分时发生，其余一律交给人（一次点击，几秒）。
 *
 * @returns {string} `id:<…>` | `fp:<标题>|<别名,别名>` | `''`（不可识别）
 */
export function fingerprintOf(entry) {
  const id = explicitIdOf(entry);
  if (id) return `id:${id}`;
  const title = titleOf(entry);
  if (!title) return '';
  return `fp:${title}|${aliasesOf(entry).join(',')}`;
}

/**
 * 挂到节点上的笔记引用（`node.lore` 的形状）。
 *
 * `{ noteId, path, title, at, key, fingerprint }`：
 *   · `noteId` —— 这篇笔记对应的实体 id（见 `noteIdOf`，随改名而变，**不是**键）；
 *   · `path`   —— 绑定时的库内相对路径（人看得懂、能直接开阅读器）；
 *   · `at`     —— 绑定时间（由调用方传入，本模块不读时钟，保持可测）；
 *   · `key` / `fingerprint` —— 绑定当时的身份快照，`reconcileBindings` 直接吃它，
 *     所以**不需要**为了对账回库重算一遍。
 * @param {object} entry 索引条目 / 搜索结果 / 已有的绑定（都接受）
 * @param {string} [at] 绑定时间（ISO 字符串；调用方给）
 * @returns {null | {noteId:string, path:string, title:string, at:string, key:string, fingerprint:string}}
 */
export function noteRefOf(entry, at = '') {
  const e = entry || {};
  const key = String(e.key || bindingKey(e) || '');
  const fingerprint = String(e.fingerprint || fingerprintOf(e) || '');
  const path = normalizeRelPath(e.path);
  const title = titleOf(e);
  const noteId = String(e.noteId || noteIdOf(e) || '');
  if (!key && !path && !title) return null;         // 什么都没有 → 不是一条可绑定的引用
  return Object.freeze({
    noteId,
    path,
    title,
    at: String(at || ''),
    key: key || `path:${path}`,
    fingerprint,
  });
}

/**
 * 两条引用是不是同一篇笔记（UI 用来点亮「已绑定」/ 判断重复绑定）。
 * 先比身份键，再比路径（键可能因升级/迁移缺失）。
 */
export function sameNoteRef(a, b) {
  if (!a || !b) return false;
  const ka = String(a.key || bindingKey(a) || '');
  const kb = String(b.key || bindingKey(b) || '');
  if (ka && kb && ka === kb) return true;
  const pa = normalizeRelPath(a.path);
  const pb = normalizeRelPath(b.path);
  return !!pa && pa === pb;
}

/** FNV-1a 32 位（8 位十六进制）—— 只用于把身份键压成短后缀，不需要密码学强度 */
function hash8(text) {
  const s = String(text || '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 候选 → 节点草稿（**不写任何数据**，只产出形状；写由 store 的 `importVaultCandidate` 走 `addNode`）。
 *
 * id 由**绑定键**派生（`vault_<规范化标题>_<身份键 hash8>`）：
 *   · 同一篇笔记导两次 → 同一个 id → 第二次被 store 拒为「已经导入过」，不会出现两个节点；
 *   · 不用裸 `normalizeId(标题)`：库里同名不同目录的两篇笔记会撞成同一个 id，
 *     而那两个确实是两个地方（"撞 id" 比"多一个草稿"更难收拾）。
 *   · 代价（诚实写下来）：笔记**移动过之后**再导入，id 会不同（键是路径档）；
 *     这种情形该走「绑定 / 重连」，不是再导一次。
 *
 * @param {object} candidate 索引候选 / 搜索命中（需要 title|name + path，或显式 id）
 * @param {{layer?:string, parentId?:string|null}} [opts]
 * @returns {null | {id:string,name:string,layer:string,parentId:string|null,
 *                   sourcePath:string,tags:string[],draft:boolean}}  （冻结对象）
 */
export function candidateToNodeDraft(candidate, opts = {}) {
  const c = candidate || {};
  const key = bindingKey(c);
  const name = titleOf(c);
  if (!key || !name) return null;
  const layer = String((opts && opts.layer) || c.layer || c.layerHint || 'unknown').trim() || 'unknown';
  const parentId = opts && opts.parentId != null && opts.parentId !== '' ? String(opts.parentId) : null;
  return Object.freeze({
    id: `vault_${normalizeId(name)}_${hash8(key)}`,
    name,
    layer,
    parentId,
    sourcePath: normalizeRelPath(c.path),
    tags: Object.freeze([VAULT_IMPORT_TAG]),
    draft: true,
  });
}

/** 上一轮绑定 → 规整成数组（接受数组 / `{entityId: binding}` 字典；补齐 key/fingerprint；按 entityId 稳定排序） */
function normalizePrevBindings(prevBindings) {
  const rows = [];
  const push = (b, entityId) => {
    if (!b || typeof b !== 'object') return;
    const id = String(entityId || b.entityId || '').trim();
    if (!id) return;
    const shaped = { path: b.path, title: b.title, name: b.name, aliases: b.aliases, sitianId: b.sitianId, fm: b.fm };
    rows.push({
      entityId: id,
      noteId: String(b.noteId || noteIdOf(shaped) || ''),
      path: normalizeRelPath(b.path),
      title: titleOf(shaped),
      key: String(b.key || bindingKey(shaped) || ''),
      fingerprint: String(b.fingerprint || fingerprintOf(shaped) || ''),
      at: String(b.at || ''),
    });
  };
  if (Array.isArray(prevBindings)) {
    for (const b of prevBindings) push(b, b && b.entityId);
  } else if (prevBindings && typeof prevBindings === 'object') {
    for (const [k, b] of Object.entries(prevBindings)) push(b, k);
  }
  rows.sort((a, b) => a.entityId.localeCompare(b.entityId, 'zh'));
  return rows;
}

/**
 * 对账：上一轮的绑定 × 新索引 → 新的绑定表 + 改名清单 + 失联清单。
 *
 * 规则（顺序即裁决顺序，**不做模糊匹配**）：
 *   1. **绑定键精确命中且唯一** → 保留（path 变了就是改名，进 `renamed`）；
 *   2. 键命中但**不唯一**（两篇笔记共用同一个身份）→ `lost`，不猜；
 *   3. 键没命中 → **指纹命中且唯一**（候选侧唯一 + 绑定侧唯一）→ 重绑，进 `renamed`；
 *   4. 其余 → `lost`（带可读 reasons），**绝不**按名字相似度兜底。
 *
 * 为什么"两侧都唯一"：两篇同名笔记 + 一个绑定 = 分不清绑给了谁；
 * 两个节点绑着指纹相同的笔记 + 只剩一篇 = 同样分不清。任一侧歧义都必须交给人。
 *
 * @param {Array|Object} prevBindings `[{entityId, path, title, noteId, at, key?, fingerprint?}]`
 *        或 `{ [entityId]: binding }`（就是 `node.lore` 的表）
 * @param {Array|Object} nextIndexEntries 索引条目数组或 `index.files` 字典
 * @returns {{bindings:Object<string,object>, renamed:Array, lost:Array}} 三个容器都冻结
 */
export function reconcileBindings(prevBindings, nextIndexEntries) {
  const prev = normalizePrevBindings(prevBindings);
  const entries = (Array.isArray(nextIndexEntries)
    ? nextIndexEntries
    : Object.values(nextIndexEntries || {}))
    .filter((e) => e && typeof e === 'object');

  const byKey = new Map();
  const byFingerprint = new Map();
  const add = (map, k, v) => {
    if (!k) return;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(v);
  };
  for (const e of entries) {
    add(byKey, bindingKey(e), e);
    add(byFingerprint, fingerprintOf(e), e);
  }
  // 绑定侧的重数：指纹被多个节点共用时，剩下唯一一条候选也分不清是谁的
  const prevFpCount = new Map();
  for (const b of prev) {
    if (!b.fingerprint) continue;
    prevFpCount.set(b.fingerprint, (prevFpCount.get(b.fingerprint) || 0) + 1);
  }

  // 用 null 原型：entityId 来自用户数据（`normalizeId` 保留下划线），
  // 万一有人把节点 id 起成 `__proto__`，普通对象会被"赋值改原型"吞掉这条绑定。
  const bindings = Object.create(null);
  const renamed = [];
  const lost = [];

  for (const b of prev) {
    if (!b.key && !b.fingerprint) {
      lost.push({ entityId: b.entityId, noteId: b.noteId, why: '这条绑定没有可用的身份（既没有路径也没有标题），无法对账' });
      continue;
    }

    let hit = null;
    let via = '';

    const byKeyHits = b.key ? (byKey.get(b.key) || []) : [];
    if (byKeyHits.length === 1) {
      hit = byKeyHits[0];
      via = 'key';
    } else if (byKeyHits.length > 1) {
      // 同一个身份出现在多篇笔记上（复制了带 sitian-id 的笔记 / 同一路径两条脏数据）→ 交给人
      lost.push({
        entityId: b.entityId,
        noteId: b.noteId,
        why: `有 ${byKeyHits.length} 篇笔记共用同一个身份（${b.key}），无法判断是哪一篇`,
      });
      continue;
    } else {
      const fpHits = b.fingerprint ? (byFingerprint.get(b.fingerprint) || []) : [];
      const ownCount = prevFpCount.get(b.fingerprint) || 0;
      if (fpHits.length === 1 && ownCount === 1) {
        hit = fpHits[0];
        via = 'fingerprint';
      } else if (fpHits.length > 1) {
        lost.push({
          entityId: b.entityId,
          noteId: b.noteId,
          why: `库里有 ${fpHits.length} 篇「${b.title || b.key}」同名笔记，指纹不唯一，不猜（请人工重绑）`,
        });
        continue;
      } else if (ownCount > 1) {
        lost.push({
          entityId: b.entityId,
          noteId: b.noteId,
          why: `${ownCount} 个节点绑着指纹相同的笔记，无法区分，不猜（请人工重绑）`,
        });
        continue;
      } else {
        lost.push({
          entityId: b.entityId,
          noteId: b.noteId,
          why: '库里已找不到这篇笔记（可能被删除，或改名时连标题/别名一起改了），需人工重绑',
        });
        continue;
      }
    }

    const nextPath = normalizeRelPath(hit.path);
    const nextTitle = titleOf(hit);
    const key = bindingKey(hit);
    const fingerprint = fingerprintOf(hit);
    // 绑定对象里**不带** entityId：表键就是它（带两份迟早不一致）
    const binding = Object.freeze({
      noteId: noteIdOf(hit) || b.noteId,
      path: nextPath,
      title: nextTitle,
      at: b.at,
      key,
      fingerprint,
    });
    bindings[b.entityId] = binding;
    // 改名 = **位置变了**（同一身份、不同路径）。标题变化不单列：它是同一条笔记的编辑。
    if (nextPath && nextPath !== b.path) {
      renamed.push(Object.freeze({ entityId: b.entityId, from: b.path, to: nextPath, via }));
    }
  }

  return Object.freeze({
    bindings: Object.freeze(bindings),
    renamed: Object.freeze(renamed),
    lost: Object.freeze(lost),
  });
}
