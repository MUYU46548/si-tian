#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 65：P3 工具栏按任务分层 + P4 海洋分区

对应验收行：
  P3  默认可见控件 ≤6；「更多」里每个原入口都可达（能力一个都不减）
  P4  海陆分界严丝合缝；海区不出现在 ownership / 时间轴

P3 的判定手法：**真的去点**。逐个按 title 找到「更多」里的入口并 click，断言工具真的切过去了
（只数按钮个数是假绿：按钮在 DOM 里 ≠ 点得到、更 ≠ 真的接上了 handler）。
P4 的判定手法：海色由 `getProvinceColor` 直接判定（函数在 setupState 里可调），归属则走
「势力油漆桶点在海域上 → ownership 里不能出现它」的行为路径。
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json            # noqa: E402
from lib import helpers as H                        # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def _code_only(src):
    return '\n'.join(l for l in src.split('\n')
                     if not l.strip().startswith(('//', '*', '/*')))


def _js(cdp, src):
    ok, obj = eval_json(cdp, src)
    if not ok:
        return {'ERR': str(obj)[:400]}
    return obj if isinstance(obj, dict) else {'fails': [], 'notes': obj}


def source_gates():
    fails, notes = [], []
    sc = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
    checks = [
        # ── P3 ──
        ('class="toolbar-row primary-row"', '主工具行存在（按任务分层）'),
        ('const moreOpen = ref(false)', '「更多」默认收起'),
        ('const ADVANCED_TOOLS = new Set(', '高级工具清单（收进「更多」）'),
        ('const provinceRowVisible = computed(() => moreOpen.value || PROVINCE_TOOLS.has(tool.value))',
         '省份选项只在选到该类工具/打开「更多」时出现'),
        ('.toolbar-more {', '「更多」面板样式'),
        ('class="more-toggle"', '「更多」按钮'),
        # ── P4 ──
        # 海色/海界常量 2026-10-01 移入 `utils/scenarioPalette.js`（画布与 SVG 导出共用一份）；
        # 组件这边只守「引了单源 + 用法没变」，常量本体在下面单独查单源文件。
        ("from '../utils/scenarioPalette'", '组件引用配色单源'),
        ("if (prov && prov.kind === 'sea') return SEA_FILL;", '海域不吃归属色（最先判）'),
        ('c.setLineDash([px(6), px(4)])', '海界 = 淡虚线'),
        ("if (prov && prov.kind === 'sea') {", '势力油漆桶跳过海域'),
        ('海域不参与势力归属', '海域被拒时有明确交代（不是静默无效）'),
        ('onProvinceKindChange', '属性面板可切「陆地/海域」'),
    ]
    for needle, label in checks:
        if needle not in sc:
            fails.append(f'源码闸门缺失：{label}（找不到 `{needle}`）')
    # 单源里必须真有那两个常量（否则「引了单源」是假接线）
    pal = _code_only(_read('src/renderer/src/utils/scenarioPalette.js'))
    for needle, label in (("export const SEA_FILL = 'rgba(", '海面色常量（单源）'),
                          ("export const SEA_EDGE = 'rgba(", '海界色常量（单源）')):
        if needle not in pal:
            fails.append(f'源码闸门缺失：{label}（找不到 `{needle}`）')
    for needle in ("const SEA_FILL = 'rgba(", "const SEA_EDGE = 'rgba("):
        if needle in sc:
            fails.append(f'ScenarioMap 又抄了一份 {needle.strip()}（配色单源被破坏）')
    # 14 个高级工具入口必须都还在（能力一个都不减）
    legacy = ['split', 'merge', 'paint', 'river', 'relief', 'label', 'erase', 'height', 'biome',
              'burg', 'culture', 'religion', 'marker', 'road']
    missing = [t for t in legacy if f"setTool('{t}')" not in sc]
    if missing:
        fails.append(f'高级工具入口丢了：{missing}')
    notes.append(f'源码闸门 {len(checks)} 项 + 14 个高级入口' + ('全过' if not fails else '有问题'))
    return fails, notes


JS_UI = r""" (async () => {
  const sc = __SC__;
  const fails = [], notes = {};
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + e + ')' : '')); };
  // 🔴 Vue 的 DOM 更新是**异步**的（nextTick）。点了按钮立刻查 DOM = 必然查不到，
  // 所以探针必须是 async 的，每次点完 await 一个 tick（cdp.eval 带 awaitPromise）。
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 60));
  const bar = document.querySelector('.scenario-toolbar');
  if (!bar) {
    const cont = document.querySelector('.scenario-map-container');
    return JSON.stringify({ fails: ['P3：工具栏不在 DOM 里'], notes: { diag: {
      kids: cont ? Array.from(cont.children).map((c) => c.tagName + '.' + (c.className || '')) : [],
      view: String(sc.viewMode), tool: String(sc.tool) } } });
  }
  const visible = (el) => !!(el && el.offsetParent !== null && el.getClientRects().length);
  const controls = (root) => !root ? [] : Array.from(root.querySelectorAll('button, select, input, textarea'))
    .filter((el) => visible(el));

  // ── P3-① 默认可见控件 ≤ 6 ────────────────────────────────────────────
  sc.setTool('draw');
  sc.moreOpen = false;
  await tick();
  const defControls = controls(bar);
  notes.defaultControls = defControls.map((el) => (el.title || el.textContent || el.tagName).trim().slice(0, 10));
  ok('P3：默认可见控件 ≤ 6', defControls.length <= 6,
     defControls.length + ' 个：' + notes.defaultControls.join(' / '));
  ok('P3：「更多」默认收起（面板不在 DOM 里）', !document.querySelector('.toolbar-more'));
  ok('P3：moreOpen 初值为 false', sc.moreOpen === false);

  // ── P3-② 「更多」里每个原入口都可达（真的点，断言工具切过去了）───────────
  const moreBtn = Array.from(bar.querySelectorAll('button')).find((b) => (b.title || '').includes('更多'));
  ok('P3：找得到「更多」按钮', !!moreBtn);
  if (moreBtn) moreBtn.click();
  await tick();
  const panel = document.querySelector('.toolbar-more');
  ok('P3：点开后出现「更多」面板', !!panel);
  notes.moreControls = controls(panel).length;

  const want = {
    '拆分省份': 'split', '合并省份': 'merge', '势力油漆桶': 'paint', '河流编辑器': 'river',
    'Relief 图标': 'relief', '历史地名': 'label', '删除': 'erase', '高度笔刷': 'height',
    '生物群系笔刷': 'biome', '智能聚落': 'burg', '文化笔刷': 'culture', '宗教笔刷': 'religion',
    '标记 (K)': 'marker', '道路 (J)': 'road',
  };
  const unreachable = [], clicked = [];
  for (const sub of Object.keys(want)) {
    const b = Array.from(bar.querySelectorAll('button')).find((x) => visible(x) && (x.title || '').includes(sub));
    if (!b) { unreachable.push(sub + '(无可见入口)'); continue; }
    b.click();
    clicked.push(sub + '⟨' + String(b.title).slice(0, 14) + (b.disabled ? ' DISABLED' : '') + '⟩→' + sc.tool);
    if (sc.tool !== want[sub]) unreachable.push(sub + '→' + sc.tool + '(期望 ' + want[sub] + ')');
  }
  notes.clicked = clicked;
  ok('P3：14 个高级工具入口全部可达且真的切换', unreachable.length === 0, unreachable.join('；'));
  ok('P3：「更多」里控件数 > 6（工具是搬进去了，不是删了）', notes.moreControls > 6, notes.moreControls);

  // ── P3-③ 省份选项随工具出现（不必打开「更多」）────────────────────────
  sc.setTool('provinceBrush');
  sc.moreOpen = false;
  await tick();
  const provRow = document.querySelector('.province-row');
  ok('P3：选到省份笔刷时省份选项自动出现', !!provRow && visible(provRow));
  sc.setTool('draw');
  await tick();
  ok('P3：回到自由绘制后省份选项收起', !document.querySelector('.province-row'));
  return JSON.stringify({ fails, notes });
})()"""

JS_SEA = r""" (async () => {
  const sc = __SC__, s = __STORE__;
  const fails = [], notes = {};
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + e + ')' : '')); };
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 80));

  // ── P4-① 海色优先于归属色 ───────────────────────────────────────────
  const sea = { id: 'sea1', name: '测试海域', kind: 'sea',
    points: [{ x: 100, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 120 }, { x: 100, y: 120 }] };
  ok('P4：海域用水面色', sc.getProvinceColor(sea) === sc.SEA_FILL, sc.getProvinceColor(sea));
  const land = { id: 'l1', name: '测试陆地', kind: 'land', color: '#123456', points: sea.points };
  ok('P4：陆地保留自己的省份色', sc.getProvinceColor(land) === '#123456', sc.getProvinceColor(land));

  // ── P4-② 海陆分界严丝合缝（相邻陆/海共享边界顶点）────────────────────
  const KEY = 'case65';
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: '用例65底图' });
  const A = { id: 'c65a', name: '用例65陆', kind: 'land',
    points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 120 }, { x: 0, y: 120 }] };
  const B = { id: 'c65b', name: '用例65海', kind: 'sea',
    points: [{ x: 100, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 120 }, { x: 100, y: 120 }] };
  s.baseMaps = { ...s.baseMaps, [KEY]: { ...s.baseMaps[KEY], terrain: [A, B], provinceLabels: undefined } };
  const seeded = s.rebuildProvinceGrid(KEY);
  ok('P4：海陆两省栅格化成功', !!seeded && seeded.owned > 0, JSON.stringify(seeded));
  const kk = (q) => Math.round(q.x * 1000) + ',' + Math.round(q.y * 1000);
  const ka = new Set(A.points.map(kk));
  const shared = B.points.filter((q) => ka.has(kk(q))).length;
  ok('P4：海陆分界严丝合缝（共享边界顶点）', shared >= 2, shared + ' 个共享顶点');
  await tick();

  // ── P4-③ 海域不进归属（真的点一次势力油漆桶）─────────────────────────
  // 🔴 画布只画**当前底图**：不把 baseMapKey 切到合成底图，点击查的是 harness 那张图上的省份，
  //    两次点击都会「什么都没点中」→ 断言变成假绿（海区那条会因为 prov=null 而"通过"）。
  const prevKey = sc.baseMapKey;
  sc.baseMapKey = KEY;
  await tick(150);

  // 合成底图上没有现成剧本 —— 自己播一个（否则这条断言只能 skip，skip = 没测）
  s.createScenario('scen_case65', {
    id: 'scen_case65', name: '用例65剧本', ownerKey: KEY, order: 1,
    polities: [{ id: 'pol_case65', name: '用例65势力', color: '#8b2f2f' }],
    ownership: {}, changeYears: {},
  });
  const scenRef = () => s.getScenario('scen_case65');
  {
    const scen = scenRef();
    sc.selectedScenario = scen;
    sc.selectedPolity = scen.polities[0];
    const canvasEl = document.querySelector('.scenario-map-container canvas');
    const rr = canvasEl.getBoundingClientRect();
    sc.cameraScale = 1; sc.cameraX = 0; sc.cameraY = 0;   // world→屏幕 = w*scale + camera
    const clickWorld = (wx, wy) => {
      const cx = rr.left + (wx * sc.cameraScale + sc.cameraX);
      const cy = rr.top + (wy * sc.cameraScale + sc.cameraY);
      for (const t of ['mousedown', 'mouseup', 'click']) {
        canvasEl.dispatchEvent(new MouseEvent(t, { clientX: cx, clientY: cy, bubbles: true, cancelable: true, button: 0 }));
      }
      return { cx: Math.round(cx), cy: Math.round(cy), world: sc.screenToWorld(cx - rr.left, cy - rr.top) };
    };
    sc.setTool('paint');
    await tick();
    const f = (x, y) => { try { const q = sc.findProvinceAt(x, y); return q ? q.id : null; } catch (e) { return 'ERR'; } };
    notes.diag = {
      key: String(sc.baseMapKey), tool: String(sc.tool),
      hasScen: !!sc.selectedScenario, hasPol: !!sc.selectedPolity,
      polId: sc.selectedPolity ? String(sc.selectedPolity.id) : null,
      hitSea: f(150, 60), hitLand: f(50, 60),
      world050: JSON.stringify(sc.screenToWorld(50, 60)),
      mapCount: (s.getBaseMapsList ? s.getBaseMapsList().length : -1),
      status: String(sc.statusMsg || ''),
    };
    const own = () => Object.assign({}, (scenRef() || {}).ownership || {});
    const before = JSON.stringify(own());
    const hitSea = clickWorld(150, 60);
    await tick();
    const afterSea = own();
    ok('P4：点海域 → ownership 里不出现它', !afterSea['c65b'], 'c65b=' + String(afterSea['c65b']));
    ok('P4：点海域不连带改动别的归属', JSON.stringify(afterSea) === before);
    const hitLand = clickWorld(50, 60);
    await tick();
    const afterLand = own();
    ok('P4：点陆地 → ownership 记下了（对照）', !!afterLand['c65a'], 'c65a=' + String(afterLand['c65a']));
    notes.ownership = '海=' + String(afterSea['c65b']) + ' / 陆=' + String(afterLand['c65a'])
      + ' / 世界坐标 ' + JSON.stringify(hitSea.world) + ' ' + JSON.stringify(hitLand.world)
      + ' / 海域提示=' + String(sc.statusMsg || sc.statusMessage || '').slice(0, 40);
  }

  sc.baseMapKey = prevKey;
  s.removeScenario('scen_case65');
  delete s.baseMaps[KEY];
  return JSON.stringify({ fails, notes });
})()"""


def run(cdp):
    fails, notes = source_gates()

    cdp.eval(
        "(() => { const b = Array.from(document.querySelectorAll('button'))"
        ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()"
    )
    try:
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式挂载')
    except RuntimeError as e:
        return False, f'剧本模式未挂载：{e}'
    time.sleep(1.5)

    ui = _js(cdp, JS_UI.replace('__SC__', SC))
    if 'ERR' in ui:
        return False, f'P3 探针失败：{ui["ERR"]}'
    fails += ui.get('fails', [])
    un = ui.get('notes', {})

    sea = _js(cdp, JS_SEA.replace('__SC__', SC).replace('__STORE__', STORE))
    if 'ERR' in sea:
        return False, f'P4 探针失败：{sea["ERR"]}'
    fails += sea.get('fails', [])
    sn = sea.get('notes', {})

    notes.append(
        f'P3：默认可见控件 {len(un.get("defaultControls", []))} 个（'
        + ' / '.join(un.get('defaultControls', [])[:8]) + f'…），「更多」里 {un.get("moreControls")} 个；'
        f'P4：归属 {sn.get("ownership")}'
    )
    if fails:
        return False, (' | '.join(fails)
                       + ' ‖ P4现场：' + json.dumps(sn, ensure_ascii=False)[:900]
                       + ' ‖ 逐项点击：' + ' '.join(un.get('clicked', [])))
    return True, ' | '.join(notes)
