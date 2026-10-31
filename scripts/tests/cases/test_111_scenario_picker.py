#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 111：剧本卡片墙（ScenarioPicker）+ 沉浸看图模式（2026-10-17 P0，暮雨拍板）

来历：三大模块深度改造 P0 第一件 —— 「历史剧本」入口此前**直接进编辑器**，
暮雨要的是 EU4 式「先看到一排剧本卡片（年代+缩略图+钩子文案+开局态势），点一张进去」。
同批落地：沉浸看图模式（Ctrl+I 收起顶栏/侧栏/时间轴，地图占满；小地图可手动隐藏）。

⚠️ 与 30+ 个既有用例的关系：它们的路径是「点『历史剧本』→ ScenarioMap 直接挂载」。
   harness 在 MOCK_SCRIPT 里注入 `window.__SKIP_SCENARIO_PICKER = true` 让 enterScenarioMode
   跳过卡片墙（sessionStorage 开关可关掉，同免责声明种子手法）。
   本用例**专门关掉开关再重载**，验证产品默认路径（卡片墙）真实可用 —— 并在收尾清开关。

本用例守五段（全部走**真事件**：真按钮点击 / 真 Ctrl+I 键盘事件）：
  a 源码闸门：卡片墙三件套在场（组件 / App 接线 / hook 字段进 createScenario 与管理表单）；
    ScenarioMap 有 initialScenarioId/openManager 两个 props 与沉浸模式实现；
    harness 的跳过开关在场（缺了它 30+ 用例会集体变红）。
  b 卡片墙真的挡在编辑器前面：关掉开关重载 → 点「历史剧本」→ 卡片墙可见、编辑器未挂载；
    造 2 条剧本（带 hook）→ 卡片数对、缩略图 canvas 真烘了图（非纯色）、卡片上真有钩子文案。
  c 点卡片进编辑器且落在**那张剧本**上：selectedScenario 就是点的那张、时间轴年份 = 起始年。
  d 沉浸模式：Ctrl+I → 顶条出现、时间轴/左栏隐藏、工具栏变胶囊；再按恢复。
  e 小地图按钮：沉浸顶条里的开关真能拨动 showMinimap。
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from lib.cdp import eval_json, wait_for      # noqa: E402
from lib.helpers import ensure_case_state, ensure_data_ready, open_harness_project  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
APPVUE = os.path.join(ROOT, 'src', 'renderer', 'src', 'App.vue')
SMV = os.path.join(ROOT, 'src', 'renderer', 'src', 'components', 'ScenarioMap.vue')
SPV = os.path.join(ROOT, 'src', 'renderer', 'src', 'components', 'ScenarioPicker.vue')
SCARDS = os.path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'scenarioCards.js')
SEDIT = os.path.join(ROOT, 'src', 'renderer', 'src', 'store', 'geodataModules', 'scenarioEditing.js')
RUNT = os.path.join(ROOT, 'scripts', 'tests', 'run_tests.py')

SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SKIP_FLAG = '__sitian_skip_picker_seed'


def _code_only(src):
    out, in_block = [], False
    for line in src.split('\n'):
        s = line
        if in_block:
            if '*/' in s:
                s = s.split('*/', 1)[1]
                in_block = False
            else:
                continue
        while '/*' in s:
            before, after = s.split('/*', 1)
            if '*/' in after:
                s = before + after.split('*/', 1)[1]
            else:
                s = before
                in_block = True
                break
        if '//' in s:
            s = s.split('//', 1)[0]
        out.append(s)
    return '\n'.join(out)


def _read(path):
    with open(path, encoding='utf-8') as f:
        return _code_only(f.read())


def source_gates():
    fails = []
    app = _read(APPVUE)
    sm = _read(SMV)
    sp = _read(SPV)
    cards = _read(SCARDS)
    sed = _read(SEDIT)
    # 🔴 run_tests.py 是 **Python** 文件（MOCK_SCRIPT 是里面的三引号 JS 字符串）——
    #    不能过 `_code_only`（它按 JS 规则剥 // 与 /* */，会把 MOCK_SCRIPT 里的 JS 注释
    #    连同后续行整段吞掉，实测把注入行也剥没了 → 闸门假红）。直接查原文的代码行。
    with open(RUNT, encoding='utf-8') as f:
        runt_raw = f.read()

    # a① 卡片墙三件套
    if 'scenario-picker' not in app or 'ScenarioPicker' not in app:
        fails.append('🔴 App.vue 没接卡片墙（<scenario-picker> 或 import 缺失）')
    if 'handlePickerEdit' not in app:
        fails.append('🔴 App.vue 没有 handlePickerEdit（点卡片没有进入通路）')
    # ⚠️ App.vue 里是 kebab-case 绑定 `:initial-scenario-id` + ref 名 `scenarioInitialId` ——
    #    驼峰的 `initialScenarioId` 在 App.vue **从不出现**（它是子组件 prop 名），别拿它当判据。
    if 'initial-scenario-id' not in app or 'scenarioInitialId' not in app:
        fails.append('🔴 App.vue 没把 initialScenarioId 传给 ScenarioMap（卡片 → 剧本选中的通路断）')
    if '__SKIP_SCENARIO_PICKER' not in app:
        fails.append('🔴 enterScenarioMode 不认跳过开关 —— 30+ 个既有用例会集体变红')

    # a② hook 字段：schema + 管理表单（两处都得有，只有 schema = UI 够不着）
    if "hook: scenario.hook || ''" not in sed:
        fails.append('🔴 createScenario 没有 hook 字段（钩子文案落不了库）')
    if 'newScenario.hook' not in sm:
        fails.append('🔴 管理表单没接 hook（用户没地方写钩子文案）')

    # a③ ScenarioMap 的 props 与沉浸实现
    if 'initialScenarioId' not in sm or 'openManager' not in sm:
        fails.append('🔴 ScenarioMap 没有 initialScenarioId/openManager props')
    if 'immersive' not in sm or 'immersive-bar' not in sm:
        fails.append('🔴 ScenarioMap 没有沉浸模式实现（immersive 状态 / 顶条）')
    # 2026-10-31：快捷键搬进 `scenario/interaction/keyboard.js` —— 判据跟着搬家
    kbd = _read('src/renderer/src/scenario/interaction/keyboard.js')
    if "event.key === 'i'" not in kbd or 'ctrlKey' not in kbd:
        fails.append('🔴 沉浸模式没有 Ctrl+I 快捷键')

    # a④ 卡片墙组件本体
    if 'scenario-picker' not in sp:
        fails.append('🔴 ScenarioPicker.vue 根节点没有 data-testid="scenario-picker"')
    if 'openingSituation' not in sp:
        fails.append('🔴 卡片墙没接开局态势（openingSituation）')
    if 'requestAnimationFrame' not in sp:
        fails.append('🔴 缩略图烘焙没有帧让出（会卡住首屏）')

    # a⑤ 纯函数层：开局态势必须走 currentOwnerRef（跨代归属唯一实现）
    if 'currentOwnerRef' not in cards:
        fails.append('🔴 openingSituation 没走 currentOwnerRef —— 开局年早于首条易主日时颜色会全查成灰')

    # a⑥ harness 跳过开关（缺了它 30+ 用例红）——判**代码行**不是判注释提到
    if 'window.__SKIP_SCENARIO_PICKER = true' not in runt_raw:
        fails.append('🔴 run_tests.py 的 MOCK_SCRIPT 没注入 __SKIP_SCENARIO_PICKER —— 30+ 既有用例会挡在卡片墙前')

    # ── 2026-10-17 暮雨实测三条的修复闸门 ──────────────────────────────────
    # b0 卡片墙必须盖全屏 —— 二测「依旧盖不住」的真因：fixed 节点仍在 main-content 内，
    #    `.main-content > *` 的入场动画带 transform，动画期间 fixed 的包含块被改写成
    #    main-content → 动画那 0.28 秒里左侧导航树可见。Teleport 到 body 是彻底解法。
    if 'position: fixed' not in sp:
        fails.append('🔴 卡片墙不是 position: fixed —— 盖不住全屏（暮雨一测）')
    if '<Teleport to="body">' not in sp:
        fails.append('🔴 卡片墙没 Teleport 到 body —— 入场动画的 transform 会在动画期间'
                     '把 fixed 的包含块改写成 main-content，左侧导航树露出（暮雨二测）')
    # b1 全局烘焙进度行（「进入的时候有点卡（且没有任何加载提示）」）
    if 'sp-progress' not in sp or 'bakeTotal' not in sp:
        fails.append('🔴 卡片墙没有全局烘焙进度提示（进入卡顿且无反馈）')
    # b2 Path2D 缓存 —— 每张卡重建 2.7 万点路径 = 进入卡顿主源
    if 'Path2D' not in _read(os.path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'scenarioThumb.js')):
        fails.append('🔴 缩略图烘焙没用 Path2D 缓存 —— 每张卡重建路径，415 省底图进入必卡')
    # b3 选中河流必须有画布高亮（「缺乏视觉提示……只能通过工具栏突然往下挤」）
    #    且增量必须是**屏幕像素口径**（px() 换算）——二测「太粗太离谱」的根因是
    #    直接加世界单位常数（+8 世界单位在放大 4 倍时 = +32 屏幕像素的大白虫）。
    if 'drawSelectedRiverHighlight' not in sm:
        fails.append('🔴 没有选中河流的画布高亮（选中状态只活在工具栏文字里）')
    else:
        i = sm.find('function drawSelectedRiverHighlight')
        seg = sm[i:i + 1600] if i >= 0 else ''
        if 'px(' not in seg:
            fails.append('🔴 选中高亮的线宽没走 px() 屏幕像素换算 —— 放大后会粗成大白虫（暮雨二测）')
    # b4 河流/道路/聚落写口不许同步全量保存（「点一下卡一下」的根因：
    #    每次点击都 JSON.parse(JSON.stringify(整个项目载荷))）
    sed_raw = _read(SEDIT)
    for fn, ln in (('removeBaseMapRiver', 2676), ('updateBaseMapRiver', 2731)):
        i = sed_raw.find(f'function {fn}(')
        if i < 0:
            fails.append(f'🔴 找不到 {fn}（判据失效，需同步本用例）')
            continue
        seg = sed_raw[i:i + 3000]
        if 'saveScenarios();' in seg.split('\n  }')[0]:
            fails.append(f'🔴 {fn} 仍是同步 saveScenarios() —— 每点一下全量序列化项目，必卡（暮雨实测）')

    # ── 2026-10-17 第三轮的 P0 三件（编辑器→卡片墙返回入口 / 缩略图缓存 / 空态分流）──
    # c0 编辑器 → 卡片墙（P0-1）：两侧都要有 —— 组件发 `picker` 事件，App 收。
    #    ⚠️ 判据必须两边都在场：只在组件里加按钮、App 没接 = 点了没反应（本项目最典型的一类）。
    if "backToScenarioPicker" not in app:
        fails.append('🔴 App.vue 没有 backToScenarioPicker（编辑器的「换剧本」点了没反应）')
    if 'slp-picker' not in sm:
        fails.append('🔴 剧本列表头部没有「换剧本」入口（编辑器回卡片墙仍要绕三步）')
    if "$emit('picker')" not in sm:
        fails.append('🔴 没有 picker 事件（换剧本的通路没接）')
    # c1 缩略图成品缓存（P0-2）：模块级缓存 + 内容签名 + 命中即不让出帧。
    thumb = _read(os.path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'scenarioThumb.js'))
    if 'const bakedCache = new Map()' not in thumb:
        fails.append('🔴 缩略图没有**模块级**成品缓存 —— baker 是每实例一份，'
                     '「进卡片墙→改剧本→再回来」仍会把每张卡重画一遍')
    if 'function signatureOf(' not in thumb:
        fails.append('🔴 成品缓存没有内容签名（键只有底图 key 的话，改了地形/归属会留着旧图）')
    if 'if (!cached)' not in sp:
        fails.append('🔴 命中缓存时仍在逐张让出帧（第二次进卡片墙会凭空慢 N 帧）')
    # c1b 面积索引复用（P0-2 的**后半**：缓存上线后实测第二次进墙仍要 1 秒，
    #     真凶是「每条剧本都把同一份净面积重算一遍」——400 省 × 10 剧本实测 1059ms）。
    if 'provinceAreaIndex' not in sp or 'areaOf' not in sp:
        fails.append('🔴 卡片墙没有复用面积索引 —— 每条剧本会把同一份净面积重算一遍（实测 1059ms）'
                     '（纯函数层的硬判据在 unit/test_scenario_cards.js）')
    # c2 空态分流（P0-3）：有底图 / 没底图 走两句不同的引导
    if 'hasBaseMap' not in sp or 'sp-empty-nobasemap' not in sp:
        fails.append('🔴 卡片墙空态没有按「有没有底图」分流 —— 纯新项目里"去建剧本"是条死路')
    if '.map' not in sp:
        fails.append('🔴 空态没提 .map 导入（用户不知道下一步做什么）')
    # c3 空态必须给**能点的按钮**，不是又一句"用上方 +"（+ 在「更多」里，当刻看不见）
    if 'empty-import-map' not in sm or 'triggerMapImport()' not in sm:
        fails.append('🔴 剧本编辑器空态没有接通的「导入 .map 底图」按钮（提示指向看不见的入口）')
    if 'empty-new-basemap' not in sm or 'createEmptyBaseMapFromHint' not in sm:
        fails.append('🔴 空态没有「新建空底图，自己画」按钮')
    if 'pointer-events: auto' not in sm:
        fails.append('🔴 空态容器是 pointer-events:none，按钮没收回事件 = 看得见点不动的假按钮')
    return fails


# ── b 造数据：2 条剧本（各带 hook）+ 底图 + 省份 ─────────────────────────────
JS_SETUP = r"""
(async () => {
  const s = __STORE__;
  const KEY = 'case111';
  const mk = (id, x0, y0) => ({
    id, name: '省' + id.slice(-1).toUpperCase(),
    points: [{x:x0,y:y0},{x:x0+200,y:y0},{x:x0+200,y:y0+140},{x:x0,y:y0+140}],
    biome: 'temperate', coast: true,
  });
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: KEY });
  const bm = s.baseMaps[KEY];
  bm.terrain.length = 0;
  ['prov_a','prov_b','prov_c'].forEach((id, i) => {
    s.addBaseProvince(KEY, mk(id, 100 + i * 240, 100), { checkOverlap: false });
  });
  const P = (id, name, color) => ({ id, name, color });
  const mkSc = (name, order, y0, y1, polities, ownership, hook) => {
    const id = KEY + '/' + name;
    if (s.scenarios[id]) s.removeScenario(id);
    s.createScenario(id, {
      ownerKey: KEY, name, order,
      era: { roman: 'Ⅰ', label: name, startYear: String(y0), endYear: String(y1) },
      polities, ownership, hook,
    });
  };
  mkSc('甲时代', 1, 1200, 1250,
    [P('A1','甲国','#c23b3b'), P('A2','甲南','#4a90d9')],
    { prov_a:'A1', prov_b:'A1', prov_c:'A2' },
    '北方三镇拥兵自立，王朝诏令不出京畿。');
  mkSc('乙时代', 2, 1250, 1300,
    [P('B1','乙国','#5b8c5a')],
    { prov_a:'B1', prov_b:'B1', prov_c:'B1' },
    '旧朝彻底崩解，新秩序在废墟上立起。');
  return JSON.stringify({
    baseMaps: Object.keys(s.baseMaps || {}),
    scenarios: Object.keys(s.scenarios || {}).filter(k => k.startsWith(KEY)),
    hooks: ['甲时代','乙时代'].map(n => (s.scenarios[KEY+'/'+n] || {}).hook || null),
  });
})()
"""

# ── b 点「历史剧本」后断言卡片墙 ─────────────────────────────────────────────
JS_PICKER = r"""
(async () => {
  const picker = document.querySelector('[data-testid="scenario-picker"]');
  const editor = document.querySelector('.scenario-map-container');
  const cards = Array.from(document.querySelectorAll('[data-testid="sp-cards"] .sp-card'));
  const out = {
    pickerVisible: !!picker,
    editorMounted: !!editor,
    cardCount: cards.length,
    names: cards.map(c => ((c.querySelector('.sp-name') || {}).textContent || '').trim()),
    hooks: cards.map(c => ((c.querySelector('.sp-hook') || {}).textContent || '').trim()),
    // 🔴 真·盖全屏的**结构判据**（2026-10-17 二测「左侧导航树依旧盖不住」）：
    //    只断言 `position: fixed` 不够 —— fixed 在带 transform 的祖先里会退化成相对定位，
    //    所以必须断言它**已经不在 .main-content 里**（Teleport 生效）。
    inMainContent: !!(picker && picker.closest('.main-content')),
    parentIsBody: !!(picker && picker.parentElement === document.body),
  };
  // 缩略图真烘了图：中心区域颜色数 > 1（纯色 = 烘焙没跑或底图没进）
  const cv = document.querySelector('[data-testid="sp-cards"] .sp-thumb canvas');
  if (cv) {
    const g = cv.getContext('2d');
    const d = g.getImageData(cv.width/4, cv.height/4, cv.width/2, cv.height/2).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4) seen.add((d[i]<<16)|(d[i+1]<<8)|d[i+2]);
    out.thumbColors = seen.size;
  } else {
    out.thumbColors = 0;
  }
  return JSON.stringify(out);
})()
"""

# ── c 点第二张卡（乙时代）→ 断言编辑器落在它上面 ────────────────────────────
JS_CLICK_CARD = r"""
(async () => {
  const cards = Array.from(document.querySelectorAll('[data-testid="sp-cards"] .sp-card'));
  const target = cards.find(c => ((c.querySelector('.sp-name')||{}).textContent||'').includes('乙时代'));
  if (!target) return JSON.stringify({ err: '找不到乙时代卡片', cards: cards.length });
  target.click();
  return JSON.stringify({ clicked: true });
})()
"""

JS_AFTER_CLICK = r"""
(() => {
  const el = document.querySelector('.scenario-map-container');
  if (!el) return JSON.stringify({ editorMounted: false });
  const sc = el.__vueParentComponent.setupState;
  return JSON.stringify({
    editorMounted: true,
    pickerGone: !document.querySelector('[data-testid="scenario-picker"]'),
    selected: sc.selectedScenario ? sc.selectedScenario.name : null,
    year: sc.tlDate ? sc.tlDate.y : null,
  });
})()
"""

# ── d/e 沉浸模式（真键盘事件）+ 小地图开关 ──────────────────────────────────
JS_IMMERSIVE = r"""
(async () => {
  const el = document.querySelector('.scenario-map-container');
  if (!el) return JSON.stringify({ err: '编辑器没挂载' });
  const sc = el.__vueParentComponent.setupState;
  const key = (extra) => window.dispatchEvent(new KeyboardEvent('keydown',
    Object.assign({ key: 'i', code: 'KeyI', ctrlKey: true, bubbles: true, cancelable: true }, extra || {})));
  const snap = () => ({
    immersive: !!el.classList.contains('immersive'),
    bar: !!document.querySelector('[data-testid="immersive-bar"]'),
    // 时间轴/左栏在沉浸态必须真的不可见（display:none），不是"看不见但还在布局里"
    timelineHidden: (() => {
      const t = document.querySelector('.scenario-timeline-root');
      return t ? getComputedStyle(t).display === 'none' : null;
    })(),
    listHidden: (() => {
      const t = document.querySelector('[data-testid="scenario-list-panel"]');
      return t ? getComputedStyle(t).display === 'none' : null;
    })(),
  });
  const before = snap();
  key();
  await new Promise(r => setTimeout(r, 250));
  const on = snap();
  // e 小地图按钮（沉浸顶条里）：真点，看 showMinimap 拨动
  const mmBtn = document.querySelector('[data-testid="imb-minimap"]');
  const mmBefore = sc.showMinimap;
  if (mmBtn) mmBtn.click();
  await new Promise(r => setTimeout(r, 150));
  const mmAfter = sc.showMinimap;
  key();
  await new Promise(r => setTimeout(r, 250));
  const off = snap();
  return JSON.stringify({ before, on, off, mmBtn: !!mmBtn, mmBefore, mmAfter });
})()
"""


# ── f 换剧本（编辑器 → 卡片墙）+ 缩略图成品缓存（P0-1 / P0-2）──────────────
# 两件事在**同一条操作序列**上量：进卡片墙（第 1 次，必烘）→ 点卡片进编辑器
# → 点「换剧本」回卡片墙（第 2 次，应纯命中缓存）。
# 缓存判据走 `thumbCacheStats()` 读数，不用耗时（耗时判据在 CI 机器上会抖）。
JS_PICKER_BACK = r"""
(async () => {
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 80));
  const out = {};
  const el = () => document.querySelector('.scenario-map-container');
  const btn = (sel) => document.querySelector(sel);
  out.haveSlpPicker = !!btn('[data-testid="slp-picker"]');
  out.haveImbPicker = !!btn('[data-testid="imb-picker"]');
  const mod = await import('/src/utils/scenarioThumb.js');
  out.statsBefore = mod.thumbCacheStats();
  // 点「换剧本」→ 卡片墙
  if (out.haveSlpPicker) btn('[data-testid="slp-picker"]').click();
  await tick(400);
  out.pickerVisible = !!btn('[data-testid="scenario-picker"]');
  out.editorMounted = !!el();
  out.bakingLeft = document.querySelectorAll('.sp-baking').length;
  out.statsAfter = mod.thumbCacheStats();
  // 从卡片墙再点一张卡 → 回编辑器（这条回来的路必须还通）
  const cards = Array.from(document.querySelectorAll('[data-testid="sp-cards"] .sp-card'));
  if (cards.length) cards[0].click();
  await tick(900);
  out.backInEditor = !!el();
  return JSON.stringify(out);
})()
"""

# ── g 空态分流（P0-3）：把底图与剧本临时清空，走「没有底图」那条路 ────────────
# 放在**用例最后**并即时还原：清空会连带把项目标脏，用例之间是各自重新播种的，
# 但"跑完不留脏状态"仍是纪律（下一轮 worker 单跑本用例时不该看到上次的残留）。
JS_EMPTY_STATE = r"""
(async () => {
  const s = __STORE__;
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 80));
  const visible = (e) => !!(e && e.offsetParent !== null && e.getClientRects().length);
  const out = {};
  const bmSnap = JSON.parse(JSON.stringify(s.baseMaps || {}));
  const scSnap = JSON.parse(JSON.stringify(s.scenarios || {}));
  Object.keys(s.baseMaps || {}).forEach(k => delete s.baseMaps[k]);
  Object.keys(s.scenarios || {}).forEach(k => delete s.scenarios[k]);
  await tick(250);

  // g① 编辑器空态：必须有**能点**的导入按钮（不是一句"用上方 +"）
  const imp = document.querySelector('[data-testid="empty-import-map"]');
  const neu = document.querySelector('[data-testid="empty-new-basemap"]');
  out.haveImportBtn = !!imp;
  out.haveNewBtn = !!neu;
  out.importVisible = visible(imp);
  out.importPointerEvents = imp ? getComputedStyle(imp).pointerEvents : null;

  // g② 点「换剧本」→ 卡片墙的空态应是「先导底图」那一支
  const slp = document.querySelector('[data-testid="slp-picker"]');
  if (slp) slp.click();
  await tick(350);
  out.pickerEmptyNoBasemap = !!document.querySelector('[data-testid="sp-empty-nobasemap"]');
  out.emptyText = (document.querySelector('.sp-empty') || {}).textContent || '';
  out.haveEditorBtn = !!document.querySelector('[data-testid="sp-empty-editor"]');

  // g③ 「进入编辑器导入底图」真的回编辑器（按钮不是摆设）
  const eb = document.querySelector('[data-testid="sp-empty-editor"]');
  if (eb) eb.click();
  await tick(400);
  out.backInEditor = !!document.querySelector('.scenario-map-container');

  // g④ 「新建空底图，自己画」真的建出一张底图（空态里的出口必须通）
  const nb = document.querySelector('[data-testid="empty-new-basemap"]');
  if (nb) nb.click();
  await tick(300);
  out.createdKeys = Object.keys(s.baseMaps || {});
  out.statusText = (document.querySelector('.scenario-status-bar') || {}).textContent || '';

  // 还原（先清再填：新键不许留下）
  Object.keys(s.baseMaps || {}).forEach(k => delete s.baseMaps[k]);
  Object.keys(s.scenarios || {}).forEach(k => delete s.scenarios[k]);
  Object.assign(s.baseMaps, bmSnap);
  Object.assign(s.scenarios, scSnap);
  out.restoredBaseMaps = Object.keys(s.baseMaps || {}).length;
  out.restoredScenarios = Object.keys(s.scenarios || {}).length;
  await tick(150);
  return JSON.stringify(out);
})()
"""


def _ev(cdp, js, desc):
    r = eval_json(cdp, js.replace('__STORE__', STORE),
                  required=None, desc=desc)
    if isinstance(r, tuple) and r[0]:
        return r[1]
    return {'__err__': r}


def _click_history(cdp):
    eval_json(cdp,
              "(() => { const b = Array.from(document.querySelectorAll('button'))"
              ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()",
              required=None, desc='点「历史剧本」')


def _viewport(cdp):
    try:
        cdp.send('Emulation.setDeviceMetricsOverride',
                 {'width': 1280, 'height': 800, 'deviceScaleFactor': 1, 'mobile': False})
    except Exception:
        pass


def run(cdp):
    fails = source_gates()
    notes = ['源码闸门 6 组']
    ensure_case_state(cdp)
    _viewport(cdp)

    # ── 默认态（开关在）：点「历史剧本」应直达编辑器（30+ 既有用例的路径）──
    _click_history(cdp)
    try:
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25,
                 desc='直达编辑器（跳过开关生效）')
    except Exception:
        fails.append('🔴 开关在场时点「历史剧本」没进编辑器 —— 30+ 个既有用例的路径被卡片墙挡住了')
        return False, ' | '.join(fails)
    if eval_json(cdp, "JSON.stringify(!!document.querySelector('[data-testid=\"scenario-picker\"]'))",
                 required=None, desc='开关在场时卡片墙不该出现')[1]:
        fails.append('🔴 开关在场时卡片墙还是出现了（跳过开关无效）')
    # 退出编辑器
    eval_json(cdp, "(() => { const b = Array.from(document.querySelectorAll('.scenario-toolbar .back-btn'))[0];"
                   " if (b) b.click(); return 'ok'; })()", required=None, desc='返回世界')
    time.sleep(0.6)

    # ── 关掉开关 + 重载（走产品默认路径）──
    eval_json(cdp, "sessionStorage.setItem('%s', '1'); 'ok'" % SKIP_FLAG,
              required=None, desc='关掉跳过开关')
    cdp.navigate()
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='重载', timeout=30)
    _viewport(cdp)
    ensure_data_ready(cdp)
    open_harness_project(cdp)
    time.sleep(0.5)

    # 造数据（必须在项目打开后：createScenario 是写口）
    setup = _ev(cdp, JS_SETUP, '造 2 条剧本 + 底图省份')
    if not isinstance(setup, dict) or setup.get('__err__'):
        fails.append(f'🔴 造数据失败：{setup}')
        return False, ' | '.join(fails)
    if len(setup.get('scenarios') or []) != 2:
        fails.append(f"🔴 剧本没造出来（{setup.get('scenarios')}）")
    hooks = setup.get('hooks') or []
    if hooks != ['北方三镇拥兵自立，王朝诏令不出京畿。', '旧朝彻底崩解，新秩序在废墟上立起。']:
        fails.append(f'🔴 hook 字段没落库（读回 {hooks}）')

    # ── b 点「历史剧本」→ 卡片墙 ──
    _click_history(cdp)
    try:
        wait_for(cdp, "!!document.querySelector('[data-testid=\"scenario-picker\"]')",
                 timeout=20, desc='卡片墙挂载')
    except Exception:
        fails.append('🔴 关掉开关后点「历史剧本」没有出现卡片墙')
        return False, ' | '.join(fails)
    time.sleep(2.0)   # 等逐张烘焙（2 张卡 = 2 帧 + 余量）
    pk = _ev(cdp, JS_PICKER, '卡片墙断言')
    if not isinstance(pk, dict) or pk.get('__err__'):
        fails.append(f'🔴 卡片墙求值失败：{pk}')
        return False, ' | '.join(fails)
    if pk.get('editorMounted'):
        fails.append('🔴 卡片墙可见时编辑器也挂载了（应该是"先选后进"，不是两个都开）')
    if pk.get('cardCount') != 2:
        fails.append(f"🔴 卡片数不对（{pk.get('cardCount')}，应为 2）")
    if '乙时代' not in (pk.get('names') or []):
        fails.append(f"🔴 卡片上没有剧本名（names={pk.get('names')}）")
    if not any('拥兵自立' in h for h in (pk.get('hooks') or [])):
        fails.append(f"🔴 卡片上没有钩子文案（hooks={pk.get('hooks')}）")
    # 缩略图必须真烘了图 —— 纯色 = 地形层没进（恒为 1 色）
    if (pk.get('thumbColors') or 0) < 4:
        fails.append(f"🔴 缩略图是纯色/近纯色（颜色数 {pk.get('thumbColors')}）—— 烘焙没跑或底图没进")
    # Teleport 的**结构**判据（不是只看 CSS 里有没有 fixed）
    if pk.get('inMainContent'):
        fails.append('🔴 卡片墙 DOM 仍在 .main-content 内 —— 入场动画的 transform 期间 fixed 会退化，'
                     '左侧导航树会露出（暮雨二测）')
    if not pk.get('parentIsBody'):
        fails.append('🔴 卡片墙的父节点不是 body（Teleport 没生效）')

    # ── c 点乙时代卡片 → 编辑器落在它上面 ──
    cc = _ev(cdp, JS_CLICK_CARD, '点乙时代卡片')
    if not isinstance(cc, dict) or cc.get('err'):
        fails.append(f'🔴 点卡片失败：{cc}')
    try:
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=20,
                 desc='点卡片后编辑器挂载')
    except Exception:
        fails.append('🔴 点了卡片但编辑器没挂载')
        return False, ' | '.join(fails)
    time.sleep(1.2)   # 初始剧本选择在 320ms 定时器里（排在 resetTimelineToStart 之后）
    ac = _ev(cdp, JS_AFTER_CLICK, '编辑器落在乙时代')
    if not isinstance(ac, dict) or ac.get('__err__'):
        fails.append(f'🔴 编辑器状态求值失败：{ac}')
    else:
        if not ac.get('pickerGone'):
            fails.append('🔴 进了编辑器但卡片墙还挂着')
        if ac.get('selected') != '乙时代':
            fails.append(f"🔴 卡片没把编辑器带到对应剧本（selected={ac.get('selected')}，应为 乙时代）")
        if ac.get('year') != 1250:
            fails.append(f"🔴 没落到该剧本起始年（year={ac.get('year')}，应为 1250）")

    # ── d/e 沉浸模式 + 小地图 ──
    im = _ev(cdp, JS_IMMERSIVE, 'Ctrl+I 沉浸往返 + 小地图开关')
    if not isinstance(im, dict) or im.get('err'):
        fails.append(f'🔴 沉浸模式求值失败：{im}')
    else:
        on, off = im.get('on') or {}, im.get('off') or {}
        if not on.get('immersive') or not on.get('bar'):
            fails.append(f"🔴 Ctrl+I 没进沉浸模式（class={on.get('immersive')} 顶条={on.get('bar')}）")
        if on.get('timelineHidden') is False:
            fails.append('🔴 沉浸态时间轴还在布局里（display 不是 none）—— 地图占不满')
        if on.get('listHidden') is False:
            fails.append('🔴 沉浸态左栏剧本列表还在布局里')
        if off.get('immersive') or off.get('bar'):
            fails.append('🔴 再按 Ctrl+I 没退出沉浸模式')
        if im.get('mmBtn') and im.get('mmBefore') == im.get('mmAfter'):
            fails.append('🔴 沉浸顶条的小地图按钮点了没拨动 showMinimap（摆设）')

    # ── f P0-1 换剧本通路 + P0-2 成品缓存（同一条操作序列上量）──
    pb = _ev(cdp, JS_PICKER_BACK, '换剧本回卡片墙 + 缓存读数')
    if not isinstance(pb, dict) or pb.get('__err__'):
        fails.append(f'🔴 换剧本求值失败：{pb}')
    else:
        if not pb.get('haveSlpPicker'):
            fails.append('🔴 剧本列表头部没有「换剧本」按钮 —— 回卡片墙仍要绕「返回世界」三步')
        if not pb.get('pickerVisible'):
            fails.append('🔴 点了「换剧本」没回到卡片墙')
        if pb.get('editorMounted'):
            fails.append('🔴 回到卡片墙时编辑器还挂着（应该是二选一）')
        sb, sa = pb.get('statsBefore') or {}, pb.get('statsAfter') or {}
        notes.append(f"缓存 第2次进墙 hits {sb.get('hits')}→{sa.get('hits')} "
                     f"misses {sb.get('misses')}→{sa.get('misses')} size={sa.get('size')} "
                     f"烘图中残留={pb.get('bakingLeft')}")
        if not (sa.get('hits', 0) > sb.get('hits', 0)):
            fails.append(f"🔴 第二次进卡片墙一张都没命中缓存（hits {sb.get('hits')}→{sa.get('hits')}）"
                         '—— "进编辑器改完再回来"仍要重画全部缩略图')
        if sa.get('misses', 0) != sb.get('misses', 0):
            fails.append(f"🔴 第二次进卡片墙又烘了新图（misses {sb.get('misses')}→{sa.get('misses')}）"
                         '—— 内容签名在没改数据时不该变（会让缓存永不命中）')
        if (pb.get('bakingLeft') or 0) > 0:
            fails.append(f"🔴 第二次进卡片墙还在「烘图中…」（{pb.get('bakingLeft')} 张）—— 缓存命中了却仍逐张让出帧")
        if not pb.get('backInEditor'):
            fails.append('🔴 从卡片墙再点一张卡进不去编辑器（回来的路断了）')

    # ── g P0-3 空态分流（用例最后一段，跑完即还原）──
    es = _ev(cdp, JS_EMPTY_STATE, '空态分流（无底图）')
    if not isinstance(es, dict) or es.get('__err__'):
        fails.append(f'🔴 空态求值失败：{es}')
    else:
        if not (es.get('haveImportBtn') and es.get('importVisible')):
            fails.append('🔴 没有底图时编辑器空态没有可点的「导入 .map 底图」按钮')
        if es.get('importPointerEvents') == 'none':
            fails.append('🔴 空态的导入按钮 pointer-events 是 none —— 看得见点不动（假按钮）')
        if not es.get('haveNewBtn'):
            fails.append('🔴 空态没有「新建空底图，自己画」按钮')
        if not es.get('pickerEmptyNoBasemap'):
            fails.append('🔴 没有底图时卡片墙空态没走「先导底图」那一支（仍是"去建剧本"的死路）')
        if '.map' not in (es.get('emptyText') or ''):
            fails.append(f"🔴 卡片墙空态没提 .map 导入（原文：{(es.get('emptyText') or '')[:80]}）")
        if not es.get('backInEditor'):
            fails.append('🔴 卡片墙空态的「进入编辑器导入底图」点了没回编辑器')
        if not (es.get('createdKeys') or []):
            fails.append('🔴 「新建空底图，自己画」点了没建出底图（空态的出口是死路）')
        if (es.get('restoredBaseMaps') or 0) == 0:
            fails.append('🔴 空态用例没把底图还原（污染后续用例）')
        notes.append(f"空态：导入按钮={es.get('haveImportBtn')} 无底图话术={es.get('pickerEmptyNoBasemap')} "
                     f"建空底图→{es.get('createdKeys')} 还原底图={es.get('restoredBaseMaps')}")

    notes.append(f"卡片={pk.get('cardCount')}张 名字={pk.get('names')} 缩略图颜色数={pk.get('thumbColors')}"
                 f" / 点卡→selected={ac.get('selected')}@{ac.get('year')}"
                 f" / 沉浸 {im.get('on', {}).get('immersive')}→{im.get('off', {}).get('immersive')}"
                 f" 时间轴隐藏={im.get('on', {}).get('timelineHidden')}"
                 f" 小地图 {im.get('mmBefore')}→{im.get('mmAfter')}")

    # ── 收尾：清 sessionStorage 开关（跨导航存活，不清会污染后续用例）──
    eval_json(cdp, "sessionStorage.removeItem('%s'); 'ok'" % SKIP_FLAG,
              required=None, desc='清跳过开关')

    if fails:
        return False, ' | '.join(fails) + ' ‖ ' + ' + '.join(notes)
    return True, ' + '.join(notes)
