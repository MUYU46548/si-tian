#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""**打包产物**冒烟演练：剧本视图「挂载 → 离开」不抛错（2026-10-11 新增）

为什么需要它（本轮真事故）：
  0.2.3 的 `provinceGridTimer is not defined` 只在 `ScenarioMap` 的 **onUnmounted** 上抛
  （用户日志：`[2026-10-11 15:18:31.889] [error] [renderer] provinceGridTimer is not defined
  { component: 'ScenarioMap' }`，栈指向 `app.asar/dist/assets/ScenarioMap-*.js`）。
  而两道既有闸门都够不到它：
    · 93 个 CDP 用例跑在 **Vite dev server** 上，不是打包产物；
    · `drill_quit_flush.py` 的 p4 虽在真机上跑，但**从不离开剧本视图** → 卸载钩子没被执行过。
  本脚本补的就是这个洞：在**打包出来的 app.asar** 上走一遍「进历史剧本 → 返回世界选择」。

三条判据（都带阳性对照，避免"探测器是瞎的"造成假绿）：
  ① 剧本视图真的挂载、点「返回」后真的卸载（否则根本没走到卸载钩子 = 空转）；
  ② 卸载全程**没有** `#sitian-error-overlay`（应用自带的错误覆盖层）；
  ③ 应用自己的错误通道（electron-log → `<userData>/logs/main.log`）**一个字都没写**。
  ⚠️ 阳性对照实测：控制台钩子**会漏**（overlay 与主进程日志才是可靠通道），
     所以脚本末尾会故意抛一个未声明标识符，验证 ②③ 真的会响 —— 不响就是失败。

两种启动方式（被测代码都是同一份 app.asar）：
  · 默认 `asar`：开发版 electron 加载 `release-inst/win-unpacked/resources/app.asar`
    —— **本机唯一跑通的方式**（直接执行 SiTian.exe 在本环境里以 0x80000003 秒退）；
  · `exe`：`SITIAN_PROBE_MODE=exe python scripts/tests/drill_package_smoke.py`
    —— 直接跑 SiTian.exe，在能正常双击启动的机器上用它。

安全（比 drill_quit_flush 更保守）：
  · userData 指到**临时目录**（`--user-data-dir`）→ 真实 `config.json` 与 `logs/main.log` 一字节不动；
  · 只把 config.json **复制**一份进临时 userData（保留 lastProjectPath，才进得了剧本视图）；
  · 跑完核对**真实项目文件 sha256 未变**（实测一致）；
  · 只按 PID 杀自己拉起的进程（**绝不 `/IM`**），并清理临时目录。

用法：
  python scripts/tests/drill_package_smoke.py
  SITIAN_PROBE_MODE=exe python scripts/tests/drill_package_smoke.py
退出码：0 = 全过，1 = 有失败
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))
from lib.cdp import CDP, find_page_ws, wait_for  # noqa: E402

EXE = os.path.join(ROOT, 'release-inst', 'win-unpacked', 'SiTian.exe')
ASAR = os.path.join(ROOT, 'release-inst', 'win-unpacked', 'resources', 'app.asar')
DEV_ELECTRON = os.path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
# exe  = 直接跑 SiTian.exe（最真，但本环境里它以 0x80000003 秒退）
# asar = 用开发版 electron 二进制加载**同一个 app.asar**（启动路径已知可用）
MODE = os.environ.get('SITIAN_PROBE_MODE', 'asar')
PORT = 9224
REAL_CFG = os.path.join(os.environ.get('APPDATA', ''), 'SiTian', 'config.json')
TMP = os.path.join(os.environ.get('TEMP', ROOT), 'sitian-pkg-smoke-%d' % int(time.time()))

RESULT = {'fails': [], 'notes': {}}


def ck(name, cond, detail=''):
    print(('  ✅ ' if cond else '  ❌ ') + name + (('  — ' + str(detail)) if detail else ''))
    if not cond:
        RESULT['fails'].append(name + ((' (' + str(detail) + ')') if detail else ''))


def sha256(p):
    if not p or not os.path.exists(p):
        return None
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def port_pid(port):
    try:
        out = subprocess.run(['netstat', '-ano', '-p', 'tcp'], capture_output=True, text=True).stdout
    except Exception:
        return None
    for line in out.splitlines():
        if (':%d ' % port) in line and 'LISTENING' in line:
            parts = line.split()
            if parts and parts[-1].isdigit():
                return int(parts[-1])
    return None


def main():
    if MODE == 'asar':
        if not os.path.exists(DEV_ELECTRON) or not os.path.exists(ASAR):
            print('asar 模式缺文件：%s / %s' % (DEV_ELECTRON, ASAR))
            return 2
        launch = [DEV_ELECTRON, ASAR]
        print('启动方式：开发版 electron 加载打包的 app.asar')
    else:
        if not os.path.exists(EXE):
            print('找不到打包产物：' + EXE)
            return 2
        launch = [EXE]
    print('被测 app.asar：' + ASAR)
    os.makedirs(TMP, exist_ok=True)
    cfg = json.load(open(REAL_CFG, encoding='utf-8'))
    proj = cfg.get('lastProjectPath') or ''
    shutil.copyfile(REAL_CFG, os.path.join(TMP, 'config.json'))   # 隔离副本
    print('打包产物：' + EXE)
    print('临时 userData：' + TMP)
    print('真实项目：%s（sha 跑前 = %s）' % (proj, (sha256(proj) or '')[:16]))

    before = sha256(proj)
    env = {k: v for k, v in os.environ.items() if k != 'ELECTRON_RUN_AS_NODE'}
    out_p = os.path.join(TMP, 'stdout.txt')
    err_p = os.path.join(TMP, 'stderr.txt')
    proc = subprocess.Popen(
        launch + ['--user-data-dir=' + TMP, '--remote-debugging-port=%d' % PORT,
                  '--remote-allow-origins=*',
                  '--disable-gpu', '--disable-software-rasterizer', '--in-process-gpu', '--no-first-run'],
        env=env, stdout=open(out_p, 'wb'), stderr=open(err_p, 'wb'))
    cdp = None
    try:
        try:
            ws = find_page_ws(PORT, timeout=60)
        except Exception as e:
            # 诊断：进程还活着吗？CDP 端点有没有起来？应用自己写了什么？
            import urllib.request
            diag = {'poll': proc.poll()}
            for url in ('http://127.0.0.1:%d/json/version' % PORT, 'http://127.0.0.1:%d/json' % PORT):
                try:
                    with urllib.request.urlopen(url, timeout=3) as r:
                        diag[url] = r.read().decode('utf-8', 'replace')[:300]
                except Exception as e2:
                    diag[url] = 'ERR ' + str(e2)[:120]
            for p in (err_p, out_p):
                try:
                    diag[os.path.basename(p)] = open(p, 'rb').read().decode('utf-8', 'replace')[-600:]
                except Exception:
                    diag[os.path.basename(p)] = '<无>'
            print('CDP 未就绪，诊断：' + json.dumps(diag, ensure_ascii=False, indent=1))
            raise e
        cdp = CDP(ws)
        wait_for(cdp, "!!document.querySelector('#app')", timeout=60, desc='主界面就绪')
        time.sleep(3.0)
        cdp.eval("window.__errs = [];"
                 " const _oe = console.error;"
                 " console.error = function(){ try { window.__errs.push(Array.from(arguments).map("
                 "   (x) => (x && x.message) || String(x)).join(' ')); } catch(e){} return _oe.apply(console, arguments); };"
                 " window.addEventListener('error', (e) => window.__errs.push('onerror:' + (e.message || '')));"
                 " window.addEventListener('unhandledrejection', (e) => window.__errs.push('rejection:' + ((e.reason && e.reason.message) || '')));"
                 " 'ok'")
        # 首次引导 / 免责声明可能挡着
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find(x => x.textContent.trim() === '跳过'); if (b) b.click(); return !!b; })()")
        time.sleep(0.6)

        r = cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                     ".find(x => (x.textContent || '').includes('历史剧本'));"
                     " if (!b) return 'nobtn'; b.click(); return 'clicked'; })()")
        ck('找得到「历史剧本」入口并点了', r == 'clicked', r)
        mounted = False
        try:
            wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=30, desc='剧本视图挂载')
            mounted = True
        except Exception as e:
            ck('剧本视图挂载（ScenarioMap 组件被创建）', False, str(e)[:120])
        if mounted:
            ck('剧本视图挂载（ScenarioMap 组件被创建）', True, '')
        time.sleep(2.5)
        RESULT['notes']['canvas'] = bool(cdp.eval("!!document.querySelector('.scenario-map-container canvas')"))

        # 🔴 关键动作：离开剧本视图 → 触发 onUnmounted（0.2.3 的崩溃点）
        back = cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                        ".find(x => (x.title || '').includes('返回世界选择'));"
                        " if (!b) return 'noback'; b.click(); return 'back'; })()")
        ck('点得到「返回」（离开剧本视图）', back == 'back', back)
        time.sleep(2.5)
        left = not cdp.eval("!!document.querySelector('.scenario-map-container')")
        ck('剧本视图真的卸载了（否则没走到卸载钩子）', left, '')

        errs = cdp.eval("JSON.stringify(window.__errs || [])")
        try:
            errs = json.loads(errs) if isinstance(errs, str) else []
        except ValueError:
            errs = ['<unparsable>' + str(errs)[:120]]
        bad = [e for e in errs if ('is not defined' in e or 'ReferenceError' in e or 'provinceGridTimer' in e)]
        # ⚠️ 控制台只是**辅助通道**：阳性对照实测它会漏（overlay 与主进程日志才是可靠通道）。
        #    所以这条不作为硬判据，只作参考 —— 硬判据是下面的「无覆盖层」+「日志零字节」。
        ck('（辅助）控制台捕获里没有未声明标识符', not bad, bad[:2] or ('捕获 %d 条其它日志' % len(errs)))
        overlay = bool(cdp.eval("!!document.getElementById('sitian-error-overlay')"))
        ck('卸载剧本视图没有弹出应用内错误覆盖层 #sitian-error-overlay', not overlay, '')
        logp = os.path.join(TMP, 'logs', 'main.log')
        # electron-log 是**首次写入才建文件**的 → "文件不存在"与"0 字节"是同一件事：
        # 应用自己的错误通道在这整段（挂载 → 卸载）里一个字都没写。
        log_size = os.path.getsize(logp) if os.path.exists(logp) else 0
        ck('卸载剧本视图后主进程日志里没有任何错误写入（文件不存在或 0 字节）',
           log_size == 0, '存在=%s 字节=%d' % (os.path.exists(logp), log_size))
        logtxt = ''
        if os.path.exists(logp):
            logtxt = open(logp, encoding='utf-8', errors='replace').read()
        ck('打包产物日志里没有 provinceGridTimer', 'provinceGridTimer' not in logtxt,
           ('日志 %d 字节' % len(logtxt)))
        RESULT['notes']['log_bytes'] = len(logtxt)
        RESULT['notes']['errors_seen'] = errs[:5]
        RESULT['notes']['left_view'] = left

        # ── 阳性对照（本仓纪律：判据必须先被证明"能红"）────────────────────────
        # 上面三条"没有报错"在**探测器是瞎的**时候也会全绿。所以这里故意抛一个
        # 与 0.2.3 同型的错误（未声明标识符），验证：控制台捕获 / 错误覆盖层 /
        # 主进程日志**三个通道都真的会响**。
        log_before = len(logtxt)
        cdp.eval("setTimeout(() => { window.__sitianProbeNeverDeclaredFn(); }, 0); 'ok'")
        time.sleep(2.0)
        ctl = cdp.eval("JSON.stringify(window.__errs || [])")
        try:
            ctl = json.loads(ctl) if isinstance(ctl, str) else []
        except ValueError:
            ctl = []
        ctl_overlay = bool(cdp.eval("!!document.getElementById('sitian-error-overlay')"))
        log_after = ''
        if os.path.exists(logp):
            log_after = open(logp, encoding='utf-8', errors='replace').read()
        hit_err = any('is not defined' in e for e in ctl)
        hit_log = 'is not defined' in log_after
        # 硬判据 = 覆盖层 + 主进程日志（这两个已被证明会响）；控制台只作参考
        ck('阳性对照：故意抛未声明标识符 → 覆盖层与主进程日志都响了（否则上面几条是空转）',
           ctl_overlay and len(log_after) > log_before,
           'overlay=%s 日志 %d→%d 字节；控制台捕获=%s（辅助通道，实测会漏）'
           % (ctl_overlay, log_before, len(log_after), hit_err))
        RESULT['notes']['positive_control'] = {
            'overlay': ctl_overlay, 'log_grew': len(log_after) > log_before,
            'console_channel_reliable': hit_err,
            'log_says': [l for l in log_after.splitlines() if l.strip()][:2],
        }
    finally:
        if cdp:
            cdp.close()
        pid = proc.pid
        try:
            subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'],
                           capture_output=True, text=True, timeout=20)
        except Exception:
            pass
        owner = port_pid(PORT)
        if owner and owner != pid:
            subprocess.run(['taskkill', '/PID', str(owner), '/T', '/F'], capture_output=True, text=True)
        time.sleep(1.0)
        after = sha256(proj)
        ck('真实项目文件未被改动（sha256 一致）', before == after, 'before=%s after=%s' % ((before or '')[:12], (after or '')[:12]))
        shutil.rmtree(TMP, ignore_errors=True)

    print('\n=== 结果: %s ===' % ('全过' if not RESULT['fails'] else ('失败 %d 项' % len(RESULT['fails']))))
    if RESULT['fails']:
        for f in RESULT['fails']:
            print('  - ' + f)
    print('现场：' + json.dumps(RESULT['notes'], ensure_ascii=False))
    return 0 if not RESULT['fails'] else 1


if __name__ == '__main__':
    sys.exit(main())
