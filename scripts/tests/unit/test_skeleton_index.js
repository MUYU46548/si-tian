#!/usr/bin/env node
/**
 * Node 单元测试：骨架顶点的**空间索引**（`src/renderer/src/utils/provinceShape.js`）
 *
 * 为什么必须有这一层：`conformToSkeleton` 的第一步是「笔迹上每个点找最近的骨架顶点」，
 * 朴素写法 O(笔迹点数 × 骨架顶点数)。真实 desite 底图 **24018 个骨架顶点**，一笔 46 点的
 * 预览 = 110 万次 `Math.hypot`，而预览每 60ms 就重算一次 —— CPU 采样实测这一项占拖笔总耗时的
 * **17%**。改成格子索引（格子边长 = threshold、查 3×3 邻域）之后必须保证：
 *
 *  ① **结果逐位一致**：候选集必须完备（半径 ≤ threshold 的圆盘最多与中心格 ±1 的格子相交），
 *     并列（同距离）时的取舍也要与原实现相同 —— 原实现按「行序 → 顶点序」扫描、只在
 *     `d < bd` 时替换 ⇒ 同距离取**先出现**的那个。这里用**朴素实现的完整复刻**做对照：
 *     同一批随机笔迹，两条路的输出必须 `JSON.stringify` 逐字符相同（`hit` 标记也一致）。
 *  ② **真的更快**：8k 顶点 × 20 条笔迹，索引路径至少要比朴素路径快一个量级
 *     （阈值取得很松，只用来抓"索引写了但没接上/每次重建"这类退化成朴素的情况）。
 *
 * 用法：node scripts/tests/unit/test_skeleton_index.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const DEPS = ['provinceShape.js', 'polylineSmooth.js', 'geometry.js', 'gridOutline.js'];

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

function pickTmpRoot() {
  const cands = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : '',
    os.tmpdir(), process.env.TEMP, process.env.TMP, os.homedir(),
  ];
  for (const c of cands) {
    if (!c || !path.isAbsolute(c)) continue;
    if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(c)) continue;
    try {
      fs.mkdirSync(c, { recursive: true });
      fs.accessSync(c, fs.constants.W_OK);
      return c;
    } catch (_) { /* 换下一个 */ }
  }
  return null;
}

// ── 朴素实现（**原算法的完整复刻**，只用于对照；产品侧已删掉这条路径）─────────────
const QKEY = (x, y, q) => `${Math.round(x / q)}:${Math.round(y / q)}`;
const indexOfLineNaive = (line, cache, q = 1e-6) => {
  const hit = cache.get(line);
  if (hit) return hit;
  const m = new Map();
  for (let i = 0; i < line.length; i++) {
    const k = QKEY(line[i].x, line[i].y, q);
    if (!m.has(k)) m.set(k, i);
  }
  cache.set(line, m);
  return m;
};
const arcBetweenNaive = (line, ka, kb, cache) => {
  const idx = indexOfLineNaive(line, cache);
  const ia = idx.get(ka), ib = idx.get(kb);
  if (ia === undefined || ib === undefined || ia === ib) return null;
  const N = line.length;
  const fwd = [], bwd = [];
  for (let k = (ia + 1) % N; k !== ib; k = (k + 1) % N) fwd.push(line[k]);
  for (let k = (ib + 1) % N; k !== ia; k = (k + 1) % N) bwd.push(line[k]);
  const len = (arc) => {
    let L = 0, prev = line[ia];
    for (const p of arc) { L += Math.hypot(p.x - prev.x, p.y - prev.y); prev = p; }
    L += Math.hypot(line[ib].x - prev.x, line[ib].y - prev.y);
    return L;
  };
  return len(fwd) <= len(bwd) ? fwd : bwd;
};
/** 原 `conformToSkeleton`（逐顶点扫全部骨架顶点）—— 只在本测试里存在 */
function conformNaive(points, skeleton, threshold, dedupeRing, { maxDetour = 1.6, cache } = {}) {
  const src = dedupeRing(points);
  if (src.length < 3 || !skeleton || !skeleton.length) return src;
  const snapped = src.map((p) => {
    let best = null, bd = threshold;
    for (const line of skeleton) {
      for (const v of line) {
        const d = Math.hypot(v.x - p.x, v.y - p.y);
        if (d < bd) { bd = d; best = v; }
      }
    }
    return best ? { x: best.x, y: best.y, hit: true } : { x: p.x, y: p.y, hit: false };
  });
  const out = [];
  for (let i = 0; i < snapped.length; i++) {
    const a = snapped[i], b = snapped[(i + 1) % snapped.length];
    out.push({ x: a.x, y: a.y });
    if (!a.hit || !b.hit) continue;
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    if (chord <= threshold) continue;
    const ka = QKEY(a.x, a.y, 1e-6), kb = QKEY(b.x, b.y, 1e-6);
    let bestArc = null, bestLen = Infinity;
    for (const line of skeleton) {
      const arc = arcBetweenNaive(line, ka, kb, cache);
      if (!arc || !arc.length) continue;
      let L = 0, prev = { x: a.x, y: a.y };
      for (const p of arc) { L += Math.hypot(p.x - prev.x, p.y - prev.y); prev = p; }
      L += Math.hypot(b.x - prev.x, b.y - prev.y);
      if (L < bestLen) { bestLen = L; bestArc = arc; }
    }
    if (bestArc && bestLen <= chord * maxDetour) out.push(...bestArc.map((p) => ({ x: p.x, y: p.y })));
  }
  return out;
}

/** 确定性伪随机（不用 Math.random：失败要可复现） */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

async function main() {
  const root = pickTmpRoot();
  if (!root) throw new Error('找不到可写的临时目录');
  const tmp = fs.mkdtempSync(path.join(root, 'sitian-skidx-'));
  const fixExt = (src) => src.replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
  for (const f of DEPS) {
    fs.writeFileSync(path.join(tmp, f), fixExt(fs.readFileSync(path.join(SRC_DIR, f), 'utf8')));
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const mod = await import(pathToFileURL(path.join(tmp, 'provinceShape.js')).href);
  const { conformToSkeleton, nearestSkeletonVertex, dedupeRing, buildSkeleton } = mod;

  // ── 合成骨架：40 个环 × 200 顶点 = 8000 个顶点（含**整数格点**，制造大量并列距离）──
  const skeleton = [];
  const rand = rng(20261018);
  for (let r = 0; r < 40; r++) {
    const line = [];
    const cx = (r % 8) * 400 - 1400, cy = Math.floor(r / 8) * 400 - 800;
    for (let i = 0; i < 200; i++) {
      const a = (i / 200) * Math.PI * 2;
      // 刻意取**整数**坐标：并列距离会真的出现（这正是并列取舍判据要覆盖的情形）
      line.push({ x: Math.round(cx + Math.cos(a) * 180), y: Math.round(cy + Math.sin(a) * 180) });
    }
    skeleton.push(line);
  }
  const vertexCount = skeleton.reduce((a, l) => a + l.length, 0);

  // 造 20 条随机笔迹（有的贴着骨架、有的在空地）
  const traces = [];
  for (let t = 0; t < 20; t++) {
    const pts = [];
    const bx = (t % 8) * 400 - 1400, by = Math.floor(t / 8) * 400 - 800;
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2;
      const rr = 170 + rand() * 40;
      pts.push({ x: bx + Math.cos(a) * rr + (rand() - 0.5) * 6, y: by + Math.sin(a) * rr + (rand() - 0.5) * 6 });
    }
    traces.push(pts);
  }

  check('空间索引与朴素实现**逐位一致**（20 条笔迹 / 8000 顶点，含并列距离）', () => {
    const cache = new Map();
    let hitVertices = 0;
    for (let i = 0; i < traces.length; i++) {
      const fast = conformToSkeleton(traces[i], skeleton, 10);
      const slow = conformNaive(traces[i], skeleton, 10, dedupeRing, { cache });
      const a = JSON.stringify(fast), b = JSON.stringify(slow);
      if (a !== b) {
        throw new Error(`第 ${i} 条笔迹两条路不一致：索引 ${fast.length} 点 / 朴素 ${slow.length} 点`
          + `（前 80 字符：${a.slice(0, 80)} vs ${b.slice(0, 80)}）`);
      }
      for (const p of fast) if (p && Number.isFinite(p.x)) hitVertices++;
    }
    assert(hitVertices > 0, '对照样本一条都没命中骨架 —— 判据是空转的（换一组笔迹）');
    return `20 条笔迹 × ${vertexCount} 顶点，输出逐字符相同`;
  });

  check('并列取舍：同距离取「行序 → 顶点序」最先出现的那个', () => {
    // 两条环上各有一个**与查询点等距**的顶点（(0,0) 与 (10,0) 对 (5,0) 等距）
    const sk = [
      [{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 50, y: 50 }],
      [{ x: 10, y: 0 }, { x: 10, y: 50 }, { x: 60, y: 50 }],
    ];
    const got = nearestSkeletonVertex(5, 0, sk, 10);
    assert(got && got.x === 0 && got.y === 0, `并列应取先出现的 (0,0)，实际 ${JSON.stringify(got)}`);
    // 反例：把先出现的那个换成更远 → 必须落到第二个
    const sk2 = [
      [{ x: 4, y: 20 }, { x: 0, y: 50 }, { x: 50, y: 50 }],
      [{ x: 10, y: 0 }, { x: 10, y: 50 }, { x: 60, y: 50 }],
    ];
    const got2 = nearestSkeletonVertex(5, 0, sk2, 10);
    assert(got2 && got2.x === 10 && got2.y === 0, `应取更近的 (10,0)，实际 ${JSON.stringify(got2)}`);
    return '(5,0) 等距时取 (0,0)；(0,0) 不可用时取 (10,0)';
  });

  check('阈值语义：严格小于才命中（等于阈值 = 不命中）', () => {
    const sk = [[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 100 }]];
    assert(nearestSkeletonVertex(9.999, 0, sk, 10) !== null, '9.999 < 10 应命中');
    assert(nearestSkeletonVertex(10, 0, sk, 10) === null, '10 == 10 不应命中（原实现是 d < bd）');
    assert(nearestSkeletonVertex(1000, 1000, sk, 10) === null, '远处不该命中');
    return '严格小于阈值才命中';
  });

  check('索引真的更快（同一批 20 条笔迹，至少快 5×）', () => {
    const cache = new Map();
    const t0 = Date.now();
    for (const tr of traces) conformNaive(tr, skeleton, 10, dedupeRing, { cache });
    const slowMs = Date.now() - t0;
    const t1 = Date.now();
    for (const tr of traces) conformToSkeleton(tr, skeleton, 10);
    const fastMs = Date.now() - t1;
    if (!(fastMs * 5 <= slowMs)) {
      throw new Error(`索引没有明显更快：朴素 ${slowMs}ms / 索引 ${fastMs}ms（阈值 5×）——`
        + '要么索引没接上，要么每次都在重建索引');
    }
    return `朴素 ${slowMs}ms → 索引 ${fastMs}ms（${(slowMs / Math.max(1, fastMs)).toFixed(1)}×）`;
  });

  check('buildSkeleton + 索引：换一个骨架数组不会串味（WeakMap 按数组身份）', () => {
    const provinces = [
      { id: 'a', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] },
      { id: 'b', points: [{ x: 100, y: 100 }, { x: 110, y: 100 }, { x: 110, y: 110 }] },
    ];
    const sk1 = buildSkeleton(provinces);
    const sk2 = buildSkeleton(provinces.slice(1));
    assert(nearestSkeletonVertex(100, 100, sk1, 10) !== null, 'sk1 里应命中 b 的顶点');
    assert(nearestSkeletonVertex(0, 0, sk1, 1) !== null, 'sk1 里应命中 a 的顶点');
    assert(nearestSkeletonVertex(0, 0, sk2, 1) === null, 'sk2 不含 a → 不该命中（索引串味了）');
    return 'sk1/sk2 各自独立';
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? '✅' : '🔴'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 清不掉就留着 */ }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('🔴 测试自身异常：', (err && err.stack) || err);
  process.exit(1);
});
