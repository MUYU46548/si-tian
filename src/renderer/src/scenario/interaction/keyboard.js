// scenario/interaction/keyboard.js — 剧本视图键盘处理（N1 第三阶段：把交互逻辑搬出组件）
//
// 为什么单独一刀：`onKeyDown` / `onKeyUp` 是**纯"读状态 → 调动作"**，不碰画布绘制、
// 也不持有只有组件才知道的临时对象 —— 最适合先搬，用来验证「交互搬出组件」这套搬法。
//
// 约定（与 `scenario/layers/*` 一致）：不 import Vue、不摸组件；所有状态与动作由 `ctx` 传入。
// `ctx` 里 ref 传**对象本身**（读写 .value），普通 `let` 变量（altStraight / suppressRiverClick /
// vertexMarqueeStart / vertexLinkCtx）传 get/set —— 直接传值只会拷一份，组件那边永远不更新。
//
// 口径一行没改（每条注释都是原处的）：
//   · 组合键（Ctrl/⌘/Alt）**不是工具快捷键**（2026-10-25 事故：复制文字把工具切成文化笔刷）；
//   · 页面上有文字被选中时，裸字母不切工具；
//   · Shift+B / Shift+W 必须判在裸 B / 裸 W 之前（先写的分支赢）。

/**
 * @param {object} ctx 见文件头；至少要有 tool / setTool / render / statusMsg 等
 * @returns {{ onKeyDown: Function, onKeyUp: Function }}
 */
export function createKeyboardHandlers(ctx) {
  const {
    tool, selectedRiver, riverSelIds, setRiverSelection, statusMsg, render,
    setTool, fitToView, isEditableTarget, nextTick,
    deleteSelectedRiver, removeSelectedRiverNode, clearSnapMarker, clearProvinceSelection,
    finishPolySplit, schedulePolySplitPreview, finishDraw,
    riverDraft, riverDrag, riverActiveNode,
    drawPoints, splitStep, splitPoints, mergeStep, mergeProvId,
    contextMenu, selectedBurg, dragPreview, draggingHandle, activeVertexIdx,
    vertexSelection, vertexMarquee, polySplitPoints, polySplitHover, polySplitPreview,
    terrainLabelPick, immersive, baseMap,
    getAltStraight, setAltStraight, setSuppressRiverClick,
    setVertexMarqueeStart, setVertexLinkCtx,
  } = ctx;

  function onKeyDown(event) {
    if (event.key === 'Escape' || event.key === 'Esc') {
      riverDraft.value = [];
      riverDrag.value = null;
      riverActiveNode.value = -1;
      setSuppressRiverClick(false);
    }
    // Delete / Backspace：河流工具下 —— 有活动节点先删那个节点；空手再按一次删整条
    if ((event.key === 'Delete' || event.key === 'Backspace') && tool.value === 'river' && selectedRiver.value) {
      event.preventDefault();
      if (!removeSelectedRiverNode()) deleteSelectedRiver();
      return;
    }
    // 🔴 2026-10-17 第八修·补：**选择工具**里选中河之后，Delete 也必须能删它。
    if ((event.key === 'Delete' || event.key === 'Backspace')
        && tool.value !== 'river' && selectedRiver.value) {
      event.preventDefault();
      deleteSelectedRiver();
      return;
    }
    if (event.key === 'Escape') {
      drawPoints.value = [];
      splitStep.value = 0;
      splitPoints.value = [];
      mergeStep.value = 0;
      mergeProvId.value = null;
      contextMenu.value.show = false;
      selectedBurg.value = null;
      dragPreview.value = null;
      draggingHandle.value = null;
      activeVertexIdx.value = -1;
      // P1：Esc 同时退出顶点框选（否则框选的顶点会一直跟着下一次拖动）
      vertexSelection.value = [];
      vertexMarquee.value = null;
      setVertexMarqueeStart(null);
      setVertexLinkCtx(null);
      polySplitPoints.value = [];
      polySplitHover.value = null;
      polySplitPreview.value = null;
      clearSnapMarker();
      clearProvinceSelection();      // Esc 也取消多选（批量条的「取消选择」同效）
      // Esc 取消河流选中（2026-10-27）：旧实现只有工具栏一个小按钮，按 Esc 什么都不发生
      if (selectedRiver.value || riverSelIds().length) {
        setRiverSelection([]);
        statusMsg('已取消河流选中（数据未改）');
      }
      // 地形注记手绘：Esc 取消采集（几何只在内存草稿里，数据一个字节都没写）
      if (terrainLabelPick.value) {
        terrainLabelPick.value = null;
        statusMsg('已取消手绘注记（数据未改）');
      }
      render();
    }
    // A：折线切割 —— Enter 收口、Backspace 退一个点
    if (tool.value === 'polySplit') {
      if (event.key === 'Enter') { event.preventDefault(); finishPolySplit(); return; }
      if (event.key === 'Backspace') {
        event.preventDefault();
        if (polySplitPoints.value.length) {
          polySplitPoints.value = polySplitPoints.value.slice(0, -1);
          statusMsg(`折线切割：退回一个点（还剩 ${polySplitPoints.value.length} 个）`);
          schedulePolySplitPreview();
          render();
        }
        return;
      }
    }
    // P0-T1：Alt 临时直线段（按下即重绘，松开恢复曲线）
    if (event.key === 'Alt' && !getAltStraight()) {
      setAltStraight(true);
      event.preventDefault();
      render();
    }
    if (event.key === 'Enter' && tool.value === 'draw' && drawPoints.value.length >= 3) {
      finishDraw();
    }
    if (isEditableTarget(event.target)) return;
    // 沉浸看图模式：Ctrl+I 收起顶栏/侧栏/时间轴。
    // 🔴 用 Ctrl+I 不用裸 I —— 裸 I 已被 Relief 图标占用（下面的 else-if 链）。
    if ((event.ctrlKey || event.metaKey) && (event.key === 'i' || event.key === 'I')) {
      event.preventDefault();
      immersive.value = !immersive.value;
      nextTick(() => { if (baseMap.value?.terrain?.length) fitToView(); });
      statusMsg(immersive.value
        ? '已进入沉浸模式 —— Ctrl+I 退出；底部胶囊 8 秒无操作自动淡出'
        : '已退出沉浸模式');
      return;
    }
    // 🔴 2026-10-25：**Ctrl/⌘/Alt 组合键不是工具快捷键**（复制文字会切工具的事故）。
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // 页面上有一段文字被选中时，裸字母也不切工具（用户多半在读/准备复制）
    const selection = window.getSelection?.();
    if (selection && !selection.isCollapsed && String(selection).trim()) return;
    if (event.key === 'v' || event.key === 'V') setTool('select');
    // Shift+B = 笔刷建省。⚠️ 必须判在 `b` 之前：先写的那个赢
    else if ((event.key === 'b' || event.key === 'B') && event.shiftKey) setTool('provincePaint');
    else if (event.key === 'b' || event.key === 'B') setTool('draw');
    else if (event.key === 'g' || event.key === 'G') setTool('vertex');
    else if (event.key === 'y' || event.key === 'Y') setTool('outline');   // E：描轮廓（Y 未被占用）
    else if (event.key === 'x' || event.key === 'X') setTool('split');
    else if (event.key === 'm' || event.key === 'M') setTool('merge');
    else if (event.key === 'p' || event.key === 'P') setTool('paint');
    else if (event.key === 'q' || event.key === 'Q') setTool(event.shiftKey ? 'provinceBrush' : 'ownerBrush');
    else if ((event.key === 'l' || event.key === 'L') && event.shiftKey) setTool('lake');
    else if (event.key === 'l' || event.key === 'L') setTool('provinceLasso');
    else if (event.key === 'o' || event.key === 'O') setTool('provinceFill');
    else if (event.key === 'd' || event.key === 'D') setTool('polySplit');
    else if (event.key === 'a' || event.key === 'A') setTool('voronoi');
    else if (event.key === 't' || event.key === 'T') setTool('label');
    else if (event.key === 'e' || event.key === 'E') setTool('erase');
    else if (event.key === 'h' || event.key === 'H') setTool('height');
    else if (event.key === 'n' || event.key === 'N') setTool('biome');
    else if (event.key === 'u' || event.key === 'U') setTool('burg');
    else if (event.key === 'c' || event.key === 'C') setTool('culture');
    else if (event.key === 'r' || event.key === 'R') setTool('religion');
    else if (event.key === 'k' || event.key === 'K') setTool('marker');
    else if (event.key === 'j' || event.key === 'J') setTool('road');
    // Shift+W = 河流橡皮。⚠️ 必须判在 `w` 之前（否则"Shift+W 打开了画河"这种静默错位）
    else if ((event.key === 'w' || event.key === 'W') && event.shiftKey) setTool('riverErase');
    else if (event.key === 'w' || event.key === 'W') setTool('river');
    else if (event.key === 'i' || event.key === 'I') setTool('relief');
    else if (event.key === 'f' || event.key === 'F') fitToView();
  }

  function onKeyUp(event) {
    if (event.key === 'Alt' && getAltStraight()) {
      setAltStraight(false);
      render();
    }
  }

  return { onKeyDown, onKeyUp };
}
