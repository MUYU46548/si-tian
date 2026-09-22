#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 58：「导入知识库内容」+ 面板暗色可读性（2026-09-22 用户实测反馈）

用户实测三条里两条是"卡住"级的：
  · 「司天能联动打开 Obsidian 库，但这不意味着可以从 Obsidian 导入数据……我设法找到了重新提取数据的按钮，
     点下去没有反应。我的项目依然是空的。」
    → 真因：**已存在的（空）项目没有任何把知识库内容带进来的入口** ——「新建并导入知识库内容」只管新建那条路，
      「重新提取」在项目态被正确拒绝（两套事实源混流），用户就卡在"项目里空空的"。
  · 「面板部分文本在暗色模式背景下难以阅读」
    → 真因：面板底色是 PanelShell 的 `--panel-bg`（暗色主题 = #161b22），而面板里写死了深色文字 → 深底深字。

本用例守：
  a) 空项目下**世界视图空态**有「导入知识库内容」入口，且真的能导入（实体进项目 + 节点上画布）
  b) 项目面板有「导入知识库内容」按钮 + 说明文案（能导入多少、只补缺、可撤销）
  c) 导入是**一条 undo**（Ctrl+Z 能整体撤销）且**不覆盖**项目里已有的实体
  d) 面板文字在**亮色与暗色两套主题**下都达到对比度底线（WCAG 小字 4.5）
  e) 静态：canvasBridge 有第四个注册口（导入）、App/面板不经 geodata 直连
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.helpers import ensure_case_state   # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
APP = "document.querySelector('#app').__vue_app__"
PANEL = "document.querySelector('.project-panel')"

# 对比度探针（与 skill §122 同款：逐层合成背景 + WCAG 比值）
CONTRAST_JS = r"""(() => {
  const parse = (bg) => {
    const m = /rgba?\(([^)]+)\)/.exec(bg || '');
    if (!m) return null;
    const p = m[1].split(',').map(s => parseFloat(s));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const bgOf = (el) => {
    const stack = [];
    let node = el;
    while (node) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) { stack.push(c); if (c.a >= 0.999) break; }
      node = node.parentElement;
    }
    let base = [255, 255, 255];
    for (const c of stack.reverse()) base = [0,1,2].map(i => base[i] * (1 - c.a) + [c.r, c.g, c.b][i] * c.a);
    return base;
  };
  const lum = (rgb) => {
    const f = (v) => { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  };
  const ratio = (fg, bg) => { const a = lum(fg), b = lum(bg); const hi = Math.max(a, b), lo = Math.min(a, b); return (hi + 0.05) / (lo + 0.05); };
  const parseColor = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return null;
    const p = m[1].split(',').map(s => parseFloat(s)); return [p[0], p[1], p[2]]; };

  const root = document.querySelector(__ROOT__);
  if (!root) return JSON.stringify({ err: 'no-root' });
  const bad = [];
  let checked = 0, min = 99, minInfo = null;
  for (const el of root.querySelectorAll('*')) {
    // 只看"直接承载文字"的元素
    const hasText = Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!hasText) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.5) continue;
    const fg = parseColor(cs.color);
    if (!fg) continue;
    const size = parseFloat(cs.fontSize) || 12;
    const bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
    const large = size >= 18.66 || (size >= 14 && bold);
    const need = large ? 3.0 : 4.5;
    const r = ratio(fg, bgOf(el));
    checked += 1;
    if (r < min) { min = r; minInfo = { text: (el.textContent || '').trim().slice(0, 24), cls: String(el.className || '').slice(0, 40), size: size, need: need, ratio: Math.round(r * 100) / 100 }; }
    if (r < need) bad.push({ text: (el.textContent || '').trim().slice(0, 24), cls: String(el.className || '').slice(0, 40), size: size, need: need, ratio: Math.round(r * 100) / 100, color: cs.color, bg: bgOf(el).map(Math.round).join(',') });
  }
  return JSON.stringify({ checked, min: Math.round(min * 100) / 100, minInfo, bad: bad.slice(0, 8), theme: document.querySelector('.app-layout').className });
})()"""


def _j(raw, label):
    try:
        return json.loads(raw)
    except Exception:
        raise AssertionError(f'{label} 读取失败：{str(raw)[:240]}')


def _contrast(cdp, root_sel):
    return _j(cdp.eval(CONTRAST_JS.replace('__ROOT__', json.dumps(root_sel))), '对比度探针')


def _open_project_panel(cdp):
    cdp.eval("""(() => {
      const b = Array.from(document.querySelectorAll('button'))
        .find(x => (x.getAttribute('title') || '').indexOf('.sitian') >= 0);
      if (b) b.click();
      return 'ok';
    })()""")
    for _ in range(30):
        if cdp.eval("!!document.querySelector('.project-panel')"):
            return True
        time.sleep(0.1)
    return False


def run(cdp):
    ensure_case_state(cdp)

    # ── a) 建一个**空项目**（复现用户的处境：项目里空空的） ───────────────────
    created = _j(cdp.eval("""(async () => {
      const app = %s;
      const pinia = app.config.globalProperties.$pinia;
      const M = await import('/src/store/projectStore.js');
      const proj = M.useProjectStore(pinia);
      const res = await proj.createProject({ name: '导入测试项目', dir: 'mock/projects' });
      await new Promise(r => setTimeout(r, 400));
      const st = app._instance.setupState.store;
      return JSON.stringify({
        ok: res.success === true,
        name: proj.meta ? proj.meta.name : '',
        entities: Object.keys(proj.entities || {}).length,
        nodes: st.nodes.length,
        source: st.canvasSource,
      });
    })()""" % APP), '新建空项目')
    if not created.get('ok'):
        return False, f'前置失败：无法新建空项目 {created}'
    if created.get('entities', 0) != 0 or created.get('nodes', 0) != 0:
        return False, f'前置假设不成立：新项目应当是空的 {created}'

    # 世界视图空态 + 导入入口
    ws = _j(cdp.eval("""(() => {
      const b = document.querySelector('[data-testid="import-from-vault-empty"]');
      const r = b ? b.getBoundingClientRect() : null;
      return JSON.stringify({
        exists: !!b,
        text: b ? (b.textContent || '').trim() : '',
        inViewport: r ? (r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth) : false,
        emptyState: !!document.querySelector('.empty-state'),
      });
    })()"""), '世界视图空态导入入口')
    if not ws.get('exists'):
        return False, ('空项目下世界视图没有「导入知识库内容」入口 —— '
                       '这正是用户卡住的地方（"项目里空空的"，只有一条被拒绝的重新提取）')
    if '导入' not in (ws.get('text') or ''):
        return False, f'入口文案没说清是导入：{ws.get("text")!r}'
    if not ws.get('inViewport'):
        return False, '「导入知识库内容」按钮不在视口内（看不见等于没有）'

    # ── b) 点它 → 真的导入（实体进项目 + 节点上画布） ─────────────────────────
    before = _j(cdp.eval("""(async () => {
      const app = %s;
      const pinia = app.config.globalProperties.$pinia;
      const M = await import('/src/store/projectStore.js');
      const proj = M.useProjectStore(pinia);
      return JSON.stringify({ entities: Object.keys(proj.entities || {}).length, historyLen: 0 });
    })()""" % APP), '导入前计数')
    cdp.eval("document.querySelector('[data-testid=\"import-from-vault-empty\"]').click()")
    time.sleep(1.6)
    after = _j(cdp.eval("""(async () => {
      const app = %s;
      const pinia = app.config.globalProperties.$pinia;
      const M = await import('/src/store/projectStore.js');
      const proj = M.useProjectStore(pinia);
      const st = app._instance.setupState.store;
      return JSON.stringify({
        entities: Object.keys(proj.entities || {}).length,
        nodes: st.nodes.length,
        source: st.canvasSource,
        dirty: proj.dirty,
        status: (document.querySelector('.status') || {}).textContent || '',
      });
    })()""" % APP), '导入后计数')
    if after.get('entities', 0) <= before.get('entities', 0):
        return False, f'点了「导入知识库内容」但项目实体没有增加：{before} → {after}'
    if after.get('nodes', 0) != after.get('entities', 0):
        return False, (f'导入后画布节点数与项目实体数不一致（导入没有落到画布上）：'
                       f'entities={after.get("entities")} nodes={after.get("nodes")}')
    if '导入' not in (after.get('status') or ''):
        return False, f'导入后没有可见回音：{after.get("status")!r}'

    # ── c) 一条 undo 撤销整个导入 ─────────────────────────────────────────────
    undone = _j(cdp.eval("""(async () => {
      const app = %s;
      const pinia = app.config.globalProperties.$pinia;
      const M = await import('/src/store/projectStore.js');
      const proj = M.useProjectStore(pinia);
      const st = app._instance.setupState.store;
      st.undo();
      await new Promise(r => setTimeout(r, 300));
      return JSON.stringify({ entities: Object.keys(proj.entities || {}).length, nodes: st.nodes.length });
    })()""" % APP), '撤销导入')
    if undone.get('entities', 0) != before.get('entities', 0) or undone.get('nodes', 0) != before.get('nodes', 0):
        return False, f'一次 undo 没有还原整个导入：{after} → {undone}'
    # 再导入回来（后续步骤要用有内容的项目）
    cdp.eval("""(async () => {
      const app = %s;
      const pinia = app.config.globalProperties.$pinia;
      const M = await import('/src/store/projectStore.js');
      const proj = M.useProjectStore(pinia);
      await proj.importFromVault();
      return 'ok';
    })()""" % APP)
    time.sleep(1.2)

    # ── c2) 不覆盖：项目里已有的实体在重复导入后保持原样 ───────────────────────
    keep = _j(cdp.eval("""(async () => {
      const app = %s;
      const pinia = app.config.globalProperties.$pinia;
      const M = await import('/src/store/projectStore.js');
      const proj = M.useProjectStore(pinia);
      const first = Object.keys(proj.entities)[0];
      proj.renameEntity(first, '我改过的名字');
      await new Promise(r => setTimeout(r, 200));
      const again = await proj.importFromVault();
      await new Promise(r => setTimeout(r, 400));
      const e = proj.getEntity(first);
      return JSON.stringify({ merged: again.merged || null, nothingNew: !!again.nothingNew, name: e ? e.name : null });
    })()""" % APP), '重复导入不覆盖')
    if keep.get('name') != '我改过的名字':
        return False, f'重复导入把项目里已有实体覆盖了（应只补缺）：{keep}'

    # ── d) 面板存在 + 说明文案 + 暗色/亮色可读性 ──────────────────────────────
    if not _open_project_panel(cdp):
        return False, '打不开项目面板'
    time.sleep(0.6)
    panel = _j(cdp.eval("""(() => {
      const b = document.querySelector('.project-panel [data-testid="import-from-vault"]');
      const hint = document.querySelector('.project-panel [data-testid="import-hint"]');
      return JSON.stringify({
        hasBtn: !!b,
        btnText: b ? (b.textContent || '').trim() : '',
        disabled: b ? !!b.disabled : null,
        hint: hint ? (hint.textContent || '').trim() : '',
      });
    })()"""), '面板导入按钮')
    if not panel.get('hasBtn'):
        return False, '项目面板没有「导入知识库内容」按钮（用户找不到入口的地方之一）'
    if panel.get('disabled') is not False:
        return False, f'面板里「导入知识库内容」按钮不可用（有留底时应当可用）：{panel}'
    if '导入' not in (panel.get('hint') or '') or '撤销' not in (panel.get('hint') or ''):
        return False, f'面板缺少说明（能导入多少 / 可撤销）：{panel.get("hint")!r}'

    # ── d2) 面板文字可读性（用户实测「面板部分文本在暗色模式背景下难以阅读」）────────
    # 判据：逐层合成背景 + WCAG 比值（skill §122 同款手法）；小字 ≥4.5 / 大字 ≥3.0
    # 覆盖本轮改动过的两个面板（同步面板 / 项目面板），两套主题各测一遍。
    PANELS = (('git-sync', '.git-sync-panel', '同步面板'), ('project', '.project-panel', '项目面板'))
    # ⚠️ panelsStore 同一时刻只开一个面板（openPanelId 单值）→ 必须逐个开、逐个测
    OPEN_JS = """(() => { %s._instance.setupState.panelsStore.open('__PID__'); return 'ok'; })()"""
    THEME_JS = """(() => {
      const app = %s;
      const s = app._instance.setupState;
      s.currentTheme = '__T__';           // useTheme() 的 ref，proxyRefs 赋值即写 .value
      return 'set:' + s.currentTheme;
    })()"""
    results = {}
    for theme in ('dark', 'light'):
        set_theme = cdp.eval(THEME_JS.replace('__T__', theme) % APP)
        time.sleep(0.5)
        got = cdp.eval("%s._instance.setupState.currentTheme" % APP)
        if got != theme:
            return False, f'前置失败：切不到 {theme} 主题（实际 {got}，{set_theme}）'
        results[theme] = {}
        for pid, sel, label in PANELS:
            cdp.eval(OPEN_JS.replace('__PID__', pid) % APP)
            time.sleep(0.6)
            if not cdp.eval("!!document.querySelector(%s)" % json.dumps(sel)):
                return False, f'{theme} 主题下 {label} 没渲染出来（选择器 {sel}）'
            probe = _contrast(cdp, sel)
            if probe.get('err'):
                return False, f'{theme} 主题下 {label} 对比度探针失败：{probe}'
            results[theme][label] = probe
            if probe.get('bad'):
                worst = sorted(probe['bad'], key=lambda x: x['ratio'])[:3]
                return False, (f'{theme} 主题下 {label} 有文字达不到对比度底线'
                               f'（用户实测"难以阅读"）：{json.dumps(worst, ensure_ascii=False)}'
                               f'｜该面板最低 {probe.get("min")} / 探针 {probe.get("checked")} 处')
            if probe.get('checked', 0) < 3:
                return False, f'{theme} 主题下 {label} 探针只检查到 {probe.get("checked")} 处文字（渲染不完整？）'
    cdp.eval(THEME_JS.replace('__T__', 'dark') % APP)   # 还原成暗色（默认）

    # ── e) 静态接线 ──────────────────────────────────────────────────────────
    def read(rel):
        with open(os.path.join(ROOT, rel), 'r', encoding='utf-8') as f:
            return f.read()

    static = []
    bridge = read('src/renderer/src/store/canvasBridge.js')
    store = read('src/renderer/src/store/projectStore.js')
    app_src = read('src/renderer/src/App.vue')
    panel_src = read('src/renderer/src/components/ProjectPanel.vue')
    geo = read('src/renderer/src/store/geodata.js')
    if 'setImportHandler' not in bridge or 'importFromVault' not in bridge:
        static.append('canvasBridge 缺少导入注册口（第 4 条）')
    if 'setImportHandler(importFromVault)' not in store:
        static.append('projectStore 未注册导入实现')
    if 'exportVaultPayload' not in geo:
        static.append('geodata 未提供知识库载荷（exportVaultPayload）')
    import re as _re
    # ⚠️ 只认 import 语句，不要用 'projectStore' 子串判断 —— 注释里出现同名会误报（本次真踩：
    #    App.vue 里那句「不 import projectStore」的说明文字把子串判据打红了）
    if _re.search(r"from\s+['\"][^'\"]*projectStore['\"]", app_src):
        static.append('App.vue 直接 import 了 projectStore（应只走 canvasBridge 注册表）')
    if _re.search(r"from\s+['\"][^'\"]*geodata['\"]", panel_src):
        static.append('ProjectPanel 直接 import 了 geodata（应只走 canvasBridge）')
    if static:
        return False, '导入链路接线不完整：' + '；'.join(static)

    def _mins(theme):
        return ', '.join(f'{k} {v.get("min")}' for k, v in results[theme].items())
    dark = {'min': min(v.get('min', 99) for v in results['dark'].values())}
    light = {'min': min(v.get('min', 99) for v in results['light'].values())}
    return True, (f'导入知识库内容链路通过：空项目 → 世界视图空态有入口（可点、在视口内）→ 导入后 '
                  f'{after["entities"]} 个实体全部落到画布（nodes 一致）→ 一次 undo 整体还原 → 重复导入只补缺'
                  f'（改过的名字没被覆盖）；项目面板有按钮 + 说明；面板文字对比度 暗色 [{_mins("dark")}] / '
                  f'亮色 [{_mins("light")}] 全部达标（WCAG 小字 4.5）；'
                  f'静态接线（canvasBridge 第 4 注册口 / App 不引 projectStore / 面板不引 geodata）齐备')
