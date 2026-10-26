<template>
  <div class="tlab" data-testid="terrain-labels-panel">
    <div class="tlab-head">
      <strong>地形注记</strong>
      <span class="tlab-sub">山系名沿脊线排；名字由你给，几何由地形决定</span>
      <button class="tlab-x" title="收起面板" @click="$emit('close')"><Icon name="x" :size="14"/></button>
    </div>

    <div class="tlab-actions">
      <button
        class="tlab-btn"
        data-testid="terrain-labels-detect"
        :disabled="busy || !hasHeightmap"
        :title="hasHeightmap ? '从高度图抽山脊候选（只算一次；已命名的条目不覆盖）' : '这张底图还没有高度图 —— 先造陆或生成地形'"
        @click="detect"
      >{{ busy ? '检测中…' : '检测山脊' }}</button>
      <button
        class="tlab-btn primary"
        data-testid="terrain-labels-apply"
        :disabled="busy || !rows.length"
        title="整表保存（一条 Ctrl+Z 可退回）"
        @click="apply"
      >应用</button>
      <span class="tlab-status" data-testid="terrain-labels-status">{{ status }}</span>
    </div>

    <div v-if="!rows.length" class="tlab-empty">
      还没有注记。点「检测山脊」抽候选，填名字后再「应用」——
      没名字的候选不会落库（不自动编专名）。
    </div>

    <div v-else class="tlab-rows">
      <div v-for="(row, i) in rows" :key="row.id" class="tlab-row" :class="{ auto: row.origin === 'auto' }">
        <input
          class="tlab-name"
          :value="row.name"
          :placeholder="row.origin === 'auto' ? '给这条山脊起名…' : '（无名字）'"
          :data-testid="`terrain-label-name-${i}`"
          @input="row.name = $event.target.value"
        >
        <span class="tlab-badge" :class="{ auto: row.origin === 'auto' }">{{ row.origin === 'auto' ? '自动' : '手绘' }}</span>
        <span class="tlab-meta">{{ row.meta || `${(row.points || []).length} 点` }}</span>
        <button class="tlab-del" title="删掉这一条" @click="removeRow(i)"><Icon name="trash-2" :size="13"/></button>
      </div>
    </div>

    <div class="tlab-note">
      自动项只来自高度图抽出的脊线（候选可筛、可删）；用户手绘的注记永远不会被“重新检测”覆盖。
      海域 / 平原注记与沿河排字在下一批。
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';
import Icon from './Icon.vue';
import { useGeodataStore } from '../store/geodata';
import { detectRidges } from '../utils/ridges';
import { smoothPolyline } from '../utils/polylineSmooth';
import { simplifyContour } from '../utils/contour';
import { SEA_LEVEL } from '../utils/heightMath';

const props = defineProps({
  baseMapKey: { type: String, default: '' },
  hasHeightmap: { type: Boolean, default: false },
});
const emit = defineEmits(['applied', 'close']);

const store = useGeodataStore();
const rows = ref([]);
const busy = ref(false);
const status = ref('');

function bm() {
  return (store.baseMaps && props.baseMapKey) ? store.baseMaps[props.baseMapKey] : null;
}

function loadSaved() {
  const m = bm();
  const list = (m && Array.isArray(m.terrainLabels)) ? m.terrainLabels : [];
  rows.value = list.map((t) => ({
    id: t.id,
    kind: t.kind || 'range',
    name: t.name || '',
    points: Array.isArray(t.points) ? t.points : [],
    origin: t.origin === 'auto' ? 'auto' : 'user',
    meta: `${(t.points || []).length} 点`,
  }));
  status.value = '';
}

watch(() => props.baseMapKey, loadSaved, { immediate: true });

function detect() {
  busy.value = true;
  status.value = '';
  try {
    const hm = store.getHeightmapFor ? store.getHeightmapFor(props.baseMapKey) : null;
    if (!hm || !hm.grid || !hm.h) {
      status.value = '这张底图没有高度图 —— 先造陆/生成地形';
      return;
    }
    const cands = detectRidges(hm, {
      seaLevel: SEA_LEVEL,
      maxRidges: 10,
      smooth: (pts) => smoothPolyline(pts, 2),
    });
    // 「检测」只替换**没命名的自动候选**：已命名的（用户正在编辑的）与手绘的一条都不动。
    const kept = rows.value.filter((r) => !(r.origin === 'auto' && !String(r.name || '').trim()));
    const stamp = Date.now().toString(36);
    // 平滑后的脊线点数会被 Chaikin 放大 4 倍（实测 148 点/条）→ 落库前 RDP 抽稀，
    // 保留形状（eps = 0.35 格）；一条山脊 30~50 点足够画字。
    const eps = Math.max(3, (Number(hm.grid.spacing) || 10) * 0.35);
    const added = cands.map((c, i) => {
      const simplified = simplifyContour(c.points, eps);
      const points = simplified.length >= 2 ? simplified : c.points;
      return {
        id: `auto_${stamp}_${i}`,
        kind: 'range',
        name: '',
        points,
        origin: 'auto',
        meta: `${c.cells} 格 · 峰 ${Math.round(c.peakHeight)} · ${points.length} 点`,
      };
    });
    rows.value = [...kept, ...added];
    status.value = cands.length
      ? `检测到 ${cands.length} 条山脊候选 —— 填名字后「应用」（没名字的不会落库）`
      : '没检测到山脊（地形太平缓，或这张图没有起伏）';
  } catch (err) {
    status.value = `检测失败：${(err && err.message) || err}`;
  } finally {
    busy.value = false;
  }
}

function removeRow(i) {
  rows.value.splice(i, 1);
}

function apply() {
  const labels = rows.value
    .filter((r) => String(r.name || '').trim())
    .map((r) => ({ id: r.id, kind: r.kind || 'range', name: String(r.name).trim(), points: r.points, origin: r.origin }));
  if (!labels.length) {
    status.value = '还没有命名任何一条 —— 没名字不落库';
    return;
  }
  const res = store.applyTerrainLabels ? store.applyTerrainLabels(props.baseMapKey, labels) : null;
  if (!res) { status.value = 'store 没有 applyTerrainLabels（模块未挂上）'; return; }
  status.value = res.message || (res.ok ? '已保存' : '保存失败');
  if (res.ok && res.changed) emit('applied', res.message || '');
}
</script>

<style scoped>
/* 与「地形生成参数」面板同一套深色口径（.resample-panel 里不跟主题切） */
.tlab {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 2px 2px 6px;
  width: 100%;
  max-width: 680px;
  font-size: 12px;
  color: #cbd5e1;
}
.tlab-head { display: flex; align-items: baseline; gap: 10px; }
.tlab-head strong { font-size: 13px; color: #e2e8f0; }
.tlab-sub { color: #94a3b8; font-size: 11px; }
.tlab-x {
  margin-left: auto; border: none; background: transparent; color: #94a3b8;
  cursor: pointer; line-height: 1; padding: 0 2px; display: inline-flex;
}
.tlab-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tlab-btn {
  border: 1px solid #475569; background: rgba(148, 163, 184, 0.12); color: #e2e8f0;
  border-radius: 4px; padding: 3px 12px; font-size: 12px; cursor: pointer;
}
.tlab-btn.primary { color: #0f172a; background: #38bdf8; border-color: #38bdf8; font-weight: 600; }
.tlab-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.tlab-status { color: #94a3b8; font-size: 11px; line-height: 1.5; }
.tlab-empty { color: #94a3b8; font-size: 11px; line-height: 1.7; padding: 6px 0; }
.tlab-rows { display: flex; flex-direction: column; gap: 4px; max-height: 300px; overflow: auto; }
.tlab-row {
  display: grid; grid-template-columns: 1fr auto 90px auto; align-items: center; gap: 8px;
  padding: 3px 6px; border: 1px solid #334155; border-radius: 4px;
}
.tlab-row.auto { border-color: #3f5a72; }
.tlab-name {
  background: #0f172a; color: #e2e8f0; border: 1px solid #475569;
  border-radius: 4px; padding: 2px 6px; font-size: 12px; min-width: 0;
}
.tlab-badge {
  font-size: 10px; padding: 1px 6px; border-radius: 999px;
  border: 1px solid #475569; color: #94a3b8;
}
.tlab-badge.auto { border-color: #38bdf8; color: #7dd3fc; }
.tlab-meta { color: #94a3b8; font-size: 10px; text-align: right; font-variant-numeric: tabular-nums; }
.tlab-del {
  border: 1px solid #475569; background: transparent; color: #94a3b8;
  border-radius: 4px; cursor: pointer; display: inline-flex; padding: 2px 5px;
}
.tlab-del:hover { color: #fca5a5; border-color: #fca5a5; }
.tlab-note { color: #94a3b8; font-size: 11px; line-height: 1.6; }
</style>
