#!/usr/bin/env node
/**
 * Node 单元测试：FMG 高度图管线（B 阶段 2 第一步，2026-10-29）
 *
 * 守的四件事（与 `docs/plan/TODO_REMAINING_20261028.md` 的 B 条一一对应）：
 *   · **同 seed 逐字节一致**（P0 改造的判据：随机只来自显式 rng，不再改全局 Math.random）；
 *   · **8k 格 < 1s**（真机 Node 实测，取三次中位数）；
 *   · 产出能直接当司天的高度图用（形状 / 单位 / 格距自洽，陆地占比在合理区间）；
 *   · 模板是**数据**：14 个模板齐全、MIT 头在、未知模板必须报错而不是静默回落。
 *
 * 用法：node scripts/tests/unit/test_fmg_heightmap.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, l) { if (a !== b) throw new Error(`${l}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }

/** 把 utils 整棵树拷到临时目录（够粗暴但可靠：fmg 的依赖横跨 utils 根与 utils/fmg） */
function copyUtils() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-fmg-'));
  const copy = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
      const s = path.join(from, ent.name);
      const d = path.join(to, ent.name);
      if (ent.isDirectory()) copy(s, d);
      else if (ent.name.endsWith('.js')) {
        const src = fs.readFileSync(s, 'utf8')
          .replace(/from '(\.{1,2}\/[^']+)'/g, (m, p) => (path.extname(p) ? m : `from '${p}.js'`));
        fs.writeFileSync(d, src);
      }
    }
  };
  copy(UTILS, path.join(dir, 'utils'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  return dir;
}

function hashBytes(arr) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < arr.length; i++) {
    h ^= arr[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

async function main() {
  const dir = copyUtils();
  const url = (rel) => pathToFileURL(path.join(dir, rel)).href;
  const F = await import(url('utils/fmg/index.js'));
  const T = await import(url('utils/fmg/templates.js'));
  const { generateHeightmap, toSitianHeightmap, landRatioOf, spacingForCells, HEIGHT_TEMPLATES, TEMPLATE_IDS } = F;

  const base = { seed: 12345, width: 1600, height: 1000, cellsDesired: 2000, templateId: 'continents' };

  check('f1 确定性：同 seed 两次逐字节一致，换 seed 明显不同（P0：显式 rng）', () => {
    const a = generateHeightmap(base);
    const b = generateHeightmap(base);
    eq(hashBytes(a.h), hashBytes(b.h), '同 seed 哈希应相同');
    eq(a.cellsX, b.cellsX, '行列应相同');
    const c = generateHeightmap({ ...base, seed: 999 });
    assert(hashBytes(c.h) !== hashBytes(a.h), '换 seed 后高度图不该一样');
    return `${a.cellsX}×${a.cellsY} / hash ${hashBytes(a.h)}`;
  });

  check('f2 8k 格 < 1s（三次中位数；判据是"真机 Node"不是拍脑袋）', () => {
    const opts = { ...base, cellsDesired: 8000, templateId: 'oldWorld' };
    const times = [];
    let cells = 0;
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const r = generateHeightmap(opts);
      times.push(Date.now() - t0);
      cells = r.cellsX * r.cellsY;
    }
    times.sort((x, y) => x - y);
    const median = times[1];
    assert(cells >= 6000, `目标 8000 格，实际只有 ${cells}`);
    assert(median < 1000, `8k 格耗时中位数 ${median}ms（应 < 1000ms）`);
    return `${cells} 格 / 中位 ${median}ms（${times.join('/')}）`;
  });

  check('f3 出来的图能当司天高度图用：形状 / 单位 / 陆地占比自洽', () => {
    const r = generateHeightmap({ ...base, cellsDesired: 4000, roughness: 40, coverage: 0.4 });
    assert(r.h.length === r.cellsX * r.cellsY, '格数应与行列自洽');
    const ratio = landRatioOf(r.h);
    // 覆盖率校准的判据：命中目标 ±1 个百分点（这是 B 条写死的判据之一）
    assert(Math.abs(ratio - 0.4) <= 0.011, `覆盖率应命中 40%±1pp（实际 ${(ratio * 100).toFixed(1)}%）`);
    // 单位：0..100 的整数，且真的用到了海（20 以下）与陆（20 以上）
    let min = 255, max = 0;
    for (const v of r.h) { if (v < min) min = v; if (v > max) max = v; }
    assert(min < 20 && max >= 20, `高度应跨过海平面 20（min ${min} / max ${max}）`);
    const hm = toSitianHeightmap(r, { originX: -800, originY: -500 });
    assert(hm.grid.points.length === r.h.length, '适配后点数应与格数一致');
    assert(hm.grid.cellsX === r.cellsX && hm.grid.cellsY === r.cellsY, '适配后行列应保持');
    assert(hm.h instanceof Float32Array, '司天侧 h 是 Float32Array（与 commitHeightmap 的形状一致）');
    const p0 = hm.grid.points[0];
    assert(p0[0] >= -800 && p0[1] >= -500, '适配后的点应落在给定原点上');
    return `陆地 ${(ratio * 100).toFixed(1)}%（目标 40） / ${r.cellsX}×${r.cellsY} / spacing ${r.spacing.toFixed(1)}`;
  });

  check('f4 模板是数据：14 个齐全、MIT 头在、未知模板必须报错', () => {
    eq(TEMPLATE_IDS.length, 14, '模板数');
    const src = fs.readFileSync(path.join(UTILS, 'fmg', 'templates.js'), 'utf8');
    assert(src.includes('SPDX-License-Identifier: MIT'), 'templates.js 必须保留 MIT 许可头');
    assert(src.includes('Azgaar'), 'templates.js 必须保留 Azgaar 版权行');
    for (const id of TEMPLATE_IDS) {
      const t = HEIGHT_TEMPLATES[id];
      assert(typeof t.template === 'string' && t.template.length > 20, `${id} 模板脚本为空`);
      assert(t.probability > 0, `${id} 权重应 > 0`);
    }
    let threw = false;
    try { T.getTemplateScript('no-such-template'); } catch (e) { threw = true; }
    assert(threw, '未知模板必须抛错（静默回落会让"选了 A 出来 B"无法排查）');
    return `${TEMPLATE_IDS.length} 个模板 / MIT 头在`;
  });

  check('f5 大陆参数展开：同 seed 同脚本、换 count 脚本变、且能真的跑出图', () => {
    const a = generateHeightmap({ ...base, templateId: undefined, continents: { count: 4, sizeVariance: 0.4 } });
    const b = generateHeightmap({ ...base, templateId: undefined, continents: { count: 4, sizeVariance: 0.4 } });
    eq(hashBytes(a.h), hashBytes(b.h), '同参数同 seed 应一致');
    const c = generateHeightmap({ ...base, templateId: undefined, continents: { count: 7, sizeVariance: 0.4 } });
    assert(a.template !== c.template, '换大陆数应换脚本');
    assert(hashBytes(a.h) !== hashBytes(c.h), '换大陆数应换结果');
    assert(a.template.includes('Hill'), '展开出来的脚本应含 Hill 步骤');
    return `脚本 ${a.template.split('\n').length} 步 / 4 块 vs 7 块不同`;
  });

  check('f6 随机纪律：fmg/ 下不许出现 Math.random（判据只能来自传入的 rng）', () => {
    const bad = [];
    const walk = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) { walk(p); continue; }
        if (!ent.name.endsWith('.js')) continue;
        const src = fs.readFileSync(p, 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        if (/Math\.random\s*\(/.test(src)) bad.push(path.relative(UTILS, p));
      }
    };
    walk(path.join(UTILS, 'fmg'));
    assert(bad.length === 0, `fmg/ 里出现 Math.random：${bad.join(', ')}`);
    return 'fmg/ 下 0 处 Math.random';
  });

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed += 1;
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log(`\n=== ${results.length - failed}/${results.length} 通过 ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('用例异常：', e); process.exit(1); });
