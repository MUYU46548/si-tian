// store/quitFlush.js — 「退出前落盘」的注册表（数据安全：不把用户手绘时间留在内存里丢掉）
//
// 为什么单独一个模块（而不是让 App.vue 直接调各 store）：
//   1. App.vue 有一条静态闸门 —— 不得出现 `projectStore` 字样（面板/组件才连项目 store）。
//      退出钩子却是 App 级行为，所以走这个中立注册表，沿用 `canvasBridge` 那套「注册口」手法。
//   2. 各 store 自己知道「什么算未落盘的改动」，外部不该猜。谁 dirty 谁注册。
//
// 时序：主进程在真正 quit 前发 `app-flush-before-quit` → 渲染层 `flushAll()` →
//       无论成败都回 `app-flush-done`（主进程另有 2.5s 超时兜底，退不掉比丢 800ms 更糟）。
//
// 注册纪律：**只能注册，不能覆盖**；单个 flusher 抛错不影响其他 flusher（各自 try/catch）。
const flushers = [];

/**
 * 注册一个退出前落盘回调。name 仅用于日志/断言；fn 可返回任意值，抛错会被捕获。
 * priority 越小越先执行 —— 画布侧（geodata）要先把自己的改动推给项目，项目再落盘。
 */
export function registerFlush(name, fn, priority = 0) {
  if (typeof fn !== 'function') return false;
  if (flushers.some(f => f.name === name)) return false;   // 幂等：重复注册（HMR / 多次 setup）不叠加
  flushers.push({ name, fn, priority });
  flushers.sort((a, b) => a.priority - b.priority);
  return true;
}

/** 依次执行所有 flusher，返回每个的结果（绝不抛错）。 */
export async function flushAll(reason = '') {
  const results = [];
  for (const f of flushers) {
    try {
      const r = await f.fn(reason);
      results.push({ name: f.name, ok: !(r && r.success === false), result: r });
    } catch (err) {
      results.push({ name: f.name, ok: false, error: (err && err.message) || String(err) });
    }
  }
  return results;
}

/** 已注册的名字（测试用） */
export function registeredFlushers() {
  return flushers.map(f => f.name);
}
