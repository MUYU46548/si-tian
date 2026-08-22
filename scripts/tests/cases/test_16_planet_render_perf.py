#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 16：行星图渲染回归（批次C1/C2）
覆盖：
  a) marker 绘制全路径 —— 修复前 planetDrawing 裸引用未导入的 markerTypes，
     markers 非空即 ReferenceError 中断整条渲染管线
  b) region 命中检测 —— 修复前 planetHitTest 引用未导入的 geoPointInPolygon，
     regions 非空 + mousemove 即 ReferenceError
  c) fastMode 拖拽路径 —— 视口裁剪 + 降级绘制（跳光晕/标签/凸包）不抛错
  d) perfStats 帧时间宽松阈值 —— headless 软渲染下的防退化冒烟
"""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for
from lib.helpers import goto_planet


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')

    # 错误收集器：渲染管线内的未捕获异常（含 ReferenceError）都会落进 window.__errs
    cdp.eval("(() => { window.__errs = []; window.addEventListener('error', e => window.__errs.push(String(e.message))); return 'ok'; })()")

    r = goto_planet(cdp, '乐园星')
    if r != 'planet':
        return False, f'导航行星失败 ({r})'
    wait_for(cdp, "!!document.querySelector('.planet-map-container canvas')", desc='行星画布挂载')
    time.sleep(1.2)

    # a+b) 注入 marker 与 region 并选中 region，强制走 drawMarkers/drawRegions 全路径
    added = cdp.eval("""(() => {
      const pm = document.querySelector('.planet-map-container').__vueParentComponent.setupState;
      const store = document.querySelector('#app').__vue_app__._instance.setupState.store;
      const pid = store.currentPlanet.id;
      store.addMarker(pid, { id: 'test_marker_c1', type: 'chest', name: 'C1回归标记', x: 100, y: 80 });
      store.addRegion(pid, { id: 'test_region_c1', name: 'C1回归区域', color: '#FF6B6B', type: 'region',
        points: [{ x: 0, y: 0 }, { x: 260, y: 0 }, { x: 260, y: 200 }, { x: 0, y: 200 }] });
      pm.selectedRegion = store.mapData[pid].regions.find(g => g.id === 'test_region_c1');
      pm.renderer.requestRender();
      return JSON.stringify({
        marker: (store.mapData[pid].markers || []).some(m => m.id === 'test_marker_c1'),
        region: (store.mapData[pid].regions || []).some(g => g.id === 'test_region_c1'),
      });
    })()""")
    try:
        flags = json.loads(added) if isinstance(added, str) else {}
    except Exception:
        flags = {}
    if not (flags.get('marker') and flags.get('region')):
        return False, f'marker/region 注入失败 ({added})'

    # b) 模拟 mousemove 穿越 region 内部 → 触发 hitTest 的 region 分支（含 pointInPolygon）
    # c) 同一事件链里做大幅平移拖拽（>5px 阈值）→ fastMode 置位 + 降级重绘
    #    每步 await rAF 强制每步一帧（同步 dispatch 会被 rAF 合并成一帧，帧数不可控）
    drag = cdp.eval("""(async () => {
      const pm = document.querySelector('.planet-map-container').__vueParentComponent.setupState;
      const c = pm.canvas;
      const r = c.getBoundingClientRect();
      const mk = (dx, dy, t) => new MouseEvent(t, {
        clientX: Math.trunc(r.left + c.clientWidth / 2 + dx),
        clientY: Math.trunc(r.top + c.clientHeight / 2 + dy),
        bubbles: true, cancelable: true, button: 0,
      });
      // hover 穿越 region（视口中心附近，region 覆盖 0..260 x 0..200 世界坐标）
      c.dispatchEvent(mk(30, 20, 'mousemove'));
      // 平移拖拽：累计位移远超 fastModeThreshold=5
      c.dispatchEvent(mk(-40, -30, 'mousedown'));
      for (let i = 1; i <= 8; i++) {
        c.dispatchEvent(mk(-40 + i * 25, -30 + i * 18, 'mousemove'));
        await new Promise(res => requestAnimationFrame(res));
      }
      c.dispatchEvent(mk(160, 114, 'mouseup'));
      await new Promise(res => requestAnimationFrame(res));
      const stats = pm.renderer.getPerfStats();
      // frameCount 每秒被 fps 统计清零，用滚动窗口 _frameTimes 判帧数
      return JSON.stringify({ avgFrameTime: stats.avgFrameTime, sampled: (stats._frameTimes || []).length });
    })()""")
    try:
        stats = json.loads(drag) if isinstance(drag, str) else {}
    except Exception:
        stats = {}
    time.sleep(0.5)  # 等最后的 rAF 帧落定

    errs = cdp.eval("window.__errs ? JSON.stringify(window.__errs) : '[]'")
    try:
        err_list = json.loads(errs) if isinstance(errs, str) else [str(errs)]
    except Exception:
        err_list = [str(errs)]
    # 过滤与本组件无关的环境噪声（如 ResizeObserver）再判
    fatal = [e for e in err_list if 'ResizeObserver' not in e]
    if fatal:
        return False, f'渲染管线抛错: {fatal[:3]}'

    avg = stats.get('avgFrameTime')
    if not isinstance(avg, (int, float)) or stats.get('sampled', 0) < 3:
        return False, f'perfStats 不可读或采样帧不足 ({drag})'
    if avg > 120:  # headless --disable-gpu 软渲染下的宽松退化阈值
        return False, f'平均帧时间异常 {avg:.1f}ms (>120ms)'

    return True, f'marker/region 绘制+命中无异常，拖拽采样 {stats.get("sampled")} 帧 avg {avg:.1f}ms'
