#!/usr/bin/env node
/**
 * Node 单元测试：沿路径排字（src/renderer/src/utils/textOnPath.js）
 *
 * 这是"山系名沿山脊 / 河名沿河"的几何层。守四件事：
 *   · 字距均匀、整段**居中**（参考图的山名都居中在脊线上，不是从端点开始写）；
 *   · 路径不够长 → 明确失败（调用方据此换字号/放弃，**不许压缩字距**糊上去）；
 *   · 朝左的路径要反过来读（字不能倒着写）；
 *   · 切线过陡的字跳过，其余照排（不整条丢）。
 *
 * 用法：node scripts/tests/unit/test_text_on_path.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'textOnPath.js');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, l) { if (a !== b) throw new Error(`${l}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }

const line = (x0, y0, x1, y1, n = 2) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    out.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t });
  }
  return out;
};

async function main() {
  const mod = await import('data:text/javascript;base64,'
    + Buffer.from(fs.readFileSync(SRC, 'utf8'), 'utf8').toString('base64'));
  const { layoutTextAlongPath, pathLength, estimateCharWidth } = mod;

  check('t1 水平直线：4 个字居中、角度 0、字距均匀', () => {
    const pts = line(0, 100, 200, 100);
    const out = layoutTextAlongPath('ABCD', pts, { fontSize: 10, letterSpacing: 2 });
    eq(out.ok, true, '放得下');
    eq(out.placed.length, 4, '字数');
    const xs = out.placed.map((p) => p.x);
    for (const a of out.placed) assert(Math.abs(a.angle) < 1e-9, `角度应为 0：${a.angle}`);
    for (let i = 1; i < xs.length; i++) {
      assert(Math.abs((xs[i] - xs[i - 1]) - (out.placed[0].ch ? xs[1] - xs[0] : 0)) < 1e-6, '字距应均匀');
    }
    const span = xs[xs.length - 1] - xs[0];
    assert(Math.abs((xs[0] + xs[xs.length - 1]) / 2 - 100) < 1e-6, `应居中于 100（实际 ${(xs[0] + xs[xs.length - 1]) / 2}）`);
    return `span=${span.toFixed(1)} 居中=100`;
  });

  check('t2 路径太短：ok=false、一个字都不给（绝不压缩字距糊上去）', () => {
    const out = layoutTextAlongPath('ABCDEFGH', line(0, 0, 20, 0), { fontSize: 12 });
    eq(out.ok, false, '应失败');
    eq(out.placed.length, 0, '不排字');
    return `width=${out.width.toFixed(0)} path=${out.pathLength}`;
  });

  check('t3 朝左的路径：先反序，字仍是正的（角度≈0，不是 π）', () => {
    const out = layoutTextAlongPath('AB', line(200, 50, 0, 50), { fontSize: 10 });
    eq(out.placed.length, 2, '两个字');
    assert(Math.abs(out.placed[0].angle) < 1e-6, `角度应≈0：${out.placed[0].angle}`);
    assert(out.placed[0].x < out.placed[1].x, '字应从左到右');
    return `x=${out.placed.map((p) => p.x.toFixed(0)).join(',')}`;
  });

  check('t4 自定义字宽：measure 生效（宽字占更多弧长）', () => {
    const out = layoutTextAlongPath('WW', line(0, 0, 100, 0), { measure: () => 30, letterSpacing: 0 });
    const d = out.placed[1].x - out.placed[0].x;
    assert(Math.abs(d - 30) < 1e-6, `中心距应为 30（实际 ${d}）`);
    return `center gap=${d}`;
  });

  check('t5 陡坡上的字：跳过而不是画成竖字，其余照排', () => {
    // 一条 90° 竖直的路径：所有字都应被跳过（maxTilt 默认 70°）
    const out = layoutTextAlongPath('AB', line(0, 0, 0, 200), { fontSize: 10 });
    eq(out.placed.length, 0, '竖线上不排字');
    eq(out.ok, false, 'ok 应为 false');
    return '0/2';
  });

  check('t6 退化输入：空文本 / 单点 / 空数组不抛', () => {
    eq(layoutTextAlongPath('', line(0, 0, 10, 0)).placed.length, 0, '空文本');
    eq(layoutTextAlongPath('AB', [{ x: 1, y: 1 }]).placed.length, 0, '单点');
    eq(layoutTextAlongPath('AB', []).placed.length, 0, '空数组');
    eq(pathLength([]), 0, '长度 0');
    return '0';
  });

  check('t7 字宽估算：CJK 按 1em、拉丁按 0.55em', () => {
    eq(estimateCharWidth('山', 10), 10, 'CJK');
    assert(Math.abs(estimateCharWidth('A', 10) - 5.5) < 1e-9, '拉丁');
    return '10 / 5.5';
  });

  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
