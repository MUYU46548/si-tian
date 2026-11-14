#!/usr/bin/env node
/**
 * Node 单元测试：家具平面符号（src/renderer/src/interior/furnitureSymbols.js）
 *
 * 这块守的是"一眼能认出是什么"：床要有两只枕头、桌要有四条腿、柜要能看出双开门、
 * 线宽要随缩放反比（屏幕上恒定 1px 左右）。纯绘制用假 ctx 记调用，不需要 canvas。
 *
 * 用法：node scripts/tests/unit/test_furniture_symbols.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'interior', 'furnitureSymbols.js');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }

/** 假 ctx：记录所有绘制调用与线宽 */
function fakeCtx() {
  const ops = [];
  const widths = [];
  const rec = (name) => (...args) => { ops.push({ name, args }); };
  const ctx = {
    ops,
    widths,
    fillStyle: '',
    strokeStyle: '',
    lineJoin: '',
    _lineWidth: 1,
    get lineWidth() { return this._lineWidth; },
    set lineWidth(v) { this._lineWidth = v; widths.push(v); },
    save: rec('save'),
    restore: rec('restore'),
    beginPath: rec('beginPath'),
    closePath: rec('closePath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    rect: rec('rect'),
    arc: rec('arc'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    fillRect: rec('fillRect'),
    quadraticCurveTo: rec('quadraticCurveTo'),
    count(name) { return ops.filter((o) => o.name === name).length; },
  };
  return ctx;
}

async function main() {
  const mod = await import('data:text/javascript;base64,'
    + Buffer.from(fs.readFileSync(SRC, 'utf8'), 'utf8').toString('base64'));
  const { drawFurnitureSymbol, SYMBOL_TYPES } = mod;

  check('f1 每种类型都画得出来、不抛（含未知类型回退通用）', () => {
    const all = [...SYMBOL_TYPES, 'sofa', '不存在的类型', undefined];
    for (const type of all) {
      const ctx = fakeCtx();
      const ok = drawFurnitureSymbol(ctx, { width: 200, height: 150, type }, { zoom: 1 });
      assert(ok === true, `类型 ${type} 应返回 true`);
      assert(ctx.count('restore') >= 1, `类型 ${type} 必须 restore（否则画布状态被污染）`);
    }
    assert(SYMBOL_TYPES.includes('bed') && SYMBOL_TYPES.includes('table'), '至少要有床和桌');
    return `${all.length} 种`;
  });

  check('f2 尺寸非法（0 / 负 / NaN）：不画、不抛、返回 false', () => {
    for (const bad of [{ width: 0, height: 100 }, { width: -5, height: 100 }, { width: NaN, height: 100 }, {}]) {
      const ctx = fakeCtx();
      assert(drawFurnitureSymbol(ctx, bad, { zoom: 1 }) === false, `${JSON.stringify(bad)} 应返回 false`);
      assert(ctx.ops.length === 0, '不该产生任何绘制调用');
    }
    return '4 种坏尺寸';
  });

  check('f3 床：床垫 + 两只枕头（枕头用白底描边，跟床身分开）', () => {
    const ctx = fakeCtx();
    drawFurnitureSymbol(ctx, { width: 200, height: 150, type: 'bed' }, { zoom: 1 });
    // 床垫 1 个 roundRect（由 moveTo/quadraticCurveTo 拼）+ 枕头 2 个 = 三次 fill
    assert(ctx.count('fill') >= 3, `床至少 3 次 fill（床垫+2 枕），实际 ${ctx.count('fill')}`);
    // 被子折线：一条独立 stroke
    assert(ctx.count('stroke') >= 3, `床至少 3 次 stroke，实际 ${ctx.count('stroke')}`);
    return `fill ${ctx.count('fill')} / stroke ${ctx.count('stroke')}`;
  });

  check('f4 桌：四条腿（4 个 fillRect）', () => {
    const ctx = fakeCtx();
    drawFurnitureSymbol(ctx, { width: 140, height: 80, type: 'table' }, { zoom: 1 });
    assert(ctx.count('fillRect') === 4, `桌子应画 4 条腿，实际 ${ctx.count('fillRect')}`);
    return '4 条腿';
  });

  check('f5 柜：中缝竖线 + 两个把手（2 个 arc）', () => {
    const ctx = fakeCtx();
    drawFurnitureSymbol(ctx, { width: 120, height: 60, type: 'chest' }, { zoom: 1 });
    assert(ctx.count('arc') === 2, `柜子把手应为 2 个，实际 ${ctx.count('arc')}`);
    assert(ctx.count('moveTo') >= 1 && ctx.count('lineTo') >= 1, '应有中缝竖线');
    return '双开门 + 2 把手';
  });

  check('f6 线宽随 zoom 反比：放大 2 倍时同一条线只占一半世界宽度', () => {
    const a = fakeCtx();
    drawFurnitureSymbol(a, { width: 200, height: 150, type: 'bed' }, { zoom: 1 });
    const b = fakeCtx();
    drawFurnitureSymbol(b, { width: 200, height: 150, type: 'bed' }, { zoom: 2 });
    const minA = Math.min(...a.widths);
    const minB = Math.min(...b.widths);
    assert(Math.abs(minB * 2 - minA) < 1e-9, `zoom=2 的线宽应是 zoom=1 的一半（${minB} vs ${minA}）`);
    assert(minA > 0 && minB > 0, '线宽必须为正');
    return `zoom1 ${minA} / zoom2 ${minB}`;
  });

  check('f7 区域类不在符号表里（院落/园林/水池仍走半透明虚线）', () => {
    for (const area of ['courtyard', 'garden', 'corridor', 'pond', 'wall']) {
      assert(!SYMBOL_TYPES.includes(area), `${area} 应是区域类型，不该进符号表`);
    }
    return '5 类区域不在表内';
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
