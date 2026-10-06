<script setup>
/**
 * RichText.vue —— 极简行内富文本渲染（只支持 `**加粗**` 与 `` `代码` ``）。
 *
 * 为什么不直接 v-html：免责声明虽是自有静态文案，但一旦养成「往 v-html 里塞字符串」的习惯，
 * 迟早会有人把用户可控的文本传进来。这里按标记切分成 token 后由模板渲染，
 * **天然不产生 HTML 解析路径**，从根上免掉 XSS 面。
 *
 * 只做这两个标记：文案里真的只用到这两个，多一个语法多一处「写了不生效」的坑。
 */
import { computed } from 'vue';

const props = defineProps({ text: { type: String, default: '' } });

const parts = computed(() => {
  const src = String(props.text || '');
  const out = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ kind: 'text', t: src.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: 'bold', t: m[1] });
    else out.push({ kind: 'code', t: m[2] });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ kind: 'text', t: src.slice(last) });
  return out;
});
</script>

<template>
  <template v-for="(p, i) in parts" :key="i">
    <strong v-if="p.kind === 'bold'" class="font-semibold text-foreground">{{ p.t }}</strong>
    <code
      v-else-if="p.kind === 'code'"
      class="rounded-[3px] bg-secondary px-1 py-px font-mono text-[11px] text-foreground"
    >{{ p.t }}</code>
    <template v-else>{{ p.t }}</template>
  </template>
</template>
