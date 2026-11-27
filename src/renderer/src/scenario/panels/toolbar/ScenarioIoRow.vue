<template>
  <!-- 工具栏“更多 → 剧本 · 导入导出”卡片里的那一行（2026-11-07 拆分第 5 步）：
       剧本管理 / 势力谱系 / 外交 / 撤销历史 ＋ 导出 PNG / 导出 SVG / 切片 / 导出数据 / 导入合并 / 导入替换。

       🔴 三条硬约束（每搬一行都一样）：
         · 根元素必须是原来的 `<div class="toolbar-row">`，不许再包一层 wrapper
           （`test_65` 按 class 数可见控件，包一层就数错）；
         · `data-testid` / `title` / 按钮顺序 / `:class` 的高亮语义原样；
         · 状态仍归父组件：这里只读 props、只发事件，不碰 store，也不自己开关面板。

       ⚠️ 样式：`.tool-group` 与按钮皮肤都在父组件的 scoped 表里，父表里都有 `:deep()` 入口 ——
       见 `scenario-map.css` 开头那段“为什么必须 :deep”，别删。 -->
  <div class="toolbar-row">
    <div class="tool-group">
      <button @click="$emit('openManager')" title="剧本管理"><Icon name="file-text" :size="15"/>剧本管理</button>
      <button @click="$emit('openLineage')" title="势力谱系管理（人工纠正继承关系 / 易主年份）" data-testid="open-lineage"><Icon name="git-branch" :size="15"/>势力谱系</button>
      <!-- 外交表（N3a-2，2026-11-02）：回答“某年 A 与 B 什么关系”——
           关系标签 / 该年生效事件 / “为什么”+ 势力关系矩阵；面板顶部可补录一条（一次录入 = 一条撤销）。
           与“势力谱系”分工：谱系管继承与易主年份，这里管两两关系（战争/同盟/臣属…）。 -->
      <button
        data-testid="diplomacy-open"
        :class="{ active: diplomacyOpen }"
        title="外交 —— 查“某年 A 与 B 什么关系”：关系 / 该年生效事件 / 为什么，附势力关系矩阵；也可以补录一条（一次录入 = 一条撤销）"
        @click="$emit('toggleDiplomacy')"
      ><Icon name="flag" :size="15"/>外交</button>
      <button @click="$emit('toggleHistory')" title="撤销历史" :class="{ active: historyOpen }"><Icon name="history" :size="15"/>撤销历史</button>
    </div>
    <div class="tool-group" title="导出">
      <!-- 2026-11-27：单张 PNG 的“导出尺寸”（用户要 4K 入册，原来固定 2× 没有口子）。
           标准 = 历史行为（图幅 2 倍）；4K = 成品长边至少 3840 像素，倍率按图幅自动算。
           SVG 是矢量，不受这里影响；切片倍率在切片对话框里选。
           ⚠️ 这是**动作参数**（点导出时随事件交给父组件），不是共享视图状态 ——
             所以留在本组件的本地 ref 里，父组件不必为它多存一份。 -->
      <label class="export-size" title="导出 PNG 的成品尺寸：标准 = 图幅 2 倍；4K = 长边至少 3840 像素（按图幅自动放大，适合印刷/入册）。SVG 是矢量，不受影响">
        导出尺寸
        <select v-model="exportScale" data-testid="export-scale">
          <option value="standard">标准</option>
          <option value="4k">4K</option>
        </select>
      </label>
      <button @click="$emit('exportPng', exportScale)" title="导出当前剧本/年份为 PNG" data-testid="export-png"><Icon name="image" :size="15"/>导出 PNG</button>
      <button @click="$emit('exportSvg')" title="导出当前剧本/年份为 SVG 矢量图（可进 Illustrator/Inkscape 继续加工）" data-testid="export-svg"><Icon name="layers" :size="15"/>导出 SVG</button>
      <button @click="$emit('openSliceExport')" data-testid="open-slice-export"
              title="逐年切片导出（每个状态变化的年份一张图 + frames.json 清单，可交 ffmpeg 合成）"><Icon name="film" :size="15"/>切片</button>
      <button @click="$emit('exportData')" title="导出当前底图的剧本数据（scenarios.json）" data-testid="export-json"><Icon name="export" :size="15"/>导出数据</button>
      <button @click="$emit('importMerge')" title="导入剧本数据（合并：同 key 覆盖）" data-testid="import-json-merge"><Icon name="download" :size="15"/>导入合并</button>
      <button @click="$emit('importReplace')" title="导入剧本数据（替换：清空现有剧本后再导入）" data-testid="import-json-replace"><Icon name="refresh" :size="15"/>导入替换</button>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import Icon from '../../../components/Icon.vue';

/** 导出 PNG 的尺寸档：'standard'（历史 2×）/ '4k'（成品长边 ≥ 3840）。动作参数，随事件上抛。 */
const exportScale = ref('standard');

defineProps({
  /** 外交面板是否开着（决定那个按钮的高亮） */
  diplomacyOpen: { type: Boolean, default: false },
  /** 撤销历史面板是否开着（同上） */
  historyOpen: { type: Boolean, default: false },
});
defineEmits([
  'openManager', 'openLineage', 'toggleDiplomacy', 'toggleHistory',
  'exportPng', 'exportSvg', 'openSliceExport', 'exportData', 'importMerge', 'importReplace',
]);
</script>
