#!/usr/bin/env node
/**
 * **河网交叉审计（只读）**——回答“过穿的河流还有多少”。
 *
 * 两种口径一次跑：
 *   · `stored`：项目文件里**已落盘**的 `baseMaps[key].rivers`（用户此刻在图上看到的）；
 *   · `net`   ：拿同一份高度图**重新建一次网**（含汇流焊接，`utils/fmg/rivers.js`）。
 *
 * 判据：交叉数（不同河之间的真几何相交）。端点相接（汇流点）不算交叉。
 *
 * 用法：
 *   node scripts/tests/tools/audit_river_network.mjs <项目.sitian> [key] [--minflux 120]
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = process.cwd();
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');

function collectDeps(entries) {
  const seen = new Map();
  const queue = [...entries];
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
  return seen;
}

async function loadRivers() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-rivernet-'));
  for (const [f, src] of collectDeps(['fmg/rivers.js', 'riverRender.js'])) {
    const dest = path.join(tmp, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, src);
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const rivers = await import(pathToFileURL(path.join(tmp, 'fmg', 'rivers.js')).href);
  const render = await import(pathToFileURL(path.join(tmp, 'riverRender.js')).href);
  return { rivers, render };
}

function countCrossings(rivers, cellSize, opts = {}) {
  const withSelf = opts.withSelf === true;
  // 汇流点容差：相交点离**任一条河的端点**小于这个距离时，算“汇流”而不是“穿过”。
  // 为什么需要（2026-11-04 实测）：支流被焊在干流线上后，落库坐标量化到 0.01 会把交点
  // 挪开千分之几 —— 视觉上是同一个点，几何上判“越线”。容差默认 0.8 世界单位（<1/10 格）。
  const junctionTol = Number.isFinite(opts.junctionTol) ? opts.junctionTol : (args.includes('--strict') ? 0 : 0.8);
  const ends = rivers.map((r) => {
    const pts = r.points || [];
    return pts.length ? [pts[0], pts[pts.length - 1]] : [];
  });
  const nearEnd = (ri, x, y) => ends[ri].some((p) => Math.hypot(p.x - x, p.y - y) <= junctionTol);
  const cross = (a, b, c, d) => {
    const rx = b.x - a.x, ry = b.y - a.y;
    const sx = d.x - c.x, sy = d.y - c.y;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-12) return null;
    const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
    const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
    if (!(t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6)) return null;
    return { x: a.x + rx * t, y: a.y + ry * t, t, u };
  };
  const seen = new Set();
  const samples = [];
  let n = 0;
  const grid = new Map();
  const segs = [];
  for (let ri = 0; ri < rivers.length; ri++) {
    const pts = rivers[ri].points || [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const rec = { ri, i, a: pts[i], b: pts[i + 1] };
      segs.push(rec);
      const x0 = Math.floor(Math.min(rec.a.x, rec.b.x) / cellSize), x1 = Math.floor(Math.max(rec.a.x, rec.b.x) / cellSize);
      const y0 = Math.floor(Math.min(rec.a.y, rec.b.y) / cellSize), y1 = Math.floor(Math.max(rec.a.y, rec.b.y) / cellSize);
      for (let gx = x0; gx <= x1; gx++) {
        for (let gy = y0; gy <= y1; gy++) {
          const k = gx + ',' + gy;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(rec);
        }
      }
    }
  }
  for (const list of grid.values()) {
    for (let m = 0; m < list.length; m++) {
      for (let n2 = m + 1; n2 < list.length; n2++) {
        const s = list[m], t = list[n2];
        if (s.ri === t.ri) {
          if (!withSelf) continue;
          if (Math.abs(s.i - t.i) <= 1) continue;   // 相邻段共享端点
        }
        const key = Math.min(s.ri, t.ri) + ':' + Math.max(s.ri, t.ri) + ':' + s.i + ':' + t.i;
        if (seen.has(key)) continue;
        seen.add(key);
        const hit = cross(s.a, s.b, t.a, t.b);
        if (!hit) continue;
        if (junctionTol > 0 && (nearEnd(s.ri, hit.x, hit.y) || nearEnd(t.ri, hit.x, hit.y))) continue;
        n++;
        if (opts.why && samples.length < 6) {
          samples.push({ A: (rivers[s.ri].id), B: (rivers[t.ri].id), x: +hit.x.toFixed(2), y: +hit.y.toFixed(2), t: +hit.t.toFixed(4), u: +hit.u.toFixed(4) });
        }
      }
    }
  }
  return { crossings: n, segments: segs.length, samples };
}

const args = process.argv.slice(2);
const project = args[0];
const key = args[1] && !args[1].startsWith('--') ? args[1] : 'desite';
const mfIdx = args.indexOf('--minflux');
const minFlux = mfIdx >= 0 ? Number(args[mfIdx + 1]) : 120;
const tIdx = args.indexOf('--tension');
const tension = tIdx >= 0 ? Number(args[tIdx + 1]) : 0.5;
if (!project || !fs.existsSync(project)) {
  console.error('用法：node scripts/tests/tools/audit_river_network.mjs <项目.sitian> [key] [--minflux 120]');
  process.exit(2);
}

const j = JSON.parse(fs.readFileSync(project, 'utf8'));
const bm = ((j.scenarios || {}).baseMaps || {})[key];
if (!bm) { console.error('找不到底图', key); process.exit(2); }
const hm = bm.heightmap;
const spacing = Number(hm.grid.spacing) || 8;

const stored = bm.rivers || [];
const s = countCrossings(stored, spacing);
console.log(`[stored] ${stored.length} 条 / ${s.segments} 段 → 交叉 ${s.crossings}`);

const R = await loadRivers();
const net = R.rivers.buildRiverNetwork({ grid: hm.grid, h: hm.h, lakes: hm.lakes }, { minFlux });
const storedFromNet = R.rivers.toStoredRivers(net);
const ns = countCrossings(storedFromNet, spacing, { junctionTol: 0, why: args.includes('--why') });
if (args.includes('--why')) console.log('[why]', JSON.stringify(ns.samples));
console.log(`[round ] toStoredRivers(net) 严格交叉 ${ns.crossings} / ${ns.segments} 段`);
const inspIdx = args.indexOf('--inspect');
if (inspIdx >= 0) {
  const want = String(args[inspIdx + 1] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const byIdW = new Map(net.rivers.map((r) => ['river_gen_' + r.id, r]));
  for (const id of want) {
    const r = byIdW.get(id);
    if (!r) { console.log('[inspect]', id, 'missing'); continue; }
    const tail = r.points[r.points.length - 1];
    let best = Infinity;
    const pr = r.parent ? byIdW.get('river_gen_' + r.parent) : null;
    if (pr) {
      for (let i = 0; i + 1 < pr.points.length; i++) {
        const a = pr.points[i], b = pr.points[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const L = dx * dx + dy * dy;
        if (!L) continue;
        const u = Math.max(0, Math.min(1, ((tail.x - a.x) * dx + (tail.y - a.y) * dy) / L));
        best = Math.min(best, Math.hypot(tail.x - (a.x + dx * u), tail.y - (a.y + dy * u)));
      }
    }
    console.log('[inspect]', id, 'sea=' + r.endInSea, 'lake=' + r.endInLake, 'edge=' + r.endAtEdge,
      'junction=' + !!r.endsAtJunction, 'parent=' + r.parent, 'dParent=' + (Number.isFinite(best) ? best.toFixed(2) : 'n/a'),
      'cells=' + r.cells.length, 'pts=' + r.points.length);
  }
}
const n = countCrossings(net.rivers, spacing);
console.log(`[net   ] ${net.rivers.length} 条 / ${n.segments} 段 → 交叉 ${n.crossings}`
  + ` · 焊接 ${net.stats.welded} 条（新挂 parent ${net.stats.weldedJoined}）/ 入海 ${net.stats.endInSea} / 入湖 ${net.stats.endInLake}`
  + ` / maxOrder ${net.stats.maxOrder}`);

// 渲染口径：画布上真正画的是 Catmull-Rom 细分后的曲线（`riverRender.catmullRomPoints`），
// 样条会在急弯处**过冲** → 直线段之间不相交的，可能被画成交叉。这里按渲染口径再数一次。
const drawn = net.rivers.map((r) => ({ ...r, points: R.render.catmullRomPoints(r.points, 8, tension) }));
const nd = countCrossings(drawn, spacing);
console.log(`[draw  ] Catmull-Rom（tension=${tension}）细分后 → 交叉 ${nd.crossings} / ${nd.segments} 段`);

// Chaikin 角切（凸组合，不会越过控制折线）——按画布同一口径数一次
const chaikin = net.rivers.map((r) => ({ ...r, points: R.render.chaikinPoints(r.points, 3) }));
const nc = countCrossings(chaikin, spacing);
console.log(`[chaikin] 3 遍角切后 → 交叉 ${nc.crossings} / ${nc.segments} 段`);

// 渲染前再焊一次（对**细分后的**折线）：样条过冲造成的残余交叉也一起收口
const drawnWelded = drawn.map((r) => ({ ...r, points: r.points.slice() }));
const stats2 = R.rivers.weldRiverJunctions(drawnWelded, { spacing });
const nd2 = countCrossings(drawnWelded, spacing);
console.log(`[draw+weld] 细分后再焊（切断 ${stats2.cut} 条）→ 交叉 ${nd2.crossings} / ${nd2.segments} 段`);
const ndSelf = countCrossings(drawn, spacing, { withSelf: true });
console.log(`[draw+self] 含**同一条河自交** → 交叉 ${ndSelf.crossings}（其中自交 ${ndSelf.crossings - nd.crossings}）`);



// `--near x,y`：查这个点附近最近的**两条不同河**相隔多少（判断画面上的 X 是真交叉还是近邻）
const nearIdx = args.indexOf('--near');
if (nearIdx >= 0) {
  const [nx, ny] = String(args[nearIdx + 1] || '').split(',').map(Number);
  if (Number.isFinite(nx) && Number.isFinite(ny)) {
    const hits = [];
    net.rivers.forEach((r) => {
      const pts = r.points || [];
      let best = Infinity;
      let where = null;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const L = dx * dx + dy * dy;
        if (!L) continue;
        const t = Math.max(0, Math.min(1, ((nx - a.x) * dx + (ny - a.y) * dy) / L));
        const qx = a.x + dx * t, qy = a.y + dy * t;
        const d = Math.hypot(nx - qx, ny - qy);
        if (d < best) { best = d; where = { x: qx, y: qy }; }
      }
      if (Number.isFinite(best)) hits.push({ id: r.id, d: best, where, pts: pts.length });
    });
    hits.sort((a, b) => a.d - b.d);
    console.log(`[near] (${nx}, ${ny}) 最近 4 条：`
      + hits.slice(0, 4).map((h) => `${h.id} d=${h.d.toFixed(2)}@(${h.where.x.toFixed(1)},${h.where.y.toFixed(1)})`).join(' · '));
  }
}

const byId = new Map(net.rivers.map((r) => [r.id, r]));
const orphans = [];
for (const r of net.rivers) {
  let cur = r;
  const seen = new Set([r.id]);
  let okEnd = false;
  for (let guard = 0; guard < 128; guard++) {
    if (cur.endInSea || cur.endInLake || cur.endAtEdge || cur.endsAtJunction) { okEnd = true; break; }
    if (!cur.parent || seen.has(cur.parent)) break;
    seen.add(cur.parent);
    cur = byId.get(cur.parent);
    if (!cur) break;
  }
  if (!okEnd) orphans.push(r);
}
console.log(`[orphan] ${orphans.length} 条 parent 链走不到海/湖/图边`
  + (orphans.length ? `（例：${orphans.slice(0, 6).map((r) => `${r.id}(parent=${r.parent},order=${r.order},pts=${r.points.length})`).join(' / ')}）` : ''));

// parent 环自检（焊接只在“没有 parent”时挂，理论上不该成环；成环说明既有 parent 与截断冲突）
for (const r of orphans.slice(0, 3)) {
  const chain = [];
  let cur = r;
  for (let g = 0; g < 8 && cur; g++) {
    chain.push(`${cur.id}(d=${Math.round(cur.discharge)}, p=${cur.parent}, sea=${cur.endInSea}, lake=${cur.endInLake}, edge=${cur.endAtEdge})`);
    cur = byId.get(cur.parent);
  }
  console.log('[chain] ' + chain.join(' → '));
}


process.exit(n.crossings === 0 ? 0 : 1);
