#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 100：剧本 PNG 导出（P0「第一张图最小闭环」的机器验证）

🔴 为什么需要这个用例：**PNG 导出此前全仓零覆盖** ——
   `grep -n "export-png|exportScenarioPNG|rasterizeSvg" scripts/` 无命中；
   `test_42` 只覆盖 JSON + **SVG**。于是"导出的 PNG 到底是不是一张图"这个问题
   从来没有被问过：尺寸算错（`scale` 没生效）、整张空白（背景色把内容盖了）、
   标注丢失（图层开关没接进导出）、只走了一次 IPC 而根本没产出图、
   dataUrl 是 1×1 占位 —— 这些**全都不会让任何用例变红**。

本用例的三条纪律：
  · **真鼠标事件**点 `[data-testid="export-png"]`（不是直接调 `exportScenarioPNG()`）——
    后者会绕过按钮的挂载态 / 「更多」面板展开态 / `@click` 绑定这三层。
    导出按钮在 `.toolbar-more`（模板里是 `v-if="moreOpen"`）里 → **不展开就查不到该元素**。
  · **分块取回** dataUrl（`lib/cdp.fetch_string`）：CDP 读超时 15s，一次取几 MB 必炸。
  · 判据是**像素级**的（Pillow）：合法 PNG / 尺寸 == SVG 头解析出的 `W*2 × H*2` /
    非空白 / 三个已知势力色确有像素 / 确有 LABEL_COLOR 的省名文字像素。
    "调用了 IPC" 不算判据。

覆盖：
  f0 前置：2 省 / 2 剧本 / 3 势力（`#c23b3b` `#4a90d9` `#e6a23c`），游标落到「乙时代」。
  f1 PNG 像素判据（真鼠标点击 + 分块取回 + Pillow）。
  f2 反向：`SM.showLabels = false` 重导 → **省名文字像素归零**（实测数字见下），
     且除标注外逐像素一致；另有一枚"连导两次完全一致"的对照，证明 f1 的差异不是光栅化噪声。
  f3 非真空对照：一个必然不存在的颜色（`#00ff00`）在图上必须是 0 像素 ——
     否则说明颜色判据"什么都能匹配"，f1 的势力色断言就是空的。
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, fetch_string, wait_for                     # noqa: E402
from lib.helpers import ensure_data_ready, open_test_base_map, open_toolbar_more  # noqa: E402
import lib.pngcheck as png                                                # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
KEY = '用例100底图'
SC1 = KEY + '/甲时代'
SC2 = KEY + '/乙时代'
# 三个已知势力色（既是 fixture 的取值，也顺带与真实项目 desite/诸侯割据 的配色同族）
C1, C2, C3 = '#c23b3b', '#4a90d9', '#e6a23c'
# ══════════════════════════════════════════════════════════════════════════
# 阈值（全部为 **2026-10-13 实测值** 打折后写死，注释里留实测数；见下方 MEASURED）
# ══════════════════════════════════════════════════════════════════════════
TOL = 8                     # 逐通道容差（任务要求 ≤8；实测原色/合成色的偏差为 0）
MIN_UNIQUE_COLORS = 4       # 实测 840×440 的图上 2524 色
MIN_COLOR_PIXELS = 1000     # 实测「原色 + 0.72 合成色」合计：C1=27208 C2=43261 C3=18848
MIN_TEXT_PIXELS = 1500      # 实测「标注层贡献的像素」（有/无标注两导之差）= 3182
MIN_LABEL_PIXELS = 400      # 实测其中**实心笔画**（= LABEL_COLOR@0.85 的精确合成色）= 904
# ⚠️ 诚实交代：上面两条**文字**阈值是按按钮的默认档 `exportScenarioPNG()`（= `scale=2`）标定的。
#    反向探针实测把默认档改成 `scale=1` 后，笔画像素从 904 掉到 244、标注层像素从 3182 掉到 956
#    → 这两条也会跟着红（同时尺寸判据先红）。这是**正确**的红（PNG 确实不再是 2 倍图），
#    但要知道它们是**尺度相关**的：日后真要支持"用户自选倍率"，这两条得改成按 `scale` 缩放。


# ══════════════════════════════════════════════════════════════════════════
# 造数（2 省 + 2 剧本 + 3 势力）—— 与 test_42 的 _seed_js 同款写法
# ══════════════════════════════════════════════════════════════════════════
SEED_JS = r"""
  for (const k of Object.keys(s.scenarios || {})) s.removeScenario(k);
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: KEY });
  s.baseMaps[KEY].terrain.length = 0;
  const mk100 = (id, name, x0) => ({ id, name, kind: 'land',
    points: [{x:x0,y:150},{x:x0+140,y:150},{x:x0+140,y:290},{x:x0,y:290}] });
  s.addBaseProvince(KEY, mk100('prov_a', '甲省测试地名甲乙丙', 200), { checkOverlap: false });
  s.addBaseProvince(KEY, mk100('prov_b', '乙省测试地名丁戊己', 400), { checkOverlap: false });
  const P = (id, name, color) => ({ id, name, color });
  s.createScenario(KEY + '/甲时代', { ownerKey: KEY, name: '甲时代', order: 1,
    era: { roman: 'I', label: '甲', startYear: '2000', endYear: '2010' },
    polities: [P('A1', '甲国', '#c23b3b')],
    ownership: { prov_a: 'A1', prov_b: 'A1' } });
  s.createScenario(KEY + '/乙时代', { ownerKey: KEY, name: '乙时代', order: 2,
    era: { roman: 'II', label: '乙', startYear: '2010', endYear: '2020' },
    polities: [P('B1', '乙国', '#4a90d9'), P('B2', '乙南', '#e6a23c')],
    ownership: { prov_a: 'B1', prov_b: 'B2' } });
  SM.baseMapKey = KEY;
  if (typeof SM.onBaseMapChange === 'function') await SM.onBaseMapChange();
  SM.tlDiffMode = 'eu4';
  // 落到「乙时代末年」：此时 prov_b 已易主（EU4 斜线 = 旧主底色 + 新主斜线）
  const scIds = SM.timeline.scenarios.map(x => x.id);
  SM.tlDate = { y: 2020, m: null, d: null };
  SM.tlEra = scIds.indexOf(KEY + '/乙时代');
  SM.selectedPolity = null;
  SM.selectedProvinceIds = [];
"""


def _seed():
    return (SEED_JS.replace('__STORE__', STORE).replace('__KEY__', json.dumps(KEY)))


# ══════════════════════════════════════════════════════════════════════════
# 导出探针：**真鼠标事件**点按钮 → 等 dataUrl + 状态栏
# ══════════════════════════════════════════════════════════════════════════
EXPORT_JS = r"""(async () => {
  const fails = [], notes = {};
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 120));
  const s = __STORE__, SM = __SM__;
  const KEY = __KEY__;
  // 真鼠标事件（不是 el.click()）：坐标从布局取，并确认该点上**最顶层的元素就是按钮**
  const clickReal = (el) => {
    const rc = el.getBoundingClientRect();
    const cx = rc.left + rc.width / 2, cy = rc.top + rc.height / 2;
    const top = document.elementFromPoint(cx, cy);
    const mk = (t) => new MouseEvent(t, { clientX: cx, clientY: cy, bubbles: true, cancelable: true, button: 0 });
    el.dispatchEvent(mk('mousedown'));
    el.dispatchEvent(mk('mouseup'));
    el.dispatchEvent(mk('click'));
    return { hit: !!top && (top === el || el.contains(top)),
             rect: { x: Math.round(rc.left), y: Math.round(rc.top), w: Math.round(rc.width), h: Math.round(rc.height) } };
  };

  // setupState 上到底有哪些绑定：本用例依赖的几个先点名（缺一个就带现场返回，不许静默 undefined）
  const need = ['showLabels', 'timeline', 'tlDate', 'tlEra', 'tlYear', 'baseMapKey', 'tlDiffMode'];
  const missing = need.filter(k => !(k in SM));
  if (missing.length) {
    notes.setupKeys = Object.keys(SM).slice(0, 400);
    return JSON.stringify({ fails: fails.concat('ScenarioMap 的 setupState 缺绑定: ' + JSON.stringify(missing)), notes });
  }

  __SEED__
  await tick(400);

  if (__WITH_SEED__) {
    ck('前置：底图有 2 个省', (s.baseMaps[KEY].terrain || []).length === 2, (s.baseMaps[KEY].terrain || []).length);
    ck('前置：共 2 个剧本', Object.keys(s.scenarios).length === 2, Object.keys(s.scenarios));
    ck('前置：游标落在乙时代 2020', SM.tlEra === 1 && Math.round(SM.tlYear) === 2020,
       { era: SM.tlEra, year: Math.round(SM.tlYear), scIds: SM.timeline.scenarios.map(x => x.id) });
  }

  // ── 尺寸判据的真源 = SVG 头 ──────────────────────────────────────────────
  // 🔴 `buildScenarioSVG` **不是** setupState 顶层绑定（组件只解构了 `export*` 那几个；
  //    它挂在 composable 返回对象 `scenarioExport` 上）。三条路依次取，取不到就带回现场：
  //      ① setupState 顶层 → ② `SM.scenarioExport` 上 → ③ 真鼠标点「导出 SVG」按钮拿 IPC 载荷
  let svgText = '', svgSource = '';
  const direct = (typeof SM.buildScenarioSVG === 'function') ? SM.buildScenarioSVG
    : (SM.scenarioExport && typeof SM.scenarioExport.buildScenarioSVG === 'function')
      ? SM.scenarioExport.buildScenarioSVG : null;
  if (direct) {
    svgSource = (typeof SM.buildScenarioSVG === 'function') ? 'setupState-top' : 'setupState.scenarioExport';
    try { svgText = String(direct().svg || ''); } catch (e) { svgText = ''; svgSource = 'setupState-err:' + e.message; }
  }
  if (!svgText) {
    const svgBtn = document.querySelector('[data-testid="export-svg"]');
    if (svgBtn) {
      window.__LAST_TEXT_EXPORT__ = null;
      clickReal(svgBtn);
      let w2 = 0;
      while (!window.__LAST_TEXT_EXPORT__ && w2 < 15000) { await tick(100); w2 += 100; }
      svgText = String((window.__LAST_TEXT_EXPORT__ || {}).text || '');
      svgSource = 'export-svg-button(' + w2 + 'ms)';
    }
  }
  notes.svgSource = svgSource;
  if (!svgText) {
    notes.setupKeys = Object.keys(SM).slice(0, 400);
    return JSON.stringify({ fails: fails.concat('取不到 SVG 文本（三条路全空）'),
                            notes });
  }

  // 运行时改写 mock 的 saveExportFile（默认恒返回 canceled:true，否则永远走不到"导出成功"分支）
  window.__LAST_EXPORT__ = null;
  window.__EXPORT_CALLS__ = 0;
  window.sitianAPI.saveExportFile = async (o) => {
    window.__LAST_EXPORT__ = o;
    window.__EXPORT_CALLS__++;
    return { success: true, path: 'mock/p0.png' };
  };

  SM.showLabels = __SHOW_LABELS__;
  SM.exportStatus = '';
  await tick(300);

  const btn = document.querySelector('[data-testid="export-png"]');
  if (!btn) {
    return JSON.stringify({ fails: fails.concat('导出按钮不在 DOM —— 工具栏「更多」没展开？（它在 v-if="moreOpen" 的 .toolbar-more 里）'),
      notes: { more: !!document.querySelector('.toolbar-more'),
               testids: Array.from(document.querySelectorAll('[data-testid]')).map(e => e.getAttribute('data-testid')) } });
  }
  const hit = clickReal(btn);
  notes.hitTarget = hit.hit;
  notes.btnRect = hit.rect;

  let waited = 0;
  while ((!window.__LAST_EXPORT__ || !/已导出 PNG/.test(String(SM.exportStatus || ''))) && waited < 30000) {
    await tick(100); waited += 100;
  }
  notes.waitedMs = waited;
  ck('点一次只发生一次 saveExportFile 调用', window.__EXPORT_CALLS__ === 1, window.__EXPORT_CALLS__);
  ck('走到了 saveExportFile（不是"点了没反应"）', !!window.__LAST_EXPORT__);
  ck('状态栏报「已导出 PNG」', /已导出 PNG/.test(String(SM.exportStatus || '')), SM.exportStatus);
  if (!window.__LAST_EXPORT__) {
    return JSON.stringify({ fails, notes });
  }
  const rec = window.__LAST_EXPORT__ || {};
  const du = String(rec.dataUrl || '');
  notes.defaultName = rec.defaultName;
  notes.dataUrlPrefix = du.slice(0, 22);
  notes.dataUrlLen = du.length;
  notes.exportStatus = SM.exportStatus;
  notes.showLabels = SM.showLabels;
  notes.tlYear = Math.round(SM.tlYear);
  notes.tlEra = SM.tlEra;

  const head = svgText.match(/width="(\d+)"\s+height="(\d+)"/);
  notes.svgW = head ? Number(head[1]) : -1;
  notes.svgH = head ? Number(head[2]) : -1;
  notes.svgBytes = svgText.length;
  notes.svgPathCount = (svgText.match(/<path /g) || []).length;
  notes.svgTextCount = (svgText.match(/<text /g) || []).length;
  notes.svgPatternCount = (svgText.match(/<pattern /g) || []).length;
  // 文本层：省名 + 势力图例名 + 剧本名（"导出物应自解释"）
  notes.svgHasProvA = svgText.indexOf('甲省') >= 0;
  notes.svgHasProvB = svgText.indexOf('乙省') >= 0;
  notes.svgHasLegend = svgText.indexOf('势力') >= 0 && svgText.indexOf('乙国') >= 0;
  notes.svgHasTitle = svgText.indexOf('乙时代') >= 0;
  // P0 制图要素：比例尺（世界单位）。没有它，“第一张图”只能自用、不能交人。
  notes.svgHasScaleBar = svgText.indexOf('比例尺') >= 0 && svgText.indexOf('单位') >= 0;
  notes.svgHasLabelColor = svgText.toUpperCase().indexOf('#3C4150') >= 0;
  return JSON.stringify({ fails, notes });
})()"""


def _export_expr(show_labels, with_seed):
    return (EXPORT_JS.replace('__STORE__', STORE).replace('__SM__', SM)
            .replace('__KEY__', json.dumps(KEY))
            .replace('__SEED__', _seed() if with_seed else '')
            .replace('__WITH_SEED__', 'true' if with_seed else 'false')
            .replace('__SHOW_LABELS__', 'true' if show_labels else 'false'))


def _enter(cdp):
    """进剧本模式（轮询等按钮出现：应用未挂载时表达式抛错会被 wait_for 当成真值）。"""
    for _ in range(20):
        r = cdp.eval("""(() => {
          const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
          if (!app || !app._instance) return 'not-ready';
          const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('历史剧本'));
          if (!b) return 'no-btn';
          b.click(); return 'ok';
        })()""")
        if r == 'ok':
            return 'ok'
        if r == 'no-btn':
            return 'no-btn'
        time.sleep(0.5)
    return 'timeout'


def _fetch_data_url(cdp, desc):
    """把 `window.__LAST_EXPORT__.dataUrl` 从页面分块取回（CDP 读超时 15s）。"""
    return fetch_string(
        cdp,
        "window.__LAST_EXPORT__ && window.__LAST_EXPORT__.dataUrl ? window.__LAST_EXPORT__.dataUrl.length : -1",
        lambda i, j: "window.__LAST_EXPORT__.dataUrl.slice(%d,%d)" % (i, j),
        chunk=524288, desc=desc)


def _do_export(cdp, show_labels, with_seed, desc):
    """跑一次导出探针；返回 (ok, notes_or_error, data_url_or_None)。"""
    ok, res = eval_json(cdp, _export_expr(show_labels, with_seed), required=('fails', 'notes'), desc=desc)
    if not ok:
        return False, res, None
    if res['fails']:
        return False, ('导出探针断言失败：' + '；'.join(res['fails'][:6])
                       + ' 现场：' + json.dumps(res.get('notes'), ensure_ascii=False)[:600]), None
    if not res['notes'].get('dataUrlLen'):
        return False, f'没拿到 dataUrl：{json.dumps(res["notes"], ensure_ascii=False)[:400]}', None
    try:
        data_url = _fetch_data_url(cdp, desc + '（分块取回 dataUrl）')
    except Exception as e:
        return False, f'{desc}：dataUrl 分块取回失败：{e}', None
    return True, res['notes'], data_url


def run(cdp):
    ensure_data_ready(cdp)
    r = _enter(cdp)
    if r != 'ok':
        return False, f'进入剧本模式失败: {r}'
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", desc='ScenarioMap 挂载', timeout=8)
    cdp.eval("window.confirm = () => true; window.prompt = (m, d) => d;")
    time.sleep(0.8)
    # 导出按钮在 .toolbar-more（v-if="moreOpen"）里 —— 不展开就是"查不到元素"，不是产品缺陷
    if not open_toolbar_more(cdp):
        return False, '工具栏「更多」面板没展开（导出按钮就在里面）—— 先查 .scenario-toolbar 的按钮 title'

    # ══════════════ f1：有标注 → PNG（真鼠标点击 → 分块取回） ══════════════
    ok, notes1, du_a = _do_export(cdp, True, True, 'f1 导出 PNG（含标注）')
    if not ok:
        return False, notes1

    # ══════════════ f2：关掉标注重导（反向对照） ══════════════
    ok, notes2, du_b = _do_export(cdp, False, False, 'f2 导出 PNG（关掉标注）')
    if not ok:
        return False, f'反向对照（关掉标注）导出失败：{notes2}'
    # 连导两次同一配置 → 逐像素必须完全一致（证明差异不是光栅化噪声）
    ok, notes3, du_b2 = _do_export(cdp, False, False, 'f2b 再导一次（一致性对照）')
    if not ok:
        return False, f'一致性对照导出失败：{notes3}'

    # ══════════════ Python 侧：Pillow 像素判据 ══════════════
    try:
        img_a, img_b, img_b2 = png.open_png(png.decode_data_url(du_a)), \
            png.open_png(png.decode_data_url(du_b)), png.open_png(png.decode_data_url(du_b2))
    except Exception as e:
        return False, f'dataUrl 解不成 PNG（{e}）；长度 {len(du_a)}，前缀 {du_a[:22]!r}'

    expect_size = (notes1['svgW'] * 2, notes1['svgH'] * 2)
    fails = []
    n_unique = png.unique_colors(img_a)
    if img_a.format != 'PNG':
        fails.append(f'不是合法 PNG：format={img_a.format}')
    if img_a.size != expect_size:
        fails.append(f'PNG 尺寸 != SVG 头 ×2：{img_a.size} vs {expect_size}（SVG {notes1["svgW"]}×{notes1["svgH"]}）')
    if n_unique < MIN_UNIQUE_COLORS:
        fails.append(f'去重颜色数 {n_unique} < {MIN_UNIQUE_COLORS}（疑似空白图）')

    # 势力色：原色（图例色块 / EU4 斜线）+ 0.72 合成色（省份填充）两种落点都算
    color_stats = {}
    polity_rgb = []
    for name, hexc in (('#c23b3b', C1), ('#4a90d9', C2), ('#e6a23c', C3)):
        c = tuple(int(hexc[i:i + 2], 16) for i in (1, 3, 5))
        polity_rgb.append(c)
        exact = png.count_near(img_a, c, TOL)
        blend = png.count_near_blend(img_a, c, png.PROVINCE_FILL_ALPHA, png.SVG_BG, TOL)
        color_stats[name] = {'exact': exact, 'blend': blend, 'total': exact + blend}
        if exact + blend < MIN_COLOR_PIXELS:
            fails.append(f'势力色 {name} 在图上像素过少：原色 {exact} + 0.72 合成 {blend} = {exact + blend} < {MIN_COLOR_PIXELS}')

    # ── 标注（省名）的判据：**两套互补口径**，都出自「有标注 / 无标注」两张独立导出 ──
    #   ① `text_px` = 两份导出逐像素差 = **标注这一层贡献的全部像素**（含抗锯齿边缘）
    #   ② `label_px` = 其中**实心笔画**：`b` 就是文字底下真实的背景，所以期望色
    #      `0.85*LABEL + 0.15*b` 是逐像素精确的 → 落在 ±TOL 内的即是 LABEL_COLOR 的笔画
    #   ③ 反向 = 两次**独立**的「关掉 labels」导出之差：同一算子在"开"时给 578，在"关"时必须给 0
    # 为什么不用"数某个候选色"当独立判据（实测过，已弃用）：省界 / 网格 与省份填充的过渡色
    # 会落进候选集合，产生 **~4.8k 的假阳性地板**（实测 4843 vs 真实 39），比值判据因此失效。
    text_px, _ = png.diff_pixels(img_a, img_b)
    label_px = png.label_text_pixels(img_a, img_b, png.LABEL_COLOR, png.LABEL_ALPHA, TOL)
    text_px_off, _ = png.diff_pixels(img_b, img_b2)   # 两次"关掉 labels"的独立导出之差
    cands = png.name_text_candidates(png.LABEL_COLOR, png.LABEL_ALPHA, polity_rgb)
    direct_on = png.count_near_any(img_a, cands, TOL)
    direct_off = png.count_near_any(img_b, cands, TOL)
    if text_px < MIN_TEXT_PIXELS:
        fails.append(f'标注层贡献的像素 {text_px} < {MIN_TEXT_PIXELS} —— 省名标注没进 PNG（或几乎没画出来）')
    if label_px < MIN_LABEL_PIXELS:
        fails.append(f'LABEL_COLOR 实心笔画像素 {label_px} < {MIN_LABEL_PIXELS}（标注不是 LABEL_COLOR 画的？）')
    # 🔴 反向判据：关掉 labels 后，同一算子测得的标注层像素必须归零（实测 578 → 0）
    if text_px_off != 0:
        fails.append(f'关掉 labels 后标注层仍有 {text_px_off} 像素（应归零；开标注时是 {text_px}）')
    # 同一枚数字同时是一致性对照：同一配置连导两次必须逐像素一致
    # （若光栅化不确定，`text_px_off` 会非 0 → f1 的像素判据整体不可靠）
    noise_px = text_px_off

    # f3 非真空对照：图上不可能有的颜色必须 0 像素
    ctrl_stats = {}
    for name, hexc in ((' #00ff00', '#00ff00'), ('#ff00ff', '#ff00ff')):
        c = tuple(int(hexc[i:i + 2], 16) for i in (1, 3, 5))
        ctrl_stats[name.strip()] = png.count_near(img_a, c, TOL) + png.count_near_blend(img_a, c, png.PROVINCE_FILL_ALPHA, png.SVG_BG, TOL)
        if ctrl_stats[name.strip()] != 0:
            fails.append(f'非真空对照失败：颜色 {name.strip()} 不该出现，却有 {ctrl_stats[name.strip()]} 像素'
                         '（说明颜色判据什么都能匹配，势力色断言是空的）')

    # SVG 文本层判据（与像素判据互补：一个判"画出来了"，一个判"内容对不对"）
    if not (notes1['svgHasProvA'] and notes1['svgHasProvB']):
        fails.append(f'SVG 文本里缺省名：aprov={notes1["svgHasProvA"]} bprov={notes1["svgHasProvB"]}')
    if not notes1['svgHasLegend']:
        fails.append('SVG 缺势力图例（「势力」+ 势力名）')
    if not notes1['svgHasTitle']:
        fails.append('SVG 缺剧本名标题')
    if not notes1.get('svgHasScaleBar'):
        fails.append('SVG 缺比例尺（P0：图例/比例尺/标题三件）')
    if notes1['svgTextCount'] <= 0:
        fails.append('SVG 里一个 <text> 都没有')
    if not notes1['svgHasLabelColor']:
        fails.append('SVG 里没有 LABEL_COLOR(#3c4150) 的省名文字')

    if fails:
        return False, ('PNG 导出判据失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8])
                       + ' | 实测：' + json.dumps({
                           'png_size': img_a.size, 'expect': expect_size, 'uniqueColors': n_unique,
                           'colors': color_stats, 'labelLayerPixels': text_px, 'labelStrokePixels': label_px,
                           'labelLayerPixelsAfterOff': text_px_off,
                           'candidateColorCounts_含假阳性地板_仅参考': {'on': direct_on, 'off': direct_off},
                           'noiseBetweenTwoExports': noise_px,
                           'controlColors': ctrl_stats, 'status': notes1['exportStatus'],
                           'bytes': len(du_a), 'svgSource': notes1.get('svgSource'),
                           'svgText': notes1['svgTextCount'],
                           'svgPaths': notes1['svgPathCount'], 'svgPatterns': notes1['svgPatternCount'],
                       }, ensure_ascii=False))

    return True, (
        f'PNG {img_a.size[0]}×{img_a.size[1]}（= SVG {notes1["svgW"]}×{notes1["svgH"]} ×2）'
        f' / {len(du_a)}B dataUrl / 去重色 {n_unique}'
        f' / 势力色像素 原色+0.72合成 C1={color_stats["#c23b3b"]["total"]}'
        f'(exact {color_stats["#c23b3b"]["exact"]}) C2={color_stats["#4a90d9"]["total"]}'
        f'(exact {color_stats["#4a90d9"]["exact"]}) C3={color_stats["#e6a23c"]["total"]}'
        f'(exact {color_stats["#e6a23c"]["exact"]})'
        f' / 标注层像素 {text_px}（其中 LABEL_COLOR 实心笔画 {label_px}）'
        f' → 关掉 labels 后 {text_px_off}（同一算子，归零）'
        f' / 连导两次差异 {noise_px}px'
        f' / 非真空对照 #00ff00={ctrl_stats["#00ff00"]} #ff00ff={ctrl_stats["#ff00ff"]}'
        f' / SVG {notes1["svgPathCount"]} path {notes1["svgTextCount"]} text {notes1["svgPatternCount"]} pattern'
        f'（源: {notes1.get("svgSource")}）'
        f' / 状态栏「{notes1["exportStatus"]}」')
