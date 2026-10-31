#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 97：描轮廓 —— 线跟着笔走、相邻省自动重算（E，2026-10-11）

用户原话（第 6 条）：「如何调整轮廓雏形？我没找到单独调整省份轮廓的地方，显然我不应该选择
拆分或合并，而是随心所欲描画轮廓，线跟着笔（鼠标）走，相邻省份自动重算更新轮廓。」

四条既有路都不满足它：
  · 顶点编辑：一次拖一个点，**只改被拖那一个省**（拖出去会与邻居压叠/留缝）
  · 省份笔刷：**粗带**扫过就划归（`traceBrushRings` 生成胶囊带，手要"刷"而不是"描"）
  · 套索：圈目标地**从未知省手里抢过来**（目标 = 用户在下拉里先选好的那个省）
  · 折线切割：把一个省切两半（是"分"，不是"改"）
描轮廓补的正是这一条：**区域 = 笔迹自己围出的那块**，目标省 = 区域里占比最高的那个，
被碰到的邻省自动按布尔重算。

本用例守四类判据：
  a 源码闸门（剥注释）：store 单源 + 组件只翻译结果 + 写口契约已登记；不许在组件里再写几何
  b 判定：单省时目标就是它；跨两省时判给"占区域比例最高"的那个（**不是**中心点法、
     也**不是**绝对面积法）；不写任何数据（判定是只读的）
  c 落库：笔迹围住的那块地从邻省改判给目标省 → 总面积**守恒**、只报被真正改到的省、
     一笔 = 一条 undo（undo/redo 双向）
  d 闸门与护栏：围太大 → `area-gate` + 零副作用；没围住省 → `no-target`；
     点太少 → 明确回执；**如实回报"有多少探到了邻省地盘"**
  e UI：工具按钮在「更多」里、点了真能切过去、按 Y 也能；主行仍是 6 个可见控件（不回归）
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for      # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def _code_only(src):
    out, in_block = [], False
    for line in src.split('\n'):
        s = line
        if in_block:
            if '*/' in s:
                s = s.split('*/', 1)[1]
                in_block = False
            else:
                continue
        while '/*' in s:
            before, after = s.split('/*', 1)
            if '*/' in after:
                s = before + after.split('*/', 1)[1]
            else:
                s = before
                in_block = True
                break
        if '//' in s:
            s = s.split('//', 1)[0]
        out.append(s)
    return '\n'.join(out)


def source_gates():
    fails, notes = [], []
    pe = _code_only(_read('src/renderer/src/store/geodataModules/provinceEditing.js'))
    sc = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
    # 2026-10-31：绘制/交互体已分批搬到 scenario/{layers,interaction}/* —— 判据读合集，不再绑文件位置
    from lib.rsrc import render_src_code_only as _rsrc_all
    sc = _rsrc_all()
    wg = _code_only(_read('src/renderer/src/store/writeGate.js'))

    for src, needle, label in [
        (pe, 'function resolveOutlineRegion(', 'store：区域与目标的判定（单源）'),
        (pe, 'function applyProvinceOutline(', 'store：描轮廓落库入口'),
        (pe, 'OUTLINE_AREA_SHARE_DEFAULT', 'store：面积闸门常量'),
        (pe, "type: 'province-outline'", 'store：一整笔 = 一条 undo'),
        (sc, 'store.applyProvinceOutline(', '组件：调用 store 的落库入口'),
        (sc, 'function commitOutlineTrace(', '组件：描轮廓收口'),
        (sc, "data-testid=\"province-outline-btn\"", '组件：工具栏入口'),
        (wg, "'applyProvinceOutline'", '写口契约：描轮廓已登记（只读态必须被拦）'),
    ]:
        if needle not in src:
            fails.append(f'源码闸门缺失：{label}（找不到 `{needle}`）')

    # 🔴 红线：几何判定不许在组件里再写一套（双源必然漂移）
    for bad in ('resolveOutlineRegion(', 'polygonClipping.'):
        # 允许出现 `store.resolveOutlineRegion(`（那正是"调用 store"），不允许裸用
        if bad == 'resolveOutlineRegion(':
            if 'resolveOutlineRegion(' in sc.replace('store.resolveOutlineRegion(', ''):
                fails.append('🔴 组件里出现裸的 resolveOutlineRegion（判定必须留在 store 单源）')
        elif bad in sc:
            fails.append(f'🔴 组件里直接用了布尔引擎（{bad}）—— 几何只能来自 store / 纯函数层')

    notes.append('源码闸门 8 项 + 2 条红线' + ('全过' if not fails else f'缺 {len(fails)}'))
    return fails, notes


JS = r""" (async () => {
  const s = __STORE__, sc = __SC__;
  const fails = [], notes = {};
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + e + ')' : '')); };
  const P = window.__provShape;
  window.confirm = () => true;
  const KEY = 'case97';
  const area = (p) => P.provinceNetArea(p);
  const totalArea = () => (s.baseMaps[KEY].terrain || []).reduce((n, p) => n + area(p), 0);

  // 底图：两个相邻矩形（各 20000 面积）
  //   A = [0,0]-[200,100]      B = [200,0]-[400,100]
  const A = { id: 'p97a', name: '甲省', kind: 'land',
    points: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }] };
  const B = { id: 'p97b', name: '乙省', kind: 'land',
    points: [{ x: 200, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 100 }, { x: 200, y: 100 }] };
  s.baseMaps = { ...s.baseMaps, [KEY]: { id: KEY, name: '用例97底图', terrain: [A, B], referenceImages: [] } };
  sc.baseMapKey = KEY;
  sc.moreOpen = true;
  await new Promise((r) => setTimeout(r, 80));
  const base = totalArea();
  ok('构造：两省各 20000，合计 40000', Math.abs(base - 40000) < 1, base);

  // ══ b) 判定（只读）════════════════════════════════════════════════════════
  // 🔴 关键设计（2026-10-11 实测纠偏）：围住的那块地本来就在**原主**手里，所以
  //    "区域里占比最高的省"**永远**是原主 —— 而用户描边界想要的是**改判给邻省**。
  //    默认取向必须是"判给贴着描的邻省"，否则这一笔必然只有 union、没有 difference（纹丝不动）。
  {
    // 单省：笔迹围着 A 的内部一圈（每边内缩 20）—— 没碰到任何邻省
    const insideA = [{ x: 20, y: 20 }, { x: 180, y: 20 }, { x: 180, y: 80 }, { x: 20, y: 80 }, { x: 20, y: 20 }];
    const r = s.resolveOutlineRegion(KEY, insideA);
    ok('b1 单省：原主是围住的那个省', !!(r && r.ownerIdx === 1), JSON.stringify(r && { o: r.ownerIdx, rej: r.rejected }));
    ok('b1 没碰到邻省 → 仍归原主（并如实标出未换主）',
       !!(r && r.targetIdx === 1 && r.switched === false && !r.neighborIdx),
       JSON.stringify(r && { t: r.targetIdx, sw: r.switched, nb: r.neighborIdx }));
    ok('b1 判定是只读的（几何一字未动）', Math.abs(totalArea() - base) < 1);
    ok('b1 区域面积正确（160×60 = 9600）', !!(r && Math.abs(r.area - 9600) < 60), r && r.area);

    // 🔴 贴着 A/B 中缝描一小块 A 的地（笔迹点压到 B 里面）→ 默认应改判给 B
    const alongBorder = [
      { x: 180, y: 20 }, { x: 205, y: 20 }, { x: 205, y: 60 },
      { x: 180, y: 60 }, { x: 205, y: 40 }, { x: 180, y: 20 },
    ];
    const r2 = s.resolveOutlineRegion(KEY, alongBorder);
    ok('b2 🔴 贴着边界描 → 默认改判给邻省（不是原主）',
       !!(r2 && r2.switched === true && r2.targetIdx === 2 && r2.ownerIdx === 1),
       JSON.stringify(r2 && { o: r2.ownerIdx, t: r2.targetIdx, sw: r2.switched, nb: r2.neighborIdx, hits: r2.neighborHits }));

    // 同一个笔迹、显式关掉"改判给邻省" → 归原主
    const r2b = s.resolveOutlineRegion(KEY, alongBorder, { toNeighbor: false });
    ok('b2 关掉改判 → 归原主（去修形状而不是换主）',
       !!(r2b && r2b.targetIdx === 1 && r2b.switched === false), JSON.stringify(r2b && { t: r2b.targetIdx }));

    // 显式指定目标省时以调用方为准
    const r2c = s.resolveOutlineRegion(KEY, alongBorder, { targetIdx: 2 });
    ok('b2 显式 targetIdx 优先', !!(r2c && r2c.targetIdx === 2), JSON.stringify(r2c && { t: r2c.targetIdx }));

    // 🔴 原主判定必须"按占比"，不是"按绝对面积被覆盖" —— 用一个极大但只擦到一角的省来验
    const KEY2 = 'case97big';
    const big = { id: 'p97big', name: '大省', kind: 'land',
      points: [{ x: -2000, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: -2000, y: 100 }] };
    const small = { id: 'p97small', name: '小省', kind: 'land',
      points: [{ x: 200, y: 0 }, { x: 260, y: 0 }, { x: 260, y: 30 }, { x: 200, y: 30 }] };
    s.baseMaps = { ...s.baseMaps, [KEY2]: { id: KEY2, name: '用例97大底图', terrain: [big, small], referenceImages: [] } };
    // 区域：x 190..250 / y 5..25 —— 落在小省里的比例远高于落在大省里
    const region = [{ x: 190, y: 5 }, { x: 250, y: 5 }, { x: 250, y: 25 }, { x: 190, y: 25 }, { x: 190, y: 5 }];
    const r3 = s.resolveOutlineRegion(KEY2, region);
    ok('b3 🔴 原主按"区域里有多大比例属于它"（大省只沾一角 → 原主是小省）',
       !!(r3 && r3.ownerIdx === 2), JSON.stringify(r3 && { o: r3.ownerIdx, cov: r3.coveredRatio }));
    delete s.baseMaps[KEY2];
  }

  // ══ c) 落库：围住的那块地改判 + 邻省自动重算 + 面积守恒 ═════════════════
  {
    // 用户"描"的是甲省的地盘：把甲右上一块（x 140..200 / y 0..50）划给乙。
    // ⚠️ 笔迹要**压在省界上/压进乙一侧**（真实手感就是"贴着边界描"）：
    //    首版把笔迹画在 x=200 那道缝外的空处，于是"贴着谁描"一个点都数不到 →
    //    回落到原主 → 只有 union、纹丝不动（test_97 c 段当场抓到）。
    const trace = [
      { x: 140, y: 0 }, { x: 203, y: 0 }, { x: 203, y: 50 },
      { x: 140, y: 50 }, { x: 203, y: 25 }, { x: 140, y: 0 },
    ];
    const r = s.applyProvinceOutline(KEY, trace);
    ok('c1 落库成功', !!(r && r.changed > 0), JSON.stringify(r && { ch: r.changed, rej: r.rejected, msg: r.message }));
    // 🔴 这一笔是"贴着原主边界描、把那块地划给邻省" → 目标应当是**邻省**（甲 → 乙）。
    //    先量出来真实数字（原主/目标/面积/探出量），再让断言说话 ——
    //    首版 c1 与 c2 都过、c3 全错，正是因为目标选成了原主，光看 changed 完全看不出来。
    ok('c1 🔴 目标判给了邻省（甲 → 乙）', !!(r && r.targetIdx === 2 && r.ownerIdx === 1 && r.switched === true),
       JSON.stringify(r && { o: r.ownerIdx, t: r.targetIdx, sw: r.switched, cov: r.coveredRatio, area: r.area, out: r.outside }));
    ok('c1 报了被改到的省（union + difference 分开列）',
       !!(r && r.ops && r.ops.some((o) => o.op === 'union') && r.ops.some((o) => o.op === 'difference')),
       JSON.stringify(r && r.ops));
    ok('c2 🔴 总面积守恒（3600 那块只是改判，不是凭空增减）',
       Math.abs(totalArea() - base) < 2, Math.round(totalArea()) + ' vs ' + Math.round(base));
    const T = () => s.baseMaps[KEY].terrain;
    const aNow = T().find((p) => p.id === 'p97a');
    const bNow = T().find((p) => p.id === 'p97b');
    // 🔴 **划分语义**（transfer = 区域 − 乙原有地）：
    //    笔迹压在边界上、右侧探进乙，于是"转移量"= 区域 ∩ 甲（甲被挖掉的那块）。
    //    实测：转移 1429 → 甲 20000−1429=18571、乙 20000+1429=21429，二者严格互补。
    const moved = Math.round(r.transferArea || 0);
    ok('c3 转移量 > 0 且不超过围住面积', moved > 0 && moved <= Math.round(r.area) + 1,
       JSON.stringify({ moved, area: Math.round(r.area) }));
    ok('c3 目标省（乙）净得 = 转移量', Math.abs(area(bNow) - (20000 + moved)) < 2,
       Math.round(area(bNow)) + ' 期望 ' + (20000 + moved));
    ok('c3 邻省（甲）净失 = 转移量（逐字节互补）', Math.abs(area(aNow) - (20000 - moved)) < 2,
       Math.round(area(aNow)) + ' 期望 ' + (20000 - moved));
    ok('c3 🔴 面积精确守恒（划分，不是叠加）',
       Math.abs((area(aNow) + area(bNow)) - base) < 1,
       Math.round(area(aNow) + area(bNow)) + ' vs ' + Math.round(base));
    // 🔴 划分语义的**排他性**：转移的那块地上不允许再有别省压着（首版"先并后挖"会重叠）
    ok('c3 🔴 无新增压叠（这块地上只有目标省）', !(r.preOverlap > 1),
       JSON.stringify({ preOverlap: r.preOverlap }));
    ok('c4 如实回报转移量与"原有压叠"（贴边界描时应为 0）',
       !!(r && Number.isFinite(r.transferArea) && Number.isFinite(r.preOverlap)),
       JSON.stringify({ moved: r && r.transferArea, pre: r && r.preOverlap }));
    ok('c4 海岸线没被动（两省 bbox 右边界仍是 400）',
       Math.abs(P.provinceBBox(bNow).maxX - 400) < 1, P.provinceBBox(bNow).maxX);

    s.undo();
    ok('c5 一条 undo 还原（几何逐点回滚）',
       Math.abs(totalArea() - base) < 1 && area(T().find((p) => p.id === 'p97a')) === 20000,
       Math.round(area(T().find((p) => p.id === 'p97a'))));
    s.redo();
    ok('c5 redo 再改回来', area(T().find((p) => p.id === 'p97b')) > 20000, Math.round(area(T().find((p) => p.id === 'p97b'))));
    s.undo();
    notes.outline = '面积守恒 ' + Math.round(totalArea()) + '（原 ' + Math.round(base) + '）';
  }

  // ══ d) 闸门与护栏（拒绝 = 零副作用）═════════════════════════════════════
  {
    const before = JSON.stringify(s.baseMaps[KEY].terrain.map((p) => p.points));
    const big = s.applyProvinceOutline(KEY, [
      { x: -100000, y: -100000 }, { x: 100000, y: -100000 },
      { x: 100000, y: 100000 }, { x: -100000, y: 100000 }, { x: -100000, y: -100000 },
    ]);
    ok('d1 围太大 → area-gate 且给占比', !!(big && big.rejected === 'area-gate' && big.share > 0),
       JSON.stringify(big && { rej: big.rejected, share: big.share }));
    ok('d1 拒绝时零副作用', JSON.stringify(s.baseMaps[KEY].terrain.map((p) => p.points)) === before);
    ok('d1 拒绝文案给去处（提示贴着边界描）', /描|边界/.test((big && big.message) || ''), (big && big.message || '').slice(0, 40));

    const thr = s.applyProvinceOutline(KEY, [
      { x: 10, y: 10 }, { x: 190, y: 10 }, { x: 190, y: 90 }, { x: 10, y: 90 }, { x: 10, y: 10 },
    ], { maxShare: 0.0001 });
    ok('d1 面积阈值可注入且生效', !!(thr && thr.rejected === 'area-gate'), JSON.stringify(thr && thr.rejected));

    const outside = s.applyProvinceOutline(KEY, [
      { x: 900, y: 900 }, { x: 950, y: 900 }, { x: 950, y: 950 }, { x: 900, y: 950 }, { x: 900, y: 900 },
    ]);
    ok('d2 没围住任何省 → no-target（不是静默无反应）',
       !!(outside && outside.rejected === 'no-target'), JSON.stringify(outside));
    const few = s.applyProvinceOutline(KEY, [{ x: 10, y: 10 }, { x: 20, y: 20 }]);
    ok('d2 点太少 → 明确回执', !!(few && few.changed === 0 && few.message), JSON.stringify(few));
    ok('d2 以上拒绝之后几何仍未动', JSON.stringify(s.baseMaps[KEY].terrain.map((p) => p.points)) === before);
  }

  // ══ e) UI ═══════════════════════════════════════════════════════════════
  {
    const bar = document.querySelector('.scenario-toolbar');
    const visible = (el) => !!(el && el.offsetParent !== null && el.getClientRects().length);
    sc.moreOpen = true;
    await new Promise((r) => setTimeout(r, 80));
    const btn = bar.querySelector('[data-testid="province-outline-btn"]');
    ok('e1 「更多」里有「描轮廓」按钮', !!btn, '按钮不在');
    if (btn) {
      btn.click();
      await new Promise((r) => setTimeout(r, 60));
      ok('e1 点了真能切到该工具', sc.tool === 'outline', String(sc.tool));
      ok('e1 状态栏给出用法提示（描一圈 / 邻省自动重算）',
         !!document.querySelector('[data-testid="outline-hint"]'));
    }
    // 快捷键 Y
    sc.setTool('select');
    await new Promise((r) => setTimeout(r, 40));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    ok('e1 快捷键 Y 切到描轮廓', sc.tool === 'outline', String(sc.tool));
    // 🔴 2026-10-25：Ctrl/⌘+字母是系统组合键（复制/粘贴），不能当工具快捷键。
    //    用户实测事故：选中状态栏文字按 Ctrl+C 复制 → 工具被静默切成「文化笔刷」。
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 60));
    ok('e1b Ctrl+C 不切工具（复制文字不该召唤笔刷）', sc.tool === 'outline', String(sc.tool));
    // 主行可见控件数（P3 纪律，test_65 同口径）
    // 🔴 2026-10-20：底图编辑模式落地后，日常行 = 4（返回/选择/涂归属/更多），
    //    开模式 = 6（+画省份 +改形状）。旧断言写死 6 是模式化之前的数字（自 10-18 起已红）。
    const primary = Array.from(bar.querySelectorAll('.primary-row button')).filter(visible);
    ok('e2 日常行仍是 4 个可见控件（新工具进「更多」）',
       primary.length === 4, primary.length + ' 个：' + primary.map((b) => (b.textContent || '').trim()).join('/'));
    sc.basemapEditMode = true;
    await new Promise((r) => setTimeout(r, 80));
    const primaryOn = Array.from(bar.querySelectorAll('.primary-row button')).filter(visible);
    ok('e2b 开底图编辑 = 6 个（画省份/改形状只在模式内）',
       primaryOn.length === 6, primaryOn.length + ' 个：' + primaryOn.map((b) => (b.textContent || '').trim()).join('/'));
    sc.basemapEditMode = false;
    await new Promise((r) => setTimeout(r, 60));
    sc.setTool('select');
  }

  delete s.baseMaps[KEY];
  sc.baseMapKey = Object.keys(s.baseMaps)[0] || '';
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

    prep = eval_json(cdp, """(async () => {
      const P = await import('/src/utils/provinceShape.js');
      window.__provShape = P;
      return JSON.stringify({ fails: [] });
    })()""", desc='provinceShape 加载')
    if not prep[0]:
        return False, f'provinceShape 模块加载失败：{prep[1]}'

    ok, res = eval_json(cdp, JS.replace('__STORE__', STORE).replace('__SC__', SC), desc='97 主探针')
    if not ok:
        return False, res
    fails += res.get('fails', [])
    n = res.get('notes', {})
    if n.get('outline'):
        notes.append(n['outline'])
    return (not fails), ' | '.join(fails) if fails else ' | '.join(notes)
