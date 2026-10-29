<template>
  <div class="tgen" data-testid="terrain-gen-panel">
    <div class="tgen-head">
      <strong>地形生成参数</strong>
      <span class="tgen-sub">同种子 + 同参数 = 同一份地形</span>
      <button class="tgen-x" title="收起面板" @click="$emit('close')"><Icon name="x" :size="14"/></button>
    </div>

    <!-- 预设：不是"另一套参数"，只是把下面这些滑杆摆到几组起点（参数表仍只有 utils/terrainParams.js 一份） -->
    <div class="tgen-presets">
      <button
        v-for="p in presets"
        :key="p.id"
        class="tgen-chip"
        :class="{ on: activePreset === p.id }"
        :data-testid="`tgen-preset-${p.id}`"
        @click="applyPreset(p)"
      >{{ p.name }}</button>
    </div>

    <div class="tgen-rows">
      <div v-for="f in fields" :key="f.key" class="tgen-row" :title="f.hint">
        <label :for="`tgen-${f.key}`">{{ f.label }}</label>
        <template v-if="f.kind === 'choice'">
          <select
            :id="`tgen-${f.key}`"
            :value="params[f.key]"
            :data-testid="`tgen-${f.key}`"
            @change="setChoice(f.key, $event)"
          >
            <option v-for="o in f.options" :key="o" :value="o">{{ o }} 格</option>
          </select>
        </template>
        <template v-else-if="f.key === 'seed'">
          <input
            :id="`tgen-${f.key}`"
            type="range" :min="f.min" :max="f.max" :step="f.step"
            :value="params[f.key]"
            data-testid="tgen-seed"
            @input="setNum(f.key, $event)"
          >
          <input
            class="tgen-num"
            type="number" :min="f.min" :max="f.max" :step="f.step"
            :value="params[f.key]"
            data-testid="tgen-seed-num"
            @change="setNum(f.key, $event)"
          >
          <button class="tgen-dice" title="换一个种子（确定性推进，可复现）" data-testid="tgen-dice" @click="dice">
            <Icon name="refresh-cw" :size="13"/>
          </button>
        </template>
        <template v-else-if="f.kind === 'optional-int'">
          <select
            :id="`tgen-${f.key}`"
            :value="params[f.key] === null ? 'auto' : 'fixed'"
            :data-testid="`tgen-${f.key}-mode`"
            @change="setAxisMode($event)"
          >
            <option value="auto">随种子</option>
            <option value="fixed">固定走向</option>
          </select>
          <input
            v-if="params[f.key] !== null"
            type="range" :min="f.min" :max="f.max" :step="f.step"
            :value="params[f.key]"
            :data-testid="`tgen-${f.key}`"
            @input="setNum(f.key, $event)"
          >
          <span class="tgen-val">{{ params[f.key] === null ? '—' : params[f.key] + '°' }}</span>
        </template>
        <template v-else>
          <input
            :id="`tgen-${f.key}`"
            type="range" :min="f.min" :max="f.max" :step="f.step"
            :value="params[f.key]"
            :data-testid="`tgen-${f.key}`"
            @input="setNum(f.key, $event)"
          >
          <span class="tgen-val">{{ Number(params[f.key]).toFixed(f.step < 0.1 ? 2 : 1) }}{{ f.key === 'latitudeSpanDeg' ? '°' : '' }}</span>
        </template>
      </div>
    </div>

    <!-- 重生成保留手绘（2026-10-28，补 §3.2 欠账）：默认开；关掉 = 用户明确要"彻底重来" -->
    <label
      class="tgen-check"
      title="重生成时把这张地图上已手绘/笔刷改过的高度按坐标写回新地形（只对同种子有效）；关掉 = 手绘全部丢弃，彻底重来"
    >
      <input type="checkbox" v-model="keepHandEdits" data-testid="tgen-keep-hand" />
      重生成保留手绘地形
      <span class="tgen-sub">（同种子才有效；关掉等于彻底重来）</span>
    </label>

    <div class="tgen-cands-head">
      <span>候选（同参数、不同种子）</span>
      <button class="tgen-mini" :disabled="busy" data-testid="tgen-preview" @click="runPreview">
        {{ busy ? '生成中…' : '重新出候选' }}
      </button>
      <span v-if="elapsedMs != null" class="tgen-sub">{{ elapsedMs }} ms</span>
    </div>
    <div class="tgen-cands">
      <button
        v-for="(c, i) in candidates"
        :key="c.id"
        class="tgen-cand"
        :class="{ on: i === selected }"
        :data-testid="`tgen-cand-${i}`"
        :title="`种子 ${c.seed} · 走向 ${c.axis == null ? '—' : c.axis + '°'} · 裂谷 ${c.rifts} 条`"
        @click="selected = i"
      >
        <canvas :ref="(el) => setCanvas(i, el)" width="132" height="84" />
        <span class="tgen-cand-name">候选 {{ ['一', '二', '三', '四'][i] || i + 1 }}</span>
        <span class="tgen-cand-meta">种子 {{ c.seed }}</span>
      </button>
      <div v-if="!candidates.length && !busy" class="tgen-empty">还没有候选 —— 点「重新出候选」</div>
    </div>

    <div v-if="warn" class="tgen-warn">{{ warn }}</div>
    <div v-if="paramWarn" class="tgen-warn">{{ paramWarn }}</div>

    <div class="tgen-actions">
      <button
        class="tgen-btn primary"
        :disabled="busy || !candidates.length"
        data-testid="tgen-apply"
        @click="apply"
      >应用所选（一条撤销）</button>
      <button class="tgen-btn" data-testid="tgen-cancel" @click="$emit('close')">取消</button>
    </div>
    <div class="tgen-note">
      ⚠️ 应用会**替换**现有地形高度图（一条 Ctrl+Z 可撤回）；缩略图是粗网格预览，应用时按你选的精度重算。
      气候（温度/降水/群系）随地形一起按纬度与离岸距离派生。
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { useGeodataStore } from '../store/geodata';
import {
  DEFAULT_TERRAIN_PARAMS, TERRAIN_PARAM_FIELDS, TERRAIN_PRESETS,
  normalizeTerrainParams, describeTerrainParams, rollSeed,
} from '../utils/terrainParams';
import { SEA_LEVEL } from '../utils/heightMath';

const props = defineProps({
  baseMapKey: { type: String, default: '' },
  // A6（2026-10-29）：面板也能用在**行星**上 —— 传 planetId 就写 `mapData[planetId].heightmap`，
  // 推演 / 手绘搬移 / 气候派生仍是同一份实现（store 侧 `synthesizeTerrainInto`）。
  planetId: { type: String, default: '' },
  hasHeightmap: { type: Boolean, default: false },
});
const emit = defineEmits(['apply', 'close']);

const isPlanet = computed(() => !!props.planetId);
const targetName = computed(() => (isPlanet.value ? '这颗行星' : '这张底图'));

const store = useGeodataStore();
const fields = TERRAIN_PARAM_FIELDS;
const presets = TERRAIN_PRESETS;

const params = reactive({ ...DEFAULT_TERRAIN_PARAMS });
const activePreset = ref('default');
const candidates = ref([]);
const selected = ref(0);
const busy = ref(false);
const elapsedMs = ref(null);
const warn = ref('');
const paramWarn = ref('');
const keepHandEdits = ref(true);
const canvases = new Map();

function setCanvas(i, el) {
  if (el) canvases.set(i, el);
  else canvases.delete(i);
}

function syncFrom(raw, presetId = '') {
  const { params: p, warnings } = normalizeTerrainParams(raw);
  for (const f of fields) params[f.key] = p[f.key];
  activePreset.value = presetId;
  paramWarn.value = warnings.length
    ? `参数已自动夹取：${warnings.map((w) => `${w.key}${w.from != null ? ` ${w.from}→${w.to}` : '→默认'}`).join('、')}`
    : '';
}

function applyPreset(p) {
  syncFrom(p.params, p.id);
  runPreview();
}

function setNum(key, e) {
  const v = Number(e.target.value);
  if (Number.isFinite(v)) {
    params[key] = v;
    activePreset.value = '';
    paramWarn.value = '';
  }
}

function setChoice(key, e) {
  params[key] = Number(e.target.value);
  activePreset.value = '';
}

function setAxisMode(e) {
  params.rangeAxisDeg = e.target.value === 'auto' ? null : (params.rangeAxisDeg ?? 0);
  activePreset.value = '';
}

function dice() {
  params.seed = rollSeed(params.seed);
  activePreset.value = '';
  runPreview();
}

function paramSnapshot() {
  const raw = {};
  for (const f of fields) raw[f.key] = params[f.key];
  return normalizeTerrainParams(raw).params;
}

function runPreview() {
  if (!props.baseMapKey && !props.planetId) { warn.value = `先打开${isPlanet.value ? '一颗行星' : '一张底图'}`; return; }
  busy.value = true;
  warn.value = '';
  // 逐帧让 UI 先画出"生成中"再同步算（推演是同步纯函数；预览用粗网格，单张几十毫秒）
  nextTick(() => {
    const t0 = performance.now();
    let r = null;
    try {
      r = isPlanet.value
        ? store.previewPlanetTerrainSynthesis(props.planetId, paramSnapshot(), { count: 3 })
        : store.previewTerrainSynthesis(props.baseMapKey, paramSnapshot(), { count: 3 });
    } catch (err) {
      warn.value = `候选生成失败：${(err && err.message) || err}`;
    }
    busy.value = false;
    if (!r || r.ok === false) {
      candidates.value = [];
      warn.value = (r && r.message) || warn.value || '候选生成失败';
      return;
    }
    candidates.value = r.candidates;
    selected.value = 0;
    elapsedMs.value = Math.round(performance.now() - t0);
    if (r.paramWarnings && r.paramWarnings.length) {
      paramWarn.value = `参数已自动夹取：${r.paramWarnings.map((w) => `${w.key}→${w.to}`).join('、')}`;
    }
    nextTick(() => drawAll());
  });
}

// ── 缩略图：把 h 画成"海/低地/高地"三段色（不引入第二套配色表：三档就是画布已有的地形三档语义）──
function drawOne(c) {
  const el = canvases.get(c.index);
  if (!el || !c) return;
  const ctx = el.getContext('2d');
  const { cols, rows } = c;
  const w = el.width, h = el.height;
  ctx.clearRect(0, 0, w, h);
  const cellW = w / cols, cellH = h / rows;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const v = c.h[j * cols + i];
      let color;
      if (v < SEA_LEVEL) {
        const t = Math.max(0, Math.min(1, (SEA_LEVEL - v) / 8));
        color = `rgb(${30 + 20 * (1 - t)},${70 + 40 * (1 - t)},${110 + 40 * (1 - t)})`;
      } else {
        const t = Math.max(0, Math.min(1, (v - SEA_LEVEL) / 60));
        const r = Math.round(120 + 110 * t);
        const g = Math.round(150 + 40 * t);
        const b = Math.round(90 - 40 * t);
        color = `rgb(${r},${g},${b})`;
      }
      ctx.fillStyle = color;
      ctx.fillRect(i * cellW, j * cellH, Math.ceil(cellW) + 1, Math.ceil(cellH) + 1);
    }
  }
}
function drawAll() {
  for (const c of candidates.value) drawOne(c);
}

function apply() {
  const c = candidates.value[selected.value];
  if (!c) return;
  busy.value = true;
  nextTick(() => {
    const r = isPlanet.value
      ? store.synthesizePlanetTerrain(props.planetId, {
        params: c.params,
        force: true,
        keepHandEdits: keepHandEdits.value,
      })
      : store.synthesizeBaseMapTerrain(props.baseMapKey, {
        params: c.params,
        force: true,
        keepHandEdits: keepHandEdits.value,
      });
    busy.value = false;
    if (!r || r.ok === false) {
      warn.value = (r && r.message) || '应用失败';
      return;
    }
    emit('apply', r);
  });
}

// 换底图 / 换行星 → 旧候选作废（否则会把上一张地图的缩略图当成这一张的）
watch(() => [props.baseMapKey, props.planetId], () => {
  candidates.value = [];
  selected.value = 0;
  elapsedMs.value = null;
});

watch(candidates, () => nextTick(() => drawAll()));

const summary = computed(() => describeTerrainParams(paramSnapshot()));

// 打开面板即出一组候选（用户不用先猜"先在哪儿点"）
if (props.baseMapKey || props.planetId) runPreview();
defineExpose({ summary, keepHandEdits });
</script>

<style scoped>
/* 颜色与「分辨率」面板（.resample-panel）同口径：那一片是深色面板，不跟主题切；
   这里若用 --text-primary，浅色主题下会变成深字压深底（读不出来）。 */
.tgen {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 2px 2px 6px;
  width: 100%;
  max-width: 680px;
  font-size: 12px;
  color: #cbd5e1;
}
.tgen-head { display: flex; align-items: baseline; gap: 10px; }
.tgen-head strong { font-size: 13px; color: #e2e8f0; }
.tgen-sub { color: #94a3b8; font-size: 11px; }
.tgen-x {
  margin-left: auto; border: none; background: transparent; color: #94a3b8;
  cursor: pointer; line-height: 1; padding: 0 2px; display: inline-flex;
}
.tgen-presets { display: flex; gap: 6px; flex-wrap: wrap; }
.tgen-chip {
  border: 1px solid #475569; background: transparent; color: #cbd5e1;
  border-radius: 999px; padding: 2px 10px; font-size: 11px; cursor: pointer;
}
.tgen-chip.on { border-color: #38bdf8; color: #e2e8f0; background: rgba(56, 189, 248, 0.14); }
.tgen-rows { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 4px 16px; }
.tgen-check {
  display: flex; align-items: center; gap: 6px;
  color: #cbd5e1; font-size: 12px; cursor: pointer;
}
.tgen-check input[type='checkbox'] { accent-color: #38bdf8; }
.tgen-row { display: grid; grid-template-columns: 64px 1fr auto; align-items: center; gap: 6px; }
.tgen-row label { color: #94a3b8; white-space: nowrap; }
.tgen-row input[type='range'] { width: 100%; accent-color: #38bdf8; }
.tgen-row select {
  background: #0f172a; color: #e2e8f0; border: 1px solid #475569;
  border-radius: 4px; padding: 2px 6px; font-size: 12px;
}
.tgen-num {
  width: 76px; background: #0f172a; color: #e2e8f0; border: 1px solid #475569;
  border-radius: 4px; padding: 2px 6px; font-size: 12px;
}
.tgen-val { min-width: 34px; text-align: right; color: #94a3b8; font-variant-numeric: tabular-nums; }
.tgen-dice {
  border: 1px solid #475569; background: transparent; color: #cbd5e1;
  border-radius: 4px; cursor: pointer; display: inline-flex; padding: 2px 5px;
}
.tgen-cands-head { display: flex; align-items: center; gap: 8px; color: #94a3b8; }
.tgen-mini {
  border: 1px solid #475569; background: transparent; color: #cbd5e1;
  border-radius: 4px; padding: 1px 8px; font-size: 11px; cursor: pointer;
}
.tgen-cands { display: flex; gap: 8px; flex-wrap: wrap; }
.tgen-cand {
  display: flex; flex-direction: column; gap: 2px; padding: 4px;
  border: 1px solid #475569; background: transparent; border-radius: 6px; cursor: pointer;
}
.tgen-cand.on { border-color: #38bdf8; box-shadow: 0 0 0 1px #38bdf8 inset; }
.tgen-cand canvas { display: block; border-radius: 4px; width: 132px; height: 84px; }
.tgen-cand-name { font-size: 11px; }
.tgen-cand-meta { font-size: 10px; color: #94a3b8; }
.tgen-empty { color: #94a3b8; font-size: 11px; padding: 10px 0; }
.tgen-warn { color: #fca5a5; font-size: 11px; line-height: 1.6; }
.tgen-actions { display: flex; gap: 8px; }
.tgen-btn {
  border: 1px solid #475569; background: rgba(148, 163, 184, 0.12); color: #e2e8f0;
  border-radius: 4px; padding: 3px 12px; font-size: 12px; cursor: pointer;
}
.tgen-btn.primary { color: #0f172a; background: #38bdf8; border-color: #38bdf8; font-weight: 600; }
.tgen-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.tgen-btn:not(:disabled):hover { filter: brightness(1.12); }
.tgen-note { color: #94a3b8; font-size: 11px; line-height: 1.6; }
</style>
