#!/usr/bin/env node
/**
 * 单元测试：README 不许跟实现说反话（2026-11-07，卡“README 特性段更新”）
 *
 * 为什么单独立一条闸门：README 是**唯一给陌生人看的那一页**，它说错话比没有说明更坏
 * （本项目已有前车之鉴 R16：`SITIAN_VAULT_SPEC.md` 曾写“重命名后关联保留”，
 *  与实测正好相反）。而"写错"这件事**不会报错**，只能靠判据。
 *
 * 本轮实测到的两处漂移（都已被这条闸门当场抓住过）：
 *   ① README 写着“无项目时仍写入知识库缓存；无项目必须只读的严格模式是下一步”——
 *      而 `READONLY_WITHOUT_PROJECT = true` 从 2026-09-20 起就是翻开状态；
 *   ② README 写着“项目文件磁盘备份（10 份）/ 缓存保留最近 10 批”——
 *      而 2026-10-30 用户拍板统一成 **3**（`projectHandler.js` / `main/index.js` 的 `BACKUP_KEEP`）。
 *
 * 判据只做"**能机械核对的那部分**"：数字与已拍板状态。文案好不好不在这里判（那是人读的）。
 * 每条都带负向探针：把错误写法喂回同一个函数，必须报出来 —— 否则这个闸门自己是空转。
 *
 * 用法：node scripts/tests/unit/test_readme_claims.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const readText = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const README = readText('README.md');
const WRITE_GATE = readText('src/renderer/src/store/writeGate.js');
const PROJECT_HANDLER = readText('src/main/handlers/projectHandler.js');
const MAIN_INDEX = readText('src/main/index.js');
const PKG = JSON.parse(readText('package.json'));

// ── 事实：从代码里读，不从文档里猜 ───────────────────────────────────────────
const FACTS = {
  readOnlyWithoutProject: /export const READONLY_WITHOUT_PROJECT = (true|false)/.exec(WRITE_GATE),
  projectBackupKeep: /const BACKUP_KEEP = (\d+)/.exec(PROJECT_HANDLER),
  cacheBackupKeep: /const BACKUP_KEEP = (\d+)/.exec(MAIN_INDEX),
};
const READ_ONLY = FACTS.readOnlyWithoutProject && FACTS.readOnlyWithoutProject[1] === 'true';
const PROJECT_KEEP = FACTS.projectBackupKeep ? Number(FACTS.projectBackupKeep[1]) : null;
const CACHE_KEEP = FACTS.cacheBackupKeep ? Number(FACTS.cacheBackupKeep[1]) : null;

// ── 判据 1：只读态已翻开 ⇒ README 不许再说"还是下一步" ───────────────────────
/** @returns {string[]} 问题清单（空 = 通过） */
function checkReadOnlyClaims(readme, readOnly) {
  const problems = [];
  if (!readOnly) return problems;
  const stale = [
    ['严格模式是下一步', 'README 把"无项目只读"写成了"下一步"，而它 2026-09-20 起就是翻开状态'],
    ['无项目时仍写入知识库缓存', 'README 说无项目仍可写缓存，而写闸门会拒绝（会让人以为能改）'],
  ];
  for (const [needle, why] of stale) {
    if (readme.includes(needle)) problems.push(why + `（残留原文：${needle}）`);
  }
  if (!/没有打开项目时是只读的|无项目\s*=\s*只读|无项目时是只读/.test(readme)) {
    problems.push('README 没有写清"没有项目时是只读"这条当前行为（陌生人会以为能直接编辑）');
  }
  return problems;
}

// ── 判据 2：备份份数必须等于代码里的 BACKUP_KEEP ─────────────────────────────
/** @returns {string[]} 问题清单（空 = 通过） */
function checkBackupClaims(readme, projectKeep, cacheKeep) {
  const problems = [];
  const checks = [
    [/(项目文件[^。]*?)保留最近\s*(\d+)\s*份/, projectKeep, '项目文件备份份数'],
    [/(缓存[^。]*?)保留最近\s*(\d+)\s*批/, cacheKeep, '缓存备份批数'],
  ];
  for (const [re, actual, label] of checks) {
    if (!Number.isFinite(actual)) continue;             // 代码里读不到就不判（别造判据）
    const m = re.exec(readme);
    if (!m) continue;                                   // README 没提这份数 → 不判
    const claimed = Number(m[2]);
    if (claimed !== actual) {
      problems.push(`${label}写的是 ${claimed}，代码里是 ${actual}（拍板值改过就该跟着改 README）`);
    }
  }
  return problems;
}

// ── 判据 3：README 里提到的用例/单测数必须与仓库一致 ─────────────────────────
function checkCountClaims(readme, caseCount, unitCount) {
  const problems = [];
  const caseRe = /(\d+)\s*(?:个)?\s*(?:回归)?用例/g;
  let m;
  while ((m = caseRe.exec(readme))) {
    const n = Number(m[1]);
    if (n >= 50 && n !== caseCount) {
      problems.push(`README 说有 ${n} 个用例，仓库里是 ${caseCount}`);
    }
  }
  const unitRe = /(\d+)\s*个?\s*(?:Node\s*)?单测/g;
  while ((m = unitRe.exec(readme))) {
    const n = Number(m[1]);
    if (n >= 10 && n !== unitCount) {
      problems.push(`README 说有 ${n} 个单测，仓库里是 ${unitCount}`);
    }
  }
  return problems;
}

// ── 跑判据 ───────────────────────────────────────────────────────────────
const caseCount = fs.readdirSync(path.join(ROOT, 'scripts', 'tests', 'cases'))
  .filter((n) => /^test_.*\.py$/.test(n)).length;
const unitCount = fs.readdirSync(path.join(ROOT, 'scripts', 'tests', 'unit'))
  .filter((n) => /\.js$/.test(n)).length;

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`✓ ${name}${detail ? '  —— ' + detail : ''}`); }
  else { fails.push(name + (detail ? '  —— ' + detail : '')); console.log(`✗ ${name}${detail ? '  —— ' + detail : ''}`); }
}

ok('事实读取：写闸门的只读常量在（改名前得先改这里）', FACTS.readOnlyWithoutProject !== null,
  READ_ONLY ? 'READONLY_WITHOUT_PROJECT = true' : 'false');
ok('事实读取：两处 BACKUP_KEEP 都在，且值一致',
  PROJECT_KEEP !== null && CACHE_KEEP !== null && PROJECT_KEEP === CACHE_KEEP,
  `项目 ${PROJECT_KEEP} / 缓存 ${CACHE_KEEP}`);

const p1 = checkReadOnlyClaims(README, READ_ONLY);
ok('只读态已翻开时，README 不说"还是下一步"、且写清了"没有项目时只读"',
  p1.length === 0, p1.join('；') || 'ok');

const p2 = checkBackupClaims(README, PROJECT_KEEP, CACHE_KEEP);
ok('README 的备份份数 = 代码里的 BACKUP_KEEP', p2.length === 0, p2.join('；') || `都是 ${PROJECT_KEEP}`);

const p3 = checkCountClaims(README, caseCount, unitCount);
ok('README 提到的用例数 / 单测数与仓库一致', p3.length === 0, p3.join('；') || `${caseCount} / ${unitCount}`);

// ── 负向探针：同一函数喂错写法必须红（否则本文件是空转）─────────────────────
{
  const bad1 = README + '\n> 无项目时仍写入知识库缓存；无项目必须只读的严格模式是下一步。\n';
  ok('负向探针 A：塞回"严格模式是下一步"必须被抓到', checkReadOnlyClaims(bad1, true).length > 0);

  const bad2 = README.replace(/保留最近\s*\d+\s*份/, '保留最近 10 份');
  ok('负向探针 B：份数写错必须被抓到', checkBackupClaims(bad2, PROJECT_KEEP, CACHE_KEEP).length > 0);

  const bad3 = README + `\n回归 ${caseCount + 7} 个用例，另有 ${unitCount + 3} 个单测。\n`;
  ok('负向探针 C：用例数/单测数写错必须被抓到',
    checkCountClaims(bad3, caseCount, unitCount).length > 0);
}

console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  console.error('失败：\n' + fails.map((f) => ' - ' + f).join('\n'));
  process.exit(1);
}
