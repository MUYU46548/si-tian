// utils/galaxyLayout.js — 星系/星域视图的**布局 + 配色 + 几何**唯一实现（纯函数，Node 可测；2026-10-18 第十二修）
//
// ── 为什么必须有它（§bug 导出与画布不同源）────────────────────────────────────
// 「导出 PNG(全图)」在 `App.vue` 里是**第三套实现**，与画布各写一份，于是同一份数据在两张图上不一样：
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
 * @param {Array} domains
 * @param {{draggingId?:string, overrides?:object}} [opts]
 */
export function layoutDomains(domains, opts = {}) {
  const list = Array.isArray(domains) ? domains : [];
  const count = list.length;
  const radius = count > 1 ? GALAXY_LAYOUT.domainSpacing * GALAXY_LAYOUT.ringFactor : 0;
  return list.map((domain, idx) => {
    const angle = (idx / Math.max(count, 1)) * Math.PI * 2 - Math.PI / 2;
    const saved = (domain.userMoved || domain.id === opts.draggingId)
      && domain.coordinate && Number.isFinite(domain.coordinate.x) && Number.isFinite(domain.coordinate.y);
    return {
      ...domain,
      x: saved ? domain.coordinate.x : (count > 1 ? Math.cos(angle) * radius : 0),
      y: saved ? domain.coordinate.y : (count > 1 ? Math.sin(angle) * radius : 0),
      factionColor: resolveDomainColor(domain, opts.overrides),
      radius: GALAXY_LAYOUT.domainRadius,
    };
  });
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
 * ⚠️ 三个分支缺一不可的历史原因仍在：导出原先在「星系数不足」处直接 `continue`（星域凭空消失）。
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
 * 所以现在是「同族青 + 两种明暗 + 虚线表示非直连」，而不是以前的紫/红/绿/蓝四色：
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
 * 航道稀疏化（2026-11-02，对应用户第 2 条「跨域航道数量本身没做稀疏化，数据多时仍偏吵」）。
 *
 * 只改**画什么**，不改数据（`hyperlanes` 一条都不删 —— 删一条就是改世界观）。
 * 口径：
 *   · 编辑态 / 近景（lod ≥ 0.85）→ 全画（要能点、要能改，别在编辑时藏东西）；
 *   · 用户亲手建的航道（id 不以 `auto_` 开头）→ 永远画；
 *   · 悬停 / 选中的 → 永远画（不能"看不见却点得到"，反过来也不行）；
 *   · 其余自动航道：**先保骨架**（Kruskal 最小生成树，把所有恒星连成一片，不产生孤岛），
 *     再按「每个星域对最多 1 条（远景）/ 2 条（中景）」补跨域，最后按每个恒星最多 2 条短边补局部。
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
