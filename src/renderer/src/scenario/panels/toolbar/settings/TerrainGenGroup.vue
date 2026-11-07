<template>
  <!-- “更多 → 地形 · 底图 · 生成”卡片里的**地形生成簇**（2026-11-07 拆分第 9 步）。
       根元素仍是 `<div class="tool-group">`。七个入口各自的“为什么在”都留在 title 里：

       · 建高度图：新底图的高度图此前**只有 .map 导入**一条来源，自建底图里高度/群系/文化/宗教
         笔刷与一键派生全都“点了没反应”（没有网格 → 直接 return）。
       · 按轮廓生成地形（2026-10-17 第八修·改向）：上面那个建出来是**全 0 的平地**，
         于是“画大陆 → 建高度图 → 自动河流 → **永远是 0 条河**”且不报错。
         这个按钮补上本地地形起点（离岸距离场 + 分形起伏），自建地图才长得出河流。
       · 地形生成参数：旧入口一点就按写死的常量推演，用户既不知道种子也无法换，
         不满意只能反复点、每次都是同一张。
       · 分辨率：真实来由是用户“地形模模糊糊”，量出来的事实是**数据分辨率**（133×75），
         唯一有效做法是把格子变密；⚠️ 按钮**必须带可见文字**（第一版只有图标，
         暮雨实测“分辨率按钮不知道在哪里”）。 -->
  <div class="tool-group">
    <button
      v-if="canCreateHeightmap"
      data-testid="basemap-create-heightmap"
      title="为这张底图创建高度图网格（创建后即可用高度 / 群系 / 文化 / 宗教笔刷与一键派生）"
      @click="$emit('createHeightmap')"
    ><Icon name="layers" :size="15"/>建高度图</button>
    <button
      v-if="canSynthesize"
      data-testid="basemap-synthesize-terrain"
      title="按已画好的陆地轮廓推演一份地形高度图（内陆高、海岸低 + 分形起伏）—— 这是自建地图长出河流的起点，之后可用地形笔刷继续手改"
      @click="$emit('synthesize')"
    ><Icon name="mountain" :size="15"/>按轮廓生成地形</button>
    <button
      v-if="canSynthesize"
      data-testid="basemap-terrain-params"
      :class="{ active: terrainGenOpen }"
      title="地形生成参数 —— 种子 / 起伏 / 山脉 / 高原 / 裂谷 / 精度 + 3 张候选预览，选一张再应用（一条撤销）"
      @click="$emit('toggleTerrainGen')"
    ><Icon name="settings" :size="15"/>地形生成参数</button>
    <button
      v-if="hasBaseMap"
      data-testid="basemap-fmg-terrain"
      :class="{ active: fmgOpen }"
      title="现成模板 —— 14 套做好的大陆形状（大陆 / 群岛 / 环礁 / 地中海…），挑一套直接出高度图，一条撤销可退回"
      @click="$emit('toggleFmg')"
    ><Icon name="sparkles" :size="15"/>现成模板</button>
    <!-- P0-2（2026-10-25）：**造陆**。此前"从零开始"的第一步是让用户自己画大陆 ——
         手画出来多是圆饼，而且只会画一块中央大陆。这里按参数生成大陆/群岛轮廓，
         再用现有铺底管线切成省（一条 undo）。 -->
    <button
      v-if="hasBaseMap"
      data-testid="basemap-generate-landmass"
      :class="{ active: landmassOpen }"
      title="造陆 —— 按参数生成大陆/群岛轮廓，再用铺底切成省；一次 Ctrl+Z 可整体退回"
      @click="$emit('toggleLandmass')"
    ><Icon name="globe" :size="15"/>造陆</button>
    <!-- P0-4（2026-10-25）：文化/宗教/势力派生 —— 空省从"没有文化、没有归属"变成
         有连续文化区、有按文化分组的势力；只补空/覆盖两档显式选，笔刷仍可覆盖。 -->
    <button
      v-if="hasBaseMap"
      data-testid="basemap-derive-culture"
      :class="{ active: deriveOpen }"
      title="生成文化/宗教/势力 —— 按地形与位置铺文化区，再按文化分组建势力；只补空或覆盖（会先问）"
      @click="$emit('toggleDerive')"
    ><Icon name="users" :size="15"/>生成文化势力</button>
    <button
      v-if="canResample"
      data-testid="basemap-resample"
      :class="{ active: resampleOpen }"
      :title="`调整高度图分辨率 — 当前 ${previewSrcCells} 格；`
              + '把格子变密能让海岸线/山坡不再一块一块（放大会更明显）。⚠️ 这是插值，不增加地形信息'"
      @click="$emit('openResample')"
    ><Icon name="grid" :size="15"/>分辨率</button>
  </div>
</template>

<script setup>
import Icon from '../../../../components/Icon.vue';

defineProps({
  /** 有底图才有“现成模板 / 造陆 / 生成文化势力” */
  hasBaseMap: { type: Boolean, default: false },
  /** 这张底图还没有高度图 → 露出“建高度图” */
  canCreateHeightmap: { type: Boolean, default: false },
  /** 已经有陆地轮廓、还没有高度图 → 露出“按轮廓生成地形 / 地形生成参数” */
  canSynthesize: { type: Boolean, default: false },
  /** 高度图存在 → 露出“分辨率” */
  canResample: { type: Boolean, default: false },
  /** 当前高度图源格数（分辨率按钮的 title 里要写） */
  previewSrcCells: { type: Number, default: 0 },
  // 四个面板的开合（决定按钮高亮）
  terrainGenOpen: { type: Boolean, default: false },
  fmgOpen: { type: Boolean, default: false },
  landmassOpen: { type: Boolean, default: false },
  deriveOpen: { type: Boolean, default: false },
  resampleOpen: { type: Boolean, default: false },
});
defineEmits([
  'createHeightmap', 'synthesize', 'toggleTerrainGen', 'toggleFmg',
  'toggleLandmass', 'toggleDerive', 'openResample',
]);
</script>
