#!/usr/bin/env node
/**
 * Node 单元测试：房间材质目录 + 多边形三角化（A23/A15 的纯函数底座，2026-11-15）
 *
 * 为什么必须有这一层：
 *   · 材质色表要同时喂 2D 填充、纹理线、3D 材质和 UI 下拉 —— 四处各写一份必然漂移；
 *   · 3D 里"每个房间铺一块面"要把多边形切成三角面，**凹形房间**用包围盒近似会铺到隔壁去。
 * 这两个模块都是纯函数，所以判据可以完全脱离浏览器（着色对不对靠留证图看，这里守数学与口径）。
 *
 * 用法：node scripts/tests/unit/test_room_materials.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 */
'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'interior');

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => { results.push({ name, ok: true, detail: detail || '' }); })
    .catch((err) => { results.push({ name, ok: false, detail: err && err.message ? err.message : String(err) }); });
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function near(actual, expected, tol, label) {
  if (!(Math.abs(actual - expected) <= tol)) throw new Error(`${label}: 期望 ${expected} ± ${tol}，实际 ${actual}`);
}

const TMP_CANDIDATES = [
  process.env.SITIAN_TEST_TMP, process.env.TEMP, process.env.TMP,
  (() => { try { return os.tmpdir(); } catch (e) { return ''; } })(),
  path.join(os.homedir(), 'AppData', 'Local', 'Temp'),
].filter(Boolean);

let TMP = '';
async function resolveTmpRoot() {
  const tried = [];
  for (const base of TMP_CANDIDATES) {
    const dir = path.join(base, `sitian-materials-${Date.now()}-${Math.floor(Math.random() * 1e4)}`);
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, '.write-probe'), 'ok', 'utf-8');
      await fsp.unlink(path.join(dir, '.write-probe'));
      TMP = dir;
      return;
    } catch (e) { tried.push(`${base} → ${e.code || e.message}`); }
  }
  throw new Error('找不到可写的临时目录。候选：' + tried.join(' | '));
}

/** 复制被测算例到临时目录（`{\"type\":\"module\"}`）再 import —— 同 test_project_size.js */
async function importModules() {
  const dir = path.join(TMP, 'mods');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');
  for (const f of ['floorPatterns.js', 'triangulate.js']) {
    const body = fs.readFileSync(path.join(SRC, f), 'utf8')
      .replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
    await fsp.writeFile(path.join(dir, f), body, 'utf-8');
  }
  return {
    P: await import(pathToFileURL(path.join(dir, 'floorPatterns.js')).href),
    T: await import(pathToFileURL(path.join(dir, 'triangulate.js')).href),
  };
}

const HEX = /^#[0-9a-f]{6}$/i;

function brightness(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return NaN;
  const v = parseInt(m[1], 16);
  return 0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255);
}

async function main() {
  await resolveTmpRoot();
  const { P, T } = await importModules();

  // ── 目录与规整 ────────────────────────────────────────────────
  await check('a. 材质目录：id 唯一、none 在首位、每个都有中文名与 3D 色', async () => {
    const ids = P.FLOOR_TEXTURES.map((t) => t.id);
    eq(new Set(ids).size, ids.length, '地面材质 id 必须唯一');
    eq(ids[0], 'none', '首个必须是 none（默认值）');
    assert(ids.length >= 5, `地面材质太少：${ids.length}`);
    for (const t of P.FLOOR_TEXTURES) {
      assert(typeof t.label === 'string' && t.label.length > 0, `材质 ${t.id} 缺中文名`);
      if (t.id === 'none') continue;
      assert(HEX.test(t.base), `材质 ${t.id} 的底色不是 #rrggbb：${t.base}`);
      assert(HEX.test(t.line), `材质 ${t.id} 的线色不是 #rrggbb：${t.line}`);
      assert(HEX.test(P.floorTextureThree(t.id)), `材质 ${t.id} 的 3D 色不合法`);
    }
    const cids = P.CEILING_TEXTURES.map((t) => t.id);
    eq(cids[0], 'none', '吊顶首个必须是 none');
    for (const t of P.CEILING_TEXTURES) assert(HEX.test(t.id === 'none' ? '#ffffff' : P.ceilingTextureThree(t.id)), `吊顶 ${t.id} 缺 3D 色`);
    return `${ids.join(' / ')} · 吊顶 ${cids.join(' / ')}`;
  });

  await check('b. normalizeFloorTexture：认识的原样、不认识的回落 wood', async () => {
    eq(P.normalizeFloorTexture('tile'), 'tile', 'tile');
    eq(P.normalizeFloorTexture('wood'), 'wood', 'wood');
    eq(P.normalizeFloorTexture(''), 'wood', '空串');
    eq(P.normalizeFloorTexture('marble'), 'wood', '未知值');
    eq(P.normalizeFloorTexture(null), 'wood', 'null');
    eq(P.floorTextureOf('marble').id, 'wood', 'floorTextureOf 未知值也要给 wood');
    return '4 条回落口径一致';
  });

  await check('c. normalizeCeiling：none 不生成对象、高度夹在 200~800、缺省 260', async () => {
    eq(P.normalizeCeiling(null), null, 'null');
    eq(P.normalizeCeiling({ texture: 'none' }), null, 'none');
    eq(P.normalizeCeiling({ texture: 'plaster', height: 240 }).height, 240, '正常高度');
    eq(P.normalizeCeiling({ texture: 'plaster', height: 50 }).height, P.CEILING_MIN_CM, '过矮');
    eq(P.normalizeCeiling({ texture: 'plaster', height: 9999 }).height, P.CEILING_MAX_CM, '过高');
    eq(P.normalizeCeiling({ texture: 'plaster' }).height, 260, '缺高度');
    eq(P.normalizeCeiling({ texture: '瞎写' }).texture, 'plaster', '未知材质回落石膏板');
    eq(P.normalizeCeiling({ texture: 'wood', height: '235.6' }).height, 236, '字符串高度取整');
    return '7 条规整口径一致';
  });

  // ── 纹理线 ────────────────────────────────────────────────────
  await check('d. 纹理线：确定性（两次同一结果）+ 木地板横缝按 18cm 排', async () => {
    const rect = { minX: 0, minY: 0, maxX: 300, maxY: 180 };
    const a = P.floorPatternSegments('wood', rect);
    const b = P.floorPatternSegments('wood', rect);
    assert(a.length === b.length && JSON.stringify(a) === JSON.stringify(b), '两次生成的纹理线不一致（有随机源）');
    const horizontals = a.filter((s) => Math.abs(s.y1 - s.y2) < 1e-9);
    // 边界上不画线（画了会和墙线叠成一条粗黑线）：120/30 → 3 条，180/18 → 9 条
    eq(horizontals.length, Math.ceil(180 / 18) - 1, '木地板横缝条数');
    const verticals = a.filter((s) => Math.abs(s.x1 - s.x2) < 1e-9);
    assert(verticals.length > 0, '木地板应有板端竖缝');
    return `${a.length} 条线（横 ${horizontals.length} / 竖 ${verticals.length}）`;
  });

  await check('e. 纹理线：瓷砖横竖都排、none 不产生线、非法矩形返回空', async () => {
    const rect = { minX: -60, minY: -60, maxX: 60, maxY: 60 };
    const segs = P.floorPatternSegments('tile', rect);
    const h = segs.filter((s) => Math.abs(s.y1 - s.y2) < 1e-9).length;
    const v = segs.filter((s) => Math.abs(s.x1 - s.x2) < 1e-9).length;
    eq(h, 3, '瓷砖横缝（120/30 − 1）');
    eq(v, 3, '瓷砖竖缝');
    eq(P.floorPatternSegments('none', rect).length, 0, 'none 不应有线');
    eq(P.floorPatternSegments('wood', { minX: 5, minY: 5, maxX: 5, maxY: 5 }).length, 0, '零面积矩形');
    eq(P.floorPatternSegments('wood', null).length, 0, 'null 矩形');
    return `瓷砖 ${h}+${v} 条；非法入参全部空数组`;
  });

  await check('f. 巨大的房间：线数被上限挡住（不会画十万条）', async () => {
    const rect = { minX: 0, minY: 0, maxX: 20000, maxY: 20000 };
    const segs = P.floorPatternSegments('carpet', rect, { maxLines: 500 });
    assert(segs.length <= 600, `线数失控：${segs.length}`);
    assert(segs.length > 0, '不该一条都不画');
    return `20000×20000cm 地毯 → ${segs.length} 条（上限 500）`;
  });

  await check('g. 2D 配色：打印态比深色主题更亮（纸上不压墙线）', async () => {
    for (const t of P.FLOOR_TEXTURES) {
      if (t.id === 'none') continue;
      const dark = P.floorTextureCss(t.id, 'dark');
      const print = P.floorTextureCss(t.id, 'print');
      assert(HEX.test(dark) && HEX.test(print), `${t.id} 的 2D 色不合法`);
      assert(brightness(print) > brightness(dark), `${t.id} 打印态没有变亮：${dark} → ${print}`);
    }
    eq(P.floorTextureCss('none', 'dark'), '', 'none 不该有底色（走主题原色）');
    return '5 种材质打印态全部变亮';
  });

  // ── 三角化 ────────────────────────────────────────────────────
  await check('h. 三角化：矩形 → 2 个三角形，面积和等于原面积', async () => {
    const poly = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }];
    const tris = T.earClip(poly);
    eq(tris.length, 2, '三角形个数');
    near(T.trianglesArea(tris), T.polygonAreaOf(poly), 1e-6, '面积和');
    return `${tris.length} 个三角形 / ${T.polygonAreaOf(poly)} cm²`;
  });

  await check('i. 三角化：L 形凹多边形不丢面积、不改形状（包围盒近似会多铺一块）', async () => {
    // L 形：600×600 的方块挖掉右下 300×300
    const poly = [
      { x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 300 },
      { x: 300, y: 300 }, { x: 300, y: 600 }, { x: 0, y: 600 },
    ];
    const tris = T.earClip(poly);
    eq(tris.length, poly.length - 2, '三角形个数应为 n−2');
    const area = T.polygonAreaOf(poly);
    near(T.trianglesArea(tris), area, 1e-6, '面积和');
    const bboxArea = 600 * 600;
    assert(area < bboxArea - 1, 'L 形面积应小于包围盒（判据本身要能区分）');
    return `6 边形 → ${tris.length} 个三角形 / 面积 ${area}（包围盒 ${bboxArea}）`;
  });

  await check('j. 三角化：顺时针输入、首尾重复点、脏点都能处理', async () => {
    const cw = [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 0 }];
    eq(T.earClip(cw).length, 2, '顺时针矩形');
    near(T.trianglesArea(T.earClip(cw)), 10000, 1e-6, '顺时针面积');
    const closed = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 0 }];
    eq(T.earClip(closed).length, 1, '首尾重复 → 三角形');
    eq(T.earClip([{ x: 0, y: 0 }, { x: 1, y: 1 }]).length, 0, '两点不成面');
    eq(T.earClip([{ x: 0, y: 0 }, { x: NaN, y: 1 }, { x: 2, y: 2 }]).length, 0, '脏点直接放弃');
    return '4 种输入都有确定结果';
  });

  await check('k. 内缩（吊顶虚线框）：面积变小但仍是正的；缩过头返回空', async () => {
    const poly = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }];
    const small = T.insetPolygon(poly, 20);
    eq(small.length, 4, '内缩后顶点数不变');
    const a0 = T.polygonAreaOf(poly);
    const a1 = T.polygonAreaOf(small);
    assert(a1 < a0 && a1 > a0 * 0.5, `内缩后面积应明显变小：${a0} → ${a1}`);
    eq(T.insetPolygon(poly, 5000).length, 0, '缩过头应返回空（宁可不画）');
    return `${a0} → ${a1} cm²`;
  });

  // ── 汇总 ──────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '  ok  ' : ' FAIL '} ${r.name}\n         ${r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  console.log(`===房间材质 ${results.length - failed.length}/${results.length} 通过===`);
  try { await fsp.rm(TMP, { recursive: true, force: true }); } catch (e) { /* 清不掉不影响结论 */ }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error('用例自身崩了：', (e && e.stack) || e); process.exitCode = 1; });
