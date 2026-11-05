#!/usr/bin/env node
/**
 * Node 单元测试：标记 / 剧本 ↔ 笔记绑定（B1，2026-11-05）
 *
 * 为什么这一层要单独守：绑定的**数据结构只有一个字段**（`notePath`，库内相对路径），
 * 出错时不会报错、只会静默错位：
 *   · 路径写法不归一（`a\b.md` vs `a/b.md`）→ 明明绑着却判成"找不到了"；
 *   · 清单没取到（API 不可用 / 未设库）当成**空清单** → 全部绑定一起变红；
 *   · 标记的写口不是白名单 → 一个 patch 就能顺手改别的字段（绕过撤销语义）；
 *   · 撤销回调不排保存 → 撤了但磁盘没撤（A1 在事件表上刚踩过同一条）。
 *
 * 用法：node scripts/tests/unit/test_note_binding.js
 * 退出码：0 = 全通过。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src');

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
function eq(a, b, label) {
  if (a !== b) throw new Error(`${label}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
/** 读源码并归一化换行（index 是 LF、工作树是 CRLF —— 不归一化切片会失败 → 假红） */
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

async function loadUtil() {
  // 纯函数模块没有相对 import，直接用 data URL 载入即可（不落地临时文件）
  const src = read('src/renderer/src/utils/noteBinding.js');
  const url = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(src);
  return import(url);
}

async function main() {
  const U = await loadUtil();
  const { normalizeNotePath, noteBasename, noteLinkState, knownNotesFrom } = U;

  check('a1 路径归一：反斜杠 / ./ 前缀 / 重复斜杠 / 空白 → 同一种写法', () => {
    eq(normalizeNotePath('地理\\北境\\风岬港.md'), '地理/北境/风岬港.md', 'Windows 反斜杠');
    eq(normalizeNotePath('  ././地理/北境.md  '), '地理/北境.md', './ 前缀与空白');
    eq(normalizeNotePath('a//b///c.md'), 'a/b/c.md', '重复斜杠');
    eq(normalizeNotePath(''), '', '空串');
    eq(normalizeNotePath(null), '', 'null');
    eq(normalizeNotePath(undefined), '', 'undefined');
    eq(normalizeNotePath('..\\逃逸.md'), '../逃逸.md', '`..` 不许被剥掉（越界留给主进程守卫）');
    return '7 种写法归一';
  });

  check('a2 显示名：最后一段去 .md（面板上不必让人读整条路径）', () => {
    eq(noteBasename('地理/北境/风岬港.md'), '风岬港', '多级路径');
    eq(noteBasename('风岬港.md'), '风岬港', '单级');
    eq(noteBasename('地理/北境/风岬港'), '风岬港', '没扩展名');
    eq(noteBasename(''), '', '空');
    return '4 例';
  });

  check('a3 状态三态：没绑 / 绑着且在库里 / 绑着但库里没了', () => {
    const known = ['地理/北境/风岬港.md', '事件/灰塔之变.md'];
    eq(noteLinkState('', known).state, 'unbound', '空路径');
    eq(noteLinkState(null, known).state, 'unbound', 'null 路径');
    eq(noteLinkState('地理/北境/风岬港.md', known).state, 'bound', '在库里');
    eq(noteLinkState('地理\\北境\\风岬港.md', known).state, 'bound', '反斜杠写法也要认');
    eq(noteLinkState('地理/北境/改名了.md', known).state, 'dangling', '库里没有 → 漂移');
    // 清单用对象数组（listVaultNotes 的形状：sourcePath / path 都认）
    eq(noteLinkState('事件/灰塔之变.md', [{ sourcePath: '事件/灰塔之变.md' }]).state, 'bound', 'sourcePath');
    eq(noteLinkState('事件/灰塔之变.md', [{ path: '事件/灰塔之变.md' }]).state, 'bound', 'path');
    return '7 例';
  });

  check('a4 🔴 清单还没取到（null）≠ 空清单：不许武断说“找不到了”', () => {
    eq(noteLinkState('地理/北境/风岬港.md', null).state, 'bound',
      '清单取不到时只显示“已绑定”，不能报漂移');
    eq(noteLinkState('地理/北境/风岬港.md', undefined).state, 'bound', 'undefined 同理');
    // 反向探针：真给了空清单，就必须报漂移（否则“找不到”这条判据是空转）
    eq(noteLinkState('地理/北境/风岬港.md', []).state, 'dangling', '空清单 → 漂移');
    return 'null/undefined 不算漂移；空清单才算（负向探针验过）';
  });

  check('a5 knownNotesFrom：读失败 → null（不是空数组）', () => {
    assert(knownNotesFrom(null) === null, 'null 输入');
    assert(knownNotesFrom({ success: false, notes: [] }) === null, '失败结果');
    assert(knownNotesFrom({ success: true }) === null, '成功但没 notes 字段');
    const rows = [{ sourcePath: 'a.md' }];
    assert(Array.isArray(knownNotesFrom({ success: true, notes: rows })), '成功且有 notes → 数组');
    return '4 例';
  });

  check('a5b 🔴 判漂移用的是全库索引路径，不是“扫描范围内的地图笔记”', () => {
    const U2 = U;
    assert(typeof U2.knownPathsFrom === 'function', '缺 knownPathsFrom（vault-index-paths 的取数口）');
    assert(U2.knownPathsFrom(null) === null, 'null 输入');
    assert(U2.knownPathsFrom({ success: false, paths: [] }) === null, '读失败 → null');
    assert(U2.knownPathsFrom({ success: true }) === null, '成功但没 paths');
    eq(U2.knownPathsFrom({ success: true, paths: ['a.md'] }).length, 1, '正常取回');
    // 真机第一跑就是拿 listVaultNotes（只列 03 设定 下的地图笔记）判漂移 → 把绑好的资料笔记误报成“找不到了”
    const vue = read('src/renderer/src/components/VaultLoreSection.vue');
    assert(vue.includes('api.vaultIndexPaths'), '组件没有用 vaultIndexPaths（会误报漂移）');
    assert(!/store\.listVaultNotes\(/.test(vue), '组件里还在调 store.listVaultNotes()（那是地图笔记口径）');
    return '全库索引路径（负向：换回 listVaultNotes 会红）';
  });

  const store = read('src/renderer/src/store/geodataModules/scenarioEditing.js');

  check('a6b 标记写口的**撤销也落盘**（B1 真机抓到的：改了标记再 Ctrl+Z，磁盘上还是新值）', () => {
    const at = store.indexOf('function updateScenarioMarker(');
    const end = store.indexOf('\n  function ', at + 10);
    const body = store.slice(at, end > 0 ? end : store.length);
    // put 是 undo/redo 共用的落点：调度必须在里面，而不是只在 execute 之后
    const putAt = body.indexOf('const put = (val) => {');
    assert(putAt >= 0, '找不到 put()');
    // 取一段窗口判（put 内部先有对象字面量的 `};`，不能用 indexOf('};') 截断）
    const putBody = body.slice(putAt, putAt + 900);
    assert(putBody.includes('scheduleAutoSaveScenarios('), 'put() 里没排保存 —— 撤销不会落盘');
    assert(!/\n\s+saveScenarios\(\);/.test(body), '写口里还在同步 saveScenarios（会卡）');
    // 增 / 删标记的 undo 回调同理
    for (const fn of ['addScenarioMarker', 'removeScenarioMarker']) {
      const a = store.indexOf('function ' + fn + '(');
      assert(a >= 0, `找不到 ${fn}`);
      const e = store.indexOf('\n  function ', a + 10);
      const b = store.slice(a, e > 0 ? e : store.length);
      assert(/undo:\s*\(\)\s*=>\s*\{[\s\S]{0,600}?scheduleAutoSaveScenarios\(/.test(b)
        || /spliceBack[\s\S]{0,300}?scheduleAutoSaveScenarios\(/.test(b),
        `${fn} 的撤销路径里没排保存`);
    }
    return 'put/undo 都是落盘点';
  });

  // ── 源码闸门：字段白名单 / 写口 / 组件不直接写 ──────────────────────────

  check('a6 标记写口：notePath 在白名单里，且非字符串被拒（不许塞对象）', () => {
    const at = store.indexOf('function updateScenarioMarker(');
    assert(at >= 0, '找不到 updateScenarioMarker');
    const end = store.indexOf('\n  function ', at + 10);
    const body = store.slice(at, end > 0 ? end : store.length);
    assert(body.includes("patch.notePath !== undefined"), '标记写口没处理 notePath');
    assert(/typeof raw !== 'string'/.test(body), '没拒绝非字符串的 notePath（会把对象塞进数据）');
    assert(body.includes("KEYS = ['name', 'type', 'icon', 'color', 'x', 'y', 'notePath']"),
      'notePath 没进“值没变就不压空撤销”的 KEYS');
    assert(body.includes('normalizeNotePath('), '没走统一的路径归一（写法会漂）');
    return '白名单 + 归一 + 拒绝非字符串';
  });

  check('a7 剧本写口 setScenarioNotePath：只认 notePath / 空值摘键 / 撤销也落盘', () => {
    const at = store.indexOf('function setScenarioNotePath(');
    assert(at >= 0, '找不到 setScenarioNotePath');
    const end = store.indexOf('\n  function ', at + 10);
    const body = store.slice(at, end > 0 ? end : store.length);
    assert(body.includes('execute('), '没走 execute()（只读态拦不住、Ctrl+Z 也回不来）');
    assert(body.includes("delete next.notePath"), '解绑时没摘键（会留空指针）');
    assert(body.includes('scheduleAutoSaveScenarios('), '没排保存 —— 撤了磁盘不会变（A1 踩过）');
    assert(!body.includes('saveScenarios('), '热路径别同步 saveScenarios（8MB 项目会卡）');
    return 'execute + 摘键 + 防抖落盘';
  });

  check('a8 组件：binding 形态只调父面板给的写口，不在组件里直接改数据', () => {
    const vue = read('src/renderer/src/components/VaultLoreSection.vue');
    assert(vue.includes("bindMode.value === 'binding'"), '组件里没有 binding 分支');
    assert(vue.includes('props.bindFn'), 'binding 绑定没走 props.bindFn');
    assert(vue.includes('props.unbindFn'), 'binding 解绑没走 props.unbindFn');
    // 只看**写函数** bind() 里的那个分支（isBound 里的同名判断不算）
    const fnAt = vue.indexOf('function bind(hit) {');
    assert(fnAt >= 0, '找不到 bind(hit)');
    const branch = vue.slice(fnAt, vue.indexOf('const res = store.bindNodeToNote', fnAt));
    assert(branch.includes("bindMode.value === 'binding'"), 'bind() 里没有 binding 分支');
    assert(!branch.includes('store.'), 'binding 分支里不该直接碰 store 写口（应由父面板决定写哪）');
    return '写口由父面板注入';
  });

  // ── 汇总 ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log('=== 标记/剧本 ↔ 笔记绑定（Node）单元测试 ===');
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
