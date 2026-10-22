#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 133：手绘笔刷「画得出正常的东西」+ 涂色=录事件 + 载入→改→存→再载入（第三刀）

用户原话（2026-10-22）：「当前手绘笔刷只画诡异几何」。
几何边界（8 字自交、松手回勾、一条线）由 `unit/test_freehand_ring.js` 在 Node 里逐值判；
本用例用**真实鼠标**守「接线 + 落库 + 账本 + 往返」：

  a 方框：成一个省；顶点少、fill 高、**零自交**；一笔 = 一条 undo（undo/redo）；
  b 直线：**不建省**，状态栏给可读原因（不再画出一个怪多边形）；
  c 涂归属 = 录事件：涂过的省在 `changeEvents` 里有**带日期**的易主事件；
     且 `timelineEvents`（外交账本）不被顺手写脏 —— 两本账不双写；一笔一条 undo；
  d 载入→改→存→再载入：项目载荷里的省界与内存逐点一致，重载后不丢。

⚠️ 原生 `confirm()` 会**阻塞渲染进程**（CDP 命令一起卡住）：用例里把它换成计数桩，
   顺带断言「方框/直线这两笔根本不该触发压叠确认」。
"""
import json
import time

from lib.cdp import eval_json, wait_for
from lib.helpers import ensure_case_state

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
KEY = 'case133'
SC = KEY + '/甲时代'


# ── 造数 / 读状态 ────────────────────────────────────────────────────────────
def _seed(cdp):
    js = r"""
(() => {
  const s = __STORE__, sm = __SM__;
  for (const k of Object.keys(s.scenarios || {})) s.removeScenario(k);
  if (!s.baseMaps[__KEY__]) s.addBaseMap(__KEY__, { name: __KEY__ });
  s.baseMaps[__KEY__].terrain.length = 0;
  s.baseMaps[__KEY__].rivers = [];
  s.createScenario(__SC__, { ownerKey: __KEY__, name: '甲时代', order: 1,
    era: { startYear: '2000', endYear: '2010' },
    polities: [{ id: 'P1', name: '甲国', color: '#c23b3b' }, { id: 'P2', name: '乙国', color: '#4a90d9' }],
    ownership: {} });
  sm.baseMapKey = __KEY__;
  if (typeof sm.onBaseMapChange === 'function') sm.onBaseMapChange();
  sm.selectScenario(s.scenarios[__SC__]);
  sm.setTool('draw');
  sm.snapToEdgeEnabled = false;
  sm.snapToGridEnabled = false;
  sm.tlDate = { y: 2005, m: 6, d: 1 };
  window.__confirmCalls = 0;
  window.confirm = () => { window.__confirmCalls += 1; return true; };
  const cv = document.querySelector('.scenario-map-container canvas');
  const rc = cv.getBoundingClientRect();
  return JSON.stringify({ rect: { left: rc.left, top: rc.top, w: rc.width, h: rc.height } });
})()
"""
    js = (js.replace('__STORE__', STORE).replace('__SM__', SM)
          .replace('__KEY__', json.dumps(KEY)).replace('__SC__', json.dumps(SC)))
    return eval_json(cdp, js, required=None, desc='造数')


def _state(cdp):
    ok, v = eval_json(cdp, """(() => {
      const s = __STORE__, sm = __SM__;
      const t = (s.baseMaps[__KEY__] && s.baseMaps[__KEY__].terrain) || [];
      const sc = s.scenarios[__SC__] || {};
      return JSON.stringify({
        count: t.length,
        provinces: t.map((p) => ({ id: p.id, name: p.name, points: (p.points || []).map((q) => [q.x, q.y]) })),
        hint: String(sm.provinceHint || ''),
        ownership: sc.ownership || {},
        changeEvents: sc.changeEvents || {},
        timelineEvents: sc.timelineEvents || [],
        confirmCalls: window.__confirmCalls || 0,
      });
    })()""".replace('__STORE__', STORE).replace('__SM__', SM)
        .replace('__KEY__', json.dumps(KEY)).replace('__SC__', json.dumps(SC)),
        required=None, desc='读状态')
    return v if ok and isinstance(v, dict) else {'error': v}


def _metrics(points):
    pts = [(float(a), float(b)) for a, b in points]
    n = len(pts)
    if n < 3:
        return {'n': n, 'area': 0.0, 'fill': 0.0, 'selfInt': 0}
    area = 0.0
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        area += x1 * y2 - x2 * y1
    area = abs(area) / 2
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    bw, bh = max(xs) - min(xs), max(ys) - min(ys)
    segs = [(pts[i], pts[(i + 1) % n]) for i in range(n)]

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    def proper(a, b, c, d):
        d1, d2 = cross(c, d, a), cross(c, d, b)
        d3, d4 = cross(a, b, c), cross(a, b, d)
        return ((d1 > 0 and d2 < 0) or (d1 < 0 and d2 > 0)) and ((d3 > 0 and d4 < 0) or (d3 < 0 and d4 > 0))

    self_int = 0
    for i in range(n):
        for j in range(i + 1, n):
            if (j + 1) % n == i or (i + 1) % n == j:
                continue
            if proper(segs[i][0], segs[i][1], segs[j][0], segs[j][1]):
                self_int += 1
    return {
        'n': n, 'area': round(area, 1),
        'fill': round(area / max(1e-9, bw * bh), 3),
        'selfInt': self_int,
    }


# ── 鼠标 ────────────────────────────────────────────────────────────────────
def _drag(cdp, pts, settle=0.04):
    cdp.send('Input.dispatchMouseEvent', {
        'type': 'mousePressed', 'x': pts[0]['x'], 'y': pts[0]['y'],
        'button': 'left', 'buttons': 1, 'clickCount': 1,
    })
    for p in pts[1:]:
        cdp.send('Input.dispatchMouseEvent', {
            'type': 'mouseMoved', 'x': p['x'], 'y': p['y'], 'button': 'left', 'buttons': 1,
        })
        time.sleep(settle)
    cdp.send('Input.dispatchMouseEvent', {
        'type': 'mouseReleased', 'x': pts[-1]['x'], 'y': pts[-1]['y'],
        'button': 'left', 'buttons': 0, 'clickCount': 1,
    })
    time.sleep(0.45)


def _hit(cdp, pt):
    ok, v = eval_json(cdp, """(() => {
      const r = document.elementFromPoint(%d, %d);
      return JSON.stringify({ tag: r && r.tagName, cls: r && r.className && String(r.className).slice(0, 50) });
    })()""" % (pt['x'], pt['y']), required=None, desc='hit')
    return v


def _shapes(rect):
    """画布中下部一块固定区域（上方是时间轴控件、左右是面板）。"""
    left, top, w, h = rect['left'], rect['top'], rect['w'], rect['h']
    ax0, ax1 = left + w * 0.36, left + w * 0.62
    ay0, ay1 = top + h * 0.32, top + h * 0.62
    aw, ah = ax1 - ax0, ay1 - ay0

    def sp(u, v):
        return {'x': round(ax0 + aw * u), 'y': round(ay0 + ah * v)}

    box = []
    bx0, by0, bx1, by1 = 0.10, 0.10, 0.60, 0.45
    for i in range(10):
        box.append((bx0 + (bx1 - bx0) * i / 10, by0))
    for i in range(10):
        box.append((bx1, by0 + (by1 - by0) * i / 10))
    for i in range(10):
        box.append((bx1 - (bx1 - bx0) * i / 10, by1))
    for i in range(10):
        box.append((bx0, by1 - (by1 - by0) * i / 10))
    box.append((bx0 + 0.004, by0 + 0.004))

    line = [(0.10 + 0.030 * i, 0.92) for i in range(18)]
    return [sp(*p) for p in box], [sp(*p) for p in line]


def _run(cdp):
    fails = []
    ok, info = ensure_case_state(cdp)
    if not ok:
        return False, f'harness 项目未就绪：{info}'
    cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
             ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式')

    ok, seed = _seed(cdp)
    if not (ok and isinstance(seed, dict) and seed.get('rect')):
        return False, f'造数失败：{seed}'
    rect = seed['rect']
    time.sleep(0.4)

    box, line = _shapes(rect)
    for label, pts in (('方框', box), ('直线', line)):
        hit = _hit(cdp, pts[0])
        if not (isinstance(hit, dict) and hit.get('tag') == 'CANVAS'):
            return False, f'{label}起笔点不在画布上（elementFromPoint={hit}）'

    note = ''
    # ── a 方框：几何 + 一条 undo ─────────────────────────────────────────────
    before = _state(cdp)
    _drag(cdp, box)
    after_box = _state(cdp)
    if after_box.get('count') != before.get('count') + 1:
        fails.append(f"方框没有建出省（{before.get('count')} → {after_box.get('count')}）：{after_box.get('hint')}")
    else:
        m = _metrics(after_box['provinces'][-1]['points'])
        if m['selfInt'] != 0:
            fails.append(f"方框落库后自交 {m['selfInt']} 处")
        if m['fill'] < 0.85:
            fails.append(f"方框 fill={m['fill']}（应接近 1）")
        if m['n'] > 12:
            fails.append(f"方框顶点 {m['n']} 个（简化不足）")
        note = f"方框 {m['n']} 点 / fill {m['fill']} / 自交 {m['selfInt']}"

    eval_json(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()", required=None, desc='undo')
    undone = _state(cdp)
    if undone.get('count') != before.get('count'):
        fails.append(f"方框一笔撤销没回到原状（{undone.get('count')}）")
    eval_json(cdp, f"(() => {{ {STORE}.redo(); return 'ok'; }})()", required=None, desc='redo')

    # ── b 直线：不建省 + 可读原因 ────────────────────────────────────────────
    base_count = _state(cdp).get('count')
    _drag(cdp, line)
    after_line = _state(cdp)
    if after_line.get('count') != base_count:
        fails.append(f"一条直线竟然建出了省（{base_count} → {after_line.get('count')}）—— 又回到『诡异几何』")
    if '没围出面积' not in str(after_line.get('hint')) and '太细' not in str(after_line.get('hint')):
        fails.append(f"直线被拒时没有可读原因：{after_line.get('hint')}")

    # ── c 涂归属 = 录事件（带日期），且不碰外交账本 ──────────────────────────
    prov = after_line['provinces'][0]
    cx = sum(p[0] for p in prov['points']) / len(prov['points'])
    cy = sum(p[1] for p in prov['points']) / len(prov['points'])
    ok_screen, screen = eval_json(cdp, ("(() => { const sm = %s; const p = sm.worldToScreen(%f, %f);"
                                       " const cv = document.querySelector('.scenario-map-container canvas');"
                                       " const rc = cv.getBoundingClientRect();"
                                       " return JSON.stringify({x: Math.round(rc.left+p.x), y: Math.round(rc.top+p.y)}); })()"
                                       % (SM, cx, cy)), required=None, desc='省中心')
    if isinstance(screen, dict) and 'x' in screen:
        eval_json(cdp, ("(() => { const sm = %s; sm.setTool('ownerBrush');"
                       " sm.selectPolity((sm.selectedScenario.polities || [])[0]);"
                       " sm.tlDate = { y: 2005, m: 6, d: 1 }; return 'ok'; })()" % SM),
                  required=None, desc='ownerBrush')
        _drag(cdp, [screen, {'x': screen['x'] + 3, 'y': screen['y'] + 2}])
        st = _state(cdp)
        ev = (st.get('changeEvents') or {}).get(prov['id']) or []
        if not ev:
            fails.append(f"涂归属没写下 changeEvents：{json.dumps(st.get('changeEvents'), ensure_ascii=False)[:160]}")
        else:
            last = ev[-1]
            if last.get('owner') != 'P1':
                fails.append(f"涂归属写下的 owner 不对：{last}")
            if not (last.get('y') == 2005 and last.get('m') == 6 and last.get('d') == 1):
                fails.append(f"涂归属没记录当前时间轴日期：{last}")
        if st.get('timelineEvents'):
            fails.append(f"涂归属顺手写脏了外交账本（timelineEvents={len(st['timelineEvents'])} 条）—— 违反两本账不双写")
        eval_json(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()", required=None, desc='undo 归属')
        back = _state(cdp)
        if (back.get('changeEvents') or {}).get(prov['id']):
            fails.append('撤销后 changeEvents 没还原（一笔一条 undo 失效）')

    # ── d 载入→改→存→再载入 ─────────────────────────────────────────────────
    time.sleep(1.0)
    eval_json(cdp, "window.__probe.flushProject()", required=None, desc='flush')
    ok_saved, saved = eval_json(cdp, """(() => {
      const p = window.__probe.lastProject();
      const bm = p && p.scenarios && p.scenarios.baseMaps ? p.scenarios.baseMaps[__KEY__] : null;
      return JSON.stringify(bm ? { terrain: bm.terrain.map((q) => ({ id: q.id, points: (q.points || []).map((z) => [z.x, z.y]) })) } : { none: true });
    })()""".replace('__KEY__', json.dumps(KEY)), required=None, desc='读载荷')
    live = _state(cdp)['provinces']
    if not isinstance(saved, dict) or 'terrain' not in saved:
        fails.append(f'项目载荷里没有这张底图：{saved}')
    else:
        saved_by_id = {t['id']: t['points'] for t in saved['terrain']}
        for p in live:
            if p['id'] not in saved_by_id:
                fails.append(f"载荷里缺省 {p['id']}")
                continue
            if saved_by_id[p['id']] != p['points']:
                fails.append(f"省 {p['id']} 的省界在载荷里变了形（内存 {len(p['points'])} 点 / 载荷 {len(saved_by_id[p['id']])} 点）")
        if not fails:
            eval_json(cdp, """(() => {
              const s = %s;
              const p = window.__probe.lastProject();
              s.applyScenarioState({ baseMaps: p.scenarios.baseMaps, scenarios: p.scenarios.scenarios }, { fresh: true });
              return 'ok';
            })()""" % STORE, required=None, desc='重载')
            reloaded = _state(cdp)['provinces']
            if json.dumps([(p['id'], p['points']) for p in reloaded], sort_keys=True) != \
               json.dumps([(p['id'], p['points']) for p in live], sort_keys=True):
                fails.append('重载后省界与重载前不一致（载入→改→存→再载入 有丢失）')

    end = _state(cdp)
    if end.get('confirmCalls'):
        fails.append(f"这两笔触发了 {end['confirmCalls']} 次压叠确认（形状互不重叠，不该问）")

    if fails:
        return False, '；'.join(fails)
    return True, note or '通过'


def run(cdp):
    import traceback
    try:
        return _run(cdp)
    except Exception:
        return False, 'TRACE: ' + traceback.format_exc()[-900:]
