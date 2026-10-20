"""用例 125：资料阅读器 + 全库搜索 + 节点绑定（D2）。

覆盖三条用户可感链路：
  · 任意笔记在司天内可读（含 ![[图]]）、[[双链]] 应用内跳、返回栈；
  · 全库正文搜索 → 点结果进阅读器；
  · 节点面板「关联资料」把另一篇笔记绑到节点上（notePaths，存项目字段）。
主进程的索引/正文搜索/附件 containment 在 unit/test_vault_index.js 里验。
"""
from lib.cdp import wait_for


READER = "[data-testid=\"note-reader\"]"
SEARCH = "[data-testid=\"note-search-panel\"]"
PICKER = "[data-testid=\"note-picker\"]"


def _open_note(cdp, path):
    return cdp.eval(
        "(() => { window.dispatchEvent(new CustomEvent('sitian:open-note', { detail: { path: %r } })); return 'ok'; })()"
        % path
    )


def _type(cdp, selector, text):
    return cdp.eval(
        "(() => { const el = document.querySelector(%r); if (!el) return 'no-input';"
        " el.value = %r; el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()"
        % (selector, text)
    )


def _click_text(cdp, root_selector, text):
    return cdp.eval(
        "(() => { const root = document.querySelector(%r); if (!root) return 'no-root';"
        " const b = Array.from(root.querySelectorAll('button')).find(x => (x.textContent || '').includes(%r));"
        " if (!b) return 'no-button'; b.click(); return 'ok'; })()"
        % (root_selector, text)
    )


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')

    # ---- 1) 阅读器：正文 + 附件 ----
    if _open_note(cdp, '03 设定/11 地理系统/行星/曜川星/霜寒城.md') != 'ok':
        return False, '派发 open-note 失败'
    wait_for(cdp, "!!document.querySelector('%s')" % READER, timeout=10, desc='阅读器打开')
    body = cdp.eval("document.querySelector('%s').innerText" % READER)
    if '测试正文' not in str(body):
        return False, f'正文未渲染：{str(body)[:160]}'
    has_img = cdp.eval("!!document.querySelector('%s img[src^=\"data:image/png\"]')" % READER)
    if not has_img:
        return False, '![[图.png]] 未变成 dataUrl 图片'

    # ---- 2) 双链应用内跳 + 返回栈 ----
    cdp.eval("document.querySelector('%s .note-wikilink').click()" % READER)
    wait_for(cdp, "document.querySelector('%s .nr-path').textContent.includes('北境')" % READER,
             timeout=10, desc='双链跳到北境')
    if cdp.eval("!document.querySelector('[data-testid=\"nr-back\"]')"):
        return False, '双链跳转后没有返回按钮'
    cdp.eval("document.querySelector('[data-testid=\"nr-back\"]').click()")
    wait_for(cdp, "document.querySelector('%s .nr-path').textContent.includes('霜寒城')" % READER,
             timeout=10, desc='返回栈回到霜寒城')
    cdp.eval("document.querySelector('[data-testid=\"nr-close\"]').click()")

    # ---- 3) 全库搜索 → 阅读器 ----
    cdp.eval("window.dispatchEvent(new CustomEvent('sitian:open-note-search'))")
    wait_for(cdp, "!!document.querySelector('%s')" % SEARCH, timeout=10, desc='搜索面板')
    if _type(cdp, '.ns-input', '艾琳') != 'ok':
        return False, '搜索输入框不存在'
    if _click_text(cdp, SEARCH, '搜索') != 'ok':
        return False, '搜索按钮不存在'
    wait_for(cdp, "document.querySelectorAll('[data-testid=\"ns-row\"]').length >= 1", timeout=10, desc='搜索结果')
    cdp.eval("document.querySelector('[data-testid=\"ns-row\"]').click()")
    wait_for(cdp, "!!document.querySelector('%s')" % READER, timeout=10, desc='结果进阅读器')
    if '艾琳' not in str(cdp.eval("document.querySelector('%s .nr-path').textContent" % READER)):
        return False, '搜索结果没有打开艾琳'
    cdp.eval("document.querySelector('[data-testid=\"nr-close\"]').click()")

    # ---- 4) 节点绑定附加笔记 ----
    sel = cdp.eval(
        "(() => { const st = document.querySelector('#app').__vue_app__._instance.setupState.store;"
        " const n = st.nodes.find(x => x.sourcePath); if (!n) return 'no-node';"
        " st.selectNode(n); return n.id; })()"
    )
    if not sel or sel == 'no-node':
        return False, '没有可选的带 sourcePath 节点'
    wait_for(cdp, "!!document.querySelector('[data-testid=\"linked-notes\"]')", timeout=10, desc='关联资料段')
    if _click_text(cdp, '[data-testid="linked-notes"]', '绑定笔记') != 'ok':
        return False, '绑定笔记按钮不存在'
    wait_for(cdp, "!!document.querySelector('%s')" % PICKER, timeout=10, desc='选择器')
    if _type(cdp, '.np-input', '艾琳') != 'ok':
        return False, '选择器输入框不存在'
    if _click_text(cdp, PICKER, '搜索') != 'ok':
        return False, '选择器搜索按钮不存在'
    wait_for(cdp, "document.querySelectorAll('.np-row:not(.disabled)').length >= 1", timeout=10, desc='选择器结果')
    cdp.eval("document.querySelector('.np-row:not(.disabled)').click()")
    wait_for(cdp,
             "(() => { const st = document.querySelector('#app').__vue_app__._instance.setupState.store;"
             " return !!(st.selectedNode && Array.isArray(st.selectedNode.notePaths) && st.selectedNode.notePaths.length); })()",
             timeout=10, desc='notePaths 写入')
    linked = cdp.eval("JSON.stringify(document.querySelector('#app').__vue_app__._instance.setupState.store.selectedNode.notePaths)")
    return True, f'阅读器/双链/返回/搜索/绑定均通；notePaths={linked}'
