<template>
  <div class="interior-container">
    <div class="map-header">
      <div class="header-left">
        <div class="header-title-row">
          <button class="back-btn" @click="store.backToArea()" title="返回区域地图">← 返回</button>
          <h2>{{ buildingNode?.name }} — 建筑内部</h2>
          <!-- 相邻建筑切换器 -->
          <div v-if="sameAreaBuildings.length > 1" class="building-switcher">
            <button class="building-switch-btn" @click="showBuildingMenu = !showBuildingMenu" title="切换同区域建筑">
              <Icon name="building" :size="13"/> {{ sameAreaBuildings.length }}
            </button>
            <div v-if="showBuildingMenu" class="building-menu" @click.stop>
              <div 
                v-for="b in sameAreaBuildings" 
                :key="b.id" 
                :class="{ current: b.id === buildingNode?.id }"
                @click="switchBuilding(b)"
              >{{ b.displayName || b.name }}</div>
            </div>
          </div>
        </div>
        <p class="hint">
          <span v-if="!editMode">
            点击家具选中 · 拖拽移动 · 滚动缩放 · 拖拽空白处平移 ·
            <a href="#" @click.prevent="enterEditMode">编辑</a>
          </span>
          <span v-else class="edit-hint">
            <strong>编辑模式</strong> —
            {{ interactionMode === 'pan' ? '拖拽家具移动 / 点击选中 / Shift+点击多选 / Shift+拖拽框选' : '' }}
            {{ interactionMode === 'add_furniture' ? '点击空白处放置家具' : '' }}
            {{ interactionMode === 'add_room' ? '选一个房间模板后点击空白处整间放置（一次可撤销）' : '' }}
            · <a href="#" @click.prevent="exitEditMode">退出</a>
          </span>
        </p>
      </div>
      <div class="header-actions">
        <!-- 外观（3D）：同一份楼层数据的第二种渲染，只读预览，不进编辑态 -->
        <button class="adopt-btn exterior-btn" @click="showExterior = true" :disabled="!canShowExterior"
                :title="canShowExterior ? '以 3D 看这栋楼的外观（墙挤成体块 + 屋顶，可转动）' : '这栋楼还没有墙：先在“编辑地图 → 画墙”里画几面墙'">
          <Icon name="cube" :size="14" /> 外观
        </button>
        <!-- 出图（2026-11-14，第 4 刀）：A4 横向图纸，比例尺/指北针/图例/标题栏/房间面积表 -->
        <button class="adopt-btn export-btn" @click="exportPlanSheet" :disabled="!canShowExterior || exporting"
                :title="canShowExterior ? '导出当前楼层的平面图（A4 横版，带比例尺、指北针、图例、标题栏、房间面积表）' : '这栋楼还没有墙，没有可出的平面图'">
          <Icon name="export" :size="14" /> {{ exporting ? '生成中…' : '出图' }}
        </button>
        <button class="adopt-btn shortcut-btn" @click="shortcutsHelpOpen = true" data-testid="shortcuts-open"
                title="快捷键一览（也可以按 ? 或 F1）">
          <Icon name="help-circle" :size="14" /> 快捷键
        </button>
        <span v-if="exportMsg" class="export-msg" :class="{ err: exportMsgErr }">{{ exportMsg }}</span>
        <template v-if="!editMode">
          <button class="adopt-btn edit-entry-btn" @click="enterEditMode" :disabled="store.isReadOnly"
                  :title="store.isReadOnly ? store.readOnlyReason : '进入编辑模式：放置/拖拽家具'"><Icon name="pencil" :size="14"/> 编辑地图</button>
        </template>
      </div>
    </div>

    <!-- 楼层切换栏 -->
    <div class="floor-bar">
      <div class="floor-tabs">
        <button
          v-for="floor in floors"
          :key="floor.id"
          :class="['floor-tab', { active: currentFloorId === floor.id }]"
          @click="selectFloor(floor.id)"
          :title="`${floor.name} (${floor.furniture?.length || 0} 物品)`"
        >
          <span class="floor-level">{{ floor.level + 1 }}F</span>
          <span class="floor-name">{{ floor.name }}</span>
        </button>
      </div>
      <div class="floor-actions">
        <!-- ⚠️ 本栏**不受 editMode 控制**（楼层切换在浏览态也要用），所以只读灰禁必须写在这里：
             否则只读态下这三个按钮照常可点 → 改内存但永不落盘 = 用户以为删掉了、重启又回来 -->
        <button class="floor-btn" @click="addFloor" :disabled="store.isReadOnly"
                :title="store.isReadOnly ? store.readOnlyReason : '添加楼层'"><Icon name="plus" :size="13"/> 楼层</button>
        <button class="floor-btn" @click="renameFloor" :disabled="store.isReadOnly || floors.length <= 1"
                :title="store.isReadOnly ? store.readOnlyReason : '重命名楼层'"><Icon name="pencil" :size="13"/> 命名</button>
        <button class="floor-btn danger" @click="removeFloor" :disabled="store.isReadOnly || floors.length <= 1"
                :title="store.isReadOnly ? store.readOnlyReason : '删除当前楼层'"><Icon name="trash" :size="13"/> 删除</button>
      </div>
    </div>

    <!-- 编辑工具栏 -->
    <div v-if="editMode" class="edit-toolbar-wrap">
      <div class="edit-toolbar">
        <div class="toolbar-group" title="工具">
          <button :class="{ active: interactionMode === 'pan' }" @click="interactionMode = 'pan'" title="拖拽平移 / 选中家具"><Icon name="hand" :size="13"/> 拖手</button>
          <button :class="{ active: interactionMode === 'add_furniture' }" @click="interactionMode = 'add_furniture'" title="点击空白处放置家具"><Icon name="armchair" :size="13"/> 家具</button>
          <button :class="{ active: interactionMode === 'add_room' }" @click="interactionMode = 'add_room'" title="房间模板：一键铺好整间（卧室/厨房/大厅/书房/仓库），一次操作可撤销"><Icon name="home" :size="13"/> 房间模板</button>
          <button :class="{ active: interactionMode === 'add_wall' }" @click="interactionMode = 'add_wall'; wallDraftStart = null" title="画墙：点一下定起点，再点一下成墙（可连续画，Esc 结束）。墙围合成房间会自动出名字和面积"><Icon name="square" :size="13"/> 画墙</button>
          <button :class="{ active: interactionMode === 'add_door' }" @click="interactionMode = 'add_door'" title="放门：点在墙上，门按点到的位置放上去"><Icon name="home" :size="13"/> 门</button>
          <button :class="{ active: interactionMode === 'add_window' }" @click="interactionMode = 'add_window'" title="放窗：点在墙上"><Icon name="grid" :size="13"/> 窗</button>
        </div>

        <div class="toolbar-group" title="墙厚" v-if="interactionMode === 'add_wall'">
          <span class="toolbar-label">墙厚</span>
          <button v-for="t in [8, 12, 24]" :key="t" :class="{ active: wallThickness === t }" @click="wallThickness = t">{{ t }}cm</button>
          <button @click="wallDraftStart = null" :disabled="!wallDraftStart" title="结束当前这段墙（Esc）">结束</button>
        </div>

        <div class="toolbar-group" title="房间模板" v-if="interactionMode === 'add_room'">
          <span class="toolbar-label">模板</span>
          <button
            v-for="tpl in ROOM_TEMPLATES"
            :key="tpl.id"
            :class="{ active: selectedRoomTemplate === tpl.id }"
            @click="selectedRoomTemplate = tpl.id"
            :title="tpl.hint || tpl.label"
          ><Icon :name="tpl.icon" :size="13"/> {{ tpl.label }}</button>
        </div>

        <div class="toolbar-group" title="家具类型" v-if="interactionMode === 'add_furniture'">
          <span class="toolbar-label">类型</span>
          <button
            v-for="ft in FURNITURE_TYPES"
            :key="ft.type"
            :class="{ active: selectedFurnitureType === ft.type }"
            @click="selectedFurnitureType = ft.type"
            :title="ft.label"
          ><Icon :name="ft.icon" :size="13"/> {{ ft.label }}</button>
        </div>

        <div class="toolbar-group" title="绘制辅助">
          <button :class="{ active: gridSnapEnabled }" @click="gridSnapEnabled = !gridSnapEnabled" title="网格对齐">⊞ 网格</button>
          <template v-if="gridSnapEnabled">
            <span class="toolbar-label">间距</span>
            <button v-for="s in [20, 40, 80]" :key="s" :class="{ active: gridSize === s }" @click="gridSize = s">{{ s }}</button>
          </template>
          <button :class="{ active: showDimensions }" @click="showDimensions = !showDimensions"
                  title="在每面墙上标出长度（关掉可让图更干净）"><Icon name="ruler" :size="13"/> 标注</button>
        </div>

        <div class="toolbar-group" title="操作">
          <button @click="deleteSelected" :disabled="!selectedFurniture && !selectedWallId && !selectedOpening" title="删除选中的家具 / 墙 / 门窗 (Del)"><Icon name="trash" :size="13"/> 删除</button>
          <button @click="rotateSelected" :disabled="!selectedFurniture" title="旋转选中家具 (R)">↻ 旋转</button>
          <button @click="openTransferDialog" :disabled="selectedFurnitureIds.length === 0" title="把选中的家具复制/移动到其他楼层（整批 = 一条 undo）"><Icon name="copy" :size="13"/> 跨楼层</button>
          <button @click="undo" :disabled="!store.canUndo">↶ 撤销</button>
          <button @click="redo" :disabled="!store.canRedo">↷ 重做</button>
        </div>

        <div class="toolbar-group" title="视图">
          <button :class="{ active: showRefImagePanel }" @click="showRefImagePanel = !showRefImagePanel" title="参考底图"><Icon name="image" :size="13"/> 参考图</button>
        </div>

        <div class="toolbar-group toolbar-group-exit">
          <button class="toolbar-close" @click="exitEditMode" title="退出编辑模式"><Icon name="check" :size="13"/> 退出</button>
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
        <label>导入室内平面图</label>
        <button class="adopt-btn" style="width:100%" @click="importReferenceImage" :disabled="refImageLoading">
          {{ refImageLoading ? '加载中...' : (referenceImages.length > 0 ? '添加底图' : '选择图片') }}
        </button>
      </div>
      <div class="editor-field" v-if="referenceImages.length > 0">
        <label>底图列表（{{ referenceImages.length }}）</label>
        <div class="ref-list">
          <div v-for="(img, idx) in referenceImages" :key="img.id" class="ref-item"
            :class="{ active: idx === activeRefIndex }" @click="activeRefIndex = idx">
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
          <label>缩放</label>
          <input type="range" min="0.05" max="5" step="0.05" v-model.number="refScale" @input="updateRefScale" />
          <span class="ref-value">{{ Math.round(refScale * 100) }}%</span>
        </div>
        <div class="editor-field">
          <label>移除</label>
          <button class="adopt-btn ghost" style="width:100%" @click="removeReferenceImage"><Icon name="trash" :size="13"/> 移除</button>
        </div>
      </template>
    </div>

    <div class="canvas-wrapper">
      <canvas ref="canvas"></canvas>

      <!-- 家具自绘提示条（2026-11-14）：只在这个模式出现，写明怎么结束 -->
      <div v-if="shapeEdit.active" class="shape-edit-bar" data-testid="shape-edit-bar">
        <span class="shape-hint">
          在<b>{{ shapeItem?.name || '家具' }}</b>上依次点出轮廓
        </span>
        <span class="shape-count" data-testid="shape-count">{{ shapePointCount }} 点</span>
        <button class="shape-btn" @click="undoShapePoint" :disabled="!shapePointCount"
                title="撤掉最后一个点 (Backspace)">撤一点</button>
        <button class="shape-btn" :class="{ active: shapeEdit.smooth }"
                @click="shapeEdit.smooth = !shapeEdit.smooth; renderer.requestRender()"
                data-testid="shape-smooth"
                :title="shapeEdit.smooth ? '当前：圆滑曲线（点仍是折线点，可随时切回）' : '把折线抹成圆滑曲线'">平滑</button>
        <button class="shape-btn primary" @click="finishShapeEdit" :disabled="shapePointCount < 3"
                :title="shapePointCount < 3 ? '至少 3 个点才能围出形状' : '闭合并保存 (Enter / 双击)'">完成</button>
        <button class="shape-btn" @click="cancelShapeEdit" title="放弃这次绘制 (Esc)">取消</button>
        <span class="shape-tip">双击或 Enter 闭合 · 点回起点也能闭合</span>
      </div>

      <eagle-eye
        v-if="viewBounds"
        :view-bounds="viewportBounds"
        :elements="eyeElements"
        :world-bounds="worldBounds"
        @navigate="handleEagleEyeNavigate"
      />
    </div>

    <!-- 门窗详情浮窗（A11）：宽 / 高 / 窗台高 / 沿墙位置，都能改 -->
    <div v-if="selectedOpening && editingOpening" class="node-detail-popover opening-popover" data-testid="opening-popover">
      <div class="popover-header">
        <h4>{{ openingForm.kind === 'doors' ? '门' : '窗' }}</h4>
        <div class="popover-header-actions">
          <button class="close-btn" @click="cancelOpeningEdit">×</button>
        </div>
      </div>
      <div class="popover-body">
        <div class="detail-row">
          <span class="detail-label">洞口宽</span>
          <div class="rotation-input">
            <input type="number" v-model.number="openingForm.width" min="20" max="600" step="5" class="popover-number" data-testid="opening-width" />
            <span class="unit-label">cm</span>
          </div>
        </div>
        <div class="detail-row">
          <span class="detail-label">高</span>
          <div class="rotation-input">
            <input type="number" v-model.number="openingForm.height" min="20" max="400" step="5" class="popover-number" data-testid="opening-height" />
            <span class="unit-label">cm</span>
          </div>
        </div>
        <div class="detail-row" v-if="openingForm.kind === 'windows'">
          <span class="detail-label">窗台高</span>
          <div class="rotation-input">
            <input type="number" v-model.number="openingForm.sillHeight" min="0" max="300" step="5" class="popover-number" data-testid="opening-sill" />
            <span class="unit-label">cm</span>
          </div>
        </div>
        <div class="detail-row">
          <span class="detail-label">沿墙位置</span>
          <input type="range" min="0.05" max="0.95" step="0.01" v-model.number="openingForm.position" class="opening-range" data-testid="opening-position" />
        </div>
        <!-- A25：门窗到墙两端的距离（只读，改位置/宽度会跟着变） -->
        <div class="detail-row" v-if="openingEnds">
          <span class="detail-label">距墙端</span>
          <span class="detail-value" data-testid="opening-ends">{{ openingEnds }}</span>
        </div>
        <div class="popover-actions">
          <button class="adopt-btn" @click="saveOpeningEdit" data-testid="opening-save"
                  :disabled="store.isReadOnly" :title="store.isReadOnly ? store.readOnlyReason : '保存尺寸与位置（可撤销）'">保存</button>
          <button class="adopt-btn ghost" @click="deleteSelected" data-testid="opening-delete"
                  :disabled="store.isReadOnly" :title="store.isReadOnly ? store.readOnlyReason : '删除这个门窗（可撤销）'">删除</button>
        </div>
      </div>
    </div>

    <!-- 快捷键一览（A27）：内容由 interior/shortcuts.js 的表生成，不在这里另抄一份 -->
    <div v-if="shortcutsHelpOpen" class="shortcuts-overlay" data-testid="shortcuts-help"
         @click.self="shortcutsHelpOpen = false">
      <div class="shortcuts-dialog">
        <div class="sc-head">
          <h4>快捷键</h4>
          <button class="close-btn" @click="shortcutsHelpOpen = false" title="关闭 (Esc)">×</button>
        </div>
        <div class="sc-groups">
          <section v-for="g in shortcutGroups" :key="g.group" class="sc-group">
            <h5>{{ g.group }}</h5>
            <div v-for="it in g.items" :key="it.id" class="sc-row">
              <span class="sc-keys">
                <kbd v-for="k in it.keys" :key="k">{{ k }}</kbd>
                <template v-if="it.alternates && it.alternates.length">
                  <span class="sc-or">或</span>
                  <kbd v-for="k in it.alternates[0]" :key="'alt-' + k">{{ k }}</kbd>
                </template>
              </span>
              <span class="sc-text"><b>{{ it.label }}</b><i>{{ it.hint }}</i></span>
            </div>
          </section>
        </div>
        <p class="sc-foot">
          原有按键照旧：<kbd>Del</kbd> 删除选中 · <kbd>R</kbd> 旋转家具 · <kbd>方向键</kbd> 微调 ·
          <kbd>Esc</kbd> 逐层退出 · <kbd>Shift</kbd> 正交画墙
        </p>
      </div>
    </div>

    <!-- 选中家具详情浮窗（可编辑） -->
    <div v-if="selectedFurniture && !editMode && !shapeEdit.active" class="node-detail-popover">
      <div class="popover-header">
        <h4 v-if="!editingPopover">{{ selectedFurniture.name }}</h4>
        <input v-else v-model="editForm.name" class="popover-title-input" placeholder="家具名称" />
        <div class="popover-header-actions">
          <button v-if="!editingPopover" class="edit-btn" @click="startEditPopover" title="编辑这件家具的名称和类型"><Icon name="pencil" :size="12"/> 编辑</button>
          <button class="close-btn" @click="cancelEditPopover">×</button>
        </div>
      </div>
      <div class="popover-body">
        <div class="detail-row">
          <span class="detail-label">类型</span>
          <select v-if="editingPopover" v-model="editForm.type" class="popover-select">
            <option v-for="ft in FURNITURE_TYPES" :key="ft.type" :value="ft.type">{{ ft.label }}</option>
          </select>
          <span v-else class="detail-value">{{ getFurnitureTypeLabel(selectedFurniture.type) }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">位置</span>
          <span class="detail-value">X: {{ Math.round(selectedFurniture.x) }}, Y: {{ Math.round(selectedFurniture.y) }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">尺寸</span>
          <div v-if="editingPopover" class="size-inputs">
            <input type="number" v-model.number="editForm.width" min="10" max="500" class="size-input" />
            <span class="size-sep">×</span>
            <input type="number" v-model.number="editForm.height" min="10" max="500" class="size-input" />
          </div>
          <span v-else class="detail-value">{{ selectedFurniture.width }} × {{ selectedFurniture.height }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">旋转</span>
          <div v-if="editingPopover" class="rotation-input">
            <input type="number" v-model.number="editForm.rotation" min="0" max="359" step="1" class="popover-number" />
            <span class="unit-label">°</span>
          </div>
          <span v-else class="detail-value">{{ selectedFurniture.rotation || 0 }}°</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">形状</span>
          <span class="detail-value" data-testid="shape-state">
            {{ selectedFurniture.custom ? `自定义（${selectedFurniture.custom.points.length} 点）` : '内置符号' }}
          </span>
        </div>
        <div class="shape-actions">
          <button class="adopt-btn" @click="startShapeEdit" data-testid="shape-draw"
                  :disabled="store.isReadOnly"
                  :title="store.isReadOnly ? store.readOnlyReason : '在画布上点出这件家具的轮廓（可再点一次接着改）'">
            <Icon name="pencil" :size="12" /> 画形状
          </button>
          <button v-if="selectedFurniture.custom" class="adopt-btn ghost" @click="clearFurnitureShape"
                  data-testid="shape-reset" :disabled="store.isReadOnly" title="丢掉自定义形状，恢复内置符号">
            恢复默认
          </button>
          <button v-if="selectedFurniture.custom" class="adopt-btn ghost" @click="saveAsShapeTemplate"
                  data-testid="shape-save-tpl" :disabled="store.isReadOnly"
                  title="把这个形状存成模板（存本机，不进项目文件），以后套到别的家具上">
            存为模板
          </button>
        </div>
        <!-- 形状模板（本机）：同一栋楼里做一排一样的柜子，不用挨个重画 -->
        <div v-if="shapeTemplates.length" class="shape-tpl-row">
          <select v-model="pickedTemplateId" class="popover-select" data-testid="shape-tpl-select">
            <option value="">选择形状模板…</option>
            <option v-for="t in shapeTemplates" :key="t.id" :value="t.id">{{ t.name }}（{{ t.width }}×{{ t.height }}）</option>
          </select>
          <button class="adopt-btn" @click="applyShapeTemplate" :disabled="!pickedTemplateId || store.isReadOnly"
                  data-testid="shape-apply-tpl" title="把选中模板套到这件家具上（中心不动）">套用</button>
          <button class="adopt-btn ghost" @click="removeShapeTemplate" :disabled="!pickedTemplateId"
                  data-testid="shape-del-tpl" title="删掉这个模板（只删本机记录）">删除</button>
        </div>
        <div v-if="editingPopover" class="popover-actions">
          <button class="adopt-btn" @click="saveEditPopover">保存</button>
          <button class="adopt-btn ghost" @click="cancelEditPopover">取消</button>
        </div>
      </div>
    </div>

    <!-- 跨楼层复制/移动对话框（R5-3） -->
    <div v-if="transferDialogOpen" class="modal-overlay" @click.self="transferDialogOpen = false">
      <div class="modal-dialog">
        <h3>跨楼层复制 / 移动</h3>
        <div class="form-row">
          <label>选中</label>
          <span>{{ selectedFurnitureIds.length }} 件家具</span>
        </div>
        <div class="form-row">
          <label>方式</label>
          <select v-model="transferMode">
            <option value="copy">复制（原层保留）</option>
            <option value="move">移动（原层移除）</option>
          </select>
        </div>
        <div class="form-row">
          <label>目标楼层</label>
          <select v-model="transferTargetFloorId">
            <option v-for="fl in floors" :key="fl.id" :value="fl.id" :disabled="fl.id === currentFloorId">
              {{ fl.name }}{{ fl.id === currentFloorId ? '（当前层）' : '' }}
            </option>
          </select>
        </div>
        <div class="modal-actions">
          <button class="adopt-btn primary" @click="confirmTransfer" :disabled="!canTransfer">确定</button>
          <button class="adopt-btn ghost" @click="transferDialogOpen = false">取消</button>
        </div>
      </div>
    </div>

    <!-- 添加家具对话框 -->
    <div v-if="addFurnitureDialogOpen" class="modal-overlay" @click.self="addFurnitureDialogOpen = false">
      <div class="modal-dialog">
        <h3>放置家具</h3>
        <div class="form-row">
          <label>名称</label>
          <input v-model="newFurnitureName" placeholder="家具名称" @keyup.enter="confirmAddFurniture" />
        </div>
        <div class="form-row">
          <label>类型</label>
          <select v-model="newFurnitureType">
            <option v-for="ft in FURNITURE_TYPES" :key="ft.type" :value="ft.type">{{ ft.label }}</option>
          </select>
        </div>
        <div class="form-row">
          <label>宽度</label>
          <input type="number" v-model.number="newFurnitureWidth" min="10" max="500" />
        </div>
        <div class="form-row">
          <label>高度</label>
          <input type="number" v-model.number="newFurnitureHeight" min="10" max="500" />
        </div>
        <div class="modal-actions">
          <button class="adopt-btn" @click="confirmAddFurniture">放置</button>
          <button class="adopt-btn ghost" @click="addFurnitureDialogOpen = false">取消</button>
        </div>
      </div>
    </div>

    <!-- 外观（3D）：覆盖整个内部视图；关闭即销毁（three 不进常驻内存） -->
    <exterior-view
      v-if="showExterior"
      :building-name="buildingNode?.name"
      :floors="floors"
      @close="showExterior = false"
    />
  </div>
</template>

<script setup>
import { canvasFont } from '../utils/mapTextStyles';
import { drawIconOrEmoji } from '../utils/canvasIcon';
import Icon from './Icon.vue';
import { ref, computed, watch, reactive, onMounted, onUnmounted } from 'vue';
import { useGeodataStore } from '../store/geodata';
// 单一写闸门（2026-09-21 补齐）：只读态下“进入编辑模式”也要拦 —— 内部视图的楼层/家具改动
// 曾经可以照改内存、但不会落盘（静默丢数据）。
import { guardWrite } from '../store/writeGate';
import { useCanvasRenderer } from '../composables/useCanvasRenderer';
import { usePromptDialog } from '../composables/usePromptDialog';
import EagleEye from './EagleEye.vue';
import { computeViewBounds } from '../utils/viewport';
import { withAlpha } from '../utils/colorUtil';
import { getPreset, drawStyledLabel } from '../utils/labelStyles';
// 建筑内部（2026-11-13 第 1/3 刀）：墙由工具栏画，房间由墙自动围合
import { detectRooms, mergeDetectedRooms } from '../utils/roomDetection';
import { drawInteriorFloor } from '../interior/renderFloor';
import { DEFAULT_WALL_THICKNESS, formatLength, formatArea, fitZoom } from '../utils/interiorUnits';
// 外观（2026-11-14）：同一份楼层数据的 3D 渲染。three 只在点开时动态加载。
import ExteriorView from './ExteriorView.vue';
import { hasWalls } from '../interior/buildShell';
// 出图（第 4 刀）：版式是纯函数，平面图本体仍走 drawInteriorFloor（换 print 主题）= 同源
import { buildPlanSheet, drawPlanSheet } from '../interior/planSheet';
import { drawFurnitureSymbol } from '../interior/furnitureSymbols';
import { worldPointsToCustom, customToWorldPoints } from '../interior/customShape';
import { collectTargets, resolveSnap } from '../interior/alignment';
import { findShortcut, groupShortcuts } from '../interior/shortcuts';
import { getRoomPolygon, polygonArea, pointInPolygon } from '../utils/roomDetection';

const props = defineProps({
  buildingNode: { type: Object, default: null },
});

const store = useGeodataStore();

const canvas = ref(null);
const editMode = ref(false);
const interactionMode = ref('pan');
const selectedFurniture = ref(null);
const selectedFurnitureIds = ref([]); // 多选家具 ID 列表
const gridSnapEnabled = ref(true);
const gridSize = ref(40);

// ===== 参考图底图 =====
const showRefImagePanel = ref(false);
const refImageLoading = ref(false);
const refOpacity = ref(0.5);
const refScale = ref(1);
const activeRefIndex = ref(0);
const refImageObjs = reactive({});
const referenceImages = computed(() => store.interiorReferenceImages[props.buildingNode?.id] || []);
const referenceImage = computed(() => referenceImages.value[activeRefIndex.value] || null);

// 家具类型
/** 室内画布自己的标签样式（深字 + 白描边 + 屏幕恒定 11px） */
const INTERIOR_LABEL_STYLE = {
  fontFamily: 'sans-serif',
  fontSize: 11,
  weight: '600',
  color: '#48535f',
  stroke: { enabled: true, color: 'rgba(255,255,255,0.92)', width: 2.5 },
  shadow: { enabled: false, color: 'rgba(0,0,0,0.4)', blur: 4 },
  background: { enabled: false, color: '#ffffff', opacity: 0.5, padding: 2 },
  lockScreenSize: true,
};

const FURNITURE_TYPES = [
  { type: 'generic', label: '通用', icon: 'package', color: '#8B8B8B' },
  { type: 'table', label: '桌子', icon: 'table', color: '#A0522D' },
  { type: 'chair', label: '椅子', icon: 'armchair', color: '#CD853F' },
  { type: 'bed', label: '床', icon: 'bed', color: '#4682B4' },
  { type: 'chest', label: '柜子', icon: 'archive', color: '#8B4513' },
  { type: 'wardrobe', label: '衣柜', icon: 'archive', color: '#6B4226' },
  { type: 'sofa', label: '沙发', icon: 'armchair', color: '#6E7F8D' },
  { type: 'decoration', label: '装饰', icon: 'vase', color: '#DAA520' },
  { type: 'door', label: '门', icon: 'door-open', color: '#696969' },
  { type: 'window', label: '窗', icon: 'window', color: '#87CEEB' },
  // 区域类型（院落/园林）
  { type: 'courtyard', label: '院落', icon: 'home', color: '#4CAF50', isArea: true },
  { type: 'garden', label: '园林', icon: 'tree', color: '#2E7D32', isArea: true },
  { type: 'corridor', label: '走廊', icon: 'route', color: '#FF9800', isArea: true },
  { type: 'pond', label: '水池', icon: 'droplet', color: '#2196F3', isArea: true },
  { type: 'wall', label: '围墙', icon: 'fence', color: '#795548', isArea: true },
];

// 判断是否为区域类型
function isAreaType(type) {
  const ft = FURNITURE_TYPES.find(t => t.type === type);
  return ft?.isArea || false;
}

// ===== 参考图绘制 =====
function drawReferenceImage(ctx) {
  const refs = referenceImages.value;
  if (!refs || refs.length === 0) return;
  
  refs.forEach((refImg) => {
    if (!refImg || !refImg.dataUrl) return;
    const img = refImageObjs[refImg.id];
    if (!img) return;
    
    const w = (refImg.width || img.width) * (refImg.scale || 1);
    const h = (refImg.height || img.height) * (refImg.scale || 1);
    const rot = (refImg.rotation || 0) % 4;
    const flipH = !!refImg.flipH;
    const cx = refImg.offsetX;
    const cy = refImg.offsetY;
    const drawW = rot % 2 === 0 ? w : h;
    const drawH = rot % 2 === 0 ? h : w;
    
    ctx.save();
    ctx.globalAlpha = refImg.opacity ?? 0.5;
    ctx.translate(cx, cy);
    ctx.rotate(rot * Math.PI / 2);
    if (flipH) ctx.scale(-1, 1);
    ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();
  });
}

// ===== 参考图操作 =====
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

async function importReferenceImage() {
  if (!props.buildingNode) return;
  refImageLoading.value = true;
  try {
    const result = await window.sitianAPI.selectReferenceImage();
    if (result?.success && result.dataUrl) {
      const img = new Image();
      img.onload = () => {
        const scale = 500 / img.width;
        const cx = renderer.getViewTransform();
        const center = { x: -cx.x / cx.scale, y: -cx.y / cx.scale };
        const list = referenceImages.value || [];
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
        store.updateInteriorReferenceImage(props.buildingNode.id, refImage);
        activeRefIndex.value = (referenceImages.value || []).length - 1;
        refImageObjs[refImage.id] = img;
        refImageLoading.value = false;
      };
      img.onerror = () => { refImageLoading.value = false; };
      img.src = result.dataUrl;
    } else {
      refImageLoading.value = false;
    }
  } catch (e) {
    refImageLoading.value = false;
  }
}

function updateRefOpacity() {
  if (!referenceImage.value) return;
  store.updateInteriorReferenceImage(props.buildingNode.id, {
    ...referenceImage.value,
    opacity: refOpacity.value,
  });
}

function updateRefScale() {
  if (!referenceImage.value) return;
  store.updateInteriorReferenceImage(props.buildingNode.id, {
    ...referenceImage.value,
    scale: refScale.value,
  });
}

function removeReferenceImage() {
  const ref = referenceImage.value;
  if (!ref) return;
  store.removeInteriorReferenceImage(props.buildingNode.id, ref.id);
  delete refImageObjs[ref.id];
}

function removeRefListItem(idx) {
  const ref = referenceImages.value[idx];
  if (!ref) return;
  store.removeInteriorReferenceImage(props.buildingNode.id, ref.id);
  delete refImageObjs[ref.id];
  if (activeRefIndex.value >= referenceImages.value.length) {
    activeRefIndex.value = Math.max(0, referenceImages.value.length - 1);
  }
}

const selectedFurnitureType = ref('generic');
const selectedRoomTemplate = ref('bedroom');
// R5-3 跨楼层复制/移动
const transferDialogOpen = ref(false);
const transferTargetFloorId = ref(null);
const transferMode = ref('copy');

// 添加家具对话框
const addFurnitureDialogOpen = ref(false);
const newFurnitureName = ref('');
const newFurnitureType = ref('generic');
const newFurnitureWidth = ref(60);
const newFurnitureHeight = ref(40);
const addFurnitureWorldPos = ref({ x: 0, y: 0 });

// ===== 房间模板（R5-1）：一键铺好整间，一次操作 = 一条 undo =====
// 坐标是相对“点击点”的偏移；尺寸取 getDefaultSize（单一事实源，不重复写死宽高）
// ⚠️ 偏移必须是网格步长（20）的整数倍 —— 开启网格吸附时基点会被吸附，
// 若偏移不整则整间里会有家具落在网格外（test_25 会守这条）
const ROOM_TEMPLATES = [
  {
    id: 'bedroom', label: '卧室', icon: 'bed', hint: '床 + 两侧柜 + 装饰',
    items: [
      { type: 'bed', name: '床', dx: 0, dy: 0 },
      { type: 'chest', name: '衣柜', dx: -180, dy: -80 },
      { type: 'chest', name: '床头柜', dx: 180, dy: 0 },
      { type: 'decoration', name: '挂饰', dx: 0, dy: 140 },
    ],
  },
  {
    id: 'kitchen', label: '厨房', icon: 'package', hint: '餐桌 + 灶台 + 储物 + 椅',
    items: [
      { type: 'table', name: '料理台', dx: 0, dy: 0 },
      { type: 'chest', name: '灶台', dx: -160, dy: -80 },
      { type: 'chest', name: '储物柜', dx: 160, dy: -80 },
      { type: 'chair', name: '凳', dx: 0, dy: 100 },
    ],
  },
  {
    id: 'hall', label: '大厅', icon: 'table', hint: '长桌 + 四椅 + 双装饰',
    items: [
      { type: 'table', name: '长桌', dx: 0, dy: 0 },
      { type: 'chair', name: '椅·左', dx: -100, dy: 0 },
      { type: 'chair', name: '椅·右', dx: 100, dy: 0 },
      { type: 'chair', name: '椅·上', dx: 0, dy: -80 },
      { type: 'chair', name: '椅·下', dx: 0, dy: 80 },
      { type: 'decoration', name: '装饰·左', dx: -220, dy: -80 },
      { type: 'decoration', name: '装饰·右', dx: 220, dy: -80 },
    ],
  },
  {
    id: 'study', label: '书房', icon: 'book', hint: '书桌 + 椅 + 双书柜',
    items: [
      { type: 'table', name: '书桌', dx: 0, dy: 0 },
      { type: 'chair', name: '椅', dx: 0, dy: 100 },
      { type: 'chest', name: '书柜·一', dx: 160, dy: -80 },
      { type: 'chest', name: '书柜·二', dx: 160, dy: 40 },
    ],
  },
  {
    id: 'storage', label: '仓库', icon: 'archive', hint: '四组货架',
    items: [
      { type: 'chest', name: '货架·一', dx: -120, dy: -80 },
      { type: 'chest', name: '货架·二', dx: 120, dy: -80 },
      { type: 'chest', name: '货架·三', dx: -120, dy: 80 },
      { type: 'chest', name: '货架·四', dx: 120, dy: 80 },
    ],
  },
];

function getDefaultSize(type) {
  // 2026-11-13：从"整数凑的方块"改成**真实尺寸**（cm）。原来一张床 100×80 ——
  // 比单人床还小，房间和家具的比例一眼就不对。坐标口径见 utils/interiorUnits.js。
  const defaults = {
    generic: { w: 80, h: 60 },
    table: { w: 140, h: 80 },      // 餐桌/书桌
    chair: { w: 45, h: 45 },
    bed: { w: 200, h: 150 },       // 双人床
    chest: { w: 120, h: 60 },      // 衣柜/书柜/货架
    decoration: { w: 40, h: 40 },
    door: { w: 90, h: 20 },
    window: { w: 120, h: 20 },
    courtyard: { w: 600, h: 600 },
    garden: { w: 800, h: 600 },
    corridor: { w: 200, h: 80 },
    pond: { w: 300, h: 200 },
    wall: { w: 600, h: 24 },
  };
  return defaults[type] || { w: 80, h: 60 };
}

// 类型变化时自动调整默认尺寸
watch(newFurnitureType, (type) => {
  const size = getDefaultSize(type);
  newFurnitureWidth.value = size.w;
  newFurnitureHeight.value = size.h;
});

// 家具详情浮窗编辑
const editingPopover = ref(false);
const editForm = reactive({
  name: '',
  type: 'generic',
  width: 40,
  height: 40,
  rotation: 0,
});

// 当前楼层列表
const floors = computed(() => {
  if (!props.buildingNode) return [];
  const data = store.interiorData[props.buildingNode.id];
  return data?.floors || [];
});

// 外观（3D）：没有墙就没什么可看的 —— 按钮灰禁并说明原因，不让用户点进去看空白
const showExterior = ref(false);
const canShowExterior = computed(() => hasWalls(floors.value));

// ===== 出图（2026-11-14，第 4 刀）=====
const exporting = ref(false);
const exportMsg = ref('');
const exportMsgErr = ref(false);
let exportTimer = 0;

function setExportMsg(text, isErr = false) {
  exportMsg.value = text;
  exportMsgErr.value = isErr;
  if (exportTimer) clearTimeout(exportTimer);
  // 失败不设 TTL（"失败要看得见"，本项目纪律）；成功 4 秒后淡出
  exportTimer = window.setTimeout(() => {
    if (!isErr) { exportMsg.value = ''; exportTimer = 0; }
  }, 4000);
}

/** 本层墙端点的外接尺寸（cm）。空层给 0 —— 版式层自己会兜底。 */
function floorFootprint(floor) {
  const walls = (floor && floor.walls) || [];
  if (!walls.length) return { w: 0, h: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const w of walls) {
    for (const p of [w.start, w.end]) {
      if (!p) continue;
      minX = Math.min(minX, Number(p.x) || 0); maxX = Math.max(maxX, Number(p.x) || 0);
      minY = Math.min(minY, Number(p.y) || 0); maxY = Math.max(maxY, Number(p.y) || 0);
    }
  }
  // 墙有厚度：外接框各边加半个墙厚，图别把墙面切掉
  const t = Math.max(...walls.map((w) => Number(w.thickness) || 12), 12);
  return {
    w: Math.max(0, maxX - minX) + t,
    h: Math.max(0, maxY - minY) + t,
    minX, minY, t,
  };
}

/** 房间面积（cm²）：与画布同一口径（getRoomPolygon → polygonArea） */
function floorRoomsWithArea(floor) {
  const walls = (floor && floor.walls) || [];
  return ((floor && floor.rooms) || []).map((r, i) => ({
    // 没命名的房间在面积表里会变成一行行"未命名"（用户分不清是哪间）→ 给序号
    name: r.name || `房间 ${i + 1}`,
    area: polygonArea(getRoomPolygon(r, walls)),
  }));
}

const EXPORT_SCALE = 2;   // 2 倍 → 2244×1588（约 192dpi，印 A4 够）

async function exportPlanSheet() {
  const floor = currentFloor.value;
  if (!floor || exporting.value) return;
  exporting.value = true;
  setExportMsg('');
  try {
    const fp = floorFootprint(floor);
    const sheet = buildPlanSheet({
      buildingName: props.buildingNode?.name || '建筑',
      floorName: floor.name || '',
      footprint: { w: fp.w, h: fp.h },
      rooms: floorRoomsWithArea(floor),
      paper: 'A4',
      date: new Date().toISOString().slice(0, 10),
      appName: '司天',
      version: (typeof window !== 'undefined' && window.sitianAPI && window.sitianAPI.version) || '',
    });

    const cvs = document.createElement('canvas');
    cvs.width = Math.round(sheet.paper.w * EXPORT_SCALE);
    cvs.height = Math.round(sheet.paper.h * EXPORT_SCALE);
    const ctx = cvs.getContext('2d');
    if (!ctx) throw new Error('拿不到画布上下文');
    ctx.scale(EXPORT_SCALE, EXPORT_SCALE);

    // 平面图本体：同一套绘制函数、print 主题；裁剪/居中由版式层负责
    drawPlanSheet(ctx, sheet, (c) => {
      // 世界原点平移到外接框左上（版式层已按 pxPerCm 缩放，这里是 cm 坐标）
      c.translate(-(fp.minX - fp.t / 2), -(fp.minY - fp.t / 2));
      drawInteriorFloor(c, floor, { zoom: sheet.pxPerCm, theme: 'print' });
    });

    const dataUrl = cvs.toDataURL('image/png');
    const name = `${props.buildingNode?.name || '建筑'}-${floor.name || '楼层'}-平面图.png`
      .replace(/[\/:*?"<>|]/g, '_');
    const api = window.sitianAPI;
    if (!api || !api.saveExportFile) throw new Error('当前环境不支持导出（缺少保存通道）');
    const r = await api.saveExportFile({ dataUrl, defaultName: name });
    if (r && r.success) setExportMsg(`已导出：${(r.path || name).split(/[\\/]/).pop()}`);
    else if (r && r.canceled) setExportMsg('');
    else setExportMsg(`导出失败：${(r && r.error) || '未知原因'}`, true);
  } catch (e) {
    setExportMsg(`导出失败：${e && e.message ? e.message : String(e)}`, true);
  } finally {
    exporting.value = false;
  }
}

// 同区域建筑列表（用于建筑间跳转）
const sameAreaBuildings = computed(() => {
  if (!props.buildingNode?.parentId) return [];
  return store.getBuildingsInArea(props.buildingNode.parentId);
});
const showBuildingMenu = ref(false);

// 切换到相邻建筑
function switchBuilding(building) {
  if (building.id !== props.buildingNode?.id) {
    store.selectBuilding(building);
  }
  showBuildingMenu.value = false;
}

// 当前选中楼层 ID
const currentFloorId = ref(null);

// 当前楼层对象（墙/房间绘制要用整层，不只是家具）
const currentFloor = computed(() => floors.value.find(f => f.id === currentFloorId.value) || null);

// 画墙：第一次点击记起点，第二次成墙；选中墙可拖端点（第 2.5 刀的最小版）
const wallDraftStart = ref(null);
const selectedWallId = ref(null);
// 选中的门窗（2026-11-14，台账 A11）：{ kind:'doors'|'windows', id, wallId }
const selectedOpening = ref(null);
const editingOpening = ref(false);
// 尺寸标注（A25）：默认开（平面图没有尺寸就不像图），可在工具栏关掉以免看乱
const showDimensions = ref(true);
const openingForm = reactive({ kind: 'doors', width: 90, height: 200, sillHeight: 90, position: 0.5 });

/**
 * 重新识别本层房间。
 * 只在"墙变了"之后调用（画完/删墙/拖完端点）—— 拖拽中每帧跑 detectRooms 会掉帧。
 */
function recalcRooms() {
  const floor = currentFloor.value;
  const buildingId = props.buildingNode?.id;
  if (!floor || !buildingId) return;
  const walls = Array.isArray(floor.walls) ? floor.walls : [];
  if (walls.length < 3) {
    if ((floor.rooms || []).length) store.setFloorRooms(buildingId, floor.id, []);
    return;
  }
  const detected = detectRooms(walls, { eps: 2 });
  const merged = mergeDetectedRooms(floor.rooms || [], detected);
  store.setFloorRooms(buildingId, floor.id, merged);
}

/** 画墙工具：两次点击成一面墙，画完自动重算房间 */
function handleWallClick(wx, wy) {
  const floorId = currentFloorId.value;
  const buildingId = props.buildingNode?.id;
  if (!floorId || !buildingId) return;
  // A26：正交（Shift）/ 端点吸附 / 轴线吸附 / 网格，统一一处算
  const p = resolvePlacement(wx, wy, { from: wallDraftStart.value }).xy;
  const start = wallDraftStart.value;
  if (!start) {
    wallDraftStart.value = p;
    return;
  }
  // 太短的墙视为误点（< 10cm 什么都画不出来）
  if (Math.hypot(p.x - start.x, p.y - start.y) < 10) return;
  store.addWall(buildingId, floorId, {
    start,
    end: p,
    thickness: wallThickness.value,
  });
  // 连续画：下一段从刚才的落点起（CAD 习惯），Esc / 切工具结束
  wallDraftStart.value = p;
  recalcRooms();
  renderer.requestRender();
}
const wallThickness = ref(DEFAULT_WALL_THICKNESS);

// 当前楼层的家具列表
const currentFurniture = computed(() => {
  const floor = floors.value.find(f => f.id === currentFloorId.value);
  return floor?.furniture || [];
});

// 楼层切换
function selectFloor(floorId) {
  currentFloorId.value = floorId;
  selectedFurniture.value = null;
  fitToFloor();
  renderer.requestRender();
}

function addFloor() {
  if (!props.buildingNode) return;
  const newFloor = store.addFloor(props.buildingNode.id, `楼层 ${floors.value.length + 1}`);
  currentFloorId.value = newFloor.id;
  renderer.requestRender();
}

async function renameFloor() {
  if (!currentFloorId.value) return;
  const floor = floors.value.find(f => f.id === currentFloorId.value);
  if (!floor) return;
  // 批次D1：window.prompt 在 Electron 渲染进程不被支持（楼层重命名此前静默失效）
  const newName = await promptDialog.askText({ title: '楼层名称', defaultValue: floor.name });
  if (newName && newName.trim()) {
    store.updateFloor(props.buildingNode.id, currentFloorId.value, { name: newName.trim() });
  }
}

function removeFloor() {
  if (floors.value.length <= 1) return;
  if (!confirm('确定删除当前楼层及其上的所有家具？')) return;
  store.removeFloor(props.buildingNode.id, currentFloorId.value);
  // 切换到第一个楼层
  if (floors.value.length > 0) {
    currentFloorId.value = floors.value[0].id;
  }
  renderer.requestRender();
}

// ===== Canvas Renderer =====
const shapeEdit = reactive({ active: false, furnitureId: null, points: [], cursor: null, smooth: false });

const shapeItem = computed(() => currentFurniture.value.find((f) => f.id === shapeEdit.furnitureId) || null);
const shapePointCount = computed(() => shapeEdit.points.length);

// ===== 对齐辅助与正交（2026-11-15，A26）=====
// guides：要画的参考线（世界坐标的 x / y）；null = 不画。
// 用 ref 而不是 reactive 单值，是为了让"没有参考线"和"参考线在 0"能区分开。
const alignGuides = ref({ x: null, y: null });
// 快捷键帮助浮层（A27）：表驱动，内容来自 interior/shortcuts.js，不在这里另抄一份
const shortcutsHelpOpen = ref(false);
const shortcutGroups = groupShortcuts();
const alignSnapPoint = ref(null);
const pointerWorld = ref(null);
const shiftDown = ref(false);

/** 吸附半径：屏幕 10px 换算成世界单位（缩得越小，可吸范围越大） */
function snapTol() {
  const z = renderer.getViewTransform().scale || 1;
  return 10 / z;
}

/**
 * 统一算落点：正交（Shift）> 端点吸附 > 轴线吸附 > 网格。
 * 顺手把参考线写进 alignGuides —— 调用方不用各写一遍（写漏一处就会"吸了但没显示"）。
 */
function resolvePlacement(wx, wy, opts = {}) {
  const floor = currentFloor.value;
  const targets = collectTargets((floor && floor.walls) || [], opts.excludeIds || []);
  const r = resolveSnap({ x: wx, y: wy }, targets, {
    tol: snapTol(),
    orthogonal: shiftDown.value && !!opts.from,
    from: opts.from || null,
    grid: gridSnapEnabled.value ? gridSize.value : 0,
  });
  alignGuides.value = { x: r.guides.x, y: r.guides.y };
  alignSnapPoint.value = r.snapPoint;
  return { ...r, xy: { x: r.x, y: r.y } };
}

function clearAlignGuides() {
  if (alignGuides.value.x === null && alignGuides.value.y === null && alignSnapPoint.value === null) return;
  alignGuides.value = { x: null, y: null };
  alignSnapPoint.value = null;
}

const renderer = useCanvasRenderer(canvas, {
  onRender: (ctx, w, h) => {
    // 🔴 背景必须铺满**整个视口**（2026-11-13 截图抓出来的既有缺陷）：
    //    这里拿到 ctx 时相机变换已经应用（useCanvasRenderer 先 translate+scale 再调 onRender），
    //    原来的 `fillRect(0, 0, w, h)` 用的是**世界坐标** —— 只涂了世界正半轴那一块，
    //    平移/缩放后另一半露白（截图里右上角整片白）。
    //    改成先算"视口对应的世界矩形"再涂。
    const vt0 = renderer.getViewTransform();
    const cs0 = vt0.scale || 1;
    const vx0 = -(w / 2 + vt0.x) / cs0;
    const vy0 = -(h / 2 + vt0.y) / cs0;
    const vw0 = w / cs0;
    const vh0 = h / cs0;
    // 2026-11-14：深紫底改**纸白**（与出图同一套主题）—— 深底上"墙+半透明房间"看着像原型，
    // 白底才像一张平面图；出图与屏幕也因此共用同一份配色。
    const bg = ctx.createLinearGradient(vx0, vy0, vx0 + vw0, vy0 + vh0);
    bg.addColorStop(0, '#ffffff');
    bg.addColorStop(1, '#f6f7f9');
    ctx.fillStyle = bg;
    ctx.fillRect(vx0, vy0, vw0, vh0);

    // 参考图底图（编辑模式下）
    if (editMode.value) {
      drawReferenceImage(ctx);
    }

    // 网格（编辑模式开启时显示）
    if (editMode.value && gridSnapEnabled.value) {
      drawGrid(ctx, w, h);
    }

    // 建筑内部第 3 刀（2026-11-13）：房间填充 → 墙 → 门窗，在家具下面一层
    if (currentFloor.value) {
      drawInteriorFloor(ctx, currentFloor.value, {
        zoom: renderer.getViewTransform().scale,
        theme: 'print',
        selectedWallId: selectedWallId.value || undefined,
        selectedOpeningId: selectedOpening.value?.id || undefined,
        showDimensions: showDimensions.value,
      });
    }

    // 绘制家具
    drawFurniture(ctx);

    // A4: 拖拽家具时高亮吸附网格点
    drawDragHighlight(ctx);

    // 画墙预览 + 对齐参考线（A26）：在墙/家具之上，用户能看着线落点
    drawWallDraftPreview(ctx);
    drawAlignGuides(ctx);

    // 家具自绘：轮廓预览画在最上层（在画墙/家具之上，用户点哪看哪）
    drawShapeEditPreview(ctx);
  },
  onDragStart: handleDragStart,
  onDragMove: handleDragMove,
  onDragEnd: handleDragEnd,
  onHitTest: hitTest,
  onDblClick: handleCanvasDblClick,
  onClick: handleCanvasClick,
  onBoxSelect: handleBoxSelect,
  onWheel: handleWheel,
  // 自绘时的橡皮筋要跟着光标走（其余时候不做任何事，避免无谓重绘）
  onPointerMove: (wx, wy) => {
    pointerWorld.value = { x: wx, y: wy };
    if (shapeEdit.active) {
      shapeEdit.cursor = { x: wx, y: wy };
      renderer.requestRender();
      return;
    }
    // 画墙草稿期间：预览线 + 吸附参考线要跟着走（没有预览的话，用户点下去才知道墙在哪）
    if (interactionMode.value === 'add_wall' && wallDraftStart.value) {
      resolvePlacement(wx, wy, { from: wallDraftStart.value });
      renderer.requestRender();
    }
  },
  interactionMode: interactionMode,
});

// ===== 绘制函数 =====
function drawGrid(ctx, w, h) {
  const vt = renderer.getViewTransform();
  const cs = vt.scale || 1;          // px per cm
  const cvs = canvas.value;
  // 🔴 2026-11-13：这里原来把世界坐标再转一次屏幕坐标（`(x - worldLeft) * scale`），
  //    而 ctx 已经应用过相机变换 → 网格整体偏移，只画在世界正半轴那一块。
  //    现在一律用**世界坐标**画线，范围由视口反算。
  const worldLeft = -(cvs.clientWidth / 2 + vt.x) / cs;
  const worldTop = -(cvs.clientHeight / 2 + vt.y) / cs;
  const worldRight = (cvs.clientWidth / 2 - vt.x) / cs;
  const worldBottom = (cvs.clientHeight / 2 - vt.y) / cs;

  const step = gridSize.value;
  if (!(step > 0)) return;
  const startX = Math.floor(worldLeft / step) * step;
  const startY = Math.floor(worldTop / step) * step;

  // 网格线
  ctx.save();
  ctx.strokeStyle = 'rgba(110, 130, 150, 0.16)';
  ctx.lineWidth = 1 / cs;            // 屏幕上恒 1px
  ctx.beginPath();
  for (let x = startX; x <= worldRight; x += step) {
    ctx.moveTo(x, worldTop);
    ctx.lineTo(x, worldBottom);
  }
  for (let y = startY; y <= worldBottom; y += step) {
    ctx.moveTo(worldLeft, y);
    ctx.lineTo(worldRight, y);
  }
  ctx.stroke();

  // 网格标签（每两格标一次；单位是厘米，显示走 formatLength）
  // 字号走 canvasFont（与其它三张画布同一份字体栈），尺寸按 zoom 反算保持屏幕恒定
  ctx.font = canvasFont(11 / cs);
  ctx.fillStyle = 'rgba(110, 125, 145, 0.7)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const labelEvery = step * 2;
  for (let x = Math.ceil(worldLeft / labelEvery) * labelEvery; x <= worldRight; x += labelEvery) {
    ctx.fillText(formatLength(x), x + 3 / cs, worldTop + 3 / cs);
  }
  for (let y = Math.ceil(worldTop / labelEvery) * labelEvery; y <= worldBottom; y += labelEvery) {
    ctx.fillText(formatLength(y), worldLeft + 3 / cs, y + 2 / cs);
  }
  ctx.restore();
}

// A4: 拖拽家具时高亮吸附网格点
function drawDragHighlight(ctx) {
  const step = gridSize.value;
  const vt = renderer.getViewTransform();
  const cvs = canvas.value;
  const centerX = cvs.clientWidth / 2 + vt.x;
  const centerY = cvs.clientHeight / 2 + vt.y;
  const worldLeft = -centerX / vt.scale;
  if (isDraggingFurniture.value && gridSnapEnabled.value && dragPreviewPos.value && selectedFurniture.value) {
    const item = selectedFurniture.value;
    const snapX = Math.round(dragPreviewPos.value.x / step) * step;
    const snapY = Math.round(dragPreviewPos.value.y / step) * step;
    const sx = (snapX - worldLeft + item.width / 2) * vt.scale;
    const sy = (snapY - worldTop + item.height / 2) * vt.scale;
    ctx.fillStyle = 'rgba(88, 166, 255, 0.5)';
    ctx.beginPath();
    ctx.arc(sx, sy, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawFurniture(ctx) {
  const items = currentFurniture.value;
  const fast = renderer.isFastMode(); // 批次C2：拖拽中跳过家具阴影与名称标签
  items.forEach(item => {
    const isSelected = selectedFurniture.value?.id === item.id;
    const isMultiSelected = selectedFurnitureIds.value.includes(item.id);
    const color = getFurnitureColor(item.type);
    const isArea = isAreaType(item.type);

    ctx.save();
    ctx.translate(item.x + item.width / 2, item.y + item.height / 2);
    if (item.rotation) ctx.rotate((item.rotation * Math.PI) / 180);

    if (isArea) {
      // 区域类型：半透明填充 + 虚线边框 + 图标
      // 半透明填充走 `withAlpha`（同 GalaxyMap 的边界层：字符串拼 alpha 对 hsl 是非法 CSS，会被静默忽略）
      ctx.fillStyle = withAlpha(color, '33');
      ctx.fillRect(-item.width / 2, -item.height / 2, item.width, item.height);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(-item.width / 2, -item.height / 2, item.width, item.height);
      ctx.setLineDash([]);
      const ft = FURNITURE_TYPES.find(t => t.type === item.type);
      const icon = ft?.icon || 'map-pin';
      const iconSize = Math.min(item.width, item.height) * 0.6;
      if (!fast) drawIconOrEmoji(ctx, icon, 0, 0, iconSize, color);
    } else {
      // 家具类型：**平面符号**（2026-11-14）—— 原来是一块纯色矩形，谁也认不出是床还是柜子。
      // 符号按真实尺寸（cm）画，与出图同一套；拖动中（fast）也画，只是不画阴影。
      if (!fast) {
        ctx.shadowColor = isSelected ? 'rgba(255, 193, 7, 0.55)' : 'rgba(40, 50, 60, 0.16)';
        ctx.shadowBlur = isSelected ? 10 : 3;
        ctx.shadowOffsetY = 1;
      }
      drawFurnitureSymbol(ctx, item, { zoom: renderer.getViewTransform().scale });
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      void color;
    }

    // 选中高亮
    if (isSelected) {
      ctx.strokeStyle = '#FFD700';
      ctx.lineWidth = 2;
      ctx.strokeRect(-item.width / 2 - 2, -item.height / 2 - 2, item.width + 4, item.height + 4);
    } else if (isMultiSelected) {
      ctx.strokeStyle = '#58a6ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(-item.width / 2 - 2, -item.height / 2 - 2, item.width + 4, item.height + 4);
    }

    // 边框：只有区域类型还需要（家具符号自己描边）
    if (isArea) {
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 1;
      ctx.strokeRect(-item.width / 2, -item.height / 2, item.width, item.height);
    }

    ctx.restore();

    // 名称标签（P0-2：走 building 预设，与其它视图同一套样式系统）
    if (item.name && !fast) {
      // 词条样式单独给：原来借 `building` 预设（10cm 世界字号、浅灰 #D7DEE8）——
      // 那是给深色地图准备的，白底平面图上等于看不见。这里用深字 + 白描边 + 屏幕恒定字号。
      drawStyledLabel(ctx, item.name, item.x + item.width / 2, item.y + item.height + 6, INTERIOR_LABEL_STYLE, {
        align: 'center',
        baseline: 'top',
        screenScale: renderer.viewTransform.scale,
      });
    }
  });
}

function getFurnitureColor(type) {
  const ft = FURNITURE_TYPES.find(t => t.type === type);
  return ft?.color || '#8B8B8B';
}

function getFurnitureTypeLabel(type) {
  const ft = FURNITURE_TYPES.find(t => t.type === type);
  return ft?.label || type;
}

// ===== 拖拽状态 =====
const dragStartPos = ref(null);
const dragStartFurniturePos = ref(null);
// A4: 拖拽家具时的预览位置（用于网格吸附高亮）
const dragPreviewPos = ref(null);
const isDraggingFurniture = ref(false);
const multiFurnitureStartMap = ref(null); // Map<id, {x,y}>

// ===== 交互 =====
function handleDragStart(wx, wy, button, shiftKey, ctrlKey, panTry) {
  // 画形状期间（2026-11-15 增强）：
  //   · 按在**已有顶点**上 → 拖它微调（画歪一点不用重画）；
  //   · 按在空白处 → 什么也不做（点击加点由 handleCanvasClick 处理）。
  // 两种都不许顺手把家具拖走或平移画布。
  if (shapeEdit.active) {
    const i = hitShapeVertex(wx, wy);
    if (i >= 0) return { mode: 'node', nodeId: `shape-vertex:${i}` };
    return false;
  }

  // 这几种是"点一下放一个东西"的工具，不进入拖拽
  if (['add_furniture', 'add_wall', 'add_door', 'add_window'].includes(interactionMode.value)) {
    return false;
  }

  // 墙端点优先于家具（端点通常不在家具上，但手感上"先抓墙"更符合预期）
  if (editMode.value && !['add_wall', 'add_door', 'add_window'].includes(interactionMode.value)) {
    const handle = hitWallHandle(wx, wy);
    if (handle) {
      wallDrag.value = {
        wallId: handle.wall.id,
        end: handle.end,
        origin: JSON.parse(JSON.stringify(handle.wall)),
        // A13 墙联动：所有**共用这个端点**的邻墙都要跟着走（否则拖走一面墙，另一面留在原地）
        links: linkedWallsAt(handle.wall, handle.end),
      };
      selectedWallId.value = handle.wall.id;
      selectedFurniture.value = null;
      selectedFurnitureIds.value = [];
      renderer.requestRender();
      return { mode: 'wall-end', wallId: handle.wall.id, end: handle.end };
    }
    // 点墙身 = 选中这面墙（Delete 可删）
    const body = hitWallBody(wx, wy);
    if (body) {
      selectedWallId.value = body.id;
      selectedFurniture.value = null;
      selectedFurnitureIds.value = [];
      renderer.requestRender();
      return false;      // 不进入拖拽：墙身拖动暂不支持（拖动会带走整面墙，手感与对手件不同）
    }
  }

  const hit = hitTest(wx, wy);
  if (hit) {
    // 多选模式：Shift/Ctrl+点击
    if (shiftKey || ctrlKey) {
      const idx = selectedFurnitureIds.value.indexOf(hit.id);
      if (idx === -1) {
        selectedFurnitureIds.value.push(hit.id);
      } else {
        selectedFurnitureIds.value.splice(idx, 1);
      }
      selectedFurniture.value = hit;
    } else {
      // 单选：如果点击的家具不在多选列表中，清空多选
      if (!selectedFurnitureIds.value.includes(hit.id)) {
        selectedFurnitureIds.value = [hit.id];
      }
      selectedFurniture.value = hit;
    }
    dragStartPos.value = { x: wx, y: wy };
    dragStartFurniturePos.value = { x: hit.x, y: hit.y };
    isDraggingFurniture.value = true;

    // 记录多选拖拽起始位置
    if (selectedFurnitureIds.value.length > 1) {
      multiFurnitureStartMap.value = new Map();
      for (const id of selectedFurnitureIds.value) {
        const item = currentFurniture.value.find(f => f.id === id);
        if (item) {
          multiFurnitureStartMap.value.set(id, { x: item.x, y: item.y });
        }
      }
    }

    renderer.requestRender();
    return { mode: 'node', nodeId: hit.id };
  }

  selectedFurniture.value = null;
  if (!shiftKey && !ctrlKey) {
    selectedFurnitureIds.value = [];
  }
  renderer.requestRender();
  return true;
}

function handleDragMove(wx, wy, info) {
  // 自绘顶点微调（2026-11-15）：只改内存里的点，松手不写库（形状还没保存）
  if (shapeEdit.active && info && info.mode === 'node' && typeof info.nodeId === 'string'
    && info.nodeId.startsWith('shape-vertex:')) {
    const i = Number(info.nodeId.slice('shape-vertex:'.length));
    if (Number.isInteger(i) && shapeEdit.points[i]) {
      shapeEdit.points[i] = { x: wx, y: wy };
      shapeEdit.cursor = { x: wx, y: wy };
      renderer.requestRender();
    }
    return;
  }

  // 拖墙端点：直接改内存 + 重画（松手才落一条 undo，见 handleDragEnd）
  if (wallDrag.value) {
    const floor = currentFloor.value;
    const w = floor && (floor.walls || []).find(x => x.id === wallDrag.value.wallId);
    if (!w) { wallDrag.value = null; return; }
    // A26：拖墙角也吸附（from = 这面墙的另一端，正交时按住 Shift 走直角）
    const other = wallDrag.value.end === 'start' ? w.end : w.start;
    const excludeIds = [w.id, ...(wallDrag.value.links || []).map((l) => l.wallId)];
    const p = resolvePlacement(wx, wy, { from: other, excludeIds }).xy;
    w[wallDrag.value.end] = p;
    // A13：共用这个端点的邻墙一起动（内存里改，松手才落一条 undo）
    for (const l of wallDrag.value.links || []) {
      const lw = (floor.walls || []).find((x) => x.id === l.wallId);
      if (lw) lw[l.end] = { x: p.x, y: p.y };
    }
    renderer.requestRender();
    return;
  }
  if (isDraggingFurniture.value && selectedFurniture.value) {
    const dx = wx - dragStartPos.value.x;
    const dy = wy - dragStartPos.value.y;

    if (selectedFurnitureIds.value.length > 1 && multiFurnitureStartMap.value) {
      // 多选拖拽：移动所有选中家具
      for (const [id, startPos] of multiFurnitureStartMap.value) {
        const item = currentFurniture.value.find(f => f.id === id);
        if (item) {
          const newX = startPos.x + dx;
          const newY = startPos.y + dy;
          if (gridSnapEnabled.value) {
            const step = gridSize.value;
            item.x = Math.round(newX / step) * step;
            item.y = Math.round(newY / step) * step;
          } else {
            item.x = newX;
            item.y = newY;
          }
        }
      }
      // A4: 更新预览位置（用最后一个吸附点）
      if (gridSnapEnabled.value && selectedFurniture.value) {
        const item = selectedFurniture.value;
        dragPreviewPos.value = { x: item.x, y: item.y };
      }
    } else {
      // 单选拖拽
      const newX = dragStartFurniturePos.value.x + dx;
      const newY = dragStartFurniturePos.value.y + dy;
      if (gridSnapEnabled.value) {
        const step = gridSize.value;
        selectedFurniture.value.x = Math.round(newX / step) * step;
        selectedFurniture.value.y = Math.round(newY / step) * step;
      } else {
        selectedFurniture.value.x = newX;
        selectedFurniture.value.y = newY;
      }
      // A4: 更新预览位置
      dragPreviewPos.value = { x: selectedFurniture.value.x, y: selectedFurniture.value.y };
    }
    renderer.requestRender();
  }
}

function handleDragEnd(wx, wy, info) {
  // 画形状期间：mousedown 已被 handleDragStart 拦掉（返回 false → panSuppressed），
  // mouseup 仍会走到这里。不挡的话会把"上一次的墙段"之类收尾动作跑掉。
  if (shapeEdit.active) return;
  clearAlignGuides();

  // 墙端点松手：比对拖动前快照，真变了才提交（一条 undo），再重算房间
  if (wallDrag.value) {
    const buildingId = props.buildingNode?.id;
    const floorId = currentFloorId.value;
    const d = wallDrag.value;
    wallDrag.value = null;
    const floor = currentFloor.value;
    const w = floor && (floor.walls || []).find(x => x.id === d.wallId);
    if (w && buildingId && floorId) {
      const moved = (w.start.x !== d.origin.start.x || w.start.y !== d.origin.start.y
        || w.end.x !== d.origin.end.x || w.end.y !== d.origin.end.y);
      if (moved) {
        // A13：本墙 + 真的跟着动了的邻墙，合成**一条** undo
        const patches = [{ wallId: d.wallId, oldSnapshot: d.origin }];
        for (const l of d.links || []) {
          const lw = (floor.walls || []).find((x) => x.id === l.wallId);
          if (!lw) continue;
          const o = l.origin && l.origin[l.end];
          const n = lw[l.end];
          if (!o || !n) continue;
          if (Math.abs(o.x - n.x) > 1e-6 || Math.abs(o.y - n.y) > 1e-6) {
            patches.push({ wallId: l.wallId, oldSnapshot: l.origin });
          }
        }
        if (patches.length > 1 && typeof store.updateWalls === 'function') {
          store.updateWalls(buildingId, floorId, patches);
        } else {
          // 内存里已经是新值 → patch 传空，oldSnapshot 供 undo 还原
          store.updateWall(buildingId, floorId, d.wallId, {}, d.origin);
        }
        recalcRooms();
      }
    }
    renderer.requestRender();
    return;
  }
  if (isDraggingFurniture.value && selectedFurniture.value && info.didPan) {
    if (selectedFurnitureIds.value.length > 1 && multiFurnitureStartMap.value) {
      // 多选拖拽结束：批量更新
      const ids = [...selectedFurnitureIds.value];
      store.beginMultiFurnitureCapture(props.buildingNode.id, currentFloorId.value, ids);
      store.endMultiFurnitureCapture(props.buildingNode.id, currentFloorId.value);
    } else {
      // 单选拖拽结束
      const item = selectedFurniture.value;
      const oldX = dragStartFurniturePos.value.x;
      const oldY = dragStartFurniturePos.value.y;
      if (oldX !== item.x || oldY !== item.y) {
        store.updateFurniture(
          props.buildingNode.id,
          currentFloorId.value,
          item.id,
          { x: item.x, y: item.y },
          { x: oldX, y: oldY }
        );
      }
    }
  }
  // A4: 清理预览状态
  dragPreviewPos.value = null;
  isDraggingFurniture.value = false;
  dragStartPos.value = null;
  dragStartFurniturePos.value = null;
  multiFurnitureStartMap.value = null;
}

function handleCanvasClick(hit, wx, wy) {
  // 家具自绘（2026-11-14）：编辑期间画布点击只用于加点，不做选中/放置
  if (shapeEdit.active) {
    addShapePoint(wx, wy);
    return;
  }

  // 画墙（2026-11-13）：点一下定起点，再点一下成墙，可连续画
  if (interactionMode.value === 'add_wall') {
    handleWallClick(wx, wy);
    return;
  }
  // 门窗：点在墙上放一个
  if (interactionMode.value === 'add_door') {
    placeOpening('door', wx, wy);
    return;
  }
  if (interactionMode.value === 'add_window') {
    placeOpening('window', wx, wy);
    return;
  }

  // R5-1 房间模板：整间一次性放置（一条 undo）
  if (interactionMode.value === 'add_room') {
    const tpl = ROOM_TEMPLATES.find(t => t.id === selectedRoomTemplate.value);
    const floorId = currentFloorId.value;
    if (!tpl || !floorId || !props.buildingNode) return;
    const base = gridSnapEnabled.value ? snapPoint({ x: wx, y: wy }) : { x: wx, y: wy };
    const items = tpl.items.map(it => {
      const size = getDefaultSize(it.type);
      return {
        name: it.name || it.type,
        type: it.type,
        x: Math.round(base.x + (it.dx || 0)),
        y: Math.round(base.y + (it.dy || 0)),
        width: it.w ?? size.w,
        height: it.h ?? size.h,
        rotation: it.rotation || 0,
        templateLabel: tpl.label,
      };
    });
    const created = store.addFurnitureBatch(props.buildingNode.id, floorId, items);
    if (created.length) {
      // 视觉反馈：选中刚放置的整间（撤销一次即整间消失）
      selectedFurnitureIds.value = created.map(c => c.id);
      selectedFurniture.value = created[created.length - 1];
    }
    renderer.requestRender();
    return;
  }

  if (interactionMode.value === 'add_furniture') {
    addFurnitureWorldPos.value = gridSnapEnabled.value ? snapPoint({ x: wx, y: wy }) : { x: wx, y: wy };
    newFurnitureName.value = '';
    newFurnitureType.value = selectedFurnitureType.value;
    // 显式取类型默认尺寸：watch(newFurnitureType) 在类型未变时不触发，此前硬编码 60/40（批次D2）
    const size = getDefaultSize(selectedFurnitureType.value);
    newFurnitureWidth.value = size.w;
    newFurnitureHeight.value = size.h;
    addFurnitureDialogOpen.value = true;
    return;
  }

  if (hit) {
    selectedFurniture.value = hit;
    if (!selectedFurnitureIds.value.includes(hit.id)) {
      selectedFurnitureIds.value = [hit.id];
    }
    // 选中互斥：选家具就放下门窗/墙
    selectedOpening.value = null;
    selectedWallId.value = null;
  } else {
    const op = hitOpening(wx, wy);
    if (op) {
      selectedOpening.value = { kind: op.kind, id: op.id, wallId: op.wallId };
      selectedFurniture.value = null;
      selectedFurnitureIds.value = [];
      selectedWallId.value = null;
      startOpeningEdit(op);
    } else {
      selectedFurniture.value = null;
      selectedFurnitureIds.value = [];
      selectedOpening.value = null;
    }
  }
  renderer.requestRender();
}

function handleBoxSelect(box, shiftKey) {
  // 框选：选中框内所有家具
  const items = currentFurniture.value;
  const inBox = items.filter(item => {
    const cx = item.x + item.width / 2;
    const cy = item.y + item.height / 2;
    return cx >= box.x1 && cx <= box.x2 && cy >= box.y1 && cy <= box.y2;
  });

  if (shiftKey) {
    for (const item of inBox) {
      if (!selectedFurnitureIds.value.includes(item.id)) {
        selectedFurnitureIds.value.push(item.id);
      }
    }
  } else {
    selectedFurnitureIds.value = inBox.map(i => i.id);
  }

  if (inBox.length > 0) {
    selectedFurniture.value = inBox[inBox.length - 1];
  }
  renderer.requestRender();
}

function handleWheel(e) {
  e.preventDefault();
  const delta = e.deltaY > 0 ? -10 : 10;
  const current = renderer.getViewTransform().scale;
  renderer.setScale(Math.max(0.1, Math.min(5, current + delta / 100)));
}

function hitTest(wx, wy) {
  const items = currentFurniture.value;
  // 反向遍历，优先选中后绘制的（视觉上层）
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (wx >= item.x && wx <= item.x + item.width &&
        wy >= item.y && wy <= item.y + item.height) {
      return item;
    }
  }
  return null;
}

function snapPoint(world) {
  const step = gridSize.value;
  return {
    x: Math.round(world.x / step) * step,
    y: Math.round(world.y / step) * step,
  };
}

// ===== 墙的命中与拖拽（2026-11-13）=====
// 容差按**屏幕像素**给（除以 zoom），否则放大后要精确到厘米才能抓住端点。
const WALL_HANDLE_PX = 12;
const wallDrag = ref(null);   // { wallId, end, origin } —— origin 是拖动前的整面墙快照

/** 点到墙端点（返回 {wall, end}） */
function hitWallHandle(wx, wy) {
  const floor = currentFloor.value;
  if (!floor) return null;
  const cs = renderer.getViewTransform().scale || 1;
  const tol = WALL_HANDLE_PX / cs;
  let best = null;
  let bestD = Infinity;
  for (const w of floor.walls || []) {
    for (const end of ['start', 'end']) {
      const p = w[end];
      if (!p) continue;
      const d = Math.hypot(p.x - wx, p.y - wy);
      if (d <= tol && d < bestD) { bestD = d; best = { wall: w, end }; }
    }
  }
  return best;
}

/**
 * 找与 `wall[end]` 这个端点重合的其它墙（台账 A13）。
 * 判据就是坐标重合（容差 0.6cm，网格吸附后基本是整数）；同一条墙只认一次。
 */
function linkedWallsAt(wall, end) {
  const floor = currentFloor.value;
  const pt = wall && wall[end];
  if (!floor || !pt) return [];
  const out = [];
  for (const w of (floor.walls || [])) {
    if (w.id === wall.id) continue;
    let hitEnd = null;
    for (const e of ['start', 'end']) {
      const p = w[e];
      if (p && Math.hypot((p.x || 0) - (pt.x || 0), (p.y || 0) - (pt.y || 0)) <= 0.6) { hitEnd = e; break; }
    }
    if (hitEnd) out.push({ wallId: w.id, end: hitEnd, origin: JSON.parse(JSON.stringify(w)) });
  }
  return out;
}

/** 点到墙身（返回命中的墙） */function hitWallBody(wx, wy) {
  const floor = currentFloor.value;
  if (!floor) return null;
  const cs = renderer.getViewTransform().scale || 1;
  const extra = 4 / cs;
  for (const w of (floor.walls || []).slice().reverse()) {
    const ax = w.start.x, ay = w.start.y, bx = w.end.x, by = w.end.y;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-6) continue;
    let t = ((wx - ax) * dx + (wy - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx, py = ay + t * dy;
    const d = Math.hypot(wx - px, wy - py);
    if (d <= (Number(w.thickness) || 12) / 2 + extra) return w;
  }
  return null;
}

/**
 * 点到门窗（台账 A11）。判据：投影到墙中心线的距离 < 半墙厚 + 容差，
 * 且沿墙方向落在 [洞口中心 ± 洞口宽/2] 内。返回 { kind, id, wallId, opening }。
 */
function hitOpening(wx, wy) {
  const floor = currentFloor.value;
  if (!floor) return null;
  const cs = renderer.getViewTransform().scale || 1;
  const extra = 3 / cs;
  const walls = floor.walls || [];
  for (const kind of ['doors', 'windows']) {
    for (const o of [...(floor[kind] || [])].reverse()) {
      const wall = walls.find((w) => w.id === o.wallId);
      if (!wall) continue;
      const ax = wall.start.x, ay = wall.start.y;
      const dx = wall.end.x - ax, dy = wall.end.y - ay;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < 1e-6) continue;
      const t = Math.max(0, Math.min(1, Number(o.position) || 0.5));
      const px = ax + t * dx, py = ay + t * dy;
      const len = Math.sqrt(lenSq);
      // 法向距离
      const dist = Math.abs((wx - px) * (-dy / len) + (wy - py) * (dx / len));
      // 沿墙方向偏移
      const along = Math.abs((wx - px) * (dx / len) + (wy - py) * (dy / len));
      const half = (Number(o.width) || 90) / 2;
      if (dist <= (Number(wall.thickness) || 12) / 2 + extra && along <= half + extra) {
        return { kind, id: o.id, wallId: o.wallId, opening: o, wall };
      }
    }
  }
  return null;
}

// ===== 家具自绘（2026-11-14）=====
// 用户在画布上依次点出轮廓 → 双击 / Enter 闭合 → 存进 item.custom（归一化坐标，换尺寸不用重画）。
// 渲染侧早就有契约（furnitureSymbols 的 drawCustomShape），这里补的是"画"的入口。
function startShapeEdit() {
  const item = selectedFurniture.value;
  if (!item) return;
  if (store.isReadOnly) {
    setExportMsg(store.readOnlyReason || '当前为只读状态', true);
    return;
  }
  // 已经画过的形状**预填**：进来就是继续改，而不是从零重画
  const pre = customToWorldPoints(item.custom, item);
  shapeEdit.active = true;
  shapeEdit.furnitureId = item.id;
  shapeEdit.points = pre;
  shapeEdit.cursor = null;
  shapeEdit.smooth = !!(item.custom && item.custom.smooth);
  selectedOpening.value = null;
  selectedWallId.value = null;
  setExportMsg('');
  renderer.requestRender();
}

function addShapePoint(wx, wy) {
  if (!shapeEdit.active) return;
  const pts = shapeEdit.points;
  const last = pts[pts.length - 1];
  // 去重：双击会在同一处连发两次 click；手抖也会点重。5cm 内视作同一点。
  if (last && Math.hypot(last.x - wx, last.y - wy) < 5) return;
  // 点回起点附近 → 直接闭合（3 点以上才允许，免得两下就"闭合"成一条线）
  const first = pts[0];
  if (pts.length >= 3 && first && Math.hypot(first.x - wx, first.y - wy) < 8) {
    finishShapeEdit();
    return;
  }
  pts.push({ x: wx, y: wy });
  renderer.requestRender();
}

function undoShapePoint() {
  if (!shapeEdit.active || !shapeEdit.points.length) return;
  shapeEdit.points.pop();
  renderer.requestRender();
}

function cancelShapeEdit() {
  shapeEdit.active = false;
  shapeEdit.furnitureId = null;
  shapeEdit.points = [];
  shapeEdit.cursor = null;
  shapeEdit.smooth = false;
  renderer.requestRender();
}

/**
 * 闭合保存。少于 3 点不写（不构成面）；写的时候把"形状撑大了包围框"一起带上（同一条 undo）。
 */
function finishShapeEdit() {
  const item = shapeItem.value;
  if (!shapeEdit.active || !item) return false;
  if (shapeEdit.points.length < 3) {
    setExportMsg('至少要 3 个点才能围出一块形状', true);
    return false;
  }
  const built = worldPointsToCustom(shapeEdit.points, item);
  if (!built) {
    setExportMsg('形状数据无效（点太少或家具尺寸为 0）', true);
    return false;
  }
  const grew = Math.abs(built.extent.width - item.width) > 1e-6
    || Math.abs(built.extent.height - item.height) > 1e-6
    || Math.abs(built.extent.x - item.x) > 1e-6
    || Math.abs(built.extent.y - item.y) > 1e-6;
  const ok = store.setFurnitureShape(
    props.buildingNode.id,
    currentFloorId.value,
    item.id,
    { points: built.points, closed: built.closed, fill: built.fill, smooth: shapeEdit.smooth },
    grew ? built.extent : null,
  );
  if (!ok) {
    setExportMsg('保存形状失败（只读或数据无效）', true);
    return false;
  }
  shapeEdit.active = false;
  shapeEdit.furnitureId = null;
  shapeEdit.points = [];
  shapeEdit.cursor = null;
  shapeEdit.smooth = false;
  setExportMsg(grew ? '已保存自定义形状（包围框随之调整）' : '已保存自定义形状');
  renderer.requestRender();
  return true;
}

/** 恢复内置符号（删掉 custom） */
function clearFurnitureShape() {
  const item = selectedFurniture.value || shapeItem.value;
  if (!item) return;
  store.setFurnitureShape(props.buildingNode.id, currentFloorId.value, item.id, null, null);
  renderer.requestRender();
}

/**
 * 画墙草稿预览（A26）：起点 → 光标位置的虚线 + 长度。
 * 以前没有预览：点第一下落点，移动什么都没发生，点第二下才知道墙画在哪。
 */
function drawWallDraftPreview(ctx) {
  const start = wallDraftStart.value;
  if (!start || interactionMode.value !== 'add_wall') return;
  const cursor = pointerWorld.value;
  if (!cursor) return;
  const z = renderer.getViewTransform().scale || 1;
  const p = resolvePlacement(cursor.x, cursor.y, { from: start }).xy;
  const len = Math.hypot(p.x - start.x, p.y - start.y);

  ctx.save();
  ctx.strokeStyle = 'rgba(80, 150, 220, 0.85)';
  // 线宽跟真实墙厚走（预览就是"画出来会有多粗"），但至少 2px 屏幕可见
  ctx.lineWidth = Math.max(wallThickness.value, 2 / z);
  ctx.setLineDash([10 / z, 6 / z]);
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(p.x, p.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // 起点 / 落点小方块
  const s2 = 5 / z;
  ctx.fillStyle = '#2f6f95';
  ctx.fillRect(start.x - s2, start.y - s2, s2 * 2, s2 * 2);
  ctx.fillStyle = 'rgba(80, 150, 220, 0.95)';
  ctx.fillRect(p.x - s2, p.y - s2, s2 * 2, s2 * 2);

  // 长度：白底垫字（墙上可能有涂黑，直接写字看不见）
  const label = formatLength(len);
  ctx.font = canvasFont(11 / z);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(label).width;
  const mx = (start.x + p.x) / 2;
  const my = (start.y + p.y) / 2;
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillRect(mx - tw / 2 - 4 / z, my - 8 / z, tw + 8 / z, 16 / z);
  ctx.fillStyle = '#2f6f95';
  ctx.fillText(label, mx, my);
  ctx.restore();
}

/**
 * 对齐参考线（A26）：贯穿视口的洋红虚线 + 吸附点方框。
 *
 * 为什么画贯穿全屏而不是一小段：对齐的意义是"和远处那面墙在同一条线上"，
 * 只画一小段看不出来对齐到哪了。
 */
function drawAlignGuides(ctx) {
  const g = alignGuides.value;
  if (g.x === null && g.y === null && !alignSnapPoint.value) return;
  const vt = renderer.getViewTransform();
  const cs = vt.scale || 1;
  const cvs = canvas.value;
  if (!cvs) return;
  const left = -(cvs.clientWidth / 2 + vt.x) / cs;
  const top = -(cvs.clientHeight / 2 + vt.y) / cs;
  const right = (cvs.clientWidth / 2 - vt.x) / cs;
  const bottom = (cvs.clientHeight / 2 - vt.y) / cs;

  ctx.save();
  ctx.strokeStyle = 'rgba(255, 45, 120, 0.9)';
  ctx.lineWidth = 1 / cs;
  ctx.setLineDash([5 / cs, 5 / cs]);
  if (g.x !== null) {
    ctx.beginPath();
    ctx.moveTo(g.x, top);
    ctx.lineTo(g.x, bottom);
    ctx.stroke();
  }
  if (g.y !== null) {
    ctx.beginPath();
    ctx.moveTo(left, g.y);
    ctx.lineTo(right, g.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // 吸附点：小方框（告诉用户"贴到了这个墙角"）
  const sp = alignSnapPoint.value;
  if (sp) {
    const r = 6 / cs;
    ctx.strokeStyle = '#ff2d78';
    ctx.lineWidth = 2 / cs;
    ctx.strokeRect(sp.x - r, sp.y - r, r * 2, r * 2);
  }
  ctx.restore();
}

/** 命中自绘的顶点（屏幕 12px 内），返回下标；没命中返回 -1 */
function hitShapeVertex(wx, wy) {
  const z = renderer.getViewTransform().scale || 1;
  const tol = 12 / z;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < shapeEdit.points.length; i++) {
    const p = shapeEdit.points[i];
    const d = Math.hypot(p.x - wx, p.y - wy);
    if (d < bestD && d <= tol) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// ===== 形状模板（2026-11-15）=====
// 存**本机**（localStorage），不进项目文件：模板是"我的习惯"，不是这栋楼的设定；
// 塞进 .sitian 会让项目文件背上跨项目的私货，还得为了它改 schema。
const SHAPE_TPL_KEY = 'sitian:interior-shape-templates';

function loadShapeTemplates() {
  try {
    const raw = localStorage.getItem(SHAPE_TPL_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    return arr.filter((t) => t && t.custom && Array.isArray(t.custom.points) && t.custom.points.length >= 3);
  } catch (e) {
    return [];
  }
}

function persistShapeTemplates(list) {
  try {
    localStorage.setItem(SHAPE_TPL_KEY, JSON.stringify(list));
  } catch (e) {
    setExportMsg('形状模板保存失败（本机存储不可用）', true);
  }
}

const shapeTemplates = ref(loadShapeTemplates());
const pickedTemplateId = ref('');

async function saveAsShapeTemplate() {
  const item = selectedFurniture.value;
  if (!item || !item.custom) return;
  const name = await promptDialog.askText({ title: '形状模板名称', defaultValue: item.name || '我的形状' });
  const trimmed = String(name || '').trim();
  if (!trimmed) return;
  const tpl = {
    id: `tpl_${Date.now()}`,
    name: trimmed,
    width: item.width,
    height: item.height,
    custom: JSON.parse(JSON.stringify(item.custom)),
  };
  const next = [tpl, ...shapeTemplates.value.filter((t) => t.name !== trimmed)].slice(0, 24);
  shapeTemplates.value = next;
  persistShapeTemplates(next);
  pickedTemplateId.value = tpl.id;
  setExportMsg(`已存为形状模板：${trimmed}`);
}

function applyShapeTemplate() {
  const tpl = shapeTemplates.value.find((t) => t.id === pickedTemplateId.value);
  const item = selectedFurniture.value;
  if (!tpl || !item || !currentFloorId.value) return;
  // 中心不动：套模板时家具不"跳"，只是换个形状与尺寸
  const cx = item.x + item.width / 2;
  const cy = item.y + item.height / 2;
  const ok = store.setFurnitureShape(
    props.buildingNode.id, currentFloorId.value, item.id,
    { ...tpl.custom },
    { x: cx - tpl.width / 2, y: cy - tpl.height / 2, width: tpl.width, height: tpl.height },
  );
  if (!ok) setExportMsg('套用模板失败（只读或数据无效）', true);
  else setExportMsg(`已套用模板：${tpl.name}`);
  renderer.requestRender();
}

function removeShapeTemplate() {
  if (!pickedTemplateId.value) return;
  const next = shapeTemplates.value.filter((t) => t.id !== pickedTemplateId.value);
  shapeTemplates.value = next;
  persistShapeTemplates(next);
  pickedTemplateId.value = '';
}

function drawShapeEditPreview(ctx) {
  if (!shapeEdit.active) return;
  const item = shapeItem.value;
  const z = renderer.getViewTransform().scale || 1;
  const pts = shapeEdit.points;
  ctx.save();

  // 家具包围框（虚线）：让用户知道"画到框外会自动撑大框"
  if (item) {
    ctx.strokeStyle = 'rgba(255, 179, 0, 0.75)';
    ctx.lineWidth = 1.5 / z;
    ctx.setLineDash([8 / z, 6 / z]);
    ctx.strokeRect(item.x, item.y, item.width, item.height);
    ctx.setLineDash([]);
  }

  if (pts.length) {
    ctx.beginPath();
    if (shapeEdit.smooth && pts.length >= 3) {
      // 平滑预览：与最终渲染同一套"中点二次贝塞尔"，否则用户看不到自己选了什么
      const at = (i) => pts[((i % pts.length) + pts.length) % pts.length];
      const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      const f0 = mid(at(0), at(1));
      ctx.moveTo(f0.x, f0.y);
      for (let i = 1; i <= pts.length; i++) {
        const c = at(i);
        const m = mid(at(i), at(i + 1));
        ctx.quadraticCurveTo(c.x, c.y, m.x, m.y);
      }
      ctx.closePath();
    } else {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      // 实时闭合预览：>=3 点时把最后一点连回起点
      if (pts.length >= 3) ctx.lineTo(pts[0].x, pts[0].y);
    }
    ctx.strokeStyle = 'rgba(255, 152, 0, 0.95)';
    ctx.lineWidth = 2 / z;
    ctx.stroke();

    // 半透明填充预览：一眼看出"将是这块面"
    if (pts.length >= 3) {
      ctx.fillStyle = 'rgba(255, 179, 0, 0.16)';
      ctx.fill();
    }

    // 顶点
    for (let i = 0; i < pts.length; i++) {
      ctx.beginPath();
      ctx.arc(pts[i].x, pts[i].y, 4 / z, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? '#ff6d00' : '#fff';
      ctx.fill();
      ctx.strokeStyle = '#ff6d00';
      ctx.lineWidth = 1.5 / z;
      ctx.stroke();
    }

    // 橡皮筋：最后一点 → 光标
    if (shapeEdit.cursor) {
      ctx.beginPath();
      ctx.moveTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      ctx.lineTo(shapeEdit.cursor.x, shapeEdit.cursor.y);
      ctx.strokeStyle = 'rgba(255, 152, 0, 0.55)';
      ctx.lineWidth = 1.5 / z;
      ctx.setLineDash([6 / z, 5 / z]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  } else if (shapeEdit.cursor) {
    // 还没点第一个点：给一个跟随光标的小十字，确认"正在画"
    ctx.strokeStyle = 'rgba(255, 152, 0, 0.6)';
    ctx.lineWidth = 1.5 / z;
    const r = 6 / z;
    ctx.beginPath();
    ctx.moveTo(shapeEdit.cursor.x - r, shapeEdit.cursor.y);
    ctx.lineTo(shapeEdit.cursor.x + r, shapeEdit.cursor.y);
    ctx.moveTo(shapeEdit.cursor.x, shapeEdit.cursor.y - r);
    ctx.lineTo(shapeEdit.cursor.x, shapeEdit.cursor.y + r);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * 点中的是哪一间房（台账 A28）。判据：点在房间多边形内（边界算命中）。
 * 倒序遍历：后画的房间在上面。
 */
function hitRoom(wx, wy) {
  const floor = currentFloor.value;
  if (!floor) return null;
  const walls = floor.walls || [];
  const rooms = floor.rooms || [];
  for (let i = rooms.length - 1; i >= 0; i--) {
    const r = rooms[i];
    const poly = getRoomPolygon(r, walls);
    if (poly && poly.length >= 3 && pointInPolygon({ x: wx, y: wy }, poly)) return r;
  }
  return null;
}

/** 双击房间 → 改名（A28）。房间名字是唯一"人给"的字段，其余都由墙推出来。 */
async function handleCanvasDblClick(hit, wx, wy) {
  // 家具自绘：双击 = 闭合保存（第一击已由 onClick 加点，双击的第二次 click 被 5cm 去重挡掉）
  if (shapeEdit.active) {
    finishShapeEdit();
    return;
  }
  if (store.isReadOnly) {
    setExportMsg(store.readOnlyReason || '当前为只读状态', true);
    return;
  }
  const room = hitRoom(wx, wy);
  if (!room) return;
  const buildingId = props.buildingNode?.id;
  const floorId = currentFloorId.value;
  if (!buildingId || !floorId) return;
  const next = await promptDialog.askText({ title: '房间名称', defaultValue: room.name || '' });
  if (next === null || next === undefined) return;   // 取消
  store.renameRoom(buildingId, floorId, room.id, String(next).trim());
  renderer.requestRender();
}

/** 选中门窗到墙两端的距离（cm，A25）。墙不存在/长度 0 时返回空串。 */
const openingEnds = computed(() => {
  const sel = selectedOpening.value;
  const floor = currentFloor.value;
  if (!sel || !floor) return '';
  const wall = (floor.walls || []).find((w) => w.id === sel.wallId);
  if (!wall) return '';
  const len = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  if (!(len > 0)) return '';
  const pos = Math.min(0.95, Math.max(0.05, Number(openingForm.position) || 0.5));
  const half = Math.max(0, Number(openingForm.width) || 0) / 2;
  const a = Math.max(0, pos * len - half);
  const b = Math.max(0, len - pos * len - half);
  return `${formatLength(a)} / ${formatLength(b)}`;
});

/** 选中一个门窗 → 打开改尺寸浮窗（A11：以前只有"放"，没有"改"） */
function startOpeningEdit(op) {
  const o = op.opening || {};
  // 选中状态在这里一并落定：调用方（点选、用例）只传 op 就够了，
  // 少一处依赖就少一处"忘了设 selectedOpening → 浮窗里距墙端是空的"。
  selectedOpening.value = { kind: op.kind, id: op.id, wallId: op.wallId };
  openingForm.kind = op.kind;
  openingForm.width = Number(o.width) || (op.kind === 'doors' ? 90 : 120);
  openingForm.height = Number(o.height) || (op.kind === 'doors' ? 200 : 140);
  openingForm.sillHeight = Number(o.sillHeight) || 90;
  openingForm.position = Number(o.position) || 0.5;
  editingOpening.value = true;
}

function cancelOpeningEdit() {
  editingOpening.value = false;
  selectedOpening.value = null;
  renderer.requestRender();
}

function saveOpeningEdit() {
  if (!selectedOpening.value || !currentFloorId.value) return;
  const bid = props.buildingNode.id;
  const fid = currentFloorId.value;
  const { kind, id } = selectedOpening.value;
  const patch = {
    width: Math.max(20, Number(openingForm.width) || 90),
    height: Math.max(20, Number(openingForm.height) || 200),
    position: Math.min(0.95, Math.max(0.05, Number(openingForm.position) || 0.5)),
  };
  if (kind === 'windows') patch.sillHeight = Math.max(0, Number(openingForm.sillHeight) || 0);
  // 写口自带 guardWrite + 一条 undo（改坏了按一次撤销就回来）
  if (kind === 'doors') store.updateDoor(bid, fid, id, patch);
  else store.updateWindow(bid, fid, id, patch);
  editingOpening.value = false;
  renderer.requestRender();
}

/** 点在墙上时，返回沿墙的参数 t（0..1），用于给门窗定位 */
function wallParamAt(w, wx, wy) {
  const dx = w.end.x - w.start.x;
  const dy = w.end.y - w.start.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) return 0.5;
  const t = ((wx - w.start.x) * dx + (wy - w.start.y) * dy) / lenSq;
  // 两端各留 5%，否则门窗会挂在墙角上，墙体被切得只剩拐角
  return Math.max(0.05, Math.min(0.95, t));
}

/** 在点中的墙上放一个门/窗（2026-11-13，写口已有） */
function placeOpening(kind, wx, wy) {
  const buildingId = props.buildingNode?.id;
  const floorId = currentFloorId.value;
  if (!buildingId || !floorId) return;
  const w = hitWallBody(wx, wy);
  if (!w) {
    // 没有 toast 体系：这里走 console + 不留状态，避免"点了没反应又不知道为什么"
    console.warn('[内部地图] 请点在墙上 —— 门窗只能挂在墙里');
    return;
  }
  const position = wallParamAt(w, wx, wy);
  if (kind === 'door') {
    store.addDoor(buildingId, floorId, { wallId: w.id, position, width: 90 });
  } else {
    store.addWindow(buildingId, floorId, { wallId: w.id, position, width: 120, sillHeight: 90 });
  }
  renderer.requestRender();
}

// ===== R5-3 跨楼层复制 / 移动 =====
const canTransfer = computed(() =>
  !!transferTargetFloorId.value
  && transferTargetFloorId.value !== currentFloorId.value
  && selectedFurnitureIds.value.length > 0
);

function openTransferDialog() {
  if (!selectedFurnitureIds.value.length) return;
  const others = floors.value.filter(f => f.id !== currentFloorId.value);
  if (!others.length) return;
  transferTargetFloorId.value = others[0].id;
  transferMode.value = 'copy';
  transferDialogOpen.value = true;
}

function confirmTransfer() {
  if (!canTransfer.value || !props.buildingNode) return;
  const ids = [...selectedFurnitureIds.value];
  const created = store.transferFurnitureBatch(
    props.buildingNode.id, currentFloorId.value, transferTargetFloorId.value, ids, transferMode.value,
  );
  transferDialogOpen.value = false;
  if (transferMode.value === 'move') {
    // 家具已离开当前层：清空选中，避免面板指向不存在的对象
    selectedFurnitureIds.value = [];
    selectedFurniture.value = null;
  } else {
    selectedFurnitureIds.value = created.map(c => c.id);
    selectedFurniture.value = created[created.length - 1] || null;
  }
  renderer.requestRender();
}

function confirmAddFurniture() {
  // 批次D2：此前空名称/楼层失效时静默 return（用户点了"放置"毫无反馈）
  if (!props.buildingNode) return;
  // 楼层缺失或指向旧建筑（建筑切换器换楼后 currentFloorId 过期）→ 自动补建一楼
  if (!currentFloorId.value || !floors.value.some(f => f.id === currentFloorId.value)) {
    const newFloor = store.addFloor(props.buildingNode.id, '一楼');
    currentFloorId.value = newFloor.id;
  }

  const pos = addFurnitureWorldPos.value;
  const typeMeta = FURNITURE_TYPES.find(t => t.type === newFurnitureType.value);
  const item = store.addFurniture(
    props.buildingNode.id,
    currentFloorId.value,
    {
      name: newFurnitureName.value.trim() || `新${typeMeta?.label || '家具'}`,
      type: newFurnitureType.value,
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      width: newFurnitureWidth.value,
      height: newFurnitureHeight.value,
    }
  );
  if (!item) {
    console.warn('[InteriorView] 家具放置失败：目标楼层不存在', props.buildingNode.id, currentFloorId.value);
    return;
  }
  addFurnitureDialogOpen.value = false;
  renderer.requestRender();
}

function deleteSelected() {
  // 选中门窗 → 只删这一个洞（2026-11-14 台账 A11：以前放进去删不掉）
  if (selectedOpening.value && currentFloorId.value) {
    const bid = props.buildingNode.id;
    const fid = currentFloorId.value;
    const { kind, id } = selectedOpening.value;
    if (kind === 'doors') store.removeDoor(bid, fid, id);
    else store.removeWindow(bid, fid, id);
    selectedOpening.value = null;
    editingOpening.value = false;
    renderer.requestRender();
    return;
  }
  // 选中墙 → 删墙（连带挂在上面的门窗，数据层已处理）
  if (selectedWallId.value && currentFloorId.value) {
    store.removeWall(props.buildingNode.id, currentFloorId.value, selectedWallId.value);
    selectedWallId.value = null;
    recalcRooms();
    renderer.requestRender();
    return;
  }
  if (!selectedFurniture.value || !currentFloorId.value) return;
  if (!confirm(`确定删除“${selectedFurniture.value.name}”？`)) return;
  store.removeFurniture(props.buildingNode.id, currentFloorId.value, selectedFurniture.value.id);
  selectedFurniture.value = null;
  renderer.requestRender();
}

function rotateSelected() {
  if (!selectedFurniture.value || !currentFloorId.value) return;
  const item = selectedFurniture.value;
  const oldRotation = item.rotation || 0;
  const newRotation = (oldRotation + 90) % 360;
  store.updateFurniture(
    props.buildingNode.id,
    currentFloorId.value,
    item.id,
    { rotation: newRotation },
    { rotation: oldRotation }
  );
  renderer.requestRender();
}

// ===== 家具详情浮窗编辑 =====
function startEditPopover() {
  if (!selectedFurniture.value) return;
  const item = selectedFurniture.value;
  editForm.name = item.name;
  editForm.type = item.type;
  editForm.width = item.width;
  editForm.height = item.height;
  editForm.rotation = item.rotation || 0;
  editingPopover.value = true;
}

function cancelEditPopover() {
  editingPopover.value = false;
  selectedFurniture.value = null;
}

function saveEditPopover() {
  if (!selectedFurniture.value || !currentFloorId.value) return;
  const item = selectedFurniture.value;
  const updates = {};
  const oldSnapshot = {};

  if (editForm.name !== item.name) {
    updates.name = editForm.name;
    oldSnapshot.name = item.name;
  }
  if (editForm.type !== item.type) {
    updates.type = editForm.type;
    oldSnapshot.type = item.type;
  }
  if (editForm.width !== item.width) {
    updates.width = editForm.width;
    oldSnapshot.width = item.width;
  }
  if (editForm.height !== item.height) {
    updates.height = editForm.height;
    oldSnapshot.height = item.height;
  }
  if (editForm.rotation !== (item.rotation || 0)) {
    updates.rotation = editForm.rotation;
    oldSnapshot.rotation = item.rotation || 0;
  }

  if (Object.keys(updates).length > 0) {
    store.updateFurniture(
      props.buildingNode.id,
      currentFloorId.value,
      item.id,
      updates,
      oldSnapshot
    );
  }
  editingPopover.value = false;
  renderer.requestRender();
}

function undo() {
  store.undo();
  renderer.requestRender();
}

function redo() {
  store.redo();
  renderer.requestRender();
}

// ===== 编辑模式 =====
function enterEditMode() {
  // 只读态（无项目）：内存编辑同样被拦 —— 改了不落盘 = 静默丢数据（拒绝理由由全局提示条给出）
  if (!guardWrite('进入编辑模式').ok) return;
  editMode.value = true;
  interactionMode.value = 'pan';
}
// 模态输入（批次D1）：楼层重命名等，替代 Electron 不支持的 window.prompt
const promptDialog = usePromptDialog();

function exitEditMode() {
  editMode.value = false;
  // 批次D2：退出编辑时重置工具，否则浏览态点击画布仍会触发放置对话框
  interactionMode.value = 'pan';
  selectedFurniture.value = null;
  selectedFurnitureIds.value = [];
  addFurnitureDialogOpen.value = false;
}

// ===== 面包屑与视图边界 =====
/**
 * 本层内容的外接框（**墙 + 家具**，cm）。
 *
 * 🔴 2026-11-14：原来只看家具 —— 只画了墙还没摆家具的楼层，边界退化成默认 ±500，
 * 而房子可能是 900×650 且从 (0,0) 起画 → 一进建筑内部，房子在**屏幕右下角露出四分之一**
 * （用户原话："做出来的东西根本不值得看"）。现在墙端点（±半墙厚）也算进来。
 */
function floorContentBounds(floor) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eat = (x0, y0, x1, y1) => {
    minX = Math.min(minX, x0, x1); maxX = Math.max(maxX, x0, x1);
    minY = Math.min(minY, y0, y1); maxY = Math.max(maxY, y0, y1);
  };
  for (const w of (floor && floor.walls) || []) {
    const t = (Number(w.thickness) || 12) / 2;
    const ax = Number(w.start?.x) || 0, ay = Number(w.start?.y) || 0;
    const bx = Number(w.end?.x) || 0, by = Number(w.end?.y) || 0;
    eat(ax - t, ay - t, bx + t, by + t);
  }
  for (const f of (floor && floor.furniture) || []) {
    eat(Number(f.x) || 0, Number(f.y) || 0, (Number(f.x) || 0) + (Number(f.width) || 0), (Number(f.y) || 0) + (Number(f.height) || 0));
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

const viewBounds = computed(() => {
  const b = floorContentBounds(currentFloor.value);
  if (!b) return { minX: -500, minY: -500, maxX: 500, maxY: 500 };
  const padding = 100;
  return {
    minX: b.minX - padding,
    minY: b.minY - padding,
    maxX: b.maxX + padding,
    maxY: b.maxY + padding,
  };
});

const worldBounds = computed(() => viewBounds.value);

// P0-4：视口边界（镜头当前看到的世界矩形）≠ 内容边界
const viewportBounds = computed(() => computeViewBounds(renderer, canvas.value, viewBounds.value));

const eyeElements = computed(() => {
  return currentFurniture.value.map(f => ({
    type: 'circle',
    x: f.x + f.width / 2,
    y: f.y + f.height / 2,
    r: Math.max(3, Math.min(9, Math.max(f.width, f.height) / 2)),
    color: '#8B7355',
  }));
});

function handleEagleEyeNavigate(world) {
  renderer.focusOn(world.x, world.y, renderer.getViewTransform().scale);
}

/**
 * 把当前楼层铺满视口（进入视图 / 切层 / 切建筑时调用）。
 * 用户自己平移缩放之后**不再打扰**（只在上述三个时机调）。
 */
function fitToFloor(padding = 0.86) {
  const el = canvas.value;
  if (!el || !el.clientWidth || !el.clientHeight) return;
  const b = floorContentBounds(currentFloor.value);
  if (!b) {
    renderer.focusOn(0, 0, 1);
    return;
  }
  const w = Math.max(100, b.maxX - b.minX);
  const h = Math.max(100, b.maxY - b.minY);
  const zoom = fitZoom({ w, h }, { w: el.clientWidth, h: el.clientHeight }, padding);
  // 夹一层：沙发那么小的内容别放到 40px/cm（会糊），宫殿别缩到 0.001（看不见线）
  const z = Math.min(6, Math.max(0.01, zoom));
  renderer.focusOn((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, z);
}

// ===== 生命周期 =====
// E2: 撤销历史跳转后重绘画布（历史面板广播）
function onHistoryJump() {
  renderer.requestRender();
}

onMounted(() => {
  renderer.initCanvas();
  // 墙的写口在 undo/redo 之后回调这里重算房间（rooms 是派生数据，不单独入 undo 栈 ——
  // 否则画一面墙要按两次撤销）。只认当前建筑 + 当前层。
  store.setFloorChangeHook((buildingId, floorId) => {
    if (buildingId !== props.buildingNode?.id) return;
    if (floorId !== currentFloorId.value) return;
    recalcRooms();
    renderer.requestRender();
  });
  window.addEventListener('keydown', handleKeydown);
  window.addEventListener('keyup', handleKeyup);
  window.addEventListener('sitian:history-jump', onHistoryJump);
  window.addEventListener('sitian:label-styles-changed', onHistoryJump); // P0-2 标签样式
  window.addEventListener('sitian:marker-types-changed', onHistoryJump);  // P1-4 标记类型

  // 初始取景：等画布尺寸就绪（同一帧里 clientWidth 可能是 0）
  requestAnimationFrame(() => fitToFloor());

  // 初始化：如果没有楼层则创建一个
  if (props.buildingNode && floors.value.length === 0) {
    const newFloor = store.addFloor(props.buildingNode.id, '一楼');
    currentFloorId.value = newFloor.id;
  } else if (floors.value.length > 0) {
    currentFloorId.value = floors.value[0].id;
  }
});

// 建筑切换器换建筑时 viewLevel 不变、组件不重挂（批次D2）：
// 此前 currentFloorId 仍指向旧建筑楼层 → addFurniture 找不到楼层静默丢弃，家具放置"无效"
watch(() => props.buildingNode?.id, (newId, oldId) => {
  if (!newId || newId === oldId) return;
  selectedFurniture.value = null;
  selectedFurnitureIds.value = [];
  editingPopover.value = false;
  if (floors.value.length === 0) {
    const newFloor = store.addFloor(newId, '一楼');
    currentFloorId.value = newFloor.id;
  } else {
    currentFloorId.value = floors.value[0]?.id || null;
  }
  fitToFloor();
  renderer.requestRender();
});

onUnmounted(() => {
  renderer.cleanupCanvas();
  // 卸载时必须摘掉回调：否则切到别的建筑后，旧组件还在替新楼层重算房间
  store.setFloorChangeHook(null);
  window.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('keyup', handleKeyup);
  window.removeEventListener('sitian:history-jump', onHistoryJump);
  window.removeEventListener('sitian:label-styles-changed', onHistoryJump);
  window.removeEventListener('sitian:marker-types-changed', onHistoryJump);
});

/**
 * 执行一条快捷键。返回 true 表示"已处理，别再往下走"。
 *
 * 注意几个 `return false`：条件不满足时（比如只读态下不许改数据）**不吞键**，
 * 让后面的分支继续跑（例如 Esc 还能关别的东西）。
 */
function runShortcut(id) {
  if (!id) return false;
  if (id === 'help') {
    shortcutsHelpOpen.value = !shortcutsHelpOpen.value;
    return true;
  }
  if (shortcutsHelpOpen.value && id !== 'help') {
    // 帮助开着时，其它键只用来关它（否则用户按 1 会突然切工具，帮助还盖在上面）
    shortcutsHelpOpen.value = false;
    return true;
  }
  if (id === 'undo') {
    if (store.isReadOnly) { setExportMsg(store.readOnlyReason || '当前为只读状态', true); return true; }
    store.undo();
    renderer.requestRender();
    return true;
  }
  if (id === 'redo') {
    if (store.isReadOnly) { setExportMsg(store.readOnlyReason || '当前为只读状态', true); return true; }
    store.redo();
    renderer.requestRender();
    return true;
  }
  if (id.startsWith('tool:')) {
    if (!editMode.value) return false;    // 浏览态不切工具（那里没有工具栏，切了用户也看不见）
    interactionMode.value = id.slice(5);
    wallDraftStart.value = null;
    clearAlignGuides();
    renderer.requestRender();
    return true;
  }
  if (id === 'view:fit') {
    fitToFloor();
    renderer.requestRender();
    return true;
  }
  if (id === 'view:grid') {
    gridSnapEnabled.value = !gridSnapEnabled.value;
    renderer.requestRender();
    return true;
  }
  if (id === 'view:dims') {
    showDimensions.value = !showDimensions.value;
    renderer.requestRender();
    return true;
  }
  return false;
}

function handleKeyup(e) {
  if (e.key === 'Shift') {
    shiftDown.value = false;
    // 松开 Shift 后参考线可能已经不对了，交给下一次 move 重算；这里只重画一帧
    renderer.requestRender();
  }
}

function handleKeydown(e) {
  // Shift = 正交（画墙 / 拖墙角）。用 keydown 而不是读事件的 e.shiftKey：
  // 画布点击回调只给坐标，拿不到修饰键（lib 的 onClick 签名就是 hit/wx/wy）。
  if (e.key === 'Shift') shiftDown.value = true;

  const tag = document.activeElement?.tagName;
  const isEditingInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  // Esc：先关外观浮层（它压在最上面），再处理画墙收尾
  // 家具自绘（2026-11-14）：Enter 闭合、Esc 取消、Backspace 撤一点
  // 必须在最前 —— 否则 Backspace 会走到别的分支、Delete 会把家具删掉
  if (shapeEdit.active && !isEditingInput) {
    if (e.key === 'Enter') {
      e.preventDefault();
      finishShapeEdit();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelShapeEdit();
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      undoShapePoint();
      return;
    }
    return;   // 自绘期间吞掉其它快捷键（R 旋转、方向键微调都不该在画形状时生效）
  }

  // ===== 快捷键表分发（A27）=====
  // 只处理“新键”（撤销/重做、工具切换、视图开关、帮助）；Del/R/方向键/Esc 分层仍在下面原处，
  // 那些路径已经跑绿了，不为了"统一"去重写。
  if (!isEditingInput) {
    const hit = findShortcut(e);
    if (hit && runShortcut(hit.id)) return;
  }

  if (e.key === 'Escape' && shortcutsHelpOpen.value) {
    shortcutsHelpOpen.value = false;
    return;
  }

  if (e.key === 'Escape' && showExterior.value) {
    showExterior.value = false;
    return;
  }

  // Esc：取消选中的门窗（浮窗一起关）
  if (e.key === 'Escape' && selectedOpening.value) {
    cancelOpeningEdit();
    return;
  }

  // Esc：结束当前这段墙（画墙是连续画的，必须有个明确的收尾键）
  if (e.key === 'Escape' && !isEditingInput && wallDraftStart.value) {
    wallDraftStart.value = null;
    clearAlignGuides();
    renderer.requestRender();
    return;
  }

  if (!isEditingInput && selectedFurniture.value && editMode.value) {
    // 方向键微调家具位置
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      const step = e.shiftKey ? gridSize.value * 5 : gridSize.value;
      let dx = 0, dy = 0;
      if (e.key === 'ArrowLeft') dx = -step;
      if (e.key === 'ArrowRight') dx = step;
      if (e.key === 'ArrowUp') dy = -step;
      if (e.key === 'ArrowDown') dy = step;
      
      const item = selectedFurniture.value;
      const oldX = item.x;
      const oldY = item.y;
      item.x += dx;
      item.y += dy;
      store.updateFurniture(
        props.buildingNode.id,
        currentFloorId.value,
        item.id,
        { x: item.x, y: item.y },
        { x: oldX, y: oldY }
      );
      renderer.requestRender();
      return;
    }
  }
  
  if (e.key === 'Delete' && !isEditingInput) {
    if (selectedFurnitureIds.value.length > 1) {
      if (confirm(`确定删除选中的 ${selectedFurnitureIds.value.length} 件家具？`)) {
        for (const id of [...selectedFurnitureIds.value]) {
          store.removeFurniture(props.buildingNode.id, currentFloorId.value, id);
        }
        selectedFurnitureIds.value = [];
        selectedFurniture.value = null;
        renderer.requestRender();
      }
    } else if (selectedFurniture.value) {
      deleteSelected();
    }
  }
  if (e.key === 'Escape' && !isEditingInput) {
    if (editMode.value) exitEditMode();
    else {
      selectedFurniture.value = null;
      selectedFurnitureIds.value = [];
    }
    renderer.requestRender();
  }
  if (e.key === 'r' && selectedFurniture.value && editMode.value) {
    rotateSelected();
  }
}

// 换工具时清掉对齐参考线（不然切走后洋红虚线还挂在画布上）
watch(interactionMode, () => {
  clearAlignGuides();
  renderer.requestRender();
});

// 监听楼层变化自动重绘
watch(currentFurniture, () => {
  renderer.requestRender();
});

// 对外暴露 `renderer` / `canvas`：App 的视口书签（R5）需要取相机与聚焦（见 PlanetMap 同名注释）
defineExpose({ canvas, renderer });
</script>

<style scoped>
.interior-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-primary);
}

.map-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 16px;
  border-bottom: 1px solid var(--nav-border);
  background: var(--toolbar-bg);
}

.header-left {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.header-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.back-btn {
  background: none;
  border: 1px solid var(--nav-border);
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  font-size: 12px;
}

.back-btn:hover {
  background: var(--btn-bg);
}

.interior-container h2 {
  font-size: 14px;
  color: var(--text-primary);
  margin: 0;
}

.hint {
  font-size: 11px;
  color: var(--text-tertiary);
  margin: 0;
}

.hint a {
  color: var(--accent);
  text-decoration: none;
}

.hint a:hover {
  text-decoration: underline;
}

.edit-hint {
  color: var(--accent);
}

.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

/* 出图状态：成功淡出，失败常驻（不设 TTL，免得用户没看见就消失） */
.export-msg {
  font-size: 11px;
  color: var(--text-secondary);
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.export-msg.err {
  color: #d9534f;
}

.export-btn,
.exterior-btn {
  min-width: 64px;
}

.adopt-btn {
  padding: 5px 10px;
  border: 1px solid var(--nav-border);
  background: var(--btn-bg);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 11px;
}

.adopt-btn:hover {
  background: var(--btn-bg-hover);
  color: var(--text-primary);
}

.adopt-btn.ghost {
  background: transparent;
}

.edit-entry-btn {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
  font-weight: 600;
}

.edit-entry-btn:hover {
  background: var(--accent);
  color: white;
  filter: brightness(1.15);
}

/* 楼层切换栏 */
.floor-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--nav-border);
  background: var(--toolbar-bg);
}

.floor-tabs {
  display: flex;
  gap: 4px;
  flex: 1;
  overflow-x: auto;
}

.floor-tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--nav-border);
  background: var(--btn-bg);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 11px;
  white-space: nowrap;
}

.floor-tab.active {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}

.floor-tab:hover:not(.active) {
  background: var(--btn-bg-hover);
}

.floor-level {
  font-weight: bold;
  font-size: 10px;
}

.floor-actions {
  display: flex;
  gap: 4px;
}

.floor-btn {
  padding: 4px 8px;
  border: 1px solid var(--nav-border);
  background: var(--btn-bg);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 11px;
}

.floor-btn:hover:not(:disabled) {
  background: var(--btn-bg-hover);
}

.floor-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.floor-btn.danger:hover:not(:disabled) {
  background: rgba(255, 0, 0, 0.1);
  color: #ff6b6b;
}

/* 相邻建筑切换器 */
.building-switcher {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.building-switch-btn {
  padding: 4px 8px;
  border: 1px solid var(--nav-border);
  background: var(--btn-bg);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 11px;
  transition: background 0.1s ease;
}

.building-switch-btn:hover {
  background: var(--btn-bg-hover);
  color: var(--text-primary);
}

.building-menu {
  position: absolute;
  top: 100%;
  left: 0;
  min-width: 160px;
  max-height: 240px;
  overflow-y: auto;
  background: var(--nav-bg, #1c2128);
  border: 1px solid var(--nav-border, #30363d);
  border-radius: var(--radius-md);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  z-index: 1000;
  margin-top: 4px;
  padding: 4px 0;
}

.building-menu div {
  padding: 6px 12px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary);
}

.building-menu div:hover {
  background: var(--btn-bg-hover);
  color: var(--text-primary);
}

.building-menu div.current {
  color: var(--accent);
  background: var(--accent-bg, rgba(88, 166, 255, 0.1));
  font-weight: 600;
}

/* 编辑工具栏 */
.edit-toolbar-wrap {
  border-bottom: 1px solid var(--nav-border);
  background: var(--toolbar-bg);
  padding: 6px 16px;
}

.edit-toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}

.toolbar-group {
  display: flex;
  gap: 4px;
  align-items: center;
}

.toolbar-group button {
  padding: 4px 8px;
  border: 1px solid var(--nav-border);
  background: var(--btn-bg);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 11px;
}

.toolbar-group button.active {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
  animation: pulse-glow 2s ease-in-out infinite;
}

@keyframes pulse-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(88, 166, 255, 0.4); }
  50% { box-shadow: 0 0 0 6px rgba(88, 166, 255, 0); }
}

.toolbar-group button:hover:not(.active) {
  background: var(--btn-bg-hover);
}

.toolbar-group button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.toolbar-label {
  font-size: 10px;
  color: var(--text-tertiary);
  margin-left: 4px;
}

.toolbar-group-exit {
  margin-left: auto;
}

.toolbar-close {
  background: #2ea043 !important;
  color: white !important;
  border-color: #2ea043 !important;
}

.canvas-wrapper {
  flex: 1;
  position: relative;
  overflow: hidden;
}

.canvas-wrapper canvas {
  display: block;
  width: 100%;
  height: 100%;
}

/* ===== 快捷键一览（A27）===== */
.shortcut-btn { min-width: 86px; }

.shortcuts-overlay {
  position: absolute;
  inset: 0;
  z-index: 90;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(28, 34, 44, 0.38);
}
.shortcuts-dialog {
  width: min(760px, calc(100% - 40px));
  max-height: calc(100% - 60px);
  overflow: auto;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 18px 48px rgba(20, 28, 40, 0.28);
  padding: 16px 20px 12px;
}
.sc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.sc-head h4 { margin: 0; font-size: 15px; color: #222b36; }
.sc-groups {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 26px;
}
.sc-group h5 {
  margin: 8px 0 4px;
  font-size: 12px;
  font-weight: 600;
  color: #8a95a3;
  letter-spacing: 0.04em;
}
.sc-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 4px 0;
  border-bottom: 1px solid #f0f2f5;
}
.sc-keys { flex: 0 0 118px; display: flex; flex-wrap: wrap; gap: 3px; align-items: center; }
.sc-keys kbd {
  font-family: inherit;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid #d5dbe3;
  border-bottom-width: 2px;
  background: #f8fafc;
  color: #3d4753;
}
.sc-or { font-size: 11px; color: #9aa5b3; }
.sc-text { display: flex; flex-direction: column; gap: 1px; }
.sc-text b { font-size: 12.5px; font-weight: 600; color: #2b3442; }
.sc-text i { font-size: 11.5px; font-style: normal; color: #7b8794; }
.sc-foot {
  margin: 12px 0 0;
  padding-top: 8px;
  border-top: 1px solid #eef1f5;
  font-size: 11.5px;
  color: #7b8794;
}
.sc-foot kbd {
  font-family: inherit;
  font-size: 11px;
  padding: 0 4px;
  border-radius: 3px;
  border: 1px solid #dfe4ea;
  background: #f8fafc;
}

/* ===== 家具自绘（2026-11-14）===== */
.shape-edit-bar {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 60;              /* 在 eagle-eye 之上，别被小地图压住 */
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-radius: 8px;
  background: rgba(255, 247, 235, 0.97);
  border: 1px solid #f0c48a;
  box-shadow: 0 4px 14px rgba(60, 40, 10, 0.14);
  font-size: 12px;
  color: #6b4a1d;
  max-width: calc(100% - 32px);
  flex-wrap: wrap;
}
.shape-hint b { color: #3f2a0c; font-weight: 600; }
.shape-count {
  font-variant-numeric: tabular-nums;
  padding: 1px 7px;
  border-radius: 9px;
  background: rgba(240, 170, 60, 0.22);
  color: #8a5c15;
}
.shape-btn {
  /* 工具栏按钮一律“图标/文字 + 最小宽度”（项目纪律：用 min-width 不用 width） */
  min-width: 56px;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid #d9b483;
  background: #fff;
  color: #6b4a1d;
  font-size: 12px;
  cursor: pointer;
}
.shape-btn:hover:not(:disabled) { background: #fff4e3; }
.shape-btn.primary {
  background: #e08a2b;
  border-color: #cf7a1d;
  color: #fff;
}
.shape-btn.primary:hover:not(:disabled) { background: #ce7c21; }
.shape-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.shape-tip { color: #9a7743; font-size: 11px; }

.shape-actions {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

.shape-tpl-row {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  align-items: center;
}
.shape-tpl-row .popover-select { flex: 1 1 auto; min-width: 0; }
.shape-btn.active {
  background: #ffe9c9;
  border-color: #e08a2b;
  color: #8a5c15;
}

/* 家具详情浮窗 */
.opening-popover {
  /* 门窗浮窗放在画布区右上（header + 楼层条下面），不压住标题与工具栏 */
  top: 132px;
}

.opening-range {
  width: 118px;
}

.node-detail-popover {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 240px;
  background: var(--panel-bg);
  border: 1px solid var(--nav-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  z-index: 30;
}

.popover-header-actions {
  display: flex;
  gap: 4px;
  align-items: center;
}

.edit-btn {
  background: none;
  border: 1px solid var(--nav-border);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  line-height: 1;
  /* 2026-11-05：从纯铅笔改成“铅笔 + 编辑”，要按内容撑开，不许裁字。 */
  display: inline-flex;
  align-items: center;
  gap: 3px;
  white-space: nowrap;
}

.edit-btn:hover {
  background: var(--btn-bg);
  color: var(--text-primary);
}

.popover-title-input {
  flex: 1;
  background: var(--bg-primary);
  border: 1px solid var(--nav-border);
  color: var(--text-primary);
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 600;
}

.popover-select,
.popover-number {
  flex: 1;
  background: var(--bg-primary);
  border: 1px solid var(--nav-border);
  color: var(--text-primary);
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  font-size: 11px;
}

.size-inputs {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
}

.size-input {
  width: 50px;
  background: var(--bg-primary);
  border: 1px solid var(--nav-border);
  color: var(--text-primary);
  padding: 3px 5px;
  border-radius: var(--radius-sm);
  font-size: 11px;
}

.size-sep {
  color: var(--text-tertiary);
  font-size: 11px;
}

.rotation-input {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
}

.unit-label {
  color: var(--text-tertiary);
  font-size: 11px;
}

.popover-actions {
  display: flex;
  gap: 6px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--nav-border);
}

.popover-actions .adopt-btn {
  flex: 1;
  text-align: center;
}

.popover-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--nav-border);
}

.popover-header h4 {
  margin: 0;
  font-size: 13px;
  color: var(--text-primary);
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 16px;
}

.close-btn:hover {
  color: var(--text-primary);
}

.popover-body {
  padding: 10px 12px;
}

.detail-row {
  display: flex;
  gap: 8px;
  margin-bottom: 6px;
}

.detail-label {
  font-size: 11px;
  color: var(--text-tertiary);
  min-width: 50px;
}

.detail-value {
  font-size: 11px;
  color: var(--text-primary);
}

/* 添加家具对话框 */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 900;
}

.modal-dialog {
  background: var(--panel-bg);
  border: 1px solid var(--nav-border);
  border-radius: var(--radius-lg);
  padding: 20px;
  width: 320px;
  box-shadow: var(--shadow-lg);
}

.modal-dialog h3 {
  margin: 0 0 16px 0;
  font-size: 15px;
  color: var(--text-primary);
}

.form-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
}

.form-row label {
  font-size: 12px;
  color: var(--text-secondary);
  min-width: 50px;
}

.form-row input,
.form-row select {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid var(--nav-border);
  background: var(--bg-primary);
  color: var(--text-primary);
  border-radius: var(--radius-sm);
  font-size: 12px;
}

.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 16px;
}
</style>
