#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 60：涂色网格覆盖整张地图 + 生物群系层反马赛克 + 剧本底图的手绘/性能

用户实测三条（2026-09-22 第三轮）：
  A「地形笔刷……似乎无法越过某条隐藏界限，在画布某些区域无法绘制，形成明显的真空区」
  B「群系（高度）笔刷一画就卡，是整个司天卡死的级别……约二十秒后地图上出现神秘草绿色方块」
  C「历史剧本的绘制（底图编辑）很卡……绘制功能有退化为早期版本描点连线模拟器的风险……
     自由轮廓视图下这个让人产生密集恐惧症的恶心视图」

量化归因（CDP 实测，真实库 `乐园星`）：
  A 涂色网格 = 高度图范围 + 16 格 → 世界矩形 [-1759,-1259]~[1682,1074]，而 worldBounds 是
    [-1550,-1050]~[1867,1629]：**网格只盖住地图的 87.7%**，底部 555m 的条带看得见却涂不上，
    落点在网格外时 paint() 的 clamp 让整笔静默无效。
  B `planetDrawing.drawHeightmap` 还是上一轮「反马赛克」只改 terrainGrid 时**漏掉的另一半**：
    逐格 roundRect + `ctx.filter = blur(1.4/zoom)` + 13 个分桶各一次 fill（画布滤镜每次 fill
    都要整层重做）。headless 实测高度图模式中位帧 **66ms**（关掉该层 33ms）；草绿色方块就是
    这一堆圆角格（草地色）终于画完的样子。
  C `rasterizeProvinces` 走 Vue 响应式代理做 O(格数 × 点数) 热循环：6 省 3600 点 / 3124 格实测
    **838.6ms**（真实库 desite 是 21 省 25930 点）；省份网格又是逐格 roundRect（格间缝隙连成
    深色网格、四角交汇处露出「点」= 用户说的密集恐惧症视图）；「绘制」只有描点一条路。

验收点（每条对应一个真实症状）：
1. 涂色网格范围 = 高度图 ∪ 地图可见范围 ∪ 已涂内容 → 网格世界矩形必须**包住 worldBounds**
2. 网格外落笔不再静默无效：自动扩网格（已涂内容按世界坐标保留），且**一条 undo 同时还原几何与像素**
3. 生物群系层源码零 roundRect / 零 ctx.filter，改走 buildLabelOutlines + 内容哈希缓存
4. 生物群系层不再是空白也不再有方块：图层开关前后画布唯一色数有可观差异，轮廓环数 > 0
5. 省份网格不再逐格 roundRect（改矢量轮廓）；`rasterizeProvinces` 热循环不再走响应式代理
6. 「绘制」工具按住拖动 = 一笔成型的自由绘制（轨迹 → RDP 简化 → 省份），且描点仍可用
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.helpers import A  # noqa: E402
from lib.cdp import wait_for  # noqa: E402
from lib import helpers as H  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
PM = "document.querySelector('.planet-map-container').__vueParentComponent.setupState"
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"

FRAME_MID_LIMIT = 55      # 高度图模式中位帧上限（旧实现在同环境 66ms）
HEIGHT_OUTLINE_LIMIT = 150  # 生物群系轮廓重建耗时上限（ms，实测见 detail）
RASTERIZE_LIMIT = 300     # 6 省 3600 点的栅格化上限（旧实现走代理实测 838.6ms）


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


def _code_only(src):
    """剥注释（带状态逐行扫描，不要用正则一把梭 —— 源码里的正则字面量会骗到它，见 skill §123/§141.3）"""
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


GRID_GEO = r"""
(() => {
  const pm = __PM__, st = __STORE__;
  const b = pm.terrainCanvasBrush;
  if (!b.terrainGrid.value) b.initTerrainGrid();
  const g = b.gridGeometry();
  const wb = pm.worldBounds;
  const G = b.terrainGrid.value;
  let painted = -1;
  if (G) { painted = 0; for (let i = 0; i < G.length; i++) if (G[i] !== 255) painted++; }
  return JSON.stringify({
    grid: g, len: G ? G.length : 0, painted,
    rect: [Math.round(g.originX), Math.round(g.originY),
           Math.round(g.originX + g.cols * g.cell), Math.round(g.originY + g.rows * g.cell)],
    wb: [Math.round(wb.minX), Math.round(wb.minY), Math.round(wb.maxX), Math.round(wb.maxY)],
    coversWb: g.originX <= wb.minX + 1e-6 && g.originY <= wb.minY + 1e-6
      && g.originX + g.cols * g.cell >= wb.maxX - 1e-6 && g.originY + g.rows * g.cell >= wb.maxY - 1e-6,
  });
})()
"""

PAINT_AT = r"""
(() => {
  const b = __PM__.terrainCanvasBrush;
  if (!b.terrainGrid.value) b.initTerrainGrid();
  if (!b.terrainGrid.value) return JSON.stringify({ err: 'no-grid' });
  // 每次都现读 terrainGrid.value：一笔结束后 applySnapshot 会**整体替换**数组对象，
  // 缓存旧引用会数到「没涂过的那一份」（第一版探针就踩了这个假红）
  const count = () => { const G = b.terrainGrid.value; let n = 0; for (let i = 0; i < G.length; i++) if (G[i] !== 255) n++; return n; };
  b.terrainBrushSize.value = 8;
  const g0 = b.gridGeometry();
  const before = count();
  b.startTerrainBrush(__X__, __Y__);
  b.endTerrainBrush();
  const g1 = b.gridGeometry();
  return JSON.stringify({ before, after: count(), geomBefore: g0, geomAfter: g1,
                          grew: (g1.cols > g0.cols || g1.rows > g0.rows
                                 || Math.abs(g1.originX - g0.originX) > 1e-6 || Math.abs(g1.originY - g0.originY) > 1e-6) });
})()
"""

UNDO_ONCE = r"""
(async () => {
  const U = await import('/src/store/undo.js');
  U.undo();
  await new Promise(r => setTimeout(r, 250));
  const b = __PM__.terrainCanvasBrush;
  const G = b.terrainGrid.value;
  let painted = 0;
  for (let i = 0; i < G.length; i++) if (G[i] !== 255) painted++;
  return JSON.stringify({ geom: b.gridGeometry(), painted });
})()
"""

FRAMES = r"""
(async () => {
  const pm = __PM__;
  const n = __N__;
  const gaps = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    pm.renderer.requestRender();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    gaps.push(performance.now() - t0);
  }
  gaps.sort((a, b) => a - b);
  return JSON.stringify({ mid: Math.round(gaps[Math.floor(gaps.length / 2)]), max: Math.round(gaps[gaps.length - 1]) });
})()
"""

UNIQ = r"""
(() => {
  const c = document.querySelector('.canvas-wrapper canvas');
  const g = c.getContext('2d');
  const w = Math.min(c.width, 900), h = Math.min(c.height, 600);
  const d = g.getImageData(0, 0, w, h).data;
  const set = new Set();
  for (let i = 0; i < d.length; i += 4) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
  return JSON.stringify({ uniq: set.size });
})()
"""

SET_MODE = r"""
(() => {
  const pm = __PM__;
  pm.setInteractionMode(__MODE__);
  pm.renderer.requestRender();
  return JSON.stringify({ mode: pm.interactionMode });
})()
"""

HM_STATS = r"""
(() => {
  const pm = __PM__;
  const s = pm.drawing.heightmapOutlineStats ? pm.drawing.heightmapOutlineStats() : null;
  const hm = pm.currentMapData && pm.currentMapData.heightmap;
  const hist = {};
  if (hm && hm.biome) for (let i = 0; i < hm.biome.length; i++) { const k = hm.biome[i]; hist[k] = (hist[k] || 0) + 1; }
  return JSON.stringify({ stats: s, hist, cells: hm ? hm.biome.length : 0 });
})()
"""

# ── 剧本模式 ────────────────────────────────────────────────
SC_FIXTURE = r"""
(() => {
  const s = __STORE__, sc = __SC__;
  const KEY = 'case60';
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: '用例60底图' });
  sc.baseMapKey = KEY;
  const N = 600, terrain = [];
  for (let k = 0; k < 6; k++) {
    const cx = -300 + (k % 3) * 300, cy = -200 + Math.floor(k / 3) * 300;
    const pts = [];
    for (let i = 0; i < N; i++) {
      const a = i / N * Math.PI * 2;
      const rad = 120 * (1 + 0.22 * Math.sin(a * 3 + k) + 0.1 * Math.sin(a * 7 + k * 2));
      pts.push({ x: Math.round((cx + Math.cos(a) * rad) * 10) / 10, y: Math.round((cy + Math.sin(a) * rad * 0.7) * 10) / 10 });
    }
    terrain.push({ id: 'c60_p' + k, name: '用例60省' + k, points: pts, biome: 'temperate', coast: false });
  }
  s.baseMaps = { ...s.baseMaps, [KEY]: { ...s.baseMaps[KEY], terrain } };
  const t0 = performance.now();
  s.rebuildProvinceGrid(KEY);
  const ms = performance.now() - t0;
  const entry = s.getProvinceGrid(KEY);
  return JSON.stringify({ rebuildMs: Math.round(ms * 10) / 10, terrain: terrain.length,
                          owned: entry ? entry.labels.reduce((a, v) => a + (v > 0 ? 1 : 0), 0) : -1,
                          grid: entry ? [entry.grid.cols, entry.grid.rows] : null });
})()
"""

# ⚠️ 网格现在是**内部中间层**（P0 第二块删掉了「网格视图」开关）：它只在**涂抹进行中**
# 叠一层即时反馈。所以量它必须真的进入一次涂抹 —— 而且要走**真鼠标**（mousedown）：
# `provStrokeActive` 是组件里的普通 let，探针改不动，只有真事件才能把它置真。
SC_MESH = r"""
(() => {
  const sc = __SC__;
  const canvasEl = document.querySelector('.scenario-map-container canvas');
  const r = canvasEl.getBoundingClientRect();
  const mk = (t, sx, sy) => new MouseEvent(t, { clientX: r.left + sx, clientY: r.top + sy, bubbles: true, cancelable: true, button: 0 });
  const cx = canvasEl.clientWidth / 2, cy = canvasEl.clientHeight / 2;
  sc.setTool('provinceBrush');
  canvasEl.dispatchEvent(mk('mousedown', cx, cy));      // 涂抹开始（网格中间层此刻才画）
  canvasEl.dispatchEvent(mk('mousemove', cx + 6, cy + 6));
  const t0 = performance.now();
  sc.render();
  const ms = performance.now() - t0;
  const stats = sc.provinceBrush.meshStats();
  const on = sc.provinceMeshOn;
  canvasEl.dispatchEvent(mk('mouseup', cx + 6, cy + 6));
  return JSON.stringify({ meshRenderMs: Math.round(ms * 100) / 100, stats, meshOn: on });
})()
"""

FREE_DRAW = r"""
(() => {
  const sc = __SC__;
  const canvasEl = document.querySelector('.scenario-map-container canvas');
  const r = canvasEl.getBoundingClientRect();
  const mk = (t, sx, sy) => new MouseEvent(t, { clientX: r.left + sx, clientY: r.top + sy, bubbles: true, cancelable: true, button: 0 });
  const before = sc.baseMap.terrain.length;
  sc.setTool('draw');
  const cx = canvasEl.clientWidth / 2, cy = canvasEl.clientHeight / 2;
  const samples = 60;
  canvasEl.dispatchEvent(mk('mousedown', cx - 150, cy - 100));
  for (let i = 0; i <= samples; i++) {
    const a = i / samples * Math.PI * 2;
    canvasEl.dispatchEvent(mk('mousemove', cx + Math.cos(a) * 150, cy + Math.sin(a) * 100));
  }
  canvasEl.dispatchEvent(mk('mouseup', cx + 150, cy));
  // 浏览器在 mouseup 之后还会派发 click —— 用例手动补一发，验证「不会再落一个描点顶点」
  canvasEl.dispatchEvent(mk('click', cx + 150, cy));
  const after = sc.baseMap.terrain.length;
  const prov = sc.baseMap.terrain[after - 1];
  return JSON.stringify({
    before, after, added: after - before,
    verts: prov && prov.points ? prov.points.length : -1,
    drawPointsAfter: sc.drawPoints.length,
    samples,
  });
})()
"""

CLICK_POINT = r"""
(() => {
  const sc = __SC__;
  const canvasEl = document.querySelector('.scenario-map-container canvas');
  const r = canvasEl.getBoundingClientRect();
  const mk = (t, sx, sy) => new MouseEvent(t, { clientX: r.left + sx, clientY: r.top + sy, bubbles: true, cancelable: true, button: 0 });
  const n0 = sc.drawPoints.length;
  canvasEl.dispatchEvent(mk('mousedown', 40, 40));
  canvasEl.dispatchEvent(mk('mouseup', 40, 40));
  canvasEl.dispatchEvent(mk('click', 40, 40));
  return JSON.stringify({ n0, n1: sc.drawPoints.length });
})()
"""


def run(cdp):
    fails = []
    notes = []

    # ── 1. 源码闸门（读磁盘 + 剥注释）────────────────────────────────────────
    try:
        code = _code_only(_read('src/renderer/src/composables/useTerrainCanvasBrush.js'))
        if 'getWorldBounds' not in code:
            fails.append('涂色网格未接入世界范围（useTerrainCanvasBrush 未用 getWorldBounds）→ 仍会有真空区')
        if 'ensureCoverage' not in code:
            fails.append('涂色网格没有「落点越界 → 自动扩网格」的入口（ensureCoverage）')
        if 'beginGridSnapshot' in code or 'endGridStroke' in code:
            fails.append('涂色网格仍用 beginGridSnapshot/endGridStroke：网格扩长后 undo 会抛 RangeError')
    except OSError as e:
        fails.append(f'读不到 useTerrainCanvasBrush.js（{e}）')

    try:
        src = _read('src/renderer/src/composables/planetDrawing.js')
        code = _code_only(src)
        # 高度图渲染整段（hashLabels / heightmapOutlines / heightmapOutlineStats / drawHeightmap）：
        # 不能只切 drawHeightmap 本身 —— 轮廓缓存函数是按顺序写在它前面的（第一版判据就踩了这个坑）
        # 不能在注释上切段：_code_only 已经把注释行剥掉了（第一版判据的坑）
        head, sep, tail = code.partition('function hashLabels')
        body = tail.partition('function drawHeightBrushPreview')[0] if sep else ''
        if not body:
            fails.append('planetDrawing.js 里找不到高度图渲染段（函数名/分段注释变了？）')
        else:
            if 'roundRect' in body:
                fails.append('高度图渲染仍逐格 roundRect → 草绿色方块还在')
            if 'ctx.filter' in body:
                fails.append('高度图渲染仍使用画布滤镜（ctx.filter）→ 每次 fill 都整层重做，会卡死')
            if 'buildLabelOutlines' not in body:
                fails.append('高度图渲染未走矢量轮廓（buildLabelOutlines）')
            if 'HeightmapOutlineStats' not in src and 'heightmapOutlineStats' not in code:
                fails.append('生物群系轮廓缺缓存统计出口（heightmapOutlineStats）')
    except OSError as e:
        fails.append(f'读不到 planetDrawing.js（{e}）')

    try:
        code = _code_only(_read('src/renderer/src/composables/useProvinceBrush.js'))
        if 'roundRect' in code:
            fails.append('省份网格仍逐格 roundRect（格间缝隙 = 用户说的密集恐惧症视图）')
        if 'buildLabelOutlines' not in code:
            fails.append('省份网格未走矢量轮廓')
    except OSError as e:
        fails.append(f'读不到 useProvinceBrush.js（{e}）')

    try:
        code = _code_only(_read('src/renderer/src/store/geodataModules/provinceEditing.js'))
        if 'rawProvinces' not in code or 'toRaw' not in code:
            fails.append('省份栅格化未去响应式（rawProvinces/toRaw）→ 真实库会卡几秒到几十秒')
    except OSError as e:
        fails.append(f'读不到 provinceEditing.js（{e}）')

    try:
        code = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
        for token in ('simplifyClosedTrace', 'freeTraceActive', 'commitFreeTrace', 'tracePath'):
            if token not in code:
                fails.append(f'ScenarioMap 自由绘制接线缺失（{token}）')
    except OSError as e:
        fails.append(f'读不到 ScenarioMap.vue（{e}）')

    # ── A/B. 行星地图 ───────────────────────────────────────────────────────
    r = H.goto_planet(cdp, A('曜川星'))
    if r != 'planet':
        return False, f'导航行星失败 ({r})'
    time.sleep(1.2)
    if H.enter_edit(cdp) != 'ok':
        return False, '进入编辑模式失败'
    time.sleep(0.6)
    H.set_pm_state(cdp, "pm.setInteractionMode('terrain'); true")
    time.sleep(0.8)

    geo = _js(cdp, GRID_GEO.replace('__PM__', PM).replace('__STORE__', STORE))
    if 'ERR' in geo:
        fails.append(f'网格几何探针失败：{geo["ERR"]}')
        return False, ' | '.join(fails)
    if not geo.get('coversWb'):
        fails.append(f'涂色网格未覆盖地图可见范围（网格 {geo["rect"]} vs worldBounds {geo["wb"]}）→ 仍有真空区')
    notes.append(f'A: 网格 {geo["grid"]["cols"]}x{geo["grid"]["rows"]} rect={geo["rect"]} 覆盖 worldBounds={geo["coversWb"]}')

    # 越界落笔：从网格右下角外 3 格处落一笔 → 必须真的写进去，且网格自动扩
    gx = geo['grid']['originX'] + geo['grid']['cols'] * geo['grid']['cell']
    gy = geo['grid']['originY'] + geo['grid']['rows'] * geo['grid']['cell']
    px = round(gx + geo['grid']['cell'] * 3)
    py = round(gy + geo['grid']['cell'] * 3)
    p = _js(cdp, PAINT_AT.replace('__PM__', PM).replace('__X__', str(px)).replace('__Y__', str(py)))
    if 'ERR' in p or p.get('err') or 'before' not in p:
        fails.append(f'越界落笔探针失败：{json.dumps(p, ensure_ascii=False)[:400]}')
    else:
        changed = p['after'] - p['before']
        p['changed'] = changed
        if changed <= 0:
            fails.append(f'网格外落笔静默无效（changed={changed}）→ 隐藏界限还在')
        if not p['grew']:
            fails.append('越界落笔没有扩网格（离边界只有 3 格却未扩张？）')
        # 一条 undo 同时还原几何与像素
        u = _js(cdp, UNDO_ONCE.replace('__PM__', PM))
        back = False
        if 'ERR' in u:
            fails.append(f'撤销探针失败：{u["ERR"]}')
        else:
            g0 = p['geomBefore']
            back = (u['geom']['cols'] == g0['cols'] and u['geom']['rows'] == g0['rows']
                    and abs(u['geom']['originX'] - g0['originX']) < 1e-6
                    and abs(u['geom']['originY'] - g0['originY']) < 1e-6)
            if not back:
                fails.append(f'撤销没有还原网格几何（{u["geom"]} vs {g0}）→ 数据会与几何错位')
            if u['painted'] != p['before']:
                fails.append(f'撤销没有还原像素（painted {u["painted"]} vs {p["before"]}）')
        notes.append(f'A: 越界落笔 changed={p["changed"]} 扩网格={p["grew"]}；一条 undo 还原几何={back}')

    # 高度图（生物群系层）：源码之外再看真实渲染成本
    _js(cdp, SET_MODE.replace('__PM__', PM).replace('__MODE__', "'height'"))
    time.sleep(0.8)
    f_on = _js(cdp, FRAMES.replace('__PM__', PM).replace('__N__', '6'))
    hm = _js(cdp, HM_STATS.replace('__PM__', PM))
    if 'ERR' in hm or not hm.get('stats'):
        fails.append(f'生物群系轮廓统计读不到：{hm}')
    else:
        if hm['stats']['loops'] <= 0:
            fails.append('生物群系轮廓环数为 0（渲染管线断了 / 层变空了）')
        if hm['stats']['cost'] >= HEIGHT_OUTLINE_LIMIT:
            fails.append(f'生物群系轮廓重建 {hm["stats"]["cost"]}ms 过慢（上限 {HEIGHT_OUTLINE_LIMIT}ms）')
        if f_on.get('mid', 999) >= FRAME_MID_LIMIT:
            fails.append(f'高度图模式中位帧 {f_on["mid"]}ms ≥ {FRAME_MID_LIMIT}ms（旧实现实测 66ms）→ 仍会卡')
        notes.append(f'B: 高度图模式中位帧 {f_on["mid"]}ms（旧实现 66ms）；轮廓 {hm["stats"]["loops"]} 环 / '
                     f'{hm["stats"]["cost"]}ms；群系种类 {len(hm.get("hist", {}))}')

    _js(cdp, SET_MODE.replace('__PM__', PM).replace('__MODE__', "'pan'"))
    time.sleep(0.5)

    # ── C. 历史剧本底图 ─────────────────────────────────────────────────────
    cdp.eval(STORE + ".backToWorld(); 'ok'")
    time.sleep(0.8)
    cdp.eval("""(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent || '').includes('历史剧本'));
      if (b) b.click(); return 'ok';
    })()""")
    try:
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式挂载')
    except RuntimeError as e:
        fails.append(f'剧本模式未挂载：{e}')
        return False, ' | '.join(fails)
    time.sleep(1.5)
    # 🔴 2026-10-02：新建省份现在带**压叠闸门**（新省压住已有省 >25% 时弹确认，见 test_79）。
    #    本用例这一段的自由绘制/描点**刻意画在 6 个合成省份上面** → 会弹确认；
    #    headless 下没人点它 → **渲染进程被模态对话框阻塞** → CDP 命令永不返回
    #    （实测症状就是「异常: Connection timed out」，而不是某条断言红）。
    #    所以这里按本仓惯例先把 confirm/prompt 打桩（用例要测「取消」时再单独覆盖）。
    cdp.eval("window.confirm = () => true; window.prompt = (m, d) => d;")

    fx = _js(cdp, SC_FIXTURE.replace('__STORE__', STORE).replace('__SC__', SC))
    if 'ERR' in fx:
        fails.append(f'底图 fixture 失败：{fx["ERR"]}')
    else:
        if fx['rebuildMs'] >= RASTERIZE_LIMIT:
            fails.append(f'省份栅格化 {fx["rebuildMs"]}ms ≥ {RASTERIZE_LIMIT}ms（走响应式代理时实测 838.6ms）')
        if fx['owned'] <= 0:
            fails.append(f'栅格化后没有归属格（owned={fx["owned"]}）')
        notes.append(f'C: 6 省 3600 点栅格化 {fx["rebuildMs"]}ms（旧实现 838.6ms）/ 网格 {fx["grid"]} / 有主格 {fx["owned"]}')

    time.sleep(0.8)
    cdp.eval(SC + ".setTool('provinceBrush'); 'ok'")
    time.sleep(0.6)
    mesh = _js(cdp, SC_MESH.replace('__SC__', SC).replace('__STORE__', STORE))
    if 'ERR' in mesh:
        fails.append(f'网格渲染探针失败：{mesh["ERR"]}')
    else:
        if not mesh.get('meshOn'):
            fails.append('涂抹中网格中间层未就绪（provinceMeshOn 为假）')
        if mesh['stats']['loops'] <= 0:
            fails.append('涂抹中网格轮廓环数为 0（内部中间层画不出东西）')
        notes.append(f'C: 涂抹中网格单帧 {mesh["meshRenderMs"]}ms / 轮廓 {mesh["stats"]["loops"]} 环 '
                     f'{mesh["stats"]["pts"]} 点（重建 {mesh["stats"]["cost"]}ms）')

    # 自由绘制（一笔成型）+ 描点仍在
    fd = _js(cdp, FREE_DRAW.replace('__SC__', SC))
    if 'ERR' in fd:
        fails.append(f'自由绘制探针失败：{fd["ERR"]}')
    else:
        if fd['added'] != 1:
            fails.append(f'自由绘制没有一笔成型（新增省份 {fd["added"]} 个）')
        elif fd['verts'] < 3 or fd['verts'] > fd['samples'] // 2:
            fails.append(f'自由绘制没有走简化（{fd["samples"]} 个采样 → {fd["verts"]} 个顶点）')
        if fd['drawPointsAfter'] != 0:
            fails.append(f'自由绘制成型后仍落了一个描点顶点（drawPoints={fd["drawPointsAfter"]}）')
        notes.append(f'C: 自由绘制 {fd["samples"]} 采样 → {fd["verts"]} 顶点（简化生效）')

    cp = _js(cdp, CLICK_POINT.replace('__SC__', SC))
    if 'ERR' in cp:
        fails.append(f'描点探针失败：{cp["ERR"]}')
    elif cp['n1'] != cp['n0'] + 1:
        fails.append(f'单击描点能力被破坏（{cp["n0"]} → {cp["n1"]}）')

    if fails:
        return False, ' | '.join(fails)
    return True, '；'.join(notes)
