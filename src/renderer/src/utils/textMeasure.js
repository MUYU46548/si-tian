// P2: 文本标签宽度测量 — 绘制（planetDrawing.drawTextLabels）、命中
// （planetHitTest.hitTestTextLabel）、手柄框（selectionHandles.getSelectionBox）
// 三处共用同一 measureText，保证视觉文本、命中区、手柄框三者严丝合缝。
// 旧实现用「字符数 × 字号 × 0.9」估算宽度，中英混排时误差可达数十字像素。

let sharedCtx = null;

function getCtx() {
  if (!sharedCtx) {
    const c = document.createElement('canvas');
    c.width = 8;
    c.height = 8;
    sharedCtx = c.getContext('2d');
  }
  return sharedCtx;
}

// 与 drawTextLabels 绘制正文用的字体串保持一致（改一处必须改两处）
export const LABEL_FONT_FAMILY = '"Microsoft YaHei", sans-serif';

export function labelFont(fontSize) {
  return `${fontSize}px ${LABEL_FONT_FAMILY}`;
}

// 文本背景框内边距 = 字号 × 0.4（drawTextLabels 的 padding 同值）
export function labelPadding(fontSize) {
  return fontSize * 0.4;
}

/**
 * 文本实际渲染宽度（px，世界单位 — 绘制层文本未缩放前同尺度）
 * @returns {number}
 */
export function measureLabelWidth(text, fontSize) {
  if (!text) return 0;
  const c = getCtx();
  c.font = labelFont(fontSize);
  return c.measureText(text).width;
}
