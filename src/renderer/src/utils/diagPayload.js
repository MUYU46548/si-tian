// utils/diagPayload.js — 诊断包请求体（卡「保存链分段读数进诊断包」，2026-11-07）
//
// 为什么单独一个文件：诊断包的载荷形状要能被**用例直接调**（`drill_diag_package.py` 在页面里
// `import('/src/utils/diagPayload.js')` 再用它拼 payload —— 走的就是按钮那条路），
// 而不是在演练脚本里手抄一份 `{stats, saveChain}`。抄一份的下场是"按钮加了字段、演练不知道"。
//
// ⚠️ 白名单 / 脱敏 / 封顶**不在这里**做：诊断包只有一个出口（主进程
// `diagPackage.buildDiagnostics` → `sanitizeSaveChain`），两边都做会漂移。
// 这里只负责"取哪几段"：最近 `max` 条原始读数。

/**
 * @param {{stats?:object, saveLog?:Array, max?:number}} [input]
 *   `saveLog` = `window.__SITIAN_SAVE_LOG__`（保存链每次落盘自报的分段读数，新的在前）
 * @returns {{stats:object, saveChain:Array}}
 */
export function buildDiagRequest({ stats, saveLog, max = 10 } = {}) {
  const log = Array.isArray(saveLog) ? saveLog : [];
  const n = Number.isFinite(max) ? Math.max(1, Math.min(50, Math.floor(max))) : 10;
  return {
    stats: (stats && typeof stats === 'object') ? stats : {},
    saveChain: log.slice(0, n),
  };
}
