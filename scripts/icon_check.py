#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""图标一致性校验：确认所有被引用的图标名都在 components/Icon.vue 中有定义。

检查来源：
  1. 模板中 <Icon name="xxx"/> 与 <Icon :name="'xxx'"/>
  2. JS/模板中 icon: 'xxx' 形式的图标名（预设表、上下文菜单项等）
  3. iconSvg('xxx') 字符串上下文
非 ASCII 值（历史 emoji 数据）自动忽略。

用法：python scripts/icon_check.py
退出码：0 = 全部有定义；1 = 存在未定义图标名
"""
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SRC = os.path.join(ROOT, "src")
ICON_VUE = os.path.join(SRC, "renderer", "src", "components", "Icon.vue")

IDENT = re.compile(r"^[a-z][a-z0-9-]*$")

# Icon.vue 中已定义的图标名
defined = set(re.findall(r"name === '([^']+)'", open(ICON_VUE, encoding="utf-8").read()))

# 引用点
PATTERNS = [
    re.compile(r"""<Icon\s+name="([^"]+)\""""),
    re.compile(r"""<Icon\s+:name="'([^']+)'\""""),
    re.compile(r"""\bicon:\s*'([^']+)'"""),
    re.compile(r"""\biconSvg\(\s*'([^']+)'"""),
]

used = {}
for dirpath, dirnames, filenames in os.walk(SRC):
    dirnames[:] = [d for d in dirnames if d != "node_modules"]
    for fn in filenames:
        if not fn.endswith((".vue", ".js")):
            continue
        path = os.path.join(dirpath, fn)
        rel = os.path.relpath(path, ROOT)
        for i, line in enumerate(open(path, encoding="utf-8"), 1):
            for pat in PATTERNS:
                for name in pat.findall(line):
                    if IDENT.match(name):
                        used.setdefault(name, []).append("%s:%d" % (rel, i))

missing = {k: v for k, v in used.items() if k not in defined}
print("Icon.vue 已定义：%d 个；代码中引用：%d 个" % (len(defined), len(used)))
unused = sorted(defined - set(used))
if unused:
    print("未使用（仅提示）：%s" % ", ".join(unused))
if missing:
    print("\n!! 未定义却被引用：")
    for k in sorted(missing):
        print("   %-20s %s" % (k, ", ".join(missing[k][:4])))
    sys.exit(1)
print("\n全部图标名均有定义 ✓")
