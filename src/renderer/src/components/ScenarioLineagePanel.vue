<template>
  <div v-if="open" class="slp-overlay" @click.self="emit('close')">
    <div class="slp-dialog" data-testid="lineage-panel">
      <div class="slp-head">
        <span class="slp-title"><Icon name="git-branch" :size="15"/> 势力谱系管理</span>
        <span class="slp-sub">{{ timeline.stats.scenarios }} 剧本 · {{ timeline.stats.provinces }} 省 ·
          自动匹配 {{ timeline.lineages.length }} 条谱系<template v-if="timeline.explicitLineageCount"> ·
          <b>人工 {{ timeline.explicitLineageCount }} 条</b></template>
        </span>
        <span class="slp-spacer"></span>
        <button class="slp-x" @click="emit('close')" title="关闭"><Icon name="x" :size="14"/></button>
      </div>

      <div class="slp-tabs">
        <button :class="{ active: tab === 'lineage' }" data-testid="slp-tab-lineage"
                @click="tab = 'lineage'">谱系纠正</button>
        <button :class="{ active: tab === 'years' }" data-testid="slp-tab-years"
                @click="tab = 'years'">易主年份</button>
      </div>

      <!-- Tab 1：谱系纠正 -->
      <div v-if="tab === 'lineage'" class="slp-body">
        <p class="slp-note">
          自动匹配按「相邻剧本的省份重叠度」推断继承关系。若推断错了，用
          <b>承自</b> 指向前一剧本的势力即可 —— 这会同时改变「变化图层」的判定。
        </p>

        <div class="slp-era" v-for="k in eraList" :key="'e' + k">
          <div class="slp-era-head">
            <span class="slp-era-name">{{ timeline.scenarios[k].name }}</span>
            <span class="slp-era-range">{{ timeline.years[k].start }} ~ {{ timeline.years[k].end }}</span>
            <span v-if="k > 0" class="slp-era-badge">{{ timeline.eraChg[k].changed.length }} 省变化</span>
          </div>

          <table class="slp-table">
            <thead>
              <tr>
                <th>势力</th><th>省</th><th>谱系</th>
                <th v-if="k > 0">承自（上一剧本）</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rowsOf(k)" :key="row.polityId"
                  :class="{ 'is-explicit': row.explicit }">
                <td>
                  <span class="slp-dot" :style="{ background: row.color }"></span>{{ row.name }}
                </td>
                <td class="slp-num">{{ row.provinceCount }}</td>
                <td class="slp-num">
                  <span :title="row.explicit ? '人工指定' : '自动匹配'">
                    L{{ row.lineage }}<b v-if="row.explicit">*</b>
                  </span>
                </td>
                <td v-if="k > 0">
                  <select class="slp-select" :value="row.successorOf || ''"
                          :data-testid="`slp-succ-${k}-${row.polityId}`"
                          @change="onSuccessorChange(k, row, $event.target.value)">
                    <option value="">（自动匹配）</option>
                    <option v-for="p in prevPolities(k)" :key="p.id" :value="p.id">
                      {{ p.name }}{{ p.lineageHint ? ` · L${p.lineageHint}` : '' }}
                    </option>
                  </select>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Tab 2：易主日期（月日精度） -->
      <div v-else class="slp-body">
        <p class="slp-note">
          未显式指定时，易主日期按「本剧本内均匀铺开」推算（<b>合成值</b>，不是史料）。
          日期可精确到<b>月日</b>：月/日留空 = 只到年（语义 = 该年 1 月 1 日）。
          同一年可以录<b>多次</b>易主（在这一代里换了两次主人），逐条按日期生效。
          在时间轴上任一日期用油漆桶上色，也会自动写入该日的显式值。清空即回到推算。
        </p>
        <div v-if="!yearRows.length" class="slp-empty">当前剧本没有谱系变化省份。</div>
        <template v-else>
          <!-- 录入进度 + 批量操作（2026-10-02）：逐个改是 N 条 undo，且「这一代都定在某日」要写 N 遍 -->
          <div class="slp-bulk">
            <span class="slp-stat" data-testid="slp-cy-stat">
              本剧本 <b>{{ yearRows.length }}</b> 省易主（{{ eventTotal }} 条事件）：显式
              <b :class="{ warn: explicitCount === 0 }">{{ explicitCount }}</b> / 自动推算
              <b :class="{ warn: yearRows.length - explicitCount > 0 }">{{ yearRows.length - explicitCount }}</b>
              <span class="slp-range">（区间 {{ eraRange.start }} ~ {{ eraRange.end }}）</span>
            </span>
            <span class="slp-spacer"></span>
            <span class="slp-bulklabel">批量：</span>
            <input class="slp-input slp-y" type="number" v-model="bulkY"
                   :placeholder="String(eraRange.start)" title="年" data-testid="slp-cy-bulk-input" />
            <span class="slp-dash">-</span>
            <input class="slp-input slp-md" type="number" min="1" max="12" v-model="bulkM"
                   title="月（留空 = 只到年）" placeholder="月" data-testid="slp-cy-bulk-month" />
            <span class="slp-dash">-</span>
            <input class="slp-input slp-md" type="number" min="1" max="31" v-model="bulkD"
                   title="日（留空 = 只到月）" placeholder="日" data-testid="slp-cy-bulk-day" />
            <button class="slp-mini" data-testid="slp-cy-bulk-set"
                    :disabled="!bulkDateValid"
                    :title="bulkDateValid ? `把本剧本全部 ${yearRows.length} 个变化省的易主日期设为该值（一条 undo）` : bulkInvalidReason"
                    @click="applyBulkSet">统一设为该日</button>
            <button class="slp-mini" data-testid="slp-cy-bulk-snap"
                    title="把当前自动推算的日期固化成显式值（之后可逐个微调；一条 undo）"
                    @click="applyBulkSnap">固化推算值</button>
            <button class="slp-mini" data-testid="slp-cy-bulk-clear"
                    :disabled="!explicitCount"
                    title="清空本剧本全部显式日期，回到自动推算（一条 undo）"
                    @click="applyBulkClear">全部清空</button>
          </div>
          <table class="slp-table">
            <thead>
              <tr><th>省份</th><th>旧主</th><th>新主</th><th>易主日期（年-月-日）</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="r in yearRows" :key="r.pid" :class="{ 'is-explicit': r.explicit }">
                <td>{{ r.name }}</td>
                <td><span class="slp-dot" :style="{ background: r.oldColor }"></span>{{ r.oldName }}</td>
                <td><span class="slp-dot" :style="{ background: r.newColor }"></span>{{ r.newName }}</td>
                <td>
                  <!-- 月日精度（2026-10-05）：年是必填，月/日可留空 = 只到年（语义 = 该年 1 月 1 日） -->
                  <span class="slp-date">
                    <input class="slp-input slp-y" type="number" :value="draftOf(r).y"
                           :class="{ bad: !!r.warn }" :title="r.warn || '易主年份（必填）'"
                           :placeholder="String(eraRange.start)"
                           :data-testid="`slp-cy-${r.pid}`"
                           @change="onDateChange(r, 'y', $event)" />
                    <span class="slp-dash">-</span>
                    <input class="slp-input slp-md" type="number" min="1" max="12" :value="draftOf(r).m"
                           title="月（留空 = 只到年）" placeholder="月"
                           :data-testid="`slp-cym-${r.pid}`"
                           @change="onDateChange(r, 'm', $event)" />
                    <span class="slp-dash">-</span>
                    <input class="slp-input slp-md" type="number" min="1" max="31" :value="draftOf(r).d"
                           title="日（留空 = 只到月）" placeholder="日"
                           :data-testid="`slp-cyd-${r.pid}`"
                           @change="onDateChange(r, 'd', $event)" />
                  </span>
                  <span v-if="r.warn" class="slp-bad" :data-testid="`slp-cywarn-${r.pid}`">{{ r.warn }}</span>
                  <span v-else-if="r.explicit && !r.hasMonth" class="slp-hint-inline"
                        :data-testid="`slp-cyonly-${r.pid}`">只到年</span>
                  <span v-if="r.multi" class="slp-hint-inline" title="本剧本内该省换了多次主人，时间轴按日期逐条生效"
                        :data-testid="`slp-cymulti-${r.pid}`">×{{ r.eventCount }}</span>
                  <span class="slp-eff" :data-testid="`slp-cyeff-${r.pid}`">{{ formatDate(r) }}</span>
                </td>
                <td>
                  <button v-if="r.explicit" class="slp-mini" title="清除显式值，回到自动推算"
                          :data-testid="`slp-cyclear-${r.pid}`"
                          @click="emit('set-change-date', { scenarioId: r.scenarioId, provinceId: r.pid, date: null })">自动</button>
                  <span v-else class="slp-auto">自动</span>
                </td>
              </tr>
            </tbody>
          </table>
        </template>
      </div>

      <div class="slp-foot">
        <span class="slp-hint">改动立即写入 .sitian/scenarios.json（可 Ctrl+Z 撤销）</span>
        <span class="slp-spacer"></span>
        <button @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<script setup>
// P2 势力/谱系管理面板：可视化纠正 successorOf / lineage / 显式易主**日期**（月日精度）
// 纯展示 + 事件：所有写入通过 emit 交给父级调 store（保持 store 调用点集中）
import { ref, computed } from 'vue';
import Icon from './Icon.vue';
import { groupMap } from '../utils/scenarioTimeline';
// 易主日期合法性判定 / 体检的**唯一实现**（与导出链、与用例共用一份；组件里不许再写一套区间比较）
import { validateChangeDateInRange, changeDateStats } from '../utils/scenarioSlices';
import { formatDate } from '../utils/scenarioDates';

const props = defineProps({
  open: { type: Boolean, default: false },
  timeline: { type: Object, required: true },
  currentEra: { type: Number, default: 0 },
  year: { type: Number, default: 0 },
  provinceNames: { type: Object, default: () => ({}) },
});

const emit = defineEmits([
  'close', 'set-polity-lineage',
  // 单省整列表替换（月日精度：一个省一条命令，支持同省多条事件）
  'set-change-date', 'set-change-dates-bulk',
  'reject',
]);

const tab = ref('lineage');
// 批量输入：年必填、月/日可空（留空 = 只到年）
const bulkY = ref('');
const bulkM = ref('');
const bulkD = ref('');
/** 编辑中的草稿（pid → {y,m,d}）：提交后由 watch 清掉，重渲染即回到库里真值 */
const drafts = ref({});

const eraList = computed(() => props.timeline.scenarios.map((_, k) => k));

function rowsOf(k) {
  const tl = props.timeline;
  const s = tl.scenarios[k];
  const g = groupMap(s);
  return (s.polities || [])
    .filter((p) => (g[p.id] || []).length > 0)
    .map((p) => ({
      polityId: p.id,
      name: p.name || p.id,
      color: p.color || '#4a5568',
      provinceCount: (g[p.id] || []).length,
      lineage: tl.lineageOf[k][p.id],
      explicit: !!(p.successorOf || (p.lineage !== undefined && p.lineage !== null && p.lineage !== '')),
      successorOf: p.successorOf || '',
    }))
    .sort((a, b) => b.provinceCount - a.provinceCount);
}

function prevPolities(k) {
  if (k <= 0) return [];
  const tl = props.timeline;
  const g = groupMap(tl.scenarios[k - 1]);
  return (tl.scenarios[k - 1].polities || [])
    .filter((p) => (g[p.id] || []).length > 0)
    .map((p) => ({ id: p.id, name: p.name || p.id, lineageHint: tl.lineageOf[k - 1][p.id] }));
}

function onSuccessorChange(k, row, value) {
  emit('set-polity-lineage', {
    scenarioId: props.timeline.scenarios[k].id,
    polityId: row.polityId,
    successorOf: value || '',
  });
}

const yearRows = computed(() => {
  const tl = props.timeline;
  const k = props.currentEra;
  if (k <= 0) return [];
  const e = tl.eraChg[k];
  const s = tl.scenarios[k];
  const prev = tl.scenarios[k - 1];
  const r = eraRange.value;
  const ctx = {};

  return e.changed.map((pid) => {
    const oldPol = prev.ownership?.[pid];
    const newPol = s.ownership?.[pid];
    const find = (sc, id) => (sc.polities || []).find((p) => p.id === id);
    ctx.old = find(prev, oldPol);
    ctx.new = find(s, newPol);
    // 「这一行显示什么日期」：显式事件优先；没有显式就用合成的那个（同一条判定来自时间轴）
    const events = (e.byProvince && e.byProvince[pid]) || [];
    const display = pickDisplayEvent(events);
    const check = validateChangeDateInRange(display, r.start, r.end);
    return {
      pid,
      scenarioId: s.id,
      name: props.provinceNames[pid] || pid,
      oldName: ctx.old?.name || oldPol || '（无主）',
      oldColor: ctx.old?.color || '#4a5468',
      newName: ctx.new?.name || newPol || '（无主）',
      newColor: ctx.new?.color || '#4a5468',
      // 生效日期（合成时就是那条合成日期）；月日为 null 表示只到年
      y: display.y, m: display.m ?? null, d: display.d ?? null,
      eventCount: events.length,
      explicit: !!e.explicit[pid],
      hasMonth: (display.m ?? null) !== null,
      // 只有「显式录入且越界」才提示 —— 合成值必然落在区间内，不必刷屏
      warn: (!check.ok && e.explicit[pid]) ? check.reason : '',
      // 该省是否有多条事件（同省同年多次易主）—— UI 上标出来，否则用户不知道能录多次
      multi: events.length > 1,
    };
  }).sort((a, b) => a.y - b.y || (a.m || 0) - (b.m || 0) || (a.d || 0) - (b.d || 0) || a.name.localeCompare(b.name));
});

/**
 * 显示用的事件：优先**显式**事件（用户录的），没有则用合成的那条。
 * 为什么不是直接 `events[0]`：合成值只有年，而显式值可能带月日 —— 拿错就会把用户录的月日藏起来。
 */
function pickDisplayEvent(events) {
  if (!events || !events.length) return { y: eraRange.value.start, m: null, d: null };
  const explicit = events.filter((e) => e.explicit);
  const pick = explicit.length ? explicit[explicit.length - 1] : events[events.length - 1];
  return { y: pick.y, m: pick.m ?? null, d: pick.d ?? null };
}

/** 输入框显示值：有草稿用草稿（用户正在编辑），否则用生效日期 */
function draftOf(row) {
  const dft = drafts.value[row.pid];
  if (dft) return dft;
  return { y: row.y, m: row.m, d: row.d };
}

/** 单格编辑 → 组装完整日期 → 提交（越界由 store 拒绝，草稿随即清掉 = 退回库里的真值） */
function onDateChange(row, field, ev) {
  const raw = ev && ev.target ? ev.target.value : '';
  const cur = draftOf(row);
  const next = { y: cur.y, m: cur.m, d: cur.d };
  next[field] = raw === '' ? null : Number(raw);
  // 只到年时把日也清掉（有日无月是脏数据，与 scenarioDates.normalizeDate 同口径）
  if (field === 'm' && next.m === null) next.d = null;
  drafts.value = { ...drafts.value, [row.pid]: next };

  emit('set-change-date', {
    scenarioId: row.scenarioId,
    provinceId: row.pid,
    date: { y: next.y, m: next.m, d: next.d },
    // 提交后无论成功失败都清草稿：成功 → 库里已是新值；失败 → 输入框必须退回库里真值
    done: () => { const { [row.pid]: _, ...rest } = drafts.value; drafts.value = rest; },
  });
}

const explicitCount = computed(() => yearRows.value.filter((r) => r.explicit).length);
/** 事件条数（同省多次易主时 > 省数）—— 体检口径与切片对话框一致 */
const eventTotal = computed(() => (props.timeline.eraChg?.[props.currentEra]?.events || []).length
  || yearRows.value.reduce((a, r) => a + r.eventCount, 0));

const eraRange = computed(() => {
  const y = props.timeline.years?.[props.currentEra] || { start: 0, end: 0 };
  return y;
});

/** 批量日期：年必填；月填了才允许填日（与 store / validateChangeDate 同口径） */
const bulkDate = computed(() => ({
  y: bulkY.value === '' ? NaN : Number(bulkY.value),
  m: bulkM.value === '' ? null : Number(bulkM.value),
  d: bulkD.value === '' ? null : Number(bulkD.value),
}));
const bulkDateValid = computed(() =>
  validateChangeDateInRange(bulkDate.value, eraRange.value.start, eraRange.value.end).ok);
const bulkInvalidReason = computed(() => {
  const v = validateChangeDateInRange(bulkDate.value, eraRange.value.start, eraRange.value.end);
  return v.ok ? '' : (v.reason || '日期不合法');
});

function applyBulkSet() {
  if (!bulkDateValid.value || !yearRows.value.length) return;
  const d = bulkDate.value;
  const patch = {};
  for (const r of yearRows.value) patch[r.pid] = { y: d.y, m: d.m, d: d.d };
  emit('set-change-dates-bulk', { scenarioId: yearRows.value[0].scenarioId, patch, what: '统一设为该日' });
}

/** 固化推算值：把当前**生效**的日期（含合成值）写成显式，之后可逐个微调 */
function applyBulkSnap() {
  if (!yearRows.value.length) return;
  const patch = {};
  for (const r of yearRows.value) patch[r.pid] = { y: r.y, m: r.m, d: r.d };
  emit('set-change-dates-bulk', { scenarioId: yearRows.value[0].scenarioId, patch, what: '固化推算值' });
}

/** 清空：全部回到自动推算（只对有显式值的省发出，避免空转 undo） */
function applyBulkClear() {
  const rows = yearRows.value.filter((r) => r.explicit);
  if (!rows.length) return;
  const patch = {};
  for (const r of rows) patch[r.pid] = null;
  emit('set-change-dates-bulk', { scenarioId: rows[0].scenarioId, patch, what: '全部清空' });
}

/**
 * 面板自用的体检（供 Tab 头部/调试：显式 vs 合成、同省多次易主）；与导出对话框同一份实现。
 * `multiPerProvince` 是月日精度带来的新信息 —— 面板上要能说出「有 N 个省在这一代换了多次」。
 */
const dates = computed(() => changeDateStats(props.timeline));
const multiText = computed(() => {
  const m = dates.value.multiPerProvince || [];
  if (!m.length) return '';
  const names = m.slice(0, 3).map((x) => props.provinceNames[x.provinceId] || x.provinceId);
  return `${m.length} 个省在本剧本内多次易主（${names.join('、')}${m.length > 3 ? ' 等' : ''}）`;
});
/** 模板用的日期文本（`<script setup>` 里 import 的绑定在模板中直接可用） */
</script>

<style scoped>
.slp-overlay {
  position: fixed;
  inset: 0;
  background: rgba(8, 12, 20, 0.62);
  z-index: 120;
  display: flex;
  align-items: center;
  justify-content: center;
}
.slp-dialog {
  width: min(920px, 94vw);
  max-height: 84vh;
  display: flex;
  flex-direction: column;
  background: #101a2b;
  border: 1px solid #334155;
  border-radius: 10px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55);
  color: #cbd5e1;
  font-size: 12px;
}
.slp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid #334155;
}
.slp-title { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; color: #e2e8f0; font-size: 13px; }
.slp-sub { font-size: 10px; color: #64748b; }
.slp-spacer { flex: 1; }
.slp-x {
  background: none; border: none; color: #94a3b8; cursor: pointer;
  padding: 3px 5px; border-radius: 4px;
}
.slp-x:hover { background: #1e293b; color: #e2e8f0; }

.slp-tabs { display: flex; gap: 4px; padding: 8px 14px 0; }
.slp-tabs button {
  background: #1e293b; border: 1px solid #475569; color: #cbd5e1;
  border-radius: 6px 6px 0 0; padding: 5px 12px; font-size: 11px;
  cursor: pointer; font-family: inherit;
}
.slp-tabs button.active { background: rgba(124, 58, 237, 0.9); border-color: #7c3aed; color: #fff; }

.slp-body { overflow-y: auto; padding: 10px 14px; flex: 1; }
.slp-note { margin: 0 0 10px; font-size: 11px; color: #94a3b8; line-height: 1.6; }
.slp-empty { padding: 24px; text-align: center; color: #64748b; }

/* 日期录入进度 + 批量条（2026-10-02） */
.slp-bulk {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 6px 8px; margin-bottom: 8px; border-radius: 6px;
  background: #16233a; border: 1px solid #1e293b; font-size: 11px;
}
.slp-stat { color: #94a3b8; }
.slp-stat b { color: #e2e8f0; font-variant-numeric: tabular-nums; }
.slp-stat b.warn { color: #fcd34d; }
.slp-range { color: #64748b; }
.slp-bulklabel { color: #64748b; }
.slp-bad { display: inline-block; margin-left: 6px; color: #fcd34d; font-size: 10px; }
.slp-input.bad { border-color: #b45309; }

.slp-era { margin-bottom: 16px; }
.slp-era-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
.slp-era-name { font-weight: 600; color: #e2e8f0; }
.slp-era-range { font-size: 10px; color: #64748b; font-variant-numeric: tabular-nums; }
.slp-era-badge {
  font-size: 9px; background: rgba(124, 58, 237, 0.8); color: #fff;
  border-radius: 7px; padding: 0 6px; line-height: 14px;
}

.slp-table { width: 100%; border-collapse: collapse; }
.slp-table th {
  text-align: left; font-size: 10px; font-weight: 500; color: #64748b;
  padding: 3px 6px; border-bottom: 1px solid #1e293b;
}
.slp-table td { padding: 3px 6px; border-bottom: 1px solid #16233a; }
.slp-table tr.is-explicit td { background: rgba(124, 58, 237, 0.10); }
.slp-num { font-variant-numeric: tabular-nums; color: #94a3b8; width: 52px; }
.slp-dot {
  display: inline-block; width: 9px; height: 9px; border-radius: 2px;
  margin-right: 5px; vertical-align: -1px;
}
.slp-select, .slp-input {
  background: #1e293b; border: 1px solid #475569; color: #cbd5e1;
  border-radius: 4px; font-size: 11px; padding: 2px 4px; font-family: inherit;
  max-width: 220px;
}
.slp-input { width: 84px; font-variant-numeric: tabular-nums; }
/* 月日精度：日期三格（年-月-日）。年宽、月日窄；「-」不可点选，避免复制出脏文本 */
.slp-date { display: inline-flex; align-items: center; gap: 3px; }
.slp-input.slp-y { width: 70px; }
.slp-input.slp-md { width: 46px; }
.slp-dash { color: #64748b; font-size: 11px; user-select: none; }
.slp-eff { display: inline-block; margin-left: 6px; font-size: 10px; color: #64748b; font-variant-numeric: tabular-nums; }
.slp-hint-inline { display: inline-block; margin-left: 6px; font-size: 10px; color: #93c5fd; }
.slp-mini {
  background: #1e293b; border: 1px solid #475569; color: #cbd5e1;
  border-radius: 4px; font-size: 10px; padding: 1px 6px; cursor: pointer; font-family: inherit;
}
.slp-mini:hover { background: #334155; }
.slp-auto { font-size: 10px; color: #64748b; }

.slp-foot {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px; border-top: 1px solid #334155;
}
.slp-hint { font-size: 10px; color: #64748b; }
.slp-foot button {
  background: #1e293b; border: 1px solid #475569; color: #cbd5e1;
  border-radius: 6px; padding: 5px 12px; font-size: 11px; cursor: pointer; font-family: inherit;
}
.slp-foot button:hover { background: #334155; }
</style>
