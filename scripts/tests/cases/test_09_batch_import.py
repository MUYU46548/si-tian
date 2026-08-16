#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 09：批量导入笔记面板（P2-1，纯创建式）

覆盖：打开面板 → 填写表单 → 执行导入 → 结果汇报；
mock 环境不真实写盘（零污染），验证 UI 链路 + 表单参数正确传递。
"""
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    import time

    # 1. 打开设置面板（world 视图的 ⚙ 按钮）
    opened = cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('⚙')); if (!b) return 'no-btn'; b.click(); return 'ok'; })()")
    if opened != 'ok':
        return False, f'设置面板按钮未找到: {opened}'
    time.sleep(0.5)
    if not cdp.eval("!!document.querySelector('.settings-overlay')"):
        return False, '设置面板未打开'

    # 2. 点「📥 批量导入」按钮
    click_import = cdp.eval("(() => { const b = Array.from(document.querySelectorAll('.settings-overlay button')).find(x => x.textContent.includes('批量导入')); if (!b) return 'no-btn'; b.click(); return 'ok'; })()")
    if click_import != 'ok':
        return False, f'批量导入按钮未找到: {click_import}'
    time.sleep(0.6)
    if not cdp.eval("!!document.querySelector('.batch-import-panel')"):
        return False, '批量导入面板未打开'

    # 3. 填写表单：世界 / 层级 / 名字列表（注意：必须 IIFE 包裹，顶层 return 是 SyntaxError）
    form = cdp.eval("""
      (() => {
        const panel = document.querySelector('.batch-import-panel');
        const selects = panel.querySelectorAll('select');
        const setVal = (el, v) => { el.value = v; el.dispatchEvent(new Event('change')); };
        if (selects.length >= 2) {
          setVal(selects[0], '幻境');
          setVal(selects[1], 'location');
        }
        const ta = panel.querySelector('textarea');
        if (ta) { ta.value = '测试地点甲\\n测试地点乙\\n测试地点丙'; ta.dispatchEvent(new Event('input')); }
        return JSON.stringify({ selects: selects.length, hasTextarea: !!ta });
      })()
    """)
    if not form or '"hasTextarea":false' in str(form):
        return False, f'表单元素异常: {form}'

    # 4. 点击「开始导入」（mock 返回 created）
    clicked = cdp.eval("(() => { const b = Array.from(document.querySelectorAll('.batch-import-panel button')).find(x => x.textContent.includes('开始导入')); if (!b) return 'no-btn'; b.click(); return 'ok'; })()")
    if clicked != 'ok':
        return False, f'开始导入按钮未找到: {clicked}'
    time.sleep(0.8)

    # 5. 断言结果展示（mock created = 3）
    result_text = cdp.eval("document.querySelector('.batch-import-panel .result-box p')?.textContent || ''")
    if '创建 3 个' not in result_text:
        return False, f'导入结果未正确展示: {result_text}'
    target_path = cdp.eval("document.querySelector('.batch-import-panel .result-path')?.textContent || ''")
    if '目标目录' not in target_path:
        return False, f'目标目录未展示: {target_path}'

    # 6. 关闭面板
    cdp.eval("(() => { const b = Array.from(document.querySelectorAll('.batch-import-panel button')).find(x => x.textContent.trim() === '取消'); if (b) b.click(); return 'ok'; })()")
    time.sleep(0.3)
    if cdp.eval("!!document.querySelector('.batch-import-panel')"):
        return False, '面板未关闭'

    return True, '批量导入面板全链路（打开/表单/导入/结果/关闭）'
