#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 120：**底图编辑模式** —— 地理类工具与日常剧本编辑分开（2026-10-18 第十七修）

暮雨原话（2026-10-18 下午）：
  「事实上我甚至觉得这玩意得进底图编辑，**底图编辑要单开一个编辑模式**，不要和日常的剧本编辑混在一起。」

修前的形态（读代码确认）：主行是日常动作（选择 / 画省份 / 改归属 / 改形状 / 更多），
而「更多」里**同时**装着两类东西 ——
  · 底图/地理：河流 / 自动河流 / 道路 / 地貌 / 地名 / 标记 / 聚落 / 文化 / 宗教 / 高度 / 群系 / 裁到海岸线 / 着色档
  · 省份批量：拆分 / 合并 / 点击填充 / 描轮廓 / Voronoi 铺底 / 删除
即**编辑对象不同（地块 vs 覆盖其上的历史归属），却在同一排按钮里** —— 这正是用户说的"混"。

本轮口径（**只做分组与可见性，不改任何工具语义**）：
  · 新增 `basemapEditMode`；主行多一枚 `basemap-edit-toggle`（当前模式的唯一读数）；
  · 开模式 → 出现 `basemap-row`，地理类工具集中在那里（`data-testid="basemap-tool-<id>"`）；
  · 🔴 **选到地理类工具会自动开模式**（`setTool` 的门）—— 这样既有 60+ 个直接 `setTool('river')`
    的用例**零迁移**，而人永远看得见"现在在哪个模式"。

判据（全部 DOM 实测）：
  a 源码闸门：模式 state / 开关按钮 / 地理行 / `setTool` 的门 / 工具清单单源（`BASEMAP_TOOLS`）都在；
  b 默认（未开）：**没有**地理行；河流类工具按钮不在主行（收敛到模式里）；
  c 点开关 → 地理行出现，且 `data-testid` 认得出的地理工具 ≥8 个；再点 → 行消失；
  d **反向（零迁移）**：直接 `setTool('river')` → 模式**自动打开**且地理行出现
     （既有用例与"用户点河流"走的是同一条路）；
  e 日常工具仍在主行、且点它**不会**把模式关掉（用户可能还要连着画几条河）；
  f 关模式后回日常：主行工具仍可用（不是"锁住能力"，只是分组）。
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for                                   # noqa: E402
from lib.helpers import ensure_case_state                                 # noqa: E402

SMC = "document.querySelector('.scenario-map-container')"
SM = SMC + ".__vueParentComponent.setupState"
ROOT = os.path.join(os.path.dirname(__file__), '..', '..', '..')


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def _code_only(src):
    src = re.sub(r'<style[\s\S]*?</style>', '', src)
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
    fails = []
    sm = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
    for sym in ('basemapEditMode', 'basemap-edit-toggle', 'basemap-row', 'BASEMAP_TOOLS', 'BASEMAP_TOOL_IDS'):
        if sym not in sm:
            fails.append(f'🔴 ScenarioMap 缺少底图编辑模式的接线：{sym}')
    # setTool 的门：选到地理类工具自动开模式（这是"零迁移"的关键）
    seg = sm.split('function setTool(', 1)
    if len(seg) < 2:
        fails.append('🔴 找不到 setTool')
    else:
        head = seg[1][:600]
        if 'BASEMAP_TOOL_IDS.has(t)' not in head or 'basemapEditMode.value = true' not in head:
            fails.append('🔴 setTool 没有"选到地理类工具就自动开模式"的门 —— '
                         '既有用例直接 setTool(\'river\') 会看不到地理行（或用户点了没反应）')
    # 工具清单必须单源（不许在模板里再手写一遍地理工具名）
    seg2 = sm.split('const BASEMAP_TOOLS = [', 1)
    if len(seg2) < 2:
        fails.append('🔴 BASEMAP_TOOLS 清单不在（行的渲染就没数据源）')
    else:
        block = seg2[1].split('];', 1)[0]
        for tid in ('height', 'biome', 'river', 'road', 'culture', 'religion', 'label', 'marker'):
            if f"id: '{tid}'" not in block:
                fails.append(f'🔴 BASEMAP_TOOLS 里少了地理工具 {tid}')
    # 主行的「更多」标题不该再宣称它自己装着河流/地貌/地名（那些已经搬走了）
    if 'title="更多 — 拆分 / 合并 / 点击填充 / 描轮廓 / 河流 / 地貌' in sm:
        fails.append('🔴 「更多」的 title 还在宣称它装着河流/地貌（文案与结构不一致）')
    return fails


STATE = r"""(() => {
  const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const row = document.querySelector('[data-testid=basemap-row]');
  const toggle = document.querySelector('[data-testid=basemap-edit-toggle]');
  const toolBtns = row ? Array.from(row.querySelectorAll('[data-testid^=basemap-tool-]')) : [];
  const mainRow = document.querySelector('.primary-row');
  const mainText = mainRow ? (mainRow.textContent || '') : '';
  return JSON.stringify({
    mode: sm.basemapEditMode,
    tool: sm.tool,
    rowPresent: !!row,
    toolCount: toolBtns.length,
    toolIds: toolBtns.map((b) => b.dataset.testid.replace('basemap-tool-', '')),
    togglePresent: !!toggle,
    toggleActive: !!(toggle && toggle.classList.contains('active')),
    moreOpen: !!sm.moreOpen,
    toolbarH: Math.round((document.querySelector('.scenario-toolbar') || {}).clientHeight || 0),
    mainHasBasemapWords: ['河流', '地貌', '地名', '群像'].filter((w) => mainText.includes(w)),
    fails: [],
  });
})()"""


def _ev(cdp, js, desc):
    v = cdp.eval(js)
    if isinstance(v, dict) and '__err__' in v:
        raise RuntimeError(f'{desc} 求值异常：{str(v)[:300]}')
    return v


def _state(cdp):
    return json.loads(_ev(cdp, STATE, '读模式状态'))


def run(cdp):
    fails = source_gates()
    notes = ['源码闸门 6 组']
    ensure_case_state(cdp)

    _ev(cdp, "(() => { const b = Array.from(document.querySelectorAll('button'))"
             ".find(x => (x.textContent || '').includes('\u5386\u53f2\u5267\u672c'));"
             " if (b) b.click(); return 'ok'; })()", '点历史剧本')
    wait_for(cdp, "!!" + SMC, timeout=25, desc='剧本编辑器挂载')
    time.sleep(0.8)

    # ── b 默认未开模式：没有地理行 ──
    _ev(cdp, "(() => { const sm = %s; sm.setTool('select'); if (sm.basemapEditMode) sm.toggleBasemapEditMode(); return 'ok'; })()" % SM,
        '复位到日常模式')
    time.sleep(0.4)
    s0 = _state(cdp)
    if s0['mode']:
        fails.append('复位后模式仍为开（判据起点不成立）')
    if s0['rowPresent']:
        fails.append('未开底图编辑模式时地理行就出现了 —— 还是混在一起')
    if not s0['togglePresent']:
        fails.append('主行没有底图编辑开关（用户看不到"现在在哪个模式"）')
    notes.append(f"b 默认：模式={s0['mode']} 地理行={s0['rowPresent']} 开关在场={s0['togglePresent']}")

    # ── c 点开关 → 地理行出现且工具齐全；再点 → 消失 ──
    _ev(cdp, "(() => { document.querySelector('[data-testid=basemap-edit-toggle]').click(); return 'ok'; })()", '开模式')
    time.sleep(0.5)
    s1 = _state(cdp)
    if not s1['mode'] or not s1['rowPresent']:
        fails.append(f"点开关后模式/地理行没起来（mode={s1['mode']} row={s1['rowPresent']}）")
    if s1['toolCount'] < 8:
        fails.append(f"地理行里的工具太少（{s1['toolCount']} 个：{s1['toolIds']}）—— 分组没分干净")
    if not s1['toggleActive']:
        fails.append('开关开着但没有 active 视觉态（用户看不出在模式里）')
    # 🔴 开模式**不许**顺手展开「更多」：第一版这么写，工具栏从 ~120px 撑到 ~470px
    #    （出图 `02-basemap-edit-mode.png` 一眼可见），画布被压掉一半 ——
    #    "模式分区"的收益会被这个面板全吃掉。判据：开模式后「更多」面板不在 DOM 里。
    if s1.get('moreOpen'):
        fails.append('🔴 开底图编辑模式时「更多」被自动展开了（工具栏会撑到近 500px、画布被压一半）')
    _ev(cdp, "(() => { document.querySelector('[data-testid=basemap-edit-toggle]').click(); return 'ok'; })()", '关模式')
    time.sleep(0.5)
    s2 = _state(cdp)
    if s2['mode'] or s2['rowPresent']:
        fails.append(f"关模式后地理行没消失（mode={s2['mode']} row={s2['rowPresent']}）")
    notes.append(f"c 开关往返：开→{s1['toolCount']} 个地理工具 / 关→行={s2['rowPresent']}")

    # ── d 反向（零迁移）：直接 setTool('river') 必须自动开模式 ──
    _ev(cdp, "(() => { %s.setTool('river'); return 'ok'; })()" % SM, '直接切河流工具')
    time.sleep(0.5)
    s3 = _state(cdp)
    if not s3['mode']:
        fails.append('🔴 直接 setTool(\'river\') 没自动开模式 —— 既有用例（60+ 个直接切工具）'
                     '会看不到地理行，等于把能力藏起来了')
    if not s3['rowPresent']:
        fails.append('🔴 自动开模式后地理行仍不在（工具确实存在但用户看不到）')
    if s3['tool'] != 'river':
        fails.append(f"setTool('river') 后 tool={s3['tool']}（应为 river）")
    notes.append(f"d 零迁移：setTool('river') → 模式自动开={s3['mode']} / 行={s3['rowPresent']}")

    # ── e 日常工具仍在主行；点它不关模式 ──
    if '画省份' not in _ev(cdp, "(() => { const r = document.querySelector('.primary-row');"
                                " return r ? r.textContent : ''; })()", '读主行'):
        fails.append('主行里找不到「画省份」—— 日常工具被误伤')
    _ev(cdp, "(() => { %s.setTool('provinceBrush'); return 'ok'; })()" % SM, '切日常工具')
    time.sleep(0.4)
    s4 = _state(cdp)
    if not s4['mode']:
        fails.append('切回日常工具就把模式关了 —— 用户连着画几条河时会被踢出模式')
    notes.append(f"e 日常工具可用且不关模式：tool={s4['tool']} 模式={s4['mode']}")

    # ── f 收尾：关模式回日常 + 退出剧本域 ──
    _ev(cdp, "(() => { const sm = %s; if (sm.basemapEditMode) sm.toggleBasemapEditMode();"
             " sm.setTool('select'); return 'ok'; })()" % SM, '收尾')
    time.sleep(0.3)
    final = _state(cdp)
    if final['mode'] or final['rowPresent']:
        fails.append('收尾没回到日常模式（会把状态留给后面的用例）')
    _ev(cdp, "(() => { const b = document.querySelector('.scenario-toolbar .back-btn');"
             " if (b) b.click(); return 'ok'; })()", '返回世界')
    time.sleep(0.5)

    if fails:
        return False, ' | '.join(notes) + ' ⇒ ' + ' ；'.join(fails)
    return True, ' | '.join(notes)
