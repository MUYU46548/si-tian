#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 28：撤销历史面板（P0-3）

验收点（对应提示词 P0-3 的「验收标准」逐条）：
1. 面板实时显示操作历史 —— 两次编辑后条目数 == undo 历史长度
2. 当前步高亮正确 —— 仅最后一条 data-state=current，其余 applied
3. 点击任意条目跳转到对应状态 —— 点 #0 → 指针回 0，第 2 次编辑的数据被回退
4. undo/redo 按钮操作后面板跟随 —— redo 后 current 移到下一条
5. 面板可折叠不挡画布 —— fold-btn 折叠后 body 消失，标题栏仍在
6. 未命名操作有兜底文案（不再出现空白行）
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for  # noqa: E402
from lib.helpers import goto_planet, enter_edit, click_canvas_at_world, ensure_data_ready  # noqa: E402

PM = "document.querySelector('.planet-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"


def _j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def _hist(cdp):
    """读 store/undo.js 模块级单例状态（与 HistoryPanel 读的是同一份）"""
    return _j(cdp, """(async () => {
      const mod = await import('/src/store/undo.js');
      const h = mod.getHistory();
      return JSON.stringify({
        len: h.length,
        pointer: mod.currentIndex.value,
        labels: h.map(e => (e.label === undefined || e.label === null) ? null : e.label),
      });
    })()""")


def _land_points(cdp, count=2, gap=250):
    """视口内的 count 个陆地世界点（彼此间距 ≥ gap，确定性扫描）"""
    return _j(cdp, f"""(() => {{
      const pm = {PM};
      const hm = pm.planetHeightBrush.ensureHeightmap();
      if (!hm || !hm.grid || !hm.grid.points) return JSON.stringify({{ err: 'no-heightmap' }});
      const c = document.querySelector('.planet-map-container .canvas-wrapper canvas');
      const vt = pm.renderer.viewTransform;
      const cw = c.clientWidth, ch = c.clientHeight;
      const toSX = wx => wx * vt.scale + vt.x + cw / 2;
      const toSY = wy => wy * vt.scale + vt.y + ch / 2;
      const pts = hm.grid.points;
      const out = [];
      for (let i = 0; i < pts.length && out.length < {count}; i++) {{
        const h = hm.h[i];
        if (h < 25 || h > 65) continue;
        const x = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
        const y = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
        const sx = toSX(x), sy = toSY(y);
        if (sx < 60 || sx > cw - 60 || sy < 60 || sy > ch - 60) continue;
        if (out.every(p => Math.hypot(p.x - x, p.y - y) >= {gap})) out.push({{ x, y, h }});
      }}
      return JSON.stringify({{ points: out }});
    }})()""")


def _panel_state(cdp):
    return _j(cdp, """(() => {
      const p = document.querySelector('.planet-map-container .history-panel');
      if (!p) return JSON.stringify({ open: false });
      const items = Array.from(p.querySelectorAll('.history-item'));
      const cur = items.filter(i => i.dataset.state === 'current');
      return JSON.stringify({
        open: true,
        count: items.length,
        currentCount: cur.length,
        currentIndex: cur.length ? Number(cur[0].dataset.index) : -1,
        labels: items.map(i => (i.querySelector('.history-label') || {}).textContent || ''),
        states: items.map(i => i.dataset.state),
        hasFoldBtn: !!p.querySelector('.fold-btn'),
        bodyVisible: !!p.querySelector('.panel-shell-body'),
      });
    })()""")


def _click_panel_button(cdp):
    """点击 PlanetMap 内的「撤销历史面板」按钮（限定在 .planet-map-container 内）"""
    return cdp.eval("""(() => {
      const root = document.querySelector('.planet-map-container');
      if (!root) return 'no-root';
      const b = Array.from(root.querySelectorAll('button'))
        .find(x => (x.getAttribute('title') || '').includes('撤销历史面板'));
      if (!b) return 'no-btn';
      b.click();
      return 'ok';
    })()""")


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    ensure_data_ready(cdp)

    r = goto_planet(cdp, '乐园星')
    if r != 'planet':
        return False, f'导航行星失败 (goto_planet → {r})'
    wait_for(cdp, "!!document.querySelector('.planet-map-container .canvas-wrapper canvas')", desc='行星画布挂载')
    time.sleep(1.0)
    if enter_edit(cdp) != 'ok':
        return False, '进入编辑模式失败'
    time.sleep(0.8)
    cdp.eval(f"(() => {{ {PM}.zoomFit(); return 'ok'; }})()")
    time.sleep(0.6)

    h0 = _hist(cdp)
    if not isinstance(h0, dict):
        return False, f'读不到 undo 历史模块 {h0}'
    base = h0['len']

    # ── 造两次真实编辑（智能聚落 = 一条「放置聚落」命令） ────────────────
    picks = _land_points(cdp, count=2, gap=250)
    if not isinstance(picks, dict) or 'points' not in picks:
        return False, f'高度图不可用 {picks}'
    pts = picks['points']
    if len(pts) < 2:
        return False, f'视口内陆地候选点不足 {picks}'

    for pt in pts[:2]:
        _j(cdp, f"(() => {{ {PM}.setInteractionMode('settle'); return 'ok'; }})()")
        time.sleep(0.3)
        if click_canvas_at_world(cdp, pt['x'], pt['y']) == 'out-of-view':
            return False, f'聚落点击点超出视口 {pt}'
        time.sleep(0.9)

    h1 = _hist(cdp)
    if h1['len'] < base + 2:
        return False, f'两次编辑后历史未增长 base={base} → {h1}'
    if h1['pointer'] != h1['len'] - 1:
        return False, f'新命令入栈后指针应指向末条（无"未来"分支）：{h1}'
    nodes_now = _j(cdp, f"JSON.stringify({{ n: {STORE}.nodes.length }})")['n']

    # ── 打开面板 ────────────────────────────────────────────────────────
    click_ret = _click_panel_button(cdp)
    if click_ret != 'ok':
        return False, f'找不到「撤销历史面板」工具栏按钮（PlanetMap 未接线？）{click_ret}'
    time.sleep(0.5)
    st = _panel_state(cdp)
    if not st.get('open'):
        diag = _j(cdp, f"""JSON.stringify({{
          flag: {PM}.historyPanelOpen,
          hp: document.querySelectorAll('.history-panel').length,
          shells: document.querySelectorAll('.panel-shell').length,
        }})""")
        return False, f'点击后历史面板未渲染（.history-panel 不存在）诊断={diag}'

    # 1. 面板实时显示操作历史
    if st['count'] != h1['len']:
        return False, f'面板条目数 {st["count"]} ≠ 历史长度 {h1["len"]}（未实时同步）'
    if any(not (l or '').strip() for l in st['labels']):
        return False, f'存在空白操作名（应回退为「未命名操作 #N」）：{st["labels"][-5:]}'

    # 2. 当前步高亮正确
    if st['currentCount'] != 1:
        return False, f'当前步应恰好 1 条高亮，实际 {st["currentCount"]} 条：{st["states"]}'
    if st['currentIndex'] != h1['len'] - 1:
        return False, f'当前步高亮位置错误 {st["currentIndex"]} ≠ {h1["len"] - 1}'

    # 3. 点击任意条目跳转 —— 点 #0（最早那步）应把后面全部撤销
    cdp.eval("""(() => {
      const it = document.querySelector('.planet-map-container .history-panel .history-item[data-index="0"]');
      if (it) it.click();
      return 'ok';
    })()""")
    time.sleep(0.6)
    h2 = _hist(cdp)
    if h2['pointer'] != 0:
        return False, f'点击 #0 后指针未跳到 0（{h2}）'
    st2 = _panel_state(cdp)
    if st2['currentIndex'] != 0:
        return False, f'跳转后面板当前步未跟随（{st2["currentIndex"]}）'
    if st2['states'].count('future') != h2['len'] - 1:
        return False, f'跳转后未来步骤应全部置灰：{st2["states"]}'
    nodes_after_jump = _j(cdp, f"JSON.stringify({{ n: {STORE}.nodes.length }})")['n']
    if nodes_after_jump >= nodes_now:
        return False, f'跳到 #0 后数据未回退（nodes {nodes_now} → {nodes_after_jump}）'

    # 4. redo 后面板跟随
    _j(cdp, f"(() => {{ {STORE}.redo(); return 'ok'; }})()")
    time.sleep(0.5)
    h3 = _hist(cdp)
    st3 = _panel_state(cdp)
    if h3['pointer'] != 1:
        return False, f'redo 后指针应为 1（{h3}）'
    if st3['currentIndex'] != 1:
        return False, f'redo 后面板未跟随移动（current {st3["currentIndex"]}）'

    # 5. 折叠不挡画布（标题栏保留，body 收起）
    if not st3['hasFoldBtn']:
        return False, '面板缺少折叠按钮（fold-btn）'
    if not st3['bodyVisible']:
        return False, '面板初始应为展开态'
    cdp.eval("document.querySelector('.planet-map-container .history-panel .fold-btn').click()")
    time.sleep(0.4)
    st4 = _panel_state(cdp)
    if st4['bodyVisible']:
        return False, '点击折叠后面板 body 仍可见（未真正折叠）'
    if not st4['open']:
        return False, '折叠后面板消失（应只收起 body，标题栏保留）'
    cdp.eval("document.querySelector('.planet-map-container .history-panel .fold-btn').click()")
    time.sleep(0.4)
    if not _panel_state(cdp)['bodyVisible']:
        return False, '再次点击后未展开'

    # 6. 未命名操作兜底：直接压入一条无 label 的命令（execute 是公开 API，label 可选）
    _j(cdp, """(async () => {
      const mod = await import('/src/store/undo.js');
      mod.execute({ type: 'test-unnamed', undo: () => {}, redo: () => {} });
      return 'ok';
    })()""")
    time.sleep(0.4)
    st5 = _panel_state(cdp)
    last = (st5['labels'] or [''])[-1]
    if '未命名操作' not in last:
        return False, f'无 label 的命令未回退为「未命名操作 #N」，实际显示「{last}」'

    _j(cdp, f"(() => {{ {PM}.setInteractionMode('pan'); return 'ok'; }})()")
    return True, (
        f'撤销历史面板通过：{st["count"]} 条记录实时同步（当前步高亮 #{st["currentIndex"] + 1}、'
        f'未来步骤 {st2["states"].count("future")} 条置灰）；点 #0 跳转后 nodes {nodes_now}→{nodes_after_jump} 且面板跟随；'
        f'redo 后当前步移回 #{st3["currentIndex"] + 1}；折叠/展开正常；'
        f'无 label 命令显示「{last}」'
    )
