<template>
  <!-- “更多 → 地形 · 底图 · 生成”卡片里的**笔刷参数**组（2026-11-07 拆分第 9 步）。
       根元素仍是 `<div class="tool-group brush-settings">`；`v-if`（哪些工具才显示）留在父组件。
       ⚠️ 样式：`.brush-settings` / `.check-label` / `.brush-slider` / `.brush-biome-select` 都在
       父组件的 scoped 表里，父表对它们都有 `:deep()` 入口 —— 见 `scenario-map.css` 开头那段。 -->
  <div class="tool-group brush-settings">
    <label>笔刷：</label>
    <label class="check-label" title="笔刷半径（滚轮调节）">
      半径
      <input type="range" :value="radius" min="20" max="300" step="10" class="brush-slider"
             @input="$emit('update:radius', Number($event.target.value))" />
      {{ radius }}
    </label>
    <label class="check-label" v-if="tool === 'height'" title="笔刷强度（Shift+滚轮调节）">
      强度
      <input type="range" :value="strength" min="0.5" max="10" step="0.5" class="brush-slider"
             @input="$emit('update:strength', Number($event.target.value))" />
      {{ strength }}
    </label>
    <label class="check-label" v-if="tool === 'biome'">
      群系
      <select :value="biome" class="brush-biome-select" @change="$emit('update:biome', $event.target.value)">
        <option v-for="(color, key) in biomeColors" :key="key" :value="key">{{ key }}</option>
      </select>
    </label>
    <label class="check-label" v-if="tool === 'culture'">
      文化
      <select :value="culture" class="brush-biome-select" @change="$emit('update:culture', $event.target.value)">
        <option v-for="c in cultures" :key="c.id" :value="String(c.id)">{{ c.name }}</option>
      </select>
    </label>
    <label class="check-label" v-if="tool === 'religion'">
      宗教
      <select :value="religion" class="brush-biome-select" @change="$emit('update:religion', $event.target.value)">
        <option v-for="r in religions" :key="r.id" :value="String(r.id)">{{ r.name }}</option>
      </select>
    </label>
  </div>
</template>

<script setup>
defineProps({
  /** 当前工具（决定露出哪几个参数：强度只给高度笔，群系/文化/宗教各一个下拉） */
  tool: { type: String, default: 'select' },
  radius: { type: Number, default: 60 },
  strength: { type: Number, default: 2 },
  biome: { type: String, default: '' },
  culture: { type: String, default: '' },
  religion: { type: String, default: '' },
  /** 群系配色表（父组件单源传入，选项文字就是 key） */
  biomeColors: { type: Object, default: () => ({}) },
  /** 这张底图上可选的文化 / 宗教（父组件算好传入） */
  cultures: { type: Array, default: () => [] },
  religions: { type: Array, default: () => [] },
});
defineEmits(['update:radius', 'update:strength', 'update:biome', 'update:culture', 'update:religion']);
</script>
