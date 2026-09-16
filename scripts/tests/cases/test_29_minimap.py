#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 29：小地图 / 缩略图导航（P0-4）

验收点（对应提示词 P0-4 的「验收标准」逐条）：
1. 小地图缩略清晰可辨主要元素 —— 画布上确实画出了除背景色之外的内容
2. 视口遮罩显示正确 —— 放大后遮罩是图内一块真子集（不是铺满全图）
3. 拖动遮罩画布跟随 —— 遮罩右移 30px，镜头中心按 30/缩略scale 世界单位右移
4. 点击非遮罩区域定位准确 —— 点击后镜头中心 == 该点换算出的世界坐标
5. 折叠/展开正常 —— 关闭后只剩展开按钮，再点恢复
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for  # noqa: E402
from lib.helpers import goto_planet, enter_edit, ensure_data_ready  # noqa: E402

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


GEOM = f"""(() => {{
  const pm = {PM};
  const body = document.querySelector('.minimap-body');
  const mask = document.querySelector('.minimap-mask');
  if (!body) return null;
  const S = body.clientWidth;
  const PADDING = 6;
  const wb = pm.worldBounds;
  const inner = Math.max(20, S - PADDING * 2);
  const s = Math.min(inner / (wb.maxX - wb.minX || 1000), inner / (wb.maxY - wb.minY || 1000));
  return {{
    S, PADDING, s, wb,
    toWorld: (sx, sy) => ({{ x: (sx - PADDING) / s + wb.minX, y: (sy - PADDING) / s + wb.minY }}),
    mask: mask ? {{
      x: Number(mask.dataset.x), y: Number(mask.dataset.y),
      w: Number(mask.dataset.w), h: Number(mask.dataset.h),
    }} : null,
  }};
}})()"""


def _view_center(cdp):
    return _j(cdp, f"""(() => {{
      const vt = {PM}.renderer.viewTransform;
      return JSON.stringify({{ x: -vt.x / vt.scale, y: -vt.y / vt.scale, scale: vt.scale }});
    }})()""")


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

    # 小地图默认展开（localStorage 未被写成 '0'）
    cdp.eval("try { localStorage.setItem('sitian-eagle-eye', '1'); } catch (e) {}")
    if _j(cdp, """(() => {
      const b = document.querySelector('.eagle-eye-toggle');
      if (b) b.click();
      return 'ok';
    })()""") != 'ok':
        return False, '小地图展开按钮不可用'
    time.sleep(0.5)
    if _j(cdp, "(() => document.querySelectorAll('.eagle-eye').length)()") != 1:
        return False, '小地图未渲染（.eagle-eye 不存在）'

    # 放大 4 倍 → 视口明显小于内容，遮罩才可能是真子集
    _j(cdp, f"(() => {{ {PM}.zoomFit(); {PM}.renderer.setScale({PM}.renderer.viewTransform.scale * 4); return 'ok'; }})()")
    time.sleep(0.6)

    g = _j(cdp, f"JSON.stringify({GEOM})")
    if not isinstance(g, dict) or not g.get('mask'):
        return False, f'取不到小地图遮罩（视口边界未接入？）{g}'
    mask = g['mask']
    S = g['S']

    # 1. 缩略图确实画了东西（采样唯一颜色数 > 背景单色）
    colors = _j(cdp, """(() => {
      const c = document.querySelector('.minimap-body canvas');
      if (!c) return 0;
      const ctx = c.getContext('2d');
      const set = new Set();
      for (let i = 0; i < 900; i++) {
        const x = Math.floor((i * 13) % c.width);
        const y = Math.floor((i * 29) % c.height);
        const d = ctx.getImageData(x, y, 1, 1).data;
        if (d[3] > 0) set.add((d[0] << 16) | (d[1] << 8) | d[2]);
      }
      return set.size;
    })()""")
    if not isinstance(colors, int) or colors < 3:
        return False, f'小地图缩略图几乎是纯色（唯一颜色 {colors} 种）—— 元素未绘制'

    # 2. 遮罩是真子集
    if mask['w'] >= S * 0.98 and mask['h'] >= S * 0.98:
        return False, f'放大后遮罩仍铺满全图（{mask} vs {S}）—— 视口/内容边界混淆'
    if mask['w'] <= 0 or mask['h'] <= 0:
        return False, f'遮罩尺寸非法 {mask}'

    # 3. 拖动遮罩 → 镜头跟随（右移 30px 应带来 30/s 世界单位右移）
    c0 = _view_center(cdp)
    mx = mask['x'] + mask['w'] / 2
    my = mask['y'] + mask['h'] / 2
    drag = _j(cdp, f"""(() => {{
      const mask = document.querySelector('.minimap-mask');
      const c = document.querySelector('.minimap-body canvas');
      if (!mask || !c) return JSON.stringify({{ err: 'no-mask' }});
      const r = c.getBoundingClientRect();
      const mk = (t, dx) => new MouseEvent(t, {{
        clientX: r.left + {mx} + dx, clientY: r.top + {my}, bubbles: true, cancelable: true, button: 0,
      }});
      mask.dispatchEvent(mk('mousedown', 0));
      window.dispatchEvent(mk('mousemove', 30));
      window.dispatchEvent(mk('mouseup', 30));
      return JSON.stringify({{ ok: true }});
    }})()""")
    if not isinstance(drag, dict) or not drag.get('ok'):
        return False, f'遮罩拖动事件派发失败 {drag}'
    time.sleep(0.6)
    c1 = _view_center(cdp)
    want_dx = 30.0 / g['s']
    got_dx = c1['x'] - c0['x']
    if abs(got_dx - want_dx) > max(20.0, abs(want_dx) * 0.35):
        return False, (f'拖动遮罩后镜头未按预期右移：期望 Δx≈{want_dx:.0f}，实际 {got_dx:.0f}'
                       f'（遮罩拖动未平移画布？）')
    g2 = _j(cdp, f"JSON.stringify({GEOM})")
    if abs(g2['mask']['x'] - mask['x']) < 2:
        return False, f'拖动后遮罩自身没动（{mask["x"]} → {g2["mask"]["x"]}）'

    # 4. 点击非遮罩区域 → 定位准确
    g3 = _j(cdp, f"JSON.stringify({GEOM})")
    m3 = g3['mask']
    cands = [(3, 3), (S - 4, 3), (3, S - 4), (S - 4, S - 4), (S // 2, 3), (S // 2, S - 4)]
    outside = None
    for cx, cy in cands:
        if not (m3['x'] <= cx <= m3['x'] + m3['w'] and m3['y'] <= cy <= m3['y'] + m3['h']):
            outside = (cx, cy)
            break
    if outside is None:
        return False, f'找不到遮罩外的点（遮罩 {m3} 覆盖了整个小地图）'

    expected = _j(cdp, f"""(() => {{
      const geom = {GEOM};
      const w = geom.toWorld({outside[0]}, {outside[1]});
      return JSON.stringify(w);
    }})()""")
    click_ret = cdp.eval(f"""(() => {{
      const c = document.querySelector('.minimap-body canvas');
      if (!c) return 'no-canvas';
      const r = c.getBoundingClientRect();
      c.dispatchEvent(new MouseEvent('click', {{
        clientX: r.left + {outside[0]}, clientY: r.top + {outside[1]}, bubbles: true, cancelable: true, button: 0,
      }}));
      return 'ok';
    }})()""")
    if click_ret != 'ok':
        return False, f'小地图点击派发失败 {click_ret}'
    time.sleep(0.6)
    c2 = _view_center(cdp)
    dist = ((c2['x'] - expected['x']) ** 2 + (c2['y'] - expected['y']) ** 2) ** 0.5
    tol = max(30.0, (1.0 / g['s']) * 3)
    if dist > tol:
        return False, (f'点击小地图定位不准：期望中心 ({expected["x"]:.0f},{expected["y"]:.0f})，'
                       f'实际 ({c2["x"]:.0f},{c2["y"]:.0f})，偏差 {dist:.0f} > {tol:.0f}')

    # 5. 折叠 / 展开
    cdp.eval("(() => { const b = document.querySelector('.minimap-close'); if (b) b.click(); return 'ok'; })()")
    time.sleep(0.4)
    st = _j(cdp, """JSON.stringify({
      mini: document.querySelectorAll('.eagle-eye').length,
      toggle: document.querySelectorAll('.eagle-eye-toggle').length,
    })""")
    if st['mini'] != 0 or st['toggle'] != 1:
        return False, f'折叠异常（应只剩展开按钮）：{st}'
    if _j(cdp, """(() => { const b = document.querySelector('.eagle-eye-toggle'); if (b) b.click(); return 'ok'; })()""") != 'ok':
        return False, '展开按钮不可点'
    time.sleep(0.5)
    st2 = _j(cdp, "(() => document.querySelectorAll('.eagle-eye').length)()")
    if st2 != 1:
        return False, f'再次展开失败（.eagle-eye 数量 {st2}）'

    return True, (
        f'小地图通过：{S}px 缩略图唯一颜色 {colors} 种（元素已绘制）；放大 4× 后遮罩 {mask["w"]:.0f}×{mask["h"]:.0f}px '
        f'为真子集；拖动遮罩 30px → 镜头 Δx={got_dx:.0f}（期望 {want_dx:.0f}）；'
        f'点击遮罩外定位偏差 {dist:.0f} 世界单位（容差 {tol:.0f}）；折叠/展开正常'
    )
