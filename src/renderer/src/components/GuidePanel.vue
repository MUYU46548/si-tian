<template>
  <div v-if="isOpen" class="guide-overlay" @click.self="close" data-testid="guide-overlay">
    <div class="guide-panel" role="dialog" aria-modal="true" aria-label="司天使用手册">
      <header class="guide-header">
        <h2><Icon name="book" :size="18" style="margin-right:6px"/>使用手册</h2>
        <input
          v-model="q"
          class="guide-search"
          data-testid="guide-search"
          type="text"
          placeholder="搜一搜：铺底 / 快照 / 铺省 / 快捷键…"
          aria-label="搜索手册"
        />
        <button class="close-btn" title="关闭（Esc）" @click="close">×</button>
      </header>

      <div class="guide-body">
        <nav class="guide-toc" data-testid="guide-toc">
          <button
            v-for="s in filtered"
            :key="s.id"
            class="guide-toc-item"
            :class="{ active: s.id === currentId }"
            :data-testid="'guide-toc-' + s.id"
            @click="currentId = s.id"
          >{{ s.title }}</button>
          <p v-if="!filtered.length" class="guide-none" data-testid="guide-none">
            没有匹配「{{ q }}」的章节 —— 换个词试试（例如「省」「快照」「导出」）
          </p>
        </nav>

        <article v-if="currentSection" class="guide-content" data-testid="guide-content">
          <h3 data-testid="guide-title">{{ currentSection.title }}</h3>
          <template v-for="(b, i) in currentSection.blocks" :key="i">
            <p v-if="b.t === 'p'" class="g-p">{{ b.v }}</p>
            <ol v-else-if="b.t === 'steps'" class="g-steps">
              <li v-for="(x, j) in b.v" :key="j">{{ x }}</li>
            </ol>
            <ul v-else-if="b.t === 'list'" class="g-list">
              <li v-for="(x, j) in b.v" :key="j">{{ x }}</li>
            </ul>
            <div v-else-if="b.t === 'key'" class="g-keys">
              <div v-for="(pair, j) in b.v" :key="j" class="g-key-row">
                <kbd>{{ pair[0] }}</kbd><span>{{ pair[1] }}</span>
              </div>
            </div>
            <p v-else-if="b.t === 'warn'" class="g-warn">⚠️ {{ b.v }}</p>
            <p v-else-if="b.t === 'tip'" class="g-tip">💡 {{ b.v }}</p>
          </template>
          <p v-if="currentSection.cite" class="g-cite">出处：{{ currentSection.cite }}</p>
        </article>
      </div>

      <footer class="guide-footer">
        <span>共 {{ GUIDE_SECTIONS.length }} 节 · 右上角「?」或 F1 随时打开</span>
        <span v-if="q">筛出 {{ filtered.length }} 节</span>
      </footer>
    </div>
  </div>
</template>

<script setup>
/**
 * 组件：使用手册（应用内教程）
 *
 * 为什么会有这个文件（2026-10-11）：
 *   暮雨的原话 ——「右上角问号点进去是关于，司天内没有教程。我记得以前有（虽然很简陋没什么用）」
 *   「顺便告诉我我应该怎么测试，如何真正用起来？」。
 *   实情是：文档一直都在（`docs/SCENARIO_GUIDE.md` 写得比这里细得多），但**他只有 exe**，
 *   仓库里的 .md 对他等于不存在。「关于」面板里的"快速开始"停在五层视图时代，
 *   既没提项目文件，也没提省份/剧本 —— 这就是"很简陋没什么用"的来源。
 *
 * 三条纪律：
 *   ① 文案**只在** `utils/userGuide.js`（单一事实源）—— 组件零文案，改字不动组件
 *      （与 `utils/disclaimer.js` 同一套做法）；搜到的关键词也在那里。
 *   ② 内容必须是**可照做**的操作步骤，且每节带 `cite`（仓库内出处），
 *      免得手册慢慢长成一堆没人敢改的传闻。
 *   ③ 关闭路径要全：× / Esc / 点遮罩。Esc 走的是组件自己的 keydown（挂载时才注册），
 *      不与 App 的全局 Esc（关闭面板）抢 —— 见 onKey。
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import Icon from './Icon.vue';
import { GUIDE_SECTIONS, searchGuide } from '../utils/userGuide';

const isOpen = ref(false);
const q = ref('');
const currentId = ref(GUIDE_SECTIONS[0] ? GUIDE_SECTIONS[0].id : '');

const filtered = computed(() => searchGuide(q.value));
const currentSection = computed(() => {
  const list = filtered.value;
  if (!list.length) return null;
  return list.find((s) => s.id === currentId.value) || list[0];
});

// 搜索把当前章节筛掉了 → 自动落到第一条，避免右边空着而左边有内容
watch(filtered, (list) => {
  if (list.length && !list.some((s) => s.id === currentId.value)) currentId.value = list[0].id;
});

function open(sectionId = '') {
  isOpen.value = true;
  q.value = '';
  if (sectionId) currentId.value = sectionId;
}
function close() { isOpen.value = false; }

function onKey(e) {
  if (!isOpen.value) return;
  if (e.key === 'Escape') { e.stopPropagation(); close(); }
}

onMounted(() => window.addEventListener('keydown', onKey, true));
onUnmounted(() => window.removeEventListener('keydown', onKey, true));

defineExpose({ open, close, isOpen });
</script>

<style scoped>
/* 浅色卡面（与 ProjectPanel / 关于面板同族）：文字强调色必须用深色，
   浅色系在白底上对比度不够（本仓已踩过：1.4~1.6 对比度 = 看不见） */
.guide-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 950;
}
.guide-panel {
  width: min(980px, 94vw);
  height: min(720px, 90vh);
  display: flex;
  flex-direction: column;
  background: var(--planet-editor-bg, #fff);
  border: 1px solid var(--panel-border, #d5dbe3);
  border-radius: 12px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}
.guide-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--separator, #e3e8ef);
}
.guide-header h2 { font-size: 16px; margin: 0; color: #1c2b3a; display: flex; align-items: center; }
.guide-search {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  font-size: 13px;
  color: #1c2b3a;                 /* preflight 关闭 → 表单控件没有 color: inherit，必须显式设色 */
  background: #f6f8fb;
  border: 1px solid #d5dbe3;
  border-radius: 6px;
}
.guide-search:focus { outline: 2px solid #2f5fd0; outline-offset: -1px; }
.close-btn {
  width: 28px; height: 28px;
  font-size: 18px; line-height: 1;
  color: #4a5568; background: transparent;
  border: 1px solid transparent; border-radius: 6px; cursor: pointer;
}
.close-btn:hover { background: #eef2f7; border-color: #d5dbe3; }

.guide-body { flex: 1; display: flex; min-height: 0; }
.guide-toc {
  width: 240px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 8px;
  border-right: 1px solid var(--separator, #e3e8ef);
  background: #fafbfd;
}
.guide-toc-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 7px 9px;
  margin-bottom: 3px;
  font-size: 12.5px;
  color: #2b3a4a;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
}
.guide-toc-item:hover { background: #eef2f7; }
.guide-toc-item.active { background: #e6efff; border-color: #bcd2f7; color: #1c4fa1; font-weight: 600; }
.guide-none { font-size: 12px; color: #6b7785; line-height: 1.6; padding: 6px; }

.guide-content { flex: 1; overflow-y: auto; padding: 16px 22px 24px; }
.guide-content h3 { margin: 0 0 10px; font-size: 16px; color: #16222e; }
.g-p { font-size: 13px; line-height: 1.75; color: #2b3a4a; margin: 0 0 10px; }
.g-steps, .g-list { font-size: 13px; line-height: 1.75; color: #2b3a4a; margin: 0 0 12px; padding-left: 22px; }
.g-steps { list-style: decimal; }
.g-list { list-style: disc; }
.g-steps li, .g-list li { margin-bottom: 4px; }
.g-keys { margin: 4px 0 12px; display: flex; flex-direction: column; gap: 4px; }
.g-key-row { display: flex; align-items: baseline; gap: 10px; font-size: 12.5px; color: #2b3a4a; }
.g-key-row kbd {
  min-width: 62px;
  text-align: center;
  padding: 2px 6px;
  font-family: inherit;
  font-size: 12px;
  color: #16222e;
  background: #f2f5f9;
  border: 1px solid #cfd8e3;
  border-bottom-width: 2px;
  border-radius: 5px;
}
.g-warn, .g-tip {
  font-size: 12.5px; line-height: 1.7;
  margin: 0 0 12px; padding: 8px 10px; border-radius: 6px;
}
.g-warn { color: #8a1f14; background: #fdecea; border: 1px solid #f5c6c0; }
.g-tip { color: #14532d; background: #eaf7ee; border: 1px solid #bfe3cb; }
.g-cite { font-size: 11px; color: #8a95a1; margin: 18px 0 0; }

.guide-footer {
  display: flex; justify-content: space-between;
  padding: 8px 16px;
  font-size: 11px; color: #6b7785;
  border-top: 1px solid var(--separator, #e3e8ef);
  background: #fafbfd;
}
</style>
