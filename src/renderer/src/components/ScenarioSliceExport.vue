<template>
  <div v-if="open" class="sse-overlay" @click.self="emit('close')">
    <div class="sse-dialog" data-testid="slice-export-panel">
      <div class="sse-head">
        <span class="sse-title"><Icon name="layers" :size="15"/> 逐年切片导出</span>
        <span class="sse-sub">按「状态真的变了」出帧 · 一次选目录写一批</span>
        <span class="sse-spacer"></span>
        <button class="sse-x" data-testid="slice-export-close" @click="emit('close')" title="关闭">
          <Icon name="x" :size="14"/>
        </button>
      </div>

      <div class="sse-body">
        <p class="sse-note">
          每一帧 = 一个<strong>状态发生变化</strong>的<strong>日期</strong>，由两类来源组成：
          <strong>切片点</strong>（你在时间轴上存的命名时间点，默认必出）∪
          <strong>自动帧</strong>（剧本起点 + 每次易主）。同一日期只出一张。
          导出后目录里会有 <code>frames.json</code> 清单（帧序 / 日期 / 剧本 / 易主省份 / 来源），
          可直接交给外部 <code>ffmpeg</code> 合成视频 —— 本应用不做动画编码。
        </p>

        <!-- 日期可信度：合成值必须摆在最前面，不许拿"好看的时间轴"冒充史料 -->
        <div v-if="dates.synthesized > 0" class="sse-warn" data-testid="slice-date-warn">
          <strong>{{ dates.synthesized }}/{{ dates.total }}</strong> 个易主日期是
          <strong>自动铺开的合成值</strong>（没有录入真实日期）—— 导出的时间轴是按剧本推出来的，
          不是史料。可到「势力谱系管理 → 易主日期」逐个录入真值（支持精确到月日）。
        </div>
        <div v-if="dates.outOfRange.length" class="sse-warn" data-testid="slice-range-warn">
          有 <strong>{{ dates.outOfRange.length }}</strong> 个易主日期落在本剧本年代区间之外
          （帧仍会出，但日期本身该修）：
          <span class="sse-dim">{{ outOfRangeText }}</span>
        </div>
        <div v-if="!dates.synthesized && dates.total" class="sse-ok" data-testid="slice-date-ok">
          全部 {{ dates.total }} 个易主日期都来自显式录入。
        </div>
        <div v-if="dates.multiPerProvince.length" class="sse-ok" data-testid="slice-multi-warn">
          有 <strong>{{ dates.multiPerProvince.length }}</strong> 个省在同一个剧本内
          <strong>多次易主</strong>（月日精度支持）—— 每一次都会单独出一帧。
        </div>
        <div v-if="!slicePoints.length" class="sse-dim-block" data-testid="slice-nopoint-hint">
          还没有切片点 —— 在时间轴上把游标拖到想导的那天，点「存为切片点」即可命名保存。
        </div>

        <div class="sse-row">
          <span class="sse-kv">帧数 <b data-testid="slice-frame-count">{{ frames.length }}</b></span>
          <span class="sse-kv">切片点 <b data-testid="slice-point-count">{{ slicePoints.length }}</b></span>
          <span class="sse-kv">剧本 <b>{{ timeline.scenarios.length }}</b></span>
          <span class="sse-kv">年代跨度 <b>{{ stats.firstText }} ~ {{ stats.lastText }}</b></span>
          <span class="sse-kv">易主 <b>{{ stats.changeCount }}</b> 次</span>
        </div>

        <div v-if="frames.length > MAX_SLICE_FRAMES" class="sse-warn">
          帧数超过上限 {{ MAX_SLICE_FRAMES }} —— 请先合并剧本（当前是一天一帧就会变成逐帧动画）。
        </div>

        <div class="sse-list" data-testid="slice-frame-list">
          <table class="sse-table">
            <thead>
              <tr><th>#</th><th>日期</th><th>剧本</th><th>本帧易主</th><th>来源</th><th>日期来源</th></tr>
            </thead>
            <tbody>
              <tr v-for="(f, i) in frames.slice(0, 400)" :key="f.dateKey"
                  :class="{ 'is-change': f.changed.length > 0, 'is-bookmark': f.sources.includes(bookmarkSrc), 'is-out': f.outOfRange }"
                  :data-testid="`slice-frame-${i}`" :data-kind="f.kind">
                <td class="sse-num">{{ i + 1 }}</td>
                <td class="sse-num" :data-testid="`slice-frame-date-${i}`">{{ formatDate(f.date) }}</td>
                <td>{{ timeline.scenarios[f.era]?.name || f.era }}</td>
                <td>
                  <span v-if="!f.changed.length" class="sse-dim">（剧本起点）</span>
                  <span v-else>{{ changedText(f) }}</span>
                </td>
                <td class="sse-src">
                  <span v-if="f.sources.includes(bookmarkSrc)" class="sse-pill-bm">切片点{{ f.label ? `「${f.label}」` : '' }}</span>
                  <span v-if="f.sources.includes(eraSrc)" class="sse-pill-era">起点</span>
                  <span v-if="f.sources.includes(changeSrc)" class="sse-pill-ch">易主</span>
                </td>
                <td>
                  <span v-if="!f.changed.length" class="sse-dim">—</span>
                  <span v-else-if="explicitCount(f) === f.changed.length" class="sse-okpill">显式</span>
                  <span v-else-if="explicitCount(f) === 0" class="sse-warnpill">自动推算</span>
                  <span v-else class="sse-mixpill">{{ explicitCount(f) }}/{{ f.changed.length }} 显式</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="sse-foot">
        <label class="sse-check">
          <input type="checkbox" v-model="png" data-testid="slice-format-png" /> 输出 PNG（默认 SVG 矢量）
        </label>
        <label v-if="png" class="sse-check">
          倍率
          <select v-model.number="scale" data-testid="slice-scale">
            <option :value="1">1×</option><option :value="2">2×</option><option :value="3">3×</option>
          </select>
        </label>
        <span class="sse-status" data-testid="slice-status">{{ status || '' }}</span>
        <span class="sse-spacer"></span>
        <button class="sse-run" data-testid="slice-export-run"
                :disabled="busy || !frames.length || frames.length > MAX_SLICE_FRAMES"
                @click="emit('run', { png, scale })">
          {{ busy ? '导出中…' : `导出 ${frames.length} 帧…` }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
// 逐年切片导出对话框：**纯展示 + 事件**。
// 帧索引与日期体检都来自纯函数层 `utils/scenarioSlices.js`（与导出链、与用例同一份判定），
// 这里不重算「哪些日期要出帧」——重算就是第二个事实源。
import { computed, ref } from 'vue';
import Icon from './Icon.vue';
import { collectSliceFrames, changeDateStats, MAX_SLICE_FRAMES, FRAME_SOURCE } from '../utils/scenarioSlices';
import { formatDate } from '../utils/scenarioDates';

const props = defineProps({
  open: { type: Boolean, default: false },
  timeline: { type: Object, required: true },
  /** 切片点书签（项目级）：默认必出的帧来源 */
  slicePoints: { type: Array, default: () => [] },
  provinceNames: { type: Object, default: () => ({}) },
  status: { type: String, default: '' },
  busy: { type: Boolean, default: false },
});

const emit = defineEmits(['close', 'run']);

const png = ref(false);
const scale = ref(2);

// 来源标记常量（模板里要比对；从纯函数层取，别在模板里写字符串字面量）
const bookmarkSrc = FRAME_SOURCE.BOOKMARK;
const eraSrc = FRAME_SOURCE.ERA;
const changeSrc = FRAME_SOURCE.CHANGE;

const model = computed(() => {
  try {
    return collectSliceFrames(props.timeline, props.slicePoints);
  } catch (_) {
    return {
      frames: [],
      stats: {
        frameCount: 0, eraCount: 0, changeCount: 0, bookmarkCount: 0,
        firstYear: 0, lastYear: 0, firstText: '', lastText: '',
      },
    };
  }
});
const frames = computed(() => model.value.frames);
const stats = computed(() => model.value.stats);
const dates = computed(() => changeDateStats(props.timeline));

const outOfRangeText = computed(() => dates.value.outOfRange
  .slice(0, 6)
  .map((d) => `${provinceNames.value[d.provinceId] || d.provinceId} ${d.text || d.year} ∉ [${d.start},${d.end}]`)
  .join('；') + (dates.value.outOfRange.length > 6 ? ` …（另有 ${dates.value.outOfRange.length - 6} 条）` : ''));

function changedText(f) {
  const names = f.changed.map((pid) => props.provinceNames[pid] || pid);
  return names.slice(0, 4).join('、') + (names.length > 4 ? ` 等 ${names.length} 省` : '');
}

function explicitCount(f) {
  return Object.keys(f.explicit || {}).length;
}
</script>

<style scoped>
.sse-overlay {
  position: fixed; inset: 0; background: rgba(8, 12, 20, 0.62); z-index: 120;
  display: flex; align-items: center; justify-content: center;
}
.sse-dialog {
  width: min(860px, 94vw); max-height: 84vh; display: flex; flex-direction: column;
  background: #101a2b; border: 1px solid #334155; border-radius: 10px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55); color: #cbd5e1; font-size: 12px;
}
.sse-head {
  display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid #334155;
}
.sse-title { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; color: #e2e8f0; font-size: 13px; }
.sse-sub { font-size: 10px; color: #64748b; }
.sse-spacer { flex: 1; }
.sse-x { background: none; border: none; color: #94a3b8; cursor: pointer; padding: 3px 5px; border-radius: 4px; }
.sse-x:hover { background: #1e293b; color: #e2e8f0; }
.sse-body { overflow-y: auto; padding: 10px 14px; flex: 1; }
.sse-note { margin: 0 0 10px; font-size: 11px; color: #94a3b8; line-height: 1.7; }
.sse-note code { background: #1e293b; padding: 0 4px; border-radius: 3px; color: #cbd5e1; }
.sse-warn {
  margin: 0 0 8px; padding: 7px 9px; border-radius: 6px; font-size: 11px; line-height: 1.6;
  background: rgba(180, 83, 9, 0.18); border: 1px solid rgba(245, 158, 11, 0.45); color: #fcd34d;
}
.sse-ok {
  margin: 0 0 8px; padding: 7px 9px; border-radius: 6px; font-size: 11px;
  background: rgba(21, 128, 61, 0.18); border: 1px solid rgba(34, 197, 94, 0.4); color: #86efac;
}
.sse-dim { color: #64748b; }
.sse-dim-block {
  margin: 0 0 8px; padding: 7px 9px; border-radius: 6px; font-size: 11px; line-height: 1.6;
  background: rgba(30, 41, 59, 0.6); border: 1px dashed #334155; color: #94a3b8;
}
.sse-src { white-space: nowrap; }
.sse-pill-bm { color: #fcd34d; margin-right: 4px; }
.sse-pill-era { color: #94a3b8; margin-right: 4px; }
.sse-pill-ch { color: #c4b5fd; }
.sse-table tr.is-bookmark td { background: rgba(251, 191, 36, 0.10); }
.sse-row { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 8px; font-size: 11px; color: #94a3b8; }
.sse-kv b { color: #e2e8f0; font-variant-numeric: tabular-nums; }
.sse-list { max-height: 320px; overflow-y: auto; border: 1px solid #1e293b; border-radius: 6px; }
.sse-table { width: 100%; border-collapse: collapse; }
.sse-table th {
  position: sticky; top: 0; background: #16233a; text-align: left; font-size: 10px;
  font-weight: 500; color: #64748b; padding: 4px 6px;
}
.sse-table td { padding: 3px 6px; border-bottom: 1px solid #16233a; }
.sse-table tr.is-change td { background: rgba(124, 58, 237, 0.10); }
.sse-table tr.is-out td { background: rgba(180, 83, 9, 0.16); }
.sse-num { font-variant-numeric: tabular-nums; color: #94a3b8; width: 56px; }
.sse-okpill { color: #86efac; }
.sse-warnpill { color: #fcd34d; }
.sse-mixpill { color: #93c5fd; }
.sse-foot {
  display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid #334155;
}
.sse-check { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: #94a3b8; }
.sse-check select {
  background: #1e293b; border: 1px solid #475569; color: #cbd5e1; border-radius: 4px;
  font-size: 11px; padding: 1px 4px; font-family: inherit;
}
.sse-status { font-size: 11px; color: #93c5fd; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sse-run {
  background: rgba(124, 58, 237, 0.9); border: 1px solid #7c3aed; color: #fff;
  border-radius: 6px; padding: 5px 14px; font-size: 11px; cursor: pointer; font-family: inherit;
}
.sse-run:disabled { background: #1e293b; border-color: #475569; color: #64748b; cursor: not-allowed; }
</style>
