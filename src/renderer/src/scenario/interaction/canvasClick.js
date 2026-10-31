// interaction/canvasClick.js — 剧本视图（N1 第三阶段批处理，2026-10-31）
//
// 由 `build/_extract_batch.mjs` 从 ScenarioMap.vue 原样搬出：onCanvasClick / triggerMapImport / triggerCoastlineRebuild / runBatchSubdivide / openSourceRestore / restoreFromSource。
// 依赖约定：`st` = 手势/工具期的普通 `let`（组件侧带 get/set，读写同一份）；
//   其余 ref / const / 函数走 `ctx`；纯函数工具直接 import。

import { backupMapSourceFile, mapNameFromFileName } from '../../utils/mapImportSource';
import { buildScenariosJson, parseMapFile } from '../../utils/azgaar-parser';
import { findRiverSegment, hitTestRiver, insertNodeBetween } from '../../utils/rivers';
import { generateRoadPath } from '../../utils/placement';
import { isBasemapPristine } from '../../utils/basemapIdentity';

export function createCanvasClickHandlers(ctx) {
  const { st, ...rest } = ctx;
  const {
    LABEL_PRESETS,
    MARKER_TYPES,
    RELIEF_ICONS,
    RIVER_HIT_PX,
    RIVER_SELECT_HIT_PX,
    RIVER_TRACE_MIN_STEP_PX,
    ROAD_STYLES,
    activeRingIdx,
    activeVertexIdx,
    applyRiverPick,
    askText,
    baseMap,
    baseMapKey,
    batchBusy,
    batchOpts,
    batchPreviewInside,
    batchSeeds,
    batchStatus,
    burgs,
    cameraScale,
    canvas,
    clearProvinceSelection,
    clearSnapMarker,
    closeMarkerEditor,
    describeBaseMapMissing,
    drawPoints,
    findBurgAt,
    findMarkerAt,
    findProvinceAt,
    fitToView,
    fmtSrcBytes,
    handleMergeClick,
    handleSplitClick,
    hitBaseMapRiver,
    onBatchSeedClick,
    onPolySplitClick,
    openBurgEditor,
    openMarkerEditor,
    openProvinceContextMenu,
    openReimportDialog,
    polySplitKeepStart,
    provinceBrush,
    px,
    rasterLayer,
    reliefIcons,
    render,
    resolveSnapPoint,
    riverActiveNode,
    riverDraft,
    riverNodesForRender,
    riverSelIds,
    roadPath,
    roadStart,
    scenarios,
    screenToWorld,
    selectedBurg,
    selectedLabelPreset,
    selectedMarker,
    selectedMarkerType,
    selectedPolity,
    selectedProvince,
    selectedProvinceIds,
    selectedReliefIcon,
    selectedRiver,
    selectedRiverId,
    selectedRoadStyle,
    selectedScenario,
    setRiverSelection,
    setSnapMarker,
    showBurgs,
    showProps,
    showSnapFeedback,
    sourceRestoreBusy,
    sourceRestoreDir,
    sourceRestoreFiles,
    sourceRestoreLoading,
    sourceRestoreMsg,
    sourceRestoreOpen,
    statusMsg,
    store,
    terrainLabelPick,
    tlDate,
    tlDateText,
    toggleProvinceSelection,
    tool,
    viewMode,
  } = rest;

async function onCanvasClick(event) {  if (event.button === 2) {
    // 批量铺底：右键 = 去掉最近的种子点（这个工具下不需要省份右键菜单）
    if (tool.value === 'voronoi') {
      const rect = canvas.value.getBoundingClientRect();
      const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
      onBatchSeedClick(world, true);
      return;
    }
    openProvinceContextMenu(event);
    return;
  }
  // 地形注记手绘：这一击已经在 mousedown/mouseup 收口，别再落到选省/选河等分支上
  if (st.suppressTerrainPickClick || terrainLabelPick.value) { st.suppressTerrainPickClick = false; return; }
  
  const rect = canvas.value.getBoundingClientRect();
  const sx = event.clientX - rect.left;
  const sy = event.clientY - rect.top;
  const world = screenToWorld(sx, sy);

  // 涂归属：写入已在 mouseup 完成 —— 紧随的 click 不再落到别的工具分支
  if (tool.value === 'ownerBrush') return;
  // 笔刷建省（2026-10-22）：同上，建省已在 mouseup 完成（click 只可能是这一笔的尾巴）
  if (tool.value === 'provincePaint') return;

  if (tool.value === 'erase') {
    const prov = findProvinceAt(world.x, world.y);
    if (prov && confirm(`确定删除省份「${prov.name}」？\n\n该省在各剧本里的势力归属与易主年份会一并清空（可用 Ctrl+Z 整体撤回）。`)) {
      if (store.isReadOnly) { statusMsg(`删除省份已停用：${store.readOnlyReason || '只读：未打开项目'}`); return; }
      const r = store.removeBaseProvince(baseMapKey.value, prov.id);
      statusMsg(r && r.cascadedScenarios
        ? `已删除省份「${prov.name}」（连带清理 ${r.cascadedScenarios} 个剧本里的归属键，可 Ctrl+Z 撤回）`
        : `已删除省份「${prov.name}」`);
      render();
    }
    return;
  }

  if (tool.value === 'vertex') {
    // 选中省份（顶点/手柄命中已在 mousedown 处理）
    const prov = findProvinceAt(world.x, world.y);
    if (prov) {
      if (selectedProvince.value?.id !== prov.id) { activeVertexIdx.value = -1; activeRingIdx.value = 0; }
      selectedProvince.value = prov;
      showProps.value = true;
    }
    render();
    return;
  }

  if (tool.value === 'draw') {
    // 自由绘制刚一笔成型（见 onMouseUp）→ 紧随的 click 不再落顶点
    if (st.suppressDrawClick) { st.suppressDrawClick = false; return; }
    // 绘制顶点吸附：P0-T2 省份边界 > P0-T3 网格；Shift 临时禁用（验收：阈劀10px）
    const snapped = resolveSnapPoint(world, event.shiftKey);
    drawPoints.value = [...drawPoints.value, { x: snapped.x, y: snapped.y }];
    if (snapped.snapped) {
      setSnapMarker(snapped.x, snapped.y, snapped.kind);
      clearSnapMarker(600);
      showSnapFeedback(snapped.kind === 'edge' ? '吸附到边界' : '吸附到网格');
    }
    render();
    return;
  }

  if (tool.value === 'split') {
    handleSplitClick(world, event.shiftKey);
    return;
  }

  // A：折线切割 —— 逐点落顶点（双击 / Enter 收口，见 onCanvasDblClick / onKeyDown）
  if (tool.value === 'polySplit') {
    if (event.shiftKey) { polySplitKeepStart.value = !polySplitKeepStart.value; }
    onPolySplitClick(world);
    return;
  }

  // B：批量铺底 —— 左键加种子点、Alt/右键去种子点
  if (tool.value === 'voronoi') {
    onBatchSeedClick(world, !!event.altKey);
    return;
  }

  if (tool.value === 'merge') {
    handleMergeClick(world);
    return;
  }

  // 选择模式：标记 → 城镇 → 省份（标记画在最上层，所以先认它）
  if (tool.value === 'select') {
    // 🔴 2026-10-17 第八修·三修：这次 click 若是"mousedown 已经消费掉河命中"的那一次，
    //    直接跳过 —— 否则下面的"选省"逻辑会把刚选中的河当场取消（用户看到的是"点了没反应"）。
    if (st.riverPressHandled) {
      st.riverPressHandled = false;
      return;
    }
    // 🔴 2026-10-17 第八修·补（用户实测：「河流逐条点根本点不中，之前画的测试河流无法删除」）：
    //    河流的命中判定此前**只在河流工具里**（`tool === 'river'`）。于是用「选择」工具
    //    点河 = 什么都没发生；而 `Delete` 也因为 `selectedRiver` 为空而不删。
    //    结果：画错的河**没法删**（用户的原话是"噩梦"）。
    //    现在：选择工具里**河优先于省**（河是压在地形上的一层细线，用户点它就是要选它），
    //    命中范围比河流工具宽一点（细线本来就难点中）。
    //    ⚠️ 真正的主判定已前移到 `onMouseDown`（click 会因轻微拖动而不派发），
    //       这里保留一份是为了"点得极快、没有拖动"的情况 —— 两条路都能选中。
    const hitRiver = hitTestRiver(
      (baseMap.value?.rivers) || [], world.x, world.y, RIVER_SELECT_HIT_PX / cameraScale.value,
      (r) => riverNodesForRender(r),
    );
    if (hitRiver) {
      applyRiverPick(hitRiver.id, event.shiftKey);
      return;
    }
    // 点空白 / 城镇 / 省份 = 取消河流选中（2026-10-27 用户 C3：「特别难取消选中」）。
    // 旧实现只换 selectedProvince，selectedRiverId 留着 → 河一直高亮、手柄一直在。
    if (riverSelIds().length) {
      setRiverSelection([]);
      statusMsg('已取消河流选中（数据未改；Esc 同效）');
    }
    // 标记命中（2026-10-24）：标记是叠在地形/城镇之上的图标 → 点它就该选中它。
    // 此前这一段缺失 = 标记"放下就再也点不到"（没有面板，也没有任何回执）。
    const markerHit = findMarkerAt(world);
    if (markerHit) {
      openMarkerEditor(markerHit.marker, markerHit.index);
      render();
      return;
    }
    if (selectedMarker.value) closeMarkerEditor();   // 点空地/别的对象 → 收起标记面板（重绘在末尾）
    const burg = showBurgs.value ? findBurgAt(sx, sy) : null;
    selectedBurg.value = burg;
    if (burg) {
      openBurgEditor(burg);
    } else {
      const prov = findProvinceAt(world.x, world.y);
      // Ctrl/⌘ + 点击 = 把该省加进/移出多选集合（批量指派的入口）
      if (prov && (event.ctrlKey || event.metaKey)) {
        toggleProvinceSelection(prov.id);
        selectedProvince.value = prov;
        showProps.value = true;
        statusMsg(selectedProvinceIds.value.includes(prov.id)
          ? `已加入多选：「${prov.name}」（共 ${selectedProvinceIds.value.length} 省；用下面的批量条指派）`
          : `已移出多选：「${prov.name}」（还剩 ${selectedProvinceIds.value.length} 省）`);
      } else {
        if (selectedProvinceIds.value.length) clearProvinceSelection();   // 普通点击 = 回到单选
        selectedProvince.value = prov;
        showProps.value = !!prov;
      }
    }
    render();
    return;
  }

  // ── 河流编辑器（2026-10-17）：**必须放在剧本模式闸门之前** ────────────────────
  // 🔴 底下那句 `if (viewMode.value !== 'scenario' || !selectedScenario.value) return;`
  //    是"着色类工具"的闸门，而河流属于**底图内容**（`baseMap.rivers`）——
  //    `viewMode` 初值就是 `'base'`（`const viewMode = ref('base')`），选剧本才会变
  //    `'scenario'` → 旧写法下"在底图模式下画河"这一整条链（双击收口 / 选中 / 加拐点）
  //    **一次都进不去**，只能靠 mousedown 一个点一个点地戳。真机探针已复现：
  //    `viewMode='base'` 时点画布 → 草稿涨了、河里什么都没有。
  if (tool.value === 'river') {
    // 这一笔已由 mousedown/mouseup 处理（画河或拖节点）→ 吃掉这次 click
    if (st.suppressRiverClick) { st.suppressRiverClick = false; return; }
    if (store.isReadOnly) { statusMsg(`河流编辑已停用：${store.readOnlyReason}`); return; }
    const hit = hitBaseMapRiver(world.x, world.y);
    if (!hit) {
      // 没点到任何河：清掉选中，说清楚下一步（不是"点了没反应"）
      selectedRiverId.value = null;
      riverActiveNode.value = -1;
      statusMsg('这里没有河流 —— 按住左键拖一笔就能画一条（松手成河）；想改已有的河就点它的河身');
      render();
      return;
    }
    const already = selectedRiver.value && selectedRiver.value.id === hit.id;
    if (already) {
      // 🔴 点**已选中**那条河的河身 = 在最近一段插一个节点（与行星图同一判据）。
      //    以前想加拐点只能删整条重画（会换 id/名字、丢掉调好的 width）。
      const seg = findRiverSegment(hit.points || [], world.x, world.y, px(RIVER_HIT_PX));
      if (seg) {
        const nodes = insertNodeBetween(hit.points || [], seg.index, seg.point, () => null)
          .map((p) => ({ x: p.x, y: p.y }));
        const res = store.updateBaseMapRiver(baseMapKey.value, hit.id, { points: nodes }, {});
        if (res && res.ok && res.changed) {
          statusMsg(`已在第 ${seg.index + 1} 段插入一个节点（现 ${nodes.length} 个）`
            + ' —— 继续点河身可加更多，拖节点可微调，Delete 删节点');
        } else if (res && !res.ok) {
          statusMsg(`加拐点失败：${res.message || '未知原因'}`);
        }
        render();
        return;
      }
    }
    selectedRiverId.value = hit.id;
    riverActiveNode.value = -1;
    // 提示里写明"再点河身加拐点 / 拖节点" —— 不然这个能力照样没人知道（可发现性纪律）
    statusMsg(`已选中河流「${hit.name || '未命名'}」（${(hit.points || []).length} 个节点）`
      + ' —— 再点河身=加拐点，拖节点=微调，鼠标移到节点上按 Delete=删这个节点');
    render();
    return;
  }

  if (viewMode.value !== 'scenario' || !selectedScenario.value) return;

  if (tool.value === 'paint') {
    const prov = findProvinceAt(world.x, world.y);
    if (prov && prov.kind === 'sea') {
      // P4：海域不进剧本归属 —— 时间轴 / 谱系都不该出现一片海
      statusMsg('这是海域（kind=sea）：海域不参与势力归属 —— 要不要先在右侧属性面板把它改成陆地？');
      render();
      return;
    }
    if (prov) {
      if (selectedPolity.value) {
        // 把时间轴当前**日期**一并记为显式易主日期 ——
        // 「拖到某日再上色 = 该日易主」，这是易主日期最自然的录入路径（月日精度：现在就带上月日）
        const wr = store.setOwnership(
          selectedScenario.value.id, prov.id, selectedPolity.value.id, tlDate.value,
        );
        if (wr && wr.success === false) {
          statusMsg(`「${prov.name}」归属已改，但易主日期没记：${wr.reason}`);
        } else {
          statusMsg(`「${prov.name}」→ ${selectedPolity.value.name}（易主日期 ${tlDateText.value}）`);
        }
      } else {
        // 色板上的「✕ 清除归属」过去只是 `selectPolity(null)`：title 承诺"清除归属"，
        // 行为却是"取消选中"，再点省份则因旧条件 `&& selectedPolity.value` 而**静默无反应**
        // （而 store 里 `clearOwnership` 明明已实现、还带 undo —— 全仓零调用 = 死入口）。
        // 现在：没选势力 + 油漆桶 = 真的清除该省的归属，与 title 一致。
        const had = !!(selectedScenario.value.ownership || {})[prov.id];
        if (!had) { statusMsg(`「${prov.name}」本来就没有势力归属`); return; }
        store.clearOwnership(selectedScenario.value.id, prov.id, tlDate.value);
        statusMsg(`已清除「${prov.name}」的势力归属（可 Ctrl+Z 撤回）`);
      }
      render();
    } else {
      statusMsg(selectedPolity.value
        ? `没点到省份 —— 油漆桶只对省份多边形生效（当前已选势力：${selectedPolity.value.name}）`
        : '没点到省份；另外：「✕ 清除归属」模式下油漆桶点省份 = 清空该省归属，想指派请先点一个势力色块');
    }
  } else if (tool.value === 'label') {
    const text = await askText({ title: '输入地名' });
    if (text) {
      const preset = LABEL_PRESETS.find(p => p.id === selectedLabelPreset.value) || LABEL_PRESETS[0];
      store.addScenarioLabel(selectedScenario.value.id, {
        x: world.x,
        y: world.y,
        text,
        font: preset.font,
        color: preset.color,
        stroke: preset.stroke,
        strokeWidth: preset.strokeWidth,
        preset: preset.id,
      });
      render();
    }
  } else if (tool.value === 'marker') {
    // 点击放置标记（P1-T5 标记类型系统）
    if (viewMode.value === 'scenario' && selectedScenario.value) {
      // 2026-10-24：点在**已有标记**上 = 打开它的面板，而不是又叠一个（同一位置两个图标
      // 谁也分不清，而且两个都点不开）。要用新标记请稍微挪开一点。
      const exist = findMarkerAt(world);
      if (exist) {
        openMarkerEditor(exist.marker, exist.index);
        statusMsg(`这里已有标记「${exist.marker.name || '（未命名标记）'}」—— 已打开它的面板；`
          + '要新放一个请挪开一点（同一位置叠两个谁也点不准）');
        render();
        return;
      }
      const name = await askText({ title: '标记名称' });
      if (name) {
        const typeDef = MARKER_TYPES.find(t => t.id === selectedMarkerType.value) || MARKER_TYPES[0];
        store.addScenarioMarker(selectedScenario.value.id, {
          x: world.x,
          y: world.y,
          name,
          type: selectedMarkerType.value,
          icon: typeDef.icon,
          color: typeDef.color,
        });
        render();
      }
    } else {
      alert('请先在剧本模式下使用标记工具');
    }
  } else if (tool.value === 'relief') {
    // Relief 图标放置（P1-T1）
    const iconDef = RELIEF_ICONS.find(i => i.id === selectedReliefIcon.value);
    if (iconDef) {
      reliefIcons.value.push({
        id: `relief_${Date.now()}`,
        iconId: iconDef.id,
        x: world.x,
        y: world.y,
        icon: iconDef.icon,
        color: iconDef.color,
      });
      render();
    }
  } else if (tool.value === 'river') {
    // 河流编辑器（P1-T2 手动绘制河流路径）—— **拖笔收点**
    //
    // 🔴 2026-10-16（画河保底）：原来这里**每个 pointer 事件都 push 一个点**（无最小间距）。
    //    pointermove 每几像素报一次 → 一条长河攒出**上千个节点**：
    //    ① 节点编辑变得不可用（满屏都是点）；② 项目 JSON 白胖；③ Chaikin 平滑的成本 ×4 后更糟。
    //    现在按**屏幕 px 换算的世界单位**设最小间距 —— 用 px 定阈值是为了"缩得越小、采样越稀"，
    //    与用户手感一致（缩远了本来就画不出细节）。
    const minStep = px(RIVER_TRACE_MIN_STEP_PX);
    const last = riverDraft.value[riverDraft.value.length - 1];
    if (!last || Math.hypot(world.x - last.x, world.y - last.y) >= minStep) {
      riverDraft.value.push({ x: world.x, y: world.y });
      render();
    }
  } else if (tool.value === 'road') {
    if (!roadStart.value) {
      roadStart.value = world;
      roadPath.value = [world];
    } else {
      // 两点完成道路：用 generateRoadPath 算实际路径
      const baseMapData = baseMap.value;
      if (baseMapData?.heightmap?.grid?.points) {
        const hm = baseMapData.heightmap;
        const pts = hm.grid.points;
        const spacing = hm.grid.spacing || 14.4;
        // 找最近网格点作为起终点
        let startIdx = -1, startDist = Infinity;
        let endIdx = -1, endDist = Infinity;
        for (let i = 0; i < pts.length; i++) {
          const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
          const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
          const sd = Math.hypot(px - roadStart.value.x, py - roadStart.value.y);
          if (sd < startDist) { startDist = sd; startIdx = i; }
          const ed = Math.hypot(px - world.x, py - world.y);
          if (ed < endDist) { endDist = ed; endIdx = i; }
        }
        if (startIdx >= 0 && endIdx >= 0 && startIdx !== endIdx) {
          const path = generateRoadPath(hm.h, hm.grid, startIdx, endIdx);
          if (path.length > 0) {
            const roadPoints = path.map(i => ({ x: pts[i][0], y: pts[i][1] }));
            const style = ROAD_STYLES.find(s => s.id === selectedRoadStyle.value) || ROAD_STYLES[1];
            const newRoute = {
              id: `road_${Date.now()}`,
              group: 'roads',
              name: `道路 ${Date.now()}`,
              points: roadPoints,
              style: style.id,
              width: style.width,
              dash: style.dash,
              color: style.color,
            };
            if (!baseMapData.routes) baseMapData.routes = [];
            // D（2026-10-11）：**改走 store**。旧实现是手搓 `store.baseMaps = {...}` ——
            // 那条路（① 不进撤销栈 ② 不触发 scheduleAutoSaveScenarios，只能"碰巧"赶上别的保存）
            // 实测后果：画完的路可能既撤不掉也可能不落盘，且绕过了只读态写闸门。
            const wr = store.addBaseMapRoute(baseMapKey.value, newRoute);
            if (wr && wr.ok) {
              statusMsg(`已画一条道路（${roadPoints.length} 个点，共 ${wr.count} 条）—— Ctrl+Z 可撤销`);
            } else {
              statusMsg(`道路没画上：${(wr && wr.message) || '未知原因'}`);
            }
          }
        }
      }
      roadStart.value = null;
      roadPath.value = [];
      render();
    }
  }
}

async function triggerMapImport(opts = {}) {
  const refreshOnly = !!(opts && opts.refreshOnly);
  // 🔴 2026-10-13：「拿到一份 .map 之后」的处理体 = **唯一实现**，两条入口共用 ——
  //    ① 用户选文件（下面建 input）；② 「从留底恢复」（`opts.source` = basemap-sources 里的原文）。
  //    刻意不另写一条导入链：两条入口一旦分叉，「只有一条会留底 / 只有一条会补缺」
  //    这类静默不一致迟早发生（本仓已踩过多次"两份实现"）。
  const handle = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      // 先留底（在任何解析/写入之前）—— 解析失败也该留下这份素材。
      // ⚠️ 「从留底恢复」进来的这一份**不再留底**：它本身就是那份留底，
      //    再写一份只会多占一个轮转位（`name-2.map`）、把更早的版本挤掉。
      const srcNote = file.__fromBackup
        ? '（用的就是项目备份目录里的留底，未重复留底）'
        : await backupMapSourceFile(file.name, text);
      const parsed = parseMapFile(text);
      const name = mapNameFromFileName(file.name);
      const json = buildScenariosJson(parsed, name, '当前');
      const bundle = json.baseMaps?.[name];

      // ── 已有同名底图：**只补数据，绝不覆盖**（B2，2026-10-11）─────────────────
      // 🔴 为什么必须分这条路：`importFromScenariosJson` 的合并语义是「同 key 整体替换」
      //     —— 拿它去"补高度图"会把用户已切好的几百块省份、归属、易主记录一起盖掉。
      //     真实场景：`desite` 底图现在有 415 块省份，而它建图时（2026-09-10）解析器
      //     还读不出高度图/河流/道路 → 用户需要的是"给这张图补上"，不是"重画一张"。
      if (bundle && store.baseMaps?.[name]) {
        const existing = store.baseMaps[name];
        // 019（2026-10-25）：同名底图分两条路 ——
        //   · 一笔未改（指纹 == 导入时指纹）→ 只补缺（旧行为，安全）；
        //   · 改过一笔（或旧数据没有指纹）→ **不能再只补数据**：新底图 + 旧归属迁移。
        // 旧行为会把"改过的底图"当成同一张图补数据；用户明确说过：动过一笔就不是一个东西了。
        if (!isBasemapPristine(existing)) {
          // 「刷新底图数据」入口只给未改过的底图补缺；改过的底图必须走「+ 导入」重导，
          // 否则用户点刷新却被弹重导对话框，按钮语义就错了。
          if (refreshOnly) {
            statusMsg(`「${name}」这张底图改过，不能只补数据；要换新 .map 请用「+ 导入 .map 底图」重导（会迁移旧归属）。刷新入口只给一笔未改的底图补缺。`);
            return;
          }
          // 不直接写：先开重导对话框，把映射统计/冲突摆出来（019）
          openReimportDialog(name, bundle, file.name);
          return;
        }

        const srcStats = parsed.stats || {};
        const missing = describeBaseMapMissing(store.baseMaps[name], bundle);
        if (!missing.length) {
          statusMsg(`「${name}」的底图数据已经齐了（高度图 / 河流 / 道路 / 城镇都有），无需刷新`);
          return;
        }
        if (!confirm(`「${name}」这张底图已经存在了。\n\n`
          + `可以把它缺的底图级数据补上：${missing.join(' / ')}\n`
          + `文件里带着：${srcStats.cells || 0} 格高度、${srcStats.rivers || 0} 条河流、`
          + `${srcStats.routes || 0} 条道路、${srcStats.burgs || 0} 个城镇。\n\n`
          + `· 你已切好的 ${(store.baseMaps[name].terrain || []).length} 块省份边界、归属与易主记录**一个字都不会动**\n`
          + `· 这张底图**已经有的**数据不会被覆盖（只补缺）\n`
          + `· 一整次刷新 = 一条 Ctrl+Z\n\n继续刷新？`)) {
          statusMsg('刷新底图数据：已取消（底图与省份均未改动）');
          return;
        }
        const r = store.updateBaseMapData(name, bundle);
        if (r && r.ok && r.changed) {
          statusMsg(`已刷新底图数据：${r.message}`
            + (r.blocked?.length ? ` ⚠️ ${r.blocked.map(b => b.message).join(' ')}` : '')
            + srcNote
            + '（可用 Ctrl+Z 撤回）');
          baseMapKey.value = name;
          // 刷新后画布上要能立刻看见：默认切到「地形高度」档（高度图刚到，用户就是为它来的）
          if (r.added.heightmap) rasterLayer.value = 'height';
          render();
        } else {
          statusMsg(`刷新底图数据：${(r && r.message) || '没有可补的数据'}`);
        }
        return;
      }

      if (refreshOnly && !store.baseMaps?.[name]) {
        // 走「刷新」入口却选了一个新名字的底图 → 不能悄悄新建（那会多出一张空底图）
        if (!confirm(`这张底图（${name}）还不存在。「刷新」只给已有底图补数据，不会新建底图。\n\n`
          + '改成「导入为新底图」？')) {
          statusMsg('刷新底图数据：已取消（没有新建底图）');
          return;
        }
      }

      store.importFromScenariosJson(json);
      baseMapKey.value = name;
      // 持久化当前底图键（P0）
      if (window.sitianAPI?.setCurrentBaseMapKey) {
        window.sitianAPI.setCurrentBaseMapKey(name);
      }
      if (json.scenarios[name + '/当前']) {
        selectedScenario.value = json.scenarios[name + '/当前'];
        viewMode.value = 'scenario';
      }
      setTimeout(fitToView, 50);

      // 尝试自动同步 Azgaar 数据到对应行星的 mapData
      const planetNode = store.nodes?.find(n =>
        n.layer === 'planet' && (n.name === name || n.displayName === name)
      );
      if (planetNode && json.baseMaps?.[name]?.heightmap) {
        store.importPlanetLayerData(planetNode.id, {
          provinces: json.baseMaps[name].terrain,
          states: parsed.states,
          cultures: parsed.cultures,
          religions: parsed.religions,
          polities: parsed.polities,
          ownership: parsed.ownership,
        });
      }

      // 🔴 导入结果必须**当场说清**（B2 的"明确可诊断"，2026-10-11）：
      //    解析器早就把「未解析到 cells.h（高度图不可用）」这类问题收进 `warnings` 了，
      //    但导入路径一个字都不报 —— 用户只会看到"地图是纯色扁平的"，
      //    然后去找一个根本不存在的显示开关。这就是他这次的实际经历。
      const newBm = store.baseMaps?.[name];
      const srcBundle = json.baseMaps?.[name];
      const missing = newBm ? describeBaseMapMissing(newBm, srcBundle) : [];
      const warns = parsed.warnings || [];
      // 「源文件里压根没有高度图」是另一回事（不是"这张底图缺"，而是"这份 .map 没带"）——
      // 两种都要说，而且要说成不同的话，否则用户会以为"刷新一下就有了"。
      const srcHasTerrain = Array.isArray(srcBundle?.heightmap?.h) && srcBundle.heightmap.h.length > 0;
      const parts = [`已导入「${name}」：省份 ${(newBm?.terrain || []).length} 块`];
      if (srcHasTerrain) parts.push('高度图 有');
      parts.push(`河流 ${(newBm?.rivers || []).length} 条`, `道路 ${(newBm?.routes || []).length} 条`);
      if (!srcHasTerrain) {
        parts.push('地形高度图 ⚠️ **这份 .map 里就没有**（导出时未包含 cells.h）'
          + ' —— 所以地图会是纯色扁平图，这不是显示开关的问题');
      }
      if (missing.length) {
        parts.push(`这张底图还缺：${missing.join(' / ')} —— 可用工具栏「刷新底图数据」从另一份 .map 补`);
      }
      if (warns.length) parts.push(`解析提示（${warns.length} 条）：${warns.slice(0, 2).join('；')}`);
      // 「原始 .map 已留底 / 留底失败」并入同一句回执（备份失败也要看得见，不能静默）
      statusMsg(parts.join('、').replace(/、地形高度图/, '；地形高度图') + srcNote);
    } catch (err) {
      alert('导入失败: ' + err.message);
    }
  };
  // 「从留底恢复」：把留底原文按 `{ name, text() }` 的形状喂进同一条链（不经过文件选择器）
  if (opts.source) return handle(opts.source);
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.map';
  input.onchange = (e) => handle(e.target.files[0]);
  input.click();
}

async function triggerCoastlineRebuild() {
  if (store.isReadOnly) { statusMsg(`重建海岸线已停用：${store.readOnlyReason}`); return; }
  if (!(baseMap.value?.terrain || []).length) { statusMsg('重建海岸线：这张底图还没有省份'); return; }
  const stored = (baseMap.value?.landFeatures || []);
  const runWith = async (features, srcLabel) => {
    const before = (baseMap.value?.terrain || []).length;
    const r = await store.rebuildCoastline(baseMapKey.value, features, {
      token: st.batchCancelToken || undefined,
    });
    provinceBrush.invalidateBorders();
    if (!r || r.ok === false) {
      statusMsg(`重建海岸线：${(r && r.message) || '失败'}（省份 ${
        (baseMap.value?.terrain || []).length} 块一字未动）`);
      render();
      return;
    }
    if (!r.changed) { statusMsg(`重建海岸线：${r.message}`); render(); return; }
    const worst = (r.detail || []).slice(0, 3)
      .map((d) => `${d.name || d.id}${d.removed ? '（被清空）' : ` ${d.delta >= 0 ? '+' : ''}${Math.round(d.delta)}`}`)
      .join('、');
    statusMsg(`重建海岸线完成（来源：${srcLabel}）：省份 ${before} 块不变，`
      + `改了 ${r.changed} 个省的边界${worst ? `（变化最大：${worst}）` : ''}`
      + `${r.skippedInside ? `；${r.skippedInside} 个内陆省逐点未动` : ''}`
      + `；面积 ${r.drift >= 0 ? '+' : ''}${(r.drift * 100).toFixed(2)}% —— 一整次 = 一条撤销`);
    render();
  };

  if (stored.length) {
    const totalPts = stored.reduce((n, f) => n + ((f.points || []).length), 0);
    if (!confirm(`用这张底图里已存的陆地轮廓重建省份外环？\n\n`
      + `· 陆地轮廓：${stored.length} 块 / 合计 ${totalPts} 点\n`
      + `· 做法：每个省 = 省 ∩ 新陆地 —— **只换海岸那一段**\n`
      + `· 内陆省逐点不动；相邻省仍无缝；海岸线换成新数据的原顶点\n`
      + `· 一整次 = 一条 Ctrl+Z；面积漂移过大（多半选错图）会被拒绝\n\n继续？`)) {
      statusMsg('重建海岸线：已取消');
      return;
    }
    await runWith(stored, '底图内已存的海岸线');
    return;
  }

  // 老底图：让用户选一份 .map，只借它的海岸线
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.map';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseMapFile(text);
      const feats = parsed.landFeatures || [];
      if (!feats.length) {
        statusMsg('重建海岸线：这份 .map 里没有陆地轮廓（生成器导出时海岸线图层可能是空的）—— 数据未改动');
        return;
      }
      const totalPts = feats.reduce((n, f) => n + ((f.points || []).length), 0);
      if (!confirm(`用「${file.name}」的海岸线重建省份外环？\n\n`
        + `· 这份文件里的陆地轮廓：${feats.length} 块 / 合计 ${totalPts} 点\n`
        + `· **只借它的海岸线** —— 省份、归属、易主记录都不作废\n`
        + `· 做法：每个省 = 省 ∩ 新陆地；内陆省逐点不动、相邻省仍无缝\n`
        + `· 一整次 = 一条 Ctrl+Z；面积漂移过大（多半选错图）会被拒绝\n\n继续？`)) {
        statusMsg('重建海岸线：已取消（数据未改动）');
        return;
      }
      await runWith(feats, file.name);
    } catch (err) {
      alert('重建海岸线失败: ' + err.message);
    }
  };
  input.click();
}

async function runBatchSubdivide() {
  if (batchBusy.value) return;
  if (store.isReadOnly) { statusMsg(`批量铺底已停用：${store.readOnlyReason}`); return; }
  const o = batchOpts();
  const seeds = batchSeeds.value.slice();
  if (!seeds.length) { statusMsg('批量铺底：先「自动播种」或在画布上点几个种子点'); return; }
  const inside = batchPreviewInside.value.filter(Boolean).length;
  if (!confirm(`批量铺底：在 ${o.provinceIds ? o.provinceIds.length + ' 个选中的省' : '全部陆地'}范围内，`
    + `用 ${seeds.length} 个种子点切分（其中 ${seeds.length - inside} 个落在范围外会被忽略）。\n\n`
    + '· 范围内的旧省份会被替换成新块（归属 / 易主记录自动继承给新块）\n'
    + '· 海岸线不会被动到（每块都与陆地边界精确求交）\n'
    + '· 一整批只算一次撤销，Ctrl+Z 可整批撤回\n'
    + '· 过程中画布会短暂不响应（正在算几何），可以点「取消切分」放弃这一批 —— 不改动任何数据\n\n继续？')) {
    statusMsg('批量铺底：已取消');
    return;
  }
  batchBusy.value = true;
  batchStatus.value = '正在切分…';
  // C（2026-10-11）：取消令牌 —— 组件与 store 之间只传一个 `{cancelled}`，store 在每个让出点
  // （rAF 帧）检查一次；取消时 store **不落库、不压 undo**，所以"取消"是真正无副作用的。
  const token = { cancelled: false };
  st.batchCancelToken = token;
  try {
    const r = await store.batchSubdivide(baseMapKey.value, {
      ...o, sites: seeds, token,
      onProgress: (pr) => { batchStatus.value = pr.message || pr.phase; },
    });
    if (!r || r.ok === false) {
      const wasCancelled = !!(r && r.rejected === 'cancelled');
      batchStatus.value = (r && r.message) || '切分失败';
      statusMsg(wasCancelled ? `批量铺底：${batchStatus.value}` : `批量铺底失败：${batchStatus.value}`);
    } else {
      const pct = r.coverage != null ? Math.round(r.coverage * 100) : null;
      batchStatus.value = `已切出 ${r.created} 块（替换 ${r.removed} 省，用时 ${(r.elapsedMs / 1000).toFixed(1)}s`
        + `${pct != null ? `，覆盖 ${pct}%` : ''}${r.failed ? `，失败 ${r.failed} 块` : ''}）`;
      statusMsg(`批量铺底完成：${r.created} 块省份（替换了 ${r.removed} 个省；归属迁移 ${r.ownershipMigrated} 个剧本；`
        + `${r.clipped} 块贴海岸、${r.inner} 块在内陆${r.snapped ? `、${r.snapped} 块走了坐标吸附兜底` : ''}）`
        + ' —— 一次 Ctrl+Z 可整批撤回');
      batchSeeds.value = [];
      selectedProvince.value = null;
      showProps.value = false;
    }
  } catch (err) {
    batchStatus.value = `切分异常：${(err && err.message) || err}`;
    statusMsg(`批量铺底异常：${(err && err.message) || err}`);
  } finally {
    batchBusy.value = false;
    st.batchCancelToken = null;
    provinceBrush.invalidateBorders();
    render();
  }
}

async function openSourceRestore() {
  sourceRestoreOpen.value = true;
  sourceRestoreMsg.value = '';
  sourceRestoreFiles.value = [];
  sourceRestoreDir.value = '';
  sourceRestoreLoading.value = true;
  try {
    const api = window.sitianAPI;
    if (!api?.listBaseMapSources || !api?.projectCurrentPath) {
      sourceRestoreMsg.value = '这个运行环境读不到留底（缺少 IPC）';
      return;
    }
    const cur = await api.projectCurrentPath();
    const projectPath = (cur && cur.success && cur.filePath) || '';
    if (!projectPath) {
      // 留底与项目文件放在一起 —— 没有已落盘的项目就没有留底目录
      sourceRestoreMsg.value = '当前没有已落盘的项目文件 —— 留底与项目放在一起，所以现在读不到';
      return;
    }
    const r = await api.listBaseMapSources({ projectPath });
    if (!r || r.success === false) {
      sourceRestoreMsg.value = `读清单失败：${(r && r.error) || '未知原因'}`;
      return;
    }
    sourceRestoreFiles.value = Array.isArray(r.files) ? r.files : [];
    sourceRestoreDir.value = r.dir || '';
  } catch (e) {
    sourceRestoreMsg.value = `读清单失败：${e.message}`;
  } finally {
    sourceRestoreLoading.value = false;
  }
}

async function restoreFromSource(f) {
  if (sourceRestoreBusy.value) return;
  if (store.isReadOnly) {
    sourceRestoreMsg.value = `只读：${store.readOnlyReason || '未打开项目'}`;
    return;
  }
  sourceRestoreBusy.value = true;
  sourceRestoreMsg.value = `正在读回 ${f.name}…`;
  try {
    const api = window.sitianAPI;
    const cur = await api.projectCurrentPath();
    const projectPath = (cur && cur.success && cur.filePath) || '';
    const r = await api.readBaseMapSource({ projectPath, name: f.name });
    if (!r || r.success === false) {
      sourceRestoreMsg.value = `读回失败：${(r && r.error) || '未知原因'}`;
      return;
    }
    // 导入链里可能弹确认框：先放开按钮，免得看着像卡死
    sourceRestoreBusy.value = false;
    await triggerMapImport({
      source: { name: r.name, text: async () => r.text, __fromBackup: true },
    });
    sourceRestoreMsg.value = `已按留底「${r.name}」（${fmtSrcBytes(r.bytes)}）走完导入链 —— `
      + '同名底图只补缺，你已切好的省份与归属不会被覆盖；详细结果见底部状态栏';
  } catch (e) {
    sourceRestoreMsg.value = `恢复失败：${e.message}`;
  } finally {
    sourceRestoreBusy.value = false;
  }
}

  return { onCanvasClick, triggerMapImport, triggerCoastlineRebuild, runBatchSubdivide, openSourceRestore, restoreFromSource };
}
