<template>
  <div class="app-layout" :class="`theme-${currentTheme}`">
    <header class="toolbar">
      <h1>SiTian</h1>
      <div class="toolbar-center">
        <search-bar ref="searchBar" />
      </div>
      <div class="toolbar-actions">
        <nav class="level-indicator">
          <!-- 世界（下拉选择） -->
          <div class="breadcrumb-item">
            <button 
              :class="{ active: store.viewLevel === 'world' }" 
              @click="store.backToWorld()"
            >世界</button>
            <span class="dropdown-arrow" @click.stop="toggleDropdown('world')">▾</span>
            <div v-if="dropdowns.world" class="dropdown-menu" @click.stop>
              <div 
                v-for="w in store.worlds" 
                :key="w.id" 
                :class="{ current: w.id === store.currentWorld?.id }"
                @click="store.selectWorld(w); dropdowns.world = false"
              >{{ w.displayName || w.name }}</div>
            </div>
          </div>
          
          <!-- 星域（世界名） -->
          <template v-if="store.currentWorld">
            <span class="separator">›</span>
            <div class="breadcrumb-item">
              <button 
                :class="{ active: store.viewLevel === 'domain' }"
                @click="store.backToDomain()"
              >{{ store.currentWorld?.displayName || store.currentWorld?.name }}</button>
              <span class="dropdown-arrow" @click.stop="toggleDropdown('domain')">▾</span>
              <div v-if="dropdowns.domain" class="dropdown-menu" @click.stop>
                <div 
                  v-for="d in store.currentWorldDomains" 
                  :key="d.id" 
                  :class="{ current: d.id === store.currentDomain?.id }"
                  @click="store.selectDomain(d); dropdowns.domain = false"
                >{{ d.displayName || d.name }}</div>
              </div>
            </div>
          </template>
          
          <!-- 恒星系（域名） -->
          <template v-if="store.currentDomain && (store.viewLevel === 'system' || store.viewLevel === 'system_detail' || store.viewLevel === 'planet' || store.viewLevel === 'area' || store.viewLevel === 'interior')">
            <span class="separator">›</span>
            <div class="breadcrumb-item">
              <button 
                :class="{ active: store.viewLevel === 'system' }"
                @click="handleBreadcrumbDomain"
                :title="store.viewLevel === 'planet' ? '返回域内恒星系总览' : ''"
              >{{ store.currentDomain?.displayName || store.currentDomain?.name }}</button>
              <span class="dropdown-arrow" @click.stop="toggleDropdown('system')">▾</span>
              <div v-if="dropdowns.system" class="dropdown-menu" @click.stop>
                <div 
                  v-for="g in store.currentDomainGalaxies" 
                  :key="g.id" 
                  :class="{ current: g.id === store.currentSystem?.id }"
                  @click="store.selectSystem(g); dropdowns.system = false"
                >{{ g.displayName || g.name }}</div>
              </div>
            </div>
          </template>
          
          <!-- 恒星系（单系地图，B4） -->
          <template v-if="store.currentSystem && (store.viewLevel === 'system_detail' || store.viewLevel === 'planet' || store.viewLevel === 'area' || store.viewLevel === 'interior')">
            <span class="separator">›</span>
            <div class="breadcrumb-item">
              <button 
                :class="{ active: store.viewLevel === 'system_detail' }"
                @click="handleBreadcrumbSystem"
                :title="store.viewLevel !== 'system_detail' ? '返回该恒星系地图' : ''"
              >{{ store.currentSystem?.displayName || store.currentSystem?.name }}</button>
              <span class="dropdown-arrow" @click.stop="toggleDropdown('systemDetail')">▾</span>
              <div v-if="dropdowns.systemDetail" class="dropdown-menu" @click.stop>
                <div 
                  v-for="g in store.currentDomainGalaxies" 
                  :key="g.id" 
                  :class="{ current: g.id === store.currentSystem?.id }"
                  @click="store.selectSystem(g); dropdowns.systemDetail = false"
                >{{ g.displayName || g.name }}</div>
              </div>
            </div>
          </template>
          
          <!-- 行星 -->
          <template v-if="store.currentPlanet">
            <span class="separator">›</span>
            <div class="breadcrumb-item">
              <button 
                :class="{ active: store.viewLevel === 'planet' }"
                @click="store.backToPlanet"
              >{{ store.currentPlanet?.displayName || store.currentPlanet?.name }}</button>
              <span class="dropdown-arrow" @click.stop="toggleDropdown('planet')">▾</span>
              <div v-if="dropdowns.planet" class="dropdown-menu" @click.stop>
                <div 
                  v-for="p in store.currentSystemPlanets" 
                  :key="p.id" 
                  :class="{ current: p.id === store.currentPlanet?.id }"
                  @click="store.selectPlanet(p); dropdowns.planet = false"
                >{{ p.displayName || p.name }}</div>
              </div>
            </div>
          </template>
          
          <!-- 区域 -->
          <template v-if="store.currentArea">
            <span class="separator">›</span>
            <div class="breadcrumb-item">
              <button 
                :class="{ active: store.viewLevel === 'area' }"
                @click="store.backToArea"
              >{{ store.currentArea?.displayName || store.currentArea?.name }}</button>
              <span class="dropdown-arrow" @click.stop="toggleDropdown('area')">▾</span>
              <div v-if="dropdowns.area" class="dropdown-menu" @click.stop>
                <div 
                  v-for="a in store.currentPlanetPlaces" 
                  :key="a.id" 
                  :class="{ current: a.id === store.currentArea?.id }"
                  @click="store.selectArea(a); dropdowns.area = false"
                >{{ a.displayName || a.name }}</div>
              </div>
            </div>
          </template>
          
          <!-- 建筑 -->
          <template v-if="store.currentBuilding">
            <span class="separator">›</span>
            <button class="active">{{ store.currentBuilding?.displayName || store.currentBuilding?.name }}</button>
          </template>
        </nav>
        <span class="toolbar-divider"></span>
        <button @click="store.undo" :disabled="!store.canUndo" :title="undoTooltip">↶</button>
        <button @click="store.redo" :disabled="!store.canRedo" title="重做 (Ctrl+Y)">↷</button>
        <button v-if="store.viewLevel !== 'world'" @click="panelsStore.toggle('history')" :class="{ active: panelsStore.isOpen('history') }" title="撤销历史面板 (E2)"><Icon name="history" :size="15"/></button>
        <button @click="reextract" :disabled="!canReextract" :title="reextractTitle"><Icon name="refresh" :size="15"/></button>
        <button @click="saveData" :disabled="!dirty || isReadOnly" title="保存"><Icon name="save" :size="15"/></button>
        <button @click="panelsStore.toggle('project')" :class="{ active: panelsStore.isOpen('project') }" title="项目（.sitian 项目文件）"><Icon name="folder-open" :size="15"/></button>
        <button @click="panelsStore.toggle('git-sync')" :class="{ active: panelsStore.isOpen('git-sync') }" title="同步到远程仓库（一键推送到你自己的 git 仓库）"><Icon name="cloud" :size="15"/></button>
        <button @click="openVaultFromToolbar" :title="vaultButtonTitle"><Icon name="book" :size="15"/></button>
        <!-- 只读徽标（决策 1 终态）：状态栏只在画布视图出现，世界/选择视图必须靠这里常驻提示，
             否则用户只会在「点了没反应」时才发现自己处于只读（点它直接去项目面板 = 给出去处）。 -->
        <button
          v-if="isReadOnly"
          class="readonly-badge"
          :title="readonlyTitle"
          @click="panelsStore.toggle('project')"
        >{{ READONLY_BADGE }}</button>
        <span class="toolbar-divider"></span>
        <button v-if="store.viewLevel !== 'world'" @click="toggleLayersPanel" title="图层面板 (L)" :class="{ active: layersStore.panelOpen }"><Icon name="layers" :size="15"/></button>
        <button v-if="store.viewLevel !== 'world'" @click="panelsStore.toggle('bookmarks')" title="视口书签" :class="{ active: panelsStore.isOpen('bookmarks') }"><Icon name="bookmark" :size="15"/></button>
        <span class="toolbar-divider"></span>
        <button @click="panelsStore.toggle('export')" title="导出"><Icon name="export" :size="15"/></button>
        <span class="toolbar-divider"></span>
        <button @click="settingsPanelRef?.open()" title="设置"><Icon name="settings" :size="15"/></button>
        <button @click="aboutPanelRef?.open()" title="帮助 (F1)">?</button>
        <button @click="keyboardShortcutsRef?.open()" title="快捷键 (Ctrl+?)"><Icon name="keyboard" :size="15"/></button>
        <button @click="changeLogRef?.open()" title="变更日志"><Icon name="clipboard" :size="15"/></button>
        <button @click="validateDataIntegrity" title="数据检查"><Icon name="search" :size="15"/></button>
        <button @click="toggleTheme" :title="`切换到${currentTheme === 'dark' ? '亮色' : '暗色'}主题`"><Icon :name="currentTheme === 'dark' ? 'moon' : 'sun'" :size="15"/></button>
        <span class="status"><Icon v-if="statusKind === 'ok'" name="check-circle" :size="12" style="margin-right:4px"/><Icon v-else-if="statusKind === 'err'" name="x-circle" :size="12" style="margin-right:4px"/><Icon v-else-if="statusKind === 'warn'" name="info" :size="12" style="margin-right:4px"/>{{ statusText }}</span>
      </div>
    </header>

    <!-- 只读态常驻提示条（用户实测反馈 2026-09-22）：
         「进入只读后除顶部小字外无任何提示，按钮却像能点」→ 顶部小徽标不够，
         这里给一条**全宽、大字、可点**的横幅（只在只读态渲染，是文档流内的元素，
         因此不会像绝对定位那样压住任何视图自己的按钮）。
         文案三段式：现状（只读·未打开项目）+ 影响（编辑与保存已停用）+ 去处（点它去项目面板）。 -->
    <div
      v-if="isReadOnly"
      class="readonly-notice"
      role="status"
      data-testid="readonly-notice"
      :title="readonlyTitle"
      @click="panelsStore.toggle('project')"
    >
      <Icon name="lock" :size="16" />
      <span class="rn-main">只读模式 · 未打开项目 —— 编辑与保存已停用</span>
      <span class="rn-sub">当前画布内容读自知识库，不会被改动；打开或新建项目后即可继续编辑</span>
      <span class="rn-go">去项目面板 →</span>
    </div>

    <!-- 导出菜单 -->
    <div v-if="panelsStore.isOpen('export')" class="export-menu" @click.self="panelsStore.close('export')">
      <!-- ⚠️ 「当前视图」整图导出只在 galaxy / system / system_detail 三层可用（PlanetMap 与
           ScenarioMap 各有自己的导出工具栏）。不可用时**置灰 + 说明去处**，而不是点了静默 return
           —— 用户实测「点了没反应」（2026-09-24 修）。 -->
      <button :disabled="!viewExportSupported" :title="viewExportSupported ? '' : VIEW_EXPORT_HINT"
              @click="handleExportPNG">导出 PNG (当前视图)</button>
      <button :disabled="!viewExportSupported"
              :title="viewExportSupported ? '位图封装成的 SVG（非矢量，不能进 Illustrator 二次编辑）' : VIEW_EXPORT_HINT"
              @click="handleExportSVG">导出 SVG (当前视图，位图封装)</button>
      <button @click="handleExportFullPNG">导出 PNG (全图)</button>
      <div class="export-divider"></div>
      <button @click="handleExportMapConfig">导出地图配置 (JSON)</button>
      <button @click="handleImportMapConfig">导入地图配置...</button>
      <template v-if="store.viewLevel === 'planet'">
        <div class="export-divider"></div>
        <button @click="handleExportGeoJSON">导出 GeoJSON (当前行星)</button>
        <button @click="handleImportGeoJSON">导入 GeoJSON...</button>
      </template>
    </div>
    
    <div class="app-body">
      <tree-navigation />
      <main class="main-content">
        <world-selector
          v-if="store.viewLevel === 'world' && !scenarioMode"
          :worlds="store.worlds"
          :domains="store.starDomains"
          :galaxies="store.galaxies"
          :planets="store.planets"
          :locations="store.locations"
          :read-only="isReadOnly"
          :read-only-hint="readonlyTitle"
          :project-open="canvasIsProject"
          @select="store.selectWorld"
          @create-world="handleCreateWorld"
          @delete-world="handleDeleteWorld"
          @reextract="reextract"
          @open-vault="openVaultFromToolbar"
          @import-from-vault="doImportFromVault"
          @load-sample="handleLoadSampleWorld"
          @open-scenarios="enterScenarioMode"
          @create-project="handleCreateProject"
          @open-project="handleOpenProject"
        />

        <scenario-map
          v-if="scenarioMode"
          @exit="exitScenarioMode"
        />
        
        <galaxy-map
          v-if="store.viewLevel === 'domain'"
          ref="galaxyMapRef"
          :world="store.currentWorld"
          :domains="store.currentWorldDomains"
          :galaxies="store.galaxies"
          @select="store.selectDomain"
          @enter-system="store.enterSystemDetail"
          @back="store.backToWorld"
          @dirty="dirty = true"
          @select-node="store.selectNode"
        />
        
        <system-view
          v-if="store.viewLevel === 'system'"
          ref="systemViewRef"
          :domain="store.currentDomain"
          :systems="store.currentDomainGalaxies"
          :planets="store.planets"
          :locations="store.locations"
          @back="store.backToDomain"
          @select-node="store.selectPlanetOrNode"
        />
        
        <system-detail-view
          v-if="store.viewLevel === 'system_detail'"
          ref="systemDetailRef"
          :system="store.currentSystem"
          @back="store.backToDomain"
          @select-node="store.selectPlanetOrNode"
          @dirty="dirty = true"
        />
        
        <planet-map
          v-if="store.viewLevel === 'planet'"
          ref="planetMapRef"
          :planet="store.currentPlanet"
          @back="handlePlanetBack"
          @select-node="store.selectNode"
          @dirty="dirty = true"
        />
        
        <area-map
          v-if="store.viewLevel === 'area'"
          ref="areaMapRef"
          :area-node="store.currentArea"
          @back="store.backToPlanet"
          @select-node="store.selectNode"
          @dirty="dirty = true"
        />
        
        <interior-view
          v-if="store.viewLevel === 'interior'"
          ref="interiorViewRef"
          :building-node="store.currentBuilding"
        />
      </main>
    </div>

    <status-bar />

    <node-detail-panel />
    <layer-panel />
    <history-panel v-if="panelsStore.isOpen('history')" @close="panelsStore.close('history')" />
    <project-panel v-if="panelsStore.isOpen('project')" @close="panelsStore.close('project')" />
    <git-sync-panel
      v-if="panelsStore.isOpen('git-sync')"
      @close="panelsStore.close('git-sync')"
      @open-project="openProjectFromSync"
    />
    <about-panel ref="aboutPanelRef" />
    <batch-import-panel ref="batchImportPanelRef" />
    <settings-panel ref="settingsPanelRef" />
    <onboarding-guide ref="onboardingGuideRef" />
    <recovery-panel />
    <keyboard-shortcuts ref="keyboardShortcutsRef" />
    <change-log ref="changeLogRef" />
    <update-notification ref="updateNotificationRef" />
    <prompt-dialog />
    <bookmark-panel
      v-if="panelsStore.isOpen('bookmarks')"
      :bookmarks="bookmarks"
      :current-index="currentIndex"
      :current-level="store.viewLevel"
      @close="panelsStore.close('bookmarks')"
      @navigate="handleBookmarkNavigate"
      @add="handleAddBookmark"
      @remove="handleRemoveBookmark"
      @clear="handleClearBookmarks"
    />
    <!-- 性能统计面板 -->
    <div v-if="perfVisible" class="perf-panel">
      <div class="perf-title">性能统计 (开发模式)</div>
      <div class="perf-row">FPS: <b>{{ perfStats.fps || 0 }}</b></div>
      <div class="perf-row">帧时间: <b>{{ perfStats.lastFrameTime?.toFixed(2) || 0 }}ms</b></div>
      <div class="perf-row">平均: <b>{{ perfStats.avgFrameTime?.toFixed(2) || 0 }}ms</b></div>
      <div class="perf-row">峰值: <b>{{ perfStats.peakFrameTime?.toFixed(2) || 0 }}ms</b></div>
    </div>

    <!-- 免责声明（UI 基座试点）：首启强制确认 + 随时可查。
         ⚠️ 位置必须在 .app-layout 内：shadcn 组件靠 .theme-* 上的 CSS 变量继承取色。 -->
    <disclaimer-dialog
      :open="disclaimerOpen"
      :mode="disclaimerMode"
      @update:open="handleDisclaimerOpenChange"
      @accept="handleDisclaimerAccept"
      @decline="handleDisclaimerDecline"
    />
  </div>
</template>

<script setup>
import { iconSvg } from './utils/iconSvg';
// 打开知识库本体（用户需求：一键可达的「打开 Obsidian 知识库」入口）
import { openVault } from './utils/vault';
// 导入知识库内容：App 只跟注册表打交道（不 import projectStore）
import { importFromVault, restoreLastProject } from './store/canvasBridge';
// B8（2026-09-24）：导入地图配置也要进 undo 栈 —— 数据修改一律放 redo 回调内（项目 undo 纪律）
import { execute } from './store/undo';
import { ref, reactive, computed, watch, nextTick, onMounted, onUnmounted, defineAsyncComponent } from 'vue';
import { useGeodataStore, jsonSafeReplacer } from './store/geodata';
// 单一写闸门：清缓存等落盘写统一过 guardWrite（只读态拒绝）
import { guardWrite, isReadOnly, writeModeReason as readOnlyReason, READONLY_BADGE, lastRejection } from './store/writeGate';
import { usePanelsStore } from './store/panels';
import { createSampleWorld } from './utils/sampleData';
import WorldSelector from './components/WorldSelector.vue';
import NodeDetailPanel from './components/NodeDetailPanel.vue';
import SearchBar from './components/SearchBar.vue';
import TreeNavigation from './components/TreeNavigation.vue';
import LayerPanel from './components/LayerPanel.vue';
import StatusBar from './components/StatusBar.vue';

// 七层视图动态导入：视图切换为 v-if，初始只需当前层，整体拆出主 bundle
// （画布类视图体量大：PlanetMap/ScenarioMap/AreaMap/GalaxyMap/InteriorView/System*）
const GalaxyMap = defineAsyncComponent(() => import('./components/GalaxyMap.vue'));
const SystemView = defineAsyncComponent(() => import('./components/SystemView.vue'));
const SystemDetailView = defineAsyncComponent(() => import('./components/SystemDetailView.vue'));
const PlanetMap = defineAsyncComponent(() => import('./components/PlanetMap.vue'));
const AreaMap = defineAsyncComponent(() => import('./components/AreaMap.vue'));
const InteriorView = defineAsyncComponent(() => import('./components/InteriorView.vue'));
const ScenarioMap = defineAsyncComponent(() => import('./components/ScenarioMap.vue'));

// 低频面板动态导入：减少初始 bundle
const AboutPanel = defineAsyncComponent(() => import('./components/AboutPanel.vue'));
const BatchImportPanel = defineAsyncComponent(() => import('./components/BatchImportPanel.vue'));
const SettingsPanel = defineAsyncComponent(() => import('./components/SettingsPanel.vue'));
const OnboardingGuide = defineAsyncComponent(() => import('./components/OnboardingGuide.vue'));
const RecoveryPanel = defineAsyncComponent(() => import('./components/RecoveryPanel.vue'));
const KeyboardShortcuts = defineAsyncComponent(() => import('./components/KeyboardShortcuts.vue'));
const ChangeLog = defineAsyncComponent(() => import('./components/ChangeLog.vue'));
const UpdateNotification = defineAsyncComponent(() => import('./components/UpdateNotification.vue'));
const PromptDialog = defineAsyncComponent(() => import('./components/PromptDialog.vue'));
const BookmarkPanel = defineAsyncComponent(() => import('./components/BookmarkPanel.vue'));
const HistoryPanel = defineAsyncComponent(() => import('./components/HistoryPanel.vue'));
// Phase 2.1：项目面板（项目文件操作 + 实体浏览器 + 快照回滚）。EntityCreator 随该 chunk 一起加载。
const ProjectPanel = defineAsyncComponent(() => import('./components/ProjectPanel.vue'));
// 一键同步到远程仓库（git）：傻瓜式推送（填一次地址 → 点「立即同步」）
const GitSyncPanel = defineAsyncComponent(() => import('./components/GitSyncPanel.vue'));
// 免责声明（UI 基座试点）：首启强制确认 + 关于/设置面板随时可查
const DisclaimerDialog = defineAsyncComponent(() => import('./components/DisclaimerDialog.vue'));
import { planetToGeoJSON, geoJSONToPlanet } from './utils/geojson';
import { useLayersStore } from './store/layers';
// 退出前落盘（数据安全）：中立注册表 —— App 不直接 import 任何 store 实现，只驱动 flushAll()
import { flushAll } from './store/quitFlush';
import { useTheme } from './composables/useTheme';
import { useBookmarks } from './composables/useBookmarks';
import { measurePerformance, cleanupTestNodes } from './utils/stressTest';
// 免责声明：确认状态与文案都在 utils/disclaimer.js（文案单一事实源）
import { hasAckedDisclaimer, ackDisclaimer } from './utils/disclaimer';
import Icon from './components/Icon.vue';

const store = useGeodataStore();
const layersStore = useLayersStore();
const panelsStore = usePanelsStore();
const { currentTheme, toggleTheme, initTheme } = useTheme();
const { bookmarks, currentIndex, addBookmark, removeBookmark, clearAll } = useBookmarks();
const dirty = ref(false);
const scenarioMode = ref(false);
const statusText = ref('');
// 状态类型：ok | err —— 驱动状态栏图标（替代原先在文案里内嵌的对错符号）
const statusKind = ref('');

// 写闸门拒绝回音（2026-09-21）：只读态下任何被拦的写操作都要在状态栏说清「为什么没反应 + 去哪儿」
// ——覆盖落盘写（11 条入口）与内存编辑（execute / 参考图 / 剧本导入…），见 store/writeGate.js。
// 绝不静默：只拦不提示 = 用户以为点了没反应（本项目踩过）。
let rejectionTimer = null;
watch(lastRejection, (r) => {
  if (!r) return;
  statusText.value = r.message;
  statusKind.value = 'err';
  if (rejectionTimer) clearTimeout(rejectionTimer);
  rejectionTimer = setTimeout(() => {
    if (statusKind.value === 'err') { statusText.value = ''; statusKind.value = ''; }
  }, 5000);
});
const searchBar = ref(null);
const galaxyMapRef = ref(null);
const systemViewRef = ref(null);
const systemDetailRef = ref(null);
// R5：这三层此前**只在模板里写了 ref 名、脚本里没有声明** —— `<script setup>` 下模板 ref
// 必须绑到声明的变量上，否则 ref 永远是 null（不报错，只是取不到）。
// 配套：三个组件补了 `defineExpose({ canvas, renderer })`（原先一个都没暴露）。
const planetMapRef = ref(null);
const areaMapRef = ref(null);
const interiorViewRef = ref(null);
const perfVisible = ref(false);
const perfStats = ref({});
const aboutPanelRef = ref(null);
const batchImportPanelRef = ref(null);
const settingsPanelRef = ref(null);
const keyboardShortcutsRef = ref(null);
const changeLogRef = ref(null);
const updateNotificationRef = ref(null);
const onboardingGuideRef = ref(null);

// ===== 免责声明（2026-10-06 UI 基座试点）=====
// 首启阻断必须在 loadGeodata() **之前**决定（放在之后会出现
// 「splash 淡出 → 闪一下主界面 → 才盖上来」，见 docs/PROPOSAL_DISCLAIMER_AND_UI.md §1.4）。
const disclaimerOpen = ref(false);
const disclaimerMode = ref('gate'); // 'gate' 首启阻断 | 'view' 随时查看
const isDisclaimerGateOpen = computed(() => disclaimerOpen.value && disclaimerMode.value === 'gate');

function openDisclaimerView() {
  disclaimerMode.value = 'view';
  disclaimerOpen.value = true;
}

function handleDisclaimerOpenChange(v) {
  // 阻断态不允许被外部关掉（reka-ui 的 Esc/点外点已被组件拦住，这里是双保险）
  if (!v && isDisclaimerGateOpen.value) return;
  disclaimerOpen.value = v;
}

function handleDisclaimerAccept(payload) {
  const at = payload && payload.at ? new Date(payload.at) : new Date();
  const persisted = ackDisclaimer(undefined, at);
  disclaimerOpen.value = false;
  window.__sitianDisclaimerGate = false;
  if (!persisted) {
    // 写不进 localStorage（隐私模式/配额满）也要说清：否则用户以为「下次不用再点了」
    statusText.value = '免责声明已确认（本次会话内有效：无法写入本地记录）';
    statusKind.value = 'warn';
  }
  // 首启时接着走新手引导 —— 引导被声明阻断过，这里补一次（见 OnboardingGuide 的守卫）
  if (!localStorage.getItem('sitian-first-run-complete')) {
    nextTick(() => onboardingGuideRef.value?.open());
  }
}

function handleDisclaimerDecline() {
  // 「不同意并退出」：走窗口关闭路径（与点 × 一致；主进程 before-quit 仍会尝试落盘未保存改动）
  window.close();
}

// 面包屑下拉菜单状态
const dropdowns = reactive({
  world: false,
  domain: false,
  system: false,
  systemDetail: false,
  planet: false,
  area: false,
});

function toggleDropdown(level) {
  Object.keys(dropdowns).forEach(key => {
    if (key !== level) dropdowns[key] = false;
  });
  dropdowns[level] = !dropdowns[level];
}

function handleClickOutside(e) {
  if (!e.target.closest('.breadcrumb-item')) {
    Object.keys(dropdowns).forEach(key => {
      dropdowns[key] = false;
    });
  }
}

// ===== 面板互斥（P0-2）：图层面板接入全局面板注册表 =====
function toggleLayersPanel() {
  layersStore.togglePanel();
  if (layersStore.panelOpen) panelsStore.open('layers');
  else panelsStore.closeAll();
}

// 其他浮层面板打开时，自动关闭图层面板
watch(() => panelsStore.openPanelId, (id) => {
  if (id !== 'layers' && layersStore.panelOpen) {
    layersStore.panelOpen = false;
  }
});
const undoTooltip = computed(() => {
  const label = store.undoLabel;
  return label ? `撤销: ${label} (Ctrl+Z)` : '撤销 (Ctrl+Z)';
});

// 只读徽标 title（决策 1 终态）：状态原因 + **能力说明 + 去处**。
// 能力不减纪律：任何「不可用」提示都必须说明去哪恢复，否则用户只看到一句「已停用」。
const readonlyTitle = computed(() => {
  const base = String(readOnlyReason.value || '只读');
  const hint = base.indexOf('打开项目后即可继续编辑') >= 0 ? '' : '；新建或打开项目后即可继续编辑';
  // 以「只读」开头：title 是「这个元素是什么」的说明，不该以状态原因开头（原因可能是「项目已关闭」）
  return `只读：${base}${hint}（点击打开项目面板）`;
});

// 「重新提取」的可用性与说明（三段式：原因 + 影响 + 去处）
//   ① 只读态（无项目）：重提取是"落盘写"，会被闸门拒绝
//   ② 已打开项目：画布事实源是项目文件，重提取会把知识库数据倒进画布（两套事实源混流）
// 两种情形都灰禁 + 在 title 里写清去哪儿恢复，避免"点了才发现被拒"。
const canvasIsProject = computed(() => store.canvasSource === 'project');
const canReextract = computed(() => !isReadOnly.value && !canvasIsProject.value);
// ⚠️ 三段文案**都必须以「重新提取」开头**：状态原因是动态的（关闭项目后是「项目已关闭」），
// 直接拿它开头会让 title 变成以「项目」开头的句子 —— 按 title 前缀找「项目面板」入口的调用方
// （用例 / 未来的帮助检索）会挑中这个按钮，表现为「点了项目按钮面板不出现」（2026-09-22 实测踩到）。
const reextractTitle = computed(() => {
  if (isReadOnly.value) {
    return `重新提取（已停用）：${readOnlyReason.value}；它要重写知识库坐标缓存，`
      + '请先在项目面板「以知识库为基底新建项目」或打开已有项目，再用面板里的「导入知识库内容」把数据带进来';
  }
  if (canvasIsProject.value) {
    return '重新提取（已停用）：当前画布数据来自项目文件，重提取会让知识库数据与项目数据混流。'
      + '要把知识库内容带进项目，请用项目面板的「导入知识库内容」（只补缺、可撤销）；'
      + '若要从零重建，先在项目面板关闭当前项目';
  }
  return '重新提取（把知识库最新内容读进来）';
});

const vaultButtonTitle = computed(() => '打开 Obsidian 知识库（打不开时自动改为在文件管理器中打开库目录）');

/**
 * 打开知识库本体（用户需求 2026-09-22：给一个「打开 Obsidian 知识库」的按钮，
 * 不再让用户自己猜知识库在哪）。三级兜底见 utils/vault.js#openVault。
 */
async function openVaultFromToolbar() {
  const res = await openVault();
  if (!res.ok) {
    statusText.value = '先设置知识库路径：设置 → 数据管理 → 知识库路径';
    statusKind.value = 'err';
    return;
  }
  statusText.value = res.how === 'obsidian' ? '已请求 Obsidian 打开知识库' : '已在文件管理器中定位知识库目录';
  statusKind.value = 'ok';
}

/**
 * 「导入知识库内容」（2026-09-22 用户实测）：把知识库既有内容合并进**当前项目**。
 * App 不 import projectStore（静态闸门），所以走 canvasBridge 的注册口。
 */
async function doImportFromVault() {
  const res = await importFromVault();
  if (res && res.success) {
    const m = (res && res.merged) || {};
    statusText.value = res.nothingNew
      ? '项目里已经有知识库的全部内容了，无需重复导入'
      : `已导入知识库内容：${m.entities || 0} 个词条 / ${m.hyperlanes || 0} 条航道 / ${m.maps || 0} 张行星图（Ctrl+Z 可撤销）`;
    statusKind.value = 'ok';
    return;
  }
  statusText.value = (res && res.error) || '导入知识库内容失败';
  statusKind.value = 'err';
}

// 面包屑点击星域：单系地图/行星地图/区域地图/建筑内部 → 返回域内恒星系总览（system 视图）
function handleBreadcrumbDomain() {
  if (store.viewLevel === 'system_detail' || store.viewLevel === 'planet' || store.viewLevel === 'area' || store.viewLevel === 'interior') {
    store.backToSystem();
  }
}

// 面包屑点击恒星系：行星地图/区域地图/建筑内部 → 返回该恒星系单系地图
function handleBreadcrumbSystem() {
  if (store.viewLevel !== 'system_detail' && store.currentSystem) {
    store.selectSystem(store.currentSystem);
  }
}

// 行星地图返回：来自单系视图（currentSystem 存在）→ 回该系；否则回域总览
function handlePlanetBack() {
  if (store.currentSystem) store.selectSystem(store.currentSystem);
  else store.backToSystem();
}
let cleanupNodeUpdated = null;
let cleanupNodeRemoved = null;
let perfUpdateTimer = null;

// 获取当前活动的 renderer ref
// 获取当前活动的 renderer（相机 / 聚焦 / 性能统计 + 视口书签）
// ⚠️ R5（2026-09-26）：原来只认 domain / system / system_detail 三层，行星 / 区域 / 建筑内部
// 一律返回 null → 调用方（书签）静默 `return`，用户表现为「点了没反应」。
// 现在覆盖**全部六层有画布的视图**（world 是选择页、无画布）。
// 前置条件：PlanetMap / AreaMap / InteriorView 必须 `defineExpose({ canvas, renderer })`。
function getActiveRenderer() {
  if (scenarioMode.value) {
    // 历史剧本是独立画布（ScenarioMap），不走这套六层导航；它有自己的导出/工具条
    return null;
  }
  if (store.viewLevel === 'world') return null;
  if (store.viewLevel === 'domain') return galaxyMapRef.value?.renderer || null;
  if (store.viewLevel === 'system') return systemViewRef.value?.renderer || null;
  if (store.viewLevel === 'system_detail') return systemDetailRef.value?.renderer || null;
  if (store.viewLevel === 'planet') return planetMapRef.value?.renderer || null;
  if (store.viewLevel === 'area') return areaMapRef.value?.renderer || null;
  if (store.viewLevel === 'interior') return interiorViewRef.value?.renderer || null;
  return null;
}

// 获取当前活动的 canvas ref —— ⚠️ **刻意保持三层**（domain / system / system_detail）。
// 它与 `getActiveRenderer()` 不是同一件事：这个只服务「当前视图整图导出」，而那条导出链
// 只在三层实现过（见下方 `viewExportSupported` / VIEW_EXPORT_HINT）。
// 行星 / 区域 / 建筑内部若在这里返回 canvas，会让导出函数拿到一张它处理不了的画布
// —— 按钮虽然仍然置灰，但函数级守卫就失效了（双保险变单保险）。
function getActiveCanvas() {
  if (store.viewLevel === 'domain') {
    return galaxyMapRef.value?.canvas;
  } else if (store.viewLevel === 'system') {
    return systemViewRef.value?.canvas;
  } else if (store.viewLevel === 'system_detail') {
    return systemDetailRef.value?.canvas;
  }
  return null;
}

// 导出功能已内联实现，无需 useMapExport

// 「当前视图」整图导出只覆盖 galaxy / system / system_detail 三层
// （PlanetMap 与 ScenarioMap 各有自己的导出工具栏）。不可用时按钮置灰 + 说明去处，
// 而不是点了静默 return —— 用户实测「点了没反应」（2026-09-24 修）。
const VIEW_EXPORT_HINT = '当前层级没有整图导出：行星地图与历史剧本请用各自工具栏的导出按钮';
const viewExportSupported = computed(() => ['domain', 'system', 'system_detail'].includes(store.viewLevel));

async function handleExportPNG() {
  const canvas = getActiveCanvas();
  if (!canvas) {
    statusText.value = VIEW_EXPORT_HINT;
    statusKind.value = 'warn';
    panelsStore.close('export');
    return;
  }

  showExportProgress('正在导出 PNG...');

  // 让 UI 再入渲染进度框后再执行阻塞导出
  await new Promise(r => requestAnimationFrame(r));
  await new Promise(r => setTimeout(r, 30));

  const tmpCanvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  tmpCanvas.width = canvas.clientWidth * dpr;
  tmpCanvas.height = canvas.clientHeight * dpr;
  const ctx = tmpCanvas.getContext('2d');
  ctx.drawImage(canvas, 0, 0, tmpCanvas.width, tmpCanvas.height);

  await new Promise(resolve => {
    tmpCanvas.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sitian-${store.viewLevel}-${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(url);
      hideExportProgress();
      statusText.value = '导出完成';
      statusKind.value = 'ok';
      resolve();
    });
  });

  panelsStore.close('export');
}

async function handleExportSVG() {
  const canvas = getActiveCanvas();
  if (!canvas) {
    statusText.value = VIEW_EXPORT_HINT;
    statusKind.value = 'warn';
    panelsStore.close('export');
    return;
  }

  showExportProgress('正在导出 SVG...');
  await new Promise(r => requestAnimationFrame(r));
  await new Promise(r => setTimeout(r, 30));

  const width = canvas.width;
  const height = canvas.height;
  const isDark = currentTheme.value !== 'light';
  const bgColor = isDark ? '#0d1117' : '#ffffff';

  const dataUrl = canvas.toDataURL('image/png');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <rect x="0" y="0" width="${width}" height="${height}" fill="${bgColor}"/>
  <image xlink:href="${dataUrl}" x="0" y="0" width="${width}" height="${height}"/>
</svg>`;

  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sitian-${store.viewLevel}-${Date.now()}.svg`;
  a.click();
  URL.revokeObjectURL(url);

  hideExportProgress();
  statusText.value = '导出完成';
  statusKind.value = 'ok';
  panelsStore.close('export');
}

function showExportProgress(msg) {
  let overlay = document.getElementById('sitian-export-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'sitian-export-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);color:#fff;font-family:system-ui,sans-serif;';
    overlay.innerHTML = `<div style="text-align:center;"><div style="margin-bottom:12px;">${iconSvg('download', { size: 32 })}</div><div id="sitian-export-msg" style="font-size:14px;"></div><div style="margin-top:16px;width:200px;height:4px;background:rgba(255,255,255,0.2);border-radius:2px;overflow:hidden;margin-left:auto;margin-right:auto;"><div style="height:100%;width:30%;background:#4A90D9;animation:sitian-progress 1s ease-in-out infinite;"></div></div></div><style>@keyframes sitian-progress{0%{transform:translateX(-100%);}100%{transform:translateX(400%);}}</style>`;
    document.body.appendChild(overlay);
  }
  const msgEl = overlay.querySelector('#sitian-export-msg');
  if (msgEl) msgEl.textContent = msg;
  overlay.style.display = 'flex';
}

function hideExportProgress() {
  const overlay = document.getElementById('sitian-export-overlay');
  if (overlay) overlay.style.display = 'none';
}

async function handleExportFullPNG() {
  statusText.value = '正在导出全图...';
  
  const nodes = store.nodes;
  const hyperlanes = store.hyperlanes;
  if (nodes.length === 0) return;
  
  const xs = nodes.map(n => n.coordinate?.x || 0).filter(x => x !== null);
  const ys = nodes.map(n => n.coordinate?.y || 0).filter(y => y !== null);
  
  if (xs.length === 0 || ys.length === 0) return;
  
  const minX = Math.min(...xs) - 150;
  const minY = Math.min(...ys) - 150;
  const maxX = Math.max(...xs) + 150;
  const maxY = Math.max(...ys) + 150;
  const width = maxX - minX;
  const height = maxY - minY;
  
  const tmpCanvas = document.createElement('canvas');
  const dpr = 2; // 2x for high quality
  tmpCanvas.width = width * dpr;
  tmpCanvas.height = height * dpr;
  const ctx = tmpCanvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.translate(-minX, -minY);
  
  // 背景色跟随当前主题
  const isDark = currentTheme.value !== 'light';
  const textColor = isDark ? '#e8edf6' : '#1f2328';
  
  // 1. 背景渐变（暗色：深蓝灰径向；亮色：浅灰线性）
  if (isDark) {
    const bg = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(width, height) * 0.72);
    bg.addColorStop(0, '#151b2e');
    bg.addColorStop(0.5, '#0f1424');
    bg.addColorStop(1, '#0a0e1a');
    ctx.fillStyle = bg;
  } else {
    const bg = ctx.createLinearGradient(0, minY, 0, maxY);
    bg.addColorStop(0, '#f8fafc');
    bg.addColorStop(1, '#eef2f7');
    ctx.fillStyle = bg;
  }
  ctx.fillRect(minX, minY, width, height);
  
  // 2. 星云 + 星尘（仅暗色主题，保证导出图有太空氛围）
  if (isDark) {
    const nebulae = [
      { x: minX + width * 0.3, y: minY + height * 0.4, r: width * 0.25, color: 'rgba(70, 100, 190, 0.07)' },
      { x: minX + width * 0.7, y: minY + height * 0.6, r: width * 0.2, color: 'rgba(140, 70, 170, 0.06)' },
    ];
    for (const neb of nebulae) {
      const g = ctx.createRadialGradient(neb.x, neb.y, 0, neb.x, neb.y, neb.r);
      g.addColorStop(0, neb.color);
      g.addColorStop(0.6, neb.color.replace('0.', '0.0'));
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.fillRect(neb.x - neb.r, neb.y - neb.r, neb.r * 2, neb.r * 2);
    }
    ctx.fillStyle = 'rgba(220, 230, 245, 0.12)';
    for (let i = 0; i < 300; i++) {
      const x = minX + ((i * 97 + 23) % Math.floor(width));
      const y = minY + ((i * 61 + 41) % Math.floor(height));
      ctx.beginPath();
      ctx.arc(x, y, (i % 3) * 0.4 + 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  
  // 3. 势力边界（星域分组 → 星系凸包 → 半透明染色 + 边界线 + 星域名标签）
  const domainGalaxyMap = new Map();
  nodes.filter(n => n.layer === 'galaxy').forEach(g => {
    if (g.coordinate?.x === null || g.coordinate?.x === undefined) return;
    if (!domainGalaxyMap.has(g.parentId)) domainGalaxyMap.set(g.parentId, []);
    domainGalaxyMap.get(g.parentId).push(g);
  });
  for (const [domainId, galaxies] of domainGalaxyMap) {
    const domain = nodeMap.get(domainId);
    if (!domain || galaxies.length < 3) continue;
    const pts = galaxies.map(g => ({ x: g.coordinate.x, y: g.coordinate.y })).filter(p => p.x !== null && p.y !== null);
    if (pts.length < 3) continue;
    const hull = convexHullForExport(pts);
    if (hull.length < 3) continue;
    const cx = hull.reduce((s, p) => s + p.x, 0) / hull.length;
    const cy = hull.reduce((s, p) => s + p.y, 0) / hull.length;
    const expanded = hull.map(p => {
      const dx = p.x - cx, dy = p.y - cy;
      const dist = Math.hypot(dx, dy) || 1;
      return { x: p.x + (dx / dist) * 25, y: p.y + (dy / dist) * 25 };
    });
    const color = getDomainColorForExport(domain.displayName || domain.name);
    ctx.beginPath();
    ctx.moveTo(expanded[0].x, expanded[0].y);
    for (let i = 1; i < expanded.length; i++) ctx.lineTo(expanded[i].x, expanded[i].y);
    ctx.closePath();
    ctx.fillStyle = color.replace('hsl(', 'hsla(').replace(')', isDark ? ', 0.15)' : ', 0.10)');
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
    // 星域名标签（带衬底，保证可读）
    const label = domain.displayName || domain.name;
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const m = ctx.measureText(label);
    ctx.fillStyle = isDark ? 'rgba(10, 14, 26, 0.72)' : 'rgba(255, 255, 255, 0.8)';
    ctx.beginPath();
    ctx.roundRect(cx - m.width / 2 - 8, cy - 12, m.width + 16, 24, 5);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(label, cx, cy + 1);
  }
  
  // 4. 航道（分类型颜色 + 辉光，跨域虚线）
  hyperlanes.forEach(h => {
    const from = nodeMap.get(h.fromId);
    const to = nodeMap.get(h.toId);
    if (!from || !to || from.coordinate?.x === null || to.coordinate?.x === null) return;
    const color = h.type === 'cross_domain'
      ? (isDark ? 'rgba(190, 130, 255, 0.75)' : 'rgba(110, 70, 200, 0.55)')
      : h.type === 'hyperjump'
        ? (isDark ? 'rgba(255, 120, 120, 0.7)' : 'rgba(200, 70, 70, 0.5)')
        : (isDark ? 'rgba(120, 210, 255, 0.6)' : 'rgba(60, 140, 200, 0.5)');
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.strokeStyle = color;
    ctx.lineWidth = h.type === 'cross_domain' ? 2.5 : 2;
    if (h.type === 'cross_domain') ctx.setLineDash([8, 5]);
    ctx.beginPath();
    ctx.moveTo(from.coordinate.x, from.coordinate.y);
    ctx.lineTo(to.coordinate.x, to.coordinate.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  });
  
  // 5. 节点 + 光晕 + 亮核 + 带衬底名称标签（导出可读性核心）
  nodes.forEach(n => {
    if (n.coordinate?.x === null || n.coordinate?.x === undefined) return;
    const color = getNodeColor(n.layer);
    const r = n.layer === 'world' ? 10 : n.layer === 'star_domain' ? 9 : n.layer === 'galaxy' ? 7 : 5;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(n.coordinate.x, n.coordinate.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.arc(n.coordinate.x - 1, n.coordinate.y - 1, r * 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    
    const label = n.displayName || n.name;
    ctx.font = (n.layer === 'world' || n.layer === 'star_domain' ? 'bold ' : '') + '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const m = ctx.measureText(label);
    const pad = 4;
    ctx.fillStyle = isDark ? 'rgba(8, 12, 22, 0.65)' : 'rgba(255, 255, 255, 0.75)';
    ctx.beginPath();
    ctx.roundRect(n.coordinate.x + r + 4, n.coordinate.y - 7, m.width + pad * 2, 14, 3);
    ctx.fill();
    ctx.fillStyle = textColor;
    ctx.fillText(label, n.coordinate.x + r + 4 + pad, n.coordinate.y + 1);
  });
  
  tmpCanvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sitian-full-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(url);
    statusText.value = '导出完成';
  });
  
  panelsStore.close('export');
}

function getNodeColor(layer) {
  const colors = {
    world: '#d2a8ff', star_domain: '#7c7cff', galaxy: '#ffd700',
    planet: '#5cb85c', city: '#f0ad4e', town: '#d9853b', location: '#888',
  };
  return colors[layer] || '#888';
}

// ===== 全图导出辅助（Stellaris 风格） =====

function convexHullForExport(points) {
  if (points.length < 3) return points;
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (O, A, B) => (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function getDomainColorForExport(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 62%, 58%)`;
}

// ===== 导入/导出地图配置 =====

// E10: GeoJSON 导出（当前行星地图 → FeatureCollection，局部米制坐标系）
function handleExportGeoJSON() {
  const planet = store.currentPlanet;
  if (!planet) return;
  const mapData = store.mapData[planet.id] || {};
  const fc = planetToGeoJSON({
    planet,
    places: store.nodes.filter(n =>
      n.parentId === planet.id &&
      ['city', 'town', 'village', 'location'].includes(n.layer)
    ),
    terrain: mapData.terrain || [],
    regions: mapData.regions || [],
    markers: mapData.markers || [],
    routes: mapData.routes || [],
    textLabels: mapData.textLabels || [],
  });

  const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sitian-${planet.id}-geojson-${Date.now()}.geojson`;
  a.click();
  URL.revokeObjectURL(url);

  panelsStore.close('export');
  statusText.value = `GeoJSON 已导出（${fc.features.length} 个要素）`;
}

// E10: GeoJSON 导入（draft 回填，不覆盖 Obsidian 节点/原始地形）
function handleImportGeoJSON() {
  const planet = store.currentPlanet;
  if (!planet) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.geojson,.json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const fc = JSON.parse(await file.text());
      const parsed = geoJSONToPlanet(fc);
      if (parsed.errors.length && parsed.places.length + parsed.markers.length + parsed.textLabels.length + parsed.routes.length + parsed.regions.length === 0) {
        statusText.value = `GeoJSON 导入失败：${parsed.errors[0]}`;
        statusKind.value = 'err';
        return;
      }
      for (const p of parsed.places) {
        store.addNode({ ...p, parentId: planet.id, coordinate: { ...p.coordinate } });
      }
      for (const m of parsed.markers) store.addMarker(planet.id, { ...m });
      for (const t of parsed.textLabels) store.addTextLabel(planet.id, { ...t });
      for (const r of parsed.routes) {
        store.addRoute(planet.id, {
          id: r.id,
          points: r.points.map(pt => ({ x: pt.x, y: pt.y, placeId: null })),
          dashed: false,
          color: r.color || '#F39C12',
          name: r.name || '导入路线',
          label: '',
          description: '',
        });
      }
      for (const rg of parsed.regions) {
        if (rg.points.length < 3) { parsed.skipped += 1; continue; }
        store.addRegion(planet.id, {
          id: rg.id,
          name: rg.name || '导入区域',
          type: 'region',
          color: rg.color || '#FF6B6B',
          points: rg.points,
          auto: false,
        });
      }
      panelsStore.close('export');
      statusText.value = `GeoJSON 已导入：地点 ${parsed.places.length}、标记 ${parsed.markers.length}、文本 ${parsed.textLabels.length}、路线 ${parsed.routes.length}、区域 ${parsed.regions.length}、跳过 ${parsed.skipped}`;
      statusKind.value = 'ok';
    } catch (err) {
      statusText.value = 'GeoJSON 导入失败：' + err.message;
      statusKind.value = 'err';
    }
  };
  input.click();
}

/**
 * 构建「地图配置」载荷（**纯构造，不落盘/不下载**）。
 *
 * 抽成独立函数是为了让「导出 → 导入」能**真的走一个往返**（回归 test_74）：
 * 载荷构造留在 `handleExportMapConfig` 里面时，用例只能自己手写一份配置去喂导入端 ——
 * 那样**导出端漏字段永远测不出来**（实测：把 `parentId` 改成恒 null，手写配置的用例照样全绿）。
 *
 * ⚠️ 字段必须与 `handleImportMapConfig` 的读取**对齐**（2026-09-24 修）：导入端会读
 *    mapData / areaZones / interiorData，旧导出端只写 nodes + hyperlanes → 「导出后再导入」
 *    会**静默丢掉**行星地图、区域多边形/道路/标记/文本、建筑内部数据。
 * 深拷贝：去响应式代理（IPC/JSON 需要）+ TypedArray 兜底（见 jsonSafeReplacer）。
 */
function buildMapConfig() {
  return {
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    viewLevel: store.viewLevel,
    currentWorld: store.currentWorld?.id || null,
    currentDomain: store.currentDomain?.id || null,
    // R6（2026-09-26）：`parentId` 是**层级**，旧导出漏了它 → 「导出 → 在另一台机器导入」后
    //    实体树会整片塌成 0 级（父子关系全丢），而且不报错。
    //    形状刻意与项目文件的实体形状对齐（`nodeToProjectEntity`）：编辑侧字段走 `entityExtras`
    //    一次性带走，`draft` 不入配置（它由 sourcePath 派生）—— 导入端用 `store.entityToNode()`
    //    还原，两侧形状只有一份定义。
    nodes: store.nodes.map(configNodeOf),
    hyperlanes: store.hyperlanes,
    mapData: JSON.parse(JSON.stringify(store.mapData || {}, jsonSafeReplacer)),
    areaZones: JSON.parse(JSON.stringify(store.areaZones || {}, jsonSafeReplacer)),
    areaRoutes: JSON.parse(JSON.stringify(store.areaRoutes || {}, jsonSafeReplacer)),
    areaMarkers: JSON.parse(JSON.stringify(store.areaMarkers || {}, jsonSafeReplacer)),
    areaTextLabels: JSON.parse(JSON.stringify(store.areaTextLabels || {}, jsonSafeReplacer)),
    interiorData: JSON.parse(JSON.stringify(store.interiorData || {}, jsonSafeReplacer)),
  };
}

function handleExportMapConfig() {
  const config = buildMapConfig();

  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sitian-map-config-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  
  panelsStore.close('export');
  statusText.value = '地图配置已导出';
}

/** R6：画布节点 → 可移植配置里的实体（形状与项目文件的实体一致；`draft` 不进配置，由 sourcePath 派生） */
function configNodeOf(n) {
  const extras = store.entityExtras(n);
  delete extras.draft;
  return {
    ...extras,
    id: n.id,
    name: n.name,
    layer: n.layer,
    layerLabel: n.layerLabel || n.layer,
    parentId: n.parentId ?? null,
    tags: Array.isArray(n.tags) ? [...n.tags] : [],
    coordinate: { x: n.coordinate?.x ?? null, y: n.coordinate?.y ?? null },
    origin: n.origin || 'canvas',
    sourcePath: n.sourcePath || '',
    uuid: n.uuid || '',
    createdAt: n.createdAt || '',
  };
}

function handleImportMapConfig() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // 🔴 导入会直接改写世界观数据 → 必须先过写闸门（2026-09-24 补，本函数原 89 行里 guardWrite 一次都没有）。
    //    旧实现直接给 store 的各个容器赋值：只读态下「已导入 N 个节点」的提示照打，
    //    但 scheduleAutoSave 在只读态直接返回 → **数据永不落盘**（静默假成功），且不进 undo 栈。
    const gate = guardWrite('导入地图配置');
    if (!gate.ok) {
      statusText.value = gate.error;
      statusKind.value = 'err';
      return;
    }

    try {
      const text = await file.text();
      const config = JSON.parse(text);
      
      if (!config.version || !config.nodes || !config.hyperlanes) {
        alert('无效的地图配置文件格式');
        return;
      }
      
      // 🔴 整次导入 = **一条 undo**（B8，2026-09-24）。
      //    既有实现直接给 store 的各个容器赋值：既绕写闸门（只读态静默假成功）、也不进 undo 栈
      //    （Ctrl+Z 撤不掉）。现在改成「先把导入后应该是什么样算好，再交给 execute 的 redo 落库」——
      //    **绝不先手动改 store**（那是双写，撤销会错位）。
      const clone = (v) => JSON.parse(JSON.stringify(v || {}, jsonSafeReplacer));
      const before = {
        coords: new Map(store.nodes.map(n => [n.id, n.coordinate])),
        parents: new Map(store.nodes.map(n => [n.id, n.parentId])),
        hyperlaneIds: new Set(store.hyperlanes.map(h => h.id)),
        mapData: clone(store.mapData),
        areaZones: clone(store.areaZones),
        areaRoutes: clone(store.areaRoutes),
        areaMarkers: clone(store.areaMarkers),
        areaTextLabels: clone(store.areaTextLabels),
        interiorData: clone(store.interiorData),
      };

      // ── R6：导入端**新建缺失实体**（旧实现只 `find` 更新已存在节点的坐标 → 换台机器导入后
      //    实体根本没进来，提示却照打「已导入 N 个节点」= 假成功）。
      //    层级靠 `parentId` 复原；父级在**本次导入集合内**也算有效（两趟：先算 id 全集，再落库）。
      const seenCfgId = new Set();
      const importNodes = (config.nodes || []).filter(n => {
        if (!n || !n.id || !n.layer || seenCfgId.has(n.id)) return false;   // 缺字段 / 重复 id → 跳过
        seenCfgId.add(n.id);
        return true;
      });
      const existingIds = new Set(store.nodes.map(n => n.id));
      const knownIds = new Set([...existingIds, ...importNodes.map(n => n.id)]);
      /** 节点要落到画布上的样子 —— 与「项目 → 画布」共用同一份形状定义 */
      const toNode = (n) => {
        const node = store.entityToNode(n);
        node.parentId = (n.parentId && n.parentId !== n.id && knownIds.has(n.parentId)) ? n.parentId : null;
        node.coordinate = {
          x: Number.isFinite(n.coordinate?.x) ? n.coordinate.x : 0,
          y: Number.isFinite(n.coordinate?.y) ? n.coordinate.y : 0,
        };
        return node;
      };
      const newNodes = importNodes.filter(n => !existingIds.has(n.id)).map(toNode);

      const applyImportNodes = () => {
        // 已有节点：只更新坐标与层级（不重建对象 —— 按引用持有的选中态会脱钩，项目踩过）
        for (const n of importNodes) {
          const existing = store.nodes.find(x => x.id === n.id);
          if (!existing) continue;
          if (Number.isFinite(n.coordinate?.x) && Number.isFinite(n.coordinate?.y)) {
            existing.coordinate = { x: n.coordinate.x, y: n.coordinate.y };
          }
          if (n.parentId && n.parentId !== existing.id && knownIds.has(n.parentId)) {
            existing.parentId = n.parentId;
          }
        }
        for (const nn of newNodes) store.nodes.push(nn);
      };
      const undoImportNodes = () => {
        const createdIds = new Set(newNodes.map(n => n.id));
        for (let i = store.nodes.length - 1; i >= 0; i--) {
          if (createdIds.has(store.nodes[i].id)) store.nodes.splice(i, 1);
        }
        store.nodes.forEach(n => {
          if (before.coords.has(n.id)) n.coordinate = before.coords.get(n.id);
          if (before.parents.has(n.id)) n.parentId = before.parents.get(n.id);
        });
      };

      const applyImport = () => {
        applyImportNodes();
        // 航道（只补缺）
        config.hyperlanes.forEach(importedH => {
          if (!store.hyperlanes.some(h => h.id === importedH.id)) store.hyperlanes.push(importedH);
        });
        // 地图数据 / 区域 / 建筑内部 / 区域级道路·标记·文本（字段与导出端对齐）
        if (config.mapData) {
          Object.entries(config.mapData).forEach(([planetId, data]) => {
            store.mapData[planetId] = data;
            store.scheduleAutoSaveMap(planetId);
          });
        }
        if (config.areaZones) Object.entries(config.areaZones).forEach(([k, v]) => { store.areaZones[k] = v; });
        if (config.areaRoutes) Object.entries(config.areaRoutes).forEach(([k, v]) => { store.areaRoutes[k] = v; });
        if (config.areaMarkers) Object.entries(config.areaMarkers).forEach(([k, v]) => { store.areaMarkers[k] = v; });
        if (config.areaTextLabels) Object.entries(config.areaTextLabels).forEach(([k, v]) => { store.areaTextLabels[k] = v; });
        if (config.interiorData) Object.entries(config.interiorData).forEach(([k, v]) => { store.interiorData[k] = v; });
        store.scheduleAutoSave();
      };

      // 逐键恢复（不整体替换容器对象 —— 那会让按引用持有的选中态脱钩，项目踩过这个坑）
      const restoreMap = (target, snapshot) => {
        Object.keys(target).forEach(k => { if (!(k in snapshot)) delete target[k]; });
        Object.entries(snapshot).forEach(([k, v]) => { target[k] = v; });
      };
      const restoreBefore = () => {
        undoImportNodes();
        for (let i = store.hyperlanes.length - 1; i >= 0; i--) {
          if (!before.hyperlaneIds.has(store.hyperlanes[i].id)) store.hyperlanes.splice(i, 1);
        }
        restoreMap(store.mapData, before.mapData);
        restoreMap(store.areaZones, before.areaZones);
        restoreMap(store.areaRoutes, before.areaRoutes);
        restoreMap(store.areaMarkers, before.areaMarkers);
        restoreMap(store.areaTextLabels, before.areaTextLabels);
        restoreMap(store.interiorData, before.interiorData);
        store.scheduleAutoSave();
      };

      execute({
        type: 'import-map-config',
        label: `导入地图配置（${config.nodes.length} 节点 / ${config.hyperlanes.length} 航道）`,
        undo: restoreBefore,
        redo: applyImport,
      });

      statusText.value = `已导入 ${config.nodes.length} 个节点`
        + (newNodes.length ? `（其中新建 ${newNodes.length} 个）` : '')
        + `和 ${config.hyperlanes.length} 条航道（Ctrl+Z 可撤销）`;
      statusKind.value = 'ok';
      dirty.value = true;
    } catch (err) {
      alert('导入失败: ' + err.message);
    }
  };
  input.click();
  
  panelsStore.close('export');
}

// ===== 压力测试 =====

function runStressTest() {
  if (window.__stressTestResults) {
    console.log('[压力测试] 清理之前的测试数据...');
    window.cleanupStressTest();
  }
  
  const results = measurePerformance(store, 400);
  window.__stressTestResults = results;
  
  console.log('[压力测试] 完成！使用 window.cleanupStressTest() 清理测试数据。');
  return results;
}

function cleanupStressTest() {
  if (!window.__stressTestResults) {
    console.log('[压力测试] 没有测试数据需要清理');
    return;
  }
  
  const count = window.__stressTestResults.nodeCount;
  cleanupTestNodes(store);
  
  console.log(`[压力测试] 已清理测试节点`);
  window.__stressTestResults = null;
  store.scheduleAutoSave();
}

// ===== 世界管理（WorldSelector） =====

function handleCreateWorld() {
  // ⚠️ 只读态（无项目）下 addNode 会被写闸门拒绝 —— 旧实现不看返回值、照样打印「已创建」= 谎报成功。
  //    2026-09-24 修：先判只读 → 给出去处（去项目面板建/开项目），而不是让用户对着"假成功"发呆。
  if (isReadOnly.value) {
    statusText.value = '新建世界被拒绝：还没有打开项目 —— 先新建或打开项目，再回来建世界';
    statusKind.value = 'warn';
    panelsStore.toggle('project');
    return;
  }
  const id = `world_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  store.addNode({
    id,
    name: `新世界${Date.now() % 1000}`,
    layer: 'world',
    parentId: null,
    tags: ['世界', '新创建'],
    sourcePath: '',
    coordinate: { x: null, y: null },
  });
  dirty.value = true;
  statusText.value = `已创建「新世界${Date.now() % 1000}」，可在左侧树中选中后重命名`;
  setTimeout(() => { statusText.value = ''; statusKind.value = ''; }, 4000);
}

function handleLoadSampleWorld() {
  // ⚠️ 同上：只读态下 20+ 个 addNode 全会被拒，旧实现仍打印「已加载示例世界观」= 谎报成功。
  if (isReadOnly.value) {
    statusText.value = '加载示例被拒绝：还没有打开项目 —— 先新建或打开项目，再回来加载示例';
    statusKind.value = 'warn';
    panelsStore.toggle('project');
    return;
  }
  const sample = createSampleWorld();
  // 批量添加示例节点
  for (const node of sample.nodes) {
    store.addNode({ ...node, tags: [...node.tags] });
  }
  // 添加示例航道
  for (const lane of sample.hyperlanes) {
    store.addHyperlane(lane.fromId, lane.toId, lane.type);
  }
  dirty.value = true;
  statusText.value = '已加载示例世界观「幻境」，点击世界卡片开始探索';
  setTimeout(() => { statusText.value = ''; statusKind.value = ''; }, 5000);
}

// ===== 剧本地图模式 =====

async function enterScenarioMode() {
  // 从**知识库缓存**（<库>/.sitian/scenarios.json）载入剧本。
  // 🔴 必须走 `fillMissingOnly`（只补缺）：项目态下画布事实源是项目文件，
  //    库里同名的剧本 / 底图**不许**覆盖项目里已经编辑过的那一份 ——
  //    旧实现走默认的「新值赢」合并，紧接着 `saveScenarios()` 把覆盖结果推给项目并落盘，
  //    于是「每次启动后第一次点『历史剧本』」都会把用户的剧本与底图编辑**静默回退**。
  //    「同 key 覆盖」留给用户在剧本工具栏明确按下的「导入剧本数据（合并：同 key 覆盖）」。
  const result = await window.sitianAPI.loadScenarios();
  if (result?.success && result.data) {
    store.importFromScenariosJson(result.data, { fillMissingOnly: true });
  }
  scenarioMode.value = true;
}

function exitScenarioMode() {
  scenarioMode.value = false;
}

function handleDeleteWorld(world) {
  const childCount = store.starDomains.filter(d => d.parentId === world.id).length;
  const msg = `确定删除世界「${world.name}」吗？\n\n` +
    (childCount > 0 ? `该世界下有 ${childCount} 个星域（及其星系/行星）将失去上级关联。\n` : '') +
    `仅从地图缓存移除，不删除 Obsidian 文件。可撤销。`;
  if (!confirm(msg)) return;
  store.removeNode(world.id);
  dirty.value = true;
  statusText.value = `世界「${world.name}」已从地图移除`;
  setTimeout(() => { statusText.value = ''; statusKind.value = ''; }, 4000);
}

// ===== 书签管理（R5，2026-09-26 修）=====
//
// 旧实现的三个问题，全在「点了没反应」这条线上：
//   ① `getActiveRenderer()` 只认三层 → 行星 / 区域 / 建筑内部拿到 null 就 `return`
//      （**静默**：不跳转、不提示、不报错）；那三层也没被组件暴露出来。
//   ② 后面那段「切换视图级别」用 `backToXxx()` —— 那是**往回退一层**，与书签记录的层级不是同一件事
//      （书签记 planet，`backToSystem()` 退到的是 system）。它排在 `if (!renderer) return` 之后，
//      实际一次都没跑到过。
//   ③ 图层状态被记下来了却**从没应用过**（`addBookmark` 存了 layerState，App 里没读）。
//
// 现在：书签额外记一个**锚点实体 id**（该视图此刻"站在"哪个实体上）。层级不同就先
// `focusEntityOnCanvas(anchorId)` 把视图切过去，再套相机；任何一步不成立都给**可见原因**。
//
// 层级 → 锚点节点的映射（与 store 的导航语义对齐；注意 `selectWorld` 落到的是 **domain** 层，
// `selectDomain` 落到 **system** 层 —— 命名是历史包袱，锚点必须按"focus 后会到哪一层"来选）：
//   domain → 世界节点 · system → 星域节点 · system_detail → 恒星系节点 · 其余 → 自身
const BOOKMARK_LEVEL_TEXT = {
  world: '世界选择页',
  domain: '星域总览',
  system: '域内恒星系总览',
  system_detail: '恒星系详情',
  planet: '行星地图',
  area: '区域地图',
  interior: '建筑内部',
};

function levelText(lv) {
  return BOOKMARK_LEVEL_TEXT[lv] || lv || '未知层级';
}

/** 当前视图"站在"哪个实体上（书签锚点；取不到则返回 null） */
function currentAnchorId() {
  switch (store.viewLevel) {
    case 'domain': return store.currentWorld?.id || null;
    case 'system': return store.currentDomain?.id || null;
    case 'system_detail': return store.currentSystem?.id || null;
    case 'planet': return store.currentPlanet?.id || null;
    case 'area': return store.currentArea?.id || null;
    case 'interior': return store.currentBuilding?.id || null;
    default: return null;
  }
}

// 状态栏回音（书签相关的一次性提示；后一条消息不会被前一条的定时器误清）
let bookmarkStatusTimer = null;
function bookmarkStatus(text, kind = '') {
  statusText.value = text;
  statusKind.value = kind;
  if (bookmarkStatusTimer) clearTimeout(bookmarkStatusTimer);
  bookmarkStatusTimer = setTimeout(() => {
    if (statusText.value === text) { statusText.value = ''; statusKind.value = ''; }
  }, 6000);
}

function handleAddBookmark() {
  const renderer = getActiveRenderer();
  if (!renderer) {
    bookmarkStatus(scenarioMode.value
      ? '历史剧本没有视口书签（书签服务的是六层地图视图）'
      : `「${levelText(store.viewLevel)}」没有可记录的画布 —— 先进入星域总览或更下层`, 'err');
    return;
  }

  const vt = renderer.getViewTransform();
  addBookmark(
    `书签 ${bookmarks.value.length + 1}`,
    vt,
    store.viewLevel,
    layersStore.layers,
    null,
    currentAnchorId(),
  );
  bookmarkStatus(`书签已添加（${levelText(store.viewLevel)}）`, 'ok');
}

/** 把书签的相机套到 renderer 上（viewTransform 存的是 translate，focusOn 要的是世界中心） */
function applyBookmarkCamera(renderer, bm) {
  const s = bm.viewTransform?.scale || 1;
  renderer.focusOn(-(bm.viewTransform?.x || 0) / s, -(bm.viewTransform?.y || 0) / s, s);
}

/** 恢复书签记录时的图层可见性（旧版记了却没用过） */
function applyBookmarkLayers(bm) {
  if (!bm.layerState) return;
  Object.entries(bm.layerState).forEach(([view, layers]) => {
    Object.entries(layers || {}).forEach(([layerId, cfg]) => {
      if (layersStore.layers[view]?.[layerId] && cfg && typeof cfg.visible === 'boolean') {
        layersStore.layers[view][layerId].visible = cfg.visible;
      }
    });
  });
}

function handleBookmarkNavigate(bm) {
  if (!bm || !bm.viewTransform) {
    bookmarkStatus('这条书签的数据不完整，无法跳转', 'err');
    return;
  }

  // ── 同层：直接用当前画布（最常见路径，不碰视图导航）──
  if (bm.viewLevel === store.viewLevel) {
    const renderer = getActiveRenderer();
    if (!renderer) {
      bookmarkStatus(`书签属于「${levelText(bm.viewLevel)}」，但当前没有可用的画布`, 'err');
      return;
    }
    applyBookmarkCamera(renderer, bm);
    applyBookmarkLayers(bm);
    bookmarkStatus(`已跳转到书签（${levelText(bm.viewLevel)}）`, 'ok');
    panelsStore.close('bookmarks');
    return;
  }

  // ── 跨层：先按锚点把视图切过去 ──
  if (!bm.anchorId) {
    bookmarkStatus(
      `这条书签记于「${levelText(bm.viewLevel)}」，但没记录定位锚点（早期版本的书签）——`
      + '请切到那一层重新添加', 'err');
    return;
  }

  const r = store.focusEntityOnCanvas?.(bm.anchorId);
  if (!r || !r.ok) {
    bookmarkStatus(`无法跳转到书签：${(r && r.error) || '定位失败'}`, 'err');
    return;
  }

  // 视图是 `v-if` + 异步组件，切换后画布要等一拍才就绪 → nextTick 再套相机
  nextTick(() => {
    const renderer = getActiveRenderer();
    if (!renderer) {
      bookmarkStatus(`已切到「${levelText(store.viewLevel)}」，但该视图的画布尚未就绪`, 'err');
      return;
    }
    applyBookmarkCamera(renderer, bm);
    applyBookmarkLayers(bm);
    if (bm.viewLevel !== store.viewLevel) {
      // 锚点只能定位到实体，落点层级与书签层级不一致时**如实说明**，不假装成功
      bookmarkStatus(
        `书签记于「${levelText(bm.viewLevel)}」，已切到「${levelText(store.viewLevel)}」`
        + '（层级不同，相机按原比例套用）', 'warn');
    } else {
      bookmarkStatus(`已跳转到书签（${levelText(bm.viewLevel)}）`, 'ok');
    }
  });
  panelsStore.close('bookmarks');
}

function handleRemoveBookmark(id) {
  removeBookmark(id);
  bookmarkStatus('书签已删除');
}

function handleClearBookmarks() {
  clearAll();
  bookmarkStatus('所有书签已清除');
}

// 暴露到全局
window.runStressTest = runStressTest;
window.cleanupStressTest = cleanupStressTest;

onMounted(async () => {
  statusText.value = '正在加载数据...';
  initTheme();
  // 免责声明：未确认**当前版本**条款 → 立刻阻断（必须在数据加载与新手引导之前）
  if (!hasAckedDisclaimer()) {
    window.__sitianDisclaimerGate = true;
    disclaimerMode.value = 'gate';
    disclaimerOpen.value = true;
  }
  window.__sitianSplash?.set?.(65, '正在加载世界数据…');
  try {
    await store.loadGeodata();
    statusText.value = `已加载 ${store.nodes.length} 个节点`;
  } catch (e) {
    // 加载失败必须显式暴露：否则界面只是「空地图」，用户与测试都看不出原因
    // （历史上 preload/ mock 未就绪时正是这样静默留在 0 节点）
    statusText.value = `数据加载失败：${e?.message || e}`;
    statusKind.value = 'err';   // 曾误写 'error'（模板只认 ok/err/warn）→ 该提示长期无图标
    window.sitianAPI?.reportError?.({ message: String(e?.message || e), stack: e?.stack, component: 'App.onMounted' });
  } finally {
    // 数据就绪（或加载失败）后关闭启动 splash（批次A10，finally 保证不会卡在加载画面）
    window.__sitianSplash?.set?.(100, '就绪');
    nextTick(() => window.__sitianSplash?.close?.());
  }
  // 启动时恢复上次打开的项目（B4，2026-09-24）：没有记录 / 文件已被删除或移动 / 解析失败，
  // 一律**静默回落只读**并说明原因 —— 启动期绝不因为"上次那个项目找不到了"而卡住或报错。
  try {
    const r = await restoreLastProject();
    if (r && r.success) {
      statusText.value = `已恢复上次的项目：${String(r.path).split(/[\\/]/).pop()}`;
      statusKind.value = 'ok';
    } else if (r && r.reason === 'missing') {
      statusText.value = '上次打开的项目文件已不存在（可能被移动或删除）—— 已回到只读浏览';
      statusKind.value = 'warn';
    }
  } catch (e) { /* 静默：恢复失败不能影响启动 */ }

  window.addEventListener('keydown', handleGlobalKeydown);
  window.addEventListener('keydown', handlePerfKeydown);

  // Vault 监听事件（项目态下画布事实源是项目文件，store 侧会拦掉这些事件并返回 false → 给用户回音）
  cleanupNodeUpdated = window.sitianAPI.onNodeUpdated((data) => {
    const applied = store.handleNodeUpdated(data.node);
    statusText.value = applied === false
      ? '知识库已变更（当前打开的是项目，画布不受影响；如需带入请用「导入知识库内容」）'
      : `已更新: ${data.node.name}`;
    statusKind.value = applied === false ? 'warn' : 'ok';
  });
  cleanupNodeRemoved = window.sitianAPI.onNodeRemoved((data) => {
    const applied = store.handleNodeRemoved(data.nodeId);
    statusText.value = applied === false
      ? '知识库已变更（当前打开的是项目，画布不受影响）'
      : `已删除节点`;
    statusKind.value = applied === false ? 'warn' : 'ok';
  });

  // 性能面板定时更新
  perfUpdateTimer = setInterval(() => {
    if (perfVisible.value) {
      const renderer = getActiveRenderer();
      if (renderer?.getPerfStats) {
        perfStats.value = renderer.getPerfStats();
      }
    }
  }, 250);

  // 设置面板事件
  window.addEventListener('sitian:reextract', () => {
    reextract();
  });
  window.addEventListener('sitian:validate-data', () => {
    validateDataIntegrity();
  });
  window.addEventListener('sitian:backup-cache', () => {
    performBackup();
  });
  window.addEventListener('sitian:open-batch-import', () => {
    batchImportPanelRef.value?.open();
  });
  window.addEventListener('sitian:clear-cache', () => {
    clearCoordinateCache();
  });

  // 系统托盘菜单 → 打开面板（托盘图标右键菜单触发）
  // 注意：用 ?. 守卫 —— preload 缺该 API 时（老版本 preload / 测试 mock）不能让
  // onMounted 抛错，否则后续初始化与数据加载链路会被静默中断
  window.sitianAPI?.onOpenSettings?.(() => settingsPanelRef.value?.open());
  window.sitianAPI?.onOpenAbout?.(() => aboutPanelRef.value?.open());
  // 关于面板中的检查更新按钮
  window.addEventListener('sitian:check-update', () => {
    updateNotificationRef.value?.checkForUpdates();
  });
  // PlanetMap 本地面板打开时，关闭 App 层浮层面板（面板互斥）
  window.addEventListener('sitian:panel-open', closeAppPanels);
  // 引导/空态把用户送到项目面板（B2/B3）
  window.addEventListener('sitian:open-project-panel', handleOpenProjectPanel);
  // 免责声明入口（关于面板 / 设置面板共用同一通道）
  window.addEventListener('sitian:open-disclaimer', openDisclaimerView);
  // 项目侧告警（如「会话基线未能创建」= 失去回滚点）→ 状态栏提醒，别让它静默
  window.addEventListener('sitian:project-warning', (e) => {
    const msg = e?.detail?.message;
    if (!msg) return;
    statusText.value = msg;
    statusKind.value = 'warn';
    setTimeout(() => { if (statusText.value === msg) { statusText.value = ''; statusKind.value = ''; } }, 12000);
  });

  // 启动时静默备份 .sitian/ 缓存（P1-2 数据安全；主进程已自动备份，这里兜底确认）
  if (window.sitianAPI?.backupSitianCache) {
    window.sitianAPI.backupSitianCache().catch(() => {});
  }
  document.addEventListener('click', handleClickOutside);

  // 退出前落盘（数据安全承诺）：主进程在真正 quit 前会等这里回执（2.5s 超时则直接放行）。
  // 画布未落盘的编辑（含还在防抖窗口里的行星地图/剧本）与 dirty 的项目文件都在这里写完。
  window.sitianAPI?.onFlushBeforeQuit?.(async (reason) => {
    let failed = [];
    try {
      const results = await flushAll(reason);
      failed = results
        .filter(r => r.ok === false)
        .map(r => ({ name: r.name, error: r.error || (r.result && r.result.error) || '' }));
      if (failed.length) console.warn('[quit] 有改动未能落盘:', failed);
    } catch (err) {
      console.warn('[quit] 退出前落盘异常:', err);
      failed = [{ name: 'flushAll', error: (err && err.message) || String(err) }];
    }
    // 🔴 必须把失败一并回执给主进程（2026-09-24 修）：主进程据此弹**原生对话框**。
    //    旧实现只 console.warn 就照常退出 —— 窗口随即关闭，用户以为「已正常退出、改动已保存」，
    //    实际未落盘；这是唯一能触达用户的时机（渲染层可能已经不可见了）。
    try { window.sitianAPI?.notifyFlushDone?.({ failed }); } catch (e) { /* noop */ }
  });
});

function closeAppPanels() {
  panelsStore.closeAll();
}

/**
 * 把用户送到「项目」面板（B2/B3，2026-09-24）。
 * 为什么不在这里直接新建/打开项目：App.vue 有一条静态闸门 —— **不得 import projectStore**
 * （只有面板/组件才连项目 store）。所以 App 只负责"送人过去"，执行者仍是面板。
 */
function handleOpenProjectPanel() {
  if (!panelsStore.isOpen('project')) panelsStore.toggle('project');
}

/** 只读态下的「新建项目」：面板才是执行者 */
function handleCreateProject() {
  handleOpenProjectPanel();
  statusText.value = '在项目面板填个名字点「新建」即可（或点「新建并导入知识库内容」把现有词条一并带进来）';
  statusKind.value = 'warn';
}

/** 只读态下的「打开项目」 */
function handleOpenProject() {
  handleOpenProjectPanel();
  statusText.value = '在项目面板点「打开项目…」选择 .sitian 文件';
  statusKind.value = 'warn';
}

/** 同步面板 → 项目面板（面板里「还没有可同步的目录」时的去处） */
function openProjectFromSync() {
  panelsStore.close('git-sync');
  panelsStore.toggle('project');
}

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeydown);
  window.removeEventListener('keydown', handlePerfKeydown);
  cleanupNodeUpdated?.();
  cleanupNodeRemoved?.();
  if (perfUpdateTimer) clearInterval(perfUpdateTimer);
  window.removeEventListener('sitian:panel-open', closeAppPanels);
  window.removeEventListener('sitian:open-project-panel', handleOpenProjectPanel);
  document.removeEventListener('click', handleClickOutside);
  window.removeEventListener('beforeunload', handleBeforeUnload);
});

function handleBeforeUnload(e) {
  // ⚠️ 刻意**不**再 preventDefault：在 Electron 里阻止 beforeunload = 窗口静默关不掉
  //    （不会弹对话框，用户只能去任务管理器强杀）—— 那比丢数据更糟。
  //    未落盘的改动改由「主进程 quit 前 flush」保障（main/index.js 的 before-quit → quitFlush）。
  if (dirty.value) {
    console.warn('[quit] 仍有未落盘的画布改动：已交给退出前 flush 处理');
  }
}

function handleGlobalKeydown(e) {
  // 免责声明阻断态：Esc 与 F1 一律吞掉。弹窗自己已拦住「Esc 关闭」，
  // 这里再挡一次是为了不让全局 Escape 去 closeAll() 别的面板、
  // 也不让 F1 在模态后面把关于面板打开（两层浮层同屏）。
  if (isDisclaimerGateOpen.value) {
    if (e.key === 'Escape' || e.key === 'F1') {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
  }
  // 输入类元素聚焦时，除 F1/Escape 外全部让路：
  // 修复搜索框/重命名框里打 l/m 误开面板、Ctrl+Z 撤的是地图数据而非文字
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  if (e.key === 'F1') {
    e.preventDefault();
    aboutPanelRef.value?.open();
    return;
  }
  if (e.key === 'Escape') {
    panelsStore.closeAll();
    return;
  }
  if (typing) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    store.undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
    e.preventDefault();
    store.redo();
    return;
  }
  if (e.key === 'l' || e.key === 'L') {
    if (store.viewLevel === 'domain' || store.viewLevel === 'system' || store.viewLevel === 'system_detail' || store.viewLevel === 'planet') {
      e.preventDefault();
      toggleLayersPanel();
    }
  }
  if (e.key === 'm' || e.key === 'M') {
    if (store.viewLevel !== 'world') {
      e.preventDefault();
      panelsStore.toggle('bookmarks');
    }
  }
}

function handlePerfKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'D') {
    e.preventDefault();
    perfVisible.value = !perfVisible.value;
  }
}

async function reextract() {
  statusText.value = '正在重新提取...';
  const res = await store.reextract();
  // ⚠️ 必须看返回值：只读态 / 已打开项目时 reextract 会**拒绝执行**（gate 或事实源冲突），
  // 旧实现忽略返回值照样打印「已更新 N 个节点」= 谎报成功（用户实测「点了没有任何反应」的真因）。
  if (res && res.ok === false) {
    statusText.value = res.error || '重新提取被拒绝';
    statusKind.value = 'err';
    return;
  }
  dirty.value = false;
  statusText.value = `已更新 ${store.nodes.length} 个节点`;
  statusKind.value = 'ok';
}

async function saveData() {
  // ⚠️ 必须**按返回值**说话（2026-09-24 修，B6）：项目态下 `saveGeodata()` 只是把改动**推给 projectStore**，
  //    真正的落盘由它的 800ms 防抖自动保存完成（返回 `staged:true / persisted:false`）。
  //    旧实现不看返回值、无条件打印「已保存」并把 dirty 清掉 = 谎报成功。
  const r = await store.saveGeodata();
  if (r && r.success === false) {
    statusText.value = `保存失败：${r.error || '未知原因'}`;
    statusKind.value = 'err';
    return;                     // 失败时**不清 dirty** —— 还有未落盘的改动，用户必须能看出来
  }
  dirty.value = false;
  if (r && r.staged) {
    statusText.value = '已交给项目，正在写入磁盘…';
    statusKind.value = 'warn';
  } else {
    statusText.value = '已保存';
    statusKind.value = 'ok';
  }
}

// ===== 数据备份（P1-2）：.sitian/ → .sitian/backups/ 带时间戳 =====
async function performBackup() {
  if (!window.sitianAPI?.backupSitianCache) return;
  statusText.value = '正在备份数据...';
  try {
    const result = await window.sitianAPI.backupSitianCache();
    if (result?.success) {
      statusText.value = result.count > 0
        ? `已备份 ${result.count} 个文件 → ${result.backupDir}`
        : '备份完成（当前无缓存文件）';
      statusKind.value = 'ok';
    } else {
      statusText.value = `备份失败: ${result?.error || '未知错误'}`;
      statusKind.value = 'err';
    }
  } catch (e) {
    statusText.value = '备份失败';
    statusKind.value = 'err';
  }
}

// ===== 数据完整性检查 =====
function validateDataIntegrity() {
  const nodes = store.nodes;
  const issues = [];
  
  // 孤立节点（parentId 指向不存在的节点）
  const nodeIds = new Set(nodes.map(n => n.id));
  for (const node of nodes) {
    if (node.parentId && !nodeIds.has(node.parentId)) {
      issues.push({ type: 'broken-parent', node: node.name, detail: `parentId "${node.parentId}" 不存在` });
    }
  }
  
  // 重复 ID
  const idCounts = {};
  for (const node of nodes) {
    idCounts[node.id] = (idCounts[node.id] || 0) + 1;
  }
  for (const [id, count] of Object.entries(idCounts)) {
    if (count > 1) {
      issues.push({ type: 'duplicate-id', detail: `ID "${id}" 出现 ${count} 次` });
    }
  }
  
  // 坐标异常
  for (const node of nodes) {
    const x = node.coordinate?.x;
    const y = node.coordinate?.y;
    if (x !== null && (typeof x !== 'number' || !isFinite(x) || Math.abs(x) > 10000)) {
      issues.push({ type: 'invalid-coord', node: node.name, detail: `X 坐标异常: ${x}` });
    }
    if (y !== null && (typeof y !== 'number' || !isFinite(y) || Math.abs(y) > 10000)) {
      issues.push({ type: 'invalid-coord', node: node.name, detail: `Y 坐标异常: ${y}` });
    }
  }
  
  // 显示结果
  if (issues.length === 0) {
    alert('数据完整性检查通过，未发现问题。');
    statusText.value = '数据检查完成：无问题';
  } else {
    const summary = `发现 ${issues.length} 个问题:\n\n` + issues.slice(0, 10).map(i => `• [${i.type}] ${i.node ? i.node + ' - ' : ''}${i.detail}`).join('\n');
    alert(summary);
    statusText.value = `数据检查完成：${issues.length} 个问题`;
  }
}

// ===== 清除坐标缓存 =====
async function clearCoordinateCache() {
  // 删除 geodata.json 和 mapdata.json 的缓存 —— 属落盘写，只读态必须拒绝（Phase 2.4：清单第 11 条）
  const gate = guardWrite('清除坐标缓存');
  if (!gate.ok) {
    statusText.value = gate.error;
    return;
  }
  // 通过主进程 API 删除文件
  try {
    await window.sitianAPI.clearCoordinateCache();
    // 重置内存地图缓存（loadMapData 的短路缓存依赖此处失效，批次A3）
    store.mapData = {};
    // 重新加载
    await store.loadGeodata();
    statusText.value = '坐标缓存已清除，数据已重新提取';
    dirty.value = false;
  } catch (e) {
    console.error('Failed to clear cache:', e);
    alert('清除缓存失败: ' + e.message);
  }
}
</script>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--app-bg);
  color: var(--text-primary);
}

.theme-dark {
  --app-bg: #0d1117;
  --toolbar-bg: #161b22;
  --toolbar-border: #30363d;
  --nav-bg: #161b22;
  --nav-border: #30363d;
  --btn-bg: #21262d;
  --btn-bg-hover: #30363d;
  --text-primary: #e2e8f0;
  --text-secondary: #c9d1d9;
  --text-tertiary: #8b949e;
  --accent: #58a6ff;
  --accent-bg: #388bfd22;
  --separator: #484f58;
  --panel-bg: #161b22;
  --panel-border: #30363d;
  --panel-header-bg: #0d1117;
  --input-bg: #0d1117;
  --input-border: #30363d;
  /* GalaxyMap / SystemView shared */
  --map-bg: #0c1020;
  --map-header-bg: #101828;
  --map-header-border: #1e2d45;
  --map-btn-bg: #1a2540;
  --map-btn-border: #2a3a55;
  --map-btn-hover: #253555;
  --map-btn-text: #d0d8e8;
  --map-text-heading: #f0f6fc;
  --map-text-hint: #8b9ab0;
  --map-accent-green: #7affb4;
  --map-accent-green-bg: #0d4718;
  --map-accent-green-border: #2ea043;
  --map-accent-blue: #58a6ff;
  --map-panel-shadow: rgba(0,0,0,0.5);
  --map-filter-border: #3a4a65;
  /* PlanetMap */
  --planet-bg: #E8F4F8;
  --planet-header-bg: rgba(255,255,255,0.6);
  --planet-header-border: #C8E6C9;
  --planet-text: #2D3436;
  --planet-text-secondary: #636E72;
  --planet-text-link: #5B8DEF;
  --planet-btn-bg: white;
  --planet-btn-border: #C8E6C9;
  --planet-btn-hover: #F0F7F4;
  --planet-btn-active-bg: #4ECDC4;
  --planet-btn-active-border: #4ECDC4;
  --planet-editor-bg: rgba(255,255,255,0.95);
  --planet-editor-border: #e0e0e0;
  --planet-input-bg: #fff;
  --planet-input-border: #ddd;
  --planet-input-focus: #5B8DEF;
  --planet-tag-bg: #E8F4F8;
  --planet-tag-border: #C8E6C9;
  /* ===== 设计令牌（P0-1）：间距/圆角/阴影/z-index/玻璃面板 ===== */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 10px;
  --radius-xl: 12px;
  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.2);
  --shadow-md: 0 4px 16px rgba(0, 0, 0, 0.35);
  --shadow-lg: 0 12px 40px rgba(0, 0, 0, 0.5);
  --z-eagle: 20;
  --z-panel: 30;
  --z-context-menu: 100;
  --z-modal: 900;
  --panel-glass: rgba(255, 255, 255, 0.8);
  --panel-glass-strong: rgba(255, 255, 255, 0.95);
  --panel-glass-soft: rgba(255, 255, 255, 0.6);
}

.theme-light {
  --app-bg: #ffffff;
  --toolbar-bg: #f6f8fa;
  --toolbar-border: #d0d7de;
  --nav-bg: #f6f8fa;
  --nav-border: #d0d7de;
  --btn-bg: #f6f8fa;
  --btn-bg-hover: #eaeef2;
  --text-primary: #1f2328;
  --text-secondary: #656d76;
  --text-tertiary: #8c959f;
  --accent: #0969da;
  --accent-bg: #ddf4ff;
  --separator: #d0d7de;
  --panel-bg: #ffffff;
  --panel-border: #d0d7de;
  --panel-header-bg: #f6f8fa;
  --input-bg: #ffffff;
  --input-border: #d0d7de;
  /* GalaxyMap / SystemView shared */
  --map-bg: #f0f4f8;
  --map-header-bg: #ffffff;
  --map-header-border: #e2e8f0;
  --map-btn-bg: #f6f8fa;
  --map-btn-border: #d0d7de;
  --map-btn-hover: #eaeef2;
  --map-btn-text: #1f2328;
  --map-text-heading: #1f2328;
  --map-text-hint: #656d76;
  --map-accent-green: #2ea043;
  --map-accent-green-bg: #dafbe1;
  --map-accent-green-border: #2ea043;
  --map-accent-blue: #0969da;
  --map-panel-shadow: rgba(0,0,0,0.1);
  --map-filter-border: #d0d7de;
  /* PlanetMap */
  --planet-bg: #E8F4F8;
  --planet-header-bg: rgba(255,255,255,0.6);
  --planet-header-border: #C8E6C9;
  --planet-text: #2D3436;
  --planet-text-secondary: #636E72;
  --planet-text-link: #5B8DEF;
  --planet-btn-bg: white;
  --planet-btn-border: #C8E6C9;
  --planet-btn-hover: #F0F7F4;
  --planet-btn-active-bg: #4ECDC4;
  --planet-btn-active-border: #4ECDC4;
  --planet-editor-bg: rgba(255,255,255,0.95);
  --planet-editor-border: #e0e0e0;
  --planet-input-bg: #fff;
  --planet-input-border: #ddd;
  --planet-input-focus: #5B8DEF;
  --planet-tag-bg: #E8F4F8;
  --planet-tag-border: #C8E6C9;
  /* ===== 设计令牌（P0-1）：与暗色主题一致 ===== */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 10px;
  --radius-xl: 12px;
  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.15);
  --shadow-md: 0 4px 16px rgba(0, 0, 0, 0.18);
  --shadow-lg: 0 12px 40px rgba(0, 0, 0, 0.25);
  --z-eagle: 20;
  --z-panel: 30;
  --z-context-menu: 100;
  --z-modal: 900;
  --panel-glass: rgba(255, 255, 255, 0.8);
  --panel-glass-strong: rgba(255, 255, 255, 0.95);
  --panel-glass-soft: rgba(255, 255, 255, 0.6);
}

.app-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.main-content {
  flex: 1;
  overflow: hidden;
}

/* 视图切换进入动画（P2-3）：v-if 重新挂载时淡入 + 轻微上移，一次触发不影响交互 */
.main-content > * {
  animation: view-fade-in 0.28s ease-out;
}
@keyframes view-fade-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: var(--toolbar-bg);
  border-bottom: 1px solid var(--toolbar-border);
  gap: 16px;
  position: relative;
}

.toolbar h1 {
  font-size: 16px;
  color: var(--accent);
  min-width: 60px;
}

.toolbar-center {
  flex: 1;
  display: flex;
  justify-content: center;
}

.toolbar-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 280px;
  justify-content: flex-end;
}

/* 只读徽标（决策 1 终态）：与状态栏 sb-readonly 同一套配色语义（--warning），
   但必须常驻工具栏 —— 世界/选择视图没有状态栏，用户在那里最需要知道「现在只能读」。
   点击可达去处（项目面板），不是死标。 */
.toolbar-actions .readonly-badge {
  height: 24px;
  padding: 0 9px;
  border-radius: 12px;
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  color: var(--warning, #d29922);
  background: color-mix(in srgb, var(--warning, #d29922) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning, #d29922) 45%, transparent);
}
.toolbar-actions .readonly-badge:hover {
  background: color-mix(in srgb, var(--warning, #d29922) 26%, transparent);
}

/* 图层按钮呼吸光圈（高频功能视觉指引） */
.toolbar-actions button[title*="图层面板"] {
  animation: layer-pulse 3s ease-in-out infinite;
}

/* 只读态常驻提示条：全宽、大字、可点（详见模板注释）
   颜色语义与工具栏只读徽标一致（--warning），但字号明显更大 —— 「小字提示」已被用户明确否掉。 */
.readonly-notice {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px 16px;
  cursor: pointer;
  user-select: none;
  color: var(--warning, #d29922);
  background: color-mix(in srgb, var(--warning, #d29922) 15%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--warning, #d29922) 45%, transparent);
}
.readonly-notice:hover {
  background: color-mix(in srgb, var(--warning, #d29922) 26%, transparent);
}
.readonly-notice .rn-main {
  font-size: 15px;
  font-weight: 700;
}
.readonly-notice .rn-sub {
  font-size: 12.5px;
  color: var(--text-secondary);
}
.readonly-notice .rn-go {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--accent);
  white-space: nowrap;
}

@keyframes layer-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(88, 166, 255, 0); }
  50% { box-shadow: 0 0 0 4px rgba(88, 166, 255, 0.3); }
}

.toolbar-actions button {
  padding: 5px 10px;
  border: 1px solid var(--toolbar-border);
  border-radius: var(--radius-sm);
  background: var(--btn-bg);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
}

.toolbar-actions button:hover {
  background: var(--btn-bg-hover);
}

.toolbar-actions button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 工具栏分组分隔线（P0-1） */
.toolbar-divider {
  width: 1px;
  height: 18px;
  background: var(--toolbar-border);
  margin: 0 2px;
  flex-shrink: 0;
}

.level-indicator {
  display: flex;
  flex-wrap: wrap; /* 深层级放不下时整段换行，而不是把按钮文字压成竖排 */
  gap: 2px 6px;
  align-items: center;
  font-size: 13px;
  position: relative;
}

.level-indicator button {
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 160px;
  min-width: 0;
}

.level-indicator button:hover {
  color: var(--accent);
  background: var(--btn-bg);
}

.level-indicator button.active {
  color: var(--accent);
  background: var(--accent-bg);
  max-width: none; /* 当前层名称完整显示，由非当前层收缩让位 */
}

.separator {
  color: var(--separator);
  font-size: 14px;
}

/* 面包屑下拉菜单 */
.breadcrumb-item {
  display: flex;
  align-items: center;
  gap: 2px;
  position: relative;
}

.dropdown-arrow {
  font-size: 10px;
  color: var(--text-tertiary);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: var(--radius-sm);
  opacity: 0.5;
  transition: opacity 0.1s ease;
}

.dropdown-arrow:hover {
  opacity: 1;
  color: var(--accent);
}

.dropdown-menu {
  position: absolute;
  top: 100%;
  left: 0;
  min-width: 180px;
  max-height: 300px;
  overflow-y: auto;
  background: var(--nav-bg, #1c2128);
  border: 1px solid var(--nav-border, #30363d);
  border-radius: var(--radius-md);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  z-index: 1000;
  margin-top: 4px;
  padding: 4px 0;
}

.dropdown-menu div {
  padding: 6px 12px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary);
  transition: background 0.1s ease;
}

.dropdown-menu div:hover {
  background: var(--btn-bg-hover);
  color: var(--text-primary);
}

.dropdown-menu div.current {
  color: var(--accent);
  background: var(--accent-bg, rgba(88, 166, 255, 0.1));
  font-weight: 600;
}

.status {
  font-size: 11px;
  color: var(--text-tertiary);
  white-space: nowrap;
}

/* 导出菜单 */
.export-menu {
  position: absolute;
  top: 50px;
  right: 16px;
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-md);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  z-index: var(--z-context-menu);
  box-shadow: var(--shadow-md);
}

.export-menu button {
  padding: 8px 16px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--btn-bg);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
  text-align: left;
}

.export-divider {
  height: 1px;
  background: var(--panel-border);
  margin: 4px 0;
}

.export-menu button:hover {
  background: var(--btn-bg-hover);
}

/* 性能统计面板 */
.perf-panel {
  position: fixed;
  bottom: 16px;
  right: 16px;
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-md);
  padding: 12px;
  font-size: 11px;
  color: var(--text-secondary);
  z-index: 100;
  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
}

.perf-title {
  font-weight: bold;
  margin-bottom: 8px;
  color: var(--text-primary);
}

.perf-row {
  margin-bottom: 4px;
}

.perf-row b {
  color: var(--accent);
}
</style>

<!-- 全局面板动画（P1-3）：非 scoped，供所有浮层面板组件引用 -->
<style>
@keyframes sitian-panel-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
/* 浮层面板统一入场动画 + 统一阴影由各面板组件各自 box-shadow 令牌控制 */
.export-menu,
.bookmarks-panel,
.layer-panel,
.cluster-panel,
.object-panel,
.snapshot-panel,
.province-editor,
.context-menu,
.search-results-panel,
.no-results-panel,
.filter-panel,
.filter-panel-galaxy,
.perf-panel {
  animation: sitian-panel-in 0.15s ease-out;
}
</style>
