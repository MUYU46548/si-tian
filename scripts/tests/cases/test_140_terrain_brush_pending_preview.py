#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 140：地形笔的 L3「将涂格」高亮（第 4 件，2026-10-24）

04 号指南对地形笔的要求：**拖动中 = 真笔迹 + "这笔下去会填哪些格"的高亮浮层；松手才批量写格**
（"松手前你先看见这笔会填哪些格，再决定认不认"）。此前是边拖边写 —— 用户看到的永远是"已经涂上"，
没有反悔的余地。

验收点（数据判据优先，全部走 product 自己的凸包/枚举）：
1. **拖动中不写格**：按下后到抬手前，网格字节**逐字节不变**（对照快照）—— 这是"预览"与"已落库"的分界
2. 拖动中确实积累了「将涂格」：`pendingCells().length > 0` 且随拖动增长
3. **所见即所得**：抬手后，每一个预览过的格都真的变成了这一笔的类型（越界格除外）
4. 抬手：pending 清空、格子落库、**一笔一条 undo**；撤销**逐字节**回到按下前的网格与几何；重做再回来
5. 源码守卫：预览与落库共用同一份格枚举（`forEachCell` / `forEachInterpolatedCell`），
   不允许预览自己再写一遍扫描逻辑
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for  # noqa: E402
from lib.helpers import A, enter_edit, goto_planet  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
PM = "document.querySelector('.planet-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"


def _code_only(src):
    import re
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    return re.sub(r'(?m)//[^\n]*', '', src)


def _read(rel):
    import io
    return io.open(os.path.join(ROOT, rel), encoding='utf-8').read()


DRAG = r"""(async () => {
  const pm = PM;
  const tb = pm.terrainCanvasBrush;
  const canvas = document.querySelector('.canvas-wrapper canvas');
  if (!canvas) return JSON.stringify({ __err__: '没有画布' });
  if (typeof tb.initTerrainGrid === 'function' && !tb.terrainGrid.value) tb.initTerrainGrid();
  if (!tb.terrainGrid.value) return JSON.stringify({ __err__: '地形网格没初始化' });

  const frame = () => new Promise((res) => requestAnimationFrame(() => res()));
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const TYPE = 7;                       // 岩石：本图地形里用得最少，便于"变没变"对照
  pm.setInteractionMode && pm.setInteractionMode('terrain');
  pm.terrainBrushType = TYPE;
  pm.terrainBrushSize = 8;
  pm.terrainBrushHardness = 0.8;
  tb.syncBrush();

  const r = canvas.getBoundingClientRect();
  const vt = pm.renderer.viewTransform;
  const sx = (wx) => wx * vt.scale + vt.x + canvas.clientWidth / 2 + r.left;
  const sy = (wy) => wy * vt.scale + vt.y + canvas.clientHeight / 2 + r.top;
  const mk = (wx, wy, t) => new MouseEvent(t, {
    clientX: sx(wx), clientY: sy(wy), bubbles: true, cancelable: true, button: 0,
  });
  const grid = () => tb.terrainGrid.value;
  const geomOf = () => tb.gridGeometry();
  const snapGrid = () => Array.from(grid());
  const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const countType = () => { const g = grid(); let n = 0; for (let i = 0; i < g.length; i++) if (g[i] === TYPE) n++; return n; };
  const historyOf = async () => (await import('/src/store/undo.js')).historyLength.value;

  const path = [[-320, 0], [-180, 90], [-40, -70], [120, 60], [280, -30]];
  const preGrid = snapGrid();
  const preGeom = geomOf();
  const preCount = countType();
  const h0 = await historyOf();

  // 像素探针：取第一段中点（远离笔刷圆心指示器），拖动中应当被"将涂格"盖住而变色
  const dpr = canvas.width / Math.max(1, canvas.clientWidth);
  const px = (wx, wy) => {
    const x = Math.round((vt.scale * wx + vt.x + canvas.clientWidth / 2) * dpr);
    const y = Math.round((vt.scale * wy + vt.y + canvas.clientHeight / 2) * dpr);
    const d = canvas.getContext('2d').getImageData(x, y, 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  };
  const probe = [-250, 45];
  const probes = [[-250, 45], [40, -5], [200, 15], [420, 240]];   // 末点是画布内"远离笔迹"的对照
  // ⚠️ 对照点必须在**画布内**：负坐标取样恒为透明黑，那种"没变"是空转（本项目踩过"空转通过"）。
  const pxPre = probes.map(([x, y]) => px(x, y));
  const pxBefore = pxPre[0];
  // 整张画布的"拖动前"快照：最终判据用它，而不是赌某一个探针点。
  // ⚠️ 拖动中还有 L2 笔迹层与笔刷预告圈；测像素前会先清掉它们，只留下「将涂格」。
  const c2d = canvas.getContext('2d');
  const allPre = new Uint8ClampedArray(c2d.getImageData(0, 0, canvas.width, canvas.height).data);
  // ① 按下（只此一次可能扩网格）；快照取在按下之后 = "拖动中不改"的对照
  canvas.dispatchEvent(mk(path[0][0], path[0][1], 'mousedown'));
  await frame();
  const dragBase = snapGrid();
  const dragGeom = geomOf();
  const pend0 = tb.pendingCells().length;

  // ② 拖动（不抬手）：每步取一次，检查"网格逐字节不变"与"预览格在长"
  const pendingAt = [];
  let bytesChanged = 0;
  let pendPrev = pend0;
  for (let i = 1; i < path.length; i += 1) {
    canvas.dispatchEvent(mk(path[i][0], path[i][1], 'mousemove'));
    await frame();
    const now = snapGrid();
    if (!sameBytes(now, dragBase)) bytesChanged += 1;
    const pend = tb.pendingCells().length;
    pendingAt.push(pend);
    if (pend < pendPrev) return JSON.stringify({ __err__: '预览格数倒退了', pendingAt });
    pendPrev = pend;
  }
  const preview = tb.pendingCells();
  const origin = tb.pendingOriginRef();
  const brushing = !!tb.isTerrainBrushing.value;
  const runs = (typeof tb.pendingRunsOf === 'function') ? tb.pendingRunsOf().length : -1;
  const mode = pm.interactionMode;
  const edit = !!pm.editMode;
  const midCount = countType();
  // 清掉 L2 笔迹与笔刷预告圈，只留「将涂格」再取整图差 ——
  // 这样"像素变了"只能来自 pending 高亮，不会被轨迹/预告圈冒充。
  if (tb.strokePath && tb.strokePath.value) tb.strokePath.value = [];
  if (typeof tb.clearBrushPreview === 'function') tb.clearBrushPreview();
  if (pm.renderer && typeof pm.renderer.renderNow === 'function') pm.renderer.renderNow();
  const allMid = c2d.getImageData(0, 0, canvas.width, canvas.height).data;
  let pixelDiff = 0;
  for (let i = 0; i < allPre.length; i += 4) {
    if (Math.abs(allPre[i] - allMid[i]) > 12
      || Math.abs(allPre[i + 1] - allMid[i + 1]) > 12
      || Math.abs(allPre[i + 2] - allMid[i + 2]) > 12) pixelDiff += 1;
  }
  // 等渲染器把这一帧画完再取像素（弹事件只是同步改数据，画是下一帧的事）。
  // ⚠️ 全量跑时机器更忙：一次等待可能读到的还是上一帧（实测整轮跑偶发 delta=0，单跑必过）。
  //    所以这里**主动 requestRender + 轮询**，最多 8 次 × ~90ms；仍为 0 才判失败。
  const pxDeltaOf = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])
    + Math.abs(a[2] - b[2]) + Math.abs(a[3] - b[3]);
  let pxDuring = px(probe[0], probe[1]);
  let pxDelta = pxDeltaOf(pxDuring, pxBefore);
  let pxTries = 0;
  if (pm.renderer && typeof pm.renderer.renderNow === 'function') pm.renderer.renderNow();
  pxDuring = px(probe[0], probe[1]);
  pxDelta = pxDeltaOf(pxDuring, pxBefore);
  for (let i = 0; i < 8 && pxDelta <= 12; i += 1) {
    pxTries = i + 1;
    if (pm.renderer && typeof pm.renderer.renderNow === 'function') pm.renderer.renderNow();
    else if (pm.renderer && typeof pm.renderer.requestRender === 'function') pm.renderer.requestRender();
    await frame();
    await sleep(90);
    pxDuring = px(probe[0], probe[1]);
    pxDelta = pxDeltaOf(pxDuring, pxBefore);
  }
  const pxMid = probes.map(([x, y]) => px(x, y));
  const deltas = probes.map((_, i) => Math.abs(pxMid[i][0] - pxPre[i][0])
    + Math.abs(pxMid[i][1] - pxPre[i][1]) + Math.abs(pxMid[i][2] - pxPre[i][2])
    + Math.abs(pxMid[i][3] - pxPre[i][3]));

  // ③ 抬手落库
  canvas.dispatchEvent(mk(path[path.length - 1][0], path[path.length - 1][1], 'mouseup'));
  await frame();
  await sleep(320);
  const afterGeom = geomOf();
  const afterGrid = grid();
  const afterCount = countType();
  const pendAfter = tb.pendingCells().length;
  const h1 = await historyOf();

  // ④ 所见即所得：预览过的每个格（换算到落库后的网格）必须已是这一笔的类型
  let checked = 0, miss = 0, outside = 0;
  const cell = origin && origin.cell ? origin.cell : afterGeom.cell;
  for (const c of preview) {
    const wx = origin.x + c.col * cell + cell / 2;
    const wy = origin.y + c.row * cell + cell / 2;
    const col = Math.floor((wx - afterGeom.originX) / afterGeom.cell);
    const row = Math.floor((wy - afterGeom.originY) / afterGeom.cell);
    if (col < 0 || row < 0 || col >= afterGeom.cols || row >= afterGeom.rows) { outside += 1; continue; }
    checked += 1;
    if (afterGrid[row * afterGeom.cols + col] !== TYPE) miss += 1;
  }

  // ⑤ 撤销：逐字节回到按下前的网格与几何；重做再回来
  const s = STORE;
  s.undo();
  await sleep(250);
  const undoGrid = snapGrid();
  const undoGeom = geomOf();
  const undoCount = countType();
  const undoExact = sameBytes(undoGrid, preGrid)
    && undoGeom.cell === preGeom.cell && undoGeom.cols === preGeom.cols && undoGeom.rows === preGeom.rows
    && Math.abs(undoGeom.originX - preGeom.originX) < 1e-6 && Math.abs(undoGeom.originY - preGeom.originY) < 1e-6;
  s.redo();
  await sleep(250);
  const redoCount = countType();

  return JSON.stringify({
    type: TYPE, pend0, pendingAt, preview: preview.length, brushing, midCount, afterCount, pendAfter,
    runs, mode, edit, pixelDiff,
    pxDelta, pxBefore, pxDuring, pxTries, deltas, pxPre, pxMid,
    checked, miss, outside, bytesChanged,
    undoExact, undoCount, redoCount, preCount,
    undoDelta: h1 - h0,
    geomChanged: dragGeom.cols !== afterGeom.cols || dragGeom.rows !== afterGeom.rows,
  });
})()"""


def sub_source_guards():
    bad = []
    tb = _code_only(_read('src/renderer/src/utils/terrainBrush.js'))
    for sym, why in (('forEachCell(', '笔刷没有统一的"碰哪些格"枚举（预览会对不上落库）'),
                     ('forEachInterpolatedCell(', '插值采样没有统一枚举（快速拖动时预览会漏段）')):
        if sym not in tb:
            bad.append(why)
    # paint / paintInterpolated 必须复用同一份枚举（不许再自己写一遍循环）
    if 'this.forEachCell(' not in tb or 'this.paint(' not in tb:
        bad.append('paint/paintInterpolated 没有复用统一枚举')
    comp = _code_only(_read('src/renderer/src/composables/useTerrainCanvasBrush.js'))
    if 'drawTerrainPendingToCtx' not in comp:
        bad.append('没有把「将涂格」画出来的入口')
    if 'commitPendingStroke' not in comp:
        bad.append('没有"松手才落库"的提交口')
    # 拖动中不许再调 paintInterpolated（那是写口的活，归 commit）
    move = comp[comp.find('function moveTerrainBrush'):comp.find('function commitPendingStroke')]
    if 'paintInterpolated(' in move or 'paintAt(' in move:
        bad.append('moveTerrainBrush 还在拖动中写格（预览就成了摆设）')
    if 'commitPendingStroke' not in move and 'accumulateSegment(' not in move:
        bad.append('moveTerrainBrush 没累积预览格')
    planet = _code_only(_read('src/renderer/src/components/PlanetMap.vue'))
    if 'drawTerrainPendingToCtx' not in planet:
        bad.append('PlanetMap 没有调用「将涂格」渲染')
    if bad:
        return False, '源码守卫失败：' + '；'.join(bad)
    return True, '预览与落库共用 forEachCell/forEachInterpolatedCell；拖动中只累积、松手才提交'


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    r = goto_planet(cdp, A('曜川星'))
    if r != 'planet':
        return False, f'导航行星失败 ({r})'
    time.sleep(1.2)
    if enter_edit(cdp) != 'ok':
        return False, '进入编辑模式失败'
    time.sleep(0.7)
    cdp.eval(f"{PM}.renderer.focusOn(0, 0, 1.0); {PM}.renderer.requestRender(); 'ok'")
    time.sleep(0.5)

    res = cdp.eval(DRAG.replace('PM', PM).replace('STORE', STORE))
    if isinstance(res, dict):
        return False, f'探针异常：{res}'
    data = json.loads(res)
    if data.get('__err__'):
        return False, f'探针失败：{data["__err__"]}'

    fails = []
    if not data.get('brushing'):
        fails.append('拖动中 isTerrainBrushing 不是 true（预览态没建立）')
    if not (data.get('pixelDiff', 0) > 200):
        fails.append(f'清掉轨迹/预告圈后整图仍没变化 —— 「将涂格」没被画出来（变化像素 {data.get("pixelDiff")}；'
                     f'runs={data.get("runs")} mode={data.get("mode")} edit={data.get("edit")} '
                     f'brushing={data.get("brushing")}；单点探针差 {data.get("pxDelta")}）')
    # 对照：远离笔迹的那个点必须**没变** —— 否则"变色"可能只是整帧重绘的巧合
    if (data.get('deltas') or [0, 0, 0, 0])[3] != 0:
        fails.append(f'远离笔迹的对照点也变色了（{data.get("deltas")}）—— 像素判据不成立')
    if not (data.get('pend0', 0) > 0):
        fails.append(f'按下后没有"将涂格"（{data.get("pend0")}）')
    if not (data.get('pendingAt') and data['pendingAt'][-1] > data['pend0']):
        fails.append(f'拖动中"将涂格"没增长（{data.get("pendingAt")}）')
    if data.get('bytesChanged'):
        fails.append(f'拖动中网格被改了（{data.get("bytesChanged")} 步字节变了）—— 预览成了摆设')
    if data.get('midCount') != data.get('preCount'):
        fails.append(f'拖动中就已经写进了类型 {data.get("type")}（{data.get("preCount")} → {data.get("midCount")}）')
    if data.get('pendAfter') != 0:
        fails.append(f'抬手后"将涂格"没清空（还剩 {data.get("pendAfter")}）')
    if not (data.get('afterCount', 0) > data.get('preCount', 0)):
        fails.append(f'抬手后格子没落库（{data.get("preCount")} → {data.get("afterCount")}）')
    if data.get('undoDelta') != 1:
        fails.append(f'一次拖动应只入栈 1 条 undo（实际 Δ={data.get("undoDelta")}）')
    if not data.get('undoExact'):
        fails.append('撤销没有逐字节回到按下前的网格/几何')
    if data.get('undoCount') != data.get('preCount'):
        fails.append(f'撤销后类型计数没回原值（{data.get("undoCount")} ≠ {data.get("preCount")}）')
    if data.get('redoCount') != data.get('afterCount'):
        fails.append(f'重做后类型计数不对（{data.get("redoCount")} ≠ {data.get("afterCount")}）')
    if data.get('preview', 0) <= 0:
        fails.append('没有记录到预览格（无法判定所见即所得）')
    if data.get('miss'):
        fails.append(f'**所见非所得**：{data.get("miss")} 个预览格抬手后不是这一笔的类型')
    if not (data.get('checked', 0) > 0):
        fails.append('没有可比对的预览格（全部越界？）')

    sg_ok, sg_detail = sub_source_guards()
    if not sg_ok:
        fails.append(sg_detail)

    detail = (f'拖动中：{data.get("pend0")}→{data.get("pendingAt")[-1] if data.get("pendingAt") else "?"} 个'
              f'「将涂格」、网格**逐字节未变**（{data.get("bytesChanged")} 步变化）；'
              f'抬手：落库 {data.get("preCount")}→{data.get("afterCount")} 格、预览清空、一条 undo；'
              f'所见即所得：{data.get("checked")} 个预览格全部命中（越界 {data.get("outside")}、漏 {data.get("miss")}）；'
              f'撤销逐字节复原（类型计数 {data.get("undoCount")}）、重做 {data.get("redoCount")}；源码守卫：{sg_detail}')
    if fails:
        return False, '；'.join(fails)[:900]
    return True, detail
