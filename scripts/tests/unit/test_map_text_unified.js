#!/usr/bin/env node
/**
 * Node 单元测试：三层文字样式的唯一入口（A5，2026-11-05）
 *
 * 为什么值得守：
 *   历史剧本层的六类文字早就收口到 `utils/mapTextStyles.js`（颜色/字号/描边/字体族一份实现），
 *   但**行星 / 区域 / 建筑**三层还各自硬编码 `'10px sans-serif'` —— 同一个软件里两套字体口径：
 *   剧本层中文走雅黑/苹方，那三层退回浏览器默认 sans-serif，小字号下中文发虚。
 *   这类“两套口径”不会报错，只会看起来“这页的字好像不太一样”，而且改一处另两处不变。
 *
 * 用法：node scripts/tests/unit/test_map_text_unified.js
 * 退出码：0 = 全通过。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const LAYERS = [
  'src/renderer/src/composables/planetDrawing.js',   // 行星
  'src/renderer/src/components/AreaMap.vue',         // 区域
  'src/renderer/src/components/InteriorView.vue',    // 建筑内部
];

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
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

async function loadUtil() {
  const src = read('src/renderer/src/utils/mapTextStyles.js');
  const url = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(src);
  return import(url);
}

async function main() {
  const U = await loadUtil();
  const { canvasFont, fontFamilyCss } = U;
  const SANS = fontFamilyCss({ fontFamily: 'sans' });
  const SERIF = fontFamilyCss({ fontFamily: 'serif' });

  check('t1 canvasFont：字号 / 加粗 / 衬线 / 非法输入四条口径', () => {
    eq(canvasFont(10), `10px ${SANS}`, '常规 10px');
    eq(canvasFont('12'), `12px ${SANS}`, '字符串字号也认');
    eq(canvasFont(10, { bold: true }), `bold 10px ${SANS}`, '加粗在**前面**（`10px bold` 不是合法 CSS）');
    eq(canvasFont(16, { family: 'serif' }), `16px ${SERIF}`, '衬线档');
    eq(canvasFont(0), `10px ${SANS}`, '0/非法字号回 10（不许输出 0px —— 那样字直接没了）');
    eq(canvasFont(undefined), `10px ${SANS}`, 'undefined 回 10');
    eq(canvasFont(-3), `10px ${SANS}`, '负数回 10');
    return '7 例';
  });

  check('t2 字体族只有一份：canvasFont 与历史剧本层共用 fontFamilyCss', () => {
    // 脚本里不许自己拼字体族（拼了就会与剧本层漂移）
    const src = read('src/renderer/src/utils/mapTextStyles.js');
    assert(src.includes('return `${opts && opts.bold ? \'bold \' : \'\'}${px}px ${fontFamilyCss({ fontFamily: family })}`'),
      'canvasFont 没有复用 fontFamilyCss');
    assert((src.match(/Microsoft YaHei/g) || []).length === 1, '字体族定义出现了不止一处');
    return '复用 fontFamilyCss';
  });

  check('t3 🔴 三层不再硬编码字体：源码里 0 处 `px sans-serif` / `px serif`', () => {
    for (const rel of LAYERS) {
      const src = read(rel);
      const left = (src.match(/\d+px\s+(sans-serif|serif)/g) || []);
      eq(left.length, 0, `${rel} 里还有硬编码字体：${left.join(', ')}`);
    }
    return '3 个文件都干净';
  });

  check('t4 三层都真的走 canvasFont（不是 import 了没用）', () => {
    for (const rel of LAYERS) {
      const src = read(rel);
      assert(src.includes("from '../utils/mapTextStyles'"), `${rel} 没有 import 唯一入口`);
      const uses = (src.match(/canvasFont\(/g) || []).length;
      assert(uses >= 1, `${rel} import 了 canvasFont 却一次都没用`);
    }
    return '3 个文件各 ≥1 处';
  });

  check('t5 历史剧本层那 5 类默认值还在（没收口时把人家的东西弄丢）', () => {
    for (const name of ['SCENARIO_LABEL_DEFAULTS', 'MARKER_LABEL_DEFAULTS', 'BURG_LABEL_DEFAULTS',
      'RIVER_LABEL_DEFAULTS', 'TERRAIN_LABEL_DEFAULTS']) {
      assert(U[name] && Number(U[name].size) > 0, `缺 ${name}`);
    }
    return '5 类';
  });

  // ── 汇总 ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log('=== 三层文字样式唯一入口（A5）Node 单元测试 ===');
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
