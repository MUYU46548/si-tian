#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""比"搬前 / 搬后"的面板截图（2026-11-06，配合 ScenarioMap 拆分）

输入是 `drill_moved_panels_visual.py` 跑两次的产物目录：

    build/panels-visual/before/   ← 拆分前（本机做法：`git checkout a111434 -- ScenarioMap.vue scenario-map.css` 后跑一遍）
    build/panels-visual/after/    ← 当前工作树

⚠️ 这是**取证工具，不是常驻闸门**：它打印判定给人/agent 看，不靠退出码卡 CI
（"文案变了"本身不一定是错 —— 2026-11-06 那一轮就同时包含了“按钮补名字”，
那些像素差异是**预期内**的；真正要抓的是**没解释的尺寸/几何漂移**）。

每块面板给一个判定：
  · `identical`   —— 逐像素一致；
  · `text-only`   —— 几何一致、像素有差（通常是文案/图标字形变了，需人眼确认是不是预期）；
  · `layout-shift`—— 位置或尺寸变了（**重点看**：多半是样式/盒模型在搬家中漏了或变了）。
并生成 `<key>-compare.png`（左=搬前，中=搬后，右=差异热图）。

用法：
    python scripts/tests/tools/diff_panel_shots.py \
        --before build/panels-visual/before --after build/panels-visual/after
"""
import argparse
import json
import os
import sys

from PIL import Image, ImageChops

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8')
    except Exception:
        pass


def load_summary(d):
    p = os.path.join(d, 'summary.json')
    if not os.path.exists(p):
        return None
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def first_diff(ta, tb):
    """首个不同字符的位置 + 两侧上下文 —— 比"文案不同"三个字有用得多。"""
    ta, tb = ta or '', tb or ''
    i = next((k for k in range(min(len(ta), len(tb))) if ta[k] != tb[k]), min(len(ta), len(tb)))
    lo = max(0, i - 12)
    return i, f'第 {i} 字起：搬前…{ta[lo:i + 18]!r} / 搬后…{tb[lo:i + 18]!r}'


def compare_images(before_png, after_png, out_png):
    if not (os.path.exists(before_png) and os.path.exists(after_png)):
        return 'missing', '有边缺图', None
    A = Image.open(before_png).convert('RGB')
    B = Image.open(after_png).convert('RGB')
    if A.size != B.size:
        return 'layout-shift', f'尺寸 {A.size} → {B.size}', None
    diff = ImageChops.difference(A, B)
    bbox = diff.getbbox()
    if not bbox:
        return 'identical', f'{A.size[0]}×{A.size[1]} 逐像素一致', None
    hist = diff.convert('L').histogram()
    nonzero = sum(hist[1:])
    total = A.size[0] * A.size[1]
    pct = nonzero * 100.0 / total if total else 0
    heat = diff.convert('L').point(lambda v: 255 if v else 0).convert('RGB')
    w, h = A.size
    canvas = Image.new('RGB', (w * 3 + 16, h), (24, 24, 28))
    canvas.paste(A, (0, 0))
    canvas.paste(B, (w + 8, 0))
    canvas.paste(heat, (w * 2 + 16, 0))
    canvas.save(out_png)
    return 'text-only', f'{nonzero}/{total} 像素不同（{pct:.2f}%），差异区域 {bbox}', out_png


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--before', required=True)
    ap.add_argument('--after', required=True)
    ap.add_argument('--out', default='')
    args = ap.parse_args()
    out = args.out or args.after

    sb = load_summary(args.before)
    sa = load_summary(args.after)
    if not sb or not sa:
        print('缺 summary.json —— 先把 drill 在两个状态下各跑一遍')
        return 2

    before = {p['key']: p for p in sb.get('panels', [])}
    after = {p['key']: p for p in sa.get('panels', [])}
    keys = [p['key'] for p in sa.get('panels', [])] + [k for k in before if k not in after]

    print('搬前：%s' % sb.get('ts'))
    print('搬后：%s' % sa.get('ts'))
    print()
    report = []
    for k in keys:
        pb, pa = before.get(k), after.get(k)
        if not pb or not pa:
            print(f'  ⚠ {k}：只有单边，跳过')
            continue
        label = pa.get('label') or k
        verdict, detail, png = compare_images(
            os.path.join(args.before, k + '.png'),
            os.path.join(args.after, k + '.png'),
            os.path.join(out, k + '-compare.png'))
        same_box = pb.get('box') == pa.get('box')
        same_text = pb.get('textSha') == pa.get('textSha')
        if verdict in ('identical',) and same_box and same_text:
            mark = '✅'
        elif verdict == 'layout-shift' or not same_box:
            mark = '🔴'
        else:
            mark = '🟡'
        print(f'  {mark} {label}（{k}）—— {verdict}')
        print(f'       截图：{detail}')
        print(f'       几何：{"一致" if same_box else "%s → %s" % (pb.get("box"), pa.get("box"))}')
        if not same_text:
            i, line = first_diff(pb.get('text'), pa.get('text'))
            print(f'       文案：{line}')
        if png:
            print(f'       对照图：{os.path.basename(png)}（左=搬前 / 中=搬后 / 右=差异）')
        report.append(dict(key=k, label=label, verdict=verdict, detail=detail,
                           sameBox=same_box, sameText=same_text,
                           boxBefore=pb.get('box'), boxAfter=pa.get('box'),
                           compare=os.path.basename(png) if png else None))

    # ⚠️ 输出目录得先建：以前 `--out` 指到一个不存在的目录时，比对结果全算完了、
    #    却在写 report.json 这一步崩掉（看起来像"工具坏了"，其实是少一行 makedirs）。
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, 'report.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    n_id = sum(1 for r in report if r['verdict'] == 'identical')
    n_txt = sum(1 for r in report if r['verdict'] == 'text-only')
    n_lay = sum(1 for r in report if r['verdict'] == 'layout-shift')
    print()
    print('共 %d 块：逐像素一致 %d / 仅文案差异 %d / 尺寸或位置变了 %d'
          % (len(report), n_id, n_txt, n_lay))
    print('🔴 的每一块都要给出解释（是预期内的样式改动，还是搬家漏了样式）。')
    print('产物：', out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
