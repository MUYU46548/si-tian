#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 scripts/proto 与 docs/proto 下的直角引号换成普通双引号。

## 为什么单独写个脚本

`test_quote_marks.js` 是项目的硬闸门（禁止直角引号），而我写中文注释时**五次**用了
`""`。每次都是被闸门拦下来才去修 —— 那是在治症状。

这个脚本是为了：
  ① 一次性把现有的清干净；
  ② 以后改完 proto 目录，跑一下就知道还有没有（比等全量回归快）。

用法：
  python scripts/proto/fix_quotes.py          # 修
  python scripts/proto/fix_quotes.py --check  # 只查不改（非 0 退出 = 有）
"""
import glob
import os
import sys

LEFT = '\u300c'    # "
RIGHT = '\u300d'   # "

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PATTERNS = ['scripts/proto/*', 'docs/proto/*']


def main():
    check_only = '--check' in sys.argv[1:]
    total = 0
    files = 0
    for pat in PATTERNS:
        for f in glob.glob(os.path.join(ROOT, pat)):
            if not os.path.isfile(f):
                continue
            with open(f, 'r', encoding='utf-8') as fh:
                t = fh.read()
            n = t.count(LEFT) + t.count(RIGHT)
            if not n:
                continue
            total += n
            files += 1
            print(f'{"[有]" if check_only else "[修]"} {os.path.relpath(f, ROOT)}: {n} 处')
            if not check_only:
                t = t.replace(LEFT, '"').replace(RIGHT, '"')
                with open(f, 'w', encoding='utf-8', newline='') as fh:
                    fh.write(t)

    if check_only:
        if total:
            print(f'\n共 {files} 个文件 / {total} 处直角引号 —— 会被 test_quote_marks.js 判红')
            return 1
        print('干净：0 处直角引号')
        return 0
    print(f'\n共修 {files} 个文件 / {total} 处')
    return 0


if __name__ == '__main__':
    sys.exit(main())
