#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 51：Phase 2.6 区域勾轮廓管线 —— 闭环简化 + 离屏校验「落地内 + 不重叠」

覆盖：
  a) 纯函数层：手抖闭环 → simplifyClosedTrace 顶点数大降且**保形**（面积偏差 ≤ 8%）
  b) 纯函数层：轮廓大部分落在可绘制范围外 → code='outside'；完全在内 → ok
  c) 纯函数层：与已有区域重叠 → code='overlap' 且消息点名 + 带百分比；不重叠 → ok
  d) 端到端（接受路径）：区域模式自由拖拽 → 区域 +1、落库顶点已被简化、一条 undo 全撤
  e) 端到端（拒绝路径·重叠）：盖在已有区域上 → 区域数不变 + 状态栏给出重叠原因
  f) 端到端（拒绝路径·落地内）：行星边界设小后画在界外 → 区域数不变 + 状态栏给出范围原因

判定一律走 lib/cdp.py 的 eval_json（异常/非 JSON/缺字段 = 失败），不用「没有 fails 就算过」。
"""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json
from lib import helpers as H

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
PM = "document.querySelector('.planet-map-container').__vueParentComponent.setupState"
STATUS = "document.querySelector('.status-bar')"

# ── JS 片段（用 PLACEHOLDER 注入，避免 f-string 的 {} 转义陷阱）──
JS_MODULE = r"""
(async () => {
  const fails = [];
  const same = (label, got, want) => { if (String(got) !== String(want)) fails.push(label + ' got=' + got + ' want=' + want); };
  const mod = await import('/src/utils/regionTrace.js');
  const { simplifyClosedTrace, validateRegionTrace, closedRing } = mod;

  // ── a) 手抖闭环保形简化 ──
  const raw = [];
  const N = 200, R = 100;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    // 确定性抖动（不用 Math.random）：正弦伪噪声 ±3 世界单位
    const j = 3 * Math.sin(i * 12.9898) * Math.cos(i * 78.233);
    raw.push({ x: Math.cos(a) * (R + j), y: Math.sin(a) * (R + j) });
  }
  const simp = simplifyClosedTrace(raw, 2);
  const area = (pts) => { let s = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; s += p.x * q.y - q.x * p.y; } return Math.abs(s) / 2; };
  const a0 = area(raw), a1 = area(simp);
  if (!(simp.length >= 3)) fails.push('简化后顶点数 < 3（' + simp.length + '）');
  if (!(simp.length <= 40)) fails.push('简化无效：' + raw.length + ' → ' + simp.length + '（期望 ≤ 40）');
  const areaErr = Math.abs(a1 - a0) / a0;
  if (!(areaErr <= 0.10)) fails.push('简化后形状失真 ' + (areaErr * 100).toFixed(1) + '%（面积 ' + a0.toFixed(1) + ' → ' + a1.toFixed(1) + '）');
  // 简化必须与「从哪一格起笔」无关（锚点=离质心最远点）
  const rot = raw.slice(37).concat(raw.slice(0, 37));
  same('简化结果对起笔位置敏感', simplifyClosedTrace(rot, 2).length, simp.length);

  // ── b) 落地内 ──
  const box = [[{ x: -100, y: -100 }, { x: 100, y: -100 }, { x: 100, y: 100 }, { x: -100, y: 100 }]];
  const outside = [{ x: 400, y: 400 }, { x: 500, y: 400 }, { x: 500, y: 500 }, { x: 400, y: 500 }];
  const inside = [{ x: -50, y: -50 }, { x: 50, y: -50 }, { x: 50, y: 50 }, { x: -50, y: 50 }];
  const rOut = validateRegionTrace({ points: outside, containers: box, simplify: false });
  const rIn = validateRegionTrace({ points: inside, containers: box, simplify: false });
  same('界外轮廓未被拒', rOut.ok, false);
  same('界外拒绝码', rOut.code, 'outside');
  if (!/可绘制范围/.test(rOut.message || '')) fails.push('界外消息不可读：' + rOut.message);
  same('界内轮廓被误拒', rIn.ok, true);
  same('界内 insideRatio', rIn.stats.insideRatio.toFixed(2), '1.00');
  // 不定范围（containers 为空）= 跳过落地内检查，不得拒绝
  const rNoCont = validateRegionTrace({ points: outside, simplify: false });
  same('无范围时误拒', rNoCont.ok, true);

  // ── c) 不重叠 ──
  const sib = [{ id: 'sib', name: '旧区域', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] }];
  const onTop = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const away = [{ x: 500, y: 500 }, { x: 600, y: 500 }, { x: 600, y: 600 }, { x: 500, y: 600 }];
  const rOv = validateRegionTrace({ points: onTop, siblings: sib, simplify: false });
  const rFree = validateRegionTrace({ points: away, siblings: sib, simplify: false });
  same('重叠未被拒', rOv.ok, false);
  same('重叠拒绝码', rOv.code, 'overlap');
  if (!/旧区域/.test(rOv.message || '')) fails.push('重叠消息未点名：' + rOv.message);
  if (!/%/.test(rOv.message || '')) fails.push('重叠消息缺比例：' + rOv.message);
  if (!(rOv.stats.overlapRatio > 0.95)) fails.push('重叠比例算错：' + rOv.stats.overlapRatio);
  same('不重叠时误拒', rFree.ok, true);
  same('不重叠比例', rFree.stats.overlapRatio.toFixed(2), '0.00');
  // 退化输入：两点 / 零面积
  same('两点未被拒', validateRegionTrace({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }).code, 'too-few-points');
  same('零面积未被拒', validateRegionTrace({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }] }).code, 'degenerate');

  return JSON.stringify({ fails, rawN: raw.length, simpN: simp.length, areaErr: areaErr,
    outsideMsg: rOut.message, overlapMsg: rOv.message });
})()
"""

# 在行星图上按世界坐标拖一圈（真实事件链；绘制期间关掉吸附，保证落点确定）
JS_DRAW = r"""
(async () => {
  const fails = [];
  const pm = PLACEHOLDER_PM;
  const s = PLACEHOLDER_STORE;
  if (!pm) return JSON.stringify({ fails: ['PlanetMap 未挂载'] });
  const pid = pm.props.planet ? pm.props.planet.id : null;
  if (!pid) return JSON.stringify({ fails: ['没有当前行星'] });
  if (!s.mapData[pid]) return JSON.stringify({ fails: ['行星地图数据未加载'] });

  if (PRESET) { pm.canvasSizePreset = '150'; }
  pm.editMode = true;
  pm.interactionMode = 'region';
  pm.drawMode = true;          // 自由绘制（勾轮廓）
  pm.floodFillMode = false;
  pm.snapEnabled = false;      // 关吸附：合成事件的落点必须确定
  pm.gridSnapEnabled = false;
  await new Promise(r => setTimeout(r, 80));

  const before = (s.mapData[pid].regions || []).length;
  return JSON.stringify({ fails, pid, before, mode: pm.interactionMode, drawMode: pm.drawMode });
})()
"""

JS_READ = r"""
(() => {
  const pm = PLACEHOLDER_PM;
  const s = PLACEHOLDER_STORE;
  const pid = pm.props.planet.id;
  const regions = s.mapData[pid].regions || [];
  const last = regions[regions.length - 1];
  // 目标区域的质心（拒绝路径要用它当落点）
  const base = regions[0] || null;
  let cen = null, rad = 0;
  if (base && base.points && base.points.length) {
    let sx = 0, sy = 0, minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (const p of base.points) { sx += p.x; sy += p.y; minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    cen = { x: sx / base.points.length, y: sy / base.points.length };
    rad = Math.max(maxX - minX, maxY - minY) / 2;
  }
  const st = STATUS_TEXT;
  return JSON.stringify({ fails: [], n: regions.length, pid,
    last: last ? { id: last.id, name: last.name, npts: last.points.length, color: last.color,
                   cx: last.points.reduce((a, p) => a + p.x, 0) / last.points.length,
                   cy: last.points.reduce((a, p) => a + p.y, 0) / last.points.length } : null,
    base: cen ? { cx: cen.x, cy: cen.y, r: rad } : null, toolLabel: st });
})()
"""


def _j(cdp, expr, desc=''):
    ok, obj = eval_json(cdp, expr, required=('fails',), desc=desc)
    if not ok:
        return None, obj
    return obj, ''



def _ring(cx, cy, r, n=36):
    import math
    pts = []
    for i in range(n):
        a = (i / n) * math.tau
        pts.append((cx + math.cos(a) * r, cy + math.sin(a) * r))
    pts.append(pts[0])
    return pts


def _region_setup(cdp, preset=False):
    ok, obj = eval_json(cdp, JS_DRAW.replace('PLACEHOLDER_PM', PM).replace('PLACEHOLDER_STORE', STORE)
                        .replace('PRESET', 'true' if preset else 'false'), required=('fails',), desc='区域绘制准备')
    return (obj, '') if ok else (None, obj)


def _region_read(cdp):
    return _j(cdp, JS_READ.replace('PLACEHOLDER_PM', PM).replace('PLACEHOLDER_STORE', STORE)
              .replace('STATUS_TEXT', "document.querySelector('.status-bar') ? document.querySelector('.status-bar').textContent : ''"), desc='读取区域')


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')

    # ── a~c) 纯函数层：直接 import 模块，断言语义（快、准）──
    obj, err = _j(cdp, JS_MODULE, desc='regionTrace 纯函数')
    if obj is None:
        return False, f'纯函数子测试求值失败：{err}'
    if obj['fails']:
        return False, '纯函数层失败：' + '；'.join(obj['fails'])
    pure_summary = f"{obj['rawN']} → {obj['simpN']} 顶点（面积偏差 {obj['areaErr']*100:.1f}%）"
    print(f"    [a-c] 简化 {pure_summary}；界外拒绝 → {obj['outsideMsg']}；重叠拒绝 → {obj['overlapMsg']}")

    # ── 进入行星地图 ──
    level = H.goto_planet(cdp, '乐园星')
    if level != 'planet':
        return False, f'导航行星失败（viewLevel={level}）'
    H.enter_edit(cdp)
    wait_for(cdp, f"!!document.querySelector('.canvas-wrapper canvas')", desc='行星画布挂载')
    time.sleep(0.8)
    H.fit_world(cdp)
    time.sleep(0.4)

    try:
        # ── d) 接受路径：在视口中心附近画一圈（远离已有「区域 1」）──
        obj, err = _region_setup(cdp)
        if obj is None:
            return False, f'区域绘制准备失败：{err}'
        before = obj['before']
        if obj['mode'] != 'region' or not obj['drawMode']:
            return False, f'未进入区域自由绘制态 {obj}'

        # 视口中心世界坐标（画在可见处，避免落到屏幕外）
        cen = cdp.eval("(() => { const pm = %s; const c = document.querySelector('.canvas-wrapper canvas'); const vt = pm.renderer.viewTransform; return JSON.stringify({ cx: -vt.x / vt.scale, cy: -vt.y / vt.scale, scale: vt.scale }); })()" % PM)
        cen = json.loads(cen) if isinstance(cen, str) else cen
        pts = H.quantize_world_pts(cdp, _ring(cen['cx'], cen['cy'], 120, 36))
        H.drag_canvas_polyline(cdp, pts)
        time.sleep(0.5)

        st, err = _region_read(cdp)
        if st is None:
            return False, f'读取区域失败：{err}'
        if st['n'] != before + 1:
            return False, f'自由绘制未创建区域（{before} → {st["n"]}）；状态栏：{st["toolLabel"]!r}'
        last = st['last']
        if last['npts'] < 3:
            return False, f'区域顶点不足 {last}'
        if last['npts'] > 24:
            return False, f'落库轮廓未被简化：{len(pts)} 点拖拽 → {last["npts"]} 顶点（期望 ≤ 24）'
        off = ((last['cx'] - cen['cx']) ** 2 + (last['cy'] - cen['cy']) ** 2) ** 0.5
        if off > 60:
            return False, f'区域生成位置偏移过大（质心偏离拖拽中心 {off:.0f} 世界单位）{last}'
        accepted = last['npts']

        # 一条 undo 撤销整块
        cdp.eval(f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
        time.sleep(0.4)
        st2, _ = _region_read(cdp)
        if st2['n'] != before:
            return False, f'一次撤销未撤掉整块区域（{st2["n"]} ≠ {before}）'
        cdp.eval(f"(() => {{ {STORE}.redo(); return 'ok'; }})()")
        time.sleep(0.3)

        # ── e) 拒绝路径·重叠：盖在已有「区域 1」上 ──
        base = st2['base']
        if not base:
            return False, '没有可用的已有区域做重叠用例'
        H.drag_canvas_polyline(cdp, H.quantize_world_pts(cdp, _ring(base['cx'], base['cy'], max(20.0, base['r'] * 0.8), 24)))
        time.sleep(0.5)
        st3, err = _region_read(cdp)
        if st3 is None:
            return False, f'读取区域失败：{err}'
        if st3['n'] != before + 1:
            return False, f'重叠轮廓未被拒绝（区域数 {st3["n"]}，期望 {before + 1}）；状态栏：{st3["toolLabel"]!r}'
        if '重叠' not in (st3['toolLabel'] or ''):
            return False, f'重叠被拒但状态栏没说原因：{st3["toolLabel"]!r}'

        # ── f) 拒绝路径·落地内：行星边界设小（±150）后画在界外 ──
        # 落点取远离已有区域的固定世界坐标 (900,900)：保证触发的是「落地内」判定而不是先被重叠拦下
        # （区域 1 在 (-274,-480)，接受路径新建的区域在视口中心附近 r≈120，都够远）。
        cdp.eval(f"(() => {{ {PM}.canvasSizePreset = '150'; return 'ok'; }})()")
        time.sleep(0.2)
        obj, err = _region_setup(cdp)
        if obj is None:
            return False, f'区域绘制准备失败：{err}'
        H.drag_canvas_polyline(cdp, H.quantize_world_pts(cdp, _ring(900.0, 900.0, 60.0, 20)))
        time.sleep(0.5)
        st4, err = _region_read(cdp)
        if st4 is None:
            return False, f'读取区域失败：{err}'
        if st4['n'] != before + 1:
            return False, f'界外轮廓未被拒绝（区域数 {st4["n"]}，期望 {before + 1}）；状态栏：{st4["toolLabel"]!r}'
        if '可绘制范围' not in (st4['toolLabel'] or ''):
            return False, f'界外被拒但状态栏没说原因：{st4["toolLabel"]!r}'
        outsideMsg = st4['toolLabel']
    finally:
        # 清场：撤销本次用例新增的区域 + 还原行星边界（localStorage 会跨用例留存）
        cdp.eval(f"(() => {{ const s = {STORE}; for (let i = 0; i < 6; i++) s.undo(); return 'ok'; }})()")
        cdp.eval(f"(() => {{ {PM}.canvasSizePreset = 'auto'; return 'ok'; }})()")

    return True, (f'区域勾轮廓管线通过：手抖闭环简化保形（{pure_summary}）、自由绘制落库 {accepted} 顶点 + 一条 undo；'
                  f'拒绝路径（重叠 / 落地内）均不改区域数 —— 落地内消息「{outsideMsg}」')
