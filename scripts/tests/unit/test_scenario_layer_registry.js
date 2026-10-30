#!/usr/bin/env node
/**
 * Node 单元测试：剧本视图渲染层注册表（src/renderer/src/utils/scenarioLayerRegistry.js）
 *
 * 为什么必须有这一层：N1（渲染层接口化）把 `ScenarioMap.vue` 里那条手写 `if` 链换成注册表。
 * 顺序一旦错、`when` 一旦漏判，**画面会变但一条都不会报错**——正是这条链历史上出过的
 * 「抛在中途 → 从那一行起后面全不画」。这里把五条口径钉死：
 *   ① order 决定顺序；② 同 order 按注册先后稳定排序；③ when=false 不调 draw；
 *   ④ 非法层注册即抛（不做静默兜底）；⑤ draw 抛错往上抛（本层不假装容错）。
 *
 * 用法：node scripts/tests/unit/test_scenario_layer_registry.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.join(ROOT, 'src', 'renderer', 'src', 'utils');

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
function throws(fn, msg) { try { fn(); } catch (e) { return e; } throw new Error(msg || '期望抛错但没有'); }

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-scenelayers-'));
  fs.copyFileSync(path.join(SRC_DIR, 'scenarioLayerRegistry.js'), path.join(tmp, 'scenarioLayerRegistry.js'));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const M = await import(pathToFileURL(path.join(tmp, 'scenarioLayerRegistry.js')).href);
  const { createLayerRegistry } = M;

  /** 造一个记录调用顺序的层 */
  function mk(log, id, order, extra) {
    return Object.assign({
      id, order,
      draw: (ctx, view) => { log.push(id); },
    }, extra || {});
  }

  check('a1 order 决定绘制顺序（与注册顺序无关）', () => {
    const reg = createLayerRegistry();
    const log = [];
    reg.register(mk(log, 'late', 100));
    reg.register(mk(log, 'early', 10));
    reg.register(mk(log, 'mid', 50));
    const drawn = reg.run({}, {}, {});
    assert(log.join(',') === 'early,mid,late', log.join(','));
    assert(drawn.join(',') === 'early,mid,late', `返回值不符：${drawn.join(',')}`);
    return log.join(' → ');
  });

  check('a2 同 order 按**注册先后**稳定排序（增量迁移期两条链并存也不打乱）', () => {
    const reg = createLayerRegistry();
    const log = [];
    reg.register(mk(log, 'coastA', 30));
    reg.register(mk(log, 'coastB', 30));
    reg.register(mk(log, 'base', 10));
    reg.run({}, {}, {});
    assert(log.join(',') === 'base,coastA,coastB', log.join(','));
    return log.join(' → ');
  });

  check('a3 when 返回假值 → 不调用 draw；when 收得到 (view, state)', () => {
    const reg = createLayerRegistry();
    const log = [];
    let seen = null;
    reg.register(mk(log, 'always', 10));
    reg.register(mk(log, 'never', 20, { when: () => false }));
    reg.register(mk(log, 'onFlag', 30, { when: (v, s) => { seen = { v, s }; return s.flag; } }));
    reg.run({}, { id: 'view' }, { flag: false });
    assert(log.join(',') === 'always', `不该画 never/onFlag：${log.join(',')}`);
    assert(seen && seen.v.id === 'view' && seen.s.flag === false, `when 入参不对：${JSON.stringify(seen)}`);
    log.length = 0;
    reg.run({}, { id: 'view' }, { flag: true });
    assert(log.join(',') === 'always,onFlag', log.join(','));
    return 'when 门控生效';
  });

  check('a4 非法层在注册时就抛（不做静默兜底）', () => {
    const reg = createLayerRegistry();
    const e1 = throws(() => reg.register({ id: '', order: 1, draw() {} }), '空 id 应被拒');
    const e2 = throws(() => reg.register({ id: 'x', order: NaN, draw() {} }), 'NaN order 应被拒');
    const e3 = throws(() => reg.register({ id: 'x', order: 1 }), '缺 draw 应被拒');
    const e4 = throws(() => reg.register({ id: 'x', order: 1, draw() {}, when: 1 }), 'when 非函数应被拒');
    assert(/id/.test(e1.message) && /order/.test(e2.message) && /draw/.test(e3.message) && /when/.test(e4.message),
      `错误信息没点名：${e1.message} | ${e2.message} | ${e3.message} | ${e4.message}`);
    return '4 类非法输入全被拒';
  });

  check('a5 同 id 重复注册被拒、replace 是显式覆盖（且保留原位置）', () => {
    const reg = createLayerRegistry();
    const log = [];
    reg.register(mk(log, 'a', 10));
    reg.register(mk(log, 'b', 20));
    const e = throws(() => reg.register(mk(log, 'a', 10)), '重复 id 应被拒');
    assert(/重复/.test(e.message), e.message);
    reg.replace(mk(log, 'a', 10, { draw: () => log.push('a2') }));
    reg.run({}, {}, {});
    assert(log.join(',') === 'a2,b', `覆盖后顺序变了：${log.join(',')}`);
    return '重复被拒 + replace 保留位置';
  });

  check('a6 默认值：cacheable=false / quality=full / when 缺省恒真；snapshot 只含形状', () => {
    const reg = createLayerRegistry();
    reg.register({ id: 'x', order: 5, draw: () => {} });
    const snap = reg.snapshot();
    assert(snap.length === 1 && snap[0].cacheable === false && snap[0].quality === 'full',
      JSON.stringify(snap));
    assert(typeof snap[0].draw === 'undefined', 'snapshot 不该带函数');
    const reg2 = createLayerRegistry();
    reg2.register({ id: 'c', order: 1, draw: () => {}, cacheable: true, quality: 'cheap' });
    const s2 = reg2.snapshot();
    assert(s2[0].cacheable === true && s2[0].quality === 'cheap', JSON.stringify(s2));
    return JSON.stringify(snap);
  });

  check('a7 draw 抛错往上抛（不吞），且错误能定位到层', () => {
    const reg = createLayerRegistry();
    reg.register(mk([], 'ok', 10));
    reg.register({ id: 'boom', order: 20, draw: () => { throw new Error('渲染爆了'); } });
    const e = throws(() => reg.run({}, {}, {}), 'draw 抛错应向上传播');
    assert(/渲染爆了/.test(e.message), e.message);
    return e.message;
  });

  check('a8 unregister 后不再参与；size 随注册/注销变化', () => {
    const reg = createLayerRegistry();
    const log = [];
    reg.register(mk(log, 'a', 10));
    reg.register(mk(log, 'b', 20));
    assert(reg.size === 2, String(reg.size));
    assert(reg.unregister('b') === true, 'unregister 应返回 true');
    assert(reg.unregister('b') === false, '重复 unregister 应返回 false');
    reg.run({}, {}, {});
    assert(log.join(',') === 'a', log.join(','));
    return 'size=1';
  });

  check('a9 plan() 只算不画（给"这一帧会画哪些层"留一个可断言的出口）', () => {
    const reg = createLayerRegistry();
    const log = [];
    reg.register(mk(log, 'a', 10));
    reg.register(mk(log, 'b', 20, { when: () => false }));
    const p = reg.plan({}, {});
    assert(p.length === 1 && p[0].id === 'a', JSON.stringify(p.map(x => x.id)));
    assert(log.length === 0, 'plan 不该调用 draw');
    return 'plan=[a]';
  });

  const failed = results.filter(r => !r.ok);
  console.log('=== 渲染层注册表单元测试（Node）===');
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
