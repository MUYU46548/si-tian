#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 56：一键同步到远程仓库（面板可达性 + 傻瓜式契约）

主进程的真实 git 行为由 `scripts/tests/unit/test_git_sync.js` 覆盖（本地 bare 仓库当远程，真 git 端到端）。
本用例只守**用户看得到的那一层**——因为「按钮点了没反应 / 输入框点不进去」这类问题
只有 UI 层用例能抓到（历史教训：§130.2）：

  a) 工具栏有同步入口，点了会打开面板（面板是懒加载 → 必须等它挂载，不能点完就断言）
  b) 面板内容齐备：同步目录 / 仓库地址输入 / 「立即同步」按钮 / 令牌是 password 且不回显
  c) 填地址 → 保存 → 真的调到了主进程（mock 记录调用），并给出成功提示
  d) 点「立即同步」→ 真的调到主进程
  e) 没有项目时：面板给出空态 + 「去项目面板」的去处（而不是一个点了没反应的按钮）
  f) 静态：App.vue 懒加载挂载 + 工具栏入口 + preload 四通道 + handler 顶层不依赖 electron
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.helpers import ensure_case_state   # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
APP = "document.querySelector('#app').__vue_app__"


def _wait(cdp, expr, timeout=6.0, step=0.15):
    """轮询等待（懒加载面板的挂载窗口不能靠死等）"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if cdp.eval(expr):
            return True
        time.sleep(step)
    return False


def _open_panel(cdp):
    """点工具栏的同步按钮 → 等面板挂载"""
    btn = cdp.eval("""(() => {
      const b = Array.from(document.querySelectorAll('button'))
        .find(x => (x.getAttribute('title') || '').indexOf('远程仓库') >= 0);
      if (!b) return 'no-btn';
      b.click();
      return 'ok';
    })()""")
    if btn != 'ok':
        return False, '工具栏未找到「同步到远程仓库」按钮'
    if not _wait(cdp, "!!document.querySelector('.git-sync-panel')"):
        return False, '点了同步按钮但面板没有出现（懒加载挂载失败）'
    return True, ''


def run(cdp):
    ensure_case_state(cdp)

    # ── a) 入口 + 面板能打开 ─────────────────────────────────────────────
    ok, err = _open_panel(cdp)
    if not ok:
        return False, err

    # ── b) 面板内容齐备 ──────────────────────────────────────────────────
    shape = cdp.eval("""(() => {
      const p = document.querySelector('.git-sync-panel');
      const inputs = Array.from(p.querySelectorAll('input'));
      const texts = Array.from(p.querySelectorAll('button')).map(b => (b.textContent || '').trim());
      const pwd = inputs.find(i => i.type === 'password');
      return JSON.stringify({
        hasPath: !!p.querySelector('.gs-path'),
        inputs: inputs.length,
        pwdType: pwd ? pwd.type : null,
        pwdAutocomplete: pwd ? (pwd.getAttribute('autocomplete') || '') : null,
        buttons: texts,
        hasUrlPlaceholder: inputs.some(i => /github\\.com/i.test(i.placeholder || '')),
      });
    })()""")
    try:
        shape = json.loads(shape)
    except Exception:
        return False, f'面板结构读取失败：{str(shape)[:200]}'
    if not shape.get('hasPath'):
        return False, '面板未显示同步目录'
    if not shape.get('hasUrlPlaceholder'):
        return False, '仓库地址输入框缺失（或者说不出该填什么）'
    if shape.get('pwdType') != 'password':
        return False, f'令牌输入框不是 password（会明文显示）：{shape.get("pwdType")}'
    if not any('立即同步' in b for b in shape.get('buttons', [])):
        return False, f'缺少「立即同步」按钮：{shape.get("buttons")}'

    # ── c) 填地址 → 保存 → 真的调到主进程 + 有回音 ─────────────────────────
    cdp.eval("""(() => {
      const p = document.querySelector('.git-sync-panel');
      const input = Array.from(p.querySelectorAll('input')).find(i => /github\\.com/i.test(i.placeholder || ''));
      input.value = 'https://example.com/demo/world.git';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()""")
    time.sleep(0.2)
    cdp.eval("""(() => {
      const p = document.querySelector('.git-sync-panel');
      const b = Array.from(p.querySelectorAll('button')).find(x => (x.textContent || '').indexOf('保存并连接') >= 0);
      if (b) b.click();
      return 'ok';
    })()""")
    time.sleep(0.5)
    saved = cdp.eval("""(() => {
      const p = document.querySelector('.git-sync-panel');
      const calls = (window.__gitCalls || []).filter(c => c.op === 'configure');
      return JSON.stringify({
        calls: calls.length,
        lastUrl: calls.length ? calls[calls.length - 1].remoteUrl : '',
        hasDir: calls.length ? !!calls[calls.length - 1].dir : false,
        tip: (p.querySelector('.gs-tip-line') || {}).textContent || '',
      });
    })()""")
    try:
        saved = json.loads(saved)
    except Exception:
        return False, f'保存结果读取失败：{str(saved)[:200]}'
    if saved.get('calls', 0) < 1:
        return False, '点了「保存并连接」但主进程没收到调用（按钮是死的）'
    if saved.get('lastUrl') != 'https://example.com/demo/world.git':
        return False, f'传给主进程的地址不对：{saved.get("lastUrl")}'
    if not saved.get('hasDir'):
        return False, '保存时没有带上同步目录（主进程不知道同步哪个目录）'
    if '已保存' not in (saved.get('tip') or ''):
        return False, f'保存后没有可见回音：{saved.get("tip")!r}'

    # ── c2) 测试连接 → 真的调到主进程 + 回音（用户要的是"确定能用"，不是 push 时才知道） ──
    cdp.eval("""(() => {
      const p = document.querySelector('.git-sync-panel');
      const b = p.querySelector('[data-testid="test-connection"]');
      if (b) b.click();
      return 'ok';
    })()""")
    time.sleep(0.5)
    tested = cdp.eval("""(() => {
      const p = document.querySelector('.git-sync-panel');
      return JSON.stringify({
        calls: (window.__gitCalls || []).filter(c => c.op === 'test').length,
        tip: (p.querySelector('.gs-tip-line') || {}).textContent || '',
      });
    })()""")
    try:
        tested = json.loads(tested)
    except Exception:
        return False, f'测试连接结果读取失败：{str(tested)[:200]}'
    if tested.get('calls', 0) < 1:
        return False, '没有「测试连接」按钮，或点了没调到主进程'
    if not (tested.get('tip') or '').strip():
        return False, '测试连接没有可见回音'

    # ── c3) 令牌：保存后状态要变成「令牌已保存」（用户最恨"我明明填了却还说没登录"）──
    cdp.eval("""(() => {
      const p = document.querySelector('.git-sync-panel');
      const pwd = Array.from(p.querySelectorAll('input')).find(i => i.type === 'password');
      pwd.value = 'ghp_mock_token_should_never_be_echoed';
      pwd.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()""")
    time.sleep(0.2)
    cdp.eval("""(() => {
      const p = document.querySelector('.git-sync-panel');
      const b = Array.from(p.querySelectorAll('button')).find(x => (x.textContent || '').indexOf('保存令牌') >= 0);
      if (b) b.click();
      return 'ok';
    })()""")
    time.sleep(0.5)
    tok = cdp.eval("""(() => {
      const p = document.querySelector('.git-sync-panel');
      const pwd = Array.from(p.querySelectorAll('input')).find(i => i.type === 'password');
      const pill = p.querySelector('[data-testid="token-state"]');
      const calls = (window.__gitCalls || []).filter(c => c.op === 'credential');
      return JSON.stringify({
        calls: calls.length,
        sentToken: calls.length ? !!calls[calls.length - 1].hasToken : false,
        pill: pill ? (pill.textContent || '').trim() : '',
        inputCleared: pwd ? pwd.value === '' : false,
        tip: (p.querySelector('.gs-tip-line') || {}).textContent || '',
        panelEchoesToken: (p.textContent || '').indexOf('ghp_mock_token') >= 0,
      });
    })()""")
    try:
        tok = json.loads(tok)
    except Exception:
        return False, f'令牌状态读取失败：{str(tok)[:200]}'
    if tok.get('calls', 0) < 1:
        return False, '点了「保存令牌」但主进程没收到调用'
    if not tok.get('sentToken'):
        return False, '保存令牌时没有把令牌传给主进程'
    if not tok.get('inputCleared'):
        return False, '令牌保存后输入框没有清空（会在界面上继续显示）'
    if tok.get('panelEchoesToken'):
        return False, '面板把令牌内容回显到了界面上（必须永不回显）'
    if '令牌已保存' not in (tok.get('pill') or ''):
        return False, f'保存令牌后状态没有变（用户会以为没保存成功）：{tok.get("pill")!r} / {tok.get("tip")!r}'

    # ── d) 立即同步 → 真的调到主进程 ──────────────────────────────────────
    cdp.eval("""(() => {
      const p = document.querySelector('.git-sync-panel');
      const b = Array.from(p.querySelectorAll('button')).find(x => (x.textContent || '').indexOf('立即同步') >= 0);
      if (b) b.click();
      return 'ok';
    })()""")
    time.sleep(0.6)
    synced = cdp.eval("""(() => {
      const p = document.querySelector('.git-sync-panel');
      return JSON.stringify({
        calls: (window.__gitCalls || []).filter(c => c.op === 'sync').length,
        tip: (p.querySelector('.gs-tip-line') || {}).textContent || '',
      });
    })()""")
    try:
        synced = json.loads(synced)
    except Exception:
        return False, f'同步结果读取失败：{str(synced)[:200]}'
    if synced.get('calls', 0) < 1:
        return False, '点了「立即同步」但主进程没收到调用'
    if not (synced.get('tip') or '').strip():
        return False, '同步后没有可见回音'

    # ── d2) 从远程恢复（拉取）：警告文案 + 两步确认 + 恢复后必须重新载入项目 ──
    warn = cdp.eval("""(() => {
      const p = document.querySelector('.git-sync-panel');
      const sec = p.querySelector('.gs-danger-section');
      const btn = p.querySelector('[data-testid="pull-btn"]');
      return JSON.stringify({
        hasSection: !!sec,
        text: sec ? (sec.textContent || '') : '',
        hasBtn: !!btn,
      });
    })()""")
    try:
        warn = json.loads(warn)
    except Exception:
        return False, f'恢复区读取失败：{str(warn)[:200]}'
    if not warn.get('hasSection') or not warn.get('hasBtn'):
        return False, '缺少「从远程恢复」入口（用户要的恢复数据能力）'
    if '一致' not in (warn.get('text') or '') or '⚠' not in (warn.get('text') or ''):
        return False, f'恢复区缺少破坏性警告（用户明确要求"伴随相应警告"）：{warn.get("text")[:120]!r}'

    # 第一次点击 = 只探测（confirm=false），不得直接改数据
    cdp.eval("""(() => {
      const p = document.querySelector('.git-sync-panel');
      const b = p.querySelector('[data-testid="pull-btn"]');
      if (b) b.click();
      return 'ok';
    })()""")
    time.sleep(0.7)
    step1 = cdp.eval("""(() => {
      const p = document.querySelector('.git-sync-panel');
      const calls = (window.__gitCalls || []).filter(c => c.op === 'pull');
      const bar = p.querySelector('[data-testid="pull-confirm"]');
      return JSON.stringify({
        calls: calls.length,
        lastConfirm: calls.length ? calls[calls.length - 1].confirm : null,
        hasBar: !!bar,
        barText: bar ? (bar.textContent || '').trim() : '',
      });
    })()""")
    try:
        step1 = json.loads(step1)
    except Exception:
        return False, f'恢复第一步读取失败：{str(step1)[:200]}'
    if step1.get('calls', 0) < 1:
        return False, '点了「读取远程版本」但主进程没收到调用'
    if step1.get('lastConfirm') is not False:
        return False, f'第一步不该直接改数据（必须以 confirm=false 探测）：{step1.get("lastConfirm")}'
    if not step1.get('hasBar'):
        return False, '远程有新内容时没有出现二次确认条（会静默覆盖本地）'
    if '确认恢复' not in (step1.get('barText') or ''):
        return False, f'确认条里没有「确认恢复」按钮：{step1.get("barText")!r}'

    # 第二步：确认恢复 → confirm=true + 项目重新载入
    before_opens = cdp.eval("(() => (window.__projectCalls || []).filter(c => c.op === 'open').length)()")
    cdp.eval("""(() => {
      const p = document.querySelector('.git-sync-panel');
      const b = Array.from(p.querySelectorAll('[data-testid="pull-confirm"] button'))
        .find(x => (x.textContent || '').indexOf('确认恢复') >= 0);
      if (b) b.click();
      return 'ok';
    })()""")
    time.sleep(1.0)
    step2 = cdp.eval("""(() => {
      const p = document.querySelector('.git-sync-panel');
      const calls = (window.__gitCalls || []).filter(c => c.op === 'pull');
      const opens = (window.__projectCalls || []).filter(c => c.op === 'open').length;
      return JSON.stringify({
        calls: calls.length,
        lastConfirm: calls.length ? calls[calls.length - 1].confirm : null,
        opens: opens,
        tip: (p.querySelector('.gs-tip-line') || {}).textContent || '',
      });
    })()""")
    try:
        step2 = json.loads(step2)
    except Exception:
        return False, f'恢复第二步读取失败：{str(step2)[:200]}'
    if step2.get('lastConfirm') is not True:
        return False, f'确认后仍以 confirm={step2.get("lastConfirm")} 调用（不会真正恢复）'
    if step2.get('opens', 0) <= before_opens:
        return False, '恢复后没有重新打开项目 —— 画布上仍是旧数据，下一次自动保存会把旧数据写回去'
    if '恢复' not in (step2.get('tip') or ''):
        return False, f'恢复后没有可见回音：{step2.get("tip")!r}'

    # ── e) 无项目时：空态 + 去项目面板的去处 ──────────────────────────────
    closed = cdp.eval(f"""(async () => {{
      const app = {APP};
      const pinia = app.config.globalProperties.$pinia;
      const M = await import('/src/store/projectStore.js');
      const proj = M.useProjectStore(pinia);
      if (proj.isOpen) await proj.closeProject();
      return 'ok';
    }})()""")
    if closed != 'ok':
        return False, '前置失败：无法关闭基线项目'
    time.sleep(0.5)
    # 关闭再打开面板（面板读的是 projectStore 的当前状态）
    cdp.eval("""(() => {
      const b = Array.from(document.querySelectorAll('button'))
        .find(x => (x.getAttribute('title') || '').indexOf('远程仓库') >= 0);
      if (b) b.click();
      return 'ok';
    })()""")
    time.sleep(0.4)
    _open_panel(cdp)
    time.sleep(0.4)
    empty = cdp.eval("""(() => {
      const p = document.querySelector('.git-sync-panel');
      if (!p) return JSON.stringify({ panel: false });
      const b = Array.from(p.querySelectorAll('button')).find(x => (x.textContent || '').indexOf('去项目面板') >= 0);
      return JSON.stringify({
        panel: true,
        text: (p.querySelector('.gs-empty') || {}).textContent || '',
        hasGo: !!b,
      });
    })()""")
    try:
        empty = json.loads(empty)
    except Exception:
        return False, f'空态读取失败：{str(empty)[:200]}'
    if not empty.get('panel'):
        return False, '无项目时面板不存在（按钮点不开）'
    if not empty.get('hasGo'):
        return False, '无项目时没有给出「去项目面板」的去处'
    if '项目' not in (empty.get('text') or ''):
        return False, f'空态文案没说清怎么才有可同步目录：{empty.get("text")!r}'

    # 还原：重新打开基线项目，避免影响后续用例
    cdp.eval(f"""(async () => {{
      const app = {APP};
      const pinia = app.config.globalProperties.$pinia;
      const M = await import('/src/store/projectStore.js');
      const proj = M.useProjectStore(pinia);
      await proj.openProject('mock/projects/harness-baseline.sitian');
      return 'ok';
    }})()""")

    # ── f) 静态接线 ──────────────────────────────────────────────────────
    def _read(rel):
        with open(os.path.join(ROOT, rel), 'r', encoding='utf-8') as f:
            return f.read()

    static = []
    app_src = _read('src/renderer/src/App.vue')
    preload_src = _read('src/preload/index.js')
    handler_src = _read('src/main/handlers/gitSyncHandler.js')
    main_src = _read('src/main/index.js')
    if "components/GitSyncPanel.vue" not in app_src or 'defineAsyncComponent' not in app_src:
        static.append('App.vue 未把同步面板注册为懒加载组件')
    if 'git-sync-panel' not in app_src:
        static.append('App.vue 未挂载 git-sync-panel')
    if "panelsStore.toggle('git-sync')" not in app_src:
        static.append('App.vue 缺少同步面板入口按钮')
    for api in ('gitSyncStatus', 'gitSyncConfigure', 'gitSyncCredential', 'gitSyncForget', 'gitSyncTest', 'gitSyncNow', 'gitSyncPull'):
        if api not in preload_src:
            static.append(f'preload 未暴露 {api}')
    if 'registerGitSyncHandlers' not in main_src:
        static.append('main/index.js 未注册 gitSyncHandler')
    # 令牌保管：应用侧加密存储（不再只依赖系统凭据管理器）
    if 'createCredentialStore' not in main_src:
        static.append('main/index.js 未装配应用侧令牌保管（createCredentialStore）')
    if 'safeStorage' not in main_src:
        static.append('main/index.js 未用 safeStorage 加密令牌（会落明文）')
    handler_src_cred = _read('src/main/gitCredentialStore.js')
    if "require('electron')" in handler_src_cred:
        static.append('gitCredentialStore 顶层依赖 electron（Node 单测会跑不起来）')
    if 'SITIAN_GIT_TOKEN' not in handler_src:
        static.append('gitSyncHandler 未把令牌经环境变量喂给 git（推送会退回依赖系统凭据管理器）')
    lines = [l.strip() for l in handler_src.splitlines() if not l.strip().startswith('//')]
    if any(l.startswith("const { ") and "require('electron')" in l for l in lines):
        static.append('gitSyncHandler 顶层依赖 electron（Node 单测会跑不起来）')
    if 'GIT_TERMINAL_PROMPT' not in handler_src:
        static.append('git 调用未禁用交互提示（缺凭证时会挂死 UI）')

    if static:
        return False, '同步面板接线不完整：' + '；'.join(static)

    return True, ('同步面板可达性通过：工具栏入口→面板挂载（懒加载等待）、目录/地址/令牌(password)/立即同步 齐备、'
                  '保存与同步都真的调到主进程且都有可见回音、无项目时空态给出「去项目面板」去处；'
                  '静态接线（懒加载/挂载/入口/preload 四通道/handler 注册 + 无 electron 依赖 + 禁交互提示）齐备')
