// galaxy/territory.js —— 星域「所有权场 φ」软融合边界（**吸收自 SP-1025 `core/territory.ts` + `render/regions.ts`**）
//
// ── 为什么不再是凸包（用户 2026-11-01 的原话：「星域总览还是旧版，一坨狗屎」）──────────────
// 凸包是**折线**：它在两颗星之间拉一条直边，旁边留一个尖角，星域之间互不相让 ——
// 观感像「几个多边形贴纸」而不是「一片片领土」。原型那套不用多边形，用**场**：
//
//   effD_i(p) = (d_i(p) + wobble_i(p)·fade(d_i)) / weight_i
//   φ_i(p)    = min( claim_i − d_i(p),  min_{j≠i} effD_j(p) − effD_i(p) )
//
// 性质（`scripts/tests/unit/test_galaxy_territory.js` 固化）：
//   ① argmin 互斥 ⇒ 任意 p 至多属于一个星域，**色块零重叠**；
//   ② 相邻两个星域在「谁更近」翻转的那条线上**共享同一条零等值线** ⇒ 贴合、无缝；
//   ③ wobble 是低频正弦（波长 ~600 世界单位）并在成员附近归零 ⇒ 边界走大波浪，不抖成锯齿；
//   ④ claim 半径把领土截在自己的星星附近 ⇒ 不会顺着坐标系漫到天边。
//
// ⚠️ 与原型的两处差异（司天必须这样）：
//   · 司天的星系是**稀疏**的（一个星域几颗），原型是 120 颗铺满盘面。直接用「最近成员距离」当 d
//     会让边界变成一串小圆（花瓣状）→ 这里 d 取到**星域中心**的距离，成员数量只影响权重 claim。
//   · 边界必须**可编辑**：用户拖过的星域仍走覆盖点（`points` 逐点可拖）。
//     场派生的形状只给到「重采样后的 14 点」当手柄（`border.soft = true`），点一下才转成覆盖点。
//
// 本模块是**纯函数**（无 DOM、无 store），画布与「导出 PNG(全图)」都调它（同源红线）。

/** 场的默认参数（画布与导出同值；改这里 = 改两边） */
export const TERRITORY = {
  gridStep: 8,          // 世界单位/格；8 在 350 半径的星域上是 0.023 的相对精度
  wobbleAmp: 42,        // 边界波浪幅值（世界单位；实际按 claim 的比例自适应，见 buildFieldInputs）
  wobbleFadeDist: 150,  // d 小于它的地方波浪归零（保证色块包住自己的星）
  claimPad: 1.16,       // claim 半径 = 中心到最远恒星 × 该系数
  claimGapRatio: 0.62,  // claim 要**超过**与邻居的中点（0.5）才有「两家共享同一条边」的融合感，
                        // 只到 0.47 时四块领土之间永远隔着一条真空带（第一版实测：像四个圆点）
  claimMin: 210,        // 没有恒星时的兜底半径（星域半径 350 的 0.6，比 12 边形好看）
  claimMax: 900,
  chaikinIters: 2,
  minLoopArea: 900,     // 小于它的环当噪声丢掉（世界单位²）
  resampleN: 14,        // 可编辑手柄点数（软形状点一下转覆盖点时的点数）
};

/** 确定性浮点（场里不许有 Math.random，同输入必须同一边界） */
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * 有机轮廓扰动：**按角度**的三组低频正弦叠加（相对星域中心）。
 * 旧实现用世界坐标上的平面正弦 —— 得到的是"稍微不圆的圆"，半径 400 的领土上看起来仍是正圆。
 * 按角度取 2/3/5 阶 lobes 才能得到参照图那种「两三个大瓣」的轮廓；
 * 幅值按半径归一（返回 [-amp, amp]），所以小星域不会抖成锯齿。
 */
export function wobbleAt(px, py, cx, cy, salt, amp) {
  const dx = px - cx;
  const dy = py - cy;
  const th = Math.atan2(dy, dx);
  const p1 = Math.sin(salt * 0.917) * 6.283;
  const p2 = Math.sin(salt * 1.331 + 2.1) * 6.283;
  const p3 = Math.sin(salt * 0.573 + 4.7) * 6.283;
  const v = 0.52 * Math.sin(3 * th + p1)
    + 0.28 * Math.sin(5 * th + p2)
    + 0.20 * Math.sin(2 * th + p3);
  return v * amp;
}

/** 扰动在恒星附近归零：d < fadeDist 时线性压到 0 */
export function wobbleFade(d, fadeDist) {
  return clamp(d / Math.max(1, fadeDist), 0, 1);
}

/**
 * 单个星域在 p 点的**原始**归属判定量（无 claim 截断）。
 * 拆出来是为了让 Node 单测能直接验「argmin 互斥」而不必跑整张网格。
 */
export function effectiveDistance(domain, p, salt) {
  const d = Math.hypot(p.x - domain.x, p.y - domain.y);
  const w = domain.weight || 1;
  const amp = domain.wobbleAmp || TERRITORY.wobbleAmp;
  const wob = wobbleAt(p.x, p.y, domain.x, domain.y, salt + domain.saltOffset, amp)
    * wobbleFade(d, TERRITORY.wobbleFadeDist);
  return (d + wob) / w;
}

/** 星域的「带波浪的距离」（不含权重）—— claim 截断与 bisector 必须吃同一个 wobble */
export function wobbleDistance(domain, p, salt) {
  const d = Math.hypot(p.x - domain.x, p.y - domain.y);
  const amp = domain.wobbleAmp || TERRITORY.wobbleAmp;
  return d + wobbleAt(p.x, p.y, domain.x, domain.y, salt + domain.saltOffset, amp)
    * wobbleFade(d, TERRITORY.wobbleFadeDist);
}

/**
 * φ_i(p)：星域 i 在 p 点的所有权裕度（>0 = i 的领土）。
 * 单星域文档退化为「以自己为中心、claim 为半径的圆盘」。
 */
export function ownershipGap(domains, i, p, salt) {
  const own = effectiveDistance(domains[i], p, salt);
  const claim = (domains[i].claim || TERRITORY.claimMin) - wobbleDistance(domains[i], p, salt);
  let nearestForeign = Infinity;
  for (let j = 0; j < domains.length; j++) {
    if (j === i) continue;
    const eff = effectiveDistance(domains[j], p, salt);
    if (eff < nearestForeign) nearestForeign = eff;
  }
  return Math.min(claim, nearestForeign - own);
}

/**
 * 线段拼接：marching squares 产出的零散线段 → 闭合环。
 * 端点按 1e-3 量化做键（同一格边上的交点由两侧格各自算出，浮点只差末位）。
 */
function stitchSegments(segments) {
  const key = (p) => `${Math.round(p.x * 1000)}:${Math.round(p.y * 1000)}`;
  const byKey = new Map();
  segments.forEach((s, i) => {
    for (const end of [0, 1]) {
      const k = key(end === 0 ? s.a : s.b);
      let list = byKey.get(k);
      if (!list) { list = []; byKey.set(k, list); }
      list.push({ i, end });
    }
  });
  const used = new Uint8Array(segments.length);
  const loops = [];
  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = 1;
    const first = segments[start];
    const loop = [first.a, first.b];
    let guard = 0;
    while (guard++ < segments.length + 8) {
      const tail = loop[loop.length - 1];
      const cands = byKey.get(key(tail)) || [];
      let next = -1;
      for (const c of cands) {
        if (used[c.i]) continue;
        next = c.i;
        break;
      }
      if (next < 0) break;
      used[next] = 1;
      const sg = segments[next];
      const far = key(sg.a) === key(tail) ? sg.b : sg.a;
      loop.push(far);
      if (key(far) === key(loop[0])) { loop.pop(); break; }
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

/**
 * Marching squares（线性插值版）。返回**世界坐标**闭合环数组。
 * 鞍点（对角两角为正）把四个交点按顺序两两相连 —— 对平滑后的观感没有影响，但保证线段一定配平。
 */
export function marchingSquares(values, nx, ny, minX, minY, step, iso = 0) {
  const v = (i, j) => values[j * nx + i];
  const segments = [];
  const interp = (a, b, pa, pb) => {
    const t = Math.abs(b - a) < 1e-9 ? 0.5 : (iso - a) / (b - a);
    return { x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t };
  };
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const v0 = v(i, j), v1 = v(i + 1, j), v2 = v(i + 1, j + 1), v3 = v(i, j + 1);
      const in0 = v0 > iso, in1 = v1 > iso, in2 = v2 > iso, in3 = v3 > iso;
      const mask = (in0 ? 1 : 0) | (in1 ? 2 : 0) | (in2 ? 4 : 0) | (in3 ? 8 : 0);
      if (mask === 0 || mask === 15) continue;
      const P0 = { x: minX + i * step, y: minY + j * step };
      const P1 = { x: minX + (i + 1) * step, y: minY + j * step };
      const P2 = { x: minX + (i + 1) * step, y: minY + (j + 1) * step };
      const P3 = { x: minX + i * step, y: minY + (j + 1) * step };
      const pts = [];
      if (in0 !== in1) pts.push(interp(v0, v1, P0, P1)); // 下边
      if (in1 !== in2) pts.push(interp(v1, v2, P1, P2)); // 右边
      if (in3 !== in2) pts.push(interp(v3, v2, P3, P2)); // 上边
      if (in0 !== in3) pts.push(interp(v0, v3, P0, P3)); // 左边
      for (let k = 0; k + 1 < pts.length; k += 2) {
        segments.push({ a: pts[k], b: pts[k + 1] });
      }
    }
  }
  return stitchSegments(segments);
}

/** Chaikin 圆角（闭合环；0.75/0.25），与 `utils/gridOutline.js#chaikinLoop` 同一规则但收点对象 */
export function chaikinClosed(loop, iters = 2) {
  let pts = loop.map((p) => ({ x: p.x, y: p.y }));
  if (pts.length < 3) return pts;
  for (let it = 0; it < iters; it++) {
    const out = new Array(pts.length * 2);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      out[i * 2] = { x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 };
      out[i * 2 + 1] = { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 };
    }
    pts = out;
  }
  return pts;
}

/** 鞋带公式面积（世界单位²，取绝对值） */
export function loopArea(loop) {
  let s = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** 环的面积质心（与 `hullCenter` 同口径：凸环与凹环都能用） */
export function loopCentroid(loop) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i], q = loop[(i + 1) % loop.length];
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sy = 0;
    for (const p of loop) { sx += p.x; sy += p.y; }
    return { x: sx / loop.length, y: sy / loop.length };
  }
  a *= 0.5;
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

/** 按弧长等距重采样成 n 个点（给「软形状 → 可拖手柄」用） */
export function resampleLoop(loop, n = TERRITORY.resampleN) {
  if (!loop || loop.length < 3) return [];
  const pts = loop.concat([loop[0]]);
  const seg = [];
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    seg.push(len);
    total += len;
  }
  if (total < 1e-6) return [];
  const out = [];
  let target = 0, segIdx = 0, acc = 0;
  for (let k = 0; k < n; k++) {
    target = (total * k) / n;
    while (segIdx < seg.length - 1 && acc + seg[segIdx] < target) {
      acc += seg[segIdx];
      segIdx++;
    }
    const t = seg[segIdx] < 1e-9 ? 0 : (target - acc) / seg[segIdx];
    out.push({
      x: pts[segIdx].x + (pts[segIdx + 1].x - pts[segIdx].x) * t,
      y: pts[segIdx].y + (pts[segIdx + 1].y - pts[segIdx].y) * t,
    });
  }
  return out;
}

/** 点到折线（闭合）的最近距离 —— 编辑态「点边界就开始改」的命中判定 */
export function distanceToLoop(loop, x, y) {
  let best = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 < 1e-9 ? 0 : ((x - a.x) * dx + (y - a.y) * dy) / len2;
    t = clamp(t, 0, 1);
    const d = Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
    if (d < best) best = d;
  }
  return best;
}

/**
 * 星域 → 场的输入。**唯一入口**：`factionBorders` 调它，单测也调它。
 * @param {Array} domainNodes 已经过 `layoutDomains` 的星域（有 x/y）
 * @param {Array} galaxyNodes 已经过 `layoutGalaxies` 的星系（有 x/y/domainId）
 * @param {{salt?:number}} [opts]
 */
export function buildFieldInputs(domainNodes, galaxyNodes, opts = {}) {
  const byDomain = new Map();
  for (const g of galaxyNodes || []) {
    if (!byDomain.has(g.domainId)) byDomain.set(g.domainId, []);
    byDomain.get(g.domainId).push(g);
  }
  const list = domainNodes || [];
  let gcx = 0, gcy = 0;
  for (const d of list) { gcx += d.x; gcy += d.y; }
  if (list.length) { gcx /= list.length; gcy /= list.length; }
  return list.map((d, idx) => {
    const galaxies = byDomain.get(d.id) || [];
    let maxDist = 0;
    for (const g of galaxies) {
      const dd = Math.hypot(g.x - d.x, g.y - d.y);
      if (dd > maxDist) maxDist = dd;
    }
    // 最近邻星域距离：只用来判「星域排得开不开」（决定 wobble 幅值上限），**不再参与 claim**。
    // 第一版把 claim 抬到「最近邻的一半以上」去消灭真空带，结果四块领土变成四条**扇形楔子**，
    // 环心成了四家对撞点（实测图 t5：一条"米"字分割线，比凸包还难看）。
    let nn = Infinity;
    for (const other of list) {
      if (other === d) continue;
      const dd = Math.hypot(other.x - d.x, other.y - d.y);
      if (dd < nn) nn = dd;
    }
    // claim 跟着**自己的恒星散布**走：星域是一簇星，领土就该包住这一簇星 + 一圈余量。
    // 相邻星域中间留暗带没关系（星与星之间本来就是真空），重点是轮廓要有自己的形状。
    const claim = clamp(
      (maxDist || TERRITORY.claimMin / TERRITORY.claimPad) * TERRITORY.claimPad + 60,
      TERRITORY.claimMin,
      Math.min(TERRITORY.claimMax, Number.isFinite(nn) ? nn * 0.72 : TERRITORY.claimMax),
    );
    // 权重：星星多的星域 claim 更远（版图不对称，但同一个星域永远同一个权重）
    const weight = clamp(1 + 0.05 * Math.sqrt(galaxies.length), 1, 1.32);
    return {
      id: d.id,
      name: d.name,
      x: d.x,
      y: d.y,
      color: d.factionColor,
      claim,
      // 波浪幅值跟着 claim 走：半径 430 的领土上 42 的幅值只是"稍微不圆"，
      // 要的是能看到 2~3 个大瓣（参照原型成品图7 的轮廓）。
      wobbleAmp: clamp(claim * 0.26, 30, 88),
      weight,
      saltOffset: (idx * 17.17) + (opts.salt || 0),
      galaxyCount: galaxies.length,
    };
  });
}

/**
 * 所有权场 → 每个星域的闭合环（世界坐标）。
 * 网格只跑一遍（argmin 互斥 ⇒ 一个格点只有一个星域 φ>0），逐星域再抽那一条场。
 * @returns {Array<{domainId:string, loops:Array<Array<{x,y}>>, area:number, fadeRadius:number}>}
 */
export function computeDomainShapes(fieldInputs, opts = {}) {
  const domains = fieldInputs || [];
  if (!domains.length) return [];
  const step = opts.gridStep || TERRITORY.gridStep;
  const salt = opts.salt || 0;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of domains) {
    const r = d.claim + TERRITORY.wobbleAmp * 2 + step * 2;
    if (d.x - r < minX) minX = d.x - r;
    if (d.y - r < minY) minY = d.y - r;
    if (d.x + r > maxX) maxX = d.x + r;
    if (d.y + r > maxY) maxY = d.y + r;
  }
  const nx = Math.max(2, Math.ceil((maxX - minX) / step) + 1);
  const ny = Math.max(2, Math.ceil((maxY - minY) / step) + 1);

  const bestIdx = new Int16Array(nx * ny).fill(-1);
  const bestPhi = new Float32Array(nx * ny);

  for (let j = 0; j < ny; j++) {
    const y = minY + j * step;
    for (let i = 0; i < nx; i++) {
      const p = { x: minX + i * step, y };
      let bi = -1, bEff = Infinity, second = Infinity;
      const effs = new Array(domains.length);
      for (let f = 0; f < domains.length; f++) {
        const eff = effectiveDistance(domains[f], p, salt);
        effs[f] = eff;
        if (eff < bEff) { second = bEff; bEff = eff; bi = f; }
        else if (eff < second) second = eff;
      }
      if (bi < 0) continue;
      const claimGap = domains[bi].claim - wobbleDistance(domains[bi], p, salt);
      const phi = domains.length === 1 ? claimGap : Math.min(claimGap, second - bEff);
      bestIdx[j * nx + i] = bi;
      bestPhi[j * nx + i] = phi;
    }
  }

  const out = [];
  const grid = new Float32Array(nx * ny);
  for (let f = 0; f < domains.length; f++) {
    grid.fill(-1);
    for (let k = 0; k < grid.length; k++) {
      if (bestIdx[k] === f) grid[k] = bestPhi[k];
    }
    const raw = marchingSquares(grid, nx, ny, minX, minY, step, 0);
    const loops = [];
    for (const loop of raw) {
      if (loopArea(loop) < TERRITORY.minLoopArea) continue;
      loops.push(chaikinClosed(loop, TERRITORY.chaikinIters));
    }
    if (!loops.length) continue;
    loops.sort((a, b) => loopArea(b) - loopArea(a));
    let fadeRadius = 1;
    for (const p of loops[0]) {
      const d = Math.hypot(p.x - domains[f].x, p.y - domains[f].y);
      if (d > fadeRadius) fadeRadius = d;
    }
    out.push({
      domainId: domains[f].id,
      loops,
      area: loopArea(loops[0]),
      center: { x: domains[f].x, y: domains[f].y },
      fadeRadius,
    });
  }
  return out;
}
