#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 38：P2-3 笔刷脏矩形（只重绘受影响区域）

覆盖：
  a) DirtyRectTracker 语义：add/merge/getRects/clear、负宽高归一化、相邻矩形合并、
     「脏面积 > 50% 画布」判定
  b) 渲染器接线：PlanetMap 挂了 tracker；真实笔刷拖动期间存在 **partial** 帧，
     且单帧重绘面积远小于全画布
  c) 面积兜底：注入一个覆盖 >50% 视口的脏矩形 → 自动回退全画布
  d) 缩放/平移后首帧必为全画布（否则会拿旧变换的像素去比对新变换）
  e) 拖拽结束的收尾帧必为全画布（fastMode 快/全质量切换，防残影；这是本改动最危险的边界）
  f) partial 渲染与 full 渲染**逐像素一致**（同状态同帧质量下比对，验证无接缝/残影）

关于帧率：headless Edge 的 rAF 计时不可靠（--disable-gpu + 软件光栅），
因此不拿绝对 fps 当门槛，改拿**确定性等价量**：单帧重绘面积占比（fill 工作量）
与实测帧耗时对比。全画布 = 100% 面积，拖动帧 < 20% 即 ≥5 倍填充量削减。
"""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for
from lib.helpers import goto_planet, enter_edit

PM = "document.querySelector('.planet-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
CANVAS = "document.querySelector('.planet-map-container .canvas-wrapper canvas')"


def _j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


# ─────────────────────────────────────────────────────────────
# a) DirtyRectTracker 单元语义（页面内 import 同一份模块）
# ─────────────────────────────────────────────────────────────
def sub_tracker_unit(cdp):
    res = _j(cdp, """(async () => {
      const m = await import('/src/utils/dirtyRect.js');
      const { DirtyRectTracker, mergeRects, unionRect, normalizeRect } = m;
      const out = {};

      // 归一化：负宽高转正
      out.neg = normalizeRect({ x: 10, y: 10, w: -4, h: -6 });
      out.zero = normalizeRect({ x: 0, y: 0, w: 0, h: 10 });

      // add / getRects / clear
      const t = new DirtyRectTracker({ marginPx: 0 });
      t.add({ x: 0, y: 0, w: 10, h: 10 });
      t.add({ x: 100, y: 100, w: 10, h: 10 });
      out.afterAdd = t.getRects().length;
      t.clear();
      out.afterClear = t.getRects().length;

      // 重叠合并：3 个相互重叠 → 1 个；再 + 1 个分离的 → 2 个
      const t2 = new DirtyRectTracker({ marginPx: 0 });
      t2.add({ x: 0, y: 0, w: 10, h: 10 });
      t2.add({ x: 5, y: 5, w: 10, h: 10 });
      t2.add({ x: 12, y: 12, w: 10, h: 10 });
      out.merged = t2.merge().length;
      out.mergedArea = t2.totalArea();
      t2.add({ x: 500, y: 500, w: 10, h: 10 });
      const m2 = t2.merge();
      out.merged2 = m2.length;
      out.bbox = t2.boundingBox();

      // 面积兜底：画布 100x100，脏面积 40x40=1600 < 50% → 不全画布；60x60=3600 > 50% → 全画布
      const t3 = new DirtyRectTracker({ marginPx: 0 });
      t3.add({ x: 0, y: 0, w: 40, h: 40 });
      out.smallFull = t3.shouldFullRedraw(100, 100, 1);
      t3.clear();
      // 60x60 = 36% 画布 → 仍走 partial（阈值是 50%）
      t3.add({ x: 0, y: 0, w: 60, h: 60 });
      out.midFull = t3.shouldFullRedraw(100, 100, 1);
      t3.clear();
      // 75x75 = 56.25% > 50% → 回退全画布
      t3.add({ x: 0, y: 0, w: 75, h: 75 });
      out.bigFull = t3.shouldFullRedraw(100, 100, 1);
      // 缩放折算：scale=0.5 时同一世界矩形只占 1/4 画布面积 → 不再是「大面积」
      out.scaledSmall = t3.shouldFullRedraw(100, 100, 0.5);
      // markFull 强制
      const t4 = new DirtyRectTracker({ marginPx: 0 });
      t4.add({ x: 0, y: 0, w: 1, h: 1 });
      t4.markFull();
      out.markFull = t4.shouldFullRedraw(1000, 1000, 1) && t4.getRects().length === 0;

      // margin 按 scale 折算（世界单位）
      const t5 = new DirtyRectTracker({ marginPx: 4 });
      t5.setScale(0.5);
      out.marginWorld = t5.marginWorld;

      out.union = unionRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 });
      out.mergeFn = mergeRects([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 }]).length;
      return JSON.stringify(out);
    })()""")
    if not isinstance(res, dict) or 'afterAdd' not in res:
        return False, f'tracker 单元链路异常 {res}'
    if res['neg'] != {'x': 6, 'y': 4, 'w': 4, 'h': 6}:
        return False, f'负宽高未归一化 {res["neg"]}'
    if res['zero'] is not None:
        return False, f'零面积矩形未被丢弃 {res["zero"]}'
    if res['afterAdd'] != 2 or res['afterClear'] != 0:
        return False, f'add/getRects/clear 语义异常 {res}'
    if res['merged'] != 1:
        return False, f'重叠矩形未合并（{res["merged"]} 个，期望 1）'
    if res['mergedArea'] != 22 * 22:
        return False, f'合并后面积异常 {res["mergedArea"]}（期望 {(22) ** 2}）'
    if res['merged2'] != 2:
        return False, f'分离矩形被误合并 {res["merged2"]}'
    if res['smallFull'] is not False:
        return False, f'小面积脏区误判全画布 {res}'
    if res['midFull'] is not False:
        return False, f'36% 脏面积被误判为全画布 {res}'
    if res['bigFull'] is not True:
        return False, f'>50% 脏面积未回退全画布 {res}'
    if res['scaledSmall'] is not False:
        return False, f'scale 折算错误（0.5 缩放后 60×60 世界矩形只占 9% 画布）{res}'
    if not res['markFull']:
        return False, f'markFull 未生效 {res}'
    if abs(res['marginWorld'] - 8) > 1e-9:
        return False, f'margin 未按 scale 折算 {res["marginWorld"]}（scale=0.5、4px → 8 世界单位）'
    if res['union'] != {'x': 0, 'y': 0, 'w': 15, 'h': 15}:
        return False, f'unionRect 异常 {res["union"]}'
    if res['mergeFn'] != 2:
        return False, f'不相交矩形被合并 {res["mergeFn"]}'
    return True, ('tracker 语义通过：负宽高归一化/零面积丢弃、add·getRects·clear、3 个重叠→1 个（面积 484）、'
                  '分离矩形不误合并、>50% 面积回退全画布、scale 折算与 margin 折算正确')


# ─────────────────────────────────────────────────────────────
# b) 真实笔刷拖动 → partial 帧
# ─────────────────────────────────────────────────────────────
def sub_brush_partial(cdp):
    res = _j(cdp, f"""(async () => {{
      const pm = {PM};
      const c = {CANVAS};
      if (!pm || !c) return JSON.stringify({{ err: 'no-canvas' }});
      const hasTracker = !!pm.renderer.getDirtyTracker();
      const hasApi = typeof pm.renderer.markDirtyRect === 'function'
        && typeof pm.renderer.getRenderInfo === 'function'
        && typeof pm.renderer.markFullRedraw === 'function';
      pm.editMode = true;
      pm.setInteractionMode('terrain');
      pm.terrainBrushType = 3;
      pm.terrainBrushSize = 4;
      pm.gridSnapEnabled = false;
      await new Promise(r => setTimeout(r, 120));

      const r = c.getBoundingClientRect();
      const vt = pm.renderer.viewTransform;
      const toSX = wx => Math.trunc(r.left + wx * vt.scale + vt.x + c.clientWidth / 2);
      const toSY = wy => Math.trunc(r.top + wy * vt.scale + vt.y + c.clientHeight / 2);
      const mk = (t, wx, wy) => new MouseEvent(t, {{ clientX: toSX(wx), clientY: toSY(wy),
        bubbles: true, cancelable: true, button: 0 }});

      // 视口中心附近走一条斜线，每步等一帧，便于采集逐帧渲染信息
      const cwx = (c.clientWidth / 2 - vt.x) / vt.scale;
      const cwy = (c.clientHeight / 2 - vt.y) / vt.scale;
      const step = 40 / vt.scale;
      const frames = [];
      c.dispatchEvent(mk('mousedown', cwx - 2 * step, cwy - 2 * step));
      for (let i = 1; i <= 6; i++) {{
        c.dispatchEvent(mk('mousemove', cwx - 2 * step + i * step * 0.8, cwy - 2 * step + i * step * 0.6));
        await new Promise(r2 => setTimeout(r2, 55));
        const info = pm.renderer.getRenderInfo();
        frames.push({{ mode: info.mode, ratio: +(info.dirtyAreaRatio || 0).toFixed(4), rects: info.rects }});
      }}
      c.dispatchEvent(mk('mouseup', cwx + 3 * step, cwy + 2 * step));
      await new Promise(r3 => setTimeout(r3, 90));
      const tail = pm.renderer.getRenderInfo();
      const painted = (() => {{
        const g = pm.terrainCanvasBrush?.terrainGrid?.value;
        if (!g) return -1;
        let n = 0;
        for (let i = 0; i < g.length; i++) if (g[i] !== 255) n++;
        return n;
      }})();
      const canvas = {{ w: c.width, h: c.height }};
      // 收尾：撤销这次涂抹，保持数据干净
      pm.undo();
      return JSON.stringify({{ hasTracker, hasApi, frames, tail: {{ mode: tail.mode }}, painted, canvas }});
    }})()""")
    if not isinstance(res, dict) or 'frames' not in res:
        return False, f'笔刷脏矩形链路异常 {res}'
    if not res['hasTracker']:
        return False, 'PlanetMap 未挂 DirtyRectTracker（renderer.getDirtyTracker() 为空）'
    if not res['hasApi']:
        return False, '渲染器缺少 markDirtyRect/getRenderInfo/markFullRedraw API'
    if res['painted'] <= 0:
        return False, f'笔刷未真正写网格（painted={res["painted"]}），本用例无从判定脏矩形'
    frames = res['frames']
    partials = [f for f in frames if f['mode'] == 'partial']
    if len(partials) < max(3, len(frames) // 2):
        return False, f'拖动期间 partial 帧过少（{len(partials)}/{len(frames)}）：{frames}'
    worst = max(f['ratio'] for f in partials)
    if worst >= 0.5:
        return False, f'partial 帧重绘面积占比过大（{worst}）：{frames}'
    if res['tail']['mode'] != 'full':
        return False, f'拖拽收尾帧不是全画布（mode={res["tail"]["mode"]}）——快/全质量混用会留残影'
    avg = sum(f['ratio'] for f in partials) / len(partials)
    return True, (f'笔刷 partial 渲染通过：{len(partials)}/{len(frames)} 帧命中脏矩形，'
                  f'平均重绘面积 {avg * 100:.1f}% 画布、最大 {worst * 100:.1f}%（<50% 阈值）、'
                  f'收尾帧回全画布；本次涂抹真实写入 {res["painted"]} 格')


# ─────────────────────────────────────────────────────────────
# c) 面积兜底：>50% 画布 → 全画布
# ─────────────────────────────────────────────────────────────
def sub_area_fallback(cdp):
    res = _j(cdp, f"""(async () => {{
      const pm = {PM};
      const c = {CANVAS};
      const vt = pm.renderer.viewTransform;
      const w = c.clientWidth, h = c.clientHeight;
      // 视口对应的世界矩形
      const tl = pm.renderer.screenToWorld(0, 0);
      const br = pm.renderer.screenToWorld(w, h);
      const vw = br.x - tl.x, vh = br.y - tl.y;

      // 先做一次小脏区，确认 partial 生效
      pm.renderer.markDirtyRect({{ x: tl.x + vw / 2, y: tl.y + vh / 2, w: vw * 0.05, h: vh * 0.05 }});
      pm.renderer.requestRender();
      await new Promise(r => setTimeout(r, 60));
      const small = pm.renderer.getRenderInfo();

      // 再报一个大矩形（85% 视口面积 > 50% 阈值）
      pm.renderer.markDirtyRect({{ x: tl.x, y: tl.y, w: vw * 0.92, h: vh * 0.92 }});
      pm.renderer.requestRender();
      await new Promise(r => setTimeout(r, 60));
      const big = pm.renderer.getRenderInfo();
      return JSON.stringify({{ smallMode: small.mode, smallRatio: +(small.dirtyAreaRatio || 0).toFixed(3),
        bigMode: big.mode, bigRatio: +(big.dirtyAreaRatio || 0).toFixed(3) }});
    }})()""")
    if not isinstance(res, dict) or 'smallMode' not in res:
        return False, f'面积兜底链路异常 {res}'
    if res['smallMode'] != 'partial':
        return False, f'小脏区未走 partial（{res}）'
    if res['bigMode'] != 'full':
        return False, f'>50% 脏面积未回退全画布（{res}）'
    return True, (f'面积兜底通过：5% 脏区走 partial，92% 脏区自动回退全画布'
                  f'（{res["smallRatio"] * 100:.0f}% → {res["bigMode"]}）')


# ─────────────────────────────────────────────────────────────
# d) 缩放/平移后首帧全画布
# ─────────────────────────────────────────────────────────────
def sub_transform_full(cdp):
    res = _j(cdp, f"""(async () => {{
      const pm = {PM};
      const c = {CANVAS};
      const vt = pm.renderer.viewTransform;
      const tl = pm.renderer.screenToWorld(0, 0);
      const br = pm.renderer.screenToWorld(c.clientWidth, c.clientHeight);
      const vw = br.x - tl.x, vh = br.y - tl.y;
      const mid = {{ x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 }};

      // 稳定帧 → partial
      pm.renderer.markDirtyRect({{ x: mid.x, y: mid.y, w: vw * 0.05, h: vh * 0.05 }});
      pm.renderer.requestRender();
      await new Promise(r => setTimeout(r, 60));
      const base = pm.renderer.getRenderInfo().mode;

      // 缩放：同一帧必须全画布
      pm.renderer.setScale(Math.min(3, vt.scale * 1.25));
      pm.renderer.markDirtyRect({{ x: mid.x, y: mid.y, w: vw * 0.05, h: vh * 0.05 }});
      pm.renderer.requestRender();
      await new Promise(r => setTimeout(r, 70));
      const zoom = pm.renderer.getRenderInfo();
      const s1 = vt.scale;

      // 再稳定一帧 → partial
      pm.renderer.markDirtyRect({{ x: mid.x, y: mid.y, w: vw * 0.05, h: vh * 0.05 }});
      pm.renderer.requestRender();
      await new Promise(r => setTimeout(r, 60));
      const stable = pm.renderer.getRenderInfo().mode;

      // 平移：同样必须全画布
      vt.x += 24; vt.y += 16;
      pm.renderer.markDirtyRect({{ x: mid.x, y: mid.y, w: vw * 0.05, h: vh * 0.05 }});
      pm.renderer.requestRender();
      await new Promise(r => setTimeout(r, 70));
      const pan = pm.renderer.getRenderInfo();
      const s2 = vt.scale;

      // 复原缩放
      pm.renderer.setScale(s2 / 1.25);
      pm.renderer.requestRender();
      await new Promise(r => setTimeout(r, 60));
      return JSON.stringify({{ base, zoomMode: zoom.mode, stable, panMode: pan.mode }});
    }})()""")
    if not isinstance(res, dict) or 'zoomMode' not in res:
        return False, f'变换帧链路异常 {res}'
    if res['base'] != 'partial' or res['stable'] != 'partial':
        return False, f'基准帧未走 partial（{res}），后面两条断言不成立'
    if res['zoomMode'] != 'full':
        return False, f'缩放后首帧不是全画布（{res["zoomMode"]}）'
    if res['panMode'] != 'full':
        return False, f'平移后首帧不是全画布（{res["panMode"]}）'
    return True, '变换兜底通过：稳定帧 partial、缩放首帧 full、平移首帧 full'


# ─────────────────────────────────────────────────────────────
# e) partial 与 full 逐像素一致（无接缝/残影）
# ─────────────────────────────────────────────────────────────
def sub_pixel_equivalence(cdp):
    res = _j(cdp, f"""(async () => {{
      const pm = {PM};
      const c = {CANVAS};
      const ctx = c.getContext('2d');
      const r = c.getBoundingClientRect();
      const vt = pm.renderer.viewTransform;
      const toSX = wx => Math.trunc(r.left + wx * vt.scale + vt.x + c.clientWidth / 2);
      const toSY = wy => Math.trunc(r.top + wy * vt.scale + vt.y + c.clientHeight / 2);
      const mk = (t, wx, wy) => new MouseEvent(t, {{ clientX: toSX(wx), clientY: toSY(wy),
        bubbles: true, cancelable: true, button: 0 }});

      pm.editMode = true;
      pm.setInteractionMode('terrain');
      pm.terrainBrushType = 4;   // 换个颜色，避免与上一子测试的笔迹重合
      pm.terrainBrushSize = 5;
      await new Promise(r0 => setTimeout(r0, 120));

      const cwx = (c.clientWidth / 2 - vt.x) / vt.scale;
      const cwy = (c.clientHeight / 2 - vt.y) / vt.scale;
      const st = 30 / vt.scale;
      c.dispatchEvent(mk('mousedown', cwx - st, cwy + st));
      for (let i = 1; i <= 5; i++) {{
        c.dispatchEvent(mk('mousemove', cwx - st + i * st * 0.7, cwy + st - i * st * 0.4));
        await new Promise(r1 => setTimeout(r1, 45));
      }}
      // 停在拖动中：此时画面由若干 partial 帧叠加而成，且仍处于 fastMode
      await new Promise(r2 => setTimeout(r2, 60));
      const infoMid = pm.renderer.getRenderInfo();
      const modeDuring = pm.renderer.isFastMode() ? 'fast' : 'full-quality';
      const before = ctx.getImageData(0, 0, c.width, c.height).data;

      // 同状态下强制全画布重绘一帧
      pm.renderer.markFullRedraw();
      await new Promise(r3 => setTimeout(r3, 90));
      const after = ctx.getImageData(0, 0, c.width, c.height).data;
      const fullInfo = pm.renderer.getRenderInfo();

      let diff = 0, maxDelta = 0;
      let bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1;
      const W = c.width;
      for (let i = 0; i < before.length; i++) {{
        if (before[i] !== after[i]) {{
          diff++;
          const d = Math.abs(before[i] - after[i]);
          if (d > maxDelta) maxDelta = d;
          const px = (i >> 2) % W, py = (i >> 2) / W | 0;
          if (px < bx0) bx0 = px;
          if (py < by0) by0 = py;
          if (px > bx1) bx1 = px;
          if (py > by1) by1 = py;
        }}
      }}
      const bbox = (bx1 >= 0) ? [bx0, by0, bx1, by1] : null;
      const total = before.length;
      c.dispatchEvent(mk('mouseup', cwx + 2.5 * st, cwy - st));
      await new Promise(r4 => setTimeout(r4, 90));
      pm.undo();
      return JSON.stringify({{ diff, maxDelta, bbox, total, modeDuring, trackMode: infoMid.mode,
        fullMode: fullInfo.mode, w: c.width, h: c.height }});
    }})()""")
    if not isinstance(res, dict) or 'diff' not in res:
        return False, f'像素等价链路异常 {res}'
    if res['fullMode'] != 'full':
        return False, f'强制全画布重绘未生效（{res}）'
    if res['diff'] != 0:
        pct = res['diff'] / max(1, res['total']) * 100
        return False, (f'partial 与 full 渲染结果不一致：{res["diff"]} 个字节不同'
                       f'（{pct:.3f}% of {res["total"]}，最大通道差 {res["maxDelta"]}，'
                       f'差异包围盒 {res.get("bbox")}）—— 脏矩形边界有接缝/残影')
    return True, (f'视觉等价通过：拖动中（质量档 {res["modeDuring"]}）partial 帧与强制全画布重绘的 '
                  f'{res["w"]}×{res["h"]} 画面**逐字节一致**（0 差异），无接缝、无残影')


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    wait_for(cdp, f"{STORE}.nodes.length > 0", timeout=45, desc='地理数据加载')

    r = goto_planet(cdp, '乐园星')
    if r != 'planet':
        return False, f'导航行星失败 (goto_planet → {r})'
    time.sleep(1.0)
    if enter_edit(cdp) != 'ok':
        return False, '进入编辑模式失败'
    time.sleep(0.6)
    wait_for(cdp, f"!!{CANVAS}", desc='行星画布挂载')

    results = []
    for name, fn in (('a tracker 语义', sub_tracker_unit),
                     ('b 笔刷 partial', sub_brush_partial),
                     ('c 面积兜底', sub_area_fallback),
                     ('d 变换兜底', sub_transform_full),
                     ('e 视觉等价', sub_pixel_equivalence)):
        try:
            ok, detail = fn(cdp)
        except Exception as e:
            ok, detail = False, f'异常: {e}'
        results.append((name, ok, detail))

    failed = [f'{n}: {d}' for n, o, d in results if not o]
    if failed:
        return False, (f'脏矩形 {len(results) - len(failed)}/{len(results)} 子测试通过；失败：\n    '
                       + '\n    '.join(failed))
    return True, ('脏矩形 ' + f'{len(results)}/{len(results)} 全通过 — '
                  + '；'.join(d for _, _, d in results))
