#!/usr/bin/env node
/**
 * Node 单元测试：**保存链分块化**（2026-11-05，卡「撤销连按被保存链拖住：主线程占满 1~3 秒」）
 *
 * 为什么要有这层：真机 CPU 样本里连按撤销的 3 秒窗口一帧都不出，归因到保存链上的四段同步工作
 * （exportCanvas / snapshotState 55ms / pushSnapshot 92ms / toIpcJson 88ms）首尾相接。
 * 修法是把它们切成小块、块间让出事件循环 —— 但"切块"绝不能改变落盘内容。
 *
 * 所以本用例守的是**行为等价**（不是"跑得快"）：
 *   a) `toIpcJsonChunked` 与 `toIpcJson` **逐字节相同**（混合夹具 + 8MB 级大结构）
 *      —— 负向探针：改一个值必须不等（证明比对不是恒等）
 *   b) 分块真的分了：yield 次数够多、单块字节远小于整体
 *   c) `snapshotStateChunked` 与 `snapshotState` 深等
 *   d) `pushSnapshotWithState` 与 `pushSnapshot` 逐份相同（三次顺序改动 + 一次空改动）
 *   e) 状态缓存**不许出错**：把快照数组换成一份"被改过的"（回滚/外部修改的形状）后，
 *      重放结果必须仍然正确（负向探针：缓存命中错会产出缺字段的补丁）
 *   f) 入参不被改（`pushSnapshot` 不得就地改 `project.snapshots`）
 *
 * 用法：node scripts/tests/unit/test_save_chain_chunked.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const fsp = fs.promises;
const os = require('os');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
let TMP = '';
const results = [];

function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function importSchema(sub = 'schema') {
  const deps = ['projectSchema.js', 'normalizeId.js'];
  const dir = path.join(TMP, sub);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');
  for (const f of deps) {
    // `normalizeId` 的 import 没写扩展名（Vite 能解，Node 不能）—— 副本里补上
    const body = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'utils', f), 'utf8')
      .replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
    await fsp.writeFile(path.join(dir, f), body, 'utf-8');
  }
  return import(pathToFileURL(path.join(dir, 'projectSchema.js')).href);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || '' });
    console.log(`  ✅ ${name}${detail ? ` —— ${detail}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
    console.log(`  ❌ ${name} —— ${(err && err.message) || err}`);
  }
}

/** 夹具：把 JSON.stringify 的边角都踩一遍（转义 / undefined 键 / TypedArray / 数字边界 / 嵌套） */
function makeFixture(S) {
  return {
    version: '1.0.0',
    meta: { name: '示例 世界 "带引号"', note: '换行\n与\t制表符 \\ 反斜杠', empty: '', n: -0, big: 1e21, tiny: 1e-7, nonFinite: Infinity },
    entities: {
      a: { id: 'a', name: '啊', tags: ['x', 'y'], createdAt: '2026-01-01T00:00:00.000Z' },
      b: { id: 'b', name: '吧', undef: undefined, nested: { k: [1, 2, { z: null }] } },
    },
    hyperlanes: [{ id: 'h1', from: 'a', to: 'b', w: 1.23456 }],
    scenarios: {
      version: 2,
      baseMaps: {
        desite: {
          key: 'desite',
          terrain: [{ id: 'p1', points: [1.0004, 2.0006, 3.1] }, { id: 'p2', points: [] }],
          heightmap: new Float32Array([0.5, 0.25, 1 / 3]),
          rivers: [{ id: 'r1', path: [0, 1, 2] }],
          referenceImages: [{ id: 'i1', src: 'x.png' }],
        },
        other: { key: 'other', terrain: [] },
      },
      scenarios: { s1: { id: 's1', name: '第一代', ownership: { p1: '甲', p2: null } } },
      slicePoints: [{ at: 1350 }],
      groups: [{ id: 'g1', name: '主线' }],
    },
    maps: {
      mapData: {
        m1: { terrain: { grid: new Float32Array([1, 2, 3]) }, markers: [], textLabels: [{ t: '标注' }] },
      },
      editor: { domainBorderOverrides: {}, areaZones: { z1: { points: [0, 0, 1, 1] } } },
    },
    snapshots: [
      { at: 't0', label: '', base: { meta: { name: 'a' } }, patch: { set: [], del: [] }, changes: 0 },
      { at: 't1', label: '改', patch: { set: [{ path: ['meta', 'name'], value: 'b' }], del: [] }, changes: 1 },
    ],
  };
}

/** 造一份"8MB 级"的合成项目（结构同真实项目：scenarios.baseMaps 最大，另有 maps / snapshots） */
function makeBigProject() {
  const provinces = [];
  for (let i = 0; i < 415; i += 1) {
    provinces.push({ id: `p${i}`, name: `省${i}`, points: Array.from({ length: 60 }, (_, k) => ((i + k) % 97) / 7) });
  }
  const mapData = {};
  for (let m = 0; m < 6; m += 1) {
    mapData[`m${m}`] = { markers: provinces.slice(0, 40).map((p) => ({ id: p.id, x: 1, y: 2 })), textLabels: [{ t: `标注${m}` }] };
  }
  const snapshots = [{ at: 't0', label: '', base: { meta: { name: '大项目' } }, patch: { set: [], del: [] }, changes: 0 }];
  for (let i = 1; i < 12; i += 1) {
    snapshots.push({ at: `t${i}`, label: '改', patch: { set: [{ path: ['meta', 'name'], value: `n${i}` }], del: [] }, changes: 1 });
  }
  return {
    version: '1.0.0',
    meta: { name: '大项目' },
    entities: Object.fromEntries(provinces.slice(0, 120).map((p) => [p.id, { id: p.id, name: p.name }])),
    hyperlanes: [],
    scenarios: {
      version: 2,
      baseMaps: {
        desite: { key: 'desite', terrain: provinces, rivers: Array.from({ length: 300 }, (_, i) => ({ id: `r${i}`, path: [i, i + 1] })) },
        north: { key: 'north', terrain: provinces.slice(0, 100) },
      },
      scenarios: { s1: { id: 's1', ownership: Object.fromEntries(provinces.map((p) => [p.id, '甲'])) } },
      slicePoints: [],
      groups: [],
    },
    maps: { mapData, editor: {} },
    snapshots,
  };
}

async function main() {
  TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'sitian-chunked-'));
  const S = await importSchema();

  await check('a1 分块序列化与整串**逐字节相同**（混合夹具：转义/undefined/TypedArray/数字边界）', async () => {
    const fx = makeFixture(S);
    const want = S.toIpcJson(fx);
    const got = await S.toIpcJsonChunked(fx);
    assert(want === got, `文本不同：want ${want.length} 字节 / got ${got.length} 字节`);
    return `${want.length} 字节，完全一致`;
  });

  await check('a2 大结构（415 省 / 8MB 级）同样逐字节相同', async () => {
    const big = makeBigProject();
    const want = S.toIpcJson(big);
    const got = await S.toIpcJsonChunked(big);
    assert(want === got, `文本不同：want ${want.length} / got ${got.length}`);
    assert(want.length > 200000, `夹具不够大（${want.length} 字节），这条判据就白测了`);
    return `${(want.length / 1024).toFixed(0)} KB，完全一致`;
  });

  await check('a3 负向探针：改一个值之后文本必须**不同**（比对不是恒等）', async () => {
    const fx = makeFixture(S);
    const a = await S.toIpcJsonChunked(fx);
    const fx2 = makeFixture(S);
    fx2.scenarios.baseMaps.desite.terrain[0].points[0] += 1;
    const b = await S.toIpcJsonChunked(fx2);
    assert(a !== b, '改了数据文本却没变 —— 判据是恒等，等于没测');
    return '一改就变';
  });

  await check('a4 根值不是对象 / 是 null 时与 toIpcJson 同形', async () => {
    for (const v of [null, undefined, 'abc', 42, [1, 2, 3], new Float32Array([1.0004, 2])]) {
      const want = S.toIpcJson(v);
      const got = await S.toIpcJsonChunked(v);
      assert(want === got, `值 ${String(v)} 上不同：want ${want} / got ${got}`);
    }
    return '6 种根形态一致';
  });

  await check('b 分块真的分了：yield ≥ 8 次，且**单块耗时** ≤ 60ms（真机闸门是 200ms）', async () => {
    const big = makeBigProject();
    let yields = 0;
    let maxPiece = 0;
    let maxPieceMs = 0;
    let pieceStart = Date.now();
    let curBytes = 0;
    const total = await S.toIpcJsonChunked(big, {
      yieldFn: () => {
        yields += 1;
        const ms = Date.now() - pieceStart;
        if (ms > maxPieceMs) { maxPieceMs = ms; maxPiece = curBytes; }
        curBytes = 0;
        pieceStart = Date.now();
      },
      onPiece: (p, text) => { curBytes += text ? text.length : 0; },
    });
    assert(yields >= 8, `只让出了 ${yields} 次 —— 等于没切块`);
    assert(maxPieceMs <= 60, `单块最长 ${maxPieceMs}ms（${maxPiece} 字节）—— 分块没起到作用`);
    return `${yields} 次让出，单块最长 ${maxPieceMs}ms（${(maxPiece / 1024).toFixed(0)} KB）/ 共 ${(total.length / 1024).toFixed(0)} KB`;
  });

  await check('c snapshotStateChunked 与 snapshotState 深等', async () => {
    const fx = makeFixture(S);
    const want = S.snapshotState(fx);
    const got = await S.snapshotStateChunked(fx);
    assert(S.deepEqual(want, got), '两者结果不一致');
    // 重字段（heightmap/terrainGrid/referenceImages）必须仍然被剔除
    assert(got.scenarios.baseMaps.desite.heightmap === undefined, 'heightmap 没被剔除 —— 快照体积会爆');
    assert(got.scenarios.baseMaps.desite.referenceImages === undefined, 'referenceImages 没被剔除');
    return '一致，且重字段仍剔除';
  });

  await check('d pushSnapshotWithState 与 pushSnapshot 逐份相同（三次顺序改动 + 一次空改动）', async () => {
    // ⚠️ 每个项目必须是**独立深拷贝**：浅拷贝会让夹具里的 meta/terrain 被就地改，
    //    两个序列最后状态悄悄不一致（第一版就是这么红的）。
    const mk = () => S.deepClone({ ...makeFixture(S), snapshots: [] });
    let a = mk();
    let b = mk();
    const edits = [
      (p) => { p.meta.name = '改一'; },
      (p) => { p.scenarios.baseMaps.desite.terrain[0].points[1] = 9.5; },
      (p) => { p.entities.c = { id: 'c', name: '新实体' }; },
      () => { /* 空改动 */ },
    ];
    const strip = (snaps) => snaps.map((s) => ({ ...s, at: '' }));   // `at` 是各次调用的时间戳，不比
    for (const edit of edits) {
      edit(a); edit(b);
      a = S.pushSnapshot(a, { label: '测试' });
      const st = await S.snapshotStateChunked(b);
      b = S.pushSnapshotWithState(b, st, { label: '测试' });
      assert(S.deepEqual(strip(a.snapshots), strip(b.snapshots)),
        `快照链不一致（长度 ${a.snapshots.length} vs ${b.snapshots.length}）`);
    }
    // 空改动：两条路都必须返回**原对象**（不留空快照）
    assert(S.pushSnapshot(a, {}) === a, '空改动却留了快照（pushSnapshot）');
    const st3 = await S.snapshotStateChunked(b);
    assert(S.pushSnapshotWithState(b, st3, {}) === b, '空改动却留了快照（pushSnapshotWithState）');
    return `${a.snapshots.length} 份逐份一致，空改动不留快照`;
  });

  await check('e 负向探针：快照数组被换过（回滚/外部修改的形状）后，缓存不许命中', async () => {
    const p = { ...makeFixture(S), snapshots: [] };
    const p1 = { ...p }; p1.meta.name = 'v1';
    const s1 = S.pushSnapshot(p1, { label: 'v1' });
    const p2 = { ...s1 }; p2.meta.name = 'v2';
    const s2 = S.pushSnapshot(p2, { label: 'v2' });
    assert(s2.snapshots.length === 2, `应有两份快照，实际 ${s2.snapshots.length}`);

    // 篡改：换一份"最后一格被改过"的副本（模拟回滚后内存里快照与缓存对不上）
    const tampered = s2.snapshots.map((s, i) => (i === s2.snapshots.length - 1
      ? { ...s, patch: { set: [{ path: ['meta', 'name'], value: '被外面改过' }], del: [] } }
      : s));
    const p3 = { ...s2, snapshots: tampered };
    p3.meta.name = 'v3';
    const s3 = S.pushSnapshot(p3, { label: 'v3' });
    assert(s3.snapshots.length === 3, `应追加成三份，实际 ${s3.snapshots.length}`);
    // 新补丁必须只记 v2→v3 的差（如果错用了缓存里的旧状态，这里会多/少字段）
    const patch = s3.snapshots[2].patch;
    const sets = patch.set.map((x) => x.path.join('.'));
    assert(sets.includes('meta.name'), `补丁里没有 meta.name（实际 ${JSON.stringify(sets)}）—— 说明重放没按篡改后的链走`);
    // 硬核对：从第 0 份 base 起逐份 applyPatch，重放出来必须等于 p3 的当前状态
    let replayed = S.deepClone(s3.snapshots[0].base || {});
    for (let i = 1; i < s3.snapshots.length; i += 1) replayed = S.applyPatch(replayed, s3.snapshots[i].patch);
    const live = S.snapshotState(p3);
    assert(S.deepEqual(replayed, live), '逐份回放结果与当前状态不一致 —— 补丁链坏了（缓存命中错了）');
    return '篡改后仍按真链算补丁，回放核对通过';
  });

  await check('f 入参不被改：pushSnapshot 不就地改 project.snapshots', async () => {
    const p = makeFixture(S);
    const beforeLen = p.snapshots.length;
    const beforeFirst = JSON.stringify(p.snapshots[0]);
    const beforeEntry = p.snapshots[p.snapshots.length - 1];
    const next = { ...p, meta: { name: '新名字' } };
    const out = S.pushSnapshot(next, { label: 'x' });
    assert(p.snapshots.length === beforeLen, '入参 snapshots 长度被改了');
    assert(JSON.stringify(p.snapshots[0]) === beforeFirst, '入参快照内容被改了');
    assert(out.snapshots.length === beforeLen + 1, '返回的新项目里没追加快照');
    assert(out.snapshots[beforeLen - 1] === beforeEntry, '旧条目被克隆了（字节缓存会永远 miss）');
    return '不动入参，旧条目引用保留';
  });

  await check('g 消息通道不投递时，"让出一拍"也必须醒过来（8ms 兜底；连续 3 次后退 setTimeout）', async () => {
    // 🔴 这条守的是**真机上刚踩过的坑**：第一版用 `addEventListener('message')` 在这台 Electron 的
    //    渲染进程里根本收不到消息 → `saveProject()` 永不 resolve、一个字节都没落盘、还没有报错。
    //    这里塞一条"永远不投递"的假通道，断言：① 每拍都能在 100ms 内返回；
    //    ② 走兜底 3 次之后永久改走 setTimeout（不再白等 8ms/拍）。
    const saved = globalThis.MessageChannel;
    class FakePort {
      constructor() { this.onmessage = null; }
      start() {}
      postMessage() {}
      close() {}
    }
    globalThis.MessageChannel = class FakeMessageChannel {
      constructor() { this.port1 = new FakePort(); this.port2 = new FakePort(); }
    };
    try {
      const S2 = await importSchema('schema-fake-mc');
      const t0 = Date.now();
      for (let i = 0; i < 6; i += 1) {
        const a = Date.now();
        await Promise.race([
          S2.yieldToEventLoop(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('让出一拍卡住了（>200ms 不返回）')), 200)),
        ]);
        const ms = Date.now() - a;
        assert(ms < 200, `第 ${i + 1} 拍不返回（${ms}ms）—— 保存链会被挂死`);
      }
      const total = Date.now() - t0;
      assert(total < 400, `6 拍用了 ${total}ms —— 兜底没切到 setTimeout（每拍都在白等 8ms）`);
      return `6 拍共 ${total}ms，兜底后自动退路`;
    } finally {
      globalThis.MessageChannel = saved;
    }
  });

  await check('h 正常通道下"让出一拍"很快（<5ms/拍，且不会走兜底）', async () => {
    const S3 = await importSchema('schema-real-mc');
    const t0 = Date.now();
    for (let i = 0; i < 20; i += 1) await S3.yieldToEventLoop();
    const per = (Date.now() - t0) / 20;
    assert(per < 5, `每拍 ${per.toFixed(2)}ms —— 说明落到了 setTimeout 兜底（4ms 夹取）`);
    return `20 拍平均 ${per.toFixed(2)}ms`;
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
  if (failed.length) {
    for (const f of failed) console.log(`  ❌ ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
