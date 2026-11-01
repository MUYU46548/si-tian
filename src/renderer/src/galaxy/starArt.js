// galaxy/starArt.js —— 恒星节点美术（**吸收自 SP-1025 `src/render/nodes.ts`，MIT，自研**）
//
// 原型口径（10-25 视觉返工）：
//   · 每颗星按 **id 哈希** 确定性分派色温（白 / 蓝白 / 黄白 / 橙 / 红）——同一颗星永远是同一颗星；
//   · 三层光晕（halo → 主星体 → 白热星心），枢纽（度数高）更亮；
//   · 远景只画点（不做图标），近景才出类型图元（首府环 / 空间站六边形 / 星门双环）。
//
// 与司天的结合点（原型没有、司天必须有）：
//   · **归属色**：星系所属星域的 `factionColor` 画成一圈细环 + 低透明光晕底衬 ——
//     色温只表达"这颗星是什么"，环色表达"它归谁"。两者分离，图例才读得懂。
//   · **叙事状态淡化**：`fade`（`utils/entityStatus.js`）只降权重，不隐藏数据。
//   · **匹配态**：`matched` 走金色，`current` 更亮（沿用原有语义）。
//   · 尺寸一律**屏幕像素 ÷ scale** —— 缩放时星点不变胖（原型就是屏幕空间渲染，这里等价换算）。
//
// ⚠️ 回归契约（test_117）：导出时每个节点必须有 **半径 ≥ 5 的 arc 画在布局位置** 上 ——
//    所以主星体半径在导出模式按 `uiScale` 放大，且圆心必须精确等于节点坐标。

/** 确定性哈希 → [0,1)（FNV-1a，与原型一致） */
function hash01(str, salt) {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 100000) / 100000;
}

/** 色温分级：白 / 蓝白 / 黄白 / 橙 / 红（权重仿星族分布） */
const STAR_CLASSES = [
  { tint: '#f5f8ff', w: 0.30 },
  { tint: '#cfe0ff', w: 0.25 },
  { tint: '#fff3d6', w: 0.20 },
  { tint: '#ffd9a0', w: 0.15 },
  { tint: '#ffb9a3', w: 0.10 },
];

/** 这颗星是什么色温（同 id 恒定） */
export function starTintOf(id) {
  const h = hash01(String(id || ''), 7);
  let acc = 0;
  for (const c of STAR_CLASSES) {
    acc += c.w;
    if (h < acc) return c.tint;
  }
  return STAR_CLASSES[0].tint;
}

/** 屏幕半径（px）：远景 3.4，中近景 4.6~9.5；枢纽 ×1.3
 *  ⚠️ 远景别做太小：司天的星系数远少于原型（415 省项目里一个星域也就几颗），
 *     2.2px 的点在整幅图里会"看不见星"、只剩标签飘在空中（2026-11-01 首版就是这个问题）。 */
export function starScreenRadius(lod, { major = false, exportMode = false, uiScale = 1 } = {}) {
  if (exportMode) return (major ? 10 : 8) * uiScale;
  if (lod < 0.28) return major ? 4.4 : 3.4;
  const base = Math.min(9.5, Math.max(5.2, 4.0 + lod * 4.4));
  return major ? base * 1.3 : base;
}

function rgba(hex, a) {
  const s = String(hex || '#ffffff');
  if (s.startsWith('rgb')) return s.replace(/rgba?\(([^)]+)\)/, (m, body) => {
    const parts = body.split(',').map(x => parseFloat(x));
    return `rgba(${parts[0]},${parts[1] || 0},${parts[2] || 0},${a})`;
  });
  if (s.startsWith('hsl')) return s; // hsl 无法可靠拆 alpha，退回原色（宁可实一点，不出非法 CSS）
  const n = parseInt(s.slice(1, 7).padEnd(6, '0'), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * 画一颗星系（恒星）。
 * @param {CanvasRenderingContext2D} ctx 世界坐标上下文
 * @param {object} star { id, x, y, name, factionColor, degree, matched, current, hovered, selected, fade, major }
 * @param {object} o { scale, lod, time, exportMode, uiScale }
 */
export function paintStar(ctx, star, o) {
  const scale = o.scale || 1;
  const lod = o.lod == null ? 1 : o.lod;
  const exportMode = !!o.exportMode;
  const time = o.time || 0;
  const fade = star.fade == null ? 1 : star.fade;

  const major = !!star.major || (star.degree || 0) >= 4 || star.matched;
  const rPx = starScreenRadius(lod, { major, exportMode, uiScale: o.uiScale || 1 });
  const r = rPx / scale;            // 屏幕恒定 → 世界半径
  const tint = starTintOf(star.id);
  const owner = star.factionColor || null;

  ctx.save();
  if (fade < 1) ctx.globalAlpha = fade;

  // ① 归属光晕底衬（低透明）：远处也能看出"这一片是谁的"
  if (owner && (exportMode || lod >= 0.2)) {
    const hr = r * (exportMode ? 4.2 : 3.6);
    const g = ctx.createRadialGradient(star.x, star.y, 0, star.x, star.y, hr);
    g.addColorStop(0, rgba(owner, 0.34));
    g.addColorStop(0.55, rgba(owner, 0.12));
    g.addColorStop(1, rgba(owner, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(star.x, star.y, hr, 0, Math.PI * 2);
    ctx.fill();
  }

  // ② 色温光晕（所有档位都画：远景没有光晕就只剩几个看不出是星的像素点）
  {
    const flicker = exportMode ? 1 : 0.92 + Math.sin(time * 1.6 + (hash01(String(star.id), 3) * 6.28)) * 0.08;
    const gr = r * (major ? 4.0 : 3.4) * flicker;
    const g = ctx.createRadialGradient(star.x, star.y, 0, star.x, star.y, gr);
    g.addColorStop(0, rgba(tint, major ? 0.62 : 0.5));
    g.addColorStop(0.45, rgba(tint, 0.18));
    g.addColorStop(1, rgba(tint, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(star.x, star.y, gr, 0, Math.PI * 2);
    ctx.fill();
  }

  // ③ 主星体（**必须**在这里落一个 r 圆心 = 节点坐标的 arc：回归用例按它验同源）
  ctx.beginPath();
  ctx.arc(star.x, star.y, r, 0, Math.PI * 2);
  ctx.fillStyle = tint;
  ctx.fill();

  // ④ 白热星心
  ctx.beginPath();
  ctx.arc(star.x, star.y, r * 0.42, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fill();

  // ⑤ 归属细环（读归属靠它；远景不画，免得糊成一圈）
  // ⚠️ 导出态用**不透明**描边：`test_117` 要按「势力色像素数 > 0」证明星系真的按归属色画出来了，
  //    半透明描边叠在深色底上出来的颜色会偏、数不到。
  if (owner && (exportMode || lod >= 0.45)) {
    ctx.beginPath();
    ctx.arc(star.x, star.y, r * 1.28, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(owner, exportMode ? 1 : 0.95);
    ctx.lineWidth = Math.max(0.6, (exportMode ? 1.8 * (o.uiScale || 1) : 1.2) / scale);
    ctx.stroke();
  }

  // ⑥ 近景图元 / 匹配态
  if (!exportMode && lod >= 0.85) {
    if (star.matched) {
      const pulse = 1 + Math.sin(time * 3.2) * 0.08;
      ctx.beginPath();
      ctx.arc(star.x, star.y, r * 1.9 * pulse, 0, Math.PI * 2);
      ctx.strokeStyle = star.current ? 'rgba(255,214,102,0.95)' : 'rgba(255,178,72,0.8)';
      ctx.lineWidth = Math.max(0.8, 1.4 / scale);
      ctx.stroke();
    }
    if (major) {
      // 枢纽：四向短芒（够近才画，远景是噪点）
      const L = r * 2.6;
      ctx.strokeStyle = rgba(tint, 0.55);
      ctx.lineWidth = Math.max(0.5, 1 / scale);
      ctx.beginPath();
      ctx.moveTo(star.x - L, star.y); ctx.lineTo(star.x - r * 1.35, star.y);
      ctx.moveTo(star.x + r * 1.35, star.y); ctx.lineTo(star.x + L, star.y);
      ctx.moveTo(star.x, star.y - L); ctx.lineTo(star.x, star.y - r * 1.35);
      ctx.moveTo(star.x, star.y + r * 1.35); ctx.lineTo(star.x, star.y + L);
      ctx.stroke();
    }
  }

  // ⑦ 悬停 / 选中
  if (star.hovered && !exportMode) {
    ctx.beginPath();
    ctx.arc(star.x, star.y, r * 1.55, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = Math.max(0.6, 1 / scale);
    ctx.stroke();
  }
  if (star.selected && !exportMode) {
    const pulse = 1 + Math.sin(time * 4) * 0.06;
    ctx.beginPath();
    ctx.arc(star.x, star.y, r * 1.85 * pulse, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = Math.max(0.8, 1.6 / scale);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * 星域中心标记（导出图需要"星域本体"也有一个可点的节点圆；画布用边界+名字代替）。
 * 半径固定 ≥ 5（回归契约）。
 */
export function paintDomainMarker(ctx, domain, o = {}) {
  const scale = o.scale || 1;
  const uiScale = o.uiScale || 1;
  const r = 7 * uiScale / (o.exportMode ? 1 : scale);
  const color = domain.factionColor || '#7c7cff';
  ctx.save();
  ctx.beginPath();
  ctx.arc(domain.x, domain.y, r, 0, Math.PI * 2);
  ctx.fillStyle = rgba(color, 0.9);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(domain.x, domain.y, r * 1.7, 0, Math.PI * 2);
  ctx.strokeStyle = rgba(color, 0.55);
  ctx.lineWidth = Math.max(0.6, 1.2 / scale);
  ctx.stroke();
  ctx.restore();
}
