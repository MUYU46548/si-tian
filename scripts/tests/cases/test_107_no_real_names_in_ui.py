#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 107：**用户可见文案里不许出现真实世界观专名**（2026-10-17）

真实来由（暮雨实测）：「新建剧本的提示文本依然混入绒花计划世界观真实术语，虚拟化没做到位」。
核实：`ScenarioMap.vue` 的两个 placeholder 写死了
`如：乐园星历2006` / `如：乐园星历2008` —— 「乐园星历」是他真实世界观的**纪元名**。

🔴 为什么 `test_86` 没抓到：它只查**用例文件**里的专名是否按数据源解析
（`A('曜川星')` / `__alias()`），**从不扫产品源码的用户可见文案**。
于是"代码里写死真实专名"这条一直漏网 —— 而它比用例里的专名更严重：
**会直接显示给用户**（placeholder / title / 按钮文字）。

本用例守两件事：
  a **黑名单扫描**：`src/` 下的 `.vue` / `.js` 里，**用户可见文案**（placeholder/title/label/
    按钮文字/`statusMsg`/`prompt` 的字符串）不许出现真实专名（乐园星历 / 绒花计划 / 德斯特星 …）。
  b **注释不算**：注释里出现真实专名是**允许**的（它是历史留档，比如"曾硬编码「德斯特星」已移除"），
     所以判据必须先**剥注释**再看 —— 否则会把留档本身判成违规（假红）。

⚠️ 免责/版权署名例外：`AboutPanel.vue` 的 `© 2026 暮雨 · 绒花计划` 是**真实署名**（不是示例文案），
   在 `ALLOWLIST` 里显式豁免，并在注释里写明理由 —— 白名单必须是**具名**的，不能按文件整体放过。
"""
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SRC_DIR = os.path.join(ROOT, 'src')

# ── 黑名单：真实世界观专名（纪元名 / 项目名 / 旧示例名）────────────────────────
# ⚠️ 新增真实专名就加到这里。灰名单只放「真实项目名」，不含任何虚构词 ——
#    虚构词（曜川星等）属于 fixture，不在本用例的防守范围（`test_86` 管那一半）。
REAL_NAMES = [
    '乐园星历',      # 真实纪元名（本轮抓到的那个）
    '绒花计划',      # 真实项目名
    '德斯特星',      # 旧示例名（用户曾要求移除）
]

# ── 具名豁免：真实署名（不是"示例文案"）──────────────────────────────────────
ALLOWLIST = [
    # (文件后缀, 片段, 理由)
    ('AboutPanel.vue', '© 2026 暮雨 · 绒花计划',
     '版权署名 —— 它本来就该写真实作者与项目名，不是给用户的示例'),
]


def _strip_comments(src):
    """剥掉 // 与 /* */ 注释（判据必须看**代码**，不能看历史留档的说明文字）"""
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


def _iter_sources():
    for base, _dirs, files in os.walk(SRC_DIR):
        for fn in files:
            if not fn.endswith(('.vue', '.js')):
                continue
            p = os.path.join(base, fn)
            try:
                with open(p, encoding='utf-8') as f:
                    yield p, f.read()
            except (OSError, UnicodeDecodeError):
                continue


def scan_user_facing():
    """扫源码里的真实专名（剥注释后）；返回 [(相对路径, 行号, 名字, 行内容)]"""
    hits = []
    for path, raw in _iter_sources():
        code = _strip_comments(raw)
        rel = os.path.relpath(path, ROOT).replace('\\', '/')
        for name in REAL_NAMES:
            if name not in code:
                continue
            # 找**还有效的豁免**（按文件后缀 + 片段）
            allowed = any(rel.endswith(suf) and frag in code for suf, frag, _ in ALLOWLIST)
            if allowed:
                # 精确判：豁免片段之外还有没有别处出现
                remainder = code.replace(
                    next(f for suf, f, _ in ALLOWLIST if rel.endswith(suf)), '')
                if name not in remainder:
                    continue
            for i, line in enumerate(code.split('\n'), 1):
                if name in line:
                    hits.append((rel, i, name, line.strip()[:120]))
    return hits


def run(cdp):
    # 不需要浏览器：纯源码扫描（但保持用例签名一致，供 run_tests 调度）
    fails = []
    hits = scan_user_facing()
    for rel, ln, name, line in hits:
        fails.append(f'🔴 用户可见文案里出现真实专名「{name}」：{rel}:{ln}  `{line}`')

    # 反向探针：确认这个扫描器**真抓得住**（否则"0 命中"可能只是因为正则写错）
    probe = 'const t = "如：乐园星历2006";'
    code_only = _strip_comments(probe)
    if not any(n in code_only for n in REAL_NAMES):
        fails.append('🔴 反向探针失败：扫描器对"代码里的真实专名"没有反应（判据无判别力）')
    # 反向探针 2：注释里的专名**不该**被算作违规
    if _strip_comments('// 曾硬编码「乐园星历」已移除').strip():
        fails.append('🔴 反向探针失败：注释没有被剥掉（会把历史留档判成违规）')

    if fails:
        return False, ' | '.join(fails[:8]) + (f' …共 {len(fails)} 条' if len(fails) > 8 else '')
    return True, (f'扫 {len(list(_iter_sources()))} 个源文件，用户可见文案里 0 处真实专名'
                  f'（黑名单 {len(REAL_NAMES)} 个 / 具名豁免 {len(ALLOWLIST)} 条；反向探针 2 条都有判别力）')
