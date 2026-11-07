<template>
  <!-- 省份行 · 圈选 / 点填 / 改省界共用的选项组（2026-11-07 拆分第 8 步）。
       🔴 锁定海岸线（默认开）：涂归属 / 圈选只在**已有省份范围内**易手，绝不扩张到海面 ——
       海岸线只由“底图编辑”调整（暮雨 2026-10-09 明确要求：“平时维持锁定状态”）。
       🔴 P2：边界是**矢量布尔**的结果（目标省并集 / 相交省差集），不经过任何格点 ——
       旧版那层“格点即时反馈”已删除：格子是 10525 点海岸线被退化成 22 点的根因。 -->
  <div class="tool-group brush-settings">
    <label>划归到：</label>
    <select :value="brushTarget" class="brush-biome-select" title="要划归的目标省份"
            @change="$emit('update:brushTarget', Number($event.target.value))">
      <option v-for="o in targetOptions" :key="o.p.id" :value="o.idx">{{ o.p.name || ('省份 ' + o.idx) }}</option>
    </select>
    <template v-if="showBrushTool">
      <label class="check-label">
        工具
        <select :value="brushTool" class="brush-biome-select" title="改省界 / 抹除 / 平滑（改的是省界形状，不是势力归属）"
                @change="$emit('update:brushTool', $event.target.value)">
          <option v-for="t in toolOptions" :key="t.key" :value="t.key">{{ t.label }}</option>
        </select>
      </label>
      <label class="check-label" title="笔刷半径（屏幕像素）—— 画布缩放时手感一致；世界半径 = 像素 / 当前缩放">
        半径
        <input type="range" :value="brushRadius" min="1" max="200" step="1" class="brush-slider"
               @input="$emit('update:brushRadius', Number($event.target.value))" />
        {{ brushRadius }}px
      </label>
    </template>
    <label class="check-label" data-testid="lock-coast"
           title="开启后：涂归属 / 圈选只在已有省份范围内生效，“不会改动海岸线”；要改海岸线请到“底图编辑”里做">
      <input type="checkbox" :checked="lockCoast" @change="$emit('update:lockCoast', $event.target.checked)" /> 锁定海岸线
    </label>
    <button @click="$emit('addEmptyProvince')" title="新建一个空省份 —— 用“底图编辑 → 改省界”笔刷涂出它的地盘即可"><Icon name="plus" :size="13"/> 新建省份</button>
    <button @click="$emit('clearAllShapes')" title="清空所有省份的边界（一次撤销可回退）"><Icon name="refresh-cw" :size="13"/> 重置省界</button>
    <span class="row-hint ready"
          title="涂完抬手即按多边形布尔改边界：目标省并集、相交省差集，几何只可能更精细">
      矢量边界（精确）
    </span>
  </div>
</template>

<script setup>
import Icon from '../../../../components/Icon.vue';

defineProps({
  /** 目标省份在 `terrain` 里的下标 */
  brushTarget: { type: Number, default: 0 },
  /** 可划归的省份选项：`[{ idx, p }]`（父组件按底图算出） */
  targetOptions: { type: Array, default: () => [] },
  /** 是否露出“工具”下拉（只有“改省界”工具才需要选 改省界/抹除/平滑） */
  showBrushTool: { type: Boolean, default: false },
  /** 当前笔刷工具 key */
  brushTool: { type: String, default: 'add' },
  /** 可选工具：`[{ key, label }]`（父组件从 PROVINCE_TOOLS 过滤掉 lasso 后传入） */
  toolOptions: { type: Array, default: () => [] },
  brushRadius: { type: Number, default: 24 },
  /** 锁定海岸线：涂归属 / 圈选不扩张到海面 */
  lockCoast: { type: Boolean, default: true },
});
defineEmits([
  'update:brushTarget', 'update:brushTool', 'update:brushRadius', 'update:lockCoast',
  'addEmptyProvince', 'clearAllShapes',
]);
</script>
