<template>
  <div class="scenario-timeline-root" :data-testid="'scenario-timeline'">
    <!-- 轨道：数字年份轴 / 时代块 / 断层块 / 游标 -->
    <div class="tl-railwrap" ref="railWrap"
         @pointerdown="onPointerDown"
         @pointermove="onPointerMove"
         @pointerup="onPointerUp"
         @pointercancel="onPointerCancel">
      <div class="tl-rail" ref="rail">
        <div v-for="(t, i) in ticks" :key="'t' + i" class="tl-tickline" :style="{ left: tickPct(t) + '%' }"></div>
        <div v-for="(t, i) in ticks" :key="'tl' + i" class="tl-tick" :style="{ left: tickPct(t) + '%' }">{{ t }}</div>

        <div
          v-for="b in blocks"
          :key="b.key"
          class="tl-block"
          :class="{ 'is-on': b.active, 'is-past': b.past, 'is-gap': b.gap, 'is-tiny': b.tiny }"
          :style="{ left: b.left + '%', width: b.width + '%' }"
          :title="b.title"
          :data-era="b.era"
          :data-key="b.key"
          :data-testid="b.gap ? 'tl-gap' : 'tl-era-' + b.era"
          @click="onBlockClick(b)"
        >
          <span class="tl-l">{{ b.label }}</span>
          <span class="tl-y">{{ b.sub }}</span>
          <span v-if="b.badge" class="tl-badge" :title="`相对上一剧本：${b.badge} 省谱系变化`">{{ b.badge }}</span>
        </div>
      </div>
      <div class="tl-playhead" :style="{ left: playheadPct + '%' }" data-testid="tl-playhead"></div>
    </div>

    <!-- 控制条 -->
    <div class="tl-controls">
      <button :class="{ active: playing }" data-testid="tl-play"
              :title="playing ? '暂停演变' : '播放演变（按剧本推进，约 1.3s/剧本）'"
              @click="emit('update:playing', !playing)">
        <Icon :name="playing ? 'pause' : 'play'" :size="13"/> {{ playing ? '暂停' : '播放演变' }}
      </button>
      <button data-testid="tl-prev" @click="stepEra(-1)"><Icon name="chevron-left" :size="13"/> 上一剧本</button>
      <button data-testid="tl-next" @click="stepEra(1)">下一剧本 <Icon name="chevron-right" :size="13"/></button>

      <span class="tl-spacer"></span>

      <span class="tl-grp"><span class="tl-grp-label">轴向</span>
        <button :class="{ active: axisMode === 'year' }" data-testid="tl-axis-year"
                title="按真实年份线性排布（短时代会缩得很窄）"
                @click="emit('update:axisMode', 'year')">按年比例</button>
        <button :class="{ active: axisMode === 'equal' }" data-testid="tl-axis-equal"
                title="每个剧本等宽（短时代也点得中）"
                @click="emit('update:axisMode', 'equal')">等宽</button>
      </span>

      <span class="tl-grp"><span class="tl-grp-label">变化图层</span>
        <button :class="{ active: diffMode === 'eu4' }" data-testid="tl-diff-eu4"
                title="EU4 式斜线占领：旧主底色 + 新主斜线（易主落定后出现）"
                @click="emit('update:diffMode', 'eu4')">斜线占领</button>
        <button :class="{ active: diffMode === 'outline' }" data-testid="tl-diff-outline"
                title="只给谱系变化省加白描边"
                @click="emit('update:diffMode', 'outline')">白描边</button>
        <button :class="{ active: diffMode === 'off' }" data-testid="tl-diff-off"
                @click="emit('update:diffMode', 'off')">关</button>
      </span>

      <button data-testid="tl-lineage" title="势力谱系管理（可视化纠正 successorOf / 显式易主年份）"
              @click="emit('open-lineage')"><Icon name="git-branch" :size="13"/> 谱系</button>
    </div>
  </div>
</template>

<script setup>
// 历史剧本时间轴：按年比例 / 等宽 双轴向 + EU4 斜线占领开关 + 键盘导航
// 纯展示组件：所有状态由父级（ScenarioMap）持有，通过多个 v-model 同步。
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';
import Icon from './Icon.vue';
import { yearToU, uToYear, eraIndexOfYear, axisTicks } from '../utils/scenarioTimeline';

const props = defineProps({
  timeline: { type: Object, required: true },
  year: { type: Number, required: true },
  era: { type: Number, default: 0 },
  axisMode: { type: String, default: 'year' },
  diffMode: { type: String, default: 'eu4' },
  playing: { type: Boolean, default: false },
});

const emit = defineEmits([
  'update:year', 'update:era', 'update:axisMode', 'update:diffMode', 'update:playing',
  'select-scenario', 'open-lineage',
]);

const railWrap = ref(null);
const rail = ref(null);
/** 极窄块的标签收起标记（两个 track：先量后判，避免来回抖动） */
const tinyFlags = ref({});

const ticks = computed(() => {
  if (props.axisMode !== 'year') return [];
  return axisTicks(props.timeline.minYear, props.timeline.maxYear, 8);
});

function tickPct(y) {
  const { minYear, maxYear } = props.timeline;
  const span = maxYear - minYear;
  return span > 0 ? ((y - minYear) / span) * 100 : 0;
}

const playheadPct = computed(() => yearToU(props.timeline, props.year, props.axisMode) * 100);

const blocks = computed(() => {
  const tl = props.timeline;
  const n = tl.years.length;
  if (!n) return [];
  const out = [];
  const span = tl.maxYear - tl.minYear;

  const push = (key, { era, label, sub, title, left, width, gap }) => {
    const badge = !gap && era > 0 ? (tl.eraChg[era]?.changed.length || 0) : 0;
    out.push({
      key, era, label, sub, title, left, width, gap,
      badge,
      active: !gap && era === props.era,
      past: !gap && era < props.era,
      tiny: !!tinyFlags.value[key],
    });
  };

  if (props.axisMode === 'equal') {
    tl.scenarios.forEach((s, k) => {
      push('era' + k, {
        era: k,
        label: s.name,
        sub: `${tl.years[k].start}~${tl.years[k].end}`,
        title: `${s.name} ${tl.years[k].start} ~ ${tl.years[k].end}`,
        left: (k / n) * 100,
        width: 100 / n,
      });
    });
    return out;
  }

  tl.scenarios.forEach((s, k) => {
    const y = tl.years[k];
    const left = span > 0 ? ((y.start - tl.minYear) / span) * 100 : 0;
    const right = span > 0 ? ((y.end - tl.minYear) / span) * 100 : 0;
    push('era' + k, {
      era: k,
      label: s.name,
      sub: `${y.start}~${y.end}`,
      title: `${s.name} ${y.start} ~ ${y.end}（${y.end - y.start} 年）`,
      left,
      width: Math.max(0.06, right - left),
    });
  });
  // 断层块（无剧本年代）
  tl.gaps.forEach((g, i) => {
    const left = span > 0 ? ((g.from - tl.minYear) / span) * 100 : 0;
    const right = span > 0 ? ((g.to - tl.minYear) / span) * 100 : 0;
    push('gap' + i, {
      era: -1,
      label: `空位 ${Math.round(g.to - g.from)}年`,
      sub: `${g.from}~${g.to}`,
      title: `${g.from} → ${g.to} 无剧本（沿用前一剧本版图）`,
      left,
      width: right - left,
      gap: true,
    });
  });
  return out;
});

/** 极窄块收起标签：必须两趟（加上 is-tiny 后 .tl-l 变 display:none，scrollWidth 归零会抖动） */
async function fitLabels() {
  await nextTick();
  const el = rail.value;
  if (!el) return;
  const nodes = [...el.querySelectorAll('.tl-block')];
  tinyFlags.value = {};
  // 第一趟：全部按「展开」量真实文字宽度
  const need = nodes.map((b) => {
    b.classList.remove('is-tiny');
    const l = b.querySelector('.tl-l');
    const badge = b.querySelector('.tl-badge');
    return (l ? l.scrollWidth : 0) + (badge ? 20 : 0) + 12;
  });
  // 第二趟：按宽度判定
  const flags = {};
  nodes.forEach((b, i) => {
    flags[b.dataset.key || ('idx' + i)] = b.clientWidth < need[i];
  });
  tinyFlags.value = flags;
}

// ===== 拖动 =====
let scrubbing = false;

function yearFromClientX(clientX) {
  const r = rail.value?.getBoundingClientRect();
  if (!r || r.width <= 0) return props.year;
  return uToYear(props.timeline, (clientX - r.left) / r.width, props.axisMode);
}

function onPointerDown(e) {
  if (!rail.value) return;
  scrubbing = true;
  if (props.playing) emit('update:playing', false);
  // ⚠️ 合成指针事件（自动化测试）下 setPointerCapture 会抛 NotFoundError，
  //    不兜住会打断后续 setYear —— 拖动整条链路静默失效
  try { railWrap.value?.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
  emit('update:year', Math.round(yearFromClientX(e.clientX)));
}

function onPointerMove(e) {
  if (!scrubbing) return;
  emit('update:year', Math.round(yearFromClientX(e.clientX)));
}

function onPointerUp(e) {
  scrubbing = false;
  try { railWrap.value?.releasePointerCapture(e.pointerId); } catch (_) { /* noop */ }
}

function onPointerCancel() { scrubbing = false; }

function onBlockClick(b) {
  if (b.gap) return;
  if (props.playing) emit('update:playing', false);
  emit('update:era', b.era);
  emit('update:year', props.timeline.years[b.era].start);
  emit('select-scenario', props.timeline.scenarios[b.era]);
}

function stepEra(delta) {
  if (props.playing) emit('update:playing', false);
  const n = props.timeline.years.length;
  const k = Math.max(0, Math.min(n - 1, props.era + delta));
  emit('update:era', k);
  emit('update:year', props.timeline.years[k].start);
  emit('select-scenario', props.timeline.scenarios[k]);
}

// ===== 键盘 =====
const KEYS = new Set(['ArrowLeft', 'ArrowRight', ' ', 'Home', 'End']);

function isTypingTarget(t) {
  if (!t) return false;
  const tag = (t.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

function onKeydown(e) {
  if (!KEYS.has(e.key)) return;
  if (isTypingTarget(e.target)) return;
  const n = props.timeline.years.length;
  if (!n) return;
  const k = props.era;

  if (e.key === ' ') {
    e.preventDefault(); e.stopPropagation();
    emit('update:playing', !props.playing);
    return;
  }
  if (e.key === 'Home') {
    e.preventDefault(); e.stopPropagation();
    if (props.playing) emit('update:playing', false);
    emit('update:era', 0); emit('update:year', props.timeline.years[0].start);
    return;
  }
  if (e.key === 'End') {
    e.preventDefault(); e.stopPropagation();
    if (props.playing) emit('update:playing', false);
    emit('update:era', n - 1); emit('update:year', props.timeline.years[n - 1].start);
    return;
  }
  e.preventDefault(); e.stopPropagation();
  if (props.playing) emit('update:playing', false);
  // Shift + 左右 = 逐年微调；否则跳剧本
  if (e.shiftKey) {
    emit('update:year', props.year + (e.key === 'ArrowLeft' ? -1 : 1));
    return;
  }
  const d = e.key === 'ArrowLeft' ? -1 : 1;
  const nk = Math.max(0, Math.min(n - 1, k + d));
  emit('update:era', nk);
  emit('update:year', props.timeline.years[nk].start);
}

watch(() => [props.axisMode, props.timeline], fitLabels, { deep: false });
watch(() => props.timeline.stats.scenarios, fitLabels);

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', fitLabels);
  fitLabels();
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', fitLabels);
});

// 供父级/测试调用
defineExpose({ fitLabels, eraIndexOfYear });
</script>

<style scoped>
.scenario-timeline-root {
  background: #172033;
  border-top: 1px solid #334155;
  flex: none;
}

.tl-railwrap {
  position: relative;
  height: 64px;
  margin: 0 12px;
  cursor: ew-resize;
  touch-action: none;
  user-select: none;
}

.tl-rail {
  position: absolute;
  inset: 16px 0 0 0;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 5px;
}

.tl-block {
  position: absolute;
  top: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 6px;
  overflow: hidden;
  border-right: 1px solid #334155;
  cursor: pointer;
}
.tl-block:last-child { border-right: none; }
.tl-block .tl-l {
  font-size: 11px;
  color: #e2e8f0;
  white-space: nowrap;
  line-height: 1.25;
}
.tl-block .tl-y {
  font-size: 9px;
  color: #64748b;
  white-space: nowrap;
}
.tl-block.is-past .tl-l { color: #94a3b8; }
.tl-block.is-on {
  background: rgba(124, 58, 237, 0.22);
  box-shadow: inset 0 0 0 1px #7c3aed;
}
.tl-badge {
  position: absolute;
  right: 3px;
  top: 3px;
  font-size: 8px;
  background: rgba(124, 58, 237, 0.85);
  color: #fff;
  border-radius: 7px;
  padding: 0 4px;
  line-height: 12px;
}
/* 极窄块（真朝 6 年 ≈ 1.6px）放不下标签 → 收成小圆点，信息交给 title 悬停 */
.tl-block.is-tiny { padding: 0; }
.tl-block.is-tiny .tl-l,
.tl-block.is-tiny .tl-y,
.tl-block.is-tiny .tl-badge { display: none; }
.tl-block.is-tiny::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  width: 4px;
  height: 4px;
  margin: -2px 0 0 -2px;
  border-radius: 50%;
  background: #64748b;
}
.tl-block.is-tiny.is-on::after {
  background: #a78bfa;
  width: 6px;
  height: 6px;
  margin: -3px 0 0 -3px;
}
.tl-block.is-gap {
  background: repeating-linear-gradient(45deg, rgba(148, 163, 184, 0.10) 0 4px, transparent 4px 9px);
  cursor: default;
}
.tl-block.is-gap .tl-l { color: #64748b; font-size: 10px; }

.tl-tick {
  position: absolute;
  top: -15px;
  transform: translateX(-50%);
  font-size: 9px;
  color: #64748b;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}
.tl-tickline {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: rgba(148, 163, 184, 0.15);
}

.tl-playhead {
  position: absolute;
  top: 8px;
  bottom: -2px;
  width: 2px;
  background: #a78bfa;
  transform: translateX(-1px);
  pointer-events: none;
}
.tl-playhead::after {
  content: "";
  position: absolute;
  left: -5px;
  top: -9px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #a78bfa;
  border: 2px solid #0f172a;
}

.tl-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px 10px;
  flex-wrap: wrap;
}
.tl-controls button {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: #1e293b;
  border: 1px solid #475569;
  color: #cbd5e1;
  border-radius: 6px;
  padding: 4px 9px;
  font-size: 11px;
  cursor: pointer;
  font-family: inherit;
}
.tl-controls button:hover { background: #334155; }
.tl-controls button.active {
  background: rgba(124, 58, 237, 0.9);
  border-color: #7c3aed;
  color: #fff;
}
.tl-spacer { flex: 1; }
.tl-grp { display: inline-flex; align-items: center; gap: 4px; }
.tl-grp-label { font-size: 10px; color: #64748b; }
</style>
