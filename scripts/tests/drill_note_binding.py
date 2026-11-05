#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""标记 / 剧本 ↔ 资料笔记绑定的端到端判据（B1，2026-11-05）

背景（阶段目标卡 P0）：`scenario/interaction/markers.js` 里 `notePath` **0 命中** ——
标记只是"画在图上的一层"，点开面板只能改名/改类型/改坐标，**挂不上一篇设定笔记**。
于是"这个渡口是哪篇笔记写的"只能靠人脑记。

B1 的最小闭环（本工具全走产品入口，真 Electron + 真项目副本 + **真资料库**）：
  ① 用标记面板里的“资料”段搜到那篇笔记 → 点“绑定” → 标记上出现 `notePath`；
  ② 面板立刻显示“已绑定 + 那篇笔记”（可点开），**写进项目文件**（读盘核对）；
  ③ Ctrl+Z 撤回 → 内存与磁盘一起回到没绑的状态；
  ④ 反向探针：绑一个库里不存在的路径 → 面板必须显示“找不到了”（漂移不静默）；
     再绑回真笔记 → 提示消失（重连）；
  ⑤ 剧本侧同一个形状：`setScenarioNotePath` 一条 undo + 落盘。

资料库用**仓内合成 fixture 的副本**（`scripts/tests/fixtures/vault-fixture-messy`，
全虚构、可入库）—— 副本放在本次产物目录里，索引写进副本，仓里的 fixture 一个字节都不动。

用法：
  python scripts/tests/drill_note_binding.py [--project <file.sitian>]

⚠️ 会开一个真实 Electron 窗口（约 2 分钟）；独占 5180 / 9229。
产物：`build/note-binding/<时间戳>/{result.json,summary.md,vault-copy/,vite.log,electron.log}`
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8')
    except Exception:
        pass
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

DEV_PORT = 5180
CDP_PORT = 9229          # 9222=Edge 回归 / 9224=行星截图 / 9226=涂归属 / 9227=撤销 / 9228=外交写
VAULT_FIXTURE = os.path.join(ROOT, 'scripts', 'tests', 'fixtures', 'vault-fixture-messy')
SAMPLE = os.path.join(ROOT, 'sample', '示例世界.sitian')

fails = []


# ══════════════════════════════════════════════════════════════════════════
# 页面侧脚本
# ══════════════════════════════════════════════════════════════════════════

# 建一个标记（走 store 唯一写口）+ 打开它的面板。名字用 fixture 里真有的地名，才能搜到资料。
SETUP_JS = r"""(async () => {
  const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const sc = SM.selectedScenario;
  if (!sc) return JSON.stringify({ ok: false, why: 'no-scenario' });
  const name = '风岬港';
  const before = (sc.markers || []).length;
  s.addScenarioMarker(sc.id, { id: 'note_probe_marker', x: 120, y: 90, name, type: 'city' });
  const sc2 = s.scenarios[sc.id];
  const list = sc2.markers || [];
  const idx = list.findIndex((m) => m && m.id === 'note_probe_marker');
  if (idx < 0) return JSON.stringify({ ok: false, why: 'marker-not-created' });
  // 与点图标同一条路：打开标记面板（面板里才有“资料”段）
  SM.openMarkerEditor(list[idx], idx);
  await new Promise((r) => setTimeout(r, 300));
  window.__NB__ = { sid: sc.id, markerId: 'note_probe_marker', idx, name };
  return JSON.stringify({ ok: true, sid: sc.id, markers: before, idx,
    panel: !!document.querySelector('[data-testid="marker-props"]'),
    vault: !!document.querySelector('[data-testid="marker-vault"]') });
})()"""

# 资料段是异步检索：等命中出来（Python 侧 wait_for 也会等，这里给一次即时读数）
HITS_JS = r"""(() => {
  const rows = Array.from(document.querySelectorAll('[data-testid="marker-vault-hit"]'));
  const binds = Array.from(document.querySelectorAll('[data-testid="marker-vault-bind"]'));
  const paths = rows.map((r) => (r.querySelector('.pv-path') || {}).textContent || '');
  return JSON.stringify({ ok: true, hits: rows.length, binds: binds.length,
    first: paths[0] || '', paths: paths.slice(0, 5) });
})()"""

# 点第一行候选的“绑定”
BIND_JS = r"""(async () => {
  const btn = document.querySelector('[data-testid="marker-vault-bind"]');
  if (!btn) return JSON.stringify({ ok: false, why: 'no-bind-button' });
  btn.click();
  await new Promise((r) => setTimeout(r, 260));
  return JSON.stringify({ ok: true });
})()"""

STATE_JS = r"""(() => {
  const NB = window.__NB__ || {};
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const sc = NB.sid ? s.scenarios[NB.sid] : null;
  const m = sc ? ((sc.markers || []).find((x) => x && x.id === NB.markerId) || null) : null;
  const bound = document.querySelector('[data-testid="marker-vault-bound"]');
  const dangling = document.querySelector('[data-testid="marker-vault-dangling"]');
  const msg = document.querySelector('[data-testid="marker-vault-msg"]');
  return JSON.stringify({
    ok: !!sc,
    markerNote: m ? (m.notePath || '') : '',
    scenarioNote: sc ? (sc.notePath || '') : '',
    bound: !!bound,
    boundText: bound ? (bound.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) : '',
    dangling: !!dangling,
    msg: msg ? (msg.textContent || '').trim() : '',
    canUndo: !!s.canUndo, canRedo: !!s.canRedo, undoLabel: (s.undoLabel || '') + '',
  });
})()"""

# 反向探针：绑一个库里不存在的路径（走同一个 store 写口）
FAKE_JS = r"""(() => {
  const NB = window.__NB__ || {};
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const r = s.updateScenarioMarker(NB.sid, NB.markerId, { notePath: '不存在的目录/根本没有这篇.md' });
  return JSON.stringify({ ok: !!(r && r.ok), notePath: (r && r.marker && r.marker.notePath) || '' });
})()"""

# 反向探针 2：非字符串必须整条拒绝（不许把对象塞进数据）
BAD_JS = r"""(() => {
  const NB = window.__NB__ || {};
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const r = s.updateScenarioMarker(NB.sid, NB.markerId, { notePath: { 恶意: '对象' } });
  const sc = s.scenarios[NB.sid];
  const m = ((sc.markers || []).find((x) => x && x.id === NB.markerId)) || {};
  return JSON.stringify({ ok: !!(r && r.ok), reason: (r && r.reason) || '',
    markerNote: m.notePath || '' });
})()"""


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def tree_sha(path):
    """目录指纹（判"仓里的 fixture 一个字节都没动"）。"""
    h = hashlib.sha256()
    for base, dirs, files in os.walk(path):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(base, name)
            h.update(os.path.relpath(full, path).replace('\\', '/').encode('utf-8'))
            with open(full, 'rb') as f:
                h.update(f.read())
    return h.hexdigest()


def port_open(port):
    import socket
    s = socket.socket()
    s.settimeout(0.3)
    try:
        return s.connect_ex(('127.0.0.1', port)) == 0
    finally:
        s.close()


def wait_port(port, timeout=120):
    end = time.time() + timeout
    while time.time() < end:
        if port_open(port):
            return True
        time.sleep(0.4)
    return False


def wait_http(url, timeout=120):
    import urllib.request
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    end = time.time() + timeout
    while time.time() < end:
        try:
            with opener.open(url, timeout=1) as r:
                if r.status < 500:
                    return True
        except Exception:
            time.sleep(0.4)
    return False


def wait_file_change(path, before, timeout=25.0, poll=0.02):
    end = time.time() + timeout
    while time.time() < end:
        st = os.stat(path)
        if (st.st_mtime_ns, st.st_size) != before:
            return True
        time.sleep(poll)
    return False


def ck(name, ok, detail=''):
    print(('  ✅ ' if ok else '  ❌ ') + name + (' — ' + str(detail) if detail else ''), flush=True)
    if not ok:
        fails.append(name + (' — ' + str(detail) if detail else ''))
    return bool(ok)


def handle_disclaimer(cdp):
    from lib.cdp import wait_for
    try:
        wait_for(cdp, "!!document.querySelector('[data-testid=\"disclaimer-dialog\"]')",
                 timeout=8, desc='免责声明')
    except RuntimeError:
        return 'no-dialog'
    cdp.eval("""(() => {
      const sc = document.querySelector('[data-testid="disclaimer-scroll"]');
      if (sc) { sc.scrollTop = sc.scrollHeight; sc.dispatchEvent(new Event('scroll', { bubbles: true })); }
      return 'scrolled';
    })()""")
    time.sleep(0.5)
    cdp.eval("""(() => {
      const dlg = document.querySelector('[data-testid="disclaimer-dialog"]');
      const sm = dlg && dlg.__vueParentComponent && dlg.__vueParentComponent.setupState;
      if (sm && 'agreed' in sm) sm.agreed = true;
      const b = document.querySelector('[data-testid="disclaimer-accept"]');
      if (b) b.click();
      return 'ok';
    })()""")
    time.sleep(0.8)
    return 'closed'


def ctrl_z(cdp):
    for t in ('rawKeyDown', 'keyUp'):
        cdp.send('Input.dispatchKeyEvent', {
            'type': t, 'modifiers': 2, 'key': 'z', 'code': 'KeyZ',
            'windowsVirtualKeyCode': 90, 'nativeVirtualKeyCode': 90,
        })


def disk_marker(path, sid, marker_id):
    with open(path, 'rb') as f:
        data = json.loads(f.read().decode('utf-8'))
    scen = (((data.get('scenarios') or {}).get('scenarios')) or {}).get(sid) or {}
    m = next((x for x in (scen.get('markers') or []) if x and x.get('id') == marker_id), None)
    return scen, m


def main():
    args = sys.argv[1:]
    project = args[args.index('--project') + 1] if '--project' in args else SAMPLE
    if not os.path.exists(project):
        print(f'  ❌ 找不到项目：{project}')
        return 2
    if not os.path.isdir(VAULT_FIXTURE):
        print(f'  ❌ 找不到资料库 fixture：{VAULT_FIXTURE}')
        return 2
    for p in (DEV_PORT, CDP_PORT):
        if port_open(p):
            print(f'  ❌ 端口 {p} 已被占用（先停掉正在跑的回归/演练）')
            return 2

    ts = time.strftime('%Y%m%d-%H%M%S')
    out_dir = os.path.join(ROOT, 'build', 'note-binding', ts)
    os.makedirs(out_dir, exist_ok=True)
    src_sha = sha256(project)
    fixture_sha_before = tree_sha(VAULT_FIXTURE)
    work = os.path.join(out_dir, 'work-copy.sitian')
    shutil.copy2(project, work)
    vault = os.path.join(out_dir, 'vault-copy')
    shutil.copytree(VAULT_FIXTURE, vault)
    print('=== 标记/剧本 ↔ 笔记绑定（B1）· 真机 + 项目副本 + 资料库副本 ===')
    print(f'  源项目（只读）：{project}')
    print(f'  资料库（副本）：{vault}', flush=True)

    import run_tests as RT
    from lib.cdp import CDP, wait_for, eval_json, skip_onboarding

    node = shutil.which('node')
    exe = os.path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    profile = os.path.join(out_dir, 'userdata')
    shutil.rmtree(profile, ignore_errors=True)
    os.makedirs(profile, exist_ok=True)
    # 隔离 profile + 把资料库指到**副本**（索引会写进副本，仓里的 fixture 一个字节都不动）
    with open(os.path.join(profile, 'config.json'), 'w', encoding='utf-8') as f:
        json.dump({'vaultPath': vault}, f, ensure_ascii=False, indent=2)

    dev = el = None
    result = {}
    try:
        dev = subprocess.Popen([node, os.path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
                                '--config', 'vite.config.js'],
                               cwd=ROOT, stdout=open(os.path.join(out_dir, 'vite.log'), 'w'),
                               stderr=subprocess.STDOUT)
        if not wait_http('http://localhost:%d/' % DEV_PORT):
            print('  ❌ Vite 没起来（看 vite.log）')
            return 1
        env = dict(os.environ)
        env['NODE_ENV'] = 'development'
        env.pop('OPEN_DEVTOOLS', None)
        env.pop('ELECTRON_RUN_AS_NODE', None)
        el = subprocess.Popen([exe, '--user-data-dir=%s' % profile,
                               '--remote-debugging-port=%d' % CDP_PORT,
                               '--remote-allow-origins=*', '.'],
                              cwd=ROOT, env=env,
                              stdout=open(os.path.join(out_dir, 'electron.log'), 'w'),
                              stderr=subprocess.STDOUT)
        if not wait_port(CDP_PORT):
            print('  ❌ Electron CDP 没起来（看 electron.log）')
            return 1

        cdp = CDP(port=CDP_PORT)
        wait_for(cdp, "document.readyState === 'complete' && !!document.querySelector('.app-layout')",
                 timeout=180, desc='应用挂载')
        RT.apply_viewport(cdp)
        handle_disclaimer(cdp)
        skip_onboarding(cdp)

        # 资料索引（真实产物：索引写进**副本**库的 .sitian/）
        idx = eval_json(cdp, """(async () => {
          const r = await window.sitianAPI.vaultIndexBuild({ forceFull: true });
          return JSON.stringify({ ok: !!(r && r.success), total: (r && r.total) || 0,
            err: (r && r.error) || '' });
        })()""", required=('ok',), desc='建资料索引')[1]
        idx_file = os.path.join(vault, '.sitian', 'note-index.json')
        print(f"  · 资料索引：{json.dumps(idx, ensure_ascii=False)[:160]}（{idx_file} 存在={os.path.exists(idx_file)}）",
              flush=True)
        ck('资料索引建立成功（写在副本库的 .sitian/ 里，仓里的 fixture 不动）',
           bool(idx.get('ok')) and int(idx.get('total') or 0) > 0 and os.path.exists(idx_file),
           f"total={idx.get('total')} / {idx.get('err')}")

        opened = eval_json(cdp, """(async () => {
          const app = document.querySelector('#app').__vue_app__;
          const { useProjectStore } = await import('/src/store/projectStore.js');
          const ps = useProjectStore(app.config.globalProperties.$pinia);
          const r = await ps.openProject(%s);
          return JSON.stringify({ ok: !!(r && r.success !== false), err: (r && r.error) || '',
                                  filePath: ps.filePath || '' });
        })()""" % json.dumps(work), required=('ok',), desc='打开工作副本')[1]
        ck('打开的是工作副本（不是源项目）',
           os.path.normcase(str(opened.get('filePath') or '')) == os.path.normcase(work),
           opened.get('filePath'))
        time.sleep(2.0)
        cdp.eval("(() => { const b = document.querySelector('.recovery-overlay .btn-discard');"
                 " if (b) b.click(); return 'ok'; })()")
        time.sleep(0.8)

        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find((x) => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
        try:
            wait_for(cdp, "!!document.querySelector('.sp-card')", timeout=90, desc='剧本卡片墙')
            cdp.eval("(() => { const c = document.querySelector('.sp-card'); if (c) c.click(); return 'ok'; })()")
        except RuntimeError:
            ck('进入剧本编辑器', False, '卡片墙没出现')
            return 1
        wait_for(cdp, "!!document.querySelector('.scenario-map-container canvas')", timeout=90, desc='剧本画布')
        # 🔴 卡片点击 → 选中剧本是**异步**的（Vue 更新 + 剧本装载）：不等它，面板就是空的（第一跑真踩）
        try:
            wait_for(cdp, "!!(document.querySelector('.scenario-map-container').__vueParentComponent"
                          ".setupState.selectedScenario)",
                     timeout=30, desc='剧本被选中')
        except RuntimeError:
            # 再点一次卡片（有时首帧卡片还没挂完监听）
            cdp.eval("(() => { const c = document.querySelector('.sp-card'); if (c) c.click(); return 'ok'; })()")
            wait_for(cdp, "!!(document.querySelector('.scenario-map-container').__vueParentComponent"
                          ".setupState.selectedScenario)", timeout=30, desc='剧本被选中（重点一次）')
        time.sleep(1.0)

        setup = eval_json(cdp, SETUP_JS, required=('ok',), desc='建标记并打开面板')[1]
        ck('标记面板打开（面板里有“资料”段）',
           bool(setup.get('ok')) and setup.get('panel') is True and setup.get('vault') is True,
           json.dumps(setup, ensure_ascii=False)[:200])
        if not setup.get('ok'):
            return 1
        sid = setup.get('sid')

        # 资料段按标记名检索（异步）—— 等到出现“绑定”按钮
        try:
            wait_for(cdp, "document.querySelectorAll('[data-testid=\"marker-vault-bind\"]').length > 0",
                     timeout=20, desc='资料命中')
            hits = eval_json(cdp, HITS_JS, required=('ok',), desc='读命中')[1]
            ck('按标记名搜到了库内笔记（有“绑定”按钮）', int(hits.get('hits') or 0) > 0,
               json.dumps(hits, ensure_ascii=False)[:200])
        except RuntimeError:
            hits = eval_json(cdp, HITS_JS, required=('ok',), desc='读命中')[1]
            ck('按标记名搜到了库内笔记（有“绑定”按钮）', False, json.dumps(hits, ensure_ascii=False)[:200])
            return 1
        hit_path = hits.get('first') or ''
        print(f"  · 首条命中：{hit_path}", flush=True)

        # ── ① 绑定 ────────────────────────────────────────────────────────
        st0 = os.stat(work)
        sig0 = (st0.st_mtime_ns, st0.st_size)
        bind = eval_json(cdp, BIND_JS, required=('ok',), desc='点绑定')[1]
        st1 = eval_json(cdp, STATE_JS, required=('ok',), desc='绑定后状态')[1]
        ck('点“绑定”后标记上出现 notePath',
           bool(bind.get('ok')) and st1.get('markerNote') == hit_path.replace('\\', '/'),
           f"marker.notePath={st1.get('markerNote')!r} / 命中 {hit_path!r}")
        base = hit_path.split('/')[-1]
        base = base[:-3] if base.lower().endswith('.md') else base
        ck('面板显示“已绑定 + 那篇笔记”',
           bool(st1.get('bound')) and (base in (st1.get('boundText') or '')),
           st1.get('boundText'))
        ck('绑定后没有误报“找不到了”', st1.get('dangling') is False, json.dumps(st1, ensure_ascii=False)[:160])

        # ── ② 落盘 ────────────────────────────────────────────────────────
        changed = wait_file_change(work, sig0, timeout=25.0)
        scen_disk, marker_disk = disk_marker(work, sid, 'note_probe_marker')
        ck('项目文件真的变了', changed, f'{sig0}')
        ck('磁盘上的标记带 notePath（读盘核对）',
           bool(marker_disk) and (marker_disk.get('notePath') or '') == hit_path.replace('\\', '/'),
           json.dumps(marker_disk, ensure_ascii=False)[:200])

        # ── ③ Ctrl+Z：内存与磁盘都退回 ────────────────────────────────────
        # 🔴 两条真机纪律（A1 演练里踩过，这里复用）：窗口没被 OS 聚焦时 CDP 按键到不了页面；
        #    程序化 .click() 又不移动焦点，而全局 Ctrl+Z 在 INPUT/TEXTAREA 上故意让路。
        eval_json(cdp, """(() => {
          window.__KEYLOG__ = [];
          if (!window.__KEYPROBE__) {
            window.__KEYPROBE__ = true;
            window.addEventListener('keydown', (e) => {
              if (window.__KEYLOG__ && window.__KEYLOG__.length < 20) {
                window.__KEYLOG__.push({ key: e.key, ctrl: !!e.ctrlKey, tag: (e.target && e.target.tagName) || '' });
              }
            }, true);
          }
          try { if (document.activeElement) document.activeElement.blur(); } catch (e) {}
          try { document.body.focus(); } catch (e) {}
          return JSON.stringify({ ok: true });
        })()""", required=('ok',), desc='装按键探针 + 摘焦点')
        rc = eval_json(cdp, """(() => {
          const p = document.querySelector('.scenario-map-container canvas');
          if (!p) return JSON.stringify({ ok: false });
          const r = p.getBoundingClientRect();
          return JSON.stringify({ ok: true, x: Math.round(r.left + r.width - 40), y: Math.round(r.top + 40) });
        })()""", required=('ok',), desc='取画布角落坐标')[1]
        if rc.get('ok'):
            for t in ('mousePressed', 'mouseReleased'):
                cdp.send('Input.dispatchMouseEvent', {'type': t, 'x': rc['x'], 'y': rc['y'],
                                                      'button': 'left', 'clickCount': 1})
            time.sleep(0.2)
        try:
            cdp.send('Page.bringToFront')
            time.sleep(0.2)
        except Exception:
            pass
        sig_before_undo = (os.stat(work).st_mtime_ns, os.path.getsize(work))
        ctrl_z(cdp)
        time.sleep(0.6)
        keylog = eval_json(cdp, """(() => {
          const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
          return JSON.stringify({ ok: true, log: window.__KEYLOG__ || [],
            canUndo: !!s.canUndo, canRedo: !!s.canRedo, label: (s.undoLabel || '') + '' });
        })()""", required=('ok',), desc='读按键探针')[1]
        undo_via = 'cdp'
        print(f"  · Ctrl+Z（CDP 真按键）：页面收到 {json.dumps(keylog.get('log'), ensure_ascii=False)}；"
              f"canRedo={keylog.get('canRedo')}", flush=True)
        if not keylog.get('canRedo'):
            undo_via = 'synthetic'
            cdp.eval("""(() => {
              window.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true,
              }));
              return 'ok';
            })()""")
            time.sleep(0.5)
            keylog = eval_json(cdp, """(() => {
              const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
              return JSON.stringify({ ok: true, canUndo: !!s.canUndo, canRedo: !!s.canRedo,
                label: (s.undoLabel || '') + '' });
            })()""", required=('ok',), desc='兜底再按一次')[1]
        st2 = eval_json(cdp, STATE_JS, required=('ok',), desc='撤销后状态')[1]
        ck('Ctrl+Z 真的执行了（canRedo=true）', keylog.get('canRedo') is True,
           f"[{undo_via}] canRedo={keylog.get('canRedo')} / 栈顶={keylog.get('label')!r} / "
           f"页面收到 {keylog.get('log')}")
        ck('撤销后标记上的 notePath 没了', st2.get('markerNote') == '', st2.get('markerNote'))
        ck('撤销后面板回到“未绑定笔记”', '未绑定' in (st2.get('boundText') or ''),
           st2.get('boundText'))
        disk_changed = wait_file_change(work, sig_before_undo, timeout=25.0)
        _, marker_after_undo = disk_marker(work, sid, 'note_probe_marker')
        ck('撤销也落盘（磁盘上标记的 notePath 也没了）', disk_changed
           and (marker_after_undo or {}).get('notePath') in (None, ''),
           f"changed={disk_changed} / notePath={(marker_after_undo or {}).get('notePath')!r}")

        # ── ④ 反向探针：绑一个不存在的路径 → 必须显示“找不到了” ──────────
        # 撤销前点的那下画布会选中省份（面板因此收起）—— 重新把标记面板打开再看漂移
        reopen = eval_json(cdp, """(async () => {
          const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
          const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
          const NB = window.__NB__ || {};
          const sc = s.scenarios[NB.sid];
          const list = (sc && sc.markers) || [];
          const idx = list.findIndex((m) => m && m.id === NB.markerId);
          if (idx < 0) return JSON.stringify({ ok: false, why: 'marker-gone' });
          SM.openMarkerEditor(list[idx], idx);
          await new Promise((r) => setTimeout(r, 400));
          return JSON.stringify({ ok: true, panel: !!document.querySelector('[data-testid="marker-props"]') });
        })()""", required=('ok',), desc='重新打开标记面板')[1]
        ck('重新打开标记面板（看漂移用）', bool(reopen.get('ok')) and reopen.get('panel') is True,
           json.dumps(reopen, ensure_ascii=False)[:120])
        fake = eval_json(cdp, FAKE_JS, required=('ok',), desc='绑一个不存在的路径')[1]
        time.sleep(1.6)      # 面板会重新取一次清单（listVaultNotes）
        st3 = eval_json(cdp, STATE_JS, required=('ok',), desc='漂移状态')[1]
        ck('绑了不存在的路径（写口照常接受）', bool(fake.get('ok')), json.dumps(fake, ensure_ascii=False)[:120])
        ck('🔴 面板必须显示“找不到了”（漂移不静默）', st3.get('dangling') is True,
           json.dumps(st3, ensure_ascii=False)[:200])

        # 重连：绑回真笔记 → 提示消失
        eval_json(cdp, """(() => {
          const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
          s.updateScenarioMarker(window.__NB__.sid, window.__NB__.markerId, { notePath: %s });
          return JSON.stringify({ ok: true });
        })()""" % json.dumps(hit_path), required=('ok',), desc='绑回真笔记')
        time.sleep(1.6)
        st4 = eval_json(cdp, STATE_JS, required=('ok',), desc='重连后状态')[1]
        ck('重连（绑回真笔记）后“找不到了”消失', st4.get('dangling') is False and st4.get('bound') is True,
           json.dumps(st4, ensure_ascii=False)[:160])

        # ── ⑤ 非字符串必须整条拒绝 ────────────────────────────────────────
        bad = eval_json(cdp, BAD_JS, required=('ok',), desc='塞对象当路径')[1]
        ck('非字符串的 notePath 被整条拒绝（数据没被污染）',
           bad.get('ok') is False and bad.get('reason') == 'bad-note-path'
           and (bad.get('markerNote') or '') == hit_path.replace('\\', '/'),
           json.dumps(bad, ensure_ascii=False)[:160])

        # ── ⑥ 剧本侧同一个形状 ────────────────────────────────────────────
        sc_res = eval_json(cdp, """(async (path) => {
          const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
          const NB = window.__NB__ || {};
          const r = SM.bindScenarioNote({ path });
          await new Promise((res) => setTimeout(res, 200));
          const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
          const sc = s.scenarios[NB.sid];
          return JSON.stringify({ ok: !!(r && r.ok), note: (sc && sc.notePath) || '',
            label: (s.undoLabel || '') + '' });
        })(""" + json.dumps(hit_path) + ')', required=('ok',), desc='剧本绑定笔记')[1]
        ck('剧本侧也能绑（scenario.notePath）',
           bool(sc_res.get('ok')) and (sc_res.get('note') or '') == hit_path.replace('\\', '/'),
           json.dumps(sc_res, ensure_ascii=False)[:160])
        sc_un = eval_json(cdp, """(async () => {
          const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
          const r = SM.unbindScenarioNote();
          await new Promise((res) => setTimeout(res, 150));
          return JSON.stringify({ ok: !!(r && r.ok) });
        })()""", required=('ok',), desc='剧本解绑')[1]
        ck('剧本侧能解绑（键摘掉，不留空指针）', bool(sc_un.get('ok')), json.dumps(sc_un, ensure_ascii=False))

        # ── 只读纪律：源项目与仓里的 fixture 都没被动 ────────────────────
        ck('源项目只读（跑前/跑后 sha256 一致）', sha256(project) == src_sha, sha256(project)[:16])
        ck('仓里的资料库 fixture 一个字节都没动（索引写在副本里）',
           tree_sha(VAULT_FIXTURE) == fixture_sha_before, 'fixture tree sha')

        result = {
            'ts': ts, 'project': project, 'workCopy': work, 'vaultCopy': vault,
            'scenario': sid, 'hitPath': hit_path,
            'states': {'afterBind': st1, 'afterUndo': st2, 'dangling': st3, 'reconnected': st4},
            'disk': {'afterBind': marker_disk, 'afterUndo': marker_after_undo},
            'scenarioNote': sc_res, 'badPath': bad,
            'verdict': {'bad': len(fails), 'fails': fails},
        }
        with open(os.path.join(out_dir, 'result.json'), 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=1)
        md = [
            f'# 标记/剧本 ↔ 笔记绑定（B1）· {ts}', '',
            f'- 源项目（只读）：`{project}`', f'- 工作副本：`{work}`',
            f'- 资料库副本：`{vault}`（仓内 fixture 跑前/跑后同指纹）', '',
            '| 判据 | 结果 |', '|---|---|',
            f'| 绑定后 marker.notePath | **{st1.get("markerNote")}** |',
            f'| 面板显示 | {st1.get("boundText")} |',
            f'| 磁盘上的 notePath | **{(marker_disk or {}).get("notePath")}** |',
            f'| 撤销后（内存 / 磁盘） | {st2.get("markerNote")!r} / {(marker_after_undo or {}).get("notePath")!r} |',
            f'| 绑不存在的路径 → 漂移提示 | {st3.get("dangling")} |',
            f'| 重连后提示消失 | not dangling = {not st4.get("dangling")} |',
            f'| 非字符串被拒 | {bad.get("reason")} |',
            f'| 剧本侧 notePath | {sc_res.get("note")} |',
            '', f'结论：**{len(fails)} 项没过**',
        ]
        with open(os.path.join(out_dir, 'summary.md'), 'w', encoding='utf-8') as f:
            f.write('\n'.join(md) + '\n')
        print('\n' + '\n'.join(md), flush=True)
        print(('  ✅ 笔记绑定判据通过' if not fails else f'  🔴 {len(fails)} 项没过'), flush=True)
        return 0 if not fails else 1
    finally:
        if el is not None:
            subprocess.run(['taskkill', '/PID', str(el.pid), '/T', '/F'], capture_output=True)
        if dev is not None:
            subprocess.run(['taskkill', '/PID', str(dev.pid), '/T', '/F'], capture_output=True)
        shutil.rmtree(profile, ignore_errors=True)
        for junk in (work + '.backups',):
            shutil.rmtree(junk, ignore_errors=True)
        try:
            os.remove(work + '.session-baseline.sitian')
        except Exception:
            pass
        print('  · 隔离 profile 已清理', flush=True)


if __name__ == '__main__':
    code = main()
    if code:
        print('\n🔴 %d 项失败' % len(fails))
        for f in fails:
            print('  - ' + f)
    sys.exit(code)
