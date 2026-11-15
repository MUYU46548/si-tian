#!/usr/bin/env node
/**
 * Node 单元测试：柱（src/renderer/src/interior/columns.js + buildShell 接线，A24 余）
 *
 * 守四件事：
 *   · 柱是**中心点 + 截面**（与家具的“左上角”口径不同），平面矩形 = 中心 ± size/2；
 *   · 柱高 = **本层墙高**（不是全局最高、也不是用户填的字段）—— 否则矮墙房间的柱会顶穿屋面；
 *   · 截面夹在 15~200cm，非法数据（x/y 不是数、size 0）直接跳过，不抛错；
 *   · 命中检测取最近的一根，且给一点容差（手指点不准）。
 *
 * 用法：node scripts/tests/unit/test_columns.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DIR = path.join(ROOT, 'src', 'renderer', 'src', 'interior');
const SRC_COL = path.join(DIR, 'columns.js');
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

/** ESM 源码按 data URL 载入（相对 import 递归替换；与 test_building_shell.js 同一手法） */
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

function rectRoom({ w = 400, d = 300, t = 12, h = 280, elevation = 0, id = 'f1', columns = [] } = {}) {
  const corners = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: d }, { x: 0, y: d }];
  const walls = corners.map((c, i) => {
    const n = corners[(i + 1) % corners.length];
    return { id: `${id}-w${i}`, start: { ...c }, end: { ...n }, thickness: t, height: h, color: '#8d7f6e' };
  });
  return { id, name: id, elevation, walls, doors: [], windows: [], furniture: [], columns };
}

const colA = { id: 'c1', x: 100, y: 100, size: 40, color: '#8d7f6e' };
const colB = { id: 'c2', x: 300, y: 100, size: 60, color: '#8d7f6e' };

async function main() {
  const colMod = await loadEsm(SRC_COL);
  const shellMod = await loadEsm(SRC_SHELL);
  const { normalizeColumn, columnBoxes, columnFootprint, columnAtPoint, COLUMN_DEFAULTS } = colMod;
  const { buildBuildingShell } = shellMod;

  check('c1 缺省值：40cm 方柱、石色；只给坐标也能成立', () => {
    const n = normalizeColumn({ x: 10, y: 20 });
    assert(n, '应当成立');
    near(n.size, COLUMN_DEFAULTS.size, 1e-9, '缺省尺寸');
    assert(n.shape === 'square', `缺省形状应为 square，实际 ${n.shape}`);
    assert(n.color === COLUMN_DEFAULTS.color, '缺省颜色不对');
    return `40cm / ${n.color}`;
  });

  check('c2 截面夹在 15~200cm（太小是点、太大是墙墩）', () => {
    near(normalizeColumn({ x: 0, y: 0, size: 5 }).size, 15, 1e-9, '下限');
    near(normalizeColumn({ x: 0, y: 0, size: 999 }).size, 200, 1e-9, '上限');
    near(normalizeColumn({ x: 0, y: 0, size: 45 }).size, 45, 1e-9, '区间内照抄');
    return '5→15 / 999→200 / 45→45';
  });

  check('c3 坐标不是数 → null（不生成一根“在原点”的假柱）', () => {
    assert(normalizeColumn({ x: NaN, y: 0 }) === null, 'x=NaN 应 null');
    assert(normalizeColumn({ y: 0 }) === null, '缺 x 应 null');
    assert(normalizeColumn(null) === null, 'null 应 null');
    return '3 种非法输入';
  });

  check('c4 盒子口径：中心 = (x, y)，sx = sz = 截面，高度 = 传入的墙高', () => {
    const [b] = columnBoxes([colA], 0, { wallHeight: 280 });
    near(b.cx, 100, 1e-9, '中心 x');
    near(b.cz, 100, 1e-9, '中心 z（= 平面 y）');
    near(b.sx, 40, 1e-9, '截面宽');
    near(b.sz, 40, 1e-9, '截面深');
    near(b.sy, 280, 1e-9, '柱高');
    near(b.cy, 140, 1e-9, '中心高度 = 一半');
    assert(b.kind === 'column', `kind 应为 column，实际 ${b.kind}`);
    return '40×40×280';
  });

  check('c5 二层（elevation 300）的柱坐在 300 面上', () => {
    const [b] = columnBoxes([colA], 300, { wallHeight: 280 });
    near(b.cy - b.sy / 2, 300, 1e-9, '柱底 = 本层地面');
    near(b.cy + b.sy / 2, 580, 1e-9, '柱顶 = 本层墙顶');
    return '300 → 580';
  });

  check('c6 平面矩形 = 中心 ± size/2（左上角口径，与命中/选择框共用）', () => {
    const fp = columnFootprint(colB);
    near(fp.x, 300 - 30, 1e-9, '左上 x');
    near(fp.y, 100 - 30, 1e-9, '左上 y');
    near(fp.w, 60, 1e-9, '宽');
    near(fp.h, 60, 1e-9, '高');
    return '270,70 60×60';
  });

  check('c7 命中：中心命中 / 边缘 +6cm 容差内命中 / 远处不命中', () => {
    assert(columnAtPoint([colA], { x: 100, y: 100 })?.id === 'c1', '中心应命中');
    assert(columnAtPoint([colA], { x: 100 + 20 + 5, y: 100 })?.id === 'c1', '边缘 +5cm 应命中');
    assert(columnAtPoint([colA], { x: 100 + 20 + 20, y: 100 }) === null, '边缘 +20cm 不该命中');
    assert(columnAtPoint([], { x: 0, y: 0 }) === null, '空数组返回 null');
    return '容差 6cm';
  });

  check('c8 命中取最近的一根（两根贴在一起时不能选错）', () => {
    const near1 = { id: 'n1', x: 100, y: 100, size: 40 };
    const near2 = { id: 'n2', x: 130, y: 100, size: 40 };
    const hit = columnAtPoint([near1, near2], { x: 124, y: 100 });
    assert(hit && hit.id === 'n2', `应命中更近的 n2，实际 ${hit && hit.id}`);
    return 'n2';
  });

  check('c9 buildShell 接线：一层 3 根柱 → 3 个柱盒，stats.columns = 3，墙数不变', () => {
    const cols = [colA, colB, { id: 'c3', x: 200, y: 200, size: 30 }];
    const r = buildBuildingShell([rectRoom({ columns: cols })], { roof: { kind: 'flat' } });
    const boxes = r.boxes.filter((b) => b.kind === 'column');
    assert(boxes.length === 3, `柱盒应为 3，实际 ${boxes.length}`);
    assert(r.stats.columns === 3, `stats.columns 应为 3，实际 ${r.stats.columns}`);
    assert(r.stats.walls === 4, `墙数不该变，实际 ${r.stats.walls}`);
    return '3 根 · 总盒 ' + r.stats.boxes;
  });

  check('c10 柱高跟本层墙高（320 高的墙 → 320 的柱），不跟全局最高层', () => {
    const tall = rectRoom({ id: 'f1', elevation: 0, h: 320, columns: [colA] });
    const short = rectRoom({ id: 'f2', elevation: 300, h: 240, columns: [colB] });
    const r = buildBuildingShell([tall, short], { roof: { kind: 'flat' } });
    const boxes = r.boxes.filter((b) => b.kind === 'column');
    assert(boxes.length === 2, `应为 2 根，实际 ${boxes.length}`);
    const heights = boxes.map((b) => b.sy).sort((a, b) => a - b);
    near(heights[0], 240, 1e-9, '矮墙层的柱高');
    near(heights[1], 320, 1e-9, '高墙层的柱高');
    return '240 / 320';
  });

  check('c11 options.columns === false 关掉（实时预览省 mesh）', () => {
    const r = buildBuildingShell([rectRoom({ columns: [colA, colB] })], { roof: { kind: 'flat' }, columns: false });
    assert(r.boxes.filter((b) => b.kind === 'column').length === 0, '关掉后应为 0');
    assert(r.stats.columns === 0, 'stats 也要是 0');
    return '2 → 0';
  });

  check('c12 非法柱被跳过且不抛错（size 0 / 缺坐标）', () => {
    const r = buildBuildingShell(
      [rectRoom({ columns: [{ id: 'bad1', size: 0 }, { id: 'bad2', x: 10, y: 10, size: 0 }, colA] })],
      { roof: { kind: 'flat' } },
    );
    // size:0 会被夹到 15（合法），缺坐标的那根必须被丢掉
    const boxes = r.boxes.filter((b) => b.kind === 'column');
    assert(boxes.length === 2, `应有 2 根（一根被丢），实际 ${boxes.length}`);
    return '缺坐标的丢了';
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
