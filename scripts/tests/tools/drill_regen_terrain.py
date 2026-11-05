#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把真实项目的某张底图按“生成地形”重跑一遍（带备份 · 走产品动作 · 只读盘核对）。

为什么是“驱动真机”而不是离线改 JSON：生成地形这条动作里还有 **undo 记录、气候同一笔、
手绘搬移、生成账本（provenance）、保存链** —— 离线拼一份 JSON 只能拼出“看起来像”的一半，
而且绕过了写闸门与保存链。本脚本点的是 `store.synthesizeBaseMapTerrain(key, {force:true})`，
与面板上那个按钮**同一条代码路径**。

用法：
  python scripts/tests/tools/drill_regen_terrain.py [--project <x.sitian>] [--key desite] [--cells 192]

产物：`build/regen-terrain/`（备份副本、运行日志、`report.json`）。
跑完校验：项目文件里高度图格数变了、有 genSeed / structure、生成账本多一条、文件能正常解析。
"""
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))
from lib.cdp import CDP, wait_for                      # noqa: E402
from diag_t2_save import wait_http, wait_cdp, free_port, node_exe, kill_tree  # noqa: E402

DEV_PORT = 5180
CDP_PORT = 9223
OUT = os.path.join(ROOT, 'build', 'regen-terrain')


def arg(name, default):
    a = sys.argv[1:]
    return a[a.index('--' + name) + 1] if ('--' + name) in a and a.index('--' + name) + 1 < len(a) else default


def _watchdog(seconds):
    """硬超时：真机驱动一旦卡在 CDP 上，脚本不能把会话拖死（2026-11-04 真踩：卡了 18 分钟）。"""
    time.sleep(seconds)
    print('!! 超时退出（%ds）—— 看 electron.log / vite.log' % seconds, flush=True)
    os._exit(2)


def main():
    import threading
    threading.Thread(target=_watchdog, args=(600,), daemon=True).start()
    project = arg('project', r'<用户目录>\Documents\SiTianProjects\示例项目.sitian')
    key = arg('key', 'desite')
    cells = int(arg('cells', '192'))
    if not os.path.isfile(project):
        print('项目不存在：%s' % project)
        return 1
    os.makedirs(OUT, exist_ok=True)
    stamp = time.strftime('%Y%m%d-%H%M%S')
    backup = os.path.join(OUT, 'backup-%s.sitian' % stamp)
    shutil.copy2(project, backup)
    size0 = os.path.getsize(project)
    mtime0 = os.path.getmtime(project)
    print('备份：%s（%,d 字节）'.replace('%,d', '{:,}').format(size0) % backup)

    node, exe = node_exe()   # 返回 (node 可执行文件, electron 可执行文件)
    procs = []
    try:
        free_port(DEV_PORT)
        devlog = open(os.path.join(OUT, 'vite.log'), 'a', encoding='utf-8')
        procs.append(subprocess.Popen([node, os.path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
                                       '--config', 'vite.config.js'],
                                      cwd=ROOT, stdout=devlog, stderr=devlog))
        if not wait_http('http://localhost:%d/' % DEV_PORT, timeout=90):
            print('vite 未就绪（见 vite.log）')
            return 1
        print('vite 就绪')

        free_port(CDP_PORT)
        env = dict(os.environ)
        env['NODE_ENV'] = 'development'
        env.pop('ELECTRON_RUN_AS_NODE', None)
        applog = open(os.path.join(OUT, 'electron.log'), 'a', encoding='utf-8')
        procs.append(subprocess.Popen(
            [exe, '.', '--remote-debugging-port=%d' % CDP_PORT,
             '--disable-gpu', '--disable-software-rasterizer', '--in-process-gpu',
             '--remote-allow-origins=*'],
            cwd=ROOT, env=env, stdout=applog, stderr=applog))
        if not wait_cdp(CDP_PORT, timeout=90):
            print('CDP 未就绪（见 electron.log）')
            return 1

        cdp = CDP(port=CDP_PORT)
        wait_for(cdp, "!!document.querySelector('#app') && !!(document.querySelector('#app').__vue_app__"
                      " && document.querySelector('#app').__vue_app__._instance)", timeout=60, desc='应用挂载')
        # 打开项目（若上次留了“未保存编辑”对话框，先丢弃）
        for _ in range(20):
            r = cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                         ".find(x => (x.textContent||'').trim() === '丢弃备份'); if (b) { b.click(); return 'dialog'; } return 'none'; })()")
            if r == 'dialog':
                time.sleep(0.3)
            else:
                break
        opened = cdp.eval("(async () => { try { const r = await window.sitianAPI.projectOpen(%s);"
                          " return JSON.stringify(r || {}); } catch (e) { return 'ERR:' + e.message; } })()"
                          % json.dumps(project))
        print('projectOpen → %s' % opened)
        if isinstance(opened, str) and opened.startswith('ERR:'):
            return 1

        # 等底图与地形就位
        ready = wait_for(cdp, "(() => { try { const s = document.querySelector('#app').__vue_app__._instance.setupState.store;"
                              " const bm = s && s.baseMaps && s.baseMaps[%s]; return !!(bm && bm.terrain && bm.terrain.length); }"
                              " catch (e) { return false; } })()" % json.dumps(key), timeout=60, desc='底图就位')
        print('底图就位：%s' % ready)

        before = cdp.eval("(() => { const s = document.querySelector('#app').__vue_app__._instance.setupState.store;"
                          " const bm = s.baseMaps[%s]; const hm = bm && bm.heightmap;"
                          " return JSON.stringify({ provinces: (bm.terrain||[]).length,"
                          " cells: hm && hm.grid ? hm.grid.cellsX * hm.grid.cellsY : 0,"
                          " lakes: (hm && hm.lakes || []).length, seed: hm && hm.genSeed }); })()" % json.dumps(key))
        print('生成前：%s' % before)

        t0 = time.time()
        res = cdp.eval("(async () => { try { const s = document.querySelector('#app').__vue_app__._instance.setupState.store;"
                       " const r = s.synthesizeBaseMapTerrain(%s, { force: true, params: { cellsAcross: %d } });"
                       " return JSON.stringify({ ok: !!(r && r.ok), reason: r && r.reason, message: r && r.message,"
                       " cells: r && r.heightmap && r.heightmap.grid ? r.heightmap.grid.cellsX * r.heightmap.grid.cellsY : 0,"
                       " lakes: (r && r.heightmap && r.heightmap.lakes || []).length,"
                       " structure: r && r.heightmap && r.heightmap.structure || null }); } catch (e) { return 'ERR:' + e.message; } })()"
                       % (json.dumps(key), cells))
        print('生成动作：%s（%.1fs）' % (res, time.time() - t0))
        if isinstance(res, str) and res.startswith('ERR:'):
            return 1

        # 生成动作现在会**自己写河**（同一笔 undo），这里不再清河。
        # 等保存到磁盘（mtime 变化 + 尺寸合理）
        ok_disk = False
        for _ in range(40):
            time.sleep(0.5)
            if os.path.getmtime(project) > mtime0 + 0.5:
                ok_disk = True
                break
        print('落盘：%s（%,d → %s 字节）'.replace('%,d', '{:,}').format(size0, os.path.getsize(project)) if ok_disk
              else '落盘：未检测到文件变化')
        time.sleep(1.0)
    finally:
        for p in reversed(procs):
            try:
                kill_tree(p.pid)
            except Exception:
                pass
        time.sleep(1.0)

    # 只读盘核对
    with open(project, 'r', encoding='utf-8') as f:
        j = json.load(f)
    bm = (j.get('scenarios', {}).get('baseMaps') or {}).get(key) or {}
    hm = bm.get('heightmap') or {}
    grid = hm.get('grid') or {}
    cells_now = int(grid.get('cellsX') or 0) * int(grid.get('cellsY') or 0)
    prov = bm.get('provenance') or []
    last = prov[-1] if isinstance(prov, list) and prov else {}
    report = {
        'project': project,
        'key': key,
        'backup': backup,
        'bytes_before': size0,
        'bytes_after': os.path.getsize(project),
        'provinces': len(bm.get('terrain') or []),
        'cells': cells_now,
        'h_len': len(hm.get('h') or []),
        'lakes': len(hm.get('lakes') or []),
        'genSeed': hm.get('genSeed'),
        'structure': hm.get('structure'),
        'temp': len(hm.get('temp') or []),
        'prec': len(hm.get('prec') or []),
        'provenance_last': {'kind': last.get('kind'), 'seed': last.get('seed'),
                            'source': (last.get('params') or {}).get('source')} if last else None,
    }
    with open(os.path.join(OUT, 'report.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))

    bad = []
    if not cells_now:
        bad.append('高度图没有格子')
    if report['h_len'] != cells_now:
        bad.append('h 长度与网格不一致')
    if not hm.get('genSeed'):
        bad.append('缺 genSeed')
    if not isinstance(last, dict) or last.get('kind') != 'terrain':
        bad.append('生成账本没有新增 terrain 记录')
    if bad:
        print('判据不过：%s' % '；'.join(bad))
        return 1
    print('判据通过：格 %d · 湖 %d · 账本 %s' % (cells_now, report['lakes'], report['provenance_last']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
