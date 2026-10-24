#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 142：设置面板「新笔记目录」（2026-10-24，用户拍板：能用约定目录才用、否则库根）

为什么守它：落点规则（`src/main/noteTarget.js`）有单测，但**用户改不到**就等于没有 ——
这条用例只守"用户能在界面上把自己的目录写进去、能读回来、能清空回自动"，以及
"这个值真的会传到主进程的落点入口"（harness 的 mock 把 `setSitianConfig` 记在 `window.__uiConfig`）。

验收点：
1. 设置面板有「新笔记目录」段（输入框 + 保存按钮 + 说明"留空 = 自动"）
2. 填 `99 我的沙盒` → 保存 → mock 收到 `noteTarget.dir`，界面给出"已保存"
3. 重新打开设置面板 → 输入框回显上次保存的值（不是只在内存里）
4. 清空 → 保存 → `dir === ''`（= 回到自动规则），界面文案说明"留空 = 自动"
5. 源码守卫：落点规则只有一份实现（`noteTarget.js`），设置只写配置、**不自己拼路径**
   （否则"设置改了、落点没改"这类双源漂移会静默发生）
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for  # noqa: E402
from lib.helpers import ensure_data_ready  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SETTINGS = 'src/renderer/src/components/SettingsPanel.vue'
MAIN = 'src/main/index.js'
NOTE_TARGET = 'src/main/noteTarget.js'


def _read(rel):
    import io
    return io.open(os.path.join(ROOT, rel), encoding='utf-8').read()


def _code_only(src):
    src = re.sub(r'<!--.*?-->', '', src, flags=re.S)
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    return re.sub(r'(?m)//[^\n]*', '', src)


def _j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, dict):
        raise RuntimeError('eval 异常：%s' % v)
    if isinstance(v, str) and v.startswith(('{', '[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


OPEN_SETTINGS = "(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.title === '设置'); if (!b) return 'no-btn'; b.click(); return 'ok'; })()"
CLOSE_SETTINGS = "(() => { const b = document.querySelector('.settings-overlay .settings-close, .settings-overlay .close-btn'); if (b) { b.click(); return 'ok'; } document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 'esc'; })()"

FILL = r"""(() => {
  const inp = document.querySelector('[data-testid="note-target-dir"]');
  if (!inp) return JSON.stringify({ err: 'no-input' });
  inp.value = VALUE;
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  const btn = document.querySelector('[data-testid="save-note-target"]');
  if (!btn) return JSON.stringify({ err: 'no-save' });
  btn.click();
  return 'ok';
})()"""

STATE = r"""(() => {
  const inp = document.querySelector('[data-testid="note-target-dir"]');
  const status = document.querySelector('[data-testid="note-target-status"]');
  const cfg = (window.__uiConfig || {}).noteTarget || null;
  return JSON.stringify({
    input: inp ? inp.value : null,
    status: status ? (status.textContent || '').trim() : '',
    cfg: cfg ? cfg.dir : null,
    hasSection: !!document.querySelector('[data-testid="note-target-section"]'),
    hasSave: !!document.querySelector('[data-testid="save-note-target"]'),
  });
})()"""


def sub_source_guards():
    bad = []
    settings = _code_only(_read(SETTINGS))
    if 'data-testid="note-target-dir"' not in settings or 'data-testid="save-note-target"' not in settings:
        bad.append('设置面板缺「新笔记目录」输入/保存')
    if "setSitianConfig('noteTarget'" not in settings:
        bad.append('设置面板没把目录写进 noteTarget 配置')
    # 🔴 设置面板不许自己拼落点（那会变成第二份规则）。
    #    说明文案里出现「03 设定」是允许的（那是给用户看的）；要抓的是**拼路径**。
    for banned in ("path.join(", "from 'path'", '02 场景地点', '11 地理系统'):
        if banned in settings:
            bad.append(f'设置面板里出现了落点规则片段 {banned}（应是唯一实现在 noteTarget.js）')
    src = _read(MAIN)
    start = src.find("ipcMain.handle('create-obsidian-note'")
    end = src.find('ipcMain.handle(', start + 10)
    seg = src[start:end if end > 0 else len(src)]
    if 'resolveNoteTarget(' not in seg:
        bad.append('create 段没用 resolveNoteTarget')
    if "sitianConfigPath('noteTarget')" not in seg:
        bad.append('create 段没读用户的「新笔记目录」设置')
    if 'target.reason' not in seg:
        bad.append('越界目录被拒时没把原因回给界面（会静默落根）')
    if not os.path.exists(os.path.join(ROOT, NOTE_TARGET)):
        bad.append('落点唯一实现 noteTarget.js 不见了')
    if bad:
        return False, '源码守卫失败：' + '；'.join(bad)
    return True, '设置只写配置；落点规则只有 noteTarget.js 一份；越界会带原因拒绝'


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    ensure_data_ready(cdp)
    time.sleep(0.4)

    if cdp.eval(OPEN_SETTINGS) != 'ok':
        return False, '设置按钮没找到'
    wait_for(cdp, "!!document.querySelector('.settings-overlay')", timeout=8, desc='设置面板')
    time.sleep(0.5)

    st0 = _j(cdp, STATE)
    fails = []
    if not st0.get('hasSection') or not st0.get('hasSave'):
        fails.append(f'设置面板没有「新笔记目录」段：{st0}')

    # ② 填 → 保存
    fill = _j(cdp, FILL.replace('VALUE', json.dumps('99 我的沙盒')))
    if fill != 'ok':
        return False, f'填/保存失败：{fill}'
    time.sleep(0.5)
    st1 = _j(cdp, STATE)
    if st1.get('cfg') != '99 我的沙盒':
        fails.append(f'保存没写进配置（cfg={st1.get("cfg")!r}）')
    if '已保存' not in (st1.get('status') or ''):
        fails.append(f'保存后没有可读回执（status={st1.get("status")!r}）')

    # ③ 关掉再打开 → 回显
    _j(cdp, CLOSE_SETTINGS)
    time.sleep(0.4)
    if cdp.eval(OPEN_SETTINGS) != 'ok':
        fails.append('再次打开设置失败')
    time.sleep(0.6)
    st2 = _j(cdp, STATE)
    if st2.get('input') != '99 我的沙盒':
        fails.append(f'重开设置面板没回显保存过的目录（{st2.get("input")!r}）')

    # ④ 清空 → 保存（= 回到自动规则）
    fill2 = _j(cdp, FILL.replace('VALUE', json.dumps('')))
    if fill2 != 'ok':
        fails.append(f'清空保存失败：{fill2}')
    time.sleep(0.5)
    st3 = _j(cdp, STATE)
    if st3.get('cfg') != '':
        fails.append(f'清空后配置不是空串（{st3.get("cfg")!r}）')
    if '自动' not in (st3.get('status') or ''):
        fails.append(f'清空后的回执没说清"留空 = 自动"（{st3.get("status")!r}）')

    _j(cdp, CLOSE_SETTINGS)
    time.sleep(0.3)

    sg_ok, sg_detail = sub_source_guards()
    if not sg_ok:
        fails.append(sg_detail)

    detail = (f'设置段在位；保存 → cfg={st1.get("cfg")!r}、回执「{st1.get("status")}」；'
              f'重开回显 {st2.get("input")!r}；清空 → cfg={st3.get("cfg")!r}、回执「{st3.get("status")}」；'
              f'源码守卫：{sg_detail}')
    if fails:
        return False, '；'.join(fails)[:900]
    return True, detail
