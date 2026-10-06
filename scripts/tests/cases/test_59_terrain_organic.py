#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 59：行星地图「地形绘制」的有机轮廓渲染（反马赛克闸门）

用户实测原话：「行星地图的绘制功能不太好，依然是马赛克方块填色（地形），不是自然的笔刷」。
CDP 实测归因（scale=1.0、画布 900×600 唯一色数）：
    全开 7458 → 关掉 terrain 层 717   （旧实现）
    全开 2651 → 关掉 terrain 层 717   （新实现）
两个来源，缺一不可：
  ① 地形涂色网格：逐格 roundRect + 5 档噪点抖动 → 改成「格边界抽平滑闭合环（gridOutline）→ 一次 fill」
  ② 地形多边形纹理：64×64 瓦片里撒上百个 Math.random 小斑点（alpha 0.7）→ 改成确定性大尺度柔和底纹（alpha 0.45）

验收点（每条对应一个真实症状或必须守住的约束）：
1. 网格渲染不再逐格画（源码零 roundRect/噪点档；改走 gridOutline）
2. 地形纹理确定性（textures.js 零 Math.random）+ 叠加强度 ≤ 0.5
3. 画布噪声闸门：terrain 层贡献的唯一色数 < 3500（旧实现 6741）
4. 连续色块的轮廓不碎（7 块有机色块 → 环数 ≤ 40），且重建耗时 < 60ms
5. 真实笔刷：拖动真的写入格子、轮廓环数 > 0、一次拖动 = 一条 undo
6. 轮廓缓存纪律：数据未变时不重建（重复渲染 rev 不变）；改动数据后必须重建（rev 递增）
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for  # noqa: E402
from lib.helpers import A, drag_canvas_polyline, enter_edit, goto_planet, set_pm_state  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))

PM = "document.querySelector('.planet-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
EMPTY_TERRAIN = 255
GRID_JUNK_LIMIT = 3500   # terrain 层对画布唯一色数的贡献上限（旧实现实测 6741）
LOOP_LIMIT = 40          # 7 块连片色块应产出的环数上限


def _js(cdp, code):
    return json.loads(cdp.eval(code))


def _uniq(cdp):
    return _js(cdp, f"""(() => {{
      const c = document.querySelector('.canvas-wrapper canvas');
      const g = c.getContext('2d');
      const w = Math.min(c.width, 900), h = Math.min(c.height, 600);
      const d = g.getImageData(0, 0, w, h).data;
      const set = new Set();
      for (let i = 0; i < d.length; i += 4) set.add((d[i] << 16) | (d[i+1] << 8) | d[i+2]);
      return JSON.stringify({{ uniq: set.size, scale: {PM}.renderer.viewTransform.scale }});
    }})()""")['uniq']


def _set_layers(cdp, grid, layer):
    """`layer` = **地形多边形**是否显示。

    M2/A2 第二步随动：`terrain[]` 已降为**可选覆盖物** —— 有高度图的行星上，「地形」总开关
    现在渲染的是**高度图**，多边形只在「多边形」图层打开时出现。本用例测的是**多边形本身**
    的有机轮廓/纹理质量，所以：
      · 关掉「地形」总开关（不让高度图盖在上面）
      · 用「多边形」图层控制开关 → 此时多边形是唯一地形显示 = **实色不透明，与从前一致**
    """
    return cdp.eval(f"""(() => {{
      const pm = {PM};
      pm.terrainCanvasBrush.terrainGridEnabled.value = {str(grid).lower()};
      if (pm.layers.layers.planet['terrain'].visible) pm.layers.toggleLayer('planet', 'terrain');
      if (pm.layers.layers.planet['terrainPolygons'].visible !== {str(layer).lower()}) pm.layers.toggleLayer('planet', 'terrainPolygons');
      pm.renderer.requestRender();
      return 'ok';
    }})()""")


def _stats(cdp):
    return _js(cdp, f"""(() => {{
      const b = {PM}.terrainCanvasBrush;
      const s = b.outlineStats();
      const g = b.terrainGrid.value; let painted = 0;
      for (let i = 0; i < g.length; i++) if (g[i] !== {EMPTY_TERRAIN}) painted++;
      return JSON.stringify({{ loops: s.loops, pts: s.pts, cost: +s.cost.toFixed(1), rev: s.rev, painted }});
    }})()""")


def _code_only(src):
    """去掉整行注释与块注释，只留代码行。

    🔴 判据必须只看代码：本文件第一版就踩了同一个坑——textures.js 的注释里写着
    「旧实现用 `Math.random()`」，子串判据立刻把注释当成违规（skill §126/§139.9 记过两次）。
    这里用带状态的逐行扫描而不是正则一把梭：正则会被源码里的正则字面量骗到（§123 实测吃错 140 行）。
    """
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


def _read_src(rel):
    """直接读磁盘上的源码。

    🔴 不要用 `fetch('/src/xxx.js?raw')` 做「按行/按注释」的静态判据：
    Vite 有时会返回**转换后的模块**（体积是源文件的 6~7 倍，里面还嵌了一份原始源码），
    注释与换行结构都不可靠 —— 本用例实测「单跑通过、全量跑红」就是这个原因（同一判据两种结果）。
    只做子串判断的用例（如 test_53 的 px() 计数）不受影响，需要行结构的必须直接读盘。
    """
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def run(cdp):
    fails = []

    # ── 1/2. 源码静态闸门（读磁盘 + 只剥注释后的代码行） ────────────────────
    try:
        brush_src = _read_src('src/renderer/src/composables/useTerrainCanvasBrush.js')
        code = _code_only(brush_src)
        if 'buildLabelOutlines' not in code:
            fails.append('地形网格未走矢量轮廓（useTerrainCanvasBrush 未引用 gridOutline）')
        if 'roundRect' in code:
            fails.append('地形网格仍逐格 roundRect 绘制（马赛克来源）')
    except OSError as e:
        fails.append(f'读不到 useTerrainCanvasBrush.js（{e}）')

    try:
        tcode = _code_only(_read_src('src/renderer/src/utils/textures.js'))
        if 'Math.random(' in tcode:
            fails.append('textures.js 又出现 Math.random（纹理不可复现，画面会随重建抖动）')
        if 'makeRng' not in tcode:
            fails.append('textures.js 缺确定性 PRNG')
    except OSError as e:
        fails.append(f'读不到 textures.js（{e}）')

    try:
        dcode = _code_only(_read_src('src/renderer/src/composables/planetDrawing.js'))
        # M2/A2 第二步：多边形可能以**半透明覆盖物**身份出现（叠在高度图上），
        # 纹理叠加强度必须随整体 alpha 一起缩放 —— 基准仍是 0.45。
        # ⚠️ 判据要求「乘以 alpha」，不是「等于 0.45」：只写裸 0.45 时，
        #    覆盖物淡下去了、纹理却还是原强度 → 覆盖物看起来比底色"更实"（观感不一致）。
        if 'ctx.globalAlpha = 0.45 * alpha;' not in dcode:
            fails.append('地形纹理叠加强度未随 alpha 缩放（基准应保持 0.45）')
        if 'ctx.globalAlpha = 0.45;' in dcode:
            fails.append('地形纹理叠加强度写成了裸 0.45（覆盖物半透明时纹理会比底色更实）')
    except OSError as e:
        fails.append(f'读不到 planetDrawing.js（{e}）')

    try:
        if 'buildLabelOutlines' not in _code_only(_read_src('src/renderer/src/utils/gridOutline.js')):
            fails.append('gridOutline.js 未就位')
    except OSError as e:
        fails.append(f'读不到 gridOutline.js（{e}）')

    # ── 导航到行星 + 编辑模式 ──────────────────────────────────────────────
    r = goto_planet(cdp, A('曜川星'))
    if r != 'planet':
        return False, f'导航行星失败 ({r})'
    time.sleep(1.2)

    # ── 3. 画布噪声闸门（terrain 层贡献的唯一色数） ────────────────────────
    cdp.eval(f"{PM}.renderer.focusOn(0, 0, 1.0); {PM}.renderer.requestRender(); 'ok'")
    time.sleep(0.6)
    _set_layers(cdp, True, True)
    time.sleep(0.6)
    uniq_on = _uniq(cdp)
    _set_layers(cdp, True, False)
    time.sleep(0.6)
    uniq_off = _uniq(cdp)
    _set_layers(cdp, True, True)
    time.sleep(0.4)
    delta = uniq_on - uniq_off
    detail_noise = f'terrain 层噪声贡献 {delta} 色（全开 {uniq_on} / 关闭 {uniq_off}，上限 {GRID_JUNK_LIMIT}）'
    if delta >= GRID_JUNK_LIMIT:
        fails.append(detail_noise + ' → 仍像马赛克')

    # ── 4. 连续色块 → 环数不碎 + 重建耗时 ─────────────────────────────────
    blob = _js(cdp, f"""(() => {{
      const b = {PM}.terrainCanvasBrush;
      const g = b.terrainGrid.value, W = b.gridWidth.value, H = b.gridHeight.value;
      g.fill({EMPTY_TERRAIN});
      const blobs = [
        [W*0.30, H*0.35, W*0.16, H*0.22, 2], [W*0.36, H*0.30, W*0.09, H*0.12, 3],
        [W*0.62, H*0.60, W*0.14, H*0.20, 5], [W*0.66, H*0.55, W*0.07, H*0.09, 6],
        [W*0.20, H*0.72, W*0.10, H*0.14, 4], [W*0.48, H*0.70, W*0.09, H*0.12, 1],
        [W*0.78, H*0.30, W*0.07, H*0.09, 7],
      ];
      for (const [cx, cy, rx, ry, tp] of blobs) {{
        for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {{
          const dx = (c - cx) / rx, dy = (r - cy) / ry;
          const ang = Math.atan2(dy, dx);
          const wob = 1 + 0.22 * Math.sin(ang * 3.1 + cx * 0.013) + 0.16 * Math.sin(ang * 5.3 + cy * 0.017);
          if (Math.sqrt(dx*dx + dy*dy) < wob) g[r * W + c] = tp;
        }}
      }}
      b.invalidateTerrainOutline(true);
      {PM}.renderer.requestRender();
      return JSON.stringify({{ ok: true }});
    }})()""")
    time.sleep(0.8)
    st = _stats(cdp)
    detail_loops = f'连续 7 块 → {st["loops"]} 环 / {st["pts"]} 点 / 重建 {st["cost"]}ms'
    if not blob.get('ok') or st['loops'] <= 0:
        fails.append('轮廓环数为 0（渲染管线断了）')
    elif st['loops'] > LOOP_LIMIT:
        fails.append(f'{detail_loops} → 连片色块被碎成过多环')
    if st['cost'] >= 60:
        fails.append(f'轮廓重建 {st["cost"]}ms 过慢（交互中会掉帧）')

    # ── 6. 轮廓缓存纪律：未变不重建 / 变了必重建 ─────────────────────────
    rev0 = _stats(cdp)['rev']
    cdp.eval(f"{PM}.renderer.requestRender(); 'ok'")
    time.sleep(0.4)
    rev1 = _stats(cdp)['rev']
    if rev1 != rev0:
        fails.append(f'数据未变却重建了轮廓（rev {rev0} → {rev1}）')
    cdp.eval(f"""(() => {{
      const b = {PM}.terrainCanvasBrush;
      b.terrainGrid.value[0] = 2;
      b.invalidateTerrainOutline(true);
      {PM}.renderer.requestRender();
      return 'ok';
    }})()""")
    time.sleep(0.5)
    rev2 = _stats(cdp)['rev']
    if rev2 == rev1:
        fails.append(f'数据改动后未重建轮廓（rev 停在 {rev2}）')

    # ── 5. 真实笔刷：写入 + 一条 undo ────────────────────────────────────
    if enter_edit(cdp) != 'ok':
        return False, '进入编辑模式失败'
    time.sleep(0.6)
    set_pm_state(cdp, "pm.setInteractionMode && pm.setInteractionMode('terrain');"
                      "pm.terrainBrushType = 3; pm.terrainBrushSize = 10; true")
    time.sleep(0.4)
    before = _stats(cdp)['painted']
    hist0 = _js(cdp, f"""(() => {{
      return import('/src/store/undo.js').then(U => JSON.stringify({{ n: U.historyLength.value }}));
    }})()""")['n']
    wb = _js(cdp, f"""(() => {{
      const b = {PM}.worldBounds;
      return JSON.stringify([(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.maxX, b.minX]);
    }})()""")
    cx, cy = wb[0], wb[1]
    drag_canvas_polyline(cdp, [[cx - 600 + i * 200, cy + (i % 3 - 1) * 120] for i in range(7)])
    time.sleep(0.9)
    after = _stats(cdp)['painted']
    hist1 = _js(cdp, f"""(() => {{
      return import('/src/store/undo.js').then(U => JSON.stringify({{ n: U.historyLength.value }}));
    }})()""")['n']
    if after <= before:
        fails.append(f'真实笔刷未写入格子（{before} → {after}）')
    if hist1 - hist0 != 1:
        fails.append(f'一次拖动应只入栈 1 条 undo（实际 Δ={hist1 - hist0}）')
    if _stats(cdp)['loops'] <= 0:
        fails.append('笔刷涂抹后轮廓环数为 0')
    detail_brush = f'真实笔刷 涂色格 {before}→{after}，undo Δ={hist1 - hist0}'

    if fails:
        return False, ' | '.join(fails)
    return True, (f'{detail_noise}；{detail_loops}；缓存纪律 ok（未变不重建/变了必重建）；{detail_brush}')
