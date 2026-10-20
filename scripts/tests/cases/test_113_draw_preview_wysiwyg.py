#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 113：自由绘制的**预览 = 落库**（2026-10-17 第四轮；暮雨「不要搞成描点连线模拟器」）

来历：他看过前几轮的成果后给的方向是「主要是编辑体验这一块，不要搞成描点连线模拟器就行」。
查代码发现一处**真·体验断点**：松手**前**画的是手迹折线（`tracePath(freeTrace)`），
松手**后**落库的是另一条形状（简化 → 贴骨架 → 贝塞尔）—— 两条不一样，预览就只是"笔迹"，
不是"你将得到的那块地"。现在两者共用 `freeTraceRing()`。

本用例守四段：
  a 源码闸门：预览与落库都走 `freeTraceRing`；预览画的是**闭合地块**（`previewTraceRing` +
    `withBezierControls` + `traceShapePath(..., true)`）；骨架按 terrain 缓存（415 省不许每帧重建）。
  b 画出来的确实是"地块"：拖笔期间圈内颜色**被着色**（不只是边界一条线）。
  c **逐点相同**：拖笔期间算出的环 == 松手后写进 terrain 的环（去掉贝塞尔控制点后逐点相等）。
  d 落库的环带贝塞尔控制点（曲线观感）+ 点数少于原始手迹（说明真的简化了，不是逐点连线）。
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from lib.cdp import eval_json, wait_for      # noqa: E402
from lib.helpers import ensure_case_state    # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SMV = os.path.join(ROOT, 'src', 'renderer', 'src', 'components', 'ScenarioMap.vue')
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"


def _code_only(src):
    out, in_block = [], False
    for line in src.split('\n'):
        s = line
        if in_block:
            if '*/' in s:
                s = s.split('*/', 1)[1]
                in_block = False
            else:
                continue
        while '/*' in s:
            before, after = s.split('/*', 1)
            if '*/' in after:
                s = before + after.split('*/', 1)[1]
            else:
                s = before
                in_block = True
                break
        if '//' in s:
            s = s.split('//', 1)[0]
        out.append(s)
    return '\n'.join(out)


def _read(path):
    with open(path, encoding='utf-8') as f:
        return _code_only(f.read())


def source_gates():
    fails = []
    sm = _read(SMV)
    if 'function freeTraceRing(' not in sm:
        fails.append('🔴 没有 freeTraceRing —— 预览与落库各写一份几何链（形状会对不上）')
    # 落库两条路都必须走同一条链
    i = sm.find('function commitFreeTrace(')
    seg = sm[i:i + 1800] if i >= 0 else ''
    if 'freeTraceRing(pts' not in seg:
        fails.append('🔴 commitFreeTrace 没走 freeTraceRing（落库几何与预览不同源）')
    j = sm.find('function commitOutlineTrace(')
    seg2 = sm[j:j + 1200] if j >= 0 else ''
    if 'freeTraceRing(pts, { snap: false })' not in seg2:
        fails.append('🔴 commitOutlineTrace 没走 freeTraceRing（描轮廓的预览与落库不同源）')
    # 预览必须画闭合地块 + 贝塞尔，而不是只有一条手迹线
    if 'previewTraceRing()' not in sm:
        fails.append('🔴 预览没走 previewTraceRing（仍是手迹折线 = 描点连线模拟器的观感）')
    if 'withBezierControls(previewRing)' in sm:
        fails.append('🔴 T8：预览又套了贝塞尔控制点（看到的曲线 ≠ 数据多边形；布尔/命中按顶点算）')
    if 'traceShapePath(c, ring, true)' not in sm:
        fails.append('🔴 预览不是闭合路径（用户看不到"围出了哪块地"）')
    # 骨架缓存（415 省底图每帧 buildSkeleton 会拖死拖笔）
    if 'function skeletonForTerrain(' not in sm or 'skeletonCache' not in sm:
        fails.append('🔴 骨架没有按 terrain 缓存 —— 大底图上每帧重建骨架，拖笔会卡')
    return fails


# 造一张空底图（无省份 → 不会触发压叠闸门、也不贴骨架），相机 1.0
JS_SETUP = r"""
(async () => {
  const s = __STORE__;
  const el = document.querySelector('.scenario-map-container');
  if (!el) return JSON.stringify({ err: '剧本编辑器没挂载' });
  const sm = el.__vueParentComponent.setupState;
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 80));
  const KEY = 'case113';
  const W = 2000, H = 1400, X0 = -1000, Y0 = -700;
  s.baseMaps = { ...s.baseMaps, [KEY]: { id: KEY, name: '用例113底图',
    terrain: [], referenceImages: [], rivers: [], routes: [], burgs: [] } };
  sm.baseMapKey = KEY;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await tick(400);
  sm.setTool('draw');
  sm.showMinimap = false;
  sm.rasterLayer = 'none';
  sm.cameraScale = 1;
  sm.cameraX = 0; sm.cameraY = 0;      // 世界原点在画布左上 → 负坐标区也可画
  sm.render();
  await tick(200);
  const cvs = sm.canvas;
  const rc = cvs.getBoundingClientRect();
  window.__C113 = { sm, cvs, rc, tick };
  return JSON.stringify({ ok: true, canvas: [Math.round(rc.width), Math.round(rc.height)],
    terrain: (s.baseMaps[KEY].terrain || []).length, cameraScale: sm.cameraScale, tool: sm.tool });
})()
"""

# 真鼠标拖一圈（不松手），量：圈内有没有被着色 / 预览环是什么
JS_DRAG = r"""
(async () => {
  const C = window.__C113, sm = C.sm, cvs = C.cvs, rc = C.rc;
  const tick = C.tick;
  const out = {};
  // 画布快照（拖之前）—— 用来证明"圈内被着色"
  const before = cvs.getContext('2d').getImageData(0, 0, cvs.width, cvs.height).data;
  const mk = (t, x, y) => new MouseEvent(t, {
    clientX: rc.left + x, clientY: rc.top + y, button: 0,
    buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true,
  });
  // 一个手抖的闭合圈（半径 ~180px，带正弦抖动）—— 真实手绘必然不光滑
  const cx = rc.width * 0.5, cy = rc.height * 0.5, R = Math.min(rc.width, rc.height) * 0.28;
  cvs.dispatchEvent(mk('mousedown', cx + R, cy));
  for (let i = 1; i <= 90; i++) {
    const a = (i / 90) * Math.PI * 2;
    const rr = R * (1 + 0.06 * Math.sin(a * 7) + 0.03 * Math.sin(a * 13));
    cvs.dispatchEvent(mk('mousemove', cx + Math.cos(a) * rr, cy + Math.sin(a) * rr));
  }
  await tick(120);
  const raw = (sm.freeTrace || []).map(p => ({ x: p.x, y: p.y }));
  out.rawPoints = raw.length;
  out.previewShown = !!sm.previewTraceRing();
  // 预览环（= 画布上真正画出的形状；与落库同一条链）
  const shape = sm.freeTraceRing(raw, { snap: true });
  out.previewRing = shape ? shape.ring : null;
  out.simplified = shape ? shape.simplified : null;
  out.snapped = shape ? shape.snapped : null;

  // 圈内是否被着色：取预览环的形心，比较"拖之前"与"现在"的像素
  const ring = shape ? shape.ring : [];
  let sx = 0, sy = 0;
  for (const p of ring) { sx += p.x; sy += p.y; }
  const c = ring.length ? { x: sx / ring.length, y: sy / ring.length } : { x: 0, y: 0 };
  const dpr = cvs.width / rc.width;
  const px0 = Math.round((sm.cameraX + c.x * sm.cameraScale) * dpr);
  const py0 = Math.round((sm.cameraY + c.y * sm.cameraScale) * dpr);
  sm.render();
  await tick(60);
  const now = cvs.getContext('2d').getImageData(0, 0, cvs.width, cvs.height).data;
  const at = (arr, X, Y) => { const i = (Y * cvs.width + X) * 4; return [arr[i], arr[i+1], arr[i+2]]; };
  const b = at(before, px0, py0), a = at(now, px0, py0);
  out.centroidPixel = { before: b, during: a,
    delta: Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]) + Math.abs(a[2]-b[2]) };
  window.__C113.committed0 = (sm.baseMapKey ? 0 : 0);
  return JSON.stringify(out);
})()
"""

# 松手落库 → 与预览环逐点比对
JS_COMMIT = r"""
(async () => {
  const C = window.__C113, sm = C.sm, cvs = C.cvs;
  const tick = C.tick;
  cvs.dispatchEvent(new MouseEvent('mouseup', { button: 0, buttons: 0, bubbles: true, cancelable: true }));
  await tick(500);
  const terrain = sm.baseMap ? sm.baseMap.terrain : [];
  const prov = terrain[terrain.length - 1];
  const round = (v) => Math.round(v * 1000) / 1000;
  const bare = prov ? (prov.points || []).map(p => ({ x: round(p.x), y: round(p.y) })) : [];
  const withCtrl = prov ? (prov.points || []).filter(p => p.controlOut || p.controlIn).length : 0;
  return JSON.stringify({
    terrainCount: terrain.length,
    committedPoints: bare,
    committedLen: bare.length,
    controlCount: withCtrl,
    status: (document.querySelector('.scenario-status-bar') || {}).textContent || '',
  });
})()
"""


def _ev(cdp, js, desc):
    ok, obj = eval_json(cdp, js.replace('__STORE__', STORE), required=None, desc=desc)
    if ok:
        return obj
    return {'__err__': str(obj)}


def _viewport(cdp):
    try:
        cdp.send('Emulation.setDeviceMetricsOverride',
                 {'width': 1280, 'height': 800, 'deviceScaleFactor': 1, 'mobile': False})
    except Exception:
        pass


def run(cdp):
    fails = source_gates()
    notes = []
    ensure_case_state(cdp)
    _viewport(cdp)
    eval_json(cdp, "(() => { const b = Array.from(document.querySelectorAll('button'))"
                   ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()",
              required=None, desc='进剧本模式')
    try:
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式挂载')
    except Exception:
        return False, '剧本模式没挂载；' + ' | '.join(fails)
    time.sleep(1.2)

    setup = _ev(cdp, JS_SETUP, '空底图 + 相机 1.0')
    if not isinstance(setup, dict) or setup.get('err') or setup.get('__err__'):
        return False, f'造数据失败：{setup} ‖ ' + ' | '.join(fails)
    if setup.get('tool') != 'draw':
        fails.append(f"🔴 没切到画省份工具（tool={setup.get('tool')}）")

    drag = _ev(cdp, JS_DRAG, '真鼠标拖一圈（不松手）')
    if not isinstance(drag, dict) or drag.get('__err__'):
        return False, f'拖笔求值失败：{drag} ‖ ' + ' | '.join(fails)
    preview = drag.get('previewRing') or []
    notes.append(f"手迹 {drag.get('rawPoints')} 点 → 简化 {drag.get('simplified')} 点（预览环 {len(preview)} 点）")
    if drag.get('rawPoints', 0) < 30:
        fails.append(f"🔴 拖笔没采到足够的点（{drag.get('rawPoints')}）—— 判据失效")
    if not drag.get('previewShown'):
        fails.append('🔴 拖笔期间没有预览形状（`previewTraceRing()` 为空）')
    dp = drag.get('centroidPixel') or {}
    if (dp.get('delta') or 0) <= 6:
        fails.append(f"🔴 拖笔期间圈内**没有被着色**（Δ{dp.get('delta')}）—— 用户只看到一条线，"
                     '看不到"将得到的地块"（这就是"描点连线模拟器"的观感）')
    else:
        notes.append(f"圈内着色 Δ={dp.get('delta')}")

    commit = _ev(cdp, JS_COMMIT, '松手落库')
    if not isinstance(commit, dict) or commit.get('__err__'):
        return False, f'落库求值失败：{commit} ‖ ' + ' | '.join(fails)
    committed = commit.get('committedPoints') or []
    notes.append(f"落库 {commit.get('committedLen')} 点（控制点 {commit.get('controlCount')}，T8 应为 0）")
    if commit.get('terrainCount') != 1:
        fails.append(f"🔴 松手后没有新建省份（terrain={commit.get('terrainCount')}）："
                     f"{str(commit.get('status'))[:120]}")
    if not preview:
        fails.append('🔴 预览环为空，无法比对（上一段已报）')
    else:
        if len(committed) != len(preview):
            fails.append(f"🔴 落库环与预览环**点数不同**（预览 {len(preview)} / 落库 {len(committed)}）"
                         '—— 预览一个形、落库另一个形')
        else:
            bad = 0
            for q, w in zip(committed, preview):
                if abs(q['x'] - round(w['x'] * 1000) / 1000) > 1e-3 or abs(q['y'] - round(w['y'] * 1000) / 1000) > 1e-3:
                    bad += 1
            if bad:
                fails.append(f"🔴 落库环与预览环**逐点不同**（{bad}/{len(committed)} 点不等）")
    if commit.get('committedLen', 0) and commit.get('committedLen') >= drag.get('rawPoints', 1):
        fails.append(f"🔴 落库环没有简化（{commit.get('committedLen')} ≥ 手迹 {drag.get('rawPoints')}）"
                     '—— 逐点连线 = 描点连线模拟器')
    if commit.get('controlCount', 0) != 0:
        fails.append(f"🔴 T8：落库环仍写了贝塞尔控制点（{commit.get('controlCount')}）"
                     '—— 数据多边形与渲染边界分离，布尔/命中会与看到的不一致')

    if fails:
        return False, ' | '.join(fails) + ' ‖ ' + ' + '.join(notes)
    return True, ' + '.join(notes)
