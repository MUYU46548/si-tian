// _shot_save.js —— 把 _lab.py 刚截的整页图 `docs/assets/lab-shot.png` 另存成交付图之一。
//
// 为什么要有这个文件（而不是直接 Copy-Item）：
//   项目纪律是「禁止用 PowerShell / shell 读写任何含非 ASCII 字符的文件」——
//   交付图的文件名是中文，走 shell 传中文参数有编码风险。这里把**中文文件名写在
//   本文件里**（UTF-8 源码），命令行只传 ASCII 的序号，shell 上不出现任何非 ASCII 字符。
//
// 用法：node scripts/tests/tools/_shot_save.js 01
//       node scripts/tests/tools/_shot_save.js 07 / 02b / 03b   （补充图）
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'docs', 'assets', 'lab-shot.png');
const DIR = path.join(ROOT, 'docs', 'assets', 'river-fix-20261017');

const NAMES = {
  '01': '01-手画河-点串问题.png',
  '02': '02-自动河-剪枝前.png',
  '03': '03-自动河-剪枝后.png',
  '04': '04-自动河-放大看弯与粗细.png',
  '05': '05-颜色统一.png',
  '06': '06-手画河-预览与变宽.png',
  '07': '07-手画河-节点手柄.png',
  '02b': '02b-自动河-剪枝前-放大.png',
  '03b': '03b-自动河-剪枝后-放大.png',
};

const key = String(process.argv[2] || '').trim();
const name = NAMES[key];
if (!name) {
  console.error('用法: node scripts/tests/tools/_shot_save.js <01|02|02b|03|03b|04|05|06|07>');
  process.exit(2);
}
if (!fs.existsSync(SRC)) {
  console.error('源图不存在（先跑 _lab.py run）: ' + SRC);
  process.exit(3);
}
fs.mkdirSync(DIR, { recursive: true });
const dst = path.join(DIR, name);
fs.copyFileSync(SRC, dst);
const st = fs.statSync(dst);
const head = fs.readFileSync(dst).subarray(0, 8).toString('hex');
console.log(JSON.stringify({
  saved: dst,
  bytes: st.size,
  isPng: head === '89504e470d0a1a0a',
  mtime: st.mtime.toISOString(),
}, null, 1));
