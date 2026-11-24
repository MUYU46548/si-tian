#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时探针：删除项目的二次确认**是否真的看得见**（不是只在 DOM 里）

用户原话（2026-11-24）：“删除项目是否有二次确认？这种常识的东西不会也没做吧？”

有确认条 ≠ 用户看得到。`test_182` 只断言 `[data-testid=pp-delete-confirm]` 在 DOM 里 ——
如果它被挤在面板可滚动区的下面、或者盖在别的元素后面、或者宽度为 0，DOM 断言照样绿，
而用户点完「删除」会以为"没反应"，然后又点一次原来的位置。这条探针就是量这个。
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

    return True, (f"确认条真的看得见：rect={got['rect']} 在视口内、未被滚动区裁掉、"
                  f"中心点命中它自己（{got.get('centerTopEl')}）、不透明；"
                  f"面板 rect={got.get('panelRect')}")
