<template>
  <div class="scenario-map-container">
    <!-- 顶栏：工具 + 模式切换 -->
    <div class="scenario-toolbar">
      <!-- 第 1 行：**按任务分层的 4 个主工具** + 「更多」（P3）
           默认可见控件 = 6 个（返回 / 选择 / 自由绘制 / 变更归属 / 顶点编辑 / 更多），
           其余工具与开关全部收进「更多」—— 能力一个都不减，只是不再糊在一排里。 -->
      <div class="toolbar-row primary-row">
        <button @click="$emit('exit')" title="返回世界选择" class="back-btn">← 返回</button>
        <button
          :class="{ active: tool === 'select' }"
          @click="setTool('select')"
          title="选择 (V) — 拖动平移画布，点击选中省份"
        ><Icon name="hand" :size="15"/></button>
        <button
          :class="{ active: tool === 'draw' }"
          @click="setTool('draw')"
          title="自由绘制 (B，默认) — 按住沿轮廓拖一圈 = 建一个省；单击 = 描点；Shift = 不吸附骨架"
        ><Icon name="pencil" :size="15"/></button>
        <button
          :class="{ active: tool === 'provinceBrush' }"
          @click="setTool('provinceBrush')"
          title="变更归属 (Q) — 按住涂抹把格子划归所选省份（省界自动重算）"
        ><Icon name="brush" :size="15"/></button>
        <button
          :class="{ active: tool === 'vertex' }"
          @click="setTool('vertex')"
          title="顶点编辑 (G) — 拖拽顶点改形状；多环省份在右侧属性面板切换活动环"
        >⬡</button>
        <button
          class="more-toggle"
          :class="{ active: moreOpen, 'has-advanced': advancedToolActive }"
          @click="moreOpen = !moreOpen"
          title="更多 — 拆分 / 合并 / 点击填充 / 河流 / 地貌 / 地名 / 擦除 / 高度 / 群系 / 聚落 / 文化 / 宗教 / 标记 / 道路，以及吸附与底图"
        ><Icon name="chevron-down" :size="13"/> 更多</button>
        <span v-if="snapToGridEnabled && (tool === 'draw' || tool === 'vertex')" class="draw-hint">吸附：50px 网格（Shift 临时禁用）</span>
      </div>

      <!-- 第 2 行：省份 —— 几何只有一个来源（多边形）；网格只是涂抹时的中间层 -->
      <!-- 「变更归属」的省份选项：选到省份类工具（或自己打开「更多」）才出现 ——
           默认那 6 个可见控件里没有它（见 P3 / test_65）。 -->
      <div class="toolbar-row province-row" v-if="provinceRowVisible">
        <label class="row-label">省份：</label>
        <button
          :class="{ active: tool === 'provinceBrush' }"
          @click="setTool('provinceBrush')"
          title="省份笔刷 (Q) — 按住涂抹划归所选省份；省界由格归属自动重算（一次拖动 = 一条撤销）"
        ><Icon name="brush" :size="15"/></button>
        <button
          :class="{ active: tool === 'provinceLasso' }"
          @click="setTool('provinceLasso')"
          title="自由轮廓 (L) — 按住画一圈，圈内所有格整批划归（不用描点）"
        ><Icon name="pen-tool" :size="15"/></button>
        <button
          :class="{ active: tool === 'provinceFill' }"
          @click="setTool('provinceFill')"
          title="点击填充 (O) — 点一下把所在封闭区域整块划归；有面积闸门（超过全图 25% 直接拒绝，避免一下填满整块大陆/海洋）"
        ><Icon name="droplet" :size="15"/></button>
      <!-- Phase 3 省份网格：笔刷 / 自由轮廓 / 点击填充 设置 -->
      <div class="tool-group brush-settings" v-if="['provinceBrush','provinceLasso','provinceFill'].includes(tool)">
        <label>划归到：</label>
        <select v-model.number="provBrushTarget" class="brush-biome-select" title="要划归的目标省份">
          <option v-for="(p, i) in provinceTargets" :key="p.id" :value="i + 1">{{ p.name || ('省份 ' + (i + 1)) }}</option>
        </select>
        <template v-if="tool === 'provinceBrush'">
          <label class="check-label">
            工具
            <select v-model="provBrushTool" class="brush-biome-select" title="归属笔刷 / 抹除 / 平滑">
              <option v-for="t in provinceBrush.PROVINCE_TOOLS.filter(t => t.key !== 'lasso')" :key="t.key" :value="t.key">{{ t.label }}</option>
            </select>
          </label>
          <label class="check-label" title="笔刷半径（格）">
            半径
            <input type="range" v-model.number="provBrushRadius" min="1" max="20" step="1" class="brush-slider" />
            {{ provBrushRadius }} 格
          </label>
          <label class="check-label" title="笔刷强度">
            强度
            <input type="range" v-model.number="provBrushStrength" min="0.3" max="1" step="0.1" class="brush-slider" />
          </label>
        </template>
        <button @click="addGridProvince" title="新建一个「纯网格省份」（无轮廓，边界由格归属自动提取）"><Icon name="plus" :size="13"/> 新建省份</button>
        <button @click="clearGridOwnership" title="把所有格清成无主（省份定义保留）——演示「海陆来自导入、省份由司天切」"><Icon name="refresh-cw" :size="13"/> 清空归属</button>
        <!-- 🔴 不再有「网格视图」开关：画布永远画多边形（= 存下来/导出的那个几何）；
             网格只在涂抹进行中作为即时反馈叠一层，抬手即写回多边形 -->
        <span class="row-hint" :class="{ ready: provinceMeshOn }"
              title="省份几何只有多边形一个来源；网格是涂抹时的中间层，抬手时把结果写回多边形">
          网格{{ provinceMeshOn ? '已就绪' : '准备中…' }}
        </span>
        <label class="check-label" title="显示无主格（海域 / 未划归）">
          <input type="checkbox" v-model="provMeshNoStar" /> 无主格
        </label>
      </div>
      </div>

      <!-- 「更多」（默认收起）：高级工具 + 吸附开关 + 图层 + 底图 —— 原入口一个都不少 -->
      <div v-if="moreOpen" class="toolbar-more">
        <div class="toolbar-row">
          <label class="row-label">高级工具：</label>
          <div class="tool-group">
                            <button 
                :class="{ active: tool === 'split' }" 
                @click="setTool('split')"
                title="拆分省份 (X) — 点击两个点定义分割线"
              ><Icon name="scissors" :size="15"/></button>
                  <button 
                :class="{ active: tool === 'merge' }" 
                @click="setTool('merge')"
                title="合并省份 (M) — 依次点击两个省份"
              >⊕</button>
                  <button 
                :class="{ active: tool === 'erase' }" 
                @click="setTool('erase')"
                title="删除 (E) — 点击省份删除"
              ><Icon name="trash" :size="15"/></button>
                  <button 
                :class="{ active: tool === 'height' }" 
                @click="setTool('height')"
                title="高度笔刷 (H) — 左键抬高/右键降低地形"
              ><Icon name="trending-up" :size="15"/></button>
                  <button 
                :class="{ active: tool === 'biome' }" 
                @click="setTool('biome')"
                title="生物群系笔刷 (N) — 涂抹生物群系"
              ><Icon name="palette" :size="15"/></button>
                  <button 
                :class="{ active: tool === 'river' }" 
                @click="setTool('river')"
                title="河流编辑器 (W) — 手动绘制河流路径"
              ><Icon name="droplets" :size="15"/></button>
                  <button 
                :class="{ active: tool === 'river' }" 
                @click="generateAndShowRivers"
                title="自动生成河流 — 沿高度梯度从高地流向海洋"
              ><Icon name="waves" :size="15"/></button>
                  <button 
                :class="{ active: tool === 'relief' }" 
                @click="setTool('relief')"
                title="Relief 图标 (I) — 放置山脉/树木/沙漠等自然特征"
              ><Icon name="mountain" :size="15"/></button>
                  <select v-if="tool === 'relief'" v-model="selectedReliefIcon" class="brush-biome-select" title="Relief 图标">
                <option v-for="icon in RELIEF_ICONS" :key="icon.id" :value="icon.id">{{ icon.name }}</option>
              </select>
                  <button 
                :class="{ active: tool === 'paint' }" 
                @click="setTool('paint')"
                title="势力油漆桶 (P) — 点击省份指派势力"
              ><Icon name="palette" :size="15"/></button>
                  <button 
                :class="{ active: tool === 'culture' }" 
                @click="setTool('culture')"
                title="文化笔刷 (C) — 涂抹文化区域"
              ><Icon name="users" :size="15"/></button>
                  <button 
                :class="{ active: tool === 'religion' }" 
                @click="setTool('religion')"
                title="宗教笔刷 (R) — 涂抹宗教区域"
              ><Icon name="church" :size="15"/></button>
                  <button 
                :class="{ active: tool === 'burg' }" 
                @click="setTool('burg')"
                title="智能聚落 (U) — 点击放置，自动贴合地形"
              ><Icon name="home" :size="15"/></button>
                  <select v-if="tool === 'burg'" v-model="selectedBurgSize" class="brush-biome-select" title="聚落规模">
                <option v-for="size in BURG_SIZES" :key="size.id" :value="size.id">{{ size.name }}</option>
              </select>
                  <button 
                :class="{ active: tool === 'label' }" 
                @click="setTool('label')"
                title="历史地名 (T) — 点击放置文字标记"
              ><Icon name="tag" :size="15"/></button>
                  <select v-if="tool === 'label'" v-model="selectedLabelPreset" class="brush-biome-select" title="标签样式预设">
                <option v-for="preset in LABEL_PRESETS" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
              </select>
                  <button 
                :class="{ active: tool === 'marker' }" 
                @click="setTool('marker')"
                title="标记 (K) — 点击放置标记"
              ><Icon name="map-pin" :size="15"/></button>
                  <select v-if="tool === 'marker'" v-model="selectedMarkerType" class="brush-biome-select" title="标记类型">
                <option v-for="type in MARKER_TYPES" :key="type.id" :value="type.id">{{ type.name }}</option>
              </select>
                  <button 
                :class="{ active: tool === 'road' }" 
                @click="setTool('road')"
                title="道路 (J) — 两点连线，自动生成沿等高线路径"
              ><Icon name="git-branch" :size="15"/></button>
                  <select v-if="tool === 'road'" v-model="selectedRoadStyle" class="brush-biome-select" title="道路样式">
                <option v-for="style in ROAD_STYLES" :key="style.id" :value="style.id">{{ style.name }}</option>
              </select>
                  <button 
                :class="{ active: tool === 'derive' }" 
                @click="deriveLayers"
                title="重算派生图层 — 基于高度重算温度/降水/生物群系"
              ><Icon name="refresh-cw" :size="15"/></button>
          </div>
        </div>
      <!-- 第 3 行：地形/群系等笔刷设置 + 底图与视图操作 -->
      <div class="toolbar-row">
      <!-- 笔刷设置 -->
      <div class="tool-group brush-settings" v-if="['height','biome','culture','religion'].includes(tool)">
        <label>笔刷：</label>
        <label class="check-label" title="笔刷半径（滚轮调节）">
          半径
          <input type="range" v-model.number="brushRadius" min="20" max="300" step="10" class="brush-slider" />
          {{ brushRadius }}
        </label>
        <label class="check-label" v-if="tool === 'height'" title="笔刷强度（Shift+滚轮调节）">
          强度
          <input type="range" v-model.number="brushStrength" min="0.5" max="10" step="0.5" class="brush-slider" />
          {{ brushStrength }}
        </label>
        <label class="check-label" v-if="tool === 'biome'">
          群系
          <select v-model="brushBiome" class="brush-biome-select">
            <option v-for="(color, key) in BIOME_COLORS" :key="key" :value="key">{{ key }}</option>
          </select>
        </label>
        <label class="check-label" v-if="tool === 'culture'">
          文化
          <select v-model="brushCulture" class="brush-biome-select">
            <option v-for="c in availableCultures" :key="c.id" :value="String(c.id)">{{ c.name }}</option>
          </select>
        </label>
        <label class="check-label" v-if="tool === 'religion'">
          宗教
          <select v-model="brushReligion" class="brush-biome-select">
            <option v-for="r in availableReligions" :key="r.id" :value="String(r.id)">{{ r.name }}</option>
          </select>
        </label>
      </div>
      <!-- 底图选择器（P1 切换底图） -->
      <div class="tool-group">
        <label>底图：</label>
        <select v-model="baseMapKey" @change="onBaseMapChange" class="basemap-select" :title="`当前底图: ${baseMapKey}`">
          <option v-for="bm in availableBaseMaps" :key="bm.id" :value="bm.id">
            {{ bm.name }} ({{ bm.count }}省)
          </option>
        </select>
        <button @click="triggerMapImport" title="导入新底图"><Icon name="plus" :size="15"/></button>
        <!-- A1（2026-09-24）：底图的高度图此前**只有 .map 导入**一条来源 —— 新建的底图里
             高度/群系/文化/宗教笔刷与一键派生全都「点了没反应」（没有网格 → 直接 return）。
             这个按钮补上「从零开始画」，同时它也是「剧情上已毁灭、不打算再建行星的星球」
             唯一可走的路径：**不绑定行星，底图自己持有一份高度图**。 -->
        <button
          v-if="baseMapCanCreateHeightmap"
          data-testid="basemap-create-heightmap"
          title="为这张底图创建高度图网格（创建后即可用高度 / 群系 / 文化 / 宗教笔刷与一键派生）"
          @click="createBaseMapHeightmap"
        ><Icon name="layers" :size="15"/></button>
      </div>

      <!-- 地形来源（M1c，2026-09-25）—— 底图的地形有两种来源，取舍完全不同，必须显式选：
             冻结导入 = 复制一份独立副本 → 历史存档剧本（行星后来怎么改都不影响它）
             跟随行星 = 共用同一份数据   → 当代地图（两边互相影响）
           真相在 store（planetId 字段 / 底图自持的 heightmap），这里只管展示与触发。 -->
      <div v-if="baseMapKey" class="tool-group" data-testid="basemap-terrain-source">
        <label>地形：</label>
        <span
          data-testid="basemap-terrain-mode"
          :title="terrainModeTitle"
          :style="{ fontSize: '11px', padding: '1px 6px', border: '1px solid currentColor', borderRadius: '3px', opacity: 0.85, whiteSpace: 'nowrap' }"
        >{{ terrainModeLabel }}</span>
        <select
          v-model="pickPlanetId"
          class="basemap-select"
          :disabled="terrainInfo.mode === 'following'"
          title="选择地形来源行星"
        >
          <option value="">选行星…</option>
          <option v-for="p in availablePlanets" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
        <button
          data-testid="basemap-freeze-import"
          :disabled="!pickPlanetId || terrainInfo.mode === 'following'"
          title="把该行星当前的地形**复制一份**到这张底图（副本独立：之后行星怎么改都不影响它，它也改不到行星）—— 适合历史存档剧本"
          @click="freezeTerrainFromPlanet"
        >冻结导入</button>
        <button
          data-testid="basemap-bind-planet"
          :disabled="!pickPlanetId || terrainInfo.mode === 'following'"
          title="让这张底图**跟随**该行星的地形（共用同一份：在剧本里涂山会改到行星，反之亦然）—— 适合与行星同步构建的当代地图。历史存档请改用「冻结导入」"
          @click="bindTerrainToPlanet"
        >跟随</button>
        <button
          v-if="terrainInfo.mode === 'following'"
          data-testid="basemap-unbind"
          title="解除跟随（行星那份不受影响；本底图回到「没有地形」，可再用「冻结导入」拿一份副本）"
          @click="unbindTerrainFromPlanet"
        >解绑</button>
      </div>

      <div class="tool-group">
        <button @click="fitToView" title="适应画布 (F)">⊞</button>
        <button @click="exportPNG" title="导出 PNG 图片"><Icon name="export" :size="15"/></button>
        <button @click="manualSave" title="保存到磁盘" :class="{ 'saving': store.saveStatus.value === 'saving' }">
          <Icon v-if="store.saveStatus.value === 'saving'" name="loader" :size="15"/>
          <Icon v-else-if="store.saveStatus.value === 'saved'" name="check-circle" :size="15"/>
          <Icon v-else name="save" :size="15"/>
        </button>
      </div>
      <div class="tool-group">
        <label>模式：</label>
        <select v-model="viewMode" @change="onModeChange">
          <option value="base">底图编辑</option>
          <option value="scenario">剧本模式</option>
        </select>
      </div>
      <div class="tool-group">
        <label>吸附：</label>
        <label class="check-label" title="绘制/顶点编辑时对齐到 50px 网格（按住 Shift 临时禁用）">
          <input type="checkbox" v-model="snapToGridEnabled" /> 网格吸附
        </label>
        <label class="check-label" title="绘制时顶点吸附到已有省份边界（按住 Shift 临时禁用）">
          <input type="checkbox" v-model="snapToEdgeEnabled" /> 海岸线吸附
        </label>
      </div>
      </div>

      <!-- 第 4 行：图层显示 / 底图图层 / 着色 -->
      <div class="toolbar-row">
      <div class="tool-group">
        <label>图层：</label>
        <label class="check-label"><input type="checkbox" v-model="showBiomes" /> 生物群系</label>
        <label class="check-label"><input type="checkbox" v-model="showBorders" /> 边界</label>
        <label class="check-label"><input type="checkbox" v-model="showBurgs" /> 城镇</label>
        <label class="check-label"><input type="checkbox" v-model="showLabels" /> 标签</label>
        <label class="check-label" title="EU4 式分级标注：放大看省名，缩小看势力名（可简称）"><input type="checkbox" v-model="showPolityLabels" data-testid="toggle-polity-labels" /> 势力名</label>
        <button @click="showLayerPanel = !showLayerPanel" title="图层锁定设置" :class="{ active: showLayerPanel }"><Icon name="lock" :size="13"/></button>
      </div>
      <div class="tool-group">
        <label>底图图层：</label>
        <select v-model="rasterLayer" title="网格数据图层（一次只渲染一层，避免叠加失真）">
          <option value="none">无</option>
          <option value="landsea">陆海底色</option>
          <option value="height">地形高度</option>
          <option value="temp">温度</option>
          <option value="prec">降水</option>
        </select>
        <label class="check-label"><input type="checkbox" v-model="showRivers" /> 河流</label>
        <label class="check-label"><input type="checkbox" v-model="showRoutes" /> 道路</label>
      </div>
      <div class="tool-group">
        <label>着色：</label>
        <select v-model="colorMode">
          <option value="default">默认</option>
          <option value="culture">文化</option>
          <option value="religion">宗教</option>
        </select>
      </div>
      </div>

      <!-- 第 5 行：剧本与导入导出 -->
      <div class="toolbar-row">
      <div class="tool-group">
        <button @click="showScenarioManager = true" title="剧本管理"><Icon name="file-text" :size="15"/></button>
        <button @click="showLineagePanel = true" title="势力谱系管理（人工纠正继承关系 / 易主年份）" data-testid="open-lineage"><Icon name="git-branch" :size="15"/></button>
        <button @click="showHistoryPanel = !showHistoryPanel" title="撤销历史" :class="{ active: showHistoryPanel }"><Icon name="history" :size="15"/></button>
      </div>
      <div class="tool-group" title="导出">
        <button @click="exportScenarioPNG()" title="导出当前剧本/年份为 PNG" data-testid="export-png"><Icon name="image" :size="15"/></button>
        <button @click="exportScenarioSVG()" title="导出当前剧本/年份为 SVG 矢量图（可进 Illustrator/Inkscape 继续加工）" data-testid="export-svg"><Icon name="layers" :size="15"/></button>
        <button @click="exportScenariosJson({ scope: 'current' })" title="导出当前底图的剧本数据（scenarios.json）" data-testid="export-json"><Icon name="export" :size="15"/></button>
        <button @click="importScenariosJson('merge')" title="导入剧本数据（合并：同 key 覆盖）" data-testid="import-json-merge"><Icon name="download" :size="15"/></button>
        <button @click="importScenariosJson('replace')" title="导入剧本数据（替换：清空现有剧本后再导入）" data-testid="import-json-replace"><Icon name="refresh" :size="15"/></button>
      </div>
      </div>
      </div>   <!-- /.toolbar-more -->
    </div>

    <!-- 剧本时间轴（按年比例轴 + EU4 斜线占领；旧按钮式时间轴条已被取代） -->
    <scenario-timeline
      v-if="timeline.years.length"
      :timeline="timeline"
      v-model:year="tlYear"
      v-model:era="tlEra"
      v-model:axis-mode="tlAxisMode"
      v-model:diff-mode="tlDiffMode"
      v-model:playing="tlPlaying"
      @select-scenario="onTimelineSelectScenario"
      @open-lineage="showLineagePanel = true"
    />

    <!-- 势力色板（剧本模式） -->
    <div v-if="viewMode === 'scenario' && selectedScenario" class="polity-palette">
      <span class="palette-title">势力：</span>
      <div 
        v-for="polity in selectedScenario.polities" 
        :key="polity.id"
        class="polity-swatch"
        :class="{ active: selectedPolity?.id === polity.id }"
        :style="{ background: polity.color }"
        @click="selectPolity(polity)"
        :title="polity.name"
      >
        {{ polity.name?.charAt(0) || '?' }}
        <span class="polity-name">{{ polity.name }}</span>
      </div>
      <div 
        class="polity-swatch clear"
        :class="{ active: !selectedPolity }"
        @click="selectPolity(null)"
        title="清除归属"
      ><Icon name="x" :size="14"/></div>
      <!-- A8：选中势力后可改「显示名称 / 简称」—— .map 带来的是 FMG 国名，用户要换成自己世界的叫法。
           简称只在缩小档使用（放大档与中档都用全名），留空即回落全名。 -->
      <div v-if="selectedPolity" class="polity-editor" data-testid="polity-editor">
        <label>名称
          <input :value="selectedPolity.name || ''" @change="onPolityNameChange"
                 :disabled="store.isReadOnly" data-testid="polity-name-input" />
        </label>
        <label>简称
          <input :value="selectedPolity.abbr || ''" @change="onPolityAbbrChange"
                 placeholder="留空用全名" :disabled="store.isReadOnly" data-testid="polity-abbr-input" />
        </label>
        <span class="polity-editor-hint" title="地图标注随缩放自动改档（放大省名 / 中档势力名 / 缩小简称）">
          标注档位：{{ { province: '省名', polity: '势力名', abbr: '简称' }[polityLabelTierNow] }}
        </span>
      </div>
    </div>

    <!-- 画布 -->
    <div class="scenario-canvas-wrap" ref="canvasWrap">
      <canvas ref="canvas"></canvas>
      <!-- 没有可用底图：说清现状 + 差异 + 去处（不是「点了没反应」）
           P-0 实测：只读态（未打开项目）时底图导入被写闸门拒绝 → 底图永远进不来，
           此时画布是空的，用户必须知道原因是「没开项目」而不是「程序卡住了」。 -->
      <div v-if="!baseMap" class="scenario-empty-hint" data-testid="scenario-empty-hint">
        <template v-if="store.isReadOnly">
          <p class="eh-title">只读：没有可用底图</p>
          <p class="eh-line">
            当前未打开项目，剧本与底图不会载入，也不会保存。
            先到工具栏「项目」面板新建或打开一个项目，再回到这里绘制。
          </p>
        </template>
        <template v-else>
          <p class="eh-title">这个项目里还没有底图</p>
          <p class="eh-line">用上方「+」导入 Azgaar .map 底图，或直接选一个绘制/笔刷工具开始画（会自动新建一张空底图）。</p>
        </template>
      </div>
    </div>

    <!-- 状态栏 -->
    <div class="scenario-status-bar">
      <span>{{ statusText }}</span>
      <!-- 渲染护栏：连续异常暂停渲染后必须可见 + 可恢复 -->
      <span v-if="renderPaused" class="render-guard" data-testid="render-guard">
        <Icon name="alert-triangle" :size="13"/> 渲染已暂停：{{ renderError }}
        <button class="rg-btn" @click="resumeRender">继续渲染</button>
      </span>
      <span>缩放: {{ (cameraScale * 100).toFixed(0) }}%</span>
      <!-- A8：点开省份详情才给势力**全名**（地图上缩小时只画简称，全名到这里查） -->
      <span v-if="selectedProvince" class="selected-province">已选：{{ selectedProvince.name }}（{{ selectedProvince.biome || '未分类' }}）<template v-if="selectedProvincePolity"> · 势力：<b class="polity-fullname" :style="{ color: selectedProvincePolity.color || undefined }" data-testid="province-polity-name">{{ selectedProvincePolity.name }}</b><template v-if="selectedProvincePolity.abbr">（简称 {{ selectedProvincePolity.abbr }}）</template></template></span>
      <span v-if="drawPoints.length > 0" class="draw-hint">绘制中: {{ drawPoints.length }} 个点 (双击完成, Esc 取消)</span>
      <span v-if="splitStep > 0" class="draw-hint">拆分: 点击第 {{ splitStep + 1 }} 个点</span>
      <span v-if="mergeStep > 0" class="draw-hint">合并: 点击第 {{ mergeStep + 1 }} 个省份</span>
      <span v-if="vertexEditMode" class="draw-hint">顶点编辑：拖拽顶点 | 点击边插入 | 右键顶点删除</span>
      <span v-if="snapToGridEnabled && (tool === 'draw' || tool === 'vertex')" class="draw-hint">吸附：50px 网格（Shift 临时禁用）</span>
      <span v-if="snapFeedback" class="snap-feedback" :class="{ edge: snapFeedback === '吸附到边界' }">{{ snapFeedback }}</span>
      <span v-if="tool === 'vertex' && activeVertexIdx >= 0" class="draw-hint">切线手柄：拖拽圆点调曲率（Alt 临时直线）</span>
      <span v-if="provinceHint" class="draw-hint">{{ provinceHint }}</span>
      <span v-if="tool === 'provinceBrush' || tool === 'provinceLasso'" class="draw-hint">
        {{ tool === 'provinceBrush' ? '省份笔刷：按住涂抹 → 整笔划归所选省份（省界自动重算）' : '自由轮廓：按住画一圈 → 圈内整批划归' }}
      </span>
      <span v-if="baseMap?.source?.warnings?.length" class="layer-warn" :title="baseMap.source.warnings.join('\n')">
        <Icon name="alert-triangle" :size="13"/> {{ baseMap.source.warnings.length }} 条图层提示
      </span>
      <span v-if="selectedBurg" class="selected-burg">城镇：{{ selectedBurg.name }}（人口 {{ formatPopulation(selectedBurg.population) }}）</span>
      <span v-if="viewMode === 'scenario' && selectedScenario">剧本：{{ selectedScenario.name }}</span>
      <span v-if="timeline.years.length" class="tl-status" data-testid="tl-status">
        年份 <b>{{ Math.round(tlYear) }}</b>
        <template v-if="tlEra > 0"> · 本剧本 <b>{{ tlSettled.settled }}</b>/{{ tlSettled.total }} 省已易主</template>
        <template v-if="tlAxisMode === 'year' && tlInGap"> · <span class="tl-warn">空位（沿用 {{ timeline.scenarios[tlEra].name }}）</span></template>
      </span>
      <span v-if="exportStatus" class="export-msg" data-testid="export-msg"><Icon name="info" :size="13"/> {{ exportStatus }}</span>
      <span v-if="selectedPolity" class="selected-polity">已选势力：<span class="polity-dot" :style="{ background: selectedPolity.color }"></span>{{ selectedPolity.name }}</span>
      <span class="save-status" :class="store.saveStatus.value">
        <template v-if="store.saveStatus.value === 'saving'"><Icon name="loader" :size="13"/> 保存中...</template>
        <template v-else-if="store.saveStatus.value === 'saved'"><Icon name="check-circle" :size="13"/> 已保存</template>
        <template v-else-if="store.saveStatus.value === 'error'"><Icon name="x-circle" :size="13"/> 保存失败</template>
        <template v-else><Icon name="save" :size="13"/> 自动保存</template>
      </span>
    </div>

    <!-- 省份右键菜单 -->
    <div v-if="contextMenu.show" class="context-menu" :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }">
      <div class="ctx-item" @click="ctxRenameProvince"><Icon name="pencil" :size="13"/> 重命名</div>
      <div class="ctx-item" @click="ctxChangeBiome"><Icon name="palette" :size="13"/> 更改生物群系</div>
      <div class="ctx-item" @click="ctxDuplicateProvince">⧉ 复制省份</div>
      <div class="ctx-item danger" @click="ctxDeleteProvince"><Icon name="trash" :size="13"/> 删除</div>
      <div class="ctx-divider"></div>
      <div class="ctx-item disabled" v-if="selectedProvince">
        {{ selectedProvince.name }} · {{ selectedProvince.biome || '未分类' }}
      </div>
    </div>

    <!-- 省份属性面板 -->
    <div v-if="selectedProvince && showProps" class="province-props">
      <div class="props-header">
        <input ref="provNameInput" v-model="selectedProvince.name" @input="onProvinceNameChange" class="props-name" />
        <button @click="showProps = false" class="props-close"><Icon name="x" :size="13"/></button>
      </div>
      <div class="props-row">
        <label>生物群系：</label>
        <select v-model="selectedProvince.biome" @change="onProvinceBiomeChange">
          <option value="">未分类</option>
          <option value="ocean">海洋</option>
          <option value="hot_desert">热沙漠</option>
          <option value="cold_desert">冷沙漠</option>
          <option value="savanna">热带草原</option>
          <option value="grassland">草原</option>
          <option value="tropical_seasonal">热带季雨林</option>
          <option value="temperate_deciduous">温带落叶林</option>
          <option value="tropical_rainforest">热带雨林</option>
          <option value="temperate_rainforest">温带雨林</option>
          <option value="taiga">针叶林</option>
          <option value="tundra">冻原</option>
          <option value="glacier">冰川</option>
          <option value="wetland">湿地</option>
        </select>
      </div>
      <div class="props-row">
        <label>文化：</label>
        <input v-model="selectedProvince.culture" @input="onProvinceCultureChange" placeholder="文化名称" />
      </div>
      <div class="props-row">
        <label>海岸：</label>
        <input type="checkbox" v-model="selectedProvince.coast" @change="onProvinceCoastChange" />
      </div>
      <div class="props-row">
        <label>类型：</label>
        <select v-model="selectedProvince.kind" @change="onProvinceKindChange"
                title="海域省份用海色渲染；陆地/海域是省份级属性（岛与飞地另见「环」）">
          <option value="land">陆地</option>
          <option value="sea">海域</option>
        </select>
      </div>
      <!-- 多环实体：飞地 / 洞都是独立的环。顶点编辑作用于**活动环**，这里切换 -->
      <div class="props-row" v-if="provinceRings(selectedProvince).length > 1">
        <label>编辑环：</label>
        <select v-model.number="activeRingIdx">
          <option v-for="(r, i) in provinceRings(selectedProvince)" :key="i" :value="i">
            {{ i === 0 ? '主环' : ('环 ' + (i + 1)) }}{{ r.fromGrid ? '（网格派生）' : '' }}
          </option>
        </select>
      </div>
      <div class="props-stats">
        环数: {{ provinceRings(selectedProvince).length }} ·
        顶点数: {{ currentRingVertexCount }}（活动环）
      </div>
    </div>

    <!-- 剧本管理对话框 -->
    <div v-if="showScenarioManager" class="modal-overlay" @click.self="showScenarioManager = false">
      <div class="modal-dialog scenario-manager">
        <h3>剧本管理</h3>
        <div class="scenario-list">
          <div v-for="s in sortedScenarios" :key="s.id" class="scenario-item">
            <span class="item-era">{{ s.era?.roman || '·' }}</span>
            <span class="item-name">{{ s.name }}</span>
            <span class="item-years">{{ s.era?.startYear || '?' }} – {{ s.era?.endYear || '?' }}</span>
            <button class="item-delete" @click="deleteScenario(s)" title="删除"><Icon name="trash" :size="15"/></button>
          </div>
        </div>
        <div class="new-scenario-form">
          <h4>新建剧本</h4>
          <div class="form-row">
            <label>名称：</label>
            <input v-model="newScenario.name" placeholder="如：第一时代·黑暗时代" />
          </div>
          <div class="form-row">
            <label>罗马数字：</label>
            <input v-model="newScenario.roman" placeholder="如：Ⅰ" class="short-input" />
          </div>
          <div class="form-row">
            <label>时代标签：</label>
            <input v-model="newScenario.label" placeholder="如：黑暗时代" />
          </div>
          <div class="form-row">
            <label>起始年：</label>
            <input v-model="newScenario.startYear" placeholder="如：乐园星历2006" />
          </div>
          <div class="form-row">
            <label>结束年：</label>
            <input v-model="newScenario.endYear" placeholder="如：乐园星历2008" />
          </div>
          <div class="form-row">
            <label>描述：</label>
            <textarea v-model="newScenario.description" placeholder="可选说明" rows="2"></textarea>
          </div>
          <div class="form-row checkbox">
            <label>继承上一时代：</label>
            <input type="checkbox" v-model="newScenario.inherit" />
          </div>
          <div class="form-actions">
            <button @click="createNewScenario" :disabled="!newScenario.name">创建</button>
            <button @click="showScenarioManager = false">关闭</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 图层锁定面板 -->
    <div v-if="showLayerPanel" class="layer-lock-panel">
      <div class="layer-lock-header">
        <span>图层锁定</span>
        <button @click="showLayerPanel = false" class="layer-lock-close"><Icon name="x" :size="13"/></button>
      </div>
      <div class="layer-lock-list">
        <div v-for="(layer, id) in scenarioLayers" :key="id" class="layer-lock-row">
          <span class="layer-lock-label">{{ layer.label }}</span>
          <button
            class="layer-lock-btn"
            :class="{ locked: layer.locked }"
            :title="layer.locked ? '解锁图层' : '锁定图层（不可编辑）'"
            @click="toggleLayerLock(id)"
          >
            <Icon :name="layer.locked ? 'lock' : 'unlock'" :size="13"/>
          </button>
        </div>
      </div>
    </div>

    <!-- 撤销历史面板 -->
    <HistoryPanel v-if="showHistoryPanel" :open="showHistoryPanel" @close="showHistoryPanel = false" />

    <!-- P2 势力谱系管理面板 -->
    <scenario-lineage-panel
      :open="showLineagePanel"
      :timeline="timeline"
      :current-era="tlEra"
      :year="tlYear"
      :province-names="provinceNameMap"
      @close="showLineagePanel = false"
      @set-polity-lineage="onSetPolityLineage"
      @set-change-year="onSetChangeYear"
    />

    <!-- 聚落编辑器面板 -->
    <div v-if="burgEditorOpen && editingBurg" class="burg-editor-panel">
      <div class="burg-editor-header">
        <span>聚落编辑</span>
        <button @click="closeBurgEditor" class="burg-editor-close"><Icon name="x" :size="13"/></button>
      </div>
      <div class="burg-editor-body">
        <div class="burg-editor-row">
          <label>名称：</label>
          <input v-model="editingBurg.name" placeholder="聚落名称" />
        </div>
        <div class="burg-editor-row">
          <label>规模：</label>
          <select v-model="editingBurg.size">
            <option v-for="size in BURG_SIZES" :key="size.id" :value="size.id">{{ size.name }}</option>
          </select>
        </div>
        <div class="burg-editor-row">
          <label>人口：</label>
          <input v-model.number="editingBurg.population" type="number" min="0" />
        </div>
        <div class="burg-editor-row">
          <label>文化：</label>
          <input v-model="editingBurg.culture" placeholder="文化归属" />
        </div>
        <div class="burg-editor-row checkbox-row">
          <label>首都：</label>
          <input type="checkbox" v-model="editingBurg.capital" :true-value="1" :false-value="0" />
        </div>
        <div class="burg-editor-actions">
          <button @click="saveBurgEditor" class="burg-save-btn">保存</button>
          <button @click="closeBurgEditor">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import Icon from './Icon.vue';
import { ref, onMounted, onUnmounted, watch, computed, toRaw, nextTick } from 'vue';
import { useGeodataStore } from '../store/geodata';
import { useLayersStore } from '../store/layers';
import { parseMapFile, buildScenariosJson } from '../utils/azgaar-parser';
import { generateRoadPath } from '../utils/placement';
import { drawIconOrEmoji } from '../utils/canvasIcon';
import { buildHeightmapRaster } from '../utils/heightmapRaster';   // M2/A2：与 PlanetMap 共用同一套栅格配色
import HistoryPanel from './HistoryPanel.vue';
import ScenarioTimeline from './ScenarioTimeline.vue';
import ScenarioLineagePanel from './ScenarioLineagePanel.vue';
import {
  buildTimeline, currentOwnerRef, isStriped, polityColor,
  settledCount, eraIndexOfYear, findGap,
} from '../utils/scenarioTimeline';
import { useScenarioExport } from '../composables/useScenarioExport';
import { useProvinceBrush } from '../composables/useProvinceBrush';
import { simplifyClosedTrace } from '../utils/regionTrace';
// A8（2026-09-26）：历史剧本「势力标注」—— 分级判定 / 领土聚合 / 标签文本全是纯函数，
// 放在 utils 里以便 Node 侧直接测（渲染里只剩「取数据 + 调 drawStyledLabel」）。
import {
  polityLabelTier, aggregateTerritories, ringAreaCentroid, labelTextFor, labelFitsOnScreen,
  POLITY_LABEL_STYLE, PROVINCE_LABEL_STYLE, LABEL_MIN_AREA_PX,
} from '../utils/polityLabels';
import { drawStyledLabel } from '../utils/labelStyles';
// P0 第二块：省份几何的**唯一表示**（多环实体）与其配套纯函数 —— 渲染/命中/分割/合并/骨架吸附
// 全部走这一层，画布里不再自己实现多边形算法（旧实现里那份凸包合并就是「吃掉邻居省份」的根因）。
import {
  provinceRings, smoothRing, pointInProvince, provinceBBox, shapePatch,
  buildSkeleton, conformToSkeleton,
} from '../utils/provinceShape';

const store = useGeodataStore();
const layers = useLayersStore();

// Phase 3：省份「归属标签网格」——笔刷/套索 + 自动省界（数据在 store 的 provinceEditing 模块）
const provinceBrush = useProvinceBrush();
const { radius: provBrushRadius, strength: provBrushStrength, tool: provBrushTool,
        targetIdx: provBrushTarget, showBorders: provMeshBorders, showNoStar: provMeshNoStar } = provinceBrush;
// 🔴 P0 第二块：**渲染单一路径**。画布永远画省份多边形（= 存下来/导出的那个几何），网格退为
//    内部中间层 —— 只在**涂抹进行中**叠一层即时反馈（labels 变了，多边形要等抬手才重算）。
//    原先的「网格视图」开关已删除：「格渲染 ↔ 多边形渲染」二选一意味着用户看到的与存下来的
//    可能不是同一个几何，这正是「丑东西 / 功能打架」的来源。
const provinceGridReady = ref(false);     // 网格是否就绪（异步补建完成；只用于提示与即时反馈）
let provStrokeActive = false;             // 涂抹中（快速档渲染）
let provLassoActive = false;
const provLassoPoints = ref([]);          // 套索轨迹（世界坐标）
const provBrushPreview = ref(null);
const provinceHint = ref('');             // 省份网格操作提示（状态栏）

const canvas = ref(null);
const canvasWrap = ref(null);
const tool = ref('draw');   // P1：自由绘制为默认工具（见 PROVINCE_PALETTE 旁的说明）
// P3：工具栏按任务分层 —— 默认只有 6 个可见控件，其余收进「更多」（能力不减）
const moreOpen = ref(false);
const ADVANCED_TOOLS = new Set(['split', 'merge', 'provinceFill', 'paint', 'river', 'relief', 'label',
  'erase', 'height', 'biome', 'burg', 'culture', 'religion', 'marker', 'road']);
const advancedToolActive = computed(() => ADVANCED_TOOLS.has(tool.value));
// 「变更归属」的省份选项：选到这类工具（或用户自己打开「更多」）就显示
const PROVINCE_TOOLS = new Set(['provinceBrush', 'provinceLasso', 'provinceFill', 'split', 'merge', 'vertex']);
const provinceRowVisible = computed(() => moreOpen.value || PROVINCE_TOOLS.has(tool.value));
const viewMode = ref('base');
// ── 底图高度图（A1，2026-09-24）──────────────────────────────────────────────
// 底图的高度图此前只有「.map 导入」一条来源 → 新建的底图用不了任何高度类工具（静默 return）。
/** 当前底图绑定到的行星 id（绑定了则高度图归行星侧，底图不该再自建） */
/** 当前底图绑定到的行星 id（绑定了则高度图归行星侧，底图不该再自建） */
const baseMapBoundPlanet = computed(() => (baseMapKey.value ? store.getBoundPlanetId(baseMapKey.value) : null));
/** 当前底图是否已有可用高度图网格 */
const baseMapHasHeightmap = computed(() => {
  if (!baseMapKey.value) return false;
  const hm = store.getHeightmapFor(baseMapKey.value);
  return !!(hm && hm.grid && Array.isArray(hm.grid.points) && hm.grid.points.length > 0);
});
/** 是否显示「创建高度图」按钮：已选底图 + 未绑定行星 + 还没有网格 */
const baseMapCanCreateHeightmap = computed(() =>
  !!baseMapKey.value && !baseMapBoundPlanet.value && !baseMapHasHeightmap.value);

// ── 地形来源（M1c，2026-09-25）────────────────────────────────────────────────
// 用户决策：「历史剧本 = 一次施工永久存档」，强行绑到行星上会有风险（改行星会连带改剧本）。
// 所以两种模式并存、**冻结为默认**：
//   · 冻结导入 → 复制一份独立副本（互不影响）→ 历史存档
//   · 跟随行星 → 共用同一份（互相影响）      → 当代、与行星同步构建的地图
// 真相仍在 store（`planetId` 字段 / 底图自持的 `heightmap`），本组件只做展示与触发。
const pickPlanetId = ref('');
const availablePlanets = computed(() =>
  (store.nodes || [])
    .filter(n => n.layer === 'planet')
    .map(n => ({ id: n.id, name: n.name || n.id })));

const terrainInfo = computed(() =>
  (baseMapKey.value ? store.describeBaseMapTerrain(baseMapKey.value) : { mode: 'none' }));

function planetNameById(id) {
  return availablePlanets.value.find(p => p.id === id)?.name || id;
}

const terrainModeLabel = computed(() => {
  const t = terrainInfo.value;
  if (t.mode === 'following') {
    return t.dangling ? `跟随：${planetNameById(t.planetId)}（已失效）` : `跟随：${planetNameById(t.planetId)}`;
  }
  if (t.mode === 'frozen') return t.from ? `冻结自 ${t.from.name}` : '独立地形';
  if (t.mode === 'empty') return '无地形';
  return '—';
});

const terrainModeTitle = computed(() => {
  const t = terrainInfo.value;
  if (t.mode === 'following') {
    return t.dangling
      ? '这张底图跟随的行星已不存在（绑定失效）—— 建议「解绑」后改用「冻结导入」'
      : `地形与「${planetNameById(t.planetId)}」共用同一份：在剧本里编辑会改到那颗行星，行星改地形也会改到这里`;
  }
  if (t.mode === 'frozen') {
    return t.from
      ? `独立副本，冻结自「${t.from.name}」（${String(t.from.at || '').slice(0, 16).replace('T', ' ')}）—— 之后行星改地形不会影响它`
      : '这张底图自持一份独立地形（不跟随任何行星）';
  }
  if (t.mode === 'empty') {
    return '这张底图还没有地形：可用「冻结导入」从行星复制一份，或点底图旁的图层按钮从零创建';
  }
  return '';
});

/** 冻结导入：把行星当前地形**复制**一份（副本独立） */
function freezeTerrainFromPlanet() {
  const pid = pickPlanetId.value;
  if (!pid) return;
  const name = planetNameById(pid);
  let r = store.importHeightmapFromPlanet(baseMapKey.value, pid, { planetName: name });
  if (r && r.conflict) {
    if (!window.confirm(r.error)) { statusMsg('已取消导入（保留了原地形）'); return; }
    r = store.importHeightmapFromPlanet(baseMapKey.value, pid, { force: true, planetName: name });
  }
  if (!r || r.ok === false) { statusMsg((r && r.error) || '导入地形失败'); return; }
  statusMsg(`已冻结导入「${name}」的地形（${r.cellsX}×${r.cellsY}，${r.cells} 格）—— 这是独立副本，之后行星改地形不会影响它`);
  renderer.requestRender();
}

/** 跟随行星：共用同一份（会二次确认，并提示存档场景应改用冻结导入） */
function bindTerrainToPlanet() {
  const pid = pickPlanetId.value;
  if (!pid) return;
  const name = planetNameById(pid);
  const okGo = window.confirm(
    `让「${baseMapKey.value}」跟随「${name}」的地形？\n\n`
    + '跟随 = 两边共用同一份：在剧本里涂山会改到行星，行星改地形也会改到这张剧本。\n\n'
    + '如果这是要长期存档的历史剧本，请改用「冻结导入」（复制一份、互不影响）。'
  );
  if (!okGo) return;
  const r = store.bindBaseMapToPlanet(baseMapKey.value, pid);
  if (!r || r.ok === false) { statusMsg((r && r.error) || '跟随失败'); return; }
  statusMsg(`已跟随「${name}」的地形 —— 现在两边是同一份：在剧本里编辑会改到那颗行星`);
  renderer.requestRender();
}

/** 解绑：行星那份不动，本底图回到「没有地形」 */
function unbindTerrainFromPlanet() {
  const okGo = window.confirm(
    '解除跟随？\n\n行星那份地形不受影响；这张底图会回到「没有地形」（可再用「冻结导入」拿一份独立副本）。'
  );
  if (!okGo) return;
  const r = store.unbindBaseMap(baseMapKey.value);
  if (!r || r.ok === false) { statusMsg((r && r.error) || '解绑失败'); return; }
  statusMsg('已解除跟随 —— 行星那份没动；可用「冻结导入」从行星拿一份独立副本');
  renderer.requestRender();
}
const baseMapKey = ref('');   // 空 = 当前项目还没有底图（onMounted 里解析：上次的 → 项目里第一张 → 空）
const selectedScenario = ref(null);
// ⚠️ 势力对象必须随数据**自愈重指向**：`updatePolity`（改名/简称）、撤销、导入都会整体替换
//    `polities` 数组 → 持有旧对象会让「改完名界面还显示旧名」，而且**不报错**。
//    这里刻意用「可写 ref + 刷新 watch」，而**不是** computed：
//    computed 只读，任何 `selectedPolity.value = x` 都会**静默失效** ——
//    实测其代价是 test_65 的 `sc.selectedPolity = …` 被无声吞掉（写失败却不报错）。
//    同理 `selectedScenario` 也是「可写 ref + 刷新 watch」，两处保持一致。
const selectedPolity = ref(null);
watch(() => selectedScenario.value?.polities, (list) => {
  const cur = selectedPolity.value;
  if (!cur) return;
  if (!list) { selectedPolity.value = null; return; }
  // 势力被删 → 清空选中（不留悬空引用）；否则指向同一个 id 的最新对象
  selectedPolity.value = list.find((p) => p.id === cur.id) || null;
});
const ctx = ref(null);
const showScenarioManager = ref(false);
const showLayerPanel = ref(false);
const showHistoryPanel = ref(false);
// 底图列表（P1 切换底图）
const availableBaseMaps = computed(() => {
  const maps = store.getBaseMapsList();
  return maps.map(b => ({
    id: b.id,
    name: b.name || b.id,
    count: b.terrain?.length || 0,
  }));
});

// 底图切换（P2 方案A：切换底图 = 切换剧本集）
async function onBaseMapChange() {
  // 清空当前选中态（避免引用旧底图数据）
  selectedProvince.value = null;
  selectedScenario.value = null;
  selectedPolity.value = null;
  showProps.value = false;
  contextMenu.value.show = false;
  rasterCache.clear();

  // 持久化当前底图键
  if (window.sitianAPI?.setCurrentBaseMapKey) {
    await window.sitianAPI.setCurrentBaseMapKey(baseMapKey.value);
  }

  // 自动选中该底图下的第一个剧本
  const first = sortedScenarios.value[0];
  resetTimelineToStart();
  if (first) {
    selectScenario(first);
  } else {
    render();
  }
}

// 图层锁定（P0 图层锁定迁移）
const scenarioLayers = ref({
  terrain: { visible: true, label: '省份', locked: false, order: 0 },
  biomes: { visible: true, label: '生物群系', locked: false, order: 1 },
  borders: { visible: true, label: '边界', locked: false, order: 2 },
  burgs: { visible: true, label: '城镇', locked: false, order: 3 },
  labels: { visible: true, label: '标签', locked: false, order: 4 },
  rivers: { visible: true, label: '河流', locked: false, order: 5 },
  routes: { visible: false, label: '道路', locked: false, order: 6 },
  raster: { visible: true, label: '底图数据', locked: false, order: 7 },
});

function isLayerLocked(layerId) {
  return scenarioLayers.value[layerId]?.locked ?? false;
}

function toggleLayerLock(layerId) {
  const layer = scenarioLayers.value[layerId];
  if (layer) {
    layer.locked = !layer.locked;
  }
}

function isLayerEditable(layerId) {
  const layer = scenarioLayers.value[layerId];
  if (!layer) return false;
  return layer.visible && !layer.locked;
}

// 图层可见性（保留旧 ref 兼容模板）
const showBiomes = ref(true);
const showBorders = ref(true);
const showLabels = ref(true);
const showBurgs = ref(true);
// A8：势力名/省名的分级标注（默认开 —— 势力名是历史剧本的主要读物）。
// 与 showLabels 分开：showLabels 管的是用户**手放**的浮动文本，两者是不同性质的东西。
const showPolityLabels = ref(true);

// 摄像机（pan/zoom）
const cameraX = ref(0);
const cameraY = ref(0);
const cameraScale = ref(1);

// 🔴 屏幕像素长度 → 世界单位：所有「屏幕空间尺寸/线宽/半径」的换算**一律走 px()**。
// 内部把相机缩放夹正数，从根上杜绝 `N / cameraScale` 在 scale 异常时算出负半径/负线宽
// （2026-09-20 实测：fitToView 在窄高窗口算出负 scale → `3 / cameraScale` 变负 →
//  ctx.arc 抛 IndexSizeError，而抛在 render 路径里会把整页交互一起拖死，后续用例连环 CDP 超时）。
// 注意：坐标变换（screenToWorld）不能用 px()，它要的是真实 scale。
const MIN_CAMERA_SCALE = 0.02;
const px = (v) => v / Math.max(cameraScale.value, MIN_CAMERA_SCALE);

// 渲染护栏状态（见下方 render()）：连续异常则暂停渲染循环并给可见提示
const renderError = ref('');        // 最近一次渲染异常信息
const renderErrorCount = ref(0);    // 连续异常帧数
const renderPaused = ref(false);    // 已暂停渲染（避免每帧刷屏/拖死交互）
let renderErrorLogged = false;      // 首次异常只报告一次（console + 主进程日志）

// 绘制/拆分/合并状态
const drawPoints = ref([]);
const splitStep = ref(0);
const splitPoints = ref([]);
const mergeStep = ref(0);
const mergeProvId = ref(null);

// 顶点编辑状态
const vertexEditMode = ref(false);
const draggingVertex = ref(null); // { provId, vertexIdx }
const draggingHandle = ref(null); // { provId, vertexIdx, which: 'in'|'out' }（P0-T1 切线手柄）
const hoveredVertex = ref(null);
// 拖拽中的临时顶点（仅做渲染预览，不写 store → undo 快照保持正确）
const dragPreview = ref(null); // { provId, points }

// 网格吸附（P0-T3）
const GRID_STEP = 50;                // 世界坐标网格间距，与 drawBackground 网格线一致
const snapToGridEnabled = ref(true); // 工具栏开关，默认开启
const snapMarker = ref(null);        // { x, y } 最近吸附点，用于十字标记
let snapMarkerTimer = null;
let lastFitKey = '';                 // 自动适屏：上次适配的底图键
let lastFitCount = 0;                // 自动适屏：上次适配时的省份数
// 首次进入的「适屏收尾」：布局还在定稿（时间轴占位会让画布变矮）期间允许重新适屏，
// 用户一旦交互（滚轮/按下）就交还控制权，绝不跟用户抢镜头。
let initialFitPending = false;
let settleFitTimer = null;

// 笔刷状态（v2 高度图编辑）
const brushRadius = ref(80);         // 世界坐标像素
const brushStrength = ref(3);        // 高度变化强度
const brushBiome = ref('grassland'); // 当前选中生物群系
const brushCulture = ref('1');       // 当前选中文化 ID
const brushReligion = ref('1');      // 当前选中宗教 ID
let isBrushing = false;              // 是否正在笔刷拖动中
let brushMode = 'raise';             // 'raise' | 'lower' | 'smooth'
const brushPreview = ref(null);      // { x, y, radius } 笔刷预览（hover 显示）

// 笔刷性能优化：空间索引（网格快速定位，避免全量遍历）
let gridSpatialIndex = null;

function buildSpatialIndex(pts, spacing) {
  if (!pts || !pts.length) return null;
  const cellSize = spacing * 2;
  const cellMap = new Map();
  let minX = Infinity, minY = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
    const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
    if (px < minX) minX = px;
    if (py < minY) minY = py;
  }
  for (let i = 0; i < pts.length; i++) {
    const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
    const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
    const cx = Math.floor((px - minX) / cellSize);
    const cy = Math.floor((py - minY) / cellSize);
    const key = `${cx},${cy}`;
    if (!cellMap.has(key)) cellMap.set(key, []);
    cellMap.get(key).push(i);
  }
  return { cellSize, minX, minY, cellMap };
}

function getNearbyIndices(worldX, worldY, radius, spatialIndex) {
  if (!spatialIndex) return null;
  const { cellSize, minX, minY, cellMap } = spatialIndex;
  const minCx = Math.floor((worldX - radius - minX) / cellSize);
  const maxCx = Math.floor((worldX + radius - minX) / cellSize);
  const minCy = Math.floor((worldY - radius - minY) / cellSize);
  const maxCy = Math.floor((worldY + radius - minY) / cellSize);
  const result = [];
  for (let cx = minCx; cx <= maxCx; cx++) {
    for (let cy = minCy; cy <= maxCy; cy++) {
      const cell = cellMap.get(`${cx},${cy}`);
      if (cell) result.push(...cell);
    }
  }
  return result;
}

// 笔刷性能优化：派生节流（拖拽中每 3 帧派生一次）
let brushFrameCount = 0;
let pendingDerive = false;
// 文化/宗教选项
const availableCultures = computed(() => {
  const hm = baseMap.value?.heightmap;
  return hm?.cultures?.filter(c => c.i > 0) || [{ id: 1, name: '未分类' }];
});

const availableReligions = computed(() => {
  const hm = baseMap.value?.heightmap;
  return hm?.religions?.filter(r => r.i > 0) || [{ id: 1, name: '未分类' }];
});

const autoRivers = ref([]);          // {x,y}[] 生成的河流路径

// Relief icons (P1-T1 山脉/树木/沙漠等自然特征)
// ⚠️ icon 存的是**矢量图标名**（Icon.vue + canvasIcon.js 双端同名），不再是 emoji 字面量：
//    emoji 会随系统字体变形、无法主题化，且用户明确要求统一画风（2026-09-22）。
//    用户历史数据里的 emoji 仍由 drawIconOrEmoji 的 fillText 回退兜住（向后兼容）。
const RELIEF_ICONS = [
  { id: 'mountain', name: '山脉', icon: 'mountain', color: '#8B7355' },
  { id: 'forest', name: '森林', icon: 'tree', color: '#228B22' },
  { id: 'desert', name: '沙漠', icon: 'desert', color: '#EDC9AF' },
  { id: 'volcano', name: '火山', icon: 'flame', color: '#FF4500' },
  { id: 'lake', name: '湖泊', icon: 'droplet', color: '#4A90D9' },
  { id: 'cactus', name: '仙人掌', icon: 'cactus', color: '#5F7A4A' },
  { id: 'palm', name: '棕榈', icon: 'palm', color: '#228B22' },
  { id: 'snow', name: '雪地', icon: 'snowflake', color: '#F0F8FF' },
];

const selectedReliefIcon = ref('mountain');
const reliefIcons = ref([]); // { id, iconId, x, y, icon, color }

// 道路编辑器（P1-T3 道路样式预设）
const ROAD_STYLES = [
  { id: 'highway', name: '公路', width: 1.5, dash: null, color: '#d06324' },
  { id: 'road', name: '道路', width: 1.0, dash: null, color: '#d06324' },
  { id: 'trail', name: '小径', width: 0.7, dash: [3, 3], color: '#d06324' },
  { id: 'path', name: '步道', width: 0.5, dash: [1.5, 3], color: '#d06324' },
  { id: 'searoute', name: '海路', width: 0.8, dash: [2, 4], color: '#ffffff' },
];

const selectedRoadStyle = ref('road');

// 标记类型系统（P1-T5 多种标记类型）
// ⚠️ 同上：icon 是矢量图标名（双端同名），不是 emoji
const MARKER_TYPES = [
  { id: 'city', name: '城市', icon: 'castle', color: '#ffd700' },
  { id: 'port', name: '港口', icon: 'anchor', color: '#4A90D9' },
  { id: 'battlefield', name: '战场', icon: 'swords', color: '#f87171' },
  { id: 'ruin', name: '遗迹', icon: 'ruins', color: '#a78bfa' },
  { id: 'resource', name: '资源', icon: 'gem', color: '#34d399' },
  { id: 'danger', name: '危险', icon: 'skull', color: '#f87171' },
  { id: 'custom', name: '自定义', icon: 'map-pin', color: '#94a3b8' },
];

const selectedMarkerType = ref('city');

// 河流编辑器（P1-T2 手动编辑河流路径）
const riverDraft = ref([]); // {x, y}[] 当前绘制中的河流路径
const riverPaths = ref([]); // {x, y}[][] 已完成的河流路径
const LABEL_PRESETS = [
  { id: 'default', name: '默认', font: '12px "PingFang SC"', color: '#e2e8f0', stroke: 'rgba(0,0,0,0.7)', strokeWidth: 3 },
  { id: 'title', name: '标题', font: 'bold 18px "PingFang SC"', color: '#ffd700', stroke: 'rgba(0,0,0,0.8)', strokeWidth: 4 },
  { id: 'subtitle', name: '副标题', font: '14px "PingFang SC"', color: '#94a3b8', stroke: 'rgba(0,0,0,0.6)', strokeWidth: 2 },
  { id: 'culture', name: '文化', font: 'italic 13px "PingFang SC"', color: '#c4b5fd', stroke: 'rgba(0,0,0,0.6)', strokeWidth: 2 },
  { id: 'danger', name: '危险', font: 'bold 13px "PingFang SC"', color: '#f87171', stroke: 'rgba(0,0,0,0.7)', strokeWidth: 3 },
];

const selectedLabelPreset = ref('default');
const roadStart = ref(null);         // {x, y} 道路起点
const roadPath = ref([]);            // {x, y}[] 道路路径预览

// 聚落编辑器（P1-T4 聚落规模/人口/文化归属）
const BURG_SIZES = [
  { id: 'capital', name: '首都', radius: 5.5, color: '#ffd700', basePop: 100 },
  { id: 'city', name: '城市', radius: 4.5, color: '#e2e8f0', basePop: 50 },
  { id: 'town', name: '城镇', radius: 3.5, color: '#94a3b8', basePop: 20 },
  { id: 'village', name: '村庄', radius: 2.5, color: '#64748b', basePop: 5 },
];

const selectedBurgSize = ref('city');
const burgEditorOpen = ref(false);
const editingBurg = ref(null); // { id, name, size, population, culture }
const BURG_HIT_RADIUS = 10;          // 命中半径（屏幕像素）
const hoveredBurg = ref(null);
const selectedBurg = ref(null);

// ── 底图数据图层（FMG .map 解析产物：网格高度/温度/降水 + 河流/道路 + 文化/宗教）──
const rasterLayer = ref('landsea');  // none | landsea | height | temp | prec（互斥单选）
const showRivers = ref(true);
const showRoutes = ref(false);
const colorMode = ref('default');    // default | culture | religion

// 顶点切线手柄当前选中顶点（P0-T1）；-1 = 未选中
const activeVertexIdx = ref(-1);
// Alt 临时直线（P0-T1）；不参与响应式，只在绘制时读取
let altStraight = false;

// P1：**自由绘制 = 默认工具** —— 空底图上打开就能画（不再需要先「新建省份」）。
// 精确定点（描点）是同一个工具里的第二条路径（单击落顶点），选择/移动另在工具栏。

// P1：新建省份的色板轮转（确定性 —— 颜色不随机，测试可断言、用户可预期）
const PROVINCE_PALETTE = [
  '#9ec9a8', '#c9b48a', '#a99ac9', '#c99a9a', '#8fb8c9',
  '#c9c48a', '#b8a4c9', '#8ac9bb', '#c9a88f', '#a4b8c9',
];
function nextProvinceColor(count) { return PROVINCE_PALETTE[count % PROVINCE_PALETTE.length]; }

// P4：海域（kind='sea'）有自己的视觉 —— 淡色水面 + **淡虚线海界**（虚线是「这是水域」的约定），
// 且**不参与势力归属着色**（海不是谁的领土）。
const SEA_FILL = 'rgba(74, 118, 158, 0.42)';
const SEA_EDGE = 'rgba(206, 228, 244, 0.75)';

// 海岸线吸附（P0-T2）
const snapToEdgeEnabled = ref(true);
const SNAP_EDGE_THRESHOLD = 10;      // 世界坐标像素
const snapFeedback = ref('');
let snapFeedbackTimer = null;

// 底图数据图层的离屏预渲染缓存（键：layerKey -> {canvas,minX,minY,w,h}）
const rasterCache = new Map();

// 分层设色盘（低→高；海洋/陆地分段）
// 色带与陆海底色（HYPSO_WATER/LAND、TEMP_RAMP、PREC_RAMP、LAND/SEA_BASE_COLOR）
// 2026-09-25 已迁到 `utils/heightmapRaster.js` —— 见文件上方说明。此处不再保留副本，
// 避免「改了一处配色、另一个视图没变」这种又一处双源。

// 右键菜单
const contextMenu = ref({ show: false, x: 0, y: 0, provId: null });
const showProps = ref(false);
const selectedProvince = ref(null);

// 生物群系颜色
const BIOME_COLORS = {
  ocean: '#2E86AB',
  hot_desert: '#E9C46A',
  cold_desert: '#B5B887',
  savanna: '#D2D082',
  grassland: '#C8D68F',
  tropical_seasonal: '#B6D95D',
  temperate_deciduous: '#29BC56',
  tropical_rainforest: '#7DCB35',
  temperate_rainforest: '#409C43',
  taiga: '#4B6B32',
  tundra: '#96784B',
  glacier: '#D5E7EB',
  wetland: '#0B9131',
  land: '#A3C4BC',
};

const newScenario = ref({
  name: '',
  roman: '',
  label: '',
  startYear: '',
  endYear: '',
  description: '',
  inherit: true,
});

const baseMap = computed(() => store.baseMaps?.[baseMapKey.value]);

// 城镇数据：优先取 .map 导入的 burgs，兼容旧数据（早期导入只把首都写进剧本 markers）
const burgs = computed(() => {
  const list = baseMap.value?.burgs;
  if (Array.isArray(list) && list.length) return list;
  return (selectedScenario.value?.markers || []).map((m, i) => ({
    id: `marker_${i}`,
    name: m.name || '',
    x: m.x,
    y: m.y,
    capital: 1,
    population: 0,
  }));
});

const scenarios = computed(() => {
  return store.getScenariosByOwner?.(baseMapKey.value) || [];
});

const sortedScenarios = computed(() => {
  return [...scenarios.value].sort((a, b) => (a.order || 0) - (b.order || 0));
});

const statusText = computed(() => {
  if (!baseMap.value) return '未加载底图';
  const la = layerAvailability.value;
  const bits = [`${baseMap.value.terrain?.length || 0} 省份`];
  if (la.cells) bits.push(`${la.cells} 网格`);
  if (la.rivers) bits.push(`${la.rivers} 河流`);
  if (la.routes) bits.push(`${la.routes} 道路`);
  if (la.cultures > 1) bits.push(`${la.cultures - 1} 文化`);
  if (la.religions > 1) bits.push(`${la.religions - 1} 宗教`);
  return bits.join(' | ');
});

function setTool(t) {
  tool.value = t;
  // Phase 3：切到省份网格工具时异步把网格准备好（否则用户涂了看不见）
  if (PROVINCE_GRID_TOOLS.has(t)) {
    // 🔴 网格懒建**不能同步**：21 省现场栅格化实测 170~368ms 主线程冻结（P-0 实测，
    //    用户观感就是「一打开省份工具就卡」）。改成下一帧再做，期间画布照画多边形。
    scheduleProvinceGrid();
    if (!provBrushTarget.value) provBrushTarget.value = 1;
  }
  provStrokeActive = false;
  provLassoActive = false;
  provLassoPoints.value = [];
  provBrushPreview.value = null;
  drawPoints.value = [];
  splitStep.value = 0;
  splitPoints.value = [];
  mergeStep.value = 0;
  mergeProvId.value = null;
  vertexEditMode.value = (t === 'vertex');
  draggingVertex.value = null;
  draggingHandle.value = null;
  activeVertexIdx.value = -1;
  dragPreview.value = null;
  hoveredBurg.value = null;
  brushPreview.value = null;
  isBrushing = false;
  roadStart.value = null;
  roadPath.value = [];
  clearSnapMarker();
  updateCursor();
}

function updateCursor() {
  if (!canvas.value) return;
  if (tool.value === 'select') canvas.value.style.cursor = 'grab';
  else if (tool.value === 'draw') canvas.value.style.cursor = 'crosshair';
  else if (tool.value === 'vertex') canvas.value.style.cursor = 'move';
  else if (tool.value === 'split') canvas.value.style.cursor = 'cell';
  else if (tool.value === 'merge') canvas.value.style.cursor = 'pointer';
  else if (tool.value === 'paint') canvas.value.style.cursor = 'copy';
  else if (tool.value === 'label') canvas.value.style.cursor = 'text';
  else if (tool.value === 'erase') canvas.value.style.cursor = 'not-allowed';
  else if (tool.value === 'height' || tool.value === 'biome') canvas.value.style.cursor = 'none';
  else if (PROVINCE_GRID_TOOLS.has(tool.value)) canvas.value.style.cursor = 'crosshair';
  else canvas.value.style.cursor = 'default';
}

function onModeChange() {
  if (viewMode.value === 'scenario') {
    if (sortedScenarios.value.length > 0 && !selectedScenario.value) {
      selectScenario(sortedScenarios.value[0]);
    }
  }
}

function selectScenario(s) {
  selectedScenario.value = s;
  render();
}

function selectPolity(p) {
  selectedPolity.value = p || null;
}

// ── A8：势力显示信息（名称 / 简称）的编辑入口 ──────────────────────────────
// 「自定义显示的势力名称」是暮雨的原话诉求：.map 导入带来的是 FMG 的国家名，
// 用户要把它改成自己世界观里的叫法（并可另给一个缩小档用的简称）。
function updateSelectedPolity(patch, okText) {
  const polity = selectedPolity.value;
  const sc = selectedScenario.value;
  if (!polity || !sc) return;
  const r = store.updatePolity(sc.id, polity.id, patch);
  if (!r || !r.success) {
    statusMsg(r && r.reason === 'no-polity' ? '势力已不存在（可能被删除）' : '修改势力失败');
    return;
  }
  if (!r.changed) return;    // 没实质改动 → 不入 undo 栈、不提示
  statusMsg(okText);
  render();
}

function onPolityNameChange(e) {
  const polity = selectedPolity.value;
  if (!polity) return;
  const v = String(e.target.value || '').trim();
  if (!v) { e.target.value = polity.name || ''; statusMsg('势力名不能为空'); return; }
  updateSelectedPolity({ name: v }, `势力已改名：${v}`);
}

function onPolityAbbrChange(e) {
  const v = String(e.target.value || '').trim();
  updateSelectedPolity({ abbr: v || null }, v ? `势力简称：${v}` : '已清除简称（缩小档回落全名）');
}

const showLineagePanel = ref(false);

// ═══════════════════════════════════════════
// 时间轴（P1）：按年比例轴 + EU4 斜线占领
// ═══════════════════════════════════════════
// 状态与 ScenarioTimeline 组件双向绑定；播放为一帧一剧本推进（3488 年按年播需 4 分钟）
const tlEra = ref(0);
const tlYear = ref(0);
const tlAxisMode = ref('year');   // year | equal
const tlDiffMode = ref('eu4');    // eu4 | outline | off
const tlPlaying = ref(false);

/** 时间轴模型（谱系匹配 + 逐省变化年份 + 年代区间/断层）——纯函数，见 utils/scenarioTimeline.js */
const timeline = computed(() => buildTimeline(sortedScenarios.value || []));

const tlSettled = computed(() => settledCount(timeline.value, tlEra.value, tlYear.value));
const tlInGap = computed(() => (tlAxisMode.value === 'year'
  ? !!findGap(timeline.value, tlYear.value) : false));

/** 省 id → 名称（P2 面板与导出用） */
const provinceNameMap = computed(() => {
  const m = {};
  for (const p of (baseMap.value?.terrain || [])) {
    if (p?.id) m[p.id] = p.name || p.id;
  }
  return m;
});

const scenarioExport = useScenarioExport({
  store,
  baseMap,
  timeline,
  currentEra: tlEra,
  currentYear: tlYear,
  diffMode: tlDiffMode,
  provinceNames: provinceNameMap,
  layerFlags: () => ({ labels: showLabels.value, borders: showBorders.value }),
});
const { exportStatus, exportScenarioPNG, exportScenarioSVG, exportScenariosJson, pickScenariosJson } = scenarioExport;

function importScenariosJson(mode) {
  return pickScenariosJson({ mode });
}

function onSetPolityLineage({ scenarioId, polityId, successorOf }) {
  store.setPolityLineage(scenarioId, polityId, { successorOf });
  render();
}

function onSetChangeYear({ scenarioId, provinceId, year }) {
  store.setProvinceChangeYear(scenarioId, provinceId, year);
  render();
}

/** 时间轴切剧本时同步选中态（编辑目标跟着走） */
function onTimelineSelectScenario(s) {
  if (s && selectedScenario.value?.id !== s.id) {
    selectedScenario.value = s;
    selectedPolity.value = null;   // 跨剧本 polity id 全新，留着必然落空
  }
  render();
}

// ——— 播放：一帧一剧本，剧本内年份线性扫过，跨剧本自动跳过年份断层 ———
const TL_ERA_MS = 1300;
let tlRafId = null;
let tlLastT = 0;
let tlPlayT = 0;

function tlFrame(t) {
  const dt = Math.min(64, t - tlLastT);
  tlLastT = t;
  if (!tlPlaying.value) { tlRafId = null; return; }
  const n = timeline.value.years.length;
  tlPlayT += dt / TL_ERA_MS;
  while (tlPlayT >= 1) {
    tlPlayT -= 1;
    if (tlEra.value >= n - 1) {
      tlEra.value = n - 1;
      tlYear.value = timeline.value.years[n - 1].end;
      tlPlaying.value = false;
      tlPlayT = 0;
      break;
    }
    tlEra.value += 1;
  }
  if (tlPlaying.value) {
    const y = timeline.value.years[tlEra.value];
    tlYear.value = y.start + tlPlayT * (y.end - y.start);
  }
  render();
  if (tlPlaying.value) tlRafId = requestAnimationFrame(tlFrame);
  else tlRafId = null;
}

watch(tlPlaying, (v) => {
  if (!v) return;
  const n = timeline.value.years.length;
  if (!n) { tlPlaying.value = false; return; }
  // 已播到末尾则从头开始
  if (tlEra.value >= n - 1 && tlYear.value >= timeline.value.years[n - 1].end) {
    tlEra.value = 0;
    tlYear.value = timeline.value.years[0].start;
  }
  const y = timeline.value.years[tlEra.value];
  tlPlayT = Math.max(0, Math.min(1, (tlYear.value - y.start) / Math.max(1, y.end - y.start)));
  tlLastT = performance.now();
  if (tlRafId == null) tlRafId = requestAnimationFrame(tlFrame);
});

// 时间轴的**唯一真源是 year**：era 必须由 year 派生。
// 否则拖动游标后 era 不跟着变 → 地图仍按旧剧本的归属渲染、HUD 的「已易主」也是错的。
watch(tlYear, (y) => {
  const tl = timeline.value;
  if (!tl.years.length) return;
  const k = eraIndexOfYear(tl, y);
  if (k !== tlEra.value) tlEra.value = k;
  render();
});

// era 变化 → 编辑目标（selectedScenario）跟着走
watch(tlEra, (k) => {
  const s = timeline.value.scenarios[k];
  if (s && selectedScenario.value?.id !== s.id) {
    selectedScenario.value = s;
    selectedPolity.value = null;   // 同上：polity id 跨剧本不通用
  }
  render();
});

watch([tlDiffMode, tlAxisMode], () => { render(); });

// ⚠️ 这两个必须在 onMounted 里注册：setup 期调用 watch(computedRef) 会**立刻求值一次**，
//    而 sortedScenarios 在本行位置尚未定义（TDZ ReferenceError）。
onMounted(() => {
  watch(sortedScenarios, (list) => {
    if (!list || !list.length) return;
    // 剧情数据被编辑（拖顶点/上色/undo）后重指向最新对象，否则选中态会悬在旧对象上
    if (selectedScenario.value) {
      const fresh = list.find(s => s.id === selectedScenario.value.id);
      if (fresh) selectedScenario.value = fresh;
    }
    if (tlEra.value > list.length - 1) tlEra.value = list.length - 1;
    // 剧本是异步载入的（scenarios.json）：数据到了就切政治视图，否则时间轴拖动看不出效果
    if (list.length && viewMode.value !== 'scenario') viewMode.value = 'scenario';
    const tl = timeline.value;
    if (tlYear.value < tl.minYear || tlYear.value > tl.maxYear) tlYear.value = tl.minYear;
    render();
  }, { deep: false });

  // 首帧把游标落到第一个剧本
  resetTimelineToStart();
});

/** 初始化/切换底图后把游标落到第一个剧本 */
function resetTimelineToStart() {
  const tl = timeline.value;
  if (!tl.years.length) { tlEra.value = 0; tlYear.value = 0; return; }
  tlEra.value = 0;
  tlYear.value = tl.years[0].start;
  // 进入剧本模块时默认就是「政治视图」——否则省份按生物群系着色，时间轴等于白拖
  if (viewMode.value !== 'scenario') viewMode.value = 'scenario';
}

// ═══════════════════════════════════════════
// 网格吸附（P0-T3）
// ═══════════════════════════════════════════
/** 对齐到最近网格点；bypass（按住 Shift）或关闭开关时原样返回 */
function snapToGrid(world, bypass = false) {
  if (!snapToGridEnabled.value || bypass) return { x: world.x, y: world.y, snapped: false };
  return {
    x: Math.round(world.x / GRID_STEP) * GRID_STEP,
    y: Math.round(world.y / GRID_STEP) * GRID_STEP,
    snapped: true,
  };
}

function setSnapMarker(x, y, kind = 'grid') {
  snapMarker.value = { x, y, kind };
  if (snapMarkerTimer) { clearTimeout(snapMarkerTimer); snapMarkerTimer = null; }
}

/** delay > 0 时延时自动清除（绘制点击后短暂显示），否则立即清除 */
function clearSnapMarker(delay = 0) {
  if (snapMarkerTimer) { clearTimeout(snapMarkerTimer); snapMarkerTimer = null; }
  if (delay <= 0) { snapMarker.value = null; return; }
  snapMarkerTimer = setTimeout(() => {
    snapMarkerTimer = null;
    snapMarker.value = null;
    render();
  }, delay);
}

/** 拖拽中返回临时预览点集，避免渲染读到未提交的修改 */
function resolvePoints(prov) {
  if (dragPreview.value && dragPreview.value.provId === prov.id) return dragPreview.value.points;
  return ringPointsOf(prov);        // 顶点编辑作用于**活动环**（多环省份可在属性面板切换）
}

// ─────────────────────────────────────────────────────────────
// 绘制用的「去响应式」几何（P-0 实测：单帧 94ms 的主因）
//   `baseMap.value.terrain` 是 Pinia ref 里的对象 → 走 `.value` 读到的每个省份/顶点都是
//   Vue 响应式代理；drawProvinces / traceShapePath / 小地图每帧对 25930 个顶点做属性读取，
//   CPU profiler 里「Vue 响应式 get 陷阱」占 27%、`reactive()` 占 6%，`vx/vy` 占 9%。
//   渲染是纯读场景，取 toRaw 后的原始数组即可（toRaw 是 WeakMap 查表，可忽略成本）。
//   ⚠️ 只在**绘制**路径用；命中检测、编辑、store 写入仍走原来的响应式引用（避免脱钩）。
// ─────────────────────────────────────────────────────────────
function rawTerrain() {
  const t = baseMap.value?.terrain;
  return t ? toRaw(t) : null;
}

/** 原始（无代理）顶点数组；拖拽预览用的是普通对象，直接返回 */
function rawPointsOf(prov) {
  if (dragPreview.value && dragPreview.value.provId === prov.id) return dragPreview.value.points;
  const pts = toRaw(prov).points;          // raw 对象上取到的是原始数组，不再创建代理
  return Array.isArray(pts) ? pts : (pts || []);
}

/** 原始省份对象（供绘制期读取 id/颜色等标量字段，同样避免代理陷阱） */
function rawProvOf(prov) {
  return toRaw(prov);
}

/**
 * 环的渲染顶点。
 * · **网格派生的环**（`fromGrid`，由归属格轮廓重算出来的）→ Chaikin 平滑，消掉格点台阶
 *   （这正是「马赛克 / 台阶边」的收敛点；网格只作为中间层，落库的是平滑后的折线）。
 * · **手绘 / 描点 / 带贝塞尔控制点的环** → 原样（顶点是用户刻意摆的，平滑会削掉有意的形状）。
 */
function ringPointsForRender(ring) {
  if (!ring || !Array.isArray(ring.points)) return null;
  if (!ring.fromGrid) return ring.points;
  // 手工加过贝塞尔控制点的环一律原样（用户刻意摆的曲率，平滑会削掉）
  for (const q of ring.points) if (q && (q.controlOut || q.controlIn)) return ring.points;
  return smoothRing(ring.points, 2);
}

/**
 * 描一个省份的**所有环**的路径（多环实体 = 主环 + 洞 / 飞地；顺序无关）。
 * 用 evenodd 填充口径与命中判定 `pointInProvince` 完全一致 —— 洞真的会空、飞地真的会画。
 * @returns {boolean} 是否描出了至少一个环
 */
function traceProvincePath(c, prov) {
  const rings = provinceRings(prov);
  let any = false;
  for (const r of rings) {
    const pts = ringPointsForRender(r);
    if (!pts || pts.length < 3) continue;
    traceShapePath(c, pts, true);
    any = true;
  }
  return any;
}

/** 活动环的顶点（顶点编辑作用于「活动环」；多环省份可在属性面板切换环） */
const activeRingIdx = ref(0);
function ringPointsOf(prov, idx = activeRingIdx.value) {
  const rings = provinceRings(prov);
  const r = rings[idx] || rings[0];
  return r ? r.points : null;
}

/** 把「活动环」的新顶点写回省份（主环 → points；额外环 → extraRings[i-1]），返回可 merge 的补丁 */
function writeRingPoints(prov, idx, points) {
  const rings = provinceRings(prov).map((r) => ({ points: r.points, kind: r.kind, fromGrid: r.fromGrid }));
  if (!rings.length) return null;
  // 与 ringPointsOf 同口径：越界一律落到主环（否则手柄画在环 0、写回却被丢弃 = 静默 no-op）
  const i = idx >= 0 && idx < rings.length ? idx : 0;
  rings[i] = { ...rings[i], points };   // 形状被手工改过 → 不再是网格派生的，去掉 fromGrid
  const patch = shapePatch(rings);
  // fromGrid 显式给出：手工改过的环不再算「网格派生」→ 渲染端不再对它做平滑
  return { kind: patch.kind || 'land', points: patch.points, extraRings: patch.extraRings, fromGrid: !!patch.fromGrid };
}

/** 省份的全部环的顶点数组（去响应式）——多环感知的度量 / 小地图 都走它 */
function rawRingPointsList(prov) {
  const rp = toRaw(prov);
  return provinceRings(rp).map((r) => toRaw(r.points)).filter((pts) => Array.isArray(pts) && pts.length);
}

/** 选中省份始终指向 store 中的最新对象（updateBaseProvince 会生成新对象） */
function currentProvince() {
  const sp = selectedProvince.value;
  if (!sp) return null;
  return baseMap.value?.terrain?.find(p => p.id === sp.id) || sp;
}

// ═══════════════════════════════════════════
// 坐标转换
// ═══════════════════════════════════════════
function screenToWorld(sx, sy) {
  return {
    x: (sx - cameraX.value) / cameraScale.value,
    y: (sy - cameraY.value) / cameraScale.value,
  };
}

// ═══════════════════════════════════════════
// Pan & Zoom
// ═══════════════════════════════════════════
let isPanning = false;
let panStart = { x: 0, y: 0 };

// ═══════════════════════════════════════════
// Phase 3：省份「归属标签网格」（笔刷 / 套索 / 自动省界）
//   数据 = store.provinceEditing（按 baseMaps[key] 走 undo）；本处只做交互与渲染。
// ═══════════════════════════════════════════
const provinceTargets = computed(() => baseMap.value?.terrain || []);

/** 当前视口的世界矩形（用于网格裁剪；屏幕坐标 = 相机变换，见 screenToWorld） */
function viewWorldRect() {
  const cvs = canvas.value;
  if (!cvs) return null;
  const a = screenToWorld(0, 0);
  const b = screenToWorld(cvs.clientWidth, cvs.clientHeight);
  return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
}

function provinceMeshColorOf(idx) {
  const prov = baseMap.value?.terrain?.[idx - 1];
  if (!prov) return null;
  return getProvinceColor(prov);      // 与多边形渲染同一套取色（势力染色在网格视图下依然生效）
}

// 🔴 省份网格是懒建的，`store.getProvinceGrid()` **不是响应式**（模块内普通缓存 Map）：
//    网格「刚就绪 / 被重建 / 换底图失效」都必须显式 +1，否则 provinceMeshOn 会一直缓存 false。
const provinceGridRev = ref(0);
let provinceGridTimer = null;

/**
 * 异步准备省份网格（幂等）。
 * 为什么不能同步：21 省 25930 点现场栅格化实测 170~368ms（P-0），同步做就是「一开省份工具就卡」。
 * 期间 provinceMeshOn 为 false → 画布照常画多边形，绝不留白。
 */
function scheduleProvinceGrid() {
  const key = baseMapKey.value;
  if (!key) return;
  if (store.getProvinceGrid(key)) { provinceGridReady.value = true; provinceGridRev.value++; return; }
  if (provinceGridTimer) return;
  statusMsg('正在准备省份网格…');
  provinceGridTimer = setTimeout(() => {
    provinceGridTimer = null;
    const t0 = performance.now();
    store.ensureProvinceGrid(baseMapKey.value);
    provinceGridReady.value = !!store.getProvinceGrid(baseMapKey.value);
    provinceGridRev.value++;
    if (provinceGridReady.value) {
      statusMsg(`省份网格已就绪（${Math.round(performance.now() - t0)}ms）——涂抹抬手时省界自动重算`);
    }
    render();
  }, 0);
}

/**
 * 省份网格是否可用（有省份 + 网格已就绪）。
 * ⚠️ 它**不再决定主渲染路径**（渲染永远是多边形）—— 只用于「涂抹即时反馈」与提示。
 * `provinceGridRev` 是必需的：`store.getProvinceGrid()` 是模块内普通缓存（非响应式），
 * 网格「刚就绪 / 被重建 / 换底图失效」都必须显式 +1，否则这个计算属性会一直缓存旧值。
 */
const provinceMeshOn = computed(() => {
  provinceGridRev.value;
  return !!baseMap.value?.terrain && !!store.getProvinceGrid(baseMapKey.value);
});

function drawProvinceMesh(c) {
  const entry = store.getProvinceGrid(baseMapKey.value);
  if (!entry) return;
  provinceBrush.drawProvinceGrid(c, {
    key: baseMapKey.value,
    labels: entry.labels,
    grid: entry.grid,
    zoom: cameraScale.value,
    colorOf: provinceMeshColorOf,
    viewRect: viewWorldRect(),
    fast: provStrokeActive,
  });
}

function provinceBrushOpts() {
  return {
    radius: provBrushRadius.value,
    strength: provBrushStrength.value,
    tool: provBrushTool.value,
    target: provBrushTarget.value,
  };
}

/** 笔刷预览圈（格数 × 格宽 → 世界半径）+ 套索轨迹（世界坐标，ctx 已带相机变换） */
function drawProvinceBrushOverlay(c) {
  const entry = store.getProvinceGrid(baseMapKey.value);
  const cell = entry ? entry.grid.cell : 0;
  const p = provBrushPreview.value;
  if (p && tool.value === 'provinceBrush' && cell > 0) {
    c.save();
    c.strokeStyle = 'rgba(255,255,255,0.7)';
    c.lineWidth = px(1.2);
    c.beginPath();
    c.arc(p.x, p.y, provBrushRadius.value * cell, 0, Math.PI * 2);
    c.stroke();
    c.restore();
  }
  const pts = provLassoPoints.value;
  if (pts && pts.length > 1) {
    c.save();
    c.setLineDash([px(5), px(4)]);
    c.strokeStyle = '#c4b5fd';
    c.lineWidth = px(1.6);
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.beginPath();
    // 平滑轨迹（中点二次曲线）：手绘一圈就应该是曲线，逐点 lineTo 会读成「描点连线」
    tracePath(c, pts, !provLassoActive);
    c.stroke();
    if (!provLassoActive) { c.fillStyle = 'rgba(196,181,253,.18)'; c.fill(); }
    c.setLineDash([]);
    c.restore();
  }
}

function statusMsg(text) {
  provinceHint.value = text;   // 省份网格操作提示（状态栏，与其它工具的 draw-hint 并列）
}

// ── 底图懒建（Phase 3 收尾）─────────────────────────────────────────────
// 项目里一张底图都没有时，**在第一次真正落笔前**建一张空底图，避免「点了没反应」。
// ⚠️ 名字绝不借用任何真实剧本名（曾硬编码「德斯特星」= 拿暮雨自用剧本当示例，已移除）。
const CREATES_CONTENT_TOOLS = new Set([
  'draw', 'height', 'biome', 'culture', 'religion', 'burg', 'river', 'relief',
  'label', 'marker', 'road', 'provinceBrush', 'provinceLasso', 'provinceFill',
]);

/** 依赖「省份归属网格」的工具（落笔前要确保网格就位；也是 tools 图层/提示的判定依据） */
const PROVINCE_GRID_TOOLS = new Set(['provinceBrush', 'provinceLasso', 'provinceFill']);

/** 空底图命名：底图 1 / 底图 2 …（避开已有名字） */
function nextBaseMapName() {
  const used = new Set(availableBaseMaps.value.map(b => b.id));
  let i = 1;
  while (used.has(`底图 ${i}`)) i += 1;
  return `底图 ${i}`;
}

/**
 * 确保有一张可写的底图。返回 false = 现在不能写 → 调用方必须直接 return（不落笔）。
 * - 已有可用底图：直接用
 * - 项目里有底图但当前键失效：切到第一张
 * - 一张都没有：懒建空底图（只读态则拒绝并说明去处）
 */
function ensureBaseMap() {
  if (baseMapKey.value && store.baseMaps?.[baseMapKey.value]) return true;
  const first = availableBaseMaps.value[0]?.id;
  if (first) { baseMapKey.value = first; return true; }
  if (store.isReadOnly) {
    statusMsg(`编辑已停用：${store.readOnlyReason}（在上面新建/打开项目后即可编辑）`);
    return false;
  }
  const name = nextBaseMapName();
  store.addBaseMap(name, { name });
  if (!store.baseMaps?.[name]) { statusMsg('无法新建底图：请先用工具栏「+」导入 .map 底图'); return false; }
  baseMapKey.value = name;
  statusMsg(`项目里还没有底图：已新建空底图「${name}」（可用工具栏「+」导入 .map 覆盖）`);
  return true;
}

function addGridProvince() {
  if (store.isReadOnly) { statusMsg(`新建省份已停用：${store.readOnlyReason}`); return; }
  const res = store.addBrushProvince(baseMapKey.value, {});
  if (!res || res.blocked) { statusMsg((res && res.message) || '新建省份失败'); return; }
  provBrushTarget.value = res.idx;
  scheduleProvinceGrid();
  provinceBrush.invalidateBorders();
  statusMsg(`已新建「${res.name}」——按住涂抹即可给它划地（省界自动提取）`);
  render();
}

function clearGridOwnership() {
  if (store.isReadOnly) { statusMsg(`清空归属已停用：${store.readOnlyReason}`); return; }
  const res = store.clearProvinceLabels(baseMapKey.value);
  if (!res || res.blocked) { statusMsg((res && res.message) || '清空归属失败'); return; }
  provinceBrush.invalidateBorders();
  statusMsg(`已清空归属（${res.cleared} 格归无主）——现在可以重新切分省份`);
  render();
}

function onMouseDown(event) {
  if (event.button === 2) return; // 右键留给 context menu
  initialFitPending = false;      // 用户开始操作 → 不再自动抢镜头（见 onMounted 的适屏收尾）

  // 写类工具先确保有底图：项目里一张都没有时懒建一张（否则用户会「点了没反应」）
  if (CREATES_CONTENT_TOOLS.has(tool.value) && !ensureBaseMap()) return;

  // Phase 3：省份网格 —— 笔刷落笔 / 套索起笔 / 点击填充
  if (PROVINCE_GRID_TOOLS.has(tool.value) && event.button === 0) {
    // 只读态（未打开项目）：编辑入口不灰禁，但**不得产生任何改动** —— 直接说明原因与去处
    if (store.isReadOnly) {
      statusMsg(`省份编辑已停用：${store.readOnlyReason}`);
      return;
    }
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    store.ensureProvinceGrid(baseMapKey.value);
    if (!provinceTargets.value.length) {
      statusMsg('还没有省份：先点工具栏「新建省份」，再涂抹划地（省界会自动提取）');
      return;
    }
    if (tool.value === 'provinceFill') {
      const res = store.fillProvinceRegion(baseMapKey.value, { x: world.x, y: world.y }, provBrushTarget.value);
      if (res && res.blocked) statusMsg(res.message);
      else if (res && res.rejected) statusMsg(res.message || '点击填充被拒绝');
      else if (res && res.changed) {
        provinceBrush.invalidateBorders();
        statusMsg(`点击填充：${res.cells} 格归「${provinceTargets.value[provBrushTarget.value - 1]?.name || ''}」`
          + '（一次点击 = 1 条撤销；省界已重算）');
      } else statusMsg((res && res.message) || '这一块没有可填充的格子');
      render();
      return;
    }
    if (tool.value === 'provinceBrush') {
      provStrokeActive = true;
      store.beginProvinceStroke();
      store.applyProvinceStroke(baseMapKey.value, { x: world.x, y: world.y, ...provinceBrushOpts() });
      provinceBrush.invalidateBorders();
    } else {
      provLassoActive = true;
      provLassoPoints.value = [world];
    }
    render();
    return;
  }

  // 「绘制」工具：按住拖动 = 自由绘制（原型 v7 的手感）。轨迹太短（其实只是单击）则不接管，
  // 仍由 onClick 的描点分支落一个顶点 —— 两条路径并存，能力不减。
  if (tool.value === 'draw' && event.button === 0) {
    if (store.isReadOnly) {
      statusMsg(`绘制已停用：${store.readOnlyReason}（新建/打开项目后即可编辑）`);
      return;
    }
    // 上一笔成型后若「那次 click 没送到」（松手点落在画布外），这里顺手清掉残留标记，
    // 免得下一次单击描点被静默吞掉（click 必定先于下一次 mousedown）
    suppressDrawClick = false;
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    freeTrace = [world];
    freeTraceActive = true;
    render();
    return;
  }

  // 笔刷工具：左键抬高 / 右键降低
  if (tool.value === 'height' && (event.button === 0 || event.button === 2)) {
    isBrushing = true;
    brushMode = event.button === 0 ? 'raise' : 'lower';
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    store.applyHeightBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushStrength.value, brushMode);
    return;
  }
  if (tool.value === 'biome' && event.button === 0) {
    isBrushing = true;
    brushMode = 'biome';
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    store.applyBiomeBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushBiome.value);
    return;
  }
  if (tool.value === 'culture' && event.button === 0) {
    isBrushing = true;
    brushMode = 'culture';
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    store.applyCultureBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushCulture.value);
    return;
  }
  if (tool.value === 'religion' && event.button === 0) {
    isBrushing = true;
    brushMode = 'religion';
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    store.applyReligionBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushReligion.value);
    return;
  }
  // marker 和 road 在 onCanvasClick 处理

  if (event.button === 0 && (tool.value === 'select' || tool.value === 'vertex')) {
    // 顶点编辑模式：先判切线手柄，再判顶点
    if (tool.value === 'vertex' && selectedProvince.value) {
      const rect = canvas.value.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      const world = screenToWorld(sx, sy);
      const prov = currentProvince();
      const threshold = px(8);
      const points = prov && provinceRings(prov).length ? resolvePoints(prov) : null;
      if (points) {
        // P0-T1：切线手柄命中（仅当前选中顶点）
        const ai = activeVertexIdx.value;
        if (ai >= 0 && ai < points.length && !altStraight) {
          const ap = points[ai];
          const hR = px(10);
          const out = ap.controlOut;
          const inn = ap.controlIn;
          if (out && Math.hypot(vx(ap) + out.x - world.x, vy(ap) + out.y - world.y) < hR) {
            draggingHandle.value = { provId: prov.id, vertexIdx: ai, which: 'out' };
            canvas.value.style.cursor = 'crosshair';
            return;
          }
          if (inn && Math.hypot(vx(ap) + inn.x - world.x, vy(ap) + inn.y - world.y) < hR) {
            draggingHandle.value = { provId: prov.id, vertexIdx: ai, which: 'in' };
            canvas.value.style.cursor = 'crosshair';
            return;
          }
        }
        for (let i = 0; i < points.length; i++) {
          const p = points[i];
          const dx = vx(p) - world.x;
          const dy = vy(p) - world.y;
          if (Math.sqrt(dx * dx + dy * dy) < threshold) {
            draggingVertex.value = { provId: prov.id, vertexIdx: i };
            activeVertexIdx.value = i;
            // 旧数据没有控制点：首次选中顶点时自动生成平滑切线（走 undo 栈）
            if (!p.controlIn && !p.controlOut) {
              store.updateBaseProvince(baseMapKey.value, prov.id, writeRingPoints(
                prov, activeRingIdx.value,
                withBezierControls(resolvePoints(prov).map(q => ({ x: vx(q), y: vy(q) }))),
              ));
              showSnapFeedback('已生成贝塞尔切线');
            }
            render();
            canvas.value.style.cursor = 'grabbing';
            return;
          }
        }
      }
    }
    isPanning = true;
    panStart = { x: event.clientX, y: event.clientY };
    canvas.value.style.cursor = 'grabbing';
  }
}

function onMouseMove(event) {
  // 「绘制」工具的自由绘制采样：按**屏幕像素**间距取样（世界单位随缩放差几十倍，
  // 用世界阈值会在大缩放时采得过密、小缩放时采得过疏）
  if (freeTraceActive && tool.value === 'draw') {
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    const last = freeTrace[freeTrace.length - 1];
    if (!last || Math.hypot(world.x - last.x, world.y - last.y) > px(2)) {
      freeTrace.push(world);
      render();
    }
    return;
  }

  // Phase 3：省份笔刷涂抹 / 套索描轨迹
  if (PROVINCE_GRID_TOOLS.has(tool.value)) {
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    provBrushPreview.value = { x: world.x, y: world.y };
    if (provStrokeActive) {
      store.applyProvinceStroke(baseMapKey.value, { x: world.x, y: world.y, ...provinceBrushOpts() });
      provinceBrush.invalidateBorders();
    } else if (provLassoActive) {
      const last = provLassoPoints.value[provLassoPoints.value.length - 1];
      if (!last || Math.hypot(world.x - last.x, world.y - last.y) > 1e-6) provLassoPoints.value.push(world);
    }
    render();
    return;
  }

  // 笔刷预览更新
  if (['height', 'biome', 'culture', 'religion'].includes(tool.value)) {
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    brushPreview.value = { x: world.x, y: world.y, radius: brushRadius.value };

    // 拖动中应用笔刷
    if (isBrushing) {
      if (tool.value === 'height') {
        store.applyHeightBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushStrength.value, brushMode);
      } else if (tool.value === 'biome') {
        store.applyBiomeBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushBiome.value);
      } else if (tool.value === 'culture') {
        store.applyCultureBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushCulture.value);
      } else if (tool.value === 'religion') {
        store.applyReligionBrush(baseMapKey.value, world.x, world.y, brushRadius.value, brushReligion.value);
      }
    }
    render();
    return;
  }

  if (tool.value === 'road' && roadStart.value) {
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    // 实时预览：从 roadStart 到当前鼠标的直线（松开时计算实际路径）
    roadPath.value = [roadStart.value, world];
    render();
    return;
  }

  if (tool.value === 'burg') {
    const rect = canvas.value.getBoundingClientRect();
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    placeSmartBurg(world);
    render();
    return;
  }

  if (draggingHandle.value) {
    const rect = canvas.value.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const world = screenToWorld(sx, sy);
    const { provId, vertexIdx, which } = draggingHandle.value;
    const prov = baseMap.value?.terrain?.find(p => p.id === provId);
    if (prov && prov.points && prov.points[vertexIdx]) {
      const src = resolvePoints(prov);
      const target = src[vertexIdx];
      // 切线偏移 = 光标 - 顶点；对称约束（拖一端，另一端镜像）
      const off = { x: world.x - vx(target), y: world.y - vy(target) };
      dragPreview.value = {
        provId,
        points: src.map((p, i) => {
          const base = { x: vx(p), y: vy(p) };
          if (i !== vertexIdx) {
            return p.controlIn || p.controlOut
              ? { x: base.x, y: base.y, controlIn: p.controlIn, controlOut: p.controlOut }
              : base;
          }
          return which === 'out'
            ? { x: base.x, y: base.y, controlOut: off, controlIn: { x: -off.x, y: -off.y } }
            : { x: base.x, y: base.y, controlIn: off, controlOut: { x: -off.x, y: -off.y } };
        }),
      };
      render();
    }
    return;
  }
  if (draggingVertex.value) {
    const rect = canvas.value.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const world = screenToWorld(sx, sy);
    const { provId, vertexIdx } = draggingVertex.value;
    const prov = baseMap.value?.terrain?.find(p => p.id === provId);
    if (prov && prov.points && prov.points[vertexIdx]) {
      // 顶点编辑拖拽同样吸附（边界 > 网格；Shift 禁用）
      const snapped = resolveSnapPoint(world, event.shiftKey);
      if (snapped.snapped) setSnapMarker(snapped.x, snapped.y, snapped.kind);
      // 只更新临时预览，不写 store（拖拽结束再一次性提交，保证 undo 可回滚）
      dragPreview.value = {
        provId,
        points: resolvePoints(prov).map((p, i) => {
          if (i !== vertexIdx) return p;
          const next = { x: snapped.x, y: snapped.y };
          if (p.controlIn) next.controlIn = p.controlIn;
          if (p.controlOut) next.controlOut = p.controlOut;
          return next;
        }),
      };
      render();
    }
    return;
  }
  if (!isPanning) {
    updateBurgHover(event);
    // 绘制模式下实时预览吸附点（只在命中变化时重绘）
    if (tool.value === 'draw' && snapToEdgeEnabled.value && !event.shiftKey) {
      const rect = canvas.value.getBoundingClientRect();
      const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
      const e = snapToEdge(world);
      const cur = snapMarker.value;
      const changed = !!e !== !!cur || (e && cur && (e.x !== cur.x || e.y !== cur.y || cur.kind !== 'edge'));
      if (changed) {
        if (e) setSnapMarker(e.x, e.y, 'edge');
        else { snapMarker.value = null; }
        render();
      }
    }
    return;
  }
  const dx = event.clientX - panStart.x;
  const dy = event.clientY - panStart.y;
  cameraX.value += dx;
  cameraY.value += dy;
  panStart = { x: event.clientX, y: event.clientY };
  render();
}

function onMouseUp(event) {
  if (freeTraceActive) {
    freeTraceActive = false;
    const pts = freeTrace || [];
    freeTrace = null;
    // 够长才算「一笔成型」；否则让随后的 click 走描点分支（落一个顶点）
    if (pts.length >= FREE_TRACE_MIN_POINTS) {
      suppressDrawClick = true;
      if (!commitFreeTrace(pts, !!(event && event.shiftKey))) suppressDrawClick = false;
    }
    render();
  }
  if (provStrokeActive) {
    provStrokeActive = false;
    const label = provBrushTool.value === 'erase' ? '省份笔刷抹除'
      : (provBrushTool.value === 'smooth' ? '省份笔刷平滑' : '省份笔刷划归');
    const res = store.endProvinceStroke(label);
    provinceBrush.invalidateBorders();
    if (res) statusMsg(`${res.label}：改 ${res.changed} 格 · 整笔 = 1 条撤销`);
    render();
  }
  if (provLassoActive) {
    provLassoActive = false;
    const poly = provLassoPoints.value;
    provLassoPoints.value = [];
    const res = store.applyProvinceLasso(baseMapKey.value, poly, provBrushTarget.value);
    provinceBrush.invalidateBorders();
    if (res && res.changed) statusMsg(`自由轮廓：圈入 ${res.changed} 格 → 整批划归（一笔成形，没有描点）`);
    else statusMsg('自由轮廓：圈内没有格子（或已全部属于该省份）');
    render();
  }
  if (isPanning) {
    isPanning = false;
    updateCursor();
  }
  if (isBrushing) {
    isBrushing = false;
  }
  if (draggingHandle.value) {
    const { provId } = draggingHandle.value;
    const preview = dragPreview.value;
    draggingHandle.value = null;
    dragPreview.value = null;
    if (preview && preview.provId === provId) {
      const prov = baseMap.value?.terrain?.find(p => p.id === provId);
      const patch = prov ? writeRingPoints(prov, activeRingIdx.value, preview.points) : null;
      if (patch) store.updateBaseProvince(baseMapKey.value, provId, patch);
    }
    render();
    updateCursor();
    return;
  }
  if (draggingVertex.value) {
    const { provId } = draggingVertex.value;
    const preview = dragPreview.value;
    draggingVertex.value = null;
    dragPreview.value = null;
    clearSnapMarker();
    // 拖拽结束后一次性写入 store：redo 写坐标、undo 回滚到拖拽前
    if (preview && preview.provId === provId) {
      const prov = baseMap.value?.terrain?.find(p => p.id === provId);
      const patch = prov ? writeRingPoints(prov, activeRingIdx.value, preview.points) : null;
      if (patch) store.updateBaseProvince(baseMapKey.value, provId, patch);
    }
    render();
    updateCursor();
  }
}

function onCanvasMouseLeave() {
  onMouseUp();
  if (hoveredBurg.value) {
    hoveredBurg.value = null;
    render();
  }
  if (brushPreview.value) {
    brushPreview.value = null;
    render();
  }
}

function onWheel(event) {
  initialFitPending = false;         // 用户开始操作 → 不再自动抢镜头
  // 笔刷工具下：滚轮调半径，Shift+滚轮调强度
  if (tool.value === 'height' || tool.value === 'biome') {
    event.preventDefault();
    const delta = event.deltaY < 0 ? 1 : -1;
    if (event.shiftKey && tool.value === 'height') {
      brushStrength.value = Math.max(0.5, Math.min(10, brushStrength.value + delta * 0.5));
    } else {
      brushRadius.value = Math.max(20, Math.min(300, brushRadius.value + delta * 10));
    }
    return;
  }
  event.preventDefault();
  const rect = canvas.value.getBoundingClientRect();
  const mx = event.clientX - rect.left;
  const my = event.clientY - rect.top;
  const worldBefore = screenToWorld(mx, my);
  const zoomFactor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
  cameraScale.value = Math.max(0.1, Math.min(50, cameraScale.value * zoomFactor));
  const worldAfter = screenToWorld(mx, my);
  cameraX.value += (worldAfter.x - worldBefore.x) * cameraScale.value;
  cameraY.value += (worldAfter.y - worldBefore.y) * cameraScale.value;
  render();
}

function fitToView() {
  if (!baseMap.value?.terrain?.length) return;
  const terrain = baseMap.value.terrain;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const prov of terrain) {
    if (!prov.points) continue;
    for (const p of prov.points) {
      const px = p.x || p[0] || 0;
      const py = p.y || p[1] || 0;
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
  }
  if (!isFinite(minX)) return;
  const w = canvasWrap.value.clientWidth;
  const h = canvasWrap.value.clientHeight;
  const padding = 40;
  const bw = maxX - minX || 1;
  const bh = maxY - minY || 1;
  // 🔴 scale 必须夹到正数：窗口很小时 (w - padding*2) 或 (h - padding*2) 会是负数
  //    → 之前会算出**负 cameraScale**，而 `3 / cameraScale` 这类绘制半径立刻变成负数，
  //      Canvas 抛 IndexSizeError，整个 render 管线崩掉（2026-09-20 实测：历史剧本打开的
  //      小窗口下必崩，并且抛错在渲染路径里会把后续交互一起拖死）。
  //    下限取 0.02（约 1 世界单位 = 0.02px），宁可视口偏远也不允许 ≤0。
  const rawScale = Math.min((w - padding * 2) / bw, (h - padding * 2) / bh);
  cameraScale.value = Math.max(0.02, rawScale || 0.02);
  cameraX.value = padding + (w - padding * 2 - bw * cameraScale.value) / 2 - minX * cameraScale.value;
  cameraY.value = padding + (h - padding * 2 - bh * cameraScale.value) / 2 - minY * cameraScale.value;
  render();
}

// ═══════════════════════════════════════════
// 鼠标交互
// ═══════════════════════════════════════════
function onCanvasClick(event) {
  if (event.button === 2) {
    // 右键菜单
    const rect = canvas.value.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const world = screenToWorld(sx, sy);
    const prov = findProvinceAt(world.x, world.y);
    if (prov) {
      selectedProvince.value = prov;
      contextMenu.value = { show: true, x: event.clientX - rect.left, y: event.clientY - rect.top, provId: prov.id };
    }
    return;
  }
  
  const rect = canvas.value.getBoundingClientRect();
  const sx = event.clientX - rect.left;
  const sy = event.clientY - rect.top;
  const world = screenToWorld(sx, sy);

  if (tool.value === 'erase') {
    const prov = findProvinceAt(world.x, world.y);
    if (prov && confirm(`确定删除省份「${prov.name}」？`)) {
      store.removeBaseProvince(baseMapKey.value, prov.id);
      render();
    }
    return;
  }

  if (tool.value === 'vertex') {
    // 选中省份（顶点/手柄命中已在 mousedown 处理）
    const prov = findProvinceAt(world.x, world.y);
    if (prov) {
      if (selectedProvince.value?.id !== prov.id) { activeVertexIdx.value = -1; activeRingIdx.value = 0; }
      selectedProvince.value = prov;
      showProps.value = true;
    }
    render();
    return;
  }

  if (tool.value === 'draw') {
    // 自由绘制刚一笔成型（见 onMouseUp）→ 紧随的 click 不再落顶点
    if (suppressDrawClick) { suppressDrawClick = false; return; }
    // 绘制顶点吸附：P0-T2 省份边界 > P0-T3 网格；Shift 临时禁用（验收：阈劀10px）
    const snapped = resolveSnapPoint(world, event.shiftKey);
    drawPoints.value = [...drawPoints.value, { x: snapped.x, y: snapped.y }];
    if (snapped.snapped) {
      setSnapMarker(snapped.x, snapped.y, snapped.kind);
      clearSnapMarker(600);
      showSnapFeedback(snapped.kind === 'edge' ? '吸附到边界' : '吸附到网格');
    }
    render();
    return;
  }

  if (tool.value === 'split') {
    handleSplitClick(world, event.shiftKey);
    return;
  }

  if (tool.value === 'merge') {
    handleMergeClick(world);
    return;
  }

  // 选择模式：城镇点击优先（标记支持选中，为后续编辑预留），否则选中省份
  if (tool.value === 'select') {
    const burg = showBurgs.value ? findBurgAt(sx, sy) : null;
    selectedBurg.value = burg;
    if (burg) {
      openBurgEditor(burg);
    } else {
      const prov = findProvinceAt(world.x, world.y);
      selectedProvince.value = prov;
      showProps.value = !!prov;
    }
    render();
    return;
  }

  if (viewMode.value !== 'scenario' || !selectedScenario.value) return;

  if (tool.value === 'paint' && selectedPolity.value) {
    const prov = findProvinceAt(world.x, world.y);
    if (prov && prov.kind === 'sea') {
      // P4：海域不进剧本归属 —— 时间轴 / 谱系都不该出现一片海
      statusMsg('这是海域（kind=sea）：海域不参与势力归属 —— 要不要先在右侧属性面板把它改成陆地？');
      render();
      return;
    }
    if (prov) {
      // 把时间轴当前年份一并记为**显式易主年份** ——
      // 「拖到某年再上色 = 该年易主」，这是 changeYear 最自然的录入路径
      store.setOwnership(selectedScenario.value.id, prov.id, selectedPolity.value.id, Math.round(tlYear.value));
      render();
    }
  } else if (tool.value === 'label') {
    const text = prompt('输入地名：');
    if (text) {
      const preset = LABEL_PRESETS.find(p => p.id === selectedLabelPreset.value) || LABEL_PRESETS[0];
      store.addScenarioLabel(selectedScenario.value.id, {
        x: world.x,
        y: world.y,
        text,
        font: preset.font,
        color: preset.color,
        stroke: preset.stroke,
        strokeWidth: preset.strokeWidth,
        preset: preset.id,
      });
      render();
    }
  } else if (tool.value === 'marker') {
    // 点击放置标记（P1-T5 标记类型系统）
    if (viewMode.value === 'scenario' && selectedScenario.value) {
      const name = prompt('标记名称：');
      if (name) {
        const typeDef = MARKER_TYPES.find(t => t.id === selectedMarkerType.value) || MARKER_TYPES[0];
        store.addScenarioMarker(selectedScenario.value.id, {
          x: world.x,
          y: world.y,
          name,
          type: selectedMarkerType.value,
          icon: typeDef.icon,
          color: typeDef.color,
        });
        render();
      }
    } else {
      alert('请先在剧本模式下使用标记工具');
    }
  } else if (tool.value === 'relief') {
    // Relief 图标放置（P1-T1）
    const iconDef = RELIEF_ICONS.find(i => i.id === selectedReliefIcon.value);
    if (iconDef) {
      reliefIcons.value.push({
        id: `relief_${Date.now()}`,
        iconId: iconDef.id,
        x: world.x,
        y: world.y,
        icon: iconDef.icon,
        color: iconDef.color,
      });
      render();
    }
  } else if (tool.value === 'river') {
    // 河流编辑器（P1-T2 手动绘制河流路径）
    riverDraft.value.push({ x: world.x, y: world.y });
    render();
  } else if (tool.value === 'road') {
    if (!roadStart.value) {
      roadStart.value = world;
      roadPath.value = [world];
    } else {
      // 两点完成道路：用 generateRoadPath 算实际路径
      const baseMapData = baseMap.value;
      if (baseMapData?.heightmap?.grid?.points) {
        const hm = baseMapData.heightmap;
        const pts = hm.grid.points;
        const spacing = hm.grid.spacing || 14.4;
        // 找最近网格点作为起终点
        let startIdx = -1, startDist = Infinity;
        let endIdx = -1, endDist = Infinity;
        for (let i = 0; i < pts.length; i++) {
          const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
          const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
          const sd = Math.hypot(px - roadStart.value.x, py - roadStart.value.y);
          if (sd < startDist) { startDist = sd; startIdx = i; }
          const ed = Math.hypot(px - world.x, py - world.y);
          if (ed < endDist) { endDist = ed; endIdx = i; }
        }
        if (startIdx >= 0 && endIdx >= 0 && startIdx !== endIdx) {
          const path = generateRoadPath(hm.h, hm.grid, startIdx, endIdx);
          if (path.length > 0) {
            const roadPoints = path.map(i => ({ x: pts[i][0], y: pts[i][1] }));
            const style = ROAD_STYLES.find(s => s.id === selectedRoadStyle.value) || ROAD_STYLES[1];
            const newRoute = {
              id: `road_${Date.now()}`,
              group: 'roads',
              name: `道路 ${Date.now()}`,
              points: roadPoints,
              style: style.id,
              width: style.width,
              dash: style.dash,
              color: style.color,
            };
            if (!baseMapData.routes) baseMapData.routes = [];
            baseMapData.routes.push(newRoute);
            store.baseMaps = {
              ...store.baseMaps,
              [baseMapKey.value]: {
                ...baseMapData,
                routes: [...baseMapData.routes],
                updatedAt: new Date().toISOString(),
              },
            };
          }
        }
      }
      roadStart.value = null;
      roadPath.value = [];
      render();
    }
  }
}

function onCanvasDblClick(event) {
  if (tool.value === 'draw' && drawPoints.value.length >= 3) {
    finishDraw();
  }
  if (tool.value === 'river' && riverDraft.value.length >= 2) {
    finishRiverDraft();
  }
}

function onKeyDown(event) {
  if (event.key === 'Escape') {
    drawPoints.value = [];
    splitStep.value = 0;
    splitPoints.value = [];
    mergeStep.value = 0;
    mergeProvId.value = null;
    contextMenu.value.show = false;
    selectedBurg.value = null;
    dragPreview.value = null;
    draggingHandle.value = null;
    activeVertexIdx.value = -1;
    clearSnapMarker();
    render();
  }
  // P0-T1：Alt 临时直线段（按下即重绘，松开恢复曲线）
  if (event.key === 'Alt' && !altStraight) {
    altStraight = true;
    event.preventDefault();
    render();
  }
  if (event.key === 'Enter' && tool.value === 'draw' && drawPoints.value.length >= 3) {
    finishDraw();
  }
  if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;
  if (event.key === 'v' || event.key === 'V') setTool('select');
  else if (event.key === 'b' || event.key === 'B') setTool('draw');
  else if (event.key === 'g' || event.key === 'G') setTool('vertex');
  else if (event.key === 'x' || event.key === 'X') setTool('split');
  else if (event.key === 'm' || event.key === 'M') setTool('merge');
  else if (event.key === 'p' || event.key === 'P') setTool('paint');
  else if (event.key === 'q' || event.key === 'Q') setTool('provinceBrush');
  else if (event.key === 'l' || event.key === 'L') setTool('provinceLasso');
  else if (event.key === 'o' || event.key === 'O') setTool('provinceFill');
  else if (event.key === 't' || event.key === 'T') setTool('label');
  else if (event.key === 'e' || event.key === 'E') setTool('erase');
  else if (event.key === 'h' || event.key === 'H') setTool('height');
  else if (event.key === 'n' || event.key === 'N') setTool('biome');
  else if (event.key === 'u' || event.key === 'U') setTool('burg');
  else if (event.key === 'c' || event.key === 'C') setTool('culture');
  else if (event.key === 'r' || event.key === 'R') setTool('religion');
  else if (event.key === 'k' || event.key === 'K') setTool('marker');
  else if (event.key === 'j' || event.key === 'J') setTool('road');
  else if (event.key === 'w' || event.key === 'W') setTool('river');
  else if (event.key === 'i' || event.key === 'I') setTool('relief');
  else if (event.key === 'f' || event.key === 'F') fitToView();
}

function onKeyUp(event) {
  if (event.key === 'Alt' && altStraight) {
    altStraight = false;
    render();
  }
}

function finishDraw() {
  const id = `prov_${Date.now()}`;
  // ① 先贴**共享边界骨架**（P0 第二块）：相邻省份的轮廓走同一条线 → 零缝。
  //    只吸端点会在两省之间斜切一条缝，`conformToSkeleton` 是「整段插中间顶点」。
  const rawPts = drawPoints.value.map(p => ({ x: p.x, y: p.y }));
  const skeleton = buildSkeleton(baseMap.value?.terrain || []);
  const conformed = skeleton.length ? conformToSkeleton(rawPts, skeleton, SNAP_EDGE_THRESHOLD) : rawPts;
  // ② P0-T1 验收：新绘制省份自动生成平滑贝塞尔曲线（控制点 = 相邻顶点连线的 1/3）
  const points = withBezierControls(conformed);
  const count = baseMap.value?.terrain?.length || 0;
  const name = `新省份 ${count + 1}`;
  const prov = { id, name, kind: 'land', color: nextProvinceColor(count), points };
  store.addBaseProvince(baseMapKey.value, prov);
  focusNewProvince(id, prov);
  drawPoints.value = [];
  render();
}

// ── 「绘制」工具的**按住拖动自由绘制**（原型 v7 的手感）─────────────────────
//
// 用户实测：「绘制功能有退化为早期版本描点连线模拟器的风险，我之前测的手动绘制原型不是
// 已经很好用了吗？……这和原型里流畅的手绘体验完全不一样。」
// 描点（单击加顶点）是必要的精确手段，保留；但**按住拖动**要能像手绘一样一笔成型：
//   按住 → 采样轨迹（屏幕像素间距）→ 松手 → 闭环 RDP 保形简化（utils/regionTrace，
//   与「区域勾轮廓」同一套：旋转到离质心最远点当锚点，容差 = 包围盒 span 的 2%~5%）
//   → 直接落成省份多边形（不做凸包、不栅格化，保原始形状）。
// 两条路径共用同一份省份数据模型（terrain[] 多边形），不新增第二套事实源。
const FREE_TRACE_MIN_POINTS = 10;   // 少于这个采样数 = 用户只是点了一下（交给描点分支）
let freeTrace = null;
let freeTraceActive = false;
let suppressDrawClick = false;      // 一笔成型后紧随的 click 不要再落顶点

/** 新建省份的公共收尾：选中它 + 打开属性面板并把光标放进名字框（P1「名字输入」） */
const provNameInput = ref(null);
function focusNewProvince(id, fallback) {
  const found = (baseMap.value?.terrain || []).find((q) => q.id === id) || fallback;
  if (found) selectedProvince.value = found;
  showProps.value = true;
  nextTick(() => {
    const el = provNameInput.value;
    if (el && typeof el.focus === 'function') { el.focus(); if (el.select) el.select(); }
  });
}

/** 自由绘制轨迹 → 省份（轨迹太短则放弃，仍由描点分支处理） */
function commitFreeTrace(pts, shiftKey) {
  if (!ensureBaseMap()) return false;
  const simplified = simplifyClosedTrace(pts);
  if (!simplified || simplified.length < 3) {
    statusMsg('自由绘制：轨迹太短，没有成型（按住沿轮廓拖一圈再松手）');
    return false;
  }
  const id = `prov_${Date.now()}`;
  const count = baseMap.value?.terrain?.length || 0;
  // 贴共享边界骨架（相邻省零缝）：整段插顶点，而不是只吸端点。
  // **Shift = 旁路吸附**（用户要摆自己的顶点就别动它 —— 与描点路径同一套按键约定）
  const skeleton = shiftKey ? [] : buildSkeleton(baseMap.value?.terrain || []);
  const conformed = skeleton.length
    ? conformToSkeleton(simplified.map(q => ({ x: q.x, y: q.y })), skeleton, SNAP_EDGE_THRESHOLD)
    : simplified;
  const name = `新省份 ${count + 1}`;
  const prov = {
    id,
    name,
    kind: 'land',
    color: nextProvinceColor(count),
    points: withBezierControls(conformed.map(q => ({ x: q.x, y: q.y }))),
  };
  store.addBaseProvince(baseMapKey.value, prov);
  provinceBrush.invalidateBorders();
  focusNewProvince(id, prov);          // 建完即选中 + 名字框待改（P1）
  statusMsg(`已建「${name}」：轨迹 ${pts.length} 点 → 简化 ${simplified.length} 点`
    + (shiftKey ? '（Shift：未吸附骨架）' : `（贴骨架后 ${conformed.length} 点）`)
    + ' —— 右侧可改名，一次绘制 = 1 条撤销');
  return true;
}

function finishRiverDraft() {
  if (riverDraft.value.length >= 2) {
    riverPaths.value.push([...riverDraft.value]);
    riverDraft.value = [];
    render();
  }
}

function handleSplitClick(world, shiftKey) {
  if (splitStep.value === 0) {
    splitPoints.value = [world];
    splitStep.value = 1;
    statusMsg('拆分：再点第二个点定义切割线（按住 Shift = 让另一侧保留原序号）');
    render();
    return;
  }
  const p1 = splitPoints.value[0];
  const p2 = world;
  splitStep.value = 0;
  splitPoints.value = [];
  if (store.isReadOnly) { statusMsg(`拆分已停用：${store.readOnlyReason}`); render(); return; }
  // 目标省份：两点之一落在它里面即可（多环 / 带洞口径由纯函数层统一）
  const target = (baseMap.value?.terrain || []).find(
    (q) => provinceRings(q).length
      && (pointInProvince(p1.x, p1.y, q) || pointInProvince(p2.x, p2.y, q)));
  if (!target) { statusMsg('拆分：两个点要落在同一个省份上'); render(); return; }
  const res = store.splitProvince(baseMapKey.value, target.id, p1, p2, { side: shiftKey ? -1 : 1 });
  if (!res || res.blocked || res.rejected) {
    statusMsg((res && res.message) || '拆分失败：切割线没有穿过这个省份（两点要落在它两侧）');
    render();
    return;
  }
  provinceBrush.invalidateBorders();
  const which = res.side === -1 ? '另一侧' : '起始侧（a）';
  statusMsg(`已把「${target.name}」拆成两块：${which}保留原序号「${target.name}」，`
    + '另一半追加到表尾 — 一次拆分 = 1 条撤销（按住 Shift 可换边）');
  render();
}

function handleMergeClick(world) {
  const prov = findProvinceAt(world.x, world.y);
  if (!prov) { statusMsg('合并：请点中省份'); return; }
  if (mergeStep.value === 0) {
    mergeProvId.value = prov.id;
    mergeStep.value = 1;
    statusMsg(`合并：已选中「${prov.name}」，再点第二个省份`);
    render();
    return;
  }
  if (store.isReadOnly) { statusMsg(`合并已停用：${store.readOnlyReason}`); return; }
  if (mergeProvId.value && mergeProvId.value !== prov.id) {
    const terrain = baseMap.value?.terrain || [];
    const provA = terrain.find(q => q.id === mergeProvId.value);
    // 🔴 合并走**精确并集**（共边抵消；环真的穿过时才退回栅格），不再是凸包 ——
    //    凸包会把两个省之间的凹陷与邻居省份一起吞掉（用户实测「合并吃掉邻居」的根因）。
    const res = store.mergeProvinces(baseMapKey.value, [mergeProvId.value, prov.id], {
      name: `${provA?.name || ''}+${prov.name}`,
    });
    if (res && (res.blocked || res.rejected)) statusMsg(res.message || '合并失败');
    else if (res) {
      provinceBrush.invalidateBorders();
      statusMsg(`已合并（${res.method === 'raster' ? '栅格并集' : '共边抵消'}，${res.loops} 环）`
        + '—— 不会吃掉邻居；一次合并 = 1 条撤销');
    }
  }
  mergeStep.value = 0;
  mergeProvId.value = null;
  render();
}

// ═══════════════════════════════════════════
// 右键菜单
// ═══════════════════════════════════════════
function ctxRenameProvince() {
  const name = prompt('省份名称：', selectedProvince.value?.name);
  if (name && selectedProvince.value) {
    selectedProvince.value.name = name;
    store.updateBaseProvince(baseMapKey.value, selectedProvince.value.id, { name });
    render();
  }
  contextMenu.value.show = false;
}

function ctxChangeBiome() {
  const biomes = Object.keys(BIOME_COLORS);
  const biome = prompt(`生物群系（${biomes.join('/')}）：`, selectedProvince.value?.biome || '');
  if (biome && selectedProvince.value) {
    selectedProvince.value.biome = biome;
    store.updateBaseProvince(baseMapKey.value, selectedProvince.value.id, { biome });
    render();
  }
  contextMenu.value.show = false;
}

function ctxDuplicateProvince() {
  if (!selectedProvince.value) return;
  const prov = selectedProvince.value;
  const offset = px(20);
  const rings = provinceRings(prov).map((r) => ({
    kind: r.kind,
    points: r.points.map(q => ({ x: vx(q) + offset, y: vy(q) + offset })),
  }));
  const id = `prov_${Date.now()}`;
  store.addBaseProvince(baseMapKey.value, {
    id, name: prov.name + ' 副本', ...shapePatch(rings),
    biome: prov.biome, culture: prov.culture,
  });
  render();
  contextMenu.value.show = false;
}

function ctxDeleteProvince() {
  if (selectedProvince.value && confirm(`确定删除省份「${selectedProvince.value.name}」？`)) {
    store.removeBaseProvince(baseMapKey.value, selectedProvince.value.id);
    selectedProvince.value = null;
    showProps.value = false;
    render();
  }
  contextMenu.value.show = false;
}

function onProvinceNameChange() {
  if (selectedProvince.value) {
    store.updateBaseProvince(baseMapKey.value, selectedProvince.value.id, { name: selectedProvince.value.name });
  }
}

function onProvinceBiomeChange() {
  if (selectedProvince.value) {
    store.updateBaseProvince(baseMapKey.value, selectedProvince.value.id, { biome: selectedProvince.value.biome });
    render();
  }
}

function onProvinceCultureChange() {
  if (selectedProvince.value) {
    store.updateBaseProvince(baseMapKey.value, selectedProvince.value.id, { culture: selectedProvince.value.culture });
  }
}

function onProvinceKindChange() {
  const prov = selectedProvince.value;
  if (!prov) return;
  store.updateBaseProvince(baseMapKey.value, prov.id, { kind: prov.kind === 'sea' ? 'sea' : 'land' });
  provinceBrush.invalidateBorders();
  render();
}

/** 活动环的顶点数（属性面板显示；顶点编辑只作用于活动环） */
const currentRingVertexCount = computed(() => {
  const prov = currentProvince();
  const pts = prov ? ringPointsOf(prov) : null;
  return pts ? pts.length : 0;
});

function onProvinceCoastChange() {
  if (selectedProvince.value) {
    store.updateBaseProvince(baseMapKey.value, selectedProvince.value.id, { coast: selectedProvince.value.coast });
  }
}

// ═══════════════════════════════════════════
// 几何工具
// ═══════════════════════════════════════════
function findProvinceAt(x, y) {
  const terrain = baseMap.value?.terrain;
  if (!terrain) return null;
  for (const prov of terrain) {
    if (!provinceRings(prov).length) continue;
    // 多环 / 带洞口径统一走纯函数层（evenodd）：洞真的点不中、飞地真的点得中
    if (pointInProvince(x, y, prov)) return prov;
  }
  return null;
}




// ═══════════════════════════════════════════
// 导入
// ═══════════════════════════════════════════
/**
 * 为当前底图创建高度图网格（A1，2026-09-24）。
 *
 * 底图的高度图此前**只有 `.map` 导入**一条来源 → 新建的底图里高度 / 群系 / 文化 / 宗教笔刷
 * 与一键派生全部因为「没有网格」直接 return，用户看到的是「工具点了没反应」。
 * 创建后这些工具即可使用；范围按底图已有地形的包围盒外扩（空底图给默认方框）。
 */
function createBaseMapHeightmap() {
  const r = store.createBaseMapHeightmap(baseMapKey.value);
  if (!r || r.ok === false) {
    statusMsg((r && r.error) || '创建高度图失败');
    return;
  }
  statusMsg(`已创建高度图网格 ${r.cellsX}×${r.cellsY}（${r.cells} 格）—— 现在可以用高度 / 群系 / 文化笔刷了`);
  renderer.requestRender();
}

async function triggerMapImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.map';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseMapFile(text);
      const name = file.name.replace(/\.map$/, '').replace(/\s*\d{4}-\d{2}-\d{2}.*$/, '');
      const json = buildScenariosJson(parsed, name, '当前');
      store.importFromScenariosJson(json);
      baseMapKey.value = name;
      // 持久化当前底图键（P0）
      if (window.sitianAPI?.setCurrentBaseMapKey) {
        window.sitianAPI.setCurrentBaseMapKey(name);
      }
      if (json.scenarios[name + '/当前']) {
        selectedScenario.value = json.scenarios[name + '/当前'];
        viewMode.value = 'scenario';
      }
      setTimeout(fitToView, 50);

      // 尝试自动同步 Azgaar 数据到对应行星的 mapData
      const planetNode = store.nodes?.find(n =>
        n.layer === 'planet' && (n.name === name || n.displayName === name)
      );
      if (planetNode && json.baseMaps?.[name]?.heightmap) {
        store.importPlanetLayerData(planetNode.id, {
          provinces: json.baseMaps[name].terrain,
          states: parsed.states,
          cultures: parsed.cultures,
          religions: parsed.religions,
          polities: parsed.polities,
          ownership: parsed.ownership,
        });
      }
    } catch (err) {
      alert('导入失败: ' + err.message);
    }
  };
  input.click();
}

function manualSave() {
  store.saveScenarios();
}

// ═══════════════════════════════════════════
// 剧本管理
// ═══════════════════════════════════════════
function createNewScenario() {
  const baseScenarioId = newScenario.value.inherit && sortedScenarios.value.length > 0
    ? sortedScenarios.value[sortedScenarios.value.length - 1].id
    : null;
  const scenarioId = `${baseMapKey.value}/${newScenario.value.name}`;
  if (baseScenarioId) {
    store.inheritScenario(scenarioId, baseScenarioId, {
      name: newScenario.value.name,
      era: { roman: newScenario.value.roman, label: newScenario.value.label, startYear: newScenario.value.startYear, endYear: newScenario.value.endYear },
      description: newScenario.value.description,
    });
  } else {
    store.createScenario(scenarioId, {
      ownerKey: baseMapKey.value,
      name: newScenario.value.name,
      era: { roman: newScenario.value.roman, label: newScenario.value.label, startYear: newScenario.value.startYear, endYear: newScenario.value.endYear },
      description: newScenario.value.description,
    });
  }
  newScenario.value = { name: '', roman: '', label: '', startYear: '', endYear: '', description: '', inherit: true };
  showScenarioManager.value = false;
  const newS = store.getScenario(scenarioId);
  if (newS) selectScenario(newS);
}

function deleteScenario(s) {
  if (confirm(`确定删除剧本「${s.name}」？`)) {
    store.removeScenario(s.id);
    if (selectedScenario.value?.id === s.id) {
      selectedScenario.value = sortedScenarios.value[0] || null;
    }
    render();
  }
}

// ═══════════════════════════════════════════
// 渲染
// ═══════════════════════════════════════════
// ══════════════════════════════════════
// 贝塞尔边界（P0-T1）
// ══════════════════════════════════════
/** 顶点坐标读取（兼容 {x,y} 与 [x,y]） */
function vx(p) { return p.x !== undefined ? p.x : p[0]; }
function vy(p) { return p.y !== undefined ? p.y : p[1]; }

/**
 * 为顶点批量生成平滑切线（验收：控制点位于相邻顶点连线的 1/3 处）。
 * 已带控制点的顶点原样保留（不覆盖手工调过的曲线）。
 */
function withBezierControls(points) {
  const n = points.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = points[i];
    if (p.controlIn && p.controlOut) { out[i] = p; continue; }
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    const dx = (vx(next) - vx(prev)) / 3;
    const dy = (vy(next) - vy(prev)) / 3;
    out[i] = { x: vx(p), y: vy(p), controlOut: { x: dx, y: dy }, controlIn: { x: -dx, y: -dy } };
  }
  return out;
}

/**
 * 描绘闭合/开口路径：有控制点且未按 Alt 时走 bezierCurveTo，否则退化直线段。
 * 红线：渲染循环内不创建新数组——本函数只读不分配。
 */
function traceShapePath(c, points, close = true) {
  const n = points.length;
  if (n < 2) return;
  c.moveTo(vx(points[0]), vy(points[0]));
  const last = close ? n : n - 1;
  for (let i = 1; i <= last; i++) {
    const prev = points[(i - 1) % n];
    const cur = points[i % n];
    const o = prev.controlOut;
    const k = cur.controlIn;
    if (!altStraight && o && k) {
      c.bezierCurveTo(vx(prev) + o.x, vy(prev) + o.y, vx(cur) + k.x, vy(cur) + k.y, vx(cur), vy(cur));
    } else {
      c.lineTo(vx(cur), vy(cur));
    }
  }
}

// ══════════════════════════════════════
// 海岸线吸附（P0-T2）
// ══════════════════════════════════════
/** 点到线段的最近投影 */
function projectOnSegment(world, a, b) {
  const ax = vx(a), ay = vy(a), bx = vx(b), by = vy(b);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 1e-9 ? ((world.x - ax) * dx + (world.y - ay) * dy) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const x = ax + t * dx;
  const y = ay + t * dy;
  const ddx = world.x - x, ddy = world.y - y;
  return { x, y, dist: Math.sqrt(ddx * ddx + ddy * ddy), t };
}

/**
 * 在已有省份边界上找最近吸附点（阈值默认 10px 世界坐标）。
 * 只在绘制/顶点编辑时调用；200 省 × ~30 边 ≈ 6000 次投影，单次调用微秒级。
 */
function snapToEdge(world, threshold = SNAP_EDGE_THRESHOLD) {
  const terrain = baseMap.value?.terrain;
  if (!terrain || !terrain.length) return null;
  let best = null;
  for (const prov of terrain) {
    const pts = resolvePoints(prov);
    if (!pts || pts.length < 2) continue;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const r = projectOnSegment(world, pts[j], pts[i]);
      if (r.dist <= threshold && (!best || r.dist < best.dist)) {
        best = { x: r.x, y: r.y, dist: r.dist, provId: prov.id, t: r.t, edgeIndex: i };
      }
    }
  }
  return best;
}

function showSnapFeedback(text, ms = 1000) {
  snapFeedback.value = text;
  if (snapFeedbackTimer) { clearTimeout(snapFeedbackTimer); snapFeedbackTimer = null; }
  snapFeedbackTimer = setTimeout(() => {
    snapFeedbackTimer = null;
    snapFeedback.value = '';
  }, ms);
}

/** 输入点 → 吸附结果（优先级：省份边界 > 网格；Shift 同时禁用两者） */
function resolveSnapPoint(world, shiftKey) {
  if (!shiftKey && snapToEdgeEnabled.value) {
    const e = snapToEdge(world);
    if (e) return { x: e.x, y: e.y, kind: 'edge', snapped: true };
  }
  const g = snapToGrid(world, shiftKey);
  return { x: g.x, y: g.y, kind: g.snapped ? 'grid' : 'none', snapped: g.snapped };
}

// ══════════════════════════════════════
// 底图数据图层（P1-T1 地形 / P1-T2 温度降水 / 陆海底色）
// ⚠️ 2026-09-25（M2/A2）：逐格上色与色带已抽到 `utils/heightmapRaster.js` ——
//    PlanetMap 此前另有一套矢量轮廓渲染，同一份高度图两个视图两个观感。
//    颜色与阈值**逐字**搬过去，本视图行为不变；改配色请改共享模块（两边同时生效）。
// ══════════════════════════════════════

/**
 * 当前底图的高度图栅格（M2/A2，2026-09-25）。
 *
 * 构建逻辑已抽到 `utils/heightmapRaster.js`：同一份高度图以前有两个视图两套渲染算法与配色，
 * 现在是同一套。本函数只负责「用哪一份高度图」（底图当前的那份）。
 *
 * 红线不变：大数据量必须预渲染，不逐帧重绘（几万格逐格画 = 每帧几十毫秒）。
 */
function buildCellRaster(kind) {
  return buildHeightmapRaster(baseMap.value?.heightmap, kind);
}

function getRaster(kind) {
  const key = baseMapKey.value + '|' + kind;
  const hit = rasterCache.get(key);
  if (hit) return hit;
  const built = buildCellRaster(kind);
  if (built) rasterCache.set(key, built);
  return built;
}

function drawRasterLayer(c, kind, alpha) {
  const r = getRaster(kind);
  if (!r) return;
  c.save();
  c.globalAlpha = alpha;
  c.imageSmoothingEnabled = false;
  c.drawImage(r.canvas, r.minX, r.minY, r.w, r.h);
  c.restore();
}

// ══════════════════════════════════════
// 河流 / 道路图层（P1-T3）
// ══════════════════════════════════════
/** 折线是否与当前视口相交（含 pad） */
function polylineInView(pts, minX, minY, maxX, maxY) {
  for (let i = 0; i < pts.length; i++) {
    const x = vx(pts[i]), y = vy(pts[i]);
    if (x >= minX && x <= maxX && y >= minY && y <= maxY) return true;
  }
  return false;
}

function drawRivers(c) {
  const list = baseMap.value?.rivers;
  if (!list || !list.length) return;
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(canvas.value.width, canvas.value.height);
  const pad = px(40);
  const minX = tl.x - pad, maxX = br.x + pad, minY = tl.y - pad, maxY = br.y + pad;

  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.strokeStyle = '#5d97bb';
  for (const r of list) {
    const pts = r.points;
    if (!pts || pts.length < 2) continue;
    if (!polylineInView(pts, minX, minY, maxX, maxY)) continue;
    // 线宽走世界坐标（随缩放变粗），并用 discharge 做量级区分
    const scaleW = r.discharge ? Math.sqrt(Math.max(r.discharge, 1)) / 14 : 1;
    c.lineWidth = Math.max(0.7, Math.min(4, (r.width || 0.2) * 6 * Math.max(scaleW, 0.6)));
    c.beginPath();
    c.moveTo(vx(pts[0]), vy(pts[0]));
    for (let i = 1; i < pts.length; i++) c.lineTo(vx(pts[i]), vy(pts[i]));
    c.stroke();
  }
  c.restore();
}

/** 配色/样式对齐 Azgaar FMG 默认：道路棕色实线、小径棕色虚线、海路白色虚线 */
const ROUTE_STYLES = {
  roads: { color: '#d06324', width: 0.9, dash: null, alpha: 0.95 },
  trails: { color: '#d06324', width: 0.5, dash: [2, 3], alpha: 0.85 },
  searoutes: { color: '#ffffff', width: 0.5, dash: [1.5, 3], alpha: 0.5 },
};

function drawRoutes(c) {
  const list = baseMap.value?.routes;
  if (!list || !list.length) return;
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(canvas.value.width, canvas.value.height);
  const pad = px(40);
  const minX = tl.x - pad, maxX = br.x + pad, minY = tl.y - pad, maxY = br.y + pad;

  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  for (const r of list) {
    const pts = r.points;
    if (!pts || pts.length < 2) continue;
    if (!polylineInView(pts, minX, minY, maxX, maxY)) continue;
    // 优先使用道路自带样式（P1-T3），回退到 group 默认
    const st = r.color ? { color: r.color, width: r.width || 1, dash: r.dash || null, alpha: 0.95 } : ROUTE_STYLES[r.group] || ROUTE_STYLES.roads;
    c.globalAlpha = st.alpha;
    c.strokeStyle = st.color;
    c.lineWidth = st.width;
    c.setLineDash(st.dash || []);
    c.beginPath();
    c.moveTo(vx(pts[0]), vy(pts[0]));
    for (let i = 1; i < pts.length; i++) c.lineTo(vx(pts[i]), vy(pts[i]));
    c.stroke();
  }
  c.setLineDash([]);
  c.restore();
}

function drawRiverPaths(c) {
  if (!riverPaths.value.length) return;
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(canvas.value.width, canvas.value.height);
  const pad = px(40);
  const minX = tl.x - pad, maxX = br.x + pad, minY = tl.y - pad, maxY = br.y + pad;
  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.strokeStyle = '#5d97bb';
  for (const path of riverPaths.value) {
    if (path.length < 2) continue;
    c.lineWidth = Math.max(1, px(2));
    c.beginPath();
    c.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) c.lineTo(path[i].x, path[i].y);
    c.stroke();
  }
  c.restore();
}

// ══════════════════════════════════════
// 文化/宗教图例（P1-T5，屏幕坐标系右下角）
// ══════════════════════════════════════
function drawCultureLegend(c) {
  const hm = baseMap.value?.heightmap;
  const src = colorMode.value === 'culture' ? hm?.cultures : hm?.religions;
  if (!src || !src.length) return;
  const rows = src.filter(x => x && x.i > 0 && x.color);
  if (!rows.length) return;

  const rowH = 15;
  const shown = rows.slice(0, 22);
  c.font = '11px "PingFang SC", sans-serif';
  let maxW = 40;
  for (const r of shown) maxW = Math.max(maxW, c.measureText(r.name || '').width);
  const boxW = Math.min(250, maxW + 34);
  const boxH = shown.length * rowH + 12;
  const bx = canvas.value.width - boxW - 12;
  const by = canvas.value.height - boxH - 12;

  c.save();
  c.fillStyle = 'rgba(15,26,46,0.86)';
  c.strokeStyle = 'rgba(148,163,184,0.5)';
  c.lineWidth = 1;
  c.beginPath();
  if (typeof c.roundRect === 'function') c.roundRect(bx, by, boxW, boxH, 6);
  else c.rect(bx, by, boxW, boxH);
  c.fill();
  c.stroke();
  for (let i = 0; i < shown.length; i++) {
    const y = by + 6 + i * rowH;
    c.fillStyle = shown[i].color;
    c.fillRect(bx + 8, y + 3, 10, 10);
    c.fillStyle = '#cbd5e1';
    c.fillText(shown[i].name || '', bx + 24, y + 12);
  }
  c.restore();
}

/** 当前底图可用的数据图层清单（状态栏显示） */
const layerAvailability = computed(() => {
  const hm = baseMap.value?.heightmap;
  return {
    cells: hm?.grid?.points?.length || 0,
    temp: (hm?.temp?.length || 0) > 0,
    prec: (hm?.prec?.length || 0) > 0,
    rivers: (baseMap.value?.rivers?.length || 0),
    routes: (baseMap.value?.routes?.length || 0),
    cultures: (hm?.cultures?.length || 0),
    religions: (hm?.religions?.length || 0),
  };
});

// 小地图（P11）
const showMinimap = ref(true);
const MINIMAP_SIZE = 150;
const minimapViewportDragging = false;

// 🔴 小地图缓存（P-0 实测：`drawMinimap` + `getMinimapWorldBounds` 每帧两次全量遍历
//    25930 个顶点，占单帧 CPU 的 16%）。现在几何只在「换图 / 数据变更」时重算一次，
//    缩略图烘到离屏 canvas，每帧只 drawImage + 画视口框。
let minimapRev = 0;
let minimapCache = { key: '', entry: null };

/** 省份几何/底图变化时作废小地图缓存（由 watch 调用） */
function invalidateMinimap() {
  minimapRev++;
}

/** 缩略图局部坐标系（0,0 起算，与屏幕上的摆放位置无关） */
function minimapGeo(bounds) {
  const mw = MINIMAP_SIZE;
  const mh = MINIMAP_SIZE;
  const spanX = bounds.maxX - bounds.minX || 1;
  const spanY = bounds.maxY - bounds.minY || 1;
  const scale = Math.min((mw - 4) / spanX, (mh - 4) / spanY);
  return {
    scale,
    offX: 2 + ((mw - 4) - spanX * scale) / 2,
    offY: 2 + ((mh - 4) - spanY * scale) / 2,
  };
}

function computeMinimapBounds() {
  const terrain = rawTerrain();
  if (!terrain?.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const prov of terrain) {
    for (const pts of rawRingPointsList(prov)) {      // 多环：飞地 / 洞都要进包围盒
      for (const p of pts) {
        const px = vx(p);
        const py = vy(p);
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
      }
    }
  }
  if (!isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

function buildMinimapThumb(bounds, geo) {
  const cv = document.createElement('canvas');
  cv.width = MINIMAP_SIZE;
  cv.height = MINIMAP_SIZE;
  const g = cv.getContext('2d');
  g.fillStyle = 'rgba(15,26,46,0.85)';
  g.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
  const terrain = rawTerrain();
  if (terrain) {
    g.fillStyle = 'rgba(148,163,184,0.4)';
    for (const prov of terrain) {
      for (const pts of rawRingPointsList(prov)) {
        if (!pts || pts.length < 3) continue;
        g.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const sx = geo.offX + (vx(pts[i]) - bounds.minX) * geo.scale;
          const sy = geo.offY + (vy(pts[i]) - bounds.minY) * geo.scale;
          if (i === 0) g.moveTo(sx, sy);
          else g.lineTo(sx, sy);
        }
        g.closePath();
        g.fill();
      }
    }
  }
  return cv;
}

function getMinimapEntry() {
  const key = `${baseMapKey.value}|${minimapRev}|${MINIMAP_SIZE}`;
  if (minimapCache.key === key) return minimapCache.entry;
  const bounds = computeMinimapBounds();
  let entry = null;
  if (bounds) {
    const geo = minimapGeo(bounds);
    entry = { bounds, geo, thumb: buildMinimapThumb(bounds, geo) };
  }
  minimapCache = { key, entry };
  return entry;
}

function drawMinimap(c) {
  if (!showMinimap.value) return;
  const entry = getMinimapEntry();
  if (!entry) return;
  const { bounds, geo, thumb } = entry;
  const mw = MINIMAP_SIZE;
  const mh = MINIMAP_SIZE;
  const pad = 12;
  const mx = canvas.value.width - mw - pad;
  const my = canvas.value.height - mh - pad;

  c.save();
  c.drawImage(thumb, mx, my);
  c.strokeStyle = 'rgba(148,163,184,0.5)';
  c.lineWidth = 1;
  c.strokeRect(mx, my, mw, mh);

  const tl = screenToWorld(0, 0);
  const br = screenToWorld(canvas.value.width, canvas.value.height);
  const vx1 = mx + geo.offX + (tl.x - bounds.minX) * geo.scale;
  const vy1 = my + geo.offY + (tl.y - bounds.minY) * geo.scale;
  const vx2 = mx + geo.offX + (br.x - bounds.minX) * geo.scale;
  const vy2 = my + geo.offY + (br.y - bounds.minY) * geo.scale;
  c.strokeStyle = '#ffd700';
  c.lineWidth = 1.5;
  c.strokeRect(vx1, vy1, vx2 - vx1, vy2 - vy1);

  c.restore();
}

// 数据图表（P2-T3 文化/宗教/势力分布）
const showDataChart = ref(false);
const dataChartType = ref('culture'); // culture | religion | polity

function toggleDataChart() {
  showDataChart.value = !showDataChart.value;
}

function drawDataChart(c) {
  if (!showDataChart.value) return;
  const hm = baseMap.value?.heightmap;
  const rows = dataChartType.value === 'culture' ? hm?.cultures : dataChartType.value === 'religion' ? hm?.religions : null;
  if (!rows || !rows.length) return;
  const data = rows.filter(x => x && x.i > 0 && x.color);
  if (!data.length) return;

  // 统计各文化/宗教的网格点数
  const counts = {};
  const arr = dataChartType.value === 'culture' ? hm.culture : hm.religion;
  if (!arr) return;
  for (let i = 0; i < arr.length; i++) {
    const id = arr[i];
    counts[id] = (counts[id] || 0) + 1;
  }

  const labels = data.map(r => ({ name: r.name, color: r.color, count: counts[r.i] || 0 }));
  const total = labels.reduce((s, l) => s + l.count, 0);
  if (!total) return;

  const boxW = 220;
  const boxH = labels.length * 22 + 50;
  const bx = 12;
  const by = canvas.value.height - boxH - 12;

  c.save();
  c.fillStyle = 'rgba(15,26,46,0.9)';
  c.strokeStyle = 'rgba(148,163,184,0.5)';
  c.lineWidth = 1;
  c.fillRect(bx, by, boxW, boxH);
  c.strokeRect(bx, by, boxW, boxH);

  c.font = 'bold 12px "PingFang SC", sans-serif';
  c.fillStyle = '#e2e8f0';
  c.fillText(`${dataChartType.value === 'culture' ? '文化' : '宗教'}分布`, bx + 10, by + 18);

  const maxCount = Math.max(...labels.map(l => l.count));
  for (let i = 0; i < labels.length; i++) {
    const y = by + 35 + i * 22;
    const pct = (labels[i].count / total * 100).toFixed(1);
    // 色块
    c.fillStyle = labels[i].color;
    c.fillRect(bx + 10, y, 12, 12);
    // 名称 + 百分比
    c.fillStyle = '#cbd5e1';
    c.font = '11px "PingFang SC", sans-serif';
    c.fillText(`${labels[i].name} ${pct}%`, bx + 28, y + 11);
    // 条形图
    const barW = 80;
    const barX = bx + 120;
    c.fillStyle = labels[i].color;
    c.fillRect(barX, y, (labels[i].count / maxCount) * barW, 12);
  }
  c.restore();
}

function render() {
  if (renderPaused.value) return;
  try {
    renderFrame();
    if (renderErrorCount.value) { renderErrorCount.value = 0; renderError.value = ''; }
  } catch (e) {
    // ── 渲染护栏 ─────────────────────────────────────────────────────────
    // render() 里抛出的异常会在 rAF / 事件回调里反复抛出：用户看到的是「画布黑掉 + 整页交互失效」；
    // 回归里表现为后续用例连环 CDP 超时（2026-09-20 一次负半径 IndexSizeError 连坐 12 个用例）。
    // 策略：捕获 → 只记录一次（console + 主进程错误日志）→ 连续 3 帧仍失败则**暂停渲染循环**
    // 并在状态栏给可见提示 + 「继续渲染」按钮（可见、可恢复，绝不静默黑屏）。
    renderErrorCount.value += 1;
    renderError.value = String((e && e.message) || e);
    if (!renderErrorLogged) {
      renderErrorLogged = true;
      console.error('[ScenarioMap] 渲染异常：', e);
      window.sitianAPI?.reportError?.({
        message: `ScenarioMap 渲染异常：${renderError.value}`,
        stack: e && e.stack,
        component: 'ScenarioMap.render',
      });
    }
    if (renderErrorCount.value >= 3) {
      renderPaused.value = true;
      statusMsg(`渲染已暂停（连续 ${renderErrorCount.value} 帧异常）：${renderError.value}`);
    }
  }
}

/** 手动恢复渲染（护栏暂停后由状态栏按钮触发） */
function resumeRender() {
  renderPaused.value = false;
  renderErrorCount.value = 0;
  renderError.value = '';
  renderErrorLogged = false;
  render();
}

function renderFrame() {
  if (!ctx.value) return;
  const cvs = canvas.value;
  const w = cvs.width;
  const h = cvs.height;
  ctx.value.clearRect(0, 0, w, h);

  ctx.value.save();
  ctx.value.translate(cameraX.value, cameraY.value);
  ctx.value.scale(cameraScale.value, cameraScale.value);

  drawBackground(ctx.value);

  // 底图数据图层：陆海底色铺底（补足省份多边形之外的海岸缝隙）
  if (rasterLayer.value === 'landsea') drawRasterLayer(ctx.value, 'landsea', 1);

  if (showBiomes.value) drawBiomeBackground(ctx.value);
  // 🔴 渲染单一路径：**永远画省份多边形**（存下来 / 导出的就是它）。
  //    涂抹进行中额外叠一层网格即时反馈（labels 已变，多边形要等抬手才重算）。
  drawProvinces(ctx.value);
  if ((provStrokeActive || provLassoActive) && provinceMeshOn.value) drawProvinceMesh(ctx.value);

  // 地形/温度/降水：半透明叠加在省份之上（验收：alpha ≈ 0.4，不影响点击选中）
  if (rasterLayer.value === 'height') drawRasterLayer(ctx.value, 'height', 0.45);
  else if (rasterLayer.value === 'temp') drawRasterLayer(ctx.value, 'temp', 0.5);
  else if (rasterLayer.value === 'prec') drawRasterLayer(ctx.value, 'prec', 0.5);

  if (showRoutes.value) drawRoutes(ctx.value);
  if (showRivers.value) drawRivers(ctx.value);
  drawRiverPaths(ctx.value);

  // v2: 自动生成的河流
  if (autoRivers.value.length > 0 && showRivers.value) {
    ctx.save();
    ctx.strokeStyle = '#5d97bb';
    ctx.lineWidth = px(1);
    for (const river of autoRivers.value) {
      if (river.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(river[0].x, river[0].y);
      for (let i = 1; i < river.length; i++) {
        ctx.lineTo(river[i].x, river[i].y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
  if (showBorders.value) drawProvinceBorders(ctx.value);
  drawVertexHandles(ctx.value);
  if (showBurgs.value) drawBurgs(ctx.value);
  if (PROVINCE_GRID_TOOLS.has(tool.value)) drawProvinceBrushOverlay(ctx.value);
  drawPreviewOverlay(ctx.value);
  if (showLabels.value) drawLabels(ctx.value);
  // A8：势力标注画在用户浮动文本之后（势力名是底层读物，不该被浮字压住）
  drawPolityLabels(ctx.value);
  drawReliefIcons(ctx.value);
  drawScenarioMarkers(ctx.value);

  ctx.value.restore();

  // 以下浮层画在屏幕坐标系：字号与命中不受缩放影响
  drawBurgTooltip(ctx.value);
  drawCultureLegend(ctx.value);
  drawMinimap(ctx.value);
  drawDataChart(ctx.value);
}

function drawBackground(ctx) {
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(canvas.value.width, canvas.value.height);
  ctx.fillStyle = '#1a2a3a';
  ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = px(1);
  const step = GRID_STEP;
  const startX = Math.floor(tl.x / step) * step;
  const startY = Math.floor(tl.y / step) * step;
  const endX = br.x + step;
  const endY = br.y + step;
  for (let x = startX; x <= endX; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, startY);
    ctx.lineTo(x, endY);
    ctx.stroke();
  }
  for (let y = startY; y <= endY; y += step) {
    ctx.beginPath();
    ctx.moveTo(startX, y);
    ctx.lineTo(endX, y);
    ctx.stroke();
  }
}

function drawBiomeBackground(ctx) {
  // 如果有生物群系数据，用半透明色块显示
  const biomes = baseMap.value?.heightmap?.biomes;
  if (!biomes || !biomes.length) return;
  
  // 绘制生物群系图例（右下角）
  const legendX = screenToWorld(canvas.value.width - 150, canvas.value.height - 300).x;
  const legendY = screenToWorld(canvas.value.width - 150, canvas.value.height - 300).y;
  ctx.font = `${11}px "PingFang SC", sans-serif`;
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(legendX - 5, legendY - 15, 140, biomes.length * 18 + 20);
  ctx.fillStyle = '#fff';
  ctx.fillText('生物群系', legendX, legendY);
  biomes.forEach((b, i) => {
    if (i < 10) {
      ctx.fillStyle = b.color || '#888';
      ctx.fillRect(legendX, legendY + 5 + i * 18, 12, 12);
      ctx.fillStyle = '#ccc';
      ctx.fillText(b.name || `Biome ${i}`, legendX + 16, legendY + 15 + i * 18);
    }
  });
}


/** 颜色是否不透明（同色描边前的判据：半透明色描边会变成可见的深色轮廓线） */
function isOpaqueColor(col) {
  if (typeof col !== 'string') return false;
  const m = col.match(/^rgba?\(([^)]+)\)$/i);
  if (!m) return true;                       // #rrggbb / 命名色 / hsl() → 当作不透明
  const parts = m[1].split(',').map((s) => s.trim());
  return parts.length < 4 || Number(parts[3]) >= 1;
}

function drawProvinces(c) {
  if (!baseMap.value?.terrain) return;
  const tl = timeline.value;
  const k = tlEra.value;
  const year = tlYear.value;
  const scenarioMode = viewMode.value === 'scenario' && tl.scenarios.length > 0;

  rawTerrain().forEach(prov => {
    const rp = rawProvOf(prov);
    if (!rp || !provinceRings(rp).length) return;
    const fillCol = getProvinceColor(rp);
    c.fillStyle = fillCol;
    c.beginPath();
    // 多环实体：一条路径覆盖所有环；evenodd 与命中口径（pointInProvince）一致 → 洞真空、飞地真画
    traceProvincePath(c, rp);
    c.closePath();
    c.fill('evenodd');
    // 同色描边（~1px）：抹掉相邻省份之间的**亚像素缝**。
    // 网格派生的边界由相邻两省各自平滑（Chaikin 在共享弧的两端邻域不同），交界处最多差
    // 零点几像素 —— 同色 1px 描边是最省事的收敛办法（恰好覆盖在边界上，观感不变）。
    // 仅对不透明色描边：半透明色描上去会变成一条可见的深色轮廓线（不是我们要的）。
    if (rp.kind === 'sea') {
      // P4：海界 = **淡虚线**（实线是陆地省界，虚线一眼区分水陆；海陆交界处两者贴合 = 严丝合缝）
      c.setLineDash([px(6), px(4)]);
      c.strokeStyle = SEA_EDGE;
      c.lineWidth = px(1.2);
      c.stroke();
      c.setLineDash([]);
    } else if (isOpaqueColor(fillCol)) {
      c.strokeStyle = fillCol;
      c.lineWidth = px(1);
      c.stroke();
    }

    // EU4 式斜线占领：底色刻意是**旧主**色（上面刚填的），斜线用**新主**色。
    // 两方本色即可表达「谁占了谁的」，不需要引入任何新色相。
    if (scenarioMode && tlDiffMode.value === 'eu4' && isStriped(tl, k, rp.id, year)) {
      const newCol = polityColor(tl.scenarios[k], tl.scenarios[k].ownership?.[rp.id]);
      const b = provinceBBox(rp);
      const dy = b.maxY - b.minY;
      const step = px(8.5);
      c.save();
      c.clip();                       // 复用当前路径（fill 不会清空路径）
      c.globalAlpha = 0.92;
      c.strokeStyle = newCol;
      c.lineWidth = px(3.2);
      for (let t = b.minX - dy - 20; t < b.maxX + 20; t += step) {
        c.beginPath();
        c.moveTo(t, b.minY - 20);
        c.lineTo(t + dy + 40, b.maxY + 20);
        c.stroke();
      }
      c.restore();
      c.save();
      c.lineWidth = px(1.4);
      c.strokeStyle = newCol;
      c.beginPath();
      traceProvincePath(c, rp);
      c.closePath();
      c.stroke();
      c.restore();
    } else if (scenarioMode && tlDiffMode.value === 'outline'
               && k > 0 && (tl.eraChg[k]?.changed || []).includes(rp.id)) {
      c.save();
      c.lineWidth = px(2);
      c.strokeStyle = '#ffffff';
      c.beginPath();
      traceProvincePath(c, rp);
      c.closePath();
      c.stroke();
      c.restore();
    }
  });
}

function drawProvinceBorders(c) {
  if (!baseMap.value?.terrain) return;
  rawTerrain().forEach(prov => {
    const isSelected = selectedProvince.value?.id === prov.id;
    const isMergeTarget = mergeProvId.value === prov.id;
    const rp = rawProvOf(prov);
    if (!rp || !provinceRings(rp).length) return;
    c.strokeStyle = isMergeTarget ? '#ffd700' : (isSelected ? '#ffffff' : 'rgba(141,138,130,0.6)');
    c.lineWidth = isSelected ? px(1.5) : px(0.6);
    c.beginPath();
    traceProvincePath(c, rp);
    c.closePath();
    c.stroke();
  });
}

function drawVertexHandles(c) {
  if (!vertexEditMode.value || !selectedProvince.value) return;
  const prov = currentProvince();
  const points = prov ? resolvePoints(prov) : null;
  if (!points) return;
  const r = px(4);
  const hR = px(3.5);
  const active = activeVertexIdx.value;

  // P0-T1：仅对当前选中顶点画切线手柄（大省份全画会遮满屏幕）
  if (active >= 0 && active < points.length && !altStraight) {
    const p = points[active];
    const cx = vx(p), cy = vy(p);
    const out = p.controlOut;
    const inn = p.controlIn;
    if (out || inn) {
      c.save();
      c.setLineDash([px(3), px(3)]);
      c.strokeStyle = 'rgba(167,139,250,0.8)';
      c.lineWidth = px(1);
      if (out) { c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + out.x, cy + out.y); c.stroke(); }
      if (inn) { c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + inn.x, cy + inn.y); c.stroke(); }
      c.setLineDash([]);
      c.fillStyle = '#38bdf8';
      c.strokeStyle = '#ffffff';
      if (out) { c.beginPath(); c.arc(cx + out.x, cy + out.y, hR, 0, Math.PI * 2); c.fill(); c.stroke(); }
      if (inn) { c.beginPath(); c.arc(cx + inn.x, cy + inn.y, hR, 0, Math.PI * 2); c.fill(); c.stroke(); }
      c.restore();
    }
  }

  points.forEach((p, i) => {
    const px = vx(p);
    const py = vy(p);
    c.fillStyle = draggingVertex.value?.vertexIdx === i ? '#ffd700' : (i === active ? '#f472b6' : '#a78bfa');
    c.strokeStyle = '#fff';
    c.lineWidth = px(1);
    c.beginPath();
    c.arc(px, py, r, 0, Math.PI * 2);
    c.fill();
    c.stroke();
  });
}

function getProvinceColor(prov) {
  // P4：海域**不参与归属着色**（海不是谁的领土）→ 永远用水面色，与剧本/时间轴无关
  if (prov && prov.kind === 'sea') return SEA_FILL;

  // P1-T5：文化/宗教着色（颜色取自 .map 的 cultures/religions 定义，归属来自 province → burg → culture）
  if (colorMode.value === 'culture' && prov.cultureColor) return prov.cultureColor;
  if (colorMode.value === 'religion' && prov.religionColor) return prov.religionColor;

  // 剧本模式：优先势力归属色。归属按**时间轴当前年份**取（含「演变铺开」），
  // 而不是用选中剧本的静态快照 —— 否则拖时间轴时地图不会随年份变。
  if (viewMode.value === 'scenario') {
    const tl = timeline.value;
    const k = tlEra.value;
    if (tl.scenarios.length) {
      // ⚠️ 底色随变化图层模式切换：
      //   EU4 斜线占领 → 底色刻意保持**旧主**色（新主由斜线表达，两方本色）
      //   其他模式    → 底色 = **当前实际**持有者（关掉图层就该看到真实归属）
      // 颜色必须在 owner 所属的那个剧本里查（旧主 id 属于上一个剧本，跨剧本查会落到灰）
      const ref = (tlDiffMode.value === 'eu4' && isStriped(tl, k, prov.id, tlYear.value))
        ? { owner: tl.scenarios[k - 1].ownership?.[prov.id], era: k - 1 }
        : currentOwnerRef(tl, k, prov.id, tlYear.value);
      return polityColor(tl.scenarios[ref.era], ref.owner);
    }
    // 时间轴不可用（剧本缺年份等）时退回选中剧本的静态归属
    if (selectedScenario.value) {
      const owner = selectedScenario.value.ownership?.[prov.id];
      const polity = selectedScenario.value.polities?.find(p => p.id === owner);
      return polity?.color || '#4a5568';
    }
  }

  // 省份**自有色**（P1：新建省份按色板轮转给色）—— 这是用户的显式选择，优先于群系/默认色
  if (prov.color) return prov.color;

  // 生物群系图层开启时按群系染色
  if (showBiomes.value && prov.biome && BIOME_COLORS[prov.biome]) return BIOME_COLORS[prov.biome];

  if (viewMode.value === 'scenario' && selectedScenario.value) return '#4a5568';
  return prov.biomeColor || '#bccda0';
}

/** 把轨迹画成**平滑**路径（中点二次曲线）：手绘的观感就是曲线，逐点 lineTo 会变成「描点连线」 */
function tracePath(c, pts, close) {
  if (!pts || pts.length < 2) return false;
  c.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    c.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  const last = pts[pts.length - 1];
  c.lineTo(last.x, last.y);
  if (close) c.closePath();
  return true;
}

function drawPreviewOverlay() {
  const c = ctx.value;
  // 「绘制」工具的自由绘制实时轨迹（一笔跟着走，松手才简化成型）
  if (freeTraceActive && freeTrace && freeTrace.length > 1) {
    c.save();
    c.strokeStyle = '#c4b5fd';
    c.lineWidth = px(1.8);
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.beginPath();
    tracePath(c, freeTrace, false);
    c.stroke();
    c.restore();
  }
  if (tool.value === 'draw' && drawPoints.value.length > 0) {
    c.strokeStyle = '#7c3aed';
    c.fillStyle = 'rgba(124, 58, 237, 0.15)';
    c.lineWidth = px(2);
    c.beginPath();
    c.moveTo(drawPoints.value[0].x, drawPoints.value[0].y);
    for (let i = 1; i < drawPoints.value.length; i++) {
      c.lineTo(drawPoints.value[i].x, drawPoints.value[i].y);
    }
    if (drawPoints.value.length >= 3) c.closePath();
    c.fill();
    c.stroke();
    for (const p of drawPoints.value) {
      c.fillStyle = '#a78bfa';
      c.beginPath();
      c.arc(p.x, p.y, px(3), 0, Math.PI * 2);
      c.fill();
    }
  }

  // 吸附标记（P0-T3 网格绿十字 / P0-T2 边界青环）
  if (snapMarker.value) {
    const mx = snapMarker.value.x;
    const my = snapMarker.value.y;
    const isEdge = snapMarker.value.kind === 'edge';
    const arm = px(7);
    c.strokeStyle = isEdge ? '#22d3ee' : '#34d399';
    c.lineWidth = px(1.5);
    c.beginPath();
    c.moveTo(mx - arm, my);
    c.lineTo(mx + arm, my);
    c.moveTo(mx, my - arm);
    c.lineTo(mx, my + arm);
    c.stroke();
    c.beginPath();
    c.arc(mx, my, px(2.5), 0, Math.PI * 2);
    c.stroke();
    if (isEdge) {
      c.beginPath();
      c.arc(mx, my, px(6), 0, Math.PI * 2);
      c.stroke();
    }
  }

  // 笔刷预览（hover 时显示）
  if (brushPreview.value && ['height', 'biome', 'culture', 'religion'].includes(tool.value)) {
    const bp = brushPreview.value;
    c.beginPath();
    c.arc(bp.x, bp.y, bp.radius, 0, Math.PI * 2);
    let color = 'rgba(74, 158, 255, 0.8)';
    if (tool.value === 'biome') color = 'rgba(255, 107, 107, 0.8)';
    else if (tool.value === 'culture') color = 'rgba(255, 215, 0, 0.8)';
    else if (tool.value === 'religion') color = 'rgba(167, 139, 250, 0.8)';
    c.strokeStyle = color;
    c.lineWidth = px(2);
    c.setLineDash([px(5), px(5)]);
    c.stroke();
    c.setLineDash([]);
    c.fillStyle = color.replace('0.8', '0.1');
    c.fill();
  }

  // 道路预览
  if (tool.value === 'road' && roadPath.value.length >= 2) {
    c.strokeStyle = '#ffd700';
    c.lineWidth = px(2);
    c.setLineDash([px(4), px(4)]);
    c.beginPath();
    c.moveTo(roadPath.value[0].x, roadPath.value[0].y);
    for (let i = 1; i < roadPath.value.length; i++) {
      c.lineTo(roadPath.value[i].x, roadPath.value[i].y);
    }
    c.stroke();
    c.setLineDash([]);
    // 起终点标记
    c.fillStyle = '#ffd700';
    c.beginPath();
    c.arc(roadPath.value[0].x, roadPath.value[0].y, px(4), 0, Math.PI * 2);
    c.fill();
    c.beginPath();
    c.arc(roadPath.value[roadPath.value.length - 1].x, roadPath.value[roadPath.value.length - 1].y, px(4), 0, Math.PI * 2);
    c.fill();
  }

  if (tool.value === 'split' && splitStep.value === 1 && splitPoints.value.length === 1) {
    c.fillStyle = '#fbbf24';
    c.beginPath();
    c.arc(splitPoints.value[0].x, splitPoints.value[0].y, px(5), 0, Math.PI * 2);
    c.fill();
  }

  // 河流编辑器预览（P1-T2）
  if (tool.value === 'river' && riverDraft.value.length > 0) {
    c.strokeStyle = '#5d97bb';
    c.lineWidth = px(2);
    c.setLineDash([px(4), px(4)]);
    c.beginPath();
    c.moveTo(riverDraft.value[0].x, riverDraft.value[0].y);
    for (let i = 1; i < riverDraft.value.length; i++) {
      c.lineTo(riverDraft.value[i].x, riverDraft.value[i].y);
    }
    c.stroke();
    c.setLineDash([]);
    for (const p of riverDraft.value) {
      c.fillStyle = '#5d97bb';
      c.beginPath();
      c.arc(p.x, p.y, px(3), 0, Math.PI * 2);
      c.fill();
    }
  }
}

// ═══════════════════════════════════════════
// 城镇图层（P1-T4）
// ═══════════════════════════════════════════
/** 屏幕坐标命中城镇；首都优先（避免小城镇遮住首都） */
function findBurgAt(sx, sy) {
  const list = burgs.value;
  if (!list.length) return null;
  const r2 = BURG_HIT_RADIUS * BURG_HIT_RADIUS;
  let best = null;
  let bestD = Infinity;
  for (let pass = 1; pass >= 0; pass--) {
    for (const b of list) {
      if ((b.capital ? 1 : 0) !== pass) continue;
      const dx = cameraX.value + b.x * cameraScale.value - sx;
      const dy = cameraY.value + b.y * cameraScale.value - sy;
      const d = dx * dx + dy * dy;
      if (d <= r2 && d < bestD) { bestD = d; best = b; }
    }
    if (best) return best;
  }
  return null;
}

/** 选择工具下 hover 命中城镇；仅状态变化时重绘，避免 mousemove 刷屏 */
function updateBurgHover(event) {
  if (tool.value !== 'select' || !showBurgs.value) {
    if (hoveredBurg.value) { hoveredBurg.value = null; render(); }
    return;
  }
  const rect = canvas.value.getBoundingClientRect();
  const hit = findBurgAt(event.clientX - rect.left, event.clientY - rect.top);
  const prevId = hoveredBurg.value ? hoveredBurg.value.id : null;
  const nextId = hit ? hit.id : null;
  if (prevId === nextId) return;
  hoveredBurg.value = hit;
  canvas.value.style.cursor = hit ? 'pointer' : 'grab';
  render();
}

/** 首都：金色星形 */
function drawCapitalStar(c, x, y, r) {
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.42;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = x + Math.cos(a) * rad;
    const py = y + Math.sin(a) * rad;
    if (i === 0) c.moveTo(px, py);
    else c.lineTo(px, py);
  }
  c.closePath();
  c.fillStyle = '#ffd700';
  c.fill();
  c.strokeStyle = 'rgba(20,24,34,0.65)';
  c.lineWidth = px(1);
  c.stroke();
}

function drawBurgs(c) {
  const list = burgs.value;
  if (!list.length) return;
  // 视口裁剪：只画可见范围（含边距）
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(canvas.value.width, canvas.value.height);
  const pad = px(24);
  const minX = tl.x - pad, maxX = br.x + pad, minY = tl.y - pad, maxY = br.y + pad;
  const dotR = px(2.5);
  const starR = px(5.5);
  const hoverId = hoveredBurg.value ? hoveredBurg.value.id : null;
  const selectedId = selectedBurg.value ? selectedBurg.value.id : null;

  // 两趟绘制（普通城镇在下、首都在上）；不新建数组，避免渲染循环内分配
  for (let pass = 0; pass <= 1; pass++) {
    for (const b of list) {
      if ((b.capital ? 1 : 0) !== pass) continue;
      if (b.x < minX || b.x > maxX || b.y < minY || b.y > maxY) continue;
      if (pass === 1) {
        drawCapitalStar(c, b.x, b.y, starR);
      } else {
        // 根据聚落规模调整大小（P1-T4）
        const sizeDef = BURG_SIZES.find(s => s.id === b.size) || BURG_SIZES[1];
        const r = dotR * (sizeDef.radius / 3.5);
        c.fillStyle = sizeDef.color;
        c.globalAlpha = 0.85;
        c.beginPath();
        c.arc(b.x, b.y, r, 0, Math.PI * 2);
        c.fill();
        c.globalAlpha = 1;
      }
      if (b.id === selectedId || b.id === hoverId) {
        c.strokeStyle = b.id === selectedId ? '#34d399' : '#ffffff';
        c.lineWidth = px(1.5);
        c.beginPath();
        c.arc(b.x, b.y, starR * 1.8, 0, Math.PI * 2);
        c.stroke();
      }
    }
  }
}

/** FMG 的 population 为原始数值（不做单位换算，避免臆造量纲） */
function formatPopulation(pop) {
  if (!pop) return '—';
  return pop >= 100 ? String(Math.round(pop)) : pop.toFixed(1);
}

/** 悬停/选中的城镇信息浮层（屏幕坐标系，字号不随缩放变化） */
function drawBurgTooltip(c) {
  if (!showBurgs.value) return;
  const b = hoveredBurg.value || selectedBurg.value;
  if (!b) return;
  const sx = cameraX.value + b.x * cameraScale.value;
  const sy = cameraY.value + b.y * cameraScale.value;
  const title = b.name || '未命名城镇';
  const sub = `${b.capital ? '首都 · ' : ''}人口 ${formatPopulation(b.population)}`;
  c.font = '12px "PingFang SC", sans-serif';
  const w = Math.max(c.measureText(title).width, c.measureText(sub).width) + 18;
  const h = 36;
  let tx = sx + 12;
  let ty = sy - h - 6;
  if (tx + w > canvas.value.width) tx = sx - w - 12;
  if (ty < 0) ty = sy + 12;
  c.fillStyle = 'rgba(15,26,46,0.94)';
  c.strokeStyle = b.capital ? '#ffd700' : '#475569';
  c.lineWidth = 1;
  c.beginPath();
  if (typeof c.roundRect === 'function') c.roundRect(tx, ty, w, h, 6);
  else c.rect(tx, ty, w, h);
  c.fill();
  c.stroke();
  c.fillStyle = '#e2e8f0';
  c.font = '12px "PingFang SC", sans-serif';
  c.fillText(title, tx + 9, ty + 15);
  c.fillStyle = '#94a3b8';
  c.font = '11px "PingFang SC", sans-serif';
  c.fillText(sub, tx + 9, ty + 28);
}

// ─────────────────────────────────────────────────────────────
// A8：势力标注（EU4 式分级）—— 放大看省名，缩小只留势力名（可简称），全名点开省份详情才给
// ─────────────────────────────────────────────────────────────

// 分级依据 = 「视口可见世界宽度 ÷ 地图世界宽度」。
// ⚠️ 刻意**不用绝对 cameraScale**：它依赖数据量纲（FMG 导入 ≈1 量级、合成 fixture ≈0.2 量级），
//    换一份数据阈值就整体失准 —— 表现为「同一档位在一份数据里全画省名、另一份里全画简称」。
// 缓存只按 `terrain` 数组**引用**失效（编辑一律替换数组）→ 每帧不再重扫 25930 个顶点。
let _mapSizeCache = { src: null, w: 0, h: 0 };
function mapWorldSize() {
  const terrain = baseMap.value?.terrain;
  if (!terrain || !terrain.length) return { w: 0, h: 0 };
  if (_mapSizeCache.src === terrain) return _mapSizeCache;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const prov of terrain) {
    for (const ring of provinceRings(toRaw(prov))) {
      for (const p of (ring.points || [])) {
        const x = Array.isArray(p) ? p[0] : p && p.x;
        const y = Array.isArray(p) ? p[1] : p && p.y;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  _mapSizeCache = {
    src: terrain,
    w: isFinite(minX) ? Math.max(1, maxX - minX) : 0,
    h: isFinite(minY) ? Math.max(1, maxY - minY) : 0,
  };
  return _mapSizeCache;
}

/** 视口可见世界宽度 ÷ 地图世界宽度（无数据时回落 1 = 中档，绝不返回 NaN） */
function mapVisibleRatio() {
  const { w } = mapWorldSize();
  const cvsW = canvas.value?.width || canvas.value?.clientWidth || 0;
  const scale = Math.max(cameraScale.value, MIN_CAMERA_SCALE);
  if (!w || !cvsW) return 1;
  return (cvsW / scale) / w;
}

/** 当前档位（暴露给模板/用例；判定本体在 utils/polityLabels.js） */
const polityLabelTierNow = computed(() => polityLabelTier(mapVisibleRatio()));

/**
 * 当前选中省份所属势力 —— 「全名只在点开省份详情时给」那条诉求的落点
 * （地图上缩小时只画简称，全名要能查到）。
 */
const selectedProvincePolity = computed(() => {
  if (viewMode.value !== 'scenario') return null;
  const prov = selectedProvince.value;
  if (!prov) return null;
  const { ownerRefOf, polityOfEra } = polityLabelSources();
  const ref = ownerRefOf(prov.id);
  if (!ref || !ref.owner) return null;
  return polityOfEra(ref.era, ref.owner);
});

/**
 * 势力标注的**归属查询**：必须与 `getProvinceColor` 走同一口径
 * （含「演变铺开」与 EU4 斜线占领的旧主底色），否则会出现「颜色是甲、名字写乙」。
 * 势力对象还必须在 **owner 所属的那个剧本**里查 —— 真实数据每个剧本的 polity id 全新
 * （`pol_ou → pol_li`），跨剧本查会落空 → 标签整片消失（颜色那条路径已因此踩过一次）。
 */
function polityLabelSources() {
  const tl = timeline.value;
  const k = tlEra.value;
  const year = tlYear.value;
  if (tl.scenarios.length) {
    const ownerRefOf = (pid) => {
      if (tlDiffMode.value === 'eu4' && isStriped(tl, k, pid, year)) {
        return { owner: tl.scenarios[k - 1]?.ownership?.[pid], era: k - 1 };
      }
      return currentOwnerRef(tl, k, pid, year);
    };
    return { ownerRefOf, polityOfEra: (era, owner) => tl.scenarios[era]?.polities?.find(p => p.id === owner) || null };
  }
  const sc = selectedScenario.value;
  return {
    ownerRefOf: (pid) => ({ owner: sc?.ownership?.[pid], era: -1 }),
    polityOfEra: (_era, owner) => sc?.polities?.find(p => p.id === owner) || null,
  };
}

function drawPolityLabels(c) {
  if (!showPolityLabels.value) return;
  if (viewMode.value !== 'scenario') return;
  const terrain = rawTerrain();
  if (!terrain || !terrain.length) return;

  const scale = cameraScale.value;
  const tier = polityLabelTierNow.value;
  const { ownerRefOf, polityOfEra } = polityLabelSources();

  // 视口裁剪（标签是屏幕空间的，画在屏幕外纯属浪费 measureText）
  const tl0 = screenToWorld(0, 0);
  const br0 = screenToWorld(canvas.value.width, canvas.value.height);
  const pad = px(40);
  const inView = (x, y) => x >= tl0.x - pad && x <= br0.x + pad && y >= tl0.y - pad && y <= br0.y + pad;

  // ── 放大档：省名 ──
  // ⚠️ 海域判据取**环的 kind**（与 `drawProvinces` 里 `rp.kind === 'sea'` 同口径）：
  //    `kind` 是省份级字段、由 `provinceRings` 归一后下发到环上，直接读 `prov.kind`
  //    在「只有环上带 kind」的数据里会漏判 → 海面被挂上名字。
  // ⚠️ 只取**主环**（`rings[0]`）算面积与形心：多环省份里洞与飞地面积很小，
  //    对标签落点的贡献远小于主陆，把它算进来反而会把名字往边界推。
  if (tier === 'province') {
    for (const prov of terrain) {
      if (!prov) continue;
      const name = String(prov.name || '').trim();
      if (!name) continue;
      const rings = provinceRings(prov);
      if (!rings.length || rings[0].kind === 'sea') continue;
      const pts = ringPointsForRender(rings[0]);
      if (!pts || pts.length < 3) continue;
      const { area, cx, cy } = ringAreaCentroid(pts);
      if (!labelFitsOnScreen(area, scale, LABEL_MIN_AREA_PX.province)) continue;
      if (!inView(cx, cy)) continue;
      drawStyledLabel(c, name, cx, cy, PROVINCE_LABEL_STYLE, { screenScale: scale });
    }
    return;
  }

  // ── 中/小档：势力名 / 简称（领土聚合 → 面积加权质心）──
  const items = [];
  for (const prov of terrain) {
    if (!prov) continue;
    const ref = ownerRefOf(prov.id);
    if (!ref || !ref.owner) continue;
    const rings = provinceRings(prov);
    if (!rings.length || rings[0].kind === 'sea') continue;
    const pts = ringPointsForRender(rings[0]);
    if (!pts || pts.length < 3) continue;
    items.push({ key: `${ref.era}|${ref.owner}`, points: pts });
  }
  const agg = aggregateTerritories(items, (it) => it.key);
  for (const [key, st] of agg) {
    if (!labelFitsOnScreen(st.area, scale, LABEL_MIN_AREA_PX.polity)) continue;
    if (!inView(st.cx, st.cy)) continue;
    const sep = key.indexOf('|');
    const era = Number(key.slice(0, sep));
    const owner = key.slice(sep + 1);
    const text = labelTextFor(polityOfEra(era, owner), tier);
    if (!text) continue;
    // 选中势力高亮：与色板/状态栏的「已选势力」呼应，方便确认自己正在改谁
    const highlight = !!selectedPolity.value && selectedPolity.value.id === owner;
    drawStyledLabel(c, text, st.cx, st.cy, POLITY_LABEL_STYLE, { screenScale: scale, highlight });
  }
}

function drawLabels(c) {
  if (viewMode.value !== 'scenario' || !selectedScenario.value?.labels) return;
  selectedScenario.value.labels.forEach(label => {
    c.font = label.font || `${label.size || 12}px "PingFang SC", sans-serif`;
    c.fillStyle = label.color || '#e2e8f0';
    // 描边（提升可读性，Wonderdraft 风格）
    if (label.stroke && label.strokeWidth > 0) {
      c.strokeStyle = label.stroke;
      c.lineWidth = label.strokeWidth;
      c.lineJoin = 'round';
      c.strokeText(label.text, label.x, label.y);
    }
    c.fillText(label.text, label.x, label.y);
  });
}

function drawReliefIcons(c) {
  if (!reliefIcons.value.length) return;
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(canvas.value.width, canvas.value.height);
  const pad = px(30);
  const minX = tl.x - pad, maxX = br.x + pad, minY = tl.y - pad, maxY = br.y + pad;
  const fontSize = Math.max(12, px(16));
  c.font = `${fontSize}px "PingFang SC", sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  for (const r of reliefIcons.value) {
    if (r.x < minX || r.x > maxX || r.y < minY || r.y > maxY) continue;
    // 矢量图标名走 Path2D；用户历史数据里的 emoji 由 drawIconOrEmoji 内部 fillText 兜住
    drawIconOrEmoji(c, r.icon, r.x, r.y, Math.max(14, px(18)), r.color || '#FFFFFF');
  }
  c.textAlign = 'start';
  c.textBaseline = 'alphabetic';
}

function drawScenarioMarkers(c) {
  if (viewMode.value !== 'scenario' || !selectedScenario.value?.markers?.length) return;
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(canvas.value.width, canvas.value.height);
  const pad = px(30);
  const minX = tl.x - pad, maxX = br.x + pad, minY = tl.y - pad, maxY = br.y + pad;
  const fontSize = Math.max(12, px(14));
  c.font = `${fontSize}px "PingFang SC", sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  for (const m of selectedScenario.value.markers) {
    if (m.x < minX || m.x > maxX || m.y < minY || m.y > maxY) continue;
    // 图标（矢量；历史数据里的 emoji 由内部 fillText 兜住）
    // 图标/颜色缺省时按「标记类型」补 —— 导入的数据往往只带 type，不补会全变成同一个兜底图标
    const typeDef = MARKER_TYPES.find(t => t.id === m.type);
    drawIconOrEmoji(c, m.icon || (typeDef && typeDef.icon) || 'map-pin', m.x, m.y,
      Math.max(12, px(16)), m.color || (typeDef && typeDef.color) || '#FFFFFF');
    // 名称标签
    c.font = `${Math.max(10, px(11))}px "PingFang SC", sans-serif`;
    c.fillStyle = m.color || '#e2e8f0';
    c.fillText(m.name, m.x, m.y + fontSize * 0.8);
  }
  c.textAlign = 'start';
  c.textBaseline = 'alphabetic';
}

function handleResize() {
  if (!canvas.value || !canvasWrap.value) return;
  canvas.value.width = canvasWrap.value.clientWidth;
  canvas.value.height = canvasWrap.value.clientHeight;
  // 首次进入期间布局仍在定稿（时间轴面板占位会让画布变矮）→ 重新适屏，别留一个错的镜位；
  // 用户已经开始操作后就只重绘，不动镜头。
  if (initialFitPending) fitToView();
  else render();
}

// ═══════════════════════════════════════════
// v2 智能放置与派生
// ═══════════════════════════════════════════

function placeSmartBurg(world) {
  const baseMapData = baseMap.value;
  if (!baseMapData?.heightmap?.grid?.points) return;
  const hm = baseMapData.heightmap;
  const pts = hm.grid.points;
  const spacing = hm.grid.spacing || 14.4;
  const searchRadius = 100;
  let bestI = -1;
  let bestScore = -Infinity;

  for (let i = 0; i < pts.length; i++) {
    const h = hm.h[i];
    if (h < 20 || h > 70) continue;
    const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
    const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
    const clickDist = Math.hypot(px - world.x, py - world.y);
    if (clickDist > searchRadius) continue;

    let score = -Math.abs(h - 40) * 0.1 - clickDist * 0.05;
    // 靠近已有 burg 则减分（避免堆叠）
    for (const b of burgs.value) {
      const bd = Math.hypot(b.x - px, b.y - py);
      if (bd < spacing * 3) score -= 10;
    }

    if (score > bestScore) {
      bestScore = score;
      bestI = i;
    }
  }

  if (bestI >= 0) {
    const px = Array.isArray(pts[bestI]) ? pts[bestI][0] : pts[bestI].x;
    const py = Array.isArray(pts[bestI]) ? pts[bestI][1] : pts[bestI].y;
    const burgId = `burg_${Date.now()}`;
    if (!baseMapData.burgs) {
      baseMapData.burgs = [];
    }
    const sizeDef = BURG_SIZES.find(s => s.id === selectedBurgSize.value) || BURG_SIZES[1];
    const newBurg = {
      id: burgId,
      name: `新${sizeDef.name} ${baseMapData.burgs.length + 1}`,
      x: px,
      y: py,
      capital: sizeDef.id === 'capital' ? 1 : 0,
      population: sizeDef.basePop,
      size: sizeDef.id,
    };
    store.addBaseMapBurg(baseMapKey.value, newBurg);
  }
}

function openBurgEditor(burg) {
  editingBurg.value = { ...burg };
  burgEditorOpen.value = true;
}

function saveBurgEditor() {
  if (!editingBurg.value) return;
  const burg = baseMap.value?.burgs?.find(b => b.id === editingBurg.value.id);
  if (burg) {
    Object.assign(burg, editingBurg.value);
    store.baseMaps = {
      ...store.baseMaps,
      [baseMapKey.value]: {
        ...baseMap.value,
        burgs: [...baseMap.value.burgs],
        updatedAt: new Date().toISOString(),
      },
    };
  }
  burgEditorOpen.value = false;
  editingBurg.value = null;
  render();
}

function closeBurgEditor() {
  burgEditorOpen.value = false;
  editingBurg.value = null;
}

function generateAndShowRivers() {
  const rivers = store.generateRivers(baseMapKey.value);
  autoRivers.value = rivers;
  render();
}

function deriveLayers() {
  store.deriveAllLayers(baseMapKey.value);
  render();
}

async function exportPNG() {
  const cvs = canvas.value;
  const scale = 2;
  const offscreen = document.createElement('canvas');
  offscreen.width = cvs.width * scale;
  offscreen.height = cvs.height * scale;
  const ctx = offscreen.getContext('2d');
  ctx.scale(scale, scale);
  ctx.translate(cameraX.value, cameraY.value);
  ctx.scale(cameraScale.value, cameraScale.value);
  drawBackground(ctx);
  drawProvinces(ctx);
  if (showBurgs.value) drawBurgs(ctx);
  drawLabels(ctx);
  // A8：导出必须与画布一致（M2/A2 的教训：导出各写一套 → 导出的东西画布上看不见，且不报错）
  drawPolityLabels(ctx);
  ctx.font = '14px "PingFang SC", sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  const scenarioName = selectedScenario?.value?.name || '未命名剧本';
  const eraLabel = selectedScenario?.value?.era?.roman || '';
  const watermark = eraLabel ? `${eraLabel} · ${scenarioName}` : scenarioName;
  ctx.fillText(watermark, 10, cvs.height / scale - 10);
  offscreen.toBlob(async (blob) => {
    if (!blob) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result;
      const result = await window.sitianAPI.saveExportFile({ dataUrl, defaultName: `scenario-${Date.now()}.png` });
      if (!result?.success) {
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = `scenario-${Date.now()}.png`;
        a.click();
      }
    };
    reader.readAsDataURL(blob);
  }, 'image/png');
}

let resizeObserver = null;

onMounted(async () => {
  const cvs = canvas.value;
  const wrap = canvasWrap.value;
  cvs.width = wrap.clientWidth;
  cvs.height = wrap.clientHeight;
  ctx.value = cvs.getContext('2d');

  // P0: 恢复上次使用的底图键（全局配置）——但只在**当前项目里确实存在**这张底图时才用
  if (window.sitianAPI?.getCurrentBaseMapKey) {
    const savedKey = await window.sitianAPI.getCurrentBaseMapKey();
    if (savedKey && store.baseMaps?.[savedKey]) {
      baseMapKey.value = savedKey;
    }
  }

  // 🔴 不再默默造一张叫「德斯特星」的空底图（2026-09-20 用户决策）：
  //    ① 那是暮雨自用剧本地图的名字，硬编码进产品 = 用真实剧本当示例；
  //    ② 每个新项目一打开剧本模式就凭空多出一张假底图（还会随保存写进项目文件）。
  //    现在：没有可用底图就留空 → 画布显示「还没有底图」提示，由用户导入 .map 或懒建。
  if (!store.baseMaps?.[baseMapKey.value]) {
    baseMapKey.value = availableBaseMaps.value[0]?.id || '';
  }

  cvs.addEventListener('mousedown', onMouseDown);
  cvs.addEventListener('mousemove', onMouseMove);
  cvs.addEventListener('mouseup', onMouseUp);
  cvs.addEventListener('mouseleave', onCanvasMouseLeave);
  cvs.addEventListener('click', onCanvasClick);
  cvs.addEventListener('dblclick', onCanvasDblClick);
  cvs.addEventListener('wheel', onWheel, { passive: false });
  cvs.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('click', () => { contextMenu.value.show = false; });
  window.addEventListener('sitian:history-jump', onHistoryJump);

  resizeObserver = new ResizeObserver(handleResize);
  resizeObserver.observe(wrap);

  lastFitKey = baseMapKey.value;
  lastFitCount = baseMap.value?.terrain?.length || 0;
  // 🔴 先算镜位、再画第一帧（P-0 实测）：不这么做，首帧用的是未适屏相机 (0,0,1)，
  //    画布上只有底网格（非背景像素 7%），适屏帧要等 setTimeout(100) 才来 ——
  //    用户观感就是「打开底图编辑卡住 / 画布空白，滚一下才出现」。
  if (baseMap.value?.terrain?.length) {
    fitToView();               // fitToView 内部已 render()
  } else {
    render();
  }
  // 布局定稿（时间轴面板占位会让画布变矮）后再补一次适屏；用户一交互就交给用户
  initialFitPending = true;
  settleFitTimer = setTimeout(() => {
    settleFitTimer = null;
    if (initialFitPending) fitToView();
  }, 250);

  // 时间轴游标落到第一个剧本（数据可能刚由 scenarios.json 异步载入）
  resetTimelineToStart();
  setTimeout(resetTimelineToStart, 300);
});

onUnmounted(() => {
  if (resizeObserver) resizeObserver.disconnect();
  if (settleFitTimer) { clearTimeout(settleFitTimer); settleFitTimer = null; }
  if (provinceGridTimer) { clearTimeout(provinceGridTimer); provinceGridTimer = null; }
  if (tlRafId != null) { cancelAnimationFrame(tlRafId); tlRafId = null; }
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('sitian:history-jump', onHistoryJump);
  if (snapMarkerTimer) { clearTimeout(snapMarkerTimer); snapMarkerTimer = null; }
  if (snapFeedbackTimer) { clearTimeout(snapFeedbackTimer); snapFeedbackTimer = null; }
  rasterCache.clear();
});

function onHistoryJump() {
  // 撤销/重做后重新对齐选中引用（updateBaseProvince 会生成新对象）
  const sp = selectedProvince.value;
  if (sp) {
    const fresh = baseMap.value?.terrain?.find(p => p.id === sp.id);
    if (fresh && fresh !== sp) selectedProvince.value = fresh;
  }
  render();
}
watch([rasterLayer, showRivers, showRoutes, colorMode, showBiomes, showBorders, showLabels, showPolityLabels], () => render());
// 网格显示选项：变了就重绘（网格只作为涂抹反馈；主渲染永远是多边形）
watch([provMeshNoStar, provMeshBorders], () => {
  if (PROVINCE_GRID_TOOLS.has(tool.value)) scheduleProvinceGrid();
  render();
});

// 切换底图 → 作废离屏栅格缓存（不同地图的网格数据不同）
watch(baseMapKey, () => {
  rasterCache.clear();
  invalidateMinimap();               // 换图 → 小地图缩略图与包围盒都要重算
  // Phase 3：省份网格随底图切换（目标省份、省界缓存、套索态都要重置）
  provBrushTarget.value = 1;
  provStrokeActive = false;
  provLassoActive = false;
  provLassoPoints.value = [];
  provinceBrush.invalidateBorders();
  provinceGridRev.value++;           // 网格引用随底图切换变化，必须让 provinceMeshOn 重算
  provinceGridReady.value = false;
  if (PROVINCE_GRID_TOOLS.has(tool.value)) scheduleProvinceGrid();
  render();
});

// 🔴 底图数据可能**晚于组件挂载**到达：只读态（未打开项目）下底图导入被写闸门拒绝、
//    项目里暂时没有底图后再「导入知识库内容」、外部导入 scenarios.json……
//    而 baseMapKey 只在 onMounted 解析一次 → key 停在 '' ⇒ baseMap 恒 undefined
//    ⇒ watch(baseMap) 永不触发 ⇒ 画布永久空白（P-0 实测：注入真实载荷后 0 帧重绘，
//    连按 F 都没用，因为 fitToView 在「没有省份」时直接 return）。
//    数据到了必须自动选中一张，「打开就空白」不能再靠用户重启/重进。
watch(availableBaseMaps, (list) => {
  if (!list.length) return;
  if (!baseMapKey.value || !store.baseMaps?.[baseMapKey.value]) {
    baseMapKey.value = list[0].id;   // watch(baseMapKey) 会负责作废缓存 + 适屏 + 重绘
  }
});

// 关闭城镇图层时同时收起悬停/选中态（避免残留浮层）
watch(showBurgs, (visible) => {
  if (!visible) {
    hoveredBurg.value = null;
    selectedBurg.value = null;
  }
  render();
});

// 换图或省份增删时自动适应视图；编辑顶点/改名不打断当前镜头
watch([baseMapKey, () => baseMap.value?.terrain?.length || 0], ([key, count]) => {
  if (!count) return;
  if (key === lastFitKey && count === lastFitCount) return;
  lastFitKey = key;
  lastFitCount = count;
  setTimeout(fitToView, 50);
});

watch(baseMap, () => {
  // updateBaseProvince 会生成新对象，重新对齐选中引用，避免读到旧数据
  const sp = selectedProvince.value;
  if (sp) {
    const fresh = baseMap.value?.terrain?.find(p => p.id === sp.id);
    if (fresh && fresh !== sp) selectedProvince.value = fresh;
  }
  invalidateMinimap();          // 几何变了 → 小地图缩略图与包围盒作废（否则省界改了缩略图不动）
  render();
}, { deep: true });
</script>

<style scoped>
.scenario-map-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  /* 小窗口（或工具栏两行展开）时内容会超出——允许滚动，别把画布挤成 0 高 */
  overflow: auto;
  background: #0f1a2e;
}

/* 🔴 工具栏是**多行**结构（P0 第二块重整）：原来 `.scenario-toolbar` 在第 128 行就被提前
   `</div>` 闭合，后面十几组控件全都掉到容器层 → 只有第一行有工具栏底色，其余几行是裸的
   （「工具看着挤在一起 / 分不清哪排管什么」的真因）。现在：工具栏 = 竖直列，每行一个
   `.toolbar-row`（自动换行、有底色与分隔），行内才是 `.tool-group`。 */
.scenario-toolbar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 12px;
  background: #1e293b;
  border-bottom: 1px solid #334155;
  align-items: stretch;
}

.toolbar-row {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  min-height: 34px;
}
/* 整行为空（该行的控件都被 v-if 关掉）→ 不留空档 */
.toolbar-row:not(:has(> *)) { display: none; }

/* P3：按任务分层 —— 主行只放 4 个任务工具 + 「更多」；高级工具与开关收在 .toolbar-more 里。
   ⚠️ 不要把这些控件再摊回主行：主行的可见控件数由 test_65 守着（≤6）。 */
.primary-row { gap: 4px; }
.more-toggle { display: inline-flex; align-items: center; gap: 3px; padding: 0 8px; }
.more-toggle.has-advanced { box-shadow: inset 0 0 0 1px var(--accent); }
.toolbar-more {
  display: flex; flex-direction: column; gap: 2px;
  border-top: 1px solid var(--border, #2a3038);
  max-height: 42vh; overflow-y: auto;
}
.toolbar-more .toolbar-row { background: transparent; }

.row-label {
  color: #94a3b8;
  font-size: 11px;
  white-space: nowrap;
}

.row-hint {
  color: #94a3b8;
  font-size: 11px;
  padding: 2px 8px;
  border: 1px dashed #475569;
  border-radius: 10px;
}
.row-hint.ready { color: #86efac; border-color: #3f6212; }

.back-btn {
  padding: 6px 12px;
  border: 1px solid #475569;
  background: #334155;
  color: #e2e8f0;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  margin-right: 8px;
}

.back-btn:hover { background: #475569; }

.tool-group {
  display: flex;
  gap: 4px;
  align-items: center;
}

.tool-group label {
  color: #94a3b8;
  font-size: 11px;
}

.tool-group select {
  background: #334155;
  color: #e2e8f0;
  border: 1px solid #475569;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
}

.check-label {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: #94a3b8;
  cursor: pointer;
}

.tool-group button {
  width: 32px;
  height: 32px;
  border: 1px solid #475569;
  background: #334155;
  color: #e2e8f0;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
}

.tool-group button:hover { background: #475569; }
.tool-group button.active { background: #5b21b6; border-color: #7c3aed; }
.tool-group button:disabled { opacity: 0.4; cursor: not-allowed; }
.tool-group button.saving { animation: pulse 1s infinite; }

/* 笔刷设置 */
.brush-settings {
  gap: 8px;
}
.brush-settings .check-label {
  gap: 4px;
}
.brush-slider {
  width: 80px;
  vertical-align: middle;
}
.basemap-select {
  min-width: 120px;
}

.brush-biome-select {
  background: #334155;
  color: #e2e8f0;
  border: 1px solid #475569;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 11px;
  vertical-align: middle;
}


/* 旧「按钮式时间轴条」的样式已随入口一起移除（现由 ScenarioTimeline.vue 承载） */
.tl-status { color: #94a3b8; }
.tl-status b { color: #e2e8f0; font-variant-numeric: tabular-nums; }
.tl-warn { color: #fbbf24; }
.export-msg { color: #a78bfa; }

.polity-palette {
  display: flex;
  gap: 4px;
  padding: 6px 12px;
  background: #172033;
  border-bottom: 1px solid #334155;
  flex-wrap: wrap;
  align-items: center;
}

.palette-title {
  color: #94a3b8;
  font-size: 11px;
  margin-right: 4px;
}

.polity-swatch {
  width: 28px;
  height: 28px;
  border-radius: 4px;
  border: 2px solid transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #fff;
  font-weight: 600;
  text-shadow: 0 1px 2px rgba(0,0,0,0.5);
  position: relative;
}

.polity-swatch:hover { transform: scale(1.1); }
.polity-swatch.active { border-color: #ffd700; box-shadow: 0 0 6px rgba(255, 215, 0, 0.5); }

.polity-name {
  display: none;
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  background: #1e293b;
  color: #e2e8f0;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11px;
  white-space: nowrap;
  z-index: 100;
  border: 1px solid #475569;
}

.polity-swatch:hover .polity-name { display: block; }

/* A8：势力显示信息编辑（深色条上的内联编辑，配色跟色板一致） */
.polity-editor {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: 10px;
  padding-left: 10px;
  border-left: 1px solid #334155;
  flex-wrap: wrap;
}

.polity-editor label {
  display: flex;
  align-items: center;
  gap: 4px;
  color: #94a3b8;
  font-size: 11px;
}

.polity-editor input {
  width: 110px;
  padding: 3px 6px;
  background: #0f1a2e;
  border: 1px solid #475569;
  border-radius: 4px;
  color: #e2e8f0;
  font-size: 12px;
}

.polity-editor input:focus { outline: none; border-color: #ffd700; }
.polity-editor input:disabled { opacity: 0.55; cursor: not-allowed; }

.polity-editor-hint { color: #64748b; font-size: 11px; }

.polity-fullname { font-weight: 600; }

.polity-swatch.clear { background: #475569; border-color: #64748b; }

.scenario-canvas-wrap {
  flex: 1;
  /* 小窗口下不许被工具栏/时间轴挤扁：<canvas> 高度为 0 会让任何像素读取直接抛
     IndexSizeError（实测：getImageData 源高 0）。低于此高度时整块视图改为可滚动。 */
  min-height: 200px;
  position: relative;
  overflow: hidden;
}

.scenario-canvas-wrap canvas {
  width: 100%;
  height: 100%;
  display: block;
  cursor: grab;
}

/* 「还没有底图」空态提示：居中、不拦事件（绝不挡住画布交互） */
.scenario-empty-hint {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  max-width: 420px;
  padding: 16px 20px;
  text-align: center;
  border: 1px dashed rgba(148, 163, 184, 0.55);
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.72);
  color: #cbd5e1;
  pointer-events: none;
}
.scenario-empty-hint .eh-title { margin: 0 0 6px; font-size: 14px; color: #e2e8f0; }
.scenario-empty-hint .eh-line { margin: 0; font-size: 12px; line-height: 1.6; }

/* 渲染护栏提示（状态栏内，红黄警示 + 可点击恢复） */
.render-guard { color: #fbbf24; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }
.render-guard .rg-btn {
  padding: 1px 7px;
  font-size: 11px;
  color: #fbbf24;
  background: transparent;
  border: 1px solid #b45309;
  border-radius: 4px;
  cursor: pointer;
}
.render-guard .rg-btn:hover { background: rgba(251, 191, 36, 0.12); }

.scenario-status-bar {
  padding: 6px 12px;
  background: #1e293b;
  border-top: 1px solid #334155;
  color: #94a3b8;
  font-size: 11px;
  display: flex;
  gap: 16px;
}

.draw-hint { color: #a78bfa; font-weight: 600; }
.snap-feedback { color: #34d399; font-weight: 600; }
.snap-feedback.edge { color: #22d3ee; }
.layer-warn { color: #fbbf24; cursor: help; }
.selected-provity { color: #fbbf24; }
.selected-burg { color: #ffd700; font-weight: 600; }

.selected-polity {
  display: flex;
  align-items: center;
  gap: 4px;
}

.polity-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}

.save-status { margin-left: auto; }
.save-status.saved { color: #4ade80; }
.save-status.error { color: #f87171; }
.save-status.saving { color: #fbbf24; }

/* 右键菜单 */
.context-menu {
  position: absolute;
  background: #1e293b;
  border: 1px solid #475569;
  border-radius: 8px;
  padding: 4px 0;
  z-index: 1000;
  min-width: 160px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}

.ctx-item {
  padding: 8px 16px;
  color: #e2e8f0;
  font-size: 12px;
  cursor: pointer;
}

.ctx-item:hover { background: #334155; }
.ctx-item.danger { color: #f87171; }
.ctx-item.disabled { color: #64748b; cursor: default; }

.ctx-divider {
  height: 1px;
  background: #334155;
  margin: 4px 0;
}

/* 省份属性面板 */
.province-props {
  position: absolute;
  top: 100px;
  right: 16px;
  width: 280px;
  background: #1e293b;
  border: 1px solid #475569;
  border-radius: 12px;
  padding: 16px;
  z-index: 100;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}

.props-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.props-name {
  flex: 1;
  background: #334155;
  border: 1px solid #475569;
  border-radius: 4px;
  padding: 6px 8px;
  color: #e2e8f0;
  font-size: 14px;
  font-weight: 600;
}

.props-close {
  background: none;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  font-size: 14px;
}

.props-close:hover { color: #e2e8f0; }

.props-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.props-row label {
  min-width: 70px;
  font-size: 12px;
  color: #94a3b8;
}

.props-row input[type="text"], .props-row select {
  flex: 1;
  background: #334155;
  border: 1px solid #475569;
  border-radius: 4px;
  padding: 4px 8px;
  color: #e2e8f0;
  font-size: 12px;
}

.props-stats {
  font-size: 11px;
  color: #64748b;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #334155;
}

/* 模态框 */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
}

.modal-dialog {
  background: #1e293b;
  border: 1px solid #475569;
  border-radius: 12px;
  padding: 20px;
  max-width: 500px;
  width: 90%;
  max-height: 80vh;
  overflow-y: auto;
  color: #e2e8f0;
}

.modal-dialog h3 { margin: 0 0 16px; font-size: 16px; }

.scenario-list { margin-bottom: 20px; }

.scenario-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid #334155;
}

.item-era { font-weight: 600; color: #7c3aed; min-width: 20px; }
.item-name { flex: 1; font-size: 13px; }
.item-years { font-size: 11px; color: #64748b; }

.item-delete {
  background: none;
  border: none;
  cursor: pointer;
  opacity: 0.5;
}

.item-delete:hover { opacity: 1; }

.new-scenario-form {
  border-top: 1px solid #334155;
  padding-top: 16px;
}

.new-scenario-form h4 { margin: 0 0 12px; font-size: 14px; }

.form-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.form-row label {
  min-width: 80px;
  font-size: 12px;
  color: #94a3b8;
}

.form-row input[type="text"], .form-row textarea {
  flex: 1;
  background: #334155;
  border: 1px solid #475569;
  border-radius: 4px;
  padding: 6px 8px;
  color: #e2e8f0;
  font-size: 12px;
}

.form-row input.short-input { max-width: 60px; }
.form-row.checkbox label { min-width: auto; }

.form-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 12px;
}

.form-actions button {
  padding: 6px 16px;
  border: 1px solid #475569;
  background: #334155;
  color: #e2e8f0;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}

.form-actions button:first-child { background: #5b21b6; border-color: #7c3aed; }
.form-actions button:disabled { opacity: 0.4; cursor: not-allowed; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* 图层锁定面板 */
.layer-lock-panel {
  position: absolute;
  top: 100px;
  right: 16px;
  width: 200px;
  background: #1e293b;
  border: 1px solid #475569;
  border-radius: 12px;
  padding: 12px;
  z-index: 100;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}

.layer-lock-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #e2e8f0;
}

.layer-lock-close {
  background: none;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  padding: 4px;
}

.layer-lock-close:hover { color: #e2e8f0; }

.layer-lock-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.layer-lock-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 6px;
  border-radius: 4px;
}

.layer-lock-row:hover { background: #334155; }

.layer-lock-label {
  font-size: 12px;
  color: #cbd5e1;
}

.layer-lock-btn {
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px;
  opacity: 0.5;
  color: #94a3b8;
}

.layer-lock-btn:hover { opacity: 1; }

.layer-lock-btn.locked {
  opacity: 1;
  color: #fbbf24;
}

/* 撤销历史面板（覆盖 HistoryPanel 默认定位） */
.history-panel {
  top: 100px !important;
  left: 12px !important;
}

/* 聚落编辑器面板 */
.burg-editor-panel {
  position: absolute;
  top: 100px;
  right: 16px;
  width: 280px;
  background: #1e293b;
  border: 1px solid #475569;
  border-radius: 12px;
  padding: 16px;
  z-index: 100;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}

.burg-editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  font-size: 14px;
  font-weight: 600;
  color: #e2e8f0;
}

.burg-editor-close {
  background: none;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  padding: 4px;
}

.burg-editor-close:hover { color: #e2e8f0; }

.burg-editor-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.burg-editor-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.burg-editor-row label {
  min-width: 60px;
  font-size: 12px;
  color: #94a3b8;
}

.burg-editor-row input[type="text"],
.burg-editor-row input[type="number"],
.burg-editor-row select {
  flex: 1;
  background: #334155;
  border: 1px solid #475569;
  border-radius: 4px;
  padding: 4px 8px;
  color: #e2e8f0;
  font-size: 12px;
}

.burg-editor-row.checkbox-row label {
  min-width: auto;
}

.burg-editor-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 8px;
}

.burg-editor-actions button {
  padding: 6px 16px;
  border: 1px solid #475569;
  background: #334155;
  color: #e2e8f0;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}

.burg-editor-actions button.burg-save-btn {
  background: #5b21b6;
  border-color: #7c3aed;
}
</style>
