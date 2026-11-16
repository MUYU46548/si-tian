#!/usr/bin/env node
/**
 * Node 单元测试：省色块整幅位图（`src/renderer/src/scenario/provinceFillBake.js`）
 *
 * 为什么要有它（规模刀 2：1 万/2 万省压测）：
 *   适屏档每帧画 N 个省 = 每省一次 fill + 一次同色 stroke，1 万省实测 292ms/帧、2 万省 646ms/帧。
 *   位图化是唯一能把它拉回 60fps 的路（EU4 也这么画：省图是位图 + 颜色查找）。
 *   但位图一旦**该换没换**，屏幕上的就是上一版颜色 —— 这类缺陷用户不会怀疑缓存，
 *   只会觉得“这图怎么不对”。所以本用例守的是**失效口径**，不是速度：
 *
 *   ① 世界包围盒按 terrain 数组引用缓存（同一数组 → 同一个 rect 对象，不重复扫点）；
 *   ② 省数不到门槛 / 过渡态 / 开关关掉 → 一律不烘（返回 null，退回逐省矢量）；
 *   ③ 同一份数据连叫两次 → **不重烘**（`bakes` 计数不动，返回同一个槽）；
 *   ④ 换剧本对象 / 换日期 / 开群系图层 / 换地形数组 → **必须重烘**；
 *   ⑤ 放大超过位图精度（`scale > needPpu * 1.05`）→ 不烘（这时逐省矢量更清楚）。
 *
 * 用法：node scripts/tests/unit/test_province_fill_bake.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MOD = path.join(ROOT, 'src', 'renderer', 'src', 'scenario', 'provinceFillBake.js');

let failures = 0;
function ok(name, cond, extra) {
  if (cond) { console.log('✓ ' + name); return; }
  failures += 1;
  console.log('✗ ' + name + (extra ? '  —— ' + extra : ''));
}

/** 极简 canvas 桩：只统计调用，不做任何绘制 */
function makeCanvasStub(calls) {
  const ctx = {
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
    setTransform() { calls.push('setTransform'); },
    save() { calls.push('save'); }, restore() { calls.push('restore'); },
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    fill() { calls.push('fill'); }, stroke() { calls.push('stroke'); },
    clip() {}, setLineDash() {},
  };
  return {
    width: 0, height: 0,
    getContext() { return ctx; },
  };
}

function fakeTerrain(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const cx = i % 100, cy = Math.floor(i / 100);
    out.push({
      id: 'p' + i, points: [
        { x: cx, y: cy }, { x: cx + 1, y: cy }, { x: cx + 1, y: cy + 1 }, { x: cx, y: cy + 1 },
      ],
    });
  }
  return out;
}

(async () => {
  const M = await import(pathToFileURL(MOD).href);

  // ── ① 世界包围盒：按数组引用缓存 ──────────────────────────────────────
  const t1 = fakeTerrain(9);
  const r1 = M.provinceWorldRect(t1);
  const r2 = M.provinceWorldRect(t1);
  ok('① 包围盒算对了', r1 && r1.minX === 0 && r1.minY === 0 && r1.w === 9 && r1.h === 1, JSON.stringify(r1));
  ok('① 同一数组 → 同一个 rect 对象（不重复扫点）', r1 === r2);
  ok('① 另一份数组 → 重新算', M.provinceWorldRect(fakeTerrain(9)) !== r1);
  ok('① 空数组 → null', M.provinceWorldRect([]) === null);

  // ── ② 资格判据 ────────────────────────────────────────────────────────
  // ⚠️ timeline / 剧本对象必须**跨调用复用**：真实路径里 `view.timeline` 是 computed 的稳定引用，
  //    每次新造一个对象等于“数据变了” → 一定会重烘（用例要模拟真实引用，不是模拟“每帧新对象”）。
  const sc0 = { id: 'sc', ownership: {}, polities: [] };
  const tl0 = { scenarios: [sc0] };
  const view = (over) => Object.assign({
    baseMapKey: 'bm', cameraScale: 1, eraIndex: 0, date: { y: 1300 },
    diffMode: 'eu4', rasterLayer: 'landsea', mode: 'scenario', politicalWash: 0.42,
    showBiomes: false, selectedScenario: null, eraFade: null, timeline: tl0,
  }, over || {});

  const big = fakeTerrain(2000);
  ok('② 省数不够（默认 2000）→ 不烘', M.provinceFillBitmap(view(), fakeTerrain(1999), () => {}) === null);
  ok('② 过渡态 → 不烘', M.provinceFillBitmap(view({ eraFade: { t: 0.4 } }), big, () => {}) === null);
  ok('② 导出/切片（snapshot）→ 不烘（矢量精度优先）', M.provinceFillBitmap(view({ forExport: true }), big, () => {}) === null);

  global.window = {};
  window.__SITIAN_PROV_BITMAP__ = false;
  ok('② 开关关掉 → 不烘', M.provinceFillBitmap(view(), big, () => {}) === null);
  window.__SITIAN_PROV_BITMAP__ = true;          // 强制开（但 Node 里没有 document）

  // ── ③/④ 烘焙与失效（需要 document 桩）────────────────────────────────
  const calls = [];
  const created = [];
  global.document = {
    createElement() { const c = makeCanvasStub(calls); created.push(c); return c; },
  };
  window.__SITIAN_PROV_BITMAP_MIN__ = 0;

  M.resetProvinceFillBitmap();
  const b1 = M.provinceFillBitmap(view(), big, (ctx, shim) => {
    // 烘焙时 px() 必须换成“烘焙分辨率下的像素”
    if (Math.abs(shim.px(1) - 1 / (shim.cameraScale || 1)) > 1e-9) calls.push('bad-px');
    calls.push('paint');
  });
  ok('③ 该烘的时候烘出来了', !!b1 && b1.canvas instanceof Object);
  ok('③ 烘焙宽度按 128 一档（1024 或以上）', b1.canvas.width >= 512, String(b1.canvas.width));
  ok('③ 画法真的跑了一遍', calls.includes('paint'));
  ok('③ 烘焙时 px() 用的是烘焙分辨率', !calls.includes('bad-px'));
  const bakes1 = window.__SITIAN_PROV_BITMAP_STAT__.bakes;

  // 放大一档（scale 1.6×）→ 仍复用（容忍 1.33 倍拉伸），不许整幅重烘
  const b2 = M.provinceFillBitmap(view({ cameraScale: 1.6 }), big, () => { calls.push('paint2'); });
  ok('③ 同一份数据 + 放大一档 → 不重烘（容忍拉伸复用）', b2 === b1);
  ok('③ 同一份数据再叫 → bakes 计数不动', window.__SITIAN_PROV_BITMAP_STAT__.bakes === bakes1);
  ok('③ 同一份数据再叫 → 画法没再跑', !calls.includes('paint2'));

  // 换剧本对象（= 归属编辑后的新对象）→ 必须重烘
  const sc2 = { id: 'sc', ownership: { p0: 'f1' }, polities: [] };
  const tl2 = { scenarios: [sc2] };   // 同上：跨调用复用，才能测“同数据不重烘”
  const b3 = M.provinceFillBitmap(view({ timeline: tl2 }), big, () => { calls.push('paint3'); });
  ok('④ 换剧本对象 → 重烘', b3 !== b1 && calls.includes('paint3'));

  // 换日期（时间轴拖动）→ 必须重烘
  const bakesBeforeDate = window.__SITIAN_PROV_BITMAP_STAT__.bakes;
  M.provinceFillBitmap(view({ date: { y: 1310 }, timeline: tl2 }), big, () => { calls.push('paint4'); });
  ok('④ 换日期 → 重烘', window.__SITIAN_PROV_BITMAP_STAT__.bakes === bakesBeforeDate + 1 && calls.includes('paint4'));

  // 开群系图层（取色口径变了）→ 必须重烘
  const bakesBeforeBiome = window.__SITIAN_PROV_BITMAP_STAT__.bakes;
  M.provinceFillBitmap(view({ showBiomes: true, date: { y: 1310 }, timeline: tl2 }), big, () => { calls.push('paint5'); });
  ok('④ 开群系图层 → 重烘', window.__SITIAN_PROV_BITMAP_STAT__.bakes === bakesBeforeBiome + 1 && calls.includes('paint5'));

  // 换地形数组（涂抹/撤销换引用）→ 必须重烘
  const big2 = fakeTerrain(2000);
  const bakesBeforeTerrain = window.__SITIAN_PROV_BITMAP_STAT__.bakes;
  M.provinceFillBitmap(view({ showBiomes: true, date: { y: 1310 }, timeline: tl2 }), big2, () => { calls.push('paint6'); });
  ok('④ 换地形数组 → 重烘', window.__SITIAN_PROV_BITMAP_STAT__.bakes === bakesBeforeTerrain + 1 && calls.includes('paint6'));

  // ── ⑤ 放大超过位图精度 → 不烘 ─────────────────────────────────────────
  const far = view({ cameraScale: 40, showBiomes: true, date: { y: 1310 }, timeline: tl2 });
  ok('⑤ 放大超过位图精度 → 不烘（退回逐省矢量）', M.provinceFillBitmap(far, big2, () => { calls.push('paint7'); }) === null);
  ok('⑤ 这一档一次都没画', !calls.includes('paint7'));

  // ── 反证：键里漏掉某个取色输入就会“假命中” ───────────────────────────
  // 关掉群系后，键必须与“开着群系”那张不同 —— 否则重新打开图层时屏幕上是旧颜色
  const bakesBeforeOff = window.__SITIAN_PROV_BITMAP_STAT__.bakes;
  M.provinceFillBitmap(view({ showBiomes: false, date: { y: 1310 }, timeline: tl2 }), big2, () => { calls.push('paint8'); });
  ok('反证：关掉群系图层也会重烘（键含该开关）', window.__SITIAN_PROV_BITMAP_STAT__.bakes === bakesBeforeOff + 1 && calls.includes('paint8'));
  // 放大到超过 1.5 倍拉伸 → 交给逐省矢量，**不许再重烘**（重烘 284ms，矢量只要 28~69ms）
  const bakesBeforeZoom = window.__SITIAN_PROV_BITMAP_STAT__.bakes;
  const far2 = view({ cameraScale: 10, date: { y: 1310 }, timeline: tl2 });
  ok('④ 放大超过 1.5 倍拉伸 → 返回 null（走逐省矢量）', M.provinceFillBitmap(far2, big2, () => { calls.push('paint9'); }) === null);
  ok('④ 这一档也没有重烘（bakes 不动、画法没跑）',
     window.__SITIAN_PROV_BITMAP_STAT__.bakes === bakesBeforeZoom && !calls.includes('paint9'));

  delete global.document;
  delete global.window;

  console.log('\n=== 省色块位图 ' + (failures === 0 ? '全通过' : (failures + ' 条失败')) + ' ===');
  process.exit(failures === 0 ? 0 : 1);
})();
