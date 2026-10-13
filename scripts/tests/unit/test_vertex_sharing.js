#!/usr/bin/env node
/**
 * Node 单元测试：共边顶点配对与联动移动（src/renderer/src/utils/vertexSharing.js）
 *
 * 为什么必须有这一层（2026-10-13，P1 顶点编辑）：
 *   「拖动共边顶点 → 邻省同位顶点跟着动 → 无缝无压叠」这件事的**全部风险都在配对判据上**：
 *     · 配错了 → 动了不该动的省（用户说的"串省"）；
 *     · 配漏了 → 拖完留一条缝（画布上看不出来，导出图里是白线）；
 *     · 差量算错 → 两侧本来重合的顶点被磨开（越拖缝越大）。
 *   这三条 CDP 用例都只能看像素，定位不到根因。本文件直接对纯函数下断言。
 *
 * 用法：node scripts/tests/unit/test_vertex_sharing.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 *
 * ⚠️ 被测试模块是 ESM 且有相对 import（./provinceShape）→ 与 test_province_shape.js 同法：
 *    把依赖复制到临时目录 + 补 `.js` 扩展名 + 写 `{"type":"module"}`，再用 file URL import。
 *    源码一个字符都不改。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const DEPS = ['vertexSharing.js', 'provinceShape.js', 'geometry.js', 'gridOutline.js'];

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
function eq(a, b, label) {
  if (a !== b) throw new Error(`${label}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
function near(a, b, tol, label) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${label}: 期望 ${b} ±${tol}，实际 ${a}`);
}

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

/**
 * 两块**共边**的省：A 的右边 = B 的左边（逐位相同的 5 个顶点）。
 *   A: (0,0) (100,0) (100,25) (100,50) (100,75) (100,100) (0,100)
 *   B: (100,0) (200,0) (200,100) (100,100) (100,75) (100,50) (100,25)
 * 共边 = x=100 上那 6 个顶点（y=0,25,50,75,100 + 两端），故意用**相反顺序**——
 * 真实数据里相邻两省的环绕向相反（`unionRingsByCancellation` 的注释就写了这条）。
 */
function twoProvinces() {
  const A = {
    id: 'A', name: 'A',
    points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 25 }, { x: 100, y: 50 },
      { x: 100, y: 75 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
  };
  const B = {
    id: 'B', name: 'B',
    points: [{ x: 100, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 100, y: 100 },
      { x: 100, y: 75 }, { x: 100, y: 50 }, { x: 100, y: 25 }],
  };
  return [A, B];
}

const sum = (pts) => pts.reduce((a, p) => a + p.x + p.y, 0);
const ringCoords = (pts) => pts.map((p) => `${p.x},${p.y}`).join(' ');

async function main() {
  const root = pickTmpRoot();
  if (!root) throw new Error('找不到可写的临时目录');
  const tmp = fs.mkdtempSync(path.join(root, 'sitian-vertshare-'));
  const fixExt = (src) => src.replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
  for (const f of DEPS) {
    fs.writeFileSync(path.join(tmp, f), fixExt(fs.readFileSync(path.join(SRC_DIR, f), 'utf8')));
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));

  const mod = await import(pathToFileURL(path.join(tmp, 'vertexSharing.js')).href);
  const {
    vertexKey, buildCoincidentIndex, findLinkedVertices, shiftPoints, verticesInBox, VERTEX_QUANTUM,
  } = mod;

  // ── 1. 索引与配对 ───────────────────────────────────────────────────────
  check('a1 索引：两块共边的省 → 共边上的顶点被认出是"共享"的', () => {
    const [A, B] = twoProvinces();
    const built = buildCoincidentIndex([A, B]);
    eq(built.total, 14, '顶点总数');
    // x=100 上 5 个位置（y=0,25,50,75,100）各有 2 个顶点 → 10 个共享顶点
    eq(built.shared, 10, '共享顶点数');
    return `total=${built.total} shared=${built.shared}`;
  });

  check('a2 配到邻省对应的 5 个同位顶点（含绕向相反的环）', () => {
    const [A, B] = twoProvinces();
    const built = buildCoincidentIndex([A, B]);
    const sel = [2, 3, 4];                       // A 的 y=25/50/75 —— 共边中段
    const r = findLinkedVertices([A, B], { provIdx: 0, ringIdx: 0 }, sel, built);
    eq(r.links.length, 3, '联动点数');
    eq(r.provinces.length, 1, '只该牵涉 1 个邻省');
    eq(r.links[0].provIdx, 1, '邻省是该省');
    // A[2]=(100,25) ↔ B[6]=(100,25)
    eq(r.links[0].vertexIdx, 6, 'A 的 y=25 应配到 B 的下标 6');
    near(r.links[0].dx, 0, 1e-9, '同位顶点无偏差');
    near(r.links[0].dy, 0, 1e-9, '同位顶点无偏差');
    return `links=${r.links.map((l) => l.vertexIdx).join(',')}`;
  });

  check('a3 不碰无关省：只共享一个角的第三块省不在联动集里（选中的不是那个角）', () => {
    const [A, B] = twoProvinces();
    const C = { id: 'C', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: -60 }, { x: 0, y: -60 }] };
    const built = buildCoincidentIndex([A, B, C]);
    // 选 A 的 y=50（只与 B 共边）→ C 不应出现
    const r = findLinkedVertices([A, B, C], { provIdx: 0, ringIdx: 0 }, [3], built);
    eq(r.links.length, 1, '只该牵涉 B');
    assert(r.provinces.indexOf(2) < 0, 'C 不该被牵涉（它只共享 (100,0)/(0,0) 那个角）');
    // 而选中那个角 (100,0) → A、B、C 三家都该动
    const r2 = findLinkedVertices([A, B, C], { provIdx: 0, ringIdx: 0 }, [1], built);
    eq(r2.provinces.length, 2, '角点上的那次拖动该牵涉 B 与 C 两家');
    return `中段=${r.links.length} 家角点=${r2.links.length} 点`;
  });

  check('a4 没有共边（海岸线 / 独苗省）→ 0 联动，且不报错', () => {
    const lone = [{ id: 'X', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }];
    const built = buildCoincidentIndex(lone);
    eq(built.shared, 0, '无共享顶点');
    const r = findLinkedVertices(lone, { provIdx: 0, ringIdx: 0 }, [0, 1, 2], built);
    eq(r.links.length, 0, '联动数应为 0');
    eq(r.provinces.length, 0, '不牵涉任何省');
    return '0 联动（如实回报，不静默兜底）';
  });

  check('a5 浮点尾差仍能配到（quantum 吸收 1e-3 以内的差）', () => {
    const A = { id: 'A', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100.0000004, y: 50 }, { x: 0, y: 50 }] };
    const B = { id: 'B', points: [{ x: 100, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 99.9999996, y: 50 }] };
    const built = buildCoincidentIndex([A, B]);
    // 4 个共享顶点 = (100,0) 那一对（精确相同）+ (100.0000004/99.9999996, 50) 那一对（带尾差）
    eq(built.shared, 4, '两对共边顶点都应算共享');
    const r = findLinkedVertices([A, B], { provIdx: 0, ringIdx: 0 }, [2], built);
    eq(r.links.length, 1, '应配到');
    // 差量 = 参考顶点 − 同位顶点 = 8e-7
    near(r.links[0].dx, 8e-7, 1e-12, '差量应精确记录两侧偏差');
    return `dx=${r.links[0].dx}`;
  });

  check('a6 反向探针：把 quantum 调到 0（精确比对）→ 尾差那对**必须**配不上', () => {
    const A = { id: 'A', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100.0000004, y: 50 }, { x: 0, y: 50 }] };
    const B = { id: 'B', points: [{ x: 100, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 99.9999996, y: 50 }] };
    const built = buildCoincidentIndex([A, B], { quantum: 1e-12 });
    const r = findLinkedVertices([A, B], { provIdx: 0, ringIdx: 0 }, [2], built, { quantum: 1e-12 });
    eq(r.links.length, 0, '精确比对下这一对不该配上（说明 a5 的成功不是空转）');
    return 'quantum=1e-12 → 0 联动（判据真的在看坐标）';
  });

  check('a7 联动顶点数有上限（病态数据不许把帧预算拖垮）', () => {
    // 30 个省在同一角点重合
    const provs = [];
    for (let i = 0; i < 30; i++) {
      provs.push({ id: `p${i}`, points: [{ x: 0, y: 0 }, { x: 10 + i, y: 0 }, { x: 10 + i, y: 10 + i }, { x: 0, y: 10 + i }] });
    }
    const built = buildCoincidentIndex(provs);
    const r = findLinkedVertices(provs, { provIdx: 0, ringIdx: 0 }, [0], built);
    assert(r.truncated === true, '超过上限必须回报 truncated（不静默截断）');
    assert(r.links.length <= 24, `联动数应被夹住，实际 ${r.links.length}`);
    return `links=${r.links.length} truncated=${r.truncated}`;
  });

  // ── 2. 差量平移 ─────────────────────────────────────────────────────────
  check('b1 只动被点名的下标，其余顶点逐坐标不变', () => {
    const [A] = twoProvinces();
    const before = ringCoords(A.points);
    const out = shiftPoints(A.points, [{ idx: 3, dx: -20, dy: 0 }]);
    eq(out[3].x, 80, '被拖的顶点');
    eq(ringCoords(A.points), before, '原数组必须一点不动（纯函数）');
    const unchanged = out.filter((_, i) => i !== 3).every((p, k) => {
      const idx = k < 3 ? k : k + 1;
      return p.x === A.points[idx].x && p.y === A.points[idx].y;
    });
    assert(unchanged, '其余顶点不该变');
    return `A[3] 100 → ${out[3].x}`;
  });

  check('b2 两侧各自平移自己的差量 → 拖完仍然**严格重合**（无缝的根本）', () => {
    const [A, B] = twoProvinces();
    const built = buildCoincidentIndex([A, B]);
    const sel = [2, 3, 4];
    const r = findLinkedVertices([A, B], { provIdx: 0, ringIdx: 0 }, sel, built);
    // 5 个共边顶点里拖中段 3 个：整条共边往 A 内侧挪 20
    const movesA = sel.map((i) => ({ idx: i, dx: -20, dy: 0 }));
    const movesB = r.links.map((l) => ({ idx: l.vertexIdx, dx: -20 + l.dx, dy: 0 + l.dy }));
    const A2 = shiftPoints(A.points, movesA);
    const B2 = shiftPoints(B.points, movesB);
    // 共边上的 5 个位置：y=0/100 两端没拖（只有 A[1] 与 A[5] 在共边上但没选中）
    for (const y of [25, 50, 75]) {
      const a = A2.find((p) => p.y === y);
      const b = B2.find((p) => p.y === y);
      assert(a && b, `y=${y} 两侧都应有顶点`);
      near(a.x, b.x, 1e-9, `y=${y} 重合度`);
    }
    // 未选中的两端没被碰
    near(A2[1].x, 100, 1e-9, 'A 的 y=0 端点未动');
    near(B2[0].x, 100, 1e-9, 'B 的 y=0 端点未动');
    return '拖后 x=100 → 80 的 3 个点两侧逐位重合';
  });

  check('b3 Bezier 控制点跟着顶点走（原样带上，不被丢掉）', () => {
    const pts = [
      { x: 0, y: 0 }, { x: 10, y: 0, controlOut: { x: 3, y: 1 } }, { x: 20, y: 0 },
    ];
    const out = shiftPoints(pts, [{ idx: 1, dx: 5, dy: 5 }]);
    eq(out[1].x, 15, 'x');
    eq(out[1].y, 5, 'y');
    eq(out[1].controlOut.x, 3, '控制点相对偏移不变');
    eq(out[1].controlOut.y, 1, '控制点相对偏移不变');
    assert(out[1].controlOut !== pts[1].controlOut, '必须是新对象（不共享引用）');
    return 'controlOut 原样随行';
  });

  check('b4 空位移表 / 越界下标 → 原样返回，不抛', () => {
    const pts = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
    eq(shiftPoints(pts, []).length, 2, '长度');
    const out = shiftPoints(pts, [{ idx: 99, dx: 1, dy: 1 }]);
    eq(out[0].x, 1, '越界下标被忽略');
    return 'ok';
  });

  // ── 3. 框选 ─────────────────────────────────────────────────────────────
  check('c1 框选按顶点当前位置命中（含边界上/反向拖框）', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 }, { x: 30, y: 30 }];
    eq(JSON.stringify(verticesInBox(pts, { x0: 5, y0: 5, x1: 25, y1: 25 })), JSON.stringify([1, 2]), '正框');
    eq(JSON.stringify(verticesInBox(pts, { x0: 25, y0: 25, x1: 5, y1: 5 })), JSON.stringify([1, 2]), '反向拖框同结果');
    eq(JSON.stringify(verticesInBox(pts, { x0: 0, y0: 0, x1: 0, y1: 0 })), JSON.stringify([0]), '压在一个顶点上也算命中');
    eq(verticesInBox(pts, { x0: 100, y0: 100, x1: 200, y1: 200 }).length, 0, '框外为空');
    return '4 种框都符合';
  });

  check('c2 反向探针：框选判据若改成"只看 x"→ 明显不同（判据不是恒真）', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 }];
    const box = { x0: 5, y0: 100, y1: 200, x1: 25 };
    eq(verticesInBox(pts, box).length, 0, 'y 全在框外 → 一个都不该命中');
    return 'y 范围真的参与判定';
  });

  // ── 4. 量级（真实库规模）─────────────────────────────────────────────────
  check('d1 性能：415 省 × ~60 点 建索引 + 单点配对 < 150ms', () => {
    const provs = [];
    for (let i = 0; i < 415; i++) {
      const x0 = (i % 25) * 40, y0 = Math.floor(i / 25) * 40;
      const pts = [];
      for (let k = 0; k <= 15; k++) pts.push({ x: x0, y: y0 + k * 4 });              // 左边 16 点
      for (let k = 0; k <= 15; k++) pts.push({ x: x0 + 40, y: y0 + k * 4 });         // 右边 16 点（与邻居共边）
      for (let k = 14; k >= 0; k--) pts.push({ x: x0 + 40, y: y0 + k * 4 + 2 });     // 制造 ~48 点/省
      provs.push({ id: `p${i}`, points: pts });
    }
    const t0 = Date.now();
    const built = buildCoincidentIndex(provs);
    // 右边缘（下标 17/18/19）与右边邻居的左边**逐位重合** → 必须配到人
    const r = findLinkedVertices(provs, { provIdx: 0, ringIdx: 0 }, [17, 18, 19], built);
    const dt = Date.now() - t0;
    assert(dt < 150, `耗时 ${dt}ms（应 < 150ms）`);
    assert(built.total > 15000, `顶点数应上万，实际 ${built.total}`);
    assert(r.links.length >= 3, `右边缘该配到邻省的 3 个同位顶点，实际 ${r.links.length}`);
    return `${built.total} 点 / ${built.shared} 共享 / 配对 ${r.links.length} 点 / ${dt}ms`;
  });

  // ── 汇总 ────────────────────────────────────────────────────────────────
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  const failed = results.filter((r) => !r.ok);
  console.log('=== 共边顶点联动（Node）单元测试 ===');
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
