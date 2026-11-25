// galaxy/domain3dScene.js —— 星域内 3D 总览的**纯函数适配层**（2026-11-25，E-4 原型）
//
// ## 为什么是纯函数
//
// 与 `utils/system3dScene.js`（单恒星系 3D）同一个纪律：**这里不碰 DOM、不碰 three、不碰 store**。
// 输入是司天自己的实体数组，输出是一份"场景描述"JSON —— 可以在 Node 里直接单测，
// 也可以交给任何渲染器（three / WebGL / 将来的别的）去画。
//
// 这条纪律的价值在 E-4 尤其大：域内总览的性能风险全在"画多少"上，
// 而"画多少"由这里算出来的**实例数**决定。先能量出这个数，再谈渲染。
//
// ## 与 System3DView 的分工
//
// - `system3dScene.js`：**一个**恒星系内部（恒星 + 行星 + 卫星 + 环），最细一层
// - 本文件：**一个星域内**的 N 个恒星系（每系只画一个代表天体）+ 航道 + 星域边界
//
// 所以这里**不展开行星**。星域总览看的是"哪些星系在哪、怎么连、归谁"，
// 展开行星会让实例数翻几十倍而观众根本看不见。想看清某一系 → 点进去用 System3DView。
//
// ## 性能口径（这条决定了 B 方案成不成立）
//
// 用户 2026-11-25 拍板走 B（域内真 3D）。当年搁置 E-4 的理由是"性能"，而性能的真实瓶颈是
// **draw call 数**，不是顶点数。所以本文件的输出结构**按合批所需的形状设计**：
//
//   · 所有恒星系的位置 → 一份扁平 Float32Array（`stars.position`），喂 InstancedMesh / Points
//   · 所有航道的线段端点 → 一份扁平 Float32Array（`lanes.positions`），喂一次 LineSegments
//   · 星域边界 → 每条轮廓一份扁平数组（数量少，几条而已）
//   · 每类天体一个"批次"（如何渲染由调用方定：instanced 球 / sprite / points）
//
// ⚠️ 不这么做的话：30 个星系 × 每个一个 Mesh + 每条航道一个 Line = 几百个 draw call，
//    星域一多就掉帧 —— 这正是当年担心的事。合批之后是**个位数**。

/** 单个恒星系在 3D 里的默认半径（世界单位）。域内总览只画代表球，不画行星。 */
export const DOMAIN3D_STAR_RADIUS = 26;
/** 默认 z 层厚度比例（以星域半径为单位）。0 = 完全平面，1 = 最厚。 */
export const DOMAIN3D_Z_THICKNESS = 0.18;

/**
 * 把「一个星域 + 它的成员恒星系 + 域内航道」算成 3D 场景描述。
 *
 * @param {object} input
 * @param {object} input.domain     星域节点，至少含 `{ id, name }`
 * @param {Array}  input.stars      成员恒星系，每项 `{ id, name, x, y, degree?, planetClass? }`
 *                                  ⚠️ **x/y 是 2D 世界坐标**；z 由本函数派生（见下）
 * @param {Array}  input.hyperlanes 航道，每项 `{ id, from, to }`（from/to 是星 id）
 *                                  只画**两端都在本星域内**的航道；跨域航道不在这里画
 *                                  （跨域线属于星域层，那是 2D 的活）
 * @param {Array}  [input.borders]  星域边界轮廓，每项 `{ points: [{x,y}] }`（来自 territory.js）
 * @param {number} [input.radius]   星域半径（世界单位），用于把 z 换算成可观厚度
 * @param {number} [input.zThickness] z 层厚度比例，默认 DOMAIN3D_Z_THICKNESS
 * @param {number} [input.starRadius] 单系代表球半径，默认 DOMAIN3D_STAR_RADIUS
 * @returns {{
 *   domain: object,
 *   stars: { ids: string[], names: string[], position: Float32Array, count: number },
 *   lanes: { ids: string[], position: Float32Array, segmentCount: number },
 *   borders: Array<{ position: Float32Array, pointCount: number }>,
 *   counts: { stars: number, laneSegments: number, borders: number, borderPoints: number },
 *   bbox: { minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number },
 *   radius: number,
 *   warnings: string[]
 * }}
 */
export function buildDomain3dScene(input = {}) {
  const domain = input.domain || { id: null, name: '' };
  const starsIn = Array.isArray(input.stars) ? input.stars : [];
  const lanesIn = Array.isArray(input.hyperlanes) ? input.hyperlanes : [];
  const bordersIn = Array.isArray(input.borders) ? input.borders : [];
  const warnings = [];

  const radius = Number.isFinite(input.radius) && input.radius > 0 ? input.radius : 350;
  const zThickness = Number.isFinite(input.zThickness) ? input.zThickness : DOMAIN3D_Z_THICKNESS;
  const starRadius = Number.isFinite(input.starRadius) && input.starRadius > 0
    ? input.starRadius : DOMAIN3D_STAR_RADIUS;

  // ── 1. 只用坐标有效的星（脏数据不许进渲染 —— 与 system3dScene 同一条纪律）────────
  const stars = [];
  for (const s of starsIn) {
    if (!s || !s.id) continue;
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) {
      warnings.push(`恒星系 ${s.id} 坐标非法，已跳过`);
      continue;
    }
    stars.push(s);
  }

  // ── 2. z 从哪来 ────────────────────────────────────────────────────────────
  // 司天的实体**没有 z 字段**（数据模型是 2D 地理）。所以 z 必须**派生**，且必须满足两条：
  //   ① 确定性：同一份数据每次算出来一样（否则相机一重置，星就在抖）；
  //   ② 有厚度但不乱：纯随机 z 会让航道悬空乱穿，看起来像故障。
  //
  // 做法：按 id 的**稳定哈希**散到一个薄层里（±zThickness×radius）。
  // 这样"盘面是主体、有薄薄的一层起伏"，正是群星星图那种观感（它不是真三维球状分布）。
  //
  // ⚠️ 这是本原型的一个**待定设计点**（卡里记着）：如果将来数据模型加了真实 z，
  //    这里换成读 `s.z` 即可，其余代码不用动。
  const zHalf = Math.max(0, zThickness) * radius;
  const zOf = (id) => {
    if (zHalf <= 0) return 0;
    const h = stableHash01(String(id));
    return (h * 2 - 1) * zHalf;   // [-zHalf, +zHalf]
  };

  const ids = [];
  const names = [];
  const position = new Float32Array(stars.length * 3);
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    ids.push(s.id);
    names.push(s.name || s.id);
    position[i * 3] = s.x;
    position[i * 3 + 1] = s.y;
    position[i * 3 + 2] = zOf(s.id);
  }

  // ── 3. 航道：只留两端都在本星域的，且去重/去自环 ────────────────────────────
  const idSet = new Set(ids);
  const seen = new Set();
  const lanes = [];
  for (const hl of lanesIn) {
    if (!hl || !hl.from || !hl.to) continue;
    if (!idSet.has(hl.from) || !idSet.has(hl.to)) continue;   // 跨域 / 端点缺失
    if (hl.from === hl.to) continue;                          // 自环不画
    const key = hl.from < hl.to ? `${hl.from}|${hl.to}` : `${hl.to}|${hl.from}`;
    if (seen.has(key)) continue;                               // 重复对只画一次
    seen.add(key);
    lanes.push(hl);
  }

  const laneIds = [];
  const lanePos = new Float32Array(lanes.length * 6);   // 每段 2 个端点 × 3 分量
  const indexOfStar = new Map(ids.map((id, i) => [id, i]));
  for (let i = 0; i < lanes.length; i++) {
    const hl = lanes[i];
    laneIds.push(hl.id || `${hl.from}->${hl.to}`);
    const a = indexOfStar.get(hl.from);
    const b = indexOfStar.get(hl.to);
    lanePos[i * 6] = position[a * 3];
    lanePos[i * 6 + 1] = position[a * 3 + 1];
    lanePos[i * 6 + 2] = position[a * 3 + 2];
    lanePos[i * 6 + 3] = position[b * 3];
    lanePos[i * 6 + 4] = position[b * 3 + 1];
    lanePos[i * 6 + 5] = position[b * 3 + 2];
  }

  // ── 4. 星域边界：每条轮廓一份扁平数组（数量少，不强行合批）───────────────────
  const borders = [];
  let borderPoints = 0;
  for (const b of bordersIn) {
    const pts = (b && Array.isArray(b.points)) ? b.points : [];
    const valid = pts.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
    if (valid.length < 3) {
      if (pts.length) warnings.push('星域边界点数不足 3，已跳过');
      continue;
    }
    // 闭合环：末尾补回首点（three 的 LineLoop 能省这一步，但我们用普通 Line 更好控制）
    const arr = new Float32Array((valid.length + 1) * 3);
    for (let i = 0; i < valid.length; i++) {
      arr[i * 3] = valid[i].x;
      arr[i * 3 + 1] = valid[i].y;
      arr[i * 3 + 2] = 0;          // 边界画在 z=0 平面上（群星也是平面切片）
    }
    const p0 = valid[0];
    arr[valid.length * 3] = p0.x;
    arr[valid.length * 3 + 1] = p0.y;
    arr[valid.length * 3 + 2] = 0;
    borders.push({ position: arr, pointCount: valid.length });
    borderPoints += valid.length;
  }

  // ── 5. bbox（相机取景要用；空场景给一个安全的默认框）─────────────────────────
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < stars.length; i++) {
    const x = position[i * 3], y = position[i * 3 + 1], z = position[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const empty = !Number.isFinite(minX);
  if (empty) { minX = -radius; maxX = radius; minY = -radius; maxY = radius; minZ = -zHalf; maxZ = zHalf; }

  return {
    domain,
    stars: { ids, names, position, count: stars.length },
    lanes: { ids: laneIds, position: lanePos, segmentCount: lanes.length },
    borders,
    counts: {
      stars: stars.length,
      laneSegments: lanes.length,
      borders: borders.length,
      borderPoints,
      // 这三个是给验收用的：B 方案能不能成立，就看"要画几批"而不是"要画几个"
      // 合批之后：恒星 1 批 + 航道 1 批 + 边界 1 批（轮廓再多也可以合并成 1 个 LineSegments）
      drawCallsIfBatched: 3,
      drawCallsIfNaive: stars.length + lanes.length + borders.length,
    },
    bbox: { minX, minY, minZ, maxX, maxY, maxZ },
    radius,
    starRadius,
    warnings,
  };
}

/**
 * 稳定哈希 → [0,1)。
 *
 * 与 `planetArt.js#hashString` / `sky.js` 同一个思路：**不依赖 Math.random**，
 * 同一个 id 永远同一个值。这样"相机重置后星不抖"是白拿的，不用额外存 z。
 *
 * 用 FNV-1a：短字符串上分布均匀、实现 6 行、没有依赖。
 */
export function stableHash01(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 4294967296;
}

/**
 * 相机取景参数（纯数学，不碰 three）。
 *
 * 目的：让调用方用同一个公式算"多远能看全"，避免各处各写一遍 `fitView`
 * （`galaxyLayout.js` 的注释里记过：导出与画布各写一份 → 两张图不一样）。
 *
 * @param {{minX,minY,minZ,maxX,maxY,maxZ}} bbox
 * @param {{w:number,h:number,fovDeg?:number,padding?:number}} view
 */
export function fitCameraFor(bbox, view) {
  const w = Math.max(1, Number(view && view.w) || 1);
  const h = Math.max(1, Number(view && view.h) || 1);
  const fovDeg = Number(view && view.fovDeg) || 50;
  const padding = Number.isFinite(view && view.padding) ? view.padding : 1.25;

  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = (bbox.minY + bbox.maxY) / 2;
  const cz = (bbox.minZ + bbox.maxZ) / 2;
  const spanX = Math.max(1, bbox.maxX - bbox.minX);
  const spanY = Math.max(1, bbox.maxY - bbox.minY);

  // 透视相机的可见范围：距离 d 处的**竖直**可见高度 = 2·d·tan(fov/2)，
  // 横向可见宽度 = 那个高度 × aspect。
  //
  // 所以两个方向各自需要的最小距离（这是 2026-11-25 单测 e2 抓出来的：
  // 我第一版拿 `span = max(spanX, spanY)` 先算成竖直距离再除以 aspect，
  // 结果是**把宽度当成了高度再缩一次** —— 宽 bbox 配宽画布时反而算得更近，会横向出画）。
  const fov = (fovDeg * Math.PI) / 180;
  const tanHalf = Math.tan(fov / 2);
  const aspect = w / h;

  const distForHeight = (spanY / 2) / tanHalf;                 // 竖直方向装下 spanY
  const distForWidth = (spanX / 2) / (tanHalf * aspect);       // 横向装下 spanX

  const dist = Math.max(distForHeight, distForWidth) * padding;

  return { center: { x: cx, y: cy, z: cz }, distance: dist, fovDeg };
}
