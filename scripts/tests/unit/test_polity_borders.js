#!/usr/bin/env node
/**
 * Node 单元测试：国界边（2026-11-03）
 *
 * 「国界」= **同一条共边两侧归属不同**的那些边。这条判据只能在共边索引上做（顶点严格重合），
 * 做错了不会报错、只会"图上多画/少画几条线"。所以这里用三块拼在一起的方块把口径钉死：
 *   · 共享边只算一次（两侧各省一条，索引里要并成一条）；
 *   · 两侧同主 → 不是国界；两侧全无主 → 不是国界；一侧有主一侧无主 → 是国界；
 *   · 顶点顺序相反（A 顺时针、B 逆时针）也必须认成同一条边。
 *
 * 用法：node scripts/tests/unit/test_polity_borders.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const U = path.join(ROOT, 'src', 'renderer', 'src', 'utils');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** 方块（顺时针，y 向下）。共边靠**同坐标**，与手绘/导入的真实口径一致 */
function square(id, x0, y0, x1, y1, clockwise = true) {
  const pts = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  return { id, name: id, points: clockwise ? pts : pts.slice().reverse(), kind: 'land' };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-polity-'));
  // 与被测模块同法（见 test_vertex_sharing.js）：复制依赖 + 给相对 import 补 `.js` + 写 type:module
  const DEPS = ['vertexSharing.js', 'provinceShape.js', 'polylineSmooth.js', 'geometry.js', 'gridOutline.js'];
  const fixExt = (src) => src.replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
  for (const f of DEPS) {
    const p = path.join(U, f);
    if (!fs.existsSync(p)) continue;
    fs.writeFileSync(path.join(tmp, f), fixExt(fs.readFileSync(p, 'utf8')));
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const V = await import(pathToFileURL(path.join(tmp, 'vertexSharing.js')).href);

  const A = square('a', 0, 0, 10, 10);
  const B = square('b', 10, 0, 20, 10, false);   // 逆时针：共边端点顺序相反
  const C = square('c', 20, 0, 30, 10);
  const three = [A, B, C];

  check('p1 共边索引：三块拼一起 → A|B、B|C 各被认成一条共享边', () => {
    const idx = V.buildEdgeIndex(three);
    assert(idx instanceof Map, '应返回 Map');
    // 3 块 × 4 条 = 12 条，两条共享边各并掉 1 条 → 10 条唯一边
    assert(idx.size === 10, `唯一边应为 10，实测 ${idx.size}`);
    const shared = [...idx.values()].filter(e => e.provs.length >= 2);
    assert(shared.length === 2, `共享边应为 2 条，实测 ${shared.length}`);
    // 共享边的两个端点必须是 x=10 / x=20 的竖边（含端点坐标，别认成同一条水平边）
    const xs = shared.map(e => [e.a.x, e.b.x].sort((m, n) => m - n).join(',')).sort();
    assert(xs.join(' | ') === '10,10 | 20,20', `共享边的 x 坐标不对：${xs.join(' | ')}`);
    return `唯一边 ${idx.size} / 共享 ${shared.length}`;
  });

  check('p2 两侧同主 → 不是国界；全无主 → 不是国界', () => {
    assert(V.buildPolityBorderEdges(three, () => 'p1').length === 0, '同主不该画国界');
    assert(V.buildPolityBorderEdges(three, () => '').length === 0, '全无主不该画国界');
    return 'ok';
  });

  check('p3 A=p1 / B=p2 / C=p2 → 只画 A|B 那一条', () => {
    const owner = { a: 'p1', b: 'p2', c: 'p2' };
    const edges = V.buildPolityBorderEdges(three, (p) => owner[p.id] || '');
    assert(edges.length === 1, `应只有 1 条国界，实测 ${edges.length}`);
    const xs = [edges[0].a.x, edges[0].b.x].sort((m, n) => m - n).join(',');
    assert(xs === '10,10', `国界应落在 x=10（A|B），实测 x=${xs}`);
    return 'ok';
  });

  check('p4 一侧有主、一侧无主 → 也算国界（EU4 的"边境"）', () => {
    const owner = { a: 'p1', b: '', c: '' };
    const edges = V.buildPolityBorderEdges(three, (p) => owner[p.id] || '');
    assert(edges.length === 1, `应只有 1 条边境，实测 ${edges.length}`);
    return 'ok';
  });

  check('p5 单省 / 空数据 / 缺字段都不许抛', () => {
    assert(V.buildPolityBorderEdges([A], () => 'p1').length === 0, '单省不该有国界');
    assert(V.buildPolityBorderEdges([], () => 'p1').length === 0, '空数据应返回空');
    assert(V.buildPolityBorderEdges(null, () => 'p1').length === 0, 'null 应返回空');
    assert(V.buildEdgeIndex([{ id: 'x' }]).size === 0, '没有 points 的省应被跳过');
    return 'ok';
  });

  check('p6 三块交汇于一点：每条共边仍只算一条，不会把三条边串成一条', () => {
    // 一个"品"字形：三块各占 120°，两两共边
    const s1 = { id: 's1', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }] };
    const s2 = { id: 's2', points: [{ x: 10, y: 0 }, { x: 5, y: 10 }, { x: 20, y: 10 }] };
    const s3 = { id: 's3', points: [{ x: 5, y: 10 }, { x: 0, y: 0 }, { x: 20, y: 10 }] };
    const idx = V.buildEdgeIndex([s1, s2, s3]);
    const shared = [...idx.values()].filter(e => e.provs.length >= 2);
    assert(shared.length === 3, `三个两两共边的三角形应有 3 条共享边，实测 ${shared.length}`);
    return `共享 ${shared.length}`;
  });

  const failed = results.filter(r => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  —— ' + r.detail : ''}`);
  console.log(`\n=== 国界边 ${results.length - failed.length}/${results.length} 通过 ===`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
