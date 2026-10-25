#!/usr/bin/env node
/**
 * Node 单元测试：**造陆**（src/renderer/src/utils/landmass.js）+ 造陆参数（terrainParams.js 的 LAND_* 组）
 *
 * 守的东西（都是 P0-2 的验收项）：
 *   ① **确定性**：同 seed + 同参数 = 同一组环（同一份输入永远同一张大陆）；
 *   ② **不重叠**：任意一块陆地的环点不落进另一块（粘在一起会让铺底切出横跨两块大陆的省）；
 *   ③ **不出界**：所有点都在给定 bbox 内（出界的部分渲染看不到，用户却会以为省数不对）；
 *   ④ **形状口径有效**：长条大陆的 y/x 比明显更小；群岛的环数 > 陆块数；崎岖度真的改变周长；
 *   ⑤ **占比如实**：实际陆地占比与目标同量级，且**不假装达标**（低了就报低）。
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

  check('a1 确定性：同 seed + 同参数两次生成逐点相同', () => {
    const x = L.generateLandmass(base, bbox);
    const y = L.generateLandmass(base, bbox);
    assert(hashRings(x.rings) === hashRings(y.rings), '两次生成不一致');
    const z = L.generateLandmass({ ...base, seed: base.seed + 1 }, bbox);
    assert(hashRings(x.rings) !== hashRings(z.rings), '换 seed 后形状没变');
    return `${x.rings.length} 个环 / ${x.rings.reduce((a, r) => a + r.points.length, 0)} 点`;
  });

  check('a2 不出界：所有环点都在 bbox 内', () => {
    for (const shape of ['continent', 'elongated', 'archipelago']) {
      const g = L.generateLandmass({ ...base, shape, continentCount: 4, roughness: 0.7 }, bbox);
      for (const r of g.rings) {
        for (const p of r.points) {
          assert(p.x >= bbox.minX - 1e-6 && p.x <= bbox.maxX + 1e-6, `${shape} 环点 x=${p.x} 出界`);
          assert(p.y >= bbox.minY - 1e-6 && p.y <= bbox.maxY + 1e-6, `${shape} 环点 y=${p.y} 出界`);
        }
      }
    }
    return '三种形状都贴边内';
  });

  check('a3 不重叠：任意环点不落进别的环', () => {
    for (const shape of ['continent', 'elongated', 'archipelago']) {
      const g = L.generateLandmass({ ...base, shape, continentCount: 4, landRatio: 0.5 }, bbox);
      let bad = 0;
      g.rings.forEach((r, i) => {
        g.rings.forEach((q, j) => {
          if (i === j) return;
          for (const p of r.points) if (insidePolygon(p, q.points)) { bad++; break; }
        });
      });
      assert(bad === 0, `${shape} 有 ${bad} 个环至少一个点落进别的环（叠在一起了）`);
    }
    return '0 处重叠';
  });

  check('a4 形状口径：长条大陆 y/x 比更小；群岛环数 > 陆块数', () => {
    const c = L.generateLandmass({ ...base, shape: 'continent', continentCount: 2 }, bbox);
    const e = L.generateLandmass({ ...base, shape: 'elongated', continentCount: 2 }, bbox);
    const a = L.generateLandmass({ ...base, shape: 'archipelago', continentCount: 2 }, bbox);
    const cb = bboxOf(c.rings), eb = bboxOf(e.rings);
    const ratioC = (cb.maxY - cb.minY) / (cb.maxX - cb.minX);
    const ratioE = (eb.maxY - eb.minY) / (eb.maxX - eb.minX);
    assert(ratioE < ratioC * 0.8, `长条 ${ratioE.toFixed(2)} 未明显小于圆润 ${ratioC.toFixed(2)}`);
    assert(a.rings.length > 2, `群岛只有 ${a.rings.length} 个环（应 > 陆块数 2）`);
    return `圆润 ${ratioC.toFixed(2)} / 长条 ${ratioE.toFixed(2)} / 群岛 ${a.rings.length} 环`;
  });

  check('a5 崎岖度有效：海岸周长随 roughness 上升；0 时接近光滑', () => {
    const smooth = L.generateLandmass({ ...base, shape: 'continent', continentCount: 1, roughness: 0 }, bbox);
    const rough = L.generateLandmass({ ...base, shape: 'continent', continentCount: 1, roughness: 1 }, bbox);
    const Ls = perimeter(smooth.rings[0].points);
    const Lr = perimeter(rough.rings[0].points);
    assert(Lr > Ls * 1.08, `崎岖周长 ${Lr.toFixed(0)} 未明显大于光滑 ${Ls.toFixed(0)}`);
    // 光滑情形下必须是一个**标准椭圆**（rot 会把椭圆转个角，所以用 PCA 求半轴，不假定轴对齐）：
    // 面积 / (π·a·b) 应 ≈ 1；崎岖环的边界起伏会让它明显偏离（下面顺带比较）。
    const ellipseFit = (ring) => {
      const pts = ring.points;
      const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
      const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
      let sxx = 0, syy = 0, sxy = 0;
      for (const p of pts) { const dx = p.x - cx, dy = p.y - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
      sxx /= pts.length; syy /= pts.length; sxy /= pts.length;
      const tr = sxx + syy, det = sxx * syy - sxy * sxy;
      const disc = Math.max(0, (tr * tr) / 4 - det);
      const l1 = tr / 2 + Math.sqrt(disc), l2 = Math.max(1e-9, tr / 2 - Math.sqrt(disc));
      const a = Math.sqrt(2 * l1), b = Math.sqrt(2 * l2);
      let area = 0;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) area += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
      return { a, b, ratio: Math.abs(area) / 2 / (Math.PI * a * b) };
    };
    const fitS = ellipseFit(smooth.rings[0]);
    const fitR = ellipseFit(rough.rings[0]);
    assert(Math.abs(fitS.ratio - 1) < 0.03, `roughness=0 不是标准椭圆：面积/πab=${fitS.ratio.toFixed(3)}`);
    assert(Math.abs(fitR.ratio - 1) > 0.03, `roughness=1 仍像标准椭圆（ratio=${fitR.ratio.toFixed(3)}）—— 崎岖度没生效`);
    return `周长 ${Ls.toFixed(0)} → ${Lr.toFixed(0)}；椭圆拟合 光滑 ${fitS.ratio.toFixed(3)} / 崎岖 ${fitR.ratio.toFixed(3)}`;
  });

  check('a6 占比：实际陆地占比与目标同量级（0.5×~1.2×），且低于目标时如实回报', () => {
    for (const target of [0.15, 0.3, 0.45]) {
      const g = L.generateLandmass({ ...base, landRatio: target, continentCount: 3 }, bbox);
      const got = g.stats.landRatio;
      assert(got > target * 0.5, `目标 ${target} 实际只有 ${got.toFixed(3)}（不到一半）`);
      assert(got <= target * 1.2 + 0.01, `目标 ${target} 实际 ${got.toFixed(3)}（超出 20%）`);
      assert(g.stats.targetRatio === target, 'targetRatio 回执缺失');
    }
    return '三档同量级';
  });

  check('a7 参数归一化：越界夹取留 warning；形状枚举只认白名单', () => {
    const { params, warnings } = P.normalizeLandParams({ seed: -5, continentCount: 99, landRatio: 2, shape: 'blob', provinceCount: 9999 });
    const keys = new Set(warnings.map((w) => w.key));
    for (const k of ['seed', 'continentCount', 'landRatio', 'shape', 'provinceCount']) assert(keys.has(k), `${k} 改了却没 warning`);
    assert(params.seed === 0 && params.continentCount === 8 && params.landRatio === 0.55, `夹取不对：${JSON.stringify(params)}`);
    assert(params.shape === 'continent', `非法形状应回默认，实际 ${params.shape}`);
    assert(params.provinceCount === 600, `provinceCount 上界夹取失败：${params.provinceCount}`);
    return `${warnings.length} 条 warning`;
  });

  check('a8 确定性源码扫描：landmass / 参数模型里没有 Math.random', () => {
    for (const f of ['landmass.js', 'terrainParams.js']) {
      const raw = fs.readFileSync(path.join(UTILS, f), 'utf8');
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert(!/Math\.random\s*\(/.test(code), `${f} 出现 Math.random`);
    }
    return 'ok';
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  —— ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 留就留 */ }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error('用例自身崩溃：', err); process.exit(1); });
