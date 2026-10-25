#!/usr/bin/env node
/**
 * Node 单元测试：底图「一笔未改」判定 + 重导省映射（src/renderer/src/utils/basemapIdentity.js）
 *
 * 为什么值得测：019 的语义是「改过一笔 = 新底图 + 旧归属迁过去」。
 * 判错会静默丢归属：
 *   · 指纹把"只改了一个顶点"当成没改 → 走同图补数据，用户的编辑被覆盖；
 *   · 映射把拆省/并省弄反 → 旧归属落到错的省。
 *
 * 用法：node scripts/tests/unit/test_basemap_identity.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const DEPS = ['basemapIdentity.js', 'provinceShape.js', 'geometry.js', 'gridOutline.js', 'polylineSmooth.js', 'polityLabels.js'];

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (e) { results.push({ name, ok: false, detail: (e && e.message) || String(e) }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, label) {
  if (a !== b) throw new Error(`${label}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
function deepEq(a, b, label) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${label}: 期望 ${y}，实际 ${x}`);
}

function rect(id, x0, y0, w, h, extra) {
  return {
    id, name: id, kind: 'land', ...(extra || {}),
    points: [
      { x: x0, y: y0 }, { x: x0 + w, y: y0 },
      { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h },
    ],
  };
}

async function main() {
  // 复制到临时目录 + 补 .js 扩展名（与其它 unit 用例同法；模块有相对 import）
  const cands = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Temp'), os.tmpdir(), process.env.TEMP, process.env.TMP];
  let root = null;
  for (const c of cands) {
    if (!c || !path.isAbsolute(c)) continue;
    try { fs.mkdirSync(c, { recursive: true }); fs.accessSync(c, fs.constants.W_OK); root = c; break; } catch (_) { /* next */ }
  }
  if (!root) throw new Error('找不到可写临时目录');
  const tmp = fs.mkdtempSync(path.join(root, 'sitian-basemap-id-'));
  for (const f of DEPS) {
    fs.writeFileSync(path.join(tmp, f), fs.readFileSync(path.join(SRC_DIR, f), 'utf8')
      .replace(/from '\.\/([A-Za-z0-9_-]+)(?:\.js)?'/g, "from './$1.js'"));
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const mod = await import(pathToFileURL(path.join(tmp, 'basemapIdentity.js')).href);
  const { basemapFingerprint, stampBasemapSource, isBasemapPristine, mapProvinces, remapScenariosForReimport } = mod;

  check('b1 指纹：同一份数据同指纹（键顺序无关）；改一个顶点就变', () => {
    const a = { terrain: [rect('p1', 0, 0, 100, 100)], rivers: [{ id: 'r', name: '河', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] };
    const b = { rivers: a.rivers, terrain: a.terrain };
    eq(basemapFingerprint(a), basemapFingerprint(b), '键顺序不影响');
    const c = JSON.parse(JSON.stringify(a));
    c.terrain[0].points[0].x += 0.01;
    assert(basemapFingerprint(a) !== basemapFingerprint(c), '改顶点必须变指纹');
    const d = JSON.parse(JSON.stringify(a));
    d.rivers[0].points[1].y = 2;
    assert(basemapFingerprint(a) !== basemapFingerprint(d), '改河必须变指纹');
    return '同/异 3 例';
  });

  check('b2 一笔未改：盖指纹后 pristine；改高度图/城镇/参考图后不再 pristine', () => {
    const bm = {
      terrain: [rect('p1', 0, 0, 10, 10)],
      heightmap: { h: new Float32Array([1, 2, 3]), grid: { points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 5 }], cellsX: 2, cellsY: 2, spacing: 5 } },
      burgs: [{ id: 1, name: '镇', x: 5, y: 5 }],
      referenceImages: [{ id: 'ref', dataUrl: 'data:x', width: 1, height: 1 }],
    };
    const stamped = stampBasemapSource(bm, { file: 'a.map', at: '2026-10-25T00:00:00.000Z' });
    assert(!!stamped.source.contentHash, '盖了指纹');
    assert(isBasemapPristine(stamped), '刚导入 = 一笔未改');
    const edited = JSON.parse(JSON.stringify(stamped));
    edited.burgs[0].name = '改名';
    assert(!isBasemapPristine(edited), '改城镇后必须判"改过"');
    const edited2 = JSON.parse(JSON.stringify(stamped));
    edited2.heightmap.h = [1, 2, 9];
    assert(!isBasemapPristine(edited2), '改高度图后必须判"改过"');
    assert(!isBasemapPristine({ terrain: [] }), '没有指纹的旧数据保守判"改过"');
    return 'pristine/改城镇/改高度/无指纹 4 例';
  });

  check('b3 映射：id 相同直接配对', () => {
    const oldT = [rect('a', 0, 0, 10, 10), rect('b', 20, 0, 10, 10)];
    const newT = [rect('a', 0, 0, 10, 10), rect('b', 20, 0, 10, 10)];
    const m = mapProvinces(oldT, newT);
    deepEq(m.byOld, { a: ['a'], b: ['b'] }, 'byOld');
    deepEq(m.exact, ['a', 'b'], 'exact');
    eq(m.conflicts.length, 0, '无冲突');
    return '2 省';
  });

  check('b4 拆省：一个旧省 → 两个新省（一对多，不是冲突）', () => {
    const oldT = [rect('old', 0, 0, 100, 100)];
    const newT = [rect('n1', 0, 0, 50, 100), rect('n2', 50, 0, 50, 100)];
    const m = mapProvinces(oldT, newT);
    deepEq(m.byOld, { old: ['n1', 'n2'] }, 'byOld');
    eq(m.conflicts.length, 0, '拆省不算冲突');
    deepEq(m.unmappedOld, [], '旧省全映射');
    return 'old→[n1,n2]';
  });

  check('b5 并省：两个旧省 → 一个新省（多对一，必须进冲突清单）', () => {
    const oldT = [rect('o1', 0, 0, 50, 100), rect('o2', 50, 0, 50, 100)];
    const newT = [rect('n', 0, 0, 100, 100)];
    const m = mapProvinces(oldT, newT);
    eq(m.conflicts.length, 1, '有一条冲突');
    deepEq(m.conflicts[0].oldIds.sort(), ['o1', 'o2'], '冲突里列出两个旧省');
    deepEq(m.byOld.n ? [] : (m.byOld.n || []), [], 'n 不是旧 id');
    return JSON.stringify(m.conflicts);
  });

  check('b6 未映射：旧省与新省完全错开 → 各自进 unmapped', () => {
    const oldT = [rect('old', 0, 0, 10, 10)];
    const newT = [rect('new', 1000, 1000, 10, 10)];
    const m = mapProvinces(oldT, newT);
    deepEq(m.unmappedOld, ['old'], '旧未映射');
    deepEq(m.unmappedNew, ['new'], '新未映射');
    return 'old/new 各自 unmapped';
  });

  check('b7 剧本迁移：只动旧底图；id 保持；拆省复制归属/事件；未映射列出', () => {
    const scenarios = {
      'old/甲': {
        id: 'old/甲', ownerKey: 'old', name: '甲',
        ownership: { o1: 'P1', o2: 'P2', gone: 'P3' },
        changeEvents: { o1: [{ y: 2000, m: null, d: null, owner: 'P1' }] },
        initialOwnership: { o1: 'P0' },
        labels: [{ text: '地名', x: 1, y: 2 }],
      },
      'other/乙': { id: 'other/乙', ownerKey: 'other', name: '乙', ownership: { x: 'Q' } },
    };
    const map = { byOld: { o1: ['n1', 'n2'], o2: ['n3'] }, byNew: {}, exact: [], conflicts: [], unmappedOld: ['gone'], unmappedNew: [] };
    const r = remapScenariosForReimport(scenarios, 'old', 'new', map);
    deepEq(r.moved, ['old/甲'], '只迁旧底图剧本');
    const s = r.scenarios['old/甲'];
    eq(s.id, 'old/甲', 'id 保持不变');
    eq(s.ownerKey, 'new', 'ownerKey 改新');
    deepEq(s.ownership, { n1: 'P1', n2: 'P1', n3: 'P2' }, '拆省复制归属');
    deepEq(s.initialOwnership, { n1: 'P0', n2: 'P0' }, 'initialOwnership 同步');
    deepEq(s.changeEvents, { n1: [{ y: 2000, m: null, d: null, owner: 'P1' }], n2: [{ y: 2000, m: null, d: null, owner: 'P1' }] }, '事件复制');
    deepEq(r.droppedOldProvinces, ['gone'], '未映射省列出');
    eq(r.scenarios['other/乙'], scenarios['other/乙'], '别的底图同引用');
    return `moved=${r.moved} dropped=${r.droppedOldProvinces}`;
  });

  const failed = results.filter(r => !r.ok);
  for (const r of results) console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    for (const f of failed) console.error(`  · ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('用例异常：', e); process.exit(1); });
