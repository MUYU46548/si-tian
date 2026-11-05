// interaction/markers.js — 剧本视图（N1.5 拆分，2026-11-02）
//
// 由 `build/_n15.cjs` 从 ScenarioMap.vue **逐字搬出**（只搬函数 + `labelDetailState` 这个
// 只被 `labelDetailNow` 读写的档位滞回状态）：
//   mapVisibleRatio / labelDetailNow / labelScaleNow / findMarkerAt / closeMarkerEditor / openMarkerEditor /
//   refreshSelectedMarker / markerRefOf / applyMarkerPatch / onMarkerNameChange /
//   onMarkerTypeChange / onMarkerCoordChange / deleteSelectedMarker /
//   deriveLayers / openBurgEditor / closeBurgEditor / onHistoryJump。
// 依赖约定：`ctx` = 组件侧传入的 ref / 函数 / 常量（搬出后仍读写同名同一份）；
//   纯函数工具直接 import。
//
// ⚠️ 留在 SFC 的：`selectedMarker` / `selectedMarkerIndex` / `showMarkerPanel` 三个 ref
//   （模板直接读写）、`markerCoords` / `markerTotal` / `markerOrdinal` 三个 computed、
//   以及 6801 行那三条 `watch`（注册顺序是行为的一部分）。

import { hitMarker, markerIdentity, markerIndexOf, MARKER_HIT_RADIUS_PX } from '../../utils/markerHitTest';
import { zoomDetail, labelFontScale } from '../../utils/labelZoom';
import { normalizeNotePath } from '../../utils/noteBinding';

export function createMarkerActions(ctx) {
  const {
    MARKER_TYPES,
    MIN_CAMERA_SCALE,
    baseMap,
    baseMapKey,
    burgEditorOpen,
    cameraScale,
    canvas,
    contextMenu,
    cw,
    editingBurg,
    mapWorldSize,
    markerCoords,
    pruneProvinceSelection,
    render,
    selectedMarker,
    selectedMarkerIndex,
    selectedProvince,
    selectedScenario,
    showMarkerPanel,
    showProps,
    statusMsg,
    store,
    viewMode,
  } = ctx;

function mapVisibleRatio() {
  const { w } = mapWorldSize();
  const cvsW = cw() || canvas.value?.clientWidth || 0;
  const scale = Math.max(cameraScale.value, MIN_CAMERA_SCALE);
  if (!w || !cvsW) return 1;
  return (cvsW / scale) / w;
}

let labelDetailState = { key: '', detail: null };

/** 当前详略档位（close / near / mid / far；带滞回，抗滚轮边界抖动） */
function labelDetailNow() {
  const key = baseMapKey.value || '';
  // 换底图 → 重新起算（否则新图会沿用上一张图的档位滞回状态）
  if (labelDetailState.key !== key) labelDetailState = { key, detail: null };
  const detail = zoomDetail(mapVisibleRatio(), labelDetailState.detail);
  labelDetailState = { key, detail };
  return detail;
}

function labelScaleNow() {
  return labelFontScale(mapVisibleRatio());
}

function findMarkerAt(world) {
  const list = selectedScenario.value?.markers || [];
  if (!list.length) return null;
  const tol = MARKER_HIT_RADIUS_PX / Math.max(1e-6, cameraScale.value || 1);
  return hitMarker(list, world.x, world.y, tol);
}

function closeMarkerEditor() {
  if (!selectedMarker.value && !showMarkerPanel.value) return;
  selectedMarker.value = null;
  selectedMarkerIndex.value = -1;
  showMarkerPanel.value = false;
}

function openMarkerEditor(marker, index) {
  if (!marker) return;
  selectedMarker.value = marker;
  selectedMarkerIndex.value = Number.isInteger(index) ? index : -1;
  showMarkerPanel.value = true;
  selectedProvince.value = null;
  showProps.value = false;
  contextMenu.value.show = false;
  statusMsg(`已选中标记“${marker.name || '（未命名标记）'}”—— 面板里可改名 / 改类型 / 改坐标 / 删除，`
    + '下面“资料”按名字只读检索库内词条');
}

function refreshSelectedMarker() {
  const cur = selectedMarker.value;
  if (!cur) return;
  const list = selectedScenario.value?.markers || [];
  const idx = markerIndexOf(list, markerIdentity(cur, selectedMarkerIndex.value));
  if (idx < 0) { closeMarkerEditor(); return; }
  selectedMarkerIndex.value = idx;
  if (list[idx] !== cur) selectedMarker.value = list[idx];
}

function markerRefOf() {
  const cur = selectedMarker.value;
  if (!cur) return null;
  return markerIdentity(cur, selectedMarkerIndex.value);
}

/**
 * 改标记的一个写口（名字 / 类型 / 坐标都走这里 → store 一条 undo + 写闸门）。
 * @returns {boolean} 是否真的改了（只读 / 非法值 / 找不到目标时为 false，**且什么都不写**）
 */
function applyMarkerPatch(patch) {
  const sc = selectedScenario.value;
  if (!sc || !selectedMarker.value) return false;
  if (store.isReadOnly) {
    statusMsg(`改标记已停用：${store.readOnlyReason || '只读：未打开项目'}`);
    return false;
  }
  const res = store.updateScenarioMarker(sc.id, markerRefOf(), patch);
  if (!res || res.ok === false) {
    statusMsg(`改标记失败（${(res && res.reason) || '未知原因'}）—— 数据没有变`);
    return false;
  }
  selectedMarker.value = res.marker;
  render();
  return true;
}

function onMarkerNameChange(e) {
  const name = String(e.target.value || '').trim();
  if (!name) {
    e.target.value = selectedMarker.value?.name || '';
    statusMsg('标记名不能留空 —— 已恢复原值（没写任何东西）');
    return;
  }
  if (applyMarkerPatch({ name })) statusMsg(`标记已改名“${name}”（可 Ctrl+Z 撤回）`);
}

function onMarkerTypeChange(e) {
  const def = MARKER_TYPES.find(t => t.id === String(e.target.value || '')) || MARKER_TYPES[0];
  // 图标/颜色跟着类型走：画布按 m.icon / m.color 渲染，只改 type 会"类型变了、图标没变"
  if (applyMarkerPatch({ type: def.id, icon: def.icon, color: def.color })) {
    statusMsg(`标记类型已改为“${def.name}”（可 Ctrl+Z 撤回）`);
  }
}

function onMarkerCoordChange(axis, e) {
  // ⚠️ `Number('') === 0` —— 输入框被清空时必须判为非法，不能"顺手把坐标写成 0"
  //    （那会是一个用户没打算执行的静默移动）
  const raw = String(e.target.value == null ? '' : e.target.value).trim();
  const v = raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(v)) {
    e.target.value = markerCoords.value[axis];
    statusMsg('坐标必须是有限数字 —— 已恢复原值（没写任何东西）');
    return;
  }
  if (applyMarkerPatch({ [axis]: v })) statusMsg(`标记坐标 ${axis.toUpperCase()} → ${v}（可 Ctrl+Z 撤回）`);
}

function deleteSelectedMarker() {
  const sc = selectedScenario.value;
  const cur = selectedMarker.value;
  if (!sc || !cur) return;
  if (store.isReadOnly) { statusMsg(`删除标记已停用：${store.readOnlyReason || '只读：未打开项目'}`); return; }
  const name = cur.name || '（未命名标记）';
  const res = store.removeScenarioMarker(sc.id, markerRefOf());
  if (!res || res.ok === false) { statusMsg(`删除标记失败（${(res && res.reason) || '未知原因'}）`); return; }
  closeMarkerEditor();
  statusMsg(`已删除标记“${name}”（可 Ctrl+Z 撤回；底图与省份一个都没动）`);
  render();
}

// placeSmartBurg 已搬到 actions.js（2026-10-31）

// ===== B1（2026-11-05）：标记 / 剧本 ↔ 资料笔记的绑定 =====
// 为什么放在这里：两者都长在**当前剧本**上（标记是 `scenario.markers[i]`、剧本是 `scenario.notePath`），
// 写口也都是 `store.updateScenarioMarker` / `store.setScenarioNotePath`（各一条 undo）。
// 组件侧（`VaultLoreSection` 的 `binding` 形态）只显示与转发，**不写数据** —— 这一层是唯一的落地点。
// 返回形状统一 `{ ok, error? }`：面板要能直接显示拒绝原因，不能"点了没反应"。

/** 标记绑一篇笔记（`hit` 是读料候选行，取它的 `path`） */
function bindMarkerNote(hit) {
  const sc = selectedScenario.value;
  if (!sc || !selectedMarker.value) return { ok: false, error: '没有选中的标记' };
  const path = normalizeNotePath((hit && (hit.path || hit.sourcePath)) || '');
  if (!path) return { ok: false, error: '这条候选没有路径，绑不了（换一条试试）' };
  const res = store.updateScenarioMarker(sc.id, markerRefOf(), { notePath: path });
  if (!res || res.ok === false) return { ok: false, error: `绑定失败（${(res && res.reason) || '未知原因'}）` };
  selectedMarker.value = res.marker;
  statusMsg(`已把这个标记绑到“${path}”（可 Ctrl+Z 撤回）`);
  render();
  return { ok: true, notePath: path };
}

function unbindMarkerNote() {
  const sc = selectedScenario.value;
  if (!sc || !selectedMarker.value) return { ok: false, error: '没有选中的标记' };
  const res = store.updateScenarioMarker(sc.id, markerRefOf(), { notePath: '' });
  if (!res || res.ok === false) return { ok: false, error: `解绑失败（${(res && res.reason) || '未知原因'}）` };
  selectedMarker.value = res.marker;
  statusMsg('已解除这个标记的笔记绑定（可 Ctrl+Z 撤回）');
  render();
  return { ok: true };
}

/** 剧本绑一篇笔记（写 `scenario.notePath`；与标记同一条 undo 纪律） */
function bindScenarioNote(hit) {
  const sc = selectedScenario.value;
  if (!sc) return { ok: false, error: '还没有选中剧本' };
  const path = normalizeNotePath((hit && (hit.path || hit.sourcePath)) || '');
  if (!path) return { ok: false, error: '这条候选没有路径，绑不了（换一条试试）' };
  const res = store.setScenarioNotePath(sc.id, path);
  if (!res || res.ok === false) return { ok: false, error: `绑定失败（${(res && res.reason) || '未知原因'}）` };
  statusMsg(`已把剧本“${sc.name || sc.id}”绑到“${path}”（可 Ctrl+Z 撤回）`);
  render();
  return res;
}

function unbindScenarioNote() {
  const sc = selectedScenario.value;
  if (!sc) return { ok: false, error: '还没有选中剧本' };
  const res = store.setScenarioNotePath(sc.id, '');
  if (!res || res.ok === false) return { ok: false, error: `解绑失败（${(res && res.reason) || '未知原因'}）` };
  statusMsg('已解除这个剧本的笔记绑定（可 Ctrl+Z 撤回）');
  render();
  return res;
}


function openBurgEditor(burg) {
  editingBurg.value = { ...burg };
  burgEditorOpen.value = true;
}

// saveBurgEditor 已搬到 actions.js（2026-10-31）


function closeBurgEditor() {
  burgEditorOpen.value = false;
  editingBurg.value = null;
}

// generateAndShowRivers 已搬到 rivers.js（2026-10-31）


function deriveLayers() {
  store.deriveAllLayers(baseMapKey.value);
  render();
}

function onHistoryJump() {
  // 撤销/重做后重新对齐选中引用（updateBaseProvince 会生成新对象）
  const sp = selectedProvince.value;
  if (sp) {
    const fresh = baseMap.value?.terrain?.find(p => p.id === sp.id);
    if (fresh && fresh !== sp) selectedProvince.value = fresh;
  }
  pruneProvinceSelection();     // 省份表变了 → 多选集合里已不存在的 id 必须剔除
  render();
}

  return {
    mapVisibleRatio,
    labelDetailNow,
    labelScaleNow,
    findMarkerAt,
    closeMarkerEditor,
    openMarkerEditor,
    refreshSelectedMarker,
    markerRefOf,
    applyMarkerPatch,
    onMarkerNameChange,
    onMarkerTypeChange,
    onMarkerCoordChange,
    deleteSelectedMarker,
    deriveLayers,
    openBurgEditor,
    closeBurgEditor,
    onHistoryJump,
    // B1：标记 / 剧本 ↔ 笔记（VaultLoreSection 的 binding 写口）
    bindMarkerNote,
    unbindMarkerNote,
    bindScenarioNote,
    unbindScenarioNote,
  };
}
