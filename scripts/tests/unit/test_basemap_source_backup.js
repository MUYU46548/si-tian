#!/usr/bin/env node
/**
 * Node 单元测试：**原始底图来源备份**（`saveBaseMapSource` / `listBaseMapSources`）
 *
 * 为什么值得单独守：这是本项目**真实损失过一轮**的那个缺口。
 *   暮雨的 `desite` 底图建于 2026-09-10，当时解析器读不出高度图/河流/道路 →
 *   那些数据从来没进过项目；等想补时，唯一来源是**用户自己还留着的那份生成器导出**
 *   （`desite.map`，4.3MB）。而司天此前只备份自己的项目文件，**从不留用户导入的 `.map`**。
 *   那份文件一丢，地形/河流/道路就永久无法恢复。
 *
 * 本文件只 require 纯 Node 模块（projectHandler 顶层不含 electron），真实落盘到临时目录。
 * 用法：node scripts/tests/unit/test_basemap_source_backup.js
 * 退出码：0 = 全通过，1 = 有失败
 *
 * 判据分五组：
 *   a 原样字节：写进去的与读出来的**逐字节相同**（改了就不是"再次导入的凭据"）
 *   b 目录与命名：落在 `<项目>.sitian.backups/basemap-sources/`；非法字符被清洗；不产生目录层级
 *   c 轮转：只留最近 keep 份，且**不碰**项目备份的 `*.sitian`
 *   d 拒绝项：空内容 / 非项目路径 明确报错（不产生空备份）
 *   e 列表：按时间倒序、带字节数与路径
 */
'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const H = require(path.join(ROOT, 'src', 'main', 'handlers', 'projectHandler.js'));

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => { results.push({ name, ok: true, detail: detail || '' }); })
    .catch((err) => { results.push({ name, ok: false, detail: err && err.message ? err.message : String(err) }); });
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

const TMP_CANDIDATES = [
  process.env.SITIAN_TEST_TMP, process.env.TEMP, process.env.TMP,
  (() => { try { return os.tmpdir(); } catch (e) { return ''; } })(),
  path.join(os.homedir(), 'AppData', 'Local', 'Temp'),
  path.join(os.homedir(), '.sitian-test-tmp'),
].filter(Boolean);

let TMP = '';
let DIR = '';

async function resolveTmpRoot() {
  const tried = [];
  for (const base of TMP_CANDIDATES) {
    for (let i = 0; i < 2; i++) {
      const dir = path.join(base, `sitian-bmsrc-${Date.now()}-${Math.floor(Math.random() * 1e4)}`);
      try {
        await fsp.mkdir(dir, { recursive: true });
        const probe = path.join(dir, '.probe');
        await fsp.writeFile(probe, 'x');
        await fsp.unlink(probe);
        return dir;
      } catch (e) {
        tried.push(`${dir}: ${e.code || e.message}`);
      }
    }
  }
  throw new Error('找不到可写临时目录：\n' + tried.join('\n'));
}

/** 造一段"像真的 .map"的文本（多行 + 长行 + CRLF），用于逐字节比对 */
function fakeMapText(tag) {
  const rows = [];
  rows.push('1.151.2|File can be loaded in azgaar.github.io/Fantasy-Map-Generator|2026-9-9|971546738|1920|1080');
  rows.push('km|4|square|m|2|°C|||||||1000|1||||||{"mapSize":100,"latitude":50}');
  rows.push('{"latT":180,"latN":90,"latS":-90,"lonT":320,"lonW":-160,"lonE":160}');
  rows.push('[' + Array.from({ length: 300 }, (_, i) => i % 97).join(',') + ']');
  rows.push('<!-- tag: ' + tag + ' -->');
  return rows.join('\r\n') + '\r\n';
}

async function main() {
  TMP = await resolveTmpRoot();
  DIR = path.join(TMP, 'proj');
  await fsp.mkdir(DIR, { recursive: true });
  const projPath = path.join(DIR, '测试世界.sitian');
  await fsp.writeFile(projPath, JSON.stringify({ version: '1.0.0', entities: {} }), 'utf-8');

  const srcDir = path.join(H.backupDirFor(projPath), H.BASE_MAP_SRC_DIR);

  // ── a) 原样字节 ────────────────────────────────────────────────────────
  await check('a1 写入的与读出来的逐字节相同（原文就是凭据）', async () => {
    const text = fakeMapText('alpha');
    const r = await H.saveBaseMapSource(projPath, { name: 'desite.map', text });
    eq(r.success, true, 'success');
    eq(r.bytes, Buffer.byteLength(text, 'utf8'), 'bytes');
    const back = await fsp.readFile(r.path, 'utf-8');
    assert(back === text, '读回内容与写入不一致（被重编码了？）');
    assert(back.includes('\r\n'), 'CRLF 没有被保留');
    return `${r.bytes} 字节，路径 ${path.relative(TMP, r.path)}`;
  });

  await check('a2 中文 / emoji / 大数组都不被破坏', async () => {
    const text = '名：德斯特星 🌏\r\n' + JSON.stringify({ h: Array.from({ length: 2000 }, (_, i) => (i * 7) % 101) });
    const r = await H.saveBaseMapSource(projPath, { name: '德斯特星.map', text });
    const back = await fsp.readFile(r.path, 'utf-8');
    assert(back === text, '内容不一致');
    return `${r.bytes} 字节`;
  });

  // ── b) 目录与命名 ──────────────────────────────────────────────────────
  await check('b1 落在 <项目>.sitian.backups/basemap-sources/ 下', async () => {
    eq(path.basename(srcDir), 'basemap-sources', '目录名');
    assert(srcDir.startsWith(H.backupDirFor(projPath)), '不在项目备份目录下');
    const st = await fsp.stat(srcDir);
    assert(st.isDirectory(), '不是目录');
    return path.relative(TMP, srcDir);
  });

  await check('b2 非法字符被清洗、绝不产生目录层级', async () => {
    const r = await H.saveBaseMapSource(projPath, { name: '../../evil/坏:名?.map', text: 'x' });
    const rel = path.relative(srcDir, r.path);
    assert(!rel.includes(path.sep), `产生了子目录层级：${rel}`);
    assert(!/[\\/:*?"<>|]/.test(path.basename(r.path).replace(/\.map$/i, '')), `文件名仍含非法字符：${path.basename(r.path)}`);
    return path.basename(r.path);
  });

  await check('b3 没有扩展名时自动补 .map', async () => {
    const r = await H.saveBaseMapSource(projPath, { name: '没有扩展名', text: 'x' });
    assert(r.path.toLowerCase().endsWith('.map'), `未补扩展名：${r.path}`);
    return path.basename(r.path);
  });

  await check('b4 同一份文件重复留底不会互相覆盖（uniquePath 生效）', async () => {
    const before = (await fsp.readdir(srcDir)).length;
    const r1 = await H.saveBaseMapSource(projPath, { name: 'dup.map', text: 'v1' });
    const r2 = await H.saveBaseMapSource(projPath, { name: 'dup.map', text: 'v2' });
    assert(r1.path !== r2.path, '两次写到了同一个文件（旧备份被覆盖）');
    eq(await fsp.readFile(r1.path, 'utf-8'), 'v1', '第一份内容被改了');
    eq(await fsp.readFile(r2.path, 'utf-8'), 'v2', '第二份内容不对');
    const after = (await fsp.readdir(srcDir)).length;
    assert(after >= before + 2, '没有产生两份');
    return `${before} → ${after} 个文件`;
  });

  // ── c) 轮转 ────────────────────────────────────────────────────────────
  await check('c1 只保留最近 keep 份 .map', async () => {
    const keep = H.BASE_MAP_SRC_KEEP;
    for (const f of await fsp.readdir(srcDir)) await fsp.unlink(path.join(srcDir, f)).catch(() => {});
    for (let i = 0; i < keep + 5; i++) {
      await H.saveBaseMapSource(projPath, { name: `rot-${String(i).padStart(3, '0')}.map`, text: 'x' + i });
      await new Promise(r => setTimeout(r, 6));   // 让 mtime 明显可分（有些文件系统时间戳粒度粗）
    }
    const left = (await fsp.readdir(srcDir)).filter(f => f.toLowerCase().endsWith('.map'));
    eq(left.length, keep, `轮转后应剩 ${keep} 份`);
    assert(left.indexOf('rot-000.map') < 0, '最旧的没被清掉');
    assert(left.indexOf(`rot-${String(keep + 4).padStart(3, '0')}.map`) >= 0, '最新的被清掉了');
    return `${keep + 5} 份 → ${left.length} 份`;
  });

  await check('c1b 🔴 删除依据是**修改时间**、不是文件名（乱序名字反证）', async () => {
    // 首版按名字 `.sort()` 排序 → 刚写进去的名字若字母序靠前会被当成"最旧"删掉
    // （单测 e3 当场抓到 ENOENT）。这里用"字母序与写入顺序**完全相反**"的名字再证一次。
    for (const f of await fsp.readdir(srcDir)) await fsp.unlink(path.join(srcDir, f)).catch(() => {});
    const keep = H.BASE_MAP_SRC_KEEP;
    const written = [];
    for (let i = 0; i < keep + 2; i++) {
      const name = `zzz-${String(keep + 1 - i).padStart(3, '0')}.map`;   // 名字递减，写入递增
      await H.saveBaseMapSource(projPath, { name, text: 'v' + i });
      written.push(name);
      await new Promise(r => setTimeout(r, 6));
    }
    const left = (await fsp.readdir(srcDir)).filter(f => f.toLowerCase().endsWith('.map'));
    eq(left.length, keep, `应剩 ${keep} 份`);
    // 留下的必须是**最后写入的两份之外**的，即最新的 keep 份
    const newest = written.slice(-keep);
    for (const n of newest) assert(left.indexOf(n) >= 0, `最新的 ${n} 被误删（说明在按名字排序）`);
    return `留下最新 ${keep} 份（最新的 ${newest[newest.length - 1]} 在）`;
  });

  await check('c2 🔴 轮转不碰项目备份的 *.sitian（各扫各的）', async () => {
    // 在同一个备份目录里放几份"项目备份"，确认它们不参与 .map 的轮转
    const bdir = H.backupDirFor(projPath);
    const planted = [];
    for (let i = 0; i < 3; i++) {
      const p = path.join(bdir, `测试世界-planted-${i}.sitian`);
      await fsp.writeFile(p, '{}', 'utf-8');
      planted.push(p);
    }
    await H.saveBaseMapSource(projPath, { name: 'trigger-rotate.map', text: 'x' });
    for (const p of planted) {
      assert(fs.existsSync(p), `项目备份被误删：${path.basename(p)}`);
    }
    return `植入 ${planted.length} 份 .sitian 全在`;
  });

  // ── d) 拒绝项 ──────────────────────────────────────────────────────────
  await check('d1 空内容被拒（不产生空备份）', async () => {
    const before = (await fsp.readdir(srcDir)).length;
    let threw = '';
    try { await H.saveBaseMapSource(projPath, { name: 'empty.map', text: '' }); } catch (e) { threw = e.message; }
    assert(/为空|拒绝/.test(threw), `没有拒绝空内容：${threw}`);
    eq((await fsp.readdir(srcDir)).length, before, '目录里多了文件');
    return threw;
  });

  await check('d2 非项目路径被拒（路径守卫）', async () => {
    let threw = '';
    try { await H.saveBaseMapSource(path.join(DIR, '不是项目.txt'), { name: 'a.map', text: 'x' }); } catch (e) { threw = e.message; }
    assert(/不是司天项目文件/.test(threw), `没有命中路径守卫：${threw}`);
    return threw;
  });

  await check('d3 写失败不留 .tmp 残渣', async () => {
    await H.saveBaseMapSource(projPath, { name: 'tmpcheck.map', text: 'x' });
    const all = await fsp.readdir(srcDir);
    const leftover = all.filter(f => f.includes('.tmp-'));
    eq(leftover.length, 0, `残留临时文件：${leftover.join(',')}`);
    return `${all.length} 个文件，无 .tmp 残渣`;
  });

  // ── e) 列表 ────────────────────────────────────────────────────────────
  await check('e1 列表按时间倒序、带字节数与路径', async () => {
    const r = await H.listBaseMapSources(projPath);
    eq(r.success, true, 'success');
    eq(r.dir, srcDir, 'dir');
    assert(r.files.length > 0, '列表为空');
    for (const f of r.files) {
      assert(f.bytes > 0, `${f.name} 字节数为 0`);
      assert(typeof f.mtime === 'string' && f.mtime.length > 0, `${f.name} 缺 mtime`);
      assert(path.isAbsolute(f.path), `${f.name} 路径不是绝对路径`);
    }
    const times = r.files.map(f => f.mtime);
    const sorted = times.slice().sort().reverse();
    assert(JSON.stringify(times) === JSON.stringify(sorted), '没有按时间倒序');
    return `${r.files.length} 份，最新 ${r.files[0].name}`;
  });

  await check('e2 目录不存在时返回空列表（不抛）', async () => {
    const other = path.join(DIR, '另一个项目.sitian');
    await fsp.writeFile(other, '{}', 'utf-8');
    const r = await H.listBaseMapSources(other);
    eq(r.success, true, 'success');
    eq(r.files.length, 0, 'files');
    return '空列表';
  });

  await check('e3 反向探针：内容被改动一点点就必须判否（判据不是空转）', async () => {
    const text = fakeMapText('reverse');
    const r = await H.saveBaseMapSource(projPath, { name: 'reverse.map', text });
    const back = await fsp.readFile(r.path, 'utf-8');
    const tampered = back.replace('971546738', '971546739');
    assert(tampered !== back, '探针没改到东西（判据空转）');
    assert(tampered !== text, '改动后仍与原文相同（判据空转）');
    return '逐字节比对真的会抓出差异';
  });

  // ── 汇总 ───────────────────────────────────────────────────────────────
  const failed = results.filter(r => !r.ok);
  console.log('=== 原始底图来源备份单元测试（Node）===');
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
  return failed.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    console.error('单元测试运行器异常:', err);
    await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
    process.exit(1);
  });
