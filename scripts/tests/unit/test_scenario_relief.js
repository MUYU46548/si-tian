#!/usr/bin/env node
/**
 * Node 单元测试：剧本视图「地形浮雕底 + 政治水洗 + 三级线宽」（2026-11-03）
 *
 * 为什么要有这一层：浮雕/水洗是**观感**改动，浏览器里的像素判据容易被取景、标签位置干扰
 * （实测同一个"省心补丁"在两次截图里对不上）。真正能钉死的接线判据是**假 ctx 记账**：
 *   · `drawBackgroundLayer` 在 `view.showRelief` 为真时**必须** drawImage 一次浮雕栅格，
 *     为假时**一次都不许**（否则关不掉）；
 *   · `drawProvincesLayer` 的填色与同色缝描边**都**要吃 `view.politicalWash`
 *     （只改填色不改描边 → 浮雕上浮出一圈实色边）；
 *   · 海岸线 1.6px（三级线宽里最重的一级）+ 省界常量 0.7。
 *
 * 用法：node scripts/tests/unit/test_scenario_relief.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const LAYERS = path.join(ROOT, 'src', 'renderer', 'src', 'scenario', 'layers');

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** 记账用假 ctx：只记调用顺序 + 调用瞬间的 alpha / lineWidth / 颜色 */
function makeCtx() {
  const calls = [];
  const ctx = {
    calls,
    globalAlpha: 1,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    _rec(name, args) {
      calls.push({ name, args, alpha: ctx.globalAlpha, lineWidth: ctx.lineWidth, fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle });
    },
    save() { calls.push({ name: 'save', alpha: ctx.globalAlpha }); },
    restore() { calls.push({ name: 'restore' }); },
    fillRect(...a) { this._rec('fillRect', a); },
    drawImage(...a) { this._rec('drawImage', a); },
    beginPath() { this._rec('beginPath', []); },
    moveTo(...a) { this._rec('moveTo', a); },
    lineTo(...a) { this._rec('lineTo', a); },
    stroke(...a) { this._rec('stroke', a); },
    fill(...a) { this._rec('fill', a); },
    setLineDash(...a) { this._rec('setLineDash', a); },
    clip(...a) { this._rec('clip', a); },
  };
  return ctx;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-relief-'));
  fs.cpSync(LAYERS, path.join(tmp, 'layers'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const B = await import(pathToFileURL(path.join(tmp, 'layers', 'background.js')).href);
  const P = await import(pathToFileURL(path.join(tmp, 'layers', 'provinces.js')).href);
  const C = await import(pathToFileURL(path.join(tmp, 'layers', 'coast.js')).href);

  const raster = { canvas: { fake: 'relief-canvas' }, minX: -10, minY: -20, w: 400, h: 300 };
  const bgView = (over) => Object.assign({
    w: 800, h: 600, px: (v) => v, screenToWorld: (x, y) => ({ x, y }), GRID_STEP: 120,
    baseMap: { terrain: [] }, showRelief: true, reliefRaster: () => raster,
  }, over || {});

  check('c1 浮雕：showRelief 为真 → 先铺底色、再 drawImage 浮雕、最后画网格', () => {
    const ctx = makeCtx();
    B.drawBackgroundLayer(ctx, bgView());
    const names = ctx.calls.map(c => c.name);
    const iFill = names.indexOf('fillRect');
    const iImg = names.indexOf('drawImage');
    const iGrid = names.indexOf('stroke');
    assert(iFill >= 0, '底色没画（fillRect 缺失）');
    assert(iImg > iFill, '浮雕必须在底色之后（否则被底色盖住）');
    assert(iGrid > iImg, '网格必须在浮雕之后（网格是叠加层）');
    const img = ctx.calls[iImg];
    assert(img.args[0] === raster.canvas, 'drawImage 的第一个参数必须是浮雕 canvas');
    assert(img.args[1] === -10 && img.args[2] === -20 && img.args[3] === 400 && img.args[4] === 300,
      `浮雕贴图矩形不对：${JSON.stringify(img.args.slice(1))}`);
    return 'fillRect → drawImage → 网格';
  });

  check('c2 浮雕：showRelief 为假 / 没有 reliefRaster → 一次都不许 drawImage', () => {
    for (const view of [bgView({ showRelief: false }), bgView({ reliefRaster: undefined }), bgView({ reliefRaster: () => null })]) {
      const ctx = makeCtx();
      B.drawBackgroundLayer(ctx, view);
      const imgs = ctx.calls.filter(c => c.name === 'drawImage');
      assert(imgs.length === 0, `不该画浮雕却画了 ${imgs.length} 次（${JSON.stringify(Object.keys(view))}）`);
    }
    return 'ok';
  });

  check('c3 浮雕：reliefRaster 抛异常也不许把整帧带走（防御）', () => {
    const ctx = makeCtx();
    B.drawBackgroundLayer(ctx, bgView({ reliefRaster: () => { throw new Error('boom'); } }));
    assert(ctx.calls.some(c => c.name === 'fillRect'), '底色都没画');
    assert(ctx.calls.filter(c => c.name === 'stroke').length > 0, '网格没画（异常把后面带走了）');
    return '异常被吞，底色与网格照画';
  });

  const provView = (over) => Object.assign({
    baseMap: { terrain: [{ id: 'p1' }] },
    rawTerrain: () => [{ id: 'p1' }],
    rawProvOf: () => ({ id: 'p1', kind: 'land' }),
    provincePathFor: () => ({ fake: 'path' }),
    getProvinceColor: () => '#ff0000',
    timeline: { scenarios: [] },
    eraIndex: 0, date: { y: 1, m: null, d: null }, mode: 'view',
    rasterLayer: 'landsea', px: (v) => v, altStraight: false, politicalWash: 0.42,
  }, over || {});

  check('c4 水洗：填色吃 politicalWash（0.42），同色缝描边也必须吃同一个值', () => {
    const ctx = makeCtx();
    P.drawProvincesLayer(ctx, provView(), { fills: true });
    const f = ctx.calls.find(c => c.name === 'fill');
    const s = ctx.calls.find(c => c.name === 'stroke');
    assert(f, '没有填色');
    assert(Math.abs(f.alpha - 0.42) < 1e-6, `填色 alpha 应为 0.42，实测 ${f.alpha}`);
    assert(s, '没有同色缝描边');
    assert(Math.abs(s.alpha - 0.42) < 1e-6, `缝描边 alpha 应为 0.42（否则浮雕上浮出一圈实色边），实测 ${s.alpha}`);
    return 'fill/stroke 都是 0.42';
  });

  check('c5 水洗：没有浮雕（politicalWash=1）时保持旧口径 —— 不透明填色', () => {
    const ctx = makeCtx();
    P.drawProvincesLayer(ctx, provView({ politicalWash: 1 }), { fills: true });
    const f = ctx.calls.find(c => c.name === 'fill');
    assert(f && f.alpha === 1, `无浮雕时应不透明，实测 ${f && f.alpha}`);
    return 'alpha=1';
  });

  check('c6 三级线宽：政治档海岸线 1.6px（最重一级），浅海光带 5px', () => {
    const widths = [];
    const view = {
      rasterLayer: 'landsea', w: 800, h: 600, px: (v) => v,
      screenToWorld: (x, y) => ({ x, y }),
      getSeaDetail: () => ({ isobaths: [], coasts: [[{ x: 0, y: 0 }, { x: 10, y: 10 }]] }),
      polylineInView: () => true,
      strokeWorldPolyline: (c) => { widths.push(c.lineWidth); },
    };
    const ctx = makeCtx();
    C.drawPoliticalCoastLayer(ctx, view);
    assert(widths.length === 2, `应画两遍（浅海光带 + 海岸线），实测 ${widths.length}`);
    assert(widths[0] === 5, `浅海光带应 5px，实测 ${widths[0]}`);
    assert(widths[1] === 1.6, `海岸线应 1.6px（三级最重），实测 ${widths[1]}`);
    return `5px 带 + 1.6px 岸线`;
  });

  check('c7 源码守卫：省界线宽常量 = 0.7（三级里最细的一级）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'components', 'ScenarioMap.vue'), 'utf8');
    const m = /const PROVINCE_BORDER_PX = ([\d.]+)\)?/.exec(src);
    assert(m, '找不到 PROVINCE_BORDER_PX');
    assert(Number(m[1]) === 0.7, `省界应为 0.7，实测 ${m[1]}`);
    return `PROVINCE_BORDER_PX=${m[1]}`;
  });

  const failed = results.filter(r => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  —— ' + r.detail : ''}`);
  console.log(`\n=== 浮雕/水洗 ${results.length - failed.length}/${results.length} 通过 ===`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
