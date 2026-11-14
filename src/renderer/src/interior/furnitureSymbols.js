// interior/furnitureSymbols.js — 家具的**平面符号**（2026-11-14）
//
// ── 为什么要有这一层 ─────────────────────────────────────────────────────
// 之前家具就是一块纯色矩形（`fillRect` + 阴影）。用户原话：
// "做出来的东西根本不值得看" —— 一块蓝方块谁也不知道是床还是沙发。
// 这一层按**真实尺寸**把家具画成平面图符号（床头枕头、桌面四腿、灶眼、沙发靠背…），
// 一眼能认出是什么，且与出图同一套（屏幕上什么样，纸上就什么样）。
//
// ── 纪律 ─────────────────────────────────────────────────────────────────
// 1) 零依赖、不碰 DOM / store / 响应式 → Node 单测可直接加载（`unit/test_furniture_symbols.js`）。
// 2) 坐标：调用方已 translate 到家具中心并 rotate 到 `rotation`，这里一律用 **cm** 画
//    （-w/2..w/2, -h/2..h/2）。线宽要除以 zoom 才能在屏幕上恒定 —— 由 `opt.zoom` 传入。
// 3) 颜色走一套「纸上制图」色：浅填充 + 深描边，细节再淡一档。
//    不跟家具类型的原色（蓝/棕）走 —— 那些颜色在白底上像贴纸，且互相压不住。

const FILL = '#f4f6f8';
const STROKE = '#59636f';
const DETAIL = '#8494a5';
const ACCENT = '#b9c6d3';

/** 线宽：屏幕恒定 px（世界单位 = px / zoom） */
function lw(zoom, px) {
  const z = Number(zoom) > 0 ? Number(zoom) : 1;
  return px / z;
}

function rect(ctx, x, y, w, h) {
  ctx.beginPath();
  ctx.rect(x, y, w, h);
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/**
 * 画一件家具的平面符号。
 *
 * @param {CanvasRenderingContext2D} ctx 已 translate/rotate 到家具体中心
 * @param {{width:number,height:number,type?:string,rotation?:number}} item 尺寸单位 cm
 * @param {{zoom?:number}} [opt]
 * @returns {boolean} 是否画了（未知类型会退回"通用"符号，仍返回 true）
 */
export function drawFurnitureSymbol(ctx, item, opt = {}) {
  if (!ctx || !item) return false;
  const w = Number(item.width) || 0;
  const h = Number(item.height) || 0;
  if (!(w > 0) || !(h > 0)) return false;
  const zoom = Number(opt.zoom) > 0 ? Number(opt.zoom) : 1;
  const x0 = -w / 2;
  const y0 = -h / 2;
  const type = String(item.type || 'generic');

  ctx.save();
  ctx.fillStyle = FILL;
  ctx.strokeStyle = STROKE;
  ctx.lineWidth = lw(zoom, 1.2);
  ctx.lineJoin = 'round';

  const draw = SYMBOLS[type] || SYMBOLS.generic;
  draw(ctx, { w, h, x0, y0, zoom });

  ctx.restore();
  return true;
}

const SYMBOLS = {
  /** 床：床垫 + 两个枕头（在 -h/2 这头）+ 被子压线 */
  bed(ctx, { w, h, x0, y0, zoom }) {
    roundRect(ctx, x0, y0, w, h, Math.min(w, h) * 0.04);
    ctx.fill();
    ctx.stroke();

    const headH = Math.min(h * 0.22, 34);      // 枕头区深度
    const pad = Math.min(w, h) * 0.08;
    const pw = (w - pad * 3) / 2;              // 两只枕头并排
    const ph = Math.max(8, headH - pad);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = DETAIL;
    ctx.lineWidth = lw(zoom, 0.9);
    for (let i = 0; i < 2; i++) {
      roundRect(ctx, x0 + pad + i * (pw + pad), y0 + pad, pw, ph, Math.min(pw, ph) * 0.25);
      ctx.fill();
      ctx.stroke();
    }
    // 被子折线（横过床身 1/3 处）
    ctx.strokeStyle = ACCENT;
    ctx.beginPath();
    ctx.moveTo(x0 + w * 0.04, y0 + headH + (h - headH) * 0.30);
    ctx.lineTo(x0 + w * 0.96, y0 + headH + (h - headH) * 0.30);
    ctx.stroke();
  },

  /** 桌：桌面 + 四角桌腿点 + 中缝 */
  table(ctx, { w, h, x0, y0, zoom }) {
    rect(ctx, x0, y0, w, h);
    ctx.fill();
    ctx.stroke();
    const s = Math.min(w, h) * 0.12;            // 腿粗
    ctx.fillStyle = DETAIL;
    for (const [lx, ly] of [[x0 + s * 0.6, y0 + s * 0.6], [x0 + w - s * 1.6, y0 + s * 0.6],
      [x0 + s * 0.6, y0 + h - s * 1.6], [x0 + w - s * 1.6, y0 + h - s * 1.6]]) {
      ctx.fillRect(lx, ly, s, s);
    }
    ctx.strokeStyle = ACCENT;
    ctx.beginPath();
    ctx.moveTo(x0 + w * 0.5, y0 + h * 0.12);
    ctx.lineTo(x0 + w * 0.5, y0 + h * 0.88);
    ctx.stroke();
  },

  /** 椅：坐垫 + 靠背（-h/2 侧）*/
  chair(ctx, { w, h, x0, y0, zoom }) {
    const back = Math.max(4, h * 0.16);
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, x0, y0, w, h, Math.min(w, h) * 0.12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = ACCENT;
    rect(ctx, x0, y0, w, back);
    ctx.fill();
    ctx.strokeStyle = DETAIL;
    ctx.stroke();
    ctx.fillStyle = FILL;
    ctx.strokeStyle = STROKE;
    ctx.lineWidth = lw(zoom, 1.0);
    roundRect(ctx, x0 + w * 0.1, y0 + back + h * 0.06, w * 0.8, h - back - h * 0.16, Math.min(w, h) * 0.08);
    ctx.fill();
    ctx.stroke();
  },

  /** 柜：双开门 + 把手（圆形）+ 顶部挂衣杆 */
  chest(ctx, { w, h, x0, y0, zoom }) {
    rect(ctx, x0, y0, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = ACCENT;
    ctx.beginPath();
    ctx.moveTo(x0 + w / 2, y0);
    ctx.lineTo(x0 + w / 2, y0 + h);
    ctx.stroke();
    // 门扇内缩一格（平面图上柜子是"箱体"）
    ctx.strokeStyle = DETAIL;
    ctx.lineWidth = lw(zoom, 0.9);
    rect(ctx, x0 + w * 0.08, y0 + h * 0.08, w * 0.84, h * 0.84);
    ctx.stroke();
    ctx.fillStyle = DETAIL;
    const r = Math.max(1.2, Math.min(w, h) * 0.03);
    for (const dx of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(x0 + w / 2 + dx * w * 0.06, y0 + h / 2, r, 0, Math.PI * 2);
      ctx.fill();
    }
  },

  /** 装饰（瓶/摆件）：圆 + 一点枝叶 */
  decoration(ctx, { w, h, x0, y0, zoom }) {
    const r = Math.min(w, h) / 2;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.92, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = lw(zoom, 0.9);
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2);
    ctx.stroke();
    void x0; void y0;
  },

  /** 门（家具化的门）：门扇 + 四分之一开合弧 */
  door(ctx, { w, h, x0, y0, zoom }) {
    const len = Math.max(w, h);
    ctx.strokeStyle = STROKE;
    ctx.lineWidth = lw(zoom, 1.2);
    rect(ctx, x0, y0, w, h);
    ctx.stroke();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = lw(zoom, 0.9);
    ctx.beginPath();
    ctx.moveTo(x0, y0 + h);
    ctx.lineTo(x0, y0 + h - len);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x0, y0 + h, len, -Math.PI / 2, 0);
    ctx.stroke();
  },

  /** 窗（家具化的窗）：双线 + 玻璃分隔 */
  window(ctx, { w, h, x0, y0, zoom }) {
    rect(ctx, x0, y0, w, h);
    ctx.fillStyle = '#eaf2f7';
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = DETAIL;
    ctx.lineWidth = lw(zoom, 0.8);
    const n = Math.max(2, Math.round(Math.max(w, h) / 60));
    for (let i = 1; i < n; i++) {
      ctx.beginPath();
      if (w >= h) {
        ctx.moveTo(x0 + (w * i) / n, y0);
        ctx.lineTo(x0 + (w * i) / n, y0 + h);
      } else {
        ctx.moveTo(x0, y0 + (h * i) / n);
        ctx.lineTo(x0 + w, y0 + (h * i) / n);
      }
      ctx.stroke();
    }
  },

  /** 沙发：外框 + 靠背 + 两侧扶手 + 坐垫分隔 */
  sofa(ctx, { w, h, x0, y0, zoom }) {
    const back = Math.max(6, h * 0.24);
    const arm = Math.max(6, w * 0.1);
    roundRect(ctx, x0, y0, w, h, Math.min(w, h) * 0.12);
    ctx.fill();
    ctx.stroke();
    // 靠背（上侧）
    ctx.fillStyle = ACCENT;
    roundRect(ctx, x0, y0, w, back, Math.min(w, h) * 0.1);
    ctx.fill();
    ctx.stroke();
    // 两侧扶手
    for (const ax of [x0, x0 + w - arm]) {
      ctx.fillStyle = ACCENT;
      rect(ctx, ax, y0 + back, arm, h - back);
      ctx.fill();
      ctx.stroke();
    }
    // 坐垫分隔（2 个座位 → 1 条竖线）
    ctx.strokeStyle = DETAIL;
    ctx.lineWidth = lw(zoom, 0.9);
    ctx.beginPath();
    ctx.moveTo(x0 + w / 2, y0 + back + (h - back) * 0.1);
    ctx.lineTo(x0 + w / 2, y0 + h - (h - back) * 0.1);
    ctx.stroke();
  },

  /** 衣柜：箱体 + 双开门 + 挂衣杆（顶部一条横线 + 两端挂钩）*/
  wardrobe(ctx, { w, h, x0, y0, zoom }) {
    rect(ctx, x0, y0, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = DETAIL;
    ctx.lineWidth = lw(zoom, 0.9);
    rect(ctx, x0 + w * 0.06, y0 + h * 0.06, w * 0.88, h * 0.88);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x0 + w / 2, y0 + h * 0.06);
    ctx.lineTo(x0 + w / 2, y0 + h * 0.94);
    ctx.stroke();
    // 挂衣杆
    ctx.strokeStyle = ACCENT;
    ctx.beginPath();
    ctx.moveTo(x0 + w * 0.14, y0 + h * 0.2);
    ctx.lineTo(x0 + w * 0.86, y0 + h * 0.2);
    ctx.stroke();
  },

  /** 通用：矩形 + 对角交叉（"未知物件"的制图惯例）*/
  generic(ctx, { w, h, x0, y0, zoom }) {
    rect(ctx, x0, y0, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = lw(zoom, 0.8);
    ctx.beginPath();
    ctx.moveTo(x0, y0); ctx.lineTo(x0 + w, y0 + h);
    ctx.moveTo(x0 + w, y0); ctx.lineTo(x0, y0 + h);
    ctx.stroke();
  },
};

/** 区域类（院落/园林/走廊/水池/围墙）仍走"半透明 + 虚线"，不在此列 */
export const SYMBOL_TYPES = Object.freeze(Object.keys(SYMBOLS));
