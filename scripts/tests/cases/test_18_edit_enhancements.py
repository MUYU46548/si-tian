#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 18：第三批编辑增强专项（E4 旋转/缩放手柄、E5 智能参考线、E7 批量选择/属性、E9 内联文本）

覆盖真实鼠标事件链路 + setupState 直检：
  1. E5 智能参考线：move 拖拽标记靠近另一标记 X → 磁吸对齐 + 拖后参考线清空
  2. E4 旋转手柄：选中标记拖旋转手柄 90° → rotation 变化 + undo 恢复
  3. E4 缩放手柄：拖缩放手柄放大一倍 → scale=2 + undo 恢复
  4. E9 内联文本：双击文本 → 覆盖层出现 → 改名 Enter 提交 + undo 恢复
  5. E7 批量：Shift+点击两个标记 → multiSel=2 → 批量改类型 + 批量拖动 + undo
  6. P1：marker 放置模式下点击已选对象手柄位置 → 放置新标记而非变换（不劫持）
  7. P1：批量面板出现时侧栏 marker 编辑器让位，关闭批量面板后恢复
  8. P1：同层级切换行星 → 选中/批量/内联态清空（无幽灵手柄/输入框）

坐标精度说明：合成 MouseEvent 的 clientX/Y 会被引擎截断为整数像素，
zoom=0.2 时 1px 误差 = 5 世界单位。所有拖拽/点击点先经 quantize_world_pts
量化到"整数屏幕像素栅格"对应的精确世界坐标，保证断言可复现。
"""
import sys, os, json, time, math
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for
from lib.helpers import (goto_planet, enter_edit, confirm_yes, fit_world,
                         set_pm_state, drag_canvas_polyline, dblclick_canvas_at_world)


def quantize_world_pts(cdp, pts):
    """把世界坐标点集量化为整数屏幕像素栅格上的精确世界坐标。

    原理：dispatch 的 clientY = rect.top + sy 会被引擎 floor；
    取 K = ceil(rect.top + sy) 并反解 world' = (K - rect.top - ch/2 - vt.y) / scale，
    则 floor(rect.top + sy') == K 恒成立，screenToWorld 还原结果与 world' 严格一致。
    """
    pts_js = json.dumps(pts)
    expr = f"""(() => {{
      const pm = document.querySelector('.planet-map-container')?.__vueParentComponent?.setupState;
      const c = document.querySelector('.canvas-wrapper canvas');
      if (!pm || !c) return '[]';
      const r = c.getBoundingClientRect();
      const vt = pm.renderer.viewTransform;
      const toSX = wx => wx * vt.scale + vt.x + c.clientWidth / 2;
      const toSY = wy => wy * vt.scale + vt.y + c.clientHeight / 2;
      const fromSX = sx => (sx - c.clientWidth / 2 - vt.x) / vt.scale;
      const fromSY = sy => (sy - c.clientHeight / 2 - vt.y) / vt.scale;
      const pts = {pts_js};
      return JSON.stringify(pts.map(([wx, wy]) => {{
        const kx = Math.ceil(r.left + toSX(wx));
        const ky = Math.ceil(r.top + toSY(wy));
        return [fromSX(kx - r.left), fromSY(ky - r.top)];
      }}));
    }})()"""
    return json.loads(cdp.eval(expr))


def _add_marker(cdp, mid, x, y, name):
    """注入测试标记（mock saveMapData 不落盘，零污染）"""
    return set_pm_state(cdp, f"""
      const pid = pm.store.currentPlanet.id;
      pm.store.addMarker(pid, {{ id: '{mid}', type: 'chest', name: '{name}', x: {x}, y: {y}, description: '' }});
      return 'ok';
    """)


def _remove_marker(cdp, mid):
    return set_pm_state(cdp, f"""
      const pid = pm.store.currentPlanet.id;
      pm.store.removeMarker(pid, '{mid}');
      return 'ok';
    """)


def _marker(cdp, mid):
    v = set_pm_state(cdp, f"""
      const m = pm.currentMapData.markers.find(m => m.id === '{mid}');
      if (!m) return 'null';
      return JSON.stringify({{ rotation: m.rotation || 0, scale: m.scale || 1, x: m.x, y: m.y, type: m.type }});
    """)
    try:
        return json.loads(v or 'null')
    except Exception:
        return None


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    import time

    r = goto_planet(cdp, '乐园星')
    if r != 'planet':
        return False, f'导航行星失败 ({r})'
    time.sleep(1.2)
    enter_edit(cdp)
    time.sleep(0.8)
    confirm_yes(cdp)
    fit_world(cdp)
    time.sleep(0.5)

    # ===== 准备：两个测试标记（B 放到远处，避免磁吸候选/地形/聚落碰撞；网格吸附关闭）=====
    set_pm_state(cdp, "pm.gridSnapEnabled = false; pm.smartGuidesEnabled = true; pm.multiSel = []; return 'ok';")
    for mid, x, y, name in [('t18_mkA', 1500, 1500, 'A'), ('t18_mkB', 6000, 6000, 'B')]:
        if _add_marker(cdp, mid, x, y, name) != 'ok':
            return False, f'注入标记失败 ({mid})'
    time.sleep(0.3)

    try:
        # ============ 1. E5 智能参考线 ============
        set_pm_state(cdp, "pm.setInteractionMode('move'); pm.selectedMarker = null; return 'ok';")
        # 目标点：x = B.x - min(5, 阈值/2)（必落阈值内 → 磁吸到 B.x）；
        # y = 所有候选 y 的最大值 + 阈值 + 20（保证无 Y 候选可吸附）
        target = json.loads(set_pm_state(cdp, """
          const z = pm.renderer.viewTransform.scale;
          const th = 8 / z;
          const bx = 6000;
          let maxY = -Infinity;
          pm.currentMapData.markers.forEach(m => { if (m.id !== 't18_mkA') maxY = Math.max(maxY, m.y); });
          (pm.currentMapData.textLabels || []).forEach(l => { maxY = Math.max(maxY, l.y); });
          pm.places.forEach(p => { if (p.coordinate && p.coordinate.y != null) maxY = Math.max(maxY, p.coordinate.y); });
          (pm.currentMapData.regions || []).forEach(r => (r.points || []).forEach(p => { maxY = Math.max(maxY, p.y); }));
          return JSON.stringify({ x: bx - Math.min(5, th / 2), y: maxY + th + 20, th });
        """) or '{}')
        if 'x' not in target:
            return False, 'E5: 目标点计算失败'
        q = quantize_world_pts(cdp, [(1500, 1500), (target['x'], target['y'])])
        drag_canvas_polyline(cdp, q)
        time.sleep(0.4)
        a = _marker(cdp, 't18_mkA')
        if not a:
            return False, 'E5: 标记 A 丢失'
        if abs(a['x'] - 6000) > 1e-6:
            return False, f'E5: X 未磁吸对齐到 B.x=6000 (实际 {a["x"]})'
        if abs(a['y'] - q[1][1]) > 1e-6:
            return False, f'E5: Y 不应被吸附 (实际 {a["y"]}, 预期 {q[1][1]})'
        guides = set_pm_state(cdp, "return JSON.stringify(pm.smartGuides);")
        if json.loads(guides or '[]') != []:
            return False, f'E5: 拖拽结束后参考线未清空 ({guides})'
        set_pm_state(cdp, "pm.undo(); return 'ok';")
        time.sleep(0.3)
        a2 = _marker(cdp, 't18_mkA')
        if abs(a2['x'] - 1500) > 1e-6:
            return False, f'E5: undo 未恢复 A.x ({a2})'

        # ============ 2. E4 旋转手柄 ============
        set_pm_state(cdp, "pm.selectedMarker = pm.currentMapData.markers.find(m => m.id === 't18_mkA'); return 'ok';")
        # 旋转手柄位于 (cx, cy - 10 - 22/zoom)（rotation=0, scale=1）
        hpos = json.loads(set_pm_state(cdp, """
          const m = pm.currentMapData.markers.find(m => m.id === 't18_mkA');
          const z = pm.renderer.viewTransform.scale;
          return JSON.stringify({ x: m.x, y: m.y - 10 - 22 / z });
        """) or '{}')
        if 'x' not in hpos:
            return False, 'E4: 旋转手柄位置计算失败'
        # 从正上方（-90° 方位）拖到正左方（180° 方位）→ rotation = 180-(-90) = 270 → 归一化 -90
        # 期望值用量化端点精确预测（实现与测试读同一坐标，可复现到浮点精度）
        q = quantize_world_pts(cdp, [(hpos['x'], hpos['y']), (hpos['x'] - 50, hpos['y'] - 5), (1500 - 100, 1500)])
        drag_canvas_polyline(cdp, q)
        time.sleep(0.4)
        a = _marker(cdp, 't18_mkA')
        start_angle = math.atan2(q[0][1] - 1500, q[0][0] - 1500)
        end_angle = math.atan2(q[2][1] - 1500, q[2][0] - 1500)
        expected = ((math.degrees(end_angle - start_angle) + 540) % 360 - 180)
        expected = round(expected * 10) / 10  # 实现侧舍入到 0.1°
        if abs(a['rotation'] - expected) > 0.001:
            return False, f'E4: 旋转手柄未生效 (rotation={a["rotation"]}, 预期 {expected})'
        set_pm_state(cdp, "pm.undo(); return 'ok';")
        time.sleep(0.3)
        a2 = _marker(cdp, 't18_mkA')
        if abs(a2['rotation']) > 1e-6:
            return False, f'E4: 旋转 undo 未恢复 ({a2["rotation"]})'

        # ============ 3. E4 缩放手柄 ============
        # 步骤 2 拖拽终点的 onClick 可能命中地形/区域并清掉选中 → 重新选中
        set_pm_state(cdp, "pm.selectedMarker = pm.currentMapData.markers.find(m => m.id === 't18_mkA'); return 'ok';")
        # 缩放手柄位于 (cx + 10, cy + 10)（rotation=0, scale=1）；拖到 (cx+20, cy+20) → scale=2
        # 期望值 = old.scale × |量化终点-中心| / |量化起点-中心|，取 2 位小数（实现侧舍入规则）
        q = quantize_world_pts(cdp, [(1500 + 10, 1500 + 10), (1500 + 15, 1500 + 15), (1500 + 20, 1500 + 20)])
        drag_canvas_polyline(cdp, q)
        time.sleep(0.4)
        a = _marker(cdp, 't18_mkA')
        d0 = math.hypot(q[0][0] - 1500, q[0][1] - 1500)
        d1 = math.hypot(q[2][0] - 1500, q[2][1] - 1500)
        expected_scale = round(min(5, max(0.2, d1 / d0)), 2)
        if abs(a['scale'] - expected_scale) > 0.001:
            return False, f'E4: 缩放手柄未生效 (scale={a["scale"]}, 预期 {expected_scale})'
        set_pm_state(cdp, "pm.undo(); return 'ok';")
        time.sleep(0.3)
        a2 = _marker(cdp, 't18_mkA')
        if abs(a2['scale'] - 1) > 1e-6:
            return False, f'E4: 缩放 undo 未恢复 ({a2["scale"]})'
        set_pm_state(cdp, "pm.selectedMarker = null; return 'ok';")

        # ============ 4. E9 内联文本 ============
        set_pm_state(cdp, """
          const pid = pm.store.currentPlanet.id;
          pm.store.addTextLabel(pid, { id: 't18_txt', x: 1400, y: 1750, text: '原始文本', fontSize: 16, color: '#2D3436' });
          pm.setInteractionMode('move');
          return 'ok';
        """)
        time.sleep(0.3)
        dblclick_canvas_at_world(cdp, 1400, 1750)
        time.sleep(0.4)
        has_overlay = cdp.eval("!!document.querySelector('.inline-text-edit input')")
        if not has_overlay:
            return False, 'E9: 双击文本未出现内联编辑覆盖层'
        # 改名 → Enter 提交（v-model 需要 input 事件）
        cdp.eval("""
          (() => {
            const el = document.querySelector('.inline-text-edit input');
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(el, '重命名后的文本');
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            return 'ok';
          })()
        """)
        time.sleep(0.4)
        txt = set_pm_state(cdp, "const l = pm.currentMapData.textLabels.find(l => l.id === 't18_txt'); return l ? l.text : 'null';")
        if txt != '重命名后的文本':
            return False, f'E9: 内联编辑未提交 ({txt})'
        set_pm_state(cdp, "pm.undo(); return 'ok';")
        time.sleep(0.3)
        txt2 = set_pm_state(cdp, "const l = pm.currentMapData.textLabels.find(l => l.id === 't18_txt'); return l ? l.text : 'null';")
        if txt2 != '原始文本':
            return False, f'E9: 内联编辑 undo 未恢复 ({txt2})'

        # ============ 5. E7 批量选择/属性/拖动 ============
        # Shift+点击 A 与 B（真实鼠标链路：同点 mousedown/move/mouseup + shiftKey）
        # 注意：A 在步骤 1 拖拽后已 undo 回 (1500,1500)
        a_pos = _marker(cdp, 't18_mkA')
        q = quantize_world_pts(cdp, [(a_pos['x'], a_pos['y'])])
        drag_canvas_polyline(cdp, [q[0], q[0]], shift=True)
        time.sleep(0.3)
        sel1 = set_pm_state(cdp, "return pm.multiSel.length;")
        if int(sel1 or 0) != 1:
            return False, f'E7: Shift+点击 A 未入组 (multiSel={sel1})'
        q = quantize_world_pts(cdp, [(6000, 6000)])
        drag_canvas_polyline(cdp, [q[0], q[0]], shift=True)  # B
        time.sleep(0.3)
        sel2 = set_pm_state(cdp, "return pm.multiSel.length;")
        if int(sel2 or 0) != 2:
            return False, f'E7: Shift+点击 B 未入组 (multiSel={sel2})'
        # 批量面板出现
        has_panel = cdp.eval("!!document.querySelector('.batch-editor')")
        if not has_panel:
            return False, 'E7: 批量属性面板未出现'
        # 批量改类型 → 统一为 flag（断言一致性）
        set_pm_state(cdp, "pm.batchApply('marker', { type: 'flag', color: null }); return 'ok';")
        time.sleep(0.3)
        ta = _marker(cdp, 't18_mkA')
        tb = _marker(cdp, 't18_mkB')
        if ta['type'] != 'flag' or tb['type'] != 'flag':
            return False, f'E7: 批量改类型未生效 (A={ta["type"]}, B={tb["type"]})'
        set_pm_state(cdp, "pm.undo(); return 'ok';")
        time.sleep(0.3)
        # 批量拖动：按住组内 A 拖动 → B 同步位移（量化点差即实际位移，逐分量精确断言）
        before = _marker(cdp, 't18_mkA')
        ax, ay = before['x'], before['y']
        bx, by = _marker(cdp, 't18_mkB')['x'], _marker(cdp, 't18_mkB')['y']
        q = quantize_world_pts(cdp, [(ax, ay), (ax + 50, ay - 30)])
        drag_canvas_polyline(cdp, q)
        time.sleep(0.4)
        a3 = _marker(cdp, 't18_mkA')
        b3 = _marker(cdp, 't18_mkB')
        da = (a3['x'] - ax, a3['y'] - ay)
        db = (b3['x'] - bx, b3['y'] - by)
        if abs(da[0] - db[0]) > 1e-6 or abs(da[1] - db[1]) > 1e-6:
            return False, f'E7: 批量拖动不同步 AΔ{da} BΔ{db}'
        if abs(da[0] - (q[1][0] - q[0][0])) > 1e-6 or abs(da[1] - (q[1][1] - q[0][1])) > 1e-6:
            return False, f'E7: 批量拖动位移不符 AΔ{da} 预期({q[1][0] - q[0][0]}, {q[1][1] - q[0][1]})'
        set_pm_state(cdp, "pm.undo(); pm.multiSel = []; return 'ok';")
        time.sleep(0.3)

        # ============ 6. P1：放置模式不被手柄劫持 ============
        set_pm_state(cdp, "pm.selectedMarker = pm.currentMapData.markers.find(m => m.id === 't18_mkA'); pm.setInteractionMode('marker'); return 'ok';")
        time.sleep(0.2)
        before_ids = set(json.loads(set_pm_state(cdp, "return JSON.stringify(pm.currentMapData.markers.map(m => m.id));") or '[]'))
        # 旋转手柄位于 (1500, 1500-10-22/zoom)；marker 放置模式下点击该处应放置新标记
        hpos = json.loads(set_pm_state(cdp, """
          const z = pm.renderer.viewTransform.scale;
          return JSON.stringify({ x: 1500, y: 1500 - 10 - 22 / z });
        """) or '{}')
        q = quantize_world_pts(cdp, [(hpos['x'], hpos['y'])])
        # 注意用同点折线派发点击：click_canvas_at_world 有视口内检查，
        # 而手柄位置（A 上方 120 世界单位）超出 headless 小画布会被拒绝
        drag_canvas_polyline(cdp, [q[0], q[0]])
        time.sleep(0.3)
        after_ids = json.loads(set_pm_state(cdp, "return JSON.stringify(pm.currentMapData.markers.map(m => m.id));") or '[]')
        new_ids = [i for i in after_ids if i not in before_ids]
        if not new_ids:
            return False, 'P1: marker 放置模式下手柄位置点击未放置新标记（被手柄劫持）'
        new_pos = json.loads(set_pm_state(cdp, f"const m = pm.currentMapData.markers.find(m => m.id === '{new_ids[0]}'); return JSON.stringify({{ x: m.x, y: m.y, rot: m.rotation || 0 }});") or '{}')
        if abs(new_pos['x'] - q[0][0]) > 1e-6 or abs(new_pos['y'] - q[0][1]) > 1e-6:
            return False, f'P1: 新标记位置不符 {new_pos} 预期 {q[0]}'
        set_pm_state(cdp, f"pm.store.removeMarker(pm.store.currentPlanet.id, '{new_ids[0]}'); pm.setInteractionMode('move'); return 'ok';")
        time.sleep(0.2)

        # ============ 7. P1：批量面板出现时侧栏编辑器让位 ============
        set_pm_state(cdp, """
          pm.selectedMarker = pm.currentMapData.markers.find(m => m.id === 't18_mkA');
          pm.multiSel = [ { type: 'marker', id: 't18_mkA' }, { type: 'marker', id: 't18_mkB' } ];
          return 'ok';
        """)
        time.sleep(0.3)
        if not cdp.eval("!!document.querySelector('.batch-editor')"):
            return False, 'P1: 批量面板未出现'
        if cdp.eval("!!document.querySelector('.marker-editor')"):
            return False, 'P1: 批量面板出现时侧栏 marker 编辑器未让位（重叠）'
        set_pm_state(cdp, "pm.multiSel = []; return 'ok';")
        time.sleep(0.3)
        if not cdp.eval("!!document.querySelector('.marker-editor')"):
            return False, 'P1: 批量面板关闭后侧栏 marker 编辑器未恢复'

        # ============ 8. P1：切换行星清空选中/批量/内联态 ============
        set_pm_state(cdp, """
          pm.selectedMarker = pm.currentMapData.markers.find(m => m.id === 't18_mkA');
          pm.multiSel = [ { type: 'marker', id: 't18_mkA' } ];
          const lbl = pm.currentMapData.textLabels.find(l => l.id === 't18_txt');
          if (lbl) pm.startInlineTextEdit(lbl);
          return 'ok';
        """)
        time.sleep(0.2)
        if not cdp.eval("!!document.querySelector('.inline-text-edit')"):
            return False, 'P1: 前置内联编辑覆盖层未出现'
        set_pm_state(cdp, """
          const other = pm.store.nodes.find(n => n.layer === 'planet' && n.name !== '乐园星');
          if (!other) return 'no-other';
          pm.store.selectPlanet(other);
          return 'ok';
        """)
        time.sleep(1.0)
        cleared = json.loads(set_pm_state(cdp, """
          return JSON.stringify({
            marker: !!pm.selectedMarker,
            multi: pm.multiSel.length,
            overlay: !!document.querySelector('.inline-text-edit'),
            planet: pm.store.currentPlanet.name,
          });
        """) or '{}')
        if cleared.get('marker') or cleared.get('multi', 1) != 0 or cleared.get('overlay'):
            return False, f'P1: 切换行星后状态未清空 {cleared}'
        # 切回乐园星（恢复清理上下文）
        set_pm_state(cdp, """
          const home = pm.store.nodes.find(n => n.layer === 'planet' && n.name === '乐园星');
          pm.store.selectPlanet(home);
          return 'ok';
        """)
        time.sleep(1.0)
        if not _marker(cdp, 't18_mkA'):
            return False, 'P1: 切回乐园星后标记 A 丢失'

        return True, '编辑增强专项 8 项全通过（E5 磁吸/E4 旋转/E4 缩放/E9 内联/E7 批量/P1×3）'
    finally:
        # 清理注入对象（幂等：失败路径也执行）
        set_pm_state(cdp, "pm.multiSel = []; pm.selectedMarker = null; return 'ok';")
        _remove_marker(cdp, 't18_mkA')
        _remove_marker(cdp, 't18_mkB')
        set_pm_state(cdp, """
          const pid = pm.store.currentPlanet.id;
          pm.store.removeTextLabel(pid, 't18_txt');
          return 'ok';
        """)
