// utils/galaxyLayout.js — 星系/星域视图的**布局 + 配色 + 几何**唯一实现（纯函数，Node 可测；2026-10-18 第十二修）
//
// ── 为什么必须有它（§bug 导出与画布不同源）────────────────────────────────────
// “导出 PNG(全图)”在 `App.vue` 里是**第三套实现**，与画布各写一份，于是同一份数据在两张图上不一样：
//   · **坐标源**：导出用 `node.coordinate`，画布用 `applyStableLayout` 的布局坐标 ——
//     自动布局的节点画在环形/簇内位置上，而它的 `coordinate` 是别处的旧值 → 导出图与画布**位置对不上**；
//     更糟的是**没有 coordinate 的节点被导出直接跳过**（`if (n.coordinate?.x === null) return;`）→ 整幅图缺节点。
//   · **势力配色**：导出按名字哈希 `hsl()`，画布按 `resolveDomainColor()`（节点 factionColor 优先）→ 两种颜色。
//   · **恒星颜色**：导出固定 `#ffd700`，画布用势力的 `factionColor`。
//   · **凸包外扩**：导出 25、画布 50；星系数 < 3 时导出**跳过**该星域，画布画一个 12 边形。
//   · **航道配色**：画布 4 类（跨域紫 / 跳跃红 / **用户建的绿** / 自动的蓝），导出 3 类。
// 这些差异**一条都不会报错**，只会让"导出的图和屏幕上的不是一回事"。
//
// 本模块把上面这些判定收成一份纯函数：**画布与导出都调它**（`test_117` 的源码闸门守"两边都 import 它、
// 且 `App.vue` 不许再自带第二套"）。判据（Node `test_galaxy_layout.js`）盯的是函数本身的口径。
//
// ⚠️ **背景星云/星尘不在共享范围**（`STARFIELD` 只导出常量供两边取用同一条谱）：它是装饰、无信息量，
//    画布按世界坐标铺、导出按图幅裁；这条取舍写进交接文档，不装作"全都同源了"。
//
// 2026-11-02：**边界从凸包改成所有权场 φ 软融合**（吸收 SP-1025 `core/territory.ts`）。
//    场的数学在 `galaxy/territory.js`（纯函数），这里是唯一消费口 —— 画布、导出、命中测试都走它。
//    `convexHull` / `expandHull` 仍导出（历史调用与单测还在用），但**不再参与边界绘制**。

// ⚠️ 显式写 `.js`：这份模块被 Node 单测**复制到临时目录当 ESM 跑**（`test_galaxy_layout.js`），
//    无扩展名的相对 import 在 Node ESM 下解析不了（Vite 能解析，Node 不能）。
import { buildFieldInputs, computeDomainShapes, resampleLoop, TERRITORY } from '../galaxy/territory.js';

/** 势力 → 固定色板（**唯一实现**：原先 store 与 GalaxyMap 各有一份同形表） */
export const FACTION_COLORS = {
  '蓝镜帝国': '#4A90D9',
  '绿野联邦': '#5CB85C',
  '赤焰王国': '#E74C3C',
  '紫晶商会': '#9B59B6',
  '金辉共和国': '#F39C12',
  '青霜联盟': '#1ABC9C',
  '橙光同盟': '#E67E22',
  '银月帝国': '#95A5A6',
};

/** 未归属星域的默认色 */
export const DEFAULT_FACTION_COLOR = '#6b5b95';

/** 势力名 → 颜色（表内直取；表外按名字哈希出确定性 hsl） */
export function getFactionColor(faction) {
  if (!faction) return DEFAULT_FACTION_COLOR;
  if (FACTION_COLORS[faction]) return FACTION_COLORS[faction];
  let hash = 0;
  for (let i = 0; i < faction.length; i++) {
    hash = faction.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 60%)`;
}

/**
 * 星域当前颜色的**唯一解析口**（图例 / 画布 / 边界 / 导出四处共用）。
 * 优先级：① 运行期预览覆盖（**按 domain.id**）② 节点持久化的 `factionColor` ③ 按势力名推的默认色。
 */
export function resolveDomainColor(domain, overrides) {
  if (!domain) return DEFAULT_FACTION_COLOR;
  const ov = overrides && overrides[domain.id];
  if (ov) return ov;
  if (domain.factionColor) return domain.factionColor;
  return getFactionColor(domain.faction);
}

/** 布局常量（**唯一实现**：导出与画布不许各拿一套数字） */
export const GALAXY_LAYOUT = {
  domainSpacing: 700,
  ringFactor: 0.9,          // 星域环形半径 = 700 * 0.9 = 630
  domainRadius: 350,
  galaxyBaseDist: 100,
  galaxyDistStep: 60,       // dist = base + (idx % 4) * step
  galaxyAngleOffset: 0.3,
  hullPad: 50,              // 凸包外扩（原先画布 50 / 导出 25 —— 统一取画布值）
  circleSegments: 12,       // 星系数 < 3 时的多边形边数
  minHullPoints: 3,
  fieldSalt: 20261102,      // 所有权场波浪的固定盐（同项目同项目、换项目换形状，且可复现）
  domainShape: '',          // 星域排布形态：'' = 按星域数自动切（见 autoDomainShape）；ring / disc / spiral 可强制
  domainSeed: 20261102,     // 形态采样种子（同项目恒定）
  minDomainGap: 760,        // 任意两个星域中心的**最小间距**（与生成器 toSiTianEntities 同量级：
                            //   星域半径 350 + claim 余量，低于这个数领土就会出现"一块压着另一块"）
  discMinCount: 7,          // ≥7 个星域才摆"盘"：环上相邻间距 = 2·630·sin(π/n)，n=7 时只剩 546，
                            //   小于两倍星域半径（700）→ 圆已经开始压；小数量时环反而更舒展（实测出图）
  spiralMinCount: 8,        // ≥8 个星域才读得出螺旋臂（4 个时螺旋退化成一横排）
};

/** 凸包（Graham Scan，**唯一实现**：`App.vue` 的 `convexHullForExport` 已删） */
export function convexHull(points) {
  const pts = Array.isArray(points) ? points.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y)) : [];
  if (pts.length < 3) return pts.map(p => ({ x: p.x, y: p.y }));
  const sorted = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (O, A, B) => (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** 凸包中心（质心） */
export function hullCenter(hull) {
  if (!hull || !hull.length) return { x: 0, y: 0 };
  let x = 0, y = 0;
  for (const p of hull) { x += p.x; y += p.y; }
  return { x: x / hull.length, y: y / hull.length };
}

/** 凸包沿质心方向外扩 `pad`（唯一实现：画布与导出同值） */
export function expandHull(hull, pad = GALAXY_LAYOUT.hullPad) {
  const c = hullCenter(hull);
  return hull.map(p => {
    const dx = p.x - c.x, dy = p.y - c.y;
    const d = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / d) * pad, y: p.y + (dy / d) * pad };
  });
}

/**
 * 星域布局。**只有 `userMoved`（或正在拖动）才采信 `coordinate`** ——
 * 提取器给每个星域都写了遗留 coordinate，无条件采信会让老项目一次性全部错位（见 test_116 f5）。
 *
 * 2026-11-02（抄群星）：新增 `shape` —— 群星的银河是**盘/螺旋臂/环带**，我们一直是"环"。
 * 形态采样直接移植原型 `core/generator.ts#sampleShape`（同一套公式：disc 用 u^1.4 的核密度梯度、
 * spiral 用对数螺线 + 高斯抖动、ring 用 0.52~1 的环带）。
 *
 * 2026-11-03（用户"其他继续做"）：**默认不再恒定是环**，按星域数自动切（`autoDomainShape`）：
 *   · ≤6 → ring（小数量时环最舒展；3 个点摆盘会退化成一条线，实测出图见 build/domain-layout/preview.png）；
 *   · 7 → disc —— 环在 n=7 时相邻中心只剩 546 < 700（两倍星域半径），圆开始互相压，必须换布局；
 *   · ≥8 → spiral（3 条对数螺线臂）—— 实测 4 个星域时螺旋退化成一横排，所以门槛是 8。
 * 采样完再按 `minDomainGap`（760）把整组中心拉开：星与星的相对形状基本不变，只把整团撑开，
 * 保证领土不互相压（与生成器 `toSiTianEntities` 同一条判据）。
 * `window.__SITIAN_DOMAIN_SHAPE__` 与 `opts.shape` 仍可强制覆盖（调形态用）。
 * @param {Array} domains
 * @param {{draggingId?:string, overrides?:object, shape?:'ring'|'disc'|'spiral', seed?:number}} [opts]
 */
export function layoutDomains(domains, opts = {}) {
  const list = Array.isArray(domains) ? domains : [];
  const count = list.length;
  // 环半径：默认 630；但 n≥5 时 630 上的相邻间距已经不够（n=6 只剩 630 < 700），
  // 按"相邻中心 ≥ minDomainGap"反解半径，保证环上也不压（n≤4 反解值 < 630，仍取 630）。
  const ringRadius = count > 1
    ? Math.max(
      GALAXY_LAYOUT.domainSpacing * GALAXY_LAYOUT.ringFactor,
      GALAXY_LAYOUT.minDomainGap / (2 * Math.sin(Math.PI / count)),
    )
    : 0;
  const radius = ringRadius;
  const shape = opts.shape
    || (typeof window !== 'undefined' && window.__SITIAN_DOMAIN_SHAPE__)
    || GALAXY_LAYOUT.domainShape
    || autoDomainShape(count);
  // 盘/螺旋：先按形态采样出一组**互不重叠**的中心点（确定性），再按 id 顺序分配
  let placed = null;
  if (shape !== 'ring' && count > 1) {
    placed = sampleDomainCenters(count, shape, opts.seed || GALAXY_LAYOUT.domainSeed, radius);
  }
  return list.map((domain, idx) => {
    const angle = (idx / Math.max(count, 1)) * Math.PI * 2 - Math.PI / 2;
    const saved = (domain.userMoved || domain.id === opts.draggingId)
      && domain.coordinate && Number.isFinite(domain.coordinate.x) && Number.isFinite(domain.coordinate.y);
    const fallback = placed ? placed[idx] : {
      x: count > 1 ? Math.cos(angle) * radius : 0,
      y: count > 1 ? Math.sin(angle) * radius : 0,
    };
    return {
      ...domain,
      x: saved ? domain.coordinate.x : fallback.x,
      y: saved ? domain.coordinate.y : fallback.y,
      factionColor: resolveDomainColor(domain, opts.overrides),
      radius: GALAXY_LAYOUT.domainRadius,
    };
  });
}

/** mulberry32（与 sky.js / FMG 同族；布局里不许碰 Math.random） */
function _rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 形态采样（移植自原型 `core/generator.ts#sampleShape`）：
 *   disc  = 核密椭圆盘（u^1.4，中心密、边缘疏）
 *   spiral= 对数螺线旋臂（3.1·ln(1+5.2r) 的臂偏角 + 高斯抖动）
 *   ring  = 环带（0.52~1.0）
 */
export function sampleDomainShape(shape, rx, ry, rnd, arms = 3) {
  const u = rnd();
  const ang0 = rnd() * Math.PI * 2;
  if (shape === 'spiral') {
    const arm = Math.floor(rnd() * arms);
    const rr = 0.16 + 0.84 * Math.pow(u, 0.85);
    const ang = (arm * Math.PI * 2) / arms + 3.1 * Math.log(1 + 5.2 * rr) + (rnd() - 0.5) * 0.26;
    return { x: Math.cos(ang) * rr * rx, y: Math.sin(ang) * rr * ry };
  }
  if (shape === 'ring') {
    const rr = 0.52 + 0.48 * Math.pow(u, 0.9);
    return { x: Math.cos(ang0) * rr * rx, y: Math.sin(ang0) * rr * ry };
  }
  const rr = Math.pow(u, 1.4);
  return { x: Math.cos(ang0) * rr * rx, y: Math.sin(ang0) * rr * ry };
}

/**
 * 按星域数自动选形态（**唯一实现**：`layoutDomains` 与用例都走这里，别各写一套门槛）。
 * ≤6 → ring（小数量时环最舒展）｜7 → disc｜≥8 → spiral（4 个星域时螺旋退化成一横排，实测）。
 */
export function autoDomainShape(count) {
  const n = Math.max(0, Number(count) || 0);
  if (n >= GALAXY_LAYOUT.spiralMinCount) return 'spiral';
  if (n >= GALAXY_LAYOUT.discMinCount) return 'disc';
  return 'ring';
}

/** 一组点的最小两两距离（判定"领土会不会互相压"用） */
function minPairDistance(points) {
  let min = Infinity;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
      if (d < min) min = d;
    }
  }
  return min;
}

/**
 * 把一组中心点彼此推开，直到任意两点 ≥ `minGap`。
 * 为什么不能只靠"等比放大"：采样兜底点可能与已有点几乎重合，等比放大会把整团吹到天边（实测 n=10 时
 * 半径从 ~1,200 炸到 ~34,000）。所以先用确定性的**两两松弛**把压在一起的点推开，形状只微调。
 */
function relaxCenters(points, minGap, iters = 80) {
  const pts = (points || []).map(p => ({ x: p.x, y: p.y }));
  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        let dx = pts[j].x - pts[i].x;
        let dy = pts[j].y - pts[i].y;
        let d = Math.hypot(dx, dy);
        if (d >= minGap) continue;
        if (d < 1e-6) {
          // 完全重合：按 (i,j) 给一个确定方向推开（不许用 Math.random，布局必须可复现）
          const a = i * 2.399963 + j * 1.618034;
          dx = Math.cos(a); dy = Math.sin(a);
        } else {
          dx /= d; dy /= d;
        }
        const push = (minGap - d) / 2 + 0.5;
        pts[i].x -= dx * push; pts[i].y -= dy * push;
        pts[j].x += dx * push; pts[j].y += dy * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return pts;
}

/**
 * 把一组中心点拉开到任意两点 ≥ `minGap`：**先两两松弛，再以质心等比放大补足**。
 * 星与星之间的相对形状基本不变（盘的"近核密、边缘疏"不会被破坏）。
 * 布局坐标不落盘（只有 `userMoved` 才落），放大不会改用户数据。
 */
export function expandCentersToGap(points, minGap = GALAXY_LAYOUT.minDomainGap) {
  const pts = relaxCenters(points, minGap);
  if (pts.length < 2 || !(minGap > 0)) return pts;
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;
  // 残余压紧（松弛没到位）：放大倍率封顶 1.6，最多 4 轮 —— 宁可略近一点也不炸到天边
  for (let iter = 0; iter < 4; iter++) {
    const min = minPairDistance(pts);
    if (min >= minGap) break;
    const k = Math.min(1.6, (minGap / Math.max(min, 1e-6)) * 1.002);
    for (const p of pts) {
      p.x = cx + (p.x - cx) * k;
      p.y = cy + (p.y - cy) * k;
    }
  }
  return pts;
}

/** 在形态上撒 count 个互不重叠的星域中心（先按采样间距散开，再整体放大到 `minDomainGap`） */
export function sampleDomainCenters(count, shape, seed, radius) {
  const rnd = _rng(seed >>> 0);
  // 星域一多，630 的采样盘装不下（拒采 400 次也放不进 → 全掉进环形兜底，螺旋就白采了）。
  // 采样盘按 √n 放大：形态不变、点够散，最后再统一放大到 minDomainGap。
  const fieldScale = Math.max(1, Math.sqrt(Math.max(count, 1) / 3));
  const rx = radius * fieldScale;
  const ry = radius * 0.74 * fieldScale;    // 椭圆盘：群星的银河是扁的
  const sampleGap = GALAXY_LAYOUT.minDomainGap * 0.65;
  const arms = 3;
  const out = [];
  for (let i = 0; i < count; i++) {
    let best = null;
    for (let attempt = 0; attempt < 800; attempt++) {
      const p = sampleDomainShape(shape, rx, ry, rnd, arms);
      let ok = true;
      for (const q of out) {
        if (Math.hypot(q.x - p.x, q.y - p.y) < sampleGap) { ok = false; break; }
      }
      if (ok) { best = p; break; }
    }
    // 兜底：按环摆（保证一定放得下，不产生 NaN / 重叠堆在一起）
    if (!best) {
      const a = (i / Math.max(count, 1)) * Math.PI * 2 - Math.PI / 2;
      best = { x: Math.cos(a) * rx, y: Math.sin(a) * ry };
    }
    out.push(best);
  }
  return expandCentersToGap(out, GALAXY_LAYOUT.minDomainGap);
}

/**
 * 星系布局：按 `parentId` 分组摆进所属星域（环形簇），
 * **手动摆过（`userMoved`）且坐标仍落在星域半径内**的星系保留自己的坐标。
 */
export function layoutGalaxies(galaxies, domainNodes, opts = {}) {
  const list = Array.isArray(galaxies) ? galaxies : [];
  const domainMap = new Map((domainNodes || []).map(d => [d.id, d]));
  const byParent = new Map();
  for (const g of list) {
    if (!byParent.has(g.parentId)) byParent.set(g.parentId, []);
    byParent.get(g.parentId).push(g);
  }
  const out = [];
  for (const [pid, group] of byParent) {
    const parentDomain = domainMap.get(pid);
    if (!parentDomain) continue;          // 父星域不在当前世界 → 不画（与画布一致）
    const total = group.length;
    group.forEach((galaxy, idx) => {
      const angle = (idx / Math.max(total, 1)) * Math.PI * 2 + GALAXY_LAYOUT.galaxyAngleOffset;
      const dist = GALAXY_LAYOUT.galaxyBaseDist + (idx % 4) * GALAXY_LAYOUT.galaxyDistStep;
      let gx = parentDomain.x + Math.cos(angle) * dist;
      let gy = parentDomain.y + Math.sin(angle) * dist;
      const hasCoord = galaxy.userMoved && galaxy.coordinate
        && galaxy.coordinate.x !== null && galaxy.coordinate.x !== undefined
        && Number.isFinite(galaxy.coordinate.x) && Number.isFinite(galaxy.coordinate.y);
      if (hasCoord) {
        // 坐标必须仍在该星域边界圆内，否则视为旧布局残留 → 回落簇内位置
        const d = Math.hypot(galaxy.coordinate.x - parentDomain.x, galaxy.coordinate.y - parentDomain.y);
        if (d <= (parentDomain.radius || GALAXY_LAYOUT.domainRadius)) {
          gx = galaxy.coordinate.x;
          gy = galaxy.coordinate.y;
        }
      }
      out.push({ ...galaxy, x: gx, y: gy, domainId: galaxy.parentId, factionColor: parentDomain.factionColor });
    });
  }
  void opts;
  return out;
}

/**
 * 势力边界（2026-11-02 换口径：**所有权场 φ 软融合**，不再是凸包）：
 *   ① 用户覆盖点优先（逐点可拖，原样返回 —— `test_116` f5 / 单测守这条身份）
 *   ② 其余星域由 `galaxy/territory.js` 的场派生出**闭合软轮廓**（`loops`，多环）
 *   ③ `points` 是对最大环**等距重采样**后的 14 个手柄点（软形状点一下才转成覆盖点，
 *      不给用户 200 个拖不动的点），`center` 恒为星域中心（标签 / 命中 / 拖拽手柄都靠它）
 *
 * ⚠️ 三个分支缺一不可的历史原因仍在：导出原先在“星系数不足”处直接 `continue`（星域凭空消失）。
 * ⚠️ 形状只跟**布局**有关（星域坐标 + 星系坐标），与颜色无关 —— 所以形状走缓存、颜色每次现取。
 */
const _shapeCache = new Map();
const _SHAPE_CACHE_MAX = 6;

/** 形状缓存键：布局一变就换（颜色 / 覆盖点不进键，见上） */
function shapeKey(domainNodes, galaxyNodes) {
  const d = (domainNodes || []).map(n => `${n.id}@${Math.round(n.x)},${Math.round(n.y)}`).join('|');
  const g = (galaxyNodes || []).map(n => `${n.id}>${n.domainId}@${Math.round(n.x)},${Math.round(n.y)}`).join('|');
  return `${d}##${g}`;
}

/** 场派生的星域轮廓（带缓存；画布每帧、命中测试每次都调它） */
export function domainShapes(domainNodes, galaxyNodes) {
  const key = shapeKey(domainNodes, galaxyNodes);
  const hit = _shapeCache.get(key);
  if (hit) return hit;
  const inputs = buildFieldInputs(domainNodes, galaxyNodes, { salt: GALAXY_LAYOUT.fieldSalt });
  const shapes = computeDomainShapes(inputs);
  if (_shapeCache.size >= _SHAPE_CACHE_MAX) {
    _shapeCache.delete(_shapeCache.keys().next().value);
  }
  _shapeCache.set(key, shapes);
  return shapes;
}

export function factionBorders({ domainNodes, galaxyNodes, overrides } = {}) {
  const borders = [];
  const shapes = new Map(domainShapes(domainNodes, galaxyNodes).map(s => [s.domainId, s]));
  for (const domain of domainNodes || []) {
    const override = overrides && overrides[domain.id];
    if (Array.isArray(override) && override.length >= 3) {
      borders.push({
        domainId: domain.id, name: domain.name, color: domain.factionColor,
        points: override, loops: [override], center: { x: domain.x, y: domain.y },
        soft: false, editable: true,
      });
      continue;
    }
    const shape = shapes.get(domain.id);
    if (!shape) continue;
    borders.push({
      domainId: domain.id, name: domain.name, color: domain.factionColor,
      points: resampleLoop(shape.loops[0], TERRITORY.resampleN),
      loops: shape.loops,
      center: shape.center,
      fadeRadius: shape.fadeRadius,
      soft: true, editable: false,
    });
  }
  return borders;
}

/**
 * 航道配色（**2026-11-02 按群星参考图改口径**）：群星里普通航道只有**一种青色**，
 * 靠明暗分主次，不按类型换色（`refs/src/星链接线1.jpg` / `星域视图2.jpg`）；紫色只留给虫洞。
 * 所以现在是“同族青 + 两种明暗 + 虚线表示非直连”，而不是以前的紫/红/绿/蓝四色：
 *   · 自动航道（auto_*）：青、实线、偏暗（它是背景网，不该抢星）；
 *   · 跨域航道：同族青、虚线、更暗（远看只是"这边和那边连着"）；
 *   · 跳跃航道：紫、虚线（= 虫洞语义，唯一保留的第二种颜色）；
 *   · 用户亲手建的：绿、最亮（**我们自己的语义**：他画的那条要看得到）。
 * ⚠️ 判据（`unit/test_galaxy_layout.js` e1）跟着改：不再要求"四色互不相同"，
 *    改守"自动与跨域同族青、跳跃紫、用户绿，且四者两两可区分（同族靠明暗+虚线区分）"。
 */
export function hyperlaneColor(h, opts = {}) {
  const isDark = opts.isDark !== false;
  const hovered = !!opts.hovered;
  const isUserCreated = !String(h && h.id || '').startsWith('auto_');
  if (h && h.type === 'cross_domain') {
    return hovered ? 'rgba(160, 235, 245, 0.95)'
      : (isDark ? 'rgba(96, 190, 205, 0.42)' : 'rgba(40, 110, 125, 0.45)');
  }
  if (h && h.type === 'hyperjump') {
    return hovered ? 'rgba(214, 175, 255, 1.0)'
      : (isDark ? 'rgba(178, 136, 235, 0.8)' : 'rgba(110, 70, 190, 0.5)');
  }
  if (isUserCreated) {
    return hovered ? 'rgba(120, 255, 210, 1.0)'
      : (isDark ? 'rgba(100, 240, 180, 0.85)' : 'rgba(40, 170, 130, 0.55)');
  }
  return hovered ? 'rgba(190, 250, 255, 1.0)'
    : (isDark ? 'rgba(120, 214, 232, 0.62)' : 'rgba(50, 130, 150, 0.5)');
}

/**
 * 远景整批不画航道（2026-11-03，对照群星截图）：群星的全景**一条连接线都没有** ——
 * 远景是“星点 + 领土色块”，线一出现整幅图就变成蛛网。所以这里给一个明确的 LOD 门槛，
 * 画布与命中测试**都**走它（`hyperlanesToDraw` 是唯一入口）：
 *   · 编辑态 → 永远画（要能点、能改）；
 *   · 有悬停/选中的那条 → 永远画（不能“看不见却点得到”）；
 *   · 其余：`lod < LANE_FAR_LOD` 时整批不画。
 * ⚠️ 导出 PNG 走的是中景（`lod: 0.45`），不受这个门槛影响。
 */
export const LANE_FAR_LOD = 0.22;

export function lanesVisibleAt(lod, opts = {}) {
  if (opts.editMode || opts.hovered) return true;
  return !(Number(lod) < LANE_FAR_LOD);
}

/**
 * 航道稀疏化（2026-11-02，对应用户第 2 条“跨域航道数量本身没做稀疏化，数据多时仍偏吵”）。
 *
 * 只改**画什么**，不改数据（`hyperlanes` 一条都不删 —— 删一条就是改世界观）。
 * 口径：
 *   · 编辑态 / 近景（lod ≥ 0.85）→ 全画（要能点、要能改，别在编辑时藏东西）；
 *   · 用户亲手建的航道（id 不以 `auto_` 开头）→ 永远画；
 *   · 悬停 / 选中的 → 永远画（不能"看不见却点得到"，反过来也不行）；
 *   · 其余自动航道：**先保骨架**（Kruskal 最小生成树，把所有恒星连成一片，不产生孤岛），
 *     再按“每个星域对最多 1 条（远景）/ 2 条（中景）”补跨域，最后按每个恒星最多 2 条短边补局部。
 * 全程按 (长度, id) 排序 → 同一份数据每次都画出同一批线（不会闪来闪去）。
 *
 * @param {Array} lanes 航道
 * @param {{nodeById?:Map, domainOf?:Map, lod?:number, editMode?:boolean, pinned?:Set}} opts
 * @returns {Array} 该画的航道（顺序即输入顺序）
 */
export function sparsifyHyperlanes(lanes, opts = {}) {
  const list = Array.isArray(lanes) ? lanes : [];
  const { nodeById, domainOf, lod = 1, editMode = false, pinned } = opts;
  if (!nodeById || list.length < 4) return list;
  if (editMode || lod >= 0.85) return list;

  const keep = new Set();
  const measured = [];
  for (const h of list) {
    const isUser = !String(h.id || '').startsWith('auto_');
    if (isUser || (pinned && pinned.has(h.id))) { keep.add(h.id); continue; }
    const a = nodeById.get(h.fromId);
    const b = nodeById.get(h.toId);
    if (!a || !b) continue;
    measured.push({
      h,
      len: Math.hypot(b.x - a.x, b.y - a.y),
      a: a.id,
      b: b.id,
      pair: [domainOf ? domainOf.get(a.id) : null, domainOf ? domainOf.get(b.id) : null].sort().join('>'),
      cross: h.type === 'cross_domain'
        || (domainOf && domainOf.get(a.id) !== domainOf.get(b.id)),
    });
  }
  measured.sort((p, q) => (p.len - q.len) || String(p.h.id).localeCompare(String(q.h.id)));

  // ① 骨架：Kruskal 最小生成树（保证没有任何一颗星因为稀疏化变成孤岛）
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r);
    return r;
  };
  const union = (x, y) => {
    const rx = find(x), ry = find(y);
    if (rx === ry) return false;
    parent.set(rx, ry);
    return true;
  };
  for (const e of measured) {
    if (find(e.a) === undefined) parent.set(e.a, e.a);
    if (find(e.b) === undefined) parent.set(e.b, e.b);
    if (union(e.a, e.b)) keep.add(e.h.id);
  }

  // ② 跨域：同一对星域最多留 1 条（远景）/ 2 条（中景）
  const perPair = lod < 0.5 ? 1 : 2;
  const pairCount = new Map();
  for (const e of measured) {
    if (!e.cross || keep.has(e.h.id)) continue;
    const n = pairCount.get(e.pair) || 0;
    if (n >= perPair) continue;
    pairCount.set(e.pair, n + 1);
    keep.add(e.h.id);
  }

  // ③ 局部：每颗星最多再补 2 条最短的（跨域已经算过的也计入度）
  const degree = new Map();
  for (const e of measured) {
    if (!keep.has(e.h.id)) continue;
    degree.set(e.a, (degree.get(e.a) || 0) + 1);
    degree.set(e.b, (degree.get(e.b) || 0) + 1);
  }
  const ADD_CAP = 2;
  for (const e of measured) {
    if (keep.has(e.h.id)) continue;
    if ((degree.get(e.a) || 0) >= ADD_CAP || (degree.get(e.b) || 0) >= ADD_CAP) continue;
    keep.add(e.h.id);
    degree.set(e.a, (degree.get(e.a) || 0) + 1);
    degree.set(e.b, (degree.get(e.b) || 0) + 1);
  }
  return list.filter(h => keep.has(h.id));
}

/** 节点半径（层 → 半径；画布与导出同值） */
export function nodeRadius(layer) {
  if (layer === 'world') return 10;
  if (layer === 'star_domain') return 9;
  if (layer === 'galaxy') return 7;
  return 5;
}

/**
 * 节点颜色：**星系用势力的 `factionColor`**（画布口径），其余层用固定色板。
 * （导出原先对星系固定 `#ffd700` —— 与画布不一致的第五条。）
 */
export function nodeColor(node, opts = {}) {
  if (!node) return '#888';
  if (node.layer === 'galaxy') return node.factionColor || '#4a90d9';
  const colors = {
    world: '#d2a8ff', star_domain: '#7c7cff', galaxy: '#ffd700',
    planet: '#5cb85c', city: '#f0ad4e', town: '#d9853b', location: '#888',
  };
  void opts;
  return colors[node.layer] || '#888';
}

/**
 * 星云谱（**世界坐标固定**，与画布同一组常量）。导出按图幅取用；两边都**不许**再各写一套。
 * ⚠️ 这只是"取同一条谱"，不是"逐像素同源"（见文件头注释）。
 */
export const STARFIELD = {
  nebulae: [
    { x: 300, y: -200, r: 600, color: 'rgba(60, 90, 180, 0.06)' },
    { x: -400, y: 300, r: 500, color: 'rgba(120, 60, 150, 0.05)' },
    { x: 100, y: 400, r: 400, color: 'rgba(60, 150, 120, 0.04)' },
    { x: -200, y: -350, r: 450, color: 'rgba(150, 100, 60, 0.04)' },
    { x: 600, y: 100, r: 550, color: 'rgba(80, 120, 200, 0.05)' },
    { x: -600, y: -100, r: 480, color: 'rgba(100, 80, 160, 0.04)' },
  ],
  gridStep: 120,
  gridColor: 'rgba(60, 80, 120, 0.12)',
};
