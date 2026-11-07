<template>
  <!-- 工具栏**底图/地理行**（2026-11-07 拆分第 3 步）：只在“底图编辑模式”开着时出现。
       为什么是独立一行而不是藏进“更多”：暮雨要的是**一眼看出现在的编辑对象换人了** ——
       藏进下拉里等于还是“混”（2026-10-18 第十七修）。

       🔴 三条硬约束（每搬一行都一样）：
         · 根元素必须是原来的 `<div class="toolbar-row basemap-row" data-testid="basemap-row">`，
           不许再包一层 wrapper；
         · `data-testid` / `title` / 按钮顺序 / `v-if` 原样；
         · 状态仍归父组件：只读 props、只发事件，不碰 store。

       ⚠️ 样式：`.row-label` / `.basemap-row-label` / `.basemap-exit` 都在父组件的 scoped 表里，
       父 scope id 只贴在本组件根节点上（根里面的元素拿不到），父表里那几个 class 都有
       `:deep()` 入口 —— 见 `scenario-map.css` 开头那段“为什么必须 :deep”，别删。 -->
  <div class="toolbar-row basemap-row" data-testid="basemap-row">
    <span class="row-label basemap-row-label"><Icon name="layers" :size="12"/> 底图/地理：</span>
    <button
      v-for="t in tools" :key="t.id"
      :class="{ active: tool === t.id }"
      :data-testid="'basemap-tool-' + t.id"
      :title="t.title"
      @click="$emit('setTool', t.id)"
    ><Icon :name="t.icon" :size="14"/>{{ t.label }}</button>
    <!-- “笔刷建省”= 像画图软件一样**涂出一块地**（2026-10-22）。
         与“画省份”的分工：画省份 = 描一圈精确边界（要闭合、会贴骨架）；
         笔刷建省 = 抹一条就成一块省（不闭合、涂抹过程就是最终形状）。
         放在“改省界”旁边而不是主行：主行的可见控件数由 test_97 硬守（日常 4 / 底图编辑 6）。 -->
    <button
      :class="{ active: tool === 'provincePaint' }"
      data-testid="basemap-tool-provincePaint"
      title="笔刷建省 (Shift+B) — 按住左键像涂色一样抹，松手把抹过的范围长成**一个省**：不用闭合、不会画出自交怪形，涂抹过程就是最终形状。已有省份的地不会被抢（新省只长在空地上）；一笔 = 一条撤销"
      @click="$emit('setTool', 'provincePaint')"
    ><Icon name="brush" :size="14"/>笔刷建省</button>
    <!-- “改省界”= 原先挂在日常行的那个几何笔刷（把笔迹并进所选省份）。
         2026-10-20：它与“涂归属”同名不同义，用户实测“好像在生造省份”。
         现在改名并收进底图编辑 —— 日常行只留**真的改归属**那一个。 -->
    <button
      :class="{ active: tool === 'provinceBrush' }"
      data-testid="basemap-tool-provinceBrush"
      title="改省界 (Shift+Q) — 按住涂抹，把笔迹并进下面“划归到”所选的那个省（**改的是省界形状，不是势力归属**）；相交的邻省会相应让出这块地。一笔 = 一条撤销。想改“这块地归哪个势力”请回日常行点“涂归属”"
      @click="$emit('setTool', 'provinceBrush')"
    ><Icon name="pencil" :size="14"/>改省界</button>
    <!-- D3（2026-10-26）：**地形注记** —— 山系名沿脊线排。它是**地理数据**（不是历史归属），
         所以住在底图编辑行；更多菜单里不再重复一份（同一个 testid 两处 = 用例命中哪个看顺序）。 -->
    <button
      v-if="baseMapKey"
      data-testid="basemap-terrain-labels"
      :class="{ active: terrainLabelsOpen }"
      title="地形注记 —— 从高度图抽山脊候选，逐条命名；名字沿脊线排（一条 Ctrl+Z 可退回）"
      @click="$emit('toggleTerrainLabels')"
    ><Icon name="type" :size="14"/>地形注记</button>
    <!-- 2026-10-21：出口就在工作行末尾。用户“误进入底图编辑、又找不到退出口，
         点左上角返回把整个剧本退了”——不能只靠顶栏那个按钮。 -->
    <button class="basemap-exit" data-testid="basemap-exit"
            title="退出底图编辑，回到日常剧本编辑（省份 / 归属 / 剧本）—— 不会离开历史剧本"
            @click="$emit('exit')">← 日常视图</button>
  </div>
</template>

<script setup>
import Icon from '../../../components/Icon.vue';

defineProps({
  /** 地理工具清单（父组件的 `BASEMAP_TOOLS`，唯一来源 —— 组件不另抄一份表） */
  tools: { type: Array, default: () => [] },
  /** 当前工具 id（父组件的 `tool`） */
  tool: { type: String, default: 'select' },
  /** 有底图才给“地形注记”（没底图时那个按钮点了也没东西可选） */
  baseMapKey: { type: String, default: '' },
  /** 地形注记面板是否开着（决定那个按钮的高亮） */
  terrainLabelsOpen: { type: Boolean, default: false },
});
defineEmits(['setTool', 'toggleTerrainLabels', 'exit']);
</script>
