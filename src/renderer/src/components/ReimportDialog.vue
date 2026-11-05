<template>
  <!-- 019 重导对话框（B3，2026-11-05 起可逐条裁决并省冲突）
       为什么单独成组件：ScenarioMap 有 ≤7,000 行闸门；而且这块全是“只显示与转发”，
       不该再往那个 7 千行文件里塞。判定（映射/冲突/裁决合不合法）都在纯函数与 store 里。 -->
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal-dialog rd" data-testid="reimport-dialog">
      <h3>重导底图为新底图</h3>
      <p class="rd-intro">
        这张底图已经改过（或来源未知），不能当“同一张图只补数据”。
        重导会新建一张底图，并把旧剧本的归属 / 易主迁过去；旧底图保留归档。
      </p>

      <div class="rd-grid">
        <span>旧底图</span><b>{{ state.preview.oldName }}</b>
        <span>新文件</span><b>{{ state.fileName || '（未命名）' }}</b>
        <span>省份</span><b>{{ state.preview.totalOld }} → {{ state.preview.totalNew }}</b>
        <span>按 id 直配</span><b>{{ state.preview.exact }} 省</b>
        <span>未映射</span>
        <b>旧 {{ state.preview.unmappedOld.length }} / 新 {{ state.preview.unmappedNew.length }}</b>
      </div>

      <!-- 并省冲突：以前只能整单放弃，现在逐条三选一 -->
      <div v-if="conflictRows.length" class="rd-warn" data-testid="reimport-conflicts">
        <strong>{{ conflictRows.length }} 处并省冲突</strong>（多个旧省并成了同一个新省）——
        每个都要选一次归属，否则不写入任何数据：
        <div v-for="c in conflictRows" :key="c.newId" class="rd-conflict" :data-testid="'reimport-conflict-' + c.newId">
          <div class="rd-conflict-head">
            新省“<b>{{ c.newName }}</b>” ← 旧省
            <span v-for="k in c.candidates" :key="k.id" class="rd-cand">
              {{ k.name }}<span v-if="ownersText(k)">（{{ ownersText(k) }}）</span>
            </span>
          </div>
          <select class="rd-choice" :value="state.conflictChoices[c.newId] || ''"
                  :data-testid="'reimport-choice-' + c.newId"
                  @change="onChoose(c.newId, $event.target.value)">
            <option value="">— 请选择 —</option>
            <option v-for="k in c.candidates" :key="k.id" :value="k.id">归属取“{{ k.name }}”</option>
            <option value="__merge__">合并（按旧省顺序，后者覆盖前者）</option>
            <option value="__drop__">都不要（这个新省无主）</option>
          </select>
        </div>
        <span v-if="unresolved.length" class="rd-pending" data-testid="reimport-pending">
          还有 {{ unresolved.length }} 处没选，重导按钮现在不可用。
        </span>
      </div>

      <div v-if="state.preview.unmappedOld.length" class="rd-warn" data-testid="reimport-unmapped">
        有 {{ state.preview.unmappedOld.length }} 个旧省没映射到新省；继续的话这些省的归属会丢：
        <code>{{ shownUnmapped.join(' / ') }}</code>
        <button v-if="state.preview.unmappedOld.length > 8" type="button" class="rd-more"
                @click="showAllUnmapped = !showAllUnmapped">
          {{ showAllUnmapped ? '收起' : `展开全部 ${state.preview.unmappedOld.length} 个` }}
        </button>
      </div>

      <label class="rd-check">
        <input type="checkbox" :checked="!!state.copyReferenceImages"
               @change="emit('toggle-reference')" />
        带上旧底图的参考图（默认不带；新 .map 通常有自己的地理）
      </label>

      <div class="rd-actions">
        <button @click="emit('close')">取消</button>
        <button class="primary" :disabled="!canApply"
                :data-testid="'reimport-apply'" @click="emit('apply')">
          {{ canApply ? '重导并迁移' : '还有冲突没选' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { unresolvedConflicts } from '../utils/basemapIdentity';

const props = defineProps({
  /** `reimportDialog` 那个对象：{ oldKey, fileName, preview, copyReferenceImages, conflictChoices } */
  state: { type: Object, required: true },
});
const emit = defineEmits(['apply', 'close', 'choose', 'toggle-reference']);

const showAllUnmapped = ref(false);

const conflictRows = computed(() => props.state.preview.conflictDetails
  || (props.state.preview.conflicts || []).map((c) => ({
    newId: c.newId, newName: c.newId,
    candidates: (c.oldIds || []).map((id) => ({ id, name: id, owners: [] })),
  })));

const unresolved = computed(() => unresolvedConflicts(props.state.preview, props.state.conflictChoices));
const canApply = computed(() => unresolved.value.length === 0);

const shownUnmapped = computed(() => {
  const names = props.state.preview.unmappedOldNames || props.state.preview.unmappedOld || [];
  return showAllUnmapped.value ? names : names.slice(0, 8);
});

/** 候选旧省在剧本里归谁（给“选哪个旧省”做判断依据；同一省可能在不同剧本里不同主） */
function ownersText(cand) {
  const owners = cand.owners || [];
  if (!owners.length) return '';
  const head = owners.slice(0, 2).map((o) => (o.scenario ? `${o.scenario}：${o.owner}` : o.owner));
  return head.join('、') + (owners.length > 2 ? ` 等 ${owners.length} 条` : '');
}

function onChoose(newId, value) {
  emit('choose', { newId, choice: value });
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 60;
}
.modal-dialog {
  background: #16202e;
  border: 1px solid #2f4157;
  border-radius: 10px;
  color: #dbe4ef;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
}
.rd {
  width: min(680px, 92vw);
  max-height: 86vh;
  overflow-y: auto;
  padding: 16px 18px;
}
.rd h3 { margin: 0 0 8px; font-size: 15px; }
.rd-intro { margin: 0 0 12px; font-size: 12px; line-height: 1.6; color: #9fb0c4; }
.rd-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 10px;
  font-size: 12px;
  margin-bottom: 12px;
}
.rd-grid span { color: #8fa3b8; }
.rd-warn {
  border: 1px solid rgba(216, 180, 106, 0.35);
  background: rgba(216, 180, 106, 0.08);
  border-radius: 7px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.55;
  margin-bottom: 10px;
}
.rd-conflict { margin-top: 8px; }
.rd-conflict-head { font-size: 12px; line-height: 1.6; }
.rd-cand { display: inline-block; margin-right: 8px; color: #cfd8e3; }
.rd-choice {
  margin-top: 4px;
  width: 100%;
  background: #1e293b;
  border: 1px solid #475569;
  color: #e2e8f0;
  border-radius: 5px;
  font-size: 12px;
  padding: 3px 5px;
  font-family: inherit;
}
.rd-pending { display: block; margin-top: 8px; color: #e8b93e; }
.rd-more {
  margin-left: 6px;
  font-size: 11px;
  background: transparent;
  border: 1px solid rgba(93, 151, 187, 0.5);
  color: #b9d7ea;
  border-radius: 4px;
  padding: 1px 6px;
  cursor: pointer;
}
.rd-check { display: flex; gap: 6px; align-items: center; font-size: 12px; color: #b9c7d6; }
.rd-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.rd-actions button {
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid #475569;
  background: #1e293b;
  color: #dbe4ef;
  cursor: pointer;
}
.rd-actions button.primary {
  border-color: rgba(93, 151, 187, 0.7);
  background: rgba(93, 151, 187, 0.25);
}
.rd-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
