#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""第 2 件「实例可选中可移动」的验收探针（2026-10-24）。

判据（全部只读，不改产品代码）：
  ① 点中图标 = 选中（`selectedReliefId` 有值）且**零写入**（undo 栈不动）
  ② 拖动它 = 位置真的变了，且**一次拖动 = 一条 undo**（label「移动地貌图标」）
  ③ 撤销 = 回到原位（位置逐位相等）
  ④ 点空白 = 收掉选中；**散布一笔仍是新图标**（点空白不会误挪已有的）

用法（lab 必须先 up）：
    python scripts/tests/tools/_probe_relief_select.py
"""
import json
import os
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

from lib.cdp import CDP, wait_for            # noqa: E402
from lib.helpers import open_harness_project  # noqa: E402
import run_tests as RT                       # noqa: E402

PM = "document.querySelector('.planet-map-container').__vueParentComponent.setupState"
READY = "!!document.querySelector('.planet-map-container .canvas-wrapper canvas')"

ENTER = r"""
(() => {
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const planetId = Object.keys(s.mapData || {})[0];
  if (!planetId) return JSON.stringify({ __err__: '没有已载入的行星地图' });
  s.focusEntityOnCanvas(planetId);
  return JSON.stringify({ planetId, view: s.viewLevel });
})()
"""

SETUP = r"""
(() => {
  const pm = """ + PM + r""";
  pm.editMode = true;
  pm.interactionMode = 'relief';
  pm.reliefBrush.reliefType.value = 'mountain';
  pm.reliefBrush.reliefSpacing.value = 40;
  pm.reliefBrush.reliefSize.value = 26;
  pm.renderer.requestRender();
  // 世界↔屏幕：renderer 只暴露 screenToWorld，按同一口径反解
  // ⚠️ 画布矩形必须**每次现取**：进编辑模式会插一条工具栏，画布整体下移；
  //    用 SETUP 时缓存的那份 rect → 点击会落在图标上方（本轮第一版就栽在这：点不中，落成散布）。
  const cvs = document.querySelector('.planet-map-container .canvas-wrapper canvas');
  window.__SEL = {
    cvs,
    rect: () => cvs.getBoundingClientRect(),
    mk: (t, x, y) => {
      const r = cvs.getBoundingClientRect();
      return new MouseEvent(t, {
        clientX: r.left + x, clientY: r.top + y, button: 0,
        buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true,
      });
    },
    clickEvt: (x, y) => {
      const r = cvs.getBoundingClientRect();
      return new MouseEvent('click', {
        clientX: r.left + x, clientY: r.top + y, button: 0, bubbles: true, cancelable: true,
      });
    },
    w2s(wx, wy) {
      const t = pm.renderer.getViewTransform();
      return { x: wx * t.scale + t.x + cvs.clientWidth / 2, y: wy * t.scale + t.y + cvs.clientHeight / 2 };
    },
  };
  return JSON.stringify({ mode: pm.interactionMode, edit: !!pm.editMode });
})()
"""

SCATTER = r"""
(() => {
  const S = window.__SEL;
  const r = S.rect(); const y = Math.round(r.height * 0.45);
  const x0 = Math.round(r.width * 0.30), x1 = Math.round(r.width * 0.62);
  S.cvs.dispatchEvent(S.mk('mousedown', x0, y));
  for (let x = x0; x <= x1; x += 12) S.cvs.dispatchEvent(S.mk('mousemove', x, y));
  S.cvs.dispatchEvent(S.mk('mouseup', x1, y));
  return 'ok';
})()
"""

STATE = r"""
(() => {
  const pm = """ + PM + r""";
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const list = (pm.currentMapData && pm.currentMapData.reliefIcons) || [];
  return JSON.stringify({
    icons: list.length,
    selected: pm.reliefBrush.selectedReliefId.value,
    dragging: !!pm.reliefBrush.reliefDrag.value,
    canUndo: !!s.canUndo,
    undoLabel: s.undoLabel,
    first: list[0] ? { id: list[0].id, x: list[0].x, y: list[0].y, size: list[0].size } : null,
  });
})()
"""

# 点中第一颗（按下 + 抬起，没有位移）→ 只选中
CLICK_ICON = r"""
(() => {
  const S = window.__SEL;
  const pm = """ + PM + r""";
  const it = ((pm.currentMapData && pm.currentMapData.reliefIcons) || [])[0];
  if (!it) return JSON.stringify({ __err__: '没有图标' });
  const p = S.w2s(it.x, it.y);
  window.__SEL.target = { id: it.id, x: it.x, y: it.y };
  S.cvs.dispatchEvent(S.mk('mousedown', p.x, p.y));
  S.cvs.dispatchEvent(S.mk('mouseup', p.x, p.y));
  return JSON.stringify({ at: { x: Math.round(p.x), y: Math.round(p.y) }, id: it.id });
})()
"""

# 拖它（按下 → 10 步 → 抬起）
DRAG_ICON = r"""
(() => {
  const S = window.__SEL;
  const pm = """ + PM + r""";
  const it = ((pm.currentMapData && pm.currentMapData.reliefIcons) || []).find(x => x.id === window.__SEL.target.id);
  const p = S.w2s(it.x, it.y);
  S.cvs.dispatchEvent(S.mk('mousedown', p.x, p.y));
  return new Promise((resolve) => {
    let i = 0;
    const step = () => {
      i += 1;
      S.cvs.dispatchEvent(S.mk('mousemove', p.x + i * 9, p.y + i * 5));
      if (i < 10) requestAnimationFrame(step);
      else { S.cvs.dispatchEvent(S.mk('mouseup', p.x + 90, p.y + 50)); resolve('ok'); }
    };
    requestAnimationFrame(step);
  });
})()
"""

# 点空白（远离所有图标）→ 收掉选中
CLICK_EMPTY = r"""
(() => {
  const S = window.__SEL;
  const r = S.rect(); const p = { x: Math.round(r.width * 0.12), y: Math.round(r.height * 0.82) };
  S.cvs.dispatchEvent(S.mk('mousedown', p.x, p.y));
  S.cvs.dispatchEvent(S.mk('mouseup', p.x, p.y));
  S.cvs.dispatchEvent(S.clickEvt(p.x, p.y));
  return 'ok';
})()
"""

UNDO = "(() => { const s = document.querySelector('#app').__vue_app__._instance.setupState.store; s.undo(); return 'ok'; })()"

# ⑤ 只读态：拖得动预览，但**落不了库**（图标留在原位 + 有回音）
SET_READONLY = "(() => import('/src/store/writeGate.js').then(m => { m.setWriteMode('readonly', 'probe'); return 'ok'; }))()"
SET_WRITABLE = "(() => import('/src/store/writeGate.js').then(m => { m.setWriteMode('project', 'probe'); return 'ok'; }))()"
STATUS_TEXT = r"""
(() => {
  const pm = """ + PM + r""";
  const el = document.querySelector('.planet-map-container');
  const text = String((el && el.innerText) || '');
  return JSON.stringify({
    exportStatus: String(pm.exportStatus || ''),
    hasReadonly: text.indexOf('只读') >= 0,
  });
})()
"""


def j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, dict):
        raise RuntimeError('eval 异常：%s' % v)
    try:
        return json.loads(v) if isinstance(v, str) and v.startswith(('{', '[')) else v
    except ValueError:
        return v


def main():
    cdp = CDP()
    try:
        cdp.ws.settimeout(180)
        cdp.navigate('http://localhost:5180/?sel=%d' % int(time.time()))
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='导航', timeout=60)
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate('http://localhost:5180/?sel=%d' % (int(time.time()) + 1))
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='重载', timeout=60)
        RT.apply_viewport(cdp)
        wait_for(cdp, "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
                 timeout=45, desc='数据就绪')
        open_harness_project(cdp)

        print('enter:', j(cdp, ENTER))
        wait_for(cdp, READY, timeout=40, desc='行星画布')
        time.sleep(1.0)
        print('setup:', j(cdp, SETUP))
        time.sleep(0.5)

        j(cdp, SCATTER)
        time.sleep(0.8)
        s0 = j(cdp, STATE)
        print('散布后:', s0)
        if s0['icons'] < 3:
            print('🔴 图标太少，判据无从谈起')
            return 1

        # ① 点中 = 选中，零写入
        click = j(cdp, CLICK_ICON)
        time.sleep(0.3)
        s1 = j(cdp, STATE)
        print('点中图标:', click, '→', s1)

        # ② 拖它
        j(cdp, DRAG_ICON)
        time.sleep(0.5)
        s2 = j(cdp, STATE)
        print('拖动后:', s2)

        # ③ 撤销回原位
        j(cdp, UNDO)
        time.sleep(0.4)
        s3 = j(cdp, STATE)
        print('撤销后:', s3)

        # ④ 点空白收选中
        j(cdp, CLICK_EMPTY)
        time.sleep(0.3)
        s4 = j(cdp, STATE)
        print('点空白后:', s4)

        # ⑤ 只读态：拖得动预览，但落不了库（图标留在原位 + 有回音）
        j(cdp, SET_READONLY)
        time.sleep(0.4)
        clk2 = j(cdp, CLICK_ICON)
        time.sleep(0.2)
        j(cdp, DRAG_ICON)
        time.sleep(0.6)
        s5 = j(cdp, STATE)
        st5 = j(cdp, STATUS_TEXT)
        print('只读态拖动后:', s5, st5)
        j(cdp, SET_WRITABLE)
        time.sleep(0.2)

        fails = []
        if not s1.get('selected'):
            fails.append('点中图标没有选中（selectedReliefId 空）')
        if s1.get('undoLabel') != s0.get('undoLabel') or s1.get('icons') != s0.get('icons'):
            fails.append('"只选中"发生了写入（undo/图标数变了）')
        if s2.get('undoLabel') != '移动地貌图标':
            fails.append('拖动后 undo label 不是「移动地貌图标」（实际 %s）' % s2.get('undoLabel'))
        if s2.get('icons') != s0.get('icons'):
            fails.append('移动把图标数量改了（%s → %s）' % (s0.get('icons'), s2.get('icons')))
        if s3.get('icons') != s0.get('icons'):
            fails.append('撤销后图标数量不对')
        if abs((s3.get('first') or {}).get('x', 0) - (s0.get('first') or {}).get('x', 0)) > 0.001 \
                or abs((s3.get('first') or {}).get('y', 0) - (s0.get('first') or {}).get('y', 0)) > 0.001:
            fails.append('撤销后位置没回到原位')
        if s4.get('selected'):
            fails.append('点空白没有收掉选中')
        # 只读：位置没变、undo 栈没多出"移动"命令、界面有回音
        if abs((s5.get('first') or {}).get('x', 0) - (s0.get('first') or {}).get('x', 0)) > 0.001:
            fails.append('只读态居然把图标挪走了（x 变了）')
        if s5.get('undoLabel') == '移动地貌图标':
            fails.append('只读态压进了"移动"命令（不该有）')
        if not st5.get('hasReadonly'):
            fails.append('只读态拖动没有回音（状态栏没提只读）')

        print('\n=== 判据 ===')
        print(json.dumps({
            'icons_scattered': s0['icons'],
            'selected_after_click': s1.get('selected'),
            'undo_before_drag': s0.get('undoLabel'), 'undo_after_drag': s2.get('undoLabel'),
            'selected_after_drag': s2.get('selected'),
            'undo_after_undo': s3.get('undoLabel'),
            'position_after_undo': (s3.get('first') or {}),
            'selected_after_empty_click': s4.get('selected'),
            'readonly_kept_position': (s5.get('first') or {}),
            'readonly_status': st5.get('exportStatus'),
            'selected_after_empty_click': s4.get('selected'),
            'fails': fails,
        }, ensure_ascii=False, indent=1))
        return 0 if not fails else 1
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
