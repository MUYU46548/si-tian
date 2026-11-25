#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 186：2D 恒星系视图的**天体属性面板**（2026-11-25 第七轮）

## 为什么要有它

用户 2026-11-25：“2D 视图里没有行星属性面板（类型也只能在 3D 改）。”
于是 2D 单系视图在**编辑模式**下点行星会打开属性面板：类型（内置 + 项目自定义）+ 三个拾色器。
面板与 3D 卡片走**同一条写口/取色口**，不是另造一套。

## 判据（全走产品入口）

| # | 判据 | 口径 |
|---|---|---|
| A | 浏览模式行为不变 | 进面板前 DOM 无 `planet-props-panel`；单击行星仍是“进入行星地图” |
| B | 编辑模式点行星 → 面板打开 | 真实鼠标点画布上的行星中心 → 面板在 DOM、标题带行星名 |
| C | 类型下拉 = 内置 + 项目自定义 | 18 个内置项；注入一个项目类别后它出现在“本项目自定义”分组，选中后 `node.planetClass` 落库 |
| D | 拾色器真的改了这一颗 | 改主色 → `node.planetColors.base` 落库 + **2D 画布像素**变（统计盘内洋红像素，不是看截图） |
| E | 退出编辑 / 进入行星地图 | 退编辑 → 面板消失；再进编辑点行星 → 点“进入行星地图” → `viewLevel === 'planet'` 且 `currentPlanet` 是那一颗 |

## 口径（踩过的）

· 点画布用**真实鼠标事件**（CDP），坐标由组件自己的 `renderer.getViewTransform()` 换算 —— 不在 Python 里猜行星在哪。
· 画布有 DPR：`getImageData` 用**后备存储像素**（CSS × devicePixelRatio），不是 CSS 像素。
· 改色后要等一拍再读像素（`updateNode` → watch → requestRender → rAF）——立即读会读到上一帧。
· 这个视图的单击行星在浏览模式是导航，所以必须先点“编辑地图”；这是产品设计，不是绕过。
"""
import json
import os
import sys
import time

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:      # noqa: BLE001
    pass

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json            # noqa: E402
from lib.helpers import ensure_case_state  # noqa: E402

HINT_MAGENTA = 60     # D：单通道门槛（0~255）
MIN_DELTA = 25        # D：改色前后“盘内洋红像素”至少增加这么多（实测远大于此）

ENTER_SYSTEM_JS = r"""(() => {
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const sys = s.nodes.find((n) => n.layer === 'galaxy'
    && s.nodes.some((p) => p.layer === 'planet' && p.parentId === n.id));
  if (!sys) return JSON.stringify({ ok: false, why: 'no-system-with-planets' });
  s.enterSystemDetail(sys);
  return JSON.stringify({ ok: true, id: sys.id, name: sys.displayName || sys.name, level: s.viewLevel });
})()"""

# 组件 setupState：canvas 在 setupState 里可能已被解包，也可能还是 ref（两者都接）
S3 = r"""(() => {
  const root = document.querySelector('.system-detail-container');
  if (!root) return null;
  const inst = root.__vueParentComponent;
  const st = inst && inst.setupState;
  if (!st) return null;
  const cvs = (st.canvas && st.canvas.value) ? st.canvas.value : st.canvas;
  return { st, cvs };
})()"""

CLICK_EDIT_JS = r"""(() => {
  const b = Array.from(document.querySelectorAll('.header-actions button'))
    .find((x) => (x.textContent || '').includes('编辑地图'));
  if (!b) return JSON.stringify({ ok: false, why: 'no-edit-button' });
  b.click();
  return JSON.stringify({ ok: true });
})()"""

DONE_EDIT_JS = r"""(() => {
  const b = Array.from(document.querySelectorAll('.header-actions button'))
    .find((x) => (x.textContent || '').includes('完成编辑'));
  if (!b) return JSON.stringify({ ok: false, why: 'no-done-button' });
  b.click();
  return JSON.stringify({ ok: true });
})()"""

POS_JS = r"""(() => {
  const holder = %s;
  if (!holder) return JSON.stringify({ ok: false, why: 'no-component' });
  const { st, cvs } = holder;
  const row = st.planetLayouts.find((p) => !p.isMoon && p.layer === 'planet'
    && !(p.tags || []).includes('空间站'));
  if (!row) return JSON.stringify({ ok: false, why: 'no-planet' });
  const vt = st.renderer.getViewTransform();
  const rect = cvs.getBoundingClientRect();
  return JSON.stringify({
    ok: true,
    id: row.id,
    name: row.displayName || row.name,
    editMode: st.editMode,
    panel: !!document.querySelector('[data-testid="planet-props-panel"]'),
    userMoved: !!row.userMoved,
    pageX: rect.left + row.x * vt.scale + vt.x + cvs.clientWidth / 2,
    pageY: rect.top + row.y * vt.scale + vt.y + cvs.clientHeight / 2,
  });
})()""" % S3


def click_at(cdp, x, y):
    for ev in ('mouseMoved', 'mousePressed', 'mouseReleased'):
        cdp.send('Input.dispatchMouseEvent', {
            'type': ev, 'x': x, 'y': y, 'button': 'left', 'clickCount': 1,
        })
    time.sleep(0.35)


def read_panel(cdp, planet_id):
    ok, obj = eval_json(cdp, r"""(() => {
      const holder = %s;
      if (!holder) return JSON.stringify({ ok: false, why: 'no-component' });
      const { st } = holder;
      const panel = document.querySelector('[data-testid="planet-props-panel"]');
      const sel = document.querySelector('[data-testid="planet-props-class"]');
      const base = document.querySelector('[data-testid="planet-props-color-base"]');
      const s = st.store;
      const node = s.nodes.find((n) => n.id === %s) || null;
      return JSON.stringify({
        ok: true,
        panel: !!panel,
        title: panel ? (panel.querySelector('h3') || {}).textContent || '' : '',
        select: !!sel,
        groups: sel ? Array.from(sel.querySelectorAll('optgroup')).map((g) => g.label) : [],
        options: sel ? Array.from(sel.options).length : 0,
        classValue: sel ? sel.value : '',
        baseValue: base ? base.value : '',
        nodeClass: node ? (node.planetClass || null) : null,
        nodeColors: node ? (node.planetColors || null) : null,
        nodeUserMoved: node ? !!node.userMoved : null,
        editMode: st.editMode,
      });
    })()""" % (S3, json.dumps(planet_id)), required=None, desc='读属性面板')
    if not ok:
        return {'ok': False, 'why': str(obj)}
    return obj if isinstance(obj, dict) else {'ok': False, 'why': f'返回的不是对象：{obj!r}'}


def run(cdp):
    ok, seeded = ensure_case_state(cdp)
    if not ok:
        return False, f'harness 基线项目没打开：{seeded}'

    ok, sysinfo = eval_json(cdp, ENTER_SYSTEM_JS, required=('ok',), desc='进入恒星系')
    if not ok or not sysinfo.get('ok'):
        return False, f'进不了带行星的恒星系：{sysinfo}'
    time.sleep(0.9)

    # ---------- A. 浏览模式：没有面板 ----------
    ok, pos = eval_json(cdp, POS_JS, required=('ok',), desc='读行星屏幕位置')
    if not ok or not pos.get('ok'):
        return False, f'读不到行星位置：{pos}'
    if pos.get('editMode') or pos.get('panel'):
        return False, f'进面板前状态不对（editMode={pos.get("editMode")} panel={pos.get("panel")}）'
    pid, pname = pos['id'], pos['name']

    # ---------- B. 编辑模式 + 真实点击行星 → 面板 ----------
    ok, mode = eval_json(cdp, CLICK_EDIT_JS, required=('ok',), desc='点编辑地图')
    if not ok or not mode.get('ok'):
        return False, f'点不到“编辑地图”：{mode}'
    ok, pos2 = eval_json(cdp, POS_JS, required=('ok',), desc='编辑模式下重新取位置')
    if not ok or not pos2.get('ok') or not pos2.get('editMode'):
        return False, f'编辑模式没打开：{pos2}'
    eval_json(cdp, r"""(() => {
      const holder = %s;
      const { cvs } = holder;
      window.__probe2d = { down: 0, up: 0, move: 0, errors: [] };
      cvs.addEventListener('mousedown', () => { window.__probe2d.down += 1; });
      cvs.addEventListener('mouseup', () => { window.__probe2d.up += 1; });
      cvs.addEventListener('mousemove', () => { window.__probe2d.move += 1; });
      window.addEventListener('error', (e) => window.__probe2d.errors.push(String(e.message)));
      return JSON.stringify({ ok: true });
    })()""" % S3, required=None, desc='挂点击探针')
    click_at(cdp, pos2['pageX'], pos2['pageY'])
    panel = read_panel(cdp, pid)
    if not panel.get('ok') or not panel.get('panel'):
        diag = eval_json(cdp, r"""(() => {
          const holder = %s;
          const { st, cvs } = holder;
          const row = st.planetLayouts.find((p) => p.id === %s);
          const vt = st.renderer.getViewTransform();
          const rect = cvs.getBoundingClientRect();
          const el = document.elementFromPoint(%f, %f);
          const mx = %f - rect.left;
          const my = %f - rect.top;
          const wx = (mx - cvs.clientWidth / 2 - vt.x) / vt.scale;
          const wy = (my - cvs.clientHeight / 2 - vt.y) / vt.scale;
          return JSON.stringify({
            editPlanetId: st.editPlanetId,
            hit: typeof st.hitTest === 'function' ? st.hitTest(row.x, row.y) : 'no-hitTest',
            hitAtClick: typeof st.hitTest === 'function' ? st.hitTest(wx, wy) : 'no-hitTest',
            clickWorld: { wx, wy },
            element: el ? (el.tagName + '.' + (el.className || '')) : null,
            probe: window.__probe2d || null,
            row: { x: row.x, y: row.y, id: row.id, layer: row.layer },
            vt, rect: { left: rect.left, top: rect.top, w: rect.width, h: rect.height },
            canvas: { cw: cvs.clientWidth, ch: cvs.clientHeight, w: cvs.width, h: cvs.height },
            point: { x: %f, y: %f },
          });
        })() """ % (S3, json.dumps(pid), pos2['pageX'], pos2['pageY'],
                   pos2['pageX'], pos2['pageY'], pos2['pageX'], pos2['pageY']),
                      required=None, desc='面板没开时的诊断')
        return False, f'编辑模式下点行星没有打开属性面板：{panel} / diag={diag}'
    if pname not in (panel.get('title') or ''):
        return False, f'面板标题没有行星名（title={panel.get("title")!r} / {pname!r}）'
    if not panel.get('select') or not panel.get('groups'):
        return False, f'类型下拉/分组不齐：{panel}'
    if panel.get('nodeUserMoved') != pos2.get('userMoved'):
        return False, (f'单击行星把它标成了 userMoved（会从公式位瞬移到旧坐标，点击链被打断）：'
                       f'before={pos2.get("userMoved")} after={panel.get("nodeUserMoved")}')
    if '内置类型' not in panel['groups']:
        return False, f'类型下拉没有内置分组：{panel.get("groups")}'
    if (panel.get('options') or 0) < 18:
        return False, f'内置类型不足 18 项：{panel.get("options")}'
    if not (panel.get('classValue') or ''):
        return False, f'类型下拉当前值为空（应当显示推断出来的类别）：{panel}'
    if not (panel.get('baseValue') or '').startswith('#'):
        return False, f'拾色器没有当前值：{panel}'

    # ---------- C. 项目自定义类别出现在下拉里，且选中后落库 ----------
    ok, custom = eval_json(cdp, r""" (async () => {
      const holder = %s;
      if (!holder) return JSON.stringify({ ok: false, why: 'no-component' });
      const { st } = holder;
      const s = st.store;
      const P = await import('/src/utils/planetArt.js');
      const def = P.customClassFromPalette({ name: '机检2D类', classId: 'ocean' });
      const added = s.addPlanetClass(def);
      await new Promise((r) => setTimeout(r, 220));
      const sel = document.querySelector('[data-testid="planet-props-class"]');
      const opt = sel ? Array.from(sel.options).find((o) => o.value === def.id) : null;
      const groups = sel ? Array.from(sel.querySelectorAll('optgroup')).map((g) => g.label) : [];
      if (sel) {
        sel.value = def.id;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await new Promise((r) => setTimeout(r, 240));
      const node = s.nodes.find((n) => n.id === %s) || null;
      return JSON.stringify({
        ok: true,
        added: !!(added && added.ok),
        id: def.id,
        label: def.label,
        option: opt ? opt.textContent : null,
        groups,
        nodeClass: node ? (node.planetClass || null) : null,
        classValue: sel ? sel.value : '',
      });
    })() """ % (S3, json.dumps(pid)), required=None, desc='注入自定义类别并选中')
    if not ok or not custom.get('ok'):
        return False, f'注入/选择自定义类别失败：{custom}'
    if not custom.get('added'):
        return False, f'addPlanetClass 被拒（真项目不该被拒）：{custom}'
    if custom.get('option') != custom.get('label'):
        return False, f'自定义类别没出现在 2D 下拉里：{custom}'
    if '本项目自定义' not in (custom.get('groups') or []):
        return False, f'2D 下拉没有“本项目自定义”分组：{custom}'
    if custom.get('nodeClass') != custom.get('id'):
        return False, f'2D 选类别后 node.planetClass 没落库：{custom}'
    if custom.get('classValue') != custom.get('id'):
        return False, f'2D 类型下拉显示值与所选项不一致：{custom}'

    # ---------- D. 拾色器：落库 + 2D 画布像素真的变 ----------
    ok, color = eval_json(cdp, r""" (async () => {
      const holder = %s;
      if (!holder) return JSON.stringify({ ok: false, why: 'no-component' });
      const { st, cvs } = holder;
      const row = st.planetLayouts.find((p) => p.id === %s);
      if (!row) return JSON.stringify({ ok: false, why: 'no-planet' });
      const vt = st.renderer.getViewTransform();
      const dpr = window.devicePixelRatio || 1;
      const sx = row.x * vt.scale + vt.x + cvs.clientWidth / 2;
      const sy = row.y * vt.scale + vt.y + cvs.clientHeight / 2;
      const count = () => {
        const ctx = cvs.getContext('2d');
        const pad = Math.round(48 * dpr);
        const x0 = Math.max(0, Math.round(sx * dpr) - pad);
        const y0 = Math.max(0, Math.round(sy * dpr) - pad);
        const w = Math.min(cvs.width - x0, pad * 2);
        const h = Math.min(cvs.height - y0, pad * 2);
        const d = ctx.getImageData(x0, y0, w, h).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i]; const g = d[i + 1]; const b = d[i + 2];
          if (r >= 150 && b >= 150 && g <= 110 && r - g >= 60 && b - g >= 60) n += 1;
        }
        return n;
      };
      const before = count();
      const inp = document.querySelector('[data-testid="planet-props-color-base"]');
      if (!inp) return JSON.stringify({ ok: false, why: 'no-color-input' });
      inp.value = '#ff00ff';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 420));
      const after = count();
      const node = st.store.nodes.find((n) => n.id === %s) || null;
      return JSON.stringify({
        ok: true,
        before,
        after,
        shown: inp.value,
        colors: node ? (node.planetColors || null) : null,
        canvas: { w: cvs.width, h: cvs.height, dpr },
      });
    })() """ % (S3, json.dumps(pid), json.dumps(pid)), required=None, desc='改色 + 盘内像素')
    if not ok or not color.get('ok'):
        return False, f'改色探针失败：{color}'
    if (color.get('colors') or {}).get('base') != '#ff00ff':
        return False, f'改色没写进 node.planetColors：{color}'
    if color.get('shown') != '#ff00ff':
        return False, f'拾色器显示值没跟着变：{color}'
    delta = (color.get('after') or 0) - (color.get('before') or 0)
    if delta < MIN_DELTA:
        return False, (f'2D 画布没跟着变：洋红像素 {color.get("before")} → {color.get("after")}'
                       f'（要求 +{MIN_DELTA}，canvas={color.get("canvas")}）')

    # ---------- E. 退出编辑 → 面板消失；再进 → “进入行星地图” ----------
    ok, done = eval_json(cdp, DONE_EDIT_JS, required=('ok',), desc='点完成编辑')
    if not ok or not done.get('ok'):
        return False, f'点不到“完成编辑”：{done}'
    time.sleep(0.3)
    gone = read_panel(cdp, pid)
    if gone.get('panel'):
        return False, f'退出编辑模式后属性面板还在：{gone}'
    if gone.get('editMode'):
        return False, f'退出编辑模式失败：{gone}'

    ok2, _edit = eval_json(cdp, CLICK_EDIT_JS, required=('ok',), desc='再次进编辑模式')
    if not ok2:
        return False, '再次进不了编辑模式'
    time.sleep(0.25)
    ok, pos3 = eval_json(cdp, POS_JS, required=('ok',), desc='再次取位置')
    if not ok or not pos3.get('ok'):
        return False, f'再次读位置失败：{pos3}'
    click_at(cdp, pos3['pageX'], pos3['pageY'])
    ok, nav = eval_json(cdp, r""" (async () => {
      const go = document.querySelector('[data-testid="planet-props-go"]');
      if (!go) return JSON.stringify({ ok: false, why: 'no-go-button' });
      go.click();
      await new Promise((r) => setTimeout(r, 650));
      const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
      return JSON.stringify({
        ok: true,
        level: s.viewLevel,
        planet: s.currentPlanet ? s.currentPlanet.id : null,
        detailGone: !document.querySelector('.system-detail-container'),
      });
    })() """, required=None, desc='点进入行星地图')
    if not ok or not nav.get('ok'):
        return False, f'面板里点不到“进入行星地图”：{nav}'
    if nav.get('level') != 'planet' or nav.get('planet') != pid:
        return False, f'“进入行星地图”没导航到那一颗：{nav}'
    if not nav.get('detailGone'):
        return False, f'进入行星地图后恒星系视图没卸载：{nav}'

    detail = json.dumps({
        'planet': pid,
        'custom': custom.get('label'),
        'magenta': [color.get('before'), color.get('after')],
        'canvas': color.get('canvas'),
        'groups': panel.get('groups'),
    }, ensure_ascii=False)
    return True, ('2D 天体属性面板：编辑模式点行星 → 类型（内置+自定义）/ 拾色器 → '
                  f'落库且画布像素变化 → 退编辑收起 → 进入行星地图 | {detail}')
