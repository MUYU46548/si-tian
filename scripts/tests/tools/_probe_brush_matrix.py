#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""S0 笔刷矩阵探针（**不是回归用例**，会话结束前可删）。

目的：把「每个笔刷画出来是什么」变成 12 张图 + 一组读数，而不是靠读代码猜。
- 真实 `docs/mockups/desite.map`（200 省）导入剧本底图；
- 每个工具用真实 CDP 鼠标事件画一笔；
- 抬手后截图（`docs/assets/s0-brush-20261019/`），读 store 的省份/河/点数/撤销；
- 截完 `undo()` 回到基线，保证下一笔不受污染；
- 结果落 `summary.json`，供 `docs/SITIAN_BREAKPOINT_20261019.md` 引用。

前置：
    1) `python scripts/tests/tools/_lab.py up`
    2) `src/renderer/public/__real_desite.map` 存在（由本脚本自动从 docs/mockups 拷）
用法：
    python scripts/tests/tools/_probe_brush_matrix.py
"""
import base64
import json
import os
import shutil
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

from lib.cdp import CDP, wait_for          # noqa: E402
from lib.helpers import open_harness_project  # noqa: E402
import run_tests as RT                     # noqa: E402

MAP_SRC = os.path.join(ROOT, 'docs', 'mockups', 'desite.map')
MAP_DST = os.path.join(ROOT, 'src', 'renderer', 'public', '__real_desite.map')
OUT_DIR = os.path.join(ROOT, 'docs', 'assets', 's0-brush-20261019')
SUMMARY = os.path.join(OUT_DIR, 'summary.json')
KEY = 'S0真实底图'

LOAD_JS = r"""
(async () => {
  const app = document.querySelector('#app').__vue_app__;
  const s = app._instance.setupState.store;
  const AP = await import('/src/utils/azgaar-parser.js');
  const text = await (await fetch('/__real_desite.map')).text();
  const NAME = __NAME__;
  const parsed = AP.parseMapFile(text);
  s.importFromScenariosJson(AP.buildScenariosJson(parsed, NAME, '当前'));
  await new Promise((r) => setTimeout(r, 2800));
  const sc = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  sc.baseMapKey = NAME;
  if (sc.onBaseMapChange) await sc.onBaseMapChange();
  await new Promise((r) => setTimeout(r, 1400));
  if (typeof sc.fitToView === 'function') sc.fitToView();
  await new Promise((r) => setTimeout(r, 600));
  window.__S0 = {
    name: NAME,
    stats() {
      const bm = s.baseMaps[NAME] || {};
      const terr = bm.terrain || [];
      const rivers = bm.rivers || [];
      const ringPts = (p) => (p.points || []).length
        + (p.extraRings || []).reduce((n, r) => n + ((r.points || []).length), 0);
      return {
        tool: sc.tool,
        basemapEditMode: !!sc.basemapEditMode,
        canvas: (() => { const r = sc.canvas.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
        terrain: terr.length,
        terrainPts: terr.reduce((n, p) => n + ringPts(p), 0),
        rivers: rivers.length,
        riverPts: rivers.reduce((n, r) => n + ((r.points || []).length), 0),
        canUndo: !!s.canUndo,
        undoLabel: s.undoLabel || '',
        status: (document.querySelector('.scenario-status-bar') || {}).innerText || '',
      };
    },
    // 找一个「确定在陆地里」的画布点：取面积最大的省，用包围盒中心/四角试探，
    // 再用 findProvinceAt 复核（避免点落在洞里或海上）。
    landPoint() {
      const r = sc.canvas.getBoundingClientRect();
      const terr = (sc.baseMap && sc.baseMap.terrain) || [];
      const scale = Number(sc.cameraScale) || 1;
      const cands = [];
      for (const p of terr) {
        const pts = p.points || [];
        if (pts.length < 4) continue;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const q of pts) {
          if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
          if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
        }
        cands.push({ p, area: (maxX - minX) * (maxY - minY), sx: (maxX - minX) * scale, sy: (maxY - minY) * scale });
      }
      cands.sort((a, b) => b.area - a.area);
      // 只要“深”点：四周 40px 都还在同一个省里；否则一笔就涂到海里，
      // 会被 lockCoast 裁成空 / 河流起点落海而拒画（第三版 11/12 空转的根因）。
      for (const best of cands.slice(0, 40)) {
        if (best.sx < 110 || best.sy < 70) continue;
        const w = best.sx / scale, h = best.sy / scale;
        let minX = Infinity, minY = Infinity;
        for (const q of best.p.points) { if (q.x < minX) minX = q.x; if (q.y < minY) minY = q.y; }
        for (const fx of [0.5, 0.35, 0.65, 0.2, 0.8]) {
          for (const fy of [0.5, 0.35, 0.65, 0.2, 0.8]) {
            const wx = minX + w * fx, wy = minY + h * fy;
            if (sc.findProvinceAt(wx, wy) !== best.p) continue;
            let deep = true;
            for (const [dx, dy] of [[40, 0], [-40, 0], [0, 40], [0, -40], [28, 28], [-28, -28]]) {
              if (sc.findProvinceAt(wx + dx / scale, wy + dy / scale) !== best.p) { deep = false; break; }
            }
            if (!deep) continue;
            const s = sc.worldToScreen(wx, wy);
            const x = s.x + r.left, y = s.y + r.top;
            if (x < r.left + 45 || x > r.left + r.width - 45) continue;
            if (y < r.top + 45 || y > r.top + r.height - 45) continue;
            const el = document.elementFromPoint(x, y);
            if (!el || el.tagName !== 'CANVAS') continue;
            return { x, y, id: best.p.id, safe: 40 };
          }
        }
      }
      // 兜底：画布被面板压得很小时，上面按“大省中心”可能全落在画布外 → 网格扫一遍。
      for (let gy = 0.15; gy <= 0.86; gy += 0.08) {
        for (let gx = 0.1; gx <= 0.9; gx += 0.08) {
          const x = r.left + r.width * gx, y = r.top + r.height * gy;
          const w = sc.screenToWorld(x - r.left, y - r.top);
          const p = sc.findProvinceAt(w.x, w.y);
          if (!p) continue;
          const el = document.elementFromPoint(x, y);
          if (el && el.tagName === 'CANVAS') return { x, y, id: p.id, safe: 18 };
        }
      }
      return null;
    },
    // 海面点：给「自由绘制」用，避免一画就撞上已有省份的压叠闸门。
    seaPoint() {
      const r = sc.canvas.getBoundingClientRect();
      const scale = Number(sc.cameraScale) || 1;
      for (let gy = 0.2; gy <= 0.8; gy += 0.1) {
        for (let gx = 0.15; gx <= 0.85; gx += 0.1) {
          const x = r.left + r.width * gx, y = r.top + r.height * gy;
          const w = sc.screenToWorld(x - r.left, y - r.top);
          if (sc.findProvinceAt(w.x, w.y)) continue;
          // 必须离陆地 80px 以上，否则自由绘制一圈会压到已有省份（压叠闸门会弹确认）。
          let clear = true;
          for (const [dx, dy] of [[80, 0], [-80, 0], [0, 80], [0, -80], [56, 56], [-56, -56]]) {
            if (sc.findProvinceAt(w.x + dx / scale, w.y + dy / scale)) { clear = false; break; }
          }
          if (!clear) continue;
          const el = document.elementFromPoint(x, y);
          if (!el || el.tagName !== 'CANVAS') continue;
          return { x, y, id: null, safe: 80 };
        }
      }
      return null;
    },
    // 边界点：扫一个省的顶点，找「偏离 6px 就落到另一个省」的那一段 —— 描轮廓要贴着这种点画。
    borderPoint() {
      const r = sc.canvas.getBoundingClientRect();
      const terr = (sc.baseMap && sc.baseMap.terrain) || [];
      const offs = [[6, 0], [-6, 0], [0, 6], [0, -6], [4, 4], [-4, -4]];
      for (const p of terr.slice(0, 40)) {
        const pts = p.points || [];
        for (let i = 0; i < pts.length; i += 3) {
          const s = sc.worldToScreen(pts[i].x, pts[i].y);
          const x = s.x + r.left, y = s.y + r.top;
          if (x < r.left + 15 || x > r.left + r.width - 15) continue;
          if (y < r.top + 15 || y > r.top + r.height - 15) continue;
          for (const [dx, dy] of offs) {
            const w = sc.screenToWorld(x - r.left + dx, y - r.top + dy);
            const q = sc.findProvinceAt(w.x, w.y);
            if (q && q !== p) {
              const el = document.elementFromPoint(x, y);
              if (el && el.tagName === 'CANVAS') return { x, y, id: p.id, other: q.id };
            }
          }
        }
      }
      return null;
    },
    pick(px, py) {
      const r = sc.canvas.getBoundingClientRect();
      const w = sc.screenToWorld(px - r.left, py - r.top);
      const p = sc.findProvinceAt(w.x, w.y);
      const terr = (sc.baseMap && sc.baseMap.terrain) || [];
      const idx = p ? terr.indexOf(p) + 1 : 0;
      sc.provBrushTarget = idx || sc.provBrushTarget || 1;
      sc.selectedProvince = p || null;
      return JSON.stringify({ idx, name: p && p.name });
    },
    // ── 几何度量：把「诡异」拆成可比的数 ────────────────────────────────
    // maxBulgeWorld = 渲染贝塞尔在 t=0.5 处离「数据多边形那条弦」的最远距离（世界单位）
    // maxBulgeRatio = 上述距离 / 该段弦长；>0.05 就说明“看到的边界”明显不是数据边界
    // spikes        = 相邻线段夹角 >150°（近似折返）的顶点数
    // maxEdgeRatio  = 最长边 / 周长（开口笔迹用弦收口时，这个值会很大）
    // selfInt       = 自交段对数（只对 ≤300 点的环算，真实海岸线 1 万点不算）
    metrics(prov) {
      const rings = [{ points: prov.points || [] }].concat((prov.extraRings || []).map((r) => ({ points: r.points || [] })));
      let n = 0, area = 0, per = 0, maxBulgeWorld = 0, maxBulgeRatio = 0, spikes = 0, maxEdge = 0, selfInt = 0;
      const pxScale = Number(sc.cameraScale) || 1;
      for (const ring of rings) {
        const pts = ring.points;
        const m = pts.length;
        if (m < 3) continue;
        n += m;
        for (let i = 0; i < m; i++) {
          const a = pts[i], b = pts[(i + 1) % m];
          area += a.x * b.y - b.x * a.y;
          const len = Math.hypot(b.x - a.x, b.y - a.y);
          per += len;
          if (len > maxEdge) maxEdge = len;
        }
        for (let i = 0; i < m; i++) {
          const prev = pts[(i - 1 + m) % m], cur = pts[i], next = pts[(i + 1) % m];
          const v1x = cur.x - prev.x, v1y = cur.y - prev.y;
          const v2x = next.x - cur.x, v2y = next.y - cur.y;
          const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
          if (l1 > 1e-9 && l2 > 1e-9) {
            const cos = (v1x * v2x + v1y * v2y) / (l1 * l2);
            if (cos < -0.866) spikes++;
          }
        }
        // 渲染用的是一条**闭合三次贝塞尔**：控制点是**数据里存的**；没有控制点的段
        // 渲染端走 lineTo（`traceShapePath` 的 `!o || !k` 分支）→ 该段偏差为 0。
        // 这样量出来的才是“看到的 vs 算到的”，而不是我们假设它一定有控制点。
        const out = pts.map((p) => (p.controlOut ? { x: p.controlOut.x, y: p.controlOut.y } : null));
        const inn = pts.map((p) => (p.controlIn ? { x: p.controlIn.x, y: p.controlIn.y } : null));
        for (let i = 0; i < m; i++) {
          const p0 = pts[i], p3 = pts[(i + 1) % m];
          if (!out[i] || !inn[(i + 1) % m]) continue;
          const p1 = { x: p0.x + out[i].x, y: p0.y + out[i].y };
          const p2 = { x: p3.x + inn[(i + 1) % m].x, y: p3.y + inn[(i + 1) % m].y };
          const bx = (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8;
          const by = (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8;
          const mx = (p0.x + p3.x) / 2, my = (p0.y + p3.y) / 2;
          const dist = Math.hypot(bx - mx, by - my);
          const chord = Math.hypot(p3.x - p0.x, p3.y - p0.y);
          if (dist > maxBulgeWorld) { maxBulgeWorld = dist; maxBulgeRatio = chord > 1e-9 ? dist / chord : 0; }
        }
        if (m <= 300) {
          const seg = (i) => [pts[i], pts[(i + 1) % m]];
          const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
          for (let i = 0; i < m; i++) {
            for (let j = i + 2; j < m; j++) {
              if (i === 0 && j === m - 1) continue;
              const [a, b] = seg(i), [c, d] = seg(j);
              const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
              if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) selfInt++;
            }
          }
        }
      }
      return {
        id: prov.id, name: prov.name, n,
        area: Math.abs(area / 2),
        perimeter: per,
        maxBulgeWorld: +maxBulgeWorld.toFixed(3),
        maxBulgePx: +(maxBulgeWorld * pxScale).toFixed(2),
        maxBulgeRatio: +maxBulgeRatio.toFixed(3),
        spikes, selfInt,
        maxEdgeRatio: per > 1e-9 ? +(maxEdge / per).toFixed(3) : 0,
      };
    },
    snap() {
      const bm = s.baseMaps[NAME] || {};
      window.__S0._snap = (bm.terrain || []).map((p) => ({ id: p.id, n: (p.points || []).length }));
      return window.__S0._snap.length;
    },
    changed() {
      const bm = s.baseMaps[NAME] || {};
      const snap = window.__S0._snap || [];
      const terr = bm.terrain || [];
      const out = [];
      for (const p of terr) {
        const old = snap.find((q) => q.id === p.id);
        if (!old || old.n !== (p.points || []).length) out.push(window.__S0.metrics(p));
      }
      return out.slice(0, 8);
    },
    lastProv() {
      const bm = s.baseMaps[NAME] || {};
      const terr = bm.terrain || [];
      return terr.length ? window.__S0.metrics(terr[terr.length - 1]) : null;
    },
    riverStats() {
      const bm = s.baseMaps[NAME] || {};
      const rs = bm.rivers || [];
      return rs.map((r) => ({ id: r.id, n: (r.points || []).length, width: r.width, name: r.name }));
    },
    // 用**页面内合成事件**画一笔。为什么不用 CDP Input：本机 headless 下 Input 事件偶尔
    // 到不了 canvas（同一坐标 elementFromPoint 是 CANVAS，但 onMouseDown 不触发）；
    // 合成事件直接派发到 canvas，稳定，且坐标只依赖 getBoundingClientRect。
    async stroke(kind, o) {
      const cvs = sc.canvas;
      const fire = (type, x, y, buttons, clickCount) => cvs.dispatchEvent(new MouseEvent(type, {
        clientX: x, clientY: y, button: 0, buttons, bubbles: true, cancelable: true,
        clickCount: clickCount || 1,
      }));
      const tick = () => new Promise((res) => setTimeout(res, 16));
      if (kind === 'line') {
        fire('mousedown', o.x0, o.y0, 1);
        for (let i = 1; i <= (o.steps || 14); i++) {
          const t = i / (o.steps || 14);
          fire('mousemove', o.x0 + (o.x1 - o.x0) * t, o.y0 + (o.y1 - o.y0) * t, 1);
          await tick();
        }
        fire('mouseup', o.x1, o.y1, 0);
      } else if (kind === 'loop') {
        const steps = o.steps || 30;
        fire('mousedown', o.cx + o.r, o.cy, 1);
        for (let i = 1; i <= steps; i++) {
          const a = (i / steps) * Math.PI * 2;
          fire('mousemove', o.cx + Math.cos(a) * o.r, o.cy + Math.sin(a) * o.r * 0.72, 1);
          await tick();
        }
        fire('mouseup', o.cx + o.r, o.cy, 0);
      } else if (kind === 'split') {
        const click = async (x, y, count) => {
          fire('mousedown', x, y, 1, count); fire('mouseup', x, y, 0, count);
          await tick();
        };
        await click(o.cx - o.dx, o.cy - o.dy, 1);
        await click(o.cx + o.dx * 0.25, o.cy + o.dy * 0.3, 1);
        await click(o.cx + o.dx, o.cy + o.dy, 2);
      }
      return 'ok';
    },
  };
  return JSON.stringify({
    ok: true,
    name: NAME,
    terrain: (s.baseMaps[NAME].terrain || []).length,
    rivers: (s.baseMaps[NAME].rivers || []).length,
    canvas: (() => { const r = sc.canvas.getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, h: r.height }; })(),
  });
})()
"""


def mouse(cdp, typ, x, y, buttons=0, click=1):
    cdp.send('Input.dispatchMouseEvent', {
        'type': typ, 'x': round(x, 1), 'y': round(y, 1),
        'button': 'left' if (buttons or typ == 'mousePressed') else 'none',
        'buttons': buttons, 'clickCount': click,
    })


def stroke_line(cdp, x0, y0, x1, y1, steps=14):
    mouse(cdp, 'mousePressed', x0, y0, 1)
    for i in range(1, steps + 1):
        t = i / steps
        mouse(cdp, 'mouseMoved', x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 1)
        time.sleep(0.016)
    mouse(cdp, 'mouseReleased', x1, y1, 0)


def stroke_loop(cdp, cx, cy, r=120, steps=30):
    import math
    mouse(cdp, 'mousePressed', cx + r, cy, 1)
    for i in range(1, steps + 1):
        a = (i / steps) * math.tau
        mouse(cdp, 'mouseMoved', cx + math.cos(a) * r, cy + math.sin(a) * r * 0.72, 1)
        time.sleep(0.016)
    mouse(cdp, 'mouseReleased', cx + r, cy, 0)


def stroke_split(cdp, cx, cy, dx=70, dy=45):
    mouse(cdp, 'mousePressed', cx - dx, cy - dy, 1)
    mouse(cdp, 'mouseReleased', cx - dx, cy - dy, 0)
    time.sleep(0.15)
    mouse(cdp, 'mousePressed', cx + dx * 0.25, cy + dy * 0.3, 1)
    mouse(cdp, 'mouseReleased', cx + dx * 0.25, cy + dy * 0.3, 0)
    time.sleep(0.15)
    mouse(cdp, 'mousePressed', cx + dx, cy + dy, 1, click=2)
    mouse(cdp, 'mouseReleased', cx + dx, cy + dy, 0, click=2)


def do_stroke(cdp, kind, **kw):
    v = cdp.eval("window.__S0.stroke(%s, %s)" % (json.dumps(kind), json.dumps(kw)))
    if isinstance(v, dict) and '__err__' in v:
        raise RuntimeError('stroke 求值异常：%s' % v)
    return v


def shot(cdp, name):
    data = cdp.send('Page.captureScreenshot', {'format': 'png'})['data']
    path = os.path.join(OUT_DIR, name + '.png')
    with open(path, 'wb') as f:
        f.write(base64.b64decode(data))
    return os.path.relpath(path, ROOT)


def stats(cdp):
    v = cdp.eval("JSON.stringify(window.__S0.stats())")
    return json.loads(v) if isinstance(v, str) else {'__err__': str(v)}


def _json(cdp, expr, default):
    v = cdp.eval(expr)
    if isinstance(v, str):
        try:
            return json.loads(v)
        except ValueError:
            return {'__raw__': v[:200]}
    return {'__err__': str(v)[:200]} if default is None else default


def undo_until(cdp, base, limit=6):
    """撤销到 stats 回到基线（最多 limit 次），返回撤销次数。"""
    n = 0
    for _ in range(limit):
        cur = stats(cdp)
        if cur.get('terrain') == base['terrain'] and cur.get('rivers') == base['rivers'] \
                and cur.get('terrainPts') == base['terrainPts'] and cur.get('riverPts') == base['riverPts']:
            break
        cdp.eval("document.querySelector('#app').__vue_app__._instance.setupState.store.undo()")
        n += 1
        time.sleep(0.35)
    return n


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    if not os.path.exists(MAP_SRC):
        raise SystemExit('缺少 %s' % MAP_SRC)
    os.makedirs(os.path.dirname(MAP_DST), exist_ok=True)
    shutil.copyfile(MAP_SRC, MAP_DST)

    cdp = CDP()
    cdp.ws.settimeout(180)
    try:
        bust = int(time.time())
        cdp.navigate('http://localhost:5180/?s0=%d' % bust)
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='导航', timeout=60)
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate('http://localhost:5180/?s0=%d' % (bust + 1))
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='重载', timeout=60)
        RT.apply_viewport(cdp)
        wait_for(cdp, "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
                 timeout=45, desc='数据就绪')
        cdp.eval("window.confirm = () => true; window.alert = () => {}; window.prompt = () => 'S0';")

        ok, info = open_harness_project(cdp)
        print('harness project:', ok, str(info)[:180])
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=30, desc='剧本模式')
        time.sleep(1.2)
        # 丢弃 harness 项目里可能存在的旧备份，避免弹窗挡住画布
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find((x) => (x.textContent || '').includes('丢弃备份')); if (b) { b.click(); return true; } return false; })()")
        time.sleep(0.8)

        loaded = cdp.eval(LOAD_JS.replace('__NAME__', json.dumps(KEY)))
        print('load:', str(loaded)[:400])
        if not isinstance(loaded, str) or '"ok":true' not in loaded.replace(' ', ''):
            raise SystemExit('真实底图未加载成功：%s' % loaded)
        # 压叠闸门/命名/删除确认都会走 window.confirm —— 不拦掉，headless 里会直接返回 false，
        # 表现就是“画了但什么都没发生”（第一版探针的 12/12 空转就是这么来的）。
        cdp.eval("window.confirm = () => true; window.alert = () => {}; window.prompt = () => 'S0';")
        canvas = json.loads(loaded)['canvas']
        land = _json(cdp, "JSON.stringify(window.__S0.landPoint())", None)
        sea = _json(cdp, "JSON.stringify(window.__S0.seaPoint())", None)
        border = _json(cdp, "JSON.stringify(window.__S0.borderPoint())", None)
        print('canvas:', canvas)
        print('land:', land, 'sea:', sea, 'border:', border)
        if not land:
            raise SystemExit('找不到可用的陆地画布点')

        base = stats(cdp)
        print('baseline:', json.dumps(base, ensure_ascii=False)[:300])
        out = {'map': 'docs/mockups/desite.map', 'key': KEY, 'canvas': canvas,
               'points': {'land': land, 'sea': sea, 'border': border},
               'baseline': base, 'tools': []}

        # 每项：id / tool / kind / extra
        specs = [
            ('01-draw', 'draw', 'loop', ''),
            ('02-outline', 'outline', 'loop', ''),
            ('03-brush-paint', 'provinceBrush', 'line', 'paint'),
            ('04-lasso', 'provinceLasso', 'loop', 'lasso'),
            ('05-polysplit', 'polySplit', 'split', ''),
            ('06-river', 'river', 'line', ''),
            ('07-river-erase', 'riverErase', 'erase', ''),
            ('08-height', 'height', 'line', ''),
            ('09-biome', 'biome', 'line', ''),
            ('10-culture', 'culture', 'line', ''),
            ('11-religion', 'religion', 'line', ''),
            ('12-brush-erase', 'provinceBrush', 'line', 'erase'),
        ]

        for tid, tool, kind, extra in specs:
            item = {'id': tid, 'tool': tool, 'kind': kind, 'extra': extra}
            try:
                cdp.eval("window.__S0.snap()")
                before = stats(cdp)
                item['shotBefore'] = shot(cdp, tid + '-before')
                cdp.eval("(() => { const sc = document.querySelector('.scenario-map-container')"
                         ".__vueParentComponent.setupState;"
                         " sc.setTool(%s);"
                         " sc.provBrushTool = %s;"
                         " sc.provBrushRadius = 40;"
                         " return 'ok'; })()" % (json.dumps(tool), json.dumps(extra if extra in ('paint', 'erase') else 'paint')))
                time.sleep(0.35)
                # 🔴 工具切换会改变布局（省份行 / 底图编辑模式行都会把画布顶下去或压窄），
                #    所以**必须在切完工具之后**再取点；用切之前的点会落到工具栏上，
                #    表现就是“鼠标动了、数据没动”（第二版探针的 11/12 空转）。
                if tid == '01-draw':
                    pt = _json(cdp, "JSON.stringify(window.__S0.seaPoint())", None) \
                        or _json(cdp, "JSON.stringify(window.__S0.landPoint())", None) or land
                    radius = 70
                elif tid == '02-outline':
                    pt = _json(cdp, "JSON.stringify(window.__S0.borderPoint())", None) \
                        or _json(cdp, "JSON.stringify(window.__S0.landPoint())", None) or land
                    radius = 45
                else:
                    pt = _json(cdp, "JSON.stringify(window.__S0.landPoint())", None) or land
                    radius = 70
                # 画布会随面板开合变高变窄；把落点与线的两端都夹进**当前**画布，
                # 否则 mouseup 落在画布外（组件没做 pointer capture）→ 整笔永不提交。
                rect = _json(cdp, "JSON.stringify((() => { const sc = document.querySelector('.scenario-map-container')"
                                  ".__vueParentComponent.setupState; const r = sc.canvas.getBoundingClientRect();"
                                  " return { l: r.left, t: r.top, w: r.width, h: r.height }; })())", None)
                if not rect:
                    raise RuntimeError('读不到当前画布矩形')
                m = 28
                px = min(max(pt['x'], rect['l'] + m), rect['l'] + rect['w'] - m)
                py = min(max(pt['y'], rect['t'] + m), rect['t'] + rect['h'] - m)
                pt = {'x': px, 'y': py, 'id': pt.get('id')}
                item['pt'] = pt
                item['canvasAtDraw'] = rect
                if extra in ('paint', 'lasso', 'erase'):
                    cdp.eval("window.__S0.pick(%f, %f)" % (px, py))
                    time.sleep(0.2)
                x0 = max(rect['l'] + 18, px - 55)
                x1 = min(rect['l'] + rect['w'] - 18, px + 55)
                y0 = max(rect['t'] + 18, py - 22)
                y1 = min(rect['t'] + rect['h'] - 18, py + 22)
                # 自由绘制放在海面：避免一画就撞已有省份的压叠闸门；
                # 描轮廓贴着「陆地/邻省」的边界点；其余都在陆地省内部。
                if tid == '07-river-erase':
                    # 先画一条河，再擦它
                    cdp.eval("(() => { const sc = document.querySelector('.scenario-map-container')"
                             ".__vueParentComponent.setupState; sc.setTool('river'); return 'ok'; })()")
                    time.sleep(0.25)
                    do_stroke(cdp, 'line', x0=x0, y0=py - 8, x1=x1, y1=py + 8, steps=16)
                    time.sleep(0.7)
                    cdp.eval("(() => { const sc = document.querySelector('.scenario-map-container')"
                             ".__vueParentComponent.setupState; sc.setTool('riverErase'); return 'ok'; })()")
                    time.sleep(0.25)
                    do_stroke(cdp, 'line', x0=px - 12, y0=max(rect['t'] + 18, py - 35),
                              x1=px + 12, y1=min(rect['t'] + rect['h'] - 18, py + 35), steps=8)
                elif kind == 'loop':
                    base_r = 38 if tool == 'provinceLasso' else radius
                    rr = min(base_r, max(18, (rect['w'] - 70) / 2), max(18, (rect['h'] - 70) / 2))
                    do_stroke(cdp, 'loop', cx=px, cy=py, r=rr, steps=30)
                elif kind == 'line':
                    do_stroke(cdp, 'line', x0=x0, y0=y0, x1=x1, y1=y1, steps=14)
                elif kind == 'split':
                    do_stroke(cdp, 'split', cx=px, cy=py,
                              dx=min(70, (x1 - x0) / 2), dy=min(45, (y1 - y0) / 2))
                elif kind == 'erase':
                    do_stroke(cdp, 'line',
                              x0=max(rect['l'] + 18, px - 35), y0=max(rect['t'] + 18, py - 35),
                              x1=min(rect['l'] + rect['w'] - 18, px + 35),
                              y1=min(rect['t'] + rect['h'] - 18, py + 35), steps=8)
                time.sleep(0.8)
                after = stats(cdp)
                item['before'] = before
                item['after'] = after
                item['geom'] = _json(cdp, "JSON.stringify(window.__S0.changed())", [])
                item['lastProv'] = _json(cdp, "JSON.stringify(window.__S0.lastProv())", None)
                item['riverStats'] = _json(cdp, "JSON.stringify(window.__S0.riverStats())", [])
                item['shot'] = shot(cdp, tid)
                # 只对「改省份/河流」的工具做撤销复原；高度/群系/文化/宗教改的是
                # 各自独立的图层（高度图/群系网格/通道），累积着正好能看出后一笔有没有被前一笔影响。
                if tool in ('draw', 'outline', 'provinceBrush', 'provinceLasso',
                            'polySplit', 'river', 'riverErase'):
                    item['undoCount'] = undo_until(cdp, base)
                else:
                    item['undoCount'] = 0
                item['restored'] = stats(cdp)
                item['ok'] = True
            except Exception as e:
                item['ok'] = False
                item['error'] = str(e)[:300]
                try:
                    item['shot'] = shot(cdp, tid + '-error')
                except Exception:
                    pass
            out['tools'].append(item)
            print('%-16s %s  terrain %s→%s  rivers %s→%s  undo=%s' % (
                tid, item.get('ok'),
                item.get('before', {}).get('terrain'), item.get('after', {}).get('terrain'),
                item.get('before', {}).get('rivers'), item.get('after', {}).get('rivers'),
                item.get('undoCount')))

        with open(SUMMARY, 'w', encoding='utf-8') as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
        print('summary ->', os.path.relpath(SUMMARY, ROOT))
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
