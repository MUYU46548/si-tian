<template>
  <div v-if="visible" class="note-picker-overlay" data-testid="note-picker" @click.self="$emit('close')">
    <div class="note-picker">
      <header class="np-head">
        <h2>{{ title || '选择要绑定的笔记' }}</h2>
        <button class="np-close" @click="$emit('close')" title="关闭">×</button>
      </header>
      <div class="np-bar">
        <input
          ref="inputEl"
          v-model="query"
          class="np-input"
          placeholder="搜标题 / 标签 / 正文"
          @keydown.enter.prevent="doSearch"
        />
        <button class="np-btn" :disabled="busy || !query.trim()" @click="doSearch">{{ busy ? '搜索中…' : '搜索' }}</button>
      </div>
      <div v-if="error" class="np-error">{{ error }}</div>
      <div class="np-results">
        <p v-if="!busy && searched && !rows.length" class="np-empty">没有命中。</p>
        <button
          v-for="r in rows"
          :key="r.path"
          class="np-row"
          :class="{ disabled: isExcluded(r.path) }"
          :disabled="isExcluded(r.path)"
          @click="pick(r)"
        >
          <span class="np-title">{{ r.title }}</span>
          <span class="np-path">{{ r.path }}</span>
          <span v-if="isExcluded(r.path)" class="np-badge">已绑定</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
// NotePicker.vue — 给节点/标记绑定「附加笔记」的搜索选择器（D2）
// 只负责选路径；写项目/撤销由调用方（NodeDetailPanel → store.updateNode）负责。
import { ref, watch, nextTick } from 'vue';
import { useVaultIndexStore } from '../store/vaultIndex';

const props = defineProps({
  visible: { type: Boolean, default: false },
  title: { type: String, default: '' },
  excludePaths: { type: Array, default: () => [] },
});
const emit = defineEmits(['pick', 'close']);

const store = useVaultIndexStore();
const query = ref('');
const busy = ref(false);
const searched = ref(false);
const rows = ref([]);
const error = ref('');
const inputEl = ref(null);

function isExcluded(p) { return (props.excludePaths || []).includes(p); }

async function doSearch() {
  const q = query.value.trim();
  if (!q) return;
  busy.value = true;
  error.value = '';
  rows.value = (await store.searchDeep(q, 30)) || [];
  busy.value = false;
  searched.value = true;
  if (store.error) error.value = store.error;
}

function pick(row) {
  if (!row || isExcluded(row.path)) return;
  emit('pick', row.path);
  emit('close');
}

watch(() => props.visible, async (v) => {
  if (!v) return;
  query.value = '';
  rows.value = [];
  searched.value = false;
  error.value = '';
  await nextTick();
  if (inputEl.value) inputEl.value.focus();
});

defineExpose({ search: doSearch });
</script>

<style scoped>
.note-picker-overlay {
  position: fixed;
  inset: 0;
  background: rgba(6, 10, 16, 0.6);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
  z-index: 1300;
}
.note-picker {
  width: min(680px, 92vw);
  max-height: 66vh;
  display: flex;
  flex-direction: column;
  background: var(--panel-bg, #161d27);
  border: 1px solid var(--panel-border, #2a3545);
  border-radius: 12px;
  overflow: hidden;
}
.np-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px 8px; }
.np-head h2 { margin: 0; font-size: 15px; color: var(--text-primary, #e8edf5); }
.np-close { background: none; border: none; color: #8a94a6; font-size: 18px; cursor: pointer; }
.np-bar { display: flex; gap: 8px; padding: 0 16px 10px; }
.np-input {
  flex: 1;
  padding: 8px 10px;
  font-size: 13px;
  color: var(--text-primary, #e8edf5);
  background: var(--input-bg, #0f151d);
  border: 1px solid var(--input-border, #2a3545);
  border-radius: 6px;
}
.np-btn { padding: 8px 14px; font-size: 13px; color: #0b1220; background: #6cb6ff; border: none; border-radius: 6px; cursor: pointer; }
.np-btn:disabled { opacity: 0.45; }
.np-error { padding: 0 16px 8px; color: #e06c75; font-size: 12px; }
.np-results { overflow: auto; padding: 0 10px 12px; }
.np-empty { padding: 16px 8px; color: var(--text-tertiary, #8a94a6); font-size: 13px; }
.np-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  width: 100%;
  padding: 8px;
  background: none;
  border: none;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  text-align: left;
  cursor: pointer;
}
.np-row:hover { background: rgba(108, 182, 255, 0.08); }
.np-row.disabled { opacity: 0.45; cursor: default; }
.np-title { flex: 0 0 auto; max-width: 40%; font-size: 13px; color: var(--text-primary, #e8edf5); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.np-path { flex: 1; min-width: 0; font-size: 11px; color: var(--text-tertiary, #8a94a6); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.np-badge { font-size: 11px; color: #d4a857; }
</style>
