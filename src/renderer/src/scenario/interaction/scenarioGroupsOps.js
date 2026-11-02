// interaction/scenarioGroups.js — 剧本视图（N1.5 拆分，2026-11-02）
//
// 由 `build/_n15.cjs` 从 ScenarioMap.vue **逐字搬出**（只搬函数）：剧本集 CRUD / 剧本迁移 /
// 删剧本 / 剧本表单（blank / 编辑转换）/ 管理对话框收口。
// 依赖约定：`ctx` = 组件侧传入的 ref / 函数（搬出后仍读写同名同一份）；
//   纯函数工具直接 import（组判定/计数只有 `utils/scenarioGroups.js` 一份实现）。
//
// ⚠️ 留在 SFC 的：`newGroupName` / `editingGroupId` / `editGroupName` / `editingScenarioId`
//   / `showScenarioManager` / `newScenario` 这些 ref（模板直读写），本模块只经 ctx 读写它们。

import { DEFAULT_SCENARIO_GROUP, scenarioGroupIdOf } from '../../utils/scenarioGroups';

export function createGroupActions(ctx) {
  const {
    activeGroupId,
    editGroupName,
    editingGroupId,
    editingScenarioId,
    groupCount,
    groupNameOf,
    newGroupName,
    newScenario,
    render,
    selectScenarioAt,
    selectedScenario,
    showScenarioManager,
    sortedScenarios,
    statusMsg,
    store,
  } = ctx;

function createGroup() {
  if (store.isReadOnly) { statusMsg(store.readOnlyReason || '只读：未打开项目'); return; }
  const name = newGroupName.value.trim();
  if (!name) return;
  const r = store.addScenarioGroup({ name });
  if (!r || !r.success) { statusMsg(`新建剧本集失败：${(r && r.error) || '未知原因'}`); return; }
  newGroupName.value = '';
  activeGroupId.value = r.group.id;
  statusMsg(`已新建剧本集「${r.group.name}」—— 新建剧本会默认落在这一组；也可在列表里把已有剧本移进来`);
  render();
}

function startRenameGroup(g) {
  if (store.isReadOnly) { statusMsg(store.readOnlyReason || '只读：未打开项目'); return; }
  editingGroupId.value = g.id;
  editGroupName.value = g.name;
}

function cancelRenameGroup() {
  editingGroupId.value = '';
  editGroupName.value = '';
}

function commitRenameGroup() {
  const id = editingGroupId.value;
  if (!id) return;
  const name = editGroupName.value.trim();
  if (!name) return;
  const r = store.renameScenarioGroup(id, name);
  if (!r || !r.success) { statusMsg(`改名失败：${(r && r.error) || '未知原因'}`); return; }
  cancelRenameGroup();
  statusMsg(`剧本集已改名为「${name}」`);
}

function deleteGroup(g) {
  if (store.isReadOnly) { statusMsg(store.readOnlyReason || '只读：未打开项目'); return; }
  const n = groupCount(g.id);
  const r = store.removeScenarioGroup(g.id);
  if (!r || !r.success) { statusMsg(`删除失败：${(r && r.error) || '未知原因'}`); return; }
  if (activeGroupId.value === g.id) activeGroupId.value = DEFAULT_SCENARIO_GROUP;
  statusMsg(n
    ? `已删除剧本集「${g.name}」—— ${n} 条剧本退回「默认」组（一条都没删，Ctrl+Z 可撤销）`
    : `已删除空剧本集「${g.name}」（Ctrl+Z 可撤销）`);
  render();
}

function moveScenarioToGroup(s, groupId) {
  if (store.isReadOnly) { statusMsg(store.readOnlyReason || '只读：未打开项目'); return; }
  const target = String(groupId || DEFAULT_SCENARIO_GROUP);
  const r = store.setScenarioGroup(s.id, target);
  if (!r || !r.success) { statusMsg(`移动失败：${(r && r.error) || '未知原因'}`); return; }
  // 移的正好是当前在看的那条 → 跟着它切组（否则地图上还是它、左栏却没它了）
  if (selectedScenario.value?.id === s.id) {
    activeGroupId.value = target;
    selectScenarioAt(store.getScenario(s.id));
  }
  statusMsg(`「${s.name}」已移到剧本集「${groupNameOf(target)}」${r.unchanged ? '（本来就在这一组）' : ''}`);
  render();
}

// createNewScenario 已搬到 actions.js（2026-10-31）


function deleteScenario(s) {
  if (!confirm(`确定删除剧本「${s.name}」？`)) return;
  store.removeScenario(s.id);
  if (selectedScenario.value?.id === s.id) {
    selectedScenario.value = sortedScenarios.value[0] || null;
  }
  render();
}

function scenarioFormBlank() {
  return {
    name: '', roman: '', label: '', startYear: '', endYear: '',
    description: '', hook: '', inherit: true,
    group: activeGroupId.value || DEFAULT_SCENARIO_GROUP,
  };
}

function scenarioToForm(s) {
  return {
    name: s.name || '',
    roman: s.era?.roman || '',
    label: s.era?.label || '',
    startYear: s.era?.startYear != null ? String(s.era.startYear) : '',
    endYear: s.era?.endYear != null ? String(s.era.endYear) : '',
    description: s.description || '',
    hook: s.hook || '',
    inherit: false,   // 编辑既有剧本时没有「继承上一时代」的语义
    group: scenarioGroupIdOf(s),
  };
}

function startEditScenario(s) {
  if (store.isReadOnly) { statusMsg(store.readOnlyReason || '只读：未打开项目'); return; }
  editingScenarioId.value = s.id;
  newScenario.value = scenarioToForm(s);
}

function cancelEditScenario() {
  editingScenarioId.value = null;
  newScenario.value = scenarioFormBlank();
}

function closeScenarioManager() {
  cancelEditScenario();
  showScenarioManager.value = false;
}

  return {
    createGroup,
    startRenameGroup,
    cancelRenameGroup,
    commitRenameGroup,
    deleteGroup,
    moveScenarioToGroup,
    deleteScenario,
    scenarioFormBlank,
    scenarioToForm,
    startEditScenario,
    cancelEditScenario,
    closeScenarioManager,
  };
}
