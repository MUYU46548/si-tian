<template>
  <div v-if="isOpen" class="settings-overlay" @click.self="close">
    <div class="settings-panel">
      <div class="settings-header">
        <h2><Icon name="settings" :size="18" style="margin-right:6px"/>设置</h2>
        <button class="close-btn" @click="close">×</button>
      </div>

      <div class="settings-content">
        <!-- P0-2 / P1-4：设置分页（标签样式 / 标记类型各自一页） -->
        <div class="settings-tabs">
          <button
            v-for="t in TABS" :key="t.key"
            class="settings-tab" :class="{ active: tab === t.key }"
            :data-testid="'settings-tab-' + t.key"
            @click="tab = t.key"
          >{{ t.label }}</button>
        </div>

        <template v-if="tab === 'general'">
        <!-- 通用设置 -->
        <section class="settings-section">
          <h3>通用</h3>
          
          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">自动保存</span>
              <span class="setting-desc">编辑后自动保存到 JSON 缓存</span>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" v-model="settings.autoSave" @change="saveSettings" />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">边缘吸附</span>
              <span class="setting-desc">绘制省份时自动贴合相邻边界</span>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" v-model="settings.snapEnabled" @change="saveSettings" />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">显示编辑辅助线</span>
              <span class="setting-desc">在编辑模式下显示控制点和预览</span>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" v-model="settings.showEditHelpers" @change="saveSettings" />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">关闭时退出应用</span>
              <span class="setting-desc">关闭窗口直接退出程序（默认关闭窗口仅最小化到托盘，右键托盘可退出）</span>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" v-model="closeQuitsApp" @change="onCloseQuitsAppChange" />
              <span class="toggle-slider"></span>
            </label>
          </div>
        </section>

        <!-- 视图设置 -->
        <section class="settings-section">
          <h3>视图</h3>
          
          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">动画效果</span>
              <span class="setting-desc">启用画布动画（可能影响性能）</span>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" v-model="settings.animateCanvas" @change="saveSettings" />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">显示 FPS</span>
              <span class="setting-desc">在画布角落显示帧率统计</span>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" v-model="settings.showFPS" @change="saveSettings" />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">纹理填充</span>
              <span class="setting-desc">省份使用纹理而非纯色填充</span>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" v-model="settings.useTextures" @change="saveSettings" />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="setting-item" v-if="windowMode !== null">
            <div class="setting-info">
              <span class="setting-name">启动窗口</span>
              <span class="setting-desc">应用启动时的窗口模式（立即生效并记忆）</span>
            </div>
            <select class="setting-input window-mode-select" v-model="windowMode" @change="onWindowModeChange">
              <option value="maximized">最大化</option>
              <option value="fullscreen">全屏</option>
              <option value="default">默认 1600×900</option>
            </select>
          </div>
        </section>

        <!-- 数据设置 -->
        <section class="settings-section">
          <h3>数据</h3>
          
          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">Vault 监听</span>
              <span class="setting-desc">监听 Obsidian 文件变更自动刷新</span>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" v-model="settings.vaultWatcher" @change="saveSettings" />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">自动保存延迟</span>
              <span class="setting-desc">编辑后等待多久自动保存（毫秒）</span>
            </div>
            <input 
              type="number" 
              class="setting-input" 
              v-model.number="settings.autoSaveDelay" 
              @change="saveSettings"
              min="200" 
              max="5000" 
              step="100"
            />
          </div>
        </section>

        <!-- 快捷键参考 -->
        <section class="settings-section">
          <h3>快捷键参考</h3>
          <div class="shortcuts-list">
            <div class="shortcut-row">
              <kbd>Ctrl</kbd>+<kbd>Z</kbd>
              <span>撤销</span>
            </div>
            <div class="shortcut-row">
              <kbd>Ctrl</kbd>+<kbd>Y</kbd>
              <span>重做</span>
            </div>
            <div class="shortcut-row">
              <kbd>Ctrl</kbd>+<kbd>F</kbd>
              <span>搜索</span>
            </div>
            <div class="shortcut-row">
              <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>
              <span>搜索过滤</span>
            </div>
            <div class="shortcut-row">
              <kbd>F1</kbd>
              <span>帮助</span>
            </div>
            <div class="shortcut-row">
              <kbd>L</kbd>
              <span>图层面板</span>
            </div>
            <div class="shortcut-row">
              <kbd>Del</kbd>
              <span>删除选中</span>
            </div>
            <div class="shortcut-row">
              <kbd>Esc</kbd>
              <span>取消/关闭</span>
            </div>
            <div class="shortcut-row">
              <kbd>空格</kbd>
              <span>临时拖手</span>
            </div>
            <div class="shortcut-row">
              <kbd>/</kbd>
              <span>聚焦搜索</span>
            </div>
          </div>
        </section>

        <!-- 数据管理 -->
        <section class="settings-section">
          <h3>数据管理</h3>
          <!-- 知识库路径（2026-08-16 可配置化） -->
          <div class="setting-item">
            <div class="setting-info">
              <span class="setting-name">知识库路径</span>
              <span class="setting-desc">Obsidian 库根目录（需包含 .obsidian 文件夹），更改后自动重新提取</span>
            </div>
            <div class="vault-path-row">
              <span class="vault-path-text" :title="vaultPath">{{ vaultPath || '未设置（使用默认库）' }}</span>
              <button class="vault-btn" @click="chooseVaultPath" title="选择知识库目录"><Icon name="folder" :size="14"/> 选择</button>
            </div>
          </div>
          <div class="data-actions">
            <button class="data-btn" @click="reextractData">
              <Icon name="refresh" :size="14"/> 重新提取数据
            </button>
            <button class="data-btn" @click="validateData">
              <Icon name="search" :size="14"/> 数据完整性检查
            </button>
            <button class="data-btn" @click="backupCache" title="将 .sitian/ 缓存备份到 backups/（带时间戳，保留最近 10 批）">
              <Icon name="package" :size="14"/> 立即备份
            </button>
            <button class="data-btn" @click="openBatchImport" title="批量创建笔记（只创建不修改，已存在自动跳过）">
              <Icon name="download" :size="14"/> 批量导入
            </button>
            <button class="data-btn danger" @click="clearCache">
              <Icon name="trash" :size="14"/> 清除坐标缓存
            </button>
          </div>
        </section>

        <!-- 配置管理（对外发布打磨 P1.2）：导出 / 导入 / 恢复默认 -->
        <section class="settings-section">
          <h3>配置管理</h3>
          <div class="data-actions">
            <button class="data-btn" @click="exportSettings" title="将当前设置导出为 JSON 文件（便于备份或多机同步）">
              <Icon name="upload" :size="14"/> 导出设置
            </button>
            <button class="data-btn" @click="triggerImportSettings" title="从 JSON 文件导入设置（仅覆盖可识别的设置项）">
              <Icon name="download" :size="14"/> 导入设置
            </button>
            <button class="data-btn danger" @click="resetSettings" title="将所有设置项恢复为默认值">
              <Icon name="refresh" :size="14"/> 恢复默认设置
            </button>
            <input
              ref="settingsFileInput"
              type="file"
              accept="application/json,.json"
              class="hidden-file-input"
              @change="onSettingsFileChosen"
            />
          </div>
        </section>
        </template>

        <!-- ===== P0-2 标签样式 ===== -->
        <template v-else-if="tab === 'labels'">
          <section class="settings-section">
            <h3>标签样式预设</h3>
            <p class="setting-desc hint-block">
              所有地图视图（行星 / 区域 / 建筑内部）的标签共用这套预设；按节点层级自动匹配，
              改动即时生效并保存到 <code>.sitian/config/label-presets.json</code>。
            </p>
            <div class="preset-tabs" data-testid="label-preset-list">
              <button
                v-for="p in presetList" :key="p.key"
                class="preset-tab" :class="{ active: activeKey === p.key }"
                :data-testid="'label-preset-' + p.key"
                @click="selectPreset(p.key)"
              >{{ p.name }}<span v-if="!p.builtin" class="preset-user">自定</span></button>
            </div>
          </section>

          <section class="settings-section">
            <h3>实时预览 · {{ activePreset?.name }}</h3>
            <canvas ref="previewCanvas" class="label-preview" data-testid="label-preview" width="620" height="132"></canvas>
            <div class="setting-desc preview-caption">{{ describePreset(activePreset) }}</div>
          </section>

          <section class="settings-section">
            <h3>样式编辑</h3>
            <div class="setting-item">
              <div class="setting-info">
                <span class="setting-name">字体族</span>
                <span class="setting-desc">衬线 / 无衬线 / 等宽</span>
              </div>
              <select class="setting-input label-select" :value="activePreset?.fontFamily"
                      @change="patch('fontFamily', $event.target.value)">
                <option v-for="f in FONT_FAMILIES" :key="f.value" :value="f.value">{{ f.label }}</option>
              </select>
            </div>

            <div class="setting-item">
              <div class="setting-info">
                <span class="setting-name">字号</span>
                <span class="setting-desc">{{ activePreset?.fontSize }} px（8 – 32）</span>
              </div>
              <input type="range" class="setting-range" min="8" max="32" step="1"
                     :value="activePreset?.fontSize"
                     @input="patch('fontSize', Number($event.target.value), false)"
                     @change="patch('fontSize', Number($event.target.value))" />
            </div>

            <div class="setting-item">
              <div class="setting-info">
                <span class="setting-name">加粗</span>
                <span class="setting-desc">city 预设默认加粗</span>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" :checked="activePreset?.weight === 'bold'"
                       @change="patch('weight', $event.target.checked ? 'bold' : 'normal')" />
                <span class="toggle-slider"></span>
              </label>
            </div>

            <div class="setting-item">
              <div class="setting-info">
                <span class="setting-name">颜色</span>
                <span class="setting-desc">文字填充色</span>
              </div>
              <input type="color" class="setting-color" :value="activePreset?.color"
                     @input="patch('color', $event.target.value, false)"
                     @change="patch('color', $event.target.value)" />
            </div>

            <div class="setting-item">
              <div class="setting-info">
                <span class="setting-name">描边</span>
                <span class="setting-desc">深色描边提高对比度</span>
              </div>
              <div class="inline-controls">
                <input type="color" class="setting-color" :value="activePreset?.stroke?.color"
                       @input="patchPart('stroke', 'color', $event.target.value, false)"
                       @change="patchPart('stroke', 'color', $event.target.value)" />
                <input type="range" class="setting-range small" min="1" max="8" step="0.5"
                       :value="activePreset?.stroke?.width"
                       @input="patchPart('stroke', 'width', Number($event.target.value), false)"
                       @change="patchPart('stroke', 'width', Number($event.target.value))" />
                <label class="toggle-switch">
                  <input type="checkbox" :checked="activePreset?.stroke?.enabled"
                         @change="patchPart('stroke', 'enabled', $event.target.checked)" />
                  <span class="toggle-slider"></span>
                </label>
              </div>
            </div>

            <div class="setting-item">
              <div class="setting-info">
                <span class="setting-name">投影 / 外发光</span>
                <span class="setting-desc">城市预设默认开启外发光</span>
              </div>
              <div class="inline-controls">
                <input type="color" class="setting-color" :value="toHex(activePreset?.shadow?.color)"
                       @input="patchPart('shadow', 'color', $event.target.value, false)"
                       @change="patchPart('shadow', 'color', $event.target.value)" />
                <input type="range" class="setting-range small" min="0" max="24" step="1"
                       :value="activePreset?.shadow?.blur"
                       @input="patchPart('shadow', 'blur', Number($event.target.value), false)"
                       @change="patchPart('shadow', 'blur', Number($event.target.value))" />
                <label class="toggle-switch">
                  <input type="checkbox" :checked="activePreset?.shadow?.enabled"
                         @change="patchPart('shadow', 'enabled', $event.target.checked)" />
                  <span class="toggle-slider"></span>
                </label>
              </div>
            </div>

            <div class="setting-item">
              <div class="setting-info">
                <span class="setting-name">背景条</span>
                <span class="setting-desc">半透明底衬（region 预设默认开启）</span>
              </div>
              <div class="inline-controls">
                <input type="color" class="setting-color" :value="activePreset?.background?.color"
                       @input="patchPart('background', 'color', $event.target.value, false)"
                       @change="patchPart('background', 'color', $event.target.value)" />
                <input type="range" class="setting-range small" min="0" max="1" step="0.05"
                       :value="activePreset?.background?.opacity"
                       @input="patchPart('background', 'opacity', Number($event.target.value), false)"
                       @change="patchPart('background', 'opacity', Number($event.target.value))" />
                <label class="toggle-switch">
                  <input type="checkbox" :checked="activePreset?.background?.enabled"
                         @change="patchPart('background', 'enabled', $event.target.checked)" />
                  <span class="toggle-slider"></span>
                </label>
              </div>
            </div>

            <div class="setting-item">
              <div class="setting-info">
                <span class="setting-name">锁定屏幕像素</span>
                <span class="setting-desc">开启后缩放地图时字号不变（关闭则跟随地图坐标）</span>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" :checked="activePreset?.lockScreenSize"
                       @change="patch('lockScreenSize', $event.target.checked)" />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </section>

          <section class="settings-section">
            <h3>预设管理</h3>
            <div class="data-actions">
              <button class="data-btn" data-testid="label-save-preset" @click="saveCurrentAsPreset"
                      title="把当前样式另存为一个新预设">
                <Icon name="save" :size="14"/> 保存当前样式为预设
              </button>
              <button class="data-btn" @click="resetActivePreset" title="把选中预设恢复为内置默认样式">
                <Icon name="refresh" :size="14"/> 重置选中预设
              </button>
              <button class="data-btn" @click="exportLabelPresets" title="导出全部预设为 JSON">
                <Icon name="upload" :size="14"/> 导出预设 JSON
              </button>
              <button class="data-btn" @click="triggerImportPresets" title="从 JSON 导入预设（仅覆盖可识别字段）">
                <Icon name="download" :size="14"/> 导入预设 JSON
              </button>
              <button class="data-btn danger" @click="resetAllLabelPresets" title="全部预设恢复为内置默认">
                <Icon name="refresh" :size="14"/> 全部恢复默认
              </button>
              <input
                ref="presetFileInput"
                type="file"
                accept="application/json,.json"
                class="hidden-file-input"
                @change="onPresetFileChosen"
              />
            </div>
          </section>
        </template>

        <!-- ===== P1-4 标记类型 ===== -->
        <template v-else-if="tab === 'markers'">
          <section class="settings-section">
            <h3>标记类型</h3>
            <p class="setting-desc hint-block">
              每种类型 = 图标 + 颜色 + 名称；地图上的标记默认继承类型样式，单点覆盖优先。
              改动保存到 <code>.sitian/config/marker-types.json</code>。
            </p>
            <div class="marker-type-list" data-testid="marker-type-list">
              <div
                v-for="(t, i) in markerTypeList" :key="t.type"
                class="marker-type-row"
                :class="{ active: editingType === t.type }"
                :data-testid="'marker-type-' + t.type"
                @click="editMarkerType(t.type)"
              >
                <span class="marker-type-swatch" :style="{ background: t.color }"><Icon :name="t.icon" :size="13"/></span>
                <span class="marker-type-label">{{ t.label }}</span>
                <span v-if="t.builtin" class="marker-type-tag">内置</span>
                <span v-if="t.legacy" class="marker-type-tag legacy">旧</span>
                <span class="marker-type-ops">
                  <button class="mini-btn" title="上移" :disabled="i === 0" @click.stop="moveType(t.type, -1)">↑</button>
                  <button class="mini-btn" title="下移" :disabled="i === markerTypeList.length - 1" @click.stop="moveType(t.type, 1)">↓</button>
                  <button
                    class="mini-btn danger" title="删除类型（该类型标记会转为自定义）"
                    :disabled="t.builtin" @click.stop="deleteMarkerType(t.type)"
                  >×</button>
                </span>
              </div>
            </div>
          </section>

          <section v-if="editingTypeObj" class="settings-section">
            <h3>编辑：{{ editingTypeObj.label }}</h3>
            <div class="setting-item">
              <div class="setting-info">
                <span class="setting-name">名称</span>
                <span class="setting-desc">type 键：{{ editingTypeObj.type }}</span>
              </div>
              <input class="setting-input marker-name-input" :value="editingTypeObj.label"
                     @change="updateType({ label: $event.target.value })" />
            </div>
            <div class="setting-item">
              <div class="setting-info">
                <span class="setting-name">颜色</span>
                <span class="setting-desc">该类型标记的默认颜色</span>
              </div>
              <div class="inline-controls">
                <input type="color" class="setting-color" :value="editingTypeObj.color"
                       @input="updateType({ color: $event.target.value }, false)"
                       @change="updateType({ color: $event.target.value })" />
              </div>
            </div>
            <div class="setting-item">
              <div class="setting-info">
                <span class="setting-name">图标</span>
                <span class="setting-desc">从内置图标库中选（Icon.vue 已定义的名称）</span>
              </div>
            </div>
            <div class="icon-picker" data-testid="marker-icon-picker">
              <button
                v-for="ic in ICON_POOL" :key="ic"
                class="icon-pick" :class="{ active: editingTypeObj.icon === ic }"
                :data-testid="'marker-icon-' + ic"
                @click="updateType({ icon: ic })"
              ><Icon :name="ic" :size="14"/></button>
            </div>
          </section>

          <section class="settings-section">
            <h3>类型管理</h3>
            <div class="data-actions">
              <button class="data-btn" data-testid="marker-type-add" @click="addType" title="新建一个自定义标记类型">
                <Icon name="plus" :size="14"/> 新建类型
              </button>
              <button class="data-btn" @click="exportTypes" title="导出全部类型为 JSON">
                <Icon name="upload" :size="14"/> 导出类型 JSON
              </button>
              <button class="data-btn" @click="triggerImportTypes" title="从 JSON 导入类型">
                <Icon name="download" :size="14"/> 导入类型 JSON
              </button>
              <button class="data-btn danger" @click="resetTypes" title="全部类型恢复为内置默认">
                <Icon name="refresh" :size="14"/> 恢复默认类型
              </button>
              <input
                ref="typeFileInput"
                type="file"
                accept="application/json,.json"
                class="hidden-file-input"
                @change="onTypeFileChosen"
              />
            </div>
          </section>
        </template>
      </div>

      <div class="settings-footer">
        <span>设置自动保存到本地</span>
        <span class="settings-version" :title="appPlatform ? ('平台：' + appPlatform) : ''">SiTian v{{ appVersion }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import Icon from './Icon.vue';
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import {
  labelPresets, getPreset, updatePreset, resetAllPresets, removePreset,
  saveAsPreset, exportPresets, importPresets, describePreset,
  drawStyledLabel, FONT_FAMILIES, BUILTIN_PRESETS, PRESET_KEYS,
} from '../utils/labelStyles';
import {
  markerTypes, MARKER_ICON_POOL, addMarkerType, updateMarkerType as updateMarkerTypeDef,
  removeMarkerType, moveMarkerType, resetMarkerTypes, resolveMarkerType,
  exportMarkerTypes, importMarkerTypes,
} from '../utils/markerTypes';
import { useGeodataStore } from '../store/geodata';

const isOpen = ref(false);

// ===== 分页（P0-2 标签样式 / P1-4 标记类型）=====
const TABS = [
  { key: 'general', label: '通用' },
  { key: 'labels', label: '标签样式' },
  { key: 'markers', label: '标记类型' },
];
const tab = ref('general');

// ===== P0-2 标签样式 =====
const activeKey = ref('city');
const previewCanvas = ref(null);
const presetFileInput = ref(null);

/** 预设列表：内置 6 个 + 用户自建（按插入顺序） */
const presetList = computed(() =>
  Object.values(labelPresets.value).map(p => ({ key: p.key, name: p.name, builtin: !!BUILTIN_PRESETS[p.key] })));

const activePreset = computed(() => getPreset(activeKey.value));

function selectPreset(key) {
  activeKey.value = key;
  nextTick(renderPreview);
}

function patch(prop, value, persist = true) {
  updatePreset(activeKey.value, { [prop]: value }, { persist });
  renderPreview();
}

function patchPart(part, prop, value, persist = true) {
  updatePreset(activeKey.value, { [part]: { [prop]: value } }, { persist });
  renderPreview();
}

/** color input 不接受 rgba() → 取 #rrggbb，取不到就用兜底色 */
function toHex(color) {
  const s = String(color || '');
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  return '#000000';
}

function renderPreview() {
  const c = previewCanvas.value;
  if (!c) return;
  const ctx = c.getContext('2d');
  const W = c.width;
  const H = c.height;
  // 模拟行星地图深色底
  ctx.fillStyle = '#1a2a3a';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

  const style = activePreset.value;
  if (!style) return;
  const samples = [
    { text: '乐园星港', y: 40, k: 1 },
    { text: '丰竹镇', y: 84, k: 0.85 },
    { text: '小村', y: 118, k: 0.7 },
  ];
  for (const s of samples) {
    const st = { ...style, fontSize: Math.max(8, style.fontSize * s.k), lockScreenSize: false };
    drawStyledLabel(ctx, s.text, W / 2, s.y, st, { align: 'center', baseline: 'middle', screenScale: 1 });
  }
}

function saveCurrentAsPreset() {
  const name = window.prompt('新预设名称', `${activePreset.value?.name || '自定义'} 副本`);
  if (!name) return;
  const created = saveAsPreset(name, activePreset.value);
  activeKey.value = created.key;
  nextTick(renderPreview);
  alert(`已保存预设「${created.name}」`);
}

function resetActivePreset() {
  if (!confirm('把选中预设恢复为内置默认样式？')) return;
  removePreset(activeKey.value);
  nextTick(renderPreview);
}

function resetAllLabelPresets() {
  if (!confirm('全部标签预设恢复为内置默认？')) return;
  resetAllPresets();
  activeKey.value = 'city';
  nextTick(renderPreview);
}

function exportLabelPresets() {
  const payload = exportPresets();
  const name = `sitian-label-presets-${new Date().toISOString().slice(0, 10)}.json`;
  try {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    alert('导出预设失败：' + e.message);
  }
}

function triggerImportPresets() {
  presetFileInput.value?.click();
}

async function onPresetFileChosen(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    const keys = importPresets(raw);
    if (keys.length && !keys.includes(activeKey.value)) activeKey.value = keys[0];
    nextTick(renderPreview);
    alert(`已导入 ${keys.length} 个预设`);
  } catch (e) {
    alert('导入预设失败：' + e.message);
  }
}

// 预设全局变化（本地编辑除外，如导入/外部改动）→ 预览跟随
watch(labelPresets, () => { nextTick(renderPreview); }, { deep: true });
watch(tab, () => { if (tab.value === 'labels') nextTick(renderPreview); });

// ===== P1-4 标记类型 =====
const editingType = ref('interest');
const typeFileInput = ref(null);
const ICON_POOL = MARKER_ICON_POOL;

const markerTypeList = computed(() => markerTypes.value);
const editingTypeObj = computed(() => resolveMarkerType(editingType.value));

function editMarkerType(type) {
  editingType.value = type;
}

function updateType(patch, persist = true) {
  if (!editingType.value) return;
  if (persist) updateMarkerTypeDef(editingType.value, patch);
  else {
    // 拖动滑块/取色器过程中先内存生效（不落盘），松手再落盘
    markerTypes.value = markerTypes.value.map(t =>
      t.type === editingType.value ? { ...t, ...patch } : t);
  }
}

function addType() {
  const label = window.prompt('新标记类型名称', '新类型');
  if (!label) return;
  const created = addMarkerType({ label, icon: 'map-pin', color: '#95A5A6' });
  editingType.value = created.type;
}

function moveType(type, delta) {
  moveMarkerType(type, delta);
}

function deleteMarkerType(type) {
  const t = resolveMarkerType(type);
  if (t.builtin) {
    alert('内置类型不可删除（可以改名/改色/换图标）');
    return;
  }
  if (!confirm(`删除类型「${t.label}」？该类型下的标记会自动转为「自定义」类型。`)) return;
  // 先把引用该类型的标记转为 custom（避免出现悬空 type）
  const store = window.__sitianStore;
  if (store?.mapData) {
    for (const pid of Object.keys(store.mapData)) {
      for (const m of (store.mapData[pid]?.markers || [])) {
        if (m.type === type) store.updateMarker(pid, m.id, { type: 'custom' });
      }
    }
  }
  const res = removeMarkerType(type);
  if (!res.removed) { alert(res.reason || '删除失败'); return; }
  if (editingType.value === type) editingType.value = 'interest';
}

function exportTypes() {
  const payload = exportMarkerTypes();
  const name = `sitian-marker-types-${new Date().toISOString().slice(0, 10)}.json`;
  try {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    alert('导出类型失败：' + e.message);
  }
}

function triggerImportTypes() { typeFileInput.value?.click(); }

async function onTypeFileChosen(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    const n = importMarkerTypes(raw);
    alert(`已导入，当前共 ${n} 个类型`);
  } catch (e) {
    alert('导入类型失败：' + e.message);
  }
}

function resetTypes() {
  if (!confirm('全部标记类型恢复为内置默认？自定义类型会被清除。')) return;
  resetMarkerTypes();
  editingType.value = 'interest';
}


// 窗口启动模式（批次A7）：null = 当前环境无 sitianAPI（纯浏览器 dev），隐藏该选项
const windowMode = ref(null);
// 关闭行为（批次A12）：点 × 直接退出应用
const closeQuitsApp = ref(false);

// 默认设置（对外发布打磨 P1.2）：「恢复默认设置」与「导入校验」的单一事实来源
const DEFAULT_SETTINGS = Object.freeze({
  autoSave: true,
  snapEnabled: true,
  showEditHelpers: true,
  animateCanvas: true,
  showFPS: false,
  useTextures: true,
  vaultWatcher: true,
  autoSaveDelay: 800,
});

const settings = ref({ ...DEFAULT_SETTINGS });

// 版本号 / 平台（设置面板展示 + 导出文件元信息）
const appVersion = ref('开发版');
const appPlatform = ref('');
const settingsFileInput = ref(null);

function loadVersion() {
  appVersion.value = window.sitianAPI?.version || '开发版';
  appPlatform.value = window.sitianAPI?.platform || '';
}

// 通知订阅方重新读取设置（如画布动画/FPS 开关）
function notifySettingsChanged() {
  window.dispatchEvent(new CustomEvent('sitian:settings-changed', { detail: { ...settings.value } }));
}

function open() {
  isOpen.value = true;
  loadSettings();
  loadWindowMode();
  loadCloseQuitsApp();
  loadVersion();
  nextTick(renderPreview);
}

function close() {
  isOpen.value = false;
}

function loadSettings() {
  try {
    const saved = localStorage.getItem('sitian-settings');
    if (saved) {
      Object.assign(settings.value, JSON.parse(saved));
    }
  } catch (e) {
    console.warn('Failed to load settings:', e);
  }
}

function saveSettings() {
  try {
    localStorage.setItem('sitian-settings', JSON.stringify(settings.value));
  } catch (e) {
    console.warn('Failed to save settings:', e);
  }
}

async function loadWindowMode() {
  try {
    windowMode.value = await window.sitianAPI.getWindowMode();
  } catch (e) {
    windowMode.value = null;
  }
}

async function onWindowModeChange() {
  try {
    await window.sitianAPI.setWindowMode(windowMode.value);
  } catch (e) {
    console.warn('Failed to set window mode:', e);
  }
}

// 关闭行为（批次A12）：读取 / 切换「点 × 直接退出应用」
async function loadCloseQuitsApp() {
  try {
    closeQuitsApp.value = await window.sitianAPI.getCloseQuitsApp();
  } catch (e) {
    closeQuitsApp.value = false;
  }
}

async function onCloseQuitsAppChange() {
  try {
    await window.sitianAPI.setCloseQuitsApp(closeQuitsApp.value);
  } catch (e) {
    console.warn('Failed to set close-quits-app:', e);
  }
}

function reextractData() {
  window.dispatchEvent(new CustomEvent('sitian:reextract'));
}

// ===== 知识库路径（2026-08-16 可配置化） =====
const vaultPath = ref('');

async function loadVaultPath() {
  try {
    const res = await window.sitianAPI.getVaultPath();
    if (typeof res === 'string') vaultPath.value = res;
  } catch (e) { /* 浏览器环境忽略 */ }
}

async function chooseVaultPath() {
  try {
    const result = await window.sitianAPI.selectVaultPath();
    if (result?.success) {
      vaultPath.value = result.path;
      // 库路径已变更 → 重新提取数据
      window.dispatchEvent(new CustomEvent('sitian:reextract'));
      setTimeout(() => alert('知识库路径已更新，数据已重新提取'), 300);
    } else if (result?.error) {
      alert(result.error);
    }
  } catch (e) {
    alert('选择知识库失败：' + e.message);
  }
}

function validateData() {
  window.dispatchEvent(new CustomEvent('sitian:validate-data'));
}

function backupCache() {
  window.dispatchEvent(new CustomEvent('sitian:backup-cache'));
}

function openBatchImport() {
  window.dispatchEvent(new CustomEvent('sitian:open-batch-import'));
}

function clearCache() {
  if (confirm('确定要清除坐标缓存吗？下次启动将自动从 Obsidian 重新提取。')) {
    window.dispatchEvent(new CustomEvent('sitian:clear-cache'));
  }
}

// ===== 配置管理（对外发布打磨 P1.2）：导出 / 导入 / 恢复默认 =====
function exportSettings() {
  const payload = {
    app: 'SiTian',
    type: 'settings',
    schema: 1,
    version: appVersion.value,
    exportedAt: new Date().toISOString(),
    settings: { ...settings.value },
  };
  const ts = new Date().toISOString().slice(0, 10);
  const name = `sitian-settings-${ts}.json`;
  try {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    alert('导出设置失败：' + e.message);
  }
}

function triggerImportSettings() {
  settingsFileInput.value?.click();
}

// 只接受已知字段且类型一致的值，避免导入脏数据破坏设置结构
function applyImportedSettings(incoming) {
  const applied = [];
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!Object.prototype.hasOwnProperty.call(incoming, key)) continue;
    const val = incoming[key];
    if (typeof val !== typeof DEFAULT_SETTINGS[key]) continue;
    settings.value[key] = val;
    applied.push(key);
  }
  return applied;
}

async function onSettingsFileChosen(event) {
  const file = event.target.files?.[0];
  event.target.value = ''; // 允许重复选择同一文件
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    const incoming = raw && typeof raw === 'object' && raw.settings && typeof raw.settings === 'object'
      ? raw.settings
      : raw;
    if (!incoming || typeof incoming !== 'object') throw new Error('不是有效的设置文件');
    const applied = applyImportedSettings(incoming);
    if (!applied.length) throw new Error('未找到可识别的设置项');
    saveSettings();
    notifySettingsChanged();
    alert(`已导入 ${applied.length} 项设置`);
  } catch (e) {
    alert('导入设置失败：' + e.message);
  }
}

function resetSettings() {
  if (!confirm('确定要恢复默认设置吗？当前所有设置项都会被重置。')) return;
  Object.assign(settings.value, DEFAULT_SETTINGS);
  saveSettings();
  notifySettingsChanged();
}

onMounted(() => {
  loadSettings();
  loadVaultPath();
  loadVersion();
  nextTick(renderPreview);
});

defineExpose({ open, close });
</script>

<style scoped>
.settings-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(4px);
}

.settings-panel {
  width: 480px;
  max-height: 80vh;
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.settings-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 18px 24px;
  border-bottom: 1px solid var(--panel-border);
  background: var(--panel-header-bg);
}

.settings-header h2 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px 24px;
}

/* ===== 分页（P0-2 / P1-4）===== */
.settings-tabs {
  display: flex;
  gap: 4px;
  margin: -4px 0 14px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--separator);
}
.settings-tab {
  padding: 5px 12px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  color: var(--text-tertiary);
  font-size: 12px;
  cursor: pointer;
}
.settings-tab:hover {
  color: var(--text-primary);
  background: var(--btn-bg);
}
.settings-tab.active {
  color: var(--text-primary);
  background: var(--btn-bg-hover);
  border-color: var(--accent);
  font-weight: 600;
}

/* ===== P0-2 标签样式页 ===== */
.hint-block {
  margin: 0 0 10px;
  line-height: 1.55;
}
.hint-block code {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 10.5px;
  background: var(--input-bg);
  padding: 1px 4px;
  border-radius: 3px;
}
.preset-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.preset-tab {
  padding: 5px 10px;
  background: var(--btn-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.preset-tab:hover {
  background: var(--btn-bg-hover);
  color: var(--text-primary);
}
.preset-tab.active {
  border-color: var(--accent);
  color: var(--text-primary);
  font-weight: 600;
}
.preset-user {
  margin-left: 4px;
  font-size: 9.5px;
  color: var(--accent);
}
.label-preview {
  display: block;
  width: 100%;
  height: auto;
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-sm);
}
.preview-caption {
  margin-top: 6px;
  font-variant-numeric: tabular-nums;
}
.label-select {
  width: 130px;
  text-align: left;
  cursor: pointer;
}
.setting-range {
  width: 120px;
  accent-color: var(--accent);
}
.setting-range.small {
  width: 74px;
}
.setting-color {
  width: 34px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--input-border);
  border-radius: var(--radius-sm);
  background: var(--input-bg);
  cursor: pointer;
}
.inline-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.inline-controls .toggle-switch {
  margin-left: 0;
}

/* ===== P1-4 标记类型页 ===== */
.marker-type-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 220px;
  overflow-y: auto;
}
.marker-type-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-sm);
  background: var(--btn-bg);
  cursor: pointer;
}
.marker-type-row:hover {
  background: var(--btn-bg-hover);
}
.marker-type-row.active {
  border-color: var(--accent);
}
.marker-type-swatch {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: #fff;
  flex-shrink: 0;
}
.marker-type-label {
  flex: 1;
  font-size: 12px;
  color: var(--text-primary);
}
.marker-type-tag {
  font-size: 9.5px;
  color: var(--text-tertiary);
  border: 1px solid var(--panel-border);
  border-radius: 3px;
  padding: 0 4px;
}
.marker-type-tag.legacy {
  color: #d29922;
  border-color: #d2992255;
}
.marker-type-ops {
  display: flex;
  gap: 2px;
}
.mini-btn {
  width: 20px;
  height: 20px;
  padding: 0;
  font-size: 11px;
  line-height: 1;
  background: transparent;
  border: 1px solid var(--panel-border);
  border-radius: 3px;
  color: var(--text-secondary);
  cursor: pointer;
}
.mini-btn:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--btn-bg-hover);
}
.mini-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.mini-btn.danger:hover:not(:disabled) {
  color: #f85149;
  border-color: #f85149;
}
.marker-name-input {
  width: 130px;
  text-align: left;
}
.icon-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 0 2px;
}
.icon-pick {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--btn-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
}
.icon-pick:hover {
  color: var(--text-primary);
  background: var(--btn-bg-hover);
}
.icon-pick.active {
  border-color: var(--accent);
  color: var(--accent);
}

.settings-section {
  margin-bottom: 20px;
}

.settings-section h3 {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 0 0 12px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--separator);
}

.setting-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid var(--separator);
}

.setting-item:last-child {
  border-bottom: none;
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}

.setting-name {
  font-size: 12px;
  color: var(--text-primary);
  font-weight: 500;
}

.setting-desc {
  font-size: 11px;
  color: var(--text-tertiary);
}

/* Toggle Switch */
.toggle-switch {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  flex-shrink: 0;
  margin-left: 12px;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background: var(--btn-bg-hover);
  border-radius: var(--radius-lg);
  transition: 0.2s;
}

.toggle-slider::before {
  content: '';
  position: absolute;
  height: 16px;
  width: 16px;
  left: 2px;
  bottom: 2px;
  background: var(--text-tertiary);
  border-radius: 50%;
  transition: 0.2s;
}

input:checked + .toggle-slider {
  background: #238636;
}

input:checked + .toggle-slider::before {
  transform: translateX(16px);
  background: var(--text-primary);
}

.setting-input {
  width: 80px;
  padding: 4px 8px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 12px;
  text-align: center;
}

.setting-input:focus {
  outline: none;
  border-color: var(--accent);
}

/* 窗口模式下拉（批次A7）：选项文案较长，放宽并左对齐 */
.window-mode-select {
  width: 130px;
  text-align: left;
  cursor: pointer;
}

.shortcuts-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.shortcut-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-secondary);
}

.shortcut-row kbd {
  background: var(--btn-bg);
  border: 1px solid var(--panel-border);
  padding: 2px 5px;
  border-radius: 3px;
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 10px;
  color: var(--text-primary);
}

.data-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 知识库路径（2026-08-16 可配置化） */
.vault-path-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.vault-path-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-tertiary);
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
}
.vault-btn {
  padding: 6px 12px;
  background: var(--btn-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
}
.vault-btn:hover {
  background: var(--btn-bg-hover);
}

.data-btn {
  padding: 10px 14px;
  background: var(--btn-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 12px;
  text-align: left;
  transition: background 0.1s ease;
}

.data-btn:hover {
  background: var(--btn-bg-hover);
}

.data-btn.danger {
  border-color: #f8514944;
}

.data-btn.danger:hover {
  background: #f8514922;
  border-color: #f85149;
}

.settings-footer {
  padding: 12px 24px;
  border-top: 1px solid var(--separator);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.settings-footer span {
  font-size: 10px;
  color: var(--text-tertiary);
}

.settings-version {
  font-family: 'SFMono-Regular', Consolas, monospace;
  letter-spacing: 0.02em;
}

.hidden-file-input {
  display: none;
}

.close-btn {
  background: var(--btn-bg);
  border: none;
  color: var(--text-tertiary);
  font-size: 18px;
  cursor: pointer;
  padding: 6px 10px;
  border-radius: var(--radius-md);
}

.close-btn:hover {
  background: var(--btn-bg-hover);
  color: var(--text-primary);
}
</style>
