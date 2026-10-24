#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 141：读料桥 · 设定卡「读不到笔记」的可读回落（2026-10-24）

读料桥（第 5 件）的判据之一是「**换库不崩**」：库被切换 / 笔记被改名或删除时，
节点上的 `sourcePath` 会指向一个不存在的文件。此前这里只是 `note = null` →
正文区**静默消失**（用户以为"内容没了"，且不知道去哪儿找）。

本用例守三件事：
1. 正常态：选中一个有词条的节点 → 面板里真的有设定卡内容（frontmatter / 正文）
2. 坏链路：把 sourcePath 改成一个不存在的路径 → 出现可读回落（路径 + 原因 + 两个出口），
   **不抛异常**；点「全库搜索」→ 搜索面板打开且**带上了节点名**
3. 复原：把 sourcePath 改回去 → 回落消失、内容回来（不残留、不静默）

另加源码守卫：`loadNote` 只许调 `readObsidianNote`（读料层只读），回落块里不许出现任何写 IPC。
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
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
PANEL = 'src/renderer/src/components/NodeDetailPanel.vue'
SEARCH = 'src/renderer/src/components/NoteSearchPanel.vue'
READER = 'src/renderer/src/utils/noteReader.js'


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


PICK = r"""(() => {
  const s = STORE;
  const n = (s.nodes || []).find(x => x && x.sourcePath && !x.draft);
  if (!n) return JSON.stringify({ err: 'no-note-node' });
  s.selectedNode = n;
  return JSON.stringify({ id: n.id, name: n.name, path: n.sourcePath });
})()""".replace('STORE', STORE)

CARD = r"""(() => {
  const s = STORE;
  const panel = document.querySelector('.detail-panel');
  const n = s.selectedNode;
  const fmRows = panel ? panel.querySelectorAll('.fm-row').length : 0;
  const body = panel ? panel.querySelector('.content-body') : null;
  return JSON.stringify({
    panel: !!panel,
    fmRows,
    bodyLen: body ? (body.textContent || '').trim().length : 0,
    missing: !!panel.querySelector('[data-testid="lore-missing"]'),
    missingText: panel.querySelector('[data-testid="lore-missing"]')
      ? (panel.querySelector('[data-testid="lore-missing"]').textContent || '').replace(/\s+/g, ' ').trim() : '',
    reason: panel.querySelector('[data-testid="lore-missing-reason"]')
      ? panel.querySelector('[data-testid="lore-missing-reason"]').textContent.trim() : '',
    hasRetry: !!panel.querySelector('[data-testid="lore-retry"]'),
    hasSearch: !!panel.querySelector('[data-testid="lore-search"]'),
    nodeName: n ? n.name : '',
    pathNow: n ? (n.sourcePath || '') : '',
    panels: document.querySelectorAll('.detail-panel').length,
  });
})()""".replace('STORE', STORE)

BREAK = r"""(() => {
  const s = STORE;
  const n = s.selectedNode;
  if (!n) return JSON.stringify({ err: 'no-selected' });
  s.updateNode(n.id, { sourcePath: '99 不存在的目录/不存在的词条.md' });
  // ⚠️ harness 把 `readObsidianNote` mock 成"永远成功"（canned 笔记）。
  //    换库/改名的真实后果是主进程**读失败**，所以这里要按真边界模拟一次失败，
  //    否则测的就只是 mock 的成功路径（等于没测）。
  if (!window.__origReadNote) window.__origReadNote = window.sitianAPI.readObsidianNote;
  window.sitianAPI.readObsidianNote = async () => ({ success: false, error: 'ENOENT: 笔记不在这个库里' });
  // 面板吃的是 `selectedNode` 这个对象；重新选一次让它重新读（真实场景里是换库后重新装载）
  s.selectedNode = (s.nodes || []).find((x) => x && x.id === n.id) || s.selectedNode;
  return JSON.stringify({ id: n.id, nowPath: s.selectedNode.sourcePath });
})()""".replace('STORE', STORE)

RESTORE = r"""(() => {
  const s = STORE;
  const n = s.selectedNode;
  if (!n) return JSON.stringify({ err: 'no-selected' });
  if (window.__origReadNote) {
    window.sitianAPI.readObsidianNote = window.__origReadNote;
    window.__origReadNote = null;
  }
  s.updateNode(n.id, { sourcePath: ORIGINAL });
  s.selectedNode = (s.nodes || []).find((x) => x && x.id === n.id) || s.selectedNode;
  return JSON.stringify({ ok: true, nowPath: s.selectedNode.sourcePath });
})()""".replace('STORE', STORE)

OPEN_SEARCH = r"""(() => {
  const b = document.querySelector('[data-testid="lore-search"]');
  if (!b) return JSON.stringify({ err: 'no-search-btn' });
  b.click();
  return 'ok';
})()"""

SEARCH_STATE = r"""(() => {
  const p = document.querySelector('[data-testid="note-search-panel"]');
  if (!p) return JSON.stringify({ open: false });
  const input = p.querySelector('.ns-input');
  return JSON.stringify({ open: true, query: input ? input.value : '', rows: p.querySelectorAll('[data-testid="ns-row"]').length });
})()"""

CLOSE_SEARCH = r"""(() => {
  const b = document.querySelector('[data-testid="note-search-panel"] .ns-close');
  if (b) b.click();
  return 'ok';
})()"""


def sub_source_guards():
    bad = []
    code = _code_only(_read(PANEL))
    start = code.find('async function loadNote')
    end = code.find('function searchVaultByName')
    seg = code[start:end] if start >= 0 else ''
    if not seg:
        bad.append('找不到 loadNote（设定卡的读取口）')
    else:
        if 'readObsidianNote' not in seg:
            bad.append('loadNote 没走 readObsidianNote')
        for banned in ('createObsidianNote', 'writeFile', 'saveProject', 'setSitianConfig', 'execute('):
            if banned in seg:
                bad.append(f'设定卡读取里出现了写操作 {banned}（读料层必须只读）')
    if 'data-testid="lore-missing"' not in code:
        bad.append('没有"读不到笔记"的可读回落块')
    if 'openNoteSearch' not in code:
        bad.append('回落块没有"全库搜索"出口')
    search = _code_only(_read(SEARCH))
    if 'detail.query' not in search and 'initialQuery' not in search:
        bad.append('搜索面板不接预填关键词（"全库搜这个名字"会退化成空搜）')
    reader = _read(READER)
    if 'openNoteSearch(query' not in reader:
        bad.append('openNoteSearch 不接受关键词参数')
    if bad:
        return False, '源码守卫失败：' + '；'.join(bad)
    return True, '设定卡读取只走 readObsidianNote；读不到时有可读回落 + 全库搜索（带名字预填）'


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    ensure_data_ready(cdp)
    time.sleep(0.3)

    pick = _j(cdp, PICK)
    if pick.get('err'):
        return False, f'数据里找不到带词条的节点：{pick}'
    time.sleep(0.9)
    card = _j(cdp, CARD)
    if not card.get('panel'):
        return False, '详情面板没打开'
    if not (card.get('fmRows', 0) > 0 or card.get('bodyLen', 0) > 0):
        return False, f'正常态就没有设定卡内容（frontmatter {card.get("fmRows")} 行 / 正文 {card.get("bodyLen")} 字）'
    if card.get('missing'):
        return False, '正常态居然显示了"读不到笔记"回落'

    # ② 坏链路：把 sourcePath 指到一个不存在的文件（模拟换库 / 改名 / 删除）
    _j(cdp, BREAK)
    time.sleep(0.9)
    broken = _j(cdp, CARD)
    fails = []
    if not broken.get('missing'):
        fails.append(f'笔记读不到时没有可读回落（卡片={broken}）')
    if '99 不存在的目录/不存在的词条.md' not in (broken.get('missingText') or ''):
        fails.append(f'回落里没有点名来源路径：{broken.get("missingText")}')
    if not broken.get('hasRetry') or not broken.get('hasSearch'):
        fails.append('回落缺少出口（重试 / 全库搜索）')
    if broken.get('bodyLen', 0) > 0 or broken.get('fmRows', 0) > 0:
        fails.append('坏链路下仍显示着旧内容（会让人以为是新库里的内容）')

    # ③ 点「全库搜索」→ 搜索面板打开 + 带上节点名
    if _j(cdp, OPEN_SEARCH) == 'ok':
        time.sleep(0.8)
        st = _j(cdp, SEARCH_STATE)
        if not st.get('open'):
            fails.append('点「全库搜索」没打开搜索面板')
        elif st.get('query') != broken.get('nodeName'):
            fails.append(f'搜索面板没预填节点名（{st.get("query")!r} ≠ {broken.get("nodeName")!r}）')
        _j(cdp, CLOSE_SEARCH)
        time.sleep(0.3)

    # ④ 复原 sourcePath → 回落消失、内容回来
    _j(cdp, RESTORE.replace('ORIGINAL', json.dumps(pick.get('path'))))
    time.sleep(0.9)
    fixed = _j(cdp, CARD)
    if fixed.get('missing'):
        fails.append('sourcePath 复原后回落块还在（状态没跟着节点变）')
    if not (fixed.get('fmRows', 0) > 0 or fixed.get('bodyLen', 0) > 0):
        fails.append('sourcePath 复原后内容没回来')

    sg_ok, sg_detail = sub_source_guards()
    if not sg_ok:
        fails.append(sg_detail)

    detail = (f'正常态：frontmatter {card.get("fmRows")} 行 / 正文 {card.get("bodyLen")} 字；'
              f'坏链路：回落点名路径 + 出口齐全（重试/搜索）、旧内容不再显示；'
              f'「全库搜索」带节点名「{broken.get("nodeName")}」预填；复原后内容回来；源码守卫：{sg_detail}')
    if fails:
        return False, '；'.join(fails)[:900]
    return True, detail
