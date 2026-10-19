#!/usr/bin/env node
/**
 * Node 单元测试：批量铺底纯几何层（src/renderer/src/utils/voronoiBatch.js）
 *              + 折线切割的纯几何部分（src/renderer/src/utils/polygonBool.js 的 cutRingForPolyline）
 *
 * 为什么必须有这一层：B 方案（Voronoi 一次切出四五百块）与 A 方案（折线切割）的正确性
 * 全靠这两段纯几何 —— 一旦 cell 之间**留缝/压叠**、或切出的"一侧"其实两侧都覆盖，
 * 表现出来只是"地图上有条细缝 / 少了一块地"，在 CDP 用例里几乎定位不到。
 * 这里直接对顶点下断言：铺满、无缝、site 归属唯一、折线两侧互补。
 *
 * ⚠️ 与 test_polygon_bool.js 同一套加载方式：复制到临时目录 + 写 `{"type":"module"}` +
 *    给相对 import 补 `.js`（不改 package.json、不改源码）。布尔引擎（polygon-clipping）
 *    **不在这里测** —— 真布尔由 CDP 用例端到端覆盖；这里只测"喂给引擎的环长什么样"。
 *
 * 用法：node scripts/tests/unit/test_voronoi_batch.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const DEPS = ['voronoiBatch.js', 'polygonBool.js', 'provinceShape.js', 'polylineSmooth.js', 'geometry.js', 'gridOutline.js'];

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
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function pickTmpRoot() {
  const cands = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : '',
    os.tmpdir(), process.env.TEMP, process.env.TMP, os.homedir(),
  ];
  for (const c of cands) {
    if (!c || !path.isAbsolute(c)) continue;
    if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(c)) continue;
    try {
      fs.mkdirSync(c, { recursive: true });
      fs.accessSync(c, fs.constants.W_OK);
      return c;
    } catch (_) { /* 换下一个 */ }
  }
  return null;
}

async function main() {
  const root = pickTmpRoot();
  if (!root) throw new Error('找不到可写的临时目录');
  const tmp = fs.mkdtempSync(path.join(root, 'sitian-voronoi-'));
  const fixExt = (src) => src.replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
  for (const f of DEPS) {
    const body = fixExt(fs.readFileSync(path.join(SRC_DIR, f), 'utf8'));
    fs.writeFileSync(path.join(tmp, f), body);
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));

  const V = await import(pathToFileURL(path.join(tmp, 'voronoiBatch.js')).href);
  const B = await import(pathToFileURL(path.join(tmp, 'polygonBool.js')).href);

  // ══════════════════════════════════════════════════════════════════════
  // 一、确定性随机与播种
  // ══════════════════════════════════════════════════════════════════════
  check('makeRng：同种子同序列，不同种子不同序列', () => {
    const a = V.makeRng(7), b = V.makeRng(7), c = V.makeRng(8);
    const A = [a(), a(), a()], Bv = [b(), b(), b()], C = [c(), c(), c()];
    assert(JSON.stringify(A) === JSON.stringify(Bv), '同种子必须复现（用例可断言、用户可"再来一次"）');
    assert(JSON.stringify(A) !== JSON.stringify(C), '不同种子应给出不同序列');
    assert(A.every((x) => x >= 0 && x < 1), 'rng 值必须落在 [0,1)');
  });

  check('gridShapeFor：长条包围盒不把 cell 拉成细条', () => {
    const s = V.gridShapeFor({ minX: 0, minY: 0, maxX: 400, maxY: 100 }, 100);
    assert(s.cols > s.rows, `宽 4:1 应 cols>rows，实际 ${s.cols}x${s.rows}`);
    assert(s.cols * s.rows >= 100, `网格数应 ≥ 目标，实际 ${s.cols * s.rows}`);
  });

  check('jitteredGridSeeds：点全部落在包围盒内、数量 = cols×rows', () => {
    const bb = { minX: 0, minY: 0, maxX: 100, maxY: 50 };
    const pts = V.jitteredGridSeeds(bb, 10, 5, V.makeRng(3), 0.62);
    assert(pts.length === 50, `应 50，实际 ${pts.length}`);
    const bad = pts.filter((p) => p.x < bb.minX || p.x > bb.maxX || p.y < bb.minY || p.y > bb.maxY);
    assert(bad.length === 0, `有 ${bad.length} 个点跑出包围盒`);
  });

  check('autoSeedsInRegion：只播在区域内，且凑够目标块数', () => {
    // 区域 = 左下象限的方块（只占包围盒 1/4）
    const region = [[[[0, 0], [50, 0], [50, 50], [0, 50], [0, 0]]]];
    const probe = V.makeRegionProbe(region);
    const r = V.autoSeedsInRegion({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, probe, 60, { seed: 5 });
    assert(r.seeds.length === 60, `应凑够 60 个，实际 ${r.seeds.length}（attempt ${r.attempt}）`);
    const out = r.seeds.filter((p) => !probe.inside(p.x, p.y));
    assert(out.length === 0, `有 ${out.length} 个种子落在区域外`);
    return `${r.seeds.length} 个 / ${r.attempt + 1} 轮`;
  });

  // ══════════════════════════════════════════════════════════════════════
  // 二、Voronoi：铺满、无缝、唯一归属
  // ══════════════════════════════════════════════════════════════════════
  const bb = { minX: 0, minY: 0, maxX: 120, maxY: 80 };
  const sites = V.jitteredGridSeeds(bb, 8, 6, V.makeRng(11), 0.6);
  const built = V.voronoiCells(sites, bb);
  const rings = built.rings;

  check('voronoiCells：每个 site 都拿到一个 cell', () => {
    const nulls = rings.filter((r) => !r).length;
    assert(nulls === 0, `有 ${nulls} 个 cell 为空`);
    return `${rings.length} 块 / ${built.facets} 次半平面裁剪`;
  });

  check('🔴 铺满无缝：包围盒内每个采样点**恰好**落在一个 cell 里', () => {
    // 逐点判「在几个 cell 内」：0 = 有缝（丢地），≥2 = 压叠（错归属）
    let zero = 0, multi = 0, total = 0;
    for (let i = 0; i <= 60; i++) {
      for (let j = 0; j <= 40; j++) {
        const x = bb.minX + (bb.maxX - bb.minX) * (i / 60);
        const y = bb.minY + (bb.maxY - bb.minY) * (j / 40);
        let k = 0;
        for (const r of rings) if (B.pointInMulti(x, y, [[r]])) k++;
        total++;
        if (k === 0) zero++;
        if (k > 1) multi++;
      }
    }
    assert(zero === 0, `有 ${zero}/${total} 个采样点不在任何 cell 里（cell 之间留缝 = 地图上会有细缝）`);
    assert(multi === 0, `有 ${multi}/${total} 个采样点落在多个 cell 里（cell 压叠 = 归属有歧义）`);
    return `${total} 个采样点，0 缝 0 叠`;
  });

  check('🔴 面积守恒：所有 cell 面积之和 = cell 被裁到的矩形面积（无重叠无缺口）', () => {
    let s = 0;
    for (const r of rings) s += B.multiNetArea([[r]]);
    // cell 会被裁到「包围盒外扩 pad」的矩形里（外圈 cell 是无界的，必须有个框）
    const rect = built.rect;
    const box = Math.abs((rect[2][0] - rect[0][0]) * (rect[2][1] - rect[0][1]));
    assert(near(s, box, box * 1e-6), `合计 ${s.toFixed(4)} vs 裁剪矩形 ${box.toFixed(4)}`);
    return `${s.toFixed(3)} ≈ ${box}`;
  });

  check('🔴 归属唯一：cell 内任意点到本 site 的距离 ≤ 到任何别的 site', () => {
    let bad = 0;
    for (let i = 0; i < rings.length; i++) {
      const s = sites[i];
      const r = rings[i];
      for (let k = 0; k < r.length - 1; k++) {
        const x = (r[k][0] + r[k + 1][0]) / 2, y = (r[k][1] + r[k + 1][1]) / 2;
        const d0 = Math.hypot(x - s.x, y - s.y);
        for (const t of sites) {
          const d = Math.hypot(x - t.x, y - t.y);
          if (d < d0 - 1e-6) { bad++; break; }
        }
      }
    }
    assert(bad === 0, `有 ${bad} 条边的中点离别的 site 更近（cell 与 site 对不上号）`);
  });

  check('相邻 cell 精确共边（同一段边在两个 cell 里坐标逐位相同）', () => {
    // 取 cell0 与它最近邻的 cell：共享边应出现两次且坐标一致
    let best = 1, bd = Infinity;
    for (let j = 1; j < sites.length; j++) {
      const d = Math.hypot(sites[j].x - sites[0].x, sites[j].y - sites[0].y);
      if (d < bd) { bd = d; best = j; }
    }
    const key = (p) => `${p[0].toFixed(9)},${p[1].toFixed(9)}`;
    const setA = new Set(rings[0].map(key));
    const shared = rings[best].filter((p) => setA.has(key(p)));
    assert(shared.length >= 2, `相邻 cell 应共享 ≥2 个顶点（一条边），实际 ${shared.length}`);
    return `共享 ${shared.length} 个顶点`;
  });

  check('voronoiCells：确定性（同一输入逐位相同）', () => {
    const again = V.voronoiCells(sites, bb);
    assert(JSON.stringify(again.rings) === JSON.stringify(rings), '同样输入必须给出同样几何');
  });

  check('voronoiCells：n 个点 → n 个 cell（不吞不重）', () => {
    const small = V.voronoiCells([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 9 }], { minX: -20, minY: -20, maxX: 30, maxY: 30 });
    assert(small.rings.length === 3, `应 3，实际 ${small.rings.length}`);
    assert(small.rings.every((r) => r && r.length >= 4), '每个 cell 都应是合法闭合环');
  });

  // ══════════════════════════════════════════════════════════════════════
  // 三、区域探针（"要不要调布尔引擎"的判据必须**保守**）
  // ══════════════════════════════════════════════════════════════════════
  check('makeRegionProbe：inside 对洞正确（洞内算外）', () => {
    const ring = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]];
    const hole = [[40, 40], [60, 40], [60, 60], [40, 60], [40, 40]];
    const probe = V.makeRegionProbe([[ring, hole]]);
    assert(probe.inside(10, 10) === true, '外环内应 true');
    assert(probe.inside(50, 50) === false, '洞里应 false');
    assert(probe.inside(200, 200) === false, '外面应 false');
  });

  check('🔴 makeRegionProbe：edgeNear 只会**多报**，绝不会漏报', () => {
    // 一个 100×100 方块；在它内部取一个小盒（离边界很远）→ 应为 false；
    // 跨边界的盒 → 必须 true（否则那一块会被当成"全内"，海岸线就被抹平了）
    const probe = V.makeRegionProbe([[[[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]]]);
    assert(probe.edgeNear({ minX: 40, minY: 40, maxX: 60, maxY: 60 }) === false, '内陆盒不该报 true');
    assert(probe.edgeNear({ minX: 95, minY: 40, maxX: 105, maxY: 60 }) === true, '跨边界盒必须 true');
    assert(probe.edgeNear({ minX: -50, minY: -50, maxX: -40, maxY: -40 }) === false, '远处盒不该报 true');
  });

  check('makeRegionProbe：与逐点判定一致（随机 400 点）', () => {
    const mp = [[[[0, 0], [80, 0], [80, 80], [0, 80], [0, 0]]], [[[200, 200], [260, 200], [260, 260], [200, 260], [200, 200]]]];
    const probe = V.makeRegionProbe(mp);
    const rng = V.makeRng(99);
    let bad = 0;
    for (let i = 0; i < 400; i++) {
      const x = rng() * 300 - 20, y = rng() * 300 - 20;
      if (probe.inside(x, y) !== B.pointInMulti(x, y, mp)) bad++;
    }
    assert(bad === 0, `${bad} 个点与 pointInMulti 不一致`);
  });

  // ══════════════════════════════════════════════════════════════════════
  // 四、折线切出的"一侧"（A 方案的几何核心）
  // ══════════════════════════════════════════════════════════════════════
  check('clipSegmentToRect：区间正确', () => {
    const r = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const s = B.clipSegmentToRect({ x: -5, y: 5 }, { x: 15, y: 5 }, r);
    assert(s && near(s[0].x, 0, 1e-9) && near(s[1].x, 10, 1e-9), `实际 ${JSON.stringify(s)}`);
    assert(B.clipSegmentToRect({ x: -5, y: 5 }, { x: -1, y: 5 }, r) === null, '完全在外应返回 null');
  });

  check('clipPolylineToRect：真出界再回来 → 拆成多段', () => {
    const r = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    // 在盒内 → 出右边界 → 从上方绕回 → 再从左边界进入（两段的进出点不同）
    const pts = [
      { x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: -5 },
      { x: -5, y: -5 }, { x: -5, y: 5 }, { x: 5, y: 5 },
    ];
    const runs = B.clipPolylineToRect(pts, r);
    assert(runs.length === 2, `应 2 段，实际 ${runs.length}`);
    assert(near(runs[0][runs[0].length - 1].x, 10, 1e-9), `第一段应止于右边 x=10，实际 ${runs[0][runs[0].length - 1].x}`);
    assert(near(runs[1][0].x, 0, 1e-9), `第二段应从左边 x=0 起，实际 ${runs[1][0].x}`);
  });

  check('🔴 cutRingForPolyline：水平折线 → 环覆盖且只覆盖折线的一侧', () => {
    const box = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const line = [{ x: -20, y: 50 }, { x: 120, y: 50 }];
    const cut = B.cutRingForPolyline(line, box);
    assert(cut && cut.ring.length >= 4, '应给出一个闭合环');
    const mp = [[cut.ring]];
    const up = B.pointInMulti(50, 20, mp), down = B.pointInMulti(50, 80, mp);
    assert(up !== down, `折线两侧必须在环的内/外各一份（上=${up} 下=${down}）`);
    // 环还必须覆盖**包围盒之外**：否则"切"不出完整的省（省的边贴到盒外就漏了）
    assert(B.pointInMulti(-40, up ? 20 : 80, mp) === true, '同一侧的盒外区域也必须在环内');
    assert(B.pointInMulti(-40, up ? 80 : 20, mp) === false, '另一侧的盒外区域必须在环外');
    return `环 ${cut.ring.length} 点 / ${cut.runs} 段（保留${up ? '上' : '下'}半）`;
  });

  check('🔴 cutRingForPolyline：折线两侧互补（并集覆盖整个包围盒）', () => {
    // 用「点在环内」的布尔值构造两侧，采样验证每个点恰好属于一侧
    const box = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const line = [{ x: -10, y: 0 }, { x: 40, y: 60 }, { x: 110, y: 30 }];
    const cut = B.cutRingForPolyline(line, box);
    assert(cut, '应给出闭合环');
    const inSide = (x, y) => B.pointInMulti(x, y, [[cut.ring]]);
    // 取折线中点上方/下方各一点：必须落在不同侧
    const mid = { x: 40, y: 60 };
    let a = 0, b = 0;
    for (let i = 1; i <= 40; i++) {
      for (let j = 1; j <= 40; j++) {
        const x = (i / 41) * 100, y = (j / 41) * 100;
        if (inSide(x, y)) a++; else b++;
      }
    }
    assert(a > 0 && b > 0, `两侧都必须非空（${a} / ${b}）`);
    assert(a + b === 1600, '每个采样点必须恰好属于一侧');
    assert(inSide(mid.x, mid.y + 3) !== inSide(mid.x, mid.y - 3), '折线两侧必须分属不同的环内/环外');
  });

  check('cutRingForPolyline：折线退化（<2 点 / 无包围盒）→ null', () => {
    assert(B.cutRingForPolyline([{ x: 0, y: 0 }], { minX: 0, minY: 0, maxX: 1, maxY: 1 }) === null, '单点应 null');
    assert(B.cutRingForPolyline([{ x: 0, y: 0 }, { x: 1, y: 1 }], null) === null, '无 bbox 应 null');
  });

  check('🔴 cutRingForPolyline：两个端点都落在省内也能切（两端自动沿切向延长）', () => {
    const box = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    // 用户只在省中间画了一小段 —— 仍然应该是一条完整的切割线
    const cut = B.cutRingForPolyline([{ x: 4, y: 5 }, { x: 6, y: 5 }], box);
    assert(cut, '两端延长后应能横穿');
    const mp = [[cut.ring]];
    assert(B.pointInMulti(5, 1, mp) !== B.pointInMulti(5, 9, mp), '延长后的折线两侧仍必须分属内外');
  });

  // ══════════════════════════════════════════════════════════════════════
  // 五、工具函数
  // ══════════════════════════════════════════════════════════════════════
  check('multiBBox / multiNetArea / countMultiPoints', () => {
    const sq = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]];
    const hole = [[[3, 3], [6, 3], [6, 6], [3, 6], [3, 3]]];
    const mp = [[sq[0], hole[0]]];
    const bb2 = B.multiBBox(mp);
    assert(bb2.minX === 0 && bb2.maxY === 10, `包围盒错：${JSON.stringify(bb2)}`);
    assert(near(B.multiNetArea(mp), 100 - 9, 1e-9), `净面积应为 91，实际 ${B.multiNetArea(mp)}`);
    assert(B.countMultiPoints(mp) === 10, `顶点数应为 10，实际 ${B.countMultiPoints(mp)}`);
  });

  check('🔴 multiNetArea：洞必须减（毛面积会把洞算成两份地）', () => {
    const outer = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]];
    const hole = [[40, 40], [60, 40], [60, 60], [40, 60], [40, 40]];
    assert(B.multiNetArea([[outer, hole]]) < B.multiNetArea([[outer]]), '带洞必须比不带洞小');
  });

  check('snapMulti：坐标吸附到栅格（引擎报错时的兜底）', () => {
    const mp = [[[[0.00049, 1.23456], [10.9999, 0], [10, 10], [0, 0]]]];
    const s = B.snapMulti(mp, 1e-3);
    assert(s[0][0][0][1] === 1.235 || near(s[0][0][0][1], 1.234, 1e-3), `吸附结果异常：${s[0][0][0][1]}`);
  });

  check('pointInMulti：奇偶规则对飞地也对', () => {
    const mp = [
      [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
      [[[50, 50], [60, 50], [60, 60], [50, 60], [50, 50]]],
    ];
    assert(B.pointInMulti(5, 5, mp) === true, '第一块内');
    assert(B.pointInMulti(55, 55, mp) === true, '飞地内');
    assert(B.pointInMulti(30, 30, mp) === false, '两块之间应在外');
  });

  // ── 输出 ────────────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  for (const r of results) {
    console.log(`${r.ok ? '  ok  ' : '  FAIL'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  }
  console.log(`\n=== 批量铺底/折线切割纯几何：${pass}/${results.length} 通过 ===`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 临时目录清不掉不影响结论 */ }
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('测试运行失败：', (err && err.stack) || err);
  process.exit(1);
});
