<template>
  <div v-if="node" class="detail-panel">
    <div class="panel-header">
      <h3>{{ node.name }}</h3>
      <button class="close-btn" @click="store.clearSelection()">×</button>
    </div>

    <div class="panel-content">
      <!-- 基本信息 -->
      <section class="info-section">
        <div class="info-row">
          <span class="label">层级</span>
          <span class="value">{{ node.layerLabel || node.layer }}</span>
        </div>
        <div class="info-row" v-if="node.parentId">
          <span class="label">上级</span>
          <span class="value">{{ getParentName(node.parentId) }}</span>
        </div>
        <div class="info-row" v-if="node.tags?.length">
          <span class="label">标签</span>
          <div class="tags">
            <span v-for="tag in node.tags" :key="tag" class="tag">{{ tag }}</span>
          </div>
        </div>
      </section>

      <!-- 坐标 -->
      <section class="info-section">
        <div class="section-title">坐标</div>
        <div class="info-row">
          <span class="label">X</span>
          <span class="value">{{ Math.round(node.coordinate?.x || 0) }}</span>
        </div>
        <div class="info-row">
          <span class="label">Y</span>
          <span class="value">{{ Math.round(node.coordinate?.y || 0) }}</span>
        </div>
      </section>

      <!-- Obsidian 内容 -->
      <section class="info-section" v-if="note">
        <div class="section-title">Obsidian 内容</div>
        
        <!-- Frontmatter -->
        <div v-if="note.frontmatter && Object.keys(note.frontmatter).length" class="frontmatter">
          <div v-for="(val, key) in note.frontmatter" :key="key" class="fm-row">
            <span class="fm-key">{{ key }}:</span>
            <span class="fm-val">{{ formatFmValue(val) }}</span>
          </div>
        </div>

        <!-- 正文摘要 -->
        <div v-if="note.content" class="content-preview">
          {{ note.content.slice(0, 200) }}{{ note.content.length > 200 ? '...' : '' }}
        </div>

        <!-- Wikilinks -->
        <div v-if="note.wikilinks?.length" class="wikilinks">
          <div class="wl-title">关联链接</div>
          <a 
            v-for="link in note.wikilinks" 
            :key="link" 
            class="wl-link"
            @click="openInObsidian(link)"
          >{{ link }}</a>
        </div>
      </section>

      <!-- 关联航道 -->
      <section class="info-section" v-if="relatedHyperlanes.length">
        <div class="section-title">关联航道 ({{ relatedHyperlanes.length }})</div>
        <div v-for="h in relatedHyperlanes" :key="h.id" class="hyperlane-item">
          <span class="hl-type" :class="h.type">{{ h.type }}</span>
          <span class="hl-target">{{ getNodeName(h.fromId === node.id ? h.toId : h.fromId) }}</span>
        </div>
      </section>

      <!-- 操作按钮 -->
      <section class="actions">
        <button class="action-btn primary" @click="openSourceInObsidian">
          在 Obsidian 中打开
        </button>
        <button class="action-btn" @click="revealInExplorer">
          在文件夹中显示
        </button>
      </section>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { useGeodataStore } from '../store/geodata';

const store = useGeodataStore();
const note = ref(null);
const loading = ref(false);

const node = computed(() => store.selectedNode);

// 关联航道
const relatedHyperlanes = computed(() => {
  if (!node.value) return [];
  return store.getHyperlanesForNode(node.value.id);
});

function getParentName(parentId) {
  const parent = store.nodes.find(n => n.id === parentId);
  return parent?.name || parentId;
}

function getNodeName(nodeId) {
  const n = store.nodes.find(x => x.id === nodeId);
  return n?.name || nodeId;
}

function formatFmValue(val) {
  if (Array.isArray(val)) return val.join(', ');
  return String(val);
}

// 加载 Obsidian 内容
async function loadNote() {
  if (!node.value?.sourcePath) {
    note.value = null;
    return;
  }
  
  loading.value = true;
  try {
    const result = await window.sitianAPI.readObsidianNote(node.value.sourcePath);
    if (result.success) {
      note.value = result.data;
    } else {
      note.value = null;
    }
  } catch (e) {
    console.error('Failed to load note:', e);
    note.value = null;
  } finally {
    loading.value = false;
  }
}

watch(node, loadNote, { immediate: true });

// 操作
function openSourceInObsidian() {
  if (!node.value?.sourcePath) return;
  const url = `obsidian://open?vault=${encodeURIComponent('ROSA')}&file=${encodeURIComponent(node.value.sourcePath)}`;
  window.sitianAPI.openExternal(url);
}

function openInObsidian(linkName) {
  const url = `obsidian://open?vault=${encodeURIComponent('ROSA')}&file=${encodeURIComponent(linkName)}`;
  window.sitianAPI.openExternal(url);
}

async function revealInExplorer() {
  if (!node.value?.sourcePath) return;
  const vaultPath = 'E:/图书馆/ROSA';
  const fullPath = `${vaultPath}/${node.value.sourcePath}`;
  await window.sitianAPI.revealInExplorer(fullPath);
}
</script>

<style scoped>
.detail-panel {
  position: fixed;
  right: 0;
  top: 0;
  width: 320px;
  height: 100vh;
  background: #161b22;
  border-left: 1px solid #30363d;
  display: flex;
  flex-direction: column;
  z-index: 100;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid #30363d;
}

.panel-header h3 {
  font-size: 14px;
  color: #f0f6fc;
  margin: 0;
}

.close-btn {
  background: none;
  border: none;
  color: #8b949e;
  font-size: 18px;
  cursor: pointer;
  padding: 4px 8px;
}

.close-btn:hover {
  color: #f0f6fc;
}

.panel-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
}

.info-section {
  margin-bottom: 16px;
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
}

.info-row {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
  font-size: 12px;
}

.label {
  color: #8b949e;
  min-width: 50px;
}

.value {
  color: #e2e8f0;
  flex: 1;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.tag {
  background: #388bfd22;
  color: #58a6ff;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 11px;
}

.frontmatter {
  background: #0d1117;
  padding: 8px;
  border-radius: 4px;
  margin-bottom: 8px;
}

.fm-row {
  display: flex;
  gap: 6px;
  font-size: 11px;
  margin-bottom: 2px;
}

.fm-key {
  color: #8b949e;
}

.fm-val {
  color: #e2e8f0;
}

.content-preview {
  font-size: 12px;
  color: #8b949e;
  line-height: 1.5;
  background: #0d1117;
  padding: 8px;
  border-radius: 4px;
  max-height: 120px;
  overflow: hidden;
}

.wikilinks {
  margin-top: 8px;
}

.wl-title {
  font-size: 11px;
  color: #8b949e;
  margin-bottom: 4px;
}

.wl-link {
  display: block;
  color: #58a6ff;
  cursor: pointer;
  font-size: 12px;
  padding: 2px 0;
}

.wl-link:hover {
  text-decoration: underline;
}

.hyperlane-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
}

.hl-type {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  background: #30363d;
  color: #8b949e;
}

.hl-type.local { background: #0d4718; color: #7affb4; }
.hl-type.cross_domain { background: #3d1f7a; color: #d2a8ff; }
.hl-type.hyperjump { background: #7a1f1f; color: #ff7b72; }

.actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid #30363d;
}

.action-btn {
  padding: 8px 12px;
  border: 1px solid #30363d;
  border-radius: 4px;
  background: #21262d;
  color: #c9d1d9;
  cursor: pointer;
  font-size: 12px;
  text-align: center;
}

.action-btn:hover {
  background: #30363d;
}

.action-btn.primary {
  background: #238636;
  border-color: #2ea043;
  color: #fff;
}

.action-btn.primary:hover {
  background: #2ea043;
}
</style>
