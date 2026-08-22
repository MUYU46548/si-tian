<template>
  <div class="planet-map-container" @mousedown="handlePanelHeaderDrag">
    <div class="map-header">
      <div class="header-left">
        <div class="header-title-row">
          <button class="back-btn" @click="$emit('back')" title="返回域内恒星系总览">← 返回</button>
          <h2>{{ planet?.name }} — 行星地图</h2>
        </div>
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
      <div class="header-actions" v-if="!editMode">
        <button class="adopt-btn edit-entry-btn" @click="enterEditMode" title="进入编辑模式：绘制地形/区域/标记/路线/文本等">✏️ 编辑地图</button>
        <template v-if="autoRegions.length > 0">
          <button class="adopt-btn" @click="adoptAutoRegions" title="将自动生成的区域边界转为正式区域，可继续编辑">
            ✨ 采用自动区域 ({{ autoRegions.length }})
          </button>
          <button class="adopt-btn ghost" @click="regenerateAutoRegions" title="重新按地点聚类生成区域边界">
            ↻ 重新生成
          </button>
        </template>
      </div>
    </div>
    
    <!-- 编辑工具栏（仅编辑形态显示，退出即隐藏，无折叠中间态；按功能分组 P0-1） -->
    <div v-if="editMode" class="edit-toolbar-wrap">
      <div class="edit-toolbar">
        <div class="toolbar-group" title="绘制工具">
          <button :class="{ active: interactionMode === 'pan' }" @click="setInteractionMode('pan')" title="拖动画布 (空格临时切换)">🤚 拖手</button>
          <button :class="{ active: interactionMode === 'move' }" @click="setInteractionMode('move')" title="移动对象：点击选中地点/标记/文本/区域，拖动移动；空白处拖动画布">✥ 移动</button>
          <button :class="{ active: interactionMode === 'draw' }" @click="setInteractionMode('draw')" title="绘制省份">✏️ 绘制</button>
          <button :class="{ active: interactionMode === 'region' }" @click="setInteractionMode('region')" title="圈画区域">🗺️ 区域</button>
          <button :class="{ active: interactionMode === 'marker' }" @click="setInteractionMode('marker')" title="放置标记">📍 标记</button>
          <button :class="{ active: interactionMode === 'route' }" @click="setInteractionMode('route')" title="绘制路线">🛣️ 路线</button>
          <button :class="{ active: interactionMode === 'text' }" @click="setInteractionMode('text')" title="放置浮动文本">🔤 文本</button>
          <button :class="{ active: interactionMode === 'cluster' }" @click="setInteractionMode('cluster'); openPlanetPanel('cluster')" title="框选地点创建簇 (拖动圈选)">🗂 簇</button>
        </div>

        <div class="toolbar-group" title="面板管理">
          <button :class="{ active: objectPanelOpen }" @click="openPlanetPanel('object')" title="对象列表：地形/标记/路线/文本管理">📋 对象</button>
          <button :class="{ active: snapshotPanelOpen }" @click="openPlanetPanel('snapshot')" title="地图版本快照：拍摄/恢复">📸 快照</button>
        </div>

        <template v-if="interactionMode === 'draw'">
          <div class="toolbar-group toolbar-group-sub">
            <button :class="{ active: drawMode && !floodFillMode && !brushMode }" @click="drawMode = true; floodFillMode = false; brushMode = false" title="按住拖动绘制">✏️ 自由绘制</button>
            <button :class="{ active: !drawMode && !floodFillMode && !brushMode }" @click="drawMode = false; floodFillMode = false; brushMode = false" title="点击放置顶点">📐 点击描点</button>
            <button :class="{ active: floodFillMode }" @click="floodFillMode = !floodFillMode; brushMode = false" title="点击空白处生成区域">▣ 区域填充</button>
            <button :class="{ active: brushMode }" @click="brushMode = !brushMode; floodFillMode = false" title="按住拖动地形笔刷涂抹">🖌 笔刷</button>
            <template v-if="brushMode">
              <span class="toolbar-label">大小</span>
              <button v-for="s in [24, 40, 64, 96]" :key="s" :class="{ active: brushSize === s }" @click="brushSize = s">{{ s }}</button>
            </template>
          </div>
        </template>

        <template v-if="interactionMode === 'region'">
          <div class="toolbar-group toolbar-group-sub">
            <button :class="{ active: drawMode && !floodFillMode }" @click="drawMode = true; floodFillMode = false; brushMode = false" title="按住拖动绘制区域">✏️ 自由绘制</button>
            <button :class="{ active: !drawMode && !floodFillMode }" @click="drawMode = false; floodFillMode = false; brushMode = false" title="点击放置顶点">📐 点击描点</button>
            <button :class="{ active: floodFillMode }" @click="floodFillMode = !floodFillMode; brushMode = false" title="点击空白处自动生成区域">▣ 区域填充</button>
          </div>
        </template>

        <template v-if="interactionMode === 'route'">
          <div class="toolbar-group toolbar-group-sub">
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
          </div>
        </template>

        <template v-if="interactionMode === 'text'">
          <div class="toolbar-group toolbar-group-sub">
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
          </div>
        </template>

        <div class="toolbar-group" title="绘制辅助">
          <button v-if="interactionMode === 'draw'" :class="{ active: snapEnabled }" @click="snapEnabled = !snapEnabled" title="边缘吸附到相邻省份">🧲 吸附</button>
          <button :class="{ active: gridSnapEnabled }" @click="gridSnapEnabled = !gridSnapEnabled" title="对齐网格：绘制/移动/放置吸附到网格（按住 Ctrl 临时关闭）">⊞ 网格</button>
          <template v-if="gridSnapEnabled">
            <span class="toolbar-label">间距</span>
            <button v-for="s in [50, 100, 200]" :key="s" :class="{ active: gridSize === s }" @click="gridSize = s">{{ s }}</button>
          </template>
          <button :class="{ active: mirrorMode }" @click="mirrorMode = !mirrorMode" title="对称绘制：绘制时自动镜像（以 X/Y 轴为对称轴）">⇌ 对称</button>
          <template v-if="mirrorMode">
            <button :class="{ active: mirrorAxis === 'y' }" @click="mirrorAxis = 'y'" title="左右镜像（以竖直线 X=偏移 为对称轴）">⇋ 左右</button>
            <button :class="{ active: mirrorAxis === 'x' }" @click="mirrorAxis = 'x'" title="上下镜像（以水平线 Y=偏移 为对称轴）">⇵ 上下</button>
            <span class="toolbar-label">轴</span>
            <input type="number" class="mirror-axis-input" v-model.number="mirrorAxisOffset" step="50" title="对称轴位置（世界坐标，默认 0=原点）" />
          </template>
        </div>

        <div class="toolbar-group" title="对象操作">
          <button v-if="selectedProvince" :class="{ active: splitSelectMode }" @click="startSplitMode" title="拆分省份：点击多边形内两点画切割线">✂ 拆分</button>
          <button v-if="selectedProvince" :class="{ active: mergeSelectMode }" @click="startMergeMode" title="合并省份：再点击一个相邻省份">⛓ 合并</button>
          <button @click="deleteSelected" :disabled="!selectedProvince && !selectedRegion && !selectedMarker && !selectedRoute && !selectedTextLabel && selectedPlaceIds.size === 0" title="删除选中对象 (Del)">🗑 删除</button>
          <button v-if="selectedPlaceIds.size > 0" @click="openReparentDialog" title="批量移入区域">⬆ 移入区域</button>
          <button v-if="selectedProvince || selectedRegion" @click="smoothPolygonBoundary" title="平滑边界为贝塞尔曲线">〰️ 平滑</button>
          <button @click="undo" :disabled="!store.canUndo" :title="'撤销: ' + undoLabel">↶ 撤销</button>
          <button @click="redo" :disabled="!store.canRedo">↷ 重做</button>
          <button @click="saveMap" title="保存地图">💾 保存</button>
          <button @click="confirmClear" title="清空所有省份">🧹 清空</button>
        </div>

        <div class="toolbar-group" title="视图与输出">
          <button :class="{ active: showRefImagePanel }" @click="openPlanetPanel('refimage')" title="参考底图：导入手绘草图/大陆轮廓描摹">🖼 参考图</button>
          <select class="boundary-select" v-model="canvasSizePreset" title="行星地图边界（作为鹰眼/适屏的下限，内容超出自动扩展；正式绘制前统一各行星尺寸）">
            <option value="auto">📐 边界:自动</option>
            <option value="500">边界: ±500</option>
            <option value="800">边界: ±800</option>
            <option value="1000">边界: ±1000</option>
          </select>
          <button :class="{ active: rulerVisible }" @click="rulerVisible = !rulerVisible" title="显示/隐藏画布边缘标尺">📏 标尺</button>
          <button @click="exportFullMapPNG" title="导出全图高清 PNG（含全部省份/区域/路线/标记/文本）">📤 导出全图</button>
        </div>
        
        <div class="toolbar-group" title="图层可见性">
          <button :class="{ active: layers.isVisible('planet', 'terrain') }" @click="layers.toggleLayer('planet', 'terrain')" title="切换地形图层显示">▣ 地形</button>
          <button :class="{ active: layers.isVisible('planet', 'terrainLabels') }" @click="layers.toggleLayer('planet', 'terrainLabels')" title="切换地形名称显示">🏔 地名</button>
          <button :class="{ active: layers.isVisible('planet', 'regions') }" @click="layers.toggleLayer('planet', 'regions')" title="切换区域图层显示">▥ 区域</button>
        </div>

        <div class="toolbar-group toolbar-group-exit">
          <button class="toolbar-close" @click="exitEditMode" title="退出编辑模式">✓ 退出编辑</button>
        </div>
      </div>
    </div>
    
    <!-- 非编辑模式的导出按钮 -->
    <div v-if="!editMode" class="view-actions">
      <button class="adopt-btn" @click="openPlanetPanel('cluster')" title="地点簇大纲">🗂 地点簇</button>
      <button class="adopt-btn" :class="{ active: objectPanelOpen }" @click="openPlanetPanel('object')" title="对象列表：地形/标记/路线/文本管理">📋 对象</button>
      <button class="adopt-btn" :class="{ active: snapshotPanelOpen }" @click="openPlanetPanel('snapshot')" title="地图版本快照：拍摄/恢复">📸 快照</button>
      <button class="adopt-btn" @click="exportFullMapPNG" title="导出全图高清 PNG">📤 导出全图</button>
    </div>
    
    <!-- 导出状态提示 -->
    <div v-if="exportStatus" class="export-status">{{ exportStatus }}</div>
    
    <!-- 地形类型选择器 -->
    <div v-if="editMode && interactionMode === 'draw'" class="terrain-picker">
      <span class="picker-label">地形类型：</span>
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
    
    <div class="canvas-wrapper" @dragover.prevent="handleDragOver" @drop.prevent="handleDrop">
      <canvas ref="canvas"></canvas>
      <eagle-eye
        :view-bounds="viewBounds"
        :elements="eagleEyeElements"
        :world-bounds="worldBounds"
        @navigate="handleEagleEyeNavigate"
      />
      <!-- 空地图引导（P1-3）：浏览态且地图完全为空时提示可编辑 -->
      <div v-if="!editMode && fogMode" class="empty-map-hint">
        <div class="empty-map-icon">🗺️</div>
        <div class="empty-map-title">这张行星地图还是空的</div>
        <div class="empty-map-desc">点击「编辑地图」开始绘制省份、标记地点、规划路线</div>
        <button class="adopt-btn edit-entry-btn" @click="enterEditMode">✏️ 编辑地图</button>
      </div>
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
      <!-- 版本快照面板（P2）：与簇/对象面板互斥 -->
      <snapshot-panel
        :open="snapshotPanelOpen"
        :snapshots="mapSnapshots"
        @close="snapshotPanelOpen = false"
        @take="takeSnapshot"
        @restore="restoreSnapshot"
        @remove="removeSnapshot"
      />
      <!-- 缩放控件组（P0-1）：− 滑条 ＋ 100% 适屏 + 百分比输入 -->
      <div class="zoom-controls" @mousedown.stop @wheel.stop>
        <button @click="zoomBy(-0.2)" title="缩小">−</button>
        <input type="range" min="20" max="300" step="5" v-model.number="zoomPercent" @input="onZoomSlider" title="缩放级别" />
        <button @click="zoomBy(0.2)" title="放大">＋</button>
        <button @click="applyZoom(100)" title="重置为 100%">重置</button>
        <button @click="zoomFit" title="适屏显示全部内容">⤢</button>
        <input type="number" class="zoom-input" min="20" max="300" v-model.number="zoomPercent" @change="onZoomSlider" title="输入缩放百分比后回车/失焦生效" />
        <span class="zoom-value">%</span>
      </div>
      <!-- 保存状态横幅 -->
      <div v-if="saveStatus" class="save-banner" :class="{ error: saveStatus.startsWith('✗') }">{{ saveStatus }}</div>
      <!-- 光标世界坐标（P1-1） -->
      <div v-if="cursorCoord.visible" class="cursor-coords">X: {{ cursorCoord.x }} · Y: {{ cursorCoord.y }}</div>
      <!-- 画布边缘标尺（P2）：顶部 X 轴 / 左侧 Y 轴，随镜头联动；可开关 -->
      <div v-if="rulerVisible" class="ruler ruler-top">
        <div v-for="tick in hTicks" :key="tick.left" class="ruler-tick" :style="{ left: tick.left + 'px' }">
          <span>{{ tick.label }}</span>
        </div>
      </div>
      <div v-if="rulerVisible" class="ruler ruler-left">
        <div v-for="tick in vTicks" :key="tick.top" class="ruler-tick" :style="{ top: tick.top + 'px' }">
          <span>{{ tick.label }}</span>
        </div>
      </div>
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
      <!-- 扩展字段：海拔/气候/生态（阶段4 预留接口） -->
      <div class="editor-field">
        <label>海拔</label>
        <select
          :value="selectedProvince?.elevation || ''"
          @change="updateTerrainField('elevation', $event.target.value)"
        >
          <option value="">未指定</option>
          <option value="深海">深海 (-2000m 以下)</option>
          <option value="浅海">浅海 (-200~0m)</option>
          <option value="平原">平原 (0~200m)</option>
          <option value="丘陵">丘陵 (200~500m)</option>
          <option value="高原">高原 (500~2000m)</option>
          <option value="山地">山地 (2000~4000m)</option>
          <option value="高山">高山 (4000m+)</option>
        </select>
      </div>
      <div class="editor-field">
        <label>气候</label>
        <select
          :value="selectedProvince?.climate || ''"
          @change="updateTerrainField('climate', $event.target.value)"
        >
          <option value="">未指定</option>
          <option value="热带">热带</option>
          <option value="亚热带">亚热带</option>
          <option value="温带">温带</option>
          <option value="寒温带">寒温带</option>
          <option value="寒带">寒带</option>
          <option value="干旱">干旱</option>
          <option value="湿润">湿润</option>
        </select>
      </div>
      <div class="editor-field">
        <label>生态</label>
        <input
          type="text"
          :value="selectedProvince?.ecology || ''"
          @input="updateTerrainField('ecology', $event.target.value)"
          placeholder="生态描述（如：温带落叶林）"
        />
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
          {{ refImageLoading ? '加载中...' : (referenceImages.length > 0 ? '➕ 添加底图' : '📂 选择图片') }}
        </button>
        <p class="ref-hint">点击「编辑地图」后，从「☷ 图层」旁打开此面板或从工具栏进入</p>
      </div>
      <div class="editor-field" v-if="referenceImages.length > 0">
        <label>底图列表（{{ referenceImages.length }}）</label>
        <div class="ref-list">
          <div
            v-for="(img, idx) in referenceImages"
            :key="img.id"
            class="ref-item"
            :class="{ active: idx === activeRefIndex }"
            @click="activeRefIndex = idx"
            :title="'选中底图 ' + (idx + 1) + '（属性编辑作用于该图）'"
          >
            <span class="ref-item-name">{{ img.name || '底图 ' + (idx + 1) }}</span>
            <button class="ref-item-del" @click.stop="removeRefListItem(idx)" title="删除该底图">×</button>
          </div>
        </div>
      </div>
      <template v-if="referenceImage">
        <div class="editor-field">
          <label>透明度</label>
          <input type="range" min="0.05" max="1" step="0.05" v-model.number="refOpacity" @input="updateRefOpacity" />
          <span class="ref-value">{{ Math.round(refOpacity * 100) }}%</span>
        </div>
        <div class="editor-field">
          <label>缩放（围绕中心）</label>
          <input type="range" min="0.05" max="5" step="0.05" v-model.number="refScale" @input="updateRefScale" />
          <span class="ref-value">{{ Math.round(refScale * 100) }}%</span>
        </div>
        <div class="editor-field">
          <label>方向</label>
          <div class="line-style-row">
            <button class="adopt-btn" @click="rotateRefImage" title="顺时针旋转 90°">↻ 旋转</button>
            <button class="adopt-btn" @click="flipRefImageH" title="水平镜像（左右翻转）">⇋ 镜像</button>
          </div>
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

  <!-- 批量移入区域对话框 -->
  <div v-if="reparentDialogOpen" class="modal-overlay" @click.self="reparentDialogOpen = false">
    <div class="modal-dialog">
      <h3>批量移入区域</h3>
      <p class="modal-desc">将选中的 <strong>{{ selectedPlaceIds.size }}</strong> 个地点移入目标区域。</p>
      <div class="form-row">
        <label>目标区域</label>
        <select v-model="reparentTargetId">
          <option value="">请选择...</option>
          <option v-for="candidate in reparentCandidates" :key="candidate.id" :value="candidate.id">
            {{ candidate.displayName || candidate.name }}（{{ store.layerLabels[candidate.layer] || candidate.layer }}）
          </option>
        </select>
      </div>
      <p class="reparent-warning">⚠️ 移动后这些地点将从行星地图消失，仅在区域地图中显示。</p>
      <div class="modal-actions">
        <button class="adopt-btn" @click="confirmReparent" :disabled="!reparentTargetId">确认移入</button>
        <button class="adopt-btn ghost" @click="reparentDialogOpen = false">取消</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, reactive, onMounted, onUnmounted } from 'vue';
import { useGeodataStore } from '../store/geodata';
import { useLayersStore } from '../store/layers';
import { usePanelsStore } from '../store/panels';
import { useCanvasRenderer } from '../composables/useCanvasRenderer';
import { createPlanetDrawing } from '../composables/planetDrawing';
import { createPlanetHitTest } from '../composables/planetHitTest';
import { createPlanetInteractions } from '../composables/planetInteractions';
import { getLastCommandLabel, execute } from '../store/undo';
import { getTexturePattern, prewarmTextures } from '../utils/textures';
import { snapPolygonToNeighbors } from '../utils/snap';
import { createProvinceByFloodFill } from '../utils/floodfill';
import { validatePolygon, pointInPolygon as geoPointInPolygon, convexHull, expandPolygon, splitPolygon, mergePolygons, simplifyPath } from '../utils/geometry';
import EagleEye from './EagleEye.vue';
import ClusterPanel from './ClusterPanel.vue';
import ObjectListPanel from './ObjectListPanel.vue';
import SnapshotPanel from './SnapshotPanel.vue';

const store = useGeodataStore();
const layers = useLayersStore();
const panelsStore = usePanelsStore();

const props = defineProps({
  planet: { type: Object, default: null },
});

const emit = defineEmits(['back', 'select-node', 'dirty']);

// ===== 面板互斥（P0-2）：本地四个面板单开互斥 + 与 App 层浮层互斥 =====
function openPlanetPanel(panelName) {
  const alreadyOpen =
    (panelName === 'cluster' && clusterPanelOpen.value) ||
    (panelName === 'object' && objectPanelOpen.value) ||
    (panelName === 'snapshot' && snapshotPanelOpen.value) ||
    (panelName === 'refimage' && showRefImagePanel.value);
  // 通知 App 层关闭导出/书签/图层面板
  window.dispatchEvent(new CustomEvent('sitian:panel-open'));
  clusterPanelOpen.value = panelName === 'cluster' && !alreadyOpen;
  objectPanelOpen.value = panelName === 'object' && !alreadyOpen;
  snapshotPanelOpen.value = panelName === 'snapshot' && !alreadyOpen;
  showRefImagePanel.value = panelName === 'refimage' && !alreadyOpen;
  renderer.requestRender();
}

// App 层打开其他浮层（export/bookmarks/layers）时，关闭本地面板
watch(() => panelsStore.openPanelId, (id) => {
  if (id !== null && !['planet-cluster', 'planet-object', 'planet-snapshot', 'planet-refimage'].includes(id)) {
    clusterPanelOpen.value = false;
    objectPanelOpen.value = false;
    snapshotPanelOpen.value = false;
    showRefImagePanel.value = false;
  }
});

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

// ===== 省份拆分/合并（2026-08-16） =====
const splitSelectMode = ref(false);
const splitPoints = ref([]);
const mergeSelectMode = ref(false);
const mergeTargetId = ref(null);

// ===== 区域绘制状态 =====
const selectedRegion = ref(null);
const regionColor = ref('#FF6B6B');
const REGION_COLORS = ['#FF6B6B', '#FFA500', '#FFD700', '#32CD32', '#4169E1', '#9B59B6'];

// ===== 交互模式 =====
const interactionMode = ref('pan');
// 移动工具拖拽状态（marker/textLabel/region 走"本地改+松手一次提交"，避免 undo 栈爆炸）
const dragObject = ref(null);
const dragRegionAnchor = ref(null);
const isSpacebarDown = ref(false);
const snapEnabled = ref(true);

// ===== 网格对齐（P0-2）=====
const gridSnapEnabled = ref(true); // 网格吸附开关（与"省份边缘吸附" snapEnabled 独立）
const gridSize = ref(100);         // 网格间距 50/100/200
let snapCtrlHeld = false;          // Ctrl 按住临时关闭吸附（精细微调）

// 世界坐标吸附到网格（返回新点；Ctrl 或开关关闭时不吸附）
function snapPoint(p) {
  if (!gridSnapEnabled.value || snapCtrlHeld) return p;
  const g = gridSize.value;
  return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
}

// ===== 边缘吸附（P1-3）：绘制中实时吸附到已有地形边 =====
// 绘制落点的吸附预览（金色小圆提示将吸附到的边）
const edgeSnapPreview = ref(null);

// 点到线段的最近点
function closestPointOnSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { x: x1, y: y1 };
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return { x: x1 + t * dx, y: y1 + t * dy };
}

// 距已有地形多边形边 < threshold 时吸附到边（返回吸附点；否则原样返回）
function snapToNearestEdge(p, threshold = 12) {
  if (!snapEnabled.value) return p;
  const terrain = currentMapData.value?.terrain || [];
  let best = null;
  let bestDist = threshold;
  for (const poly of terrain) {
    const pts = poly.points || [];
    if (pts.length < 2) continue;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const cp = closestPointOnSegment(p.x, p.y, a.x, a.y, b.x, b.y);
      const d = Math.hypot(cp.x - p.x, cp.y - p.y);
      if (d < bestDist) { bestDist = d; best = cp; }
    }
  }
  return best || p;
}

// 绘制落点统一入口：边缘吸附优先（贴合已有省份边界），否则网格吸附
function snapDrawPoint(p) {
  const edge = snapToNearestEdge(p);
  if (edge !== p) {
    edgeSnapPreview.value = edge;
    return edge;
  }
  edgeSnapPreview.value = null;
  return snapPoint(p);
}

// ===== 对称绘制（P2）=====
const mirrorMode = ref(false); // 对称绘制开关
const mirrorAxis = ref('y');   // 'y'=以竖直线为对称轴 → 左右镜像；'x'=以水平线为对称轴 → 上下镜像
const mirrorAxisOffset = ref(0); // 对称轴位置（世界坐标，默认 0=原点）

function mirrorPoint(p) {
  if (!mirrorMode.value) return p;
  if (mirrorAxis.value === 'y') return { x: 2 * mirrorAxisOffset.value - p.x, y: p.y };
  return { x: p.x, y: 2 * mirrorAxisOffset.value - p.y };
}

// 对称闭合路径：原路径 + 镜像路径（反向），构成完整对称多边形
function getMirroredPath(points) {
  if (!mirrorMode.value || points.length < 2) return points;
  const mirrored = points.map(mirrorPoint).reverse();
  return [...points, ...mirrored];
}

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
  isDrawingActive.value = false;
  currentPath.value = [];
  clusterSelectMode.value = false;
  clusterBoxStart.value = null;
  clusterBoxEnd.value = null;
  dragObject.value = null;
  dragRegionAnchor.value = null;
  edgeSnapPreview.value = null;
  splitSelectMode.value = false;
  splitPoints.value = [];
  mergeSelectMode.value = false;
  mergeTargetId.value = null;
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

function updateTerrainField(field, value) {
  if (!selectedProvince.value) return;
  store.updateTerrainPolygon(props.planet.id, selectedProvince.value.id, {
    [field]: value,
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
  { type: 'lake', label: '湖泊', color: '#6FB3C8' },
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

// ===== 参考图底图（P2 多图）=====
const showRefImagePanel = ref(false);
const refImageLoading = ref(false);
const refDragMode = ref(false);
const refOpacity = ref(0.5);
const refScale = ref(1); // 参考图缩放（drawImage 以 offset 为中心，缩放保持中心不变）
// 全部参考图数组 + 当前选中索引（referenceImage 保持单图语义，其余渲染/交互代码不变）
const referenceImages = computed(() => currentMapData.value?.referenceImages || []);
const activeRefIndex = ref(0);
const referenceImage = computed(() => referenceImages.value[activeRefIndex.value] || null);
// 每张图的 HTMLImageElement 缓存（id → img）
const refImageObjs = reactive({});

// 列表变化时校正选中索引 + 懒加载全部图的 Image
watch(referenceImages, (list) => {
  if (activeRefIndex.value >= list.length) {
    activeRefIndex.value = Math.max(0, list.length - 1);
  }
  list.forEach(ref => {
    if (ref.dataUrl && refImageObjs[ref.id]?.src !== ref.dataUrl) {
      const img = new Image();
      img.onload = () => { refImageObjs[ref.id] = img; renderer.requestRender(); };
      img.src = ref.dataUrl;
    }
  });
}, { deep: true, immediate: true });

// 加载参考图（Electron 主进程读取文件 → base64 dataURL）
async function importReferenceImage() {
  if (!props.planet) return;
  refImageLoading.value = true;
  try {
    const result = await window.sitianAPI.selectReferenceImage();
    if (result?.success && result.dataUrl) {
      const img = new Image();
      img.onload = () => {
        // 默认放到画布中心，宽度适配 1200 世界单位
        const scale = 1200 / img.width;
        const cx = renderer.getViewTransform();
        const center = { x: -cx.x / cx.scale, y: -cx.y / cx.scale };
        const list = currentMapData.value.referenceImages || [];
        const refImage = {
          id: `ref_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
          name: `底图 ${list.length + 1}`,
          dataUrl: result.dataUrl,
          opacity: refOpacity.value,
          locked: false,
          offsetX: center.x,
          offsetY: center.y,
          scale,
          width: img.width,
          height: img.height,
        };
        store.updateReferenceImage(props.planet.id, refImage);
        activeRefIndex.value = (currentMapData.value.referenceImages || []).length - 1;
        refImageObjs[refImage.id] = img;
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

function updateRefScale() {
  if (!referenceImage.value) return;
  const s = Number(refScale.value);
  if (!Number.isFinite(s) || s <= 0) return;
  // offset 是参考图中心点，scale 变化时保持中心不动（围绕中心缩放）
  store.updateReferenceImage(props.planet.id, {
    ...referenceImage.value,
    scale: s,
  });
  emit('dirty', true);
}

// 参考图方向（P2）：旋转 90° 步进 / 水平镜像（绕中心）
function rotateRefImage() {
  if (!referenceImage.value) return;
  store.updateReferenceImage(props.planet.id, {
    ...referenceImage.value,
    rotation: ((referenceImage.value.rotation || 0) + 1) % 4,
  });
  emit('dirty', true);
}

function flipRefImageH() {
  if (!referenceImage.value) return;
  store.updateReferenceImage(props.planet.id, {
    ...referenceImage.value,
    flipH: !referenceImage.value.flipH,
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
  const ref = referenceImage.value;
  if (!ref) return;
  if (!confirm('确定移除该参考底图？')) return;
  store.removeReferenceImageById(props.planet.id, ref.id);
  delete refImageObjs[ref.id];
  refDragMode.value = false;
  emit('dirty', true);
}

// 从底图列表删除指定项（active 校正由 watch referenceImages 处理）
function removeRefListItem(idx) {
  const ref = referenceImages.value[idx];
  if (!ref) return;
  if (!confirm(`删除底图「${ref.name || '底图 ' + (idx + 1)}」？`)) return;
  store.removeReferenceImageById(props.planet.id, ref.id);
  delete refImageObjs[ref.id];
  if (activeRefIndex.value >= referenceImages.value.length) {
    activeRefIndex.value = Math.max(0, referenceImages.value.length - 1);
  }
  refDragMode.value = false;
  emit('dirty', true);
}

watch(referenceImage, (refImg) => {
  if (refImg?.opacity !== undefined) refOpacity.value = refImg.opacity;
  if (refImg?.scale !== undefined) refScale.value = refImg.scale;
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
  
  const planetPlaces = store.nodes.filter(p => PLACE_LAYERS.includes(p.layer) && p.parentId === planetId);
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
// 地点类层级（含 facility/village —— 曾只含 location/city/town 导致设施层地点不渲染、定位失效）
const PLACE_LAYERS = ['location', 'city', 'town', 'village', 'facility'];

const places = computed(() => {
  if (!props.planet) return [];
  return store.nodes.filter(p => PLACE_LAYERS.includes(p.layer) && p.parentId === props.planet.id);
});

// ===== 节点样式 =====
const NODE_COLORS = { city: '#5B8DEF', town: '#4ECDC4', village: '#4ECDC4', location: '#95E1D3', facility: '#B8A6D9' };
const NODE_RADIUS = { city: 10, town: 7, village: 7, location: 5, facility: 5 };
const LABEL_SIZE = { city: 13, town: 12, village: 12, location: 11, facility: 11 };
const LABEL_WEIGHT = { city: 'bold', town: 'normal', village: 'normal', location: 'normal', facility: 'normal' };

// ===== 地点类型样式（第二维度，优先于 layer 颜色） =====
const PLACE_TYPE_COLORS = {
  自然: '#4CAF50', 宗教: '#9B59B6', 皇室: '#F1C40F', 商业: '#E67E22',
  工业: '#7F8C8D', 居住: '#1ABC9C', 公共: '#3498DB', 特殊: '#E91E63',
};
const PLACE_TYPE_ICONS = {
  自然: '⛰', 宗教: '⛪', 皇室: '🏯', 商业: '🏪',
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
// 重叠率（2026-08-16）：网格采样 a 内点，统计也落在 b 内的比例（0~1）
// 用于绘制完成时检测新地形与已有地形重叠，避免互相覆盖
function polygonOverlapRatio(a, b) {
  if (!a || !b || a.length < 3 || b.length < 3) return 0;
  const minX = Math.min(...a.map(p => p.x)), maxX = Math.max(...a.map(p => p.x));
  const minY = Math.min(...a.map(p => p.y)), maxY = Math.max(...a.map(p => p.y));
  const span = Math.max(maxX - minX, maxY - minY);
  // 步长随跨度自适应（约 60 采样/边），控制采样成本
  const STEP = Math.max(6, Math.round(span / 60));
  let total = 0, inside = 0;
  for (let x = minX; x <= maxX; x += STEP) {
    for (let y = minY; y <= maxY; y += STEP) {
      if (geoPointInPolygon(x, y, a)) {
        total++;
        if (geoPointInPolygon(x, y, b)) inside++;
      }
    }
  }
  return total === 0 ? 0 : inside / total;
}


// ===== Undo/Redo label =====
const undoLabel = computed(() => getLastCommandLabel());

// ===== 绘制中的多边形状态 =====
const isDrawing = computed(() => currentPath.value.length > 0);

// ===== LOD =====
const lodRef = ref(1);

// ===== 鹰眼导航数据 =====
// 画布尺寸预设（P1-2）：auto 动态 | 500/800/1000 固定边界（作为下限，内容超出仍扩展）
const canvasSizePreset = ref('auto');
try {
  const saved = localStorage.getItem('sitian-canvas-size');
  if (saved) canvasSizePreset.value = saved;
} catch (e) { /* localStorage 不可用时忽略 */ }
watch(canvasSizePreset, (v) => {
  try { localStorage.setItem('sitian-canvas-size', v); } catch (e) { /* ignore */ }
});

const worldBounds = computed(() => {
  const preset = Number(canvasSizePreset.value);
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
  
  // 空地图：有预设用预设，否则 ±300
  if (elements.length === 0) {
    if (preset > 0) return { minX: -preset, maxX: preset, minY: -preset, maxY: preset };
    return { minX: -300, maxX: 300, minY: -300, maxY: 300 };
  }
  
  // 预设为边界下限，内容超出自动扩展
  let minX = preset > 0 ? -preset : Infinity;
  let maxX = preset > 0 ? preset : -Infinity;
  let minY = preset > 0 ? -preset : Infinity;
  let maxY = preset > 0 ? preset : -Infinity;
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
  const vt = renderer.viewTransform;
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
  // 修复：getViewTransform() 返回浅拷贝，改 vt 无效。改为 focusOn 直接设置内部 viewTransform
  renderer.focusOn(world.x, world.y, renderer.getViewTransform().scale);
}

// ===== 绘制逻辑 =====
// 图层变化时自动重绘（解决切换按钮无反馈的问题）
watch(
  () => {
    const p = layers.layers.planet;
    return Object.keys(p).map(k => p[k].visible).join(',');
  },
  () => { renderer.requestRender(); }
);

function onRender(ctx, w, h) {
  const scale = renderer.getViewTransform().scale;
  lodRef.value = Math.min(1, Math.max(0, (scale - 0.5) / 0.5));
  
  drawing.drawBackground(ctx, w, h);
  
  // 参考图底图（最底层，地形之下）
  drawing.drawReferenceImage(ctx);
  
  // 迷雾占位符：无地形数据且非编辑模式时，覆盖暗色迷雾层（原神式占位）
  if (fogMode.value) {
    drawing.drawFog(ctx, w, h);
  }
  
  if (layers.isVisible('planet', 'terrain')) {
    drawing.drawTerrain(ctx);
  }
  
  if (layers.isVisible('planet', 'terrainLabels')) {
    drawing.drawTerrainLabels(ctx);
  }
  
  if (layers.isVisible('planet', 'regions')) {
    drawing.drawRegions(ctx);
  }
  
  if (layers.isVisible('planet', 'routes')) {
    drawing.drawRoutes(ctx);
  }
  
  if (layers.isVisible('planet', 'places')) {
    drawing.drawPlaces(ctx);
  }
  
  if (layers.isVisible('planet', 'markers')) {
    drawing.drawMarkers(ctx);
  }
  
  if (layers.isVisible('planet', 'clusters')) {
    drawing.drawClusters(ctx);
  }
  
  if (layers.isVisible('planet', 'textLabels')) {
    drawing.drawTextLabels(ctx);
  }
  
  if (editMode.value) {
    drawing.drawEditHelpers(ctx);
  }
  
  drawing.drawSelectedHighlight(ctx);
  
  // 定位高亮（金色脉冲光圈 + 十字标记）
  if (focusHighlightNode.value) {
    drawFocusHighlight(ctx, focusHighlightNode.value);
  }
}

// 参考图底图渲染

// ===== 命中检测（批次 2c：拆分至 composables/planetHitTest.js，2026-08-16） =====
// 只读工厂：getState 每次命中测试取最新解包状态
const hitTestModule = createPlanetHitTest(() => ({
  layers,
  currentMapData: currentMapData.value,
  places: places.value,
  selectedProvince: selectedProvince.value,
  selectedRegion: selectedRegion.value,
  selectedRoute: selectedRoute.value,
  editMode: editMode.value,
  getNodeRadius,
}));

// ===== Canvas Renderer =====
// ===== 绘制函数（批次 2a：拆分至 composables/planetDrawing.js，2026-08-16） =====
// 工厂注入状态访问器：每次渲染 getState() 取最新解包值；绘制只读状态不修改
const drawing = createPlanetDrawing(() => ({
  lodRef: lodRef.value, editMode: editMode.value, interactionMode: interactionMode.value,
  currentMapData: currentMapData.value, places: places.value, autoRegions: autoRegions.value,
  selectedProvince: selectedProvince.value, selectedRegion: selectedRegion.value,
  selectedMarker: selectedMarker.value, selectedRoute: selectedRoute.value,
  selectedTextLabel: selectedTextLabel.value, selectedTerrain: selectedTerrain.value,
  selectedPlaceIds: selectedPlaceIds.value, hoveredNode: hoveredNode.value,
  hoveredVertex: hoveredVertex.value, hoverMemberId: hoverMemberId.value,
  highlightedPlaceId: highlightedPlaceId.value, activeClusterId: activeClusterId.value,
  activeRefIndex: activeRefIndex.value, refDragMode: refDragMode.value,
  referenceImages: referenceImages.value, refImageObjs,
  gridSize: gridSize.value, routeDashed: routeDashed.value, routeColor: routeColor.value,
  routeDraftPoints: routeDraftPoints.value, isDrawing: isDrawing.value,
  drawingPolygon: drawingPolygon.value, currentPath: currentPath.value,
  brushMode: brushMode.value, brushSize: brushSize.value, isBrushing: isBrushing.value,
  brushStrokePoints: brushStrokePoints.value, mirrorMode: mirrorMode.value,
  mirrorAxis: mirrorAxis.value, mirrorAxisOffset: mirrorAxisOffset.value,
  splitSelectMode: splitSelectMode.value, splitPoints: splitPoints.value,
  clusterBoxStart: clusterBoxStart.value, clusterBoxEnd: clusterBoxEnd.value,
  boxSelectStart: boxSelectStart.value, boxSelectEnd: boxSelectEnd.value,
  isBoxSelecting: isBoxSelecting.value, edgeSnapPreview: edgeSnapPreview.value,
  placeRegionMap: placeRegionMap.value, terrainTypes,
  screenToWorld: renderer.screenToWorld,
}));

// ===== 交互状态机（P0-2：从巨型组件拆分，composables/planetInteractions.js）=====
// getState：读通道，回调执行时惰性取最新解包状态（数组/对象内部修改直接写回 reactive）
const getState = () => ({
  interactionMode: interactionMode.value,
  isSpacebarDown: isSpacebarDown.value,
  editMode: editMode.value,
  splitSelectMode: splitSelectMode.value,
  mergeSelectMode: mergeSelectMode.value,
  refDragMode: refDragMode.value,
  brushMode: brushMode.value,
  drawMode: drawMode.value,
  isBoxSelecting: isBoxSelecting.value,
  boxSelectStart: boxSelectStart.value,
  boxSelectEnd: boxSelectEnd.value,
  isBrushing: isBrushing.value,
  brushLastPoint: brushLastPoint.value,
  brushStrokePoints: brushStrokePoints.value,
  isDrawingActive: isDrawingActive.value,
  currentPath: currentPath.value,
  clusterBoxStart: clusterBoxStart.value,
  clusterBoxEnd: clusterBoxEnd.value,
  dragObject: dragObject.value,
  dragRegionAnchor: dragRegionAnchor.value,
  selectedProvince: selectedProvince.value,
  selectedRegion: selectedRegion.value,
  selectedMarker: selectedMarker.value,
  selectedRoute: selectedRoute.value,
  selectedTextLabel: selectedTextLabel.value,
  selectedPlaceIds: selectedPlaceIds.value,
  selectedMarkerType: selectedMarkerType.value,
  splitPoints: splitPoints.value,
  mergeTargetId: mergeTargetId.value,
  drawingPolygon: drawingPolygon.value,
  refDragStart: refDragStart.value,
  refDragStartWorld: refDragStartWorld.value,
  isDraggingPlaces: isDraggingPlaces.value,
  placesDragStart: placesDragStart.value,
  referenceImage: referenceImage.value,
  currentMapData: currentMapData.value,
  places: places.value,
  planetId: props.planet.id,
  brushSize: brushSize.value,
  textFontSize: textFontSize.value,
  textColor: textColor.value,
  markerTypes,
  hitTest: (wx, wy) => hitTestModule.hitTest(wx, wy),
  hitTestVertex: (wx, wy) => hitTestModule.hitTestVertex(wx, wy),
  captureVertexSnapshot,
  snapPoint,
  snapDrawPoint,
  store,
});

// actions：写通道，组件注入 ref 整体赋值 / store 调用 / 私有函数（闭包引用后定义函数，运行时调用）
const interactions = createPlanetInteractions(getState, {
  setVertexDrag(kind, snapshot) { vertexDragKind.value = kind; vertexDragOld.value = snapshot; },
  clearVertexDrag() { vertexDragKind.value = null; vertexDragOld.value = null; },
  setRefDragStart(start, world) { refDragStart.value = start; refDragStartWorld.value = world; },
  clearRefDragStart() { refDragStart.value = null; },
  startBrush(p) { isBrushing.value = true; brushLastPoint.value = { ...p }; brushStrokePoints.value = [{ ...p }]; },
  setBrushLastPoint(p) { brushLastPoint.value = { ...p }; },
  clearBrush() { isBrushing.value = false; brushLastPoint.value = null; brushStrokePoints.value = []; },
  startDrawing(p) { isDrawingActive.value = true; currentPath.value = [p]; },
  clearDrawing() { isDrawingActive.value = false; edgeSnapPreview.value = null; currentPath.value = []; },
  setClusterBox(p) { clusterBoxStart.value = { ...p }; clusterBoxEnd.value = { ...p }; },
  setClusterBoxEnd(p) { clusterBoxEnd.value = { ...p }; },
  startBoxSelect(p) { isBoxSelecting.value = true; boxSelectStart.value = { ...p }; boxSelectEnd.value = { ...p }; },
  setBoxSelectEnd(p) { boxSelectEnd.value = { ...p }; },
  clearBoxSelect() { isBoxSelecting.value = false; boxSelectStart.value = null; boxSelectEnd.value = null; },
  setMoveObject(obj) { dragObject.value = obj; },
  setDragRegionAnchor(p) { dragRegionAnchor.value = p; },
  clearMoveObject() { dragObject.value = null; dragRegionAnchor.value = null; },
  selectOnly(kind, obj) {
    selectedProvince.value = null;
    selectedRegion.value = null;
    selectedMarker.value = null;
    selectedRoute.value = null;
    selectedTextLabel.value = null;
    if (kind === 'province') selectedProvince.value = obj;
    else if (kind === 'region') selectedRegion.value = obj;
    else if (kind === 'marker') selectedMarker.value = obj;
    else if (kind === 'route') selectedRoute.value = obj;
    else if (kind === 'textLabel') selectedTextLabel.value = obj;
    else if (kind === 'place') selectedPlaceIds.value = new Set([obj]);
  },
  setSelectedPlaces(set) { selectedPlaceIds.value = set; },
  startPlacesDrag(start, ids) {
    isDraggingPlaces.value = true;
    placesDragStart.value = { ...start };
    if (ids.length > 1) store.beginMultiNodePositionCapture(ids);
    else store.beginNodePositionCapture(ids[0]);
  },
  setPlacesDragStart(p) { placesDragStart.value = { ...p }; },
  endPlacesDrag() {
    isDraggingPlaces.value = false;
    placesDragStart.value = null;
    if (selectedPlaceIds.value.size > 1) store.endMultiNodePositionCapture();
    else selectedPlaceIds.value.forEach(id => store.endNodePositionCapture(id));
    emit('dirty', true);
  },
  commitMove() {
    const obj = dragObject.value;
    if (!obj) return;
    if (obj.type === 'marker') store.updateMarker(props.planet.id, obj.id, { x: obj.marker.x, y: obj.marker.y }, obj.old);
    else if (obj.type === 'textLabel') store.updateTextLabel(props.planet.id, obj.id, { x: obj.label.x, y: obj.label.y }, obj.old);
    else if (obj.type === 'region') store.updateRegion(props.planet.id, obj.id, { points: obj.region.points.map(p => ({ ...p })) }, { points: obj.old });
    dragObject.value = null;
    dragRegionAnchor.value = null;
    emit('dirty', true);
  },
  commitVertexDrag() {
    if (vertexDragOld.value) {
      const { kind, id, points } = vertexDragOld.value;
      const target = kind === 'route' ? selectedRoute.value : (kind === 'region' ? selectedRegion.value : selectedProvince.value);
      if (target?.points) {
        const newPoints = target.points.map(p => ({ ...p }));
        if (kind === 'province') store.updateTerrainPolygon(props.planet.id, id, { points: newPoints }, { points });
        else if (kind === 'region') store.updateRegion(props.planet.id, id, { points: newPoints }, { points });
        else if (kind === 'route') store.updateRoute(props.planet.id, id, { points: newPoints }, { points });
        emit('dirty', true);
      }
    }
    vertexDragKind.value = null;
    vertexDragOld.value = null;
  },
  finishDraw() { finishDrawing(); },
  finishBrush() { finishBrushStroke(); },
  finishCluster(wx, wy) { finishClusterBox(wx, wy); },
  setSplitPoint(p) { splitPoints.value = [p]; },
  doSplit(pA, pB) { performSplit(pA, pB); },
  doMerge(idA, idB) { performMerge(idA, idB); },
  setStatus(msg) { exportStatus.value = msg; },
  clusterClick(wx, wy) { handleClusterCanvasClick(wx, wy); },
  routeClick(wx, wy) { handleRouteClick(wx, wy); },
  pointClick(wx, wy, mode) { handlePointClick(wx, wy, mode); },
  addTextLabel(label) {
    store.addTextLabel(props.planet.id, label);
    selectedTextLabel.value = label;
    emit('dirty', true);
    renderer.requestRender();
  },
  addMarker(marker) {
    store.addMarker(props.planet.id, marker);
    selectedMarker.value = marker;
    emit('dirty', true);
    renderer.requestRender();
  },
  emitSelectNode(node) { emit('select-node', node); },
  requestRender() { renderer.requestRender(); },
});

const renderer = useCanvasRenderer(canvas, {
  onRender,
  onHitTest: (wx, wy) => hitTestModule.hitTest(wx, wy),
  onHover: (hit, wx, wy) => {
    // 光标世界坐标（左下角状态条）
    cursorCoord.value = { x: Math.round(wx), y: Math.round(wy), visible: true };
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
      const vHit = hitTestModule.hitTestVertex(wx, wy);
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
    interactions.handleCanvasClick(hit, wx, wy);
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
    // 双击地点节点：进入区域地图（下钻）
    if (hit?.type === 'place' && hit.node) {
      store.selectArea(hit.node);
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
  onDragStart: interactions.onDragStart,
  onDragMove: interactions.onDragMove,
  onDragEnd: interactions.onDragEnd,
  onWheel: (e, newScale) => {
    // 滚轮缩放 → 同步滑条/百分比显示
    zoomPercent.value = Math.round(newScale * 100);
    if (onWheelCallback) onWheelCallback(e, newScale);
  },
  drawMode,
  currentPath,
  interactionMode,
  isSpacebarDown,
});

const isDrawingActive = ref(false);

// ===== 缩放控件（P0-1）=====
// zoomPercent 为 ref：滚轮（onWheel 回调）、滑条、按钮、输入框共用，保证互相联动
const zoomPercent = ref(100);

function applyZoom(v) { // v 为百分比
  const num = Number(v);
  if (!Number.isFinite(num) || num <= 0) return;
  const s = renderer.setScale(num / 100);
  zoomPercent.value = Math.round(s * 100);
}

function zoomBy(delta) {
  applyZoom(zoomPercent.value + delta * 100);
}

function zoomFit() {
  const s = renderer.fitView(worldBounds.value);
  zoomPercent.value = Math.round(s * 100);
}

// 滑条 / 数字输入框变化 → 应用缩放（v-model 已写 zoomPercent）
function onZoomSlider() {
  const v = Number(zoomPercent.value);
  if (!Number.isFinite(v) || v <= 0) return;
  renderer.setScale(v / 100);
}

let onWheelCallback = null;

// 参考图拖动起始状态（dragInfo 中 world 坐标起点）
const refDragStart = ref(null);
const refDragStartWorld = ref(null);
// 当前顶点拖拽的对象类型（route/province/region）
const vertexDragKind = ref(null);
// 顶点拖拽起始快照（onDragStart 记录 → onDragEnd 带快照提交 undo）
const vertexDragOld = ref(null);

// 记录选中多边形/区域/路线的 points 深拷贝快照（顶点拖拽 undo 用）
function captureVertexSnapshot(kind) {
  const target = kind === 'route' ? selectedRoute.value : (kind === 'region' ? selectedRegion.value : selectedProvince.value);
  if (!target) return null;
  return {
    kind,
    id: target.id,
    points: (target.points || []).map(p => ({ ...p })),
  };
}

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
  const finalPoints = getMirroredPath(simplified);

  // 重叠检测（2026-08-16）：新地形与已有地形重叠 > 5% 时确认，避免互相覆盖
  if (!isRegion && finalPoints.length >= 3) {
    const existing = currentMapData.value?.terrain || [];
    const overlapList = existing.filter(t => polygonOverlapRatio(finalPoints, t.points) > 0.05);
    if (overlapList.length > 0) {
      const msg = `新地形与 ${overlapList.length} 个已有地形重叠（${overlapList.map(t => t.name).join('、')}）。\n重叠会互相覆盖，建议取消后用「🧲 边缘吸附」对齐边界。仍要创建吗？`;
      if (!confirm(msg)) {
        currentPath.value = [];
        renderer.requestRender();
        return;
      }
    }
  }

  const polygon = {
    id: `poly_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    // 对称模式：原路径 + 镜像路径合并成完整对称多边形
    points: finalPoints,
    type,
    name: `${typeLabel} ${count}`,
    description: '',
    elevation: '',
    climate: '',
    ecology: '',
    color: isRegion ? regionColor.value : undefined,
  };
  
  if (isRegion) {
    store.addRegion(props.planet.id, polygon);
  } else {
    store.addTerrainPolygon(props.planet.id, polygon);
  }
  
  emit('dirty', true);
}

// ===== 省份拆分/合并执行（2026-08-16） =====
function startSplitMode() {
  if (!selectedProvince.value) return;
  splitSelectMode.value = !splitSelectMode.value;
  mergeSelectMode.value = false;
  splitPoints.value = [];
  if (splitSelectMode.value) {
    exportStatus.value = '拆分模式：点击省份内两点画切割线（Esc 取消）';
  } else {
    exportStatus.value = '';
  }
  renderer.requestRender();
}

function startMergeMode() {
  if (!selectedProvince.value) return;
  mergeSelectMode.value = !mergeSelectMode.value;
  splitSelectMode.value = false;
  splitPoints.value = [];
  if (mergeSelectMode.value) {
    mergeTargetId.value = selectedProvince.value.id;
    exportStatus.value = '合并模式：再点击一个要合并的省份（Esc 取消）';
  } else {
    mergeTargetId.value = null;
    exportStatus.value = '';
  }
  renderer.requestRender();
}

function performSplit(pA, pB) {
  const poly = selectedProvince.value;
  splitSelectMode.value = false;
  splitPoints.value = [];
  if (!poly || !poly.points || poly.points.length < 4) return;
  const result = splitPolygon(poly.points, pA, pB);
  if (!result) {
    exportStatus.value = '拆分失败：切割线需穿过省份边界（两点在多边形两侧）';
    setTimeout(() => { exportStatus.value = ''; }, 3500);
    renderer.requestRender();
    return;
  }
  const [pa, pb] = result;
  const base = poly.name || '省份';
  const mkId = () => `poly_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const newA = { ...poly, id: mkId(), points: pa, controlPoints: null, name: `${base} 1` };
  const newB = { ...poly, id: mkId(), points: pb, controlPoints: null, name: `${base} 2` };
  store.splitTerrainPolygon(props.planet.id, poly.id, newA, newB);
  selectedProvince.value = null;
  emit('dirty', true);
  renderer.requestRender();
  exportStatus.value = `已拆分「${base}」为两个省份`;
  setTimeout(() => { exportStatus.value = ''; }, 3000);
}

function performMerge(idA, idB) {
  const list = currentMapData.value?.terrain || [];
  const polyA = list.find(t => t.id === idA);
  const polyB = list.find(t => t.id === idB);
  mergeSelectMode.value = false;
  mergeTargetId.value = null;
  if (!polyA || !polyB) return;
  const merged = mergePolygons(polyA.points, polyB.points);
  if (!merged) {
    exportStatus.value = '合并失败：多边形无效';
    setTimeout(() => { exportStatus.value = ''; }, 3500);
    renderer.requestRender();
    return;
  }
  const mergedNameRaw = `${polyA.name || '省份'} + ${polyB.name || '省份'}`;
  // 多次合并会让名字疯长（"陆地 1 2 + 陆地 1 1 1 + ..."），超过 20 字符截断（2026-08-16）
  const mergedName = mergedNameRaw.length > 20 ? mergedNameRaw.slice(0, 20) + '…' : mergedNameRaw;
  const newPoly = {
    ...polyA,
    id: `poly_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    points: merged,
    controlPoints: null,
    name: mergedName,
  };
  store.mergeTerrainPolygons(props.planet.id, idA, idB, newPoly);
  selectedProvince.value = newPoly;
  emit('dirty', true);
  renderer.requestRender();
  exportStatus.value = '已合并省份';
  setTimeout(() => { exportStatus.value = ''; }, 3000);
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
  const sp = snapDrawPoint({ x: wx, y: wy });
  // 若已存在绘制中的多边形，继续追加顶点
  if (drawingPolygon.value) {
    const last = drawingPolygon.value.points[drawingPolygon.value.points.length - 1];
    if (Math.hypot(sp.x - last.x, sp.y - last.y) < 5) return; // 防止重复点击同一点
    drawingPolygon.value.points.push(sp);
    renderer.requestRender();
    return;
  }
  
  // 新建绘制中的多边形
  drawingPolygon.value = {
    id: `poly_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    points: [sp],
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
  // 对称模式：原路径 + 镜像路径合并
  const finalPoly = { ...poly, points: getMirroredPath(poly.points) };
  if (finalPoly.type === 'region') {
    store.addRegion(props.planet.id, finalPoly);
  } else {
    // 重叠检测（2026-08-16）：新地形与已有地形重叠 > 5% 时确认
    if (finalPoly.points.length >= 3) {
      const existing = currentMapData.value?.terrain || [];
      const overlapList = existing.filter(t => polygonOverlapRatio(finalPoly.points, t.points) > 0.05);
      if (overlapList.length > 0) {
        const msg = `新地形与 ${overlapList.length} 个已有地形重叠（${overlapList.map(t => t.name).join('、')}）。\n重叠会互相覆盖，建议取消后用「🧲 边缘吸附」对齐边界。仍要创建吗？`;
        if (!confirm(msg)) {
          drawingPolygon.value = null;
          renderer.requestRender();
          return;
        }
      }
    }
    store.addTerrainPolygon(props.planet.id, finalPoly);
  }
  drawingPolygon.value = null;
  emit('dirty', true);
  renderer.requestRender();
}

// ===== 路线绘制交互 =====
// 在 route 模式点击画布：放置路线顶点
function handleRouteClick(wx, wy) {
  // 若命中已有路线端点，直接开始编辑该路线（选中）
  const hit = hitTestModule.hitTest(wx, wy);
  if (hit?.type === 'route' || hit?.type === 'route-endpoint') {
    selectedRoute.value = hit.route;
    routeDraftPoints.value = [];
    return;
  }
  
  // 吸附：地点优先（<20px 贴到地点坐标），否则网格吸附（开启时）
  let target = { x: wx, y: wy };
  for (const place of places.value) {
    const dx = wx - (place.coordinate?.x || 0);
    const dy = wy - (place.coordinate?.y || 0);
    if (dx * dx + dy * dy < 20 * 20) {
      target = { x: place.coordinate.x, y: place.coordinate.y, placeId: place.id };
      break;
    }
  }
  if (!target.placeId) target = snapPoint(target);
  
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
  // 互斥：打开簇面板时关闭其他面板（防止同位置叠加互相遮挡 ×）
  openPlanetPanel('cluster');
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
    if (poly.points?.length) center = drawing.getPolygonCenter(poly.points);
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
  // 异步保存 + 横幅反馈，避免用户无反馈狂点
  saveStatus.value = '正在保存...';
  store.saveMapData(props.planet.id, currentMapData.value).then(result => {
    saveStatus.value = result?.success ? '✓ 保存成功' : '✗ 保存失败';
    if (saveStatusTimer) clearTimeout(saveStatusTimer);
    saveStatusTimer = setTimeout(() => { saveStatus.value = ''; }, 3000);
  }).catch(() => {
    saveStatus.value = '✗ 保存失败';
    if (saveStatusTimer) clearTimeout(saveStatusTimer);
    saveStatusTimer = setTimeout(() => { saveStatus.value = ''; }, 3000);
  });
}

// ===== 保存状态横幅 =====
const saveStatus = ref('');
let saveStatusTimer = null;
// 版本快照面板（P2）
const snapshotPanelOpen = ref(false);
const mapSnapshots = computed(() => currentMapData.value?.snapshots || []);

function takeSnapshot(name) {
  const snap = store.addMapSnapshot(props.planet.id, name || '');
  if (snap) {
    emit('dirty', true);
    renderer.requestRender();
    saveStatus.value = `✓ 已拍摄快照「${snap.name}」`;
    if (saveStatusTimer) clearTimeout(saveStatusTimer);
    saveStatusTimer = setTimeout(() => { saveStatus.value = ''; }, 2500);
  }
}

function restoreSnapshot(snap) {
  if (!confirm(`确定恢复快照「${snap.name}」？\n当前地图内容将被快照替换（可撤销）。`)) return;
  store.restoreMapSnapshot(props.planet.id, snap.id);
  emit('dirty', true);
  renderer.requestRender();
  saveStatus.value = `✓ 已恢复快照「${snap.name}」`;
  if (saveStatusTimer) clearTimeout(saveStatusTimer);
  saveStatusTimer = setTimeout(() => { saveStatus.value = ''; }, 2500);
}

function removeSnapshot(snap) {
  if (!confirm(`删除快照「${snap.name}」？`)) return;
  store.removeMapSnapshot(props.planet.id, snap.id);
  emit('dirty', true);
  renderer.requestRender();
}
// 光标世界坐标（P1-1）
const cursorCoord = ref({ x: 0, y: 0, visible: false });
// 刚放置的地点高亮（短暂光环提示位置）
const highlightedPlaceId = ref(null);
// 定位高亮节点（金色脉冲光圈 + 十字标记，来自搜索/详情面板）
const focusHighlightNode = ref(null);
let focusHighlightTimer = null;

// ===== 画布边缘标尺（P2）=====
// 独立开关（localStorage 持久化）
const rulerVisible = ref(true);
try {
  if (localStorage.getItem('sitian-ruler') === '0') rulerVisible.value = false;
} catch (e) { /* ignore */ }
watch(rulerVisible, (v) => {
  try { localStorage.setItem('sitian-ruler', v ? '1' : '0'); } catch (e) { /* ignore */ }
});

// 选择"漂亮"步长（1/2/5×10^n），使屏幕上刻度间距 ~80px
function niceStep(raw) {
  if (!isFinite(raw) || raw <= 0) return 100;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const rem = raw / pow;
  let n;
  if (rem <= 1) n = 1;
  else if (rem <= 2) n = 2;
  else if (rem <= 5) n = 5;
  else n = 10;
  return n * pow;
}

// 顶部 X 轴刻度（依赖 reactive viewTransform，镜头移动自动重算）
const hTicks = computed(() => {
  const vt = renderer.viewTransform;
  const cvs = canvas.value;
  if (!cvs) return [];
  const w = cvs.clientWidth;
  const scale = vt.scale;
  const step = niceStep(80 / scale);
  const worldLeft = -(vt.x + w / 2) / scale;
  const start = Math.floor(worldLeft / step) * step;
  const ticks = [];
  for (let wx = start; wx <= start + (w / scale) + step; wx += step) {
    ticks.push({ left: Math.round(wx * scale + vt.x + w / 2), label: Math.round(wx) });
  }
  return ticks;
});

// 左侧 Y 轴刻度
const vTicks = computed(() => {
  const vt = renderer.viewTransform;
  const cvs = canvas.value;
  if (!cvs) return [];
  const h = cvs.clientHeight;
  const scale = vt.scale;
  const step = niceStep(80 / scale);
  const worldTop = -(vt.y + h / 2) / scale;
  const start = Math.floor(worldTop / step) * step;
  const ticks = [];
  for (let wy = start; wy <= start + (h / scale) + step; wy += step) {
    ticks.push({ top: Math.round(wy * scale + vt.y + h / 2), label: Math.round(wy) });
  }
  return ticks;
});
let highlightTimer = null;

// ===== 导航树地点拖放到画布放置 =====
function handleDragOver(e) {
  if (e.dataTransfer?.types?.includes('text/sitian-node-id')) {
    e.dataTransfer.dropEffect = 'copy';
  }
}

function handleDrop(e) {
  const nodeId = e.dataTransfer.getData('text/sitian-node-id');
  if (!nodeId) return;
  const node = store.nodes.find(n => n.id === nodeId);
  // 仅地点类节点可放置（与 TreeItem draggable 一致，双保险）
  if (!node || !['location', 'city', 'town', 'village', 'facility'].includes(node.layer)) return;
  if (!canvas.value) return;
  
  // 计算世界坐标（drop 的屏幕位置 → 画布相对 → 世界坐标 → 网格吸附）
  const rect = canvas.value.getBoundingClientRect();
  const world = renderer.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  const sp = snapPoint({ x: world.x, y: world.y });
  
  // 归属当前行星 + 设置坐标（走 undo，可撤销）
  store.updateNode(nodeId, {
    parentId: props.planet.id,
    coordinate: { x: Math.round(sp.x), y: Math.round(sp.y) },
    userMoved: true,
  });
  emit('dirty', true);
  const updated = store.nodes.find(n => n.id === nodeId);
  if (updated) emit('select-node', updated);
  renderer.requestRender();
  
  // 镜头立即定位到放置位置（至少 1.2x 保证地点图标/标签可见）+ 短暂金色光环提示
  renderer.focusOn(sp.x, sp.y, Math.max(renderer.getViewTransform().scale, 1.2));
  highlightedPlaceId.value = nodeId;
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => {
    highlightedPlaceId.value = null;
    renderer.requestRender();
  }, 2500);
  
  // 放置反馈横幅（含定位引导）
  saveStatus.value = `✓ 已放置「${node.displayName || node.name}」，镜头已定位`;
  if (saveStatusTimer) clearTimeout(saveStatusTimer);
  saveStatusTimer = setTimeout(() => { saveStatus.value = ''; }, 2500);
}

// ===== 搜索/详情定位：监听 sitian:focus-node =====
// PlanetMap 此前未监听该事件 → 搜索跳转/详情定位在行星地图无效（GalaxyMap/SystemView 已有）
function onFocusNode(e) {
  const node = e.detail;
  if (!node) return;
  const place = places.value.find(p => p.id === node.id);
  if (place && place.coordinate?.x !== null && place.coordinate?.x !== undefined) {
    renderer.focusOn(place.coordinate.x, place.coordinate.y, Math.max(renderer.getViewTransform().scale, 1.2));
    renderer.requestRender();
    showFocusHighlight(place);
  }
}

// ===== 定位高亮（金色脉冲光圈 + 十字标记） =====
function showFocusHighlight(place) {
  focusHighlightNode.value = place;
  if (focusHighlightTimer) clearTimeout(focusHighlightTimer);
  focusHighlightTimer = setTimeout(() => {
    focusHighlightNode.value = null;
    renderer.requestRender();
  }, 2000);
  renderer.requestRender();
}

function drawFocusHighlight(ctx, place) {
  const x = place.coordinate?.x || 0;
  const y = place.coordinate?.y || 0;
  const time = Date.now() / 1000;
  const pulse = Math.sin(time * 4) * 0.5 + 0.5;

  ctx.save();
  ctx.strokeStyle = '#FFD700';
  ctx.lineWidth = 3;
  ctx.shadowColor = '#FFD700';
  ctx.shadowBlur = 10 + pulse * 10;
  ctx.beginPath();
  ctx.arc(x, y, 18 + pulse * 8, 0, Math.PI * 2);
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(255, 215, 0, 0.3)';
  ctx.beginPath();
  ctx.arc(x, y, 14, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#FFD700';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - 22, y);
  ctx.lineTo(x - 10, y);
  ctx.moveTo(x + 10, y);
  ctx.lineTo(x + 22, y);
  ctx.moveTo(x, y - 22);
  ctx.lineTo(x, y - 10);
  ctx.moveTo(x, y + 10);
  ctx.lineTo(x, y + 22);
  ctx.stroke();
  ctx.restore();
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
  drawing.drawReferenceImage(ctx);
  
  if (layers.isVisible('planet', 'terrain')) drawing.drawTerrain(ctx);
  if (layers.isVisible('planet', 'terrainLabels')) drawing.drawTerrainLabels(ctx);
  if (layers.isVisible('planet', 'regions')) drawing.drawRegions(ctx);
  if (layers.isVisible('planet', 'routes')) drawing.drawRoutes(ctx);
  if (layers.isVisible('planet', 'places')) drawing.drawPlaces(ctx);
  if (layers.isVisible('planet', 'markers')) drawing.drawMarkers(ctx);
  if (layers.isVisible('planet', 'clusters')) drawing.drawClusters(ctx);
  if (layers.isVisible('planet', 'textLabels')) drawing.drawTextLabels(ctx);
  
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
  isDrawingActive.value = false;
}

function exitEditMode() {
  editMode.value = false;
  isDrawingActive.value = false;
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
  splitSelectMode.value = false;
  splitPoints.value = [];
  mergeSelectMode.value = false;
  mergeTargetId.value = null;
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
  window.addEventListener('keyup', handleKeyup);
  window.addEventListener('sitian:focus-node', onFocusNode);
});

onUnmounted(() => {
  renderer.cleanupCanvas();
  window.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('keyup', handleKeyup);
  window.removeEventListener('sitian:focus-node', onFocusNode);
  if (highlightTimer) clearTimeout(highlightTimer);
  if (focusHighlightTimer) clearTimeout(focusHighlightTimer);
});

// ===== 编辑面板拖拽 =====
// 点击面板 header 时拖动整个面板（事件委托在根容器）
// 支持：province-editor（属性编辑面板）、cluster-panel（地点簇）、object-panel（对象列表）
function handlePanelHeaderDrag(e) {
  // header 内的交互元素（× 关闭按钮、输入框、颜色按钮等）不触发拖拽
  // 否则点击 × 会先启动面板拖拽（mousedown 在 header 内冒泡到委托），面板被位移、preventDefault 吞掉关闭
  if (e.target.closest('button, input, select, textarea, a, label')) return;
  const header = e.target.closest('.province-editor .editor-header, .cluster-panel .panel-header, .object-panel .panel-header, .snapshot-panel .editor-header');
  if (!header) return;
  const panel = header.closest('.province-editor, .cluster-panel, .object-panel, .snapshot-panel');
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
  // Ctrl 按住：临时关闭网格吸附（精细微调），不受编辑模式限制
  if (e.key === 'Control') { snapCtrlHeld = true; return; }
  // Esc：取消拆分/合并模式（不依赖编辑模式）
  if (e.key === 'Escape') {
    if (splitSelectMode.value || mergeSelectMode.value) {
      splitSelectMode.value = false;
      splitPoints.value = [];
      mergeSelectMode.value = false;
      mergeTargetId.value = null;
      exportStatus.value = '';
      renderer.requestRender();
      return;
    }
  }
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

// Ctrl 松开 → 恢复网格吸附
function handleKeyup(e) {
  if (e.key === 'Control') snapCtrlHeld = false;
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

// ===== 批量移入区域 =====
const reparentDialogOpen = ref(false);
const reparentTargetId = ref('');

// 移入目标候选：当前行星下的所有聚落节点（城市/城镇/村庄）
const reparentCandidates = computed(() => {
  return store.nodes.filter(n =>
    n.parentId === props.planet.id &&
    ['city', 'town', 'village'].includes(n.layer)
  );
});

function openReparentDialog() {
  if (selectedPlaceIds.value.size === 0) return;
  reparentTargetId.value = '';
  reparentDialogOpen.value = true;
}

function confirmReparent() {
  if (!reparentTargetId.value || selectedPlaceIds.value.size === 0) return;
  const ids = Array.from(selectedPlaceIds.value);
  const results = store.reparentNodes(ids, reparentTargetId.value);
  const failed = results.filter(r => !r.success);
  if (failed.length > 0) {
    alert(`${failed.length} 个节点迁移失败：${failed.map(f => `${f.id} (${f.reason})`).join(', ')}`);
  }
  selectedPlaceIds.value = new Set();
  reparentDialogOpen.value = false;
  emit('dirty', true);
  renderer.requestRender();
}

watch(() => store.mapData[props.planet?.id], () => {
  renderer.requestRender();
}, { deep: true });

// ===== 地图数据加载（2026-08-16 修复存量缺陷） =====
// 此前 loadMapData 无任何调用方 → 打开行星地图时已保存的地形/标记/路线从不加载
watch(() => props.planet?.id, async (id) => {
  if (!id) return;
  try {
    const data = await store.loadMapData(id);
    if (data) {
      // loadMapData 已写入 store.mapData[id]，currentMapData 响应式更新
      renderer.requestRender();
      // 预生成纹理，避免首帧渲染时卡顿
      if (data.terrain?.length > 0) {
        const types = [...new Set(data.terrain.map(t => t.type))];
        const ctx = renderer.getContext?.();
        if (ctx) prewarmTextures(types, ctx);
      }
    }
  } catch (e) {
    console.error('加载地图数据失败:', e);
  }
}, { immediate: true });
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

.header-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.header-title-row h2 { margin: 0; }
.back-btn {
  padding: 3px 10px;
  border: 1px solid var(--planet-header-border);
  border-radius: var(--radius-sm);
  background: var(--planet-header-bg);
  color: var(--planet-text);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s;
}
.back-btn:hover {
  background: var(--planet-btn-hover, rgba(255,255,255,0.1));
  border-color: var(--planet-text-link);
  color: var(--planet-text-link);
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
  border-radius: var(--radius-sm);
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

/* 编辑地图主入口（醒目按钮） */
.edit-entry-btn {
  background: var(--planet-text-link, #4A90D9);
  border-color: var(--planet-text-link, #4A90D9);
  color: #fff;
  font-weight: 600;
}
.edit-entry-btn:hover {
  background: var(--planet-text-link, #4A90D9);
  filter: brightness(1.15);
  border-color: var(--planet-text-link, #4A90D9);
}

/* 画布边界预设下拉（P1-2） */
.boundary-select {
  padding: 5px 8px;
  border: 1px solid var(--planet-btn-border);
  border-radius: var(--radius-sm);
  background: var(--planet-btn-bg);
  color: var(--planet-text);
  cursor: pointer;
  font-size: 12px;
  outline: none;
}
.boundary-select:hover {
  border-color: var(--planet-btn-active-border);
}

/* 对称轴偏移输入（P2-3） */
.mirror-axis-input {
  width: 56px;
  height: 26px;
  border: 1px solid var(--planet-btn-border);
  border-radius: var(--radius-sm);
  background: var(--planet-btn-bg);
  color: var(--planet-text);
  font-size: 11px;
  text-align: center;
  outline: none;
}
.mirror-axis-input:focus {
  border-color: var(--planet-text-link, #4A90D9);
}

.edit-toolbar-wrap {
  display: flex;
  align-items: center;
  padding: 6px 16px;
  background: var(--panel-glass);
  border-bottom: 1px solid var(--planet-header-border);
}

.toolbar-toggle {
  padding: 6px 16px;
  border: 1px dashed var(--planet-btn-border);
  border-radius: var(--radius-md);
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
  border-radius: var(--radius-sm);
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
  animation: pulse-glow 2s ease-in-out infinite;
}

@keyframes pulse-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(88, 166, 255, 0.4); }
  50% { box-shadow: 0 0 0 6px rgba(88, 166, 255, 0); }
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

/* 工具栏分组（P0-1）：组间用分隔线 + 留白建立视觉层级 */
.toolbar-group {
  display: flex;
  align-items: center;
  gap: 4px;
}
.toolbar-group + .toolbar-group {
  border-left: 1px solid var(--planet-btn-border);
  margin-left: 8px;
  padding-left: 8px;
}
/* 次级选项（自由绘制/描点/颜色等子模式）弱化底色，与主工具区分 */
.toolbar-group-sub button {
  background: var(--planet-btn-hover) !important;
  font-size: 11px !important;
  padding: 5px 10px !important;
}
/* 次级按钮选中态必须恢复强调背景，否则白字浅底看不见（background 被上方 !important 覆盖） */
.toolbar-group-sub button.active {
  background: var(--planet-btn-active-bg) !important;
  border-color: var(--planet-btn-active-border) !important;
  color: white;
}
.toolbar-group-exit {
  margin-left: auto !important;
}

.terrain-picker {
  display: flex;
  gap: 6px;
  padding: 8px 20px;
  background: var(--panel-glass-soft);
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
  border-radius: var(--radius-sm);
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

/* 空地图引导卡片（P1-3） */
.empty-map-hint {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 28px 40px;
  background: rgba(13, 17, 23, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: var(--radius-xl);
  color: #e2e8f0;
  text-align: center;
  z-index: 15;
  box-shadow: var(--shadow-lg);
  max-width: 340px;
}
.empty-map-icon { font-size: 34px; line-height: 1; }
.empty-map-title { font-size: 15px; font-weight: 600; }
.empty-map-desc { font-size: 12px; color: #8b949e; }
.empty-map-hint .edit-entry-btn { margin-top: 4px; }

canvas {
  display: block;
  width: 100%;
  height: 100%;
}

/* ===== 缩放控件组（P0-1）===== */
.zoom-controls {
  position: absolute;
  right: 14px;
  bottom: 14px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--planet-editor-bg, rgba(15, 22, 35, 0.88));
  border: 1px solid var(--planet-header-border, rgba(255, 255, 255, 0.14));
  border-radius: 8px;
  box-shadow: var(--shadow-md);
  z-index: 25;
  user-select: none;
}
.zoom-controls button {
  min-width: 26px;
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--planet-header-border, rgba(255, 255, 255, 0.16));
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--planet-text, #dbe4f0);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  transition: all 0.15s;
}
.zoom-controls button:hover {
  background: rgba(255, 255, 255, 0.12);
  border-color: var(--planet-text-link, #4A90D9);
  color: var(--planet-text-link, #4A90D9);
}
.zoom-controls input[type="range"] {
  width: 110px;
  accent-color: #4A90D9;
  cursor: pointer;
}
.zoom-value {
  font-size: 11px;
  color: var(--planet-text-secondary, #8b949e);
}
.zoom-input {
  width: 54px;
  height: 26px;
  border: 1px solid var(--planet-header-border, rgba(255, 255, 255, 0.16));
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--planet-text, #dbe4f0);
  font-size: 11px;
  text-align: right;
  padding: 0 6px;
  outline: none;
}
.zoom-input:focus {
  border-color: var(--planet-text-link, #4A90D9);
}

/* ===== 保存状态横幅 ===== */
.save-banner {
  position: absolute;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  padding: 8px 20px;
  border-radius: var(--radius-md);
  background: rgba(46, 160, 67, 0.95);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  z-index: 26;
  box-shadow: var(--shadow-md);
  pointer-events: none;
  animation: save-banner-in 0.18s ease-out;
}
.save-banner.error {
  background: rgba(248, 81, 73, 0.95);
}
@keyframes save-banner-in {
  from { opacity: 0; transform: translateX(-50%) translateY(6px); }
  to { opacity: 1; transform: translateX(-50%) translateY(0); }
}

/* ===== 光标坐标状态条（P1-1）===== */
.cursor-coords {
  position: absolute;
  left: 14px;
  bottom: 14px;
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  background: rgba(15, 22, 35, 0.75);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: var(--planet-text-secondary, #aeb9c8);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  z-index: 25;
  pointer-events: none;
  user-select: none;
}

/* ===== 画布边缘标尺（P2）===== */
.ruler {
  position: absolute;
  z-index: 5;
  pointer-events: none;
  user-select: none;
  overflow: hidden;
}
.ruler-top {
  top: 0;
  left: 0;
  right: 0;
  height: 20px;
  background: rgba(15, 22, 35, 0.55);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.ruler-left {
  top: 0;
  left: 0;
  bottom: 0;
  width: 20px;
  background: rgba(15, 22, 35, 0.55);
  border-right: 1px solid rgba(255, 255, 255, 0.08);
}
.ruler-tick {
  position: absolute;
  width: 1px;
  height: 6px;
  background: rgba(255, 255, 255, 0.35);
}
.ruler-left .ruler-tick {
  width: 6px;
  height: 1px;
}
.ruler-tick span {
  position: absolute;
  top: 7px;
  left: 2px;
  font-size: 9px;
  color: rgba(200, 215, 230, 0.75);
  white-space: nowrap;
  transform: translateX(-50%);
}
.ruler-left .ruler-tick span {
  top: -4px;
  left: 8px;
  transform: none;
}

/* ===== 版本快照面板（P2）===== */

/* ===== 参考图底图列表（P2 多图）===== */
.ref-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 160px;
  overflow-y: auto;
}
.ref-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid transparent;
  cursor: pointer;
}
.ref-item:hover {
  background: rgba(255, 255, 255, 0.09);
}
.ref-item.active {
  border-color: var(--planet-text-link, #4A90D9);
  background: rgba(74, 144, 217, 0.12);
}
.ref-item-name {
  flex: 1;
  font-size: 12px;
  color: var(--planet-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ref-item-del {
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--planet-text-secondary);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  border-radius: 3px;
}
.ref-item-del:hover {
  color: #ff7b72;
  background: rgba(255, 123, 114, 0.12);
}

/* ===== 版本快照面板（P2）===== */
.province-editor {
  position: absolute;
  right: 16px;
  top: 120px;
  width: 280px;
  background: var(--planet-editor-bg);
  border-radius: 8px;
  border: 1px solid var(--planet-editor-border);
  box-shadow: var(--shadow-md);
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
  border-radius: var(--radius-sm);
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
  border-radius: var(--radius-xl);
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
  border-radius: var(--radius-sm);
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
  border-radius: var(--radius-sm);
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
  border-radius: var(--radius-sm);
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
  border-radius: var(--radius-sm);
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
  background: var(--panel-bg);
  color: #f0f6fc;
  border: 1px solid #30363d;
  border-radius: var(--radius-md);
  padding: 8px 16px;
  font-size: 12px;
  max-width: 70%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-shadow: var(--shadow-md);
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

/* 批量移入区域对话框 */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
}
.modal-dialog {
  width: 380px;
  max-width: 90vw;
  background: #161b22;
  border-radius: 10px;
  border: 1px solid #30363d;
  box-shadow: 0 16px 64px rgba(0,0,0,0.5);
  padding: 20px;
}
.modal-dialog h3 {
  margin: 0 0 8px 0;
  font-size: 16px;
  color: #e2e8f0;
}
.modal-desc {
  margin: 0 0 16px 0;
  font-size: 13px;
  color: #8b949e;
}
.form-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}
.form-row label {
  font-size: 12px;
  color: #8b949e;
  font-weight: 500;
}
.form-row select,
.form-row input {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid #30363d;
  background: #0d1117;
  color: #e2e8f0;
  font-size: 13px;
}
.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 16px;
}
.reparent-warning {
  font-size: 11px;
  color: #f0883e;
  margin: 8px 0 0 0;
  line-height: 1.4;
}
</style>
