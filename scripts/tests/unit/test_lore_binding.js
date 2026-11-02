#!/usr/bin/env node
/**
 * Node 单测：读料桥「稳定身份绑定」纯函数层（N3a-3，2026-11-02）
 *
 * 守什么（施工单点名的五条 + 两条防线）：
 *   ① **改名检测**：笔记换了路径、还是同一篇 → 重绑并上报 `renamed`（from/to 都是路径）；
 *   ② **歧义不猜**：两篇同名笔记 → **不重绑**，进 `lost` 且带可读原因（绝不按名字相似度兜底）；
 *   ③ **确定性**：`candidateToNodeDraft` 同一输入两次 → 同一个 id（导两次不会变两个节点）；
 *   ④ **不可变**：入参不被改写、返回值是冻结的新对象（对账不改旧绑定表）；
 *   ⑤ **源码门**：两个 store 写口（`bindNodeToNote` / `importVaultCandidate`，外加 `unbindNodeNote`）
 *      都在 `store/writeGate.js#MEMORY_WRITE_CALLSITES` 里，且函数体首行有 `guardWrite(`；
 *      并且它们真的被 geodata.js 装配（防"写了没接上"）。
 * 另加两条（都会静默坏）：
 *   ⑥ **索引侧事实**：`vaultIndex` 条目带 `sitianId`（显式稳定 id）、搜索结果带 `aliases`/`sitianId` ——
 *      少了 `aliases`，UI 建的绑定与索引条目的**指纹就对不上**，一改名就被误判失联（这条用例专门钉死它）；
 *   ⑦ **读料只读**：建索引跑完，库快照逐字节不变、不建 `.sitian`（红线：读料必须只读）。
 *
 * 用法：node scripts/tests/unit/test_lore_binding.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 *
 * ⚠️ 被册模块是 ESM（Vite 源码），本文件是 CJS → 用 `data:` URL 动态 import。
 *    它还 import 了两个同目录模块（vaultRelink / normalizeId），所以这里写了个**递归**
 *    的小加载器：把相对 import 换成各自的 data URL（与其它 unit 用例同一手法，只是支持多层）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const LORE = path.join(UTILS, 'loreBinding.js');
const STORE_MOD = path.join(ROOT, 'src', 'renderer', 'src', 'store', 'geodataModules', 'loreBinding.js');
const GATE = path.join(ROOT, 'src', 'renderer', 'src', 'store', 'writeGate.js');
const GEODATA = path.join(ROOT, 'src', 'renderer', 'src', 'store', 'geodata.js');
const LORE_UI = path.join(ROOT, 'src', 'renderer', 'src', 'components', 'VaultLoreSection.vue');

const vi = require(path.join(ROOT, 'src', 'main', 'vaultIndex.js'));

// ── ESM 加载器（递归把相对 import 换成 data: URL）────────────────────────────
const URL_CACHE = new Map();
function dataUrl(src) {
  return 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');
}
async function esmUrl(absPath) {
  const abs = /\.js$/.test(absPath) ? absPath : absPath + '.js';
  if (URL_CACHE.has(abs)) return URL_CACHE.get(abs);
  const src = fs.readFileSync(abs, 'utf8');
  const specs = [...new Set([...src.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1]))];
  let out = src;
  for (const spec of specs) {
    const depUrl = await esmUrl(path.resolve(path.dirname(abs), spec));
    out = out.split(`from '${spec}'`).join(`from ${JSON.stringify(depUrl)}`);
  }
  const url = dataUrl(out);
  URL_CACHE.set(abs, url);
  return url;
}

// ── 断言小工具（与其它 unit 用例同形）──────────────────────────────────────
const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (e) {
    results.push({ name, ok: false, detail: (e && e.message) || String(e) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}
function deepEq(actual, expected, label) {
  const a = JSON.stringify(actual); const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: 期望 ${b}，实际 ${a}`);
}
function readFile(abs) { return fs.readFileSync(abs, 'utf8'); }
function readRel(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ── 固定数据 ───────────────────────────────────────────────────────────────
const OLD_PATH = '03 设定/11 地理系统/行星/曜川星/雾隐城.md';
const NEW_PATH = '03 设定/11 地理系统/行星/曜川星/旧城区/雾隐城.md';

/** 一条索引条目（字段形状与 vaultIndex.parseEntry 对齐） */
function entry(over = {}) {
  return {
    path: OLD_PATH,
    name: '雾隐城',
    title: '雾隐城',
    aliases: [],
    sitianId: '',
    size: 1200,
    mtimeMs: 1700000000000,
    layerHint: 'city',
    kind: 'map',
    ...over,
  };
}

/** 一条「上一轮的绑定」（= 节点上的 node.lore） */
function binding(over = {}) {
  return { path: OLD_PATH, title: '雾隐城', noteId: '雾隐城', at: '2026-11-01T00:00:00.000Z', ...over };
}

function makeVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-lorebind-'));
  const files = {
    '03 设定/11 地理系统/行星/曜川星/雾隐城.md':
      '---\n层级: 城市\n别名: [雾隐]\n---\n雾隐城，北境的港。\n',
    '03 设定/11 地理系统/行星/曜川星/带稳定ID.md':
      '---\n层级: 城市\nsitian-id: S-77\n---\n有显式稳定 id 的地方。\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf-8');
  }
  return dir;
}

function snapshot(root) {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { out.push(['dir', path.relative(root, full).replace(/\\/g, '/')]); walk(full); }
      else out.push(['file', path.relative(root, full).replace(/\\/g, '/'), fs.statSync(full).size]);
    }
  })(root);
  out.sort((a, b) => String(a).localeCompare(String(b)));
  return JSON.stringify(out);
}

async function main() {
  const mod = await import(await esmUrl(LORE));
  const {
    bindingKey, fingerprintOf, reconcileBindings, candidateToNodeDraft,
    noteRefOf, sameNoteRef, noteIdOf, VAULT_IMPORT_TAG,
  } = mod;

  // ① 绑定键的优先级：显式 id > 路径 > 标题；别名**不**进 key
  await check('一：bindingKey 优先级 = 显式 id > 路径 > 标题；别名不进键；认不出给空串', () => {
    eq(bindingKey(entry({ sitianId: 'S-42' })), 'id:S-42', '显式 id 压过路径');
    eq(bindingKey(entry()), `path:${OLD_PATH}`, '没有显式 id 时用路径');
    eq(bindingKey({ path: './03 设定\\11 地理系统\\\\x.md' }), 'path:03 设定/11 地理系统/x.md', '路径归一化');
    eq(bindingKey({ title: '雾隐城' }), 'title:雾隐城', '没有路径时退到标题');
    eq(bindingKey({}), '', '什么都没有 → 不可识别');
    eq(bindingKey(entry({ aliases: ['雾隐'] })), `path:${OLD_PATH}`, '别名是可变显示名，不当键');
    eq(bindingKey(entry({ sitianId: 'S-42' })), bindingKey(entry({ sitianId: 'S-42' })), '确定性');
    return 'id / path / title 三档齐全，别名与空输入按口径处理';
  });

  // ② 指纹与位置无关，且**不含** size / mtime（编辑不该改身份）
  await check('二：fingerprint 不含 size/mtime（改一个字不算换了一篇），别名排序无关', () => {
    const a = fingerprintOf(entry({ size: 100, mtimeMs: 1 }));
    const b = fingerprintOf(entry({ size: 999999, mtimeMs: 9e12, path: NEW_PATH }));
    eq(a, b, '只改 size/mtime/路径，指纹必须不变');
    eq(
      fingerprintOf({ title: '雾隐城', aliases: ['乙', '甲'] }),
      fingerprintOf({ title: '雾隐城', aliases: ['甲', '乙'] }),
      '别名顺序不影响指纹',
    );
    assert(
      fingerprintOf({ title: '雾隐城', aliases: ['雾隐'] }) !== fingerprintOf({ title: '雾隐城' }),
      '别名参与指纹（改名认亲的第二证据）',
    );
    eq(fingerprintOf({ sitianId: 'S-9', title: '随便' }), 'id:S-9', '有显式 id 时指纹就用 id');
    eq(fingerprintOf({}), '', '认不出 → 空指纹');
    return 'size/mtime 不参与；别名集合（排序后）参与；显式 id 优先';
  });

  // ③ 改名检测：路径变了、还是同一篇 → 重绑 + renamed（from/to = 路径）
  await check('三：改名检测 —— 同一篇换路径 → 重绑，renamed 报 from/to', () => {
    const prev = { 'node-1': binding() };
    const before = JSON.stringify(prev);
    const r = reconcileBindings(prev, [entry({ path: NEW_PATH })]);
    eq(r.lost.length, 0, '不该判失联');
    eq(r.renamed.length, 1, '应报一条改名');
    eq(r.renamed[0].entityId, 'node-1', '改名归属');
    eq(r.renamed[0].from, OLD_PATH, 'from = 旧路径');
    eq(r.renamed[0].to, NEW_PATH, 'to = 新路径');
    eq(r.renamed[0].via, 'fingerprint', '这一档是靠指纹认出来的');
    eq(r.bindings['node-1'].path, NEW_PATH, '绑定跟到新路径');
    eq(r.bindings['node-1'].title, '雾隐城', '标题照旧');
    assert(!r.bindings['node-1'].entityId, '绑定表里不需要再带 entityId 字段（键就是它）');
    eq(JSON.stringify(prev), before, '入参不许被改写');
    return `重绑 ${r.renamed[0].from} → ${r.renamed[0].to}（via=${r.renamed[0].via}）`;
  });

  // ③b 有显式稳定 id 时：改名也能认出来，而且是**键**命中（不是猜）
  await check('四：显式稳定 id —— 改名/换目录后仍靠键命中（via=key）', () => {
    const prev = { 'node-2': binding({ path: '旧/x.md', title: '甲', sitianId: 'S-7' }) };
    const r = reconcileBindings(prev, [{ sitianId: 'S-7', path: '新/别处/x2.md', title: '甲（改名后）' }]);
    eq(r.lost.length, 0, '有稳定 id 就不该失联');
    eq(r.renamed.length, 1, '路径变了 → 报改名');
    eq(r.renamed[0].via, 'key', '这一档靠 id 键，不靠指纹');
    eq(r.bindings['node-2'].path, '新/别处/x2.md', '绑定跟到新路径');
    eq(r.bindings['node-2'].title, '甲（改名后）', '标题跟着更新（同一篇的编辑，不是另一篇）');
    return 'id 键命中 + 路径变化上报，标题更新不误报';
  });

  // ③c 键精确命中（路径没变）→ 不报改名
  await check('五：路径没变 → 键精确命中，不报改名（只更新标题）', () => {
    const r = reconcileBindings({ 'node-3': binding() }, [entry({ title: '雾隐城（新）' })]);
    eq(r.renamed.length, 0, '路径没变不算改名');
    eq(r.bindings['node-3'].path, OLD_PATH, '路径不变');
    eq(r.bindings['node-3'].title, '雾隐城（新）', '标题跟新');
    return '键命中且路径一致 → 静默更新';
  });

  // ④ 歧义：两篇同名笔记 → 绝不重绑，进 lost 且原因可读
  await check('六：歧义不猜 —— 两篇同名笔记 → 进 lost（带原因），一条都不重绑', () => {
    const r = reconcileBindings({ 'node-4': binding() }, [
      entry({ path: 'A/雾隐城.md' }),
      entry({ path: 'B/雾隐城.md' }),
    ]);
    eq(Object.keys(r.bindings).length, 0, '歧义时不许产出绑定');
    eq(r.renamed.length, 0, '歧义时不许报改名');
    eq(r.lost.length, 1, '必须报失联（不是静默丢）');
    eq(r.lost[0].entityId, 'node-4', '失联归属');
    assert(r.lost[0].noteId === '雾隐城', `lost 要带旧 noteId（便于人说清是哪篇）：${JSON.stringify(r.lost[0])}`);
    assert(/指纹|同名/.test(r.lost[0].why), `原因要说得清（现在是 ${JSON.stringify(r.lost[0].why)}）`);
    return `lost 原因：${r.lost[0].why}`;
  });

  // ④b 绑定侧歧义：两个节点绑着同名笔记，只剩一篇候选 → 也分不清，进 lost
  await check('七：绑定侧歧义 —— 两个节点指纹相同、只剩一条候选 → 也不猜', () => {
    const prev = {
      'node-5': binding({ path: 'A/雾隐城.md' }),
      'node-6': binding({ path: 'B/雾隐城.md' }),
    };
    const r = reconcileBindings(prev, [entry({ path: 'A/雾隐城.md' })]);
    eq(Object.keys(r.bindings).length, 1, '路径还在的那条照常保留');
    eq(r.lost.length, 1, '另一条分不清 → 失联');
    assert(/节点|指纹/.test(r.lost[0].why), `原因要说得清：${JSON.stringify(r.lost[0])}`);
    return '键命中保留 / 指纹歧义失联，互不牵连';
  });

  // ⑤ 候选 → 节点草稿：确定性 + 幂等 + 形状
  await check('八：candidateToNodeDraft 确定性 —— 同一输入两次同 id，同名不同路径不撞 id', () => {
    const cand = entry({ layer: 'city' });
    const a = candidateToNodeDraft(cand, { layer: 'city', parentId: 'planet-1' });
    const b = candidateToNodeDraft(entry({ layer: 'city' }), { layer: 'city', parentId: 'planet-1' });
    eq(a.id, b.id, '同一篇笔记两次导入必须同 id');
    deepEq(a, b, '整份草稿逐字段一致');
    assert(/^vault_/.test(a.id), `id 要是合法节点 id（现在 ${a.id}）`);
    assert(a.id.length < 80, `id 别太长（现在 ${a.id.length} 字）`);
    eq(a.draft, true, 'draft 必须是 true（草稿才不会被当成已确认实体）');
    eq(a.sourcePath, OLD_PATH, 'sourcePath 写笔记路径');
    deepEq(a.tags, [VAULT_IMPORT_TAG], '标签必须是 vault-import');
    eq(a.parentId, 'planet-1', 'parentId 透传');
    eq(a.layer, 'city', 'layer 透传');
    assert(Object.isFrozen(a) && Object.isFrozen(a.tags), '草稿要冻结（防调用方就地改）');
    const other = candidateToNodeDraft(entry({ path: 'B/雾隐城.md' }), {});
    assert(other.id !== a.id, '同名但不同目录是**两个地方** → 不许撞同一个 id');
    eq(candidateToNodeDraft({}, {}), null, '没有身份/名字 → 不给草稿（不猜）');
    // 显式 id 时 id 跟身份走：换了路径也还是同一个 id（不会因为移动就变两个节点）
    const idA = candidateToNodeDraft(entry({ sitianId: 'S-1', path: 'A/x.md' }), {});
    const idB = candidateToNodeDraft(entry({ sitianId: 'S-1', path: 'B/x.md' }), {});
    eq(idA.id, idB.id, '有显式 id 时导出 id 只跟身份走');
    return `id 形如 ${a.id}；同名不同路径不撞；显式 id 时跨路径稳定`;
  });

  // ⑥ 不可变：入参不改、返回冻结新对象
  await check('九：不可变 —— 入参逐字节不变，返回值冻结且是新对象', () => {
    const prev = { 'node-7': binding() };
    const entries = [entry({ path: NEW_PATH })];
    const prevSnap = JSON.stringify(prev);
    const entriesSnap = JSON.stringify(entries);
    const r = reconcileBindings(prev, entries);
    eq(JSON.stringify(prev), prevSnap, '绑定表入参不许改');
    eq(JSON.stringify(entries), entriesSnap, '索引条目入参不许改');
    assert(r.bindings !== prev, '返回的是新对象（不是原表）');
    assert(Object.isFrozen(r.bindings) && Object.isFrozen(r.renamed) && Object.isFrozen(r.lost),
      'bindings / renamed / lost 都要冻结');
    assert(Object.isFrozen(r.bindings['node-7']), '单条绑定也要冻结');
    // 改返回值不许污染入参
    try { r.bindings['node-7'].path = 'x'; } catch (e) { /* 冻结对象在严格模式会抛，两种都算通过 */ }
    eq(prev['node-7'].path, OLD_PATH, '改返回值不许回头改入参');
    // noteRefOf 同样不改入参
    const hit = entry({ aliases: ['雾隐'], sitianId: 'S-3' });
    const hitSnap = JSON.stringify(hit);
    const ref = noteRefOf(hit, 'T1');
    eq(JSON.stringify(hit), hitSnap, 'noteRefOf 不许改入参');
    deepEq(Object.keys(ref).sort(), ['at', 'fingerprint', 'key', 'noteId', 'path', 'title'], 'node.lore 形状');
    eq(ref.at, 'T1', 'at 由调用方传入（模块不读时钟）');
    eq(ref.key, 'id:S-3', '引用里带身份键快照');
    assert(sameNoteRef(ref, hit), 'sameNoteRef 认得出同一篇');
    assert(!sameNoteRef(ref, entry({ title: '别的', path: '别的/地方.md' })), '不同笔记不许判成同一篇');
    return '入参不变；返回值冻结；node.lore 形状 = 6 个字段';
  });

  // ⑦ 索引侧事实：sitianId / aliases 必须出现在条目与搜索结果里（否则指纹对不上）
  await check('十：索引侧 —— 条目带 sitianId，搜索命中带 aliases/sitianId，且 UI 建的绑定能对上账', () => {
    const vault = makeVault();
    const before = snapshot(vault);
    const { index } = vi.buildIndex(vault, { forceFull: true, write: false });
    const files = Object.values(index.files);
    const byName = (n) => files.find((f) => f.name === n);
    eq(byName('带稳定ID').sitianId, 'S-77', 'frontmatter 的 sitian-id 要进条目');
    eq(byName('雾隐城').sitianId, '', '没写就是空串（不生成、不写笔记）');
    deepEq(byName('雾隐城').aliases, ['雾隐'], '别名照旧在条目上');
    eq(bindingKey(byName('带稳定ID')), 'id:S-77', '条目的键走显式 id 档');

    const hits = vi.searchIndex(index, '雾隐城');
    assert(hits.length > 0, '搜索应有命中');
    assert(Array.isArray(hits[0].aliases), `搜索结果必须带 aliases（现在 ${JSON.stringify(hits[0])}）`);
    assert('sitianId' in hits[0], `搜索结果必须带 sitianId（现在 ${JSON.stringify(hits[0])}）`);

    // 🔴 这条是重点：**用搜索命中建的绑定**必须能被索引条目对账（指纹一致）——
    //    命中里少一个 aliases，UI 绑完第一次改名就会被误判失联。
    const ref = noteRefOf(hits[0], 'T2');
    const rec = reconcileBindings({ 'node-8': ref }, files);
    eq(rec.lost.length, 0, `用命中建的绑定不该失联：${JSON.stringify(rec.lost)}`);
    eq(rec.renamed.length, 0, '路径没变，不该报改名');

    eq(snapshot(vault), before, '读料必须只读：库快照逐字节不变');
    assert(!fs.existsSync(path.join(vault, '.sitian')), '只读模式不许在库里建 .sitian');
    fs.rmSync(vault, { recursive: true, force: true });
    return `${files.length} 篇；sitianId/aliases 齐；命中建的绑定零失联；库未改动`;
  });

  // ⑧ 源码门：写口登记 + 函数体有守卫 + 真的被装配
  await check('十一：源码门 —— 两个 store 写口都登记在 MEMORY_WRITE_CALLSITES，且真被装配', () => {
    const gate = readFile(GATE);
    assert(gate.includes('MEMORY_WRITE_CALLSITES'), 'writeGate 缺少内存写入口清单');
    const modRel = path.relative(ROOT, STORE_MOD).replace(/\\/g, '/');
    const blocks = gate.split(/\{\s*id:\s*\d+,/).filter((b) => b.includes(`file: '${modRel}'`));
    assert(blocks.length === 1, `MEMORY_WRITE_CALLSITES 里应**恰好一条**登记 ${modRel}（现在 ${blocks.length} 条）`);
    const fnsRaw = (blocks[0].match(/fns:\s*\[([^\]]*)\]/) || [])[1] || '';
    const fns = fnsRaw.match(/'([^']+)'/g) || [];
    const registered = fns.map((s) => s.replace(/'/g, ''));
    for (const fn of ['bindNodeToNote', 'unbindNodeNote', 'importVaultCandidate']) {
      assert(registered.includes(fn), `MEMORY_WRITE_CALLSITES 没登记 ${fn}()`);
    }

    const src = readFile(STORE_MOD);
    const chunks = src.split(/\n  function /).map((c, i) => (i === 0 ? c : 'function ' + c));
    for (const fn of ['bindNodeToNote', 'unbindNodeNote', 'importVaultCandidate']) {
      const body = chunks.find((c) => c.startsWith(`function ${fn}(`));
      assert(!!body, `store 模块里找不到 ${fn}()`);
      assert(body.includes('guardWrite('), `${fn}() 函数体里没有 guardWrite（只读态会改内存但永不落盘）`);
      // 一次操作 = 一条撤销：写要么进自己的 execute，要么走既有的 addNode（它内部就是 execute）
      assert(body.includes('execute(') || body.includes('addNode('),
        `${fn}() 既没走 execute 也没走 addNode（没有 undo，一条操作就不是一条撤销）`);
    }
    // 「一次操作 = 一条撤销」：导入的写入点必须是既有的 addNode，不许自带第二个建节点逻辑
    const importBody = chunks.find((c) => c.startsWith('function importVaultCandidate('));
    assert(importBody.includes('addNode('), 'importVaultCandidate 必须复用既有的 addNode（不写第二个建节点函数）');
    for (const banned of ['nodes.value.push(', 'nodes.value =']) {
      assert(!importBody.includes(banned), `importVaultCandidate 里出现 ${banned}（绕过 addNode = 第二份建节点实现）`);
    }

    // 装配：模块被 geodata.js import + 创建 + 展开进 store 返回值
    const geodata = readFile(GEODATA);
    assert(geodata.includes("from './geodataModules/loreBinding'"), 'geodata.js 没 import loreBinding 模块');
    assert(/createLoreBindingModule\(\{/.test(geodata), 'geodata.js 没创建 loreBinding 模块');
    assert(geodata.includes('...loreBindingModule'), 'geodata.js 没把 loreBinding 展开进返回值（UI 调不到）');

    // UI：两个 testid 必须在**唯一**的资料组件里（绑定 / 导入），且必须真有一个使用点传了 nodeId
    const ui = readFile(LORE_UI);
    for (const tid of ["'-bind'", "'-import'", "'-unbind'", "'-bound'"]) {
      assert(ui.includes(`testid + ${tid}`), `VaultLoreSection 缺少 testid 后缀 ${tid}`);
    }
    assert(/nodeId:\s*\{\s*type:\s*String/.test(ui), 'VaultLoreSection 没有 nodeId prop（写口无处触发）');
    const consumers = ['src/renderer/src/components/NodeDetailPanel.vue']
      .filter((rel) => readRel(rel).includes(':node-id='));
    assert(consumers.length > 0, '没有使用点把 node-id 传给资料段（绑定/导入在 UI 上点不到 = 死代码）');
    return `${modRel} 登记 3 个函数；三处 guardWrite + execute；导入复用 addNode；UI 4 个 testid 齐`;
  });

  // ⑨ 追加：noteId 的语义（"这篇笔记会用的实体 id"），与绑定键分开
  await check('十二：noteId ≠ bindingKey —— 前者随改名变（展示用），后者才是身份', () => {
    eq(noteIdOf(entry()), '雾隐城', 'noteId = normalizeId(文件名)（与提取器同口径）');
    eq(noteIdOf(entry({ path: NEW_PATH })), '雾隐城', '同名的桩保持同 noteId');
    assert(noteIdOf(entry({ path: 'A/雾隐城.md' })) === noteIdOf(entry({ path: 'B/雾隐城.md' })),
      '同名不同目录 noteId 相同（这正是提取器撞 id 的老问题 —— 所以绑定键用完整路径）');
    assert(bindingKey(entry({ path: 'A/雾隐城.md' })) !== bindingKey(entry({ path: 'B/雾隐城.md' })),
      '绑定键必须区分同名不同目录');
    eq(noteIdOf(entry({ sitianId: 'S-9' })), 'S-9', '有显式 id 时 noteId 直接用 id');
    return 'noteId 同提取器口径；bindingKey 用完整路径区分同名条目';
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('用例自身崩溃：', (e && e.stack) || e); process.exit(1); });
