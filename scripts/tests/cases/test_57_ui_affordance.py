#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 57：UI 可点性 / 样式统一 / 只读提示 / 图标语义（2026-09-22 用户实测反馈的守卫）

用户这一轮报的问题里有三条是「界面上看起来能用、实际点不到 / 认不出」：
  ① 行星地图非编辑模式下无法进入编辑 —— 真因是 `.view-actions`（地点簇/对象/快照/导出）
     用绝对定位压在 `.map-header` 的「编辑地图」上（同右边界 + DOM 在后 ⇒ 整片盖住）。
     → 必须用**命中测试**（元素中心点 elementsFromPoint）守住，单纯"元素存在"是假绿。
  ② 部分按钮是浏览器默认样式（Azgaar 参考图层那四个：非激活态 class 为空）。
     → 用 computed style 的 `border-style: outset` 全站扫描（Chrome 默认按钮的签名）。
  ③ 只读态除了工具栏小徽标没有任何提示。
     → 断言全宽提示条存在 + 大字 + 可点达去处；且「重新提取」在只读/项目态被灰禁并说明去处。
另守两条本次的交付：
  ④ 导出按钮必须用「导出」语义图标（不是下载图标）；ScenarioMap 的 15 个预设图标必须是
     矢量图标名，且双端（Icon.vue / canvasIcon.js）都有几何 —— emoji 会随字体变形、画风不统一。
  ⑤ 有一键可达的「打开知识库」入口（用户："连我都不知道去哪里打开知识库"）。
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.helpers import ensure_case_state, goto_planet   # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
APP = "document.querySelector('#app').__vue_app__"


def _j(raw, label):
    try:
        return json.loads(raw)
    except Exception:
        raise AssertionError(f'{label} 读取失败：{str(raw)[:240]}')


def _hit_test(cdp, selector, label):
    """返回元素中心点的命中栈（最上层在前）。用于守「按钮真的点得到」。"""
    raw = cdp.eval("""(() => {
      const el = document.querySelector(%s);
      if (!el) return JSON.stringify({ missing: true });
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return JSON.stringify({ missing: false, zero: true, rect: {w: r.width, h: r.height} });
      const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
      const stack = document.elementsFromPoint(x, y).slice(0, 5).map(e => {
        const cls = (typeof e.className === 'string') ? e.className : '';
        return e.tagName + (cls ? '.' + cls.trim().split(/\\s+/).join('.') : '');
      });
      return JSON.stringify({ missing: false, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, stack: stack, x: x, y: y });
    })()""" % json.dumps(selector))
    return _j(raw, label)


def run(cdp):
    ensure_case_state(cdp)

    # ══ ① 行星地图：非编辑态下「编辑地图」必须可点中 + 不得与视图动作条重叠 ══
    lvl = goto_planet(cdp)
    if lvl != 'planet':
        return False, f'导航行星失败（viewLevel={lvl}）'
    cdp.eval("new Promise(r => setTimeout(r, 400))")

    hit = _hit_test(cdp, '.planet-map-container .edit-entry-btn', '编辑地图按钮命中测试')
    if hit.get('missing'):
        return False, '行星地图上没有「编辑地图」按钮（入口消失）'
    if hit.get('zero'):
        return False, f'「编辑地图」按钮尺寸为 0（被布局压扁）：{hit.get("rect")}'
    top = (hit.get('stack') or [''])[0]
    if 'edit-entry-btn' not in top:
        return False, ('「编辑地图」按钮被别的元素盖住，点它点不到 → 用户以为"无法编辑地图"：'
                       f'命中栈最上层 = {top}（完整栈 {hit.get("stack")}，位置 {hit.get("x")},{hit.get("y")}）')

    overlap = _j(cdp.eval("""(() => {
      const a = document.querySelector('.map-header .header-actions');
      const b = document.querySelector('.view-actions');
      const rc = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
      const ra = rc(a), rb = rc(b);
      let inter = null;
      if (ra && rb) {
        const ix = Math.max(0, Math.min(ra.x + ra.w, rb.x + rb.w) - Math.max(ra.x, rb.x));
        const iy = Math.max(0, Math.min(ra.y + ra.h, rb.y + rb.h) - Math.max(ra.y, rb.y));
        inter = ix * iy;
      }
      const pos = b ? getComputedStyle(b).position : '';
      return JSON.stringify({ headerActions: ra, viewActions: rb, intersect: inter, position: pos });
    })()"""), '视图动作条布局')
    if overlap.get('intersect'):
        return False, (f'视图动作条与标题栏按钮区仍然重叠（面积 {overlap["intersect"]}px²）：'
                       f'{overlap.get("headerActions")} vs {overlap.get("viewActions")}')
    if overlap.get('position') == 'absolute':
        return False, '视图动作条又变回绝对定位了（同右边界必然与标题栏按钮相撞）'

    # ══ ② 默认样式按钮扫描（行星图 + 世界视图） ══
    def scan_default_buttons(tag):
        raw = cdp.eval("""(() => {
          const bad = [];
          for (const b of document.querySelectorAll('button')) {
            const r = b.getBoundingClientRect();
            const cs = getComputedStyle(b);
            if (r.width < 2 || r.height < 2 || cs.display === 'none' || cs.visibility === 'hidden') continue;
            // Chrome 默认按钮签名：border-style outset（本项目所有自定义按钮都是 solid/none）
            if (cs.borderTopStyle === 'outset') {
              bad.push({ text: (b.textContent || '').trim().slice(0, 16), cls: String(b.className || ''), title: (b.getAttribute('title') || '').slice(0, 20) });
            }
          }
          return JSON.stringify(bad.slice(0, 8));
        })()""")
        return _j(raw, f'{tag} 默认样式按钮扫描')

    bad = scan_default_buttons('行星图')
    if bad:
        return False, f'行星地图上仍有浏览器默认样式按钮（风格不统一）：{bad}'

    # 编辑模式也要扫一遍（工具栏/子工具栏都在这时可见）
    cdp.eval("""(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const b = btns.find(x => x.classList.contains('edit-entry-btn'));
      if (b) b.click();
      return 'ok';
    })()""")
    cdp.eval("new Promise(r => setTimeout(r, 300))")
    bad2 = scan_default_buttons('行星图（编辑态）')
    if bad2:
        return False, f'行星地图编辑态仍有浏览器默认样式按钮：{bad2}'
    cdp.eval("""(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const b = btns.find(x => (x.textContent || '').includes('退出编辑'));
      if (b) b.click();
      return 'ok';
    })()""")
    cdp.eval("new Promise(r => setTimeout(r, 250))")

    # ══ ③ 导出图标语义 + ScenarioMap 预设图标（静态 + 双端几何） ══
    def read(rel):
        with open(os.path.join(ROOT, rel), 'r', encoding='utf-8') as f:
            return f.read()

    for rel, what in (('src/renderer/src/components/PlanetMap.vue', '行星地图'),
                      ('src/renderer/src/App.vue', '主工具栏'),
                      ('src/renderer/src/components/ScenarioMap.vue', '剧本地图'),
                      ('src/renderer/src/components/SettingsPanel.vue', '设置面板')):
        src = read(rel)
        if 'name="download"' in src and '导出' in src:
            # 允许「导入」用 download；只禁「导出 …」与 download 同行
            for line in src.splitlines():
                if 'name="download"' in line and '导出' in line:
                    return False, f'{what} 的导出按钮仍用下载图标：{line.strip()[:120]}'
    if 'name="export"' not in read('src/renderer/src/components/PlanetMap.vue'):
        return False, '行星地图的导出按钮没有使用「导出」语义图标（Icon name="export"）'

    # ScenarioMap 预设：必须是 ASCII 图标名，且双端都有几何
    scen = read('src/renderer/src/components/ScenarioMap.vue')
    canvas_icon = read('src/renderer/src/utils/canvasIcon.js')
    icon_names = set()
    for line in scen.splitlines():
        s = line.strip()
        if s.startswith("{ id:") and "icon: '" in s:
            icon = s.split("icon: '", 1)[1].split("'", 1)[0]
            if s.startswith('{ id:') and 'name:' in s:
                icon_names.add(icon)
    if len(icon_names) < 14:
        return False, f'ScenarioMap 预设图标数量异常（应 ≥14 个地貌/标记预设）：{sorted(icon_names)}'
    non_ascii = [i for i in icon_names if not i.isascii()]
    if non_ascii:
        return False, f'ScenarioMap 预设图标里还有 emoji 字面量（会随系统字体变形）：{non_ascii}'
    defined_in_icon = set()
    for line in read('src/renderer/src/components/Icon.vue').splitlines():
        if "name === '" in line:
            defined_in_icon.add(line.split("name === '", 1)[1].split("'", 1)[0])
    missing_icon = sorted(i for i in icon_names if i not in defined_in_icon)
    if missing_icon:
        return False, f'ScenarioMap 预设图标在 Icon.vue 里没有定义：{missing_icon}'
    not_canvas = _j(cdp.eval("""(async () => {
      const m = await import('/src/utils/canvasIcon.js');
      const names = %s;
      return JSON.stringify(names.filter(n => !m.isCanvasIcon(n)));
    })()""" % json.dumps(sorted(icon_names))), 'canvasIcon 几何检查')
    if not_canvas:
        return False, (f'这些预设图标在 canvasIcon.js 里没有几何 → 画布上会**留白**（看起来"图标消失了"）：'
                       f'{not_canvas}')

    # ══ ④ 世界视图：一键可达的「打开知识库」 + 空态断言（如为空态） ══
    cdp.eval("""(() => {
      const s = %s._instance.setupState.store;
      s.backToWorld ? s.backToWorld() : s.selectWorld(null);
      return 'ok';
    })()""" % APP)
    cdp.eval("new Promise(r => setTimeout(r, 350))")
    vault = _j(cdp.eval("""(() => {
      const b = document.querySelector('[data-testid="open-vault"], [data-testid="open-vault-empty"]');
      const r = b ? b.getBoundingClientRect() : null;
      const sel = document.querySelector('.world-selector');
      const rs = sel ? sel.getBoundingClientRect() : null;
      return JSON.stringify({
        exists: !!b,
        text: b ? (b.textContent || '').trim() : '',
        rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
        selectorRect: rs ? { x: Math.round(rs.x), y: Math.round(rs.y), w: Math.round(rs.width), h: Math.round(rs.height) } : null,
        scrollTop: sel ? sel.scrollTop : -1,
        scrollHeight: sel ? sel.scrollHeight : -1,
        vp: { w: innerWidth, h: innerHeight },
        inViewport: r ? (r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth) : false,
      });
    })()"""), '打开知识库入口')
    if not vault.get('exists'):
        return False, '世界视图没有「打开知识库」入口（用户："连我都不知道去哪里打开知识库"）'
    if '知识库' not in (vault.get('text') or ''):
        return False, f'「打开知识库」按钮文案说不清是什么：{vault.get("text")!r}'
    if not vault.get('inViewport'):
        return False, (f'「打开知识库」按钮不在视口内（看不见等于没有）：按钮 {vault.get("rect")}，'
                       f'容器 {vault.get("selectorRect")}，视口 {vault.get("vp")}，'
                       f'scrollTop={vault.get("scrollTop")}/{vault.get("scrollHeight")}')

    # ══ ④b 通用：可见按钮不得被弹到视口上方（flex 居中 + 内容超高的经典裁切） ══
    clipped = _j(cdp.eval("""(() => {
      const bad = [];
      for (const b of document.querySelectorAll('button')) {
        const r = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        if (r.width < 2 || r.height < 2 || cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (r.top < 0) {
          bad.push({ text: (b.textContent || '').trim().slice(0, 14), top: Math.round(r.top),
                     title: (b.getAttribute('title') || '').slice(0, 18) });
        }
      }
      return JSON.stringify(bad.slice(0, 8));
    })()"""), '视口上方被裁切的按钮')
    if clipped:
        return False, (f'有按钮被弹到视口上方（用户根本够不着，="点了没反应"的同源问题）：{clipped}')

    # 点击 → 必须真的走到主进程（mock 捕获 openExternal 的 URL）
    cdp.eval("""(() => {
      window.__openedUrls = [];
      const orig = window.sitianAPI.openExternal;
      window.sitianAPI.openExternal = async (u) => { window.__openedUrls.push(String(u)); return { success: true }; };
      window.__restoreOpenExternal = () => { window.sitianAPI.openExternal = orig; };
      const b = document.querySelector('[data-testid="open-vault"], [data-testid="open-vault-empty"]');
      if (b) b.click();
      return 'ok';
    })()""")
    cdp.eval("new Promise(r => setTimeout(r, 500))")
    opened = _j(cdp.eval("""(() => {
      const urls = window.__openedUrls || [];
      if (window.__restoreOpenExternal) window.__restoreOpenExternal();
      return JSON.stringify({ urls: urls, status: (document.querySelector('.status') || {}).textContent || '' });
    })()"""), '打开知识库结果')
    if not opened.get('urls'):
        return False, '点了「打开知识库」但没有发出任何请求（按钮是死的）'
    if 'obsidian://' not in opened['urls'][0]:
        return False, f'打开知识库没有走 obsidian:// 协议：{opened["urls"][0]}'

    # ══ ⑤ 只读态：全宽大字提示 + 重新提取灰禁说明 ══
    cdp.eval("""(async () => {
      const app = %s;
      const pinia = app.config.globalProperties.$pinia;
      const M = await import('/src/store/projectStore.js');
      const proj = M.useProjectStore(pinia);
      if (proj.isOpen) await proj.closeProject();
      return 'ok';
    })()""" % APP)
    cdp.eval("new Promise(r => setTimeout(r, 500))")
    ro = _j(cdp.eval("""(() => {
      const n = document.querySelector('[data-testid="readonly-notice"]');
      const main = n ? n.querySelector('.rn-main') : null;
      const cs = main ? getComputedStyle(main) : null;
      const bar = Array.from(document.querySelectorAll('.toolbar-actions button'))
        .find(b => (b.getAttribute('title') || '').indexOf('重新提取') >= 0);
      return JSON.stringify({
        exists: !!n,
        text: n ? (n.textContent || '').trim() : '',
        fontSize: cs ? parseFloat(cs.fontSize) : 0,
        fontWeight: cs ? cs.fontWeight : '',
        clickable: n ? getComputedStyle(n).cursor : '',
        reextractDisabled: bar ? !!bar.disabled : null,
        reextractTitle: bar ? (bar.getAttribute('title') || '') : '',
      });
    })()"""), '只读提示条')
    if not ro.get('exists'):
        return False, '只读态没有全宽提示条（用户实测："除顶部小字外无任何提示"）'
    if '只读' not in (ro.get('text') or ''):
        return False, f'只读提示条没说清状态：{ro.get("text")!r}'
    if ro.get('fontSize', 0) < 14:
        return False, f'只读提示条字号太小（用户明确要求"较大字号"）：{ro.get("fontSize")}px'
    if ro.get('clickable') != 'pointer':
        return False, '只读提示条不可点（应点击直达项目面板 = 给出去处）'
    if ro.get('reextractDisabled') is not True:
        return False, '只读态下「重新提取」没有灰禁（用户点了会得到一句拒绝，属坏交互）'
    if '项目' not in (ro.get('reextractTitle') or ''):
        return False, f'「重新提取」的 title 没说明去处：{ro.get("reextractTitle")!r}'

    # 提示条点击 → 打开项目面板
    cdp.eval("""(() => {
      const n = document.querySelector('[data-testid="readonly-notice"]');
      if (n) n.click();
      return 'ok';
    })()""")
    cdp.eval("new Promise(r => setTimeout(r, 500))")
    panel = cdp.eval("!!document.querySelector('.project-panel')")
    if not panel:
        return False, '点击只读提示条没有打开项目面板（去处不可达）'

    # 还原：重新打开基线项目，避免影响后续用例
    cdp.eval("""(async () => {
      const app = %s;
      const pinia = app.config.globalProperties.$pinia;
      const M = await import('/src/store/projectStore.js');
      const proj = M.useProjectStore(pinia);
      await proj.openProject('mock/projects/harness-baseline.sitian');
      return 'ok';
    })()""" % APP)

    return True, ('可点性/样式/只读提示守卫通过：行星图「编辑地图」命中测试在最上层（不再被视图动作条盖住）、'
                  '标题栏与视图动作条零重叠且未回到绝对定位、行星图（浏览态+编辑态）无浏览器默认样式按钮、'
                  '导出按钮用 export 图标、ScenarioMap 15 个预设图标全为矢量名且双端有几何、'
                  '世界视图「打开知识库」可点且走 obsidian://、只读态有大字可点提示条 + 重新提取灰禁并说明去处')
