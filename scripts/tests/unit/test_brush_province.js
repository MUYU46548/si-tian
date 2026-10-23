#!/usr/bin/env node
/**
 * Node 单元测试：笔刷建省的纯几何层（src/renderer/src/utils/brushProvince.js）
 *
 * 为什么必须有这一层测试（2026-10-22）：
 *   「笔刷建省」= 一笔涂抹长出一个新省。它的三条性质**只能在几何层断言**，
 *   在 CDP 用例里只表现为"画出来的形状不对"：
 *     ① 笔迹覆盖范围 = 新省面积（圆盘 ∪ 胶囊，不多不少）；
 *     ② **不压叠**：新省与任何已有省份的交集必须为空（压叠会让点选/上色/标签三处打架）；
 *     ③ 已有省份整块盖住笔迹时**必须拒绝且零副作用**（否则会造出发丝粗细的怪省）。
 *
 * ⚠️ 本文件的被测模块是 ESM 且有相对 import —— 与 test_polygon_bool.js 同一套做法：
 *    复制到临时目录 + 写 `{"type":"module"}`，把副本的相对 import 补上 `.js`，再用 file URL import。
 * ⚠️ 但这里**要用真布尔引擎**（polygon-clipping）：`brushProvince.js` 的引擎是**注入式**的，
 *    所以由本文件 `require('polygon-clipping')`（解析于仓库 node_modules）再注入进去 ——
 *    这正是那一层设计成注入式的原因：纯几何可以在 Node 里跑真引擎，不靠 CDP 猜。
 *
 * 用法：node scripts/tests/unit/test_brush_province.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const DEPS = ['brushProvince.js', 'polygonBool.js', 'provinceShape.js', 'polylineSmooth.js', 'geometry.js', 'gridOutline.js'];

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

const area = (m, pc) => Math.abs((() => {
  // 用引擎自身的 union 归一遍再自己算面积：这里只需"净面积"这一个数
  const rings = [];
  for (const poly of m || []) (poly || []).forEach((ring, i) => rings.push({ ring, sign: i === 0 ? 1 : -1 }));
  let s = 0;
  for (const { ring, sign } of rings) {
    let a2 = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      a2 += p[0] * q[1] - q[0] * p[1];
    }
    s += sign * Math.abs(a2 / 2);
  }
  return s;
})());

/** 两个 MultiPolygon 的交集面积（判"压叠"）——真引擎算 */
function overlapArea(pc, a, b) {
  if (!a || !a.length || !b || !b.length) return 0;
  try {
    return area(pc.intersection(a, b), pc);
  } catch (e) {
    throw new Error(`交集算不出来（引擎异常）：${e.message}`);
  }
}

const SQ = (x, y, w, h) => ({ id: `sq${x}_${y}`, name: `方块${x}`, kind: 'land',
  points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] });
const line = (x0, y0, x1, y1, n = 40) => {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t });
  }
  return out;
};
const ringAround = (cx, cy, r, n = 60) => {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return out;
};

async function main() {
  const root = pickTmpRoot();
  if (!root) throw new Error('找不到可写的临时目录');
  const tmp = fs.mkdtempSync(path.join(root, 'sitian-brushprov-'));
  const fixExt = (src) => src.replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
  for (const f of DEPS) {
    const body = fixExt(fs.readFileSync(path.join(SRC_DIR, f), 'utf8'));
    fs.writeFileSync(path.join(tmp, f), body);
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));

  let pc = null;
  try {
    const mod = require('polygon-clipping');
    pc = (mod && typeof mod.union === 'function') ? mod : (mod && mod.default);
  } catch (e) {
    throw new Error(`require('polygon-clipping') 失败：${e.message} —— 先在仓库根跑 npm install（真布尔是这条用例的一部分）`);
  }
  if (!pc || typeof pc.union !== 'function' || typeof pc.difference !== 'function') {
    throw new Error('polygon-clipping 的形状不对（拿不到 union/difference）');
  }

  const BP = await import(pathToFileURL(path.join(tmp, 'brushProvince.js')).href);
  const PB = await import(pathToFileURL(path.join(tmp, 'polygonBool.js')).href);
  assert(typeof BP.brushStrokeMulti === 'function', 'brushStrokeMulti 没导出');
  assert(typeof BP.paintProvinceShape === 'function', 'paintProvinceShape 没导出');
  assert(typeof BP.subtractProvinces === 'function', 'subtractProvinces 没导出');

  // ① 笔迹 → 胶囊形状：面积 = 2rL + πr²（圆盘近似多边形，允许 10% 误差）
  check('一笔直线 = 胶囊：面积 ≈ 2rL + πr²（不多不少，涂抹范围就是省）', () => {
    const r = 20, L = 300;
    const stroke = line(0, 0, L, 0, 60);
    const got = BP.brushStrokeMulti(pc, stroke, r);
    assert(!got.rejected, `被拒绝：${got.rejected}`);
    const A = area(got.multi, pc);
    const want = 2 * r * L + Math.PI * r * r;
    const err = Math.abs(A - want) / want;
    assert(err < 0.10, `面积偏差 ${(err * 100).toFixed(1)}%：${A.toFixed(1)} vs ${want.toFixed(1)}`);
    assert(got.multi.length === 1, `应是一整块（MultiPolygon 只有 1 个 Polygon），实际 ${got.multi.length}`);
    return `面积 ${A.toFixed(0)} / 期望 ${want.toFixed(0)}（偏差 ${(err * 100).toFixed(1)}%）`;
  });

  // ② 单点 = 一个圆（单击也能成一个"圆点省"）
  check('单击（1 个采样点）= 半径 r 的圆', () => {
    const r = 25;
    const got = BP.brushStrokeMulti(pc, [{ x: 100, y: 100 }], r);
    assert(!got.rejected, `被拒绝：${got.rejected}`);
    const A = area(got.multi, pc);
    const want = Math.PI * r * r;
    const err = Math.abs(A - want) / want;
    assert(err < 0.08, `面积偏差 ${(err * 100).toFixed(1)}%`);
    return `面积 ${A.toFixed(0)} / 期望 ${want.toFixed(0)}`;
  });

  // ③ 空地：不切、cutRatio=0、形状可用（multiToShape 能给出一份干净的省份几何）
  check('空底图：整笔都算新省（cutRatio=0），且能转成省份几何（fromGrid=false）', () => {
    const stroke = line(0, 0, 200, 0, 40);
    const res = BP.paintProvinceShape(pc, stroke, 18, []);
    assert(!res.rejected, `被拒绝：${res.rejected}`);
    assert(Math.abs(res.cutRatio) < 1e-9, `屈服 cutRatio=${res.cutRatio}`);
    const patch = PB.multiToShape(res.multi, 'land');
    assert(patch.points.length >= 3, '顶点不足 3');
    assert(patch.fromGrid === false, 'fromGrid 必须显式 false（否则渲染端会 Chaikin 平滑它）');
    for (const p of patch.points) assert(Number.isFinite(p.x) && Number.isFinite(p.y), '出现 NaN 顶点');
    return `${patch.points.length} 顶点 / 面积 ${Math.round(res.area)}`;
  });

  // ④ 压叠：已有省份占掉右半边 → 新省**与它零交集**（这条是"不压叠"的核心判据）
  check('已有省份占右半：新省只留左半，与已有省份交集面积为 0（不压叠）', () => {
    const stroke = line(0, 0, 200, 0, 40);
    const prov = SQ(100, -80, 200, 160);          // 从 x=100 起把右半盖住
    const res = BP.paintProvinceShape(pc, stroke, 20, [prov]);
    assert(!res.rejected, `被拒绝：${res.rejected}`);
    const provMulti = PB.provinceToMulti(prov);
    const ov = overlapArea(pc, res.multi, provMulti);
    assert(ov < 1e-6, `⚠️ 压叠了：交集面积 ${ov}`);
    assert(res.cutRatio > 0.2 && res.cutRatio < 0.9, `cutRatio 应在 0.2~0.9，实际 ${res.cutRatio.toFixed(3)}`);
    const bbox = PB.multiBBox(res.multi);
    assert(bbox.maxX <= 100.5, `新省越过边界进了已有省份：maxX=${bbox.maxX}`);
    return `面积 ${Math.round(res.area)}（少了 ${(res.cutRatio * 100).toFixed(0)}%），与已有省份交集 ${ov.toFixed(9)}`;
  });

  // ⑤ 整笔压在已有省份上 → 拒绝、零副作用（不建省、不造"头发丝"）
  check('整笔压在已有省份上：拒绝（all-covered）且不返回几何', () => {
    const stroke = line(120, 0, 180, 0, 20);
    const prov = SQ(0, -200, 400, 400);
    const res = BP.paintProvinceShape(pc, stroke, 20, [prov]);
    assert(res.rejected === 'all-covered', `应拒绝 all-covered，实际 ${res.rejected}`);
    assert(!res.multi, '拒绝时不该返回几何（零副作用）');
    assert(res.message && res.message.includes('空地'), `拒绝理由要人话：${res.message}`);
    return res.rejected;
  });

  // ⑥ 只刮到一点点空地（< 5%）→ 拒绝 too-thin（比建出怪省好）
  check('只刮到已有省份边上的一条细缝：拒绝 too-thin（不造头发丝省）', () => {
    // 画出来 ≈ 2·20·1000 + π·400 ≈ 41257；只剩 x<15 那一缝（≈ 15·40 + 半个圆 ≈ 1200，约 3%）
    const stroke = line(0, 0, 1000, 0, 120);
    const res = BP.paintProvinceShape(pc, stroke, 20, [SQ(15, -200, 2000, 400)]);
    assert(res.rejected === 'too-thin', `应拒绝 too-thin，实际 ${res.rejected}（cutRatio=${res.cutRatio.toFixed(3)}）`);
    assert(!res.multi, '拒绝时不该返回几何（零副作用）');
    assert(res.message && res.message.includes('改省界'), `拒绝理由要给出下一步：${res.message}`);
    return `too-thin（留下 ${res.area.toFixed(0)} / 画出 ${res.paintedArea.toFixed(0)}，占 ${(res.cutRatio * 100).toFixed(1)}%）`;
  });

  // ⑥b 对照组：同样一笔、同样半径，但空地够多 → **必须建得出来**（证明 ⑥ 不是把正常情况也拦了）
  check('对照组：空地占一半时照建（闸门只拦"几乎没空地"）', () => {
    const stroke = line(0, 0, 1000, 0, 120);
    const res = BP.paintProvinceShape(pc, stroke, 20, [SQ(500, -200, 2000, 400)]);
    assert(!res.rejected, `不该被拒：${res.rejected} / ${res.message}`);
    assert(res.area > 10000, `面积太小：${res.area}`);
    return `面积 ${Math.round(res.area)}（少 ${(res.cutRatio * 100).toFixed(0)}%）`;
  });

  // ⑦ 环形笔迹围住一个省 = 带洞的省（洞必须保住，不能被并集填掉）
  check('围着已有省份画一圈：新省带洞，洞的面积 ≈ 里面那个省（洞不能被填掉）', () => {
    const inner = SQ(80, -50, 100, 100);          // 面积 10000
    const stroke = ringAround(130, 0, 110, 80);
    const res = BP.paintProvinceShape(pc, stroke, 16, [inner]);
    assert(!res.rejected, `被拒绝：${res.rejected}`);
    const ov = overlapArea(pc, res.multi, PB.provinceToMulti(inner));
    assert(ov < 1e-6, `⚠️ 新省压到里面的省：交集 ${ov}`);
    // 环有洞 → Polygon 的第一个环之外还有内环
    let holes = 0;
    for (const poly of res.multi) holes += Math.max(0, (poly || []).length - 1);
    assert(holes >= 1, `应有至少 1 个洞（内环），实际 ${holes}`);
    const bbox = PB.multiBBox(res.multi);
    const boxArea = (bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY);
    assert(res.area < boxArea * 0.75, `洞被填掉了：面积 ${Math.round(res.area)} vs 包围盒 ${Math.round(boxArea)}`);
    return `${holes} 个洞 / 净面积 ${Math.round(res.area)}`;
  });

  // ⑧ 确定性：同一笔重复算，面积逐位相同（不许掺随机数）
  check('确定性：同一笔算两次结果完全一致', () => {
    const stroke = line(0, 0, 150, 90, 30);
    const a = BP.paintProvinceShape(pc, stroke, 15, []);
    const b = BP.paintProvinceShape(pc, stroke, 15, []);
    assert(!a.rejected && !b.rejected, '不该被拒');
    assert(a.area === b.area, `两次面积不同：${a.area} vs ${b.area}`);
    return `面积 ${a.area.toFixed(3)}`;
  });

  // ⑨ 空笔迹 / 坏点：明确拒绝，不抛异常（画布手势里绝不能炸）
  check('空笔迹 / 全是坏点：明确拒绝（rejected），不抛异常', () => {
    const cases = [
      BP.paintProvinceShape(pc, [], 10, []),
      BP.paintProvinceShape(pc, [{ x: NaN, y: 1 }, { x: undefined, y: 2 }], 10, []),
    ];
    for (const r of cases) {
      assert(r.rejected, '应当被拒绝');
      assert(r.message, '拒绝必须带人话理由');
    }
    return cases.map((r) => r.rejected).join(' / ');
  });

  // ⑩ 反向探针：判据本身必须能抓到"压叠"（否则上面 ④ 是空转）
  check('反向探针：故意压着的两块能算出交集面积（④ 的判据不是空转）', () => {
    const a = [[[[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]]];
    const b = [[[[50, 0], [150, 0], [150, 100], [50, 100], [50, 0]]]];
    const ov = overlapArea(pc, a, b);
    assert(Math.abs(ov - 5000) < 1, `交集应 ≈ 5000，实际 ${ov}`);
    return `交集 ${ov}`;
  });

  report();
}

function report() {
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ 单测自身异常：', err && err.stack ? err.stack : err);
  process.exit(1);
});
