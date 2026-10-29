// utils/heightmapResample.js — 高度图**重采样**（纯函数，Node 可测；2026-10-14）
//
// ── 它解决什么 ───────────────────────────────────────────────────────────────
// 用户实测第 5、2 条：「地形模模糊糊」「高度图分辨率帮我调整」。量出来的事实是：
//   · 真实底图 `desite` 的源网格 **133×75 = 9975 格 / spacing 14.4**，
//     画到 1900×1080 的画布上时**每格约 3.6 屏幕像素**（放大到 400% 时 1 格占一屏）。
//   · 这不是渲染 bug，是**数据分辨率**：`heightmapRaster` 的平滑档已经是"每格一色 +
//     子格双线性"，但每一格的**颜色**是固定的 → 放大了就是一块一块的。
//
// 唯一能真正改善观感的做法是**把格子变密**（每格有自己的高度值），于是海岸线、山坡的
// 走样从"格子那么大"缩小到"新格子那么大"。本模块就是这个动作的**唯一实现**。
//
// ── 三条口径（都不许违反）─────────────────────────────────────────────────
//   ① **纯函数**：不改入参、不碰 store、不写盘。调用方自己决定要不要落盘（走
//      `commitHeightmap` 那条唯一写口）。
//   ② **连续量插值 / 分类量最近邻**：`h` / `temp` / `prec` 是连续量 → 双线性；
//      `biome` 是**分类编码**（Uint8 下标），插值会造出"根本不存在的群系编号"（例如
//      3 与 10 之间插出 6.5 → 取整成 6 = 另一种群系）→ 一律**最近邻**。
//   ③ **不搬运行期派生字段**：`_spatialIndex` 之类是按旧网格建的空间索引，复制过去
//      会指向错误的格子（更坏：它不报错，只是让笔刷吸到隔壁的格子）。一律丢弃。
//
// ── 性能（这条决定了能不能给用户按）────────────────────────────────────────
// `estimateResampleCost()` 先算格数/内存/耗时档，UI 据此**在按下去之前**就告诉用户
// 会花多久、会占多少内存。别把"能不能承受"留给用户按完再发现 —— 本项目已有一次
// 「点了自动河流主线程卡死几分钟」的教训（见 `utils/riverTrace.js` 文件头）。

/** 允许的最大放大倍数（再大没有信息增量，只有内存与耗时的平方增长：格数 = 倍数²） */
export const MAX_RESAMPLE_FACTOR = 8;

/** 单次重采样允许的最大格数（超过就拒绝：一次性分配几十 MB 的 TypedArray 在渲染进程里会触发 GC 停顿） */
export const MAX_RESAMPLE_CELLS = 400000;

/** 连续量通道（双线性插值）；其余（`biome` 等分类量）走最近邻 */
const CONTINUOUS_CHANNELS = ['h', 'temp', 'prec'];

/** 会被丢弃的运行期键（按旧网格建立，搬过去只会指向错误的格子） */
const RUNTIME_KEYS = ['_spatialIndex', '_nearestCache', '_rasterCache'];

/**
 * 先算账：这套参数要多少格、多少内存、大概多久、值不值得。
 *
 * @param {{grid?:{cellsX:number,cellsY:number,points?:Array}}} hm 源高度图
 * @param {number} factor 放大倍数
 * @returns {{ok:boolean, reason?:string, message:string, factor:number,
 *            srcCells:number, dstCells:number, dstBytes:number, cellsX:number, cellsY:number,
 *            estMs:number, level:'fast'|'ok'|'slow'|'reject'}}
 */
export function estimateResampleCost(hm, factor) {
  const f = Math.round(Number(factor) || 0);
  const grid = (hm && hm.grid) || {};
  const cols = grid.cellsX | 0;
  const rows = grid.cellsY | 0;
  const srcCells = (cols > 0 && rows > 0) ? cols * rows : ((grid.points && grid.points.length) || 0);
  const out = {
    ok: false, factor: f, srcCells, dstCells: 0, dstBytes: 0,
    cellsX: 0, cellsY: 0, level: 'reject', message: '',
  };
  if (!(f >= 2)) {
    out.message = '放大倍数至少是 2（1 倍 = 原样，没有意义）';
    return out;
  }
  if (f > MAX_RESAMPLE_FACTOR) {
    out.message = `放大倍数最大 ${MAX_RESAMPLE_FACTOR} 倍 —— 再大不会多出任何地形信息，只会成倍吃内存和耗时`
      + `（格数 = 倍数²）。真要更细的地形，得换一份源高度图。`;
    return out;
  }
  if (!srcCells) {
    out.message = '这张高度图没有网格点，无法重采样';
    return out;
  }
  const cellsX = (cols - 1) * f + 1;
  const cellsY = (rows - 1) * f + 1;
  const dstCells = Math.max(0, cellsX * cellsY);
  // h/temp/prec 各 4 字节 + biome 1 字节 + 坐标点 2 个 float（points 是普通数组：
  // V8 里每个小数组还有约 40 字节开销，所以内存估计按"格数 × 56 字节"量级）
  const dstBytes = dstCells * (4 * 3 + 1) + dstCells * 56;
  out.cellsX = cellsX;
  out.cellsY = cellsY;
  out.dstCells = dstCells;
  out.dstBytes = dstBytes;

  // 实测口径（Node，同一台机器）：约 1.2~2.0 M 格/秒（含坐标点构造，那是主要开销）。
  // 用保守值 1.0 M 格/秒给出上界，宁可高估。
  const estMs = Math.round(dstCells / 1.0e6 * 1000);
  out.estMs = estMs;
  if (dstCells > MAX_RESAMPLE_CELLS) {
    // 🔴 2026-10-16 修：原来只写 `f - 1` 就报数字，**不再复核它是否仍然超限**。
    //    真实底图（133×75）实测：×8 被拒后建议「7 倍是 480,075 格」——480,075 **仍然 > 400,000**，
    //    用户照着建议试还是失败，得自己一路试到 ×6。（用户报的「分辨率」相关缺陷之一。）
    //    现在**从 f-1 往下找出第一个真正可行的倍数**，找不到就明说"这张图放不了这么大"。
    let suggested = 0;
    for (let cand = f - 1; cand >= 2; cand--) {
      const cc = (cols - 1) * cand + 1;
      const rr2 = (rows - 1) * cand + 1;
      if (cc * rr2 <= MAX_RESAMPLE_CELLS) { suggested = cand; break; }
    }
    const suggestText = suggested >= 2
      ? `${suggested} 倍是 ${(((cols - 1) * suggested + 1) * ((rows - 1) * suggested + 1)).toLocaleString('en-US')} 格（这一档可行）。`
      : `这张底图的网格太大，**连 ×2 都超过上限**（×2 就会到 `
        + `${(((cols - 1) * 2 + 1) * ((rows - 1) * 2 + 1)).toLocaleString('en-US')} 格）—— 只能先缩小底图范围，或换一张更小的底图。`;
    out.message = `会变成 ${dstCells.toLocaleString('en-US')} 格（约 ${fmtBytes(dstBytes)}），超过单次上限 `
      + `${MAX_RESAMPLE_CELLS.toLocaleString('en-US')} 格。请降低倍数：${suggestText}`
      + `\n提示：也可以先只保留需要的区域（把底图范围缩小）再放大。`;
    return out;
  }
  out.ok = true;
  out.level = dstCells < 60000 ? 'fast' : (dstCells < 200000 ? 'ok' : 'slow');
  out.message = `${srcCells.toLocaleString('en-US')} 格 → ${dstCells.toLocaleString('en-US')} 格`
    + `（${cellsX}×${cellsY}，约 ${fmtBytes(dstBytes)} 内存，预计 ${estMs} ms 以内）`;
  return out;
}

/** 人类可读的字节数（只给提示用） */
export function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  if (b >= 1024) return Math.round(b / 1024) + ' KB';
  return Math.round(b) + ' B';
}

/**
 * Catmull-Rom 一维权重（4 点，t∈[0,1]）。和恒为 1，线性函数被**精确复现**
 * （所以 `h = 10c + r` 这种平面地形放大后值与双线性一模一样）。
 */
function cubicWeights(t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return [
    -0.5 * t3 + t2 - 0.5 * t,
    1.5 * t3 - 2.5 * t2 + 1,
    -1.5 * t3 + 2 * t2 + 0.5 * t,
    0.5 * t3 - 0.5 * t2,
  ];
}

/**
 * 把高度图放大 `factor` 倍（连续量 **bicubic / Catmull-Rom**，格心对齐、外沿保持不动）。
 *
 * ── 为什么从双线性换成双三次（C4，2026-10-29）─────────────────────────────────
 * 双线性在放大处**只有 C0 连续**：每一格的边界上斜率突变，等值线因此呈"折线台阶"，
 * 光照/山体阴影会把台阶放大成一条条直线棱（用户原话「地形模模糊糊 / 一格一格的」）。
 * 双三次是 C1：同样的格数下坡面连续，等值线不再拐在格心上。
 * ⚠️ 双三次的代价是**过冲**（Catmull-Rom 在阶跃处会冲出 [a,b]）—— 地形高度冲出邻域会造出
 * 不存在的山尖/负高度，所以这里对 16 点邻域做 **min/max 夹持**：只在过冲时生效，
 * 线性/平滑坡面完全不受影响（判据在 `unit/test_heightmap_resample.js`）。
 *
 * 为什么格心对齐很重要：重采样后 `spacing` 变成 `spacing / factor`，而**最外圈的格心
 * 与世界坐标不变**。于是"省份多边形 / 参考底图 / 相机视口"全都不需要任何补偿 ——
 * 只有格子变密了。若按"补零到边长"的做法，整张图会平移半格，那种偏移**看起来只是
 * 地形歪了一点**，极难查。
 *
 * @param {object} hm 源高度图（`{h,temp?,prec?,biome?,grid:{points,spacing,cellsX,cellsY}}`）
 * @param {number} factor 放大倍数（2~`MAX_RESAMPLE_FACTOR`）
 * @param {{maxCells?:number}} [opts]
 * @returns {{ok:true, heightmap:object, stats:object}|{ok:false, reason:string, message:string}}
 */
export function resampleHeightmap(hm, factor, opts = {}) {
  const f = Math.round(Number(factor) || 0);
  const grid = (hm && hm.grid) || {};
  const pts = grid.points;
  if (!hm || !Array.isArray(pts) || !pts.length) {
    return { ok: false, reason: 'no-grid', message: '这张高度图没有网格点，无法重采样' };
  }
  const cost = estimateResampleCost(hm, f);
  const maxCells = Number.isFinite(opts.maxCells) ? opts.maxCells : MAX_RESAMPLE_CELLS;
  if (!cost.ok) return { ok: false, reason: 'factor', message: cost.message };
  if (cost.dstCells > maxCells) {
    return { ok: false, reason: 'too-large', message: `${cost.dstCells} 格超过上限 ${maxCells}`, cost };
  }

  const cols = grid.cellsX | 0;
  const rows = grid.cellsY | 0;
  // 格心世界坐标：项目文件里可能是 `[x, y]`，也可能是 `{x, y}`（历史数据）——
  // 两种形态都要认。⚠️ 写成 `Array.isArray(p0) ? Number(p0[0]) : Number(p0.x)` 会被
  //    运算符优先级坑到（`:` 后面的 `Number(...)` 只在"三元的第二个分支"生效？不 ——
  //    它确实生效，但若某处漏写 Number 就会造出 NaN 格心，**画布上什么都不显示且不报错**。
  //    所以这里显式取值再统一转数，并断言结果有限。
  const p0 = pts[0];
  const p0x = Array.isArray(p0) ? p0[0] : (p0 && p0.x);
  const p0y = Array.isArray(p0) ? p0[1] : (p0 && p0.y);
  const x0 = Number(p0x);
  const y0 = Number(p0y);
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) {
    return { ok: false, reason: 'bad-origin', message: '这张高度图的网格原点不是有效数字（数据可能损坏）' };
  }
  const spacing = Number(grid.spacing) || 14.4;

  // 非规则网格（点数与 cellsX×cellsY 不符）不能按行列下标插值 —— 直接拒绝，
  // 绝不"猜一个行列"（猜错的后果是地形整体错位，且不报错）。
  if (!(cols > 1 && rows > 1 && cols * rows === pts.length)) {
    return { ok: false, reason: 'irregular-grid', message: '这张高度图不是规则栅格（点数与行列数不符），无法按行列重采样' };
  }

  const nc = (cols - 1) * f + 1;
  const nr = (rows - 1) * f + 1;
  const n = nc * nr;
  const nspacing = spacing / f;

  const points = new Array(n);
  for (let r = 0; r < nr; r++) {
    const wy = y0 + r * nspacing;
    const base = r * nc;
    for (let c = 0; c < nc; c++) {
      points[base + c] = [x0 + c * nspacing, wy];
    }
  }

  const out = { grid: { points, spacing: nspacing, cellsX: nc, cellsY: nr, count: n } };
  const stats = { factor: f, srcCells: cols * rows, dstCells: n, channels: [] };

  // ── 连续量：双三次（Catmull-Rom + 邻域夹持）──────────────────────────────────
  for (const key of CONTINUOUS_CHANNELS) {
    const src = hm[key];
    if (!src || src.length !== cols * rows) continue;
    // 四周各补一圈：**二阶外插**（不是夹持/镜像）。
    // 🔴 实测：夹持会让边缘中点偏 12%（h=10c+r 的 (0.5,0) 中点会算成 4.375 而不是 5）——
    //    因为 Catmull-Rom 需要第 4 个点，用 p0 顶替 p(-1) 等于把直线掰弯了。
    //    一阶（线性）外插能救回直线，但二次面在边缘仍差 1.03（实测）→ 这里用二阶：
    //    `v(-1) = 3·v(0) − 3·v(1) + v(2)`（对二次以下精确，线性/常数是其特例）。
    const padW = cols + 2;
    const padH = rows + 2;
    const pad = new Float32Array(padW * padH);
    const at = (r, c) => pad[(r + 1) * padW + (c + 1)];
    const put = (r, c, v) => { pad[(r + 1) * padW + (c + 1)] = v; };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) put(r, c, src[r * cols + c]);
    }
    // 行方向上下两圈（列 0..cols-1 已填好）
    for (let c = 0; c < cols; c++) {
      if (rows >= 3) {
        put(-1, c, 3 * at(0, c) - 3 * at(1, c) + at(2, c));
        put(rows, c, 3 * at(rows - 1, c) - 3 * at(rows - 2, c) + at(rows - 3, c));
      } else {
        put(-1, c, at(0, c));
        put(rows, c, at(rows - 1, c));
      }
    }
    // 列方向左右两圈（此时每一行（含上下两圈）都已齐全）
    for (let r = -1; r <= rows; r++) {
      if (cols >= 3) {
        put(r, -1, 3 * at(r, 0) - 3 * at(r, 1) + at(r, 2));
        put(r, cols, 3 * at(r, cols - 1) - 3 * at(r, cols - 2) + at(r, cols - 3));
      } else {
        put(r, -1, at(r, 0));
        put(r, cols, at(r, cols - 1));
      }
    }
    const dst = new Float32Array(n);
    for (let r = 0; r < nr; r++) {
      const fy = r / f;
      const j = Math.min(rows - 2, Math.floor(fy));
      const ty = fy - j;
      const wy = cubicWeights(ty);
      const base = r * nc;
      for (let c = 0; c < nc; c++) {
        const fx = c / f;
        const i = Math.min(cols - 2, Math.floor(fx));
        const tx = fx - i;
        const wx = cubicWeights(tx);
        let sum = 0;
        let mn = Infinity;
        let mx = -Infinity;
        for (let b = 0; b < 4; b++) {
          const rr = j - 1 + b;
          const rowIn = rr >= 0 && rr < rows;
          const wb = wy[b];
          for (let a = 0; a < 4; a++) {
            const cc = i - 1 + a;
            const v = at(rr, cc);
            // 夹持只看**真实格点**：外插的鬼点可能远离数据（阶跃处会到 300），
            // 把它算进 min/max 等于给过冲开后门 —— 那正是要防的东西。
            if (rowIn && cc >= 0 && cc < cols) {
              if (v < mn) mn = v;
              if (v > mx) mx = v;
            }
            sum += v * wb * wx[a];
          }
        }
        // 邻域 min/max 夹持：只砍过冲（否则阶跃处会造出"不存在的山尖"与负高度）
        dst[base + c] = sum < mn ? mn : (sum > mx ? mx : sum);
      }
    }
    out[key] = dst;
    stats.channels.push(key + ':bicubic');
  }

  // ── 分类量：最近邻（插值会造出不存在的编码）────────────────────────────────
  for (const key of Object.keys(hm)) {
    if (CONTINUOUS_CHANNELS.indexOf(key) >= 0) continue;
    if (RUNTIME_KEYS.indexOf(key) >= 0) continue;
    if (key === 'grid' || key === 'h') continue;
    const src = hm[key];
    if (!src || typeof src.length !== 'number' || src.length !== cols * rows) continue;
    // biome 是 Uint8 编码；历史数据里也可能有其它分类通道 → 统一按"取最近格的值"处理
    const dst = new Uint8Array(n);
    for (let r = 0; r < nr; r++) {
      const j = Math.round(r / f);
      const rowA = j * cols;
      const base = r * nc;
      for (let c = 0; c < nc; c++) {
        dst[base + c] = src[rowA + Math.round(c / f)] | 0;
      }
    }
    out[key] = dst;
    stats.channels.push(key + ':nearest');
  }

  // `h` 是必需的：源里没有 h 时给一张全 0 的（与 `createBaseMapHeightmap` 的空高度图同构）
  if (!out.h) {
    out.h = new Float32Array(n);
    stats.channels.unshift('h:empty');
  }

  return { ok: true, heightmap: out, stats };
}

/**
 * 地形平滑（**可分离盒滤波**，半径按格数）。
 *
 * 为什么需要：用户实测「地形模模糊糊」的另一半——源高度图是 FMG 生成的低频起伏，
 * 放大了就是一块块的台阶。平滑能让等值线不再沿格子走方波。
 *
 * 🔴 为什么不复用 `heightMath.smoothHeightmap`：那个实现对每个格**全表扫描**找范围内的
 *    邻居（O(n²)），真实底图 9975 格 ≈ 1 亿次内层迭代，26910 格 ≈ 7 亿次 —— 点一下就是
 *    秒级到十秒级的主线程停顿。本函数是分离式（先横后竖）的 O(n·半径)，同样效果。
 *    仓库里那份**目前零调用**（已核查），留着是颗地雷，本轮在它头上加了警告注释。
 *
 * ⚠️ 只平滑 `h`（地形本体）。`temp`/`prec`/`biome` 是**派生量**，平滑后应当重算
 *    （`deriveAllLayers`），不要在这里顺手改 —— 否则"平滑地形"会悄悄改掉气候与群系。
 *
 * @param {object} hm 高度图
 * @param {{radius?:number, passes?:number}} [opts] `radius` = 半径（格，默认 1 = 3×3）
 * @returns {{ok:true, heightmap:object, stats:object}|{ok:false, reason:string, message:string}}
 */
export function smoothHeightmapGrid(hm, opts = {}) {
  const grid = (hm && hm.grid) || {};
  const pts = grid.points;
  const cols = grid.cellsX | 0;
  const rows = grid.cellsY | 0;
  if (!hm || !hm.h || !Array.isArray(pts) || !pts.length) {
    return { ok: false, reason: 'no-grid', message: '这张高度图没有网格点，无法平滑' };
  }
  if (!(cols > 1 && rows > 1 && cols * rows === hm.h.length)) {
    return { ok: false, reason: 'irregular-grid', message: '这张高度图不是规则栅格，无法平滑' };
  }
  const radius = Math.max(1, Math.min(8, Math.round(Number(opts.radius) || 1)));
  const passes = Math.max(1, Math.min(4, Math.round(Number(opts.passes) || 1)));

  // 两个缓冲轮换：读 a 写 b（原地读写会一边改一边读，结果与"分离式滤波"不等价）
  let a = new Float32Array(hm.h);
  let b = new Float32Array(a.length);
  const win = radius * 2 + 1;
  for (let p = 0; p < passes; p++) {
    // 横向：a → b
    for (let r = 0; r < rows; r++) {
      const base = r * cols;
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += a[base + clamp(k, 0, cols - 1)];
      for (let c = 0; c < cols; c++) {
        b[base + c] = sum / win;
        sum -= a[base + clamp(c - radius, 0, cols - 1)];
        sum += a[base + clamp(c + radius + 1, 0, cols - 1)];
      }
    }
    // 纵向：b → a
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += b[clamp(k, 0, rows - 1) * cols + c];
      for (let r = 0; r < rows; r++) {
        a[r * cols + c] = sum / win;
        sum -= b[clamp(r - radius, 0, rows - 1) * cols + c];
        sum += b[clamp(r + radius + 1, 0, rows - 1) * cols + c];
      }
    }
  }
  const cur = a;

  const heightmap = { ...hm, h: cur };
  for (const k of RUNTIME_KEYS) delete heightmap[k];
  return {
    ok: true,
    heightmap,
    stats: { radius, passes, cells: cur.length },
  };
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
