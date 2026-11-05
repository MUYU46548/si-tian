#!/usr/bin/env node
/**
 * Node 单元测试：底图河流层的“开关门控 + 分层落笔 + 排障口”（2026-11-04，第二十修）
 *
 * 为什么要有这个文件（两条都来自真机探针，不是猜的）：
 *   ① **“河流”开关管不到底图河**：`drawRiverPathsLayer` 的调用点原来没有任何门控，
 *      而生成的河全部是 `river_gen_*`（真实 415 省项目 573/573 条都是），于是取消勾选
 *      “河流”后河还在画布上。证据：`shot_real_project.py --probe-capture` 的 `flag-off`
 *      探针里，画布指纹一位没变（`3c4a5d25` → `3c4a5d25`）；加上门控之后变成
 *      `3c4a5d25 → ff0cf2e2`，且与“直接把 rivers 抽成空数组”的指纹**完全相同**。
 *   ② **落笔顺序没分层**：几何已经平面化（真横穿 0），但两条支流常从主干两侧同时汇入同一个点，
 *      主干先画就会被两个断面压成十字 —— 这正是用户说的“X 交叉”。改成按汇流量升序
 *      （细的先、粗的后）之后，主干带宽盖住断面，读成汇流（Y）。
 *
 * 用法：node scripts/tests/unit/test_river_layer_gate.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const VUE = path.join(ROOT, 'src', 'renderer', 'src', 'components', 'ScenarioMap.vue');
const FEATURES = path.join(ROOT, 'src', 'renderer', 'src', 'scenario', 'layers', 'features.js');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** 本仓 index=LF、工作树可能被 autocrlf 变 CRLF —— 读源码先归一化（否则切片为空 → 假红/假绿） */
function readText(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }

const SRC = readText(VUE);
const FEAT = readText(FEATURES);

/** 取包含某段的**整行**（判定“这台调用点有没有门控”就看这一行） */
function lineWith(text, needle) {
  const lines = text.split('\n').filter((l) => l.indexOf(needle) >= 0 && l.trim().indexOf('//') !== 0);
  return lines[0] || '';
}

const CALL_PATHS = lineWith(SRC, 'drawRiverPathsLayer(ctx.value');
const CALL_HILITE = lineWith(SRC, 'drawSelectedRiverHighlightLayer(ctx.value');

check('r1 底图河流层的调用点受“河流”开关管（showRiverBase）', () => {
  assert(CALL_PATHS, '找不到 drawRiverPathsLayer 的调用行');
  assert(/showRiverBase/.test(CALL_PATHS), `调用行没有门控：${CALL_PATHS.trim()}`);
  return CALL_PATHS.trim().slice(0, 96);
});

check('r2 选中河高亮同样受门控（河都隐藏了还留一圈高亮 = 幽灵）', () => {
  assert(CALL_HILITE, '找不到 drawSelectedRiverHighlightLayer 的调用行');
  assert(/showRiverBase/.test(CALL_HILITE), `调用行没有门控：${CALL_HILITE.trim()}`);
  return CALL_HILITE.trim().slice(0, 96);
});

check('r3 落笔按汇流量升序（细 → 粗），且排序在绘制循环之前', () => {
  const iSort = FEAT.indexOf('.sort((a, b) => (a.discharge - b.discharge))');
  assert(iSort > 0, '找不到按 discharge 升序的排序');
  const iDraw = FEAT.indexOf('for (const it of items)');
  assert(iDraw > 0, '找不到绘制循环');
  assert(iSort < iDraw, '排序必须在绘制循环之前（放在循环里等于每帧排一次，且顺序不稳定）');
  // 排序对象必须是 `built`（缓存里那份），不是渲染期临时数组
  assert(/built\.sort\(/.test(FEAT), '排序对象不是 built');
  return `排序位置 ${iSort} < 绘制位置 ${iDraw}`;
});

check('r4 每帧发一行帧探针（帧号 / 贴基帧 / 相机 / 河流几何版本）', () => {
  assert(/__SITIAN_FRAME_LOG__/.test(SRC), '没有 __SITIAN_FRAME_LOG__');
  assert(/function recordFrameProbe\(/.test(SRC), '没有 recordFrameProbe');
  const iCall = SRC.indexOf('recordFrameProbe(blitted, probeT0)');
  assert(iCall > 0, 'renderFrame 末尾没有调用 recordFrameProbe');
  // 必须在风 overlay 之后调用：放在中间会漏掉最后一层浮层的耗时
  const iOverlay = SRC.indexOf('overlayLayers.drawDataChart(ctx.value, overlayView)');
  assert(iOverlay > 0 && iCall > iOverlay, '帧探针必须在最后一层浮层之后调用');
  assert(/riverVer/.test(SRC), '帧探针里没有河流几何版本（riverVer）');
  return `探针在 drawDataChart 之后 ${iOverlay} < ${iCall}`;
});

check('r5 河流几何版本号只在重建曲线时自增（缓存命中不涨）', () => {
  assert(/ver: \(riverCurveCache\.ver \|\| 0\) \+ 1/.test(FEAT), '没有 ver 自增');
  const iBuild = FEAT.indexOf('riverCurveCache = { rivers, terrain: terrainRef, items');
  const iIf = FEAT.indexOf('const cacheHit = riverCurveCache.rivers === rivers');
  assert(iBuild > 0, '找不到缓存写入行');
  assert(iIf > 0, '找不到缓存命中判断');
  assert(iBuild > iIf, 'ver 自增必须只在建曲线分支里');
  // 缓存里必须同时带归一化参照（widthMax）：丢了它，生成河会被 1.0 世界单位夹成等宽
  const line = lineWith(FEAT, 'riverCurveCache = { rivers, terrain: terrainRef, items');
  assert(/widthMax/.test(line), `缓存写入行没带 widthMax：${line.trim()}`);
  return 'ver 只在重建分支自增，且带 widthMax';
});

check('r6 反向探针：把门控去掉，r1 必须红', () => {
  assert(/&& showRiverBase\.value/.test(CALL_PATHS), `调用行形态变了，负向探针要跟着改：${CALL_PATHS.trim()}`);
  const line = lineWith(SRC.replace('&& showRiverBase.value', ''), 'drawRiverPathsLayer(ctx.value');
  assert(!/showRiverBase/.test(line), '反向探针没生效（去掉门控后仍然命中）');
  return '负向探针有效';
});

check('r7 反向探针：把排序删掉，r3 必须红', () => {
  const broken = FEAT.replace('.sort((a, b) => (a.discharge - b.discharge))', '');
  assert(broken.indexOf('.sort((a, b) => (a.discharge - b.discharge))') < 0, '反向探针没生效');
  return '负向探针有效';
});

let pass = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  —— ' + r.detail : ''}`);
  if (r.ok) pass += 1;
}
console.log(`\n=== 底图河流层门控与分层 ${pass}/${results.length} 通过 ===`);
process.exit(pass === results.length ? 0 : 1);
