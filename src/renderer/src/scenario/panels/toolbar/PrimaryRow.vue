<template>
  <!-- 工具栏**主行**（2026-11-07 拆分第 2 步）：退回 / 选择 / 画省份 / 涂归属 / 改形状 / 更多。
       为什么它最值得先拆：默认态下这一行**恰好 6 个可见控件**由 `test_65` / `test_97` 硬守着，
       所以它是“DOM 一个字节都没变”最有说服力的那一步（搬完两枚用例照过）。

       🔴 三条硬约束（每搬一行都一样）：
         · 根元素必须是原来那个 `<div class="toolbar-row primary-row">`，不许再包一层 wrapper
           （`test_65`/`test_97` 按 class 数控件，包一层就数错）；
         · `data-testid` / `title` / 按钮顺序 / 各处 `v-if` 原样；
         · 状态仍归父组件：这里只读 props、只发事件，不碰 store。

       ⚠️ 样式：`.back-btn` / `.more-toggle` / `.draw-hint` 都在父组件的 scoped 表里，
       而父 scope id **只贴在本组件根节点上**（根里面的 button 拿不到）。所以父表里
       这几个 class 都另有一条 `.scenario-toolbar :deep(...)` 入口 —— 见
       `scenario-map.css` 开头那段“为什么必须 :deep”，别删。 -->
  <div class="toolbar-row primary-row">

    <!-- 🔴 2026-10-21：这个按钮**先退子模式、再退模块**。
         暮雨实测：在底图编辑里点左上角“← 返回”，以为是退底图编辑，结果整个历史剧本被退掉。
         现在：底图编辑中 = “← 返回日常”（只关底图编辑）；日常态 = “← 退出剧本”（才离开模块）。
         模块级退出还有顶部“世界观”页签，这里不再是唯一出口。 -->
    <button @click="$emit('back')" class="back-btn" data-testid="scenario-back-btn"
            :title="basemapEditMode
              ? '退出底图编辑，回到日常剧本编辑（不会离开历史剧本）'
              : '退出历史剧本，回到世界页（顶部“世界观”页签同样可以离开）'">
      {{ basemapEditMode ? '← 日常视图' : '← 退出剧本' }}
    </button>
    <button
      :class="{ active: tool === 'select' }"
      @click="$emit('setTool', 'select')"
      title="选择 (V，默认) — 拖动平移画布，点击选中省份"
    ><Icon name="hand" :size="15"/>选择</button>
    <button
      v-if="basemapEditMode"
      :class="{ active: tool === 'draw' }"
      @click="$emit('setTool', 'draw')"
      title="画省份 · 自由绘制 (B) — 按住沿轮廓拖一圈 = 建一个省；单击 = 描点；Shift = 不吸附骨架（属于底图编辑）"
    ><Icon name="pencil" :size="15"/>画省份</button>
    <button
      :class="{ active: tool === 'ownerBrush' }"
      data-testid="owner-brush-btn"
      @click="$emit('setTool', 'ownerBrush')"
      title="涂归属 (Q) — 按住在地图上涂：碰到的省改成当前势力。一笔 = 一条撤销；Alt 点一下 = 吸管"
    ><Icon name="brush" :size="15"/>涂归属</button>
    <button
      v-if="basemapEditMode"
      :class="{ active: tool === 'vertex' }"
      @click="$emit('setTool', 'vertex')"
      title="顶点编辑 (G) — 拖拽顶点改形状（属于底图编辑）；Shift+拖动可框选一批顶点"
    >⬡改形状</button>
    <button
      class="more-toggle"
      :class="{ active: moreOpen, 'has-advanced': advancedToolActive }"
      @click="$emit('toggleMore')"
      title="更多 — 拆分 / 合并 / 点击填充 / 描轮廓 / 擦除 / 聚落 / 标记 / 道路，以及吸附与底图"
    ><Icon name="chevron-down" :size="13"/> 更多</button>
    <span v-if="snapToGridEnabled && (tool === 'draw' || tool === 'vertex')" class="draw-hint">吸附：50px 网格（Shift 临时禁用）</span>
  </div>
</template>

<script setup>
import Icon from '../../../components/Icon.vue';

defineProps({
  /** 是否在底图编辑模式（决定露出「画省份」「改形状」两个控件、以及退回键的文案） */
  basemapEditMode: { type: Boolean, default: false },
  /** 当前工具 id（父组件的 `tool`）；本行只关心 select / draw / ownerBrush / vertex */
  tool: { type: String, default: 'select' },
  /** 「更多」面板是否展开 */
  moreOpen: { type: Boolean, default: false },
  /** 当前工具是否属于“高级工具”（决定「更多」上的强调环） */
  advancedToolActive: { type: Boolean, default: false },
  /** 网格吸附开没开（决定尾部的吸附提示出不出） */
  snapToGridEnabled: { type: Boolean, default: false },
});
defineEmits(['back', 'setTool', 'toggleMore']);
</script>
