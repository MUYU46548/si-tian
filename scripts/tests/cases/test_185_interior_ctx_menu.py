#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 185：建筑内部的右键菜单（2026-11-25）

## 这条用例是为哪句话写的

用户 2026-11-24 的原话：
> “截图里左键应选中、右键应出菜单/删除，现在都没有。这是「随便乱点就能学会」的最低要求。”

实测属实：**`InteriorView.vue` 里一个 `contextmenu` 监听器都没有**（`GalaxyMap` 与
`ScenarioMap` 都有）。右键在建筑内部画布上是**完全的死键** —— 不弹菜单，也不 preventDefault
（所以还会顺带弹出浏览器的原生菜单）。

## 守什么（每一条都能单独红）

  a) 源码闸门：`onContextMenu` 必须接进 `useCanvasRenderer`（真入口在里面那条 `contextmenu`
     监听器上，它已 preventDefault）；不许在组件里再挂第二个监听器（双实现会漂移，test_88 的教训）。
  b) **浏览态**右键：不许弹菜单（菜单里全是写操作 —— 与 GalaxyMap §bug6 同一条纪律）。
  c) **编辑态**右键点在墙上：菜单真的出现在 DOM 里，且带「删除这面墙」；
     并且**这面墙真的被选中**（`selectedWallIds` 里有它）——“右键选中”是用户要的一半。
  d) 点击菜单项「删除这面墙」→ 墙真的少一面、**一条 undo 能撤回来**（写口没绕过 undo 栈）。
  e) 点在**空白处**右键：菜单也得出来（给工具入口），不能是空菜单 ——
     空菜单在用户眼里等于“坏了”。
  f) 点在**家具**上右键：有「旋转 90°」与删除项，旋转项真的把 rotation 改了（+90°）。

## 纪律（都是踩过的坑）

  · 派发的是**真实 `contextmenu` 事件**，不是 `click{button:2}` —— 后者是合成事件，
    修前的死路径也能被它“通过”（test_88 记着这个教训）。
  · 菜单 DOM 的键是 `.sitian-context-menu`（全局样式、非 scoped），**不是** `.context-menu`
    （那是剧本视图自研那套的类名）。这里用前者，与 U3 统一框架一致。
  · 判据读 **store 里的数据**（墙 id / furniture rotation），不读渲染结果 ——
    画布像素可以被缓存糊弄。
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json                          # noqa: E402
from lib.helpers import ensure_data_ready, ensure_test_building  # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
IV = "document.querySelector('.interior-container').__vueParentComponent.setupState"
CANVAS_SEL = "document.querySelector('.interior-container .canvas-wrapper canvas')"

# 菜单选择器：U3 统一框架的全局类名
MENU_SEL = '.sitian-context-menu'


def _j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


# ══════════════════════════════════════════════════════════════════
# a) 源码闸门
# ══════════════════════════════════════════════════════════════════
def source_gate():
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__)))))
    path = os.path.join(root, 'src', 'renderer', 'src', 'components', 'InteriorView.vue')
    with open(path, encoding='utf-8') as fh:
        src = fh.read()
    bad = []
    # ① onContextMenu 必须接进 renderer 选项
    if 'onContextMenu:' not in src:
        bad.append('InteriorView 没有把 onContextMenu 接进 useCanvasRenderer')
    # ② 不许自己再挂一个 contextmenu 监听（双实现会漂移）
    if 'addEventListener' in src and "'contextmenu'" in src:
        bad.append('组件里自己又挂了一个 contextmenu 监听器（真入口只该在 useCanvasRenderer）')
    # ③ 浏览态闸门必须在
    if 'if (!editMode.value) return;' not in src:
        bad.append('右键没有 editMode 闸门 —— 浏览态右键就能弹写操作菜单')
    # ④ 必须复用统一组件，不许另造一套
    if "from './ContextMenu.vue'" not in src:
        bad.append('没有复用统一的 ContextMenu.vue')
    if bad:
        return False, '；'.join(bad)
    return True, '源码闸门 4 项全过（onContextMenu 接线 / 无双监听 / editMode 闸门 / 复用统一组件）'


# ══════════════════════════════════════════════════════════════════
# 公共 JS 片段
# ══════════════════════════════════════════════════════════════════
JS_COMMON = r"""
  const s = __STORE__;
  const iv = __IV__;
  const c = __CANVAS__;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const menuEl = () => document.querySelector('__MENU__');
  const menuTexts = () => {
    const m = menuEl();
    return m ? Array.from(m.querySelectorAll('.menu-item')).map((x) => (x.textContent || '').trim()) : [];
  };
  // 世界坐标 → 屏幕坐标（用组件自己的相机，别自己算一套）
  const toScreen = (wx, wy) => {
    const vt = iv.renderer.getViewTransform();
    const r = c.getBoundingClientRect();
    return {
      x: r.left + wx * vt.scale + vt.x + c.clientWidth / 2,
      y: r.top + wy * vt.scale + vt.y + c.clientHeight / 2,
    };
  };
  // 🔴 真实 contextmenu（不是 click{button:2}）
  const fireCtx = (sx, sy) => {
    const ev = new MouseEvent('contextmenu', {
      clientX: sx, clientY: sy, bubbles: true, cancelable: true, button: 2, buttons: 2,
    });
    c.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
"""


def _probe(cdp, body, desc):
    ok, obj = eval_json(cdp, "(async () => {\n" + JS_COMMON
                        .replace('__STORE__', STORE)
                        .replace('__IV__', IV)
                        .replace('__CANVAS__', CANVAS_SEL)
                        .replace('__MENU__', MENU_SEL)
                        + "\nconst __out = await (async () => {\n" + body + "\n})();\n"
                        + "return JSON.stringify(__out);\n})()", desc=desc, required=('fails',))
    if not ok:
        return {'fails': [f'探针失败：{obj}']}
    return obj


def run(cdp):
    ensure_data_ready(cdp)
    fails, notes = [], []

    # a) 源码闸门
    ok, msg = source_gate()
    if not ok:
        fails.append(f'[a 源码] {msg}')
    notes.append(msg)

    okb, binfo = ensure_test_building(cdp)
    if not okb:
        return False, f'建筑 fixture 失败：{msg}'
    bid = binfo['id']
    wait_for(cdp, "!!document.querySelector('.interior-container')", timeout=30, desc='内部视图挂载')

    # 准备：一层 + 四面墙围一间（墙的坐标固定，用例里好算屏幕位置）
    prep = _j(cdp, """(() => {
      const s = %s; const iv = %s; const bid = %s;
      let d = s.interiorData[bid];
      if (!d || !(d.floors || []).length) s.addFloor(bid, '右键层');
      d = s.interiorData[bid];
      const f = d.floors[0];
      (f.walls || []).slice().forEach((w) => s.removeWall(bid, f.id, w.id));
      const pts = [[-200, -150], [200, -150], [200, 150], [-200, 150]];
      for (let i = 0; i < 4; i++) {
        const a = pts[i], b = pts[(i + 1) %% 4];
        s.addWall(bid, f.id, { start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, thickness: 12 });
      }
      iv.selectFloor(f.id);
      iv.editMode = true;
      iv.interactionMode = 'pan';
      return JSON.stringify({ fid: f.id, walls: (f.walls || []).length });
    })()""" % (STORE, IV, json.dumps(bid)))
    if not prep.get('fid'):
        return False, f'准备楼层失败：{prep}'
    fid = prep['fid']
    time.sleep(0.2)

    try:
        # ── b) 浏览态：右键不许弹菜单 ───────────────────────────────────
        r = _probe(cdp, """
  iv.editMode = false;
  await wait(120);
  const pt = toScreen(0, -150);   // 上边那面墙的中点
  const prevented = fireCtx(pt.x, pt.y);
  await wait(160);
  const n = menuEl() ? 1 : 0;
  const out = { fails: [], browseMenu: n, prevented, editMode: iv.editMode };
  if (n !== 0) out.fails.push('浏览态右键弹出了菜单 —— 写操作在浏览态可达');
  return out;
""", 'b 浏览态右键')
        if r.get('fails'):
            fails += [f'[b] {x}' for x in r['fails']]
        notes.append(f"b 浏览态右键：菜单 {r.get('browseMenu')} 个（应为 0）")

        # ── c) 编辑态右键墙面：菜单出来 + 这面墙被选中 ────────────────────
        r = _probe(cdp, """
  iv.editMode = true;
  await wait(120);
  const pt = toScreen(0, -150);
  const prevented = fireCtx(pt.x, pt.y);
  await wait(200);
  const texts = menuTexts();
  const out = {
    fails: [], prevented, texts, editMode: iv.editMode,
    selectedWalls: (iv.selectedWallIds || []).length,
    selectedWallId: iv.selectedWallId || null,
  };
  if (!menuEl()) out.fails.push('编辑态右键没有弹出菜单（真机上右键功能整片点不到）');
  if (!prevented) out.fails.push('没有 preventDefault（会同时弹出浏览器原生菜单）');
  if (!texts.some((t) => t.includes('删除这面墙'))) out.fails.push('菜单缺少「删除这面墙」：' + JSON.stringify(texts));
  if (!out.selectedWalls) out.fails.push('右键没有选中这面墙（selectedWallIds 为空）');
  return out;
""", 'c 编辑态右键墙')
        if r.get('fails'):
            fails += [f'[c] {x}' for x in r['fails']]
        notes.append(f"c 编辑态右键墙：prevented={r.get('prevented')} 选中墙 {r.get('selectedWalls')} 面")
        notes.append(f"   菜单项：{r.get('texts')}")

        # ── d) 点「删除这面墙」→ 真少一面 + 一条 undo 回来 ─────────────────
        r = _probe(cdp, """
  const out = { fails: [] };
  const before = ((iv.currentFloor && iv.currentFloor.walls) || []).length;
  const m = menuEl();
  if (!m) { out.fails.push('菜单不在，无法点删除'); return out; }
  const item = Array.from(m.querySelectorAll('.menu-item'))
    .find((x) => (x.textContent || '').trim().includes('删除这面墙'));
  if (!item) { out.fails.push('找不到「删除这面墙」这一项'); return out; }
  item.click();
  await wait(220);
  const after = ((iv.currentFloor && iv.currentFloor.walls) || []).length;
  const menuClosed = !menuEl();
  s.undo();
  await wait(220);
  const undone = ((iv.currentFloor && iv.currentFloor.walls) || []).length;
  out.before = before; out.after = after; out.undone = undone; out.menuClosed = menuClosed;
  if (after !== before - 1) out.fails.push(`点删除后墙数 ${before} → ${after}（应 -1）`);
  if (!menuClosed) out.fails.push('点了菜单项之后菜单没有收起');
  if (undone !== before) out.fails.push(`一条 undo 后墙数 ${undone}（应回到 ${before}）`);
  return out;
""", 'd 菜单删除')
        if r.get('fails'):
            fails += [f'[d] {x}' for x in r['fails']]
        notes.append(f"d 菜单删除：墙 {r.get('before')} → {r.get('after')} → undo {r.get('undone')}"
                     f"（菜单收起={r.get('menuClosed')}）")

        # ── e) 空白处右键：菜单也要出来（不能是空菜单） ─────────────────────
        r = _probe(cdp, """
  const out = { fails: [] };
  fireCtx(...Object.values(toScreen(900, 900)));   // 房间外很远处
  await wait(200);
  const texts = menuTexts();
  out.texts = texts;
  out.hasMenu = !!menuEl();
  if (!out.hasMenu) out.fails.push('空白处右键没有菜单（用户会以为右键坏了）');
  if (texts.length < 2) out.fails.push('空白处菜单几乎是空的：' + JSON.stringify(texts));
  if (!texts.some((t) => t.includes('家具') || t.includes('铺满'))) {
    out.fails.push('空白处菜单缺少工具入口：' + JSON.stringify(texts));
  }
  return out;
""", 'e 空白处右键')
        if r.get('fails'):
            fails += [f'[e] {x}' for x in r['fails']]
        notes.append(f"e 空白处右键：{r.get('texts')}")

        # ── f) 家具右键：旋转项真的改 rotation ────────────────────────────
        r = _probe(cdp, """
  const out = { fails: [] };
  // 先关掉菜单
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await wait(120);
  const created = s.addFurniture(__BID__, __FID__, {
    name: '右键桌', type: 'table', x: 0, y: 0, width: 140, height: 80, rotation: 0,
  });
  if (!created) { out.fails.push('测试家具没建起来'); return out; }
  await wait(150);
  // 家具中心在 (70, 40)
  fireCtx(...Object.values(toScreen(70, 40)));
  await wait(220);
  const texts = menuTexts();
  out.texts = texts;
  if (!texts.some((t) => t.includes('旋转'))) out.fails.push('家具右键菜单缺少旋转项：' + JSON.stringify(texts));
  const rotate = Array.from((menuEl() || document.createElement('div')).querySelectorAll('.menu-item'))
    .find((x) => (x.textContent || '').trim().includes('旋转'));
  if (rotate) {
    rotate.click();
    await wait(220);
    const f = iv.currentFloor;
    const it = (f.furniture || []).find((x) => x.id === created.id);
    out.rotation = it ? it.rotation : null;
    if (!it || it.rotation !== 90) out.fails.push(`旋转后 rotation=${it && it.rotation}（应为 90）`);
  }
  return out;
""".replace('__BID__', json.dumps(bid)).replace('__FID__', json.dumps(fid)), 'f 家具右键旋转')
        if r.get('fails'):
            fails += [f'[f] {x}' for x in r['fails']]
        notes.append(f"f 家具右键：{r.get('texts')} → rotation={r.get('rotation')}")
    except Exception as e:      # noqa: BLE001
        return False, '异常：%s' % e
    finally:
        # 清场：撤掉本轮加的东西（家具 / 墙都不留），并把编辑模式关回去
        try:
            _j(cdp, """(() => {
              const s = %s; const iv = %s; const bid = %s; const fid = %s;
              const d = s.interiorData[bid];
              const f = d && (d.floors || []).find((x) => x.id === fid);
              if (f) {
                ((f.furniture || []).slice()).forEach((it) => s.removeFurniture(bid, fid, it.id));
                ((f.walls || []).slice()).forEach((w) => s.removeWall(bid, fid, w.id));
              }
              iv.editMode = false;
              return JSON.stringify({ ok: true });
            })()""" % (STORE, IV, json.dumps(bid), json.dumps(fid)))
        except Exception:       # noqa: BLE001
            pass

    detail = '；'.join(notes)
    if fails:
        return False, detail + ' ｜ ❌ ' + '；'.join(fails)
    return True, detail
