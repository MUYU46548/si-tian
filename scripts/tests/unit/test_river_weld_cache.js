#!/usr/bin/env node
/**
 * Node 单元测试：汇流焊接结果的单版缓存（src/renderer/src/utils/riverWeldCache.js）
 *
 * 为什么要有这一层（卡「汇流焊接仍是逐帧重算」）：
 *   `interaction/rivers.js#strokeRiverNetworkAsPaths` 里的细分 + `snapRiverTails` + `weldRiverJunctions`
 *   以前是**每帧**都跑的，而河网几何与相机无关。自建地形推演出 2457 条河 / 18,644 段（细分后 11 万段）
 *   时，这一遍单帧就要跑几十秒 —— 预算线只保证“不卡死”，保证不了“够快”。
 *
 * 本用例守三件事（都不需要浏览器）：
 *   ① 命中条件必须是**身份**（数组引用 + subdiv），且曲线条数必须对得上；
 *   ② 只缓存一份 —— 换一版河网，旧的那版立刻失效（否则会拿旧曲线画新河，错位比慢更糟）；
 *   ③ `interaction/rivers.js` **真的接上了**它，而且缓存读在焊接之前、写在焊接之后
 *      （防止“写了缓存但没人读”这种假绿）。
 *
 * 用法：node scripts/tests/unit/test_river_weld_cache.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 *
 * ⚠️ 被测模块是 ESM（Vite 源码），本文件是 CJS → data: URL 动态 import（同其它 unit 用例）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'riverWeldCache.js');
const RIVERS = path.join(ROOT, 'src', 'renderer', 'src', 'scenario', 'interaction', 'rivers.js');

const results = [];
async function check(name, fn) {
  try {
    results.push({ name, ok: true, detail: (await fn()) || '' });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/** 造一份“像河网”的曲线：每条 3 点 */
function curves(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push([{ x: i, y: 0 }, { x: i + 0.5, y: 0.2 }, { x: i + 1, y: 0 }]);
  return out;
}

async function main() {
  const src = fs.readFileSync(SRC, 'utf8');
  const mod = await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
  const { createWeldCache, readWeldCache, writeWeldCache, weldCacheStats } = mod;

  // ── 1. 命中条件 ────────────────────────────────────────────────────────────
  await check('a1 同一份 paths + 同 subdiv + 同条数 → 命中，返回同一批 curve（引用相等）', () => {
    const cache = createWeldCache();
    const paths = [{ id: 1 }, { id: 2 }];
    const cs = curves(2);
    writeWeldCache(cache, { paths, subdiv: 6, curves: cs, segs: 12, welded: true, skipped: false });
    const hit = readWeldCache(cache, { paths, subdiv: 6, count: 2 });
    assert(hit, '同键必须命中');
    assert(hit.curves === cs, '必须直接给回同一批数组（重新拷贝 11 万点等于没缓存）');
    eq(hit.segs, 12, '上次的段数要带回来（排障口要如实）');
    eq(hit.welded, true, '上次焊过没有要带回来');
    eq(hit.skipped, false, '上次跳没跳过要带回来');
    return '命中原样返回';
  });

  await check('a2 换一份 paths（引用不同）→ 失效', () => {
    const cache = createWeldCache();
    writeWeldCache(cache, { paths: [{}, {}], subdiv: 6, curves: curves(2), segs: 4, welded: true, skipped: false });
    const hit = readWeldCache(cache, { paths: [{}, {}], subdiv: 6, count: 2 });
    eq(hit, null, '内容“看起来一样”但引用不同必须失效（deep compare 比焊接还贵，且河网变了就是变了）');
    return '引用换 → miss';
  });

  await check('a3 subdiv 变 / 条数对不上 → 失效（同一份 paths 被就地改过也要发现）', () => {
    const cache = createWeldCache();
    const paths = [{}, {}];
    writeWeldCache(cache, { paths, subdiv: 6, curves: curves(2), segs: 4, welded: true, skipped: false });
    eq(readWeldCache(cache, { paths, subdiv: 4, count: 2 }), null, 'subdiv 变了必须失效（曲线是细分出来的）');
    eq(readWeldCache(cache, { paths, subdiv: 6, count: 3 }), null, '本次曲线条数对不上必须失效（paths 被就地 push 过）');
    return 'subdiv / 条数都对得上才算命中';
  });

  await check('a4 空缓存 / 坏入参不抛', () => {
    const cache = createWeldCache();
    eq(readWeldCache(cache, { paths: [], subdiv: 6, count: 0 }), null, '空缓存必须 miss');
    eq(readWeldCache(null, { paths: [], subdiv: 6, count: 0 }), null, 'cache 为 null 不抛');
    readWeldCache(cache, null);
    writeWeldCache(cache, null);
    writeWeldCache(null, { paths: [], subdiv: 6, curves: [] });
    return '4 种畸形入参都安全';
  });

  // ── 2. 只留一份 ────────────────────────────────────────────────────────────
  await check('b1 换一版河网后，旧版立刻失效（缓存只留最近一份）', () => {
    const cache = createWeldCache();
    const p1 = [{ id: 1 }];
    const p2 = [{ id: 1 }];
    writeWeldCache(cache, { paths: p1, subdiv: 6, curves: curves(1), segs: 2, welded: true, skipped: false });
    assert(readWeldCache(cache, { paths: p1, subdiv: 6, count: 1 }), '第一版先命中');
    writeWeldCache(cache, { paths: p2, subdiv: 6, curves: curves(1), segs: 2, welded: true, skipped: false });
    eq(readWeldCache(cache, { paths: p1, subdiv: 6, count: 1 }), null, '写第二版后第一版必须失效（内存只留一份）');
    assert(readWeldCache(cache, { paths: p2, subdiv: 6, count: 1 }), '第二版要命中');
    return '只留最近一份';
  });

  await check('b2 统计口径：3 次同一键 = 1 miss + 2 hits', () => {
    const cache = createWeldCache();
    const paths = [{}];
    const read = () => readWeldCache(cache, { paths, subdiv: 6, count: 1 });
    eq(read(), null, '第一次必然 miss');
    writeWeldCache(cache, { paths, subdiv: 6, curves: curves(1), segs: 2, welded: true, skipped: false });
    assert(read(), '第二次命中');
    assert(read(), '第三次命中');
    const st = weldCacheStats(cache);
    eq(st.hits, 2, 'hits');
    eq(st.misses, 1, 'misses');
    eq(st.cached, true, 'cached 标记');
    eq(st.paths, 1, '记住的是几条河');
    eq(st.subdiv, 6, '记住的 subdiv');
    return `hits ${st.hits} / misses ${st.misses}`;
  });

  // ── 3. 接线守卫（不许“写了缓存但没人读”）────────────────────────────────
  await check('c1 interaction/rivers.js 真的读了缓存，且读在焊接之前', () => {
    const body = fs.readFileSync(RIVERS, 'utf8');
    const readAt = body.indexOf('readWeldCache(_weldCache');
    const weldAt = body.indexOf('weldRiverJunctions(wrappers');
    assert(readAt > 0, '没在 strokeRiverNetworkAsPaths 里读到 readWeldCache —— 缓存成了死代码');
    assert(weldAt > 0, '没找到焊接调用（函数搬家了就更新本用例）');
    assert(readAt < weldAt, '缓存读必须发生在焊接**之前**（写在后面等于每帧照旧重算）');
    assert(body.indexOf('writeWeldCache(_weldCache') > weldAt, '缓存写必须发生在焊接**之后**（写早了会把没焊的曲线当结果）');
    return `read@${readAt} < weld@${weldAt} < write@${body.indexOf('writeWeldCache(_weldCache')}`;
  });

  await check('c2 命中分支里不许再出现细分/焊接（否则“缓存”只是多读了一次）', () => {
    const body = fs.readFileSync(RIVERS, 'utf8');
    const hitAt = body.indexOf('if (hit) {');
    const elseAt = body.indexOf('} else {', hitAt);
    assert(hitAt > 0 && elseAt > hitAt, '没找到 if (hit) { … } else { … } 结构');
    const hitBlock = body.slice(hitAt, elseAt);
    for (const forbidden of ['catmullRomPoints(', 'weldRiverJunctions(', 'snapRiverTails(']) {
      assert(!hitBlock.includes(forbidden), `命中分支里还在调 ${forbidden}（命中就该一次都不做）`);
    }
    // 反向判据：miss 分支里必须有这三件，否则“缓存”把活儿删了
    const missBlock = body.slice(elseAt, body.indexOf('writeWeldCache(_weldCache'));
    for (const needed of ['catmullRomPoints(', 'snapRiverTails(', 'weldRiverJunctions(']) {
      assert(missBlock.includes(needed), `未命中分支里少了 ${needed} —— 活儿被删了`);
    }
    return '命中分支 0 次重算 / 未命中分支三件都还在';
  });

  await check('c3 排障口带 cacheHits / cacheMisses（判据要能读，不靠猜）', () => {
    const body = fs.readFileSync(RIVERS, 'utf8');
    assert(body.includes('__SITIAN_RIVER_WELD__'), '排障口没了');
    assert(body.includes('weldCacheStats(_weldCache)'), '排障口没带缓存读数（hits/misses 读不出来 = 判据空转）');
    assert(body.includes('cached: !!hit'), '排障口要能看出这一帧是命中还是重算');
    return '__SITIAN_RIVER_WELD__ 带 cached + hits/misses';
  });

  // ── 输出 ──────────────────────────────────────────────────────────────────
  const failed = results.filter(r => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\n=== 汇流焊接缓存 ${results.length - failed.length}/${results.length} 通过 ===`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ 单测自身异常：', err && err.stack ? err.stack : err);
  process.exit(1);
});
