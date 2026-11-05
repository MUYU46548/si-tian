#!/usr/bin/env node
/**
 * 河流系统体检（2026-11-03，用户：“整套河流系统都是大问题，而且从未被解决”）
 *
 * 为什么先做这个而不是直接改画法：河流是**从高度图推出来的**，一条河对不对只有四个可证伪的事实：
 *   ① 有河（不是 0 条）；
 *   ② 每条河**终点入海**（否则是“断头河”）；
 *   ③ 沿线**严格不上升**（否则是“往山上流”）；
 *   ④ 起点在内陆（不是贴着海岸起步）。
 * 这四条能在 Node 里跑，不需要开窗口 —— 先把“到底哪条不对”量化，再决定改哪儿。
 *
 * 用法：node scripts/tests/unit/test_river_health.js [cellsAcross]
 * 退出码：0 = 四条全过；1 = 有硬伤
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');

const SEA = 20;

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

async function main() {
  const cellsAcross = Number(process.argv[2]) || 192;   // 与 2026-11-03 的新默认一致
  const TS = await import(pathToFileURL(path.join(UTILS, 'terrainSynthesis.js')).href);
  const RT = await import(pathToFileURL(path.join(UTILS, 'riverTrace.js')).href);

  const R = 380;
  const ring = [];
  for (let k = 0; k < 72; k++) {
    const a = (k / 72) * Math.PI * 2;
    const r = R * (1 + 0.08 * Math.sin(a * 3 + 0.7) + 0.05 * Math.sin(a * 7 - 1.1));
    ring.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const isLand = (x, y) => pointInRing(x, y, ring);

  const t0 = Date.now();
  const hm = TS.synthesizeHeightmapFromTerrain([{ rings: [ring] }], {
    cellsAcross, seed: 7, isLand,
    structureOverrides: { rangeWeight: 0.34, crossRangeWeight: 0.12, riftDepth: 0.22, plateauWeight: 0.28 },
  });
  const genMs = Date.now() - t0;
  if (!hm) { console.log('❌ 地形推演返回 null'); process.exit(1); }

  const cols = hm.grid.cellsX | 0, rows = hm.grid.cellsY | 0;
  const spacing = hm.grid.spacing;
  const pts = hm.grid.points;

  // 标定模式（2026-11-03）：一次跑出“分位比例 → 河流数”的曲线，避免一档一档改常量再重跑。
  if (process.argv.includes('--sweep')) {
    const landN = hm.h.filter((v) => v > SEA).length;
    console.log(`网格 ${cols}×${rows} / 陆地 ${landN} 格 / 绝对闸门 ${RT.TRACE_SOURCE_HEIGHT} = 基准`);
    for (const q of [0.005, 0.008, 0.01, 0.015, 0.02, 0.03]) {
      const o = RT.traceRivers(hm, { sourceQuantile: q });
      const rs = Array.isArray(o) ? o : (o.rivers || []);
      console.log(`  分位 ${(q * 100).toFixed(1)}% → ${rs.length} 条`);
    }
    process.exit(0);
  }

  // 新实现对照（2026-11-03）：FMG 口径的河网（flux 源头 + 必须入海 + 河宽分级）
  if (process.argv.includes('--fmg')) {
    const FMG = await import(pathToFileURL(path.join(UTILS, 'fmg', 'rivers.js')).href);
    const o = FMG.buildRiverNetwork(hm, {});
    console.log('FMG 新河网 ' + JSON.stringify(o.stats));
    process.exit(0);
  }

  const t1 = Date.now();
  const out = RT.traceRivers(hm, {});
  const traceMs = Date.now() - t1;
  const rivers = Array.isArray(out) ? out : (out.rivers || (out.net && out.net.rivers) || []);
  const stats = (out && out.stats) || {};

  const landCells = hm.h.filter((v) => v > SEA).length;
  const problems = [];
  if (!rivers.length) problems.push('① 一条河都没有');

  let noSea = 0, uphill = 0, shoreStart = 0, tooShort = 0;
  const samples = [];
  for (const r of rivers) {
    const ps = r.points || r.path || [];
    if (ps.length < 4) { tooShort++; continue; }
    // 高度取最近格点（河流点是世界坐标）
    const hAt = (p) => {
      const c = Math.max(0, Math.min(cols - 1, Math.round((p.x - pts[0][0]) / spacing)));
      const rr = Math.max(0, Math.min(rows - 1, Math.round((p.y - pts[0][1]) / spacing)));
      return hm.h[rr * cols + c];
    };
    const hs = ps.map(hAt);
    if (hs[hs.length - 1] > SEA + 0.5) noSea++;
    for (let i = 1; i < hs.length; i++) {
      if (hs[i] > hs[i - 1] + 0.05) { uphill++; break; }
    }
    if (hs[0] < SEA + 8) shoreStart++;
    if (samples.length < 3) samples.push(`len=${ps.length} h0=${hs[0].toFixed(1)} hEnd=${hs[hs.length - 1].toFixed(1)}`);
  }
  if (noSea) problems.push(`② ${noSea}/${rivers.length} 条没入海（终点仍在陆地）`);
  if (uphill) problems.push(`③ ${uphill}/${rivers.length} 条沿线有上升段（往山上流）`);
  if (shoreStart) problems.push(`④ ${shoreStart}/${rivers.length} 条起点贴着海岸（h<28）`);

  console.log(`网格 ${cols}×${rows} / 格距 ${spacing.toFixed(2)} / 陆地 ${landCells} 格 / cellsAcross=${cellsAcross}`);
  console.log(`生成 ${genMs}ms / 追踪 ${traceMs}ms / 河流 ${rivers.length} 条 / 统计 ${JSON.stringify(stats).slice(0, 160)}`);
  if (samples.length) console.log(`样本：${samples.join(' | ')}`);
  if (problems.length) {
    console.log('\n硬伤：');
    for (const p of problems) console.log('  ❌ ' + p);
  } else {
    console.log('\n✅ 四条全过：有河 / 条条入海 / 沿线不上升 / 起点在内陆');
  }
  process.exit(problems.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
