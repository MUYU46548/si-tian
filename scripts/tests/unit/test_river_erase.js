#!/usr/bin/env node
/**
 * Node 单元测试：河流橡皮的**纯几何**（`src/renderer/src/utils/riverErase.js`）
 *
 * 为什么必须有这一层：橡皮的判定全在几何里（擦掉哪一段、断成几段、切口落在哪、
 * 短段丢不丢），而 CDP 用例只能看"河从几条变几条"。这里直接对纯函数下断言 ——
 * 尤其是**两种画法必须一致**的关系：节点判定 vs 逐段判定（后者是产品的口径）。
 *
 * 用法：node scripts/tests/unit/test_river_erase.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'riverErase.js');

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

/** 沿 x 轴的等距折线：n 个点，间距 step（世界单位） */
const line = (n, step = 10, y0 = 0) => Array.from({ length: n }, (_, i) => ({ x: i * step, y: y0 }));

function pickTmpRoot() {
  const cands = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : '',
    os.tmpdir(), process.env.TEMP, process.env.TMP, os.homedir(),
  ];
  for (const c of cands) {
    if (!c || !path.isAbsolute(c)) continue;
    if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(c)) continue;
    try { fs.mkdirSync(c, { recursive: true }); fs.accessSync(c, fs.constants.W_OK); return c; } catch (_) { /* next */ }
  }
  return null;
}

async function main() {
  const root = pickTmpRoot();
  if (!root) throw new Error('找不到可写的临时目录');
  const tmp = fs.mkdtempSync(path.join(root, 'sitian-erase-'));
  fs.writeFileSync(path.join(tmp, 'riverErase.js'), fs.readFileSync(SRC, 'utf8'));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const mod = await import(pathToFileURL(path.join(tmp, 'riverErase.js')).href);
  const { erasePolylineByStroke, planRiverErase, distanceToStroke, strokeBounds } = mod;

  check('擦中间：一条直线被擦断成两段，切口贴着橡皮圈边', () => {
    const pts = line(11, 10);                       // x = 0..100
    const stroke = [{ x: 50, y: -30 }, { x: 50, y: 30 }];   // 竖着抹过 x=50
    const res = erasePolylineByStroke(pts, stroke, 12);
    assert(res.touched, '应该算擦到了');
    assert(res.runs.length === 2 || res.runs.length === 3,
      `x=50 落在节点上（节点间距 10）→ 可能擦掉 1 或 2 个节点，结果 ${res.runs.length} 段`);
    // 所有留下来点的 x 都必须在橡皮圈外（严格 >= radius 距离）
    for (const run of res.runs) {
      for (const p of run) {
        const d = distanceToStroke(p.x, p.y, stroke);
        assert(d >= 12 - 1e-6, `留下来的点 (${p.x},${p.y}) 距轨迹 ${d} < 半径 12 —— 擦不干净`);
      }
    }
    // 段与段之间的缺口必须真的跨过橡皮
    const xs = res.runs.flat().map((p) => p.x).sort((a, b) => a - b);
    assert(xs.length < pts.length, '点数应当变少');
    return `${pts.length} 点 → ${res.runs.length} 段（共 ${xs.length} 点）`;
  });

  check('擦末端：只短一截，不产生第二条河', () => {
    const pts = line(11, 10);
    const stroke = [{ x: 115, y: 0 }];              // 离末点 15 世界单位（半径 25 之内）
    const res = erasePolylineByStroke(pts, stroke, 25);
    assert(res.touched, '应命中（末点距轨迹 15 < 25）');
    assert(res.runs.length === 1, `只应剩 1 段，实际 ${res.runs.length}`);
    assert(res.runs[0][0].x === 0, '左端必须原样保留');
    const last = res.runs[0][res.runs[0].length - 1];
    assert(last.x >= 85 && last.x <= 95, `右端应切在圈边（≈90），实际最后一点 x=${last.x}`);
    return `11 点 → 1 段（${res.runs[0].length} 点，末点 x=${last.x}）`;
  });

  check('整条被擦干净 → 零段（调用方据此删河）', () => {
    const pts = line(5, 10);
    const stroke = [{ x: -20, y: 0 }, { x: 100, y: 0 }];    // 沿着整条线抹过去
    const res = erasePolylineByStroke(pts, stroke, 30);
    assert(res.touched, '应命中');
    assert(res.runs.length === 0, `整条都被擦掉时应剩 0 段，实际 ${res.runs.length}`);
    return `${pts.length} 点全部擦除`;
  });

  check('边界口径：距离**恰好等于**半径不算命中（与仓里阈值口径一致）', () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    // 轨迹在 (50, 20)，点到轨迹距离 = 20
    const stroke = [{ x: 50, y: 20 }];
    const equal = erasePolylineByStroke(pts, stroke, 20);
    assert(!equal.touched, '半径 = 距离时不该命中（严格小于）');
    const over = erasePolylineByStroke(pts, stroke, 20.5);
    assert(over.touched, '半径略大就该命中');
    return 'd == r 不命中 / d < r 命中';
  });

  check('没碰到 → touched=false，调用方一个字节都不写（不压空撤销）', () => {
    const pts = line(6, 10);
    const res = erasePolylineByStroke(pts, [{ x: 0, y: 500 }], 12);
    assert(!res.touched, '离得远不该算命中');
    assert(res.runs.length === 1 && res.runs[0].length === 6, '未命中时应原样返回');
    return '未命中：原样 6 点 / touched=false';
  });

  check('🔴 稀疏节点也擦得断（只判节点的实现会在这里漏）', () => {
    // 节点间距 100（远超橡皮直径 40）—— 只判节点的话，抹在两点正中间时两个端点都出圈 → 漏
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }];
    const stroke = [{ x: 50, y: -20 }, { x: 50, y: 20 }];   // 抹在 0 与 100 的中间
    const res = erasePolylineByStroke(pts, stroke, 20);
    assert(res.touched, '🔴 节点都出圈但线段穿过了橡皮 —— 必须算命中（这是"橡皮没反应"的根因）');
    assert(res.runs.length === 2, `应断成两段，实际 ${res.runs.length}`);
    const left = res.runs[0];
    assert(left[0].x === 0, '左段必须从原节点 x=0 起');
    const leftEnd = left[left.length - 1].x;
    assert(leftEnd >= 25 && leftEnd <= 35, `左段切口应落在圈边（≈30），实际 ${leftEnd}`);
    assert(left.length <= 3, `左段不该被虚拟采样点摊爆（实际 ${left.length} 点：${left.map((p) => p.x)}）`);
    return `间距 100 的 3 点被抹断成 ${res.runs.length} 段（左段 ${left.length} 点，切口 x=${leftEnd}）`;
  });

  check('切口落在圈边（不是整段消失）：留下的段端点到轨迹距离 ≈ 半径', () => {
    const pts = [{ x: 0, y: 0 }, { x: 200, y: 0 }];
    const stroke = [{ x: 100, y: -50 }, { x: 100, y: 50 }];
    const res = erasePolylineByStroke(pts, stroke, 20);
    assert(res.runs.length === 2, `应断成两段，实际 ${res.runs.length}`);
    const right = res.runs[1];
    const d = distanceToStroke(right[0].x, right[0].y, stroke);
    assert(Math.abs(d - 20) <= 6, `切口到轨迹的距离应≈半径 20（允许半个采样步长），实际 ${d.toFixed(2)}`);
    return `右段首点 x=${right[0].x.toFixed(2)}（距轨迹 ${d.toFixed(2)}，半径 20）`;
  });

  check('planRiverErase：断成两段 = 一段改 + 一段加；整条擦净 = 删', () => {
    const rivers = [
      { id: 'river_a', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }], width: 3.5 },
      { id: 'river_b', points: [{ x: 0, y: 100 }, { x: 100, y: 100 }], width: 2 },
      { id: 'river_c', points: [{ x: 0, y: 300 }, { x: 100, y: 300 }], width: 2 },
    ];
    const plan = planRiverErase(rivers, [{ x: 100, y: -40 }, { x: 100, y: 40 }], 20);
    assert(plan.patches.length === 1 && plan.patches[0].id === 'river_a', 'a 应被"改"（保 id）');
    assert(plan.adds.length === 1, `a 的后半段应作为新河加一条，实际 ${plan.adds.length}`);
    assert(Math.abs(plan.adds[0].width - 3.5) < 1e-9, '新段必须继承原宽度');
    assert(plan.removes.length === 0, 'b/c 离得远，不该被删');
    const plan2 = planRiverErase(rivers, [{ x: -50, y: 100 }, { x: 150, y: 100 }], 30);
    assert(plan2.removes.includes('river_b'), 'b 被整条擦掉 → 进 removes');
    assert(!plan2.patches.some((p) => p.id === 'river_b'), 'b 不该同时出现在 patches（僵尸写）');
    return `断成两段：改 ${plan.patches.length} / 加 ${plan.adds.length} / 删 ${plan.removes.length}；整条擦净 → removes=${plan2.removes.join(',')}`;
  });

  check('strokeBounds：带 pad 的包围盒（快速否定的依据）', () => {
    const b = strokeBounds([{ x: 10, y: 20 }, { x: 30, y: -5 }], 4);
    assert(b.minX === 6 && b.maxX === 34 && b.minY === -9 && b.maxY === 24,
      `包围盒不对：${JSON.stringify(b)}`);
    assert(strokeBounds([], 4) === null, '空轨迹应返回 null');
    return JSON.stringify(b);
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✅' : '🔴'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 留着 */ }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('🔴 测试自身异常：', (err && err.stack) || err);
  process.exit(1);
});
