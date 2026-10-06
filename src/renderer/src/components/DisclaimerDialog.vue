<template>
  <Dialog :open="props.open" @update:open="onOpenChange">
    <!-- 🔴 强制模式（gate）下：Esc 不关、点遮罩不关 —— 由 DialogContent 的
         dismissOnEscape / dismissOnOutsideClick 控制（reka-ui 的 DismissableLayer
         支持 preventDefault，见 DialogContent.vue 注释）。 -->
    <DialogContent
      class="w-[680px] overflow-hidden p-0"
      data-testid="disclaimer-dialog"
      :dismiss-on-escape="!isGate"
      :dismiss-on-outside-click="!isGate"
    >
      <DialogHeader class="gap-1 border-b border-solid border-border px-6 py-4">
        <DialogTitle class="flex items-center gap-2">
          <Icon name="shield" :size="16" />
          免责声明
        </DialogTitle>
        <DialogDescription>
          <span data-testid="disclaimer-version">版本 v{{ version }}</span>
          <span class="px-1.5 opacity-50">·</span>
          更新于 {{ updatedAt }}
          <template v-if="!isGate && ackedAt">
            <span class="px-1.5 opacity-50">·</span>
            你已于 {{ formatAckedAt }} 确认
          </template>
        </DialogDescription>
      </DialogHeader>

      <!-- 正文滚动容器：gate 模式下「滚到底」才解锁勾选框 -->
      <div
        ref="scrollEl"
        class="disclaimer-body min-h-0 flex-1 overflow-y-auto px-6 py-4"
        data-testid="disclaimer-scroll"
        @scroll="onScroll"
      >
        <!-- 短版：要点速览（首启读不完 13 节，但要给要点；全文在下面，必须读过） -->
        <Card class="mb-4 gap-2 bg-secondary p-3">
          <div class="mb-1 text-xs font-semibold text-foreground">要点速览</div>
          <ul class="m-0 list-none p-0">
            <li
              v-for="(t, i) in shortPoints"
              :key="i"
              class="relative py-1 pl-3.5 text-xs leading-relaxed text-muted-foreground"
            >
              <span class="absolute left-0 text-primary">•</span>
              <RichText :text="t" />
            </li>
          </ul>
        </Card>

        <!-- 完整版：13 节 -->
        <section
          v-for="sec in sections"
          :key="sec.n"
          class="mb-4"
          :data-testid="`disclaimer-section-${sec.n}`"
        >
          <h3 class="mb-2 border-b border-solid border-border pb-1 text-sm font-semibold text-foreground">
            {{ sec.n }}. {{ sec.title }}
          </h3>
          <template v-for="(b, bi) in sec.blocks" :key="bi">
            <p v-if="b.type === 'p'" class="mb-2 text-xs leading-relaxed text-muted-foreground">
              <RichText :text="b.text" />
            </p>
            <ul v-else-if="b.type === 'list'" class="mb-2 list-none p-0">
              <li
                v-for="(it, ii) in b.items"
                :key="ii"
                class="relative py-0.5 pl-4 text-xs leading-relaxed text-muted-foreground"
              >
                <span class="absolute left-0 text-primary">{{ b.ordered ? `${ii + 1}.` : '•' }}</span>
                <RichText :text="it" />
              </li>
            </ul>
            <p
              v-else-if="b.type === 'note'"
              class="mb-2 border-l-2 border-solid border-primary bg-secondary px-3 py-2 text-xs leading-relaxed text-muted-foreground"
            >
              <RichText :text="b.text" />
            </p>
          </template>
        </section>

        <p class="mb-0 py-2 text-center text-[11px] text-muted-foreground">
          — 以上为全部条款 —
        </p>
      </div>

      <DialogFooter class="items-center gap-3 border-t border-solid border-border bg-secondary px-6 py-4 sm:flex-row">
        <template v-if="isGate">
          <!-- 勾选框：未滚到底前 disabled -->
          <label
            class="mr-auto flex items-center gap-2 text-xs text-muted-foreground"
            :class="canAgree ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'"
          >
            <input
              v-model="agreed"
              type="checkbox"
              class="h-3.5 w-3.5 accent-[var(--ui-primary)]"
              :disabled="!canAgree"
              data-testid="disclaimer-ack-checkbox"
            />
            <span v-if="canAgree" data-testid="disclaimer-gate-hint">我已阅读并同意上述全部条款</span>
            <span v-else data-testid="disclaimer-gate-hint">
              请向下滚动阅读完整条款（已读 {{ readPercent }}%）
            </span>
          </label>

          <Button variant="outline" size="sm" data-testid="disclaimer-decline" @click="emits('decline')">
            不同意并退出
          </Button>
          <Button size="sm" :disabled="!agreed" data-testid="disclaimer-accept" @click="accept">
            同意并继续
          </Button>
        </template>

        <template v-else>
          <span class="mr-auto text-xs text-muted-foreground">
            条款更新后会再次提示确认
          </span>
          <Button size="sm" data-testid="disclaimer-close" @click="emits('update:open', false)">
            关闭
          </Button>
        </template>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup>
/**
 * DisclaimerDialog.vue —— 免责声明的**强制确认弹窗**（首次启动阻断） + **随时可查弹窗**。
 *
 * 两种模式（同一个组件，避免两份实现漂移）：
 *   · mode="gate"（首启阻断）：必须**滚到底**才能勾选；勾选后才能点「同意并继续」；
 *     另有「不同意并退出」。Esc 与点遮罩**都不关闭**（强制模式的证据力就在这里）。
 *   · mode="view"（关于面板查看）：无门槛，只给「关闭」，并显示你此前的确认时间。
 *
 * 🔴 为什么不按 §1.1 的「短版首启」字面做默认视图：
 *    「短版首启 + 滚到底才可勾选」是自相矛盾的 —— 短版一屏就能滚到底，
 *    等于「没读过全文也能点同意」，而勾选框存在的意义正是「同意是针对全文的同意」。
 *    因此这里的做法是**把短版（要点速览）嵌在全文最前面**：先给要点，再必须滚完 13 节。
 *    这样 §1.1-① 的「短版给要点」与 §1.1-③ 的「滚到底才可勾选」同时成立，不再冲突。
 *
 * 文案与组件分离：所有文字来自 utils/disclaimer.js，改字不动本文件。
 */
import { computed, ref, watch } from 'vue';
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from './ui/dialog';
import { Button } from './ui/button';
import { Card } from './ui/card';
import Icon from './Icon.vue';
import RichText from './RichText.vue';
import {
  DISCLAIMER_FULL, DISCLAIMER_SHORT, DISCLAIMER_VERSION, DISCLAIMER_UPDATED_AT,
  ackedDisclaimerAt,
} from '../utils/disclaimer';

const props = defineProps({
  open: { type: Boolean, default: false },
  /** 'gate' = 首启强制确认；'view' = 随时查看 */
  mode: { type: String, default: 'gate' },
});
const emits = defineEmits(['update:open', 'accept', 'decline']);

const version = DISCLAIMER_VERSION;
const updatedAt = DISCLAIMER_UPDATED_AT;
const sections = DISCLAIMER_FULL;
const shortPoints = DISCLAIMER_SHORT;

const isGate = computed(() => props.mode === 'gate');
const scrollEl = ref(null);
const scrolledToEnd = ref(false);
const agreed = ref(false);
const readPercent = ref(0);
const ackedAt = computed(() => (props.open ? ackedDisclaimerAt() : null));

const formatAckedAt = computed(() => {
  const raw = ackedAt.value;
  if (!raw) return '';
  const d = new Date(raw);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
});

/** 只有「读过全文」才算可同意；查看模式无门槛 */
const canAgree = computed(() => !isGate.value || scrolledToEnd.value);

function measure() {
  const el = scrollEl.value;
  if (!el) return;
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 4) {
    // 内容没有溢出（窗口极矮以外不会发生）：没有可滚动的内容，直接算读完
    readPercent.value = 100;
    scrolledToEnd.value = true;
    return;
  }
  const ratio = Math.min(1, Math.max(0, el.scrollTop / max));
  readPercent.value = Math.round(ratio * 100);
  if (ratio >= 0.995) scrolledToEnd.value = true;
}

function onScroll() {
  measure();
}

// 每次打开重置门槛：关掉再打开不该「还记得上次滚到底了」
watch(() => props.open, (v) => {
  if (!v) return;
  agreed.value = false;
  scrolledToEnd.value = false;
  readPercent.value = 0;
  // 等 DOM 就绪后再量一次（若内容未溢出则直接解锁）
  requestAnimationFrame(() => {
    if (scrollEl.value) scrollEl.value.scrollTop = 0;
    measure();
  });
});

function onOpenChange(v) {
  // gate 模式下不允许通过 update:open(false) 关闭（reka-ui 的 Esc/外点已被拦，这里是双保险）
  if (!v && isGate.value && !agreed.value) return;
  emits('update:open', v);
}

function accept() {
  if (!canAgree.value || (isGate.value && !agreed.value)) return;
  emits('accept', { at: new Date().toISOString() });
}
</script>

<style scoped>
/* 滚动条：司天全局没有自定义滚动条样式，这里只给本容器加一层细滚动条，
   不改全局（避免影响其它面板的观感）。 */
.disclaimer-body {
  scrollbar-width: thin;
}
.disclaimer-body::-webkit-scrollbar {
  width: 8px;
}
.disclaimer-body::-webkit-scrollbar-thumb {
  background: var(--separator);
  border-radius: 4px;
}
</style>
