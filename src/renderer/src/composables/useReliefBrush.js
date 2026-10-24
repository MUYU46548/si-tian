// composables/useReliefBrush.js — Relief Icons 笔刷交互（P0-1）
//
// 职责：持有笔刷参数与"当前一次拖动"的临时状态，把拖动路径交给 utils/reliefIcons.js
// 做确定性散布，松手时把整次拖动压缩成 **一条** undo（store.applyReliefStroke）。
//
// 交互契约（与提示词一致）：
//   · 左键拖动：沿路径散布图标（间距由 spacing × 密度档位决定）
//   · 右键拖动：擦除半径内的图标
//   · 滚轮：调整散布间距（由 PlanetMap 的 wheel 处理调用 adjustSpacing）
//   · 一次拖动 = 一条 undo（含"同时有增有删"的情形）
import { ref, computed } from 'vue';
import {
  scatterAlongPath,
  eraseInRadius,
  DEFAULT_RELIEF_PARAMS,
  RELIEF_DENSITY,
  RELIEF_TYPES,
  RELIEF_TYPE_MAP,
} from '../utils/reliefIcons';
import { brushSegmentRect } from '../utils/dirtyRect';

export function useReliefBrush({ store, currentMapData, renderer = null }) {
  // ===== 参数（笔刷子面板绑定）=====
  const reliefType = ref(DEFAULT_RELIEF_PARAMS.type);
  const reliefSize = ref(DEFAULT_RELIEF_PARAMS.size);
  const reliefSpacing = ref(DEFAULT_RELIEF_PARAMS.spacing);
  const reliefDensity = ref(DEFAULT_RELIEF_PARAMS.density);
  const reliefRandomRotation = ref(DEFAULT_RELIEF_PARAMS.randomRotation);
  const reliefEraseRadius = ref(45);

  // ===== 拖动状态 =====
  const isReliefBrushing = ref(false);
  const reliefEraseMode = ref(false);
  const reliefPath = ref([]);          // 本次拖动的世界坐标路径
  const reliefPending = ref([]);       // 本次拖动新增的图标
  const reliefRemovedIds = ref([]);    // 本次拖动擦除的图标 id
  const reliefLiveIcons = ref(null);   // 拖动中的"实时列表"（绘制层优先用它）
  const reliefCursor = ref(null);      // 笔刷光标预览 {x, y}

  // ===== 实例选中 / 拖动（第 2 件："实例可选中可移动"，2026-10-24）=====
  // 与"散布一笔"是两条互斥的链：点中已有图标 = 选中它并**拖它**；点空白 = 开始散布新图标。
  const selectedReliefId = ref(null);
  const reliefDrag = ref(null);        // { id, origX, origY, x, y, moved }
  /** 拖动中的**预览列表**：把被拖的那一颗换到手指位置（只读副本，不碰存储） */
  const reliefInstanceIcons = computed(() => {
    const d = reliefDrag.value;
    if (!d) return null;
    const list = currentMapData.value?.reliefIcons || [];
    return list.map(it => (it.id === d.id ? { ...it, x: d.x, y: d.y } : it));
  });
  const selectedReliefIcon = computed(() => {
    const id = selectedReliefId.value;
    if (!id) return null;
    const d = reliefDrag.value;
    if (d && d.id === id) return { id, x: d.x, y: d.y, size: d.size };
    const it = (currentMapData.value?.reliefIcons || []).find(x => x.id === id);
    return it ? { id: it.id, x: it.x, y: it.y, size: it.size } : null;
  });

  /** 命中半径：图标半边长 × 0.8（比图标略小，免得挨着两颗时永远只选到大的那颗） */
  function _hitRadius(it) { return Math.max(10, (it.size || 24) * 0.5 * 1.6); }

  // 「这一次点击来自选中图标」→ 随后的 click 不要清选中（否则刚点中就立刻被清掉）
  // 🔴 用**下一次 mousedown 复位**、而不是"靠 click 消费掉"：鼠标在画布外松开、或程序化派发
  //    （用例/演练只发 mousedown+mouseup）时 click 可能永远不来 —— 那样这个信用会一直挂着，
  //    下一次点空白就清不掉选中（实测就是这样：点空白后选中还在）。
  let clickCameFromSelection = false;
  function resetClickCredit() { clickCameFromSelection = false; }
  /** click 时问一句：该不该清选中？返回 true = 清（点的是空白） */
  function shouldClearSelectionOnClick() {
    return !clickCameFromSelection;
  }

  /**
   * 命中一颗图标的 id（后画的优先 —— 与绘制顺序一致，视觉在上面的先被选中）。
   * @returns {string|null}
   */
  function hitReliefInstance(wx, wy) {
    const list = currentMapData.value?.reliefIcons || [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const it = list[i];
      if (!it || !Number.isFinite(it.x) || !Number.isFinite(it.y)) continue;
      if (Math.hypot(wx - it.x, wy - it.y) <= _hitRadius(it)) return it.id;
    }
    return null;
  }

  /**
   * 按下时先问"点中图标了吗"。
   * @returns {boolean} true = 进入拖动实例（调用方**不要**再开始散布笔）
   */
  function beginInstanceDrag(wx, wy) {
    const id = hitReliefInstance(wx, wy);
    if (!id) return false;
    const it = (currentMapData.value?.reliefIcons || []).find(x => x.id === id);
    if (!it) return false;
    selectedReliefId.value = id;
    clickCameFromSelection = true;
    reliefDrag.value = { id, origX: it.x, origY: it.y, x: it.x, y: it.y, size: it.size, moved: false };
    return true;
  }

  /** 拖动中：只更新预览（**不碰存储** —— 只读态下也不会有任何半截写入） */
  function moveInstanceDrag(wx, wy) {
    const d = reliefDrag.value;
    if (!d) return false;
    d.x = wx;
    d.y = wy;
    if (!d.moved && Math.hypot(d.x - d.origX, d.y - d.origY) > 1) d.moved = true;
    return true;
  }

  /**
   * 松手：真的动过才落库（一次拖动 = 一条 undo）；没动过 = 只是"选中了一下"，零写入。
   * @returns {{moved:boolean, committed:boolean}}
   */
  function endInstanceDrag() {
    const d = reliefDrag.value;
    reliefDrag.value = null;
    if (!d) return { moved: false, committed: false };
    if (!d.moved) return { moved: false, committed: false };
    const planetId = currentMapData.value?.planetId;
    if (!planetId) return { moved: true, committed: false };
    const r = store.moveReliefIcons(planetId, [{ id: d.id, x: d.x, y: d.y }]);
    // 挪过位置 → 旧位置必须整帧重画一次才不会留下"重影"（脏矩形只覆盖新位置）
    if (typeof renderer?.markFullRedraw === 'function') renderer.markFullRedraw();
    return { moved: true, committed: !!(r && r.ok) };
  }

  function clearSelection() {
    selectedReliefId.value = null;
  }
  function selectInstance(id) {
    selectedReliefId.value = id || null;
  }

  let lastDirtyPos = null;             // P2-3 脏矩形：上一个落点
  let strokeSeed = 1;
  let walkedLength = 0;                // 本次拖动已累积的弧长（用于间距相位连续）
  let lastPoint = null;

  const reliefTypeMeta = computed(() => RELIEF_TYPE_MAP[reliefType.value] || RELIEF_TYPES[0]);
  const reliefStep = computed(() =>
    Math.max(4, reliefSpacing.value * (RELIEF_DENSITY[reliefDensity.value] || RELIEF_DENSITY.medium).factor));

  // P2-3 脏矩形：地貌图标散布半径（size 是世界单位的一半边长，留足余量）
  function markStrokeDirty(a, b) {
    if (!renderer?.markDirtyRect) return;
    const r = Math.max(reliefSize.value * 1.5, reliefEraseRadius.value);
    renderer.markDirtyRect(brushSegmentRect(a, b, r));
  }

  function _params() {
    return {
      type: reliefType.value,
      size: reliefSize.value,
      spacing: reliefSpacing.value,
      density: reliefDensity.value,
      randomRotation: reliefRandomRotation.value,
      seed: strokeSeed,
      startOffset: walkedLength,
    };
  }

  /** 当前应显示的图标列表 = 存储值 − 本次擦除 + 本次新增 */
  function _rebuildLive() {
    const stored = currentMapData.value?.reliefIcons || [];
    if (!isReliefBrushing.value) { reliefLiveIcons.value = null; return; }
    const removed = new Set(reliefRemovedIds.value);
    reliefLiveIcons.value = stored.filter(it => !removed.has(it.id)).concat(reliefPending.value);
  }

  /**
   * 开始一次拖动。
   * @param {number} wx 世界坐标
   * @param {number} wy
   * @param {{erase?: boolean}} opts 左键 erase=false，右键 erase=true
   */
  function startStroke(wx, wy, opts = {}) {
    const planetId = currentMapData.value?.planetId;
    if (!planetId) return false;
    isReliefBrushing.value = true;
    reliefEraseMode.value = !!opts.erase;
    reliefPath.value = [{ x: wx, y: wy }];
    reliefPending.value = [];
    reliefRemovedIds.value = [];
    walkedLength = 0;
    markStrokeDirty(lastDirtyPos, { x: wx, y: wy });
    lastDirtyPos = { x: wx, y: wy };
    lastPoint = { x: wx, y: wy };
    // 每次拖动换 seed：同一次拖动内保持确定性，不同拖动之间有点变化
    strokeSeed = (strokeSeed + 1) & 0x7fffffff;
    if (reliefEraseMode.value) _eraseAt(wx, wy);
    else _scatterSegment([{ x: wx, y: wy }, { x: wx, y: wy }]);
    _rebuildLive();
    return true;
  }

  function moveStroke(wx, wy) {
    if (!isReliefBrushing.value) return false;
    reliefCursor.value = { x: wx, y: wy };
    if (reliefEraseMode.value) {
      _eraseAt(wx, wy);
      _rebuildLive();
      markStrokeDirty(lastDirtyPos, { x: wx, y: wy });
      lastDirtyPos = { x: wx, y: wy };
      return true;
    }
    const a = lastPoint || { x: wx, y: wy };
    const seg = [{ x: a.x, y: a.y }, { x: wx, y: wy }];
    const segLen = Math.hypot(wx - a.x, wy - a.y);
    if (segLen < 0.5) return false; // 微小移动不重复散布
    _scatterSegment(seg);
    walkedLength += segLen;
    markStrokeDirty(lastDirtyPos, { x: wx, y: wy });
    lastDirtyPos = { x: wx, y: wy };
    lastPoint = { x: wx, y: wy };
    reliefPath.value = reliefPath.value.concat([{ x: wx, y: wy }]);
    _rebuildLive();
    return true;
  }

  /** 结束拖动：整次拖动压成一条 undo */
  function finishStroke() {
    if (!isReliefBrushing.value) return 0;
    const added = reliefPending.value;
    const removedIds = reliefRemovedIds.value;
    const planetId = currentMapData.value?.planetId;
    isReliefBrushing.value = false;
    reliefEraseMode.value = false;
    reliefPath.value = [];
    reliefPending.value = [];
    reliefRemovedIds.value = [];
    reliefLiveIcons.value = null;
    reliefCursor.value = null;
    lastPoint = null;
    lastDirtyPos = null;
    walkedLength = 0;
    if (planetId && (added.length || removedIds.length)) {
      store.applyReliefStroke(planetId, added, removedIds);
    }
    // 🔴 L2 笔迹层收口（第 2 件首落）：轨迹是**瞬态**的，必须整帧重画一次才能擦掉。
    //    只 requestRender() 不够 —— 渲染器的脏矩形只覆盖"这一笔碰过的图标矩形"，
    //    轨迹在别处的像素会留在画面上（典型事故：松手后画布上挂着一条白线，直到下次全量重绘）。
    if (typeof renderer?.markFullRedraw === 'function') renderer.markFullRedraw();
    return added.length + removedIds.length;
  }

  /** 取消当前拖动（Esc） */
  function cancelStroke() {
    lastDirtyPos = null;
    isReliefBrushing.value = false;
    reliefEraseMode.value = false;
    reliefPath.value = [];
    reliefPending.value = [];
    reliefRemovedIds.value = [];
    reliefLiveIcons.value = null;
    reliefCursor.value = null;
    lastPoint = null;
    walkedLength = 0;
    // 同上：取消也得把轨迹擦掉（这条路径没有 store 写入，光 requestRender 不会重画轨迹以外的地方）
    if (typeof renderer?.markFullRedraw === 'function') renderer.markFullRedraw();
  }

  function _scatterSegment(seg) {
    const stored = currentMapData.value?.reliefIcons || [];
    const removed = new Set(reliefRemovedIds.value);
    // 已有图标（未擦除的）+ 本次已放置的 → 一起参与"不重叠"判定
    const existing = stored.filter(it => !removed.has(it.id)).concat(reliefPending.value);
    const fresh = scatterAlongPath(seg, _params(), existing);
    if (fresh.length) reliefPending.value = reliefPending.value.concat(fresh);
  }

  function _eraseAt(wx, wy) {
    const stored = currentMapData.value?.reliefIcons || [];
    const pendingIds = new Set(reliefPending.value.map(it => it.id));
    const alreadyRemoved = new Set(reliefRemovedIds.value);
    // 1) 擦掉「本次刚放下的」→ 直接从 pending 撤回（等价于没放过）
    const { remaining: pendingLeft, removed: pendingRemoved } =
      eraseInRadius(reliefPending.value, wx, wy, reliefEraseRadius.value);
    if (pendingRemoved.length) reliefPending.value = pendingLeft;
    // 2) 擦掉「存储里已有的」→ 记 id，松手时一次提交
    const { removed } = eraseInRadius(
      stored.filter(it => !alreadyRemoved.has(it.id) && !pendingIds.has(it.id)),
      wx, wy, reliefEraseRadius.value,
    );
    if (removed.length) {
      reliefRemovedIds.value = reliefRemovedIds.value.concat(removed.map(it => it.id));
    }
  }

  // ===== 滚轮调间距 =====
  function adjustSpacing(delta) {
    const next = Math.round(reliefSpacing.value + (delta > 0 ? 5 : -5));
    reliefSpacing.value = Math.min(200, Math.max(8, next));
    return reliefSpacing.value;
  }

  function adjustSize(delta) {
    const next = Math.round(reliefSize.value + (delta > 0 ? 2 : -2));
    reliefSize.value = Math.min(48, Math.max(16, next));
    return reliefSize.value;
  }

  /** 清空当前行星的全部地貌图标（单条 undo） */
  function clearAll() {
    const planetId = currentMapData.value?.planetId;
    if (!planetId) return;
    store.clearReliefIcons(planetId);
  }

  const reliefCount = computed(() => (currentMapData.value?.reliefIcons || []).length);

  return {
    // 参数
    reliefType,
    reliefSize,
    reliefSpacing,
    reliefDensity,
    reliefRandomRotation,
    reliefEraseRadius,
    reliefTypeMeta,
    reliefStep,
    // 状态
    isReliefBrushing,
    reliefEraseMode,
    reliefPath,
    reliefPending,
    reliefLiveIcons,
    reliefCursor,
    reliefCount,
    // 实例选中 / 拖动（第 2 件）
    selectedReliefId,
    selectedReliefIcon,
    reliefDrag,
    reliefInstanceIcons,
    hitReliefInstance,
    beginInstanceDrag,
    moveInstanceDrag,
    endInstanceDrag,
    clearSelection,
    selectInstance,
    resetClickCredit,
    shouldClearSelectionOnClick,
    // 动作
    startStroke,
    moveStroke,
    finishStroke,
    cancelStroke,
    adjustSpacing,
    adjustSize,
    clearAll,
  };
}
