#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""E-4 性能原型测量器（2026-11-25）

## 干什么

把 `scripts/proto/domain3d-proto.html` 用真实浏览器（Edge headless）跑起来，
自动点「开始量」，等两轮跑完，把对照结果打出来。

## 为什么要有它（而不是手动开浏览器看）

1. **可复现**：同一份代码，今天量 42fps、下周量 18fps，必须能追到是代码变了还是机器变了；
2. **不靠人眼**：HUD 上的数字是刷新抽样（8% 概率），可能错过最慢帧；
   这里直接读页面里 `RESULT` 对象的原始样本（中位/p95/max 都在）；
3. **同时取对照**：合批 vs 逐对象必须在**同一次会话**里量，跨会话量会被机器状态污染。

## 口径（报数前先看）

- **headless 的帧率不等于真机**：headless 里 rAF 受 vsync 与合成器影响更小，
  数字通常**偏乐观**。所以这里的结论只用于**比较两者**（合批 vs 逐对象），
  绝对值要按"真机应更差"打折看。
- 像素比固定 1（与 System3DView 同口径），不受 4K 屏 DPR 影响。
- 判据 `median <= 33ms` 来自方寸卡 E-4 的 N3 条。

用法：
  python scripts/proto/probe_domain3d.py
  python scripts/proto/probe_domain3d.py --stars 60      # 换规模
  python scripts/proto/probe_domain3d.py --keep          # 保留浏览器不关（调试用）
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

# ⚠️ Windows 重定向 stdout 默认是 GBK，打印 ✅/❌/中文会 UnicodeEncodeError
#    （AGENTS.md 里记着这个坑：其它真机脚本都 reconfigure 过，这里照做）
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:      # noqa: BLE001
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))
from lib.cdp import CDP, find_page_ws                  # noqa: E402

EDGE = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
PROTO = os.path.join(ROOT, 'scripts', 'proto', 'domain3d-proto.html')
PORT = 9333          # 不要用 9222/9224-9229（那些是回归用例的）


def arg(name, default):
    a = sys.argv[1:]
    return a[a.index('--' + name) + 1] if ('--' + name) in a and a.index('--' + name) + 1 < len(a) else default


def flag(name):
    return ('--' + name) in sys.argv[1:]


def wait_devtools(timeout=25):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/version', timeout=1) as r:
                return json.loads(r.read().decode('utf-8'))
        except Exception:
            time.sleep(0.3)
    raise RuntimeError(f'DevTools 在 {timeout}s 内没起来（端口 {PORT}）')


def main():
    stars = int(arg('stars', '30'))
    if not os.path.exists(PROTO):
        print(f'❌ 原型不存在：{PROTO}')
        return 1
    if not os.path.exists(EDGE):
        print(f'❌ 找不到 Edge：{EDGE}')
        return 1

    url = 'file:///' + PROTO.replace('\\', '/') + f'?stars={stars}'
    # 🔴 profile 必须放**仓库外**（2026-11-25 踩过：放进 build/ 后 git add -A 把它
    #    连同 1457 个浏览器文件一起提交了）。用系统临时目录，跑完由 finally 清掉。
    profile = os.path.join(tempfile.gettempdir(), f'sitian-domain3d-profile-{PORT}')
    shutil.rmtree(profile, ignore_errors=True)
    os.makedirs(profile, exist_ok=True)

    cmd = [
        EDGE,
        '--headless=new',
        f'--remote-debugging-port={PORT}',
        f'--user-data-dir={profile}',
        '--no-first-run', '--no-default-browser-check',
        '--disable-gpu-sandbox',
        '--window-size=1280,800',
        # headless 里 WebGL 需要软件渲染兜底（没 GPU 的机器也能跑）
        '--enable-unsafe-swiftshader',
        url,
    ]
    print(f'启动 Edge（headless, 端口 {PORT}）…')
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_devtools()
        time.sleep(2.0)          # 等 three 从 CDN 下载 + 首帧
        # 🔴 必须**按 URL 挑 target**，不能取第一个 page。
        #    `find_page_ws` 的兜底是 pages[0] —— 换到系统临时 profile 后，Edge 会先开
        #    `edge://` 之类的内部页并把它们排在 /json 前面，于是 cdp.eval 打到了别的 target 上
        #    （表现为 `TypeError` 且 lineNumber 0）。
        #    这里自己挑：只认我们那个 file:// 原型页。
        ws = find_page_ws(PORT, prefer_prefix='file:///', timeout=30)
        cdp = CDP(ws_url=ws)

        # 等页面就绪（boot() 里最后打的标志）
        ready = False
        for _ in range(60):
            v = cdp.eval("(() => { const l=document.getElementById('log'); "
                         "return l && /就绪|失败/.test(l.textContent) ? l.textContent.slice(-160) : ''; })()")
            if v:
                print(f'页面：{v}')
                ready = '就绪' in v
                break
            time.sleep(0.5)
        if not ready:
            print('❌ 页面没就绪（three 加载失败？下面读日志）')
            v = cdp.eval("document.getElementById('log').textContent")
            print(v[-800:] if isinstance(v, str) else v)
            return 1

        # 数据规模
        counts = cdp.eval("JSON.stringify(SCENE_DATA && SCENE_DATA.counts || null)")
        try:
            counts = json.loads(counts) if isinstance(counts, str) else counts
        except ValueError:
            pass
        print(f'场景：{counts}')

        # 点「开始量」—— 两轮各 5 秒，加上间隔约 13 秒
        # ⚠️ 判"跑完"必须看 **RESULT 里两个键都在**，不能看 verdict 的 class：
        #    第一版看 `verdict.classList.contains('show')`，结果在合批那轮刚结束时就以为跑完了
        #    （showVerdict 只在最后调，但探针的等待窗口 40s 里撞上了中间态）→ 只拿到一半数据。
        #    教训：等"结果齐了"，不等"某个 UI 动了"。
        print('开始量（合批 5s + 逐对象 5s，中间各等 0.8s）…')
        cdp.eval("window.__proto.runAll(); 1")
        t0 = time.time()
        while time.time() - t0 < 60:
            done = cdp.eval(
                "(() => { const r = (window.__proto && window.__proto.result()) || {}; "
                "return !!(r.batched && r.naive); })()")
            if done:
                break
            time.sleep(0.5)
        time.sleep(0.3)

        res = cdp.eval(
            "(() => { const r = (window.__proto && window.__proto.result()) || {}; "
            "return JSON.stringify(Object.keys(r).length ? r : null); })()")
        try:
            res = json.loads(res) if isinstance(res, str) else res
        except ValueError:
            res = None
        if not res:
            print('❌ 没拿到测量结果（可能 5 秒还没跑完）')
            print(cdp.eval("document.getElementById('log').textContent")[-900:])
            return 1

        # 出表
        # ⚠️ 判判据用 **渲染耗时**（renderMedian），不用帧时：
        #    帧时被 vsync 拍平在 16.67ms，两版一模一样 → 看不出合批有没有用（第一跑就踩了这个）。
        print()
        print('=' * 88)
        print(f'{"模式":<20}{"draw calls":>11}{"渲染中位":>12}{"渲染p95":>12}{"帧时中位":>12}{"帧时max":>11}')
        print('-' * 88)
        for key, label in (('batched', '合批版（3 批）'), ('naive', '逐对象版（对照）')):
            r = res.get(key)
            if not r:
                continue
            print(f'{label:<20}{r["calls"]:>11}'
                  f'{r.get("renderMedian", 0):>11.3f}ms'
                  f'{r.get("renderP95", 0):>11.3f}ms'
                  f'{r["median"]:>11.2f}ms'
                  f'{r["max"]:>10.2f}ms')
        print('=' * 88)

        b = res.get('batched') or {}
        n = res.get('naive') or {}
        if b and n:
            rb = b.get('renderMedian', 0)
            rn = n.get('renderMedian', 0)
            print(f'渲染耗时：合批 {rb:.3f}ms / 逐对象 {rn:.3f}ms'
                  f'  → 合批省 {(rn - rb):.3f}ms（{((rn - rb) / max(0.0001, rn) * 100):.0f}%）')
            if rb > 0:
                print(f'加速 {(rn / max(0.0001, rb)):.2f}×')
            print(f'draw calls：{n["calls"]} → {b["calls"]}')
            # 16.67ms 是 60fps 的刷新周期；渲染耗时要显著低于它才有余量
            print()
            budget = 33.0
            head = budget - rb
            ok = rb <= budget
            print(('✅ 判据通过' if ok else '❌ 判据未过')
                  + f'：合批渲染中位 {rb:.3f}ms，30fps 预算 {budget:.0f}ms，余量 {head:.1f}ms')
            if ok:
                print(f'   → 余量约占预算的 {head / budget * 100:.0f}%，'
                      f'足够再放交互、标签、边境光晕等观感件。')
            else:
                print('   → 需要先减实例数或换渲染方式，别急着做正式实现')
        print()
        print('⚠️ headless + 软件渲染（SwiftShader）的数字比真机差不少，')
        print('   所以这里若已通过，真机更没问题；若未过，先确认是不是软件渲染拖的。')

        out_dir = os.path.join(ROOT, 'build', 'proto-domain3d')
        os.makedirs(out_dir, exist_ok=True)
        out = os.path.join(out_dir, 'probe-result.json')
        with open(out, 'w', encoding='utf-8') as fh:
            json.dump({'counts': counts, 'result': res,
                       'meta': {'stars': stars, 'headless': True, 'port': PORT}},
                      fh, ensure_ascii=False, indent=2)
        print(f'结果已存：{out}')
        return 0
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=8)
        except Exception:                # noqa: BLE001
            try:
                proc.kill()
            except Exception:            # noqa: BLE001
                pass
        # profile 在系统临时目录，跑完就清（别留垃圾，也别让它有机会被提交）
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
