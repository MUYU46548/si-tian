#!/usr/bin/env node
/**
 * Node 单元测试：逐年切片「批量落盘」（src/main/handlers/exportFramesHandler.js）
 *
 * 为什么必须有这一层：CDP 用例里的 `window.sitianAPI` 是 **mock**，主进程真正的
 * 「选目录 + 写 N 个文件」一行都跑不到。而这是整个功能里唯一会**动用户磁盘**的一段：
 *   ① 名字没消毒 → 帧名里的 `../` 能写到目录之外（用户数据被覆盖）；
 *   ② 不是原子写 → 中途失败留半个文件（本项目的数据安全承诺明确禁止）；
 *   ③ 同名子目录重复导出 → 把上一次的帧冲掉（用户以为"两批都在"）。
 * 这里直接对主进程那一层做**真落盘**断言（顶层不 require electron，所以能直接 require）。
 *
 * 用法：node scripts/tests/unit/test_export_frames.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MOD = path.join(ROOT, 'src', 'main', 'handlers', 'exportFramesHandler.js');

const results = [];
/**
 * ⚠️ **必须 async/await**：本文件的被测函数全是 Promise。写成同步 `check(name, fn)` 时
 * `fn()` 返回的是 Promise → 里面的断言失败了也抓不到（`ok: true` + `[object Promise]` 的
 * **假绿**，实测踩过），而未捕获的 rejection 还会把退出码变成 1、摘要却写着「全通过」。
 */
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/** 可写临时根（MSYS 的 /tmp 在 Windows 上 Node 不认 —— 与其它 unit 用例同因） */
function pickTmpRoot() {
  const cands = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : '',
    os.tmpdir(), process.env.TEMP, process.env.TMP, os.homedir(),
  ];
  for (const c of cands) {
    if (!c || !path.isAbsolute(c)) continue;
    if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(c)) continue;
    try {
      fs.mkdirSync(c, { recursive: true });
      fs.accessSync(c, fs.constants.W_OK);
      return c;
    } catch (_) { /* 换下一个 */ }
  }
  return null;
}

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

async function main() {
  const { writeFrames, safeFileName, safeDirName } = require(MOD);
  const root = pickTmpRoot();
  if (!root) throw new Error('找不到可写的临时目录');
  const base = fs.mkdtempSync(path.join(root, 'sitian-frames-'));

  // ---------- 1. 正常写入 ----------
  await check('t1 正常写入：N 帧 + frames.json 清单，内容与清单字段都对得上', async () => {
    const r = await writeFrames(base, {
      dirName: 'slices-a',
      files: [
        { name: 'frame_0001_era00_2000.svg', text: '<svg id="a"></svg>' },
        { name: 'frame_0002_era01_2013.svg', text: '<svg id="b"></svg>' },
        { name: 'frame_0002_era01_2013.png', dataUrl: PNG_1PX },
      ],
      manifest: { kind: 'scenario-slices', frameCount: 2 },
    });
    assert(r.success === true, `写入应成功：${JSON.stringify(r)}`);
    eq(r.count, 3, '文件数');
    eq(r.dirName, 'slices-a', '子目录名');
    const dir = path.join(base, 'slices-a');
    assert(fs.existsSync(path.join(dir, 'frame_0001_era00_2000.svg')), '缺第 1 帧');
    eq(fs.readFileSync(path.join(dir, 'frame_0002_era01_2013.svg'), 'utf8'), '<svg id="b"></svg>', '帧内容');
    const png = fs.readFileSync(path.join(dir, 'frame_0002_era01_2013.png'));
    assert(png.length > 50 && png[0] === 0x89 && png[1] === 0x50, 'PNG 应被正确解码（PNG 魔数）');
    const mf = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8'));
    eq(mf.frameCount, 2, '清单自带字段');
    eq(mf.dir, 'slices-a', '清单记下目录名');
    // 清单里的 files = **帧文件**（按帧序，不含 frames.json 自身）—— 外部 ffmpeg 直接吃这个列表
    eq(mf.files.length, 3, '清单里的帧文件清单');
    assert(mf.files.every((n) => n !== 'frames.json'), '清单不该把自己列进去');
    eq(r.files.length, 4, '返回值里的 files = 本次写下的全部条目（含清单）');
    assert(typeof mf.writtenAt === 'string' && mf.writtenAt.length > 10, '清单应有写入时间');
    return `${r.count} 帧 + frames.json，${r.bytes} 字节`;
  });

  // ---------- 2. 不覆盖同名子目录 ----------
  await check('t2 同名子目录**绝不覆盖**：第二次导出落到 -2（用户以为"两批都在"的前提）', async () => {
    const r2 = await writeFrames(base, {
      dirName: 'slices-a',
      files: [{ name: 'frame_0001_era00_2000.svg', text: '<svg id="c"></svg>' }],
    });
    assert(r2.success === true, `写入应成功：${JSON.stringify(r2)}`);
    eq(r2.dirName, 'slices-a-2', '第二次应落到 -2');
    // 第一次的内容必须原封不动
    eq(fs.readFileSync(path.join(base, 'slices-a', 'frame_0001_era00_2000.svg'), 'utf8'),
      '<svg id="a"></svg>', '第一批不应被覆盖');
    return '第一批保留，第二批进 slices-a-2';
  });

  // ---------- 3. 名字消毒 / 路径穿越 ----------
  await check('t3 帧名含路径分隔符或 .. → 整批拒绝（不许写到目录之外）', async () => {
    const a = await writeFrames(base, { dirName: 'evil', files: [{ name: '../escape.svg', text: 'x' }] });
    eq(a.success, false, '含 .. 应拒绝');
    assert(/不合法/.test(a.error || ''), `错误要说清原因：${a.error}`);
    const b = await writeFrames(base, { dirName: 'evil', files: [{ name: 'sub/frame.svg', text: 'x' }] });
    eq(b.success, false, '含分隔符应拒绝');
    // 拒绝必须是"整批不写"：连目录都不该建出来
    assert(!fs.existsSync(path.join(base, 'evil')), '被拒的批次不应留下目录');
    return '两例都拒绝，且不留目录';
  });

  await check('t4 每帧必须**恰好**带 text 或 dataUrl 之一；重复名拒绝', async () => {
    const a = await writeFrames(base, { dirName: 'bad1', files: [{ name: 'x.svg', text: 'a', dataUrl: PNG_1PX }] });
    eq(a.success, false, '同时带两者应拒绝');
    const b = await writeFrames(base, { dirName: 'bad2', files: [{ name: 'x.svg' }] });
    eq(b.success, false, '都不带应拒绝');
    const c = await writeFrames(base, {
      dirName: 'bad3',
      files: [{ name: 'x.svg', text: 'a' }, { name: 'x.svg', text: 'b' }],
    });
    eq(c.success, false, '重名应拒绝');
    const d = await writeFrames(base, { dirName: 'bad4', files: [{ text: 'a' }] });
    eq(d.success, false, '缺文件名应拒绝');
    return '4 例全拒';
  });

  await check('t5 非法 dataURL 拒绝；文件名里的非法字符被消毒而不是报错', async () => {
    const a = await writeFrames(base, { dirName: 'bad5', files: [{ name: 'x.png', dataUrl: 'not-a-data-url' }] });
    eq(a.success, false, '非法 dataURL 应拒绝');
    assert(/dataURL/.test(a.error || ''), `错误要点名 dataURL：${a.error}`);
    const b = await writeFrames(base, {
      dirName: 'sanitize',
      files: [{ name: 'a<b>:"c"|d?.svg', text: '<svg/>' }],
    });
    assert(b.success === true, `非法字符应被消毒而不是拒绝：${JSON.stringify(b)}`);
    const files = fs.readdirSync(path.join(base, 'sanitize'));
    assert(files.some((f) => f === 'a_b___c__d_.svg'), `实际文件：${files.join(', ')}`);
    return '非法 dataURL 拒；文件名消毒';
  });

  // ---------- 4. 目录与批次闸门 ----------
  await check('t6 目录不存在 / 非绝对路径 / 指向文件 → 各给 error，且**不抛异常**', async () => {
    const a = await writeFrames(path.join(base, 'no-such-dir'), { files: [{ name: 'a.svg', text: 'x' }] });
    eq(a.success, false, '目录不存在应拒绝');
    assert(/不存在/.test(a.error || ''), `原因要说清：${a.error}`);
    const b = await writeFrames('relative/dir', { files: [{ name: 'a.svg', text: 'x' }] });
    eq(b.success, false, '相对路径应拒绝');
    const f = path.join(base, 'a-file.txt');
    fs.writeFileSync(f, 'x');
    const c = await writeFrames(f, { files: [{ name: 'a.svg', text: 'x' }] });
    eq(c.success, false, '目标是文件应拒绝');
    const d = await writeFrames(base, { files: [] });
    eq(d.success, false, '空批次应拒绝');
    const e = await writeFrames('', { files: [{ name: 'a.svg', text: 'x' }] });
    eq(e.success, false, '空目录参数应拒绝');
    return '5 例全拒（返回 error 而非抛出）';
  });

  await check('t7 帧数超上限 → 拒绝；上限常量导出可见', async () => {
    const mod = require(MOD);
    assert(mod.MAX_FILES >= 200, `上限应给足（真实数据 ~11 帧）：${mod.MAX_FILES}`);
    const files = [];
    for (let i = 0; i < mod.MAX_FILES + 1; i++) files.push({ name: `f${i}.svg`, text: 'x' });
    const r = await writeFrames(base, { dirName: 'toomany', files });
    eq(r.success, false, '超上限应拒绝');
    assert(/超过上限/.test(r.error || ''), r.error);
    return `上限 ${mod.MAX_FILES} 生效`;
  });

  // ---------- 5. 原子性 ----------
  await check('t8 原子写：写完之后目录里**没有** .tmp- 残留', async () => {
    const r = await writeFrames(base, {
      dirName: 'atomic',
      files: [{ name: 'a.svg', text: 'x' }, { name: 'b.svg', text: 'y' }],
      manifest: { kind: 'scenario-slices' },
    });
    assert(r.success === true, JSON.stringify(r));
    const left = fs.readdirSync(path.join(base, 'atomic')).filter((f) => f.includes('.tmp-'));
    eq(left.length, 0, `残留临时文件：${left.join(', ')}`);
    return '无 .tmp- 残留';
  });

  await check('t9 不给 manifest → 不写 frames.json（但帧照写）', async () => {
    const r = await writeFrames(base, { dirName: 'nomanifest', files: [{ name: 'a.svg', text: 'x' }] });
    assert(r.success === true, JSON.stringify(r));
    eq(r.manifestPath, null, 'manifestPath 应为 null');
    const list = fs.readdirSync(path.join(base, 'nomanifest'));
    assert(!list.includes('frames.json'), `不该有 frames.json：${list.join(', ')}`);
    return '只写帧';
  });

  // ---------- 6. 消毒函数本身 ----------
  await check('t10 safeFileName / safeDirName：空值兜底、去掉分隔符与前导点、目录名截断', () => {
    eq(safeFileName('a/b\\c.svg'), 'a_b_c.svg', '分隔符换下划线');
    eq(safeFileName(''), 'frame', '空 → 兜底名');
    eq(safeFileName(null), 'frame', 'null → 兜底名');
    eq(safeFileName('..hidden.svg'), 'hidden.svg', '前导点去掉（不许造出隐藏/上级文件）');
    eq(safeFileName('a\u0000b.svg'), 'a_b.svg', '控制字符消毒');
    const long = safeDirName('x'.repeat(200));
    assert(long.length <= 80, `目录名应截断：${long.length}`);
    eq(safeDirName(''), 'sitian-slices', '空目录名兜底');
    return '消毒规则 7 例';
  });

  // ---------- 汇总 ----------
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  }
  console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败：');
    for (const f of failed) console.log(`  · ${f.name}: ${f.detail}`);
  }
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.error('用例异常：', e); process.exit(1); });
