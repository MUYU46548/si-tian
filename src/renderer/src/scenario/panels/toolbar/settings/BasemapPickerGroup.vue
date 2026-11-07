<template>
  <!-- “更多 → 地形 · 底图 · 生成”卡片里的**底图选择与维护**组（2026-11-07 拆分第 9 步）。
       根元素仍是 `<div class="tool-group">`。

       🔴 这里每个按钮都写着“为什么它在”：空底图（有底图时也能新建）、从留底恢复（备份读不回来
       就不算备份）、补齐数据（已切了几百块省份的底图只能补、不能重导）、重建海岸（第三条路：
       省 ∩ 新陆地，不作废省份）。这些理由留在组件里，别搬丢。
       ⚠️ 只读态下“空底图”要灰禁并说明原因（`isReadOnly` / `readOnlyReason` 由父组件传入 ——
       源码闸门会反查父组件确实把 `store.isReadOnly` / `store.readOnlyReason` 传进来了）。 -->
  <div class="tool-group">
    <label>底图：</label>
    <select :value="baseMapKey" class="basemap-select" :title="`当前底图: ${baseMapKey}`"
            @change="$emit('update:baseMapKey', $event.target.value); $emit('change')">
      <option v-for="bm in options" :key="bm.id" :value="bm.id">
        {{ bm.name }} ({{ bm.count }}省)
      </option>
    </select>
    <button @click="$emit('importMap')" title="导入 .map 底图 —— 同名且一笔未改：只补缺；同名且改过：重导为新底图并迁移旧归属"><Icon name="plus" :size="15"/>导入底图</button>
    <!-- 2026-10-22：**已有底图时也能新建空底图**。以前只有“空项目空态”能建，
         已有底图的项目只能导 .map —— 用户想试笔刷却没有干净画布，只能对着真实底图下手
         （“连新底图都建不了”/“怕改坏不敢测”的直接来源）。 -->
    <button
      data-testid="basemap-add-empty"
      :disabled="isReadOnly"
      :title="isReadOnly
        ? `新建底图已停用：${readOnlyReason || '只读：未打开项目'}`
        : '新建一张空白底图（已有底图时也能加）—— 之后画的省份 / 河流 / 道路都落在这张新图上，不动现有底图'"
      @click="$emit('addEmpty')"
    ><Icon name="plus" :size="15"/>空底图</button>
    <!-- 0.2.9（2026-10-13）：**从留底恢复** —— 导入过的 .map 原文一直留在
         `<项目>.sitian.backups/basemap-sources/`（0.2.8 起），但此前只有"列清单"没有入口，
         用户在界面上够不着（只能自己去资源管理器翻目录）。备份读不回来就不算备份。 -->
    <button
      data-testid="basemap-source-restore"
      class="has-advanced"
      title="从留底恢复底图 —— 列出项目备份目录里留存的原始 .map（导入时自动留底），选一份重新导入；同名底图只补缺，省份与归属不动"
      @click="$emit('openSourceRestore')"
    ><Icon name="history" :size="15"/>恢复底图</button>
    <!-- B2（2026-10-11）：给**已经在用**的底图补 FMG 数据（高度图 / 河流 / 道路 / 城镇）。
         真实缘由：`desite` 是 2026-09-10 那次导入建的，而当时解析器只读 SVG 省份多边形，
         高度图/河流/道路根本没被读出来 —— 今天解析器能读全，但没有任何入口能把它们补进
         一张已经切了几百块省份的底图（重导 = 覆盖，绝不可行）。 -->
    <button
      v-if="missing.length"
      data-testid="basemap-refresh-data"
      class="has-advanced"
      :title="`刷新底图数据 — 这张底图还缺：${missing.join(' / ')}。选一个 .map 文件补齐，` +
              '省份边界（' + provinceCount + ' 块）与归属记录一个字都不会动'"
      @click="$emit('refreshData')"
    ><Icon name="refresh" :size="15"/>补齐数据</button>
    <!-- F（0.2.6）：用新 .map 的海岸线重建现有省份外环 —— 只换海岸那一段，不作废省份。
         为什么需要它：生成器原始海岸线 10525 点，导出时被简化成 778 点，落到底图上
         每个省只剩几十个点；而"重导为新底图"会把几百块省份与归属全丢掉。
         这个按钮走的是第三条路：**省 ∩ 新陆地**。 -->
    <button
      data-testid="basemap-rebuild-coastline"
      class="has-advanced"
      :title="hasLandFeatures
        ? '用新 .map 的海岸线重建省份外环 — 只换海岸那一段；内陆省逐点不动、相邻省仍无缝、一整次 = 一条撤销'
        : '用新 .map 的海岸线重建省份外环（这张底图里没有陆地轮廓数据，会先让你选一份 .map）'"
      @click="$emit('rebuildCoastline')"
    ><Icon name="mountain" :size="15"/>重建海岸</button>
  </div>
</template>

<script setup>
import Icon from '../../../../components/Icon.vue';

defineProps({
  /** 当前底图 key */
  baseMapKey: { type: String, default: '' },
  /** 可切换的底图：`[{ id, name, count }]` */
  options: { type: Array, default: () => [] },
  /** 无项目 = 只读：新建底图要灰禁（并在 title 里说明原因） */
  isReadOnly: { type: Boolean, default: false },
  readOnlyReason: { type: String, default: '' },
  /** 这张底图缺哪些数据（空 = 不显示“补齐数据”） */
  missing: { type: Array, default: () => [] },
  /** 省份块数（“补齐数据”的 title 里要说清不会动到它们） */
  provinceCount: { type: Number, default: 0 },
  /** 这张底图里有没有陆地轮廓数据 */
  hasLandFeatures: { type: Boolean, default: false },
});
defineEmits([
  'update:baseMapKey', 'change', 'importMap', 'addEmpty', 'openSourceRestore',
  'refreshData', 'rebuildCoastline',
]);
</script>
