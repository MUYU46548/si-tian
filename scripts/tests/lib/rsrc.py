# -*- coding: utf-8 -*-
"""渲染/交互源码合集（测试用）

**为什么要有这个文件**：N1 把 `ScenarioMap.vue` 里的绘制与交互体分批搬到了
`src/renderer/src/scenario/{layers,interaction}/*.js`。很多用例的"源码闸门"原来是
`_read('.../ScenarioMap.vue')` 然后在里面搜某行代码 —— 代码一搬，闸门就假红。

这里把「组件 + 所有渲染层 + 所有交互层」拼成一份源码，用例只读这一份：
判据（找什么代码 / 什么函数体）一字不用改，也不会再因为搬家而失败。

用法：
    from lib.rsrc import render_src, render_src_code_only
    sm = render_src()                 # 原始源码（含注释）
    sm = render_src_code_only()       # 剥掉注释（多数源码闸门的口径）
"""
import os
import re
import glob

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SFC = os.path.join(ROOT, 'src', 'renderer', 'src', 'components', 'ScenarioMap.vue')


def render_files():
    """组件 + layers/*.js + interaction/*.js + styles/*.css（按路径排序，保证结果稳定）

    ⚠️ 样式也算：`ScenarioMap.vue` 的 `<style scoped>` 已搬进 `styles/scenario-map.css`，
    而不少用例的源码闸门会在组件源码里找 CSS 选择器（`.toolbar-more {` 之类）。
    """
    files = [SFC]
    for sub in ('layers', 'interaction'):
        files += sorted(glob.glob(os.path.join(
            ROOT, 'src', 'renderer', 'src', 'scenario', sub, '*.js')))
    files += sorted(glob.glob(os.path.join(
        ROOT, 'src', 'renderer', 'src', 'styles', '*.css')))
    return files


def render_src():
    out = []
    for p in render_files():
        with open(p, encoding='utf-8') as f:
            out.append(f.read())
    return '\n'.join(out)


def strip_comments(src):
    """与各用例里 `_code_only` 同口径：去掉 // 与 /* */ 注释，保留字符串"""
    out, in_block = [], False
    for line in src.split('\n'):
        s = line
        if in_block:
            if '*/' in s:
                s = s.split('*/', 1)[1]
                in_block = False
            else:
                continue
        while '/*' in s:
            before, after = s.split('/*', 1)
            if '*/' in after:
                s = before + after.split('*/', 1)[1]
            else:
                s = before
                in_block = True
                break
        if '//' in s:
            s = s.split('//', 1)[0]
        out.append(s)
    return '\n'.join(out)


def render_src_code_only():
    return strip_comments(render_src())


def read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()
