#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 31：Relief Icons 地貌图标笔刷（P0-1）

验收点（对应提示词 P0-1 的「验收标准」逐条）：
1. 拖动后图标沿线散布，自然不重叠 —— 图标贴合路径且两两不重叠；散点算法确定性（同 seed 同结果）
2. 4 种图标类型可以切换 —— 面板 4 个类型按钮，换类型后新笔迹用新类型
3. 调整大小/间距实时生效 —— 同长度拖动，间距 8 明显比间距 80 落点更多
4. 撤销/重做正常（一次拖动 = 一条 undo）
5. 右键拖动擦除，且擦除也是一条 undo
6. 保存载荷含 reliefIcons（持久化闭环）
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


def _world_center(cdp):
    return _j(cdp, f"""(() => {{
      const b = {PM}.worldBounds;
      return JSON.stringify([(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]);
    }})()""")


def _drag(cdp, points, button=0):
    """真实事件链拖拽（支持右键：button=2）"""
    pts = json.dumps(points)
    return cdp.eval(f"""(() => {{
      const pm = {PM};
      const c = document.querySelector('.planet-map-container .canvas-wrapper canvas');
      if (!pm || !c) return 'no-canvas';
      const r = c.getBoundingClientRect();
      const vt = pm.renderer.viewTransform;
      const toSX = wx => wx * vt.scale + vt.x + c.clientWidth / 2;
      const toSY = wy => wy * vt.scale + vt.y + c.clientHeight / 2;
      const mk = (x, y, t) => new MouseEvent(t, {{
        clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true, button: {button},
      }});
      const p = {pts};
      c.dispatchEvent(mk(toSX(p[0][0]), toSY(p[0][1]), 'mousedown'));
      for (let i = 1; i < p.length; i++) c.dispatchEvent(mk(toSX(p[i][0]), toSY(p[i][1]), 'mousemove'));
      const last = p[p.length - 1];
      c.dispatchEvent(mk(toSX(last[0]), toSY(last[1]), 'mouseup'));
      return 'ok';
    }})()""")


def _icons(cdp):
    return _j(cdp, f"""(() => {{
      const pm = {PM};
      const list = (pm.currentMapData && pm.currentMapData.reliefIcons) || [];
      return JSON.stringify({{
        n: list.length,
        types: [...new Set(list.map(i => i.type))],
        shapes: list.every(i => Number.isFinite(i.x) && Number.isFinite(i.y)
          && Number.isFinite(i.size) && Number.isFinite(i.rotation) && typeof i.type === 'string'),
        sizes: [...new Set(list.map(i => Math.round(i.size)))].length,
      }});
    }})()""")


def _min_pair_distance(cdp):
    return cdp.eval(f"""(() => {{
      const pm = {PM};
      const list = (pm.currentMapData && pm.currentMapData.reliefIcons) || [];
      let best = Infinity;
      for (let i = 0; i < list.length; i++) {{
        for (let j = i + 1; j < list.length; j++) {{
          const d = Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y);
          if (d < best) best = d;
        }}
      }}
      return Number.isFinite(best) ? Math.round(best * 100) / 100 : -1;
    }})()""")


def _max_dist_to_path(cdp, path):
    pts = json.dumps(path)
    return cdp.eval(f"""(() => {{
      const pm = {PM};
      const list = (pm.currentMapData && pm.currentMapData.reliefIcons) || [];
      const P = {pts};
      const distToSeg = (px, py, a, b) => {{
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const L = dx * dx + dy * dy;
        let t = L === 0 ? 0 : ((px - a[0]) * dx + (py - a[1]) * dy) / L;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
      }};
      let worst = 0;
      for (const it of list) {{
        let best = Infinity;
        for (let i = 0; i < P.length - 1; i++) best = Math.min(best, distToSeg(it.x, it.y, P[i], P[i + 1]));
        worst = Math.max(worst, best);
      }}
      return Math.round(worst * 100) / 100;
    }})()""")


DETERMINISM_JS = """(async () => {
  const mod = await import('/src/utils/reliefIcons.js');
  const path = [{x:0,y:0},{x:300,y:0},{x:300,y:200}];
  const base = { type:'mountain', size:24, spacing:30, density:'medium', randomRotation:true, seed:7 };
  const sig = (l) => JSON.stringify(l.map(i => [i.type, Math.round(i.x*1e4)/1e4, Math.round(i.y*1e4)/1e4, Math.round(i.size*1e4)/1e4, i.rotation]));
  const a = mod.scatterAlongPath(path, base, []);
  const b = mod.scatterAlongPath(path, base, []);
  const c = mod.scatterAlongPath(path, { ...base, seed: 8 }, []);
  const d = mod.scatterAlongPath(path, { ...base, spacing: 8 }, []);
  let minPair = Infinity;
  for (let i = 0; i < a.length; i++)
    for (let j = i + 1; j < a.length; j++)
      minPair = Math.min(minPair, Math.hypot(a[i].x - a[j].x, a[i].y - a[j].y));
  return JSON.stringify({
    n: a.length,
    nDense: d.length,
    deterministic: sig(a) === sig(b),
    seedSensitive: sig(a) !== sig(c),
    minPair: Number.isFinite(minPair) ? Math.round(minPair * 100) / 100 : -1,
    minSize: a.length ? Math.min(...a.map(i => i.size)) : 0,
    maxSize: a.length ? Math.max(...a.map(i => i.size)) : 0,
    rotated: a.some(i => i.rotation !== 0),
  });
})()"""


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    ensure_data_ready(cdp)

    # ── 1. 散点算法：确定性 + 不重叠 + 密度可调 ─────────────────────────
    det = _j(cdp, DETERMINISM_JS)
    if not isinstance(det, dict):
        return False, f'取不到散布算法结果 {det}'
    if det['n'] <= 0:
        return False, f'散布算法没有产出任何图标 {det}'
    if not det['deterministic']:
        return False, f'散布算法不确定（同 seed 两次结果不同）：{det}'
    if not det['seedSensitive']:
        return False, '换 seed 结果不变 —— 旋转/抖动未接入哈希'
    if det['nDense'] <= det['n']:
        return False, f'间距调小后落点未变多（{det["n"]} → {det["nDense"]}）—— 间距参数未生效'
    if det['minPair'] > 0 and det['minPair'] < 14:
        return False, f'图标重叠（最近间距 {det["minPair"]} < 14）—— 未做不重叠约束'

    # ── 2. 进入行星 + 编辑模式 + 地貌笔刷 ──────────────────────────────
    r = goto_planet(cdp, '乐园星')
    if r != 'planet':
        return False, f'导航行星失败 ({r})'
    wait_for(cdp, "!!document.querySelector('.planet-map-container .canvas-wrapper canvas')", desc='行星画布挂载')
    time.sleep(1.0)
    if enter_edit(cdp) != 'ok':
        return False, '进入编辑模式失败'
    time.sleep(0.7)
    _j(cdp, f"(() => {{ {PM}.zoomFit(); {PM}.renderer.setScale(1); return 'ok'; }})()")
    time.sleep(0.5)

    # 通过工具栏按钮进入（真实入口；顺带验证按钮存在）
    entered = _j(cdp, """(() => {
      const root = document.querySelector('.planet-map-container');
      const b = Array.from(root.querySelectorAll('button'))
        .find(x => (x.getAttribute('title') || '').includes('地貌图标笔刷'));
      if (!b) return 'no-btn';
      b.click();
      return 'ok';
    })()""")
    if entered != 'ok':
        return False, '工具栏缺少「地貌图标笔刷」按钮'
    time.sleep(0.4)
    panel = _j(cdp, """JSON.stringify({
      mode: document.querySelector('.planet-map-container').__vueParentComponent.setupState.interactionMode,
      panel: !!document.querySelector('[data-testid="relief-panel"]'),
      types: Array.from(document.querySelectorAll('[data-testid^="relief-type-"]')).map(b => b.dataset.testid),
    })""")
    if panel.get('mode') != 'relief' or not panel.get('panel'):
        return False, f'地貌笔刷未进入（{panel}）'
    if len(panel.get('types') or []) != 4:
        return False, f'类型按钮应 4 个，实际 {panel.get("types")}'

    # 保存载荷来源：接线后 mapData 落盘去向 = 项目文件（harness 已挂好 projectSave 记录 + __probe）

    cx, cy = _world_center(cdp)
    if cx is None:
        return False, '取不到地图中心'

    # ── 3. 左键拖动散布 ────────────────────────────────────────────────
    base_n = _icons(cdp)['n']
    _j(cdp, f"(() => {{ {PM}.reliefBrush.reliefType.value = 'mountain'; {PM}.reliefBrush.reliefSpacing.value = 30; return 'ok'; }})()")
    time.sleep(0.2)
    path = [[cx - 200, cy - 60], [cx - 100, cy - 60], [cx, cy - 60], [cx + 100, cy - 60], [cx + 200, cy - 60]]
    if _drag(cdp, path) != 'ok':
        return False, '拖动事件派发失败'
    time.sleep(0.6)
    after = _icons(cdp)
    if after['n'] <= base_n:
        return False, f'拖动后没有散布图标（{base_n} → {after["n"]}）'
    if not after['shapes']:
        return False, f'图标字段形状不完整（缺 x/y/size/rotation/type）：{after}'
    added = after['n'] - base_n
    worst = _max_dist_to_path(cdp, path)
    if worst > 60:
        return False, f'图标离笔迹过远（最远 {worst} > 60）——散布未贴合路径'
    min_pair = _min_pair_distance(cdp)
    if min_pair > 0 and min_pair < 10:
        return False, f'拖过的图标互相重叠（最近 {min_pair}）'

    # ── 4. 一次拖动 = 一条 undo ────────────────────────────────────────
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.4)
    undone = _icons(cdp)['n']
    if undone != base_n:
        return False, f'撤销未回到拖动前（{after["n"]} → {undone}，期望 {base_n}）—— 一次拖动被拆成多条 undo'
    _j(cdp, f"(() => {{ {STORE}.redo(); return 'ok'; }})()")
    time.sleep(0.4)
    if _icons(cdp)['n'] != after['n']:
        return False, '重做未恢复散布结果'

    # ── 5. 换类型：新笔迹用新类型 ──────────────────────────────────────
    _j(cdp, """(() => {
      const b = document.querySelector('[data-testid="relief-type-tree"]');
      if (b) b.click();
      return 'ok';
    })()""")
    time.sleep(0.3)
    t2 = [[cx - 200, cy + 80], [cx - 60, cy + 80], [cx + 80, cy + 80], [cx + 200, cy + 80]]
    _drag(cdp, t2)
    time.sleep(0.6)
    typed = _icons(cdp)
    if 'tree' not in (typed['types'] or []):
        return False, f'切到「树木」后新笔迹未产生 tree 类型图标：{typed["types"]}'
    if typed['n'] <= after['n']:
        return False, '第二次绘制没有新增图标'

    # ── 6. 间距实时生效：间距 8 的短拖动比间距 80 更密 ──────────────────
    def _stroke_with_spacing(py, spacing):
        _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
        time.sleep(0.3)
        n0 = _icons(cdp)['n']
        _j(cdp, f"""(() => {{
          const pm = {PM};
          pm.reliefBrush.reliefType.value = 'mountain';
          pm.reliefBrush.reliefSpacing.value = {spacing};
          return 'ok';
        }})()""")
        time.sleep(0.2)
        seg = [[cx - 150, py], [cx - 90, py], [cx - 30, py], [cx + 30, py], [cx + 90, py]]
        _drag(cdp, seg)
        time.sleep(0.6)
        return _icons(cdp)['n'] - n0

    dense = _stroke_with_spacing(cy, 8)
    sparse = _stroke_with_spacing(cy, 80)
    if not (dense > sparse >= 0):
        return False, f'间距参数未实时生效（间距 8 落点 {dense}，间距 80 落点 {sparse}）'

    # ── 7. 右键拖动擦除 + 一条 undo ────────────────────────────────────
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.3)
    _j(cdp, f"(() => {{ {PM}.reliefBrush.reliefSpacing.value = 30; return 'ok'; }})()")
    before_erase = _icons(cdp)['n']
    # 在已散布的那条线上右键划过
    erase_path = [[cx - 200, cy - 60], [cx - 100, cy - 60], [cx, cy - 60], [cx + 100, cy - 60], [cx + 200, cy - 60]]
    if _drag(cdp, erase_path, button=2) != 'ok':
        return False, '右键拖动事件派发失败'
    time.sleep(0.6)
    after_erase = _icons(cdp)['n']
    if after_erase >= before_erase:
        return False, f'右键拖动没有擦除任何图标（{before_erase} → {after_erase}）'
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.4)
    if _icons(cdp)['n'] != before_erase:
        return False, f'擦除撤销未复原（{_icons(cdp)["n"]} ≠ {before_erase}）'

    # ── 8. 保存载荷含 reliefIcons（落盘去向 = 项目文件） ────────────────
    time.sleep(1.4)  # 自动保存防抖 800ms → 项目侧再防抖 800ms
    _j(cdp, "window.__probe.flushProject()")
    payload = _j(cdp, """(() => {
      const p = window.__probe.lastMapPayload('乐园星');
      if (!p) return JSON.stringify({ n: 0 });
      const r = p.data.reliefIcons;
      return JSON.stringify({
        n: (window.__savedProject || []).length,
        isArray: Array.isArray(r),
        len: r ? r.length : 0,
        roundTrip: r ? JSON.parse(JSON.stringify(r)).length : 0,
      });
    })()""")
    if payload.get('n', 0) <= 0:
        return False, '地貌图标编辑后没有触发项目文件落盘'
    if not payload.get('isArray') or payload.get('roundTrip') != payload.get('len'):
        return False, f'保存载荷里 reliefIcons 不是可 JSON 往返的数组：{payload}'

    _j(cdp, f"(() => {{ {PM}.setInteractionMode('pan'); return 'ok'; }})()")
    return True, (
        f'地貌图标笔刷通过：散点确定性（同 seed {det["n"]} 个点完全一致、换 seed 变化、最小间距 {det["minPair"]}）；'
        f'拖动散布 {added} 个且离笔迹最远 {worst}、彼此不重叠（最近 {min_pair}）；'
        f'一次拖动 = 一条 undo（撤销/重做正常）；类型切换产出 {typed["types"]}；'
        f'间距 8/80 落点 {dense}/{sparse}；右键擦除 {before_erase}→{after_erase} 且可撤销；'
        f'保存载荷 reliefIcons {payload["len"]} 项可 JSON 往返'
    )
