<template>
  <div class="planet-map-container" @mousedown="handlePanelHeaderDrag">
    <div class="map-header">
      <div class="header-left">
        <h2>{{ planet?.name }} — 行星地图</h2>
        <p class="hint">
          <template v-if="!editMode">
            点击省份选中 · 点击地点查看详情 · 双击在 Obsidian 打开 · 滚动缩放 · 拖拽平移 · <a href="#" @click.prevent="enterEditMode">编辑地图</a>
          </template>
          <template v-else>
            <strong>编辑模式</strong> — 
            {{ isDrawing ? '正在绘制...' : '按住拖动绘制省份边界，松开自动闭合' }}
            · <a href="#" @click.prevent="exitEditMode">退出编辑</a>
          </template>
        </p>
      </div>
      <div class="header-actions" v-if="!editMode && autoRegions.length > 0">
        <button class="adopt-btn" @click="adoptAutoRegions" title="将自动生成的区域边界转为正式区域，可继续编辑">
          ✨ 采用自动区域 ({{ autoRegions.length }})
        </button>
        <button class="adopt-btn ghost" @click="regenerateAutoRegions" title="重新按地点聚类生成区域边界">
          ↻ 重新生成
        </button>
      </div>
    </div>
    
    <!-- 编辑工具栏（可收起，腾出地图空间） -->
    <div v-if="editMode" class="edit-toolbar-wrap">
      <button
        v-if="toolbarCollapsed"
        class="toolbar-toggle"
        @click="toolbarCollapsed = false"
        title="展开编辑工具栏"
      >🧰 编辑工具 ▾</button>
      <div v-else class="edit-toolbar">
      <button :class="{ active: interactionMode === 'pan' }" @click="setInteractionMode('pan')" title="拖动画布 (空格临时切换)">🤚 拖手</button>
      <button :class="{ active: interactionMode === 'move' }" @click="setInteractionMode('move')" title="移动对象：点击选中地点/标记/文本/区域，拖动移动；空白处拖动画布">✥ 移动</button>
      <button :class="{ active: interactionMode === 'draw' }" @click="setInteractionMode('draw')" title="绘制省份">✏️ 绘制</button>
      <button :class="{ active: interactionMode === 'region' }" @click="setInteractionMode('region')" title="圈画区域">🗺️ 区域</button>
      <button :class="{ active: interactionMode === 'marker' }" @click="setInteractionMode('marker')" title="放置标记">📍 标记</button>
      <button :class="{ active: interactionMode === 'route' }" @click="setInteractionMode('route')" title="绘制路线">🛣️ 路线</button>
      <button :class="{ active: interactionMode === 'text' }" @click="setInteractionMode('text')" title="放置浮动文本">🔤 文本</button>
      <button :class="{ active: interactionMode === 'cluster' }" @click="setInteractionMode('cluster'); clusterPanelOpen = true; objectPanelOpen = false" title="框选地点创建簇 (拖动圈选)">🗂 簇</button>
      <button :class="{ active: objectPanelOpen }" @click="objectPanelOpen = !objectPanelOpen; clusterPanelOpen = false" title="对象列表：地形/标记/路线/文本管理">📋 对象</button>
      <button class="separator-btn" disabled></button>
      
      <template v-if="interactionMode === 'draw'">
        <button :class="{ active: drawMode && !floodFillMode && !brushMode }" @click="drawMode = true; floodFillMode = false; brushMode = false" title="按住拖动绘制">✏️ 自由绘制</button>
        <button :class="{ active: !drawMode && !floodFillMode && !brushMode }" @click="drawMode = false; floodFillMode = false; brushMode = false" title="点击放置顶点">📐 点击描点</button>
        <button :class="{ active: floodFillMode }" @click="floodFillMode = !floodFillMode; brushMode = false" title="点击空白处生成区域">🪣 区域填充</button>
        <button :class="{ active: brushMode }" @click="brushMode = !brushMode; floodFillMode = false" title="按住拖动地形笔刷涂抹">🖌 笔刷</button>
        <template v-if="brushMode">
          <span class="toolbar-label">大小</span>
          <button v-for="s in [24, 40, 64, 96]" :key="s" :class="{ active: brushSize === s }" @click="brushSize = s">{{ s }}</button>
        </template>
        <button class="separator-btn" disabled></button>
      </template>
      
      <template v-if="interactionMode === 'region'">
        <button :class="{ active: drawMode && !floodFillMode }" @click="drawMode = true; floodFillMode = false; brushMode = false" title="按住拖动绘制区域">✏️ 自由绘制</button>
        <button :class="{ active: !drawMode && !floodFillMode }" @click="drawMode = false; floodFillMode = false; brushMode = false" title="点击放置顶点">📐 点击描点</button>
        <button :class="{ active: floodFillMode }" @click="floodFillMode = !floodFillMode; brushMode = false" title="点击空白处自动生成区域">🪣 区域填充</button>
        <button class="separator-btn" disabled></button>
      </template>
      
      <template v-if="interactionMode === 'route'">
        <button :class="{ active: !routeDashed }" @click="routeDashed = false" title="实线（道路/边界）">➖ 实线</button>
        <button :class="{ active: routeDashed }" @click="routeDashed = true" title="虚线（航线/秘密路线）">〰️ 虚线</button>
        <span class="toolbar-label">颜色</span>
        <button
          v-for="c in ROUTE_COLORS"
          :key="c"
          :class="{ active: routeColor === c }"
          :style="{ background: c }"
          @click="routeColor = c"
          class="color-btn"
        ></button>
        <span class="toolbar-label">↗ 点击放置顶点 · 双击完成 · 右键取消</span>
      </template>
      
      <template v-if="interactionMode === 'text'">
        <span class="toolbar-label">字号</span>
        <button v-for="s in [12, 16, 22, 30]" :key="s" :class="{ active: textFontSize === s }" @click="textFontSize = s">{{ s }}px</button>
        <button
          v-for="c in TEXT_COLORS"
          :key="c"
          :class="{ active: textColor === c }"
          :style="{ background: c }"
          @click="textColor = c"
          class="color-btn"
        ></button>
        <span class="toolbar-label">↗ 点击放置文本</span>
      </template>
      
      <button v-if="interactionMode === 'draw'" :class="{ active: snapEnabled }" @click="snapEnabled = !snapEnabled" title="边缘吸附到相邻省份">🧲 吸附</button>
      
      <button @click="deleteSelected" :disabled="!selectedProvince && !selectedRegion && !selectedMarker && !selectedRoute && !selectedTextLabel" title="删除选中对象 (Del)">🗑 删除</button>
      <button v-if="selectedProvince || selectedRegion" @click="smoothPolygonBoundary" title="平滑边界为贝塞尔曲线">〰️ 平滑</button>
      <button class="separator-btn" disabled></button>
      <button @click="undo" :disabled="!store.canUndo" :title="'撤销: ' + undoLabel">↶ 撤销</button>
      <button @click="redo" :disabled="!store.canRedo">↷ 重做</button>
      <button class="separator-btn" disabled></button>
      <button @click="saveMap" title="保存地图">💾 保存</button>
      <button @click="confirmClear" title="清空所有省份">🧹 清空</button>
      <button class="separator-btn" disabled></button>
      <button :class="{ active: showRefImagePanel }" @click="showRefImagePanel = !showRefImagePanel" title="参考底图：导入手绘草图/大陆轮廓描摹">🖼 参考图</button>
      <button @click="exportFullMapPNG" title="导出全图高清 PNG（含全部省份/区域/路线/标记/文本）">📤 导出全图</button>
      <button class="separator-btn" disabled></button>
      <button class="toolbar-close" @click="toolbarCollapsed = true" title="收起工具栏，腾出地图空间">✕ 收起</button>
      </div>
    </div>
    
    <!-- 非编辑模式的导出按钮 -->
    <div v-if="!editMode" class="view-actions">
      <button class="adopt-btn" @click="clusterPanelOpen = !clusterPanelOpen; objectPanelOpen = false" title="地点簇大纲">🗂 地点簇</button>
      <button class="adopt-btn" :class="{ active: objectPanelOpen }" @click="objectPanelOpen = !objectPanelOpen; clusterPanelOpen = false" title="对象列表：地形/标记/路线/文本管理">📋 对象</button>
      <button class="adopt-btn" @click="exportFullMapPNG" title="导出全图高清 PNG">📤 导出全图</button>
    </div>
    
    <!-- 导出状态提示 -->
    <div v-if="exportStatus" class="export-status">{{ exportStatus }}</div>
    
    <!-- 地形类型选择器 -->
    <div v-if="editMode && interactionMode === 'draw'" class="terrain-picker">
      <span class="picker-label">省份地形：</span>
      <button 
        v-for="t in terrainTypes" 
        :key="t.type"
        :class="{ active: selectedTerrain === t.type }"
        :style="{ background: t.color }"
        @click="selectedTerrain = t.type"
      >{{ t.label }}</button>
    </div>
    
    <!-- 区域颜色选择器 -->
    <div v-if="editMode && interactionMode === 'region'" class="terrain-picker">
      <span class="picker-label">区域颜色：</span>
      <button 
        v-for="c in REGION_COLORS" 
        :key="c"
        :class="{ active: regionColor === c }"
        :style="{ background: c }"
        @click="regionColor = c"
        class="color-btn"
      ></button>
    </div>
    
    <!-- 标记类型选择器 -->
    <div v-if="editMode && interactionMode === 'marker'" class="terrain-picker">
      <span class="picker-label">标记类型：</span>
      <button 
        v-for="m in markerTypes" 
        :key="m.type"
        :class="{ active: selectedMarkerType === m.type }"
        @click="selectedMarkerType = m.type"
      ><span class="marker-icon">{{ m.icon }}</span> {{ m.label }}</button>
    </div>
    
    <div class="canvas-wrapper">
      <canvas ref="canvas"></canvas>
      <eagle-eye
        :view-bounds="viewBounds"
        :elements="eagleEyeElements"
        :world-bounds="worldBounds"
        @navigate="handleEagleEyeNavigate"
      />
      <cluster-panel
        :planet="props.planet"
        :open="clusterPanelOpen"
        :active-cluster-id="activeClusterId"
        :hover-member-id="hoverMemberId"
        @create-cluster="enterClusterMode"
        @focus-cluster="focusCluster"
        @toggle-collapse="toggleClusterCollapse"
        @hover-member="hoverMemberId = $event; renderer.requestRender()"
        @select-member="selectClusterMember"
        @edit-cluster="openClusterEditor"
        @disband-cluster="disbandCluster"
        @close="clusterPanelOpen = false"
      />
      <object-list-panel
        :planet="props.planet"
        :open="objectPanelOpen"
        :active-object-id="activeObjectId"
        @focus-object="focusObject"
        @rename-object="renameObject"
        @delete-object="deleteObject"
        @close="objectPanelOpen = false"
      />
    </div>
    
    <!-- 创建/编辑地点簇对话框 -->
    <div v-if="clusterEditorOpen" class="cluster-dialog-backdrop">
      <div class="cluster-dialog">
        <div class="editor-header">
          <h3>{{ editingCluster ? '编辑地点簇' : '创建地点簇' }}</h3>
          <button class="close-btn" @click="clusterEditorOpen = false">×</button>
        </div>
        <div class="editor-field">
          <label>名称</label>
          <input v-model="editingClusterName" placeholder="簇名称（如：周边村落）" />
        </div>
        <div class="editor-field">
          <label>颜色</label>
          <div class="terrain-selector">
            <button 
              v-for="c in CLUSTER_COLORS" 
              :key="c"
              :class="{ active: editingClusterColor === c }"
              :style="{ background: c }" 
              @click="editingClusterColor = c"
              class="color-btn"
            ></button>
          </div>
        </div>
        <div v-if="editingCluster" class="editor-field">
          <label>成员 ({{ editingCluster?.memberIds?.length || 0 }})</label>
          <div class="members-list">
            <span v-for="memberId in editingCluster?.memberIds || []" :key="memberId" class="member-tag">
              {{ getPlaceName(memberId) }}
            </span>
          </div>
        </div>
        <div class="dialog-actions">
          <button class="adopt-btn" @click="saveCluster">{{ editingCluster ? '保存' : '创建' }}</button>
          <button v-if="editingCluster" class="adopt-btn ghost" @click="disbandCluster(editingCluster.id)">解散簇</button>
        </div>
      </div>
    </div>
    
    <!-- 选中省份的属性编辑面板 -->
    <div v-if="editMode && selectedProvince" class="province-editor">
      <div class="editor-header">
        <h3>编辑省份</h3>
        <button class="close-btn" @click="selectedProvince = null">×</button>
      </div>
      <div class="editor-field">
        <label>名称</label>
        <input 
          v-model="editingName" 
          @input="updateProvinceName" 
          placeholder="省份名称"
        />
      </div>
      <div class="editor-field">
        <label>地形</label>
        <div class="terrain-selector">
          <button 
            v-for="t in terrainTypes" 
            :key="t.type"
            :class="{ active: selectedProvince?.type === t.type }"
            :style="{ background: t.color }" 
            @click="updateTerrainType(t.type)"
          >{{ t.label }}</button>
        </div>
      </div>
      <div class="editor-field">
        <label>描述</label>
        <textarea 
          v-model="editingDescription" 
          @input="updateProvinceDescription" 
          placeholder="省份描述（可选）"
          rows="3"
        ></textarea>
      </div>
    </div>
    
    <!-- 选中区域的属性编辑面板 -->
    <div v-if="editMode && selectedRegion" class="province-editor region-editor">
      <div class="editor-header">
        <h3>编辑区域</h3>
        <button class="close-btn" @click="selectedRegion = null">×</button>
      </div>
      <div class="editor-field">
        <label>名称</label>
        <input 
          v-model="editingRegionName" 
          @input="updateRegionName" 
          placeholder="区域名称"
        />
      </div>
      <div class="editor-field">
        <label>颜色</label>
        <div class="terrain-selector">
          <button 
            v-for="c in REGION_COLORS" 
            :key="c"
            :class="{ active: selectedRegion?.color === c }"
            :style="{ background: c }" 
            @click="updateRegionColor(c)"
            class="color-btn"
          ></button>
        </div>
      </div>
      <div class="editor-field">
        <label>描述</label>
        <textarea 
          v-model="editingRegionDescription" 
          @input="updateRegionDescription" 
          placeholder="区域描述（可选）"
          rows="3"
        ></textarea>
      </div>
      <div class="editor-field" v-if="selectedRegion?.members?.length">
        <label>包含地点 ({{ selectedRegion.members.length }})</label>
        <div class="members-list">
          <span v-for="memberId in selectedRegion.members" :key="memberId" class="member-tag">
            {{ getPlaceName(memberId) }}
          </span>
        </div>
      </div>
    </div>
    
    <!-- 选中标记的属性编辑面板 -->
    <div v-if="editMode && selectedMarker" class="province-editor marker-editor">
      <div class="editor-header">
        <h3>编辑标记</h3>
        <button class="close-btn" @click="selectedMarker = null">×</button>
      </div>
      <div class="editor-field">
        <label>名称</label>
        <input 
          v-model="editingMarkerName" 
          @input="updateMarkerName" 
          placeholder="标记名称（如：辉石矿脉）"
        />
      </div>
      <div class="editor-field">
        <label>类型</label>
        <div class="terrain-selector">
          <button 
            v-for="m in markerTypes" 
            :key="m.type"
            :class="{ active: selectedMarker?.type === m.type }"
            @click="updateMarkerType(m.type)"
          ><span class="marker-icon">{{ m.icon }}</span> {{ m.label }}</button>
        </div>
      </div>
      <div class="editor-field">
        <label>图标</label>
        <div class="icon-input-row">
          <input 
            v-model="editingMarkerIcon" 
            @input="updateMarkerIcon" 
            placeholder="自定义 emoji 图标"
            maxlength="4"
          />
          <button
            v-for="m in markerTypes"
            :key="'ic_' + m.type"
            class="icon-pick-btn"
            :class="{ active: editingMarkerIcon === m.icon }"
            @click="editingMarkerIcon = m.icon; updateMarkerIcon()"
          >{{ m.icon }}</button>
        </div>
      </div>
      <div class="editor-field">
        <label>颜色</label>
        <div class="terrain-selector">
          <button 
            v-for="c in MARKER_COLORS" 
            :key="c"
            :class="{ active: selectedMarker?.color === c }"
            :style="{ background: c }" 
            @click="updateMarkerColor(c)"
            class="color-btn"
          ></button>
        </div>
      </div>
      <div class="editor-field">
        <label>描述</label>
        <textarea 
          v-model="editingMarkerDesc" 
          @input="updateMarkerDesc" 
          placeholder="标记描述（可选）"
          rows="3"
        ></textarea>
      </div>
    </div>
    
    <!-- 选中路线的属性编辑面板 -->
    <div v-if="editMode && selectedRoute" class="province-editor route-editor">
      <div class="editor-header">
        <h3>编辑路线</h3>
        <button class="close-btn" @click="selectedRoute = null">×</button>
      </div>
      <div class="editor-field">
        <label>名称</label>
        <input 
          v-model="editingRouteName" 
          @input="updateRouteName" 
          placeholder="路线名称（如：商路）"
        />
      </div>
      <div class="editor-field">
        <label>文字标签（显示在路线中点）</label>
        <input 
          v-model="editingRouteLabel" 
          @input="updateRouteLabel" 
          placeholder="如：贸易路线·7日路程"
        />
      </div>
      <div class="editor-field">
        <label>标签偏移</label>
        <div class="offset-row">
          <span>X</span>
          <input type="number" v-model.number="editingRouteOffsetX" @input="updateRouteOffset" placeholder="0" />
          <span>Y</span>
          <input type="number" v-model.number="editingRouteOffsetY" @input="updateRouteOffset" placeholder="0" />
          <button class="mini-reset" @click="resetRouteOffset" title="重置偏移">↺</button>
        </div>
        <p class="ref-hint">调整标签相对路线的位置（世界坐标像素）</p>
      </div>
      <div class="editor-field">
        <label>线型</label>
        <div class="line-style-row">
          <button :class="{ active: !selectedRoute?.dashed }" @click="updateRouteDashed(false)">➖ 实线</button>
          <button :class="{ active: selectedRoute?.dashed }" @click="updateRouteDashed(true)">〰️ 虚线</button>
        </div>
      </div>
      <div class="editor-field">
        <label>颜色</label>
        <div class="terrain-selector">
          <button 
            v-for="c in ROUTE_COLORS" 
            :key="c"
            :class="{ active: selectedRoute?.color === c }"
            :style="{ background: c }" 
            @click="updateRouteColor(c)"
            class="color-btn"
          ></button>
        </div>
      </div>
      <div class="editor-field">
        <label>描述</label>
        <textarea 
          v-model="editingRouteDesc" 
          @input="updateRouteDesc" 
          placeholder="路线描述（可选）"
          rows="3"
        ></textarea>
      </div>
    </div>
    
    <!-- 选中浮动文本的属性编辑面板 -->
    <div v-if="editMode && selectedTextLabel" class="province-editor text-editor">
      <div class="editor-header">
        <h3>编辑文本</h3>
        <button class="close-btn" @click="selectedTextLabel = null">×</button>
      </div>
      <div class="editor-field">
        <label>内容</label>
        <textarea 
          v-model="editingTextContent" 
          @input="updateTextContent" 
          placeholder="浮动文本内容（如：迷雾森林）"
          rows="3"
        ></textarea>
      </div>
      <div class="editor-field">
        <label>字号</label>
        <div class="line-style-row">
          <button v-for="s in [12, 16, 22, 30]" :key="s" :class="{ active: selectedTextLabel?.fontSize === s }" @click="updateTextFontSize(s)">{{ s }}px</button>
        </div>
      </div>
      <div class="editor-field">
        <label>颜色</label>
        <div class="terrain-selector">
          <button 
            v-for="c in TEXT_COLORS" 
            :key="c"
            :class="{ active: selectedTextLabel?.color === c }"
            :style="{ background: c }" 
            @click="updateTextColor(c)"
            class="color-btn"
          ></button>
        </div>
      </div>
    </div>
    
    <!-- 参考图控制面板 -->
    <div v-if="editMode && showRefImagePanel" class="province-editor refimage-editor">
      <div class="editor-header">
        <h3>参考底图</h3>
        <button class="close-btn" @click="showRefImagePanel = false">×</button>
      </div>
      <div class="editor-field">
        <label>导入草图 / 大陆轮廓</label>
        <button class="adopt-btn" style="width:100%" @click="importReferenceImage" :disabled="refImageLoading">
          {{ refImageLoading ? '加载中...' : (referenceImage ? '🔄 更换底图' : '📂 选择图片') }}
        </button>
        <p class="ref-hint">点击「编辑地图」后，从「☷ 图层」旁打开此面板或从工具栏进入</p>
      </div>
      <template v-if="referenceImage">
        <div class="editor-field">
          <label>透明度</label>
          <input type="range" min="0.05" max="1" step="0.05" v-model.number="refOpacity" @input="updateRefOpacity" />
          <span class="ref-value">{{ Math.round(refOpacity * 100) }}%</span>
        </div>
        <div class="editor-field">
          <label>锁定位置</label>
          <div class="line-style-row">
            <button :class="{ active: referenceImage.locked }" @click="toggleRefLocked">🔒 已锁定</button>
            <button :class="{ active: !referenceImage.locked }" @click="toggleRefLocked">🔓 可拖动</button>
          </div>
          <p class="ref-hint">锁定后底图不可拖动，避免描摹时误触</p>
        </div>
        <div class="editor-field" v-if="!referenceImage.locked">
          <label>拖动调整位置</label>
          <button class="adopt-btn" style="width:100%" @click="refDragMode = !refDragMode" :class="{ 'active-btn': refDragMode }">
            {{ refDragMode ? '✅ 拖动模式已开启（拖动画布移动底图）' : '🧲 开启拖动模式' }}
          </button>
        </div>
        <div class="editor-field">
          <label>移除底图</label>
          <button class="adopt-btn ghost" style="width:100%" @click="removeReferenceImage">🗑 移除</button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useGeodataStore } from '../store/geodata';
import { useLayersStore } from '../store/layers';
import { useCanvasRenderer } from '../composables/useCanvasRenderer';
import { getLastCommandLabel, execute } from '../store/undo';
import { getTexturePattern } from '../utils/textures';
import { snapPolygonToNeighbors } from '../utils/snap';
import { createProvinceByFloodFill } from '../utils/floodfill';
import { validatePolygon, pointInPolygon as geoPointInPolygon, convexHull, expandPolygon } from '../utils/geometry';
import EagleEye from './EagleEye.vue';
import ClusterPanel from './ClusterPanel.vue';
import ObjectListPanel from './ObjectListPanel.vue';

const store = useGeodataStore();
const layers = useLayersStore();

const props = defineProps({
  planet: { type: Object, default: null },
});

const emit = defineEmits(['back', 'select-node', 'dirty']);

// ===== 地点簇状态 =====
const clusterPanelOpen = ref(false);
const activeClusterId = ref(null);
const hoverMemberId = ref(null);
// ===== 对象列表面板（地形/标记/路线/文本）=====
const objectPanelOpen = ref(false);
const activeObjectId = computed(() =>
  selectedProvince.value?.id || selectedRegion.value?.id ||
  selectedMarker.value?.id || selectedRoute.value?.id || selectedTextLabel.value?.id || null
);
const clusterEditorOpen = ref(false);
const editingCluster = ref(null);
const editingClusterName = ref('');
const editingClusterColor = ref('#FF6B6B');
const CLUSTER_COLORS = ['#FF6B6B', '#FFA500', '#FFD700', '#32CD32', '#4169E1', '#9B59B6', '#E91E63', '#00BCD4'];
// 框选创建簇状态
const clusterSelectMode = ref(false);
const clusterBoxStart = ref(null);
const clusterBoxEnd = ref(null);
const clusterDraftMembers = ref([]);

const canvas = ref(null);
const drawMode = ref(true);
const floodFillMode = ref(false);
// 地形笔刷
const brushMode = ref(false);
const brushSize = ref(40);
const isBrushing = ref(false);
const brushLastPoint = ref(null);
const currentPath = ref([]);
const hoveredNode = ref(null);
const floodPreview = ref(null);

// ===== 编辑状态 =====
const editMode = ref(false);
const selectedTerrain = ref('land');
const selectedProvince = ref(null);
const drawingPolygon = ref(null);

// ===== 框选多选状态（PlanetMap 地点） =====
const isBoxSelecting = ref(false);
const boxSelectStart = ref(null);
const boxSelectEnd = ref(null);
const selectedPlaceIds = ref(new Set());
const isDraggingPlaces = ref(false);
const placesDragStart = ref(null);

// ===== 顶点编辑状态 =====
const editingVertex = ref(null);
const hoveredVertex = ref(null);

// ===== 区域绘制状态 =====
const selectedRegion = ref(null);
const regionColor = ref('#FF6B6B');
const REGION_COLORS = ['#FF6B6B', '#FFA500', '#FFD700', '#32CD32', '#4169E1', '#9B59B6'];

// ===== 交互模式 =====
const interactionMode = ref('pan');
// 编辑工具栏折叠（常态收起腾出地图空间，点胶囊呼出）
const toolbarCollapsed = ref(true);
// 移动工具拖拽状态（marker/textLabel/region 走"本地改+松手一次提交"，避免 undo 栈爆炸）
const dragObject = ref(null);
const dragRegionAnchor = ref(null);
const isSpacebarDown = ref(false);
const snapEnabled = ref(true);

// 切换交互模式时清理路线草稿
watch(interactionMode, (mode) => {
  if (mode !== 'route') {
    routeDraftPoints.value = [];
  }
});

// 统一模式切换入口：重置全部绘制子模式，防止 brushMode/floodFillMode 残留
// 拦截后续模式的自由绘制（根因：点过笔刷后 brushMode=true，切到区域/绘制被 !brushMode 拦截）
function setInteractionMode(mode) {
  interactionMode.value = mode;
  brushMode.value = false;
  floodFillMode.value = false;
  isBrushing.value = false;
  brushLastPoint.value = null;
  brushStrokePoints.value = [];
  drawingPolygon.value = null;
  isDrawingActive = false;
  currentPath.value = [];
  clusterSelectMode.value = false;
  clusterBoxStart.value = null;
  clusterBoxEnd.value = null;
  dragObject.value = null;
  dragRegionAnchor.value = null;
  renderer.requestRender();
}

// ===== 属性编辑 =====
const editingName = ref('');
const editingDescription = ref('');
const editingRegionName = ref('');
const editingRegionDescription = ref('');

watch(selectedProvince, (poly) => {
  editingName.value = poly?.name || '';
  editingDescription.value = poly?.description || '';
});

watch(selectedRegion, (region) => {
  editingRegionName.value = region?.name || '';
  editingRegionDescription.value = region?.description || '';
});

function updateProvinceName() {
  if (!selectedProvince.value || !editingName.value.trim()) return;
  store.updateTerrainPolygon(props.planet.id, selectedProvince.value.id, {
    name: editingName.value.trim(),
  });
  emit('dirty', true);
}

function updateTerrainType(type) {
  if (!selectedProvince.value) return;
  store.updateTerrainPolygon(props.planet.id, selectedProvince.value.id, { type });
  emit('dirty', true);
}

function updateProvinceDescription() {
  if (!selectedProvince.value) return;
  store.updateTerrainPolygon(props.planet.id, selectedProvince.value.id, {
    description: editingDescription.value,
  });
  emit('dirty', true);
}

// ===== 区域属性更新 =====
function updateRegionName() {
  if (!selectedRegion.value || !editingRegionName.value.trim()) return;
  store.updateRegion(props.planet.id, selectedRegion.value.id, {
    name: editingRegionName.value.trim(),
  });
  emit('dirty', true);
}

function updateRegionColor(color) {
  if (!selectedRegion.value) return;
  store.updateRegion(props.planet.id, selectedRegion.value.id, { color });
  emit('dirty', true);
}

function updateRegionDescription() {
  if (!selectedRegion.value) return;
  store.updateRegion(props.planet.id, selectedRegion.value.id, {
    description: editingRegionDescription.value,
  });
  emit('dirty', true);
}

function getPlaceName(placeId) {
  const place = places.value.find(p => p.id === placeId);
  return place?.name || placeId;
}

const terrainTypes = [
  { type: 'ocean', label: '海洋', color: '#2E86AB' },
  { type: 'land', label: '陆地', color: '#A3C4BC' },
  { type: 'forest', label: '森林', color: '#2D6A4F' },
  { type: 'desert', label: '沙漠', color: '#E9C46A' },
  { type: 'mountain', label: '山脉', color: '#8B7355' },
  { type: 'snow', label: '雪地', color: '#E8E8E8' },
  { type: 'lake', label: '湖泊', color: '#457B9D' },
];

// ===== 标记系统 =====
const selectedMarkerType = ref('chest');
const selectedMarker = ref(null);

const markerTypes = [
  { type: 'chest', label: '宝箱', icon: '📦', color: '#FFD700' },
  { type: 'teleport', label: '传送点', icon: '🌀', color: '#9B59B6' },
  { type: 'boss', label: 'Boss', icon: '💀', color: '#E74C3C' },
  { type: 'resource', label: '资源', icon: '💎', color: '#3498DB' },
  { type: 'npc', label: 'NPC', icon: '👤', color: '#2ECC71' },
  { type: 'flag', label: '旗帜', icon: '🚩', color: '#E67E22' },
];
const MARKER_COLORS = ['#FFD700', '#9B59B6', '#E74C3C', '#3498DB', '#2ECC71', '#E67E22', '#FF6B6B', '#32CD32'];

// 标记属性编辑
const editingMarkerName = ref('');
const editingMarkerDesc = ref('');
const editingMarkerIcon = ref('');

watch(selectedMarker, (marker) => {
  editingMarkerName.value = marker?.name || '';
  editingMarkerDesc.value = marker?.description || '';
  const preset = markerTypes.find(m => m.type === marker?.type);
  editingMarkerIcon.value = marker?.icon || preset?.icon || '📍';
});

function updateMarkerName() {
  if (!selectedMarker.value) return;
  store.updateMarker(props.planet.id, selectedMarker.value.id, { name: editingMarkerName.value.trim() });
  emit('dirty', true);
}

function updateMarkerDesc() {
  if (!selectedMarker.value) return;
  store.updateMarker(props.planet.id, selectedMarker.value.id, { description: editingMarkerDesc.value });
  emit('dirty', true);
}

function updateMarkerType(type) {
  if (!selectedMarker.value) return;
  const preset = markerTypes.find(m => m.type === type);
  store.updateMarker(props.planet.id, selectedMarker.value.id, {
    type,
    icon: preset?.icon || '📍',
    color: preset?.color || '#FFD700',
  });
  editingMarkerIcon.value = preset?.icon || '📍';
  emit('dirty', true);
}

function updateMarkerIcon() {
  if (!selectedMarker.value) return;
  store.updateMarker(props.planet.id, selectedMarker.value.id, { icon: editingMarkerIcon.value || '📍' });
  emit('dirty', true);
}

function updateMarkerColor(color) {
  if (!selectedMarker.value) return;
  store.updateMarker(props.planet.id, selectedMarker.value.id, { color });
  emit('dirty', true);
}

// ===== 路线系统 =====
const selectedRoute = ref(null);
const routeDashed = ref(false);
const routeColor = ref('#E67E22');
const ROUTE_COLORS = ['#E67E22', '#D35400', '#C0392B', '#16A085', '#2C3E50', '#8E44AD', '#34495E', '#B7950B'];
// 绘制中的路线顶点（route 模式点击依次放置）
const routeDraftPoints = ref([]);

// 路线属性编辑
const editingRouteName = ref('');
const editingRouteLabel = ref('');
const editingRouteDesc = ref('');
const editingRouteOffsetX = ref(0);
const editingRouteOffsetY = ref(0);

watch(selectedRoute, (route) => {
  editingRouteName.value = route?.name || '';
  editingRouteLabel.value = route?.label || '';
  editingRouteDesc.value = route?.description || '';
  editingRouteOffsetX.value = route?.labelOffsetX || 0;
  editingRouteOffsetY.value = route?.labelOffsetY || 0;
});

function updateRouteOffset() {
  if (!selectedRoute.value) return;
  store.updateRoute(props.planet.id, selectedRoute.value.id, {
    labelOffsetX: editingRouteOffsetX.value || 0,
    labelOffsetY: editingRouteOffsetY.value || 0,
  });
  emit('dirty', true);
  renderer.requestRender();
}

function resetRouteOffset() {
  editingRouteOffsetX.value = 0;
  editingRouteOffsetY.value = 0;
  updateRouteOffset();
}

function updateRouteName() {
  if (!selectedRoute.value) return;
  store.updateRoute(props.planet.id, selectedRoute.value.id, { name: editingRouteName.value.trim() });
  emit('dirty', true);
}

function updateRouteLabel() {
  if (!selectedRoute.value) return;
  store.updateRoute(props.planet.id, selectedRoute.value.id, { label: editingRouteLabel.value });
  emit('dirty', true);
}

function updateRouteDesc() {
  if (!selectedRoute.value) return;
  store.updateRoute(props.planet.id, selectedRoute.value.id, { description: editingRouteDesc.value });
  emit('dirty', true);
}

function updateRouteDashed(dashed) {
  if (!selectedRoute.value) return;
  store.updateRoute(props.planet.id, selectedRoute.value.id, { dashed });
  emit('dirty', true);
}

function updateRouteColor(color) {
  if (!selectedRoute.value) return;
  store.updateRoute(props.planet.id, selectedRoute.value.id, { color });
  emit('dirty', true);
}

// ===== 浮动文本系统 =====
const selectedTextLabel = ref(null);
const textFontSize = ref(16);
const textColor = ref('#2D3436');
const TEXT_COLORS = ['#2D3436', '#C0392B', '#D35400', '#16A085', '#2C3E50', '#8E44AD', '#7F8C8D', '#27AE60'];

const editingTextContent = ref('');

watch(selectedTextLabel, (label) => {
  editingTextContent.value = label?.text || '';
});

function updateTextContent() {
  if (!selectedTextLabel.value) return;
  store.updateTextLabel(props.planet.id, selectedTextLabel.value.id, { text: editingTextContent.value });
  emit('dirty', true);
}

function updateTextFontSize(size) {
  if (!selectedTextLabel.value) return;
  store.updateTextLabel(props.planet.id, selectedTextLabel.value.id, { fontSize: size });
  emit('dirty', true);
}

function updateTextColor(color) {
  if (!selectedTextLabel.value) return;
  store.updateTextLabel(props.planet.id, selectedTextLabel.value.id, { color });
  emit('dirty', true);
}

// ===== 当前地图数据 =====
// 注意：必须定义在 referenceImage computed 之前（setup 阶段 watch 依赖收集会立即访问）
const currentMapData = computed(() => {
  if (!props.planet) return null;
  return store.mapData[props.planet.id] || { planetId: props.planet.id, version: 1, terrain: [], regions: [], markers: [], routes: [], textLabels: [] };
});

// ===== 参考图底图 =====
const showRefImagePanel = ref(false);
const refImageLoading = ref(false);
const refDragMode = ref(false);
const refOpacity = ref(0.5);
const refImageObj = ref(null); // HTMLImageElement 缓存
const referenceImage = computed(() => currentMapData.value?.referenceImage || null);

// 加载参考图（Electron 主进程读取文件 → base64 dataURL）
async function importReferenceImage() {
  if (!props.planet) return;
  refImageLoading.value = true;
  try {
    const result = await window.sitianAPI.selectReferenceImage();
    if (result?.success && result.dataUrl) {
      const img = new Image();
      img.onload = () => {
        refImageObj.value = img;
        // 默认放到画布中心，宽度适配 1200 世界单位
        const scale = 1200 / img.width;
        const cx = renderer.getViewTransform();
        const center = { x: -cx.x / cx.scale, y: -cx.y / cx.scale };
        store.updateReferenceImage(props.planet.id, {
          dataUrl: result.dataUrl,
          opacity: refOpacity.value,
          locked: false,
          offsetX: center.x,
          offsetY: center.y,
          scale,
          width: img.width,
          height: img.height,
        });
        emit('dirty', true);
        refImageLoading.value = false;
      };
      img.onerror = () => {
        refImageLoading.value = false;
        alert('图片加载失败');
      };
      img.src = result.dataUrl;
    } else {
      refImageLoading.value = false;
    }
  } catch (e) {
    console.error('importReferenceImage failed:', e);
    refImageLoading.value = false;
  }
}

function updateRefOpacity() {
  if (!referenceImage.value) return;
  store.updateReferenceImage(props.planet.id, {
    ...referenceImage.value,
    opacity: refOpacity.value,
  });
  emit('dirty', true);
}

function toggleRefLocked() {
  if (!referenceImage.value) return;
  store.updateReferenceImage(props.planet.id, {
    ...referenceImage.value,
    locked: !referenceImage.value.locked,
  });
  if (referenceImage.value.locked) refDragMode.value = false;
  emit('dirty', true);
}

function removeReferenceImage() {
  if (!referenceImage.value) return;
  if (!confirm('确定移除参考底图？')) return;
  store.clearReferenceImage(props.planet.id);
  refImageObj.value = null;
  refDragMode.value = false;
  emit('dirty', true);
}

watch(referenceImage, (refImg) => {
  if (refImg?.opacity !== undefined) refOpacity.value = refImg.opacity;
  // 重新加载图片
  if (refImg?.dataUrl && (!refImageObj.value)) {
    const img = new Image();
    img.onload = () => { refImageObj.value = img; renderer.requestRender(); };
    img.src = refImg.dataUrl;
  }
}, { deep: true });

// ===== 迷雾/自动区域状态 =====
// 非编辑模式下：无地形数据时显示迷雾占位符；有 region 节点时自动生成初始区域边界
const autoRegions = ref([]);
// 迷雾：仅在地图完全未绘制（无地形且无区域）且非编辑模式时显示；有任一内容即解除
const fogMode = computed(() => {
  if (!currentMapData.value) return false;
  const hasContent = (currentMapData.value.terrain?.length > 0) || (currentMapData.value.regions?.length > 0);
  return !hasContent && !editMode.value;
});
// 是否已生成过自动区域（避免每次进入都重置用户微调结果）
const autoRegionsGenerated = ref(false);

// 为当前行星生成初始区域多边形（基于 region 节点的子地点凸包）
function generateAutoRegions() {
  if (!props.planet || autoRegionsGenerated.value) return;
  autoRegionsGenerated.value = true;
  
  const planetId = props.planet.id;
  // 该行星的 region 节点（两城流域、庆云岛等）
  const planetRegions = store.nodes.filter(n => n.layer === 'region' && n.parentId === planetId);
  if (planetRegions.length === 0) return;
  
  const planetPlaces = [...store.planets, ...store.locations].filter(p => p.parentId === planetId);
  const newRegions = [];
  
  planetRegions.forEach(region => {
    // 通过 tags 匹配该区域下的地点
    const members = planetPlaces.filter(p => (p.tags || []).includes(region.name));
    const points = members
      .map(m => ({ x: m.coordinate?.x, y: m.coordinate?.y }))
      .filter(p => p.x !== null && p.x !== undefined);
    
    if (points.length >= 3) {
      const hull = convexHull(points);
      const expanded = expandPolygon(hull, 60);
      newRegions.push({
        id: `auto_region_${region.id}`,
        name: region.name,
        points: expanded,
        color: '#FF6B6B',
        type: 'region',
        auto: true,
        regionNodeId: region.id,
        members: members.map(m => m.id),
      });
    } else if (region.coordinate?.x !== null && region.coordinate?.x !== undefined) {
      // 地点不足时，用 region 节点自身坐标生成一个圆
      const cx = region.coordinate.x;
      const cy = region.coordinate.y;
      const circle = [];
      for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * Math.PI * 2;
        circle.push({ x: cx + Math.cos(angle) * 120, y: cy + Math.sin(angle) * 120 });
      }
      newRegions.push({
        id: `auto_region_${region.id}`,
        name: region.name,
        points: circle,
        color: '#FF6B6B',
        type: 'region',
        auto: true,
        regionNodeId: region.id,
        members: members.map(m => m.id),
      });
    }
  });
  
  autoRegions.value = newRegions;
}

// ===== 地点归属区域 =====
// 根据地点坐标与自动/正式区域多边形的包含关系，确定地点归属
const placeRegionMap = computed(() => {
  const map = new Map();
  if (!props.planet) return map;
  
  const regionPolys = [
    ...(currentMapData.value?.regions || []),
    ...autoRegions.value,
  ].filter(r => r.points && r.points.length >= 3);
  
  for (const place of places.value) {
    const x = place.coordinate?.x;
    const y = place.coordinate?.y;
    if (x === null || x === undefined) continue;
    for (const region of regionPolys) {
      if (geoPointInPolygon(x, y, region.points)) {
        map.set(place.id, region);
        break;
      }
    }
  }
  return map;
});

// ===== 地点集合 =====
const places = computed(() => {
  if (!props.planet) return [];
  return [...store.planets, ...store.locations].filter(p => p.parentId === props.planet.id);
});

// ===== 节点样式 =====
const NODE_COLORS = { city: '#5B8DEF', town: '#4ECDC4', location: '#95E1D3' };
const NODE_RADIUS = { city: 10, town: 7, location: 5 };
const LABEL_SIZE = { city: 13, town: 12, location: 11 };
const LABEL_WEIGHT = { city: 'bold', town: 'normal', location: 'normal' };

// ===== 地点类型样式（第二维度，优先于 layer 颜色） =====
const PLACE_TYPE_COLORS = {
  自然: '#4CAF50', 宗教: '#9B59B6', 皇室: '#F1C40F', 商业: '#E67E22',
  工业: '#7F8C8D', 居住: '#1ABC9C', 公共: '#3498DB', 特殊: '#E91E63',
};
const PLACE_TYPE_ICONS = {
  自然: '⛰', 宗教: '🛕', 皇室: '🏯', 商业: '🏪',
  工业: '🏭', 居住: '🏠', 公共: '🏛', 特殊: '✦',
};

function getNodeColor(layer) { return NODE_COLORS[layer] || '#95E1D3'; }
function getNodeRadius(layer) { return NODE_RADIUS[layer] || 5; }
function getLabelSize(layer) { return LABEL_SIZE[layer] || 11; }
function getLabelWeight(layer) { return LABEL_WEIGHT[layer] || 'normal'; }
function getPlaceColor(place) {
  if (place.placeType && PLACE_TYPE_COLORS[place.placeType]) return PLACE_TYPE_COLORS[place.placeType];
  return getNodeColor(place.layer);
}
function getPlaceIcon(place) {
  return place.placeType ? PLACE_TYPE_ICONS[place.placeType] : null;
}

// ===== 命中测试 =====
function hitTest(wx, wy) {
  if (!layers.isEditable('planet', 'terrain') && 
      !layers.isEditable('planet', 'markers') && 
      !layers.isEditable('planet', 'places') &&
      !layers.isEditable('planet', 'regions')) return null;
  
  if (layers.isEditable('planet', 'markers')) {
    const markerHit = hitTestMarker(wx, wy);
    if (markerHit) return markerHit;
  }
  
  // 浮动文本（优先级在标记之后、区域之前）
  if (layers.isEditable('planet', 'textLabels') && currentMapData.value?.textLabels) {
    const textHit = hitTestTextLabel(wx, wy);
    if (textHit) return textHit;
  }
  
  // 路线（线命中）
  if (layers.isEditable('planet', 'routes') && currentMapData.value?.routes) {
    const routeHit = hitTestRoute(wx, wy);
    if (routeHit) return routeHit;
  }
  
  if (layers.isEditable('planet', 'regions') && currentMapData.value?.regions) {
    for (let i = currentMapData.value.regions.length - 1; i >= 0; i--) {
      const region = currentMapData.value.regions[i];
      if (geoPointInPolygon(wx, wy, region.points)) {
        return { type: 'region', region };
      }
    }
  }
  
  if (layers.isEditable('planet', 'places')) {
    for (const place of places.value) {
      const dx = wx - (place.coordinate?.x || 0);
      const dy = wy - (place.coordinate?.y || 0);
      const r = getNodeRadius(place.layer) + 4;
      if (dx * dx + dy * dy < r * r) return { type: 'place', node: place };
    }
  }
  
  if (layers.isEditable('planet', 'terrain') && currentMapData.value) {
    for (let i = currentMapData.value.terrain.length - 1; i >= 0; i--) {
      const poly = currentMapData.value.terrain[i];
      if (pointInPolygon(wx, wy, poly.points)) {
        return { type: 'province', polygon: poly };
      }
    }
  }
  
  return null;
}

// 路线命中测试：点到线段距离 < 8px
function hitTestRoute(wx, wy) {
  if (!currentMapData.value?.routes) return null;
  const routes = currentMapData.value.routes;
  for (let i = routes.length - 1; i >= 0; i--) {
    const route = routes[i];
    if (!route.points || route.points.length < 2) continue;
    // 先检查端点（优先级更高）
    for (let j = 0; j < route.points.length; j++) {
      const p = route.points[j];
      const dx = wx - p.x;
      const dy = wy - p.y;
      if (dx * dx + dy * dy < 64) {
        return { type: 'route-endpoint', route, pointIndex: j };
      }
    }
    // 再检查线段
    for (let j = 0; j < route.points.length - 1; j++) {
      const a = route.points[j];
      const b = route.points[j + 1];
      const dist = perpendicularDistance({ x: wx, y: wy }, a, b);
      if (dist < 8) {
        return { type: 'route', route };
      }
    }
  }
  return null;
}

// 浮动文本命中测试：文本包围盒内
function hitTestTextLabel(wx, wy) {
  if (!currentMapData.value?.textLabels) return null;
  const labels = currentMapData.value.textLabels;
  for (let i = labels.length - 1; i >= 0; i--) {
    const label = labels[i];
    if (!label?.text) continue;
    const fontSize = label.fontSize || 16;
    const w = (label.text.length * fontSize * 0.9) / 2 + 8;
    const h = fontSize + 10;
    if (Math.abs(wx - label.x) < w && Math.abs(wy - label.y) < h / 2) {
      return { type: 'textLabel', label };
    }
  }
  return null;
}

// ===== 顶点命中测试 =====
function hitTestVertex(wx, wy) {
  // 多边形/区域顶点
  const selectedPoly = selectedProvince.value || selectedRegion.value;
  if (selectedPoly && editMode.value) {
    const points = selectedPoly.points;
    for (let i = 0; i < points.length; i++) {
      const dx = wx - points[i].x;
      const dy = wy - points[i].y;
      if (dx * dx + dy * dy < 8 * 8) {
        return { vertexIndex: i };
      }
    }
  }
  
  // 路线顶点（开放折线）
  if (selectedRoute.value && editMode.value) {
    const points = selectedRoute.value.points;
    if (points) {
      for (let i = 0; i < points.length; i++) {
        const dx = wx - points[i].x;
        const dy = wy - points[i].y;
        if (dx * dx + dy * dy < 8 * 8) {
          return { vertexIndex: i };
        }
      }
    }
  }
  
  return null;
}

// ===== 边命中测试 =====
function hitTestEdge(wx, wy) {
  const selectedPoly = selectedProvince.value || selectedRegion.value;
  if (!selectedPoly || !editMode.value) return null;
  
  const points = selectedPoly.points;
  const n = points.length;
  
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const dist = perpendicularDistance({ x: wx, y: wy }, a, b);
    if (dist < 8) {
      const distToA = Math.hypot(wx - a.x, wy - a.y);
      const distToB = Math.hypot(wx - b.x, wy - b.y);
      const edgeLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (distToA > 10 && distToB > 10 && edgeLen > 20) {
        return { insertIndex: i + 1 };
      }
    }
  }
  return null;
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function hitTestMarker(wx, wy) {
  if (!currentMapData.value?.markers) return null;
  for (let i = currentMapData.value.markers.length - 1; i >= 0; i--) {
    const marker = currentMapData.value.markers[i];
    const dx = wx - marker.x;
    const dy = wy - marker.y;
    if (dx * dx + dy * dy < 64) {
      return { type: 'marker', marker };
    }
  }
  return null;
}

// ===== 路径简化（Douglas-Peucker）=====
function simplifyPath(points, tolerance) {
  if (points.length <= 2) return points;
  let maxDist = 0;
  let maxIdx = 0;
  const end = points.length - 1;
  for (let i = 1; i < end; i++) {
    const dist = perpendicularDistance(points[i], points[0], points[end]);
    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
  }
  if (maxDist > tolerance) {
    const left = simplifyPath(points.slice(0, maxIdx + 1), tolerance);
    const right = simplifyPath(points.slice(maxIdx), tolerance);
    return left.slice(0, -1).concat(right);
  } else {
    return [points[0], points[end]];
  }
}

function perpendicularDistance(point, lineStart, lineEnd) {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(point.x - lineStart.x, point.y - lineStart.y);
  const t = ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / (len * len);
  const projX = lineStart.x + t * dx;
  const projY = lineStart.y + t * dy;
  return Math.hypot(point.x - projX, point.y - projY);
}

// ===== Undo/Redo label =====
const undoLabel = computed(() => getLastCommandLabel());

// ===== 绘制中的多边形状态 =====
const isDrawing = computed(() => currentPath.value.length > 0);

// ===== LOD =====
const lodRef = ref(1);

// ===== 鹰眼导航数据 =====
const worldBounds = computed(() => {
  const elements = [];
  for (const poly of currentMapData.value?.terrain || []) {
    if (poly.points) elements.push(...poly.points);
  }
  for (const region of currentMapData.value?.regions || []) {
    if (region.points) elements.push(...region.points);
  }
  for (const route of currentMapData.value?.routes || []) {
    if (route.points) elements.push(...route.points);
  }
  for (const marker of currentMapData.value?.markers || []) {
    elements.push({ x: marker.x, y: marker.y });
  }
  for (const label of currentMapData.value?.textLabels || []) {
    elements.push({ x: label.x, y: label.y });
  }
  for (const place of places.value) {
    if (place.coordinate?.x !== null && place.coordinate?.x !== undefined) {
      elements.push({ x: place.coordinate.x, y: place.coordinate.y });
    }
  }
  
  if (elements.length === 0) {
    return { minX: -300, maxX: 300, minY: -300, maxY: 300 };
  }
  
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of elements) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  
  const padding = 50;
  return {
    minX: minX - padding,
    maxX: maxX + padding,
    minY: minY - padding,
    maxY: maxY + padding,
  };
});

const viewBounds = computed(() => {
  const vt = renderer.getViewTransform();
  const cvs = canvas.value;
  if (!cvs) return worldBounds.value;
  
  const w = cvs.clientWidth / vt.scale;
  const h = cvs.clientHeight / vt.scale;
  const cx = -vt.x / vt.scale;
  const cy = -vt.y / vt.scale;
  
  return {
    minX: cx - w / 2,
    maxX: cx + w / 2,
    minY: cy - h / 2,
    maxY: cy + h / 2,
  };
});

const eagleEyeElements = computed(() => {
  const elements = [];
  
  for (const poly of currentMapData.value?.terrain || []) {
    elements.push({
      type: 'polygon',
      points: poly.points,
      color: terrainTypes.find(t => t.type === poly.type)?.color || '#A3C4BC',
      id: poly.id,
    });
  }
  
  for (const region of currentMapData.value?.regions || []) {
    elements.push({
      type: 'polygon',
      points: region.points,
      color: region.color || '#FF6B6B',
      id: region.id,
    });
  }
  
  for (const place of places.value) {
    elements.push({
      type: 'node',
      x: place.coordinate?.x || 0,
      y: place.coordinate?.y || 0,
      r: getNodeRadius(place.layer),
      color: getPlaceColor(place),
      glow: false,
    });
  }
  
  for (const marker of currentMapData.value?.markers || []) {
    elements.push({
      type: 'marker',
      x: marker.x,
      y: marker.y,
      r: 6,
      color: marker.color || markerTypes.find(m => m.type === marker.type)?.color || '#FFD700',
      glow: true,
    });
  }
  
  for (const route of currentMapData.value?.routes || []) {
    if (route.points && route.points.length >= 2) {
      for (let i = 0; i < route.points.length - 1; i++) {
        elements.push({
          type: 'line',
          from: route.points[i],
          to: route.points[i + 1],
          color: route.color || '#E67E22',
          dashed: !!route.dashed,
        });
      }
    }
  }
  
  return elements;
});

function handleEagleEyeNavigate(world) {
  const vt = renderer.getViewTransform();
  vt.x = -world.x * vt.scale;
  vt.y = -world.y * vt.scale;
  renderer.requestRender();
}

// ===== 绘制逻辑 =====
function onRender(ctx, w, h) {
  const scale = renderer.getViewTransform().scale;
  lodRef.value = Math.min(1, Math.max(0, (scale - 0.5) / 0.5));
  
  drawBackground(ctx, w, h);
  
  // 参考图底图（最底层，地形之下）
  drawReferenceImage(ctx);
  
  // 迷雾占位符：无地形数据且非编辑模式时，覆盖暗色迷雾层（原神式占位）
  if (fogMode.value) {
    drawFog(ctx, w, h);
  }
  
  if (layers.isVisible('planet', 'terrain')) {
    drawTerrain(ctx);
  }
  
  if (layers.isVisible('planet', 'regions')) {
    drawRegions(ctx);
  }
  
  if (layers.isVisible('planet', 'routes')) {
    drawRoutes(ctx);
  }
  
  if (layers.isVisible('planet', 'places')) {
    drawPlaces(ctx);
  }
  
  if (layers.isVisible('planet', 'markers')) {
    drawMarkers(ctx);
  }
  
  if (layers.isVisible('planet', 'clusters')) {
    drawClusters(ctx);
  }
  
  if (layers.isVisible('planet', 'textLabels')) {
    drawTextLabels(ctx);
  }
  
  if (editMode.value) {
    drawEditHelpers(ctx);
  }
  
  drawSelectedHighlight(ctx);
}

// 参考图底图渲染
function drawReferenceImage(ctx) {
  const refImg = referenceImage.value;
  if (!refImg || !refImg.dataUrl) return;
  const img = refImageObj.value;
  if (!img) return;
  
  const w = (refImg.width || img.width) * (refImg.scale || 1);
  const h = (refImg.height || img.height) * (refImg.scale || 1);
  
  ctx.save();
  ctx.globalAlpha = refImg.opacity ?? 0.5;
  ctx.drawImage(
    img,
    refImg.offsetX - w / 2,
    refImg.offsetY - h / 2,
    w,
    h
  );
  ctx.restore();
  
  // 未锁定且拖动模式开启时，显示虚线边框提示
  if (editMode.value && !refImg.locked && refDragMode.value) {
    ctx.save();
    ctx.strokeStyle = '#4A90D9';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(refImg.offsetX - w / 2, refImg.offsetY - h / 2, w, h);
    ctx.setLineDash([]);
    ctx.fillStyle = '#4A90D9';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('参考底图（可拖动）', refImg.offsetX - w / 2, refImg.offsetY - h / 2 - 8);
    ctx.restore();
  }
}

// 迷雾占位符：地图未编辑时的探索态视觉（参考原神未探索区域）
function drawFog(ctx, w, h) {
  ctx.save();
  // 轻微压暗（不再是整图变暗），仅作"未绘制"提示
  const fogGradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1200);
  fogGradient.addColorStop(0, 'rgba(20, 30, 40, 0.08)');
  fogGradient.addColorStop(1, 'rgba(10, 15, 22, 0.14)');
  ctx.fillStyle = fogGradient;
  ctx.fillRect(-2000, -2000, 4000, 4000);
  
  // 迷雾边缘晕染（模拟云层，透明度降低）
  for (let i = 0; i < 20; i++) {
    const x = ((i * 137 + 53) % 3000) - 1500;
    const y = ((i * 89 + 67) % 3000) - 1500;
    const r = 80 + (i % 5) * 40;
    const cloud = ctx.createRadialGradient(x, y, 0, x, y, r);
    cloud.addColorStop(0, 'rgba(180, 200, 220, 0.03)');
    cloud.addColorStop(1, 'transparent');
    ctx.fillStyle = cloud;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  
  // 提示文字
  ctx.font = '13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(120, 140, 160, 0.5)';
  ctx.fillText('这片区域尚未绘制 — 点击「编辑地图」开始探索', 0, 0);
  ctx.restore();
}

function drawBackground(ctx, w, h) {
  const bgGradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1500);
  bgGradient.addColorStop(0, '#E8F4F8');
  bgGradient.addColorStop(0.5, '#C8E6C9');
  bgGradient.addColorStop(1, '#FFF9C4');
  ctx.fillStyle = bgGradient;
  ctx.fillRect(-2000, -2000, 4000, 4000);
  
  ctx.strokeStyle = 'rgba(150, 180, 200, 0.15)';
  ctx.lineWidth = 0.5;
  const gridSize = 100;
  for (let gx = -2000; gx <= 2000; gx += gridSize) {
    ctx.beginPath();
    ctx.moveTo(gx, -2000);
    ctx.lineTo(gx, 2000);
    ctx.stroke();
  }
  for (let gy = -2000; gy <= 2000; gy += gridSize) {
    ctx.beginPath();
    ctx.moveTo(-2000, gy);
    ctx.lineTo(2000, gy);
    ctx.stroke();
  }
}

function drawTerrain(ctx) {
  const terrain = currentMapData.value?.terrain || [];
  
  terrain.forEach(poly => {
    if (!poly.points || poly.points.length < 3) return;
    
    const terrainColor = terrainTypes.find(t => t.type === poly.type)?.color || '#A3C4BC';
    const isSelected = selectedProvince.value?.id === poly.id;
    
    ctx.beginPath();
    ctx.moveTo(poly.points[0].x, poly.points[0].y);
    for (let i = 1; i < poly.points.length; i++) {
      ctx.lineTo(poly.points[i].x, poly.points[i].y);
    }
    ctx.closePath();
    
    // 填充（不透明实色：地形"唯一值"，后画的地形直接覆盖先画的，无透明度叠加）
    ctx.fillStyle = terrainColor;
    ctx.globalAlpha = 1;
    ctx.fill();
    ctx.globalAlpha = 1;
    
    // 边界线
    ctx.strokeStyle = isSelected ? '#FFD700' : darkenColor(terrainColor, 20);
    ctx.lineWidth = isSelected ? 3 : 1.5;
    ctx.stroke();
    
    // 名称标签
    if (poly.name && lodRef.value > 0.3) {
      const center = getPolygonCenter(poly.points);
      ctx.font = `${getLabelWeight(poly.layer)} ${getLabelSize(poly.layer)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = getContrastColor(terrainColor);
      ctx.fillText(poly.name, center.x, center.y);
    }
  });
}

function drawRegions(ctx) {
  const regions = currentMapData.value?.regions || [];
  // 未进入编辑模式时，叠加自动生成的初始区域边界（辅助用户理解区域划分）
  const showAuto = !editMode.value && autoRegions.value.length > 0;
  
  regions.forEach(region => {
    if (!region.points || region.points.length < 3) return;
    
    const color = region.color || '#FF6B6B';
    const isSelected = selectedRegion.value?.id === region.id;
    
    ctx.beginPath();
    ctx.moveTo(region.points[0].x, region.points[0].y);
    for (let i = 1; i < region.points.length; i++) {
      ctx.lineTo(region.points[i].x, region.points[i].y);
    }
    ctx.closePath();
    
    ctx.fillStyle = color;
    ctx.globalAlpha = isSelected ? 0.5 : 0.3;
    ctx.fill();
    ctx.globalAlpha = 1;
    
    ctx.strokeStyle = color;
    ctx.lineWidth = isSelected ? 3 : 2;
    ctx.setLineDash([5, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    
    if (region.name && lodRef.value > 0.3) {
      const center = getPolygonCenter(region.points);
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = color;
      ctx.fillText(region.name, center.x, center.y);
    }
  });
  
  if (showAuto) {
    autoRegions.value.forEach(region => {
      if (!region.points || region.points.length < 3) return;
      const color = region.color || '#FF6B6B';
      
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(region.points[0].x, region.points[0].y);
      for (let i = 1; i < region.points.length; i++) {
        ctx.lineTo(region.points[i].x, region.points[i].y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 6]);
      ctx.beginPath();
      ctx.moveTo(region.points[0].x, region.points[0].y);
      for (let i = 1; i < region.points.length; i++) {
        ctx.lineTo(region.points[i].x, region.points[i].y);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      
      if (region.name && lodRef.value > 0.3) {
        const center = getPolygonCenter(region.points);
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = color;
        ctx.fillText(`⏳ ${region.name}`, center.x, center.y);
      }
    });
  }
}

function drawPlaces(ctx) {
  places.value.forEach(place => {
    const x = place.coordinate?.x || 0;
    const y = place.coordinate?.y || 0;
    const color = getPlaceColor(place);
    const radius = getNodeRadius(place.layer);
    const isHovered = hoveredNode.value?.id === place.id;
    const icon = getPlaceIcon(place);
    
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = isHovered ? 12 : 6;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    
    if (icon && lodRef.value > 0.6) {
      // 高缩放：地点类型图标覆盖中心
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#FFFFFF';
      ctx.globalAlpha = 0.95;
      ctx.fillText(icon, x, y + 0.5);
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = '#FFFFFF';
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(x, y, radius * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    
    if (place.name && lodRef.value > 0.4) {
      ctx.font = `${getLabelWeight(place.layer)} ${getLabelSize(place.layer)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#2D3436';
      ctx.fillText(place.displayName || place.name, x, y + radius + 4);
    }
    
    // 锁定标记
    if (place.locked) {
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#E67E22';
      ctx.fillText('🔒', x + radius + 5, y - radius - 5);
    }
    
    // 多选高亮
    if (selectedPlaceIds.value.has(place.id)) {
      ctx.save();
      ctx.strokeStyle = '#58A6FF';
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(x, y, radius + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
    
    // 区域归属徽标（近缩放时显示所属区域名）
    const ownedRegion = placeRegionMap.value.get(place.id);
    if (ownedRegion?.name && lodRef.value > 0.75) {
      const badgeY = y + radius + (place.name ? 18 : 4);
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const badgeText = `📍 ${ownedRegion.name}`;
      const metrics = ctx.measureText(badgeText);
      const padding = 3;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.beginPath();
      ctx.roundRect(
        x - metrics.width / 2 - padding,
        badgeY - 1,
        metrics.width + padding * 2,
        12,
        4
      );
      ctx.fill();
      ctx.fillStyle = '#888';
      ctx.fillText(badgeText, x, badgeY);
    }
  });
}

function drawMarkers(ctx) {
  if (!currentMapData.value?.markers) return;
  
  currentMapData.value.markers.forEach(marker => {
    const preset = markerTypes.find(m => m.type === marker.type);
    const color = marker.color || preset?.color || '#FFD700';
    const icon = marker.icon || preset?.icon || '📍';
    const isSelected = selectedMarker.value?.id === marker.id;
    
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(marker.x, marker.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(icon, marker.x, marker.y);
    
    if (isSelected) {
      ctx.strokeStyle = '#FFD700';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(marker.x, marker.y, 10, 0, Math.PI * 2);
      ctx.stroke();
    }
    
    // 名称标签
    if (marker.name && lodRef.value > 0.4) {
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#2D3436';
      ctx.fillText(marker.name, marker.x, marker.y + 10);
    }
  });
}

// 路线渲染
function drawRoutes(ctx) {
  const routes = currentMapData.value?.routes || [];
  
  // 绘制中的路线草稿
  if (interactionMode.value === 'route' && routeDraftPoints.value.length > 0) {
    drawRoutePolyline(ctx, routeDraftPoints.value, routeColor.value, routeDashed.value, true);
    routeDraftPoints.value.forEach(p => {
      ctx.fillStyle = '#FF6B6B';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  
  routes.forEach(route => {
    if (!route.points || route.points.length < 2) return;
    const color = route.color || '#E67E22';
    const isSelected = selectedRoute.value?.id === route.id;
    
    drawRoutePolyline(ctx, route.points, color, route.dashed, isSelected);
    
    // 文字标签：优先沿路径排布，路径过短时回退中点居中
    if (route.label && lodRef.value > 0.3) {
      const offsetX = route.labelOffsetX || 0;
      const offsetY = route.labelOffsetY || 0;
      const ok = drawTextOnPath(ctx, route.label, route.points, 11, color, '#2D3436', offsetX, offsetY);
      if (!ok) {
        const mid = route.points[Math.floor(route.points.length / 2)];
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const labelText = route.label;
        const metrics = ctx.measureText(labelText);
        const padding = 4;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.beginPath();
        ctx.roundRect(mid.x - metrics.width / 2 - padding + offsetX, mid.y - 10 + offsetY, metrics.width + padding * 2, 20, 4);
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#2D3436';
        ctx.fillText(labelText, mid.x + offsetX, mid.y + offsetY);
      }
    }
  });
  
  // 选中路线的顶点手柄
  if (selectedRoute.value?.points) {
    selectedRoute.value.points.forEach((p, i) => {
      const isHovered = hoveredVertex.value?.vertexIndex === i;
      ctx.fillStyle = isHovered ? '#FF6B6B' : '#FFD700';
      ctx.beginPath();
      ctx.arc(p.x, p.y, isHovered ? 8 : 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }
}

function drawRoutePolyline(ctx, points, color, dashed, highlight) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = highlight ? 4 : 2.5;
  if (dashed) ctx.setLineDash([8, 5]);
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  
  // 端点圆点
  const first = points[0];
  const last = points[points.length - 1];
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(first.x, first.y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// 沿路径排布文字：先画连续白色底带盖住线，再逐字符沿切线旋转绘制
// 返回是否成功（文本过长则回退居中）
function drawTextOnPath(ctx, text, points, fontSize, color, labelColor, offsetX = 0, offsetY = 0) {
  if (!text || points.length < 2) return false;
  
  // 计算各段长度与累计
  const segs = [];
  let totalLen = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    segs.push({ a, b, len, start: totalLen });
    totalLen += len;
  }
  
  // 估算文本总宽（CJK 字符宽度 ≈ fontSize，半角 ≈ fontSize/2）
  let textWidth = 0;
  for (const ch of text) {
    textWidth += (ch.charCodeAt(0) > 255 ? fontSize : fontSize * 0.55);
  }
  const spacing = textWidth / text.length;
  
  // 路径太短：无法沿路径显示
  if (totalLen < fontSize * 0.8) return false;
  
  ctx.save();
  ctx.font = `bold ${fontSize}px "Microsoft YaHei", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  
  // 起始偏移：让文字居中于路径
  const startOffset = Math.max(0, (totalLen - textWidth) / 2);
  
  // 字符位置数组
  const charPositions = [];
  for (let i = 0; i < text.length; i++) {
    const charPos = startOffset + i * spacing + spacing / 2;
    if (charPos < 0 || charPos > totalLen) continue;
    
    let seg = null;
    for (const s of segs) {
      if (charPos >= s.start && charPos <= s.start + s.len) { seg = s; break; }
    }
    if (!seg) { seg = segs[segs.length - 1]; }
    const t = Math.min(1, Math.max(0, (charPos - seg.start) / (seg.len || 1)));
    charPositions.push({
      x: seg.a.x + (seg.b.x - seg.a.x) * t,
      y: seg.a.y + (seg.b.y - seg.a.y) * t,
      angle: Math.atan2(seg.b.y - seg.a.y, seg.b.x - seg.a.x),
    });
  }
  
  if (charPositions.length === 0) { ctx.restore(); return false; }
  
  // 第一步：沿路径画连续白色底带（lineWidth 高于字符，完全盖住路线）
  // 底带与字符共用同一 offset，保证偏移时背景同步移动
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.lineWidth = fontSize + 6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < charPositions.length; i++) {
    const p = charPositions[i];
    if (i === 0) ctx.moveTo(p.x + offsetX, p.y + offsetY);
    else ctx.lineTo(p.x + offsetX, p.y + offsetY);
  }
  ctx.stroke();
  
  // 第二步：逐字符绘制（带 offset 整体平移）
  charPositions.forEach((p, i) => {
    ctx.save();
    ctx.translate(p.x + offsetX, p.y + offsetY);
    ctx.rotate(p.angle);
    ctx.fillStyle = labelColor || '#2D3436';
    ctx.fillText(text[i], 0, 0);
    ctx.restore();
  });
  
  ctx.restore();
  return true;
}

// 地点簇渲染：虚线边界 + 成员高亮/闪烁 + 折叠聚合
function drawClusters(ctx) {
  const clusters = currentMapData.value?.clusters || [];
  const time = performance.now() / 1000;
  
  clusters.forEach(cluster => {
    if (!cluster.memberIds?.length) return;
    const color = cluster.color || '#FF6B6B';
    const members = getClusterMembers(cluster);
    if (members.length === 0) return;
    
    const isActive = activeClusterId.value === cluster.id;
    const hasHover = hoverMemberId.value && cluster.memberIds.includes(hoverMemberId.value);
    
    // 折叠：聚合为一个气泡标记
    if (cluster.collapsed) {
      let cx = 0, cy = 0;
      members.forEach(m => { cx += m.coordinate.x; cy += m.coordinate.y; });
      cx /= members.length;
      cy /= members.length;
      
      // 聚合气泡
      const pulse = 10 + Math.sin(time * 2) * 2;
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      // 数字
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(members.length), cx, cy + 0.5);
      // 标签
      if (lodRef.value > 0.3) {
        ctx.font = '10px sans-serif';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#2D3436';
        ctx.fillText(`⛁ ${cluster.name} (${members.length})`, cx, cy + 12);
      }
      ctx.restore();
      return;
    }
    
    // 展开：虚线范围框（凸包或包围盒）
    if (members.length >= 2) {
      const hull = convexHull(members.map(m => ({ x: m.coordinate.x, y: m.coordinate.y })));
      if (hull.length >= 3) {
        ctx.save();
        ctx.fillStyle = color;
        ctx.globalAlpha = isActive ? 0.12 : 0.06;
        ctx.beginPath();
        ctx.moveTo(hull[0].x, hull[0].y);
        for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i].x, hull[i].y);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
        
        ctx.strokeStyle = color;
        ctx.lineWidth = isActive ? 2.5 : 1.5;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        
        // 簇名称标签（活动簇显示）
        if (isActive && cluster.name && lodRef.value > 0.3) {
          const center = getPolygonCenter(hull);
          ctx.font = 'bold 11px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
          const metrics = ctx.measureText(cluster.name);
          ctx.beginPath();
          ctx.roundRect(center.x - metrics.width / 2 - 4, center.y - 11, metrics.width + 8, 20, 4);
          ctx.fill();
          ctx.fillStyle = '#2D3436';
          ctx.fillText(cluster.name, center.x, center.y + 0.5);
        }
        ctx.restore();
      }
    }
    
    // 仅悬停成员时闪烁（避免与凸包视觉重复）
    if (hasHover) {
      const hoverMember = members.find(m => m.id === hoverMemberId.value);
      if (hoverMember) {
        const x = hoverMember.coordinate.x;
        const y = hoverMember.coordinate.y;
        const blink = Math.sin(time * 8) * 0.5 + 0.5;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.4 + blink * 0.6;
        ctx.beginPath();
        ctx.arc(x, y, getNodeRadius(hoverMember.layer) + 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  });
  
  // cluster 模式框选预览
  if (interactionMode.value === 'cluster' && clusterBoxStart.value && clusterBoxEnd.value) {
    const start = clusterBoxStart.value;
    const end = clusterBoxEnd.value;
    ctx.save();
    ctx.strokeStyle = '#58A6FF';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(
      Math.min(start.x, end.x),
      Math.min(start.y, end.y),
      Math.abs(end.x - start.x),
      Math.abs(end.y - start.y)
    );
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(88, 166, 255, 0.08)';
    ctx.fillRect(
      Math.min(start.x, end.x),
      Math.min(start.y, end.y),
      Math.abs(end.x - start.x),
      Math.abs(end.y - start.y)
    );
    ctx.restore();
  }
}

// 浮动文本渲染
function drawTextLabels(ctx) {
  const labels = currentMapData.value?.textLabels || [];
  
  labels.forEach(label => {
    if (!label?.text) return;
    const fontSize = label.fontSize || 16;
    const color = label.color || '#2D3436';
    const isSelected = selectedTextLabel.value?.id === label.id;
    
    ctx.save();
    ctx.font = `${fontSize}px "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // 半透明背景提高可读性
    const metrics = ctx.measureText(label.text);
    const padding = fontSize * 0.4;
    ctx.fillStyle = isSelected ? 'rgba(255, 215, 0, 0.35)' : 'rgba(255, 255, 255, 0.75)';
    ctx.beginPath();
    ctx.roundRect(
      label.x - metrics.width / 2 - padding,
      label.y - fontSize / 2 - padding / 2,
      metrics.width + padding * 2,
      fontSize + padding,
      fontSize * 0.3
    );
    ctx.fill();
    
    if (isSelected) {
      ctx.strokeStyle = '#FFD700';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    
    ctx.fillStyle = color;
    ctx.fillText(label.text, label.x, label.y);
    ctx.restore();
  });
}

function drawEditHelpers(ctx) {
  // 笔刷预览：当前笔画落点圆形
  if (isBrushing.value && brushMode.value) {
    const brushColor = terrainTypes.find(t => t.type === selectedTerrain.value)?.color || '#000';
    ctx.save();
    ctx.strokeStyle = brushColor;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    brushStrokePoints.value.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, brushSize.value / 2, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.restore();
  }
  
  // 绘制中的路径
  if (isDrawing.value) {
    ctx.strokeStyle = terrainTypes.find(t => t.type === selectedTerrain.value)?.color || '#000';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(currentPath.value[0].x, currentPath.value[0].y);
    for (let i = 1; i < currentPath.value.length; i++) {
      ctx.lineTo(currentPath.value[i].x, currentPath.value[i].y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    
    currentPath.value.forEach(p => {
      ctx.fillStyle = '#FF6B6B';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  
  // 描点模式：绘制中的多边形预览
  if (drawingPolygon.value && drawingPolygon.value.points.length > 0) {
    const pts = drawingPolygon.value.points;
    const strokeColor = drawingPolygon.value.type === 'region'
      ? (drawingPolygon.value.color || '#FF6B6B')
      : (terrainTypes.find(t => t.type === drawingPolygon.value.type)?.color || '#000');
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    if (pts.length >= 3) {
      ctx.closePath();
    }
    ctx.stroke();
    ctx.setLineDash([]);
    
    pts.forEach(p => {
      ctx.fillStyle = '#FFD700';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }
  
  // 选中省份的顶点
  if (selectedProvince.value || selectedRegion.value) {
    const poly = selectedProvince.value || selectedRegion.value;
    poly.points.forEach((p, i) => {
      const isHovered = hoveredVertex.value?.vertexIndex === i;
      ctx.fillStyle = isHovered ? '#FF6B6B' : '#FFD700';
      ctx.beginPath();
      ctx.arc(p.x, p.y, isHovered ? 8 : 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }
  
  // 选中省份的边（用于插入顶点）
  if ((selectedProvince.value || selectedRegion.value) && hoveredVertex.value === null) {
    const poly = selectedProvince.value || selectedRegion.value;
    const n = poly.points.length;
    for (let i = 0; i < n; i++) {
      const a = poly.points[i];
      const b = poly.points[(i + 1) % n];
      ctx.strokeStyle = selectedRegion.value ? (selectedRegion.value.color || '#FF6B6B') : 'rgba(255, 215, 0, 0.3)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  
  // 多选框选预览（Shift+拖动）
  if (isBoxSelecting.value && boxSelectStart.value && boxSelectEnd.value) {
    const start = boxSelectStart.value;
    const end = boxSelectEnd.value;
    ctx.save();
    ctx.strokeStyle = '#58A6FF';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(
      Math.min(start.x, end.x),
      Math.min(start.y, end.y),
      Math.abs(end.x - start.x),
      Math.abs(end.y - start.y)
    );
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(88, 166, 255, 0.08)';
    ctx.fillRect(
      Math.min(start.x, end.x),
      Math.min(start.y, end.y),
      Math.abs(end.x - start.x),
      Math.abs(end.y - start.y)
    );
    ctx.restore();
  }
}

function drawSelectedHighlight(ctx) {
  if (selectedProvince.value) {
    const poly = selectedProvince.value;
    ctx.strokeStyle = '#FFD700';
    ctx.lineWidth = 3;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(poly.points[0].x, poly.points[0].y);
    for (let i = 1; i < poly.points.length; i++) {
      ctx.lineTo(poly.points[i].x, poly.points[i].y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ===== 工具函数 =====
function getPolygonCenter(points) {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function darkenColor(hex, amount) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, (num >> 16) - amount);
  const g = Math.max(0, ((num >> 8) & 0x00FF) - amount);
  const b = Math.max(0, (num & 0x0000FF) - amount);
  return `#${(r << 16 | g << 8 | b).toString(16).padStart(6, '0')}`;
}

function getContrastColor(hex) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = num >> 16;
  const g = (num >> 8) & 0xFF;
  const b = num & 0xFF;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#2D3436' : '#FFFFFF';
}

// ===== Canvas Renderer =====
const renderer = useCanvasRenderer(canvas, {
  onRender,
  onHitTest: (wx, wy) => hitTest(wx, wy),
  onHover: (hit, wx, wy) => {
    hoveredNode.value = hit?.type === 'place' ? hit.node : null;
    // 移动工具光标提示：可移动对象上显示 move，空白显示 grab
    const hoverMode = isSpacebarDown.value ? 'pan' : interactionMode.value;
    if (hoverMode === 'move' && canvas.value) {
      const movable = hit && (hit.type === 'place' || hit.type === 'marker' || hit.type === 'textLabel' || hit.type === 'region');
      canvas.value.style.cursor = movable ? 'move' : 'grab';
    } else if (canvas.value) {
      canvas.value.style.cursor = '';
    }
    // 顶点悬停（多边形/区域/路线）
    if (editMode.value && (selectedProvince.value || selectedRegion.value || selectedRoute.value)) {
      const vHit = hitTestVertex(wx, wy);
      if (vHit) {
        hoveredVertex.value = { vertexIndex: vHit.vertexIndex };
      } else {
        hoveredVertex.value = null;
      }
    } else {
      hoveredVertex.value = null;
    }
  },
  onClick: (hit, wx, wy) => {
    // 参考图拖动模式：单击不处理
    if (refDragMode.value && referenceImage.value && !referenceImage.value.locked) return;
    handleCanvasClick(hit, wx, wy);
  },
  onDblClick: (hit, wx, wy) => {
    if (interactionMode.value === 'route') {
      finishRouteDraft();
      return;
    }
    // 描点模式：双击完成
    if ((interactionMode.value === 'draw' || interactionMode.value === 'region') && !drawMode.value && drawingPolygon.value) {
      finishPointDrawing();
      return;
    }
  },
  onContextMenu: (wx, wy) => {
    if (interactionMode.value === 'route') {
      cancelRouteDraft();
      return;
    }
    // 描点模式：右键取消
    if ((interactionMode.value === 'draw' || interactionMode.value === 'region') && drawingPolygon.value) {
      drawingPolygon.value = null;
      renderer.requestRender();
    }
  },
  onDragStart: (wx, wy, button, shiftKey, ctrlKey, panTry) => {
    if (button !== 0) return true;
    
    const mode = isSpacebarDown.value ? 'pan' : interactionMode.value;
    
    // panTry=true：pan 模式下的顶点试探，只做顶点检测，不做其他副作用
    if (panTry) {
      if (editMode.value && (selectedProvince.value || selectedRegion.value || selectedRoute.value)) {
        const vertexHit = hitTestVertex(wx, wy);
        if (vertexHit) {
          const kind = selectedRoute.value ? 'route' : (selectedRegion.value ? 'region' : 'province');
          vertexDragKind = kind;
          return { mode: 'vertex', vertexInfo: { kind, vertexIndex: vertexHit.vertexIndex } };
        }
      }
      return true; // 非顶点 → 允许平移
    }
    
    // 参考图拖动模式：拖动画布移动底图
    if (refDragMode.value && referenceImage.value && !referenceImage.value.locked) {
      refDragStart = { x: referenceImage.value.offsetX, y: referenceImage.value.offsetY };
      refDragStartWorld = { x: wx, y: wy };
      return false;
    }
    
    // 顶点拖拽（选中多边形/区域/路线时，pan 模式或任意模式下点击顶点）
    if (editMode.value && (selectedProvince.value || selectedRegion.value || selectedRoute.value)) {
      const vertexHit = hitTestVertex(wx, wy);
      if (vertexHit) {
        const kind = selectedRoute.value ? 'route' : (selectedRegion.value ? 'region' : 'province');
        vertexDragKind = kind;
        return { mode: 'vertex', vertexInfo: { kind, vertexIndex: vertexHit.vertexIndex } };
      }
    }
    
    // 地形笔刷：开始涂抹（优先于自由绘制）
    if (mode === 'draw' && brushMode.value) {
      isBrushing.value = true;
      brushLastPoint.value = { x: wx, y: wy };
      brushStrokePoints.value = [{ x: wx, y: wy }];
      return false;
    }
    
    // 绘制模式：开始绘制（笔刷模式不进入）
    // 注意：wx/wy 已是世界坐标（useCanvasRenderer 已 screenToWorld），直接用，
    // 不要再次 screenToWorldFunc —— 双重转换会导致图案偏移到画笔右侧
    if ((mode === 'draw' || mode === 'region') && drawMode.value && !brushMode.value) {
      isDrawingActive = true;
      currentPath.value = [{ x: wx, y: wy }];
      return false;
    }
    
    // cluster 模式：框选起点
    if (mode === 'cluster') {
      clusterBoxStart.value = { x: wx, y: wy };
      clusterBoxEnd.value = { x: wx, y: wy };
      return false;
    }
    
    // route/text/marker 模式：点击处理，禁止拖拽平移（用空格临时平移）
    if (mode === 'marker' || mode === 'route' || mode === 'text') {
      return false;
    }
    
    const hit = hitTest(wx, wy);
    if (!hit) {
      // Shift+拖动：框选多个地点
      if (shiftKey && editMode.value && mode === 'pan') {
        isBoxSelecting.value = true;
        boxSelectStart.value = { x: wx, y: wy };
        boxSelectEnd.value = { x: wx, y: wy };
        return false;
      }
      return true; // 空白处平移
    }
    
    // 移动工具：拖动 marker/textLabel/region；place 落到下方分支；其余平移
    if (mode === 'move') {
      if (hit.type === 'marker') {
        selectedMarker.value = hit.marker;
        selectedProvince.value = null; selectedRegion.value = null; selectedRoute.value = null; selectedTextLabel.value = null;
        dragObject.value = { type: 'marker', id: hit.marker.id, marker: hit.marker, old: { x: hit.marker.x, y: hit.marker.y } };
        return false;
      }
      if (hit.type === 'textLabel') {
        selectedTextLabel.value = hit.label;
        selectedProvince.value = null; selectedRegion.value = null; selectedMarker.value = null; selectedRoute.value = null;
        dragObject.value = { type: 'textLabel', id: hit.label.id, label: hit.label, old: { x: hit.label.x, y: hit.label.y } };
        return false;
      }
      if (hit.type === 'region') {
        selectedRegion.value = hit.region;
        selectedProvince.value = null; selectedMarker.value = null; selectedRoute.value = null; selectedTextLabel.value = null;
        dragObject.value = { type: 'region', id: hit.region.id, region: hit.region, old: hit.region.points.map(p => ({ ...p })) };
        dragRegionAnchor.value = { x: wx, y: wy };
        return false;
      }
      if (hit.type !== 'place') return true; // 省份等 → 平移
    }
    
    // 选中地点：点击已选中地点且多选 → 批量拖拽；否则启动单地点拖拽
    if (hit.type === 'place') {
      if (selectedPlaceIds.value.has(hit.node.id) && selectedPlaceIds.value.size > 1) {
        isDraggingPlaces.value = true;
        placesDragStart.value = { x: wx, y: wy };
        store.beginMultiNodePositionCapture([...selectedPlaceIds.value]);
        return false;
      }
      // 单选：清空多选并启动单地点拖拽
      // （原实现 return true 会走画布平移 → 用户"点来点去拖不动地点"）
      selectedPlaceIds.value = new Set();
      selectedPlaceIds.value.add(hit.node.id);
      isDraggingPlaces.value = true;
      placesDragStart.value = { x: wx, y: wy };
      store.beginNodePositionCapture(hit.node.id);
      return false;
    }
    
    if (mode === 'pan') return true;
    
    return false;
  },
  onDragMove: (wx, wy, dragInfo) => {
    const mode = isSpacebarDown.value ? 'pan' : interactionMode.value;
    // 移动工具：marker/textLabel/region 本地平移（松手一次提交，避免 undo 栈爆炸）
    if (mode === 'move' && dragObject.value) {
      const obj = dragObject.value;
      if (obj.type === 'marker') { obj.marker.x = wx; obj.marker.y = wy; }
      else if (obj.type === 'textLabel') { obj.label.x = wx; obj.label.y = wy; }
      else if (obj.type === 'region' && dragRegionAnchor.value) {
        const dx = wx - dragRegionAnchor.value.x;
        const dy = wy - dragRegionAnchor.value.y;
        obj.region.points = obj.old.map(p => ({ x: Math.round(p.x + dx), y: Math.round(p.y + dy) }));
      }
      renderer.requestRender();
      return;
    }
    if (isDrawingActive) {
      const last = currentPath.value[currentPath.value.length - 1];
      // wx/wy 已是世界坐标，直接使用（同 onDragStart）
      if (!last || Math.hypot(wx - last.x, wy - last.y) > 3) {
        currentPath.value.push({ x: wx, y: wy });
        renderer.requestRender();
      }
      return;
    }
    
    // 顶点拖拽：更新选中对象的顶点坐标
    if (dragInfo?.mode === 'vertex') {
      const { kind, vertexIndex } = dragInfo.vertexInfo;
      if (kind === 'route' && selectedRoute.value?.points) {
        selectedRoute.value.points[vertexIndex].x = wx;
        selectedRoute.value.points[vertexIndex].y = wy;
        store.updateRoute(props.planet.id, selectedRoute.value.id, {
          points: selectedRoute.value.points,
        });
      } else if (kind === 'province' && selectedProvince.value?.points) {
        selectedProvince.value.points[vertexIndex].x = wx;
        selectedProvince.value.points[vertexIndex].y = wy;
        store.updateTerrainPolygon(props.planet.id, selectedProvince.value.id, {
          points: selectedProvince.value.points,
        });
      } else if (kind === 'region' && selectedRegion.value?.points) {
        selectedRegion.value.points[vertexIndex].x = wx;
        selectedRegion.value.points[vertexIndex].y = wy;
        store.updateRegion(props.planet.id, selectedRegion.value.id, {
          points: selectedRegion.value.points,
        });
      }
      renderer.requestRender();
      return;
    }
    
    // 框选拖拽：更新选框
    if (isBoxSelecting.value && boxSelectStart.value) {
      boxSelectEnd.value = { x: wx, y: wy };
      renderer.requestRender();
      return;
    }
    
    // 批量拖拽：移动所有选中地点
    if (isDraggingPlaces.value && placesDragStart.value) {
      const dx = wx - placesDragStart.value.x;
      const dy = wy - placesDragStart.value.y;
      selectedPlaceIds.value.forEach(id => {
        const node = places.value.find(p => p.id === id);
        if (node && !node.locked) {
          node.coordinate.x = (node.coordinate.x || 0) + dx;
          node.coordinate.y = (node.coordinate.y || 0) + dy;
          store.updateNodePosition(id, node.coordinate.x, node.coordinate.y);
        }
      });
      placesDragStart.value = { x: wx, y: wy };
      renderer.requestRender();
      return;
    }
    
    // cluster 框选拖拽
    if (interactionMode.value === 'cluster' && clusterBoxStart.value) {
      clusterBoxEnd.value = { x: wx, y: wy };
      renderer.requestRender();
      return;
    }
    
    // 地形笔刷拖拽：间隔落点
    if (isBrushing.value && brushMode.value) {
      const last = brushLastPoint.value;
      if (last && Math.hypot(wx - last.x, wy - last.y) >= brushSize.value * 0.25) {
        brushStrokePoints.value.push({ x: wx, y: wy });
        brushLastPoint.value = { x: wx, y: wy };
        // 实时预览落点
        renderer.requestRender();
      }
      return;
    }
    
    // 参考图拖动
    if (refDragStart && refDragMode.value && referenceImage.value && !referenceImage.value.locked) {
      // wx/wy 已是世界坐标，直接使用（refDragStartWorld 同为世界坐标）
      store.updateReferenceImage(props.planet.id, {
        ...referenceImage.value,
        offsetX: refDragStart.x + (wx - refDragStartWorld.x),
        offsetY: refDragStart.y + (wy - refDragStartWorld.y),
      });
      renderer.requestRender();
      return;
    }
  },
  onDragEnd: (wx, wy, dragInfo) => {
    const mode = isSpacebarDown.value ? 'pan' : interactionMode.value;
    // 移动工具松手：一次提交（入一次 undo），避免拖动期间 undo 栈爆炸
    if (mode === 'move' && dragObject.value) {
      const obj = dragObject.value;
      if (obj.type === 'marker') store.updateMarker(props.planet.id, obj.id, { x: obj.marker.x, y: obj.marker.y });
      else if (obj.type === 'textLabel') store.updateTextLabel(props.planet.id, obj.id, { x: obj.label.x, y: obj.label.y });
      else if (obj.type === 'region') store.updateRegion(props.planet.id, obj.id, { points: obj.region.points });
      dragObject.value = null;
      dragRegionAnchor.value = null;
      emit('dirty', true);
      renderer.requestRender();
      return;
    }
    if (isDrawingActive) {
      isDrawingActive = false;
      if (currentPath.value.length > 2) {
        finishDrawing();
      }
      currentPath.value = [];
    }
    // 框选结束：确定选中地点集合
    if (isBoxSelecting.value) {
      isBoxSelecting.value = false;
      const start = boxSelectStart.value;
      const end = boxSelectEnd.value || { x: wx, y: wy };
      boxSelectStart.value = null;
      boxSelectEnd.value = null;
      
      const minX = Math.min(start.x, end.x);
      const maxX = Math.max(start.x, end.x);
      const minY = Math.min(start.y, end.y);
      const maxY = Math.max(start.y, end.y);
      
      const selected = new Set();
      places.value.forEach(p => {
        const x = p.coordinate?.x;
        const y = p.coordinate?.y;
        if (x === null || x === undefined) return;
        if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
          selected.add(p.id);
        }
      });
      selectedPlaceIds.value = selected;
      renderer.requestRender();
    }
    // 批量拖拽结束：结束节点坐标捕获（一次拖动 = 一个 undo 步骤）
    if (isDraggingPlaces.value) {
      isDraggingPlaces.value = false;
      placesDragStart.value = null;
      if (selectedPlaceIds.value.size > 1) store.endMultiNodePositionCapture();
      else selectedPlaceIds.value.forEach(id => store.endNodePositionCapture(id));
      emit('dirty', true);
    }
    // 地形笔刷结束：将笔画落点合并为一个地形多边形
    if (isBrushing.value) {
      isBrushing.value = false;
      brushLastPoint.value = null;
      finishBrushStroke();
    }
    // cluster 框选结束
    if (interactionMode.value === 'cluster' && clusterBoxStart.value) {
      finishClusterBox(wx, wy);
    }
    refDragStart = null;
    if (dragInfo?.mode === 'vertex') {
      vertexDragKind = null;
    }
  },
  onWheel: (e, newScale) => {
    if (onWheelCallback) onWheelCallback(e, newScale);
  },
  drawMode,
  currentPath,
  interactionMode,
  isSpacebarDown,
});

let isDrawingActive = false;

let onWheelCallback = null;

// 参考图拖动起始状态（dragInfo 中 world 坐标起点）
let refDragStart = null;
let refDragStartWorld = null;
// 当前顶点拖拽的对象类型（route/province/region）
let vertexDragKind = null;

function finishDrawing() {
  const simplified = simplifyPath(currentPath.value, 2);
  const isRegion = interactionMode.value === 'region';
  const type = isRegion ? 'region' : selectedTerrain.value;
  const typeLabel = isRegion
    ? '区域'
    : (terrainTypes.find(t => t.type === type)?.label || '地形');
  // 默认命名：同类型数量 + 1（如"陆地 3"），供对象列表区分
  const count = isRegion
    ? (currentMapData.value?.regions?.length || 0) + 1
    : (currentMapData.value?.terrain?.filter(t => t.type === type).length || 0) + 1;
  const polygon = {
    id: `poly_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    points: simplified,
    type,
    name: `${typeLabel} ${count}`,
    description: '',
    color: isRegion ? regionColor.value : undefined,
  };
  
  if (isRegion) {
    store.addRegion(props.planet.id, polygon);
  } else {
    store.addTerrainPolygon(props.planet.id, polygon);
  }
  
  emit('dirty', true);
}

function deleteSelected() {
  // 批量删除选中的地点
  if (selectedPlaceIds.value.size > 0) {
    if (confirm(`确定从地图移除选中的 ${selectedPlaceIds.value.size} 个地点吗？`)) {
      selectedPlaceIds.value.forEach(id => store.removeNode(id));
      selectedPlaceIds.value = new Set();
      emit('dirty', true);
    }
    return;
  }
  if (selectedProvince.value) {
    store.removeTerrainPolygon(props.planet.id, selectedProvince.value.id);
    selectedProvince.value = null;
    emit('dirty', true);
  }
  if (selectedRegion.value) {
    store.removeRegion(props.planet.id, selectedRegion.value.id);
    selectedRegion.value = null;
    emit('dirty', true);
  }
  if (selectedMarker.value) {
    store.removeMarker(props.planet.id, selectedMarker.value.id);
    selectedMarker.value = null;
    emit('dirty', true);
  }
  if (selectedRoute.value) {
    store.removeRoute(props.planet.id, selectedRoute.value.id);
    selectedRoute.value = null;
    emit('dirty', true);
  }
  if (selectedTextLabel.value) {
    store.removeTextLabel(props.planet.id, selectedTextLabel.value.id);
    selectedTextLabel.value = null;
    emit('dirty', true);
  }
}

// ===== 地形笔刷 =====
const brushStrokePoints = ref([]);

// 笔画结束：落点圆合并为凸包（单块地形，无自交、无内部重叠透明层）
function finishBrushStroke() {
  const pts = brushStrokePoints.value;
  brushStrokePoints.value = [];
  if (pts.length === 0) return;
  
  const planetId = props.planet.id;
  const type = selectedTerrain.value;
  const r = brushSize.value / 2;
  
  // 每个落点生成圆，所有圆顶点合并为凸包
  const allVertices = [];
  pts.forEach(p => {
    allVertices.push(...makeCirclePolygon(p.x, p.y, r));
  });
  
  const hull = convexHull(allVertices);
  if (hull.length < 3) return;
  
  const poly = {
    id: `poly_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    points: hull,
    type,
    name: '',
    description: '',
  };
  store.addTerrainPolygon(planetId, poly);
  emit('dirty', true);
  renderer.requestRender();
}

// 生成圆多边形（12 段）
function makeCirclePolygon(cx, cy, r) {
  const pts = [];
  const SEGMENTS = 12;
  for (let i = 0; i < SEGMENTS; i++) {
    const angle = (i / SEGMENTS) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
  }
  return pts;
}

// ===== 点击描点模式 =====
// drawMode=false 时：点击依次放置顶点，双击完成，右键取消
function handlePointClick(wx, wy, mode) {
  // 若已存在绘制中的多边形，继续追加顶点
  if (drawingPolygon.value) {
    const last = drawingPolygon.value.points[drawingPolygon.value.points.length - 1];
    if (Math.hypot(wx - last.x, wy - last.y) < 5) return; // 防止重复点击同一点
    drawingPolygon.value.points.push({ x: wx, y: wy });
    renderer.requestRender();
    return;
  }
  
  // 新建绘制中的多边形
  drawingPolygon.value = {
    id: `poly_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    points: [{ x: wx, y: wy }],
    type: mode === 'region' ? 'region' : selectedTerrain.value,
    name: '',
    description: '',
    color: mode === 'region' ? regionColor.value : undefined,
  };
  renderer.requestRender();
}

// 完成描点绘制（双击 / 右键在 ≥3 点时）
function finishPointDrawing() {
  const poly = drawingPolygon.value;
  if (!poly || poly.points.length < 3) {
    drawingPolygon.value = null;
    renderer.requestRender();
    return;
  }
  if (poly.type === 'region') {
    store.addRegion(props.planet.id, poly);
  } else {
    store.addTerrainPolygon(props.planet.id, poly);
  }
  drawingPolygon.value = null;
  emit('dirty', true);
  renderer.requestRender();
}

// ===== 路线绘制交互 =====
// 在 route 模式点击画布：放置路线顶点
function handleRouteClick(wx, wy) {
  // 若命中已有路线端点，直接开始编辑该路线（选中）
  const hit = hitTest(wx, wy);
  if (hit?.type === 'route' || hit?.type === 'route-endpoint') {
    selectedRoute.value = hit.route;
    routeDraftPoints.value = [];
    return;
  }
  
  // 吸附：若点击位置附近有地点（<20px），吸附到地点坐标
  let target = { x: wx, y: wy };
  for (const place of places.value) {
    const dx = wx - (place.coordinate?.x || 0);
    const dy = wy - (place.coordinate?.y || 0);
    if (dx * dx + dy * dy < 20 * 20) {
      target = { x: place.coordinate.x, y: place.coordinate.y, placeId: place.id };
      break;
    }
  }
  
  routeDraftPoints.value.push(target);
  renderer.requestRender();
}

// 完成路线绘制（双击）：至少 2 个点
function finishRouteDraft() {
  if (routeDraftPoints.value.length < 2) {
    routeDraftPoints.value = [];
    return;
  }
  
  const route = {
    id: `route_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    points: routeDraftPoints.value.map(p => ({ x: p.x, y: p.y, placeId: p.placeId || null })),
    dashed: routeDashed.value,
    color: routeColor.value,
    name: `路线 ${(currentMapData.value?.routes?.length || 0) + 1}`,
    label: '',
    description: '',
  };
  store.addRoute(props.planet.id, route);
  selectedRoute.value = route;
  routeDraftPoints.value = [];
  emit('dirty', true);
  renderer.requestRender();
}

// 取消路线绘制（右键）
function cancelRouteDraft() {
  if (routeDraftPoints.value.length > 0) {
    routeDraftPoints.value = [];
    renderer.requestRender();
    return true;
  }
  return false;
}

// ===== 地点簇交互 =====
function getClusters() {
  return currentMapData.value?.clusters || [];
}

function getClusterMembers(cluster) {
  return cluster.memberIds
    .map(id => places.value.find(p => p.id === id))
    .filter(Boolean);
}

function enterClusterMode() {
  interactionMode.value = 'cluster';
  clusterSelectMode.value = true;
  // 互斥：打开簇面板时关闭对象列表面板（防止两面板同位置叠加互相遮挡 ×）
  clusterPanelOpen.value = true;
  objectPanelOpen.value = false;
  clusterDraftMembers.value = [];
  renderer.requestRender();
}

// 框选结束：收集框内地点，弹出创建对话框
function finishClusterBox(wx, wy) {
  const start = clusterBoxStart.value;
  if (!start) { clusterBoxStart.value = null; return; }
  const minX = Math.min(start.x, wx);
  const maxX = Math.max(start.x, wx);
  const minY = Math.min(start.y, wy);
  const maxY = Math.max(start.y, wy);
  
  const members = places.value.filter(p => {
    const x = p.coordinate?.x;
    const y = p.coordinate?.y;
    if (x === null || x === undefined) return false;
    return x >= minX && x <= maxX && y >= minY && y <= maxY;
  });
  
  clusterBoxStart.value = null;
  clusterBoxEnd.value = null;
  
  if (members.length === 0) {
    clusterSelectMode.value = false;
    interactionMode.value = 'pan';
    renderer.requestRender();
    return;
  }
  
  clusterDraftMembers.value = members.map(m => m.id);
  editingCluster.value = null;
  editingClusterName.value = `簇_${Date.now() % 10000}`;
  editingClusterColor.value = CLUSTER_COLORS[clusterDraftMembers.value.length % CLUSTER_COLORS.length];
  clusterEditorOpen.value = true;
  clusterSelectMode.value = false;
  renderer.requestRender();
}

function saveCluster() {
  const planetId = props.planet.id;
  if (editingCluster.value) {
    store.updateCluster(planetId, editingCluster.value.id, {
      name: editingClusterName.value.trim() || editingCluster.value.name,
      color: editingClusterColor.value,
    });
  } else {
    if (clusterDraftMembers.value.length === 0) return;
    const cluster = {
      id: `cluster_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: editingClusterName.value.trim() || '未命名簇',
      memberIds: [...clusterDraftMembers.value],
      color: editingClusterColor.value,
      collapsed: false,
    };
    store.addCluster(planetId, cluster);
    activeClusterId.value = cluster.id;
  }
  clusterEditorOpen.value = false;
  clusterDraftMembers.value = [];
  // 退出簇模式，避免再次拖动画布重复创建簇
  clusterSelectMode.value = false;
  interactionMode.value = 'pan';
  // 清空框选残留，防止 Delete 误删
  selectedPlaceIds.value = new Set();
  // 簇取代自动区域：隐藏 autoRegions，避免两组虚线框重叠
  autoRegions.value = [];
  autoRegionsGenerated.value = true;
  emit('dirty', true);
  renderer.requestRender();
}

function focusCluster(clusterId) {
  const cluster = getClusters().find(c => c.id === clusterId);
  if (!cluster) return;
  activeClusterId.value = clusterId;
  const members = getClusterMembers(cluster);
  if (members.length === 0) return;
  // 平移画布到簇中心
  let cx = 0, cy = 0;
  members.forEach(m => { cx += m.coordinate.x; cy += m.coordinate.y; });
  cx /= members.length;
  cy /= members.length;
  renderer.focusOn(cx, cy, renderer.getViewTransform().scale);
  renderer.requestRender();
}

function toggleClusterCollapse(clusterId) {
  const cluster = getClusters().find(c => c.id === clusterId);
  if (!cluster) return;
  store.updateCluster(props.planet.id, clusterId, { collapsed: !cluster.collapsed });
  renderer.requestRender();
}

// ===== 对象列表面板事件（地形/标记/路线/文本）=====
// 聚焦：选中对象并平移画布到对象中心
function focusObject({ type, id }) {
  const data = currentMapData.value;
  if (!data) return;
  let center = null;
  // 清空其他选中（terrain 分支会重新设置 selectedProvince）
  selectedProvince.value = null;
  selectedRegion.value = null;
  selectedMarker.value = null;
  selectedRoute.value = null;
  selectedTextLabel.value = null;

  if (type === 'terrain') {
    const poly = (data.terrain || []).find(p => p.id === id);
    if (!poly) return;
    selectedProvince.value = poly;
    if (poly.points?.length) center = getPolygonCenter(poly.points);
  } else if (type === 'marker') {
    const m = (data.markers || []).find(x => x.id === id);
    if (!m) return;
    selectedMarker.value = m;
    center = { x: m.x, y: m.y };
  } else if (type === 'route') {
    const r = (data.routes || []).find(x => x.id === id);
    if (!r || !r.points?.length) return;
    selectedRoute.value = r;
    center = r.points[Math.floor(r.points.length / 2)];
  } else if (type === 'text') {
    const t = (data.textLabels || []).find(x => x.id === id);
    if (!t) return;
    selectedTextLabel.value = t;
    center = { x: t.x, y: t.y };
  }

  if (center) {
    renderer.focusOn(center.x, center.y, renderer.getViewTransform().scale);
  }
  renderer.requestRender();
}

// 重命名对象（文本对象改 text 字段，其余改 name）
function renameObject({ type, id, name }) {
  const planetId = props.planet.id;
  if (type === 'terrain') store.updateTerrainPolygon(planetId, id, { name });
  else if (type === 'marker') store.updateMarker(planetId, id, { name });
  else if (type === 'route') store.updateRoute(planetId, id, { name });
  else if (type === 'text') store.updateTextLabel(planetId, id, { text: name });
  emit('dirty', true);
  renderer.requestRender();
}

// 删除对象（走 undo store + 清选中）
function deleteObject({ type, id }) {
  if (!confirm('确定删除该对象吗？')) return;
  const planetId = props.planet.id;
  if (type === 'terrain') {
    store.removeTerrainPolygon(planetId, id);
    if (selectedProvince.value?.id === id) selectedProvince.value = null;
  } else if (type === 'marker') {
    store.removeMarker(planetId, id);
    if (selectedMarker.value?.id === id) selectedMarker.value = null;
  } else if (type === 'route') {
    store.removeRoute(planetId, id);
    if (selectedRoute.value?.id === id) selectedRoute.value = null;
  } else if (type === 'text') {
    store.removeTextLabel(planetId, id);
    if (selectedTextLabel.value?.id === id) selectedTextLabel.value = null;
  }
  emit('dirty', true);
  renderer.requestRender();
}

function openClusterEditor(clusterId) {
  const cluster = getClusters().find(c => c.id === clusterId);
  if (!cluster) return;
  editingCluster.value = cluster;
  editingClusterName.value = cluster.name;
  editingClusterColor.value = cluster.color || '#FF6B6B';
  clusterEditorOpen.value = true;
}

function disbandCluster(clusterId) {
  if (!confirm('确定解散该地点簇？成员地点将恢复独立（位置和属性保留）。')) return;
  store.removeCluster(props.planet.id, clusterId);
  if (activeClusterId.value === clusterId) activeClusterId.value = null;
  clusterEditorOpen.value = false;
  emit('dirty', true);
  renderer.requestRender();
}

function selectClusterMember(memberId) {
  const place = places.value.find(p => p.id === memberId);
  if (!place) return;
  emit('select-node', place);
  renderer.focusOn(place.coordinate.x, place.coordinate.y, renderer.getViewTransform().scale);
  renderer.requestRender();
}

// 在画布点击簇内成员时选中
function handleClusterCanvasClick(wx, wy) {
  // cluster 模式：点击空白处取消框选状态，pan 行为
  if (interactionMode.value === 'cluster' && !clusterSelectMode.value) {
    activeClusterId.value = null;
    renderer.requestRender();
  }
}

// ===== 单击分发 =====
function handleCanvasClick(hit, wx, wy) {
  const mode = isSpacebarDown.value ? 'pan' : interactionMode.value;
  
  // cluster 模式：点击选中簇成员/空白清除
  if (mode === 'cluster') {
    handleClusterCanvasClick(wx, wy);
    return;
  }
  
  // route 模式：点击放置顶点
  if (mode === 'route') {
    handleRouteClick(wx, wy);
    return;
  }
  
  // text 模式：点击放置浮动文本
  if (mode === 'text') {
    const textCount = (currentMapData.value?.textLabels?.length || 0) + 1;
    const label = {
      id: `text_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      x: wx,
      y: wy,
      text: `文本 ${textCount}`,
      fontSize: textFontSize.value,
      color: textColor.value,
    };
    store.addTextLabel(props.planet.id, label);
    selectedTextLabel.value = label;
    emit('dirty', true);
    renderer.requestRender();
    return;
  }
  
  // marker 模式：点击放置标记
  if (mode === 'marker') {
    if (hit?.type === 'marker') {
      selectedMarker.value = hit.marker;
      renderer.requestRender();
      return;
    }
    const markerTypeMeta = markerTypes.find(m => m.type === selectedMarkerType.value);
    const markerCount = (currentMapData.value?.markers?.filter(m => m.type === selectedMarkerType.value).length || 0) + 1;
    const marker = {
      id: `marker_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: selectedMarkerType.value,
      x: wx,
      y: wy,
      name: `${markerTypeMeta?.label || '标记'} ${markerCount}`,
      description: '',
    };
    store.addMarker(props.planet.id, marker);
    selectedMarker.value = marker;
    emit('dirty', true);
    renderer.requestRender();
    return;
  }
  
  // draw/region 描点模式（drawMode=false）：点击放置顶点
  if ((mode === 'draw' || mode === 'region') && !drawMode.value && !brushMode.value) {
    handlePointClick(wx, wy, mode);
    return;
  }
  
  // 其他模式：常规选择
  if (!hit) {
    selectedProvince.value = null;
    selectedRegion.value = null;
    selectedMarker.value = null;
    selectedRoute.value = null;
    selectedTextLabel.value = null;
    renderer.requestRender();
    return;
  }
  
  switch (hit.type) {
    case 'province':
      selectedProvince.value = hit.polygon;
      selectedRegion.value = null;
      selectedMarker.value = null;
      selectedRoute.value = null;
      selectedTextLabel.value = null;
      break;
    case 'region':
      selectedRegion.value = hit.region;
      selectedProvince.value = null;
      selectedMarker.value = null;
      selectedRoute.value = null;
      selectedTextLabel.value = null;
      break;
    case 'marker':
      selectedMarker.value = hit.marker;
      selectedProvince.value = null;
      selectedRegion.value = null;
      selectedRoute.value = null;
      selectedTextLabel.value = null;
      break;
    case 'route':
    case 'route-endpoint':
      selectedRoute.value = hit.route;
      selectedProvince.value = null;
      selectedRegion.value = null;
      selectedMarker.value = null;
      selectedTextLabel.value = null;
      break;
    case 'textLabel':
      selectedTextLabel.value = hit.label;
      selectedProvince.value = null;
      selectedRegion.value = null;
      selectedMarker.value = null;
      selectedRoute.value = null;
      break;
    case 'place':
      // 点击地点 → 单选 + 打开详情面板（原 switch 缺此 case → 点击无反应）
      selectedPlaceIds.value = new Set([hit.node.id]);
      selectedProvince.value = null;
      selectedRegion.value = null;
      selectedMarker.value = null;
      selectedRoute.value = null;
      selectedTextLabel.value = null;
      emit('select-node', hit.node);
      break;
  }
  renderer.requestRender();
}

function smoothPolygonBoundary() {
  const poly = selectedProvince.value || selectedRegion.value;
  if (!poly || poly.points.length < 3) return;
  
  const smoothed = [];
  const points = poly.points;
  const n = points.length;
  
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    
    smoothed.push({
      x: curr.x * 0.5 + (prev.x + next.x) * 0.25,
      y: curr.y * 0.5 + (prev.y + next.y) * 0.25,
    });
  }
  
  if (selectedProvince.value) {
    store.updateTerrainPolygon(props.planet.id, poly.id, { points: smoothed });
  } else {
    store.updateRegion(props.planet.id, poly.id, { points: smoothed });
  }
  emit('dirty', true);
}

function saveMap() {
  store.saveMapDataImmediate(props.planet.id);
}

// ===== 全图高清导出 =====
// 计算所有地图元素的世界包围盒
function computeFullBounds() {
  const elements = [];
  for (const poly of currentMapData.value?.terrain || []) {
    if (poly.points) elements.push(...poly.points);
  }
  for (const region of currentMapData.value?.regions || []) {
    if (region.points) elements.push(...region.points);
  }
  for (const route of currentMapData.value?.routes || []) {
    if (route.points) elements.push(...route.points);
  }
  for (const marker of currentMapData.value?.markers || []) {
    elements.push({ x: marker.x, y: marker.y });
  }
  for (const label of currentMapData.value?.textLabels || []) {
    elements.push({ x: label.x, y: label.y });
  }
  for (const place of places.value) {
    if (place.coordinate?.x !== null && place.coordinate?.x !== undefined) {
      elements.push({ x: place.coordinate.x, y: place.coordinate.y });
    }
  }
  // 参考图
  const refImg = referenceImage.value;
  if (refImg && refImg.width) {
    const w = refImg.width * (refImg.scale || 1);
    const h = refImg.height * (refImg.scale || 1);
    elements.push(
      { x: refImg.offsetX - w / 2, y: refImg.offsetY - h / 2 },
      { x: refImg.offsetX + w / 2, y: refImg.offsetY + h / 2 }
    );
  }
  
  if (elements.length === 0) {
    return { minX: -400, maxX: 400, minY: -400, maxY: 400 };
  }
  
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of elements) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  
  const padding = 60;
  return {
    minX: minX - padding,
    maxX: maxX + padding,
    minY: minY - padding,
    maxY: maxY + padding,
  };
}

// 导出全图高清 PNG：离屏 canvas 重绘全部对象，2x 缩放
// 通过系统保存对话框选择路径，成功后状态提示
const exportStatus = ref('');

async function exportFullMapPNG() {
  const bounds = computeFullBounds();
  const scale = 2;
  const w = Math.ceil((bounds.maxX - bounds.minX) * scale);
  const h = Math.ceil((bounds.maxY - bounds.minY) * scale);
  
  // 尺寸保护：避免超大画布 OOM
  if (w * h > 8000 * 8000) {
    alert('地图范围过大，无法导出全图。请缩小地图范围或减少元素。');
    return;
  }
  
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const ctx = tmp.getContext('2d');
  
  // 背景
  const bgGradient = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
  bgGradient.addColorStop(0, '#E8F4F8');
  bgGradient.addColorStop(0.5, '#C8E6C9');
  bgGradient.addColorStop(1, '#FFF9C4');
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, w, h);
  
  // 世界坐标 → 画布坐标变换
  ctx.save();
  ctx.translate(-bounds.minX * scale, -bounds.minY * scale);
  ctx.scale(scale, scale);
  
  // 强制全细节渲染（lod=1）
  const oldLod = lodRef.value;
  lodRef.value = 1;
  
  // 参考图
  drawReferenceImage(ctx);
  
  if (layers.isVisible('planet', 'terrain')) drawTerrain(ctx);
  if (layers.isVisible('planet', 'regions')) drawRegions(ctx);
  if (layers.isVisible('planet', 'routes')) drawRoutes(ctx);
  if (layers.isVisible('planet', 'places')) drawPlaces(ctx);
  if (layers.isVisible('planet', 'markers')) drawMarkers(ctx);
  if (layers.isVisible('planet', 'clusters')) drawClusters(ctx);
  if (layers.isVisible('planet', 'textLabels')) drawTextLabels(ctx);
  
  lodRef.value = oldLod;
  ctx.restore();
  
  // 通过保存对话框导出
  try {
    const dataUrl = tmp.toDataURL('image/png');
    const result = await window.sitianAPI.saveExportFile({
      dataUrl,
      defaultName: `sitian-${props.planet?.id || 'map'}-full-${Date.now()}.png`,
    });
    if (result?.success) {
      exportStatus.value = `✅ 导出成功：${result.path}`;
      setTimeout(() => { exportStatus.value = ''; }, 4000);
    } else if (result?.canceled) {
      exportStatus.value = '已取消导出';
      setTimeout(() => { exportStatus.value = ''; }, 2000);
    } else {
      exportStatus.value = `导出失败：${result?.error || '未知错误'}`;
      setTimeout(() => { exportStatus.value = ''; }, 4000);
    }
  } catch (e) {
    // 浏览器环境（无 Electron API）：回退下载
    tmp.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sitian-${props.planet?.id || 'map'}-full-${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
    exportStatus.value = '✅ 已下载（浏览器回退模式）';
    setTimeout(() => { exportStatus.value = ''; }, 3000);
  }
}

function confirmClear() {
  if (confirm('确定要清空所有省份、区域、路线、标记、文本和地点簇吗？此操作不可撤销。')) {
    store.mapData[props.planet.id] = {
      planetId: props.planet.id,
      version: 1,
      terrain: [],
      regions: [],
      markers: [],
      routes: [],
      textLabels: [],
      clusters: [],
    };
    selectedProvince.value = null;
    selectedRegion.value = null;
    selectedMarker.value = null;
    selectedRoute.value = null;
    selectedTextLabel.value = null;
    activeClusterId.value = null;
    emit('dirty', true);
  }
}

function enterEditMode() {
  editMode.value = true;
  interactionMode.value = 'draw';
  drawMode.value = true;
  // 重置绘制子模式，避免上次退出残留导致自由绘制被拦截
  floodFillMode.value = false;
  brushMode.value = false;
  isBrushing.value = false;
  brushLastPoint.value = null;
  brushStrokePoints.value = [];
  drawingPolygon.value = null;
  isDrawingActive = false;
}

function exitEditMode() {
  editMode.value = false;
  isDrawingActive = false;
  currentPath.value = [];
  routeDraftPoints.value = [];
  selectedProvince.value = null;
  selectedRegion.value = null;
  selectedMarker.value = null;
  selectedRoute.value = null;
  selectedTextLabel.value = null;
  refDragMode.value = false;
  clusterSelectMode.value = false;
  clusterBoxStart.value = null;
  clusterBoxEnd.value = null;
  brushMode.value = false;
  isBrushing.value = false;
  brushLastPoint.value = null;
  brushStrokePoints.value = [];
  isBoxSelecting.value = false;
  boxSelectStart.value = null;
  boxSelectEnd.value = null;
  selectedPlaceIds.value = new Set();
  isDraggingPlaces.value = false;
  placesDragStart.value = null;
  dragObject.value = null;
  dragRegionAnchor.value = null;
  drawingPolygon.value = null;
}

function undo() {
  store.undo();
}

function redo() {
  store.redo();
}

// ===== 生命周期 =====
onMounted(() => {
  renderer.initCanvas();
  generateAutoRegions();
  renderer.requestRender();
  window.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  renderer.cleanupCanvas();
  window.removeEventListener('keydown', handleKeydown);
});

// ===== 编辑面板拖拽 =====
// 点击面板 header 时拖动整个面板（事件委托在根容器）
// 支持：province-editor（属性编辑面板）、cluster-panel（地点簇）、object-panel（对象列表）
function handlePanelHeaderDrag(e) {
  // header 内的交互元素（× 关闭按钮、输入框、颜色按钮等）不触发拖拽
  // 否则点击 × 会先启动面板拖拽（mousedown 在 header 内冒泡到委托），面板被位移、preventDefault 吞掉关闭
  if (e.target.closest('button, input, select, textarea, a, label')) return;
  const header = e.target.closest('.province-editor .editor-header, .cluster-panel .panel-header, .object-panel .panel-header');
  if (!header) return;
  const panel = header.closest('.province-editor, .cluster-panel, .object-panel');
  if (!panel) return;
  e.preventDefault();
  
  const startX = e.clientX;
  const startY = e.clientY;
  // 用 getBoundingClientRect 获取当前视觉位置（不受 right/left 定位切换影响）
  const rect = panel.getBoundingClientRect();
  const containerRect = panel.parentElement?.getBoundingClientRect() || { left: 0, top: 0 };
  const origLeft = rect.left - containerRect.left;
  const origTop = rect.top - containerRect.top;
  // 转成 left/top 定位（原为 right 定位，避免拖拽时跳动）
  panel.style.right = 'auto';
  panel.style.left = origLeft + 'px';
  panel.style.top = origTop + 'px';
  
  function onMove(ev) {
    panel.style.left = (origLeft + ev.clientX - startX) + 'px';
    panel.style.top = (origTop + ev.clientY - startY) + 'px';
  }
  function onUp() {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// ===== 方向键微调 =====
// 方向键：选中对象逐像素移动（Shift+方向键 = 10px）
function handleKeydown(e) {
  if (!editMode.value) return;
  const arrows = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  if (!arrows.includes(e.key)) return;
  // 输入框/文本框聚焦时不拦截
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  
  let dx = 0, dy = 0;
  if (e.key === 'ArrowLeft') dx = -1;
  else if (e.key === 'ArrowRight') dx = 1;
  else if (e.key === 'ArrowUp') dy = -1;
  else if (e.key === 'ArrowDown') dy = 1;
  const step = e.shiftKey ? 10 : 1;
  dx *= step;
  dy *= step;
  
  let moved = false;
  
  // 地点节点微调（带锁定检查）
  if (hoveredNode.value && !hoveredNode.value.locked) {
    const node = hoveredNode.value;
    e.preventDefault();
    store.beginNodePositionCapture(node.id);
    store.updateNodePosition(node.id, (node.coordinate?.x || 0) + dx, (node.coordinate?.y || 0) + dy);
    store.endNodePositionCapture();
    hoveredNode.value = null; // 避免连续触发同节点（实际是选中态）
    renderer.requestRender();
    moved = true;
  } else if (selectedMarker.value) {
    const marker = selectedMarker.value;
    e.preventDefault();
    store.updateMarker(props.planet.id, marker.id, {
      x: (marker.x || 0) + dx,
      y: (marker.y || 0) + dy,
    });
    renderer.requestRender();
    moved = true;
  } else if (selectedTextLabel.value) {
    const label = selectedTextLabel.value;
    e.preventDefault();
    store.updateTextLabel(props.planet.id, label.id, {
      x: (label.x || 0) + dx,
      y: (label.y || 0) + dy,
    });
    renderer.requestRender();
    moved = true;
  }
  
  if (moved) emit('dirty', true);
}

// 采用自动生成的区域为正式区域（转为可编辑的正式 region，保存到 mapdata）
function adoptAutoRegions() {
  if (autoRegions.value.length === 0) return;
  if (!confirm(`将把 ${autoRegions.value.length} 个自动生成的区域边界转为正式区域？\n\n转换后可继续编辑边界、改色、删除。`)) return;
  
  autoRegions.value.forEach(auto => {
    const { auto: _a, regionNodeId, ...regionData } = auto;
    store.addRegion(props.planet.id, {
      ...regionData,
      id: `region_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: auto.name,
      type: 'region',
      auto: false,
    });
  });
  autoRegions.value = [];
  emit('dirty', true);
}

// 重新生成自动区域（用户放弃当前微调时）
function regenerateAutoRegions() {
  autoRegionsGenerated.value = false;
  autoRegions.value = [];
  generateAutoRegions();
  renderer.requestRender();
}

watch(() => store.mapData[props.planet?.id], () => {
  renderer.requestRender();
}, { deep: true });
</script>

<style scoped>
.planet-map-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--planet-bg);
}

.map-header {
  padding: 12px 20px;
  background: var(--planet-header-bg);
  border-bottom: 1px solid var(--planet-header-border);
}

.header-left {
  display: flex;
  align-items: baseline;
  gap: 16px;
}

.map-header h2 {
  font-size: 16px;
  color: var(--planet-text);
  margin: 0;
}

.hint {
  font-size: 12px;
  color: var(--planet-text-secondary);
  margin: 0;
}

.hint a {
  color: var(--planet-text-link);
  text-decoration: none;
}

.hint a:hover {
  text-decoration: underline;
}

.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.adopt-btn {
  padding: 6px 12px;
  border: 1px solid var(--planet-btn-border);
  border-radius: 4px;
  background: var(--planet-btn-bg);
  cursor: pointer;
  font-size: 12px;
  color: var(--planet-text);
  transition: all 0.2s;
}

.adopt-btn:hover {
  background: var(--planet-btn-hover);
  border-color: var(--planet-btn-active-border);
}

.adopt-btn.ghost {
  background: transparent;
  opacity: 0.7;
}

.adopt-btn.ghost:hover {
  opacity: 1;
}

.edit-toolbar-wrap {
  display: flex;
  align-items: center;
  padding: 6px 16px;
  background: rgba(255,255,255,0.8);
  border-bottom: 1px solid var(--planet-header-border);
}

.toolbar-toggle {
  padding: 6px 16px;
  border: 1px dashed var(--planet-btn-border);
  border-radius: 6px;
  background: var(--planet-btn-bg);
  color: var(--planet-text);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s;
}
.toolbar-toggle:hover { background: var(--planet-btn-hover); }

.toolbar-close {
  color: var(--planet-text) !important;
  border-color: var(--planet-btn-border) !important;
}

.edit-toolbar {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.edit-toolbar button {
  padding: 6px 12px;
  border: 1px solid var(--planet-btn-border);
  border-radius: 4px;
  background: var(--planet-btn-bg);
  cursor: pointer;
  font-size: 12px;
  color: var(--planet-text);
}

.edit-toolbar button:hover {
  background: var(--planet-btn-hover);
}

.edit-toolbar button.active {
  background: var(--planet-btn-active-bg);
  color: white;
  border-color: var(--planet-btn-active-border);
}

.edit-toolbar button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.edit-toolbar button.separator-btn {
  width: 1px;
  padding: 0;
  border: none;
  background: transparent;
  pointer-events: none;
}

.terrain-picker {
  display: flex;
  gap: 6px;
  padding: 8px 20px;
  background: rgba(255,255,255,0.6);
  border-bottom: 1px solid var(--planet-header-border);
  align-items: center;
  flex-wrap: wrap;
}

.picker-label {
  font-size: 12px;
  color: var(--planet-text-secondary);
}

.terrain-picker button {
  padding: 4px 10px;
  border: 2px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  color: white;
  text-shadow: 0 1px 2px rgba(0,0,0,0.3);
}

.terrain-picker button.active {
  border-color: #FFD700;
  box-shadow: 0 0 6px rgba(255,215,0,0.5);
}

.color-btn {
  width: 28px;
  height: 28px;
  border-radius: 50% !important;
  padding: 0 !important;
}

.canvas-wrapper {
  flex: 1;
  position: relative;
  overflow: hidden;
}

canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.province-editor {
  position: absolute;
  right: 16px;
  top: 120px;
  width: 280px;
  background: var(--planet-editor-bg);
  border-radius: 8px;
  border: 1px solid var(--planet-editor-border);
  box-shadow: 0 4px 16px rgba(0,0,0,0.12);
  z-index: 100;
  cursor: default;
}
.province-editor .editor-header {
  cursor: move;
  user-select: none;
}
.editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid #eee;
}
.editor-header h3 {
  margin: 0;
  font-size: 13px;
  color: var(--planet-text);
  font-weight: 600;
}
.close-btn {
  background: none;
  border: none;
  font-size: 18px;
  cursor: pointer;
  color: #999;
  line-height: 1;
  padding: 0 4px;
}
.close-btn:hover { color: #333; }
.editor-field {
  padding: 10px 14px;
  border-bottom: 1px solid #f0f0f0;
}
.editor-field:last-child { border-bottom: none; }
.editor-field label {
  display: block;
  font-size: 11px;
  color: #888;
  margin-bottom: 4px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.editor-field input,
.editor-field textarea {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--planet-input-border);
  border-radius: 4px;
  font-size: 12px;
  font-family: "Microsoft YaHei", sans-serif;
  background: var(--planet-input-bg);
  transition: border-color 0.15s;
}
.editor-field input:focus,
.editor-field textarea:focus {
  border-color: var(--planet-input-focus);
  outline: none;
}
.editor-field textarea { resize: vertical; }
.terrain-selector {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
}
.terrain-selector button {
  padding: 4px 0;
  border: 2px solid transparent;
  border-radius: 3px;
  color: #fff;
  font-size: 10px;
  cursor: pointer;
  opacity: 0.85;
  transition: all 0.15s;
}
.terrain-selector button:hover { opacity: 1; }
.terrain-selector button.active {
  opacity: 1;
  border-color: #FFD700;
  box-shadow: 0 0 0 2px rgba(255,215,0,0.3);
}
.marker-icon {
  font-size: 14px;
  margin-right: 2px;
}

/* 区域编辑器样式 */
.region-editor .members-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.member-tag {
  display: inline-block;
  padding: 2px 8px;
  background: var(--planet-tag-bg);
  border: 1px solid var(--planet-tag-border);
  border-radius: 12px;
  font-size: 11px;
  color: var(--planet-text);
}

/* 工具栏小标签 */
.toolbar-label {
  font-size: 11px;
  color: var(--planet-text-secondary);
  margin: 0 2px;
  align-self: center;
}

/* 线型/字号选择行 */
.line-style-row {
  display: flex;
  gap: 4px;
}
.line-style-row button {
  padding: 4px 10px;
  border: 2px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  background: var(--planet-btn-bg);
  color: var(--planet-text);
}
.line-style-row button.active {
  border-color: #FFD700;
  box-shadow: 0 0 6px rgba(255,215,0,0.5);
}

/* 标签偏移输入行 */
.offset-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.offset-row span {
  font-size: 11px;
  color: var(--planet-text-secondary);
}
.offset-row input {
  width: 56px;
  padding: 4px 6px;
  border: 1px solid var(--planet-input-border);
  border-radius: 4px;
  font-size: 11px;
  background: var(--planet-input-bg);
  color: var(--planet-text);
}
.mini-reset {
  background: none;
  border: 1px solid var(--planet-btn-border);
  color: var(--planet-text-secondary);
  cursor: pointer;
  font-size: 12px;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  line-height: 1;
}
.mini-reset:hover {
  color: var(--planet-text);
  background: var(--planet-btn-hover);
}

/* 标记图标输入 */
.icon-input-row {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.icon-input-row input {
  flex: 1;
  min-width: 80px;
}
.icon-pick-btn {
  width: 30px;
  height: 30px;
  border: 2px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  font-size: 15px;
  background: var(--planet-btn-bg);
}
.icon-pick-btn.active {
  border-color: #FFD700;
}

/* 参考图面板 */
.ref-hint {
  font-size: 10px;
  color: #888;
  margin: 4px 0 0;
  line-height: 1.4;
}
.ref-value {
  font-size: 11px;
  color: var(--planet-text-secondary);
  margin-left: 6px;
}
.refimage-editor input[type="range"] {
  width: 100%;
}
.active-btn {
  border-color: #FFD700 !important;
  box-shadow: 0 0 6px rgba(255,215,0,0.5);
  background: var(--planet-btn-active-bg) !important;
  color: white !important;
}

/* 非编辑模式导出按钮 */
.view-actions {
  position: absolute;
  top: 12px;
  right: 16px;
  z-index: 5;
}
.view-actions .adopt-btn {
  background: var(--planet-btn-bg);
}

/* 导出状态提示 */
.export-status {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 90;
  background: rgba(22, 27, 34, 0.92);
  color: #f0f6fc;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 8px 16px;
  font-size: 12px;
  max-width: 70%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
}

/* 地点簇对话框 */
.cluster-dialog-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
}
.cluster-dialog {
  width: 320px;
  max-height: 80vh;
  overflow-y: auto;
  background: var(--planet-editor-bg);
  border-radius: 8px;
  border: 1px solid var(--planet-editor-border);
  box-shadow: 0 8px 32px rgba(0,0,0,0.3);
}
.dialog-actions {
  display: flex;
  gap: 8px;
  padding: 12px 14px;
  justify-content: flex-end;
}
.dialog-actions .adopt-btn {
  padding: 6px 16px;
}
</style>
