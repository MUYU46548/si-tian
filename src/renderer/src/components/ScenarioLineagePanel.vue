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

      <!-- Tab 2：易主年份 -->
      <div v-else class="slp-body">
        <p class="slp-note">
          未显式指定时，易主年份按「本剧本内均匀铺开」推算（<b>合成值</b>，不是史料）。
          在时间轴上任一年份用油漆桶上色，也会自动写入该年的显式值。清空即回到推算。
        </p>
        <div v-if="!yearRows.length" class="slp-empty">当前剧本没有谱系变化省份。</div>
        <template v-else>
          <!-- 录入进度 + 批量操作（2026-10-02）：逐个改是 N 条 undo，且「这一代都定在某年」要写 N 遍 -->
          <div class="slp-bulk">
            <span class="slp-stat" data-testid="slp-cy-stat">
              本剧本 <b>{{ yearRows.length }}</b> 省易主：显式
              <b :class="{ warn: explicitCount === 0 }">{{ explicitCount }}</b> / 自动推算
              <b :class="{ warn: yearRows.length - explicitCount > 0 }">{{ yearRows.length - explicitCount }}</b>
              <span class="slp-range">（区间 {{ eraRange.start }} ~ {{ eraRange.end }}）</span>
            </span>
            <span class="slp-spacer"></span>
            <span class="slp-bulklabel">批量：</span>
            <input class="slp-input" type="number" v-model="bulkYear"
                   :placeholder="String(eraRange.start)" data-testid="slp-cy-bulk-input" />
            <button class="slp-mini" data-testid="slp-cy-bulk-set"
                    :disabled="!bulkYearValid"
                    :title="bulkYearValid ? `把本剧本全部 ${yearRows.length} 个变化省的易主年份设为该值（一条 undo）` : bulkInvalidReason"
                    @click="applyBulkSet">统一设为该年</button>
            <button class="slp-mini" data-testid="slp-cy-bulk-snap"
                    title="把当前自动推算的年份固化成显式值（之后可逐个微调；一条 undo）"
                    @click="applyBulkSnap">固化推算值</button>
            <button class="slp-mini" data-testid="slp-cy-bulk-clear"
                    :disabled="!explicitCount"
                    title="清空本剧本全部显式年份，回到自动推算（一条 undo）"
                    @click="applyBulkClear">全部清空</button>
          </div>
          <table class="slp-table">
            <thead>
              <tr><th>省份</th><th>旧主</th><th>新主</th><th>易主年份</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="r in yearRows" :key="r.pid" :class="{ 'is-explicit': r.explicit }">
                <td>{{ r.name }}</td>
                <td><span class="slp-dot" :style="{ background: r.oldColor }"></span>{{ r.oldName }}</td>
                <td><span class="slp-dot" :style="{ background: r.newColor }"></span>{{ r.newName }}</td>
                <td>
                  <input class="slp-input" type="number" :value="r.year"
                         :class="{ bad: !!r.warn }" :title="r.warn || ''"
                         :data-testid="`slp-cy-${r.pid}`"
                         @change="onYearChange(r, $event)" />
                  <span v-if="r.warn" class="slp-bad" :data-testid="`slp-cywarn-${r.pid}`">{{ r.warn }}</span>
                </td>
                <td>
                  <button v-if="r.explicit" class="slp-mini" title="清除显式值，回到自动推算"
                          :data-testid="`slp-cyclear-${r.pid}`"
                          @click="emit('set-change-year', { scenarioId: r.scenarioId, provinceId: r.pid, year: null })">自动</button>
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
// P2 势力/谱系管理面板：可视化纠正 successorOf / lineage / 显式易主年份
// 纯展示 + 事件：所有写入通过 emit 交给父级调 store（保持 store 调用点集中）
import { ref, computed } from 'vue';
import Icon from './Icon.vue';
import { groupMap } from '../utils/scenarioTimeline';
// 易主年份的合法性判定 / 体检**唯一实现**（与导出链、与用例共用一份；组件里不许再写一套区间比较）
import { validateChangeYear, changeDateStats } from '../utils/scenarioSlices';

const props = defineProps({
  open: { type: Boolean, default: false },
  timeline: { type: Object, required: true },
  currentEra: { type: Number, default: 0 },
  year: { type: Number, default: 0 },
  provinceNames: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['close', 'set-polity-lineage', 'set-change-year', 'set-change-years-bulk', 'reject']);

const tab = ref('lineage');
const bulkYear = ref('');

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
  const ctx = {};

  return e.changed.map((pid) => {
    const oldPol = prev.ownership?.[pid];
    const newPol = s.ownership?.[pid];
    const find = (sc, id) => (sc.polities || []).find((p) => p.id === id);
    ctx.old = find(prev, oldPol);
    ctx.new = find(s, newPol);
    const check = validateChangeYear(tl, k, e.year[pid]);
    return {
      pid,
      scenarioId: s.id,
      name: props.provinceNames[pid] || pid,
      oldName: ctx.old?.name || oldPol || '（无主）',
      oldColor: ctx.old?.color || '#4a5568',
      newName: ctx.new?.name || newPol || '（无主）',
      newColor: ctx.new?.color || '#4a5568',
      year: e.year[pid],
      explicit: !!e.explicit[pid],
      // 只有「显式录入且越界」才提示 —— 合成值必然落在区间内，不必刷屏
      warn: (!check.ok && e.explicit[pid]) ? check.reason : '',
    };
  }).sort((a, b) => a.year - b.year || a.name.localeCompare(b.name));
});

const explicitCount = computed(() => yearRows.value.filter((r) => r.explicit).length);

const eraRange = computed(() => {
  const y = props.timeline.years?.[props.currentEra] || { start: 0, end: 0 };
  return y;
});

const bulkYearValid = computed(() => validateChangeYear(props.timeline, props.currentEra, bulkYear.value).ok);
const bulkInvalidReason = computed(() => {
  const v = validateChangeYear(props.timeline, props.currentEra, bulkYear.value);
  return v.ok ? '' : (v.reason || '年份不合法');
});

function applyBulkSet() {
  if (!bulkYearValid.value || !yearRows.value.length) return;
  const y = Number(bulkYear.value);
  const patch = {};
  for (const r of yearRows.value) patch[r.pid] = y;
  emit('set-change-years-bulk', { scenarioId: yearRows.value[0].scenarioId, patch, what: '统一设为该年' });
}

/** 固化推算值：把当前**生效**的年份（含合成值）写成显式，之后可逐个微调 */
function applyBulkSnap() {
  if (!yearRows.value.length) return;
  const patch = {};
  for (const r of yearRows.value) patch[r.pid] = r.year;
  emit('set-change-years-bulk', { scenarioId: yearRows.value[0].scenarioId, patch, what: '固化推算值' });
}

/** 清空：全部回到自动推算（只对有显式值的省发出，避免空转 undo） */
function applyBulkClear() {
  const rows = yearRows.value.filter((r) => r.explicit);
  if (!rows.length) return;
  const patch = {};
  for (const r of rows) patch[r.pid] = null;
  emit('set-change-years-bulk', { scenarioId: rows[0].scenarioId, patch, what: '全部清空' });
}

function onYearChange(r, ev) {
  const raw = ev && ev.target ? ev.target.value : ev;
  const n = Number(raw);
  // 🔴 校验在**发出去之前**：越界年份不写库（写进去就是越界数据，切片会照它出帧）。
  //    拒绝时把输入框**退回显示库里那个值** —— 只拦不还原的话，框里留着用户输的脏值，
  //    看上去像"已经改成了 1999"（实际没写），是比直接报错更坏的一种静默。
  const check = validateChangeYear(props.timeline, props.currentEra, n);
  if (!check.ok) {
    if (ev && ev.target) ev.target.value = String(r.year);
    emit('reject', { what: `「${r.name}」的易主年份`, reason: check.reason || '年份不合法' });
    return;
  }
  emit('set-change-year', {
    scenarioId: r.scenarioId,
    provinceId: r.pid,
    year: Number.isFinite(n) ? n : null,
  });
}

/** 面板自用的体检（供 Tab 头部/调试：显式 vs 合成）；与导出对话框同一份实现 */
const dates = computed(() => changeDateStats(props.timeline));
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
