<template>
  <div class="dgen" data-testid="derive-panel">
    <div class="dgen-head">
      <strong>文化 / 宗教 / 势力派生</strong>
      <span class="dgen-sub">逐格文化区 + 省份摘要 + 按文化分组建势力（可复现）</span>
      <button class="dgen-x" title="收起面板" @click="$emit('close')"><Icon name="x" :size="14"/></button>
    </div>

    <div class="dgen-rows">
      <div v-for="f in fields" :key="f.key" class="dgen-row" :title="f.hint">
        <label>{{ f.label }}</label>
        <template v-if="f.key === 'seed'">
          <input type="range" :min="f.min" :max="f.max" :step="f.step" :value="params[f.key]"
                 data-testid="dgen-seed" @input="setNum(f.key, $event)">
          <input class="dgen-num" type="number" :min="f.min" :max="f.max" :step="f.step"
                 :value="params[f.key]" data-testid="dgen-seed-num" @change="setNum(f.key, $event)">
          <button class="dgen-dice" title="换一个种子（确定性推进）" data-testid="dgen-dice" @click="dice">
            <Icon name="refresh-cw" :size="13"/>
          </button>
        </template>
        <template v-else>
          <input type="range" :min="f.min" :max="f.max" :step="f.step" :value="params[f.key]"
                 :data-testid="`dgen-${f.key}`" @input="setNum(f.key, $event)">
          <span class="dgen-val">{{ params[f.key] }}</span>
        </template>
      </div>
    </div>

    <div v-if="preview && preview.ok" class="dgen-preview" data-testid="dgen-preview">
      <div class="dgen-line">
        <b>预览</b>：{{ preview.derived.stats.cultureCount }} 文化 / {{ preview.derived.stats.religionCount }} 宗教
        · {{ preview.derived.stats.landCells }} 陆格 · {{ preview.polityPlan.stats.polities }} 势力 /
        {{ preview.polityPlan.stats.assigned }} 省
      </div>
      <div class="dgen-line dgen-dim">
        现有：文化 {{ preview.existing.cultureCells }} 格 / 宗教 {{ preview.existing.religionCells }} 格 /
        有文化的省 {{ preview.existing.provinceCultured }}/{{ preview.existing.provinceTotal }}
      </div>
    </div>
    <div v-if="preview && !preview.ok" class="dgen-warn">{{ preview.message }}</div>

    <div class="dgen-strategy">
      <span>再生成策略</span>
      <label><input v-model="strategy" type="radio" value="fill-empty" data-testid="dgen-strategy-fill"> 只补空（保留已有/手改）</label>
      <label><input v-model="strategy" type="radio" value="overwrite" data-testid="dgen-strategy-overwrite"> 覆盖已有</label>
    </div>
    <div class="dgen-note">
      · 文化/宗教：逐格写 `heightmap.culture/religion` + 省份摘要；**覆盖**会替换整层（会先问）。
      · 势力归属：**只补空**（只给没有任何归属/易主记录的省铺初始归属）。已有历史不动 ——
      改朝换代请用「涂归属」笔刷，它会按日期记账本。
    </div>

    <div v-if="warn" class="dgen-warn">{{ warn }}</div>
    <div class="dgen-actions">
      <button class="dgen-btn primary" :disabled="busy || !preview || !preview.ok"
              data-testid="dgen-apply-culture" @click="applyCulture">生成文化 / 宗教</button>
      <button class="dgen-btn" :disabled="busy || !scenarioKey"
              data-testid="dgen-apply-polity" @click="applyPolity">生成势力与归属</button>
      <button class="dgen-btn" :disabled="busy" @click="$emit('close')">关闭</button>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { useGeodataStore } from '../store/geodata';
import {
  CULTURE_PARAM_FIELDS, DEFAULT_CULTURE_PARAMS,
  normalizeCultureParams, rollSeed,
} from '../utils/terrainParams';

const props = defineProps({
  baseMapKey: { type: String, default: '' },
  scenarioKey: { type: String, default: '' },
});
const emit = defineEmits(['applied', 'close']);

const store = useGeodataStore();
const fields = CULTURE_PARAM_FIELDS;
const params = reactive({ ...DEFAULT_CULTURE_PARAMS });
const strategy = ref('fill-empty');
const preview = ref(null);
const busy = ref(false);
const warn = ref('');

function setNum(key, e) {
  const v = Number(e.target.value);
  if (Number.isFinite(v)) { params[key] = v; warn.value = ''; }
}
function dice() {
  params.seed = rollSeed(params.seed);
  refresh();
}
function snapshot() {
  const raw = {};
  for (const f of fields) raw[f.key] = params[f.key];
  return normalizeCultureParams(raw).params;
}
function refresh() {
  if (!props.baseMapKey) return;
  try {
    preview.value = store.previewCultureDerive(props.baseMapKey, snapshot());
  } catch (err) {
    preview.value = { ok: false, message: `预览失败：${(err && err.message) || err}` };
  }
}

async function applyCulture() {
  if (strategy.value === 'overwrite') {
    const ok = confirm(
      '「覆盖」会把这张底图现有的文化/宗教网格与省份文化摘要**整层替换**（手改也会被覆盖）。\n\n'
      + '只补空会保留已有数据。确定覆盖吗？',
    );
    if (!ok) return;
  }
  busy.value = true;
  warn.value = '';
  try {
    const r = store.applyCultureDerive(props.baseMapKey, snapshot(), { strategy: strategy.value });
    if (!r || r.ok === false) { warn.value = (r && r.message) || '派生失败'; return; }
    emit('applied', r, 'culture');
    refresh();
  } catch (err) {
    warn.value = `派生失败：${(err && err.message) || err}`;
  } finally {
    busy.value = false;
  }
}

async function applyPolity() {
  busy.value = true;
  warn.value = '';
  try {
    const r = store.applyPolityDerive(props.scenarioKey, snapshot());
    if (!r || r.ok === false) { warn.value = (r && r.message) || '势力派生失败'; return; }
    emit('applied', r, 'polity');
  } catch (err) {
    warn.value = `势力派生失败：${(err && err.message) || err}`;
  } finally {
    busy.value = false;
  }
}

watch(params, refresh, { deep: true });
watch(() => props.baseMapKey, refresh);
refresh();
defineExpose({ refresh });
</script>

<style scoped>
/* 与其它深色面板同口径（.resample-panel 是深底，不跟主题切） */
.dgen { display: flex; flex-direction: column; gap: 8px; padding: 2px 2px 6px; width: 100%; max-width: 720px; font-size: 12px; color: #cbd5e1; }
.dgen-head { display: flex; align-items: baseline; gap: 10px; }
.dgen-head strong { font-size: 13px; color: #e2e8f0; }
.dgen-sub { color: #94a3b8; font-size: 11px; }
.dgen-x { margin-left: auto; border: none; background: transparent; color: #94a3b8; cursor: pointer; padding: 0 2px; display: inline-flex; }
.dgen-rows { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 4px 16px; }
.dgen-row { display: grid; grid-template-columns: 64px 1fr auto; align-items: center; gap: 6px; }
.dgen-row label { color: #94a3b8; white-space: nowrap; }
.dgen-row input[type='range'] { width: 100%; accent-color: #a78bfa; }
.dgen-num { width: 76px; background: #0f172a; color: #e2e8f0; border: 1px solid #475569; border-radius: 4px; padding: 2px 6px; font-size: 12px; }
.dgen-val { min-width: 24px; text-align: right; color: #94a3b8; font-variant-numeric: tabular-nums; }
.dgen-dice { border: 1px solid #475569; background: transparent; color: #cbd5e1; border-radius: 4px; cursor: pointer; display: inline-flex; padding: 2px 5px; }
.dgen-preview { display: flex; flex-direction: column; gap: 2px; padding: 4px 8px; background: rgba(167, 139, 250, 0.08); border: 1px solid rgba(167, 139, 250, 0.35); border-radius: 5px; }
.dgen-line { line-height: 1.6; }
.dgen-dim { color: #94a3b8; font-size: 11px; }
.dgen-strategy { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; color: #94a3b8; }
.dgen-strategy label { display: inline-flex; align-items: center; gap: 4px; color: #cbd5e1; }
.dgen-note { color: #94a3b8; font-size: 11px; line-height: 1.7; }
.dgen-warn { color: #fca5a5; font-size: 11px; line-height: 1.6; }
.dgen-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.dgen-btn { border: 1px solid #475569; background: rgba(148, 163, 184, 0.12); color: #e2e8f0; border-radius: 4px; padding: 3px 12px; font-size: 12px; cursor: pointer; }
.dgen-btn.primary { color: #140b2e; background: #a78bfa; border-color: #a78bfa; font-weight: 600; }
.dgen-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.dgen-btn:not(:disabled):hover { filter: brightness(1.1); }
</style>
