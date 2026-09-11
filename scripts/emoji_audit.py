#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Emoji 审计脚本 —— 扫描 src/ 下所有 .vue / .js 文件中的 emoji。

用法：
    python scripts/emoji_audit.py                  # 汇总表
    python scripts/emoji_audit.py --detail         # 附每处行号与上下文
    python scripts/emoji_audit.py --file <path>    # 只看某文件
"""
import os
import re
import sys

EMOJI_RE = re.compile("["
    "\U00002700-\U000027BF"
    "\U0001F600-\U0001F64F"
    "\U0001F300-\U0001F5FF"
    "\U0001F680-\U0001F6FF"
    "\U00002600-\U000026FF"
    "\U0001F900-\U0001F9FF"
    "\U0001FA00-\U0001FAFF"
    "\U00002702-\U000027B0"
    "\U0000231A-\U0000231B"
    "\U000023E9-\U000023F3"
    "\U000023F8-\U000023FA"
    "\U000025AA-\U000025AB"
    "\U000025B6"
    "\U000025C0"
    "\U000025FB-\U000025FE"
    "\U00002614-\U00002615"
    "\U00002648-\U00002653"
    "\U0000267F"
    "\U00002693"
    "\U000026A1"
    "\U000026AA-\U000026AB"
    "\U000026BD-\U000026BE"
    "\U000026C4-\U000026C5"
    "\U000026CE"
    "\U000026D4"
    "\U000026EA"
    "\U000026F2-\U000026F3"
    "\U000026F5"
    "\U000026FA"
    "\U000026FD"
    "\U00002934-\U00002935"
    "\U00002B05-\U00002B07"
    "\U00002B1B-\U00002B1C"
    "\U00002B50"
    "\U00002B55"
    "\U00003030"
    "\U0000303D"
    "\U0000FE0F"
    "\U0000200D"
    "]+", re.UNICODE)

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")
ROOT = os.path.normpath(ROOT)


def walk(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ("node_modules", ".git")]
        for fn in filenames:
            if fn.endswith((".vue", ".js")):
                yield os.path.join(dirpath, fn)


def main():
    detail = "--detail" in sys.argv
    only = None
    if "--file" in sys.argv:
        only = sys.argv[sys.argv.index("--file") + 1]

    total = 0
    files = 0
    results = []
    for path in walk(ROOT):
        rel = os.path.relpath(path, os.path.normpath(os.path.join(ROOT, "..")))
        if only and only.replace("\\", "/") not in rel.replace("\\", "/"):
            continue
        with open(path, encoding="utf-8") as fh:
            lines = fh.readlines()
        hits = []
        for i, line in enumerate(lines, 1):
            for m in EMOJI_RE.finditer(line):
                hits.append((i, m.group(), line.strip()))
        if hits:
            files += 1
            total += len(hits)
            results.append((rel, hits))

    results.sort(key=lambda x: -len(x[1]))
    for rel, hits in results:
        print("%4d  %s" % (len(hits), rel))
        if detail:
            for ln, ch, ctx in hits:
                ctx = ctx if len(ctx) < 110 else ctx[:107] + "..."
                print("        L%-5d %s  | %s" % (ln, ch, ctx))
    print("\n合计：%d 处 / %d 个文件" % (total, files))


if __name__ == "__main__":
    main()
