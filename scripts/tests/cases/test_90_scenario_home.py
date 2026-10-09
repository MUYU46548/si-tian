#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 90：历史剧本站首 + 三处交互修复（2026-10-09，暮雨实测报告）

覆盖四件事：
  ① 「打开剧本 → 本能想拖动地图查看，却意外触发绘制、弹『仍要在这里创建吗』」
     → 默认工具从 draw 翻成 select（拖拽 = 平移）
  ② 「底图编辑要点一下地图才更新」→ onModeChange 补 render()，切模式即重绘
  ③ 「根本找不到在哪选剧本 / 上一剧本·下一剧本语义不清」
     → 剧本列表常驻左栏；点一条 = 切剧本 + 地图切到该时期起始年 + 同步切剧本模式
  ④ 「神秘隐藏快捷键 Ctrl+Q 无确认就退出」→ 改两段式：主进程只发 app-request-quit，
     渲染层弹确认框，用户点「退出司天」才回 app-confirm-quit 真退

判定口径：
  * 源码闸门 —— 一律先剥注释再判（注释里写着旧实现会自己判自己，见 test_59/71 惯例）
  * CDP 行为 —— 真点列表条目、真读像素
  * 🔴 像素断言是**受控对照**：base→scenario→base→scenario 走两轮，
    第二次进剧本模式的像素必须与第一次**完全一致**。
    旧缺陷（不重绘）下第二次会停在 base 态 → B !== C 而 A === C（一眼看出是"没重绘"）。
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json            # noqa: E402
from lib.helpers import ensure_data_ready, open_test_base_map   # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SM = "document.querySelector('.scenario-map-container')?.__vueParentComponent?.setupState"


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def _code_only(src):
    """剥掉整行注释（`//` `*` `/*` 开头）—— 判据必须只对代码成立。"""
    out = []
    for line in src.split('\n'):
        st = line.strip()
        if st.startswith('//') or st.startswith('*') or st.startswith('/*'):
            continue
        out.append(line)
    return '\n'.join(out)


def source_gates():
    """纯源码判据：这些是「改完不该再回去」的契约，比行为断言更早失败、更好定位。"""
    fails, notes = [], []

    sc = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))

    # ① 默认工具
    if "const tool = ref('select')" not in sc:
        fails.append("默认工具不是「选择」——拖地图又会误触建省（应写 const tool = ref('select')）")
    if "const tool = ref('draw')" in sc:
        fails.append("默认工具仍写着 draw（2026-10-09 已翻转为 select）")

    # ② 切模式必须重绘
    i = sc.index('function onModeChange()')
    j = sc.index('\n}', i)
    mode_body = sc[i:j]
    if 'render();' not in mode_body:
        fails.append("onModeChange 里没有 render()——切模式又要点一下画布才更新")

    # ③ 剧本站首面板
    for needle, label in [
        ('data-testid="scenario-list-panel"', '剧本站首面板挂到画布上'),
        ('data-testid="slp-manage"', '面板里的「新建 / 管理剧本」入口'),
        ('function selectScenarioAt(', '点条目 = 选时期（切剧本+切年份）的唯一受理函数'),
    ]:
        if needle not in sc:
            fails.append(f'剧本站首缺失：{label}（找不到 `{needle}`）')

    if 'function selectScenarioAt(' in sc:
        i = sc.index('function selectScenarioAt(')
        j = sc.index('\n}', i)
        body = sc[i:j]
        for needle, label in [
            ('tlDate.value = { y: start', '切到该时期起始年（否则地图着色不动，看着像设置项）'),
            ('viewMode.value = ', '从底图编辑点列表时切到剧本模式（否则改了看不见）'),
        ]:
            if needle not in body:
                fails.append(f'selectScenarioAt 缺：{label}')

    # ④ Ctrl+Q 两段式退出
    main_src = _code_only(_read('src/main/index.js'))
    if 'app-request-quit' not in main_src:
        fails.append("主进程没有 'app-request-quit'——Ctrl+Q 没交给渲染层确认")
    if "ipcMain.on('app-confirm-quit'" not in main_src:
        fails.append("主进程没有 'app-confirm-quit' 受理——渲染层确认后没法真退")
    # 反向：before-input-event 的 handler 体内**不许**直接退出
    if 'before-input-event' in main_src:
        i = main_src.index('before-input-event')
        j = main_src.index('\n});', i)
        block = main_src[i:j]
        if 'app.quit()' in block:
            fails.append('Ctrl+Q 的 handler 里仍在直接 app.quit()（绕过了确认框）')
        if "send('app-request-quit'" not in block:
            fails.append('Ctrl+Q 的 handler 没有把退出请求发给渲染层')

    pl = _code_only(_read('src/preload/index.js'))
    for needle, label in [('onRequestQuit', '渲染层订阅退出请求'), ('confirmQuit', '渲染层回执确认退出')]:
        if needle not in pl:
            fails.append(f'preload 缺 {label}（{needle}）')

    app = _code_only(_read('src/renderer/src/App.vue'))
    for needle, label in [
        ('onRequestQuit?.(', 'App 订阅退出请求'),
        ('askChoice(', '退出用模态确认（不是 window.confirm）'),
        ('confirmQuit?.()', '用户确认后回执'),
    ]:
        if needle not in app:
            fails.append(f'App.vue 缺 {label}（{needle}）')

    # mock 必须同步补（AGENTS.md：新增 window.sitianAPI 能力必须同步补 MOCK_SCRIPT）
    rt = _code_only(_read('scripts/tests/run_tests.py'))
    if 'onRequestQuit: noop' not in rt:
        fails.append('run_tests.py 的 MOCK_SCRIPT 漏了 onRequestQuit（页面会挂载失败）')
    if 'confirmQuit:' not in rt:
        fails.append('run_tests.py 的 MOCK_SCRIPT 漏了 confirmQuit')

    notes.append(f'源码闸门 14 项' + ('全过' if not fails else f'缺 {len(fails)} 项'))
    return fails, notes


SEED_JS = """(() => {
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  for (const k of Object.keys(s.scenarios)) s.removeScenario(k);

  const mk = (id, x0, y0) => ({
    id, name: '省' + id.slice(-1).toUpperCase(),
    points: [{x:x0,y:y0},{x:x0+120,y:y0},{x:x0+120,y:y0+120},{x:x0,y:y0+120}],
    biome: 'temperate', coast: true,
  });
  if (!s.baseMaps['云陇大陆']) s.addBaseMap('云陇大陆', { name: '云陇大陆' });
  const bm = s.baseMaps['云陇大陆'];
  bm.terrain.length = 0;
  ['prov_a','prov_b','prov_c'].forEach((id, i) => s.addBaseProvince('云陇大陆', mk(id, 200 + i * 160, 200)));

  const P = (id, name, color) => ({ id, name, color });
  s.createScenario('云陇大陆/甲时代', {
    ownerKey: '云陇大陆', name: '甲时代', order: 1,
    era: { roman: 'Ⅰ', label: '甲', startYear: '2000', endYear: '2010' },
    polities: [P('A1','甲国','#c23b3b')],
    ownership: { prov_a:'A1', prov_b:'A1', prov_c:'A1' },
  });
  s.createScenario('云陇大陆/乙时代', {
    ownerKey: '云陇大陆', name: '乙时代', order: 2,
    era: { roman: 'Ⅱ', label: '乙', startYear: '2010', endYear: '2020' },
    polities: [P('B1','乙国','#4a90d9'), P('B2','乙南','#e6a23c')],
    ownership: { prov_a:'B1', prov_b:'B2', prov_c:'B1' },
  });
  s.createScenario('云陇大陆/丙时代', {
    ownerKey: '云陇大陆', name: '丙时代', order: 3,
    era: { roman: 'Ⅲ', label: '丙', startYear: '2020', endYear: '2030' },
    polities: [P('C1','丙国','#5b8c5a'), P('C2','丙南','#8e44ad')],
    ownership: { prov_a:'C1', prov_b:'C2', prov_c:'C1' },
  });
  return JSON.stringify({ provCount: s.baseMaps['云陇大陆'].terrain.length,
                          scCount: Object.keys(s.scenarios).length });
})()"""


PROBE_JS = """(() => {
  const sc = __SM__;
  const fails = [], notes = {};
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + e + ')' : '')); };

  // ── ① 默认工具 ──────────────────────────────────────────────────────────
  ok('默认工具 = 选择（不是 draw）', sc.tool === 'select', sc.tool);

  // ── ③ 站首面板在位 ──────────────────────────────────────────────────────
  const panel = document.querySelector('[data-testid="scenario-list-panel"]');
  ok('剧本站首面板存在', !!panel);
  ok('面板标题写着「历史剧本」', !!panel && panel.textContent.includes('历史剧本'));
  ok('「新建 / 管理剧本」按钮在位', !!document.querySelector('[data-testid="slp-manage"]'));
  const items = Array.from(document.querySelectorAll('.slp-item'));
  notes.items = items.length;
  ok('列表条目数 = 剧本数（3）', items.length === 3, items.length);
  if (items.length >= 3) {
    const t = (el) => (el ? el.textContent : '');
    ok('条目按 order 升序（第 1 条是甲时代）', t(items[0]).includes('甲时代'), t(items[0]).slice(0, 30));
    ok('条目第二行有势力数·省数摘要', /势力/.test(t(items[0])), t(items[0]).slice(0, 40));
  }

  // ── ③ 点条目 = 切剧本 + 切年份 + 切模式 ─────────────────────────────────
  sc.viewMode = 'base';
  sc.tlEra = 0;
  sc.tlDate = { y: 2000, m: null, d: null };
  const before = { era: sc.tlEra, y: sc.tlDate.y, mode: sc.viewMode };
  notes.before = JSON.stringify(before);
  if (items.length >= 3) items[2].click();   // 丙时代（2020–2030）
  notes.after = JSON.stringify({ era: sc.tlEra, y: sc.tlDate.y, mode: sc.viewMode,
                                 name: sc.selectedScenario && sc.selectedScenario.name });
  ok('点条目 → 编辑目标跟着切（丙时代）',
     sc.selectedScenario && sc.selectedScenario.name === '丙时代',
     sc.selectedScenario && sc.selectedScenario.name);
  ok('点条目 → 时间轴游标切到该时期起始年（2020）', sc.tlDate.y === 2020, sc.tlDate.y);
  ok('点条目 → 剧本索引同步（2）', sc.tlEra === 2, sc.tlEra);
  ok('点条目 → 从底图编辑自动切到剧本模式', sc.viewMode === 'scenario', sc.viewMode);

  // ── ② 切模式必须重绘（受控对照：两轮进出，像素必须一致）────────────────
  const cv = document.querySelector('.scenario-map-container canvas');
  const ctx2 = cv.getContext('2d');
  const snap = () => {
    const d = ctx2.getImageData(0, 0, cv.width, cv.height).data;
    let h = 2166136261;
    for (let i = 0; i < d.length; i += 401) { h ^= d[i]; h = Math.imul(h, 16777619); }
    return h >>> 0;
  };
  sc.tlPlaying = false;
  sc.viewMode = 'base';   sc.onModeChange();
  const A = snap();                      // 底图编辑态
  sc.viewMode = 'scenario'; sc.onModeChange();
  const B = snap();                      // 第一轮进剧本模式
  sc.viewMode = 'base';   sc.onModeChange();
  sc.viewMode = 'scenario'; sc.onModeChange();
  const C = snap();                      // 第二轮进剧本模式
  notes.pix = { A: A, B: B, C: C };
  ok('两态画面确实不同（受控对照有效）', A !== B, 'A=' + A + ' B=' + B);
  ok('第二轮进剧本模式像素与第一轮一致（切模式真的重绘了）', B === C,
     'B=' + B + ' C=' + C + ' A=' + A + '（C 若等于 A = 又停在底图态）');

  // 收尾：回到剧本模式 + 选中态，别把后续用例留在 base
  sc.viewMode = 'scenario'; sc.onModeChange();
  return JSON.stringify({ fails, notes });
})()"""


def run(cdp):
    fails = []
    sf, snotes = source_gates()
    fails += sf
    notes = list(snotes)

    ensure_data_ready(cdp)
    r = cdp.eval("""(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('历史剧本'));
      if (!btn) return 'no-btn';
      btn.click();
      return 'ok';
    })()""")
    if r != 'ok':
        return False, f'进入历史剧本失败: {r}'
    try:
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", desc='ScenarioMap 挂载', timeout=20)
    except RuntimeError as e:
        return False, f'ScenarioMap 未挂载：{e}'
    time.sleep(0.8)

    bm_ok, bm_info = open_test_base_map(cdp, '云陇大陆')
    if not bm_ok:
        return False, f'底图 fixture 未就位: {bm_info}'

    seed_ok, seed = eval_json(cdp, SEED_JS, required=('provCount', 'scCount'), desc='注入 3 省 + 3 剧本')
    if not seed_ok:
        return False, f'数据注入探针失败: {seed}'
    if seed['provCount'] != 3 or seed['scCount'] != 3:
        return False, f'数据注入失败: {seed}'
    time.sleep(0.6)   # 等 computed 重算 + 列表面板渲染

    ok, res = eval_json(cdp, PROBE_JS.replace('__SM__', SM))
    if not ok:
        return False, f'探针失败: {res}'
    fails += res.get('fails', [])
    n = res.get('notes', {})
    notes.append(
        f'列表条目 {n.get("items")} 条；点条目前 {n.get("before")} → 之后 {n.get("after")}；'
        f'像素 A(底图)={n.get("pix", {}).get("A")} B(一轮剧本)={n.get("pix", {}).get("B")} '
        f'C(二轮剧本)={n.get("pix", {}).get("C")}'
    )
    return (not fails), ' | '.join(fails) if fails else ' | '.join(notes)
