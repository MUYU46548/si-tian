#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 73：A8 —— 历史剧本「势力标注」（自定义势力名 + EU4 式分级）

背景（暮雨 2026-09-26 定案）：
  · A5「政治」不再是「编辑 azgaarProvinces 顶点」，而是**手动标记的势力（Tag）名称**；
  · 历史剧本要能**自定义显示的势力名称**，并照 EU4 的做法分级 ——
    放大看省名、缩小只看势力名（**可简称**），**全名只在点开省份详情时给**。

覆盖：
  f0 源码守卫：分级判定的**唯一实现**在 `utils/polityLabels.js`，组件里不许再写一套阈值；
     `drawPolityLabels` 必须被主渲染路径与导出路径**都**调用（少一处 = 导出的图和画布不一样，
     M2/A2 已经因为这个栽过一次，而且**不报错**）
  f1 分级：三档随「视口可见宽度 ÷ 地图宽度」切换，且与缩放**单调**（看得越远 → 名字越简）
  f2 真的画出来了：劫持 `fillText` 记录实际绘制的文本 ——
     放大档有**省名**且**没有**势力名；中档有势力**全名**且没有省名；缩小档是**简称**
  f3 改名落库：`updatePolity` 走 undo（撤销还原、重做再改）；无实质改动不入栈；空名不写
  f4 UI + 详情：勾选框存在；选中势力出现「名称/简称」编辑；受控输入改名生效；
     **真实点击省份** → 状态栏显示该省所属势力的**全名**

为什么要「互为反面」地断言：
  「放大档画省名」与「中档画势力名」必须成对断言 —— 只测一边的话，
  「档位根本没接上、永远只画一种」这种实现能同时骗过两条单边断言。
"""
import sys, os, io, json, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib import helpers as H  # noqa: E402
from lib.cdp import wait_for, eval_json  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
PM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"

BASEMAP = '用例73势力标注底图'
SCID = BASEMAP + '/甲午'
PROVS = [('a8p1', '青原省', 120), ('a8p2', '赤谷省', 360), ('a8p3', '白川县', 600)]
POLA, POLB = 'a8_polA', 'a8_polB'


# ══════════════════════════════════════════════════════════════════
# f0 源码守卫
# ══════════════════════════════════════════════════════════════════
def _read(rel):
    return io.open(os.path.join(ROOT, rel), encoding='utf-8').read()


def _code_only(src):
    """剥掉 `//` 行注释与 `/* */` 块注释 —— 修完 bug 后注释里天然会写「此前如何如何」，
    纯子串判据会把注释当违规（test_71 首版就吃过这个假红）。"""
    out, i, n = [], 0, len(src)
    in_block = False
    while i < n:
        c = src[i]
        if in_block:
            if c == '*' and i + 1 < n and src[i + 1] == '/':
                in_block = False
                i += 2
                continue
            out.append('\n' if c == '\n' else ' ')
            i += 1
            continue
        if c == '/' and i + 1 < n and src[i + 1] == '*':
            in_block = True
            i += 2
            continue
        if c == '/' and i + 1 < n and src[i + 1] == '/':
            while i < n and src[i] != '\n':
                i += 1
            continue
        out.append(c)
        i += 1
    return ''.join(out)


def _function_body(src, fn):
    """按括号配对截取函数体（跳过字符串与行注释）—— 照 test_54 的写法。
    判据必须落在**函数体**上：只判「文件里出现过某符号」的话，
    真正违规的那个函数会被同文件别处的合法调用掩盖（test_54 记过的漏报型假绿）。"""
    import re as _re
    m = _re.search(r'\n[ \t]*(?:export\s+)?(?:async\s+)?function\s+' + _re.escape(fn) + r'\s*\(', src)
    if not m:
        return None
    i = src.find('{', m.end() - 1)
    if i < 0:
        return None
    depth, j, instr, incomment = 0, i, None, False
    while j < len(src):
        c = src[j]
        if incomment:
            if c == '\n':
                incomment = False
        elif instr:
            if c == '\\':
                j += 2
                continue
            if c == instr:
                instr = None
        else:
            if c in ('"', "'", '`'):
                instr = c
            elif c == '/' and j + 1 < len(src) and src[j + 1] == '/':
                incomment = True
            elif c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    return src[i + 1:j]
        j += 1
    return None


def sub_source_guards(cdp):
    import re as _re
    sm = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
    util = _code_only(_read('src/renderer/src/utils/polityLabels.js'))
    bad = []

    # ① 分级判定只有一份实现
    for sym in ['polityLabelTier', 'aggregateTerritories', 'labelTextFor', 'labelFitsOnScreen']:
        if sym not in util:
            bad.append(f'polityLabels.js 缺少 {sym}')
    if "from '../utils/polityLabels'" not in sm:
        bad.append('ScenarioMap 没有引用 utils/polityLabels（分级判定被写回了组件？）')
    # 组件里不许再写一套阈值（「两套判定」唯一可判据的形态）
    if '0.35' in sm:
        bad.append('ScenarioMap 里出现了省名档阈值字面量 0.35（判定应只在 polityLabels.js）')
    if _re.search(r'visibleRatio\s*[<>]=?\s*[0-9]', sm):
        bad.append('ScenarioMap 里出现了对 visibleRatio 的裸阈值比较（应调用 polityLabelTier）')

    # ② 渲染入口**两处**都要接（主渲染 + 导出）—— 少一处导出图就与画布不一致
    calls = len(_re.findall(r'drawPolityLabels\(', sm))
    if calls < 3:      # 1 处定义 + 2 处调用
        bad.append(f'drawPolityLabels 只有 {calls} 处出现（应为 1 定义 + 主渲染 + 导出 ≥3）')

    # ③ 组件里不许自己实现「档位 → 文本」（必须在纯函数里）
    if _re.search(r"(?:tier|polityLabelTierNow)\s*===\s*'abbr'", sm):
        bad.append("ScenarioMap 自己写了档位→文本的分支（应调用 labelTextFor）")
    # 🔴 2026-10-01：标签判定抽到 `utils/scenarioLabels.js`（画布 + PNG + **SVG 导出**三处共用）。
    #   判据随之升级 —— 不再是「组件函数体里出现了这两个调用」，而是
    #   ① 单源模块里真有 文本选择 / 领土聚合；② 画布与**导出链**都调 collectScenarioLabels。
    labels_mod = _code_only(_read('src/renderer/src/utils/scenarioLabels.js'))
    export_mod = _code_only(_read('src/renderer/src/composables/useScenarioExport.js'))
    for sym in ['labelTextFor(', 'aggregateTerritories(', 'ringAreaCentroid(']:
        if sym not in labels_mod:
            bad.append(f'utils/scenarioLabels.js 缺少 {sym}（标签判定单源不完整）')
    body = _function_body(sm, 'drawPolityLabels')
    if body is None:
        bad.append('ScenarioMap 找不到 drawPolityLabels()（渲染函数改名后守卫要同步）')
    else:
        if 'collectScenarioLabels(' not in body:
            bad.append('drawPolityLabels 没走 collectScenarioLabels（画布又自己算了一套标签）')
        if 'drawStyledLabel(' not in body:
            bad.append('drawPolityLabels 没有走统一文本渲染入口 drawStyledLabel')
    if 'collectScenarioLabels(' not in export_mod:
        bad.append('导出链没接 collectScenarioLabels（导出的图会没有势力名 —— A8 的主要读物）')
    if "from '../utils/scenarioLabels'" not in sm:
        bad.append('ScenarioMap 没有引用 utils/scenarioLabels（判定被写回了组件？）')

    return (False, '；'.join(bad)) if bad else (True, '分级判定单源（含导出链共 3 处接线）/ 无阈值回流组件')


# ══════════════════════════════════════════════════════════════════
# f1~f4 端到端
# ══════════════════════════════════════════════════════════════════
JS = r"""(async () => {
  const fails = [], notes = [];
  const ck = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' → ' + JSON.stringify(e) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 120));

  const store = PLACEHOLDER_STORE;
  const pm = PLACEHOLDER_PM;
  if (!pm) { fails.push('ScenarioMap 未挂载'); return JSON.stringify({ fails, notes }); }

  const BM = JSON.parse(JSON.stringify(__BASEMAP__));
  const SCID = __SCID__;
  const PROVS = JSON.parse(JSON.stringify(__PROVS__));
  const POLA = __POLA__, POLB = __POLB__;

  const rect = (x, y, w, h) => [{ x: x, y: y }, { x: x + w, y: y }, { x: x + w, y: y + h }, { x: x, y: y + h }];

  // ── 装置：三块正方形省份 + 一个含两个势力的剧本 ─────────────────────────
  const SIZE = 200;
  const pids = [];
  for (const [id, name, x] of PROVS) {
    store.addBaseProvince(BM, { id: id, name: name, kind: 'land', points: rect(x, 120, SIZE, SIZE) });
    pids.push(id);
  }
  store.createScenario(SCID, {
    ownerKey: BM, name: '甲午', order: 1,
    era: { roman: 'I', label: '甲午', startYear: 1000, endYear: 1100 },
    polities: [
      { id: POLA, name: '甲午王朝', abbr: '甲午', color: '#c0392b' },
      { id: POLB, name: '乙卯王朝', abbr: '乙卯', color: '#2e86c1' },
    ],
    ownership: { a8p1: POLA, a8p2: POLA, a8p3: POLB },
  });
  await tick(200);

  const bm = store.baseMaps[BM];
  ck('装置：底图有 3 个省份', !!(bm && bm.terrain && bm.terrain.length === 3), bm && bm.terrain && bm.terrain.length);
  const sc = store.scenarios[SCID];
  ck('装置：剧本有两个势力 + 归属', !!(sc && sc.polities.length === 2 && Object.keys(sc.ownership).length === 3), null);

  pm.viewMode = 'scenario';
  pm.selectScenario(sc);
  await tick(120);

  // ── 档位 + 相机标定（ratio = 视口可见世界宽度 ÷ 地图世界宽度）──────────
  const setTier = (ratio, cx, cy) => {
    const size = pm.mapWorldSize();
    const cv = pm.canvas;
    if (!size.w || !cv) return 0;
    const s = (cv.width / ratio) / size.w;
    pm.cameraScale = s;
    pm.cameraX = cv.width / 2 - cx * s;
    pm.cameraY = cv.height / 2 - cy * s;
    pm.render();
    return pm.polityLabelTierNow;
  };

  const record = (fn) => {
    const proto = CanvasRenderingContext2D.prototype;
    const orig = proto.fillText;
    const seen = [];
    proto.fillText = function (t, x, y, m) { seen.push(String(t)); return orig.call(this, t, x, y, m); };
    try { fn(); } finally { proto.fillText = orig; }
    return seen;
  };
  const has = (arr, s) => arr.some((t) => t.indexOf(s) >= 0);
  // ⚠️ 断言「画的是简称」必须用**精确相等**：简称是全名的子串（甲午 ⊂ 甲午王朝），
  //    用 indexOf 的话「根本没走简称」也能通过（探针实测：只抓到一半）。
  const hasExact = (arr, s) => arr.some((t) => t === s);

  // ── f1 档位三档 + 单调 ──────────────────────────────────────────────
  const tProv = setTier(0.2, 220, 220);
  const tPol = setTier(0.8, 460, 220);
  const tAbbr = setTier(2.5, 440, 220);
  ck('f1 放大（ratio 0.2）→ 省名档', tProv === 'province', tProv);
  ck('f1 中档（ratio 0.8）→ 势力名档', tPol === 'polity', tPol);
  ck('f1 缩小（ratio 2.5）→ 简称档', tAbbr === 'abbr', tAbbr);
  // 单调：比例变大时档位只许变简
  const ORD = { province: 0, polity: 1, abbr: 2 };
  let prev = -1, mono = true;
  for (const r of [0.1, 0.2, 0.35, 0.5, 0.8, 1.2, 1.5, 2.5, 6]) {
    const o = ORD[setTier(r, 440, 220)];
    if (o < prev) mono = false;
    prev = o;
  }
  ck('f1 ★ 单调：看得越远 ↔ 名字越简，绝不反向', mono, null);

  // ── f2 真的画出来了（互为反面的两档）────────────────────────────────
  setTier(0.2, 220, 220);
  let texts = record(() => pm.render());
  ck('f2 放大档画出了省名「青原省」', has(texts, '青原省'), texts.slice(0, 12));
  ck('f2 ★ 放大档**不该**画势力名（省名与势力名是同批数据的两种呈现）',
     !has(texts, '甲午王朝') && !has(texts, '乙卯王朝'), null);
  setTier(0.2, 460, 220);
  const texts2 = record(() => pm.render());
  ck('f2 放大档是**逐省**命名（换到第二省会画它自己的名字）',
     has(texts2, '赤谷省') && !has(texts2, '青原省'), texts2.slice(0, 12));

  setTier(0.8, 460, 220);
  texts = record(() => pm.render());
  ck('f2 中档画出了势力**全名**', has(texts, '甲午王朝') && has(texts, '乙卯王朝'), texts.slice(0, 12));
  ck('f2 ★ 中档**不该**画省名（与放大档正好相反）',
     !has(texts, '青原省') && !has(texts, '白川县'), null);

  setTier(2.5, 440, 220);
  texts = record(() => pm.render());
  ck('f2 缩小档画的是**简称**（精确相等，不用子串 —— 简称是全名的子串）',
     hasExact(texts, '甲午') && hasExact(texts, '乙卯'), texts.slice(0, 12));
  ck('f2 ★ 缩小档不再画全名（「缩小只显示势力名称（可简写）」）',
     !hasExact(texts, '甲午王朝') && !hasExact(texts, '乙卯王朝'), null);

  // 关掉图层 → 一条势力标注都不该出现（接线真的通到开关上）
  pm.showPolityLabels = false;
  await tick(80);
  const off = record(() => pm.render());
  ck('f2 关掉「势力名」图层 → 不再画任何势力/省名',
     !has(off, '甲午') && !has(off, '乙卯') && !has(off, '青原省'), off.slice(0, 12));
  pm.showPolityLabels = true;
  await tick(80);

  // ── f3 改名落库（走 undo / redo / 空改动 / 空名）──────────────────────
  const r1 = store.updatePolity(SCID, POLA, { name: '丙申王朝', abbr: '丙申' });
  ck('f3 改名返回成功且标记 changed', !!(r1 && r1.success === true && r1.changed === true), r1);
  setTier(0.8, 460, 220);
  texts = record(() => pm.render());
  ck('f3 ★ 改名后画布跟着变（不需要谁记得去刷）', has(texts, '丙申王朝') && !has(texts, '甲午王朝'), texts.slice(0, 12));

  const r2 = store.updatePolity(SCID, POLA, { name: '丙申王朝' });
  ck('f3 无实质改动 → changed:false（不产生空撤销条目）', !!(r2 && r2.success && r2.changed === false), r2);
  const r3 = store.updatePolity(SCID, POLA, { name: '   ' });
  ck('f3 空名不写（势力名必填，清空视为没输入）',
     !!(r3 && r3.changed === false) && store.scenarios[SCID].polities.find(p => p.id === POLA).name === '丙申王朝', r3);

  store.undo();
  setTier(0.8, 460, 220);
  texts = record(() => pm.render());
  ck('f3 ★ 撤销 → 名字回到「甲午王朝」', has(texts, '甲午王朝') && !has(texts, '丙申王朝'), texts.slice(0, 12));
  store.redo();
  setTier(0.8, 460, 220);
  texts = record(() => pm.render());
  ck('f3 重做 → 又回到「丙申王朝」', has(texts, '丙申王朝'), texts.slice(0, 12));

  // ── f4 UI + 省份详情给全名 ──────────────────────────────────────────
  ck('f4 「势力名」勾选框存在', !!document.querySelector('[data-testid="toggle-polity-labels"]'), null);

  const polA = store.scenarios[SCID].polities.find(p => p.id === POLA);
  pm.selectPolity(polA);
  await tick(120);
  const editor = document.querySelector('[data-testid="polity-editor"]');
  ck('f4 选中势力后出现「名称/简称」编辑区', !!editor, null);
  const nameInput = document.querySelector('[data-testid="polity-name-input"]');
  const abbrInput = document.querySelector('[data-testid="polity-abbr-input"]');
  ck('f4 名称输入框已渲染且值 = 当前势力名', !!(nameInput && nameInput.value === '丙申王朝'), nameInput && nameInput.value);
  ck('f4 简称输入框已渲染且值 = 当前简称', !!(abbrInput && abbrInput.value === '丙申'), abbrInput && abbrInput.value);

  // 受控输入必须用原型 setter 派发事件才会生效（否则 Vue 收不到）
  const setInput = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (abbrInput) {
    setInput(abbrInput, '申');
    await tick(120);
    const nowAbbr = store.scenarios[SCID].polities.find(p => p.id === POLA).abbr;
    ck('f4 通过界面改简称 → 落进 store', nowAbbr === '申', nowAbbr);
    setTier(2.5, 440, 220);
    texts = record(() => pm.render());
    ck('f4 改简称后缩小档画的是新简称（精确相等）', hasExact(texts, '申'), texts.slice(0, 12));
  }

  // 真实点击省份 → 状态栏显示所属势力**全名**
  pm.tool = 'select';
  pm.cameraScale = 1; pm.cameraX = 0; pm.cameraY = 0;   // 1:1 → 世界坐标 == 屏幕坐标
  pm.render();
  const cvs = document.querySelector('.scenario-canvas-wrap canvas');
  const rc = cvs.getBoundingClientRect();
  cvs.dispatchEvent(new MouseEvent('click', {
    clientX: rc.left + 220, clientY: rc.top + 220, bubbles: true, button: 0,
  }));
  await tick(150);
  ck('f4 点击省份后选中态生效', !!(pm.selectedProvince && pm.selectedProvince.id === 'a8p1'),
     pm.selectedProvince && pm.selectedProvince.id);
  const hud = document.querySelector('[data-testid="province-polity-name"]');
  ck('f4 ★ 省份详情显示了势力**全名**', !!hud && hud.textContent.trim() === '丙申王朝', hud && hud.textContent);
  ck('f4 详情里同时给出简称（全名与简称并存，供校对）',
     !!document.querySelector('.selected-province') && /申/.test(document.querySelector('.selected-province').textContent),
     document.querySelector('.selected-province') && document.querySelector('.selected-province').textContent);

  notes.push('canv ' + (pm.canvas ? pm.canvas.width + 'x' + pm.canvas.height : '?') + '，地图宽 ' + pm.mapWorldSize().w);

  // ── 清理：删掉本用例造的剧本（避免污染后续用例的剧本列表）────────────
  try { store.removeScenario(SCID); } catch (e) { /* 清理失败不影响判定 */ }

  return JSON.stringify({ fails, notes });
})()"""


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    wait_for(cdp, f"{STORE}.nodes.length > 0", timeout=45, desc='地理数据加载')

    # f0：源码守卫（不启浏览器也能判，先跑，省一次等待）
    ok, detail = sub_source_guards(cdp)
    if not ok:
        return False, f'f0 源码守卫失败：{detail}'

    entered = cdp.eval("""(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('历史剧本'));
      if (!btn) return 'no-btn';
      btn.click();
      return 'ok';
    })()""")
    if entered != 'ok':
        return False, f'未找到「历史剧本」入口（{entered}）'
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=20, desc='ScenarioMap 挂载')
    time.sleep(1.0)

    bm_ok, bm_info = H.open_test_base_map(cdp, BASEMAP)
    if not bm_ok:
        return False, f'底图 fixture 未就位: {bm_info}'
    time.sleep(0.4)

    # ⚠️ 「势力名」勾选框在工具栏「更多」里（默认收起）—— 不展开则 DOM 里根本没有
    if not H.open_toolbar_more(cdp):
        return False, '未能展开剧本工具栏「更多」'

    js = (JS.replace('PLACEHOLDER_STORE', STORE)
            .replace('PLACEHOLDER_PM', PM)
            .replace('__BASEMAP__', json.dumps(BASEMAP))
            .replace('__SCID__', json.dumps(SCID))
            .replace('__PROVS__', json.dumps(PROVS))
            .replace('__POLA__', json.dumps(POLA))
            .replace('__POLB__', json.dumps(POLB)))

    ok, res = eval_json(cdp, js, desc='A8 势力标注分级')
    if not ok:
        return False, res
    if isinstance(res, dict):
        fails = res.get('fails') or []
        if fails:
            return False, f'A8 断言失败 {len(fails)} 项：' + '；'.join(str(x) for x in fails[:10])
        notes = res.get('notes') or []
        return True, ('分级三档 + 单调 / 三档分别画省名·势力全名·简称（互为反面）/ '
                      '改名落库与撤销重做 / 勾选框与内联编辑 / 点击省份给全名 —— 全部通过'
                      + ('；' + '；'.join(notes) if notes else ''))
    return False, f'用例返回值异常：{str(res)[:200]}'
