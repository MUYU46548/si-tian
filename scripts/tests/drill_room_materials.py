#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机演练：房间地面材质 + 吊顶（A23 / A15，2026-11-15）

验的不是“代码里有 floorPatterns 这个模块”，是**画面真的变了**，而且变的是被改的那一块：

平面图（2D）
  1) 两间房都设“纯色” → 出基线；
  2) 大厅改木地板、卧室改瓷砖 → **同视图**再出一张：必须大面积不同（阈值 12%）；
  3) 负向探针：同一设置连出两张必须**逐像素一致**（否则第 2 条的差异不算数）；
  4) 给大厅加吊顶（石膏板 2.40m）→ 差异必须出现（虚线框 + 净高注记，阈值 300 像素）；
  5) 去掉吊顶 → 差异幅度与第 4 条相当（对称性检验，防“加得上、去不掉”）；
  6) 回读 store：材质 / 吊顶字段真的写进去了；再走一次 undo → 吊顶回去（一条撤销）。

3D（外观）
  7) 只看一层 + 不封顶：一层两间房“纯色” → 基线；改成木地板/瓷砖 → 差异必须出现（阈值 2%）；
  8) 全部楼层·不封顶：吊顶关 → 开：顶层那间房被吊顶盖住，差异必须出现（阈值 3%）；
  9) 顶栏统计出现“间房铺了地面”“间吊顶”；切到只看某层时吊顶开关自动关掉（那是这个视图的前提）。

⚠️ 三个只能真机才现形的点（都踩过）：
   · `Page.captureScreenshot` 抓不到**2D 画布**内容（1440×900 只 7KB）→ 2D 一律 `canvas.toDataURL`；
   · headless 下 rAF 会被节流，改完数据 `requestRender()` 不保证出帧 → 每次拍 2D 前**切层再切回**重建；
   · 两次 2D 截图都必须在**切层之后**（切层会重新 fit，视图参数一变整幅就差 60%+）。

产物：`build/room-materials/`（2D 基线 / 材质 / 吊顶 + 3D 对照 + diff 热图）。
用法：python scripts/tests/drill_room_materials.py
"""
import base64
import json
import os
import sys
import time

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'lib'))
sys.path.insert(0, os.path.dirname(__file__))

import drill_exterior_3d as D                                   # noqa: E402  复用起环境/造房子
from lib.cdp import CDP, APP_URL, find_page_ws, skip_onboarding, wait_for, fetch_string  # noqa: E402
from lib.helpers import open_harness_project, ensure_data_ready, ensure_test_building  # noqa: E402
import run_tests as RT                                           # noqa: E402  setup_mock

OUT_DIR = os.path.join(D.ROOT, 'build', 'room-materials')
BID = ''


def log(msg):
    print(msg, flush=True)


def eval_json(cdp, expr):
    return D.eval_json(cdp, expr)


# ── 2D 取图（canvas.toDataURL；切层强制重建）──────────────────────────────
def snap2d(cdp, name):
    eval_json(cdp, """(() => {
      const iv = %s, s = %s, bid = %s;
      const d = s.interiorData[bid];
      if (!d || !(d.floors || []).length) return JSON.stringify({ err: 'no-floor' });
      const cur = iv.currentFloorId;
      const other = d.floors.map((f) => f.id).find((id) => id !== cur);
      if (other) iv.selectFloor(other);
      iv.selectFloor(cur);
      return JSON.stringify({ ok: true });
    })()""" % (D.IV, D.STORE, json.dumps(BID)))
    time.sleep(0.8)
    cdp.eval("window.__shot = document.querySelector('.interior-container canvas').toDataURL('image/png'); 1")
    b64 = fetch_string(cdp, 'window.__shot.length',
                       lambda i, j: 'window.__shot.slice(%d, %d)' % (i, j),
                       desc='%s canvas' % name)
    if not isinstance(b64, str) or ',' not in b64:
        raise RuntimeError('拿不到画布内容：%s' % name)
    raw = base64.b64decode(b64.split(',', 1)[1])
    path = os.path.join(OUT_DIR, '%s.png' % name)
    with open(path, 'wb') as f:
        f.write(raw)
    log('   · %s（%.0f KB）' % (os.path.basename(path), len(raw) / 1024.0))
    return path


def diff(a_path, b_path, tag):
    ia = Image.open(a_path).convert('RGB')
    ib = Image.open(b_path).convert('RGB')
    if ia.size != ib.size:
        return {'ok': False, 'err': '尺寸不同 %s vs %s' % (ia.size, ib.size)}
    a = np.asarray(ia, dtype=np.int16)
    b = np.asarray(ib, dtype=np.int16)
    d = np.abs(a - b)
    mask = d.max(axis=2) > 6
    ys, xs = np.where(mask)
    bbox = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())] if len(xs) else None
    vis = np.full_like(a, 255, dtype=np.uint8)
    vis[mask] = [220, 60, 60]
    heat = os.path.join(OUT_DIR, 'diff-%s.png' % tag)
    Image.fromarray(vis).save(heat)
    return {
        'ok': True, 'ratio': float(mask.mean()), 'px': int(mask.sum()),
        'total': int(mask.size), 'maxdiff': int(d.max()), 'bbox': bbox, 'heat': heat,
    }


# ── store 写口 ────────────────────────────────────────────────────────────
def make_rooms(cdp, bid):
    """两间房（一层）+ 一间房（二层）。坐标是 cm，留 24cm 墙厚。

    为什么不靠自动围合：这份演练要的是**确定的两间房**，自动围合在无头环境里
    受重算钩子时序影响（组件挂载顺序不同，结果可能是 0 间）——那是环境噪音，不是被测物。
    """
    expr = """(() => {
      const s = %s, bid = %s;
      const d = s.interiorData[bid];
      if (!d || d.floors.length < 2) return JSON.stringify({ err: 'need-two-floors' });
      const f1 = d.floors[0], f2 = d.floors[1];
      s.setFloorRooms(bid, f1.id, [
        { id: 'room_hall', name: '大厅', walls: [], floorTexture: 'none', cx: 266, cy: 325,
          polygon: [{x:24,y:24},{x:508,y:24},{x:508,y:626},{x:24,y:626}] },
        { id: 'room_bed', name: '卧室', walls: [], floorTexture: 'none', cx: 704, cy: 325,
          polygon: [{x:532,y:24},{x:876,y:24},{x:876,y:626},{x:532,y:626}] },
      ]);
      s.setFloorRooms(bid, f2.id, [
        { id: 'room_study', name: '书房', walls: [], floorTexture: 'stone', cx: 450, cy: 325,
          polygon: [{x:24,y:24},{x:876,y:24},{x:876,y:626},{x:24,y:626}] },
      ]);
      const dd = s.interiorData[bid];
      return JSON.stringify({
        floors: dd.floors.length,
        rooms: dd.floors.map((f) => (f.rooms || []).map((r) => ({ id: r.id, t: r.floorTexture }))),
      });
    })()""" % (D.STORE, json.dumps(bid))
    return eval_json(cdp, expr)


def set_material(cdp, floor_idx, room_id, patch):
    expr = """(() => {
      const s = %s, bid = %s;
      const d = s.interiorData[bid];
      const f = d.floors[%d];
      const res = s.setRoomMaterial(bid, f.id, %s, %s);
      const room = (s.interiorData[bid].floors[%d].rooms || []).find((r) => r.id === %s) || {};
      return JSON.stringify({ res, floorTexture: room.floorTexture || null, ceiling: room.ceiling || null });
    })()""" % (D.STORE, json.dumps(BID), floor_idx, json.dumps(room_id), json.dumps(patch),
                floor_idx, json.dumps(room_id))
    return eval_json(cdp, expr)


def undo_once(cdp):
    """走**应用自己的**撤销入口（`store.undo()`）。

    ⚠️ 不能 `import('/src/store/undo.js')` 再调 `undo()`：那是另一次模块求值，
    拿到的是**另一份历史栈**（实测 `canUndo=false`、栈顶为空，而画面上明明刚改过）——
    `geodata.js` 里 `undo()` 转调的就是同一个 store，走它才是 Ctrl+Z 那条路。
    """
    return eval_json(cdp, """(() => {
      const s = %s, bid = %s;
      const read = () => {
        const f = s.interiorData[bid].floors[0];
        const room = (f.rooms || []).find((r) => r.id === 'room_hall') || {};
        return room.ceiling || null;
      };
      const before = read();
      const canUndo = typeof s.canUndo === 'boolean' ? s.canUndo : null;
      s.undo();
      const after = read();
      return JSON.stringify({ before, after, canUndo });
    })()""" % (D.STORE, json.dumps(BID)))


def renders(cdp):
    """外观视图本次打开累计画了多少帧（按需渲染：静止时不涨）。"""
    return eval_json(cdp, """(() => {
      const el = document.querySelector('[data-testid=exterior-view]');
      const st = el && el.__vueParentComponent && el.__vueParentComponent.exposed;
      return JSON.stringify(st ? { renders: st.getStats().renders } : { err: 'no-exposed' });
    })()""")


def kick3d(cdp):
    """强制 3D 出一帧。

    headless 下 rAF 会停：`rebuild()` 换了场景（统计条都变了），画面却还停在上一帧 ——
    实测两张截图 **0 像素差**，看起来像“材质没接进 3D”，其实是根本没渲染。
    根因在 `startLoop()`：`raf` 里挂着一个**永远不触发的帧**时，后续每次 `startLoop()` 都直接 return。
    这里直接调组件自己的 `tick()`（它会先 `raf = 0` 再渲染），既有像素也不会被阻尼改机位。
    """
    return eval_json(cdp, """(() => {
      const el = document.querySelector('[data-testid=exterior-view]');
      const inst = el && el.__vueParentComponent;
      const st = inst && inst.setupState;
      if (!st || typeof st.tick !== 'function') return JSON.stringify({ err: 'no-tick' });
      const before = (inst.exposed.getStats() || {}).renders || 0;
      let n = 0;
      for (let i = 0; i < 2; i++) { try { st.tick(); n++; } catch (e) { return JSON.stringify({ err: 'tick:' + e.message, n }); } }
      const after = (inst.exposed.getStats() || {}).renders || 0;
      return JSON.stringify({ ok: true, n, before, after, delta: after - before });
    })()""")


def set_top_view(cdp):
    """把相机压成“俯视”：房间地面朝上，斜 26° 的默认机位里它基本被墙挡着（实测只有 0.1% 差异）。

    相机是**每次拍之前都重设成同一组数值**，所以 A/B 两张的可比性不受影响。
    """
    return eval_json(cdp, """(() => {
      const el = document.querySelector('[data-testid=exterior-view]');
      const inst = el && el.__vueParentComponent;
      const st = inst && inst.setupState;
      if (!st || !st.camera || !st.controls) return JSON.stringify({ err: 'no-camera' });
      const t = st.controls.target;
      const b = (st.lastShell && st.lastShell.bounds) || null;
      const span = b ? Math.max(b.size[0], b.size[2], 400) : 1200;
      st.camera.position.set(t.x + span * 0.18, t.y + span * 1.5, t.z + span * 0.42);
      st.camera.near = Math.max(0.5, span / 500);
      st.camera.far = span * 20;
      st.camera.updateProjectionMatrix();
      st.controls.update();
      return JSON.stringify({ ok: true, span });
    })()""")


def shot3d(cdp, name):
    """拍 3D（Page.captureScreenshot）：先压成俯视 → 踢出真帧 → 拍，并报告新增帧数。"""
    set_top_view(cdp)
    k = kick3d(cdp)
    if k.get('err'):
        # 拿不到 setupState（生产构建）时退化为拖一下就松（会轻微改机位，A/B 仍同向可比）
        D.drag(cdp, 700, 500, 706, 502, steps=2)
        time.sleep(0.8)
        k = {'delta': 'drag', 'err': k.get('err')}
    time.sleep(0.35)
    path, stats = D.shot(cdp, name)
    log('   · %s（新增帧 %s）' % (os.path.basename(path), k.get('delta')))
    return path, {'renders_delta': k.get('delta'), 'kick': k, 'stats': stats}


def probe3d(cdp, tag=''):
    """内省 3D 组件内部：几何到底有没有进场景（0 像素时靠它定位，不靠猜）。"""
    out = eval_json(cdp, """(() => {
      const el = document.querySelector('[data-testid=exterior-view]');
      const inst = el && el.__vueParentComponent;
      const st = inst && inst.setupState;
      if (!st) return JSON.stringify({ err: 'no-setup' });
      const shell = st.lastShell || null;
      const bg = st.buildingGroup || null;
      const kids = bg ? bg.children.map((c) => ({
        type: c.type,
        verts: c.geometry && c.geometry.attributes && c.geometry.attributes.position
          ? c.geometry.attributes.position.count : null,
        instanced: c.isInstancedMesh ? c.count : null,
      })) : null;
      return JSON.stringify({
        ceilingsOn: st.ceilingsOn,
        surfaces: shell ? (shell.surfaces || []).length : null,
        stats: shell ? { rooms: shell.stats.roomFloors, ceil: shell.stats.ceilings, boxes: shell.stats.boxes } : null,
        children: kids,
      });
    })()""")
    log('  · 内省[%s]：%s' % (tag, json.dumps(out, ensure_ascii=False)))
    return out


def set_roof(cdp, kind):
    return D.eval_json(cdp, """(() => {
      const sel = document.querySelector('[data-testid=exterior-roof-kind]');
      if (!sel) return JSON.stringify({ err: 'no-select' });
      sel.value = %s;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return JSON.stringify({ ok: true });
    })()""" % json.dumps(kind))


def set_floor_pick(cdp, value):
    out = D.eval_json(cdp, """(() => {
      const sel = document.querySelector('[data-testid=exterior-floor-pick]');
      if (!sel) return JSON.stringify({ err: 'no-select' });
      sel.value = %s;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return JSON.stringify({ ok: true });
    })()""" % json.dumps(value))
    time.sleep(1.0)
    return out


def set_ceilings(cdp, on):
    """勾/去勾“吊顶”。收框要用真实 click（v-model 走 change 事件），勾完等一拍再读。"""
    out = D.eval_json(cdp, """(() => {
      const box = document.querySelector('[data-testid=exterior-ceilings]');
      if (!box) return JSON.stringify({ err: 'no-checkbox' });
      if (box.disabled) return JSON.stringify({ err: 'disabled', title: box.getAttribute('title') });
      if (box.checked !== %s) box.click();
      return JSON.stringify({ ok: true, checked: box.checked });
    })()""" % ('true' if on else 'false'))
    time.sleep(1.2)
    out['checked'] = cdp.eval("(document.querySelector('[data-testid=exterior-ceilings]')||{}).checked")
    out['stats'] = cdp.eval("(document.querySelector('[data-testid=exterior-stats]')||{}).textContent || ''")
    return out


def main():
    global BID
    os.makedirs(OUT_DIR, exist_ok=True)
    handles = []
    edge = None
    cdp = None
    fails = []
    checks = []

    def expect(cond, msg, detail=''):
        checks.append({'ok': bool(cond), 'msg': msg, 'detail': detail})
        if cond:
            log('  ✅ %s%s' % (msg, ('  —— %s' % detail) if detail else ''))
        else:
            log('  ❌ %s%s' % (msg, ('  —— %s' % detail) if detail else ''))
            fails.append(msg + (('：%s' % detail) if detail else ''))

    try:
        log('• 起环境')
        RT.setup_mock()
        D.ensure_vite(handles)
        edge = D.start_edge()
        handles.append(edge)
        cdp = CDP(ws_url=find_page_ws(D.PORT, prefer_prefix='http://localhost:5180'))
        cdp.send('Page.enable')
        cdp.send('Emulation.setDeviceMetricsOverride', {
            'width': 1440, 'height': 900, 'deviceScaleFactor': 1, 'mobile': False,
        })
        cdp.navigate(APP_URL)
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=45, desc='应用挂载')
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate(APP_URL)
        wait_for(cdp, "!document.querySelector('.onboarding-overlay')", timeout=30, desc='引导层已退')
        skip_onboarding(cdp)
        ensure_data_ready(cdp)
        ok, info = open_harness_project(cdp)
        if not ok:
            raise RuntimeError('harness 基线项目打不开：%s' % info)
        okb, binfo = ensure_test_building(cdp)
        if not okb:
            raise RuntimeError('建筑 fixture 失败：%s' % binfo)
        BID = binfo['id']
        wait_for(cdp, "!!document.querySelector('.interior-container')", timeout=30, desc='内部视图')
        cdp.eval("window.__exErrs = []; window.addEventListener('error', (e) => window.__exErrs.push(String(e.message || e))); 1")

        log('• 造楼 + 两间房')
        house = D.build_house(cdp, BID)
        log('  · 楼：%s' % json.dumps(house, ensure_ascii=False))
        rooms = make_rooms(cdp, BID)
        log('  · 房间：%s' % json.dumps(rooms, ensure_ascii=False))
        expect(len(rooms.get('rooms', [])) == 2 and len(rooms['rooms'][0]) == 2,
               '一层两间房已建好', 'rooms=%s' % json.dumps(rooms.get('rooms')))

        # ── 2D：材质 ───────────────────────────────────────────────
        log('• 2D · 纯色基线')
        a = snap2d(cdp, '01-2d-plain')
        log('• 2D · 大厅木地板 / 卧室瓷砖')
        r1 = set_material(cdp, 0, 'room_hall', {'floorTexture': 'wood'})
        r2 = set_material(cdp, 0, 'room_bed', {'floorTexture': 'tile'})
        expect(r1.get('floorTexture') == 'wood' and r2.get('floorTexture') == 'tile',
               '材质写进了 store', 'hall=%s bed=%s' % (r1.get('floorTexture'), r2.get('floorTexture')))
        b = snap2d(cdp, '02-2d-materials')
        d1 = diff(a, b, '2d-plain-vs-materials')
        log('  · 差异 %.2f%%（%s px）' % (d1['ratio'] * 100, d1['px']))
        expect(d1['ratio'] > 0.12, '平面图上材质占满两间房', '%.2f%% > 12%%' % (d1['ratio'] * 100))

        log('• 2D · 负向探针（同设置连拍）')
        b2 = snap2d(cdp, '03-2d-materials-again')
        dneg = diff(b, b2, '2d-deterministic')
        log('  · 复拍差异 %s px' % dneg['px'])
        expect(dneg['px'] == 0, '同参数连拍逐像素一致（前面的差异不是噪声）', '%s px' % dneg['px'])

        # ── 2D：吊顶 ───────────────────────────────────────────────
        log('• 2D · 大厅加吊顶')
        r3 = set_material(cdp, 0, 'room_hall', {'ceiling': {'texture': 'plaster', 'height': 240}})
        expect((r3.get('ceiling') or {}).get('height') == 240, '吊顶写进了 store', json.dumps(r3.get('ceiling')))
        c = snap2d(cdp, '04-2d-ceiling')
        d2 = diff(b, c, '2d-ceiling-on')
        log('  · 差异 %s px（%.3f%%）' % (d2['px'], d2['ratio'] * 100))
        expect(d2['px'] >= 300, '吊顶虚线框 + 净高注记画出来了', '%s px ≥ 300' % d2['px'])

        log('• 2D · 去掉吊顶')
        set_material(cdp, 0, 'room_hall', {'ceiling': None})
        d4img = snap2d(cdp, '05-2d-ceiling-off')
        d3 = diff(b, d4img, '2d-ceiling-off')
        log('  · 与无吊顶基线的差异 %s px' % d3['px'])
        expect(d3['px'] <= 60, '去掉吊顶后画面回到基线（不是“加得上、去不掉”）', '%s px ≤ 60' % d3['px'])

        log('• 2D · undo 探针')
        set_material(cdp, 0, 'room_hall', {'ceiling': {'texture': 'plaster', 'height': 240}})
        und = undo_once(cdp)
        log('  · undo：%s' % json.dumps(und, ensure_ascii=False))
        expect(und.get('after') is None and und.get('canUndo') is True,
               '一次 undo 把吊顶撤掉（store.undo 与 Ctrl+Z 同一入口）', json.dumps(und, ensure_ascii=False))

        # ── 3D ────────────────────────────────────────────────────
        log('• 进 3D 外观')
        clicked = eval_json(cdp, """(() => {
          const b = Array.from(document.querySelectorAll('.interior-container .header-actions button'))
            .find((x) => x.textContent.trim() === '外观');
          if (!b) return JSON.stringify({ err: 'no-button' });
          if (b.disabled) return JSON.stringify({ err: 'disabled' });
          b.click();
          return JSON.stringify({ ok: true });
        })()""")
        if clicked.get('err'):
            raise RuntimeError('外观按钮不可用：%s' % clicked)
        wait_for(cdp, "!!document.querySelector('[data-testid=exterior-view]')", timeout=15, desc='外观浮层')
        wait_for(cdp, """(() => {
          const v = document.querySelector('[data-testid=exterior-view]');
          if (!v) return false;
          return !!v.querySelector('[data-testid=exterior-canvas]') || !!v.querySelector('[data-testid=exterior-fallback]');
        })()""", timeout=40, desc='3D 就绪')
        state = eval_json(cdp, """(() => {
          const v = document.querySelector('[data-testid=exterior-view]');
          return JSON.stringify({
            canvas: !!v.querySelector('[data-testid=exterior-canvas]'),
            fallback: v.querySelector('[data-testid=exterior-fallback]') ? v.querySelector('[data-testid=exterior-fallback]').textContent.trim().slice(0, 120) : '',
            stats: (v.querySelector('[data-testid=exterior-stats]') || {}).textContent || '',
          });
        })()""")
        log('  · 3D 状态：%s' % json.dumps(state, ensure_ascii=False))
        if not state.get('canvas'):
            raise RuntimeError('这台机器没拿到 WebGL：%s' % state.get('fallback'))
        expect('间房铺了地面' in (state.get('stats') or ''), '统计条报了房间地面数', state.get('stats'))

        # 只看一层：一层的材质才看得见（楼板挡着）
        floor1 = eval_json(cdp, """(() => {
          const s = %s, bid = %s;
          const d = s.interiorData[bid];
          const sorted = d.floors.slice().sort((a, b) => (a.elevation || 0) - (b.elevation || 0));
          return JSON.stringify({ id: sorted[0].id });
        })()""" % (D.STORE, json.dumps(BID)))
        set_floor_pick(cdp, floor1['id'])
        set_roof(cdp, 'none')
        time.sleep(1.2)
        vis = cdp.eval("JSON.stringify({ v: document.visibilityState, hidden: document.hidden })")
        log('  · 页面可见性：%s' % vis)
        g0 = shot3d(cdp, '06-3d-single-plain')
        probe3d(cdp, 'single-plain')

        r4 = set_material(cdp, 0, 'room_hall', {'floorTexture': 'tile'})
        r5 = set_material(cdp, 0, 'room_bed', {'floorTexture': 'tile'})
        expect(r4.get('floorTexture') == 'tile' and r5.get('floorTexture') == 'tile',
               '单层视图里材质也写进去了', 'hall=%s bed=%s' % (r4.get('floorTexture'), r5.get('floorTexture')))
        time.sleep(1.0)
        g1 = shot3d(cdp, '07-3d-single-tile')
        probe3d(cdp, 'single-tile')
        _md = g1[1].get('renders_delta')
        expect(_md == 'drag' or (isinstance(_md, int) and _md >= 1), '改材质后 3D 真的出了新帧', 'delta=%s' % _md)
        d5 = diff(g0[0], g1[0], '3d-single-tile-vs-plain')
        log('  · 3D 单层瓷砖 vs 纯色差异 %.2f%%（%s px）' % (d5['ratio'] * 100, d5['px']))
        expect(d5['ratio'] > 0.02, '3D 里房间地面真的换了颜色', '%.2f%% > 2%%' % (d5['ratio'] * 100))

        # 只改一间（大厅瓷砖 → 木地板）：同机位 A/B，证明**逐房间**生效而不是整层一起变
        r6 = set_material(cdp, 0, 'room_hall', {'floorTexture': 'wood'})
        time.sleep(1.0)
        g2 = shot3d(cdp, '08-3d-single-wood-hall')
        d6 = diff(g1[0], g2[0], '3d-single-wood-vs-tile')
        log('  · 只改大厅 差异 %.2f%%（%s px）' % (d6['ratio'] * 100, d6['px']))
        expect(d6['ratio'] > 0.005, '只改一间房也会变（不是整层一个材质）', '%.2f%% > 0.5%%' % (d6['ratio'] * 100))

        # 吊顶：回到全部楼层（单层视图会自动关掉吊顶开关）
        set_floor_pick(cdp, 'all')
        set_roof(cdp, 'none')
        # 吊顶设在**顶层**房间上：从上面看才看得见（下层那间被楼板压着，这是物理正确的）
        rc = set_material(cdp, 1, 'room_study', {'ceiling': {'texture': 'plaster', 'height': 240}})
        expect((rc.get('ceiling') or {}).get('texture') == 'plaster', '顶层房间吊顶写进去了',
               json.dumps(rc.get('ceiling'), ensure_ascii=False))
        time.sleep(1.2)
        h0 = shot3d(cdp, '09-3d-all-no-ceiling')
        ce = set_ceilings(cdp, True)
        log('  · 吊顶开关：%s' % json.dumps({k: ce.get(k) for k in ('ok', 'err', 'checked')}, ensure_ascii=False))
        expect(ce.get('checked') is True, '吊顶开关能打开', json.dumps(ce.get('err') or ''))
        time.sleep(0.8)
        h1 = shot3d(cdp, '10-3d-all-ceiling')
        probe3d(cdp, 'all-ceiling')
        _cd = h1[1].get('renders_delta')
        expect(_cd == 'drag' or (isinstance(_cd, int) and _cd >= 1), '开吊顶后 3D 真的出了新帧', 'delta=%s' % _cd)
        d7 = diff(h0[0], h1[0], '3d-ceiling-on')
        log('  · 3D 吊顶差异 %.2f%%（%s px）' % (d7['ratio'] * 100, d7['px']))
        expect(d7['ratio'] > 0.03, '顶层房间被吊顶盖住（差异够大）', '%.2f%% > 3%%' % (d7['ratio'] * 100))
        expect('间吊顶' in (ce.get('stats') or ''), '统计条报了吊顶间数', ce.get('stats'))

        # 单层视图必须自动关掉吊顶（否则正好把房间盖住）
        set_floor_pick(cdp, floor1['id'])
        box = eval_json(cdp, """(() => {
          const b = document.querySelector('[data-testid=exterior-ceilings]');
          return JSON.stringify({ exists: !!b, checked: !!b && b.checked, disabled: !!b && b.disabled });
        })()""")
        expect(box.get('checked') is False and box.get('disabled') is True,
               '只看某一层时吊顶自动关掉且开关灰禁', json.dumps(box))

        # 页面零报错
        errs = cdp.eval("JSON.stringify((window.__exErrs || []).slice(0, 5))")
        expect(errs in ('[]', ''), '页面全程零 JS 报错', str(errs))

    except Exception as e:                                          # noqa: BLE001
        log('❌ 演练异常：%s' % e)
        fails.append('异常：%s' % e)
    finally:
        # mock 必须收尾（`.bak` 留着会让下一次演练直接拒绝启动 —— 本轮就踩了一次）
        try:
            RT.teardown_mock()
        except Exception as e:                                      # noqa: BLE001
            log('  ⚠️ mock 收尾失败（请手工还原 index.html）：%s' % e)
        summary = {
            'fails': fails,
            'checks': checks,
            'at': time.strftime('%Y-%m-%d %H:%M:%S'),
            'out': OUT_DIR,
        }
        with open(os.path.join(OUT_DIR, 'result.json'), 'w', encoding='utf-8') as f:
            json.dump(summary, f, ensure_ascii=False, indent=2)
        if cdp:
            try:
                cdp.close()
            except Exception:                                       # noqa: BLE001
                pass
        for h in handles:
            try:
                D.port_open  # noqa: B018  (保持引用)
                h.terminate()
            except Exception:                                       # noqa: BLE001
                pass
        ok = len(checks) - len([c for c in checks if not c['ok']])
        log('')
        log('=== 房间材质 %d/%d 通过 ===' % (ok, len(checks)))
        if fails:
            log('失败：')
            for f in fails:
                log(' - %s' % f)
        sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
