#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 121：**地图编辑的卡顿** —— 手势期「底图基帧」缓存（2026-10-18 第十八修）

暮雨原话：
  「卡顿发生在方方面面，基本涉及地图编辑绘制的，画条线圈个地都要卡一卡。以画河流为例，
    随便拖一条出来都要卡一阵，点节点又开始卡。」

先量后修（真实 `docs/mockups/desite.map`：200 省 / 160 河 / 24018 个骨架顶点 / 9975 格高度图）：

  | 手势 | 每事件 handler | 帧 p50 | 帧 p95 | >33ms 帧 |
  |---|---|---|---|---|
  | 省份自由绘制 | **29.31ms** | 44.5ms | 72.2ms | 27/44 |
  | 河笔拖笔 | 3.42ms | 16.6ms | 24.9ms | 0 |
  | 拖节点 | 9.32ms | 23.9ms | 26.2ms | 0 |

CPU 采样（`_probe_cpu_profile.py`，拖一圈 4 秒）把 29ms 摊开：**(program) 67%** —— 也就是
**原生 canvas 光栅化本身**（每帧把整张地图重画一遍：fill/stroke/lineTo/drawImage），
另有 `conformToSkeleton` 的最近点扫描 17%（O(笔迹点 × 24018 骨架顶点)）与 Vue 响应式代理读 15%。

修法三条（各带判据）：
  ① 骨架最近顶点改走**空间索引**（格子边长 = threshold，3×3 邻域完备），且骨架改从 `toRaw`
     地形建（不然每个 `v.x` 都要过响应式 get 陷阱）；口径与朴素双循环**逐位一致**（含并列取舍）。
  ② 自动河那一段几何（闸门/剪枝/成链/抽稀/裁岸线 + 陆地掩膜）**按数据引用缓存** ——
     它原来每帧重算（实测 `render` 7.3ms → 14.3ms，`pruneRiverNetwork` 一项 4.2ms）。
  ③ **手势期「底图基帧」缓存**（本条的主角）：按下时把「没有草稿的那一帧」渲染进离屏画布，
     拖动期间每帧只「贴图 + 画笔迹」，抬手即作废。绘图软件的分层就是这个意思。

本用例判据（**不靠墙钟时间** —— 时间断言在慢机器上会假红）：
  a 源码闸门：三个函数在、`renderFrame` 的静态层受 `blitted` 管、动态层受 `strokeBaseBuilding` 管、
    缓存只在明确手势里启用（`beginStrokeBase` 的调用点）、数据一变就解甲的安全阀在；
  b 机制：一次拖动 = **1 次全量建基帧 + N 次贴图**（计数由 `strokeBaseStats` 给出），
    且拖动期间 `strokeBaseArmed` 为真；
  c 🔴 **逐像素等价**：拖笔期间的画面（贴图帧）与"解甲后全量重画"的画面**必须逐点相同** ——
    这条是本职改动的**核心安全属性**（贴图帧 ≡ 全量帧，层叠顺序不变），
    一旦谁把动态层漏进基帧、或把静态层漏出基帧，这里立刻红；
  d 相机一动（滚轮缩放）→ 基帧作废并**解甲**（相机动了还贴图 = 画错）；
  e 安全阀：手势中途底图几何换引用（撤销/别的入口写入）→ 立刻解甲（不许贴旧图）；
  f 收尾：抬手后不再启用；普通 `render()` 一次都不贴图（缓存不泄漏到手势之外）。
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for                                   # noqa: E402
from lib.helpers import ensure_case_state                                 # noqa: E402

SMC = "document.querySelector('.scenario-map-container')"
SM = SMC + ".__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
ROOT = os.path.join(os.path.dirname(__file__), '..', '..', '..')
SMV = os.path.join(ROOT, 'src', 'renderer', 'src', 'components', 'ScenarioMap.vue')


def _code_only(src):
    src = re.sub(r'<style[\s\S]*?</style>', '', src)
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


def source_gates():
    fails = []
    with open(SMV, encoding='utf-8') as f:
        sm = _code_only(f.read())
    for sym in ('function beginStrokeBase(', 'function endStrokeBase(', 'function buildStrokeBase(',
                'function blitStrokeBase(', 'strokeBaseStats'):
        if sym not in sm:
            fails.append(f'🔴 手势期基帧缓存的接线缺失：{sym}')
    # 静态层必须受 blitted 管、动态层必须受 strokeBaseBuilding 管（两边漏一个都会画错）
    # 2026-10-30（N1 刀 1）：静态六层改走 `scenarioLayers` 注册表，所以判据从"字面量"改成
    #   "注册表的 run 就在 `if (!blitted) {` 打开后 200 字符内" —— 门控仍然只包住静态层。
    _i_gate = sm.find('if (!blitted) {')
    _i_run = sm.find('scenarioRenderLayers.run(ctx.value')
    if _i_gate < 0 or _i_run < 0 or (_i_run - _i_gate) > 200:
        fails.append('🔴 静态层没有受「贴图帧」门控：`scenarioLayers.run(...)` 不在 `if (!blitted) {` 里'
                     '（贴图帧会把它们再画一遍）')
    for gate in ('if (showRiverBase.value) drawRiversLayer(ctx.value, makeLayerView());\n  }\n'
                 '  if (!strokeBaseBuilding) drawRiverPathsLayer',
                 'if (!blitted && showBorders.value) drawProvinceBordersLayer',
                 # 2026-10-21：相机移动期还会跳过聚落/标签/小地图（cameraMotion），
                 # 门控条件因此变长；判据只要求"同一行里既有 !blitted 又有 drawBurgs"。
                 'if (!blitted && showBurgs.value && !cameraMotion) {\n    drawBurgsLayer'):
        if gate not in sm:
            fails.append(f'🔴 静态层没有受「贴图帧」门控：{gate!r}（贴图帧会把它们再画一遍）')
    for gate in ('if (!strokeBaseBuilding) drawRiverPathsLayer', 'if (!strokeBaseBuilding) drawSelectedRiverHighlightLayer',
                 'if (!strokeBaseBuilding) drawVertexHandlesLayer', 'if (!strokeBaseBuilding) drawPreviewOverlayLayer'):
        if gate not in sm:
            fails.append(f'🔴 动态层没有从基帧里排除：{gate!r}（基帧会把草稿烙进去 → 拖笔留鬼影）')
    # 缓存只在明确的高频手势里启用（不许全局挂上）
    # 2026-10-31：mousedown 搬进 scenario/interaction/down.js —— 判据把那份源码一起读
    with open(os.path.join(ROOT, 'src', 'renderer', 'src', 'scenario', 'interaction', 'down.js'), encoding='utf-8') as f:
        sm = sm + '\n' + _code_only(f.read())
    if sm.count('beginStrokeBase()') < 6:
        fails.append('🔴 `beginStrokeBase()` 的启用点太少 —— 缓存没接在高频手势上（接了也没收益）')
    wheel = sm.split('function onWheel(', 1)
    if len(wheel) < 2 or 'endStrokeBase()' not in wheel[1][:400]:
        fails.append('🔴 滚轮动相机时没有作废基帧（会贴着旧图缩放）')
    if '() => baseMap.value?.terrain' not in sm or 'strokeBaseArmed) endStrokeBase()' not in sm:
        fails.append('🔴 没有「底图几何换引用就解甲」的安全阀（撤销后还贴旧图）')
    # 骨架索引 + toRaw（不然每帧 110 万次 Math.hypot / 每个坐标都过响应式 get）
    if 'skeletonForTerrain(rawTerrain()' not in sm:
        fails.append('🔴 骨架仍从**响应式**地形建（坐标读取每帧过 Vue get 陷阱）')
    with open(os.path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'provinceShape.js'), encoding='utf-8') as f:
        ps = _code_only(f.read())
    if 'export function nearestSkeletonVertex(' not in ps or 'skeletonVertexIndex' not in ps:
        fails.append('🔴 provinceShape 没有骨架空间索引（O(点数 × 顶点数) 会继续卡）')
    if 'nearestSkeletonVertex(p.x, p.y, skeleton, threshold)' not in ps:
        fails.append('🔴 conformToSkeleton 没走空间索引（索引写了但没人用）')
    return fails


# 造一张**有内容**的底图（省/河/路都有 → 基帧里真的装着好几层，等价性判据才有意义）
JS_SETUP = r"""
(async () => {
  const s = __STORE__;
  const el = document.querySelector('.scenario-map-container');
  if (!el) return JSON.stringify({ err: '剧本编辑器没挂载' });
  const sm = el.__vueParentComponent.setupState;
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 80));
  const KEY = 'case121';
  const W = 1600, H = 1000;
  const terrain = [];
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 4; i++) {
      const x = -700 + i * 380, y = -420 + j * 300;
      terrain.push({
        id: 'p' + (j * 4 + i), name: '省' + (j * 4 + i), kind: 'land',
        color: 'hsl(' + (j * 4 + i) * 30 + ', 45%, 55%)',
        points: [{ x, y }, { x: x + 360, y }, { x: x + 360, y: y + 280 }, { x, y: y + 280 }],
      });
    }
  }
  const rivers = [];
  for (let k = 0; k < 5; k++) {
    const pts = [];
    for (let i = 0; i <= 40; i++) pts.push({ x: -700 + i * 40, y: -380 + k * 180 + Math.sin(i / 4) * 30 });
    rivers.push({ id: 'r' + k, name: '河' + k, points: pts, width: 2 });
  }
  const routes = [];
  for (let k = 0; k < 4; k++) {
    const pts = [];
    for (let i = 0; i <= 20; i++) pts.push({ x: -680 + i * 70, y: -300 + k * 200 + Math.cos(i / 3) * 40 });
    routes.push({ id: 't' + k, group: 'roads', points: pts });
  }
  s.baseMaps = { ...s.baseMaps, [KEY]: { id: KEY, name: '用例121底图', terrain, referenceImages: [],
    rivers, routes, burgs: [], markers: [], labels: [] } };
  sm.baseMapKey = KEY;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await tick(400);
  sm.setTool('draw');
  sm.showMinimap = true;
  sm.showRoutes = true;
  sm.rasterLayer = 'none';
  sm.cameraScale = 1;
  sm.cameraX = 0; sm.cameraY = 0;
  sm.render();
  await tick(200);
  const cvs = sm.canvas;
  const rc = cvs.getBoundingClientRect();
  return JSON.stringify({ ok: true, canvas: [Math.round(rc.width), Math.round(rc.height)],
    terrain: terrain.length, rivers: rivers.length, routes: routes.length, tool: sm.tool, fails: [] });
})()
"""

# b + c：机制（1 次建 + N 次贴）与**逐像素等价**
JS_DRAG = r"""
(async () => {
  const sm = __SM__, s = __STORE__;
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 60));
  const cvs = sm.canvas;
  const g = cvs.getContext('2d');
  const rc = cvs.getBoundingClientRect();
  const mk = (t, x, y) => new MouseEvent(t, {
    clientX: rc.left + x, clientY: rc.top + y, button: 0,
    buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true,
  });
  const out = { fails: [] };
  const st0 = { builds: sm.strokeBaseStats.builds, blits: sm.strokeBaseStats.blits };
  const cx = rc.width * 0.42, cy = rc.height * 0.46, R = Math.min(rc.width, rc.height) * 0.22;
  cvs.dispatchEvent(mk('mousedown', cx + R, cy));
  for (let i = 1; i <= 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const rr = R * (1 + 0.05 * Math.sin(a * 6));
    cvs.dispatchEvent(mk('mousemove', cx + Math.cos(a) * rr, cy + Math.sin(a) * rr));
  }
  await tick(120);
  sm.render();                       // 收口成一次确定的"贴图帧"
  const st1 = { builds: sm.strokeBaseStats.builds, blits: sm.strokeBaseStats.blits };
  out.armed = !!sm.strokeBaseArmed;
  out.builds = st1.builds - st0.builds;
  out.blits = st1.blits - st0.blits;
  out.draftPts = (sm.freeTrace || []).length;
  out.draftShown = !!sm.previewTraceRing();
  // ── 逐像素等价：贴图帧 vs 解甲后的全量帧 ──
  const during = g.getImageData(0, 0, cvs.width, cvs.height).data;
  sm.endStrokeBase();
  sm.render();
  await tick(60);
  const full = g.getImageData(0, 0, cvs.width, cvs.height).data;
  let diff = 0, firstAt = null;
  for (let i = 0; i < during.length; i += 4) {
    if (during[i] !== full[i] || during[i + 1] !== full[i + 1] || during[i + 2] !== full[i + 2]) {
      diff++;
      if (firstAt === null) firstAt = i / 4;
    }
  }
  out.diffPixels = diff;
  out.firstDiffAt = firstAt;
  out.totalPixels = during.length / 4;
  // ── f：抬手后不再启用；普通 render 不贴图 ──
  cvs.dispatchEvent(mk('mouseup', cx + R, cy));
  await tick(400);
  const st2 = { builds: sm.strokeBaseStats.builds, blits: sm.strokeBaseStats.blits };
  out.armedAfterUp = !!sm.strokeBaseArmed;
  out.baseAfterUp = !!sm.strokeBase;
  sm.render();
  await tick(40);
  out.blitsAfterUp = sm.strokeBaseStats.blits - st2.blits;
  out.provCount = (s.baseMaps.case121.terrain || []).length;
  return JSON.stringify(out);
})()
"""

# d + e：相机一动就解甲 / 数据一变就解甲
JS_SAFETY = r"""
(async () => {
  const sm = __SM__, s = __STORE__;
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 60));
  const out = { fails: [] };
  // ── d 相机一动 → 作废并解甲 ──
  sm.beginStrokeBase();
  sm.render();
  out.armedAfterArm = !!sm.strokeBaseArmed;
  out.baseBuilt = !!sm.strokeBase;
  const blits0 = sm.strokeBaseStats.blits;
  sm.cameraScale = 2.5;
  sm.render();
  out.armedAfterCamera = !!sm.strokeBaseArmed;
  out.baseAfterCamera = !!sm.strokeBase;
  out.blitsOnCameraMove = sm.strokeBaseStats.blits - blits0;
  sm.cameraScale = 1;
  sm.cameraX = 0; sm.cameraY = 0;
  sm.render();
  await tick(60);
  // ── e 数据一变 → 安全阀解甲 ──
  sm.beginStrokeBase();
  sm.render();
  out.armedBeforeData = !!sm.strokeBaseArmed;
  const bm = s.baseMaps.case121;
  out.terrainBeforeData = (bm.terrain || []).length;
  bm.terrain = [...bm.terrain, { id: 'pNew', name: '新省', kind: 'land', color: '#abcdef',
    points: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 60 }, { x: 0, y: 60 }] }];
  await tick(120);
  out.armedAfterData = !!sm.strokeBaseArmed;
  out.baseAfterData = !!sm.strokeBase;
  out.terrainAfterData = (s.baseMaps.case121.terrain || []).length;
  // 收尾：把新省删掉（别把状态留给后面的用例）
  bm.terrain = bm.terrain.filter((p) => p.id !== 'pNew');
  sm.render();
  await tick(60);
  return JSON.stringify(out);
})()
"""


def _ev(cdp, js, desc):
    v = cdp.eval(js)
    if isinstance(v, dict) and '__err__' in v:
        raise RuntimeError(f'{desc} 求值异常：{str(v)[:300]}')
    return v


def _viewport(cdp):
    """固定视口（与 test_113 同款）：像素判据要求画布尺寸稳定，DPR 1 也能让取像素快一截"""
    try:
        cdp.send('Emulation.setDeviceMetricsOverride',
                 {'width': 1280, 'height': 800, 'deviceScaleFactor': 1, 'mobile': False})
    except Exception:
        pass


def _json(cdp, js, desc):
    v = _ev(cdp, js, desc)
    if not isinstance(v, str):
        raise RuntimeError(f'{desc} 没返回 JSON：{str(v)[:200]}')
    return json.loads(v)


def run(cdp):
    fails = source_gates()
    notes = ['源码闸门 %d 组' % (12)]
    ensure_case_state(cdp)
    _viewport(cdp)
    # 🔴 压叠闸门会 `window.confirm`：headless 下没有 dialog 处理者时它会**永久阻塞**
    #    （本用例第一次跑就是这么撞的 CDP 读超时 —— 不是产品卡，是对话框在等人）。
    #    本用例量的是"贴图帧 ≡ 全量帧"，不是"人在对话框前坐多久"，所以一律当确认。
    cdp.eval("window.confirm = () => true; 'ok'")

    _ev(cdp, "(() => { const b = Array.from(document.querySelectorAll('button'))"
             ".find(x => (x.textContent || '').includes('\u5386\u53f2\u5267\u672c'));"
             " if (b) b.click(); return 'ok'; })()", '点历史剧本')
    wait_for(cdp, "!!" + SMC, timeout=25, desc='剧本编辑器挂载')
    time.sleep(0.8)

    setup = _json(cdp, JS_SETUP.replace('__STORE__', STORE), '造底图')
    if setup.get('err'):
        return False, '底图准备失败：' + str(setup)
    notes.append('底图：%s 省 / %s 河 / %s 路' % (setup['terrain'], setup['rivers'], setup['routes']))

    # ── b + c：机制与逐像素等价 ──
    drag = _json(cdp, JS_DRAG.replace('__SM__', SM).replace('__STORE__', STORE), '拖笔与等价性')
    if not drag.get('armed'):
        fails.append('🔴 拖笔期间手势期基帧没启用（`beginStrokeBase` 没接上）')
    if drag.get('builds') != 1:
        fails.append(f"🔴 一次拖动建了 {drag.get('builds')} 次基帧（应为 1 —— 多了就是每帧重建，比不缓存还慢）")
    if (drag.get('blits') or 0) < 2:
        fails.append(f"🔴 拖动期间只贴了 {drag.get('blits')} 次图（缓存没真正在生效）")
    if not drag.get('draftShown'):
        fails.append('拖笔期间没有预览形状（基帧把草稿盖掉了？）')
    # 🔴 逐像素等价（本用例的核心判据）
    if drag.get('diffPixels'):
        fails.append(f"🔴 贴图帧与全量帧**不一致**：{drag['diffPixels']} / {drag['totalPixels']} 个像素不同"
                     f"（首个不同在第 {drag.get('firstDiffAt')} 个）—— 基帧的层叠顺序与全量重画不一致")
    notes.append('b 机制：建基帧 %s 次 / 贴图 %s 次 / 草稿 %s 点'
                 % (drag.get('builds'), drag.get('blits'), drag.get('draftPts')))
    notes.append('c 等价：%s 个像素逐个比对，差异 %s'
                 % (drag.get('totalPixels'), drag.get('diffPixels')))
    # ── f：抬手后不启用 ──
    if drag.get('armedAfterUp') or drag.get('baseAfterUp'):
        fails.append('🔴 抬手后基帧仍处于启用状态（会把旧图泄漏到手势之外）')
    if (drag.get('blitsAfterUp') or 0) != 0:
        fails.append(f"🔴 手势之外的普通 render 也在贴图（{drag.get('blitsAfterUp')} 次）")
    notes.append('f 收尾：抬手后启用=%s / 普通 render 贴图 %s 次'
                 % (drag.get('armedAfterUp'), drag.get('blitsAfterUp')))

    # ── d + e：两条安全阀 ──
    safe = _json(cdp, JS_SAFETY.replace('__SM__', SM).replace('__STORE__', STORE), '安全阀')
    if not safe.get('armedAfterArm') or not safe.get('baseBuilt'):
        fails.append('🔴 手动 arm 后基帧没建起来（后面两条安全阀的判据起点不成立）')
    if safe.get('armedAfterCamera') or safe.get('baseAfterCamera'):
        fails.append('🔴 相机变了基帧没作废（会贴着旧图缩放/平移）')
    if (safe.get('blitsOnCameraMove') or 0) != 0:
        fails.append('🔴 相机变了还在贴旧图（贴图次数 > 0）')
    if safe.get('armedBeforeData'):
        if safe.get('armedAfterData') or safe.get('baseAfterData'):
            fails.append('🔴 底图几何换了引用之后基帧没解甲（撤销/别的入口写入后会贴旧图）')
    else:
        fails.append('🔴 安全阀判据起点不成立：arm 之后立刻就不是启用态了')
    if safe.get('terrainAfterData') != (safe.get('terrainBeforeData') or 0) + 1:
        fails.append(f"数据写入本身没生效（terrain {safe.get('terrainBeforeData')} → "
                     f"{safe.get('terrainAfterData')}）—— 上一条判据不可信")
    notes.append('d 相机：动相机后启用=%s / 贴图 %s 次'
                 % (safe.get('armedAfterCamera'), safe.get('blitsOnCameraMove')))
    notes.append('e 安全阀：改 terrain 引用后启用=%s（换引用前 %s）'
                 % (safe.get('armedAfterData'), safe.get('armedBeforeData')))

    # ── 收尾：退出剧本域 ──
    _ev(cdp, "(() => { const b = document.querySelector('.scenario-toolbar .back-btn');"
             " if (b) b.click(); return 'ok'; })()", '返回世界')
    time.sleep(0.5)

    if fails:
        return False, ' | '.join(notes) + ' ⇒ ' + ' ；'.join(fails)
    return True, ' | '.join(notes)
