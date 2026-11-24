#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 184：删除项目的二次确认**是否真的看得见**（不是只在 DOM 里）

用户原话（2026-11-24）：“删除项目是否有二次确认？这种常识的东西不会也没做吧？”

有确认条 ≠ 用户看得到。`test_182` 只断言 `[data-testid=pp-delete-confirm]` 在 DOM 里 ——
如果它被挤在面板可滚动区的下面、或者盖在别的元素后面、或者宽度为 0，DOM 断言照样绿，
而用户点完「删除」会以为"没反应"，然后又点一次原来的位置。这条探针就是量这个。

实测结论（2026-11-24，用户问完"不会没做吧"之后）：
  · 二次确认**一直是有的**（按钮 → 确认条 → 才删），但最初它排在**整张列表末尾**，
    列表一长就被面板下沿切掉（实测 rect=675..801，面板底边只有 750）——
    用户点完「删除」看到的是半截/什么都看不到，读起来就是"点了没反应"。
  · 修法两层：① 确认条挪到**被点那一行紧下方**；② 打开时**主动 scrollIntoView**。
  · 本用例的判据从"在 DOM 里"升级为"**完全落在面板可视区内**"，并在多项目、
    点最后一行的最坏位置下量 —— 旧的"只看 DOM 存在"的断言在这两种状态下都是绿的。
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from lib.cdp import wait_for  # noqa: E402


def _j(v):
    if isinstance(v, str) and v[:1] in '{[':
        try:
            return json.loads(v)
        except Exception:
            return {}
    return v if isinstance(v, dict) else {}


PROBE = r"""(() => {
  const box = document.querySelector('[data-testid=pp-delete-confirm]');
  if (!box) return JSON.stringify({ exists: false });
  const r = box.getBoundingClientRect();
  const panel = document.querySelector('.project-panel');
  const pr = panel ? panel.getBoundingClientRect() : null;
  // 面板里真正的可滚动容器
  const scroller = box.closest('.pp-body') || panel;
  const sr = scroller ? scroller.getBoundingClientRect() : null;

  const vw = window.innerWidth, vh = window.innerHeight;
  const inViewport = r.width > 0 && r.height > 0 &&
    r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0;
  // 是否被**滚动区**裁掉（用户要滚才看得到 = 也算"看不见"，因为他不会去滚）
  const clippedByScroller = sr ? (r.bottom > sr.bottom + 1 || r.top < sr.top - 1) : false;
  // 中心点上是不是它自己（被别的元素盖住就说明看不见）
  const cx = Math.min(vw - 2, Math.max(2, r.left + r.width / 2));
  const cy = Math.min(vh - 2, Math.max(2, r.top + r.height / 2));
  const topEl = document.elementFromPoint(cx, cy);
  const centerHits = !!(topEl && (box === topEl || box.contains(topEl)));

  const cs = getComputedStyle(box);
  return JSON.stringify({
    exists: true,
    rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) },
    panelRect: pr ? { top: Math.round(pr.top), bottom: Math.round(pr.bottom), w: Math.round(pr.width) } : null,
    scrollerRect: sr ? { top: Math.round(sr.top), bottom: Math.round(sr.bottom) } : null,
    viewport: { w: vw, h: vh },
    inViewport: inViewport,
    clippedByScroller: clippedByScroller,
    centerHits: centerHits,
    centerTopEl: topEl ? (topEl.className || topEl.tagName) : null,
    opacity: cs.opacity, visibility: cs.visibility, display: cs.display,
    zIndex: cs.zIndex,
  });
})()"""


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    # 打开项目面板
    cdp.eval("""(() => {
      if (document.querySelector('.project-panel')) return 'already';
      const b = Array.from(document.querySelectorAll('button'))
        .find(x => (x.title || '').includes('项目') || (x.textContent || '').includes('项目'));
      if (b) b.click();
      return 'clicked';
    })()""")
    time.sleep(1.0)
    if not cdp.eval("!!document.querySelector('.project-panel')"):
        return False, '打不开项目面板'

    # 滚到项目列表顶部（模拟用户的默认位置）
    cdp.eval("""(() => {
      const s = document.querySelector('.project-panel .pp-body');
      if (s) s.scrollTop = 0;
      return 'ok';
    })()""")
    time.sleep(0.3)

    # 🔴 造 6 个项目（用户的文档目录里就是 6 个）。只有多项目时，
    #    "确认条排在整张列表末尾"这件事才会真的把它推出面板可视区。
    cdp.eval('''(() => {
      const seed = () => {
        window.__projects = window.__projects || {};
        const base = Object.values(window.__projects)[0] || null;
        for (let i = 1; i <= 6; i++) {
          const fp = 'mock/projects/探针项目' + i + '.sitian';
          if (!window.__projects[fp]) {
            window.__projects[fp] = base
              ? JSON.parse(JSON.stringify(base))
              : { version: '1.0.0', meta: { name: '探针项目' + i }, entities: {}, hyperlanes: [], scenarios: {}, maps: {}, snapshots: [] };
            window.__projects[fp].meta = Object.assign({}, window.__projects[fp].meta, { name: '探针项目' + i });
          }
        }
        return Object.keys(window.__projects).length;
      };
      const n = seed();
      // 刷新列表（走产品自己的刷新按钮）
      const b = Array.from(document.querySelectorAll('.project-panel button')).find(x => (x.title || '').includes('刷新'));
      if (b) b.click();
      return n;
    })()''')
    time.sleep(1.2)

    # 点**最后一条**的「删除」（最靠下 = 确认条最容易被推出可视区）
    last_del = cdp.eval('''(() => {
      const rows = Array.from(document.querySelectorAll('.project-panel .pp-item'));
      if (!rows.length) return 'no-rows';
      const last = rows[rows.length - 1];
      const b = last.querySelector('.pp-item-del');
      if (!b) return 'no-btn';
      b.click();
      return 'ok:' + rows.length;
    })()''')
    if not str(last_del).startswith('ok'):
        return False, f'点不到最后一条的删除（{last_del}）'
    time.sleep(0.8)

    # 点第一条的「删除」
    clicked = cdp.eval("""(() => {
      const b = document.querySelector('.project-panel .pp-item-del');
      if (!b) return 'no-btn';
      b.click();
      return 'ok';
    })()""")
    if clicked != 'ok':
        return False, f'点不到删除按钮（{clicked}）'
    time.sleep(0.6)

    # 先看 DOM 结构：确认条是不是**紧跟在被点的那一行之后**
    struct = cdp.eval('''(() => {
      const box = document.querySelector('[data-testid=pp-delete-confirm]');
      if (!box) return JSON.stringify({ exists: false });
      const prev = box.previousElementSibling;
      const kids = box.parentElement ? Array.from(box.parentElement.children).map(x => x.className || x.tagName) : [];
      return JSON.stringify({
        exists: true,
        prevEl: prev ? (prev.className || prev.tagName) : null,
        parentTag: box.parentElement ? box.parentElement.className || box.parentElement.tagName : null,
        siblingIndex: kids.indexOf('pp-confirm pp-confirm-project'),
        siblingCount: kids.length,
        siblings: kids.slice(0, 12),
      });
    })()''')
    print('   [DOM 结构] ' + str(struct)[:400])

    got = _j(cdp.eval(PROBE))
    if not got.get('exists'):
        return False, '确认条根本没出现'

    problems = []
    if not got.get('inViewport'):
        problems.append(f"不在视口内（rect={got.get('rect')}, viewport={got.get('viewport')}）")
    if got.get('clippedByScroller'):
        problems.append(f"被滚动区裁掉（rect={got.get('rect')}, scroller={got.get('scrollerRect')}）")
    if not got.get('centerHits'):
        problems.append(f"中心点被别的元素盖住（命中的是 {got.get('centerTopEl')}）")
    if got.get('display') == 'none' or got.get('visibility') == 'hidden' or float(got.get('opacity') or 1) < 0.9:
        problems.append(f"不可见：display={got.get('display')} visibility={got.get('visibility')} opacity={got.get('opacity')}")
    if (got.get('rect') or {}).get('h', 0) < 40:
        problems.append(f"高度太小（{(got.get('rect') or {}).get('h')}px），像被压扁")

    if problems:
        return False, '确认条**存在但用户看不见**：' + '；'.join(problems) + f'｜原始读数={got}'

    # 🔴 硬判据（2026-11-24，用户质问"二次确认有没有"之后补的）：
    #    确认条必须**完全落在面板可视区内**，而不是"被夹进视口就算过"。
    #    改之前实测：rect.bottom=801，面板底边只有 750 —— 用户看到的是被下沿切掉半截的确认条，
    #    读起来就是"点了没反应"。这条判据会把那种状态判成红。
    pr = got.get('panelRect') or {}
    band = []
    rr = got.get('rect') or {}
    if pr:
        if rr.get('bottom', 0) > pr.get('bottom', 0) + 1:
            band.append(f"底边 {rr.get('bottom')} 超出面板底边 {pr.get('bottom')}")
        if rr.get('top', 0) < pr.get('top', 0) - 1:
            band.append(f"顶边 {rr.get('top')} 高出面板顶边 {pr.get('top')}")
    if band:
        return False, ('确认条**被面板裁掉**（用户只能看到半截或完全看不到）：' + '；'.join(band)
                       + f'｜确认条={rr}｜面板={pr}')

    return True, (f"确认条真的看得见：rect={got['rect']} 完全落在面板可视区内"
                  f"（面板 {got.get('panelRect')}）、中心点命中它自己"
                  f"（{got.get('centerTopEl')}）、不透明")
