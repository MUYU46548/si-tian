#!/usr/bin/env node
/**
 * 单元测试：诊断包（`src/main/diagPackage.js`，发布门槛④，2026-11-05）
 *
 * 守三件事（都是发布物对陌生人的承诺）：
 *   ① **不含世界观正文**：组件只吃“计数”，日志里的一切绝对路径都脱敏；
 *   ② **路径脱敏**：`C:\Users\<名>`、库路径、项目路径都不许出现在包里；
 *   ③ **ZIP 真的能用**：自己写的 STORED zip 必须能被标准解析器读回（这里自带最小解析器；
 *      另外人工用 `Expand-Archive` 验过一次）。
 *
 * 负向探针：给一条**没进 secrets 列表**的私人路径，通用绝对路径规则也必须把它抹掉
 * （证明脱敏不依赖“事先知道那个路径”）。
 *
 * 用法：node scripts/tests/unit/test_diag_package.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const D = require(path.join(ROOT, 'src', 'main', 'diagPackage.js'));

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`✓ ${name}${detail ? '  —— ' + detail : ''}`); }
  else { fails.push(name + (detail ? '  —— ' + detail : '')); console.log(`✗ ${name}${detail ? '  —— ' + detail : ''}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** 最小 ZIP 解析器（只认本仓写出的 STORED 包）：返回 [{name, data, crc}] */
function parseZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert(eocd >= 0, '找不到 EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let k = 0; k < count; k++) {
    assert(buf.readUInt32LE(off) === 0x02014b50, '中央目录签名不对');
    const crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    assert(buf.readUInt32LE(lho) === 0x04034b50, '本地头签名不对：' + name);
    const lnLen = buf.readUInt16LE(lho + 26);
    const leLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnLen + leLen;
    const data = buf.slice(start, start + csize);
    out.push({ name, data, crc });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ── ① 路径脱敏 ────────────────────────────────────────────────────────────
{
  const m = D.maskPath('E:\\图书馆\\ROSA\\绒花计划.sitian');
  ok('maskPath：只留盘符与层数，一个目录名都不留',
    m.empty === false && m.drive === 'E:' && m.segments === 4 && !JSON.stringify(m).includes('绒花'),
    JSON.stringify(m));
  ok('maskPath：空路径 → { empty: true }', D.maskPath('').empty === true && D.maskPath(null).empty === true);
}

{
  const secrets = ['E:\\图书馆\\ROSA', 'C:\\Users\\muyu\\Documents\\SiTianProjects\\绒花计划.sitian'];
  const raw = [
    '2026-11-05 10:00:00 [info] 打开项目 C:\\Users\\muyu\\Documents\\SiTianProjects\\绒花计划.sitian',
    '2026-11-05 10:00:01 [error] 读库失败 E:/图书馆/ROSA/伏夜提加/笔记.md',
    '2026-11-05 10:00:02 [info] 见 https://example.com/docs?x=1',
  ].join('\n');
  const red = D.redactText(raw, secrets);
  ok('redactText：用户名 / 库路径 / 项目路径全部消失',
    !/muyu/.test(red) && !/绒花/.test(red) && !/伏夜提加/.test(red) && !/图书馆/.test(red),
    red.split('\n')[0].slice(0, 80));
  ok('redactText：URL 不被误伤（诊断要能看懂哪一条网络请求）', red.includes('https://example.com/docs?x=1'));
  // 负向探针：这条路径**不在 secrets 里**，也要被通用规则抹掉
  const blind = D.redactText('路径 D:\\别人的世界\\私密设定.md 打不开', []);
  ok('负向探针：未列入 secrets 的私人路径也必须抹掉',
    !/别人的世界/.test(blind) && !/私密设定/.test(blind) && /<路径:D:>/.test(blind), blind);
}

// ── ② 日志尾 + 最近错误 ───────────────────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-diag-'));
  fs.writeFileSync(path.join(dir, 'main.log'), ['a1', 'a2', 'a3', 'a4', 'a5'].join('\n'), 'utf8');
  fs.writeFileSync(path.join(dir, 'older.log'), ['b1', 'b2'].join('\n'), 'utf8');
  const t = D.tailLogFiles(dir, { maxFiles: 2, maxLines: 50 });
  ok('tailLogFiles：取最近文件并统计行数（多文件行数相加）',
    t.files.length === 2 && t.lines.length === 7 && t.bytes > 0,
    JSON.stringify(t.files));
  ok('tailLogFiles：maxLines 封顶（大日志不能整本进包）',
    D.tailLogFiles(dir, { maxFiles: 2, maxLines: 3 }).lines.length === 3);
  ok('tailLogFiles：目录不存在 → 空结果、不抛',
    D.tailLogFiles(path.join(dir, '__none__')).lines.length === 0);

  const err = D.lastErrorFrom(['x [info] ok', 'y [error] boom', '   at foo.js:1']);
  ok('lastErrorFrom：抓到最近一次错误并带堆栈',
    err && /boom/.test(err.line) && /at foo\.js/.test(err.stack), JSON.stringify(err && err.line));
  ok('lastErrorFrom：没有错误行 → null', D.lastErrorFrom(['[info] ok']) === null);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ③ 组包：不含正文、数字对得上 ──────────────────────────────────────────
{
  const diag = D.buildDiagnostics({
    version: '9.9.9',
    versions: { electron: '28.0.0', chrome: '120', node: '18', v8: '11' },
    platform: 'win32', arch: 'x64', osRelease: 'Windows_NT 10.0',
    vaultPath: 'E:\\图书馆\\ROSA',
    lastProjectPath: 'C:\\Users\\muyu\\Documents\\绒花计划.sitian',
    secrets: ['E:\\图书馆\\ROSA', 'C:\\Users\\muyu\\Documents\\绒花计划.sitian'],
    stats: { entities: 120, provinces: 415, scenarios: 13, gridCells: 16984, rivers: 573, roads: 496 },
    logDir: '',
    logOptions: {},
  });
  const s = JSON.stringify(diag);
  ok('组包：项目计数齐全（实体/省/剧本/格/河/路）',
    diag.project.entities === 120 && diag.project.provinces === 415 && diag.project.scenarios === 13
    && diag.project.gridCells === 16984 && diag.project.rivers === 573 && diag.project.roads === 496);
  ok('组包：包里没有任何私人路径/专名（含库名与世界名）',
    !/muyu/.test(s) && !/绒花/.test(s) && !/图书馆/.test(s), s.length + ' 字节');
  ok('组包：配置摘要只有“空不空 + 盘符”',
    diag.config.vault.drive === 'E:' && diag.config.lastProject.drive === 'C:');
  ok('组包：日志目录也只写占位符', diag.logs.dir === '<日志目录>');
}

// ── ④ ZIP 真的能用（写完读回）───────────────────────────────────────────
{
  const buf = D.makeZip([
    { name: 'diagnostics.json', data: '{"a":1}' },
    { name: 'logs.txt', data: 'hello 世界' },
  ]);
  const entries = parseZip(buf);
  ok('ZIP：两个条目、文件名与内容逐字节读回',
    entries.length === 2 && entries[0].name === 'diagnostics.json'
    && entries[1].data.toString('utf8') === 'hello 世界',
    entries.map((e) => e.name).join(','));
  ok('ZIP：每个条目的 CRC32 与内容自洽',
    entries.every((e) => D.crc32(e.data) === e.crc),
    entries.map((e) => e.crc.toString(16)).join(','));
  ok('ZIP：同输入逐字节一致（用例可对拍）',
    D.makeZip([{ name: 'x', data: 'y' }]).equals(D.makeZip([{ name: 'x', data: 'y' }])));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-diag-'));
  const target = path.join(dir, 'out.zip');
  const diag = D.buildDiagnostics({ version: '1.0.0', stats: { entities: 1 } });
  const res = D.writeDiagnostics(target, diag);
  const back = parseZip(fs.readFileSync(target));
  ok('writeDiagnostics：落到目标路径，且 diagnostics.json 可读回',
    res.ok === true && back.length === 2 && JSON.parse(back[0].data.toString('utf8')).app.version === '1.0.0',
    res.bytes + ' 字节');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ⑤ 源码守卫：入口与 IPC 接线在（不靠人记）───────────────────────────────
{
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  const about = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'components', 'AboutPanel.vue'), 'utf8').replace(/\r\n/g, '\n');
  ok('接线：主进程注册 diag-export、preload 暴露 diagExport、关于页有入口',
    main.includes("ipcMain.handle('diag-export'") && preload.includes('diagExport')
    && about.includes('about-export-diag') && about.includes('exportDiagnostics'));
  ok('接线：导出走的是 writeDiagnostics（不是另写一份写盘）', main.includes('writeDiagnostics(target, diag)'));
}

console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  console.error('失败：\n' + fails.map((f) => ' - ' + f).join('\n'));
  process.exit(1);
}
