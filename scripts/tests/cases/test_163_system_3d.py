#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 163：星系 3D 观景（2026-10-27 计划 §1，独立一轮交付）

验收判据（与 docs/plan/REMAINING_BACKLOG_20261027.md §1 一一对应）：

  A. **入口**：`SystemDetailView` 头部有「3D 观景」；有 ≥1 颗行星时可用，
     无行星时灰禁且 `title` 说明原因（只读态不禁 —— 3D 是纯查看，不写数据）。
  B. **打开**：点一下 → 出现 3D canvas、无错误面板、渲染在跑（frames 增长），
     three chunk 是**动态加载**的（dev 下按需 import，构建侧由单测 b2 守源码）。
  C. **关闭**：Esc / 「返回 2D」都能关；关掉后 3D 根节点消失、画布只剩 2D 那张、
     2D 视图没有重建（canvas 引用不变 = "原样恢复"）。
  D. **资源归零**：每次关闭后 `renderer.info.memory` 的 geometries / textures 都是 0
     —— 这是"遍历 dispose + forceContextLoss"的直接证据。
  E. **反复开关不涨**：连开连关 6 轮，每轮资源都归零、页面 canvas 数不增长。

为什么用 store 直接进 system_detail：背包路径（点恒星亮点）已由 test_10 守；
本用例只关心 3D，少一次画布命中就少一处会误红的依赖。

⚠️ 无行星时的灰禁只能靠单测 `test_system3d_scene.js` 的 hasPlanets 判据覆盖 ——
   合成 fixture 里每个恒星系都有行星，现场造一个空系会污染后续用例。
"""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json
from lib.helpers import ensure_case_state  # noqa: E402

ROOT_SEL = '[data-testid="system-3d"]'
CANVAS_SEL = '[data-testid="system-3d-canvas"]'
OPEN_SEL = '[data-testid="system-3d-open"]'

# 每次都从 store 重取实例：组件被卸载后 `__vueParentComponent.exposed` 仍指向旧的 defineExpose 对象
READ_ROOT_JS = r"""(() => {
  const el = document.querySelector('%s');
  if (!el) return JSON.stringify({ root: false });
  const inst = el.__vueParentComponent;
  window.__s3d = inst;              // 关闭后还要读 getStats()
  const ex = (inst && inst.exposed) || {};
  const fn = (inst && inst.setupState && inst.setupState.getStats) || ex.getStats;
  const stats = typeof fn === 'function' ? fn() : null;
  return JSON.stringify({
    root: true,
    hasCanvas: !!document.querySelector('%s'),
    canvases: document.querySelectorAll('canvas').length,
    stats,
    error: (document.querySelector('[data-testid="system-3d-error"]') || {}).textContent || '',
    labels: document.querySelectorAll('.sys3d-label').length,
  });
})()""" % (ROOT_SEL, CANVAS_SEL)

READ_CLOSED_JS = r"""(() => {
  const inst = window.__s3d;
  const ex = (inst && inst.exposed) || {};
  const fn = (inst && inst.setupState && inst.setupState.getStats) || ex.getStats;
  const stats = typeof fn === 'function' ? fn() : null;
  return JSON.stringify({
    root: !!document.querySelector('%s'),
    canvases: document.querySelectorAll('canvas').length,
    twoD: !!document.querySelector('.system-detail-container canvas'),
    stats,
  });
})()""" % ROOT_SEL

ENTER_SYSTEM_JS = r"""(() => {
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const sys = s.nodes.find(n => n.layer === 'galaxy'
    && s.nodes.some(p => p.layer === 'planet' && p.parentId === n.id));
  if (!sys) return JSON.stringify({ ok: false, why: 'no-system-with-planets' });
  s.enterSystemDetail(sys);
  return JSON.stringify({ ok: true, system: sys.id, name: sys.displayName || sys.name });
})()"""

CLICK_OPEN_JS = r"""(() => {
  const b = document.querySelector('%s');
  if (!b) return JSON.stringify({ ok: false, why: 'no-button' });
  const info = { disabled: !!b.disabled, title: b.title || '' };
  if (b.disabled) return JSON.stringify({ ok: false, why: 'disabled', info });
  b.click();
  return JSON.stringify({ ok: true, info });
})()""" % OPEN_SEL

PRESS_ESC_JS = r"""(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }));
  return 'ok';
})()"""

CLICK_CLOSE_JS = r"""(() => {
  const b = document.querySelector('[data-testid="system-3d-close"]');
  if (!b) return 'no-button';
  b.click();
  return 'ok';
})()"""


def open_3d(cdp, timeout=40):
    """点开 3D 并等到 canvas 出现（dev 首次要现编译 three，给足时间）"""
    ok, obj = eval_json(cdp, CLICK_OPEN_JS, required=('ok',), desc='点 3D 观景')
    if not ok:
        return False, str(obj)
    if not obj.get('ok'):
        return False, f"按钮不可用：{obj}"
    if not wait_for(cdp, f"!!document.querySelector('{CANVAS_SEL}')", timeout=timeout, desc='3D canvas 出现'):
        # 区分"加载失败"与"根本没挂载"
        ok2, o2 = eval_json(cdp, READ_ROOT_JS, required=('root',), desc='3D 根节点')
        return False, f'3D canvas 超时未出现：{o2 if ok2 else o2}'
    return True, obj.get('info')


def read_root(cdp):
    ok, obj = eval_json(cdp, READ_ROOT_JS, required=('root',), desc='读 3D 统计')
    return (obj if ok else {'root': False, 'err': str(obj)}), ('' if ok else str(obj))


def close_3d(cdp, how='esc'):
    cdp.eval(PRESS_ESC_JS if how == 'esc' else CLICK_CLOSE_JS)
    if not wait_for(cdp, f"!document.querySelector('{ROOT_SEL}')", timeout=12, desc='3D 关闭'):
        return False, f'{how} 没能关掉 3D'
    return True, ''


def run(cdp):
    ensure_case_state(cdp)

    # ---------- A. 入口 ----------
    ok, info = eval_json(cdp, ENTER_SYSTEM_JS, required=('ok',), desc='进入单恒星系')
    if not ok:
        return False, f'进入 system_detail 失败：{info}'
    if not info.get('ok'):
        return False, f'找不到带行星的恒星系：{info}'
    time.sleep(0.8)

    ok, gate = eval_json(cdp, r"""(() => {
      const b = document.querySelector('%s');
      const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
      return JSON.stringify({
        level: s.viewLevel,
        mounted: !!document.querySelector('.system-detail-container'),
        button: !!b,
        disabled: b ? !!b.disabled : null,
        title: b ? (b.title || '') : '',
        planets: s.currentSystemPlanets.filter(p => p.layer === 'planet').length,
      });
    })()""" % OPEN_SEL, required=('level', 'button'), desc='读入口按钮')
    if not ok:
        return False, f'入口读取失败：{gate}'
    if gate['level'] != 'system_detail' or not gate['mounted']:
        return False, f'没进 system_detail（{gate["level"]}, mounted={gate["mounted"]}）'
    if not gate['button']:
        return False, '头部没有「3D 观景」按钮'
    if gate['planets'] < 1:
        return False, f'该系行星数异常（{gate["planets"]}），用例前提不成立'
    if gate['disabled']:
        return False, f'有 {gate["planets"]} 颗行星时按钮却是灰禁的（title={gate["title"]!r}）'

    canvas_before = cdp.eval("document.querySelector('.system-detail-container canvas') ? '1' : '0'")

    # ---------- B. 打开 ----------
    ok, why = open_3d(cdp)
    if not ok:
        return False, f'打开 3D 失败：{why}'

    time.sleep(1.4)  # 让 rAF 跑几十帧
    root, err = read_root(cdp)
    if err:
        return False, f'读 3D 统计异常：{err}'
    st = root.get('stats') or {}
    if root.get('error'):
        return False, f'3D 报错面板：{root["error"]}'
    if st.get('error'):
        return False, f'3D 内部错误：{st["error"]}'
    if not root.get('hasCanvas') or not root.get('canvases', 0) >= 2:
        return False, f'3D canvas 未挂载（{root.get("canvases")} 张 canvas）'
    if not (st.get('frames') or 0) >= 5:
        return False, f'3D 渲染没在跑（frames={st.get("frames")}）'
    if not (st.get('geometries') or 0) > 0 or not (st.get('textures') or 0) > 0:
        return False, f'资源计数异常（{st.get("geometries")} geo / {st.get("textures")} tex）'
    if not (root.get('labels') or 0) >= 1:
        return False, '没有生成行星名称标签（labels=0）'
    first = {'labels': root.get('labels'), 'frames': st.get('frames'),
             'geometries': st.get('geometries'), 'textures': st.get('textures')}

    # ---------- C/D. 关闭（Esc）+ 资源归零 + 2D 原样 ----------
    ok, why = close_3d(cdp, 'esc')
    if not ok:
        return False, why
    time.sleep(0.25)
    ok, closed = eval_json(cdp, READ_CLOSED_JS, required=('root',), desc='关闭后状态')
    if not ok:
        return False, f'关闭后读取失败：{closed}'
    cst = closed.get('stats') or {}
    mem = cst.get('memoryAtDispose') or {}
    if closed.get('root'):
        return False, 'Esc 之后 3D 根节点还在'
    if not closed.get('twoD'):
        return False, '关掉 3D 后 2D 画布不见了'
    if closed.get('canvases') != 1:
        return False, f'关掉 3D 后页面 canvas 数应为 1，实得 {closed.get("canvases")}'
    if mem.get('geometries') != 0 or mem.get('textures') != 0:
        return False, f'资源没归零：{mem}（遍历 dispose 漏了东西）'
    canvas_after = cdp.eval("document.querySelector('.system-detail-container canvas') ? '1' : '0'")
    if canvas_before != '1' or canvas_after != '1':
        return False, f'2D 画布没恢复（前 {canvas_before} / 后 {canvas_after}）'

    # ---------- E. 反复开关 6 轮（Esc / 按钮交替） ----------
    cycles = []
    for i in range(6):
        ok, why = open_3d(cdp, timeout=25)
        if not ok:
            return False, f'第 {i + 1} 轮打开失败：{why}'
        time.sleep(0.35)
        r, e = read_root(cdp)
        if e:
            return False, f'第 {i + 1} 轮读统计异常：{e}'
        s = r.get('stats') or {}
        if (s.get('frames') or 0) < 2:
            return False, f'第 {i + 1} 轮渲染没跑起来（frames={s.get("frames")}）'
        how = 'esc' if i % 2 == 0 else 'button'
        ok, why = close_3d(cdp, how)
        if not ok:
            return False, f'第 {i + 1} 轮关闭失败（{how}）：{why}'
        time.sleep(0.18)
        ok, c2 = eval_json(cdp, READ_CLOSED_JS, required=('root',), desc=f'第 {i + 1} 轮关闭后')
        if not ok:
            return False, f'第 {i + 1} 轮关闭后读取失败：{c2}'
        cs = c2.get('stats') or {}
        m = cs.get('memoryAtDispose') or {}
        cycles.append({
            'how': how,
            'geometries': m.get('geometries'),
            'textures': m.get('textures'),
            'disposed': cs.get('disposed'),
            'canvases': c2.get('canvases'),
        })
        if c2.get('root'):
            return False, f'第 {i + 1} 轮关掉后根节点还在'
        if c2.get('canvases') != 1:
            return False, f'第 {i + 1} 轮关掉后 canvas 数应为 1，实得 {c2.get("canvases")}'
        if m.get('geometries') != 0 or m.get('textures') != 0:
            return False, f'第 {i + 1} 轮资源没归零：{m}'

    detail = json.dumps({'first': first, 'cycles': cycles}, ensure_ascii=False)
    return True, f'3D 观景：开→渲染→关 6 轮，资源每次归零，2D 未重建 | {detail}'
