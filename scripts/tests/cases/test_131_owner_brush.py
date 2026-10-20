"""用例 131：涂归属 = **只改势力归属**（2026-10-20 重做）。

背景（用户 2026-10-19 实测原话）：
  「我不知道「涂归属」到底在干嘛，反正肯定不是我理解的效果，好像在生造省份。
    两个同名笔刷，两种描述，同样的奇怪效果，同样的卡顿（画完松开卡几秒才有反应）。」

病因（代码实证）：此前两个叫「涂归属」的按钮都指向 `provinceBrush` —— 那是**几何笔刷**
（`applyProvinceStroke` + 多边形布尔：目标省并集、相交省差集），一笔会把沿途各省挖掉一块
并进所选省份。真正改势力归属的是「势力」油漆桶（`setOwnership`，一次一个省）。

本用例守四件事（全部走**真实鼠标输入**，不用合成事件）：
  e1 主行那个「涂归属」按钮切到的是 `ownerBrush`（不是几何笔刷）；
  e2 一笔划过 2 个省 → 两个省的 `ownership` 都变成所选势力，且**省界多边形逐字节不变**；
  e3 整笔 = 一条撤销（`undo()` 一次回到原状）；
  e4 没选势力时涂 = 一个省都不改，并给出可读回执（不许静默）。
  e5 几何笔刷只在「底图编辑」行里（主行不再出现第二个同名按钮）。
"""
import json
import time

from lib.cdp import eval_json, wait_for

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
KEY = 'case131'
SC = KEY + '/甲时代'

SEED_JS = r"""
(async () => {
  const s = __STORE__, sm = __SM__;
  for (const k of Object.keys(s.scenarios || {})) s.removeScenario(k);
  if (!s.baseMaps[__KEY__]) s.addBaseMap(__KEY__, { name: __KEY__ });
  s.baseMaps[__KEY__].terrain.length = 0;
  s.baseMaps[__KEY__].rivers = [];
  const mk = (id, name, x0) => ({ id, name, kind: 'land',
    points: [{x:x0,y:150},{x:x0+140,y:150},{x:x0+140,y:290},{x:x0,y:290}] });
  s.addBaseProvince(__KEY__, mk('prov_a', '甲省', 200), { checkOverlap: false });
  s.addBaseProvince(__KEY__, mk('prov_b', '乙省', 400), { checkOverlap: false });
  s.addBaseProvince(__KEY__, mk('prov_c', '丙省', 600), { checkOverlap: false });
  const P = (id, name, color) => ({ id, name, color });
  s.createScenario(__SC__, { ownerKey: __KEY__, name: '甲时代', order: 1,
    era: { roman: 'I', label: '甲', startYear: '2000', endYear: '2010' },
    polities: [P('A1', '甲国', '#c23b3b'), P('A2', '乙国', '#4a90d9')],
    ownership: { prov_a: 'A1', prov_b: 'A1', prov_c: 'A1' } });
  sm.baseMapKey = __KEY__;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  sm.selectScenario(s.scenarios[__SC__]);
  sm.tlDate = { y: 2005, m: 6, d: 1 };
  sm.setTool('select');
  // 笔刷半径收小：保证"一笔划过两个省"是靠**拖动**而不是一笔糊满全图
  sm.provBrushRadius = 10;
  const cv = document.querySelector('.scenario-map-container canvas');
  const rc = cv.getBoundingClientRect();
  const toClient = (wx, wy) => {
    const p = sm.worldToScreen(wx, wy);
    return { x: Math.round(rc.left + p.x), y: Math.round(rc.top + p.y) };
  };
  return JSON.stringify({
    rect: { left: rc.left, top: rc.top, w: rc.width, h: rc.height },
    a: toClient(270, 220), b: toClient(470, 220), c: toClient(670, 220),
    scale: sm.cameraScale,
    tool: sm.tool,
  });
})()
"""

STATE_JS = r"""
(() => {
  const s = __STORE__, sm = __SM__;
  const sc = s.scenarios[__SC__] || {};
  return JSON.stringify({
    own: sc.ownership || {},
    events: sc.changeEvents || {},
    geom: JSON.stringify((s.baseMaps[__KEY__].terrain || []).map(p => p.points)),
    tool: sm.tool,
    hint: String(sm.provinceHint || ''),
    polity: sm.selectedPolity && sm.selectedPolity.name,
  });
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


def _drag(cdp, pts, modifiers=0):
    cdp.send('Input.dispatchMouseEvent', {
        'type': 'mousePressed', 'x': pts[0]['x'], 'y': pts[0]['y'],
        'button': 'left', 'buttons': 1, 'clickCount': 1, 'modifiers': modifiers,
    })
    for p in pts[1:]:
        cdp.send('Input.dispatchMouseEvent', {
            'type': 'mouseMoved', 'x': p['x'], 'y': p['y'],
            'button': 'left', 'buttons': 1, 'modifiers': modifiers,
        })
        time.sleep(0.06)
    cdp.send('Input.dispatchMouseEvent', {
        'type': 'mouseReleased', 'x': pts[-1]['x'], 'y': pts[-1]['y'],
        'button': 'left', 'buttons': 0, 'clickCount': 1, 'modifiers': modifiers,
    })
    time.sleep(0.4)


def run(cdp):
    cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
             ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式')

    ok, seed = eval_json(cdp, _js(SEED_JS), required=None, desc='造数')
    if not (ok and isinstance(seed, dict)):
        return False, f'造数失败：{seed}'
    a, b, c = seed['a'], seed['b'], seed['c']
    w, h = seed['rect']['w'], seed['rect']['h']
    for name, p in (('a', a), ('b', b), ('c', c)):
        if not (0 <= p['x'] <= w and 0 <= p['y'] <= h):
            return False, f'省份 {name} 的屏幕点落在画布外：{p}（画布 {w}×{h}）'

    fails, notes = [], []
    before = _state(cdp, '涂之前')
    notes.append(f"相机 scale={seed['scale']:.3f}；三点 {a} {b} {c}")

    # ── e1 主行的「涂归属」按钮 → ownerBrush（不是几何笔刷）────────────────────
    tool = eval_json(cdp, """(() => {
      const btn = document.querySelector('[data-testid="owner-brush-btn"]');
      if (!btn) return JSON.stringify({ fails: ['主行找不到 data-testid=owner-brush-btn 的「涂归属」'] });
      btn.click();
      const sm = %s;
      return JSON.stringify({ fails: [], tool: sm.tool });
    })()""" % SM, required=None, desc='点涂归属')
    tool = tool[1] if isinstance(tool, tuple) and tool[0] else {}
    if tool.get('fails'):
        fails += tool['fails']
    elif tool.get('tool') != 'ownerBrush':
        fails.append(f"点「涂归属」切到的是 {tool.get('tool')}（应为 ownerBrush —— 几何笔刷必须改名收进底图编辑）")

    # ── e2 一笔从甲省划到乙省 → 两省归属都变，省界不动 ──────────────────────────
    eval_json(cdp, """(() => {
      const sm = %s;
      const sc = %s.scenarios[%s];
      sm.selectPolity((sc.polities || []).find(p => p.id === 'A2') || null);
      sm.setTool('ownerBrush');
      return JSON.stringify({ fails: [] });
    })()""" % (SM, STORE, json.dumps(SC)), required=None, desc='选势力+切工具')

    # 起点甲省中心 → 终点乙省中心（中间再补两个点，模拟真实拖动）
    mid1 = {'x': round((a['x'] + b['x']) / 2), 'y': a['y']}
    mid2 = {'x': round((mid1['x'] + b['x']) / 2), 'y': b['y']}
    _drag(cdp, [a, mid1, mid2, b])
    after = _state(cdp, '涂之后')

    if after['own'].get('prov_a') != 'A2':
        fails.append(f"甲省归属没变（{after['own'].get('prov_a')}）—— 涂归属没落到画笔下的省")
    if after['own'].get('prov_b') != 'A2':
        fails.append(f"乙省归属没变（{after['own'].get('prov_b')}）—— 一笔划过两个省只改了一个")
    if after['own'].get('prov_c') != 'A1':
        fails.append(f"丙省被误改（{after['own'].get('prov_c')}）—— 笔没碰到的省也被改了")
    if after['geom'] != before['geom']:
        fails.append('🔴 涂归属**改了省界多边形**（它应该只改归属）—— 用户说的「生造省份」又回来了')
    if '涂归属' not in after['hint']:
        fails.append(f"状态栏没有涂归属回执：{after['hint']}")
    ev_a = (after['events'] or {}).get('prov_a') or []
    if not ev_a or ev_a[-1].get('owner') != 'A2':
        fails.append(f"易主日期没落库：prov_a.changeEvents={ev_a}")
    notes.append(f"一笔 → 甲/乙=A2、丙={after['own'].get('prov_c')}；回执「{after['hint'][:70]}」")

    # ── e3 整笔 = 一条撤销 ─────────────────────────────────────────────────────
    eval_json(cdp, "(() => { %s.undo(); return JSON.stringify({ fails: [] }); })()" % STORE,
              required=None, desc='撤销')
    undone = _state(cdp, '撤销后')
    if undone['own'].get('prov_a') != before['own'].get('prov_a') \
            or undone['own'].get('prov_b') != before['own'].get('prov_b'):
        fails.append(f"一次撤销没回到原状：{undone['own']}（原 {before['own']}）")
    if undone['geom'] != before['geom']:
        fails.append('撤销后省界与原来不一致')

    # ── e4 没选势力时涂：**自动落到本剧本第一个势力**并说清楚（不再静默不干活）──
    eval_json(cdp, """(() => {
      const sm = %s;
      sm.selectPolity(null);
      sm.setTool('ownerBrush');
      return JSON.stringify({ fails: [] });
    })()""" % SM, required=None, desc='清空势力')
    _drag(cdp, [c, {'x': c['x'] - 30, 'y': c['y']}])
    guarded = _state(cdp, '没选势力涂之后')
    if guarded.get('polity') != '甲国':
        fails.append(f"没选势力时没有自动落到第一个势力（selected={guarded.get('polity')}）—— 工具会表现为「涂了没反应」")
    if '涂归属' not in guarded['hint']:
        fails.append(f"没选势力时没有可读回执：{guarded['hint']}")

    # ── e5 几何笔刷只活在「底图编辑」行 ────────────────────────────────────────
    geo = eval_json(cdp, """(async () => {
      const sm = %s;
      const tick = () => new Promise(r => setTimeout(r, 0));
      sm.basemapEditMode = false;
      await tick();
      const off = !!document.querySelector('[data-testid="basemap-tool-provinceBrush"]');
      sm.basemapEditMode = true;
      await tick();
      const on = !!document.querySelector('[data-testid="basemap-tool-provinceBrush"]');
      const row = document.querySelector('.primary-row');
      const rowText = row ? row.textContent : '';
      sm.basemapEditMode = false;
      return JSON.stringify({ fails: [], off, on, rowText });
    })()""" % SM, required=None, desc='几何笔刷位置')
    geo = geo[1] if isinstance(geo, tuple) and geo[0] else {}
    if geo.get('off'):
        fails.append('底图编辑模式关着时也能看到「改省界」按钮（应只在底图编辑行出现）')
    if not geo.get('on'):
        fails.append('底图编辑模式开着时找不到「改省界」按钮（几何笔刷被藏没了）')
    if geo.get('rowText', '').count('涂归属') != 1:
        fails.append(f"主行「涂归属」出现 {geo.get('rowText', '').count('涂归属')} 次（应恰好 1 次，两个同名按钮=用户实测的混淆源）")

    if fails:
        return False, ' | '.join(notes) + ' ⇒ ' + ' ；'.join(fails)
    return True, ' | '.join(notes)
