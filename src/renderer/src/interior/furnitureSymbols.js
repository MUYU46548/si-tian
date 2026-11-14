// interior/furnitureSymbols.js — 家具的**平面符号**（2026-11-14）
//
// ── 为什么要有这一层 ─────────────────────────────────────────────────────
// 之前家具就是一块纯色矩形（`fillRect` + 阴影）。用户原话：
// "做出来的东西根本不值得看" —— 一块蓝方块谁也不知道是床还是沙发。
// 这一层按**真实尺寸**把家具画成平面图符号，与出图同一套（屏幕上什么样，纸上就什么样）。
//
// ── 四条纪律 ─────────────────────────────────────────────────────────────
// 1) 零依赖、不碰 DOM / store / 响应式 → Node 单测可直接加载（`unit/test_furniture_symbols.js`）。
// 2) 坐标：调用方已 translate 到家具中心并 rotate 到 `rotation`，这里一律用 **cm** 画
//    （-w/2..w/2, -h/2..h/2）。线宽要除以 zoom 才能在屏幕上恒定 —— 由 `opt.zoom` 传入。
// 3) 🔴 **只画俯视能看见的东西**（2026-11-14 用户："有的像推翻了压在地上，特别是柜子"）。
//    第一版给柜子画了门缝 + 把手、给桌子画了四条腿、给门画了整块矩形框 —— 那些是**立面**信息，
//    塞进平面图里就变成"一块板被压在地上"的错觉。俯视图里：柜顶看不见门缝与把手，
//    桌腿被桌面挡住，门只剩"门扇 + 开合弧"。改动前先问自己：
//    **"从天花板往下看，这条线看得见吗？"**
// 4) 颜色走一套「纸上制图」色：浅填充 + 深描边，细节再淡一档。
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
 * @param {CanvasRenderingContext2D} ctx 已 translate/rotate 到家具中心
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
  // 阴影由调用方在**整体**上给就够了；符号内部若继承阴影，枕头/缝/边每一条都会带一层，
  // 叠出来像"好几层板压在一起"（第一版就是这样，被用户点出来"翻了压在地上"）。
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
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
  /** 床：床垫 + 两只枕头（在 -h/2 这头）+ 被子压线。俯视全部可见。 */
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
    ctx.strokeStyle = DETAIL;
    ctx.lineWidth = lw(zoom, 1.0);
    ctx.beginPath();
    ctx.moveTo(x0 + w * 0.04, y0 + headH + (h - headH) * 0.30);
    ctx.lineTo(x0 + w * 0.96, y0 + headH + (h - headH) * 0.30);
    ctx.stroke();
  },

  /** 桌：俯视只有桌面（腿被桌面挡住）—— 矩形 + 台面内缩边 + 一条拼接缝 */
  table(ctx, { w, h, x0, y0, zoom }) {
    rect(ctx, x0, y0, w, h);
    ctx.fill();
    ctx.stroke();
    const inset = Math.max(1.5, Math.min(w, h) * 0.045);
    ctx.strokeStyle = DETAIL;
    ctx.lineWidth = lw(zoom, 0.9);
    rect(ctx, x0 + inset, y0 + inset, w - inset * 2, h - inset * 2);
    ctx.stroke();
    ctx.strokeStyle = ACCENT;
    ctx.beginPath();
    if (w >= h) {
      ctx.moveTo(x0 + w * 0.5, y0 + inset);
      ctx.lineTo(x0 + w * 0.5, y0 + h - inset);
    } else {
      ctx.moveTo(x0 + inset, y0 + h * 0.5);
      ctx.lineTo(x0 + w - inset, y0 + h * 0.5);
    }
    ctx.stroke();
  },

  /** 椅：坐垫 + 靠背（-h/2 侧）。俯视可见。 */
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

  /**
   * 柜：俯视只有**柜顶**。门缝、把手都在立面 —— 画出来就是"一块板被压在地上"。
   * 保留一道台面边（柜顶比柜身略小一圈，这道沿俯视看得见）。
   */
  chest(ctx, { w, h, x0, y0, zoom }) {
    rect(ctx, x0, y0, w, h);
    ctx.fill();
    ctx.stroke();
    const inset = Math.max(1.5, Math.min(w, h) * 0.05);
    ctx.strokeStyle = DETAIL;
    ctx.lineWidth = lw(zoom, 0.9);
    rect(ctx, x0 + inset, y0 + inset, w - inset * 2, h - inset * 2);
    ctx.stroke();
  },

  /** 装饰（瓶/摆件）：圆 + 一圈内环。俯视是"圆台顶"。 */
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

  /**
   * 门：平面图标准画法 = 「门扇 + 四分之一开合弧」，门框只画**虚线占位**。
   * 第一版画了整块实线矩形 + 竖线 → 看起来就是一块门板被放倒压在地上（用户原话）。
   * 第二版把弧半径取成 max(w,h)（90×200 的门画出一个半径 200 的巨大弧）→ 也不对。
   * 现在：扇长取**洞口宽** min(w,h)；矩形只作为很淡的虚线占位，说明这件家具占多大地方。
   */
  door(ctx, { w, h, x0, y0, zoom }) {
    const len = Math.min(w, h);
    // 占位框（淡虚线）：看得出这件"门"占了 90×200 的位置
    ctx.save();
    ctx.setLineDash([6 / zoom, 4 / zoom]);
    ctx.strokeStyle = '#c9d3dd';
    ctx.lineWidth = lw(zoom, 0.8);
    rect(ctx, x0, y0, w, h);
    ctx.stroke();
    ctx.restore();

    // 门扇（一条粗线）+ 开合弧，铰点在左下
    ctx.strokeStyle = STROKE;
    ctx.lineWidth = lw(zoom, 1.6);
    ctx.beginPath();
    ctx.moveTo(x0, y0 + h);
    ctx.lineTo(x0 + len, y0 + h);
    ctx.stroke();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = lw(zoom, 1.1);
    ctx.beginPath();
    ctx.arc(x0, y0 + h, len, -Math.PI / 2, 0);
    ctx.stroke();
  },

  /** 窗：俯视可见（窗洞里的玻璃）—— 矩形 + 沿长边的中分线 */
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

  /** 沙发：外框 + 靠背 + 两侧扶手 + 坐垫分隔。俯视全部可见。 */
  sofa(ctx, { w, h, x0, y0, zoom }) {
    const back = Math.max(6, h * 0.24);
    const arm = Math.max(6, w * 0.1);
    roundRect(ctx, x0, y0, w, h, Math.min(w, h) * 0.12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = ACCENT;
    roundRect(ctx, x0, y0, w, back, Math.min(w, h) * 0.1);
    ctx.fill();
    ctx.stroke();
    for (const ax of [x0, x0 + w - arm]) {
      ctx.fillStyle = ACCENT;
      rect(ctx, ax, y0 + back, arm, h - back);
      ctx.fill();
      ctx.stroke();
    }
    ctx.strokeStyle = DETAIL;
    ctx.lineWidth = lw(zoom, 0.9);
    ctx.beginPath();
    ctx.moveTo(x0 + w / 2, y0 + back + (h - back) * 0.1);
    ctx.lineTo(x0 + w / 2, y0 + h - (h - back) * 0.1);
    ctx.stroke();
  },

  /**
   * 衣柜：俯视只有柜顶。第一版画了双开门 + 挂衣杆（立面信息）→ 像"柜子被拍平"。
   * 现在只留柜顶 + 一道分区线（柜顶拼缝，俯视可见）。
   */
  wardrobe(ctx, { w, h, x0, y0, zoom }) {
    rect(ctx, x0, y0, w, h);
    ctx.fill();
    ctx.stroke();
    const inset = Math.max(1.5, Math.min(w, h) * 0.05);
    ctx.strokeStyle = DETAIL;
    ctx.lineWidth = lw(zoom, 0.9);
    rect(ctx, x0 + inset, y0 + inset, w - inset * 2, h - inset * 2);
    ctx.stroke();
    ctx.strokeStyle = ACCENT;
    ctx.beginPath();
    if (w >= h) {
      const cut = x0 + w * 0.62;
      ctx.moveTo(cut, y0 + inset);
      ctx.lineTo(cut, y0 + h - inset);
    } else {
      const cut = y0 + h * 0.62;
      ctx.moveTo(x0 + inset, cut);
      ctx.lineTo(x0 + w - inset, cut);
    }
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
