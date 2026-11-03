// interaction/transfer.js — 剧本视图（N1.5 拆分，2026-11-02）
//
// 由 `build/_n15.cjs` 从 ScenarioMap.vue **逐字搬出**（只搬函数）：onRunSliceExport /
// importScenariosJson / fmtSrcBytes / fmtSrcTime / openReimportDialog / closeReimportDialog /
// describeBaseMapMissing。
// 依赖约定：`st` = 组件侧那个“普通 let 的 get/set 门面”（`pendingReimportBundle` 是裸 `let`，
//   直接传值只会拷一份 —— 与 pointerState 同一条纪律）；其余 ref / const / 函数走 `ctx`；
//   纯函数工具直接 import。
//
// ⚠️ 留在这里不搬的：`exportTerrainSnapshot` / `exportSeaSnapshot` —— 它们在 setup 期就被
//   `useScenarioExport(...)` 的配置对象按名引用（那行在本模块工厂之前求值），搬出来会是 TDZ。

import { hasHeightmapContent } from '../../utils/terrainRepresentation';

export function createTransferActions(ctx) {
  const { st, ...rest } = ctx;
  const {
    exportSliceFrames,
    groupNameNow,
    pickScenariosJson,
    reimportDialog,
    sliceExportBusy,
    slicePoints,
    statusMsg,
    store,
  } = rest;

async function onRunSliceExport({ png = false, scale = 2, era = null } = {}) {
  if (sliceExportBusy.value) return;
  sliceExportBusy.value = true;
  try {
    // `era` = 对话框选的范围（本剧本 / 本剧本集全部）；过滤在 utils/scenarioSlices 的唯一实现里
    const r = await exportSliceFrames({ png, scale, era, slicePoints: slicePoints.value, groupName: groupNameNow.value });
    // 失败/取消的回音由 exportStatus 承担（对话框里也显示同一份），这里只补一条可点名的结论
    if (r && r.success === false && !r.canceled) statusMsg(`切片导出失败：${r.error || '未知错误'}`);
    else if (r && r.canceled) statusMsg('已取消切片导出');
  } finally {
    sliceExportBusy.value = false;
  }
}

function importScenariosJson(mode) {
  return pickScenariosJson({ mode });
}

function fmtSrcBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1048576) return `${(b / 1048576).toFixed(1)}MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)}KB`;
  return `${b}B`;
}

function fmtSrcTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 019 重导对话框（2026-10-25）：先把映射统计/冲突摆出来，再让用户点“重导并迁移”。
 * 预览走 `store.previewReimportBasemap`（只读），真正写盘在 `applyReimportDialog`。
 */
function openReimportDialog(oldKey, bundle, fileName = '') {
  const preview = store.previewReimportBasemap(oldKey, bundle);
  if (!preview || !preview.ok) {
    statusMsg(`重导预检失败：${(preview && preview.message) || '未知原因'}`);
    return;
  }
  st.pendingReimportBundle = bundle;
  reimportDialog.value = {
    oldKey,
    fileName,
    preview,
    copyReferenceImages: false,
  };
}

function closeReimportDialog() {
  reimportDialog.value = null;
  st.pendingReimportBundle = null;
}

/**
 * 底图级"缺什么"清单（渲染/提示共用；判定口径与 store 的 `updateBaseMapData` 一致）。
 * ⚠️ 绑定了行星的底图**不算缺高度图** —— 那时高度图的家在行星侧，底图侧本来就不该有。
 */
function describeBaseMapMissing(bm, bundle) {
  if (!bm) return [];
  const missing = [];
  const bound = store.getBoundPlanetId ? store.getBoundPlanetId(bm.id) : (bm.planetId || null);
  // ⚠️ 判"这张底图有没有地形"必须用**地形内容**口径（`hasHeightmapContent`），不能只看
  //    `heightmap` 这个键在不在、也不能用 `hasGrid`（后者是"能否开始用笔刷编辑"，
  //    会放过"有点、无 h"的空壳 —— 那正是把纯色图报成"有地形"的原因；test_96 守）。
  const bundleHasTerrain = hasHeightmapContent(bundle?.heightmap);
  if (bundleHasTerrain && !hasHeightmapContent(bm.heightmap) && !bound) missing.push('地形高度图');
  if ((bundle?.rivers || []).length && !(bm.rivers || []).length) missing.push('河流');
  if ((bundle?.routes || []).length && !(bm.routes || []).length) missing.push('道路');
  if ((bundle?.burgs || []).length && !(bm.burgs || []).length) missing.push('城镇');
  return missing;
}

  return {
    onRunSliceExport,
    importScenariosJson,
    fmtSrcBytes,
    fmtSrcTime,
    openReimportDialog,
    closeReimportDialog,
    describeBaseMapMissing,
  };
}
