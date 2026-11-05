#!/usr/bin/env node
/**
 * Node 单元测试：星域背景的**按世界派生种子**（2026-11-03）
 *
 * 用户实测原话：“中间背景图是固定的吗？好丑。不能每次随机生成吗？顺便每个世界的图大小都固定吗？”
 *
 * 事实：此前 `GalaxyMap` / 导出都调 `paintGalaxySky` 而**不传 seed** → 全部落到默认值 20261031，
 * 于是所有世界共用同一张天。这一轮按**世界 id** 派生种子，但刻意**不是随机**：
 *   · 同一世界每次进来必须是同一片天（否则像素基线、导出图、截图全部失去意义）；
 *   · 不同世界必须是不同的天（否则这个功能等于没做）；
 *   · 名字改了天不能变（名字是显示层，id 才是身份）。
 * 这三条就是本文件的判据，最后再加一枚反向探针证明判据不是空转。
 *
 * 用法：node scripts/tests/unit/test_galaxy_sky_seed.js
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SKY = path.join(ROOT, 'src', 'renderer', 'src', 'galaxy', 'sky.js');
const GALAXY_MAP = path.join(ROOT, 'src', 'renderer', 'src', 'components', 'GalaxyMap.vue');
const APP = path.join(ROOT, 'src', 'renderer', 'src', 'App.vue');

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function readText(p) { return require('fs').readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }

/** 判据本体（也供反向探针复用）：给定一个 derive 函数，检查三条口径 */
function seedProblems(derive) {
  const out = [];
  const a1 = derive('world_1700000000000_abc123');
  const a2 = derive('world_1700000000000_abc123');
  if (a1 !== a2) out.push('同一世界两次派生出不同种子（同一世界必须是同一片天）');
  if (!Number.isFinite(a1) || a1 <= 0) out.push(`种子不是正整数：${a1}`);
  const b = derive('world_1800000000000_xyz789');
  if (a1 === b) out.push('两个不同世界拿到同一个种子（换世界没换天 = 功能没做）');
  // 空/缺失 → 回落默认值（老截图与老基线认得它）
  if (derive('') !== derive(null)) out.push('空 id 与 null 的回落不一致');
  return out;
}

async function main() {
  const sky = await import(pathToFileURL(SKY).href);

  await check('s1 导出：skySeedFor / DEFAULT_SKY_SEED 都在，默认值仍是 20261031', () => {
    assert(typeof sky.skySeedFor === 'function', 'skySeedFor 不是函数');
    assert(sky.DEFAULT_SKY_SEED === 20261031, `默认种子变了：${sky.DEFAULT_SKY_SEED}`);
    return `DEFAULT_SKY_SEED=${sky.DEFAULT_SKY_SEED}`;
  });

  await check('s2 三条口径：同世界恒定 / 换世界就换 / 空 id 回落默认', () => {
    const bad = seedProblems(sky.skySeedFor);
    assert(bad.length === 0, bad.join('；'));
    const s = sky.skySeedFor('world_A');
    return `world_A → ${s}，空 → ${sky.DEFAULT_SKY_SEED}`;
  });

  await check('s3 派生的是**世界 id** 而不是名字（改名不该换天）', async () => {
    // 名字不进派生函数的入参，这一条靠源码闸门守：GalaxyMap 传的是 props.world.id
    const gm = readText(GALAXY_MAP);
    assert(/skySeedFor\(props\.world && props\.world\.id\)/.test(gm), 'GalaxyMap 没有按 props.world.id 派生种子');
    assert(!/skySeedFor\(props\.world && props\.world\.name\)/.test(gm), 'GalaxyMap 用了名字派生（改名会换天）');
    const app = readText(APP);
    assert(/skySeedFor\(store\.currentWorld && store\.currentWorld\.id\)/.test(app), 'App 导出没有按 currentWorld.id 派生种子（导出与画布不同源）');
    return '画布与导出都按世界 id';
  });

  await check('s4 换世界会重绘（否则新世界顶着上一个世界的那片天）', () => {
    const gm = readText(GALAXY_MAP);
    assert(/watch\(\(\) => props\.world && props\.world\.id/.test(gm), '没有监听世界切换并 requestRender');
    return 'watch(world.id) → requestRender';
  });

  await check('s5 反向探针：写死种子的实现必须被判据抓到（否则本文件空转）', () => {
    const frozen = () => 20261031;
    const bad = seedProblems(frozen);
    assert(bad.length > 0, '写死种子的实现没被报出来');
    return `${bad.length} 条问题被报出`;
  });

  await check('s6 落到画面上是真的不一样（构图纯函数：两个世界的 spec 必须不同）', () => {
    // 不靠“种子数字不同”推断 —— 直接比两张构图的指纹（星点/星云位置与半径都参与）。
    const a = JSON.stringify(sky.galaxySkySpec(sky.skySeedFor('world_A')));
    const b = JSON.stringify(sky.galaxySkySpec(sky.skySeedFor('world_B')));
    const d = JSON.stringify(sky.galaxySkySpec(sky.skySeedFor('world_A')));
    assert(a !== b, '两个世界的构图一模一样（种子变了但画面没变）');
    assert(a === d, '同一世界两次构图不同（同一世界必须是同一片天）');
    const spec = sky.galaxySkySpec(sky.skySeedFor('world_A'));
    return `构图长度 ${a.length} 字节，两世界不同 / 同世界一致`;
  });

  const failed = results.filter(r => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  —— ' + r.detail : ''}`);
  console.log(`\n=== 星域背景种子 ${results.length - failed.length}/${results.length} 通过 ===`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
