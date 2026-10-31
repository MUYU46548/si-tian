// interaction/actions.js — 剧本视图（N1 第三阶段批处理，2026-10-31）
//
// 由 `build/_extract_batch.mjs` 从 ScenarioMap.vue 原样搬出：exportPNG / createNewScenario / saveEditScenario / onSetChangeDate / tlFrame / placeSmartBurg / saveBurgEditor / commitOwnerStroke / commitRiverErase。
// 依赖约定：`st` = 手势/工具期的普通 `let`（组件侧带 get/set，读写同一份）；
//   其余 ref / const / 函数走 `ctxRef`；纯函数工具直接 import。

import { DEFAULT_SCENARIO_GROUP, scenarioGroupIdOf } from '../../utils/scenarioGroups';
import { changeDateStats } from '../../utils/scenarioSlices';
import { drawBackgroundLayer } from '../../scenario/layers/background';
import { drawBurgsLayer } from '../../scenario/layers/features';
import { drawProvincesLayer } from '../../scenario/layers/provinces';
import { formatDate } from '../../utils/scenarioTimeline';
import { planRiverErase } from '../../utils/riverErase';

export function createActionHandlers(api) {
  const { st, ...rest } = api;
  const {
    BURG_SIZES,
    RIVER_ERASE_RADIUS_PX,
    TL_ERA_MS,
    activeGroupId,
    allSortedScenarios,
    baseMap,
    baseMapKey,
    burgEditorOpen,
    burgs,
    cameraScale,
    cameraX,
    cameraY,
    cancelEditScenario,
    canvas,
    ch,
    clearOwnerMode,
    ctxRef: ctxRef,
    cw,
    daysInMonthOf,
    editingBurg,
    editingScenarioId,
    handDrawnRivers,
    labelLayers,
    makeLayerView,
    newScenario,
    px,
    render,
    riverEraseStroke,
    scenarioFormBlank,
    scenarios,
    selectScenario,
    selectScenarioAt,
    selectedBurgSize,
    selectedPolity,
    selectedScenario,
    showBurgs,
    showPlaceNames,
    showScenarioManager,
    statusMsg,
    store,
    timeline,
    tlDate,
    tlDateText,
    tlEra,
    tlPlaying,
  } = rest;

function exportPNG() {
  const cvs = canvas.value;
  const scale = 2;
  const offscreen = document.createElement('canvas');
  // DPR 之后 cvs.width 是设备像素 → 离屏画布必须按 **CSS 尺寸** 建，否则导出被放大 DPR 倍
  offscreen.width = Math.round(cw() * scale);
  offscreen.height = Math.round(ch() * scale);
  const ctxRef = offscreen.getContext('2d');
  ctxRef.scale(scale, scale);
  ctxRef.translate(cameraX.value, cameraY.value);
  ctxRef.scale(cameraScale.value, cameraScale.value);
  // 导出与画布**同一份 view / 同一批层函数**（N1 刀 1）——
  // 此前导出各写一套，"导出的东西画布上看不见"且不报错（M2/A2 的教训）
  const exportView = makeLayerView();
  drawBackgroundLayer(ctxRef, exportView);
  drawProvincesLayer(ctxRef, exportView);
  if (showBurgs.value) {
    drawBurgsLayer(ctxRef, makeLayerView());
    if (showPlaceNames.value) labelLayers.drawPlanned(ctxRef, makeLayerView(), ['capital', 'town']);
  }
  labelLayers.drawScenarioLabels(ctxRef, makeLayerView());
  // A8：导出必须与画布一致（M2/A2 的教训：导出各写一套 → 导出的东西画布上看不见，且不报错）
  labelLayers.drawPolity(ctxRef, makeLayerView());
  ctxRef.font = '14px "PingFang SC", sans-serif';
  ctxRef.fillStyle = 'rgba(255,255,255,0.7)';
  const scenarioName = selectedScenario?.value?.name || '未命名剧本';
  const eraLabel = selectedScenario?.value?.era?.roman || '';
  const watermark = eraLabel ? `${eraLabel} · ${scenarioName}` : scenarioName;
  ctxRef.fillText(watermark, 10, ch() - 10);
  offscreen.toBlob(async (blob) => {
    if (!blob) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result;
      const result = await window.sitianAPI.saveExportFile({ dataUrl, defaultName: `scenario-${Date.now()}.png` });
      if (!result?.success) {
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = `scenario-${Date.now()}.png`;
        a.click();
      }
    };
    reader.readAsDataURL(blob);
  }, 'image/png');
}

function createNewScenario() {
  if (!baseMapKey.value || !store.baseMaps?.[baseMapKey.value]) {
    statusMsg('新建剧本失败：还没有选中底图（先在「底图」行点「空底图」，或「＋」导入 .map）');
    return;
  }
  const targetGroup = newScenario.value.group || activeGroupId.value || DEFAULT_SCENARIO_GROUP;
  // 继承的基准必须是**目标组**里的最后一条（不是当前左栏里的最后一条 —— 表单允许落到别的组）
  const groupList = allSortedScenarios.value.filter((x) => scenarioGroupIdOf(x) === targetGroup);
  const baseScenarioId = newScenario.value.inherit && groupList.length > 0
    ? groupList[groupList.length - 1].id
    : null;
  const scenarioId = `${baseMapKey.value}/${newScenario.value.name}`;
  if (baseScenarioId) {
    store.inheritScenario(scenarioId, baseScenarioId, {
      name: newScenario.value.name,
      era: { roman: newScenario.value.roman, label: newScenario.value.label, startYear: newScenario.value.startYear, endYear: newScenario.value.endYear },
      description: newScenario.value.description,
      hook: newScenario.value.hook,
      group: targetGroup,
    });
  } else {
    store.createScenario(scenarioId, {
      ownerKey: baseMapKey.value,
      name: newScenario.value.name,
      era: { roman: newScenario.value.roman, label: newScenario.value.label, startYear: newScenario.value.startYear, endYear: newScenario.value.endYear },
      description: newScenario.value.description,
      hook: newScenario.value.hook,
      group: targetGroup,
    });
  }
  // 新剧本可能落在**另一个组**：先切过去（`scenarioFormBlank` 也读 activeGroupId，必须排在它前面）
  activeGroupId.value = targetGroup;
  newScenario.value = scenarioFormBlank();
  showScenarioManager.value = false;
  const newS = store.getScenario(scenarioId);
  if (newS) selectScenario(newS);
  else render();
}

function saveEditScenario() {
  const id = editingScenarioId.value;
  if (!id) return;
  const f = newScenario.value;
  const name = String(f.name || '').trim();
  if (!name) { statusMsg('剧本名称不能为空'); return; }
  const before = store.getScenario ? store.getScenario(id) : null;
  if (!before) { statusMsg('该剧本已不存在（可能已被删除）'); cancelEditScenario(); return; }
  const oldStart = String(before.era?.startYear ?? '');
  const oldEnd = String(before.era?.endYear ?? '');
  store.updateScenario(id, {
    name,
    era: { roman: f.roman || '', label: f.label || '', startYear: f.startYear || '', endYear: f.endYear || '' },
    description: f.description || '',
    hook: f.hook || '',
    group: f.group || DEFAULT_SCENARIO_GROUP,
  });
  // 编辑时改了组 → 跟着它切过去（否则保存后它从左栏消失，看着像被删了）
  const targetGroup = f.group || DEFAULT_SCENARIO_GROUP;
  if (targetGroup !== activeGroupId.value) {
    activeGroupId.value = targetGroup;
    const moved = store.getScenario(id);
    if (moved) selectScenarioAt(moved);
  }
  cancelEditScenario();
  // 🔴 收窄区间可能让**已录的易主日期落到区间外**（时间轴与切片都不再显示它们）——
  //    "改坏了自己却看不出来"是最坏的一类。这里复用切片对话框同一份体检函数，不另写口径。
  if (oldStart !== String(f.startYear || '') || oldEnd !== String(f.endYear || '')) {
    const st = changeDateStats(timeline.value);
    const n = (st.outOfRange || []).length;
    statusMsg(n
      ? `剧本「${name}」已保存 —— 注意：新区间下有 ${n} 条易主日期落在区间外，时间轴/切片不会显示`
      : `剧本「${name}」已保存（区间已更新，没有易主日期落到区间外）`);
  } else {
    statusMsg(`剧本「${name}」已保存`);
  }
}

function onSetChangeDate({ scenarioId, provinceId, date, done }) {
  try {
    if (store.isReadOnly) {
      statusMsg(`只读：${store.readOnlyReason || '未打开项目'} —— 易主日期未写入`);
      return;
    }
    // `date = null` 走「整列表清空」；单条日期则保留同剧本里其它事件（面板只编辑生效的那一条）
    const sc = store.scenarios?.[scenarioId];
    const existing = Array.isArray(sc?.changeEvents?.[provinceId])
      ? sc.changeEvents[provinceId].map(e => ({ y: e.y, m: e.m ?? null, d: e.d ?? null, owner: e.owner ?? null }))
      : [];
    let list;
    if (!date) {
      list = [];
    } else if (existing.length <= 1) {
      list = [{ ...date, owner: sc?.ownership?.[provinceId] ?? null }];
    } else {
      // 有历史多条事件（同省多次易主）：替换**同一天**那条，或在末尾追加
      const key = `${date.y}-${String(date.m ?? 1).padStart(2, '0')}-${String(date.d ?? 1).padStart(2, '0')}`;
      const at = existing.findIndex(e => `${e.y}-${String(e.m ?? 1).padStart(2, '0')}-${String(e.d ?? 1).padStart(2, '0')}` === key);
      list = existing.slice();
      const rec = { ...date, owner: sc?.ownership?.[provinceId] ?? null };
      if (at >= 0) list[at] = rec; else list.push(rec);
    }
    const r = store.setChangeEvents(scenarioId, provinceId, list);
    if (!r || r.success === false) {
      statusMsg(`易主日期未写入：${r?.reason || '未知原因'}`);
      return;
    }
    if (r.noop) statusMsg('易主日期没有变化');
    else if (!date) statusMsg('已清除该省的显式易主日期（回到自动推算）');
    else statusMsg(`易主日期已设为 ${formatDate(date)}${r.changed > 1 ? `（本剧本内共 ${r.changed} 条事件）` : ''}（可 Ctrl+Z 撤回）`);
    render();
  } finally {
    if (typeof done === 'function') done();
  }
}

function tlFrame(t) {
  const dt = Math.min(64, t - st.tlLastT);
  st.tlLastT = t;
  if (!tlPlaying.value) { st.tlRafId = null; return; }
  const n = timeline.value.years.length;
  if (!n) { tlPlaying.value = false; st.tlRafId = null; return; }
  st.tlPlayT += dt / TL_ERA_MS;
  // 一帧一剧本推进：年内进度走完就跳下一个剧本（3488 年按年播需 4 分钟，所以不按年播）
  while (st.tlPlayT >= 1) {
    if (tlEra.value >= n - 1) {
      tlPlaying.value = false;
      st.tlPlayT = 0;
      tlDate.value = { y: timeline.value.years[n - 1].end, m: null, d: null };
      break;
    }
    st.tlPlayT -= 1;
    tlEra.value += 1;
  }
  if (tlPlaying.value) {
    const y = timeline.value.years[tlEra.value];
    // 年内插值按**天数**线性（执行单 §1.3）：先把进度换成「年内第几天」，再落到月日
    const days = Math.max(1, y.end - y.start);
    const dayOfYear = Math.min(365, Math.max(1, Math.round(st.tlPlayT * days * 365.25 / days) + 1));
    let rest = Math.min(dayOfYear, 365);
    let m = 1;
    let d = 1;
    for (; m <= 12; m++) {
      const dim = daysInMonthOf(y.start, m);
      if (rest <= dim) { d = rest; break; }
      rest -= dim;
    }
    if (m > 12) { m = 12; d = 31; }
    tlDate.value = { y: y.start, m, d };
  }
  render();
  if (tlPlaying.value) st.tlRafId = requestAnimationFrame(tlFrame);
  else st.tlRafId = null;
}

function placeSmartBurg(world) {
  const baseMapData = baseMap.value;
  if (!baseMapData?.heightmap?.grid?.points) return;
  const hm = baseMapData.heightmap;
  const pts = hm.grid.points;
  const spacing = hm.grid.spacing || 14.4;
  const searchRadius = 100;
  let bestI = -1;
  let bestScore = -Infinity;

  for (let i = 0; i < pts.length; i++) {
    const h = hm.h[i];
    if (h < 20 || h > 70) continue;
    const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
    const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
    const clickDist = Math.hypot(px - world.x, py - world.y);
    if (clickDist > searchRadius) continue;

    let score = -Math.abs(h - 40) * 0.1 - clickDist * 0.05;
    // 靠近已有 burg 则减分（避免堆叠）
    for (const b of burgs.value) {
      const bd = Math.hypot(b.x - px, b.y - py);
      if (bd < spacing * 3) score -= 10;
    }

    if (score > bestScore) {
      bestScore = score;
      bestI = i;
    }
  }

  if (bestI >= 0) {
    const px = Array.isArray(pts[bestI]) ? pts[bestI][0] : pts[bestI].x;
    const py = Array.isArray(pts[bestI]) ? pts[bestI][1] : pts[bestI].y;
    const burgId = `burg_${Date.now()}`;
    if (!baseMapData.burgs) {
      baseMapData.burgs = [];
    }
    const sizeDef = BURG_SIZES.find(s => s.id === selectedBurgSize.value) || BURG_SIZES[1];
    const newBurg = {
      id: burgId,
      name: `新${sizeDef.name} ${baseMapData.burgs.length + 1}`,
      x: px,
      y: py,
      capital: sizeDef.id === 'capital' ? 1 : 0,
      population: sizeDef.basePop,
      size: sizeDef.id,
    };
    store.addBaseMapBurg(baseMapKey.value, newBurg);
  }
}

function saveBurgEditor() {
  if (!editingBurg.value) return;
  // D（2026-10-11）：原先这里 `Object.assign(burg, …)` + 手搓 `store.baseMaps = {...}` ——
  // 直改 store 活对象 = 绕开写闸门与撤销栈，而且"改了内存但没排保存"，
  // 只能碰巧赶上别的落盘（与手画道路同款缺陷）。现在走 store 的一条 undo。
  //
  // 🔴 2026-10-13「旧数据里的聚落」：早期 `.map` 导入只把首都写进**剧本 markers**，
  //    底图侧没有 `burgs` —— 上面那个 computed 会把 markers 派生成城镇**显示**出来，
  //    于是这些点看得见、点得开编辑器，一保存却报「这个聚落不在这张底图上」＝ 改不了。
  //    现在第一次编辑它们时，把**整批**登记成真城镇再应用这次编辑：
  //      · 只登记被编辑的那一个 → `burgs` 一旦非空，派生回退分支就不再兜底，
  //        其余几个会**从地图上凭空消失**（用户会以为"保存把我的城镇弄没了"）；
  //      · 整批登记 + 本次编辑 = **同一条 undo**（store 侧保证），Ctrl+Z 一并退回。
  const legacySeeds = (baseMap.value?.burgs || []).length ? [] : burgs.value.map((b) => ({ ...b }));
  const isLegacy = legacySeeds.some((b) => String(b.id) === String(editingBurg.value.id));
  const r = store.updateBaseMapBurg(
    baseMapKey.value, editingBurg.value.id, editingBurg.value,
    isLegacy ? { materialize: legacySeeds } : {},
  );
  if (r && r.ok) {
    if (r.materialized) {
      statusMsg(`这些聚落以前只存在旧版数据里（剧本标注）—— 已把 ${r.materialized} 个登记成底图上的城镇，`
        + `并保存了这次编辑「${editingBurg.value.name || ''}」（Ctrl+Z 可一并撤回）`);
    } else {
      statusMsg(r.changed ? `已更新聚落「${editingBurg.value.name || ''}」` : '聚落没有改动');
    }
  } else {
    statusMsg(`聚落没改成：${(r && r.message) || '未知原因'}`);
  }
  burgEditorOpen.value = false;
  editingBurg.value = null;
  render();
}

function commitOwnerStroke() {
  const ids = [...st.ownerStrokeIds];
  st.ownerStrokeActive = false;
  st.ownerStrokeIds = new Set();
  st.ownerLastSample = null;
  const sc = selectedScenario.value;
  const pol = selectedPolity.value;
  if (!ids.length) {
    statusMsg('涂归属：这一笔没有碰到陆地省份 —— 试试把半径调大，或确认点在陆地上');
    return null;
  }
  if (!sc) { statusMsg('涂归属：还没有选中剧本'); return null; }
  const clearing = clearOwnerMode.value || !pol;
  if (!clearing && !pol) { statusMsg('涂归属：没有选中的势力（点地图上方「势力：」里的色块）'); return null; }
  const res = store.batchSetOwnership(sc.id, ids, clearing ? null : pol.id, tlDate.value, {
    // 第 4 件接线点：带上这一笔的 groupId → store 会把它落成账本事件组（一笔一组）
    strokeId: st.ownerStrokeId || undefined,
  });
  if (!res || res.success === false) {
    statusMsg(`涂归属失败：${(res && res.reason) || '未知原因'}`);
    return res;
  }
  if (res.noop) {
    statusMsg(clearing
      ? `涂归属：这 ${ids.length} 个省本来就是无主`
      : `涂归属：这 ${ids.length} 个省本来就属于「${pol.name}」（${tlDateText.value}）`);
  } else {
    statusMsg(clearing
      ? `涂归属：清空 ${res.cleared} 个省的归属（无主）· 整笔 = 1 条撤销`
      : `涂归属：${res.affected} 个省份 → 「${pol.name}」（${tlDateText.value}）`
        + `${res.skippedSea ? ` · 跳过 ${res.skippedSea} 片海` : ''} · 整笔 = 1 条撤销`);
  }
  return res;
}

function commitRiverErase() {
  const stroke = (riverEraseStroke.value || []).map((p) => ({ x: p.x, y: p.y }));
  riverEraseStroke.value = [];
  if (stroke.length === 0) return null;
  const radius = px(RIVER_ERASE_RADIUS_PX);
  const targets = handDrawnRivers();          // 只擦手画的（见上方口径）
  const plan = planRiverErase(targets, stroke, radius);
  const touchedCount = plan.patches.length + plan.removes.length;
  if (!touchedCount) {
    // 空手：明确说清"为什么没反应"（而不是静默 no-op）——这是用户最容易误判成"坏了"的一种
    statusMsg('橡皮没擦到河：只擦**手画的河**（导入河与自动河不动）—— 贴着河身抹过去');
    render();
    return { ok: false, reason: 'no-hit' };
  }
  const res = store.applyBaseMapRiverEdit(baseMapKey.value, {
    patches: plan.patches, adds: plan.adds, removes: plan.removes,
  });
  if (!res || !res.ok) {
    statusMsg(`擦除没生效：${(res && res.message) || '未知原因'}`);
    render();
    return res || { ok: false };
  }
  if (!res.changed) {
    statusMsg('这一抹没有改变任何河流');
    render();
    return res;
  }
  // 回执：**说清断了几条**（用户看到画布上多出一条河时必须知道那是"擦断"而不是"多画了一条"）
  const parts = [];
  if (res.removed.length) parts.push(`擦掉 ${res.removed.length} 条`);
  if (plan.cut) parts.push(`擦断 ${plan.cut} 处（断口各自成为一条河）`);
  if (!parts.length) parts.push(`编辑 ${res.changed} 条`);
  statusMsg(`已擦除：${parts.join('、')} —— 一次擦除 = 1 条撤销`);
  render();
  return res;
}

  return { exportPNG, createNewScenario, saveEditScenario, onSetChangeDate, tlFrame, placeSmartBurg, saveBurgEditor, commitOwnerStroke, commitRiverErase };
}
