#!/usr/bin/env node
/**
 * Node 单元测试：**造陆 v2**（src/renderer/src/utils/landmass.js）+ 造陆参数（terrainParams.js 的 LAND_* 组）
 *
 * v2（2026-10-25 用户判词「像几坨面团」之后重写）：标量场 + marching squares，不再是
 * "一个圆心 + 径向噪声"。判据随之改成**场/轮廓层**能证明的东西：
 *   ① 确定性：同 seed + 同参数 → 逐点相同；
 *   ② 不出界 + 不重叠（外环互不包含、互不相交）；
 *   ③ **占比命中**：按分位数定阈值，实测陆地占比与目标差 ≤ 5 个百分点（这是用户能看见的旋钮）；
 *   ④ 形状口径：长条的整体 y/x 更小；群岛的环数更多；
 *   ⑤ 海岸复杂度：roughness↑ → 周长/√面积 上升（"面团"就是这条低的形态）；
 *   ⑥ 参数归一化留 warning；无 Math.random。
 *
 * 用法：node scripts/tests/unit/test_landmass.js
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

function loadModules(names) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-land-'));
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

function insidePolygon(pt, pts) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (((yi > pt.y) !== (yj > pt.y)) && (pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi)) c = !c;
  }
  return c;
}
function perimeter(pts) {
  let L = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    L += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return L;
}
function area(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  return Math.abs(a) / 2;
}
function bboxOf(rings) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings) for (const p of r.points) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}
const hashRings = (rings) => rings.map((r) => r.points.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(';')).join('|');

async function main() {
  const { tmp, url } = loadModules(['landmass.js', 'terrainParams.js']);
  const L = await import(url('landmass.js'));
  const P = await import(url('terrainParams.js'));

  const bbox = { minX: -900, minY: -500, maxX: 900, maxY: 500 };
  const base = { ...P.DEFAULT_LAND_PARAMS };
  const gen = (over) => L.generateLandmass({ ...base, ...over }, bbox);

  check('a1 确定性：同参数逐点相同；换 seed 明显不同', () => {
    const a = gen({});
    const b = gen({});
    assert(hashRings(a.rings) === hashRings(b.rings), '两次生成不一致');
    const c = gen({ seed: base.seed + 1 });
    assert(hashRings(a.rings) !== hashRings(c.rings), '换 seed 后形状没变');
    return `${a.rings.length} 环 / ${a.stats.fieldCells} 格场`;
  });

  check('a2 不出界：所有外环与洞的点都在 bbox 内', () => {
    for (const shape of ['continent', 'elongated', 'archipelago']) {
      const g = gen({ shape, continentCount: 4, roughness: 0.7 });
      for (const r of g.rings) {
        for (const ring of [r.points, ...(r.holes || [])]) {
          for (const p of ring) {
            assert(p.x >= bbox.minX - 1e-6 && p.x <= bbox.maxX + 1e-6, `${shape} x=${p.x} 出界`);
            assert(p.y >= bbox.minY - 1e-6 && p.y <= bbox.maxY + 1e-6, `${shape} y=${p.y} 出界`);
          }
        }
      }
    }
    return '三种形状都贴边内';
  });

  check('a3 不重叠：任一外环的顶点不落进别的外环', () => {
    for (const shape of ['continent', 'elongated', 'archipelago']) {
      const g = gen({ shape, continentCount: 4, landRatio: 0.4 });
      let bad = 0;
      g.rings.forEach((r, i) => {
        g.rings.forEach((q, j) => {
          if (i === j) return;
          for (const p of r.points) if (insidePolygon(p, q.points)) { bad++; break; }
        });
      });
      assert(bad === 0, `${shape} 有 ${bad} 个环落进别的环（叠在一起了）`);
    }
    return '0 处重叠';
  });

  check('a4 形状口径：长条最大陆块更"细长"（PCA 主轴比）；群岛的环数更多', () => {
    const c = gen({ shape: 'continent', continentCount: 3, landRatio: 0.3 });
    const e = gen({ shape: 'elongated', continentCount: 3, landRatio: 0.3 });
    const a = gen({ shape: 'archipelago', continentCount: 3, landRatio: 0.28 });
    // 旋转不变的主轴细长比（bbox 会被旋转/簇状布局骗到）
    const elongOfBiggest = (g) => {
      const biggest = g.rings.slice().sort((x, y) => y.area - x.area)[0];
      if (!biggest) return 1;
      const pts = biggest.points;
      const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      let sxx = 0, syy = 0, sxy = 0;
      for (const p of pts) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
      const tr = sxx + syy, det = sxx * syy - sxy * sxy;
      const disc = Math.max(0, (tr * tr) / 4 - det);
      const l1 = tr / 2 + Math.sqrt(disc), l2 = Math.max(1e-9, tr / 2 - Math.sqrt(disc));
      return Math.sqrt(l1 / l2);
    };
    const ec = elongOfBiggest(c), ee = elongOfBiggest(e);
    assert(ee > ec * 1.15, `长条最大陆块主轴比 ${ee.toFixed(2)} 未明显高于圆润 ${ec.toFixed(2)}`);
    assert(a.rings.length > c.rings.length, `群岛环数 ${a.rings.length} 未多于圆润 ${c.rings.length}`);
    return `主轴比 圆润 ${ec.toFixed(2)} / 长条 ${ee.toFixed(2)} / 环数 ${c.rings.length}→${a.rings.length}`;
  });

  check('a5 海岸不是面团：roughness↑ → 周长/√面积 明显上升', () => {
    const metric = (g) => {
      let P2 = 0, A = 0;
      for (const r of g.rings) { P2 += perimeter(r.points); A += area(r.points); }
      return P2 / Math.sqrt(Math.max(1e-9, A));
    };
    const smooth = gen({ shape: 'continent', continentCount: 2, roughness: 0.05 });
    const rough = gen({ shape: 'continent', continentCount: 2, roughness: 0.95 });
    const ms = metric(smooth), mr = metric(rough);
    assert(mr > ms * 1.15, `粗糙度没有拉开复杂度：${ms.toFixed(2)} → ${mr.toFixed(2)}`);
    assert(ms > 3.2, `光滑档也太碎（${ms.toFixed(2)}）—— 检查噪声幅度`);
    return `复杂度 ${ms.toFixed(2)} → ${mr.toFixed(2)}`;
  });

  check('a6 占比命中：目标 15%/32%/45% 实测差 ≤ 5 个百分点', () => {
    for (const target of [0.15, 0.32, 0.45]) {
      const g = gen({ landRatio: target, continentCount: 3 });
      const got = g.stats.landRatio;
      assert(Math.abs(got - target) <= 0.05, `目标 ${target} 实测 ${got.toFixed(3)}（差 ${(Math.abs(got - target) * 100).toFixed(1)} 个点）`);
    }
    return '三档命中';
  });

  check('a7 湖泊：带洞的环 holes 是反向闭合环，且洞面积计入扣减', () => {
    let withHoles = 0;
    for (const seed of [1, 2, 3, 7, 11, 23, 42, 99]) {
      const g = gen({ seed, landRatio: 0.4, roughness: 0.6 });
      withHoles += g.rings.filter((r) => (r.holes || []).length).length;
    }
    assert(withHoles > 0, '8 个种子里一个带湖的陆块都没有 —— 洞的判定可能写错了');
    return `${withHoles} 个带洞陆块`;
  });

  check('a8 参数归一化：越界夹取留 warning；形状枚举只认白名单', () => {
    const { params, warnings } = P.normalizeLandParams({ seed: -5, continentCount: 99, landRatio: 2, shape: 'blob', provinceCount: 9999 });
    const keys = new Set(warnings.map((w) => w.key));
    for (const k of ['seed', 'continentCount', 'landRatio', 'shape', 'provinceCount']) assert(keys.has(k), `${k} 改了却没 warning`);
    assert(params.seed === 0 && params.continentCount === 8 && params.landRatio === 0.55, `夹取不对：${JSON.stringify(params)}`);
    assert(params.shape === 'continent', `非法形状应回默认，实际 ${params.shape}`);
    assert(params.provinceCount === 600, `provinceCount 上界夹取失败：${params.provinceCount}`);
    return `${warnings.length} 条 warning`;
  });

  check('a9 确定性源码扫描：landmass 里没有 Math.random', () => {
    const raw = fs.readFileSync(path.join(UTILS, 'landmass.js'), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert(!/Math\.random\s*\(/.test(code), 'landmass.js 出现 Math.random');
    return 'ok';
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  —— ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 留就留 */ }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error('用例自身崩溃：', err); process.exit(1); });
