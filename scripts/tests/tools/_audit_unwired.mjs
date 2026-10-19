// 审计：src 云里「导出但没人调用」的函数 / 「写了 TODO/未实装」标记 / 被禁用的 UI 入口
// 用途：用户要求「注意拾取未开放内容，不要再把没实装的东西丢掉了，都要排列好计划」。
// 判据：对每个 export function/const，数它在 src/ 下**除自身文件外**的出现次数。
import fs from 'fs';
import path from 'path';

const ROOT = 'E:/CODE/CangKu/SiTian';
const SRC = path.join(ROOT, 'src');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (/\.(js|vue|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = walk(SRC);
const srcText = new Map();
for (const f of files) srcText.set(f, fs.readFileSync(f, 'utf8'));
const allText = [...srcText.values()].join('\n');

// ── 1. 导出符号的调用点清点 ──────────────────────────────────────────────
const exportRe = /export\s+(?:async\s+)?(?:function|const|let)\s+([A-Za-z_$][\w$]*)/g;
const zero = [], low = [];
for (const [f, txt] of srcText) {
  let m;
  while ((m = exportRe.exec(txt))) {
    const name = m[1];
    if (name.length < 4) continue;                 // 太短的名字数不准
    const re = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g');
    let total = 0, own = 0;
    for (const [g, t] of srcText) {
      const n = (t.match(re) || []).length;
      total += n;
      if (g === f) own += n;
    }
    const outside = total - own;
    // 自身文件里除定义那一处之外还有引用，说明至少内部在用
    const internalUses = own - 1;
    if (outside === 0 && internalUses === 0) {
      zero.push({ name, file: path.relative(ROOT, f).replace(/\\/g, '/'), outside, own });
    } else if (outside === 0) {
      low.push({ name, file: path.relative(ROOT, f).replace(/\\/g, '/'), outside, own, internalUses });
    }
  }
}

// ── 2. TODO / 未实装 / 占位 / 暂时 / 待实装 标记 ──────────────────────────
const MARK = /(TODO|FIXME|XXX|未实装|没实装|尚未实装|未实现|未接线|占位|placeholder|待实装|暂时不|暂不|先不做|将来|后续再|留给以后)/;
const marks = [];
for (const [f, txt] of srcText) {
  txt.split('\n').forEach((line, i) => {
    if (!MARK.test(line)) return;
    // 只收代码注释里的（避免把中文 UI 文案当标记）
    const t = line.trim();
    if (!(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--'))) return;
    marks.push({ file: path.relative(ROOT, f).replace(/\\/g, '/'), line: i + 1, text: t.slice(0, 150) });
  });
}

// ── 3. 被禁用的 UI 入口（:disabled / disabled= / 灰禁） ─────────────────
const disabled = [];
for (const [f, txt] of srcText) {
  if (!f.endsWith('.vue')) continue;
  txt.split('\n').forEach((line, i) => {
    if (/:disabled=/.test(line) || /disabled\s*=\s*"true"/.test(line)) {
      disabled.push({ file: path.relative(ROOT, f).replace(/\\/g, '/'), line: i + 1, text: line.trim().slice(0, 140) });
    }
  });
}

console.log(`== 1. 全仓零调用的导出（自身文件内也没再用）: ${zero.length} 个 ==`);
const byFile = {};
for (const z of zero) { (byFile[z.file] = byFile[z.file] || []).push(z.name); }
for (const [f, names] of Object.entries(byFile).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${f}  (${names.length})`);
  console.log(`     ${names.join(', ')}`);
}
console.log(`\n== 2. 只在自身文件内使用（无外部调用点）: ${low.length} 个 ==`);
const byFile2 = {};
for (const z of low) { (byFile2[z.file] = byFile2[z.file] || []).push(z.name); }
for (const [f, names] of Object.entries(byFile2).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${f}  (${names.length}): ${names.slice(0, 14).join(', ')}${names.length > 14 ? ' …' : ''}`);
}
console.log(`\n== 3. 注释里的未实装/占位标记: ${marks.length} 处（按文件） ==`);
const byFile3 = {};
for (const mk of marks) (byFile3[mk.file] = byFile3[mk.file] || []).push(mk);
for (const [f, list] of Object.entries(byFile3).sort((a, b) => b[1].length - a[1].length).slice(0, 18)) {
  console.log(`  ${f}  (${list.length})`);
  for (const mk of list.slice(0, 3)) console.log(`     L${mk.line}: ${mk.text}`);
}
console.log(`\n== 4. 带 :disabled 的 UI 入口: ${disabled.length} 处 ==`);
const byFile4 = {};
for (const d of disabled) (byFile4[d.file] = byFile4[d.file] || []).push(d);
for (const [f, list] of Object.entries(byFile4).sort((a, b) => b[1].length - a[1].length).slice(0, 14)) {
  console.log(`  ${f}  (${list.length})`);
  for (const d of list.slice(0, 2)) console.log(`     L${d.line}: ${d.text}`);
}
