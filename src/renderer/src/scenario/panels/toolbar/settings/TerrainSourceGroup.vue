<template>
  <!-- “更多 → 地形 · 底图 · 生成”卡片里的**地形来源**组（2026-11-07 拆分第 9 步）。
       根元素仍是 `<div class="tool-group" data-testid="basemap-terrain-source">`；
       `v-if="baseMapKey"` 留在父组件。

       🔴 地形来源有两种，取舍完全不同，必须显式选（M1c，2026-09-25）：
         冻结导入 = 复制一份独立副本 → 历史存档剧本（行星后来怎么改都不影响它）
         跟随行星 = 共用同一份数据   → 当代地图（两边互相影响）
       真相在 store（planetId 字段 / 底图自持的 heightmap），这里只管展示与触发。 -->
  <div class="tool-group" data-testid="basemap-terrain-source">
    <label>地形：</label>
    <span
      data-testid="basemap-terrain-mode"
      :title="modeTitle"
      :style="{ fontSize: '11px', padding: '1px 6px', border: '1px solid currentColor', borderRadius: '3px', opacity: 0.85, whiteSpace: 'nowrap' }"
    >{{ modeLabel }}</span>
    <select
      :value="planetId"
      class="basemap-select"
      :disabled="mode === 'following'"
      title="选择地形来源行星"
      @change="$emit('update:planetId', $event.target.value)"
    >
      <option value="">选行星…</option>
      <option v-for="p in planets" :key="p.id" :value="p.id">{{ p.name }}</option>
    </select>
    <button
      data-testid="basemap-freeze-import"
      :disabled="!planetId || mode === 'following'"
      title="把该行星当前的地形**复制一份**到这张底图（副本独立：之后行星怎么改都不影响它，它也改不到行星）—— 适合历史存档剧本"
      @click="$emit('freeze')"
    >冻结导入</button>
    <button
      data-testid="basemap-bind-planet"
      :disabled="!planetId || mode === 'following'"
      title="让这张底图**跟随**该行星的地形（共用同一份：在剧本里涂山会改到行星，反之亦然）—— 适合与行星同步构建的当代地图。历史存档请改用“冻结导入”"
      @click="$emit('bind')"
    >跟随</button>
    <button
      v-if="mode === 'following'"
      data-testid="basemap-unbind"
      title="解除跟随（行星那份不受影响；本底图回到“没有地形”，可再用“冻结导入”拿一份副本）"
      @click="$emit('unbind')"
    >解绑</button>
  </div>
</template>

<script setup>
defineProps({
  /** 当前地形来源模式：'' | 'frozen' | 'following' | …（父组件的 terrainInfo.mode） */
  mode: { type: String, default: '' },
  modeLabel: { type: String, default: '' },
  modeTitle: { type: String, default: '' },
  /** 选中的来源行星 id（可空） */
  planetId: { type: String, default: '' },
  /** 可选行星：`[{ id, name }]` */
  planets: { type: Array, default: () => [] },
});
defineEmits(['update:planetId', 'freeze', 'bind', 'unbind']);
</script>
