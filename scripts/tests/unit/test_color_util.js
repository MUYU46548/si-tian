#!/usr/bin/env node
/**
 * Node 单元测试：颜色 → 带透明度 CSS 值（src/renderer/src/utils/colorUtil.js）
 *
 * 为什么必须有这一层：星域边界原来用 `border.color + '12'` 拼 alpha。6 位 hex 成立，
 * 但 `getFactionColor()` 对**不在硬编码表里的势力名**返回 `hsl(...)` → 拼出
 * `hsl(210, 70%, 60%)12` = **非法 CSS**，赋给 `fillStyle`/`addColorStop` 被**静默忽略**
 * （沿用上一个颜色）。真实库的势力名必然不在表里 → 这条路径必然走到，而且没有任何报错。
 * 本用例把"任意颜色 + 任意 alpha 都得到一个合法 rgba"钉死，并保留旧写法（两位十六进制）的语义。
 *
 * 用法：node scripts/tests/unit/test_color_util.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.join(ROOT, 'src', 'renderer', 'src', 'utils');

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

/** 合法 CSS rgba：`rgba(r, g, b, a)`，三个整数 0~255 + 一个 0~1 的小数 */
const RGBA = /^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, (?:0|1|0?\.\d+)\)$/;

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-color-'));
  fs.copyFileSync(path.join(SRC_DIR, 'colorUtil.js'), path.join(tmp, 'colorUtil.js'));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const C = await import(pathToFileURL(path.join(tmp, 'colorUtil.js')).href);

  check('a1 hex 三种长度都能解析（#rgb / #rrggbb / #rrggbbaa）', () => {
    const a = C.parseColor('#4A90D9');
    assert(a && a.r === 74 && a.g === 144 && a.b === 217 && a.a === 1, JSON.stringify(a));
    const b = C.parseColor('#abc');
    assert(b && b.r === 0xaa && b.g === 0xbb && b.b === 0xcc, JSON.stringify(b));
    const c = C.parseColor('#4A90D980');
    assert(c && Math.abs(c.a - 0x80 / 255) < 1e-9, JSON.stringify(c));
    return 'ok';
  });

  check('a2 hsl / rgb / rgba 都能解析（这就是"不在表里的势力名"走的那条路）', () => {
    const h = C.parseColor('hsl(210, 70%, 60%)');
    assert(h && Number.isFinite(h.r) && Number.isFinite(h.g) && Number.isFinite(h.b), JSON.stringify(h));
    // 210° 的 hsl(210,70%,60%) ≈ #4d94e0（红少、蓝多）
    assert(h.b > h.r, `hsl 210° 应偏蓝：${JSON.stringify(h)}`);
    const r = C.parseColor('rgb(10, 20, 30)');
    assert(r && r.r === 10 && r.g === 20 && r.b === 30 && r.a === 1, JSON.stringify(r));
    const ra = C.parseColor('rgba(10,20,30,0.4)');
    assert(ra && Math.abs(ra.a - 0.4) < 1e-9, JSON.stringify(ra));
    return 'ok';
  });

  check('a3 解析不了的输入返回 null（不许猜、不许抛）', () => {
    for (const bad of ['', null, undefined, 42, 'not-a-color', '#12345', 'hsl()', 'rgb(1,2)']) {
      assert(C.parseColor(bad) === null, `应返回 null：${JSON.stringify(bad)}`);
    }
    return 'ok';
  });

  check('a4 withAlpha：**任何**能解析的颜色都得到合法 rgba（旧写法 hsl + 拼串会得到非法值）', () => {
    const cases = ['#4A90D9', '#abc', 'hsl(210, 70%, 60%)', 'rgb(10, 20, 30)'];
    for (const c of cases) {
      const out = C.withAlpha(c, '12');
      assert(RGBA.test(out), `不是合法 rgba：${c} + '12' → ${out}`);
      // 旧写法的对照：字符串拼接对 hsl 就是非法 CSS
      const legacy = c + '12';
      if (!/^#[0-9a-fA-F]{6}$/.test(c)) {
        assert(!RGBA.test(legacy), `对照失效：${legacy} 竟然也合法？`);
      }
    }
    return cases.map((c) => `${c}→${C.withAlpha(c, '12')}`).join(' / ');
  });

  check('a5 alpha 口径：两位十六进制按历史语义（12≈7% / FF=100%），小数按 0~1', () => {
    const a1 = C.parseColor(C.withAlpha('#000000', '12')).a;
    assert(Math.abs(a1 - 0x12 / 255) < 1e-3, `'12' 应≈0.071，实测 ${a1}`);
    const a2 = C.parseColor(C.withAlpha('#000000', 'FF')).a;
    assert(Math.abs(a2 - 1) < 1e-9, `'FF' 应为 1，实测 ${a2}`);
    const a3 = C.parseColor(C.withAlpha('#000000', 0.5)).a;
    assert(Math.abs(a3 - 0.5) < 1e-9, `0.5 应为 0.5，实测 ${a3}`);
    // 与十六进制颜色自身的 alpha 相乘（#rrggbbaa + alpha）
    const a4 = C.parseColor(C.withAlpha('#00000080', 1)).a;
    assert(Math.abs(a4 - 0x80 / 255) < 1e-3, `自带 alpha 应保留，实测 ${a4}`);
    // 越界夹住
    assert(C.parseColor(C.withAlpha('#000000', 5)).a === 1, '>1 应夹到 1');
    assert(C.parseColor(C.withAlpha('#000000', -1)).a === 0, '<0 应夹到 0');
    return 'ok';
  });

  check('a6 解析不了的颜色原样返回（不抛、也不编一个假颜色）', () => {
    assert(C.withAlpha('totally-not-a-color', '12') === 'totally-not-a-color', '应原样返回');
    assert(C.withAlpha(null, '12') === null, 'null 应原样返回');
    return 'ok';
  });

  check('a7 toHex6：规范成 6 位 hex（hsl 也能转），失败返回 null', () => {
    assert(C.toHex6('#abc') === '#aabbcc', C.toHex6('#abc'));
    assert(C.toHex6('hsl(210, 70%, 60%)').startsWith('#'), 'hsl 应能转 hex');
    assert(C.toHex6('#4A90D9') === '#4a90d9', C.toHex6('#4A90D9'));
    assert(C.toHex6('nope') === null, '解析不了应返回 null');
    return 'ok';
  });

  check('a8 反向探针：把 withAlpha 退回"字符串拼接"，a4 的判据必须能抓到（非法 CSS）', () => {
    // 判据本身的判别力：拼接 hsl 的结果必须**不是**合法 rgba —— 否则本用例是空转
    const bad = 'hsl(210, 70%, 60%)' + '12';
    assert(!RGBA.test(bad), `反向探针失效：${bad} 竟然合法`);
    assert(C.withAlpha('hsl(210, 70%, 60%)', '12') !== bad, 'withAlpha 不许退化成拼接');
    return '拼接确实非法，判据有判别力';
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  —— ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('用例自身崩溃：', err);
  process.exit(1);
});
