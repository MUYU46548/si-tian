<template>
  <!-- 省份行 · 折线切割（`polySplit`）的选项组（2026-11-07 拆分第 8 步）。
       折线可以沿着海岸、山脊、历史边界走任意弯；两端落在省外（或省内）都行 ——
       不在省上的那一段会自动沿切向延长。 -->
  <div class="tool-group brush-settings">
    <span class="row-hint"
          title="折线可以沿着海岸、山脊、历史边界走任意弯；两端落在省外（或省内）都行 —— 不在省上的那一段会自动沿切向延长">
      逐点点击画折线 → 双击 / Enter 切开
    </span>
    <label class="check-label" data-testid="polysplit-side"
           title="切开后哪一半继续用原省份的身份（id / 名字 / 归属 / 时间轴都跟着它）。画布上**绿色那半**就是它；按住 Shift 切换">
      绿色那半保留原省份身份（Shift 切换）
    </label>
    <span class="row-hint" data-testid="polysplit-points">已点 {{ pointCount }} 个点</span>
    <button @click="$emit('finish')" :disabled="pointCount < 2"
            data-testid="polysplit-finish"
            title="沿折线切开（也可以双击画布 / 按 Enter）"><Icon name="check" :size="13"/> 切开</button>
    <button @click="$emit('clear')" title="清空这条折线（Esc 同效）"><Icon name="x" :size="13"/> 取消</button>
  </div>
</template>

<script setup>
import Icon from '../../../../components/Icon.vue';

defineProps({
  /** 当前折线已点的点数（< 2 时“切开”禁用） */
  pointCount: { type: Number, default: 0 },
});
defineEmits(['finish', 'clear']);
</script>
