<template>
  <!-- 工具栏**选中河流操作行**（2026-11-07 拆分第 4 步）：
       选中一条河之后，**不管当前是什么工具**都要有一条可见的操作行。
       此前只有“河流”工具里才有这一行 —— 用户用“选择”工具点中河之后界面上**没有任何删除入口**，
       只能猜着按 Delete（2026-10-17 第八修·再修，暮雨原话“河流删除也非常不好用”）。
       这一行只放：删这条 / 进河流工具拖节点 / 裁到海岸线 / 取消选中。

       🔴 三条硬约束（每搬一行都一样）：
         · 根元素必须是原来的 `<div class="toolbar-row river-selected-row">`，不许包 wrapper；
         · `data-testid` / `title` / 按钮顺序原样；
         · 状态仍归父组件：只读 props、只发事件，不碰 store。
       ⚠️ `river-edit-name` 的颜色规则写在 `.river-edit-row` 下面（不在本行），所以这里
       那个 span 一直是继承色 —— 搬家前后都一样，别顺手“修”它。 -->
  <div class="toolbar-row river-selected-row" data-testid="river-selected-row">
    <label class="row-label">已选中河流：</label>
    <span class="river-edit-name" :title="`当前选中：${selectedRiver.name || '未命名'}`"
          data-testid="river-sel-count">
      <template v-if="selCount > 1">共 {{ selCount }} 条（主：{{ selectedRiver.name || '未命名' }}）</template>
      <template v-else>{{ selectedRiver.name || '未命名' }} · {{ (selectedRiver.points || []).length }} 点</template>
    </span>
    <button
      class="tool-btn danger"
      data-testid="river-selected-delete"
      :title="selCount > 1
        ? '把选中的这批河一次删掉（整批 = 一条撤销）'
        : '删除这条河流（走撤销栈，Ctrl+Z 可恢复）'"
      @click="$emit('remove')"
    >{{ selCount > 1 ? `删除选中的 ${selCount} 条` : '删除这条河' }}</button>
    <button
      class="tool-btn"
      data-testid="river-selected-edit"
      title="切到河流工具，可以拖节点 / 点河身加拐点 / 删单个节点"
      @click="$emit('edit')"
    >编辑节点</button>
    <button
      class="tool-btn"
      data-testid="river-clip-coast"
      title="把选中的河裁到海岸线（画进海里的那一段被裁掉；整批 = 一条撤销）—— 想保留三角洲/河口就别裁"
      @click="$emit('clip')"
    >裁到海岸线</button>
    <button
      class="tool-btn"
      data-testid="river-selected-clear"
      title="取消选中（不删除任何东西）"
      @click="$emit('clear')"
    >取消选中</button>
    <span class="row-hint">Shift+点=多选 · Shift+拖动=框选一批</span>
  </div>
</template>

<script setup>
defineProps({
  /** 当前选中的河（父组件的 `selectedRiver`；本行只读它做文案） */
  selectedRiver: { type: Object, required: true },
  /** 批量选中的条数（父组件的 `riverSelIds().length`；> 1 时文案换成“整批”） */
  selCount: { type: Number, default: 0 },
});
defineEmits(['remove', 'edit', 'clip', 'clear']);
</script>
