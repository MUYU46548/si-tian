#!/usr/bin/env node
/**
 * Node 单元测试：海岸线掩膜与裁剪（src/renderer/src/utils/coastline.js）
 *              + 自动河流追踪（src/renderer/src/utils/riverTrace.js）
 *
 * 为什么必须有这一层：这两块都是**纯几何/纯算法**，错了不会报错，只会让地图看起来
 * 「有点不对」—— 河画到海里去、河凭空断一节、河流走向是上坡。CDP 用例里要发现它们
 * 得靠像素比对，代价高且说不清是哪一步错的。这里直接对输出下断言。
 *
 * 两条本用例重点守的东西（都是 2026-10-14 用户实测暴露的）：
 *   ① 河流**不能走上坡**（旧实现取"半径内最低者"，不判它是否比自己低 → 能在山脊上打转）；
 *   ② 河流**不能停在到不了海的洼地里**（旧实现追到局部最低就 break，凑够 4 点照样画出来）。
 *
 * 用法：node scripts/tests/unit/test_river_coastline.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const DEPS = ['coastline.js', 'riverTrace.js', 'polylineSmooth.js', 'gridSpatialIndex.js', 'heightmapResample.js', 'riverRender.js', 'rivers.js'];

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

/** 可选的 canvas 实现（仓库**没有**装 `@napi-rs/canvas`）——有就用真 ctx 判像素，没有就降级。
 *  ⚠️ 刻意不把 canvas 变成测试依赖：本仓 Node 层一直靠"记录式 stub"判调用，装原生模块会
 *     把单测变成需要编译产物的东西（跨机器/CI 直接红）。 */
function tryCanvas() {
  try { return require('@napi-rs/canvas'); } catch (_) { return null; }
}

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

// ── 构造辅助 ────────────────────────────────────────────────────────────────
/** 矩形省份（{x,y} 形态，与项目文件一致） */
function rect(x0, y0, x1, y1, extra) {
  return {
    id: extra && extra.id || `p_${x0}_${y0}`,
    kind: (extra && extra.kind) || 'land',
    points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
  };
}
/** 规则栅格高度图（行主序，与 buildGridFromTerrain 同构） */
function makeGrid(cols, rows, spacing, hFn) {
  const points = new Array(cols * rows);
  const h = new Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      points[i] = [c * spacing, r * spacing];
      h[i] = hFn(c, r);
    }
  }
  return { grid: { points, spacing, cellsX: cols, cellsY: rows, count: points.length }, h };
}

async function main() {
  const root = pickTmpRoot();
  if (!root) throw new Error('找不到可写的临时目录');
  const tmp = fs.mkdtempSync(path.join(root, 'sitian-river-'));
  const fixExt = (src) => src.replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
  for (const f of DEPS) {
    fs.writeFileSync(path.join(tmp, f), fixExt(fs.readFileSync(path.join(SRC_DIR, f), 'utf8')));
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const C = await import(pathToFileURL(path.join(tmp, 'coastline.js')).href);
  const R = await import(pathToFileURL(path.join(tmp, 'riverTrace.js')).href);
  const RR = await import(pathToFileURL(path.join(tmp, 'riverRender.js')).href);

  // ══════════════════════════════════════════════════════════════════════
  // 一、陆地掩膜
  // ══════════════════════════════════════════════════════════════════════
  const mask = C.buildLandMask([rect(0, 0, 100, 100), rect(200, 0, 260, 60)]);

  check('pointInRing：射线法基本正确（内 / 外 / 边界）', () => {
    const ring = [[0, 0], [10, 0], [10, 10], [0, 10]];
    assert(C.pointInRing(ring, 5, 5), '中心应在环内');
    assert(!C.pointInRing(ring, 15, 5), '环外不应判为内');
    assert(!C.pointInRing(ring, -1, 5), '左侧外不应判为内');
    return 'ok';
  });

  check('buildLandMask：第一块陆地内 / 两块的缝隙 / 外面分别判定正确', () => {
    assert(mask.lookup(50, 50), '(50,50) 应在陆地内');
    assert(mask.lookup(210, 30), '(210,30) 应在第二块陆地内');
    assert(!mask.lookup(150, 30), '(150,30) 在两块之间，必须是水');
    assert(!mask.lookup(500, 500), '远处必须是水');
    return `${mask.ringCount} 环 / ${mask.bucketCount} 桶`;
  });

  check('buildLandMask：`kind: "sea"` 的多边形算水、不算陆', () => {
    // 只有一块海：判定必须全是水（旧实现若把 sea 当陆，河就照旧画到海上）
    const m = C.buildLandMask([rect(0, 0, 100, 100, { kind: 'sea' })]);
    assert(!m.lookup(50, 50), '海域多边形不能把点判成陆地（否则河照旧画到海上）');
    assert(m.ringCount === 0, `海域应从掩膜里剔除，实际 ringCount=${m.ringCount}`);
    // 海 + 陆各一块：陆的那块照常判内
    const m2 = C.buildLandMask([rect(0, 0, 100, 100, { kind: 'sea' }), rect(200, 0, 300, 100)]);
    assert(!m2.lookup(50, 50) && m2.lookup(250, 50), '同底图上海域与陆地必须分开判定');
    return 'ok';
  });

  check('buildLandMask：包围盒外的点不进射线法（桶筛选生效）', () => {
    // 只在陆地里外各取一点，靠 bucketCount 断言"没有把每个环都塞进所有桶"
    assert(mask.bucketCount > 0 && mask.bucketCount < 5000, `桶数异常：${mask.bucketCount}`);
    return `${mask.bucketCount} 桶`;
  });

  check('buildLandMask：兼容 `[x, y]` 数组形态的顶点（旧数据）', () => {
    const m = C.buildLandMask([{ kind: 'land', points: [[0, 0], [10, 0], [10, 10], [0, 10]] }]);
    assert(m.lookup(5, 5), '数组形态的环必须同样能被判定');
    return 'ok';
  });

  // ══════════════════════════════════════════════════════════════════════
  // 二、折线裁剪
  // ══════════════════════════════════════════════════════════════════════
  const isLand = (x, y) => x <= 100;

  check('clipPolylineToCoast：全在陆地 → 原样返回、trimmed=false', () => {
    const pts = [{ x: 10, y: 10 }, { x: 50, y: 50 }, { x: 90, y: 90 }];
    const r = C.clipPolylineToCoast(pts, isLand);
    assert(!r.trimmed && !r.dropped, '不该动它');
    assert(r.points.length === 3, '点数不该变');
    return 'ok';
  });

  check('🔴 尾部入海段被砍掉，且**补上交点**（河停在岸线上，不是停在最后一个陆格）', () => {
    const pts = [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 90, y: 10 }, { x: 150, y: 10 }, { x: 300, y: 10 }];
    const r = C.clipPolylineToCoast(pts, isLand);
    assert(r.trimmed, '应当被裁剪');
    const last = r.points[r.points.length - 1];
    assert(Math.abs(last.x - 100) < 1.0, `末端应落在岸线 x≈100 上，实际 ${last.x}`);
    assert(r.points.length === 4, `应是 3 个陆点 + 1 个交点，实际 ${r.points.length}`);
    return `末端 x=${last.x.toFixed(2)}`;
  });

  check('clipPolylineToCoast：keepOvershoot 让河口咬住海面（越过岸线一小段）', () => {
    const pts = [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 200, y: 10 }];
    const r = C.clipPolylineToCoast(pts, isLand, { keepOvershoot: 5 });
    const last = r.points[r.points.length - 1];
    assert(last.x > 100 && last.x <= 105.5, `应越过岸线 ≤5，实际 ${last.x}`);
    return `越过 ${(last.x - 100).toFixed(2)}`;
  });

  check('🔴 中间的水段（湖）**保留**：一条过湖的河不能被切成两截', () => {
    // x∈[40,60] 判成水，两端是陆
    const wet = (x) => x < 40 || x > 60;
    const pts = [{ x: 10, y: 5 }, { x: 50, y: 5 }, { x: 90, y: 5 }];
    const r = C.clipPolylineToCoast(pts, wet);
    assert(!r.trimmed, '中间过湖不该触发裁剪');
    assert(r.points.length === 3, `点数应保持 3，实际 ${r.points.length}`);
    return '过湖段保留';
  });

  check('clipPolylineToCoast：全在水里 → 丢弃（dropped=true，points 为空）', () => {
    const r = C.clipPolylineToCoast([{ x: 200, y: 0 }, { x: 300, y: 0 }], isLand);
    assert(r.dropped && r.points.length === 0, '全在水里的折线应被丢弃');
    return 'ok';
  });

  check('clipPolylineToCoast：头部在水里 → 头部也裁（交点在最前）', () => {
    const pts = [{ x: 300, y: 0 }, { x: 150, y: 0 }, { x: 50, y: 0 }];
    const r = C.clipPolylineToCoast(pts, isLand);
    assert(r.trimmed && !r.dropped, '应裁掉头部');
    const first = r.points[0];
    assert(Math.abs(first.x - 100) < 1.0, `首点应落在岸线 x≈100，实际 ${first.x}`);
    assert(r.points.length === 2, `应是交点 + 1 个陆点，实际 ${r.points.length}`);
    return `首点 x=${first.x.toFixed(2)}`;
  });

  check('🔴 裁剪后的点**全部落在陆地上**（不变量：再裁一次不该再动它）', () => {
    const pts = [{ x: 300, y: 0 }, { x: 150, y: 0 }, { x: 50, y: 0 }, { x: 150, y: 0 }, { x: 400, y: 0 }];
    const r1 = C.clipPolylineToCoast(pts, isLand);
    const inWater = r1.points.filter((p) => !isLand(p.x, p.y));
    assert(inWater.length === 0, `裁剪后仍有 ${inWater.length} 个点在陆地外（二分交点落在水侧的 ε 上）`);
    const r2 = C.clipPolylineToCoast(r1.points, isLand);
    assert(!r2.trimmed, '幂等性：已经裁好的折线不该再被裁一次');
    return `${r1.points.length} 点全部在陆地`;
  });

  check('clipPolylineToCoast：判定函数抛错时不误删（当作陆地）', () => {
    const boom = () => { throw new Error('判定炸了'); };
    const r = C.clipPolylineToCoast([{ x: 1, y: 1 }, { x: 2, y: 2 }], boom);
    assert(!r.dropped && r.points.length === 2, '判定抛错必须保守处理，不能把河删掉');
    return 'ok';
  });

  check('clipPolylinesToCoast：批量统计（trimmed / dropped / unchanged）且不改原对象', () => {
    const list = [
      { id: 'a', points: [{ x: 0, y: 0 }, { x: 200, y: 0 }] },      // 尾入海 → trimmed
      { id: 'b', points: [{ x: 10, y: 0 }, { x: 20, y: 0 }] },      // 全陆 → unchanged
      { id: 'c', points: [{ x: 200, y: 0 }, { x: 300, y: 0 }] },    // 全水 → dropped
    ];
    const before = JSON.stringify(list);
    const r = C.clipPolylinesToCoast(list, isLand);
    assert(r.trimmed === 1 && r.dropped === 1 && r.unchanged === 1,
      `统计错：trimmed=${r.trimmed} dropped=${r.dropped} unchanged=${r.unchanged}`);
    assert(r.list.length === 2, `出图应 2 条，实际 ${r.list.length}`);
    assert(JSON.stringify(list) === before, '入参不能被改（渲染缓存按引用比较，改了引用就永远命中不了）');
    return `${r.list.length} 条出图`;
  });

  // ── 二b、**段**裁剪（2026-10-14 第四修：自动河流的河网段就是"两点的段"）──────────
  // 用户实测截图原话「依然过度延伸到海洋部分」：段的一端是海格中心，不裁就插进海里。
  check('🔴 clipSegmentToLand：陆→水的段裁到岸线（不再伸进海里）', () => {
    const r = C.clipSegmentToLand({ x0: 10, y0: 5, x1: 200, y1: 5, flow: 3, endInSea: true }, isLand);
    assert(r, '应当保留陆地那一截');
    assert(Math.abs(r.x1 - 100) < 1.0, `末端应落在岸线 x≈100，实际 ${r.x1}`);
    assert(r.x0 === 10 && r.y0 === 5, '陆端不能被改');
    assert(r.flow === 3, '汇流量必须带过去（线宽要用）');
    assert(r.endInSea === true, '标记这是入海口（渲染端据此决定要不要"咬"进海面一点）');
    return `末端 x=${r.x1.toFixed(2)}`;
  });

  check('🔴 clipSegmentToLand：水→陆的段保留陆端（方向反过来也要对）', () => {
    const r = C.clipSegmentToLand({ x0: 200, y0: 5, x1: 10, y1: 5, flow: 2, endInSea: false }, isLand);
    assert(r, '应当保留陆地那一截');
    assert(Math.abs(r.x0 - 100) < 1.0, `首端应落在岸线 x≈100，实际 ${r.x0}`);
    assert(r.x1 === 10, '陆端不能被改');
    assert(r.endInSea === false, '这一端不是入海口');
    return `首端 x=${r.x0.toFixed(2)}`;
  });

  check('clipSegmentToLand：全陆原样（endInSea 清零）/ 全水丢弃 / 判定抛错不误删', () => {
    const dry = C.clipSegmentToLand({ x0: 0, y0: 0, x1: 50, y1: 0, flow: 5, endInSea: true }, isLand);
    assert(dry && dry.x0 === 0 && dry.x1 === 50 && dry.endInSea === false,
      '全陆的段不该被动，且 endInSea 必须清零（否则渲染端会去"咬海"）');
    assert(C.clipSegmentToLand({ x0: 200, y0: 0, x1: 300, y1: 0, flow: 1 }, isLand) === null,
      '全在水里的段应返回 null（丢弃）');
    const boom = C.clipSegmentToLand({ x0: 0, y0: 0, x1: 50, y1: 0, flow: 1 },
      () => { throw new Error('判定炸了'); });
    assert(boom && boom.x1 === 50, '判定抛错必须保守当陆地，不能把段删掉');
    return 'ok';
  });

  check('clipSegmentToLand：keepOvershoot 让河口"咬"住海面一小段', () => {
    const r = C.clipSegmentToLand({ x0: 10, y0: 5, x1: 200, y1: 5, flow: 3 }, isLand, { keepOvershoot: 5 });
    assert(r.x1 > 100 && r.x1 <= 105.5, `应越过岸线 ≤5，实际 ${r.x1}`);
    return `越过 ${(r.x1 - 100).toFixed(2)}`;
  });

  // ══════════════════════════════════════════════════════════════════════
  // 三、河流追踪
  // ══════════════════════════════════════════════════════════════════════
  // 一座"南向倾斜的山"：上缘高、下缘低，最下一行是海
  const COLS = 12, ROWS = 10, SP = 10;
  const slope = makeGrid(COLS, ROWS, SP, (c, r) => (r === ROWS - 1 ? 0 : 100 - r * 10));

  const t1 = R.traceRivers(slope);
  check('traceRivers：斜面地形 → 有河、且每条都**真的入海**（末端是海格）', () => {
    assert(t1.rivers.length > 0, '应当追踪出河流');
    const H = slope.h;
    const pts = slope.grid.points;
    const bad = [];
    for (const r of t1.rivers) {
      const end = r.points[r.points.length - 1];
      // 找最近格判高度
      let bi = -1, bd = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const d = (pts[i][0] - end.x) ** 2 + (pts[i][1] - end.y) ** 2;
        if (d < bd) { bd = d; bi = i; }
      }
      if (!(H[bi] < R.TRACE_SEA_LEVEL)) bad.push(`${end.x},${end.y}=h${H[bi]}`);
    }
    assert(bad.length === 0, `${bad.length} 条河的末端不在海里（河没入海 = 画到一半就断了）：${bad.slice(0, 3)}`);
    return `${t1.rivers.length} 条河`;
  });

  check('🔴 traceRivers：每一步都**严格更低**（不许走上坡）', () => {
    const H = slope.h, pts = slope.grid.points;
    const idx = (p) => {
      let bi = -1, bd = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const d = (pts[i][0] - p.x) ** 2 + (pts[i][1] - p.y) ** 2;
        if (d < bd) { bd = d; bi = i; }
      }
      return bi;
    };
    let steps = 0;
    for (const r of t1.rivers) {
      for (let i = 0; i + 1 < r.points.length; i++) {
        const a = H[idx(r.points[i])], b = H[idx(r.points[i + 1])];
        assert(b < a, `第 ${i} 步走上坡：${a} → ${b}（旧实现就是这样在山脊上打转的）`);
        steps++;
      }
    }
    return `${steps} 步全部下坡`;
  });

  check('🔴 traceRivers：到不了海的闭合洼地**不算源头**（不凭空生河）', () => {
    // 中间一个四周都高的坑：中心 h=90，周围一圈 h=99，其余地方是海
    const sink = makeGrid(9, 9, 10, (c, r) => {
      if (c === 4 && r === 4) return 90;
      if (Math.abs(c - 4) <= 1 && Math.abs(r - 4) <= 1) return 99;
      return 0;
    });
    const t = R.traceRivers(sink);
    const nearCenter = t.rivers.filter((rv) => rv.points.some((p) => Math.abs(p.x - 40) < 12 && Math.abs(p.y - 40) < 12));
    assert(nearCenter.length === 0, `洼地里凭空生出 ${nearCenter.length} 条河（旧实现在这里就会画一条短线）`);
    return `源头 ${t.sources} 个，无洼地河`;
  });

  check('🔴 河网段（树枝状汇聚的几何本体）：每个能到海的陆地格都有一条段', () => {
    // 用户实测原话：「根本画不出复杂的河流汇聚（树枝状的河流，如多条河流汇总到一条
    // 大河最终入海）。地图自带河流做的比自动河流好」。
    // 根因是 `rivers[]` 只是"每个源头一条代表路径"，不含汇进来的支流 —— 实测真实底图
    // 3 条河只有 12 个点（陆地 2506 格），结构上画不出树枝状。段才是几何本体。
    assert(Array.isArray(t1.segments), 'traceRivers 必须输出 segments（河网段）');
    assert(t1.segments.length > 0, '斜地形上必须有段');
    // 每一段的形态：两个端点 + 汇流量 ≤ 上界 + 有序
    const bad = t1.segments.filter((s) => !Number.isFinite(s.x0) || !Number.isFinite(s.y1) || !(s.flow >= 1));
    assert(bad.length === 0, `有 ${bad.length} 段的坐标或汇流量不合法`);
    for (let i = 1; i < t1.segments.length; i++) {
      assert(t1.segments[i].flow >= t1.segments[i - 1].flow,
        '段必须按汇流量**升序**排（渲染按此顺序落笔：细的在下、粗的在上）');
    }
    const top = t1.segments[t1.segments.length - 1];
    assert(t1.segMaxFlow === top.flow, `segMaxFlow（${t1.segMaxFlow}）必须等于最大段的汇流量（${top.flow}）`);
    // ⚠️ 判据用「**每格最多一段**」这条结构不变量，**不是**"段数 > 代表路径点数" ——
    //    后者在小合成地形上会假红（实测 108 段 vs 264 点：代表路径每条有 5.5 个点，
    //    点数当然可能更多）。真正要钉的是"段是**逐格**的"，那与点数无关。
    const starts = new Set(t1.segments.map((s) => s.x0 + ',' + s.y0));
    assert(starts.size === t1.segments.length,
      `每格只能有一段（起点去重 ${starts.size} ≠ 段数 ${t1.segments.length}）—— 说明段不是"逐格"的`);
    // 而且它必须**比代表路径覆盖得宽**（河网 vs 几根孤立线）：
    const riverCells = new Set();
    for (const r of t1.rivers) for (const p of r.points) riverCells.add(p.x + ',' + p.y);
    assert(t1.segments.length > riverCells.size,
      `段覆盖（${t1.segments.length} 格）必须比代表路径覆盖（${riverCells.size} 格）更宽 —— `
      + '否则"树枝状汇聚"在结构上仍然画不出来（那正是用户实测看到的问题）');
    return `${t1.segments.length} 段（逐格）/ 代表路径覆盖 ${riverCells.size} 格 / segMaxFlow=${t1.segMaxFlow}`;
  });

  // 🔴 内流盆地（2026-10-15）：用户提到「地图自带河流……还有内流河」。
  //    这条**不改行为**（内流格照旧不画 —— 口径 ② 防"内陆凭空一条河"），只保证
  //    "盆地口径"被**量出来并回报**，让"要不要画内流河"有据可依、不是拍脑袋。
  check('内流盆地：到不了海的洼地被量出来并回报（不改绘制行为）', () => {
    // 中间一个四周都高的坑（h=90 被 h=99 围住），坑里/坡上的水出不去
    const sink = makeGrid(9, 9, 10, (c, r) => {
      if (Math.abs(c - 4) <= 2 && Math.abs(r - 4) <= 2) return c === 4 && r === 4 ? 90 : 95;
      return 0;                      // 其余是海
    });
    // 注入"全是陆地"的判定：让那圈洼地不会被当成海岸线附近
    const t = R.traceRivers(sink, { isLand: () => true });
    assert(typeof t.endorheicCells === 'number', 'traceRivers 必须回报 endorheicCells');
    assert(Array.isArray(t.basins), 'traceRivers 必须回报 basins');
    assert(t.endorheicCells > 0, `这片地形必须有"水出不去"的格，实际 ${t.endorheicCells}`);
    assert(t.basins.length > 0, '必须量出至少一个盆地');
    const top = t.basins[0];
    assert(top.cells >= 1 && Number.isFinite(top.lowest) && Number.isFinite(top.x),
      `盆地记录必须带面积/最低点/坐标：${JSON.stringify(top)}`);
    // 盆地面积之和 ≥ 去重格数（共用一个上游时会被两个盆地各数一次）
    assert(t.basinCells >= t.endorheicCells,
      `basinCells（${t.basinCells}）应 ≥ endorheicCells（${t.endorheicCells}）`);
    // ⚠️ 关键：**绘制行为不变** —— 内流格一个都不许出现在河/段里
    const endorheicSet = new Set();
    for (let i = 0; i < sink.h.length; i++) if (sink.h[i] >= R.TRACE_SEA_LEVEL) endorheicSet.add(i);
    // 用"末端高度"反查：所有段的末端都必须 ≥ 海平面（陆地格），不存在"终点在水里"的段
    const badSeg = t.segments.filter((s) => !Number.isFinite(s.x1));
    assert(badSeg.length === 0, `有 ${badSeg.length} 段的坐标不合法`);
    return `${t.endorheicCells} 格出不去 / ${t.basins.length} 个盆地 / 最大 ${top.cells} 格`;
  });

  check('内流盆地：没有 isLand 注入时不乱报（海域边界噪声不算盆地）', () => {
    const t = R.traceRivers(slope);          // 不注入 isLand
    assert(t.basins.length === 0, `没有陆地判定时不该报盆地，实际 ${t.basins.length} 个`);
    assert(t.endorheicCells >= 0, 'endorheicCells 仍应是个数（可以是 0）');
    return 'ok';
  });

  check('🔴 汇流量必须真的**累积**（flow 不是恒为 1）', () => {    // 这一条是 2026-10-14 实测抓到的真缺陷：累加顺序写成升序 → donor 交量时 receiver
    // 早已处理完 → 量全丢，`flow` 恒为 1，线宽分级整个失效（所有河一样细 = 用户说的"僵硬"）。
    // 斜面地形上，最下面那格的汇流量应该接近整列格数 —— 不接近就说明累加没生效。
    const flows = t1.rivers.map((r) => r.flow);
    const maxF = Math.max(...flows);
    assert(maxF >= COLS, `斜面 ${COLS} 列，最大汇流量应 ≥ ${COLS}（实际 ${maxF}）= 累加没生效`);
    const ones = flows.filter((f) => f <= 1).length;
    assert(ones === 0, `有 ${ones} 条河的 flow ≤ 1（高度累加没发生）`);
    return `最大汇流 ${maxF}`;
  });

  check('🔴 平滑：Chaikin 只切角、端点不动、点数按 2 倍增长', () => {
    const line = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    const s1 = R.smoothPolyline(line, 1);
    const s2 = R.smoothPolyline(line, 2);
    assert(s1.length === 2 + (line.length - 1) * 2, `1 次迭代点数为 2n-2，实际 ${s1.length}`);
    assert(s2.length === 2 + (s1.length - 1) * 2, `2 次迭代应在 1 次的结果上再翻倍，实际 ${s2.length}`);
    const head = s1[0], tail = s1[s1.length - 1];
    assert(head.x === 0 && head.y === 0, `首点必须原样保留，实际 ${JSON.stringify(head)}`);
    assert(tail.x === 10 && tail.y === 10, `末点必须原样保留（河口位置一字不差），实际 ${JSON.stringify(tail)}`);
    // 只切角不外扩：所有点必须落在原折线的包围盒内
    const out = s2.filter((p) => p.x < -1e-9 || p.x > 10 + 1e-9 || p.y < -1e-9 || p.y > 10 + 1e-9);
    assert(out.length === 0, `平滑点跑出包围盒 ${out.length} 个（Chaikin 不该过冲）`);
    assert(R.smoothPolyline(line, 0).length === 3, '迭代 0 次应原样返回');
    assert(R.smoothPolyline([{ x: 1, y: 1 }], 2).length === 1, '单点不该被展开');
    return `${line.length} → ${s1.length} → ${s2.length}`;
  });

  check('🔴 河源闸门（channelInit）：调大必须真的减少条数', () => {
    const t1r = R.traceRivers(slope, { channelInit: 1 });
    const t5r = R.traceRivers(slope, { channelInit: 5 });
    assert(t1r.rivers.length > 0, 'channelInit=1 应当出图（否则这个判据是空转）');
    assert(t5r.rivers.length <= t1r.rivers.length,
      `阈值调大后条数应不增，实际 ${t1r.rivers.length} → ${t5r.rivers.length}`);
    return `init=1 → ${t1r.rivers.length} 条；init=5 → ${t5r.rivers.length} 条`;
  });

  check('traceRivers：没有高度图 / 长度对不上 → 空结果而不是抛错', () => {
    assert(R.traceRivers(null).rivers.length === 0, 'null 应给空结果');
    assert(R.traceRivers({ h: [1, 2], grid: { points: [[0, 0]] } }).rivers.length === 0, '长度不一致应给空结果');
    assert(R.traceRivers({ h: [], grid: { points: [] } }).rivers.length === 0, '空网格应给空结果');
    return 'ok';
  });

  check('traceRivers：每一步只找**邻居**（半径 = spacing×factor），不跨图连点', () => {
    // 只留一个高地，其余海：那条河最多只能有几步（邻居半径 15 → 不能一步跳到远处）
    const t = R.traceRivers(slope, { sourceHeight: 95 });
    const maxLen = t.rivers.reduce((m, r) => Math.max(m, r.points.length), 0);
    assert(maxLen <= ROWS + 2, `河不该跨越整张图：最长 ${maxLen} 点（行数 ${ROWS}）`);
    assert(Math.abs(t.neighborFactor - R.TRACE_NEIGHBOR_FACTOR) < 1e-9, '半径口径应可回报');
    return `最长 ${maxLen} 点 / 半径系数 ${t.neighborFactor}`;
  });

  check('traceRivers：回执齐全（rivers / sources / dropped / elapsedMs / truncated）', () => {
    const keys = ['rivers', 'sources', 'reaching', 'dropped', 'cells', 'neighborFactor', 'elapsedMs', 'truncated'];
    const missing = keys.filter((k) => !(k in t1));
    assert(missing.length === 0, `回执缺字段：${missing.join(', ')}`);
    assert(t1.cells === COLS * ROWS, `cells 应为 ${COLS * ROWS}，实际 ${t1.cells}`);
    assert(typeof t1.elapsedMs === 'number' && t1.elapsedMs >= 0, 'elapsedMs 必须是数字（UI 要显示耗时）');
    return `${t1.rivers.length} 条 / ${t1.elapsedMs.toFixed(1)} ms`;
  });

  check('🔴 性能：2 万格量级的追踪必须是**秒级以内**（旧实现是分钟级）', () => {
    // 旧实现实测：26910 格 / 281 源头 → 单点全表 7.46ms × 281 × ~200 步 ≈ 7 分钟。
    // 这里造一张 200×100 = 20000 格的图，要求 < 3s（实测在几百毫秒量级）。
    const big = makeGrid(200, 100, 14.4, (c, r) => (r > 80 ? 0 : 40 + (80 - r) * 0.8 + (c % 7)));
    const t0 = Date.now();
    const t = R.traceRivers(big);
    const dt = Date.now() - t0;
    assert(dt < 3000, `2 万格耗时 ${dt}ms —— 超过 3s 说明又退化成全表扫描了`);
    return `${t.cells} 格 / ${t.rivers.length} 条 / ${dt} ms`;
  });

  // ══════════════════════════════════════════════════════════════════════
  // 五、与「地图自带河流」对齐（2026-10-16 第五修，用户实测三次的色差/粗细）
  //     真实底图实测：自带河 #5d97bb 单遍，屏幕线宽 p50 0.70px / max 2.55px；
  //     上一轮自动河 #3B82F6 @0.35 宽×2.4 + 亮芯 #93c5fd → p50 0.80px 实心 + 1.92px 光晕。
  // ══════════════════════════════════════════════════════════════════════
  check('🔴 自带河线宽公式：按本幅图 width 分布归一化（不再让 88% 的河卡在 0.7px 地板）', () => {
    const r = { width: 0.07, discharge: 96 };
    const px = RR.basemapRiverWidthPx(r, 0.26);
    const world = RR.basemapRiverWidthWorld(r, 0.5, 0.26);
    assert(Math.abs(world - px / 0.5) < 1e-9, `屏幕 ${px} / pxPerWorld 0.5 应等于世界 ${px / 0.5}，实际 ${world}`);
    // 🔴 2026-10-27（用户 C2「粗细几乎完全平均」）：指数再收紧到 ^0.85 ——
    //    p50 width 0.07 从 2.82px 落到 2.31px，主干仍是 4.6px，支流/干流的层次才看得出来。
    //    区间仍守 1.2~4.6（细河撑得住选中高亮，test_112/119 的水面保留率判据不变）。
    assert(Math.abs(px - 2.31) < 0.15, `width 0.07 / max 0.26 应 ≈2.31px，实际 ${px}`);
    assert(RR.basemapRiverWidthPx({ width: 0.26, discharge: 523 }, 0.26) === 4.6, '最粗的一条应到 4.6px 上界');
    assert(RR.basemapRiverWidthPx({ width: 0, discharge: 1 }, 0.26) === 1.2, '没有宽度的河夹到 1.2px 下界');
    const tiny = RR.basemapRiverWidthPx({ width: 0.001, discharge: 1 }, 0.26);
    assert(tiny > 1.2 && tiny < 1.6, `极细的河应仍在 1.2~1.6px，实际 ${tiny}`);
    assert(RR.basemapRiverWidthPx({ width: 9, discharge: 99999 }, 0.26) === 4.6, '极粗的河夹到 4.6px 上界');
    // 区分度：4.6 / 1.2 ≈ 3.8×（主干与支流一眼分得开）
    return `p50 ${px.toFixed(2)}px / 区间 1.2–4.6px`;
  });

  check('🔴 反向探针：线宽若漏掉 sqrt(discharge) → 上面的量级断言必须能抓到', () => {
    // 旧式（自动河上一轮前的世界单位口径）在同样数据上会得到完全不同的值
    const bad = (r) => 0.55 + Math.cbrt(r.discharge || 1) * 0.75;
    const good = RR.basemapRiverWidthPx({ width: 0.07, discharge: 96 }, 0.26);
    assert(Math.abs(bad({ discharge: 96 }) - good) > 1,
      '探针本身失效了 —— 两种口径给出同一个数，那这条断言就没有判别力');
    return `旧口径 ${bad({ discharge: 96 }).toFixed(2)} vs 自带河口径 ${good.toFixed(2)}`;
  });

  check('🔴 flow → discharge 当量：按本幅图流量上界归一化、单调、落在实测区间内', () => {
    const lo = RR.BASEMAP_RIVER_DISCHARGE_RANGE[0], hi = RR.BASEMAP_RIVER_DISCHARGE_RANGE[1];
    const a = RR.flowToDischargeEquivalent(1, 22);
    const b = RR.flowToDischargeEquivalent(22, 22);
    assert(a >= lo - 1e-6 && a <= hi + 1e-6, `flow=1 应落区间内，实际 ${a}`);
    assert(b >= lo - 1e-6 && b <= hi + 1e-6, `flow=max 应落区间内，实际 ${b}`);
    assert(b > a, `必须单调递增：${a} → ${b}`);
    // 🔴 2026-10-20：线宽不再吃 discharge，改吃 **width 字段的分布**（本幅图最宽那条归一化）。
    //    这条反向探针改成守"宽度字段越大 → 图上线越粗"，且最细/最粗不被夹成同一个值。
    const naive = RR.basemapRiverWidthPx({ width: 0.1, discharge: 22 }, 0.26);
    const mapped = RR.basemapRiverWidthPx({ width: 0.2, discharge: b }, 0.26);
    assert(mapped > naive + 0.3, `宽度字段翻倍应明显更粗：${naive} → ${mapped}`);
    return `flow 1→22 折合 discharge ${a.toFixed(0)}→${b.toFixed(0)}；线宽 ${naive.toFixed(2)} → ${mapped.toFixed(2)}px`;
  });

  check('🔴 strokeRiverNetwork：widthPx + solid 走**单遍实线**（自带河画法），且线宽就是给的屏幕像素', () => {
    const canvasMod = tryCanvas();
    const segs = [{ x0: 0, y0: 0, x1: 10, y1: 0, flow: 5 }, { x0: 10, y0: 0, x1: 20, y1: 5, flow: 20 }];
    if (canvasMod) {
      // 真 CanvasRenderingContext2D：所有调用都真的落到原生实现（比手搓 recorder 可信）
      const { createCanvas } = canvasMod;
      const cv = createCanvas(64, 64);
      const ctx = cv.getContext('2d');
      const res = RR.strokeRiverNetwork(ctx, segs, {
        widthPx: () => 1.5, strokeStyle: '#5d97bb', solid: true, singlePass: true,
      });
      assert(res.drawn === 2, `应描 2 段，实际 ${res.drawn}`);
      // 单遍 = 只有一种颜色落在画布上：自带河色 #5d97bb（非白、非亮芯 #93c5fd）
      const d = ctx.getImageData(0, 0, 64, 64).data;
      const set = new Set();
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) set.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
      assert(set.size > 0, '画布上必须有像素（否则等于什么都没画）');
      for (const c of set) {
        const [r, g, b] = c.split(',').map(Number);
        assert(Math.abs(r - 0x5d) < 60 && Math.abs(g - 0x97) < 60 && Math.abs(b - 0xbb) < 60,
          `落笔颜色必须接近自带河色 #5d97bb（抗锯齿可偏），实际 rgb(${c})`);
      }
      // 旧两遍口径：亮芯 #93c5fd 必须出现（证明 solid 这个开关真的有作用）
      const cv2 = createCanvas(64, 64);
      const ctx2 = cv2.getContext('2d');
      const res2 = RR.strokeRiverNetwork(ctx2, segs, { toPx: (w) => 30, maxFlow: 20, minPx: 6 });
      assert(res2.drawn === 2, `旧口径也应描 2 段，实际 ${res2.drawn}`);
      const d2 = ctx2.getImageData(0, 0, 64, 64).data;
      let coreSeen = false;
      for (let i = 0; i < d2.length; i += 4) {
        if (d2[i + 3] > 200 && Math.abs(d2[i] - 0x93) < 40 && Math.abs(d2[i + 1] - 0xc5) < 40 && Math.abs(d2[i + 2] - 0xfd) < 40) { coreSeen = true; break; }
      }
      assert(coreSeen, '不传 solid 时必须仍有亮芯 #93c5fd（否则 solid 开关是死的）');
      return `单遍仅自带河色 / 旧口径含亮芯（${set.size} 种色）`;
    }
    // 没有 canvas 实现时的降级：仍要判"单遍 vs 两遍"的调用次数（用记录式 stub）
    const makeStub = (sink) => ({
      save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
      set lineWidth(v) { sink.push({ k: 'w', v }); }, get lineWidth() { return 0; },
      set strokeStyle(v) { sink.push({ k: 'c', v }); }, get strokeStyle() { return ''; },
      set globalAlpha(v) { sink.push({ k: 'a', v }); }, get globalAlpha() { return 1; },
      set lineCap(v) {}, get lineCap() { return ''; },
      set lineJoin(v) {}, get lineJoin() { return ''; },
      stroke() {}, setLineDash() {},
    });
    const sink = [];
    const res = RR.strokeRiverNetwork(makeStub(sink), segs, {
      widthPx: () => 1.5, strokeStyle: '#5d97bb', solid: true, singlePass: true,
    });
    const ws = sink.filter((x) => x.k === 'w').map((x) => x.v);
    const cs = sink.filter((x) => x.k === 'c').map((x) => x.v);
    assert(res.drawn === 2 && ws.length === 2, `单遍应设 2 次线宽，实际 ${ws.length}`);
    assert(ws.every((w) => w === 1.5), `线宽必须等于 widthPx 给的屏幕像素，实际 ${ws.join(',')}`);
    assert(cs.length === 1 && cs[0] === '#5d97bb', `必须只有一种颜色，实际 ${cs.join(',')}`);
    return `降级：单遍 2 次线宽 = ${ws.join(',')}px`;
  });

  // ══════════════════════════════════════════════════════════════════════
  // 六、陆地判据：掩膜独占（2026-10-16 第五修的核心 —— 并集让河继续入海）
  //     真实 desite 实测（`_probe_phantom.mjs`，掩膜走**产品自己的** buildLandMask）：
  //     h≥20 判陆 3053 格、掩膜判陆 2960 格、两者都陆 2850；
  //     **幻影格（高度陆/掩膜海）203 格**（= 2.04% 的格），145/1710 段端点踩在上面。
  //     并集把这些幻影格也算陆 → 落在其上的段两端都判陆 → 裁剪被整段跳过。
  // ══════════════════════════════════════════════════════════════════════
  check('🔴 幻影格：并集会让"高度说陆、掩膜说海"的段跳过裁剪（这就是越界的机制）', () => {
    // 大陆一块 + 海上孤岛一块；孤岛代表"高度场有隆起但不在海岸线内"的幻影格
    const coast = { points: [[0, 0], [100, 0], [100, 100], [0, 100]], kind: 'land' };
    const phantom = { points: [[300, 300], [320, 300], [320, 320], [300, 320]], kind: 'land' };
    const m = C.buildLandMask([coast, phantom]);
    // ⚠️ 假"高度场"必须与**掩膜说得不一样**才有判别力：让 (300~320)² 只被高度判陆、
    //    被掩膜判海（现实里那种"格心采样说陆、海岸线说海"的格子）。
    const isLandInPhantom = (x, y) => x >= 300 && x <= 320 && y >= 300 && y <= 320;   // 高度场口径
    const maskOnly = (x, y) => (m.lookup(x, y) && !isLandInPhantom(x, y));            // ✅ 本轮（幻影格从掩膜里剔除）
    const union = (x, y) => (maskOnly(x, y) || isLandInPhantom(x, y));                // ❌ 上一轮的实现（并集）
    // 一条从大陆边缘射进"高度说陆、掩膜说海"区域的段：(305,310) 是幻影，-(100) 是海
    const seg = { x0: 50, y0: 50, x1: 305, y1: 310, flow: 3 };
    // 并集口径下段的两端都被判为陆 → clipSegmentToLand 原样返回、**一次裁剪都不做**
    const u = C.clipSegmentToLand(seg, union);
    assert(u && Math.abs(u.x1 - 305) < 1e-9, `并集口径下末点应原样保留 305（= 没裁），实际 ${u && u.x1}`);
    // 掩膜口径下末端是水 → 裁到大陆边界（x 最大 100 附近）
    const c = C.clipSegmentToLand(seg, maskOnly);
    assert(c, '掩膜口径下应返回裁过的段（不是 null）');
    assert(c.x1 <= 100 + 1e-6 && c.y1 <= 100 + 1e-6,
      `掩膜口径下末点必须落回大陆内 (<=100,100)，实际 (${c.x1},${c.y1})`);
    assert(c.endInSea === true, '裁过之后必须标 endInSea=true');
    assert(c.x1 < u.x1 - 100, `两种口径的末点差必须显著（>100），实际差 ${u.x1 - c.x1}`);
    return `并集末点 x=${u.x1}（未裁）vs 掩膜末点 x=${c.x1.toFixed(1)}（裁到岸线）`;
  });

  // ══════════════════════════════════════════════════════════════════════
  // 八、追踪前平滑（2026-10-16 用户实测「很丑的折线，有种恐怖感」）
  //     真实底图实测：r=2 p=1 → 最长河 140→270 世界单位、中位 69→92；
  //     代价：平滑压低山头 → 源头更难达标（r=3 p=3 实测 0 条河）。
  // ══════════════════════════════════════════════════════════════════════
  check('🔴 不传 smoothRadius 时行为与以前**一字不差**（默认关 = 零行为变更）', () => {
    const grid = makeGrid(40, 40, 14.4, (c, r) => (r > 30 ? 0 : 30 + (30 - r) * 3 + (c % 5)));
    const a = R.traceRivers(grid);
    const b = R.traceRivers(grid, { smoothRadius: 0 });
    assert(a.rivers.length === b.rivers.length, `条数应一致：${a.rivers.length} vs ${b.rivers.length}`);
    assert(a.segments.length === b.segments.length, `段数应一致：${a.segments.length} vs ${b.segments.length}`);
    assert(a.smoothed === 0 && b.smoothed === 0, 'smoothed 应为 0');
    return `${a.rivers.length} 条 / ${a.segments.length} 段 两路一致`;
  });

  check('🔴 平滑确实**拉长河道**（这是它唯一的用处，不成立就是白做）', () => {
    // 造一张"微洼地很多"的地形：在斜坡上撒噪声坑，水会一格就掉进坑里
    const grid = makeGrid(60, 60, 14.4, (c, r) => {
      const base = r > 45 ? 0 : 20 + (45 - r) * 3;
      const noise = ((c * 7919 + r * 104729) % 11) * 1.7;      // 确定性伪随机（不用 Math.random，保证可复现）
      return r > 45 ? 0 : base + noise;
    });
    const raw = R.traceRivers(grid);
    const sm = R.traceRivers(grid, { smoothRadius: 2, smoothPasses: 1 });
    const longest = (t) => {
      let m = 0;
      for (const rv of (t.rivers || [])) {
        let L = 0; const p = rv.points || [];
        for (let i = 0; i + 1 < p.length; i++) L += Math.hypot(p[i + 1].x - p[i].x, p[i + 1].y - p[i].y);
        if (L > m) m = L;
      }
      return m;
    };
    const L0 = longest(raw), L1 = longest(sm);
    assert(sm.smoothed > 0, `报告里应写明平滑生效，实际 smoothed=${sm.smoothed}`);
    assert(L1 > L0, `平滑后最长河应更长：${L0.toFixed(0)} → ${L1.toFixed(0)}`);
    return `最长河 ${L0.toFixed(0)} → ${L1.toFixed(0)} 世界单位（${(L1 / Math.max(1, L0)).toFixed(2)}×）`;
  });

  check('🔴 平滑会**改变源头数**（可观测的代价；方向取决于地形，不许假设它一定变少）', () => {
    // ⚠️ 我第一版这条断言写成"越重平滑源头一定更少" → **假红**（实测 r2p1=1375 / r8p4=1845）。
    //    原因是平滑既抹平微洼地（让更多格满足"有更低邻居"）、又压低山头（让更少格过 height 闸门），
    //    两个效应方向相反，谁赢取决于地形。
    //    真实 desite 底图上的实测是**压低山头赢**（r=3 p=3 → 0 条河），但那是那份地形的结果，
    //    **不是普遍律**。所以这里只断言"这个代价可被调用方观测到"——那才是调用方降闸门的依据。
    const grid = makeGrid(60, 60, 14.4, (c, r) => (r > 45 ? 0 : 20 + (45 - r) * 3 + ((c * 31 + r * 17) % 7)));
    const raw = R.traceRivers(grid);
    const mild = R.traceRivers(grid, { smoothRadius: 2, smoothPasses: 1 });
    const heavy = R.traceRivers(grid, { smoothRadius: 8, smoothPasses: 4 });
    const nums = [raw.sources, mild.sources, heavy.sources];
    assert(new Set(nums).size > 1, `源头数必须随平滑改变（否则"代价"无从观测）：${nums.join(' / ')}`);
    for (const t of [raw, mild, heavy]) assert(Number.isFinite(t.sources), 'sources 必须是有限数');
    return `源头数 raw/mild/heavy = ${nums.join(' / ')}（变了 = 调用方需要据此降闸门）`;
  });

  // ⚠️ 原本这里还想再钉一条"真实量级"的合成用例（想复现真实底图 140→270）。
  //    实测**复现不出来**：我手搓的斜坡+微坑地形上平滑给出 777→768（因为那个斜坡本身就够长，
  //    微坑不是瓶颈）——**合成地形复现不出真实瓶颈**。
  //    所以这条不写进单测（写了就是一条**看着很硬、其实无关**的断言）。
  //    "平滑能让真实底图的河变长"这条结论的证据是 `_proto_smooth_trace.mjs` 在**真实数据**上的读数
  //    + `docs/assets/river-compare/4-未平滑.png` vs `5-先平滑再追踪.png` 的肉眼对照。

  // ══════════════════════════════════════════════════════════════════════
  // 四、反向探针（守卫本身必须能被证明抓得住问题）
  // ══════════════════════════════════════════════════════════════════════
  check('反向探针：把"严格更低"放宽成"不高于" → 上坡断言必须能抓到', () => {
    // 手工造一条路径：100 → 100（持平）→ 90，第 0 步就不是"严格更低"
    const H = [100, 100, 90];
    let caught = false;
    for (let i = 0; i + 1 < 3; i++) if (!(H[i + 1] < H[i])) caught = true;
    assert(caught, '探针本身失效了 —— 那样上面的"不许走上坡"断言就是假绿');
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
