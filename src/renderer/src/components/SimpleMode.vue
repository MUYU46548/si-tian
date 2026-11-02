<template>
  <!-- 简易模式（M3，N3b-2）：一个**不新增数据模型**的新手外壳。
       🔴 三条纪律（改这个文件之前先看）：
         ① 只调用**既有**能力：新建/打开项目 = projectStore（项目面板用的就是它）；
            底图 = store.addBaseMap / store.importFromScenariosJson / store.generateLandmass；
            画省份 / 导出 PNG = 交回剧本编辑器（那两个入口只在那儿）。
         ② 不碰持久化：本组件不写 localStorage、不调 window.sitianAPI、不新增 store 逻辑
            —— 零数据分叉（`unit/test_simple_mode_contract.js` 读源码守这一条）。
         ③ 状态只从 store 读，绝不预填"完成了"：做不到的步骤就灰禁 + 写出原因。 -->
  <div
    class="fixed inset-0 z-[6500] flex justify-center overflow-y-auto bg-slate-950/85"
    data-testid="simple-mode"
    role="dialog"
    aria-modal="true"
    aria-label="简易模式：四步画出第一张图"
  >
    <div class="w-full max-w-3xl px-4 py-6">
      <!-- ── 头部：一句承诺 + 回完整模式 ───────────────────────────────── -->
      <header class="rounded-xl border border-slate-700 bg-slate-900/95 p-5 shadow-2xl">
        <div class="flex flex-wrap items-start gap-3">
          <div class="min-w-0 flex-1">
            <h2 class="text-lg font-bold text-slate-100">简易模式 · 四步画出第一张图</h2>
            <p class="mt-1 text-xs leading-relaxed text-slate-400">
              这里只摆四件事，做完就有第一张地图。数据仍是同一个 <b class="text-slate-300">.sitian</b> 文件
              —— 切回完整模式不会丢任何东西，也不会多出第二份数据。
            </p>
          </div>
          <button
            class="shrink-0 rounded-lg border border-sky-400/60 bg-sky-500/15 px-3 py-2 text-sm font-semibold text-sky-200 hover:bg-sky-500/25"
            data-testid="simple-close"
            title="回完整编辑器（同一个项目文件，数据不变）"
            @click="emit('close')"
          >切换到完整模式</button>
        </div>

        <!-- 当前真实状态（一步一读 store；没有历史回执时显示汇总） -->
        <p
          class="mt-3 rounded-lg bg-slate-800/70 px-3 py-2 text-xs leading-relaxed text-slate-300"
          data-testid="simple-status"
          role="status"
        >{{ statusLine }}</p>

        <!-- 只读：说清原因，别让新手以为按钮坏了 -->
        <p
          v-if="readOnly"
          class="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200"
        >只读：{{ readOnlyReason }} —— 第②步「一键生成 / 导入 .map」与第③步「画省份」需要先有项目（第①步）。</p>
      </header>

      <!-- ── 第 ① 步：打开或新建项目 ─────────────────────────────────── -->
      <section
        class="mt-3 rounded-xl border border-slate-700 bg-slate-900/90 p-4"
        data-testid="simple-step-1"
      >
        <div class="flex items-start gap-3">
          <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-700 text-sm font-bold text-slate-100">1</span>
          <div class="min-w-0 flex-1">
            <h3 class="text-sm font-semibold text-slate-100">打开或新建项目</h3>
            <p class="mt-1 text-xs leading-relaxed text-slate-400">
              项目就是一个 .sitian 文件。没有打开项目时司天是只读的 —— 新建一个或打开已有的，后面三步才有东西可写。
            </p>
            <p class="mt-2 text-xs text-slate-300">
              <template v-if="projectName">
                已打开：<b class="text-sky-300">「{{ projectName }}」</b>
                <span class="text-slate-500">{{ projectFile ? `（${projectFile}）` : '（还没有落盘位置）' }}</span>
              </template>
              <template v-else>还没有打开项目</template>
            </p>
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <label class="text-xs text-slate-400">新项目名称</label>
              <input
                v-model="newName"
                type="text"
                class="w-44 rounded-md border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-100"
                placeholder="我的第一张地图"
                :disabled="!!busy"
              />
            </div>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <button
                class="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="simple-action-1"
                :disabled="!!busy"
                title="项目文件的新建 / 打开不受写闸门管辖（否则没有项目就永远建不了第一个项目）"
                @click="projectName ? openProjectNow() : createProjectNow()"
              >{{ projectName ? '打开另一个项目…' : '新建项目' }}</button>
              <button
                class="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                style="background:#1e293b;color:#e2e8f0;border:1px solid #475569"
                :disabled="!!busy"
                @click="projectName ? createProjectNow() : openProjectNow()"
              >{{ projectName ? '新建一个项目' : '打开已有项目…' }}</button>
            </div>
            <p v-if="busy === 'project'" class="mt-2 text-xs text-slate-400">正在处理项目文件…</p>
          </div>
        </div>
      </section>

      <!-- ── 第 ② 步：底图（导入 .map / 一键生成）───────────────────── -->
      <section
        class="mt-3 rounded-xl border border-slate-700 bg-slate-900/90 p-4"
        data-testid="simple-step-2"
      >
        <div class="flex items-start gap-3">
          <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-700 text-sm font-bold text-slate-100">2</span>
          <div class="min-w-0 flex-1">
            <h3 class="text-sm font-semibold text-slate-100">底图（导入 .map / 一键生成）</h3>
            <p class="mt-1 text-xs leading-relaxed text-slate-400">
              底图是省份落脚的那张纸。导入 Azgaar 导出的 .map 会一并带进地形、河流和已有省份；
              一键生成则从零造一块大陆并自动切成省份（一整次 = 一条 Ctrl+Z）。
            </p>
            <p class="mt-2 text-xs text-slate-300">
              共 <b class="text-sky-300">{{ baseMapKeys.length }}</b> 张底图<template v-if="activeKey">；当前「<b class="text-sky-300">{{ activeKey }}</b>」
                <template v-if="provinceCount > 0">已经有 {{ provinceCount }} 块省份</template>
                <template v-else>还没有省份</template></template><template v-else>；还没有底图</template>
            </p>
            <div v-if="baseMapKeys.length > 1" class="mt-2 flex flex-wrap items-center gap-2">
              <label class="text-xs text-slate-400">用哪一张</label>
              <select
                :value="activeKey"
                class="rounded-md border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-slate-100"
                :disabled="!!busy"
                @change="pickedKey = $event.target.value"
              >
                <option v-for="k in baseMapKeys" :key="k" :value="k">{{ k }}</option>
              </select>
            </div>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <button
                class="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="simple-action-2"
                :disabled="!canGenerate"
                :title="generateReason || '造一块大陆并自动切成省份'"
                @click="generateNow"
              >{{ provinceCount > 0 ? '一键生成（这张图已有省份 · 已停用）' : (activeKey ? '一键生成大陆与省份' : '新建底图并一键生成') }}</button>
              <button
                class="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                style="background:#1e293b;color:#e2e8f0;border:1px solid #475569"
                :disabled="!!busy || readOnly"
                :title="readOnly ? readOnlyReason : '选一份 Azgaar（FMG）导出的 .map'"
                @click="pickMapFile"
              >导入 .map 底图…</button>
              <input
                ref="fileInput"
                type="file"
                accept=".map"
                class="hidden"
                @change="handleMapFile"
              />
            </div>
            <p v-if="generateReason" class="mt-2 text-xs leading-relaxed text-amber-300/90">{{ generateReason }}</p>
            <p v-else-if="readOnly" class="mt-2 text-xs leading-relaxed text-amber-300/90">导入已停用：{{ readOnlyReason }}</p>
          </div>
        </div>
      </section>

      <!-- ── 第 ③ 步：画省份 ──────────────────────────────────────────── -->
      <section
        class="mt-3 rounded-xl border border-slate-700 bg-slate-900/90 p-4"
        data-testid="simple-step-3"
      >
        <div class="flex items-start gap-3">
          <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-700 text-sm font-bold text-slate-100">3</span>
          <div class="min-w-0 flex-1">
            <h3 class="text-sm font-semibold text-slate-100">画省份</h3>
            <p class="mt-1 text-xs leading-relaxed text-slate-400">
              省份只能在历史剧本编辑器里画（左侧工具栏的「画省份 / 批量铺底」），这里把你送到那个编辑器 ——
              工具与手感跟完整模式完全一样，一笔一条撤销。
            </p>
            <p class="mt-2 text-xs text-slate-300">
              <template v-if="provinceCount > 0">已有 <b class="text-sky-300">{{ provinceCount }}</b> 块省份（当前底图「{{ activeKey }}」）</template>
              <template v-else-if="activeKey">当前底图「{{ activeKey }}」还没有省份</template>
              <template v-else>还没有底图 —— 先做第②步</template>
            </p>
            <div class="mt-3">
              <button
                class="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="simple-action-3"
                :disabled="!canDraw"
                :title="drawReason || '进入历史剧本编辑器画省份'"
                @click="goDraw"
              >进入历史剧本编辑器</button>
            </div>
            <p v-if="drawReason" class="mt-2 text-xs leading-relaxed text-amber-300/90">{{ drawReason }}</p>
          </div>
        </div>
      </section>

      <!-- ── 第 ④ 步：导出图片 ────────────────────────────────────────── -->
      <section
        class="mt-3 rounded-xl border border-slate-700 bg-slate-900/90 p-4"
        data-testid="simple-step-4"
      >
        <div class="flex items-start gap-3">
          <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-700 text-sm font-bold text-slate-100">4</span>
          <div class="min-w-0 flex-1">
            <h3 class="text-sm font-semibold text-slate-100">导出图片</h3>
            <p class="mt-1 text-xs leading-relaxed text-slate-400">
              导出在剧本编辑器顶部工具栏的图片按钮上（导出当前剧本 / 年份为 PNG）。
              简易模式不另写一份导出，只把你送到那个按钮。
            </p>
            <p class="mt-2 text-xs text-slate-300">
              <template v-if="canExport">可以导出：{{ provinceCount }} 块省份 / {{ baseScenarios.length }} 段剧本</template>
              <template v-else>{{ exportReason }}</template>
            </p>
            <div class="mt-3">
              <button
                class="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="simple-action-4"
                :disabled="!canExport"
                :title="canExport ? '进入剧本编辑器并指到导出按钮' : exportReason"
                @click="goExport"
              >去导出 PNG</button>
            </div>
          </div>
        </div>
      </section>

      <p class="mt-4 px-1 text-[11px] leading-relaxed text-slate-500">
        简易模式不新增任何数据：省份、底图、剧本都写在原来的 .sitian 里，完整模式看到的就是这份。
      </p>
    </div>
  </div>
</template>

<script setup>
/**
 * SimpleMode.vue —— 简易模式（M3 / N3b-2）：「新手一小时画完第一张图」的外壳。
 *
 * 设计口径：
 *   · **零新增数据模型**：本组件不定义状态、不写持久化，只读 store 的真实状态 + 调既有写口；
 *   · **同一能力只一份实现**：能交给现有入口的就交（画省份、导出 PNG 在剧本编辑器里），
 *     绝不在这里复制几何 / 落库 / 导出逻辑；
 *   · 状态诚实：读不到就是读不到，做不到就灰禁并写出原因（不预填「已完成」）。
 *
 * 四个动作各自复用的既有入口（逐条列在这里，便于 review 与源码闸门对照）：
 *   ① 新建 / 打开项目 → `projectStore.createProject()` / `projectStore.openProject()`
 *      （ProjectPanel 的「新建」「打开项目…」调的就是这两个函数）。
 *   ② 一键生成 → `store.addBaseMap()` + `store.generateLandmass()`（LandmassPanel「应用」同一个 store 动作）；
 *      导入 .map → `utils/azgaar-parser.parseMapFile` + `buildScenariosJson`（**解析唯一实现**）
 *      → `store.importFromScenariosJson()`（**落库唯一写口**，ScenarioMap 的导入最后也调它）。
 *      同名底图的「只补缺 / 重导迁移」两条分支**只在** ScenarioMap.triggerMapImport 里，
 *      这里**不复制**：遇到同名一律拒绝并指向完整模式（不拿半条链去赌用户的数据）。
 *   ③ 画省份 → 交回剧本编辑器：emit('enter-scenario') → App 走 `switchModule('scenario')`
 *      （顶部「历史剧本」按钮同一条调用）。
 *   ④ 导出 PNG → 同上，只是 App 会额外把状态栏指向剧本工具栏的导出按钮
 *      （`useScenarioExport.exportScenarioPNG` 依赖 ScenarioMap 的 canvas/timeline，只能在那边跑）。
 */
import { computed, ref } from 'vue';
import { useGeodataStore } from '../store/geodata';
import { useProjectStore } from '../store/projectStore';
// .map 的解析与「拿到一份 .map 之后」的三件共用件：与 ScenarioMap / PlanetMap 同源，不另写一份
import { buildScenariosJson, parseMapFile } from '../utils/azgaar-parser';
import { backupMapSourceFile, mapNameFromFileName, readMapSourceText } from '../utils/mapImportSource';

const emit = defineEmits(['close', 'enter-scenario']);

const store = useGeodataStore();
// 项目 store 只允许组件（面板）连，App.vue 不直连 —— 本组件属于组件层，走法与 ProjectPanel 一致
const proj = useProjectStore();

/** 最近一次动作的**真实回执**（空 = 还没做过动作，显示汇总） */
const message = ref('');
/** '' | 'project' | 'import' | 'generate' —— 只用来禁按钮，不做假进度 */
const busy = ref('');
const newName = ref('我的第一张地图');
const fileInput = ref(null);
/** 简易模式自己挑的底图（只在本次打开期间有效；不写任何持久化偏好） */
const pickedKey = ref('');

const readOnly = computed(() => !!store.isReadOnly);
const readOnlyReason = computed(() => String(store.readOnlyReason || '只读：未打开项目'));

const projectName = computed(() => (
  proj.isOpen ? String((proj.meta && proj.meta.name) || '未命名项目') : ''
));
const projectFile = computed(() => {
  const p = String(proj.filePath || '');
  return p ? p.split(/[\\/]/).pop() : '';
});

const baseMapKeys = computed(() => Object.keys(store.baseMaps || {}));
/**
 * 简易模式盯的那张底图：用户选过就用它，否则用**最后创建的一张**。
 * ⚠️ 不读也不写 `setCurrentBaseMapKey`（那是完整模式的"开图偏好"，属落盘配置）——
 *    零数据分叉的第一条就是：简易模式不新增任何持久化状态。
 */
const activeKey = computed(() => {
  const keys = baseMapKeys.value;
  if (pickedKey.value && keys.includes(pickedKey.value)) return pickedKey.value;
  return keys.length ? keys[keys.length - 1] : '';
});
const activeBaseMap = computed(() => (activeKey.value ? (store.baseMaps || {})[activeKey.value] : null));
const provinceCount = computed(() => {
  const t = activeBaseMap.value && activeBaseMap.value.terrain;
  return Array.isArray(t) ? t.length : 0;
});
/** 当前底图名下的剧本（导出 PNG 要求这两样都有：省份 + 至少一段剧本） */
const baseScenarios = computed(() => {
  const all = store.scenarios || {};
  const key = activeKey.value;
  if (!key) return [];
  return Object.keys(all).filter((id) => all[id] && all[id].ownerKey === key);
});

const canGenerate = computed(() => !readOnly.value && !busy.value && provinceCount.value === 0);
const generateReason = computed(() => {
  if (readOnly.value) return readOnlyReason.value;
  if (busy.value) return '正在处理，请稍等…';
  if (provinceCount.value > 0) {
    return `这张底图已经有 ${provinceCount.value} 块省份 —— 一键生成会整张替换（连同归属键）。`
      + '简易模式不提供"重生成"；要重来请到完整模式的「造陆」面板（那儿会先给你看候选，再问你确认）。';
  }
  return '';
});

const canDraw = computed(() => !!activeKey.value && !readOnly.value && !busy.value);
const drawReason = computed(() => {
  if (readOnly.value) return readOnlyReason.value;
  if (busy.value) return '正在处理上一件事，请稍等…';
  if (!activeKey.value) return '还没有底图 —— 先在第②步生成或导入一张。';
  return '';
});

const canExport = computed(() => (
  !busy.value && !!activeKey.value && provinceCount.value > 0 && baseScenarios.value.length > 0
));
const exportReason = computed(() => {
  if (busy.value) return '正在处理上一件事，请稍等…';
  if (!activeKey.value) return '还没有底图 —— 先做第②步。';
  if (provinceCount.value === 0) return '这张底图还没有省份 —— 先在第③步画省份。';
  if (baseScenarios.value.length === 0) return '这张底图还没有剧本 —— 进历史剧本编辑器新建一段，才有可导出的年份。';
  return '';
});

/** 没有回执时的汇总（全部来自 store 的真实值） */
const summary = computed(() => {
  const which = projectName.value ? `「${projectName.value}」` : '未打开项目';
  return `当前：${which} · ${baseMapKeys.value.length} 张底图 · ${provinceCount.value} 块省份 · ${baseScenarios.value.length} 段剧本`;
});
const statusLine = computed(() => message.value || summary.value);

// ===== 第 ① 步：项目文件的生命周期（不受写闸门管辖，只读态也能做）=====
/**
 * 切走之前先把当前项目的改动落盘（数据安全优先于手感）。
 *
 * `projectStore.flushSave()` 是「把还没落盘的改动立刻写完」的唯一入口（退出 / 关项目也用它）。
 * 保存失败就**不切**：切换会把内存里的改动丢掉，而新手最可能就是在这个入口连点两下。
 */
async function flushBeforeSwitch() {
  if (!proj.isOpen) return { ok: true };
  const r = await proj.flushSave();
  if (r && r.success) return { ok: true };
  return { ok: false, error: (r && (r.error || r.reason)) || '未知原因' };
}

async function createProjectNow() {
  if (busy.value) return;
  busy.value = 'project';
  message.value = '正在新建项目…';
  try {
    const flushed = await flushBeforeSwitch();
    if (!flushed.ok) {
      message.value = `没有切换项目：当前项目还有未保存的改动，且保存失败（${flushed.error}）—— 数据仍在内存里`;
      return;
    }
    const res = await proj.createProject({ name: String(newName.value || '').trim() || '未命名项目' });
    if (res && res.success) {
      const problems = Array.isArray(res.problems) ? res.problems.filter(Boolean) : [];
      message.value = `已新建项目「${projectName.value}」`
        + (projectFile.value ? `（${projectFile.value}）` : '')
        + ' —— 下面三步可以开始了'
        + (problems.length ? ` ⚠️ ${problems.join('；')}` : '');
    } else {
      message.value = `新建失败：${(res && res.error) || '未知原因'}`;
    }
  } catch (err) {
    message.value = `新建失败：${(err && err.message) || err}`;
  } finally {
    busy.value = '';
  }
}

async function openProjectNow() {
  if (busy.value) return;
  busy.value = 'project';
  message.value = '正在打开项目…';
  try {
    const flushed = await flushBeforeSwitch();
    if (!flushed.ok) {
      message.value = `没有切换项目：当前项目还有未保存的改动，且保存失败（${flushed.error}）—— 数据仍在内存里`;
      return;
    }
    const res = await proj.openProject();
    if (res && res.success) {
      message.value = `已打开「${projectName.value}」`
        + (projectFile.value ? `（${projectFile.value}）` : '')
        + ' —— 数据就是原来那份，没有复制';
    } else if (res && res.canceled) {
      message.value = '已取消打开项目（当前项目没有变化）';
    } else {
      message.value = `打开失败：${(res && res.error) || '未知原因'}`;
    }
  } catch (err) {
    message.value = `打开失败：${(err && err.message) || err}`;
  } finally {
    busy.value = '';
  }
}

// ===== 第 ② 步：底图 =====
/**
 * 空底图的键名。
 * 完整模式里空底图叫「底图 N」（`ScenarioMap.nextBaseMapName`，那是它的 UI 逻辑）。
 * 简易模式**不复制**那条命名，用项目名派生一个不重名的键（只影响这一张新底图叫什么），
 * 避免和完整模式抢「底图 N」的编号。
 */
function newBaseMapKey() {
  const base = `${projectName.value || '我的'} 底图`;
  let key = base;
  let i = 2;
  while (store.baseMaps && store.baseMaps[key]) {
    key = `${base} ${i}`;
    i += 1;
  }
  return key;
}

async function generateNow() {
  if (!canGenerate.value) return;
  busy.value = 'generate';
  message.value = '正在生成大陆与省份…';
  try {
    let key = activeKey.value;
    if (!key) {
      key = newBaseMapKey();
      // 🔴 addBaseMap 自己不带闸门（ScenarioMap.createEmptyBaseMap 也是先判只读再调它）——
      //    canGenerate 已经在只读态把按钮灰禁，这里再挡一次，绝不绕过写闸门。
      if (readOnly.value) { message.value = readOnlyReason.value; return; }
      store.addBaseMap(key, { name: key });
      if (!store.baseMaps || !store.baseMaps[key]) {
        message.value = '底图没有建出来（请看右上角的保存提示）';
        return;
      }
      pickedKey.value = key;
    }
    // 造陆 + 铺底切省：store 的既有动作，LandmassPanel 的「应用」调的是同一个函数
    const r = await store.generateLandmass(key, {}, {
      onProgress: (p) => { message.value = (p && p.message) || '正在生成…'; },
    });
    if (!r || r.ok === false) {
      message.value = `生成没有完成：${(r && (r.message || r.rejected)) || '未知原因'}`;
      return;
    }
    message.value = `${r.message || `已生成 ${provinceCount.value} 块省份`} —— 数据已经在这张底图里`;
  } catch (err) {
    message.value = `生成失败：${(err && err.message) || err}`;
  } finally {
    busy.value = '';
  }
}

function pickMapFile() {
  if (readOnly.value || busy.value) return;
  fileInput.value?.click();
}

/**
 * 拿到一份 .map → 装进当前项目。
 * 解析 / 组装复用 `utils/azgaar-parser.js`（唯一解析实现），落库复用
 * `store.importFromScenariosJson`（唯一写口）。**同名底图不在这里处理**：
 * 「只补缺 / 重导迁移」只在 ScenarioMap.triggerMapImport 里，仿一份必然静默分叉。
 */
async function handleMapFile(event) {
  const input = event && event.target;
  const file = input && input.files ? input.files[0] : null;
  if (input) input.value = '';   // 允许再次选同一个文件
  if (!file || busy.value) return;
  busy.value = 'import';
  message.value = `正在解析「${file.name}」…`;
  try {
    const text = await readMapSourceText(file);
    // 先留底（在任何解析/写入之前）—— 解析失败也该留下这份素材，与剧本侧同一顺序
    const srcNote = await backupMapSourceFile(file.name, text);
    let parsed;
    try {
      parsed = parseMapFile(text);
    } catch (err) {
      message.value = `解析失败：${(err && err.message) || err}（文件可能不是 Azgaar 导出的 .map）${srcNote}`;
      return;
    }
    const name = mapNameFromFileName(file.name) || '导入的底图';
    if (store.baseMaps && store.baseMaps[name]) {
      message.value = `「${name}」这张底图已经存在 —— 简易模式不重导，免得盖掉你已经切好的省份。`
        + '请到完整模式的剧本工具栏点「+ 导入 .map 底图」：那边会先给你看映射与冲突，再决定只补数据还是重导。'
        + srcNote;
      return;
    }
    const json = buildScenariosJson(parsed, name, '当前');
    const r = store.importFromScenariosJson(json);
    if (!r || r.ok === false) {
      message.value = `导入没有完成：${(r && (r.error || r.message)) || (readOnly.value ? readOnlyReason.value : '未知原因')}${srcNote}`;
      return;
    }
    pickedKey.value = name;
    message.value = `已导入「${name}」：` + `共 ${baseMapKeys.value.length} 张底图，当前这张 ${provinceCount.value} 块省份${srcNote}`;
  } catch (err) {
    message.value = `导入失败：${(err && err.message) || err}`;
  } finally {
    busy.value = '';
  }
}

// ===== 第 ③ / ④ 步：交给剧本编辑器（那两个入口只在那边）=====
function goDraw() {
  if (!canDraw.value) return;
  emit('enter-scenario', { intent: 'draw', baseMapKey: activeKey.value });
}

function goExport() {
  if (!canExport.value) return;
  emit('enter-scenario', { intent: 'export', baseMapKey: activeKey.value });
}
</script>
