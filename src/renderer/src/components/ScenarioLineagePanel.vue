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
          未显式指定时，易主年份按「本剧本内均匀铺开」推算。在时间轴上任一年份用油漆桶上色，
          也会自动写入该年的显式值。清空即回到推算。
        </p>
        <div v-if="!yearRows.length" class="slp-empty">当前剧本没有谱系变化省份。</div>
        <table v-else class="slp-table">
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
                       :data-testid="`slp-cy-${r.pid}`"
                       @change="onYearChange(r, $event.target.value)" />
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

const props = defineProps({
  open: { type: Boolean, default: false },
  timeline: { type: Object, required: true },
  currentEra: { type: Number, default: 0 },
  year: { type: Number, default: 0 },
  provinceNames: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['close', 'set-polity-lineage', 'set-change-year']);

const tab = ref('lineage');

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
    };
  }).sort((a, b) => a.year - b.year || a.name.localeCompare(b.name));
});

function onYearChange(r, v) {
  const n = Number(v);
  emit('set-change-year', {
    scenarioId: r.scenarioId,
    provinceId: r.pid,
    year: Number.isFinite(n) ? n : null,
  });
}
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
