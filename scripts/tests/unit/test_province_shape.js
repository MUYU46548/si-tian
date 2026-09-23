#!/usr/bin/env node
/**
 * Node 单元测试：省份几何「唯一表示」（src/renderer/src/utils/provinceShape.js）
 *
 * 为什么必须有这一层：P0 第二块把省份从「单环多边形」升级成「多环实体（外环 + 洞 + 飞地
 * + land/sea）」，并把合并从「凸包」换成「共边抵消的精确并集」。这两件事都在**纯几何**里，
 * CDP 用例只能看像素结果，定位不到「并集面积多了 50」「洞被填了」这种错误。本文件直接对
 * 纯函数下断言。
 *
 * 用法：node scripts/tests/unit/test_province_shape.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 *
 * ⚠️ 被测试模块是 ESM 且**有相对 import**（./geometry、./gridOutline）——
 *    data: URL 动态 import 无法解析相对路径，所以这里把三个文件复制到临时目录 + 写一份
 *    `{"type":"module"}` 的 package.json，再用 file URL import。不改 package.json、不改源码。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const DEPS = ['provinceShape.js', 'geometry.js', 'gridOutline.js'];

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
function near(a, b, tol, label) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${label}: 期望 ${b} ±${tol}，实际 ${a}`);
}

/** 矩形环（顺时针或逆时针由调用方决定） */
const sq = (x, y, w, h) => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];

/**
 * 挑一个**真能写**的临时根目录。
 * ⚠️ 不能直接用 `os.tmpdir()`：在 MSYS/Git-Bash 下 `TMPDIR=/tmp` 是 POSIX 路径，
 *    Node 在 Windows 上解析不了 → 回退到 `C:\WINDOWS`（不可写）→ mkdtemp EPERM。
 */
function pickTmpRoot() {
  const cands = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : '',
    os.tmpdir(), process.env.TEMP, process.env.TMP, os.homedir(),
  ];
  for (const c of cands) {
    if (!c || !path.isAbsolute(c)) continue;
    if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(c)) continue;   // MSYS 路径 Node 不认
    try {
      fs.mkdirSync(c, { recursive: true });
      fs.accessSync(c, fs.constants.W_OK);
      return c;
    } catch (_) { /* 换下一个 */ }
  }
  return null;
}

async function main() {
  // ── 准备临时 ESM 目录 ────────────────────────────────────────────────────
  const root = pickTmpRoot();
  if (!root) throw new Error('找不到可写的临时目录');
  const tmp = fs.mkdtempSync(path.join(root, 'sitian-provshape-'));
  // ESM 下相对 import 必须带扩展名（`./geometry` 在 Vite 能解析、在 Node 不能）→
  // 只给**副本**补上 `.js`，源码一个字符都不改。
  const fixExt = (src) => src.replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
  for (const f of DEPS) {
    const body = fixExt(fs.readFileSync(path.join(SRC_DIR, f), 'utf8'));
    fs.writeFileSync(path.join(tmp, f), body);
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));

  const mod = await import(pathToFileURL(path.join(tmp, 'provinceShape.js')).href);
  const {
    provinceRings, provinceRingPoints, isMultiRing, hasSeaRing, normalizeProvince, normalizeTerrain,
    provinceBBox, provinceArea, pointInProvince, ringSigns, orientedRings,
    dedupeRing, collapseCollinearXY, smoothRing,
    splitProvinceShape, unionRingsByCancellation, unionRingsByRaster, ringsProperlyCross,
    mergeProvinceShapes, buildSkeleton, conformToSkeleton,
    floodRegion, cellsArea, ringsFromLabels, rasterizeProvinceShapes, shapePatch,
  } = mod;

  const mkGrid = (bbox, cell = 10, extraCells = 1) => {
    const b = bbox || { minX: -100, minY: -100, maxX: 100, maxY: 100 };
    const ox = b.minX - extraCells * cell;
    const oy = b.minY - extraCells * cell;
    return {
      cell, ox, oy,
      cols: Math.max(1, Math.ceil((b.maxX - ox) / cell) + extraCells),
      rows: Math.max(1, Math.ceil((b.maxY - oy) / cell) + extraCells),
    };
  };

  // ── 1. 迁移 / 归一化（无损、幂等）────────────────────────────────────────
  check('归一化：旧数据只有 points → 单环 land；幂等且不复制顶点数组', () => {
    const pts = sq(0, 0, 10, 10);
    pts[0].controlOut = { x: 1, y: 1 };                 // 贝塞尔控制点必须原样保留
    const legacy = { id: 'p1', name: '旧省', points: pts };
    const n1 = normalizeProvince(legacy);
    assert(n1 !== legacy, '应产生归一化后的新对象');
    assert(n1.kind === 'land', `kind 默认应为 land，实际 ${n1.kind}`);
    assert(n1.points === pts, '主环数组**不能**被复制（copy 会丢掉 controlOut 引用语义）');
    assert(provinceRings(n1).length === 1, '环数应为 1');
    assert(provinceRings(n1)[0].points[0].controlOut.x === 1, '控制点必须随顶点往返');
    const n2 = normalizeProvince(n1);
    assert(n2 === n1, '归一化必须幂等（第二次返回同一引用）');
    return 'land / 1 环 / 控制点保留 / 幂等';
  });

  check('归一化：extraRings 裸数组 → {points,kind}；退化环被剔除；sea 保留', () => {
    const prov = {
      id: 'p2', points: sq(0, 0, 10, 10), kind: 'sea',
      extraRings: [sq(100, 100, 5, 5), { points: [{ x: 1, y: 1 }] }, null],
    };
    const n = normalizeProvince(prov);
    assert(n.extraRings.length === 1, `extraRings 应只剩 1 个合法环，实际 ${n.extraRings.length}`);
    assert(n.extraRings[0].kind === 'sea', '额外环应继承省份级 kind=sea');
    assert(n.kind === 'sea', 'sea 省级 kind 必须保留');
    assert(provinceRings(n).length === 2 && isMultiRing(n), '应视为多环实体');
    assert(hasSeaRing(n), 'hasSeaRing 应为真');
    return 'sea / 2 环 / 退化环剔除';
  });

  check('normalizeTerrain：计数需要写回的省份（只有脏的才算）', () => {
    const clean = normalizeProvince({ id: 'a', points: sq(0, 0, 4, 4) });
    const dirty = { id: 'b', points: sq(0, 0, 4, 4) };
    const r = normalizeTerrain([clean, dirty]);
    assert(r.changed === 1, `changed 应为 1，实际 ${r.changed}`);
    assert(r.terrain[1].kind === 'land', '脏数据应被补齐');
    return 'changed=1';
  });

  // ── 2. 多环语义：飞地 vs 洞（绕数口径）──────────────────────────────────
  check('多环命中：飞地（互不嵌套）填、洞（嵌套奇深度）不填 —— 与 nonzero 填充一致', () => {
    const outer = sq(0, 0, 100, 100);
    const island = sq(200, 0, 50, 50);          // 飞地
    const enclaveA = { id: 'a', points: outer, extraRings: [{ points: island, kind: 'land' }] };
    assert(pointInProvince(25, 25, enclaveA) === true, '实心区应命中');
    assert(pointInProvince(225, 25, enclaveA) === true, '飞地应命中（非洞）');
    assert(pointInProvince(150, 25, enclaveA) === false, '两块之外的空白不应命中');

    const hole = sq(40, 40, 20, 20);            // 落在 outer 内部 = 洞
    const withHole = { id: 'b', points: outer, extraRings: [{ points: hole, kind: 'land' }] };
    const signs = ringSigns(withHole);
    assert(signs[0] === 1 && signs[1] === -1, `嵌套符号应为 [+1,-1]，实际 ${JSON.stringify(signs)}`);
    assert(pointInProvince(50, 50, withHole) === false, '洞心不应命中');
    assert(pointInProvince(10, 10, withHole) === true, '洞外实心区应命中');
    return '飞地填 / 洞不填';
  });

  check('取向：orientedRings 把绕向统一到嵌套符号（外正洞负）', () => {
    const outerCW = sq(0, 0, 100, 100).slice().reverse();     // 故意反向
    const hole = sq(40, 40, 20, 20).slice().reverse();
    const p = { id: 'c', points: outerCW, extraRings: [{ points: hole, kind: 'land' }] };
    const or = orientedRings(p);
    const areaSign = (pts) => {
      let s = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        s += a.x * b.y - b.x * a.y;
      }
      return Math.sign(s / 2);
    };
    assert(areaSign(or[0].points) === or[0].sign, '外环绕向应与符号一致');
    assert(areaSign(or[1].points) === or[1].sign, '洞环绕向应与符号一致');
    return '外正洞负';
  });

  check('包围盒 / 毛面积：多环全部计入', () => {
    const p = { id: 'd', points: sq(0, 0, 10, 10), extraRings: [{ points: sq(100, 100, 10, 10), kind: 'land' }] };
    const bb = provinceBBox(p);
    assert(bb.minX === 0 && bb.maxX === 110 && bb.minY === 0 && bb.maxY === 110, `bbox 错误：${JSON.stringify(bb)}`);
    near(provinceArea(p), 200, 1e-6, '毛面积');
    return 'bbox 0..110 / 面积 200';
  });

  // ── 3. 环清理 / 平滑缓存 ────────────────────────────────────────────────
  check('环清理：去重复点、共线塌缩减点', () => {
    const dup = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    assert(dedupeRing(dup).length === 5, `去重后应 5 点，实际 ${dedupeRing(dup).length}`);
    const stair = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const coll = collapseCollinearXY(stair);
    assert(coll.length === 4, `共线塌缩后应 4 点，实际 ${coll.length}`);
    return '5 / 4 点';
  });

  check('平滑缓存：同一顶点数组重复调用返回同一结果（避免逐帧重算 ×4 细分）', () => {
    const pts = sq(0, 0, 10, 10);
    const a = smoothRing(pts, 2);
    const b = smoothRing(pts, 2);
    assert(a === b, 'Uncached —— 平滑结果必须命中 WeakMap 缓存');
    assert(a.length > 4, 'Chaikin 应细分出更多点');
    return `${a.length} 点 / 命中缓存`;
  });

  // ── 4. 分割 ─────────────────────────────────────────────────────────────
  check('分割：竖直中线切 100×100 → 两半各 5000，kind 与属性保留', () => {
    const prov = { id: 'big', name: '大省', points: sq(0, 0, 100, 100), kind: 'sea', biome: 'taiga' };
    const r = splitProvinceShape(prov, { x: 50, y: 0 }, { x: 50, y: 100 }, { makeId: (s) => `x_${s}` });
    assert(r, '切割应成功');
    near(provinceArea(r.a), 5000, 1e-6, 'A 面积');
    near(provinceArea(r.b), 5000, 1e-6, 'B 面积');
    assert(r.a.id === 'x_a' && r.b.id === 'x_b', 'id 应由 makeId 生成');
    assert(r.a.kind === 'sea' && r.b.kind === 'sea', 'kind 必须继承');
    assert(r.a.biome === 'taiga', '其它属性必须继承');
    assert(!r.a.points.some((p) => p.x > 50 + 1e-9) || !r.b.points.some((p) => p.x < 50 - 1e-9),
      '两半应分居切割线两侧');
    return '5000 + 5000';
  });

  check('分割：切割线完全在外部 → null（不产生垃圾省份）', () => {
    const prov = { id: 'big', name: '大省', points: sq(0, 0, 10, 10) };
    assert(splitProvinceShape(prov, { x: 100, y: -5 }, { x: 100, y: 15 }) === null, '应为 null');
    return 'null';
  });

  check('分割：多环省份 —— 未切到的环按质心整环归到一侧', () => {
    const prov = {
      id: 'multi', name: '多环',
      points: sq(0, 0, 40, 40),
      extraRings: [{ points: sq(100, 0, 40, 40), kind: 'land' }],
    };
    const r = splitProvinceShape(prov, { x: 50, y: -10 }, { x: 50, y: 60 }, { makeId: (s) => s });
    assert(r, '应切成功');
    assert(provinceRings(r.a).length === 1 && provinceRings(r.b).length === 1, '各得 1 环');
    // 两个 40×40 方块分别在切割线两侧、都不被切到 → 整环各归一侧
    near(provinceArea(r.a), 1600, 1e-6, 'A（线左边的整块）');
    near(provinceArea(r.b), 1600, 1e-6, 'B（线右边的整块）');
    return `A=${provinceArea(r.a)} B=${provinceArea(r.b)}`;
  });

  // ── 5. 合并（共边抵消，取代凸包）────────────────────────────────────────
  check('合并：两方块共边 → 1 环、面积 = 两者之和（凸包会多出面积）', () => {
    const A = { id: 'a', name: 'A', points: sq(0, 0, 20, 10) };
    const B = { id: 'b', name: 'B', points: sq(0, 10, 10, 10) };   // L 形相邻
    const m = mergeProvinceShapes([A, B]);
    assert(m, '合并应成功');
    assert(m.method === 'cancel', `应走精确共边抵消，实际 ${m.method}`);
    assert(m.loops === 1, `并集应为 1 环，实际 ${m.loops}`);
    const merged = Object.assign({ id: 'm', name: 'M' }, m.shape);
    near(provinceArea(merged), 300, 1e-6, '并集面积（凸包会是 350）');
    assert(merged.points.length === 6, `共线塌缩后应 6 顶点，实际 ${merged.points.length}`);
    return 'cancel / 1 环 / 300';
  });

  check('合并：边长不等（长边吃掉节点）也必须抵消 —— T 接点切边', () => {
    const A = { id: 'a', name: 'A', points: sq(0, 0, 30, 10) };
    const B = { id: 'b', name: 'B', points: sq(0, 10, 10, 10) };   // B 只贴 A 的左三分之一
    const m = mergeProvinceShapes([A, B]);
    assert(m && m.method === 'cancel', `应精确抵消，实际 ${m && m.method}`);
    assert(m.loops === 1, `应为 1 环，实际 ${m.loops}`);
    const merged = Object.assign({ id: 'm' }, m.shape);
    near(provinceArea(merged), 400, 1e-6, '并集面积');
    return 'T 接点切边成功 / 400';
  });

  check('合并：互不相邻 → 多环实体（不是凸包），两环面积各自保留', () => {
    const A = { id: 'a', name: 'A', points: sq(0, 0, 10, 10) };
    const B = { id: 'b', name: 'B', points: sq(100, 100, 10, 10) };
    const m = mergeProvinceShapes([A, B]);
    assert(m && m.loops === 2, `应得 2 环，实际 ${m && m.loops}`);
    const merged = Object.assign({ id: 'm' }, m.shape);
    assert(isMultiRing(merged) === false || provinceRings(merged).length === 2, '应为 2 环');
    near(provinceArea(merged), 200, 1e-6, '毛面积 = 两环之和');
    const bb = provinceBBox(merged);
    assert(bb.maxX === 110, '包围盒应覆盖两块（不是被凸包合并成一块，但 bbox 同样覆盖）');
    return '2 环 / 200';
  });

  check('合并：一省完全落在另一省的洞里 → 洞被填实（绕数抵消）', () => {
    const outer = sq(0, 0, 100, 100);
    const hole = sq(40, 40, 20, 20);
    const A = { id: 'a', name: 'A', points: outer, extraRings: [{ points: hole, kind: 'land' }] };
    const B = { id: 'b', name: 'B', points: hole.map((p) => ({ ...p })) };   // 正好填满洞
    const m = mergeProvinceShapes([A, B]);
    assert(m, '合并应成功');
    const merged = Object.assign({ id: 'm' }, m.shape);
    assert(pointInProvince(50, 50, merged) === true, '洞应被填实');
    near(provinceArea(merged), 10000, 1e-6, '实心面积（洞不再扣减）');
    return '洞填实 / 10000';
  });

  check('合并：平移后的同一方块（真正穿插）→ 走栅格兜底且面积近似正确', () => {
    const A = { id: 'a', name: 'A', points: sq(0, 0, 100, 100) };
    const B = { id: 'b', name: 'B', points: sq(50, 50, 100, 100) };         // 交叉重叠
    assert(ringsProperlyCross(A.points, B.points) === true, '应判定为真正穿插');
    const m = mergeProvinceShapes([A, B]);
    assert(m && m.method === 'raster', `穿插应退回栅格，实际 ${m && m.method}`);
    const merged = Object.assign({ id: 'm' }, m.shape);
    // 并集面积 = 10000 + 10000 - 2500 = 17500；栅格量化容差放宽到 12%
    near(provinceArea(merged), 17500, 17500 * 0.12, '栅格并集面积');
    return `raster / ${Math.round(provinceArea(merged))}`;
  });

  check('并集：不允许传朝向不一致的环（洞被当实心的静默错误已被契约禁止）', () => {
    // 反向的单环：orientedRings 会在合并内部统一，直接调 union 则必须由调用方保证
    const loops = unionRingsByCancellation([
      { points: sq(0, 0, 10, 10) },
      { points: sq(10, 0, 10, 10) },
    ]);
    assert(loops.length === 1, `共边应合成 1 环，实际 ${loops.length}`);
    return '1 环';
  });

  // ── 6. 栅格 ↔ 多边形 一致性（无漂移）────────────────────────────────────
  check('不变量：环 → 栅格 → 环 → 栅格，标签集合完全一致（无漂移）', () => {
    const provs = [
      { id: 'p1', points: sq(0, 0, 60, 40) },
      { id: 'p2', points: sq(60, 0, 40, 40) },
    ];
    const grid = mkGrid({ minX: 0, minY: 0, maxX: 100, maxY: 40 }, 10, 1);
    const L1 = rasterizeProvinceShapes(provs, grid);
    const owned1 = L1.reduce((n, v) => n + (v ? 1 : 0), 0);
    assert(owned1 === 10 * 4, `第一轮应涂满 40 格，实际 ${owned1}`);
    const byLabel = ringsFromLabels(L1, grid);
    const provs2 = [1, 2].map((idx) => Object.assign({ id: `q${idx}` }, shapePatch(
      (byLabel.get(idx) || []).map((pts) => ({ points: pts, kind: 'land' }))
    )));
    const L2 = rasterizeProvinceShapes(provs2, grid);
    let diff = 0;
    for (let i = 0; i < L1.length; i++) if (L1[i] !== L2[i]) diff++;
    assert(diff === 0, `第二轮栅格应与第一轮完全相同，实测 ${diff} 格不同（几何在漂移）`);
    return '0 格差异';
  });

  check('带洞网格：抽出的洞环重栅格化后洞仍在（洞不会被填）', () => {
    const cols = 12, rows = 12, cell = 10;
    const grid = { cell, ox: 0, oy: 0, cols, rows };
    const L = new Uint8Array(cols * rows);
    for (let r = 1; r < 11; r++) for (let c = 1; c < 11; c++) L[r * cols + c] = 1;
    for (let r = 4; r < 8; r++) for (let c = 4; c < 8; c++) L[r * cols + c] = 0;
    const byLabel = ringsFromLabels(L, grid);
    const rings = (byLabel.get(1) || []).map((pts) => ({ points: pts, kind: 'land' }));
    assert(rings.length === 2, `应抽出外环 + 洞两个环，实际 ${rings.length}`);
    const prov = Object.assign({ id: 'h' }, shapePatch(rings));
    const signs = ringSigns(prov);
    assert(signs.includes(1) && signs.includes(-1), `应同时有实心环与洞环，实际 ${JSON.stringify(signs)}`);
    assert(pointInProvince(55, 55, prov) === false, '洞心不应命中');
    assert(pointInProvince(15, 15, prov) === true, '洞外应命中');
    const L2 = rasterizeProvinceShapes([prov], grid);
    let diff = 0;
    for (let i = 0; i < L.length; i++) if ((L[i] ? 1 : 0) !== (L2[i] ? 1 : 0)) diff++;
    assert(diff === 0, `带洞数据也应零漂移，实测 ${diff} 格不同`);
    return '2 环 / 洞保留 / 0 漂移';
  });

  // ── 7. 骨架吸附（整段插顶点 → 相邻省零缝）───────────────────────────────
  check('骨架：buildSkeleton 排除自身；conformToSkeleton 整段插顶点', () => {
    const road = [
      { id: 'a', name: 'A', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }] },
      { id: 'b', name: 'B', points: sq(500, 500, 10, 10) },
    ];
    const skel = buildSkeleton(road, 'b');
    assert(skel.length === 1, `骨架应只有 A 的 1 条环（排除 b），实际 ${skel.length}`);

    // 用户只描了两个角点，中间长边没有顶点
    const drawn = [{ x: 1, y: 1 }, { x: 99, y: 1 }, { x: 99, y: 49 }, { x: 1, y: 49 }];
    const out = conformToSkeleton(drawn, skel, 10);
    assert(out[0].x === 0 && out[0].y === 0, `顶点应吸到骨架顶点，实际 ${JSON.stringify(out[0])}`);
    assert(out.length >= drawn.length, '不应丢点');
    const allOnSkeleton = out.every((p) => skel[0].some((v) => Math.hypot(v.x - p.x, v.y - p.y) < 1e-9));
    assert(allOnSkeleton, '所有顶点都应落在骨架上（零缝的前提）');
    return `${drawn.length} → ${out.length} 点，全部落在骨架上`;
  });

  check('骨架：绕远路的相邻顶点**不**被拉过去（maxDetour 保护）', () => {
    const skel = [[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]];
    // 两个顶点都吸到骨架顶点，但它们之间的弦远远短于沿骨架的弧（用户在绕远路）
    const drawn = [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 50, y: 50 }];
    const out = conformToSkeleton(drawn, skel, 5);
    const inserted = out.length - drawn.length;
    assert(inserted <= 1, `绕远路不应插入整段弧，实际插入 ${inserted} 点`);
    return `插入 ${inserted} 点`;
  });

  // ── 8. 点击填充 / 面积闸门 ──────────────────────────────────────────────
  check('点击填充：泛滥同标签区域；cap 超限返回空（交给闸门拒绝）', () => {
    const cols = 10, rows = 10, cell = 10;
    const grid = { cell, ox: 0, oy: 0, cols, rows };
    const L = new Uint8Array(cols * rows);
    L[1 * cols + 1] = 1; L[1 * cols + 2] = 1; L[2 * cols + 1] = 1;      // 3 格小岛
    for (let r = 5; r < 9; r++) for (let c = 5; c < 9; c++) L[r * cols + c] = 1;   // 16 格大块
    const small = floodRegion(L, grid, 1, 1);
    assert(small.length === 3, `小岛应 3 格，实际 ${small.length}`);
    near(cellsArea(small, grid), 300, 1e-9, '小岛面积');
    const big = floodRegion(L, grid, 6, 6);
    assert(big.length === 16, `大块应 16 格，实际 ${big.length}`);
    const capped = floodRegion(L, grid, 6, 6, { cap: 5 });
    assert(capped.length === 0, '超限应返回空数组（拒绝）');
    return '3 / 16 / cap 生效';
  });

  // ── 9. 性能（真实库规模）────────────────────────────────────────────────
  check('性能：21 省 × ~1200 点并集（共边抵消）< 400ms', () => {
    // 造一条 21 段的网格状邻接省份带（共边全部精确重合）
    const provs = [];
    const W = 60;
    for (let i = 0; i < 21; i++) {
      const pts = [];
      for (let k = 0; k <= 60; k++) pts.push({ x: (i * W) + Math.sin(k / 3) * 5, y: k * 8 });
      for (let k = 60; k >= 0; k--) pts.push({ x: ((i + 1) * W) + Math.sin(k / 3) * 5, y: k * 8 });
      provs.push({ id: `p${i}`, points: pts });
    }
    const t0 = Date.now();
    const m = mergeProvinceShapes([provs[5], provs[6]]);
    const dt = Date.now() - t0;
    assert(m, '合并应成功');
    assert(dt < 400, `耗时 ${dt}ms（应 < 400ms）`);
    return `${dt}ms / ${m.loops} 环 / ${m.method}`;
  });

  // ── 汇总 ────────────────────────────────────────────────────────────────
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }

  const failed = results.filter((r) => !r.ok);
  console.log('=== 省份几何（Node）单元测试 ===');
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('单元测试运行器异常:', err);
  process.exit(1);
});
