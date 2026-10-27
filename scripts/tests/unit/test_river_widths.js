#!/usr/bin/env node
/**
 * Node 单元测试：河道逐点宽度（src/renderer/src/utils/riverWidths.js）
 *
 * 守两件事（2026-10-27「越汇越宽」）：
 *   · 流量按**最近段**投到平滑后的点列上（不是按归一化下标 —— 那会把汇流台阶抹成缓坡）；
 *   · 汇流点（流量跳升 ≥1.6×）下游宽度**至少**是上游 ×1.35，且封顶、非递减。
 *
 * 用法：node scripts/tests/unit/test_river_widths.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'riverWidths.js');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function near(a, b, m, eps = 1e-9) { if (Math.abs(a - b) > eps) throw new Error(`${m}: 期望 ${b}，实际 ${a}`); }

async function main() {
  const mod = await import('data:text/javascript;base64,'
    + Buffer.from(fs.readFileSync(SRC, 'utf8'), 'utf8').toString('base64'));
  const { flowAlongSmoothedPath, applyConfluenceSteps } = mod;

  check('r1 流量按最近段插值（直线中点 = 平均值，不按点序号）', () => {
    const src = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const flows = [10, 20];
    near(flowAlongSmoothedPath([{ x: 50, y: 0 }], src, flows)[0], 15, '中点');
    near(flowAlongSmoothedPath([{ x: 25, y: 0 }], src, flows)[0], 12.5, '1/4 处');
    near(flowAlongSmoothedPath([{ x: 0, y: 0 }], src, flows)[0], 10, '起点');
    near(flowAlongSmoothedPath([{ x: 100, y: 0 }], src, flows)[0], 20, '终点');
    return '10/12.5/15/20';
  });

  check('r2 平滑点偏离原线时用投影（Chaikin 的角点不会错配到别的段）', () => {
    // 一条拐弯的河：0,0 → 100,0 → 100,100；流量 10 → 40 → 90
    const src = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    const flows = [10, 40, 90];
    // 平滑后的点落在拐角附近偏内侧：(95, 10) —— 最近的应是第二段（t≈0.1）
    const got = flowAlongSmoothedPath([{ x: 95, y: 10 }], src, flows)[0];
    near(got, 45, '拐角内侧应取 40→90 的 10%', 1e-6);
    return `corner=${got}`;
  });

  check('r3 汇流台阶：流量跳升处下游 ≥ 上游 ×factor，且非递减', () => {
    const widths = [0.02, 0.02, 0.02, 0.02];
    const flows = [10, 10, 40, 40];
    const out = applyConfluenceSteps(widths, flows, { factor: 1.35, jumpRatio: 1.6 });
    assert(out[2] >= 0.02 * 1.35 - 1e-9, `台阶没生效：${out}`);
    for (let i = 1; i < out.length; i++) assert(out[i] >= out[i - 1] - 1e-12, '必须非递减');
    assert(out[0] === 0.02 && out[1] === 0.02, '跳升前不该被改');
    return out.map((v) => v.toFixed(3)).join(',');
  });

  check('r4 平缓增长不算汇流（不许把正常沿程增宽改成台阶）', () => {
    const widths = [0.02, 0.024, 0.029, 0.035];
    const flows = [10, 12, 14, 17];   // 每步 <1.6×
    const out = applyConfluenceSteps(widths, flows, { factor: 1.35, jumpRatio: 1.6 });
    assert(JSON.stringify(out) === JSON.stringify(widths), `不该动：${out}`);
    return 'unchanged';
  });

  check('r5 封顶与退化输入：不超过 cap、空数组/单点/脏流量不抛', () => {
    const out = applyConfluenceSteps([0.04, 0.04], [10, 40], { factor: 2, cap: 0.05 });
    assert(out[1] <= 0.05 + 1e-12, `封顶失效：${out[1]}`);
    assert(JSON.stringify(applyConfluenceSteps([], [])) === '[]', '空数组');
    assert(JSON.stringify(applyConfluenceSteps([0.1], [5])) === '[0.1]', '单点');
    // 非有限流量：不制造 NaN
    const dirty = applyConfluenceSteps([0.02, 0.02], [NaN, undefined]);
    assert(dirty.every((v) => Number.isFinite(v)), `出 NaN 了：${dirty}`);
    // 源点不足 2 个 → 全部回落 fallback
    const fb = flowAlongSmoothedPath([{ x: 1, y: 1 }, { x: 2, y: 2 }], [{ x: 0, y: 0 }], [7], 3);
    assert(fb.length === 2 && fb[0] === 3 && fb[1] === 3, `fallback 失效：${fb}`);
    return `cap=${out[1].toFixed(3)}`;
  });

  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
