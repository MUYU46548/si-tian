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
    shadowBlur: 0,
    shadowColor: '',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
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
    setLineDash: rec('setLineDash'),
    count(name) { return ops.filter((o) => o.name === name).length; },
  };
  return ctx;
}

async function main() {
  const mod = await import('data:text/javascript;base64,'
    + Buffer.from(fs.readFileSync(SRC, 'utf8'), 'utf8').toString('base64'));
  const {
    drawFurnitureSymbol, SYMBOL_TYPES, registerFurnitureSymbol,
    unregisterFurnitureSymbol, listFurnitureSymbols, drawCustomShape,
  } = mod;

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

  check('f4 桌：俯视看不见腿 → 只画桌面（不许 fillRect，rect 两层：桌面 + 台面边）', () => {
    const ctx = fakeCtx();
    drawFurnitureSymbol(ctx, { width: 140, height: 80, type: 'table' }, { zoom: 1 });
    assert(ctx.count('fillRect') === 0, `桌子不该再画腿/色块（俯视被桌面挡住），实际 ${ctx.count('fillRect')} 次 fillRect`);
    assert(ctx.count('rect') === 2, `桌面 + 台面边应为 2 个 rect，实际 ${ctx.count('rect')}`);
    return '桌面 + 台面边';
  });

  check('f5 柜：俯视看不见门缝与把手 → 只能有柜体 + 台面边（0 个 arc）', () => {
    const ctx = fakeCtx();
    drawFurnitureSymbol(ctx, { width: 120, height: 60, type: 'chest' }, { zoom: 1 });
    assert(ctx.count('arc') === 0, `柜子不许画把手（立面信息），实际 ${ctx.count('arc')} 个 arc`);
    assert(ctx.count('rect') === 2, `柜体 + 台面边应为 2 个 rect，实际 ${ctx.count('rect')}`);
    return '柜顶 + 台面边';
  });

  check('f8 门：门扇 + 1/4 弧，且占位框必须是**虚线**（实线框=一块门板倒在地上）', () => {
    const ctx = fakeCtx();
    drawFurnitureSymbol(ctx, { width: 90, height: 200, type: 'door' }, { zoom: 1 });
    assert(ctx.count('arc') === 1, `门应有 1 段开合弧，实际 ${ctx.count('arc')}`);
    assert(ctx.count('rect') === 1, `占位框应 1 个 rect，实际 ${ctx.count('rect')}`);
    assert(ctx.count('setLineDash') >= 1, '占位框必须走虚线（setLineDash）');
    // 弧半径 = 洞口宽（90），不许取 max(90,200)=200（第二版的 bug：画出半径 200 的巨大弧）
    const arc = ctx.ops.find((o) => o.name === 'arc');
    assert(Math.abs(arc.args[2] - 90) < 1e-6, `弧半径应为洞口宽 90，实际 ${arc.args[2]}`);
    return '虚线占位 + 半径 90 的弧';
  });

  check('f9 符号内部必须清掉阴影（否则每条笔画都带一层，像"几层板压在一起"）', () => {
    const ctx = fakeCtx();
    ctx.shadowBlur = 8;              // 模拟调用方给的整体阴影
    drawFurnitureSymbol(ctx, { width: 200, height: 150, type: 'bed' }, { zoom: 1 });
    assert(ctx.shadowBlur === 0, `画完符号后 shadowBlur 应为 0，实际 ${ctx.shadowBlur}`);
    return 'shadowBlur → 0';
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

  check('f10 自定义符号可注册：symbolId 优先于 type，内置与自定义同一张表', () => {
    let hit = 0;
    assert(registerFurnitureSymbol('my-shelf', (ctx) => { hit++; ctx.fillRect(0, 0, 1, 1); }) === true, '注册应成功');
    assert(listFurnitureSymbols().includes('my-shelf'), '符号表应含新 id');
    const ctx = fakeCtx();
    // type 给 bed（内置），symbolId 给自定义 → 必须用自定义
    drawFurnitureSymbol(ctx, { width: 100, height: 40, type: 'bed', symbolId: 'my-shelf' }, { zoom: 1 });
    assert(hit === 1, `自定义符号应被调用 1 次，实际 ${hit}`);
    assert(ctx.count('fillRect') === 1, '画的是自定义那一个 fillRect（bed 不含 fillRect）');
    assert(unregisterFurnitureSymbol('my-shelf') === true, '注销应成功');
    assert(!listFurnitureSymbols().includes('my-shelf'), '注销后不在表里');
    return 'symbolId 生效';
  });

  check('f11 注册校验：空 id / 非函数一律拒绝（不许把符号表搞坏）', () => {
    assert(registerFurnitureSymbol('', () => {}) === false, '空 id 应拒绝');
    assert(registerFurnitureSymbol('  ', () => {}) === false, '空白 id 应拒绝');
    assert(registerFurnitureSymbol('x', null) === false, '非函数应拒绝');
    assert(registerFurnitureSymbol('x', 123) === false, '非函数应拒绝');
    assert(unregisterFurnitureSymbol('不存在') === false, '注销不存在的应返回 false');
    return '4 种非法输入';
  });

  check('f12 自定义形状：归一化坐标映射到 w×h，且优先于 type', () => {
    const ctx = fakeCtx();
    // 归一化 0..1 的三个角 → 应落在 -50..50 / -25..25 的框内
    drawFurnitureSymbol(ctx, {
      width: 100, height: 50, type: 'bed',
      custom: { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }], closed: true },
    }, { zoom: 1 });
    const moves = ctx.ops.filter((o) => o.name === 'moveTo' || o.name === 'lineTo');
    assert(moves.length === 3, `三条边应有 3 次 moveTo/lineTo，实际 ${moves.length}`);
    for (const m of moves) {
      const [x, y] = m.args;
      assert(x >= -50 - 1e-6 && x <= 50 + 1e-6, `x 越界：${x}`);
      assert(y >= -25 - 1e-6 && y <= 25 + 1e-6, `y 越界：${y}`);
    }
    assert(ctx.count('arc') === 0, '给了 custom 就不该再画床的枕头（arc）');
    // 没有 points → 不认，返回 false（调用方回落）
    assert(drawCustomShape(fakeCtx(), { points: [] }, { w: 10, h: 10, zoom: 1 }) === false, '空 points 应返回 false');
    assert(drawCustomShape(fakeCtx(), null, { w: 10, h: 10, zoom: 1 }) === false, 'null 应返回 false');
    return '3 点三角形 + 2 条回落';
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
