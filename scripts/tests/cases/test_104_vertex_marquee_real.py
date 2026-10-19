#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 104：顶点编辑的 Shift 框选 —— 用**真实鼠标输入**验（2026-10-14）

真实来由（暮雨实测）：
  0.3.0 交付时我在报告里承认过：「演练里"拖动"的选中集是**程序化设置**的（等价于 Shift+框选）；
  框选手势本身由 test_102 用真实鼠标事件守」—— 但 test_102 用的是
  `new MouseEvent(...)` **合成事件**，它比真实浏览器宽松（本项目已有前科：test_88 的右键菜单
  在合成 click 下"能打开"，真机上整片点不到）。
  本轮用户实测「我按 Shift 键似乎没什么作用」→ 必须用 CDP 的 `Input.dispatchMouseEvent`
  （浏览器**真实**输入管线：命中测试、指针捕获、事件顺序都走一遍）来验。

⚠️ 本用例**不做**"合成事件再验一遍"那种自证：判据只有真实输入这一条。
   若它红了，说明真机上手势确实不通 —— 那正是要抓的东西。
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for      # noqa: E402
from lib.helpers import ensure_case_state    # noqa: E402

SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"

# 一张只有 4 个顶点的小省（世界坐标），相机设成 1:1 → 屏幕坐标 = 世界 + 偏移
FIXTURE_JS = r""" (async () => {
  const s = __STORE__, sm = __SC__;
  const KEY = 'case104';
  // 🔴 必须**经 store** 建省（`addBaseProvince`），不能直接手搓 `s.baseMaps = {...}` ——
  //    后者只是把对象塞进去，省份编辑的内部缓存/选中解析看不到它，
  //    `currentProvince()` 会返回 undefined → 框选块整段被跳过 → 「框里没有顶点」。
  //    （本用例第一版就是这么假红的：提示语一字不差地指出来了。）
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: '用例104底图' });
  const bm = s.baseMaps[KEY];
  const cv = document.querySelector('.scenario-map-container canvas');
  if (!cv) return JSON.stringify({ ok: false, why: 'no-canvas' });
  if (!(bm.terrain || []).some((p) => p.id === 'p104')) {
    const r = s.addBaseProvince(KEY, {
      id: 'p104', name: '甲', kind: 'land', color: '#c8a06a',
      points: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }],
    }, { checkOverlap: false });
    if (r && r.success === false) return JSON.stringify({ ok: false, why: r });
  }
  sm.baseMapKey = KEY;
  sm.setTool('vertex');
  const prov = (s.baseMaps[KEY].terrain || []).find((p) => p.id === 'p104');
  sm.selectedProvince = prov || null;
  sm.activeRingIdx = 0;
  sm.snapToGridEnabled = false;
  sm.snapToEdgeEnabled = false;
  // ⚠️ 关掉「布局定稿后再适屏一次」（onMounted 里 250ms 的 settleFitTimer）——
  //    它会在用例拖到一半时把相机改掉，坐标准星当场漂移（本用例第一版就是这么假红的）。
  sm.initialFitPending = false;
  // 相机：把 (0,0)-(400,400) 的省摆进画布中央（留出边距，确保拖拽端点落在画布内 ——
  // 端点落到画布外时 `Input.dispatchMouseEvent` 派发的是**画布之外**的坐标，
  // 画布收不到任何事件，表现与"手势不通"一模一样：本用例第二版踩过）。
  // 先让 250ms 的适屏收尾跑完，**之后再设相机**（反过来的话会被适屏覆盖 ——
  // 本用例第三版实测：设完 1.13，读回来还是 1.383，端点被顶到画布外 → 画布收不到事件）。
  await new Promise(r => setTimeout(r, 400));
  const cw = cv.clientWidth, chh = cv.clientHeight;
  sm.cameraScale = Math.min(cw / 560, chh / 560);
  sm.cameraX = cw / 2 - 200 * sm.cameraScale;
  sm.cameraY = chh / 2 - 200 * sm.cameraScale;
  const rect = cv.getBoundingClientRect();
  const sx = (wx) => rect.left + wx * sm.cameraScale + sm.cameraX;
  const sy = (wy) => rect.top + wy * sm.cameraScale + sm.cameraY;
  const inside = (p) => p.x > rect.left && p.x < rect.right && p.y > rect.top && p.y < rect.bottom;
  const from = { x: Math.round(sx(-40)), y: Math.round(sy(440)) };
  const to = { x: Math.round(sx(440)), y: Math.round(sy(-40)) };
  return JSON.stringify({
    ok: inside(from) && inside(to),
    why: inside(from) && inside(to) ? '' : '拖拽端点落在画布外',
    tool: sm.tool,
    selected: sm.selectedProvince && sm.selectedProvince.id,
    pts: (s.baseMaps[KEY].terrain || []).find((p) => p.id === 'p104').points.length,
    cam: { x: Math.round(sm.cameraX), y: Math.round(sm.cameraY), scale: Math.round(sm.cameraScale * 1000) / 1000 },
    canvas: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
    from, to,
  });
})() """.replace('__STORE__', STORE).replace('__SC__', SC)


def run(cdp):
    ok, info = ensure_case_state(cdp)
    if not ok:
        return False, f'用例基线项目未就绪：{info}'

    cdp.eval(
        "(() => { const b = Array.from(document.querySelectorAll('button'))"
        ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()"
    )
    try:
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式挂载')
    except RuntimeError as e:
        return False, f'剧本模式未挂载：{e}'
    time.sleep(1.2)

    ok2, fx = eval_json(cdp, FIXTURE_JS, required=None, desc='铺 fixture')
    # ⚠️ `eval_json(..., required=None)` 返回 `(True, obj)` —— 这里第一版写成 `ok2[0]`
    #    直接假红（探针其实成功了）。
    if not ok2:
        return False, f'fixture 探针失败：{fx}'
    if not isinstance(fx, dict) or not fx.get('ok'):
        return False, f'fixture 未就绪：{fx}'

    ep = fx
    if ep.get('tool') != 'vertex':
        return False, f"工具没切到顶点编辑（tool={ep.get('tool')}）"
    if ep.get('selected') != 'p104':
        return False, f"没选中用例省份（selected={ep.get('selected')}）"

    a, b = ep['from'], ep['to']
    fails, notes = [], []
    notes.append(f"相机 {ep.get('cam')}；拖 ({a['x']},{a['y']}) → ({b['x']},{b['y']})")

    # ── 真实鼠标输入：按 Shift 拖一个框（CDP Input.dispatchMouseEvent）────────
    # modifiers=8 = Shift（见 CDP Input 文档：Alt=1 Ctrl=2 Meta=4 Shift=8）
    cdp.send('Input.dispatchMouseEvent', {
        'type': 'mousePressed', 'x': a['x'], 'y': a['y'], 'button': 'left',
        'buttons': 1, 'clickCount': 1, 'modifiers': 8,
    })
    # 分几步移动（真实拖动不是一个瞬移；也让"只在 mousemove 里更新"的实现能被覆盖）
    for i in range(1, 5):
        cdp.send('Input.dispatchMouseEvent', {
            'type': 'mouseMoved',
            'x': round(a['x'] + (b['x'] - a['x']) * i / 4),
            'y': round(a['y'] + (b['y'] - a['y']) * i / 4),
            'button': 'left', 'buttons': 1, 'modifiers': 8,
        })
        time.sleep(0.05)

    mid = eval_json(cdp, f"""(() => {{
      const sm = {SC};
      return JSON.stringify({{
        marquee: sm.vertexMarquee ? 1 : 0,
        hint: String(sm.provinceHint || ''),
      }});
    }})()""", required=None, desc='拖动中')
    mid = mid[1] if (isinstance(mid, tuple) and mid[0]) else {}

    cdp.send('Input.dispatchMouseEvent', {
        'type': 'mouseReleased', 'x': b['x'], 'y': b['y'], 'button': 'left',
        'buttons': 0, 'clickCount': 1, 'modifiers': 8,
    })
    time.sleep(0.35)

    res = eval_json(cdp, f"""(() => {{
      const sm = {SC};
      const cv = document.querySelector('.scenario-map-container canvas');
      const rect = cv ? cv.getBoundingClientRect() : null;
      return JSON.stringify({{
        selCount: (sm.vertexSelection || []).length,
        marqueeGone: !sm.vertexMarquee,
        hint: String(sm.provinceHint || ''),
        camX: sm.cameraX, camScale: sm.cameraScale,
        rect: rect ? {{ left: rect.left, top: rect.top }} : null,
      }});
    }})()""", required=None, desc='松手后')
    if not (isinstance(res, tuple) and res[0]):
        return False, f'结果探针失败：{res[1] if isinstance(res, tuple) else res}'
    res = res[1]
    notes.append(f"拖动中 marquee={'有' if mid.get('marquee') else '无'}；松手后选中 {res.get('selCount')} 个")
    notes.append(f"提示：「{str(res.get('hint'))[:60]}」")

    if not mid.get('marquee'):
        fails.append('🔴 按住 Shift 拖动时**没有**出现框选矩形（真实输入下手势不通）')
    if not res.get('marqueeGone'):
        fails.append('松手后框选矩形没清掉（残影）')
    if res.get('selCount', 0) != 4:
        fails.append(f"框住整省 4 个顶点，实际选中 {res.get('selCount')}（真机上 Shift 框选没生效）")
    if '框选到' not in str(res.get('hint', '')):
        fails.append(f"状态栏没有框选回执：{res.get('hint')}")

    # ── 反向探针：**不按** Shift 拖同一段 → 必须是平移、不许框选 ──────────────
    cam_before = res.get('camX')
    cdp.send('Input.dispatchMouseEvent', {
        'type': 'mousePressed', 'x': a['x'], 'y': a['y'], 'button': 'left',
        'buttons': 1, 'clickCount': 1, 'modifiers': 0,
    })
    cdp.send('Input.dispatchMouseEvent', {
        'type': 'mouseMoved', 'x': b['x'], 'y': b['y'], 'button': 'left', 'buttons': 1, 'modifiers': 0,
    })
    cdp.send('Input.dispatchMouseEvent', {
        'type': 'mouseReleased', 'x': b['x'], 'y': b['y'], 'button': 'left',
        'buttons': 0, 'clickCount': 1, 'modifiers': 0,
    })
    time.sleep(0.25)
    after = eval_json(cdp, f"""(() => {{
      const sm = {SC};
      return JSON.stringify({{ camX: sm.cameraX, selCount: (sm.vertexSelection || []).length }});
    }})()""", required=None, desc='无 Shift 拖动后')
    after = after[1] if (isinstance(after, tuple) and after[0]) else {}
    if after.get('camX') == cam_before:
        fails.append('🔴 不按 Shift 拖空白**没有平移**（相机没动）—— 旧手感被改坏了')
    # ⚠️ 普通拖动**不清空**选中集（只有"单击空白/别的省"才清）。判据写成"应当清空"会假红，
    #    实测就是——看清组件才知道：清空发生在 click 分支，不在拖动分支。
    if after.get('selCount') != 4:
        fails.append(f"不按 Shift 拖动不该动选中集（应仍为 4），实际 {after.get('selCount')}")

    # ── 收尾：清掉 fixture 底图与选中，别污染后续用例 ──────────────────────────
    cdp.eval(f"""(() => {{
      const s = {STORE}, sm = {SC};
      sm.vertexSelection = [];
      const next = {{ ...s.baseMaps }}; delete next['case104'];
      s.baseMaps = next;
      return 'ok';
    }})()""")

    return (len(fails) == 0), '；'.join(notes + fails)

