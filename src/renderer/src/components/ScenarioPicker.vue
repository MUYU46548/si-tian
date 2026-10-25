<template>
  <!-- 🔴 Teleport 到 body（2026-10-17 暮雨二次实测「左侧导航树依旧盖不住」）：
       卡片墙即使改成 position:fixed，DOM 上仍在 `.main-content` 内 —— 而
       `.main-content > *` 的入场动画（view-fade-in）带 `transform`，
       **动画期间 transform 会把 fixed 的包含块从视口改写成 main-content**，
       于是露出的 0.28 秒里左侧导航树可见（用户看到的就是这个窗口期）。
       Teleport 把节点挪到 body 下，任何祖先动画/层叠都够不到它。 -->
  <Teleport to="body">
  <div class="scenario-picker" data-testid="scenario-picker">
    <div class="sp-bg"></div>
    <div class="sp-inner">
      <div class="sp-title">选择历史剧本</div>
      <!-- 搜索 / 筛选 / 计数：12 个剧本时一屏放不下，必须能找；也让人一眼看到“不是只显示了 4 个” -->
      <div v-if="cards.length" class="sp-toolbar">
        <div class="sp-search-wrap">
          <Icon name="search" :size="14" />
          <input v-model="query" class="sp-search" data-testid="sp-search"
                 placeholder="搜索剧本名 / 钩子 / 年代…" />
          <button v-if="query" class="sp-clear" data-testid="sp-clear" title="清空搜索"
                  @click="query = ''">×</button>
        </div>
        <select v-if="ownerOptions.length > 1" v-model="ownerFilter" class="sp-select" data-testid="sp-owner-filter">
          <option value="">全部底图</option>
          <option v-for="o in ownerOptions" :key="o.key" :value="o.key">{{ o.name }}</option>
        </select>
        <select v-model="sortBy" class="sp-select" data-testid="sp-sort">
          <option value="year">按起始年</option>
          <option value="name">按名称</option>
          <option value="owned">按控制疆土</option>
        </select>
        <label class="sp-only">
          <input type="checkbox" v-model="onlyOwned" /> 只看有开局归属
        </label>
        <span class="sp-count" data-testid="sp-count">共 {{ filteredCards.length }} / {{ cards.length }} 个剧本</span>
      </div>
      <!-- 全局烘焙进度（2026-10-17 暮雨实测「进入的时候有点卡（且没有任何加载提示）」，
           二测反馈「可能位置太奇怪，我的期望是正中间或中下部」）：
           做成屏幕**中下部**的浮动胶囊（fixed 定位，不随卡片排布移动）——
           骨架卡片先出来，缩略图逐张补齐，"在等什么、等到几"始终在视线正中下方。 -->
      <div v-if="bakeTotal > 0 && bakedIds.size < bakeTotal" class="sp-progress" data-testid="sp-progress">
        <span class="sp-progress-dot"></span>
        正在生成地图缩略图 {{ bakedIds.size }} / {{ bakeTotal }}…
      </div>

      <div v-if="!cards.length" class="sp-empty" data-testid="sp-empty">
        <!-- 空态分两种（P0-3，2026-10-17 第三轮）：**这个项目有没有底图**决定用户下一步做什么。
             旧实现只有一句「进入编辑器后新建剧本」—— 纯新项目里用户照做也建不出东西
             （省份/归属都画在底图上），于是"点了没反应"的观感又回来了。 -->
        <template v-if="!hasBaseMap">
          <div class="sp-empty-text" data-testid="sp-empty-nobasemap">这个项目还没有底图</div>
          <div class="sp-empty-sub">
            剧本画在底图上（省份 → 归属 → 时期）。<br />
            进编辑器后，<b>画布中央</b>会有「导入 .map 底图」按钮，选一份 Azgaar <b>.map</b> 即可；<br />
            也可以在那里点「新建空底图，自己画」。底图进来后回到这里就能建剧本了。
          </div>
          <div class="sp-empty-actions">
            <button class="sp-btn primary" data-testid="sp-empty-editor"
                    @click="$emit('edit', { openManager: false })">进入编辑器导入底图</button>
            <button class="sp-btn" data-testid="sp-empty-back" @click="$emit('exit')">返回世界</button>
          </div>
        </template>
        <template v-else>
          <div class="sp-empty-text">还没有剧本</div>
          <div class="sp-empty-sub">进入编辑器后，在「剧本管理」里新建第一条剧本</div>
          <button class="sp-btn primary" data-testid="sp-new" @click="$emit('edit', { openManager: true })">
            ＋ 新建剧本
          </button>
        </template>
      </div>

      <div v-else class="sp-cards" data-testid="sp-cards">
        <div v-if="!filteredCards.length" class="sp-no-match" data-testid="sp-no-match">没有匹配的剧本</div>
        <div v-for="c in filteredCards" :key="c.id"
             class="sp-card" :class="{ featured: c.featured }"
             :data-testid="'sp-card-' + c.testId"
             @click="$emit('edit', { scenarioId: c.id })">
          <div class="sp-thumb">
            <canvas :ref="(el) => regCanvas(c.id, el)" :width="baker.THUMB_W" :height="baker.THUMB_H"></canvas>
            <span v-if="!bakedIds.has(c.id) && c.hasMap" class="sp-baking">烘图中…</span>
            <span class="sp-roman">{{ c.roman || '·' }}</span>
            <span class="sp-years">{{ c.years }}</span>
          </div>
          <div class="sp-body">
            <div class="sp-name">{{ c.name }}</div>
            <div v-if="c.groupName && c.groupName !== '默认'" class="sp-group" :title="`剧本集：${c.groupName}`">剧本集 · {{ c.groupName }}</div>
            <div class="sp-hook">{{ c.hook }}</div>
            <div class="sp-situation">
              <div v-for="row in c.rows" :key="row.owner" class="sp-row">
                <span class="sp-sw" :style="{ background: row.color }"></span>
                <span class="sp-fname">{{ row.name }}</span>
                <span class="sp-pct">{{ Math.round(row.pct * 100) }}%</span>
              </div>
              <div v-if="c.top && !c.sitEmpty" class="sp-sum">
                开局：{{ c.top.name }} 控制 {{ Math.round(c.top.pct * 100) }}% 疆土 · 共 {{ c.total }} 省
              </div>
              <div v-else class="sp-sum">尚未指派开局归属</div>
            </div>
          </div>
        </div>
      </div>

      <div class="sp-foot">
        <button class="sp-btn primary" data-testid="sp-manage" @click="$emit('edit', { openManager: true })">
          进入编辑器
        </button>
        <button class="sp-btn" data-testid="sp-back" @click="$emit('exit')">返回世界</button>
      </div>
      <div class="sp-foot-hint">点一张卡片直接进入该剧本的起始年 · 「进入编辑器」打开地图编辑与剧本管理</div>
    </div>
  </div>
  </Teleport>
</template>

<script setup>
/**
 * ScenarioPicker.vue —— 剧本卡片墙（选剧本界面，2026-10-17 P0）。
 *
 * 形态依据 `docs/assets/scenario-picker-mockup.png`（暮雨拍板）：
 * 深空背景 + 一排卡片（缩略图 / 罗马数字 / 起止年 / 钩子文案 / 开局势力条）+ 底部两按钮。
 *
 * 🔴 三条口径：
 * ① **数据只读**：本组件不写 store —— 新建/编辑剧本在编辑器里做（那里有 undo 与写闸门）。
 * ② **缩略图逐张烘 + 帧让出**：`requestAnimationFrame` 之间烘一张（不是 setTimeout(0)——
 *    后者不保证插进渲染，进度会假卡，见底图铺底的让出方式教训）。
 *    命中成品位图缓存（`scenarioThumb` 模块级缓存）时**不让出**：那一步零绘制成本，
 *    全命中时卡片墙应当同一拍就完整。
 * ③ **跳过开关**：`window.__SKIP_SCENARIO_PICKER`（harness 注入）= 不经过本视图直达编辑器 ——
 *    保 30+ 个既有用例「点历史剧本 → ScenarioMap 挂载」的路径不变。
 * ④ **空态分流**（P0-3）：项目里有底图 → 引导建剧本；**没有底图** → 引导先导 .map
 *    （旧实现只有前者：纯新项目照做也建不出东西，"点了没反应"的观感又回来了）。
 */
import { ref, computed, onMounted, onUnmounted, nextTick, reactive } from 'vue';
import Icon from './Icon.vue';
import { useGeodataStore } from '../store/geodata.js';
import { buildTimeline } from '../utils/scenarioTimeline.js';
import { openingSituation, cardYearsText, cardHookText, provinceAreaIndex } from '../utils/scenarioCards.js';
import { scenarioGroupNameOf, scenarioGroupIdOf } from '../utils/scenarioGroups.js';
import { createThumbBaker } from '../utils/scenarioThumb.js';

const emit = defineEmits(['edit', 'exit']);
const store = useGeodataStore();
const baker = createThumbBaker();

/** 卡片数据 = 全部剧本（跨底图/跨剧本集），按起始年升序；每张卡记自己的底图 key、剧本集与组内下标 */
const cards = computed(() => {
  const all = store.scenarios || {};
  // 按「底图 + 剧本集」分组 buildTimeline：谱系/易主是**同一条时间线内**的语义。
  // 2026-10-25 起只按底图分组已经不够 —— 同一张底图上可以有多条互不相干的时间线，
  // 混在一起 buildTimeline 会让岁序、谱系继承、开局态势全部错位（且不报错）。
  const byGroup = new Map();
  for (const [id, s] of Object.entries(all)) {
    if (!s) continue;
    const ownerKey = s.ownerKey || '';
    const groupId = scenarioGroupIdOf(s);
    const key = ownerKey + '\u0000' + groupId;
    if (!byGroup.has(key)) byGroup.set(key, { ownerKey, groupId, list: [] });
    byGroup.get(key).list.push({ id, ...s });
  }
  const out = [];
  for (const { ownerKey, groupId, list } of byGroup.values()) {
    list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    // 🔴 传给 buildTimeline 的对象必须**带 id**，且下标对齐只能靠 id ——
    //    buildTimeline 内部还会 sortScenarios 再排一次（order 优先），与这里的排序
    //    未必一致 → 用 `list[k]` 对 `tl.scenarios[k]` 会错位到别的剧本（k 错 = 缩略图/态势全错）。
    const payload = list.map(({ id, ...s }) => ({ ...s, id }));
    const tl = buildTimeline(payload);
    // 🔴 面积索引**按底图算一次、该底图的每条剧本复用**（2026-10-17 第三轮，实测）：
    //    逐条剧本现算面积 = 同一份净面积被算 N 遍，400 省 × 10 剧本实测 597.7ms，
    //    是「第二次进卡片墙仍要 1 秒」的真凶（缩略图那时已全命中缓存）。
    //    ⚠️ 刻意**不跨渲染缓存**这份索引：几何改了就该重算，缓存只会换来"面积悄悄是旧的"。
    const terrain = store.baseMaps?.[ownerKey]?.terrain || [];
    const areaOf = provinceAreaIndex(terrain);
    tl.scenarios.forEach((sc) => {
      const id = sc.id;
      const baseMap = store.baseMaps?.[ownerKey] || null;
      const k = tl.scenarios.indexOf(sc);
      const sit = baseMap?.terrain?.length
        ? openingSituation(tl, k, baseMap.terrain, { areaOf }) : null;
      out.push({
        id, ownerKey, k, tl, groupId,
        testId: id.replace(/[^\w一-龥-]/g, '_').slice(-40),
        roman: sc.era?.roman || '',
        name: sc.name || id,
        groupName: scenarioGroupNameOf(store.scenarioGroups || [], sc.group),
        years: cardYearsText(sc),
        hook: cardHookText(sc) || (sc.description ? String(sc.description).slice(0, 60) : '（未写钩子文案）'),
        rows: (sit?.byPolity || []).slice(0, 4),
        top: sit?.top || null,
        total: sit?.total || 0,
        sitEmpty: !sit || sit.empty,
        featured: false,
        hasMap: !!baseMap,
      });
    });
  }
  out.sort((a, b) => (Number(a.years) || 0) - (Number(b.years) || 0));
  if (out.length) out[0].featured = true;
  return out;
});

// 搜索 / 筛选：卡片墙 12 条时一屏放不下；只做前端过滤，不改变底层剧本数据。
const query = ref('');
const onlyOwned = ref(false);
const ownerFilter = ref('');
const sortBy = ref('year');
const ownerOptions = computed(() => {
  const seen = new Map();
  for (const c of cards.value) {
    if (!seen.has(c.ownerKey)) {
      seen.set(c.ownerKey, store.baseMaps?.[c.ownerKey]?.name || c.ownerKey || '未命名底图');
    }
  }
  return [...seen].map(([key, name]) => ({ key, name }));
});
const filteredCards = computed(() => {
  const q = String(query.value || '').trim().toLowerCase();
  const list = cards.value.filter((c) => {
    if (ownerFilter.value && c.ownerKey !== ownerFilter.value) return false;
    if (onlyOwned.value && c.sitEmpty) return false;
    if (!q) return true;
    return `${c.name} ${c.hook} ${c.roman} ${c.years} ${c.groupName}`.toLowerCase().includes(q);
  });
  const out = list.slice();
  if (sortBy.value === 'name') out.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
  else if (sortBy.value === 'owned') out.sort((a, b) => (Number(b.total) || 0) - (Number(a.total) || 0));
  else out.sort((a, b) => (Number(a.years) || 0) - (Number(b.years) || 0));
  return out;
});

/* ---- 逐张烘缩略图（帧让出；组件卸载即停） ---- */
const canvasMap = new Map();   // cardId -> HTMLCanvasElement
// 🔴 已烘完的卡片 id 集合必须是**响应式**的（reactive Set）——
//    computed 返回的卡片对象是普通对象，直接改 `c.baking` 不触发重渲染，
//    「烘图中…」会永远挂着（本项目"改了没反应"的经典形态）。
const bakedIds = reactive(new Set());
/** 还需要烘图的卡片总数（全局进度条的分母；= 0 表示无需烘图，进度行不显示） */
const bakeTotal = computed(() => cards.value.filter((c) => c.hasMap).length);
/** 这个项目里有底图吗 —— 空态分流用（P0-3：没有底图时"去新建剧本"是条死路） */
const hasBaseMap = computed(() => Object.keys(store.baseMaps || {}).length > 0);
let dead = false;
let rafId = 0;

/** 模板内联 ref 回调：收元素进 map（computed 重算不丢——回调是每次渲染重建的） */
function regCanvas(id, el) {
  if (el) canvasMap.set(id, el);
  else canvasMap.delete(id);
}

async function bakeAll() {
  const list = cards.value;
  for (let i = 0; i < list.length; i++) {
    if (dead) return;
    const c = list[i];
    const cv = canvasMap.get(c.id);
    const baseMap = c.ownerKey ? store.baseMaps?.[c.ownerKey] : null;
    let cached = false;
    if (cv && baseMap) {
      try {
        // 高度图走唯一读取口（绑定了行星的底图 baseMap.heightmap 是空的）
        const hm = store.getHeightmapFor?.(c.ownerKey) || baseMap.heightmap || null;
        const r = baker.bake(cv, { baseMapKey: c.ownerKey, baseMap, heightmap: hm, tl: c.tl, k: c.k });
        cached = !!r?.cached;
      } catch (e) {
        console.warn('[ScenarioPicker] 缩略图烘焙失败', c.id, e);
      }
    }
    bakedIds.add(c.id);
    // 让出到下一帧（真让出渲染，不是定时器队列）。
    // 🔴 **命中成品缓存时不让出** —— 那种情况没有任何绘制成本（一次 drawImage），
    //    再逐张等 16ms 只会让"第二次进卡片墙"凭空慢 N 帧；全命中时应当同一拍就完整。
    if (!cached) await new Promise((res) => { rafId = requestAnimationFrame(res); });
  }
}

onMounted(() => { nextTick(() => { bakeAll(); }); });
onUnmounted(() => { dead = true; cancelAnimationFrame(rafId); });
</script>

<style scoped>
.scenario-picker {
  /* 🔴 fixed 不是 absolute（2026-10-17 暮雨实测：左下角露出 tree-navigation）——
     picker 原来是 `.main-content` 内的 absolute，而左侧导航树是 main-content 的**兄弟**节点，
     absolute 盖不住兄弟 → 卡片墙左边缘外露出世界选择页的导航栏。fixed 视口定位直接盖全屏。 */
  /* 🔴 2026-10-21 模块壳第二轮：顶栏现在**常驻**（模块页签要在卡片墙上也能点），
     所以卡片墙从顶栏下沿开始铺，不再压住它。51px = 当前 .toolbar 的实测高度。 */
  position: fixed; inset: 51px 0 0 0; z-index: 5000;
  display: flex; align-items: flex-start; justify-content: center;
  overflow: auto;
  padding: 24px 0;
  background: #0a0d13;
}
.sp-bg {
  /* 必须 fixed：picker 自身 overflow:auto，absolute 背景会跟着内容滚走，
     滚到底部就露出后面的左侧导航/“SiTian”标题（暮雨 2026-10-19 二次实测）。 */
  position: fixed; inset: 0;
  background: radial-gradient(1200px 500px at 50% -10%, #131a26 0%, #0a0d13 70%);
}
.sp-inner { position: relative; max-width: 1400px; width: 100%; padding: 30px 40px 40px; margin: 0 auto; }
.sp-title {
  text-align: center; color: #e6edf3; letter-spacing: 6px;
  font-size: 17px; font-weight: 600; margin: 6px 0 18px;
}
/* 搜索 / 筛选 / 计数（2026-10-19 暮雨实测：12 个剧本一屏放不下，且看不出到底有几个） */
.sp-toolbar {
  display: flex; align-items: center; justify-content: center; gap: 14px;
  flex-wrap: wrap; margin: 0 0 20px;
}
.sp-search-wrap {
  display: flex; align-items: center; gap: 7px;
  padding: 0 10px;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 7px;
  color: #8b949e;
}
.sp-search-wrap:focus-within { border-color: #58a6ff; }
.sp-search {
  width: min(300px, 52vw);
  padding: 7px 0;
  font-size: 12.5px;
  color: #e6edf3;
  background: transparent;
  border: none;
}
.sp-search:focus { outline: none; }
.sp-clear {
  border: none; background: transparent; color: #8b949e; cursor: pointer;
  font-size: 16px; line-height: 1; padding: 0 2px;
}
.sp-clear:hover { color: #e6edf3; }
.sp-select {
  padding: 7px 8px; font-size: 12px;
  color: #cbd5e1; background: #0d1117;
  border: 1px solid #30363d; border-radius: 7px;
}
.sp-only { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #9aa4b1; cursor: pointer; }
.sp-count { font-size: 12px; color: #8b949e; }
.sp-no-match { width: 100%; padding: 40px 0; text-align: center; color: #8b949e; font-size: 13px; }
.sp-progress {
  position: fixed; left: 50%; bottom: 12vh; transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px;
  background: rgba(22, 27, 34, 0.92); border: 1px solid #30363d;
  color: #8b949e; font-size: 12.5px; letter-spacing: 1px;
  padding: 8px 18px; border-radius: 18px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  z-index: 10;
}
.sp-progress-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #58a6ff; animation: sp-pulse 1s ease-in-out infinite;
}
@keyframes sp-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
.sp-cards { display: flex; gap: 26px; justify-content: center; flex-wrap: wrap; }
.sp-card {
  width: 340px; background: #161b22; border: 1px solid #30363d; border-radius: 10px;
  overflow: hidden; cursor: pointer; transition: transform .15s;
}
.sp-card:hover { transform: translateY(-4px); }
.sp-card.featured { border-color: rgba(212,167,44,0.55); box-shadow: 0 12px 32px rgba(0,0,0,.5); }
.sp-thumb { position: relative; height: 200px; background: #0d1117; }
.sp-thumb canvas { width: 100%; height: 100%; display: block; }
.sp-baking {
  position: absolute; inset: auto 0 8px 0; text-align: center;
  color: #7d8590; font-size: 11px; letter-spacing: 2px;
}
.sp-roman {
  position: absolute; top: 10px; left: 10px;
  background: rgba(10,13,19,.82); border: 1px solid #30363d; color: #d4a72c;
  font-size: 12px; letter-spacing: 2px; padding: 2px 10px; border-radius: 4px; font-weight: 600;
}
.sp-years {
  position: absolute; top: 10px; right: 10px;
  background: rgba(10,13,19,.82); border: 1px solid #30363d; color: #8b949e;
  font-size: 11px; padding: 2px 8px; border-radius: 4px; letter-spacing: 1px;
}
.sp-body { padding: 14px 18px 16px; }
.sp-name { color: #f0f3f6; font-size: 16px; font-weight: 600; letter-spacing: 1px; margin-bottom: 6px; }
.sp-group {
  display: inline-block; margin: 0 0 6px; padding: 1px 7px; border-radius: 999px;
  font-size: 10.5px; color: #c4b5fd; background: rgba(124, 58, 237, 0.18);
  border: 1px solid rgba(124, 58, 237, 0.55);
}
.sp-hook {
  color: #9aa4b1; font-size: 12.5px; line-height: 1.75; height: 44px; overflow: hidden;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; margin-bottom: 12px;
}
.sp-situation { border-top: 1px solid #21262d; padding-top: 10px; }
.sp-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.sp-sw { width: 22px; height: 10px; border-radius: 2px; }
.sp-fname { color: #8b949e; font-size: 11.5px; }
.sp-pct { color: #6e7681; font-size: 11px; margin-left: auto; }
.sp-sum { color: #7d8590; font-size: 11.5px; margin-top: 4px; }
.sp-foot { display: flex; justify-content: center; gap: 14px; margin-top: 26px; }
.sp-foot-hint { text-align: center; color: #484f58; font-size: 11.5px; margin-top: 10px; letter-spacing: 1px; }
.sp-btn {
  background: #21262d; border: 1px solid #30363d; color: #8b949e;
  font-size: 12.5px; padding: 7px 22px; border-radius: 6px; letter-spacing: 2px; cursor: pointer;
}
.sp-btn.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; letter-spacing: 3px; }
.sp-btn:hover { filter: brightness(1.15); }
.sp-empty { text-align: center; padding: 70px 0; }
.sp-empty-text { color: #e6edf3; font-size: 16px; letter-spacing: 2px; margin-bottom: 8px; }
.sp-empty-sub { color: #7d8590; font-size: 12.5px; line-height: 2; margin-bottom: 22px; }
.sp-empty-actions { display: flex; justify-content: center; gap: 14px; }
</style>
