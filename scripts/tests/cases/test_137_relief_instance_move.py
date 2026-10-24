#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 137：地貌图标的「实例可选中可移动」（第 2 件，2026-10-24）

验收点（每一条都有反证，不做"看着对"）：
1. 点中一颗图标 = 选中（`selectedReliefId` 有值）且**零写入**（undo 栈与图标数不变）
2. 拖动它 = 位置真的变、图标数不变、**一次拖动 = 一条 undo**（label「移动地貌图标」）
3. 撤销 = 回到原位置（逐位相等）
4. 点空白 = 收掉选中
5. 只读态：拖得动预览但落不了库 —— 图标留在原位、undo 栈不多命令、状态栏有「只读」回音
6. 清空 / 散点仍是原能力（点空白不会误挪已有的）
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for  # noqa: E402
from lib.helpers import A, ensure_data_ready, enter_edit, goto_planet  # noqa: E402

PM = "document.querySelector('.planet-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"

# 画布矩形必须**每次现取**：进编辑模式会插一条工具栏，画布整体下移；
# 用一次缓存的 rect 会让点击落在图标上方（实测踩过：点不中 → 落成散布）
EV = """
const pm = %(PM)s;
const c = document.querySelector('.planet-map-container .canvas-wrapper canvas');
const rect = () => c.getBoundingClientRect();
const mk = (t, x, y) => { const r = rect(); return new MouseEvent(t, {
  clientX: r.left + x, clientY: r.top + y, button: 0,
  buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true,
}); };
const clickEvt = (x, y) => { const r = rect(); return new MouseEvent('click', {
  clientX: r.left + x, clientY: r.top + y, button: 0, bubbles: true, cancelable: true,
}); };
const w2s = (wx, wy) => { const t = pm.renderer.getViewTransform();
  return { x: wx * t.scale + t.x + c.clientWidth / 2, y: wy * t.scale + t.y + c.clientHeight / 2 }; };
"""


def _j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, dict):
        raise RuntimeError('eval 异常：%s' % v)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def _state(cdp):
    return _j(cdp, f"""(() => {{
      {EV % {'PM': PM}}
      const s = {STORE};
      const list = (pm.currentMapData && pm.currentMapData.reliefIcons) || [];
      const first = list[0] || null;
      return JSON.stringify({{
        icons: list.length,
        selected: pm.reliefBrush.selectedReliefId.value,
        undoLabel: s.undoLabel,
        first: first ? {{ id: first.id, x: first.x, y: first.y }} : null,
      }});
    }})()""")


def _scatter(cdp):
    return _j(cdp, f"""(() => {{
      {EV % {'PM': PM}}
      const r = rect();
      const y = Math.round(r.height * 0.45);
      const x0 = Math.round(r.width * 0.30), x1 = Math.round(r.width * 0.62);
      c.dispatchEvent(mk('mousedown', x0, y));
      for (let x = x0; x <= x1; x += 12) c.dispatchEvent(mk('mousemove', x, y));
      c.dispatchEvent(mk('mouseup', x1, y));
      return 'ok';
    }})()""")


def _click_icon(cdp):
    return _j(cdp, f"""(() => {{
      {EV % {'PM': PM}}
      const it = ((pm.currentMapData && pm.currentMapData.reliefIcons) || [])[0];
      if (!it) return JSON.stringify({{ __err__: '没有图标' }});
      const p = w2s(it.x, it.y);
      c.dispatchEvent(mk('mousedown', p.x, p.y));
      c.dispatchEvent(mk('mouseup', p.x, p.y));
      c.dispatchEvent(clickEvt(p.x, p.y));
      return JSON.stringify({{ id: it.id, at: {{ x: Math.round(p.x), y: Math.round(p.y) }} }});
    }})()""")


def _drag_icon(cdp):
    return _j(cdp, f"""(() => {{
      {EV % {'PM': PM}}
      const it = ((pm.currentMapData && pm.currentMapData.reliefIcons) || [])[0];
      if (!it) return JSON.stringify({{ __err__: '没有图标' }});
      const p = w2s(it.x, it.y);
      c.dispatchEvent(mk('mousedown', p.x, p.y));
      for (let i = 1; i <= 10; i++) c.dispatchEvent(mk('mousemove', p.x + i * 9, p.y + i * 5));
      c.dispatchEvent(mk('mouseup', p.x + 90, p.y + 50));
      c.dispatchEvent(clickEvt(p.x + 90, p.y + 50));
      return 'ok';
    }})()""")


def _click_empty(cdp):
    return _j(cdp, f"""(() => {{
      {EV % {'PM': PM}}
      const r = rect();
      const p = {{ x: Math.round(r.width * 0.12), y: Math.round(r.height * 0.82) }};
      c.dispatchEvent(mk('mousedown', p.x, p.y));
      c.dispatchEvent(mk('mouseup', p.x, p.y));
      c.dispatchEvent(clickEvt(p.x, p.y));
      return 'ok';
    }})()""")


def _status(cdp):
    return _j(cdp, f"""(() => {{
      const pm = {PM};
      const el = document.querySelector('.planet-map-container');
      const text = String((el && el.innerText) || '');
      return JSON.stringify({{ exportStatus: String(pm.exportStatus || ''), hasReadonly: text.indexOf('只读') >= 0 }});
    }})()""")


def _write_mode(cdp, mode):
    return cdp.eval(
        "import('/src/store/writeGate.js').then(m => { m.setWriteMode('%s', 'case137'); return 'ok'; })" % mode
    )


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    ensure_data_ready(cdp)

    # ── 0. 进入行星 + 编辑模式 + 地貌笔刷 ───────────────────────────────
    r = goto_planet(cdp, A('曜川星'))
    if r != 'planet':
        return False, f'导航行星失败 ({r})'
    wait_for(cdp, "!!document.querySelector('.planet-map-container .canvas-wrapper canvas')", desc='行星画布挂载')
    time.sleep(1.0)
    if enter_edit(cdp) != 'ok':
        return False, '进入编辑模式失败'
    time.sleep(0.6)
    _j(cdp, f"""(() => {{
      const pm = {PM};
      pm.interactionMode = 'relief';
      pm.reliefBrush.reliefType.value = 'mountain';
      pm.reliefBrush.reliefSpacing.value = 40;
      pm.reliefBrush.reliefSize.value = 26;
      pm.renderer.requestRender();
      return 'ok';
    }})()""")
    time.sleep(0.4)

    # ── 1. 先散布几颗 ──────────────────────────────────────────────────
    if _scatter(cdp) != 'ok':
        return False, '散布事件派发失败'
    time.sleep(0.8)
    s0 = _state(cdp)
    if s0['icons'] < 3:
        return False, f'散布后图标太少（{s0["icons"]}），后续判据无从谈起'
    if s0['undoLabel'] != '散布地貌图标':
        return False, f'散布后 undo label 不对（{s0["undoLabel"]}）'

    # ── 2. 点中 = 选中，且零写入 ───────────────────────────────────────
    click = _click_icon(cdp)
    time.sleep(0.3)
    s1 = _state(cdp)
    if not s1['selected']:
        return False, f'点中图标没有选中（{click} → {s1}）'
    if s1['undoLabel'] != s0['undoLabel'] or s1['icons'] != s0['icons']:
        return False, f'"只选中"发生了写入（undo {s0["undoLabel"]}→{s1["undoLabel"]}，图标 {s0["icons"]}→{s1["icons"]}）'
    if not s1['first'] or s1['first']['id'] != s1['selected']:
        return False, f'选中的不是点中的那一颗（{s1["selected"]} vs {s1["first"]}）'

    # ── 3. 拖它 = 位置变、条数不变、一条 undo ──────────────────────────
    _drag_icon(cdp)
    time.sleep(0.5)
    s2 = _state(cdp)
    if s2['undoLabel'] != '移动地貌图标':
        return False, f'拖动后 undo label 不是「移动地貌图标」（{s2["undoLabel"]}）'
    if s2['icons'] != s0['icons']:
        return False, f'移动把图标数量改了（{s0["icons"]} → {s2["icons"]}）'
    if abs(s2['first']['x'] - s0['first']['x']) < 1 and abs(s2['first']['y'] - s0['first']['y']) < 1:
        return False, f'拖动没有改变位置（{s0["first"]} → {s2["first"]}）'

    # ── 4. 撤销回原位 ─────────────────────────────────────────────────
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.4)
    s3 = _state(cdp)
    if abs(s3['first']['x'] - s0['first']['x']) > 0.001 or abs(s3['first']['y'] - s0['first']['y']) > 0.001:
        return False, f'撤销后位置没回到原位（{s0["first"]} vs {s3["first"]}）'
    if s3['icons'] != s0['icons']:
        return False, f'撤销后图标数不对（{s3["icons"]} ≠ {s0["icons"]}）'

    # ── 5. 点空白收选中（且不误挪、不误撒）────────────────────────────
    _click_empty(cdp)
    time.sleep(0.4)
    s4 = _state(cdp)
    if s4['selected']:
        return False, f'点空白没有收掉选中（{s4["selected"]}）'
    if s4['icons'] != s0['icons']:
        return False, f'点空白把图标数改了（{s0["icons"]} → {s4["icons"]}）'

    # ── 6. 只读态：拖得动预览，落不了库 ───────────────────────────────
    _write_mode(cdp, 'readonly')
    time.sleep(0.3)
    _click_icon(cdp)
    time.sleep(0.2)
    _drag_icon(cdp)
    time.sleep(0.5)
    s5 = _state(cdp)
    st = _status(cdp)
    _write_mode(cdp, 'project')
    time.sleep(0.2)
    if abs(s5['first']['x'] - s0['first']['x']) > 0.001:
        return False, f'只读态居然把图标挪走了（x {s0["first"]["x"]} → {s5["first"]["x"]}）'
    if s5['undoLabel'] == '移动地貌图标':
        return False, '只读态压进了"移动"命令（不该有）'
    if not st.get('hasReadonly'):
        return False, f'只读态拖动没有回音（exportStatus={st.get("exportStatus")!r}）'

    _j(cdp, f"(() => {{ {PM}.setInteractionMode('pan'); return 'ok'; }})()")
    return True, (
        f'实例可选中可移动：散布 {s0["icons"]} 颗 → 点中选中（{s1["selected"]}）、零写入；'
        f'拖动位移 ({s2["first"]["x"]:.0f},{s2["first"]["y"]:.0f}) 且条数不变、一条 undo「{s2["undoLabel"]}」；'
        f'撤销逐位回原位；点空白收选中且不误挪（{s4["icons"]} 颗）；'
        f'只读态留在原位 + 回音「只读」'
    )
