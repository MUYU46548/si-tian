#!/usr/bin/env node
/**
 * Node 单元测试：矢量布尔层（src/renderer/src/utils/polygonBool.js）
 *
 * 为什么必须有这一层测试：P2 把省份「归属」从格点模型换成矢量布尔 —— 涂抹 = 对多边形做
 * 并集/差集。这类错误（洞被填掉、飞地丢失、`fromGrid` 没清导致渲染端平滑一个 10525 点的环）
 * 在 CDP 用例里只表现为"画面不对"，定位不到。本文件直接对纯函数下断言。
 *
 * ⚠️ 被测试模块是 ESM 且**有相对 import**（./geometry、./provinceShape）——
 *    与 test_province_shape.js 同一套做法：复制到临时目录 + 写 `{"type":"module"}`，
 *    把**副本**的相对 import 补上 `.js`，再用 file URL import。不改 package.json、不改源码。
 * ⚠️ `polygon-clipping` **不在这里测** —— 本文件测的是格式转换与包装逻辑；本仓的 Node 单测
 *    在临时目录里解析不到裸模块（这正是 polygonBool.js 把引擎设计成**注入式**的原因）。
 *    真布尔由 CDP 用例端到端覆盖。
 *
 * 用法：node scripts/tests/unit/test_polygon_bool.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const DEPS = ['polygonBool.js', 'provinceShape.js', 'geometry.js', 'gridOutline.js'];

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

/** 挑一个真能写的临时根目录（不能直接用 os.tmpdir()：MSYS 下 /tmp 是 POSIX 路径） */
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

const sq = (x, y, w, h) => ({ points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] });

async function main() {
  const root = pickTmpRoot();
  if (!root) throw new Error('找不到可写的临时目录');
  const tmp = fs.mkdtempSync(path.join(root, 'sitian-polybool-'));
  const fixExt = (src) => src.replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
  for (const f of DEPS) {
    const body = fixExt(fs.readFileSync(path.join(SRC_DIR, f), 'utf8'));
    fs.writeFileSync(path.join(tmp, f), body);
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));

  const B = await import(pathToFileURL(path.join(tmp, 'polygonBool.js')).href);
  const {
    ringToXY, xyToPoints, groupRingsIntoPolygons, provinceToMulti, multiToShape,
    isEmptyMulti, rdpSimplify, brushDiscRing, segmentQuadRing, traceBrushRings,
    ringsToMulti, unionMulti, differenceMulti, intersectsMulti,
  } = B;

  // ── 一、格式转换 ────────────────────────────────────────────────────────
  check('ringToXY：自动闭合（首尾同点）', () => {
    const r = ringToXY([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
    assert(r && r.length === 4, `应 4 个坐标，实际 ${r && r.length}`);
    assert(r[0][0] === r[3][0] && r[0][1] === r[3][1], '首尾应重合');
    return `4 点闭合`;
  });

  check('ringToXY：不足 3 点 → null', () => {
    assert(ringToXY([{ x: 0, y: 0 }, { x: 1, y: 1 }]) === null, '2 点应返回 null');
  });

  check('ringToXY：过滤非法坐标', () => {
    const r = ringToXY([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: NaN, y: 5 }, { x: 10, y: 10 }]);
    assert(r && r.length === 4, `应 4（闭合），实际 ${r && r.length}`);
  });

  check('xyToPoints：去掉闭合尾点', () => {
    const pts = xyToPoints([[0, 0], [10, 0], [10, 10], [0, 0]]);
    assert(pts.length === 3, `应 3，实际 ${pts.length}`);
    assert(pts[0].x === 0 && pts[2].y === 10, '顺序应保持');
  });

  // ── 二、环分组（洞 / 飞地）──────────────────────────────────────────────
  check('分组：单外环 → 1 个 Polygon', () => {
    const polys = groupRingsIntoPolygons([sq(0, 0, 10, 10)]);
    assert(polys.length === 1 && polys[0].length === 1, `实际 ${polys.length} 个 Polygon`);
  });

  check('🔴 分组：外环 + 内环（洞）→ 同一个 Polygon 两个环', () => {
    const polys = groupRingsIntoPolygons([sq(0, 0, 100, 100), sq(40, 40, 20, 20)]);
    assert(polys.length === 1, `洞必须与外环同组，实际 ${polys.length} 个 Polygon`);
    assert(polys[0].length === 2, `应 2 个环，实际 ${polys[0].length}`);
    return `1 Polygon / 2 环`;
  });

  check('分组：两个不相交外环（飞地）→ 2 个 Polygon', () => {
    const polys = groupRingsIntoPolygons([sq(0, 0, 10, 10), sq(50, 50, 10, 10)]);
    assert(polys.length === 2, `飞地应各自成组，实际 ${polys.length}`);
  });

  check('分组：非法环被丢弃（不静默当外环）', () => {
    const polys = groupRingsIntoPolygons([sq(0, 0, 10, 10), { points: [{ x: 0, y: 0 }] }]);
    assert(polys.length === 1, `实际 ${polys.length}`);
  });

  check('provinceToMulti：主环 + extraRings', () => {
    const prov = { points: sq(0, 0, 10, 10).points, extraRings: [{ points: sq(50, 50, 10, 10).points, kind: 'land' }] };
    const mp = provinceToMulti(prov);
    assert(mp.length === 2, `两个不相邻的环 → 2 个 Polygon，实际 ${mp.length}`);
  });

  // ── 三、MultiPolygon → 省份补丁 ────────────────────────────────────────
  check('🔴 multiToShape：必须显式 fromGrid:false（否则渲染端会平滑 10525 点）', () => {
    const patch = multiToShape([[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]], 'land');
    assert(patch.fromGrid === false, `fromGrid 应为 false，实际 ${patch.fromGrid}`);
  });

  check('multiToShape：多 Polygon → 主环 + extraRings', () => {
    const mp = [
      [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
      [[[50, 50], [60, 50], [60, 60], [50, 60], [50, 50]]],
    ];
    const patch = multiToShape(mp, 'land');
    assert(patch.points.length === 4, `主环 4 点，实际 ${patch.points.length}`);
    assert(Array.isArray(patch.extraRings) && patch.extraRings.length === 1, '应有 1 个额外环');
  });

  check('multiToShape：带洞 → 洞进 extraRings', () => {
    const mp = [[
      [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]],
      [[40, 40], [40, 60], [60, 60], [60, 40], [40, 40]],
    ]];
    const patch = multiToShape(mp, 'land');
    assert(patch.extraRings && patch.extraRings.length === 1, '洞应在 extraRings');
  });

  check('isEmptyMulti：空/非空', () => {
    assert(isEmptyMulti([]) === true, '空数组应 true');
    assert(isEmptyMulti([[[[0, 0], [1, 0], [1, 1], [0, 0]]]]) === false, '有环应 false');
  });

  // ── 四、笔迹几何 ────────────────────────────────────────────────────────
  check('rdpSimplify：共线 100 点 → 2 点', () => {
    const line = [];
    for (let i = 0; i <= 100; i++) line.push({ x: i, y: 0 });
    const out = rdpSimplify(line, 0.5);
    assert(out.length === 2, `应剩首尾 2 点，实际 ${out.length}`);
  });

  check('rdpSimplify：折角必须保留', () => {
    const out = rdpSimplify([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }], 0.5);
    assert(out.length === 3, `直角应保留 3 点，实际 ${out.length}`);
  });

  check('brushDiscRing：闭合且点数=sides+1', () => {
    const r = brushDiscRing(0, 0, 10, 16);
    assert(r.length === 17, `实际 ${r.length}`);
    assert(r[0][0] === r[16][0] && r[0][1] === r[16][1], '应闭合');
  });

  check('segmentQuadRing：与轨迹垂直的宽度 = 2r', () => {
    const q = segmentQuadRing({ x: 0, y: 0 }, { x: 10, y: 0 }, 3);
    assert(q.length === 5, `实际 ${q.length}`);
    const ys = q.map((p) => p[1]);
    assert(Math.abs(Math.min(...ys) + 3) < 1e-9 && Math.abs(Math.max(...ys) - 3) < 1e-9, `宽度应 ±3，实际 ${ys}`);
  });

  check('traceBrushRings：单点 → 1 个圆', () => {
    const rings = traceBrushRings([{ x: 5, y: 5 }], 2);
    assert(rings.length === 1, `实际 ${rings.length}`);
  });

  check('traceBrushRings：三连点（共线）简化后 = 2 圆 + 1 矩形', () => {
    const rings = traceBrushRings([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 40, y: 0 }], 2);
    assert(rings.length === 3, `应 2 圆 + 1 矩形，实际 ${rings.length}`);
  });

  check('traceBrushRings：长轨迹被 RDP 压缩（不给引擎喂上千个形状）', () => {
    const pts = [];
    for (let i = 0; i <= 1000; i++) pts.push({ x: i * 0.5, y: 0 });
    const rings = traceBrushRings(pts, 3);
    assert(rings.length <= 4, `共线 1001 点应压到 ≤4 个形状，实际 ${rings.length}`);
  });

  check('ringsToMulti：合法环成 Polygon，退化环被丢', () => {
    const mp = ringsToMulti([[[0, 0], [1, 0], [1, 1], [0, 0]], [[5, 5], [6, 6]]]);
    assert(mp.length === 1, `应只保留 1 个合法环（第二个不足 4 坐标），实际 ${mp.length}`);
    const mp2 = ringsToMulti([]);
    assert(mp2.length === 0, `空输入应 0，实际 ${mp2.length}`);
  });

  // ── 五、布尔包装（注入 stub 引擎，验证短路与参数）────────────────────────
  const stubClip = {
    union: (...args) => ({ __union: args.length }),
    difference: (...args) => ({ __diff: args.length }),
    intersection: (...args) => (args[1] === 'EMPTY' ? [] : { __isect: 1 }),
  };

  check('unionMulti：无新增 → 原样返回 base，不调引擎', () => {
    const base = [[[[0, 0], [1, 0], [1, 1], [0, 0]]]];
    assert(unionMulti(stubClip, base, []) === base, '应原样返回同一引用');
  });

  check('unionMulti：base 空 + 单个新增 → 直接返回它，不调引擎', () => {
    const add = [[[[0, 0], [1, 0], [1, 1], [0, 0]]]];
    assert(unionMulti(stubClip, [], [add]) === add, '应直接返回新增');
  });

  check('unionMulti：base + 新增 → 调 union(base, add)', () => {
    const r = unionMulti(stubClip, [[[1]]], [[[2]]]);
    assert(r && r.__union === 2, `应调 union 且 2 个参数，实际 ${JSON.stringify(r)}`);
  });

  check('differenceMulti：无削减 → 原样返回 base', () => {
    const base = [[[[0, 0], [1, 0], [1, 1], [0, 0]]]];
    assert(differenceMulti(stubClip, base, []) === base, '应原样返回');
  });

  check('differenceMulti：base + 削减 → 调 difference(base, cut)', () => {
    const r = differenceMulti(stubClip, [[[1]]], [[[2]]]);
    assert(r && r.__diff === 2, `应调 difference 且 2 个参数，实际 ${JSON.stringify(r)}`);
  });

  check('intersectsMulti：空几何短路为 false', () => {
    assert(intersectsMulti(stubClip, [], [[[1]]]) === false, '空 base 应 false');
  });

  // ── 汇总 ────────────────────────────────────────────────────────────────
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }

  const failed = results.filter((r) => !r.ok);
  console.log('=== 矢量布尔层（Node）单元测试 ===');
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('单元测试运行器异常:', err);
  process.exit(1);
});
