<template>
  <!-- 工具栏**河流编辑行**（2026-11-07 拆分第 4 步）：只在使用“河流”工具时出现，
       与 `.province-row` 同款“切到该类工具才出现的选项行”。
       为什么必须是**带可见文字的常驻行**：节点编辑的三个能力（加拐点 / 删节点 / 删整条）
       在没有可见文字时等于没有（暮雨原话“河流删除也非常不好用”）。

       🔴 三条硬约束（每搬一行都一样）：
         · 根元素必须是原来的 `<div class="toolbar-row river-edit-row">`，不许包 wrapper；
         · `data-testid` / `title` / `:disabled` / 按钮顺序原样；
         · 状态仍归父组件：只读 props、只发事件，不碰 store。
       ⚠️ 样式：`.river-edit-row .river-edit-name`（浅蓝）与 `.river-edit-row button:disabled`
       都在父组件的 scoped 表里，父表里都写了 `:deep()` 入口 —— 见 `scenario-map.css`，别删。 -->
  <div class="toolbar-row river-edit-row" data-testid="river-edit-row">
    <label class="row-label">河流编辑：</label>
    <template v-if="selectedRiver">
      <span class="river-edit-name" :title="`当前选中：${selectedRiver.name || '未命名'}（${(selectedRiver.points || []).length} 个节点）`">
        已选中“{{ selectedRiver.name || '未命名' }}”· {{ (selectedRiver.points || []).length }} 点
      </span>
      <button
        data-testid="river-del-node"
        :disabled="activeNode < 0"
        @click="$emit('removeNode')"
        :title="activeNode >= 0
          ? `删掉第 ${activeNode + 1} 个节点（这条河重新平滑一次）—— 等价于把鼠标移到节点上按 Delete`
          : '删单个节点：先把鼠标移到某个节点上（它会变黄），再点这里或按 Delete'"
      ><Icon name="x" :size="13"/>删这个节点</button>
      <button
        data-testid="river-del-all"
        @click="$emit('removeAll')"
        title="删掉整条河（一条撤销可撤回）—— 快捷键：鼠标不在任何节点上时按 Delete"
      ><Icon name="trash" :size="13"/>删整条河</button>
      <button
        data-testid="river-clip-coast-row"
        @click="$emit('clip')"
        title="把这条河裁到海岸线（保留陆地那一段；整条在海里时不会自动删）"
      ><Icon name="scissors" :size="13"/>裁到海岸线</button>
      <span class="row-hint" v-if="selCount > 1">共选中 {{ selCount }} 条（批量删除/裁剪都算一条撤销）</span>
      <span class="row-hint" v-else>再点河身=加拐点，按住节点拖=微调（一次操作 = 一条撤销）</span>
    </template>
    <span v-else class="row-hint" data-testid="river-edit-hint">
      按住左键拖一笔 = 画一条河（松手成河、自动平滑）；点已有河流的河身 = 选中它，再点河身 = 加拐点
    </span>
  </div>
</template>

<script setup>
import Icon from '../../../components/Icon.vue';

defineProps({
  /** 当前选中的河（可能为 null —— 那时本行只显示一句操作提示） */
  selectedRiver: { type: Object, default: null },
  /** 光标当前悬停/选中的节点下标（`-1` = 没有 → 删节点按钮禁用） */
  activeNode: { type: Number, default: -1 },
  /** 批量选中的条数（> 1 时提示文案换成“共选中 N 条”） */
  selCount: { type: Number, default: 0 },
});
defineEmits(['removeNode', 'removeAll', 'clip']);
</script>
