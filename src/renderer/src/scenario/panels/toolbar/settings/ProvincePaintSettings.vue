<template>
  <!-- 省份行 · 笔刷建省的选项组（2026-11-07 拆分第 8 步）。
       它不选目标省 —— 每一笔都**新建**一个省（要改已有省就切“改省界”）。 -->
  <div class="tool-group brush-settings">
    <span class="row-label">笔刷建省：</span>
    <label class="check-label" title="笔刷半径（屏幕像素）—— 画布缩放时手感一致；世界半径 = 像素 / 当前缩放">
      半径
      <input type="range" :value="brushRadius" min="1" max="200" step="1" class="brush-slider"
             @input="$emit('update:brushRadius', Number($event.target.value))" />
      {{ brushRadius }}px
    </label>
    <span class="row-hint ready"
          title="新省只长在空地上：已有省份覆盖的地方涂不上（免得省份压叠）。要改已有省份的形状请用“改省界”。">
      按住涂 → 松手成一个省 · 一笔一条撤销
    </span>
  </div>
</template>

<script setup>
defineProps({
  /** 笔刷半径（屏幕像素） */
  brushRadius: { type: Number, default: 24 },
});
defineEmits(['update:brushRadius']);
</script>
