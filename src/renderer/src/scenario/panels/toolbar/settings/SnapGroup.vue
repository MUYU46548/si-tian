<template>
  <!-- “更多 → 地形 · 底图 · 生成”卡片里的**吸附**组（2026-11-07 拆分第 9 步）。
       根元素仍是 `<div class="tool-group">`。
       两个勾选项都“按住 Shift 临时禁用”——那是画布侧的快捷键，不在界面里。 -->
  <div class="tool-group">
    <label>吸附：</label>
    <label class="check-label" title="绘制/顶点编辑时对齐到 50px 网格（按住 Shift 临时禁用）">
      <input type="checkbox" :checked="snapToGrid" @change="$emit('update:snapToGrid', $event.target.checked)" /> 网格吸附
    </label>
    <label class="check-label" title="绘制时顶点吸附到已有省份边界（按住 Shift 临时禁用）">
      <input type="checkbox" :checked="snapToEdge" @change="$emit('update:snapToEdge', $event.target.checked)" /> 海岸线吸附
    </label>
  </div>
</template>

<script setup>
defineProps({
  /** 网格吸附（50px 格） */
  snapToGrid: { type: Boolean, default: false },
  /** 海岸线吸附（顶点贴已有省界） */
  snapToEdge: { type: Boolean, default: false },
});
defineEmits(['update:snapToGrid', 'update:snapToEdge']);
</script>
