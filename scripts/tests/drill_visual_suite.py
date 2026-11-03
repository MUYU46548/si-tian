#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一条命令跑完“视觉 / 浮层”演练（2026-11-03）

之前要记住 5 个脚本名、还要按顺序手动跑（每个都会起 Vite(5180) + Edge(9222)，抢端口就会红）。
本工具把它们**串起来顺序跑**，一份汇总 + 一份日志目录：

  ① 浮雕底开/关        drill_scenario_relief.py
  ② 星域航道远景/近景  drill_galaxy_lanes.py
  ③ 六个浮层**在不在**  drill_diplomacy_overlay.py
  ④ 六个浮层**看得清吗** drill_scenario_overlays_visual.py（层级/遮挡/暗色对比度/截图）
  ⑤ 像素基线            drill_scenario_pixels.py --tag <本轮> + --compare <基线> <本轮>

用法：
  python scripts/tests/drill_visual_suite.py                 # 全跑（默认比像素基线）
  python scripts/tests/drill_visual_suite.py --list          # 只列步骤
  python scripts/tests/drill_visual_suite.py --only relief,pixels
  python scripts/tests/drill_visual_suite.py --baseline v20261103e --tag my-run
  python scripts/tests/drill_visual_suite.py --no-compare     # 只拍，不比

判据：任一步非 0 → 整体非 0；退出码 = 失败步数。
⚠️ 它**独占** 5180/9222：跑之前别开 `run_tests.py` 或别的演练（本工具会先查端口，占着就直接说）。
⚠️ 像素基线**只在同一台机器上可比**（字体/DPR 跨机器不同）——`hashNoLabels` 是跨机器也有意义的那枚。
产物：build/visual-suite/<时间戳>/{<step>.log, summary.md, summary.json}
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)

# 控制台默认是 GBK（Windows PowerShell）——不显式切成 UTF-8，一条 `▶` 就会让整个套件崩在
# `UnicodeEncodeError` 上（2026-11-03 首跑实测：5 步一个都没跑）。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8')
    except Exception:
        pass

DEV_PORT = 5180
CDP_PORT = 9222

# 当前像素基线（改动观感后必须重立，并把这里与 AGENTS.md 一起改）
DEFAULT_BASELINE = 'v20261103e'

STEPS = [
    dict(key='relief', title='浮雕底开/关（同机位两帧必须不同）',
         script='drill_scenario_relief.py', args=[]),
    dict(key='lanes', title='星域航道（远景 0 条 / 悬停 1 条 / 近景全画）',
         script='drill_galaxy_lanes.py', args=[]),
    dict(key='overlays-dom', title='六个浮层在不在 DOM（含 Teleport 落点、收起下拉仍在）',
         script='drill_diplomacy_overlay.py', args=[]),
    dict(key='overlays-visual', title='六个浮层的视觉（层级/遮挡/暗色对比度/逐张截图）',
         script='drill_scenario_overlays_visual.py', args=[]),
    dict(key='pixels', title='像素基线（同机位逐像素 + 关标注几何层）',
         script='drill_scenario_pixels.py', args=['__SHOT__']),
]


def tcp_open(port):
    import socket
    s = socket.socket()
    s.settimeout(0.3)
    try:
        return s.connect_ex(('127.0.0.1', port)) == 0
    finally:
        s.close()


def wait_ports_free(timeout=45):
    """等上一步的 Vite/Edge 收干净（演练在 finally 里停进程，但端口有时释放得慢）"""
    end = time.time() + timeout
    while time.time() < end:
        if not tcp_open(DEV_PORT) and not tcp_open(CDP_PORT):
            return True
        time.sleep(1.0)
    return False


def ports_busy():
    return [p for p in (DEV_PORT, CDP_PORT) if tcp_open(p)]


def run_step(step, out_dir, env, tag=None):
    args = [sys.executable, os.path.join(HERE, step['script'])]
    for a in step['args']:
        if a == '__SHOT__':
            args += ['--tag', tag]
        else:
            args.append(a)
    log_path = os.path.join(out_dir, step['key'] + '.log')
    t0 = time.time()
    with open(log_path, 'w', encoding='utf-8') as log:
        proc = subprocess.Popen(args, cwd=ROOT, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        for raw in proc.stdout:
            line = raw.decode('utf-8', 'replace')
            log.write(line)
            log.flush()
            sys.stdout.write(line)
            sys.stdout.flush()
        code = proc.wait()
    return code, round(time.time() - t0, 1), log_path


def main():
    argv = sys.argv[1:]
    if '--list' in argv:
        print('步骤：')
        for s in STEPS:
            print(f"  {s['key']:16s} {s['title']}  →  scripts/tests/{s['script']}")
        return 0

    only = None
    if '--only' in argv:
        only = [x.strip() for x in argv[argv.index('--only') + 1].split(',') if x.strip()]
    baseline = DEFAULT_BASELINE
    if '--baseline' in argv:
        baseline = argv[argv.index('--baseline') + 1]
    tag = time.strftime('suite-%Y%m%d-%H%M%S')
    if '--tag' in argv:
        tag = argv[argv.index('--tag') + 1]
    compare = '--no-compare' not in argv

    steps = [s for s in STEPS if not only or s['key'] in only]
    unknown = [k for k in (only or []) if k not in [s['key'] for s in STEPS]]
    if unknown:
        print('不认识的步骤：' + ', '.join(unknown))
        print('可用：' + ', '.join(s['key'] for s in STEPS))
        return 2

    busy = ports_busy()
    if busy:
        print(f"❌ 端口 {busy} 已被占用 —— 先停掉正在跑的回归/演练（本工具独占 5180/9222）")
        return 2

    out_dir = os.path.join(ROOT, 'build', 'visual-suite', tag)
    os.makedirs(out_dir, exist_ok=True)
    env = dict(os.environ)
    env['PYTHONIOENCODING'] = 'utf-8'
    env['PYTHONUTF8'] = '1'

    print('=' * 78)
    print(f'视觉/浮层演练套件 · {len(steps)} 步 · tag={tag} · 基线={baseline if compare else "（不比较）"}')
    print(f'日志与汇总：{out_dir}')
    print('=' * 78, flush=True)

    results = []
    for i, step in enumerate(steps, 1):
        print(f'\n▶ [{i}/{len(steps)}] {step["title"]}', flush=True)
        code, secs, log_path = run_step(step, out_dir, env, tag=tag)
        results.append(dict(key=step['key'], title=step['title'], code=code, secs=secs, log=log_path))

        # 像素那步：拍完再与基线对拍（比较是纯文件操作，不需要端口）
        if step['key'] == 'pixels' and compare and code == 0:
            print(f'\n▶ [{i}/{len(steps)}] 像素基线比对：{baseline} → {tag}', flush=True)
            cmp_args = [sys.executable, os.path.join(HERE, step['script']),
                        '--compare', baseline, tag]
            cmp_log = os.path.join(out_dir, 'pixels-compare.log')
            t0 = time.time()
            with open(cmp_log, 'w', encoding='utf-8') as f:
                p = subprocess.Popen(cmp_args, cwd=ROOT, env=env, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT)
                for raw in p.stdout:
                    line = raw.decode('utf-8', 'replace')
                    f.write(line)
                    sys.stdout.write(line)
                ccode = p.wait()
            results.append(dict(key='pixels-compare', title=f'像素基线比对 {baseline} → {tag}',
                                code=ccode, secs=round(time.time() - t0, 1), log=cmp_log))
        if not wait_ports_free():
            print('  ⚠️ 端口 45s 内没释放干净 —— 下一步可能起不来（看端口 5180/9222 的残留进程）', flush=True)

    # ── 汇总 ──
    bad = [r for r in results if r['code'] != 0]
    lines = [f'# 视觉/浮层演练汇总 · {tag}', '',
             f'- 时间：{time.strftime("%Y-%m-%d %H:%M:%S")}',
             f'- 像素基线：{baseline if compare else "（本轮不比较）"}',
             f'- 结果：**{len(results) - len(bad)}/{len(results)} 通过**', '',
             '| 步骤 | 结果 | 用时 | 日志 |', '|---|---|---|---|']
    for r in results:
        mark = '✅ 通过' if r['code'] == 0 else f'🔴 退出码 {r["code"]}'
        lines.append(f'| {r["title"]} | {mark} | {r["secs"]}s | `{os.path.basename(r["log"])}` |')
    summary_md = '\n'.join(lines) + '\n'
    with open(os.path.join(out_dir, 'summary.md'), 'w', encoding='utf-8') as f:
        f.write(summary_md)
    with open(os.path.join(out_dir, 'summary.json'), 'w', encoding='utf-8') as f:
        json.dump({'tag': tag, 'baseline': baseline if compare else None,
                   'steps': results}, f, ensure_ascii=False, indent=2)

    print('\n' + '=' * 78)
    print(summary_md)
    print(f'汇总：{os.path.join(out_dir, "summary.md")}')
    return len(bad)


if __name__ == '__main__':
    sys.exit(main())
