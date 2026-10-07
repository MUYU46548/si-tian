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
  python scripts/tests/drill_quit_flush.py --phase p4 # 只跑「剧本基础操作」真机演练
     （建省 / 拖边界 / 右键删省 / 剧本 增·改·删 —— 每步都**读项目文件**核对落盘）
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
    """起一个真实 Electron 实例（生产路径：加载 dist，用真实 preload 与真实 IPC）。

    `require_import=False` 供「项目非空」的剧本演练用：那种情况下「导入知识库内容」
    按钮根本不存在（它只渲染在**空项目**的世界视图），不能拿它当就绪探针。
    """

    def __init__(self, require_import=True):
        self.proc = None
        self.cdp = None
        self.require_import = require_import

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
        # 项目**非空**时该按钮不存在（剧本演练 p4 就是这种情况，见 require_import）→
        # 退到「世界视图已挂载 + 历史剧本入口在」。
        probe = ("!!" + IMPORT_BTN) if self.require_import else (
            "!!document.querySelector('.app-layout')"
            " && Array.from(document.querySelectorAll('button'))"
            ".some(b => (b.textContent || '').includes('历史剧本'))")
        try:
            wait_for(self.cdp, probe, timeout=60, desc='项目态就绪（入口可见）')
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
    ap.add_argument('--phase', default='all', choices=['all', 'p1', 'p2', 'p3', 'p4'])
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

    # 「all」= 退出链三段 + 剧本基础操作一段；p4 只做 UI 操作 + 读盘，不碰退出语义
    phases = ['p1', 'p2', 'p3', 'p4'] if args.phase == 'all' else [args.phase]
    try:
        for ph in phases:
            shutil.copy2(proj_bak, proj)      # 每阶段起点一致（空项目）
            if ph == 'p4':
                run_phase_scenario(proj)
            else:
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


# ---------------------------------------------------------------- 剧本基础操作（p4）
#
# 为什么另开一段：p1~p3 只演练「退出前落盘」，而**剧本视图的基础操作**（建省 / 拆分裂界 /
# Ctrl+Z 撤销 / 右键删省 / 剧本增改删）从来没在真机上走过 —— CDP 用例跑的是 mock（`saveScenarios` 不写盘），
# 到不了「真实组件 → 真实 store → 真实防抖 → 真实项目文件」。本段**纯 UI 驱动 + 读盘核对**，
# 因此能跑在生产构建上（`__vue_app__._instance` 在 dist 里是 null，碰不到 store）。
#
# ⚠️ 只在**没有真实任务在跑**时用：会开一个真实窗口；跑前备份项目、跑后还原。

def read_project(proj):
    try:
        return json.load(open(proj, encoding='utf-8'))
    except Exception:
        return {}


def project_scenarios(doc):
    """项目文件里的 scenarios 容器（baseMaps / scenarios）。"""
    sc = doc.get('scenarios') or {}
    return (sc.get('baseMaps') or {}), (sc.get('scenarios') or {})


def wait_disk(proj, pred, timeout=20.0, interval=0.4):
    """轮询磁盘直到 pred(doc) 成立。

    🔴 判据一律是**磁盘**：剧本/地图都有 300ms + 800ms 两层防抖，
    内存里"已经改了"完全说明不了落盘（这正是本项目最贵的两类 bug 的共同前提）。
    """
    end = time.time() + timeout
    doc = {}
    while time.time() < end:
        doc = read_project(proj)
        try:
            if pred(doc):
                return True, doc
        except Exception:
            pass
        time.sleep(interval)
    return False, doc


def open_toolbar_more(cdp):
    """展开剧本工具栏的「更多」。

    ⚠️ 底图下拉、剧本管理入口、图层行**都在 `.toolbar-more` 里**（P3 起默认收起，
    `v-if="moreOpen"` → 不展开的话 `querySelector` 直接查不到）。幂等。
    """
    cdp.eval("(() => { const b = Array.from(document.querySelectorAll('.scenario-toolbar button'))"
             ".find(x => (x.title || '').includes('更多'));"
             " if (b && !document.querySelector('.toolbar-more')) b.click(); return 'ok'; })()")
    time.sleep(0.45)
    return bool(cdp.eval("!!document.querySelector('.toolbar-more')"))


def enter_scenario_view(cdp):
    from lib.cdp import wait_for
    cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
             ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=30, desc='剧本视图挂载')
    time.sleep(1.6)
    # 删除/压叠都要确认框；真机演练里没人点 → 打桩（演练对象是数据流，不是对话框）
    cdp.eval("window.confirm = () => true; window.prompt = () => '演练'; 'ok'")
    open_toolbar_more(cdp)
    return True


def basemap_key(cdp):
    return cdp.eval("(() => { const el = document.querySelector('.basemap-select');"
                    " return el ? el.value : ''; })()")


DRAW_JS = r"""(async () => {
  const cvs = document.querySelector('.scenario-map-container canvas');
  if (!cvs) return JSON.stringify({ err: 'no-canvas' });
  const settle = (ms) => new Promise((r) => setTimeout(r, ms || 60));
  const rr = cvs.getBoundingClientRect();
  const mk = (t, x, y) => new MouseEvent(t, {
    clientX: rr.left + x, clientY: rr.top + y, bubbles: true, cancelable: true, button: 0,
  });
  // 抖动的圆：≥10 个采样点才会被当成「一笔成型」（FREE_TRACE_MIN_POINTS=10）
  const cx = Math.round(rr.width / 2), cy = Math.round(rr.height / 2);
  const R = Math.max(50, Math.round(Math.min(rr.width, rr.height) * 0.2));
  const pts = [];
  for (let i = 0; i <= 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    const r = R * (1 + 0.1 * Math.sin(i * 1.7));
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  cvs.dispatchEvent(mk('mousedown', pts[0].x, pts[0].y));
  for (let i = 1; i < pts.length; i++) cvs.dispatchEvent(mk('mousemove', pts[i].x, pts[i].y));
  const last = pts[pts.length - 1];
  cvs.dispatchEvent(mk('mouseup', last.x, last.y));
  cvs.dispatchEvent(mk('click', last.x, last.y));
  // 🔴 必须等一拍再读：Vue 的 DOM 更新是**异步**的（focusNewProvince 里的 showProps 要 nextTick 才生效）
  //    —— 同一个 tick 里读 `.props-name` 永远是空，会把"建省成功"误判成"没建出来"（本轮实测踩过）。
  await settle(350);
  const nm = document.querySelector('.props-name');
  const hint = (Array.from(document.querySelectorAll('.draw-hint')).map((e) => e.textContent.trim())
    .find((t) => t.indexOf('省') >= 0) || '');
  return JSON.stringify({ ok: true, name: nm ? nm.value : '', hint: hint.slice(0, 90) });
})()"""


# 扫描定位：用「选择」工具逐点点击，谁让 `.props-name` 等于目标省名，谁就是命中点。
# 为什么不记坐标：新增省份会触发 `setTimeout(fitToView, 50)` 自动适屏 → 屏幕几何会变。
# 为什么取**命中点的质心**而不是第一个命中点：后续「拆分」要在省内取两个点，
# 靠边界的命中点会让切割线一端落到省外（拆分直接失败）。质心才稳。
SCAN_JS = r"""(async () => {
  const cvs = document.querySelector('.scenario-map-container canvas');
  if (!cvs) return JSON.stringify({ ok: false, err: 'no-canvas' });
  const rr = cvs.getBoundingClientRect();
  const cw = Math.round(rr.width), ch = Math.round(rr.height);
  // 🔴 让位只要一个**微任务级**的 0ms 定时器就够（Vue 的 DOM flush 是微任务），
  //    早先用 18ms 会让几百次探测累积成十几秒 → 直接撞上 CDP 客户端的 15s 读超时。
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const mk = (x, y) => new MouseEvent('click', {
    clientX: rr.left + x, clientY: rr.top + y, bubbles: true, cancelable: true, button: 0,
  });
  const nameOf = () => { const el = document.querySelector('.props-name'); return el ? el.value : ''; };
  const want = WANT_NAME;
  const hits = [];
  let tried = 0;
  // 🔴 墙钟上限：无论扫到哪都≤8s 返回。CDP 客户端的读超时是 **15s**，
  //    扫描一旦跑飞就是 WebSocketTimeoutException 把整段演练**崩掉**（本轮实测两次），
  //    而不是给出一条可读的失败原因 —— 演练脚本宁可"报没找到"，也不能崩。
  const deadline = Date.now() + 8000;
  const probe = async (x, y) => {
    cvs.dispatchEvent(mk(x, y));
    tried++;
    await settle();
    if (nameOf() === want) hits.push({ x, y });
  };

  // ① 先试画布中心：新建的省在原画布中央（底图里只有它时适屏后就在正中）
  await probe(Math.round(cw / 2), Math.round(ch / 2));

  // ② 还不够就扫**中心区域**的粗网格（±35% 画布，步长 45），上限 400 次探测防跑飞
  const STEP = 45;
  const x0 = Math.round(cw * 0.15), x1 = Math.round(cw * 0.85);
  const y0 = Math.round(ch * 0.15), y1 = Math.round(ch * 0.85);
  for (let y = y0; y <= y1 && hits.length < 6; y += STEP) {
    for (let x = x0; x <= x1 && hits.length < 6; x += STEP) {
      await probe(x, y);
      if (tried > 400 || Date.now() > deadline) break;
    }
    if (tried > 400 || Date.now() > deadline) break;
  }

  if (!hits.length) return JSON.stringify({ ok: false, name: nameOf(), tried });
  const cx = Math.round(hits.reduce((a, h) => a + h.x, 0) / hits.length);
  const cy = Math.round(hits.reduce((a, h) => a + h.y, 0) / hits.length);
  return JSON.stringify({ ok: true, x: cx, y: cy, hits: hits.length, tried });
})()"""


# 「拆分」工具：两次点击定义切割线（两点都要落在同一个省内）
SPLIT_JS = r"""(async () => {
  const cvs = document.querySelector('.scenario-map-container canvas');
  const settle = (ms) => new Promise((r) => setTimeout(r, ms || 80));
  const rr = cvs.getBoundingClientRect();
  const mk = (t, x, y) => new MouseEvent(t, {
    clientX: rr.left + x, clientY: rr.top + y, bubbles: true, cancelable: true, button: 0,
  });
  const x = HIT_X, y = HIT_Y, d = 45;
  cvs.dispatchEvent(mk('click', x - d, y));
  await settle();
  cvs.dispatchEvent(mk('click', x + d, y));
  await settle(200);
  const hint = (Array.from(document.querySelectorAll('.draw-hint')).map((e) => e.textContent.trim())
    .find((t) => t.indexOf('拆') >= 0) || '');
  return JSON.stringify({ ok: true, hint: hint.slice(0, 90) });
})()"""




CTX_DELETE_JS = r"""(async () => {
  const cvs = document.querySelector('.scenario-map-container canvas');
  const settle = (ms) => new Promise((r) => setTimeout(r, ms || 60));
  const rr = cvs.getBoundingClientRect();
  const ev = new MouseEvent('contextmenu', {
    clientX: rr.left + HIT_X, clientY: rr.top + HIT_Y, bubbles: true, cancelable: true, button: 2, buttons: 2,
  });
  cvs.dispatchEvent(ev);
  await settle(180);          // 菜单是 v-if 渲染的 → 必须等一拍才在 DOM 里
  const menu = document.querySelector('.context-menu');
  const items = menu ? Array.from(menu.querySelectorAll('.ctx-item')).map(x => (x.textContent || '').trim()) : [];
  const del = document.querySelector('.context-menu .ctx-item.danger');
  if (!del) return JSON.stringify({ ok: false, items, prevented: ev.defaultPrevented });
  del.click();
  await settle(150);
  return JSON.stringify({ ok: true, items, prevented: ev.defaultPrevented });
})()"""


def jsobj(cdp, expr):
    """求值并解析 JSON —— **绝不抛异常**：JS 抛错/返回非 JSON 都变成 {ok:False, err:...}。

    为什么必须有：`cdp.eval` 在 JS 异常时返回 `{'__err__': …}`（dict），
    直接 `json.loads(dict)` 会把整段演练**崩在 TypeError 上**，真正的 JS 错误反而看不见
    （本轮实测踩过：真凶是"点错了按钮导致画布没了"，却被崩栈盖住）。
    """
    v = cdp.eval(expr)
    if isinstance(v, dict):
        return {'ok': False, 'err': str(v.get('__err__'))[:260]}
    try:
        return json.loads(v or '{}')
    except Exception as e:
        return {'ok': False, 'err': 'JSON 解析失败 %s ｜ 原始：%r' % (e, str(v)[:120])}


def province_names_in(doc, key):
    bm = (project_scenarios(doc)[0] or {}).get(key) or {}
    return [p.get('name') for p in (bm.get('terrain') or [])]


def select_tool(cdp, title_part):
    """按 title 片段点工具按钮。

    ⚠️ 片段要够独特：**「更多」按钮的 title 里把所有高级工具名都列了一遍**
    （"拆分 / 合并 / 点击填充 / …"），按 '拆分' 找会先命中「更多」。用 '拆分省份' 这类才是唯一。
    """
    return cdp.eval(
        "(() => { const b = Array.from(document.querySelectorAll('.scenario-toolbar button'))"
        ".find(x => (x.title || '').includes(%s)); if (!b) return 'no-btn'; b.click(); return 'ok'; })()"
        % json.dumps(title_part))


def ctrl_z(cdp):
    for t in ('rawKeyDown', 'keyUp'):
        cdp.send('Input.dispatchKeyEvent', {
            'type': t, 'modifiers': 2, 'key': 'z', 'code': 'KeyZ',
            'windowsVirtualKeyCode': 90, 'nativeVirtualKeyCode': 90,
        })


def open_scenario_manager(cdp):
    open_toolbar_more(cdp)
    cdp.eval('(() => { const b = document.querySelector(\'.scenario-toolbar button[title="剧本管理"]\');'
             " if (b) b.click(); return 'ok'; })()")
    time.sleep(0.4)
    return bool(cdp.eval("!!document.querySelector('.scenario-manager')"))


SET_INPUT = r"""const setInput = (el, v) => {
  const st = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  st.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};"""


def scenario_create(cdp, name):
    js = r"""(async () => {
      SETINPUT
      // 🔴 setInput 之后必须**等一拍**：`:disabled="!newScenario.name"` 要等 Vue flush 才写回 DOM，
      //    同一 tick 里读到的还是旧 disabled、而 `el.click()` 对 disabled 按钮是**静默 no-op**
      //    （既不建也不报错 —— 本轮实测就是被这一点挡住）。
      const settle = () => new Promise((r) => setTimeout(r, 0));
      const form = document.querySelector('.new-scenario-form');
      if (!form) return JSON.stringify({ ok: false, err: 'no-form' });
      const inputs = Array.from(form.querySelectorAll('input'));
      const put = (ph, v) => { const el = inputs.find(x => (x.placeholder || '').includes(ph)); if (el) setInput(el, v); };
      put('第一时代', NAME);
      put('Ⅰ', 'Ⅰ');
      put('2006', '2000');
      put('2008', '2010');
      await settle();
      const nm = inputs.find(x => (x.placeholder || '').includes('第一时代'));
      const btn = document.querySelector('[data-testid="scenario-create"]');
      if (!btn) return JSON.stringify({ ok: false, err: 'no-create-btn' });
      // 🔴 回传诊断而不是"点了就报 ok"：按钮是 `:disabled="!newScenario.name"`，
      //    表单没填进去的话 click() 是**静默 no-op**（既不建也不报错）。
      const before = document.querySelectorAll('.scenario-item').length;
      const info = { nameVal: nm ? nm.value : null, disabled: !!btn.disabled, before };
      if (btn.disabled) return JSON.stringify(Object.assign({ ok: false, err: 'create-btn-disabled' }, info));
      btn.click();
      await settle();
      info.after = document.querySelectorAll('.scenario-item').length;
      info.dialogOpen = !!document.querySelector('.scenario-manager');
      return JSON.stringify(Object.assign({ ok: true }, info));
    })()""".replace('SETINPUT', SET_INPUT).replace('NAME', json.dumps(name))
    return jsobj(cdp, js)


def scenario_edit(cdp, old_name, new_name):
    js = r"""(async () => {
      SETINPUT
      const settle = () => new Promise((r) => setTimeout(r, 0));
      const item = Array.from(document.querySelectorAll('.scenario-item'))
        .find(it => (it.textContent || '').includes(OLD));
      if (!item) return JSON.stringify({ ok: false, err: 'no-item',
        items: Array.from(document.querySelectorAll('.scenario-item')).map(x => (x.textContent || '').trim().slice(0, 30)) });
      item.querySelector('[data-testid="scenario-edit"]').click();
      await settle();          // 等 Vue 把该剧本的值 patch 进表单再读（否则读到空串）
      const form = document.querySelector('.new-scenario-form');
      const inputs = Array.from(form.querySelectorAll('input'));
      const nm = inputs.find(x => (x.placeholder || '').includes('第一时代'));
      const sy = inputs.find(x => (x.placeholder || '').includes('2006'));
      const ey = inputs.find(x => (x.placeholder || '').includes('2008'));
      if (!nm || !sy || !ey) return JSON.stringify({ ok: false, err: 'no-inputs' });
      const filled = { name: nm.value, start: sy.value, end: ey.value };
      setInput(nm, NEW); setInput(sy, '1990'); setInput(ey, '1995');
      await settle();          // 同上：`:disabled` 要等 flush
      const save = document.querySelector('[data-testid="scenario-save-edit"]');
      if (!save) return JSON.stringify({ ok: false, err: 'no-save', filled });
      if (save.disabled) return JSON.stringify({ ok: false, err: 'save-disabled', filled });
      save.click();
      await settle();
      return JSON.stringify({ ok: true, filled });
    })()""".replace('SETINPUT', SET_INPUT).replace('OLD', json.dumps(old_name)).replace('NEW', json.dumps(new_name))
    return jsobj(cdp, js)


def scenario_delete(cdp, name):
    js = r"""(async () => {
      const settle = () => new Promise((r) => setTimeout(r, 0));
      const item = Array.from(document.querySelectorAll('.scenario-item'))
        .find(it => (it.textContent || '').includes(NAME));
      if (!item) return JSON.stringify({ ok: false, err: 'no-item' });
      const b = item.querySelector('[data-testid="scenario-delete"]');
      if (!b) return JSON.stringify({ ok: false, err: 'no-btn' });
      if (b.disabled) return JSON.stringify({ ok: false, err: 'delete-disabled' });
      b.click();
      await settle();
      return JSON.stringify({ ok: true });
    })()""".replace('NAME', json.dumps(name))
    return jsobj(cdp, js)


def run_phase_scenario(proj):
    """p4：剧本基础操作（建省 / 移边界 / 删省 / 剧本增改删）——纯 UI + 读盘核对。

    ⚠️ 与 p1~p3 不同，**本段不要求空项目**：所有判据都是相对基线（先读盘记下省份数/剧本名，
    再比对增量），所以在有内容（甚至就是真实项目）的库上照样能跑。跑完由 main() 还原项目文件。
    """
    print('--- p4 ---')
    n0 = entity_count(proj)
    if n0 == 0:
        print('  · [p4] 起点：项目是空的（实体 0）')
    else:
        print('  · [p4] 起点：项目已有 %d 个实体 —— 本段全程用相对基线，不要求空项目' % n0)

    with App(require_import=False) as app:
        cdp = app.cdp
        # 导入只是"给项目一些内容"的常规起点；项目非空时那个空态按钮不存在 → 跳过即可
        ok, why = click_import_and_wait_applied(cdp, timeout=20)
        if ok:
            ck('p4', '已通过 UI 导入知识库内容（真机起点）', True, why)
        else:
            print('  · [p4] 跳过导入（项目非空 / 入口不可见）：%s' % why)
        enter_scenario_view(cdp)

        ck('p4', '剧本画布已挂载', bool(cdp.eval(
            "!!document.querySelector('.scenario-map-container canvas')")), '')

        # 🔴 必须在**有底图之后**读这个键：项目里一张底图都没有时 `.basemap-select` 的值是 `''`，
        #    拿空键去查磁盘会永远查不到（本轮实测：三条 ck 全错，其中"删除已落盘（回到 0）"还
        #    因为期望值也是 0 而**空转通过** —— 基线取错 = 断言作废）。
        #    底图是「第一次落笔时懒建」的，所以先用一笔落笔把底图催出来。
        key = basemap_key(cdp)
        if not key:
            r0 = jsobj(cdp, DRAW_JS)
            ck('p4', '空底图下第一次落笔会懒建一张底图', bool(r0.get('name')), '省名=%r' % r0.get('name'))
            key = basemap_key(cdp)
        ck('p4', '剧本视图里已选中一张底图', bool(key), '底图=%r' % key)
        if not key:
            return
        ok, doc = wait_disk(proj, lambda d: bool((project_scenarios(d)[0] or {}).get(key)))
        ck('p4', '懒建的底图/省份真的落进了项目文件', ok,
           '底图=%r ｜ 项目里现有底图：%s' % (key, list(project_scenarios(doc)[0])[:3]))
        n_before = len(province_names_in(doc, key))

        # ① 创建省份边界（自由绘制「一笔成型」）
        r = jsobj(cdp, DRAW_JS)
        ck('p4', '自由绘制一笔成型，并拿到新省名', bool(r.get('ok') and r.get('name')), '省名=%r' % r.get('name'))
        if not r.get('ok') or not r.get('name'):
            return
        pname = r['name']
        ok, doc = wait_disk(proj, lambda d: len(province_names_in(d, key)) == n_before + 1)
        ck('p4', '🔴 新建省份**已落盘**（terrain %d → %d）' % (n_before, n_before + 1), ok,
           '磁盘省份数=%d' % len(province_names_in(doc, key)))

        # ② 编辑省份边界：用「拆分省份」工具把这一省切成两块 → 磁盘 terrain +1
        #    为什么选拆分：它是**真正的边界编辑**（几何被切开、两半各自成型），
        #    而顶点手柄拖拽要靠 8px 命中，真机上没有 store 可查，稳定性差。
        # ⚠️ 片段必须唯一：'选择' 会先命中**「返回世界选择」**（title 里含"选择"且排在最前）
        #    → 一次点击直接退出剧本视图（画布没了，后面全错）。必须写 '选择 (V)'。
        ck('p4', '切到「选择」工具', select_tool(cdp, '选择 (V)') == 'ok', '')
        time.sleep(0.3)
        scan = jsobj(cdp, SCAN_JS.replace('WANT_NAME', json.dumps(pname)))
        ck('p4', '在画布上定位到刚建的省份（取命中点质心）', bool(scan.get('ok')),
           ('质心 (%s, %s)，命中 %s 点 / 试了 %s 点' % (scan.get('x'), scan.get('y'),
                                                    scan.get('hits'), scan.get('tried')))
           if scan.get('ok') else str(scan))
        if not scan.get('ok'):
            return

        ck('p4', '切到「拆分省份」工具', select_tool(cdp, '拆分省份') == 'ok', '')
        time.sleep(0.3)
        sp = jsobj(cdp, SPLIT_JS.replace('HIT_X', str(scan['x'])).replace('HIT_Y', str(scan['y'])))
        ok, doc2 = wait_disk(proj, lambda d: len(province_names_in(d, key)) == n_before + 2)
        ck('p4', '🔴 拆分改边界**已落盘**（terrain %d → %d）' % (n_before + 1, n_before + 2), ok,
           '磁盘省份数=%d；画布提示=%s' % (len(province_names_in(doc2, key)), sp.get('hint')))

        # 撤销这条拆分（Ctrl+Z 也是纯 UI 路径；顺带证明撤销同样落盘）
        if ok:
            ctrl_z(cdp)
            ok2, doc3 = wait_disk(proj, lambda d: len(province_names_in(d, key)) == n_before + 1)
            ck('p4', '🔴 Ctrl+Z 撤销拆分**已落盘**（回到 %d）' % (n_before + 1), ok2,
               '磁盘省份数=%d' % len(province_names_in(doc3, key)))

        # ③ 删除省份：真右键 → 菜单 → 删除（走的就是本轮刚修好的 contextmenu 入口）
        select_tool(cdp, '选择 (V)')
        time.sleep(0.4)
        rescan = jsobj(cdp, SCAN_JS.replace('WANT_NAME', json.dumps(pname)))
        if not rescan.get('ok'):
            ck('p4', '重新定位该省（准备删除）', False, rescan)
        else:
            dm = jsobj(cdp, CTX_DELETE_JS.replace('HIT_X', str(rescan['x'])).replace('HIT_Y', str(rescan['y'])))
            ck('p4', '真实右键打开省份菜单且四项齐全',
               bool(dm.get('ok') and len(dm.get('items') or []) >= 4),
               '菜单项=%s（原生菜单已拦：%s）' % (dm.get('items'), dm.get('prevented')))
            ok, doc4 = wait_disk(proj, lambda d: len(province_names_in(d, key)) == n_before)
            ck('p4', '🔴 删除省份**已落盘**（terrain 回到 %d）' % n_before, ok,
               '磁盘省份数=%d' % len(province_names_in(doc4, key)))

        # ④ 剧本：创建 / 编辑 / 删除（三条都读盘核对）
        if not open_scenario_manager(cdp):
            ck('p4', '剧本管理对话框可打开', False, '找不到 .scenario-manager')
            return
        ts = time.strftime('%H%M%S')
        sname, sname2 = '演练剧本-' + ts, '演练剧本-' + ts + '-改名'
        r = scenario_create(cdp, sname)
        ok, doc4 = wait_disk(proj, lambda d: any(s.get('name') == sname
                                                for s in project_scenarios(d)[1].values()))
        ck('p4', '🔴 新建剧本**已落盘**（%s）' % sname, bool(r.get('ok')) and ok,
           '表单/按钮：%s ｜ 磁盘可见=%s' % (json.dumps(r, ensure_ascii=False), ok))

        # ⚠️ `createNewScenario` 建完会**关掉对话框** → 编辑前必须重新打开
        if not open_scenario_manager(cdp):
            ck('p4', '重新打开剧本管理（编辑前）', False, '找不到 .scenario-manager')
            return
        r = scenario_edit(cdp, sname, sname2)
        ok, doc5 = wait_disk(proj, lambda d: any(s.get('name') == sname2
                                                for s in project_scenarios(d)[1].values()))
        edited = None
        for s in project_scenarios(doc5)[1].values():
            if s.get('name') == sname2:
                edited = s
        era_ok = bool(edited and str((edited.get('era') or {}).get('startYear')) == '1990'
                      and str((edited.get('era') or {}).get('endYear')) == '1995')
        ck('p4', '🔴 编辑剧本（改名 + 起止年）**已落盘**', bool(r.get('ok')) and ok and era_ok,
           '编辑返回：%s ｜ 磁盘名=%s / era=%s' % (json.dumps(r, ensure_ascii=False), sname2,
                                               (edited or {}).get('era')))

        r = scenario_delete(cdp, sname2)
        ok, doc6 = wait_disk(proj, lambda d: not any(s.get('name') == sname2
                                                    for s in project_scenarios(d)[1].values()))
        ck('p4', '🔴 删除剧本**已落盘**', bool(r.get('ok')) and ok,
           '删除返回：%s ｜ 磁盘已无该名=%s' % (json.dumps(r, ensure_ascii=False), ok))

        # ⑤ 收尾：正常退出一次（顺带验证剧本改动也走「退出前落盘」那条链）
        ctrl_q(cdp)
        exited = app.wait_exit(40)
        ck('p4', 'Ctrl+Q 正常退出（退出链必须干净）', exited, 'alive=%s' % app.alive())


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
