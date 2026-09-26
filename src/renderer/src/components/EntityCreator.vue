<template>
  <div class="ec-overlay" @click.self="$emit('close')">
    <div class="ec-card" role="dialog" aria-label="新建实体">
      <header class="ec-head">
        <span class="ec-title">{{ batchMode ? '批量新建实体' : '新建实体' }}</span>
        <!-- 单个 / 批量 切换（B7，2026-09-24）：真实建世界观是「一次建一批」（粘 30 个城市名），
             逐个建 = 30 次操作 + 30 条 undo 记录。 -->
        <div class="ec-mode" role="tablist">
          <button class="ec-mode-btn" :class="{ active: !batchMode }" role="tab"
                  data-testid="ec-mode-single" @click="batchMode = false">单个</button>
          <button class="ec-mode-btn" :class="{ active: batchMode }" role="tab"
                  data-testid="ec-mode-batch" @click="batchMode = true">批量</button>
        </div>
        <button class="ec-x" title="关闭" @click="$emit('close')">×</button>
      </header>

      <div class="ec-body">
        <!-- 表单 -->
        <div v-if="!batchMode" class="ec-field">
          <label>名称</label>
          <input
            ref="nameInput"
            v-model="name"
            class="ec-input"
            placeholder="如 青崖城 / 东部荒原"
            @keydown.enter="create"
          />
          <span class="ec-id" :title="'实体 id（由名称规范化，重名自动加序号）'">id: {{ previewId || '—' }}</span>
        </div>

        <!-- 批量模式：每行一个名称（B7） -->
        <div v-else class="ec-field">
          <label>名称（每行一个）</label>
          <textarea
            ref="batchInput"
            v-model="batchNames"
            class="ec-input ec-textarea"
            rows="6"
            data-testid="ec-batch-names"
            placeholder="每行一个名称，例如：&#10;青崖城&#10;落雁关&#10;碧水镇"
          ></textarea>
          <span class="ec-id">将创建 {{ batchCount }} 个实体 · 与已有实体同名的会自动跳过并列出</span>
        </div>

        <div class="ec-field">
          <label>层级</label>
          <select v-model="layer" class="ec-input" data-testid="ec-layer">
            <option v-for="l in layerOptions" :key="l" :value="l">{{ LAYER_LABELS[l] || l }}（{{ l }}）</option>
          </select>
        </div>
        <div v-if="layerFilterHint" class="ec-hint">{{ layerFilterHint }}</div>

        <div class="ec-field">
          <label>父级</label>
          <select v-model="parentId" class="ec-input" data-testid="ec-parent">
            <option value="">（顶层）</option>
            <option v-for="e in parentOptions" :key="e.id" :value="e.id">
              {{ e.name }}（{{ e.layerLabel }}）
            </option>
          </select>
        </div>

        <div v-if="!batchMode" class="ec-field">
          <label>标签</label>
          <input v-model="tagsText" class="ec-input" placeholder="逗号分隔，可留空" />
        </div>

        <div v-if="!batchMode" class="ec-field">
          <label>坐标</label>
          <div class="ec-coord">
            <input v-model="coordX" class="ec-input small" placeholder="x（可留空）" />
            <input v-model="coordY" class="ec-input small" placeholder="y（可留空）" />
          </div>
        </div>

        <!-- 分派计划：C 方案的核心 —— 创建后按层级走不同的落位/绘制流程（创建前作为预告） -->
        <div v-if="!batchMode && !created" class="ec-dispatch">
          <div class="ec-dispatch-title">创建后</div>
          <ol>
            <li v-for="(s, i) in dispatchSteps" :key="i">{{ s }}</li>
          </ol>
          <div class="ec-note">
            点「前往编辑」会把画布切到该实体所在的视图（区域 → 区域地图绘制边界，地点 → 行星表面落位，建筑 → 建筑内部）。
          </div>
        </div>

        <!-- 创建结果卡片（用户决策 2026-09-19）：结果 + 该层级的分派流程 + 「前往编辑」 -->
        <div v-if="!batchMode && created" class="ec-card-done">
          <div class="ec-result ok">已创建「{{ created.entity.name }}」（id: {{ created.entity.id }}，层级 {{ created.entity.layerLabel }}）</div>
          <div class="ec-dispatch">
            <div class="ec-dispatch-title">下一步</div>
            <ol>
              <li v-for="(s, i) in created.steps" :key="i">{{ s }}</li>
            </ol>
            <div class="ec-note">
              点「前往编辑」会把画布切到该实体所在的视图（区域 → 区域地图绘制边界，地点 → 行星表面落位，建筑 → 建筑内部）。
            </div>
          </div>
          <div class="ec-card-actions">
            <button class="ec-btn primary" @click="gotoEdit">前往编辑</button>
            <button class="ec-btn" @click="reset">再建一个</button>
          </div>
        </div>

        <div v-if="result && !result.ok" class="ec-result err">{{ result.text }}</div>

        <!-- 批量结果（B7）：新建了哪些、跳过了哪些都要摊开说（不静默吞同名） -->
        <div v-if="batchMode && batchResult" class="ec-card-done">
          <div class="ec-result ok">
            已创建 {{ batchResult.created.length }} 个实体（层级 {{ LAYER_LABELS[layer] || layer }}，一次 Ctrl+Z 可整体撤销）
          </div>
          <div v-if="batchResult.skipped.length" class="ec-result err">
            跳过 {{ batchResult.skipped.length }} 个：{{ batchResult.skipped.join('、') }}
          </div>
          <div class="ec-card-actions">
            <button class="ec-btn" @click="resetBatch">再建一批</button>
          </div>
        </div>
        <div v-if="batchMode && batchError" class="ec-result err">{{ batchError }}</div>
      </div>

      <footer class="ec-foot">
        <span class="ec-parent-hint">{{ parentHint }}</span>
        <button class="ec-btn" @click="$emit('close')">关闭</button>
        <button class="ec-btn" :disabled="!created" @click="reset">清空重填</button>
        <button v-if="!batchMode" class="ec-btn primary" :disabled="!name.trim()" @click="create">创建</button>
        <button v-else class="ec-btn primary" data-testid="ec-batch-create"
                :disabled="!batchCount" @click="createBatch">批量创建{{ batchCount ? ` ${batchCount} 个` : '' }}</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
// components/EntityCreator.vue — 实体创建向导（Phase 2.2，C 方案「分派式向导」）
//
// 用户决策（2026-09-18）：实体创建用 C 方案 —— 表单填「名称 / 层级 / 父级」，
// 再**按层级自动分派后续步骤**，画布交互一律复用各视图现有工具，不在弹窗里再实现一套画布。
// 依据：只有 region 一个层级天生带多边形边界，其余层级是点/圆/卡片/容器（见层级×空间能力矩阵）。
//
// 本组件只写 `projectStore`（项目实体），不碰 geodata：接线（Phase 2.4）由 geodata 侧完成。

import { computed, nextTick, ref, watch } from 'vue';
import { useProjectStore } from '../store/projectStore';
import { LAYER_LABELS } from '../utils/projectSchema';

const props = defineProps({
  open: { type: Boolean, default: false },
});
const emit = defineEmits(['close', 'goto']);

const proj = useProjectStore();
const nameInput = ref(null);

// 可创建层级：与区域地图的「建筑」工具保持一致（2026-09-21 用户反馈：建筑只能在区域地图里建
// → 两条入口不一致）。building 的合法父级仍是 region / city / town / village（见 CHILD_LAYERS）。
const CREATABLE = ['world', 'star_domain', 'galaxy', 'star', 'planet', 'moon',
  'region', 'city', 'town', 'village', 'facility', 'location', 'building'];

// 层级父子关系（与知识库地理系统层级一致，用于「按已选父级过滤层级下拉」）
const CHILD_LAYERS = {
  world: ['star_domain'],
  star_domain: ['galaxy'],
  galaxy: ['star'],
  star: ['planet'],
  planet: ['moon', 'region', 'city', 'town', 'village', 'facility', 'location'],
  moon: ['region', 'city', 'town', 'village', 'facility', 'location'],
  region: ['city', 'town', 'village', 'facility', 'location', 'building'],
  city: ['facility', 'location', 'building'],
  town: ['facility', 'location', 'building'],
  village: ['facility', 'location', 'building'],
};

const name = ref('');
const layer = ref('city');
const parentId = ref('');
const tagsText = ref('');
const coordX = ref('');
const coordY = ref('');
const result = ref(null);       // 仅承载失败信息
const created = ref(null);      // { entity, steps } —— 创建成功后的结果卡片数据

// ===== 批量创建（B7，2026-09-24）=====
// 动机：真实建世界观是「一次建一批」（粘 30 个城市名）。逐个建 = 30 次操作 + 30 条 undo 记录；
//       而「批量导入笔记」那条路写的是 Obsidian .md，还得靠 reextract 才能回流 ——
//       在项目态被正确拒绝（两套事实源混流）→ 规模化建实体实际是死的。
// 语义：每行一个名称；空行忽略；与已有实体同名的跳过并**明确列出**（不静默吞）。
const batchMode = ref(false);
const batchInput = ref(null);
const batchNames = ref('');
const batchResult = ref(null);  // { created: [], skipped: [] }
const batchError = ref('');

const batchCount = computed(() => batchNames.value.split('\n').map(t => t.trim()).filter(Boolean).length);

// 切换模式时把焦点交给该模式的输入（与面板一致：不依赖点击落点的时序）
watch(batchMode, () => {
  nextTick(() => { (batchMode.value ? batchInput.value : nameInput.value)?.focus?.(); });
});

function createBatch() {
  batchError.value = '';
  batchResult.value = null;
  const res = proj.createEntities(batchNames.value.split('\n'), {
    layer: layer.value,
    parentId: parentId.value || null,
  });
  if (!res.success) { batchError.value = res.error || '批量创建失败'; return; }
  batchResult.value = { created: res.created || [], skipped: res.skipped || [] };
  if (res.nothingNew) batchError.value = '没有新建任何实体：这些名称都与已有实体重名';
}

function resetBatch() {
  batchNames.value = '';
  batchResult.value = null;
  batchError.value = '';
  nextTick(() => batchInput.value?.focus?.());
}

const previewId = computed(() => (name.value.trim() ? proj.previewEntityId(name.value.trim()) : ''));

const parentOptions = computed(() => {
  // 创建新实体时没有「自己」，只需排除……（新实体尚无后代）→ 全部实体都可作父级
  return proj.entityList;
});

// 父级约束：选定父级后，只允许建它语义上能容纳的子层级
const parentRestriction = computed(() => {
  if (!parentId.value) return null;
  const p = proj.getEntity(parentId.value);
  if (!p) return null;
  const list = (CHILD_LAYERS[p.layer] || []).filter(l => CREATABLE.includes(l));
  return list.length ? { parent: p, list } : null;
});

const layerOptions = computed(() => (parentRestriction.value ? parentRestriction.value.list : CREATABLE));

const layerFilterHint = computed(() => {
  if (parentRestriction.value) {
    const names = parentRestriction.value.list.map(l => LAYER_LABELS[l] || l).join(' / ');
    return `已按父级过滤：${parentRestriction.value.parent.name} 之下只能建 ${names}`;
  }
  if (parentId.value) {
    const p = proj.getEntity(parentId.value);
    return `${p ? p.layerLabel : '该层级'} 通常不再有子实体，层级暂不过滤`;
  }
  return '';
});

// 父级变化后若当前层级不再合法 → 自动切到第一个合法层级（避免提交出「世界下挂城市」这类脏数据）
watch(parentId, () => {
  if (!layerOptions.value.includes(layer.value)) layer.value = layerOptions.value[0];
});

const parentHint = computed(() => {
  if (!parentId.value) return '父级：顶层';
  const p = proj.getEntity(parentId.value);
  return p ? `父级：${p.name}（${p.layerLabel}）` : '父级：—';
});

// 分派计划表：层级 → 创建后的落位/绘制流程（与画布能力一一对应）
const DISPATCH = {
  world: ['直接创建；世界卡片在启动页展示。', '星域划分随后在星域图里添加。'],
  star_domain: ['直接创建。', '边界圆在星域图里拖动调整半径（半径会持久化）。'],
  galaxy: ['创建后在恒星系视图落点：进入所属星域 → 点「新增」放置恒星系。'],
  star: ['创建后在单恒星系视图落点（作为该系中心恒星）。'],
  planet: ['创建后在单恒星系视图落点：恒星居中，行星按轨道半径摆放。'],
  moon: ['创建后在所属行星附近落点。'],
  region: ['创建后进入行星表面，用自由绘制工具画区域边界。',
    '绘制方式：按住拖动勾轮廓 → RDP 简化去毛刺 → 离屏 Canvas 校验「落在陆地内 + 不与已有区域重叠」。'],
  city: ['创建后在行星表面点选落位（自动吸附到陆地）。', '下钻城市后可继续画区域多边形、放建筑入口。'],
  town: ['创建后在行星表面点选落位（自动吸附到陆地）。'],
  village: ['创建后在行星表面点选落位（自动吸附到陆地）。'],
  facility: ['创建后在行星表面或区域地图点选落位。'],
  location: ['创建后在行星表面或区域地图点选落位。'],
  building: ['创建后在所属区域地图里点选落位（也可直接用区域地图的「建筑」工具）。',
    '进入内部：选中建筑 → 「建筑内部」，可加楼层、放家具（房间模板一键铺整间）。'],
};

const dispatchSteps = computed(() => DISPATCH[layer.value] || ['落位方式待定：建议改选具体层级。']);

function reset() {
  name.value = '';
  tagsText.value = '';
  coordX.value = '';
  coordY.value = '';
  result.value = null;
  created.value = null;
  nextTick(() => nameInput.value?.focus());
}

/** 结果卡片上的「前往编辑」：把新实体交回面板（选中）+ 请求画布切到该实体所在的视图 */
function gotoEdit() {
  if (!created.value) return;
  emit('goto', created.value.entity);
}

function create() {
  const n = name.value.trim();
  if (!n) return;
  const numOrNull = (v) => {
    const t = String(v ?? '').trim();
    if (!t) return null;
    const num = Number(t);
    return Number.isFinite(num) ? num : null;
  };
  const steps = dispatchSteps.value.slice();      // 冻结在创建成功的那一刻（改层级不影响卡片）
  const res = proj.createEntity({
    name: n,
    layer: layer.value,
    parentId: parentId.value || null,
    tags: tagsText.value.split(/[,,、]/).map(t => t.trim()).filter(Boolean),
    coordinate: { x: numOrNull(coordX.value), y: numOrNull(coordY.value) },
  });
  if (res.success) {
    result.value = null;
    created.value = { entity: res.entity, steps };
  } else {
    created.value = null;
    result.value = { ok: false, text: `创建失败：${res.error}` };
  }
}

// 打开时自动聚焦名称输入
watch(() => props.open, (v) => { if (v) nextTick(() => nameInput.value?.focus()); });
</script>

<style scoped>
.ec-overlay {
  position: fixed;
  inset: 0;
  background: rgba(6, 10, 18, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1200;
}
.ec-card {
  width: 420px;
  max-height: calc(100% - 80px);
  display: flex;
  flex-direction: column;
  background: var(--planet-editor-bg, #111a26);
  border: 1px solid var(--planet-editor-border, #24384f);
  border-radius: 6px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}
.ec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 12px;
  border-bottom: 1px solid var(--planet-editor-border, #24384f);
}
.ec-title {
  color: var(--planet-text, #d8e2ef);
  font-size: 13px;
  font-weight: 600;
}
.ec-x {
  background: none;
  border: none;
  color: var(--planet-text-secondary, #8fa3bb);
  font-size: 16px;
  cursor: pointer;
  line-height: 1;
}
.ec-x:hover { color: var(--planet-text, #d8e2ef); }
.ec-body {
  padding: 12px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.ec-field {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ec-field > label {
  width: 34px;
  flex-shrink: 0;
  color: var(--planet-text-secondary, #8fa3bb);
  font-size: 11.5px;
}
.ec-input {
  flex: 1;
  min-width: 0;
  padding: 4px 7px;
  font-size: 12px;
  color: var(--planet-text, #d8e2ef);
  background: var(--planet-btn-bg, #16222f);
  border: 1px solid var(--planet-btn-border, #2b4059);
  border-radius: var(--radius-sm, 4px);
}
.ec-input:focus { outline: none; border-color: var(--planet-text-link, #4a90d9); }
.ec-input.small { flex: 1; }
.ec-coord { flex: 1; display: flex; gap: 6px; }
.ec-id {
  flex-shrink: 0;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--planet-text-secondary, #8fa3bb);
  font-size: 10.5px;
  font-family: ui-monospace, Consolas, monospace;
}
.ec-dispatch {
  border: 1px dashed var(--planet-btn-border, #2b4059);
  border-radius: var(--radius-sm, 4px);
  padding: 7px 9px;
  background: rgba(74, 144, 217, 0.06);
}
.ec-dispatch-title {
  color: var(--planet-text, #d8e2ef);
  font-size: 11.5px;
  font-weight: 600;
  margin-bottom: 3px;
}
.ec-dispatch ol {
  margin: 0;
  padding-left: 18px;
  color: var(--planet-text-secondary, #8fa3bb);
  font-size: 11.5px;
  line-height: 1.55;
}
.ec-note {
  margin-top: 5px;
  color: var(--planet-text-secondary, #8fa3bb);
  font-size: 10.5px;
  opacity: 0.85;
}
.ec-hint {
  margin-top: -4px;
  color: var(--planet-text-secondary, #8fa3bb);
  font-size: 10.5px;
  padding-left: 42px;
  opacity: 0.9;
}
.ec-card-done {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ec-card-actions {
  display: flex;
  gap: 7px;
  justify-content: flex-end;
}
.ec-result {
  font-size: 11.5px;
  padding: 5px 8px;
  border-radius: var(--radius-sm, 4px);
  border: 1px solid var(--planet-btn-border, #2b4059);
}
.ec-result.ok { color: #1b6b3a; border-color: #2e6b48; background: rgba(46, 204, 113, 0.10); }
.ec-result.err { color: #b3261e; border-color: #8f4a3a; background: rgba(231, 76, 60, 0.10); }
.ec-foot {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 12px;
  border-top: 1px solid var(--planet-editor-border, #24384f);
}
.ec-parent-hint {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--planet-text-secondary, #8fa3bb);
  font-size: 11px;
}
.ec-btn {
  padding: 4px 10px;
  font-size: 12px;
  color: var(--planet-text, #d8e2ef);
  background: var(--planet-btn-bg, #16222f);
  border: 1px solid var(--planet-btn-border, #2b4059);
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
}
.ec-btn:hover:not(:disabled) { background: var(--planet-btn-hover, #1e3044); }
.ec-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.ec-btn.primary:not(:disabled) { color: #1c4fa1; border-color: #3a6b8f; }
/* ===== 批量模式（B7，2026-09-24）===== */
.ec-mode {
  display: flex;
  gap: 4px;
  margin-left: auto;
  margin-right: 10px;
}
.ec-mode-btn {
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid var(--panel-border);
  background: var(--btn-bg);
  color: var(--text-secondary);
  border-radius: 6px;
}
.ec-mode-btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
/* 批量名称输入：多行 + 可纵向拉伸 */
.ec-textarea {
  resize: vertical;
  min-height: 96px;
  font-family: inherit;
  line-height: 1.5;
}
</style>
