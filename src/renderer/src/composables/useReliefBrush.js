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

export function useReliefBrush({ store, currentMapData }) {
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

  let strokeSeed = 1;
  let walkedLength = 0;                // 本次拖动已累积的弧长（用于间距相位连续）
  let lastPoint = null;

  const reliefTypeMeta = computed(() => RELIEF_TYPE_MAP[reliefType.value] || RELIEF_TYPES[0]);
  const reliefStep = computed(() =>
    Math.max(4, reliefSpacing.value * (RELIEF_DENSITY[reliefDensity.value] || RELIEF_DENSITY.medium).factor));

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
      return true;
    }
    const a = lastPoint || { x: wx, y: wy };
    const seg = [{ x: a.x, y: a.y }, { x: wx, y: wy }];
    const segLen = Math.hypot(wx - a.x, wy - a.y);
    if (segLen < 0.5) return false; // 微小移动不重复散布
    _scatterSegment(seg);
    walkedLength += segLen;
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
    walkedLength = 0;
    if (planetId && (added.length || removedIds.length)) {
      store.applyReliefStroke(planetId, added, removedIds);
    }
    return added.length + removedIds.length;
  }

  /** 取消当前拖动（Esc） */
  function cancelStroke() {
    isReliefBrushing.value = false;
    reliefEraseMode.value = false;
    reliefPath.value = [];
    reliefPending.value = [];
    reliefRemovedIds.value = [];
    reliefLiveIcons.value = null;
    reliefCursor.value = null;
    lastPoint = null;
    walkedLength = 0;
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
