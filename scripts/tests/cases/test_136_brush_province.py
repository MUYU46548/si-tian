#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 136：笔刷建省（2026-10-22，暮雨「像画图一样涂出一块地」）

背景（上一轮他拍板 A 方案的原话）：
  「按住左键像涂色一样抹，松手自动把抹过的范围长成一个省（不用闭合、不会出现一团自交线，
    涂抹过程就是最终形状）」「必须先做 A。说破了司天本质就是地图编辑器……连 Windows 画图都不如
    也太难绷了。」

本用例守的是**接线与交互**（几何本身由 Node 单测 `test_brush_province.js` 用真布尔引擎断言）：
  a 入口：底图编辑行有「笔刷建省」按钮且真的切到 `provincePaint`；日常省份行/空底图提示卡也有入口；
  b 空底图上**真鼠标拖一笔** → 只多出 1 个省，顶点 ≥ 3、没有自交怪形（面积 > 0）；
  c **涂抹期零落库**：按住拖动时省份数仍为 0（只有轨迹），松手才建省；
  d 整笔压在已有省份上 → 拒绝（可读回执提到「空地」），省份数不变、已有省界**逐字节不动**；
  e 一笔 = 一条撤销（`undo()` 一次回到只有 1 个省）；
  f 两笔两块省**互不压叠**（顶点采样判据）；
  g 源码闸门：按钮/函数/提示/写闸门登记/快捷键都在（防"改一处另两处不变"）。
"""
import json
import os
import time

from lib.cdp import eval_json, wait_for

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
KEY = 'case136'
SC = KEY + '/甲时代'

# ── 源码闸门（五处必须同时在：UI / 入口函数 / 画布提示 / store 写口 / 写闸门契约）─────────
GATES = [
    ('src/renderer/src/components/ScenarioMap.vue',
     ['data-testid="basemap-tool-provincePaint"',
      'data-testid="province-paint-entry"',
      'data-testid="empty-province-brush"',
      'function startPaintingProvince(',
      'data-testid="province-paint-hint"',
      "tool === 'provincePaint'",
      "setTool('provincePaint')"],
     'ScenarioMap 入口 / 按钮 / 提示'),
    ('src/renderer/src/store/geodataModules/provinceEditing.js',
     ['function createProvinceFromBrush(', "s.tool === 'provincePaint'", 'paintProvinceShape('],
     'store 笔刷建省写口'),
    ('src/renderer/src/utils/brushProvince.js',
     ['export function paintProvinceShape(', 'export function subtractProvinces('],
     '纯几何层'),
    ('src/renderer/src/store/writeGate.js',
     ["'createProvinceFromBrush'"],
     '内存写入口契约登记（test_54 反向扫描要求）'),
]

SEED_JS = r"""
(async () => {
  const s = __STORE__, sm = __SM__;
  for (const k of Object.keys(s.scenarios || {})) s.removeScenario(k);
  if (!s.baseMaps[__KEY__]) s.addBaseMap(__KEY__, { name: __KEY__ });
  s.baseMaps[__KEY__].terrain.length = 0;
  s.baseMaps[__KEY__].rivers = [];
  s.createScenario(__SC__, { ownerKey: __KEY__, name: '甲时代', order: 1,
    era: { startYear: '2000', endYear: '2010' }, polities: [], ownership: {} });
  sm.baseMapKey = __KEY__;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  sm.selectScenario(s.scenarios[__SC__]);
  sm.emptyHintDismissed = false;
  sm.basemapEditMode = false;
  sm.moreOpen = false;
  sm.setTool('select');
  sm.provBrushRadius = 26;
  const cv = document.querySelector('.scenario-map-container canvas');
  const rc = cv.getBoundingClientRect();
  return JSON.stringify({ rect: { left: rc.left, top: rc.top, w: rc.width, h: rc.height } });
})()
"""

# 🔴 为什么落笔点要"现算"，而且第二笔前要先滚轮缩小（2026-10-22 实测踩到两次）：
#    ① `ScenarioMap` 有一个 watch：**省份增删时自动适屏**（源码 `watch([baseMapKey, terrain.length])`
#       → 50ms 后 `fitToView()`）。建出第一个省之后相机会自己缩放/平移 —— 沿用上一轮算好的
#       屏幕坐标，第二笔会落到第一块省的地盘上（实测被 all-covered 拒绝，看着像产品缺陷）。
#    ② 适屏会把**唯一那个省**放大到占满画布 → 画布上几乎所有位置都在它里面。
#       所以要像真人一样**先滚轮缩小**（`Input.dispatchMouseEvent` 的 mouseWheel，走的是
#       `onWheel` 真实缩放），再从"已有省份屏幕范围的右侧 80px"起笔。
#    这样落笔点全部由**当前相机**现算，不依赖任何固定镜位、也不依赖测试去改相机。
PLACE_FIRST_JS = r"""
(() => {
  const sm = __SM__;
  const cv = document.querySelector('.scenario-map-container canvas');
  const rc = cv.getBoundingClientRect();
  const cx = Math.round(rc.left + rc.width / 2);
  const cy = Math.round(rc.top + rc.height / 2);
  return JSON.stringify({
    rect: { left: rc.left, top: rc.top, w: rc.width, h: rc.height },
    a1: { x: cx - 60, y: cy }, a2: { x: cx + 60, y: cy },
    center: { x: cx, y: cy },
  });
})()
"""

# 第二笔：按**当前相机下已有省份的屏幕 bbox** 现算，找不到空间就明确失败（不猜）
PLACE_SECOND_JS = r"""
(() => {
  const sm = __SM__, s = __STORE__;
  const cv = document.querySelector('.scenario-map-container canvas');
  const rc = cv.getBoundingClientRect();
  const terr = (s.baseMaps[__KEY__] && s.baseMaps[__KEY__].terrain) || [];
  const xs = [], ys = [];
  for (const p of terr) for (const q of p.points || []) { xs.push(q.x); ys.push(q.y); }
  if (!xs.length) return JSON.stringify({ fails: ['还没有省份，算不出第二笔的位置'] });
  const a = sm.worldToScreen(Math.min(...xs), Math.min(...ys));
  const b = sm.worldToScreen(Math.max(...xs), Math.max(...ys));
  const cy = Math.round(rc.top + rc.height / 2);
  // 已有省份右侧 80px 起笔（笔刷半径 26px → 屏幕上至少留 54px 空隙，必然不压叠）
  const x0 = Math.round(rc.left + b.x + 80);
  const x1 = x0 + 120;
  const fails = [];
  if (x0 < rc.left + 10 || x1 > rc.left + rc.width - 10) {
    fails.push(`第二笔的屏幕位置出界：x ${x0}..${x1}（画布 ${Math.round(rc.left)}..${Math.round(rc.left + rc.width)}，`
      + `已有省份屏幕 bbox x ${Math.round(rc.left + a.x)}..${Math.round(rc.left + b.x)}）—— 缩小没生效？`);
  }
  return JSON.stringify({
    fails, b1: { x: x0, y: cy }, b2: { x: x1, y: cy },
    provScreen: [Math.round(rc.left + a.x), Math.round(rc.left + b.x)],
    scale: sm.cameraScale,
  });
})()
"""

STATE_JS = r"""
(() => {
  const s = __STORE__, sm = __SM__;
  const terr = (s.baseMaps[__KEY__] && s.baseMaps[__KEY__].terrain) || [];
  let pathLen = -1;
  try { pathLen = s.getProvinceStrokePath().length; } catch (e) { pathLen = -2; }
  return JSON.stringify({
    count: terr.length,
    hint: String(sm.provinceHint || ''),
    tool: sm.tool,
    edit: !!sm.basemapEditMode,
    pathLen,
    geom: JSON.stringify(terr.map(p => ({ points: p.points || [], extra: p.extraRings || [] }))),
    pts: terr.map(p => (p.points || []).length),
    fromGrid: terr.map(p => p.fromGrid === true),
    names: terr.map(p => p.name),
  });
})()
"""

# 顶点采样判据：A 的顶点落进 B 的环里 = 压叠（纯射线法，不依赖 store 内部）
OVERLAP_JS = r"""
(() => {
  const s = __STORE__;
  const terr = (s.baseMaps[__KEY__].terrain) || [];
  if (terr.length < 2) return JSON.stringify({ fails: ['省份不足 2 个，无法判压叠：' + terr.length] });
  const ringsOf = (p) => [p.points || []].concat((p.extraRings || []).map(r => r.points || []));
  const pip = (ring, x, y) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if (!a || !b) continue;
      if (((a.y > y) !== (b.y > y)) && (x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x)) c = !c;
    }
    return c;
  };
  const inside = (p, x, y) => ringsOf(p).some(r => r.length >= 3 && pip(r, x, y));
  let hits = 0, checked = 0;
  for (let i = 0; i < terr.length; i++) {
    for (let j = 0; j < terr.length; j++) {
      if (i === j) continue;
      for (const q of ringsOf(terr[i])[0] || []) {
        if (!q || !Number.isFinite(q.x) || !Number.isFinite(q.y)) continue;
        checked++;
        if (inside(terr[j], q.x, q.y)) hits++;
      }
    }
  }
  return JSON.stringify({ fails: [], hits, checked });
})()
"""


def _js(tpl):
    return (tpl.replace('__STORE__', STORE).replace('__SM__', SM)
            .replace('__KEY__', json.dumps(KEY)).replace('__SC__', json.dumps(SC)))


def _state(cdp, desc):
    ok, v = eval_json(cdp, _js(STATE_JS), required=None, desc=desc)
    if not (isinstance(ok, bool) and ok and isinstance(v, dict)):
        raise RuntimeError(f'{desc} 探针失败：{v}')
    return v


def _send(cdp, kind, p, buttons):
    cdp.send('Input.dispatchMouseEvent', {
        'type': kind, 'x': p['x'], 'y': p['y'],
        'button': 'left', 'buttons': buttons,
        'clickCount': 1 if kind in ('mousePressed', 'mouseReleased') else 0,
    })


def _drag(cdp, pts, pause=0.05):
    _send(cdp, 'mousePressed', pts[0], 1)
    for p in pts[1:]:
        _send(cdp, 'mouseMoved', p, 1)
        time.sleep(pause)
    _send(cdp, 'mouseReleased', pts[-1], 0)
    time.sleep(0.45)


def _click(cdp, p):
    _send(cdp, 'mousePressed', p, 1)
    time.sleep(0.05)
    _send(cdp, 'mouseReleased', p, 0)
    time.sleep(0.45)


def _wheel(cdp, p, notches, delta=120):
    """真滚轮（走 onWheel）：deltaY > 0 = 缩小。"""
    for _ in range(int(notches)):
        cdp.send('Input.dispatchMouseEvent', {
            'type': 'mouseWheel', 'x': p['x'], 'y': p['y'],
            'deltaX': 0, 'deltaY': delta,
        })
        time.sleep(0.03)
    time.sleep(0.35)


def _js_eval(cdp, tpl, desc, **subs):
    js = _js(tpl)
    for k, v in subs.items():
        js = js.replace(k, json.dumps(v))
    ok, v = eval_json(cdp, js, required=None, desc=desc)
    if not (isinstance(ok, bool) and ok and isinstance(v, dict)):
        raise RuntimeError(f'{desc} 失败：{v}')
    return v


def _gates():
    fails = []
    for rel, needles, label in GATES:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            fails.append(f'{label}：文件不存在 {rel}')
            continue
        src = open(path, encoding='utf-8').read()
        for n in needles:
            if n not in src:
                fails.append(f'{label}：缺 `{n}`（{rel}）')
    return fails


def _place_first(cdp):
    v = _js_eval(cdp, PLACE_FIRST_JS, '第一笔的落笔点')
    rect = v['rect']
    for name in ('a1', 'a2', 'center'):
        p = v[name]
        if not (rect['left'] + 2 <= p['x'] <= rect['left'] + rect['w'] - 2
                and rect['top'] + 2 <= p['y'] <= rect['top'] + rect['h'] - 2):
            raise RuntimeError(f'落笔点 {name} 在画布外：{p}（画布 {rect["w"]:.0f}×{rect["h"]:.0f}）')
    return v


def run(cdp):
    fails = _gates()

    cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
             ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式')

    ok, seed = eval_json(cdp, _js(SEED_JS), required=None, desc='造数')
    if not (ok and isinstance(seed, dict)):
        return False, f'造数失败：{seed}'
    notes = [f"画布 {seed['rect']['w']:.0f}×{seed['rect']['h']:.0f}"]

    # ── a 入口：底图编辑行的按钮真的切到 provincePaint ────────────────────────────
    entry = eval_json(cdp, """(async () => {
      const sm = __SM__;
      const tick = () => new Promise(r => setTimeout(r, 0));
      sm.basemapEditMode = true;
      await tick();
      const btn = document.querySelector('[data-testid="basemap-tool-provincePaint"]');
      if (!btn) return JSON.stringify({ fails: ['底图编辑行找不到「笔刷建省」按钮'] });
      btn.click();
      await tick();
      const hint = document.querySelector('[data-testid="province-paint-hint"]');
      return JSON.stringify({ fails: [], tool: sm.tool, hint: !!hint, text: (btn.textContent || '').trim() });
    })()""".replace('__SM__', SM), required=None, desc='点笔刷建省')
    entry = entry[1] if isinstance(entry, tuple) and entry[0] else {}
    if isinstance(entry, dict) and entry.get('fails'):
        fails += entry['fails']
    elif not isinstance(entry, dict) or entry.get('tool') != 'provincePaint':
        fails.append(f"点「笔刷建省」切到的是 {entry.get('tool') if isinstance(entry, dict) else entry}（应为 provincePaint）")
    elif not entry.get('hint'):
        fails.append('切到笔刷建省后没有画布提示（用户不知道这一笔会干什么）')

    # ── c 涂抹期零落库 + b 松手建省 ───────────────────────────────────────────────
    pos = _place_first(cdp)
    _send(cdp, 'mousePressed', pos['a1'], 1)
    time.sleep(0.05)
    _send(cdp, 'mouseMoved', {'x': round((pos['a1']['x'] + pos['a2']['x']) / 2), 'y': pos['a1']['y']}, 1)
    time.sleep(0.1)
    mid = _state(cdp, '拖动中')
    if mid['count'] != 0:
        fails.append(f"涂抹期就落库了（省份数 {mid['count']}）—— 应当是松手才建省")
    if mid['pathLen'] < 2:
        fails.append(f"涂抹期没有累积轨迹（getProvinceStrokePath 长度 {mid['pathLen']}）—— 画布预览是空的")
    _send(cdp, 'mouseMoved', pos['a2'], 1)
    time.sleep(0.08)
    _send(cdp, 'mouseReleased', pos['a2'], 0)
    time.sleep(0.6)

    one = _state(cdp, '第一笔之后')
    if one['count'] != 1:
        fails.append(f"空底图上拖一笔没有建出**一个**省（省份数 {one['count']}）—— 回执「{one['hint'][:80]}」")
    elif one['pts'][0] < 3:
        fails.append(f"建出来的省只有 {one['pts'][0]} 个顶点（形状退化）")
    if '笔刷建省' not in one['hint']:
        fails.append(f"建省后状态栏没有回执：{one['hint'][:100]}")
    if '撤销' not in one['hint']:
        fails.append(f"回执没说「一笔 = 一条撤销」：{one['hint'][:100]}")
    if any(one['fromGrid']):
        fails.append('新省带 fromGrid=true —— 渲染端会把它 Chaikin 平滑（点数×4、形状变形）')
    geom1 = one['geom']
    notes.append(f"第一笔 → {one['count']} 个省 / {one['pts']} 顶点；回执「{one['hint'][:60]}」")

    # ── d 整笔压在已有省份上 → 拒绝，且省界逐字节不动 ────────────────────────────
    # 建省后组件会「自动适屏」（省份数变化 → 50ms 后 fitToView），此时唯一的省占满画布 →
    # 画布正中央必然在它里面（正好是这条要测的场景）。
    time.sleep(0.3)
    pos = _place_first(cdp)
    _click(cdp, pos['center'])
    after_click = _state(cdp, '压在已有省份上点一下')
    if after_click['count'] != 1:
        fails.append(f"整笔压在已有省份上竟然又建了一个省（省份数 {after_click['count']}）—— 会造出压叠")
    if after_click['geom'] != geom1:
        fails.append('被拒绝的那一笔改了已有省份的几何（应零副作用）')
    if '空地' not in after_click['hint'] and '改省界' not in after_click['hint']:
        fails.append(f'拒绝分支没有说清原因与下一步：{after_click["hint"][:120]}')
    notes.append(f"压在已有省份上 → 拒绝且省界未动（回执「{after_click['hint'][:50]}」）")

    # ── e 一笔 = 一条撤销 ──────────────────────────────────────────────────────────
    eval_json(cdp, "(() => { %s.undo(); return 'ok'; })()" % STORE, required=None, desc='撤销')
    time.sleep(0.35)
    undone = _state(cdp, '撤销后')
    if undone['count'] != 0:
        fails.append(f"一次撤销没有回到空底图（省份数 {undone['count']}）—— 一笔必须 = 一条撤销")
    eval_json(cdp, "(() => { %s.redo(); return 'ok'; })()" % STORE, required=None, desc='重做')
    time.sleep(0.35)
    redone = _state(cdp, '重做后')
    if redone['count'] != 1:
        fails.append(f"重做没有把省长回来（省份数 {redone['count']}）")

    # ── f 第二笔：滚轮缩小 → 在已有省份右侧再涂一块 → 两块互不压叠 ─────────────────
    time.sleep(0.4)
    pos = _place_first(cdp)                 # 只要中心和画布 rect
    _wheel(cdp, pos['center'], 8)           # 真人也会这么做：唯一那个省被适屏放大了
    second = _js_eval(cdp, PLACE_SECOND_JS, '第二笔的落笔点')
    if second.get('fails'):
        fails += second['fails']
    else:
        notes.append(f"第二笔屏幕位置 {second['b1']}→{second['b2']}（已有省份屏幕 x {second['provScreen']}，scale={second['scale']:.2f}）")
        _drag(cdp, [second['b1'], {'x': round((second['b1']['x'] + second['b2']['x']) / 2), 'y': second['b1']['y']}, second['b2']])
    two = _state(cdp, '第二笔之后')
    if two['count'] != 2:
        fails.append(f"第二笔没有建出第二个省（省份数 {two['count']}）—— 回执「{two['hint'][:80]}」")
    ov = eval_json(cdp, _js(OVERLAP_JS), required=None, desc='压叠判据')
    ov = ov[1] if isinstance(ov, tuple) and ov[0] else {}
    if isinstance(ov, dict) and ov.get('fails'):
        fails += ov['fails']
    elif not isinstance(ov, dict):
        fails.append(f'压叠判据探针失败：{ov}')
    else:
        if ov.get('hits'):
            fails.append(f"两块省压叠了：{ov.get('hits')} / {ov.get('checked')} 个顶点落在另一块里面")
        notes.append(f"第二笔 → 2 个省，压叠采样 {ov.get('hits')}/{ov.get('checked')}")

    # ── 入口补测：日常省份行 + 空底图提示卡 ────────────────────────────────────────
    daily = eval_json(cdp, """(async () => {
      const sm = __SM__;
      const s = __STORE__;
      const tick = () => new Promise(r => setTimeout(r, 0));
      // 先清空省份，让空底图提示卡有机会出现
      const before = (s.baseMaps[__KEY__].terrain || []).length;
      s.baseMaps[__KEY__].terrain.length = 0;
      sm.basemapEditMode = false;
      sm.moreOpen = true;
      sm.emptyHintDismissed = false;
      sm.setTool('select');
      await tick();
      const rowEntry = document.querySelector('[data-testid="province-paint-entry"]');
      const cardBtn = document.querySelector('[data-testid="empty-province-brush"]');
      rowEntry && rowEntry.click();
      await tick();
      const tool1 = sm.tool;
      // 回到空底图提示卡那条路
      sm.basemapEditMode = false;
      sm.setTool('select');
      await tick();
      const card = document.querySelector('[data-testid="empty-province-brush"]');
      if (card) card.click();
      await tick();
      return JSON.stringify({
        fails: before !== 2 ? ['清空省份前不是 2 个省：' + before] : [],
        rowEntry: !!rowEntry, cardBtn: !!cardBtn, tool1,
        tool2: sm.tool, edit2: !!sm.basemapEditMode,
      });
    })()""".replace('__SM__', SM).replace('__STORE__', STORE).replace('__KEY__', json.dumps(KEY)),
        required=None, desc='入口补测')
    daily = daily[1] if isinstance(daily, tuple) and daily[0] else {}
    if isinstance(daily, dict):
        if daily.get('fails'):
            fails += daily['fails']
        if not daily.get('rowEntry'):
            fails.append('日常模式的省份行里没有「笔刷建省」入口')
        elif daily.get('tool1') != 'provincePaint':
            fails.append(f"省份行入口点了切到 {daily.get('tool1')}（应为 provincePaint）")
        if not daily.get('cardBtn'):
            fails.append('空底图提示卡里没有「像画图一样涂一块（笔刷建省）」按钮')
        elif daily.get('tool2') != 'provincePaint' or not daily.get('edit2'):
            fails.append(f"提示卡按钮没有进底图编辑 + 笔刷建省（tool={daily.get('tool2')} edit={daily.get('edit2')}）")

    # 收尾
    eval_json(cdp, """(() => {
      const s = __STORE__, sm = __SM__;
      if (s.baseMaps[__KEY__]) s.removeBaseMap(__KEY__);
      sm.moreOpen = false;
      sm.basemapEditMode = false;
      sm.baseMapKey = '';
      return 'ok';
    })()""".replace('__STORE__', STORE).replace('__SM__', SM).replace('__KEY__', json.dumps(KEY)),
        required=None, desc='收尾')
    time.sleep(0.3)

    if fails:
        return False, ' | '.join(notes) + ' ⇒ ' + ' ；'.join(fails)
    return True, ' | '.join(notes) + ' ⇒ 入口/涂抹期零落库/建省/拒绝/一条撤销/不压叠 全部通过'
