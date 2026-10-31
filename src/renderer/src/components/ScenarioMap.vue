<template>
  <div class="scenario-map-container" :class="{ immersive }">
    <!-- 沉浸模式细顶条（2026-10-17 P0）：默认态下不渲染；只留 返回 / 剧本名 / 年份 / 小地图 / 退出 -->
    <div v-if="immersive" class="immersive-bar" data-testid="immersive-bar">
      <button class="imb-btn" @click="onBackClick">{{ basemapEditMode ? '← 日常视图' : '← 退出剧本' }}</button>
      <!-- 换剧本（P0-1）：沉浸态左侧剧本列表是隐藏的，没有这个按钮就只能先退出沉浸再换 -->
      <button class="imb-btn" data-testid="imb-picker" title="回到剧本选择（卡片墙）"
              @click="$emit('picker')">换剧本</button>
      <span class="imb-title">{{ selectedScenario?.name || '历史剧本' }}</span>
      <span class="imb-year" data-testid="imb-year">{{ tlDate?.y ?? '—' }} 年</span>
      <span class="imb-spacer"></span>
      <button class="imb-btn" data-testid="imb-minimap" :title="showMinimap ? '隐藏小地图' : '显示小地图'"
              @click="toggleMinimap">{{ showMinimap ? '小地图 ✓' : '小地图' }}</button>
      <button class="imb-btn" data-testid="imb-exit" title="退出沉浸模式（Ctrl+I）"
              @click="immersive = false">退出沉浸 (Ctrl+I)</button>
    </div>
    <!-- D3：地形注记面板 —— **必须放在顶栏之外**。
         面板曾跟着「造陆」放在 `toolbar-more`（v-if=moreOpen）里：底图编辑模式下「更多」是收起的，
         于是"按钮点了、面板不出现"（test_154 实测）。Teleport 的目标在 body，但 **Teleport 自身
         仍在 v-if 的子树里** —— 父节点不渲染，它就不存在。 -->
    <Teleport to="body">
      <div v-if="terrainLabelsOpen" class="gen-float" data-testid="terrain-labels-wrap">
        <div class="resample-panel">
          <TerrainLabelsPanel
            :base-map-key="baseMapKey"
            :has-heightmap="baseMapHasHeightmap"
            :pick="terrainLabelPick"
            @applied="applyTerrainLabelsResult"
            @pick="startTerrainLabelPick"
            @pick-done="onTerrainLabelPickDone"
            @pick-cancel="cancelTerrainLabelPick"
            @close="terrainLabelsOpen = false"
          />
        </div>
      </div>
    </Teleport>
    <!-- 顶栏：工具 + 模式切换 -->
    <div class="scenario-toolbar" :class="{ dim: capsuleDim }" @mousemove="pokeCapsule">
      <!-- 第 1 行：**按任务分层的 4 个主工具** + 「更多」（P3）
           默认可见控件 = 6 个（退出剧本 / 选择 / 自由绘制 / 涂归属 / 顶点编辑 / 更多），
           其余工具与开关全部收进「更多」—— 能力一个都不减，只是不再糊在一排里。 -->
      <!-- 🔴 2026-10-18 第十七修（暮雨：「我甚至觉得这玩意得进底图编辑，**底图编辑要单开一个编辑模式**，
           不要和日常的剧本编辑混在一起」）：底图/地理类工具从「更多」里拎出来，收进一个**显式模式**。
           此前的形态是"日常动作（选择/画省份/改归属/改形状）+ 地理类（河流/地形/高度/群系/文化/宗教/
           道路/地貌/地名/标记/聚落）全糊在同一个「更多」里"——**编辑对象不同（地块 vs 覆盖其上的历史归属），
           却在同一排按钮里**，这正是用户说的"混"。
           ⚠️ 只是**分组与可见性**，不改任何工具语义：既有用例点工具仍走同一个 `setTool()`，
           模式没开时自动打开（见 `setTool` 的门），所以 60+ 个既有用例零迁移。
           ⚠️ 开关**不能放主行**：主行的可见控件数由 `test_65` / `test_97` 硬守 ≤6
           （放进去实测 7 个、两条用例同时红）。 -->
      <div class="toolbar-modes" data-testid="toolbar-modes">
        <button
          class="basemap-edit-toggle"
          data-testid="basemap-edit-toggle"
          :class="{ active: basemapEditMode }"
          :title="basemapEditMode
            ? '底图编辑模式（已开）— 这一行是**画地理**（地形/河流/道路/文化…）；关掉它回到日常剧本编辑（省份/归属/剧本）'
            : '底图编辑模式（关）— 点开：地形 / 河流 / 道路 / 地貌 / 地名 / 文化 / 宗教 等**底图与地理**工具集中在这里，与日常的省份/归属编辑分开'"
          @click="toggleBasemapEditMode()"
        ><Icon name="mountain" :size="13"/>底图编辑{{ basemapEditMode ? ' ✓' : '' }}</button>
        <span class="mode-hint" data-testid="mode-hint">{{ basemapEditMode
          ? '底图 / 地理编辑中（省份与归属仍可用，但没有混在这一行）'
          : '日常剧本编辑（省份 / 归属 / 剧本）' }}</span>
      </div>

      <!-- 底图编辑模式的**地理行**（2026-10-18 第十七修）：只在模式开着时出现。
           为什么是"一行"而不是"藏进更多"：暮雨要的是**一眼看出现在的编辑对象换人了**——
           藏进下拉里等于还是"混"。 -->
      <div v-if="basemapEditMode" class="toolbar-row basemap-row" data-testid="basemap-row">
        <span class="row-label basemap-row-label"><Icon name="layers" :size="12"/> 底图/地理：</span>
        <button
          v-for="t in BASEMAP_TOOLS" :key="t.id"
          :class="{ active: tool === t.id }"
          :data-testid="'basemap-tool-' + t.id"
          :title="t.title"
          @click="setTool(t.id)"
        ><Icon :name="t.icon" :size="14"/>{{ t.label }}</button>
        <!-- 「笔刷建省」= 像画图软件一样**涂出一块地**（2026-10-22）。
             与「画省份」的分工：画省份 = 描一圈精确边界（要闭合、会贴骨架）；
             笔刷建省 = 抹一条就成一块省（不闭合、涂抹过程就是最终形状）。
             放在「改省界」旁边而不是主行：主行的可见控件数由 test_97 硬守（日常 4 / 底图编辑 6）。 -->
        <button
          :class="{ active: tool === 'provincePaint' }"
          data-testid="basemap-tool-provincePaint"
          title="笔刷建省 (Shift+B) — 按住左键像涂色一样抹，松手把抹过的范围长成**一个省**：不用闭合、不会画出自交怪形，涂抹过程就是最终形状。已有省份的地不会被抢（新省只长在空地上）；一笔 = 一条撤销"
          @click="setTool('provincePaint')"
        ><Icon name="brush" :size="14"/>笔刷建省</button>
        <!-- 「改省界」= 原先挂在日常行的那个几何笔刷（把笔迹并进所选省份）。
             2026-10-20：它与「涂归属」同名不同义，用户实测「好像在生造省份」。
             现在改名并收进底图编辑 —— 日常行只留**真的改归属**那一个。 -->
        <button
          :class="{ active: tool === 'provinceBrush' }"
          data-testid="basemap-tool-provinceBrush"
          title="改省界 (Shift+Q) — 按住涂抹，把笔迹并进下面「划归到」所选的那个省（**改的是省界形状，不是势力归属**）；相交的邻省会相应让出这块地。一笔 = 一条撤销。想改「这块地归哪个势力」请回日常行点「涂归属」"
          @click="setTool('provinceBrush')"
        ><Icon name="pencil" :size="14"/>改省界</button>
        <!-- D3（2026-10-26）：**地形注记** —— 山系名沿脊线排。它是**地理数据**（不是历史归属），
             所以住在底图编辑行；更多菜单里不再重复一份（同一个 testid 两处 = 用例命中哪个看顺序）。 -->
        <button
          v-if="baseMapKey"
          data-testid="basemap-terrain-labels"
          :class="{ active: terrainLabelsOpen }"
          title="地形注记 —— 从高度图抽山脊候选，逐条命名；名字沿脊线排（一条 Ctrl+Z 可退回）"
          @click="toggleTerrainLabelsPanel"
        ><Icon name="type" :size="14"/>地形注记</button>
        <!-- 2026-10-21：出口就在工作行末尾。用户「误进入底图编辑、又找不到退出口，
             点左上角返回把整个剧本退了」——不能只靠顶栏那个按钮。 -->
        <button class="basemap-exit" data-testid="basemap-exit"
                title="退出底图编辑，回到日常剧本编辑（省份 / 归属 / 剧本）—— 不会离开历史剧本"
                @click="toggleBasemapEditMode()">← 日常视图</button>
      </div>

      <div class="toolbar-row primary-row">

        <!-- 🔴 2026-10-21：这个按钮**先退子模式、再退模块**。
             暮雨实测：在底图编辑里点左上角「← 返回」，以为是退底图编辑，结果整个历史剧本被退掉。
             现在：底图编辑中 = 「← 返回日常」（只关底图编辑）；日常态 = 「← 退出剧本」（才离开模块）。
             模块级退出还有顶部「世界观」页签，这里不再是唯一出口。 -->
        <button @click="onBackClick" class="back-btn" data-testid="scenario-back-btn"
                :title="basemapEditMode
                  ? '退出底图编辑，回到日常剧本编辑（不会离开历史剧本）'
                  : '退出历史剧本，回到世界页（顶部「世界观」页签同样可以离开）'">
          {{ basemapEditMode ? '← 日常视图' : '← 退出剧本' }}
        </button>
        <button
          :class="{ active: tool === 'select' }"
          @click="setTool('select')"
          title="选择 (V，默认) — 拖动平移画布，点击选中省份"
        ><Icon name="hand" :size="15"/>选择</button>
        <button
          v-if="basemapEditMode"
          :class="{ active: tool === 'draw' }"
          @click="setTool('draw')"
          title="画省份 · 自由绘制 (B) — 按住沿轮廓拖一圈 = 建一个省；单击 = 描点；Shift = 不吸附骨架（属于底图编辑）"
        ><Icon name="pencil" :size="15"/>画省份</button>
        <button
          :class="{ active: tool === 'ownerBrush' }"
          data-testid="owner-brush-btn"
          @click="setTool('ownerBrush')"
          title="涂归属 (Q) — 按住在地图上涂：碰到的省改成当前势力。一笔 = 一条撤销；Alt 点一下 = 吸管"
        ><Icon name="brush" :size="15"/>涂归属</button>
        <button
          v-if="basemapEditMode"
          :class="{ active: tool === 'vertex' }"
          @click="setTool('vertex')"
          title="顶点编辑 (G) — 拖拽顶点改形状（属于底图编辑）；Shift+拖动可框选一批顶点"
        >⬡改形状</button>
        <button
          class="more-toggle"
          :class="{ active: moreOpen, 'has-advanced': advancedToolActive }"
          @click="moreOpen = !moreOpen"
          title="更多 — 拆分 / 合并 / 点击填充 / 描轮廓 / 擦除 / 聚落 / 标记 / 道路，以及吸附与底图"
        ><Icon name="chevron-down" :size="13"/> 更多</button>
        <span v-if="snapToGridEnabled && (tool === 'draw' || tool === 'vertex')" class="draw-hint">吸附：50px 网格（Shift 临时禁用）</span>
      </div>

      <!-- 第 2 行：省份 —— 几何只有一个来源（多边形）；网格只是涂抹时的中间层 -->
      <!-- 「变更归属」的省份选项：选到省份类工具（或自己打开「更多」）才出现 ——
           默认那 6 个可见控件里没有它（见 P3 / test_65）。 -->
      <div class="toolbar-row province-row" v-if="provinceRowVisible">
        <label class="row-label">省份：</label>
        <!-- 日常模式里原本没有「画省份」（它只在底图编辑的主行出现）→ 空底图上无从下手。
             这个入口点一下 = 自动进「底图编辑」+ 选好画省份（`setTool` 的门在 2681 行）。 -->
        <button
          v-if="!basemapEditMode"
          data-testid="province-draw-entry"
          title="画省份 · 自由绘制 (B) — 会先进入「底图编辑」；按住左键绕一圈，松手成省"
          @click="startDrawingProvince()"
        ><Icon name="pencil" :size="15"/>画省份</button>
        <!-- 2026-10-22：空底图上"想随便涂一块地"的人不该被要求先画一个闭合圈 ——
             笔刷建省 = 像画图一样抹（同一入口也会打开底图编辑）。 -->
        <button
          v-if="!basemapEditMode"
          data-testid="province-paint-entry"
          title="笔刷建省 (Shift+B) — 会先进入「底图编辑」；按住左键像涂色一样抹，松手就是一块省（不用闭合）"
          @click="startPaintingProvince()"
        ><Icon name="brush" :size="15"/>笔刷建省</button>
        <!-- 2026-10-20：这里原先还有第二个「涂归属」，点了却是**改省界几何**（把地并进某个省）。
             两个同名按钮两种语义 = 用户实测「好像在生造省份」的直接来源。
             现在这个几何笔刷只出现在「底图编辑」行、并改名「改省界」。 -->
        <button
          :class="{ active: tool === 'provinceLasso' }"
          @click="setTool('provinceLasso')"
          title="自由轮廓 (L) — 按住画一圈，圈内所有格整批划归（不用描点）"
        ><Icon name="pen-tool" :size="15"/>圈选</button>
        <button
          :class="{ active: tool === 'provinceFill' }"
          @click="setTool('provinceFill')"
          title="点击填充 (O) — 点一下把所在封闭区域整块划归；有面积闸门（超过全图 25% 直接拒绝，避免一下填满整块大陆/海洋）"
        ><Icon name="droplet" :size="15"/>点填</button>
        <!-- 🔴 切四五百块省份的两条正路（2026-10-11）：单选一刀一次只切一块，切 400 块要 400 次精确点击 -->
        <button
          :class="{ active: tool === 'polySplit' }"
          @click="setTool('polySplit')"
          title="折线切割 (D) — 逐点画一条折线，双击或 Enter 沿它把省份切成两块（可以沿着海岸/山脊走）；两端可落在省外，会自动延长；Shift = 换哪一半保留原省份身份"
        ><Icon name="route" :size="15"/>折线切分</button>
        <button
          :class="{ active: tool === 'voronoi' }"
          @click="setTool('voronoi')"
          title="批量铺底 (A) — 在陆地范围内播 N 个点，一次性按 Voronoi 切成 N 块省份：共边无缝、不动海岸线、归属与易主记录自动继承给新块、一整批 = 一条撤销"
        ><Icon name="grid" :size="15"/>批量铺底</button>
        <!-- E（2026-10-11）：用户要的"线跟着笔走、相邻省自动重算" ——
             手势与「画省份」相同（按住拖一圈），但做的是**改已有边界**而不是新建省。 -->
        <button
          :class="{ active: tool === 'outline' }"
          data-testid="province-outline-btn"
          @click="setTool('outline')"
          title="描轮廓 (Y) — 按住贴着要改的那条边界拖一圈、松手：笔迹**围住的那块地**改判给**贴着描的那个邻省**，被碰到的邻省**自动重算边界**（共边无缝、不压叠）；未碰到的边界一个点都不动（海岸线保住）；一笔 = 一条撤销。想让它归原主（只修形状）就关掉下面那个勾"
        ><Icon name="pen-tool" :size="15"/>描轮廓</button>
      <!-- ═══ 描轮廓（E）：区域 = 笔迹围出的那块；默认**改判给贴得最紧的邻省** ═══ -->
      <div class="tool-group brush-settings" v-if="tool === 'outline'" data-testid="outline-settings">
        <span class="row-hint"
              title="这套语义是「先并给目标省、再从被碰到的省挖掉」：贴着边界描时基本无缝；区域若探进别省地盘，那块地会两省各留一份（会如实提示百分比）">
          沿边界拖一圈 → 松手改判
        </span>
        <label class="check-label" data-testid="outline-to-neighbor"
               title="开（默认）：围住的那块地改判给**贴着描的那个邻省**——这是「把这块地划过去」。关：归**它原本所属的省**（等于原地修形状，通常看不出变化）">
          <input type="checkbox" v-model="outlineToNeighbor" /> 改判给邻省
        </label>
      </div>
      <!-- ═══ 涂归属（2026-10-20 重做）：**只改势力归属，不动省界几何** ═══
           旧的同名按钮是几何笔刷（把笔迹并进所选省份），用户实测「好像在生造省份」。
           这一块是日常剧本编辑的主路径：选势力 → 按住涂 → 碰到的省一次改归属。 -->
      <div class="tool-group brush-settings" v-if="tool === 'ownerBrush'" data-testid="owner-brush-settings">
        <span class="row-label">涂归属：</span>
        <span class="row-hint" data-testid="owner-brush-polity" :class="{ ready: !!selectedPolity || clearOwnerMode }">
          <template v-if="clearOwnerMode">当前：<b>清除归属</b>（涂到的省变无主）</template>
          <template v-else-if="selectedPolity">当前势力：
            <b :style="{ color: selectedPolity.color || undefined }">{{ selectedPolity.name }}</b>
          </template>
          <template v-else>当前势力：<b>未选</b>（点地图上方「势力：」里的色块）</template>
        </span>
        <label class="check-label" title="笔刷半径（屏幕像素）">
          半径
          <input type="range" v-model.number="provBrushRadius" min="4" max="120" step="1" class="brush-slider" data-testid="owner-brush-radius" />
          {{ provBrushRadius }}px
        </label>
        <span class="row-hint">按住涂 · 一笔一条撤销 · Alt 吸管</span>
      </div>
      <!-- ═══ 笔刷建省（2026-10-22）：像画图软件一样涂出一块地 ═══
           它不选目标省 —— 每一笔都**新建**一个省（要改已有省就切「改省界」）。 -->
      <div class="tool-group brush-settings" v-if="tool === 'provincePaint'" data-testid="province-paint-settings">
        <span class="row-label">笔刷建省：</span>
        <label class="check-label" title="笔刷半径（屏幕像素）—— 画布缩放时手感一致；世界半径 = 像素 / 当前缩放">
          半径
          <input type="range" v-model.number="provBrushRadius" min="1" max="200" step="1" class="brush-slider" />
          {{ provBrushRadius }}px
        </label>
        <span class="row-hint ready"
              title="新省只长在空地上：已有省份覆盖的地方涂不上（免得省份压叠）。要改已有省份的形状请用「改省界」。">
          按住涂 → 松手成一个省 · 一笔一条撤销
        </span>
      </div>
      <div class="tool-group brush-settings" v-if="['provinceBrush','provinceLasso','provinceFill'].includes(tool)">
        <label>划归到：</label>
        <select v-model.number="provBrushTarget" class="brush-biome-select" title="要划归的目标省份">
          <option v-for="o in provinceTargetOptions" :key="o.p.id" :value="o.idx">{{ o.p.name || ('省份 ' + o.idx) }}</option>
        </select>
        <template v-if="tool === 'provinceBrush'">
          <label class="check-label">
            工具
            <select v-model="provBrushTool" class="brush-biome-select" title="改省界 / 抹除 / 平滑（改的是省界形状，不是势力归属）">
              <option v-for="t in provinceBrush.PROVINCE_TOOLS.filter(t => t.key !== 'lasso')" :key="t.key" :value="t.key">{{ t.label }}</option>
            </select>
          </label>
          <label class="check-label" title="笔刷半径（屏幕像素）—— 画布缩放时手感一致；世界半径 = 像素 / 当前缩放">
            半径
            <input type="range" v-model.number="provBrushRadius" min="1" max="200" step="1" class="brush-slider" />
            {{ provBrushRadius }}px
          </label>
        </template>
        <!-- 🔴 锁定海岸线（默认开）：涂归属 / 圈选只在**已有省份范围内**易手，绝不扩张到海面 ——
             海岸线只由「底图编辑」调整（暮雨 2026-10-09 明确要求：「平时维持锁定状态」）。 -->
        <label class="check-label" data-testid="lock-coast"
               title="开启后：涂归属 / 圈选只在已有省份范围内生效，「不会改动海岸线」；要改海岸线请到「底图编辑」里做">
          <input type="checkbox" v-model="lockCoast" /> 锁定海岸线
        </label>
        <button @click="addEmptyProvince" title="新建一个空省份 —— 用「底图编辑 → 改省界」笔刷涂出它的地盘即可"><Icon name="plus" :size="13"/> 新建省份</button>
        <button @click="clearAllProvinceShapes" title="清空所有省份的边界（一次撤销可回退）"><Icon name="refresh-cw" :size="13"/> 重置省界</button>
        <!-- 🔴 P2：边界是**矢量布尔**的结果（目标省并集 / 相交省差集），不经过任何格点 —— -->
        <!-- 旧版那层「格点即时反馈」已删除：格子是 10525 点海岸线被退化成 22 点的根因 -->
        <span class="row-hint ready"
              title="涂完抬手即按多边形布尔改边界：目标省并集、相交省差集，几何只可能更精细">
          矢量边界（精确）
        </span>
      </div>

      <!-- ═══ 折线切割（A）：画一条折线，把省份切成两块 ═══ -->
      <div class="tool-group brush-settings" v-if="tool === 'polySplit'" data-testid="polysplit-settings">
        <span class="row-hint"
              title="折线可以沿着海岸、山脊、历史边界走任意弯；两端落在省外（或省内）都行 —— 不在省上的那一段会自动沿切向延长">
          逐点点击画折线 → 双击 / Enter 切开
        </span>
        <label class="check-label" data-testid="polysplit-side"
               title="切开后哪一半继续用原省份的身份（id / 名字 / 归属 / 时间轴都跟着它）。画布上**绿色那半**就是它；按住 Shift 切换">
          绿色那半保留原省份身份（Shift 切换）
        </label>
        <span class="row-hint" data-testid="polysplit-points">已点 {{ polySplitPoints.length }} 个点</span>
        <button @click="finishPolySplit()" :disabled="polySplitPoints.length < 2"
                data-testid="polysplit-finish"
                title="沿折线切开（也可以双击画布 / 按 Enter）"><Icon name="check" :size="13"/> 切开</button>
        <button @click="clearPolySplit()" title="清空这条折线（Esc 同效）"><Icon name="x" :size="13"/> 取消</button>
      </div>

      <!-- ═══ 批量铺底（B）：Voronoi 一次切出 N 块 ═══ -->
      <div class="tool-group brush-settings" v-if="tool === 'voronoi'" data-testid="voronoi-settings">
        <label class="check-label" title="铺底范围：默认把这张底图上所有陆地省一起重切；也可以只重切选中的那几个省">
          范围
          <select v-model="batchScope" class="brush-biome-select" data-testid="voronoi-scope">
            <option value="land">全部陆地（{{ batchTargetCount }} 省）</option>
            <option value="selection" :disabled="!selectedProvinceIds.length">
              选中的省份（{{ selectedProvinceIds.length }} 个）
            </option>
          </select>
        </label>
        <label class="check-label" title="要切成多少块 —— 直接决定省份密度">
          块数
          <input type="number" v-model.number="batchCount" min="2" max="3000" step="10"
                 class="brush-number" data-testid="voronoi-count" />
        </label>
        <label class="check-label" title="0 = 规整方格（像棋盘）；越大越自然。默认 0.6 左右最像手绘的政区">
          抖动
          <input type="range" v-model.number="batchJitter" min="0" max="0.9" step="0.05" class="brush-slider" />
          {{ batchJitter.toFixed(2) }}
        </label>
        <button @click="autoSeedBatch()" :disabled="batchBusy"
                data-testid="voronoi-autoseed"
                title="按上面的块数自动播种（在大陆里均匀撒点）"><Icon name="sparkles" :size="13"/> 自动播种</button>
        <button @click="rerollBatchSeed()" :disabled="batchBusy"
                title="换一批种子点（形状重来一次，不满意就多点几次）"><Icon name="refresh-cw" :size="13"/> 换一批</button>
        <button @click="clearBatchSeeds()" :disabled="batchBusy" title="清空种子点（可以在画布上手动点）">
          <Icon name="x" :size="13"/> 清空种子（{{ batchSeeds.length }}）
        </button>
        <button @click="runBatchSubdivide()" :disabled="batchBusy || !batchSeeds.length"
                data-testid="voronoi-run"
                title="真的切下去：会替换掉范围内的旧省份，归属与易主记录自动继承；一整批 = 一条撤销（Ctrl+Z 可整批撤回）">
          <Icon name="grid" :size="13"/> 一键切分
        </button>
        <!-- C（2026-10-11）：切分期间必须有出路。500 块的逐块布尔实测 19s，中途用户在画布上
             乱点只会把事件排到队列里、回来一起执行（越点越卡）—— 所以忙时既**遮住画布**，
             也给一个**取消**（取消 = 放弃这一批，落盘与内存都不动，可重来）。 -->
        <button v-if="batchBusy" @click="cancelBatchSubdivide()" data-testid="voronoi-cancel"
                class="batch-cancel" title="取消这一批切分（当前进度会被丢弃，省份与归属都不会改动）">
          <Icon name="x" :size="13"/> 取消
        </button>
        <span class="row-hint" :class="{ ready: !batchBusy }" data-testid="voronoi-status">{{ batchStatus }}</span>
      </div>
      </div>

      <!-- ═══ 河流编辑器：节点操作（2026-10-17）═══════════════════════════════════
           为什么必须做成**带可见文字的常驻行**（而不是只留快捷键）：节点编辑的三个能力
           （加拐点 / 删节点 / 删整条）在没有可见文字时等于没有 —— 本项目的「可发现性纪律」：
           面板入口必须带可见文字，`title` 要悬停才知道、图标认不出来，都不算。
           🔴 位置（这里踩过一脚）：它一度被放进「更多」面板里 —— 而**「河流」这个按钮本身
              就在「更多」里**，用户不展开「更多」时这一行根本不在 DOM 里（真机探针实测
              `river-edit-row: false`）。所以与 `.province-row` 同款：挂在 `.toolbar-more`
              **外面**、只随工具出现（它是"当前这条河的选项"，不是"工具入口"）。 -->
      <!-- 🔴 2026-10-17 第八修·再修（用户：「河流删除也非常不好用」）：
            选中一条河之后，**不管当前是什么工具**都要有一条可见的操作行。
            此前只有「河流」工具里才有这一行 —— 用户用「选择」工具点中河之后
            界面上**没有任何删除入口**，只能猜着按 Delete（他报的正是这个）。
            这一行只放三个动作：删这条 / 进河流工具拖节点 / 取消选中。 -->
      <div
        v-if="selectedRiver && tool !== 'river'"
        class="toolbar-row river-selected-row"
        data-testid="river-selected-row"
      >
        <label class="row-label">已选中河流：</label>
        <span class="river-edit-name" :title="`当前选中：${selectedRiver.name || '未命名'}`"
              data-testid="river-sel-count">
          <template v-if="riverSelIds().length > 1">共 {{ riverSelIds().length }} 条（主：{{ selectedRiver.name || '未命名' }}）</template>
          <template v-else>{{ selectedRiver.name || '未命名' }} · {{ (selectedRiver.points || []).length }} 点</template>
        </span>
        <button
          class="tool-btn danger"
          data-testid="river-selected-delete"
          :title="riverSelIds().length > 1
            ? '把选中的这批河一次删掉（整批 = 一条撤销）'
            : '删除这条河流（走撤销栈，Ctrl+Z 可恢复）'"
          @click="deleteSelectedRiver()"
        >{{ riverSelIds().length > 1 ? `删除选中的 ${riverSelIds().length} 条` : '删除这条河' }}</button>
        <button
          class="tool-btn"
          data-testid="river-selected-edit"
          title="切到河流工具，可以拖节点 / 点河身加拐点 / 删单个节点"
          @click="enterRiverToolForSelected()"
        >编辑节点</button>
        <button
          class="tool-btn"
          data-testid="river-clip-coast"
          title="把选中的河裁到海岸线（画进海里的那一段被裁掉；整批 = 一条撤销）—— 想保留三角洲/河口就别裁"
          @click="clipSelectedRiversToCoast()"
        >裁到海岸线</button>
        <button
          class="tool-btn"
          data-testid="river-selected-clear"
          title="取消选中（不删除任何东西）"
          @click="setRiverSelection([]); render()"
        >取消选中</button>
        <span class="row-hint">Shift+点=多选 · Shift+拖动=框选一批</span>
      </div>
      <div v-if="tool === 'river'" class="toolbar-row river-edit-row" data-testid="river-edit-row">
        <label class="row-label">河流编辑：</label>
        <template v-if="selectedRiver">
          <span class="river-edit-name" :title="`当前选中：${selectedRiver.name || '未命名'}（${(selectedRiver.points || []).length} 个节点）`">
            已选中「{{ selectedRiver.name || '未命名' }}」· {{ (selectedRiver.points || []).length }} 点
          </span>
          <button
            data-testid="river-del-node"
            :disabled="riverActiveNode < 0"
            @click="removeSelectedRiverNode()"
            :title="riverActiveNode >= 0
              ? `删掉第 ${riverActiveNode + 1} 个节点（这条河重新平滑一次）—— 等价于把鼠标移到节点上按 Delete`
              : '删单个节点：先把鼠标移到某个节点上（它会变黄），再点这里或按 Delete'"
          ><Icon name="x" :size="13"/>删这个节点</button>
          <button
            data-testid="river-del-all"
            @click="deleteSelectedRiver()"
            title="删掉整条河（一条撤销可撤回）—— 快捷键：鼠标不在任何节点上时按 Delete"
          ><Icon name="trash" :size="13"/>删整条河</button>
          <button
            data-testid="river-clip-coast-row"
            @click="clipSelectedRiversToCoast()"
            title="把这条河裁到海岸线（保留陆地那一段；整条在海里时不会自动删）"
          ><Icon name="scissors" :size="13"/>裁到海岸线</button>
          <span class="row-hint" v-if="riverSelIds().length > 1">共选中 {{ riverSelIds().length }} 条（批量删除/裁剪都算一条撤销）</span>
          <span class="row-hint" v-else>再点河身=加拐点，按住节点拖=微调（一次操作 = 一条撤销）</span>
        </template>
        <span v-else class="row-hint" data-testid="river-edit-hint">
          按住左键拖一笔 = 画一条河（松手成河、自动平滑）；点已有河流的河身 = 选中它，再点河身 = 加拐点
        </span>
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
              ><Icon name="scissors" :size="15"/>拆分</button>
                  <button 
                :class="{ active: tool === 'merge' }" 
                @click="setTool('merge')"
                title="合并省份 (M) — 依次点击两个省份"
              >⊕合并</button>
                  <button 
                :class="{ active: tool === 'erase' }" 
                @click="setTool('erase')"
                title="删除 (E) — 点击省份删除"
              ><Icon name="trash" :size="15"/>删除</button>
                  <button 
                :class="{ active: tool === 'height' }" 
                @click="setTool('height')"
                title="高度笔刷 (H) — 左键抬高/右键降低地形"
              ><Icon name="trending-up" :size="15"/>高度</button>
                  <button 
                :class="{ active: tool === 'biome' }" 
                @click="setTool('biome')"
                title="生物群系笔刷 (N) — 涂抹生物群系"
              ><Icon name="palette" :size="15"/>群系</button>
                  <button 
                :class="{ active: tool === 'river' }" 
                @click="setTool('river')"
                title="河流编辑器 (W) — 按住左键拖出笔迹 = 画一条河（松手成河）；**Shift + 按在已有河的河身上拖出去 = 画支流**（起点自动吸附、松手在母河上插拐点）；点河身加拐点；拖节点微调；Delete 删节点"
              ><Icon name="droplets" :size="15"/>河流</button>
                  <button 
                :class="{ active: autoRivers.length > 0 }" 
                @click="generateAndShowRivers"
                title="自动河流（预览）— 按地形高度从高到低追踪入海路径。⚠️ 结果只画在画布上、**不会存进项目**：切走视图或换底图就没了；要长期保留请用「河流 (W)」手画。"
              ><Icon name="waves" :size="15"/>自动河流</button>
                  <!-- 🔴 源头高度闸门（2026-10-14 第三轮）：实测在这份地形上**它决定条数**
                       （默认 60 → 3 条；40 → 67 条）。做成一枚**紧挨着按钮**的数字输入，
                       因为它与"点一下自动河流"是同一个动作的两个参数，藏进『更多』里
                       等于还是够不着（本项目反复踩的正是这一条）。 -->
                  <input
                v-model.number="riverSourceHeight"
                data-testid="river-source-height"
                type="number" min="0" max="100" step="5"
                class="river-source-height"
                title="源头高度闸门 — 只有高度**高于**这个值的格子才能当河源。调低 = 更多（更碎）的支流；调高 = 只留高地上的大江。实测这份底图：60 → 3 条、40 → 67 条"
              />
                  <!-- 🔴 河流来源（2026-10-16 第五修）：实测自动河与底图自带河**是两套水系**
                       （段到自带河最近距离中位 18.78 世界单位，只有 10% 在 3 单位内）→ 并存时
                       必然"各画各的"。给一个显式开关让用户只留一套，而不是替他猜。
                       默认 `both` = 现有行为一字不变。 -->
                  <select
                v-model="riverSource"
                data-testid="river-source"
                class="river-source-select"
                title="画哪一套河 —— 实测自动河与底图自带河是**两套不同的水系**（中位相距约 1.3 格）。「两套都画」= 一直以来的行为；想只留一套就选另一个（自动河要先点「自动河流」生成）"
              >
                <option value="both">河流：两套都画</option>
                <option value="base">只画底图自带</option>
                <option value="auto">只画自动生成</option>
              </select>
                  <!-- 🔴 2026-10-17 第八修·再修（用户：「这个长河受限有一大串很难看清的一闪而过的文本，
                        放在已经很拥挤的工具栏里真的有必要吗？」）—— **没必要，已移除**。
                        原先这里常驻一枚「⚠️ 长河受限」标签，状态栏还会追一句「悬停看原因」。
                        问题是：① 工具栏本来就挤，多一个角标只会让人以为界面坏了；
                        ② 真正的信息（这份地形为什么长不出长河）**长到放不进 tooltip**，
                           而且它是一句"解释"不是"动作"，常驻在操作区没有价值；
                        ③ 现在已经有**真正的解法**（「按轮廓生成地形」）—— 提示该变成一次性的指路，
                           不该长期占位。
                        ⇒ 只在**生成回执里说一次**（见 `generateAndShowRivers`），做完就消失。 -->
                  <!-- 🔴 追踪前先平滑（2026-10-16）：实测这是唯一能让河"长出主干"的方向
                       （最长河 140→270 世界单位）。默认关 = 零行为变更。 -->
                  <label
                class="check-label river-smooth-label"
                title="追踪前先平滑地形 —— 实测能让最长河道翻倍（140→270 世界单位）、河网铺开全岛。原理：抹掉粗网格上的微洼地，让水顺着大谷走。⚠️ 代价：平滑会压低山头，源头变少 → 勾上时会**自动把「源头高度」降到 40**（否则可能一条河都没有）"
              ><input type="checkbox" v-model="riverSmooth" data-testid="river-smooth" />平滑</label>
                  <button 
                :class="{ active: tool === 'relief' }" 
                @click="setTool('relief')"
                title="Relief 图标 (I) — 放置山脉/树木/沙漠等自然特征"
              ><Icon name="mountain" :size="15"/>地貌</button>
                  <select v-if="tool === 'relief'" v-model="selectedReliefIcon" class="brush-biome-select" title="Relief 图标">
                <option v-for="icon in RELIEF_ICONS" :key="icon.id" :value="icon.id">{{ icon.name }}</option>
              </select>
                  <button 
                :class="{ active: tool === 'paint' }" 
                @click="setTool('paint')"
                title="势力油漆桶 (P) — 点击省份指派势力"
              ><Icon name="palette" :size="15"/>势力</button>
                  <button 
                :class="{ active: tool === 'culture' }" 
                @click="setTool('culture')"
                title="文化笔刷 (C) — 涂抹文化区域"
              ><Icon name="users" :size="15"/>文化</button>
                  <button 
                :class="{ active: tool === 'religion' }" 
                @click="setTool('religion')"
                title="宗教笔刷 (R) — 涂抹宗教区域"
              ><Icon name="church" :size="15"/>宗教</button>
                  <button 
                :class="{ active: tool === 'burg' }" 
                @click="setTool('burg')"
                title="智能聚落 (U) — 点击放置，自动贴合地形"
              ><Icon name="home" :size="15"/>聚落</button>
                  <select v-if="tool === 'burg'" v-model="selectedBurgSize" class="brush-biome-select" title="聚落规模">
                <option v-for="size in BURG_SIZES" :key="size.id" :value="size.id">{{ size.name }}</option>
              </select>
                  <button 
                :class="{ active: tool === 'label' }" 
                @click="setTool('label')"
                title="历史地名 (T) — 点击放置文字标记"
              ><Icon name="tag" :size="15"/>地名</button>
                  <select v-if="tool === 'label'" v-model="selectedLabelPreset" class="brush-biome-select" title="标签样式预设">
                <option v-for="preset in LABEL_PRESETS" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
              </select>
                  <button 
                :class="{ active: tool === 'marker' }" 
                @click="setTool('marker')"
                title="标记 (K) — 点击放置标记"
              ><Icon name="map-pin" :size="15"/>标记</button>
                  <select v-if="tool === 'marker'" v-model="selectedMarkerType" class="brush-biome-select" title="标记类型">
                <option v-for="type in MARKER_TYPES" :key="type.id" :value="type.id">{{ type.name }}</option>
              </select>
                  <button 
                :class="{ active: tool === 'road' }" 
                @click="setTool('road')"
                title="道路 (J) — 两点连线，自动生成沿等高线路径"
              ><Icon name="git-branch" :size="15"/>道路</button>
                  <select v-if="tool === 'road'" v-model="selectedRoadStyle" class="brush-biome-select" title="道路样式">
                <option v-for="style in ROAD_STYLES" :key="style.id" :value="style.id">{{ style.name }}</option>
              </select>
                  <button 
                :class="{ active: tool === 'derive' }" 
                @click="deriveLayers"
                title="重算派生图层 — 基于高度重算温度/降水/生物群系"
              ><Icon name="refresh-cw" :size="15"/>重算派生</button>
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
        <button @click="triggerMapImport" title="导入 .map 底图 —— 同名且一笔未改：只补缺；同名且改过：重导为新底图并迁移旧归属"><Icon name="plus" :size="15"/></button>
        <!-- 2026-10-22：**已有底图时也能新建空底图**。以前只有「空项目空态」能建，
             已有底图的项目只能导 .map —— 用户想试笔刷却没有干净画布，只能对着真实底图下手
             （「连新底图都建不了」/「怕改坏不敢测」的直接来源）。 -->
        <button
          data-testid="basemap-add-empty"
          :disabled="store.isReadOnly"
          :title="store.isReadOnly
            ? `新建底图已停用：${store.readOnlyReason || '只读：未打开项目'}`
            : '新建一张空白底图（已有底图时也能加）—— 之后画的省份 / 河流 / 道路都落在这张新图上，不动现有底图'"
          @click="addEmptyBaseMap()"
        ><Icon name="plus" :size="15"/>空底图</button>
        <!-- 0.2.9（2026-10-13）：**从留底恢复** —— 导入过的 .map 原文一直留在
             `<项目>.sitian.backups/basemap-sources/`（0.2.8 起），但此前只有"列清单"没有入口，
             用户在界面上够不着（只能自己去资源管理器翻目录）。备份读不回来就不算备份。 -->
        <button
          data-testid="basemap-source-restore"
          class="has-advanced"
          title="从留底恢复底图 —— 列出项目备份目录里留存的原始 .map（导入时自动留底），选一份重新导入；同名底图只补缺，省份与归属不动"
          @click="openSourceRestore"
        ><Icon name="history" :size="15"/></button>
        <!-- B2（2026-10-11）：给**已经在用**的底图补 FMG 数据（高度图 / 河流 / 道路 / 城镇）。
             真实缘由：`desite` 是 2026-09-10 那次导入建的，而当时解析器只读 SVG 省份多边形，
             高度图/河流/道路根本没被读出来 —— 今天解析器能读全（实测 9975 格高度 + 160 河 + 496 路），
             但没有任何入口能把它们补进一张已经切了几百块省份的底图（重导 = 覆盖，绝不可行）。 -->
        <button
          v-if="basemapDataMissing.length"
          data-testid="basemap-refresh-data"
          class="has-advanced"
          :title="`刷新底图数据 — 这张底图还缺：${basemapDataMissing.join(' / ')}。选一个 FMG .map 文件补齐，` +
                  '省份边界（' + provinceCount + ' 块）与归属记录一个字都不会动'"
          @click="triggerMapImport({ refreshOnly: true })"
        ><Icon name="refresh" :size="15"/></button>
        <!-- F（0.2.6）：用新 .map 的海岸线重建现有省份外环 —— 只换海岸那一段，不作废省份。
             为什么需要它：生成器原始海岸线 10525 点，导出时被简化成 778 点，落到底图上
             每个省只剩几十个点（地图上那条海岸线又糙又不对）；而"重导为新底图"会把
             几百块省份与归属全丢掉。这个按钮走的是第三条路：**省 ∩ 新陆地**。 -->
        <button
          data-testid="basemap-rebuild-coastline"
          class="has-advanced"
          :title="baseMapHasLandFeatures
            ? '用新 .map 的海岸线重建省份外环 — 只换海岸那一段；内陆省逐点不动、相邻省仍无缝、一整次 = 一条撤销'
            : '用新 .map 的海岸线重建省份外环（这张底图里没有陆地轮廓数据，会先让你选一份 .map）'"
          @click="triggerCoastlineRebuild"
        ><Icon name="mountain" :size="15"/></button>
        <!-- A1（2026-09-24）：底图的高度图此前**只有 .map 导入**一条来源 —— 新建的底图里
             高度/群系/文化/宗教笔刷与一键派生全都「点了没反应」（没有网格 → 直接 return）。
             这个按钮补上「从零开始画」，同时它也是「剧情上已毁灭、不打算再建行星的星球」
             唯一可走的路径：**不绑定行星，底图自己持有一份高度图**。 -->
        <button
          v-if="baseMapCanCreateHeightmap"
          data-testid="basemap-create-heightmap"
          title="为这张底图创建高度图网格（创建后即可用高度 / 群系 / 文化 / 宗教笔刷与一键派生）"
          @click="createBaseMapHeightmap"
        ><Icon name="layers" :size="15"/>建高度图</button>
        <!-- 🔴 2026-10-17 第八修·改向（暮雨：「司天自身的编辑能力必须过硬，**不要指望靠
              用户导出高度数据地图来救河流生成**」）。
              上面那个「建高度图」建出来的是一张**全 0 的平地**（h 全 0 < 海平面 20），
              于是自建底图的完整路径是：画大陆 → 建高度图 → 点自动河流 → **永远是 0 条河**
              （平地没有坡，水不知道该往哪流），且不报错。这就是"核心能力只对外部导入的
              地图可用"的真身。
              这个按钮补上**本地地形起点**：按陆地轮廓推演一份有起伏的高度图
              （离岸距离场 + 分形起伏，见 `utils/terrainSynthesis.js`），落库进 undo。
              用户的完整路径变成：画大陆 → 按轮廓生成地形 → 有河 → 再用笔刷手调。 -->
        <button
          v-if="baseMapCanSynthesizeTerrain"
          data-testid="basemap-synthesize-terrain"
          title="按已画好的陆地轮廓推演一份地形高度图（内陆高、海岸低 + 分形起伏）—— 这是自建地图长出河流的起点，之后可用地形笔刷继续手改"
          @click="synthesizeBaseMapTerrainFromShape"
        ><Icon name="mountain" :size="15"/>按轮廓生成地形</button>
        <!-- P0-1（2026-10-25）：**参数够不着 = 生成只能撞运气**。
             旧入口一点就按写死的常量推演（种子 7 / 山脉权重 0.26 / 裂谷 0.26），
             用户既不知道"这次是什么种子"，也无法换一种地形 —— 不满意只能反复点，
             而每次点出来的都是同一张。这个入口带**文字**（本项目实测：只有图标的按钮
             用户找不到），点开是面板：种子/起伏/山脉/高原/裂谷/精度 + 3 张候选缩略图，
             选一张再应用（一条 undo）。 -->
        <button
          v-if="baseMapCanSynthesizeTerrain"
          data-testid="basemap-terrain-params"
          :class="{ active: terrainGenOpen }"
          title="地形生成参数 —— 种子 / 起伏 / 山脉 / 高原 / 裂谷 / 精度 + 3 张候选预览，选一张再应用（一条撤销）"
          @click="toggleTerrainGenPanel"
        ><Icon name="settings" :size="15"/>生成参数</button>
        <button
          v-if="baseMapKey"
          data-testid="basemap-fmg-terrain"
          :class="{ active: fmgOpen }"
          title="FMG 模板地形 —— 14 套 Azgaar 模板（大陆 / 群岛 / 环礁 / 地中海…）直接出高度图，同一条撤销"
          @click="fmgOpen = !fmgOpen"
        ><Icon name="sparkles" :size="15"/>FMG 地形</button>
        <!-- P0-2（2026-10-25）：**造陆**。此前"从零开始"的第一步是让用户自己画大陆 ——
             手画出来多是圆饼，而且只会画一块中央大陆。这里按参数生成大陆/群岛轮廓，
             再用现有铺底管线切成省（一条 undo）。 -->
        <button
          v-if="baseMapKey"
          data-testid="basemap-generate-landmass"
          :class="{ active: landmassOpen }"
          title="造陆 —— 按参数生成大陆/群岛轮廓，再用铺底切成省；一次 Ctrl+Z 可整体退回"
          @click="toggleLandmassPanel"
        ><Icon name="globe" :size="15"/>造陆</button>
        <!-- P0-4（2026-10-25）：文化/宗教/势力派生 —— 空省从"没有文化、没有归属"变成
             有连续文化区、有按文化分组的势力；只补空/覆盖两档显式选，笔刷仍可覆盖。 -->
        <button
          v-if="baseMapKey"
          data-testid="basemap-derive-culture"
          :class="{ active: deriveOpen }"
          title="派生文化/宗教/势力 —— 逐格文化区 + 省份摘要 + 按文化分组建势力；只补空或覆盖（会先问）"
          @click="toggleDerivePanel"
        ><Icon name="users" :size="15"/>派生</button>
        <!-- P5（2026-10-14）：高度图**分辨率**。
             真实来由：用户实测「地形模模糊糊」「高度图分辨率帮我调整。注意性能」。
             量出来的事实是源网格 133×75 / spacing 14.4，在 1900×1080 上每格约 3.6 屏幕像素
             —— 这是**数据分辨率**，不是渲染 bug。唯一真正有效的做法是把格子变密。

             🔴 2026-10-15：**必须带可见文字**。第一版只有一枚 `grid` 图标，而「更多」里
             它左右邻居全都有文字（拆分 / ⊕合并 / 删除 / 高度 / 群系 …）→ 暮雨实测
             「分辨率按钮不知道在哪里，『更多』中没有找到」。诊断（`test_xdiag_resample_button`）
             证实按钮**一直在**（`data-testid="basemap-resample"`），是**看不见名字**。
             纪律：按钮的可发现性不能只靠 `title`（要悬停才知道）+ 图标（认不出来）。 -->
        <button
          v-if="baseMapCanResample"
          data-testid="basemap-resample"
          :class="{ active: resampleOpen }"
          :title="`调整高度图分辨率 — 当前 ${resamplePreview ? resamplePreview.srcCells : 0} 格；`
                  + '把格子变密能让海岸线/山坡不再一块一块（放大会更明显）。⚠️ 这是插值，不增加地形信息'"
          @click="openResamplePanel"
        ><Icon name="grid" :size="15"/>分辨率</button>
      </div>

      <!-- P5：分辨率面板（按需展开，不占工具栏） -->
      <div v-if="resampleOpen && resamplePreview" class="resample-panel" data-testid="resample-panel">
        <div class="rp-row">
          <label>放大</label>
          <select v-model.number="resampleFactor" data-testid="resample-factor">
            <option :value="2">×2</option>
            <option :value="3">×3</option>
            <option :value="4">×4</option>
            <option :value="6">×6</option>
            <option :value="8">×8</option>
          </select>
          <span class="rp-cost" :class="'lv-' + resamplePreview.level" data-testid="resample-cost">
            {{ resamplePreview.message }}
          </span>
        </div>
        <div v-if="!resamplePreview.ok" class="rp-warn">{{ resamplePreview.message }}</div>
        <div class="rp-row">
          <label>平滑</label>
          <select v-model.number="smoothRadius" data-testid="smooth-radius">
            <option :value="1">半径 1 格</option>
            <option :value="2">半径 2 格</option>
            <option :value="3">半径 3 格</option>
          </select>
          <button class="rp-btn" data-testid="smooth-apply" @click="applySmooth">平滑地形</button>
          <span class="rp-hint">平滑只改高度；气候/群系要另点「重算派生图层」</span>
        </div>
        <div class="rp-actions">
          <button
            class="rp-btn primary"
            data-testid="resample-apply"
            :disabled="!resamplePreview.ok"
            @click="applyResample"
          >应用分辨率</button>
          <button class="rp-btn" @click="resampleOpen = false">取消</button>
        </div>
        <div class="rp-note">
          ⚠️ 实测口径：放大**不会**让河变长（同一片地形被更细地走一遍而已）。
          1→2→4 倍时河条数 57→287→1089，而最长河的世界长度几乎不变（111→120→110）。
          想要更长的大河只能换更高分辨率的**源数据**。
        </div>
      </div>

      <!-- P0-1：地形生成参数面板（**浮层**：2026-10-25 实测被左侧剧本列表的 `slp-empty` 盖住，
           真人点不到「应用」——`el.click()` 绕过命中测试所以用例一直绿）。
           三个生成面板统一 Teleport 到 body + 固定定位 + 高层级，不再受工具栏布局/滚动裁剪影响。 -->
      <Teleport to="body">
        <div v-if="terrainGenOpen" class="gen-float" data-testid="terrain-gen-wrap">
          <div class="resample-panel">
            <TerrainGenPanel
              :base-map-key="baseMapKey"
              :has-heightmap="baseMapHasHeightmap"
              @apply="applyGeneratedTerrain"
              @close="terrainGenOpen = false"
            />
          </div>
        </div>
      </Teleport>

      <!-- B 阶段 2（2026-10-29）：FMG 模板地形（14 套 Azgaar 模板 → 直接出高度图；同一条 undo） -->
      <Teleport to="body">
        <div v-if="fmgOpen" class="gen-float" data-testid="fmg-wrap">
          <div class="resample-panel">
            <FmgPanel
              :base-map-key="baseMapKey"
              @apply="applyGeneratedTerrain"
              @close="fmgOpen = false"
            />
          </div>
        </div>
      </Teleport>

      <!-- P0-2：造陆面板（轮廓候选 → 铺底切省；一条撤销） -->
      <Teleport to="body">
        <div v-if="landmassOpen" class="gen-float" data-testid="landmass-wrap">
          <div class="resample-panel">
            <LandmassPanel
              :base-map-key="baseMapKey"
              :has-terrain="provinceCount > 0"
              @apply="applyLandmassResult"
              @close="landmassOpen = false"
            />
          </div>
        </div>
      </Teleport>

      <!-- D3：地形注记面板（山脊候选 → 命名 → 应用；一条撤销） -->
      <Teleport to="body">
        <div v-if="terrainLabelsOpen" class="gen-float" data-testid="terrain-labels-wrap">
          <div class="resample-panel">
            <TerrainLabelsPanel
              :base-map-key="baseMapKey"
              :has-heightmap="baseMapHasHeightmap"
              :pick="terrainLabelPick"
              @applied="applyTerrainLabelsResult"
              @pick="startTerrainLabelPick"
              @pick-done="onTerrainLabelPickDone"
              @pick-cancel="cancelTerrainLabelPick"
              @close="terrainLabelsOpen = false"
            />
          </div>
        </div>
      </Teleport>
      <!-- P0-4：文化/宗教/势力派生面板 -->
      <Teleport to="body">
        <div v-if="deriveOpen" class="gen-float" data-testid="derive-wrap">
          <div class="resample-panel">
            <DerivePanel
              :base-map-key="baseMapKey"
              :scenario-key="selectedScenario?.id || ''"
              @applied="onDerived"
              @close="deriveOpen = false"
            />
          </div>
        </div>
      </Teleport>

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
        <button @click="manualSave" title="保存到磁盘" :class="{ 'saving': saveDisplay.state === 'saving' }"
                data-testid="scenario-save-btn">
          <Icon v-if="saveDisplay.state === 'saving'" name="loader" :size="15"/>
          <Icon v-else-if="saveDisplay.state === 'staged'" name="clock" :size="15"/>
          <Icon v-else-if="saveDisplay.state === 'saved'" name="check-circle" :size="15"/>
          <Icon v-else-if="saveDisplay.state === 'error'" name="x-circle" :size="15"/>
          <Icon v-else name="save" :size="15"/>
        </button>
      </div>
      <div class="tool-group">
        <label>模式：</label>
        <select v-model="viewMode" @change="onModeChange">
          <option value="base">底图编辑</option>
          <option value="scenario">剧本模式</option>
        </select>
        <!-- 🔴 两个模式**工具栏是同一套**，用户看不出差别（暮雨实测：「根本看不懂」）。
             它们真正的区别在**着色与图层**：底图编辑按群系看自然面貌，剧本模式按势力看政治版图。
             一句话写在旁边，省得用户来回切着猜。 -->
        <span class="row-hint" data-testid="view-mode-hint" :title="viewModeHint">{{ viewModeHint }}</span>
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
        <label class="check-label" title="显示导入的城镇名 / 河流名（FMG 数据多为英文名；默认关闭，需要时再开）"><input type="checkbox" v-model="showPlaceNames" data-testid="toggle-place-names" /> 自动地名</label>
        <label class="check-label" title="显示「地形注记」里的山系/海域名（沿走向排字；名字要自己给：检测山脊或手动画一条，见「地形注记」面板）"><input type="checkbox" v-model="showTerrainNames" data-testid="toggle-terrain-names" @change="onTerrainNamesToggle" /> 地形名</label>
        <label class="check-label" title="EU4 式分级标注：缩小看势力名（可简称），放大再加上省名"><input type="checkbox" v-model="showPolityLabels" data-testid="toggle-polity-labels" /> 势力名</label>
        <label class="check-label" title="放大到最详档时显示省名（未命名的省显示「新省份 N」，是改名的线索）"><input type="checkbox" v-model="showProvinceNames" data-testid="toggle-province-names" /> 省名</label>
        <label class="check-label" title="只显示你自己起过名的省 —— 程序生成的「新省份 N」整层不画（415 省项目里通常只有几十个有真名，其余会把画面糊满）"><input type="checkbox" v-model="showNamedProvincesOnly" data-testid="toggle-named-provinces" /> 仅已命名省</label>
        <button @click="showLayerPanel = !showLayerPanel" title="图层锁定设置" :class="{ active: showLayerPanel }"><Icon name="lock" :size="13"/></button>
      </div>
      <div class="tool-group">
        <label>底图图层：</label>
        <select v-model="rasterLayer" title="网格数据图层（一次只渲染一层，避免叠加失真）">
          <option value="none">无</option>
          <option value="landsea">陆海底色</option>
          <option value="satellite">卫星影像</option>
          <option value="terrain">地形色</option>
          <option value="height">地形高度</option>
          <option value="temp">温度</option>
          <option value="prec">降水</option>
        </select>
        <label class="check-label"><input type="checkbox" v-model="showRivers" /> 河流</label>
        <label class="check-label"><input type="checkbox" v-model="showRoutes" /> 道路</label>
        <!-- 🔴 山体阴影（2026-10-17 第七修）：用户「地形怎么3D表现」的落点。
             默认**关**（零行为变更）。只对「陆海底色 / 地形高度」两档生效 ——
             温度/降水是**专题图**，给它们加阴影会把数值读成地形（那是错的口径）。 -->
        <label
          class="check-label terrain-shade-label"
          data-testid="terrain-shade"
          title="山体阴影 —— 按相邻格高差算明暗，让地形「立起来」（制图惯例：光从左上来）。默认关；只对「陆海底色 / 地形高度」生效。⚠️ 我们的高度图可能是粗网格（例如 133×75），阴影会跟着粗 —— 这是数据本身的粒度，不是渲染问题。"
        ><input type="checkbox" v-model="terrainShade" data-testid="terrain-shade-box" /> 立体</label>
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
        <button @click="showSliceExport = true" data-testid="open-slice-export"
                title="逐年切片导出（每个状态变化的年份一张图 + frames.json 清单，可交 ffmpeg 合成）"><Icon name="film" :size="15"/></button>
        <button @click="exportScenariosJson({ scope: 'current' })" title="导出当前底图的剧本数据（scenarios.json）" data-testid="export-json"><Icon name="export" :size="15"/></button>
        <button @click="importScenariosJson('merge')" title="导入剧本数据（合并：同 key 覆盖）" data-testid="import-json-merge"><Icon name="download" :size="15"/></button>
        <button @click="importScenariosJson('replace')" title="导入剧本数据（替换：清空现有剧本后再导入）" data-testid="import-json-replace"><Icon name="refresh" :size="15"/></button>
      </div>
      </div>
      </div>   <!-- /.toolbar-more -->
    </div>

    <!-- 剧本时间轴（按年比例轴 + EU4 斜线占领；旧按钮式时间轴条已被取代）
         ⚠️ 组件契约仍是 `year: Number`（轨道位置与播放是年尺度），**月日只由父级 tlDate 持有**；
            从轨道拖/点回来时只给得到年 → 月日归 null（= 该年 1 月 1 日），这是刻意的：
            轨道拖拽表达的本来就是「到某一年」，要精确到日请用切片点或面板录入。 -->
    <scenario-timeline
      v-if="timeline.years.length"
      :timeline="timeline"
      :year="tlYear"
      :slice-points="slicePoints"
      v-model:era="tlEra"
      v-model:axis-mode="tlAxisMode"
      v-model:diff-mode="tlDiffMode"
      v-model:playing="tlPlaying"
      @update:year="onTimelineSetYear"
      @select-scenario="onTimelineSelectScenario"
      @open-lineage="showLineagePanel = true"
      @save-slice-point="onSaveSlicePoint"
    />

    <!-- 省份多选批量条（2026-10-02）：选中 ≥1 个省时出现，把「一次一批」接上 batchSetOwnership -->
    <div v-if="hasMultiSelection" class="province-batch-bar" data-testid="province-batch-bar">
      <span class="pbb-count" data-testid="pbb-count">已选 <b>{{ selectedProvinceIds.length }}</b> 省</span>
      <span class="pbb-sep"></span>
      <button class="pbb-primary" data-testid="pbb-assign"
              :disabled="store.isReadOnly || !selectedPolity"
              :title="store.isReadOnly ? (store.readOnlyReason || '只读：未打开项目')
                : (selectedPolity ? `把这 ${selectedProvinceIds.length} 个省一次指派给「${selectedPolity.name}」（一条撤销）`
                  : '先在上面的色板里选一个势力，再点这里批量指派')"
              @click="onBatchAssign">指派给{{ selectedPolity ? `「${selectedPolity.name}」` : '…' }}</button>
      <button class="pbb-btn" data-testid="pbb-clear"
              :disabled="store.isReadOnly"
              :title="store.isReadOnly ? (store.readOnlyReason || '只读：未打开项目') : '把这些省的势力归属清空（一条撤销）'"
              @click="onBatchClear">清除归属</button>
      <button class="pbb-btn" data-testid="pbb-select-land"
              title="选中当前底图的全部陆地省（海域不参与势力归属，不会入选）"
              @click="onSelectAllLand">全选陆地省</button>
      <button class="pbb-btn" data-testid="pbb-cancel" title="取消多选（Esc 同效）"
              @click="clearProvinceSelection">取消选择</button>
      <span class="pbb-hint">Ctrl/⌘ 点击省份可加选/减选；普通点击回到单选</span>
    </div>

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
        :class="{ active: clearOwnerMode }"
        data-testid="polity-clear"
        @click="selectClearOwnership()"
        title="清除归属：选中它之后，用「涂归属」涂过 / 用油漆桶点过的省份会变成**无主**（可 Ctrl+Z 撤回）"
      ><Icon name="x" :size="14"/></div>
      <!-- 新建势力（2026-10-01）：此前 polities **只能由 Azgaar .map 导入带进来** ——
           自建底图 + 自建剧本 = 势力功能整块不可用（色板空、油漆桶点了没反应）。
           现在＋按钮新建（走 store.addPolity = 一条 undo），选中后可改名/简称/配色/删除。 -->
      <button class="polity-add" data-testid="add-polity" :disabled="store.isReadOnly"
              :title="store.isReadOnly ? (store.readOnlyReason || '只读：未打开项目') : '新建一个势力（自定义名称与配色，可撤销）'"
              @click="onAddPolity"><Icon name="plus" :size="13"/> 势力</button>
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
        <label>配色
          <input type="color" :value="selectedPolity.color || '#888888'"
                 :disabled="store.isReadOnly" data-testid="polity-color-input"
                 title="势力配色（地图填充、色板、导出图例三处同源）"
                 @change="onPolityColorChange" />
        </label>
        <button class="polity-del" data-testid="polity-delete" :disabled="store.isReadOnly"
                :title="store.isReadOnly ? (store.readOnlyReason || '只读：未打开项目') : '删除该势力（连带清掉它占着的省份归属，可撤销）'"
                @click="onDeletePolity">删除势力</button>
        <span class="polity-editor-hint" title="地图标注随缩放自动改档（放大省名 / 中档势力名 / 缩小简称）">
          标注档位：{{ { province: '省名', polity: '势力名', abbr: '简称' }[polityLabelTierNow] }}
        </span>
      </div>
    </div>

    <!-- 画布 -->
    <div class="scenario-canvas-wrap" ref="canvasWrap">
      <canvas ref="canvas"></canvas>
      <!-- 2026-10-20：删掉「① 右侧选一个势力 ② 点涂归属 ③ 在地图上涂」的浮动引导条。
           理由（用户实测）：① 色板不在右侧（它在地图上方的「势力：」行），文案是错的；
           ② 三步流程本身就是噪音——色板、工具、地图都在眼前，不需要一段解说占着画布。
           工具自己的状态（当前势力 / 未选）已经在工具栏那一行里，不再重复。 -->
      <!-- C（2026-10-11）：批量铺底进行中的**遮罩**。
           为什么必须有它（不是装饰）：切 500 块 = 逐块多边形布尔，实测 ~19s 全在主线程上；
           这段时间里用户在画布上点/拖，事件只是排队 → 回来一起执行，观感是「越点越卡」，
           而且用户会以为程序死了。遮罩做两件事：① 吃掉所有指针事件（不让操作排队）；
           ② 明确告诉他"在算什么、算到第几块、可以取消"。 -->
      <div v-if="batchBusy" class="scenario-busy-overlay" data-testid="scenario-busy-overlay">
        <div class="busy-card">
          <Icon name="loader" :size="22" class="busy-spin"/>
          <div class="busy-title">正在切分省份…</div>
          <div class="busy-sub" data-testid="busy-progress">{{ batchStatus || '准备中' }}</div>
          <div class="busy-hint">期间画布不响应是正常的（正在算几何）；不想等就点「取消」，省份与归属都不会改动。</div>
          <button class="busy-cancel" @click="cancelBatchSubdivide()" data-testid="busy-cancel">
            <Icon name="x" :size="13"/> 取消切分
          </button>
        </div>
      </div>
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
          <p class="eh-line">
            剧本画在底图上（省份 → 归属 → 时期）。先导入一份 Azgaar <b>.map</b> 底图，
            也可以直接选个绘制/笔刷工具画一张空底图。
          </p>
          <!-- 🔴 这里必须有**按钮**，不能只写"用上方「+」"（P0-3，2026-10-17 第三轮）：
               「+」在「更多」面板里 = 提示指向一个用户当刻**看不见**的入口 ——
               本项目已在行星视图踩过同一条（交接文档 §2.2「.map 导入入口不可达」）。 -->
          <div class="eh-actions">
            <button class="eh-btn primary" data-testid="empty-import-map"
                    :disabled="store.isReadOnly"
                    title="选一份 Azgaar（FMG）导出的 .map：带进省份多边形、高度图、河流、城镇"
                    @click="triggerMapImport()">导入 .map 底图</button>
            <button class="eh-btn" data-testid="empty-new-basemap"
                    :disabled="store.isReadOnly"
                    title="新建一张空白底图，直接用绘制/笔刷工具画（之后也能再导入 .map 补数据）"
                    @click="createEmptyBaseMapFromHint()">新建空底图，自己画</button>
          </div>
        </template>
      </div>

      <!-- 有底图、但一个省都没有：把「第一笔怎么落」摆在画布中央（2026-10-22 用户实测）。
           他说"可以建空底图了，但是不知道怎么写，使用手册看不懂"——手册里写的「主行画省份」
           其实要先切「底图编辑」，日常模式里根本没有这个按钮。 -->
      <div v-if="baseMap && provinceCount === 0 && tool === 'select' && !emptyHintDismissed && !batchBusy && !renderPaused"
           class="empty-province-hint" data-testid="empty-province-hint">
        <button class="eph-close" data-testid="empty-province-dismiss" title="先不看这张提示（随时可用左上「底图编辑」回来）"
                @click="emptyHintDismissed = true">×</button>
        <template v-if="store.isReadOnly">
          <p class="eph-title">只读：不能画省份</p>
          <p class="eph-note">{{ store.readOnlyReason }}（先到「项目」面板新建 / 打开一个项目）</p>
        </template>
        <template v-else>
          <p class="eph-title">这张底图还没有省份</p>
          <ol class="eph-steps">
            <li><b>点下面的「开始画省份」</b>（＝ 左上「底图编辑」+ 主行「画省份」）</li>
            <li>在画布上<b>按住左键，绕一圈</b>画一个闭合形状</li>
            <li><b>松手</b> → 这块就是一个省（右侧可改名）</li>
          </ol>
          <button class="eph-btn" data-testid="empty-province-start" @click="startDrawingProvince()">开始画省份</button>
          <!-- 2026-10-22：会画图的人不一定会"绕一圈"——给他一支笔。 -->
          <button class="eph-btn" data-testid="empty-province-brush" @click="startPaintingProvince()">像画图一样涂一块（笔刷建省）</button>
          <p class="eph-note">
            画歪了 Ctrl+Z；没围成圈的一笔会被拒绝（不会造怪形状）。第二个省贴着第一个的边走会自动吸住。
            <br />「笔刷建省」不用闭合：按住左键像涂色一样抹，松手抹过的范围就是一个省。
          </p>
        </template>
      </div>

      <!-- 🔴 渲染护栏的**横幅**（2026-10-14）。
           为什么不再只放状态栏：用户原话「给我来一个渲染已暂停……后面就什么都看不到了，
           点什么都没反应，地图出不来，卡死了。一点提示都没有吗？」—— 状态栏那行**确实**在，
           但它在一个 12px 的状态栏里、而且用户正在盯的是空白的画布中央。
           现在暂停时在画布正中给一张卡：说明发生了什么、错误原文、以及"继续渲染 / 复制错误"。
           卡片吃掉指针事件（渲染已经停了，画布上的点击本来就没意义）。 -->
      <div v-if="renderPaused" class="render-paused-card" data-testid="render-paused-card">
        <div class="rp-title"><Icon name="alert-triangle" :size="16"/> 渲染已暂停</div>
        <div class="rp-sub">连续 {{ renderErrorCount }} 帧绘制失败，画布停止刷新（数据没有丢，改动仍在内存里）。</div>
        <pre class="rp-err" data-testid="render-paused-error">{{ renderError }}</pre>
        <div class="rp-hint">
          常见原因：某个工具刚改了数据但画布画不动它。可以先点「继续渲染」重试；
          若立刻又暂停，请把上面的错误原文复制反馈（右键可复制）。
        </div>
        <div class="rp-actions">
          <button class="rp-btn primary" @click="resumeRender()" data-testid="render-paused-resume">继续渲染</button>
          <button class="rp-btn" @click="copyRenderError()" data-testid="render-paused-copy">复制错误</button>
        </div>
      </div>

      <!-- ══ 历史剧本站首：剧本列表常驻左栏（2026-10-09）═══════════════════════════
           暮雨实测「根本找不到在哪选剧本 / 上一剧本·下一剧本语义不清」——根因是
           「选择历史时期」这件事在司天只有一个**图标按钮藏在工具栏『更多』里**（打开是弹窗），
           而 EU4 里它是进游戏就摆在左边的列表。
           本面板把那份列表提出来常驻，并把「点一条」定义成**选时期**的完整动作：
           切剧本 + 地图跳到该时期起始年 + 时间轴游标同步（见 selectScenarioAt）。
           ⚠️ 与「上一剧本/下一剧本」的分工：那两个是**按顺序推进**（翻页），
              这个列表是**选择**（跳转）—— 两种语义都留，别互相取代。 -->
      <div class="scenario-list-panel" :class="{ collapsed: !showScenarioList }" data-testid="scenario-list-panel">
        <div class="slp-head">
          <span class="slp-title">历史剧本</span>
          <span class="slp-hint">选一条，地图切到该时期</span>
          <!-- 换剧本（P0-1，2026-10-17 第三轮）：此前从编辑器回卡片墙只能「返回世界」再点一次
               「历史剧本」（三步），而「返回」的语义是**离开剧本域**（去世界选择页），
               不该兼职"选另一个剧本"。这里给一条**一步回到卡片墙**的路。
               ⚠️ 放在 `.slp-head` 而不是工具栏主行：主行受 P3「恰好 6 个可见控件」闸门管
               （test_65/test_97），而"换剧本"属于剧本导航、与左侧剧本列表同族。 -->
          <button class="slp-picker" data-testid="slp-picker" title="回到剧本选择（卡片墙）换一个时期"
                  @click="$emit('picker')">换剧本</button>
          <button class="slp-toggle" data-testid="slp-toggle"
                  :title="showScenarioList ? '收起列表（腾出画布）' : '展开剧本列表'"
                  @click="showScenarioList = !showScenarioList">
            <Icon :name="showScenarioList ? 'chevron-left' : 'chevron-right'" :size="13"/>
          </button>
        </div>
        <!-- 剧本集切换（2026-10-25）：一组 = 一条独立时间线（同一张底图 + 连续年代）。
             不切换 = 不同底图/不同时间线的剧本混在一条年份轴上，断层与"上一剧本"语义都会乱。 -->
        <div v-if="showScenarioList" class="slp-groupbar" data-testid="scenario-group-bar">
          <span class="slp-group-label">剧本集</span>
          <select
            class="slp-group-select"
            :value="activeGroupId"
            data-testid="scenario-group-switch"
            title="一组 = 一条独立时间线。切换后左栏、时间轴、播放与切片导出的「全部剧本」都只取这一组。"
            @change="switchGroup($event.target.value)"
          >
            <option v-for="g in groupOptions" :key="g.id" :value="g.id">
              {{ g.name }}（{{ groupCount(g.id) }}）
            </option>
          </select>
          <button class="slp-group-manage" data-testid="scenario-group-manage"
                  title="新建 / 改名 / 删除剧本集，或把某条剧本移到别的组（不删任何剧本）"
                  @click="showScenarioManager = true">管理</button>
        </div>
        <template v-if="showScenarioList">
          <div v-if="!sortedScenarios.length" class="slp-empty" data-testid="slp-empty">
            还没有剧本 —— 打开下方「新建 / 管理剧本…」创建第一个时期。<br />
            <b>一个剧本 = 一个时间点的版图快照</b>（谁占了哪些省）。
          </div>
          <div v-else class="slp-list">
            <div v-for="(s, i) in sortedScenarios" :key="s.id"
                 class="slp-item"
                 :class="{ active: selectedScenario?.id === s.id }"
                 :data-testid="'scenario-list-item-' + i"
                 :title="`切到「${s.name}」——地图跳到 ${s.era?.startYear || '?'} 年并同步时间轴`"
                 @click="selectScenarioAt(s)">
              <div class="slp-row1">
                <span class="slp-era">{{ s.era?.roman || '·' }}</span>
                <span class="slp-name">{{ s.name }}</span>
              </div>
              <div class="slp-row2">
                <span class="slp-years">{{ s.era?.startYear || '?' }} – {{ s.era?.endYear || '?' }}</span>
                <span class="slp-meta">{{ scenarioMeta(s) }}</span>
              </div>
            </div>
          </div>
          <button class="slp-manage" data-testid="slp-manage"
                  title="新建 / 编辑 / 删除剧本，以及管理当前剧本的地名与标记"
                  @click="showScenarioManager = true">
            <Icon name="file-text" :size="13"/> 新建 / 管理剧本…
          </button>
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
      <span v-if="vertexEditMode" class="draw-hint" data-testid="vertex-hint">顶点编辑：拖拽顶点 | Shift+拖动框选一批（拖共边顶点时邻省边界跟着走） | 点击边插入 | 右键顶点删除</span>
      <span v-if="vertexEditMode && vertexSelection.length" class="draw-hint" data-testid="vertex-sel-hint">已选中 {{ vertexSelection.length }} 个顶点（Esc 取消）</span>
      <span v-if="snapToGridEnabled && (tool === 'draw' || tool === 'vertex')" class="draw-hint">吸附：50px 网格（Shift 临时禁用）</span>
      <span v-if="snapFeedback" class="snap-feedback" :class="{ edge: snapFeedback === '吸附到边界' }">{{ snapFeedback }}</span>
      <span v-if="tool === 'vertex' && activeVertexIdx >= 0" class="draw-hint">切线手柄：拖拽圆点调曲率（Alt 临时直线）</span>
      <span v-if="provinceHint" class="draw-hint">{{ provinceHint }}</span>
      <span v-if="tool === 'ownerBrush'" class="draw-hint" data-testid="owner-brush-hint">
        <template v-if="clearOwnerMode">涂归属：按住涂 → 清空归属（无主）· 一笔一条撤销</template>
        <template v-else>涂归属：按住涂 → 碰到的省改成「{{ selectedPolity ? selectedPolity.name : '（未选）' }}」· 一笔一条撤销</template>
      </span>
      <span v-if="tool === 'provinceBrush' || tool === 'provinceLasso'" class="draw-hint">
        {{ tool === 'provinceBrush' ? '改省界：按住涂抹 → 整笔并进所选省份（改的是省界形状）' : '自由轮廓：按住画一圈 → 圈内整批划归' }}
      </span>
      <span v-if="tool === 'provincePaint'" class="draw-hint" data-testid="province-paint-hint">
        笔刷建省：按住像涂色一样抹 → 松手抹过的范围就是一个省（不用闭合）· 已有省份的地不会被抢 · 一笔一条撤销
      </span>
      <span v-if="tool === 'outline'" class="draw-hint" data-testid="outline-hint">
        描轮廓：按住**贴着要改的那条边界**拖一圈再松手 —— 围住的那块地改判给它原本主要所属的省，邻省自动重算；松手前的虚线是收口边
      </span>
      <span v-if="baseMap?.source?.warnings?.length" class="layer-warn" :title="baseMap.source.warnings.join('\n')">
        <Icon name="alert-triangle" :size="13"/> {{ baseMap.source.warnings.length }} 条图层提示
      </span>
      <span v-if="selectedBurg" class="selected-burg">城镇：{{ selectedBurg.name }}（人口 {{ formatPopulation(selectedBurg.population) }}）</span>
      <span v-if="viewMode === 'scenario' && selectedScenario">剧本：{{ selectedScenario.name }}</span>
      <span v-if="timeline.years.length" class="tl-status" data-testid="tl-status"
            title="「本剧本 N 省易主」= 这一段剧本里会易主的省总数；「已落定 M」= 游标日期之前已经发生过的条数（同省多次易主分别计数）">
        日期 <b data-testid="tl-date">{{ tlDateText }}</b>
        <template v-if="tlEra > 0"> · 本剧本 <b>{{ tlSettled.total }}</b> 省易主 · 截至本日已落定 <b data-testid="tl-settled">{{ tlSettled.settled }}</b></template>
        <template v-if="tlAxisMode === 'year' && tlInGap"> · <span class="tl-warn">空位（沿用 {{ timeline.scenarios[tlEra].name }}）</span></template>
      </span>
      <span v-if="exportStatus" class="export-msg" data-testid="export-msg"><Icon name="info" :size="13"/> {{ exportStatus }}</span>
      <span v-if="selectedPolity" class="selected-polity">已选势力：<span class="polity-dot" :style="{ background: selectedPolity.color }"></span>{{ selectedPolity.name }}</span>
      <!-- 保存状态：两条链合并显示（见 script 的 saveDisplay）。
           失败时**把原因写进文字本身** —— 暮雨实测「只有四个字『保存失败』」；
           本状态栏原先连 title 都没有，靠悬停根本看不到原因。 -->
      <span class="save-status" :class="saveDisplay.state"
            :title="saveDisplay.title || saveDisplay.text"
            data-testid="scenario-save-status">
        <Icon v-if="saveDisplay.state === 'saving'" name="loader" :size="13"/>
        <Icon v-else-if="saveDisplay.state === 'staged'" name="clock" :size="13"/>
        <Icon v-else-if="saveDisplay.state === 'saved'" name="check-circle" :size="13"/>
        <Icon v-else-if="saveDisplay.state === 'error'" name="x-circle" :size="13"/>
        <Icon v-else name="save" :size="13"/>
        {{ saveDisplay.text }}
      </span>
    </div>

    <!-- 省份右键菜单 -->
    <div v-if="contextMenu.show" class="context-menu" :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }">
      <div class="ctx-item" @click="ctxRenameProvince"><Icon name="pencil" :size="13"/> 重命名</div>
      <div class="ctx-item" @click="ctxChangeBiome"><Icon name="palette" :size="13"/> 更改生物群系</div>
      <div class="ctx-item" @click="ctxDuplicateProvince">⧉ 复制省份</div>
      <div class="ctx-item danger" @click="ctxDeleteProvince"><Icon name="trash" :size="13"/> 删除</div>
      <div class="ctx-divider"></div>
      <div class="ctx-item" v-if="contextMenuProvince" @click="ctxOpenProvinceProps" data-testid="ctx-province-detail">
        <Icon name="info" :size="13"/> 省份详情…
      </div>
      <div class="ctx-item disabled ctx-province" v-if="contextMenuProvince">
        {{ contextMenuProvince.name }} · {{ contextMenuProvince.biome || '未分类' }}
      </div>
      <!-- 归属：2026-10-21 用户实测「右键和右上角都看不到归属」。这里必须给**当前日期**的
           结论（与着色同一口径），无主就明说「无主」，不要留空让人猜。 -->
      <div class="ctx-item disabled ctx-owner" v-if="contextMenuProvince" data-testid="ctx-province-owner">
        归属：
        <template v-if="contextMenuOwner"><span class="polity-dot" :style="{ background: contextMenuOwner.color }"></span>{{ contextMenuOwner.name }}</template>
        <template v-else><span class="owner-none">无主</span></template>
        <span class="ctx-sub">（{{ tlDateText }}）</span>
      </div>
    </div>

    <!-- 省份属性面板
         🔴 2026-10-01：五个字段全部从 `v-model` 改成 `:value` + `@change` ——
         `v-model="selectedProvince.name"` 是**直接改 store 里的对象**（selectedProvince
         就是 terrain[] 里的那个活对象）：① 绕开 `guardWrite`（只读态照改内存）；
         ② `updateBaseProvince` 采集的 `oldProv` 已被改过 → **撤销把新值当成旧值还原**
         （改名/群系/文化/海岸/类型五项的 undo 全是空转）；③ 文本输入挂在 `@input` 上，
         每敲一个字符 = 一条 undo + 一次落盘，100 条上限会把更早的几何操作静默挤出栈。
         现在：值来自事件、写只走 store（`updateBaseProvince` = 一条 undo + 写闸门）。 -->
    <div v-if="selectedProvince && showProps" class="province-props">
      <div class="props-header">
        <input ref="provNameInput" :value="selectedProvince.name || ''" @change="onProvinceNameChange" class="props-name" />
        <button @click="showProps = false" class="props-close"><Icon name="x" :size="13"/></button>
      </div>
      <!-- 归属：2026-10-21 用户实测「看不到归属 / 看不到省份详情」。
           归属按**时间轴当前日期**显示（与地图着色同一口径 `ownerPolityForProvince`），
           无主就明说；两个按钮都走 store（一条 undo + 写闸门），不在模板里直改活对象。 -->
      <div class="props-row props-owner" v-if="viewMode === 'scenario'" data-testid="province-owner-row">
        <label>归属：</label>
        <span class="owner-value" :class="{ none: !selectedProvincePolity }">
          <template v-if="selectedProvincePolity">
            <span class="polity-dot" :style="{ background: selectedProvincePolity.color }"></span>
            {{ selectedProvincePolity.name }}
          </template>
          <template v-else>无主</template>
        </span>
        <button v-if="selectedProvincePolity" class="props-mini" :disabled="store.isReadOnly"
                :title="`按当前日期 ${tlDateText} 清空归属（无主；时间轴记一条「该年变无主」，一笔撤销）`"
                @click="clearSelectedProvinceOwner" data-testid="province-owner-clear">清成无主</button>
        <button v-else class="props-mini" :disabled="store.isReadOnly || !selectedPolity"
                :title="selectedPolity ? `按当前日期 ${tlDateText} 记为「${selectedPolity.name}」` : '先在色板选一个势力'"
                @click="assignSelectedProvinceOwner" data-testid="province-owner-assign">设为当前势力</button>
      </div>
      <div class="props-sub" v-if="viewMode === 'scenario'">归属随「{{ tlDateText }}」变化（拖时间轴可看不同年份）</div>
      <div class="props-row">
        <label>生物群系：</label>
        <select :value="selectedProvince.biome || ''" @change="onProvinceBiomeChange">
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
        <input :value="selectedProvince.culture || ''" @change="onProvinceCultureChange" placeholder="文化名称" />
      </div>
      <div class="props-row">
        <label>海岸：</label>
        <input type="checkbox" :checked="!!selectedProvince.coast" @change="onProvinceCoastChange" />
      </div>
      <div class="props-row">
        <label>类型：</label>
        <select :value="selectedProvince.kind === 'sea' ? 'sea' : 'land'" @change="onProvinceKindChange"
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
      <!-- 资料（读料桥，2026-10-24）：按省名在全库资料里找**候选**。
           实现只有一份：`VaultLoreSection.vue`（省份面板与标记面板共用）——
           这一段只许 `vaultIndexSearch` + `openNote`，不猜、不建、不写；
           找不到就明说（与「读不到笔记」的可读回落同一口径：不能静默什么都不显示）。 -->
      <VaultLoreSection testid="province-vault" :query="selectedProvince.name || ''" />
    </div>

    <!-- 标记属性面板（2026-10-24，第 5 件补「点标记」）
         🔴 之前标记是"只画不收"的一层：放下时 `askText` 问个名字，之后**点不到它**
         （没有命中测试、没有编辑面板）→ "点标记看资料"根本无从挂起。
         现在：命中测试在 `utils/markerHitTest.js`（唯一实现，只读），本面板只走 store 写口
         （`updateScenarioMarker` / `removeScenarioMarker`），模板里不直改 marker 对象
         （与省份面板 2026-10-01 那次修复同一条纪律：v-model 直改活对象会绕开写闸门 + 弄坏 undo）。 -->
    <div v-if="selectedMarker && showMarkerPanel && viewMode === 'scenario'"
         class="province-props marker-props" data-testid="marker-props">
      <div class="props-header">
        <input :value="selectedMarker.name || ''" class="props-name" placeholder="标记名称"
               data-testid="marker-name" @change="onMarkerNameChange" />
        <button class="props-close" data-testid="marker-close" title="收起面板（标记本身不动）"
                @click="showMarkerPanel = false"><Icon name="x" :size="13"/></button>
      </div>
      <div class="props-row">
        <label>类型：</label>
        <select :value="selectedMarker.type || 'custom'" data-testid="marker-type" @change="onMarkerTypeChange">
          <option v-for="t in MARKER_TYPES" :key="t.id" :value="t.id">{{ t.name }}</option>
        </select>
      </div>
      <div class="props-row">
        <label>坐标：</label>
        <input class="coord-input" type="number" step="1" data-testid="marker-x"
               :value="markerCoords.x" title="世界坐标（地图内部单位；改完立即落库，一条撤销）"
               @change="onMarkerCoordChange('x', $event)" />
        <input class="coord-input" type="number" step="1" data-testid="marker-y"
               :value="markerCoords.y" title="世界坐标（地图内部单位；改完立即落库，一条撤销）"
               @change="onMarkerCoordChange('y', $event)" />
      </div>
      <div class="props-row">
        <label>剧本：</label>
        <span class="marker-belong">{{ selectedScenario?.name || '（未选剧本）' }}</span>
      </div>
      <div class="props-stats">
        标记 {{ markerOrdinal }} / {{ markerTotal }} · 点图标即选中，改动一次一条撤销
      </div>
      <div class="props-row">
        <button class="props-mini danger" data-testid="marker-delete" :disabled="store.isReadOnly"
                :title="store.isReadOnly ? (store.readOnlyReason || '只读：未打开项目')
                  : '删除这个标记（可 Ctrl+Z 撤回；底图与省份不动）'"
                @click="deleteSelectedMarker">删除标记</button>
      </div>
      <!-- 资料：**同一份实现**（与省份面板共用一个组件）—— 按标记名查只读索引 -->
      <VaultLoreSection testid="marker-vault" :query="selectedMarker.name || ''" />
    </div>

    <!-- 剧本管理对话框 -->
    <div v-if="showScenarioManager" class="modal-overlay" @click.self="closeScenarioManager">
      <div class="modal-dialog scenario-manager">
        <h3>剧本管理</h3>

        <!-- 剧本集管理（2026-10-25）：一组 = 一条独立时间线。删除组**不删剧本**，只退回默认组。 -->
        <div class="scenario-groups" data-testid="scenario-groups">
          <div class="sg-head">
            <span class="sg-title">剧本集</span>
            <span class="sg-hint">切换后左栏、时间轴、播放与切片导出只显示这一组</span>
          </div>
          <div v-for="g in groupOptions" :key="g.id" class="sg-row" :data-testid="'scenario-group-row-' + g.id">
            <template v-if="editingGroupId === g.id">
              <input v-model="editGroupName" class="sg-name-input" data-testid="scenario-group-rename-input"
                     @keydown.enter="commitRenameGroup" @keydown.esc="cancelRenameGroup" />
              <button class="sg-btn primary" data-testid="scenario-group-rename-save"
                      :disabled="!editGroupName.trim()" @click="commitRenameGroup">保存</button>
              <button class="sg-btn" @click="cancelRenameGroup">取消</button>
            </template>
            <template v-else>
              <span class="sg-name" :class="{ current: g.id === activeGroupId }">{{ g.name }}</span>
              <span class="sg-count">{{ groupCount(g.id) }} 条</span>
              <button v-if="g.id !== DEFAULT_SCENARIO_GROUP" class="sg-btn" data-testid="scenario-group-rename"
                      :disabled="store.isReadOnly" title="重命名这个剧本集"
                      @click="startRenameGroup(g)">改名</button>
              <button v-if="g.id !== DEFAULT_SCENARIO_GROUP" class="sg-btn danger" data-testid="scenario-group-delete"
                      :disabled="store.isReadOnly"
                      :title="`删除剧本集「${g.name}」—— 组内 ${groupCount(g.id)} 条剧本会退回「默认」，一条剧本都不会删`"
                      @click="deleteGroup(g)">删除</button>
            </template>
          </div>
          <div class="sg-new">
            <input v-model="newGroupName" class="sg-name-input" placeholder="新剧本集名称（如：第二时间线 / 另一张底图）"
                   data-testid="scenario-group-name" @keydown.enter="createGroup" />
            <button class="sg-btn primary" data-testid="scenario-group-create"
                    :disabled="store.isReadOnly || !newGroupName.trim()" @click="createGroup">新建剧本集</button>
          </div>
          <p class="sg-note">
            剧本集只决定「哪些剧本一起出现在左栏和时间轴上」；删除组只是取消分类，剧本、省份、归属一条都不动。
          </p>
        </div>

        <div class="scenario-list">
          <div v-for="s in allSortedScenarios" :key="s.id" class="scenario-item" :data-testid="'scenario-item-' + s.id">
            <span class="item-era">{{ s.era?.roman || '·' }}</span>
            <span class="item-name">{{ s.name }}</span>
            <span class="item-years">{{ s.era?.startYear || '?' }} – {{ s.era?.endYear || '?' }}</span>
            <select class="item-group" :value="scenarioGroupIdOf(s)" :disabled="store.isReadOnly"
                    :title="`把「${s.name}」移到别的剧本集（不删任何数据）`"
                    data-testid="scenario-item-group"
                    @change="moveScenarioToGroup(s, $event.target.value)">
              <option v-for="g in groupOptions" :key="g.id" :value="g.id">{{ g.name }}</option>
            </select>
            <button class="item-edit" data-testid="scenario-edit" :disabled="store.isReadOnly"
                    :title="store.isReadOnly ? (store.readOnlyReason || '只读：未打开项目')
                      : '编辑剧本信息（名称 / 罗马数字 / 时代标签 / 起止年 / 描述）—— 不改动已录的省份归属与易主日期'"
                    @click="startEditScenario(s)"><Icon name="edit" :size="15"/></button>
            <button class="item-delete" data-testid="scenario-delete" :disabled="store.isReadOnly"
                    :title="store.isReadOnly ? (store.readOnlyReason || '只读：未打开项目') : '删除剧本'"
                    @click="deleteScenario(s)"><Icon name="trash" :size="15"/></button>
          </div>
        </div>
        <!-- 🔴 批量清空（2026-10-11 接活死入口 `removeAllScenarios`）：
             它是**零调用**的（全仓只有导出表里有名字）→ 界面上「剧本只能一条一条删」。
             真实场景：暮雨的项目里塞着 12 条从年表外部导入的占位剧本（无机主日期、无标注、
             一句话描述、势力 id 是机器味英文 pol_state_a），一条条点垃圾桶既慢又容易点错。 -->
        <div class="scenario-bulk" data-testid="scenario-bulk">
          <button
            class="btn-clear-all"
            data-testid="scenario-clear-all"
            :disabled="store.isReadOnly || !allSortedScenarios.length"
            :title="store.isReadOnly ? (store.readOnlyReason || '只读：未打开项目')
              : ('删除全部 ' + allSortedScenarios.length + ' 条剧本（所有剧本集）。只删剧本本身（名称/年份/势力归属/易主记录/标注标记），'
                + '底图与省份边界一个都不动；一条撤销即可回退')"
            @click="clearAllScenarios"
          >清空全部剧本（保留底图与省份）</button>
          <span class="bulk-hint">
            共 {{ allSortedScenarios.length }} 条（所有剧本集）· 底图与省份不受影响 · Ctrl+Z 可撤销
          </span>
        </div>
        <div class="scenario-annos" data-testid="scenario-annotations">
          <h4>「{{ selectedScenario?.name || '（未选剧本）' }}」的标注与标记</h4>
          <div v-if="!annoRows.length" class="anno-empty">
            还没有地名或标记 —— 用工具栏「更多」里的「地名 (T)」「标记 (K)」在地图上放置
          </div>
          <div v-for="row in annoRows" :key="row.key" class="anno-row" :data-testid="'anno-' + row.kind">
            <span class="anno-kind">{{ row.kind === 'label' ? '地名' : '标记' }}</span>
            <span class="anno-text">{{ row.text }}</span>
            <button class="anno-del" data-testid="anno-del" :disabled="store.isReadOnly"
                    :title="store.isReadOnly ? (store.readOnlyReason || '只读：未打开项目')
                      : ('删除' + (row.kind === 'label' ? '地名' : '标记') + '「' + row.text + '」（可撤销）')"
                    @click="deleteAnnotation(row)"><Icon name="x" :size="12"/></button>
          </div>
        </div>
        <div class="new-scenario-form">
          <h4>{{ editingScenarioId ? '编辑剧本' : '新建剧本' }}</h4>
          <!-- 2026-10-22：把「新剧本会绑哪张底图」摆在表单第一行。
               以前不显示，用户以为"新建剧本 = 新地图"，结果还是一张旧底图（真实困惑）。 -->
          <div class="form-row bound-row" data-testid="new-scenario-basemap">
            <label>底图：</label>
            <span class="bound-basemap" :title="baseMapKey ? `新剧本将绑定底图「${baseMapKey}」` : '还没有底图'">
              {{ baseMapKey || '（还没有底图）' }}
            </span>
            <!-- 对话框里也给出口：不管有没有底图，都能"新建一张空底图再建剧本"——
                 用户的困惑就发生在这张表单前（"新建剧本怎么还是旧底图"）。 -->
            <button
              type="button"
              class="bound-add"
              data-testid="new-scenario-basemap-add"
              :disabled="store.isReadOnly"
              :title="store.isReadOnly ? `新建底图已停用：${store.readOnlyReason || '只读：未打开项目'}` : '新建一张空白底图，并让本剧本绑定它'"
              @click="addEmptyBaseMap()"
            >＋ 新建空底图</button>
          </div>
          <div class="form-row">
            <label>剧本集：</label>
            <select v-model="newScenario.group" data-testid="new-scenario-group" class="short-input"
                    title="新剧本落在哪条时间线；切到该组后才出现在左栏与时间轴">
              <option v-for="g in groupOptions" :key="g.id" :value="g.id">{{ g.name }}</option>
            </select>
          </div>
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
            <input v-model="newScenario.startYear" placeholder="如：历年 2006" />
          </div>
          <div class="form-row">
            <label>结束年：</label>
            <input v-model="newScenario.endYear" placeholder="如：历年 2008" />
          </div>
          <div class="form-row">
            <label>描述：</label>
            <textarea v-model="newScenario.description" placeholder="可选说明" rows="2"></textarea>
          </div>
          <div class="form-row">
            <label title="剧本卡片墙（选剧本界面）上显示的一句钩子文案，1-2 句为宜；留空则卡片不显示这行">钩子文案：</label>
            <textarea v-model="newScenario.hook" placeholder="可选 —— 选剧本卡片上的一句话钩子，如：五雄歃血为盟又彼此提防" rows="2"></textarea>
          </div>
          <div class="form-row checkbox">
            <label>继承上一时代：</label>
            <input type="checkbox" v-model="newScenario.inherit" />
          </div>
          <div class="form-actions">
            <button v-if="editingScenarioId" data-testid="scenario-save-edit"
                    @click="saveEditScenario" :disabled="store.isReadOnly || !newScenario.name">保存</button>
            <button v-else data-testid="scenario-create" @click="createNewScenario"
                    :disabled="!newScenario.name || !baseMapKey || !store.baseMaps?.[baseMapKey] || store.isReadOnly"
                    :title="(!baseMapKey || !store.baseMaps?.[baseMapKey]) ? '还没有底图：先在下面点「＋ 新建空底图」，或用「＋」导入 .map' : ''">创建</button>
            <button v-if="editingScenarioId" data-testid="scenario-cancel-edit" @click="cancelEditScenario">取消编辑</button>
            <button v-else @click="closeScenarioManager">关闭</button>
          </div>
          <div v-if="editingScenarioId" class="edit-hint">
            正在编辑既有剧本 —— 保存只改上面这些字段，省份归属 / 易主日期 / 标注 / 标记全部保留
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
      @set-change-date="onSetChangeDate"
      @set-change-dates-bulk="onSetChangeDatesBulk"
      @reject="onPanelReject"
    />

    <!-- 逐年切片导出（EU4 式帧序列）：一次选目录写 N 帧 + frames.json -->
    <scenario-slice-export
      :open="showSliceExport"
      :timeline="timeline"
      :slice-points="slicePoints"
      :province-names="provinceNameMap"
      :status="exportStatus"
      :busy="sliceExportBusy"
      :current-era="tlEra"
      :group-name="groupNameNow"
      @close="showSliceExport = false"
      @run="onRunSliceExport"
    />

    <!-- 019 重导对话框：先摆映射统计/冲突，再让用户点「重导并迁移」 -->
    <div v-if="reimportDialog" class="modal-overlay" @click.self="closeReimportDialog">
      <div class="modal-dialog reimport-dialog" data-testid="reimport-dialog">
        <h3>重导底图为新底图</h3>
        <p class="rd-intro">
          这张底图已经改过（或来源未知），不能当「同一张图只补数据」。
          重导会新建一张底图，并把旧剧本的归属 / 易主迁过去；旧底图保留归档。
        </p>
        <div class="rd-grid">
          <span>旧底图</span><b>{{ reimportDialog.preview.oldName }}</b>
          <span>新文件</span><b>{{ reimportDialog.fileName || '（未命名）' }}</b>
          <span>省份</span><b>{{ reimportDialog.preview.totalOld }} → {{ reimportDialog.preview.totalNew }}</b>
          <span>按 id 直配</span><b>{{ reimportDialog.preview.exact }} 省</b>
          <span>未映射</span>
          <b>旧 {{ reimportDialog.preview.unmappedOld.length }} / 新 {{ reimportDialog.preview.unmappedNew.length }}</b>
        </div>
        <div v-if="reimportDialog.preview.conflicts.length" class="rd-warn" data-testid="reimport-conflicts">
          <strong>{{ reimportDialog.preview.conflicts.length }} 处并省冲突</strong>（多个旧省 → 同一新省），
          默认阻止，不替用户选：
          <ul>
            <li v-for="c in reimportDialog.preview.conflicts.slice(0, 6)" :key="c.newId">
              新省「{{ c.newId }}」← 旧省 {{ c.oldIds.join(' / ') }}
            </li>
          </ul>
          <span v-if="reimportDialog.preview.conflicts.length > 6">…共 {{ reimportDialog.preview.conflicts.length }} 条</span>
        </div>
        <div v-if="reimportDialog.preview.unmappedOld.length" class="rd-warn" data-testid="reimport-unmapped">
          有 {{ reimportDialog.preview.unmappedOld.length }} 个旧省没映射到新省；继续的话这些省的归属会丢：
          <code>{{ reimportDialog.preview.unmappedOld.slice(0, 8).join(' / ') }}</code>
          <span v-if="reimportDialog.preview.unmappedOld.length > 8"> …</span>
        </div>
        <label class="rd-check">
          <input type="checkbox" v-model="reimportDialog.copyReferenceImages" />
          带上旧底图的参考图（默认不带；新 .map 通常有自己的地理）
        </label>
        <div class="rd-actions">
          <button @click="closeReimportDialog">取消</button>
          <button class="primary" :disabled="!reimportDialog.preview.canApply" @click="applyReimportDialog">
            {{ reimportDialog.preview.canApply ? '重导并迁移' : '有冲突，不能重导' }}
          </button>
        </div>
      </div>
    </div>

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

    <!-- 从留底恢复（0.2.9，2026-10-13）：留底目录里的原始 .map 清单 + 逐份恢复。
         只读入口：读清单/读原文都不改世界观数据；「用这份恢复」走的是与「导入 .map」**同一条**链。 -->
    <div v-if="sourceRestoreOpen" class="bmsrc-panel" data-testid="basemap-source-panel">
      <div class="bmsrc-header">
        <span>从留底恢复底图</span>
        <button class="bmsrc-close" data-testid="basemap-source-close" title="关闭" @click="sourceRestoreOpen = false"><Icon name="x" :size="13"/></button>
      </div>
      <div class="bmsrc-body">
        <div v-if="sourceRestoreLoading" class="bmsrc-hint">正在读取清单…</div>
        <div v-else-if="!sourceRestoreFiles.length" class="bmsrc-hint" data-testid="basemap-source-empty">
          这里还没有留底的 .map —— 每次导入 .map 时，原文会自动留一份在项目备份目录里
        </div>
        <template v-else>
          <div class="bmsrc-hint">
            共 {{ sourceRestoreFiles.length }} 份（导入 .map 时自动留底，最近 10 份）。
            恢复 = 拿它走一遍「导入 .map」：同名底图**只补缺**，你已切好的省份与归属不会被覆盖。
          </div>
          <div
            v-for="f in sourceRestoreFiles"
            :key="f.name"
            class="bmsrc-row"
            :data-testid="'basemap-source-row-' + f.name"
          >
            <div class="bmsrc-meta">
              <span class="bmsrc-name" :title="f.path">{{ f.name }}</span>
              <span class="bmsrc-sub">{{ fmtSrcBytes(f.bytes) }} · {{ fmtSrcTime(f.mtime) }}</span>
            </div>
            <button class="bmsrc-use" :disabled="sourceRestoreBusy" @click="restoreFromSource(f)">用这份恢复</button>
          </div>
        </template>
        <div class="bmsrc-dir" v-if="sourceRestoreDir" :title="sourceRestoreDir">{{ sourceRestoreDir }}</div>
        <div v-if="sourceRestoreMsg" class="bmsrc-msg" data-testid="basemap-source-msg">{{ sourceRestoreMsg }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import Icon from './Icon.vue';
import { ref, onMounted, onUnmounted, watch, computed, toRaw, nextTick, unref } from 'vue';

/**
 * 卡片墙进入（2026-10-17 P0）：App 从 ScenarioPicker 带来的初始剧本。
 * - `initialScenarioId`：进入后自动选中该剧本（切 era + 落起始年 + scenario 视图 = selectScenarioAt 的三件套）。
 * - `openManager`：从「新建剧本」空态进来 → 直接打开剧本管理对话框。
 * 不传 = 行为与从前逐字一致（回归基线走这条：harness 注入 __SKIP_SCENARIO_PICKER 直达编辑器）。
 */
const props = defineProps({
  initialScenarioId: { type: String, default: '' },
  openManager: { type: Boolean, default: false },
});
/** 模板里原来只有 `$emit`；现在「返回」需要按上下文分支，脚本侧也要能发事件 */
const emit = defineEmits(['exit', 'picker']);
import { useGeodataStore } from '../store/geodata';
import { useLayersStore } from '../store/layers';
// N1 刀 1（2026-10-30）：渲染层注册表 —— 把 renderFrame 里的手写 if 链变成"层 + order"
import { createLayerRegistry } from '../utils/scenarioLayerRegistry';
// N1 刀 1：四层里已搬出本文件的三组（底图 / 海岸浅滩 / 省界）；文字标注层下一波
import { drawBackgroundLayer, drawBiomeLegendLayer } from '../scenario/layers/background';
import { drawSeaDetailLayer, drawPoliticalCoastLayer } from '../scenario/layers/coast';
import { drawProvincesLayer, drawProvinceBordersLayer } from '../scenario/layers/provinces';
// N1 刀 1：文字标注层（四档统一避让排布 / 地形注记 / 浮动地名）
import { createLabelLayers } from '../scenario/layers/labels';
// N1 刀 2：屏幕空间浮层（小地图 / 文化图例 / 数据分布图 / 城镇悬浮卡）
import { createOverlayLayers } from '../scenario/layers/overlays';
// N1 第三阶段：交互逻辑搬出组件（先搬键盘；鼠标/滚轮随后）
import { createKeyboardHandlers } from '../scenario/interaction/keyboard';
import { createPointerHandlers } from '../scenario/interaction/pointer';
import { createMoveHandlers } from '../scenario/interaction/move';
import { createDownHandlers } from '../scenario/interaction/down';
import { createRiverActions } from '../scenario/interaction/rivers';
import { createMiscActions } from '../scenario/interaction/misc';
import { createProvinceOps } from '../scenario/interaction/provinceOps';
import { createRiverOps } from '../scenario/interaction/riverOps';
import { createHelperActions } from '../scenario/interaction/helpers';
import { createProvinceActions } from '../scenario/interaction/province';
import { createActionHandlers } from '../scenario/interaction/actions';
// N1 刀 2 收尾：交互预览层（原来 317 行的 drawPreviewOverlay）
import { drawPreviewOverlayLayer } from '../scenario/layers/preview';
// N1 刀 2：编辑期覆盖层（顶点手柄 / 框选 / 笔刷圈 / 套索）
import { drawVertexHandlesLayer, drawProvinceBrushOverlayLayer } from '../scenario/layers/editing';
// N1 刀 2：地图要素层（道路/航路 / 手画河 / 城镇）
import {
  drawRoutesLayer, drawRiverPathsLayer, drawBurgsLayer, drawReliefIconsLayer, drawScenarioMarkersLayer,
  drawRiversLayer, drawSelectedRiverHighlightLayer,
} from '../scenario/layers/features';
import { parseMapFile, buildScenariosJson } from '../utils/azgaar-parser';
// 019：判断「这张底图是否一笔未改」—— 决定同图补数据还是新底图迁移
import { isBasemapPristine } from '../utils/basemapIdentity';
// `.map` 的「文件名 → 底图名」与「原文留底」= 与行星视图共用的一份（见 utils/mapImportSource.js）
import { mapNameFromFileName, backupMapSourceFile } from '../utils/mapImportSource';
import { generateRoadPath } from '../utils/placement';
import { drawIconOrEmoji } from '../utils/canvasIcon';
import { buildHeightmapRaster, RASTER_SMOOTH, RASTER_SEA_LEVEL } from '../utils/heightmapRaster';   // M2/A2：与 PlanetMap 共用同一套栅格配色
// 海面细节（2026-10-26）：海深是从高度图**推导**出来的（数据里海格高度是常数，见 utils/seaDepth.js），
// 等深线由 marching squares 抽取（utils/contour.js）。两者都按高度图引用缓存，不落盘。
import {
  buildSeaDepth, SEA_DEPTH_LEVELS, buildDistanceToSea, sampleGridAt, buildSeaDepthFromRings,
} from '../utils/seaDepth';
import { extractIsoLines } from '../utils/contour';
// 两个**不同**判据，别再混（2026-10-11 踩过）：
//   · `hasGrid`（heightmapAccess）= "能否开始用笔刷编辑"（有点即可；历史数据里存在只有点没有 h 的高度图）
//   · `hasHeightmapContent`（terrainRepresentation）= "有没有**地形内容**"（点与 h 都要有）
// 状态栏/缺项诊断要的是后者；用前者会把空壳报成"有地形"（暮雨那张纯色扁平图的困惑来源）。
import { hasGrid } from '../utils/heightmapAccess';
import { hasHeightmapContent } from '../utils/terrainRepresentation';
import HistoryPanel from './HistoryPanel.vue';
import ScenarioTimeline from './ScenarioTimeline.vue';
import ScenarioLineagePanel from './ScenarioLineagePanel.vue';
// 地形生成参数面板（P0-1，2026-10-25）：种子/起伏/山脉/高原/裂谷 + 3 张候选缩略图 → 应用（一条 undo）。
// 参数模型唯一实现在 utils/terrainParams.js（本组件只做展示与触发）。
import TerrainGenPanel from './TerrainGenPanel.vue';
// B 阶段 2（2026-10-29）：FMG 模板地形面板（14 套 Azgaar 模板；生成在 utils/fmg，落库复用同一条写口）
import FmgPanel from './FmgPanel.vue';
// 造陆面板（P0-2，2026-10-25）：大陆轮廓候选 → 铺底切省。轮廓纯几何在 utils/landmass.js，
// 切分复用 utils/voronoiBatch.js + store 的 batchSubdivide（不是第二套切分器）。
import LandmassPanel from './LandmassPanel.vue';
// D3（2026-10-26）：地形注记面板（山脊候选 → 命名 → 应用）
import TerrainLabelsPanel from './TerrainLabelsPanel.vue';
// 文化/宗教/势力派生面板（P0-4，2026-10-25）：只补空 / 覆盖两档；层数据写口全在 store。
import DerivePanel from './DerivePanel.vue';
// 逐年切片导出对话框（2026-10-02）：帧索引/日期体检走 utils/scenarioSlices.js，落盘走主进程一次选目录
import ScenarioSliceExport from './ScenarioSliceExport.vue';
// 剧本元信息编辑（2026-10-07）：改起止年后要用切片对话框**同一份**体检函数报「区间外易主日期」，
// 不另写一套口径（两套口径漂移 = 面板说没事、时间轴悄悄不显示）。
import { changeDateStats } from '../utils/scenarioSlices';
// 读料桥（2026-10-24）：省份 / 标记 → 库内同名词条。
// ⚠️ 实现只有一份：`VaultLoreSection.vue`（本文件只引用组件，不自己调 vaultIndexSearch）——
//    两个使用点各写一份的话，"改一处另两处不变"迟早发生。
import VaultLoreSection from './VaultLoreSection.vue';
// 标记命中的**唯一实现**（2026-10-24，第 5 件补「点标记」）：纯函数、只读，Node 单测直接覆盖
import { hitMarker, markerIdentity, markerIndexOf, MARKER_HIT_RADIUS_PX } from '../utils/markerHitTest';
import {
  buildTimeline, currentOwnerRef, isStriped, polityColor,
  settledCount, eraIndexOfYear, findGap,
  dateToYearValue, formatDate,
} from '../utils/scenarioTimeline';
import { useScenarioExport } from '../composables/useScenarioExport';
import { usePromptDialog } from '../composables/usePromptDialog';
import { useProvinceBrush } from '../composables/useProvinceBrush';
import { simplifyClosedTrace } from '../utils/regionTrace';
// 自由绘制闭环净化（2026-10-22，第三刀）：自交/碎屑/一条线 不再原样落库
import { sanitizeFreehandRing, explainFreehandRejection, selfIntersectionCount } from '../utils/freehandRing';
// T7（H1b）：perfect-freehand 的中心线稳定器 —— 自由绘制/描轮廓先平滑再简化，减少手抖折线
import { smoothStrokePoints } from '../utils/strokeEngine';
import { widthsBySpeed, resampleSeries } from '../utils/strokeMath';
// A8（2026-09-26）：历史剧本「势力标注」—— 分级判定 / 领土聚合 / 标签文本全是纯函数，
// 放在 utils 里以便 Node 侧直接测（渲染里只剩「取数据 + 调 drawStyledLabel」）。
import {
  polityLabelTier, POLITY_LABEL_STYLE, PROVINCE_LABEL_STYLE,
} from '../utils/polityLabels';
import { drawStyledLabel, fontString, drawTextAlongPath } from '../utils/labelStyles';
// 沿路径排字（D3，2026-10-26）：山系名沿脊线、河名沿河 —— 纯几何在 utils/textOnPath.js
import { layoutTextAlongPath, slicePathAroundPoint, pathLength } from '../utils/textOnPath';
// 文字避让（2026-10-26）：四档标签（势力/省/城镇/河）共用一次排布 —— 纯函数，画布与导出同源
import { layoutLabels, AREA_LABEL_PLACEMENTS } from '../utils/labelLayout';
// 缩放 → 详略档位 / 字号（2026-10-27）：Paradox 式「缩小只看势力名、放大出省名」的唯一判定
import { zoomDetail, detailCaps, labelFontScale } from '../utils/labelZoom';
// 文字层样式单源（用户地名 / 标记名 / 城镇名 / 河流名）—— 画布与 SVG 导出共用同一份
import {
  scenarioLabelTextStyle, markerLabelTextStyle, burgLabelTextStyle, riverLabelTextStyle,
  terrainLabelTextStyle,
} from '../utils/mapTextStyles';
// 城镇名 / 河流名的取数上限（纯函数，画布与导出共用；617 个城镇全标就是糊图）
// ⚠️ 档位（标不标、标哪一档）不在这里 —— 见 `utils/labelZoom.js`（按可见比例，带滞回）
import {
  collectBurgLabels, collectRiverLabels,
} from '../utils/scenarioTextPlacement';
// 剧本标签的**唯一判定**（省名 / 势力名 / 简称三档该写什么字、写在哪）—— 与 SVG 导出共用
import { collectScenarioLabels } from '../utils/scenarioLabels';
// C5（2026-10-29）：道路分级渐显的判据（纯函数；与标签/城镇同一套 far→close 档位）
import { arterialLengthThreshold, shouldDrawRoute } from '../utils/routeDensity';
// C2（2026-10-29）：超大国名的走向与折行（纯函数；画布与导出共用同一份决策）
import { planPolityShape } from '../utils/labelOrient';
// 剧本集（2026-10-25）：组判定 / 选项 / 计数 / 初始组**只有一份实现**（utils/scenarioGroups.js）
import {
  DEFAULT_SCENARIO_GROUP, scenarioGroupIdOf, scenarioGroupOptions,
  scenarioGroupNameOf, scenarioGroupCounts, firstNonEmptyGroupId,
} from '../utils/scenarioGroups';
// P0 第二块：省份几何的**唯一表示**（多环实体）与其配套纯函数 —— 渲染/命中/分割/合并/骨架吸附
// 全部走这一层，画布里不再自己实现多边形算法（旧实现里那份凸包合并就是「吃掉邻居省份」的根因）。
import {
  provinceRings, pointInProvince, provinceBBox, shapePatch,
  buildSkeleton, conformToSkeleton, ringPointsForRender,
} from '../utils/provinceShape';
// 省份命中的**空间索引**（2026-10-23，第 1 件 1-a）：把「全表线性扫描」换成「格子里那 1~3 个省」。
// 实测：真实 200 省底图上 findProvinceAt 20.4ms/次 → 涂归属每 mousemove 要查 5 次 = 96.9ms。
// 语义与旧实现**逐字节同义**（靠后的省盖在上面、洞点不中），索引按 terrain 引用缓存。
import { createProvinceHitCache, hitProvince } from '../utils/provinceHitIndex';
// 配色单一来源（2026-10-01）：省份色板 / 海域填充与海界 / 陆界 —— 画布与 SVG 导出共用一份
import { PROVINCE_PALETTE, nextProvinceColor, SEA_FILL, SEA_EDGE, BORDER_COLOR } from '../utils/scenarioPalette';
// B 方案（批量铺底）：画布里要**实时预览** Voronoi 边界，所以直接复用纯几何层（与 store 同一份实现）
import { voronoiCells } from '../utils/voronoiBatch';
// P1（2026-10-13）顶点编辑：**共边顶点**的配对与联动 —— 拖动共边上的顶点时，邻省的同位顶点
// 一起走（方案甲：边界整体移动、无缝无压叠；只认坐标不认拓扑，不做布尔运算）。
import {
  buildCoincidentIndex, findLinkedVertices, shiftPoints, verticesInBox,
} from '../utils/vertexSharing';
// 2026-10-14：导入的河流要裁到**当前海岸线**上（省份轮廓是后重建的，旧几何的尾巴露在海面上）。
// 掩膜与裁剪都是纯函数（Node 有单测），画布只做"按引用缓存 + 给判定注入一点容差"。
import { buildLandMask, clipPolylineToCoast, clipPolylinesToCoast, clipSegmentToLand } from '../utils/coastline';
// 🔴 颜色**单一来源**（2026-10-15 起改了三次，2026-10-17 第六修才真正收口）：
//    画布上**只许有一个河色** = `RIVER_DRAW_COLOR`（`utils/riverRender.js`）。
//    ⚠️ 本文件**不许再 import `RIVER_COLOR`**：那是"写进数据的默认值"，它一旦被用来描边，
//       手画河就会与自带河/自动河分成两种蓝 —— 用户 2026-10-17 的截图正是如此
//       （同一条河一半 #5d97bb 一半 #3B82F6）。`test_103` / `test_107` 有源码守卫。
// 🔴 2026-10-17（剧本底图节点编辑）：底图侧此前**只能整条删了重画** ——
//    这里补上的三件（点河身=加拐点 / 拖节点=微调 / Del=删这个节点）用的判定与行星图
//    **同一份**纯函数（`hitTestRiver` / `findRiverSegment` / `insertNodeBetween` /
//    `distanceToPolyline`），所以两张图里"点哪儿算点中河"的手感一致。
import {
  hitTestRiver, findRiverPointIndex, findRiverSegment,
  insertNodeBetween, replaceRiverNode,
  // 2026-10-17 第八修·三修：选择工具里"没点中河"时要报**差多少像素**，要用它算最近距离
  // （同一份纯函数，与命中判定同口径 —— 不许自己再写一遍距离）
  distanceToPolyline,
  // 🔴 2026-10-17 第七修：`riverWidthsFor` 用它们把"世界单位宽度"夹进河宽字段的量纲。
  //    ⚠️ 漏 import 的后果**不是编译错误而是运行时 ReferenceError**（Vite 不查未声明标识符）：
  //    用户每画一条河 / 每次拖节点预览都会在 `drawRiverPaths` 里抛一次，
  //    表现是「河画了但看不见」+ 连续 3 帧后整块画布被渲染护栏暂停。
  //    是 `scripts/tests/unit/test_undefined_identifiers.js`（全仓扫描）当场抓到的。
  RIVER_WIDTH_MIN, RIVER_WIDTH_MAX,
} from '../utils/rivers';
// 2026-10-14：自动河流的**追踪**与**画法**都是纯函数 ——
// 「河是硬的折线、没有主次」这两条反馈的修法分别在平滑与 riverRender，
// 不在这里现写一套（三处画河共用同一套颜色与线宽口径）。
import { smoothPolyline, TRACE_SMOOTH_ITERATIONS, TRACE_SOURCE_HEIGHT } from '../utils/riverTrace';
// 🔴 2026-10-16（画河保底）：手画河的**抽稀 + 平滑**与行星图共用同一份实现
//    （`polylineSmooth.js`；riverTrace 只是 re-export）。各写一份就会出现
//    "同一笔迹在两张贴图上弯度不同"，而这种偏差不会报错。
// 🔴 2026-10-17：再加 `smoothRiverNodes`（落库用，带高度）、`smoothWhileDrawing`
//    （画的时候就看得见的平滑）与 **`fitPolylineToCount`**
//    （把节点数压到目标值 —— 它是"手画河渲染成一串点"的根治）。
import { decimatePolyline, smoothRiverNodes, fitPolylineToCount } from '../utils/polylineSmooth';
// 🔴 2026-10-17 第八修（用户：「支气管模拟器」「你会画河吗」）：
//    **逐段画**从结构上画不出河。这一层把流向场还原成**河链**（沿 receiver 往上溯、
//    沿主干继续、支流另起），渲染侧改画"链"（每条链一条曲线、逐点变宽）。
//    与开源水文/制图工具的做法一致（Strahler 分级找主干的方式）。
// ⚠️ 模块名用 `riverChains` 而不是 `riverPaths` —— 后者在全仓是"组件本地平行事实源"的
//    禁用词（`test_95` 有红线：手画河曾因本地 `riverPaths` 数组而"画完就丢"）。
import { buildRiverPaths, thinRiverPath } from '../utils/riverChains';
// 河流橡皮的几何（纯函数 + Node 单测）：擦除轨迹 → 留下的连续段 → 原子写口载荷
import { planRiverErase, erasePolylineByStroke } from '../utils/riverErase';
// 手势闸门（第十九修·一）：按住画布 = 自动保存顺延。**唯一接线点就在本组件的
// onMouseDown / onMouseUp**（同一对函数覆盖全部工具：拖笔 / 河笔 / 拖节点 / 框选 / 涂抹 /
// 高度·群系·文化·宗教笔刷 —— 它们都由 mousedown 起笔），所以这里一处接线即全量生效。
import { beginInteraction, endInteraction } from '../utils/interactionGate';
import {
  RIVER_STROKE, buildRiverPolyline, strokeRiver, strokeRiverNetwork, riverWidthAt,
  // 🔴 2026-10-16 第五修：与「地图自带河流」**逐字对齐**的画法常量/公式 ——
  //    色 `#5d97bb`、线宽 `width*6*max(sqrt(discharge)/14, 0.6)` 夹在 0.7~4 屏幕像素。
  // 🔴 2026-10-17 第六修：`RIVER_DRAW_COLOR` 是**唯一**河色；`drawCurvedRiver` 是
  //    「会弯 + 从头到尾变粗」的唯一实现（手画河 / 预览都走它，不再逐点画圆）。
  BASEMAP_RIVER_COLOR, RIVER_DRAW_COLOR, RIVER_BANK_COLOR, basemapRiverWidthPx, basemapRiverWidthWorld,
  flowToDischargeEquivalent,
  drawCurvedRiver, fillRiverRibbon, smoothRiverLine, catmullRomPoints, taperWidths, pruneRiverNetwork, riverFlowGateByQuantile,
  planRiverCoveredRuns, collapseReversedRiverPoints,
  // 逐点河宽（2026-10-26）：宽度因子 / 河口判定 / 变距偏移（宽段高亮不许压进水面）
  riverWidthFactors, pickRiverMouthEnd, offsetPolylineVariable,
  // 🔴 2026-10-18 第十六修：选中轮廓的**偏移几何**与空隙常量下沉到纯函数层 ——
  //    组件里"用加宽的中心线当轮廓"是"选中即盖住水面"的根源；下沉后单测能直接判偏移量。
  offsetPolyline, RIVER_SEL_GAP_PX as RIVER_SEL_GAP_PX_UTIL,
  RIVER_SEL_WEIGHT_PX as RIVER_SEL_WEIGHT_PX_UTIL, riverSelGapForWidth,
} from '../utils/riverRender';

// 保存状态显示：唯一实现在 `composables/useSaveDisplay`（底部状态栏 / 行星图横幅也用它）
import { useSaveDisplay } from '../composables/useSaveDisplay';
// ⚠️ `useStatusBarState()` 在本组件只作**诊断注入口**保留（`test_91` 在真机上用 `sc.sbState`
//    注入落盘失败态）。显示合成一律走 `useSaveDisplay()`，**不要**在这里再写第二份 computed。
import { useStatusBarState } from '../composables/useStatusBar';

const store = useGeodataStore();
const layers = useLayersStore();

// ── 保存状态显示（2026-10-09 重做；2026-10-17 收口到唯一实现）─────────────────
// 🔴 历史剧本里**有两条保存链**，旧实现只显示了其中一半：
//    · geodata（`store.saveStatus`）—— 把画布改动推给项目 / 直接写 scenarios.json
//    · projectStore（写在全局 `useStatusBar` 的 `saveState` 里）—— **真正把 .sitian 写进磁盘**
//    只盯前者的两个坏结果：① 项目落盘失败时这里毫无反应（用户以为存好了）；
//    ② 项目态下 geodata 只到 'staged'，这里**永远显示不出「已保存」**（用户不知道到底存没存）。
//    所以项目侧的失败优先级最高 —— 那才代表「数据没进磁盘」。
// 🔴 另外失败必须**把原因写进文字**：暮雨实测「保存失败就是保存失败，我没看到其他内容」。
// 🔴 2026-10-17：合成逻辑搬到 `composables/useSaveDisplay.js`（+ 纯函数
//    `utils/saveStatusText.js`）—— 行星地图与底部状态栏也接同一份。
//    本组件不再保留第二份 `computed` 合成：「保存到底成没成」一旦有两套口径，
//    先变的那一套会静默把另一套变成谎言（行星图当时仍按 `result.success` 报「保存成功」）。
const saveDisplay = useSaveDisplay();
const sbState = useStatusBarState();

// P2：省份「矢量级归属」——笔刷 / 套索 / 点填 = 对多边形做布尔（数据在 store 的 provinceEditing 模块）
const provinceBrush = useProvinceBrush();
const { radius: provBrushRadius, strength: provBrushStrength, tool: provBrushTool,
        targetIdx: provBrushTarget } = provinceBrush;
// 🔴 P2（2026-10-09）：**多边形是唯一的几何表示**。旧的「归属标签网格」不再参与渲染或编辑 ——
//    它在抬手时把格点轮廓反向写成多边形，10525 点的海岸线一次涂抹就变 ~22 点（用户实测的「退化」）。
//    现在涂完抬手即做**精确布尔**：目标省并集、相交省差集。详见 docs/SCENARIO_PROVINCE_FIX_PLAN.md。
let provStrokeActive = false;             // 涂抹中（改省界 / 抹除 / 平滑）
let provPaintActive = false;              // 笔刷建省涂抹中（2026-10-22：抬手才建省）
let provLassoActive = false;
const provLassoPoints = ref([]);          // 套索轨迹（世界坐标）
const provBrushPreview = ref(null);
const provinceHint = ref('');             // 省份操作提示（状态栏）
// 🔴 锁定海岸线（默认开，2026-10-09 暮雨要求）：涂归属 / 圈选只在已有省份范围内生效，
//    笔迹被裁剪到「已有省份的并集」之内 → 海岸线不会被涂抹改掉（改它请走底图编辑）。
const lockCoast = ref(true);
/**
 * 描轮廓的改判方向（E，2026-10-11）。
 * 默认**开** = 围住的那块地改判给「贴着描的那个邻省」——
 * 因为围住的地本来就在**原主**手里，不换主的话这一笔必然看不出变化
 * （首版就是按"区域里占比最高的省"选的，结果 targetIdx 恒等于原主、只有 union 没有 difference）。
 */
const outlineToNeighbor = ref(false);

// ── 折线切割（A，2026-10-11）────────────────────────────────────────────────
// 现状只有「拆分 (X)」= 两点**直线**切一刀。要沿着海岸 / 山脊 / 历史边界切，
// 直线做不到；而切四五百块时，精修阶段真正需要的就是「任意折线」。
const polySplitPoints = ref([]);        // 已点下的折线顶点（世界坐标）
const polySplitHover = ref(null);       // 橡皮筋终点（跟随鼠标）
const polySplitKeepStart = ref(true);   // 哪一半保留原省份身份（Shift 切换）
const polySplitPreview = ref(null);     // { a, b } 几何预览（两块的多环）
let polySplitPreviewTimer = null;
/** 折线预览要切开哪个省：折线第一点所在（或折线穿过的）省份 */
const polySplitTarget = computed(() => {
  const pts = polySplitPoints.value;
  if (!pts.length) return null;
  const terr = baseMap.value?.terrain || [];
  const withGeom = terr.filter((p) => provinceRings(p).length);
  const hit = withGeom.find((p) => pointInProvince(pts[0].x, pts[0].y, p));
  if (hit) return hit;
  // 第一点落在省外（很常见：从海上往岸上拉）→ 用折线中点找
  const mid = pts[Math.floor(pts.length / 2)];
  return withGeom.find((p) => pointInProvince(mid.x, mid.y, p)) || null;
});

// ── 批量铺底（B，2026-10-11）────────────────────────────────────────────────
const batchScope = ref('land');         // 'land' = 全部陆地省 / 'selection' = 选中的省
const batchCount = ref(400);            // 目标块数
const batchJitter = ref(0.62);          // 播种抖动
const batchSeedValue = ref(1);          // 随机种子（「换一批」= +1）
const batchSeeds = ref([]);             // 种子点（自动播种或手动点）
const batchBusy = ref(false);
const batchStatus = ref('先「自动播种」，或在画布上点几下放种子');
/** C：当前这一批切分的取消令牌（`{cancelled:boolean}`）—— 与 store 之间唯一的取消通道 */
let batchCancelToken = null;
const batchTargets = computed(() => {
  const terr = baseMap.value?.terrain || [];
  if (batchScope.value === 'selection' && selectedProvinceIds.value.length) {
    return terr.filter((p) => selectedProvinceIds.value.includes(p.id) && provinceRings(p).length);
  }
  return terr.filter((p) => (p.kind || 'land') !== 'sea' && provinceRings(p).length);
});
const batchTargetCount = computed(() => (batchScope.value === 'selection' && selectedProvinceIds.value.length
  ? selectedProvinceIds.value.length
  : (baseMap.value?.terrain || []).filter((p) => (p.kind || 'land') !== 'sea' && provinceRings(p).length).length));
/**
 * 预览用的 Voronoi 边界：**只画不裁**（不外扩到海里就不裁）——
 * 真切分时 store 会把每块与陆地求交；预览只求"能看出密度与形状"。
 */
const batchPreviewCells = computed(() => {
  const pts = batchSeeds.value;
  if (!pts.length) return [];
  const bb = provinceBBox({ points: pts.map((p) => ({ x: p.x, y: p.y })) }) || { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const pad = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY, 1);
  const box = { minX: bb.minX - pad, minY: bb.minY - pad, maxX: bb.maxX + pad, maxY: bb.maxY + pad };
  return voronoiCells(pts, box).rings;
});
/** 种子点是否落在"范围内"（预览里区分内外：外面的会被丢弃）
 *  🔴 必须是 **computed**（缓存）：`pointInProvince` 在真实底图上是上万点，
 *     每帧对 400 个种子里逐个判 = 千万级运算，直接把画布拖成幻灯片。 */
const batchPreviewInside = computed(() => {
  const targets = batchTargets.value;
  return batchSeeds.value.map((p) => targets.some((prov) => pointInProvince(p.x, p.y, prov)));
});

const canvas = ref(null);
const canvasWrap = ref(null);

// ── 高分屏清晰度（2026-10-01）────────────────────────────────────────────────
// 其余 6 个画布视图（Galaxy/System/SystemDetail/Planet/Area/Interior）共用
// `useCanvasRenderer` 的 DPR 缩放（canvas.width = CSS 宽 × devicePixelRatio + ctx.scale）；
// 只有剧本画布自己写 `canvas.width = clientWidth` → 在 150%/200% 缩放的屏上是**位图放大**
// = 天然发虚（而导出反而更清晰，于是「看起来不如位图」的锅落在了矢量路线头上）。
// 🔴 纪律：画布尺寸在**绘制/命中/布局**里一律读 `cw()` / `ch()`（CSS 像素空间），
//    不要再读 `canvas.width` —— 那是设备像素；只有 resize / 导出建离屏画布时才碰它。
let canvasDpr = 1;
const cw = () => (canvas.value ? canvas.value.width / canvasDpr : 0);
const ch = () => (canvas.value ? canvas.value.height / canvasDpr : 0);
// 默认工具 = **选择**（2026-10-09 改，原为 draw）。
// 🔴 为什么翻转：暮雨实测「打开历史剧本，本能想拖动地图查看，却意外触发绘制机制，
//    弹窗问『仍要在这里创建吗』」—— 拖拽查看是任何地图编辑器的第一直觉动作，
//    默认停在「自由绘制」等于把最常用的动作变成最危险的误触。想画省份显式按 B / 点工具栏。
//    （原 P1 让 draw 当默认是为了「新建项目进来就能画」，代价是误触；两害相权，先保不误伤。）
const tool = ref('select');
// P3：工具栏按任务分层 —— 默认只有 6 个可见控件，其余收进「更多」（能力不减）
const moreOpen = ref(false);

// ── 底图编辑模式（2026-10-18 第十七修）──────────────────────────────────────
//
// 用户原话：「事实上我甚至觉得这玩意得进底图编辑，**底图编辑要单开一个编辑模式**，
//   不要和日常的剧本编辑混在一起」。
//
// 口径（**只做分组与可见性，不改任何工具语义**）：
//   · 日常模式（默认关）＝ 省份 / 归属 / 剧本（历史归属是"覆盖在地块上的数据"）；
//   · 底图编辑模式（开）＝ 画地理：地形 / 河流 / 道路 / 地貌 / 地名 / 文化 / 宗教 / 高度 / 群系 / 标记 / 聚落。
//   🔴 **点地理类工具时自动打开模式**（见 `setTool` 的门）—— 这样既有 60+ 个用例（它们直接调
//      `setTool('river')` 或点按钮）**零迁移**，而人也永远看得见"现在在哪个模式里"。
//      "模式"在这里的职责是**让人知道编辑对象换人了**，不是把能力锁起来（锁起来只会制造"点了没反应"）。
const basemapEditMode = ref(false);
/** 底图编辑模式里的工具清单（唯一来源；行内按钮由它渲染） */
const BASEMAP_TOOLS = [
  { id: 'height', icon: 'mountain', label: '高度', title: '高度笔刷 (H) — 按住抬高 / 右键降低（滚轮调半径、Shift+滚轮调强度）' },
  { id: 'lake', icon: 'droplet', label: '湖泊', title: '湖泊工具 (Shift+L) — 按住挖湖盆；松手后海陆重标，不触边的洼地成湖（临海会灌穿成海湾）' },
  { id: 'biome', icon: 'palette', label: '群系', title: '生物群系笔刷 (N) — 涂抹生物群系' },
  { id: 'relief', icon: 'mountain', label: '地貌', title: 'Relief 图标 (I) — 放置山脉/树木/沙漠等自然特征' },
  { id: 'river', icon: 'droplets', label: '河流', title: '河流编辑器 (W) — 按住拖出笔迹画河；**Shift + 按在已有河的河身上拖出去 = 画支流**；点河身加拐点；拖节点微调' },
  { id: 'riverErase', icon: 'eraser', label: '橡皮', title: '河流橡皮 (Shift+W) — 按住抹过河身，擦掉那一段；一条河被擦断会**断成两条**（切口落在橡皮圈边上）；一次擦除 = 一条撤销。只擦手画的河（导入河/自动河不动）' },
  { id: 'road', icon: 'route', label: '道路', title: '道路 (K) — 逐点画一条路' },
  { id: 'culture', icon: 'palette', label: '文化', title: '文化笔刷 (C) — 涂抹文化分布' },
  { id: 'religion', icon: 'flame', label: '宗教', title: '宗教笔刷 (R) — 涂抹宗教分布' },
  { id: 'label', icon: 'type', label: '地名', title: '地名牌 (T) — 地图上放一个地名' },
  { id: 'marker', icon: 'map-pin', label: '标记', title: '标记 (M) — 放一个地图标记' },
  { id: 'burg', icon: 'home', label: '聚落', title: '聚落 (U) — 放一个城镇/村庄' },
];
const BASEMAP_TOOL_IDS = new Set(BASEMAP_TOOLS.map((t) => t.id));
function toggleBasemapEditMode() {
  basemapEditMode.value = !basemapEditMode.value;  // 🔴 开模式**顺手收起「更多」**（2026-10-18 第十七修·出图实测）：
  //    第一版是"开模式就展开「更多」"，结果工具栏从 ~120px 撑到 **~470px**（出图
  //    `docs/assets/basemap-mode-20261018/02-basemap-edit-mode.png` 一眼可见）——
  //    画布被压掉一半，而"模式分区"的收益全被这个面板吃掉了。
  //    地理类工具**已经在模式行里**；「更多」里的那几件（参考图 / 自带-自动河源 / 着色档 / 吸附）
  //    是**进阶开关**，想用再点开。同理：`setTool` 的自动开模式更不该碰 `moreOpen`
  //    （那会让"切一下工具"就展开 42vh 面板，实测把 `test_61` 的画布内容判空判红）。
  if (basemapEditMode.value) moreOpen.value = false;
  statusMsg(basemapEditMode.value
    ? '已进入底图编辑模式 —— 这一行是画地理；关掉它回到日常剧本编辑'
    : '已退出底图编辑模式 —— 回到日常剧本编辑（省份 / 归属 / 剧本）');
}

/**
 * 左上角「返回」：**先退子模式，再退模块**（2026-10-21，暮雨实测误触）。
 *
 * 旧行为：底图编辑里点「← 返回」→ 直接 `exit`，整个历史剧本被退掉。
 * 新行为：
 *   · 底图编辑中 → 只关底图编辑，留在历史剧本（按钮显示「← 返回日常」）；
 *   · 日常态   → 才退出历史剧本（按钮显示「← 退出剧本」）。
 * 模块级退出另有顶部「世界观」页签，这里不再是唯一出口。
 */
function onBackClick() {
  if (basemapEditMode.value) {
    basemapEditMode.value = false;
    statusMsg('已退出底图编辑 —— 回到日常剧本编辑（历史剧本还在；要离开请点「← 退出剧本」或顶部「世界观」）');
    render();
    return;
  }
  emit('exit');
}
const ADVANCED_TOOLS = new Set(['split', 'merge', 'provinceFill', 'paint', 'river', 'relief', 'label',
  'erase', 'height', 'biome', 'burg', 'culture', 'religion', 'marker', 'road']);
const advancedToolActive = computed(() => ADVANCED_TOOLS.has(tool.value));
// 「变更归属」的省份选项：选到这类工具（或用户自己打开「更多」）就显示
const PROVINCE_TOOLS = new Set(['provinceBrush', 'provincePaint', 'provinceLasso', 'provinceFill', 'split', 'merge', 'vertex', 'polySplit', 'voronoi', 'outline', 'ownerBrush']);
const provinceRowVisible = computed(() => moreOpen.value || PROVINCE_TOOLS.has(tool.value));
const viewMode = ref('base');
/**
 * 当前模式在做什么 —— 一句话说明。
 * 🔴 为什么必须显式写出来：两个模式的**工具栏完全相同**（同一套 setTool），
 *    差别只体现在着色与图层上（见各 viewMode 判定点）。用户切来切去只能靠猜
 *    （暮雨实测：「搞了半天依然没搞懂」）。
 */
const viewModeHint = computed(() => (viewMode.value === 'scenario'
  ? '改政治版图：势力归属 / 易主 —— 省份按势力着色'
  : '改自然面貌：地形高度 / 群系 / 河流 —— 省份按群系着色'));
// ── 底图高度图（A1，2026-09-24）──────────────────────────────────────────────
// 底图的高度图此前只有「.map 导入」一条来源 → 新建的底图用不了任何高度类工具（静默 return）。
/** 当前底图绑定到的行星 id（绑定了则高度图归行星侧，底图不该再自建） */
/** 当前底图绑定到的行星 id（绑定了则高度图归行星侧，底图不该再自建） */
const baseMapBoundPlanet = computed(() => (baseMapKey.value ? store.getBoundPlanetId(baseMapKey.value) : null));
/** 当前底图是否已有可用高度图网格（判据 = `hasGrid`：笔刷/派生的"能用"口径） */
const baseMapHasHeightmap = computed(() => {
  if (!baseMapKey.value) return false;
  return hasGrid(store.getHeightmapFor(baseMapKey.value));
});
/** 当前底图是否已有**地形内容**（空壳高度图不算）—— 用于状态栏与「缺什么」诊断 */
const baseMapHasTerrainContent = computed(() =>
  hasHeightmapContent(store.getHeightmapFor ? store.getHeightmapFor(baseMapKey.value) : null));

/** 是否显示「创建高度图」按钮：已选底图 + 未绑定行星 + 还没有网格 */
const baseMapCanCreateHeightmap = computed(() =>
  !!baseMapKey.value && !baseMapBoundPlanet.value && !baseMapHasHeightmap.value);

/**
 * 是否显示「按轮廓生成地形」按钮（2026-10-17 第八修·改向）：
 * 已选底图 + 未绑定行星 + **已经画了陆地**。
 *
 * 🔴 2026-10-17 再修（用户实测：「工具『更多』没找到按轮廓生成地形，不知道点哪个」）：
 *    第一版的显示条件里还有 `!baseMapHasHeightmap` —— 于是**正好在用户找它的时候把它藏了**
 *    （他的底图有导入的高度图）。这是本项目第 N 次同一类错误：**条件式隐藏 = 等于没做**。
 *    现在：只要有底图 + 有陆地就**一直显示**；已经存在高度图时按钮改为"重新推演"语义，
 *    点了会**明确询问是否覆盖**（覆盖走 undo，可撤回），而不是隐身。
 */
const baseMapCanSynthesizeTerrain = computed(() =>
  !!baseMapKey.value
  && !baseMapBoundPlanet.value
  && Array.isArray(rawTerrain()) && rawTerrain().length > 0);

/** 「按轮廓生成地形」—— 见按钮注释：给自建底图一个能长出河流的本地地形起点 */
// synthesizeBaseMapTerrainFromShape 已搬到 misc.js（2026-10-31）


// ── P0-1（2026-10-25）：地形生成参数面板 ─────────────────────────────────────
// 「按轮廓生成地形」保留为**一键最快路径**（默认参数）；想调/想挑形状走这个面板。
// 两条路都走同一个 store 入口（`synthesizeBaseMapTerrain`），所以 undo/落盘/绑定行星
// 的行为天然一致 —— 不许给面板再写一条"直接改 baseMaps"的捷径。
const terrainGenOpen = ref(false);
/** B 阶段 2（2026-10-29）：FMG 模板地形面板开关（与「生成参数」是两个引擎，各自一个入口） */
const fmgOpen = ref(false);

function toggleTerrainGenPanel() {
  if (!baseMapKey.value) { statusMsg('先选一张底图'); return; }
  terrainGenOpen.value = !terrainGenOpen.value;
}

// ── D3（2026-10-26）：地形注记 —— 山系名沿脊线排 ──────────────────────────────
// 名字由用户给（面板里逐条命名），几何来自 `ridges.detectRidges` 的候选；
// 落库走 store 的 `applyTerrainLabels`（整表一条 undo）。
const terrainLabelsOpen = ref(false);
/** 与「自动地名」分开：FMG 的英文城镇名可以关，山系名是自己的数据、默认开 */
const showTerrainNames = ref(true);

function toggleTerrainLabelsPanel() {
  if (!baseMapKey.value) { statusMsg('先选一张底图'); return; }
  terrainLabelsOpen.value = !terrainLabelsOpen.value;
}

function applyTerrainLabelsResult(msg) {
  statusMsg(msg || '地形注记已保存');
  render();
}

/**
 * 「地形名」勾选（2026-10-27 用户 A2/B2：「勾了地形名完全看不见」）。
 *
 * 真相：这张底图 `terrainLabels = 0` —— 地形注记是**用户命名**的数据（检测山脊候选或手绘），
 * 没有名字就没有东西可画。旧界面勾上后**一声不响**，看起来像渲染坏了。
 * 现在：勾上且一条都没有 → 直接把「地形注记」面板打开并说清下一步。
 */
function onTerrainNamesToggle(e) {
  const on = !!(e && e.target && e.target.checked);
  if (!on) { render(); return; }
  const n = (baseMap.value?.terrainLabels || []).length;
  if (n === 0) {
    if (baseMapKey.value) terrainLabelsOpen.value = true;
    statusMsg('这张底图还没有地形注记（0 条）—— 已打开「地形注记」面板：点「检测山脊」或用「画山系 / 画海域 / 点平原」自己画一条，命名后「应用」');
  }
  render();
}

// ── D3 手绘（2026-10-27）：山系/海域拖一条线、平原点一个点 ──────────────────
// 为什么几何采集放这里而不是面板里：只有画布知道相机与屏幕→世界的换算，
// 也只有它能画「拖到一半」的预览。面板负责命名与整表落库（`applyTerrainLabels`），
// 两边合成的仍是**同一条数据形状**与**同一个写口**。
const terrainLabelPick = ref(null);
const TERRAIN_PICK_MIN_STEP = 3;     // 屏幕像素：采样抽稀，别让一条线攒出上千点

function startTerrainLabelPick(kind) {
  if (!baseMapKey.value) { statusMsg('先选一张底图'); return; }
  if (store.isReadOnly) { statusMsg(`地形注记已停用：${store.readOnlyReason}`); return; }
  const k = ['range', 'sea', 'plain'].includes(kind) ? kind : 'range';
  terrainLabelPick.value = { kind: k, points: [], dragging: false, finished: false };
  statusMsg(k === 'plain' ? '平原注记：在地图上点一下落个点' : '在地图上拖一条线（松开鼠标完成）');
  render();
}

function clearTerrainLabelPick(msg) {
  terrainLabelPick.value = null;
  if (msg) statusMsg(msg);
  render();
}

/** 面板「完成」→ 采到的点已经变成一行（面板负责），这里只收尾 */
function onTerrainLabelPickDone() {
  clearTerrainLabelPick('');
}

function cancelTerrainLabelPick() {
  clearTerrainLabelPick('已取消手绘注记（数据未改）');
}

/** 面板应用回执：与一键入口做同样的画布侧收尾（缓存失效 + 切到地形高度 + 重绘） */
function applyGeneratedTerrain(r) {
  rasterCache.clear();
  rasterLayer.value = 'height';
  // 两个引擎（按轮廓推演 / FMG 模板）共用一个收口：谁应用完都关面板、切高度档、递回执
  terrainGenOpen.value = false;
  fmgOpen.value = false;
  statusMsg((r && r.message) || '已生成地形');
  render();
}

// ── P0-2（2026-10-25）：造陆面板 ─────────────────────────────────────────────
// 「造陆」= 生成轮廓 + 现有铺底切省（store 里合成**一条 undo**）。
// 只读态/绑定行星都不影响省份创建；已有陆地时面板里会先问一次（覆盖 = 整张替换）。
const landmassOpen = ref(false);

function toggleLandmassPanel() {
  if (!baseMapKey.value) { statusMsg('先选一张底图'); return; }
  landmassOpen.value = !landmassOpen.value;
}

// applyLandmassResult 已搬到 misc.js（2026-10-31）


// ── P0-4（2026-10-25）：文化/宗教/势力派生 ───────────────────────────────────
const deriveOpen = ref(false);

function toggleDerivePanel() {
  if (!baseMapKey.value) { statusMsg('先选一张底图'); return; }
  deriveOpen.value = !deriveOpen.value;
}

/** 派生回执：文化层变了要清栅格缓存；势力归属变了会走既有渲染路径 */
function onDerived(r, kind) {
  if (kind === 'culture') rasterCache.clear();
  statusMsg((r && r.message) || '已派生');
  render();
}

// ── P5：高度图分辨率（2026-10-14）────────────────────────────────────────────
// 「地形模模糊糊」的量出来的事实：源网格 133×75 / spacing 14.4，在 1900×1080 的画布上
// **每格约 3.6 屏幕像素**（放大到 400% 时 1 格占一屏）。渲染侧已经在做子格双线性，但
// 每格的颜色是固定的 → 唯一真正有效的做法是把格子变密。
const resampleOpen = ref(false);
const resampleFactor = ref(2);
const resamplePreview = computed(() => {
  const hm = baseMapKey.value ? store.getHeightmapFor(baseMapKey.value) : null;
  if (!hm || !hm.grid || !Array.isArray(hm.grid.points) || !hm.grid.points.length) return null;
  return store.estimateResampleCost(hm, resampleFactor.value);
});
const baseMapCanResample = computed(() =>
  !!baseMapKey.value && !!resamplePreview.value && resamplePreview.value.srcCells > 0);
const smoothRadius = ref(1);

/**
 * 🔴 自动河流的**源头高度闸门**（2026-10-14 第三轮补）。
 *
 * 为什么它必须有 UI：实测证明**这个读数就是这份地形上"河有几条"的主宰** ——
 * `desite` 底图默认 60 只出 **3 条**，降到 40 立刻 **67 条**（同一份数据，见
 * `docs/RIVER_NATURALNESS_AND_RESOLUTION_20261014.md` 的对照表）。旧口径下这个值
 * 写死在 `TRACE_SOURCE_HEIGHT`，用户看到"就 3 条河"时**既不知道是被闸门卡的，
 * 也无从调**——这正是本项目反复踩的"能力存在但够不着"。
 *
 * ⚠️ 只改**这一次点击**的参数（不落盘、不进项目）：它是"看地形"的临时旋钮，
 *    不是需要持久化的世界设定。默认值仍从纯函数层取（`TRACE_SOURCE_HEIGHT`），
 *    避免在组件里另立一套数字（那就会出现"面板显示 60、算法用别的值"）。
 */
const riverSourceHeight = ref(TRACE_SOURCE_HEIGHT);

/**
 * 🔴 **追踪前先平滑地形**（2026-10-16 用户实测截图：「很丑的折线，有种恐怖感」）。
 *
 * 根因不是配色也不是线宽，是**几何分辨率**：真实底图高度图只有 **133×75 / 格距 14.4**
 * （岛宽 1700），最长代表路径只有 **140 世界单位 = 岛宽的 8%**、段长中位 **1.2 格**
 * → 画出来必然是"几百根短、直、放射状的小棍"（见 `docs/RIVER_UGLINESS_ROOT_CAUSE_20261016.md`）。
 *
 * 实测（`scripts/tests/tools/_proto_smooth_trace.mjs`，真实 desite 底图）：
 *   先做 r=2 p=1 的盒滤波再追踪 → **最长河 140 → 270（≈2 倍）**、中位 69 → 92，
 *   河网从"挤在海岸"变成铺开全岛。
 *
 * ⚠️ **默认关**（`riverSmooth` 初值 false）→ 行为与以前**一字不差**。
 * ⚠️ **代价必须一起处理**：平滑压低山头 → 源头高度闸门更难满足
 *   （实测 r=3 p=3 = **0 条河**）。所以勾上时会把闸门**自动下调到 40**（并回执说明），
 *   否则用户看到的是"开了平滑反而一条河都没有"。
 */
const riverSmooth = ref(false);
const riverSmoothRadius = ref(2);       // 与实测最优 r=2 p=1 对齐
const riverSmoothPasses = ref(1);
/**
 * 山体阴影（2026-10-17 第七修）—— 用户「地形怎么3D表现」的落点。
 * 🔴 **默认关**（零行为变更）：开了会改变所有既有底图的观感，必须由用户自己选。
 * `terrainShadeStrength` 是强度（1 = 默认；`buildShadeMap` 里按本幅图高度标准差归一化）。
 */
const terrainShade = ref(false);
const terrainShadeStrength = ref(1);
/** 勾上平滑时把源头高度闸门下调到这个值（实测 60 → 0 条、40 才有河） */
const RIVER_SMOOTH_SOURCE_HEIGHT = 40;

/**
 * 🔴 **这份地形能不能生出长河**（2026-10-16 第三轮，查导入链路时量出来的硬结论）。
 *
 * 判据是**网格规模**：单格最大汇流累积 ≤ 陆格数，而粗网格上它必然很小。
 * 真实底图实测 **133×75 → segMaxFlow = 22**（手写的标准水文管线也是 22）→ 最长河约 22 格
 * ≈ 316 世界单位，只有岛宽（≈1700）的 19%。细网格（≥200×200）不提示，避免变成噪音。
 * 根因**不在算法也不在导入链路**（已查证原始 `.map` 的 `points`/`cells.h` 与项目里存的一字不差）：
 *   `.map` 自己写着 `cellsDesired: 10000`（Azgaar **最小档**），`cells.h` 还是取整到 0~100 的粗副本。
 *   → 这份数据里**不存在**能生成长河的原始信息，任何算法都变不出来。
 * ⚠️ 这条提示是**常驻**的（生成前就看得到）—— "点了个按钮才发现没用"是最坏的体验。
 */
const riverTerrainAdvice = computed(() => {
  const hm = baseMap.value?.heightmap;
  if (!hm || !Array.isArray(hm.h) || !hm.grid) return '';
  const cols = hm.grid.cellsX | 0, rows = hm.grid.cellsY | 0;
  const sp = hm.grid.spacing || 14.4;
  if (!cols || !rows) return '';
  const cells = cols * rows;
  if (cells > 40000) return '';
  // 最长可能河道 ≈ 单格汇流上界（= 格数开方向的量级）；这里只给量级，不假装精确
  const approxLen = Math.round(cols * sp / 6);
  return `⚠️ 这份高度图只有 ${cols}×${rows} 格（${cells} 格，格距 ${sp}）：实测单格最大汇流只有 `
    + `**22 格** → 最长河约 ${approxLen} 世界单位（量级），只有底图宽度的两成。`
    + `**长河在这份数据里不存在**（原始 .map 是 Azgaar 的 10000 格最小档、高度还取整到 0~100；`
    + `导入链路没有降采样 —— 已查证）。想要长河：在 Azgaar 里把 cellsDesired 调大重导；`
    + `或直接用「河流来源 → 只画底图自带」（那 160 条自带河好看得多）。`;
});

function openResamplePanel() {
  resampleOpen.value = !resampleOpen.value;
}
function applyResample() {
  const r = store.resampleBaseMapHeightmap(baseMapKey.value, resampleFactor.value);
  if (!r || r.ok === false) { statusMsg((r && r.message) || '调整分辨率失败'); return; }
  resampleOpen.value = false;
  // ⚠️ 这里**刻意不手写 `rasterCache.clear()`**：格数/内容变了，高度图对象引用就变了，
  //    而栅格缓存的键里含这个引用（见 `getRaster`）→ 自己就失效了。
  //    手写 clear 是"两处都要记得改"的双源（本项目反复踩的那类）。
  statusMsg(r.message + ' —— 已重建，可用 Ctrl+Z 撤销');
  render();
}
function applySmooth() {
  const r = store.smoothBaseMapHeightmap(baseMapKey.value, { radius: smoothRadius.value, passes: 1 });
  if (!r || r.ok === false) { statusMsg((r && r.message) || '平滑失败'); return; }
  statusMsg(r.message);
  render();
}

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
  render();
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
  render();
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
  render();
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
/**
 * 「清除归属」模式（2026-10-20）—— 色板上的 ✕。
 *
 * 为什么必须是一个**显式模式**：`selectedPolity = null` 同时表示"还没选"和"要清空"，
 * 而涂归属在"没选"时会自动落到第一个势力（否则工具表现成"涂不了"）。两者混在一起，
 * 用户点 ✕ 再涂反而会被涂上第一个势力。所以 ✕ = 一个独立的意图：
 * 涂到的省**删掉 ownership 键**（真无主），油漆桶/涂归属都认它。
 */
const clearOwnerMode = ref(false);
watch(() => selectedScenario.value?.polities, (list) => {
  const cur = selectedPolity.value;
  if (!cur) return;
  if (!list) { selectedPolity.value = null; return; }
  // 势力被删 → 清空选中（不留悬空引用）；否则指向同一个 id 的最新对象
  selectedPolity.value = list.find((p) => p.id === cur.id) || null;
});
const ctx = ref(null);
const showScenarioManager = ref(false);
// 沉浸看图模式（2026-10-17 P0，暮雨拍板）：收起顶栏/侧栏/时间轴，地图占满；Ctrl+I 切换。
// 底部工具胶囊 8 秒无操作自动淡出（`capsuleDim`）。
// 小地图显隐：**复用既有 `showMinimap`**（6683，此前无 UI 开关）——本轮给它补按钮与偏好持久化。
const immersive = ref(false);
const capsuleDim = ref(false);
let capsuleTimer = 0;
function pokeCapsule() {
  if (!immersive.value) return;
  capsuleDim.value = false;
  clearTimeout(capsuleTimer);
  capsuleTimer = setTimeout(() => { capsuleDim.value = true; }, 8000);
}
function toggleMinimap() {
  showMinimap.value = !showMinimap.value;
  try { localStorage.setItem('sitian-scenario-minimap', showMinimap.value ? '1' : '0'); } catch { /* 隐私模式 */ }
  render();
}
watch(immersive, () => { pokeCapsule(); nextTick(() => { if (baseMap.value?.terrain?.length) fitToView(); }); });
/** 「历史剧本」常驻左栏是否展开（收起后只留一条标题栏，腾出画布空间） */
const showScenarioList = ref(true);
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

function toggleLayerLock(layerId) {
  const layer = scenarioLayers.value[layerId];
  if (layer) {
    layer.locked = !layer.locked;
  }
}

// 图层可见性（保留旧 ref 兼容模板）
const showBiomes = ref(true);
const showBorders = ref(true);
const showLabels = ref(true);
// 城镇名/河流名（导入的 FMG 自动地名；多为英文）—— 默认关闭，避免中文地图上突然出现一串英文。
// 与 `showLabels`（用户手放的地名/标记）分开：那一层是用户自己写的，这层是底图自带的。
const showPlaceNames = ref(false);
const showBurgs = ref(true);
// A8：势力名/省名的分级标注（默认开 —— 势力名是历史剧本的主要读物）。
// 与 showLabels 分开：showLabels 管的是用户**手放**的浮动文本，两者是不同性质的东西。
const showPolityLabels = ref(true);
/** 省名单独一层（2026-10-27）：旧实现与「势力名」共用一个开关，关掉势力名会连省名一起消失 ——
 *  用户排查 A4 时就被这一点误导过。现在两个开关各管一层，默认都开。 */
const showProvinceNames = ref(true);
/** C3（2026-10-29）：「只显示已命名的省」。415 省项目里绝大多数名字是程序起的「新省份 N」，
 *  它们盖住真正起了名的几十个 —— 开关默认关（保持现有观感），打开后占位名整层不画。
 *  判据复用 `polityLabels.isPlaceholderProvinceName`（与导出链同一份，不另写正则）。 */
const showNamedProvincesOnly = ref(false);

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
// 拖拽中的临时顶点（仅做渲染预览，不写 store → undo 快照保持正确）
// `linked` = 跟随一起移动的邻省环（P1）：`[{ provId, ringIdx, points }]`，同样只做预览
const dragPreview = ref(null); // { provId, points, linked?: Array<{provId, ringIdx, points}> }

// ── P1（2026-10-13）顶点多选与共边联动 ────────────────────────────────────────
// vertexSelection：**活动环上**被框选的顶点下标（顶点编辑始终作用于"活动环"，见 ringPointsOf）
const vertexSelection = ref([]);
// vertexMarquee：框选矩形（世界坐标；Shift+空白处拖动起框）
const vertexMarquee = ref(null); // { x0, y0, x1, y1 }
let vertexMarqueeStart = null;
// 一次拖动的联动上下文（在 mousedown 时算一次，mousemove 复用 —— 每帧重算索引会拖垮帧预算）
let vertexLinkCtx = null; // { built, links, basePoints, refProvIdx, refRingIdx }


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

// 笔刷性能优化：派生节流（拖拽中每 3 帧派生一次）
// 文化/宗教选项
const availableCultures = computed(() => {
  const hm = baseMap.value?.heightmap;
  return hm?.cultures?.filter(c => c.i > 0) || [{ id: 1, name: '未分类' }];
});

const availableReligions = computed(() => {
  const hm = baseMap.value?.heightmap;
  return hm?.religions?.filter(r => r.i > 0) || [{ id: 1, name: '未分类' }];
});

const autoRivers = ref([]);          // {points,flows,order}[] 生成的河流**代表路径**（命名/分级用）
// 🔴 2026-10-14 第四修：河网的**几何本体**是"段"（每格 → 它的接收格），不是代表路径。
//    代表路径只有 12~270 个点（陆地 2506 格）→ 结构上画不出树枝状汇聚（用户实测截图）。
//    段（1717 段）逐格相连，支流才汇得进干流。两列**同时**存在：段负责观感，路径负责身份。
const autoRiverSegments = ref([]);   // {x0,y0,x1,y1,flow,endInSea}[]
const autoRiverMaxFlow = ref(0);     // 段汇流量上界 —— 线宽归一化要用它（见 flowWidthScale）
// 🔴 2026-10-17 第六修：**这份网络实际画了几段**（剪枝之后）—— 回执里要说清
//    "画的是河道，不是每格一根"。它在生成时算好（**不是**渲染时才算：回执要用当次读数）。
const autoRiverDrawn = ref(0);

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
// 这一笔是**支流**时，它长在哪条河上（母河 id；'' = 独立的一条新河）。
// 存 id 不存对象：河在 store 里每次编辑都换新对象（与 `selectedRiverId` 同一条纪律）。
const riverDraftParentId = ref('');
// 支流起点落在母河折线的哪一段（`segIndex`；-1 = 无）—— 落库时在母河上插一个拐点用，
// 使支流口与干流共享**同一个坐标**（否则放大后是"差半个像素没接上"）。
const riverDraftParentSeg = ref(-1);
// ── 剧本底图的**河流节点编辑**（2026-10-17，与行星图对齐的最后一块）─────────────
// 🔴 存 **id** 而不是那条河的对象：河在 store 里每次编辑都会换新对象
//    （`updateBaseMapRiver` 走 execute + map 替换），按住对象就会出现"改了界面不动"
//    （本项目在项目↔画布接线上踩过同一坑：按引用持有的当前节点会脱钩）。
const selectedRiverId = ref(null);
const selectedRiver = computed(() => {
  const id = selectedRiverId.value;
  if (!id) return null;
  return (baseMap.value?.rivers || []).find((r) => r && r.id === id) || null;
});

/* ── 河流多选（2026-10-17 第五轮；用户点名要过的三件之一）────────────────────
 * 为什么需要它：`selectedRiverId` 是"当前在编哪一条"（拖节点/加拐点/删节点都靠它），
 * 但**批量删河**（框选一片，一次删掉）与**批量裁海岸线**需要"一批"的概念。
 *
 * 口径：`selectedRiverId` 仍是**主选中**（单选 / Shift 多选里最后点的那条），
 *       `selectedRiverIds` 是**整批**（含主选中）。渲染高亮、批量操作都读 `riverSelIds()`。
 * ⚠️ 不用 Set 直接暴露给模板（Vue 对 Set 的响应式要 `.value` 替换才触发重渲染）；
 *    数组 + 去重足够（河流数量级几十条）。
 */
const selectedRiverIds = ref([]);
/** 当前选中的全部河流 id（主选中 + 多选，去重、只保留本底图上真实存在的） */
function riverSelIds() {
  const all = [...selectedRiverIds.value];
  if (selectedRiverId.value) all.unshift(selectedRiverId.value);
  const alive = new Set(((baseMap.value?.rivers) || []).map((r) => r && r.id).filter(Boolean));
  return [...new Set(all.filter((id) => alive.has(id)))];
}
/** 选中的河流对象（批量删除/裁剪用） */
function riverSelList() {
  const ids = new Set(riverSelIds());
  return ((baseMap.value?.rivers) || []).filter((r) => r && ids.has(r.id));
}
/** 设置选中：`ids` 为空 = 取消选中 */
function setRiverSelection(ids, primary = null) {
  const clean = [...new Set((ids || []).filter(Boolean))];
  selectedRiverIds.value = clean;
  selectedRiverId.value = primary || clean[clean.length - 1] || null;
  riverActiveNode.value = -1;
}
/** Shift+点：把一条河加进/移出选中集（与省份的 Ctrl+点多选同一套手感） */
function toggleRiverSelection(id) {
  const cur = riverSelIds();
  const has = cur.includes(id);
  const next = has ? cur.filter((x) => x !== id) : [...cur, id];
  setRiverSelection(next, has ? (next[next.length - 1] || null) : id);
  return !has;
}

/**
 * 「点选一条河」的唯一落点（2026-10-27 抽出来：mousedown 记账、mouseup 结算、click 兜底
 * 三条路都走它，避免"点了没反应/选不中"那类三套实现）。
 */
// applyRiverPick 已搬到 riverOps.js（2026-10-31）

/** 框选状态（Shift+拖动）：`{ x0, y0, x1, y1 }` 世界坐标；null = 没在框 */
const riverMarquee = ref(null);

/** 把"两个角"的框整理成 `{ minX, minY, maxX, maxY, w, h }`（顺序无关） */
function normalizeBox(b) {
  const minX = Math.min(b.x0, b.x1), maxX = Math.max(b.x0, b.x1);
  const minY = Math.min(b.y0, b.y1), maxY = Math.max(b.y0, b.y1);
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** 线段与矩形是否相交（Liang–Barsky 裁剪；端点在内也算相交） */
function segmentHitsBox(ax, ay, bx, by, box) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const tests = [
    [-dx, ax - box.minX], [dx, box.maxX - ax],
    [-dy, ay - box.minY], [dy, box.maxY - ay],
  ];
  for (const [p, q] of tests) {
    if (Math.abs(p) < 1e-12) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return t0 <= t1;
}

/**
 * 框住了哪些河。
 * 🔴 判据必须包含"**线段穿过框**"，不能只看"顶点在框内"：河的点很稀疏
 *    （一段可能跨几百世界单位），只判顶点会让"框住河身中部"完全选不中，
 *    用户会以为框选坏了（本项目已多次踩"判据与视觉效果不一致"）。
 */
// riversInBox 已搬到 misc.js（2026-10-31）

/** 正在拖的节点：{ riverId, index, oldNodes } —— `oldNodes` 是**按下那一刻**的快照（undo 档） */
const riverDrag = ref(null);
/**
 * 当前"活动的"节点（悬停到的那个；`Delete` 就删它）。
 * 为什么需要它：键盘事件（Delete）背后只有"选中的河"这个概念，没有"哪个点"——
 * 没有这枚状态就只能删整条（用户要的是"删单个节点"）。
 */
const riverActiveNode = ref(-1);
/** 河流工具下"这一笔已经处理过了"的标记：吃掉紧随其后的 click（见 finishRiverDraft） */
let suppressRiverClick = false;
/** 地形注记手绘（2026-10-27）：这一笔已由 mousedown/mouseup 收口，紧随的 click 不要再落到别的工具 */
let suppressTerrainPickClick = false;
/** 这一笔是否已经顶到 `RIVER_MAX_DRAFT_POINTS`（顶到只说一次，不要每帧刷屏） */
let riverDraftCapped = false;
/**
 * 「选择」工具下**这次按下已被河流命中消费掉**的标记（2026-10-17 第八修·三修）。
 * 为什么需要：那条分支会 `return`（不进平移），但紧随其后的 `click` 仍会派发到
 * `onCanvasClick` —— 那里会再跑一遍"选省"逻辑，把刚选中的河**当场取消**。
 * 所以按下时置位、click 时消费并复位。
 */
let riverPressHandled = false;
/** 河流节点/河身的命中容差（屏幕像素；换算世界单位要除以相机缩放） */
const RIVER_HIT_PX = 12;
/**
 * 「选择」工具里点河的命中半径（屏幕像素）。
 * 比河流工具的 `RIVER_HIT_PX` 更大：河流是一条细线（屏幕上常只有 1.8~2.5px），
 * 用 12px 意味着"必须点在线上"，用户会觉得"点不中"（实测原话）。
 * 24px ≈ 一根手指/一枚光标的宽容度 —— 而这个工具下**没有别的争抢对象**（河优先于省）。
 */
const RIVER_SELECT_HIT_PX = 24;
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
/**
 * 🔴 **河流来源**（2026-10-16 第五修，用户第四条「依旧和底图自带河流各画各的」）。
 *
 * 实测（`scripts/tests/tools/_probe_river_align.mjs`，真实 desite 底图）：
 *   · 自动河网段到自带河的最近距离 **中位 18.78 世界单位**（≈1.3 格），只有 **10%** 在 3 单位内；
 *   · 反过来，自带河的顶点只有 **40%** 附近有自动河（≤3 单位）。
 * → **两套河真的是两套水系**，不是"同一条河画了两次"（那点差别一条隐藏就能解决）。
 *
 * ⚠️ 所以**不能悄悄隐藏自带河** —— 会丢掉用户原来那 160 条河覆盖的真实地理。
 *   两套并存又是用户抱怨的"各画各的"→ 唯一的正确答案是**把选择权交出去**：
 *   `both`（默认，零行为变更）/ `base`（只看底图自带）/ `auto`（只看自动生成）。
 *   用户在「自动河流」面板里点一下就能只留一套 —— 那才是他要的"一套河"。
 *
 * ⚠️ 我**没有**把默认值改成 `auto`：那会让「自动河流」按钮一点就把他原来的河藏起来，
 *   属于改变既有语义的破坏性默认（本项目在「隐式载入覆盖项目数据」上吃过这种亏）。
 */
const riverSource = ref('both');           // 'both' | 'base' | 'auto'
const showRiverBase = computed(() => showRivers.value && riverSource.value !== 'auto');
const showRiverAuto = computed(() => showRivers.value && riverSource.value !== 'base');
const showRoutes = ref(false);
const colorMode = ref('default');    // default | culture | religion

// 顶点切线手柄当前选中顶点（P0-T1）；-1 = 未选中
const activeVertexIdx = ref(-1);
// Alt 临时直线（P0-T1）；不参与响应式，只在绘制时读取
let altStraight = false;

// 自由绘制（B）：**2026-10-09 起不再是默认工具**（默认翻成「选择」= 拖拽平移，
// 见上方 `const tool` 处的说明）。它仍是「建省」的唯一入口：空底图上打开就能画（不必先「新建省份」）。
// 精确定点（描点）是同一个工具里的第二条路径（单击落顶点），选择/移动另在工具栏。

// P1：新建省份的色板轮转（确定性 —— 颜色不随机，测试可断言、用户可预期）
// 定义已移到 `utils/scenarioPalette.js`（画布 / SVG 导出 / 省界网格三处共用一份）。

// P4：海域（kind='sea'）有自己的视觉 —— 淡色水面 + **淡虚线海界**（虚线是「这是水域」的约定），
// 且**不参与势力归属着色**（海不是谁的领土）。着色常量同样在 `utils/scenarioPalette.js`。

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

/**
 * 右键菜单指向的省份（按 id 反查活对象）与它在**时间轴当前日期**的归属势力。
 *
 * 为什么按 id 反查而不是存对象：`terrain[]` 在编辑后可能换新数组（撤销/导入/合并），
 * 存对象会让菜单指向一个"已经不在列表里"的副本 —— 与 `selectedRiverId` 同一条纪律。
 * 归属查询走 `ownerPolityForProvince`（与地图着色/势力标注同一口径），
 * 所以「看到的颜色」和「菜单里写的名字」不可能不一致。
 */
const contextMenuProvince = computed(() => {
  const id = contextMenu.value.provId;
  if (!id) return null;
  return (baseMap.value?.terrain || []).find((p) => p && p.id === id) || null;
});
const contextMenuOwner = computed(() => (contextMenu.value.show
  ? ownerPolityForProvince(contextMenu.value.provId)
  : null));

// ── 省份多选（2026-10-02）────────────────────────────────────────────────────
// 用途：一次把多个省指派给同一个势力（`store.batchSetOwnership` —— 此前是零调用的死入口）。
// 交互刻意只绑「选择」工具 + Ctrl/⌘ 点击：Ctrl/⌘ 在组件内原本完全空闲（全局只被 App.vue 的
// 撤销占用），而 Shift 在这个组件里已被三处语义占满（禁吸附 / 决定拆分哪半 / 滚轮第二轴）。
// 多选**不进导出**（与选中描边同一策略：那是编辑期的辅助，不是图面内容）。
const selectedProvinceIds = ref([]);
const multiSelectSet = computed(() => new Set(selectedProvinceIds.value));
/** 批量条是否显示（有选中就显示；指派按钮另看有没有选势力） */
const hasMultiSelection = computed(() => selectedProvinceIds.value.length > 0);
const selectedLandProvinces = computed(() => (baseMap.value?.terrain || [])
  .filter(p => p && p.kind !== 'sea').map(p => p.id));

function toggleProvinceSelection(id) {
  const list = selectedProvinceIds.value;
  selectedProvinceIds.value = list.includes(id) ? list.filter(x => x !== id) : [...list, id];
}
function clearProvinceSelection() {
  if (selectedProvinceIds.value.length) selectedProvinceIds.value = [];
}
/** 底图/省份表变了就剔除已经不存在的 id（否则批量条会拿幽灵 id 去写归属） */
function pruneProvinceSelection() {
  if (!selectedProvinceIds.value.length) return;
  const alive = new Set((baseMap.value?.terrain || []).map(p => p.id));
  const next = selectedProvinceIds.value.filter(id => alive.has(id));
  if (next.length !== selectedProvinceIds.value.length) selectedProvinceIds.value = next;
}

// 生物群系颜色
const BIOME_COLORS = {
  ocean: '#2E86AB',
  hot_desert: '#E9C46A',
  cold_desert: '#B5B887',
  savanna: '#D2D082',
  grassland: '#C8D68F',
  tropical_seasonal: '#B6D95D',
  // 🔴 `temperate` 是司天自己的**默认群系**（`scenarioEditing.js` 里 `biome || 'temperate'`），
  //    但本表原先没有它 → 查不到色 → 省份落兜底色（2026-10-09 实测：暮雨导入的底图
  //    整块大陆都显示成兜底色，看着像"没上色"）。表必须覆盖所有会被写进去的群系名。
  temperate: '#5FA85C',
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
  group: DEFAULT_SCENARIO_GROUP,
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

// ── 剧本集（2026-10-25）────────────────────────────────────────────────────
// 一组 = 一条独立时间线（通常一张底图 + 一段连续年代）。
// 左栏 / 时间轴 / 播放 / 切片导出的「全部剧本」都只取**当前组**；
// 组表在 project 文件里（`scenarios.groups`），默认组是虚拟的（旧项目零迁移）。
const activeGroupId = ref(DEFAULT_SCENARIO_GROUP);
const groupOptions = computed(() => scenarioGroupOptions(store.scenarioGroups || []));
const groupNameNow = computed(() => scenarioGroupNameOf(store.scenarioGroups || [], activeGroupId.value));
const groupCounts = computed(() => scenarioGroupCounts(scenarios.value));
function groupCount(id) { return groupCounts.value.get(String(id || DEFAULT_SCENARIO_GROUP)) || 0; }
function groupNameOf(id) { return scenarioGroupNameOf(store.scenarioGroups || [], id); }

/** 当前底图的全部剧本（跨所有剧本集），按 order 排；仅管理对话框 / 初始组判定用 */
const allSortedScenarios = computed(() => {
  return [...scenarios.value].sort((a, b) => (a.order || 0) - (b.order || 0));
});

/** 当前剧本集里的剧本 —— 时间轴 / 左栏 / 播放 / 切片导出的唯一取数口 */
const sortedScenarios = computed(() => {
  return allSortedScenarios.value.filter((s) => scenarioGroupIdOf(s) === activeGroupId.value);
});

/**
 * 切剧本集：选择第一段并同步游标；空组则清空选中（时间轴无帧）。
 * 不走 `selectScenarioAt` 的「找不到就 return」—— 空组是合法状态。
 */
// switchGroup 已搬到 misc.js（2026-10-31）


/**
 * 换底图 / 首次装载 → 落到**第一条剧本所在的组**（而不是永远默认组）。
 * 只在底图切换时调用；用户手动切到空组不在这里被弹回去。
 */
function resetGroupForBaseMap() {
  const list = allSortedScenarios.value;
  if (!list.length) { activeGroupId.value = DEFAULT_SCENARIO_GROUP; return; }
  activeGroupId.value = firstNonEmptyGroupId(list);
}

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

// setTool 已搬到 province.js（2026-10-31）


// updateCursor 已搬到 riverOps.js（2026-10-31）


function onModeChange() {
  if (viewMode.value === 'scenario') {
    if (sortedScenarios.value.length > 0 && !selectedScenario.value) {
      selectScenario(sortedScenarios.value[0]);
    }
  }
  // 🔴 切模式后必须重绘（2026-10-09 修）：旧实现只在「首次进入剧本模式（selectedScenario 为空）」
  //    时经 selectScenario 顺带 render 一次 —— 第二次切回来 `selectedScenario` 已有值，
  //    一个 render 都不会走，画面停留在上一次的底图态。
  //    用户观感：「切了模式没反应，得用鼠标在画布上点一下才更新」（暮雨实测）。
  //    render() 幂等：上面若已 selectScenario，这里重复一次无害。
  render();
}

function selectScenario(s) {
  selectedScenario.value = s;
  render();
}

function selectPolity(p) {
  selectedPolity.value = p || null;
  if (p) clearOwnerMode.value = false;
}

/** 色板 ✕：进入「清除归属」模式（把涂到的省改成无主，而不是涂错颜色） */
function selectClearOwnership() {
  selectedPolity.value = null;
  clearOwnerMode.value = true;
}

// ══════════════════════════════════════════════════════════════════════════
// 涂归属（2026-10-20 重做）—— **只改势力归属，不动省界几何**
//
// 为什么重做：此前叫「涂归属」的按钮实际是**几何笔刷**（把笔迹并进所选省份，
// 相交的邻省被挖掉）→ 用户实测「我不知道涂归属到底在干嘛，好像在生造省份」。
// 而真正做对事的是「势力」油漆桶（点一次改一个省），但一次只能一个省，慢。
//
// 现在的语义：选一个势力 → 按住涂 → 笔刷**碰到哪些省**就把哪些省的归属改成它，
// 抬手一次性落库（`batchSetOwnership` = 一条 undo）。不碰任何多边形：
//   · 省界一个点都不变（用例判据：涂完 points 逐字节相同）；
//   · 不触发多边形布尔（旧路径「松开卡几秒」的根因），也不重建省界缓存。
//
// 采样：每 `OWNER_BRUSH_SAMPLE_PX` 屏幕像素取一个点，每个采样点测
// 圆心 + 上下左右 4 个偏移（≈ 半径 0.65）。拖动期只做**只读**命中，
// 不写 store、不碰多边形 —— 抬手才一次性落库。
// ══════════════════════════════════════════════════════════════════════════
const OWNER_BRUSH_SAMPLE_PX = 3;
let ownerStrokeActive = false;
let ownerStrokeIds = new Set();
let ownerLastSample = null;
// 这一笔的账本身份（groupId）：按下时生成，抬手落库时带给 store → 一笔一组（第 4 件接线点）
let ownerStrokeId = '';
function nextOwnerStrokeId() {
  ownerStrokeId = `own-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
  return ownerStrokeId;
}

/** 笔刷半径（世界单位）—— 与几何笔刷同一口径：屏幕像素 / 缩放 */
function ownerBrushWorldRadius() {
  return provBrushRadius.value / Math.max(1e-6, cameraScale.value || 1);
}

/** 世界点 → 命中的陆地省 id 列表（海域不算：海不参与势力归属） */
function ownerHitProvinceIds(wx, wy) {
  const r = ownerBrushWorldRadius();
  const offsets = [[0, 0], [0.65, 0], [-0.65, 0], [0, 0.65], [0, -0.65]];
  const out = [];
  const seen = new Set();
  for (const [dx, dy] of offsets) {
    const p = findProvinceAt(wx + dx * r, wy + dy * r);
    if (!p || p.kind === 'sea') continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p.id);
  }
  return out;
}

/** 一次采样：把这笔新碰到的省并进 `ownerStrokeIds`（返回新增个数） */
function ownerStrokeSample(wx, wy) {
  let added = 0;
  for (const id of ownerHitProvinceIds(wx, wy)) {
    if (ownerStrokeIds.has(id)) continue;
    ownerStrokeIds.add(id);
    added++;
  }
  return added;
}

/**
 * 吸管：取该省当前的势力并选中它（Alt+点击）。
 * 找不到时返回 null —— 调用方负责说清「这个省本来没有归属」。
 */
function pickPolityAt(wx, wy) {
  const prov = findProvinceAt(wx, wy);
  if (!prov) return { prov: null, polity: null };
  const owner = selectedScenario.value?.ownership?.[prov.id];
  const polity = owner
    ? (selectedScenario.value?.polities || []).find((p) => p.id === owner) || null
    : null;
  return { prov, polity };
}

/** 抬手：整笔一次落库（一条 undo）+ 一句点名回执 */
// commitOwnerStroke 已搬到 actions.js（2026-10-31）


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

/**
 * 新建势力（2026-10-01）：补上「势力只能靠 .map 导入带进来」这个缺口 ——
 * 自建底图 + 自建剧本时 polities 为空，色板空空、油漆桶点了静默无反应。
 * 名称用 prompt（与 label/marker 的录入方式一致，不新造一套内联编辑）。
 */
async function onAddPolity() {
  const sc = selectedScenario.value;
  if (!sc) { statusMsg('先选一个剧本，再新建势力'); return; }
  if (store.isReadOnly) { statusMsg(`新建势力已停用：${store.readOnlyReason || '只读'}`); return; }
  const name = await askText({ title: '新势力名称', defaultValue: `势力 ${(sc.polities || []).length + 1}` });
  if (name === null) return;                     // 取消
  if (!String(name).trim()) { statusMsg('势力名不能为空'); return; }
  const r = store.addPolity(sc.id, { name });
  if (!r || !r.success) { statusMsg('新建势力失败'); return; }
  // 选中新势力：接着就能直接油漆桶上色（不是"建完了还得自己找"）
  const created = (store.scenarios?.[sc.id]?.polities || []).find(p => p.id === r.id) || null;
  selectedPolity.value = created;
  statusMsg(`已新建势力：${r.name}（选中它，用油漆桶 P 点省份即可指派）`);
  render();
}

function onPolityColorChange(e) {
  const v = String(e.target.value || '').trim();
  if (!v) return;
  updateSelectedPolity({ color: v }, `势力配色已改为 ${v}`);
}

// onDeletePolity 已搬到 misc.js（2026-10-31）


function onPolityAbbrChange(e) {
  const v = String(e.target.value || '').trim();
  updateSelectedPolity({ abbr: v || null }, v ? `势力简称：${v}` : '已清除简称（缩小档回落全名）');
}

const showLineagePanel = ref(false);

// ═══════════════════════════════════════════
// 时间轴（P1）：月日精度游标 + EU4 斜线占领
// ═══════════════════════════════════════════
// 🔴 游标真源是 **tlDate**（`{y,m,d}`，月日可缺省 = 该年 1 月 1 日），不是 tlYear。
//    为什么不用「浮点年份 + 月日另存」：两处状态 = 迟早不一致（滑动改一个、日期录入改另一个）。
//    `tlYear` 只作为**只读派生**给轨道/播放用（`dateToYearValue` 供年内插值）。
//    年 = 剧本边界的唯一判据（边界仍是年精度，见《月日精度与切片书签》执行单 §0.4），
//    月日只进易主事件与切片点。
const tlEra = ref(0);
const tlDate = ref({ y: 0, m: null, d: null });
/** 播放时的**年内进度**（0..1）。只服务 rAF 插值，不参与任何判定 —— 不落进 tlDate 就不会有第二个真源。 */
let tlPlayT = 0;
const tlAxisMode = ref('year');   // year | equal
const tlDiffMode = ref('eu4');    // eu4 | outline | off
const tlPlaying = ref(false);

/** 游标年份（只读派生）—— 轨道位置 / 播放 / 旧调用点用 */
const tlYear = computed(() => dateToYearValue(tlDate.value));
/** 游标年份（整数）—— 状态栏显示与「上色即易主」的显式日期用 */
/** 状态栏日期文本（只到年时只显示年，不谎报 1 月 1 日） */
const tlDateText = computed(() => formatDate(tlDate.value));

/** 时间轴模型（谱系匹配 + 逐省变化日期 + 年代区间/断层）——纯函数，见 utils/scenarioTimeline.js */
const timeline = computed(() => buildTimeline(sortedScenarios.value || []));

const tlSettled = computed(() => settledCount(timeline.value, tlEra.value, tlDate.value));
const tlInGap = computed(() => (tlAxisMode.value === 'year'
  ? !!findGap(timeline.value, tlDate.value.y) : false));

/** 切片点书签（项目级，store 持有）：给时间轴画标记 + 给切片对话框当帧来源 */
const slicePoints = computed(() => store.slicePoints || []);

/** 省 id → 名称（P2 面板与导出用） */
const provinceNameMap = computed(() => {
  const m = {};
  for (const p of (baseMap.value?.terrain || [])) {
    if (p?.id) m[p.id] = p.name || p.id;
  }
  return m;
});

// Electron 渲染进程不支持 window.prompt（"prompt() is and will not be supported"）。
// 所有文本录入统一走 App 根部的 PromptDialog（单例状态 + Promise）。
const { askText } = usePromptDialog();
const scenarioExport = useScenarioExport({  store,
  baseMap,
  timeline,
  currentEra: tlEra,
  currentYear: tlYear,
  diffMode: tlDiffMode,
  provinceNames: provinceNameMap,
  // `terrainNames`：地形注记（山系/海域/平原）跟着画布的那个开关走 —— 导出与画布一致
  // `terrainBg`：地形/专题底图档（height/temp/prec）时导出**带上地形底图**（与画布一致：
  //   省份只描边不填色）。见 `exportTerrainSnapshot`。
  layerFlags: () => ({
    labels: showLabels.value, borders: showBorders.value,
    placeNames: showPlaceNames.value, terrainNames: showTerrainNames.value,
    terrainBg: rasterLayer.value === 'height' || rasterLayer.value === 'temp' || rasterLayer.value === 'prec',
  }),
  exportTerrain: exportTerrainSnapshot,
  // 政治模式导出也要浅滩带（§3.1 欠账）：只给海岸线几何，**不生成栅格**
  exportSea: exportSeaSnapshot,
});
const {
  exportStatus, exportScenarioPNG, exportScenarioSVG, exportScenariosJson, pickScenariosJson,
  exportSliceFrames,
} = scenarioExport;

// ——— 逐年切片导出（EU4 式帧序列）———
const showSliceExport = ref(false);
// 019：重导对话框（预览统计 + 冲突；真正写盘在 applyReimportDialog）
const reimportDialog = ref(null);
let pendingReimportBundle = null;
const sliceExportBusy = ref(false);
async function onRunSliceExport({ png = false, scale = 2, era = null } = {}) {
  if (sliceExportBusy.value) return;
  sliceExportBusy.value = true;
  try {
    // `era` = 对话框选的范围（本剧本 / 本剧本集全部）；过滤在 utils/scenarioSlices 的唯一实现里
    const r = await exportSliceFrames({ png, scale, era, slicePoints: slicePoints.value, groupName: groupNameNow.value });
    // 失败/取消的回音由 exportStatus 承担（对话框里也显示同一份），这里只补一条可点名的结论
    if (r && r.success === false && !r.canceled) statusMsg(`切片导出失败：${r.error || '未知错误'}`);
    else if (r && r.canceled) statusMsg('已取消切片导出');
  } finally {
    sliceExportBusy.value = false;
  }
}

function importScenariosJson(mode) {
  return pickScenariosJson({ mode });
}

function onSetPolityLineage({ scenarioId, polityId, successorOf }) {
  store.setPolityLineage(scenarioId, polityId, { successorOf });
  render();
}

/** 面板里的输入被拒（越界年份等）：拒绝必须有回音 —— 静默吞掉等于用户以为改成功了 */
function onPanelReject({ what = '输入', reason = '' } = {}) {
  statusMsg(`${what}未写入：${reason || '不合法'}`);
}

// ── 省份多选 → 批量归属（2026-10-02 接活 batchSetOwnership）─────────────────
// 回执必须点名「改了几省 / 跳过了什么」：批量操作最怕"点了没反应"或"悄悄漏掉几个"。
function batchEcho(r, verb) {
  if (!r || r.success === false) { statusMsg(`${verb}失败：${r?.reason || '未知原因'}`); return; }
  if (r.noop) { statusMsg(`${verb}：没有需要改动的省份${r.skippedSea ? `（跳过 ${r.skippedSea} 个海域省）` : ''}`); return; }
  const parts = [`${verb}：${r.changed || r.cleared} 省`];
  if (r.skippedSea) parts.push(`跳过 ${r.skippedSea} 个海域省`);
  if (r.skippedMissing) parts.push(`跳过 ${r.skippedMissing} 个不存在的省`);
  parts.push('可 Ctrl+Z 撤回');
  statusMsg(parts.join(' · '));
}

function onBatchAssign() {
  if (store.isReadOnly) { statusMsg(`批量指派已停用：${store.readOnlyReason || '只读：未打开项目'}`); return; }
  if (!selectedPolity.value) { statusMsg('批量指派：先在上面的色板里选一个势力'); return; }
  if (!selectedScenario.value) { statusMsg('批量指派：先在时间轴上选一个剧本'); return; }
  const r = store.batchSetOwnership(
    selectedScenario.value.id,
    selectedProvinceIds.value.slice(),
    selectedPolity.value.id,
    tlDate.value,
  );
  batchEcho(r, `已指派给「${selectedPolity.value.name}」`);
  render();
}

function onBatchClear() {
  if (store.isReadOnly) { statusMsg(`批量清除归属已停用：${store.readOnlyReason || '只读：未打开项目'}`); return; }
  if (!selectedScenario.value) { statusMsg('批量清除归属：先在时间轴上选一个剧本'); return; }
  const r = store.batchSetOwnership(
    selectedScenario.value.id, selectedProvinceIds.value.slice(), null,
  );
  batchEcho(r, '已清除归属');
  render();
}

function onSelectAllLand() {
  selectedProvinceIds.value = selectedLandProvinces.value.slice();
  statusMsg(`已选中当前底图的 ${selectedProvinceIds.value.length} 个陆地省（海域不参与归属，未入选）`);
  render();
}

/**
 * 单省易主日期（面板的「年-月-日」三格或「自动」按钮）—— 月日精度后是**整列表替换**。
 * `date = null` → 清除该省全部显式日期（回到自动推算）。
 * @param {{scenarioId:string, provinceId:string, date:object|null, done?:Function}} p
 *   `done` 由面板传入：无论成败都回调，让面板把输入框草稿清掉（成败都要显示库里真值）。
 */
// onSetChangeDate 已搬到 actions.js（2026-10-31）


/**
 * 批量设置易主日期（面板的「统一设为该日 / 固化推算值 / 全部清空」）—— 一条 undo。
 * 回执必须点名改了几省、清了几省（否则用户不知道这次批量到底动了什么）。
 */
// onSetChangeDatesBulk 已搬到 riverOps.js（2026-10-31）


/** 把当前游标存为切片点（带默认名 = 日期文本），走 store 的一条 undo */
async function onSaveSlicePoint() {
  if (store.isReadOnly) {
    statusMsg(`只读：${store.readOnlyReason || '未打开项目'} —— 切片点未保存`);
    return;
  }
  if (!timeline.value.years.length) { statusMsg('还没有剧本，无法存切片点'); return; }
  const d = tlDate.value;
  const label = await askText({ title: '切片点名称（留空则显示日期）', defaultValue: formatDate(d) });
  if (label === null) return;                       // 取消
  const r = store.addSlicePoint({ y: d.y, m: d.m, d: d.d }, label || '');
  if (!r || r.success === false) { statusMsg(`切片点未保存：${r?.reason || '未知原因'}`); return; }
  statusMsg(`已存切片点「${label || formatDate(d)}」（${formatDate(d)}）—— 切片导出会默认带上它（可 Ctrl+Z 撤回）`);
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

/**
 * 剧本列表条目的一句话摘要（EU4 那张「选择历史时期」列表里的第二行）。
 * 势力数 = 本剧本定义的势力数；省数 = 本剧本 ownership 里**真有归属**的省份数
 * （值为空/缺失 = 无主，不计入 —— 地图上显示灰，不该被算成"这个势力的地盘"）。
 */
function scenarioMeta(s) {
  const polities = (s?.polities || []).length;
  const own = s?.ownership || {};
  const owned = Object.keys(own).filter((pid) => own[pid]).length;
  return `${polities} 势力 · ${owned} 省`;
}

/**
 * 「选择历史时期」：点列表一条 = **切剧本 + 地图跳到该时期起始年 + 时间轴游标同步**。
 *
 * 🔴 为什么必须三件事一起做（而不是只改 selectedScenario）：
 *    ① 只改 selectedScenario → 地图着色不动（游标还在旧年份）→ 看着像"设置项"不是"时期选择器"；
 *    ② 只改游标 → 编辑目标（势力色板 / 归属写入落到哪个剧本）还停在旧剧本 → **写错地方**。
 *    三件一起才是 EU4 里「点一条，地图变成那一年的世界」这个动作的完整语义。
 * 年份取 `timeline.years[idx].start`（而非 `s.era.startYear`）：与轨道、播放同一口径，
 * 避免"列表说 2044、游标落到 2043"这种只有对齐时才发现的不一致。
 */
function selectScenarioAt(s) {
  const idx = sortedScenarios.value.findIndex((x) => x && s && x.id === s.id);
  if (idx < 0) return false;
  tlPlaying.value = false;
  tlEra.value = idx;
  const start = timeline.value?.years?.[idx]?.start;
  if (Number.isFinite(start)) tlDate.value = { y: start, m: null, d: null };
  if (selectedScenario.value?.id !== s.id) {
    selectedScenario.value = s;
    selectedPolity.value = null;
  }
  // 从底图编辑里点列表 = 想去看/改政治版图 → 顺带切到剧本模式（否则改了看不见）
  if (viewMode.value !== 'scenario') viewMode.value = 'scenario';
  render();
  return true;
}

/**
 * 轨道拖拽/点击/键盘给了「年」→ 写回 tlDate。
 * 🔴 月日**归 null**（= 该年 1 月 1 日）而不是保留旧月日：轨道表达的是「到某一年」，
 *    保留 6 月 1 日会让「拖到 1045 年」实际停在 1045-06-01 —— 用户看不见、却影响归属判定。
 *    要精确到日请走「存为切片点」或谱系面板的日期录入。
 */
function onTimelineSetYear(y) {
  const n = Number(y);
  if (!Number.isFinite(n)) return;
  const yy = Math.round(n);
  if (tlDate.value.y === yy && tlDate.value.m === null && tlDate.value.d === null) return;
  tlDate.value = { y: yy, m: null, d: null };
  render();
}

// ——— 播放：一帧一剧本，剧本内年份线性扫过，跨剧本自动跳过年份断层 ———
const TL_ERA_MS = 1300;
let tlRafId = null;
let tlLastT = 0;

/** 该年在该月的天数（播放插值用；与 scenarioDates 同口径，闰年照算） */
function daysInMonthOf(y, m) {
  const v = Math.abs(y);
  const feb = (v % 4 === 0 && v % 100 !== 0) || v % 400 === 0 ? 29 : 28;
  return [31, feb, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

// ⚠️ `tlPlayT` 在模块顶部声明（时间轴区域）—— 播放环与 watch 都要用，别在这里再 let 一次（重复声明会静默遮蔽）
// tlFrame 已搬到 actions.js（2026-10-31）


watch(tlPlaying, (v) => {
  if (!v) return;
  const n = timeline.value.years.length;
  if (!n) { tlPlaying.value = false; return; }
  const cur = tlDate.value.y;
  const last = timeline.value.years[n - 1];
  // 已播到末尾则从头开始
  if (tlEra.value >= n - 1 && cur >= last.end) {
    tlEra.value = 0;
    tlDate.value = { y: timeline.value.years[0].start, m: null, d: null };
  } else {
    // 从「当前剧本起点 + 年内进度」续播；月日归零，避免播放中途从 6 月 1 日开始插值
    const y = timeline.value.years[tlEra.value];
    tlPlayT = Math.max(0, Math.min(1,
      (tlDate.value.y - y.start) / Math.max(1, y.end - y.start)));
    tlDate.value = { y: y.start, m: null, d: null };
  }
  tlLastT = performance.now();
  if (tlRafId == null) tlRafId = requestAnimationFrame(tlFrame);
});

// 时间轴的**唯一真源是 tlDate**：era 必须由它的**年**派生。
// 否则拖动游标后 era 不跟着变 → 地图仍按旧剧本的归属渲染、HUD 的「已易主」也是错的。
// 🔴 注册点必须在 **onMounted 里**（见 onMounted 末尾）：在 setup 期直接
//    `watch(() => tlDate.value.y, …)` 会在组件挂载前**触发一次 render()** —— 那一帧用的是
//    还没适屏的相机 (0,0,1)，于是「首帧 = 空画布」（test_61 实测帧序：
//    t=1059 空帧 → t=1067 才适屏）。与本文件 `watch(sortedScenarios…)` 同一条纪律。

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
    const cur = tlDate.value;
    if (!tl.years.length || cur.y < tl.minYear || cur.y > tl.maxYear) {
      tlDate.value = { y: tl.minYear, m: null, d: null };
    }
    render();
  }, { deep: false });

  // 首帧把游标落到第一个剧本
  resetTimelineToStart();
});

/** 初始化/切换底图后把游标落到第一个剧本 */
function resetTimelineToStart() {
  const tl = timeline.value;
  if (!tl.years.length) { tlEra.value = 0; tlDate.value = { y: 0, m: null, d: null }; return; }
  tlEra.value = 0;
  tlDate.value = { y: tl.years[0].start, m: null, d: null };
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
 * 环的渲染顶点 —— 实现已移到 `utils/provinceShape.js#ringPointsForRender`
 * （2026-10-01：SVG 导出必须与画布用**同一条**平滑规则，否则涂抹改过的省在导出图里
 *  台阶感更重、与画布不一致；两份实现就是"改一处另一处不变"的经典双源）。
 */

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

/**
 * **省份 Path2D 缓存**（2026-10-21，编辑卡顿的第一刀）。
 *
 * 为什么：`drawProvinces` 每帧对 415 个省逐环 `beginPath/moveTo/lineTo/closePath` 再 fill，
 * 顶点编辑/拖拽/笔刷的每一帧都要重付一次（415 省 ≈ 2.4 万顶点）。而**几何只在改省界时变**，
 * 颜色/归属/日期只改 fillStyle —— 路径本身可以复用。
 *
 * 口径：
 *   · 以 `prov` 对象为键（WeakMap），签名 = 每个环的 `points` 引用 + `fromGrid`；
 *     顶点编辑换新数组 → 只让**那一个省**的缓存失效；
 *   · `altStraight`（Alt 临时直线）单独一槽，不污染曲线槽；
 *   · 路径用**世界坐标**（画布已 scale/translate）—— 缓存与相机无关；
 *   · 平滑/贝塞尔的画法与 `traceShapePath` 逐字一致（否则省界会在有无缓存时长得不一样）。
 */
const provincePathCache = new WeakMap();
// buildProvincePath 已搬到 provinceOps.js（2026-10-31）

function provincePathFor(prov, straight = false) {
  const slot = straight ? 'straight' : 'curve';
  let entry = provincePathCache.get(prov);
  if (!entry) { entry = {}; provincePathCache.set(prov, entry); }
  const hit = entry[slot];
  // 快路径：只比**数据引用**（points / extraRings / rings），不再每帧跑 provinceRings + 建签名数组
  // —— 415 省 × 每帧会白造 400+ 个数组，CPU 采样里 GC 占 72ms/20 帧。
  if (hit && hit.pts === prov.points && hit.extra === prov.extraRings && hit.rings === prov.rings) {
    return hit.path;
  }
  const path = buildProvincePath(prov, straight);
  entry[slot] = { pts: prov.points, extra: prov.extraRings, rings: prov.rings, path };
  return path;
}

/** 活动环的顶点（顶点编辑作用于「活动环」；多环省份可在属性面板切换环） */
const activeRingIdx = ref(0);
function ringPointsOf(prov, idx = activeRingIdx.value) {
  const rings = provinceRings(prov);
  const r = rings[idx] || rings[0];
  return r ? r.points : null;
}

/**
 * 把**多个环**的新顶点一次性写回省份（P1：顶点拖动可能同时牵涉一个省的另一个环 ——
 * 例如洞环与外环共用一个顶点）。
 * @param {Map<number, Array>} ringChanges ringIdx → 新顶点数组
 */
function writeRingsPatch(prov, ringChanges) {
  const rings = provinceRings(prov).map((r) => ({ points: r.points, kind: r.kind, fromGrid: r.fromGrid }));
  if (!rings.length) return null;
  for (const [idx, points] of ringChanges) {
    // 与 ringPointsOf 同口径：越界一律落到主环（否则手柄画在环 0、写回却被丢弃 = 静默 no-op）
    const i = idx >= 0 && idx < rings.length ? idx : 0;
    rings[i] = { ...rings[i], points };   // 形状被手工改过 → 不再是网格派生的，去掉 fromGrid
  }
  const patch = shapePatch(rings);
  // fromGrid 显式给出：手工改过的环不再算「网格派生」→ 渲染端不再对它做平滑
  return { kind: patch.kind || 'land', points: patch.points, extraRings: patch.extraRings, fromGrid: !!patch.fromGrid };
}

/** 把「活动环」的新顶点写回省份（主环 → points；额外环 → extraRings[i-1]），返回可 merge 的补丁 */
function writeRingPoints(prov, idx, points) {
  return writeRingsPatch(prov, new Map([[idx, points]]));
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

/**
 * 世界坐标 → **画布内**屏幕坐标（`screenToWorld` 的逆）。
 *
 * 🔴 为什么要有这个函数（2026-10-17，我自己踩的坑）：真机探针里我手写
 *    `sc.cameraX + wx * sc.cameraScale` 来算点击位置 —— 而 `sc` 是组件实例代理，
 *    **ref 不会在那里解包**，于是 `sc.cameraX` 拿到的是 ref 对象，
 *    整个表达式变成 `[object] + wx * [object]` → 点在了别处，
 *    我还以为"节点拖不动"。有了这枚函数，探针与产品走**同一个换算**，
 *    这类"测试自己算错"就不会再伪装成产品缺陷。
 */
function worldToScreen(wx, wy) {
  return {
    x: cameraX.value + wx * cameraScale.value,
    y: cameraY.value + wy * cameraScale.value,
  };
}

// ═══════════════════════════════════════════
// Pan & Zoom
// ═══════════════════════════════════════════
let isPanning = false;
/**
 * 「按下时命中了河、但还没决定要选中」—— 2026-10-27 用户实测「随便一拖就选中河流」。
 * 旧实现 mousedown 命中就立刻选中并吃掉按下，于是想拖地图查看时只要起点靠近河（10px）就变成选河。
 * 现在：按下只记候选，**照常进平移**；松手时位移 ≤4px 才算"点选"。
 */
let pendingRiverPick = null;
// 相机移动期（平移 / 滚轮缩放）：标签、聚落、浮雕、小地图这些"读完就够"的层先跳过，
// 停稳 140ms 再补一帧全量。415 省实测：带这些层的帧 ~23ms，去掉后接近静止帧（5~9ms）。
let cameraMotion = false;
let cameraSettleTimer = null;
function markCameraMotion() {
  cameraMotion = true;
  if (cameraSettleTimer) clearTimeout(cameraSettleTimer);
  cameraSettleTimer = setTimeout(() => {
    cameraSettleTimer = null;
    cameraMotion = false;
    render();
  }, 140);
}
let panStart = { x: 0, y: 0 };

// ═══════════════════════════════════════════
// Phase 3：省份「归属标签网格」（笔刷 / 套索 / 自动省界）
//   数据 = store.provinceEditing（按 baseMaps[key] 走 undo）；本处只做交互与渲染。
// ═══════════════════════════════════════════
const provinceTargets = computed(() => baseMap.value?.terrain || []);
// D11：被挖空的省标 `empty:true` 后仍留在数组里（保持 id/索引稳定），但**不能**作为划归目标；
// 选项带原始 1-based 下标，避免过滤后 targetIdx 与 terrain 下标错位。
const provinceTargetOptions = computed(() => provinceTargets.value
  .map((p, i) => ({ p, idx: i + 1 }))
  .filter((o) => !o.p.empty));

// 🔴 P2（2026-10-09）：原先这一整段「省份网格即时反馈」已删除 ——
//    `provinceMeshColorOf` / `scheduleProvinceGrid` / `provinceMeshOn` / `drawProvinceMesh`
//    全部服务于「把归属格画到画布上」。而格点正是 10525 点海岸线退化成 ~22 点的根源
//    （见 provinceEditing.js 文件头 / docs/SCENARIO_PROVINCE_FIX_PLAN.md）。
//    现在：涂抹期间画布只画笔迹预览（`drawProvinceBrushOverlay`），抬手时多边形被精确布尔替换。

// H2：笔刷半径按**屏幕像素**存，换算成世界单位再交给几何（缩放时手感一致）
const provBrushWorldRadius = computed(() => provBrushRadius.value / Math.max(1e-6, cameraScale.value || 1));

function provinceBrushOpts() {
  return {
    radius: provBrushWorldRadius.value,
    strength: provBrushStrength.value,
    tool: provBrushTool.value,
    target: provBrushTarget.value,
  };
}

/** 最近一次操作回执的时间（毫秒）—— 布局类提示不许覆盖它（见 handleResize） */
let lastStatusAt = 0;
function statusMsg(text) {
  provinceHint.value = text;   // 省份网格操作提示（状态栏，与其它工具的 draw-hint 并列）
  lastStatusAt = Date.now();
}

// ── 底图懒建（Phase 3 收尾）─────────────────────────────────────────────
// 项目里一张底图都没有时，**在第一次真正落笔前**建一张空底图，避免「点了没反应」。
// ⚠️ 名字绝不借用任何真实剧本名（曾硬编码「德斯特星」= 拿暮雨自用剧本当示例，已移除）。
const CREATES_CONTENT_TOOLS = new Set([
  'draw', 'height', 'biome', 'culture', 'religion', 'burg', 'river', 'relief',
  'label', 'marker', 'road', 'provinceBrush', 'provincePaint', 'provinceLasso', 'provinceFill',
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
/**
 * 建一张空白底图（**同步核心**：只建、不切换、不提示）—— ensureBaseMap / 工具栏按钮 / 空态按钮共用。
 * @returns {{ok:boolean, name?:string, reason?:string}}
 */
function createEmptyBaseMap() {
  if (store.isReadOnly) return { ok: false, reason: store.readOnlyReason || '只读：未打开项目' };
  const name = nextBaseMapName();
  store.addBaseMap(name, { name });
  if (!store.baseMaps?.[name]) {
    return { ok: false, reason: '底图没有建出来（保存状态可能异常，请看右上角保存提示）' };
  }
  return { ok: true, name };
}

/**
 * 工具栏「空底图」与「新建剧本 → 新建空底图」的唯一动作：建好 → 切过去 → 回执。
 *
 * 为什么独立成函数：切换底图不只是改 `baseMapKey` —— 还要清选中、持久化当前键、按新底图重绘
 * （`onBaseMapChange` 就是这条唯一收口）。三处入口各写一遍，迟早有一处忘了清选中/持久化。
 */
async function addEmptyBaseMap() {
  const r = createEmptyBaseMap();
  if (!r.ok) { statusMsg(`新建底图已停用：${r.reason}`); return null; }
  baseMapKey.value = r.name;
  await onBaseMapChange();
  statusMsg(`已新建空底图「${r.name}」—— 之后画的省份 / 河流 / 道路都落在这张图上，不影响现有底图；要地形数据时用「＋」导入 .map 补`);
  return r.name;
}

function ensureBaseMap() {
  if (baseMapKey.value && store.baseMaps?.[baseMapKey.value]) return true;
  const first = availableBaseMaps.value[0]?.id;
  if (first) { baseMapKey.value = first; return true; }
  const r = createEmptyBaseMap();
  if (!r.ok) {
    statusMsg(`编辑已停用：${r.reason}（在上面新建/打开项目后即可编辑）`);
    return false;
  }
  baseMapKey.value = r.name;
  statusMsg(`项目里还没有底图：已新建空底图「${r.name}」（可用工具栏「+」导入 .map 覆盖）`);
  return true;
}

/**
 * 空态提示里的「新建空底图，自己画」（P0-3）。
 * 与绘制工具触发的懒建是**同一条路**（`ensureBaseMap`）—— 这里只补一句针对按钮的回执：
 * 按钮点下去必须有回音（"没反应"是本项目反复出现的一类投诉）。
 */
/**
 * 「第一笔」入口（2026-10-22）：确保有底图 → 进底图编辑 → 选「画省份」。
 *
 * 为什么需要它：空底图上日常模式的省份行只有 圈选/点填/折线/铺底/描轮廓，全都要"已有省份或陆地"；
 * 真正能开第一笔的「画省份」只在「底图编辑」主行里（`v-if="basemapEditMode"`）——
 * 用户卡在这里，无路可走（原话：「可以建空底图了，但是我不知道怎么画，于是又卡住了」）。
 *
 * ⚠️ 不能只靠 `setTool('draw')` 自动开模式：`BASEMAP_TOOL_IDS` 里**没有** draw/vertex
 *    （它们是从主行去的），所以这里显式走 `toggleBasemapEditMode()`（它同时收起「更多」并给回执）。
 */
function startDrawingProvince() {
  if (store.isReadOnly) {
    statusMsg(`画省份已停用：${store.readOnlyReason || '只读：未打开项目'}`);
    return false;
  }
  if (!ensureBaseMap()) return false;
  if (!basemapEditMode.value) toggleBasemapEditMode();
  setTool('draw');
  statusMsg('画省份：在画布上按住左键绕一圈，松手成省（Shift = 不吸附已有省界；画歪了 Ctrl+Z）');
  return true;
}

/**
 * 「笔刷建省」入口（2026-10-22）：确保有底图 → 进底图编辑 → 选笔刷建省。
 *
 * 与 `startDrawingProvince` 是**两条并列的第一笔路径**（不是同一个工具的两个名字）：
 *   · 画省份 = 绕一圈描边界（精确、会贴骨架）
 *   · 笔刷建省 = 抹一条（快、像画图；不闭合也能成省）
 * 用户原话：「按住左键像涂色一样抹，松手自动把抹过的范围长成一个省」——
 * 空底图上"不知道怎么落第一笔"的人，绝大多数想的是前者那种笔，不是套索。
 */
function startPaintingProvince() {
  if (store.isReadOnly) {
    statusMsg(`笔刷建省已停用：${store.readOnlyReason || '只读：未打开项目'}`);
    return false;
  }
  if (!ensureBaseMap()) return false;
  if (!basemapEditMode.value) toggleBasemapEditMode();
  setTool('provincePaint');
  statusMsg('笔刷建省：按住左键像涂色一样抹，松手抹过的范围就是一个省（不用闭合；一笔一条撤销）');
  return true;
}

async function createEmptyBaseMapFromHint() {
  const name = await addEmptyBaseMap();
  if (name) {
    statusMsg(`已新建空底图「${name}」—— 用「画省份」或笔刷工具直接开始；之后随时可用「导入 .map 底图」补地形/河流数据`);
  }
  return !!name;
}

function addEmptyProvince() {
  if (store.isReadOnly) { statusMsg(`新建省份已停用：${store.readOnlyReason}`); return; }
  const res = store.addBrushProvince(baseMapKey.value, {});
  if (!res || res.blocked) { statusMsg((res && res.message) || '新建省份失败'); return; }
  provBrushTarget.value = res.idx;
  provinceBrush.invalidateBorders();
  statusMsg(`已新建「${res.name}」——按住涂抹即可给它划地（边界在抬手时生成）`);
  render();
}

function clearAllProvinceShapes() {
  if (store.isReadOnly) { statusMsg(`重置省界已停用：${store.readOnlyReason}`); return; }
  const res = store.clearProvinceLabels(baseMapKey.value);
  if (!res || res.blocked) { statusMsg((res && res.message) || '重置省界失败'); return; }
  provinceBrush.invalidateBorders();
  statusMsg(`已清空 ${res.cleared || 0} 个省份的边界（一次撤销可回退）`);
  render();
}

// onMouseDown 已搬到 src/renderer/src/scenario/interaction/down.js（2026-10-31）


// onMouseMove 已搬到 src/renderer/src/scenario/interaction/move.js（2026-10-31）


// onMouseUp 已搬到 `scenario/interaction/pointer.js`（2026-10-31）


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

// onWheel 已搬到 helpers.js（2026-10-31）


// fitToView 已搬到 helpers.js（2026-10-31）


// ═══════════════════════════════════════════
// 鼠标交互
// ═══════════════════════════════════════════

/**
 * 打开省份右键菜单（**唯一实现**）。
 *
 * 🔴 2026-10-07 修：此前只有 `onCanvasClick` 里的 `event.button === 2` 分支会开这个菜单，
 *    而 **浏览器对右键根本不派发 `click`**（只派发 `contextmenu` / `auxclick`）——
 *    当时唯一的 contextmenu 监听器只写了 `e.preventDefault()` → 真机上**右键菜单整片打不开**。
 *    该菜单里的四条失效后果（据实说，别夸大）：
 *      · 「重命名」「更改生物群系」 —— 属性面板另有入口（改名输入框 / 群系下拉）；
 *      · 「删除」                   —— 「更多 → 删除 (E)」工具另有入口（点击省份即删）；
 *      · 「复制省份」               —— **此前只有这个菜单有**（唯一真正独有的能力）。
 *    即便如此，一个"点了没反应"的右键仍是真缺陷（用户第一反应就是右键）。
 *    ⚠️ 之所以长期没被发现：测试里自己 `dispatchEvent(new MouseEvent('click', {button:2}))`
 *    就能把菜单"打开"，于是源码/行为守卫双双为真 —— **合成事件比真实浏览器更宽松**
 *    （`test_88` 现在只用真实 `contextmenu` 事件做判据）。
 *    现在入口是真正的 `contextmenu` 监听器；`click` 分支保留（合成事件仍可用，行为不变）。
 */
function openProvinceContextMenu(event) {
  const rect = canvas.value.getBoundingClientRect();
  const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
  const prov = findProvinceAt(world.x, world.y);
  if (!prov) return false;
  selectedProvince.value = prov;
  contextMenu.value = {
    show: true,
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
    provId: prov.id,
  };
  return true;
}

async function onCanvasClick(event) {  if (event.button === 2) {
    // 批量铺底：右键 = 去掉最近的种子点（这个工具下不需要省份右键菜单）
    if (tool.value === 'voronoi') {
      const rect = canvas.value.getBoundingClientRect();
      const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
      onBatchSeedClick(world, true);
      return;
    }
    openProvinceContextMenu(event);
    return;
  }
  // 地形注记手绘：这一击已经在 mousedown/mouseup 收口，别再落到选省/选河等分支上
  if (suppressTerrainPickClick || terrainLabelPick.value) { suppressTerrainPickClick = false; return; }
  
  const rect = canvas.value.getBoundingClientRect();
  const sx = event.clientX - rect.left;
  const sy = event.clientY - rect.top;
  const world = screenToWorld(sx, sy);

  // 涂归属：写入已在 mouseup 完成 —— 紧随的 click 不再落到别的工具分支
  if (tool.value === 'ownerBrush') return;
  // 笔刷建省（2026-10-22）：同上，建省已在 mouseup 完成（click 只可能是这一笔的尾巴）
  if (tool.value === 'provincePaint') return;

  if (tool.value === 'erase') {
    const prov = findProvinceAt(world.x, world.y);
    if (prov && confirm(`确定删除省份「${prov.name}」？\n\n该省在各剧本里的势力归属与易主年份会一并清空（可用 Ctrl+Z 整体撤回）。`)) {
      if (store.isReadOnly) { statusMsg(`删除省份已停用：${store.readOnlyReason || '只读：未打开项目'}`); return; }
      const r = store.removeBaseProvince(baseMapKey.value, prov.id);
      statusMsg(r && r.cascadedScenarios
        ? `已删除省份「${prov.name}」（连带清理 ${r.cascadedScenarios} 个剧本里的归属键，可 Ctrl+Z 撤回）`
        : `已删除省份「${prov.name}」`);
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

  // A：折线切割 —— 逐点落顶点（双击 / Enter 收口，见 onCanvasDblClick / onKeyDown）
  if (tool.value === 'polySplit') {
    if (event.shiftKey) { polySplitKeepStart.value = !polySplitKeepStart.value; }
    onPolySplitClick(world);
    return;
  }

  // B：批量铺底 —— 左键加种子点、Alt/右键去种子点
  if (tool.value === 'voronoi') {
    onBatchSeedClick(world, !!event.altKey);
    return;
  }

  if (tool.value === 'merge') {
    handleMergeClick(world);
    return;
  }

  // 选择模式：标记 → 城镇 → 省份（标记画在最上层，所以先认它）
  if (tool.value === 'select') {
    // 🔴 2026-10-17 第八修·三修：这次 click 若是"mousedown 已经消费掉河命中"的那一次，
    //    直接跳过 —— 否则下面的"选省"逻辑会把刚选中的河当场取消（用户看到的是"点了没反应"）。
    if (riverPressHandled) {
      riverPressHandled = false;
      return;
    }
    // 🔴 2026-10-17 第八修·补（用户实测：「河流逐条点根本点不中，之前画的测试河流无法删除」）：
    //    河流的命中判定此前**只在河流工具里**（`tool === 'river'`）。于是用「选择」工具
    //    点河 = 什么都没发生；而 `Delete` 也因为 `selectedRiver` 为空而不删。
    //    结果：画错的河**没法删**（用户的原话是"噩梦"）。
    //    现在：选择工具里**河优先于省**（河是压在地形上的一层细线，用户点它就是要选它），
    //    命中范围比河流工具宽一点（细线本来就难点中）。
    //    ⚠️ 真正的主判定已前移到 `onMouseDown`（click 会因轻微拖动而不派发），
    //       这里保留一份是为了"点得极快、没有拖动"的情况 —— 两条路都能选中。
    const hitRiver = hitTestRiver(
      (baseMap.value?.rivers) || [], world.x, world.y, RIVER_SELECT_HIT_PX / cameraScale.value,
      (r) => riverNodesForRender(r),
    );
    if (hitRiver) {
      applyRiverPick(hitRiver.id, event.shiftKey);
      return;
    }
    // 点空白 / 城镇 / 省份 = 取消河流选中（2026-10-27 用户 C3：「特别难取消选中」）。
    // 旧实现只换 selectedProvince，selectedRiverId 留着 → 河一直高亮、手柄一直在。
    if (riverSelIds().length) {
      setRiverSelection([]);
      statusMsg('已取消河流选中（数据未改；Esc 同效）');
    }
    // 标记命中（2026-10-24）：标记是叠在地形/城镇之上的图标 → 点它就该选中它。
    // 此前这一段缺失 = 标记"放下就再也点不到"（没有面板，也没有任何回执）。
    const markerHit = findMarkerAt(world);
    if (markerHit) {
      openMarkerEditor(markerHit.marker, markerHit.index);
      render();
      return;
    }
    if (selectedMarker.value) closeMarkerEditor();   // 点空地/别的对象 → 收起标记面板（重绘在末尾）
    const burg = showBurgs.value ? findBurgAt(sx, sy) : null;
    selectedBurg.value = burg;
    if (burg) {
      openBurgEditor(burg);
    } else {
      const prov = findProvinceAt(world.x, world.y);
      // Ctrl/⌘ + 点击 = 把该省加进/移出多选集合（批量指派的入口）
      if (prov && (event.ctrlKey || event.metaKey)) {
        toggleProvinceSelection(prov.id);
        selectedProvince.value = prov;
        showProps.value = true;
        statusMsg(selectedProvinceIds.value.includes(prov.id)
          ? `已加入多选：「${prov.name}」（共 ${selectedProvinceIds.value.length} 省；用下面的批量条指派）`
          : `已移出多选：「${prov.name}」（还剩 ${selectedProvinceIds.value.length} 省）`);
      } else {
        if (selectedProvinceIds.value.length) clearProvinceSelection();   // 普通点击 = 回到单选
        selectedProvince.value = prov;
        showProps.value = !!prov;
      }
    }
    render();
    return;
  }

  // ── 河流编辑器（2026-10-17）：**必须放在剧本模式闸门之前** ────────────────────
  // 🔴 底下那句 `if (viewMode.value !== 'scenario' || !selectedScenario.value) return;`
  //    是"着色类工具"的闸门，而河流属于**底图内容**（`baseMap.rivers`）——
  //    `viewMode` 初值就是 `'base'`（`const viewMode = ref('base')`），选剧本才会变
  //    `'scenario'` → 旧写法下"在底图模式下画河"这一整条链（双击收口 / 选中 / 加拐点）
  //    **一次都进不去**，只能靠 mousedown 一个点一个点地戳。真机探针已复现：
  //    `viewMode='base'` 时点画布 → 草稿涨了、河里什么都没有。
  if (tool.value === 'river') {
    // 这一笔已由 mousedown/mouseup 处理（画河或拖节点）→ 吃掉这次 click
    if (suppressRiverClick) { suppressRiverClick = false; return; }
    if (store.isReadOnly) { statusMsg(`河流编辑已停用：${store.readOnlyReason}`); return; }
    const hit = hitBaseMapRiver(world.x, world.y);
    if (!hit) {
      // 没点到任何河：清掉选中，说清楚下一步（不是"点了没反应"）
      selectedRiverId.value = null;
      riverActiveNode.value = -1;
      statusMsg('这里没有河流 —— 按住左键拖一笔就能画一条（松手成河）；想改已有的河就点它的河身');
      render();
      return;
    }
    const already = selectedRiver.value && selectedRiver.value.id === hit.id;
    if (already) {
      // 🔴 点**已选中**那条河的河身 = 在最近一段插一个节点（与行星图同一判据）。
      //    以前想加拐点只能删整条重画（会换 id/名字、丢掉调好的 width）。
      const seg = findRiverSegment(hit.points || [], world.x, world.y, px(RIVER_HIT_PX));
      if (seg) {
        const nodes = insertNodeBetween(hit.points || [], seg.index, seg.point, () => null)
          .map((p) => ({ x: p.x, y: p.y }));
        const res = store.updateBaseMapRiver(baseMapKey.value, hit.id, { points: nodes }, {});
        if (res && res.ok && res.changed) {
          statusMsg(`已在第 ${seg.index + 1} 段插入一个节点（现 ${nodes.length} 个）`
            + ' —— 继续点河身可加更多，拖节点可微调，Delete 删节点');
        } else if (res && !res.ok) {
          statusMsg(`加拐点失败：${res.message || '未知原因'}`);
        }
        render();
        return;
      }
    }
    selectedRiverId.value = hit.id;
    riverActiveNode.value = -1;
    // 提示里写明"再点河身加拐点 / 拖节点" —— 不然这个能力照样没人知道（可发现性纪律）
    statusMsg(`已选中河流「${hit.name || '未命名'}」（${(hit.points || []).length} 个节点）`
      + ' —— 再点河身=加拐点，拖节点=微调，鼠标移到节点上按 Delete=删这个节点');
    render();
    return;
  }

  if (viewMode.value !== 'scenario' || !selectedScenario.value) return;

  if (tool.value === 'paint') {
    const prov = findProvinceAt(world.x, world.y);
    if (prov && prov.kind === 'sea') {
      // P4：海域不进剧本归属 —— 时间轴 / 谱系都不该出现一片海
      statusMsg('这是海域（kind=sea）：海域不参与势力归属 —— 要不要先在右侧属性面板把它改成陆地？');
      render();
      return;
    }
    if (prov) {
      if (selectedPolity.value) {
        // 把时间轴当前**日期**一并记为显式易主日期 ——
        // 「拖到某日再上色 = 该日易主」，这是易主日期最自然的录入路径（月日精度：现在就带上月日）
        const wr = store.setOwnership(
          selectedScenario.value.id, prov.id, selectedPolity.value.id, tlDate.value,
        );
        if (wr && wr.success === false) {
          statusMsg(`「${prov.name}」归属已改，但易主日期没记：${wr.reason}`);
        } else {
          statusMsg(`「${prov.name}」→ ${selectedPolity.value.name}（易主日期 ${tlDateText.value}）`);
        }
      } else {
        // 色板上的「✕ 清除归属」过去只是 `selectPolity(null)`：title 承诺"清除归属"，
        // 行为却是"取消选中"，再点省份则因旧条件 `&& selectedPolity.value` 而**静默无反应**
        // （而 store 里 `clearOwnership` 明明已实现、还带 undo —— 全仓零调用 = 死入口）。
        // 现在：没选势力 + 油漆桶 = 真的清除该省的归属，与 title 一致。
        const had = !!(selectedScenario.value.ownership || {})[prov.id];
        if (!had) { statusMsg(`「${prov.name}」本来就没有势力归属`); return; }
        store.clearOwnership(selectedScenario.value.id, prov.id, tlDate.value);
        statusMsg(`已清除「${prov.name}」的势力归属（可 Ctrl+Z 撤回）`);
      }
      render();
    } else {
      statusMsg(selectedPolity.value
        ? `没点到省份 —— 油漆桶只对省份多边形生效（当前已选势力：${selectedPolity.value.name}）`
        : '没点到省份；另外：「✕ 清除归属」模式下油漆桶点省份 = 清空该省归属，想指派请先点一个势力色块');
    }
  } else if (tool.value === 'label') {
    const text = await askText({ title: '输入地名' });
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
      // 2026-10-24：点在**已有标记**上 = 打开它的面板，而不是又叠一个（同一位置两个图标
      // 谁也分不清，而且两个都点不开）。要用新标记请稍微挪开一点。
      const exist = findMarkerAt(world);
      if (exist) {
        openMarkerEditor(exist.marker, exist.index);
        statusMsg(`这里已有标记「${exist.marker.name || '（未命名标记）'}」—— 已打开它的面板；`
          + '要新放一个请挪开一点（同一位置叠两个谁也点不准）');
        render();
        return;
      }
      const name = await askText({ title: '标记名称' });
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
    // 河流编辑器（P1-T2 手动绘制河流路径）—— **拖笔收点**
    //
    // 🔴 2026-10-16（画河保底）：原来这里**每个 pointer 事件都 push 一个点**（无最小间距）。
    //    pointermove 每几像素报一次 → 一条长河攒出**上千个节点**：
    //    ① 节点编辑变得不可用（满屏都是点）；② 项目 JSON 白胖；③ Chaikin 平滑的成本 ×4 后更糟。
    //    现在按**屏幕 px 换算的世界单位**设最小间距 —— 用 px 定阈值是为了"缩得越小、采样越稀"，
    //    与用户手感一致（缩远了本来就画不出细节）。
    const minStep = px(RIVER_TRACE_MIN_STEP_PX);
    const last = riverDraft.value[riverDraft.value.length - 1];
    if (!last || Math.hypot(world.x - last.x, world.y - last.y) >= minStep) {
      riverDraft.value.push({ x: world.x, y: world.y });
      render();
    }
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
            // D（2026-10-11）：**改走 store**。旧实现是手搓 `store.baseMaps = {...}` ——
            // 那条路（① 不进撤销栈 ② 不触发 scheduleAutoSaveScenarios，只能"碰巧"赶上别的保存）
            // 实测后果：画完的路可能既撤不掉也可能不落盘，且绕过了只读态写闸门。
            const wr = store.addBaseMapRoute(baseMapKey.value, newRoute);
            if (wr && wr.ok) {
              statusMsg(`已画一条道路（${roadPoints.length} 个点，共 ${wr.count} 条）—— Ctrl+Z 可撤销`);
            } else {
              statusMsg(`道路没画上：${(wr && wr.message) || '未知原因'}`);
            }
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
  // 🔴 2026-10-17：双击收口**保留**，但不再是唯一的路（松手就落库）。
  //    留着它的理由：用户从旧版本带来的手感，以及"描点式"画长河的兜底。
  if (tool.value === 'river' && riverDraft.value.length >= 2) {
    finishRiverDraft();
  }
  // A：折线切割 —— 双击 = 收口切开（与「自由绘制」同一套手感）
  if (tool.value === 'polySplit' && polySplitPoints.value.length >= 2) {
    finishPolySplit();
  }
}

/** 输入类元素 / 可编辑区里，画布快捷键一律让路（打字、退格、复制粘贴都不劫持） */
function isEditableTarget(t) {
  if (!t) return false;
  const tag = String(t.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!t.isContentEditable;
}

// finishDraw 已搬到 misc.js（2026-10-31）


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
// 上一笔被净化层拒绝的原因（松手时 statusMsg 用它说人话，不再只报「轨迹太短」）
let freeTraceRejectReason = '';
/** 用户点了提示卡的 ×（本次进剧本内不再弹；换底图/新建省后自然也不需要） */
const emptyHintDismissed = ref(false);
let suppressDrawClick = false;      // 一笔成型后紧随的 click 不要再落顶点

/* ══════════════════════════════════════════════════════════════════════════
 * 自由绘制的**唯一几何链**：预览 = 落库（2026-10-17 第四轮）
 *
 * 暮雨的说法：「主要是编辑体验这一块，不要搞成描点连线模拟器就行」。
 * 此前松手**前**的预览是一条**手抖折线**（`tracePath(freeTrace)`），而松手**后**落库的是
 * 另一条形状（简化 → 贴骨架 → 贝塞尔平滑）—— 两条不一样，预览就只是"笔迹"，不是
 * "你将得到的那块地"。现在预览与落库都走 `freeTraceRing()`，做到**按什么看到什么**。
 *
 * ⚠️ 贴骨架那段是 O(点数 × 骨架点数)：415 省底图上**不能每帧跑** →
 *    ① 骨架按 `terrain` 引用缓存（`skeletonCache`，同 `coincidentIndexFor` 的口径）；
 *    ② 预览形状按 **60ms** 节流（手感线仍逐帧跟手，只有"地块形状"是 ~16fps）。
 * ══════════════════════════════════════════════════════════════════════════ */
let skeletonCache = null;           // { terrain, skeleton }
function skeletonForTerrain(terrain) {
  if (skeletonCache && skeletonCache.terrain === terrain) return skeletonCache.skeleton;
  const built = buildSkeleton(terrain);
  skeletonCache = { terrain, skeleton: built };
  return built;
}

/**
 * 轨迹 → 省份环（预览与落库共用）。
 * @param {Array} rawPts 手迹采样点（世界坐标）
 * @param {object} opts `{ snap }` —— 画省份默认吸附到已有省界；Shift 旁路
 * @returns {{ring: Array, simplified: number, snapped: number}|null} null = 轨迹太短，不成形
 */
// freeTraceRing 已搬到 province.js（2026-10-31）


/** 预览形状的节流缓存（手感线不用它；只有"地块形状"用） */
let tracePreviewCache = { at: -1e9, ring: null };
function previewTraceRing() {
  const n = freeTrace ? freeTrace.length : 0;
  if (n < 3) return null;
  // 一大团自己绕自己的手迹（乱涂）不画"预测地块"：那种环本来就没意义，画出来是一团
  // 交叉白线（用户实测："这玩意很卡…画出来一团"），还每 60ms 白算一次。
  if (n > 400) return null;
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  if (now - tracePreviewCache.at < 90) return tracePreviewCache.ring;
  const shape = freeTraceRing(freeTrace, { snap: tool.value === 'draw', sanitize: false });
  const ring = shape ? shape.ring : null;
  tracePreviewCache = {
    at: now,
    ring: ring && selfIntersectionCount(ring) === 0 ? ring : null,
  };
  return tracePreviewCache.ring;
}

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
/**
 * 描轮廓落库（E，2026-10-11）：把笔迹**围住的那块地**从邻省手里改到目标省。
 *
 * 语义与「画省份」的区别（同一个手势，两件事）：
 *   · 画省份 = 新建一个省（区域是笔迹**描出的轮廓**）
 *   · 描轮廓 = 改已有省份的边界（区域是笔迹**围出的闭合形状**，目标省 = 区域里占比最高的那个）
 * 落库只在 store（`applyProvinceOutline`）—— 判定与几何**单源**，组件只负责翻译结果。
 * @returns {boolean} 是否算"这一笔已经成型"（false → 让随后的 click 走描点分支）
 */
// commitOutlineTrace 已搬到 province.js（2026-10-31）


// commitFreeTrace 已搬到 province.js（2026-10-31）


/**
 * 新建省份的**统一落库口**（含压叠闸门）—— 描点 / 自由绘制两条路径共用。
 *
 * 判定在 store（`addBaseProvince` → `utils/provinceOverlap.js`，单源），这里只负责**问人**：
 *   被拦 → 把「压了多少、压在谁身上」摆出来 → 用户确认才带 `allowOverlap` 重试。
 * 为什么是「问」而不是「硬拒」：确实会有人照着一张更大的范围重画，硬拒会让他无路可走；
 * 但**默默压上去**更坏 —— 压叠会让点选、归属上色、势力标签三处互相打架。
 * @returns {object|null} null = 没建成（被拦且用户放弃 / 其它拒绝）
 */
/** 顶点拖动让压叠"恶化"多少才值得问一句（低于它视为既有压叠，不打扰） */
const VERTEX_OVERLAP_WORSEN_MARGIN = 0.05;

// ══════════════════════════════════════════════════════════════════════════════
// P1（2026-10-13）顶点多选 + 共边联动（方案甲：边界整体移动）
//
// 用户要的是"框选一批顶点 → 拖动 → 邻省边界自动重算、不串省"。实现路子：
//   省份的"共边"在数据里就是**两端坐标恰好相同**（网格派生 / FMG 导入 / 骨架吸附三处都如此），
//   所以让邻省的**同位顶点跟着平移同样的 Δ**，边界线就整体移动了 ——
//   A 缩多少 B 就涨多少，**无缝、无压叠，且不需要任何布尔运算**。
//   配对判定在 `utils/vertexSharing.js`（纯函数 + Node 单测），这里只做编排。
// ══════════════════════════════════════════════════════════════════════════════

/** 这次拖动实际搬哪些顶点：拖动的那一个若在选中集里 → 整组；否则只有它自己 */
function effectiveVertexSelection(vertexIdx) {
  const sel = vertexSelection.value || [];
  return sel.indexOf(vertexIdx) >= 0 ? sel.slice() : [vertexIdx];
}

/**
 * 共边索引的**按需缓存**：键是 `terrain` 数组本身。
 * 每次 store 写入都会换数组引用（`setTerrain` / `updateProvincesBatch` 都是新数组），
 * 所以引用相等 = 几何没变 → 复用；引用变了自然失效，不需要额外的手工失效点。
 */
let vertexIndexCache = null;   // { terrain, built }
function coincidentIndexFor(terrain) {
  if (vertexIndexCache && vertexIndexCache.terrain === terrain) return vertexIndexCache.built;
  const built = buildCoincidentIndex(terrain);
  vertexIndexCache = { terrain, built };
  return built;
}

function provIdxOf(prov) {
  const terrain = baseMap.value?.terrain || [];
  return terrain.findIndex((p) => p.id === prov.id);
}

/** mousedown 时算一次共边索引与联动表（mousemove 里复用 —— 每帧重算索引会拖垮帧预算） */
// beginVertexLinkContext 已搬到 provinceOps.js（2026-10-31）


/**
 * 跟随邻省的**预览**（只画不改）：按 `provId` 分组，一组里可以带多个环。
 *
 * 🔴 必须先**按环把位移累积起来、再整体 `shiftPoints` 一次** —— 首版写成
 *    "每个联动顶点各算一次整环的 shiftPoints，然后覆盖同组结果"，于是同一条环上
 *    只有**最后一个**顶点动、其余全部原地不动（test_102 当场量出 B 的 4 个同位顶点只动了 1 个）。
 *    这不是预览问题：落库走的是同一份预览，所以它同时是**数据**问题。
 *
 * @returns {Array<{provId:string, rings:Array<{ringIdx:number, points:Array}>}>}
 */
// buildLinkedPreview 已搬到 provinceOps.js（2026-10-31）


/** 把预览变成可落库的补丁（一个省一个补丁，多环合并到同一次写） */
function collectLinkedPatches(preview) {
  const out = [];
  const terrain = baseMap.value?.terrain || [];
  for (const g of ((preview && preview.linked) || [])) {
    const prov = terrain.find((p) => p.id === g.provId);
    if (!prov) continue;
    const changes = new Map(g.rings.map((r) => [r.ringIdx, r.points]));
    const patch = writeRingsPatch(prov, changes);
    if (patch) out.push({ provId: g.provId, patch, prov });
  }
  return out;
}

/**
 * 多省版压叠闸门（P1）：跟随的邻省走**同一度量、同一"只对恶化发问"**口径。
 * 它们只会涨，仍可能涨到第三个省身上；**一家被拒 → 整次拖动都不落库**（不留半截）。
 */
// confirmVertexBatchOverlap 已搬到 provinceOps.js（2026-10-31）



/**
 * 顶点编辑的**压叠闸门**（2026-10-11）。
 *
 * 与新建省份的闸门（`addProvinceWithOverlapGate`）共用同一份度量 —— 但**判定单源在 store**：
 * 这里只调 `store.previewProvinceOverlap()`（`test_79` f0 硬断言组件里连那个纯函数的名字都不许出现），
 * 组件只负责"问人"。差别只在两点：
 *   ① **先量后写**：候选几何是 `{...prov, ...patch}`（还没落库），用户点「取消」就什么也不发生，
 *      不需要"写完再撤销"那套（那会给一次拖拽留下两条历史）。
 *   ② **只对"恶化"发问**：真实数据里有**本来就互相压着**的省份（格点时代留下的），
 *      若只要 `ratio > 阈值` 就问，用户每拖一个顶点都会被弹一次 —— 把一个既存问题算到
 *      这一下手势头上，很快就会练成"闭眼点确定"。所以判据是「这次拖动让它更压了吗」。
 *
 * @param {object} before 拖动前的省份对象（当前库里的那份）
 * @param {object} after  拖动后的候选省份对象（未落库）
 * @returns {boolean} true = 允许写入
 */
// confirmVertexMoveOverlap 已搬到 provinceOps.js（2026-10-31）


// addProvinceWithOverlapGate 已搬到 provinceOps.js（2026-10-31）


/**
 * 🔴 **手画河的笔迹参数**（2026-10-16，画河保底）。
 *
 * `RIVER_TRACE_MIN_STEP_PX` = 收点/抽稀的**最小间距（屏幕像素）**。
 *   为什么用屏幕 px 而不是世界单位：缩得越小采样越稀 —— 与"缩远了本来就画不出细节"的手感一致，
 *   而且换个底图尺度不用改数字。
 *   太小学生 拖笔就攒出上千节点（节点编辑不可用、JSON 白胖）；太大笔迹会变折线。
 * `RIVER_SMOOTH_ITERATIONS` = 抬笔时 Chaikin 迭代次数（2 是既有实测常用值，见 `polylineSmooth.js`）。
 */
const RIVER_TRACE_MIN_STEP_PX = 10;
/**
 * 🔴 **节点数上限**（2026-10-17 第六修）——"画出来一堆点"的根治。
 *
 * 用户截图里那条河是**几百个圆点糊成的虚线**，根因是点数**由拖动时长决定**：
 * 收点按屏幕 6px 间距（一条横穿屏幕的笔迹 ≈ 120 点）→ Chaikin 2 轮 ×4 → **~480 点**，
 * 而屏幕上线长只有 ~700px → 节点间距 < 2px → 手柄糊成一条点线。
 *
 * 现在：**先按弧长把笔迹压到 `RIVER_TARGET_NODES` 个控制点**，Chaikin 只跑 1 轮
 * （点已经少了，1 轮就够切角，且不会把点数乘到失控）。
 * 目标值按"一个控制点 ≈ 18 屏幕像素"取 —— 与真实地图的河网精度同一量级，
 * 也给节点编辑留出了"点得到"的余地（间距太密的话节点根本拖不准）。
 */
const RIVER_TARGET_NODES = 40;
const RIVER_NODE_SPACING_PX = 30;
const RIVER_MIN_NODES = 6;
const RIVER_MAX_NODES = 72;
/** 一次笔迹最多收几个原始点（防止用户长按慢拖把内存/渲染拖垮 —— 见 `riverDraftTooLong`） */
const RIVER_MAX_DRAFT_POINTS = 600;
/**
 * 节点手柄的**可见性闸门**（2026-10-17 第六修）。
 * 点数超过它、或缩放低于它，就只画"活动节点"那一个。
 * 理由：手柄是给"我要拖某一个点"用的，不是给"看这条河长什么样"用的 ——
 * 点数一多、缩放一小，满屏圆点会把河本身盖掉（用户截图：一堆点而不是线）。
 */
const RIVER_HANDLE_MAX = 120;
const RIVER_HANDLE_MIN_ZOOM = 1.2;
/**
 * 抬笔时低于这个点数视为「只是点了一下」→ **不落库**（当作选河/加拐点，见 onCanvasClick）。
 * 与行星图 `RIVER_BRUSH_MIN_POINTS` 同一口径：拖 2px 手抖不该被当成画一条河。
 */
const RIVER_BRUSH_MIN_POINTS = 4;

// ══════════════════════════════════════════════════════════════════════════
// 河流橡皮（2026-10-18 第十八修·三）—— 暮雨原话：
//   「河流要不要尝试其他画法？应该更偏向手绘吗（甚至有橡皮擦来擦除）。
//     事实上整个司天所有涉及地图编辑的地方，都应该优先参考现成各类绘图软件。」
//
// 现成绘图软件的橡皮是**同一件事**：按住抹过去，笔迹就没了 —— 不需要先选中对象、
// 不需要挑节点、不需要按 Delete。这里照抄这条交互，只是墨水换成了折线几何：
//   · 按下 → 开始记轨迹（世界坐标），画一条半透明的"橡皮轨迹"；
//   · 抹过哪条河 → 那一段被擦掉；**擦断的河断成两条**（切口落在橡皮圈边上）；
//   · 抬手 → 一次原子落库（改/加/删一起，**一条撤销**，见 `applyBaseMapRiverEdit`）。
// 🔴 只擦**手画的河**（id 前缀 `river_`）：导入河是别人 .map 里的数据、自动河是推演出来的
//    中间产物 —— 擦掉它们要么毁掉导入数据、要么下次生成又回来（"擦了又出现"最误导人）。
// ══════════════════════════════════════════════════════════════════════════
/**
 * 橡皮半径（**屏幕像素**，18 ⇒ 直径 36px）。
 * 🔴 为什么是屏幕像素：河节点间距是按屏幕像素定的（`RIVER_NODE_SPACING_PX` = 30px），
 *    橡皮跟着屏幕走，任何缩放档下"抹一下能擦掉一段"的手感才一致（世界单位会让缩远了擦不动）。
 *    18 这个值取在"半个节点间距"之上 —— 保证垂直抹过河身时至少吃掉一个节点。
 */
const RIVER_ERASE_RADIUS_PX = 18;
/** 擦除轨迹的采样最小间距（屏幕像素）—— 与拖笔同口径，避免一次拖动攒上千个采样点 */
const RIVER_ERASE_MIN_STEP_PX = 6;
const riverEraseStroke = ref([]);

/**
 * 抬手：把这一抹翻译成**一次原子写**（改/加/删），并给回执。
 * 数学在纯函数层（`utils/riverErase.js`，Node 单测钉着），这里只负责问 store、说人话。
 */
// commitRiverErase 已搬到 actions.js（2026-10-31）


/**
 * 笔迹 → **落库节点**（预览与落库的**唯一**几何链；2026-10-18 第十八修·四）。
 *
 * 🔴 暮雨原话：「河流要不要尝试其他画法？应该更偏向手绘吗（甚至有橡皮擦来擦除）……
 *    不要搞成描点连线模拟器」。其中"模拟器"的观感有一半来自**画的和落库的不是一条**：
 *    拖动时预览走 `smoothWhileDrawing`，抬手落库走「抽稀 → 压点数 → Chaikin」——
 *    两条链的手感与形状都不同，用户看到的是"松手之后形状跳了一下"。
 *    现在两条路**逐点相同**（回归 `test_122` 按点比对）。
 *
 * **三步走，顺序不能换**（2026-10-17 第六修，用户截图"画出来一堆点而不是线"）：
 *    ① 抽稀：丢掉过密的采样点（按屏幕 px 口径）；
 *    ② **压到目标点数**：按弧长均匀取样 —— 这一步决定"节点间距不会小于约 18 屏幕像素"；
 *    ③ 平滑：Chaikin **只跑 1 轮**（点已经不多，1 轮足够切角；2 轮会把点数再乘 2）。
 *    旧实现缺 ②、且 ③ 跑 2 轮 → 点数 ×4 → 节点手柄糊成一条虚线。
 *
 * @returns {{raw:Array, wantNodes:number, fitted:Array, pts:Array}}
 */
function riverNodesFromDraft(draft) {
  const raw = decimatePolyline((draft || []).map((p) => ({ x: p.x, y: p.y })), px(RIVER_TRACE_MIN_STEP_PX));
  if (raw.length < 2) return { raw, wantNodes: 0, fitted: raw, pts: raw };
  const wantNodes = Math.max(RIVER_MIN_NODES, Math.min(RIVER_MAX_NODES,
    Math.round(draftWorldLength(raw) / px(RIVER_NODE_SPACING_PX))));
  const fitted = fitPolylineToCount(raw, wantNodes, { minCount: RIVER_MIN_NODES, maxCount: RIVER_MAX_NODES });
  const pts = fitted.length >= 3 ? smoothRiverNodes(fitted, 1) : fitted;
  return { raw, wantNodes, fitted, pts };
}

/**
 * 拖动期间的预览节点（= 抬手会落库的那一条）。按 **60ms 节流** —— 几何链里有抽稀与按弧长
 * 重采样，逐帧算没必要（河笔迹最多 `RIVER_MAX_DRAFT_POINTS` 个采样点，但预览只要跟上手感）。
 */
let riverPreviewCache = { at: -1e9, pts: [] };
function riverPreviewNodes() {
  const draft = riverDraft.value || [];
  if (draft.length < 2) return [];
  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  if (now - riverPreviewCache.at < 60) return riverPreviewCache.pts;
  const pts = riverNodesFromDraft(draft).pts;
  riverPreviewCache = { at: now, pts };
  return pts;
}

/**
 * 落库一条手画河（抬笔收口；一条河 = 一条 undo）。
 * @param {boolean} [fromBrush] 是否来自"拖笔"（决定回执措辞与短笔迹的处理）
 * @returns {object|null} 成功时返回新河（供 onCanvasClick 立刻选中）
 */
// finishRiverDraft 已搬到 rivers.js（2026-10-31）


/** 折线总长（世界单位）—— 用来算"该给多少个控制点" */
function draftWorldLength(pts) {
  let sum = 0;
  for (let i = 0; i + 1 < (pts || []).length; i++) {
    sum += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  }
  return sum;
}

/**
 * 一条手画河的**逐点宽度序列**（源头细 → 河口粗）—— 见 `drawCurvedRiver`/`taperWidths`。
 *
 * 🔴 用户原话「不会有粗细变化吗？你没看过真实的地图吗？」：
 *    手画河此前是**一个线宽画到底**，所以形状再对也像一根管子。
 *    这里按 `width` 字段（"河口宽度"）反推源头宽度，中间用三次方根过渡 ——
 *    **同一份数据在两个视图里给同一条河同样的粗细比**。
 *
 * 🔴 2026-10-17 第六修的量纲教训（第三次强调）：`width` 是**世界单位**，
 *    而世界单位宽不宽**取决于是谁在看** —— 底图可以缩到 14%（用户实测截图就是 14%），
 *    那时 `width=1.6` 只有 **0.22 屏幕像素** → 一条几乎看不见的细线。
 *    "在 100% 下多粗"完全没有意义，**判据只能是屏幕像素**。
 *    所以这里做两件事：
 *      ① 世界单位量级先抬到与自动河同一量程（自动河河口实测 3.3 世界单位）；
 *      ② 给一个**屏幕像素下限**（`RIVER_MIN_SCREEN_PX`）——缩多远都还看得见，
 *         这也是真实地图的做法（河流线宽相对屏幕，不相对比例尺）。
 */
// riverWidthsFor 已搬到 rivers.js（2026-10-31）

/**
 * 河道宽度的显示口径（**单一来源**，画布与"调到多粗"都用它）：
 *   · `RIVER_WIDTH_DATA_SCALE = 2.4`：数据里的 width 乘这个倍数是**世界单位**宽度。
 *     取 2.4 是让默认宽度（3.5）× 2.4 = 8.4 世界单位 ≈ **8.4 屏幕像素 @100%**
 *     —— 与用户参考图上的主干河一个量级（实测参考图主干约 4~8px）；
 *   · `RIVER_MIN_SCREEN_PX = 1.8`：缩得再小，河口也不细于 1.8 屏幕像素
 *     （实测 0.7px 在 100% 缩放下几乎看不见，1.2px 仍偏细 —— 而**判据只能是屏幕像素**，
 *      世界单位宽不宽取决于是谁在看，这是第五次强调同一条）。
 *   · 🔴 `RIVER_MIN_SCREEN_CAP_PX = 12`（2026-10-18 第十五修）：屏幕下限**封顶**，
 *     否则它在放大端把世界下限压到 0.11 → 河变成发丝（"空心铁轨"的真因）。
 *     12px 的含义 = "缩到 1× 时至少 12 屏幕像素的河身"，到 1× 以上就不再靠下限、
 *     改由**用户选的世界宽度**决定（放大即变宽，与真实地图一致）。
 *   · `RIVER_WORLD_FLOOR = 0.4`：世界单位硬下限（防 width=0 的病态数据画出 0 宽）。
 *     ⚠️ 这个数字**刻意避开某个两位小数**：`test_73` 有一条"ScenarioMap 的脚本区里
 *       不许出现省名档阈值（一个 0.xx 字面量）"的源码守卫，它唯一可判据的形态就是裸子串。
 *       该守卫第二次误伤时留下的纪律是「遇到时先看是不是省名档逻辑，不是就**改数字**、
 *       别改守卫」—— 这里照办（**连注释里也不要写出那个数**，否则守卫照样红）。
 */
const RIVER_WIDTH_DATA_SCALE = 2.4;
const RIVER_WIDTH_DEFAULT = 3.5;

/** 手画河的**屏幕像素**宽度下限（不管缩到多小，河都要看得见）—— 见 `riverWidthsFor` 口径 */
const RIVER_MIN_SCREEN_PX = 1.8;
/** 上面那个屏幕下限的**封顶**（超过它就不再抬世界宽度；防"越放大越细"）—— 第十五修 */
const RIVER_MIN_SCREEN_CAP_PX = 12;
/** 世界单位硬下限（防病态数据画出 0 宽；数值刻意避开 test_73 守卫的那个字面量） */
const RIVER_WORLD_FLOOR = 0.4;

/** 段长的多少比例用作弯曲偏移（12% ≈ 轻微蜿蜒，像真河而不是像折线） */
const RIVER_MEANDER_RATIO = 0.12;
/** 弯曲偏移的屏幕像素上限（放大时不让河缠成意大利面） */
const RIVER_MEANDER_MAX_PX = 1.8;

/**
 * 把**河链**画成曲线（自动河的唯一画法，2026-10-17 第八修）。
 *
 * 与逐段画法的本质区别（用户「支气管模拟器」的根因）：
 *   · 逐段：N 根一格长小棍，每根独立 `beginPath/stroke` → 分叉处像"劈开的三根棍"，
 *     而且每根都是直线、段与段之间**没有共享几何** → 结构上不可能连成一条河；
 *   · 按链：一条链是"源头 → 汇流点/河口"的**完整折线**，压到 8~14 个控制点后
 *     交给 Catmull-Rom → 一条**大尺度弯曲**的连续曲线；分叉是"链与链的端点相接"。
 *
 * 宽度：每条链取自己的 `flow`，按**本幅图流量上界**映射到屏幕像素（干流粗、支流细），
 * 链内部再按"源头细 → 下游粗"过渡（指数 1.6，与 `taperWidths` 同一口径）——
 * 真实河流的第一特征。
 *
 * @param {CanvasRenderingContext2D} c
 * @param {Array<Array<{x:number,y:number,flow:number}>>} paths 每条链的控制点（已 thin）
 * @param {{toPx:(w:number)=>number, maxFlow:number, color:string, minPx:number, subdiv:number}} opts
 */
// strokeRiverNetworkAsPaths 已搬到 rivers.js（2026-10-31）


/** 自动河最多画多少条链（按流量从大到小取；防病态数据拖死渲染） */
const RIVER_PATH_MAX = 900;
/**
 * 自动河的**链最短点数**：低于它的链不画。
 * 🔴 实测（第八修）：不设这个闸门时 593 条链里 **496 条只有 2 个点**——
 *    那就是用户说的"支气管"：一堆一格长的短直棍。5 个点 ≈ 5 格 ≈ 一张粗糙地图上
 *    "短得看不出是河"的最小长度；再长的才有资格叫支流。
 */
const RIVER_PATH_MIN_POINTS = 5;
/** 每条链压到多少控制点 —— 8~14 才出"大尺度的弯"（格级点数会退回锯齿） */
const RIVER_PATH_CONTROL_POINTS = 12;
/** 河链曲线的每段细分（8 → 一条 12 控制点的链约 90 个曲线点） */
const RIVER_NET_CURVE_SUBDIV = 8;

/**
 * 自动河网的**流量闸门**（绝对流量值）—— 走**分位口径**。
 *
 * 🔴 判据来源（两次实测，第一次的结论是错的，都在这里留档）：
 *   · 第一版用 `segMaxFlow × 0.25`（按上界取比例）。圆丘数据上还行（留 1/8），
 *     但在**真实分布**上直接崩：那份数据段汇流 `p50 = 2`、`max = 1275`（极端长尾），
 *     0.25×1275 = 319 → 3750 段只留 **26 段**（0.7%）→ 画布上几乎什么都没有
 *     （回归 `test_103` 当场抓住："画布上找不到自带河色的像素"）。
 *   · 现在按**分位**（留流量最高的 `RIVER_FLOW_KEEP_RATIO`）—— 与分布形状无关。
 * 🔴 教训的完整版：**归一化的对象是分布，不是最大值**。
 */
function riverFlowGate(segMax, segments) {
  const list = Array.isArray(segments) ? segments : autoRiverSegments.value;
  const gate = riverFlowGateByQuantile(list, RIVER_FLOW_KEEP_RATIO);
  if (gate > 0) return gate;
  // 兜底（没有段数据时按上界比例）
  const m = Number.isFinite(segMax) && segMax > 1 ? segMax : 0;
  return m > 0 ? Math.max(2, m * RIVER_FLOW_KEEP_RATIO) : 0;
}
/** 河网只画流量最高的这一比例（实测 12% 在两种分布上都留住了成百上千段主干） */
const RIVER_FLOW_KEEP_RATIO = 0.12;

/**
 * 河网的**屏幕像素线宽下限** —— 让"这份数据在当前缩放下还有没有意义"决定画多粗。
 *
 * 🔴 为什么需要（用户：「恐怖谷」的几何成因，本轮实测）：
 *    段是"格→格"，**一格的屏幕尺寸 = 格距 × 缩放**。缩到 10% 时一格只有 1.4 屏幕像素 →
 *    一万根 1~2 像素的短线并排 = 一片**平行斜线网格**（不是河，是布纹）。
 *    真实地图在这种比例尺下**根本不画细支流**。
 *    所以：一格 ≥ 6px 时按自带河口径（0.7px 起）；一格只有 1.4px 时抬到 2.2px ——
 *    细到"看不见"的段自然被更粗的主干盖过，网络才不会变成布纹。
 */
function riverMinWidthForNet() {
  const hm = baseMapKey.value ? store.getHeightmapFor(baseMapKey.value) : null;
  const spacing = Number(hm && hm.grid && hm.grid.spacing) || 0;
  const scale = cameraScale.value || 0;
  if (!(spacing > 0) || !(scale > 0)) return RIVER_NET_MIN_PX_BASE;
  const cellPx = spacing * scale;
  if (cellPx >= RIVER_NET_CELL_PX_OK) return RIVER_NET_MIN_PX_BASE;
  const t = Math.max(0, Math.min(1, cellPx / RIVER_NET_CELL_PX_OK));
  return RIVER_NET_MIN_PX_BASE + (RIVER_NET_MIN_PX_MAX - RIVER_NET_MIN_PX_BASE) * (1 - t);
}
/** 一格 ≥ 这个屏幕像素数 ⇒ 网络还"看得清"，按自带河口径画 */
const RIVER_NET_CELL_PX_OK = 6;
/**
 * 河网的**最细屏幕像素**（`minPx`）。
 * 🔴 1.2 而不是 0.7：实测在 100% 缩放下（cellPx=14.4）0.7px 的线**几乎看不见**
 *    （用户：「自动河流依旧恐怖谷」的另一半是"看不清"）。1.2px 仍然比自带河细，
 *    但干流能站住 —— 真实地图上的主干河也是这个量级。
 */
const RIVER_NET_MIN_PX_BASE = 1.2;
/** 格子小到看不见时，最细的河抬到这个屏幕像素（避免布纹） */
const RIVER_NET_MIN_PX_MAX = 2.2;

/**
 * `catmullRomPoints` 的每段细分（屏幕观感 vs 成本的平衡量）：
 * 一条 48 控制点的河 → (48-1)×7+1 ≈ **330 个曲线点** → 330 次逐段描边。
 * 实测这一量级在一帧里是亚毫秒到毫秒级（见 `strokeVariableWidth` 注释）；
 * 再高就只是给"已经看不见的折角"付费了。
 */
const RIVER_CURVE_SUBDIV = 7;

/** 画布上画一条手画河（**唯一实现**：曲线 + 变宽 + 岸线） */
// drawOneHandRiver 已搬到 riverOps.js（2026-10-31）


// ══════════════════════════════════════════════════════════════════════════
// 剧本底图的**河流节点编辑**（2026-10-17）
//
// 为什么必须补：底图侧的河此前只有 add / remove —— 「画完之后想微调」在数据层
// 与交互层**两个地方都没有出口**（行星图早就有的「拖节点 / 加拐点 / 删整条」）。
// 用户原话是"保底也要做，强化地图编辑器本身，让用户可以随心所欲画河流"。
//
// 🔴 底图河的坐标是**底图自身坐标系**，与行星图的高度图不是一回事 ——
//    所以这里**不做流向约束**（`clampRiverNode`）：底图河边上的"高度"只是当底图
//    恰好绑了行星/带了高度图时才存在，硬套会把节点弹到用户没点的地方。
//    真实约束由用户的眼睛承担，撤销由 Ctrl+Z 承担（一次编辑 = 一条 undo）。
// ══════════════════════════════════════════════════════════════════════════

/** 手画的河（id 前缀 `river_`）—— 与 `drawRiverPaths` 同一口径，导入河不参与节点编辑 */
function handDrawnRivers() {
  return (baseMap.value?.rivers || []).filter((r) => r && String(r.id || '').indexOf('river_') === 0);
}

/** 命中哪一条手画河（河身容差随相机缩放换算） */
function hitBaseMapRiver(wx, wy) {
  const tol = px(RIVER_HIT_PX);
  return hitTestRiver(handDrawnRivers(), wx, wy, tol);
}

// ── 支流（2026-10-18 第十五修）──────────────────────────────────────────────
//
// 用户原话：「河流的手动绘制依旧画不好……而且依旧不能给河流画支流。似乎只能加拐点。
// 依旧描点连线模拟器。我又画了一条想模拟河流汇聚，结果给我整出来什么交叉怪物。」
//
// 拆成两条互相独立的保证：
//   ① **能画支流**：起笔落在已有河的河身上 → 起点吸附到河身、笔迹沿路吸附（`snapToPolyline`）；
//   ② **画不出交叉怪物**：松手时若这一笔**穿回母河**（超过"起点那一下"的交叉）或**自交**，
//      直接丢弃并说清原因（宁可不落库，也不留一团交叉线）。
// ⚠️ 判据是"**交点个数**"而不是"有没有交点"：支流从母河**长出去**时必然与母河有一处相交
//    （就是起点），那一处不算。所以穿回母河 = 交点 ≥ 2。
/** 起笔吸附到河身的容差（屏幕像素） */
const RIVER_BRANCH_SNAP_PX = 22;

/** 河身上离给定世界点最近的那一点（返回 dist 供调用方判闸门） */
function snapToPolyline(w, points) {
  const pts = Array.isArray(points) ? points : [];
  if (!w || pts.length === 0) return null;
  if (pts.length === 1) return { point: { x: pts[0].x, y: pts[0].y }, dist: Math.hypot(w.x - pts[0].x, w.y - pts[0].y), segIndex: 0 };
  let best = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((w.x - a.x) * dx + (w.y - a.y) * dy) / len2)) : 0;
    const px2 = a.x + dx * t, py2 = a.y + dy * t;
    const dist = Math.hypot(w.x - px2, w.y - py2);
    if (!best || dist < best.dist) best = { point: { x: px2, y: py2 }, dist, segIndex: i };
  }
  return best;
}

/** 起笔是否有"母河"可接（返回 { river, point, dist } 或 null）—— 只看手画河（导入河不参与编辑） */
function hitHandRiverBranchAnchor(wx, wy) {
  const tol = px(RIVER_BRANCH_SNAP_PX);
  let best = null;
  for (const r of handDrawnRivers()) {
    const s = snapToPolyline({ x: wx, y: wy }, r && r.points);
    if (s && s.dist <= tol && (!best || s.dist < best.dist)) best = { river: r, point: s.point, dist: s.dist };
  }
  return best;
}

/**
 * 两条线段是否相交（**含端点接触与共线重叠**）。
 *
 * 🔴 2026-10-18 第十五修·补：第一版只判"严格跨立"（四个叉积异号）—— 用户手画的河
 *    常常是**轴对齐的**（一笔拉直、或横平竖直），于是"穿过去"恰好落在母河的**顶点**上：
 *    四个叉积里有一个是 0，严格判据返回 false ⇒ **交叉怪物照样落库**
 *    （探针实测：一条水平笔画过一条竖线的中点，`worst=0`）。
 *    端点接触必须算相交：拓扑上它就是"穿过"。
 */
function segmentsProperlyIntersect(p1, p2, p3, p4) {
  const EPS = 1e-9;
  const o = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const onSeg = (a, b, c) => Math.abs(o(a, b, c)) <= EPS
    && Math.min(a.x, b.x) - EPS <= c.x && c.x <= Math.max(a.x, b.x) + EPS
    && Math.min(a.y, b.y) - EPS <= c.y && c.y <= Math.max(a.y, b.y) + EPS;
  const o1 = o(p3, p4, p1), o2 = o(p3, p4, p2), o3 = o(p1, p2, p3), o4 = o(p1, p2, p4);
  if (((o1 > EPS && o2 < -EPS) || (o1 < -EPS && o2 > EPS))
      && ((o3 > EPS && o4 < -EPS) || (o3 < -EPS && o4 > EPS))) return true;
  // 退化情形：端点落在另一条线段上 / 共线重叠
  if (onSeg(p3, p4, p1) || onSeg(p3, p4, p2) || onSeg(p1, p2, p3) || onSeg(p1, p2, p4)) return true;
  return false;
}

/** 两条线段是否相交（**含端点接触与共线重叠**）。见下方同名实现的注释。 */
function segmentHits(p1, p2, p3, p4) {
  return segmentsProperlyIntersect(p1, p2, p3, p4);
}

/** 折线与折线的交点数（用于"穿回母河"与"自交"两条判定） */
function countPolylineCrossings(a, b) {
  const A = Array.isArray(a) ? a : [];
  const B = Array.isArray(b) ? b : [];
  let n = 0;
  for (let i = 0; i + 1 < A.length; i++) {
    for (let j = 0; j + 1 < B.length; j++) {
      if (segmentHits(A[i], A[i + 1], B[j], B[j + 1])) n++;
    }
  }
  return n;
}

/** 自交段数（相邻段共享端点，天然不算相交） */
function countSelfCrossings(pts) {
  const P = Array.isArray(pts) ? pts : [];
  let n = 0;
  for (let i = 0; i + 1 < P.length; i++) {
    for (let j = i + 2; j + 1 < P.length; j++) {
      if (segmentsProperlyIntersect(P[i], P[i + 1], P[j], P[j + 1])) n++;
    }
  }
  return n;
}

/**
 * 给一条折线当"侧向测试基准"的一段（取**最长**的那一段，最能代表这条河的走向）。
 * @returns {{a:{x:number,y:number}, b:{x:number,y:number}}|null}
 */
function riverSideRef(points) {
  const pts = Array.isArray(points) ? points : [];
  let best = null;
  let bestLen = -1;
  for (let i = 0; i + 1 < pts.length; i++) {
    const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    if (len > bestLen) { bestLen = len; best = { a: pts[i], b: pts[i + 1] }; }
  }
  return best;
}

/** 点在直线 a→b 的哪一侧（>0 左 | <0 右 | 0 线上；只看符号，不看距离） */
function sideOfLine(a, b, p) {
  const v = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  return v > 1e-9 ? 1 : (v < -1e-9 ? -1 : 0);
}

/**
 * 这一笔**横切了哪几条河** —— 「交叉怪物」的结构性判据。
 *
 * 🔴 口径迭代了三次，每一次都是被判据教出来的（据实记下来，免得下一个人走回头路）：
 *    ① **只统计"与任何已有河有 ≥2 交点"** → 把**搭桥、正当交汇**也拒了
 *       （test_95 立刻红：一笔普通的新河恰好斜穿两条已有河）。
 *    ② 收紧成"**同一条河**上 ≥2 交点" → 还是把"穿过两条河各一次"误当成怪物
 *       （test_95 依然红：draft 的两段各穿第一条河一次 = 同一条河 2 个交点）。
 *    ③ 现在按**形状**判（这才是用户说的"交叉怪物"）：一笔从河的一侧出去、**又绕回同一侧**，
 *       于是同一条河被穿过 ≥2 次。判据 = 交点 ≥2 **且** 笔迹首尾在该河同侧
 *       （真的"穿过去"首尾必然异侧）。
 *    ⚠️ 代价（据实说）：首尾同侧的"来回穿两次"才拦；一笔横穿好几条不同的河不拦
 *       （那是正当交汇，用户可用 Ctrl+Z）。
 */
function countCrossingsWithExisting(draft, minPerRiver = 2) {
  const P = Array.isArray(draft) ? draft : [];
  let total = 0;
  let worst = 0;
  if (P.length < 2) return { total, worst };
  const head = P[0], tail = P[P.length - 1];
  for (const r of handDrawnRivers()) {
    const n = countPolylineCrossings(P, r && r.points);
    if (n < minPerRiver) continue;
    const ref = riverSideRef(r && r.points);
    if (!ref) continue;
    const s0 = sideOfLine(ref.a, ref.b, head);
    const s1 = sideOfLine(ref.a, ref.b, tail);
    if (s0 === 0 || s1 === 0) continue;      // 有一端就落在河上 → 那是"接在上面"，不是横切
    if (s0 !== s1) continue;                  // 首尾异侧 = 真的穿过去了（回去查是桥/交汇）
    total += n;
    if (n > worst) worst = n;
  }
  return { total, worst };
}

/** 命中**选中那条河**的第几个节点（-1 = 没中） */
function hitRiverNodeIndex(wx, wy) {
  const r = selectedRiver.value;
  if (!r) return -1;
  // ⚠️ 底图河的节点数组字段是 **`points`**（`addBaseMapRiver` / `normalizeBaseMapRivers`
  //    与 `drawRiverPaths` 全都读它）。行星图那边叫 `nodes` —— 别顺手写错，
  //    写错的后果是"能选中但拖不动"（`r.nodes` 恒 undefined）。
  const nodes = r.points || [];
  if (nodes.length < 2) return -1;
  return findRiverPointIndex(nodes, wx, wy, px(RIVER_HIT_PX));
}

/** 拖动中：**只动拖动草稿**（`riverDrag.points`），松手才一条提交。
 *
 * 🔴 为什么不用"就地改 `selectedRiver.points[i]`"（2026-10-17，实测踩到）：
 *    看着更省，但拖动期间读到的那条河**不保证是 store 里那条对象** ——
 *    本仓在项目↔画布接线上踩过同款（按引用持有的当前节点会脱钩）。
 *    症状是"按住节点拖，松手后坐标没变"（日志里 `commit changed=true`，
 *    而 store 里的点纹丝不动）。改成**显式草稿**之后，"画什么"与"存什么"
 *    各有唯一来源，也不再依赖对象身份。与同文件顶点拖动的 `dragPreview` 同款。
 */
function moveRiverNodeTo(world) {
  const drag = riverDrag.value;
  const r = selectedRiver.value;
  if (!drag || !r || drag.riverId !== r.id) return;
  if (!drag.points || !drag.points[drag.index]) return;
  drag.points[drag.index] = { x: world.x, y: world.y };
  // 拖节点是高频手势 → 帧合并；松手时 `commitRiverDrag` 会用同步 `render()` 收口
  renderCoalesced();
}

/** 拖动期间**画的是草稿**（含正在拖的那个点）；没在拖就画 store 里的真值 */
function riverNodesForRender(r) {
  const drag = riverDrag.value;
  if (drag && r && drag.riverId === r.id && drag.points) return drag.points;
  return (r && r.points) || [];
}

/** 松手：一条 undo 提交（草稿 != 按下那一刻的快照才写） */
// commitRiverDrag 已搬到 riverOps.js（2026-10-31）


/**
 * 删掉选中河流的一个节点（`Del` / `Backspace`；只剩 2 点时明确拒绝，不静默）。
 * 删完重新平滑一次 —— 少了拐点之后原来的弧线要跟着收（与"画完一次就平滑"同一口径）。
 */
/**
 * 从「已选中河流」那一行切进河流工具（2026-10-17 第八修·再修）。
 *
 * 为什么要这个按钮：`Delete` 能删整条河，但**改节点**必须在河流工具里。
 * 用户在「选择」工具里点中一条河之后，如果只给"删除"，他能做的就只有删 ——
 * 而"这条河的弯不对，我要调一下"是最常见的诉求。所以给一个**一步到位**的入口
 * （与「选中后按 Delete」互补，不是替代）。
 */
function enterRiverToolForSelected() {
  if (!selectedRiver.value) { statusMsg('没有选中的河流'); return; }
  setTool('river');
  statusMsg(`已切到河流工具：鼠标移到节点上拖动可微调，点河身加拐点，Delete 删节点`);
  render();
}

/**
 * 删掉选中河流的一个节点（`Del` / `Backspace`；只剩 2 点时明确拒绝，不静默）。
 * 删完重新平滑一次 —— 少了拐点之后原来的弧线要跟着收（与"画完一次就平滑"同一口径）。
 */
// removeSelectedRiverNode 已搬到 misc.js（2026-10-31）


/** 删除选中的整条河（`Delete` 空手 / 面板按钮） */
// deleteSelectedRiver 已搬到 riverOps.js（2026-10-31）


/**
 * 把选中的河**裁到海岸线**（用户点名要过的按钮；2026-10-17 第五轮）。
 *
 * 为什么是按钮不是自动：有人**就是要**画进海里做三角洲/河口（他明确说过）。
 * 所以只在他按下时裁，且一条撤销可撤回。
 *
 * 口径与"自动河/导入河裁海岸线"**完全同一份**：
 *   · 陆地判定 = `makeRiverLandCheck(landMaskFor(terrain))`（省份掩膜独占，第五修的结论）
 *   · 裁剪算法 = `clipPolylineToCoast`（与导入河同一条）
 * 这里**不另写**一套 —— 本项目反复踩"同一个能力两份实现，改一处另一处不变"。
 */
// clipSelectedRiversToCoast 已搬到 rivers.js（2026-10-31）


// handleSplitClick 已搬到 provinceOps.js（2026-10-31）


// handleMergeClick 已搬到 province.js（2026-10-31）


// ═══════════════════════════════════════════
// A 折线切割（画一条折线把省切成两块）
// ═══════════════════════════════════════════

function clearPolySplit() {
  polySplitPoints.value = [];
  polySplitHover.value = null;
  polySplitPreview.value = null;
  if (polySplitPreviewTimer) { clearTimeout(polySplitPreviewTimer); polySplitPreviewTimer = null; }
  render();
}

/**
 * 折线预览**防抖**：一次布尔（10525 点的省 ≈ 20ms ×2）不能挂在 mousemove 上。
 * 只在「点了一个点」之后算一次 —— 拖橡皮筋那段不需要重新切。
 */
function schedulePolySplitPreview() {
  if (polySplitPreviewTimer) clearTimeout(polySplitPreviewTimer);
  polySplitPreviewTimer = setTimeout(() => {
    polySplitPreviewTimer = null;
    const target = polySplitTarget.value;
    const pts = polySplitPoints.value;
    polySplitPreview.value = (target && pts.length >= 2)
      ? store.previewSplitAlong(baseMapKey.value, target.id, pts)
      : null;
    render();
  }, 30);
}

function onPolySplitClick(world) {
  if (store.isReadOnly) { statusMsg(`折线切割已停用：${store.readOnlyReason}`); return; }
  polySplitPoints.value = [...polySplitPoints.value, { x: world.x, y: world.y }];
  const n = polySplitPoints.value.length;
  if (n === 1) {
    const t = polySplitTarget.value;
    statusMsg(t
      ? `折线切割：起点在「${t.name || t.id}」上 —— 继续点，沿想要的边界走；双击 / Enter 切开`
      : '折线切割：起点不在任何省份上 —— 继续画，折线穿过哪个省就切哪个');
  } else {
    statusMsg(`折线切割：已点 ${n} 个点 —— 双击 / Enter 切开，Esc 取消`);
  }
  schedulePolySplitPreview();
  render();
}

// finishPolySplit 已搬到 province.js（2026-10-31）


// ═══════════════════════════════════════════
// B 批量铺底（Voronoi 一次切出 N 块）
// ═══════════════════════════════════════════

function batchOpts() {
  return {
    provinceIds: batchScope.value === 'selection' ? selectedProvinceIds.value.slice() : null,
    count: Math.max(2, Math.round(batchCount.value || 400)),
    seed: batchSeedValue.value,
    jitter: batchJitter.value,
  };
}

// autoSeedBatch 已搬到 helpers.js（2026-10-31）


function rerollBatchSeed() {
  batchSeedValue.value = (batchSeedValue.value || 1) + 1;
  autoSeedBatch();
}

function clearBatchSeeds() {
  batchSeeds.value = [];
  batchStatus.value = '种子已清空 —— 可以在画布上手动点几下放种子，或「自动播种」';
  render();
}

// onBatchSeedClick 已搬到 riverOps.js（2026-10-31）


async function runBatchSubdivide() {
  if (batchBusy.value) return;
  if (store.isReadOnly) { statusMsg(`批量铺底已停用：${store.readOnlyReason}`); return; }
  const o = batchOpts();
  const seeds = batchSeeds.value.slice();
  if (!seeds.length) { statusMsg('批量铺底：先「自动播种」或在画布上点几个种子点'); return; }
  const inside = batchPreviewInside.value.filter(Boolean).length;
  if (!confirm(`批量铺底：在 ${o.provinceIds ? o.provinceIds.length + ' 个选中的省' : '全部陆地'}范围内，`
    + `用 ${seeds.length} 个种子点切分（其中 ${seeds.length - inside} 个落在范围外会被忽略）。\n\n`
    + '· 范围内的旧省份会被替换成新块（归属 / 易主记录自动继承给新块）\n'
    + '· 海岸线不会被动到（每块都与陆地边界精确求交）\n'
    + '· 一整批只算一次撤销，Ctrl+Z 可整批撤回\n'
    + '· 过程中画布会短暂不响应（正在算几何），可以点「取消切分」放弃这一批 —— 不改动任何数据\n\n继续？')) {
    statusMsg('批量铺底：已取消');
    return;
  }
  batchBusy.value = true;
  batchStatus.value = '正在切分…';
  // C（2026-10-11）：取消令牌 —— 组件与 store 之间只传一个 `{cancelled}`，store 在每个让出点
  // （rAF 帧）检查一次；取消时 store **不落库、不压 undo**，所以"取消"是真正无副作用的。
  const token = { cancelled: false };
  batchCancelToken = token;
  try {
    const r = await store.batchSubdivide(baseMapKey.value, {
      ...o, sites: seeds, token,
      onProgress: (pr) => { batchStatus.value = pr.message || pr.phase; },
    });
    if (!r || r.ok === false) {
      const wasCancelled = !!(r && r.rejected === 'cancelled');
      batchStatus.value = (r && r.message) || '切分失败';
      statusMsg(wasCancelled ? `批量铺底：${batchStatus.value}` : `批量铺底失败：${batchStatus.value}`);
    } else {
      const pct = r.coverage != null ? Math.round(r.coverage * 100) : null;
      batchStatus.value = `已切出 ${r.created} 块（替换 ${r.removed} 省，用时 ${(r.elapsedMs / 1000).toFixed(1)}s`
        + `${pct != null ? `，覆盖 ${pct}%` : ''}${r.failed ? `，失败 ${r.failed} 块` : ''}）`;
      statusMsg(`批量铺底完成：${r.created} 块省份（替换了 ${r.removed} 个省；归属迁移 ${r.ownershipMigrated} 个剧本；`
        + `${r.clipped} 块贴海岸、${r.inner} 块在内陆${r.snapped ? `、${r.snapped} 块走了坐标吸附兜底` : ''}）`
        + ' —— 一次 Ctrl+Z 可整批撤回');
      batchSeeds.value = [];
      selectedProvince.value = null;
      showProps.value = false;
    }
  } catch (err) {
    batchStatus.value = `切分异常：${(err && err.message) || err}`;
    statusMsg(`批量铺底异常：${(err && err.message) || err}`);
  } finally {
    batchBusy.value = false;
    batchCancelToken = null;
    provinceBrush.invalidateBorders();
    render();
  }
}

/** C：取消这一批切分（store 在下一个帧让出点返回 `rejected:'cancelled'`，数据一行不改） */
function cancelBatchSubdivide() {
  if (!batchBusy.value) { statusMsg('批量铺底：当前没有在跑的切分'); return; }
  if (batchCancelToken) batchCancelToken.cancelled = true;
  batchStatus.value = '正在取消…（等当前这一块算完；不会写入任何数据）';
  statusMsg('批量铺底：已请求取消 —— 省界与归属都不会改变');
}

// ═══════════════════════════════════════════
// 右键菜单
// ═══════════════════════════════════════════
async function ctxRenameProvince() {
  const name = await askText({ title: '省份名称', defaultValue: selectedProvince.value?.name || '' });
  if (name && selectedProvince.value) {
    // 不要再写 `selectedProvince.value.name = name`（直改 store 活对象 → 绕守卫 + 撤销空转）
    const v = String(name).trim();
    if (!v) { statusMsg('省份名不能为空'); contextMenu.value.show = false; return; }
    provinceWrite({ name: v }, `省份已改名：${v}`);
  }
  contextMenu.value.show = false;
}

async function ctxChangeBiome() {
  const biomes = Object.keys(BIOME_COLORS);
  const biome = await askText({ title: `生物群系（${biomes.join('/')}）`, defaultValue: selectedProvince.value?.biome || '' });
  if (biome && selectedProvince.value) {
    provinceWrite({ biome });
  }
  contextMenu.value.show = false;
}

// ctxDuplicateProvince 已搬到 provinceOps.js（2026-10-31）


// ctxDeleteProvince 已搬到 misc.js（2026-10-31）


/** 右键菜单 → 打开省份详情（右上角属性面板），并选中它 */
function ctxOpenProvinceProps() {
  const prov = contextMenuProvince.value;
  contextMenu.value.show = false;
  if (!prov) return;
  selectedProvince.value = prov;
  showProps.value = true;
  render();
}

/**
 * 属性面板里「设为当前势力 / 清成无主」—— 与油漆桶同一套 store 写口（一条 undo）。
 * 日期一律用 `tlDate`（时间轴游标 = 唯一真源），这样「看到哪年就改哪年」。
 *
 * ⚠️ 清空归属**不等于**抹掉历史：带日期的 `clearOwnership` 会在该日期写一条
 *    `owner: null` 事件（时间轴上就是「这一年这块地变成无主」），只把 `ownership`
 *    这个"终态快照键"删掉。所以文案不能说"连带删除易主事件"（2026-10-21 核对实现后改口）。
 */
function assignSelectedProvinceOwner() {
  const prov = selectedProvince.value;
  const sc = selectedScenario.value;
  if (!prov || !sc) return;
  if (prov.kind === 'sea') { statusMsg('这是海域（kind=sea）：海域不参与势力归属'); return; }
  if (!selectedPolity.value) { statusMsg('先在色板选一个势力，再点「设为当前势力」'); return; }
  if (store.isReadOnly) { statusMsg(`改归属已停用：${store.readOnlyReason || '只读：未打开项目'}`); return; }
  const wr = store.setOwnership(sc.id, prov.id, selectedPolity.value.id, tlDate.value);
  statusMsg(wr && wr.success === false
    ? `「${prov.name}」归属已改，但易主日期没记：${wr.reason}`
    : `「${prov.name}」→ ${selectedPolity.value.name}（${tlDateText.value}，可 Ctrl+Z 撤回）`);
  render();
}

function clearSelectedProvinceOwner() {
  const prov = selectedProvince.value;
  const sc = selectedScenario.value;
  if (!prov || !sc) return;
  if (store.isReadOnly) { statusMsg(`改归属已停用：${store.readOnlyReason || '只读：未打开项目'}`); return; }
  store.clearOwnership(sc.id, prov.id, tlDate.value);
  statusMsg(`已清除「${prov.name}」的势力归属 → 无主（${tlDateText.value} 起；可 Ctrl+Z 撤回）`);
  render();
}

// ── 省份属性面板的写入口（2026-10-01 重写）──────────────────────────────────
// 旧实现在模板上用 `v-model` 直改 store 里的活对象，再调 `updateBaseProvince`：
// 撤销拿到的"旧值"其实已经是新值（空转），且只读态绕开守卫照改内存。
// 现在一律：**值来自事件 → 写只走 store**（一条 undo + 写闸门），并给只读态回音。
function provinceWrite(updates, okText) {
  const prov = selectedProvince.value;
  if (!prov) return;
  if (store.isReadOnly) { statusMsg(`编辑省份已停用：${store.readOnlyReason || '只读：未打开项目'}`); return; }
  store.updateBaseProvince(baseMapKey.value, prov.id, updates);
  if (okText) statusMsg(okText);
  render();
}

function onProvinceNameChange(e) {
  const prov = selectedProvince.value;
  if (!prov) return;
  const v = String(e.target.value || '').trim();
  if (!v) { e.target.value = prov.name || ''; statusMsg('省份名不能为空'); return; }
  provinceWrite({ name: v }, `省份已改名：${v}`);
}

function onProvinceBiomeChange(e) {
  provinceWrite({ biome: String(e.target.value || '') });
}

function onProvinceCultureChange(e) {
  provinceWrite({ culture: String(e.target.value || '') });
}

function onProvinceKindChange(e) {
  const kind = e.target.value === 'sea' ? 'sea' : 'land';
  const prov = selectedProvince.value;
  if (!prov) return;
  if (store.isReadOnly) { statusMsg(`编辑省份已停用：${store.readOnlyReason || '只读：未打开项目'}`); return; }
  store.updateBaseProvince(baseMapKey.value, prov.id, { kind });
  provinceBrush.invalidateBorders();
  statusMsg(kind === 'sea' ? '已改为海域（不参与势力归属）' : '已改为陆地');
  render();
}

/** 活动环的顶点数（属性面板显示；顶点编辑只作用于活动环） */
const currentRingVertexCount = computed(() => {
  const prov = currentProvince();
  const pts = prov ? ringPointsOf(prov) : null;
  return pts ? pts.length : 0;
});

function onProvinceCoastChange(e) {
  provinceWrite({ coast: !!e.target.checked });
}

// ═══════════════════════════════════════════
// 几何工具
// ═══════════════════════════════════════════
/**
 * 命中测试：**自顶向下**（数组末尾 = 画得最上面）。
 *
 * 🔴 2026-10-02 修正：此前是正序遍历「第一个命中就返回」，而 `drawProvinces` 是正序 fill
 * （数组靠后的盖在上面）→ 两个省压叠时点中的是**视觉上被压在下面**的那个（越叠越明显）。
 * 两者口径必须相反才自洽：画 = 后面的在上，命中 = 从后面往前找。
 * 新省创建侧另有压叠闸门（`utils/provinceOverlap.js`），这条是「已经压叠了也要点得准」。
 *
 * 🔴 2026-10-23（第 1 件 1-a）：实现换成**空间索引**，语义逐字节不变（候选按原下标降序、
 *    洞点不中、飞地点得中）。旧实现在真实 200 省底图上 20.4ms/次，涂归属每次 mousemove
 *    要查 5 个偏移 = 96.9ms；换索引后是"格子里的 1~3 个省"。
 *    索引按 `terrain` 引用缓存（本仓每次几何写入都换新数组 → 引用变即重建，零手工失效点）。
 */
const provinceHitCache = createProvinceHitCache();
function findProvinceAt(x, y) {
  const terrain = baseMap.value?.terrain;
  if (!terrain) return null;
  return hitProvince(provinceHitCache.get(terrain), x, y);
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
  render();
}

/**
 * 🔴 2026-10-17：`.map` 的「文件名 → 底图名」与「原文留底」搬到
 * `utils/mapImportSource.js` —— 行星视图（`PlanetMap`）现在也能导入 `.map`，
 * 两处各写一份的代价不是报错，而是「只有一边留了原文 / 只有一边剥掉日期后缀」这种静默不一致。
 * 详见该文件头部说明。
 */

// ── 从留底恢复（2026-10-13）────────────────────────────────────────────────
// 留底从 0.2.8 起就一直在写，但**只有"列清单"没有入口** —— 用户在界面上根本够不着，
// 那批 `.map` 等于不存在（只能自己去资源管理器翻目录）。**备份读不回来就不算备份。**
const sourceRestoreOpen = ref(false);
const sourceRestoreFiles = ref([]);
const sourceRestoreDir = ref('');
const sourceRestoreLoading = ref(false);
const sourceRestoreBusy = ref(false);
const sourceRestoreMsg = ref('');

function fmtSrcBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1048576) return `${(b / 1048576).toFixed(1)}MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)}KB`;
  return `${b}B`;
}

function fmtSrcTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 打开留底清单（**只读**：只问项目路径与文件名清单，不动任何世界观数据） */
async function openSourceRestore() {
  sourceRestoreOpen.value = true;
  sourceRestoreMsg.value = '';
  sourceRestoreFiles.value = [];
  sourceRestoreDir.value = '';
  sourceRestoreLoading.value = true;
  try {
    const api = window.sitianAPI;
    if (!api?.listBaseMapSources || !api?.projectCurrentPath) {
      sourceRestoreMsg.value = '这个运行环境读不到留底（缺少 IPC）';
      return;
    }
    const cur = await api.projectCurrentPath();
    const projectPath = (cur && cur.success && cur.filePath) || '';
    if (!projectPath) {
      // 留底与项目文件放在一起 —— 没有已落盘的项目就没有留底目录
      sourceRestoreMsg.value = '当前没有已落盘的项目文件 —— 留底与项目放在一起，所以现在读不到';
      return;
    }
    const r = await api.listBaseMapSources({ projectPath });
    if (!r || r.success === false) {
      sourceRestoreMsg.value = `读清单失败：${(r && r.error) || '未知原因'}`;
      return;
    }
    sourceRestoreFiles.value = Array.isArray(r.files) ? r.files : [];
    sourceRestoreDir.value = r.dir || '';
  } catch (e) {
    sourceRestoreMsg.value = `读清单失败：${e.message}`;
  } finally {
    sourceRestoreLoading.value = false;
  }
}

/**
 * 用某一份留底走一遍导入链。
 * 🔴 **不重复留底**（`__fromBackup`）：这一份本身就是留底，再写一份只会多占轮转位、
 *    把更早的版本挤掉。其余行为与"选文件导入"完全同一条链（同名底图只补缺）。
 */
async function restoreFromSource(f) {
  if (sourceRestoreBusy.value) return;
  if (store.isReadOnly) {
    sourceRestoreMsg.value = `只读：${store.readOnlyReason || '未打开项目'}`;
    return;
  }
  sourceRestoreBusy.value = true;
  sourceRestoreMsg.value = `正在读回 ${f.name}…`;
  try {
    const api = window.sitianAPI;
    const cur = await api.projectCurrentPath();
    const projectPath = (cur && cur.success && cur.filePath) || '';
    const r = await api.readBaseMapSource({ projectPath, name: f.name });
    if (!r || r.success === false) {
      sourceRestoreMsg.value = `读回失败：${(r && r.error) || '未知原因'}`;
      return;
    }
    // 导入链里可能弹确认框：先放开按钮，免得看着像卡死
    sourceRestoreBusy.value = false;
    await triggerMapImport({
      source: { name: r.name, text: async () => r.text, __fromBackup: true },
    });
    sourceRestoreMsg.value = `已按留底「${r.name}」（${fmtSrcBytes(r.bytes)}）走完导入链 —— `
      + '同名底图只补缺，你已切好的省份与归属不会被覆盖；详细结果见底部状态栏';
  } catch (e) {
    sourceRestoreMsg.value = `恢复失败：${e.message}`;
  } finally {
    sourceRestoreBusy.value = false;
  }
}

/**
 * 019 重导对话框（2026-10-25）：先把映射统计/冲突摆出来，再让用户点「重导并迁移」。
 * 预览走 `store.previewReimportBasemap`（只读），真正写盘在 `applyReimportDialog`。
 */
function openReimportDialog(oldKey, bundle, fileName = '') {
  const preview = store.previewReimportBasemap(oldKey, bundle);
  if (!preview || !preview.ok) {
    statusMsg(`重导预检失败：${(preview && preview.message) || '未知原因'}`);
    return;
  }
  pendingReimportBundle = bundle;
  reimportDialog.value = {
    oldKey,
    fileName,
    preview,
    copyReferenceImages: false,
  };
}

function closeReimportDialog() {
  reimportDialog.value = null;
  pendingReimportBundle = null;
}

// applyReimportDialog 已搬到 helpers.js（2026-10-31）


async function triggerMapImport(opts = {}) {
  const refreshOnly = !!(opts && opts.refreshOnly);
  // 🔴 2026-10-13：「拿到一份 .map 之后」的处理体 = **唯一实现**，两条入口共用 ——
  //    ① 用户选文件（下面建 input）；② 「从留底恢复」（`opts.source` = basemap-sources 里的原文）。
  //    刻意不另写一条导入链：两条入口一旦分叉，「只有一条会留底 / 只有一条会补缺」
  //    这类静默不一致迟早发生（本仓已踩过多次"两份实现"）。
  const handle = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      // 先留底（在任何解析/写入之前）—— 解析失败也该留下这份素材。
      // ⚠️ 「从留底恢复」进来的这一份**不再留底**：它本身就是那份留底，
      //    再写一份只会多占一个轮转位（`name-2.map`）、把更早的版本挤掉。
      const srcNote = file.__fromBackup
        ? '（用的就是项目备份目录里的留底，未重复留底）'
        : await backupMapSourceFile(file.name, text);
      const parsed = parseMapFile(text);
      const name = mapNameFromFileName(file.name);
      const json = buildScenariosJson(parsed, name, '当前');
      const bundle = json.baseMaps?.[name];

      // ── 已有同名底图：**只补数据，绝不覆盖**（B2，2026-10-11）─────────────────
      // 🔴 为什么必须分这条路：`importFromScenariosJson` 的合并语义是「同 key 整体替换」
      //     —— 拿它去"补高度图"会把用户已切好的几百块省份、归属、易主记录一起盖掉。
      //     真实场景：`desite` 底图现在有 415 块省份，而它建图时（2026-09-10）解析器
      //     还读不出高度图/河流/道路 → 用户需要的是"给这张图补上"，不是"重画一张"。
      if (bundle && store.baseMaps?.[name]) {
        const existing = store.baseMaps[name];
        // 019（2026-10-25）：同名底图分两条路 ——
        //   · 一笔未改（指纹 == 导入时指纹）→ 只补缺（旧行为，安全）；
        //   · 改过一笔（或旧数据没有指纹）→ **不能再只补数据**：新底图 + 旧归属迁移。
        // 旧行为会把"改过的底图"当成同一张图补数据；用户明确说过：动过一笔就不是一个东西了。
        if (!isBasemapPristine(existing)) {
          // 「刷新底图数据」入口只给未改过的底图补缺；改过的底图必须走「+ 导入」重导，
          // 否则用户点刷新却被弹重导对话框，按钮语义就错了。
          if (refreshOnly) {
            statusMsg(`「${name}」这张底图改过，不能只补数据；要换新 .map 请用「+ 导入 .map 底图」重导（会迁移旧归属）。刷新入口只给一笔未改的底图补缺。`);
            return;
          }
          // 不直接写：先开重导对话框，把映射统计/冲突摆出来（019）
          openReimportDialog(name, bundle, file.name);
          return;
        }

        const srcStats = parsed.stats || {};
        const missing = describeBaseMapMissing(store.baseMaps[name], bundle);
        if (!missing.length) {
          statusMsg(`「${name}」的底图数据已经齐了（高度图 / 河流 / 道路 / 城镇都有），无需刷新`);
          return;
        }
        if (!confirm(`「${name}」这张底图已经存在了。\n\n`
          + `可以把它缺的底图级数据补上：${missing.join(' / ')}\n`
          + `文件里带着：${srcStats.cells || 0} 格高度、${srcStats.rivers || 0} 条河流、`
          + `${srcStats.routes || 0} 条道路、${srcStats.burgs || 0} 个城镇。\n\n`
          + `· 你已切好的 ${(store.baseMaps[name].terrain || []).length} 块省份边界、归属与易主记录**一个字都不会动**\n`
          + `· 这张底图**已经有的**数据不会被覆盖（只补缺）\n`
          + `· 一整次刷新 = 一条 Ctrl+Z\n\n继续刷新？`)) {
          statusMsg('刷新底图数据：已取消（底图与省份均未改动）');
          return;
        }
        const r = store.updateBaseMapData(name, bundle);
        if (r && r.ok && r.changed) {
          statusMsg(`已刷新底图数据：${r.message}`
            + (r.blocked?.length ? ` ⚠️ ${r.blocked.map(b => b.message).join(' ')}` : '')
            + srcNote
            + '（可用 Ctrl+Z 撤回）');
          baseMapKey.value = name;
          // 刷新后画布上要能立刻看见：默认切到「地形高度」档（高度图刚到，用户就是为它来的）
          if (r.added.heightmap) rasterLayer.value = 'height';
          render();
        } else {
          statusMsg(`刷新底图数据：${(r && r.message) || '没有可补的数据'}`);
        }
        return;
      }

      if (refreshOnly && !store.baseMaps?.[name]) {
        // 走「刷新」入口却选了一个新名字的底图 → 不能悄悄新建（那会多出一张空底图）
        if (!confirm(`这张底图（${name}）还不存在。「刷新」只给已有底图补数据，不会新建底图。\n\n`
          + '改成「导入为新底图」？')) {
          statusMsg('刷新底图数据：已取消（没有新建底图）');
          return;
        }
      }

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

      // 🔴 导入结果必须**当场说清**（B2 的"明确可诊断"，2026-10-11）：
      //    解析器早就把「未解析到 cells.h（高度图不可用）」这类问题收进 `warnings` 了，
      //    但导入路径一个字都不报 —— 用户只会看到"地图是纯色扁平的"，
      //    然后去找一个根本不存在的显示开关。这就是他这次的实际经历。
      const newBm = store.baseMaps?.[name];
      const srcBundle = json.baseMaps?.[name];
      const missing = newBm ? describeBaseMapMissing(newBm, srcBundle) : [];
      const warns = parsed.warnings || [];
      // 「源文件里压根没有高度图」是另一回事（不是"这张底图缺"，而是"这份 .map 没带"）——
      // 两种都要说，而且要说成不同的话，否则用户会以为"刷新一下就有了"。
      const srcHasTerrain = Array.isArray(srcBundle?.heightmap?.h) && srcBundle.heightmap.h.length > 0;
      const parts = [`已导入「${name}」：省份 ${(newBm?.terrain || []).length} 块`];
      if (srcHasTerrain) parts.push('高度图 有');
      parts.push(`河流 ${(newBm?.rivers || []).length} 条`, `道路 ${(newBm?.routes || []).length} 条`);
      if (!srcHasTerrain) {
        parts.push('地形高度图 ⚠️ **这份 .map 里就没有**（导出时未包含 cells.h）'
          + ' —— 所以地图会是纯色扁平图，这不是显示开关的问题');
      }
      if (missing.length) {
        parts.push(`这张底图还缺：${missing.join(' / ')} —— 可用工具栏「刷新底图数据」从另一份 .map 补`);
      }
      if (warns.length) parts.push(`解析提示（${warns.length} 条）：${warns.slice(0, 2).join('；')}`);
      // 「原始 .map 已留底 / 留底失败」并入同一句回执（备份失败也要看得见，不能静默）
      statusMsg(parts.join('、').replace(/、地形高度图/, '；地形高度图') + srcNote);
    } catch (err) {
      alert('导入失败: ' + err.message);
    }
  };
  // 「从留底恢复」：把留底原文按 `{ name, text() }` 的形状喂进同一条链（不经过文件选择器）
  if (opts.source) return handle(opts.source);
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.map';
  input.onchange = (e) => handle(e.target.files[0]);
  input.click();
}

/**
 * 底图级"缺什么"清单（渲染/提示共用；判定口径与 store 的 `updateBaseMapData` 一致）。
 * ⚠️ 绑定了行星的底图**不算缺高度图** —— 那时高度图的家在行星侧，底图侧本来就不该有。
 */
function describeBaseMapMissing(bm, bundle) {
  if (!bm) return [];
  const missing = [];
  const bound = store.getBoundPlanetId ? store.getBoundPlanetId(bm.id) : (bm.planetId || null);
  // ⚠️ 判"这张底图有没有地形"必须用**地形内容**口径（`hasHeightmapContent`），不能只看
  //    `heightmap` 这个键在不在、也不能用 `hasGrid`（后者是"能否开始用笔刷编辑"，
  //    会放过"有点、无 h"的空壳 —— 那正是把纯色图报成"有地形"的原因；test_96 守）。
  const bundleHasTerrain = hasHeightmapContent(bundle?.heightmap);
  if (bundleHasTerrain && !hasHeightmapContent(bm.heightmap) && !bound) missing.push('地形高度图');
  if ((bundle?.rivers || []).length && !(bm.rivers || []).length) missing.push('河流');
  if ((bundle?.routes || []).length && !(bm.routes || []).length) missing.push('道路');
  if ((bundle?.burgs || []).length && !(bm.burgs || []).length) missing.push('城镇');
  return missing;
}

/**
 * F（0.2.6）：用新 .map 的海岸线重建省份外环。
 *
 * 数据来源两条路：① 这张底图里已经存了 `landFeatures`（导入 .map 时 parser 带进来的）→ 直接用；
 * ② 没有（老底图）→ 让用户选一份 .map，**只借它的海岸线**，不动省份与归属。
 * 落库只在 store（`rebuildCoastline`）—— 几何与闸门单源，组件只负责问人与翻译结果。
 */
async function triggerCoastlineRebuild() {
  if (store.isReadOnly) { statusMsg(`重建海岸线已停用：${store.readOnlyReason}`); return; }
  if (!(baseMap.value?.terrain || []).length) { statusMsg('重建海岸线：这张底图还没有省份'); return; }
  const stored = (baseMap.value?.landFeatures || []);
  const runWith = async (features, srcLabel) => {
    const before = (baseMap.value?.terrain || []).length;
    const r = await store.rebuildCoastline(baseMapKey.value, features, {
      token: batchCancelToken || undefined,
    });
    provinceBrush.invalidateBorders();
    if (!r || r.ok === false) {
      statusMsg(`重建海岸线：${(r && r.message) || '失败'}（省份 ${
        (baseMap.value?.terrain || []).length} 块一字未动）`);
      render();
      return;
    }
    if (!r.changed) { statusMsg(`重建海岸线：${r.message}`); render(); return; }
    const worst = (r.detail || []).slice(0, 3)
      .map((d) => `${d.name || d.id}${d.removed ? '（被清空）' : ` ${d.delta >= 0 ? '+' : ''}${Math.round(d.delta)}`}`)
      .join('、');
    statusMsg(`重建海岸线完成（来源：${srcLabel}）：省份 ${before} 块不变，`
      + `改了 ${r.changed} 个省的边界${worst ? `（变化最大：${worst}）` : ''}`
      + `${r.skippedInside ? `；${r.skippedInside} 个内陆省逐点未动` : ''}`
      + `；面积 ${r.drift >= 0 ? '+' : ''}${(r.drift * 100).toFixed(2)}% —— 一整次 = 一条撤销`);
    render();
  };

  if (stored.length) {
    const totalPts = stored.reduce((n, f) => n + ((f.points || []).length), 0);
    if (!confirm(`用这张底图里已存的陆地轮廓重建省份外环？\n\n`
      + `· 陆地轮廓：${stored.length} 块 / 合计 ${totalPts} 点\n`
      + `· 做法：每个省 = 省 ∩ 新陆地 —— **只换海岸那一段**\n`
      + `· 内陆省逐点不动；相邻省仍无缝；海岸线换成新数据的原顶点\n`
      + `· 一整次 = 一条 Ctrl+Z；面积漂移过大（多半选错图）会被拒绝\n\n继续？`)) {
      statusMsg('重建海岸线：已取消');
      return;
    }
    await runWith(stored, '底图内已存的海岸线');
    return;
  }

  // 老底图：让用户选一份 .map，只借它的海岸线
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.map';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseMapFile(text);
      const feats = parsed.landFeatures || [];
      if (!feats.length) {
        statusMsg('重建海岸线：这份 .map 里没有陆地轮廓（生成器导出时海岸线图层可能是空的）—— 数据未改动');
        return;
      }
      const totalPts = feats.reduce((n, f) => n + ((f.points || []).length), 0);
      if (!confirm(`用「${file.name}」的海岸线重建省份外环？\n\n`
        + `· 这份文件里的陆地轮廓：${feats.length} 块 / 合计 ${totalPts} 点\n`
        + `· **只借它的海岸线** —— 省份、归属、易主记录都不作废\n`
        + `· 做法：每个省 = 省 ∩ 新陆地；内陆省逐点不动、相邻省仍无缝\n`
        + `· 一整次 = 一条 Ctrl+Z；面积漂移过大（多半选错图）会被拒绝\n\n继续？`)) {
        statusMsg('重建海岸线：已取消（数据未改动）');
        return;
      }
      await runWith(feats, file.name);
    } catch (err) {
      alert('重建海岸线失败: ' + err.message);
    }
  };
  input.click();
}

/** 当前底图里有没有**陆地轮廓**（海岸线数据）—— 决定重建按钮走"直接用"还是"先选 .map" */
const baseMapHasLandFeatures = computed(() => ((baseMap.value?.landFeatures) || []).length > 0);

/** 当前底图还缺哪些底图级数据（没缺 → 刷新按钮不出现） */const basemapDataMissing = computed(() => {
  const bm = baseMap.value;
  if (!bm) return [];
  const out = [];
  const bound = baseMapBoundPlanet.value;
  // 与 describeBaseMapMissing 同口径（`hasHeightmapContent`）：空壳高度图算"缺"
  const hasTerrain = baseMapHasTerrainContent.value;
  if (!hasTerrain && !bound) out.push('地形高度图');
  if (!(bm.rivers || []).length) out.push('河流');
  if (!(bm.routes || []).length) out.push('道路');
  return out;
});
const provinceCount = computed(() => (baseMap.value?.terrain || []).length);

function manualSave() {
  store.saveScenarios();
}

// ═══════════════════════════════════════════
// 剧本集（2026-10-25）
// ═══════════════════════════════════════════
const newGroupName = ref('');
const editingGroupId = ref('');
const editGroupName = ref('');

function createGroup() {
  if (store.isReadOnly) { statusMsg(store.readOnlyReason || '只读：未打开项目'); return; }
  const name = newGroupName.value.trim();
  if (!name) return;
  const r = store.addScenarioGroup({ name });
  if (!r || !r.success) { statusMsg(`新建剧本集失败：${(r && r.error) || '未知原因'}`); return; }
  newGroupName.value = '';
  activeGroupId.value = r.group.id;
  statusMsg(`已新建剧本集「${r.group.name}」—— 新建剧本会默认落在这一组；也可在列表里把已有剧本移进来`);
  render();
}

function startRenameGroup(g) {
  if (store.isReadOnly) { statusMsg(store.readOnlyReason || '只读：未打开项目'); return; }
  editingGroupId.value = g.id;
  editGroupName.value = g.name;
}

function cancelRenameGroup() {
  editingGroupId.value = '';
  editGroupName.value = '';
}

function commitRenameGroup() {
  const id = editingGroupId.value;
  if (!id) return;
  const name = editGroupName.value.trim();
  if (!name) return;
  const r = store.renameScenarioGroup(id, name);
  if (!r || !r.success) { statusMsg(`改名失败：${(r && r.error) || '未知原因'}`); return; }
  cancelRenameGroup();
  statusMsg(`剧本集已改名为「${name}」`);
}

function deleteGroup(g) {
  if (store.isReadOnly) { statusMsg(store.readOnlyReason || '只读：未打开项目'); return; }
  const n = groupCount(g.id);
  const r = store.removeScenarioGroup(g.id);
  if (!r || !r.success) { statusMsg(`删除失败：${(r && r.error) || '未知原因'}`); return; }
  if (activeGroupId.value === g.id) activeGroupId.value = DEFAULT_SCENARIO_GROUP;
  statusMsg(n
    ? `已删除剧本集「${g.name}」—— ${n} 条剧本退回「默认」组（一条都没删，Ctrl+Z 可撤销）`
    : `已删除空剧本集「${g.name}」（Ctrl+Z 可撤销）`);
  render();
}

function moveScenarioToGroup(s, groupId) {
  if (store.isReadOnly) { statusMsg(store.readOnlyReason || '只读：未打开项目'); return; }
  const target = String(groupId || DEFAULT_SCENARIO_GROUP);
  const r = store.setScenarioGroup(s.id, target);
  if (!r || !r.success) { statusMsg(`移动失败：${(r && r.error) || '未知原因'}`); return; }
  // 移的正好是当前在看的那条 → 跟着它切组（否则地图上还是它、左栏却没它了）
  if (selectedScenario.value?.id === s.id) {
    activeGroupId.value = target;
    selectScenarioAt(store.getScenario(s.id));
  }
  statusMsg(`「${s.name}」已移到剧本集「${groupNameOf(target)}」${r.unchanged ? '（本来就在这一组）' : ''}`);
  render();
}

// createNewScenario 已搬到 actions.js（2026-10-31）


function deleteScenario(s) {
  if (!confirm(`确定删除剧本「${s.name}」？`)) return;
  store.removeScenario(s.id);
  if (selectedScenario.value?.id === s.id) {
    selectedScenario.value = sortedScenarios.value[0] || null;
  }
  render();
}

/**
 * 清空全部剧本（2026-10-11 接活 `removeAllScenarios` 这个零调用死入口）。
 *
 * 语义边界（**必须说清**，否则用户不敢点）：只删「剧本」这一层 ——
 *   名称 / 罗马数字 / 起止年 / 势力 / `ownership` / `changeEvents` / 标注 / 标记。
 *   **底图（`baseMaps`）与省份多边形（`terrain`）一个字都不动** ——
 *   清完还能直接把省份批量铺底重切，或用「导入剧本数据」灌一份干净的进来。
 * 一条 undo：`removeAllScenarios` 里是整份 `scenarios` 的快照替换。
 */
// clearAllScenarios 已搬到 misc.js（2026-10-31）


// ═══════════════════════════════════════════
// 剧本元信息编辑（2026-10-07）
// ═══════════════════════════════════════════
// 🔴 `updateScenario` 此前是**零调用的死入口**：剧本的 名称 / 罗马数字 / 时代标签 /
//    **起止年** 建完就改不了 —— 年份填错只能「删剧本重建」，而重建会连带丢掉
//    ownership / changeEvents / 标注 / 标记（那是真丢数据）。这里复用新建表单做编辑。
const editingScenarioId = ref(null);

function scenarioFormBlank() {
  return {
    name: '', roman: '', label: '', startYear: '', endYear: '',
    description: '', hook: '', inherit: true,
    group: activeGroupId.value || DEFAULT_SCENARIO_GROUP,
  };
}

function scenarioToForm(s) {
  return {
    name: s.name || '',
    roman: s.era?.roman || '',
    label: s.era?.label || '',
    startYear: s.era?.startYear != null ? String(s.era.startYear) : '',
    endYear: s.era?.endYear != null ? String(s.era.endYear) : '',
    description: s.description || '',
    hook: s.hook || '',
    inherit: false,   // 编辑既有剧本时没有「继承上一时代」的语义
    group: scenarioGroupIdOf(s),
  };
}

function startEditScenario(s) {
  if (store.isReadOnly) { statusMsg(store.readOnlyReason || '只读：未打开项目'); return; }
  editingScenarioId.value = s.id;
  newScenario.value = scenarioToForm(s);
}

function cancelEditScenario() {
  editingScenarioId.value = null;
  newScenario.value = scenarioFormBlank();
}

function closeScenarioManager() {
  cancelEditScenario();
  showScenarioManager.value = false;
}

// 每次打开管理对话框：新建表单落到**当前剧本集**（否则在自定义组里打开，默认会建到「默认」组）
watch(showScenarioManager, (open) => {
  if (!open || editingScenarioId.value) return;
  newScenario.value = scenarioFormBlank();
});

// saveEditScenario 已搬到 actions.js（2026-10-31）


// ═══════════════════════════════════════════
// 标注 / 标记的删除（2026-10-07）
// ═══════════════════════════════════════════
// 此前 `removeScenarioLabel` / `removeScenarioMarker` 是零调用的死入口
// → 地名与标记「只能加不能删」（只有一次性的撤销兜底）。
// ⚠️ FMG `.map` 导入的标注/标记**没有 id** → 一律带上下标，交 store 按「id 或下标」解析；
//    否则 `undefined === undefined` 命中同类型第一条（点第 3 条删掉第 1 条，且不报错）。
const annoRows = computed(() => {
  const s = selectedScenario.value;
  if (!s) return [];
  const out = [];
  (s.labels || []).forEach((l, i) => {
    out.push({ kind: 'label', ref: (l && l.id != null) ? l.id : i, key: 'label_' + i, text: (l && l.text) || '（空地名）' });
  });
  (s.markers || []).forEach((m, i) => {
    out.push({ kind: 'marker', ref: (m && m.id != null) ? m.id : i, key: 'marker_' + i, text: (m && m.name) || '（未命名标记）' });
  });
  return out;
});

function deleteAnnotation(row) {
  const sid = selectedScenario.value?.id;
  if (!sid || !row) return;
  const what = row.kind === 'label' ? '地名' : '标记';
  if (!confirm(`确定删除${what}「${row.text}」？`)) return;
  const r = row.kind === 'label'
    ? store.removeScenarioLabel(sid, row.ref)
    : store.removeScenarioMarker(sid, row.ref);
  if (!r || r.ok === false) {
    statusMsg(`删除${what}失败（${(r && r.reason) || '未知原因'}）`);
    return;
  }
  statusMsg(`已删除${what}「${row.text}」（可撤销）`);
  render();
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
// withBezierControls 已搬到 riverOps.js（2026-10-31）


/**
 * 描绘闭合/开口路径：有控制点且未按 Alt 时走 bezierCurveTo，否则退化直线段。
 * 红线：渲染循环内不创建新数组——本函数只读不分配。
 */
// traceShapePath 已搬到 misc.js（2026-10-31）


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
  // 🔴 必须走 `getHeightmapFor`（A1 的**唯一**读取口），不能摸 `baseMap.heightmap`：
  //    绑定行星后底图侧那份是空的/过期的，照它画就会「涂了看不见、地形凭空没了」，
  //    而且不报错。本组件此前读的是 `baseMap.value?.heightmap`（2026-10-14 改）。
  const hm = baseMapKey.value ? store.getHeightmapFor(baseMapKey.value) : null;
  // 山体阴影（2026-10-17 第七修，用户：「地形怎么3D表现」）：默认关 = 零行为变更。
  // 只对"读地形的档"生效（`buildHeightmapRaster` 内部自己判，专题图档不会加阴影）。
  // `landAsSea`（2026-10-27）：剧本画布的「陆海底色」只当海面纸 —— 陆地由省份多边形负责，
  // 否则省份平滑后的海岸会漏出一圈块状浅米色（B1「白一块」）。
  return buildHeightmapRaster(hm, kind, {
    shade: terrainShade.value ? terrainShadeStrength.value
      : ((kind === 'satellite' || kind === 'terrain') ? 1 : 0),
    landAsSea: kind === 'landsea',
  });
}

function getRaster(kind) {  // 🔴 键里必须含**高度图对象引用**（2026-10-14）：只按 `底图键|档位` 存的话，
  //    「调整分辨率 / 平滑 / 涂抹 / 撤销」之后画布还是旧图 —— 缓存命中，什么都不重画，
  //    而且没有任何提示。`commitHeightmap` 每次都换对象 → 引用变 = 内容变。
  const hm = baseMapKey.value ? store.getHeightmapFor(baseMapKey.value) : null;
  // ⚠️ 缓存键必须含**阴影开关与强度**：否则"勾了阴影画布不变"（缓存命中）——
  //    这正是本项目反复踩的"开关改了没反应"，且不会报错。
  const key = baseMapKey.value + '|' + kind + '|sh' + (terrainShade.value ? terrainShadeStrength.value : 0);
  const hit = rasterCache.get(key);
  if (hit && hit.hm === hm) return hit.raster;
  const built = buildCellRaster(kind);
  if (built) rasterCache.set(key, { hm, raster: built });
  return built;
}

function drawRasterLayer(c, kind, alpha) {
  const r = getRaster(kind);
  if (!r) return;
  c.save();
  c.globalAlpha = alpha;
  // 平滑档（RASTER_SMOOTH，2026-10-09 反「拼豆」）：源画布是格级分辨率，靠插值放大成渐变。
  // 方块档是 1 世界单位 1 像素并 1:1 贴回，插值与否无差别。
  c.imageSmoothingEnabled = RASTER_SMOOTH;
  c.imageSmoothingQuality = 'high';
  c.drawImage(r.canvas, r.minX, r.minY, r.w, r.h);
  c.restore();
}

/**
 * 导出的地形底图快照（2026-10-27）：「导出 = 你看到的那张图」。
 *
 * 触发条件：用户的「地形表示」选的是 height / temp / prec（这三档是**地形/专题底图**，
 * 画布上省份只描边不填色，政治色块不参与）。这时导出若仍是纯政治色块，成品图与屏幕上是两张图。
 *
 * 返回 `{ kind, raster, isobaths, coasts }`：
 *   · `raster`：与画布**同一份** `getRaster()`（分带设色 + 海深渐变 + 山体阴影）的 PNG dataURL；
 *   · `isobaths` / `coasts`：等深线与海岸线（同 `getSeaDetail()` 的那份几何，导出侧画成矢量
 *     `<path>` —— 比位图清晰，也不随导出分辨率糊掉）。
 * 拿不到任何底图数据 → 返回 null（调用方退回原来的政治图）。
 */
function exportTerrainSnapshot() {
  const kind = rasterLayer.value;
  if (kind !== 'height' && kind !== 'temp' && kind !== 'prec') return null;  const r = getRaster(kind);
  const raster = r
    ? { dataUrl: r.canvas.toDataURL('image/png'), minX: r.minX, minY: r.minY, w: r.w, h: r.h }
    : null;
  // 只有「高度」档有海深/等深线（温度/降水是专题图，加海深会被读成地形 —— 与画布同一条口径）
  const sea = kind === 'height' ? getSeaDetail() : null;
  const isobaths = sea && Array.isArray(sea.isobaths) ? sea.isobaths : [];
  const coasts = sea && Array.isArray(sea.coasts) ? sea.coasts : [];
  if (!raster && !isobaths.length && !coasts.length) return null;
  return { kind, raster, isobaths, coasts };
}

/**
 * 只取海岸线 / 等深线几何（2026-10-28，补 §3.1 欠账）：政治模式导出要在海面上画浅滩带，
 * 但那时**不该**为了导出而生成栅格（`getRaster` 有成本）。与 `exportTerrainSnapshot`
 * 共用 `getSeaDetail()`（同一份缓存），不另算距离场。
 */
function exportSeaSnapshot() {
  const sea = getSeaDetail();
  if (!sea) return null;
  return {
    isobaths: Array.isArray(sea.isobaths) ? sea.isobaths : [],
    coasts: Array.isArray(sea.coasts) ? sea.coasts : [],
  };
}

// ══════════════════════════════════════
// 海面细节：等深线 + 海岸线（2026-10-26）
// ══════════════════════════════════════//
// 用户给的意大利地形图里，海面不是一块纯色：浅海 → 深海有分带，带上还有等深线，
// 陆地与海之间有一条明确的海岸线。这三样在我们数据里**都不存在**：
//   · 海格高度恒 = 12（导入图 2539/2539 个海格、造陆图 `seaLevel-8`）→ 分带无从下手；
//   · 海岸线只有导入的 `.map` 带 `landFeatures`，造陆出来的底图没有。
// 所以海深**推导**（utils/seaDepth.js），海岸线"有轮廓用轮廓、没有就在高度场上取海平面等值线"。
// 两者都是纯几何，按高度图/轮廓的**引用**缓存 —— 引用没变就不可能变，与既有缓存纪律一致。
let seaDetailCache = { hm: null, land: null, isobaths: [], coasts: [] };

// getSeaDetail 已搬到 helpers.js（2026-10-31）


/** 世界坐标折线描边（画布已按相机做过 translate/scale，这里直接用世界坐标） */
function strokeWorldPolyline(c, pts, close = false) {
  if (!pts || pts.length < 2) return;
  c.beginPath();
  c.moveTo(vx(pts[0]), vy(pts[0]));
  for (let i = 1; i < pts.length; i++) c.lineTo(vx(pts[i]), vy(pts[i]));
  if (close) c.closePath();
  c.stroke();
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

// ── 导入河/路的「海岸线裁剪」缓存（2026-10-14）──────────────────────────────
// 🔴 为什么必须有缓存：`drawRivers` 每帧都跑，而判定「这一点在不在陆地上」是逐环射线法
//    （真实底图 415 个环 / 24018 个顶点）。每帧现算 = 把"改好了观感"换成"卡成幻灯片"。
//    缓存键用**引用**（`baseMap.terrain` / `baseMap.rivers` 的数组引用）：
//    改省份会换 terrain 数组引用、导入会换 rivers 数组引用 —— 引用没变就不可能变，
//    所以这层缓存不会"陈旧"（比按 key 名缓存安全：同名换数据不会漏失效）。
let displayRiverCache = { terrain: null, rivers: null, out: [] };
// 导入河的「绘制计划」与「分块 Path2D」两套缓存已随 `drawRivers` 搬进
// `scenario/layers/features.js`（它们是渲染独占，组件这边不再需要）。
let landMaskCache = { terrain: null, mask: null };

/** 取当前底图的陆地掩膜（按 terrain 引用缓存） */
function getLandMask() {
  const terrain = baseMap.value?.terrain;
  if (!terrain || !terrain.length) return null;
  if (landMaskCache.terrain === terrain && landMaskCache.mask) return landMaskCache.mask;
  const mask = buildLandMask(terrain);
  landMaskCache = { terrain, mask };
  return mask;
}

/**
 * 河流的**陆地判定** —— 自动河流裁剪专用，**单一实现**。
 *
 * 🔴 口径 = **省份掩膜独占**（2026-10-16 第五修）。上一轮这里是「掩膜 ∪ 高度场」，
 *    并据"实测 9/2785 越界"认为已修好 —— 实际上并集**让越界变多了**，理由与实测见函数体内注释。
 *    一句话：**掩膜在时高度场不许插话**；掩膜不在（还没画省份的空底图）才用高度场兜底。
 *
 * ⚠️ 与"源头必须离海 ≥2 格"那道闸门**现在同口径了**（`scenarioEditing.landMaskFor` →
 *   `traceRivers({ isLand })` 也是纯掩膜）—— 源头与几何用同一份陆地定义，
 *   不会再有"源头在海上、河道在陆上"这种自相矛盾。
 * ⚠️ 高度按**规则栅格**定位（O(1)），不是逐点扫网格（那会退化成 O(格数) × 段数）。
 */
// makeRiverLandCheck 已搬到 rivers.js（2026-10-31）


/** 与 `heightMath.SEA_LEVEL` / `riverTrace.TRACE_SEA_LEVEL` 同口径（20） */
const SEA_LEVEL_FOR_RIVER = 20;

/**
 * 🔴 **自动河流的河网段**（2026-10-14 第四修）—— 裁到海岸线后按 `terrain` 引用缓存。
 *
 * 这一层存在的两个理由，都是用户实测截图逼出来的：
 *  ① **树枝状汇聚**：`rivers[]` 是"每个源头一条代表路径"，实测只有 12~270 个点（陆地 2506 格）
 *     → 结构上画不出河网。段（1717 段）才是河网的几何本体，见 `strokeRiverNetwork`。
 *  ② **不再钻进海里**：段的一端是**海格中心**，而画出来的海岸线在格与格之间 →
 *     照原样画就是"河越过岸线伸进海里"。这里逐段裁到陆地边界（`clipSegmentToLand`），
 *     与导入河走**同一份陆地掩膜**（`getLandMask()`）—— 两处用不同判据就会
 *     "进口河不越界、自动河越界"，那种不一致最难查。
 *
 * ⚠️ 缓存键是 `terrain` **引用** + `autoRivers` **引用**：掩膜与段都只在
 *    "换了底图 / 重新生成"时变（`autoRivers` 每次生成都是新数组）。不缓存的话
 *    1717 段 × 每段 12 次二分射线判定 = 每帧两万次，直接变幻灯片。
 */
let autoRiverNetCache = { terrain: null, rivers: null, out: [] };
// getAutoRiverNetwork 已搬到 misc.js（2026-10-31）


/**
 * 自动河「要画的那几段折线」—— **按数据引用缓存的纯几何**（2026-10-18 第十八修）。
 *
 * 这一段原来整块写在 `renderFrame` 里，于是**每帧**都要：算流量闸门 → 剪枝 → 沿 receiver
 * 成链 → 抽稀到控制点 → 重建陆地掩膜 → 逐链裁到海岸线。全部与相机无关，纯属白付。
 * 实测（真实 desite 底图 / 1710 段 / 755 段过闸门）：一帧 7.3ms → **14.3ms**，
 * 其中 `pruneRiverNetwork` 一项就 4.2ms；用户侧表现是「点过自动河流之后到处都卡」。
 *
 * 缓存键 = `(net, terrain, segMax)` 三个**引用/标量**：`net` 由 `getAutoRiverNetwork()`
 * 按 `(segments, terrain)` 引用缓存，`segMax` 随生成换值，`terrain` 写入一律换数组
 * —— 三者任一变了才可能变，所以这层不会陈旧（与本文件的 `displayRiverCache` 同口径）。
 */
let autoRiverPartsCache = { net: null, terrain: null, segMax: null, out: [] };
// autoRiverPartsFor 已搬到 rivers.js（2026-10-31）


/** 导入的河流（已裁到海岸线）。手画的（`river_` 前缀）不走这里 */
// getDisplayRivers 已搬到 misc.js（2026-10-31）


// ── 逐点河宽（2026-10-26）──────────────────────────────────────────────────
// 数据里 `width` 是**每河一个标量**；要"源头细 → 河口粗"就得逐点宽度。
// 两种来源：
//   · 造陆河：生成时已经把逐点流量写进 `r.widths`（同一份 `widthAt` 曲线）；
//   · 导入河：没有逐点数据 → 按**弧长**推 0.35~1 的因子。方向（哪端是河口）用
//     `buildDistanceToSea` 的距海距离判断 —— 用两端地形高度判不出来（159 条里 156 条两端同格）。
// 结果按 points 数组引用缓存（`WeakMap`）：同一段几何不可能变。
let seaDistanceCache = { hm: null, field: null };
function getSeaDistanceField() {
  const hm = baseMapKey.value ? store.getHeightmapFor(baseMapKey.value) : null;
  if (!hm || !hm.grid) return null;
  if (seaDistanceCache.hm === hm) return seaDistanceCache.field;
  seaDistanceCache = { hm, field: buildDistanceToSea(hm, { seaLevel: RASTER_SEA_LEVEL }) };
  return seaDistanceCache.field;
}

const riverWidthSeriesCache = new WeakMap();

/** 逐点宽度（与 `river.width` 同量纲：0.02~0.26） */
// riverWidthSeries 已搬到 helpers.js（2026-10-31）


/** 本幅图最宽的河（`basemapRiverWidthPx` 的归一化参照）—— 按 rivers 数组引用缓存 */
let maxRiverWidthCache = { list: null, max: 0 };
function getMaxRiverWidth() {
  const list = baseMap.value?.rivers || [];
  if (maxRiverWidthCache.list === list) return maxRiverWidthCache.max;
  let max = 0;
  for (const r of list) {
    const w = Number(r && r.width);
    if (Number.isFinite(w) && w > max) max = w;
  }
  maxRiverWidthCache = { list, max };
  return max;
}

/** 配色/样式对齐 Azgaar FMG 默认：道路棕色实线、小径棕色虚线、海路白色虚线 */

/** 选中轮廓的空隙（屏幕像素）—— 单一来源在 `riverRender.js`（`riverSelGapForWidth` 按河宽收窄） */
const RIVER_SEL_GAP_PX = RIVER_SEL_GAP_PX_UTIL;
const RIVER_SEL_WEIGHT_PX = RIVER_SEL_WEIGHT_PX_UTIL;

/** 当前底图可用的数据图层清单（状态栏显示） */
const layerAvailability = computed(() => {
  const hm = baseMap.value?.heightmap;
  return {
    // 🔴 只报**有地形内容**的格数（2026-10-11）：空壳高度图（有点、无 h）此前会被报成
    //    「N 网格」，于是用户看到纯色扁平图 + 状态栏说"有网格"，只能去找一个不存在的显示开关。
    cells: hasHeightmapContent(hm) ? (hm?.grid?.points?.length || 0) : 0,
    temp: (hm?.temp?.length || 0) > 0,
    prec: (hm?.prec?.length || 0) > 0,
    rivers: (baseMap.value?.rivers?.length || 0),
    routes: (baseMap.value?.routes?.length || 0),
    cultures: (hm?.cultures?.length || 0),
    religions: (hm?.religions?.length || 0),
  };
});

// 小地图（P11）
// N1 刀 2：缩略图缓存 / 包围盒 / 缩略图烘焙全搬进 `scenario/layers/overlays.js`（按实例），
// 这里只留开关；缓存失效由 `overlayLayers.invalidateMinimap()` 触发。
const showMinimap = ref(true);

// 数据图表（P2-T3 文化/宗教/势力分布）
const showDataChart = ref(false);
const dataChartType = ref('culture'); // culture | religion | polity

/**
 * 🔴 **帧合并的正确位置**（2026-10-17 第七修补正）：只在**高频连续手势**里用，
 * **不是**改 `render()` 本身的语义。
 *
 * 教训留档（我这一轮真的踩了）：一开始我把 `render()` 全局改成"同帧只画一次、后续推迟到
 * 下一帧"，于是 5 个用例同时变红，而它们的共同点是**"改数据 → render() → 立刻取像素"**：
 *   · `test_20`（Alt 临时直线生效，像素差分应为 >0）→ 0
 *   · `test_53`（渲染护栏：首帧后要能读到错误、连续 3 帧要能暂停）→ 读不到
 *   · `test_61`（打开省份工具后画布必须立刻有多边形）+ `test_73`（势力标注要跟着改）→ 画布空
 *   · `test_90`（两态画面必须不同）→ 两态相同
 * 根因不是"测试写得脆"，而是**`render()` 的语义是同步**：全仓几十处调用都依赖这一点。
 * 把公共 API 改异步 = 为一个局部优化付全局语义代价 —— 这是错的。
 *
 * ⇒ 现在：`render()` 恢复**同步**（语义不变）；只有这些**明确的高频手势**显式调用本函数：
 *   河流拖笔采样、河流拖节点、顶点拖动、平移/缩放、时间轴播放。
 * 它们一秒能触发几十次，合并掉同帧的重复整帧才有意义。
 */
function renderCoalesced() {
  if (renderPaused.value) return;
  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  if (now - lastRenderAt < 15) {
    if (rafRenderId == null && typeof requestAnimationFrame === 'function') {
      rafRenderId = requestAnimationFrame(() => { rafRenderId = null; render(); });
    }
    return;
  }
  render();
}
let lastRenderAt = -1e9;
let rafRenderId = null;

function render() {
  if (renderPaused.value) return;
  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  lastRenderAt = now;
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

/** 手动恢复渲染（护栏暂停后由状态栏按钮 / 画布中央横幅触发） */
function resumeRender() {
  renderPaused.value = false;
  renderErrorCount.value = 0;
  renderError.value = '';
  renderErrorLogged = false;
  render();       // 护栏解除必须**立刻**出图（用户点了按钮就要看到变化）
}

/** 把渲染错误原文复制到剪贴板（横幅上的「复制错误」）—— 用户反馈时最需要的那个字符串 */
async function copyRenderError() {
  const text = `渲染已暂停（连续 ${renderErrorCount.value} 帧异常）：${renderError.value}`;
  try {
    await navigator.clipboard.writeText(text);
    statusMsg('错误原文已复制到剪贴板');
  } catch (_) {
    // 剪贴板不可用（无权限/非安全上下文）→ 退化成"选中给用户手动复制"，
    // 绝不静默：用户点了按钮必须看到反应。
    statusMsg(`复制失败，请手动选中：${renderError.value}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 手势期「底图基帧」缓存（2026-10-18 第十八修·二）—— 卡顿的主刀
//
// 🔴 为什么是这个做法（而不是"给每个图层各加一层缓存"）：CPU 采样实测，拖一圈省份的 4 秒里
//    **(program) 占 67%** —— 也就是**原生 canvas 光栅化本身**（fill / stroke / lineTo /
//    drawImage），不是任何一段 JS。当时的每一帧都把**整张地图**重画一遍（200 省 / 160 河 /
//    24018 个顶点 / 9975 格高度图）。绘图软件遇到这件事的标准答案就是**分层**：底图只在需要
//    时画一次，笔迹画在它上面。这里用最小代价实现同一件事 —— 手势按下时把「没有草稿的那一帧」
//    渲染进一张离屏画布，手势期间每帧改成「贴这张图 + 画在动的浮层」。
//    它与 `renderCoalesced` 是同一条纪律：**只在明确的高频手势里启用**，手势一结束就丢掉，
//    `render()` 的同步语义与全量重画路径一个字不改。
//
// 🔴 为什么可以整帧缓存（不需要维护依赖键）：启用的前提是**这一笔不改地图数据**（草稿都在
//    组件本地状态里：`freeTrace` / `riverDraft` / `riverDrag` / `dragPreview` / 框选矩形），
//    且相机不动 —— 相机一动立刻弃用并**解甲**（`blitStrokeBase`），否则"重建 + 贴图"会比
//    全量重画还贵一倍。⚠️ 涂抹 / 高度 / 群系笔刷**不启用**（它们每帧真的在改底图数据）。
//
// 口径：基帧只装「草稿之下的静态层」。草稿之上的静态层（省名 / 势力名 / 浮雕 / 标记）与
//    屏幕空间浮层（小地图 / 图例 / 统计）在手势帧里**照常逐帧画** ⇒ 贴图帧与全量帧的
//    **层叠顺序逐层相同**、像素应当逐点相同（回归 `test_121` 就按这条判）。
// ══════════════════════════════════════════════════════════════════════════
let strokeBase = null;            // { canvas, w, h, camX, camY, camScale }
let strokeBasePool = null;        // 离屏画布（只在尺寸变化时重建）
let strokeBaseArmed = false;      // 手势期启用（mousedown 开；mouseup/离开/滚轮/卸载关）
let strokeBaseBuilding = false;   // 正在渲染基帧（防递归）
// 机械计数（不参与渲染语义）：手势里**全量重画了几次、贴图几次** —— 用例按它判"缓存真的在生效"，
// 不靠墙钟时间（时间断言在慢机器上会假红）。
const strokeBaseStats = { builds: 0, blits: 0 };

// 手势闸门是否已开（与 onMouseDown/onMouseUp 严格配对；卸载时兜底收掉，见 onBeforeUnmount）
let canvasGateArmed = false;

/** 手势按下时调用（**只在这些手势**：自由绘制 / 描轮廓 / 河笔 / 拖节点 / 顶点拖动 / 框选 / 折线切割） */
function beginStrokeBase() {
  strokeBaseArmed = true;
  strokeBase = null;              // 相机可能刚动过 → 基帧一律重建
}
function endStrokeBase() {
  strokeBaseArmed = false;
  strokeBase = null;
}

function strokeBaseLayer() {
  const cvs = canvas.value;
  const w = (cvs && cvs.width) | 0;
  const h = (cvs && cvs.height) | 0;
  if (!w || !h) return null;
  let cv = strokeBasePool;
  if (!cv) { cv = document.createElement('canvas'); strokeBasePool = cv; }
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }   // 改尺寸会顺带清空
  const c = cv.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, w, h);
  return { canvas: cv, ctx: c, w, h };
}

/** 把「草稿之下的静态层」渲染进离屏画布（**临时把 `ctx` 换到离屏**，见函数内注释） */
function buildStrokeBase() {
  const layer = strokeBaseLayer();
  if (!layer) return;
  // ⚠️ `ctx` 是 `<script setup>` 的 ref，`renderFrame` 通篇走 `ctx.value`（也就 `drawPreviewOverlay`）。
  //    这里临时改指向再改回来，是**同步**的、且 `strokeBaseBuilding` 期间正好把那唯一的
  //    外部读者（`drawPreviewOverlay`）挡掉（见上面的守卫），所以不存在"画到别人画布上"。
  const saved = ctx.value;
  strokeBaseBuilding = true;
  ctx.value = layer.ctx;
  try {
    renderFrame();
  } finally {
    ctx.value = saved;
    strokeBaseBuilding = false;
  }
  strokeBase = {
    canvas: layer.canvas, w: layer.w, h: layer.h,
    camX: cameraX.value, camY: cameraY.value, camScale: cameraScale.value,
  };
  strokeBaseStats.builds += 1;
}

/** 有可用基帧就贴回来；返回 true = 这一帧的「草稿之下的静态层」已经画好了 */
function blitStrokeBase() {
  const b = strokeBase;
  if (!b) return false;
  if (b.camX !== cameraX.value || b.camY !== cameraY.value || b.camScale !== cameraScale.value) {
    endStrokeBase();
    return false;
  }
  const c = ctx.value;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.drawImage(b.canvas, 0, 0, b.w, b.h);
  c.setTransform(canvasDpr, 0, 0, canvasDpr, 0, 0);
  strokeBaseStats.blits += 1;
  return true;
}

// ── N1 第三阶段：交互处理（2026-10-31）────────────────────────────────────
// 键盘先搬（纯"读状态→调动作"），鼠标/滚轮随后用同一个 ctx 搬。
// `let` 变量（altStraight / suppressRiverClick / vertexMarqueeStart / vertexLinkCtx）用 get/set 传 ——
// 直接传值只会拷一份，组件这边永远不更新。
// 预览层的 view（比 makeLayerView 多几项只在交互期才有的状态）
function makePreviewView() {
  return {
    ...makeLayerView(),
    px,
    tool: tool.value,
    freeTraceActive,
    freeTrace,
    drawPoints: drawPoints.value,
    polySplitPoints: polySplitPoints.value,
    polySplitPreview: polySplitPreview.value,
    polySplitKeepStart: polySplitKeepStart.value,
    polySplitHover: polySplitHover.value,
    batchSeeds: batchSeeds.value,
    batchPreviewCells: batchPreviewCells.value,
    batchPreviewInside: batchPreviewInside.value,
    snapMarker: snapMarker.value,
    brushPreview: brushPreview.value,
    roadPath: roadPath.value,
    splitStep: splitStep.value,
    splitPoints: splitPoints.value,
    riverEraseStroke: riverEraseStroke.value,
    riverDraft: riverDraft.value,
    terrainLabelPick: terrainLabelPick.value,
    selectedRiver: selectedRiver.value,
    riverActiveNode: riverActiveNode.value,
    cameraScale: cameraScale.value,
    tracePath,
    traceShapePath,
    previewTraceRing,
    riverPreviewNodes,
    drawOneHandRiver,
    riverNodesForRender,
    RIVER_ERASE_RADIUS_PX,
    RIVER_WIDTH_DEFAULT,
    RIVER_HANDLE_MAX,
    RIVER_HANDLE_MIN_ZOOM,
  };
}

// ── N1 刀 1：渲染层注册表（2026-10-30）─────────────────────────────────────────
// 这一步只把「谁先谁后」变成数据（绘制实现仍在本文件），所以判据是**逐像素一致**
// （`python scripts/tests/drill_scenario_pixels.py --compare before after`）。
// 顺序口径（照抄原来的 if 链，一个字都没改）：
//   · 栅格图层只有"陆海底色"是给省份兜底的；height/temp/prec/satellite/terrain 是**地形底图**，
//     必须画在省份之前、且不透明（2026-10-26 用户原话「看不出地形」就是两层半透明互相洗成的）；
//   · 海岸（浅海带 `landsea` / 等深线 `rasterBase`）画在栅格之上、省界之下 —— 海岸属地形，压在行政边界以下；
//   · 省份**永远画**（存下来/导出的就是它）；地形底图模式下只描边不填色（`fills:false`），否则地形被色块盖住。
const RASTER_BASE_KINDS = new Set(['height', 'temp', 'prec', 'satellite', 'terrain']);
const isRasterBase = () => RASTER_BASE_KINDS.has(rasterLayer.value);
const isAnyRaster = () => rasterLayer.value === 'landsea' || isRasterBase();

/**
 * 一帧的「层可见世界」——**渲染层唯一的数据入口**（N1 接口化的核心）。
 *
 * 为什么是一个显式的 view 而不是让层直接摸组件状态：
 *   ① 每层读什么写在它自己的文件头里，改一层不用通读 14k 行；
 *   ② 将来"在整张图之上套质感"时，质感层拿到的是同一份 view，而不是 28 个各画各的闭包；
 *   ③ 导出（`exportPNG`）与画布用同一份 view，天然同源（此前导出各写一套 → 导出与画布不一致且不报错）。
 */
function makeLayerView() {
  return {
    w: cw(),
    h: ch(),
    px,
    screenToWorld,
    cameraX: cameraX.value,
    cameraY: cameraY.value,
    cameraScale: cameraScale.value,
    baseMap: baseMap.value,
    terrain: rawTerrain(),
    rasterLayer: rasterLayer.value,
    showBiomes: showBiomes.value,
    timeline: timeline.value,
    eraIndex: tlEra.value,
    date: tlDate.value,
    diffMode: tlDiffMode.value,
    mode: viewMode.value,
    altStraight,
    selectedProvince: selectedProvince.value,
    selectedScenario: selectedScenario.value,
    selectedPolity: selectedPolity.value,
    multiSelect: multiSelectSet.value,
    mergeProvId: mergeProvId.value,
    // 文字层的五个开关 + 河名开关（都是「这一帧画不画」的判据，不是选项面板状态）
    showLabels: showLabels.value,
    showPlaceNames: showPlaceNames.value,
    showPolityLabels: showPolityLabels.value,
    showProvinceNames: showProvinceNames.value,
    showBurgs: showBurgs.value,
    showNamedProvincesOnly: showNamedProvincesOnly.value,
    showTerrainNames: showTerrainNames.value,
    showRiverBase: showRiverBase.value,
    GRID_STEP,
    SEA_EDGE,
    BORDER_COLOR,
    PROVINCE_BORDER_COLOR,
    PROVINCE_BORDER_PX,
    getSeaDetail,
    rawTerrain,
    rawProvOf,
    provincePathFor,
    getProvinceColor,
    provinceBBox,
    isStriped,
    polityColor,
    polylineInView,
    strokeWorldPolyline,
    // 文字层要的几个组件内判据（档位/字号/领土来源/地图尺寸）
    polityLabelSources,
    polityLabelTier: polityLabelTierNow.value,
    mapWorldSize,
    labelDetail: labelDetailNow,
    labelScale: labelScaleNow,
    // 屏幕空间浮层（小地图 / 图例 / 分布图 / 悬浮卡）
    baseMapKey: baseMapKey.value,
    colorMode: colorMode.value,
    dataChartType: dataChartType.value,
    showDataChart: showDataChart.value,
    showMinimap: showMinimap.value,
    hoveredBurg: hoveredBurg.value,
    selectedBurg: selectedBurg.value,
    ringPointsList: rawRingPointsList,
    // 地图要素层（道路 / 手画河 / 城镇）
    routes: baseMap.value?.routes || null,
    rivers: baseMap.value?.rivers || null,
    burgs: burgs.value,
    arterialLengthThreshold,
    shouldDrawRoute,
    getLandMask,
    riverNodesForRender,
    drawOneHandRiver,
    BURG_SIZES,
    getDisplayRivers,
    getMaxRiverWidth,
    riverWidthSeries,
    riverSelIds,
    selectedRiverId: selectedRiverId.value,
    RIVER_SEL_WEIGHT_PX: RIVER_SEL_WEIGHT_PX_UTIL,
    drawRiverNames: (cc) => labelLayers.drawPlanned(cc, makeLayerView(), ['river']),
    reliefIcons: reliefIcons.value,
    selectedMarker: selectedMarker.value,
    MARKER_TYPES,
    markerLabelTextStyle,
    drawStyledLabel,
    drawIconOrEmoji,
    // 编辑期覆盖层（顶点手柄 / 框选 / 笔刷圈 / 套索）
    dragPreview: dragPreview.value,
    vertexEditMode: vertexEditMode.value,
    currentProvince,
    resolvePoints,
    activeVertexIdx: activeVertexIdx.value,
    vertexSelection: vertexSelection.value,
    draggingVertex: draggingVertex.value,
    vertexMarquee: vertexMarquee.value,
    riverMarquee: riverMarquee.value,
    normalizeBox,
    provBrushPreview: provBrushPreview.value,
    tool: tool.value,
    clearOwnerMode: clearOwnerMode.value,
    ownerStrokeIds,
    provinceRings,
    ownerBrushWorldRadius,
    provBrushRadius: provBrushRadius.value,
    provBrushWorldRadius: provBrushWorldRadius.value,
    store,
    provLassoPoints: provLassoPoints.value,
    provLassoActive: provLassoActive.value,
    tracePath,
    vx,
    vy,
    formatPopulation,
  };
}

const labelLayers = createLabelLayers();
const overlayLayers = createOverlayLayers();

const scenarioRenderLayers = createLayerRegistry();
scenarioRenderLayers.register({
  id: 'basemap.background', order: 10, cacheable: true,
  draw: (c, view) => drawBackgroundLayer(c, view),
});
scenarioRenderLayers.register({
  id: 'basemap.raster', order: 20, when: isAnyRaster, cacheable: true,
  draw: (c) => drawRasterLayer(c, rasterLayer.value, 1),
});
scenarioRenderLayers.register({
  id: 'basemap.coastShallow', order: 30, when: () => rasterLayer.value === 'landsea',
  draw: (c, view) => drawPoliticalCoastLayer(c, view),
});
scenarioRenderLayers.register({
  id: 'basemap.seaDetail', order: 30, when: isRasterBase, cacheable: true,
  draw: (c, view) => drawSeaDetailLayer(c, view),
});
scenarioRenderLayers.register({
  id: 'basemap.biomes', order: 40, when: () => showBiomes.value, cacheable: true,
  draw: (c, view) => drawBiomeLegendLayer(c, view),
});
scenarioRenderLayers.register({
  id: 'provinces.fill', order: 50, cacheable: true,
  draw: (c, view) => drawProvincesLayer(c, view, { fills: !isRasterBase() }),
});

function renderFrame() {
  if (!ctx.value) return;
  const cvs = canvas.value;
  const w = cw();
  const h = ch();
  // DPR：**每帧显式设基准变换**，不依赖 resize 时设一次 —— save/restore 失衡或别处
  // setTransform 都会把它抹掉（本仓真的发生过 ctx.filter 配方类问题成批复现的现象）。
  ctx.value.setTransform(canvasDpr, 0, 0, canvasDpr, 0, 0);
  ctx.value.clearRect(0, 0, w, h);

  // 手势期基帧（见 `beginStrokeBase` 注释）：有得贴就贴，没得贴就全量画。
  // ⚠️ 递归保护：建基帧时会再进一次本函数（`strokeBaseBuilding`），那一次不许再走这条分支。
  let blitted = false;
  if (strokeBaseArmed && !strokeBaseBuilding) {
    if (!strokeBase) buildStrokeBase();
    blitted = blitStrokeBase();
  }

  ctx.value.save();
  ctx.value.translate(cameraX.value, cameraY.value);
  ctx.value.scale(cameraScale.value, cameraScale.value);

  if (!blitted) {
    // ── N1 刀 1（2026-10-30）：底图 / 栅格 / 海岸浅滩 / 等深线 / 群系 / 省界 六层走注册表 ──
    //    顺序不再是"读代码才知道"，而是每层自己声明的 `order`；每层读什么见 `makeLayerView()`。
    const layerView = makeLayerView();
    scenarioRenderLayers.run(ctx.value, layerView, {});

    if (showRoutes.value) drawRoutesLayer(ctx.value, makeLayerView());
    if (showRiverBase.value) drawRiversLayer(ctx.value, makeLayerView());
  }
  if (!strokeBaseBuilding) drawRiverPathsLayer(ctx.value, makeLayerView());
  // 选中河流的高亮（2026-10-17 暮雨实测「缺乏视觉提示……只能通过工具栏突然往下挤」）：
  // 选中的河画两遍 —— 外层宽半透明光晕 + 内层亮芯，任何底色上都一眼可辨（EU4 选中单位的光圈语义）。
  if (!strokeBaseBuilding) drawSelectedRiverHighlightLayer(ctx.value, makeLayerView());

  // v2: 自动生成的河流
  // 🔴 2026-10-14 修：这一段原来写的是裸 `ctx.xxx(...)` —— `ctx` 是 `ref(null)`，
  //    在 `<script setup>` 里**不是** Vue 模板，不会被自动解包：`ctx.save` 是 undefined，
  //    于是**只要画布上有自动河流，第一帧渲染就抛** `ctx.save is not a function`（压缩后
  //    `Ce.save is not a function`）。它抛在 renderFrame 里 → 从这一行起**后面全不画
  //    （省界/标签/小地图/势力名全没了）+ 3 帧后渲染护栏自我暂停**，用户看到的就是
  //    「点了自动河流之后一片空白、点什么都没反应」。
  //    为什么以前没被发现：`autoRivers` 只由「自动河流」按钮填充，默认是空数组 →
  //    这一整块**默认永远不执行**；而 92 个 CDP 用例没有一个点过那个按钮。
  //    教训：`<script setup>` 里的 ref 只有模板会解包；**函数体里一律 `.value`**。
  //    守卫见 scripts/tests/unit/test_vue_ref_unwrap.js。
  //
  // 🔴 2026-10-14 第二修（用户实测「很丑，是僵硬的折线」）：三条一起改 ——
  //    ① 格心连成的折线先过 `smoothPolyline`（Chaikin 角切割，只切角不外扩，
  //       端点不动 → 河口/源头位置一字不差）；真实底图实测转角中位数 41.6°、最大 113°，
  //       不平滑就是一眼假的锯齿。
  //    ② 线宽按**逐点汇流量**（`flows[k]`）而不是整条河一个数：真实的河**越往下游越宽**，
  //       整条一个粗细是"一眼假"的最后一块拼图。口径（立方根）在 `utils/riverRender.js`。
  //    ③ 画法走 `strokeRiver`（两遍描边：外层浅色 + 内层亮芯）。一条 1px 实线在花掉的
  //       地形上根本认不出来，这是"河流看不清"的由来。
  //
  // 🔴 2026-10-14 第三修：**按汇流量升序**画（细的在下、粗的在上）。追踪输出是"大流量在
  //    前"，照那个顺序画的话，一条细支流会**压住**它所汇入的干流下游段 —— 看起来就是
  //    "主干忽然变细"。升序画则粗的永远最后落笔，下游不会被细线覆盖。
  //
  // 🔴 2026-10-14 第四修（用户实测截图三条一起改）：
  //    ① 「根本画不出树枝状汇聚」→ **改画河网段**（`strokeRiverNetwork`）：段是流向场本身
  //       （实测 1717 段），支流逐格汇进干流；代表路径只有 12~270 个点，画不出这个结构。
  //    ② 「并没有越往下游越宽」→ 线宽改**归一化口径**（`flowWidthScale(flow, segMaxFlow)`）：
  //       旧绝对口径在这份地形上只有 1.4 倍变化，等于一样粗。
  //    ③ 「依然过度延伸到海洋」→ 段在 `getAutoRiverNetwork()` 里已逐段裁到海岸线。
  if (!blitted && autoRivers.value.length > 0 && showRiverAuto.value) {
    const spacing = baseMap.value?.heightmap?.grid?.spacing || 14.4;
    const toPx = (w) => px(w);
    ctx.value.save();
    // 河网（树枝状）优先：它才是"河"的观感本体
    const net = getAutoRiverNetwork();
    if (net.length) {
      // 🔴 2026-10-16 第五修：**观感与地图自带河流对齐** —— 同一个色、同一条线宽公式、同样单遍实线。
      //    实测（真实 desite 底图，zoom=1）：
      //      · 自带河 `#5d97bb` 单遍，屏幕线宽 p50 **0.70px** / max 2.55px；
      //      · 上一轮自动河 `#3B82F6` @0.35 宽×2.4 + 亮芯 `#93c5fd` → p50 **0.80px 实心 + 1.92px 光晕**。
      //    于是自动河像"发光的中蓝带子"、自带河像"贴着地形的细暗线"，一眼两套东西（用户原话：
      //    「依旧色差，依旧和底图自带河流各画各的」）。
      //    ⚠️ 宽度必须走**屏幕像素**（`widthPx`）：自带河就是屏幕像素口径、不随缩放变粗；
      //       若继续走世界单位（`px(w)`），放大后自动河会比自带河粗一倍以上，色对齐了粗细仍不对。
      //    ⚠️ `flow`（汇流格数）→ `discharge`（自带河口径）必须按本幅图段流量上界归一化，
      //       否则 `width*6*0.6` 底下全是 0.7px 的下限（与第四修"绝对口径"同一个坑）。
      const segMax = autoRiverMaxFlow.value;
      // 🔴 2026-10-18 第十八修（性能）：这一段以前**每帧重算**。实测（真实 desite 底图，
      //    200 省 / 1710 段 / 755 段过闸门）：`render` 从 **7.3ms → 14.3ms**，翻了一倍，
      //    其中 `pruneRiverNetwork` **4.2ms**、`riverFlowGate` 0.5ms，另外每帧还在
      //    重建陆地掩膜（24018 个顶点）+ 逐链裁到海岸线。用户侧的表现就是
      //    「点过自动河流之后，画什么、拖什么都卡」—— 因为每一帧都要付这笔钱。
      //    现在整段几何**按数据引用缓存**（`autoRiverPartsFor`）：闸门 / 剪枝 / 成链 /
      //    抽稀 / 裁岸线全是**与相机无关**的纯几何，只在「河网换了或地形换了」时才重算。
      const netParts = autoRiverPartsFor(net, rawTerrain(), segMax);
      if (netParts.length) {
        strokeRiverNetworkAsPaths(ctx.value, netParts, {
          toPx,
          maxFlow: segMax,
          color: BASEMAP_RIVER_COLOR,
          minPx: riverMinWidthForNet(),
          subdiv: RIVER_NET_CURVE_SUBDIV,
        });
      }
    }
    // 代表路径照旧画（它是"命名/分级"的对象；没有段数据时它就是唯一的东西）
    if (!net.length) {
      const drawList = autoRivers.value
        .map((river, idx) => ({ river, idx, flow: (river && river.flow) || 0 }))
        .sort((a, b) => (a.flow - b.flow) || (a.idx - b.idx));
      for (const item of drawList) {
        const river = item.river;
        const raw = Array.isArray(river) ? river : (river && river.points);
        if (!raw || raw.length < 2) continue;
        const sm = smoothPolyline(raw, TRACE_SMOOTH_ITERATIONS);
        const poly = buildRiverPolyline(
          { points: sm, flows: river && river.flows, flow: item.flow, width: river && river.width },
          { spacing, maxFlow: autoRiverMaxFlow.value });
        if (!poly) continue;
        strokeRiver(ctx.value, poly, { toPx });
      }
    }
    ctx.value.restore();
  }
  // 省界（N1 刀 1）：仍直接调用 —— 它的门控是 `showBorders`，且必须画在河流/草稿之上，
  // 塞进注册表会改变层叠顺序（那是刀 2 的事）。实现已搬到 `scenario/layers/provinces.js`。
  if (!blitted && showBorders.value) drawProvinceBordersLayer(ctx.value, makeLayerView());
  if (!strokeBaseBuilding) drawVertexHandlesLayer(ctx.value, makeLayerView());
  if (!blitted && showBurgs.value && !cameraMotion) {
    drawBurgsLayer(ctx.value, makeLayerView());
    // 城镇名与河名/省名/势力名同一份排布（放不下的直接不标）
    if (showPlaceNames.value) labelLayers.drawPlanned(ctx.value, makeLayerView(), ['capital', 'town']);
  }
  if (!strokeBaseBuilding && (PROVINCE_GRID_TOOLS.has(tool.value) || tool.value === 'ownerBrush' || tool.value === 'provincePaint')) drawProvinceBrushOverlayLayer(ctx.value, makeLayerView());
  if (!strokeBaseBuilding) drawPreviewOverlayLayer(ctx.value, makePreviewView());
  // ── 以下四层画在**草稿之上**（省名/势力名/浮雕/标记）——
  //    基帧里**不含**它们（`!strokeBaseBuilding`），所以贴图帧与全量帧的层叠顺序逐层相同：
  //    「基帧（草稿之下的静态层）→ 草稿 → 这四层 → 屏幕空间浮层」。
  // 地形注记（山系名沿脊线）：画在用户地名之下、河流/城镇名之上
  if (!strokeBaseBuilding && !cameraMotion) labelLayers.drawTerrain(ctx.value, makeLayerView());
  if (!strokeBaseBuilding && showLabels.value && !cameraMotion) labelLayers.drawScenarioLabels(ctx.value, makeLayerView());
  // A8：势力标注画在用户浮动文本之后（势力名是底层读物，不该被浮字压住）
  if (!strokeBaseBuilding && !cameraMotion) {
    labelLayers.drawPolity(ctx.value, makeLayerView());
    drawReliefIconsLayer(ctx.value, makeLayerView());
    drawScenarioMarkersLayer(ctx.value, makeLayerView());
  }

  ctx.value.restore();

  // 以下浮层画在屏幕坐标系：字号与命中不受缩放影响
  if (!strokeBaseBuilding && !cameraMotion) {
    const overlayView = makeLayerView();
    overlayLayers.drawBurgTooltip(ctx.value, overlayView);
    overlayLayers.drawCultureLegend(ctx.value, overlayView);
    overlayLayers.drawMinimap(ctx.value, overlayView);
    overlayLayers.drawDataChart(ctx.value, overlayView);
  }
}


/**
 * 普通省界的颜色 / 线宽口径（单一来源）。
 * 为什么不半透明：**共边会被相邻两个省各描一次**，半透明叠加后共边比独边深 ——
 * 同一张图上边界深浅不一，肉眼读成"没画干净"。不透明就没有这个问题。
 * ⚠️ 颜色取配色单源 `BORDER_COLOR`（以前画布这里写死一个灰，而 SVG 导出用的是单源，
 *    同一张图导出与画布**边界颜色不一致** —— 正是"看起来做了但两处不一样"那一类）。
 */
const PROVINCE_BORDER_COLOR = BORDER_COLOR;
/** 普通省界的线宽（屏幕像素）—— 参考图是**细线**：1.1 → 0.9（2026-10-27 细棕线口径） */
const PROVINCE_BORDER_PX = 0.9;

/** 十六进制色混合：`t=0` 全 a、`t=1` 全 b（非 6 位色退回 a） */
function mixHexColor(a, b, t) {
  const pa = String(a || '').match(/^#([0-9a-f]{6})$/i);
  const pb = String(b || '').match(/^#([0-9a-f]{6})$/i);
  if (!pa) return a;
  if (!pb) return a;
  const k = Math.max(0, Math.min(1, Number(t) || 0));
  const av = parseInt(pa[1], 16), bv = parseInt(pb[1], 16);
  const ch = (sh) => {
    const x = (av >> sh) & 255, y = (bv >> sh) & 255;
    return Math.round(x + (y - x) * k);
  };
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

/**
 * 无主省份的底色（2026-10-27，用户 B1「黑一块白一块」）。
 *
 * 旧实现：剧本模式里**没有势力归属**的省一律刷 `#4a5568`（深灰蓝）—— 真实 415 省项目
 * 大部分省在早期年份是无主的，于是整块大陆变成一块灰蓝，中间夹几个有主色/湖泊色，
 * 就是"黑一块白一块"。EU4 的读法是：**无主 = 露出地形本色**，只有有主的地方才上势力色。
 * 这里同理：纸面底色 + 群系淡淡一调（有群系时），有主省仍由势力色覆盖。
 */
const UNOWNED_LAND_HEX = '#d8d2c2';
function unownedProvinceColor(prov) {
  const b = showBiomes.value && prov && prov.biome ? BIOME_COLORS[prov.biome] : '';
  return b ? mixHexColor(UNOWNED_LAND_HEX, b, 0.28) : UNOWNED_LAND_HEX;
}

// getProvinceColor 已搬到 province.js（2026-10-31）


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

// ═══════════════════════════════════════════
// 城镇图层（P1-T4）
// ═══════════════════════════════════════════
/** 屏幕坐标命中城镇；首都优先（避免小城镇遮住首都） */
// findBurgAt 已搬到 misc.js（2026-10-31）


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

function formatPopulation(pop) {
  if (!pop) return '—';
  return pop >= 100 ? String(Math.round(pop)) : pop.toFixed(1);
}

// ─────────────────────────────────────────────────────────────
// A8：势力标注（EU4 式分级）—— 放大看省名，缩小只留势力名（可简称），全名点开省份详情才给
// ─────────────────────────────────────────────────────────────

// 分级依据 = 「视口可见世界宽度 ÷ 地图世界宽度」。
// ⚠️ 刻意**不用绝对 cameraScale**：它依赖数据量纲（FMG 导入 ≈1 量级、合成 fixture ≈0.2 量级），
//    换一份数据阈值就整体失准 —— 表现为「同一档位在一份数据里全画省名、另一份里全画简称」。
// 缓存只按 `terrain` 数组**引用**失效（编辑一律替换数组）→ 每帧不再重扫 25930 个顶点。
let _mapSizeCache = { src: null, w: 0, h: 0 };
// mapWorldSize 已搬到 helpers.js（2026-10-31）


/** 视口可见世界宽度 ÷ 地图世界宽度（无数据时回落 1 = 中档，绝不返回 NaN） */
function mapVisibleRatio() {
  const { w } = mapWorldSize();
  const cvsW = cw() || canvas.value?.clientWidth || 0;
  const scale = Math.max(cameraScale.value, MIN_CAMERA_SCALE);
  if (!w || !cvsW) return 1;
  return (cvsW / scale) / w;
}

/** 当前档位（暴露给模板/用例；判定本体在 utils/polityLabels.js） */
const polityLabelTierNow = computed(() => polityLabelTier(mapVisibleRatio()));

// ── 缩放 → 详略档位 / 字号（2026-10-27）──────────────────────────────────────
// 用户口径（Paradox）：缩小只看见势力名；放大才出省名；再大出城镇/河名；字号随缩放略变。
// 判定本体在 `utils/labelZoom.js`（纯函数：档位表 + 12% 滞回 + 字号系数）。
// 滞回状态放**模块级**（不是 ref）：它只影响「这一帧算多细」，不进响应式、不该触发渲染。
let labelDetailState = { key: '', detail: null };

/** 当前详略档位（close / near / mid / far；带滞回，抗滚轮边界抖动） */
function labelDetailNow() {
  const key = baseMapKey.value || '';
  // 换底图 → 重新起算（否则新图会沿用上一张图的档位滞回状态）
  if (labelDetailState.key !== key) labelDetailState = { key, detail: null };
  const detail = zoomDetail(mapVisibleRatio(), labelDetailState.detail);
  labelDetailState = { key, detail };
  return detail;
}

/** 字号系数（放大略大 / 缩小略小；见 `labelZoom.labelFontScale`） */
function labelScaleNow() {
  return labelFontScale(mapVisibleRatio());
}


/**
 * 某省在**时间轴当前日期**的归属势力（唯一口径）。
 *
 * 与 `drawProvinces` / `drawPolityLabels` 共用 `polityLabelSources()`：
 * 含「演变铺开」与 EU4 斜线占领的旧主口径，并在 **owner 所属的那个剧本**里查 polity。
 * 返回 null = 该日期下无主（UI 必须明说「无主」，不能留空）。
 *
 * @param {string|null|undefined} provId
 * @returns {object|null} polity
 */
function ownerPolityForProvince(provId) {
  if (viewMode.value !== 'scenario' || !provId) return null;
  const { ownerRefOf, polityOfEra } = polityLabelSources();
  const ref = ownerRefOf(provId);
  if (!ref || !ref.owner) return null;
  return polityOfEra(ref.era, ref.owner);
}

/**
 * 当前选中省份所属势力 —— 「全名只在点开省份详情时给」那条诉求的落点
 * （地图上缩小时只画简称，全名要能查到）。
 * 2026-10-21：抽到 `ownerPolityForProvince`，右键菜单与属性面板共用同一口径。
 */
const selectedProvincePolity = computed(() => ownerPolityForProvince(selectedProvince.value?.id));

// ===== 库内资料检索 → 已抽成 `VaultLoreSection.vue`（2026-10-24，读料桥）=====
// 唯一实现只在那一个组件里（省份面板 / 标记面板共用），本文件**不再自己调** `vaultIndexSearch`。
// 纪律不变：只读检索 + 打开阅读器；没命中就明说「库里没有同名词条」；不猜、不自动建。

// ===== 标记 → 命中 / 面板（2026-10-24，第 5 件补「点标记」）=====
//
// 为什么现在才有：标记此前是"只画不收"的一层 —— 放下时 `askText` 问个名字，
// 之后**点不到它**（选择工具只认河流 / 城镇 / 省份）。所以"点标记看资料"的前置是
// ① 命中测试（`utils/markerHitTest.js`，纯函数 + Node 单测）② 编辑面板（本段）。
//
// 选中的状态分两半：`selectedMarker`（对象，面板拿来显示）+ `selectedMarkerIndex`（下标）。
// 为什么留下标：FMG `.map` 导入的标记**没有 id**（只有 `{x,y,name,type}`），
// 只按 id 定位会落到"任意第一条无 id 的"（`removeScenarioMarker` 的注释记着这次事故）。
const selectedMarker = ref(null);
const selectedMarkerIndex = ref(-1);
const showMarkerPanel = ref(false);

/** 世界坐标 → 命中的标记（判定唯一实现见 utils/markerHitTest.js；容差按屏幕 px 换算） */
function findMarkerAt(world) {
  const list = selectedScenario.value?.markers || [];
  if (!list.length) return null;
  const tol = MARKER_HIT_RADIUS_PX / Math.max(1e-6, cameraScale.value || 1);
  return hitMarker(list, world.x, world.y, tol);
}

function closeMarkerEditor() {
  if (!selectedMarker.value && !showMarkerPanel.value) return;
  selectedMarker.value = null;
  selectedMarkerIndex.value = -1;
  showMarkerPanel.value = false;
}

/** 打开标记面板：顺带收起省份面板（两块都在右侧，叠着谁也读不了） */
function openMarkerEditor(marker, index) {
  if (!marker) return;
  selectedMarker.value = marker;
  selectedMarkerIndex.value = Number.isInteger(index) ? index : -1;
  showMarkerPanel.value = true;
  selectedProvince.value = null;
  showProps.value = false;
  contextMenu.value.show = false;
  statusMsg(`已选中标记「${marker.name || '（未命名标记）'}」—— 面板里可改名 / 改类型 / 改坐标 / 删除，`
    + '下面「资料」按名字只读检索库内词条');
}

/** 对齐面板指向的标记对象（store 每次写都换对象；撤销/重做也走这里） */
function refreshSelectedMarker() {
  const cur = selectedMarker.value;
  if (!cur) return;
  const list = selectedScenario.value?.markers || [];
  const idx = markerIndexOf(list, markerIdentity(cur, selectedMarkerIndex.value));
  if (idx < 0) { closeMarkerEditor(); return; }
  selectedMarkerIndex.value = idx;
  if (list[idx] !== cur) selectedMarker.value = list[idx];
}

function markerRefOf() {
  const cur = selectedMarker.value;
  if (!cur) return null;
  return markerIdentity(cur, selectedMarkerIndex.value);
}

const markerCoords = computed(() => {
  const m = selectedMarker.value || {};
  const round = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : 0);
  return { x: round(m.x), y: round(m.y) };
});
const markerTotal = computed(() => (selectedScenario.value?.markers || []).length);
const markerOrdinal = computed(() => (selectedMarkerIndex.value >= 0 ? selectedMarkerIndex.value + 1 : '?'));

/**
 * 改标记的一个写口（名字 / 类型 / 坐标都走这里 → store 一条 undo + 写闸门）。
 * @returns {boolean} 是否真的改了（只读 / 非法值 / 找不到目标时为 false，**且什么都不写**）
 */
function applyMarkerPatch(patch) {
  const sc = selectedScenario.value;
  if (!sc || !selectedMarker.value) return false;
  if (store.isReadOnly) {
    statusMsg(`改标记已停用：${store.readOnlyReason || '只读：未打开项目'}`);
    return false;
  }
  const res = store.updateScenarioMarker(sc.id, markerRefOf(), patch);
  if (!res || res.ok === false) {
    statusMsg(`改标记失败（${(res && res.reason) || '未知原因'}）—— 数据没有变`);
    return false;
  }
  selectedMarker.value = res.marker;
  render();
  return true;
}

function onMarkerNameChange(e) {
  const name = String(e.target.value || '').trim();
  if (!name) {
    e.target.value = selectedMarker.value?.name || '';
    statusMsg('标记名不能留空 —— 已恢复原值（没写任何东西）');
    return;
  }
  if (applyMarkerPatch({ name })) statusMsg(`标记已改名「${name}」（可 Ctrl+Z 撤回）`);
}

function onMarkerTypeChange(e) {
  const def = MARKER_TYPES.find(t => t.id === String(e.target.value || '')) || MARKER_TYPES[0];
  // 图标/颜色跟着类型走：画布按 m.icon / m.color 渲染，只改 type 会"类型变了、图标没变"
  if (applyMarkerPatch({ type: def.id, icon: def.icon, color: def.color })) {
    statusMsg(`标记类型已改为「${def.name}」（可 Ctrl+Z 撤回）`);
  }
}

function onMarkerCoordChange(axis, e) {
  // ⚠️ `Number('') === 0` —— 输入框被清空时必须判为非法，不能"顺手把坐标写成 0"
  //    （那会是一个用户没打算执行的静默移动）
  const raw = String(e.target.value == null ? '' : e.target.value).trim();
  const v = raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(v)) {
    e.target.value = markerCoords.value[axis];
    statusMsg('坐标必须是有限数字 —— 已恢复原值（没写任何东西）');
    return;
  }
  if (applyMarkerPatch({ [axis]: v })) statusMsg(`标记坐标 ${axis.toUpperCase()} → ${v}（可 Ctrl+Z 撤回）`);
}

function deleteSelectedMarker() {
  const sc = selectedScenario.value;
  const cur = selectedMarker.value;
  if (!sc || !cur) return;
  if (store.isReadOnly) { statusMsg(`删除标记已停用：${store.readOnlyReason || '只读：未打开项目'}`); return; }
  const name = cur.name || '（未命名标记）';
  const res = store.removeScenarioMarker(sc.id, markerRefOf());
  if (!res || res.ok === false) { statusMsg(`删除标记失败（${(res && res.reason) || '未知原因'}）`); return; }
  closeMarkerEditor();
  statusMsg(`已删除标记「${name}」（可 Ctrl+Z 撤回；底图与省份一个都没动）`);
  render();
}

// 选中省份 / 换剧本 → 收起标记面板（面板占用同一块右侧位置）
watch(selectedProvince, (p) => { if (p) closeMarkerEditor(); });
watch(() => selectedScenario.value?.id, () => { closeMarkerEditor(); });
// store 每次写都会把 `scenarios` 换成新对象 → `selectedScenario` 被重新指向（见 onMounted 里的
// `watch(sortedScenarios…)`）→ 这里把面板指向**新的**标记对象；标记被撤销删掉时收起面板。
watch(selectedScenario, () => { refreshSelectedMarker(); });


/**
 * 势力标注的**归属查询**：必须与 `getProvinceColor` 走同一口径
 * （含「演变铺开」与 EU4 斜线占领的旧主底色），否则会出现「颜色是甲、名字写乙」。
 * 势力对象还必须在 **owner 所属的那个剧本**里查 —— 真实数据每个剧本的 polity id 全新
 * （`pol_ou → pol_li`），跨剧本查会落空 → 标签整片消失（颜色那条路径已因此踩过一次）。
 */
// polityLabelSources 已搬到 misc.js（2026-10-31）


// ══════════════════════════════════════
// 文字层（N1 刀 1：实现已搬到 `scenario/layers/labels.js`）
// ══════════════════════════════════════
//
// 排布结论（四档合一 + 避让 + 档位滞回）全在层模块里；本文件只留**一个兼容出口**：
// 用例按 `SM.getLabelPlan()` 读结论（test_149/156/159/162 都在用），别让探针跟着搬家。
function getLabelPlan() {
  return labelLayers.getPlan(makeLayerView());
}

let smallCanvasWarned = false;
// handleResize 已搬到 helpers.js（2026-10-31）


// ═══════════════════════════════════════════
// v2 智能放置与派生
// ═══════════════════════════════════════════

// placeSmartBurg 已搬到 actions.js（2026-10-31）


function openBurgEditor(burg) {
  editingBurg.value = { ...burg };
  burgEditorOpen.value = true;
}

// saveBurgEditor 已搬到 actions.js（2026-10-31）


function closeBurgEditor() {
  burgEditorOpen.value = false;
  editingBurg.value = null;
}

// generateAndShowRivers 已搬到 rivers.js（2026-10-31）


function deriveLayers() {
  store.deriveAllLayers(baseMapKey.value);
  render();
}

// exportPNG 已搬到 actions.js（2026-10-31）

let resizeObserver = null;

onMounted(async () => {
  const cvs = canvas.value;
  const wrap = canvasWrap.value;
  {
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    canvasDpr = dpr;
    cvs.width = Math.round(w * dpr);
    cvs.height = Math.round(h * dpr);
    cvs.style.width = w + 'px';
    cvs.style.height = h + 'px';
  }
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
  // 右键菜单的**真入口**（2026-10-07）：只 preventDefault 不开菜单 = 省份右键功能整片点不到
  cvs.addEventListener('contextmenu', (e) => { e.preventDefault(); openProvinceContextMenu(e); });
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

  // 剧本集：数据到了才定"当前是哪一组"（落到第一条剧本所在的组；全空则默认组）
  resetGroupForBaseMap();
  // 数据**晚于挂载**到达（scenarios.json / 导入项目）时兜底：当前组一条都没有、别的组有 → 跟过去。
  // 只在这条「当前组为空」的窄条件下切，用户手动切到空组不会被弹走（空组是合法状态）。
  watch(allSortedScenarios, (list) => {
    if (!list.length) return;
    if (!list.some((x) => scenarioGroupIdOf(x) === activeGroupId.value)) {
      activeGroupId.value = scenarioGroupIdOf(list[0]);
    }
  }, { deep: false });

  // 时间轴游标落到第一个剧本（数据可能刚由 scenarios.json 异步载入）
  resetTimelineToStart();
  setTimeout(resetTimelineToStart, 300);

  // 卡片墙带来的初始剧本（2026-10-17 P0）：选中它 + 落到它的起始年。
  // 🔴 必须排在上面 300ms 的 resetTimelineToStart **之后**（320ms）—— 排前面会被它盖回第一个剧本。
  //    卡片可能来自**另一张底图**：先切 baseMapKey（sortedScenarios 按它过滤，不切就找不到）。
  if (props.initialScenarioId) {
    const s = store.scenarios?.[props.initialScenarioId];
    if (s?.ownerKey && store.baseMaps?.[s.ownerKey] && s.ownerKey !== baseMapKey.value) {
      baseMapKey.value = s.ownerKey;
    }
    // 卡片可能来自**别的剧本集**：先切到它那一组，否则 320ms 后按当前组找不到它
    if (s) activeGroupId.value = scenarioGroupIdOf(s);
    setTimeout(() => {
      const target = sortedScenarios.value.find((x) => x && x.id === props.initialScenarioId);
      if (target) selectScenarioAt(target);
    }, 320);
  }
  if (props.openManager) showScenarioManager.value = true;

  // 🔴 游标监听必须**在这里**注册（不能在 setup 顶层）：顶层 watch 会在挂载前求值一次并
  //    触发 render()，那一帧用的是未适屏相机 (0,0,1) →「首帧 = 空画布」（test_61 抓到的帧序：
  //    t=1059 空帧 → t=1067 才适屏）。与上面 `watch(sortedScenarios…)` 同一条纪律。
  watch(() => tlDate.value.y, (yy) => {
    const tl = timeline.value;
    if (!tl.years.length) return;
    const k = eraIndexOfYear(tl, yy);
    if (k !== tlEra.value) tlEra.value = k;
    render();
  });
  // 月日变化也要重绘（同一年内 6 月前后归属不同，底色/标签随之切换）
  watch(() => [tlDate.value.m, tlDate.value.d], () => { render(); });
});

onUnmounted(() => {
  if (resizeObserver) resizeObserver.disconnect();
  if (settleFitTimer) { clearTimeout(settleFitTimer); settleFitTimer = null; }
  // 🔴 帧合并的 rAF 也要清（与「谁建了定时器就要清」同一条纪律）：
  //    卸载后回调仍会跑 `render()` → `ctx` 已失效 → 抛进渲染护栏 → 控制台刷错误。
  if (rafRenderId != null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(rafRenderId);
    rafRenderId = null;
  }
  // 🔴 `provinceGridTimer` 是格点模型（P2 前）的遗留引用 —— 那个变量**全仓从未声明**，
  //    于是卸载时这里必抛 `ReferenceError: provinceGridTimer is not defined`（0.2.3 用户实测崩溃，
  //    Vue 报在 `runtime-um`＝卸载钩子上）。网格渲染已随 P2 退役，正确做法是删掉它。
  //    顺带补上真正缺的一条：折线预览的 30ms 防抖定时器此前**没人清**（卸载后回调仍会跑
  //    `store.previewSplitAlong` + `render()`）—— 卸载清理清单要与「谁建了定时器」一一对应。
  if (polySplitPreviewTimer) { clearTimeout(polySplitPreviewTimer); polySplitPreviewTimer = null; }
  if (tlRafId != null) { cancelAnimationFrame(tlRafId); tlRafId = null; }
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('sitian:history-jump', onHistoryJump);
  if (snapMarkerTimer) { clearTimeout(snapMarkerTimer); snapMarkerTimer = null; }
  if (snapFeedbackTimer) { clearTimeout(snapFeedbackTimer); snapFeedbackTimer = null; }
  endStrokeBase();          // 卸载后残留的"手势期基帧"没有任何用处，留着只是占内存
  // 手势闸门同理：卸载时手还按着（切视图/关项目）就不能把闸门留在"进行中"，
  // 否则自动保存会被顺延到 5s 上限才强制写一次（见 interactionGate.js 的口径 ②）
  if (canvasGateArmed) { endInteraction('scenario-canvas'); canvasGateArmed = false; }
  rasterCache.clear();
});

function onHistoryJump() {
  // 撤销/重做后重新对齐选中引用（updateBaseProvince 会生成新对象）
  const sp = selectedProvince.value;
  if (sp) {
    const fresh = baseMap.value?.terrain?.find(p => p.id === sp.id);
    if (fresh && fresh !== sp) selectedProvince.value = fresh;
  }
  pruneProvinceSelection();     // 省份表变了 → 多选集合里已不存在的 id 必须剔除
  render();
}
// ⚠️ `riverSource`（河流来源）必须在这里 —— 漏了就是"下拉改了画布没反应"
//    （本项目在高度图着色档位上踩过同一条：test_69 抓到过 `diffPixels: 0`）。
// ⚠️ `riverSource`（河流来源）必须在这里 —— 漏了就是"下拉改了画布没反应"
// ⚠️ `terrainShade` / `terrainShadeStrength` 同理（2026-10-17 第七修）：漏了就是"勾了立体没反应"
watch([rasterLayer, showRivers, riverSource, showRoutes, colorMode, showBiomes, showBorders, showLabels, showPlaceNames, showPolityLabels, showProvinceNames, showTerrainNames, terrainShade, terrainShadeStrength], () => render());
// 🔴 手势期基帧的**安全阀**（2026-10-18 第十八修·二）：只要底图几何/河网换了引用
//    （撤销、别的入口写入、导入…），立刻解甲 —— 底图变了还贴旧图就是"改了数据画面不动"。
//    启用基帧的前提本来就是"这一笔不改数据"，这条 watch 是**把前提落实成机制**，
//    而不是靠"我记得不要在拖笔里写库"这种注释纪律。
watch(
  [() => baseMap.value?.terrain, () => baseMap.value?.rivers, () => baseMap.value?.heightmap,
   () => autoRivers.value, () => autoRiverSegments.value],
  () => { if (strokeBaseArmed) endStrokeBase(); },
);
// 切换底图 → 作废离屏栅格缓存（不同地图的网格数据不同）
watch(baseMapKey, () => {
  rasterCache.clear();
  overlayLayers.invalidateMinimap();               // 换图 → 小地图缩略图与包围盒都要重算
  // 剧本集按底图重选：落到这张底图第一条剧本所在的组（不同底图通常就是不同时间线）
  resetGroupForBaseMap();
  // Phase 3：省份网格随底图切换（目标省份、省界缓存、套索态都要重置）
  provBrushTarget.value = 1;
  provStrokeActive = false;
  provLassoActive = false;
  provLassoPoints.value = [];
  provinceBrush.invalidateBorders();
  render();
});

// P1（2026-10-13）：换省份 / 换活动环就丢掉顶点框选 —— 框选存的是**活动环上的下标**，
// 换了省或换了环之后那些下标指向的是别的顶点（不丢就会"拖这个省、改那个省"）。
watch([() => selectedProvince.value?.id, activeRingIdx], () => {
  if (vertexSelection.value.length) vertexSelection.value = [];
  vertexMarquee.value = null;
  vertexMarqueeStart = null;
  vertexLinkCtx = null;
});

// 🔴 底图数据可能**晚于组件挂载**到达：只读态（未打开项目）下底图导入被写闸门拒绝、//    项目里暂时没有底图后再「导入知识库内容」、外部导入 scenarios.json……
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

// 换图时自动适应视图；**同一张图上增减省份一律不动镜头**（只重绘）
watch([baseMapKey, () => baseMap.value?.terrain?.length || 0], ([key, count]) => {
  if (!count) return;
  if (key === lastFitKey && count === lastFitCount) return;
  const mapChanged = key !== lastFitKey;
  lastFitKey = key;
  lastFitCount = count;
  // 🔴 2026-10-24（镜头语义一刀）：「省数变了」**不再**是适屏的理由。
  //    原来只豁免 `provincePaint`（笔刷建省），自由绘制没豁免 —— 实测（`_probe_land_camera.js`）：
  //    先把镜头挪到 {x:67.6,y:-53.5,scale:0.3549}，画一个省，松手后 800ms 内镜头变成
  //    {x:45.3,y:-50.3,scale:0.4894} —— **每画一个省，镜头自己重新适屏**，既是第三遍全量重绘，
  //    也是用户说的"手一松镜头就跳"。
  //    为什么可以干脆不认它：真正需要适屏的入口**都已经自己调了 fitToView()** ——
  //    · 打开/切换底图：`onMounted` 首帧 + `watch(immersive)` + 本 watch 的 mapChanged 分支；
  //    · 导入 .map（含"刷新底图数据"）：导入流程末尾的 `setTimeout(fitToView, 50)`；
  //    · 项目/底图装载：组件重挂 → onMounted。
  //    计数照样记账（lastFitKey/lastFitCount）：切走工具后不会"还欠一次适屏"而突然跳一下。
  if (!mapChanged) { render(); return; }
  setTimeout(fitToView, 50);
});

// 🔴 2026-10-24（1-b 收口）：**去掉 deep** —— 这里要的只是「这张底图换对象了」。
//    原来 `{ deep: true }` 让 Vue 每次变化都 `traverse` **整份底图**（200 省 + 160 河 + 9975 格高度图）：
//    CPU 采样里 **77ms/次**，比它触发的那次重绘（冷帧 35ms）还贵，且每次都发生在松手后的同一帧里。
//    为什么可以只认引用：本仓所有底图写入都是**整体替换**（`baseMaps.value = {...baseMaps.value, [key]: {...bm, …}}`，
//    见 scenarioEditing / provinceEditing 的 60+ 处写入；高度图走 `commitHeightmap` 同样是换对象）。
//    `baseMap` 是 `store.baseMaps[key]` 的计算属性 → 写入换对象 = 引用变 = 这里必触发；
//    而"写了别的底图"不会换这张的对象 → 也不会误触发（deep 反而会）。
//    ⚠️ 若将来出现**就地改**底图几何（`prov.points[i].x = …` 这种），这里会漏一次重绘 ——
//       那种写法本身就是本仓的禁区（改几何一律走 store 写口换数组），必须改写法而不是把 deep 加回来。
watch(baseMap, () => {
  // updateBaseProvince 会生成新对象，重新对齐选中引用，避免读到旧数据
  const sp = selectedProvince.value;
  if (sp) {
    const fresh = baseMap.value?.terrain?.find(p => p.id === sp.id);
    if (fresh && fresh !== sp) selectedProvince.value = fresh;
  }
  overlayLayers.invalidateMinimap();          // 几何变了 → 小地图缩略图与包围盒作废（否则省界改了缩略图不动）
  render();
});
// ── 交互工厂（放在最后：ctx 会立即读取各绑定，必须等它们全部初始化）──
// ── N1 第三阶段：指针手势（2026-10-31）───────────────────────────────────────
// 手势期的普通 `let` 状态放在一个**带 get/set 的对象**里：搬出组件后仍然读写同一份变量
// （直接传值只会拷一份 —— keyboard 那刀已踩过一次）。
const pointerState = {
  get canvasGateArmed() { return canvasGateArmed; },
  set canvasGateArmed(v) { canvasGateArmed = v; },
  get suppressTerrainPickClick() { return suppressTerrainPickClick; },
  set suppressTerrainPickClick(v) { suppressTerrainPickClick = v; },
  get pendingRiverPick() { return pendingRiverPick; },
  set pendingRiverPick(v) { pendingRiverPick = v; },
  get riverPressHandled() { return riverPressHandled; },
  set riverPressHandled(v) { riverPressHandled = v; },
  get suppressRiverClick() { return suppressRiverClick; },
  set suppressRiverClick(v) { suppressRiverClick = v; },
  get vertexMarqueeStart() { return vertexMarqueeStart; },
  set vertexMarqueeStart(v) { vertexMarqueeStart = v; },
  get freeTrace() { return freeTrace; },
  set freeTrace(v) { freeTrace = v; },
  get freeTraceActive() { return freeTraceActive; },
  set freeTraceActive(v) { freeTraceActive = v; },
  get suppressDrawClick() { return suppressDrawClick; },
  set suppressDrawClick(v) { suppressDrawClick = v; },
  get ownerStrokeActive() { return ownerStrokeActive; },
  set ownerStrokeActive(v) { ownerStrokeActive = v; },
  get provPaintActive() { return provPaintActive; },
  set provPaintActive(v) { provPaintActive = v; },
  get provStrokeActive() { return provStrokeActive; },
  set provStrokeActive(v) { provStrokeActive = v; },
  get provLassoActive() { return provLassoActive; },
  set provLassoActive(v) { provLassoActive = v; },
  get isPanning() { return isPanning; },
  set isPanning(v) { isPanning = v; },
  get cameraMotion() { return cameraMotion; },
  set cameraMotion(v) { cameraMotion = v; },
  get cameraSettleTimer() { return cameraSettleTimer; },
  set cameraSettleTimer(v) { cameraSettleTimer = v; },
  get isBrushing() { return isBrushing; },
  set isBrushing(v) { isBrushing = v; },
  get vertexLinkCtx() { return vertexLinkCtx; },
  set vertexLinkCtx(v) { vertexLinkCtx = v; },
  get brushMode() { return brushMode; },
  set brushMode(v) { brushMode = v; },
  get ownerLastSample() { return ownerLastSample; },
  set ownerLastSample(v) { ownerLastSample = v; },
  get panStart() { return panStart; },
  set panStart(v) { panStart = v; },
  get riverDraftCapped() { return riverDraftCapped; },
  set riverDraftCapped(v) { riverDraftCapped = v; },
  get altStraight() { return altStraight; },
  set altStraight(v) { altStraight = v; },
  get freeTraceRejectReason() { return freeTraceRejectReason; },
  set freeTraceRejectReason(v) { freeTraceRejectReason = v; },
  get initialFitPending() { return initialFitPending; },
  set initialFitPending(v) { initialFitPending = v; },
  get ownerStrokeIds() { return ownerStrokeIds; },
  set ownerStrokeIds(v) { ownerStrokeIds = v; },
  get riverPreviewCache() { return riverPreviewCache; },
  set riverPreviewCache(v) { riverPreviewCache = v; },
  get tracePreviewCache() { return tracePreviewCache; },
  set tracePreviewCache(v) { tracePreviewCache = v; },
  get autoRiverPartsCache() { return autoRiverPartsCache; },
  set autoRiverPartsCache(v) { autoRiverPartsCache = v; },
  get autoRiverNetCache() { return autoRiverNetCache; },
  set autoRiverNetCache(v) { autoRiverNetCache = v; },
  get displayRiverCache() { return displayRiverCache; },
  set displayRiverCache(v) { displayRiverCache = v; },
  get seaDetailCache() { return seaDetailCache; },
  set seaDetailCache(v) { seaDetailCache = v; },
  get _mapSizeCache() { return _mapSizeCache; },
  set _mapSizeCache(v) { _mapSizeCache = v; },
  get pendingReimportBundle() { return pendingReimportBundle; },
  set pendingReimportBundle(v) { pendingReimportBundle = v; },
  get canvasDpr() { return canvasDpr; },
  set canvasDpr(v) { canvasDpr = v; },
  get smallCanvasWarned() { return smallCanvasWarned; },
  set smallCanvasWarned(v) { smallCanvasWarned = v; },
  get lastStatusAt() { return lastStatusAt; },
  set lastStatusAt(v) { lastStatusAt = v; },
};

// 河流动作工厂要在指针三件**之前**：它们的 ctx 直接引用 finishRiverDraft 等 const
const { getSeaDetail, mapWorldSize, riverWidthSeries, applyReimportDialog, autoSeedBatch, onWheel, fitToView, handleResize } = createHelperActions({
  st: pointerState,
  baseMap,
  baseMapKey,
  batchOpts,
  batchSeeds,
  batchStatus,
  brushRadius,
  brushStrength,
  cameraScale,
  cameraX,
  cameraY,
  canvas,
  canvasWrap,
  closeReimportDialog,
  endStrokeBase,
  getSeaDistanceField,
  markCameraMotion,
  provinceHint,
  px,
  rasterLayer,
  reimportDialog,
  render,
  riverWidthSeriesCache,
  screenToWorld,
  statusMsg,
  store,
  tool,
});

const { finishRiverDraft, riverWidthsFor, makeRiverLandCheck, strokeRiverNetworkAsPaths, autoRiverPartsFor, clipSelectedRiversToCoast, generateAndShowRivers } = createRiverActions({
  st: pointerState,
  RIVER_BRUSH_MIN_POINTS,
  RIVER_MIN_SCREEN_CAP_PX,
  RIVER_MIN_SCREEN_PX,
  RIVER_PATH_CONTROL_POINTS,
  RIVER_PATH_MAX,
  RIVER_PATH_MIN_POINTS,
  RIVER_SMOOTH_SOURCE_HEIGHT,
  RIVER_WIDTH_DATA_SCALE,
  RIVER_WIDTH_DEFAULT,
  RIVER_WORLD_FLOOR,
  SEA_LEVEL_FOR_RIVER,
  autoRiverDrawn,
  autoRiverMaxFlow,
  autoRiverSegments,
  autoRivers,
  baseMap,
  baseMapKey,
  cameraScale,
  countCrossingsWithExisting,
  countPolylineCrossings,
  countSelfCrossings,
  getLandMask,
  handDrawnRivers,
  px,
  render,
  riverDraft,
  riverDraftParentId,
  riverDraftParentSeg,
  riverFlowGate,
  riverNodesFromDraft,
  riverSelIds,
  riverSelList,
  riverSmooth,
  riverSmoothPasses,
  riverSmoothRadius,
  riverSourceHeight,
  riverTerrainAdvice,
  selectedRiverId,
  smoothRadius,
  snapToPolyline,
  statusMsg,
  store,
});
const { applyRiverPick, deleteSelectedRiver, commitRiverDrag, drawOneHandRiver, withBezierControls, onBatchSeedClick, updateCursor, onSetChangeDatesBulk } = createRiverOps({
  st: pointerState,
  PROVINCE_GRID_TOOLS,
  RIVER_CURVE_SUBDIV,
  baseMap,
  baseMapKey,
  batchSeeds,
  batchStatus,
  canvas,
  closeMarkerEditor,
  px,
  render,
  riverDrag,
  riverSelIds,
  riverWidthsFor,
  selectedProvince,
  selectedRiver,
  setRiverSelection,
  showProps,
  statusMsg,
  store,
  toggleRiverSelection,
  tool,
  vx,
  vy,
});


const { handleSplitClick, ctxDuplicateProvince, addProvinceWithOverlapGate, buildProvincePath, confirmVertexBatchOverlap, beginVertexLinkContext, confirmVertexMoveOverlap, buildLinkedPreview } = createProvinceOps({
  st: pointerState,
  VERTEX_OVERLAP_WORSEN_MARGIN,
  activeRingIdx,
  baseMap,
  baseMapKey,
  coincidentIndexFor,
  contextMenu,
  effectiveVertexSelection,
  provIdxOf,
  provinceBrush,
  px,
  render,
  resolvePoints,
  selectedProvince,
  splitPoints,
  splitStep,
  statusMsg,
  store,
  vx,
  vy,
});

// misc 在 provinceOps 之后（它用到 addProvinceWithOverlapGate），在 province 之前
const { ctxDeleteProvince, clearAllScenarios, getAutoRiverNetwork, getDisplayRivers, finishDraw, removeSelectedRiverNode, riversInBox, traceShapePath, findBurgAt, polityLabelSources, switchGroup, onDeletePolity, applyLandmassResult, synthesizeBaseMapTerrainFromShape } = createMiscActions({
  st: pointerState,
  BURG_HIT_RADIUS,
  SNAP_EDGE_THRESHOLD,
  activeGroupId,
  addProvinceWithOverlapGate,
  allSortedScenarios,
  autoRiverSegments,
  autoRivers,
  baseMap,
  baseMapHasHeightmap,
  baseMapKey,
  burgs,
  cameraScale,
  cameraX,
  cameraY,
  contextMenu,
  drawPoints,
  focusNewProvince,
  getLandMask,
  groupNameOf,
  landmassOpen,
  makeRiverLandCheck,
  rasterCache,
  rasterLayer,
  render,
  riverActiveNode,
  riverNodesForRender,
  scenarios,
  segmentHitsBox,
  selectScenarioAt,
  selectedPolity,
  selectedProvince,
  selectedRiver,
  selectedScenario,
  showProps,
  sortedScenarios,
  statusMsg,
  store,
  terrainShade,
  timeline,
  tlDate,
  tlDiffMode,
  tlEra,
  tlPlaying,
  vx,
  vy,
});

const { freeTraceRing, commitOutlineTrace, commitFreeTrace, finishPolySplit, handleMergeClick, getProvinceColor, setTool } = createProvinceActions({
  st: pointerState,
  BASEMAP_TOOL_IDS,
  BIOME_COLORS,
  PROVINCE_GRID_TOOLS,
  SNAP_EDGE_THRESHOLD,
  activeVertexIdx,
  addProvinceWithOverlapGate,
  baseMap,
  baseMapKey,
  basemapEditMode,
  brushPreview,
  clearPolySplit,
  clearSnapMarker,
  colorMode,
  dragPreview,
  draggingHandle,
  draggingVertex,
  drawPoints,
  endStrokeBase,
  ensureBaseMap,
  findProvinceAt,
  focusNewProvince,
  hoveredBurg,
  lockCoast,
  mergeProvId,
  mergeStep,
  outlineToNeighbor,
  polySplitHover,
  polySplitKeepStart,
  polySplitPoints,
  polySplitPreview,
  polySplitTarget,
  provBrushPreview,
  provBrushTarget,
  provLassoPoints,
  provinceBrush,
  rawTerrain,
  render,
  riverActiveNode,
  riverDraft,
  riverDrag,
  riverEraseStroke,
  riverMarquee,
  roadPath,
  roadStart,
  scenarios,
  selectedProvince,
  selectedRiverIds,
  selectedScenario,
  showBiomes,
  showProps,
  skeletonForTerrain,
  splitPoints,
  splitStep,
  statusMsg,
  store,
  timeline,
  tlDate,
  tlDiffMode,
  tlEra,
  tool,
  unownedProvinceColor,
  updateCursor,
  vertexEditMode,
  vertexMarquee,
  vertexSelection,
  viewMode,
});

const { exportPNG, createNewScenario, saveEditScenario, onSetChangeDate, tlFrame, placeSmartBurg, saveBurgEditor, commitOwnerStroke, commitRiverErase } = createActionHandlers({
  st: pointerState,
  BURG_SIZES,
  RIVER_ERASE_RADIUS_PX,
  TL_ERA_MS,
  activeGroupId,
  allSortedScenarios,
  baseMap,
  baseMapKey,
  burgEditorOpen,
  burgs,
  cameraScale,
  cameraX,
  cameraY,
  cancelEditScenario,
  canvas,
  ch,
  clearOwnerMode,
  ctx,
  cw,
  daysInMonthOf,
  editingBurg,
  editingScenarioId,
  handDrawnRivers,
  labelLayers,
  makeLayerView,
  newScenario,
  px,
  render,
  riverEraseStroke,
  scenarioFormBlank,
  scenarios,
  selectScenario,
  selectScenarioAt,
  selectedBurgSize,
  selectedPolity,
  selectedScenario,
  showBurgs,
  showPlaceNames,
  showScenarioManager,
  statusMsg,
  store,
  timeline,
  tlDate,
  tlDateText,
  tlEra,
  tlPlaying,
});

const { onMouseUp } = createPointerHandlers({
  st: pointerState,
  endInteraction,
  endStrokeBase,
  terrainLabelPick,
  statusMsg,
  render,
  riverMarquee,
  normalizeBox,
  canvas,
  riversInBox,
  setRiverSelection,
  applyRiverPick,
  tool,
  riverDrag,
  commitRiverDrag,
  riverDraft,
  finishRiverDraft,
  vertexMarquee,
  currentProvince,
  resolvePoints,
  verticesInBox,
  baseMap,
  findLinkedVertices,
  provIdxOf,
  activeRingIdx,
  coincidentIndexFor,
  FREE_TRACE_MIN_POINTS,
  commitOutlineTrace,
  commitFreeTrace,
  commitOwnerStroke,
  store,
  provinceBrush,
  provBrushTool,
  lockCoast,
  provLassoPoints,
  provBrushTarget,
  riverEraseStroke,
  commitRiverErase,
  updateCursor,
  draggingHandle,
  dragPreview,
  writeRingPoints,
  draggingVertex,
  clearSnapMarker,
  collectLinkedPatches,
  confirmVertexBatchOverlap,
  confirmVertexMoveOverlap,
  selectedProvince,
  vertexSelection,
  baseMapKey,
});

const { onMouseMove } = createMoveHandlers({
  st: pointerState,
  OWNER_BRUSH_SAMPLE_PX,
  PROVINCE_GRID_TOOLS,
  RIVER_BRANCH_SNAP_PX,
  RIVER_ERASE_MIN_STEP_PX,
  RIVER_MAX_DRAFT_POINTS,
  TERRAIN_PICK_MIN_STEP,
  baseMap,
  baseMapKey,
  brushBiome,
  brushCulture,
  brushPreview,
  brushRadius,
  brushReligion,
  brushStrength,
  buildLinkedPreview,
  cameraScale,
  cameraX,
  cameraY,
  canvas,
  dragPreview,
  draggingHandle,
  draggingVertex,
  effectiveVertexSelection,
  handDrawnRivers,
  hitRiverNodeIndex,
  markCameraMotion,
  moveRiverNodeTo,
  ownerStrokeSample,
  placeSmartBurg,
  pokeCapsule,
  polySplitHover,
  provBrushPreview,
  provBrushWorldRadius,
  provLassoPoints,
  provinceBrush,
  provinceBrushOpts,
  px,
  render,
  renderCoalesced,
  resolvePoints,
  resolveSnapPoint,
  riverActiveNode,
  riverDraft,
  riverDraftParentId,
  riverDrag,
  riverEraseStroke,
  riverMarquee,
  roadPath,
  roadStart,
  screenToWorld,
  setSnapMarker,
  snapMarker,
  snapToEdge,
  snapToEdgeEnabled,
  snapToPolyline,
  statusMsg,
  store,
  terrainLabelPick,
  tool,
  updateBurgHover,
  vertexMarquee,
  vx,
  vy,
});

const { onMouseDown } = createDownHandlers({
  st: pointerState,
  CREATES_CONTENT_TOOLS,
  PROVINCE_GRID_TOOLS,
  RIVER_SELECT_HIT_PX,
  activeRingIdx,
  activeVertexIdx,
  baseMap,
  baseMapKey,
  beginStrokeBase,
  beginVertexLinkContext,
  brushBiome,
  brushCulture,
  brushRadius,
  brushReligion,
  brushStrength,
  cameraScale,
  canvas,
  clearOwnerMode,
  colorMode,
  currentProvince,
  draggingHandle,
  draggingVertex,
  ensureBaseMap,
  hitHandRiverBranchAnchor,
  hitRiverNodeIndex,
  nextOwnerStrokeId,
  ownerStrokeSample,
  pickPolityAt,
  provBrushPreview,
  provBrushWorldRadius,
  provLassoPoints,
  provinceBrush,
  provinceBrushOpts,
  provinceTargets,
  px,
  rasterLayer,
  render,
  resolvePoints,
  riverActiveNode,
  riverDraft,
  riverDraftParentId,
  riverDraftParentSeg,
  riverDrag,
  riverEraseStroke,
  riverMarquee,
  riverNodesForRender,
  screenToWorld,
  selectPolity,
  selectedPolity,
  selectedProvince,
  selectedRiver,
  selectedScenario,
  showSnapFeedback,
  statusMsg,
  store,
  terrainLabelPick,
  tool,
  vertexMarquee,
  vertexSelection,
  viewMode,
  vx,
  vy,
  withBezierControls,
  writeRingPoints,
  provBrushTarget,
});

const { onKeyDown, onKeyUp } = createKeyboardHandlers({
  tool, selectedRiver, riverSelIds, setRiverSelection, statusMsg, render,
  setTool, fitToView, isEditableTarget, nextTick,
  deleteSelectedRiver, removeSelectedRiverNode, clearSnapMarker, clearProvinceSelection,
  finishPolySplit, schedulePolySplitPreview, finishDraw,
  riverDraft, riverDrag, riverActiveNode,
  drawPoints, splitStep, splitPoints, mergeStep, mergeProvId,
  contextMenu, selectedBurg, dragPreview, draggingHandle, activeVertexIdx,
  vertexSelection, vertexMarquee, polySplitPoints, polySplitHover, polySplitPreview,
  terrainLabelPick, immersive, baseMap,
  getAltStraight: () => altStraight,
  setAltStraight: (v) => { altStraight = v; },
  setSuppressRiverClick: (v) => { suppressRiverClick = v; },
  setVertexMarqueeStart: (v) => { vertexMarqueeStart = v; },
  setVertexLinkCtx: (v) => { vertexLinkCtx = v; },
});

</script>

<style scoped>
.scenario-map-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  /* 小窗口（或工具栏两行展开）时内容会超出——允许滚动，别把画布挤成 0 高 */
  overflow: auto;
  background: #0f1a2e;
  /* 沉浸顶条与底部胶囊都是绝对定位 —— 锚就是容器自己（缺这行它们会飞到最近的定位祖先上） */
  position: relative;
}

/* ══ 沉浸看图模式（2026-10-17 P0，暮雨拍板）══════════════════════════════════
   收起：顶栏（工具栏）/ 左栏剧本列表 / 底部时间轴 —— 地图占满（可视区 ~55% → ~95%）。
   保留：细顶条（返回/剧本名/年份/小地图/退出）+ 底部悬浮工具胶囊（主行 6 控件，
   8 秒无操作自动淡出、鼠标一动即回）+ 右下角小地图（可手动隐藏，偏好记住）。
   🔴 **能力一个都不减**：胶囊 = 原主行那 6 个控件；被收起的行/面板按 Ctrl+I 即回。
   🔴 细顶条不许改成绝对定位之外的定位方式 —— 它必须浮在画布上方且不吃画布高度
   （吃高度 = 适屏 fitToView 白算一次）。 */
.scenario-map-container.immersive { overflow: hidden; }
.immersive-bar {
  position: absolute; top: 0; left: 0; right: 0; z-index: 30;
  display: flex; align-items: center; gap: 14px;
  height: 30px; padding: 0 14px;
  background: rgba(10, 13, 19, 0.82);
  border-bottom: 1px solid rgba(48, 54, 61, 0.6);
  backdrop-filter: blur(4px);
}
.imb-title { color: #e6edf3; font-size: 12.5px; letter-spacing: 2px; font-weight: 600; }
.imb-year { color: #8b949e; font-size: 11.5px; letter-spacing: 1px; }
.imb-spacer { flex: 1; }
.imb-btn {
  background: transparent; border: 1px solid #30363d; color: #8b949e;
  font-size: 11px; padding: 3px 10px; border-radius: 5px; cursor: pointer; letter-spacing: 1px;
}
.imb-btn:hover { border-color: #58a6ff; color: #e6edf3; }
/* 沉浸态：工具栏变底部悬浮胶囊（只留主行）；左栏/时间轴收起 */
.scenario-map-container.immersive .scenario-toolbar {
  position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%);
  z-index: 25; flex-direction: row; align-items: center;
  background: rgba(22, 27, 34, 0.92);
  border: 1px solid #30363d; border-radius: 22px;
  padding: 6px 14px; max-width: 92vw;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  transition: opacity 0.35s;
}
.scenario-map-container.immersive .scenario-toolbar.dim { opacity: 0.08; }
.scenario-map-container.immersive .scenario-toolbar.dim:hover { opacity: 1; }
/* 沉浸态只留主行（其余行/面板收起 —— Ctrl+I 即回，能力不减） */
.scenario-map-container.immersive .toolbar-row:not(.primary-row) { display: none; }
.scenario-map-container.immersive .toolbar-more { display: none; }
.scenario-map-container.immersive .scenario-list-panel { display: none; }
.scenario-map-container.immersive .scenario-timeline-root { display: none; }

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
/* 剧本视图引导条：先选势力 → 涂归属 → 地图上涂 */
.scenario-onboarding {
  position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
  z-index: 30;
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  max-width: calc(100% - 20px);
  margin: 0;
  padding: 6px 10px;
  font-size: 12px;
  color: #cbd5e1;
  background: rgba(13, 23, 40, 0.92);
  border: 1px solid rgba(88, 166, 255, 0.38);
  border-radius: 7px;
  box-shadow: 0 4px 14px rgba(0,0,0,0.35);
}
.scenario-onboarding .so-step { white-space: nowrap; }
.scenario-onboarding .so-step b { color: #f0f6fc; }
.scenario-onboarding .so-add {
  padding: 2px 9px; font-size: 12px;
  background: #1f6feb; border: 1px solid #388bfd; border-radius: 6px; color: #fff; cursor: pointer;
}
.scenario-onboarding .so-add:hover { filter: brightness(1.12); }
.more-toggle { display: inline-flex; align-items: center; gap: 3px; padding: 0 8px; }
.more-toggle.has-advanced { box-shadow: inset 0 0 0 1px var(--accent); }
/* 底图编辑模式（2026-10-18 第十七修）：模式条在主行**之上**（模式是"状态"，不是工具栏按钮）。
   ⚠️ 它不能进 `.primary-row` —— 主行可见控件数由 test_65 / test_97 硬守 ≤6（放进去实测 7 个、两条红）。 */
.toolbar-modes {
  display: flex; align-items: center; gap: 10px; padding: 2px 4px 0;
}
.mode-hint { color: #94a3b8; font-size: 11px; letter-spacing: 0.5px; }
.basemap-edit-toggle { display: inline-flex; align-items: center; gap: 4px; padding: 2px 10px; font-size: 12px; }
.basemap-edit-toggle.active {
  background: #78350f; border-color: #d97706; color: #fde68a; font-weight: 600;
}
.basemap-row {
  border-left: 3px solid #d97706; padding-left: 8px; background: rgba(120, 53, 15, 0.18);
}
.basemap-row-label { color: #fbbf24; }
/* 底图编辑行末尾的出口：一眼可见、与地理工具同一条行，避免用户去点左上角的模块级返回 */
.basemap-exit {
  margin-left: auto;
  color: #fbbf24;
  border: 1px solid rgba(217, 119, 6, 0.55);
  background: rgba(120, 53, 15, 0.28);
  border-radius: 4px;
  padding: 2px 10px;
}
.basemap-exit:hover { background: rgba(120, 53, 15, 0.5); }
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
  /* 2026-10-09：按钮从「纯图标」改为「图标 + 文字」——
     暮雨实测「上面一堆工具但是根本看不懂」。固定 32px 方块保留为**最小**尺寸，
     有文字时自动撑开（横排规则见 .scenario-toolbar button）。 */
  min-width: 32px;
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

/* 批量铺底的「块数」数字输入（2026-10-11）：与下拉同一套配色 —— preflight 已关，
   表单控件不会自带 color: inherit，不显式设色就会是黑字黑底 */
.brush-number {
  width: 64px;
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

/* 省份多选批量条（2026-10-02）：与色板同一条视觉带，只在有选中时出现 */
.province-batch-bar {
  display: flex;
  gap: 6px;
  padding: 6px 12px;
  background: #10233a;
  border-bottom: 1px solid #1e5f7a;
  flex-wrap: wrap;
  align-items: center;
  font-size: 11px;
  color: #94a3b8;
}
.pbb-count b { color: #22d3ee; font-variant-numeric: tabular-nums; }
.pbb-sep { width: 1px; height: 16px; background: #1e5f7a; margin: 0 4px; }
.pbb-primary, .pbb-btn {
  background: #1e293b; border: 1px solid #475569; color: #cbd5e1;
  border-radius: 5px; padding: 3px 10px; font-size: 11px; cursor: pointer; font-family: inherit;
}
.pbb-primary { background: rgba(34, 211, 238, 0.18); border-color: #22d3ee; color: #a5f3fc; }
.pbb-primary:hover:not(:disabled), .pbb-btn:hover:not(:disabled) { background: #334155; }
.pbb-primary:disabled, .pbb-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.pbb-hint { color: #64748b; font-size: 10px; margin-left: 4px; }

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
/* 取色器不能继承上面那条 110px 文本输入宽度（原生 color 输入要小方块） */
.polity-editor input[type="color"] {
  width: 34px;
  height: 24px;
  padding: 0 2px;
  cursor: pointer;
}

/* 新建势力 / 删除势力（2026-10-01）：与色板同一套深色条观感 */
.polity-add,
.polity-del {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #1e293b;
  border: 1px dashed #64748b;
  border-radius: 4px;
  color: #cbd5e1;
  font-size: 11px;
  padding: 5px 9px;
  cursor: pointer;
}

.polity-add:hover:not(:disabled) { border-color: #ffd700; color: #ffd700; }

.polity-del {
  border-style: solid;
  border-color: #7f3b3b;
  color: #f0a8a8;
  margin-left: 4px;
}

.polity-del:hover:not(:disabled) { border-color: #f85149; color: #f85149; }
.polity-add:disabled,
.polity-del:disabled { opacity: 0.45; cursor: not-allowed; }

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

/* ── 批量铺底进行中的遮罩（C，2026-10-11）────────────────────────────────────
   两个职责：① 吃掉所有指针事件 —— 切 500 块的逐块布尔实测 ~19s，用户在画布上点的每一下
   都只会排队、回来一起执行（观感 = 越点越卡、像死机）；② 明确说清"在算什么 + 能取消"。 */
.scenario-busy-overlay {
  position: absolute;
  inset: 0;
  z-index: 25;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(11, 17, 28, 0.55);
  cursor: progress;
}

.scenario-busy-overlay .busy-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 16px 22px;
  border-radius: 8px;
  background: rgba(22, 32, 48, 0.96);
  border: 1px solid #3b4d66;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  color: #e2e8f0;
  max-width: 420px;
  text-align: center;
}

.scenario-busy-overlay .busy-spin { animation: sitian-busy-spin 1s linear infinite; color: #67e8f9; }
@keyframes sitian-busy-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  /* 动效敏感用户：不转，但**必须还看得见"在忙"** —— 所以保留图标与文字，只停动画 */
  .scenario-busy-overlay .busy-spin { animation: none; }
}

.scenario-busy-overlay .busy-title { font-size: 14px; font-weight: 600; }
.scenario-busy-overlay .busy-sub { font-size: 12px; color: #93e6f5; font-variant-numeric: tabular-nums; }
.scenario-busy-overlay .busy-hint { font-size: 11px; line-height: 1.6; color: #9aa7b8; }
.scenario-busy-overlay .busy-cancel,
.batch-cancel {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  padding: 4px 10px;
  font-size: 12px;
  color: #ffd9d9;
  background: rgba(120, 30, 40, 0.5);
  border: 1px solid #a3474f;
  border-radius: 4px;
  cursor: pointer;
}
.scenario-busy-overlay .busy-cancel:hover,
.batch-cancel:hover { background: rgba(150, 40, 52, 0.65); }

/* ── 历史剧本站首：常驻左栏（2026-10-09）────────────────────────────────────
   浮在画布左侧（不动 flex 布局：多一个 flex 兄弟会改分配比例，风险大）。
   可收起（只留标题条）。深色系与 .polity-palette / 状态栏同族。
   ⚠️ 按钮必须显式写 color —— 关掉 preflight 后 <button> 会落回浏览器 UA 的
   buttontext（Windows 浅色系统 ≈ 近黑），深底上会黑底黑字。 */
.scenario-list-panel {
  position: absolute;
  left: 10px;
  top: 10px;
  bottom: 10px;
  width: 236px;
  z-index: 6;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  background: rgba(23, 32, 51, 0.94);
  border: 1px solid #334155;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}
/* 🔴 2026-10-20：收起 = **整块收起**，不是只藏内容留一个 236×全高的空窗
   （用户实测：「那个侧边栏的收起按钮根本不能正确收起整个侧边栏，只是隐藏剧本内容，
   留下一个空窗占地方」）。收起后只剩一个 40px 的展开按钮，贴着左上角。 */
.scenario-list-panel.collapsed {
  width: 40px;
  bottom: auto;
  padding: 6px;
}
.scenario-list-panel.collapsed .slp-title,
.scenario-list-panel.collapsed .slp-hint,
.scenario-list-panel.collapsed .slp-picker {
  display: none;
}
.scenario-list-panel.collapsed .slp-head {
  padding: 0;
  border-bottom: 0;
  justify-content: center;
}
.slp-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 0 2px 6px;
  border-bottom: 1px solid #2b3a52;
}
.slp-title { color: #e2e8f0; font-size: 12px; font-weight: 600; }
.slp-hint { color: #64748b; font-size: 10px; flex: 1; }
.slp-toggle {
  background: transparent;
  border: 1px solid #475569;
  color: #94a3b8;
  border-radius: 4px;
  cursor: pointer;
  padding: 1px 4px;
  display: inline-flex;
  align-items: center;
}
.slp-toggle:hover { background: #334155; color: #e2e8f0; }
/* 换剧本（P0-1）：与收起按钮同族的小控件，常驻剧本列表头部（列表收起时也在） */
.slp-picker {
  background: #1e293b;
  border: 1px solid #475569;
  color: #cbd5e1;
  border-radius: 4px;
  cursor: pointer;
  padding: 1px 7px;
  font-size: 10px;
  font-family: inherit;
  white-space: nowrap;
}
.slp-picker:hover { background: #334155; color: #e2e8f0; border-color: #64748b; }
.slp-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; }
.slp-item {
  padding: 5px 7px;
  border: 1px solid #334155;
  border-radius: 6px;
  cursor: pointer;
  background: rgba(30, 41, 59, 0.6);
}
.slp-item:hover { background: #334155; border-color: #64748b; }
.slp-item.active { background: rgba(124, 58, 237, 0.22); border-color: #7c3aed; }
.slp-row1 { display: flex; align-items: baseline; gap: 5px; }
.slp-era { color: #94a3b8; font-size: 10px; min-width: 12px; }
.slp-name { color: #e2e8f0; font-size: 12px; }
.slp-item.active .slp-name { color: #fff; font-weight: 600; }
.slp-row2 { display: flex; align-items: baseline; gap: 6px; margin-top: 2px; }
.slp-years { color: #94a3b8; font-size: 10px; font-variant-numeric: tabular-nums; }
.slp-meta { color: #64748b; font-size: 10px; margin-left: auto; }
.slp-empty { color: #94a3b8; font-size: 11px; line-height: 1.7; padding: 6px 2px; }
.slp-empty b { color: #cbd5e1; }
.slp-manage {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  background: #1e293b;
  border: 1px solid #475569;
  color: #cbd5e1;
  border-radius: 6px;
  padding: 5px 8px;
  font-size: 11px;
  cursor: pointer;
  font-family: inherit;
}
.slp-manage:hover { background: #334155; }

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
.scenario-empty-hint .eh-line b { color: #e2e8f0; }
/* 🔴 空态容器是 `pointer-events: none`（不许挡住画布交互）—— 里面的按钮必须**逐个**收回
   事件（`auto`），否则「导入 .map 底图」是个看得见、点不动的假按钮。 */
.scenario-empty-hint .eh-actions {
  display: flex; justify-content: center; gap: 8px; margin-top: 12px; flex-wrap: wrap;
}
.scenario-empty-hint .eh-btn {
  pointer-events: auto;
  background: #1e293b; border: 1px solid #475569; color: #cbd5e1;
  border-radius: 6px; padding: 6px 12px; font-size: 12px; cursor: pointer; font-family: inherit;
}
.scenario-empty-hint .eh-btn:hover:not(:disabled) { background: #334155; color: #e2e8f0; }
.scenario-empty-hint .eh-btn.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
.scenario-empty-hint .eh-btn.primary:hover:not(:disabled) { filter: brightness(1.12); }
.scenario-empty-hint .eh-btn:disabled { opacity: 0.5; cursor: not-allowed; }
/* 空底图上的「第一笔」提示卡（2026-10-22） */
.empty-province-hint {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: 400px; max-width: calc(100% - 40px);
  padding: 16px 18px; border-radius: 10px; text-align: left;
  background: rgba(15, 23, 42, 0.94); border: 1px solid #334155;
  color: #cbd5e1; pointer-events: none; z-index: 6;
}
.empty-province-hint .eph-title { margin: 0 0 8px; font-size: 15px; font-weight: 600; color: #e2e8f0; }
.empty-province-hint .eph-steps { margin: 0 0 10px; padding-left: 18px; font-size: 12.5px; line-height: 1.9; }
.empty-province-hint .eph-steps b { color: #e2e8f0; }
.empty-province-hint .eph-btn {
  pointer-events: auto; cursor: pointer; font-family: inherit;
  background: #1f6feb; border: 1px solid #1f6feb; color: #fff;
  border-radius: 6px; padding: 6px 14px; font-size: 12.5px;
}
.empty-province-hint .eph-btn:hover { filter: brightness(1.12); }
.empty-province-hint .eph-note { margin: 10px 0 0; font-size: 11.5px; line-height: 1.65; color: #94a3b8; }
.empty-province-hint .eph-close {
  position: absolute; top: 6px; right: 8px; width: 20px; height: 20px; padding: 0;
  border: 0; border-radius: 4px; background: transparent; color: #94a3b8;
  font-size: 16px; line-height: 18px; cursor: pointer; pointer-events: auto;
}
.empty-province-hint .eph-close:hover { background: #334155; color: #e2e8f0; }

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

/* 渲染护栏横幅（画布正中；2026-10-14）—— 状态栏那行**不够**：
   用户盯着的是空白的画布，提示必须出现在他正在看的地方，并且必须给出错误原文。 */
.render-paused-card {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 30;
  width: min(560px, 78%);
  padding: 18px 22px;
  border: 1px solid #b45309;
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.94);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  color: #e2e8f0;
  text-align: left;
}
.render-paused-card .rp-title {
  display: flex; align-items: center; gap: 8px;
  font-size: 15px; font-weight: 700; color: #fbbf24;
}
.render-paused-card .rp-sub { margin-top: 8px; font-size: 12px; line-height: 1.7; color: #cbd5e1; }
.render-paused-card .rp-err {
  margin: 10px 0;
  padding: 8px 10px;
  max-height: 120px;
  overflow: auto;
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
  color: #fca5a5;
  background: rgba(0, 0, 0, 0.45);
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
}
.render-paused-card .rp-hint { font-size: 11px; line-height: 1.7; color: #94a3b8; }
.render-paused-card .rp-actions { margin-top: 12px; display: flex; gap: 10px; }
.render-paused-card .rp-btn {
  padding: 5px 14px;
  font-size: 12px;
  color: #e2e8f0;
  background: rgba(148, 163, 184, 0.12);
  border: 1px solid #475569;
  border-radius: 6px;
  cursor: pointer;
}
.render-paused-card .rp-btn.primary { color: #0f172a; background: #fbbf24; border-color: #fbbf24; font-weight: 600; }
.render-paused-card .rp-btn:hover { filter: brightness(1.12); }

/* 源头高度闸门（紧挨「自动河流」按钮）：宽度收窄，别把工具栏挤爆 */
.river-source-height {
  width: 54px;
  margin: 0 2px 0 4px;
  padding: 2px 4px;
  font-size: 12px;
  color: #e2e8f0;
  background: #0f172a;
  border: 1px solid #475569;
  border-radius: 4px;
}
/* 河流来源（紧挨闸门输入）：选项文字比闸门数字长，给足宽度 */
.river-source-select {
  max-width: 132px;
  margin: 0 2px 0 4px;
  padding: 2px 4px;
  font-size: 12px;
  color: #e2e8f0;
  background: #0f172a;
  border: 1px solid #475569;
  border-radius: 4px;
}
/* 平滑开关（紧挨自动河流按钮）：与邻居同字号，别把工具栏挤爆 */
.river-smooth-label {
  margin: 0 2px 0 4px;
  font-size: 12px;
  white-space: nowrap;
}
/* 河流节点编辑行（2026-10-17）：只在使用河流工具时出现 —— 与 `.province-row` 同款
   "切到该类工具才出现的选项行"。用 `flex-wrap` 兜住窄窗口（否则两个按钮会被挤出去）。 */
.river-edit-row {
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.river-edit-row .river-edit-name {
  font-size: 12px;
  color: #93c5fd;
  white-space: nowrap;
}
.river-edit-row button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
/* 地形限制提示（常驻小徽标，光标悬停看详细原因）：刻意用警示色，别让人以为河就该长这样 */
.river-terrain-advice {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin: 0 2px 0 4px;
  padding: 2px 6px;
  font-size: 12px;
  white-space: nowrap;
  color: #fbbf24;
  background: #3a2a0a;
  border: 1px solid #a16207;
  border-radius: 4px;
  cursor: help;
}

/* ── P5：高度图分辨率面板（2026-10-14）───────────────────────────────────────
   为什么按需展开而不是常驻：这组操作**不常做**（一次调整管很久），常驻会在工具栏上
   再加一排控件，把"每屏能看几个工具"进一步挤没。 */
/* 生成类面板的浮层容器（P0-1/P0-2/P0-4 共用）：固定定位 + 高层级。
   🔴 2026-10-25 用户实测「按钮根本点不了」：内联在工具栏里时，左栏剧本列表的
   `.slp-empty` 正好压在「造陆并铺 N 省」上方 —— 真人点击命中的是它，而 `el.click()`
   绕过命中测试，所以用例一直绿。浮层化后既不被遮挡，也不受工具栏高度裁剪。 */
.gen-float {
  position: fixed;
  left: 50%;
  top: 64px;
  transform: translateX(-50%);
  z-index: 80;
  width: min(780px, calc(100vw - 96px));
  max-height: calc(100vh - 120px);
  overflow: auto;
  padding: 8px 10px;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 8px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
}
.gen-float .resample-panel { margin: 0; border: none; background: transparent; padding: 0; }

.resample-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  margin: 4px 0;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 6px;
  font-size: 12px;
  color: #cbd5e1;
}
.resample-panel .rp-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.resample-panel label { opacity: 0.85; }
.resample-panel select {
  background: #0f172a; color: #e2e8f0; border: 1px solid #475569;
  border-radius: 4px; padding: 2px 6px; font-size: 12px;
}
.resample-panel .rp-cost { opacity: 0.9; }
.resample-panel .rp-cost.lv-ok { color: #fbbf24; }
.resample-panel .rp-cost.lv-slow { color: #fb923c; }
.resample-panel .rp-cost.lv-reject { color: #f87171; }
.resample-panel .rp-warn { color: #fca5a5; line-height: 1.6; white-space: pre-wrap; }
.resample-panel .rp-hint { opacity: 0.65; font-size: 11px; }
.resample-panel .rp-note { opacity: 0.6; font-size: 11px; line-height: 1.6; }
.resample-panel .rp-actions { display: flex; gap: 8px; }
.resample-panel .rp-btn {
  padding: 3px 12px; font-size: 12px; color: #e2e8f0;
  background: rgba(148, 163, 184, 0.12); border: 1px solid #475569;
  border-radius: 4px; cursor: pointer;
}
.resample-panel .rp-btn.primary { color: #0f172a; background: #38bdf8; border-color: #38bdf8; font-weight: 600; }
.resample-panel .rp-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.resample-panel .rp-btn:not(:disabled):hover { filter: brightness(1.12); }

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

/* 保存状态：失败原因可能很长 → 限宽 + 省略号（全文在 title 里）。
   ⚠️ span 是 inline，text-overflow 需要 inline-block 才生效。 */
.save-status {
  margin-left: auto;
  display: inline-block;
  max-width: 46ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}
.save-status.saved { color: #4ade80; }
.save-status.error { color: #f87171; font-weight: 600; }
.save-status.saving { color: #fbbf24; }
/* staged（2026-10-17）：已交给项目、还在等磁盘写入 / 有改动未落盘 ——
   与 saved 的绿标**必须不同色**，否则「还在内存里」和「已经进磁盘」在界面上又混成一件事 */
.save-status.staged { color: #fbbf24; }
.save-status.idle { color: #94a3b8; }

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
.ctx-province { font-size: 12px; }
/* 归属行：底色比其它禁用行亮一档 —— 它是用户右键时最想确认的一条信息 */
.ctx-item.ctx-owner { color: #cbd5e1; padding-top: 2px; padding-bottom: 6px; }
.ctx-item.ctx-owner .polity-dot {
  width: 8px; height: 8px; margin: 0 4px 0 2px; vertical-align: -1px;
}
.ctx-owner .owner-none { color: #94a3b8; font-style: italic; margin-left: 2px; }
.ctx-sub { color: #64748b; font-size: 11px; margin-left: 2px; }

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

/* 资料（读料桥）段的样式**搬进了 `VaultLoreSection.vue`**（2026-10-24）：
   父组件的 scoped 样式只能命中子组件根节点，内部节点拿不到 —— 与其在这里用 :deep 穿透
   （子组件就被钉死在父组件身上），不如让组件自带样式。本文件不再保留那份规则。 */

/* 标记面板（2026-10-24）：复用省份面板的定位/行样式，补坐标输入与删除按钮 */
.marker-props { top: 100px; }
.marker-props .coord-input {
  width: 74px;
  background: #334155;
  border: 1px solid #475569;
  border-radius: 4px;
  padding: 4px 6px;
  color: #e2e8f0;
  font-size: 12px;
}
.marker-props .marker-belong {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: #cbd5e1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.props-mini.danger { color: #f87171; border-color: #7f1d1d; }
.props-mini.danger:not(:disabled):hover { background: rgba(248, 113, 113, 0.16); }

/* 归属行（2026-10-21）：值占满剩余宽度，右侧一个「清成无主 / 设为当前势力」小按钮 */
.props-row .owner-value {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #e2e8f0;
  min-width: 0;
}
.props-row .owner-value.none { color: #94a3b8; font-style: italic; }
.props-mini {
  padding: 2px 8px;
  font-size: 11px;
  color: #e2e8f0;
  background: rgba(148, 163, 184, 0.12);
  border: 1px solid #475569;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}
.props-mini:not(:disabled):hover { background: rgba(148, 163, 184, 0.24); }
.props-mini:disabled { opacity: 0.45; cursor: not-allowed; }
.props-sub { margin: -2px 0 8px 78px; font-size: 10px; color: #64748b; }

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

/* 019 重导对话框 */
.reimport-dialog { max-width: 560px; }
.rd-intro { margin: 0 0 12px; font-size: 12px; line-height: 1.65; color: #94a3b8; }
.rd-grid {
  display: grid; grid-template-columns: 88px 1fr; gap: 6px 10px;
  padding: 10px 12px; margin-bottom: 12px;
  background: rgba(15, 23, 42, 0.55); border: 1px solid #334155; border-radius: 8px;
  font-size: 12px; color: #cbd5e1;
}
.rd-grid span { color: #64748b; }
.rd-grid b { color: #e2e8f0; font-weight: 600; word-break: break-all; }
.rd-warn {
  margin: 0 0 10px; padding: 8px 10px; font-size: 11.5px; line-height: 1.6;
  color: #fde68a; background: rgba(120, 53, 15, 0.28);
  border: 1px solid #92400e; border-radius: 6px;
}
.rd-warn ul { margin: 4px 0 0; padding-left: 18px; }
.rd-warn code { color: #fef3c7; }
.rd-check { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: #94a3b8; }
.rd-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.rd-actions button {
  background: #1e293b; border: 1px solid #475569; color: #cbd5e1;
  border-radius: 6px; padding: 5px 12px; font-size: 12px; cursor: pointer; font-family: inherit;
}
.rd-actions button.primary { background: rgba(124, 58, 237, 0.9); border-color: #7c3aed; color: #fff; }
.rd-actions button:disabled { opacity: 0.45; cursor: not-allowed; }

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
.item-group {
  max-width: 92px;
  background: #16233a;
  border: 1px solid #475569;
  color: #cbd5e1;
  border-radius: 4px;
  font-size: 10.5px;
  padding: 1px 3px;
  font-family: inherit;
}

/* 剧本集（2026-10-25）：左栏切换条 + 管理对话框里的组表 */
.slp-groupbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 2px 6px;
  border-bottom: 1px solid #263449;
}
.slp-group-label { font-size: 10px; color: #94a3b8; flex: none; }
.slp-group-select {
  flex: 1 1 auto;
  min-width: 0;
  background: #1e293b;
  border: 1px solid #475569;
  color: #e2e8f0;
  border-radius: 5px;
  font-size: 11px;
  padding: 2px 4px;
  font-family: inherit;
}
.slp-group-manage {
  flex: none;
  background: #1e293b;
  border: 1px solid #475569;
  color: #cbd5e1;
  border-radius: 5px;
  padding: 2px 6px;
  font-size: 10.5px;
  cursor: pointer;
  font-family: inherit;
}
.slp-group-manage:hover { background: #334155; color: #e2e8f0; }

.scenario-groups {
  margin: 0 0 16px;
  padding: 8px;
  border: 1px solid #334155;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.35);
}
.sg-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.sg-title { font-size: 12px; font-weight: 600; color: #e2e8f0; }
.sg-hint { font-size: 10.5px; color: #64748b; }
.sg-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  border-bottom: 1px solid #263449;
}
.sg-row:last-of-type { border-bottom: 0; }
.sg-name { flex: 1; font-size: 12px; color: #cbd5e1; }
.sg-name.current { color: #fff; font-weight: 600; }
.sg-count { font-size: 10.5px; color: #64748b; font-variant-numeric: tabular-nums; }
.sg-name-input {
  flex: 1;
  min-width: 0;
  background: #16233a;
  border: 1px solid #475569;
  color: #e2e8f0;
  border-radius: 4px;
  font-size: 11px;
  padding: 2px 5px;
  font-family: inherit;
}
.sg-btn {
  flex: none;
  background: #1e293b;
  border: 1px solid #475569;
  color: #cbd5e1;
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 10.5px;
  cursor: pointer;
  font-family: inherit;
}
.sg-btn:hover:not(:disabled) { background: #334155; color: #e2e8f0; }
.sg-btn.primary { background: rgba(124, 58, 237, 0.85); border-color: #7c3aed; color: #fff; }
.sg-btn.danger:hover:not(:disabled) { background: rgba(180, 40, 50, 0.35); border-color: #a3474f; color: #fecaca; }
.sg-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.sg-new { display: flex; gap: 6px; margin-top: 6px; }
.sg-note { margin: 6px 0 0; font-size: 10.5px; line-height: 1.55; color: #64748b; }

.item-delete {
  background: none;
  border: none;
  cursor: pointer;
  opacity: 0.5;
}

.item-delete:hover { opacity: 1; }

/* 剧本条：编辑按钮与删除同形（2026-10-07） */
.item-edit {
  background: none;
  border: none;
  cursor: pointer;
  opacity: 0.5;
}
.item-edit:hover { opacity: 1; }
.item-edit:disabled, .item-delete:disabled { opacity: 0.25; cursor: not-allowed; }

/* 批量清空剧本（2026-10-11）：危险动作 → 单独一行、带文字（本仓纪律：工具栏/对话框按钮
   一律「图标 + 文字」，纯图标被判过"根本看不懂"），并把"不动底图与省份"写在旁边 */
.scenario-bulk {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0 0 14px;
}
.btn-clear-all {
  padding: 6px 12px;
  font-size: 12px;
  font-family: inherit;
  color: #fecaca;
  background: rgba(220, 38, 38, 0.18);
  border: 1px solid #b91c1c;
  border-radius: 6px;
  cursor: pointer;
}
.btn-clear-all:hover:not(:disabled) { background: rgba(220, 38, 38, 0.32); }
.btn-clear-all:disabled { opacity: 0.4; cursor: not-allowed; }
.bulk-hint { font-size: 11px; color: #94a3b8; }

/* 标注 / 标记管理（2026-10-07）—— 此前这两个写口是死入口，条目只能加不能删 */
.scenario-annos {
  border-top: 1px solid #334155;
  padding-top: 12px;
  margin-bottom: 16px;
}
.scenario-annos h4 { margin: 0 0 8px; font-size: 13px; color: #cbd5e1; }
.anno-empty { font-size: 12px; color: #64748b; line-height: 1.5; }
.anno-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
}
.anno-kind {
  flex: 0 0 auto;
  font-size: 11px;
  color: #a78bfa;
  border: 1px solid #4c1d95;
  border-radius: 3px;
  padding: 0 4px;
}
.anno-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.anno-del {
  background: none;
  border: none;
  cursor: pointer;
  opacity: 0.55;
  color: inherit;
}
.anno-del:hover { opacity: 1; }
.anno-del:disabled { opacity: 0.25; cursor: not-allowed; }

.edit-hint { margin-top: 8px; font-size: 11px; color: #94a3b8; line-height: 1.5; }

.new-scenario-form {
  border-top: 1px solid #334155;
  padding-top: 16px;
}

.new-scenario-form h4 { margin: 0 0 12px; font-size: 14px; }
.bound-row .bound-basemap {
  flex: 1; font-size: 12px; color: var(--text-secondary, #9aa4b2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bound-row .bound-add {
  font-size: 12px; padding: 2px 8px; cursor: pointer;
  background: transparent; border: 1px solid var(--border, #3a4350); border-radius: 4px;
  color: var(--accent, #8ab4f8);
}

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

/* 从留底恢复面板（0.2.9）—— 与聚落编辑器同一套观感，独立命名便于单独立样式 */
.bmsrc-panel {
  position: absolute;
  top: 100px;
  right: 16px;
  width: 340px;
  max-height: 60%;
  display: flex;
  flex-direction: column;
  background: #1e293b;
  border: 1px solid #475569;
  border-radius: 12px;
  padding: 16px;
  z-index: 100;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}

.bmsrc-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  font-size: 14px;
  font-weight: 600;
  color: #e2e8f0;
}

.bmsrc-close {
  background: none;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  padding: 4px;
}

.bmsrc-close:hover { color: #e2e8f0; }

.bmsrc-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  min-height: 0;
}

.bmsrc-hint,
.bmsrc-msg {
  font-size: 11px;
  line-height: 1.5;
  color: #94a3b8;
}

.bmsrc-msg { color: #cbd5e1; }

.bmsrc-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 6px;
}

.bmsrc-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.bmsrc-name {
  font-size: 12px;
  color: #e2e8f0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bmsrc-sub {
  font-size: 10px;
  color: #94a3b8;
}

.bmsrc-use {
  flex: 0 0 auto;
  padding: 4px 10px;
  border: 1px solid #7c3aed;
  background: #5b21b6;
  color: #e2e8f0;
  border-radius: 6px;
  cursor: pointer;
  font-size: 11px;
}

.bmsrc-use:disabled { opacity: 0.5; cursor: default; }

.bmsrc-dir {
  font-size: 10px;
  color: #64748b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 工具栏可读性（2026-10-09）───────────────────────────────────────────────
   暮雨实测：「上面一堆工具但是根本看不懂」—— 根因是所有工具按钮**只有图标没有文字**，
   名字只藏在 title 里（要悬停 1 秒才出）。这里统一改成「图标 + 文字」横排。
   ⚠️ 用 min-width 而非 width：无文字的按钮仍旧是 32×32 方块，观感不变。 */
.scenario-toolbar button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 0 8px;
  min-width: 32px;
  height: 32px;
  white-space: nowrap;
  /* ⚠️ 关掉 preflight 后 <button> 不吃继承：字体必须显式写，
     否则按钮文字会用浏览器 UA 默认字体（与面板其余部分不一致）。 */
  font-family: inherit;
  font-size: 12px;
}
</style>
