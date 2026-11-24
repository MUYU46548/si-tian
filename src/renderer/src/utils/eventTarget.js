/**
 * 事件目标安全的 `closest` —— **`e.target` 不保证是元素**。
 *
 * 为什么要有这一层（2026-11-24）：
 *   `e.target.closest(...)` 是仓里到处都在用的写法，但它有一条**只在特定输入路径下**才踩的坑：
 *   `EventTarget` 不只是 `Element`。常见的非元素 target：
 *     · `window` —— 程序化派发最常见（`window.dispatchEvent(new KeyboardEvent('keydown'))`、
 *       以及在 `window` 上挂的 `mousedown` 监听器收到的合成事件）。**测试里天天这么干**。
 *     · `document` —— 同样可以派发/接收。
 *     · 文本节点 / `DocumentFragment` —— 极少数合成路径。
 *   这些一律没有 `closest`，直接调就是
 *   `TypeError: e.target.closest is not a function`，冒到 `window.onerror`
 *   弹"应用遇到错误"面板（`errorReport.js`）。2026-11-24 用页面错误判据在
 *   `test_04_panels` 上抓到过一次，路径正是 `window.dispatchEvent(new KeyboardEvent(...))`。
 *
 * 判据：只有 `nodeType === 1`（Element）才调 `closest`；其余一律当"没命中"。
 * 注意**不要**写成 `e.target instanceof Element` —— 跨 realm（iframe / 某些合成对象）时
 * `instanceof` 会漏判，而 `nodeType` 是鸭子类型，稳得多。
 */

/** 该 target 命中 selector 吗？（非 Element 一律 false，不抛异常） */
export function targetClosest(target, selector) {
  const el = target && target.nodeType === 1 ? target : null;
  return el ? el.closest(selector) : null;
}

/** 该 target 落在 selector 之内吗？（`targetClosest` 的布尔版，读起来更顺） */
export function targetMatches(target, selector) {
  return !!targetClosest(target, selector);
}
