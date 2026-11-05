#!/usr/bin/env node
/**
 * 单元测试：隐私与署名扫描（`scripts/privacy-scan.mjs`，发布门槛③，2026-11-05）
 *
 * 守四件事：
 *   ① **仓里 0 命中**（code / docs / root 三个作用域）；
 *   ② **反向探针**：临时目录里塞一个真专名，扫描必须报（否则“0 命中”可能只是扫描器坏了）；
 *   ③ **词表不落明文**：`privacy-terms.js` 里只有 base64，没有词表明文（否则扫描器自己成了泄漏点）；
 *   ④ **署名在**：LICENSE / README 的 `暮雨` 还在（这是要保留的，不能“清隐私”清掉了作者）。
 *
 * 用法：node scripts/tests/unit/test_privacy_scan.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`✓ ${name}${detail ? '  —— ' + detail : ''}`); }
  else { fails.push(name + (detail ? '  —— ' + detail : '')); console.log(`✗ ${name}${detail ? '  —— ' + detail : ''}`); }
}

(async () => {
  const S = await import(pathToFileURL(path.join(ROOT, 'scripts', 'privacy-scan.mjs')).href);
  const terms = S.DEFAULT_TERMS;

  ok('词表来自 base64（不是各写一份明文）', Array.isArray(terms) && terms.length >= 10,
    `${terms.length} 个词`);

  // ① 仓里 0 命中
  for (const scope of ['code', 'docs', 'root', 'sample']) {
    const files = S.SCOPES[scope]();
    const r = S.scanFiles(files, terms);
    ok(`[${scope}] 0 命中（扫了 ${r.scanned} 个文件）`, r.hits.length === 0,
      r.hits.slice(0, 3).map((h) => `${h.file}:${h.line} «${h.term}»`).join(' | '));
  }

  // ② 反向探针：临时目录里塞一个真专名 → 必须报
  const st = S.selfTest();
  ok('反向探针：塞真专名会被抓到 / 无专名时安静', st.caught && st.quietWhenClean, JSON.stringify(st));

  // ③ 词表文件本身不许有明文
  const termsSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'privacy-terms.js'), 'utf8');
  const leaked = terms.filter((t) => termsSrc.includes(t));
  ok('词表文件里没有明文专名（只存 base64）', leaked.length === 0,
    leaked.length ? `明文出现在 privacy-terms.js：${leaked.length} 个` : '干净');

  // ④ 署名必须保留
  const sig = S.checkSignature();
  ok('署名保留：LICENSE / README 都还写着作者', sig.every((x) => x.ok),
    sig.map((x) => `${x.file}:${x.ok}`).join(' / '));

  // ⑤ 负向探针要真的“有判别力”而不是只对 selfTest 的假词生效
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-privacy-'));
  const leak = path.join(dir, 'leak.md');
  fs.writeFileSync(leak, `这是一段混入 ${terms[0]} 的文字\n`, 'utf8');
  const caught = S.scanFiles([leak], terms);
  fs.rmSync(dir, { recursive: true, force: true });
  ok('反向探针：真词表里的词被塞进文件也必须被抓到', caught.hits.length === 1,
    caught.hits.length ? `${caught.hits[0].term}` : '没抓到（判据失效）');

  console.log(`\n${pass}/${pass + fails.length} 通过`);
  if (fails.length) {
    console.error('失败：\n' + fails.map((f) => ' - ' + f).join('\n'));
    process.exit(1);
  }
})().catch((e) => {
  console.error('用例自身崩溃：', e && e.message ? e.message : e);
  process.exit(1);
});
