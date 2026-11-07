<template>
  <!-- 工具栏“更多 → 图层 · 着色”卡片里的那一行（2026-11-07 拆分第 6 步）：
       图层显示开关（10 个）+ 锁定图层入口 ＋ 底图栅格层 + 河流/道路/立体 ＋ 着色模式。

       🔴 三条硬约束（每搬一行都一样）：
         · 根元素必须是原来的 `<div class="toolbar-row">`，不许包 wrapper；
         · `data-testid` / `title` / 勾选项顺序 / `select` 的 option 列表原样；
         · 状态仍归父组件：这里全部用**具名 v-model**（`update:xxx`），父组件那边照旧是
           一个 `ref`，源码两边都搜得到（比塞一个大对象可读，也比 15 个手写 emit 好维护）。

       ⚠️ 样式：`.check-label` / `.tool-group` / 按钮皮肤都在父组件的 scoped 表里，
       父表里都有 `:deep()` 入口 —— 见 `scenario-map.css` 开头那段“为什么必须 :deep”。 -->
  <div class="toolbar-row">
    <div class="tool-group">
      <label>图层：</label>
      <label class="check-label"><input type="checkbox" :checked="showBiomes" @change="$emit('update:showBiomes', $event.target.checked)" /> 生物群系</label>
      <label class="check-label"><input type="checkbox" :checked="showBorders" @change="$emit('update:showBorders', $event.target.checked)" /> 边界</label>
      <label class="check-label"><input type="checkbox" :checked="showBurgs" @change="$emit('update:showBurgs', $event.target.checked)" /> 城镇</label>
      <label class="check-label"><input type="checkbox" :checked="showLabels" @change="$emit('update:showLabels', $event.target.checked)" /> 标签</label>
      <label class="check-label" title="显示导入的城镇名 / 河流名（导入的地图数据常是英文名；默认关闭，需要时再开）"><input type="checkbox" :checked="showPlaceNames" data-testid="toggle-place-names" @change="$emit('update:showPlaceNames', $event.target.checked)" /> 自动地名</label>
      <label class="check-label" title="显示“地形注记”里的山系/海域名（沿走向排字）。生成地形时会按种子自动起名（只补空）；也可以在里面自己改名或手画一条"><input type="checkbox" :checked="showTerrainNames" data-testid="toggle-terrain-names" @change="onTerrainNamesChange" /> 地形名</label>
      <label class="check-label" title="EU4 式分级标注：缩小看势力名（可简称），放大再加上省名"><input type="checkbox" :checked="showPolityLabels" data-testid="toggle-polity-labels" @change="$emit('update:showPolityLabels', $event.target.checked)" /> 势力名</label>
      <label class="check-label" title="放大到最详档时显示省名（未命名的省显示“新省份 N”，是改名的线索）"><input type="checkbox" :checked="showProvinceNames" data-testid="toggle-province-names" @change="$emit('update:showProvinceNames', $event.target.checked)" /> 省名</label>
      <label class="check-label" title="只显示你自己起过名的省 —— 程序生成的“新省份 N”整层不画（415 省项目里通常只有几十个有真名，其余会把画面糊满）"><input type="checkbox" :checked="showNamedProvincesOnly" data-testid="toggle-named-provinces" @change="$emit('update:showNamedProvincesOnly', $event.target.checked)" /> 仅已命名省</label>
      <button @click="$emit('toggleLayerPanel')" title="图层锁定设置" :class="{ active: layerPanelOpen }"><Icon name="lock" :size="13"/>锁定图层</button>
    </div>
    <div class="tool-group">
      <label>底图图层：</label>
      <select :value="rasterLayer" title="网格数据图层（一次只渲染一层，避免叠加失真）"
              @change="$emit('update:rasterLayer', $event.target.value)">
        <option value="none">无</option>
        <option value="landsea">陆海底色</option>
        <option value="satellite">卫星影像</option>
        <option value="terrain">地形色</option>
        <option value="height">地形高度</option>
        <option value="temp">温度</option>
        <option value="prec">降水</option>
      </select>
      <label class="check-label"><input type="checkbox" :checked="showRivers" @change="$emit('update:showRivers', $event.target.checked)" /> 河流</label>
      <label class="check-label"><input type="checkbox" :checked="showRoutes" @change="$emit('update:showRoutes', $event.target.checked)" /> 道路</label>
      <!-- 🔴 山体阴影（2026-10-17 第七修）：用户“地形怎么3D表现”的落点。
           默认**关**（零行为变更）。只对“陆海底色 / 地形高度”两档生效 ——
           温度/降水是**专题图**，给它们加阴影会把数值读成地形（那是错的口径）。 -->
      <label
        class="check-label terrain-shade-label"
        data-testid="terrain-shade"
        title="山体阴影 —— 按相邻格高差算明暗，让地形“立起来”（制图惯例：光从左上来）。默认关；只对“陆海底色 / 地形高度”生效。⚠️ 我们的高度图可能是粗网格（例如 133×75），阴影会跟着粗 —— 这是数据本身的粒度，不是渲染问题。"
      ><input type="checkbox" :checked="terrainShade" data-testid="terrain-shade-box" @change="$emit('update:terrainShade', $event.target.checked)" /> 立体</label>
    </div>
    <div class="tool-group">
      <label>着色：</label>
      <select :value="colorMode" @change="$emit('update:colorMode', $event.target.value)">
        <option value="default">默认</option>
        <option value="culture">文化</option>
        <option value="religion">宗教</option>
      </select>
    </div>
  </div>
</template>

<script setup>
import Icon from '../../../components/Icon.vue';

defineProps({
  showBiomes: { type: Boolean, default: true },
  showBorders: { type: Boolean, default: true },
  showBurgs: { type: Boolean, default: true },
  showLabels: { type: Boolean, default: true },
  showPlaceNames: { type: Boolean, default: false },
  showTerrainNames: { type: Boolean, default: true },
  showPolityLabels: { type: Boolean, default: true },
  showProvinceNames: { type: Boolean, default: true },
  showNamedProvincesOnly: { type: Boolean, default: false },
  /** 锁定图层面板是否开着（决定那个按钮的高亮） */
  layerPanelOpen: { type: Boolean, default: false },
  /** 底图栅格层：none / landsea / satellite / terrain / height / temp / prec */
  rasterLayer: { type: String, default: 'none' },
  showRivers: { type: Boolean, default: true },
  showRoutes: { type: Boolean, default: true },
  /** 山体阴影（只对陆海底色 / 地形高度生效） */
  terrainShade: { type: Boolean, default: false },
  /** 着色模式：default / culture / religion */
  colorMode: { type: String, default: 'default' },
});
const emit = defineEmits([
  'update:showBiomes', 'update:showBorders', 'update:showBurgs', 'update:showLabels',
  'update:showPlaceNames', 'update:showTerrainNames', 'update:showPolityLabels',
  'update:showProvinceNames', 'update:showNamedProvincesOnly',
  'update:rasterLayer', 'update:showRivers', 'update:showRoutes',
  'update:terrainShade', 'update:colorMode',
  'toggleLayerPanel', 'terrainNamesChanged',
]);
/** “地形名”这一格除了改值，父组件还要顺带做一次联动（原来写在 @change 上） */
function onTerrainNamesChange(e) {
  emit('update:showTerrainNames', e.target.checked);
  emit('terrainNamesChanged');
}
</script>
