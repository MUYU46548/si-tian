/**
 * interior/shortcuts.js 单测（2026-11-15，台账 A27）
 *
 * 快捷键最容易出的两种错：
 *   ① 互相踩：Ctrl+Shift+Z 同时命中 Ctrl+Z（撤销一次做了两次，或者重做变成撤销）；
 *   ② 该管住时不管：在输入框里打 "g" 把网格关了（调用方用 isEditingInput 挡，这里验匹配层不背这个锅）。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.cwd());
const mod = await import(pathToFileURL(path.join(ROOT, 'src/renderer/src/interior/shortcuts.js')).href);
const { INTERIOR_SHORTCUTS, matchShortcut, findShortcut, groupShortcuts, describeKeys } = mod;

const results = [];
function check(name, fn) {
  try {
    const note = fn();
    results.push({ name, ok: true, note });
    console.log(`  ✅ ${name}${note ? ` —— ${note}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, note: e && e.message });
    console.log(`  ❌ ${name} —— ${e && e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const ev = (key, opt = {}) => ({
  key,
  ctrlKey: !!opt.ctrl, metaKey: !!opt.meta, shiftKey: !!opt.shift, altKey: !!opt.alt,
});

check('s1 表结构自检：每条都有 id/group/label/hint/keys/match，且 id 不重复到"同键两义"', () => {
  assert(INTERIOR_SHORTCUTS.length >= 10, `快捷键应 ≥10 条，实际 ${INTERIOR_SHORTCUTS.length}`);
  const seen = new Set();
  for (const e of INTERIOR_SHORTCUTS) {
    for (const f of ['id', 'group', 'label', 'hint', 'keys', 'match']) {
      assert(e[f] !== undefined, `${e.id || '?'} 缺字段 ${f}`);
    }
    assert(Array.isArray(e.keys) && e.keys.length > 0, `${e.id} 的 keys 不能为空`);
    const sig = `${e.match.key}|${!!e.match.mod}|${!!e.match.shift}`;
    assert(!seen.has(sig), `两条快捷键的匹配规则完全相同：${sig}`);
    seen.add(sig);
  }
  return `${INTERIOR_SHORTCUTS.length} 条 / ${seen.size} 种按法`;
});

check('s2 Ctrl+Z 命中撤销，Ctrl+Shift+Z 绝不能命中撤销（会一次撤两步）', () => {
  const undo = INTERIOR_SHORTCUTS.find((e) => e.id === 'undo');
  assert(matchShortcut(ev('z', { ctrl: true }), undo) === true, 'Ctrl+Z 应命中撤销');
  assert(matchShortcut(ev('z', { ctrl: true, shift: true }), undo) === false, 'Ctrl+Shift+Z 不许命中撤销');
  assert(matchShortcut(ev('z'), undo) === false, '裸 z 不许命中撤销');
  return '3 种按法';
});

check('s3 Ctrl+Shift+Z 与 Ctrl+Y 都命中重做', () => {
  const a = findShortcut(ev('z', { ctrl: true, shift: true }));
  const b = findShortcut(ev('y', { ctrl: true }));
  assert(a && a.id === 'redo', `Ctrl+Shift+Z 应重做，实际 ${a && a.id}`);
  assert(b && b.id === 'redo', `Ctrl+Y 应重做，实际 ${b && b.id}`);
  return '两种按法同一动作';
});

check('s4 工具键：裸 1/2/3/4 命中，带 Ctrl 不命中（不能抢浏览器快捷键）', () => {
  const map = { 1: 'tool:pan', 2: 'tool:add_wall', 3: 'tool:add_door', 4: 'tool:add_window' };
  for (const [k, id] of Object.entries(map)) {
    const hit = findShortcut(ev(k));
    assert(hit && hit.id === id, `裸 ${k} 应命中 ${id}，实际 ${hit && hit.id}`);
    const withCtrl = findShortcut(ev(k, { ctrl: true }));
    assert(!withCtrl || withCtrl.match.mod === true, `Ctrl+${k} 不该命中工具键`);
  }
  return '4 个工具键';
});

check('s5 视图键：F / G / M 命中，按住 Alt 一律不算（输入法里会变特殊字符）', () => {
  assert(findShortcut(ev('f')).id === 'view:fit', 'F → 铺满');
  assert(findShortcut(ev('g')).id === 'view:grid', 'G → 网格');
  assert(findShortcut(ev('m')).id === 'view:dims', 'M → 标注');
  assert(findShortcut(ev('f', { alt: true })) === null, 'Alt+F 不许命中');
  return '3 键 + Alt 排除';
});

check('s6 帮助：? 与 F1 都开帮助（? 自带 Shift，必须显式声明才准）', () => {
  const q = findShortcut(ev('?', { shift: true }));
  const f1 = findShortcut(ev('F1'));
  assert(q && q.id === 'help', '? 应开帮助');
  assert(f1 && f1.id === 'help', 'F1 应开帮助');
  // 不带 Shift 的 '?'（某些合成事件）不该命中：否则会在输入框里误开
  assert(findShortcut(ev('?', { shift: false })) === null, '无 Shift 的 ? 不该命中');
  return '? / F1';
});

check('s7 未登记的键返回 null（不许瞎触发）', () => {
  for (const k of ['q', 'Escape', 'Enter', 'Backspace', '5', 'F2']) {
    assert(findShortcut(ev(k)) === null, `${k} 不该命中任何新快捷键`);
  }
  return '6 个未登记键';
});

check('s8 groupShortcuts：分组带顺序、同一 id 的另一种按法归到 alternates', () => {
  const groups = groupShortcuts();
  assert(groups.length >= 4, `分组应 ≥4，实际 ${groups.length}`);
  const edit = groups.find((g) => g.group === '编辑');
  assert(edit, '应有"编辑"组');
  const redo = edit.items.find((x) => x.id === 'redo');
  assert(redo, '编辑组里应有重做');
  assert((redo.alternates || []).length === 1, `重做应有 1 个备选按法，实际 ${(redo.alternates || []).length}`);
  assert(redo.alternates[0].join('+') === 'Ctrl+Y', `备选应是 Ctrl+Y，实际 ${redo.alternates[0]}`);
  return groups.map((g) => `${g.group}(${g.items.length})`).join(' / ');
});

check('s9 describeKeys 能正确拼展示串', () => {
  const undo = INTERIOR_SHORTCUTS.find((e) => e.id === 'undo');
  assert(describeKeys(undo) === 'Ctrl+Z', `应为 Ctrl+Z，实际 ${describeKeys(undo)}`);
  const help = INTERIOR_SHORTCUTS.filter((e) => e.id === 'help')[1];
  assert(describeKeys(help) === 'F1', `应为 F1，实际 ${describeKeys(help)}`);
  return 'Ctrl+Z / F1';
});

const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length ? '❌' : '✅'} shortcuts 单测：${results.length - bad.length}/${results.length} 通过`);
process.exit(bad.length ? 1 : 0);
