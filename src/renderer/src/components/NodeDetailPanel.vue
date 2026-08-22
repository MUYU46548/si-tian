<template>
  <div v-if="node" class="detail-panel">
    <!-- 头部：图标 + 名称 + 层级 -->
    <div class="panel-hero" :style="heroStyle">
      <div class="hero-icon">{{ layerIcon }}</div>
      <div class="hero-info">
        <h2 class="hero-title">{{ node.displayName || node.name }}</h2>
        <span v-if="node.displayName" class="hero-source-name">原文名：{{ node.name }}</span>
        <span class="hero-layer">{{ node.layerLabel || node.layer }}</span>
      </div>
      <button class="close-btn" @click="store.clearSelection()">×</button>
    </div>

    <div class="panel-content" @click="handlePanelClick">
      <!-- 回退按钮（浏览历史非空时显示） -->
      <button v-if="nodeHistory.length > 0" class="history-back-btn" @click="goBackToNode" title="返回上一个查看的节点">
        ← 返回「{{ nodeHistory[nodeHistory.length - 1].displayName || nodeHistory[nodeHistory.length - 1].name }}」
      </button>

      <!-- 操作按钮（高频前置，任何 tab 下常驻可见） -->
      <section class="actions-section actions-section-top">
        <button class="action-btn primary" @click="openSourceInObsidian">
          <span class="btn-icon">📝</span> 在 Obsidian 中打开
        </button>
        <button class="action-btn locate-btn" @click="focusOnMap" :disabled="!canFocusOnMap" title="镜头定位到该节点在地图上的位置">
          <span class="btn-icon">🎯</span> 在地图上定位
        </button>
        <button class="action-btn" @click="revealInExplorer">
          <span class="btn-icon">📁</span> 在文件夹中显示
        </button>
        <button class="action-btn" @click="toggleLock" :title="isLocked ? '解除锁定（可拖拽/微调）' : '锁定位置（防误拖）'">
          <span class="btn-icon">{{ isLocked ? '🔓' : '🔒' }}</span> {{ isLocked ? '解除锁定' : '锁定位置' }}
        </button>
        <button class="action-btn danger" @click="removeFromMap" title="从地图移除该节点及其关联航道（可撤销）">
          <span class="btn-icon">🗑</span> 从地图移除
        </button>
      </section>

      <!-- 信息分区 tab（批次A5：概览=读、关系=跳转/归属、编辑=写操作） -->
      <div class="detail-tab-bar">
        <button class="detail-tab-btn" :class="{ active: activeTab === 'overview' }" @click="activeTab = 'overview'">概览</button>
        <button class="detail-tab-btn" :class="{ active: activeTab === 'relations' }" @click="activeTab = 'relations'">
          关系<span v-if="relationsCount" class="tab-count">{{ relationsCount }}</span>
        </button>
        <button class="detail-tab-btn" :class="{ active: activeTab === 'edit' }" @click="activeTab = 'edit'">编辑</button>
      </div>

      <!-- ===== Tab 概览：元信息 + frontmatter(默认折叠) + 正文 ===== -->
      <template v-if="activeTab === 'overview'">
        <!-- 元数据区域：仅显示 TAGS + 层级 -->
        <section v-if="node.tags?.length || node.layer" class="meta-section meta-section-compact">
          <div class="meta-row" v-if="node.layer">
            <span class="meta-key">层级</span>
            <span class="meta-val">{{ node.layerLabel || node.layer }}</span>
          </div>
          <div class="meta-row" v-if="node.tags?.length">
            <span class="meta-key">TAGS</span>
            <span class="meta-val meta-tags">{{ node.tags.join(', ') }}</span>
          </div>
        </section>

        <!-- 正文区域 -->
        <section v-if="note" class="content-section">
          <div v-if="note.frontmatter && Object.keys(note.frontmatter).length" class="frontmatter-block" :class="{ collapsed: !isFmExpanded }">
            <div v-for="(val, key) in note.frontmatter" :key="key" class="fm-row">
              <span class="fm-key">{{ key }}:</span>
              <span class="fm-val">{{ formatFmValue(val) }}</span>
            </div>
            <button class="expand-btn" @click="isFmExpanded = !isFmExpanded">
              {{ isFmExpanded ? '收起详情' : `展开详情 (${Object.keys(note.frontmatter).length} 项)` }}
            </button>
          </div>

          <div v-if="note.content" class="content-body" :class="{ collapsed: isContentLong && !isContentExpanded }">
            <div class="markdown-body" v-html="renderedContent"></div>
            <button v-if="isContentLong" class="expand-btn" @click="isContentExpanded = !isContentExpanded">
              {{ isContentExpanded ? '收起全文' : '展开全文' }}
            </button>
          </div>
        </section>
      </template>

      <!-- ===== Tab 关系：节点间跳转 + 层级迁移 ===== -->
      <template v-else-if="activeTab === 'relations'">
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
            <span class="relation-name">{{ parentNode.displayName || parentNode.name }}</span>
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
            <span class="relation-name">{{ child.displayName || child.name }}</span>
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
          <div v-for="h in relatedHyperlanes.slice(0, 6)" :key="h.id" class="relation-link hyperlane-link">
            <span class="relation-icon">🛤</span>
            <span class="relation-name">{{ getNodeName(h.fromId === node.id ? h.toId : h.fromId) }}</span>
            <select
              class="hyperlane-type-select"
              :value="h.type"
              :title="`航道类型：${hyperlaneTypeLabels[h.type] || h.type}`"
              @change="updateHyperlaneType(h, $event.target.value)"
              @click.stop
            >
              <option v-for="t in hyperlaneTypes" :key="t.value" :value="t.value">{{ t.label }}</option>
            </select>
            <button class="hyperlane-remove" @click.stop="removeHyperlane(h.id)" title="删除航道">×</button>
          </div>
        </div>
      </section>

      <!-- 层级迁移 -->
      <section class="reparent-section">
        <div class="section-header">
          <span class="section-title">层级迁移</span>
          <span class="section-note">修改上级节点归属</span>
        </div>
        <div class="reparent-control">
          <label>上级节点</label>
          <input
            v-model="reparentSearchQuery"
            type="text"
            class="reparent-search-input"
            placeholder="搜索节点名称或层级..."
          />
          <select :value="node.parentId ?? ''" @change="handleReparent($event.target.value || null)">
            <option value="">无（顶层 — 直接挂载于行星/星系下）</option>
            <option
              v-for="candidate in filteredParentCandidates"
              :key="candidate.id"
              :value="candidate.id"
            >
              {{ getLayerIcon(candidate.layer) }} {{ candidate.displayName || candidate.name }}（{{ store.layerLabels[candidate.layer] || candidate.layer }}）
            </option>
          </select>
          <p class="reparent-hint">
            {{ filteredParentCandidates.length }} / {{ parentCandidates.length }} 个可选目标 · 选择后立即生效，可撤销
          </p>
        </div>
      </section>
      </template>

      <!-- ===== Tab 编辑：标签 + 属性 + 坐标（全部写操作收拢） ===== -->
      <template v-else-if="activeTab === 'edit'">
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

      <!-- 属性编辑 -->
      <section class="property-section">
        <div class="section-header">
          <span class="section-title">属性</span>
          <span class="section-note">仅存缓存，重新提取后还原</span>
        </div>
        <div class="prop-field">
          <label>名称</label>
          <input type="text" :value="node.name" disabled title="名称对应 Markdown 文件名，请在 Obsidian 中重命名" />
        </div>
        <div class="prop-field">
          <label>显示名称</label>
          <input type="text" :value="node.displayName || ''" @change="updateDisplayName($event.target.value)" placeholder="留空使用原文名（如 时间钟楼（建筑）→ 时间钟楼）" />
        </div>
        <div class="prop-field">
          <label>层级</label>
          <select :value="node.layer" @change="updateLayer($event.target.value)">
            <option v-for="l in editableLayers" :key="l.value" :value="l.value">{{ l.label }}</option>
          </select>
        </div>
        <div class="prop-field" v-if="isPlaceNode">
          <label>地点类型</label>
          <select :value="node.placeType || ''" @change="updatePlaceType($event.target.value)">
            <option value="">未设置（回落默认样式）</option>
            <option v-for="t in placeTypes" :key="t" :value="t">{{ t }}</option>
          </select>
        </div>
        <div class="prop-field">
          <label>标签</label>
          <div class="tag-editor">
            <span v-for="tag in node.tags || []" :key="tag" class="tag-badge removable">
              {{ tag }}
              <button class="tag-remove" @click="removeTag(tag)" title="移除标签">×</button>
            </span>
            <span v-if="!(node.tags || []).length" class="tag-empty">无标签</span>
            <input
              v-model="newTagInput"
              class="tag-input"
              placeholder="+ 添加标签"
              @keydown.enter.prevent="addTag"
              @keydown.tab.prevent="addTag"
              @blur="addTag"
            />
          </div>
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
      </template>

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
const isFmExpanded = ref(false); // frontmatter 默认折叠（批次A5）
const activeTab = ref('overview'); // overview=概览 | relations=关系 | edit=编辑（批次A5）
const newTagInput = ref('');
const reparentSearchQuery = ref('');

const node = computed(() => store.selectedNode);

// 可编辑层级列表（与 LAYER_ORDER 一致，排除 world 顶层容器避免误改）
const editableLayers = [
  { value: 'star_domain', label: '星域' },
  { value: 'galaxy', label: '星系' },
  { value: 'star', label: '恒星' },
  { value: 'planet', label: '行星' },
  { value: 'moon', label: '卫星' },
  { value: 'region', label: '区域' },
  { value: 'city', label: '城市' },
  { value: 'town', label: '城镇' },
  { value: 'village', label: '村庄' },
  { value: 'facility', label: '设施' },
  { value: 'location', label: '地点' },
  { value: 'unknown', label: '未知' },
];

// 地点类型（第二维度，与提取脚本一致）
const placeTypes = ['自然', '宗教', '皇室', '商业', '工业', '居住', '公共', '特殊'];
const isPlaceNode = computed(() => ['facility', 'location', 'region'].includes(node.value?.layer));

// 航道类型选项
const hyperlaneTypes = [
  { value: 'local', label: '域内' },
  { value: 'cross_domain', label: '跨域' },
  { value: 'hyperjump', label: '跳跃' },
];
const hyperlaneTypeLabels = Object.fromEntries(hyperlaneTypes.map(t => [t.value, t.label]));

// 层级图标映射
const LAYER_ICONS = {
  world: '🌍', star_domain: '🌌', galaxy: '☀️', star: '✨',
  planet: '🌍', moon: '🌙', region: '🏞', city: '🏙',
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

// 关系 tab 徽标计数（子节点 + 关联链接 + 航道）
const relationsCount = computed(() =>
  childNodes.value.length + wikilinksFromContent.value.length + relatedHyperlanes.value.length
);

// 计算当前节点的所有后代节点 ID（用于过滤父节点候选）
function getDescendantIds(nodeId) {
  const descendants = new Set();
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift();
    const children = store.nodes.filter(n => n.parentId === current);
    for (const child of children) {
      if (!descendants.has(child.id)) {
        descendants.add(child.id);
        queue.push(child.id);
      }
    }
  }
  return descendants;
}

// 父节点候选列表：排除自身和后代，按层级分组排序
const parentCandidates = computed(() => {
  if (!node.value) return [];
  const descendants = getDescendantIds(node.value.id);
  return store.nodes
    .filter(n => n.id !== node.value.id && !descendants.has(n.id))
    .sort((a, b) => {
      const order = ['world', 'star_domain', 'galaxy', 'planet', 'region', 'city', 'town', 'village', 'facility', 'location'];
      return order.indexOf(a.layer) - order.indexOf(b.layer);
    });
});

// 搜索过滤后的候选列表
const filteredParentCandidates = computed(() => {
  const candidates = parentCandidates.value;
  const query = reparentSearchQuery.value.trim().toLowerCase();
  if (!query) return candidates;
  return candidates.filter(c => {
    const name = (c.displayName || c.name || '').toLowerCase();
    const layer = (store.layerLabels[c.layer] || c.layer || '').toLowerCase();
    return name.includes(query) || layer.includes(query) || c.layer.toLowerCase().includes(query);
  });
});

function getParentName(parentId) {
  const parent = store.nodes.find(n => n.id === parentId);
  return parent?.name || parentId;
}

// 层级迁移处理
function handleReparent(newParentId) {
  if (!node.value) return;
  const currentParentId = node.value.parentId ?? null;
  if ((newParentId === null && currentParentId === null) || newParentId === currentParentId) return;

  const targetName = newParentId ? (store.nodes.find(n => n.id === newParentId)?.name || '未知') : '无（顶层）';
  const currentName = currentParentId ? (store.nodes.find(n => n.id === currentParentId)?.name || '未知') : '无（顶层）';
  
  // 确认迁移
  const confirmed = confirm(`确定将「${node.value.name}」的上级节点从「${currentName}」修改为「${targetName}」？`);
  if (!confirmed) return;

  const result = store.reparentNode(node.value.id, newParentId);
  if (!result.success) {
    alert('迁移失败：' + result.reason);
    const selectEl = document.querySelector('.reparent-control select');
    if (selectEl) selectEl.value = currentParentId ?? '';
  }
}

function getNodeName(nodeId) {
  const n = store.nodes.find(x => x.id === nodeId);
  return n?.name || nodeId;
}

function formatFmValue(val) {
  if (Array.isArray(val)) return val.join(', ');
  return String(val);
}

// 节点浏览历史（用于回退按钮）
const nodeHistory = ref([]);

// 导航到节点（记录历史）
function navigateToNode(targetNode) {
  if (targetNode) {
    // 将当前节点压入历史栈
    if (node.value && node.value.id !== targetNode.id) {
      nodeHistory.value.push(node.value);
      // 限制历史栈长度，防止无限增长
      if (nodeHistory.value.length > 20) {
        nodeHistory.value.shift();
      }
    }
    store.selectNode(targetNode);
  }
}

// 返回上一个查看的节点
function goBackToNode() {
  if (nodeHistory.value.length > 0) {
    const prevNode = nodeHistory.value.pop();
    store.selectNode(prevNode);
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
  isFmExpanded.value = false;
  activeTab.value = 'overview';
  loadNote();
}, { immediate: true });

// 操作
function openSourceInObsidian() {
  if (!node.value?.sourcePath) return;
  const url = `obsidian://open?vault=${encodeURIComponent('ROSA')}&file=${encodeURIComponent(node.value.sourcePath)}`;
  window.sitianAPI.openExternal(url);
}

// 在地图上定位：节点有坐标且当前视图能展示时才可用
const canFocusOnMap = computed(() => {
  const n = node.value;
  if (!n || n.coordinate?.x === null || n.coordinate?.x === undefined) return false;
  return ['world', 'star_domain', 'galaxy', 'planet', 'location', 'city', 'town', 'village', 'facility'].includes(n.layer);
});

function focusOnMap() {
  if (!node.value) return;
  window.dispatchEvent(new CustomEvent('sitian:focus-node', { detail: node.value }));
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

// 锁定/解锁节点位置
const isLocked = computed(() => !!node.value?.locked);

function toggleLock() {
  if (!node.value) return;
  store.toggleNodeLock(node.value.id);
}

// 从地图移除节点（仅移除 JSON 缓存，不删除 Obsidian 文件）
function removeFromMap() {
  if (!node.value) return;
  const target = node.value;
  const childCount = store.nodes.filter(n => n.parentId === target.id).length;
  const linkCount = store.getHyperlanesForNode(target.id).length;
  
  const msg = `确定从地图移除「${target.name}」吗？\n\n` +
    `将同时移除 ${linkCount} 条关联航道` +
    (childCount ? `，并把 ${childCount} 个子节点置为未归属` : '') +
    `。\n\n仅移除坐标缓存，不会删除 Obsidian 笔记。可用 Ctrl+Z 撤销。`;
  
  if (!confirm(msg)) return;
  
  store.removeNode(target.id);
  store.clearSelection();
  window.dispatchEvent(new CustomEvent('sitian:node-removed-from-map', { detail: target.id }));
}

// 更新层级（仅缓存层，可撤销）
function updateLayer(layer) {
  if (!node.value || node.value.layer === layer) return;
  store.updateNode(node.value.id, { layer, layerLabel: editableLayers.find(l => l.value === layer)?.label || layer });
  window.dispatchEvent(new CustomEvent('sitian:coordinate-updated'));
}

function updateDisplayName(value) {
  if (!node.value) return;
  const v = value.trim();
  store.updateNode(node.value.id, { displayName: v || null });
  window.dispatchEvent(new CustomEvent('sitian:coordinate-updated'));
}

function updatePlaceType(value) {
  if (!node.value) return;
  store.updateNode(node.value.id, { placeType: value || null });
  window.dispatchEvent(new CustomEvent('sitian:coordinate-updated'));
}

// 添加标签
function addTag() {
  const tag = newTagInput.value.trim();
  if (!tag || !node.value) return;
  const tags = [...(node.value.tags || [])];
  if (!tags.includes(tag)) {
    tags.push(tag);
    store.updateNode(node.value.id, { tags });
  }
  newTagInput.value = '';
}

// 移除标签
function removeTag(tag) {
  if (!node.value) return;
  const tags = (node.value.tags || []).filter(t => t !== tag);
  store.updateNode(node.value.id, { tags });
}

// 更新航道类型（走 undo 栈）
function updateHyperlaneType(h, type) {
  if (!h || h.type === type) return;
  store.updateHyperlane(h.id, { type });
  window.dispatchEvent(new CustomEvent('sitian:coordinate-updated'));
}

// 删除航道（走 undo 栈）
function removeHyperlane(hyperlaneId) {
  store.removeHyperlane(hyperlaneId);
  window.dispatchEvent(new CustomEvent('sitian:coordinate-updated'));
}

// 更新坐标
function updateCoordinate(axis, value) {
  if (!node.value) return;
  const num = parseFloat(value);
  if (isNaN(num)) return;
  
  const nodeId = node.value.id;
  const existingCoord = node.value.coordinate || {};
  
  // 手动输入坐标视为用户意图，布局重算时保留（直接改响应式节点，不产生额外 undo 命令）
  if (node.value.userMoved !== true) {
    node.value.userMoved = true;
    store.scheduleAutoSave();
  }
  
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
  border-radius: var(--radius-lg);
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

.hero-source-name {
  display: block;
  font-size: 10px;
  color: #6e7681;
  margin-top: 1px;
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
  border-radius: var(--radius-lg);
  color: #58a6ff;
}

.close-btn {
  background: rgba(255, 255, 255, 0.06);
  border: none;
  color: #8b949e;
  font-size: 18px;
  cursor: pointer;
  padding: 6px 10px;
  border-radius: var(--radius-md);
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

.meta-section-compact {
  display: flex;
  gap: 8px;
  padding: 8px 0;
}

.meta-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  background: #161b22;
  border-radius: var(--radius-sm);
  border: 1px solid #30363d;
}

.meta-section-compact .meta-key {
  font-size: 10px;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.meta-section-compact .meta-val {
  font-size: 12px;
  color: #e2e8f0;
  font-weight: 500;
}

.meta-section-compact .meta-tags {
  font-size: 11px;
  color: #58a6ff;
}

.meta-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.meta-item {
  background: #161b22;
  padding: 8px 12px;
  border-radius: var(--radius-md);
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
  border-radius: var(--radius-md);
  border: 1px solid #30363d;
  margin-bottom: 12px;
}

/* 默认折叠（批次A5）：只露前几行 + 底部渐隐，展开按钮见下 */
.frontmatter-block.collapsed .fm-row:nth-child(n+4) {
  display: none;
}

.frontmatter-block.collapsed {
  padding-bottom: 6px;
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
  border-radius: var(--radius-md);
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
  border-radius: var(--radius-sm);
  color: #58a6ff;
  cursor: pointer;
  font-size: 11px;
  text-align: center;
}

.expand-btn:hover {
  background: #30363d;
}

/* ===== 信息分区 tab（批次A5，样式对齐 ObjectListPanel tab-bar） ===== */
.detail-tab-bar {
  display: flex;
  gap: 2px;
  margin-bottom: 12px;
  border-bottom: 1px solid #30363d;
}

.detail-tab-btn {
  flex: 1;
  padding: 7px 4px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: #8b949e;
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.detail-tab-btn:hover {
  color: #e2e8f0;
}

.detail-tab-btn.active {
  color: #58a6ff;
  border-bottom-color: #58a6ff;
}

.tab-count {
  font-size: 10px;
  background: #21262d;
  border-radius: 8px;
  padding: 0 5px;
  line-height: 14px;
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
  border-radius: var(--radius-md);
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
  border-radius: var(--radius-md);
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
  border-radius: var(--radius-md);
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

.hyperlane-type-select {
  flex-shrink: 0;
  max-width: 64px;
  padding: 2px 4px;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: var(--radius-sm);
  color: #58a6ff;
  font-size: 10px;
  outline: none;
  cursor: pointer;
}

.hyperlane-type-select:focus {
  border-color: #58a6ff;
}

.hyperlane-remove {
  flex-shrink: 0;
  background: none;
  border: none;
  color: #8b949e;
  font-size: 14px;
  line-height: 1;
  padding: 0 3px;
  cursor: pointer;
  border-radius: 50%;
}

.hyperlane-remove:hover {
  color: #f85149;
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

/* ===== 属性编辑 ===== */
.property-section {
  margin-bottom: 16px;
}

.section-note {
  font-size: 10px;
  color: #8b949e;
  font-weight: normal;
  margin-left: 8px;
}

.prop-field {
  margin-bottom: 10px;
}

.prop-field label {
  display: block;
  font-size: 10px;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: 4px;
}

.prop-field input[type="text"],
.prop-field select {
  width: 100%;
  padding: 6px 8px;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: var(--radius-sm);
  color: #e2e8f0;
  font-size: 12px;
  outline: none;
  transition: border-color 0.15s;
}

.prop-field input[type="text"]:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.prop-field select:focus,
.prop-field input[type="text"]:not(:disabled):focus {
  border-color: #58a6ff;
}

.tag-editor {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.tag-badge.removable {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: default;
}

.tag-badge.removable:hover {
  transform: none;
}

.tag-remove {
  background: none;
  border: none;
  color: #58a6ff;
  font-size: 13px;
  line-height: 1;
  padding: 0 2px;
  cursor: pointer;
  border-radius: 50%;
}

.tag-remove:hover {
  color: #f85149;
}

.tag-empty {
  font-size: 11px;
  color: #8b949e;
}

.tag-input {
  flex: 1;
  min-width: 90px;
  padding: 4px 8px;
  background: transparent;
  border: 1px dashed #30363d;
  border-radius: var(--radius-xl);
  color: #e2e8f0;
  font-size: 11px;
  outline: none;
  transition: border-color 0.15s;
}

.tag-input:focus {
  border-color: #58a6ff;
  border-style: solid;
}

.tag-input::placeholder {
  color: #6e7681;
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
  border-radius: var(--radius-sm);
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
  padding: 0 0 12px 0;
}

.actions-section-top {
  border-bottom: 1px solid #21262d;
  margin-bottom: 12px;
}

/* 回退按钮：返回上一个查看的节点 */
.history-back-btn {
  width: 100%;
  padding: 6px 12px;
  margin-bottom: 12px;
  border: 1px dashed #30363d;
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.02);
  color: #8b949e;
  cursor: pointer;
  font-size: 12px;
  text-align: left;
  transition: background 0.1s ease, color 0.1s ease;
}

.history-back-btn:hover {
  background: rgba(255, 255, 255, 0.06);
  color: #e2e8f0;
}

.action-btn {
  flex: 1;
  padding: 10px 14px;
  border: 1px solid #30363d;
  border-radius: var(--radius-md);
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

/* 定位按钮高亮（金色呼吸光圈） */
.action-btn.locate-btn {
  border-color: #FFD70055;
  background: #FFD70014;
  color: #FFD700;
  animation: locate-pulse 2.5s ease-in-out infinite;
}

.action-btn.locate-btn:hover {
  background: #FFD70028;
}

@keyframes locate-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255, 215, 0, 0.3); }
  50% { box-shadow: 0 0 0 5px rgba(255, 215, 0, 0); }
}

.action-btn.danger {
  border-color: #f8514933;
  background: #f8514914;
  color: #f85149;
}

.action-btn.danger:hover {
  background: #f8514933;
  border-color: #f85149;
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

/* 层级迁移 */
.reparent-section {
  padding: 16px 18px;
  border-top: 1px solid #21262d;
}

.reparent-control {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.reparent-control label {
  font-size: 12px;
  color: #8b949e;
  font-weight: 500;
}

.reparent-control select {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid #30363d;
  background: #161b22;
  color: #e2e8f0;
  font-size: 13px;
  cursor: pointer;
  max-width: 100%;
}

.reparent-search-input {
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid #30363d;
  background: #161b22;
  color: #e2e8f0;
  font-size: 13px;
  outline: none;
}

.reparent-search-input:focus {
  border-color: #58a6ff;
}

.reparent-search-input::placeholder {
  color: #8b949e;
}

.reparent-control select:hover {
  border-color: #58a6ff;
}

.reparent-hint {
  font-size: 11px;
  color: #6e7681;
  margin: 0;
}
</style>
