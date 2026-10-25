#!/usr/bin/env node
/**
 * Node 单元测试：**文化 / 宗教 / 势力派生**（src/renderer/src/utils/cultureDerive.js）
 *
 * 守的判据（P0-4 验收项）：
 *   ① 确定性：同 seed + 同参数 → 逐格文化/宗教、省份摘要、势力方案全部一致；
 *   ② 覆盖性：每个陆格都必须有文化（值 1..k），海格必须是 0；
 *   ③ 文化区连续：每个文化至少有若干格（最远点采样若退化成"一个中心包全场"会被抓到）；
 *   ④ 宗教：数量正确、每个宗教都绑定一个存在的文化；
 *   ⑤ 省份摘要：每个省都有文化/宗教，且名字能在列表里找到；
 *   ⑥ 势力：数量正确、归属只落在存在的省份上、不跨文化、每势力至少一省；
 *   ⑦ 无 Math.random（同参数必须可复现）。
 *
 * 用法：node scripts/tests/unit/test_culture_derive.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');

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

function loadModule(entry) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-culture-'));
  const fix = (src) => src.replace(/from '\.\/([A-Za-z0-9_.-]+)'/g, (m) => (m.includes(".js'") ? m : m.slice(0, -1) + ".js'"));
  for (const f of collectDeps([entry])) {
    fs.writeFileSync(path.join(tmp, f), fix(fs.readFileSync(path.join(UTILS, f), 'utf8')));
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  return { tmp, url: pathToFileURL(path.join(tmp, entry)).href };
}

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }

/** 合成一块椭圆陆地 + 网格（40×30 / spacing 40），再切 3×3 个省 */
function makeFixture() {
  const cols = 40, rows = 30, spacing = 40;
  const points = [];
  const h = new Float32Array(cols * rows);
  const cx = (cols - 1) / 2, cy = (rows - 1) / 2;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      points.push([i * spacing, j * spacing]);
      const dx = (i - cx) / (cols * 0.4), dy = (j - cy) / (rows * 0.4);
      h[j * cols + i] = (dx * dx + dy * dy) <= 1 ? 40 + 10 * Math.sin(i / 4) : 8;
    }
  }
  // 3×3 省（覆盖整张网格；海格也会落到省里，省摘要只看 Land 格）
  const terrain = [];
  const pw = (cols * spacing) / 3, ph = (rows * spacing) / 3;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const x0 = c * pw, y0 = r * ph;
      terrain.push({
        id: `p_${r}_${c}`,
        name: `省 ${r}${c}`,
        kind: 'land',
        points: [
          { x: x0 + 1, y: y0 + 1 }, { x: x0 + pw - 1, y: y0 + 1 },
          { x: x0 + pw - 1, y: y0 + ph - 1 }, { x: x0 + 1, y: y0 + ph - 1 },
        ],
      });
    }
  }
  return { grid: { points, cellsX: cols, cellsY: rows, spacing }, h, terrain };
}

async function main() {
  const { tmp, url } = loadModule('cultureDerive.js');
  const M = await import(url);
  const F = makeFixture();
  const params = { seed: 42, cultureCount: 5, religionCount: 4, polityCount: 4 };
  const d1 = M.deriveCultureLayers({ grid: F.grid, h: F.h, seaLevel: 20, terrain: F.terrain, params });
  const d2 = M.deriveCultureLayers({ grid: F.grid, h: F.h, seaLevel: 20, terrain: F.terrain, params });

  check('a1 确定性：同参数两次派生逐格相同 / 省份摘要相同 / 势力方案相同', () => {
    assert(String(d1.cultureGrid) === String(d2.cultureGrid), '文化网格不确定');
    assert(String(d1.religionGrid) === String(d2.religionGrid), '宗教网格不确定');
    assert(JSON.stringify(d1.provinceCulture) === JSON.stringify(d2.provinceCulture), '省份摘要不确定');
    const p1 = M.planPolities(F.terrain, d1.provinceCulture, params);
    const p2 = M.planPolities(F.terrain, d2.provinceCulture, params);
    assert(JSON.stringify(p1) === JSON.stringify(p2), '势力方案不确定');
    const d3 = M.deriveCultureLayers({ grid: F.grid, h: F.h, seaLevel: 20, terrain: F.terrain, params: { ...params, seed: 43 } });
    assert(String(d1.cultureGrid) !== String(d3.cultureGrid), '换 seed 后文化网格没变');
    return `${d1.stats.landCells} 个陆格`;
  });

  check('a2 覆盖性：陆格全部有文化（1..k），海格必须为 0', () => {
    let seaAssigned = 0, landAssigned = 0;
    for (let i = 0; i < F.h.length; i++) {
      const land = F.h[i] >= 20;
      if (land) { if (d1.cultureGrid[i] >= 1) landAssigned++; }
      else if (d1.cultureGrid[i] !== 0 || d1.religionGrid[i] !== 0) seaAssigned++;
    }
    assert(seaAssigned === 0, `海格被写了文化/宗教：${seaAssigned}`);
    assert(landAssigned === d1.stats.landCells, `陆格覆盖 ${landAssigned} ≠ ${d1.stats.landCells}`);
    return `陆 ${landAssigned} / 海 0`;
  });

  check('a3 文化区真的分区：数量 = 参数，且每个文化 ≥ 20 格', () => {
    assert(d1.cultures.length === params.cultureCount, `文化数 ${d1.cultures.length} ≠ ${params.cultureCount}`);
    const sizes = d1.stats.cultureSizes;
    assert(sizes.length === params.cultureCount, `规模数组长度 ${sizes.length}`);
    sizes.forEach((n, i) => assert(n >= 20, `文化 ${i + 1} 只有 ${n} 格（没形成区）`));
    return sizes.join(' / ');
  });

  check('a4 宗教：数量正确、每个宗教绑定一个存在的文化', () => {
    assert(d1.religions.length === params.religionCount, `宗教数 ${d1.religions.length} ≠ ${params.religionCount}`);
    const ids = new Set(d1.cultures.map((c) => c.id));
    for (const r of d1.religions) assert(ids.has(r.culture), `宗教 ${r.name} 绑定了不存在的文化 ${r.culture}`);
    const sizes = d1.stats.religionSizes;
    assert(sizes.reduce((a, b) => a + b, 0) === d1.stats.landCells, '宗教格数之和不等于陆格数');
    return `${d1.religions.length} 宗教`;
  });

  check('a5 省份摘要：每省都有文化/宗教，名字能在列表里找到', () => {
    const names = new Set(d1.cultures.map((c) => c.name));
    const rnames = new Set(d1.religions.map((r) => r.name));
    assert(Object.keys(d1.provinceCulture).length === F.terrain.length,
      `省份摘要 ${Object.keys(d1.provinceCulture).length}/${F.terrain.length}`);
    for (const [pid, rec] of Object.entries(d1.provinceCulture)) {
      assert(rec.cultureId >= 1, `${pid} 没有 cultureId`);
      assert(names.has(rec.culture), `${pid} 的文化名 ${rec.culture} 不在列表里`);
      assert(rnames.has(rec.religion), `${pid} 的宗教名 ${rec.religion} 不在列表里`);
    }
    return `${Object.keys(d1.provinceCulture).length} 省`;
  });

  check('a6 势力：数量正确、归属只落在存在的省、每势力至少一省；文化多于势力时按地理合并', () => {
    // ① 势力 ≥ 文化：不跨文化，每势力至少一省
    const many = { ...params, polityCount: 7 };
    const plan = M.planPolities(F.terrain, d1.provinceCulture, many);
    assert(plan.polities.length === 7, `势力数 ${plan.polities.length} ≠ 7`);
    const provIds = new Set(F.terrain.map((p) => p.id));
    const polIds = new Set(plan.polities.map((p) => p.id));
    const byCulture = new Map();
    for (const [pid, owner] of Object.entries(plan.ownerByProvince)) {
      assert(provIds.has(pid), `归属指向不存在的省 ${pid}`);
      assert(polIds.has(owner), `归属指向不存在的势力 ${owner}`);
      const cid = d1.provinceCulture[pid].cultureId;
      if (!byCulture.has(owner)) byCulture.set(owner, cid);
      else assert(byCulture.get(owner) === cid, `势力 ${owner} 跨文化（${byCulture.get(owner)} vs ${cid}）`);
    }
    for (const p of plan.polities) {
      const n = Object.values(plan.ownerByProvince).filter((x) => x === p.id).length;
      assert(n >= 1, `势力 ${p.name} 一省都没有`);
    }
    // ② 势力 < 文化：按地理合并成 polityCount 组，省数守恒
    const few = { ...params, polityCount: 3 };
    const plan2 = M.planPolities(F.terrain, d1.provinceCulture, few);
    assert(plan2.polities.length === 3, `合并后势力数 ${plan2.polities.length} ≠ 3`);
    assert(plan2.stats.assigned + plan2.stats.unassigned === F.terrain.length, '合并后省数不守恒');
    return `${plan.polities.length} 势力（不跨文化） / ${plan2.polities.length} 势力（合并）`;
  });

  check('a7 无 Math.random：派生路径必须可复现', () => {
    const raw = fs.readFileSync(path.join(UTILS, 'cultureDerive.js'), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert(!/Math\.random\s*\(/.test(code), 'cultureDerive.js 出现 Math.random');
    return 'ok';
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  —— ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 留就留 */ }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error('用例自身崩溃：', err); process.exit(1); });
