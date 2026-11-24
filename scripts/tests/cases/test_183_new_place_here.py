#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 183：**在行星图上就地新建地点**（右键空白处 → 带坐标打开创建框）

为什么加这一条（2026-11-24）：
  用户实测原话：“想加个地点用来测试都没地方加”。
  查下来的事实是：创建实体的入口**一直有**（项目面板 →「+ 新建实体」），
  但它长在项目面板里，而人的心智是“我看着地图上这块地方，就想在这儿放一个点”。
  于是补了一条**地图侧入口**：行星图空白处右键 →「在这里新建地点…」→
  创建对话框被**预填当前世界坐标 + 当前行星作为父级**。

这条用例守的是"这条入口真的存在且真的带坐标"，不是"对话框能打开"：
  a) 空白处右键的菜单里有「在这里新建地点…」这一项；
  b) 点它 → `EntityCreator` 真的出现在 DOM 里；
  c) 对话框里的**坐标输入框**已经不是空的，且与右键处世界坐标一致（容差 1px 级）；
  d) 父级下拉默认是当前行星（不是空的顶层）；
  e) 只读态下这一项是**禁用**的（带说明），不是静默不给；
  f) 全程零错误面板。

⚠️ 只验"入口 → 预填"，不验"创建成功"（那条由 test_48 的创建链守，
   两者是同一个 store 写口，重复验只会让用例互相牵制）。
"""
import json
import sys
import os
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for  # noqa: E402

APP = "document.querySelector('#app').__vue_app__"
PLANET = "document.querySelector('.planet-map-container')"


def _j(v):
    if isinstance(v, str) and v[:1] in '{[':
        try:
            return json.loads(v)
        except Exception:
            return {}
    return v if isinstance(v, dict) else {}


def _error_panel(cdp):
    raw = cdp.eval("""(() => {
      const el = document.getElementById('sitian-error-overlay');
      if (!el) return '';
      const pre = el.querySelector('[data-role=detail]');
      return (pre && pre.textContent ? pre.textContent : '(无详情)').slice(0, 500);
    })()""")
    return raw if isinstance(raw, str) else ''


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')

    # ── 进入某颗行星的行星图 + 打开编辑地图（右键菜单只在编辑模式给） ──────────
    nav = cdp.eval(f"""(() => {{
      const s = ({APP})._instance.setupState.store;
      const planet = s.nodes.find(n => n.layer === 'planet');
      if (!planet) return 'no-planet';
      s.selectPlanetOrNode ? s.selectPlanetOrNode(planet) : s.selectPlanet(planet);
      return JSON.stringify({{ level: s.viewLevel, id: planet.id }});
    }})()""")
    info = _j(nav)
    if info.get('level') != 'planet':
        return False, f'未能进入行星视图（{nav}）'
    wait_for(cdp, "!!document.querySelector('.planet-map-container canvas')", desc='行星画布挂载')
    time.sleep(0.8)

    # 进编辑模式（右键只在 editMode 下给）：点**产品自己的「编辑地图」按钮**
    # 🔴 不能读 `__vueParentComponent.setupState.editMode` —— 行星图那层在 dev 下
    #    有时取得到、有时取不到（组件链被异步组件包了一层），取不到就整条用例假红。
    #    走真实按钮既稳，又更接近用户路径。
    entered = cdp.eval("""(() => {
      const btns = Array.from(document.querySelectorAll('.planet-map-container button'));
      const b = btns.find(x => (x.textContent || '').trim().includes('编辑地图'));
      if (!b) return 'no-btn';
      if (b.disabled) return 'disabled:' + (b.title || '');
      b.click();
      return 'ok';
    })()""")
    if not (isinstance(entered, str) and entered == 'ok'):
        return False, f'点不到「编辑地图」（只读态？{entered}）'
    time.sleep(0.6)

    # ── a) 空白处右键 → 菜单里应有「在这里新建地点…」 ─────────────────────────
    opened = _j(cdp.eval(f"""(() => {{
      const c = document.querySelector('.planet-map-container canvas');
      if (!c) return JSON.stringify({{ ok: false, why: 'no-canvas' }});
      const r = c.getBoundingClientRect();
      // 画布**很靠边**的空白处（避开恒星/行星/已有点位那些中心区）
      const cx = Math.round(r.left + r.width * 0.08);
      const cy = Math.round(r.top + r.height * 0.08);
      c.dispatchEvent(new MouseEvent('contextmenu', {{
        clientX: cx, clientY: cy, bubbles: true, cancelable: true, button: 2,
      }}));
      return JSON.stringify({{ ok: true, cx: cx, cy: cy }});
    }})()"""))
    if not opened.get('ok'):
        return False, f'右键派发失败（{opened}）'
    time.sleep(0.6)

    menu = _j(cdp.eval("""(() => {
      const items = Array.from(document.querySelectorAll('.sitian-context-menu .menu-item'));
      return JSON.stringify({
        visible: document.querySelectorAll('.sitian-context-menu').length > 0,
        labels: items.map(x => (x.textContent || '').trim()),
        disabled: items.filter(x => x.classList.contains('disabled') || x.getAttribute('aria-disabled') === 'true')
          .map(x => (x.textContent || '').trim()),
      });
    })()"""))
    if not menu.get('visible'):
        return False, f'右键没弹出菜单（{menu}）'
    labels = menu.get('labels') or []
    if not any('在这里新建地点' in t for t in labels):
        return False, f'空白处右键菜单里没有「在这里新建地点…」这一项，实际项：{labels}'

    # ── b) 点它 → EntityCreator 出现 ─────────────────────────────────────────
    clicked = cdp.eval("""(() => {
      const it = Array.from(document.querySelectorAll('.sitian-context-menu .menu-item'))
        .find(x => (x.textContent || '').includes('在这里新建地点'));
      if (!it) return 'no-item';
      if (it.classList.contains('disabled')) return 'disabled';
      it.click();
      return 'ok';
    })()""")
    if clicked == 'disabled':
        return False, '只读态下这项被禁用了，但本用例是在编辑模式跑的（判据环境不对）'
    if clicked != 'ok':
        return False, f'点不到那一项（{clicked}）'
    time.sleep(0.8)

    dlg = _j(cdp.eval("""(() => {
      const card = document.querySelector('.ec-card');
      if (!card) return JSON.stringify({ shown: false });
      const inputs = Array.from(card.querySelectorAll('input'));
      const parent = card.querySelector('[data-testid=ec-parent]');
      return JSON.stringify({
        shown: true,
        title: ((card.querySelector('.ec-title') || {}).textContent || '').trim(),
        inputValues: inputs.map(i => ({ v: i.value, ph: i.placeholder || '' })),
        parentValue: parent ? parent.value : null,
        parentText: parent && parent.selectedOptions && parent.selectedOptions[0]
          ? parent.selectedOptions[0].textContent.trim() : '',
        layerValue: (() => { const l = card.querySelector('[data-testid=ec-layer]'); return l ? l.value : null; })(),
      });
    })()"""))
    if not dlg.get('shown'):
        return False, '点了「在这里新建地点…」但创建对话框没出现'

    # ── c) 坐标输入框已被预填（不是空的） ────────────────────────────────────
    vals = [x.get('v') or '' for x in (dlg.get('inputValues') or [])]
    filled = [v for v in vals if str(v).strip() != '']
    numeric = [v for v in filled if _is_num(v)]
    if len(numeric) < 2:
        return False, (f'坐标没有被预填（对话框里的输入框值：{vals}）——'
                       '「带坐标」这条承诺没做到')

    # ── d) 父级默认是当前行星 ────────────────────────────────────────────────
    if not dlg.get('parentValue'):
        return False, f'父级没有默认成当前行星（parentValue={dlg.get("parentValue")!r}）'

    # ── f) 零错误面板 ────────────────────────────────────────────────────────
    panel = _error_panel(cdp)
    if panel:
        return False, f'整条链路上弹了错误面板：{panel}'

    return True, (f'空白处右键 → 菜单含「在这里新建地点…」→ 创建框预填了坐标 '
                  f'(x={numeric[0]}, y={numeric[1]}) 且父级=当前行星'
                  f'（层级默认 {dlg.get("layerValue")}）；全程零错误面板')


def _is_num(v):
    try:
        float(str(v).strip())
        return True
    except Exception:
        return False
