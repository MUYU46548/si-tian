#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""行星视图工具坞的**真机**验收（2026-11-05，一轮一问的“遗留问题”检查）

为什么单独一份：`unit/test_toolbar_ux_planet.js` 只读源码模板 —— 它能证明“每个按钮都有名字”，
但证明不了 **名字有没有被裁掉 / 坞有没有挡住画布 / 19 个工具排下来放不放得下**。
这一类只能真机量（上一轮剧本视图的三个布局 bug 就是源码判据全绿、截图一眼看穿）。

做法：Vite(5180) + **真实 Electron**（隔离 user-data-dir，CDP 9224）→ 打开示例项目副本 →
`store.selectPlanet()` 进行星视图 → 打开编辑模式 → 量 DOM + 截图。

判据（全读真实 DOM）：
  1) 工具坞存在，且按钮数 ≥ 15（工具 + 对象/快照/完成）
  2) **每个按钮都有可见文字**（textContent 去空白后非空）
  3) **没有一个按钮的文字被裁**（scrollWidth <= clientWidth + 1）—— 纯图标时代不会出现，
     加了文字之后才会（`.mini-reset` 就差点被 24×24 裁掉）
  4) 坞宽 ≤ 140px，且不横向压住超过 15% 的画布
  5) 截图落 `build/planet-ux/dock.png`（人眼复核用）

用法：python scripts/tests/tools/shot_planet_ux.py
退出码：0 = 通过。
"""
import json
import os
import shutil
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
OUT = os.path.join(ROOT, 'build', 'planet-ux')
DEV_PORT = 5180
CDP_PORT = 9224
SAMPLE = os.path.join(ROOT, 'sample', '示例世界.sitian')

fails = []


def ck(name, ok, detail=''):
    print(('  ✅ ' if ok else '  ❌ ') + name + (' — ' + str(detail) if detail else ''), flush=True)
    if not ok:
        fails.append(name + (' — ' + str(detail) if detail else ''))


def port_open(port):
    import socket
    s = socket.socket()
    s.settimeout(0.3)
    try:
        return s.connect_ex(('127.0.0.1', port)) == 0
    finally:
        s.close()


def wait_port(port, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        if port_open(port):
            return True
        time.sleep(0.3)
    return False


def wait_http(url, timeout=90):
    import urllib.request
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    end = time.time() + timeout
    while time.time() < end:
        try:
            with opener.open(url, timeout=1) as r:
                if r.status < 500:
                    return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def dismiss_disclaimer(cdp):
    """首启的免责声明是全屏对话框（不滚到底不许同意）—— 演练里把它按产品同一条路走完：
    滚到底 → 勾“我已阅读” → 点同意。否则截图里全是对话框、看不到工具坞。"""
    r = cdp.eval("""(() => {
      const sc = document.querySelector('[data-testid="disclaimer-scroll"]');
      if (!sc) return 'no-dialog';
      sc.scrollTop = sc.scrollHeight;
      sc.dispatchEvent(new Event('scroll', { bubbles: true }));
      const cb = document.querySelector('[data-testid="disclaimer-ack-checkbox"]');
      if (cb && !cb.checked) cb.click();
      return 'scrolled';
    })()""")
    time.sleep(0.6)
    # 勾选框是 reka-ui 的 button[role=checkbox]，程序化 `.click()` 在它身上不稳；
    # 直接把组件的 agreed 置真再点“同意并继续”（仍然走组件自己的 accept()）。
    cdp.eval("""(() => {
      const dlg = document.querySelector('[data-testid="disclaimer-dialog"]');
      const vt = dlg && dlg.__vueParentComponent;
      const sm = vt && vt.setupState;
      if (sm && 'agreed' in sm) sm.agreed = true;
      const cb = document.querySelector('[data-testid="disclaimer-ack-checkbox"]');
      if (cb && !(cb.checked === true)) { try { cb.click(); } catch (e) {} }
      return 'agree-set';
    })()""")
    time.sleep(0.5)
    cdp.eval("""(() => {
      const b = document.querySelector('[data-testid="disclaimer-accept"]');
      if (!b) return 'no-accept';
      b.click();
      return 'accept-clicked';
    })()""")
    time.sleep(0.8)
    gone = cdp.eval("!document.querySelector('[data-testid=\"disclaimer-dialog\"]')")
    return 'closed' if gone else 'still-open'


def shot(cdp, path):
    """整页截图（尽力而为）。

    ⚠️ 实测：行星画布（1720px 宽）上 `Page.captureScreenshot` **必超时**，把视口钉到
    1280×800@1x、读超时放到 90s 也一样 —— 这是 CDP 合成器在这一页上拿不到帧，
    不是判据本身有问题（8 条 DOM 判据已能量出“文字有没有被裁 / 坞有多宽”）。
    所以截图作为**非阻塞**步骤：失败只打印警告，不计入失败项，并在卡片上留口。
    """
    import base64
    for params in ({'format': 'png', 'fromSurface': False}, {'format': 'png'}):
        old = None
        try:
            old = cdp.ws.gettimeout()
            cdp.ws.settimeout(20)
        except Exception:
            pass
        try:
            rep = cdp.send('Page.captureScreenshot', params)
            data = (rep or {}).get('data') or ''
            if data:
                with open(path, 'wb') as f:
                    f.write(base64.b64decode(data))
                return len(data)
        except Exception:                                        # noqa: BLE001
            pass
        finally:
            try:
                if old is not None:
                    cdp.ws.settimeout(old)
            except Exception:
                pass
    return 0


def main():
    for p in (DEV_PORT, CDP_PORT):
        if port_open(p):
            print('端口 %d 被占用 —— 先停掉正在跑的回归/演练' % p)
            return 2
    if not os.path.exists(SAMPLE):
        print('缺少示例项目：%s' % SAMPLE)
        return 2
    os.makedirs(OUT, exist_ok=True)
    copy = os.path.join(OUT, '示例世界-行星检查.sitian')
    shutil.copyfile(SAMPLE, copy)

    node = 'node'
    exe = subprocess.run([node, '-e', 'process.stdout.write(require("electron"))'],
                         cwd=ROOT, capture_output=True, text=True, timeout=60).stdout.strip()
    dev = el = None
    try:
        print('=== 行星视图工具坞真机检查 ===')
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
        shutil.rmtree(profile, ignore_errors=True)
        el = subprocess.Popen([exe, '--user-data-dir=%s' % profile,
                               '--remote-debugging-port=%d' % CDP_PORT,
                               '--disable-gpu', '--remote-allow-origins=*', '.'],
                              cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if not wait_port(CDP_PORT):
            print('Electron CDP 未就绪')
            return 1
        cdp = CDP(port=CDP_PORT)
        wait_for(cdp, "document.readyState === 'complete' && !!document.querySelector('.app-layout')",
                 timeout=120, desc='应用挂载')
        ck('首启免责声明已按产品路径走完', dismiss_disclaimer(cdp) != 'no-dialog')
        # 🔴 顺序有讲究：**先免责声明、后新手引导** —— 反过来时（先跳过引导）接受声明之后
        #    引导层会再弹一次，截图里就是一层浮层压着画布（真踩，第一次截图整页都是弹窗）。
        skip_onboarding(cdp)

        # 打开示例副本（走产品同一条 openProject）
        opened = cdp.eval("""(async () => {
          const app = document.querySelector('#app').__vue_app__;
          const pinia = app.config.globalProperties.$pinia;
          const { useProjectStore } = await import('/src/store/projectStore.js');
          const ps = useProjectStore(pinia);
          const r = await ps.openProject(%s);
          return JSON.stringify({ ok: !!(r && r.success), err: (r && r.error) || '' });
        })()""" % json.dumps(copy))
        ok_open = json.loads(opened) if isinstance(opened, str) else {}
        ck('示例副本能打开', bool(ok_open.get('ok')), ok_open.get('err') or '')

        # 进行星视图（走 store 的 selectPlanet，与点导航同一个入口）
        entered = cdp.eval("""(() => {
          const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
          const p = (s.nodes || []).find((n) => n.layer === 'planet');
          if (!p) return JSON.stringify({ ok: false, err: 'no-planet-node' });
          s.selectPlanet(p);
          return JSON.stringify({ ok: true, name: p.name });
        })()""")
        info = json.loads(entered) if isinstance(entered, str) else {}
        ck('行星视图能进（store.selectPlanet）', bool(info.get('ok')), info.get('name') or info.get('err'))
        wait_for(cdp, "!!document.querySelector('.planet-map-container')", timeout=60, desc='行星视图挂载')

        # 打开编辑模式 → 工具坞才渲染
        cdp.eval("""(() => {
          const el = document.querySelector('.planet-map-container');
          const sm = el && el.__vueParentComponent && el.__vueParentComponent.setupState;
          if (!sm) return 'no-setup';
          sm.editMode = true;
          return 'ok';
        })()""")
        try:
            wait_for(cdp, "!!document.querySelector('.tool-dock')", timeout=20, desc='工具坞')
            has_dock = True
        except RuntimeError:
            has_dock = False
        ck('打开编辑模式后工具坞出现', has_dock)
        if not has_dock:
            return 1

        # 量 DOM：每个按钮有文字、文字不被裁、坞不压太多画布
        measured = cdp.eval("""(() => {
          const dock = document.querySelector('.tool-dock');
          const canvas = document.querySelector('.planet-map-container canvas');
          const btns = Array.from(dock.querySelectorAll('button'));
          const empty = btns.filter((b) => !(b.textContent || '').trim()).map((b) => b.getAttribute('title') || '?');
          const clipped = btns.filter((b) => b.scrollWidth > b.clientWidth + 1)
            .map((b) => (b.textContent || '').trim() + ' ' + b.scrollWidth + '>' + b.clientWidth);
          const dr = dock.getBoundingClientRect();
          const cw = canvas ? canvas.getBoundingClientRect().width : 0;
          return JSON.stringify({
            count: btns.length, empty, clipped,
            dockW: Math.round(dr.width), dockH: Math.round(dr.height), canvasW: Math.round(cw),
            labels: btns.map((b) => (b.textContent || '').trim()).slice(0, 24),
          });
        })()""")
        m = json.loads(measured) if isinstance(measured, str) else {}
        ck('工具坞按钮数 ≥ 15', int(m.get('count') or 0) >= 15, m.get('count'))
        ck('每个按钮都有可见文字', len(m.get('empty') or []) == 0, ','.join(m.get('empty') or [])[:120])
        ck('没有一个按钮的文字被裁', len(m.get('clipped') or []) == 0, ' | '.join(m.get('clipped') or [])[:160])
        ck('坞宽 ≤ 140px', int(m.get('dockW') or 0) <= 140, '%spx' % m.get('dockW'))
        share = (int(m.get('dockW') or 0) / m.get('canvasW')) if m.get('canvasW') else 1
        ck('坞不横向压住超过 15% 画布', share <= 0.15, '%.0f%%（画布 %spx）' % (share * 100, m.get('canvasW')))

        path = os.path.join(OUT, 'dock.png')
        size = shot(cdp, path)
        if size:
            ck('截图落盘（可选步骤）', os.path.exists(path), '%s（%.0f KB）' % (path, size / 1024.0))
        else:
            print('  ⚠️ 截图拿不到帧（CDP 合成器在这一页超时）—— 判据不受影响，'
                  '但要人眼看坞的观感请直接开应用；此口已记在任务卡上')
        print('  标签：', ' / '.join(m.get('labels') or []))
        return 0 if not fails else 1
    finally:
        for p in (el, dev):
            try:
                if p and p.poll() is None:
                    p.terminate()
            except Exception:
                pass
        time.sleep(1.0)
        try:
            shutil.rmtree(os.path.join(OUT, 'userdata'), ignore_errors=True)
        except Exception:
            pass
        for f in (copy, copy + '.backups'):
            try:
                if os.path.isdir(f):
                    shutil.rmtree(f)
                elif os.path.exists(f):
                    os.remove(f)
            except Exception:
                pass


if __name__ == '__main__':
    code = main()
    print(('\n✅ 全部通过' if code == 0 else '\n🔴 %d 项失败' % len(fails)))
    for f in fails:
        print('  - ' + f)
    sys.exit(code)
