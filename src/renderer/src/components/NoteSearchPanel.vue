<template>
  <div v-if="visible" class="note-search-overlay" data-testid="note-search-panel" @click.self="close">
    <div class="note-search">
      <header class="ns-head">
        <h2>全库资料搜索</h2>
        <button class="ns-close" @click="close" title="关闭">×</button>
      </header>
      <div class="ns-bar">
        <input
          ref="inputEl"
          v-model="query"
          class="ns-input"
          placeholder="搜标题 / 标签 / 正文（人物、组织、事件都能搜）"
          @keydown.enter.prevent="doSearch"
        />
        <button class="ns-btn" :disabled="busy || !query.trim()" @click="doSearch">{{ busy ? '搜索中…' : '搜索' }}</button>
      </div>
      <div v-if="error" class="ns-error">{{ error }}</div>
      <div class="ns-results">
        <p v-if="!busy && searched && !results.length" class="ns-empty">没有命中。试试更短的关键词。</p>
        <button
          v-for="r in results"
          :key="r.path + r.matchedIn"
          class="ns-row"
          :data-testid="'ns-row'"
          @click="pick(r)"
        >
          <span class="ns-kind">{{ r.matchedIn === 'content' ? '正文' : (r.layerHint || r.kind || '资料') }}</span>
          <span class="ns-title">{{ r.title }}</span>
          <span class="ns-path">{{ r.path }}</span>
          <span v-if="r.snippet" class="ns-snippet">{{ r.snippet }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
// NoteSearchPanel.vue — 全库资料搜索（D2）
// 与地图搜索的分工：这里搜**所有 .md**（标题/标签/正文），结果直接进阅读器；
// 不改变地图选中、不碰画布。
import { ref, nextTick, onMounted, onUnmounted } from 'vue';
import { useVaultIndexStore } from '../store/vaultIndex';
import { OPEN_NOTE_SEARCH_EVENT, openNote } from '../utils/noteReader';

const store = useVaultIndexStore();
const visible = ref(false);
const query = ref('');
const busy = ref(false);
const searched = ref(false);
const results = ref([]);
const error = ref('');
const inputEl = ref(null);

async function doSearch() {
  const q = query.value.trim();
  if (!q) return;
  busy.value = true;
  error.value = '';
  const rows = await store.searchDeep(q, 40);
  busy.value = false;
  searched.value = true;
  results.value = rows || [];
  if (store.error) error.value = store.error;
}

function pick(row) {
  if (!row || !row.path) return;
  openNote(row.path);
  close();
}

async function open(initialQuery = '') {
  visible.value = true;
  if (initialQuery) query.value = String(initialQuery);
  await nextTick();
  if (inputEl.value && inputEl.value.focus) inputEl.value.focus();
  // 带词打开 = 直接把结果搜出来（读料桥：设定卡读不到笔记时"全库搜这个名字"一步到位）
  if (initialQuery && query.value.trim()) await doSearch();
}

function close() {
  visible.value = false;
  query.value = '';
  results.value = [];
  searched.value = false;
  error.value = '';
}

function onOpenEvent(e) { open((e && e.detail && e.detail.query) || ''); }

onMounted(() => window.addEventListener(OPEN_NOTE_SEARCH_EVENT, onOpenEvent));
onUnmounted(() => window.removeEventListener(OPEN_NOTE_SEARCH_EVENT, onOpenEvent));

defineExpose({ open, close });
</script>

<style scoped>
.note-search-overlay {
  position: fixed;
  inset: 0;
  background: rgba(6, 10, 16, 0.62);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 10vh;
  z-index: 1250;
  backdrop-filter: blur(3px);
}
.note-search {
  width: min(760px, 92vw);
  max-height: 72vh;
  display: flex;
  flex-direction: column;
  background: var(--panel-bg, #161d27);
  border: 1px solid var(--panel-border, #2a3545);
  border-radius: 12px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}
.ns-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px 8px; }
.ns-head h2 { margin: 0; font-size: 15px; color: var(--text-primary, #e8edf5); }
.ns-close { background: none; border: none; color: #8a94a6; font-size: 18px; cursor: pointer; }
.ns-bar { display: flex; gap: 8px; padding: 0 16px 10px; }
.ns-input {
  flex: 1;
  padding: 8px 10px;
  font-size: 13px;
  color: var(--text-primary, #e8edf5);
  background: var(--input-bg, #0f151d);
  border: 1px solid var(--input-border, #2a3545);
  border-radius: 6px;
}
.ns-btn {
  padding: 8px 14px;
  font-size: 13px;
  color: #0b1220;
  background: #6cb6ff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.ns-btn:disabled { opacity: 0.45; cursor: default; }
.ns-error { padding: 0 16px 8px; color: #e06c75; font-size: 12px; }
.ns-results { overflow: auto; padding: 0 10px 12px; }
.ns-empty { padding: 18px 8px; color: var(--text-tertiary, #8a94a6); font-size: 13px; }
.ns-row {
  display: grid;
  grid-template-columns: 48px 1fr auto;
  gap: 6px 10px;
  width: 100%;
  padding: 8px 8px;
  text-align: left;
  background: none;
  border: none;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  cursor: pointer;
}
.ns-row:hover { background: rgba(108, 182, 255, 0.08); }
.ns-kind { font-size: 11px; color: #8a94a6; }
.ns-title { font-size: 13px; color: var(--text-primary, #e8edf5); }
.ns-path {
  font-size: 11px;
  color: var(--text-tertiary, #8a94a6);
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ns-snippet { grid-column: 1 / -1; font-size: 12px; color: #a9b4c4; }
</style>
