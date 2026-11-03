<template>
  <!-- 资料段（读料桥）——**唯一实现**：省份面板 / 标记面板 / 节点详情面板都用这一个组件，不复制第二份。
       只做三件事：`vaultIndexSearch`（主进程只读索引、元数据命中，不读正文）+ `openNote`（阅读器）
       + 给了 `nodeId` 时的**显式写操作**（绑定 / 导入，各走 store 的一条 undo 写口）。
       🔴 不猜、不自动建：没命中就明说“库里没有同名词条”——“认不出就进待人工”同一条纪律。 -->
  <div class="props-vault" :data-testid="testid">
    <div class="props-vault-head">
      <span>资料</span>
      <span class="pv-actions">
        <button
          type="button"
          class="props-mini"
          :data-testid="testid + '-search'"
          :disabled="!q"
          :title="q ? `重新按“${q}”在库里检索（只读）` : '先给它起个名字'"
          @click="search(true)"
        >重查</button>
        <button
          type="button"
          class="props-mini"
          :data-testid="testid + '-global'"
          :disabled="!q"
          :title="q ? `在“全库资料搜索”里搜“${q}”（可搜正文；仍只读）` : '先给它起个名字'"
          @click="openGlobalSearch"
        >全库搜索</button>
      </span>
    </div>

    <!-- 当前绑定（只在给了 nodeId 时出现；省份/标记面板完全看不到这一块 = 那边依旧纯只读） -->
    <div v-if="canBind" class="pv-bound" :data-testid="testid + '-bound'">
      <template v-if="bound">
        <span class="pv-bound-tag">已绑定</span>
        <a class="pv-bound-note" :title="bound.path" @click="openNote(bound.path)">{{ bound.title || bound.path }}</a>
        <button
          type="button"
          class="props-mini"
          :data-testid="testid + '-unbind'"
          :disabled="readOnly"
          :title="readOnly ? readOnlyReason : '解除这个节点与笔记的绑定（可撤销）'"
          @click="unbind"
        >解绑</button>
      </template>
      <span v-else class="pv-bound-none" :data-testid="testid + '-unbound'">
        未绑定笔记（点候选右侧“绑定”把库内笔记挂到这个节点）
      </span>
    </div>

    <div v-if="!q" class="props-vault-dim" :data-testid="testid + '-noname'">
      还没有名字 —— 起个名字后自动按名字查资料（只读检索）
    </div>
    <div v-else-if="busy" class="props-vault-dim">查找中…</div>
    <template v-else>
      <div v-if="hits.length" class="props-vault-list">
        <div v-for="h in hits" :key="h.path" class="props-vault-row" :title="h.path">
          <a
            class="pv-main"
            :title="h.path"
            :data-testid="testid + '-hit'"
            @click="openNote(h.path)"
          >
            <span class="pv-title">{{ h.title }}</span>
            <span class="pv-path">{{ h.path }}</span>
          </a>
          <!-- 写操作只在“有归属节点”时出现：没有节点就没有可绑的对象，按钮不该占位 -->
          <span v-if="canBind" class="pv-row-actions">
            <button
              type="button"
              class="props-mini"
              :class="{ 'pv-on': isBound(h) }"
              :data-testid="testid + '-bind'"
              :disabled="readOnly"
              :title="bindTitle(h)"
              @click.stop="bind(h)"
            >{{ isBound(h) ? '已绑定' : '绑定' }}</button>
            <button
              v-if="canImport(h)"
              type="button"
              class="props-mini"
              :data-testid="testid + '-import'"
              :disabled="readOnly"
              :title="importTitle(h)"
              @click.stop="importCandidate(h)"
            >导入为节点</button>
          </span>
        </div>
      </div>
      <div v-else class="props-vault-dim" :data-testid="testid + '-empty'">
        库里没有同名词条“{{ q }}”（只读检索；不会替你新建）
      </div>
    </template>

    <!-- 写操作的**回音**：拒绝（只读 / 已导入 / 节点不存在）必须有可读原因，不许静默 -->
    <p v-if="msg" class="pv-msg" :data-testid="testid + '-msg'">{{ msg }}</p>
  </div>
</template>

<script setup>
// components/VaultLoreSection.vue — “按名字找库内资料”+（可选）稳定绑定 / 候选导入（2026-10-24 / N3a-3）
//
// 为什么抽成组件：这份能力有三个使用点（省份属性区 / 标记面板 / 节点详情面板）。两份实现不会报错，
// 只会"改一处另两处不变"——本仓的红线“同一能力只许一份实现”。
//
// 判据（test_143 / test_144 守旧口径，本文件不许退化）：
//   · 检索关键词**就是**使用点的名字（省名 / 标记名 / 节点名）；
//   · 连点 / 就地改名有**序号防乱序**（先到的不许盖后到的）；
//   · 没有 `nodeId` 时整段**没有任何写口**：不建笔记、不改配置、不碰项目文件
//     （省份 / 标记面板就是这个形态 —— 那里连按钮都不渲染）；
//   · 名字还没起 / 库没命中都要有**可读文字**，不能"什么都不显示"。
//
// N3a-3 加的两件（只在传了 `nodeId` 时出现）：
//   · “绑定”→ `store.bindNodeToNote`（写 `node.lore`，一条 undo；重复绑同一篇不进撤销栈）；
//   · “导入为节点”→ `store.importVaultCandidate`（建草稿节点，一条 undo；已导入过会拒绝并说原因）。
//   两者都在只读态灰禁 + 给出原因（`store.readOnlyReason`），不做"点了才知道不行"的交互。
//   ⚠️ 归类（"这条命中是不是地图实体"）**不在组件里判**：读主进程索引给的 `kind` / `layerHint`，
//      唯一实现是 `scripts/lib/vaultClassify.js`。组件只读结论，绝不自己再猜一次。
import { ref, computed, watch, onUnmounted } from 'vue';
import { openNote, openNoteSearch } from '../utils/noteReader';
import { useGeodataStore } from '../store/geodata';
import { sameNoteRef } from '../utils/loreBinding';

const props = defineProps({
  /** 检索关键词（省名 / 标记名 / 节点名）。空串或全空白 = 还没名字 */
  query: { type: String, default: '' },
  /** 根节点的 data-testid，同时作为子元素 testid 的前缀（如 `province-vault` → `province-vault-hit`） */
  testid: { type: String, required: true },
  /** 最多取几条候选（默认 5，与 test_143 的判据一致） */
  limit: { type: Number, default: 5 },
  /** 归属节点 id。**给了才有绑定/导入能力**；不给 = 纯只读资料段（省份 / 标记面板） */
  nodeId: { type: String, default: '' },
});

const hits = ref([]);
const busy = ref(false);
const msg = ref('');
let seq = 0;

const q = computed(() => String(props.query || '').trim());
const canBind = computed(() => !!String(props.nodeId || '').trim());

// ===== 绑定态（只在有归属节点时读；null = 没绑）=====
const store = useGeodataStore();
const readOnly = computed(() => !!store.isReadOnly);
const readOnlyReason = computed(() => store.readOnlyReason || '只读：未打开项目文件');
const currentNode = computed(() => {
  if (!canBind.value) return null;
  const list = store.nodes || [];
  return list.find((n) => n && n.id === props.nodeId) || null;
});
const bound = computed(() => (currentNode.value && currentNode.value.lore) || null);

function isBound(hit) {
  return !!(bound.value && sameNoteRef(bound.value, hit));
}

function bindTitle(hit) {
  if (readOnly.value) return readOnlyReason.value;
  if (isBound(hit)) return '当前绑定的就是这篇（再点一次不会重复入栈）';
  return `把这个节点绑到“${hit.title || hit.path}”上（一条撤销；只存路径与身份，不改笔记）`;
}

function importTitle(hit) {
  if (readOnly.value) return readOnlyReason.value;
  return `按“${hit.title || hit.path}”建一个草稿节点挂到当前节点下（一条撤销；幂等，不会重复导入）`;
}

/**
 * 这条命中能不能“导入为节点”：**只认主进程的归类结论**。
 * `kind === 'map'` 是索引里的“地图实体”（`vaultClassify` 的 geo 类）；`lore`/`unknown` 不行 ——
 * 把人物/组织/事件导成地图节点正是读料桥要避免的那种"悄悄把资料当地方"。
 * `kind` 缺省（老索引 / 第三方调用）时才退回 `layerHint` 这一档。
 */
function canImport(hit) {
  if (!canBind.value || !hit) return false;
  if (hit.kind === 'map') return true;
  if (hit.kind == null || hit.kind === '') return !!hit.layerHint;
  return false;
}

async function search(force = false) {
  const name = q.value;
  const my = ++seq;
  msg.value = '';
  if (!name) { hits.value = []; busy.value = false; return; }
  // 没有命中时显示“查找中…”；已有候选时不闪（重查只是刷新列表）
  busy.value = !!force || hits.value.length === 0;
  try {
    const api = window.sitianAPI;
    const res = api && typeof api.vaultIndexSearch === 'function'
      ? await api.vaultIndexSearch(name, props.limit)
      : null;
    if (my !== seq) return;                        // 连点/改名：最后一次赢（先到的不许盖后到的）
    hits.value = (res && res.success && Array.isArray(res.results)) ? res.results : [];
  } catch (e) {
    if (my === seq) hits.value = [];
  } finally {
    if (my === seq) busy.value = false;
  }
}

// 换了名字（切省 / 就地改名 / 换标记 / 换节点）→ 重新查。只读检索很轻，不必防抖。
watch(q, () => { search(); }, { immediate: true });

function openGlobalSearch() {
  if (!q.value) return;
  openNoteSearch(q.value);                          // 带名字预填，面板自己会搜
}

// ===== 写操作（各一条 undo；全部经 store 的写口，组件不直接改数据）=====
function bind(hit) {
  if (!canBind.value) return;
  const res = store.bindNodeToNote(props.nodeId, hit);
  msg.value = res && res.ok
    ? (res.unchanged ? `“${hit.title || hit.path}”已经是当前绑定` : `已绑定“${hit.title || hit.path}”`)
    : ((res && res.error) || '绑定失败');
}

function unbind() {
  if (!canBind.value) return;
  const res = store.unbindNodeNote(props.nodeId);
  msg.value = res && res.ok ? '已解绑（可撤销）' : ((res && res.error) || '解绑失败');
}

function importCandidate(hit) {
  if (!canBind.value) return;
  const res = store.importVaultCandidate(hit, { parentId: props.nodeId });
  msg.value = res && res.ok
    ? `已导入为草稿节点“${res.node.name}”（虚线边框；确认后可在画布上编辑/转正）`
    : ((res && res.error) || '导入失败');
}

onUnmounted(() => { seq += 1; });                   // 卸载后回来的结果一律作废
</script>

<style scoped>
/* 归属：本组件自带样式 —— 父面板（ScenarioMap）的 scoped 样式只能命中子组件**根节点**，
   内部节点拿不到。这些规则与父面板里同名规则视觉一致（同一份设计，非两套口径）。 */
.props-vault {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #334155;
}
.props-vault-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 11px;
  color: #94a3b8;
  margin-bottom: 4px;
}
.pv-actions { display: flex; gap: 4px; }
.props-vault-dim {
  font-size: 11px;
  color: #64748b;
  line-height: 1.5;
}
.props-vault-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 132px;
  overflow: auto;
}
/* 行变成“左边标题/路径（可点开）+ 右边绑定/导入按钮”；标题与路径的排布与旧版一致 */
.props-vault-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 5px;
  border-radius: 3px;
  background: rgba(148, 163, 184, 0.06);
}
.props-vault-row:hover { background: rgba(148, 163, 184, 0.16); }
.pv-main {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1;
  min-width: 0;
  cursor: pointer;
}
.props-vault-row .pv-title { font-size: 12px; color: #cbd5e1; }
.props-vault-row .pv-path {
  font-size: 10px;
  color: #64748b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pv-row-actions { display: flex; gap: 2px; flex-shrink: 0; }
/* 绑定块（只在有 nodeId 时渲染） */
.pv-bound {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 4px;
  font-size: 11px;
  color: #94a3b8;
  min-width: 0;
}
.pv-bound-tag {
  flex-shrink: 0;
  padding: 0 4px;
  border-radius: 3px;
  color: #6ee7b7;
  background: rgba(16, 185, 129, 0.12);
}
.pv-bound-note {
  flex: 1;
  min-width: 0;
  color: #cbd5e1;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pv-bound-note:hover { text-decoration: underline; }
.pv-bound-none { color: #64748b; line-height: 1.5; }
.pv-msg {
  margin: 3px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: #fbbf24;
}
.props-mini {
  padding: 2px 8px;
  font-size: 11px;
  color: #e2e8f0;
  background: rgba(148, 163, 184, 0.12);
  border: 1px solid #475569;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}
.props-mini:not(:disabled):hover { background: rgba(148, 163, 184, 0.24); }
.props-mini:disabled { opacity: 0.45; cursor: not-allowed; }
.props-mini.pv-on { border-color: #10b981; color: #6ee7b7; }
</style>
