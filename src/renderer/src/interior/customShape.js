/**
 * 家具自定义形状的坐标换算（2026-11-14）。
 *
 * ## 为什么需要这一层
 *
 * 家具渲染时的变换是：`translate(x + w/2, y + h/2)` → `rotate(rotation)` → 以**中心为原点**画。
 * 用户在画布上点的是**世界坐标**，而 `item.custom.points` 存的是**归一化 0..1**（相对家具自身
 * 未旋转的包围框）。两者之间差一次「反旋转 + 平移到中心 + 除以宽高」，写错了形状就会跟着
 * 家具转一圈跑偏（家具旋转 90° 时最明显）。
 *
 * 归一化的好处：家具改尺寸不用重画形状，拖动/旋转都不变形。
 *
 * 纯函数、零依赖，Node 直接可测。
 */

const DEG = Math.PI / 180;

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 家具的中心点（世界坐标，cm） */
export function furnitureCenter(item) {
  return {
    x: num(item && item.x) + num(item && item.width) / 2,
    y: num(item && item.y) + num(item && item.height) / 2,
  };
}

/**
 * 世界点 → 家具本地坐标（已反旋转，原点在家具中心）。
 * @param {{x:number,y:number}} pt
 * @param {object} item
 * @param {number} [rotationOverride] 用例模拟旋转时用
 */
export function worldToLocal(pt, item, rotationOverride) {
  const c = furnitureCenter(item);
  const rot = (rotationOverride === undefined ? num(item && item.rotation) : num(rotationOverride)) * DEG;
  const dx = num(pt && pt.x) - c.x;
  const dy = num(pt && pt.y) - c.y;
  // 渲染是「先平移后旋转」，所以反解是 R(-θ)
  const cos = Math.cos(-rot);
  const sin = Math.sin(-rot);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

/** 家具本地坐标（原点在中心）→ 世界点 */
export function localToWorld(local, item, rotationOverride) {
  const c = furnitureCenter(item);
  const rot = (rotationOverride === undefined ? num(item && item.rotation) : num(rotationOverride)) * DEG;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const x = num(local && local.x);
  const y = num(local && local.y);
  return { x: c.x + x * cos - y * sin, y: c.y + x * sin + y * cos };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 用户在世界坐标点出的一串点 → `item.custom.points`（归一化 0..1）。
 *
 * 超出家具包围框的点会被**贴到边框上**（clamp），不是丢弃 —— 丢弃会让形状莫名缺一块。
 * 想让形状更大就先把家具拉大，或者画完再拉伸。
 *
 * @param {Array<{x:number,y:number}>} worldPts
 * @param {object} item
 * @param {{closed?:boolean, fill?:boolean}} [opts]
 * @returns {{points:Array<{x:number,y:number}>, closed:boolean, fill:boolean,
 *            extent:{x:number,y:number,width:number,height:number}} | null}
 *   少于 3 点返回 null（不构成面）
 */
export function worldPointsToCustom(worldPts, item, opts = {}) {
  const list = Array.isArray(worldPts) ? worldPts : [];
  const w = num(item && item.width);
  const h = num(item && item.height);
  if (list.length < 3 || !(w > 0) || !(h > 0)) return null;

  const locals = list.map((p) => worldToLocal(p, item));

  // 🔴 画到包围框外的点**不 clamp、不丢**（第一版 clamp 掉 → 旋转 37° 的家具画形状会缺一块，
  //    单测 c7 抓到差 7.5cm）。改成自动把家具的宽高撑到能包住所有点，**中心不动**：
  //    这样形状、命中框、"改宽高"三者始终自洽，用户也不会因为画大了一圈就丢笔画。
  let halfW = w / 2;
  let halfH = h / 2;
  for (const l of locals) {
    if (Math.abs(l.x) > halfW) halfW = Math.abs(l.x);
    if (Math.abs(l.y) > halfH) halfH = Math.abs(l.y);
  }
  const nw = 2 * halfW;
  const nh = 2 * halfH;
  const c = furnitureCenter(item);

  const points = locals.map((l) => ({
    // 本地 [-halfW, halfW] → 归一化 [0, 1]；保留 4 位小数，项目文件不至于被浮点尾巴撑大
    x: Math.round(((l.x + halfW) / nw) * 1e4) / 1e4,
    y: Math.round(((l.y + halfH) / nh) * 1e4) / 1e4,
  }));

  return {
    points,
    closed: opts.closed !== false,
    fill: opts.fill !== false,
    smooth: opts.smooth === true,       // 平滑 = 渲染时用中点贝塞尔（数据仍是点）
    extent: { x: c.x - halfW, y: c.y - halfH, width: nw, height: nh },
  };
}

/**
 * `item.custom.points`（归一化）→ 世界坐标点串。
 *
 * 用途：① 已经画过的形状再次进入编辑器时要能继续改（预填）；② 用例断言。
 * @returns {Array<{x:number,y:number}>} 无效输入返回空数组
 */
export function customToWorldPoints(custom, item) {
  const pts = Array.isArray(custom && custom.points) ? custom.points : null;
  const w = num(item && item.width);
  const h = num(item && item.height);
  if (!pts || !pts.length || !(w > 0) || !(h > 0)) return [];
  return pts.map((p) => localToWorld(
    { x: clamp01(num(p && p.x)) * w - w / 2, y: clamp01(num(p && p.y)) * h - h / 2 },
    item,
  ));
}

/**
 * 清理/校验一份 custom（防止从旧项目或手工编辑带进非法数据）。
 * 非法（点数 < 3、坐标不是数）→ 返回 null，调用方按"没有自定义形状"处理。
 */
export function sanitizeCustom(custom) {
  const pts = Array.isArray(custom && custom.points) ? custom.points : null;
  if (!pts || pts.length < 3) return null;
  const points = [];
  for (const p of pts) {
    const x = Number(p && p.x);
    const y = Number(p && p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    points.push({ x, y });
  }
  return {
    points,
    closed: custom.closed !== false,
    fill: custom.fill !== false,
    smooth: custom.smooth === true,
  };
}
