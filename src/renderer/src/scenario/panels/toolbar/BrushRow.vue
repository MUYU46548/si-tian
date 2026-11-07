<template>
  <!-- 工具栏“更多 → 笔刷与绘制”卡片里的那一行（2026-11-07 拆分第 7 步）：
       笔刷类工具按钮（高度/群系/河流/地貌/势力/文化/宗教/聚落/地名/标记/道路）+ 各自的参数下拉
       + 河源汇流 / 河流来源 / 追踪前先平滑 + 重算气候。

       🔴 三条硬约束（每搬一行都一样）：
         · 根元素必须是原来的 `<div class="toolbar-row">`，不许包 wrapper；
         · `data-testid` / `title` / 控件顺序 / 各 `v-if="tool === xxx"` 的参数下拉原样；
         · 状态仍归父组件：开关与下拉走**具名 v-model**，常量表（RELIEF_ICONS / BURG_SIZES /
           LABEL_PRESETS / MARKER_TYPES / ROAD_STYLES）由父组件传入 —— 不在这里另抄一份。

       ⚠️ 这一行控件多，所以**没有拆成更小的组件**：它们共用同一个 `.row-label` + `.tool-group`，
       再拆就要为“哪个下拉属于哪个按钮”再建一层嵌套，反而更难读（决断页那条“超过 20 个 props
       就回第二节重评”的门槛是 20，这里是 15 个 props）。 -->
  <div class="toolbar-row">
    <label class="row-label">笔刷：</label>
    <div class="tool-group">
      <button
        :class="{ active: tool === 'height' }"
        @click="$emit('setTool', 'height')"
        title="高度笔刷 (H) — 左键抬高/右键降低地形"
      ><Icon name="trending-up" :size="15"/>高度</button>
      <button
        :class="{ active: tool === 'biome' }"
        @click="$emit('setTool', 'biome')"
        title="生物群系笔刷 (N) — 涂抹生物群系"
      ><Icon name="palette" :size="15"/>群系</button>
      <button
        :class="{ active: tool === 'river' }"
        @click="$emit('setTool', 'river')"
        title="河流编辑器 (W) — 按住左键拖出笔迹 = 画一条河（松手成河）；**Shift + 按在已有河的河身上拖出去 = 画支流**（起点自动吸附、松手在母河上插拐点）；点河身加拐点；拖节点微调；Delete 删节点"
      ><Icon name="droplets" :size="15"/>河流</button>
      <button
        :class="{ active: autoRiverCount > 0 }"
        @click="$emit('generateRivers')"
        title="自动河流（预览）— 按地形高度从高到低追踪入海路径。⚠️ 结果只画在画布上、**不会存进项目**：切走视图或换底图就没了；要长期保留请用“河流 (W)”手画。"
      ><Icon name="waves" :size="15"/>自动河流</button>
      <!-- 🔴 河源汇流闸门（2026-11-04，FMG 口径重抄后由“源头高度”改名）：
           它控制的是**河源要攒够多少汇水**（降水当量），不是绝对高度 ——
           旧标题那句“只有高度高于这个值的格子才能当河源”已经不成立。
           ⚠️ `data-testid` 保持不变：用例/演练按它定位，改名会把判据弄红。 -->
      <input
        :value="riverSourceHeight"
        data-testid="river-source-height"
        type="number" min="0" max="100" step="5"
        class="river-source-height"
        title="河源汇流 — 河源至少要攒够这么多水（降水当量）才成河。调低 = 更多更碎的小支流；调高 = 只留大江。默认 60"
        @input="$emit('update:riverSourceHeight', Number($event.target.value))"
      />
      <!-- 🔴 河流来源（2026-10-16 第五修）：实测自动河与底图自带河**是两套水系**
           （段到自带河最近距离中位 18.78 世界单位，只有 10% 在 3 单位内）→ 并存时
           必然"各画各的"。给一个显式开关让用户只留一套，而不是替他猜。
           默认 `both` = 现有行为一字不变。 -->
      <select
        :value="riverSource"
        data-testid="river-source"
        class="river-source-select"
        title="画哪一套河 —— 实测自动河与底图自带河是**两套不同的水系**（中位相距约 1.3 格）。“两套都画”= 一直以来的行为；想只留一套就选另一个（自动河要先点“自动河流”生成）"
        @change="$emit('update:riverSource', $event.target.value)"
      >
        <option value="both">河流：两套都画</option>
        <option value="base">只画底图自带</option>
        <option value="auto">只画自动生成</option>
      </select>
      <!-- 🔴 2026-10-17 第八修·再修（用户：“这个长河受限有一大串很难看清的一闪而过的文本，
             放在已经很拥挤的工具栏里真的有必要吗？”）—— **没必要，已移除**。
             原先这里常驻一枚“⚠️ 长河受限”标签，状态栏还会追一句“悬停看原因”。
             问题是：① 工具栏本来就挤，多一个角标只会让人以为界面坏了；
             ② 真正的信息（这份地形为什么长不出长河）**长到放不进 tooltip**，
                而且它是一句"解释"不是"动作"，常驻在操作区没有价值；
             ③ 现在已经有**真正的解法**（“按轮廓生成地形”）—— 提示该变成一次性的指路，
                不该长期占位。
             ⇒ 只在**生成回执里说一次**（见父组件的 generateAndShowRivers），做完就消失。 -->
      <!-- 🔴 追踪前先平滑（2026-10-16）：实测这是唯一能让河"长出主干"的方向
           （最长河 140→270 世界单位）。默认关 = 零行为变更。 -->
      <label
        class="check-label river-smooth-label"
        title="追踪前先平滑地形 —— 实测能让最长河道翻倍（140→270 世界单位）、河网铺开全岛。原理：抹掉粗网格上的微洼地，让水顺着大谷走。⚠️ 代价：平滑会压低山头，源头变少 → 勾上时会**自动把“源头高度”降到 40**（否则可能一条河都没有）"
      ><input type="checkbox" :checked="riverSmooth" data-testid="river-smooth"
              @change="$emit('update:riverSmooth', $event.target.checked)" />平滑</label>
      <button
        :class="{ active: tool === 'relief' }"
        @click="$emit('setTool', 'relief')"
        title="Relief 图标 (I) — 放置山脉/树木/沙漠等自然特征"
      ><Icon name="mountain" :size="15"/>地貌</button>
      <select v-if="tool === 'relief'" :value="selectedReliefIcon" class="brush-biome-select" title="Relief 图标"
              @change="$emit('update:selectedReliefIcon', $event.target.value)">
        <option v-for="icon in reliefIcons" :key="icon.id" :value="icon.id">{{ icon.name }}</option>
      </select>
      <button
        :class="{ active: tool === 'paint' }"
        @click="$emit('setTool', 'paint')"
        title="势力油漆桶 (P) — 点击省份指派势力"
      ><Icon name="palette" :size="15"/>势力</button>
      <button
        :class="{ active: tool === 'culture' }"
        @click="$emit('setTool', 'culture')"
        title="文化笔刷 (C) — 涂抹文化区域"
      ><Icon name="users" :size="15"/>文化</button>
      <button
        :class="{ active: tool === 'religion' }"
        @click="$emit('setTool', 'religion')"
        title="宗教笔刷 (R) — 涂抹宗教区域"
      ><Icon name="church" :size="15"/>宗教</button>
      <button
        :class="{ active: tool === 'burg' }"
        @click="$emit('setTool', 'burg')"
        title="智能聚落 (U) — 点击放置，自动贴合地形"
      ><Icon name="home" :size="15"/>聚落</button>
      <select v-if="tool === 'burg'" :value="selectedBurgSize" class="brush-biome-select" title="聚落规模"
              @change="$emit('update:selectedBurgSize', $event.target.value)">
        <option v-for="size in burgSizes" :key="size.id" :value="size.id">{{ size.name }}</option>
      </select>
      <button
        :class="{ active: tool === 'label' }"
        @click="$emit('setTool', 'label')"
        title="历史地名 (T) — 点击放置文字标记"
      ><Icon name="tag" :size="15"/>地名</button>
      <select v-if="tool === 'label'" :value="selectedLabelPreset" class="brush-biome-select" title="标签样式预设"
              @change="$emit('update:selectedLabelPreset', $event.target.value)">
        <option v-for="preset in labelPresets" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
      </select>
      <button
        :class="{ active: tool === 'marker' }"
        @click="$emit('setTool', 'marker')"
        title="标记 (K) — 点击放置标记"
      ><Icon name="map-pin" :size="15"/>标记</button>
      <select v-if="tool === 'marker'" :value="selectedMarkerType" class="brush-biome-select" title="标记类型"
              @change="$emit('update:selectedMarkerType', $event.target.value)">
        <option v-for="type in markerTypes" :key="type.id" :value="type.id">{{ type.name }}</option>
      </select>
      <button
        :class="{ active: tool === 'road' }"
        @click="$emit('setTool', 'road')"
        title="道路 (J) — 两点连线，自动生成沿等高线路径"
      ><Icon name="git-branch" :size="15"/>道路</button>
      <select v-if="tool === 'road'" :value="selectedRoadStyle" class="brush-biome-select" title="道路样式"
              @change="$emit('update:selectedRoadStyle', $event.target.value)">
        <option v-for="style in roadStyles" :key="style.id" :value="style.id">{{ style.name }}</option>
      </select>
      <button
        :class="{ active: tool === 'derive' }"
        @click="$emit('deriveLayers')"
        title="重算气候 —— 按当前高度重新算温度/降水/群系（不动地形本身）"
      ><Icon name="refresh-cw" :size="15"/>重算气候</button>
    </div>
  </div>
</template>

<script setup>
import Icon from '../../../components/Icon.vue';

defineProps({
  /** 当前工具 id（决定每个按钮的高亮与四个参数下拉出不出） */
  tool: { type: String, default: 'select' },
  /** 自动河流预览的条数（> 0 时“自动河流”按钮高亮） */
  autoRiverCount: { type: Number, default: 0 },
  /** 河源汇流阈值（降水当量，默认 60） */
  riverSourceHeight: { type: Number, default: 60 },
  /** 画哪一套河：both / base / auto */
  riverSource: { type: String, default: 'both' },
  /** 追踪前先平滑地形（勾上会把河源阈值降到 40） */
  riverSmooth: { type: Boolean, default: false },
  selectedReliefIcon: { type: String, default: '' },
  selectedBurgSize: { type: String, default: '' },
  selectedLabelPreset: { type: String, default: '' },
  selectedMarkerType: { type: String, default: '' },
  selectedRoadStyle: { type: String, default: '' },
  // 常量表由父组件传入（单源）：不在这里另抄一份
  reliefIcons: { type: Array, default: () => [] },
  burgSizes: { type: Array, default: () => [] },
  labelPresets: { type: Array, default: () => [] },
  markerTypes: { type: Array, default: () => [] },
  roadStyles: { type: Array, default: () => [] },
});
defineEmits([
  'setTool', 'generateRivers', 'deriveLayers',
  'update:riverSourceHeight', 'update:riverSource', 'update:riverSmooth',
  'update:selectedReliefIcon', 'update:selectedBurgSize', 'update:selectedLabelPreset',
  'update:selectedMarkerType', 'update:selectedRoadStyle',
]);
</script>
