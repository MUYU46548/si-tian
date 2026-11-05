<template>
  <!-- 跨剧本集“只读总览”（A3，2026-11-05）
       为什么需要：剧本集 = 一条独立时间线，左栏/时间轴/切片只取当前组 —— 于是**看不见别的时间线**。
       这里把全部剧本按组列出来：能看（年代 + 规模），别组**点不改**（只读），
       要编辑就点组名那一行的“切到这一组”（明确动作，不会悄悄换掉当前编辑目标）。 -->
  <div class="sgo" data-testid="scenario-overview">
    <div class="sgo-tip">全部剧本集（只读）：别的时间线只能看，要改先切过去</div>
    <div v-for="row in rows" :key="row.id" class="sgo-group" :class="{ active: row.isActive }">
      <div class="sgo-head">
        <span class="sgo-name" :title="row.name">{{ row.name }}</span>
        <span class="sgo-count">{{ row.scenarios.length }} 本</span>
        <span v-if="row.isActive" class="sgo-cur">当前</span>
        <button v-else type="button" class="sgo-go"
                :data-testid="'scenario-overview-switch-' + row.id"
                :title="`切到“${row.name}”这条时间线（切过去之后就能编辑）`"
                @click="emit('switch-group', row.id)">切到这一组</button>
      </div>
      <button v-for="(s, si) in row.scenarios" :key="s.id" type="button" class="sgo-item"
              :class="{ sel: s.id === selectedId, ro: s.readonly }"
              :data-testid="'scenario-overview-item-' + row.id + '-' + si"
              :title="s.readonly ? `只读：这是“${row.name}”里的剧本，切到那一组才能改` : `切到“${s.name}”`"
              @click="onClick(row, s)">
        <span class="sgo-era">{{ s.era?.roman || '·' }}</span>
        <span class="sgo-title">{{ s.name }}</span>
        <span class="sgo-yrs">{{ s.era?.startYear || '?' }}–{{ s.era?.endYear || '?' }}</span>
        <span v-if="s.readonly" class="sgo-ro">只读</span>
      </button>
    </div>
    <div v-if="!rows.length" class="sgo-empty">这张底图下还没有剧本。</div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { scenarioOverviewRows } from '../utils/scenarioGroups';

const props = defineProps({
  /** 全部剧本（同一张底图下、已按 order 排好） */
  scenarios: { type: Array, default: () => [] },
  /** 项目级剧本集表 */
  groups: { type: Array, default: () => [] },
  /** 当前组（时间轴/播放/切片只取它） */
  activeGroupId: { type: String, default: '' },
  /** 当前选中的剧本 id（只用来高亮） */
  selectedId: { type: String, default: '' },
});
const emit = defineEmits(['select', 'switch-group', 'msg']);

const rows = computed(() => scenarioOverviewRows(props.scenarios, props.groups, props.activeGroupId));

/** 点条目：当前组 = 真的切过去；别组 = **只读**，只给一句可读回执（不改任何状态） */
function onClick(row, s) {
  if (!s.readonly) {
    emit('select', s);
    return;
  }
  emit('msg', `“${s.name}”在剧本集“${row.name}”里（只读总览）—— 点那一行的“切到这一组”才能打开它编辑`);
}
</script>

<style scoped>
.sgo {
  padding: 6px 8px 4px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 46vh;
  overflow-y: auto;
}
.sgo-tip {
  font-size: 11px;
  color: #8b97a5;
  line-height: 1.4;
  padding: 0 2px 2px;
}
.sgo-group {
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  padding: 4px 5px 5px;
  background: rgba(255, 255, 255, 0.02);
}
.sgo-group.active { border-color: rgba(93, 151, 187, 0.45); }
.sgo-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 1px 2px 4px;
}
.sgo-name {
  font-size: 12px;
  font-weight: 600;
  color: #cfd8e3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
  min-width: 0;
}
.sgo-count { font-size: 11px; color: #8b97a5; flex: 0 0 auto; }
.sgo-cur { font-size: 11px; color: #7fc4a0; flex: 0 0 auto; }
.sgo-go {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid rgba(93, 151, 187, 0.55);
  background: rgba(93, 151, 187, 0.14);
  color: #b9d7ea;
  cursor: pointer;
  flex: 0 0 auto;
}
.sgo-go:hover { background: rgba(93, 151, 187, 0.26); }
.sgo-item {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 3px 5px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #cfd8e3;
  cursor: pointer;
  text-align: left;
  font-size: 12px;
}
.sgo-item:hover { background: rgba(255, 255, 255, 0.06); }
.sgo-item.sel { background: rgba(93, 151, 187, 0.22); }
.sgo-item.ro { cursor: default; color: #a9b4c0; }
.sgo-era { flex: 0 0 auto; color: #8b97a5; font-size: 11px; min-width: 14px; }
.sgo-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sgo-yrs { flex: 0 0 auto; color: #8b97a5; font-size: 11px; }
.sgo-ro {
  flex: 0 0 auto;
  font-size: 10px;
  color: #d8b46a;
  border: 1px solid rgba(216, 180, 106, 0.4);
  border-radius: 3px;
  padding: 0 3px;
}
.sgo-empty { font-size: 12px; color: #8b97a5; padding: 4px; }
</style>
