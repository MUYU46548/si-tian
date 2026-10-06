#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把用例里**写死的 fixture 专名**改成「按当前数据源解析」（2026-10-06）。

背景：`--real-data` 下 19 个失败里 17 个是「写死了合成 fixture 的名字」。用例应当写
`A('曜川星')`（Python 侧）或 `__alias('曜川星')`（页面 JS 侧），由 harness 在真实数据下
解析成真实库里的对应名字（表在 fixtures/name_map.py）。

为什么不能用一句 sed：
    同一个名字在两种上下文里都有 ——
      · Python 值：    act_on_node(cdp, '曜川星', 'click')       → A('曜川星')
      · 页面 JS 文本： "s.nodes.find(n => n.name === '曜川星')"  → __alias('曜川星')
    一律替换会得到 `"… === '__alias('曜川星')'"`（引号被包进 JS 字符串，直接写坏）。

两阶段（各自处理一种上下文，互不重叠）：
    阶段 A —— `tokenize` 按**字符串字面量**切分：
        · 字面量解码后**恰好等于**名字      → Python 值 → 整段换成 A('名字')
        · 字面量里含 `'名字'`（引号在内部）→ 页面 JS → 把 `'名字'` 换成 __alias('名字')
        （docstring 内的专名是散文，跳过）
    阶段 B —— f-string 里的 JS 文本：
        Python 3.12+（PEP 701）把 f-string 拆成 FSTRING_START/MIDDLE/END，
        且 MIDDLE 的偏移在 `{{`/`}}` 处会漂移 → **不能用偏移算术**。
        改为用 `ast.JoinedStr` 取 f-string 的行区间，在行内做正则替换。

用法：
    python scripts/tests/tools/alias_fixture_names.py --dry      # 只打印计划 + 残留清单
    python scripts/tests/tools/alias_fixture_names.py --apply    # 写盘（幂等）
"""
import argparse
import ast
import io
import os
import re
import sys
import tokenize

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests', 'fixtures'))
from name_map import KNOWN_FIXTURE_NAMES  # noqa: E402

CASES = os.path.join(ROOT, 'scripts', 'tests', 'cases')
NAMES = sorted(KNOWN_FIXTURE_NAMES, key=len, reverse=True)

# 尚未包装的名字引用（负向后视：已是 A(...) / __alias(...) 实参的不动）
_LOOKBEHIND = r'(?<!A\()(?<!__alias\()'

#: 「这段字面量是不是 JS 源码」的判据 —— 防止把 Python 的**失败提示串**当 JS 改坏。
#: 实测踩过：`return False, '搜索"沧屿"无结果'` 里的 `"沧屿"` 被换成 `__alias("沧屿")`
#: （只坏文案不影响断言，但属于静默走形，必须挡住）。
_IS_JS = re.compile(r'=>|;|\{|\}|!==|===|\|\||&&|\.\w+\(')

#: 引号前一个字符若是汉字/字母数字，说明这是散文里的引用，不是 JS 里的字符串字面量
_WORDY = re.compile(r'[\w\u4e00-\u9fa5]')


def _quoted_pattern(name):
    """匹配 `'名字'` / `"名字"`，含转义写法 `\\'名字\\'`。"""
    parts = []
    for q in ("'", '"'):
        parts.append(re.escape(q + name + q))
        parts.append(re.escape('\\' + q + name + '\\' + q))
    return re.compile(_LOOKBEHIND + '(?:' + '|'.join(parts) + ')')


def _spans(src):
    """(docstring 行区间, f-string 行区间)。"""
    doc, fstr = [], []
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return doc, fstr
    for node in ast.walk(tree):
        if isinstance(node, ast.JoinedStr):
            fstr.append((node.lineno, node.end_lineno))
            continue
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, 'body', None)
            if body and isinstance(body[0], ast.Expr) \
                    and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
                doc.append((body[0].value.lineno, body[0].value.end_lineno))
    return doc, fstr


def _in(ln, spans):
    return any(a <= ln <= b for a, b in spans)


def already_wrapped(src, pos):
    """成为 A(...) / __alias(...) 实参的文本不再动（幂等）。"""
    return src[max(0, pos - 12):pos].rstrip().endswith(('A(', '__alias(', 'A (', '__alias ('))


def plan_file(path):
    src = io.open(path, encoding='utf-8').read()
    doc_span, fstr_span = _spans(src)
    lines = src.splitlines(keepends=True)
    offs = [0]
    for ln in lines:
        offs.append(offs[-1] + len(ln))
    at = lambda l, c: offs[l - 1] + c

    edits = []

    # ── 阶段 A：tokenize 切分字符串字面量
    for tok in tokenize.generate_tokens(io.StringIO(src).readline):
        if tok.type != tokenize.STRING or _in(tok.start[0], doc_span):
            continue
        raw, start = tok.string, at(tok.start[0], tok.start[1])
        try:
            val = ast.literal_eval(raw)
        except Exception:
            val = None
        if isinstance(val, str) and val in NAMES and not already_wrapped(src, start):
            edits.append((start, start + len(raw), "A(%r)" % val, val, 'py'))
            continue
        if not (isinstance(val, str) and _IS_JS.search(val)):
            continue    # 既不是「纯值」也不是「JS 源码」→ 散文串（失败提示等），别动
        for n in NAMES:
            for m in _quoted_pattern(n).finditer(raw):
                if _WORDY.match(m.group(0)[:1]) or (m.start() > 0 and _WORDY.match(raw[m.start() - 1])):
                    continue    # 引号紧贴汉字/字母 → 散文引用，不是 JS 字符串字面量
                # 整段匹配换成 __alias(原匹配)：普通 `'名'` → __alias('名')；
                # 转义 `\'名\'` → __alias(\'名\')（留在单引号 Python 串里仍合法）
                edits.append((start + m.start(), start + m.end(),
                              '__alias(' + m.group(0) + ')', n, 'js'))

    # ── 阶段 B：f-string 内的 JS 文本（偏移会漂移 → 在行内正则替换）
    for ln in range(1, len(lines) + 1):
        if not _in(ln, fstr_span) or _in(ln, doc_span):
            continue
        text = lines[ln - 1]
        for n in NAMES:
            for m in _quoted_pattern(n).finditer(text):
                if m.start() > 0 and _WORDY.match(text[m.start() - 1]):
                    continue    # 同上：引号紧贴汉字 → 散文引用
                edits.append((at(ln, m.start()), at(ln, m.end()),
                              '__alias(' + m.group(0) + ')', n, 'js-f'))

    # 去重 + 排序
    seen, out = set(), []
    for e in sorted(edits, key=lambda x: x[0]):
        if e[0] in seen:
            continue
        seen.add(e[0])
        out.append(e)

    # ── 残留清单：ASCII 引号包着的名字，但没被任何一条 edit 覆盖
    covered = set()
    for s, e, _r, _n, _k in out:
        covered.add((s, e))
    leftovers = []
    for ln in range(1, len(lines) + 1):
        text = lines[ln - 1]
        for n in NAMES:
            for m in _quoted_pattern(n).finditer(text):
                if (at(ln, m.start()), at(ln, m.end())) in covered:
                    continue
                why = 'docstring' if _in(ln, doc_span) else ('f-string' if _in(ln, fstr_span) else '其它')
                leftovers.append((ln, n, why, text.strip()[:90]))
    return src, out, leftovers


def apply_edits(src, edits):
    out, cur = [], 0
    for s, e, rep, _n, _k in edits:
        out.append(src[cur:s])
        out.append(rep)
        cur = e
    out.append(src[cur:])
    return ''.join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()

    total, touched, all_left = 0, 0, []
    for fn in sorted(os.listdir(CASES)):
        if not (fn.startswith('test_') and fn.endswith('.py')):
            continue
        path = os.path.join(CASES, fn)
        src, edits, leftovers = plan_file(path)
        if not edits:
            continue
        touched += 1
        total += len(edits)
        kinds = {}
        for e in edits:
            kinds[e[4]] = kinds.get(e[4], 0) + 1
        print('%-44s %2d 处  %s' % (fn, len(edits), kinds))
        if args.apply:
            io.open(path, 'w', encoding='utf-8', newline='').write(apply_edits(src, edits))
        all_left += [(fn, ) + l for l in leftovers]

    print('\n%s：%d 个文件 / %d 处' % ('计划' if not args.apply else '已改写', touched, total))
    if all_left:
        print('\n残留（未被改写的 ASCII 引号名字引用，%d 处）—— 需人工确认是否散文：' % len(all_left))
        for fn, ln, n, why, txt in all_left:
            print('  %-38s L%-4d %-8s %-9s %s' % (fn, ln, n, why, txt))
    else:
        print('\n残留：0 —— 所有 ASCII 引号包裹的 fixture 专名都已包进 A()/__alias()')
    return 0


if __name__ == '__main__':
    sys.exit(main())
