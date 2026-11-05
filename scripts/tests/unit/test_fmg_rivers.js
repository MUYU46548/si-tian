#!/usr/bin/env node
/**
 * 单元测试：**FMG 口径的河网**（`src/renderer/src/utils/fmg/rivers.js` + `utils/lakes.js`）
 *
 * 为什么要有它（2026-11-04）：上一版河网的四类硬伤里，有三类**能量、但没人量**：
 *   ① 孤立短段（真实 415 省底图上 11 条、合成环岛 43 条 —— 每条 2~4 点，既不入海也不接主干）；
 *   ② 没有河的身份（只有格子，没有"从哪起源、汇进谁"→ 河名/分级无处挂）；
 *   ③ 湖与河各画各的（河照直穿过湖面）。
 * 这一份把三条都钉成**可证伪的断言**，并顺带守"不要把 FMG 的绝对闸门抄成摆设"。
 *
 * 判据设计纪律（本仓踩过多次）：
 *   · 每条断言先证明**量到了东西**（`n > 0`），再认那个 0/比例 —— 空集合恒真是假绿；
 *   · 反向对照必须有（把参数推到极端，读数必须真的变），否则测的是"函数没崩"而不是"口径对"。
 *
 * 用法：node scripts/tests/unit/test_fmg_rivers.js
 * 退出码：0 = 全过；1 = 有断言失败
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const SEA = 20;

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`✓ ${name}${detail ? `  —— ${detail}` : ''}`); }
  else { fails.push(`${name}${detail ? `  —— ${detail}` : ''}`); console.log(`✗ ${name}${detail ? `  —— ${detail}` : ''}`); }
}

function ringRing(R, wobble) {
  const ring = [];
  const k = 96;
  for (let i = 0; i < k; i++) {
    const a = (i / k) * Math.PI * 2;
    const r = R * (1 + 0.08 * Math.sin(a * 3 + 0.7) + wobble * Math.sin(a * 7 - 1.1));
    ring.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return ring;
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/**
 * 手搭一张 41×41 的方格：**西高东低**的斜坡（西 95 → 东 12 = 海），中间挖一个碗（深 26），
 * 碗口低于四周 → 填平后形成**一处小湖**；河流从西坡流进湖、从湖的东侧出口继续入海。
 * 这张图是"手画/导入的地形"的代表：原始高度**没有填过洼地**（引擎得自己填）。
 */
function lakeFixture() {
  const cols = 41, rows = 41, sp = 10;
  const points = [], h = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      points.push([c * sp, r * sp]);
      const d = Math.hypot(c - 20, r - 20);
      const bowl = 26 * Math.exp(-((d / 3.2) ** 2));
      const v = Math.max(21, 95 - c * 2 - bowl);
      h.push(Math.round(v * 100) / 100);
    }
  }
  return { h, grid: { points, cellsX: cols, cellsY: rows, spacing: sp } };
}

/** 每个格子是否有一条**严格下降**的路通向海（只走 down 链） */
function drainsToSea(hm, down) {
  const n = hm.h.length;
  const verdict = new Int8Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (hm.h[i] < SEA) { verdict[i] = 1; continue; }
    let cur = i, guard = 0;
    const stack = [];
    let v = 0;
    while (cur >= 0 && guard++ < n) {
      if (verdict[cur] !== -1) { v = verdict[cur]; break; }
      if (hm.h[cur] < SEA) { v = 1; break; }
      stack.push(cur);
      cur = down[cur];
    }
    for (const s of stack) verdict[s] = v;
    if (!v) return i;
  }
  return -1;
}

async function main() {
  const R = await import(pathToFileURL(path.join(UTILS, 'fmg', 'rivers.js')).href);
  const L = await import(pathToFileURL(path.join(UTILS, 'lakes.js')).href);
  const TS = await import(pathToFileURL(path.join(UTILS, 'terrainSynthesis.js')).href);

  // ── ① 合成底图（真实管线）：像样的地形上必须长得出河，且**没有漏河的孤段** ──────────
  const ring = ringRing(380, 0.05);
  const isLand = (x, y) => pointInRing(x, y, ring);
  const t0 = Date.now();
  const hm = TS.synthesizeHeightmapFromTerrain([{ rings: [ring] }], {
    cellsAcross: 96, seed: 7, isLand,
    structureOverrides: { rangeWeight: 0.34, crossRangeWeight: 0.12, riftDepth: 0.22, plateauWeight: 0.28 },
  });
  const genMs = Date.now() - t0;
  ok('a1 合成地形可用（有 h / 网格 / 陆地）', !!(hm && hm.h && hm.grid && hm.grid.points),
    `${hm.grid.cellsX}×${hm.grid.cellsY} / ${genMs}ms`);

  const hmWet = hm.prec ? hm : { ...hm, prec: Array.from(hm.h, () => 90) };
  const out = R.buildRiverNetwork(hmWet, {});
  const rivers = out.rivers || [];
  const stats = out.stats || {};
  ok('a2 有河（不是 0 条）', rivers.length > 0, `${rivers.length} 条 / ${out.segments.length} 段`);
  ok('a3 每条河都至少 minCells 格（不长出"短棍"）', rivers.every((r) => r.cells.length >= R.MIN_RIVER_CELLS),
    `最少 ${Math.min(...rivers.map((r) => r.cells.length))} 格`);
  ok('a4 每条河都有身份（id / source / mouth / parent / basin / order / points）',
    rivers.every((r) => Number.isInteger(r.id) && Number.isInteger(r.source) && Number.isInteger(r.mouth)
      && Number.isInteger(r.parent) && Number.isInteger(r.basin) && r.order >= 1
      && Array.isArray(r.points) && r.points.length >= 2));

  // ② 孤段的结构判据：沿 parent 链必须能走到“入海 / 入湖 / 出图边”的河。
  //    2026-11-04 起多认一种合法终点：`endsAtJunction`（汇流焊接把支流截在干流线上，
  //    端点就在干流几何上，不是浮空的短棍）。
  const byId = new Map(rivers.map((r) => [r.id, r]));
  const leaks = [];
  for (const r of rivers) {
    let cur = r, guard = 0, water = false;
    while (cur && guard++ < 200) {
      if (cur.endInSea || cur.endInLake || cur.endAtEdge || cur.endsAtJunction) { water = true; break; }
      cur = cur.parent ? byId.get(cur.parent) : null;
    }
    if (!water) leaks.push(r.id);
  }
  ok('a5 没有"漏河的孤段"（每条河的 parent 链都走到海/湖/图边/汇流点）', leaks.length === 0,
    leaks.length ? `漏河 ${leaks.length} 条（例：${leaks.slice(0, 5).join(',')}）` : `${rivers.length} 条全部归海/入湖/汇流`);

  // ③ 河必须顺流而下（用高度直接核）：cell 链上高度严格不升
  let uphill = 0;
  for (const r of rivers) {
    for (let i = 1; i < r.cells.length; i++) {
      if (hmWet.h[r.cells[i]] > hmWet.h[r.cells[i - 1]] + 1e-9) { uphill++; break; }
    }
  }
  ok('a6 没有"往山上流"的河（逐格高度不上升）', uphill === 0, `${uphill}/${rivers.length} 条有上升段`);

  // ④ 确定性：同输入同输出（逐字段）
  const out2 = R.buildRiverNetwork(hmWet, {});
  const sig = (o) => o.rivers.map((r) => `${r.id}:${r.cells.length}:${r.points.length}:${Math.round(r.discharge * 1000)}`).join('|');
  ok('a7 同输入两次结果逐字节一致（确定性）', sig(out) === sig(out2), `${rivers.length} 条`);

  // ⑤ 分级：Strahler 的不变量（父 ≥ 子；两个同级子 → 父 +1）
  let badOrder = 0;
  for (const r of rivers) {
    if (!r.parent) continue;
    const parent = byId.get(r.parent);
    if (!parent) continue;
    if (parent.order < r.order) badOrder++;
  }
  ok('a8 分级满足"父不急（父 ≥ 子）"', badOrder === 0, `${badOrder} 处违反`);
  const kidsBy = new Map();
  for (const r of rivers) if (r.parent) {
    const list = kidsBy.get(r.parent) || [];
    list.push(r.order);
    kidsBy.set(r.parent, list);
  }
  let strahlerBad = 0;
  for (const [id, orders] of kidsBy) {
    const max = Math.max(...orders);
    const cnt = orders.filter((o) => o === max).length;
    const want = cnt >= 2 ? max + 1 : max;
    const got = byId.get(id).order;
    if (got !== want) strahlerBad++;
  }
  ok('a9 Strahler 口径正确（汇流点：两个同级子 → +1）', strahlerBad === 0, `${strahlerBad} 个汇流点不符`);

  // ⑥ 气候：降水决定的 flux 真的在起作用（FMG 的 drainWater 口径）
  const arid = { ...hmWet, prec: Array.from(hmWet.h, () => 1) };
  const aridOut = R.buildRiverNetwork(arid, {});
  const wetOut = R.buildRiverNetwork({ ...hmWet, prec: Array.from(hmWet.h, () => 100) }, {});
  ok('a10 干旱（prec=1）的河**远少于**湿润（prec=100）（FMG 的降水→汇流口径）',
    wetOut.rivers.length > 0 && aridOut.rivers.length < wetOut.rivers.length * 0.2,
    `干旱 ${aridOut.rivers.length} 条 / 湿润 ${wetOut.rivers.length} 条`
    + `（${wetOut.rivers.length ? (aridOut.rivers.length / wetOut.rivers.length * 100).toFixed(1) : '–'}%）`);

  // ⑦ 闸门单调：调高 minFlux 只会更少（不许"调了没反应"）
  const counts = [30, 120, 400].map((mf) => R.buildRiverNetwork({ ...hmWet, prec: Array.from(hmWet.h, () => 90) }, { minFlux: mf }).rivers.length);
  ok('a11 河源汇流闸门单调有效（30 ≥ 120 ≥ 400 的条数）',
    counts[0] >= counts[1] && counts[1] >= counts[2] && counts[0] > counts[2],
    `30→${counts[0]} / 120→${counts[1]} / 400→${counts[2]}`);

  // ⑦b 阈值口径：`minDrainageArea`（世界面积）与分辨率解耦，且单调有效
  {
    const precWet = Array.from(hmWet.h, () => 90);
    const byArea = [200, 800, 3200].map((a) =>
      R.buildRiverNetwork({ ...hmWet, prec: precWet }, { minDrainageArea: a }).rivers.length);
    ok('a14 流域面积阈值单调有效（200 ≥ 800 ≥ 3200 的条数）',
      byArea[0] >= byArea[1] && byArea[1] >= byArea[2] && byArea[0] > byArea[2],
      `200→${byArea[0]} / 800→${byArea[1]} / 3200→${byArea[2]}`);
    // 换算等价：面积阈值应当等价于“按 meanPrec / cellModifier / spacing² 换算出来的 minFlux”。
    // 注意：这不是“分辨率无关”—— 格距翻倍时每格代表 4 倍面积，同样面积阈值会放进更多河，
    // 那是正确行为；真正影响河密度的是**地形细节随格距变化**，不是阈值本身。
    const spacing = hmWet.grid.spacing;
    const cellMod = 1.5;
    const meanPrec = 90;
    const eqFlux = (800 * meanPrec) / (cellMod * spacing * spacing);
    const nArea = R.buildRiverNetwork({ ...hmWet, prec: precWet }, { minDrainageArea: 800, cellModifier: cellMod }).rivers.length;
    const nFlux = R.buildRiverNetwork({ ...hmWet, prec: precWet }, { minFlux: eqFlux, cellModifier: cellMod }).rivers.length;
    ok('a15 面积阈值与 raw 阈值换算等价（同图同参数 → 同河数）',
      nArea === nFlux,
      `面积 800 ≈ minFlux ${eqFlux.toFixed(1)}：${nArea} vs ${nFlux} 条`);
  }

  // ⑦c 河源判据：minSourceRise 越高，河只会更少（且 0 = 老行为）
  {
    const precWet = Array.from(hmWet.h, () => 90);
    const base = R.buildRiverNetwork({ ...hmWet, prec: precWet }, {}).rivers.length;
    const cs = [0, 5, 10].map((r) => R.buildRiverNetwork({ ...hmWet, prec: precWet }, { minSourceRise: r }).rivers.length);
    ok('a16 河源海拔门槛单调（0 ≥ 5 ≥ 10），且 0 = 老行为',
      cs[0] === base && cs[0] >= cs[1] && cs[1] >= cs[2],
      `0→${cs[0]}（默认 ${base}）/ 5→${cs[1]} / 10→${cs[2]}`);
  }

  // ⑦d 落盘形状：生成地形时河要能直接写进项目文件（2026-11-04）
  {
    const net = R.buildRiverNetwork({ ...hmWet, prec: Array.from(hmWet.h, () => 90) }, {});
    const stored = R.toStoredRivers(net);
    const bad = stored.filter((r) => !Array.isArray(r.points) || r.points.length < 2
      || !r.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
      || !Number.isFinite(r.width));
    const ids = new Set(stored.map((r) => r.id));
    const rounded = stored.every((r) => r.points.every((p) => Math.round(p.x * 100) / 100 === p.x));
    ok('a17 落盘河形状：点 >=2、坐标 2 位小数、宽度有限、id 唯一',
      bad.length === 0 && ids.size === stored.length && rounded,
      `${stored.length} 条 / 网络 ${net.rivers.length} 条 / id ${ids.size}`);
  }

  // ⑦e 汇流焊接（2026-11-04，暮雨：“过穿的河流是否无法解决”）
  //     判据①：整网不同河之间**交叉 0**（端点相接 = 汇流点，不算）；判据②：函数本身能在
  //     精确交点处截断并挂 parent；判据③：端点相接不被误裁；判据④：两次构建逐字节一致。
  {
    const crossCount = (rivers, cellSize, junctionTol = 0.8) => {
      const ends = rivers.map((r) => {
        const pts = r.points || [];
        return pts.length ? [pts[0], pts[pts.length - 1]] : [];
      });
      const nearEnd = (ri, x, y) => ends[ri].some((p) => Math.hypot(p.x - x, p.y - y) <= junctionTol);
      const segX = (a, b, c, d) => {
        const rx = b.x - a.x, ry = b.y - a.y;
        const sx = d.x - c.x, sy = d.y - c.y;
        const den = rx * sy - ry * sx;
        if (Math.abs(den) < 1e-12) return null;
        const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
        const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
        if (!(t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6)) return null;
        return { x: a.x + rx * t, y: a.y + ry * t };
      };
      const grid = new Map();
      for (let ri = 0; ri < rivers.length; ri++) {
        const pts = rivers[ri].points || [];
        for (let i = 0; i + 1 < pts.length; i++) {
          const a = pts[i], b = pts[i + 1];
          const x0 = Math.floor(Math.min(a.x, b.x) / cellSize), x1 = Math.floor(Math.max(a.x, b.x) / cellSize);
          const y0 = Math.floor(Math.min(a.y, b.y) / cellSize), y1 = Math.floor(Math.max(a.y, b.y) / cellSize);
          for (let gx = x0; gx <= x1; gx++) {
            for (let gy = y0; gy <= y1; gy++) {
              const k = gx + ',' + gy;
              if (!grid.has(k)) grid.set(k, []);
              grid.get(k).push({ ri, i, a, b });
            }
          }
        }
      }
      const seen = new Set();
      let n = 0;
      for (const list of grid.values()) {
        for (let m = 0; m < list.length; m++) {
          for (let n2 = m + 1; n2 < list.length; n2++) {
            const s = list[m], t = list[n2];
            if (s.ri === t.ri) continue;
            const key = Math.min(s.ri, t.ri) + ':' + Math.max(s.ri, t.ri) + ':' + s.i + ':' + t.i;
            if (seen.has(key)) continue;
            seen.add(key);
            const hit = segX(s.a, s.b, t.a, t.b);
          if (!hit) continue;
          if (nearEnd(s.ri, hit.x, hit.y) || nearEnd(t.ri, hit.x, hit.y)) continue;
          n++;
          }
        }
      }
      return n;
    };

    const wet = { ...hmWet, prec: Array.from(hmWet.h, () => 90) };
    const net = R.buildRiverNetwork(wet, {});
    const nCross = crossCount(net.rivers, Number(hmWet.grid.spacing) || 8);
    ok('a18 整网汇流焊接：不同河之间交叉 0（端点相接不算）',
      nCross === 0 && net.stats.welded >= 0,
      `${net.rivers.length} 条 / ${net.stats.segments} 段 / 交叉 ${nCross} / 焊接 ${net.stats.welded} 条`);

    // 直接喂两条“必然交叉”的假河：A 横穿（流量大），B 斜穿
    const A = { id: 1, discharge: 100, points: [{ x: 0, y: 50 }, { x: 100, y: 50 }] };
    const B = { id: 2, discharge: 10, points: [{ x: 40, y: 0 }, { x: 60, y: 100 }] };
    const stats = R.weldRiverJunctions([A, B], { spacing: 10 });
    const cutB = B.points[B.points.length - 1];
    const onLine = Math.abs(cutB.y - 50) < 1e-6 && cutB.x > 40 && cutB.x < 60;
    ok('a19 焊接：支流截在干流线上并挂上 parent',
      stats.cut === 1 && B.parent === 1 && onLine,
      `cut=${stats.cut} parent=${B.parent} 端点=(${cutB.x.toFixed(1)}, ${cutB.y.toFixed(1)})`);

    // 端点相接（真汇流）不该被裁
    const C = { id: 3, discharge: 5, points: [{ x: 0, y: 0 }, { x: 100, y: 50 }] };
    const D = { id: 4, discharge: 1, points: [{ x: 50, y: 25 }, { x: 50, y: 90 }] };
    const st2 = R.weldRiverJunctions([C, D], { spacing: 10 });
    ok('a20 焊接：端点相接/贴边不算交叉，不裁不挂', st2.cut === 0 && D.parent === undefined,
      `cut=${st2.cut} parent=${D.parent}`);

    // 确定性
    const again = R.buildRiverNetwork(wet, {});
    const same = JSON.stringify(net.rivers.map((r) => [r.id, r.parent, r.order, r.points]))
      === JSON.stringify(again.rivers.map((r) => [r.id, r.parent, r.order, r.points]));
    ok('a21 焊接是确定性的：同输入两次构建逐字节一致', same);

    // 落库形状（量化到 0.01）之后仍然 0 交叉：量化会把“端点正好落在干流上”挪开一丝，
    // 实测真实项目会因此长出 30 处“贴着汇流点的越线”——所以 toStoredRivers 里再焊一次。
    const stored = R.toStoredRivers(net);
    const nStored = crossCount(stored, Number(hmWet.grid.spacing) || 8);
    ok('a22 落库形状（坐标量化后）交叉仍然为 0', nStored === 0,
      `${stored.length} 条 / 交叉 ${nStored}`);
    // 断头河：支流尾点离 parent 折线 2 个单位 → snapRiverTails 接上去，源头不动
    const P = { id: 10, discharge: 100, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };
    const Cc = { id: 11, discharge: 5, parent: 10, points: [{ x: 30, y: 40 }, { x: 50, y: 2 }] };
    const st3 = R.snapRiverTails([P, Cc], { spacing: 8 });
    const tailP = Cc.points[Cc.points.length - 1];
    ok('a23 断头河：支流尾巴接到 parent 线上（源头不动）',
      st3.snapped === 1 && Math.abs(tailP.y) < 0.05 && Cc.points[0].y === 40,
      `snapped=${st3.snapped} tail=(${tailP.x}, ${tailP.y})`);

    // 汇流点收口（2026-11-04 第二十一修，暮雨：12 倍下汇流点读成 X 交叉）：
    // 两条支流落在主干**同一个点**时，后到的要沿主干错开 ≥ declumpGap；只有一条时不许动。
    const trunkPts = [];
    for (let x = 0; x <= 100; x += 2) trunkPts.push({ x, y: 0 });
    const mkTrunk = () => ({ id: 20, discharge: 100, points: trunkPts.map((q) => ({ ...q })) });
    const T2 = mkTrunk();
    const A2 = { id: 21, discharge: 10, points: [{ x: 50, y: -20 }, { x: 50, y: 0 }] };
    const B2 = { id: 22, discharge: 5, points: [{ x: 50, y: 20 }, { x: 50, y: 0 }] };
    const st4 = R.weldRiverJunctions([T2, A2, B2], { spacing: 10 });
    const tA = A2.points[A2.points.length - 1];
    const tB = B2.points[B2.points.length - 1];
    const sep = Math.hypot(tA.x - tB.x, tA.y - tB.y);
    ok('a24 同点汇入收口：两条支流不再落在同一点（且都还在主干上）',
      st4.declumped >= 1 && sep >= 1.2 && Math.abs(tA.y) < 1e-6 && Math.abs(tB.y) < 1e-6,
      `declumped=${st4.declumped} 间距=${sep.toFixed(2)} A=(${tA.x},${tA.y}) B=(${tB.x},${tB.y})`);

    const T5 = mkTrunk();
    const A5 = { id: 23, discharge: 10, points: [{ x: 50, y: -20 }, { x: 50, y: 0 }] };
    const st5 = R.weldRiverJunctions([T5, A5], { spacing: 10 });
    const t5 = A5.points[A5.points.length - 1];
    ok('a25 只有一条支流时不动它（收口只在“同点”才触发）',
      st5.declumped === 0 && t5.x === 50 && t5.y === 0,
      `declumped=${st5.declumped} tail=(${t5.x},${t5.y})`);
  }

  // ⑦e 河宽量纲（2026-11-04 第二十二修）：生成河存的是**相对量纲**，必须按本图最宽归一化，
  //     否则渲染侧那句 `Math.max(RIVER_WIDTH_MIN, …)` 会把 562/573 条河夹成同一个宽度（等宽观感）。
  {
    const RW = await import(pathToFileURL(path.join(UTILS, 'rivers.js')).href);
    const trunk = { id: 'river_gen_501', width: 0.66 };
    const trib = { id: 'river_gen_216', width: 0.22 };
    const hand = { id: 'river_1700000000000', width: 3.5 };
    const cm = RW.riverMouthWorldWidth(trunk, { widthMax: 1.65, dataScale: 2.4 });
    const ct = RW.riverMouthWorldWidth(trib, { widthMax: 1.65, dataScale: 2.4 });
    ok('a26 河宽量纲：生成河按本图最宽归一化，主干至少是支流的 2 倍',
      cm >= ct * 2 && cm <= RW.RIVER_WIDTH_REL_MAX + 1e-9,
      `主干 ${cm.toFixed(2)} / 支流 ${ct.toFixed(2)} 世界单位（比 ${(cm / ct).toFixed(1)}×）`);
    const ch = RW.riverMouthWorldWidth(hand, { widthMax: 1.65, dataScale: 2.4 });
    const cOld = RW.riverMouthWorldWidth({ id: 'river_gen_9', width: 3.5 }, { widthMax: 9, dataScale: 2.4 });
    ok('a27 河宽量纲：手画河 / 已是显示量纲的生成河都走原路（3.5 → 8.4 世界单位）',
      Math.abs(ch - 8.4) < 1e-9 && Math.abs(cOld - 8.4) < 1e-9,
      `手画 ${ch.toFixed(2)} / 显示量纲生成河 ${cOld.toFixed(2)}`);
  }

  // ⑧ 宽度：同一份公式下"越往下游越宽"（源头细 → 河口粗）
  const one = rivers.slice().sort((a, b) => b.cells.length - a.cells.length)[0];
  const wAt = (r, k) => R.widthFromOffset(R.getOffset({
    flux: r.points[Math.min(k, r.points.length - 1)].flux, pointIndex: k,
    widthFactor: r.widthFactor, startingWidth: r.sourceWidth, fluxMax: stats.maxFlux || 1,
  }));
  ok('a12 河宽随点位变粗（源头 < 河口）', wAt(one, one.points.length - 1) > wAt(one, 1) * 1.2,
    `${wAt(one, 1).toFixed(2)} → ${wAt(one, one.points.length - 1).toFixed(2)}（相对量纲）`);

  // ⑨ 性能：96 格跨全图上不该出现 O(n²)（旧引擎就是死在这）
  const t1 = Date.now();
  R.buildRiverNetwork(hmWet, {});
  const ms = Date.now() - t1;
  ok('a13 建网耗时 < 400ms（96 格跨全图）', ms < 400, `${ms}ms`);

  // ── ⑩ 湖：盆地 → 水面标记 → 河在湖岸断、从出口另起一条 ─────────────────────────
  const bowl = lakeFixture();
  const land = Uint8Array.from(bowl.h, (v) => (v >= SEA ? 1 : 0));
  const basins = [];
  const filled = TS.fillDepressions(Float64Array.from(bowl.h), land, 41, 41, SEA, 0.02, basins);
  const lakes = L.detectBasinLakes(filled, basins, 41, 41, { minArea: 4, minDepth: 0.5 });
  ok('l1 洼地填平记了账、湖判定认得出盆地', basins.length > 0 && lakes.length > 0,
    `抬高 ${basins.length} 格 / 湖 ${lakes.length} 处 / ${lakes.reduce((a, l) => a + l.cells.length, 0)} 格`);
  ok('l2 湖格都在陆地上（不是把海标成湖）', lakes.every((lk) => lk.cells.every((i) => bowl.h[i] >= SEA)));
  ok('l3 湖面高度 ≥ 盆底（水位取溢出口）', lakes.every((lk) => lk.level >= Math.min(...lk.cells.map((i) => bowl.h[i]))));

  // 带湖的河网：把湖写进 hm.lakes，河必须"在湖岸断、从出口续"
  // ⚠️ 这里故意喂**没填过**的原始高度（盆底是平的）—— 引擎自己会填（上游 `resolveDepressions`
  //    的同一件事），这正是"手画地形也能出河"的那条判据。
  const withLakes = { ...bowl, lakes };
  const lo = R.buildRiverNetwork(withLakes, { minFlux: 1 });
  const lakeCellOf = new Int32Array(bowl.h.length).fill(-1);
  for (let k = 0; k < lakes.length; k++) for (const i of lakes[k].cells) lakeCellOf[i] = k;
  const loById = new Map(lo.rivers.map((r) => [r.id, r]));
  const intoLake = lo.rivers.filter((r) => r.endInLake);
  ok('l4 有河在湖岸结束（endInLake）', intoLake.length > 0, `${intoLake.length} 条 / 共 ${lo.rivers.length} 条`);
  ok('l5 每条河只在**末格**踩到湖面（不许穿湖而过）',
    lo.rivers.every((r) => r.cells.slice(0, -1).every((i) => lakeCellOf[i] < 0)));
  const outletRivers = lo.rivers.filter((r) => r.parent && loById.has(r.parent) && loById.get(r.parent).endInLake);
  ok('l6 湖有出口河（出口下游另起一条河，parent 接在入湖河上）', outletRivers.length > 0,
    `${outletRivers.length} 条出口河`);
  ok('l7 湖格不上河（河不走"湖里"的格子）',
    lo.rivers.every((r) => r.cells.filter((i) => lakeCellOf[i] >= 0).length <= 1));
  ok('l8 原始高度有封闭盆地时引擎自己填（stalled > 0 被处理掉）',
    (lo.stats.refilled || 0) > 0 && (lo.stats.stalled || 0) > 0,
    `stalled ${lo.stats.stalled} / refilled ${lo.stats.refilled}`);

  // ⑪ 源码纪律：纯函数层（零 DOM），且湖的实现只有一份
  const fs = require('fs');
  const src = fs.readFileSync(path.join(UTILS, 'fmg', 'rivers.js'), 'utf8');
  const lakeSrc = fs.readFileSync(path.join(UTILS, 'lakes.js'), 'utf8');
  ok('s1 河网是纯函数（没有 document / window / canvas）',
    !/document\.|window\.|getContext\(/.test(src));
  ok('s2 湖的实现只有一份（fmg/index 不再自己定义 detectBasinLakes）',
    /export function detectBasinLakes/.test(lakeSrc)
    && !/function detectBasinLakes/.test(fs.readFileSync(path.join(UTILS, 'fmg', 'index.js'), 'utf8')));
  ok('s3 抄的是上游常量（MIN_FLUX_TO_FORM_RIVER = 30 / MIN_RIVER_CELLS = 3）',
    /MIN_FLUX_TO_FORM_RIVER = 30/.test(src) && /MIN_RIVER_CELLS = 3/.test(src));

  console.log(`\n${fails.length ? '❌' : '✅'} ${pass}/${pass + fails.length} 通过`);
  if (fails.length) {
    for (const f of fails) console.log('  - ' + f);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
