#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 182：**删除项目**（默认进回收站）—— 2026-11-24 用户拍板的功能

用户原话：“‘删除项目’这个功能必须要有，默认移到回收站，否则整个软件都不完整。”

这条用例守"**用户点得到、点完真的没了、而且能还原**"，全部走产品自己的 DOM 入口：

  a) 项目列表面板里每条项目都有「删除」按钮（可见文字，不是纯图标）；
  b) 点它 → 出现确认条，且**点一下不会直接删**（两段式，防误触）；
  c) 确认条里说清了"文件和备份目录会一起进回收站"+"只删项目文件，保留备份历史"选项；
  d) 点「取消」→ 什么都没发生（文件还在、列表还在）；
  e) 点「移到回收站」→ 该条从列表消失；
  f) **删的若是当前打开的项目** → 项目被关闭（不关闭的话下一次自动保存会把文件写回来，
     用户看到的就是"删不掉"）；
  g) 全程零错误面板。

⚠️ 本用例的 `window.sitianAPI` 是 **mock**（渲染层用例一律如此），所以它验的是
   **UI 与 store 的接线**；「真的把文件移进回收站」由主进程侧的真实落盘单测
   `test_project_delete.js` 守（注入 trashItem + 真实临时目录）。
   两层分工是刻意的：CDP 那层看不见文件系统，Node 那层看不见 DOM。
"""
import json
import sys
import os
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for  # noqa: E402

APP = "document.querySelector('#app').__vue_app__"
PANEL = "document.querySelector('.project-panel')"
# 🔴 取 store 一律走 pinia（`PanelShell` 包了一层，`__vueParentComponent.setupState`
#    在不同构建形态下不可靠：dev 能读到、打包件不一定）。store id = 'project'。
PROJ = "document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('project')"


def _j(v):
    if isinstance(v, str) and v[:1] in '{[':
        try:
            return json.loads(v)
        except Exception:
            return {}
    return v if isinstance(v, dict) else {}


def _panel(cdp):
    """打开项目面板（幂等）并等它挂载。"""
    cdp.eval(f"""(() => {{
      if (document.querySelector('.project-panel')) return 'already';
      const btns = Array.from(document.querySelectorAll('button'));
      const b = btns.find(x => (x.title || '').includes('项目') || (x.textContent || '').includes('项目'));
      if (b) b.click();
      return 'clicked';
    }})()""")
    time.sleep(0.6)
    for _ in range(20):
        if cdp.eval("!!document.querySelector('.project-panel')"):
            return True
        time.sleep(0.2)
    return False


def _error_panel(cdp):
    raw = cdp.eval("""(() => {
      const el = document.getElementById('sitian-error-overlay');
      if (!el) return '';
      const pre = el.querySelector('[data-role=detail]');
      return (pre && pre.textContent ? pre.textContent : '(无详情)').slice(0, 500);
    })()""")
    return raw if isinstance(raw, str) else ''


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')

    if not _panel(cdp):
        return False, '打不开项目面板'

    # ── a) 列表里每条都有「删除」按钮，且是**可见文字**（不是纯图标） ──────────
    listed = _j(cdp.eval(f"""(() => {{
      const items = Array.from(document.querySelectorAll('.project-panel .pp-item'));
      const rows = items.map(it => {{
        const b = it.querySelector('.pp-item-del');
        return {{
          hasBtn: !!b,
          text: b ? (b.textContent || '').trim() : '',
          testid: b ? b.getAttribute('data-testid') : '',
          title: b ? (b.title || '') : '',
        }};
      }});
      return JSON.stringify({{ count: items.length, rows: rows }});
    }})()"""))
    if not isinstance(listed, dict) or listed.get('count', 0) == 0:
        return False, f'项目列表为空，无法验证删除入口（{listed}）'
    rows = listed.get('rows') or []
    missing = [r for r in rows if not r.get('hasBtn')]
    if missing:
        return False, f'{len(missing)} 条项目没有删除按钮'
    iconic = [r for r in rows if not r.get('text')]
    if iconic:
        return False, f'删除按钮是纯图标（没有可见文字）：{iconic[:2]}'
    if not all(r.get('title') for r in rows):
        return False, '删除按钮缺 title（说不清会删什么）'

    panel0 = _error_panel(cdp)
    if panel0:
        return False, f'打开面板就弹了错误面板：{panel0}'

    # ── d 的前置：记住当前列表（用于"取消后没变化"）─────────────────────────
    before = _j(cdp.eval(f"""(() => {{
      const items = Array.from(document.querySelectorAll('.project-panel .pp-item'));
      return JSON.stringify({{
        files: items.map(it => it.getAttribute('title') || ''),
        current: ({PROJ}).filePath || '',
      }});
    }})()"""))

    # ── b/c) 点删除 → 只出确认条，不直接删 ────────────────────────────────────
    clicked = _j(cdp.eval("""(() => {
      const b = document.querySelector('.project-panel .pp-item-del');
      if (!b) return JSON.stringify({ ok: false, why: 'no-btn' });
      const rowBefore = document.querySelectorAll('.project-panel .pp-item').length;
      b.click();
      return JSON.stringify({ ok: true, rowBefore });
    })()"""))
    if not clicked.get('ok'):
        return False, f'点不到删除按钮（{clicked}）'
    time.sleep(0.5)

    confirm = _j(cdp.eval(f"""(() => {{
      const box = document.querySelector('[data-testid=pp-delete-confirm]');
      if (!box) return JSON.stringify({{ shown: false }});
      const keep = document.querySelector('[data-testid=pp-delete-keep-backups]');
      const okBtn = document.querySelector('[data-testid=pp-delete-confirm-btn]');
      const cancel = Array.from(box.querySelectorAll('button')).find(x => (x.textContent || '').includes('取消'));
      const rowsNow = document.querySelectorAll('.project-panel .pp-item').length;
      return JSON.stringify({{
        shown: true,
        text: (box.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
        hasKeepOpt: !!keep,
        hasOkBtn: !!okBtn,
        okText: okBtn ? (okBtn.textContent || '').trim() : '',
        hasCancel: !!cancel,
        rowsNow: rowsNow,
      }});
    }})()"""))
    if not confirm.get('shown'):
        return False, '点了删除却没有确认条（直接删了？两段式确认没了）'
    if confirm.get('rowsNow') != clicked.get('rowBefore'):
        return False, f'还没确认，列表就少了一条（{clicked.get("rowBefore")} → {confirm.get("rowsNow")}）'
    if not (confirm.get('hasKeepOpt') and confirm.get('hasOkBtn') and confirm.get('hasCancel')):
        return False, f'确认条缺要素（保留备份选项/确认/取消）：{confirm}'
    if '回收站' not in (confirm.get('text') or ''):
        return False, f'确认条没说清"移到回收站"（用户不知道能不能还原）：{confirm.get("text")}'
    if '备份' not in (confirm.get('text') or ''):
        return False, f'确认条没说备份目录会怎么处理：{confirm.get("text")}'

    # ── c2) **必须输入项目全名才能删**（2026-11-24 用户要求，照同系列产品的做法）──
    #       判据三层：① 输入框在；② 没输入/输错时按钮是禁用的；③ 输对了才可用。
    typed_gate = _j(cdp.eval("""(() => {
      const box = document.querySelector('[data-testid=pp-delete-confirm]');
      const btn = document.querySelector('[data-testid=pp-delete-confirm-btn]');
      const inp = document.querySelector('[data-testid=pp-delete-typed-name]');
      if (!box || !btn || !inp) {
        return JSON.stringify({ ok: false, hasBox: !!box, hasBtn: !!btn, hasInput: !!inp });
      }
      const idleDisabled = btn.disabled;
      inp.value = '不匹配的名字xyz';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return JSON.stringify({
        ok: true,
        idleDisabled: idleDisabled,
        wrongDisabled: btn.disabled,
        placeholder: inp.placeholder || '',
      });
    })()"""))
    if not typed_gate.get('ok'):
        return False, f'确认条里没有"输入项目全名"这一道（{typed_gate}）'
    if not typed_gate.get('idleDisabled'):
        return False, '还没输入项目名，删除按钮却是可点的（这一道形同虚设）'
    if not typed_gate.get('wrongDisabled'):
        return False, '输入了错误的名字，删除按钮仍然可点（判据没生效）'

    # 输入正确的全名 → 按钮可用（用 placeholder，它就是项目名）
    cdp.eval("""(() => {
      const inp = document.querySelector('[data-testid=pp-delete-typed-name]');
      if (!inp) return 'no-input';
      inp.value = inp.placeholder || '';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()""")
    time.sleep(0.35)
    after_type = _j(cdp.eval("""(() => {
      const btn = document.querySelector('[data-testid=pp-delete-confirm-btn]');
      return JSON.stringify({ disabled: btn ? btn.disabled : null });
    })()"""))
    if after_type.get('disabled') is not False:
        return False, (f'输入了正确的项目名，删除按钮仍不可点'
                       f'（姓名判据：{typed_gate} / 输入后：{after_type}）')

    # ── d) 取消 → 什么都没发生 ────────────────────────────────────────────────
    cdp.eval("""(() => {
      const box = document.querySelector('[data-testid=pp-delete-confirm]');
      const cancel = box && Array.from(box.querySelectorAll('button')).find(x => (x.textContent || '').includes('取消'));
      if (cancel) cancel.click();
      return 'ok';
    })()""")
    time.sleep(0.4)
    afterCancel = _j(cdp.eval(f"""(() => {{
      const box = document.querySelector('[data-testid=pp-delete-confirm]');
      const items = Array.from(document.querySelectorAll('.project-panel .pp-item'));
      return JSON.stringify({{
        confirmGone: !box,
        files: items.map(it => it.getAttribute('title') || ''),
      }});
    }})()"""))
    if not afterCancel.get('confirmGone'):
        return False, '点取消后确认条还在'
    if afterCancel.get('files') != (before.get('files') or []):
        return False, '点取消后列表变了（取消不该有任何副作用）'

    # ── e/f) 确认删除 → 该条消失 ─────────────────────────────────────────────
    #        优先挑**当前打开的那个**项目删（这样能顺带验 f：删当前项目会先关掉它）
    target = _j(cdp.eval(f"""(() => {{
      const cur = ({PROJ}).filePath || '';
      const items = Array.from(document.querySelectorAll('.project-panel .pp-item'));
      const row = items.find(it => (it.getAttribute('title') || '') === cur) || items[0];
      const targetPath = row ? (row.getAttribute('title') || '') : '';
      const wasCurrent = !!(cur && targetPath === cur);
      const b = row && row.querySelector('.pp-item-del');
      if (b) b.click();
      return JSON.stringify({{ targetPath: targetPath, wasCurrent: wasCurrent, cur: cur }});
    }})()"""))
    if not target.get('targetPath'):
        return False, f'挑不到要删的那一条（{target}）'
    time.sleep(0.5)
    # 第二次点开确认条后，同样必须先输入全名才允许删（这一道不是只挡第一次）
    cdp.eval("""(() => {
      const inp = document.querySelector('[data-testid=pp-delete-typed-name]');
      if (!inp) return 'no-input';
      inp.value = inp.placeholder || '';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()""")
    time.sleep(0.35)
    cdp.eval("""(() => {
      const b = document.querySelector('[data-testid=pp-delete-confirm-btn]');
      if (b && !b.disabled) b.click();
      return 'ok';
    })()""")
    time.sleep(1.2)

    after = _j(cdp.eval(f"""(() => {{
      const proj = ({PROJ});
      const items = Array.from(document.querySelectorAll('.project-panel .pp-item'));
      return JSON.stringify({{
        files: items.map(it => it.getAttribute('title') || ''),
        isOpen: !!proj.isOpen,
        filePath: proj.filePath || '',
        tip: (document.querySelector('.project-panel .pp-tip, .project-panel [data-role=tip]') || {{}}).textContent || '',
      }});
    }})()"""))
    files_after = after.get('files') or []
    if target.get('targetPath') in files_after:
        return False, f'确认删除后那条还在列表里：{target.get("targetPath")}'
    if target.get('wasCurrent') and after.get('isOpen'):
        return False, ('删的是当前打开的项目，但它还开着 —— 下一次自动保存会把文件写回来，'
                       f'用户看到的就是"删不掉"（isOpen={after.get("isOpen")}, filePath={after.get("filePath")}）')

    # ── f2) **撤回**：删完必须能在应用里一键找回（2026-11-24 用户要求）──────
    #        「还原没做，因为司天内根本没还原按钮。你难道指望用户去回收站自己找？」
    restore_ui = _j(cdp.eval(f"""(() => {{
      const proj = ({PROJ});
      const bar = document.querySelector('[data-testid=pp-restore-deleted]');
      const btn = document.querySelector('[data-testid=pp-restore-deleted-btn]');
      const list = document.querySelectorAll('[data-testid^=pp-restore-]');
      return JSON.stringify({{
        hasBar: !!bar,
        hasBtn: !!btn,
        btnText: btn ? (btn.textContent || '').trim() : '',
        lastDeleted: proj.lastDeleted ? proj.lastDeleted.filePath : null,
        restoreControls: list.length,
      }});
    }})()"""))
    if not (restore_ui.get('hasBar') and restore_ui.get('hasBtn')):
        return False, f'删完没有可点的"撤回"入口（{restore_ui}）—— 用户只能自己去回收站翻'
    if not restore_ui.get('lastDeleted'):
        return False, f'删除后 store 没记下 lastDeleted（撤回不知道找哪个，{restore_ui}）'

    restored = _j(cdp.eval("""(() => {
      const b = document.querySelector('[data-testid=pp-restore-deleted-btn]');
      if (!b) return JSON.stringify({ clicked: false });
      b.click();
      return JSON.stringify({ clicked: true, disabled: b.disabled });
    })()"""))
    if not restored.get('clicked'):
        return False, '点不到撤回按钮'
    time.sleep(1.5)
    after_restore = _j(cdp.eval(f"""(() => {{
      const proj = ({PROJ});
      const items = Array.from(document.querySelectorAll('.project-panel .pp-item'));
      return JSON.stringify({{
        files: items.map(it => it.getAttribute('title') || ''),
        lastDeleted: proj.lastDeleted ? proj.lastDeleted.filePath : null,
        barGone: !document.querySelector('[data-testid=pp-restore-deleted]'),
      }});
    }})()"""))
    if target.get('targetPath') not in (after_restore.get('files') or []):
        return False, (f'点了撤回，但那条没回到项目列表（{after_restore}）；'
                       '用户会以为撤回失败')
    if not after_restore.get('barGone'):
        return False, '撤回成功了，但"撤回"提示条还挂着（会误导用户再点一次）'

    # ── g) 全程零错误面板 ────────────────────────────────────────────────────
    panel = _error_panel(cdp)
    if panel:
        return False, f'删除过程中弹了错误面板：{panel}'

    return True, (f'删除入口齐备（{listed["count"]} 条都有带文字的「删除」）→ '
                  f'确认条要求**输入项目全名**（错名字按钮禁用）→ 取消无副作用 → '
                  f'确认后该条消失 → **撤回把它找回来**'
                  + ('，且当前项目被正确关闭（不会"删了又回来"）' if target.get('wasCurrent') else '')
                  + '；全程零错误面板。⚠️ 真实搬进/搬出回收站由 test_project_delete.js 守（本层是 mock API）')
