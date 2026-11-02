// interaction/polityPalette.js — 剧本视图（N1.5 拆分，2026-11-02）
//
// 由 `build/_n15.cjs` 从 ScenarioMap.vue **逐字搬出**（只搬函数）：selectPolity /
// selectClearOwnership / nextOwnerStrokeId / ownerBrushWorldRadius / ownerHitProvinceIds /
// updateSelectedPolity / onPolityNameChange / onAddPolity / onPolityColorChange /
// onPolityAbbrChange / onSetPolityLineage / batchEcho / onBatchAssign / onBatchClear /
// onSelectAllLand / assignSelectedProvinceOwner / clearSelectedProvinceOwner。
// 依赖约定：`ctx` = 组件侧传入的 ref / 函数（搬出后仍读写同名同一份）；
//   纯函数工具直接 import（本文件暂无）。
//
// ⚠️ 留在 SFC 的：势力色板自己的 `selectedPolity` / `clearOwnerMode` ref（模板大量读写）、
//   `ownerStrokeIds` / `ownerLastSample`（pointerState 的 get/set 门面指着它们）、
//   `ownerStrokeSample`（唯一读 `ownerStrokeIds` 的那个，留在原地免改门面）。
//   `ownerStrokeId` 只被 `nextOwnerStrokeId` 读写（pointerState 从来没有它的门面，
//   `actions.js` 里 `st.ownerStrokeId` 恒为 undefined —— 这是**既有行为**，搬动不许改）。

export function createPolityActions(ctx) {
  const {
    askText,
    cameraScale,
    clearOwnerMode,
    findProvinceAt,
    provBrushRadius,
    render,
    selectedLandProvinces,
    selectedPolity,
    selectedProvince,
    selectedProvinceIds,
    selectedScenario,
    statusMsg,
    store,
    tlDate,
    tlDateText,
  } = ctx;

function selectPolity(p) {
  selectedPolity.value = p || null;
  if (p) clearOwnerMode.value = false;
}

/** 色板 ✕：进入「清除归属」模式（把涂到的省改成无主，而不是涂错颜色） */
function selectClearOwnership() {
  selectedPolity.value = null;
  clearOwnerMode.value = true;
}

// 这一笔的账本身份（groupId）：按下时生成，抬手落库时带给 store → 一笔一组（第 4 件接线点）
let ownerStrokeId = '';
function nextOwnerStrokeId() {
  ownerStrokeId = `own-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
  return ownerStrokeId;
}

/** 笔刷半径（世界单位）—— 与几何笔刷同一口径：屏幕像素 / 缩放 */
function ownerBrushWorldRadius() {
  return provBrushRadius.value / Math.max(1e-6, cameraScale.value || 1);
}

/** 世界点 → 命中的陆地省 id 列表（海域不算：海不参与势力归属） */
function ownerHitProvinceIds(wx, wy) {
  const r = ownerBrushWorldRadius();
  const offsets = [[0, 0], [0.65, 0], [-0.65, 0], [0, 0.65], [0, -0.65]];
  const out = [];
  const seen = new Set();
  for (const [dx, dy] of offsets) {
    const p = findProvinceAt(wx + dx * r, wy + dy * r);
    if (!p || p.kind === 'sea') continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p.id);
  }
  return out;
}

// ── A8：势力显示信息（名称 / 简称）的编辑入口 ──────────────────────────────
// 「自定义显示的势力名称」是暮雨的原话诉求：.map 导入带来的是 FMG 的国家名，
// 用户要把它改成自己世界观里的叫法（并可另给一个缩小档用的简称）。
function updateSelectedPolity(patch, okText) {
  const polity = selectedPolity.value;
  const sc = selectedScenario.value;
  if (!polity || !sc) return;
  const r = store.updatePolity(sc.id, polity.id, patch);
  if (!r || !r.success) {
    statusMsg(r && r.reason === 'no-polity' ? '势力已不存在（可能被删除）' : '修改势力失败');
    return;
  }
  if (!r.changed) return;    // 没实质改动 → 不入 undo 栈、不提示
  statusMsg(okText);
  render();
}

function onPolityNameChange(e) {
  const polity = selectedPolity.value;
  if (!polity) return;
  const v = String(e.target.value || '').trim();
  if (!v) { e.target.value = polity.name || ''; statusMsg('势力名不能为空'); return; }
  updateSelectedPolity({ name: v }, `势力已改名：${v}`);
}

/**
 * 新建势力（2026-10-01）：补上「势力只能靠 .map 导入带进来」这个缺口 ——
 * 自建底图 + 自建剧本时 polities 为空，色板空空、油漆桶点了静默无反应。
 * 名称用 prompt（与 label/marker 的录入方式一致，不新造一套内联编辑）。
 */
async function onAddPolity() {
  const sc = selectedScenario.value;
  if (!sc) { statusMsg('先选一个剧本，再新建势力'); return; }
  if (store.isReadOnly) { statusMsg(`新建势力已停用：${store.readOnlyReason || '只读'}`); return; }
  const name = await askText({ title: '新势力名称', defaultValue: `势力 ${(sc.polities || []).length + 1}` });
  if (name === null) return;                     // 取消
  if (!String(name).trim()) { statusMsg('势力名不能为空'); return; }
  const r = store.addPolity(sc.id, { name });
  if (!r || !r.success) { statusMsg('新建势力失败'); return; }
  // 选中新势力：接着就能直接油漆桶上色（不是"建完了还得自己找"）
  const created = (store.scenarios?.[sc.id]?.polities || []).find(p => p.id === r.id) || null;
  selectedPolity.value = created;
  statusMsg(`已新建势力：${r.name}（选中它，用油漆桶 P 点省份即可指派）`);
  render();
}

function onPolityColorChange(e) {
  const v = String(e.target.value || '').trim();
  if (!v) return;
  updateSelectedPolity({ color: v }, `势力配色已改为 ${v}`);
}

function onPolityAbbrChange(e) {
  const v = String(e.target.value || '').trim();
  updateSelectedPolity({ abbr: v || null }, v ? `势力简称：${v}` : '已清除简称（缩小档回落全名）');
}

function onSetPolityLineage({ scenarioId, polityId, successorOf }) {
  store.setPolityLineage(scenarioId, polityId, { successorOf });
  render();
}

// ── 省份多选 → 批量归属（2026-10-02 接活 batchSetOwnership）─────────────────
// 回执必须点名「改了几省 / 跳过了什么」：批量操作最怕"点了没反应"或"悄悄漏掉几个"。
function batchEcho(r, verb) {
  if (!r || r.success === false) { statusMsg(`${verb}失败：${r?.reason || '未知原因'}`); return; }
  if (r.noop) { statusMsg(`${verb}：没有需要改动的省份${r.skippedSea ? `（跳过 ${r.skippedSea} 个海域省）` : ''}`); return; }
  const parts = [`${verb}：${r.changed || r.cleared} 省`];
  if (r.skippedSea) parts.push(`跳过 ${r.skippedSea} 个海域省`);
  if (r.skippedMissing) parts.push(`跳过 ${r.skippedMissing} 个不存在的省`);
  parts.push('可 Ctrl+Z 撤回');
  statusMsg(parts.join(' · '));
}

function onBatchAssign() {
  if (store.isReadOnly) { statusMsg(`批量指派已停用：${store.readOnlyReason || '只读：未打开项目'}`); return; }
  if (!selectedPolity.value) { statusMsg('批量指派：先在上面的色板里选一个势力'); return; }
  if (!selectedScenario.value) { statusMsg('批量指派：先在时间轴上选一个剧本'); return; }
  const r = store.batchSetOwnership(
    selectedScenario.value.id,
    selectedProvinceIds.value.slice(),
    selectedPolity.value.id,
    tlDate.value,
  );
  batchEcho(r, `已指派给「${selectedPolity.value.name}」`);
  render();
}

function onBatchClear() {
  if (store.isReadOnly) { statusMsg(`批量清除归属已停用：${store.readOnlyReason || '只读：未打开项目'}`); return; }
  if (!selectedScenario.value) { statusMsg('批量清除归属：先在时间轴上选一个剧本'); return; }
  const r = store.batchSetOwnership(
    selectedScenario.value.id, selectedProvinceIds.value.slice(), null,
  );
  batchEcho(r, '已清除归属');
  render();
}

function onSelectAllLand() {
  selectedProvinceIds.value = selectedLandProvinces.value.slice();
  statusMsg(`已选中当前底图的 ${selectedProvinceIds.value.length} 个陆地省（海域不参与归属，未入选）`);
  render();
}

/**
 * 属性面板里「设为当前势力 / 清成无主」—— 与油漆桶同一套 store 写口（一条 undo）。
 * 日期一律用 `tlDate`（时间轴游标 = 唯一真源），这样「看到哪年就改哪年」。
 *
 * ⚠️ 清空归属**不等于**抹掉历史：带日期的 `clearOwnership` 会在该日期写一条
 *    `owner: null` 事件（时间轴上就是「这一年这块地变成无主」），只把 `ownership`
 *    这个"终态快照键"删掉。所以文案不能说"连带删除易主事件"（2026-10-21 核对实现后改口）。
 */
function assignSelectedProvinceOwner() {
  const prov = selectedProvince.value;
  const sc = selectedScenario.value;
  if (!prov || !sc) return;
  if (prov.kind === 'sea') { statusMsg('这是海域（kind=sea）：海域不参与势力归属'); return; }
  if (!selectedPolity.value) { statusMsg('先在色板选一个势力，再点「设为当前势力」'); return; }
  if (store.isReadOnly) { statusMsg(`改归属已停用：${store.readOnlyReason || '只读：未打开项目'}`); return; }
  const wr = store.setOwnership(sc.id, prov.id, selectedPolity.value.id, tlDate.value);
  statusMsg(wr && wr.success === false
    ? `「${prov.name}」归属已改，但易主日期没记：${wr.reason}`
    : `「${prov.name}」→ ${selectedPolity.value.name}（${tlDateText.value}，可 Ctrl+Z 撤回）`);
  render();
}

function clearSelectedProvinceOwner() {
  const prov = selectedProvince.value;
  const sc = selectedScenario.value;
  if (!prov || !sc) return;
  if (store.isReadOnly) { statusMsg(`改归属已停用：${store.readOnlyReason || '只读：未打开项目'}`); return; }
  store.clearOwnership(sc.id, prov.id, tlDate.value);
  statusMsg(`已清除「${prov.name}」的势力归属 → 无主（${tlDateText.value} 起；可 Ctrl+Z 撤回）`);
  render();
}

  return {
    selectPolity,
    selectClearOwnership,
    nextOwnerStrokeId,
    ownerBrushWorldRadius,
    ownerHitProvinceIds,
    updateSelectedPolity,
    onPolityNameChange,
    onAddPolity,
    onPolityColorChange,
    onPolityAbbrChange,
    onSetPolityLineage,
    batchEcho,
    onBatchAssign,
    onBatchClear,
    onSelectAllLand,
    assignSelectedProvinceOwner,
    clearSelectedProvinceOwner,
  };
}
