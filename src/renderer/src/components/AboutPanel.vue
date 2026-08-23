<template>
  <div v-if="isOpen" class="about-overlay" @click.self="close">
    <div class="about-panel">
      <div class="about-header">
        <div class="about-logo">
          <span class="logo-icon">🌌</span>
          <div class="logo-info">
            <h2>SiTian</h2>
            <span class="version">v0.1.0</span>
          </div>
        </div>
        <button class="close-btn" @click="close">×</button>
      </div>

      <div class="about-content">
        <!-- 关于 -->
        <section class="about-section">
          <h3>关于</h3>
          <p class="description">
            世界观地理可视化编辑器，为 Obsidian 知识库设计的星图工具。
            以 Stellaris 风格的五层视图呈现地理层级，支持 Markdown 附加可编辑坐标元数据，
            实现画布与笔记的双向同步。
          </p>
        </section>

        <!-- 快速开始 -->
        <section class="about-section">
          <h3>📖 快速开始</h3>
          <ul class="guide-list">
            <li><b>五层视图导航</b>：世界卡片 → 星域地图 → 域内星系总览 → 单系详情 → 行星地图</li>
            <li><b>区域与建筑</b>：行星地图中点击聚落进入区域地图，再下钻建筑内部</li>
            <li><b>点击节点</b>：查看百科卡片式详情面板</li>
            <li><b>编辑模式</b>：各视图均支持编辑地图，自动保存到 JSON 缓存</li>
            <li><b>撤销/重做</b>：Ctrl+Z / Ctrl+Y 全程可回溯</li>
          </ul>
        </section>

        <!-- 快捷键 -->
        <section class="about-section">
          <h3>⌨️ 快捷键</h3>
          <div class="shortcuts-grid">
            <div class="shortcut-item">
              <kbd>Ctrl</kbd> + <kbd>Z</kbd>
              <span class="shortcut-desc">撤销</span>
            </div>
            <div class="shortcut-item">
              <kbd>Ctrl</kbd> + <kbd>Y</kbd>
              <span class="shortcut-desc">重做</span>
            </div>
            <div class="shortcut-item">
              <kbd>Ctrl</kbd> + <kbd>F</kbd>
              <span class="shortcut-desc">搜索节点</span>
            </div>
            <div class="shortcut-item">
              <kbd>F1</kbd>
              <span class="shortcut-desc">打开帮助</span>
            </div>
            <div class="shortcut-item">
              <kbd>L</kbd>
              <span class="shortcut-desc">图层面板</span>
            </div>
            <div class="shortcut-item">
              <kbd>Del</kbd>
              <span class="shortcut-desc">删除选中</span>
            </div>
            <div class="shortcut-item">
              <kbd>Esc</kbd>
              <span class="shortcut-desc">取消/关闭</span>
            </div>
            <div class="shortcut-item">
              <kbd>空格</kbd>
              <span class="shortcut-desc">临时拖手</span>
            </div>
            <div class="shortcut-item">
              <kbd>/</kbd>
              <span class="shortcut-desc">聚焦搜索</span>
            </div>
          </div>
        </section>

        <!-- 行星地图编辑 -->
        <section class="about-section">
          <h3>🛠 行星地图编辑</h3>
          <div class="edit-modes">
            <div class="mode-item">
              <span class="mode-icon">✏️</span>
              <div class="mode-info">
                <span class="mode-name">自由绘制</span>
                <span class="mode-desc">按住拖动绘制省份边界，松开自动闭合</span>
              </div>
            </div>
            <div class="mode-item">
              <span class="mode-icon">📐</span>
              <div class="mode-info">
                <span class="mode-name">点击描点</span>
                <span class="mode-desc">逐点放置顶点，双击闭合多边形</span>
              </div>
            </div>
            <div class="mode-item">
              <span class="mode-icon">▣</span>
              <div class="mode-info">
                <span class="mode-name">区域填充</span>
                <span class="mode-desc">点击空白处自动生成不重叠区域</span>
              </div>
            </div>
            <div class="mode-item">
              <span class="mode-icon">🧲</span>
              <div class="mode-info">
                <span class="mode-name">边缘吸附</span>
                <span class="mode-desc">自动贴合相邻省份边界</span>
              </div>
            </div>
          </div>
        </section>

        <!-- 数据来源 -->
        <section class="about-section">
          <h3>📂 数据来源</h3>
          <div class="data-info">
            <div class="data-row">
              <span class="data-label">Obsidian 知识库</span>
              <span class="data-path">（用户配置的 Obsidian 知识库路径）</span>
            </div>
            <div class="data-row">
              <span class="data-label">坐标缓存</span>
              <span class="data-path">.sitian/geodata.json</span>
            </div>
            <div class="data-row">
              <span class="data-label">地图数据</span>
              <span class="data-path">.sitian/mapdata.json</span>
            </div>
          </div>
          <p class="note">
            所有原始世界观数据仅存于 Obsidian 库的 Markdown 文件中。
            JSON 文件仅作为坐标缓存加速编辑，可被删除后重新提取。
          </p>
        </section>

        <!-- 技术栈 -->
        <section class="about-section">
          <h3>🔧 技术栈</h3>
          <div class="tech-tags">
            <span class="tech-tag">Electron 28</span>
            <span class="tech-tag">Vue 3</span>
            <span class="tech-tag">Pinia</span>
            <span class="tech-tag">Vite 5</span>
            <span class="tech-tag">Canvas 2D</span>
            <span class="tech-tag">marked</span>
          </div>
        </section>
      </div>

      <div class="about-footer">
        <span class="copyright">© 2026 暮雨 · 绒花计划 (ROSA)</span>
        <span class="license">内部工具，暂无开源许可</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';

const isOpen = ref(false);

function open() {
  isOpen.value = true;
}

function close() {
  isOpen.value = false;
}

defineExpose({ open, close });
</script>

<style scoped>
.about-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(4px);
}

.about-panel {
  width: 560px;
  max-height: 80vh;
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.about-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 24px;
  border-bottom: 1px solid var(--panel-border);
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
}

.about-logo {
  display: flex;
  align-items: center;
  gap: 14px;
}

.logo-icon {
  font-size: 36px;
}

.logo-info h2 {
  font-size: 20px;
  font-weight: 700;
  color: #f0f6fc;
  margin: 0;
  line-height: 1.2;
}

.version {
  font-size: 12px;
  color: #58a6ff;
  background: rgba(88, 166, 255, 0.15);
  padding: 2px 8px;
  border-radius: var(--radius-lg);
}

.about-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}

.about-section {
  margin-bottom: 24px;
}

.about-section:last-child {
  margin-bottom: 0;
}

.about-section h3 {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 12px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--separator);
}

.description {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-tertiary);
  margin: 0;
}

.guide-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.guide-list li {
  font-size: 12px;
  color: var(--text-secondary);
  padding: 6px 0;
  padding-left: 16px;
  position: relative;
}

.guide-list li::before {
  content: '•';
  position: absolute;
  left: 0;
  color: var(--accent);
}

.guide-list li b {
  color: var(--text-primary);
}

.shortcuts-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.shortcut-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-secondary);
}

.shortcut-item kbd {
  background: var(--btn-bg);
  border: 1px solid var(--panel-border);
  padding: 2px 6px;
  border-radius: 3px;
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 10px;
  color: var(--text-primary);
  min-width: 20px;
  text-align: center;
}

.shortcut-desc {
  color: var(--text-tertiary);
}

.edit-modes {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mode-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px;
  background: var(--btn-bg);
  border-radius: var(--radius-md);
  border: 1px solid var(--panel-border);
}

.mode-icon {
  font-size: 20px;
  flex-shrink: 0;
}

.mode-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mode-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.mode-desc {
  font-size: 11px;
  color: var(--text-tertiary);
}

.data-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

.data-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
}

.data-label {
  color: var(--text-tertiary);
}

.data-path {
  color: var(--accent);
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 11px;
}

.note {
  font-size: 11px;
  color: var(--text-tertiary);
  line-height: 1.5;
  padding: 10px;
  background: var(--btn-bg);
  border-radius: var(--radius-md);
  border-left: 3px solid var(--accent);
  margin: 0;
}

.tech-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tech-tag {
  font-size: 11px;
  padding: 4px 10px;
  background: var(--accent-bg);
  color: var(--accent);
  border-radius: 14px;
}

.about-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 24px;
  border-top: 1px solid var(--separator);
  background: var(--panel-header-bg);
}

.copyright {
  font-size: 11px;
  color: var(--text-tertiary);
}

.license {
  font-size: 10px;
  color: var(--text-tertiary);
  font-style: italic;
}

.close-btn {
  background: var(--btn-bg);
  border: none;
  color: var(--text-tertiary);
  font-size: 20px;
  cursor: pointer;
  padding: 6px 10px;
  border-radius: var(--radius-md);
}

.close-btn:hover {
  background: var(--btn-bg-hover);
  color: var(--text-primary);
}
</style>
