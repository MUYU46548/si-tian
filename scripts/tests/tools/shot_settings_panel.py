#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""设置面板真机检查（2026-11-08，用户：“界面太丑了，难以阅读和使用”）

为什么单独一件：`test_124_vault_index` 能证明“元素存在、按钮有字、点了会调 IPC”，
但**证明不了排版**。2026-11-08 那次真机上就是这么翻车的 —— 把说明 + 输入框 + 按钮
塞进了 `.setting-item`（横排 flex），结果说明被压成一列字、输入框成了窄条、按钮叠在一起，
而源码闸门与用例**全绿**。

判据（全部量真机 DOM 的几何，不看源码）：
  1) “按目录补上层”整块在 DOM 里；
  2) **说明文字的宽度 ≥ 220px**（横排压扁时会变成 30~60px，一列一个字）；
  3) 输入框宽度 ≥ 220px、高度 ≥ 48px（能写字、能看见自己写了什么）；
  4) 三个按钮的文字**没有被裁**（scrollWidth <= clientWidth + 1），高度 ≤ 34px（没竖排）；
  5) 摘要行（候选/待人工/全库搜索）**不横向溢出**（scrollWidth <= clientWidth + 2）；
  6) 留一张整页截图 `build/settings-panel/settings.png` 给人眼复核。

用法：python scripts/tests/tools/shot_settings_panel.py
退出码：0 = 全过。
"""
import base64
import os
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TESTS = os.path.dirname(HERE)
sys.path.insert(0, TESTS)

from lib.cdp import CDP, wait_for, skip_onboarding          # noqa: E402

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8')
    except Exception:
        pass

ROOT = os.path.abspath(os.path.join(TESTS, '..', '..'))
OUT = os.path.join(ROOT, 'build', 'settings-panel')
DEV_PORT = 5180
CDP_PORT = 9225
fails = []


def ck(name, ok, detail=''):
    print(('  ✅ ' if ok else '  ❌ ') + name + ('  — ' + str(detail) if detail else ''), flush=True)
    if not ok:
        fails.append(name + ('  — ' + str(detail) if detail else ''))


def port_open(port):
    s = socket.socket()
    s.settimeout(0.3)
    try:
        return s.connect_ex(('127.0.0.1', port)) == 0
    finally:
        s.close()


def wait_port(port, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if port_open(port):
            return True
        time.sleep(0.3)
    return False


def wait_http(url, timeout=60):
    import urllib.request
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return True
        except Exception:                                        # noqa: BLE001
            time.sleep(0.4)
    return False


def dismiss_disclaimer(cdp):
    """首启免责声明：滚到底 → 置 agreed → 点“同意并继续”。

    ⚠️ 三个坑（本脚本第一版就踩了第一个，导致截图整页是弹窗、而 DOM 判据全绿）：
      ① 声明是**异步挂载**的，点完 .app-layout 就找会见不到它 → 必须重试；
      ② gate 模式下“同意”按钮要求 `scrolledToEnd`（滚到底才可勾选），光置 agreed 不够；
      ③ 置完 ref 要等一拍再点，`:disabled` 是异步更新的。
    """
    for _ in range(24):                      # 最多等 12s
        if cdp.eval("!!document.querySelector('[data-testid=\"disclaimer-dialog\"]')"):
            break
        time.sleep(0.5)
    else:
        return 'no-dialog'
    for _ in range(6):
        cdp.eval("""(() => {
          const dlg = document.querySelector('[data-testid="disclaimer-dialog"]');
          const sc = Array.from(dlg.querySelectorAll('*'))
            .find(e => e.scrollHeight > e.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(e).overflowY));
          if (sc) { sc.scrollTop = sc.scrollHeight; sc.dispatchEvent(new Event('scroll')); }
          const sm = dlg.__vueParentComponent && dlg.__vueParentComponent.setupState;
          // gate 模式两个门槛：滚到底（scrolledToEnd）与勾选（agreed）。截图工具直接置状态，
          // 产品路径本身由 test_83_disclaimer / shot_planet_ux 走真实点击守。
          if (sm && 'scrolledToEnd' in sm) sm.scrolledToEnd = true;
          if (sm && 'readPercent' in sm) sm.readPercent = 100;
          if (sm && 'agreed' in sm) sm.agreed = true;
          return 'ok';
        })()""")
        time.sleep(0.5)
        cdp.eval("""(() => {
          const b = document.querySelector('[data-testid="disclaimer-accept"]');
          if (b && !b.disabled) b.click();
          return 'ok';
        })()""")
        time.sleep(0.8)
        if not cdp.eval("!!document.querySelector('[data-testid=\"disclaimer-dialog\"]')"):
            return 'closed'
    return 'still-open'


def shot(cdp, path):
    for params in ({'format': 'png', 'fromSurface': False}, {'format': 'png'}):
        try:
            rep = cdp.send('Page.captureScreenshot', params)
            data = (rep or {}).get('data') or ''
            if data:
                with open(path, 'wb') as f:
                    f.write(base64.b64decode(data))
                return len(data)
        except Exception:                                        # noqa: BLE001
            pass
    return 0


def check_world(cdp):
    """世界视图：卡片上的“改名 / 删除”必须**常驻 + 带文字**（2026-11-08）。

    这两个按钮曾经是 opacity:0 + 纯图标。判据只看真机几何：
      · 文字里有“改名 / 删除”；· computed opacity 是 1；· 宽度装得下字（≥40px）；
      · 两个按钮**不重叠**（position:absolute 调 right 值很容易叠）。
    """
    ok_cards = False
    for _ in range(60):
        if cdp.eval("document.querySelectorAll('.world-card').length > 0"):
            ok_cards = True
            break
        time.sleep(0.5)
    if not ok_cards:
        # 空库时世界视图本来就没有卡片 —— 拿**示例项目的副本**开一次（副本在 build/ 里，不碰仓内原件）
        import shutil
        copy = os.path.join(OUT, 'world-check.sitian')
        shutil.copyfile(os.path.join(ROOT, 'sample', '示例世界.sitian'), copy)
        opened = cdp.eval("""(async () => {
          try {
            const app = document.querySelector('#app').__vue_app__;
            const M = await import('/src/store/projectStore.js');
            const p = M.useProjectStore(app.config.globalProperties.$pinia);
            const r = await p.openProject(%r);
            return { ok: !!(r && r.success !== false), err: (r && r.error) || '' };
          } catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
        })()""" % copy.replace('\\', '/'))
        if not isinstance(opened, dict) or not opened.get('ok'):
            print('打开示例副本失败：%s' % (opened.get('err') if isinstance(opened, dict) else opened))
            return 1
        for _ in range(40):
            if cdp.eval("document.querySelectorAll('.world-card').length > 0"):
                ok_cards = True
                break
            time.sleep(0.5)
    if not ok_cards:
        print('没有 .world-card —— 当前屏：grid=%s ｜ 文字前 160 字：%s' % (
            cdp.eval("document.querySelectorAll('.world-grid > *').length"),
            cdp.eval("(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 160)")))
        return 1
    time.sleep(0.6)
    info = cdp.eval("""(() => {
      const card = document.querySelector('.world-card');
      if (!card) return { none: true };
      const box = (sel) => {
        const b = card.querySelector(sel);
        if (!b) return null;
        const rc = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        return { text: (b.textContent || '').trim(), opacity: cs.opacity,
                 x: Math.round(rc.x), y: Math.round(rc.y), w: Math.round(rc.width), h: Math.round(rc.height) };
      };
      return { rename: box('.rename-btn'), del: box('.delete-btn'),
               card: ((rc) => ({ x: Math.round(rc.x), w: Math.round(rc.width) }))(card.getBoundingClientRect()) };
    })()""")
    ck('世界卡片存在', not info.get('none'))
    for key, want in (('rename', '改名'), ('del', '删除')):
        b = info.get(key) or {}
        ck('%s 按钮有可见文字' % want, want in (b.get('text') or ''), b.get('text'))
        ck('%s 按钮常驻（opacity=1）' % want, str(b.get('opacity')) == '1', b.get('opacity'))
        ck('%s 按钮宽度装得下文字' % want, (b.get('w') or 0) >= 40, b.get('w'))
    r, d = info.get('rename') or {}, info.get('del') or {}
    card = info.get('card') or {}
    if r and d and card:
        overlap = not (r['x'] + r['w'] <= d['x'] + 1 or d['x'] + d['w'] <= r['x'] + 1)
        ck('两个按钮不重叠', not overlap, 'rename x=%s w=%s / del x=%s w=%s' % (r['x'], r['w'], d['x'], d['w']))
        left, right = card['x'], card['x'] + card['w']
        ck('两个按钮都在卡片内', r['x'] >= left and d['x'] + d['w'] <= right + 1,
           'card x=%s w=%s（按钮 %s~%s）' % (left, card['w'], r['x'], d['x'] + d['w']))
    n = shot(cdp, os.path.join(OUT, 'world.png'))
    ck('截图落盘', n > 0, '%d 字节' % n)
    print('\n截图：build/settings-panel/world.png')
    return 1 if fails else 0


def check_header(cdp):
    """顶栏：每个按钮都有文字、不横向溢出（1920 与 1280 两档）、“更多”浮层能开且项都有字。

    2026-11-08：顶栏原来 20 个纯图标按钮；主力动作补了文字，低频收进「更多」。
    这条只量真机几何 —— 源码闸门能证明“写了文字”，证明不了“1280 下会不会挤出屏幕”。
    """
    wait_for(cdp, "!!document.querySelector('.toolbar-actions')", timeout=60, desc='顶栏')
    probe = """(() => {
      const bar = document.querySelector('.toolbar-actions');
      const btns = Array.from(bar.querySelectorAll('button'));
      const noText = btns.filter(b => !((b.textContent || '').trim())).length;
      const tb = btns.filter(b => b.classList.contains('tb-btn'));
      const tbNoText = tb.filter(b => !((b.textContent || '').trim())).length;
      const hdr = document.querySelector('header.toolbar');
      return {
        count: btns.length, tb: tb.length, noText, tbNoText,
        barOverflow: bar.scrollWidth > bar.clientWidth + 2,
        barW: Math.round(bar.getBoundingClientRect().width),
        hdrOverflow: hdr.scrollWidth > hdr.clientWidth + 2,
        hdrW: Math.round(hdr.getBoundingClientRect().width),
        docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      };
    })()"""
    a = cdp.eval(probe)
    ck('顶栏每个按钮都有可见文字（纯图标 = 0）', a.get('noText') == 0,
       'buttons=%s / tb-btn=%s / 无字=%s' % (a.get('count'), a.get('tb'), a.get('noText')))
    ck('顶栏不横向溢出（当前窗口）', not a.get('hdrOverflow') and not a.get('barOverflow'),
       'header %spx 溢出=%s / actions 溢出=%s' % (a.get('hdrW'), a.get('hdrOverflow'), a.get('barOverflow')))

    # 打开“更多”浮层
    opened = cdp.eval("""(() => {
      const b = document.querySelector('[data-testid="header-more"]');
      if (!b) return 'no-btn';
      b.click();
      return 'ok';
    })()""")
    ck('“更多”按钮存在且可点', opened == 'ok', opened)
    time.sleep(0.3)
    panel = cdp.eval("""(() => {
      const p = document.querySelector('[data-testid="header-more-panel"]');
      if (!p) return { missing: true };
      const cs = getComputedStyle(p);
      const rc = p.getBoundingClientRect();
      const items = Array.from(p.querySelectorAll('.hm-item'));
      return {
        visible: cs.display !== 'none' && rc.width > 0,
        x: Math.round(rc.x), y: Math.round(rc.y),
        w: Math.round(rc.width), h: Math.round(rc.height),
        inViewport: rc.x >= 0 && rc.y >= 0 && rc.right <= innerWidth + 1 && rc.bottom <= innerHeight + 1,
        items: items.map(i => (i.textContent || '').trim()),
        noTextItems: items.filter(i => !((i.textContent || '').trim())).length,
      };
    })()""")
    ck('浮层打开后可见', (panel.get('visible') is True) and not panel.get('missing'), panel)
    ck('浮层里每一项都有文字', (panel.get('noTextItems') or 0) == 0, panel.get('items'))
    ck('浮层完整在视口内', panel.get('inViewport') is True,
       'x=%s y=%s w=%s h=%s' % (panel.get('x'), panel.get('y'), panel.get('w'), panel.get('h')))
    shot(cdp, os.path.join(OUT, 'header-more.png'))
    # 收起：用**真实鼠标事件**点浮层外面（收起逻辑挂在 document 的 mousedown 上；
    # `body.click()` 只派发 click，不派发 mousedown —— 用它验会假红，也会掩盖“真的点不掉”这种缺陷）
    try:
        for t in ('mousePressed', 'mouseReleased'):
            cdp.send('Input.dispatchMouseEvent', {'type': t, 'x': 640, 'y': 620, 'button': 'left', 'clickCount': 1})
    except Exception:                                            # noqa: BLE001
        cdp.eval("document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))")
    time.sleep(0.3)
    gone = cdp.eval("(() => { const p = document.querySelector('[data-testid=\"header-more-panel\"]');"
                    " return !p || getComputedStyle(p).display === 'none'; })()")
    ck('点外面能收起', gone is True)

    # 窄窗 1280：证明文字全加上之后仍然装得下
    try:
        cdp.send('Emulation.setDeviceMetricsOverride',
                 {'width': 1280, 'height': 800, 'deviceScaleFactor': 1, 'mobile': False})
        time.sleep(0.5)
        b = cdp.eval(probe)
        ck('1280 窄窗下顶栏仍不溢出', (not b.get('hdrOverflow')) and (not b.get('barOverflow')),
           'header %spx 溢出=%s / actions 溢出=%s' % (b.get('hdrW'), b.get('hdrOverflow'), b.get('barOverflow')))
        shot(cdp, os.path.join(OUT, 'header-1280.png'))
    finally:
        try:
            cdp.send('Emulation.clearDeviceMetricsOverride', {})
        except Exception:                                        # noqa: BLE001
            pass
    print('\n截图：build/settings-panel/header-more.png / header-1280.png')
    return 1 if fails else 0


def main():
    for p in (DEV_PORT, CDP_PORT):
        if port_open(p):
            print('端口 %d 被占用 —— 先停掉正在跑的回归/演练' % p)
            return 2
    os.makedirs(OUT, exist_ok=True)

    node = 'node'
    exe = subprocess.run([node, '-e', 'process.stdout.write(require("electron"))'],
                         cwd=ROOT, capture_output=True, text=True, timeout=60).stdout.strip()
    dev = el = None
    try:
        print('=== 设置面板真机检查 ===')
        dev = subprocess.Popen([node, os.path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
                                '--config', 'vite.config.js'], cwd=ROOT,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if not wait_http('http://localhost:%d/' % DEV_PORT):
            print('vite 未就绪')
            return 1
        env = dict(os.environ)
        env['NODE_ENV'] = 'development'
        env.pop('ELECTRON_RUN_AS_NODE', None)
        profile = os.path.join(OUT, 'userdata')
        import shutil
        shutil.rmtree(profile, ignore_errors=True)
        os.makedirs(profile, exist_ok=True)
        # 预先写好 vaultPath（指向**仓内 fixture 的副本**）：
        #   ① 不碰仓内 fixture（副本可写，`.sitian` 落在副本里）；
        #   ② 面板才会真的去建索引、渲染摘要行 —— 空库时摘要行是 v-if 不渲染的，
        #      那样“摘要行有没有溢出”这条判据是**空转**（第一版就这么假绿过）。
        vcopy = os.path.join(OUT, 'vault')
        shutil.rmtree(vcopy, ignore_errors=True)
        # 用“乱库”夹具（22 篇、结构故意不齐）：主夹具 vault-fixture 是生成出来的，
        # 仓里不带 .md（0 篇）—— 拿它建索引会得到 total 0，摘要行照样不渲染。
        src_fixture = os.path.join(ROOT, 'scripts', 'tests', 'fixtures', 'vault-fixture-messy')
        if not os.path.isdir(src_fixture):
            src_fixture = os.path.join(ROOT, 'scripts', 'tests', 'fixtures', 'vault-fixture')
        shutil.copytree(src_fixture, vcopy)
        with open(os.path.join(profile, 'config.json'), 'w', encoding='utf-8') as f:
            import json as _json
            _json.dump({'vaultPath': vcopy, 'windowMode': 'maximized', 'closeQuitsApp': False}, f, ensure_ascii=False)
        el = subprocess.Popen([exe, '--user-data-dir=%s' % profile,
                               '--remote-debugging-port=%d' % CDP_PORT,
                               '--disable-gpu', '--remote-allow-origins=*', '.'],
                              cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if not wait_port(CDP_PORT, 90):
            print('Electron CDP 未就绪')
            return 1
        cdp = CDP(port=CDP_PORT)
        wait_for(cdp, "document.readyState === 'complete' && !!document.querySelector('.app-layout')",
                 timeout=120, desc='应用挂载')
        # 首启免责声明：**拿模块自己的键写 ack 再重载**。
        # gate 模式下两个门槛（滚到底 + 勾选）都卡着，程序化点一个 disabled 按钮是静默 no-op ——
        # 第一版就因此截图整页是弹窗、而 DOM 判据全绿（真实点击路径由 test_83_disclaimer 守）。
        ack_key = cdp.eval("""(async () => {
          try { const m = await import('/src/utils/disclaimer.js'); return m.DISCLAIMER_ACK_KEY || ''; }
          catch (e) { return ''; }
        })()""")
        if ack_key and isinstance(ack_key, str):
            cdp.eval("(() => { try { localStorage.setItem(%r, new Date().toISOString()); } catch (e) {} return 'ok'; })()" % ack_key)
            try:
                cdp.send('Page.reload', {})
            except Exception:                                    # noqa: BLE001
                pass
            time.sleep(2.5)
            wait_for(cdp, "document.readyState === 'complete' && !!document.querySelector('.app-layout')",
                     timeout=120, desc='重载后应用挂载')
        dres = dismiss_disclaimer(cdp)
        ck('首启免责声明已关掉（没关的话截图整页是弹窗，第一版就这么假绿过）',
           dres in ('closed', 'no-dialog'), dres)
        skip_onboarding(cdp)
        time.sleep(0.8)

        # `--view world|header`：分别查世界卡片、顶栏（都不需要打开设置面板）
        if '--view' in sys.argv:
            i = sys.argv.index('--view')
            mode = sys.argv[i + 1] if i + 1 < len(sys.argv) else ''
            if mode == 'world':
                print('=== 世界视图真机检查 ===')
                return check_world(cdp)
            if mode == 'header':
                print('=== 顶栏真机检查 ===')
                return check_header(cdp)

        # 打开设置面板：先按工具栏那条稳定入口找，找不到就退化成“全页找 title=设置”
        clicked = cdp.eval("""(() => {
          const b = Array.from(document.querySelectorAll('.toolbar-actions button')).find(x => x.title === '设置')
                 || Array.from(document.querySelectorAll('button')).find(x => x.title === '设置')
                 || Array.from(document.querySelectorAll('button')).find(x => (x.getAttribute('aria-label') || '') === '设置');
          if (!b) return 'no-button:' + Array.from(document.querySelectorAll('button')).map(x => x.title || (x.textContent || '').trim()).slice(0, 12).join(' | ');
          b.click();
          return 'ok';
        })()""")
        if clicked != 'ok':
            print('找不到设置入口：%s' % clicked)
            print('页面文字前 200 字：%s' % cdp.eval("(document.body.innerText || '').slice(0, 200)"))
            return 1
        wait_for(cdp, "!!document.querySelector('.settings-panel')", timeout=20, desc='设置面板')
        wait_for(cdp, "!!document.querySelector('[data-testid=\"geo-parent-dirs\"]')", timeout=20, desc='按目录补上层')

        # 真建一次索引 → 摘要行（候选/待人工/全库搜索）才会渲染；不建的话下面那条判据是空转
        cdp.eval("""(() => {
          const b = Array.from(document.querySelectorAll('[data-testid="vault-index-section"] button'))
            .find(x => (x.textContent || '').includes('重建索引'));
          if (b) b.click();
          return 'ok';
        })()""")
        built = False
        for _ in range(60):
            if cdp.eval("!!document.querySelector('.index-summary')"):
                built = True
                break
            time.sleep(0.5)
        if not built:
            print('索引没建起来 —— 状态行：%s ｜ 错误：%s' % (
                cdp.eval("(document.querySelector('[data-testid=\"vault-index-section\"] .setting-desc') || {}).textContent || ''"),
                cdp.eval("(document.querySelector('.index-error') || {}).textContent || ''"),
            ))
            return 1
        # 展开“待人工”（用户截图里看不懂的就是这一屏）
        cdp.eval("""(() => {
          const b = document.querySelector('[data-testid="toggle-vault-missing"]');
          if (b) b.click();
          return 'ok';
        })()""")
        time.sleep(1.0)
        # 进到“按目录补上层”那一屏
        cdp.eval("""(() => {
          const el = document.querySelector('[data-testid="geo-parent-dirs"]');
          if (el) el.scrollIntoView({ block: 'center' });
          return 'ok';
        })()""")
        time.sleep(0.6)

        ck('“按目录补上层”整块在 DOM 里', True)

        geo = cdp.eval("""(() => {
          const box = document.querySelector('[data-testid="geo-parent-dirs"]');
          if (!box) return { missing: true };
          const desc = box.querySelector('.setting-desc');
          const head = box.querySelector('.geo-dirs-head');
          const ta = box.querySelector('[data-testid="geo-dirs-input"]');
          const btns = Array.from(box.querySelectorAll('button')).map(b => ({
            text: (b.textContent || '').trim(),
            w: Math.round(b.getBoundingClientRect().width),
            h: Math.round(b.getBoundingClientRect().height),
            clipped: b.scrollWidth > b.clientWidth + 1,
          }));
          const sum = document.querySelector('.index-summary');
          const rb = (e) => e ? { w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) } : null;
          return {
            desc: rb(desc), head: rb(head), ta: rb(ta), btns,
            sumOverflow: sum ? (sum.scrollWidth > sum.clientWidth + 2) : null,
            sum: rb(sum),
            sumDetail: sum ? {
              sw: sum.scrollWidth, cw: sum.clientWidth,
              cs: getComputedStyle(sum).flexWrap + '/' + getComputedStyle(sum).display,
              kids: Array.from(sum.children).map(e => ({
                t: (e.textContent || '').trim().slice(0, 14),
                w: Math.round(e.getBoundingClientRect().width),
              })),
            } : null,
            panelW: Math.round((document.querySelector('.settings-panel') || {}).getBoundingClientRect
              ? document.querySelector('.settings-panel').getBoundingClientRect().width : 0),
          };
        })()""")

        if geo.get('missing'):
            return 1
        d = geo.get('desc') or {}
        ck('说明文字没有被压成一列字（宽度 ≥ 220）', (d.get('w') or 0) >= 220, d)
        t = geo.get('ta') or {}
        ck('输入框够宽够高', (t.get('w') or 0) >= 220 and (t.get('h') or 0) >= 48, t)
        btns = geo.get('btns') or []
        ck('三个按钮都在', len(btns) == 3, [b.get('text') for b in btns])
        ck('按钮文字没有被裁', all(not b.get('clipped') for b in btns), [b.get('text') for b in btns if b.get('clipped')])
        ck('按钮没有被压成竖排（高度 ≤ 34）', all((b.get('h') or 0) <= 34 for b in btns), [(b.get('text'), b.get('h')) for b in btns])
        ck('摘要行不横向溢出', geo.get('sumOverflow') is False, geo.get('sumDetail'))

        # 待人工那一屏：名字不能是 H1（真实库里 H1 多是“概述”，一屏几十行全一样 = 认不出）
        miss = cdp.eval("""(() => {
          const list = document.querySelector('[data-testid="vault-missing-list"]');
          if (!list) return { none: true };
          const rows = Array.from(list.querySelectorAll('.vault-candidate'));
          return {
            n: rows.length,
            titles: rows.map(r => (r.querySelector('.vc-title') || {}).textContent || ''),
            reasons: rows.map(r => {
              const el = r.querySelector('.vc-reason');
              if (!el) return null;
              const rc = el.getBoundingClientRect();
              return { w: Math.round(rc.width), h: Math.round(rc.height), clipped: el.scrollHeight > el.clientHeight + 2 };
            }),
          };
        })()""")
        if not miss.get('none'):
            ck('待人工至少有 1 行', (miss.get('n') or 0) >= 1, miss.get('n'))
            ck('行标题不是 H1 的“概述”', '概述' not in (miss.get('titles') or []), (miss.get('titles') or [])[:4])
            ck('行标题不空', all(bool(t.strip()) for t in (miss.get('titles') or [])), (miss.get('titles') or [])[:4])
            reasons = [r for r in (miss.get('reasons') or []) if r]
            ck('理由没有被裁（整行读得到）', all(not r.get('clipped') for r in reasons),
               [(r.get('h'), r.get('clipped')) for r in reasons][:4])

        n = shot(cdp, os.path.join(OUT, 'settings.png'))
        ck('截图落盘', n > 0, '%d 字节' % n)

        print('\n面板宽度：%s px · 截图：build/settings-panel/settings.png' % geo.get('panelW'))
        return 1 if fails else 0
    finally:
        for p in (el, dev):
            if p is not None:
                try:
                    p.terminate()
                except Exception:                                # noqa: BLE001
                    pass


if __name__ == '__main__':
    rc = main()
    print('\n=== %s ===' % ('全部通过' if rc == 0 else '有失败项：' + '；'.join(fails)))
    sys.exit(rc)
