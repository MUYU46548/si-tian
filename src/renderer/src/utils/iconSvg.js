// iconSvg.js — 字符串上下文（innerHTML / 覆盖层）使用的图标 SVG 片段。
//
// 背景：错误覆盖层、导出遮罩等场景直接拼 innerHTML，无法挂载 <Icon> 组件。
// 此处提供同名图标的 SVG 字符串版本。
//
// 约束：几何必须与 components/Icon.vue 中同名图标一致（仅收录字符串场景用到的少量图标）。
// 若某图标仅用于组件模板，请直接使用 <Icon>，不要在此重复登记。

const ICON_BODY = {
  'alert-triangle':
    '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
    '<line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
    '<polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  camera:
    '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>' +
    '<circle cx="12" cy="13" r="4"/>',
  package:
    '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/>' +
    '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>' +
    '<polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>'
};

/**
 * 生成内联 SVG 图标字符串。
 * @param {string} name 图标名（须已登记在 ICON_BODY）
 * @param {{size?:number,color?:string,strokeWidth?:number,style?:string}} [opts]
 * @returns {string} SVG 标记；未登记的名字返回空串（调用方须自行降级）
 */
export function iconSvg(name, opts = {}) {
  const body = ICON_BODY[name];
  if (!body) return '';
  const { size = 16, color = 'currentColor', strokeWidth = 2, style = '' } = opts;
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}"` +
    ` stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"` +
    ` style="display:inline-block;vertical-align:middle;flex-shrink:0;${style}">${body}</svg>`
  );
}
