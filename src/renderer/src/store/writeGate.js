// store/writeGate.js — 单一写闸门（Phase 2，用户决策 2026-09-18）
//
// 决策：默认事实源 = 「有项目文件用项目文件；无项目时回退 Obsidian」，
//       但**无项目状态下必须只读** —— 禁止一切落盘写操作（不写散文件、不写回 Obsidian）。
//
// ── 为什么是「单一闸门」而不是各处判断 ──────────────────────────────────────
// 世界观数据的落盘入口有 11 个（下表）。分散判断必漏，而且漏了**不会有任何报错**——
// 正是「你以为在只读浏览，其实已经写回知识库」的静默破坏形态。
// 所以：所有落盘路径统一过 `guardWrite()`，UI 侧统一读 `isReadOnly` 做灰禁。
//
// ── 落盘入口清单（新增任何落盘路径必须登记进本表 + 加 guard）──────────────
//   ⚠️ `scripts/tests/cases/test_47_write_mode.py` 会**读源码**校验本清单：
//      标记 guarded 的条目必须在对应文件里出现 `guardWrite(` / `isReadOnly`。
//      所以本表不是注释，是可执行的契约。
//
//   | # | 文件 | 落盘路径 | 状态 |
//   |---|------|---------|------|
//   | 1 | store/geodata.js | saveGeodata（节点/坐标/编辑器字段） | ✅ 已守 |
//   | 2 | store/geodata.js | saveScenarios（剧本） | ✅ 已守 |
//   | 3 | store/geodata.js | saveMapData（行星地图） | ✅ 已守 |
//   | 4 | store/geodata.js | reextractGeodata（重提取会整库重写 geodata.json） | ✅ 已守 |
//   | 5 | utils/labelStyles.js | setSitianConfig(label-presets) 写进库内 .sitian/config | ✅ 已守 |
//   | 6 | utils/markerTypes.js | setSitianConfig(marker-types) 同上 | ✅ 已守 |
//   | 7 | components/PlanetMap.vue | createObsidianNote（draft 转正 → 新建 .md） | ⬜ 2.4 与按钮灰禁同时落 |
//   | 8 | components/AreaMap.vue | createObsidianNote 同上 | ⬜ 2.4 |
//   | 9 | components/NodeDetailPanel.vue | createObsidianNote 同上 | ⬜ 2.4 |
//   | 10 | components/BatchImportPanel.vue | batchImportNotes（批量新建 .md） | ⬜ 2.4 |
//   | 11 | App.vue | clearCoordinateCache（删除 geodata/mapdata 缓存） | ⬜ 2.4 |
//
// 7~11 刻意与「UI 灰禁」一起落地：只拦不灰禁＝用户点了按钮得到一句拒绝，属于坏交互；
// 灰禁必须同时给出「打开项目后即可编辑」的说明（能力不减，见 skill 铁律）。
//
// ── 三种模式 ────────────────────────────────────────────────────────────
//   'project'  已打开项目文件 → 允许写（写进项目文件）
//   'legacy'   无项目 + 兼容模式 → 允许写（沿用 Obsidian 缓存链路，**接线前的现状**）
//   'readonly' 无项目 + 严格模式 → 拒绝一切落盘写（决策 1 的终态）
//
// ⚠️ 当前 `READONLY_WITHOUT_PROJECT = false`（无项目 → 'legacy'，行为与接线前一致）。
//    翻成 true 必须与「projectStore 接线 + 测试 harness 自动开 mock 项目」同时落地：
//    45 个既有回归用例都跑在「无项目态」且依赖写盘，单独翻默认值会让基线当场全红。
//    翻转点 = Phase 2.4。

import { ref, computed } from 'vue';

export const WRITE_MODES = ['project', 'legacy', 'readonly'];

/** 无项目时是否强制只读。Phase 2.4 接线后翻 true（届时同步更新 harness）。 */
export const READONLY_WITHOUT_PROJECT = false;

export const WRITE_BLOCKED_HINT = '只读：未打开项目文件，编辑与保存已停用（新建或打开项目后即可继续编辑）';
export const READONLY_BADGE = '只读 · 未打开项目';

// ===== 落盘入口清单（见文件头表格；测试按本表读源码校验）=====
export const WRITE_CALLSITES = [
  { id: 1, file: 'src/renderer/src/store/geodata.js', marker: 'guardWrite(', what: 'saveGeodata', guarded: true },
  { id: 2, file: 'src/renderer/src/store/geodata.js', marker: 'guardWrite(', what: 'saveScenarios', guarded: true },
  { id: 3, file: 'src/renderer/src/store/geodata.js', marker: 'guardWrite(', what: 'saveMapData', guarded: true },
  { id: 4, file: 'src/renderer/src/store/geodata.js', marker: 'guardWrite(', what: 'reextractGeodata', guarded: true },
  { id: 5, file: 'src/renderer/src/utils/labelStyles.js', marker: 'guardWrite(', what: 'setSitianConfig(labelPresets)', guarded: true },
  { id: 6, file: 'src/renderer/src/utils/markerTypes.js', marker: 'guardWrite(', what: 'setSitianConfig(markerTypes)', guarded: true },
  { id: 7, file: 'src/renderer/src/components/PlanetMap.vue', marker: 'guardWrite(', what: 'createObsidianNote', guarded: false },
  { id: 8, file: 'src/renderer/src/components/AreaMap.vue', marker: 'guardWrite(', what: 'createObsidianNote', guarded: false },
  { id: 9, file: 'src/renderer/src/components/NodeDetailPanel.vue', marker: 'guardWrite(', what: 'createObsidianNote', guarded: false },
  { id: 10, file: 'src/renderer/src/components/BatchImportPanel.vue', marker: 'guardWrite(', what: 'batchImportNotes', guarded: false },
  { id: 11, file: 'src/renderer/src/App.vue', marker: 'guardWrite(', what: 'clearCoordinateCache', guarded: false },
];

// ===== 状态（模块级单例：与 store/undo.js 同模式）=====
const mode = ref(defaultModeWithoutProject());

function defaultModeWithoutProject() {
  return READONLY_WITHOUT_PROJECT ? 'readonly' : 'legacy';
}

export const writeMode = computed(() => mode.value);
export const isReadOnly = computed(() => mode.value === 'readonly');

const reason = ref('');
export const writeModeReason = computed(() => reason.value || defaultReason(mode.value));

function defaultReason(m) {
  if (m === 'project') return '已打开项目文件：编辑保存到项目文件';
  if (m === 'readonly') return WRITE_BLOCKED_HINT;
  return '未打开项目（兼容模式：编辑仍写入知识库缓存）';
}

/**
 * 设置写模式。
 * @param {'project'|'legacy'|'readonly'} next
 * @param {string} [why] 人类可读原因（显示在只读徽标 title 上）
 * @returns {{ ok: boolean, mode: string, error?: string }}
 */
export function setWriteMode(next, why = '') {
  if (!WRITE_MODES.includes(next)) {
    console.warn(`[writeGate] 未知写模式：${next}（忽略）`);
    return { ok: false, mode: mode.value, error: `未知写模式：${next}` };
  }
  mode.value = next;
  reason.value = why || '';
  return { ok: true, mode: next };
}

/** 回到「无项目」时的默认模式（项目关闭时调用） */
export function resetWriteMode(why = '') {
  return setWriteMode(defaultModeWithoutProject(), why);
}

/** 当前是否允许落盘写（不产生副作用，供 UI 判断） */
export function canWrite() {
  return mode.value !== 'readonly';
}

/**
 * 落盘写守卫 —— 所有世界观数据落盘路径的唯一入口。
 * @param {string} [action] 动作名（用于错误信息，如「保存地理数据」）
 * @returns {{ ok: true } | { ok: false, readOnly: true, error: string }}
 */
export function guardWrite(action = '写操作') {
  if (mode.value === 'readonly') {
    return { ok: false, readOnly: true, error: `${action}被拒绝：${WRITE_BLOCKED_HINT}` };
  }
  return { ok: true };
}

// 调试/测试用：读取完整状态
export function describeWriteGate() {
  return { mode: mode.value, readOnly: isReadOnly.value, reason: writeModeReason.value, canWrite: canWrite() };
}
