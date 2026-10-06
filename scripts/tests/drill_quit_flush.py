#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""退出前落盘 **真机演练**（backlog R4：唯一没有在真机上演练过的数据安全护栏）

护栏本身（`main/index.js` 的 `before-quit` → `app-flush-before-quit` → 渲染层 `flushAll()`
→ `app-flush-done` 回执 → 真退出，2.5s 超时兜底）已有单测与源码守卫。
**但从来没有人真的在真机上"改完立刻退出"过**：单测跑模块，CDP 用例跑 mock
（`saveMapData` 不写盘）—— 两者都到不了「真实 before-quit 拦截 → 真实 IPC 回执 → 真实磁盘」。

做法：起**真实 Electron 进程（dist 产物 + 真实 preload + 真实知识库 + 真实项目文件）**，
用**纯 UI 操作**制造一次「改完立刻退出」，然后**读盘**核对。

⚠️ 为什么不用 `__vue_app__._instance.setupState.store`（CDP 用例的常规手法）：
   那是 **dev-only** 的 —— Vue 只在 `__DEV__ || PROD_DEVTOOLS` 分支里给 `app._instance` 赋值，
   生产构建里是 `null`。所以本演练**不碰 store**，只看 DOM 与磁盘，
   从而能跑在真正的构建产物上（而不是"只能在 dev server 上跑的真机演练"）。

三个阶段（P1 与 P2 互为反面，缺一这次演练就没有说服力）：
  · **P1 负向探针（强杀）**：改完**立即 taskkill** → 磁盘**不该**有改动。
    它不是"证明 kill 会丢"，而是**证明 P2 的成功不是假象** ——
    若防抖保存本来就已偷偷跑过，P2 会在"护栏根本没工作"的情况下也变绿。
  · **P2 正向（Ctrl+Q 退出）**：改完**立即 Ctrl+Q** → 进程正常退出后，磁盘**必须**有改动。
  · **P3 点 × 关窗**（本机 `closeQuitsApp=false`，即默认设置）：改完点 × →
    验证语义 = **最小化到托盘而非退出**（进程还活着、防抖保存随后照常落盘）。

安全措施（务必保留）：
  · 每个阶段**开始前**把项目文件还原成备份（保证三阶段起点一致），**结束时**再还原项目与配置；
  · 只杀自己拉起的进程（`taskkill /PID <pid> /T /F`），**绝不做 `taskkill /IM`**；
  · 演练期间会弹出真实窗口（十几秒），结束后进程退出。

用法：
  python scripts/tests/drill_quit_flush.py            # 三阶段全跑
  python scripts/tests/drill_quit_flush.py --phase p2 # 只跑某一阶段
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

CDP_PORT = 9223
APP_CFG = os.path.join(os.environ.get('APPDATA', ''), 'SiTian', 'config.json')
IMPORT_BTN = "document.querySelector('[data-testid=\"import-from-vault-empty\"]')"

R = []


def ck(phase, name, ok, detail=''):
    R.append((phase, name, bool(ok), detail))
    print('  %s [%s] %s%s' % ('✅' if ok else '❌', phase, name, ('  — ' + str(detail)) if detail else ''))


# ---------------------------------------------------------------- 基础设施
def electron_exe():
    out = subprocess.run(['node', '-e', 'process.stdout.write(require("electron"))'],
                         cwd=ROOT, capture_output=True, text=True)
    p = (out.stdout or '').strip()
    if not p or not os.path.exists(p):
        raise RuntimeError('找不到 electron 可执行文件：%r' % p)
    return p


def wait_cdp(port, timeout=45):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen('http://127.0.0.1:%d/json/version' % port, timeout=1) as r:
                if json.loads(r.read().decode('utf-8')):
                    return True
        except Exception:
            time.sleep(0.4)
    return False


def kill_tree(pid):
    try:
        subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], capture_output=True, timeout=20)
    except Exception:
        pass


def port_owner_pid(port=CDP_PORT):
    """占用调试端口的那个 pid —— 也就是真正的 Electron 浏览器主进程。

    🔴 为什么不能只杀 `Popen.pid`：Electron 的启动器与浏览器进程之间还隔着一层，
    `taskkill /T` 依赖**进程父子链**，中间那层一死，子进程就被重新挂靠、**杀不到**。
    实测后果不是"演练失败"这么轻 —— 残留实例继续占着 9223，下一次 `wait_cdp` 会
    连上**上一轮的旧实例**（页面文字里还留着上一轮的状态），演练结论直接作废。
    所以一律**按端口找进程**，只杀我们自己的那个端口占用者（绝不做 `taskkill /IM`）。
    """
    try:
        # ⚠️ 中文 Windows 的 netstat 输出不是 UTF-8（代码页 GBK）→ 直接 text=True 会
        #    UnicodeDecodeError，异常被吞掉后 `out` 变 None（表现为 AttributeError，很难读）。
        #    这里按字节取回后 utf-8 + replace 解码：我们要的那行（TCP … LISTENING <pid>）是纯 ASCII。
        raw = subprocess.run(['netstat', '-ano'], capture_output=True, timeout=20).stdout
        out = raw.decode('utf-8', 'replace')
    except Exception:
        return None
    for line in out.splitlines():
        if (':%d' % port) in line and 'LISTENING' in line:
            try:
                return int(line.split()[-1])
            except Exception:
                continue
    return None


def free_port(port=CDP_PORT, tries=3):
    """清掉上一轮残留（按端口精确定位），确保新实例真的绑上 9223。"""
    for _ in range(tries):
        pid = port_owner_pid(port)
        if not pid:
            return True
        kill_tree(pid)
        time.sleep(1.5)
    return port_owner_pid(port) is None


def entity_count(proj):
    """直接读项目文件 —— **磁盘是唯一判据**。"""
    try:
        d = json.load(open(proj, encoding='utf-8'))
        return len(d.get('entities') or {})
    except Exception:
        return -1


def sha(path):
    try:
        return hashlib.sha256(open(path, 'rb').read()).hexdigest()[:16]
    except Exception:
        return '-'


class App:
    """起一个真实 Electron 实例（生产路径：加载 dist，用真实 preload 与真实 IPC）。"""

    def __init__(self):
        self.proc = None
        self.cdp = None

    def __enter__(self):
        env = dict(os.environ)
        env.pop('NODE_ENV', None)              # 非 development → loadFile(dist/index.html)
        env.pop('OPEN_DEVTOOLS', None)
        # 🔴 必删：受管终端常预设 ELECTRON_RUN_AS_NODE=1，那会让 electron.exe **退化成纯 node**
        #    （`require('electron')` 只返回路径、`app` 为 undefined）→ electron-updater 启动即
        #    TypeError、CDP 端口永不监听。看起来像"环境坏了"，其实就是这一行。
        env.pop('ELECTRON_RUN_AS_NODE', None)
        exe = electron_exe()
        # 🔴 GPU 三件套：本机 GPU 进程会以 0xC0000005 反复崩，最后
        #    `FATAL: GPU process isn't usable. Goodbye.` 带走整个应用（窗口闪一下就没）。
        #    `--remote-allow-origins` 是 Chromium 111+ 对 DevTools WebSocket 的 Origin 校验兜底。
        free_port()                       # 上一轮残留会抢走 CDP，必须先清（按端口，不按进程名）
        logf = open(os.path.join(ROOT, 'backups', 'electron-drill.log'), 'a', encoding='utf-8')
        self._logf = logf
        self.proc = subprocess.Popen(
            [exe, '.', '--remote-debugging-port=%d' % CDP_PORT,
             '--disable-gpu', '--disable-software-rasterizer', '--in-process-gpu',
             '--remote-allow-origins=*'],
            cwd=ROOT, env=env, stdout=logf, stderr=logf,
        )
        if not wait_cdp(CDP_PORT):
            raise RuntimeError('CDP 端口未就绪（见 backups/electron-drill.log）')
        from lib.cdp import CDP, wait_for
        self.cdp = CDP(port=CDP_PORT)
        self.owner_pid = port_owner_pid() or self.proc.pid   # 真正的浏览器主进程
        wait_for(self.cdp, "!!document.querySelector('.app-layout')", timeout=45, desc='应用挂载')
        # 「导入知识库内容」按钮只在 **项目态 + 空项目 + 世界视图** 下渲染 ——
        # 它同时证明「应用起来了」与「上次的项目已被自动恢复」，是最好用的就绪探针。
        # ⚠️ 超时必须把**页面文字**打出来：超时也可能是"停在只读态/世界列表"等别的原因，
        #    只报「等待超时」等于把最有用的一条线索丢掉。
        try:
            wait_for(self.cdp, "!!" + IMPORT_BTN, timeout=60, desc='项目态就绪（导入入口可见）')
        except Exception as e:
            txt = self.cdp.eval("document.body.innerText.slice(0, 400)")
            raise RuntimeError('%s；页面文字：%r' % (e, txt))
        return self

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def wait_exit(self, timeout=30):
        end = time.time() + timeout
        while time.time() < end and self.alive():
            time.sleep(0.3)
        return not self.alive()

    def kill(self):
        """硬杀（P1 负向探针用）：按端口杀真正的浏览器主进程 + 我们记录的 pid。"""
        for pid in {port_owner_pid(), getattr(self, 'owner_pid', None), self.proc.pid}:
            if pid:
                kill_tree(pid)

    def __exit__(self, *a):
        try:
            if self.cdp:
                self.cdp.close()
        except Exception:
            pass
        if self.alive() or port_owner_pid():
            self.kill()
            self.wait_exit(10)


def ctrl_q(cdp):
    for t in ('rawKeyDown', 'keyUp'):
        cdp.send('Input.dispatchKeyEvent', {
            'type': t, 'modifiers': 2, 'key': 'q', 'code': 'KeyQ',
            'windowsVirtualKeyCode': 81, 'nativeVirtualKeyCode': 81,
        })


def click_import_and_wait_applied(cdp, timeout=45):
    """点「导入知识库内容」→ 等画布真的被填充（按钮消失 = 空态结束）。

    为什么必须等到这一刻再动手：要把「改动已产生、但 800ms 防抖还没跑」这个窗口卡死，
    否则 P1/P2 都可能变成空转（P1 假绿：改动本来就没产生；P2 假绿：防抖早已落盘）。
    """
    from lib.cdp import wait_for
    r = cdp.eval("(() => { const b = %s; if (!b) return 'no-btn'; b.click(); return 'ok'; })()" % IMPORT_BTN)
    if r != 'ok':
        return False, '找不到/点不动「导入知识库内容」：%r' % r
    try:
        wait_for(cdp, "!" + IMPORT_BTN, timeout=timeout, desc='导入已落到画布')
    except Exception:
        return False, '导入没有落到画布（按钮仍在）'
    return True, '导入已落到画布（此刻防抖 800ms 尚未到期）'


# ---------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--phase', default='all', choices=['all', 'p1', 'p2', 'p3'])
    args = ap.parse_args()

    if not os.path.exists(APP_CFG):
        print('找不到应用配置：%s' % APP_CFG)
        return 2
    cfg = json.load(open(APP_CFG, encoding='utf-8'))
    proj = cfg.get('lastProjectPath', '')
    if not proj or not os.path.exists(proj):
        print('配置里的 lastProjectPath 不存在：%r' % proj)
        return 2

    ts = time.strftime('%Y%m%d-%H%M%S')
    bak = os.path.join(ROOT, 'backups', 'drill-' + ts)
    os.makedirs(bak, exist_ok=True)
    proj_bak = os.path.join(bak, os.path.basename(proj))
    shutil.copy2(proj, proj_bak)
    shutil.copy2(APP_CFG, os.path.join(bak, 'config.json'))

    print('=== 退出前落盘真机演练 ===')
    print('项目：%s（起始 实体=%d sha=%s）' % (proj, entity_count(proj), sha(proj)))
    print('备份：%s' % bak)
    print('⚠️ 会弹出真实应用窗口，十几秒后自动退出\n')

    phases = ['p1', 'p2', 'p3'] if args.phase == 'all' else [args.phase]
    try:
        for ph in phases:
            shutil.copy2(proj_bak, proj)      # 每阶段起点一致（空项目）
            run_phase(ph, proj)
    finally:
        shutil.copy2(proj_bak, proj)
        shutil.copy2(os.path.join(bak, 'config.json'), APP_CFG)
        print('\n已还原项目与配置（项目 sha=%s，实体=%d）' % (sha(proj), entity_count(proj)))

    print('\n==== 汇总 ====')
    for ph, name, ok, detail in R:
        print('  %s [%s] %s%s' % ('✅' if ok else '❌', ph, name, ('  — ' + str(detail)) if detail else ''))
    bad = [r for r in R if not r[2]]
    print('\n%s' % ('全部通过（%d/%d）' % (len(R), len(R)) if not bad
                    else '失败 %d 项（共 %d）' % (len(bad), len(R))))
    return 0 if not bad else 1


def run_phase(ph, proj):
    print('--- %s ---' % ph)
    n0 = entity_count(proj)
    ck(ph, '起点：项目是空的（实体 0）', n0 == 0, '实体=%d' % n0)

    with App() as app:
        ok, why = click_import_and_wait_applied(app.cdp)
        ck(ph, '已通过 UI 触发一次真实改动（导入知识库内容）', ok, why)
        if not ok:
            return

        if ph == 'p1':
            app.kill()                        # 立刻强杀：不给 800ms 防抖任何机会
            app.wait_exit(15)
            time.sleep(1.5)
            n = entity_count(proj)
            ck('p1', '🔴 强杀后磁盘上**没有**这次改动（证明防抖确实没来得及跑 → P2 才有说服力）',
               n == 0, '磁盘实体=%d（应为 0）' % n)

        elif ph == 'p2':
            ctrl_q(app.cdp)
            exited = app.wait_exit(40)
            ck('p2', 'Ctrl+Q 让进程真的退出了', exited, 'alive=%s' % app.alive())
            time.sleep(1.5)
            n = entity_count(proj)
            ck('p2', '🔴 退出前落盘生效：正常退出后磁盘上**有**这次改动', n > 0, '磁盘实体=%d' % n)

        else:  # p3
            app.cdp.eval("window.close(); 'ok'")
            time.sleep(3.0)
            ck('p3', '点 × 不退出进程（closeQuitsApp=false → 最小化到托盘）', app.alive(),
               'alive=%s' % app.alive())
            time.sleep(2.5)   # 进程还活着 → 防抖保存（800ms×2 层）应当已落盘
            n = entity_count(proj)
            ck('p3', '点 × 之后改动仍会落盘（不存在丢数据的窗口）', n > 0, '磁盘实体=%d' % n)
            if app.alive():
                ctrl_q(app.cdp)
                app.wait_exit(25)
            ck('p3', '随后 Ctrl+Q 能正常收尾', not app.alive(), 'alive=%s' % app.alive())


if __name__ == '__main__':
    sys.exit(main())
