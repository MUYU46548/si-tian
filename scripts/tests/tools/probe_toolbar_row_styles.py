#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""工具栏各行按钮的**实际算出来的样式**（真机读数，不是源码推断）

为什么要这个文件（2026-11-07）：

2026-11-06 的工具栏拆分试点把“拆分/合并/删除”那一行搬进了
`scenario/panels/toolbar/ProvinceOpsRow.vue`，当时记下的一条结论是
“子组件根节点会继承父 scope id，样式照常命中，不要再给工具栏行抄 CSS”。

那句话**只对根节点成立**。`<style scoped>` 的父 scope id 只贴在子组件的**根元素**上，
子组件内部的按钮（`.toolbar-row` 里面那层 `button`）拿不到它 —— 于是
`scenario-map.css` 里那些 `.scenario-toolbar button` / `.tool-group button` 的规则
（display / gap / padding / min-width / **height: 32px** / font-family / font-size）
一条都不会命中。表现是**按钮退化成浏览器默认样子**（矮、字号不对、间距不对），
而这种事故：

  · 源码闸门看不见（class 还在、DOM 结构没变、`test_65` 数的是可见控件数）；
  · 面板视觉演练也看不见（它只覆盖 7 块浮层，不覆盖工具栏行）；
  · 只有**真机上算一次样式**才现形。

所以本工具做一件事：进剧本视图，把 `.scenario-toolbar` 里**每一个** button
的 computedStyle 关键项与它“归属”的那一行一起记下来，落 JSON。

用法：
  python scripts/tests/tools/probe_toolbar_row_styles.py --out build/toolbar-row-styles/x.json
  python scripts/tests/tools/probe_toolbar_row_styles.py --compare A.json B.json
      # 比两次拍下来的读数：只看同一行里同一批按钮的关键项是否一致（拆前/拆后判据）

判据口径（`--compare`）：按「行 class + 按钮文字」对齐，逐项比
height / padding / font-size / font-family / display / min-width / gap / border / background /
color / border-radius。任何一个按钮的任一项变了 → 非 0 退出并点名。
"""
import base64
import json
import os
import subprocess
import sys
import time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))          # scripts/tests （给 run_tests / lib / drill_*）
sys.path.insert(0, HERE)

import run_tests as rt                                               # noqa: E402
from lib.cdp import CDP, wait_for, eval_json                         # noqa: E402
from lib.helpers import ensure_data_ready, open_harness_project      # noqa: E402
import drill_scenario_overlays_visual as ov                          # noqa: E402  （场景铺设唯一实现）

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8')
    except Exception:
        pass

# 判据项：只取“会让人一眼看出按钮走样”的那些（不是全部 computedStyle）
PROPS = ['width', 'maxWidth', 'height', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
         'fontSize', 'fontFamily', 'display', 'alignItems', 'justifyContent', 'gap',
         'minWidth', 'borderTopWidth', 'borderTopColor', 'backgroundColor', 'color',
         'borderTopLeftRadius', 'cursor', 'whiteSpace']

COLLECT_JS = """(() => {
  const root = document.querySelector('.scenario-map-container');
  if (!root) return JSON.stringify({ ok: false, why: 'no-scenario-map' });
  // ScenarioMap.vue 自己的 scope id（父组件的样式只认这一个）
  const parentScopes = Array.from(root.attributes)
    .map(a => a.name).filter(n => n.startsWith('data-v-'));
  const toolbar = document.querySelector('.scenario-toolbar');
  if (!toolbar) return JSON.stringify({ ok: false, why: 'no-toolbar' });
  const rows = (el) => {
    const out = [];
    let p = el.parentElement;
    while (p && p !== toolbar) {
      if (p.classList && p.classList.contains('toolbar-row')) out.push(p.className);
      p = p.parentElement;
    }
    return out;
  };
  const props = %s;
  const items = [];
  for (const btn of toolbar.querySelectorAll('button')) {
    const cs = getComputedStyle(btn);
    const style = {};
    for (const k of props) style[k] = cs[k];
    const r = btn.getBoundingClientRect();
    items.push({
      kind: 'button',
      row: rows(btn)[0] || '(no-row)',
      inMore: !!btn.closest('.toolbar-more'),
      text: (btn.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24),
      testid: btn.getAttribute('data-testid') || '',
      parentScopeOnButton: parentScopes.some(s => btn.hasAttribute(s)),
      box: { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 },
      style,
    });
  }
  // ⚠️ 行里不只有按钮：小标题（省份：/ 底图/地理：）、提示（.row-hint / .draw-hint）、勾选项
  //    也都是父组件 scoped 表在管。只量按钮会漏掉“标签掉色”这类事故
  //    （2026-11-07 实测：`.basemap-row-label` 的琥珀色就是这么丢的，源码闸门 m8 抓到的）。
  for (const el of toolbar.querySelectorAll('.row-label, .basemap-row-label, .river-edit-name, .row-hint, .check-label, .draw-hint, '
              + '.river-source-height, select')) {
    const cs = getComputedStyle(el);
    const style = {};
    for (const k of props) style[k] = cs[k];
    const r = el.getBoundingClientRect();
    items.push({
      kind: el.tagName.toLowerCase(),
      row: rows(el)[0] || '(no-row)',
      inMore: !!el.closest('.toolbar-more'),
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24),
      testid: el.getAttribute('data-testid') || '',
      parentScopeOnButton: parentScopes.some(s => el.hasAttribute(s)),
      box: { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 },
      style,
    });
  }
  return JSON.stringify({ ok: true, parentScopes, count: items.length, items });
})()"""


def ck(name, ok, detail=''):
    print(('  ✅ ' if ok else '  ❌ ') + name + (f' — {detail}' if detail else ''), flush=True)
    return bool(ok)


def capture(cdp, box, path):
    """整页截图 → 按元素矩形裁切（`Page.captureScreenshot` 带 clip 在本机不生效，2026-11-06 实测）。"""
    try:
        rep = cdp.send('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})
        data = (rep or {}).get('data') or ''
    except Exception:                                            # noqa: BLE001
        data = ''
    if not data:
        return False
    raw = base64.b64decode(data)
    try:
        from PIL import Image
        import io as _io
        img = Image.open(_io.BytesIO(raw))
        x = max(0, int(box.get('x') or 0))
        y = max(0, int(box.get('y') or 0))
        w = max(1, int(box.get('w') or img.size[0]))
        h = max(1, int(box.get('h') or img.size[1]))
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        img.crop((x, y, min(x + w, img.size[0]), min(y + h, img.size[1]))).save(path)
        return True
    except Exception:                                            # noqa: BLE001
        with open(path, 'wb') as f:
            f.write(raw)
        return True


def collect(out_path, want_shot=True):
    shot_dir = os.path.splitext(os.path.abspath(out_path))[0] + '-shots'
    for port in (rt.DEV_PORT, rt.CDP_PORT):
        if rt._tcp_open(port, '127.0.0.1'):
            print(f'  ❌ 端口 {port} 已被占用（先停掉正在跑的回归/演练）', flush=True)
            return 2
    rt.setup_mock()
    handles = []
    try:
        dev = subprocess.Popen(['cmd', '/c', 'npm', 'run', 'dev'], cwd=rt.ROOT,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        handles.append(rt.ProcessHandle(dev, 'dev'))
        if not rt.wait_port(rt.DEV_PORT, timeout=120):
            raise RuntimeError('Vite dev server 启动超时')
        edge = subprocess.Popen([
            rt.EDGE_EXE, '--headless=new', '--disable-gpu', '--disable-dev-shm-usage',
            '--remote-debugging-port=%d' % rt.CDP_PORT, '--remote-allow-origins=*',
            '--user-data-dir=%s' % os.path.join(rt.ROOT, '.test-edge-profile'),
            '--no-first-run', '--no-default-browser-check', '--no-sandbox', 'about:blank',
        ])
        handles.append(rt.ProcessHandle(edge, 'edge'))
        if not rt.wait_port(rt.CDP_PORT, timeout=60):
            raise RuntimeError('Edge CDP 启动超时')

        cdp = CDP()
        cdp.send('Page.enable')
        cdp.navigate()
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=90, desc='首次导航')
        rt.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate()
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=90, desc='整页加载')
        wait_for(cdp, "!document.querySelector('.onboarding-overlay')", timeout=30, desc='引导层关闭')
        ensure_data_ready(cdp, timeout=90)
        ok, info = open_harness_project(cdp)
        if not ck('harness 项目已打开', ok, json.dumps(info, ensure_ascii=False)[:60]):
            return 1

        got, res = eval_json(cdp, """(() => {
          const b = Array.from(document.querySelectorAll('button'))
            .find(x => (x.textContent || '').includes('历史剧本'));
          if (!b) return JSON.stringify({ ok: false, why: 'no-btn' });
          b.click();
          return JSON.stringify({ ok: true });
        })()""", required=('ok',), desc='进历史剧本')
        if not got or not res.get('ok'):
            ck('进入剧本视图', False, res)
            return 1
        wait_for(cdp, "!!document.querySelector('.scenario-map-container canvas')", timeout=60, desc='剧本画布')
        time.sleep(0.8)
        sc_ok, sc = eval_json(cdp, ov.SCENE_JS, required=('ok',), desc='铺场景')
        if not ck('场景已铺设', bool(sc_ok) and bool(sc.get('ok')),
                  f"省 {sc.get('provinces')} / 剧本 {sc.get('scenarios')}"):
            return 1
        time.sleep(0.6)

        # 三档状态各拍一次：日常 / 「更多」展开（拆出去的那几行都住在这里）/ 底图编辑行
        # ⚠️ 少了「更多」那一档就会漏掉整块搬出去的按钮 —— 它们默认不在 DOM 里。
        # ⚠️ 河流行还多要两档：它只在“选中了河”或“河流工具”时出现（默认态根本没有这两个节点）。
        #    `selectedRiver` 是 computed（按 id 去 `baseMap.rivers` 里找），所以不能直接塞对象，
        #    必须走 `setRiverSelection(ids)` —— 否则行虽然渲染、内容却走“未选中”那条分支（实测踩过）。
        PICK_RIVER = """
          const rs = (sm.baseMap && sm.baseMap.rivers) || [];
          const ids = rs.slice(0, %d).map(function (r) { return r && r.id; }).filter(Boolean);
          if (sm.setRiverSelection && ids.length) sm.setRiverSelection(ids);
        """
        PHASES = [
            ('default', '(() => 1)()'),
            ('more-open', "sm.moreOpen = true;"),
            ('basemap', "sm.moreOpen = false; sm.basemapEditMode = true;"),
            ('river-selected',
             "sm.basemapEditMode = false; sm.tool = 'select';" + (PICK_RIVER % 2)),
            ('river-edit',
             "sm.tool = 'river';" + (PICK_RIVER % 1) + "sm.riverActiveNode = 0;"),
            ('river-edit-none',
             "sm.tool = 'river'; sm.selectedRiverId = null;"
             " sm.selectedRiverIds = []; sm.riverActiveNode = -1;"),
        ]
        res = None
        for phase, act in PHASES:
            js = ("""(() => {
              const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
              %s
              return JSON.stringify({ ok: true });
            })()""" % act)
            eval_json(cdp, js, required=('ok',), desc='切态·' + phase)
            cdp.eval("new Promise(r => setTimeout(r, 320))")
            got, r1 = eval_json(cdp, COLLECT_JS % json.dumps(PROPS), required=('ok',),
                                desc='量按钮样式·' + phase)
            if not got or not r1.get('ok'):
                ck(f'拿到工具栏按钮读数·{phase}', False, r1)
                return 1
            for it in r1['items']:
                it['phase'] = phase
            if res is None:
                res = r1
            else:
                res['items'].extend(r1['items'])
            ck(f'读数·{phase}', True, f'{r1.get("count")} 个按钮')
            # 留一张工具栏截图（搬前/搬后逐像素比；修样式前后也靠它说话）
            if want_shot:
                gb, tb = eval_json(cdp, """(() => {
                  const el = document.querySelector('.scenario-toolbar');
                  if (!el) return JSON.stringify({ ok: false });
                  const r = el.getBoundingClientRect();
                  return JSON.stringify({ ok: true,
                    box: { x: r.left, y: r.top, w: r.width, h: r.height } });
                })()""", required=('ok',), desc='量工具栏矩形')
                if gb and tb.get('ok'):
                    png = os.path.join(shot_dir, phase + '.png')
                    ck(f'工具栏截图·{phase}', capture(cdp, tb['box'], png), os.path.basename(png))
                # ⚠️ 拆出去的行大多住在“更多”这块**浮层**里（`position:absolute`，锚在工具栏上、
                #    落在工具栏矩形**下面**）。只截工具栏会漏掉它们 —— 试点那 3 个按钮
                #    （拆分/合并/删除）就是这么在截图里看不见的。
                gb2, tb2 = eval_json(cdp, """(() => {
                  const el = document.querySelector('.toolbar-more');
                  if (!el) return JSON.stringify({ ok: false });
                  const r = el.getBoundingClientRect();
                  return JSON.stringify({ ok: true,
                    box: { x: r.left, y: r.top, w: r.width, h: r.height } });
                })()""", required=('ok',), desc='量更多面板矩形')
                if gb2 and tb2.get('ok'):
                    png2 = os.path.join(shot_dir, phase + '-morepanel.png')
                    ck(f'更多面板截图·{phase}', capture(cdp, tb2['box'], png2), os.path.basename(png2))
        res['count'] = len(res['items'])
        res['ts'] = time.strftime('%Y-%m-%dT%H:%M:%S')
        res['root'] = rt.ROOT
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(res, f, ensure_ascii=False, indent=1)
        ck(f'读数已落盘（{res.get("count")} 个按钮）', True, out_path)

        # ── 功能探针：具名 v-model 的接线是否真的通 ────────────────────────────
        # 🔴 为什么必须有这一步（2026-11-07 第 6 步）：把勾选框从 `v-model="showX"` 改成
        #    `:checked` + `update:showX` 之后，**样式一个字节都不会变** —— 但如果 emit 名字拼错
        #    或者父组件忘了接，点上去就是“没反应”。样式对拍看不见它，只能真点一次看状态。
        # ⚠️ 两个坑（第一版都踩了）：
        #    ① 这些开关住在「更多」浮层里 —— 面板没展开时 `querySelector` 拿到 null，
        #       而当时的判定写成 `before != now`，`None != False` 恰好为真 → **假绿**。
        #       所以先把面板打开，且两个读数都必须是真布尔值才算数。
        #    ② 点完要复原，否则会污染后面（比如渲染路径）的状态。
        eval_json(cdp, """(() => {
          const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
          sm.moreOpen = true;
          return JSON.stringify({ ok: true });
        })()""", required=('ok',), desc='打开更多（功能探针）')
        cdp.eval("new Promise(r => setTimeout(r, 260))")
        FUNCTIONAL = [
            ('toggle-place-names', 'showPlaceNames'),
            ('terrain-shade-box', 'terrainShade'),
            ('toggle-named-provinces', 'showNamedProvincesOnly'),
        ]
        for testid, ref_name in FUNCTIONAL:
            ok, res = eval_json(cdp, """(() => {
              const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
              const el = document.querySelector('[data-testid=%s]');
              if (!el) return JSON.stringify({ ok: false, why: 'no-el' });
              const before = !!sm.%s;
              el.click();
              return JSON.stringify({ ok: true, before: before });
            })()"""
            % (json.dumps(testid), ref_name), required=('ok',), desc='点·' + testid)
            cdp.eval("new Promise(r => setTimeout(r, 140))")
            got2, after = eval_json(cdp, """(() => {
              const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
              return JSON.stringify({ ok: true, now: !!sm.%s });
            })()""" % ref_name, required=('ok',), desc='读·' + ref_name)
            # 只有“两边都真的读到了布尔值、而且值确实翻了”才算通
            strict = (bool(ok) and bool(res.get('ok')) and bool(got2)
                      and isinstance(res.get('before'), bool) and isinstance(after.get('now'), bool)
                      and res.get('before') != after.get('now'))
            ck(f'接线通·{testid} → {ref_name}', strict,
               f"{res.get('ok') and res.get('before')} → {after.get('now')}"
               + ('' if res.get('ok') else f"（读不到元素：{res.get('why')}）"))
            # 复原（别污染后面的状态）
            eval_json(cdp, """(() => {
              const el = document.querySelector('[data-testid=%s]');
              if (el) el.click();
              return JSON.stringify({ ok: true });
            })()""" % json.dumps(testid), required=('ok',), desc='复原·' + testid)
            cdp.eval("new Promise(r => setTimeout(r, 140))")
        eval_json(cdp, """(() => {
          const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
          sm.moreOpen = false;
          return JSON.stringify({ ok: true });
        })()""", required=('ok',), desc='收起更多（功能探针收尾）')

        # 顺手打印一张“按行分组”的表，肉眼也能看出一行是不是走样了

        # 顺手打印一张“按行分组”的表，肉眼也能看出一行是不是走样了
        by_row = {}
        for it in res['items']:
            by_row.setdefault(it.get('phase', '-') + ' | ' + it['row']
                              + (' [更多]' if it['inMore'] else ''), []).append(it)
        for row, items in by_row.items():
            h = sorted({i['style']['height'] for i in items})
            fs = sorted({i['style']['fontSize'] for i in items})
            d = sorted({i['style']['display'] for i in items})
            print(f'    · {row}: {len(items)} 个按钮  height={h} fontSize={fs} display={d}'
                  f' · 父 scope 命中 {sum(1 for i in items if i["parentScopeOnButton"])}/{len(items)}',
                  flush=True)
        return 0
    finally:
        for h in reversed(handles):
            try:
                h.stop()
            except Exception:
                pass
        try:
            rt.teardown_mock()
        except Exception:
            pass


def compare(a_path, b_path):
    with open(a_path, encoding='utf-8') as f:
        a = json.load(f)
    with open(b_path, encoding='utf-8') as f:
        b = json.load(f)

    def key(it):
        return (it.get('phase', '-'), it.get('kind', 'button'), it['row'], it['inMore'],
                it['text'], it['testid'])

    ai = {key(it): it for it in a['items']}
    bi = {key(it): it for it in b['items']}
    bad = 0
    for k in sorted(set(ai) & set(bi)):
        da, db = ai[k]['style'], bi[k]['style']
        diff = [f'{p}: {da.get(p)} → {db.get(p)}' for p in PROPS
                if da.get(p) != db.get(p)]
        ba, bb = ai[k]['box'], bi[k]['box']
        if (ba.get('w'), ba.get('h')) != (bb.get('w'), bb.get('h')):
            diff.append(f'尺寸: {ba.get("w")}×{ba.get("h")} → {bb.get("w")}×{bb.get("h")}')
        bad += 0 if ck(f'[{k[0]}] {k[1]} {k[2]} · {k[4] or k[5] or "(无字)"}',
                       not diff, '; '.join(diff)) else 1
    only_a = sorted(set(ai) - set(bi))
    only_b = sorted(set(bi) - set(ai))
    for k in only_a:
        bad += 0 if ck(f'少了元素 [{k[0]}] {k[1]} {k[2]} · {k[4]}', False, 'B 里找不到') else 1
    for k in only_b:
        bad += 0 if ck(f'多了元素 [{k[0]}] {k[1]} {k[2]} · {k[4]}', False, 'A 里没有') else 1
    print(f'\n=== 工具栏按钮样式对拍：{len(set(ai) & set(bi))} 个对齐，{bad} 项不同 ===', flush=True)
    return 0 if not bad else 1


def main():
    args = sys.argv[1:]
    out = None
    for i, a in enumerate(args):
        if a == '--out' and i + 1 < len(args):
            out = args[i + 1]
    if '--compare' in args:
        i = args.index('--compare')
        return compare(args[i + 1], args[i + 2])
    if not out:
        out = os.path.join(rt.ROOT, 'build', 'toolbar-row-styles',
                           time.strftime('%Y%m%d-%H%M%S') + '.json')
    return collect(out)


if __name__ == '__main__':
    sys.exit(main())
