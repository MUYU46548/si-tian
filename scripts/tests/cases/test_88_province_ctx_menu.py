#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 88：剧本视图的省份右键菜单**必须由真实的 contextmenu 事件打开**

来源：2026-10-07 做「剧本专用真机演练」时发现的真缺陷。

缺陷原貌（修复前）：
  `contextMenu.value = { show: true, … }` 只出现在 `onCanvasClick` 的
  `if (event.button === 2)` 分支里 —— 而 **浏览器对右键根本不派发 `click`**
  （只派发 `contextmenu` / `auxclick`），当时唯一的 contextmenu 监听器是
  `(e) => e.preventDefault()`，**只拦不弹** → 真机上**右键菜单整片打不开**。
  失效后果据实说：菜单里「重命名」「更改生物群系」在属性面板另有入口、「删除」在
  「更多 → 删除 (E)」工具另有入口，**真正只剩这个菜单有的能力是「复制省份」**；
  但"右键点了没反应"本身就是真缺陷（用户第一反应就是右键）。

  为什么长期没被发现：CDP 用例里自己 `dispatchEvent(new MouseEvent('click', {button:2}))`
  就能把菜单"打开"——**合成事件比真实浏览器宽松**，于是行为断言与源码守卫双双为真。
  这与本项目"测试 mock 不许比真实边界更宽松"是同一条纪律。

修法：抽出唯一实现 `openProvinceContextMenu(event)`，注册到**真正的 `contextmenu` 监听器**
（同时保留 `preventDefault`，否则会弹出浏览器原生菜单）；`click` 分支保留给合成事件。

本用例覆盖：
  f0 源码守卫：`contextmenu` 监听器必须调用开菜单函数；开菜单只有一处实现；
     `click{button:2}` 那条旧分支不许再自己拼一份 `contextMenu.value = { show: true … }`。
  f1 用**真实 contextmenu 事件**打开菜单（这条就是回归本身：修前必红）；
     同时校验原生菜单被 preventDefault 拦下、菜单四项齐全。
  f2 走菜单删除省份 → 省份真的少了、级联 / undo 正常。
"""

import io
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json  # noqa: E402
from lib.helpers import ensure_data_ready, open_toolbar_more  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
SM = 'src/renderer/src/components/ScenarioMap.vue'


def _read(rel):
    return io.open(os.path.join(ROOT, rel), encoding='utf-8').read()


def _code_only(src):
    src = re.sub(r'<!--.*?-->', '', src, flags=re.S)
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    return re.sub(r'(?m)//[^\n]*', '', src)


# ══════════════════════════════════════════════════════════════════
def sub_source_guards(cdp):
    bad = []
    sm = _code_only(_read(SM))

    # ① contextmenu 监听器必须真的开菜单（只 preventDefault = 点不到）
    m = re.search(r"addEventListener\(\s*'contextmenu'\s*,\s*\(([^)]*)\)\s*=>\s*\{(.*?)\}\s*\)", sm, re.S)
    if not m:
        bad.append("找不到 canvas 的 contextmenu 监听器")
    else:
        if 'openProvinceContextMenu(' not in m.group(2):
            bad.append('contextmenu 监听器没有调用 openProvinceContextMenu（右键菜单在真机上打不开）')
        if 'preventDefault' not in m.group(2):
            bad.append('contextmenu 监听器没有 preventDefault（会同时弹出浏览器原生菜单）')

    # ② 开菜单只能有一处实现
    n = len(re.findall(r'contextMenu\.value\s*=\s*\{\s*show:\s*true', sm))
    if n != 1:
        bad.append(f'开菜单的实现有 {n} 处（应恰好 1 处：openProvinceContextMenu）')

    # ③ openProvinceContextMenu 必须是函数定义，且 click 分支复用它
    if 'function openProvinceContextMenu(' not in sm:
        bad.append('缺少 openProvinceContextMenu 的唯一实现')
    if re.search(r'if\s*\(event\.button === 2\)\s*\{[^}]*contextMenu\.value', sm):
        bad.append('click 分支里又拼了一份 contextMenu.value（双实现会漂移）')

    if bad:
        return False, '源码守卫失败：' + '；'.join(bad)
    return True, 'contextmenu 真入口 + preventDefault + 开菜单单实现 + click 分支复用'


# ══════════════════════════════════════════════════════════════════
SETUP_JS = r"""(async () => {
  const fails = [];
  const s = __STORE__;
  const sc = __SC__;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.confirm = () => true;

  const KEY = '__case88basemap__';
  window.__t88 = { KEY, prevKey: sc.baseMapKey, PID: 'p88a' };
  sc.baseMapKey = KEY;
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: '用例88底图' });
  await wait(400);

  const cvs = document.querySelector('.scenario-map-container canvas');
  if (!cvs) return JSON.stringify({ fails: ['找不到剧本画布'] });
  const rr = cvs.getBoundingClientRect();
  const cw = Math.round(rr.width), ch = Math.round(rr.height);

  // 屏幕中心对应的世界坐标 → 在它周围造一个省
  const w0 = sc.screenToWorld(cw / 2, ch / 2);
  const pts = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    pts.push({ x: Math.round(w0.x + Math.cos(a) * 160), y: Math.round(w0.y + Math.sin(a) * 160) });
  }
  const made = s.addBaseProvince(KEY, { id: 'p88a', name: '用例88省', points: pts }, { checkOverlap: false });
  if (!made || made.success === false) return JSON.stringify({ fails: ['造省失败：' + JSON.stringify(made)] });
  await wait(500);

  // 画布可能因「省份数变化」自动适屏 → 扫一遍屏幕网格，找出这台相机下真的能命中的点
  let hit = null;
  for (let y = 30; y < ch && !hit; y += 30) {
    for (let x = 30; x < cw; x += 30) {
      const w = sc.screenToWorld(x, y);
      const p = sc.findProvinceAt(w.x, w.y);
      if (p && p.id === 'p88a') { hit = { x, y }; break; }
    }
  }
  if (!hit) return JSON.stringify({ fails: ['造出来的省在画布上扫不到（相机/适屏问题）'] });
  window.__t88.hit = hit;
  sc.setTool('select');
  await wait(150);
  return JSON.stringify({ fails, canvas: [cw, ch], hit });
})()"""


def _setup(cdp):
    cdp.eval(
        "(() => { const b = Array.from(document.querySelectorAll('button'))"
        ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()"
    )
    try:
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式挂载')
    except RuntimeError as e:
        return False, f'剧本模式未挂载：{e}'
    time.sleep(1.2)
    ok, res = eval_json(cdp, SETUP_JS.replace('__STORE__', STORE).replace('__SC__', SC),
                        desc='装置：造省', required=('fails',))
    if not ok:
        return False, res
    if res['fails']:
        return False, '装置失败：' + '；'.join(res['fails'])
    return True, res


# ══════════════════════════════════════════════════════════════════
# f1 真实 contextmenu 事件必须打开菜单
# ══════════════════════════════════════════════════════════════════
F1_JS = r"""(async () => {
  const fails = [];
  const notes = {};
  const s = __STORE__;
  const sc = __SC__;
  const { KEY, hit } = window.__t88;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const cvs = document.querySelector('.scenario-map-container canvas');
  const rr = cvs.getBoundingClientRect();

  // 🔴 关键词：派发的是 **contextmenu**（真实浏览器对右键就是派发这个），
  //    不是 `click{button:2}` —— 后者是合成事件，修前的死路径也能被它"通过"。
  const ev = new MouseEvent('contextmenu', {
    clientX: rr.left + hit.x, clientY: rr.top + hit.y,
    bubbles: true, cancelable: true, button: 2, buttons: 2,
  });
  cvs.dispatchEvent(ev);
  await wait(200);

  notes.prevented = ev.defaultPrevented;
  const menu = document.querySelector('.context-menu');
  if (!menu) {
    fails.push('🔴 派发真实 contextmenu 后菜单没有出现（真机上右键功能整片点不到）');
    return JSON.stringify({ fails, notes });
  }
  if (!ev.defaultPrevented) fails.push('没有 preventDefault（会同时弹出浏览器原生菜单）');
  const items = Array.from(menu.querySelectorAll('.ctx-item')).map((x) => (x.textContent || '').trim());
  notes.items = items;
  for (const want of ['重命名', '更改生物群系', '复制省份', '删除']) {
    if (!items.some((t) => t.includes(want))) fails.push('菜单缺少「' + want + '」');
  }
  if (!sc.selectedProvince || sc.selectedProvince.id !== 'p88a') {
    fails.push('右键没有选中该省份：' + JSON.stringify(sc.selectedProvince && sc.selectedProvince.id));
  }
  return JSON.stringify({ fails, notes });
})()"""


def sub_reachability(cdp):
    ok, res = eval_json(cdp, F1_JS.replace('__STORE__', STORE).replace('__SC__', SC),
                        desc='右键菜单可达性', required=('fails',))
    if not ok:
        return False, res
    if res['fails']:
        return False, '右键菜单可达性失败：' + '；'.join(res['fails'])
    n = res.get('notes', {})
    return True, (f"真实 contextmenu 打开了菜单（原生化菜单已拦：prevented={n.get('prevented')}）"
                  f"，四项齐全：{n.get('items')}")


# ══════════════════════════════════════════════════════════════════
# f2 走菜单删除省份
# ══════════════════════════════════════════════════════════════════
F2_JS = r"""(async () => {
  const fails = [];
  const notes = {};
  const s = __STORE__;
  const sc = __SC__;
  const { KEY, hit } = window.__t88;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.confirm = () => true;

  const before = (s.baseMaps[KEY].terrain || []).length;
  const cvs = document.querySelector('.scenario-map-container canvas');
  const rr = cvs.getBoundingClientRect();
  cvs.dispatchEvent(new MouseEvent('contextmenu', {
    clientX: rr.left + hit.x, clientY: rr.top + hit.y,
    bubbles: true, cancelable: true, button: 2, buttons: 2,
  }));
  await wait(200);
  const del = document.querySelector('.context-menu .ctx-item.danger');
  if (!del) return JSON.stringify({ fails: ['菜单里没有删除项'] });
  del.click();
  await wait(320);

  const after = (s.baseMaps[KEY].terrain || []).length;
  notes.before = before; notes.after = after;
  if (after !== before - 1) fails.push(`删除后省份数应为 ${before - 1}，实际 ${after}`);
  if ((s.baseMaps[KEY].terrain || []).some((p) => p.id === 'p88a')) {
    fails.push('被删的省份还在表里');
  }
  if (document.querySelector('.context-menu')) fails.push('删除后菜单没有收起');

  s.undo();
  await wait(260);
  const back = (s.baseMaps[KEY].terrain || []).length;
  notes.undo = back;
  if (back !== before) fails.push(`undo 后应回到 ${before} 个省份，实际 ${back}`);
  return JSON.stringify({ fails, notes });
})()"""


def sub_delete_via_menu(cdp):
    ok, res = eval_json(cdp, F2_JS.replace('__STORE__', STORE).replace('__SC__', SC),
                        desc='走菜单删除省份', required=('fails',))
    if not ok:
        return False, res
    if res['fails']:
        return False, '走菜单删除省份失败：' + '；'.join(res['fails'])
    n = res.get('notes', {})
    return True, (f"菜单删除生效：省份 {n.get('before')} → {n.get('after')}，undo 回到 {n.get('undo')}；菜单自动收起")


CLEANUP_JS = r"""(() => {
  const s = __STORE__;
  const t = window.__t88 || {};
  const sc = __SC__;
  try {
    sc.baseMapKey = t.prevKey != null ? t.prevKey : null;
    if (t.KEY && s.baseMaps[t.KEY]) delete s.baseMaps[t.KEY];
  } catch (e) { return 'cleanup-err:' + e.message; }
  return 'ok';
})()"""


def run(cdp):
    ensure_data_ready(cdp)
    results = []

    try:
        ok, detail = sub_source_guards(cdp)
    except Exception as e:
        ok, detail = False, f'异常: {e}'
    results.append(('f0 源码守卫', ok, detail))

    setup_ok, setup_detail = _setup(cdp)
    if not setup_ok:
        results.append(('f1 右键可达性', False, setup_detail))
        results.append(('f2 菜单删省', False, setup_detail))
    else:
        for name, fn in (('f1 右键可达性', sub_reachability), ('f2 菜单删省', sub_delete_via_menu)):
            try:
                ok, detail = fn(cdp)
            except Exception as e:
                ok, detail = False, f'异常: {e}'
            results.append((name, ok, detail))
        try:
            cdp.eval(CLEANUP_JS.replace('__STORE__', STORE).replace('__SC__', SC))
        except Exception:
            pass

    failed = [f'{n}: {d}' for n, o, d in results if not o]
    if failed:
        return False, (f'省份右键菜单 {len(results) - len(failed)}/{len(results)} 子测试通过；失败：\n    '
                       + '\n    '.join(failed))
    return True, ('省份右键菜单 ' + f'{len(results)}/{len(results)} 全通过 — '
                  + '；'.join(d for _, _, d in results))
