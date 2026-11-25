#!/usr/bin/env node
/**
 * Node 单元测试：2D 天体属性面板（2026-11-25 第七轮）
 *
 * 这一层的判据为什么只能守源码：面板本身要在真机里点（test_186 覆盖行为），
 * 但**接线漏一段**在页面上看起来只是“点了没反应”—— 礼貌、安静、极难查。
 * 所以这里钉死四条接线，并且每条都跑一遍**负向探针**（把这段删掉，判据必须变红）
 * —— 否则本文件就是一段永远通过的正则。
 *
 * 判据：
 *   ① 面板在模板里（行星属性 testid / 类型下拉分组 / 三个拾色器 / “进入行星地图”）；
 *   ② 两个写口都走 `store.updateNode`（类型 → planetClass；颜色 → planetColors）；
 *   ③ 显示值走**同一个取色口**（`paletteForClass`）与**同一个类别解析**（`planetClassForNode`）——
 *      不许在 2D 里另算一套默认色，否则 2D/3D 一定会漂；
 *   ④ 只在编辑模式开（浏览模式单击行星仍是进入行星地图），退出编辑 / 换系都收起。
 *
 * 用法：node scripts/tests/unit/test_planet_props_2d.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FILE = 'src/renderer/src/components/SystemDetailView.vue';

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** 剥注释：判据不许被注释里的示例骗过（本仓既定口径；模板注释也要剥） */
function codeOnly(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const SRC = codeOnly(fs.readFileSync(path.join(ROOT, FILE), 'utf8'));

/** 四组判据（纯函数式：传任何一份源码都能给出同一套结论，负向探针直接复用） */
function gatePanel(src) {
  const fails = [];
  if (!/data-testid="planet-props-panel"/.test(src)) fails.push('面板缺 data-testid="planet-props-panel"');
  if (!/data-testid="planet-props-class"/.test(src)) fails.push('面板缺类型下拉');
  for (const slot of ['base', 'land', 'atmo']) {
    if (!src.includes(`data-testid="planet-props-color-${slot}"`)) fails.push(`面板缺 ${slot} 拾色器`);
  }
  if (!/data-testid="planet-props-go"/.test(src)) fails.push('面板缺“进入行星地图”按钮');
  if (!/optgroup label="内置类型"/.test(src)) fails.push('类型下拉缺内置分组');
  if (!/optgroup v-if="customPlanetClasses\.length" label="本项目自定义"/.test(src)) {
    fails.push('类型下拉缺“本项目自定义”分组');
  }
  return fails;
}

function gateWrite(src) {
  const fails = [];
  if (!/store\.updateNode\(p\.id,\s*\{\s*planetClass: classId\s*\}\)/.test(src)) {
    fails.push('改类型没走 store.updateNode({ planetClass })');
  }
  if (!/store\.updateNode\(p\.id,\s*\{\s*planetColors: colors\s*\}\)/.test(src)) {
    fails.push('改颜色没走 store.updateNode({ planetColors })');
  }
  if (!/function onPlanetClassChange\(e\)/.test(src)) fails.push('缺 onPlanetClassChange');
  if (!/function onPlanetColor\(slot, e\)/.test(src)) fails.push('缺 onPlanetColor');
  if (!/renderer\.requestRender\(\)/.test(src)) fails.push('改完没有重画（面板看起来“点了没变”）');
  return fails;
}

function gateSameSource(src) {
  const fails = [];
  if (!/paletteForClass\(editPlanetClassId\.value, p\.planetColors\)/.test(src)) {
    fails.push('面板显示值没走 paletteForClass（2D/3D 会各算一套默认色）');
  }
  if (!/planetClassForNode\(editPlanet\.value,\s*\{\s*fallbackLayer: 'planet'\s*\}\)/.test(src)) {
    fails.push('面板当前类型没走 planetClassForNode（没设过类型时会显示空）');
  }
  if (!/getPlanetDisc\(classId, pxSize, planet\.planetColors\)/.test(src)) {
    fails.push('2D 圆盘没把逐颗色板传下去');
  }
  return fails;
}

function gateGate(src) {
  const fails = [];
  // 编辑模式分支：点行星 → 选中；不能连“空间站/卫星”一起收（它们没有类别/颜色语义）
  if (!/if \(editMode\.value\)\s*\{[\s\S]{0,400}?editPlanetId\.value = nextId/.test(src)) {
    fails.push('编辑模式点击没选中行星（editPlanetId 没赋值）');
  }
  if (!/hit\.node\.layer === 'planet' && !isStationNode\(hit\.node\)/.test(src)) {
    fails.push('选中条件没收紧到“非空间站的行星”');
  }
  // 浏览模式那条链**必须还在**：单击行星进入行星地图是既有手感，不许被面板改掉
  if (!/if \(hit\?\.type === 'planet'\)\s*\{\s*emit\('select-node', hit\.node\)/.test(src)) {
    fails.push('浏览模式单击行星不再进入行星地图（把既有手感改坏了）');
  }
  if (!/if \(!editMode\.value\) editPlanetId\.value = null/.test(src)) {
    fails.push('退出编辑模式没收起面板');
  }
  if (!/watch\(\(\) => props\.system\?\.id,[\s\S]{0,200}?editPlanetId\.value = null/.test(src)) {
    fails.push('换恒星系没收起面板（会指着别的系的行星）');
  }
  if (!/点行星改类型\/颜色/.test(src)) fails.push('编辑模式提示没告诉用户这里能改类型/颜色');
  return fails;
}

const GATES = [
  ['a1 面板骨架：属性面板 / 类型下拉（含自定义分组）/ 三个拾色器 / 进入行星地图',
    gatePanel, 'data-testid="planet-props-panel"'],
  ['a2 写口：类型 → planetClass、颜色 → planetColors，都走 store.updateNode 并当场重画',
    gateWrite, 'store.updateNode(p.id, { planetClass: classId })'],
  ['a3 同源：显示值走 paletteForClass、当前类型走 planetClassForNode、圆盘带逐颗色板',
    gateSameSource, 'paletteForClass(editPlanetClassId.value, p.planetColors)'],
  ['a4 闸门：只在编辑模式开；浏览模式仍单击进行星地图；退编辑/换系都收起',
    gateGate, 'if (editMode.value)'],
];

for (const [name, gate] of GATES) {
  check(name, () => {
    const fails = gate(SRC);
    assert(fails.length === 0, fails.join('；'));
    return 'ok';
  });
}

// ── 负向探针：每删一段接线，对应的那条判据必须变红 ──────────────────────────
check('b1 负向探针：删掉“存 planetClass”→ a2 必红', () => {
  const broken = SRC.replace('store.updateNode(p.id, { planetClass: classId });', '');
  const fails = gateWrite(broken);
  assert(fails.some((f) => f.includes('planetClass')), `没抓住：${fails.join('；')}`);
  return '抓到“改类型没落数据”';
});

check('b2 负向探针：把 paletteForClass 换成硬编码默认色 → a3 必红', () => {
  const broken = SRC.replace('paletteForClass(editPlanetClassId.value, p.planetColors)', "{ base: '#888888', land: '#888888', atmosphere: '#888888' }");
  const fails = gateSameSource(broken);
  assert(fails.some((f) => f.includes('paletteForClass')), `没抓住：${fails.join('；')}`);
  return '抓到“2D 另算一套默认色”';
});

check('b3 负向探针：把浏览模式的单击导航删掉 → a4 必红', () => {
  // ⚠️ 用正则而不是字面量：仓库工作区是 CRLF，字面量里写 \n 会永远匹配不上（探针变成空转）
  const broken = SRC.replace(/if \(hit\?\.type === 'planet'\) \{\s*emit\('select-node', hit\.node\);/, 'if (false) {');
  const fails = gateGate(broken);
  assert(fails.some((f) => f.includes('进入行星地图')), `没抓住：${fails.join('；')}`);
  return '抓到“把既有单击手感改坏”';
});

check('b4 负向探针：选中条件放宽成“所有 planet 命中”（含空间站）→ a4 必红', () => {
  const broken = SRC.replace("hit?.type === 'planet' && hit.node.layer === 'planet' && !isStationNode(hit.node)", "hit?.type === 'planet'");
  const fails = gateGate(broken);
  assert(fails.some((f) => f.includes('非空间站')), `没抓住：${fails.join('；')}`);
  return '抓到“空间站也被当成可控行星”';
});

const failed = results.filter((r) => !r.ok);
console.log('=== 2D 天体属性面板 单元测试（Node）===');
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
}
console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length) {
  console.log('失败:');
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
