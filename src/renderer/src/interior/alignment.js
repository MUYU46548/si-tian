/**
 * 对齐与正交（2026-11-15，台账 A26）。
 *
 * 现在画墙/拖墙角只有"网格吸附"：网格 40cm 时，想在别人墙的正对面接一段，只能靠眼睛。
 * 这一层负责三件事，优先级从高到低：
 *
 *   1. **正交约束**（按住 Shift）：从起点只走水平或垂直，取位移大的那个轴；
 *   2. **端点吸附**：靠近别的墙端点（≤ tol）就贴上去 —— 接墙必须严丝合缝，否则房间围不出来；
 *   3. **轴线吸附**：与某面墙的端点共线（x 或 y 相同）时贴到那条线上，画出来的墙才平行对齐；
 *   4. 都不命中时按网格取整（调用方决定，本模块只回 `used: false`）。
 *
 * 纯函数、零依赖（Node 直接可测）。世界单位是 cm，tol 由调用方按缩放换算（屏幕 8px ≈ 8/zoom cm）。
 */

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * 收集吸附目标。
 *
 * @param {Array<object>} walls 墙数组（`{id, start:{x,y}, end:{x,y}}`）
 * @param {Array<string>} excludeIds 当前正在操作的墙（不能吸附到自己的端点，否则永远贴着自己）
 * @returns {{points: Array<{x:number,y:number,wallId:string}>, xs: number[], ys: number[]}}
 */
export function collectTargets(walls, excludeIds = []) {
  const skip = new Set(excludeIds || []);
  const points = [];
  const xs = [];
  const ys = [];
  for (const w of walls || []) {
    if (!w || skip.has(w.id)) continue;
    for (const p of [w.start, w.end]) {
      if (!p) continue;
      const x = num(p.x);
      const y = num(p.y);
      points.push({ x, y, wallId: w.id });
      xs.push(x);
      ys.push(y);
    }
  }
  // 去重（同一处接了好几面墙很常见，重复值只会拖慢比较）
  return { points, xs: [...new Set(xs)], ys: [...new Set(ys)] };
}

/**
 * 算一个落点：正交 / 端点吸附 / 轴线吸附。
 *
 * @param {{x:number,y:number}} pt 光标的世界坐标
 * @param {object} targets `collectTargets` 的结果
 * @param {{tol?:number, orthogonal?:boolean, from?:{x:number,y:number}|null, grid?:number}} opts
 *   · tol：吸附半径（世界单位 cm）
 *   · orthogonal：按住 Shift，从 from 起只走水平/垂直
 *   · from：起点（画墙的起点 / 拖墙时的另一端）；没有就不做正交
 *   · grid：都不命中且给了 grid 时按网格取整（否则原样返回）
 * @returns {{x:number,y:number,used:boolean,guides:{x:number|null,y:number|null},
 *            snapPoint:{x:number,y:number}|null, orthogonal:boolean}}
 */
export function resolveSnap(pt, targets, opts = {}) {
  const tol = Math.max(0, num(opts.tol, 8));
  const t = targets || { points: [], xs: [], ys: [] };
  const grid = num(opts.grid, 0);
  const from = opts.from && Number.isFinite(Number(opts.from.x)) ? { x: num(opts.from.x), y: num(opts.from.y) } : null;

  let x = num(pt && pt.x);
  let y = num(pt && pt.y);
  const guides = { x: null, y: null };

  // ① 正交：先定主方向（谁位移大听谁的），再把另一轴钉回起点
  let orthogonal = false;
  if (opts.orthogonal && from) {
    const dx = x - from.x;
    const dy = y - from.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      y = from.y;
      guides.y = from.y;          // 水平走 → 横向基准线
    } else {
      x = from.x;
      guides.x = from.x;
    }
    orthogonal = true;
  }

  // ② 端点吸附（正交时不吸：正交只允许沿一个方向，吸端点会把方向掰弯）
  let snapPoint = null;
  if (!orthogonal) {
    let best = Infinity;
    for (const p of t.points) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < best && d <= tol) {
        best = d;
        snapPoint = p;
      }
    }
    if (snapPoint) {
      x = snapPoint.x;
      y = snapPoint.y;
      guides.x = snapPoint.x;
      guides.y = snapPoint.y;
    }
  }

  // ③ 轴线吸附：在还没被钉住的轴上，找最近的共线目标
  if (!snapPoint) {
    if (guides.x === null) {
      let best = Infinity;
      for (const v of t.xs) {
        const d = Math.abs(v - x);
        if (d < best && d <= tol) { best = d; guides.x = v; }
      }
      if (guides.x !== null) x = guides.x;
    }
    // 正交时 y 已被钉在 from 上，不许再被别的横线拉走
    if (guides.y === null && !orthogonal) {
      let best = Infinity;
      for (const v of t.ys) {
        const d = Math.abs(v - y);
        if (d < best && d <= tol) { best = d; guides.y = v; }
      }
      if (guides.y !== null) y = guides.y;
    }
  }

  const used = !!(snapPoint || guides.x !== null || guides.y !== null || orthogonal);

  // ④ 网格兜底：只在完全没有吸附时生效（吸附优先于网格，否则网格会把吸附结果拉歪）
  if (!used && grid > 0) {
    x = Math.round(x / grid) * grid;
    y = Math.round(y / grid) * grid;
  } else if (!used) {
    x = Math.round(x);
    y = Math.round(y);
  }

  return {
    x, y, used, orthogonal, guides, snapPoint: snapPoint ? { x: snapPoint.x, y: snapPoint.y } : null,
  };
}

/**
 * 正交投影（拖家具/单点用：没有"起点"，只把落点钉到最近的水平或垂直线上）。
 * 与 `resolveSnap` 分开是因为"从某点出发"和"自带方向"是两种语义，混在一起会让调用方难读。
 */
export function projectOrthogonal(pt, guides, tol = 8) {
  let x = num(pt && pt.x);
  let y = num(pt && pt.y);
  const gx = guides && Number.isFinite(Number(guides.x)) ? num(guides.x) : null;
  const gy = guides && Number.isFinite(Number(guides.y)) ? num(guides.y) : null;
  if (gx !== null && Math.abs(gx - x) <= tol && Math.abs(gx - x) <= Math.abs((gy === null ? Infinity : gy - y))) {
    x = gx;
  } else if (gy !== null && Math.abs(gy - y) <= tol) {
    y = gy;
  }
  return { x, y };
}
