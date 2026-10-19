// 探针：**自动河流的"走法"到底该用哪一种**（2026-10-18 第九修开工前量数）
//
// 背景（`docs/RIVER_ALTERNATIVES_20261016.md` §5 的实测）：
//   133×75 粗网格上，任何"怎么走"的口径上限都很低（最长 9~12 格 / 140 世界单位）；
//   把地形**放大 6 倍**再追 + 最小代价出流 → 最长 **269 世界单位**、而且弯了。
//   同一张细网格上 D8 最陡只有 **77** —— 说明**细网格上"路由口径"才是决定性的**。
//
// 而产品现状（`store/geodataModules/scenarioEditing.js#generateRivers`）：
//   · `traceRivers(hm, passed)` —— UI **不传 `upsample`、不传 `smoothRadius`**（面板里有平滑开关，
//     但默认关）；
//   · 路由 = 局部最陡（`keyLess`：filled → H → **格号**）—— 平局落到格号 = 同高片里
//     所有格朝同一个方向走 = **梳齿**。
//
// 本探针要回答三个问题（只用真实 desite 底图，判据全是数）：
//   Q1 平局打破（格号 → 空间哈希抖动）本身能改善多少？
//   Q2 换成**最小代价出流**（Dijkstra from outlets）能改善多少？在细网格上呢？
//   Q3 观感指标（汇流率 / 梳齿指数 / 最长河道世界长度）谁最优？
//
// 用法：node scripts/tests/tools/_probe_routing_v2.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const P = 'C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian';
const SEA = 20;

// 产品源码直接用（只改写相对 import 的后缀，不改逻辑）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-rv2-'));
for (const f of ['riverTrace.js', 'riverChains.js', 'coastline.js', 'gridSpatialIndex.js', 'heightmapAccess.js', 'heightmapResample.js', 'polylineSmooth.js']) {
  fs.writeFileSync(path.join(tmp, f),
    fs.readFileSync(path.join(UTILS, f), 'utf8').replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'"));
}
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
const R = await import(pathToFileURL(path.join(tmp, 'riverTrace.js')).href);
const CH = await import(pathToFileURL(path.join(tmp, 'riverChains.js')).href);
const HR = await import(pathToFileURL(path.join(tmp, 'heightmapResample.js')).href);
const C = await import(pathToFileURL(path.join(tmp, 'coastline.js')).href);

const j = JSON.parse(fs.readFileSync(P, 'utf8'));
const bm = j.scenarios.baseMaps.desite;
const hm0 = bm.heightmap;
const mask = C.buildLandMask(bm.terrain);

function gridOf(hm) {
  const g = hm.grid, cols = g.cellsX | 0, rows = g.cellsY | 0, sp = g.spacing || 14.4, n = cols * rows;
  const H = Float64Array.from(hm.h, (v) => Number(v) || 0);
  const p0 = g.points[0];
  const X0 = Array.isArray(p0) ? p0[0] : p0.x, Y0 = Array.isArray(p0) ? p0[1] : p0.y;
  const XY = (i) => [X0 + (i % cols) * sp, Y0 + ((i / cols) | 0) * sp];
  return { cols, rows, sp, n, H, XY, isLand: (i) => H[i] >= SEA && !!mask.lookup(XY(i)[0], XY(i)[1]) };
}

function nb8(G) {
  const { cols, rows, sp } = G;
  const list = new Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) {
    const ci = i % cols, cj = (i / cols) | 0, out = [];
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
      out.push({ j: nj * cols + ni, dist: Math.hypot(di, dj) * sp, di, dj });
    }
    list[i] = out;
  }
  return list;
}

/** 二叉最小堆（探针内部用） */
function heap() {
  const I = [], K = [];
  return {
    push(i, k) { I.push(i); K.push(k); let a = I.length - 1; while (a > 0) { const p = (a - 1) >> 1; if (K[p] <= K[a]) break; [I[p], I[a]] = [I[a], I[p]]; [K[p], K[a]] = [K[a], K[p]]; a = p; } },
    pop() { const i = I[0], k = K[0]; const li = I.pop(), lk = K.pop(); if (I.length) { I[0] = li; K[0] = lk; let a = 0; for (;;) { const l = 2 * a + 1, r = l + 1; let m = a; if (l < K.length && K[l] < K[m]) m = l; if (r < K.length && K[r] < K[m]) m = r; if (m === a) break; [I[m], I[a]] = [I[a], I[m]]; [K[m], K[a]] = [K[a], K[m]]; a = m; } } return [i, k]; },
    get size() { return I.length; },
  };
}

function fill(G) {
  const { n, H, isLand } = G;
  const filled = new Float64Array(n), done = new Uint8Array(n), hp = heap();
  for (let i = 0; i < n; i++) if (!isLand(i)) { filled[i] = H[i]; done[i] = 1; hp.push(i, H[i]); }
  const NB = G.NB;
  while (hp.size) {
    const [i, k] = hp.pop();
    for (const nb of NB[i]) {
      const j2 = nb.j; if (done[j2]) continue; done[j2] = 1;
      filled[j2] = Math.max(H[j2], k); hp.push(j2, filled[j2]);
    }
  }
  return filled;
}

function hashJitter(i, cols, seed = 17) {
  const x = i % cols, y = (i / cols) | 0;
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177; h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}

/** ① 现状口径：filled → H → 格号 */
function recvLegacy(G, filled, tie) {
  const { n, H, NB } = G;
  const recv = new Int32Array(n).fill(-1);
  const less = (a, b) => {
    const fa = filled[a], fb = filled[b];
    if (fa < fb - 1e-12) return true;
    if (fa > fb + 1e-12) return false;
    if (H[a] < H[b] - 1e-12) return true;
    if (H[a] > H[b] + 1e-12) return false;
    if (tie === 'hash') return hashJitter(a, G.cols) < hashJitter(b, G.cols);
    return a < b;
  };
  for (let i = 0; i < n; i++) {
    if (H[i] < SEA) { recv[i] = i; continue; }
    let best = -1;
    for (const nb of NB[i]) { if (best < 0 || less(nb.j, best)) best = nb.j; }
    recv[i] = (best >= 0 && less(best, i)) ? best : -1;
  }
  return recv;
}

/** ② 最小代价出流：Dijkstra from outlets，代价 = 距离 + 权重×（逆坡抬升） */
function recvLeastCost(G, filled, w = 0) {
  const { n, H, NB } = G;
  const cost = new Float64Array(n).fill(Infinity);
  const settled = new Uint8Array(n);
  const hp = heap();
  for (let i = 0; i < n; i++) if (H[i] < SEA) { cost[i] = 0; hp.push(i, 0); }
  while (hp.size) {
    const [i, ci] = hp.pop();
    if (settled[i]) continue; settled[i] = 1;
    for (const nb of NB[i]) {
      const j2 = nb.j; if (settled[j2]) continue;
      if (H[j2] < SEA) continue;
      // nb → i 这一段：距离是常数项，逆坡（要抬升才能流过去）按 w 计权
      const rise = Math.max(0, filled[j2] - filled[i]);
      const nc = ci + nb.dist * 0.001 + w * rise;
      if (nc < cost[j2] - 1e-12) { cost[j2] = nc; hp.push(j2, nc); }
    }
  }
  const recv = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (H[i] < SEA) { recv[i] = i; continue; }
    if (!Number.isFinite(cost[i])) { recv[i] = -1; continue; }
    let best = -1;
    for (const nb of NB[i]) {
      const j2 = nb.j;
      if (!(cost[j2] < cost[i] - 1e-12)) continue;
      if (best < 0) { best = j2; continue; }
      if (cost[j2] < cost[best] - 1e-12) { best = j2; continue; }
      if (Math.abs(cost[j2] - cost[best]) <= 1e-12) {
        if (H[j2] < H[best] || (H[j2] === H[best] && hashJitter(j2, G.cols) < hashJitter(best, G.cols))) best = j2;
      }
    }
    // 万一没有任何邻居代价更小（数值边界）→ 退回最陡
    if (best < 0) {
      let b2 = -1;
      for (const nb of NB[i]) { if (b2 < 0 || filled[nb.j] < filled[b2] || (filled[nb.j] === filled[b2] && H[nb.j] < H[b2])) b2 = nb.j; }
      if (b2 >= 0 && (filled[b2] < filled[i] - 1e-12 || (Math.abs(filled[b2] - filled[i]) <= 1e-12 && H[b2] < H[i] - 1e-12))) best = b2;
    }
    recv[i] = best;
  }
  return { recv, cost };
}

/** ③ 指标：全是数，便于跨口径比较 */
function metrics(G, filled, recv, orderKey, label, ms) {
  const { n, H, NB, sp } = G;
  // 汇流累积（按下游优先的键降序）
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (orderKey[b] - orderKey[a]) || (a - b));
  const acc = new Float64Array(n).fill(1);
  for (const i of order) {
    if (H[i] < SEA) continue;
    const j2 = recv[i];
    if (j2 >= 0 && j2 !== i) acc[j2] += acc[i];
  }
  let maxAcc = 0, land = 0, reaching = 0, junctions = 0, combCells = 0;
  for (let i = 0; i < n; i++) {
    if (H[i] < SEA) continue;
    land++;
    if (acc[i] > maxAcc) maxAcc = acc[i];
  }
  // 到不到海 + 最长河道（世界单位）+ 梳齿指数
  const verdict = new Uint8Array(n);   // 0 未知 / 1 能到 / 2 不能
  for (let i = 0; i < n; i++) if (H[i] < SEA) verdict[i] = 1;
  const donors = new Int32Array(n);
  for (let i = 0; i < n; i++) { if (H[i] < SEA) continue; const j2 = recv[i]; if (j2 >= 0 && j2 !== i) donors[j2]++; }
  for (let i = 0; i < n; i++) if (H[i] >= SEA && donors[i] >= 2) junctions++;
  let longest = 0;
  // 下游长度（世界单位）记忆化：downLen[i] = dist(i, recv[i]) + downLen[recv[i]]
  const downLen = new Float64Array(n).fill(-1);
  const stepDist = (i, j2) => Math.hypot((j2 % G.cols) - (i % G.cols), ((j2 / G.cols) | 0) - ((i / G.cols) | 0)) * sp;
  for (let i = 0; i < n; i++) {
    if (H[i] < SEA || downLen[i] >= 0) continue;
    const stack = [];
    let cur = i;
    while (cur >= 0 && H[cur] >= SEA && downLen[cur] < 0) {
      const nx = recv[cur];
      if (nx < 0 || nx === cur) { downLen[cur] = 0; break; }
      stack.push(cur); cur = nx;
      if (stack.length > n) break;
    }
    for (let k = stack.length - 1; k >= 0; k--) {
      const c = stack[k], nx = recv[c];
      downLen[c] = (nx < 0 || nx === c) ? 0 : stepDist(c, nx) + Math.max(0, downLen[nx]);
    }
  }
  for (let i = 0; i < n; i++) if (H[i] >= SEA && downLen[i] > longest) longest = downLen[i];
  const dirIdx = (i) => {
    const j2 = recv[i]; if (j2 < 0 || j2 === i) return -1;
    const ci = i % G.cols, cj = (i / G.cols) | 0, di = (j2 % G.cols) - ci, dj = ((j2 / G.cols) | 0) - cj;
    return (Math.sign(dj) + 1) * 3 + (Math.sign(di) + 1);   // 0..8，4 = 原地
  };
  const runLen = new Int32Array(n).fill(-1);   // 沿流向下游的同向连续段长（含自身）
  function runOf(i) {
    if (runLen[i] >= 0) return runLen[i];
    const d = dirIdx(i);
    if (d < 0) { runLen[i] = 0; return 0; }
    const j2 = recv[i];
    // 递归会爆栈 → 迭代
    const stack = [];
    let cur = i;
    while (true) {
      if (runLen[cur] >= 0) break;
      const cd = dirIdx(cur);
      if (cd < 0) { runLen[cur] = 0; break; }
      const nx = recv[cur];
      if (runLen[nx] >= 0) { runLen[cur] = (dirIdx(nx) === cd) ? runLen[nx] + 1 : 1; break; }
      stack.push(cur); cur = nx;
      if (stack.length > 400000) { for (const s of stack) runLen[s] = 1; break; }
    }
    for (let k = stack.length - 1; k >= 0; k--) {
      const c = stack[k], cd = dirIdx(c), nx = recv[c];
      runLen[c] = (runLen[nx] >= 0 && dirIdx(nx) === cd) ? runLen[nx] + 1 : 1;
    }
    return runLen[i];
  }
  for (let i = 0; i < n; i++) {
    if (H[i] < SEA) continue;
    // 走到海（含记忆化太长，这里直接用 verdict 迭代）
    if (!verdict[i]) {
      let cur = i, ok = false, guard = 0;
      const path = [];
      while (guard++ < 100000) {
        if (verdict[cur]) { ok = verdict[cur] === 1; break; }
        const nx = recv[cur];
        if (nx < 0 || nx === cur) { ok = false; break; }
        path.push(cur); cur = nx;
      }
      for (const c of path) verdict[c] = ok ? 1 : 2;
      verdict[i] = ok ? 1 : 2;
    }
    if (verdict[i] === 1) reaching++;
    if (dirIdx(i) >= 0) { const r = runOf(i); const axis = [3, 5, 1, 7].includes(dirIdx(i)); if (axis && r >= 4) combCells++; }
  }
  // 汇流率：相邻陆格里，两者流向**同一个**下游的比例
  let adj = 0, merge = 0;
  for (let i = 0; i < n; i++) {
    if (H[i] < SEA) continue;
    const ci = i % G.cols, cj = (i / G.cols) | 0;
    for (const [di, dj] of [[1, 0], [0, 1]]) {
      const ni = ci + di, nj = cj + dj;
      if (ni >= G.cols || nj >= G.rows) continue;
      const j2 = nj * G.cols + ni;
      if (H[j2] < SEA) continue;
      adj++;
      if (recv[i] >= 0 && recv[i] === recv[j2]) merge++;
    }
  }
  console.log(`${label.padEnd(34)} 陆格 ${String(land).padStart(5)} 到海 ${(reaching / land * 100).toFixed(1)}%`
    + ` 最大汇流 ${String(Math.round(maxAcc)).padStart(6)} 汇流点 ${String(junctions).padStart(5)}`
    + ` 最长河道 ${String(Math.round(longest)).padStart(5)}u 梳齿 ${(combCells / land * 100).toFixed(1)}%`
    + ` 汇流率 ${(merge / adj * 100).toFixed(1)}% ${String(Math.round(ms)).padStart(5)}ms`);
  return { maxAcc, longest, comb: combCells / land, merge: merge / adj, reaching: reaching / land, junctions };
}

console.log('== 真实 desite 底图（133×75 / 陆格 2876）==');

/** 从流向场造出与产品同形的段，再用**产品自己的** buildRiverPaths 建链，量"画出来是什么样" */
function chainMetrics(G, recv, label, ms) {
  const { n, H, sp } = G;
  const segs = [];
  for (let i = 0; i < n; i++) {
    if (H[i] < SEA) continue;
    const nx = recv[i];
    if (nx < 0 || nx === i) continue;
    const a = G.XY(i), b = G.XY(nx);
    segs.push({ x0: a[0], y0: a[1], x1: b[0], y1: b[1], flow: 1, endInSea: H[nx] < SEA, cell: i });
  }
  const chains = CH.buildRiverPaths(segs, { minFlow: 0, minLen: 2 });
  const lens = chains.map((c) => {
    let L = 0;
    for (let k = 0; k + 1 < c.points.length; k++) L += Math.hypot(c.points[k + 1].x - c.points[k].x, c.points[k + 1].y - c.points[k].y);
    return L;
  }).sort((a, b) => a - b);
  const npts = chains.map((c) => c.points.length).sort((a, b) => a - b);
  const med = (arr) => (arr.length ? arr[arr.length >> 1] : 0);
  const sticks = npts.filter((p) => p <= 3).length;
  // 转角：每条链相邻两点方向的夹角（度）
  let turnSum = 0, turnN = 0;
  for (const c of chains) {
    for (let k = 1; k + 1 < c.points.length; k++) {
      const a1 = Math.atan2(c.points[k].y - c.points[k - 1].y, c.points[k].x - c.points[k - 1].x);
      const a2 = Math.atan2(c.points[k + 1].y - c.points[k].y, c.points[k + 1].x - c.points[k].x);
      let d = Math.abs(a2 - a1) * 180 / Math.PI;
      if (d > 180) d = 360 - d;
      turnSum += d; turnN++;
    }
  }
  console.log(`${label.padEnd(28)} 段 ${String(segs.length).padStart(6)} 链 ${String(chains.length).padStart(5)}`
    + ` 链点数中位 ${String(med(npts)).padStart(4)} ≤3点的链 ${(sticks / Math.max(1, chains.length) * 100).toFixed(0).padStart(3)}%`
    + ` 链长中位 ${String(Math.round(med(lens))).padStart(4)}u 最长 ${String(Math.round(lens[lens.length - 1] || 0)).padStart(5)}u`
    + ` 平均转角 ${(turnSum / Math.max(1, turnN)).toFixed(0).padStart(3)}° ${String(Math.round(ms)).padStart(5)}ms`);
  return { chains: chains.length, sticks: sticks / Math.max(1, chains.length), medPts: med(npts), medLen: med(lens), maxLen: lens[lens.length - 1] || 0 };
}

const G0 = gridOf(hm0); G0.NB = nb8(G0);
const f0 = fill(G0);
for (const [name, tie] of [['B0 现状（filled→H→格号）', 'index'], ['B1 平局→空间哈希', 'hash']]) {
  const t = Date.now();
  const r = recvLegacy(G0, f0, tie);
  chainMetrics(G0, r, name, Date.now() - t);
}
for (const w of [0, 0.2]) {
  const t = Date.now();
  const { recv } = recvLeastCost(G0, f0, w);
  chainMetrics(G0, recv, `B2 最小代价 w=${w}`, Date.now() - t);
}
for (const factor of [3, 6]) {
  const rr = HR.resampleHeightmap(hm0, factor);
  if (!rr.ok) { console.log(`放大 ${factor}× 失败：${rr.message}`); continue; }
  const G = gridOf(rr.heightmap); G.NB = nb8(G);
  const f = fill(G);
  console.log(`-- ${factor}× → ${G.cols}×${G.rows} / 格距 ${G.sp.toFixed(2)} --`);
  {
    const t = Date.now();
    chainMetrics(G, recvLegacy(G, f, 'index'), `  ${factor}× 现状口径`, Date.now() - t);
  }
  {
    const t = Date.now();
    chainMetrics(G, recvLeastCost(G, f, 0.2).recv, `  ${factor}× 最小代价 w=0.2`, Date.now() - t);
  }
}
console.log('\n== 与分辨率无关的"链节"指标（物理长度，不截断）==');
/**
 * 链节长度：从每格往下游走到**下一个汇流点（入度≥2）或河口**的世界距离。
 * 为什么不用 buildRiverPaths：它按流量排序截到 maxPaths（1200），细网格下只统计了流量最高的
 * 那批链 → 中位链长被系统性拉高（假结论）。链节是 Strahler 分级的同一概念，可跨分辨率比。
 */
function linkStats(G, recv, label) {
  const { n, H, sp, cols } = G;
  const donors = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (H[i] < SEA) continue;
    const nx = recv[i];
    if (nx >= 0 && nx !== i) donors[nx]++;
  }
  let junctions = 0;
  for (let i = 0; i < n; i++) if (H[i] >= SEA && donors[i] >= 2) junctions++;
  const d2j = new Float64Array(n).fill(-1);
  const step = (i, j2) => Math.hypot((j2 % cols) - (i % cols), ((j2 / cols) | 0) - ((i / cols) | 0)) * sp;
  for (let i = 0; i < n; i++) {
    if (H[i] < SEA || d2j[i] >= 0) continue;
    const stack = [];
    let cur = i;
    while (cur >= 0 && H[cur] >= SEA && d2j[cur] < 0) {
      const nx = recv[cur];
      if (nx < 0 || nx === cur) { d2j[cur] = 0; break; }
      if (donors[cur] >= 2) { d2j[cur] = 0; break; }          // 汇流点 = 链节终点
      stack.push(cur);
      if (donors[nx] >= 2 || H[nx] < SEA) { d2j[nx] = 0; }
      cur = nx;
      if (stack.length > n) break;
    }
    for (let k = stack.length - 1; k >= 0; k--) {
      const c = stack[k], nx = recv[c];
      d2j[c] = (nx < 0 || nx === c) ? 0 : step(c, nx) + Math.max(0, d2j[nx]);
    }
  }
  const vals = [];
  let land = 0, short20 = 0, short40 = 0;
  for (let i = 0; i < n; i++) {
    if (H[i] < SEA || recv[i] < 0) continue;
    land++;
    const v = d2j[i];
    vals.push(v);
    if (v < 20) short20++;
    if (v < 40) short40++;
  }
  vals.sort((a, b) => a - b);
  const q = (p) => (vals.length ? vals[Math.min(vals.length - 1, Math.round((vals.length - 1) * p))] : 0);
  console.log(`${label.padEnd(26)} 陆格 ${String(land).padStart(6)} 汇流点 ${String(junctions).padStart(5)}`
    + ` 链节中位 ${String(Math.round(q(0.5))).padStart(4)}u p90 ${String(Math.round(q(0.9))).padStart(4)}u`
    + ` <20u ${(short20 / Math.max(1, land) * 100).toFixed(0).padStart(3)}% <40u ${(short40 / Math.max(1, land) * 100).toFixed(0).padStart(3)}%`);
  return { med: q(0.5), short20: short20 / land, short40: short40 / land, junctions };
}
{
  const G0 = gridOf(hm0); G0.NB = nb8(G0);
  const f0 = fill(G0);
  linkStats(G0, recvLegacy(G0, f0, 'index'), '1× 现状口径');
  linkStats(G0, recvLegacy(G0, f0, 'hash'), '1× 平局→空间哈希');
  linkStats(G0, recvLeastCost(G0, f0, 0.2).recv, '1× 最小代价 w=0.2');
}
for (const factor of [2, 3, 4, 6, 8]) {
  const rr = HR.resampleHeightmap(hm0, factor);
  if (!rr.ok) { console.log(`放大 ${factor}× 失败：${rr.message}`); continue; }
  const G = gridOf(rr.heightmap); G.NB = nb8(G);
  const f = fill(G);
  linkStats(G, recvLegacy(G, f, 'index'), `${factor}× 现状口径`);
  linkStats(G, recvLeastCost(G, f, 0.2).recv, `${factor}× 最小代价 w=0.2`);
}
console.log('\n== 候选：放大时叠加**分形细节**（双线性只让同一地形更细，不产生新水系）==');
function hash2(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177; h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}
const sm = (t) => { const c = t < 0 ? 0 : t > 1 ? 1 : t; return c * c * (3 - 2 * c); };
function vnoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), tx = sm(x - xi), ty = sm(y - yi);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed), c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  const t = a + (b - a) * tx, bo = c + (d - c) * tx;
  return t + (bo - t) * ty;
}
function fbm(x, y, seed, oct = 3) {
  let s = 0, amp = 1, f = 1, norm = 0;
  for (let o = 0; o < oct; o++) { s += vnoise(x * f, y * f, seed + o * 101) * amp; norm += amp; amp *= 0.5; f *= 2; }
  return s / norm;
}
for (const factor of [3, 6]) {
  const rr = HR.resampleHeightmap(hm0, factor);
  if (!rr.ok) continue;
  for (const amp of [0, 2, 4, 8, 14]) {
    const G = gridOf(rr.heightmap); G.NB = nb8(G);
    if (amp > 0) {
      // 细节波长 ≈ 6 个**细格**（≈ 2 个粗格），幅度 amp（高度单位）
      const wl = G.sp * 6;
      for (let i = 0; i < G.n; i++) {
        if (G.H[i] < SEA) continue;
        const [x, y] = G.XY(i);
        const v = (fbm(x / wl, y / wl, 11, 3) - 0.5) * 2;
        // 只加在陆地上，且不许压到海平面以下（否则海岸被噪声咬出洞）
        G.H[i] = Math.max(SEA + 0.5, G.H[i] + amp * v * (wl > 0 ? 1 : 1));
      }
    }
    const f = fill(G);
    linkStats(G, recvLegacy(G, f, 'index'), `  ${factor}× 细节 amp=${amp}`);
  }
}
process.exit(0);

{
  const t = Date.now();
  const r = recvLegacy(G0, f0, 'index');
  metrics(G0, f0, r, f0, 'B0 现状口径（filled→H→格号）', Date.now() - t);
}
{
  const t = Date.now();
  const r = recvLegacy(G0, f0, 'hash');
  metrics(G0, f0, r, f0, 'B1 只把平局换成空间哈希', Date.now() - t);
}
for (const w of [0, 0.02, 0.2]) {
  const t = Date.now();
  const { recv, cost } = recvLeastCost(G0, f0, w);
  metrics(G0, f0, recv, cost, `B2 最小代价出流 w=${w}`, Date.now() - t);
}

for (const factor of [3, 4, 6]) {
  const rr = HR.resampleHeightmap(hm0, factor);
  if (!rr.ok) { console.log(`放大 ${factor}× 失败：${rr.message}`); continue; }
  const G = gridOf(rr.heightmap); G.NB = nb8(G);
  const f = fill(G);
  console.log(`-- ${factor}× → ${G.cols}×${G.rows} = ${G.n} 格 / 格距 ${G.sp.toFixed(2)} --`);
  {
    const t = Date.now();
    const r = recvLegacy(G, f, 'index');
    metrics(G, f, r, f, `  ${factor}× 现状口径`, Date.now() - t);
  }
  for (const w of [0, 0.02]) {
    const t = Date.now();
    const { recv, cost } = recvLeastCost(G, f, w);
    metrics(G, f, recv, cost, `  ${factor}× 最小代价 w=${w}`, Date.now() - t);
  }
}
console.log('\n判读：看「最长河道(u)」与「梳齿% / 汇流率%」两列。');
console.log('      若最小代价口径在细网格上把最长河道成倍拉长、且梳齿下降 → 就是本轮要接的东西。');
