<template>
  <div class="fmg" data-testid="fmg-panel">
    <div class="fmg-head">
      <strong>FMG 模板地形</strong>
      <span class="fmg-sub">14 套 Azgaar 模板（大陆 / 群岛 / 环礁 / 地中海…）→ 直接出高度图</span>
      <button class="fmg-x" title="收起面板" @click="$emit('close')"><Icon name="x" :size="14"/></button>
    </div>

    <div class="fmg-rows">
      <div class="fmg-row">
        <label>模板</label>
        <select v-model="params.template" data-testid="fmg-template" @change="runPreview">
          <option v-for="t in templates" :key="t.id" :value="t.id">{{ t.name }}</option>
        </select>
      </div>
      <div class="fmg-row">
        <label>种子</label>
        <input type="number" class="fmg-num" min="1" max="999999" v-model.number="params.seed" data-testid="fmg-seed" @change="runPreview" />
        <button class="fmg-dice" title="换一个种子（确定性推进，可复现）" data-testid="fmg-dice" @click="dice">
          <Icon name="refresh-cw" :size="13"/>
        </button>
      </div>
      <div class="fmg-row">
        <label>陆地</label>
        <input type="range" min="5" max="90" step="1" v-model.number="coveragePct" data-testid="fmg-coverage" />
        <span class="fmg-val">{{ coveragePct }}%</span>
      </div>
      <div class="fmg-row">
        <label>崎岖度</label>
        <input type="range" min="0" max="100" step="5" v-model.number="params.roughness" data-testid="fmg-roughness" />
        <span class="fmg-val">{{ params.roughness }}</span>
      </div>
      <div class="fmg-row">
        <label>精度</label>
        <select v-model.number="params.cells" data-testid="fmg-cells">
          <option :value="2000">2k 格（快）</option>
          <option :value="8000">8k 格</option>
          <option :value="16000">16k 格</option>
          <option :value="32000">32k 格</option>
        </select>
      </div>
    </div>

    <label class="fmg-check" title="重生成时把已手绘的高度按图幅相对位置搬到新图（换种子则不保留）。关掉 = 手绘全部丢弃。">
      <input type="checkbox" v-model="keepHandEdits" data-testid="fmg-keep-hand" />
      重生成保留手绘地形
    </label>

    <div class="fmg-cands-head">
      <span>候选（同参数、不同种子）</span>
      <button class="fmg-mini" :disabled="busy" data-testid="fmg-preview" @click="runPreview">
        {{ busy ? '生成中…' : '重新出候选' }}
      </button>
      <span v-if="elapsedMs != null" class="fmg-sub">{{ elapsedMs }} ms</span>
    </div>
    <div class="fmg-cands">
      <button
        v-for="(c, i) in candidates"
        :key="c.id"
        class="fmg-cand"
        :class="{ on: i === selected }"
        :data-testid="`fmg-cand-${i}`"
        :title="`种子 ${c.seed} · ${c.cols}×${c.rows} · 陆地 ${(c.landRatio * 100).toFixed(1)}%`"
        @click="selected = i"
      >
        <canvas :ref="(el) => setCanvas(i, el)" width="132" height="84" />
        <span class="fmg-cand-name">候选 {{ ['一', '二', '三', '四'][i] || i + 1 }}</span>
        <span class="fmg-cand-meta">种子 {{ c.seed }} · 陆地 {{ (c.landRatio * 100).toFixed(0) }}%</span>
      </button>
      <div v-if="!candidates.length && !busy" class="fmg-empty">还没有候选 —— 点「重新出候选」</div>
    </div>

    <div v-if="warn" class="fmg-warn">{{ warn }}</div>

    <div class="fmg-actions">
      <button class="fmg-btn primary" :disabled="busy || !candidates.length" data-testid="fmg-apply" @click="apply">
        {{ busy ? '生成中…' : '应用所选（一条撤销）' }}
      </button>
      <button class="fmg-btn" data-testid="fmg-cancel" @click="$emit('close')">取消</button>
    </div>
    <div class="fmg-note">
      ⚠️ 应用会**替换**现有地形高度图（一条 Ctrl+Z 可撤回）。预览是粗网格（{{ previewCells }} 格），
      应用时按你选的精度重算 —— 同种子 + 同参数 = 逐格一致。
      <br>河道不在这一步生成：应用后点「自动河流」（用的是同一套河网追踪，FMG 地形已填平洼地，能长出河）。
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { useGeodataStore } from '../store/geodata';
import { TEMPLATE_IDS, HEIGHT_TEMPLATES } from '../utils/fmg/templates';
import { drawHeightThumb } from '../utils/heightThumb';

const props = defineProps({
  baseMapKey: { type: String, default: '' },
  planetId: { type: String, default: '' },
});
const emit = defineEmits(['apply', 'close']);

const store = useGeodataStore();
const templates = TEMPLATE_IDS.map((id) => ({ id, name: HEIGHT_TEMPLATES[id].name }));
const isPlanet = computed(() => !!props.planetId);

const params = reactive({ template: 'continents', seed: 7, coverage: 0.35, roughness: 0, cells: 8000 });
const coveragePct = computed({
  get: () => Math.round(params.coverage * 100),
  set: (v) => { params.coverage = Math.max(0.05, Math.min(0.9, Number(v) / 100)); },
});
const keepHandEdits = ref(true);
const candidates = ref([]);
const selected = ref(0);
const busy = ref(false);
const elapsedMs = ref(null);
const previewCells = ref(2500);
const warn = ref('');
const canvases = new Map();

function setCanvas(i, el) {
  if (el) canvases.set(i, el);
  else canvases.delete(i);
}

function snapshot() {
  return { ...params, coverage: coveragePct.value / 100 };
}

function runPreview() {
  if (!props.baseMapKey && !props.planetId) { warn.value = '先打开一张地图'; return; }
  busy.value = true;
  warn.value = '';
  nextTick(() => {
    const t0 = performance.now();
    let r = null;
    try {
      const target = isPlanet.value
        ? { kind: 'planet', planetId: props.planetId }
        : { kind: 'basemap', key: props.baseMapKey };
      r = store.previewFmgTerrain(target, snapshot(), { count: 3, cells: 2500 });
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
    previewCells.value = r.previewCells || 2500;
    selected.value = 0;
    elapsedMs.value = Math.round(performance.now() - t0);
    nextTick(() => drawAll());
  });
}

function drawAll() {
  for (let i = 0; i < candidates.value.length; i++) {
    const c = candidates.value[i];
    const el = canvases.get(i);
    if (!el || !c) continue;
    const ctx = el.getContext('2d');
    ctx.clearRect(0, 0, el.width, el.height);
    drawHeightThumb(ctx, { h: c.h, cols: c.cols, rows: c.rows });
  }
}

function dice() {
  params.seed = Math.max(1, (Math.floor(params.seed * 1.6180339887) % 997) + 1);
  runPreview();
}

function apply() {
  const c = candidates.value[selected.value];
  if (!c) return;
  busy.value = true;
  warn.value = '';
  nextTick(() => {
    const target = isPlanet.value
      ? { kind: 'planet', planetId: props.planetId }
      : { kind: 'basemap', key: props.baseMapKey };
    const r = store.applyFmgTerrain(target, { ...snapshot(), seed: c.seed }, {
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

watch(() => [props.baseMapKey, props.planetId], () => {
  candidates.value = [];
  selected.value = 0;
  elapsedMs.value = null;
});
watch(candidates, () => nextTick(() => drawAll()));

if (props.baseMapKey || props.planetId) runPreview();
</script>

<style scoped>
/* 与 TerrainGenPanel 同一套深色口径（面板装在 .gen-float / .planet-gen-float 里，不跟主题切） */
.fmg { display: flex; flex-direction: column; gap: 8px; padding: 2px 2px 6px; width: 100%; max-width: 680px; font-size: 12px; color: #cbd5e1; }
.fmg-head { display: flex; align-items: baseline; gap: 10px; }
.fmg-head strong { font-size: 13px; color: #e2e8f0; }
.fmg-sub { color: #94a3b8; font-size: 11px; }
.fmg-x { margin-left: auto; border: none; background: transparent; color: #94a3b8; cursor: pointer; line-height: 1; padding: 0 2px; display: inline-flex; }
.fmg-rows { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 4px 16px; }
.fmg-row { display: grid; grid-template-columns: 64px 1fr auto; align-items: center; gap: 6px; }
.fmg-row label { color: #94a3b8; white-space: nowrap; }
.fmg-row input[type='range'] { width: 100%; accent-color: #38bdf8; }
.fmg-row select { background: #0f172a; color: #e2e8f0; border: 1px solid #475569; border-radius: 4px; padding: 2px 6px; font-size: 12px; }
.fmg-num { width: 76px; background: #0f172a; color: #e2e8f0; border: 1px solid #475569; border-radius: 4px; padding: 2px 6px; font-size: 12px; }
.fmg-val { min-width: 34px; text-align: right; color: #94a3b8; font-variant-numeric: tabular-nums; }
.fmg-dice { border: 1px solid #475569; background: transparent; color: #cbd5e1; border-radius: 4px; cursor: pointer; display: inline-flex; padding: 2px 5px; }
.fmg-check { display: flex; align-items: center; gap: 6px; color: #cbd5e1; font-size: 12px; cursor: pointer; }
.fmg-check input[type='checkbox'] { accent-color: #38bdf8; }
.fmg-cands-head { display: flex; align-items: center; gap: 8px; color: #94a3b8; }
.fmg-mini { border: 1px solid #475569; background: transparent; color: #cbd5e1; border-radius: 4px; padding: 1px 8px; font-size: 11px; cursor: pointer; }
.fmg-cands { display: flex; gap: 8px; flex-wrap: wrap; }
.fmg-cand { display: flex; flex-direction: column; gap: 2px; padding: 4px; border: 1px solid #475569; background: transparent; border-radius: 6px; cursor: pointer; }
.fmg-cand.on { border-color: #38bdf8; box-shadow: 0 0 0 1px #38bdf8 inset; }
.fmg-cand canvas { display: block; border-radius: 4px; width: 132px; height: 84px; }
.fmg-cand-name { font-size: 11px; }
.fmg-cand-meta { font-size: 10px; color: #94a3b8; }
.fmg-empty { color: #94a3b8; font-size: 11px; padding: 10px 0; }
.fmg-warn { color: #fca5a5; font-size: 11px; line-height: 1.6; }
.fmg-actions { display: flex; gap: 8px; }
.fmg-btn { border: 1px solid #475569; background: rgba(148, 163, 184, 0.12); color: #e2e8f0; border-radius: 4px; padding: 3px 12px; font-size: 12px; cursor: pointer; }
.fmg-btn.primary { color: #0f172a; background: #38bdf8; border-color: #38bdf8; font-weight: 600; }
.fmg-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.fmg-btn:not(:disabled):hover { filter: brightness(1.12); }
.fmg-note { color: #94a3b8; font-size: 11px; line-height: 1.6; }
</style>
