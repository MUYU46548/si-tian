#!/usr/bin/env node
/**
 * Node 单元测试：**FMG 侵蚀层（N3b-1）** —— `src/renderer/src/utils/terrainErosion.js`
 *
 * 守的五件事（对应 `docs/plan/PLAN_AUDIT_20261030.md` N3b-1 的判据）：
 *   ① **确定性**：同 seed 两次 → 高度数组哈希逐字节一致（没有 Math.random，顺序全确定）；
 *   ② **不断头**：合成 8k 格地形上跑完整侵蚀层，`brokenRivers === 0`
 *      （河格不得低于它的下游格；且 `repaired === 0` 证明是构造保证、不是兜底修复掩盖）；
 *   ③ **8k 格 < 1s**：三次中位数（真机 Node 实测，不是拍脑袋）；
 *   ④ **V 形谷**：谷壁拓宽确实把河床两侧带下去，且**床仍是最低点**（水往床里流的方向不变）；
 *   ⑤ **平原不糊**：坡度低于阈值的平地一格都不动（这是"选择性松弛"与"全图均值滤波"的分水岭）。
 *
 * 另外扫描源码确认没有 `Math.random`（判据只能来自输入）。
 *
 * 用法：node scripts/tests/unit/test_terrain_erosion.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');

/** 收集 `./xxx` 依赖并拷到临时目录（相对导入补 `.js`，思路同 `test_landmass.js`） */
function collectDeps(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = fs.readFileSync(path.join(UTILS, f), 'utf8');
    for (const m of src.matchAll(/from '\.\/([A-Za-z0-9_.-]+)'/g)) {
      const dep = m[1].endsWith('.js') ? m[1] : m[1] + '.js';
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  return [...seen];
}

function loadModules(names) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-erosion-'));
  const fix = (src) => src.replace(/from '\.\/([A-Za-z0-9_.-]+)'/g, (m) => (m.includes(".js'") ? m : m.slice(0, -1) + ".js'"));
  for (const f of collectDeps(names)) {
    fs.writeFileSync(path.join(tmp, f), fix(fs.readFileSync(path.join(UTILS, f), 'utf8')));
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  return { tmp, url: (f) => pathToFileURL(path.join(tmp, f)).href };
}

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }

/** FNV-1a（高度按 0.01 量化：与落库/回执同精度，避免浮点尾差干扰判据） */
function hashHeights(h) {
  let hh = 2166136261 >>> 0;
  for (let i = 0; i < h.length; i++) {
    hh ^= Math.round(Number(h[i]) * 100) | 0;
    hh = Math.imul(hh, 16777619) >>> 0;
  }
  return hh >>> 0;
}

/** 射线法：点是否在多边形内（判定用，非渲染） */
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/**
 * 合成 8k 格地形夹具：**圆形大陆**（72 边形，半径带确定性正弦起伏 —— 不是随机）。
 * 轮廓 → `synthesizeHeightmapFromTerrain`（与造陆同一条地形链，不是另写一份）。
 */
function makeFixture(P, seed, cellsAcross = 90) {
  const R = 380;
  const ring = [];
  for (let k = 0; k < 72; k++) {
    const a = (k / 72) * Math.PI * 2;
    const r = R * (1 + 0.08 * Math.sin(a * 3 + 0.7) + 0.05 * Math.sin(a * 7 - 1.1));
    ring.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const isLand = (x, y) => pointInRing(x, y, ring);
  return P.synthesizeHeightmapFromTerrain([{ rings: [ring] }], {
    cellsAcross,
    seed,
    isLand,
    // 与造陆现场同量级的结构权重（高原压平 → 水系更明显；这里只为夹具稳定出河）
    structureOverrides: { rangeWeight: 0.34, crossRangeWeight: 0.12, riftDepth: 0.22, plateauWeight: 0.28 },
  });
}

/** 小方阵夹具（松弛的选择性判据用；不经过合成，纯构造） */
function makeSmallGrid(cols, rows, spacing, hOf) {
  const points = [];
  const h = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      points.push([i * spacing, j * spacing]);
      h.push(hOf(i, j));
    }
  }
  return { h, grid: { points, cellsX: cols, cellsY: rows, spacing } };
}

const cloneHm = (hm) => ({ ...hm, h: hm.h.slice() });

/** 一次"生成"：夹具 + 完整侵蚀层（判据里的 ms 就是这一步） */
function generate(P, E, seed, cellsAcross) {
  const hm = makeFixture(P, seed, cellsAcross);
  const stats = E.erodeTerrain(hm, { seaLevel: 20, iterations: 2, strength: 2.8 });
  return { hm, stats };
}

async function main() {
  const { tmp, url } = loadModules(['terrainErosion.js', 'terrainSynthesis.js']);
  const E = await import(url('terrainErosion.js'));
  const P = await import(url('terrainSynthesis.js'));

  const SEED = 4242;

  // ── 夹具自检：格数必须真的在 8k 量级（否则后面所有判据都不算"8k 格通过"）
  const fixture = makeFixture(P, SEED);
  assert(fixture, '合成夹具失败（synthesizeHeightmapFromTerrain 返回 null）');
  const cellCount = fixture.grid.cellsX * fixture.grid.cellsY;
  assert(cellCount >= 7000 && cellCount <= 10000, `夹具格数 ${cellCount} 不在 8k 量级`);
  const landCells = fixture.h.filter((v) => v >= 20).length;
  assert(landCells > 1500, `夹具陆地格太少（${landCells}）：水系长不出来，判据没有意义`);

  check('e0 夹具：8k 量级 + 陆地占比合理', () => {
    return `${fixture.grid.cellsX}×${fixture.grid.cellsY} = ${cellCount} 格 · 陆地 ${landCells} 格`
      + ` · 格距 ${fixture.effectiveCellSize}`;
  });

  check('e1 确定性：同 seed 两次 → 高度数组哈希一致；换 seed 明显不同', () => {
    const a = generate(P, E, SEED);
    const b = generate(P, E, SEED);
    const ha = hashHeights(a.hm.h);
    const hb = hashHeights(b.hm.h);
    assert(ha === hb, `同 seed 两次不一致（${ha} vs ${hb}）`);
    const c = generate(P, E, SEED + 1);
    assert(hashHeights(c.hm.h) !== ha, '换 seed 后高度数组不该一样');
    return `hash ${ha} · ${a.hm.h.length} 格`;
  });

  check('e2 不断头：8k 格完整侵蚀层 → brokenRivers === 0（且不是靠兜底修复掩盖）', () => {
    const a = generate(P, E, SEED);
    const s = a.stats;
    assert(s.brokenChecked > 500, `参与判定的河段太少（${s.brokenChecked}）—— 夹具没水系，判据无效`);
    assert(s.brokenRivers === 0, `断头河 ${s.brokenRivers} 段（最严重倒挂 ${s.brokenWorst}）`);
    // repaired 非 0 = 上面三道守卫漏了（下切封顶 / 拓谷不碰河格 / 削峰河床下限），
    // 兜底修复只是安全网；这里要求 **0**，否则等于让测试替实现擦屁股。
    assert(s.repaired === 0, `兜底修复动了 ${s.repaired} 次 —— 守卫漏了，去查上面三道`);
    // 平原/海岸不变量：海平面以下一格没动（海岸线由别的模块算好）
    let below = 0;
    for (const v of a.hm.h) if (v < 20) below++;
    assert(below > 100, '海格不该全被抬成陆地');
    return `${s.brokenChecked} 段参与判定 · broken 0 · repaired 0 · 谷壁 ${s.widenCells} 格 · 削峰 ${s.relaxCells} 格`;
  });

  check('e3 8k 格 < 1s（三次中位数；打印生成 ms）', () => {
    const times = [];
    let cells = 0;
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const g = generate(P, E, SEED, 90);
      times.push(Date.now() - t0);
      cells = g.hm.grid.cellsX * g.hm.grid.cellsY;
    }
    const sorted = times.slice().sort((x, y) => x - y);
    const median = sorted[1];
    assert(median < 1000, `8k 格生成中位数 ${median}ms（应 < 1000ms）`);
    return `${cells} 格 · 中位 ${median}ms（${times.join(' / ')}）`;
  });

  check('e4 V 形谷：床两侧被带下去、越远越浅，床仍是最低（不造新坑）', () => {
    // 手工渠道：21×21 平地，中间一行是河道（比两侧低 3），每列降 0.2 → 水沿 +x 流。
    // 用合成地形之外的**解析夹具**来判"剖面形状"：合成地形的谷会互相重叠，
    // 床的邻居可能同时是另一条谷的谷壁，"所有邻居都高于床"这种断言在那里不成立（也不该成立）。
    const cols = 21;
    const rows = 21;
    const spacing = 10;
    const baseAt = (j) => (Math.abs(j - 10) === 0 ? 40 : Math.abs(j - 10) === 1 ? 43 : 46);
    const hOf = (i, j) => Math.round((baseAt(j) - 0.2 * i) * 100) / 100;
    const hm = makeSmallGrid(cols, rows, spacing, hOf);
    const segs = [];
    const carve = new Float64Array(cols * rows);
    for (let i = 0; i < cols - 1; i++) {
      const a = 10 * cols + i;
      const b = 10 * cols + i + 1;
      carve[a] = 2.0;                                  // 这一轮床被切深了 2 个高度点
      segs.push({
        cell: a, x0: i * spacing, y0: 10 * spacing, x1: (i + 1) * spacing, y1: 10 * spacing,
        flow: 2 + i, endInSea: false,
      });
    }
    const wid = E.widenValleys(hm, segs, { carve, radius: 2 });
    assert(wid.cells > 20, `谷壁拓宽几乎没生效（${wid.cells} 格）`);
    const col = 10;
    const bed0 = hOf(col, 10);
    const w1a = hOf(col, 9);
    const w1b = hOf(col, 11);
    const w2a = hOf(col, 8);
    const w2b = hOf(col, 12);
    const far = hOf(col, 7);
    // 床本身也可能被**邻段**当成谷壁带下（侵蚀里所有陆格都是河格，这是允许的）——
    // 但它必须仍高于自己的下游，且剖面顺序必须是 床 < 一圈 < 二圈 < 原地（V 形）。
    const bed = hm.h[10 * cols + col];
    assert(bed <= bed0, `床被抬高了（${bed} > ${bed0}）：拓谷只许下切`);
    assert(hm.h[9 * cols + col] < w1a && hm.h[11 * cols + col] < w1b, '紧邻床的一圈谷壁没被带下去');
    assert(hm.h[9 * cols + col] > bed && hm.h[11 * cols + col] > bed, '谷壁被带到床面以下（谷壁成了新河床）');
    assert(hm.h[8 * cols + col] < w2a && hm.h[12 * cols + col] < w2b, '第二圈谷壁没被带下去（没有 V 的"坡"）');
    // V 形：距离越远削得越少（第二圈必须比第一圈高）
    assert(hm.h[8 * cols + col] > hm.h[9 * cols + col], '第二圈不比第一圈高 —— 不是 V 形，是平底坑');
    assert(hm.h[12 * cols + col] > hm.h[11 * cols + col], '第二圈不比第一圈高 —— 不是 V 形，是平底坑');
    // 半径之外一格不许动（否则就是全图往下平移）
    assert(hm.h[7 * cols + col] === far, `半径之外的格子被动了（${hm.h[7 * cols + col]} ≠ ${far}）`);
    const g = E.countBrokenRivers(hm, segs);
    assert(g.broken === 0, `拓谷把 ${g.broken} 个河格带成断头`);
    return `床 ${bed.toFixed(2)} < 一圈 ${hm.h[9 * cols + col].toFixed(2)} < 二圈 `
      + `${hm.h[8 * cols + col].toFixed(2)} < 原地 ${far.toFixed(2)} · 断头 0`;
  });

  check('e5 平原不糊：坡度低于阈值的平地一格不动，尖峰才被削', () => {
    // 平地：±0.2 的微起伏（远低于 TALUS_SLOPE_THRESHOLD=1.4）
    const plain = makeSmallGrid(24, 24, 10, (i, j) => 30 + ((i * 7 + j * 13) % 3) * 0.2);
    const before = plain.h.slice();
    const rp = E.relaxSlopes(plain, { passes: 3 });
    assert(rp.moved === 0, `平地被松弛了 ${rp.moved} 格 —— 平原会被抹成糊`);
    assert(plain.h.every((v, k) => v === before[k]), '平地高度数组被改动了');
    // 尖峰：整片平地中央抬起一格（邻差 12 ≫ 阈值）→ 必须被削
    const spike = makeSmallGrid(24, 24, 10, (i, j) => (i === 12 && j === 12 ? 42 : 30));
    const rs = E.relaxSlopes(spike, { passes: 2 });
    const peak = 12 * 24 + 12;
    assert(rs.cells >= 1, `尖峰一格都没被削（${rs.cells}）`);
    assert(spike.h[peak] < 42, '尖峰没被削低');
    assert(spike.h[peak] >= 30, '削峰把尖峰削到平地以下了（该只削不抬、更不该挖坑）');
    return `平地 0 格变动 · 尖峰 42 → ${spike.h[peak].toFixed(2)}（${rs.cells} 格参与）`;
  });

  check('e6 API 稳定：inciseByFlow 原有字段齐全（landmass 的复用面不许破）', () => {
    const hm = makeFixture(P, SEED, 60);
    const r = E.inciseByFlow(hm, { seaLevel: 20, iterations: 1, strength: 2.8 });
    for (const k of ['iterations', 'carved', 'cells', 'ms', 'perIteration', 'segments']) {
      assert(k in r, `inciseByFlow 缺字段 ${k}`);
    }
    assert(Array.isArray(r.perIteration) && Array.isArray(r.segments), 'perIteration/segments 应是数组');
    assert(r.iterations === 1 && r.carved > 0, `回执不自洽：iterations=${r.iterations} carved=${r.carved}`);
    // 新入口的字段必须覆盖 landmass 现在读的四个诊断
    const full = E.erodeTerrain(cloneHm(hm), { seaLevel: 20, iterations: 1, strength: 2.8 });
    for (const k of ['iterations', 'carved', 'segments', 'widenCells', 'relaxCells', 'brokenRivers']) {
      assert(k in full, `erodeTerrain 缺字段 ${k}`);
    }
    return `inciseByFlow 在下切 ${r.perIteration[0]} 点 · erodeTerrain 诊断齐全`;
  });

  check('e7 随机纪律：terrainErosion.js 里没有 Math.random', () => {
    const raw = fs.readFileSync(path.join(UTILS, 'terrainErosion.js'), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert(!/Math\.random\s*\(/.test(code), 'terrainErosion.js 出现 Math.random（同 seed 必须同结果）');
    return '0 处 Math.random';
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  —— ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 留就留 */ }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error('用例自身崩溃：', err); process.exit(1); });
