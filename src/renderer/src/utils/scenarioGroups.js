// utils/scenarioGroups.js — 历史剧本“剧本集”纯函数层（2026-10-25）
//
// 为什么需要独立一层：剧本集是**数据语义**（哪几条剧本属于同一条时间线），
// 左栏、时间轴、切片导出、剧本管理、导入导出五处都要用同一套判定。
// 五处各写一遍 `s.group || 'default'` 不会报错 —— 只会出现“左栏按组过滤了、
// 时间轴没有”这种同屏两个世界（本项目在“省份色 / 派生命名 / 海色”上各栽过一次）。
//
// 纯函数：不碰 store / DOM / 响应式，Node 侧可直接测。

/** 未分组剧本的归属组（**虚拟组**：不写进 projects 的 groups 表，但永远可选） */
export const DEFAULT_SCENARIO_GROUP = 'default';
export const DEFAULT_SCENARIO_GROUP_NAME = '默认';

/** 剧本属于哪个组（缺省 / 空串 / 脏值 → 默认组） */
export function scenarioGroupIdOf(scenario) {
  const raw = scenario && scenario.group;
  const s = String(raw == null ? '' : raw).trim();
  return s || DEFAULT_SCENARIO_GROUP;
}

/**
 * 规整组表：丢掉没有 id 的行、去重、补 name/order，按 order 稳定排序。
 * ⚠️ 不在这里塞“默认”——默认组是虚拟的，只在 `scenarioGroupOptions` 里出现。
 */
export function sanitizeScenarioGroups(list) {
  const out = [];
  const seen = new Set([DEFAULT_SCENARIO_GROUP]);
  const rows = Array.isArray(list) ? list : [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;
    const id = String(row.id == null ? '' : row.id).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = String(row.name == null ? '' : row.name).trim() || id;
    const order = Number.isFinite(Number(row.order)) ? Number(row.order) : i + 1;
    out.push({ id, name, order });
  }
  return out.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
}

/** 下拉/列表用的组选项：默认组永远在第一位 */
export function scenarioGroupOptions(groups) {
  return [
    { id: DEFAULT_SCENARIO_GROUP, name: DEFAULT_SCENARIO_GROUP_NAME, order: 0 },
    ...sanitizeScenarioGroups(groups),
  ];
}

/** 组 id → 显示名（找不到时回 id，绝不返回空串） */
export function scenarioGroupNameOf(groups, id) {
  const gid = String(id == null ? '' : id).trim() || DEFAULT_SCENARIO_GROUP;
  const hit = scenarioGroupOptions(groups).find((g) => g.id === gid);
  return hit ? hit.name : gid;
}

/** 剧本列表条目的一句话摘要：势力数 · 真有归属的省数（左栏、总览、卡片墙同一口径） */
export function scenarioMetaText(scenario) {
  const polities = (scenario?.polities || []).length;
  const own = scenario?.ownership || {};
  const owned = Object.keys(own).filter((pid) => own[pid]).length;
  return `${polities} 势力 · ${owned} 省`;
}

/**
 * 跨剧本集**只读总览**（A3，2026-11-05）—— 左栏“看全部剧本集”用的行模型。
 *
 * 为什么要有它：剧本集 = 一条独立时间线。当前组的时间轴/播放/切片只取本组（这是对的），
 * 但也意味着**看不见别的时间线**。总览把全部剧本按小组出来，让人能看到“还有一条 X 时代”，
 * 同时 **别组的剧本是只读的**（`readonly: true`）：能看、能一键切过去，但不会在总览里
 * 悄悄把当前编辑目标换掉。
 *
 * 口径：
 *   · 当前组永远排第一（其余按组表 order，再按 id —— 确定性）；
 *   · 空组不出现（总览不是组管理表）；
 *   · 组内保持入参顺序（调用方传进来的已经按 order 排好）；
 *   · 组名找不到时回 id；默认组叫“默认”；
 *   · `activeGroupId` 指向一个组表里没有、但有剧本的组（导入包常见）→ 它照样排第一并标 isActive。
 *
 * @param {Array<object>} scenarios 全部剧本（同一张底图下的）
 * @param {Array<object>} groups 项目级组表
 * @param {string} activeGroupId 当前组
 * @returns {Array<{id:string,name:string,isActive:boolean,scenarios:Array<object>}>}
 */
export function scenarioOverviewRows(scenarios, groups, activeGroupId) {
  const list = Array.isArray(scenarios) ? scenarios : [];
  const active = String(activeGroupId == null ? '' : activeGroupId).trim() || DEFAULT_SCENARIO_GROUP;
  const options = scenarioGroupOptions(groups);
  const byId = new Map(options.map((g) => [g.id, g]));
  const buckets = new Map();
  for (const s of list) {
    const gid = scenarioGroupIdOf(s);
    let row = buckets.get(gid);
    if (!row) {
      const hit = byId.get(gid);
      row = { id: gid, name: hit ? hit.name : gid, order: hit ? hit.order : Number.MAX_SAFE_INTEGER, rows: [] };
      buckets.set(gid, row);
    }
    row.rows.push(s);
  }
  const rows = [...buckets.values()];
  rows.sort((a, b) => {
    if ((a.id === active) !== (b.id === active)) return a.id === active ? -1 : 1;
    return (a.order - b.order) || String(a.id).localeCompare(String(b.id));
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    isActive: row.id === active,
    scenarios: row.rows.map((s) => ({ ...s, readonly: row.id !== active })),
  }));
}

/** 只留属于某组的剧本（保持入参顺序） */
export function filterScenariosByGroup(scenarios, groupId) {
  const gid = String(groupId == null ? '' : groupId).trim() || DEFAULT_SCENARIO_GROUP;
  return (Array.isArray(scenarios) ? scenarios : []).filter((s) => scenarioGroupIdOf(s) === gid);
}

/** 组 id → 剧本条数（左栏下拉/组管理用） */
export function scenarioGroupCounts(scenarios) {
  const map = new Map();
  for (const s of (Array.isArray(scenarios) ? scenarios : [])) {
    const gid = scenarioGroupIdOf(s);
    map.set(gid, (map.get(gid) || 0) + 1);
  }
  return map;
}

/** 第一个有剧本的组（切底图/首次打开时用；全空 → 默认组） */
export function firstNonEmptyGroupId(scenarios) {
  const list = Array.isArray(scenarios) ? scenarios : [];
  for (const s of list) {
    const gid = scenarioGroupIdOf(s);
    if (gid) return gid;
  }
  return DEFAULT_SCENARIO_GROUP;
}

/** 新组 id（确定、可测；不用 Date.now —— 同一批夹具两次跑要同名） */
export function nextScenarioGroupId(groups) {
  const used = new Set(sanitizeScenarioGroups(groups).map((g) => g.id));
  let n = 1;
  while (used.has(`grp_${n}`)) n++;
  return `grp_${n}`;
}

/** 剧本实际用到的非默认组 id（按首次出现顺序） */
export function collectUsedGroupIds(scenarios) {
  const out = [];
  const seen = new Set();
  for (const s of (Array.isArray(scenarios) ? scenarios : [])) {
    const gid = scenarioGroupIdOf(s);
    if (gid === DEFAULT_SCENARIO_GROUP || seen.has(gid)) continue;
    seen.add(gid);
    out.push(gid);
  }
  return out;
}

/**
 * 收养“剧本引用了、组表里却没有”的组 id（2026-10-25）。
 *
 * 为什么必须做：剧本的可见性 = `scenario.group ∈ 当前组选项`。如果导入包/旧数据里
 * 只有 `scenario.group` 而组表丢了，这条剧本**不会出现在任何组里**（默认组也不收它）——
 * 用户看到的是“剧本凭空消失”，且没有任何报错。这里把孤儿 id 收编成同名组，
 * **不改剧本**（只补组表），保住可见性；用户可在管理对话框里改名。
 */
export function adoptOrphanGroups(groups, scenarios) {
  const clean = sanitizeScenarioGroups(groups);
  const have = new Set(clean.map((g) => g.id));
  const extra = [];
  let order = clean.length + 1;
  for (const gid of collectUsedGroupIds(scenarios)) {
    if (have.has(gid)) continue;
    have.add(gid);
    extra.push({ id: gid, name: gid, order: order++ });
  }
  return extra.length ? sanitizeScenarioGroups([...clean, ...extra]) : clean;
}
