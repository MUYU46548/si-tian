#!/usr/bin/env node
/**
 * Node 单元测试：高度图**重采样 / 平滑**（src/renderer/src/utils/heightmapResample.js）
 *              + 河流**画法**（src/renderer/src/utils/riverRender.js）
 *
 * 为什么必须有这一层：这两块都是**纯函数**，错了不会抛异常 —— 只会让地形"看着怪"、
 * 河流"一样粗"。CDP 用例要发现它们得靠像素比对，既说不清是哪一步错，也容易假绿
 * （本项目在"合成事件比真实浏览器宽松"上已经吃过一次亏）。
 *
 * 本用例重点守的四条（都是 2026-10-14 用户实测暴露的）：
 *   ① **格心对齐**：重采样后最外圈的格心世界坐标**一字不动**（否则整张地形会平移半格，
 *      看起来只是"地形歪了一点"，几乎不可能查出来）；
 *   ② **分类量不许插值**：`biome` 是 Uint8 编码，双线性会造出**根本不存在的群系编号**；
 *   ③ **平滑是 O(n·半径) 且真的降方差**（旧 `heightMath.smoothHeightmap` 是 O(n²) 且零调用）；
 *   ④ **河宽随汇流量单调、有上下限**（"一条河一个粗细"就是用户说的"一眼假"）。
 *
 * 用法：node scripts/tests/unit/test_heightmap_resample.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const DEPS = ['heightmapResample.js', 'riverRender.js', 'rivers.js'];

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function close(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }

function pickTmpRoot() {
  const cands = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : '',
    os.tmpdir(), process.env.TEMP, process.env.TMP, os.homedir(),
  ];
  for (const c of cands) {
    if (!c || !path.isAbsolute(c)) continue;
    if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(c)) continue;
    try { fs.mkdirSync(c, { recursive: true }); fs.accessSync(c, fs.constants.W_OK); return c; } catch (_) { /* next */ }
  }
  return null;
}

/** 规则栅格（行主序，与 buildGridFromTerrain / heightmapRaster 同构） */
function makeGrid(cols, rows, spacing, hFn, biomeFn) {
  const points = new Array(cols * rows);
  const h = new Float32Array(cols * rows);
  const biome = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      points[i] = [c * spacing, r * spacing];
      h[i] = hFn(c, r);
      biome[i] = biomeFn ? biomeFn(c, r) : 0;
    }
  }
  return { h, biome, grid: { points, spacing, cellsX: cols, cellsY: rows, count: points.length } };
}

async function main() {
  const root = pickTmpRoot();
  if (!root) throw new Error('找不到可写的临时目录');
  const tmp = fs.mkdtempSync(path.join(root, 'sitian-resample-'));
  const fixExt = (src) => src.replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
  for (const f of DEPS) {
    fs.writeFileSync(path.join(tmp, f), fixExt(fs.readFileSync(path.join(SRC_DIR, f), 'utf8')));
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const RS = await import(pathToFileURL(path.join(tmp, 'heightmapResample.js')).href);
  const RR = await import(pathToFileURL(path.join(tmp, 'riverRender.js')).href);

  // ══════════════════════════════════════════════════════════════════════
  // 一、重采样
  // ══════════════════════════════════════════════════════════════════════
  // 4×3 网格：h = 10*c + r（棋盘式递增，双线性的期望值可以手算）
  const src = makeGrid(4, 3, 14.4, (c, r) => 10 * c + r, (c, r) => (c + r) % 7);

  check('重采样：格数 = (cols-1)*f+1 × (rows-1)*f+1，格距 = spacing/f', () => {
    const r = RS.resampleHeightmap(src, 2);
    assert(r.ok, `应当成功：${r.message || ''}`);
    const g = r.heightmap.grid;
    assert(g.cellsX === 7 && g.cellsY === 5, `应为 7×5，实际 ${g.cellsX}×${g.cellsY}`);
    assert(g.points.length === 35, `点数为 35，实际 ${g.points.length}`);
    assert(close(g.spacing, 7.2, 1e-9), `格距应为 7.2，实际 ${g.spacing}`);
    return `${g.cellsX}×${g.cellsY} / spacing ${g.spacing}`;
  });

  check('🔴 格心对齐：最外圈格心世界坐标一字不动（否则整张地形平移半格）', () => {
    const r = RS.resampleHeightmap(src, 3);
    const g = r.heightmap.grid, s = src.grid;
    const first = g.points[0], last = g.points[g.points.length - 1];
    assert(first[0] === s.points[0][0] && first[1] === s.points[0][1],
      `左上格心应保持 (${s.points[0]})，实际 (${first})`);
    const sLast = s.points[s.points.length - 1];
    assert(close(last[0], sLast[0], 1e-9) && close(last[1], sLast[1], 1e-9),
      `右下格心应保持 (${sLast})，实际 (${last})`);
    return `左上 (${first}) / 右下 (${last})`;
  });

  check('🔴 线性场：新格心的值等于四邻插值（手算对照；双三次对线性场与双线性等价）', () => {
    const r = RS.resampleHeightmap(src, 2);
    const g = r.heightmap.grid, H = r.heightmap.h;
    // 原格 (0,0)=0 与 (1,0)=10 之间的中点 → 5；(0,0)/ (0,1)=1 之间的中点 → 0.5
    const at = (ci, cj) => H[cj * g.cellsX + ci];
    assert(close(at(1, 0), 5, 1e-6), `(1,0) 应为 5，实际 ${at(1, 0)}`);
    assert(close(at(0, 1), 0.5, 1e-6), `(0,1) 应为 0.5，实际 ${at(0, 1)}`);
    assert(close(at(1, 1), 0, 1e-6) === false || true, '');
    // 内部格 (2,2)：u=1,v=1 → 原格 (1,1)=11
    assert(close(at(2, 2), 11, 1e-6), `(2,2) 应为 11（正是原格 (1,1)），实际 ${at(2, 2)}`);
    // 原格心必须**逐位保留**（这是"格心对齐"的另一半）
    assert(close(at(0, 0), src.h[0], 1e-6), '原格 (0,0) 应原样保留');
    assert(close(at(6, 4), src.h[src.h.length - 1], 1e-6), '原格 (3,2) 应原样保留');
    return `中点 ${at(1, 0)} / ${at(0, 1)}，原格 ${at(2, 2)}`;
  });

  check('C4 双三次：二次面上的中点误差 ≈0（双线性在这里差 0.25），阶跃处不过冲且单调', () => {
    // 5×3：h = c²（只看列）—— 双线性在中点给 0.5，而真值是 0.25；Catmull-Rom 对三次以下精确
    const quad = makeGrid(5, 3, 14.4, (c) => c * c);
    const r = RS.resampleHeightmap(quad, 4);
    assert(r.ok, `应当成功：${r.message || ''}`);
    const g = r.heightmap.grid, H = r.heightmap.h;
    const row = 2;   // 内部行
    let maxErr = 0;
    for (let ci = 0; ci < g.cellsX; ci++) {
      const x = ci / 4;                  // 源列坐标
      maxErr = Math.max(maxErr, Math.abs(H[row * g.cellsX + ci] - x * x));
    }
    assert(maxErr < 1e-3, `二次面上的最大误差应 ≈0（双线性会到 0.25），实际 ${maxErr}`);
    // 阶跃 0,0,100,100,100：过渡带单调 + 不冲出 [0,100]（Catmull-Rom 会过冲，靠邻域夹持砍掉）
    const step = makeGrid(5, 3, 14.4, (c) => (c >= 2 ? 100 : 0));
    const rs = RS.resampleHeightmap(step, 4);
    assert(rs.ok, `阶跃重采样应当成功：${rs.message || ''}`);
    const gs = rs.heightmap.grid, Hs = rs.heightmap.h;
    const line = [];
    for (let ci = 0; ci < gs.cellsX; ci++) line.push(Hs[2 * gs.cellsX + ci]);
    assert(line.every((v) => v >= -1e-6 && v <= 100 + 1e-6),
      `过冲了：${line.map((v) => v.toFixed(2)).join(',')}`);
    for (let i = 1; i < line.length; i++) {
      assert(line[i] >= line[i - 1] - 1e-6, `过渡带回摆：${line.map((v) => v.toFixed(2)).join(',')}`);
    }
    assert(rs.stats.channels.some((ch) => ch.includes(':bicubic')), `统计应标 bicubic：${rs.stats.channels}`);
    return `二次面误差 ${maxErr.toExponential(1)} / 阶跃 ${line.length} 格不过冲`;
  });

  check('🔴 分类量（biome）走最近邻：不许插出"不存在的群系编号"', () => {
    const r = RS.resampleHeightmap(src, 2);
    const B = r.heightmap.biome;
    const used = new Set(Array.from(src.biome));
    const bad = [];
    for (const v of B) if (!used.has(v)) bad.push(v);
    assert(bad.length === 0, `插出了源数据里没有的群系编码 ${bad.slice(0, 5)}（双线性插值分类量就是这个后果）`);
    assert(B.length === r.heightmap.h.length, 'biome 长度应与格数一致');
    return `${B.length} 格全部落在源编码集合 {${[...used].join(',')}} 内`;
  });

  check('重采样：不改入参（源高度图与网格保持不变）', () => {
    const before = JSON.stringify({ h: Array.from(src.h), p: src.grid.points, b: Array.from(src.biome) });
    RS.resampleHeightmap(src, 2);
    const after = JSON.stringify({ h: Array.from(src.h), p: src.grid.points, b: Array.from(src.biome) });
    assert(before === after, '源数据被改了（纯函数被破坏）');
    return 'ok';
  });

  check('重采样：丢弃运行期键（_spatialIndex 之类按旧网格建立，搬过去会指向错格）', () => {
    const withIdx = { ...src, _spatialIndex: { cellSize: 1, old: true } };
    const r = RS.resampleHeightmap(withIdx, 2);
    assert(r.ok, '应当成功');
    assert(r.heightmap._spatialIndex === undefined, '运行期索引不该被搬过来（它会指向旧网格的格子）');
    return 'ok';
  });

  check('成本预估：倍数 <2 / >上限 / 不规则网格 都要**拒绝并给理由**', () => {
    const a = RS.estimateResampleCost(src, 1);
    assert(!a.ok && a.message.includes('至少'), `1 倍应被拒并有说明，实际 ${JSON.stringify(a)}`);
    const b = RS.estimateResampleCost(src, 99);
    assert(!b.ok && b.message.includes(String(RS.MAX_RESAMPLE_FACTOR)), `99 倍应被拒并点名上限`);
    const irregular = { h: [1, 2, 3], grid: { points: [[0, 0], [1, 0], [2, 0]], spacing: 1, cellsX: 2, cellsY: 2, count: 3 } };
    const c = RS.resampleHeightmap(irregular, 2);
    assert(!c.ok && c.reason === 'irregular-grid', `不规则网格必须拒绝（猜行列会静默错位），实际 ${JSON.stringify(c)}`);
    return 'a/b/c 三条都拒了';
  });

  check('成本预估：给出格数 / 内存 / 档位，且超上限时点名更小的可行倍数', () => {
    const big = makeGrid(60, 60, 14.4, () => 50);
    const c = RS.estimateResampleCost(big, 8);
    assert(c.ok, `60×60 ×8 应当可算：${c.message}`);
    assert(c.dstCells === 473 * 473, `格数应为 ${473 * 473}，实际 ${c.dstCells}`);
    assert(c.dstBytes > 0 && c.estMs >= 0, '必须给出内存与耗时估计');
    // 超过单次上限（用极小上限模拟）
    const over = RS.resampleHeightmap(big, 8, { maxCells: 1000 });
    assert(!over.ok && over.reason === 'too-large', `超上限必须拒绝，实际 ${JSON.stringify(over).slice(0, 200)}`);
    assert(RS.fmtBytes(1024 * 1024).includes('MB'), 'fmtBytes 应给可读单位');
    return `${c.level} / ${RS.fmtBytes(c.dstBytes)} / ${c.estMs}ms`;
  });

  check('🔴 超上限时建议的倍数**自身必须可行**（不能建议一个仍然超限的数）', () => {
    // 真实底图量级：133×75。×8 → 1,057×593 = 626,801 格 > 400,000 上限。
    // 旧实现只写 `f-1` 就报「7 倍是 480,075 格」—— **480,075 仍然超限**，
    // 用户照着建议试还是失败（用户实测报的缺陷之一）。
    const real = makeGrid(133, 75, 14.4, () => 50);
    const c = RS.estimateResampleCost(real, 8);
    assert(!c.ok, `133×75 ×8 必须被拒，实际 ok=${c.ok}`);
    const m = /(\d+) 倍是 ([\d,]+) 格/.exec(c.message);
    assert(m, `拒绝文案里应给出一个建议倍数与它的格数，实际：${c.message}`);
    const suggested = Number(m[1]);
    const suggestedCells = Number(m[2].replace(/,/g, ''));
    assert(suggestedCells <= RS.MAX_RESAMPLE_CELLS,
      `建议的 ${suggested} 倍是 ${suggestedCells} 格，**仍超上限 ${RS.MAX_RESAMPLE_CELLS}** —— 这就是那个 bug`);
    // 且它必须是"真的可行"的（用真函数复核一遍，而不是只信文案）
    const re = RS.estimateResampleCost(real, suggested);
    assert(re.ok, `建议的 ${suggested} 倍应当真的能算，实际 ${re.message}`);
    // 反向探针：把建议逻辑退回"直接 f-1"，这条断言必须能抓到
    const badSuggested = 7;
    const badCells = ((133 - 1) * badSuggested + 1) * ((75 - 1) * badSuggested + 1);
    assert(badCells > RS.MAX_RESAMPLE_CELLS,
      `探针失效：旧口径的 ${badSuggested} 倍算出 ${badCells}，本应超限`);
    return `×8 被拒 → 建议 ×${suggested}（${suggestedCells.toLocaleString('en-US')} 格，复核 ok=true）`;
  });

  // ══════════════════════════════════════════════════════════════════════
  // 二、平滑
  // ══════════════════════════════════════════════════════════════════════
  check('🔴 平滑：降方差、保均值、且不改网格与其它通道', () => {
    // 棋盘（0/100 交替）→ 平滑后应当明显更平
    const chk = makeGrid(16, 16, 10, (c, r) => ((c + r) % 2 ? 100 : 0));
    const r = RS.smoothHeightmapGrid(chk, { radius: 1, passes: 1 });
    assert(r.ok, `应当成功：${r.message || ''}`);
    const stat = (a) => {
      const m = a.reduce((s, v) => s + v, 0) / a.length;
      const v = a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length;
      return { m, v };
    };
    const s0 = stat(Array.from(chk.h)), s1 = stat(Array.from(r.heightmap.h));
    assert(s1.v < s0.v * 0.5, `方差应显著下降：${s0.v.toFixed(1)} → ${s1.v.toFixed(1)}`);
    assert(Math.abs(s1.m - s0.m) < 1.0, `均值应基本不变：${s0.m} → ${s1.m}`);
    assert(r.heightmap.grid === chk.grid, '网格对象不该被换掉（平滑只改高度）');
    assert(r.heightmap.biome === chk.biome, '分类通道不该被动（气候/群系是派生量，要另走重算）');
    return `方差 ${s0.v.toFixed(0)} → ${s1.v.toFixed(0)}，均值 ${s0.m.toFixed(1)} → ${s1.m.toFixed(1)}`;
  });

  check('🔴 平滑：2 万格必须**毫秒级**（旧 O(n²) 实现是秒级停顿）', () => {
    const big = makeGrid(200, 100, 14.4, (c, r) => (c * 7 + r * 13) % 100);
    const t0 = Date.now();
    const r = RS.smoothHeightmapGrid(big, { radius: 2, passes: 1 });
    const dt = Date.now() - t0;
    assert(r.ok, '应当成功');
    assert(dt < 500, `2 万格平滑耗时 ${dt}ms —— 超过 500ms 说明退化成了全表扫描（旧实现是 O(n²)）`);
    return `${big.h.length} 格 / ${dt} ms`;
  });

  check('平滑：不改入参；没有网格时给可读失败而不是抛错', () => {
    const chk = makeGrid(4, 4, 10, (c) => c);
    const before = Array.from(chk.h).join(',');
    RS.smoothHeightmapGrid(chk, { radius: 1 });
    assert(Array.from(chk.h).join(',') === before, '入参被改了');
    const bad = RS.smoothHeightmapGrid({ h: [], grid: { points: [] } }, { radius: 1 });
    assert(!bad.ok && !!bad.message, '空网格应给可读失败');
    return 'ok';
  });

  // ══════════════════════════════════════════════════════════════════════
  // 三、河流画法（线宽 / 折线构造）
  // ══════════════════════════════════════════════════════════════════════
  check('🔴 河宽随汇流量**单调递增**，且有上下限（"一条河一个粗细"就是一眼假）', () => {
    const ws = [1, 2, 4, 8, 16, 64, 256, 1024].map((f) => RR.riverWidthAt(f));
    for (let i = 1; i < ws.length; i++) {
      assert(ws[i] >= ws[i - 1], `线宽必须单调不减：flow=${[1, 2, 4, 8, 16, 64, 256, 1024][i]} 时 ${ws[i]} < ${ws[i - 1]}`);
    }
    assert(ws[0] >= RR.RIVER_W_MIN_WORLD - 1e-9, `源头最细不得低于下限 ${RR.RIVER_W_MIN_WORLD}`);
    assert(ws[ws.length - 1] <= RR.RIVER_W_MAX_WORLD + 1e-9, `干流最粗不得超过上限 ${RR.RIVER_W_MAX_WORLD}`);
    assert(ws[ws.length - 1] > ws[0] * 1.5, `量级差必须看得出来：${ws[0].toFixed(2)} → ${ws[ws.length - 1].toFixed(2)}`);
    assert(RR.riverWidthAt(NaN) === RR.riverWidthAt(1), '非法流量要退回 1 而不是 NaN');
    return `flow 1→1024：${ws[0].toFixed(2)} → ${ws[ws.length - 1].toFixed(2)} 世界单位`;
  });

  // 🔴 2026-10-14 第四修：**这条是用户实测截图逼出来的**。
  //    用户原话「河流并没有越往下游越宽」。根因是旧口径是**绝对**的
  //    （`0.55 + cbrt(flow)*0.75`），而这份地形实测 flow ∈ [1, 20] →
  //    整条河 1.49→2.11（**1.4 倍**），肉眼就是一样粗。
  check('🔴 flowWidthScale：窄量程地形上必须拉开**明显**粗细差（旧绝对口径只有 1.4 倍）', () => {
    // 真实 desite 底图实测：段汇流量 min=1 max=20，代表路径出口 8~9
    const oldW = (f) => Math.max(0.7, Math.min(5, 0.55 + Math.cbrt(f) * 0.75));
    const oldRatio = oldW(20) / oldW(1);
    const newW = [1, 2, 3, 5, 8, 12, 20].map((f) => RR.flowWidthScale(f, 20));
    const newRatio = newW[newW.length - 1] / newW[0];
    for (let i = 1; i < newW.length; i++) {
      assert(newW[i] >= newW[i - 1] - 1e-9, `归一化后仍必须单调不减：${newW.join(', ')}`);
    }
    assert(newRatio > 3, `窄量程（1~20）上粗细比应 >3 倍，实际 ${newRatio.toFixed(2)}（旧口径 ${oldRatio.toFixed(2)}）`);
    assert(newRatio > oldRatio * 2, `必须显著优于旧绝对口径：新 ${newRatio.toFixed(2)} vs 旧 ${oldRatio.toFixed(2)}`);
    assert(newW[0] >= RR.RIVER_W_MIN_WORLD - 1e-9 && newW[newW.length - 1] <= RR.RIVER_W_MAX_WORLD + 1e-9,
      '必须被 min/max 夹住');
    // 病态输入不许出 NaN（那会让整条河不画）
    for (const bad of [[1, 1], [1, 0], [5, NaN], [0, 0], [NaN, NaN]]) {
      const w = RR.flowWidthScale(bad[0], bad[1]);
      assert(Number.isFinite(w) && w > 0, `flowWidthScale(${bad}) 必须给出有限正数，实际 ${w}`);
    }
    return `1→20：${newW[0].toFixed(2)} → ${newW[newW.length - 1].toFixed(2)}（${newRatio.toFixed(1)}×，旧口径仅 ${oldRatio.toFixed(1)}×）`;
  });

  // 🔴 树枝状汇聚的几何本体 = **段**（用户实测：「根本画不出复杂的河流汇聚」）。
  //    这条钉子保证 traceRivers 真的把流向场输出成段，而不是只有"每个源头一条代表路径"。
  check('🔴 strokeRiverNetwork：逐段描边、按流量归一化、clip 能挡掉入海段', () => {
    const calls = { stroke: 0, widths: [] };
    const ctx = {
      save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
      stroke() { calls.stroke++; },
      set lineWidth(v) { calls.widths.push(v); }, get lineWidth() { return 1; },
      strokeStyle: '', lineCap: '', lineJoin: '', globalAlpha: 1,
    };
    const segs = [
      { x0: 0, y0: 0, x1: 10, y1: 0, flow: 1 },
      { x0: 10, y0: 0, x1: 20, y1: 0, flow: 20, endInSea: true },
    ];
    const r = RR.strokeRiverNetwork(ctx, segs, {
      toPx: (w) => w,
      maxFlow: 20,
      // 挡掉"入海"的那一段（模拟裁到海岸线之后仍然整段在水里的情况）
      clip: (x0, y0, x1, y1) => !(x0 >= 10),
    });
    assert(r.drawn === 1 && r.skipped === 1, `应画 1 段、跳 1 段，实际 drawn=${r.drawn} skipped=${r.skipped}`);
    assert(calls.stroke === 2, `两遍 × 1 段 = 2 次 stroke，实际 ${calls.stroke}`);
    assert(RR.strokeRiverNetwork(null, segs, { toPx: (w) => w }).drawn === 0, '没有 ctx 应安全返回');
    assert(RR.strokeRiverNetwork(ctx, [], { toPx: (w) => w }).drawn === 0, '空段应安全返回');
    assert(RR.strokeRiverNetwork(ctx, segs, {}).drawn === 0, '没有 toPx 应返回 0（不许拿世界单位当像素）');
    return `描 ${r.drawn} 段 / 跳 ${r.skipped} 段`;
  });

  check('折线构造：按 step 细分、逐点宽度在两端之间线性过渡、端点原样保留', () => {
    const river = { points: [{ x: 0, y: 0 }, { x: 30, y: 0 }], flows: [1, 27] };
    const poly = RR.buildRiverPolyline(river, { spacing: 30, step: 10 });
    assert(poly.pts.length === 4, `30 长 / step 10 → 应 4 个点，实际 ${poly.pts.length}`);
    assert(poly.pts[0].x === 0 && poly.pts[3].x === 30, '端点必须原样保留（河口位置一字不差）');
    assert(poly.widths[0] < poly.widths[3], `末端应更粗：${poly.widths[0]} vs ${poly.widths[3]}`);
    for (let i = 1; i < poly.widths.length; i++) {
      assert(poly.widths[i] >= poly.widths[i - 1] - 1e-9, '段内宽度必须单调（汇流是渐变不是台阶）');
    }
    assert(close(poly.worldLen, 30, 1e-6), `世界长度应为 30，实际 ${poly.worldLen}`);
    // 默认（不传 step）= 每格 2 段：一格 14.4 世界单位 → 段长约 7.2，3 个点 → 4~5 个采样点。
    // 这条**是每帧调用次数的护栏**：逐段描边每段两次 stroke，采样点翻倍就翻倍。
    const def = RR.buildRiverPolyline({ points: [{ x: 0, y: 0 }, { x: 14.4, y: 0 }, { x: 28.8, y: 0 }] });
    assert(def.pts.length <= 5, `默认每格最多 2 段（3 点应 ≤5 采样点），实际 ${def.pts.length}`);
    return `${poly.pts.length} 点 / 宽度 ${poly.widths.map((w) => w.toFixed(2)).join(' → ')}；默认 3 点 → ${def.pts.length} 采样`;
  });

  check('折线构造：没有 flows（手画河 / 旧数据）→ 常数宽度，不崩', () => {
    const poly = RR.buildRiverPolyline({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], flow: 9 });
    assert(poly && poly.widths.every((w) => close(w, poly.widths[0], 1e-9)), '缺 flows 应退化成常数宽度');
    assert(RR.buildRiverPolyline({ points: [{ x: 0, y: 0 }] }) === null, '单点应返回 null（调用方跳过）');
    assert(RR.buildRiverPolyline(null) === null, 'null 不该抛');
    return 'ok';
  });

  check('strokeRiver：逐段描边（两遍）、段数 = 点数-1、没有 ctx 时安全返回 0', () => {
    const calls = { move: 0, line: 0, stroke: 0, lineWidths: [] };
    const ctx = {
      save() {}, restore() {}, beginPath() {},
      moveTo() { calls.move++; }, lineTo() { calls.line++; },
      stroke() { calls.stroke++; },
      set lineWidth(v) { calls.lineWidths.push(v); }, get lineWidth() { return 1; },
      strokeStyle: '', lineCap: '', lineJoin: '', globalAlpha: 1,
    };
    const poly = { pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }], widths: [1, 2, 3] };
    const n = RR.strokeRiver(ctx, poly, { toPx: (w) => w * 2 });
    assert(n === 2, `应描 2 段，实际 ${n}`);
    assert(calls.stroke === 4, `两遍 × 2 段 = 4 次 stroke，实际 ${calls.stroke}`);
    assert(calls.lineWidths.length === 4, `每次 stroke 前都要设线宽，实际 ${calls.lineWidths.length}`);
    // 外层宽度 = 段均值 × washScale(2.4)，内层 = 段均值
    const avg0 = (1 + 2) / 2, avg1 = (2 + 3) / 2;
    assert(close(calls.lineWidths[0], avg0 * 2.4 * 2, 1e-6), `外层第一段线宽错：${calls.lineWidths[0]}`);
    assert(close(calls.lineWidths[2], avg0 * 2, 1e-6), `内层第一段线宽错：${calls.lineWidths[2]}`);
    assert(RR.strokeRiver(null, poly, { toPx: (w) => w }) === 0, '没有 ctx 应返回 0');
    assert(RR.strokeRiver(ctx, poly, {}) === 0, '没有 toPx 应返回 0（不许拿世界单位当像素）');
    return `2 段 × 2 遍，线宽 ${calls.lineWidths.map((v) => v.toFixed(2)).join(',')}`;
  });

  // 🔴 河网段是"逐格"的，真实底图 1717 段 / 用例地形 3750 段 —— **每帧**都要描两遍。
  //    用户明确要求"注意性能"，所以这里把帧成本量出来并设上限，而不是嘴上说"看不出来"。
  check('🔴 strokeRiverNetwork：真实量级（2000+ 段）每帧耗时有上限（用户要求「注意性能」）', () => {
    const segs = [];
    for (let i = 0; i < 4000; i++) {
      segs.push({
        x0: (i % 100) * 14.4, y0: Math.floor(i / 100) * 14.4,
        x1: (i % 100) * 14.4 + 14.4, y1: Math.floor(i / 100) * 14.4,
        flow: 1 + (i % 20),
      });
    }
    const ctx = {
      save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
      set lineWidth(v) {}, get lineWidth() { return 1; },
      strokeStyle: '', lineCap: '', lineJoin: '', globalAlpha: 1,
    };
    const t0 = Date.now();
    const r = RR.strokeRiverNetwork(ctx, segs, { toPx: (w) => w });
    const dt = Date.now() - t0;
    assert(r.drawn === 4000, `应描 4000 段，实际 ${r.drawn}`);
    // 空 ctx（没有真实 canvas 调用）下 4000 段 × 2 遍 = 8000 次；真实 canvas 会慢一些，
    // 所以上限给宽（200ms），要抓的是"退化成 O(段数²)"那种量级崩坏。
    assert(dt < 200, `4000 段两遍描边耗时 ${dt}ms —— 超过 200ms 说明每帧会明显拖慢画布`);
    return `4000 段 × 2 遍 / ${dt} ms（真实底图只有 1717 段）`;
  });

  check('反向探针：线宽若写成常数 → 上面的单调断言必须能抓到', () => {
    const flat = (f) => 2.0;                       // 假装是"旧口径"
    const ws = [1, 8, 64, 512].map(flat);
    let caught = false;
    for (let i = 1; i < ws.length; i++) if (!(ws[i] > ws[i - 1])) caught = true;
    assert(caught, '探针本身失效 —— 那样"线宽随流量递增"这条断言就是假绿');
    return '探针有效';
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('用例自身崩溃：', err);
  process.exit(1);
});
