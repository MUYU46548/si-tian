#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 53：可用性加固（2026-09-20 用户实测反馈的 5 条）

覆盖：
  a) 项目面板「新建项目」输入框：面板一打开就自动聚焦（不依赖点击）、占位文字不再硬编码 ROSA、
     聚焦有可见描边、行内间隙点击也能聚焦、能真的输入并让「新建」变可用
  b) 「Git 快照」按钮在位，且 title/回执说明了「司天不会自动初始化 git 仓库」（目录非仓库时给去处）
  c) 新建的空项目：剧本模式**不再**凭空造出「德斯特星」空底图（那曾把自用剧本名硬编码进产品），
     而是显示「还没有底图」提示；真正落笔时才懒建「底图 N」
  d) 世界选择空态卡片：三个按钮不再溢出卡片边界（宽/窄窗口都断言）
  e) 渲染护栏：绘制路径全部走 px()（裸「数字 / cameraScale」清零、坐标变换仍用真实 scale）；
     renderFrame 抛异常被捕获（不冒泡）、连续 3 帧后暂停渲染并给出可见 + 可恢复的提示
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for  # noqa: E402
from lib.helpers import ensure_data_ready  # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
PANEL = "document.querySelector('.project-panel')"


def _click_toolbar(cdp, title_prefix):
    return cdp.eval("""(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => (x.getAttribute('title') || '').startsWith(%s));
      if (!b) return 'no-btn';
      b.click();
      return 'ok';
    })()""" % json.dumps(title_prefix))


def _real_click(cdp, x, y):
    cdp.send('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': x, 'y': y, 'button': 'none'})
    cdp.send('Input.dispatchMouseEvent', {'type': 'mousePressed', 'x': x, 'y': y, 'button': 'left', 'clickCount': 1})
    cdp.send('Input.dispatchMouseEvent', {'type': 'mouseReleased', 'x': x, 'y': y, 'button': 'left', 'clickCount': 1})


def _type(cdp, text):
    """真实输入路径：先 Input.insertText，失败退回逐字 keyDown"""
    cdp.send('Input.insertText', {'text': text})
    time.sleep(0.25)
    v = cdp.eval("document.querySelector('.project-panel .pp-input').value")
    if v != text:
        cdp.eval("document.querySelector('.project-panel .pp-input').value = ''")
        for ch in text:
            cdp.send('Input.dispatchKeyEvent', {'type': 'keyDown', 'text': ch, 'key': ch})
            cdp.send('Input.dispatchKeyEvent', {'type': 'keyUp', 'key': ch})
        time.sleep(0.25)
    return cdp.eval("document.querySelector('.project-panel .pp-input').value")


JS_PANEL = r"""(() => {
  const fails = [];
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + e + ')' : '')); };
  const inp = document.querySelector('.project-panel .pp-input');
  if (!inp) return JSON.stringify({ fails: ['面板输入框不存在'] });
  ok('面板打开后输入框自动聚焦（不依赖点击）', document.activeElement === inp,
     document.activeElement && (document.activeElement.tagName + '.' + document.activeElement.className));
  ok('占位文字不硬编码 ROSA', !/rosa/i.test(inp.placeholder || ''), inp.placeholder);
  const cs = getComputedStyle(inp);
  ok('聚焦有可见描边', cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2,
     cs.outlineStyle + '/' + cs.outlineWidth);
  const btn = document.querySelector('.project-panel .pp-name-row .pp-btn');
  const ir = inp.getBoundingClientRect(), br = btn.getBoundingClientRect();
  return JSON.stringify({ fails, gapX: Math.round((ir.right + br.left) / 2), gapY: Math.round(ir.top + ir.height / 2) });
})()"""

JS_GIT_BTN = r"""(() => {
  const fails = [];
  const b = Array.from(document.querySelectorAll('.project-panel .pp-btn')).find(x => x.textContent.trim() === 'Git 快照');
  if (!b) return JSON.stringify({ fails: ['没有「Git 快照」按钮'] });
  const title = b.getAttribute('title') || '';
  if (!/不会自动初始化|自行在项目目录 git init/.test(title)) fails.push('按钮 title 未说明「不会自动初始化仓库」：' + title);
  b.click();
  return JSON.stringify({ fails, title });
})()"""

JS_SCENARIO_EMPTY = r"""(() => {
  const fails = [];
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + e + ')' : '')); };
  const same = (l, g, w) => { if (String(g) !== String(w)) fails.push(l + ' got=' + g + ' want=' + w); };
  const s = PLACEHOLDER_STORE;
  const sc = PLACEHOLDER_SC;
  if (!sc) return JSON.stringify({ fails: ['ScenarioMap 未挂载'] });
  const keys = Object.keys(s.baseMaps || {});
  ok('空项目里没有任何底图', keys.length === 0, JSON.stringify(keys));
  same('baseMapKey 为空（不再默认德斯特星）', sc.baseMapKey, '');
  ok('没有凭空造出「德斯特星」', !keys.includes('德斯特星'), JSON.stringify(keys));
  ok('画布给出「还没有底图」提示', !!document.querySelector('[data-testid="scenario-empty-hint"]'));
  ok('状态栏提示未加载底图', String(sc.statusText).includes('未加载底图'), sc.statusText);

  // 懒建：切到绘制工具后真实落笔一次 → 才建「底图 N」（名字不借用任何真实剧本）
  sc.setTool('draw');
  const cvs = document.querySelector('.scenario-canvas-wrap canvas');
  const r = cvs.getBoundingClientRect();
  const mk = (t) => new MouseEvent(t, { clientX: r.left + 180, clientY: r.top + 140, bubbles: true, cancelable: true, button: 0 });
  cvs.dispatchEvent(mk('mousedown'));
  cvs.dispatchEvent(mk('mouseup'));
  const keys2 = Object.keys(s.baseMaps || {});
  ok('落笔时才懒建底图（恰一张）', keys2.length === 1, JSON.stringify(keys2));
  ok('懒建名不与真实剧本重名', keys2.length === 1 && /^底图 \d+$/.test(keys2[0]), JSON.stringify(keys2));
  same('baseMapKey 指向懒建底图', sc.baseMapKey, keys2[0] || '');
  ok('懒建的是空底图', !((s.baseMaps[keys2[0]] || {}).terrain || []).length, JSON.stringify((s.baseMaps[keys2[0]] || {}).terrain));

  return JSON.stringify({ fails, keys: keys2 });
})()"""

JS_EMPTY_STATE = r"""(() => {
  const fails = [];
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + e + ')' : '')); };
  const state = document.querySelector('.world-selector .empty-state');
  if (!state) return JSON.stringify({ fails: ['世界选择空态未渲染'] });
  const sr = state.getBoundingClientRect();
  const actions = state.querySelector('.empty-actions');
  if (!actions) return JSON.stringify({ fails: ['空态里没有按钮行'] });
  const ar = actions.getBoundingClientRect();
  ok('按钮行不超出卡片', ar.left >= sr.left - 1 && ar.right <= sr.right + 1,
     Math.round(ar.left) + '..' + Math.round(ar.right) + ' vs 卡片 ' + Math.round(sr.left) + '..' + Math.round(sr.right));
  const over = [];
  for (const b of actions.querySelectorAll('button')) {
    const br = b.getBoundingClientRect();
    if (br.left < sr.left - 1 || br.right > sr.right + 1) over.push(b.textContent.trim() + ':' + Math.round(br.left) + '..' + Math.round(br.right));
  }
  ok('每个按钮都落在卡片内（不溢出）', over.length === 0, over.join(' | '));
  ok('按钮行在视口内', ar.left >= -1 && ar.right <= window.innerWidth + 1,
     Math.round(ar.left) + '..' + Math.round(ar.right) + ' / 视口 ' + window.innerWidth);
  return JSON.stringify({ fails, card: [Math.round(sr.left), Math.round(sr.right)],
    actions: [Math.round(ar.left), Math.round(ar.right)],
    btns: Array.from(actions.querySelectorAll('button')).map(b => b.textContent.trim()) });
})()"""

JS_SRC = r"""(() => {
  const fails = [];
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + e + ')' : '')); };
  const txt = window.__SCENARIO_SRC__ || '';
  if (!txt) return JSON.stringify({ fails: ['未取到 ScenarioMap 源码'] });
  const pxUses = (txt.match(/px\(/g) || []).length;
  ok('px() 助手覆盖绘制路径', pxUses >= 40, pxUses);
  const raw = (txt.match(/[^\w.]\d+(?:\.\d+)?\s*\/\s*cameraScale\.value/g) || []).length;
  ok('裸「数字 / cameraScale」已清零', raw === 0, raw);
  ok('坐标变换仍用真实 scale', /\(sx - cameraX\.value\) \/ cameraScale\.value/.test(txt));
  ok('渲染护栏在位', /renderPaused/.test(txt) && /function resumeRender/.test(txt));
  ok('不再硬编码默认底图德斯特星', !/ref\('德斯特星'\)/.test(txt));
  return JSON.stringify({ fails, pxUses, rawDiv: raw });
})()"""

JS_GUARD = r"""(() => {
  const fails = [];
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + e + ')' : '')); };
  const s = PLACEHOLDER_STORE;
  const sc = PLACEHOLDER_SC;
  const key = sc.baseMapKey;
  if (!key || !s.baseMaps[key]) return JSON.stringify({ fails: ['没有可用的底图（前序子测试未还原）'] });

  // 给底图一点内容，让 fitToView 有包围盒可算
  if (!((s.baseMaps[key].terrain) || []).length) {
    s.addBaseProvince(key, {
      id: 'case53_p1', name: '用例53省', biome: 'temperate', coast: false,
      points: [{x:0,y:0},{x:400,y:0},{x:400,y:300},{x:0,y:300}],
    });
  }
  sc.fitToView();
  ok('fitToView 的相机缩放为正', sc.cameraScale > 0, sc.cameraScale);
  sc.render();
  ok('正常渲染不触发护栏', sc.renderPaused === false && !sc.renderError, sc.renderPaused + '/' + sc.renderError);

  // 🔴 px() 的核心作用：相机缩放异常（曾经是负值）时长度被夹正 → 不再有负半径/负线宽。
  //    旧实现此处必然抛 IndexSizeError（ctx.arc radius 为负）→ 渲染路径异常 → 整页交互拖死。
  const good = sc.cameraScale;
  sc.cameraScale = -1;
  sc.render();
  ok('负相机缩放不再崩渲染（px 夹正）', sc.renderPaused === false && !sc.renderError,
     sc.renderPaused + '/' + sc.renderError);
  sc.cameraScale = good;
  ok('相机缩放已还原', sc.cameraScale > 0, sc.cameraScale);

  // 注入一个「读取坐标即抛错」的城镇 → 让 renderFrame 真的抛（护栏必须吞掉并计数，不能冒泡）
  const bm = s.baseMaps[key];
  const bad = { capital: 0, get x() { throw new Error('护栏测试异常'); }, get y() { return 0; } };
  s.baseMaps = { ...s.baseMaps, [key]: { ...bm, burgs: [bad] } };
  sc.render();                      // 1
  ok('首帧异常被捕获（未冒泡）', true);
  ok('首帧后记录错误信息', String(sc.renderError).includes('护栏测试异常'), sc.renderError);
  ok('首帧未立刻暂停（允许瞬时抖动）', sc.renderPaused === false, sc.renderPaused);
  sc.render(); sc.render();          // 2 / 3 → 触发暂停
  ok('连续 3 帧后暂停渲染', sc.renderPaused === true, sc.renderPaused);
  sc.render();                       // 暂停后直接返回，不再刷屏
  ok('暂停期间渲染短路', sc.renderPaused === true);

  // 收场：移除坏数据 + 恢复渲染
  s.baseMaps = { ...s.baseMaps, [key]: { ...bm, burgs: [] } };
  sc.resumeRender();
  ok('恢复渲染后状态清零', sc.renderPaused === false && !sc.renderError, sc.renderPaused + '/' + sc.renderError);
  return JSON.stringify({ fails, cameraScale: sc.cameraScale });
})()"""


def _j(cdp, expr, desc=''):
    ok, obj = eval_json(cdp, expr, required=('fails',), desc=desc)
    return (obj, '') if ok else (None, obj)


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    ensure_data_ready(cdp)
    cdp.send('Emulation.setDeviceMetricsOverride',
             {'width': 1600, 'height': 900, 'deviceScaleFactor': 1, 'mobile': False})
    # headless 下 document 默认为「未聚焦」→ `:focus` 样式不生效（computed outline 读不到）。
    # 打开焦点模拟，才能验证「聚焦有可见描边」这一条（用例结束再关掉）。
    cdp.send('Emulation.setFocusEmulationEnabled', {'enabled': True})
    time.sleep(0.3)

    # ── a) 项目面板：输入框自动聚焦 / 占位文字 / 可见描边 / 能输入 ─────────────
    if _click_toolbar(cdp, '项目') != 'ok':
        return False, '未找到工具栏「项目」按钮'
    try:
        wait_for(cdp, "!!document.querySelector('.project-panel .pp-input')", timeout=20, desc='项目面板挂载')
    except Exception as e:
        return False, f'项目面板未挂载：{e}'
    time.sleep(0.5)

    obj, err = _j(cdp, JS_PANEL, desc='面板输入框')
    if obj is None:
        return False, f'面板检查求值失败：{err}'
    if obj['fails']:
        return False, '面板输入框失败：' + '；'.join(obj['fails'])
    panel_note = '面板打开即自动聚焦、占位文字无硬编码、聚焦描边可见'

    # 行内间隙（输入框与「新建」之间的空档）点击也要聚焦
    cdp.eval("document.activeElement && document.activeElement.blur()")
    time.sleep(0.15)
    _real_click(cdp, obj['gapX'], obj['gapY'])
    time.sleep(0.25)
    if cdp.eval("document.activeElement === document.querySelector('.project-panel .pp-input')") is not True:
        return False, '点击「项目名称」行空档后输入框未聚焦（命中区没生效）'

    # 真实输入 → 「新建」按钮解锁
    typed = _type(cdp, '用例53空项目')
    if typed != '用例53空项目':
        return False, f'输入框写不进内容（得到 {typed!r}）'
    disabled = cdp.eval("document.querySelector('.project-panel .pp-btn.primary').disabled")
    if disabled is not False:
        return False, '输入名称后「新建」按钮仍disabled'

    # ── b) Git 快照按钮 ────────────────────────────────────────────────
    obj, err = _j(cdp, JS_GIT_BTN, desc='Git 快照按钮')
    if obj is None:
        return False, f'Git 快照检查求值失败：{err}'
    if obj['fails']:
        return False, 'Git 快照按钮失败：' + '；'.join(obj['fails'])
    try:
        wait_for(cdp, "!!document.querySelector('.project-panel .pp-tip')", timeout=8, desc='Git 快照回执')
    except Exception:
        pass
    tip = cdp.eval("(document.querySelector('.project-panel .pp-tip') || {}).textContent || ''")
    if not (isinstance(tip, str) and 'git' in tip.lower() and 'init' in tip.lower()):
        return False, f'Git 快照回执未说明去处（司天不自动 git init）：{tip!r}'

    # ── c) 用 UI 新建空项目（真实流程：输入名称 → 点「新建」）──────────────────
    cdp.eval("document.querySelector('.project-panel .pp-btn.primary').click()")
    wait_for(cdp, """(async () => {
      const app = document.querySelector('#app').__vue_app__;
      const { useProjectStore } = await import('/src/store/projectStore.js');
      const p = useProjectStore(app.config.globalProperties.$pinia);
      return p.isOpen === true && p.entityCount === 0;
    })()""", timeout=20, desc='空项目已打开')
    nodes = cdp.eval("%s.nodes.length" % STORE)
    if nodes != 0:
        return False, f'新建的空项目画布不是空的（nodes={nodes}）'

    # ── d) 世界选择空态布局（宽 / 窄窗口各一次）────────────────────────────
    cdp.eval("(() => { const s = %s; if (s.viewLevel !== 'world' && s.backToWorld) s.backToWorld(); return s.viewLevel; })()" % STORE)
    time.sleep(0.5)
    layout = []
    for w, h, label in ((1600, 900, '1600×900'), (900, 620, '900×620')):
        cdp.send('Emulation.setDeviceMetricsOverride',
                 {'width': w, 'height': h, 'deviceScaleFactor': 1, 'mobile': False})
        time.sleep(0.4)
        obj, err = _j(cdp, JS_EMPTY_STATE, desc=f'空态布局 {label}')
        if obj is None:
            return False, f'空态布局 {label} 求值失败：{err}'
        if obj['fails']:
            return False, f'空态布局 {label} 失败：' + '；'.join(obj['fails'])
        layout.append(f"{label} 卡片 {obj['card'][0]}..{obj['card'][1]} / 按钮行 {obj['actions'][0]}..{obj['actions'][1]}")
    cdp.send('Emulation.setDeviceMetricsOverride',
             {'width': 1600, 'height': 900, 'deviceScaleFactor': 1, 'mobile': False})
    time.sleep(0.3)

    # ── e) 剧本模式：空项目不注入假底图 + 落笔懒建 ────────────────────────────
    if cdp.eval("""(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent || '').includes('历史剧本'));
      if (!b) return 'no-btn';
      b.click();
      return 'ok';
    })()""") != 'ok':
        return False, '未找到「历史剧本」入口'
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=20, desc='ScenarioMap 挂载')
    time.sleep(1.0)
    obj, err = _j(cdp, JS_SCENARIO_EMPTY.replace('PLACEHOLDER_STORE', STORE).replace('PLACEHOLDER_SC', SC),
                  desc='空项目底图')
    if obj is None:
        return False, f'空项目底图求值失败：{err}'
    if obj['fails']:
        return False, '空项目底图失败：' + '；'.join(obj['fails'])
    base_note = f"空项目无底图、落笔懒建 {obj['keys'][0]}（不借用真实剧本名）"

    # ── f) 渲染护栏（静态 + 行为）────────────────────────────────────────
    cdp.eval("""(async () => {
      const r = await fetch('/src/components/ScenarioMap.vue?raw');
      window.__SCENARIO_SRC__ = await r.text();
      return true;
    })()""")
    obj, err = _j(cdp, JS_SRC, desc='px/护栏静态检查')
    if obj is None:
        return False, f'静态检查求值失败：{err}'
    if obj['fails']:
        return False, '静态检查失败：' + '；'.join(obj['fails'])
    src_note = f"px() {obj['pxUses']} 处、裸除法 {obj['rawDiv']} 处"

    # 窄高窗口（历史上 fitToView 在此算出负 scale）
    cdp.send('Emulation.setDeviceMetricsOverride',
             {'width': 420, 'height': 320, 'deviceScaleFactor': 1, 'mobile': False})
    time.sleep(0.4)
    obj, err = _j(cdp, JS_GUARD.replace('PLACEHOLDER_STORE', STORE).replace('PLACEHOLDER_SC', SC), desc='渲染护栏')
    if obj is None:
        return False, f'渲染护栏求值失败：{err}'
    if obj['fails']:
        return False, '渲染护栏失败：' + '；'.join(obj['fails'])
    cdp.send('Emulation.setDeviceMetricsOverride',
             {'width': 1600, 'height': 900, 'deviceScaleFactor': 1, 'mobile': False})

    # 收场：退出剧本模式 + 关掉焦点模拟（避免影响后续用例）
    cdp.eval("(() => { const s = %s; s.scenarioMode = false; return 'ok'; })()" % STORE)
    cdp.send('Emulation.setFocusEmulationEnabled', {'enabled': False})

    return True, (f'面板输入框可用（{panel_note}）、Git 快照按钮带去处说明；空项目无假底图（{base_note}）；'
                  f'世界选择空态按钮不溢出（{layout[0]}；{layout[1]}）；'
                  f'渲染护栏：{src_note}，窄高窗口 cameraScale={obj["cameraScale"]} 为正、'
                  f'注入异常被捕获→连续 3 帧暂停→可恢复')
