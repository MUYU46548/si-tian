<template>
  <!-- “更多 → 地形 · 底图 · 生成”卡片里的**分辨率 / 平滑面板**（2026-11-07 拆分第 9 步）。
       根元素仍是 `<div class="resample-panel" data-testid="resample-panel">`；
       `v-if="resampleOpen && resamplePreview"` 留在父组件。

       🔴 面板底部那段口径是实测结论，别删：放大**不会**让河变长（同一片地形被更细地走一遍而已）。
       1→2→4 倍时河条数 57→287→1089，而最长河的世界长度几乎不变（111→120→110）——
       想要更长的大河只能换更高分辨率的**源数据**。 -->
  <div class="resample-panel" data-testid="resample-panel">
    <div class="rp-row">
      <label>放大</label>
      <select :value="factor" data-testid="resample-factor"
              @change="$emit('update:factor', Number($event.target.value))">
        <option :value="2">×2</option>
        <option :value="3">×3</option>
        <option :value="4">×4</option>
        <option :value="6">×6</option>
        <option :value="8">×8</option>
      </select>
      <span class="rp-cost" :class="'lv-' + preview.level" data-testid="resample-cost">
        {{ preview.message }}
      </span>
    </div>
    <div v-if="!preview.ok" class="rp-warn">{{ preview.message }}</div>
    <div class="rp-row">
      <label>平滑</label>
      <select :value="smoothRadius" data-testid="smooth-radius"
              @change="$emit('update:smoothRadius', Number($event.target.value))">
        <option :value="1">半径 1 格</option>
        <option :value="2">半径 2 格</option>
        <option :value="3">半径 3 格</option>
      </select>
      <button class="rp-btn" data-testid="smooth-apply" @click="$emit('smooth')">平滑地形</button>
      <span class="rp-hint">平滑只改高度；气候/群系要另点“重算派生图层”</span>
    </div>
    <div class="rp-actions">
      <button
        class="rp-btn primary"
        data-testid="resample-apply"
        :disabled="!preview.ok"
        @click="$emit('apply')"
      >应用分辨率</button>
      <button class="rp-btn" @click="$emit('close')">取消</button>
    </div>
    <div class="rp-note">
      ⚠️ 实测口径：放大**不会**让河变长（同一片地形被更细地走一遍而已）。
      1→2→4 倍时河条数 57→287→1089，而最长河的世界长度几乎不变（111→120→110）。
      想要更长的大河只能换更高分辨率的**源数据**。
    </div>
  </div>
</template>

<script setup>
defineProps({
  /** `{ ok, level, message, srcCells, dstCells }`（父组件算好的预演结果） */
  preview: { type: Object, required: true },
  /** 放大倍数 */
  factor: { type: Number, default: 2 },
  /** 平滑半径（格） */
  smoothRadius: { type: Number, default: 1 },
});
defineEmits(['update:factor', 'update:smoothRadius', 'smooth', 'apply', 'close']);
</script>
