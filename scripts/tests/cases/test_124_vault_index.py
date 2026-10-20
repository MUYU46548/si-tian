"""用例 124：全库只读索引（D1）—— 设置面板入口 / 重建 / 候选列表接线。

只测渲染层接线；主进程真实扫描与 containment 在 `scripts/tests/unit/test_vault_index.js`。
网格数据来自 mock（run_tests.py 的 MOCK_SCRIPT），这里守：
  · 设置面板有「资料索引」段（不是只有主进程 API、用户看不见）；
  · 「重建索引」真的调用 `vaultIndexBuild`（不是按钮摆着）；
  · 候选列表能读出来、显示层级/标题（不是空壳）。
"""
from lib.cdp import wait_for


SECTION = "!!document.querySelector('[data-testid=\"vault-index-section\"]')"


def _click(cdp, text):
    return cdp.eval(
        "(() => { const sec = document.querySelector('[data-testid=\"vault-index-section\"]');"
        " if (!sec) return 'no-section';"
        " const b = Array.from(sec.querySelectorAll('button')).find(x => (x.textContent || '').includes(%r));"
        " if (!b) return 'no-button'; b.click(); return 'ok'; })()" % text
    )


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    cdp.eval("Array.from(document.querySelectorAll('.toolbar-actions button')).find(b => b.title === '设置').click()")
    wait_for(cdp, "!!document.querySelector('.settings-panel')", timeout=10, desc='设置面板')
    wait_for(cdp, SECTION, timeout=10, desc='资料索引段')

    text = cdp.eval("document.querySelector('[data-testid=\"vault-index-section\"]').innerText")
    if '120 篇' not in text:
        return False, f'索引状态未显示 120 篇：{str(text)[:200]}'

    if _click(cdp, '重建索引') != 'ok':
        return False, '找不到「重建索引」按钮'
    wait_for(cdp, "window.__viBuildCalls >= 1", timeout=10, desc='重建索引调用')
    # 重建成功后组件会直接把候选展开（`showVaultCandidates = true`），
    # 所以这里等的是候选行本身，而不是「查看候选」按钮。
    wait_for(cdp, "document.querySelectorAll('.vault-candidate').length >= 2", timeout=10, desc='候选列表')
    rows = cdp.eval("document.querySelectorAll('.vault-candidate').length")
    row_text = cdp.eval("document.querySelector('.vault-candidate').innerText")
    if '霜寒城' not in str(row_text):
        return False, f'候选首行不含霜寒城：{str(row_text)[:120]}'
    return True, f'索引段在位 / 重建被调用 / 候选 {rows} 行（首行 {str(row_text)[:40]}）'
