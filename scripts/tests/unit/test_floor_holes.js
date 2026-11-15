#!/usr/bin/env node
/**
 * Node 单元测试：楼板洞口（src/renderer/src/interior/floorHoles.js + buildShell 接线，A16 余）
 *
 * 守四件事：
 *   · 手画洞是**矩形**（左上角 + 宽高），夹在 20~5000cm；
 *   · 合并口径只有一处：`allHolesForFloor` = 楼梯自动开的（在前）+ 手画的（在后）；
 *   · 3D 楼板真的被切碎（不是“平面图上有洞、3D 里楼板是整块”）；
 *   · 命中重叠时取小的那个（大洞套小洞时用户想选小的）。
 *
 * 用法：node scripts/tests/unit/test_floor_holes.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DIR = path.join(ROOT, 'src', 'renderer', 'src', 'interior');
const SRC_HOLES = path.join(DIR, 'floorHoles.js');
const SRC_SHELL = path.join(DIR, 'buildShell.js');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function near(a, b, tol, label) {
  if (!Number.isFinite(a) || Math.abs(a - b) > tol) throw new Error(`${label}: 期望 ${b} ±${tol}，实际 ${a}`);
}

async function loadEsm(absPath) {
  const cache = new Map();
  const build = (p) => {
    if (cache.has(p)) return Promise.resolve(cache.get(p));
    const src = fs.readFileSync(p, 'utf8');
    const re = /from\s+'(\.\.?\/[^']+)';/g;
    const jobs = [];
    let m;
    while ((m = re.exec(src))) jobs.push({ at: m.index, end: m.index + m[0].length, spec: m[1] });
    const parts = [];
    let last = 0;
    const chain = jobs.reduce((p2, j) => p2.then(async () => {
      const child = path.resolve(path.dirname(p), j.spec);
      const url = await build(child);
      parts.push(src.slice(last, j.at) + `from '${url}';`);
      last = j.end;
    }), Promise.resolve());
    return chain.then(() => {
      const out = parts.join('') + src.slice(last);
      const url = 'data:text/javascript;base64,' + Buffer.from(out, 'utf8').toString('base64');
      cache.set(p, url);
      return url;
    });
  };
  const url = await build(absPath);
  return import(url);
}

function rectRoom({ w = 800, d = 600, t = 12, h = 280, elevation = 0, id = 'f1', holes = [], stairs = [] } = {}) {
  const corners = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: d }, { x: 0, y: d }];
  const walls = corners.map((c, i) => {
    const n = corners[(i + 1) % corners.length];
    return { id: `${id}-w${i}`, start: { ...c }, end: { ...n }, thickness: t, height: h, color: '#8d7f6e' };
  });
  return { id, name: id, elevation, walls, doors: [], windows: [], furniture: [], columns: [], holes, stairs };
}

async function main() {
  const holesMod = await loadEsm(SRC_HOLES);
  const shellMod = await loadEsm(SRC_SHELL);
  const { normalizeHole, holePolygon, ownHolesForFloor, allHolesForFloor, holeAtPoint, HOLE_DEFAULTS, HOLE_MIN, HOLE_MAX } = holesMod;
  const { buildBuildingShell } = shellMod;

  check('h1 缺省 120×120；只给坐标也成立', () => {
    const n = normalizeHole({ x: 10, y: 20 });
    assert(n, '应当成立');
    near(n.w, HOLE_DEFAULTS.w, 1e-9, '缺省宽');
    near(n.h, HOLE_DEFAULTS.h, 1e-9, '缺省高');
    return '120×120';
  });

  check('h2 宽高夹在 20~5000cm', () => {
    near(normalizeHole({ x: 0, y: 0, w: 1, h: 1 }).w, HOLE_MIN, 1e-9, '下限');
    near(normalizeHole({ x: 0, y: 0, w: 99999, h: 99999 }).h, HOLE_MAX, 1e-9, '上限');
    near(normalizeHole({ x: 0, y: 0, w: 150, h: 90 }).w, 150, 1e-9, '区间内照抄');
    return '1→20 / 99999→5000';
  });

  check('h3 坐标不是数 → null', () => {
    assert(normalizeHole({ x: NaN, y: 0 }) === null, 'x=NaN');
    assert(normalizeHole({ y: 0 }) === null, '缺 x');
    assert(normalizeHole(null) === null, 'null');
    return '3 种非法输入';
  });

  check('h4 多边形 = 左上 → 右上 → 右下 → 左下', () => {
    const poly = holePolygon({ x: 100, y: 200, w: 50, h: 30 });
    assert(poly.length === 4, `应为 4 点，实际 ${poly.length}`);
    assert(poly[0].x === 100 && poly[0].y === 200, '左上');
    assert(poly[1].x === 150 && poly[1].y === 200, '右上');
    assert(poly[2].x === 150 && poly[2].y === 230, '右下');
    assert(poly[3].x === 100 && poly[3].y === 230, '左下');
    return '4 点顺时针';
  });

  check('h5 ownHolesForFloor：转 poly + 名字兜底；非法洞被跳过', () => {
    const out = ownHolesForFloor({
      holes: [
        { id: 'a', x: 0, y: 0, w: 100, h: 100 },
        { id: 'b', x: 0, y: 0, w: 100, h: 100, label: '检修口' },
        { id: 'bad', w: 10, h: 10 },
      ],
    });
    assert(out.length === 2, `应为 2 个（坏数据被跳），实际 ${out.length}`);
    assert(out[0].holeId === 'a' && out[0].label === '洞口', '名字兜底');
    assert(out[1].label === '检修口', '自定义名字');
    assert(out[0].poly.length === 4, 'poly 4 点');
    return '2 个（1 个被跳）';
  });

  check('h6 allHolesForFloor：楼梯洞在前、手画洞在后', () => {
    const floors = [
      rectRoom({ id: 'f1', elevation: 0, stairs: [{ id: 's1', start: { x: 100, y: 300 }, end: { x: 400, y: 300 }, width: 100, steps: 17, direction: 'up' }] }),
      rectRoom({ id: 'f2', elevation: 300, holes: [{ id: 'h1', x: 100, y: 100, w: 150, h: 150 }] }),
    ];
    const list = allHolesForFloor(floors, 'f2');
    assert(list.length === 2, `应有 2 个洞（楼梯 + 手画），实际 ${list.length}`);
    assert(list[0].stairId === 's1', '第一个应是楼梯洞');
    assert(list[1].holeId === 'h1', '第二个应是手画洞');
    return '楼梯 1 + 手画 1';
  });

  check('h7 allHolesForFloor：没有楼梯时只有手画洞；层 id 不存在返回空', () => {
    const floors = [rectRoom({ id: 'f1', elevation: 0, holes: [{ id: 'h1', x: 0, y: 0, w: 100, h: 100 }] })];
    assert(allHolesForFloor(floors, 'f1').length === 1, '应只有 1 个手画洞');
    assert(allHolesForFloor(floors, 'ghost').length === 0, '不存在的层应为空');
    return '1 / 0';
  });

  check('h8 holeAtPoint：命中矩形内；外面不命中；重叠取小的那个', () => {
    const big = { id: 'big', x: 0, y: 0, w: 400, h: 400 };
    const small = { id: 'small', x: 50, y: 50, w: 100, h: 100 };
    assert(holeAtPoint([big], { x: 100, y: 100 })?.id === 'big', '大洞里应命中');
    assert(holeAtPoint([big], { x: 500, y: 500 }) === null, '外面不该命中');
    assert(holeAtPoint([big, small], { x: 100, y: 100 })?.id === 'small', '重叠时应取小的');
    return 'small';
  });

  check('h9 buildShell：二层有手画洞 → 楼板被切碎（净面积 = 整板 − 洞）', () => {
    const f1 = rectRoom({ id: 'f1', elevation: 0 });
    const f2 = rectRoom({ id: 'f2', elevation: 300, holes: [{ id: 'h1', x: 200, y: 150, w: 200, h: 150 }] });
    const withHole = buildBuildingShell([f1, f2], { roof: { kind: 'flat' } });
    const pieces = withHole.boxes.filter((b) => b.kind === 'slab');
    assert(pieces.length >= 2, `楼板应被切碎，实际 ${pieces.length} 块`);
    const area = pieces.reduce((s, b) => s + b.sx * b.sz, 0);

    const f2b = rectRoom({ id: 'f2', elevation: 300 });
    const noHole = buildBuildingShell([f1, f2b], { roof: { kind: 'flat' } });
    const whole = noHole.boxes.filter((b) => b.kind === 'slab').reduce((s, b) => s + b.sx * b.sz, 0);
    near(area, whole - 200 * 150, whole * 0.02, '净面积 = 整板 − 洞');
    return `${pieces.length} 块 · 净面积 ${area.toFixed(0)}`;
  });

  check('h10 单层楼没有楼板：手画洞不生成任何盒子（也不报错）', () => {
    const r = buildBuildingShell([rectRoom({ id: 'f1', elevation: 0, holes: [{ id: 'h1', x: 0, y: 0, w: 100, h: 100 }] })], { roof: { kind: 'flat' } });
    assert(r.boxes.filter((b) => b.kind === 'slab').length === 0, '单层不该有楼板');
    return '0 块';
  });

  const bad = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? '  ok  ' : '  FAIL'}  ${r.name}${r.detail ? `  —— ${r.detail}` : ''}`);
  }
  console.log(`\n${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) {
    console.log('\n失败明细：');
    for (const r of bad) console.log(` - ${r.name}\n   ${r.detail}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
