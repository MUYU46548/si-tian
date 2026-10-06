#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""T2 取证：真机上「导入知识库内容 → 保存链断在哪」（2026-10-06）

背景：`drill_quit_flush.py` 观察到导入后磁盘 12 秒零变化，但生产构建里
`__vue_app__._instance` 是 null，读不到 store，只能看到"没落盘"这个结果。

本脚本用 **dev 模式**（`NODE_ENV=development` + vite dev server）复现同一条链路 ——
dev 下 `_instance` 可用，于是能把「没落盘」拆成可判定的几步：
  exportCanvas 是否抛 / saveProject 是否被调用 / 是否抛 / 抛在哪儿 / writeMode 是什么。

安全措施（务必保留）：
  · **绝不写真实项目文件** —— 打开的是真实项目的**工作副本**（配置里的 lastProjectPath 临时改指它）；
  · `%APPDATA%/SiTian/config.json` 先备份、finally 里还原；
  · 只杀自己拉起的进程：electron 按 **CDP 端口**定位，vite 按自己的 pid 树。

用法：python scripts/tests/diag_t2_save.py
"""
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
DEV_PORT = 5180
APP_CFG = os.path.join(os.environ.get('APPDATA', ''), 'SiTian', 'config.json')
IMPORT_BTN = "document.querySelector('[data-testid=\"import-from-vault-empty\"]')"

# ---- 取数脚本 ----
PROBE = """(async () => {
  const app = document.querySelector('#app').__vue_app__;
  if (!app || !app._instance) return { __err__: 'no __vue_app__._instance' };
  const pinia = app.config.globalProperties.$pinia;
  const ps = (await import('/src/store/projectStore.js')).useProjectStore(pinia);
  const wg = await import('/src/store/writeGate.js');
  return {
    isOpen: !!ps.project,
    filePath: ps.filePath,
    entityCount: Object.keys((ps.project && ps.project.entities) || {}).length,
    dirty: ps.dirty,
    saveStatus: ps.saveStatus,
    lastError: ps.lastError,
    writeMode: wg.describeWriteGate(),
  };
})()"""

EXPORT_PROBE = """(async () => {
  const a = (await import('/src/store/canvasBridge.js')).getCanvasAdapter();
  if (!a) return { __err__: 'no adapter' };
  try {
    const p = a.exportCanvas();
    return { ok: true, keys: Object.keys(p || {}),
             entities: Object.keys((p && p.entities) || {}).length,
             mapKeys: Object.keys(((p && p.maps) || {}).mapData || {}).length,
             scenarios: !!p.scenarios };
  } catch (e) { return { ok: false, thrown: String((e && e.stack) || e).slice(0, 1200) }; }
})()"""

SAVE_CALL = """(async () => {
  const app = document.querySelector('#app').__vue_app__;
  const pinia = app.config.globalProperties.$pinia;
  const ps = (await import('/src/store/projectStore.js')).useProjectStore(pinia);
  try {
    const r = await ps.saveProject({ label: 'diag' });
    return { ok: true, res: r };
  } catch (e) { return { ok: false, thrown: String((e && e.stack) || e).slice(0, 1500) }; }
})()"""

CLONE_WALK = """(async () => {
  const app = document.querySelector('#app').__vue_app__;
  const pinia = app.config.globalProperties.$pinia;
  const ps = (await import('/src/store/projectStore.js')).useProjectStore(pinia);
  const a = (await import('/src/store/canvasBridge.js')).getCanvasAdapter();
  const merged = ps.mergeCanvasPayload(ps.project, a.exportCanvas());
  const bad = [];
  const cloneErr = (v) => { try { structuredClone(v); return ''; } catch (e) { return String((e && e.message) || e); } };
  const desc = (v) => ({
    tag: Object.prototype.toString.call(v),
    typeof: typeof v,
    ctor: (v && v.constructor && v.constructor.name) || '',
    isReactive: !!(v && v.__v_isReactive),
    isRef: !!(v && v.__v_isRef),
    preview: (() => { try { return String(v).slice(0, 80); } catch (e) { return '<no-string>'; } })(),
  });
  const walk = (v, path, depth) => {
    if (depth > 8 || bad.length >= 15) return;
    if (!cloneErr(v)) return;
    const tag = Object.prototype.toString.call(v);
    if (tag === '[object Object]' || tag === '[object Array]') {
      let keys = [];
      try { keys = Array.isArray(v) ? v.map((_, i) => String(i)) : Object.keys(v); } catch (e) {}
      const before = bad.length;
      for (const k of keys) { try { walk(v[k], path + '.' + k, depth + 1); } catch (e) {} }
      if (bad.length === before) bad.push(Object.assign({ path, note: '自身不可克隆，子项均可' }, desc(v)));
      return;
    }
    bad.push(Object.assign({ path }, desc(v)));
  };
  const topErr = cloneErr(merged);
  if (topErr) walk(merged, '$', 0);
  let entityOne = null;
  const firstId = Object.keys(merged.entities || {})[0];
  if (firstId) entityOne = { id: firstId, err: cloneErr(merged.entities[firstId]) };
  return { topErr, entities: Object.keys(merged.entities || {}).length, bad,
           badFields: bad.map(b => b.path + '  [' + b.tag + '] ctor=' + b.ctor),
           entityOne, reactiveFail: cloneErr(ps.project), plainFail: cloneErr(JSON.parse(JSON.stringify(merged))) };
})()"""

SNAP_PROBE = """(async () => {
  const app = document.querySelector('#app').__vue_app__;
  const pinia = app.config.globalProperties.$pinia;
  const ps = (await import('/src/store/projectStore.js')).useProjectStore(pinia);
  const { pushSnapshot } = await import('/src/utils/projectSchema.js');
  try {
    const p = pushSnapshot(ps.project, { label: 'diag' });
    return { ok: true, snaps: (p.snapshots || []).length };
  } catch (e) { return { ok: false, thrown: String((e && e.stack) || e).slice(0, 1500) }; }
})()"""


def ck(name, ok, detail=''):
    print('  %s %s%s' % ('[OK]' if ok else '[!!]', name, ('  -- ' + str(detail)) if detail else ''))
    return bool(ok)


def wait_http(url, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                return r.status < 500
        except Exception:
            time.sleep(0.4)
    return False


def wait_cdp(port=CDP_PORT, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen('http://127.0.0.1:%d/json/version' % port, timeout=1) as r:
                if json.loads(r.read().decode('utf-8')):
                    return True
        except Exception:
            time.sleep(0.4)
    return False


def port_owner_pid(port):
    try:
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


def kill_tree(pid):
    if not pid:
        return
    try:
        subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], capture_output=True, timeout=25)
    except Exception:
        pass


def free_port(port, tries=3):
    for _ in range(tries):
        pid = port_owner_pid(port)
        if not pid:
            return True
        kill_tree(pid)
        time.sleep(1.2)
    return port_owner_pid(port) is None


def node_exe():
    for cand in ('node', r'C:\Users\muyu\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'):
        try:
            out = subprocess.run([cand, '-e', 'process.stdout.write(require("electron"))'],
                                 cwd=ROOT, capture_output=True, text=True, timeout=60)
            p = (out.stdout or '').strip()
            if p and os.path.exists(p):
                return cand, p
        except Exception:
            continue
    raise RuntimeError('找不到 node / electron')


def stat_of(p):
    try:
        st = os.stat(p)
        return {'size': st.st_size, 'mtime': int(st.st_mtime)}
    except Exception:
        return {'size': -1, 'mtime': 0}


def entities_of(p):
    try:
        return len(json.load(open(p, encoding='utf-8')).get('entities') or {})
    except Exception:
        return -1


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--obs', type=int, default=14, help='点导入后观察多少秒（默认 14）')
    args = ap.parse_args()
    obs = max(0, args.obs)

    if not os.path.exists(APP_CFG):
        print('找不到应用配置：%s' % APP_CFG)
        return 2
    cfg_orig_text = open(APP_CFG, encoding='utf-8').read()
    cfg = json.loads(cfg_orig_text)
    real_proj = cfg.get('lastProjectPath', '')
    if not real_proj or not os.path.exists(real_proj):
        print('配置里的 lastProjectPath 不存在：%r' % real_proj)
        return 2

    ts = time.strftime('%Y%m%d-%H%M%S')
    bak = os.path.join(ROOT, 'backups', 'diag-t2-' + ts)
    os.makedirs(bak, exist_ok=True)
    shutil.copy2(APP_CFG, os.path.join(bak, 'config.json'))
    # 工作副本：应用打开它，真实项目一个字节都不会被动
    work = os.path.join(bak, 'work-copy.sitian')
    shutil.copy2(real_proj, work)

    print('=== T2 取证（dev 模式）===')
    print('真实项目（只读）：%s  entities=%d' % (real_proj, entities_of(real_proj)))
    print('工作副本       ：%s  entities=%d' % (work, entities_of(work)))
    print('备份目录       ：%s' % bak)

    try:
        cfg['lastProjectPath'] = work
        with open(APP_CFG, 'w', encoding='utf-8') as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)

        node, exe = node_exe()
        print('node=%s\nelectron=%s\n' % (node, exe))

        # --- vite dev server ---
        free_port(DEV_PORT)
        devlog = open(os.path.join(bak, 'vite-dev.log'), 'a', encoding='utf-8')
        dev = subprocess.Popen([node, os.path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
                                '--config', 'vite.config.js'],
                               cwd=ROOT, stdout=devlog, stderr=devlog)
        if not wait_http('http://localhost:%d/' % DEV_PORT, timeout=90):
            print('vite dev server 未就绪（见 %s/vite-dev.log）' % bak)
            return 1
        print('vite dev server：http://localhost:%d 就绪' % DEV_PORT)

        # --- electron（dev 模式）---
        free_port(CDP_PORT)
        env = dict(os.environ)
        env['NODE_ENV'] = 'development'
        env.pop('OPEN_DEVTOOLS', None)
        env.pop('ELECTRON_RUN_AS_NODE', None)
        applog = open(os.path.join(bak, 'electron-dev.log'), 'a', encoding='utf-8')
        el = subprocess.Popen(
            [exe, '.', '--remote-debugging-port=%d' % CDP_PORT,
             '--disable-gpu', '--disable-software-rasterizer', '--in-process-gpu',
             '--remote-allow-origins=*'],
            cwd=ROOT, env=env, stdout=applog, stderr=applog)
        if not wait_cdp(CDP_PORT, timeout=90):
            print('CDP 未就绪（见 %s/electron-dev.log）' % bak)
            return 1

        from lib.cdp import CDP, wait_for
        cdp = CDP(port=CDP_PORT)
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=60, desc='应用挂载')
        wait_for(cdp, "(async () => { try { const a = document.querySelector('#app').__vue_app__;"
                      " return !!(a && a._instance); } catch (e) { return false; } })()",
                 timeout=30, desc='__vue_app__._instance 可用')
        print('应用已挂载，_instance 可用\n')

        # --- 0) 等点击就绪 ---
        ready = wait_for(cdp, "!!" + IMPORT_BTN, timeout=60, desc='导入入口可见（项目态 + 空项目）')
        ck('项目态就绪（导入入口可见）', bool(ready))

        print('\n-- A) 导入前 store 状态 --')
        s0 = cdp.eval(PROBE)
        print(json.dumps(s0, ensure_ascii=False, indent=2))
        f0 = stat_of(work)
        print('磁盘：%s entities=%d' % (f0, entities_of(work)))

        print('\n-- B) exportCanvas（saveProject 内部第一步）--')
        ex = cdp.eval(EXPORT_PROBE)
        print(json.dumps(ex, ensure_ascii=False, indent=2))

        print('\n-- C) pushSnapshot（saveProject 内部第二步）--')
        sn = cdp.eval(SNAP_PROBE)
        print(json.dumps(sn, ensure_ascii=False, indent=2))

        print('\n-- D) 点「导入知识库内容」并观察 %d 秒 --' % obs)
        r = cdp.eval("(() => { const b = %s; if (!b) return 'no-btn'; b.click(); return 'ok'; })()" % IMPORT_BTN)
        ck('点击导入按钮', r == 'ok', r)
        for i in range(0, obs, 2):
            time.sleep(2.0)
            si = cdp.eval(PROBE)
            fi = stat_of(work)
            print('  t+%2ds  dirty=%-5s status=%-7s bytes=%-7d mtime=%-11d ents=%-4d err=%s'
                  % (i + 2, si.get('dirty'), si.get('saveStatus'), fi['size'], fi['mtime'],
                     entities_of(work), (si.get('lastError') or '')[:90]))
        s1 = cdp.eval(PROBE)
        print('\n导入后 store：')
        print(json.dumps(s1, ensure_ascii=False, indent=2))
        # 注意：`.sitian.backups` 目录在**打开项目**时就会由 makeSessionBaseline 建出来，
        # 所以"目录存在"不能当作落盘判据 —— 只有目录里出现非 baseline 的备份文件才算。
        bdir = work + '.backups'
        real_bk = []
        if os.path.isdir(bdir):
            real_bk = [f for f in os.listdir(bdir)
                       if f.endswith('.sitian') and '.session-baseline' not in f]
        ck('磁盘上出现了真实备份文件（= writeProjectFile 真的跑过）', bool(real_bk),
           real_bk if real_bk else '只有会话基线/没有 → 主进程从未成功写入')

        print('\n-- F) 精确定位"不可克隆"的字段 --')
        cw = cdp.eval(CLONE_WALK)
        print(json.dumps(cw, ensure_ascii=False, indent=2))

        print('\n-- E) 直接调 store.saveProject() 捕获真实异常 --')
        sc = cdp.eval(SAVE_CALL)
        print(json.dumps(sc, ensure_ascii=False, indent=2))
        f2 = stat_of(work)
        print('调用后磁盘：%s entities=%d' % (f2, entities_of(work)))
        ck('显式 saveProject 之后磁盘确实变了', f2['mtime'] != f0['mtime'],
           'mtime %d -> %d' % (f0['mtime'], f2['mtime']))

        cdp.close()
        return 0
    finally:
        try:
            kill_tree(port_owner_pid(CDP_PORT))
        except Exception:
            pass
        try:
            kill_tree(dev.pid)
        except Exception:
            pass
        time.sleep(1.0)
        free_port(CDP_PORT)
        free_port(DEV_PORT)
        with open(APP_CFG, 'w', encoding='utf-8') as f:
            f.write(cfg_orig_text)
        print('\n已还原配置；证据留在 %s' % bak)
        print('真实项目 entities=%d（应保持原值）' % entities_of(real_proj))


if __name__ == '__main__':
    sys.exit(main())
