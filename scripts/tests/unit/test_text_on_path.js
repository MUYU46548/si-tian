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
  const { layoutTextAlongPath, pathLength, estimateCharWidth, slicePathAroundPoint } = mod;

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

  // ── 河名沿河（2026-10-27）：先取「落点附近的一段河道」，再沿它排字 ──
  check('t8 窗口以落点的**最近投影**为中心（不是整条河的中点）', () => {
    // 一条 1000 长的水平河；落点在 x=800 附近 → 窗口应落在 [750,850] 一带，而不是 [450,550]
    const river = line(0, 0, 1000, 0, 2);
    const win = slicePathAroundPoint(river, { x: 800, y: 40 }, 100);
    assert(win.length >= 2, '应返回 >=2 点');
    const x0 = win[0].x, x1 = win[win.length - 1].x;
    assert(Math.abs((x0 + x1) / 2 - 800) < 1e-6, `窗口中心应≈800（实际 ${(x0 + x1) / 2}）`);
    assert(Math.abs((x1 - x0) - 100) < 1e-6, `窗口长度应=100（实际 ${x1 - x0}）`);
    return `[${x0.toFixed(0)}, ${x1.toFixed(0)}]`;
  });

  check('t9 端点/短河边界：窗口不越界、span 超长时整条返回', () => {
    const river = line(0, 0, 200, 0, 2);
    const head = slicePathAroundPoint(river, { x: 0, y: 10 }, 100);
    eq(head[0].x, 0, '窗口贴左端不越界');
    assert(Math.abs(head[head.length - 1].x - 100) < 1e-6, `贴端时整段平移（实际到 ${head[head.length - 1].x}）`);
    const whole = slicePathAroundPoint(river, { x: 100, y: 0 }, 10000);
    assert(Math.abs(whole[whole.length - 1].x - 200) < 1e-6, 'span 超长 → 整条');
    // 折线中段的顶点要被保留（窗口不是只有两个端点，拐弯才排得出字）
    const bent = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    const w2 = slicePathAroundPoint(bent, { x: 100, y: 0 }, 300);
    assert(w2.length === 3, `应保留拐点（实际 ${w2.length} 点）`);
    // 退化输入不抛
    eq(slicePathAroundPoint([], { x: 0, y: 0 }, 10).length, 0, '空折线');
    eq(slicePathAroundPoint([{ x: 1, y: 1 }], { x: 0, y: 0 }, 10).length, 1, '单点');
    return `head=[${head[0].x},${head[1].x}] whole=${whole.length}pt bent=${w2.length}pt`;
  });

  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
