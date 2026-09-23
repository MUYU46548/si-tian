#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 61：历史剧本（底图编辑）进入/编辑性能与「空白陷阱」回归（P-0 修复的守卫）

P-0 实测结论（2026-09-22，真实库 desite 21 省 25930 点）：
  1. 「打开底图编辑卡住」= 点击即 113~148ms 同步 JS + 挂载期一次 367~446ms 长任务（rAF 停摆 381~449ms）
  2. 「画布像空的」   = **首帧用的是未适屏相机 (0,0,1)**：非背景像素仅 7%（只剩底网格），
                       适屏帧要等 `setTimeout(fitToView, 100)` 才来（+684ms）
  3. 「滚轮才刷新」   = 画布纯事件驱动；漏掉的那次 render 会一直留在屏幕上
  4. 「未知原因卡死」 = `baseMapKey` 只在 onMounted 解析一次 → 底图数据晚到（或只读被闸门拒绝）时
                       `baseMap` 恒 undefined → 任何 watch 都不触发 → **画布永久空白**（实测 0 帧重绘）
  5. 「绘制很卡」     = 单帧 render 94ms（Vue 响应式 get 27% + traceShapePath 18% + 每帧重画小地图 16%）；
                       拖动平移 20 步 1906ms
  6. 「打开省份工具一顿」= `setTool('provinceBrush')` 现场栅格化 170~368ms

本用例守这六条的修复（每条一个子测试）：
  a 源码闸门：绘制走 toRaw（rawTerrain/rawPointsOf）、小地图缓存、网格异步、底图晚到自动选中
  b 首帧即适屏（帧时相机 ≠ (0,0,1)，且画布非空）
  c 底图数据晚到 → 自动选中 + 适屏 + 出现内容（不再永久空白）
  d 空态文案区分「只读（未打开项目）」与「项目里还没有底图」
  e 帧成本：21 省 25200 点，单帧中位 ≤ 40ms；平移 20 步 ≤ 900ms
  f setTool('provinceBrush') 不再同步冻结（调用 ≤ 60ms），网格随后异步就绪
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for  # noqa: E402
from lib import helpers as H  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"

FRAME_MED_LIMIT = 25       # 单帧 render 中位上限（P-0 旧实现同规模实测 ≈94ms；修复后 ≈0.8ms）
PAN_LIMIT = 400            # 平移 20 步上限（旧实现实测 1906ms；修复后 ≈16ms）
SETTOOL_LIMIT = 60         # setTool 同步耗时上限（旧实现现场栅格化实测 170~368ms）
N_PROV = 21                # 与真实库 desite 同规模
N_PTS = 1200               # 21 × 1200 = 25200 点


def _js(cdp, expr):
    raw = cdp.eval(expr)
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except ValueError:
            return {'raw': raw[:300]}
    if isinstance(raw, dict) and '__err__' in raw:
        return {'ERR': str(raw['__err__'])[:300]}
    return {'raw': raw}


# 画布「有内容」的判据：只有底网格的空画布实测 colors≈46 / nonBg≈328（P-0），
# 有省份时 colors≥100 / nonBg≥600。判据太松会让性能断言量到一个空画布（本用例踩过）。
EMPTY_COLORS, EMPTY_NONBG = 46, 328


def _canvas_has_content(cdp, colors_min=100, nonbg_min=600):
    px = _js(cdp, PIX)
    if 'ERR' in px:
        return False, px
    okc = px.get('colors', 0) >= colors_min and px.get('nonBg', 0) >= nonbg_min
    return okc, px


def _code_only(src):
    out, in_block = [], False
    for line in src.splitlines():
        s = line.strip()
        if in_block:
            if '*/' in s:
                in_block = False
            continue
        if s.startswith('/*'):
            if '*/' not in s:
                in_block = True
            continue
        if s.startswith('//') or s.startswith('*'):
            continue
        out.append(line)
    return '\n'.join(out)


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


# ── 帧记录钩子：每次可见帧记下「当时的相机」——首帧是否适屏只能这样测 ──
FRAME_HOOK = r"""
(() => {
  if (window.__frameLog) { window.__frameLog.length = 0; return 'ok'; }
  window.__frameLog = [];
  const orig = CanvasRenderingContext2D.prototype.clearRect;
  CanvasRenderingContext2D.prototype.clearRect = function () {
    try {
      const cv = this.canvas;
      if (cv && cv.parentElement && String(cv.parentElement.className).indexOf('scenario-canvas-wrap') >= 0) {
        let cam = null;
        const el = document.querySelector('.scenario-map-container');
        if (el) {
          let n = el;
          while (n && !n.__vueParentComponent) n = n.parentElement;
          if (n) { const sc = n.__vueParentComponent.setupState; cam = [sc.cameraX, sc.cameraY, sc.cameraScale]; }
        }
        window.__frameLog.push({ t: Math.round(performance.now()), w: cv.width, h: cv.height, cam });
      }
    } catch (e) {}
    return orig.apply(this, arguments);
  };
  return 'ok';
})()
"""

PIX = r"""JSON.stringify((() => {
  const cvs = document.querySelector('.scenario-canvas-wrap canvas');
  if (!cvs || !cvs.width) return { err: 'no-canvas' };
  const s = document.createElement('canvas'); s.width = 96; s.height = 48;
  const c = s.getContext('2d');
  c.drawImage(cvs, 0, 0, cvs.width, cvs.height, 0, 0, 96, 48);
  const d = c.getImageData(0, 0, 96, 48).data;
  const colors = new Set(); let nonBg = 0;
  const bg = [26, 42, 58];
  for (let i = 0; i < d.length; i += 4) {
    colors.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 24) nonBg++;
  }
  return { colors: colors.size, nonBg: nonBg };
})())"""

# 挂载**之前**就把底图准备好（store 级 fixture，不依赖组件）
PRE_FIXTURE = r"""
(() => {
  const s = __STORE__;
  const KEY = 'case61';
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: '用例61底图' });
  const terrain = [];
  for (let k = 0; k < __NPROV__; k++) {
    const cx = -900 + (k % 6) * 320, cy = -500 + Math.floor(k / 6) * 320;
    const pts = [];
    for (let i = 0; i < __NPTS__; i++) {
      const a = i / __NPTS__ * Math.PI * 2;
      const rad = 130 * (1 + 0.22 * Math.sin(a * 3 + k) + 0.1 * Math.sin(a * 7 + k * 2));
      pts.push({ x: Math.round((cx + Math.cos(a) * rad) * 10) / 10, y: Math.round((cy + Math.sin(a) * rad * 0.7) * 10) / 10 });
    }
    terrain.push({ id: 'c61_p' + k, name: '用例61省' + k, points: pts, biome: 'temperate', coast: false });
  }
  s.baseMaps = { ...s.baseMaps, [KEY]: { ...s.baseMaps[KEY], terrain } };
  const t0 = performance.now();
  s.ensureProvinceGrid(KEY);
  return JSON.stringify({ key: KEY, terrain: terrain.length,
                          points: terrain.reduce((a, p) => a + p.points.length, 0),
                          gridMs: Math.round(performance.now() - t0) });
})()
"""

SC_STATE = r"""JSON.stringify((() => {
  const sc = __SC__, s = __STORE__;
  const hint = document.querySelector('[data-testid="scenario-empty-hint"]');
  const cvs = document.querySelector('.scenario-canvas-wrap canvas');
  return {
    key: sc.baseMapKey,
    terrain: sc.baseMap ? sc.baseMap.terrain.length : null,
    cam: [Math.round(sc.cameraX), Math.round(sc.cameraY), Math.round(sc.cameraScale * 1000) / 1000],
    readOnly: s.isReadOnly,
    hintText: hint ? hint.textContent.replace(/\s+/g, ' ').trim().slice(0, 80) : null,
    cvs: cvs ? [cvs.width, cvs.height] : null,
    renderPaused: sc.renderPaused,
  };
})())"""

ADD_BASEMAP_LATER = r"""
(() => {
  const s = __STORE__;
  const KEY = 'case61_late';
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: '用例61迟到底图' });
  const terrain = [];
  for (let k = 0; k < 4; k++) {
    const cx = -400 + (k % 2) * 400, cy = -200 + Math.floor(k / 2) * 400;
    const pts = [];
    for (let i = 0; i < 300; i++) {
      const a = i / 300 * Math.PI * 2;
      const rad = 150 * (1 + 0.18 * Math.sin(a * 3 + k));
      pts.push({ x: Math.round((cx + Math.cos(a) * rad) * 10) / 10, y: Math.round((cy + Math.sin(a) * rad) * 10) / 10 });
    }
    terrain.push({ id: 'c61l_p' + k, name: '迟到省' + k, points: pts });
  }
  s.baseMaps = { ...s.baseMaps, [KEY]: { ...s.baseMaps[KEY], terrain } };
  return JSON.stringify({ key: KEY, keys: Object.keys(s.baseMaps) });
})()
"""

WIDE_FIXTURE = r"""
(() => {
  const s = __STORE__;
  const KEY = 'case61_wide';
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: '用例61宽域底图' });
  const terrain = [];
  for (let k = 0; k < 21; k++) {
    const cx = -2700 + (k % 6) * 1080, cy = -1600 + Math.floor(k / 6) * 1080;
    const pts = [];
    for (let i = 0; i < 200; i++) {
      const a = i / 200 * Math.PI * 2;
      const rad = 320 * (1 + 0.2 * Math.sin(a * 3 + k));
      pts.push({ x: Math.round((cx + Math.cos(a) * rad) * 10) / 10, y: Math.round((cy + Math.sin(a) * rad) * 10) / 10 });
    }
    terrain.push({ id: 'c61w_p' + k, name: '宽域省' + k, points: pts });
  }
  s.baseMaps = { ...s.baseMaps, [KEY]: { ...s.baseMaps[KEY], terrain } };
  // 故意**不**预建网格：本 fixture 用来测「切省份工具时现场栅格化」的同步代价
  return JSON.stringify({ key: KEY, terrain: terrain.length, gridReady: !!s.getProvinceGrid(KEY) });
})()
"""

SWITCH_BASEMAP = r"""JSON.stringify((() => {
  const sc = __SC__, s = __STORE__;
  sc.setTool('select');
  sc.showProvinceMesh = false;
  sc.baseMapKey = __KEY__;
  return { key: sc.baseMapKey, terrain: sc.baseMap ? sc.baseMap.terrain.length : null,
           meshOn: sc.provinceMeshOn, gridReady: !!s.getProvinceGrid(sc.baseMapKey) };
})())"""

FRAME_COST = r"""JSON.stringify((() => {
  const sc = __SC__;
  const ts = [];
  for (let i = 0; i < 10; i++) {
    const a = performance.now();
    sc.render();
    ts.push(performance.now() - a);
  }
  const sorted = ts.slice().sort((x, y) => x - y);
  return { median: Math.round(sorted[5] * 10) / 10, min: Math.round(sorted[0] * 10) / 10,
           max: Math.round(sorted[9] * 10) / 10, all: ts.map(v => Math.round(v * 10) / 10) };
})())"""

PAN_DRAG = r"""JSON.stringify((() => {
  const sc = __SC__;
  const cvs = document.querySelector('.scenario-canvas-wrap canvas');
  const r = cvs.getBoundingClientRect();
  const mk = (t, x, y) => new MouseEvent(t, { clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true, button: 0 });
  sc.setTool('select');
  const t0 = performance.now();
  cvs.dispatchEvent(mk('mousedown', 300, 150));
  for (let i = 0; i < 20; i++) cvs.dispatchEvent(mk('mousemove', 300 + i * 12, 150 + i * 4));
  cvs.dispatchEvent(mk('mouseup', 540, 230));
  const ms = performance.now() - t0;
  return { pan_ms: Math.round(ms * 10) / 10, cam: [Math.round(sc.cameraX), Math.round(sc.cameraY)] };
})())"""

SET_TOOL = r"""JSON.stringify((() => {
  const sc = __SC__, s = __STORE__;
  const t0 = performance.now();
  sc.setTool('provinceBrush');
  const ms = performance.now() - t0;
  return { ms: Math.round(ms * 10) / 10, mesh: sc.showProvinceMesh,
           gridReadyNow: !!s.getProvinceGrid(sc.baseMapKey) };
})())"""


def run(cdp):
    fails = []
    notes = []

    # ── a. 源码闸门（剥注释后判定）───────────────────────────────────────────
    try:
        code = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
        for tok in ('rawTerrain', 'rawPointsOf', 'toRaw'):
            if tok not in code:
                fails.append(f'绘制路径未去响应式（缺 {tok}）→ 单帧又会回到 ~94ms')
        for tok in ('invalidateMinimap', 'buildMinimapThumb', 'getMinimapEntry'):
            if tok not in code:
                fails.append(f'小地图缓存缺失（{tok}）→ 每帧两次全量遍历 25930 点')
        if 'getMinimapWorldBounds' in code:
            fails.append('旧的小地图包围盒函数还在（每帧全量遍历）→ 应已由 getMinimapEntry 的缓存取代')
        if 'scheduleProvinceGrid' not in code:
            fails.append('省份网格未改异步（scheduleProvinceGrid）→ 打开省份工具仍会冻结 170~368ms')
        if 'watch(availableBaseMaps' not in code:
            fails.append('底图数据晚到时不会自动选中（缺 watch(availableBaseMaps)）→ 画布永久空白')
        if 'fitToView();' not in code:
            fails.append('onMounted 未「先算镜位再画首帧」→ 首帧又是 (0,0,1) 空画布')
    except OSError as e:
        fails.append(f'读不到 ScenarioMap.vue（{e}）')
        return False, ' | '.join(fails)

    # ── b. 首帧即适屏（挂载前就备好底图）─────────────────────────────────────
    cdp.eval(FRAME_HOOK)
    fx = _js(cdp, PRE_FIXTURE.replace('__STORE__', STORE)
             .replace('__NPROV__', str(N_PROV)).replace('__NPTS__', str(N_PTS)))
    if 'ERR' in fx:
        fails.append(f'预置底图 fixture 失败：{fx["ERR"]}')
        return False, ' | '.join(fails)
    notes.append(f'fixture: {fx["terrain"]} 省 / {fx["points"]} 点（栅格化 {fx["gridMs"]}ms）')

    cdp.eval(FRAME_HOOK)      # 清空帧记录
    cdp.eval("""(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent || '').includes('历史剧本'));
      if (b) b.click(); return 'ok';
    })()""")
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式挂载')
    time.sleep(1.2)

    frames = _js(cdp, "JSON.stringify(window.__frameLog || [])")
    if 'ERR' in frames or not frames:
        fails.append(f'帧记录为空（帧钩子没生效或首帧没画）：{frames}')
    else:
        first = frames[0]
        cam = first.get('cam')
        if not cam:
            fails.append('首帧记不到相机（帧钩子与组件挂载顺序异常）')
        elif abs(cam[2] - 1) < 1e-9 and abs(cam[0]) < 1e-9 and abs(cam[1]) < 1e-9:
            fails.append(f'首帧仍是未适屏相机 (0,0,1) → 打开底图编辑的第一眼是空画布（帧 {first}）')
        else:
            notes.append(f'首帧相机 {cam}（已适屏，非 (0,0,1)）/ 位图 {first["w"]}x{first["h"]}')
        # 首帧之后画布必须有内容（不是只有底网格）
        has, px = _canvas_has_content(cdp)
        if 'ERR' in px:
            fails.append(f'像素探针失败：{px["ERR"]}')
        elif not has:
            fails.append(f'进入后画布几乎空白（非背景像素 {px.get("nonBg")}/4608，{px.get("colors")} 色；'
                         f'空画布基线 {EMPTY_NONBG}/{EMPTY_COLORS}）')
        else:
            notes.append(f'进入后画布非背景像素 {px["nonBg"]}/4608，{px["colors"]} 色')

    st = _js(cdp, SC_STATE.replace('__SC__', SC).replace('__STORE__', STORE))
    if 'ERR' in st:
        fails.append(f'状态探针失败：{st["ERR"]}')
    else:
        if st['key'] != 'case61':
            fails.append(f'挂载时没有自动选中已有底图（key={st["key"]}）')
        if st['hintText']:
            fails.append(f'有底图却还显示空态提示：{st["hintText"]}')
        if st['renderPaused']:
            fails.append('渲染护栏处于暂停态（渲染路径抛异常了）')

    # ── c. 底图数据「迟到」→ 必须自动选中 + 适屏 + 出内容 ────────────────────
    #    先在空底图状态进入剧本模式，再补数据（复刻只读被拒后补救 / 项目里后来才有底图）
    cdp.eval(STORE + ".baseMaps = {}; 'ok'")
    cdp.eval("""(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent || '').includes('返回'));
      if (b) b.click(); return 'ok';
    })()""")
    time.sleep(0.6)
    cdp.eval(FRAME_HOOK)
    cdp.eval("""(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent || '').includes('历史剧本'));
      if (b) b.click(); return 'ok';
    })()""")
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='空底图剧本模式挂载')
    time.sleep(0.8)
    empty = _js(cdp, SC_STATE.replace('__SC__', SC).replace('__STORE__', STORE))
    if 'ERR' in empty:
        fails.append(f'空底图状态探针失败：{empty["ERR"]}')
    elif not empty['readOnly'] and '还没有底图' not in (empty['hintText'] or ''):
        fails.append(f'可写态空底图的提示文案不对：{empty["hintText"]}')

    late = _js(cdp, ADD_BASEMAP_LATER.replace('__STORE__', STORE))
    if 'ERR' in late:
        fails.append(f'迟到底图 fixture 失败：{late["ERR"]}')
    else:
        ok_late = False
        for _ in range(12):
            time.sleep(0.15)
            s2 = _js(cdp, SC_STATE.replace('__SC__', SC).replace('__STORE__', STORE))
            if 'ERR' in s2:
                continue
            has2, px2 = _canvas_has_content(cdp, colors_min=60, nonbg_min=400)
            if s2['key'] == 'case61_late' and has2:
                ok_late = True
                notes.append(f'迟到底图 1.8s 内自动选中并出内容（key={s2["key"]}，非背景像素 {px2["nonBg"]}）')
                break
        if not ok_late:
            s2 = _js(cdp, SC_STATE.replace('__SC__', SC).replace('__STORE__', STORE))
            fails.append(f'底图数据晚到后没有自动渲染（key={s2.get("key")} hint={s2.get("hintText")}）→ 画布永久空白')

    # ── d. 省份网格：切工具不许同步栅格化（旧实现 170~368ms 冻结），且等待期不空白 ──
    wide = _js(cdp, WIDE_FIXTURE.replace('__STORE__', STORE))
    if 'ERR' in wide:
        fails.append(f'宽域 fixture 失败：{wide["ERR"]}')
    else:
        sw = _js(cdp, SWITCH_BASEMAP.replace('__SC__', SC).replace('__STORE__', STORE)
                  .replace('__KEY__', "'case61_wide'"))
        if 'ERR' in sw:
            fails.append(f'切底图探针失败：{sw["ERR"]}')
        elif sw['gridReady']:
            fails.append('宽域 fixture 意外预建了网格 → setTool 的异步断言会失去意义')
        else:
            tool = _js(cdp, SET_TOOL.replace('__SC__', SC).replace('__STORE__', STORE))
            if 'ERR' in tool:
                fails.append(f'setTool 探针失败：{tool["ERR"]}')
            else:
                if tool['ms'] >= SETTOOL_LIMIT:
                    fails.append(f"setTool('provinceBrush') 同步耗时 {tool['ms']}ms ≥ {SETTOOL_LIMIT}ms"
                                 f"（旧实现现场栅格化 170~368ms）")
                if not tool['mesh']:
                    fails.append('切到省份笔刷后没有开网格视图')
                px_wait = _js(cdp, PIX)
                if 'ERR' not in px_wait and (px_wait.get('nonBg', 0) < 400 or px_wait.get('colors', 0) < 60):
                    fails.append(f'网格尚未就绪时画布变空了（非背景像素 {px_wait.get("nonBg")}，'
                                 f'{px_wait.get("colors")} 色）→ 应退回多边形渲染')
                ready = False
                for _ in range(14):
                    time.sleep(0.15)
                    g = _js(cdp, "JSON.stringify(!!%s.getProvinceGrid('case61_wide'))" % STORE)
                    if g is True:
                        ready = True
                        break
                mesh_on = _js(cdp, 'JSON.stringify(' + SC + '.provinceMeshOn)')
                if not ready:
                    fails.append('省份网格异步补建后 2s 内仍未就绪（网格视图会一直显示多边形）')
                if mesh_on is not True:
                    fails.append(f'网格就绪后 provinceMeshOn 仍为 {mesh_on} → 网格视图打不开（响应式未触发）')
                notes.append(f"setTool('provinceBrush') 同步 {tool['ms']}ms（旧实现 170~368ms），"
                             f"异步就绪={ready}，就绪后 meshOn={mesh_on}")

    # ── e. 帧成本 / 平移（21 省 25200 点，与真实库同规模）─────────────────────
    #    注意：case c 已经把 baseMaps 清空过，这里必须重新播种并**核对真的切过去了**
    #    （本用例第一版就踩了：切到一张不存在的底图 → baseMap undefined → 量的是空画布）
    _js(cdp, PRE_FIXTURE.replace('__STORE__', STORE)
        .replace('__NPROV__', str(N_PROV)).replace('__NPTS__', str(N_PTS)))
    sw2 = _js(cdp, SWITCH_BASEMAP.replace('__SC__', SC).replace('__STORE__', STORE)
              .replace('__KEY__', "'case61'"))
    if 'ERR' in sw2:
        fails.append(f'切回大规模底图失败：{sw2["ERR"]}')
    elif sw2.get('key') != 'case61' or sw2.get('terrain') != N_PROV:
        fails.append(f'没切到大规模底图（key={sw2.get("key")} terrain={sw2.get("terrain")}）→ 性能断言会量到空画布')
    time.sleep(0.6)
    has_big, px_big = _canvas_has_content(cdp)
    if not has_big:
        fails.append(f'大规模底图画布为空或过稀（{px_big}）→ 性能断言失去意义')

    cost = _js(cdp, FRAME_COST.replace('__SC__', SC))
    if 'ERR' in cost:
        fails.append(f'帧成本探针失败：{cost["ERR"]}')
    else:
        if cost['median'] >= FRAME_MED_LIMIT:
            fails.append(f'单帧 render 中位 {cost["median"]}ms ≥ {FRAME_MED_LIMIT}ms（P-0 旧实现同规模 94ms）')
        notes.append(f'单帧 render 中位 {cost["median"]}ms（min {cost["min"]} / max {cost["max"]}，'
                     f'{fx["points"]} 点，旧实现 94ms）')

    pan = _js(cdp, PAN_DRAG.replace('__SC__', SC))
    if 'ERR' in pan:
        fails.append(f'平移探针失败：{pan["ERR"]}')
    else:
        if pan['pan_ms'] >= PAN_LIMIT:
            fails.append(f'平移 20 步 {pan["pan_ms"]}ms ≥ {PAN_LIMIT}ms（P-0 旧实现实测 1906ms）')
        notes.append(f'平移 20 步 {pan["pan_ms"]}ms（旧实现 1906ms）')

    # ── f. 只读态（未打开项目）：底图进不来必须说清原因与去处，不能只是空白 ──────────
    #    P-0 实测：只读态下 importFromScenariosJson 被 guardWrite 拒绝 → baseMaps 空 →
    #    画布空白。用户看到「打开底图编辑什么都没有」，必须知道是「没开项目」而不是「程序卡了」。
    cdp.navigate()
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='只读态导航')
    cdp.send('Emulation.setDeviceMetricsOverride',
             {'width': 1280, 'height': 800, 'deviceScaleFactor': 1, 'mobile': False})
    cdp.eval("localStorage.setItem('sitian-first-run-complete','true')")
    cdp.navigate()
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='只读态重载')
    cdp.send('Emulation.setDeviceMetricsOverride',
             {'width': 1280, 'height': 800, 'deviceScaleFactor': 1, 'mobile': False})
    wait_for(cdp, "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
             timeout=45, desc='只读态数据就绪')
    time.sleep(0.5)
    cdp.eval("""(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent || '').includes('历史剧本'));
      if (b) b.click(); return 'ok';
    })()""")
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='只读态剧本模式挂载')
    time.sleep(0.8)
    ro = _js(cdp, SC_STATE.replace('__SC__', SC).replace('__STORE__', STORE))
    if 'ERR' in ro:
        fails.append(f'只读态探针失败：{ro["ERR"]}')
    elif not ro['readOnly']:
        fails.append('只读态用例没有跑在「未打开项目」状态（readOnly=false）')
    else:
        txt = ro['hintText'] or ''
        if '只读' not in txt:
            fails.append(f'只读态空画布没有说明「只读」：{txt}')
        if '项目' not in txt:
            fails.append(f'只读态空画布没有给出去处（去哪打开项目）：{txt}')
        if '还没有底图' in txt:
            fails.append(f'只读态误用了可写态文案：{txt}')
        notes.append(f'只读态提示：{txt}')

    if fails:
        return False, ' | '.join(fails)
    return True, '；'.join(notes)
