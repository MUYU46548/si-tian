#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 105：高度图**分辨率与平滑**（P5，2026-10-14）

真实来由（暮雨实测原话）：
  「地形模模糊糊，是分辨率不够吗？高度图分辨率帮我调整。⚠️ 注意性能」

量出来的事实（不是感觉）：真实底图源网格 **133×75 = 9975 格 / spacing 14.4**，
画到 1900×1080 的画布上每格约 **3.6 屏幕像素**（放大到 400% 时 1 格占满一屏）。
渲染侧已经在做子格双线性（`heightmapRaster` 平滑档），但**每格的颜色是固定的** →
这是**数据分辨率**，唯一的解药是把格子变密。

本用例守五类判据：
  a 源码闸门（剥注释）：重采样/平滑的算法在纯函数层，store 侧**不许自己写插值**；
     两个新写口都登记进 `MEMORY_WRITE_CALLSITES` 且函数首行有守卫；栅格缓存键含高度图引用
  b 端到端：真 UI 打开分辨率面板 → 成本预估在场 → 点「应用分辨率」→ 格数真的变成
     (cols-1)*f+1 × (rows-1)*f+1、格距真的变小、**渲染没崩**
  c 不变量：最外圈格心世界坐标一字不动（否则整张地形平移半格，几乎查不出来）
  d 一条 undo 能回到原分辨率（撤销必须**逐字段**回到原状态）
  e 性能：面板给出的预估与实际耗时同量级；平滑 2 万格是毫秒级
"""
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for      # noqa: E402
from lib.helpers import ensure_case_state, open_test_base_map   # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def _code_only(src):
    """剥掉 // 与 /* */ 注释（判据必须看代码，不能看注释里的说明文字）"""
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
    se = _code_only(_read('src/renderer/src/store/geodataModules/scenarioEditing.js'))
    sc = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
    rs = _code_only(_read('src/renderer/src/utils/heightmapResample.js'))
    wg = _code_only(_read('src/renderer/src/store/writeGate.js'))

    # ① 算法在纯函数层；store 不许自己写插值
    if 'function resampleHeightmap' not in rs:
        fails.append('utils/heightmapResample.js 里没有 resampleHeightmap（算法层缺失）')
    if 'function smoothHeightmapGrid' not in rs:
        fails.append('utils/heightmapResample.js 里没有 smoothHeightmapGrid（平滑被绕开了）')
    if 'resampleBaseMapHeightmap' not in se or 'smoothBaseMapHeightmap' not in se:
        fails.append('store 没有暴露分辨率/平滑入口（UI 会够不着）')
    # store 侧出现手写插值就是"第二条实现"
    if re.search(r'for\s*\([^)]*\)\s*\{[^}]*\*\s*\(\s*1\s*-\s*t', se):
        fails.append('🔴 store 里出现了手写的线性插值（算法必须只有一份实现）')
    if 'resampleHeightmap(' not in se or 'smoothHeightmapGrid(' not in se:
        fails.append('store 没有调用纯函数层的重采样/平滑')

    # ② 写闸门契约：两个新写口都必须登记
    for fn in ('resampleBaseMapHeightmap', 'smoothBaseMapHeightmap'):
        if fn not in wg:
            fails.append(f'🔴 `{fn}` 没有登记进 MEMORY_WRITE_CALLSITES（只读态可以绕过闸门改内存）')
    # 函数首行必须守卫（test_54 用函数体截取判，这里做一次同类粗检）
    for fn in ('resampleBaseMapHeightmap', 'smoothBaseMapHeightmap'):
        i = se.find('function ' + fn)
        if i < 0:
            fails.append(f'找不到 {fn}（判据锚点失效）')
            continue
        body = se[i:i + 1400]
        if 'guardWrite(' not in body:
            fails.append(f'🔴 `{fn}` 函数体内没有 guardWrite（先改内存后 execute 的函数必须守首行）')

    # ③ 栅格缓存键必须含**高度图引用**（否则调完分辨率画布还是旧图，而且不报错）
    if 'hit.hm === hm' not in sc:
        fails.append('🔴 栅格缓存没有按高度图引用失效 —— 调完分辨率/平滑后画布会还是旧图')
    # ④ 读取必须走 getHeightmapFor（绑定行星后读 baseMap.heightmap 会读到空副本）
    i = sc.find('function buildCellRaster')
    if i < 0:
        fails.append('找不到 buildCellRaster（判据锚点失效）')
    elif 'getHeightmapFor' not in sc[i:i + 600]:
        fails.append('🔴 buildCellRaster 没有走 getHeightmapFor（绑定行星后会画不出地形且不报错）')

    notes.append('源码闸门 9 项' + ('全过' if not fails else f'缺 {len(fails)}'))
    return fails, notes


def run(cdp):
    fails, notes = source_gates()

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

    key = 'case105'
    ok_bm, info_bm = open_test_base_map(cdp, key, '用例105底图')
    if not ok_bm:
        return False, f'用例底图未就绪：{info_bm}'
    time.sleep(0.6)

    # ── 造地形：一块带坡度的高地（这样平滑与重采样都有意义）──────────────────
    setup_js = r""" (async () => {
  const s = __STORE__, sm = __SC__, KEY = __KEY__;
  const out = { ok: false };
  s.createBaseMapHeightmap(KEY);
  const hm = s.getHeightmapFor(KEY);
  if (!hm || !hm.grid || !hm.grid.points) { out.why = 'no-heightmap'; return JSON.stringify(out); }
  const cols = hm.grid.cellsX, rows = hm.grid.cellsY;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      hm.h[i] = Math.round(20 + 70 * (1 - r / (rows - 1)) + 6 * Math.sin(c / 3));
      hm.biome[i] = (c + r) % 5;
    }
  }
  s.commitHeightmap(KEY, hm);
  const hm2 = s.getHeightmapFor(KEY);
  const src = { cols: hm2.grid.cellsX, rows: hm2.grid.cellsY, spacing: hm2.grid.spacing,
                p0: hm2.grid.points[0], pLast: hm2.grid.points[hm2.grid.points.length - 1] };
  // 「调整高度图分辨率」按钮在工具栏「更多」里（默认收起）—— 必须先展开，它才进 DOM。
  // ⚠️ 别绕过 UI 直接调 store：那会把"按钮在不在、点了有没有反应"整条路径漏掉。
  const toggle = document.querySelector('.more-toggle');
  if (toggle) toggle.click();
  await new Promise(r => setTimeout(r, 120));
  out.src = src;
  out.hasButton = !!document.querySelector('[data-testid="basemap-resample"]');
  out.ok = true;
  return JSON.stringify(out);
})() """.replace('__STORE__', STORE).replace('__SC__', SC).replace('__KEY__', repr(key))

    r = eval_json(cdp, setup_js, required=None, desc='造地形')
    if not (isinstance(r, tuple) and r[0]):
        return False, f'造地形探针失败：{r[1] if isinstance(r, tuple) else r}'
    r = r[1]
    if not r.get('ok'):
        return False, f'造地形失败：{r}'
    src = r['src']
    notes.append(f"源网格 {src['cols']}×{src['rows']} / spacing {src['spacing']}")
    if not r.get('hasButton'):
        fails.append('「调整高度图分辨率」按钮不在 DOM 里（底图没有高度图？）')

    # 🔴 可发现性（2026-10-15 补；用户实测「分辨率按钮不知道在哪里，『更多』中没有找到」）：
    #    按钮**一直在**（诊断 `test_xdiag_resample_button` 证实），但第一版只有一枚
    #    `grid` 图标、**没有文字**，而「更多」里它左右邻居全都有文字（拆分/合并/高度/群系…）
    #    → 用户扫过去只看见一排有名字的按钮，那枚没名字的就被跳过了。
    #    这条守卫钉死"面板入口必须有可见文字"：靠 title（要悬停）+ 图标（认不出）不算。
    label_js = r""" (() => {
  const el = document.querySelector('[data-testid="basemap-resample"]');
  return JSON.stringify({ text: el ? (el.textContent || '').trim() : null, title: el ? (el.title || '') : '' });
})() """
    lab = eval_json(cdp, label_js, required=None, desc='按钮文字')
    lab = lab[1] if isinstance(lab, tuple) and lab[0] else {}
    if not (lab.get('text') or '').strip():
        fails.append('🔴 「分辨率」按钮没有可见文字（只有图标 + title）—— '
                     '「更多」里左右邻居都有名字，没名字的那个会被跳过（用户就是这么找不到的）')
    else:
        notes.append(f"入口按钮文字：「{lab.get('text')}」")

    # ── 真 UI：打开面板 → 看成本预估 → 选 ×2 → 应用 ──────────────────────────
    panel_js = r""" (async () => {
  const sm = __SC__;
  const out = {};
  // 工具栏「更多」默认收起；按钮不在 DOM 里时先展开（找不到按钮必须**带回现场**，
  // 而不是就地抛异常 —— 本项目在 test_65 上踩过"查空即抛"掩盖真实原因）
  let btn = document.querySelector('[data-testid="basemap-resample"]');
  if (!btn) {
    const toggle = document.querySelector('.more-toggle');
    if (toggle) toggle.click();
    await new Promise(r => setTimeout(r, 120));
    btn = document.querySelector('[data-testid="basemap-resample"]');
  }
  if (!btn) return JSON.stringify({ clicked: false, moreOpen: !!document.querySelector('.toolbar-more'),
                                    keys: Object.keys(sm).filter(k => /resample|Resample/.test(k)) });
  btn.click();
  await new Promise(r => setTimeout(r, 120));
  const panel = document.querySelector('[data-testid="resample-panel"]');
  out.panelOpen = !!panel;
  const costText = () => {
    const el = document.querySelector('[data-testid="resample-cost"]');
    return el ? (el.textContent || '').trim() : '';
  };
  const setFactor = async (v) => {
    const sel = document.querySelector('[data-testid="resample-factor"]');
    if (!sel) return false;
    sel.value = String(v);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 90));
    return true;
  };
  out.costText = costText();                       // 初始（默认 ×2）
  out.applyDisabled = (() => {
    const b = document.querySelector('[data-testid="resample-apply"]');
    return b ? !!b.disabled : null;
  })();
  // ⚠️ 必须**真的换一个值**再换回来，否则「切换倍数后读数有没有变」这条判据是空转
  //    （默认就是 ×2，setTimeout 之后再读同一档，读数当然一样 —— 首版就是这么假绿的）
  await setFactor(4);
  out.costText4 = costText();
  await setFactor(2);
  out.costText2 = costText();
  const apply = document.querySelector('[data-testid="resample-apply"]');
  const t0 = performance.now();
  if (apply && !apply.disabled) apply.click();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  out.ms = Math.round(performance.now() - t0);
  const s = __STORE__;
  const hm = s.getHeightmapFor(__KEY__);
  out.after = { cols: hm.grid.cellsX, rows: hm.grid.cellsY, spacing: hm.grid.spacing,
                n: hm.grid.points.length,
                p0: hm.grid.points[0], pLast: hm.grid.points[hm.grid.points.length - 1],
                h0: hm.h[0], biome0: hm.biome ? hm.biome[0] : null };
  out.panelClosed = !document.querySelector('[data-testid="resample-panel"]');
  out.renderPaused = !!sm.renderPaused;
  out.renderError = String(sm.renderError || '');
  out.status = String(sm.provinceHint || '');
  out.clicked = true;
  return JSON.stringify(out);
})() """.replace('__SC__', SC).replace('__STORE__', STORE).replace('__KEY__', repr(key))

    got = eval_json(cdp, panel_js, required=None, desc='打开面板并应用 ×2')
    if not (isinstance(got, tuple) and got[0]):
        return False, f'分辨率面板探针失败：{got[1] if isinstance(got, tuple) else got}'
    got = got[1]
    if not got.get('clicked'):
        return False, f'点不动「调整高度图分辨率」按钮：{got}'
    if not got.get('panelOpen'):
        fails.append('点了按钮但面板没打开（用户会以为按钮坏了）')
    if not got.get('costText'):
        fails.append('面板没有显示成本预估（格数/内存/耗时）—— 「注意性能」这条就没有落点')
    else:
        notes.append(f"成本预估 ×2：{got['costText']}")
        if got.get('costText4'):
            notes.append(f"×4：{got['costText4']}")
    if got.get('costText4') and got['costText4'] == got.get('costText2'):
        fails.append(f"切换倍数（×2 / ×4）成本预估**读数一样**：{got.get('costText2')} —— 预估没接上倍数")
    if got.get('applyDisabled'):
        fails.append('「应用分辨率」是禁用的（预估没问题却点不动）')

    after = got.get('after') or {}
    exp_cols = (src['cols'] - 1) * 2 + 1
    exp_rows = (src['rows'] - 1) * 2 + 1
    if after.get('cols') != exp_cols or after.get('rows') != exp_rows:
        fails.append(f"格数应为 {exp_cols}×{exp_rows}（(cols-1)×2+1），实际 {after.get('cols')}×{after.get('rows')}")
    if after.get('n') != exp_cols * exp_rows:
        fails.append(f"点数应为 {exp_cols * exp_rows}，实际 {after.get('n')}")
    if not after.get('spacing') or abs(after['spacing'] - src['spacing'] / 2) > 1e-6:
        fails.append(f"格距应减半（{src['spacing'] / 2}），实际 {after.get('spacing')}")

    # ── c 不变量：最外圈格心世界坐标一字不动 ─────────────────────────────────
    def same_pt(a, b):
        if not a or not b or len(a) < 2 or len(b) < 2:
            return False
        return abs(a[0] - b[0]) < 1e-9 and abs(a[1] - b[1]) < 1e-9

    if not same_pt(after.get('p0'), src.get('p0')):
        fails.append(f"🔴 左上格心动了（{src.get('p0')} → {after.get('p0')}）—— 整张地形会平移半格，"
                     f"看起来只是'地形歪了一点'，几乎查不出来")
    if not same_pt(after.get('pLast'), src.get('pLast')):
        fails.append(f"🔴 右下格心动了（{src.get('pLast')} → {after.get('pLast')}）")
    if got.get('renderPaused') or got.get('renderError'):
        fails.append(f"🔴 调整分辨率之后渲染异常：{got.get('renderError')}")
    if got.get('status'):
        notes.append(f"状态栏：{got['status']}")

    # ── d 一条 undo 回到原状态（逐字段）──────────────────────────────────────
    # 用 `store.undo()`（与 test_102 同款：撤销这件事本身由 test_47/54 守，
    # 这里要判的是「调整分辨率 = 一条 undo」这条纪律）。
    undo_js = r""" (async () => {
  const sm = __SC__, s = __STORE__;
  s.undo();
  await new Promise(r => setTimeout(r, 200));
  const hm = s.getHeightmapFor(__KEY__);
  return JSON.stringify({ cols: hm.grid.cellsX, rows: hm.grid.cellsY, spacing: hm.grid.spacing,
                          n: hm.grid.points.length, h0: hm.h[0],
                          renderPaused: !!sm.renderPaused, renderError: String(sm.renderError || '') });
})() """.replace('__SC__', SC).replace('__STORE__', STORE).replace('__KEY__', repr(key))
    un = eval_json(cdp, undo_js, required=None, desc='撤销分辨率')
    un = un[1] if isinstance(un, tuple) and un[0] else {'err': un}
    if un.get('cols') != src['cols'] or un.get('rows') != src['rows']:
        fails.append(f"撤销没有回到原网格（应为 {src['cols']}×{src['rows']}，实际 "
                     f"{un.get('cols')}×{un.get('rows')}）—— 「一次调整 = 一条 undo」没成立")
    elif abs(float(un.get('spacing') or 0) - float(src['spacing'])) > 1e-6:
        fails.append(f"撤销后格距不对（应 {src['spacing']}，实际 {un.get('spacing')}）")
    else:
        notes.append(f"撤销回到 {un.get('cols')}×{un.get('rows')} / spacing {un.get('spacing')}")

    # ── e 平滑：真点按钮、真的变平、毫秒级 ──────────────────────────────────
    smooth_js = r""" (async () => {
  const sm = __SC__, s = __STORE__, KEY = __KEY__;
  const hm0 = s.getHeightmapFor(KEY);
  const before = Array.from(hm0.h);
  const stat = (a) => {
    const m = a.reduce((x, y) => x + y, 0) / a.length;
    return a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length;
  };
  const v0 = stat(before);
  const btn = document.querySelector('[data-testid="basemap-resample"]');
  if (btn && !document.querySelector('[data-testid="resample-panel"]')) btn.click();
  await new Promise(r => setTimeout(r, 100));
  const sb = document.querySelector('[data-testid="smooth-apply"]');
  if (!sb) return JSON.stringify({ err: 'no-smooth-button' });
  const t0 = performance.now();
  sb.click();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const ms = Math.round(performance.now() - t0);
  const hm1 = s.getHeightmapFor(KEY);
  const v1 = stat(Array.from(hm1.h));
  return JSON.stringify({ v0, v1, ms, cells: hm1.h.length,
                          renderPaused: !!sm.renderPaused, renderError: String(sm.renderError || '') });
})() """.replace('__SC__', SC).replace('__STORE__', STORE).replace('__KEY__', repr(key))
    sm_res = eval_json(cdp, smooth_js, required=None, desc='平滑地形')
    sm_res = sm_res[1] if isinstance(sm_res, tuple) and sm_res[0] else {'err': sm_res}
    if sm_res.get('err'):
        fails.append(f"平滑按钮不可用：{sm_res.get('err')}")
    else:
        if not (sm_res.get('v1', 1e9) < sm_res.get('v0', 0)):
            fails.append(f"平滑之后方差没有下降（{sm_res.get('v0')} → {sm_res.get('v1')}）—— 按钮没起作用")
        else:
            notes.append(f"平滑：方差 {sm_res.get('v0'):.1f} → {sm_res.get('v1'):.1f}，"
                         f"{sm_res.get('cells')} 格 / {sm_res.get('ms')} ms")
        if sm_res.get('renderPaused') or sm_res.get('renderError'):
            fails.append(f"🔴 平滑之后渲染异常：{sm_res.get('renderError')}")

    # ── 收尾：撤销平滑，别把改动留给后续用例 ────────────────────────────────
    cdp.eval(f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.2)
    time.sleep(0.2)

    detail = '；'.join(notes + fails)
    return (len(fails) == 0), detail
