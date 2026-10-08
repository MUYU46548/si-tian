// composables/usePlanetChannelBrush.js — 行星侧「文化 / 宗教」逐格笔刷的**交互层**（A3，2026-10-08）
//
// ── 分工（别混）──────────────────────────────────────────────────────────────
//   · `store/geodataModules/channelBrush.js` = **数据层**：抬手 diff、一次 stroke 一条 undo、
//     唯一的写口（`endChannelStroke`，已登记写口契约）。
//   · 本文件 = **交互层**：半径 / 硬度 / 当前选中的文化·宗教 / 笔刷预览 / 吸管，只调用 store 的 API。
//
// 为什么重绘回调要从这里注入：数据层不依赖渲染器（store 不该 import renderer），
// 而 undo/redo 回放的闭包必须能刷新画布 —— 所以 `begin` 时把 `afterWrite` 交给数据层捕获。
// Ctrl+Z 时命令闭包执行 → 它自己会调 `renderer.requestRender()`，不需要 App 再管一次。

import { ref, computed } from 'vue';
import { CHANNEL_LABELS, CHANNEL_MAX_INDEX } from '../utils/heightmapChannels';
import { CULTURE_COLORS } from '../utils/settlement';
import { brushSegmentRect } from '../utils/dirtyRect';

const LIST_KEY = { culture: 'cultures', religion: 'religions' };

export function usePlanetChannelBrush({ store, renderer, currentMapData, onStatus, previewSink }) {
  const brushRadius = ref(120);
  const brushHardness = ref(0.2);      // 0 = 整个半径内都涂；越大越只涂中心（落笔的"硬边"）
  const isBrushing = ref(false);
  const pickMode = ref(null);          // 'culture' | 'religion' | null（吸管待命）
  const valueByChannel = ref({ culture: '1', religion: '1' });
  let lastPaintPos = null;

  function planetId() { return currentMapData.value?.planetId || null; }

  function listOf(channel) {
    const pid = planetId();
    const list = pid ? store.mapData?.[pid]?.[LIST_KEY[channel]] : null;
    return Array.isArray(list) ? list : [];
  }

  /** 下拉选项：`value` 用**位置**（1 起）——与通道值口径一致（见 heightmapChannels.js） */
  const optionsOf = (channel) => listOf(channel).map((it, i) => ({
    value: String(i + 1),
    name: it.name || (CHANNEL_LABELS[channel] + (i + 1)),
    color: it.color || '#888888',
  }));

  const cultureOptions = computed(() => optionsOf('culture'));
  const religionOptions = computed(() => optionsOf('religion'));

  /** 当前选中值（越界/空列表 → 0 = 无主，不画） */
  function valueOf(channel) {
    const v = parseInt(valueByChannel.value[channel], 10) || 0;
    return (v >= 1 && v <= listOf(channel).length) ? v : 0;
  }

  function setValue(channel, v) {
    valueByChannel.value = { ...valueByChannel.value, [channel]: String(v) };
  }

  function nameOfValue(channel, v) {
    const it = listOf(channel)[v - 1];
    return (it && it.name) || (CHANNEL_LABELS[channel] + v);
  }

  /**
   * 保证列表里有东西可涂：空列表时**自动建第一条**。
   * 为什么自动建而不是弹输入框：笔刷一旦"点了没反应"就等同于功能没做
   * （本项目已把「工具点了没反应」列为一类缺陷）。命名可事后在聚落详情面板里改。
   */
  function ensureList(channel) {
    if (!planetId()) return 0;
    if (listOf(channel).length) return 1;
    return createEntry(channel) ? 1 : 0;
  }

  /** 面板上的「＋ 新建」按钮 */
  function createEntry(channel) {
    const pid = planetId();
    if (!pid) return 0;
    const n = listOf(channel).length + 1;
    if (n > CHANNEL_MAX_INDEX) { onStatus && onStatus('条目已达上限（255）'); return 0; }
    const item = {
      id: Date.now(),
      name: CHANNEL_LABELS[channel] + n,
      color: CULTURE_COLORS[(n - 1) % CULTURE_COLORS.length],
    };
    const created = channel === 'culture' ? store.addCulture(pid, item) : store.addReligion(pid, item);
    if (!created) { onStatus && onStatus('新建失败（可能未打开项目）'); return 0; }
    setValue(channel, n);          // 通道值 = 位置（1 起），与数据层口径一致
    onStatus && onStatus(`已新建「${created.name}」`);
    return 1;
  }

  // ── 笔刷预览 / 脏矩形 ───────────────────────────────────────────────────
  // 预览圈**复用**高度笔刷那条渲染通道（`drawHeightBrushPreview` 读的是
  // `planetHeightBrush.brushPreview`）—— 三个模式互斥，不会互相抢。
  function updatePreview(x, y) {
    if (previewSink && previewSink.brushPreview) {
      previewSink.brushPreview.value = { x, y, radius: brushRadius.value };
    }
  }
  function clearPreview() {
    if (previewSink && previewSink.brushPreview) previewSink.brushPreview.value = null;
  }
  function markDirty(x, y) {
    if (renderer && renderer.markDirtyRect) {
      renderer.markDirtyRect(brushSegmentRect(lastPaintPos, { x, y }, brushRadius.value + 1));
    }
    lastPaintPos = { x, y };
  }

  // ── 笔画生命周期 ───────────────────────────────────────────────────────
  function begin(channel, x, y) {
    const pid = planetId();
    if (!pid) return false;
    if (!ensureList(channel)) { onStatus && onStatus('还没有可涂的' + CHANNEL_LABELS[channel] + '：请先新建项目'); return false; }
    const res = store.beginChannelStroke(pid, channel, { afterWrite: () => renderer && renderer.requestRender() });
    if (!res || res.ok !== true) {
      onStatus && onStatus(res && res.reason === 'readonly'
        ? `编辑已停用：${store.readOnlyReason || '未打开项目'}`
        : `无法涂抹${CHANNEL_LABELS[channel]}：这张地图还没有高度图（先点工具栏「创建高度图」）`);
      return false;
    }
    lastPaintPos = null;
    isBrushing.value = true;
    const v = valueOf(channel);
    if (!v) { onStatus && onStatus(`请先选择要涂的${CHANNEL_LABELS[channel]}`); return true; }
    store.applyChannelStroke(pid, channel, x, y, brushRadius.value, brushHardness.value, v);
    updatePreview(x, y);
    markDirty(x, y);
    renderer && renderer.requestRender();
    return true;
  }

  function move(channel, x, y) {
    updatePreview(x, y);
    if (!isBrushing.value) { renderer && renderer.requestRender(); return 0; }
    const pid = planetId();
    const v = valueOf(channel);
    if (!pid || !v) return 0;
    const n = store.applyChannelStroke(pid, channel, x, y, brushRadius.value, brushHardness.value, v);
    markDirty(x, y);
    renderer && renderer.requestRender();
    return n;
  }

  function end() {
    isBrushing.value = false;
    clearPreview();
    const r = store.endChannelStroke();
    if (r && r.changed) onStatus && onStatus(`已涂 ${r.changed} 格（一次拖动 = 一条撤销，可 Ctrl+Z）`);
    renderer && renderer.requestRender();
    return r;
  }

  function cancel() {
    isBrushing.value = false;
    clearPreview();
    store.cancelChannelStroke();
    renderer && renderer.requestRender();
  }

  // ── 吸管（B1）：把落点那一格的通道值取回当前笔刷 ────────────────────────
  function pick(channel, x, y) {
    pickMode.value = null;
    const pid = planetId();
    if (!pid) return 0;
    const cell = store.pickChannelCell(pid, x, y);
    if (!cell) { onStatus && onStatus('吸管：这里没有网格（先创建高度图）'); return 0; }
    const v = cell[channel] | 0;
    if (!v) { onStatus && onStatus(`吸管：这一格还没有${CHANNEL_LABELS[channel]}归属`); return 0; }
    if (v > listOf(channel).length) { onStatus && onStatus(`吸管：这一格指向第 ${v} 号${CHANNEL_LABELS[channel]}，但列表里只有 ${listOf(channel).length} 条`); return 0; }
    setValue(channel, v);
    onStatus && onStatus(`吸管：已取「${nameOfValue(channel, v)}」—— 现在可以直接涂`);
    renderer && renderer.requestRender();
    return v;
  }

  function armPick(channel) {
    pickMode.value = channel;
    onStatus && onStatus(`吸管待命：点一下地图上已有的${CHANNEL_LABELS[channel]}即可取色`);
  }

  return {
    brushRadius, brushHardness, isBrushing, pickMode, valueByChannel,
    cultureOptions, religionOptions,
    listOf, valueOf, setValue, nameOfValue, createEntry, ensureList,
    begin, move, end, cancel, pick, armPick,
    updatePreview, clearPreview,
  };
}
