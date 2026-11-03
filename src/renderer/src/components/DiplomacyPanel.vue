<script setup>
// components/DiplomacyPanel.vue
// 外交表 UI（N3a-2，2026-11-02）—— 回答“某年 A 与 B 什么关系”。
//
// 数据来源（**只读**，不新建第二份真值）：
//   · 剧本对象 / 势力表：`store.getScenario(id)` —— 剧本只有 store 一份，势力就是 `scenario.polities`；
//   · 事件表：`scenario.timelineEvents`，经 `timelineEventsOf()` 取（没录过 = 空数组，不返回 undefined）；
//   · 单个配对的关系：`store.queryRelationAt()`（内部就是 `relationBetween` + `describeRelation`，
//     全仓唯一实现；本组件不自己比较日期窗口）；
//   · 矩阵：`relationsAt()`（矩阵查询的唯一实现，与单个配对同一条语义）；
//   · 年份：父级 `ScenarioMap` 的 `tlDate`（时间轴游标 = 唯一真源）经 `date` prop 传入、
//     `update:date` 回写，本组件**不持有第二个年份状态**。
//
// 🔴 只读纪律：这里不调用任何 store 写口、不走 undo、不落盘 —— 外交关系只从这里查。
//    （年份步进只移动时间轴游标，改的是 UI 游标，不是世界观数据。）
//
// 样式：只用 Tailwind utilities + 内联色值。刻意**不依赖 `.theme-*` 的 CSS 变量** ——
//   父级把它 Teleport 到 body（与既有生成类浮层同一做法），出了主题作用域变量会断，
//   所以关系色写死成字面色值（深色面板，与既有 `.gen-float` 同族）。
import { computed, ref, watch } from 'vue';
import { useGeodataStore } from '../store/geodata';
import Icon from './Icon.vue';
import {
  RELATIONS, RELATION_LABELS, typeLabel, formatEventSpan, timelineEventsOf,
  activeEventsAt, relationsAt,
} from '../utils/scenarioEventLedger';
import { polityName, polityColor, formatDate } from '../utils/scenarioTimeline';

/** 矩阵上限：超过这个数就不画（12×12 已经很密，再多只会挤成一团） */
const MATRIX_MAX = 12;
const NEUTRAL_LABEL = RELATION_LABELS[RELATIONS.NEUTRAL];

const props = defineProps({
  /** 当前剧本 id（`scenario.id` = store 字典键）；空 = 没有剧本 */
  scenarioId: { type: String, default: '' },
  /** 时间轴游标 `{ y, m, d }`（月日可缺省）—— 唯一真源在父级 */
  date: { type: Object, default: null },
});
const emit = defineEmits(['update:date', 'close']);

const store = useGeodataStore();

// ── 数据（全部只读）────────────────────────────────────────────────────────
const scenario = computed(() => (props.scenarioId ? store.getScenario(props.scenarioId) : null));
const events = computed(() => timelineEventsOf(scenario.value));
/** 势力清单：与 store 内部所有枚举点同源（`scenario.polities`），不做第二份派生 */
const polities = computed(() => (scenario.value?.polities || []).filter((p) => p && p.id !== undefined && p.id !== null));

// ── 年份：父级游标为真源，缺省时回落到剧本起年（只用于显示/查询，不回写）──
function firstYear(...cands) {
  for (const c of cands) {
    const n = Number(c);
    if (Number.isFinite(n) && n !== 0) return Math.trunc(n);
  }
  return 0;
}
const year = computed(() => firstYear(
  props.date && props.date.y,
  scenario.value?.era?.startYear,
  events.value[0] && events.value[0].from && events.value[0].from.y,
));
const queryDate = computed(() => {
  const raw = props.date || {};
  const rawY = Number(raw.y);
  const same = Number.isFinite(rawY) && Math.trunc(rawY) === year.value;
  return {
    y: year.value,
    m: same ? (raw.m === undefined ? null : raw.m) : null,
    d: same ? (raw.d === undefined ? null : raw.d) : null,
  };
});
const dateText = computed(() => formatDate(queryDate.value) || String(year.value));
const eraText = computed(() => {
  const era = scenario.value?.era || {};
  const s = Number(era.startYear);
  const e = Number(era.endYear);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return '';
  return `本剧本 ${Math.trunc(s)} ~ ${Math.trunc(e)}`;
});

function setYear(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return;
  // 只改年 → 月日原样带回（否则“在面板里点一下年份”会把用户精确到日的游标悄悄抹成 1-1）
  emit('update:date', {
    y: Math.trunc(n),
    m: queryDate.value.m ?? null,
    d: queryDate.value.d ?? null,
  });
}
function onYearChange(e) {
  const v = e && e.target ? e.target.value : '';
  if (v === '') { if (e && e.target) e.target.value = String(year.value); return; }
  setYear(v);
}
function stepYear(delta) {
  setYear(year.value + delta);
}

// ── 甲 / 乙 选择 ────────────────────────────────────────────────────────────
const aId = ref('');
const bId = ref('');
function idsOf(list) { return (list || []).map((p) => p.id); }
function sameId(x, y) { return String(x) === String(y); }
function otherThan(id) {
  return idsOf(polities.value).find((x) => !sameId(x, id));
}
function ensurePair() {
  const ids = idsOf(polities.value);
  if (!ids.some((id) => sameId(id, aId.value))) aId.value = ids.length ? ids[0] : '';
  if (!ids.some((id) => sameId(id, bId.value)) || sameId(bId.value, aId.value)) {
    bId.value = otherThan(aId.value) ?? '';
  }
}
watch(() => idsOf(polities.value).map(String).join('|'), ensurePair, { immediate: true });
watch(aId, (v) => {
  if (v === '' || !sameId(v, bId.value)) return;
  const alt = otherThan(v);
  bId.value = alt === undefined ? '' : alt;
});
watch(bId, (v) => {
  if (v === '' || !sameId(v, aId.value)) return;
  const alt = otherThan(v);
  if (alt === undefined) bId.value = '';   // 只有一个势力：留空，别把甲也清掉
  else aId.value = alt;                    // 甲/乙撞了 → 换一位（选择的仍是这两方）
});

/** 点矩阵格子 = 把这一对设为甲 / 乙（"两次点击答一个问题"的另一条路，仍然只读） */
function pickPair(rowId, colId) {
  if (sameId(rowId, colId)) return;
  aId.value = rowId;
  bId.value = colId;
}

// ── 单个配对：关系 + 生效事件 + “为什么” ──────────────────────────────────
const pair = computed(() => {
  if (!scenario.value || !props.scenarioId) return null;
  if (aId.value === '' || bId.value === '' || sameId(aId.value, bId.value)) return null;
  const r = store.queryRelationAt(props.scenarioId, aId.value, bId.value, queryDate.value);
  return r && r.ok ? r : null;
});
const nameA = computed(() => polityName(scenario.value, aId.value));
const nameB = computed(() => polityName(scenario.value, bId.value));
const colorA = computed(() => polityColor(scenario.value, aId.value));
const colorB = computed(() => polityColor(scenario.value, bId.value));

/** 该年**同时涉及这两方**的全部生效事件（含记事：它不改关系，但用户要看得见） */
const pairEvents = computed(() => {
  if (!pair.value) return [];
  return activeEventsAt(events.value, queryDate.value).filter((ev) => {
    const actors = (Array.isArray(ev.actors) ? ev.actors : []).map(String);
    return actors.includes(String(aId.value)) && actors.includes(String(bId.value));
  });
});

const spanText = computed(() => {
  const p = pair.value;
  if (!p || !p.since) return '';
  return formatEventSpan({ from: p.since, to: p.until });
});

/** “为什么”：点名是哪条事件把关系写成现在的样子（没记录就直说没记录） */
const why = computed(() => {
  const p = pair.value;
  if (!p) return '';
  if (!p.known) {
    return `账本里没有针对“${nameA.value} × ${nameB.value}”、在 ${dateText.value} 生效的关系事件`
      + '（中立 ≠ 确定和平：也可能只是还没录）';
  }
  const what = `${typeLabel(p.type)}${p.title ? `“${p.title}”` : ''}`;
  const tail = p.eventId ? ` · ${p.eventId}` : '';
  return `由 ${what} 确立（${spanText.value || dateText.value}${tail}）`;
});

// ── 关系配色（字面色值，不依赖主题变量；未知关系回落到中立）──────────────────
const RELATION_STYLE = {
  [RELATIONS.NEUTRAL]: { dot: '#94a3b8', bg: 'rgba(148, 163, 184, 0.18)', fg: '#cbd5e1' },
  [RELATIONS.ALLY]: { dot: '#34d399', bg: 'rgba(52, 211, 153, 0.18)', fg: '#6ee7b7' },
  [RELATIONS.FRIENDLY]: { dot: '#60a5fa', bg: 'rgba(96, 165, 250, 0.18)', fg: '#93c5fd' },
  [RELATIONS.SUSPICIOUS]: { dot: '#fbbf24', bg: 'rgba(251, 191, 36, 0.18)', fg: '#fcd34d' },
  [RELATIONS.ENEMY]: { dot: '#f87171', bg: 'rgba(248, 113, 113, 0.22)', fg: '#fca5a5' },
  [RELATIONS.RIVAL]: { dot: '#fb923c', bg: 'rgba(251, 146, 60, 0.22)', fg: '#fdba74' },
  [RELATIONS.VASSAL]: { dot: '#a78bfa', bg: 'rgba(196, 181, 253, 0.18)', fg: '#c4b5fd' },
  [RELATIONS.SUZERAIN]: { dot: '#818cf8', bg: 'rgba(129, 140, 248, 0.22)', fg: '#a5b4fc' },
};
function styleOf(relation) {
  return RELATION_STYLE[relation] || RELATION_STYLE[RELATIONS.NEUTRAL];
}
const chipStyle = computed(() => {
  const s = styleOf(pair.value ? pair.value.relation : RELATIONS.NEUTRAL);
  return { background: s.bg, color: s.fg };
});
const dotStyle = computed(() => ({ background: styleOf(pair.value ? pair.value.relation : RELATIONS.NEUTRAL).dot }));

// ── 矩阵 ────────────────────────────────────────────────────────────────────
const matrix = computed(() => relationsAt(events.value, queryDate.value, {
  polityIds: polities.value.map((p) => p.id),
}));

function cellFor(rowId, colId) {
  const row = matrix.value.byPolity[String(rowId)];
  return (row && row[String(colId)]) || null;
}
function cellLabel(rowId, colId) {
  const cell = cellFor(rowId, colId);
  return cell ? cell.label : NEUTRAL_LABEL;
}
function cellStyle(rowId, colId) {
  const cell = cellFor(rowId, colId);
  if (!cell) return { color: '#64748b', background: 'transparent' };
  const s = styleOf(cell.relation);
  return { color: s.fg, background: s.bg };
}
function cellTitle(row, col) {
  const cell = cellFor(row.id, col.id);
  const rel = cell ? `${cell.label}（${typeLabel(cell.type)}${cell.title ? `“${cell.title}”` : ''} ${formatEventSpan({ from: cell.since, to: cell.until })}）` : NEUTRAL_LABEL;
  return `${row.name || row.id} × ${col.name || col.id}：${rel}\n点这里把这一对设为甲 / 乙`;
}
function shortName(p) {
  return String(p.abbr || p.name || p.id).slice(0, 4);
}
</script>

<template>
  <div
    class="w-[min(780px,calc(100vw-3rem))] max-h-[calc(100vh-8rem)] overflow-auto rounded-xl border border-slate-600 bg-slate-900/95 p-4 text-[13px] text-slate-200 shadow-2xl"
    data-testid="diplomacy-panel"
  >
    <!-- 头部：标题 + 只读徽标 + 当前剧本 -->
    <div class="mb-3 flex items-start gap-2">
      <span class="mt-0.5 text-sky-300"><Icon name="flag" :size="16" /></span>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-sm font-semibold text-slate-100">外交 · 某年谁与谁</span>
          <span class="rounded border border-slate-600 px-1.5 py-0.5 text-[10px] text-slate-400">只读</span>
          <span v-if="scenario" class="truncate text-[11px] text-slate-400">{{ scenario.name }}</span>
        </div>
        <div class="mt-1 text-[11px] leading-relaxed text-slate-400">
          数据来自当前剧本的事件账本（谁和谁 · 什么事 · 起止）。这里只查询，不写盘、不产生撤销。
        </div>
      </div>
      <button
        type="button"
        class="shrink-0 cursor-pointer rounded border border-slate-600 bg-slate-800 px-2 py-0.5 text-xs text-slate-300 hover:bg-slate-700"
        data-testid="diplomacy-close"
        title="关闭外交面板（不影响任何数据）"
        @click="emit('close')"
      >✕ 关闭</button>
    </div>

    <!-- 空状态 1：没有剧本 -->
    <div
      v-if="!scenario"
      class="rounded-lg border border-dashed border-slate-600 bg-slate-800/40 px-4 py-6 text-center text-[12px] leading-relaxed text-slate-400"
      data-testid="diplomacy-empty-scenario"
    >
      没有剧本 —— 先在左侧“历史剧本”里选一个时期（或用“新建 / 管理剧本…”建一个），
      外交关系表才有事件可查。
    </div>

    <template v-else>
      <!-- 甲 / 乙 + 年份 -->
      <div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <label class="flex items-center gap-1 text-slate-400">
          <span class="inline-block h-2.5 w-2.5 rounded-full" :style="{ background: colorA }"></span>甲
          <select
            v-model="aId"
            class="cursor-pointer rounded border border-slate-600 bg-slate-800 px-1.5 py-0.5 text-xs text-slate-200"
            data-testid="diplomacy-a"
            :disabled="!polities.length"
            title="甲方势力（来自当前剧本的势力表）"
          >
            <option v-if="!polities.length" value="">（该剧本没有势力）</option>
            <option v-for="p in polities" :key="'a-' + p.id" :value="p.id">{{ p.name || p.id }}</option>
          </select>
        </label>

        <span class="text-slate-500">×</span>

        <label class="flex items-center gap-1 text-slate-400">
          <span class="inline-block h-2.5 w-2.5 rounded-full" :style="{ background: colorB }"></span>乙
          <select
            v-model="bId"
            class="cursor-pointer rounded border border-slate-600 bg-slate-800 px-1.5 py-0.5 text-xs text-slate-200"
            data-testid="diplomacy-b"
            :disabled="polities.length < 2"
            title="乙方势力（来自当前剧本的势力表）"
          >
            <option v-if="!polities.length" value="">（该剧本没有势力）</option>
            <option v-for="p in polities" :key="'b-' + p.id" :value="p.id">{{ p.name || p.id }}</option>
          </select>
        </label>

        <span class="mx-1 h-4 w-px bg-slate-600"></span>

        <label class="flex items-center gap-1 text-slate-400" title="改年份 = 移动时间轴游标（画布年份一起变）；这里查的就是游标那一天">
          年份
          <button
            type="button"
            class="cursor-pointer rounded border border-slate-600 bg-slate-800 px-1.5 py-0.5 text-xs text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="diplomacy-year-prev"
            title="上一年"
            @click="stepYear(-1)"
          >−</button>
          <input
            type="number"
            class="w-20 rounded border border-slate-600 bg-slate-800 px-1.5 py-0.5 text-xs text-slate-100"
            data-testid="diplomacy-year"
            :value="year"
            title="年份（回车或失焦生效）"
            @change="onYearChange"
          />
          <button
            type="button"
            class="cursor-pointer rounded border border-slate-600 bg-slate-800 px-1.5 py-0.5 text-xs text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="diplomacy-year-next"
            title="下一年"
            @click="stepYear(1)"
          >＋</button>
        </label>

        <span v-if="eraText" class="text-[11px] text-slate-500">{{ eraText }}</span>
        <span v-if="scenario && !events.length" class="text-[11px] text-amber-200">该剧本没有时间线事件</span>
      </div>

      <!-- 空状态 2：没有时间线事件 -->
      <div
        v-if="!events.length"
        class="rounded-lg border border-dashed border-slate-600 bg-slate-800/40 px-4 py-5 text-[12px] leading-relaxed text-slate-400"
        data-testid="diplomacy-empty-events"
      >
        没有时间线事件 —— 这个剧本的 <code class="text-slate-300">timelineEvents</code> 还是空的。
        先录一条“谁和谁、什么事、起止”（战争 / 同盟 / 臣属 / 和约…），这里才会出现关系。
      </div>

      <template v-else>
        <!-- 结果 -->
        <div class="mb-3 rounded-lg border border-slate-700 bg-slate-800/60 p-3" data-testid="diplomacy-result">
          <div v-if="!pair" class="text-[12px] leading-relaxed text-slate-400">
            选择两个<b>不同</b>的势力（甲 / 乙），就能查出“这一年的它们是什么关系”。
          </div>
          <template v-else>
            <div class="flex flex-wrap items-center gap-2">
              <span class="inline-block h-3 w-3 rounded-full" :style="dotStyle"></span>
              <span class="rounded px-2 py-0.5 text-sm font-semibold" :style="chipStyle">{{ pair.label }}</span>
              <span class="text-slate-300">{{ nameA }} × {{ nameB }}</span>
              <span class="text-[11px] text-slate-500">@ {{ dateText }}</span>
              <span v-if="spanText" class="text-[11px] text-slate-400">生效窗口 {{ spanText }}</span>
            </div>

            <!-- store 的同一句话答案（describeRelation；与命令行同源） -->
            <div class="mt-2 text-[12px] leading-relaxed text-slate-300">{{ pair.text }}</div>

            <!-- 为什么 = 哪条事件把关系写成现在这样 -->
            <div class="mt-1 text-[12px] leading-relaxed" :class="pair.known ? 'text-amber-200' : 'text-slate-400'">
              <span class="font-semibold">为什么：</span>{{ why }}
            </div>

            <!-- 该年生效的双方事件 -->
            <div class="mt-2 border-t border-slate-700/70 pt-2">
              <div class="text-[11px] text-slate-400">
                该年生效的双方事件（{{ pairEvents.length }}）
                <span class="text-slate-500">· 记事类不改关系，但同样列出来</span>
              </div>
              <div v-if="!pairEvents.length" class="mt-1 text-[11px] leading-relaxed text-slate-500" data-testid="diplomacy-no-relation">
                该年两方无关系：账本里没有任何在这两方之间生效的事件（中立）。
              </div>
              <ul v-else class="mt-1 space-y-1">
                <li
                  v-for="(ev, i) in pairEvents"
                  :key="ev.id || ('ev-' + i)"
                  class="flex flex-wrap items-center gap-2 text-[11px] text-slate-300"
                >
                  <span class="rounded bg-slate-700/70 px-1.5 py-0.5 text-slate-200">{{ typeLabel(ev.type) }}</span>
                  <span class="min-w-0 truncate">{{ ev.title || ev.id || '（无标题）' }}</span>
                  <span class="text-slate-400">{{ formatEventSpan(ev) }}</span>
                </li>
              </ul>
            </div>
          </template>
        </div>

        <!-- 矩阵 -->
        <div class="rounded-lg border border-slate-700 bg-slate-800/40 p-3" data-testid="diplomacy-matrix">
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <span class="text-[12px] font-semibold text-slate-200">关系矩阵 · {{ dateText }}</span>
            <span class="text-[11px] text-slate-400">行 = 甲，列 = 乙；共 {{ polities.length }} 个势力</span>
          </div>

          <div v-if="polities.length > MATRIX_MAX" class="text-[11px] leading-relaxed text-amber-200" data-testid="diplomacy-matrix-hint">
            势力共 {{ polities.length }} 个（超过 {{ MATRIX_MAX }} 个）—— 矩阵会挤成一团，已收起。
            请用上方甲 / 乙查询单个配对。
          </div>
          <div v-else-if="polities.length < 2" class="text-[11px] text-slate-400" data-testid="diplomacy-matrix-hint">
            这个剧本还不到两个势力，没有可比的配对。
          </div>

          <div v-else class="max-h-72 overflow-auto">
            <table class="border-collapse text-[10px]">
              <thead>
                <tr>
                  <th class="px-1 py-0.5"></th>
                  <th
                    v-for="p in polities"
                    :key="'mh-' + p.id"
                    class="px-1 py-0.5 text-center font-normal text-slate-400"
                    :title="p.name || p.id"
                  >{{ shortName(p) }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in polities" :key="'mr-' + row.id">
                  <th class="px-1 py-0.5 text-right font-normal text-slate-400" :title="row.name || row.id">
                    {{ shortName(row) }}
                  </th>
                  <td
                    v-for="col in polities"
                    :key="'mc-' + row.id + '-' + col.id"
                    class="border border-slate-700/70 p-0 text-center"
                  >
                    <button
                      v-if="!sameId(row.id, col.id)"
                      type="button"
                      class="block w-full min-w-[3.25rem] cursor-pointer px-1 py-0.5 text-center hover:brightness-125"
                      :style="cellStyle(row.id, col.id)"
                      :title="cellTitle(row, col)"
                      @click="pickPair(row.id, col.id)"
                    >{{ cellLabel(row.id, col.id) }}</button>
                    <span v-else class="block w-full min-w-[3.25rem] px-1 py-0.5 text-slate-600">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="mt-2 text-[10px] leading-relaxed text-slate-500">
            “{{ NEUTRAL_LABEL }}”有两层意思：账本里没有这一对的事件，或事件已到期 ——
            想知道是哪一种，点开该格子看上方结果里的“为什么”。
          </div>
        </div>
      </template>
    </template>
  </div>
</template>
