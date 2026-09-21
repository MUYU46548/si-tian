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
    for api in ('gitSyncStatus', 'gitSyncConfigure', 'gitSyncCredential', 'gitSyncNow'):
        if api not in preload_src:
            static.append(f'preload 未暴露 {api}')
    if 'registerGitSyncHandlers' not in main_src:
        static.append('main/index.js 未注册 gitSyncHandler')
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
