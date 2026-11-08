#!/usr/bin/env node
/**
 * 规模压测（只读，纯函数层）——回答“几千个省份 + 更大的图，性能压力重不重”。
 *
 * 量的都是**产品里真实存在的那几条热路径**（不另写一套实现）：
 *   ① 地形推演 + 河网（`terrainPipeline.synthesizeTerrain` / `fmg/rivers.buildRiverNetwork`）随格数怎么涨；
 *   ② 省份命中（`provinceHitIndex.buildProvinceHitIndex` / `hitProvince`）随省份数怎么涨；
 *   ③ 时间轴账本（`scenarioTimeline.buildTimeline`）—— 涂一笔归属就要整条重算的那个；
 *   ④ 落盘载荷（`JSON.stringify` / `structuredClone`）—— 保存链与跨进程传输的真实成本；
 *   ⑤ 陆地掩膜（`coastline.buildLandMask`）—— 河/海岸裁剪每次生成都要建一遍。
 *
 * 用法：node scripts/tests/tools/_bench_eu4_scale.mjs [--quick]
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const argv = process.argv.slice(2);
const QUICK = argv.includes('--quick');

async function loadModuleViaTmp(entry) {
  const seen = new Map();
  const queue = [entry];
  while (queue.length) {
    const f = queue.pop().replace(/\\/g, '/');
    if (seen.has(f)) continue;
    const src = fs.readFileSync(path.join(UTILS, f), 'utf8');
    seen.set(f, src);
    for (const m of src.matchAll(/from '(\.\.?\/[^']+)'/g)) {
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      queue.push(rel.endsWith('.js') ? rel : rel + '.js');
    }
  }
  const tmpRoot = path.join(ROOT, 'build', '.tmp-modules');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(tmpRoot, 'run-'));
  for (const [f, src] of seen) {
    const fixed = src.replace(/from '(\.\.?\/[^']+)'/g, (all, spec) => (spec.endsWith('.js') ? all : `from '${spec}.js'`));
    const dest = path.join(tmp, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, fixed);
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const mod = await import(pathToFileURL(path.join(tmp, entry)).href);
  fs.rmSync(tmp, { recursive: true, force: true });
  try { fs.rmdirSync(tmpRoot); } catch { /* 还有副本 */ }
  return mod;
}

/** 确定性 PRNG（不许 Math.random：压测要可复现） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 铺 `n` 个省到 world × world 的地图上：每省一个约 `pts` 点的抖动六边形（面积随 n 缩小） */
function makeProvinces(n, world = 2000, pts = 40) {
  const rnd = mulberry32(7);
  const cols = Math.ceil(Math.sqrt(n));
  const cell = world / cols;
  const out = [];
  for (let i = 0; i < n; i++) {
    const cx = (i % cols + 0.5) * cell;
    const cy = (Math.floor(i / cols) + 0.5) * cell;
    const r = cell * 0.46;
    const points = [];
    for (let k = 0; k < pts; k++) {
      const a = (k / pts) * Math.PI * 2;
      const jitter = 0.82 + rnd() * 0.3;
      points.push({ x: +(cx + Math.cos(a) * r * jitter).toFixed(2), y: +(cy + Math.sin(a) * r * jitter).toFixed(2) });
    }
    out.push({ id: `p${i}`, name: `省${i}`, kind: 'land', color: '#c9a06a', points });
  }
  return out;
}

function ms(fn) {
  const t0 = process.hrtime.bigint();
  const r = fn();
  const t1 = process.hrtime.bigint();
  return { r, ms: Number(t1 - t0) / 1e6 };
}

async function main() {
  const PIPE = await loadModuleViaTmp('terrainPipeline.js');
  const P = await loadModuleViaTmp('terrainParams.js');
  const R = await loadModuleViaTmp('fmg/rivers.js');
  const PHI = await loadModuleViaTmp('provinceHitIndex.js');
  const TL = await loadModuleViaTmp('scenarioTimeline.js');
  const C = await loadModuleViaTmp('coastline.js');

  const mkRing = (cx, cy, r, n, wobble, seed) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const w = 1 + Math.sin(a * 3 + seed) * wobble + Math.sin(a * 7 + seed * 2) * wobble * 0.5;
      pts.push({ x: cx + Math.cos(a) * r * w, y: cy + Math.sin(a) * r * w * 0.72 });
    }
    return pts;
  };
  const terrain = [{ id: 'p1', name: 'A', kind: 'land', color: '#c9a06a', points: mkRing(0, 0, 900, 90, 0.16, 1.2) }];
  const mask = C.buildLandMask(terrain);

  // ── ① 格数：推演 / 河网 / 载荷 ────────────────────────────────────────────
  // 两档规模一起量：**同一块大陆换精度**（256 / 512 / 768）与 **大陆本身变大**（半径 900 → 3600）。
  console.log('【① 网格规模】地形推演 + 河网 + 落盘体积（产品默认参数：8 河口 + 260 丘陵）');
  console.log('  大陆半径 | cellsAcross |   格网    | 总格数 | 推演ms | 河网ms | 河数 | 高度图JSON | 河JSON');
  const cases = QUICK
    ? [{ r: 900, cells: 192 }, { r: 900, cells: 512 }]
    : [{ r: 900, cells: 192 }, { r: 900, cells: 512 }, { r: 1800, cells: 768 }, { r: 3600, cells: 1024 }];
  for (const { r, cells } of cases) {
    const land = [{ id: 'p1', name: 'A', kind: 'land', color: '#c9a06a', points: mkRing(0, 0, r, 90, 0.16, 1.2) }];
    const mk = C.buildLandMask(land);
    // `normalizeTerrainParams` 会把 cellsAcross 夹到面板选项（最大 256）—— 压测要越过面板，
    // 所以先取参数再**覆盖** cellsAcross（这也是引擎真实的入口）。
    const opts = { ...P.toSynthesisOptions(P.normalizeTerrainParams({ seed: 7 }).params, { isLand: mk.lookup }), cellsAcross: cells };
    const t = ms(() => PIPE.synthesizeTerrain(land, opts));
    const hm = t.r;
    const n = hm.h.length;
    const net = ms(() => R.buildRiverNetwork({ grid: hm.grid, h: hm.h, lakes: hm.lakes }, { minFlux: 120 }));
    const stored = R.toStoredRivers(net.r);
    const hmJson = JSON.stringify({ h: Array.from(hm.h, (v) => Math.round(v * 100) / 100) });
    const rvJson = JSON.stringify(stored);
    console.log(`  ${String(r).padStart(8)} | ${String(cells).padStart(11)} | ${String(hm.grid.cellsX + 'x' + hm.grid.cellsY).padStart(9)} | ${String(n).padStart(6)} | ${t.ms.toFixed(0).padStart(6)} | ${net.ms.toFixed(0).padStart(6)} | ${String(net.r.rivers.length).padStart(4)} | ${(hmJson.length / 1048576).toFixed(2).padStart(8)} MB | ${(rvJson.length / 1048576).toFixed(2)} MB`);
  }
  void mask;

  // ── ② 省份数：命中索引 / 掩膜 ─────────────────────────────────────────────
  console.log('\n【② 省份规模】命中索引（悬停/点击那条路）+ 陆地掩膜（生成时建一次）');
  console.log('    省份数 | 建索引ms | 内存索引条目 | 1000 次命中ms | 平均 μs/次 | 掩膜ms');
  const provList = QUICK ? [415, 1500] : [415, 1500, 3000, 6000];
  const rnd = mulberry32(11);
  for (const n of provList) {
    const provs = makeProvinces(n);
    const built = ms(() => PHI.buildProvinceHitIndex(provs));
    const q = ms(() => {
      let hits = 0;
      for (let i = 0; i < 1000; i++) {
        const x = rnd() * 2000, y = rnd() * 2000;
        if (PHI.hitProvince(built.r, x, y)) hits += 1;
      }
      return hits;
    });
    const maskBuild = ms(() => C.buildLandMask(provs));
    console.log(`  ${String(n).padStart(7)} | ${built.ms.toFixed(0).padStart(8)} | ${String(built.r && built.r.cells ? built.r.cells.size : (built.r && built.r.count) || '-').padStart(12)} | ${q.ms.toFixed(0).padStart(13)} | ${(q.ms).toFixed(1).padStart(10)} | ${maskBuild.ms.toFixed(0).padStart(6)}`);
  }

  // ── ③ 时间轴账本：涂一笔归属就要整条重算 ──────────────────────────────────
  console.log('\n【③ 账本重算】每涂一笔归属，`buildTimeline` 整条重算（A4 卡里 415 省实测 48ms 的那条）');
  console.log('    省份数 | 段数 | buildTimeline ms | 每省 μs');
  for (const n of (QUICK ? [415, 1500] : [415, 1500, 3000])) {
    const provs = makeProvinces(n);
    const list = [];
    for (let s = 0; s < 13; s++) {
      const ownership = {};
      for (const p of provs) ownership[p.id] = `f${(s + p.id.length) % 4}`;
      list.push({
        id: `sc${s}`, name: `第${s}代`, start: 1300 + s * 50, end: 1350 + s * 50,
        ownership,
        changeEvents: s === 0 ? [] : provs.slice(0, Math.ceil(n * 0.02)).map((p, k) => ({
          id: `ev${s}_${k}`, pid: p.id, owner: `f${k % 4}`, date: 1310 + s * 50,
        })),
      });
    }
    const t = ms(() => TL.buildTimeline(list));
    console.log(`  ${String(n).padStart(7)} | ${String(t.r.scenarios.length).padStart(4)} | ${t.ms.toFixed(0).padStart(16)} | ${(t.ms * 1000 / n).toFixed(1).padStart(6)}`);
  }

  // ── ④ 落盘载荷 ────────────────────────────────────────────────────────────
  console.log('\n【④ 落盘载荷】项目文件体积 + 一次序列化/深拷的时间（保存链与跨进程传输的真实成本）');
  console.log('    省份数 | 格数 | 项目JSON | stringify ms | structuredClone ms');
  for (const n of (QUICK ? [415, 1500] : [415, 1500, 3000])) {
    const provs = makeProvinces(n);
    const cells = 193;
    const grid = n === 415 ? 193 : 257;
    const cols = grid, rows = Math.round(grid * 0.75);
    const h = new Array(cols * rows);
    for (let i = 0; i < h.length; i++) h[i] = 20 + ((i * 37) % 55);
    const totalPts = provs.reduce((a, p) => a + p.points.length, 0);
    const rivers = Array.from({ length: 800 }, (_, i) => ({
      id: `river_gen_${i}`, name: `河${i}`, width: 0.1,
      points: Array.from({ length: 12 }, (_, k) => ({ x: k * 3, y: i % 200, flux: 100 + k })),
    }));
    const proj = {
      format: 'sitian-project', version: 1,
      entityTree: { id: 'root', name: '压测世界', children: [] },
      scenarios: {
        baseMaps: { bench: { id: 'bench', name: '压测底图', terrain: provs, heightmap: { grid: { points: [], cellsX: cols, cellsY: rows, spacing: 9 }, h }, rivers } },
        list: [], groups: [],
      },
    };
    const str = ms(() => JSON.stringify(proj));
    const cl = ms(() => structuredClone(proj));
    console.log(`  ${String(n).padStart(7)} | ${String(h.length).padStart(6)} | ${(str.r.length / 1048576).toFixed(2).padStart(7)} MB | ${str.ms.toFixed(0).padStart(12)} | ${cl.ms.toFixed(0).padStart(18)}`);
    void totalPts; void cells;
  }

  console.log('\n（全部只读：不写项目文件、不碰磁盘数据；每次都跑两遍取第二遍更有代表性，本表是单跑读数）');
}

main().catch((e) => { console.error(e); process.exit(1); });
