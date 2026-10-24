<template>
  <!-- 资料段（读料桥）——**唯一实现**：省份面板与标记面板都用这一个组件，不复制第二份。
       只做两件事：`vaultIndexSearch`（主进程只读索引、元数据命中，不读正文）+ `openNote`（阅读器）。
       🔴 不猜、不自动建：没命中就明说「库里没有同名词条」——「认不出就进待人工」同一条纪律。 -->
  <div class="props-vault" :data-testid="testid">
    <div class="props-vault-head">
      <span>资料</span>
      <span class="pv-actions">
        <button
          type="button"
          class="props-mini"
          :data-testid="testid + '-search'"
          :disabled="!q"
          :title="q ? `重新按「${q}」在库里检索（只读）` : '先给它起个名字'"
          @click="search(true)"
        >重查</button>
        <button
          type="button"
          class="props-mini"
          :data-testid="testid + '-global'"
          :disabled="!q"
          :title="q ? `在「全库资料搜索」里搜「${q}」（可搜正文；仍只读）` : '先给它起个名字'"
          @click="openGlobalSearch"
        >全库搜索</button>
      </span>
    </div>
    <div v-if="!q" class="props-vault-dim" :data-testid="testid + '-noname'">
      还没有名字 —— 起个名字后自动按名字查资料（只读检索）
    </div>
    <div v-else-if="busy" class="props-vault-dim">查找中…</div>
    <template v-else>
      <div v-if="hits.length" class="props-vault-list">
        <a
          v-for="h in hits"
          :key="h.path"
          class="props-vault-row"
          :title="h.path"
          :data-testid="testid + '-hit'"
          @click="openNote(h.path)"
        >
          <span class="pv-title">{{ h.title }}</span>
          <span class="pv-path">{{ h.path }}</span>
        </a>
      </div>
      <div v-else class="props-vault-dim" :data-testid="testid + '-empty'">
        库里没有同名词条「{{ q }}」（只读检索；不会替你新建）
      </div>
    </template>
  </div>
</template>

<script setup>
// components/VaultLoreSection.vue — 「按名字找库内资料」的只读候选段（2026-10-24）
//
// 为什么抽成组件：这份能力有两个使用点（省份属性区 / 标记面板）。两份实现不会报错，
// 只会"改一处另两处不变"——本仓的红线「同一能力只许一份实现」。
//
// 判据（test_143 / test_144）：
//   · 检索关键词**就是**使用点的名字（省名 / 标记名）；
//   · 连点 / 就地改名有**序号防乱序**（先到的不许盖后到的）；
//   · 整段**没有任何写口**：不建笔记、不改配置、不碰项目文件。
//   · 名字还没起 / 库没命中都要有**可读文字**，不能"什么都不显示"。
import { ref, computed, watch, onUnmounted } from 'vue';
import { openNote, openNoteSearch } from '../utils/noteReader';

const props = defineProps({
  /** 检索关键词（省名 / 标记名）。空串或全空白 = 还没名字 */
  query: { type: String, default: '' },
  /** 根节点的 data-testid，同时作为子元素 testid 的前缀（如 `province-vault` → `province-vault-hit`） */
  testid: { type: String, required: true },
  /** 最多取几条候选（默认 5，与 test_143 的判据一致） */
  limit: { type: Number, default: 5 },
});

const hits = ref([]);
const busy = ref(false);
let seq = 0;

const q = computed(() => String(props.query || '').trim());

async function search(force = false) {
  const name = q.value;
  const my = ++seq;
  if (!name) { hits.value = []; busy.value = false; return; }
  // 没有命中时显示「查找中…」；已有候选时不闪（重查只是刷新列表）
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

// 换了名字（切省 / 就地改名 / 换标记）→ 重新查。只读检索很轻，不必防抖。
watch(q, () => { search(); }, { immediate: true });

function openGlobalSearch() {
  if (!q.value) return;
  openNoteSearch(q.value);                          // 带名字预填，面板自己会搜
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
.props-vault-row {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 3px 5px;
  border-radius: 3px;
  cursor: pointer;
  background: rgba(148, 163, 184, 0.06);
}
.props-vault-row:hover { background: rgba(148, 163, 184, 0.16); }
.props-vault-row .pv-title { font-size: 12px; color: #cbd5e1; }
.props-vault-row .pv-path {
  font-size: 10px;
  color: #64748b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
</style>
