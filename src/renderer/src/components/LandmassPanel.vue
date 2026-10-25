<template>
  <div class="lgen" data-testid="landmass-panel">
    <div class="lgen-head">
      <strong>造陆</strong>
      <span class="lgen-sub">参数生成大陆轮廓 → 用现有铺底切成省（一条撤销）</span>
      <button class="lgen-x" title="收起面板" @click="$emit('close')"><Icon name="x" :size="14"/></button>
    </div>

    <div class="lgen-presets">
      <button
        v-for="p in presets"
        :key="p.id"
        class="lgen-chip"
        :class="{ on: activePreset === p.id }"
        :data-testid="`lgen-preset-${p.id}`"
        @click="applyPreset(p)"
      >{{ p.name }}</button>
    </div>

    <div class="lgen-rows">
      <div v-for="f in fields" :key="f.key" class="lgen-row" :title="f.hint">
        <label>{{ f.label }}</label>
        <template v-if="f.kind === 'enum'">
          <select :value="params[f.key]" :data-testid="`lgen-${f.key}`" @change="setEnum(f.key, $event)">
            <option v-for="o in f.options" :key="o" :value="o">{{ shapeName(o) }}</option>
            <option v-if="!f.options.includes(params[f.key])" :value="params[f.key]">{{ params[f.key] }}</option>
          </select>
        </template>
        <template v-else-if="f.key === 'seed'">
          <input type="range" :min="f.min" :max="f.max" :step="f.step" :value="params[f.key]"
                 data-testid="lgen-seed" @input="setNum(f.key, $event)">
          <input class="lgen-num" type="number" :min="f.min" :max="f.max" :step="f.step"
                 :value="params[f.key]" data-testid="lgen-seed-num" @change="setNum(f.key, $event)">
          <button class="lgen-dice" title="换一个种子（确定性推进）" data-testid="lgen-dice" @click="dice">
            <Icon name="refresh-cw" :size="13"/>
          </button>
        </template>
        <template v-else-if="f.key === 'provinceCount'">
          <input type="range" :min="f.min" :max="f.max" :step="f.step" :value="params[f.key]"
                 data-testid="lgen-provinceCount" @input="setNum(f.key, $event)">
          <span class="lgen-val">{{ params[f.key] }}</span>
        </template>
        <template v-else>
          <input type="range" :min="f.min" :max="f.max" :step="f.step" :value="params[f.key]"
                 :data-testid="`lgen-${f.key}`" @input="setNum(f.key, $event)">
          <span class="lgen-val">{{ fmt(f) }}</span>
        </template>
      </div>
    </div>

    <div class="lgen-cands-head">
      <span>候选（同参数、不同种子）</span>
      <button class="lgen-mini" :disabled="busy" data-testid="lgen-preview" @click="runPreview">重新出候选</button>
      <span v-if="previewMs != null" class="lgen-sub">{{ previewMs }} ms</span>
    </div>
    <div class="lgen-cands">
      <button
        v-for="(c, i) in candidates"
        :key="c.id"
        class="lgen-cand"
        :class="{ on: i === selected }"
        :data-testid="`lgen-cand-${i}`"
        :title="`种子 ${c.seed} · ${c.stats.ringCount} 个环 · 陆地 ${(c.stats.landRatio * 100).toFixed(1)}%`"
        @click="selected = i"
      >
        <canvas :ref="(el) => setCanvas(i, el)" width="184" height="108" />
        <span class="lgen-cand-name">候选 {{ ['一', '二', '三', '四'][i] || i + 1 }}</span>
        <span class="lgen-cand-meta">种子 {{ c.seed }} · {{ (c.stats.landRatio * 100).toFixed(0) }}% 陆地</span>
      </button>
      <div v-if="!candidates.length && !busy" class="lgen-empty">还没有候选 —— 点「重新出候选」</div>
    </div>

    <div v-if="warn" class="lgen-warn">{{ warn }}</div>
    <div v-if="progress" class="lgen-progress" data-testid="lgen-progress">{{ progress }}</div>

    <div class="lgen-actions">
      <button class="lgen-btn primary" :disabled="busy || !candidates.length" data-testid="lgen-apply" @click="apply">
        {{ busy ? '铺底中…' : `造陆并铺 ${params.provinceCount} 省` }}
      </button>
      <button class="lgen-btn" data-testid="lgen-cancel" @click="$emit('close')">取消</button>
    </div>
    <div class="lgen-note">
      ⚠️ 造陆会**替换**这张底图现有陆地与省份（一次性 Ctrl+Z 可整体退回）。
      已有归属键会随旧省份一起退回 —— 不会只退一半。
      缩略图里**海岸线来自轮廓、山地河湖来自同一份地形高度图**（绿=低地、褐=山地、灰=高山），
      所以预览里看到的地形就是铺底后地形层的那份；铺底本身在点「造陆」后才算。
    </div>
  </div>
</template>

<script setup>
import { nextTick, reactive, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { useGeodataStore } from '../store/geodata';
import {
  DEFAULT_LAND_PARAMS, LAND_PARAM_FIELDS, LAND_PRESETS,
  normalizeLandParams, describeLandParams, rollSeed,
} from '../utils/terrainParams';
import { reliefRgb } from '../utils/landmassRelief';

const props = defineProps({
  baseMapKey: { type: String, default: '' },
  hasTerrain: { type: Boolean, default: false },
});
const emit = defineEmits(['apply', 'close']);

const store = useGeodataStore();
const fields = LAND_PARAM_FIELDS;
const presets = LAND_PRESETS;

const params = reactive({ ...DEFAULT_LAND_PARAMS });
const activePreset = ref('continent');
const candidates = ref([]);
const selected = ref(0);
const busy = ref(false);
const previewMs = ref(null);
const warn = ref('');
const progress = ref('');
const canvases = new Map();

function shapeName(id) {
  return { continent: '圆润大陆', elongated: '长条大陆', archipelago: '群岛' }[id] || id;
}
function setCanvas(i, el) {
  if (el) canvases.set(i, el); else canvases.delete(i);
}
function fmt(f) {
  if (f.key === 'landRatio') return `${(Number(params[f.key]) * 100).toFixed(0)}%`;
  return f.kind === 'int' ? String(params[f.key]) : Number(params[f.key]).toFixed(2);
}
function syncFrom(raw, presetId = '') {
  const { params: p } = normalizeLandParams(raw);
  for (const f of fields) params[f.key] = p[f.key];
  activePreset.value = presetId;
}
function applyPreset(p) {
  syncFrom(p.params, p.id);
  runPreview();
}
function setNum(key, e) {
  const v = Number(e.target.value);
  if (Number.isFinite(v)) { params[key] = v; activePreset.value = ''; warn.value = ''; }
}
function setEnum(key, e) {
  params[key] = e.target.value;
  activePreset.value = '';
}
function dice() {
  params.seed = rollSeed(params.seed);
  activePreset.value = '';
  runPreview();
}
function snapshot() {
  const raw = {};
  for (const f of fields) raw[f.key] = params[f.key];
  return normalizeLandParams(raw).params;
}
function runPreview() {
  if (!props.baseMapKey) { warn.value = '先选一张底图'; return; }
  busy.value = true;
  warn.value = '';
  nextTick(() => {
    const t0 = performance.now();
    let r = null;
    try {
      r = store.previewLandmass(props.baseMapKey, snapshot(), { count: 3 });
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
    previewMs.value = Math.round(performance.now() - t0);
    if (r.params) syncFrom(r.params, activePreset.value);
    nextTick(() => drawAll());
  });
}

// ── 缩略图：地形底图（高度栅格 + 山体阴影）+ 海岸线；没有地形数据时退回平涂 ────────
//
// v4（2026-10-25）：v3 的缩略图是一块**平涂的土黄**，只能看轮廓、看不出山与水。
// 现在造陆会顺带合成一份地形高度图（`terrainSynthesis`），这里把它染成地形图：
//   · 色带走 `utils/landmassRelief.js`（与出图工具**同一份**，否则预览与出图不同色）；
//   · 叠一层山体阴影（左上光源），山脊/谷地才看得出来；
//   · 湖泊（洞）与海岸线仍按矢量描，保证与真正铺底的轮廓一致。
function drawRelief(ctx, c, X, Y, s) {
  const r = c.relief;
  if (!r || !r.data || !r.w || !r.h) return false;
  const sea = Number.isFinite(c.stats && c.stats.seaLevel) ? c.stats.seaLevel : 20;
  const off = document.createElement('canvas');
  off.width = r.w;
  off.height = r.h;
  const octx = off.getContext('2d');
  if (!octx) return false;
  const img = octx.createImageData(r.w, r.h);
  const px = img.data;
  const at = (i, j) => r.data[Math.min(r.h - 1, j) * r.w + Math.min(r.w - 1, i)] * (100 / 255);
  for (let j = 0; j < r.h; j++) {
    for (let i = 0; i < r.w; i++) {
      const hv = at(i, j);
      const [cr, cg, cb] = reliefRgb(hv, sea);
      // 山体阴影只打在**陆地**上：海面是平的，给它叠阴影只会在栅格边缘露出
      // 一圈"比海更深/更浅"的带子（实测：看上去像一张贴图方框）。
      let shade = 1;
      if (hv >= sea) {
        const dx = (at(i + 1, j) - at(Math.max(0, i - 1), j)) * 0.5;
        const dy = (at(i, j + 1) - at(i, Math.max(0, j - 1))) * 0.5;
        shade = 1 + Math.max(-0.3, Math.min(0.3, (dx + dy) * 0.3));
      }
      const o = (j * r.w + i) * 4;
      px[o] = Math.max(0, Math.min(255, cr * shade));
      px[o + 1] = Math.max(0, Math.min(255, cg * shade));
      px[o + 2] = Math.max(0, Math.min(255, cb * shade));
      px[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  // 栅格的世界坐标 → 画布：`origin`/`spacing` 是它自己的口径（比 bbox 多一圈 pad），
  // 直接铺满画布会与矢量海岸线错开 3%（0.94 的留白），所以按同一套 X/Y 换算贴图。
  const ox0 = (r.origin && Number.isFinite(r.origin.x)) ? r.origin.x : (c.bbox ? c.bbox.minX : 0);
  const oy0 = (r.origin && Number.isFinite(r.origin.y)) ? r.origin.y : (c.bbox ? c.bbox.minY : 0);
  const sp = Number.isFinite(r.spacing) && r.spacing > 0 ? r.spacing : 1;
  const x0 = X(ox0), y0 = Y(oy0);
  const wpx = (r.w - 1) * sp * s, hpx = (r.h - 1) * sp * s;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, x0, y0, wpx, hpx);
  return true;
}

function drawOne(c) {
  const el = canvases.get(c.index);
  if (!el || !c) return;
  const ctx = el.getContext('2d');
  const w = el.width, h = el.height;
  const seaLevel = Number.isFinite(c.stats && c.stats.seaLevel) ? c.stats.seaLevel : 20;
  // 底色必须与地形栅格的**深海色**一致：地形图是矩形贴上去的，
  // 底色差一点就会在画面上露出一个"比海更深"的方框（实测：一眼就看得出是贴图边界）。
  const [sr, sg, sb] = reliefRgb(0, seaLevel);
  ctx.fillStyle = `rgb(${sr}, ${sg}, ${sb})`;
  ctx.fillRect(0, 0, w, h);
  const b = c.bbox || { minX: -900, minY: -500, maxX: 900, maxY: 500 };
  const bw = Math.max(1e-6, b.maxX - b.minX), bh = Math.max(1e-6, b.maxY - b.minY);
  const s = Math.min(w / bw, h / bh) * 0.94;
  const ox = (w - bw * s) / 2, oy = (h - bh * s) / 2;
  const X = (x) => ox + (x - b.minX) * s;
  const Y = (y) => oy + (y - b.minY) * s;
  ctx.fillStyle = '#c9b48a';
  ctx.strokeStyle = '#8a7850';
  ctx.lineWidth = 1;
  const trace = (pts) => {
    if (!pts || pts.length < 3) return false;
    ctx.beginPath();
    ctx.moveTo(X(pts[0].x), Y(pts[0].y));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(X(pts[i].x), Y(pts[i].y));
    ctx.closePath();
    return true;
  };
  if (!drawRelief(ctx, c, X, Y, s)) {
    for (const ring of c.rings || []) {
      if (!trace(ring.points)) continue;
      ctx.fill();
      ctx.stroke();
    }
  } else {
    // 海岸线：只描不填（地形底图已经铺过陆地色）
    ctx.strokeStyle = 'rgba(24, 33, 48, 0.85)';
    for (const ring of c.rings || []) {
      if (!trace(ring.points)) continue;
      ctx.stroke();
    }
  }
  // 湖泊：用海色挖回去（视觉上才能看出"里面有水"，而不是一整块面团）
  ctx.fillStyle = `rgb(${sr}, ${sg}, ${sb})`;
  for (const ring of c.rings || []) {
    for (const hole of ring.holes || []) {
      if (!trace(hole)) continue;
      ctx.fill();
    }
  }
}
function drawAll() {
  for (const c of candidates.value) drawOne(c);
}

async function apply() {
  const c = candidates.value[selected.value];
  if (!c) return;
  if (props.hasTerrain && !confirm(
    '这张底图已经有陆地/省份。\n\n造陆会整张替换它们（连同归属键），一次 Ctrl+Z 可整体退回。\n\n继续吗？',
  )) return;
  busy.value = true;
  warn.value = '';
  progress.value = '正在铺底切省…';
  try {
    // 轮廓参数用**选中那张候选**（保证应用结果与缩略图一致）；
    // 「铺底块数」只影响切分密度、不影响轮廓，所以取滑块当前值（改完不必重新出候选）。
    const applyParams = { ...c.params, provinceCount: Number(params.provinceCount) };
    const r = await store.generateLandmass(props.baseMapKey, applyParams, {
      force: props.hasTerrain,
      onProgress: (p) => { progress.value = p && p.message ? p.message : '正在铺底…'; },
    });
    if (!r || r.ok === false) {
      warn.value = (r && r.message) || '造陆失败';
      return;
    }
    emit('apply', r);
  } catch (err) {
    warn.value = `造陆失败：${(err && err.message) || err}`;
  } finally {
    busy.value = false;
    progress.value = '';
  }
}

watch(() => props.baseMapKey, () => {
  candidates.value = [];
  selected.value = 0;
  previewMs.value = null;
});
watch(candidates, () => nextTick(() => drawAll()));

if (props.baseMapKey) runPreview();
defineExpose({ summary: () => describeLandParams(snapshot()) });
</script>

<style scoped>
/* 与「分辨率 / 生成参数」面板同口径：深色面板，不跟主题切（.resample-panel 是深底） */
.lgen { display: flex; flex-direction: column; gap: 8px; padding: 2px 2px 6px; width: 100%; max-width: 700px; font-size: 12px; color: #cbd5e1; }
.lgen-head { display: flex; align-items: baseline; gap: 10px; }
.lgen-head strong { font-size: 13px; color: #e2e8f0; }
.lgen-sub { color: #94a3b8; font-size: 11px; }
.lgen-x { margin-left: auto; border: none; background: transparent; color: #94a3b8; cursor: pointer; padding: 0 2px; display: inline-flex; }
.lgen-presets { display: flex; gap: 6px; flex-wrap: wrap; }
.lgen-chip { border: 1px solid #475569; background: transparent; color: #cbd5e1; border-radius: 999px; padding: 2px 10px; font-size: 11px; cursor: pointer; }
.lgen-chip.on { border-color: #34d399; color: #e2e8f0; background: rgba(52, 211, 153, 0.14); }
.lgen-rows { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 4px 16px; }
.lgen-row { display: grid; grid-template-columns: 76px 1fr auto; align-items: center; gap: 6px; }
.lgen-row label { color: #94a3b8; white-space: nowrap; }
.lgen-row input[type='range'] { width: 100%; accent-color: #34d399; }
.lgen-row select { background: #0f172a; color: #e2e8f0; border: 1px solid #475569; border-radius: 4px; padding: 2px 6px; font-size: 12px; }
.lgen-num { width: 76px; background: #0f172a; color: #e2e8f0; border: 1px solid #475569; border-radius: 4px; padding: 2px 6px; font-size: 12px; }
.lgen-val { min-width: 42px; text-align: right; color: #94a3b8; font-variant-numeric: tabular-nums; }
.lgen-dice { border: 1px solid #475569; background: transparent; color: #cbd5e1; border-radius: 4px; cursor: pointer; display: inline-flex; padding: 2px 5px; }
.lgen-cands-head { display: flex; align-items: center; gap: 8px; color: #94a3b8; }
.lgen-mini { border: 1px solid #475569; background: transparent; color: #cbd5e1; border-radius: 4px; padding: 1px 8px; font-size: 11px; cursor: pointer; }
.lgen-cands { display: flex; gap: 8px; flex-wrap: wrap; }
.lgen-cand { display: flex; flex-direction: column; gap: 2px; padding: 4px; border: 1px solid #475569; background: transparent; border-radius: 6px; cursor: pointer; }
.lgen-cand.on { border-color: #34d399; box-shadow: 0 0 0 1px #34d399 inset; }
.lgen-cand canvas { display: block; border-radius: 4px; width: 184px; height: 108px; }
.lgen-cand-name { font-size: 11px; }
.lgen-cand-meta { font-size: 10px; color: #94a3b8; }
.lgen-empty { color: #94a3b8; font-size: 11px; padding: 10px 0; }
.lgen-warn { color: #fca5a5; font-size: 11px; line-height: 1.6; }
.lgen-progress { color: #93c5fd; font-size: 11px; }
.lgen-actions { display: flex; gap: 8px; }
.lgen-btn { border: 1px solid #475569; background: rgba(148, 163, 184, 0.12); color: #e2e8f0; border-radius: 4px; padding: 3px 12px; font-size: 12px; cursor: pointer; }
.lgen-btn.primary { color: #052e1a; background: #34d399; border-color: #34d399; font-weight: 600; }
.lgen-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.lgen-btn:not(:disabled):hover { filter: brightness(1.1); }
.lgen-note { color: #94a3b8; font-size: 11px; line-height: 1.6; }
</style>
