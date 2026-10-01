#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 80：省份多选 → 势力批量指派（接活 `batchSetOwnership`）

来源：2026-10-01 收尾时留下的第三件 ——
  `scenarioEditing.batchSetOwnership` 是**零调用的死入口**：骨架（一条 undo / 直通写闸门）
  早就在，缺的是「省份多选」这个交互，以及三处语义不完整：
    ① `polityId` 假值会写 `ownership[id] = null`（**留键**），而 `clearOwnership` 是 delete 真删键 ——
       `groupMap` / 谱系重叠度判的是「键在不在」，于是"清空"会留下指向 null 的孤儿键；
    ② **海域不跳过**：单省油漆桶在 UI 侧拒 sea（海不参与势力归属、不进时间轴/谱系），
       批量照写就会出现「有些海莫名其妙有了归属」；
    ③ 空 / 无改动照样 execute + save（无操作噪音），且**没有回执**（UI 只能自己数个数）。

本用例覆盖：
  f0 源码守卫：批量写口走 execute + 有回执 + 清空走真删键 + 海域跳过 + 空操作不入栈；
     ScenarioMap 有 selectedProvinceIds / Ctrl·⌘ 加选 / 批量条三个 testid / 全选陆地省。
  f1 store 行为：3 个省（2 陆 + 1 海）→ 批量指派（含易主年份）→ 海域被跳过后回报 →
     一条 undo 全还原；`polityId=null` → 真删键 + 连带清 changeYears；重复 id 去重；
     不存在的 id 计入 skippedMissing；**同值重复指派 = noop 且不多压一条 undo**。
  f2 真鼠标多选：Ctrl+点击加选两个省 → 批量条显示「已选 2 省」→ 点「指派」→ 归属落库 +
     状态栏点名；再 Ctrl+点击同一个省 = 减选；普通点击 = 回单选并清空多选。
  f3 全选陆地省 / 取消选择 / 只读灰禁（无项目时按钮禁用且带原因）。
"""
import io
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json  # noqa: E402
from lib.helpers import ensure_data_ready  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
KEY = '用例80底图'
SC = KEY + '/甲时代'
# 两个陆地省 + 一片海（紧凑排布，保证在 headless 画布可视范围内）
LAND1 = (100, 100, 300, 300)
LAND2 = (320, 100, 520, 300)
SEA = (100, 320, 520, 460)


def _read(rel):
    return io.open(os.path.join(ROOT, rel), encoding='utf-8').read()


def _code_only(src):
    src = re.sub(r'<!--.*?-->', '', src, flags=re.S)
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    return re.sub(r'(?m)//[^\n]*', '', src)


# ══════════════════════════════════════════════════════════════════
# f0 源码守卫
# ══════════════════════════════════════════════════════════════════
def sub_source_guards(cdp):
    bad = []

    se = _code_only(_read('src/renderer/src/store/geodataModules/scenarioEditing.js'))
    seg = se[se.find('function batchSetOwnership'):se.find('function batchSetOwnership') + 4200]
    if not seg:
        bad.append('scenarioEditing 缺少 batchSetOwnership')
    for sym, why in (('execute(', '批量写必须一条 undo'),
                     ('skippedSea', '海域必须跳过并回报'),
                     ('skippedMissing', '不存在的省份要回报'),
                     ('noop', '空/无改动不能压栈'),
                     ('delete nextOwnership[', '清空必须真删键（不能留 null 孤儿键）')):
        if sym not in seg:
            bad.append(f'batchSetOwnership 缺 {sym}（{why}）')
    if 'null' in seg and 'delete nextOwnership[' not in seg:
        bad.append('清空路径疑似仍写 null')

    sm = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
    for sym, why in (('selectedProvinceIds', '缺少多选状态'),
                     ('event.ctrlKey || event.metaKey', '缺少 Ctrl/⌘ 加选'),
                     ('toggleProvinceSelection', '缺少加选/减选切换'),
                     ('function onBatchAssign', '缺少批量指派处理'),
                     ('store.batchSetOwnership', '批量条没接到 store'),
                     ('selectedLandProvinces', '缺少「全选陆地省」的数据源')):
        if sym not in sm:
            bad.append(f'ScenarioMap 缺 {sym}（{why}）')
    for tid in ('data-testid="province-batch-bar"', 'data-testid="pbb-assign"',
                'data-testid="pbb-clear"', 'data-testid="pbb-select-land"',
                'data-testid="pbb-cancel"'):
        if tid not in sm:
            bad.append(f'批量条缺 {tid}')
    if 'multiSelectSet' not in sm:
        bad.append('多选没有 O(1) 查表（描边每帧要按 id 判）')

    if bad:
        return False, '源码守卫失败：' + '；'.join(bad)
    return True, '批量写口（回执/真删键/海域跳过/空操作不入栈）+ 多选状态与批量条 全部就位'


# ══════════════════════════════════════════════════════════════════
# 公共造数：2 陆地省 + 1 海域省 + 一个剧本（含两个势力）
# ══════════════════════════════════════════════════════════════════
SEED_JS = r"""
  for (const k of Object.keys(s.scenarios || {})) s.removeScenario(k);
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: KEY });
  s.baseMaps[KEY].terrain.length = 0;
  const mk80 = (id, name, r, kind) => ({ id, name, kind: kind || 'land',
    points: [{x:r[0],y:r[1]},{x:r[2],y:r[1]},{x:r[2],y:r[3]},{x:r[0],y:r[3]}] });
  s.addBaseProvince(KEY, mk80('p80a', '甲省', __A__), { checkOverlap: false });
  s.addBaseProvince(KEY, mk80('p80b', '乙省', __B__), { checkOverlap: false });
  s.addBaseProvince(KEY, mk80('p80sea', '近海', __S__, 'sea'), { checkOverlap: false });
  s.createScenario(SC, { ownerKey: KEY, name: '甲时代', order: 1,
    era: { roman: 'I', label: '甲', startYear: '1000', endYear: '1100' },
    polities: [{ id: 'A1', name: '甲国', color: '#c23b3b' }, { id: 'A2', name: '乙国', color: '#4a90d9' }],
    ownership: {}, changeYears: {} });
  SM.baseMapKey = KEY;
  if (typeof SM.onBaseMapChange === 'function') SM.onBaseMapChange();
  s.rebuildProvinceGrid(KEY);
  SM.tlEra = 0; SM.tlYear = 1050;
  SM.selectedScenario = s.scenarios[SC];
  SM.selectedPolity = s.scenarios[SC].polities[0];
  SM.cameraScale = 1; SM.cameraX = 0; SM.cameraY = 0;
"""


def _seed():
    return (SEED_JS.replace('__STORE__', STORE).replace('__KEY__', json.dumps(KEY))
            .replace('__SC__', json.dumps(SC))
            .replace('__A__', json.dumps(list(LAND1))).replace('__B__', json.dumps(list(LAND2)))
            .replace('__S__', json.dumps(list(SEA))))


# ══════════════════════════════════════════════════════════════════
# f1 store 行为
# ══════════════════════════════════════════════════════════════════
STORE_JS = r"""(async () => {
  const fails = [], notes = {};
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 120));
  const s = __STORE__, SM = __SM__;
  const KEY = __KEY__, SC = __SC__;
  const seed = () => { __SEED__ };
  const own = () => (s.scenarios[SC].ownership || {});
  const cys = () => (s.scenarios[SC].changeYears || {});
  const undoStepsToEmpty = () => {
    let n = 0;
    while (n < 12 && s.baseMaps[KEY] && (s.baseMaps[KEY].terrain || []).length) { s.undo(); n++; }
    return n;
  };

  seed();
  await tick(150);
  ck('前置：3 个省（2 陆 1 海）在册', s.baseMaps[KEY].terrain.length === 3, s.baseMaps[KEY].terrain.length);

  // ① 批量指派：两个陆地省，含易主年份；海域必须被跳过
  const r1 = s.batchSetOwnership(SC, ['p80a', 'p80b', 'p80sea', 'p80b'], 'A1', 1050);
  ck('批量指派成功', !!(r1 && r1.success === true), r1);
  ck('两个陆地省都写进 ownership（重复 id 已去重）',
     own().p80a === 'A1' && own().p80b === 'A1' && r1.changed === 2, { own: own(), r: r1 });
  ck('海域被跳过并回报', r1.skippedSea === 1 && own().p80sea === undefined, r1);
  ck('易主年份一并写入', cys().p80a === 1050 && cys().p80b === 1050, cys());
  ck('回执给出 affected', r1.affected === 2, r1);

  s.undo();
  ck('**一条** undo 把两个省一起还原', own().p80a === undefined && own().p80b === undefined
     && cys().p80a === undefined, { own: own(), cys: cys() });
  s.redo();
  ck('redo 再落一次', own().p80a === 'A1' && own().p80b === 'A1');

  // ② noop 不入栈：跑**同一串真实操作**，只在其中一次后面多插一发同值指派 ——
  //    「撤空 terrain 需要几步」会把中途那些不改 terrain 的命令也算进去，所以判据必须是
  //    两条支路的**步数之差**，而不是拿它跟「只有 seed」的基线比（那样必然多一步而假红）。
  const stepsRealOnly = (() => {
    seed(); s.batchSetOwnership(SC, ['p80a', 'p80b'], 'A1', 1050);
    return undoStepsToEmpty();
  })();
  seed();
  await tick(150);
  s.batchSetOwnership(SC, ['p80a', 'p80b'], 'A1', 1050);
  const r2 = s.batchSetOwnership(SC, ['p80a', 'p80b'], 'A1', 1050);
  ck('同值重复指派 = noop', !!(r2 && r2.noop === true && r2.changed === 0), r2);
  const stepsWithNoop = undoStepsToEmpty();
  notes.noop = { stepsRealOnly, stepsWithNoop };
  ck('noop 没有多压一条 undo（与同操作的对照组步数一致）', stepsWithNoop === stepsRealOnly, notes.noop);

  // ③ 清空归属：必须**真删键**（不能留 null 孤儿键）
  seed();
  await tick(150);
  s.batchSetOwnership(SC, ['p80a', 'p80b'], 'A1', 1050);
  const r3 = s.batchSetOwnership(SC, ['p80a', 'p80b'], null);
  ck('清空成功且回报 cleared=2', !!(r3 && r3.success === true && r3.cleared === 2), r3);
  ck('键被真删（不是留 null）',
     !Object.prototype.hasOwnProperty.call(own(), 'p80a')
     && !Object.prototype.hasOwnProperty.call(own(), 'p80b'), own());
  ck('易主年份跟着清', !Object.prototype.hasOwnProperty.call(cys(), 'p80a'), cys());
  s.undo();
  ck('清空也是一条 undo', own().p80a === 'A1' && own().p80b === 'A1', own());

  // ④ 不存在的 id 计入 skippedMissing；海+不存在+陆地混在一起时陆地照写
  seed();
  await tick(150);
  const r4 = s.batchSetOwnership(SC, ['p80a', 'ghost', 'p80sea'], 'A2', 1010);
  ck('混入不存在 id → 只写存在的陆地省', own().p80a === 'A2' && r4.changed === 1, { own: own(), r: r4 });
  ck('不存在与海域分别计数', r4.skippedMissing === 1 && r4.skippedSea === 1, r4);
  ck('换势力 = 新的指派（不是 noop）', r4.noop !== true);

  // ⑤ 空数组 / 只给海域 → noop（没有可改的东西就不该压栈）
  const r5 = s.batchSetOwnership(SC, [], 'A2', 1000);
  ck('空数组 = noop', r5 && r5.noop === true, r5);
  const r6 = s.batchSetOwnership(SC, ['p80sea'], 'A2', 1000);
  ck('只给海域 = noop + 回报跳过', r6 && r6.noop === true && r6.skippedSea === 1, r6);
  return JSON.stringify({ fails, notes });
})()"""


def sub_store(cdp):
    expr = (STORE_JS.replace('__STORE__', STORE).replace('__SM__', SM)
            .replace('__KEY__', json.dumps(KEY)).replace('__SC__', json.dumps(SC))
            .replace('__SEED__', _seed()))
    ok, res = eval_json(cdp, expr, desc='批量指派 store')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        extra = f' 现场：{json.dumps(res.get("notes"), ensure_ascii=False)}' if res.get('notes') else ''
        return False, ('批量指派断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8]) + extra)
    return True, '批量指派（含年份）/ 海域与幽灵 id 跳过并回报 / 一条 undo / 清空真删键 / 同值与空操作不压栈'


# ══════════════════════════════════════════════════════════════════
# f2 真鼠标多选 + 批量条
# ══════════════════════════════════════════════════════════════════
CLICK = r"""
  const canvasEl = document.querySelector('.scenario-map-container canvas');
  const rr = canvasEl.getBoundingClientRect();
  const toScreen = (wx, wy) => ({ x: wx * SM.cameraScale + SM.cameraX, y: wy * SM.cameraScale + SM.cameraY });
  const clickWorld = (wx, wy, extra) => {
    const p = toScreen(wx, wy);
    const mk = (t) => new MouseEvent(t, Object.assign({
      clientX: rr.left + p.x, clientY: rr.top + p.y, bubbles: true, cancelable: true, button: 0,
    }, extra || {}));
    canvasEl.dispatchEvent(mk('mousedown'));
    canvasEl.dispatchEvent(mk('mouseup'));
    canvasEl.dispatchEvent(mk('click'));
  };
"""

UI_JS = r"""(async () => {
  const fails = [], notes = {};
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 200));
  const s = __STORE__, SM = __SM__;
  const KEY = __KEY__, SC = __SC__;
  __CLICK__
  __SEED__
  SM.setTool('select');
  await tick(300);
  const bar = () => document.querySelector('[data-testid="province-batch-bar"]');
  const own = () => (s.scenarios[SC].ownership || {});

  ck('前置：多选集合是空的、批量条不显示', SM.selectedProvinceIds.length === 0 && !bar());

  // ① Ctrl+点击两个陆地省 → 多选 2 个 + 批量条出现
  clickWorld(200, 200, { ctrlKey: true });
  await tick(250);
  clickWorld(420, 200, { ctrlKey: true });
  await tick(250);
  ck('Ctrl+点击加选两个省', SM.selectedProvinceIds.length === 2, SM.selectedProvinceIds);
  ck('批量条出现', !!bar());
  if (!bar()) {
    // 查空时带回现场（本仓纪律：不许就地抛异常，也不许只报"没找到"）
    fails.push('批量条没出现 —— 后续断言无法进行');
    return JSON.stringify({ fails, notes: {
      ids: SM.selectedProvinceIds, tool: SM.tool, baseMapKey: SM.baseMapKey,
      selected: SM.selectedProvince && SM.selectedProvince.id,
      bars: Array.from(document.querySelectorAll('[data-testid]')).map(e => e.getAttribute('data-testid')),
    } });
  }
  ck('批量条显示已选数量', bar() && /2/.test(bar().querySelector('[data-testid="pbb-count"]').textContent),
     bar() && bar().querySelector('[data-testid="pbb-count"]').textContent);
  ck('批量条带指派/清除/全选/取消四个入口',
     ['pbb-assign', 'pbb-clear', 'pbb-select-land', 'pbb-cancel']
       .every(id => !!bar().querySelector('[data-testid="' + id + '"]')));

  // ② 点「指派」→ 归属落库 + 状态栏点名
  bar().querySelector('[data-testid="pbb-assign"]').click();
  await tick(300);
  ck('两个省的归属都写进了当前势力', own().p80a === 'A1' && own().p80b === 'A1', own());
  ck('状态栏点名批量结果', /已指派给/.test(String(SM.provinceHint || '')) && /2 省/.test(String(SM.provinceHint || '')),
     SM.provinceHint);

  // ③ 再 Ctrl+点同一个省 = 减选
  clickWorld(200, 200, { ctrlKey: true });
  await tick(250);
  ck('再点一次同一个省 = 减选', SM.selectedProvinceIds.length === 1, SM.selectedProvinceIds);

  // ④ 普通点击 = 回单选并清空多选
  clickWorld(420, 200);
  await tick(250);
  ck('普通点击清空多选', SM.selectedProvinceIds.length === 0, SM.selectedProvinceIds);
  ck('普通点击后批量条收起', !bar());

  // ⑤ 全选陆地省：海域不进多选
  SM.selectedProvinceIds = [];
  clickWorld(200, 200, { ctrlKey: true });     // 先让批量条出现
  await tick(250);
  bar().querySelector('[data-testid="pbb-select-land"]').click();
  await tick(250);
  ck('全选陆地省 = 2 个（海域不算）', SM.selectedProvinceIds.length === 2, SM.selectedProvinceIds);
  ck('多选里没有海域 id', SM.selectedProvinceIds.indexOf('p80sea') < 0, SM.selectedProvinceIds);

  // ⑥ 取消选择
  bar().querySelector('[data-testid="pbb-cancel"]').click();
  await tick(250);
  ck('取消选择清空多选并收起批量条', SM.selectedProvinceIds.length === 0 && !bar());

  // ⑦ 批量的撤销也是「一条」
  clickWorld(200, 200, { ctrlKey: true });
  await tick(200);
  clickWorld(420, 200, { ctrlKey: true });
  await tick(200);
  SM.selectedPolity = s.scenarios[SC].polities[1];      // 换成乙国
  bar().querySelector('[data-testid="pbb-assign"]').click();
  await tick(300);
  ck('换成乙国再批量指派', own().p80a === 'A2' && own().p80b === 'A2', own());
  s.undo();
  await tick(250);
  ck('批量指派一条 undo 全还原（回甲国）', own().p80a === 'A1' && own().p80b === 'A1', own());
  return JSON.stringify({ fails, notes });
})()"""


def sub_ui(cdp):
    expr = (UI_JS.replace('__STORE__', STORE).replace('__SM__', SM)
            .replace('__KEY__', json.dumps(KEY)).replace('__SC__', json.dumps(SC))
            .replace('__CLICK__', CLICK).replace('__SEED__', _seed()))
    ok, res = eval_json(cdp, expr, desc='多选批量指派 UI')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        extra = f' 现场：{json.dumps(res.get("notes"), ensure_ascii=False)}' if res.get('notes') else ''
        return False, ('多选 UI 断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8]) + extra)
    return True, 'Ctrl+点击加选/减选 + 批量条指派落库 + 普通点击回单选 + 全选陆地省（排除海域）+ 取消 + 一条 undo'


# ══════════════════════════════════════════════════════════════════
# f3 只读灰禁（无项目 = 只读）
# ══════════════════════════════════════════════════════════════════
READONLY_JS = r"""(async () => {
  const fails = [], notes = {};
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 200));
  const s = __STORE__, SM = __SM__;
  const KEY = __KEY__, SC = __SC__;
  __CLICK__
  __SEED__
  SM.setTool('select');
  await tick(250);
  // 伪造只读：把 store 的只读判据翻过来（用例不动文件系统）
  const origRO = Object.getOwnPropertyDescriptor(s, 'isReadOnly');
  try {
    Object.defineProperty(s, 'isReadOnly', { configurable: true, get: () => true });
    Object.defineProperty(s, 'readOnlyReason', { configurable: true, get: () => '只读：用例注入' });
    SM.selectedProvinceIds = ['p80a', 'p80b'];
    await tick(250);
    const bar = document.querySelector('[data-testid="province-batch-bar"]');
    ck('只读态批量条仍在（只读 ≠ 看不见）', !!bar);
    const assign = bar && bar.querySelector('[data-testid="pbb-assign"]');
    const clear = bar && bar.querySelector('[data-testid="pbb-clear"]');
    ck('只读态「指派」禁用', !!(assign && assign.disabled));
    ck('只读态「清除归属」禁用', !!(clear && clear.disabled));
    ck('禁用带原因（title 里说明去哪儿开）', /只读/.test(assign ? assign.title : ''), assign && assign.title);
    const before = JSON.stringify(s.scenarios[SC].ownership || {});
    if (assign && !assign.disabled) assign.click();
    await tick(200);
    ck('只读态点了也不会改数据', JSON.stringify(s.scenarios[SC].ownership || {}) === before);
  } finally {
    if (origRO) Object.defineProperty(s, 'isReadOnly', origRO);
    else delete s.isReadOnly;
    delete s.readOnlyReason;
  }
  return JSON.stringify({ fails, notes });
})()"""


def sub_readonly(cdp):
    expr = (READONLY_JS.replace('__STORE__', STORE).replace('__SM__', SM)
            .replace('__KEY__', json.dumps(KEY)).replace('__SC__', json.dumps(SC))
            .replace('__CLICK__', CLICK).replace('__SEED__', _seed()))
    ok, res = eval_json(cdp, expr, desc='只读态批量条')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        return False, '只读态断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8])
    return True, '只读态批量条禁用且带原因、点了不改数据'


def run(cdp):
    ensure_data_ready(cdp)
    r = cdp.eval("""(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('历史剧本'));
      if (!b) return 'no-btn';
      b.click(); return 'ok';
    })()""")
    if r != 'ok':
        return False, f'进入剧本模式失败: {r}'
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", desc='ScenarioMap 挂载', timeout=8)
    cdp.eval("window.confirm = () => true; window.prompt = (m, d) => d;")
    time.sleep(1.2)

    results = []
    for name, fn in (('f0 源码守卫', sub_source_guards),
                     ('f1 批量指派 store', sub_store),
                     ('f2 多选 UI', sub_ui),
                     ('f3 只读灰禁', sub_readonly)):
        try:
            ok, detail = fn(cdp)
        except Exception as e:
            ok, detail = False, f'异常: {e}'
        results.append((name, ok, detail))

    failed = [f'{n}: {d}' for n, o, d in results if not o]
    if failed:
        return False, (f'批量指派 {len(results) - len(failed)}/{len(results)} 子测试通过；失败：\n    '
                       + '\n    '.join(failed))
    return True, ('批量指派 ' + f'{len(results)}/{len(results)} 全通过 — '
                  + '；'.join(d for _, _, d in results))
