#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 123：手势期间的自动保存必须顺延（第十九修·一，2026-10-19）

## 为什么有这条用例

真实 desite 底图（200 省 / 载荷 2.07MB）实测：一次编辑之后 800ms 防抖到点时，
主线程被**整块占住 519ms**；若那一刻人还在拖鼠标，最长帧 **596ms**。
所以「连续拖笔已经从 29ms/事件 修到 2ms/事件」，手感**仍然会一顿** —— 就是这一顿。

这次保存**没有理由必须立刻发生**：它是防抖保存，不是用户按下的 Ctrl+S。

## 修法与三条口径（见 `utils/interactionGate.js` 文件头）

  ① 闸门只影响**自动**保存 —— 显式 flush / Ctrl+S / 关项目一律照常写（数据安全优先）；
  ② 顺延有 **5s 上限**（防"某个手势没配对"把保存饿死 → 到点强制写一次，记 `forced`）；
  ③ 抬手后有**静默窗口**（把 mouseup 里收笔那一拍让开）。

## 判据（不许按墙钟时间判 —— 慢机器上会假红）

  a) 源码闸门：组件真接线 / 两条保存链都过 `check()` / flush **不**经闸门 / 不许留裸定时器保存
  b) 手势中到点的保存**真的没发生**（`__projectCalls` 里没有新的 `save`），`defers` 在涨
  c) 抬手后同一批改动**真的补存**（save 计数 +1、dirty 归零）
  d) 显式 flush 手还按着也**立刻写**（闸门不能变成"保存被卡住"）
  e) 上限兜底：手势一直不放，5s 后强制保存一次（`forced >= 1`）—— 数据不饿死
  f) 真事件接线：真实 mousedown / mouseup 能开关闸门（不是只有函数级 API 在动）
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json            # noqa: E402
from lib.helpers import ensure_data_ready          # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"

# 页面侧公共前置：store / 组件 setupState / projectStore 实例 / 保存计数
PRELUDE = """const sc = __SM__;
  const s = sc.store;
  const app = document.querySelector('#app').__vue_app__;
  const pinia = app.config.globalProperties.$pinia;
  const PS = (await import('/src/store/projectStore.js')).useProjectStore(pinia);
  const G = await import('/src/utils/interactionGate.js');
  const saves = () => (window.__projectCalls || []).filter((c) => c.op === 'save').length;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [], notes = {};
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + e + ')' : '')); };
"""


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
    fails, notes = [], []

    gate = _code_only(_read('src/renderer/src/utils/interactionGate.js'))
    for needle, label in [
        ('export function beginInteraction', '公开 begin（组件接线用）'),
        ('export function endInteraction', '公开 end'),
        ('export function isInteractionActive', '公开"人还在画布上"判定'),
        ('export function createSaveDeferrer', '顺延判定器（每个保存链一份）'),
        ('export const SAVE_MAX_DEFER_MS = 5000', '顺延上限（防手势没配对把保存饿死）'),
        ('export const SAVE_DEFER_RETRY_MS', '顺延后的复查间隔'),
        ("if (waited >= maxDeferMs)", '上限判定真的在（不能只声明常量）'),
        ('interactionGateStats.forced += 1', '到上限强制保存要留计数（用例据它判兜底）'),
    ]:
        if needle not in gate:
            fails.append(f'interactionGate 缺：{label}（`{needle}`）')

    gd = _code_only(_read('src/renderer/src/store/geodata.js'))
    for needle, label in [
        ("from '../utils/interactionGate'", 'geodata 接上闸门'),
        ('createSaveDeferrer()', '三条保存链各持顺延状态'),
        ("autoSaveDeferrer.check() === 'wait'", '地理链：到点先问闸门'),
        ("scenarioSaveDeferrer.check() === 'wait'", '剧本链：到点先问闸门'),
        ("mapSaveDeferrer.check() === 'wait'", '行星图链：到点先问闸门'),
        ('function runAutoSave()', '地理链接上"到点"单一入口'),
        ('function runAutoSaveMap()', '行星图链接上单一入口'),
        ('function runScenarioAutoSave()', '剧本链接上单一入口'),
        ('return;\n    }\n    saveGeodata()', '顺延后必须**提前返回**（否则照样卡）'),
    ]:
        if needle not in gd:
            fails.append(f'geodata 缺：{label}（`{needle}`）')
    if 'setTimeout(async () => {\n      await saveGeodata()' in gd:
        fails.append('geodata 还留着"裸定时器里直接 saveGeodata"（绕过闸门的旧实现）')

    ps = _code_only(_read('src/renderer/src/store/projectStore.js'))
    for needle, label in [
        ("from '../utils/interactionGate'", 'projectStore 接上闸门'),
        ("autoSaveDeferrer.check() === 'wait'", '项目链：到点先问闸门（这是 519ms 的主因）'),
        ('function runProjectAutoSave()', '项目链接上单一入口'),
    ]:
        if needle not in ps:
            fails.append(f'projectStore 缺：{label}（`{needle}`）')

    # 🔴 数据安全红线：显式落盘不许被闸门挡住（手还按着也必须能写）
    #    判法：flushSave 的函数体里不许出现 deferrer —— 一旦接进去，"退出前落盘"就成了"看心情"
    for name in ('flushSave',):
        idx = ps.find('async function ' + name)
        if idx < 0:
            fails.append(f'projectStore 找不到 {name}')
        else:
            body = ps[idx:idx + 900]
            if 'Deferrer' in body:
                fails.append(f'projectStore.{name} 里出现 Deferrer —— 显式落盘不许被闸门顺延')
    for name in ('flushSave',):
        idx = gd.find('async function ' + name)
        if idx < 0:
            fails.append(f'geodata 找不到 {name}')
        else:
            body = gd[idx:idx + 1400]
            if 'Deferrer' in body:
                fails.append(f'geodata.{name} 里出现 Deferrer —— 退出前落盘不许被闸门顺延')
            if 'await saveGeodata()' not in body:
                fails.append('geodata.flushSave 没有真的 saveGeodata（只清定时器 = 丢改动）')

    sm = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
    for needle, label in [
        ("import { beginInteraction, endInteraction } from '../utils/interactionGate'",
         '组件真的接线（不是只有模块躺着）'),
        ('beginInteraction(\'scenario-canvas\')', 'mousedown 开闸门'),
        ('endInteraction(\'scenario-canvas\')', 'mouseup 关闸门'),
        ('if (canvasGateArmed) {', '配对守卫（mouseleave 也会走 onMouseUp，不能无条件 end）'),
    ]:
        if needle not in sm:
            fails.append(f'ScenarioMap 缺：{label}（`{needle}`）')

    notes.append('源码闸门 24 项' + ('全过' if not fails else f'缺 {len(fails)} 项'))
    return fails, notes


B1_JS = """(async () => { __PRELUDE__
  // ══ b) 手势中到点的保存必须被顺延 ═══════════════════════════════════════════
  G.resetInteractionGate();
  const n0 = saves();
  G.beginInteraction('case123');
  s.scheduleAutoSave();              // 地理链（800ms 防抖）
  s.scheduleAutoSaveScenarios();     // 剧本链（300ms 防抖）
  s.syncCanvasToProject('case123');  // 项目链（800ms 防抖）—— 同时置 dirty
  await wait(1700);
  notes.n0 = n0; notes.n1 = saves();
  ok('b1 手势期间自动保存被顺延（一次都没写盘）', saves() === n0, `${n0} → ${saves()}`);
  ok('b1 顺延计数在涨（闸门真的被走到，不是碰巧没到点）',
     G.interactionGateStats.defers >= 2, JSON.stringify(G.interactionGateStats));
  ok('b1 改动没丢（dirty 仍为 true）', PS.dirty === true, String(PS.dirty));
  return JSON.stringify({ fails, notes });
})()"""

B2_JS = """(async () => { __PRELUDE__
  // ══ c) 抬手后同一批改动必须补存 ═════════════════════════════════════════════
  const n1 = saves();
  G.endInteraction('case123');
  await wait(1500);
  notes.n2 = saves();
  ok('c1 抬手后补存了（save 计数增加）', saves() > n1, `${n1} → ${saves()}`);
  ok('c2 补存后 dirty 归零', PS.dirty === false, String(PS.dirty));
  ok('c3 没有"没有 begin 的 end"', G.interactionGateStats.unmatchedEnds === 0,
     JSON.stringify(G.interactionGateStats));
  return JSON.stringify({ fails, notes });
})()"""

D_JS = """(async () => { __PRELUDE__
  // ══ d) 显式落盘不受闸门影响（手还按着也立刻写）════════════════════════════════
  G.beginInteraction('case123-flush');
  s.syncCanvasToProject('case123-flush');
  const n2 = saves();
  const r = await PS.flushSave();
  ok('d1 闸门开着也立刻写盘（数据安全优先于手感）', saves() > n2, `${n2} → ${saves()}`);
  ok('d2 flush 有成功回执', !!(r && r.success === true), JSON.stringify(r));
  ok('d3 flush 后 dirty 归零', PS.dirty === false, String(PS.dirty));
  G.endInteraction('case123-flush');
  return JSON.stringify({ fails, notes });
})()"""

E1_JS = """(async () => { __PRELUDE__
  // ══ e) 上限兜底：手势一直不放，5s 后必须强制写一次 ══════════════════════════
  G.endInteraction('case123-flush');
  G.resetInteractionGate();
  G.beginInteraction('case123-cap');
  s.syncCanvasToProject('case123-cap');
  notes.n3 = saves();
  return JSON.stringify({ fails, notes });
})()"""

E2_JS = """(async () => { __PRELUDE__
  const n3 = (window.__caseN3 = window.__caseN3 || 0);
  ok('e1 上限兜底：强制保存了一次（数据不饿死）', saves() > n3, `${n3} → ${saves()}`);
  ok('e2 forced 计数 >= 1', G.interactionGateStats.forced >= 1,
     JSON.stringify(G.interactionGateStats));
  G.endInteraction('case123-cap');
  await wait(300);
  return JSON.stringify({ fails, notes });
})()"""

F_JS = """(async () => { __PRELUDE__
  // ══ f) 真事件接线：mousedown/mouseup 真的开关闸门 ═════════════════════════════
  const KEY = 'case123';
  s.baseMaps = { ...s.baseMaps, [KEY]: {
    id: KEY, name: '用例123底图',
    terrain: [{ id: 'p123', name: '用例123陆地', kind: 'land',
      points: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }] }],
    referenceImages: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } };
  sc.baseMapKey = KEY;
  await wait(120);
  G.resetInteractionGate();
  const cvs = sc.canvas;
  const rc = cvs.getBoundingClientRect();
  const mk = (type, buttons) => new MouseEvent(type, {
    clientX: rc.left + 60, clientY: rc.top + 60, button: 0, buttons,
    bubbles: true, cancelable: true,
  });
  cvs.dispatchEvent(mk('mousedown', 1));
  ok('f1 真实 mousedown 后闸门开着', G.activeInteractionCount() === 1,
     JSON.stringify(G.describeInteractionGate()));
  cvs.dispatchEvent(mk('mouseup', 0));
  ok('f2 真实 mouseup 后闸门关了', G.activeInteractionCount() === 0,
     JSON.stringify(G.describeInteractionGate()));
  ok('f3 全程没有"没有 begin 的 end"', G.interactionGateStats.unmatchedEnds === 0,
     JSON.stringify(G.interactionGateStats));
  return JSON.stringify({ fails, notes });
})()"""


def _js(tpl):
    return tpl.replace('__PRELUDE__', PRELUDE).replace('__SM__', SM)


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
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", desc='ScenarioMap 挂载', timeout=25)
    except RuntimeError as e:
        return False, f'ScenarioMap 未挂载：{e}'
    time.sleep(1.2)

    for tpl, tag in ((B1_JS, 'b'), (B2_JS, 'c'), (D_JS, 'd')):
        ok, res = eval_json(cdp, _js(tpl))
        if not ok:
            return False, f'{tag} 段探针失败: {res}'
        fails += res.get('fails', [])
        notes.append(f'{tag} 段 notes={json.dumps(res.get("notes"), ensure_ascii=False)}')

    # e 段：顺延要跨过 5s 上限，必须**拆成两次 eval**（CDP 单次读超时 15s，塞一起会崩在超时上）
    ok, res = eval_json(cdp, _js(E1_JS))
    if not ok:
        return False, f'e1 段探针失败: {res}'
    fails += res.get('fails', [])
    n3 = (res.get('notes') or {}).get('n3', 0)
    cdp.eval(f"window.__caseN3 = {int(n3)}; 'ok'")
    # 上限 5000ms **从"这条保存到点"算起**（E1 里 sync 之后还有 800ms 防抖）
    # → 强制保存最早出现在 E1 之后 ~5.8s。留足余量，别把用例卡在临界点上。
    time.sleep(7.2)
    ok, res = eval_json(cdp, _js(E2_JS))
    if not ok:
        return False, f'e2 段探针失败: {res}'
    fails += res.get('fails', [])
    notes.append('e 段 notes=' + json.dumps(res.get('notes'), ensure_ascii=False))

    ok, res = eval_json(cdp, _js(F_JS))
    if not ok:
        return False, f'f 段探针失败: {res}'
    fails += res.get('fails', [])
    notes.append('f 段 notes=' + json.dumps(res.get('notes'), ensure_ascii=False))

    # 收尾：别把闸门留在"进行中"（否则后续用例的保存全被顺延到 5s）
    cdp.eval("""(async () => {
      const G = await import('/src/utils/interactionGate.js');
      while (G.activeInteractionCount() > 0) G.endInteraction('cleanup');
      G.resetInteractionGate();
      return 'ok';
    })()""")

    return (not fails), ' | '.join(fails) if fails else ' | '.join(notes)
