#!/usr/bin/env node
/**
 * Node 单元测试：「保存到底成没成」的文案判定（src/renderer/src/utils/saveStatusText.js）
 *
 * 背景（2026-10-17，暮雨要求「保存诚实显示」）：
 * 项目态（`.sitian`）下保存是**两段**的 ——
 *   ① geodata 把画布改动推给 projectStore（`{ staged: true, persisted: false }`）
 *   ② projectStore 的 800ms 防抖把项目写进磁盘（成功才 `saveStatus = 'saved'`）
 * 把 ① 当成"存好了"的代价不是报错，而是**在最不该乐观的时刻乐观**：
 *   · 行星图「保存地图」按 `result.success` 报「保存成功」（事实：还在内存里）；
 *   · 底部状态栏在"改了但还没落盘"的整段时间停在上一枚绿标。
 *
 * 这些判定全是纯函数，正好在 Node 层用真实断言钉住（不依赖 CDP / 不依赖真实磁盘）。
 *
 * 用法：node scripts/tests/unit/test_save_status_text.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'saveStatusText.js');

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
  if (actual !== expected) {
    throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}
function has(text, sub, label) {
  assert(String(text).indexOf(sub) >= 0, `${label}: 文字里没有「${sub}」（实际：${text}）`);
}

async function main() {
  const load = async (p) => import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(p, 'utf8'), 'utf8').toString('base64'));
  const { describeSaveAction, resolveSaveDisplay, SAVE_ERR_MAX } = await load(SRC);

  // ══ a. 单次保存动作的返回值 ═══════════════════════════════════════════════
  check('a1 🔴 项目态 staged（只交给项目）**不得**报「已保存」', () => {
    const d = describeSaveAction({ success: true, staged: true, persisted: false });
    eq(d.state, 'staged', 'state');
    eq(d.kind, 'warn', 'kind（必须与成功态不同色）');
    has(d.text, '已交给项目', 'text');
    assert(d.text.indexOf('已保存') < 0, `staged 文案里不许出现「已保存」（实际：${d.text}）`);
    return d.text;
  });

  check('a2 真落盘（persisted）才报「已保存到磁盘」', () => {
    const d = describeSaveAction({ success: true, staged: true, persisted: true });
    eq(d.state, 'saved', 'state');
    eq(d.kind, 'ok', 'kind');
    has(d.text, '已保存到磁盘', 'text');
    return d.text;
  });

  check('a3 失败带原因（截断进文字、全文进 title）', () => {
    const err = 'EBUSY: resource busy or locked, rename E:/图书馆/ROSA/项目.sitian.tmp-1699';
    const d = describeSaveAction({ success: false, error: err });
    eq(d.state, 'error', 'state');
    has(d.text, '保存失败：', 'text');
    has(d.text, 'EBUSY', 'text 里要有原因');
    assert(d.title === `保存失败：${err}`, `title 应是全文（实际：${d.title}）`);
    return d.text;
  });

  check('a4 超长原因被截断（文字不会撑破 chip）', () => {
    const err = 'X'.repeat(SAVE_ERR_MAX + 40);
    const d = describeSaveAction({ success: false, error: err });
    assert(d.text.length <= `保存失败：`.length + SAVE_ERR_MAX + 1, `text 太长：${d.text.length}`);
    assert(d.text.endsWith('…'), '截断后应有省略号');
    assert(d.title.endsWith(err), 'title 必须保留全文');
    return `${d.text.length} 字`;
  });

  check('a5 legacy（没有 staged/persisted 字段）→ 照旧报「已保存」', () => {
    const d = describeSaveAction({ success: true });
    eq(d.state, 'saved', 'state');
    eq(d.text, '已保存', 'text（旧路径直接写文件，旧说法是对的）');
    return d.text;
  });

  check('a6 空返回值按成功处理（旧调用点可能不返回）', () => {
    eq(describeSaveAction().state, 'saved', 'undefined');
    eq(describeSaveAction(null).state, 'saved', 'null');
  });

  // ══ b. 全局合成（项目链 × 画布链 × dirty）═══════════════════════════════════
  check('b1 🔴 项目落盘失败 > 画布失败（数据没进磁盘最重）', () => {
    const d = resolveSaveDisplay({
      project: { saveState: { kind: 'err', text: '保存失败', title: '写入 E:/x.sitian 失败：EACCES' } },
      canvas: { status: 'error', error: 'EBUSY' },
    });
    eq(d.state, 'error', 'state');
    has(d.text, 'EACCES', 'text');
    assert(d.text.indexOf('EBUSY') < 0, '画布侧原因不该压过项目侧');
    return d.text;
  });

  check('b2 只有画布失败时也报错并带原因', () => {
    const d = resolveSaveDisplay({ canvas: { status: 'error', error: '磁盘被占用（EBUSY）' } });
    eq(d.state, 'error', 'state');
    has(d.text, 'EBUSY', 'text');
    has(d.title, 'EBUSY', 'title');
    return d.text;
  });

  check('b3 🔴 有改动未落盘（pending）不得显示「已保存」', () => {
    const d = resolveSaveDisplay({
      project: { saveState: { kind: 'ok', text: '已保存到磁盘' }, pending: true },
    });
    eq(d.state, 'staged', 'state');
    has(d.text, '待写入磁盘', 'text');
    assert(d.text.indexOf('已保存到磁盘') < 0, `pending 时不许沿用旧绿标（实际：${d.text}）`);
    return d.text;
  });

  check('b4 正在写入磁盘 / 正在交给项目（两段各有说法）', () => {
    const a = resolveSaveDisplay({ project: { saveState: { kind: 'busy' } } });
    eq(a.state, 'saving', 'project busy');
    has(a.text, '正在写入磁盘', 'project busy text');
    const b = resolveSaveDisplay({ canvas: { status: 'saving' } });
    eq(b.state, 'saving', 'canvas saving');
    has(b.text, '正在交给项目', 'canvas saving text');
    return `${a.text} / ${b.text}`;
  });

  check('b5 项目态「已交给项目」（warn）是中间档，不是成功', () => {
    const d = resolveSaveDisplay({ project: { saveState: { kind: 'warn', text: '已交给项目，待写入磁盘…' } } });
    eq(d.state, 'staged', 'state');
    eq(d.kind, 'warn', 'kind');
    return d.text;
  });

  check('b6 画布侧 staged 也照实说「正在写入磁盘」', () => {
    const d = resolveSaveDisplay({ canvas: { status: 'staged' } });
    eq(d.state, 'staged', 'state');
    has(d.text, '已交给项目', 'text');
    return d.text;
  });

  check('b7 真落盘成功 → 绿标 + 最后保存时间进 title', () => {
    const d = resolveSaveDisplay({
      project: { saveState: { kind: 'ok', text: '已保存到磁盘' }, pending: false, lastSavedAt: '2026-10-17T12:00:00.000Z' },
    });
    eq(d.state, 'saved', 'state');
    eq(d.kind, 'ok', 'kind');
    has(d.title, '2026-10-17T12:00:00.000Z', 'title');
    return `${d.text}（${d.title}）`;
  });

  check('b8 画布侧 legacy saved 也算绿标', () => {
    const d = resolveSaveDisplay({ canvas: { status: 'saved' } });
    eq(d.state, 'saved', 'state');
    return d.text;
  });

  check('b9 什么都没有 → idle（状态栏不占位）', () => {
    const d = resolveSaveDisplay({});
    eq(d.state, 'idle', 'state');
    eq(d.kind, 'idle', 'kind');
    return d.text;
  });

  check('b10 反向探针：把 staged 与 persisted 弄反必须被抓住', () => {
    // 这里不是"再测一遍实现"，而是确认判据本身有分辨力（否则 a1/a2 是空转）
    const staged = describeSaveAction({ success: true, staged: true, persisted: false });
    const persisted = describeSaveAction({ success: true, staged: true, persisted: true });
    assert(staged.text !== persisted.text, 'staged 与 persisted 的文案必须不同');
    assert(staged.kind !== persisted.kind, 'staged 与 persisted 的颜色必须不同');
    return `${staged.text} ≠ ${persisted.text}`;
  });

  const failed = results.filter(r => !r.ok);
  console.log('=== 保存文案判定单元测试（Node）===');
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  return failed.length ? 1 : 0;
}

main().then(code => process.exit(code)).catch((err) => {
  console.error('单元测试运行器异常:', err);
  process.exit(1);
});
