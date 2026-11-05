#!/usr/bin/env node
/**
 * Node 单元测试：演变过渡（A2，2026-11-05）
 *
 * 为什么值得单独守：过渡的每一处错都**不会报错**，只会静默变成另一种观感：
 *   · 进度曲线端点不精确 → 换代瞬间仍硬跳（或者永远停在中间色）；
 *   · 颜色混合解析失败 → 整省变成 `undefined` / 黑块（canvas 不报错，直接吞）；
 *   · 导出带上过渡 → 同一份数据导两次得到不同像素（"导出诚实"被破坏，且很难复现）；
 *   · 过渡把海岛/无主省的取色路径改坏 → 只有特定省变黑（画面里看着像"数据丢了"）。
 *
 * 用法：node scripts/tests/unit/test_era_transition.js
 * 退出码：0 = 全通过。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

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
function eq(a, b, label) {
  if (a !== b) throw new Error(`${label}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
function near(a, b, eps, label) {
  if (Math.abs(Number(a) - Number(b)) > eps) {
    throw new Error(`${label}: 期望 ≈${b}（±${eps}），实际 ${a}`);
  }
}
/** 读源码并归一化换行（index 是 LF、工作树是 CRLF —— 不归一化切片会失败 → 假红） */
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

async function loadUtil() {
  const src = read('src/renderer/src/utils/eraTransition.js');
  const url = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(src);
  return import(url);
}

async function main() {
  const U = await loadUtil();
  const { ERA_FADE_MS, ERA_FADE_MS_MAX, eraFadeMs, eraFadeProgress, parseCssColor, mixCssColor } = U;

  // ── a. 时长口径 ────────────────────────────────────────────────────────────
  check('a1 默认时长 = 320ms，且 0 能真的关掉（A/B 观感对比用）', () => {
    eq(ERA_FADE_MS, 320, '默认值');
    eq(eraFadeMs({}), 320, '没有覆盖口');
    eq(eraFadeMs({ __SITIAN_ERA_FADE_MS__: 0 }), 0, '明确写 0 = 关');
    eq(eraFadeMs({ __SITIAN_ERA_FADE_MS__: '0' }), 0, '字符串 "0" 也认');
    eq(eraFadeMs(undefined), 320, '没有 window');
    return '0 是有效值（关闭），不是"没设"';
  });

  check('a2 非法覆盖值 → 回默认（不许静默把动画关掉/开到无穷）', () => {
    eq(eraFadeMs({ __SITIAN_ERA_FADE_MS__: -5 }), 320, '负数');
    eq(eraFadeMs({ __SITIAN_ERA_FADE_MS__: 'abc' }), 320, '非数字');
    eq(eraFadeMs({ __SITIAN_ERA_FADE_MS__: null }), 320, 'null');
    eq(eraFadeMs({ __SITIAN_ERA_FADE_MS__: 99999 }), ERA_FADE_MS_MAX, '超上限夹住');
    eq(eraFadeMs({ __SITIAN_ERA_FADE_MS__: '800' }), 800, '合法字符串');
    return '4 例非法 + 1 例超限 + 1 例合法';
  });

  // ── b. 进度曲线 ────────────────────────────────────────────────────────────
  check('b1 进度端点精确：0 → 0、到点 → 1（端点不精确 = 换代那帧仍硬跳）', () => {
    eq(eraFadeProgress(0, 320), 0, '起点');
    eq(eraFadeProgress(-10, 320), 0, '负 elapsed');
    eq(eraFadeProgress(320, 320), 1, '恰好到点');
    eq(eraFadeProgress(999, 320), 1, '超过时长');
    eq(eraFadeProgress(100, 0), 1, '时长 0 = 没有过渡（恒确定态）');
    near(eraFadeProgress(160, 320), 0.5, 1e-9, '中点走 smoothstep = 0.5');
    return '端点精确 + 中点半值';
  });

  check('b2 进度单调递增，且始终落在 [0,1]', () => {
    let prev = -1;
    for (let e = 0; e <= 320; e += 16) {
      const t = eraFadeProgress(e, 320);
      assert(t >= 0 && t <= 1, `t(${e}) = ${t} 越界`);
      assert(t >= prev, `t(${e}) = ${t} 比上一档 ${prev} 小（不是单调）`);
      prev = t;
    }
    return '0..320 每 16ms 采样一遍';
  });

  // ── c. 颜色解析与混合 ──────────────────────────────────────────────────────
  check('c1 颜色解析：#rgb / #rrggbb / rgba() 都认，非法返回 null', () => {
    eq(JSON.stringify(parseCssColor('#c23b3b')), '[194,59,59,1]', '6 位 hex');
    eq(JSON.stringify(parseCssColor('#f00')), '[255,0,0,1]', '3 位 hex');
    eq(JSON.stringify(parseCssColor('rgba(74, 118, 158, 0.42)')), '[74,118,158,0.42]', 'rgba');
    eq(JSON.stringify(parseCssColor('rgb(1 2 3)')), '[1,2,3,1]', '空格分隔');
    assert(JSON.stringify(parseCssColor('#11223380')).startsWith('[17,34,51,'), '8 位 hex 带 alpha');
    assert(parseCssColor('hsl(0, 100%, 50%)') === null, 'hsl 不支持 → null（不猜）');
    assert(parseCssColor('') === null, '空串');
    assert(parseCssColor(null) === null, 'null');
    return '6 种合法写法 + 3 种不支持';
  });

  check('c2 混合端点与中点：两端必须**原色**（不能差一档）', () => {
    eq(mixCssColor('#c23b3b', '#3b6cc2', 0), '#c23b3b', 't=0 = 旧色');
    eq(mixCssColor('#c23b3b', '#3b6cc2', 1), '#3b6cc2', 't=1 = 新色');
    eq(mixCssColor('#c23b3b', '#3b6cc2', 0.5), '#7f547f', '中点（逐通道四舍五入）');
    // 两端同色 → 恒等（不因浮点抖动出一个中间色）
    eq(mixCssColor('#112233', '#112233', 0.37), '#112233', '同色恒等');
    return '端点精确 + 中点 + 同色恒等';
  });

  check('c3 🔴 解析不了的一端不许把颜色弄丢（回退整色，而不是 undefined/透明）', () => {
    eq(mixCssColor('hsl(0,100%,50%)', '#112233', 0.2), 'hsl(0,100%,50%)', '旧色不可解析 → 取旧色');
    eq(mixCssColor('#112233', 'hsl(0,100%,50%)', 0.8), 'hsl(0,100%,50%)', '新色不可解析 → 取新色');
    for (const t of [0, 0.5, 1]) {
      const out = mixCssColor(null, undefined, t);
      assert(typeof out === 'string' && out.length > 0, `t=${t} 返回了 ${JSON.stringify(out)}`);
      assert(!/undefined|NaN/.test(out), `t=${t} 拼出脏色 ${out}`);
    }
    return '回退整色；负向探针查 undefined/NaN';
  });

  check('c4 alpha 参与插值；不透明结果返回 #rrggbb（省界层据此判不透明）', () => {
    eq(mixCssColor('rgba(0,0,0,0)', 'rgba(255,255,255,1)', 0.5), 'rgba(128, 128, 128, 0.5)', 'alpha 中点');
    assert(/^#[0-9a-f]{6}$/.test(mixCssColor('rgba(0,0,0,1)', 'rgba(255,255,255,1)', 0.5)),
      '不透明结果不是 #rrggbb（会让省界退化成"半透明描边"）');
    return 'alpha 插值 + 不透明结果格式';
  });

  // ── d. 源码契约（组件/渲染层的接线，跑不了 Vue 的部分靠这里守）──────────────
  const vue = read('src/renderer/src/components/ScenarioMap.vue');
  const actions = read('src/renderer/src/scenario/interaction/actions.js');
  const province = read('src/renderer/src/scenario/interaction/province.js');
  const layers = read('src/renderer/src/scenario/layers/provinces.js');
  const fadeMod = read('src/renderer/src/scenario/interaction/eraFade.js');

  check('d1 换代时启动过渡：watch(tlEra) 把**上一代**代号交给过渡状态机', () => {
    const at = vue.indexOf('watch(tlEra, (k, oldK) => {');
    assert(at >= 0, '找不到 watch(tlEra) 的两个参数形式（少 oldK 就只能硬跳）');
    const body = vue.slice(at, at + 700);
    assert(body.includes('eraFade.start(oldK)'), 'watch 里没启动过渡');
    assert(fadeMod.includes('eraFadeProgress('), '状态机没用统一进度曲线（会各写一套）');
    assert(vue.includes('createEraFade({ tlEra, render })'), '组件没装配过渡状态机');
    assert(fadeMod.includes('window.__SITIAN_ERA_FADE__'), '缺排障读数口（真机判据读不到过渡态）');
    return 'watch(tlEra) → eraFade.start(oldK)';
  });

  check('d2 取色口把过渡固定进这一帧的 view；层不知道过渡的存在', () => {
    assert(vue.includes('getProvinceColor: (prov) => getProvinceColor(prov, eraFadeNow)'),
      'makeLayerView 没把过渡绑进取色闭包（层会拿到确定态）');
    assert(!/drawProvincesLayer\([^)]*eraTransition/.test(vue), '组件不该自己混合颜色');
    assert(layers.includes('view.getProvinceColor(rp)'), '省界层改了口径（应只调 view 的取色口）');
    assert(!layers.includes('eraTransition'), '层直接 import 过渡模块 = 两处实现，导出/画布会分叉');
    return 'view 闭包 + 层零感知';
  });

  check('d3 🔴 导出必须是确定态：exportPNG 一律 snapshot，不留裸 makeLayerView()', () => {
    const at = actions.indexOf('function exportPNG()');
    assert(at >= 0, '找不到 exportPNG');
    const end = actions.indexOf('\nfunction ', at + 10);
    const body = actions.slice(at, end > 0 ? end : actions.length);
    assert(body.includes('makeLayerView({ snapshot: true })'), '导出没有走 snapshot（会在过渡期导出中间色）');
    const bare = body.match(/makeLayerView\(\s*\)/g) || [];
    eq(bare.length, 0, '导出里还有裸 makeLayerView()');
    return '6 处全 snapshot';
  });

  check('d4 取色按"指定代号"可查（上一代的颜色算得出来），且过渡结束 = 新主色', () => {
    assert(province.includes('function provinceColorAt(prov, eraIndex)'), '取色没有代号参数（算不出旧色）');
    const at = province.indexOf('function getProvinceColor(prov, fade)');
    assert(at >= 0, '找不到 getProvinceColor(prov, fade)');
    const end = province.indexOf('\nfunction ', at + 10);
    const body = province.slice(at, end > 0 ? end : province.length);
    assert(body.includes('mixCssColor(prev, base, t)'), '过渡没用统一混合实现');
    assert(/t >= 1\) return base/.test(body), 't=1 必须直接返回新色（否则末帧停在中间色）');
    assert(body.includes('fromEra === tlEra.value'), '同代时不该混合（会白算一遍）');
    return 'provinceColorAt(eraIndex) + t=1 归新色';
  });

  check('d5 时长每次换代现读（模块级缓存会让运行时覆盖口"没接上"）', () => {
    // 2026-11-05 真机判据抓到：缓存成 `const TL_ERA_FADE_MS = eraFadeMs()` 之后，
    // 页面里再改覆盖口要等重载才生效（drill 读到的 dur 一直是默认 320）。
    assert(!/const\s+TL_ERA_FADE_MS\s*=\s*eraFadeMs\(\)/.test(vue),
      '时长被缓存成常量 —— 运行时覆盖口不会生效');
    const at = fadeMod.indexOf('function start(fromEra) {');
    assert(at >= 0, '找不到状态机的 start()');
    const body = fadeMod.slice(at, at + 700);
    assert(/const dur = eraFadeMs\(\)/.test(body), 'start() 里没有现读时长');
    assert(body.includes('dur,'), '没有把这次过渡的时长钉进状态');
    assert(!/const dur = [0-9]/.test(body), '时长不该是写死的数字');
    return '现读 + 钉进状态';
  });

  // ── 汇总 ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log('=== 演变过渡（A2）Node 单元测试 ===');
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('单元测试运行器异常:', err);
  process.exit(1);
});
