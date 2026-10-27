// utils/labelLayout.js — 文字避让排布（纯函数；2026-10-26）
//
// ── 为什么需要它（用户参照的意大利地形图，标注密度高但一个都不压一个）──
// 我们有 617 个城镇名、160 条河名、415 个省名，分级逻辑（`scenarioTextPlacement` /
// `polityLabels`）已经挡掉了大部分，但**同一档内的标签之间没有任何避让**：
// 2× 下 150 个城镇名照样互相压成一团墨。参考图的信息密度不是"多画字"，而是
// **每一处字都放得下才画**（放不下就不标 —— 制图惯例）。
//
// ── 边界（保持纯）────────────────────────────────────────────────────────────
// 只做「候选 + 量字 + 摆位 → 放下的那些」：不碰 DOM / canvas / store。
// 量字由调用方注入（画布用 `measureText`，导出用同一份画布上下文，Node 用例用估算函数），
// 所以画布与 SVG 导出能吃到**同一份排布结论** —— 与 `scenarioLabels` 的纪律一致。
//
// ── 算法 ────────────────────────────────────────────────────────────────────
// 按优先级降序（势力名 > 首都 > 省名 > 城镇 > 河名），逐个试"首选落点 + 备选落点"，
// 撞上已放下的框或障碍物（城镇圆点）就换下一个落点，全撞就**丢掉**（不叠着画）。
// 碰撞用屏幕空间的均匀网格（cell=64px）：每帧最多几百个候选，平均 O(n)。
//
// ⚠️ 坐标单位是**布局空间**（画布 = 屏幕像素；导出 = 世界单位/相当于 1px）。
//    调用方负责把世界坐标换算进来、把结论换算回去。

/** 默认优先级（数大先放）。调用方可在候选上覆盖 */
export const LABEL_PRIORITY = Object.freeze({
  polity: 100,      // 势力名：读图的第一个层次
  capital: 90,      // 首都
  marker: 80,
  province: 70,     // 省名
  town: 60,         // 一般城镇
  river: 50,        // 河名：最容易被牺牲的一档
});

/**
 * **面状标签**（省名 / 势力名）的落点序列 —— 形心优先，放不下就在面内挪一点。
 *
 * 为什么不能只试形心：势力名（优先级更高）本来就落在同一片领土的形心上，
 * 省名再要那个点就必然被挤掉 —— 实测把整片省名全丢了（`test_100` 的 PNG 里一个省名都没有）。
 * 挪动幅度取字高/字宽的 1~2 倍，仍在省界附近（地图上的省名本来就可以偏一点）。
 */
export const AREA_LABEL_PLACEMENTS = Object.freeze([
  { dx: 0, dy: 0 },
  { dx: 0, dy: -34 },
  { dx: 0, dy: 34 },
  { dx: -42, dy: 0 },
  { dx: 42, dy: 0 },
  { dx: 0, dy: -68 },
  { dx: 0, dy: 68 },
  { dx: -76, dy: 0 },
  { dx: 76, dy: 0 },
  { dx: 0, dy: -110 },
  { dx: 0, dy: 110 },
]);

function priorityOf(c) {
  if (Number.isFinite(c.priority)) return c.priority;
  if (c.kind && Number.isFinite(LABEL_PRIORITY[c.kind])) return LABEL_PRIORITY[c.kind];
  return 0;
}

/** 两个矩形是否相交（含 pad：把 b 向外扩 pad 再比，等价于"留缝"） */
export function rectsOverlap(a, b, pad = 0) {
  return !(a.x1 + pad <= b.x0 || b.x1 + pad <= a.x0
    || a.y1 + pad <= b.y0 || b.y1 + pad <= a.y0);
}

/**
 * 排布标签。
 *
 * @param {Array<object>} candidates 候选：
 *   `{ id, kind, text, x, y, style, priority?, placements?, obstacles?, meta? }`
 *   · `placements`：文本**中心**相对 (x,y) 的偏移数组，按顺序尝试；缺省 `[{dx:0,dy:0}]`
 *   · `obstacles`：必须先占住的矩形（例如城镇圆点），`{x0,y0,x1,y1}`
 * @param {object} opts
 * @param {(text:string, c:object)=>{w:number,h:number}} opts.measure 量字（布局空间）
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} [opts.bounds] 可见范围（中心点判定）
 * @param {number} [opts.pad=2] 框间留缝
 * @param {number} [opts.maxLabels=400] 上限（防御：数据异常时不要摆一万个）
 * @returns {Array<object>} 放下的候选（带 `cx,cy,w,h,box,place`），按优先级顺序
 */
export function layoutLabels(candidates, opts = {}) {
  const measure = opts.measure;
  if (typeof measure !== 'function') return [];
  const src = Array.isArray(candidates) ? candidates.filter((c) => c && c.text) : [];
  if (!src.length) return [];
  const pad = Number.isFinite(opts.pad) ? opts.pad : 2;
  const maxLabels = Number.isFinite(opts.maxLabels) ? opts.maxLabels : 400;
  const bounds = opts.bounds || null;
  const cell = Number.isFinite(opts.cell) && opts.cell > 16 ? opts.cell : 64;

  const grid = new Map();
  const cellsOf = (b) => {
    const out = [];
    const i0 = Math.floor(b.x0 / cell), i1 = Math.floor(b.x1 / cell);
    const j0 = Math.floor(b.y0 / cell), j1 = Math.floor(b.y1 / cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) out.push(i + ',' + j);
    return out;
  };
  const addBox = (b, isObstacle, softObstacle) => {
    for (const k of cellsOf(b)) {
      let arr = grid.get(k);
      if (!arr) { arr = []; grid.set(k, arr); }
      arr.push({ b, obs: !!isObstacle, soft: !!softObstacle });
    }
  };
  const blocked = (b, ignoreSoft) => {
    for (const k of cellsOf(b)) {
      const arr = grid.get(k);
      if (!arr) continue;
      // 障碍物（圆点/星标）是**精确几何**，不加留缝 —— 加了缝连"贴着圆点右侧"都算撞上，
      // 于是所有城镇名都会被自己的圆点挡掉（实测：3 个城镇一个都放不下）。
      for (const e of arr) {
        // 2026-10-27：城镇圆点是"软障碍"——势力名/省名这种面状大字本来就该盖住城市点；
        // 地形注记走廊是"硬保留区"，任何标签都得让开。
        if (e.obs && e.soft && ignoreSoft) continue;
        if (rectsOverlap(b, e.b, e.obs ? 0 : pad)) return true;
      }
    }
    return false;
  };

  // 障碍物先占位（它们不参与输出，但会挡标签）
  for (const c of src) {
    if (!Array.isArray(c.obstacles)) continue;
    for (const o of c.obstacles) if (o) addBox(o, true, true);
  }

  // 外部保留区（2026-10-27）：**不是候选标签、但也不许被压住**的东西 ——
  // 典型是地形注记（山系名沿脊线排的那一条走廊）。它们由调用方按自己的坐标系给框
  // （画布 = 屏幕像素，导出 = 世界单位），本函数只把它当障碍物。
  for (const o of (Array.isArray(opts.reserve) ? opts.reserve : [])) {
    if (!o) continue;
    const x0 = Number(o.x0), y0 = Number(o.y0), x1 = Number(o.x1), y1 = Number(o.y1);
    if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
    addBox({ x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) }, true);
  }

  const order = src.map((c, i) => ({ c, i }))
    .sort((a, b) => (priorityOf(b.c) - priorityOf(a.c)) || (a.i - b.i));

  const out = [];
  for (const { c } of order) {
    if (out.length >= maxLabels) break;
    const m = measure(String(c.text), c) || { w: 0, h: 0 };
    const w = Math.max(0, Number(m.w) || 0);
    const h = Math.max(0, Number(m.h) || 0);
    if (!(w > 0) || !(h > 0)) continue;
    const tries = Array.isArray(c.placements) && c.placements.length
      ? c.placements
      : [{ mode: 'center' }];
    for (let p = 0; p < tries.length; p++) {
      const t = tries[p] || { mode: 'center' };
      // 落点两种写法：
      //   · `{mode:'right'|'left'|'above'|'below', gap, dx?, dy?}` —— 以**鼠标/圆点**为基准贴边，
      //     宽度未知也能算（城镇名要贴在圆点右侧，不能写死半宽）
      //   · `{dx, dy}` —— 以文本中心为基准（省名/势力名用形心，直接居中）
      let box;
      const gap = Number(t.gap) || 0;
      const dx = Number(t.dx) || 0;
      const dy = Number(t.dy) || 0;
      if (t.mode === 'right' || t.mode === 'left') {
        const x0 = t.mode === 'right' ? c.x + gap : c.x - gap - w;
        box = { x0, x1: x0 + w, y0: c.y + dy - h / 2, y1: c.y + dy + h / 2 };
      } else if (t.mode === 'above' || t.mode === 'below') {
        const y0 = t.mode === 'above' ? c.y - gap - h : c.y + gap;
        box = { x0: c.x + dx - w / 2, x1: c.x + dx + w / 2, y0, y1: y0 + h };
      } else {
        const cx = c.x + dx;
        const cy = c.y + dy;
        box = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
      }
      const cx = (box.x0 + box.x1) / 2;
      const cy = (box.y0 + box.y1) / 2;
      // 可见范围判定用**框与视口是否相交**，不是"中心点在视口内"：
      // 大国名/边缘城镇名本来就常常一半在屏外，按中心判会把它们整条丢掉
      // （2026-10-27 实测：真实项目右下角的势力名因为形心差 26px 出界而整条消失）。
      if (bounds && (box.x1 < bounds.minX || box.x0 > bounds.maxX
        || box.y1 < bounds.minY || box.y0 > bounds.maxY)) {
        continue;
      }
      if (blocked(box, c.ignoreSoftObstacles)) continue;
      addBox(box, false);
      out.push({ ...c, cx, cy, w, h, box, place: p });
      break;
    }
  }
  return out;
}
