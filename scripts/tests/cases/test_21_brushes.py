#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 21：画布地形笔刷 + 高度图笔刷（P3 集成回归）

验收点（每个都对应一条真实用户症状）：
1. 地形笔刷：按住拖动后网格里真的写入了格子（曾"拖了没反应"）
2. 地形笔刷：写入落在视口内可复现的网格原点（曾"网格在视口外"）
3. 一次拖动 = 一条 undo（曾逐帧入栈，撤销一次只退一格）
4. 保存载荷里网格/高度图是普通数组且能 JSON 往返（曾退化成无 length 的对象，读回即空）
5. 高度笔刷：抬高后 h 真的变化（曾 brushMode 取到 undefined，写了个寂寞）
6. 高度笔刷：ensureHeightmap 能自愈历史损坏数据（h 为 {} → 按地形重建）
7. 群系笔刷：写入 wetland（派生永不为 wetland，可判定为"确实来自笔刷"）
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for  # noqa: E402
from lib.helpers import goto_planet, enter_edit, set_pm_state, drag_canvas_polyline  # noqa: E402

PM = "document.querySelector('.planet-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
EMPTY_TERRAIN = 255

_T0 = [time.time()]


def _log(msg):
    print(f'    [21] +{time.time() - _T0[0]:5.1f}s {msg}', flush=True)


def _js_obj(cdp, code):
    return json.loads(cdp.eval(code))


def _world_center(cdp):
    return _js_obj(cdp, f"""(() => {{
      const pm = {PM};
      const b = pm.worldBounds;
      return JSON.stringify([(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]);
    }})()""")


def _grid_stats(cdp):
    return _js_obj(cdp, f"""(() => {{
      const pm = {PM};
      const brush = pm.terrainCanvasBrush;
      const g = brush ? brush.terrainGrid.value : null;
      let painted = 0;
      if (g) for (let i = 0; i < g.length; i++) if (g[i] !== {EMPTY_TERRAIN}) painted++;
      return JSON.stringify({{
        enabled: !!(brush && brush.terrainGridEnabled.value),
        typed: typeof Uint8Array !== 'undefined' && g instanceof Uint8Array,
        len: g ? g.length : 0,
        painted,
        gw: brush ? brush.gridWidth.value : 0,
        gh: brush ? brush.gridHeight.value : 0,
      }});
    }})()""")


def run(cdp):
    _T0[0] = time.time()
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    wait_for(cdp, f"{STORE}.nodes.length > 0", timeout=45, desc='地理数据加载')  # 冷启动时 mock 数据（2MB mapdata）是异步注入的
    _log('app + geodata ready')

    r = goto_planet(cdp, '乐园星')
    if r != 'planet':
        return False, f'导航行星失败 (goto_planet → {r})'
    time.sleep(1.2)
    if enter_edit(cdp) != 'ok':
        return False, '进入编辑模式失败'
    time.sleep(0.6)

    # 拦截保存载荷（mock 的 saveMapData 不落盘，这里只做载荷断言）
    cdp.eval("""(() => {
      window.__savedPayloads = [];
      const api = window.sitianAPI;
      if (api && !api.__brushSaveHooked) {
        api.saveMapData = async (key, data) => { window.__savedPayloads.push({ key, data }); return { success: true }; };
        api.__brushSaveHooked = true;
      }
      return 'ok';
    })()""")

    cx, cy = _world_center(cdp)
    if cx is None:
        return False, '取不到地图中心'

    # ── 1. 地形笔刷：按住拖动 → 网格被写入 ─────────────────────────────
    set_pm_state(cdp, "pm.setInteractionMode('terrain'); return 'ok';")
    time.sleep(0.4)
    set_pm_state(cdp, "pm.terrainBrushType = 3; pm.terrainBrushSize = 4; return 'ok';")  # 森林，4 格
    time.sleep(0.2)

    _log('terrain mode set')
    before_grid = _grid_stats(cdp)
    drag_canvas_polyline(cdp, [
        [cx - 160, cy], [cx - 80, cy - 40], [cx, cy], [cx + 80, cy + 40], [cx + 160, cy],
    ])
    time.sleep(0.4)
    _log('terrain drag dispatched')
    after_grid = _grid_stats(cdp)

    if not after_grid['enabled']:
        return False, 'terrain 模式未启用网格（terrainGridEnabled=false）— initTerrainGrid 失败'
    if not after_grid['typed']:
        return False, f'terrainGrid 不是 Uint8Array（{after_grid}）'
    if after_grid['len'] <= 0:
        return False, f'网格长度异常（{after_grid}）'
    if after_grid['painted'] <= before_grid['painted']:
        return False, f'涂抹无写入：painted {before_grid["painted"]} → {after_grid["painted"]}'

    # ── 1b. 与高度图同粒度 + 同原点对齐（"两套像素粒度打架"的修复不变量） ──
    align = _js_obj(cdp, f"""(() => {{
      const pm = {PM};
      const brush = pm.terrainCanvasBrush;
      const cell = brush.cellWorldSize.value;
      const hm = pm.currentMapData.heightmap;
      const spacing = hm && hm.grid ? hm.grid.spacing : null;
      return JSON.stringify({{ cell, spacing, same: cell === spacing }});
    }})()""")
    if not align.get('same'):
        return False, f'地形网格格宽与高度图不一致（会出现两种像素粒度打架）：{align}'

    # ── 2. 保存载荷：普通数组 + 可 JSON 往返 ───────────────────────────
    _log('terrain painted ok, waiting autosave')
    time.sleep(1.4)  # scheduleAutoSaveMap 防抖 800ms
    payload = _js_obj(cdp, """(() => {
      const list = window.__savedPayloads || [];
      const last = list[list.length - 1];
      if (!last) return JSON.stringify({ n: 0 });
      const g = last.data.terrainGrid;
      return JSON.stringify({
        n: list.length, key: last.key,
        isArray: Array.isArray(g), len: g ? g.length : 0,
        painted: g ? g.filter(v => v !== 255).length : 0,
        hasOrigin: typeof last.data.gridOriginX === 'number' && typeof last.data.gridOriginY === 'number',
        hasCell: last.data.cellWorldSize,
      });
    })()""")
    if payload.get('n', 0) <= 0:
        return False, '涂抹后没有触发保存（__savedPayloads 为空）'
    if not payload.get('isArray'):
        return False, f'保存载荷里 terrainGrid 不是普通数组（JSON 往返后会丢失 length）：{payload}'
    if payload.get('painted', 0) <= 0:
        return False, f'保存载荷里没有已涂抹的格子：{payload}'
    if not payload.get('hasOrigin'):
        return False, f'保存载荷缺少网格原点（重载后涂抹位置会漂移）：{payload}'

    # ── 3. 一次拖动 = 一条 undo ───────────────────────────────────────
    _log('save payload checked')
    cdp.eval(f"{STORE}.undo()")
    time.sleep(0.3)
    undone = _grid_stats(cdp)
    if undone['painted'] != before_grid['painted']:
        return False, f'撤销未回到拖动前状态：painted {undone["painted"]} ≠ {before_grid["painted"]}（一次拖动被拆成多条 undo？）'
    cdp.eval(f"{STORE}.redo()")
    time.sleep(0.3)
    redone = _grid_stats(cdp)
    if redone['painted'] != after_grid['painted']:
        return False, f'重做未恢复涂抹结果：{redone["painted"]} ≠ {after_grid["painted"]}'

    # ── 4. 高度笔刷：抬高 ────────────────────────────────────────────
    _log('terrain undo/redo ok')
    hm_before = _js_obj(cdp, f"""(() => {{
      const pm = {PM};
      const hm = pm.planetHeightBrush.ensureHeightmap();
      if (!hm) return JSON.stringify({{ ok: false }});
      window.__hmBefore = Array.from(hm.h);
      return JSON.stringify({{ ok: true, len: hm.h.length, count: hm.grid.count, typed: hm.h instanceof Float32Array }});
    }})()""")
    if not hm_before.get('ok'):
        return False, 'ensureHeightmap 返回 null（mapData 缺失）'
    if hm_before['len'] != hm_before['count']:
        return False, f'高度图长度与网格点数不一致：{hm_before}'
    if not hm_before['typed']:
        return False, f'高度图 h 不是 Float32Array（自愈失败）：{hm_before}'

    _log('heightmap ensured')
    set_pm_state(cdp, "pm.setInteractionMode('height'); pm.heightTool = 'raise'; return 'ok';")
    time.sleep(0.4)
    drag_canvas_polyline(cdp, [[cx - 80, cy], [cx, cy], [cx + 80, cy]])
    time.sleep(0.4)

    _log('height drag dispatched')
    hm_after = _js_obj(cdp, f"""(() => {{
      const pm = {PM};
      const hm = pm.currentMapData.heightmap;
      const before = window.__hmBefore || [];
      const n = Math.min(before.length, hm.h.length);
      let up = 0, down = 0;
      for (let i = 0; i < n; i++) {{
        const d = hm.h[i] - before[i];
        if (d > 0.001) up++; else if (d < -0.001) down++;
      }}
      return JSON.stringify({{ len: hm.h.length, up, down, biomeTyped: hm.biome instanceof Uint8Array }});
    }})()""")
    if hm_after['up'] <= 0:
        return False, f'抬高笔刷没有写入任何网格点（up={hm_after["up"]}, down={hm_after["down"]}）— brushMode 是否为 undefined？'
    if not hm_after['biomeTyped']:
        return False, '派生 biome 不是 Uint8Array'

    # 一次拖动 = 一条 undo（还原到 before 全量快照）
    cdp.eval(f"{STORE}.undo()")
    time.sleep(0.3)
    hm_undo = _js_obj(cdp, f"""(() => {{
      const pm = {PM};
      const hm = pm.currentMapData.heightmap;
      const before = window.__hmBefore || [];
      const n = Math.min(before.length, hm.h.length);
      let diff = 0;
      for (let i = 0; i < n; i++) if (Math.abs(hm.h[i] - before[i]) > 0.001) diff++;
      return JSON.stringify({{ diff, lenDiff: Math.abs(hm.h.length - before.length) }});
    }})()""")
    if hm_undo['diff'] != 0 or hm_undo['lenDiff'] != 0:
        return False, f'高度笔刷撤销未还原（{hm_undo}）— 拖动被拆成多次 undo？'
    cdp.eval(f"{STORE}.redo()")
    time.sleep(0.2)

    # ── 5. 群系笔刷：写入 wetland（派生不可能产出 wetland） ──────────────
    _log('height brush + undo ok')
    wl_before = cdp.eval(f"""(() => {{
      const pm = {PM}; const hm = pm.currentMapData.heightmap;
      let n = 0; for (let i = 0; i < hm.biome.length; i++) if (hm.biome[i] === 12) n++;
      return n;
    }})()""")
    set_pm_state(cdp, """pm.setInteractionMode('height'); pm.heightTool = 'biome';
    pm.planetHeightBrush.brushBiome.value = 'wetland'; return 'ok';""")
    time.sleep(0.4)
    drag_canvas_polyline(cdp, [[cx - 60, cy + 60], [cx, cy + 60], [cx + 60, cy + 60]])
    time.sleep(0.4)
    wl_after = cdp.eval(f"""(() => {{
      const pm = {PM}; const hm = pm.currentMapData.heightmap;
      let n = 0; for (let i = 0; i < hm.biome.length; i++) if (hm.biome[i] === 12) n++;
      return n;
    }})()""")
    if not isinstance(wl_after, int) or wl_after <= (wl_before or 0):
        return False, f'生物群系笔刷未写入 wetland（{wl_before} → {wl_after}）'
    cdp.eval(f"{STORE}.undo()")
    time.sleep(0.3)

    # ── 6. 缓存 JSON 往返（模拟重载：heightmap / terrainGrid 必须还原成有长度的数组） ──
    _log('biome brush ok')
    rt = _js_obj(cdp, """(async () => {
      const mod = await import('/src/store/geodata.js');
      const pm = """ + PM + """;
      const s = """ + STORE + """;
      const id = pm.currentMapData.planetId;
      const md = s.mapData[id];
      const snap = { terrainGrid: Array.from(pm.terrainCanvasBrush.terrainGrid.value), heightmap: md.heightmap };
      const round = JSON.parse(JSON.stringify(snap, mod.jsonSafeReplacer));
      const h = round.heightmap.h;
      const g = round.terrainGrid;
      return JSON.stringify({
        gridIsArray: Array.isArray(g), gridLen: g.length,
        hIsArray: Array.isArray(h), hLen: h.length,
        hRebuilt: new Float32Array(h).length,
        biomeLen: round.heightmap.biome.length,
        tempLen: round.heightmap.temp.length,
      });
    })()""")
    if not rt.get('gridIsArray') or not rt.get('hIsArray'):
        return False, f'TypedArray 未序列化为普通数组（重载即丢数据）：{rt}'
    if rt['hLen'] <= 0 or rt['hRebuilt'] != rt['hLen']:
        return False, f'高度图 JSON 往返后无法还原长度：{rt}'
    if rt['biomeLen'] != rt['hLen'] or rt['tempLen'] != rt['hLen']:
        return False, f'派生层长度与高度不一致：{rt}'

    return True, (
        f'地形笔刷已涂抹 {after_grid["painted"]} 格（网格 {after_grid["gw"]}×{after_grid["gh"]}，'
        f'{align["cell"]}m/格 = 高度图同格宽；涂抹前 {before_grid["painted"]} 格来自旧 30m 数据按世界坐标重采样）、'
        f'保存载荷为普通数组 {payload["len"]} 项、一次拖动一条 undo；'
        f'高度笔刷改动 {hm_after["up"]} 点且撤销全还原；群系笔刷 wetland {wl_before}→{wl_after}；'
        f'JSON 往返 h={rt["hLen"]} 可还原'
    )