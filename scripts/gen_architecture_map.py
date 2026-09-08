#!/usr/bin/env python3
"""再生成 docs/ARCHITECTURE_MAP.md 的「结构清单」节（GEN 标记之间）。

分工纪律：
  - 快变量（文件清单、行数）= 本脚本负责，永远新鲜
  - 慢变量（每文件一句话职责）= 人工维护，再生成时自动保留
  - 文件删除后其职责描述自动消失；新文件标注（待补）

用法：
  python scripts/gen_architecture_map.py          # 再生成并合并旧职责描述
  python scripts/gen_architecture_map.py --check  # 只对比不改写，报告过期行数（exit 1 = 已过期）
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOC = os.path.join(ROOT, "docs", "ARCHITECTURE_MAP.md")
SCAN_DIRS = ["src/main", "src/preload", "src/renderer/src", "scripts"]
EXTS = (".js", ".vue", ".py")
SKIP_DIRS = {"node_modules", "__pycache__", "cases", "release"}


def scan():
    """返回 {相对路径: 行数}，按路径排序。"""
    rows = {}
    for d in SCAN_DIRS:
        base = os.path.join(ROOT, d)
        for dp, dn, fn in os.walk(base):
            dn[:] = [x for x in dn if x not in SKIP_DIRS]
            for f in fn:
                if f.endswith(EXTS):
                    p = os.path.join(dp, f)
                    rel = os.path.relpath(p, ROOT).replace("\\", "/")
                    try:
                        with open(p, encoding="utf-8", errors="replace") as fh:
                            n = sum(1 for _ in fh)
                    except OSError:
                        n = 0
                    rows[rel] = n
    return dict(sorted(rows.items()))


def parse_old(text):
    """从旧文档 GEN 块提取 {路径: 职责}。"""
    descs = {}
    m = re.search(r"<!-- GEN:START -->\n(.*?)<!-- GEN:END -->", text, re.S)
    if not m:
        return descs
    for line in m.group(1).splitlines():
        mm = re.match(r"\|\s*\d+\s*\|\s*`([^`]+)`\s*\|\s*(.*?)\s*\|?\s*$", line)
        if mm:
            descs[mm.group(1)] = mm.group(2)
    return descs


def build(rows, descs):
    out = ["| 行数 | 文件 | 职责 |", "|---:|---|---|"]
    for rel, n in rows.items():
        out.append("| {} | `{}` | {} |".format(n, rel, descs.get(rel, "（待补）")))
    return "\n".join(out)


def main():
    check = "--check" in sys.argv
    text = ""
    if os.path.exists(DOC):
        with open(DOC, encoding="utf-8") as fh:
            text = fh.read()
    descs = parse_old(text)
    rows = scan()
    new_block = build(rows, descs)

    if check:
        old_lines = set(text.splitlines())
        stale = [l for l in new_block.splitlines()
                 if l not in old_lines and not l.startswith("| 行数") and not l.startswith("|---")]
        if stale:
            print("check: 文档与代码不一致，{} 行需更新：".format(len(stale)))
            for l in stale[:10]:
                print("  " + l)
            if len(stale) > 10:
                print("  ... 共 {} 行".format(len(stale)))
            sys.exit(1)
        print("check: 结构清单与代码一致（{} 文件，{} 条职责描述）".format(len(rows), len(descs)))
        return

    if "<!-- GEN:START -->" in text:
        new_text = re.sub(
            r"<!-- GEN:START -->\n.*?<!-- GEN:END -->",
            "<!-- GEN:START -->\n" + new_block + "\n<!-- GEN:END -->",
            text, flags=re.S)
    else:
        head = text + "\n\n" if text.strip() else ""
        new_text = head + "<!-- GEN:START -->\n" + new_block + "\n<!-- GEN:END -->\n"
    with open(DOC, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(new_text)
    print("ok: {} 个文件已写入 docs/ARCHITECTURE_MAP.md（保留职责描述 {} 条）".format(len(rows), len(descs)))


if __name__ == "__main__":
    main()
