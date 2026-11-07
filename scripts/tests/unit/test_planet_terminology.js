#!/usr/bin/env node
/**
 * 单元测试：行星侧术语必须是“地形块”，不许再出现“省份”（2026-11-07）
 *
 * 为什么有这条：同一个数据（`provinces` 数组）在两个视图里**读法不同** ——
 * 历史剧本里它是“省份”（某个国家的一块地），行星表面它是“地形块”（星球上一块地貌）。
 * 2026-10-12 暮雨对这条拍过口径：“省份改地形块……就是改个文案的事情而已”，并把它归到司天侧。
 *
 * 判据只扫 `PlanetMap.vue` 的**非注释行**（用户可见文字 + 回执/确认框字符串都在里面；
 * 注释里保留“省份拆分合并 composable”这类说法是为了让代码读者对得上数据模型，不算违规）。
 *
 * 用法：node scripts/tests/unit/test_planet_terminology.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FILE = 'src/renderer/src/components/PlanetMap.vue';

/**
 * 扫描“用户可见文字里的禁用术语”。
 * @param {string} src 源码
 * @param {string} banned 禁用词
 * @returns {Array<{line:number, text:string}>} 违规行
 */
function scanUserText(src, banned) {
  const out = [];
  const lines = String(src).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const t = line.trim();
    // 注释行不算用户可见文字（口径见文件头）
    if (t.startsWith('//') || t.startsWith('<!--') || t.startsWith('*') || t.startsWith('/*')) continue;
    if (line.includes(banned)) out.push({ line: i + 1, text: t.slice(0, 100) });
  }
  return out;
}

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`✓ ${name}${detail ? '  —— ' + detail : ''}`); }
  else { fails.push(name + (detail ? '  —— ' + detail : '')); console.log(`✗ ${name}${detail ? '  —— ' + detail : ''}`); }
}

const src = fs.readFileSync(path.join(ROOT, FILE), 'utf8').replace(/\r\n/g, '\n');

const banned = scanUserText(src, '省份');
ok('行星视图的用户可见文字里 0 处“省份”', banned.length === 0,
  banned.length ? banned.slice(0, 4).map((b) => `${b.line}: ${b.text}`).join(' | ') : 'ok');

const good = (src.match(/地形块/g) || []).length;
ok('“地形块”真的用上了（不是把词删掉了事）', good >= 3, `${good} 处`);

// 只改了文案：数据模型与函数名一个字都不许动（它们是 provinces / updateProvinceName）
ok('数据模型与函数名没被顺手改名（provinces / selectedProvince / updateProvince 仍在）',
  /provinces/.test(src) && /selectedProvince/.test(src) && /updateProvinceName/.test(src));

// ── 负向探针：同一函数喂两种写法，判据必须有判别力 ────────────────────────────
{
  const bad = '    <span>绘制省份</span>\n';
  ok('负向探针 A：非注释行里出现“省份”必须被抓到', scanUserText(bad, '省份').length === 1);

  const commentOnly = '    // 省份拆分合并 composable\n<!-- 选中省份的属性编辑面板 -->\n';
  ok('负向探针 B：只在注释里出现不算违规（否则代码读者对不上数据模型）',
    scanUserText(commentOnly, '省份').length === 0);
}

console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  console.error('失败：\n' + fails.map((f) => ' - ' + f).join('\n'));
  process.exit(1);
}
