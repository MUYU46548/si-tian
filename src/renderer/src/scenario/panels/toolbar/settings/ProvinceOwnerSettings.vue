<template>
  <!-- 省份行 · 涂归属的选项组（2026-11-07 拆分第 8 步）。
       🔴 这一块是**日常剧本编辑的主路径**：选势力 → 按住涂 → 碰到的省一次改归属；
       它只改势力归属，**不动省界几何**（改形状是“底图编辑 → 改省界”）。
       🔴 2026-11-03 用户实测：“涂归属一开始无法选择势力…疑似必须选中一个剧本才可以用”——
       判断完全正确：归属是**按剧本（时期）记账**的，没有剧本就没有“这个年代归谁”可言。
       旧界面在无剧本时只是整条势力色板不渲染，工具本体静默不干活 → 用户看到“点了没反应”。
       所以这里把依赖写成一句话 + 两个直达按钮，不再让人靠乱点撞出来。 -->
  <div class="tool-group brush-settings">
    <span
      v-if="!hasScenario"
      class="row-hint"
      data-testid="owner-brush-need-scenario"
      title="涂归属记的是“某个年代这块地归谁”，所以必须挂在一条剧本（时期）上；没有剧本时连势力色板都不会出现"
    >
      涂归属要先有剧本：
      <button data-testid="owner-brush-pick-scenario" @click="$emit('openScenarioList')">用左侧剧本列表选一个</button>
      <button data-testid="owner-brush-new-scenario" @click="$emit('newScenario')">新建剧本…</button>
    </span>
    <span class="row-label">涂归属：</span>
    <span class="row-hint" data-testid="owner-brush-polity" :class="{ ready: !!selectedPolity || clearOwnerMode }">
      <template v-if="clearOwnerMode">当前：<b>清除归属</b>（涂到的省变无主）</template>
      <template v-else-if="selectedPolity">当前势力：
        <b :style="{ color: selectedPolity.color || undefined }">{{ selectedPolity.name }}</b>
      </template>
      <template v-else>当前势力：<b>未选</b>（点地图上方“势力：”里的色块）</template>
    </span>
    <label class="check-label" title="笔刷半径（屏幕像素）">
      半径
      <input type="range" :value="brushRadius" min="4" max="120" step="1" class="brush-slider" data-testid="owner-brush-radius"
             @input="$emit('update:brushRadius', Number($event.target.value))" />
      {{ brushRadius }}px
    </label>
    <span class="row-hint">按住涂 · 一笔一条撤销 · Alt 吸管</span>
  </div>
</template>

<script setup>
defineProps({
  /** 有没有选中剧本（没有时给“先有剧本”的指路） */
  hasScenario: { type: Boolean, default: false },
  /** 当前选中的势力（null / undefined 时显示“未选”） */
  selectedPolity: { type: Object, default: null },
  /** 是否处在“清除归属”模式（涂到的省变无主） */
  clearOwnerMode: { type: Boolean, default: false },
  /** 笔刷半径（屏幕像素） */
  brushRadius: { type: Number, default: 24 },
});
defineEmits(['openScenarioList', 'newScenario', 'update:brushRadius']);
</script>
