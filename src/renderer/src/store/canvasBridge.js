// store/canvasBridge.js — 画布（geodata）与项目文件（projectStore）之间的**唯一接线点**（Phase 2.4）
//
// 为什么需要这一层：
//   七层视图 / 所有编辑器都只认 `store/geodata.js` 的工作内存（nodes / hyperlanes / mapData / scenarios）。
//   「有项目用项目文件、无项目回退知识库」这套决策如果让两个 store 互相 import，会形成循环依赖
//   （geodata ← 保存去向 → projectStore ← 打开时装载 → geodata），也容易演成两套事实源。
//   所以两边都只依赖本模块的**注册表**：
//     · geodata 在 store setup 时 `setCanvasAdapter({ applyProject, releaseProject, exportCanvas })`
//     · projectStore 在「打开 / 保存 / 关闭」项目时 `getCanvasAdapter()` 调用它
//   依赖方向：geodata → canvasBridge ← projectStore，无环。
//
// 纪律：本模块不持有世界观数据，只做转发；不要在别处再实现第二套 switch 逻辑。

let adapter = null;      // 画布侧（geodata 注册）：被项目侧调用来切换/装载/同步画布
let sink = null;         // 项目侧（projectStore 注册）：被画布侧调用来把画布状态落进项目

/** 由 projectStore 在 setup 时注册（画布 → 项目的唯一入口） */
export function setProjectSink(next) {
  sink = next || null;
  return sink;
}

/** 取项目侧入水口（未注册 → 说明 projectStore 还没装载，画布保存应退化为"未接线"提示） */
export function getProjectSink() {
  return sink;
}

/** 由 geodata store 在 setup 时注册（重复注册覆盖旧的，便于 HMR） */
export function setCanvasAdapter(next) {
  adapter = next || null;
  return adapter;
}

/** 取当前适配器（未注册时返回 null，调用方必须判空 —— Node/纯逻辑环境下没有画布） */
export function getCanvasAdapter() {
  return adapter;
}

/** 画布是否已切到项目文件（无适配器/未接线时恒为 false） */
export function canvasSource() {
  return adapter && typeof adapter.source === 'function' ? adapter.source() : 'vault';
}

// ── 第三条注册口（2026-09-21）：面板 → 画布的「聚焦某实体」请求 ───────────────
// 背景：项目面板/实体向导不允许 import geodata（test_46/test_48 静态守），但「前往编辑」
// 需要把画布切到该实体所在的视图。所以沿用同一套注册表模式：geodata 注册实现，面板只发请求。
let gotoHandler = null;

/** 由 geodata 在 setup 时注册（重复注册覆盖旧的，便于 HMR） */
export function setGotoHandler(fn) {
  gotoHandler = typeof fn === 'function' ? fn : null;
  return gotoHandler;
}

/**
 * 请求画布定位到某实体（id 或实体对象）。
 * @returns {{ ok: boolean, view?: string, viewLabel?: string, name?: string, error?: string }}
 */
export function gotoEntity(entityOrId) {
  const id = typeof entityOrId === 'string' ? entityOrId : (entityOrId && entityOrId.id);
  if (!id) return { ok: false, error: '缺少实体 id' };
  if (!gotoHandler) return { ok: false, error: '画布尚未就绪（geodata 未装载）' };
  try {
    return gotoHandler(id) || { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 调试/测试用 */
export function describeCanvasBridge() {
  const base = adapter && typeof adapter.describe === 'function'
    ? adapter.describe()
    : { attached: false, source: 'vault' };
  return { ...base, projectSink: !!(sink && typeof sink.syncFromCanvas === 'function'), gotoHandler: !!gotoHandler };
}
