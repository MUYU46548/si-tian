<template>
  <!-- 省份属性面板（2026-11-06 从 ScenarioMap.vue 拆出，拆分第四批）
       🔴 2026-10-01 的那条纪律**必须留着**：五个字段全部 `:value` + `@change`，不许用 v-model。
       `selectedProvince` 就是 terrain[] 里的**活对象**：v-model 会 ①绕开 guardWrite（只读态照改内存）；
       ②`updateBaseProvince` 采集的 oldProv 已被改过 → 撤销把新值当旧值还原（五项 undo 全空转）；
       ③文本输入挂在 @input 上时每敲一个字符 = 一条 undo + 一次落盘。
       所以这里照样只发事件，写仍走父组件的 store 写口（一条 undo + 写闸门）。 -->
  <div v-if="province && open" class="province-props" data-testid="province-props">
    <div class="props-header">
      <input ref="nameInput" :value="province.name || ''" @change="$emit('name', $event)" class="props-name" />
      <button class="props-close" title="收起省份面板" @click="$emit('close')">×</button>
    </div>
    <!-- 归属：2026-10-21 用户实测“看不到归属 / 看不到省份详情”。
         归属按**时间轴当前日期**显示（与地图着色同一口径），无主就明说；
         两个按钮都走 store（一条 undo + 写闸门），不在模板里直改活对象。 -->
    <div class="props-row props-owner" v-if="scenario" data-testid="province-owner-row">
      <label>归属：</label>
      <span class="owner-value" :class="{ none: !polity }">
        <template v-if="polity">
          <span class="props-dot" :style="{ background: polity.color }"></span>
          {{ polity.name }}
        </template>
        <template v-else>无主</template>
      </span>
      <button v-if="polity" class="props-mini" :disabled="readOnly"
              :title="`按当前日期 ${dateText} 清空归属（无主；时间轴记一条“该年变无主”，一笔撤销）`"
              @click="$emit('clearOwner')" data-testid="province-owner-clear">清成无主</button>
      <button v-else class="props-mini" :disabled="readOnly || !selectedPolity"
              :title="selectedPolity ? `按当前日期 ${dateText} 记为“${selectedPolity.name}”` : '先在色板选一个势力'"
              @click="$emit('assignOwner')" data-testid="province-owner-assign">设为当前势力</button>
    </div>
    <div class="props-sub" v-if="scenario">归属随“{{ dateText }}”变化（拖时间轴可看不同年份）</div>
    <div class="props-row">
      <label>生物群系：</label>
      <select :value="province.biome || ''" @change="$emit('biome', $event)">
        <option value="">未分类</option>
        <option value="ocean">海洋</option>
        <option value="hot_desert">热沙漠</option>
        <option value="cold_desert">冷沙漠</option>
        <option value="savanna">热带草原</option>
        <option value="grassland">草原</option>
        <option value="tropical_seasonal">热带季雨林</option>
        <option value="temperate_deciduous">温带落叶林</option>
        <option value="tropical_rainforest">热带雨林</option>
        <option value="temperate_rainforest">温带雨林</option>
        <option value="taiga">针叶林</option>
        <option value="tundra">冻原</option>
        <option value="glacier">冰川</option>
        <option value="wetland">湿地</option>
      </select>
    </div>
    <div class="props-row">
      <label>文化：</label>
      <input :value="province.culture || ''" @change="$emit('culture', $event)" placeholder="文化名称" />
    </div>
    <div class="props-row">
      <label>海岸：</label>
      <input type="checkbox" :checked="!!province.coast" @change="$emit('coast', $event)" />
    </div>
    <div class="props-row">
      <label>类型：</label>
      <select :value="province.kind === 'sea' ? 'sea' : 'land'" @change="$emit('kind', $event)"
              title="海域省份用海色渲染；陆地/海域是省份级属性（岛与飞地另见“环”）">
        <option value="land">陆地</option>
        <option value="sea">海域</option>
      </select>
    </div>
    <!-- 多环实体：飞地 / 洞都是独立的环。顶点编辑作用于**活动环**，这里切换 -->
    <div class="props-row" v-if="rings(province).length > 1">
      <label>编辑环：</label>
      <select v-model.number="ringIdx">
        <option v-for="(r, i) in rings(province)" :key="i" :value="i">
          {{ i === 0 ? '主环' : ('环 ' + (i + 1)) }}{{ r.fromGrid ? '（网格派生）' : '' }}
        </option>
      </select>
    </div>
    <div class="props-stats">
      环数: {{ rings(province).length }} ·
      顶点数: {{ ringVertexCount }}（活动环）
    </div>
    <!-- 资料（读料桥，2026-10-24）：按省名在全库资料里找**候选**。
         实现只有一份：`VaultLoreSection.vue`（省份面板与标记面板共用）——
         这段只许 `vaultIndexSearch` + `openNote`，不猜、不建、不写；找不到就明说。 -->
    <VaultLoreSection testid="province-vault" :query="province.name || ''" />
  </div>
</template>

<script setup>
import { ref } from 'vue';
import VaultLoreSection from '../../components/VaultLoreSection.vue';

defineProps({
  province: { type: Object, default: null },
  open: { type: Boolean, default: false },
  /** 剧本视图才有“归属随日期变化”的两行 */
  scenario: { type: Boolean, default: false },
  /** 当前省在该日期的归属势力（父组件的 selectedProvincePolity） */
  polity: { type: Object, default: null },
  /** 色板上选中的势力（决定“设为当前势力”能不能点） */
  selectedPolity: { type: Object, default: null },
  dateText: { type: String, default: '' },
  readOnly: { type: Boolean, default: false },
  readOnlyReason: { type: String, default: '' },
  /** 多环几何的唯一实现（utils/provinceShape.provinceRings） */
  rings: { type: Function, default: () => [] },
  ringVertexCount: { type: [Number, String], default: 0 },
});

// 与父组件同一个 ref（`.number` 修饰）：活动环下标仍归父组件（顶点编辑要用）
const ringIdx = defineModel('ringIdx', { type: Number, default: 0 });

defineEmits(['close', 'name', 'biome', 'culture', 'coast', 'kind', 'clearOwner', 'assignOwner']);

// 新建省份后父组件要把光标放进名字框（focusNewProvince）—— 输入框在组件里，
// 所以由父组件拿组件 ref 调这个方法，不再跨组件抓 DOM。
const nameInput = ref(null);
function focusName() {
  const el = nameInput.value;
  if (el && typeof el.focus === 'function') { el.focus(); if (el.select) el.select(); }
}
defineExpose({ focusName });
</script>

<style scoped src="./props-panel.css"></style>
