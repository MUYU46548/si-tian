<template>
  <div v-if="node" class="detail-panel">
    <!-- 头部：图标 + 名称 + 层级 -->
    <div class="panel-hero" :style="heroStyle">
      <div class="hero-icon">{{ layerIcon }}</div>
      <div class="hero-info">
        <h2 class="hero-title">{{ node.name }}</h2>
        <span class="hero-layer">{{ node.layerLabel || node.layer }}</span>
      </div>
      <button class="close-btn" @click="store.clearSelection()">×</button>
    </div>

    <div class="panel-content" @click="handlePanelClick">
      <!-- 元数据区域 -->
      <section v-if="note && hasFrontmatter" class="meta-section">
        <div class="meta-grid">
          <div v-for="(val, key) in note.frontmatter" :key="key" class="meta-item">
            <span class="meta-key">{{ key }}</span>
            <span class="meta-val">{{ formatFmValue(val) }}</span>
          </div>
        </div>
      </section>

      <!-- 正文区域 -->
      <section v-if="note" class="content-section">
        <div v-if="note.frontmatter && Object.keys(note.frontmatter).length" class="frontmatter-block">
          <div v-for="(val, key) in note.frontmatter" :key="key" class="fm-row">
            <span class="fm-key">{{ key }}:</span>
            <span class="fm-val">{{ formatFmValue(val) }}</span>
          </div>
        </div>

        <div v-if="note.content" class="content-body" :class="{ collapsed: isContentLong && !isContentExpanded }">
          <div class="markdown-body" v-html="renderedContent"></div>
          <button v-if="isContentLong" class="expand-btn" @click="isContentExpanded = !isContentExpanded">
            {{ isContentExpanded ? '收起全文' : '展开全文' }}
          </button>
        </div>
      </section>

      <!-- 关系区域 -->
      <section class="relations-section">
        <div class="section-header">
          <span class="section-title">关系</span>
        </div>
        
        <!-- 上级节点 -->
        <div v-if="node.parentId && parentNode" class="relation-group">
          <div class="relation-label">上级</div>
          <a class="relation-link parent-link" @click="navigateToNode(parentNode)">
            <span class="relation-icon">{{ getLayerIcon(parentNode.layer) }}</span>
            <span class="relation-name">{{ parentNode.name }}</span>
          </a>
        </div>

        <!-- 子节点 -->
        <div v-if="childNodes.length" class="relation-group">
          <div class="relation-label">子节点 ({{ childNodes.length }})</div>
          <a 
            v-for="child in childNodes.slice(0, 6)" 
            :key="child.id" 
            class="relation-link child-link"
            @click="navigateToNode(child)"
          >
            <span class="relation-icon">{{ getLayerIcon(child.layer) }}</span>
            <span class="relation-name">{{ child.name }}</span>
          </a>
          <span v-if="childNodes.length > 6" class="relation-more">+{{ childNodes.length - 6 }} 更多...</span>
        </div>

        <!-- Wikilinks 关联 -->
        <div v-if="wikilinksFromContent.length" class="relation-group">
          <div class="relation-label">关联链接</div>
          <a 
            v-for="link in wikilinksFromContent.slice(0, 8)" 
            :key="link" 
            class="relation-link wikilink-item"
            @click="openInObsidian(link)"
          >
            <span class="relation-icon">🔗</span>
            <span class="relation-name">{{ link }}</span>
          </a>
        </div>

        <!-- 关联航道 -->
        <div v-if="relatedHyperlanes.length" class="relation-group">
          <div class="relation-label">航道</div>
          <div v-for="h in relatedHyperlanes.slice(0, 4)" :key="h.id" class="relation-link hyperlane-link">
            <span class="relation-icon">🛤</span>
            <span class="relation-name">{{ getNodeName(h.fromId === node.id ? h.toId : h.fromId) }}</span>
            <span class="relation-type">{{ h.type }}</span>
          </div>
        </div>
      </section>

      <!-- 标签云 -->
      <section v-if="node.tags?.length" class="tags-section">
        <div class="section-header">
          <span class="section-title">标签</span>
        </div>
        <div class="tags-cloud">
          <span 
            v-for="tag in node.tags" 
            :key="tag" 
            class="tag-badge"
            @click="searchByTag(tag)"
          >{{ tag }}</span>
        </div>
      </section>

      <!-- 坐标编辑 -->
      <section class="coordinate-section">
        <div class="section-header">
          <span class="section-title">坐标</span>
        </div>
        <div class="coordinate-inputs">
          <div class="coord-field">
            <label>X</label>
            <input 
              type="number" 
              :value="node.coordinate?.x" 
              @input="updateCoordinate('x', $event.target.value)"
              step="1"
              placeholder="0"
            />
          </div>
          <div class="coord-field">
            <label>Y</label>
            <input 
              type="number" 
              :value="node.coordinate?.y" 
              @input="updateCoordinate('y', $event.target.value)"
              step="1"
              placeholder="0"
            />
          </div>
        </div>
      </section>

      <!-- 操作按钮 -->
      <section class="actions-section">
        <button class="action-btn primary" @click="openSourceInObsidian">
          <span class="btn-icon">📝</span> 在 Obsidian 中打开
        </button>
        <button class="action-btn" @click="revealInExplorer">
          <span class="btn-icon">📁</span> 在文件夹中显示
        </button>
      </section>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { marked } from 'marked';
import { useGeodataStore } from '../store/geodata';

// marked 配置
marked.setOptions({ gfm: true, breaks: true });

const store = useGeodataStore();
const note = ref(null);
const loading = ref(false);
const isContentExpanded = ref(false);

const node = computed(() => store.selectedNode);

// 层级图标映射
const LAYER_ICONS = {
  world: '🌍', star_domain: '🌌', galaxy: '☀️', star: '✨',
  planet: '🪐', moon: '🌙', region: '🏞', city: '🏙',
  town: '🏘', village: '🏡', facility: '🏛', location: '📍', unknown: '❓'
};

const layerIcon = computed(() => LAYER_ICONS[node.value?.layer] || '❓');

// 头部背景样式（根据层级）
const heroStyle = computed(() => {
  const colors = {
    world: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
    star_domain: 'linear-gradient(135deg, #0f3460 0%, #16213e 100%)',
    galaxy: 'linear-gradient(135deg, #533483 0%, #1a1a2e 100%)',
    planet: 'linear-gradient(135deg, #2d6a4f 0%, #1b4332 100%)',
    city: 'linear-gradient(135deg, #386fa4 0%, #1b3a5c 100%)',
    town: 'linear-gradient(135deg, #5c8001 0%, #3a5001 100%)',
  };
  const bg = colors[node.value?.layer] || 'linear-gradient(135deg, #1a1a2e 0%, #0d1117 100%)';
  return { background: bg };
});

// 获取层级图标
function getLayerIcon(layer) {
  return LAYER_ICONS[layer] || '❓';
}

// 计算 frontmatter 是否有内容
const hasFrontmatter = computed(() => {
  return note.value?.frontmatter && Object.keys(note.value.frontmatter).length > 0;
});

// 提取 wikilinks（从正文中解析）
const wikilinksFromContent = computed(() => {
  if (!note.value?.content) return [];
  const links = new Set();
  const regex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  let match;
  while ((match = regex.exec(note.value.content)) !== null) {
    links.add(match[1].trim());
  }
  return [...links];
});

// 预处理 Obsidian 语法
function preprocessObsidianSyntax(content) {
  if (!content) return '';
  let processed = content;
  
  // ![[image.png]] → 图片占位
  processed = processed.replace(/!\[\[([^\]]+)\]\]/g, 
    '<span class="obsidian-image">📷 $1</span>');
  
  // [[显示名|链接]] → 可点击链接
  processed = processed.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, 
    '<a class="wikilink" data-link="$2">$1</a>');
  
  // [[链接]] → 可点击链接（名称=链接）
  processed = processed.replace(/\[\[([^\]]+)\]\]/g, 
    '<a class="wikilink" data-link="$1">$1</a>');
  
  // Obsidian callout 语法转换
  processed = processed.replace(/^>\s\[!(\w+)\]\s*(.*)$/gm, (match, type, title) => {
    return `<div class="callout callout-${type}" data-type="${type}"><div class="callout-title">${title || type.toUpperCase()}</div><div class="callout-content">`;
  });
  processed = processed.replace(/^>\s(?!\[)(.*)$/gm, '$1');
  
  return processed;
}

const renderedContent = computed(() => {
  if (!note.value?.content) return '';
  const preprocessed = preprocessObsidianSyntax(note.value.content);
  return marked.parse(preprocessed);
});

// 内容过长时显示折叠按钮
const isContentLong = computed(() => {
  return (note.value?.content?.length || 0) > 800;
});

// 关联航道
const relatedHyperlanes = computed(() => {
  if (!node.value) return [];
  return store.getHyperlanesForNode(node.value.id);
});

// 父节点
const parentNode = computed(() => {
  if (!node.value?.parentId) return null;
  return store.nodes.find(n => n.id === node.value.parentId);
});

// 子节点
const childNodes = computed(() => {
  if (!node.value) return [];
  return store.nodes.filter(n => n.parentId === node.value.id);
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

// 导航到节点
function navigateToNode(targetNode) {
  if (targetNode) {
    store.selectNode(targetNode);
  }
}

// 标签搜索
function searchByTag(tag) {
  const event = new CustomEvent('sitian:search-tag', { detail: tag });
  window.dispatchEvent(event);
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

watch(node, () => {
  isContentExpanded.value = false;
  loadNote();
}, { immediate: true });

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

// 事件委托处理点击
function handlePanelClick(e) {
  const wikilink = e.target.closest('.wikilink');
  if (wikilink) {
    e.preventDefault();
    const linkName = wikilink.getAttribute('data-link');
    if (linkName) openInObsidian(linkName);
  }
}

async function revealInExplorer() {
  if (!node.value?.sourcePath) return;
  const vaultPath = 'E:/图书馆/ROSA';
  const fullPath = `${vaultPath}/${node.value.sourcePath}`;
  await window.sitianAPI.revealInExplorer(fullPath);
}

// 更新坐标
function updateCoordinate(axis, value) {
  if (!node.value) return;
  const num = parseFloat(value);
  if (isNaN(num)) return;
  
  const nodeId = node.value.id;
  const existingCoord = node.value.coordinate || {};
  
  if (axis === 'x') {
    store.updateNodePosition(nodeId, num, existingCoord.y || 0);
  } else {
    store.updateNodePosition(nodeId, existingCoord.x || 0, num);
  }
  
  // 触发重新渲染
  window.dispatchEvent(new CustomEvent('sitian:coordinate-updated'));
}
</script>

<style scoped>
.detail-panel {
  position: fixed;
  right: 0;
  top: 0;
  width: 360px;
  height: 100vh;
  background: #0d1117;
  border-left: 1px solid #30363d;
  display: flex;
  flex-direction: column;
  z-index: 100;
  box-shadow: -4px 0 24px rgba(0, 0, 0, 0.4);
}

/* ===== 头部区域 ===== */
.panel-hero {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid #30363d;
  min-height: 80px;
}

.hero-icon {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  flex-shrink: 0;
}

.hero-info {
  flex: 1;
  min-width: 0;
}

.hero-title {
  font-size: 16px;
  font-weight: 600;
  color: #f0f6fc;
  margin: 0;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hero-layer {
  display: inline-block;
  font-size: 11px;
  color: #8b949e;
  margin-top: 4px;
  padding: 2px 8px;
  background: rgba(88, 166, 255, 0.12);
  border-radius: 10px;
  color: #58a6ff;
}

.close-btn {
  background: rgba(255, 255, 255, 0.06);
  border: none;
  color: #8b949e;
  font-size: 18px;
  cursor: pointer;
  padding: 6px 10px;
  border-radius: 6px;
  flex-shrink: 0;
}

.close-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  color: #f0f6fc;
}

/* ===== 面板内容 ===== */
.panel-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}

/* ===== 元数据区域 ===== */
.meta-section {
  margin-bottom: 16px;
}

.meta-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.meta-item {
  background: #161b22;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid #30363d;
}

.meta-key {
  display: block;
  font-size: 10px;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: 2px;
}

.meta-val {
  display: block;
  font-size: 12px;
  color: #e2e8f0;
  font-weight: 500;
}

/* ===== Frontmatter 块 ===== */
.frontmatter-block {
  background: #161b22;
  padding: 10px 14px;
  border-radius: 6px;
  border: 1px solid #30363d;
  margin-bottom: 12px;
}

.fm-row {
  display: flex;
  gap: 8px;
  font-size: 11px;
  margin-bottom: 3px;
}

.fm-row:last-child {
  margin-bottom: 0;
}

.fm-key {
  color: #8b949e;
  min-width: 60px;
  flex-shrink: 0;
}

.fm-val {
  color: #e2e8f0;
}

/* ===== 正文区域 ===== */
.content-section {
  margin-bottom: 16px;
}

.content-body {
  font-size: 12px;
  line-height: 1.6;
  background: #161b22;
  padding: 14px;
  border-radius: 6px;
  border: 1px solid #30363d;
}

.content-body.collapsed {
  max-height: 240px;
  overflow: hidden;
  position: relative;
}

.content-body.collapsed::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 50px;
  background: linear-gradient(transparent, #161b22);
  pointer-events: none;
}

.expand-btn {
  display: block;
  width: 100%;
  margin-top: 10px;
  padding: 8px;
  background: #21262d;
  border: 1px solid #30363d;
  border-radius: 4px;
  color: #58a6ff;
  cursor: pointer;
  font-size: 11px;
  text-align: center;
}

.expand-btn:hover {
  background: #30363d;
}

/* ===== Markdown 渲染 ===== */
.markdown-body {
  color: #c9d1d9;
}

.markdown-body h1,
.markdown-body h2,
.markdown-body h3,
.markdown-body h4 {
  color: #f0f6fc;
  margin: 14px 0 8px;
  font-weight: 600;
  line-height: 1.3;
}

.markdown-body h1 { font-size: 16px; border-bottom: 1px solid #30363d; padding-bottom: 6px; }
.markdown-body h2 { font-size: 14px; }
.markdown-body h3 { font-size: 13px; }
.markdown-body h4 { font-size: 12px; }

.markdown-body p {
  margin: 0 0 10px;
}

.markdown-body a {
  color: #58a6ff;
  text-decoration: none;
}

.markdown-body a:hover {
  text-decoration: underline;
}

.markdown-body ul,
.markdown-body ol {
  padding-left: 22px;
  margin: 0 0 10px;
}

.markdown-body li {
  margin-bottom: 3px;
}

.markdown-body code {
  background: #0d1117;
  color: #e2e8f0;
  padding: 2px 5px;
  border-radius: 3px;
  font-size: 11px;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
}

.markdown-body pre {
  background: #0d1117;
  padding: 10px;
  border-radius: 6px;
  overflow-x: auto;
  margin: 0 0 10px;
  border: 1px solid #21262d;
}

.markdown-body pre code {
  background: none;
  padding: 0;
}

.markdown-body blockquote {
  border-left: 3px solid #30363d;
  padding-left: 12px;
  color: #8b949e;
  margin: 0 0 10px;
}

.markdown-body table {
  border-collapse: collapse;
  width: 100%;
  margin: 0 0 10px;
  font-size: 11px;
}

.markdown-body th,
.markdown-body td {
  border: 1px solid #30363d;
  padding: 5px 10px;
  text-align: left;
}

.markdown-body th {
  background: #161b22;
  color: #f0f6fc;
  font-weight: 600;
}

.markdown-body hr {
  border: none;
  border-top: 1px solid #30363d;
  margin: 14px 0;
}

.markdown-body strong { color: #f0f6fc; font-weight: 600; }
.markdown-body em { color: #e2e8f0; }

/* Wikilinks */
.wikilink {
  color: #58a6ff;
  text-decoration: none;
  border-bottom: 1px dashed #58a6ff;
  cursor: pointer;
}

.wikilink:hover {
  text-decoration: underline;
  border-bottom-style: solid;
}

/* Obsidian 图片占位 */
.obsidian-image {
  display: inline-block;
  background: #21262d;
  color: #8b949e;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 11px;
}

/* Obsidian Callouts */
.callout {
  margin: 0 0 10px;
  padding: 10px 14px;
  border-radius: 6px;
  border-left: 3px solid #58a6ff;
  background: rgba(88, 166, 255, 0.08);
}

.callout-title {
  font-weight: 600;
  color: #58a6ff;
  margin-bottom: 4px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.callout-content {
  color: #c9d1d9;
}

.callout-info { border-left-color: #58a6ff; background: rgba(88, 166, 255, 0.08); }
.callout-info .callout-title { color: #58a6ff; }

.callout-warning, .callout-caution, .callout-attention { 
  border-left-color: #d29922; 
  background: rgba(210, 153, 34, 0.08); 
}
.callout-warning .callout-title, .callout-caution .callout-title, .callout-attention .callout-title { 
  color: #d29922; 
}

.callout-danger, .callout-error { 
  border-left-color: #f85149; 
  background: rgba(248, 81, 73, 0.08); 
}
.callout-danger .callout-title, .callout-error .callout-title { 
  color: #f85149; 
}

.callout-success, .callout-check, .callout-done { 
  border-left-color: #3fb950; 
  background: rgba(63, 185, 80, 0.08); 
}
.callout-success .callout-title, .callout-check .callout-title, .callout-done .callout-title { 
  color: #3fb950; 
}

.callout-note { border-left-color: #a371f7; background: rgba(163, 113, 247, 0.08); }
.callout-note .callout-title { color: #a371f7; }

/* ===== 关系区域 ===== */
.relations-section {
  margin-bottom: 16px;
}

.section-header {
  display: flex;
  align-items: center;
  margin-bottom: 10px;
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.relation-group {
  margin-bottom: 12px;
}

.relation-label {
  font-size: 10px;
  color: #8b949e;
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.relation-link {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  color: #e2e8f0;
  background: #161b22;
  border: 1px solid #30363d;
  margin-bottom: 4px;
  transition: background 0.1s ease, border-color 0.1s ease;
}

.relation-link:hover {
  background: #21262d;
  border-color: #58a6ff;
}

.relation-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.relation-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.relation-type {
  font-size: 10px;
  color: #8b949e;
  padding: 1px 6px;
  background: #0d1117;
  border-radius: 3px;
}

.relation-more {
  display: block;
  font-size: 11px;
  color: #8b949e;
  padding: 6px 10px;
  text-align: center;
  font-style: italic;
}

.parent-link {
  border-color: #58a6ff44;
}

.parent-link:hover {
  border-color: #58a6ff;
}

.wikilink-item {
  border-color: #a371f744;
}

.wikilink-item:hover {
  border-color: #a371f7;
}

/* ===== 标签云 ===== */
.tags-section {
  margin-bottom: 16px;
}

.tags-cloud {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag-badge {
  display: inline-block;
  padding: 4px 10px;
  background: #388bfd22;
  color: #58a6ff;
  border-radius: 14px;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.1s ease, transform 0.1s ease;
}

.tag-badge:hover {
  background: #388bfd44;
  transform: translateY(-1px);
}

.tag-badge:active {
  transform: translateY(0);
}

/* ===== 坐标编辑 ===== */
.coordinate-section {
  margin-bottom: 16px;
}

.coordinate-inputs {
  display: flex;
  gap: 8px;
}

.coord-field {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.coord-field label {
  font-size: 10px;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.coord-field input {
  padding: 6px 8px;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  color: #e2e8f0;
  font-size: 12px;
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  outline: none;
  transition: border-color 0.15s;
}

.coord-field input:focus {
  border-color: #58a6ff;
}

.coord-field input::placeholder {
  color: #484f58;
}

/* ===== 操作按钮 ===== */
.actions-section {
  display: flex;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid #21262d;
  margin-top: auto;
}

.action-btn {
  flex: 1;
  padding: 10px 14px;
  border: 1px solid #30363d;
  border-radius: 6px;
  background: #21262d;
  color: #e2e8f0;
  cursor: pointer;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: background 0.1s ease, border-color 0.1s ease;
}

.action-btn:hover {
  background: #30363d;
}

.action-btn.primary {
  background: #238636;
  border-color: #2ea043;
  color: #f0f6fc;
}

.action-btn.primary:hover {
  background: #2ea043;
}

.btn-icon {
  font-size: 14px;
}
</style>
