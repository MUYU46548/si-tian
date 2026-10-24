#!/usr/bin/env node
/**
 * Node 单元测试：**序列化边界**上「去 Vue 代理」与「TypedArray 兜底」的判定
 * （src/renderer/src/utils/projectSchema.js 的 `toIpcPlain` / `deepClone` / `snapshotBytes`）。
 *
 * 背景（1-b，2026-10-24）：画布载荷不再在 `buildProjectPayload` 里深拷贝，深拷贝挪到落盘唯一出口。
 * 于是这三个函数成了**唯一**保证「无代理跨 IPC / TypedArray 变数组」的地方 —— 它们静默退化的后果
 * 都是数据事故级：
 *   · 代理跨进程 → V8 抛 "An object could not be cloned." → **每次保存都失败**（2026-10-06 T2）；
 *   · TypedArray 不过 replacer → 主进程 `JSON.stringify` 写出 `{"0":..}`（丢 length）→ 读回是空数组；
 *   · `deepClone` 走 structuredClone 时被代理抛错 → 每次都退 JSON 降级（慢 4 倍，且丢 TypedArray 类型）。
 *
 * ⚠️ 本文件用「形如代理的普通对象」模拟 Vue 代理（`__v_raw` 指回原始对象）：
 *    不去 import vue —— 这一层判定的是**读取 `__v_raw` 的契约**，与框架版本无关。
 *    「真代理」那一半由 CDP 用例（test_85 的 IPC 边界 / test_55 的落盘）守。
 *
 * 用法：node scripts/tests/unit/test_project_plain.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const fsp = fs.promises;
const os = require('os');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');

const results = [];
let TMP = '';

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: 期望 ${b}，实际 ${a}`);
}

/** 把 ESM 源文件复制到临时目录并按需补 `.js` 后缀，再 import（同 test_project_size.js） */
async function importSchema() {
  const deps = ['projectSchema.js', 'normalizeId.js'];
  const dir = path.join(TMP, 'schema');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');
  for (const f of deps) {
    const body = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'utils', f), 'utf8')
      .replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
    await fsp.writeFile(path.join(dir, f), body, 'utf-8');
  }
  return import(pathToFileURL(path.join(dir, 'projectSchema.js')).href);
}

/** 模拟 Vue 的 reactive 代理：一个带 `__v_raw` 的外壳（读属性会走壳，取值得到原始的同一份） */
function fakeReactive(raw) {
  return new Proxy(raw, {
    get(target, key) {
      if (key === '__v_raw') return target;
      return target[key];
    },
  });
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || '' });
    console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
    console.log(`  ❌ ${name} — ${(err && err.message) || err}`);
  }
}

async function main() {
  TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'sitian-plain-'));
  const S = await importSchema();

  console.log('=== 序列化边界（去代理 / TypedArray）单元测试 ===');

  await check('a1 代理：toIpcPlain 取原始对象（值一致、不带 __v_raw）', () => {
    const raw = { version: '1.0.0', meta: { name: '甲' }, entities: { a: { id: 'a' } } };
    const plain = S.toIpcPlain(fakeReactive(raw));
    eq(plain, raw, '转出来的值');
    assert(!('__v_raw' in plain), 'toIpcPlain 的产物里不该有 __v_raw（那是代理的实现细节）');
    assert(plain !== raw, 'toIpcPlain 必须返回副本（不能把内存里的对象直接交给 IPC）');
  });

  await check('a2 代理：deepClone 不再抛错，且副本与原对象互不影响', () => {
    const raw = { scenarios: { baseMaps: { b: { terrain: [{ id: 'p', points: [{ x: 1, y: 2 }] }] } } } };
    const copy = S.deepClone(fakeReactive(raw));
    eq(copy, raw, '深拷贝内容');
    assert(copy !== raw && copy.scenarios !== raw.scenarios, '必须是深拷贝（换对象引用）');
    copy.scenarios.baseMaps.b.terrain[0].points[0].x = 999;
    eq(raw.scenarios.baseMaps.b.terrain[0].points[0].x, 1, '改副本不该影响原对象');
  });

  await check('a3 TypedArray：toIpcPlain 转成普通数组、保留 3 位小数', () => {
    const p = S.toIpcPlain({ h: new Float32Array([1.23456, 2, -0.0004]) });
    eq(Array.from(p.h), [1.235, 2, -0], 'Float32Array → 数组（3 位小数）');
    assert(Array.isArray(p.h), '必须是数组（对象 {0:..} 会让读回退化成无 length 的字典）');
    assert(!ArrayBuffer.isView(p.h), '过完边界不该还是视图');
  });

  await check('a4 TypedArray：deepClone 保住原生类型（结构化克隆优先）', () => {
    const src = { grid: new Uint8Array([1, 2, 3]) };
    const copy = S.deepClone(src);
    assert(ArrayBuffer.isView(copy.grid), 'structuredClone 分支应保住 TypedArray');
    eq(Array.from(copy.grid), [1, 2, 3], '内容一致');
  });

  await check('a5 嵌套代理：structuredClone 抛错时必须退 JSON（不能把异常冒出去）', () => {
    // 原始对象里**嵌着一个代理**（现实里会出现：`obj.x = 另一个 reactive`）→ structuredClone 必抛
    const inner = fakeReactive({ a: 1 });
    const copy = S.deepClone({ outer: inner });
    eq(copy, { outer: { a: 1 } }, '降级后内容仍然对');
  });

  await check('a6 snapshotBytes 口径与落盘一致（TypedArray 不该按 {"0":..} 数）', () => {
    const snaps = [{ at: 't', patch: { set: [{ path: ['x'], value: new Float32Array(64) }], del: [] } }];
    const withReplacer = JSON.stringify(snaps, S.jsonSafeReplacer).length;
    const naive = JSON.stringify(snaps).length;
    const got = S.snapshotBytes(snaps);
    eq(got, withReplacer, 'snapshotBytes 必须与 jsonSafeReplacer 同口径');
    assert(got < naive, `带 replacer 的字节数应小于裸 stringify（实际 ${got} vs ${naive}）`);
  });

  await check('a7 空值契约：toIpcPlain(undefined/null) 都是 {}（旧行为不变）', () => {
    eq(S.toIpcPlain(undefined), {}, 'undefined');
    eq(S.toIpcPlain(null), {}, 'null');
    eq(S.deepClone(undefined), undefined, 'deepClone(undefined) 仍是 undefined');
  });

  await check('a8 反向探针：把 replacer 从 toIpcPlain 里去掉 → a3/a6 必须变红', async () => {
    const dir = path.join(TMP, 'broken');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');
    for (const f of ['projectSchema.js', 'normalizeId.js']) {
      let body = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'utils', f), 'utf8')
        .replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
      if (f === 'projectSchema.js') {
        body = body
          .replace('JSON.stringify(unwrapRaw(value), jsonSafeReplacer)', 'JSON.stringify(unwrapRaw(value))')
          .replace('JSON.stringify(Array.isArray(snapshots) ? snapshots : [], jsonSafeReplacer)',
            'JSON.stringify(Array.isArray(snapshots) ? snapshots : [])');
      }
      await fsp.writeFile(path.join(dir, f), body, 'utf-8');
    }
    const B = await import(pathToFileURL(path.join(dir, 'projectSchema.js')).href);
    const broken = B.toIpcPlain({ h: new Float32Array([1.23456, 2]) });
    assert(!Array.isArray(broken.h), '去掉 replacer 后 TypedArray 仍被当成数组 —— 反向探针失效（a3 是空转）');
    const snaps = [{ at: 't', patch: { set: [{ path: ['x'], value: new Float32Array(64) }], del: [] } }];
    assert(B.snapshotBytes(snaps) === JSON.stringify(snaps).length,
      '去掉 replacer 后 snapshotBytes 应与裸 stringify 同长 —— 否则 a6 抓不住');
    return '去掉 replacer：TypedArray 变 {"0":..}（a3 会红）、snapshotBytes 口径漂移（a6 会红）';
  });

  await check('a9 源码守卫：toIpcPlain / deepClone 仍然经过 unwrapRaw', () => {
    // ⚠️ 为什么这条只能查源码、不能靠行为对拍：Vue 代理被 `JSON.stringify` **读穿**，
    //    `toIpcPlain` / `deepClone` 的**返回值**去掉 unwrapRaw 后仍然一样（差别只在耗时 4 倍与
    //    structuredClone 分支走不走）。所以"有人图省事删掉它"是行为测不出来的静默退化，只能读源码。
    const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'projectSchema.js'), 'utf8');
    const hits = (src.match(/unwrapRaw\(/g) || []).length;
    assert(src.indexOf('JSON.stringify(unwrapRaw(value), jsonSafeReplacer)') >= 0,
      'toIpcPlain 没经过 unwrapRaw（3.6MB 正文会从 60ms 退回 237ms）');
    assert(src.indexOf('const plain = unwrapRaw(value);') >= 0,
      'deepClone 没经过 unwrapRaw（structuredClone 会因代理抛错 → 每次都退 JSON 降级）');
    assert(hits >= 3, `unwrapRaw 调用点只有 ${hits} 处（期望 ≥3：定义 + toIpcPlain + deepClone）`);
    return `${hits} 处调用`;
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
  if (failed.length) {
    for (const f of failed) console.log(`  ❌ ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
