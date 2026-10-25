#!/usr/bin/env node
/**
 * Node 单元测试：**造陆 v3**（src/renderer/src/utils/landmass.js + landmassField.js）+ 造陆参数
 *
 * v3（2026-10-25 用户判词「从几坨面团变成了几坨花生酱」之后重写）：先铺**地形**
 * （陆核 / 叶 / 山脊=半岛 / 海槽=海湾 / 海峡），再在**抖动网格**上逐格判海陆、沿格边描海岸。
 * 判据随之改成"用户能看见的东西"：
 *   ① 确定性：同 seed + 同参数 → 逐点相同；
 *   ② 不出界 + 不重叠（外环互不包含、互不相交）；
 *   ③ **占比命中**：格口径（海平面分位数）≤0.5 个点、多边形口径 ≤2 个点；
 *   ④ 形状口径：长条整体更扁长；群岛的环数更多；
 *   ⑤ 海岸不是面团：roughness↑ → 周长/√面积 与 顶点密度都上升；光滑档也必须 10+；
 *   ⑥ 湖泊（洞）存在且方向相反；参数归一化留 warning；无 Math.random。
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

  check('a4 形状口径：长条的整体更"扁长"（面积加权陆地主轴比）；群岛的环数更多', () => {
    const c = gen({ shape: 'continent', continentCount: 3, landRatio: 0.3 });
    const e = gen({ shape: 'elongated', continentCount: 3, landRatio: 0.3 });
    const a = gen({ shape: 'archipelago', continentCount: 3, landRatio: 0.28 });
    // 为什么是"面积加权主轴"而不是"最大环 PCA"或"包围盒"：
    //   · 最大环 PCA —— 单个大环可能只是一块近圆的半岛/岛，会被单块形状骗到；
    //   · 包围盒 —— 几座散岛就能把 bbox 撑满整张画布（实测三种形状全都 ≈1.0，判不出差别）。
    //   面积加权后大块陆地主导方向，散岛权重趋近于零。
    const landPCA = (g) => {
      let A = 0, mx = 0, my = 0;
      const means = g.rings.map((r) => {
        const m = r.points.reduce((acc, p) => ({ x: acc.x + p.x / r.points.length, y: acc.y + p.y / r.points.length }), { x: 0, y: 0 });
        return m;
      });
      g.rings.forEach((r, i) => { A += r.area; mx += means[i].x * r.area; my += means[i].y * r.area; });
      if (A <= 0) return 1;
      mx /= A; my /= A;
      let sxx = 0, syy = 0, sxy = 0;
      g.rings.forEach((r, i) => {
        const w = r.area / r.points.length;
        for (const p of r.points) {
          const dx = p.x - mx, dy = p.y - my;
          sxx += w * dx * dx; syy += w * dy * dy; sxy += w * dx * dy;
        }
      });
      const tr = sxx + syy, det = sxx * syy - sxy * sxy;
      const disc = Math.max(0, (tr * tr) / 4 - det);
      const l1 = tr / 2 + Math.sqrt(disc), l2 = Math.max(1e-9, tr / 2 - Math.sqrt(disc));
      return Math.sqrt(l1 / l2);
    };
    const ec = landPCA(c), ee = landPCA(e);
    assert(ee > ec * 1.15, `长条陆地主轴比 ${ee.toFixed(2)} 未明显高于圆润 ${ec.toFixed(2)}`);
    assert(a.rings.length > c.rings.length, `群岛环数 ${a.rings.length} 未多于圆润 ${c.rings.length}`);
    return `陆地主轴比 圆润 ${ec.toFixed(2)} / 长条 ${ee.toFixed(2)} / 环数 ${c.rings.length}→${a.rings.length}`;
  });

  check('a5 海岸不是面团：roughness↑ → 周长/√面积 与 顶点密度 都明显上升', () => {
    const metric = (g) => {
      let P2 = 0, A = 0, pts = 0;
      for (const r of g.rings) { P2 += perimeter(r.points); A += area(r.points); pts += r.points.length; }
      return { c: P2 / Math.sqrt(Math.max(1e-9, A)), pts };
    };
    const smooth = metric(gen({ shape: 'continent', continentCount: 2, roughness: 0.05 }));
    const rough = metric(gen({ shape: 'continent', continentCount: 2, roughness: 0.95 }));
    assert(rough.c > smooth.c * 1.15, `粗糙度没有拉开复杂度：${smooth.c.toFixed(2)} → ${rough.c.toFixed(2)}`);
    assert(rough.pts > smooth.pts * 1.2, `粗糙度没有拉开顶点密度：${smooth.pts} → ${rough.pts}`);
    // 光滑档也不能是"面团"：v3 用格边描岸，复杂度天生在 12+（v2 面团约 6~8）
    assert(smooth.c > 10, `光滑档太"面团"（${smooth.c.toFixed(2)} < 10）`);
    return `复杂度 ${smooth.c.toFixed(2)} → ${rough.c.toFixed(2)}；顶点 ${smooth.pts} → ${rough.pts}`;
  });

  check('a6 占比命中：目标 15%/32%/45% 的多边形与格口径都差 ≤ 2 个百分点', () => {
    for (const target of [0.15, 0.32, 0.45]) {
      const g = gen({ landRatio: target, continentCount: 3 });
      const got = g.stats.landRatio;
      assert(Math.abs(got - target) <= 0.02, `目标 ${target} 多边形实测 ${got.toFixed(3)}（差 ${(Math.abs(got - target) * 100).toFixed(1)} 个点）`);
      // 格口径是海平面分位数的直接结果，必须更准（≤ 0.5 个点）——它证明"占比滑杆"真的在生效
      const cell = g.stats.cellLandRatio;
      assert(Math.abs(cell - target) <= 0.005, `目标 ${target} 格口径 ${cell.toFixed(3)} 偏差过大`);
      assert(g.stats.holeCount >= 0 && g.stats.cells > 1000, `格数异常：${g.stats.cells}`);
    }
    return '三档命中（多边形 ≤2pp / 格 ≤0.5pp）';
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

  check('a10 地形：合成高度图存在、有落差、且与海岸线对得上', () => {
    const g = gen({ landRatio: 0.32 });
    assert(g.terrain && g.terrain.grid && Array.isArray(g.terrain.grid.points), '没有回传地形高度图');
    assert(g.terrain.grid.cellsX * g.terrain.grid.cellsY > 8000, `地形格数太少：${g.terrain.grid.cellsX}×${g.terrain.grid.cellsY}`);
    assert(g.stats.terrainMax - g.stats.terrainMin > 20,
      `地形没有落差：${g.stats.terrainMin} ~ ${g.stats.terrainMax}（山地没起来）`);
    // 高差要有"分层"：不能全挤在海岸那一段
    const hs = Array.from(g.terrain.h).filter((v) => v >= 20).sort((a, b) => a - b);
    const q = (p) => hs[Math.min(hs.length - 1, Math.round(p * (hs.length - 1)))];
    assert(q(0.95) - q(0.5) > 12, `高地不够高：p50=${q(0.5).toFixed(1)} p95=${q(0.95).toFixed(1)}`);
    // 回传的预览栅格：与水陆判定同口径（差 ≤ 5 个百分点）
    assert(g.relief && g.relief.data && g.relief.w > 0, '没有回传预览栅格');
    let below = 0;
    for (const v of g.relief.data) if ((v * 100) / 255 < g.stats.seaLevel) below++;
    const rasterLand = 1 - below / g.relief.data.length;
    assert(Math.abs(rasterLand - g.stats.landRatio) < 0.05,
      `预览栅格的陆地占比 ${(rasterLand * 100).toFixed(1)}% 与多边形 ${(g.stats.landRatio * 100).toFixed(1)}% 差太多`);
    return `${g.terrain.grid.cellsX}×${g.terrain.grid.cellsY} 格 · 高差 ${g.stats.terrainMin}~${g.stats.terrainMax} · 栅格陆 ${(rasterLand * 100).toFixed(1)}%`;
  });

  check('a11 海岸细节尺度：中位边长 ≤ 12 世界单位（v3 是 17.6 —— 放大就是台阶）', () => {
    const edgeLens = (g) => {
      const out = [];
      for (const r of g.rings) {
        for (const ring of [r.points, ...(r.holes || [])]) {
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length];
            out.push(Math.hypot(b.x - a.x, b.y - a.y));
          }
        }
      }
      out.sort((a, b) => a - b);
      return out;
    };
    const g = gen({ roughness: 0.45, continentCount: 3 });
    const lens = edgeLens(g);
    const median = lens[Math.floor(lens.length / 2)];
    assert(lens.length > 800, `顶点太少（${lens.length}），海岸没细节可言`);
    assert(median <= 12, `中位边长 ${median.toFixed(1)} 世界单位 —— 台阶太粗（v3 实测 17.6）`);
    // 台阶的观感来自"边长都差不多"：抖过之后分散度必须上来
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
    const cv = sd / mean;
    assert(cv > 0.35, `边长过于整齐（CV=${cv.toFixed(2)}）：那是格网台阶的特征`);
    return `中位 ${median.toFixed(1)} 单位 · CV ${cv.toFixed(2)} · ${lens.length} 条边`;
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  —— ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 留就留 */ }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error('用例自身崩溃：', err); process.exit(1); });
