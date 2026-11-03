// interaction/terrainPanels.js — 剧本视图（N1.5 拆分，2026-11-02）
//
// 由 `build/_n15.cjs` 从 ScenarioMap.vue **逐字搬出**（只搬函数 + `capsuleTimer` 这一个
// 只被 `pokeCapsule` 读写的裸 `let`）：底图编辑模式 / 地形生成与注记面板 / 造陆 / 派生 /
// 高度图分辨率 / 地形来源绑定行星 / 小地图 / 换底图 / 图层锁。
// 依赖约定：`ctx` = 组件侧传入的 ref / 函数（搬出后仍读写同名同一份）。
//
// ⚠️ 留在 SFC 的：各面板开关 ref（`terrainGenOpen` / `fmgOpen` / `terrainLabelsOpen` /
//   `landmassOpen` / `deriveOpen` / `resampleOpen` / `basemapEditMode` / `immersive` /
//   `showMinimap` / `capsuleDim`）—— 模板直接读写它们，且它们不是本模块的状态机。

export function createTerrainPanelActions(ctx) {
  const {
    availablePlanets,
    baseMap,
    baseMapKey,
    basemapEditMode,
    capsuleDim,
    contextMenu,
    deriveOpen,
    emit,
    fmgOpen,
    immersive,
    landmassOpen,
    moreOpen,
    pickPlanetId,
    rasterCache,
    rasterLayer,
    render,
    resampleFactor,
    resampleOpen,
    resetTimelineToStart,
    scenarioLayers,
    selectScenario,
    selectedPolity,
    selectedProvince,
    selectedScenario,
    showMinimap,
    showProps,
    smoothRadius,
    sortedScenarios,
    statusMsg,
    store,
    terrainGenOpen,
    terrainLabelPick,
    terrainLabelsOpen,
  } = ctx;

function toggleBasemapEditMode() {
  basemapEditMode.value = !basemapEditMode.value;  // 🔴 开模式**顺手收起“更多”**（2026-10-18 第十七修·出图实测）：
  //    第一版是"开模式就展开“更多”"，结果工具栏从 ~120px 撑到 **~470px**（出图
  //    `docs/assets/basemap-mode-20261018/02-basemap-edit-mode.png` 一眼可见）——
  //    画布被压掉一半，而"模式分区"的收益全被这个面板吃掉了。
  //    地理类工具**已经在模式行里**；“更多”里的那几件（参考图 / 自带-自动河源 / 着色档 / 吸附）
  //    是**进阶开关**，想用再点开。同理：`setTool` 的自动开模式更不该碰 `moreOpen`
  //    （那会让"切一下工具"就展开 42vh 面板，实测把 `test_61` 的画布内容判空判红）。
  if (basemapEditMode.value) moreOpen.value = false;
  statusMsg(basemapEditMode.value
    ? '已进入底图编辑模式 —— 这一行是画地理；关掉它回到日常剧本编辑'
    : '已退出底图编辑模式 —— 回到日常剧本编辑（省份 / 归属 / 剧本）');
}

/**
 * 左上角“返回”：**先退子模式，再退模块**（2026-10-21，暮雨实测误触）。
 *
 * 旧行为：底图编辑里点“← 返回”→ 直接 `exit`，整个历史剧本被退掉。
 * 新行为：
 *   · 底图编辑中 → 只关底图编辑，留在历史剧本（按钮显示“← 返回日常”）；
 *   · 日常态   → 才退出历史剧本（按钮显示“← 退出剧本”）。
 * 模块级退出另有顶部“世界观”页签，这里不再是唯一出口。
 */
function onBackClick() {
  if (basemapEditMode.value) {
    basemapEditMode.value = false;
    statusMsg('已退出底图编辑 —— 回到日常剧本编辑（历史剧本还在；要离开请点“← 退出剧本”或顶部“世界观”）');
    render();
    return;
  }
  emit('exit');
}

function toggleTerrainGenPanel() {
  if (!baseMapKey.value) { statusMsg('先选一张底图'); return; }
  terrainGenOpen.value = !terrainGenOpen.value;
}

function toggleTerrainLabelsPanel() {
  if (!baseMapKey.value) { statusMsg('先选一张底图'); return; }
  terrainLabelsOpen.value = !terrainLabelsOpen.value;
}

function applyTerrainLabelsResult(msg) {
  statusMsg(msg || '地形注记已保存');
  render();
}

/**
 * “地形名”勾选（2026-10-27 用户 A2/B2：“勾了地形名完全看不见”）。
 *
 * 真相：这张底图 `terrainLabels = 0` —— 地形注记是**用户命名**的数据（检测山脊候选或手绘），
 * 没有名字就没有东西可画。旧界面勾上后**一声不响**，看起来像渲染坏了。
 * 现在：勾上且一条都没有 → 直接把“地形注记”面板打开并说清下一步。
 */
function onTerrainNamesToggle(e) {
  const on = !!(e && e.target && e.target.checked);
  if (!on) { render(); return; }
  const n = (baseMap.value?.terrainLabels || []).length;
  if (n === 0) {
    if (baseMapKey.value) terrainLabelsOpen.value = true;
    statusMsg('这张底图还没有地形注记（0 条）—— 已打开“地形注记”面板：点“检测山脊”或用“画山系 / 画海域 / 点平原”自己画一条，命名后“应用”');
  }
  render();
}

function startTerrainLabelPick(kind) {
  if (!baseMapKey.value) { statusMsg('先选一张底图'); return; }
  if (store.isReadOnly) { statusMsg(`地形注记已停用：${store.readOnlyReason}`); return; }
  const k = ['range', 'sea', 'plain'].includes(kind) ? kind : 'range';
  terrainLabelPick.value = { kind: k, points: [], dragging: false, finished: false };
  statusMsg(k === 'plain' ? '平原注记：在地图上点一下落个点' : '在地图上拖一条线（松开鼠标完成）');
  render();
}

function clearTerrainLabelPick(msg) {
  terrainLabelPick.value = null;
  if (msg) statusMsg(msg);
  render();
}

function onTerrainLabelPickDone() {
  clearTerrainLabelPick('');
}

function cancelTerrainLabelPick() {
  clearTerrainLabelPick('已取消手绘注记（数据未改）');
}

function applyGeneratedTerrain(r) {
  rasterCache.clear();
  rasterLayer.value = 'height';
  // 两个引擎（按轮廓推演 / FMG 模板）共用一个收口：谁应用完都关面板、切高度档、递回执
  terrainGenOpen.value = false;
  fmgOpen.value = false;
  statusMsg((r && r.message) || '已生成地形');
  render();
}

function toggleLandmassPanel() {
  if (!baseMapKey.value) { statusMsg('先选一张底图'); return; }
  landmassOpen.value = !landmassOpen.value;
}

function toggleDerivePanel() {
  if (!baseMapKey.value) { statusMsg('先选一张底图'); return; }
  deriveOpen.value = !deriveOpen.value;
}

function onDerived(r, kind) {
  if (kind === 'culture') rasterCache.clear();
  statusMsg((r && r.message) || '已派生');
  render();
}

function openResamplePanel() {
  resampleOpen.value = !resampleOpen.value;
}

function applyResample() {
  const r = store.resampleBaseMapHeightmap(baseMapKey.value, resampleFactor.value);
  if (!r || r.ok === false) { statusMsg((r && r.message) || '调整分辨率失败'); return; }
  resampleOpen.value = false;
  // ⚠️ 这里**刻意不手写 `rasterCache.clear()`**：格数/内容变了，高度图对象引用就变了，
  //    而栅格缓存的键里含这个引用（见 `getRaster`）→ 自己就失效了。
  //    手写 clear 是"两处都要记得改"的双源（本项目反复踩的那类）。
  statusMsg(r.message + ' —— 已重建，可用 Ctrl+Z 撤销');
  render();
}

function applySmooth() {
  const r = store.smoothBaseMapHeightmap(baseMapKey.value, { radius: smoothRadius.value, passes: 1 });
  if (!r || r.ok === false) { statusMsg((r && r.message) || '平滑失败'); return; }
  statusMsg(r.message);
  render();
}

function planetNameById(id) {
  return availablePlanets.value.find(p => p.id === id)?.name || id;
}

function freezeTerrainFromPlanet() {
  const pid = pickPlanetId.value;
  if (!pid) return;
  const name = planetNameById(pid);
  let r = store.importHeightmapFromPlanet(baseMapKey.value, pid, { planetName: name });
  if (r && r.conflict) {
    if (!window.confirm(r.error)) { statusMsg('已取消导入（保留了原地形）'); return; }
    r = store.importHeightmapFromPlanet(baseMapKey.value, pid, { force: true, planetName: name });
  }
  if (!r || r.ok === false) { statusMsg((r && r.error) || '导入地形失败'); return; }
  statusMsg(`已冻结导入“${name}”的地形（${r.cellsX}×${r.cellsY}，${r.cells} 格）—— 这是独立副本，之后行星改地形不会影响它`);
  render();
}

function bindTerrainToPlanet() {
  const pid = pickPlanetId.value;
  if (!pid) return;
  const name = planetNameById(pid);
  const okGo = window.confirm(
    `让“${baseMapKey.value}”跟随“${name}”的地形？\n\n`
    + '跟随 = 两边共用同一份：在剧本里涂山会改到行星，行星改地形也会改到这张剧本。\n\n'
    + '如果这是要长期存档的历史剧本，请改用“冻结导入”（复制一份、互不影响）。'
  );
  if (!okGo) return;
  const r = store.bindBaseMapToPlanet(baseMapKey.value, pid);
  if (!r || r.ok === false) { statusMsg((r && r.error) || '跟随失败'); return; }
  statusMsg(`已跟随“${name}”的地形 —— 现在两边是同一份：在剧本里编辑会改到那颗行星`);
  render();
}

function unbindTerrainFromPlanet() {
  const okGo = window.confirm(
    '解除跟随？\n\n行星那份地形不受影响；这张底图会回到“没有地形”（可再用“冻结导入”拿一份独立副本）。'
  );
  if (!okGo) return;
  const r = store.unbindBaseMap(baseMapKey.value);
  if (!r || r.ok === false) { statusMsg((r && r.error) || '解绑失败'); return; }
  statusMsg('已解除跟随 —— 行星那份没动；可用“冻结导入”从行星拿一份独立副本');
  render();
}

let capsuleTimer = 0;
function pokeCapsule() {
  if (!immersive.value) return;
  capsuleDim.value = false;
  clearTimeout(capsuleTimer);
  capsuleTimer = setTimeout(() => { capsuleDim.value = true; }, 8000);
}

function toggleMinimap() {
  showMinimap.value = !showMinimap.value;
  try { localStorage.setItem('sitian-scenario-minimap', showMinimap.value ? '1' : '0'); } catch { /* 隐私模式 */ }
  render();
}

// 底图切换（P2 方案A：切换底图 = 切换剧本集）
async function onBaseMapChange() {
  // 清空当前选中态（避免引用旧底图数据）
  selectedProvince.value = null;
  selectedScenario.value = null;
  selectedPolity.value = null;
  showProps.value = false;
  contextMenu.value.show = false;
  rasterCache.clear();

  // 持久化当前底图键
  if (window.sitianAPI?.setCurrentBaseMapKey) {
    await window.sitianAPI.setCurrentBaseMapKey(baseMapKey.value);
  }

  // 自动选中该底图下的第一个剧本
  const first = sortedScenarios.value[0];
  resetTimelineToStart();
  if (first) {
    selectScenario(first);
  } else {
    render();
  }
}

function toggleLayerLock(layerId) {
  const layer = scenarioLayers.value[layerId];
  if (layer) {
    layer.locked = !layer.locked;
  }
}

  return {
    toggleBasemapEditMode,
    onBackClick,
    toggleTerrainGenPanel,
    toggleTerrainLabelsPanel,
    applyTerrainLabelsResult,
    onTerrainNamesToggle,
    startTerrainLabelPick,
    clearTerrainLabelPick,
    onTerrainLabelPickDone,
    cancelTerrainLabelPick,
    applyGeneratedTerrain,
    toggleLandmassPanel,
    toggleDerivePanel,
    onDerived,
    openResamplePanel,
    applyResample,
    applySmooth,
    planetNameById,
    freezeTerrainFromPlanet,
    bindTerrainToPlanet,
    unbindTerrainFromPlanet,
    pokeCapsule,
    toggleMinimap,
    onBaseMapChange,
    toggleLayerLock,
  };
}
