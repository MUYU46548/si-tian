#!/usr/bin/env node
/**
 * Node 单元测试：河流画法（src/renderer/src/utils/riverRender.js）
 *
 * 2026-10-20 第十九修：河流唯一的画法是 `strokeTaperedLine`（中心线**分块描边**）。
 * 上一版是"左右岸合成一个多边形再一次 fill"—— 实测真实项目 **90/90 条河都自交**
 * （弯急处左右偏移互相穿过），nonzero 填充在交叠处抵消成洞 → 屏幕上就是
 * 「两条边夹一条缝」，放大后更明显（用户截图）。
 *
 * 本用例守的就是"结构上不可能出洞"：
 *   ① 只描边、**一次 fill 都不调**（有 fill = 又回到多边形路线）；
 *   ② 分块数 = chunks，块与块共享端点（圆帽接缝）；
 *   ③ 宽度按块中点取值，块内恒定（不会出现锯齿状宽度跳变）；
 *   ④ 退化输入不抛异常；
 *   ⑤ 圆角器真的把拐角磨圆（平均转角下降）、端点不动。
 *
 * 用法：node scripts/tests/unit/test_river_ribbon.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils');

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

/** 记录式 canvas stub（本仓不依赖原生 canvas） */
function stubCtx() {
  const calls = { fill: 0, stroke: 0, beginPath: 0, moveTo: 0, lineTo: 0, closePath: 0, lineWidth: [], alphas: [] };
  let alpha = 1;
  return {
    calls,
    lineJoin: '', lineCap: '', fillStyle: '', strokeStyle: '',
    get globalAlpha() { return alpha; },
    set globalAlpha(v) { calls.alphas.push(v); alpha = v; },
    set lineWidth(v) { calls.lineWidth.push(v); },
    get lineWidth() { return calls.lineWidth[calls.lineWidth.length - 1] || 0; },
    save() {}, restore() {}, beginPath() { calls.beginPath++; }, moveTo() { calls.moveTo++; },
    lineTo() { calls.lineTo++; }, closePath() { calls.closePath++; },
    fill() { calls.fill++; }, stroke() { calls.stroke++; },
  };
}

/** 折线的最大转角（度） */
function maxTurn(pts) {
  let m = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const v1 = Math.atan2(b.y - a.y, b.x - a.x);
    const v2 = Math.atan2(c.y - b.y, c.x - b.x);
    let d = Math.abs(v2 - v1);
    if (d > Math.PI) d = 2 * Math.PI - d;
    m = Math.max(m, d);
  }
  return (m * 180) / Math.PI;
}

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
  const tmp = fs.mkdtempSync(path.join(root, 'sitian-river-stroke-'));
  const IMPORT_RE = /from '\.\/([A-Za-z0-9_-]+)(\.js)?'/g;
  const fixExt = (src) => src.replace(IMPORT_RE, "from './$1.js'");
  const seen = new Set();
  const queue = ['riverRender.js'];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    const full = path.join(SRC, f);
    if (!fs.existsSync(full)) continue;
    const code = fs.readFileSync(full, 'utf8');
    fs.writeFileSync(path.join(tmp, f), fixExt(code));
    for (const m of code.matchAll(IMPORT_RE)) queue.push(`${m[1]}.js`);
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const RR = await import(pathToFileURL(path.join(tmp, 'riverRender.js')).href);

  check('一：分块描边 = chunks 次 stroke、**一次 fill 都没有**（结构上不可能出洞）', () => {
    const c = stubCtx();
    const pts = Array.from({ length: 40 }, (_, i) => ({ x: i * 10, y: Math.sin(i / 5) * 20 }));
    const widths = pts.map((_, i) => 1 + i * 0.1);
    const n = RR.strokeTaperedLine(c, pts, widths, { color: '#5d97bb', chunks: 8 });
    assert(n === 8, `块数应为 8，实际 ${n}`);
    assert(c.calls.stroke === 8, `stroke 次数应为 8，实际 ${c.calls.stroke}`);
    assert(c.calls.fill === 0, `不该有 fill（多边形路线会自交出洞），实际 ${c.calls.fill}`);
    assert(c.calls.closePath === 0, '不该 closePath（开放折线）');
    assert(c.calls.beginPath === 8, `beginPath 次数应为 8，实际 ${c.calls.beginPath}`);
    return `${n} 块 / stroke×${c.calls.stroke} / fill×${c.calls.fill}`;
  });

  check('二：宽度取自块中点、块内恒定；首尾块分别接近头/尾宽度', () => {
    const c = stubCtx();
    const pts = Array.from({ length: 33 }, (_, i) => ({ x: i * 10, y: 0 }));
    const widths = pts.map((_, i) => 2 + i * 0.5);   // 2 → 18
    RR.strokeTaperedLine(c, pts, widths, { chunks: 4 });
    const ws = c.calls.lineWidth;
    assert(ws.length === 4, `4 块应有 4 个 lineWidth，实际 ${ws.length}`);
    assert(ws[0] >= 2 && ws[0] <= 8, `第一块宽度应靠近源头（2~8），实际 ${ws[0]}`);
    assert(ws[3] >= 12 && ws[3] <= 18, `最后一块应靠近河口（12~18），实际 ${ws[3]}`);
    assert(ws[0] < ws[1] && ws[1] < ws[2] && ws[2] < ws[3], `宽度必须单调递增：${ws.join(',')}`);
    return `宽度 ${ws.map((x) => x.toFixed(1)).join(' → ')}`;
  });

  check('三：退化输入（空/单点/非法宽度）不抛异常', () => {
    const c = stubCtx();
    assert(RR.strokeTaperedLine(c, [], [], {}) === 0, '空点集应为 0');
    assert(RR.strokeTaperedLine(c, [{ x: 0, y: 0 }], 2, {}) === 0, '单点应为 0');
    assert(RR.strokeTaperedLine(null, [{ x: 0, y: 0 }, { x: 1, y: 1 }], 2, {}) === 0, 'ctx 为空应为 0');
    RR.strokeTaperedLine(c, [{ x: 0, y: 0 }, { x: 10, y: 0 }], [NaN, 0], { chunks: 1 });
    assert(c.calls.lineWidth.every((w) => w >= 0.35), `非法宽度应回落到 ≥0.35，实际 ${c.calls.lineWidth.join(',')}`);
    return `兜底宽度 ${c.calls.lineWidth[c.calls.lineWidth.length - 1]}`;
  });

  check('四：圆角器把拐角磨圆、端点不动', () => {
    const raw = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }];
    const smooth = RR.smoothRiverLine(raw, 4);
    assert(smooth.length > raw.length, `圆角后点数应增加：${raw.length} → ${smooth.length}`);
    assert(smooth[0].x === 0 && smooth[0].y === 0, '起点必须不动');
    const last = smooth[smooth.length - 1];
    assert(last.x === 0 && last.y === 50, `终点必须不动，实际 (${last.x},${last.y})`);
    const before = maxTurn(raw);
    const after = maxTurn(smooth);
    assert(after < before - 10, `最大转角应明显下降：${before.toFixed(0)}° → ${after.toFixed(0)}°`);
    return `转角 ${before.toFixed(0)}° → ${after.toFixed(0)}° / ${raw.length} → ${smooth.length} 点`;
  });

  check('五：河身默认**不透明**（分块圆帽接缝叠自己不能把颜色压深）', () => {
    const c = stubCtx();
    const pts = Array.from({ length: 40 }, (_, i) => ({ x: i * 10, y: 0 }));
    const widths = pts.map(() => 2);
    RR.strokeTaperedLine(c, pts, widths, { chunks: 6 });
    assert(c.calls.stroke === 6, `应有 6 次 stroke，实际 ${c.calls.stroke}`);
    assert(c.calls.alphas.every((a) => a === 1),
      `默认必须不透明（每块 globalAlpha=1），实际 ${c.calls.alphas.join(',')}`);
    // 显式要半透明（预览/草稿）仍要生效 —— 默认值改了不等于把能力删了
    const c2 = stubCtx();
    RR.strokeTaperedLine(c2, pts, widths, { chunks: 2, alpha: 0.85 });
    assert(c2.calls.alphas.every((a) => a === 0.85), `显式 alpha 应生效，实际 ${c2.calls.alphas.join(',')}`);
    return `默认 ${c.calls.alphas[0]} / 显式 ${c2.calls.alphas[0]}`;
  });

  check('六：同一段河道不被两条河各画一遍（宽河先画、窄河去重；横穿不误伤）', () => {
    const line = (x0, x1, y, n) => Array.from({ length: n }, (_, i) =>
      ({ x: x0 + (x1 - x0) * i / (n - 1), y }));
    const wide = { points: line(0, 100, 0, 101), widthPx: 4 };
    const thin = { points: line(-30, 130, 2, 161), widthPx: 2 };
    const plans = RR.planRiverCoveredRuns([thin, wide], { dist: 6 });
    assert(plans[1].length === 1, `宽河应整条画：${JSON.stringify(plans[1])}`);
    assert(plans[0].length === 2, `窄河应被切成两段（源头/河口各一段）：${JSON.stringify(plans[0])}`);
    const kept = plans[0].reduce((a, [s, e]) => a + (e - s), 0);
    assert(kept < 161 && kept > 40, `被盖住的中段必须跳过（剩 ${kept}/161）`);
    // 横穿的支流：方向垂直 → 方向判据放过，不许被吃掉
    const cross = { points: line(50, 50, -30, 40).map((p, i) => ({ x: 50, y: -30 + i * (60 / 39) })), widthPx: 1 };
    const crossPlans = RR.planRiverCoveredRuns([cross, wide], { dist: 6 });
    assert(crossPlans[0].length === 1 && crossPlans[0][0][1] === 40,
      `横穿的河必须整条保留：${JSON.stringify(crossPlans[0])}`);
    return `窄河剩 ${kept}/161 点；横穿整条保留`;
  });

  check('七：uncoveredIndexRuns 的边界（全空/夹花/全盖/单点段）', () => {
    assert(JSON.stringify(RR.uncoveredIndexRuns(5, () => false)) === '[[0,5]]', '全空 → 一整段');
    assert(JSON.stringify(RR.uncoveredIndexRuns(5, () => true)) === '[]', '全盖 → 空');
    assert(JSON.stringify(RR.uncoveredIndexRuns(5, (i) => i === 2)) === '[[0,2],[3,5]]', '中间盖住 → 两段');
    // 只留一个孤立点：画不出线 → 丢掉
    assert(JSON.stringify(RR.uncoveredIndexRuns(3, (i) => i !== 1)) === '[]', '单点段必须丢掉');
    return '四种边界都对';
  });

  check('八：导入河「去 + 原路回」的闭合路径折成一条中心线', () => {
    const outbound = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 1 }, { x: 30, y: 2 }];
    const roundTrip = outbound.concat(outbound.slice(0, -1).reverse().map((p) => ({ ...p })));
    const got = RR.collapseReversedRiverPoints(roundTrip);
    assert(got.length === outbound.length, `往返路径应折成 ${outbound.length} 点，实际 ${got.length}`);
    assert(got[got.length - 1].x === 30, `折返点必须保留，实际 ${JSON.stringify(got[got.length - 1])}`);
    const normal = Array.from({ length: 20 }, (_, i) => ({ x: i * 4, y: Math.sin(i) }));
    assert(RR.collapseReversedRiverPoints(normal).length === 20, '正常单程路径不许被折');
    return `往返 ${roundTrip.length} → ${got.length} 点；单程原样`;
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('用例自身崩溃：', err);
  process.exit(1);
});
