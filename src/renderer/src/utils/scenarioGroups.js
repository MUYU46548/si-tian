// utils/scenarioGroups.js — 历史剧本「剧本集」纯函数层（2026-10-25）
//
// 为什么需要独立一层：剧本集是**数据语义**（哪几条剧本属于同一条时间线），
// 左栏、时间轴、切片导出、剧本管理、导入导出五处都要用同一套判定。
// 五处各写一遍 `s.group || 'default'` 不会报错 —— 只会出现「左栏按组过滤了、
// 时间轴没有」这种同屏两个世界（本项目在「省份色 / 派生命名 / 海色」上各栽过一次）。
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
 * ⚠️ 不在这里塞「默认」——默认组是虚拟的，只在 `scenarioGroupOptions` 里出现。
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
 * 收养「剧本引用了、组表里却没有」的组 id（2026-10-25）。
 *
 * 为什么必须做：剧本的可见性 = `scenario.group ∈ 当前组选项`。如果导入包/旧数据里
 * 只有 `scenario.group` 而组表丢了，这条剧本**不会出现在任何组里**（默认组也不收它）——
 * 用户看到的是「剧本凭空消失」，且没有任何报错。这里把孤儿 id 收编成同名组，
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
