<template>
  <!-- 省份行 · 批量铺底（`voronoi`）的选项组（2026-11-07 拆分第 8 步）。
       C（2026-10-11）：切分期间必须有出路。500 块的逐块布尔实测 19s，中途用户在画布上
       乱点只会把事件排到队列里、回来一起执行（越点越卡）—— 所以忙时既**遮住画布**，
       也给一个**取消**（取消 = 放弃这一批，落盘与内存都不动，可重来）。 -->
  <div class="tool-group brush-settings">
    <label class="check-label" title="铺底范围：默认把这张底图上所有陆地省一起重切；也可以只重切选中的那几个省">
      范围
      <select :value="scope" class="brush-biome-select" data-testid="voronoi-scope"
              @change="$emit('update:scope', $event.target.value)">
        <option value="land">全部陆地（{{ targetCount }} 省）</option>
        <option value="selection" :disabled="!selectedCount">
          选中的省份（{{ selectedCount }} 个）
        </option>
      </select>
    </label>
    <label class="check-label" title="要切成多少块 —— 直接决定省份密度">
      块数
      <input type="number" :value="count" min="2" max="3000" step="10"
             class="brush-number" data-testid="voronoi-count"
             @input="$emit('update:count', Number($event.target.value))" />
    </label>
    <label class="check-label" title="0 = 规整方格（像棋盘）；越大越自然。默认 0.6 左右最像手绘的政区">
      抖动
      <input type="range" :value="jitter" min="0" max="0.9" step="0.05" class="brush-slider"
             @input="$emit('update:jitter', Number($event.target.value))" />
      {{ Number(jitter).toFixed(2) }}
    </label>
    <button @click="$emit('autoSeed')" :disabled="busy"
            data-testid="voronoi-autoseed"
            title="按上面的块数自动播种（在大陆里均匀撒点）"><Icon name="sparkles" :size="13"/> 自动播种</button>
    <button @click="$emit('reroll')" :disabled="busy"
            title="换一批种子点（形状重来一次，不满意就多点几次）"><Icon name="refresh-cw" :size="13"/> 换一批</button>
    <button @click="$emit('clearSeeds')" :disabled="busy" title="清空种子点（可以在画布上手动点）">
      <Icon name="x" :size="13"/> 清空种子（{{ seedCount }}）
    </button>
    <button @click="$emit('run')" :disabled="busy || !seedCount"
            data-testid="voronoi-run"
            title="真的切下去：会替换掉范围内的旧省份，归属与易主记录自动继承；一整批 = 一条撤销（Ctrl+Z 可整批撤回）">
      <Icon name="grid" :size="13"/> 一键切分
    </button>
    <button v-if="busy" @click="$emit('cancel')" data-testid="voronoi-cancel"
            class="batch-cancel" title="取消这一批切分（当前进度会被丢弃，省份与归属都不会改动）">
      <Icon name="x" :size="13"/> 取消
    </button>
    <span class="row-hint" :class="{ ready: !busy }" data-testid="voronoi-status">{{ status }}</span>
  </div>
</template>

<script setup>
import Icon from '../../../../components/Icon.vue';

defineProps({
  /** 铺底范围：land = 全部陆地 / selection = 只重切选中的省 */
  scope: { type: String, default: 'land' },
  /** 范围内有多少省（文案用） */
  targetCount: { type: Number, default: 0 },
  /** 当前选中了多少省（0 时“选中的省份”那项禁用） */
  selectedCount: { type: Number, default: 0 },
  /** 要切成多少块 */
  count: { type: Number, default: 60 },
  /** 抖动（0 = 规整方格） */
  jitter: { type: Number, default: 0.6 },
  /** 是否正在切分（忙时按钮禁用 + 露出“取消”） */
  busy: { type: Boolean, default: false },
  /** 已撒了多少个种子点 */
  seedCount: { type: Number, default: 0 },
  /** 状态文案（父组件维护） */
  status: { type: String, default: '' },
});
defineEmits([
  'update:scope', 'update:count', 'update:jitter',
  'autoSeed', 'reroll', 'clearSeeds', 'run', 'cancel',
]);
</script>
