<template>
  <div v-if="visible" class="note-reader-overlay" data-testid="note-reader" @click.self="close">
    <div class="note-reader">
      <header class="nr-head">
        <button v-if="stack.length" class="nr-btn" data-testid="nr-back" @click="back" title="返回上一篇">← 返回</button>
        <div class="nr-title">
          <h2>{{ noteTitle }}</h2>
          <span class="nr-path">{{ currentPath }}</span>
        </div>
        <div class="nr-actions">
          <button class="nr-btn" data-testid="nr-open-obsidian" @click="openInObsidian" title="在 Obsidian 中打开">在 Obsidian 中打开</button>
          <button class="nr-btn close" data-testid="nr-close" @click="close" title="关闭">×</button>
        </div>
      </header>
      <div v-if="altCount" class="nr-alt">同名/别名候选 {{ altCount }} 篇；当前打开第一篇</div>
      <div v-if="loading" class="nr-loading">读取中…</div>
      <div v-else-if="error" class="nr-error">{{ error }}</div>
      <div v-else ref="bodyEl" class="nr-body markdown-body" v-html="rendered" @click="onContentClick"></div>
    </div>
  </div>
</template>

<script setup>
// NoteReader.vue — 应用内资料阅读器（D2）
//
// 目标（S0 实测的“大号 Obsidian 启动器”）：任意 .md 在司天里读；[[双链]] 应用内跳；
// ![[图]] 能显示；有返回栈。数据只走 `vaultIndexStore`（主进程只读 + 库根 containment），
// 不 import geodata / projectStore，也不写任何笔记。
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue';
import { marked } from 'marked';
import { useVaultIndexStore } from '../store/vaultIndex';
import { OPEN_NOTE_EVENT } from '../utils/noteReader';
import { openObsidianUri } from '../utils/vault';

marked.setOptions({ gfm: true, breaks: true });

const store = useVaultIndexStore();
const visible = ref(false);
const loading = ref(false);
const error = ref('');
const note = ref(null);
const stack = ref([]);          // 返回栈：只存 path
const altCount = ref(0);        // 同名/别名候选数
const bodyEl = ref(null);

const currentPath = computed(() => (note.value && note.value.path) || '');
const noteTitle = computed(() => {
  const n = note.value;
  if (!n) return '';
  const h = String(n.content || '').match(/^#\s+(.+)$/m);
  return h ? h[1].trim() : String(n.path || '').split('/').pop().replace(/\.md$/i, '');
});

function escAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Obsidian 语法 → 可渲染 HTML：先附件，再双链（顺序不能反，否则 ![[x]] 被双链吃掉） */
function preprocess(content) {
  let s = String(content || '');
  s = s.replace(/!\[\[([^\]]+)\]\]/g, (_, name) => `<span class="note-asset" data-asset="${escAttr(name)}"></span>`);
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => {
    const t = String(target).trim();
    const text = String(label || t).trim();
    return `<a href="#" class="note-wikilink" data-target="${escAttr(t)}">${escAttr(text)}</a>`;
  });
  return s;
}

const rendered = computed(() => (note.value ? marked.parse(preprocess(note.value.content)) : ''));

async function hydrateAssets() {
  const root = bodyEl.value;
  if (!root || !note.value) return;
  // 1) ![[图.png]] → 待替换的 span
  for (const el of [...root.querySelectorAll('.note-asset')]) {
    const name = el.getAttribute('data-asset') || '';
    const asset = await store.readAsset(name, note.value.path);
    if (asset && asset.dataUrl) {
      const img = document.createElement('img');
      img.src = asset.dataUrl;
      img.alt = name;
      img.loading = 'lazy';
      el.replaceWith(img);
    } else {
      el.textContent = `[附件未找到：${name}]`;
    }
  }
  // 2) 标准 Markdown 图片/相对路径 → dataUrl（只处理相对路径，http/data 原样）
  for (const img of [...root.querySelectorAll('img')]) {
    const src = img.getAttribute('src') || '';
    if (!src || /^(https?:|data:)/i.test(src)) continue;
    const asset = await store.readAsset(src, note.value.path);
    if (asset && asset.dataUrl) img.src = asset.dataUrl;
  }
}

async function load(path, push = true) {
  if (!path) return;
  if (push && currentPath.value && currentPath.value !== path) stack.value.push(currentPath.value);
  loading.value = true;
  error.value = '';
  altCount.value = 0;
  visible.value = true;
  const n = await store.readNote(path);
  loading.value = false;
  if (!n) {
    error.value = store.error || `读取失败：${path}`;
    return;
  }
  note.value = n;
  await nextTick();
  await hydrateAssets();
}

async function openTarget(name) {
  const res = await store.resolveNote(name);
  if (!res.path) {
    error.value = `找不到笔记：${name}`;
    return;
  }
  altCount.value = res.candidates.length > 1 ? res.candidates.length : 0;
  await load(res.path, true);
}

function back() {
  const prev = stack.value.pop();
  if (prev) load(prev, false);
}

function close() {
  visible.value = false;
  note.value = null;
  error.value = '';
  stack.value = [];
  altCount.value = 0;
}

function onContentClick(e) {
  const a = e.target && e.target.closest ? e.target.closest('.note-wikilink') : null;
  if (!a) return;
  e.preventDefault();
  openTarget(a.getAttribute('data-target') || '');
}

async function openInObsidian() {
  if (currentPath.value) await openObsidianUri(currentPath.value);
}

function onOpenEvent(e) {
  const path = e && e.detail && e.detail.path;
  if (path) {
    stack.value = [];
    load(path, false);
  }
}

onMounted(() => window.addEventListener(OPEN_NOTE_EVENT, onOpenEvent));
onUnmounted(() => window.removeEventListener(OPEN_NOTE_EVENT, onOpenEvent));

defineExpose({ open: (p) => load(p, false), close, openTarget });
</script>

<style scoped>
.note-reader-overlay {
  position: fixed;
  inset: 0;
  background: rgba(6, 10, 16, 0.62);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1200;
  backdrop-filter: blur(3px);
}
.note-reader {
  width: min(920px, 92vw);
  height: min(760px, 86vh);
  display: flex;
  flex-direction: column;
  background: var(--panel-bg, #161d27);
  border: 1px solid var(--panel-border, #2a3545);
  border-radius: 12px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}
.nr-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--panel-border, #2a3545);
}
.nr-title { flex: 1; min-width: 0; }
.nr-title h2 { margin: 0; font-size: 17px; color: var(--text-primary, #e8edf5); }
.nr-path {
  display: block;
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-tertiary, #8a94a6);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nr-actions { display: flex; gap: 8px; align-items: center; }
.nr-btn {
  padding: 5px 10px;
  font-size: 12px;
  color: var(--text-secondary, #c3ccda);
  background: var(--btn-bg, #202a38);
  border: 1px solid var(--panel-border, #2a3545);
  border-radius: 6px;
  cursor: pointer;
}
.nr-btn:hover { border-color: #4a90d9; }
.nr-btn.close { font-size: 16px; line-height: 1; padding: 3px 9px; }
.nr-alt {
  padding: 6px 16px;
  font-size: 12px;
  color: #d4a857;
  border-bottom: 1px solid var(--panel-border, #2a3545);
}
.nr-loading, .nr-error { padding: 24px; font-size: 13px; color: var(--text-secondary, #c3ccda); }
.nr-error { color: #e06c75; }
.nr-body {
  flex: 1;
  overflow: auto;
  padding: 18px 24px 40px;
  color: var(--text-primary, #e8edf5);
  font-size: 14px;
  line-height: 1.75;
}
.nr-body :deep(h1), .nr-body :deep(h2), .nr-body :deep(h3) { color: #fff; margin: 1.1em 0 0.5em; }
.nr-body :deep(a.note-wikilink) { color: #6cb6ff; text-decoration: none; border-bottom: 1px dashed #6cb6ff66; }
.nr-body :deep(a.note-wikilink:hover) { border-bottom-style: solid; }
.nr-body :deep(img) { max-width: 100%; border-radius: 6px; display: block; margin: 10px 0; }
.nr-body :deep(table) { border-collapse: collapse; margin: 12px 0; }
.nr-body :deep(th), .nr-body :deep(td) { border: 1px solid #2a3545; padding: 5px 9px; }
.nr-body :deep(blockquote) { margin: 12px 0; padding-left: 12px; border-left: 3px solid #3b4a5f; color: #a9b4c4; }
.nr-body :deep(code) { background: #0f151d; padding: 1px 5px; border-radius: 4px; }
</style>
