#!/usr/bin/env node
/**
 * Node 单元测试：河流「实心变宽丝带」（src/renderer/src/utils/riverRender.js）
 *
 * 为什么单独守这一块（2026-10-20 第十七修）：
 *   用户对河流的最高频投诉是「铁轨 / 竹节 / 描点连线」。技术成因是**逐段描边**——
 *   每一小段一次 beginPath/stroke，接头靠圆帽补，段宽突变时出现横向接缝；放大后
 *   两条岸线 + 中间一条缝就是"铁轨"。
 *   修法是把一条河画成**一个闭合多边形**（左岸正向 + 右岸反向）+ 一次 fill。
 *   这个性质在 CDP 像素用例里只能"看着像"，在这里可以直接数调用次数。
 *
 * 判据：
 *   ① 顶点数 = 2 × 中心线点数（左岸 + 右岸），且闭合多边形**不重复首点**；
 *   ② 等宽直线的丝带包围盒高度 = 宽度（不偏、不缩）；
 *   ③ 变宽（源头细 → 河口粗）时两侧偏移真的跟着变；
 *   ④ `fillRiverRibbon` 对一条 40 点河**只**调用一次 fill（不是 39 次 stroke）；
 *   ⑤ 退化输入（0/1 点、宽度非法）返回空，不抛异常。
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
  const calls = { fill: 0, stroke: 0, beginPath: 0, moveTo: 0, lineTo: 0, closePath: 0, lineWidth: [] };
  return {
    calls,
    lineJoin: '', lineCap: '', globalAlpha: 1, fillStyle: '', strokeStyle: '',
    set lineWidth(v) { calls.lineWidth.push(v); },
    get lineWidth() { return calls.lineWidth[calls.lineWidth.length - 1] || 0; },
    save() {}, restore() {}, beginPath() { calls.beginPath++; }, moveTo() { calls.moveTo++; },
    lineTo() { calls.lineTo++; }, closePath() { calls.closePath++; },
    fill() { calls.fill++; }, stroke() { calls.stroke++; },
  };
}

function bbox(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
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
  const tmp = fs.mkdtempSync(path.join(root, 'sitian-river-ribbon-'));
  const IMPORT_RE = /from '\.\/([A-Za-z0-9_-]+)(\.js)?'/g;
  const fixExt = (src) => src.replace(IMPORT_RE, "from './$1.js'");
  // 把 riverRender.js 的**本地依赖闭包**一起拷过去（它 import './rivers.js' 等）
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

  check('一：等宽直线 → 2N 个顶点，包围盒高度 = 宽度', () => {
    const pts = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }];
    const poly = RR.variableRibbon(pts, 4);
    assert(poly.length === 6, `顶点数应为 6（2×3），实际 ${poly.length}`);
    const bb = bbox(poly);
    assert(Math.abs(bb.h - 4) < 1e-6, `直线丝带高度应 = 宽度 4，实际 ${bb.h}`);
    assert(Math.abs(bb.w - 100) < 1e-6, `丝带长度应 = 100，实际 ${bb.w}`);
    return `${poly.length} 点 / bbox ${bb.w.toFixed(1)}×${bb.h.toFixed(1)}`;
  });

  check('二：变宽（源头 1 → 河口 9）时两侧偏移真的跟着变', () => {
    const pts = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }];
    const poly = RR.variableRibbon(pts, [1, 5, 9]);
    // 左岸前 3 点、右岸后 3 点（右岸已反向 → 最后一点对应源头）
    const head = poly[0];
    const mouth = poly[2];
    const headH = Math.abs(head.y);
    const mouthH = Math.abs(mouth.y);
    assert(Math.abs(headH - 0.5) < 1e-6, `源头半宽应 = 0.5，实际 ${headH}`);
    assert(Math.abs(mouthH - 4.5) < 1e-6, `河口半宽应 = 4.5，实际 ${mouthH}`);
    return `源头 ${headH} → 河口 ${mouthH}`;
  });

  check('三：一条 40 点河只 fill 一次（不是 39 次 stroke）', () => {
    const c = stubCtx();
    const pts = Array.from({ length: 40 }, (_, i) => ({ x: i * 10, y: Math.sin(i / 5) * 20 }));
    const widths = pts.map((_, i) => 1 + i * 0.2);
    const n = RR.fillRiverRibbon(c, pts, widths, { color: '#5d97bb', bankWidth: 0.8 });
    assert(n > 0, '应画出顶点');
    assert(c.calls.fill === 1, `fill 次数应为 1，实际 ${c.calls.fill}`);
    assert(c.calls.stroke === 1, `岸线 stroke 次数应为 1（同一个多边形），实际 ${c.calls.stroke}`);
    assert(c.calls.beginPath === 1, `beginPath 次数应为 1，实际 ${c.calls.beginPath}`);
    assert(c.calls.moveTo === 1, `moveTo 次数应为 1，实际 ${c.calls.moveTo}`);
    assert(c.calls.lineTo === n - 1, `lineTo 次数应 = 顶点数-1（首点 moveTo），应 ${n - 1}，实际 ${c.calls.lineTo}`);
    return `${n} 点 / fill×${c.calls.fill} / stroke×${c.calls.stroke} / beginPath×${c.calls.beginPath}`;
  });

  check('四：退化输入 → 空数组，不抛异常', () => {
    assert(RR.variableRibbon([], 2).length === 0, '空点集应为空');
    assert(RR.variableRibbon([{ x: 0, y: 0 }], 2).length === 0, '单点应为空');
    const poly = RR.variableRibbon([{ x: 0, y: 0 }, { x: 10, y: 0 }], [0, NaN]);
    assert(poly.length === 4, '非法宽度应回落到最小半宽而不是崩');
    const c = stubCtx();
    assert(RR.fillRiverRibbon(c, [], [], {}) === 0, '空输入不应画');
    return `${poly.length} 点兜底`;
  });

  check('五：折线拐角处两侧不交叉（法线取前后段平均）', () => {
    // 90° 直角：如果按"单段法线"推，拐点两侧会各算一次 → 出现自交的蝴蝶结
    const pts = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }];
    const poly = RR.variableRibbon(pts, 6);
    const bb = bbox(poly);
    assert(bb.w <= 56 + 1e-6 && bb.h <= 56 + 1e-6, `拐角外扩不应超过半宽（${bb.w}×${bb.h}）`);
    // 拐点（第 2 个中心点）两侧点 → 中点应仍在中心线上
    const l = poly[1], r = poly[poly.length - 2];
    assert(Math.abs((l.x + r.x) / 2 - 50) < 1e-6 && Math.abs((l.y + r.y) / 2) < 1e-6,
      `拐点两侧的中点应 = 中心点 (50,0)，实际 (${(l.x + r.x) / 2},${(l.y + r.y) / 2})`);
    return `bbox ${bb.w.toFixed(1)}×${bb.h.toFixed(1)}`;
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
