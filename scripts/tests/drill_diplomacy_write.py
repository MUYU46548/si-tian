#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""外交关系「可写」的端到端判据（A1，2026-11-05）

背景（阶段目标卡 P0）：外交表做完时**只能查不能写** —— `addTimelineEvent` / `setTimelineEvents`
只存在于 `scenarioEditing.js`，`.vue` 里 0 调用者。于是“某年 A 与 B 是什么关系”答得出来，
但用户纠正不了：想补一条“甲乙在 1348 年结盟”没有任何入口。

A1 的最小闭环就四步，本工具**全走产品自己的入口**（真 Electron + 真项目文件副本）：
  ① 面板里改一条关系（选甲 / 乙 + 类型 + 起年 → 点“记下这条”）；
  ② 面板当场生效（关系从“中立”变“同盟”，结果区与“为什么”都换）；
  ③ **写进项目文件**（等两层防抖落盘 → 读磁盘 JSON 核对 `timelineEvents`）；
  ④ **Ctrl+Z 撤回**，并且**磁盘也撤回**（2026-11-05 修：撤销回调里此前没有排保存，
     于是“撤了 → 关掉重开 → 又回来了”）。

另有一条**反向探针**（判据不许恒真）：起止颠倒的录入必须被整条拒绝，而且事件表一条都不许多。

用法：
  python scripts/tests/drill_diplomacy_write.py            # 默认用仓内示例项目（72 省 / 4 势力）
  python scripts/tests/drill_diplomacy_write.py --project <file.sitian>

⚠️ 会开一个真实 Electron 窗口（约 1~2 分钟）；独占 5180 / 9228，别和回归或其它演练同时跑。
产物：`build/diplomacy-write/<时间戳>/{result.json, summary.md, vite.log, electron.log}`
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
CDP_PORT = 9228          # 9222=Edge 回归 / 9224=行星截图 / 9226=涂归属 / 9227=撤销时延，这里避开

fails = []


# ══════════════════════════════════════════════════════════════════════════
# 页面侧脚本（全部走产品入口：面板 DOM + store 唯一写口）
# ══════════════════════════════════════════════════════════════════════════

# 打开外交面板：先用势力色板那行的常驻入口，没有就退回“更多 → 外交”（两条路同一个面板）。
# ⚠️ 色板行只在 `viewMode === 'scenario' && selectedScenario` 时渲染；卡片进来如果还没选中剧本，
#    它就不在 DOM 里 —— 这不是缺陷，所以这里**两条路都试**，并把当时的 mode/选中态写进回执。
OPEN_JS = r"""(async () => {
  const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tryClick = (sel) => {
    const b = document.querySelector(sel);
    if (!b) return false;
    b.click();
    return true;
  };
  let how = '';
  if (tryClick('[data-testid="diplomacy-open-palette"]')) {
    how = 'palette';
  } else {
    tryClick('button[title^="更多"]');
    await sleep(250);
    if (tryClick('[data-testid="diplomacy-open"]')) how = 'more';
  }
  await sleep(300);
  const panel = document.querySelector('[data-testid="diplomacy-panel"]');
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const sc = SM.selectedScenario;
  if (!panel || !sc) {
    return JSON.stringify({ ok: false, why: how ? 'opened-no-panel' : 'no-entry', how,
      mode: SM.viewMode, hasScenario: !!sc,
      candidates: Array.from(document.querySelectorAll('[data-testid^="diplomacy-open"]')).map((x) => x.dataset.testid) });
  }
  window.__DIP__ = { sid: sc.id, era: sc.era || {}, how,
    polities: (sc.polities || []).map((p) => ({ id: String(p.id), name: p.name || '' })) };
  return JSON.stringify({ ok: true, panel: !!panel, how, sid: sc.id,
    polities: (sc.polities || []).map((p) => ({ id: String(p.id), name: p.name || '' })),
    events: ((sc.timelineEvents) || []).length });
})()"""

# 填表单：甲 / 乙 / 类型 / 起年 / 止年 / 标题 —— 全部按真人操作（改 DOM 值 + 派发事件）
FILL_JS = r"""(async () => {
  const D = window.__DIP__;
  const set = (sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.value = String(val);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    return true;
  };
  const ids = D.polities.map((p) => p.id);
  const okA = set('[data-testid="diplomacy-a"]', ids[0]);
  const okB = set('[data-testid="diplomacy-b"]', ids[1]);
  const okT = set('[data-testid="diplomacy-type"]', D.type);
  const okF = set('[data-testid="diplomacy-from-year"]', D.from);
  const okTo = set('[data-testid="diplomacy-to-year"]', D.to === null ? '' : D.to);
  const okN = set('[data-testid="diplomacy-title"]', D.title || '');
  // 年份也拨到起始年那一年：面板结果区按"游标那一天"算关系，不拨的话录完仍显示中立
  const yearEl = document.querySelector('[data-testid="diplomacy-year"]');
  if (yearEl) {
    yearEl.value = String(D.from);
    yearEl.dispatchEvent(new Event('change', { bubbles: true }));
  }
  await new Promise((r) => setTimeout(r, 160));
  const typeEl = document.querySelector('[data-testid="diplomacy-type"]');
  return JSON.stringify({ ok: okA && okB && okT && okF && okTo && okN,
    a: document.querySelector('[data-testid="diplomacy-a"]').value,
    b: document.querySelector('[data-testid="diplomacy-b"]').value,
    type: typeEl ? typeEl.value : null });
})()"""

SUBMIT_JS = r"""(async () => {
  const b = document.querySelector('[data-testid="diplomacy-add"]');
  if (!b) return JSON.stringify({ ok: false, why: 'no-button' });
  b.click();
  await new Promise((r) => setTimeout(r, 220));
  const msg = document.querySelector('[data-testid="diplomacy-add-msg"]');
  const result = document.querySelector('[data-testid="diplomacy-result"]');
  return JSON.stringify({ ok: true,
    msg: msg ? (msg.textContent || '').trim() : '',
    result: result ? (result.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220) : '' });
})()"""

# 内存态：事件表 / 关系查询 / 面板文案
MEM_JS = r"""(() => {
  const D = window.__DIP__ || {};
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const sc = D.sid ? s.scenarios[D.sid] : null;
  const events = (sc && sc.timelineEvents) || [];
  const ids = (D.polities || []).map((p) => p.id);
  const at = D.queryYear;
  const rel = (D.sid && ids[0] && ids[1]) ? s.queryRelationAt(D.sid, ids[0], ids[1], at) : null;
  return JSON.stringify({
    ok: !!sc,
    events: events.length,
    last: events.length ? events[events.length - 1] : null,
    relation: rel ? rel.relation : null,
    relationLabel: rel ? rel.label : null,
    relationText: rel ? (rel.text || '').slice(0, 160) : '',
    canUndo: !!s.canUndo, canRedo: !!s.canRedo, undoLabel: (s.undoLabel || '') + '',
    panel: !!document.querySelector('[data-testid="diplomacy-panel"]'),
  });
})()"""


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
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
    """等文件 (mtime, size) 变化；返回 True/False。"""
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
    """首启免责声明（隔离 profile 里会弹）—— 按产品自己的路径走完；没弹也算处理完。"""
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


def disk_scenario(path, sid):
    """读磁盘上的项目文件，返回某段剧本与它的事件表（只看盘，不看内存）。"""
    with open(path, 'rb') as f:
        data = json.loads(f.read().decode('utf-8'))
    scen = (((data.get('scenarios') or {}).get('scenarios')) or {}).get(sid) or {}
    return scen, (scen.get('timelineEvents') or [])


def main():
    args = sys.argv[1:]
    project = args[args.index('--project') + 1] if '--project' in args else os.path.join(ROOT, 'sample', '示例世界.sitian')
    if not os.path.exists(project):
        print(f'  ❌ 找不到项目：{project}')
        return 2
    for p in (DEV_PORT, CDP_PORT):
        if port_open(p):
            print(f'  ❌ 端口 {p} 已被占用（先停掉正在跑的回归/演练）')
            return 2

    ts = time.strftime('%Y%m%d-%H%M%S')
    out_dir = os.path.join(ROOT, 'build', 'diplomacy-write', ts)
    os.makedirs(out_dir, exist_ok=True)
    src_sha = sha256(project)
    work = os.path.join(out_dir, 'work-copy.sitian')
    shutil.copy2(project, work)
    print('=== 外交关系可写（A1）· 真机 + 项目副本 ===')
    print(f'  源项目（只读）：{project}')
    print(f'  工作副本：{work}', flush=True)

    import run_tests as RT
    from lib.cdp import CDP, wait_for, eval_json, skip_onboarding

    node = shutil.which('node')
    exe = os.path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    profile = os.path.join(out_dir, 'userdata')
    shutil.rmtree(profile, ignore_errors=True)
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
            ck('能进入剧本编辑器（卡片墙 → 剧本）', False, '卡片墙没出现')
            return 1
        wait_for(cdp, "!!document.querySelector('.scenario-map-container canvas')", timeout=90, desc='剧本画布')
        time.sleep(1.5)

        opened_panel = eval_json(cdp, OPEN_JS, required=('ok',), desc='打开外交面板')[1]
        ck('外交面板能打开', bool(opened_panel.get('ok')), json.dumps(opened_panel, ensure_ascii=False)[:160])
        if not opened_panel.get('ok'):
            return 1
        polities = opened_panel.get('polities') or []
        sid = opened_panel.get('sid')
        base_events = int(opened_panel.get('events') or 0)
        ck('该剧本至少两个势力（面板才有甲乙可选）', len(polities) >= 2, f'{len(polities)} 个')
        if len(polities) < 2:
            return 1
        era = {}
        info = eval_json(cdp, """(() => {
          const D = window.__DIP__;
          const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
          const sc = s.scenarios[D.sid];
          return JSON.stringify({ ok: true, era: sc.era || {}, name: sc.name || '',
                                  polities: (sc.polities || []).map((p) => p.name || p.id) });
        })()""", required=('ok',), desc='剧本信息')[1]
        era = info.get('era') or {}
        start_year = int(float(era.get('startYear') or 100))
        end_year = int(float(era.get('endYear') or (start_year + 100)))
        from_year = start_year + 10
        to_year = min(end_year - 10, from_year + 60)
        cdp.eval('(() => { window.__DIP__.queryYear = %d; return "ok"; })()' % from_year)
        print(f"  · 剧本 {sid}（{info.get('name')}）：{', '.join(info.get('polities') or [])} · "
              f"{start_year}~{end_year} · 基线事件 {base_events} 条", flush=True)

        # ── ① 填一条同盟 ──────────────────────────────────────────────────
        cdp.eval('(() => { Object.assign(window.__DIP__, %s); return "ok"; })()'
                 % json.dumps({'type': 'alliance', 'from': from_year, 'to': to_year,
                               'title': '判据：甲乙结盟'}, ensure_ascii=False))
        filled = eval_json(cdp, FILL_JS, required=('ok',), desc='填表（甲乙/类型/起止/标题）')[1]
        ck('表单填进去了（甲 / 乙 / 类型 = 同盟）',
           bool(filled.get('ok')) and filled.get('type') == 'alliance'
           and filled.get('a') == polities[0]['id'] and filled.get('b') == polities[1]['id'],
           json.dumps(filled, ensure_ascii=False)[:160])

        before_stat = os.stat(work)
        before_sig = (before_stat.st_mtime_ns, before_stat.st_size)
        sub = eval_json(cdp, SUBMIT_JS, required=('ok',), desc='点“记下这条”')[1]
        ck('点“记下这条”后有回执', '已记下' in (sub.get('msg') or ''), (sub.get('msg') or '')[:160])

        mem = eval_json(cdp, MEM_JS, required=('ok',), desc='读内存态')[1]
        last = mem.get('last') or {}
        ck('事件表 +1（内存）', int(mem.get('events') or 0) == base_events + 1,
           f"{base_events} → {mem.get('events')}")
        ck('事件形状对（同盟 / 两方 / 起始年 / 标题）',
           last.get('type') == 'alliance'
           and [str(x) for x in (last.get('actors') or [])] == [polities[0]['id'], polities[1]['id']]
           and int((last.get('from') or {}).get('y') or 0) == from_year
           and (last.get('title') or '') == '判据：甲乙结盟',
           json.dumps(last, ensure_ascii=False)[:200])
        ck('查询立刻变同盟（面板读的就是这条账本）',
           mem.get('relation') == 'Ally', f"{mem.get('relation')} / {mem.get('relationLabel')}")
        ck('面板结果区还写着“同盟”', '同盟' in (sub.get('result') or '') or '同盟' in (mem.get('relationText') or ''),
           (sub.get('result') or '')[:120])

        # ── ② 反向探针：起止颠倒必须被整条拒绝 ─────────────────────────────
        cdp.eval('(() => { Object.assign(window.__DIP__, %s); return "ok"; })()'
                 % json.dumps({'type': 'war', 'from': start_year + 80, 'to': start_year + 40,
                               'title': '判据：倒着的战争'}, ensure_ascii=False))
        eval_json(cdp, FILL_JS, required=('ok',), desc='填颠倒的起止')
        bad_sub = eval_json(cdp, SUBMIT_JS, required=('ok',), desc='提交颠倒的起止')[1]
        mem_bad = eval_json(cdp, MEM_JS, required=('ok',), desc='读拒绝后的内存态')[1]
        ck('颠倒的起止被拒绝（回执说“没有记下”）',
           '没有记下' in (bad_sub.get('msg') or ''), (bad_sub.get('msg') or '')[:160])
        ck('拒绝理由点名“早于”', '早于' in (bad_sub.get('msg') or ''), (bad_sub.get('msg') or '')[:160])
        ck('被拒的录入一条都不许写进去', int(mem_bad.get('events') or 0) == base_events + 1,
           f"事件 {mem.get('events')} → {mem_bad.get('events')}")

        # ── ③ 落盘：等两层防抖真的写进项目文件 ────────────────────────────
        changed = wait_file_change(work, before_sig, timeout=25.0)
        scen_disk, evs_disk = disk_scenario(work, sid)
        ck('写入落盘（项目文件真的变了）', changed, f'mtime/size {before_sig}')
        disk_last = evs_disk[-1] if evs_disk else {}
        ck('磁盘上事件表 +1（读盘，不看内存）', len(evs_disk) == base_events + 1,
           f'{base_events} → {len(evs_disk)}')
        ck('磁盘上的那条事件字段齐（同盟 / 标题 / 起年）',
           disk_last.get('type') == 'alliance' and (disk_last.get('title') or '') == '判据：甲乙结盟'
           and int((disk_last.get('from') or {}).get('y') or 0) == from_year,
           json.dumps(disk_last, ensure_ascii=False)[:200])

        # ── ④ 撤销：内存与磁盘都要退回去 ──────────────────────────────────
        # 🔴 先把焦点从任何输入框上摘掉：App 的全局 Ctrl+Z 在 `typing`（INPUT/TEXTAREA…）时**故意让路**
        #    （不然在搜索框里按 Ctrl+Z 会撤地图数据）。程序化 `.click()` 不会移动焦点，
        #    不 blur 的话这一按会被当成"正在打字"吞掉（第一跑就是这么假红的）。
        focus = eval_json(cdp, """(() => {
          const a = document.activeElement;
          const tag = a ? a.tagName : '';
          try { if (a && a.blur) a.blur(); } catch (e) {}
          try { document.body.focus(); } catch (e) {}
          const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
          return JSON.stringify({ ok: true, prevFocus: tag,
            canUndo: !!s.canUndo, undoLabel: (s.undoLabel || '') + '' });
        })()""", required=('ok',), desc='撤销前摘焦点')[1]
        print(f"  · 撤销前：焦点 {focus.get('prevFocus')} / canUndo={focus.get('canUndo')} / "
              f"栈顶={focus.get('undoLabel')!r}", flush=True)
        ck('撤销前栈顶就是这条录入（“录入事件：判据：甲乙结盟”）',
           '判据：甲乙结盟' in (focus.get('undoLabel') or ''), focus.get('undoLabel'))
        # 撤销后要等文件再变一次 —— 指纹必须是"撤销前那一版"
        st_undo = os.stat(work)
        sig_before_undo = (st_undo.st_mtime_ns, st_undo.st_size)
        # 先装一个**只记不改**的 keydown 探针：区分"按键没到页面"与"到了但没生效"
        # （2026-11-05 真踩：卸载/浮层场景里 CDP 按键偶尔不进渲染进程，读数是"撤销没生效"，
        #   实际是输入没送到 —— 不先分清就会去改产品代码）
        cdp.eval("""(() => {
          window.__KEYLOG__ = [];
          if (!window.__KEYPROBE__) {
            window.__KEYPROBE__ = true;
            window.addEventListener('keydown', (e) => {
              if (window.__KEYLOG__ && window.__KEYLOG__.length < 20) {
                window.__KEYLOG__.push({ key: e.key, ctrl: !!e.ctrlKey, tag: (e.target && e.target.tagName) || '' });
              }
            }, true);
          }
          return 'ok';
        })()""")
        # 🔴 先给页面一点"真实的输入"：Electron 窗口没被 OS 聚焦时，CDP 的按键事件不会进渲染进程
        #    （本跑实测：页面 keydown 探针收到 0 条）。在面板标题区点一下（不是按钮、无副作用）
        #    让窗口拿到焦点，再按 Ctrl+Z —— 这样走的才是"真人按键"那条路。
        rc = eval_json(cdp, """(() => {
          const p = document.querySelector('[data-testid="diplomacy-panel"]');
          if (!p) return JSON.stringify({ ok: false });
          const r = p.getBoundingClientRect();
          return JSON.stringify({ ok: true, x: Math.round(r.left + 24), y: Math.round(r.top + 14) });
        })()""", required=('ok',), desc='取面板标题坐标')[1]
        if rc.get('ok'):
            for t in ('mousePressed', 'mouseReleased'):
                cdp.send('Input.dispatchMouseEvent', {'type': t, 'x': rc['x'], 'y': rc['y'],
                                                      'button': 'left', 'clickCount': 1})
            time.sleep(0.2)
        # 让窗口成为前台页：CDP 的按键事件在没有前台页时会被丢掉（本跑实测：探针收到 0 条）
        try:
            cdp.send('Page.bringToFront')
            time.sleep(0.2)
        except Exception:
            pass
        ctrl_z(cdp)
        time.sleep(0.55)
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
            # 兜底：同一条产品监听（window keydown）上用**页面内 KeyboardEvent** 再按一次。
            # 只在"CDP 按键没送到"时走这条路，结果里会写明走的哪条（不混为一谈）。
            cdp.eval("""(() => {
              window.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true,
              }));
              return 'ok';
            })()""")
            time.sleep(0.5)
            keylog2 = eval_json(cdp, """(() => {
              const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
              return JSON.stringify({ ok: true, canUndo: !!s.canUndo, canRedo: !!s.canRedo,
                label: (s.undoLabel || '') + '' });
            })()""", required=('ok',), desc='兜底再按一次 Ctrl+Z')[1]
            keylog = keylog2
            print(f"  · 兜底（页面内 KeyboardEvent）：canRedo={keylog.get('canRedo')}", flush=True)
        ck('Ctrl+Z 到了产品监听并且真的执行了（撤销后 canRedo = true）',
           bool(keylog.get('canRedo')) is True,
           f"[{undo_via}] canRedo={keylog.get('canRedo')} / canUndo={keylog.get('canUndo')} / "
           f"栈顶={keylog.get('label')!r} / 页面收到 {keylog.get('log')}")
        mem_undo = eval_json(cdp, MEM_JS, required=('ok',), desc='撤销后内存态')[1]
        ck('Ctrl+Z：内存里事件表回到基线', int(mem_undo.get('events') or 0) == base_events,
           f"{mem_bad.get('events')} → {mem_undo.get('events')}")
        ck('Ctrl+Z：关系回到“中立/无记录”', mem_undo.get('relation') in ('Neutral', None),
           f"{mem_undo.get('relation')}")

        disk_changed = wait_file_change(work, sig_before_undo, timeout=25.0)
        _, evs_after_undo = disk_scenario(work, sid)
        ck('撤销也落盘（磁盘上事件表回到基线）', disk_changed,
           f'文件有无再变：{disk_changed}')
        ck('磁盘事件表条数 = 基线', len(evs_after_undo) == base_events,
           f'{len(evs_after_undo)} 条')

        # ── 只读纪律：源项目一个字节都没动 ────────────────────────────────
        ck('源项目只读（跑前/跑后 sha256 一致）', sha256(project) == src_sha, sha256(project)[:16])

        result = {
            'ts': ts, 'project': project, 'projectSha256': src_sha, 'workCopy': work,
            'scenario': sid, 'polities': polities, 'baseEvents': base_events,
            'fromYear': from_year, 'toYear': to_year,
            'submitted': sub.get('msg'), 'rejected': bad_sub.get('msg'),
            'memory': {'afterAdd': mem, 'afterReject': mem_bad, 'afterUndo': mem_undo},
            'disk': {'afterAdd': len(evs_disk), 'afterUndo': len(evs_after_undo)},
            'undoVia': undo_via,
            'verdict': {'bad': len(fails), 'fails': fails},
        }
        with open(os.path.join(out_dir, 'result.json'), 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=1)
        md = [
            f'# 外交关系可写（A1）· {ts}', '',
            f'- 源项目（只读）：`{project}`', f'- 工作副本：`{work}`',
            f'- 剧本：`{sid}`（{info.get("name")}）· 势力 {", ".join(info.get("polities") or [])}',
            f'- 录入：同盟 {from_year} ~ {to_year}（基线事件 {base_events} 条）', '',
            '| 判据 | 结果 |', '|---|---|',
            f'| 录入后内存事件数 | **{mem.get("events")}** |',
            f'| 查询结果 | **{mem.get("relation")} / {mem.get("relationLabel")}** |',
            f'| 颠倒起止被拒 | {bad_sub.get("msg")} |',
            f'| 落盘事件数（读盘） | **{len(evs_disk)}** |',
            f'| 撤销后内存事件数 | **{mem_undo.get("events")}** |',
            f'| 撤销后磁盘事件数 | **{len(evs_after_undo)}** |',
            f'| 撤销按键路径 | {"真按键（CDP Input）" if undo_via == "cdp" else "页面内 KeyboardEvent（CDP 按键没送到窗口）"} |',
            '', f'结论：**{len(fails)} 项没过**',
        ]
        with open(os.path.join(out_dir, 'summary.md'), 'w', encoding='utf-8') as f:
            f.write('\n'.join(md) + '\n')
        print('\n' + '\n'.join(md), flush=True)
        print(('  ✅ 外交可写判据通过' if not fails else f'  🔴 {len(fails)} 项没过'), flush=True)
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
