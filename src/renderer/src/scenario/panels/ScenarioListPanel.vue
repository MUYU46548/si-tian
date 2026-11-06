<template>
  <!-- 左侧“历史剧本”列表（2026-11-06 从 ScenarioMap.vue 拆出，拆分第三批）
       为什么拆：76 行模板 + 约 200 行 `.scenario-list-panel/.slp-*` 样式只服务这一块。

       职责边界（与拆分前逐字同效）：
       · 只负责“列出当前剧本集的剧本 + 点一条 = 选时期”这个**显示层**；
         真正切剧本（切 era + 跳年份 + 同步时间轴）仍是父组件的 `selectScenarioAt`（点一条发 `select`）。
       · “换剧本”回卡片墙走 `picker`，父组件转发给 App。
       · “管理”只是把剧本管理对话框打开（`manage`），不再自己写数据。
       · 收起/展开（`open`）与“看全部”总览（`overview`）都是本组件的本地开关，
         用 `v-model` 让父组件仍能读它们（沉浸模式 / 测试要查）。 -->
  <div class="scenario-list-panel" :class="{ collapsed: !open }" data-testid="scenario-list-panel">
    <div class="slp-head">
      <span class="slp-title">历史剧本</span>
      <span class="slp-hint">选一条，地图切到该时期</span>
      <!-- 换剧本（P0-1，2026-10-17 第三轮）：此前从编辑器回卡片墙只能“返回世界”再点一次
           “历史剧本”（三步），而“返回”的语义是**离开剧本域**（去世界选择页），
           不该兼职"选另一个剧本"。这里给一条**一步回到卡片墙**的路。
           ⚠️ 放在 `.slp-head` 而不是工具栏主行：主行受 P3“恰好 6 个可见控件”闸门管
           （test_65/test_97），而"换剧本"属于剧本导航、与左侧剧本列表同族。 -->
      <button class="slp-picker" data-testid="slp-picker" title="回到剧本选择（卡片墙）换一个时期"
              @click="$emit('picker')">换剧本</button>
      <button class="slp-toggle" data-testid="slp-toggle"
              :title="open ? '收起列表（腾出画布）' : '展开剧本列表'"
              @click="open = !open">
        <Icon :name="open ? 'chevron-left' : 'chevron-right'" :size="13"/>{{ open ? ' 收起' : ' 展开' }}
      </button>
    </div>
    <!-- 剧本集切换（2026-10-25）：一组 = 一条独立时间线（同一张底图 + 连续年代）。
         不切换 = 不同底图/不同时间线的剧本混在一条年份轴上，断层与"上一剧本"语义都会乱。 -->
    <div v-if="open" class="slp-groupbar" data-testid="scenario-group-bar">
      <span class="slp-group-label">剧本集</span>
      <select
        class="slp-group-select"
        :value="activeGroupId"
        data-testid="scenario-group-switch"
        title="一组 = 一条独立时间线。切换后左栏、时间轴、播放与切片导出的“全部剧本”都只取这一组。"
        @change="$emit('switchGroup', $event.target.value)"
      >
        <option v-for="g in groups" :key="g.id" :value="g.id">
          {{ g.name }}（{{ groupCount(g.id) }}）
        </option>
      </select>
      <button class="slp-group-manage" data-testid="scenario-group-manage"
              title="新建 / 改名 / 删除剧本集，或把某条剧本移到别的组（不删任何剧本）"
              @click="$emit('manage')">管理</button>
      <!-- A3：看全部剧本集（只读总览）—— 别的时间线只能看、要改先切过去 -->
      <button class="slp-group-overview" :class="{ on: overview }" data-testid="scenario-group-overview"
              :title="overview ? '收起总览，只看当前剧本集' : '看全部剧本集：别的时间线只能看，要改先切过去'"
              @click="overview = !overview">{{ overview ? '收起' : '看全部' }}</button>
    </div>
    <template v-if="open">
      <ScenarioGroupOverview v-if="overview" :scenarios="scenarios"
                             :groups="scenarioGroups" :active-group-id="activeGroupId"
                             :selected-id="selectedId"
                             @select="$emit('select', $event)" @switch-group="$emit('switchGroup', $event)"
                             @msg="$emit('msg', $event)" />
      <template v-else>
        <div v-if="!shown.length" class="slp-empty" data-testid="slp-empty">
          还没有剧本 —— 点下方“新建 / 管理剧本…”创建第一个时期。<br />
          <b>一个剧本 = 一个时间点的版图快照</b>（谁占了哪些省）。<br />
          “涂归属”和上方的势力色板都挂在剧本上：没有剧本时它们不出现，不是坏了。
        </div>
        <div v-else class="slp-list">
          <div v-for="(s, i) in shown" :key="s.id"
               class="slp-item"
               :class="{ active: selectedId === s.id }"
               :data-testid="'scenario-list-item-' + i"
               :title="`切到“${s.name}”——地图跳到 ${s.era?.startYear || '?'} 年并同步时间轴`"
               @click="$emit('select', s)">
            <div class="slp-row1">
              <span class="slp-era">{{ s.era?.roman || '·' }}</span>
              <span class="slp-name">{{ s.name }}</span>
            </div>
            <div class="slp-row2">
              <span class="slp-years">{{ s.era?.startYear || '?' }} – {{ s.era?.endYear || '?' }}</span>
              <span class="slp-meta">{{ scenarioMeta(s) }}</span>
            </div>
          </div>
        </div>
      </template>
      <button class="slp-manage" data-testid="slp-manage"
              title="新建 / 编辑 / 删除剧本，以及管理当前剧本的地名与标记"
              @click="$emit('manage')">
        <Icon name="file-text" :size="13"/> 新建 / 管理剧本…
      </button>
    </template>
  </div>
</template>

<script setup>
import Icon from '../../components/Icon.vue';
import ScenarioGroupOverview from '../../components/ScenarioGroupOverview.vue';

defineProps({
  /** 剧本集选项 + 每组条数 */
  groups: { type: Array, default: () => [] },
  groupCount: { type: Function, default: () => 0 },
  activeGroupId: { type: String, default: '' },
  /** “看全部”总览用的全量（所有剧本集）与当前组过滤后的列表 */
  scenarios: { type: Array, default: () => [] },
  shown: { type: Array, default: () => [] },
  scenarioGroups: { type: Array, default: () => [] },
  selectedId: { type: String, default: '' },
  /** 每条剧本的第二行小字（父组件的 scenarioMeta） */
  scenarioMeta: { type: Function, default: () => '' },
});

const open = defineModel('open', { type: Boolean, default: true });
const overview = defineModel('overview', { type: Boolean, default: false });

defineEmits(['picker', 'select', 'switchGroup', 'manage', 'msg']);
</script>

<style scoped>
.scenario-list-panel {
  position: absolute;
  left: 10px;
  top: 10px;
  bottom: 10px;
  width: 236px;
  z-index: 6;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  background: rgba(23, 32, 51, 0.94);
  border: 1px solid #334155;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}

.scenario-list-panel.collapsed {
  width: 40px;
  bottom: auto;
  padding: 6px;
}

.scenario-list-panel.collapsed .slp-title,
.scenario-list-panel.collapsed .slp-hint,
.scenario-list-panel.collapsed .slp-picker {
  display: none;
}

.scenario-list-panel.collapsed .slp-head {
  padding: 0;
  border-bottom: 0;
  justify-content: center;
}

.slp-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 0 2px 6px;
  border-bottom: 1px solid #2b3a52;
}

.slp-title { color: #e2e8f0; font-size: 12px; font-weight: 600; }

.slp-hint { color: #64748b; font-size: 10px; flex: 1; }

.slp-toggle {
  background: transparent;
  border: 1px solid #475569;
  color: #94a3b8;
  border-radius: 4px;
  cursor: pointer;
  padding: 1px 4px;
  display: inline-flex;
  align-items: center;
}

.slp-toggle:hover { background: #334155; color: #e2e8f0; }

.slp-picker {
  background: #1e293b;
  border: 1px solid #475569;
  color: #cbd5e1;
  border-radius: 4px;
  cursor: pointer;
  padding: 1px 7px;
  font-size: 10px;
  font-family: inherit;
  white-space: nowrap;
}

.slp-picker:hover { background: #334155; color: #e2e8f0; border-color: #64748b; }

.slp-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; }

.slp-item {
  padding: 5px 7px;
  border: 1px solid #334155;
  border-radius: 6px;
  cursor: pointer;
  background: rgba(30, 41, 59, 0.6);
}

.slp-item:hover { background: #334155; border-color: #64748b; }

.slp-item.active { background: rgba(124, 58, 237, 0.22); border-color: #7c3aed; }

.slp-row1 { display: flex; align-items: baseline; gap: 5px; }

.slp-era { color: #94a3b8; font-size: 10px; min-width: 12px; }

.slp-name { color: #e2e8f0; font-size: 12px; }

.slp-item.active .slp-name { color: #fff; font-weight: 600; }

.slp-row2 { display: flex; align-items: baseline; gap: 6px; margin-top: 2px; }

.slp-years { color: #94a3b8; font-size: 10px; font-variant-numeric: tabular-nums; }

.slp-meta { color: #64748b; font-size: 10px; margin-left: auto; }

.slp-empty { color: #94a3b8; font-size: 11px; line-height: 1.7; padding: 6px 2px; }

.slp-empty b { color: #cbd5e1; }

.slp-manage {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  background: #1e293b;
  border: 1px solid #475569;
  color: #cbd5e1;
  border-radius: 6px;
  padding: 5px 8px;
  font-size: 11px;
  cursor: pointer;
  font-family: inherit;
}

.slp-manage:hover { background: #334155; }

.slp-groupbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 2px 6px;
  border-bottom: 1px solid #263449;
}

.slp-group-label { font-size: 10px; color: #94a3b8; flex: none; }

.slp-group-select {
  flex: 1 1 auto;
  min-width: 0;
  background: #1e293b;
  border: 1px solid #475569;
  color: #e2e8f0;
  border-radius: 5px;
  font-size: 11px;
  padding: 2px 4px;
  font-family: inherit;
}

.slp-group-manage {
  flex: none;
  background: #1e293b;
  border: 1px solid #475569;
  color: #cbd5e1;
  border-radius: 5px;
  padding: 2px 6px;
  font-size: 10.5px;
  cursor: pointer;
  font-family: inherit;
}

.slp-group-manage:hover { background: #334155; color: #e2e8f0; }

.slp-group-overview {
  flex: none;
  background: #1e293b;
  border: 1px solid #475569;
  color: #cbd5e1;
  border-radius: 5px;
  padding: 2px 6px;
  font-size: 10.5px;
  cursor: pointer;
  font-family: inherit;
}

.slp-group-overview:hover { background: #334155; color: #e2e8f0; }

.slp-group-overview.on {
  background: rgba(93, 151, 187, 0.28);
  border-color: rgba(93, 151, 187, 0.65);
  color: #dbeafe;
}
</style>
