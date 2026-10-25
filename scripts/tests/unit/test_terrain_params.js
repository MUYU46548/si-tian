#!/usr/bin/env node
/**
 * Node 单元测试：**地形生成参数模型**（src/renderer/src/utils/terrainParams.js）
 *              + 推演参数注入（terrainSynthesis.js）
 *              + 气候输入（heightMath.js buildClimateInputs，P0-3）
 *
 * 这一层守的是 P0 的三条硬承诺（暮雨 2026-10-25 拍板）：
 *   ① **同 seed + 同参数 = 同结果**（可复现；候选/应用/重算三处必须一致）；
 *   ② **默认参数 = 0.4.0 旧行为逐字节不变** —— 用改版前抓的 sha256 黄金值守。
 *      没有这条，"参数化"就可能顺手改掉所有既有底图的地形，而且没人会发现；
 *   ③ **气候不再由高度单独决定**（纬度/离岸距离真的进了派生），且**重复派生结果一致**。
 *
 * 为什么黄金值写死在用例里而不是每次现算：现算只能证明"实现稳定"，证明不了
 * "与上一版一致" —— 后者才是这次重构的风险所在（默认值乘 1.0 是否真的等价）。
 *
 * 用法：node scripts/tests/unit/test_terrain_params.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const DEPS = ['terrainSynthesis.js', 'terrainParams.js', 'heightMath.js'];

/** 0.4.0（v0.4.0 = c1e5e77）实测黄金值：改版前用同一构造抓的 sha256 */
const GOLDEN = {
  7: { sha: '98a3cb7e0971820c84d8fd6924ea9e63c94da4a34bf5e1beb711e1a9e9e332e7', cells: 7081, axis: 53 },
  11: { sha: '50082df701ef4535bade11889c7f62ae040d14724140c2b448519f905cfde417', cells: 7081, axis: 21 },
  23: { sha: '1688350ab23ad58df82c850d77989c6e089d738a63226f0e9f254672db42fe19', cells: 7081, axis: 169 },
};

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

// ── 与 test_terrain_structure.js / test_109 同形的带波瓣陆地（不换构造，黄金值才有意义）──
function makeLandRing(cx, cy, r, seed) {
  const pts = [];
  const N = 120;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const w = 1 + Math.sin(a * 3 + seed) * 0.16 + Math.sin(a * 7 + seed * 2) * 0.08;
    pts.push({ x: cx + Math.cos(a) * r * w, y: cy + Math.sin(a) * r * w * 0.72 });
  }
  return pts;
}
function makeInside(ring) {
  return (x, y) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i].x, yi = ring[i].y, xj = ring[j].x, yj = ring[j].y;
      if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) c = !c;
    }
    return c;
  };
}
function shaOfH(h) {
  return createHash('sha256').update(Float64Array.from(h)).digest('hex');
}

async function main() {
  const root = (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Temp')) || os.tmpdir();
  const tmp = fs.mkdtempSync(path.join(root, 'sitian-tparams-'));
  const fixExt = (src) => src.replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
  for (const f of DEPS) {
    fs.writeFileSync(path.join(tmp, f), fixExt(fs.readFileSync(path.join(SRC_DIR, f), 'utf8')));
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const TS = await import(pathToFileURL(path.join(tmp, 'terrainSynthesis.js')).href);
  const P = await import(pathToFileURL(path.join(tmp, 'terrainParams.js')).href);
  const HM = await import(pathToFileURL(path.join(tmp, 'heightMath.js')).href);

  const ring = makeLandRing(0, 0, 900, 1.2);
  const inside = makeInside(ring);
  const terrain = [{ rings: [ring] }];
  const synOpts = (params) => P.toSynthesisOptions(params, { isLand: inside });

  // ══════════════════════════════════════════════════════════════════════
  // 一、参数模型：默认值 / 夹取 / 留痕 / 稳定性
  // ══════════════════════════════════════════════════════════════════════
  check('a1 默认参数：每个字段都有值且在范围内，且与 TERRAIN_STRUCTURE 的原始常量一致', () => {
    const p = P.normalizeTerrainParams({}).params;
    for (const f of P.TERRAIN_PARAM_FIELDS) {
      assert(f.key in p, `字段 ${f.key} 归一化后缺失`);
      if (p[f.key] === null) continue;
      if (f.kind === 'choice') {
        assert(f.options.includes(p[f.key]), `${f.key}=${p[f.key]} 不在档位 ${f.options}`);
        continue;
      }
      assert(p[f.key] >= f.min && p[f.key] <= f.max, `${f.key}=${p[f.key]} 越界 [${f.min},${f.max}]`);
    }
    assert(p.riftDepth === TS.TERRAIN_STRUCTURE.riftDepth,
      `riftDepth 默认 ${p.riftDepth} ≠ TERRAIN_STRUCTURE ${TS.TERRAIN_STRUCTURE.riftDepth}`);
    assert(p.cellsAcross === 96, `cellsAcross 默认 ${p.cellsAcross} ≠ 96（0.4.0 旧口径）`);
    assert(p.rangeAxisDeg === null, 'rangeAxisDeg 默认应为 null（随种子）');
    return `${Object.keys(p).length} 个字段`;
  });

  check('a2 越界/非数字：夹取或回默认值，并且**每一项都留 warning**', () => {
    const { params, warnings } = P.normalizeTerrainParams({
      seed: 12e9, relief: 'abc', mountainStrength: 99, plateauStrength: -5,
      riftDepth: 0.123456, cellsAcross: 100, rangeAxisDeg: 999, latitudeSpanDeg: 30,
    });
    const keys = new Set(warnings.map((w) => w.key));
    for (const k of ['seed', 'relief', 'mountainStrength', 'plateauStrength', 'riftDepth', 'cellsAcross', 'rangeAxisDeg', 'latitudeSpanDeg']) {
      assert(keys.has(k), `${k} 被改了却没进 warnings（静默改动 = 用户以为参数生效了）`);
    }
    assert(params.seed === 999999, `seed 上界夹取失败：${params.seed}`);
    assert(params.relief === 1, `relief 非数字应回默认 1，实际 ${params.relief}`);
    assert(params.mountainStrength === 1.6, `mountainStrength 上界夹取失败：${params.mountainStrength}`);
    assert(params.plateauStrength === 0, `plateauStrength 下界夹取失败：${params.plateauStrength}`);
    assert(params.cellsAcross === 96, `cellsAcross 100 应吸到最近档 96，实际 ${params.cellsAcross}`);
    assert(params.rangeAxisDeg === 179, `rangeAxisDeg 上界夹取失败：${params.rangeAxisDeg}`);
    assert(params.riftDepth === 0.12, `riftDepth 0.123456 应按 step 0.01 对齐到 0.12，实际 ${params.riftDepth}`);
    return `${warnings.length} 条 warning`;
  });

  check('a3 参数 key：同参数同 key（字段顺序无关），改一个值 key 必变', () => {
    const k1 = P.terrainParamsKey({ seed: 7, relief: 1 });
    const k2 = P.terrainParamsKey({ relief: 1.0, seed: 7, extra: 'ignored' });
    assert(k1 === k2, `同参数 key 不同：\n${k1}\n${k2}`);
    assert(k1 !== P.terrainParamsKey({ seed: 8, relief: 1 }), '换 seed 后 key 没变');
    return k1.slice(0, 48) + '…';
  });

  check('a4 候选种子：确定性、互不相同、且不与基准相同（预览三张不能重复）', () => {
    for (const seed of [0, 7, 23, 999999]) {
      const s0 = P.candidateSeed(seed, 0);
      const s1 = P.candidateSeed(seed, 1);
      const s2 = P.candidateSeed(seed, 2);
      assert(s0 === seed, `候选 0 应等于基准种子：${s0} vs ${seed}`);
      assert(new Set([s0, s1, s2]).size === 3, `seed=${seed} 三个候选种子有重复：${[s0, s1, s2]}`);
      assert(P.candidateSeed(seed, 2) === s2, `seed=${seed} 候选种子不确定`);
    }
    const r1 = P.rollSeed(7);
    const r2 = P.rollSeed(r1);
    assert(r1 !== 7 && r2 !== r1, `🎲 换种子没有推进：7→${r1}→${r2}`);
    assert(P.rollSeed(7) === r1, '🎲 不确定（同输入两次不同）');
    return `7→${r1}→${r2}`;
  });

  check('a5 参数映射：默认值必须等于「原常量 × 1.0」（山脉/高原/裂谷三处）', () => {
    const o = P.toSynthesisOptions(P.DEFAULT_TERRAIN_PARAMS);
    const st = TS.TERRAIN_STRUCTURE;
    assert(o.structureOverrides.rangeWeight === st.rangeWeight, 'rangeWeight 默认 ≠ 原常量');
    assert(o.structureOverrides.crossRangeWeight === st.crossRangeWeight, 'crossRangeWeight 默认 ≠ 原常量');
    assert(o.structureOverrides.plateauWeight === st.plateauWeight, 'plateauWeight 默认 ≠ 原常量');
    assert(o.structureOverrides.riftDepth === st.riftDepth, 'riftDepth 默认 ≠ 原常量');
    assert(o.rangeAxisDeg === undefined, 'rangeAxisDeg=null 时不该传值（否则推演不会回落到随种子）');
    const forced = P.toSynthesisOptions({ ...P.DEFAULT_TERRAIN_PARAMS, rangeAxisDeg: 42 });
    assert(forced.rangeAxisDeg === 42, '强制走向没传出去');
    return `主脊 ${o.structureOverrides.rangeWeight} / 高原 ${o.structureOverrides.plateauWeight}`;
  });

  // ══════════════════════════════════════════════════════════════════════
  // 二、推演：黄金基线 + 可复现 + 参数真的改变地形
  // ══════════════════════════════════════════════════════════════════════
  check('b1 黄金基线：默认参数跑出来的 h 与 0.4.0 逐字节一致（三个种子）', () => {
    for (const seed of Object.keys(GOLDEN).map(Number)) {
      const g = GOLDEN[seed];
      const syn = TS.synthesizeHeightmapFromTerrain(terrain, synOpts({ ...P.DEFAULT_TERRAIN_PARAMS, seed }));
      assert(syn, `seed=${seed} 推演返回 null`);
      const sha = shaOfH(syn.h);
      assert(sha === g.sha, `seed=${seed} 默认参数已改变地形！\n  期望 ${g.sha}\n  实际 ${sha}`);
      assert(syn.cellCount === g.cells, `seed=${seed} 格数 ${syn.cellCount} ≠ ${g.cells}`);
      assert(syn.structure.rangeAxisDeg === g.axis, `seed=${seed} 走向 ${syn.structure.rangeAxisDeg}° ≠ ${g.axis}°`);
    }
    return Object.keys(GOLDEN).map((s) => `${s}:${GOLDEN[s].sha.slice(0, 8)}`).join(' / ');
  });

  check('b2 可复现：同 seed + 同参数两次逐值相同；换 seed 至少 20% 的格不同', () => {
    const opts = synOpts({ ...P.DEFAULT_TERRAIN_PARAMS, seed: 7, relief: 1.2, mountainStrength: 1.3 });
    const a = TS.synthesizeHeightmapFromTerrain(terrain, opts);
    const b = TS.synthesizeHeightmapFromTerrain(terrain, opts);
    for (let i = 0; i < a.h.length; i++) assert(a.h[i] === b.h[i], `第 ${i} 格不同：${a.h[i]} vs ${b.h[i]}`);
    const c = TS.synthesizeHeightmapFromTerrain(terrain, synOpts({ ...P.DEFAULT_TERRAIN_PARAMS, seed: 23, relief: 1.2, mountainStrength: 1.3 }));
    let diff = 0;
    for (let i = 0; i < a.h.length; i++) if (a.h[i] !== c.h[i]) diff++;
    assert(diff > a.h.length * 0.2, `换 seed 只有 ${diff}/${a.h.length} 格不同 —— seed 没起作用`);
    return `差 ${(diff / a.h.length * 100).toFixed(0)}%`;
  });

  check('b3 参数有判别力：山脉强度↑ → 高频残差更大；裂谷深度 0 → 走廊不再下切', () => {
    const base = { ...P.DEFAULT_TERRAIN_PARAMS, seed: 7 };
    const weak = TS.synthesizeHeightmapFromTerrain(terrain, synOpts({ ...base, mountainStrength: 0 }));
    const strong = TS.synthesizeHeightmapFromTerrain(terrain, synOpts({ ...base, mountainStrength: 1.6 }));
    const hp = (syn) => {
      // 高频残差 = h − 自身 3×3 均值（只取陆地）
      const { cellsX: cols, cellsY: rows } = syn.grid;
      let sum = 0, n = 0;
      for (let j = 1; j < rows - 1; j++) {
        for (let i = 1; i < cols - 1; i++) {
          const idx = j * cols + i;
          const h = syn.h[idx];
          if (h < 20) continue;
          let m = 0;
          for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) m += syn.h[(j + dj) * cols + (i + di)];
          sum += Math.abs(h - m / 9); n++;
        }
      }
      return sum / Math.max(1, n);
    };
    const w = hp(weak), s = hp(strong);
    assert(s > w * 1.15, `山脉强度 1.6 的高频残差 ${s.toFixed(2)} 未显著高于 0 的 ${w.toFixed(2)}`);

    const noRift = TS.synthesizeHeightmapFromTerrain(terrain, synOpts({ ...base, riftDepth: 0 }));
    const rifts = TS.makeRiftSegments(7, 53, 0.72);
    const segDist = (px, py, ax, ay, bx, by) => {
      const dx = bx - ax, dy = by - ay;
      const L2 = dx * dx + dy * dy;
      let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    };
    const corridorMean = (syn) => {
      const { cellsX: cols, cellsY: rows } = syn.grid;
      let sum = 0, n = 0;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const idx = j * cols + i;
          if (syn.h[idx] < 20) continue;
          const ny = j / cols;
          let best = Infinity;
          for (const rf of rifts) best = Math.min(best, segDist(i / cols, ny, rf.ax, rf.ay, rf.bx, rf.by));
          if (best < 0.03) { sum += syn.h[idx]; n++; }
        }
      }
      return sum / Math.max(1, n);
    };
    const withRift = TS.synthesizeHeightmapFromTerrain(terrain, synOpts(base));
    const a = corridorMean(withRift), b = corridorMean(noRift);
    assert(a < b - 1.0, `裂谷深度 0 后走廊均值只从 ${a.toFixed(2)} 变到 ${b.toFixed(2)}（应更低）`);
    return `残差 ${w.toFixed(2)}→${s.toFixed(2)}；走廊 ${a.toFixed(1)}→${b.toFixed(1)}`;
  });

  check('b4 精度：cellsAcross 64/96/160 得到不同格数，且都覆盖同一块陆地（没有算空）', () => {
    const cells = [64, 96, 160].map((n) => {
      const syn = TS.synthesizeHeightmapFromTerrain(terrain, synOpts({ ...P.DEFAULT_TERRAIN_PARAMS, cellsAcross: n }));
      assert(syn, `cellsAcross=${n} 返回 null`);
      assert(syn.landCells > 500, `cellsAcross=${n} 只有 ${syn.landCells} 个陆格`);
      return syn.cellCount;
    });
    assert(cells[0] < cells[1] && cells[1] < cells[2], `格数没有随精度上升：${cells.join(' / ')}`);
    return cells.join(' / ');
  });

  // ══════════════════════════════════════════════════════════════════════
  // 三、气候输入（P0-3）：纬度/离岸距离真的进去了，且可复现
  // ══════════════════════════════════════════════════════════════════════
  check('c1 气候输入：纬度北高南低（上为北）、海格 0 / 陆格随距离递增、重复调用一致', () => {
    const cols = 20, rows = 10, n = cols * rows;
    const h = new Array(n);
    const points = new Array(n);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const idx = j * cols + i;
        points[idx] = [i * 10, j * 10];
        h[idx] = i < 10 ? 10 : 40;          // 左半海 / 右半陆
      }
    }
    const grid = { points, cellsX: cols, cellsY: rows, spacing: 10 };
    const c = HM.buildClimateInputs(h, grid, { latitudeSpanDeg: 120 });
    assert(c.lat && c.ocean, `气候输入缺失：${JSON.stringify(c)}`);
    assert(Math.abs(c.lat[0] - 60) < 1e-6, `顶行纬度 ${c.lat[0]} ≠ +60`);
    assert(Math.abs(c.lat[n - 1] + 60) < 1e-6, `底行纬度 ${c.lat[n - 1]} ≠ −60`);
    assert(c.ocean[0] === 0, `海格离岸距离 ${c.ocean[0]} ≠ 0`);
    assert(c.ocean[cols - 1] > 0 && c.ocean[cols - 1] <= 10, `最远陆格距离异常：${c.ocean[cols - 1]}`);
    let mono = true;
    for (let i = 10; i < cols - 1; i++) if (c.ocean[i] > c.ocean[i + 1]) mono = false;
    assert(mono, '同一行陆格的离岸距离没有单调递增（BFS 方向错？）');
    const c2 = HM.buildClimateInputs(h, grid, { latitudeSpanDeg: 120 });
    for (let i = 0; i < n; i++) assert(c.lat[i] === c2.lat[i] && c.ocean[i] === c2.ocean[i], `第 ${i} 格气候输入不确定`);
    return `纬度 ±60° / 最远 ${c.ocean[cols - 1]} 格`;
  });

  check('c2 气候派生：同一高度、不同纬度 → 温度显著不同；靠海比内陆更湿', () => {
    const cols = 20, rows = 10, n = cols * rows;
    const h = new Array(n);
    const points = new Array(n);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const idx = j * cols + i;
        points[idx] = [i * 10, j * 10];
        h[idx] = i < 10 ? 10 : 40;
      }
    }
    const grid = { points, cellsX: cols, cellsY: rows, spacing: 10 };
    const c = HM.buildClimateInputs(h, grid, { latitudeSpanDeg: 120 });
    const derived = HM.deriveLayers(h, points, (_p, i) => c.lat[i], (_p, i) => c.ocean[i]);
    const topIdx = 0 * cols + 15;                 // 顶行（北）陆格
    const midIdx = 5 * cols + 15;                 // 中行（赤道）陆格
    const diff = derived.temperature[midIdx] - derived.temperature[topIdx];
    assert(diff > 25, `南北同高度温差只有 ${diff.toFixed(1)}°C —— 纬度没进派生`);
    const coast = 5 * cols + 10, inland = 5 * cols + 19;
    assert(derived.precipitation[coast] > derived.precipitation[inland],
      `靠海降水 ${derived.precipitation[coast]} 未高于内陆 ${derived.precipitation[inland]}`);
    const again = HM.deriveLayers(h, points, (_p, i) => c.lat[i], (_p, i) => c.ocean[i]);
    for (let i = 0; i < n; i++) assert(derived.biome[i] === again.biome[i], `第 ${i} 格群系不确定`);
    return `温差 ${diff.toFixed(0)}°C / 降水 ${derived.precipitation[coast]} vs ${derived.precipitation[inland]}`;
  });

  check('c3 气候派生：与旧的 null,null 口径必须不同（否则等于没接）', () => {
    const cols = 12, rows = 6, n = cols * rows;
    const h = new Array(n).fill(40);
    const points = new Array(n);
    for (let i = 0; i < n; i++) points[i] = [i % cols, Math.floor(i / cols)];
    h[0] = 10; // 一格海，保证有海岸
    const grid = { points, cellsX: cols, cellsY: rows, spacing: 1 };
    const c = HM.buildClimateInputs(h, grid, { latitudeSpanDeg: 120 });
    const withClimate = HM.deriveLayers(h, points, (_p, i) => c.lat[i], (_p, i) => c.ocean[i]);
    const legacy = HM.deriveLayers(h, points, null, null);
    let tempDiff = 0, precDiff = 0, biomeDiff = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(withClimate.temperature[i] - legacy.temperature[i]) > 1) tempDiff++;
      if (Math.abs(withClimate.precipitation[i] - legacy.precipitation[i]) > 1) precDiff++;
      if (withClimate.biome[i] !== legacy.biome[i]) biomeDiff++;
    }
    assert(tempDiff > n * 0.5, `温度与旧口径只有 ${tempDiff}/${n} 格不同 —— 纬度没生效`);
    assert(biomeDiff > 0, '群系与旧口径完全一样 —— 气候层没有改变结论');
    return `温度 ${tempDiff}/${n}、降水 ${precDiff}/${n}、群系 ${biomeDiff}/${n} 格不同`;
  });

  check('c4 确定性源码扫描：terrainParams / heightMath 里没有 Math.random（生成必须可复现）', () => {
    for (const f of ['terrainParams.js', 'heightMath.js']) {
      const raw = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
      // 去掉注释再扫 —— 注释里写「不许用 Math.random()」不算违规
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert(!/Math\.random\s*\(/.test(code), `${f} 里出现 Math.random —— 同参数将无法复现`);
    }
    return 'ok';
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  —— ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 清不掉就留着 */ }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('用例自身崩溃：', err);
  process.exit(1);
});
