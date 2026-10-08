// store/writeGate.js — 单一写闸门（Phase 2，用户决策 2026-09-18）
//
// 决策：默认事实源 = 「有项目文件用项目文件；无项目时回退 Obsidian」，
//       但**无项目状态下必须只读** —— 禁止一切落盘写操作（不写散文件、不写回 Obsidian）。
//
// ── 为什么是「单一闸门」而不是各处判断 ──────────────────────────────────────
// 世界观数据的落盘入口有 11 个（下表）。分散判断必漏，而且漏了**不会有任何报错**——
// 正是「你以为在只读浏览，其实已经写回知识库」的静默破坏形态。
// 所以：所有落盘路径统一过 `guardWrite()`，UI 侧统一读 `isReadOnly` 做灰禁。
//
// ── 落盘入口清单（新增任何落盘路径必须登记进本表 + 加 guard）──────────────
//   ⚠️ `scripts/tests/cases/test_47_write_mode.py` 会**读源码**校验本清单：
//      标记 guarded 的条目必须在对应文件里出现 `guardWrite(` / `isReadOnly`。
//      所以本表不是注释，是可执行的契约。
//
//   | # | 文件 | 落盘路径 | 状态 |
//   |---|------|---------|------|
//   | 1 | store/geodata.js | saveGeodata（节点/坐标/编辑器字段） | ✅ 已守 |
//   | 2 | store/geodata.js | saveScenarios（剧本） | ✅ 已守 |
//   | 3 | store/geodata.js | saveMapData（行星地图） | ✅ 已守 |
//   | 4 | store/geodata.js | reextractGeodata（重提取会整库重写 geodata.json） | ✅ 已守 |
//   | 5 | utils/labelStyles.js | setSitianConfig(label-presets) 写进库内 .sitian/config | ✅ 已守 |
//   | 6 | utils/markerTypes.js | setSitianConfig(marker-types) 同上 | ✅ 已守 |
//   | 7 | components/PlanetMap.vue | createObsidianNote（draft 转正 → 新建 .md） | ✅ 已守（右键项灰禁） |
//   | 8 | components/AreaMap.vue | createObsidianNote 同上 | ✅ 已守（按钮灰禁） |
//   | 9 | components/NodeDetailPanel.vue | createObsidianNote 同上 | ✅ 已守（按钮灰禁） |
//   | 10 | components/BatchImportPanel.vue | batchImportNotes（批量新建 .md） | ✅ 已守（按钮灰禁） |
//   | 11 | App.vue | clearCoordinateCache（删除 geodata/mapdata 缓存） | ✅ 已守（设置面板按钮灰禁） |
//
// 11 条全部已守（2.4 落地）：每条守卫都同时配了 UI 灰禁 + 原因说明——
// 只拦不灰禁＝用户点了按钮才得到一句拒绝，属于坏交互（见 skill 铁律：能力不减，入口要说明去处）。
//
// ── 三种模式 ────────────────────────────────────────────────────────────
//   'project'  已打开项目文件 → 允许写（写进项目文件）
//   'legacy'   无项目 + 兼容模式 → 允许写（沿用 Obsidian 缓存链路）
//   'readonly' 无项目 + 严格模式 → 拒绝一切落盘写（决策 1 的终态）
//
// ✅ 终态已落地：`READONLY_WITHOUT_PROJECT = true`（2026-09-20，决策 1 收尾）。
//    无项目 = 只读：画布仍可浏览知识库数据（事实源 'vault'），但任何落盘写都被 `guardWrite()`
//    拒绝，UI 入口同步灰禁 + 给出「新建或打开项目后即可继续编辑」的能力说明。
//    随之而来的两条纪律（都踩过或差点踩到）：
//      ① **项目文件的生命周期操作不受本闸门管辖** —— 新建 / 打开 / 保存 / 备份项目文件
//         是「项目文件写」，不是「世界观数据落盘写」。若把 ProjectPanel 的「新建」也灰禁，
//         就会形成死锁：没有项目 → 只读 → 禁新建 → 永远没有项目（第一个项目打不开）。
//      ② **回归基线必须跑在「已打开项目」状态** —— 45+ 个用例依赖落盘写。
//         harness 在每个用例前用当前知识库内容播种一个 mock 项目并打开（不落盘、零污染），
//         见 `scripts/tests/run_tests.py` 的 `open_harness_project()`。

import { ref, computed } from 'vue';

export const WRITE_MODES = ['project', 'legacy', 'readonly'];

/** 无项目时是否强制只读（决策 1 终态，2026-09-20 翻开）。 */
export const READONLY_WITHOUT_PROJECT = true;

export const WRITE_BLOCKED_HINT = '只读：未打开项目文件，编辑与保存已停用（新建或打开项目后即可继续编辑）';
export const READONLY_BADGE = '只读 · 未打开项目';

// ===== 落盘入口清单（见文件头表格；测试按本表读源码校验）=====
export const WRITE_CALLSITES = [
  { id: 1, file: 'src/renderer/src/store/geodata.js', marker: 'guardWrite(', what: 'saveGeodata', guarded: true },
  { id: 2, file: 'src/renderer/src/store/geodata.js', marker: 'guardWrite(', what: 'saveScenarios', guarded: true },
  { id: 3, file: 'src/renderer/src/store/geodata.js', marker: 'guardWrite(', what: 'saveMapData', guarded: true },
  { id: 4, file: 'src/renderer/src/store/geodata.js', marker: 'guardWrite(', what: 'reextractGeodata', guarded: true },
  { id: 5, file: 'src/renderer/src/utils/labelStyles.js', marker: 'guardWrite(', what: 'setSitianConfig(labelPresets)', guarded: true },
  { id: 6, file: 'src/renderer/src/utils/markerTypes.js', marker: 'guardWrite(', what: 'setSitianConfig(markerTypes)', guarded: true },
  { id: 7, file: 'src/renderer/src/components/PlanetMap.vue', marker: 'guardWrite(', what: 'createObsidianNote', guarded: true },
  { id: 8, file: 'src/renderer/src/components/AreaMap.vue', marker: 'guardWrite(', what: 'createObsidianNote', guarded: true },
  { id: 9, file: 'src/renderer/src/components/NodeDetailPanel.vue', marker: 'guardWrite(', what: 'createObsidianNote', guarded: true },
  { id: 10, file: 'src/renderer/src/components/BatchImportPanel.vue', marker: 'guardWrite(', what: 'batchImportNotes', guarded: true },
  { id: 11, file: 'src/renderer/src/App.vue', marker: 'guardWrite(', what: 'clearCoordinateCache', guarded: true },
];

// ===== 状态（模块级单例：与 store/undo.js 同模式）=====
const mode = ref(defaultModeWithoutProject());

function defaultModeWithoutProject() {
  return READONLY_WITHOUT_PROJECT ? 'readonly' : 'legacy';
}

export const writeMode = computed(() => mode.value);
export const isReadOnly = computed(() => mode.value === 'readonly');

const reason = ref('');
export const writeModeReason = computed(() => reason.value || defaultReason(mode.value));

function defaultReason(m) {
  if (m === 'project') return '已打开项目文件：编辑保存到项目文件';
  if (m === 'readonly') return WRITE_BLOCKED_HINT;
  return '未打开项目（兼容模式：编辑仍写入知识库缓存）';
}

/**
 * 设置写模式。
 * @param {'project'|'legacy'|'readonly'} next
 * @param {string} [why] 人类可读原因（显示在只读徽标 title 上）
 * @returns {{ ok: boolean, mode: string, error?: string }}
 */
export function setWriteMode(next, why = '') {
  if (!WRITE_MODES.includes(next)) {
    console.warn(`[writeGate] 未知写模式：${next}（忽略）`);
    return { ok: false, mode: mode.value, error: `未知写模式：${next}` };
  }
  mode.value = next;
  reason.value = why || '';
  return { ok: true, mode: next };
}

/** 回到「无项目」时的默认模式（项目关闭时调用） */
export function resetWriteMode(why = '') {
  return setWriteMode(defaultModeWithoutProject(), why);
}

/** 当前是否允许落盘写（不产生副作用，供 UI 判断） */
export function canWrite() {
  return mode.value !== 'readonly';
}

/**
 * 落盘写守卫 —— 所有世界观数据落盘路径的唯一入口。
 * @param {string} [action] 动作名（用于错误信息，如「保存地理数据」）
 * @returns {{ ok: true } | { ok: false, readOnly: true, error: string }}
 */
export function guardWrite(action = '写操作') {
  if (mode.value === 'readonly') {
    const error = `${action}被拒绝：${WRITE_BLOCKED_HINT}`;
    reportRejection(action, error);   // 拒绝必须有回音：绝不静默
    return { ok: false, readOnly: true, error };
  }
  return { ok: true };
}

// ── 内存编辑闸门（2026-09-21 补齐；2026-09-24 改为**函数级**契约）──────────────
// 「落盘写」之外还有一类写：**内存编辑**（画布上的笔刷 / 多边形 / 家具 / 剧本染色…）。
// 它们在只读态下曾经可以照改内存 —— 改动看起来生效（画布变了、列表多了），
// 但永远不会落盘 = 静默丢数据，比直接报错更坏。处置与落盘写一致：拒绝 + 提示去处。
//
// 🔴 **为什么必须按「函数」登记（2026-09-24 修，本文件最重要的变更）**：
//    旧清单是**文件级**的（条目里只写 `marker: 'guardWrite('`），测试只判
//    「这个文件里出现过 guardWrite(」—— 于是**一个文件里只要有一个守卫，整行就算通过**，
//    同文件里其余裸奔的写函数**永远查不出来**（漏报型假绿，比误报隐蔽得多）。
//    实测代价：`interior.js` 13 个函数只有 3 个有守卫、`mapDataEditing.js` 有 26 处
//    「先改内存后 execute」，全部隐形；`test_47`/`test_54` 却双双全绿。
//    现在条目登记到 `fns: [...]`，测试**截取每个函数体**后逐个断言。
//
// 清单只登记「**自己不守就会出事**」的两类函数：
//   ① 直接改世界观数据、不走 `execute()` 的裸写；
//   ② **先改内存、后 `execute()`** 的函数 —— 只守 execute 时，拒绝发生在数据已经改完之后。
// 靠 `execute()` 间接守卫的函数**不在此登记**（execute 本身是 id=1 条目）。
// ⚠️ 新增任何「直接改世界观数据」的函数，必须补 `guardWrite` + 登记到本表。
// ⚠️ 校验口径：函数体内出现 `guardWrite(` **或** `blocked(`（省份模块用 blocked() 统一包装）。
export const MEMORY_WRITE_CALLSITES = [
  { id: 1, file: 'src/renderer/src/store/undo.js',
    fns: ['execute'],
    what: '所有走 undo 栈的编辑（内存写总闸门）' },
  { id: 2, file: 'src/renderer/src/store/geodata.js',
    fns: ['updateNode', 'removeNode', 'updateNodePosition', 'toggleNodeLock', 'updateAllCoordinates', 'changeNodeId',
          'reextract'],
    what: '节点 CRUD / 坐标 / 锁定 / id 变更（先改内存后 execute → 必须守函数首行）+ 重新提取' },
  { id: 3, file: 'src/renderer/src/store/geodata.js',
    fns: ['selectBuilding'],
    what: '建筑内部容器懒建（只守懒建那一段；视图导航在只读态照常工作）' },
  { id: 4, file: 'src/renderer/src/store/geodataModules/interior.js',
    fns: ['addFloor', 'removeFloor', 'updateFloor', 'removeFurniture', 'updateFurniture',
          'updateInteriorReferenceImage', 'removeInteriorReferenceImage'],
    what: '楼层 / 家具 / 参考图' },
  { id: 5, file: 'src/renderer/src/store/geodataModules/areaEditing.js',
    fns: ['updateAreaReferenceImage', 'removeAreaReferenceImage'],
    what: '区域参考图' },
  { id: 6, file: 'src/renderer/src/store/geodataModules/mapDataEditing.js',
    fns: ['addTerrainPolygon', 'removeTerrainPolygon', 'updateControlPoint',
          'addRegion', 'removeRegion', 'updateRegion', 'updateTerrainPolygon',
          'addRoute', 'removeRoute', 'updateRoute',
          'addTextLabel', 'removeTextLabel', 'updateTextLabel',
          'addMarker', 'removeMarker', 'updateMarker', 'batchUpdateMapObjects',
          'updateReferenceImage', 'removeReferenceImageById', 'clearReferenceImage',
          'addMapSnapshot', 'removeMapSnapshot',
          'addCluster', 'removeCluster', 'updateCluster',
          'applyReliefStroke', 'ensureRivers', 'clearPlanetContent',
          'addChannelListItem', 'removeChannelListItem', 'updateChannelListItem'],
    what: '行星地图对象 CRUD / 参考图 / 快照 / 河流 / 文化·宗教列表 / 清空内容' },
  { id: 7, file: 'src/renderer/src/store/geodataModules/scenarioEditing.js',
    fns: ['importFromScenariosJson', 'importPlanetLayerData', 'applyHeightBrush', 'applyBiomeBrush',
          'applyCultureBrush', 'applyReligionBrush', 'deriveAllLayers',
          'createBaseMapHeightmap', 'bindBaseMapToPlanet', 'unbindBaseMap', 'importHeightmapFromPlanet',
          'addSlicePoint', 'renameSlicePoint', 'updateSlicePoint', 'removeSlicePoint',
          'addBaseMapBurg'],
    what: '剧本导入 + 涂抹笔刷 + 底图绑定/绑定迁移 + 切片点 + 聚落' },
  { id: 8, file: 'src/renderer/src/store/geodataModules/provinceEditing.js',
    fns: ['rebuildProvinceGrid', 'applyProvinceLasso', 'removeProvinceWithGrid', 'clearProvinceLabels',
          'applyProvinceStroke', 'fillProvinceRegion', 'splitProvince', 'mergeProvinces', 'addBrushProvince'],
    what: '省份网格写操作（统一经 blocked() 包装）' },
  { id: 9, file: 'src/renderer/src/store/geodataModules/channelBrush.js',
    fns: ['beginChannelStroke', 'endChannelStroke'],
    what: '高度图逐格通道笔刷（文化/宗教）：落笔（涂抹期就改内存数组）与抬手提交各一个守卫' },
];

// ── 拒绝回音（供 App.vue 提示用户「为什么点了没反应 / 改哪儿去了」）─────────
export const rejectionCount = ref(0);
export const lastRejection = ref(null); // { action, message, at }

function reportRejection(action, message) {
  rejectionCount.value += 1;
  lastRejection.value = { action, message, at: Date.now() };
}

/** 供测试/调试：清掉回音状态 */
export function clearRejection() {
  lastRejection.value = null;
}

// 调试/测试用：读取完整状态
export function describeWriteGate() {
  return { mode: mode.value, readOnly: isReadOnly.value, reason: writeModeReason.value, canWrite: canWrite() };
}
