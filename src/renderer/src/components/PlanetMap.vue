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
    
    <!-- 编辑选项栏 -->
    <div v-if="editMode" class="edit-toolbar-wrap">
      <div class="edit-toolbar">
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
            <button :class="{ active: !routeEditor.routeDashed }" @click="routeEditor.routeDashed = false" title="实线（道路/边界）">➖ 实线</button>
            <button :class="{ active: routeEditor.routeDashed }" @click="routeEditor.routeDashed = true" title="虚线（航线/秘密路线）">〰️ 虚线</button>
            <span class="toolbar-label">颜色</span>
            <button
              v-for="c in routeEditor.ROUTE_COLORS"
              :key="c"
              :class="{ active: routeEditor.routeColor === c }"
              :style="{ background: c }"
              @click="routeEditor.routeColor = c"
              class="color-btn"
            ></button>
            <span class="toolbar-label">↗ 点击放置顶点 · 双击完成 · 右键取消</span>
          </div>
        </template>

        <template v-if="interactionMode === 'text'">
          <div class="toolbar-group toolbar-group-sub">
            <span class="toolbar-label">字号</span>
            <button v-for="s in [12, 16, 22, 30]" :key="s" :class="{ active: textEditor.textFontSize === s }" @click="textEditor.textFontSize = s">{{ s }}px</button>
            <button
              v-for="c in textEditor.TEXT_COLORS"
              :key="c"
              :class="{ active: textEditor.textColor === c }"
              :style="{ background: c }"
              @click="textEditor.textColor = c"
              class="color-btn"
            ></button>
            <span class="toolbar-label">↗ 点击放置文本</span>
          </div>
        </template>

        <div class="toolbar-group" title="绘制辅助">
          <button v-if="interactionMode === 'draw'" :class="{ active: snapEnabled }" @click="snapEnabled = !snapEnabled" title="边缘吸附到相邻省份">🧲 吸附</button>
          <button :class="{ active: smartGuidesEnabled }" @click="smartGuidesEnabled = !smartGuidesEnabled" title="E5 智能参考线">⇔ 对齐</button>
          <button :class="{ active: gridSnapEnabled }" @click="gridSnapEnabled = !gridSnapEnabled" title="对齐网格">⊞ 网格</button>
          <template v-if="gridSnapEnabled">
            <span class="toolbar-label">间距</span>
            <button v-for="s in [100, 500, 1000]" :key="s" :class="{ active: gridSize === s }" @click="gridSize = s">{{ s >= 1000 ? (s/1000)+'km' : s+'m' }}</button>
          </template>
          <button :class="{ active: gridLabels }" @click="gridLabels = !gridLabels" title="显示/隐藏网格距离标签">🔢 标签</button>
          <button :class="{ active: mirrorMode }" @click="mirrorMode = !mirrorMode" title="对称绘制">⇌ 对称</button>
          <template v-if="mirrorMode">
            <button :class="{ active: mirrorAxis === 'y' }" @click="mirrorAxis = 'y'" title="左右镜像">⇋ 左右</button>
            <button :class="{ active: mirrorAxis === 'x' }" @click="mirrorAxis = 'x'" title="上下镜像">⇵ 上下</button>
            <span class="toolbar-label">轴</span>
            <input type="number" class="mirror-axis-input" v-model.number="mirrorAxisOffset" step="50" title="对称轴位置" />
          </template>
        </div>

        <div class="toolbar-group" title="对象操作">
          <button v-if="selectedProvince" :class="{ active: splitSelectMode }" @click="startSplitMode" title="拆分省份">✂ 拆分</button>
          <button v-if="selectedProvince" :class="{ active: mergeSelectMode }" @click="startMergeMode" title="合并省份">⛓ 合并</button>
          <button @click="deleteSelected" :disabled="!selectedProvince && !selectedRegion && !selectedMarker && !selectedRoute && !selectedTextLabel && selectedPlaceIds.size === 0 && multiSel.length === 0" title="删除选中对象 (Del)">🗑 删除</button>
          <button v-if="selectedPlaceIds.size > 1" @click="openArrangeDialog(selectedPlaceIds)" title="批量排列选中节点">⊞ 排列</button>
          <template v-if="selectedPlaceIds.size >= 2">
            <div class="toolbar-group" title="对齐与分布 (E3)">
              <button @click="alignSelected('left', selectedPlaceIds)" title="左对齐">⇤</button>
              <button @click="alignSelected('hcenter', selectedPlaceIds)" title="水平居中对齐">⇹</button>
              <button @click="alignSelected('right', selectedPlaceIds)" title="右对齐">⇥</button>
              <button @click="alignSelected('top', selectedPlaceIds)" title="顶对齐">⇧</button>
              <button @click="alignSelected('vcenter', selectedPlaceIds)" title="垂直居中对齐">⇳</button>
              <button @click="alignSelected('bottom', selectedPlaceIds)" title="底对齐">⇩</button>
              <button @click="distributeSelected('h', selectedPlaceIds)" title="水平等间距分布">⋯</button>
              <button @click="distributeSelected('v', selectedPlaceIds)" title="垂直等间距分布">⋮</button>
            </div>
          </template>
          <button v-if="selectedPlaceIds.size > 0" @click="openReparentDialog(selectedPlaceIds)" title="批量移入区域">⬆ 移入区域</button>
          <button v-if="selectedProvince || selectedRegion" @click="smoothPolygonBoundary" title="平滑边界">〰️ 平滑</button>
          <button @click="undo" :disabled="!store.canUndo" :title="'撤销: ' + undoLabel">↶ 撤销</button>
          <button @click="redo" :disabled="!store.canRedo">↷ 重做</button>
          <button @click="saveMap" title="保存地图">💾 保存</button>
          <button @click="confirmClear" title="清空所有省份">🧹 清空</button>
        </div>

        <div class="toolbar-group" title="视图与输出">
          <button :class="{ active: referenceImage.showRefImagePanel }" @click="openPlanetPanel('refimage')" title="参考底图">🖼 参考图</button>
          <select class="boundary-select" v-model="canvasSizePreset" title="行星地图边界">
            <option value="auto">📐 边界:自动</option>
            <option value="500">边界: ±500</option>
            <option value="800">边界: ±800</option>
            <option value="1000">边界: ±1000</option>
          </select>
          <button :class="{ active: rulerVisible }" @click="rulerVisible = !rulerVisible" title="显示/隐藏画布边缘标尺">📏 标尺</button>
          <button :class="{ active: compassVisible }" @click="compassVisible = !compassVisible" title="显示/隐藏指北针">🧭 指北针</button>
          <button :class="{ active: scaleBarVisible }" @click="scaleBarVisible = !scaleBarVisible" title="显示/隐藏比例尺">📐 比例尺</button>
          <button @click="exportFullMapPNG" title="导出全图高清 PNG">📤 导出全图</button>
        </div>
        
        <div class="toolbar-group" title="图层可见性">
          <button :class="{ active: layers.isVisible('planet', 'terrain') }" @click="layers.toggleLayer('planet', 'terrain')" title="切换地形图层显示">▣ 地形</button>
          <button :class="{ active: layers.isVisible('planet', 'terrainLabels') }" @click="layers.toggleLayer('planet', 'terrainLabels')" title="切换地形名称显示">🏔 地名</button>
          <button :class="{ active: layers.isVisible('planet', 'regions') }" @click="layers.toggleLayer('planet', 'regions')" title="切换区域图层显示">▥ 区域</button>
          <button @click="referenceImage.showExtraLayers = !referenceImage.showExtraLayers" title="更多图层（海拔/气候/降水）">☷ 更多</button>
        </div>
      </div>
    </div>
    
    <!-- 非编辑模式的导出按钮 -->
    <div v-if="!editMode" class="view-actions">
      <button class="adopt-btn" @click="openPlanetPanel('cluster')" title="地点簇大纲">🗂 地点簇</button>
      <button class="adopt-btn" :class="{ active: objectPanelOpen }" @click="openPlanetPanel('object')" title="对象列表">📋 对象</button>
      <button class="adopt-btn" :class="{ active: snapshotPanelOpen }" @click="openPlanetPanel('snapshot')" title="地图版本快照">📸 快照</button>
      <button class="adopt-btn" @click="exportFullMapPNG" title="导出全图高清 PNG">📤 导出全图</button>
    </div>
    
    <!-- 导出状态提示 -->
    <div v-if="exportStatus" class="export-status">{{ exportStatus }}</div>
    
    <!-- 地形类型选择器 -->
    <div v-if="editMode && interactionMode === 'draw'" class="terrain-picker">
      <span class="picker-label">地形类型：</span>
      <button 
        v-for="t in provinceEditor.terrainTypes" 
        :key="t.type"
        :class="{ active: selectedTerrain === t.type }"
        :style="{ background: t.color }"
        @click="selectedTerrain = t.type"
      >{{ t.label }}</button>
    </div>
    
    <!-- 更多图层面板 -->
    <div v-if="editMode && referenceImage.showExtraLayers" class="terrain-picker">
      <span class="picker-label">更多图层：</span>
      <button :class="{ active: layers.isVisible('planet', 'elevation') }" @click="layers.toggleLayer('planet', 'elevation')" title="显示海拔等高线">⛰ 海拔</button>
      <button :class="{ active: layers.isVisible('planet', 'climate') }" @click="layers.toggleLayer('planet', 'climate')" title="显示气候分区">🌡 气候</button>
      <button :class="{ active: layers.isVisible('planet', 'precipitation') }" @click="layers.toggleLayer('planet', 'precipitation')" title="显示降水分布">💧 降水</button>
    </div>

    <!-- 区域颜色选择器 -->
    <div v-if="editMode && interactionMode === 'region'" class="terrain-picker">
      <span class="picker-label">区域颜色：</span>
      <button 
          v-for="c in regionEditor.REGION_COLORS" 
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
        v-for="m in markerEditor.markerTypes" 
        :key="m.type"
        :class="{ active: markerEditor.selectedMarkerType === m.type }"
        @click="markerEditor.selectedMarkerType = m.type"
      ><span class="marker-icon">{{ m.icon }}</span> {{ m.label }}</button>
    </div>
    
    <div class="canvas-wrapper" @dragover.prevent="handleDragOver" @drop.prevent="handleDrop">
      <canvas ref="canvas"></canvas>
      <transition name="skeleton-fade"><canvas-skeleton v-if="!skeletonReady" /></transition>
      <!-- U1 工具箱 dock -->
      <div v-if="editMode" class="tool-dock" @mousedown.stop @dblclick.stop @wheel.stop>
        <button :class="{ active: interactionMode === 'pan' }" @click="setInteractionMode('pan')" title="拖动画布 (空格临时切换)">🤚</button>
        <button :class="{ active: interactionMode === 'move' }" @click="setInteractionMode('move')" title="移动对象">✥</button>
        <button :class="{ active: interactionMode === 'draw' }" @click="setInteractionMode('draw')" title="绘制省份">✏️</button>
        <button :class="{ active: interactionMode === 'region' }" @click="setInteractionMode('region')" title="圈画区域">🗺️</button>
        <button :class="{ active: interactionMode === 'marker' }" @click="setInteractionMode('marker')" title="放置标记">📍</button>
        <button :class="{ active: interactionMode === 'route' }" @click="setInteractionMode('route')" title="绘制路线">🛣️</button>
        <button :class="{ active: interactionMode === 'text' }" @click="setInteractionMode('text')" title="放置浮动文本">🔤</button>
        <button :class="{ active: interactionMode === 'cluster' }" @click="setInteractionMode('cluster'); openPlanetPanel('cluster')" title="框选地点创建簇">🗂</button>
        <div class="tool-dock-sep"></div>
        <button :class="{ active: objectPanelOpen }" @click="openPlanetPanel('object')" title="对象列表">📋</button>
        <button :class="{ active: snapshotPanelOpen }" @click="openPlanetPanel('snapshot')" title="地图版本快照">📸</button>
        <div class="tool-dock-flex"></div>
        <button class="tool-dock-exit" @click="exitEditMode" title="退出编辑模式">✓</button>
      </div>
      <!-- E9 内联文本编辑覆盖层 -->
      <div v-if="inlineEdit" class="inline-text-edit" :style="{ left: inlineEdit.sx + 'px', top: inlineEdit.sy + 'px' }" @mousedown.stop @dblclick.stop @wheel.stop>
        <input
          ref="inlineEditInput"
          v-model="inlineEdit.value"
          :style="{ fontSize: inlineEdit.fontSize + 'px', color: inlineEdit.color, width: Math.max(120, (inlineEdit.value.length * inlineEdit.fontSize * 0.62) + 32) + 'px' }"
          @keydown.enter.exact.prevent="commitInlineEdit"
          @keydown.esc.prevent="cancelInlineEdit"
          @blur="commitInlineEdit"
        />
        <div class="inline-text-hint">Enter 确认 · Esc 取消</div>
      </div>
      <!-- 右键菜单 -->
      <context-menu :state="ctxMenu.state" @close="ctxMenu.close()" />
      <eagle-eye
        :view-bounds="viewBounds"
        :elements="eagleEyeElements"
        :world-bounds="worldBounds"
        @navigate="handleEagleEyeNavigate"
      />
      <zoom-controls :renderer="renderer" :on-fit-all="fitAllContent" :on-fit-selection="fitSelection" />
      <!-- 空地图引导 -->
      <div v-if="!editMode && fogMode" class="empty-map-hint">
        <div class="empty-map-icon">🗺️</div>
        <div class="empty-map-title">这张行星地图还是空的</div>
        <div class="empty-map-desc">点击「编辑地图」开始绘制省份、标记地点、规划路线</div>
        <button class="adopt-btn edit-entry-btn" @click="enterEditMode">✏️ 编辑地图</button>
      </div>
      <cluster-panel
        :planet="props.planet"
        :open="clusterEditor.clusterPanelOpen"
        :active-cluster-id="clusterEditor.activeClusterId"
        :hover-member-id="clusterEditor.hoverMemberId"
        @create-cluster="clusterEditor.enterClusterMode"
        @focus-cluster="clusterEditor.focusCluster"
        @toggle-collapse="clusterEditor.toggleClusterCollapse"
        @hover-member="clusterEditor.hoverMemberId = $event; renderer.requestRender()"
        @select-member="clusterEditor.selectClusterMember"
        @edit-cluster="clusterEditor.openClusterEditor"
        @disband-cluster="clusterEditor.disbandCluster"
        @close="clusterEditor.clusterPanelOpen = false"
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
      <!-- 版本快照面板 -->
      <snapshot-panel
        :open="snapshotPanelOpen"
        :snapshots="mapSnapshots"
        @close="snapshotPanelOpen = false"
        @take="takeSnapshot"
        @restore="restoreSnapshot"
        @remove="removeSnapshot"
      />
      <!-- 缩放控件组 -->
      <div class="zoom-controls" @mousedown.stop @wheel.stop>
        <button @click="zoomBy(-0.2)" title="缩小">−</button>
        <input type="range" min="20" max="300" step="5" v-model.number="zoomPercent" @input="onZoomSlider" title="缩放级别" />
        <button @click="zoomBy(0.2)" title="放大">＋</button>
        <button @click="applyZoom(100)" title="重置为 100%">重置</button>
        <button @click="zoomFit" title="适屏显示全部内容">⤢</button>
        <input type="number" class="zoom-input" min="20" max="300" v-model.number="zoomPercent" @change="onZoomSlider" title="输入缩放百分比" />
        <span class="zoom-value">%</span>
      </div>
      <!-- 保存状态横幅 -->
      <div v-if="saveStatus" class="save-banner" :class="{ error: saveStatus.startsWith('✗') }">{{ saveStatus }}</div>
      <!-- 光标世界坐标 -->
      <div v-if="cursorCoord.visible" class="cursor-coords">X: {{ cursorCoord.x }} · Y: {{ cursorCoord.y }}</div>
      <!-- 画布边缘标尺 -->
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
    <div v-if="clusterEditor.clusterEditorOpen" class="cluster-dialog-backdrop">
      <div class="cluster-dialog">
        <div class="editor-header">
          <h3>{{ clusterEditor.editingCluster ? '编辑地点簇' : '创建地点簇' }}</h3>
          <button class="close-btn" @click="clusterEditor.clusterEditorOpen = false">×</button>
        </div>
        <div class="editor-field">
          <label>名称</label>
          <input v-model="clusterEditor.editingClusterName" placeholder="簇名称（如：周边村落）" />
        </div>
        <div class="editor-field">
          <label>颜色</label>
          <div class="terrain-selector">
            <button 
              v-for="c in clusterEditor.CLUSTER_COLORS" 
              :key="c"
              :class="{ active: clusterEditor.editingClusterColor === c }"
              :style="{ background: c }" 
              @click="clusterEditor.editingClusterColor = c"
              class="color-btn"
            ></button>
          </div>
        </div>
        <div v-if="clusterEditor.editingCluster" class="editor-field">
          <label>成员 ({{ clusterEditor.editingCluster?.memberIds?.length || 0 }})</label>
          <div class="members-list">
            <span v-for="memberId in clusterEditor.editingCluster?.memberIds || []" :key="memberId" class="member-tag">
              {{ getPlaceName(memberId) }}
            </span>
          </div>
        </div>
        <div class="dialog-actions">
          <button class="adopt-btn" @click="clusterEditor.saveCluster">{{ clusterEditor.editingCluster ? '保存' : '创建' }}</button>
          <button v-if="clusterEditor.editingCluster" class="adopt-btn ghost" @click="clusterEditor.disbandCluster(clusterEditor.editingCluster.id)">解散簇</button>
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
        <input v-model="provinceEditor.editingName" @input="provinceEditor.updateProvinceName" placeholder="省份名称" />
      </div>
      <div class="editor-field">
        <label>地形</label>
        <div class="terrain-selector">
          <button 
            v-for="t in provinceEditor.terrainTypes" 
            :key="t.type"
            :class="{ active: selectedProvince?.type === t.type }"
            :style="{ background: t.color }" 
            @click="provinceEditor.updateTerrainType(t.type)"
          >{{ t.label }}</button>
        </div>
      </div>
      <div class="editor-field">
        <label>描述</label>
        <textarea v-model="provinceEditor.editingDescription" @input="provinceEditor.updateProvinceDescription" placeholder="省份描述（可选）" rows="3"></textarea>
      </div>
      <div class="editor-field">
        <label>海拔</label>
        <select :value="selectedProvince?.elevation || ''" @change="provinceEditor.updateTerrainField('elevation', $event.target.value)">
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
        <select :value="selectedProvince?.climate || ''" @change="provinceEditor.updateTerrainField('climate', $event.target.value)">
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
        <input type="text" :value="selectedProvince?.ecology || ''" @input="provinceEditor.updateTerrainField('ecology', $event.target.value)" placeholder="生态描述（如：温带落叶林）" />
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
        <input v-model="regionEditor.editingRegionName" @input="regionEditor.updateRegionName" placeholder="区域名称" />
      </div>
      <div class="editor-field">
        <label>颜色</label>
        <div class="terrain-selector">
          <button 
            v-for="c in regionEditor.REGION_COLORS" 
            :key="c"
            :class="{ active: selectedRegion?.color === c }"
            :style="{ background: c }" 
            @click="regionEditor.updateRegionColor(c)"
            class="color-btn"
          ></button>
        </div>
      </div>
      <div class="editor-field">
        <label>描述</label>
        <textarea v-model="regionEditor.editingRegionDescription" @input="regionEditor.updateRegionDescription" placeholder="区域描述（可选）" rows="3"></textarea>
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
    <div v-if="editMode && selectedMarker && !batchPanelVisible" class="province-editor marker-editor">
      <div class="editor-header">
        <h3>编辑标记</h3>
        <button class="close-btn" @click="selectedMarker = null">×</button>
      </div>
      <div class="editor-field">
        <label>名称</label>
        <input v-model="markerEditor.editingMarkerName" @input="markerEditor.updateMarkerName" placeholder="标记名称（如：辉石矿脉）" />
      </div>
      <div class="editor-field">
        <label>类型</label>
        <div class="terrain-selector">
          <button 
            v-for="m in markerEditor.markerTypes" 
            :key="m.type"
            :class="{ active: selectedMarker?.type === m.type }"
            @click="markerEditor.updateMarkerType(m.type)"
          ><span class="marker-icon">{{ m.icon }}</span> {{ m.label }}</button>
        </div>
      </div>
      <div class="editor-field">
        <label>图标</label>
        <div class="icon-input-row">
          <input v-model="markerEditor.editingMarkerIcon" @input="markerEditor.updateMarkerIcon" placeholder="自定义 emoji 图标" maxlength="4" />
          <button
            v-for="m in markerEditor.markerTypes"
            :key="'ic_' + m.type"
            class="icon-pick-btn"
            :class="{ active: markerEditor.editingMarkerIcon === m.icon }"
            @click="markerEditor.editingMarkerIcon = m.icon; markerEditor.updateMarkerIcon()"
          >{{ m.icon }}</button>
        </div>
      </div>
      <div class="editor-field">
        <label>颜色</label>
        <div class="terrain-selector">
          <button 
            v-for="c in markerEditor.MARKER_COLORS" 
            :key="c"
            :class="{ active: selectedMarker?.color === c }"
            :style="{ background: c }" 
            @click="markerEditor.updateMarkerColor(c)"
            class="color-btn"
          ></button>
        </div>
      </div>
      <div class="editor-field">
        <label>描述</label>
        <textarea v-model="markerEditor.editingMarkerDesc" @input="markerEditor.updateMarkerDesc" placeholder="标记描述（可选）" rows="3"></textarea>
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
        <input v-model="routeEditor.editingRouteName" @input="routeEditor.updateRouteName" placeholder="路线名称（如：商路）" />
      </div>
      <div class="editor-field">
        <label>文字标签（显示在路线中点）</label>
        <input v-model="routeEditor.editingRouteLabel" @input="routeEditor.updateRouteLabel" placeholder="如：贸易路线·7日路程" />
      </div>
      <div class="editor-field">
        <label>标签偏移</label>
        <div class="offset-row">
          <span>X</span>
          <input type="number" v-model.number="routeEditor.editingRouteOffsetX" @input="routeEditor.updateRouteOffset" placeholder="0" />
          <span>Y</span>
          <input type="number" v-model.number="routeEditor.editingRouteOffsetY" @input="routeEditor.updateRouteOffset" placeholder="0" />
          <button class="mini-reset" @click="routeEditor.resetRouteOffset" title="重置偏移">↺</button>
        </div>
        <p class="ref-hint">调整标签相对路线的位置（世界坐标像素）</p>
      </div>
      <div class="editor-field">
        <label>线型</label>
        <div class="line-style-row">
          <button :class="{ active: !selectedRoute?.dashed }" @click="routeEditor.updateRouteDashed(false)">➖ 实线</button>
          <button :class="{ active: selectedRoute?.dashed }" @click="routeEditor.updateRouteDashed(true)">〰️ 虚线</button>
        </div>
      </div>
      <div class="editor-field">
        <label>颜色</label>
        <div class="terrain-selector">
          <button 
            v-for="c in routeEditor.ROUTE_COLORS" 
            :key="c"
            :class="{ active: selectedRoute?.color === c }"
            :style="{ background: c }" 
            @click="routeEditor.updateRouteColor(c)"
            class="color-btn"
          ></button>
        </div>
      </div>
      <div class="editor-field">
        <label>描述</label>
        <textarea v-model="routeEditor.editingRouteDesc" @input="routeEditor.updateRouteDesc" placeholder="路线描述（可选）" rows="3"></textarea>
      </div>
    </div>
    
    <!-- 选中浮动文本的属性编辑面板 -->
    <div v-if="editMode && selectedTextLabel && !batchPanelVisible" class="province-editor text-editor">
      <div class="editor-header">
        <h3>编辑文本</h3>
        <button class="close-btn" @click="selectedTextLabel = null">×</button>
      </div>
      <div class="editor-field">
        <label>内容</label>
        <textarea v-model="textEditor.editingTextContent" @input="textEditor.updateTextContent" placeholder="浮动文本内容（如：迷雾森林）" rows="3"></textarea>
      </div>
      <div class="editor-field">
        <label>字号</label>
        <div class="line-style-row">
          <button v-for="s in [12, 16, 22, 30]" :key="s" :class="{ active: selectedTextLabel?.fontSize === s }" @click="textEditor.updateTextFontSize(s)">{{ s }}px</button>
        </div>
      </div>
      <div class="editor-field">
        <label>颜色</label>
        <div class="terrain-selector">
          <button
            v-for="c in textEditor.TEXT_COLORS"
            :key="c"
            :class="{ active: selectedTextLabel?.color === c }"
            :style="{ background: c }"
            @click="textEditor.updateTextColor(c)"
            class="color-btn"
          ></button>
        </div>
      </div>
    </div>

    <!-- E7 批量属性编辑面板 -->
    <div v-if="batchPanelVisible" class="province-editor batch-editor">
      <div class="editor-header">
        <h3>批量编辑（{{ multiSelObjs.length }} 个对象）</h3>
        <button class="close-btn" @click="multiSel = []" title="取消批量选择">×</button>
      </div>
      <p class="ref-hint">拖动任一组成员可整组移动；此处统一修改共有属性</p>

      <template v-if="multiMarkers.length >= 1">
        <div class="editor-field">
          <label>标记类型（{{ multiMarkers.length }} 个标记）</label>
          <div class="terrain-selector">
            <button
              v-for="m in markerEditor.markerTypes"
              :key="m.type"
              :class="{ active: multiMarkers.every(o => o.obj.type === m.type) }"
              @click="batchApply('marker', { type: m.type, color: null })"
              :title="'统一设为' + m.label"
            ><span class="marker-icon">{{ m.icon }}</span> {{ m.label }}</button>
          </div>
        </div>
      </template>

      <template v-if="multiLabels.length >= 1">
        <div class="editor-field">
          <label>文本字号（{{ multiLabels.length }} 个文本）</label>
          <div class="line-style-row">
            <button
              v-for="s in [12, 16, 22, 30]"
              :key="s"
              :class="{ active: multiLabels.every(o => (o.obj.fontSize || 16) === s) }"
              @click="batchApply('textLabel', { fontSize: s })"
            >{{ s }}px</button>
          </div>
        </div>
        <div class="editor-field">
          <label>文本颜色</label>
          <div class="terrain-selector">
            <button
              v-for="c in textEditor.TEXT_COLORS"
              :key="c"
              :class="{ active: multiLabels.every(o => (o.obj.color || '#2D3436') === c) }"
              :style="{ background: c }"
              @click="batchApply('textLabel', { color: c })"
              class="color-btn"
            ></button>
          </div>
        </div>
      </template>

      <div class="editor-field">
        <label>变换（E4 旋转/缩放）</label>
        <div class="line-style-row">
          <button @click="batchSelection.batchResetTransform" title="旋转归零、缩放恢复 100%">↺ 重置变换</button>
        </div>
      </div>

      <div class="editor-field">
        <label>对齐与分布（P2）</label>
        <div class="line-style-row">
          <button @click="alignMultiSel('left')" title="左对齐">⇤</button>
          <button @click="alignMultiSel('hcenter')" title="水平居中对齐">⇹</button>
          <button @click="alignMultiSel('right')" title="右对齐">⇥</button>
          <button @click="alignMultiSel('top')" title="顶对齐">⇧</button>
          <button @click="alignMultiSel('vcenter')" title="垂直居中对齐">⇳</button>
          <button @click="alignMultiSel('bottom')" title="底对齐">⇩</button>
          <button @click="distributeMultiSel('h')" title="水平等间距分布">⋯</button>
          <button @click="distributeMultiSel('v')" title="垂直等间距分布">⋮</button>
        </div>
      </div>

      <div class="editor-field">
        <button class="adopt-btn batch-delete-btn" @click="deleteSelected" title="删除全部批量选中对象">🗑 删除所选（{{ multiSelObjs.length }}）</button>
      </div>
    </div>
    
    <!-- 参考图控制面板 -->
    <div v-if="editMode && referenceImage.showRefImagePanel" class="province-editor refimage-editor">
      <div class="editor-header">
        <h3>参考底图</h3>
        <button class="close-btn" @click="referenceImage.showRefImagePanel = false">×</button>
      </div>
      <div class="editor-field">
        <label>导入草图 / 大陆轮廓</label>
        <button class="adopt-btn" style="width:100%" @click="referenceImage.importReferenceImage" :disabled="referenceImage.refImageLoading">
          {{ referenceImage.refImageLoading ? '加载中...' : (referenceImage.referenceImages.length > 0 ? '➕ 添加底图' : '📂 选择图片') }}
        </button>
        <p class="ref-hint">点击「编辑地图」后，从「☷ 图层」旁打开此面板或从工具栏进入</p>
      </div>
      <div class="editor-field" v-if="referenceImage.referenceImages.length > 0">
        <label>底图列表（{{ referenceImage.referenceImages.length }}）</label>
        <div class="ref-list">
          <div
            v-for="(img, idx) in referenceImage.referenceImages"
            :key="img.id"
            class="ref-item"
            :class="{ active: idx === referenceImage.activeRefIndex }"
            @click="referenceImage.activeRefIndex = idx"
            :title="'选中底图 ' + (idx + 1) + '（属性编辑作用于该图）'"
          >
            <span class="ref-item-name">{{ img.name || '底图 ' + (idx + 1) }}</span>
            <button class="ref-item-del" @click.stop="referenceImage.removeRefListItem(idx)" title="删除该底图">×</button>
          </div>
        </div>
      </div>
      <template v-if="referenceImage.referenceImage">
        <div class="editor-field">
          <label>透明度</label>
          <input type="range" min="0.05" max="1" step="0.05" v-model.number="referenceImage.refOpacity" @input="referenceImage.updateRefOpacity" />
          <span class="ref-value">{{ Math.round(referenceImage.refOpacity * 100) }}%</span>
        </div>
        <div class="editor-field">
          <label>缩放（围绕中心）</label>
          <input type="range" min="0.05" max="5" step="0.05" v-model.number="referenceImage.refScale" @input="referenceImage.updateRefScale" />
          <span class="ref-value">{{ Math.round(referenceImage.refScale * 100) }}%</span>
        </div>
        <div class="editor-field">
          <label>方向</label>
          <div class="line-style-row">
            <button class="adopt-btn" @click="referenceImage.rotateRefImage" title="顺时针旋转 90°">↻ 旋转</button>
            <button class="adopt-btn" @click="referenceImage.flipRefImageH" title="水平镜像（左右翻转）">⇋ 镜像</button>
          </div>
        </div>
        <div class="editor-field">
          <label>锁定位置</label>
          <div class="line-style-row">
            <button :class="{ active: referenceImage.referenceImage.locked }" @click="referenceImage.toggleRefLocked">🔒 已锁定</button>
            <button :class="{ active: !referenceImage.referenceImage.locked }" @click="referenceImage.toggleRefLocked">🔓 可拖动</button>
          </div>
          <p class="ref-hint">锁定后底图不可拖动，避免描摹时误触</p>
        </div>
        <div class="editor-field" v-if="!referenceImage.referenceImage.locked">
          <label>拖动调整位置</label>
          <button class="adopt-btn" style="width:100%" @click="referenceImage.refDragMode = !referenceImage.refDragMode" :class="{ 'active-btn': referenceImage.refDragMode }">
            {{ referenceImage.refDragMode ? '✅ 拖动模式已开启（拖动画布移动底图）' : '🧲 开启拖动模式' }}
          </button>
        </div>
        <div class="editor-field">
          <label>校准（对齐到世界坐标）</label>
          <button class="adopt-btn" style="width:100%" @click="referenceImage.startCalibration" :class="{ 'active-btn': referenceImage.calibrationMode }">
            {{ referenceImage.calibrationMode ? `📐 校准中 (点 ${referenceImage.calibrationPoints.length}/2)` : '📏 两点校准' }}
          </button>
          <p class="ref-hint">点击画布上的两个已知距离的点，自动对齐底图比例</p>
          <div v-if="referenceImage.calibrationMode" class="calibration-input">
            <span class="toolbar-label">两点距离</span>
            <input type="number" v-model.number="referenceImage.calibrationDist" min="0.1" step="0.5" style="width:60px" />
            <span class="toolbar-label">km</span>
          </div>
        </div>
        <div class="editor-field" v-if="referenceImage.referenceImage.calibrated">
          <label>校准状态</label>
          <span class="ref-value" style="color:#3fb950">✓ 已校准 ({{ (referenceImage.referenceImage.ppm || 0).toFixed(1) }} px/km)</span>
        </div>
        <div class="editor-field">
          <label>移除底图</label>
          <button class="adopt-btn ghost" style="width:100%" @click="referenceImage.removeReferenceImage">🗑 移除</button>
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
        <button class="adopt-btn" @click="confirmReparent(selectedPlaceIds)" :disabled="!reparentTargetId">确认移入</button>
        <button class="adopt-btn ghost" @click="reparentDialogOpen = false">取消</button>
      </div>
    </div>
  </div>

  <!-- 批量排列对话框 -->
  <div v-if="arrangeDialogOpen" class="modal-overlay" @click.self="arrangeDialogOpen = false">
    <div class="modal-dialog">
      <h3>批量排列节点 ({{ selectedPlaceIds.size }})</h3>
      <div class="form-row">
        <label>排列方式</label>
        <select v-model="arrangeMode">
          <option value="grid">网格</option>
          <option value="circle">圆形</option>
          <option value="line_h">水平线</option>
          <option value="line_v">垂直线</option>
        </select>
      </div>
      <div class="form-row" v-if="arrangeMode === 'grid'">
        <label>列数</label>
        <input type="number" v-model.number="arrangeCols" min="1" max="20" />
      </div>
      <div class="form-row">
        <label>间距 (km)</label>
        <input type="number" v-model.number="arrangeSpacing" min="1" max="10000" step="10" />
      </div>
      <div class="modal-actions">
        <button class="adopt-btn" @click="confirmArrange(selectedPlaceIds)">应用</button>
        <button class="adopt-btn ghost" @click="arrangeDialogOpen = false">取消</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, reactive, onMounted, onUnmounted, nextTick } from 'vue';
import { useGeodataStore } from '../store/geodata';
import { useLayersStore } from '../store/layers';
import { usePanelsStore } from '../store/panels';
import { useCanvasRenderer } from '../composables/useCanvasRenderer';
import { createPlanetDrawing } from '../composables/planetDrawing';
import { createPlanetHitTest } from '../composables/planetHitTest';
import { createPlanetInteractions } from '../composables/planetInteractions';
import { useProvinceEditor } from '../composables/useProvinceEditor';
import { useRegionEditor } from '../composables/useRegionEditor';
import { useMarkerEditor } from '../composables/useMarkerEditor';
import { useRouteEditor } from '../composables/useRouteEditor';
import { useTextEditor } from '../composables/useTextEditor';
import { useReferenceImage } from '../composables/useReferenceImage';
import { useClusterEditor } from '../composables/useClusterEditor';
import { useBatchSelection } from '../composables/useBatchSelection';
import { usePanelManager } from '../composables/usePanelManager';
import { useObjectPanel } from '../composables/useObjectPanel';
import { useSnapshotPanel } from '../composables/useSnapshotPanel';
import { useBatchArrange } from '../composables/useBatchArrange';
import { useBrushDrawing } from '../composables/useBrushDrawing';
import { useProvinceSplitMerge } from '../composables/useProvinceSplitMerge';
import { useAutoRegions } from '../composables/useAutoRegions';
import { useZoomControls } from '../composables/useZoomControls';
import { useRuler } from '../composables/useRuler';
import { useInlineEdit } from '../composables/useInlineEdit';
import { useFocusHighlight } from '../composables/useFocusHighlight';
import { useFullMapExport } from '../composables/useFullMapExport';
import { useKeyboardShortcuts } from '../composables/useKeyboardShortcuts';
import { getLastCommandLabel, execute } from '../store/undo';
import { getTexturePattern, prewarmTextures } from '../utils/textures';
import { snapPolygonToNeighbors } from '../utils/snap';
import { alignItems, distributeItems, diffPositions } from '../utils/align';
import { setClipboard, getClipboard, cloneItem } from '../utils/clipboard';
import { showStatusBar, hideStatusBar, setStatusThrottled, setStatus } from '../composables/useStatusBar';
import { useContextMenu } from '../composables/useContextMenu';
import { createProvinceByFloodFill } from '../utils/floodfill';
import { validatePolygon, pointInPolygon as geoPointInPolygon, convexHull, expandPolygon, splitPolygon, mergePolygons, simplifyPath } from '../utils/geometry';
import CanvasSkeleton from './CanvasSkeleton.vue';
import EagleEye from './EagleEye.vue';
import ClusterPanel from './ClusterPanel.vue';
import ObjectListPanel from './ObjectListPanel.vue';
import SnapshotPanel from './SnapshotPanel.vue';
import ZoomControls from './ZoomControls.vue';
import ContextMenu from './ContextMenu.vue';

const store = useGeodataStore();
const layers = useLayersStore();
const panelsStore = usePanelsStore();

const props = defineProps({
  planet: { type: Object, default: null },
});

const emit = defineEmits(['back', 'select-node', 'dirty']);

// ===== 基础状态 =====
const canvas = ref(null);
const skeletonReady = ref(false);
const drawMode = ref(true);
const floodFillMode = ref(false);
const currentPath = ref([]);
const hoveredNode = ref(null);
const floodPreview = ref(null);
const editMode = ref(false);
const selectedTerrain = ref('land');
const selectedProvince = ref(null);
const drawingPolygon = ref(null);
const isBoxSelecting = ref(false);
const boxSelectStart = ref(null);
const boxSelectEnd = ref(null);
const selectedPlaceIds = ref(new Set());
const isDraggingPlaces = ref(false);
const placesDragStart = ref(null);
const editingVertex = ref(null);
const hoveredVertex = ref(null);
const selectedRegion = ref(null);
const regionColor = ref('#FF6B6B');
const interactionMode = ref('pan');
const dragObject = ref(null);
const dragRegionAnchor = ref(null);
const isSpacebarDown = ref(false);
const snapEnabled = ref(true);
const gridSnapEnabled = ref(true);
const gridSize = ref(500);
const gridLabels = ref(true);
const edgeSnapPreview = ref(null);
const mirrorMode = ref(false);
const mirrorAxis = ref('y');
const mirrorAxisOffset = ref(0);
const selectedMarker = ref(null);
const selectedRoute = ref(null);
const selectedTextLabel = ref(null);
const isDrawingActive = ref(false);
const refDragStart = ref(null);
const refDragStartWorld = ref(null);
const vertexDragKind = ref(null);
const vertexDragOld = ref(null);
const objectPanelOpen = ref(false);
const activeObjectId = ref(null);
const canvasSizePreset = ref('auto');
const highlightedPlaceId = ref(null);
const cursorCoord = ref({ x: 0, y: 0, visible: false });
const lodRef = ref(1);

try {
  const saved = localStorage.getItem('sitian-canvas-size');
  if (saved) canvasSizePreset.value = saved;
} catch (e) { /* ignore */ }
watch(canvasSizePreset, (v) => {
  try { localStorage.setItem('sitian-canvas-size', v); } catch (e) { /* ignore */ }
});

// ===== 当前地图数据 =====
const currentMapData = computed(() => {
  if (!props.planet) return null;
  return store.mapData[props.planet.id] || { planetId: props.planet.id, version: 1, terrain: [], regions: [], markers: [], routes: [], textLabels: [] };
});

// ===== 地点集合 =====
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
const PLACE_TYPE_COLORS = { '自然': '#4CAF50', '宗教': '#9B59B6', '皇室': '#F1C40F', '商业': '#E67E22', '工业': '#7F8C8D', '居住': '#1ABC9C', '公共': '#3498DB', '特殊': '#E91E63' };
const PLACE_TYPE_ICONS = { '自然': '⛰', '宗教': '⛪', '皇室': '🏯', '商业': '🏪', '工业': '🏭', '居住': '🏠', '公共': '🏛', '特殊': '✦' };

function getNodeColor(layer) { return NODE_COLORS[layer] || '#95E1D3'; }
function getNodeRadius(layer) { return NODE_RADIUS[layer] || 5; }
function getLabelSize(layer) { return LABEL_SIZE[layer] || 11; }
function getLabelWeight(layer) { return LABEL_WEIGHT[layer] || 'normal'; }
function getPlaceColor(place) { return place.placeType && PLACE_TYPE_COLORS[place.placeType] ? PLACE_TYPE_COLORS[place.placeType] : getNodeColor(place.layer); }
function getPlaceIcon(place) { return place.placeType ? PLACE_TYPE_ICONS[place.placeType] : null; }

// ===== 属性编辑器 composables =====
const provinceEditor = useProvinceEditor({ store, props, emit, selectedProvince });
const regionEditor = useRegionEditor({ store, props, emit, selectedRegion });
const markerEditor = useMarkerEditor({ store, props, emit, selectedMarker });
const textEditor = useTextEditor({ store, props, emit, selectedTextLabel });

// ===== 解构 composables 到组件作用域 =====
// 这些需要在 renderer 创建前声明，以便传递给 composables
const exportStatus = ref('');
const zoomPercent = ref(100);

// ===== 辅助函数 =====
function getPlaceName(placeId) { const place = places.value.find(p => p.id === placeId); return place?.name || placeId; }
function captureVertexSnapshot(kind) {
  const target = kind === 'route' ? selectedRoute.value : (kind === 'region' ? selectedRegion.value : selectedProvince.value);
  if (!target) return null;
  return { kind, id: target.id, points: (target.points || []).map(p => ({ ...p })) };
}

// ===== 命中测试 =====
function polygonOverlapRatio(a, b) {
  if (!a || !b || a.length < 3 || b.length < 3) return 0;
  const minX = Math.min(...a.map(p => p.x)), maxX = Math.max(...a.map(p => p.x));
  const minY = Math.min(...a.map(p => p.y)), maxY = Math.max(...a.map(p => p.y));
  const span = Math.max(maxX - minX, maxY - minY);
  const STEP = Math.max(6, Math.round(span / 60));
  let total = 0, inside = 0;
  for (let x = minX; x <= maxX; x += STEP) {
    for (let y = minY; y <= maxY; y += STEP) {
      if (geoPointInPolygon(x, y, a)) { total++; if (geoPointInPolygon(x, y, b)) inside++; }
    }
  }
  return total === 0 ? 0 : inside / total;
}

// ===== Undo/Redo label =====
const undoLabel = computed(() => getLastCommandLabel());
const isDrawing = computed(() => currentPath.value.length > 0);

// ===== 鹰眼导航数据 =====
const worldBounds = computed(() => {
  const preset = Number(canvasSizePreset.value);
  const elements = [];
  for (const poly of currentMapData.value?.terrain || []) { if (poly.points) elements.push(...poly.points); }
  for (const region of currentMapData.value?.regions || []) { if (region.points) elements.push(...region.points); }
  for (const route of currentMapData.value?.routes || []) { if (route.points) elements.push(...route.points); }
  for (const marker of currentMapData.value?.markers || []) { elements.push({ x: marker.x, y: marker.y }); }
  for (const label of currentMapData.value?.textLabels || []) { elements.push({ x: label.x, y: label.y }); }
  for (const place of places.value) { if (place.coordinate?.x !== null && place.coordinate?.x !== undefined) elements.push({ x: place.coordinate.x, y: place.coordinate.y }); }
  if (elements.length === 0) { if (preset > 0) return { minX: -preset, maxX: preset, minY: -preset, maxY: preset }; return { minX: -300, maxX: 300, minY: -300, maxY: 300 }; }
  let minX = preset > 0 ? -preset : Infinity, maxX = preset > 0 ? preset : -Infinity, minY = preset > 0 ? -preset : Infinity, maxY = preset > 0 ? preset : -Infinity;
  for (const p of elements) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const padding = 50;
  return { minX: minX - padding, maxX: maxX + padding, minY: minY - padding, maxY: maxY + padding };
});

const viewBounds = computed(() => {
  const vt = renderer.viewTransform;
  const cvs = canvas.value;
  if (!cvs) return worldBounds.value;
  const w = cvs.clientWidth / vt.scale, h = cvs.clientHeight / vt.scale;
  const cx = -vt.x / vt.scale, cy = -vt.y / vt.scale;
  return { minX: cx - w / 2, maxX: cx + w / 2, minY: cy - h / 2, maxY: cy + h / 2 };
});

const eagleEyeElements = computed(() => {
  const elements = [];
  for (const poly of currentMapData.value?.terrain || []) { elements.push({ type: 'polygon', points: poly.points, color: provinceEditor.terrainTypes.find(t => t.type === poly.type)?.color || '#A3C4BC', id: poly.id }); }
  for (const region of currentMapData.value?.regions || []) { elements.push({ type: 'polygon', points: region.points, color: region.color || '#FF6B6B', id: region.id }); }
  for (const place of places.value) { elements.push({ type: 'node', x: place.coordinate?.x || 0, y: place.coordinate?.y || 0, r: getNodeRadius(place.layer), color: getPlaceColor(place), glow: false }); }
  for (const marker of currentMapData.value?.markers || []) { elements.push({ type: 'marker', x: marker.x, y: marker.y, r: 6, color: marker.color || markerEditor.markerTypes.find(m => m.type === marker.type)?.color || '#FFD700', glow: true }); }
  for (const route of currentMapData.value?.routes || []) { if (route.points && route.points.length >= 2) { for (let i = 0; i < route.points.length - 1; i++) { elements.push({ type: 'line', from: route.points[i], to: route.points[i + 1], color: route.color || '#E67E22', dashed: !!route.dashed }); } } }
  return elements;
});

function handleEagleEyeNavigate(world) { renderer.focusOn(world.x, world.y, renderer.getViewTransform().scale); }

// ===== 绘制逻辑 =====
watch(() => { const p = layers.layers.planet; return Object.keys(p).map(k => p[k].visible).join(','); }, () => { renderer.requestRender(); });

function onRender(ctx, w, h) {
  const scale = renderer.getViewTransform().scale;
  lodRef.value = Math.min(1, Math.max(0, (scale - 0.5) / 0.5));
  drawing.drawBackground(ctx, w, h);
  drawing.drawReferenceImage(ctx);
  if (fogMode.value) drawing.drawFog(ctx, w, h);
  if (layers.isVisible('planet', 'terrain')) drawing.drawTerrain(ctx);
  if (layers.isVisible('planet', 'elevation')) drawing.drawElevation(ctx);
  if (layers.isVisible('planet', 'climate')) drawing.drawClimate(ctx);
  if (layers.isVisible('planet', 'precipitation')) drawing.drawPrecipitation(ctx);
  if (layers.isVisible('planet', 'terrainLabels')) drawing.drawTerrainLabels(ctx);
  if (layers.isVisible('planet', 'regions')) drawing.drawRegions(ctx);
  if (layers.isVisible('planet', 'routes')) drawing.drawRoutes(ctx);
  if (layers.isVisible('planet', 'places')) drawing.drawPlaces(ctx);
  if (layers.isVisible('planet', 'markers')) drawing.drawMarkers(ctx);
  if (layers.isVisible('planet', 'clusters')) drawing.drawClusters(ctx);
  if (layers.isVisible('planet', 'textLabels')) drawing.drawTextLabels(ctx);
  if (editMode.value) drawing.drawEditHelpers(ctx);
  drawing.drawSelectedHighlight(ctx);
  drawing.drawSelectionHandles(ctx);
  if (focusHighlightNode.value) focusHighlight.drawFocusHighlight(ctx, focusHighlightNode.value);
}

// ===== 命中检测 =====
const ctxMenu = useContextMenu();
const hitTestModule = createPlanetHitTest(() => ({
  layers, currentMapData: currentMapData.value, places: places.value,
  selectedProvince: selectedProvince.value, selectedRegion: selectedRegion.value,
  selectedRoute: selectedRoute.value, selectedMarker: selectedMarker.value,
  selectedTextLabel: selectedTextLabel.value, editMode: editMode.value,
  zoom: renderer.viewTransform.scale, getNodeRadius,
}));

// ===== Canvas Renderer =====
const EMPTY_REGION_MAP = new Map();
function getRenderViewport() {
  const cvs = canvas.value;
  if (!cvs) return null;
  const tl = renderer.screenToWorld(0, 0);
  const br = renderer.screenToWorld(cvs.clientWidth, cvs.clientHeight);
  return { minX: Math.min(tl.x, br.x), minY: Math.min(tl.y, br.y), maxX: Math.max(tl.x, br.x), maxY: Math.max(tl.y, br.y) };
}

const drawing = createPlanetDrawing(() => ({
  lodRef: lodRef.value, editMode: editMode.value, interactionMode: interactionMode.value,
  currentMapData: currentMapData.value, places: places.value, autoRegions: autoRegions.value,
  selectedProvince: selectedProvince.value, selectedRegion: selectedRegion.value,
  selectedMarker: selectedMarker.value, selectedRoute: selectedRoute.value,
  selectedTextLabel: selectedTextLabel.value, selectedTerrain: selectedTerrain.value,
  selectedPlaceIds: selectedPlaceIds.value, hoveredNode: hoveredNode.value,
  hoveredVertex: hoveredVertex.value, hoverMemberId: clusterEditor.hoverMemberId,
  highlightedPlaceId: highlightedPlaceId.value, activeClusterId: clusterEditor.activeClusterId,
  activeRefIndex: referenceImage.activeRefIndex.value, refDragMode: referenceImage.refDragMode.value,
  referenceImages: referenceImage.referenceImages.value, refImageObjs: referenceImage.refImageObjs,
  gridSize: gridSize.value, gridLabels: gridLabels.value, routeDashed: routeEditor.routeDashed, routeColor: routeEditor.routeColor,
  calibrationPoints: referenceImage.calibrationPoints.value, calibrationMode: referenceImage.calibrationMode.value,
  compassVisible: compassVisible.value, scaleBarVisible: scaleBarVisible.value,
  routeDraftPoints: routeEditor.routeDraftPoints, isDrawing: isDrawing.value,
  drawingPolygon: drawingPolygon.value, currentPath: currentPath.value,
  brushMode: brushMode.value, brushSize: brushSize.value, isBrushing: isBrushing.value,
  brushStrokePoints: brushStrokePoints.value, mirrorMode: mirrorMode.value,
  mirrorAxis: mirrorAxis.value, mirrorAxisOffset: mirrorAxisOffset.value,
  splitSelectMode: splitSelectMode.value, splitPoints: splitPoints.value,
  clusterBoxStart: clusterEditor.clusterBoxStart, clusterBoxEnd: clusterEditor.clusterBoxEnd,
  boxSelectStart: boxSelectStart.value, boxSelectEnd: boxSelectEnd.value,
  isBoxSelecting: isBoxSelecting.value, edgeSnapPreview: edgeSnapPreview.value,
  placeRegionMap: renderer.isFastMode() ? EMPTY_REGION_MAP : placeRegionMap.value,
  terrainTypes: provinceEditor.terrainTypes, markerTypes: markerEditor.markerTypes,
  isFastMode: renderer.isFastMode(), viewport: getRenderViewport(),
  screenToWorld: renderer.screenToWorld, zoom: renderer.viewTransform.scale, smartGuides: smartGuides,
}));

// ===== 交互状态机 =====
function isShiftToggleActive(id, type) {
  const t = batchSelection.lastShiftToggle.value;
  return !!(t && t.id === id && t.type === type && Date.now() - t.t < 600);
}

function setPrimarySelection(kind, obj) {
  selectedProvince.value = null; selectedRegion.value = null; selectedMarker.value = null; selectedRoute.value = null; selectedTextLabel.value = null;
  if (kind === 'province') selectedProvince.value = obj;
  else if (kind === 'region') selectedRegion.value = obj;
  else if (kind === 'marker') selectedMarker.value = obj;
  else if (kind === 'route') selectedRoute.value = obj;
  else if (kind === 'textLabel') selectedTextLabel.value = obj;
  else if (kind === 'place') selectedPlaceIds.value = new Set([obj]);
}

const getState = () => ({
  interactionMode: interactionMode.value, isSpacebarDown: isSpacebarDown.value, editMode: editMode.value,
  splitSelectMode: splitSelectMode.value, mergeSelectMode: mergeSelectMode.value,
  refDragMode: referenceImage.refDragMode.value, brushMode: brushMode.value, drawMode: drawMode.value,
  isBoxSelecting: isBoxSelecting.value, boxSelectStart: boxSelectStart.value, boxSelectEnd: boxSelectEnd.value,
  isBrushing: isBrushing.value, brushLastPoint: brushLastPoint.value, brushStrokePoints: brushStrokePoints.value,
  isDrawingActive: isDrawingActive.value, currentPath: currentPath.value,
  clusterBoxStart: clusterEditor.clusterBoxStart, clusterBoxEnd: clusterEditor.clusterBoxEnd,
  dragObject: dragObject.value, dragRegionAnchor: dragRegionAnchor.value,
  selectedProvince: selectedProvince.value, selectedRegion: selectedRegion.value,
  selectedMarker: selectedMarker.value, selectedRoute: selectedRoute.value,
  selectedTextLabel: selectedTextLabel.value, selectedPlaceIds: selectedPlaceIds.value,
  selectedMarkerType: markerEditor.selectedMarkerType, splitPoints: splitPoints.value,
  mergeTargetId: mergeTargetId.value, drawingPolygon: drawingPolygon.value,
  refDragStart: refDragStart.value, refDragStartWorld: refDragStartWorld.value,
  isDraggingPlaces: isDraggingPlaces.value, placesDragStart: placesDragStart.value,
  referenceImage: referenceImage.referenceImage, currentMapData: currentMapData.value, places: places.value,
  planetId: props.planet.id, brushSize: brushSize.value, textFontSize: textEditor.textFontSize,
  textColor: textEditor.textColor, markerTypes: markerEditor.markerTypes, zoom: renderer.viewTransform.scale,
  multiSel: multiSel.value, smartGuidesEnabled: smartGuidesEnabled.value,
  transformDrag: batchSelection.transformDrag.value, isShiftToggled: (id, type) => isShiftToggleActive(id, type),
  hitTestSelectionHandle: (wx, wy) => hitTestModule.hitTestSelectionHandle(wx, wy),
  hitTest: (wx, wy) => hitTestModule.hitTest(wx, wy),
  hitTestVertex: (wx, wy) => hitTestModule.hitTestVertex(wx, wy),
  captureVertexSnapshot, snapPoint, snapDrawPoint, store,
});

const interactions = createPlanetInteractions(getState, {
  setVertexDrag(kind, snapshot) { vertexDragKind.value = kind; vertexDragOld.value = snapshot; },
  clearVertexDrag() { vertexDragKind.value = null; vertexDragOld.value = null; },
  setRefDragStart(start, world) { refDragStart.value = start; refDragStartWorld.value = world; },
  clearRefDragStart() { refDragStart.value = null; },
  startBrush(p) { isBrushing.value = true; brushLastPoint.value = { ...p }; brushStrokePoints.value = [{ ...p }]; },
  setBrushLastPoint(p) { brushLastPoint.value = { ...p }; },
  clearBrush() { brushDrawing.clearBrush(); },
  startDrawing(p) { isDrawingActive.value = true; currentPath.value = [p]; },
  clearDrawing() { isDrawingActive.value = false; edgeSnapPreview.value = null; currentPath.value = []; },
  setClusterBox(p) { clusterEditor.clusterBoxStart = { ...p }; clusterEditor.clusterBoxEnd = { ...p }; },
  setClusterBoxEnd(p) { clusterEditor.clusterBoxEnd = { ...p }; },
  startBoxSelect(p) { isBoxSelecting.value = true; boxSelectStart.value = { ...p }; boxSelectEnd.value = { ...p }; },
  setBoxSelectEnd(p) { boxSelectEnd.value = { ...p }; },
  clearBoxSelect() { isBoxSelecting.value = false; boxSelectStart.value = null; boxSelectEnd.value = null; },
  setMoveObject(obj) { dragObject.value = obj; },
  setDragRegionAnchor(p) { dragRegionAnchor.value = p; },
  clearMoveObject() { dragObject.value = null; dragRegionAnchor.value = null; },
  selectOnly(kind, obj) { multiSel.value = []; setPrimarySelection(kind, obj); },
  selectOnlyKeepGroup(kind, obj) { setPrimarySelection(kind, obj); },
  shiftSelect(kind, obj) {
    const idx = multiSel.value.findIndex(m => m.type === kind && m.id === obj.id);
    if (idx >= 0) multiSel.value = multiSel.value.filter((_, i) => i !== idx);
    else multiSel.value = [...multiSel.value, { type: kind, id: obj.id }];
    batchSelection.lastShiftToggle.value = { type: kind, id: obj.id, t: Date.now() };
    setPrimarySelection(kind, obj);
  },
  isShiftToggled(id, type) { const t = batchSelection.lastShiftToggle.value; return !!(t && t.id === id && t.type === type && Date.now() - t.t < 600); },
  beginMultiObjectDrag(start) {
    const members = [];
    multiSel.value.forEach(m => {
      const obj = m.type === 'marker' ? currentMapData.value?.markers?.find(o => o.id === m.id) : currentMapData.value?.textLabels?.find(o => o.id === m.id);
      if (obj) members.push({ type: m.type, id: m.id, obj, old: { x: obj.x, y: obj.y } });
    });
    if (members.length === 0) return;
    dragObject.value = { type: 'multi', start: { ...start }, members };
  },
  setSmartGuides(guides) { smartGuides.value = guides; },
  clearSmartGuides() { smartGuides.value = []; },
  setSelectedPlaces(set) { selectedPlaceIds.value = set; },
  startPlacesDrag(start, ids) { isDraggingPlaces.value = true; placesDragStart.value = { ...start }; if (ids.length > 1) store.beginMultiNodePositionCapture(ids); else store.beginNodePositionCapture(ids[0]); },
  setPlacesDragStart(p) { placesDragStart.value = { ...p }; },
  endPlacesDrag() { isDraggingPlaces.value = false; placesDragStart.value = null; if (selectedPlaceIds.value.size > 1) store.endMultiNodePositionCapture(); else selectedPlaceIds.value.forEach(id => store.endNodePositionCapture(id)); emit('dirty', true); },
  commitMove() {
    const obj = dragObject.value;
    if (!obj) return;
    if (obj.type === 'marker') store.updateMarker(props.planet.id, obj.id, { x: obj.marker.x, y: obj.marker.y }, obj.old);
    else if (obj.type === 'textLabel') store.updateTextLabel(props.planet.id, obj.id, { x: obj.label.x, y: obj.label.y }, obj.old);
    else if (obj.type === 'multi') {
      const entries = obj.members.filter(m => m.obj.x !== m.old.x || m.obj.y !== m.old.y).map(m => ({ kind: m.type, id: m.id, updates: { x: m.obj.x, y: m.obj.y }, old: { x: m.old.x, y: m.old.y } }));
      if (entries.length > 0) store.batchUpdateMapObjects(props.planet.id, entries);
    } else if (obj.type === 'region') store.updateRegion(props.planet.id, obj.id, { points: obj.region.points.map(p => ({ ...p })) }, { points: obj.old });
    dragObject.value = null; dragRegionAnchor.value = null; emit('dirty', true);
  },
  setTransformDrag(info) { batchSelection.transformDrag.value = info; },
  commitTransform() {
    const info = batchSelection.transformDrag.value; batchSelection.transformDrag.value = null;
    if (!info) return;
    const list = info.kind === 'marker' ? currentMapData.value?.markers : currentMapData.value?.textLabels;
    const target = list?.find(o => o.id === info.id);
    if (!target) return;
    const updates = {}; const newRotation = target.rotation || 0; const newScale = target.scale || 1;
    if (newRotation !== info.old.rotation) updates.rotation = newRotation;
    if (newScale !== info.old.scale) updates.scale = newScale;
    if (Object.keys(updates).length === 0) return;
    const oldSnapshot = { rotation: info.old.rotation, scale: info.old.scale };
    if (info.kind === 'marker') store.updateMarker(props.planet.id, info.id, updates, oldSnapshot);
    else store.updateTextLabel(props.planet.id, info.id, updates, oldSnapshot);
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
    vertexDragKind.value = null; vertexDragOld.value = null;
  },
  finishDraw() { finishDrawing(); },
  finishBrush() { brushDrawing.finishBrushStroke(selectedTerrain); },
  finishCluster(wx, wy) { clusterEditor.finishClusterBox(wx, wy); },
  setSplitPoint(p) { splitPoints.value = [p]; },
  doSplit(pA, pB) { provinceSplitMerge.performSplit(pA, pB, selectedProvince); },
  doMerge(idA, idB) { provinceSplitMerge.performMerge(idA, idB, selectedProvince); },
  setStatus(msg) { exportStatus.value = msg; },
  clusterClick(wx, wy) { clusterEditor.handleClusterCanvasClick(wx, wy); },
  routeClick(wx, wy) { handleRouteClick(wx, wy); },
  pointClick(wx, wy, mode) { handlePointClick(wx, wy, mode); },
  addTextLabel(label) { store.addTextLabel(props.planet.id, label); selectedTextLabel.value = label; emit('dirty', true); renderer.requestRender(); },
  addMarker(marker) { store.addMarker(props.planet.id, marker); selectedMarker.value = marker; emit('dirty', true); renderer.requestRender(); },
  emitSelectNode(node) { emit('select-node', node); },
  requestRender() { renderer.requestRender(); },
});

const renderer = useCanvasRenderer(canvas, {
  onRender,
  onHitTest: (wx, wy) => hitTestModule.hitTest(wx, wy),
  onPointerMove: (wx, wy) => { setStatusThrottled({ mouseWorld: { x: wx, y: wy }, zoom: renderer.viewTransform.scale * 100 }); },
  onHover: (hit, wx, wy) => {
    cursorCoord.value = { x: Math.round(wx), y: Math.round(wy), visible: true };
    setStatusThrottled({ selectionCount: selectedPlaceIds.value.size });
    hoveredNode.value = hit?.type === 'place' ? hit.node : null;
    const hoverMode = isSpacebarDown.value ? 'pan' : interactionMode.value;
    if (hoverMode === 'move') {
      const movable = hit && (hit.type === 'place' || hit.type === 'marker' || hit.type === 'textLabel' || hit.type === 'region');
      renderer.setCursorOverride(movable ? 'move' : null);
    } else { renderer.setCursorOverride(null); }
    if (editMode.value && (selectedProvince.value || selectedRegion.value || selectedRoute.value)) {
      const vHit = hitTestModule.hitTestVertex(wx, wy);
      hoveredVertex.value = vHit ? { vertexIndex: vHit.vertexIndex } : null;
    } else { hoveredVertex.value = null; }
  },
  onClick: (hit, wx, wy) => {
    if (referenceImage.refDragMode.value && referenceImage.referenceImage.value && !referenceImage.referenceImage.value.locked) return;
    if (referenceImage.calibrationMode.value && referenceImage.handleCalibrationClick(wx, wy)) return;
    interactions.handleCanvasClick(hit, wx, wy);
  },
  onDblClick: (hit, wx, wy) => {
    if (interactionMode.value === 'route') { finishRouteDraft(); return; }
    if ((interactionMode.value === 'draw' || interactionMode.value === 'region') && !drawMode.value && drawingPolygon.value) { finishPointDrawing(); return; }
    if (hit?.type === 'textLabel' && hit.label) { selectedTextLabel.value = hit.label; startInlineTextEdit(hit.label); return; }
    if (hit?.type === 'place' && hit.node) { store.selectArea(hit.node); }
  },
  onContextMenu: (wx, wy) => {
    if (interactionMode.value === 'route') { cancelRouteDraft(); return; }
    if ((interactionMode.value === 'draw' || interactionMode.value === 'region') && drawingPolygon.value) { drawingPolygon.value = null; renderer.requestRender(); return; }
    if (!editMode.value) return;
    const hit = hitTestModule.hitTest(wx, wy);
    const items = [];
    if (hit?.type === 'place') {
      const place = hit.node; const isDraft = !place.sourcePath;
      if (isDraft) {
        items.push({ key: 'ctx-place-create-note', label: '创建 Obsidian 笔记', icon: '📝', action: async () => {
          const result = await window.sitianAPI.createObsidianNote({ name: place.name, layer: place.layer, parentId: place.parentId, tags: place.tags || [], coordinate: place.coordinate, content: `# ${place.name}\n\n` });
          if (result?.success) { store.updateNode(place.id, { sourcePath: result.path }); emit('dirty', true); renderer.requestRender(); } else if (result?.error) { console.error('创建笔记失败:', result.error); }
        } });
        items.push({ separator: true });
      }
    }
    if (hit?.type === 'marker') {
      const m = hit.marker;
      items.push({ key: 'ctx-marker-edit', label: '编辑标记', icon: '✏️', action: () => { multiSel.value = []; setPrimarySelection('marker', m); } });
      items.push({ key: 'ctx-marker-copy', label: '复制标记', icon: '📋', action: () => { setClipboard('markers', [m], 'planet'); } });
      items.push({ key: 'ctx-marker-del', label: '删除标记', icon: '🗑', danger: true, action: () => { store.removeMarker(props.planet.id, m.id); if (selectedMarker.value?.id === m.id) selectedMarker.value = null; emit('dirty', true); renderer.requestRender(); } });
    } else if (hit?.type === 'textLabel') {
      const l = hit.label;
      items.push({ key: 'ctx-text-edit', label: '编辑文本', icon: '✏️', action: () => { multiSel.value = []; setPrimarySelection('textLabel', l); startInlineTextEdit(l); } });
      items.push({ key: 'ctx-text-copy', label: '复制文本', icon: '📋', action: () => { setClipboard('textLabels', [l], 'planet'); } });
      items.push({ key: 'ctx-text-del', label: '删除文本', icon: '🗑', danger: true, action: () => { store.removeTextLabel(props.planet.id, l.id); if (selectedTextLabel.value?.id === l.id) selectedTextLabel.value = null; emit('dirty', true); renderer.requestRender(); } });
    } else if (!hit) {
      const clip = getClipboard();
      if (clip && ['markers', 'textLabels', 'planetObjects'].includes(clip.kind)) { items.push({ key: 'ctx-paste', label: '粘贴', icon: '📋', action: () => pasteClipboard() }); }
    }
    if (!items.length) return;
    const vt = renderer.viewTransform; const cvs = canvas.value; if (!cvs) return;
    ctxMenu.open(items, { x: wx * vt.scale + vt.x + cvs.clientWidth / 2, y: wy * vt.scale + vt.y + cvs.clientHeight / 2 }, cvs.parentElement);
  },
  onDragStart: interactions.onDragStart,
  onDragMove: interactions.onDragMove,
  onDragEnd: interactions.onDragEnd,
  onWheel: (e, newScale) => { zoomOnWheel(newScale); },
  drawMode, currentPath, interactionMode, isSpacebarDown,
});

// ===== 其他 composables（需要 renderer）=====
const routeEditor = useRouteEditor({ store, props, emit, selectedRoute, renderer });
const referenceImage = useReferenceImage({ store, props, emit, renderer, currentMapData });
const clusterEditor = useClusterEditor({ store, props, emit, renderer, places, interactionMode });
const batchSelection = useBatchSelection({ store, props, emit, renderer, currentMapData, exportStatus });

// ===== 快照面板 composable =====
const snapshotPanel = useSnapshotPanel({ store, props, emit, renderer, currentMapData });

// ===== 面板管理 composable =====
const panelManager = usePanelManager({
  panelsStore, clusterEditor, objectPanelOpen,
  snapshotPanelOpen: snapshotPanel.snapshotPanelOpen,
  referenceImage, renderer,
});

// ===== 对象面板 composable =====
const objectPanel = useObjectPanel({
  store, props, emit, renderer, drawing, currentMapData,
  selectedProvince, selectedRegion, selectedMarker, selectedRoute, selectedTextLabel,
});

// ===== 批量排列 composable =====
const batchArrange = useBatchArrange({ store, props, emit, renderer, currentMapData, batchSelection });

// ===== 笔刷绘制 composable =====
const brushDrawing = useBrushDrawing({ store, props, emit, renderer });

// ===== 省份拆分合并 composable =====
const provinceSplitMerge = useProvinceSplitMerge({ store, props, emit, renderer, currentMapData, exportStatus });

// ===== 自动区域 composable =====
const autoRegionsMgr = useAutoRegions({ store, props, emit, renderer, currentMapData });

// ===== 缩放控件 composable =====
const zoomControls = useZoomControls({ renderer });

// ===== 标尺 composable =====
const ruler = useRuler({ renderer, canvas });

// ===== 内联编辑 composable =====
const inlineEditMgr = useInlineEdit({ store, props, emit, renderer, currentMapData, canvas });

// ===== 定位高亮 composable =====
const focusHighlight = useFocusHighlight({ renderer });

// ===== 全图导出 composable =====
const fullMapExport = useFullMapExport({
  store, props, emit, renderer, currentMapData, layers,
  drawing, referenceImage, places, provinceEditor, markerEditor, lodRef, ruler,
});

// ===== 解构 composables 到组件作用域 =====
const { zoomBy, applyZoom, onWheel: zoomOnWheel, onZoomSlider } = zoomControls;
const rulerVisible = ruler.rulerVisible;
const compassVisible = ruler.compassVisible;
const scaleBarVisible = ruler.scaleBarVisible;
const hTicks = ruler.hTicks;
const vTicks = ruler.vTicks;
const { inlineEdit, inlineEditInput, startInlineTextEdit, commitInlineEdit, cancelInlineEdit } = inlineEditMgr;
const focusHighlightNode = focusHighlight.focusHighlightNode;
const snapshotPanelOpen = snapshotPanel.snapshotPanelOpen;
const mapSnapshots = snapshotPanel.mapSnapshots;
const saveStatus = snapshotPanel.saveStatus;
const { takeSnapshot, restoreSnapshot, removeSnapshot } = snapshotPanel;
const autoRegions = autoRegionsMgr.autoRegions;
const fogMode = autoRegionsMgr.fogMode;
const placeRegionMap = autoRegionsMgr.placeRegionMap;
const { adoptAutoRegions, regenerateAutoRegions } = autoRegionsMgr;
const brushMode = brushDrawing.brushMode;
const brushSize = brushDrawing.brushSize;
const isBrushing = brushDrawing.isBrushing;
const brushLastPoint = brushDrawing.brushLastPoint;
const brushStrokePoints = brushDrawing.brushStrokePoints;
const splitSelectMode = provinceSplitMerge.splitSelectMode;
const splitPoints = provinceSplitMerge.splitPoints;
const mergeSelectMode = provinceSplitMerge.mergeSelectMode;
const mergeTargetId = provinceSplitMerge.mergeTargetId;
const { startSplitMode, startMergeMode } = provinceSplitMerge;
const arrangeDialogOpen = batchArrange.arrangeDialogOpen;
const arrangeMode = batchArrange.arrangeMode;
const arrangeCols = batchArrange.arrangeCols;
const arrangeSpacing = batchArrange.arrangeSpacing;
const reparentDialogOpen = batchArrange.reparentDialogOpen;
const reparentTargetId = batchArrange.reparentTargetId;
const reparentCandidates = batchArrange.reparentCandidates;
const { openArrangeDialog, confirmArrange, alignSelected, distributeSelected, openReparentDialog, confirmReparent, getSelectedPlaceItems } = batchArrange;
const { openPlanetPanel } = panelManager;
const { focusObject, renameObject, deleteObject } = objectPanel;
const { exportFullMapPNG } = fullMapExport;

// ===== 批量选择短名委托（tests、模板与 getState 使用的旧顶层名）=====
const multiSel = batchSelection.multiSel;
const smartGuides = batchSelection.smartGuides;
const smartGuidesEnabled = batchSelection.smartGuidesEnabled;
const batchApply = batchSelection.batchApply;
const alignMultiSel = batchSelection.alignMultiSel;
const distributeMultiSel = batchSelection.distributeMultiSel;
const batchPanelVisible = batchSelection.batchPanelVisible;
const multiSelObjs = batchSelection.multiSelObjs;
const multiMarkers = batchSelection.multiMarkers;
const multiLabels = batchSelection.multiLabels;
// 拆分/合并：包一层默认注入 selectedProvince（旧签名 performSplit(pA, pB) 的兼容形态）
const performSplit = (pA, pB) => provinceSplitMerge.performSplit(pA, pB, selectedProvince);
const performMerge = (idA, idB) => provinceSplitMerge.performMerge(idA, idB, selectedProvince);
const terrainTypes = provinceEditor.terrainTypes;

// ===== 键盘快捷键 composable =====
const keyboardShortcuts = useKeyboardShortcuts({
  store, props, emit, renderer,
  selectedProvince, selectedMarker, selectedTextLabel,
  exportStatus, splitSelectMode, mergeSelectMode, editMode,
  copySelection, pasteClipboard,
});

// ===== 网格吸附 =====
function snapPoint(p) { if (!gridSnapEnabled.value || keyboardShortcuts.isSnapCtrlHeld()) return p; const g = gridSize.value; return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g }; }

function closestPointOnSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1; const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { x: x1, y: y1 };
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq; t = Math.max(0, Math.min(1, t));
  return { x: x1 + t * dx, y: y1 + t * dy };
}

function snapToNearestEdge(p, threshold = 12) {
  if (!snapEnabled.value) return p;
  const terrain = currentMapData.value?.terrain || []; let best = null; let bestDist = threshold;
  for (const poly of terrain) { const pts = poly.points || []; if (pts.length < 2) continue; for (let i = 0; i < pts.length; i++) { const a = pts[i]; const b = pts[(i + 1) % pts.length]; const cp = closestPointOnSegment(p.x, p.y, a.x, a.y, b.x, b.y); const d = Math.hypot(cp.x - p.x, cp.y - p.y); if (d < bestDist) { bestDist = d; best = cp; } } }
  return best || p;
}

function snapDrawPoint(p) { const edge = snapToNearestEdge(p); if (edge !== p) { edgeSnapPreview.value = edge; return edge; } edgeSnapPreview.value = null; return snapPoint(p); }

// ===== 对称绘制 =====
function mirrorPoint(p) { if (!mirrorMode.value) return p; if (mirrorAxis.value === 'y') return { x: 2 * mirrorAxisOffset.value - p.x, y: p.y }; return { x: p.x, y: 2 * mirrorAxisOffset.value - p.y }; }
function getMirroredPath(points) { if (!mirrorMode.value || points.length < 2) return points; const mirrored = points.map(mirrorPoint).reverse(); return [...points, ...mirrored]; }

// ===== 切换交互模式 =====
watch(interactionMode, (mode) => { if (mode !== 'route') routeEditor.routeDraftPoints.value = []; });

function setInteractionMode(mode) {
  interactionMode.value = mode;
  setStatus({ toolLabel: mode === 'pan' ? '浏览' : mode === 'move' ? '移动' : '绘制' });
  brushMode.value = false; floodFillMode.value = false; isBrushing.value = false; brushLastPoint.value = null; brushStrokePoints.value = []; drawingPolygon.value = null; isDrawingActive.value = false; currentPath.value = [];
  clusterEditor.clusterSelectMode = false; clusterEditor.clusterBoxStart = null; clusterEditor.clusterBoxEnd = null;
  dragObject.value = null; dragRegionAnchor.value = null; edgeSnapPreview.value = null;
  splitSelectMode.value = false; splitPoints.value = []; mergeSelectMode.value = false; mergeTargetId.value = null;
  renderer.requestRender();
}

// ===== 同层级切换行星时清空状态 =====
watch(() => props.planet?.id, () => {
  selectedProvince.value = null; selectedRegion.value = null; selectedMarker.value = null; selectedRoute.value = null; selectedTextLabel.value = null;
  selectedPlaceIds.value = new Set(); multiSel.value = []; batchSelection.lastShiftToggle.value = null; batchSelection.transformDrag.value = null; smartGuides.value = [];
  inlineEdit.value = null; dragObject.value = null; dragRegionAnchor.value = null; vertexDragKind.value = null; vertexDragOld.value = null; hoveredNode.value = null; hoveredVertex.value = null;
  isDrawingActive.value = false; currentPath.value = []; drawingPolygon.value = null; routeEditor.routeDraftPoints.value = []; splitPoints.value = [];
  isBoxSelecting.value = false; boxSelectStart.value = null; boxSelectEnd.value = null;
  renderer?.requestRender();
});

// ===== 导航树地点拖放到画布 =====
function handleDragOver(e) { if (e.dataTransfer?.types?.includes('text/sitian-node-id')) e.dataTransfer.dropEffect = 'copy'; }

function handleDrop(e) {
  const nodeId = e.dataTransfer.getData('text/sitian-node-id');
  if (!nodeId) return;
  const node = store.nodes.find(n => n.id === nodeId);
  if (!node || !['location', 'city', 'town', 'village', 'facility'].includes(node.layer)) return;
  if (!canvas.value) return;
  const rect = canvas.value.getBoundingClientRect();
  const world = renderer.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  const sp = snapPoint({ x: world.x, y: world.y });
  store.updateNode(nodeId, { parentId: props.planet.id, coordinate: { x: Math.round(sp.x), y: Math.round(sp.y) }, userMoved: true });
  emit('dirty', true);
  const updated = store.nodes.find(n => n.id === nodeId);
  if (updated) emit('select-node', updated);
  renderer.requestRender();
  renderer.focusOn(sp.x, sp.y, Math.max(renderer.getViewTransform().scale, 1.2));
  highlightedPlaceId.value = nodeId;
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => { highlightedPlaceId.value = null; renderer.requestRender(); }, 2500);
  saveStatus.value = `✓ 已放置「${node.displayName || node.name}」，镜头已定位`;
  setTimeout(() => { saveStatus.value = ''; }, 2500);
}

// ===== 搜索/详情定位 =====
function onFocusNode(e) {
  const node = e.detail; if (!node) return;
  const place = places.value.find(p => p.id === node.id);
  if (place && place.coordinate?.x !== null && place.coordinate?.x !== undefined) {
    renderer.focusOn(place.coordinate.x, place.coordinate.y, Math.max(renderer.getViewTransform().scale, 1.2));
    renderer.requestRender(); focusHighlight.showFocusHighlight(place);
  }
}

function onHistoryJump() { renderer.requestRender(); }

// ===== 编辑面板拖拽 =====
function handlePanelHeaderDrag(e) {
  if (e.target.closest('button, input, select, textarea, a, label')) return;
  const header = e.target.closest('.province-editor .editor-header');
  if (!header) return;
  const panel = header.closest('.province-editor');
  if (!panel) return;
  e.preventDefault();
  const startX = e.clientX; const startY = e.clientY;
  const rect = panel.getBoundingClientRect();
  const containerRect = panel.parentElement?.getBoundingClientRect() || { left: 0, top: 0 };
  const origLeft = rect.left - containerRect.left; const origTop = rect.top - containerRect.top;
  panel.style.right = 'auto'; panel.style.left = origLeft + 'px'; panel.style.top = origTop + 'px';
  function onMove(ev) { panel.style.left = (origLeft + ev.clientX - startX) + 'px'; panel.style.top = (origTop + ev.clientY - startY) + 'px'; }
  function onUp() { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); }
  window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
}

// ===== 复制粘贴 =====
let pasteCount = 0;
const PASTE_OFFSET = 100;

function copySelection() {
  const places = Array.from(selectedPlaceIds.value).map(id => store.nodes.find(n => n.id === id)).filter(n => n && n.coordinate?.x != null);
  if (places.length) { setClipboard('places', places.map(n => ({ ...n })), 'planet'); pasteCount = 0; return; }
  if (multiSel.value.length >= 2 && multiSelObjs.value.length >= 2) {
    const items = multiSelObjs.value.map(({ type, obj }) => ({ type, data: JSON.parse(JSON.stringify(obj)) }));
    setClipboard('planetObjects', items, 'planet'); pasteCount = 0; exportStatus.value = `已复制 ${items.length} 个对象`; return;
  }
  if (selectedMarker.value) { setClipboard('markers', [selectedMarker.value], 'planet'); pasteCount = 0; }
  else if (selectedTextLabel.value) { setClipboard('textLabels', [selectedTextLabel.value], 'planet'); pasteCount = 0; }
}

function pasteClipboard() {
  const clip = getClipboard(); if (!clip) return;
  pasteCount += 1; const dx = PASTE_OFFSET * pasteCount; const dy = PASTE_OFFSET * pasteCount;
  if (clip.kind === 'places') { for (const item of clip.items) { const copy = cloneItem(item, dx, dy); copy.id = `${copy.id}_p`; copy.sourcePath = ''; copy.displayName = `${copy.displayName || copy.name} 副本`; store.addNode(copy); } emit('dirty', true); renderer.requestRender(); return; }
  if (clip.kind === 'planetObjects') {
    const planetId = props.planet?.id; if (!planetId) return;
    const newSel = [];
    for (const item of clip.items) {
      const copy = cloneItem(item.data, dx, dy);
      if (item.type === 'marker') { store.addMarker(planetId, copy); newSel.push({ type: 'marker', id: copy.id }); }
      else if (item.type === 'textLabel') { store.addTextLabel(planetId, copy); newSel.push({ type: 'textLabel', id: copy.id }); }
    }
    if (newSel.length) { selectedMarker.value = null; selectedTextLabel.value = null; multiSel.value = newSel; }
    exportStatus.value = `已粘贴 ${newSel.length} 个对象`; emit('dirty', true); renderer.requestRender(); return;
  }
  const planetId = props.planet?.id; if (!planetId) return;
  if (clip.kind === 'markers') { for (const item of clip.items) store.addMarker(planetId, cloneItem(item, dx, dy)); emit('dirty', true); renderer.requestRender(); }
  else if (clip.kind === 'textLabels') { for (const item of clip.items) store.addTextLabel(planetId, cloneItem(item, dx, dy)); emit('dirty', true); renderer.requestRender(); }
}

function duplicateSelection() { copySelection(); pasteClipboard(); }

// ===== 拆分时丢失的编辑模式与工具函数（2026-09-05 回填自 8c1962d）=====
function enterEditMode() {
  editMode.value = true;
  interactionMode.value = 'draw';
  drawMode.value = true;
  // 重置绘制子模式，避免上次退出残留导致自由绘制被拦截
  floodFillMode.value = false;
  brushDrawing.brushMode.value = false;
  brushDrawing.isBrushing.value = false;
  brushDrawing.brushLastPoint.value = null;
  brushDrawing.brushStrokePoints.value = [];
  drawingPolygon.value = null;
  isDrawingActive.value = false;
}

function exitEditMode() {
  editMode.value = false;
  isDrawingActive.value = false;
  currentPath.value = [];
  routeEditor.routeDraftPoints.value = [];
  selectedProvince.value = null;
  selectedRegion.value = null;
  selectedMarker.value = null;
  selectedRoute.value = null;
  selectedTextLabel.value = null;
  referenceImage.refDragMode.value = false;
  clusterEditor.clusterSelectMode = false;
  clusterEditor.clusterBoxStart = null;
  clusterEditor.clusterBoxEnd = null;
  brushDrawing.brushMode.value = false;
  brushDrawing.isBrushing.value = false;
  brushDrawing.brushLastPoint.value = null;
  brushDrawing.brushStrokePoints.value = [];
  isBoxSelecting.value = false;
  boxSelectStart.value = null;
  boxSelectEnd.value = null;
  selectedPlaceIds.value = new Set();
  isDraggingPlaces.value = false;
  placesDragStart.value = null;
  dragObject.value = null;
  dragRegionAnchor.value = null;
  drawingPolygon.value = null;
  provinceSplitMerge.splitSelectMode.value = false;
  provinceSplitMerge.splitPoints.value = [];
  provinceSplitMerge.mergeSelectMode.value = false;
  provinceSplitMerge.mergeTargetId.value = null;
  renderer.requestRender();
}

function undo() { store.undo(); }
function redo() { store.redo(); }

function deleteSelected() {
  // E7：批量删除 Shift 多选的标记/文本（逐个走 store，各生成一条 undo）
  if (multiSel.value.length > 0) {
    if (confirm(`确定删除选中的 ${multiSel.value.length} 个对象吗？`)) {
      multiSelObjs.value.forEach(({ type, id }) => {
        if (type === 'marker') store.removeMarker(props.planet.id, id);
        else store.removeTextLabel(props.planet.id, id);
      });
      multiSel.value = [];
      emit('dirty', true);
    }
    return;
  }
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
  renderer.requestRender();
}

function saveMap() {
  // 异步保存 + 横幅反馈，避免用户无反馈狂点
  saveStatus.value = '正在保存...';
  store.saveMapData(props.planet.id, currentMapData.value).then(result => {
    saveStatus.value = result?.success ? '✓ 保存成功' : '✗ 保存失败';
    snapshotPanel.clearSaveStatusTimer();
    snapshotPanel.saveStatusTimer.value = setTimeout(() => { saveStatus.value = ''; }, 3000);
  }).catch(() => {
    saveStatus.value = '✗ 保存失败';
    snapshotPanel.clearSaveStatusTimer();
    snapshotPanel.saveStatusTimer.value = setTimeout(() => { saveStatus.value = ''; }, 3000);
  });
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
    clusterEditor.activeClusterId.value = null;
    emit('dirty', true);
    renderer.requestRender();
  }
}

// ===== 路线草稿/描点绘制（2026-09-05 回填自 8c1962d，拆分时丢失）=====
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

function finishRouteDraft() {
  if (routeEditor.routeDraftPoints.value.length < 2) {
    routeEditor.routeDraftPoints.value = [];
    return;
  }
  
  const route = {
    id: `route_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    points: routeEditor.routeDraftPoints.value.map(p => ({ x: p.x, y: p.y, placeId: p.placeId || null })),
    dashed: routeEditor.routeDashed.value,
    color: routeEditor.routeColor.value,
    name: `路线 ${(currentMapData.value?.routes?.length || 0) + 1}`,
    label: '',
    description: '',
  };
  store.addRoute(props.planet.id, route);
  selectedRoute.value = route;
  routeEditor.routeDraftPoints.value = [];
  emit('dirty', true);
  renderer.requestRender();
}

function cancelRouteDraft() {
  if (routeEditor.routeDraftPoints.value.length > 0) {
    routeEditor.routeDraftPoints.value = [];
    renderer.requestRender();
    return true;
  }
  return false;
}

function handleRouteClick(wx, wy) {
  // 若命中已有路线端点，直接开始编辑该路线（选中）
  const hit = hitTestModule.hitTest(wx, wy);
  if (hit?.type === 'route' || hit?.type === 'route-endpoint') {
    selectedRoute.value = hit.route;
    routeEditor.routeDraftPoints.value = [];
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
  
  routeEditor.routeDraftPoints.value.push(target);
  renderer.requestRender();
}

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



// ===== 适配全部 / 适配选中 =====
function fitAllContent() { if (worldBounds.value) renderer.fitView(worldBounds.value); }
function fitSelection() {
  const items = getSelectedPlaceItems(selectedPlaceIds);
  if (!items.length) return;
  renderer.fitView({ minX: Math.min(...items.map(i => i.x)), minY: Math.min(...items.map(i => i.y)), maxX: Math.max(...items.map(i => i.x)), maxY: Math.max(...items.map(i => i.y)) });
}

function zoomFit() {
  if (worldBounds.value) {
    const s = renderer.fitView(worldBounds.value);
    zoomPercent.value = Math.round(s * 100);
  }
}

// ===== 地图数据加载 =====
watch(() => store.mapData[props.planet?.id], () => { renderer.requestRender(); }, { deep: true });

watch(() => props.planet?.id, async (id) => {
  if (!id) return;
  try {
    const data = await store.loadMapData(id);
    if (data) {
      renderer.requestRender();
      if (data.terrain?.length > 0) { const types = [...new Set(data.terrain.map(t => t.type))]; const ctx = renderer.getContext?.(); if (ctx) prewarmTextures(types, ctx); }
    }
  } catch (e) { console.error('加载地图数据失败:', e); }
}, { immediate: true });

// ===== 生命周期 =====
let highlightTimer = null;
onMounted(() => {
  renderer.initCanvas(); renderer.requestRender();
  requestAnimationFrame(() => requestAnimationFrame(() => { skeletonReady.value = true; }));
  showStatusBar('行星地图'); setStatus({ toolLabel: '浏览' });
  requestAnimationFrame(() => { autoRegionsMgr.generateAutoRegions(); renderer.requestRender(); });
  window.addEventListener('keydown', keyboardShortcuts.handleKeydown); window.addEventListener('keyup', keyboardShortcuts.handleKeyup);
  window.addEventListener('sitian:focus-node', onFocusNode); window.addEventListener('sitian:history-jump', onHistoryJump);
});

onUnmounted(() => {
  renderer.cleanupCanvas(); hideStatusBar();
  window.removeEventListener('keydown', keyboardShortcuts.handleKeydown); window.removeEventListener('keyup', keyboardShortcuts.handleKeyup);
  window.removeEventListener('sitian:focus-node', onFocusNode); window.removeEventListener('sitian:history-jump', onHistoryJump);
  if (highlightTimer) clearTimeout(highlightTimer);
  focusHighlight.clearFocusHighlightTimer();
});
</script>

<style scoped>
.planet-map-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--planet-bg);
}

.map-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 20px;
  background: var(--planet-header-bg);
  border-bottom: 1px solid var(--planet-header-border);
}

.header-left {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
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
  flex-shrink: 0;
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

/* U1 工具箱 dock：左侧竖排主工具，悬浮于画布；顶部选项栏仅显示上下文组 */
.tool-dock {
  position: absolute;
  left: 12px;
  top: 12px;
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 46px;
  max-height: calc(100% - 24px);
  padding: 7px 5px;
  background: var(--panel-glass);
  border: 1px solid var(--planet-header-border);
  border-radius: var(--radius-md);
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(10px);
  overflow-y: auto;
  scrollbar-width: none;
}
.tool-dock::-webkit-scrollbar { display: none; }
.tool-dock button {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
  color: var(--planet-text);
  transition: background 0.15s, border-color 0.15s;
}
.tool-dock button:hover { background: var(--planet-btn-hover); }
.tool-dock button.active {
  background: var(--planet-btn-active-bg);
  border-color: var(--planet-btn-active-border);
  color: white;
  animation: pulse-glow 2s ease-in-out infinite;
}
.tool-dock-sep {
  height: 1px;
  flex-shrink: 0;
  margin: 4px 3px;
  background: var(--planet-btn-border);
}
.tool-dock-flex { flex: 1; min-height: 6px; }
.tool-dock-exit { color: var(--planet-text-link, #4A90D9) !important; font-weight: bold; }

/* E9 内联文本编辑覆盖层：定位到文本世界坐标的屏幕投影点 */
.inline-text-edit {
  position: absolute;
  z-index: 45;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.inline-text-edit input {
  padding: 2px 6px;
  border: 2px solid #4AA3FF;
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.92);
  text-align: center;
  font-family: "Microsoft YaHei", sans-serif;
  outline: none;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.25);
}
.inline-text-hint {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.85);
  background: rgba(0, 0, 0, 0.55);
  padding: 2px 8px;
  border-radius: 8px;
  user-select: none;
  white-space: nowrap;
}

/* E7 批量属性编辑面板 */
.batch-editor .terrain-selector button {
  background: var(--planet-btn-hover);
  color: var(--planet-text);
}
.batch-editor .terrain-selector button.active {
  background: var(--planet-btn-active-bg);
  border-color: var(--planet-btn-active-border);
  color: white;
}
.batch-delete-btn {
  width: 100%;
  color: #FF6B6B;
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
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-xl);
  color: var(--text-primary);
  text-align: center;
  z-index: 15;
  box-shadow: var(--shadow-lg);
  max-width: 340px;
}
.empty-map-icon { font-size: 34px; line-height: 1; }
.empty-map-title { font-size: 15px; font-weight: 600; }
.empty-map-desc { font-size: 12px; color: var(--text-tertiary); }
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
  background: var(--planet-btn-hover);
  border-color: var(--planet-text-link, #4A90D9);
  color: var(--planet-text-link, #4A90D9);
}
.zoom-controls input[type="range"] {
  width: 110px;
  accent-color: var(--planet-text-link);
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
  background: var(--planet-btn-bg);
  border: 1px solid transparent;
  cursor: pointer;
}
.ref-item:hover {
  background: var(--planet-btn-hover);
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
  border-bottom: 1px solid var(--panel-border);
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
  color: var(--text-tertiary);
  line-height: 1;
  padding: 0 4px;
}
.close-btn:hover { color: var(--text-primary); }
.editor-field {
  padding: 10px 14px;
  border-bottom: 1px solid var(--panel-border);
}
.editor-field:last-child { border-bottom: none; }
.editor-field label {
  display: block;
  font-size: 11px;
  color: var(--text-tertiary);
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
  color: var(--text-tertiary);
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
  color: var(--text-primary);
  border: 1px solid var(--panel-border);
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
  background: var(--panel-bg);
  border-radius: 10px;
  border: 1px solid var(--panel-border);
  box-shadow: 0 16px 64px rgba(0,0,0,0.5);
  padding: 20px;
}
.modal-dialog h3 {
  margin: 0 0 8px 0;
  font-size: 16px;
  color: var(--text-primary);
}
.modal-desc {
  margin: 0 0 16px 0;
  font-size: 13px;
  color: var(--text-tertiary);
}
.form-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}
.form-row label {
  font-size: 12px;
  color: var(--text-tertiary);
  font-weight: 500;
}
.form-row select,
.form-row input {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--input-border);
  background: var(--input-bg);
  color: var(--text-primary);
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
