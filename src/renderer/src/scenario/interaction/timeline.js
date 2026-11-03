// interaction/timeline.js — 剧本视图（N1.5 拆分，2026-11-02）
//
// 由 `build/_n15.cjs` 从 ScenarioMap.vue **逐字搬出**（只搬函数，ref/computed/watch 仍留在 SFC）：
//   onPanelReject / onSaveSlicePoint / onTimelineSelectScenario / scenarioMeta / selectScenarioAt /
//   onTimelineSetYear / onDiplomacySetDate / daysInMonthOf / resetTimelineToStart。
// 依赖约定：`ctx` = 组件侧传入的 ref / 函数（搬出后仍读写同名同一份）；
//   纯函数工具直接 import。**不许在这里另立第二份状态**（tlDate 仍是唯一真源）。
//
// ⚠️ 归属边界：`tlDate`/`tlEra`/`tlPlaying`/`viewMode`/`timeline` 都是 SFC 的 ref，
//   本模块只读/写它们；watch（`tlPlaying` 续播、`tlDate.y` → era、`tlEra` → 选中）留 SFC ——
//   注册顺序是行为的一部分（见 SFC 里 onMounted 的注释），搬进来就会改顺序。

import { formatDate } from '../../utils/scenarioTimeline';

export function createTimelineActions(ctx) {
  const {
    askText,
    render,
    selectedPolity,
    selectedScenario,
    sortedScenarios,
    statusMsg,
    store,
    timeline,
    tlDate,
    tlEra,
    tlPlaying,
    viewMode,
  } = ctx;

/** 面板里的输入被拒（越界年份等）：拒绝必须有回音 —— 静默吞掉等于用户以为改成功了 */
function onPanelReject({ what = '输入', reason = '' } = {}) {
  statusMsg(`${what}未写入：${reason || '不合法'}`);
}

/** 把当前游标存为切片点（带默认名 = 日期文本），走 store 的一条 undo */
async function onSaveSlicePoint() {
  if (store.isReadOnly) {
    statusMsg(`只读：${store.readOnlyReason || '未打开项目'} —— 切片点未保存`);
    return;
  }
  if (!timeline.value.years.length) { statusMsg('还没有剧本，无法存切片点'); return; }
  const d = tlDate.value;
  const label = await askText({ title: '切片点名称（留空则显示日期）', defaultValue: formatDate(d) });
  if (label === null) return;                       // 取消
  const r = store.addSlicePoint({ y: d.y, m: d.m, d: d.d }, label || '');
  if (!r || r.success === false) { statusMsg(`切片点未保存：${r?.reason || '未知原因'}`); return; }
  statusMsg(`已存切片点“${label || formatDate(d)}”（${formatDate(d)}）—— 切片导出会默认带上它（可 Ctrl+Z 撤回）`);
  render();
}

/** 时间轴切剧本时同步选中态（编辑目标跟着走） */
function onTimelineSelectScenario(s) {
  if (s && selectedScenario.value?.id !== s.id) {
    selectedScenario.value = s;
    selectedPolity.value = null;   // 跨剧本 polity id 全新，留着必然落空
  }
  render();
}

/**
 * 剧本列表条目的一句话摘要（EU4 那张“选择历史时期”列表里的第二行）。
 * 势力数 = 本剧本定义的势力数；省数 = 本剧本 ownership 里**真有归属**的省份数
 * （值为空/缺失 = 无主，不计入 —— 地图上显示灰，不该被算成"这个势力的地盘"）。
 */
function scenarioMeta(s) {
  const polities = (s?.polities || []).length;
  const own = s?.ownership || {};
  const owned = Object.keys(own).filter((pid) => own[pid]).length;
  return `${polities} 势力 · ${owned} 省`;
}

/**
 * “选择历史时期”：点列表一条 = **切剧本 + 地图跳到该时期起始年 + 时间轴游标同步**。
 *
 * 🔴 为什么必须三件事一起做（而不是只改 selectedScenario）：
 *    ① 只改 selectedScenario → 地图着色不动（游标还在旧年份）→ 看着像"设置项"不是"时期选择器"；
 *    ② 只改游标 → 编辑目标（势力色板 / 归属写入落到哪个剧本）还停在旧剧本 → **写错地方**。
 *    三件一起才是 EU4 里“点一条，地图变成那一年的世界”这个动作的完整语义。
 * 年份取 `timeline.years[idx].start`（而非 `s.era.startYear`）：与轨道、播放同一口径，
 * 避免"列表说 2044、游标落到 2043"这种只有对齐时才发现的不一致。
 */
function selectScenarioAt(s) {
  const idx = sortedScenarios.value.findIndex((x) => x && s && x.id === s.id);
  if (idx < 0) return false;
  tlPlaying.value = false;
  tlEra.value = idx;
  const start = timeline.value?.years?.[idx]?.start;
  if (Number.isFinite(start)) tlDate.value = { y: start, m: null, d: null };
  if (selectedScenario.value?.id !== s.id) {
    selectedScenario.value = s;
    selectedPolity.value = null;
  }
  // 从底图编辑里点列表 = 想去看/改政治版图 → 顺带切到剧本模式（否则改了看不见）
  if (viewMode.value !== 'scenario') viewMode.value = 'scenario';
  render();
  return true;
}

/**
 * 轨道拖拽/点击/键盘给了“年”→ 写回 tlDate。
 * 🔴 月日**归 null**（= 该年 1 月 1 日）而不是保留旧月日：轨道表达的是“到某一年”，
 *    保留 6 月 1 日会让“拖到 1045 年”实际停在 1045-06-01 —— 用户看不见、却影响归属判定。
 *    要精确到日请走“存为切片点”或谱系面板的日期录入。
 */
function onTimelineSetYear(y) {
  const n = Number(y);
  if (!Number.isFinite(n)) return;
  const yy = Math.round(n);
  if (tlDate.value.y === yy && tlDate.value.m === null && tlDate.value.d === null) return;
  tlDate.value = { y: yy, m: null, d: null };
  render();
}

/**
 * 外交面板步进/输入年份 → 移动**同一个**时间轴游标（tlDate 仍是唯一真源）。
 * 与 `onTimelineSetYear` 的差别：面板会带回月日（它只改年时保留用户拖到的月日），
 * 所以这里不把 m/d 归 null —— 归 null 会让“面板里点一下年份”把精确到日的游标悄悄抹掉。
 */
function onDiplomacySetDate(next) {
  if (!next) return;
  const n = Number(next.y);
  if (!Number.isFinite(n)) return;
  const yy = Math.trunc(n);
  const m = next.m === undefined ? null : next.m;
  const d = next.d === undefined ? null : next.d;
  if (tlDate.value.y === yy && tlDate.value.m === m && tlDate.value.d === d) return;
  tlDate.value = { y: yy, m, d };
  render();
}

/** 该年在该月的天数（播放插值用；与 scenarioDates 同口径，闰年照算） */
function daysInMonthOf(y, m) {
  const v = Math.abs(y);
  const feb = (v % 4 === 0 && v % 100 !== 0) || v % 400 === 0 ? 29 : 28;
  return [31, feb, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/** 初始化/切换底图后把游标落到第一个剧本 */
function resetTimelineToStart() {
  const tl = timeline.value;
  if (!tl.years.length) { tlEra.value = 0; tlDate.value = { y: 0, m: null, d: null }; return; }
  tlEra.value = 0;
  tlDate.value = { y: tl.years[0].start, m: null, d: null };
  // 进入剧本模块时默认就是“政治视图”——否则省份按生物群系着色，时间轴等于白拖
  if (viewMode.value !== 'scenario') viewMode.value = 'scenario';
}

  return {
    onPanelReject,
    onSaveSlicePoint,
    onTimelineSelectScenario,
    scenarioMeta,
    selectScenarioAt,
    onTimelineSetYear,
    onDiplomacySetDate,
    daysInMonthOf,
    resetTimelineToStart,
  };
}
