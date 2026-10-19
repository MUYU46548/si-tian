#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 118：历史剧本必须是一个**独立模块**，不是盖在其他模块上的大号图层（2026-10-18 第十四修）

暮雨原话（第十四轮反馈第 1、4 条）：
  ·「历史剧本选择界面（卡片墙），左下角依旧会露出导航栏，虽然不是很严重的 bug，算视觉上的穿帮。
     此问题应该已经修过至少三次，没有一次修好。」
  ·「历史剧本依旧整体是一个大号图层盖在顶上，想测行星地图点导航栏双击几遍都出不来，
     点返回果然是被整个盖住了。历史剧本我说过是一个**独立的模块**，不是盖在其他模块上面的遮罩。」

案情（DOM 实测，不是读码推测）：
  `App.vue` 旧模板条件只有 `scenarioMode && !scenarioPickerVisible` —— 只管"在不在剧本域"，
  不管"当前看的是哪一层"。用户在剧本编辑器里双击左侧导航树的行星 → `jumpToNode()` →
  `store.selectPlanet()` 把 `viewLevel` 改成 `planet`、`scenarioMode` 仍为 true：
  ① ScenarioMap **不卸**、② PlanetMap **同时挂载**；两者都 `height:100%` 且同在 `.main-content`，
  **逐个像素完全重叠**（实测 200,127,1080,647 vs 200,774,1080,647 —— 同尺寸同位置），
  而模板里 ScenarioMap 排在前面 ⇒ 行星地图**看得见 0 像素、点不到一下**。
  `elementFromPoint(画布中心)` 命中的是 ScenarioMap 的 canvas（这条是"被盖住"最硬的判据）。

本用例的判据（每条都有反向对照）：
  a 源码闸门：编辑器的 `v-if` **必须**挂在层级门上（`scenarioEditorVisible` + `viewLevel === 'world'`）；
    卡片墙必须 Teleport 到 body（穿帮的结构性判据，test_111 已立，这里守住不退）；
    必须存在回程浮标 + 两个按钮。
  b 剧本编辑器内：ScenarioMap 在场、导航树在场、**互不重叠**；
    elementFromPoint(画布中心) 必须是 ScenarioMap 的 canvas。
  c **产品路径**双击导航树行星 → ScenarioMap 必须卸下（反向对照：修前它还在、且尺寸与
    PlanetMap 完全相同）、elementFromPoint(画布中心) 必须是 PlanetMap 的 canvas、
    回程浮标必须出现。
  d 点浮标 → 回剧本编辑器（ScenarioMap 回来、PlanetMap 消失、viewLevel 回 world）。
  e 反向：在行星地图里**点导航树双击又一遍**，ScenarioMap 不许复活（"盖住"的复发探针）；
    点行星地图的「返回」→ 也不许复活。
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for                                  # noqa: E402
from lib.helpers import ensure_case_state, open_harness_project          # noqa: E402

APP = "#app.__vue_app__._instance.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
# ⚠️ 探针源码里**不能**出现裸的 `const st = document.querySelector('#app')…`：
#    CDP 的 eval 按表达式解析，开头是 `#app` 时 V8 会当成**私有字段**报
#    "Private field '#app' must be declared in an enclosing class"（本轮踩过）。
#    一律套一层括号（`const st = (…)`）。
APP_STATE_EXPR = "(document.querySelector('#app').__vue_app__._instance.setupState)"
SMC = "document.querySelector('.scenario-map-container')"
PMC = "document.querySelector('.planet-map-container')"

HISTORY_BTN = ("(() => { const b = Array.from(document.querySelectorAll('button'))"
               ".find(x => (x.textContent || '').includes('\u5386\u53f2\u5267\u672c'));"
               " if (b) b.click(); return 'ok'; })()")

# 双击导航树里**第一个 planet 行**（走 TreeItem 的 @dblclick → jumpToNode，和用户手一样）
DBL_PLANET = r"""(() => {
  const rows = Array.from(document.querySelectorAll('.tree-navigation .tree-node'));
  const seen = [];
  for (const it of rows) {
    const n = it.__vueParentComponent && it.__vueParentComponent.props
              && it.__vueParentComponent.props.node;
    if (!n) { seen.push('(no-node)'); continue; }
    seen.push(n.layer + ':' + n.name);
    if (n.layer === 'planet') {
      it.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      return JSON.stringify({ ok: true, name: n.name, id: n.id });
    }
  }
  return JSON.stringify({ ok: false, seen: seen.slice(0, 8) });
})()"""

# 一次取回"层叠事实"：谁在场 / 各自矩形 / 画布中心命中谁
LAYOUT = r"""(() => {
  const st = %s;
  const box = (s) => { const el = document.querySelector(s); if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const mc = box('.main-content');
  const cx = Math.round(mc.x + mc.w / 2), cy = Math.round(mc.y + mc.h / 2);
  const hitEl = document.elementFromPoint(cx, cy);
  const chain = []; for (let e = hitEl; e && chain.length < 4; e = e.parentElement)
    chain.push(e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className
      ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : ''));
  const scenario = box('.scenario-map-container');
  const planet = box('.planet-map-container');
  const inter = (a, b) => { if (!a || !b) return 0;
    const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return Math.round(w * h); };
  const tree = box('.tree-navigation');
  return JSON.stringify({
    viewLevel: st.store.viewLevel,
    scenarioMode: st.scenarioMode,
    pickerVisible: st.scenarioPickerVisible,
    editorVisible: st.scenarioEditorVisible,
    steppedOut: st.scenarioSteppedOut,
    scenarioBox: scenario, planetBox: planet, treeBox: tree,
    overlapScenarioPlanet: inter(scenario, planet),
    overlapScenarioTree: inter(scenario, tree),
    centerHit: chain,
    chip: box('[data-testid=scenario-return-chip]'),
    worldSelector: !!document.querySelector('.world-selector'),
    fails: [],
  });
})()""" % APP_STATE_EXPR


def _ev(cdp, js, desc):
    v = cdp.eval(js)
    if isinstance(v, dict) and '__err__' in v:
        raise RuntimeError(f'{desc} 求值异常：{str(v)[:300]}')
    return v


APP_STATE_EXPR = "(document.querySelector('#app').__vue_app__._instance.setupState)"


def _layout(cdp):
    v = cdp.eval(LAYOUT)
    if isinstance(v, dict) and '__err__' in v:
        raise RuntimeError(f'布局探针求值异常：{str(v)[:300]}')
    return json.loads(v)


def _code_only(src):
    """剥掉注释再判源码（判据不许被注释里的字样骗过 —— 本仓既定口径）"""
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


def source_gates():
    root = os.path.join(os.path.dirname(__file__), '..', '..', '..')

    def read(rel):
        with open(os.path.join(root, rel), encoding='utf-8') as f:
            return f.read()

    app = _code_only(read('src/renderer/src/App.vue'))
    picker = _code_only(read('src/renderer/src/components/ScenarioPicker.vue'))
    fails = []

    # a① 编辑器必须**跟着层级**卸下：v-if 绑 scenarioEditorVisible，且该 computed 里出现
    #     `viewLevel === 'world'`。判据要求成对出现 —— 只写一半（有 computed 名字但门里没层级）
    #     就是"看着修了、其实还是盖着"。
    if 'v-if="scenarioEditorVisible"' not in app:
        fails.append('🔴 App.vue 的 <scenario-map> 没有绑 scenarioEditorVisible —— '
                     '剧本编辑器不跟层级走，还会盖住行星地图')
    seg = app.split('const scenarioEditorVisible', 1)
    if len(seg) < 2:
        fails.append('🔴 App.vue 找不到 scenarioEditorVisible（编辑器与层级的互斥门）')
    else:
        head = seg[1][:400]
        if "viewLevel === 'world'" not in head:
            fails.append("🔴 scenarioEditorVisible 里没有 `viewLevel === 'world'` —— "
                         "门只判了「在不在剧本域」，没判「看的是哪一层」（这正是第十四修的病根）")
    if 'const scenarioSteppedOut' not in app:
        fails.append('🔴 App.vue 没有 scenarioSteppedOut（走开了却没有回程 = 另一种"点了没反应"）')
    if 'data-testid="scenario-return-chip"' not in app or 'data-testid="scenario-return-btn"' not in app:
        fails.append('🔴 App.vue 没有回程浮标/回程按钮')
    # ⚠️ 旧条件（只有 scenarioMode + pickerVisible）不许复活
    if 'v-if="scenarioMode && !scenarioPickerVisible"' in app:
        fails.append('🔴 旧的 <scenario-map> 条件还在（不判层级 = 会与行星地图同屏重叠）')

    # a② 卡片墙穿帮（第 1 条反馈）的结构判据：Teleport 到 body + fixed 全屏。
    if '<Teleport to="body">' not in picker:
        fails.append('🔴 卡片墙没有 Teleport 到 body —— 左侧导航树又会在入场动画期间露出来（穿帮）')
    if 'position: fixed; inset: 0;' not in picker:
        fails.append('🔴 卡片墙不是 fixed 全屏（absolute 盖不住 .main-content 的兄弟节点）')
    return fails


def run(cdp):
    fails = source_gates()
    notes = ['源码闸门 5 条']

    ensure_case_state(cdp)

    # ── b 进剧本编辑器（harness 的 __SKIP_SCENARIO_PICKER 在场 → 直达编辑器）──
    _ev(cdp, HISTORY_BTN, '点历史剧本')
    try:
        wait_for(cdp, "!!" + SMC, timeout=25, desc='剧本编辑器挂载')
    except Exception:
        return False, '点「历史剧本」没进编辑器（用例前提不成立）'
    time.sleep(0.8)

    b = _layout(cdp)
    if b['viewLevel'] != 'world':
        fails.append(f"进编辑器后 viewLevel={b['viewLevel']}（应为 world）")
    if b['scenarioBox'] and b['treeBox'] and b['overlapScenarioTree'] > 0:
        fails.append(f"剧本编辑器与导航树重叠 {b['overlapScenarioTree']} px² —— 剧本域没有自己的空间")
    if 'scenario-map-container' not in ' '.join(b['centerHit']):
        fails.append(f"编辑器内画布中心命中的不是 ScenarioMap：{b['centerHit']}")
    if b['planetBox']:
        fails.append('编辑器内 PlanetMap 也挂载了（两个画布同屏 = 迟早互相盖）')
    notes.append(f"b 编辑器内：ScenarioMap={b['scenarioBox']} / 树重叠 {b['overlapScenarioTree']} px²")

    # ── c 产品路径：双击导航树的行星 ──
    d = _ev(cdp, DBL_PLANET, '双击导航树行星')
    d = json.loads(d) if isinstance(d, str) else d
    if not d.get('ok'):
        return False, ' | '.join(fails) + f" ⇒ 导航树里没有 planet 行：{d}"
    time.sleep(1.2)
    c = _layout(cdp)
    if c['viewLevel'] != 'planet':
        fails.append(f"双击行星后 viewLevel={c['viewLevel']}（应为 planet）")
    if c['scenarioBox']:
        fails.append(f"🔴 进了行星地图，剧本编辑器**仍然挂载**（{c['scenarioBox']}）"
                     f"（与 PlanetMap {c['planetBox']} 重叠 {c['overlapScenarioPlanet']} px²）"
                     f"—— 它排在模板前面、又在同一层，就是把行星地图整块盖住（用户第 4 条反馈）")
    if not c['planetBox']:
        fails.append('双击行星后 PlanetMap 没有挂载（跳转链路断了）')
    if 'planet-map-container' not in ' '.join(c['centerHit']):
        fails.append(f"🔴 画布中心点被谁吃掉了：{c['centerHit']} —— 用户点不到行星地图")
    if not c['chip']:
        fails.append('走开了却没有回程浮标（去得了行星地图，回不了剧本）')
    else:
        sb = c['chip']
        if sb['y'] + sb['h'] > 800 - 20:
            fails.append(f"回程浮标压住状态栏（{sb}）")
        if sb['y'] < 200 and sb['x'] < 700:
            fails.append(f"回程浮标落在画布主操作区（{sb}）—— 会吃掉画布控件的点击")
    notes.append(f"c 双击行星后：ScenarioMap 卸下={c['scenarioBox'] is None} / "
                 f"中心命中={c['centerHit'][:2]} / 浮标={c['chip']}")

    # ── d 点浮标回编辑器 ──
    _ev(cdp, "(() => { const b = document.querySelector('[data-testid=scenario-return-btn]');"
             " if (b) b.click(); return 'ok'; })()", '点回程浮标')
    time.sleep(1.0)
    e = _layout(cdp)
    if not e['scenarioBox']:
        fails.append('点回程浮标后剧本编辑器没回来')
    if e['planetBox']:
        fails.append('回到编辑器后 PlanetMap 还挂着（应该只有剧本域的画布）')
    if e['viewLevel'] != 'world':
        fails.append(f"点回程浮标后 viewLevel={e['viewLevel']}（应为 world）")
    if e['steppedOut']:
        fails.append('回到编辑器后 steppedOut 仍为真（浮标该消失）')
    notes.append(f"d 回程：编辑器={e['scenarioBox'] is not None} / viewLevel={e['viewLevel']}")

    # ── e 反向：在行星地图里再双击一遍树，以及点行星地图的「返回」──
    _ev(cdp, DBL_PLANET, '再双击行星')
    time.sleep(1.0)
    _ev(cdp, DBL_PLANET, '第三遍双击行星')
    time.sleep(1.0)
    f = _layout(cdp)
    if f['scenarioBox']:
        fails.append('🔴 反复双击导航树后剧本编辑器复活了 —— "盖住"复发')
    if 'planet-map-container' not in ' '.join(f['centerHit']):
        fails.append(f"反复双击后画布中心命中的不是 PlanetMap：{f['centerHit']}")
    _ev(cdp, "(() => { const b = Array.from(document.querySelectorAll('.planet-map-container button'))"
             ".find(x => (x.textContent || '').includes('\u8fd4\u56de'));"
             " if (b) b.click(); return 'ok'; })()", '点行星地图返回')
    time.sleep(1.0)
    g = _layout(cdp)
    if g['scenarioBox']:
        fails.append('🔴 点行星地图的「返回」后剧本编辑器又盖上来（用户原话就是这条）')
    notes.append(f"e 反向：反复双击后 scenarioBox={f['scenarioBox']} / 返回后 scenarioBox={g['scenarioBox']}")

    # ── f 入口/回程在**每一层**都可走（目标 ②：含从行星视图等任意层级进入/返回）──
    #    修前的形状：用户必须"回到世界选择页"才找得到「历史剧本」按钮，而一旦在剧本域里
    #    走到行星层就被盖住（c/e 两段守的就是这个）。这一段补的是**反方向**：
    #    从更深的层能不能回到世界选择页、再进剧本，以及**退出剧本域后视口位置是否保留**。
    #
    #    🔴 一条口径（第一版写错、被诊断读数教回来）：`exitScenarioMode()` **只**关剧本域，
    #       **不动 `viewLevel`** —— 用户刚才在恒星系层，退出剧本后就停在恒星系层
    #       （这是刻意的：退出 ≠ 把视口也一并复位）。所以"再进剧本"之前必须**自己走回**
    #       世界选择页，判据不能假设"退出即回家"。
    _ev(cdp, "(() => { const b = document.querySelector('[data-testid=scenario-return-exit]');"
             " if (b) b.click(); return 'ok'; })()", '退出剧本域')
    time.sleep(0.6)
    left = _layout(cdp)
    if left['scenarioBox'] or left['scenarioMode']:
        fails.append(f"点「退出剧本」后剧本域没有收干净（scenarioMode={left['scenarioMode']}）")
    if left['viewLevel'] != 'system':
        fails.append(f"退出剧本域后视口位置被改了（停在 {left['viewLevel']}，应保留在 system）"
                     f"—— 退出剧本不该顺带把视口复位")
    notes.append(f"f0 退出剧本域：scenarioMode=False / 视口保留在 {left['viewLevel']}")
    # 逐层返回世界选择页（产品路径：每层工具栏的「← 返回」）
    for _ in range(5):
        if _layout(cdp)['viewLevel'] == 'world':
            break
        _ev(cdp, "(() => { const b = Array.from(document.querySelectorAll('.main-content button'))"
                 ".find(x => (x.textContent || '').includes('\u8fd4\u56de'));"
                 " if (b) { b.click(); return 'ok'; } return 'no-back'; })()", '逐层返回')
        time.sleep(0.7)
    back = _layout(cdp)
    if back['viewLevel'] != 'world':
        fails.append(f"逐层返回没能回到世界选择页（停在 {back['viewLevel']}）")
        return False, ' | '.join(notes) + ' ⇒ ' + ' ；'.join(fails)
    if not back['worldSelector']:
        fails.append('回到世界选择页后 WorldSelector 没有挂载')
    has_btn = _ev(cdp, "(() => { const b = Array.from(document.querySelectorAll('button'))"
                       ".find(x => (x.textContent || '').includes('\u5386\u53f2\u5267\u672c'));"
                       " return b ? 'yes' : 'no'; })()", '找历史剧本按钮')
    if has_btn != 'yes':
        fails.append('回到世界选择页后找不到「历史剧本」入口（进不去剧本域）')
    notes.append(f"f1 任意层级回程：{left['viewLevel']}→逐层→{back['viewLevel']}，入口={has_btn}")

    # f2 再进一次剧本域（产品入口），编辑器必须挂回来
    _ev(cdp, HISTORY_BTN, '再点历史剧本')
    try:
        wait_for(cdp, "!!" + SMC, timeout=25, desc='再次进编辑器')
    except Exception:
        diag = _ev(cdp, "(() => { const st = (%s); return JSON.stringify({"
                        "skipFlag: String(window.__SKIP_SCENARIO_PICKER),"
                        "scenarioMode: st.scenarioMode, picker: st.scenarioPickerVisible,"
                        "viewLevel: st.store.viewLevel,"
                        "pickerDom: !!document.querySelector('.scenario-picker'),"
                        "historyBtn: !!Array.from(document.querySelectorAll('button'))"
                        ".find(x => (x.textContent || '').includes('\u5386\u53f2\u5267\u672c')) }); })()"
                  % APP_STATE_EXPR, '诊断')
        fails.append(f"回到世界选择页后再进不去剧本编辑器：{diag}")
        return False, ' | '.join(notes) + ' ⇒ ' + ' ；'.join(fails)
    time.sleep(0.5)
    again = _layout(cdp)
    if not again['scenarioBox']:
        fails.append('再次进入剧本域后编辑器没有挂载')
    notes.append('f2 世界选择页入口可重复进入剧本编辑器')

    if fails:
        return False, ' | '.join(notes) + ' ⇒ ' + ' ；'.join(fails)
    return True, ' | '.join(notes)
