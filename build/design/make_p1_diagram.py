# -*- coding: utf-8 -*-
"""画 P1「顶点拖动让省份变小」的两种语义对照图（给暮雨定夺用）。

背景（2026-10-13）：P1 顶点编辑要解决「框选 → 拖动 → 相邻省边界自动重算」。
拖动让省**变大**时语义清楚（多出来的地从邻省扣）；让省**变小**时退出来的那块地归谁，
产品上没定 —— 这张图就是把两条路画出来。
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'p1-vertex-shrink-options.png')
FONT = r'C:\Windows\Fonts\msyh.ttc'
FONT_B = r'C:\Windows\Fonts\msyhbd.ttc'


def font(size, bold=False):
    for p in ([FONT_B, FONT] if bold else [FONT, FONT_B]):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


W, H = 1240, 680
img = Image.new('RGB', (W, H), '#f7f8fa')
d = ImageDraw.Draw(img)

TITLE = font(23, True)
SUB = font(15)
CAP = font(17, True)
BODY = font(13)
SMALL = font(12.5)
BODY_B = font(13, True)

PX0, PY, PW, PH = 40, 104, 360, 336
GAP = 40
AX0, AX1, BX0, BX1 = 25, 175, 175, 335
Y0, Y1, MIDY, NOTCH_X = 48, 250, 149, 116

A_FILL, A_EDGE = '#cfe0f7', '#2f5fd0'
B_FILL, B_EDGE = '#d8ecd2', '#3d7a34'
FREE_FILL, FREE_EDGE = '#e6e6ec', '#b3261e'

PANELS = [
    ('① 拖动前（基线）', None,
     'A 与 B 共享这条边；拖动的是边上的中间顶点（空心圆）。'),
    ('② 方案甲：边界整体重算', 'jia',
     '退出来的地由邻省吃掉 —— 无缝隙、无洞（EU4 的做法）。'),
    ('③ 方案乙：留成无主地', 'yi',
     '退出来的地没人要，画布上是一块灰缝 / 洞。'),
]


def panel(ox, oy, title, mode, note):
    d.rounded_rectangle([ox, oy, ox + PW, oy + PH], radius=10, fill='#ffffff', outline='#d3d8e0')
    d.text((ox + 16, oy + 12), title, font=CAP, fill='#1c2b3a')

    # 省 A
    a_pts = ([(AX0, Y0), (AX1, Y0), (AX1, Y1), (AX0, Y1)] if not mode else
             [(AX0, Y0), (AX1, Y0), (NOTCH_X, MIDY), (AX1, Y1), (AX0, Y1)])
    d.polygon([(ox + x, oy + y) for x, y in a_pts], fill=A_FILL, outline=A_EDGE, width=3)
    d.text((ox + AX0 + 10, oy + Y0 + 10), '省 A', font=CAP, fill=A_EDGE)

    # 省 B
    b_pts = ([(BX0, Y0), (BX1, Y0), (BX1, Y1), (BX0, Y1)] if mode != 'jia' else
             [(BX1, Y0), (BX1, Y1), (BX0, Y1), (NOTCH_X, MIDY), (BX0, Y0)])
    d.polygon([(ox + x, oy + y) for x, y in b_pts], fill=B_FILL, outline=B_EDGE, width=3)
    d.text((ox + BX0 + 12, oy + Y0 + 10), '省 B', font=CAP, fill=B_EDGE)
    d.text((ox + BX0 + 12, oy + Y0 + 32), '（邻省）', font=SMALL, fill=B_EDGE)

    # 退出来的那块地
    tri = [(BX0, Y0), (NOTCH_X, MIDY), (BX0, Y1)]
    if mode == 'yi':
        d.polygon([(ox + x, oy + y) for x, y in tri], fill=FREE_FILL, outline=FREE_EDGE, width=3)

    # 共享边界（基线）
    if not mode:
        d.line([(ox + AX1, oy + Y0), (ox + AX1, oy + Y1)], fill='#333333', width=2)

    # 顶点：原位置（空心）+ 拖后位置（金色）
    d.ellipse([ox + AX1 - 5, oy + MIDY - 5, ox + AX1 + 5, oy + MIDY + 5],
              fill='#ffffff', outline='#111111', width=2)
    if mode:
        d.line([(ox + AX1, oy + MIDY), (ox + NOTCH_X + 10, oy + MIDY)], fill='#8a6d00', width=2)
        d.polygon([(ox + NOTCH_X + 10, oy + MIDY), (ox + NOTCH_X + 22, oy + MIDY - 5),
                   (ox + NOTCH_X + 22, oy + MIDY + 5)], fill='#8a6d00')
        d.ellipse([ox + NOTCH_X - 6, oy + MIDY - 6, ox + NOTCH_X + 6, oy + MIDY + 6],
                  fill='#ffd700', outline='#8a6d00', width=2)

    # 面板内注释（放在形状下方，避免压到图形）
    y = oy + 264
    for line, fnt, col in note:
        d.text((ox + 16, y), line, font=fnt, fill=col)
        y += 20


panel(PX0, PY, *PANELS[0][:1], PANELS[0][1], [
    ('空心圆 = 被拖动的中间顶点', BODY, '#33404d'),
    ('黑线 = A 与 B 的共边', BODY, '#33404d'),
])
panel(PX0 + (PW + GAP), PY, *PANELS[1][:1], PANELS[1][1], [
    ('退出来的那块 → 邻省 B 吃掉', BODY_B, B_EDGE),
    ('边界重算后：无缝隙、无洞', BODY, '#33404d'),
])
panel(PX0 + 2 * (PW + GAP), PY, *PANELS[2][:1], PANELS[2][1], [
    ('退出来的那块 → 无主（灰色）', BODY_B, FREE_EDGE),
    ('画布上留下一条缝 / 一个洞', BODY, '#33404d'),
])

d.text((40, 30), 'P1 顶点编辑：拖动让一个省「变小」时，退出来的那块地归谁？', font=TITLE, fill='#16202c')
d.text((40, 64), '同一个手势、同一块地 —— 差别只在这三步里的后两步。选定之后我按它写「相邻省边界自动重算」。',
       font=SUB, fill='#5a6572')

TY = PY + PH + 22
d.text((40, TY), '方案甲（EU4 的做法）：边界整体重算，邻省吃掉退出来的地。无缝隙、无洞，导出图与归属统计里也不会多出"无主"。',
       font=SUB, fill='#1c2a3a')
d.text((40, TY + 24), '代价：一次拖动可能同时改动多个邻省；框选批量拖动时要再加一道「不许碰到无关省」的闸门（这正是 P1 验收线里那句"不串省"）。',
       font=SMALL, fill='#5a6572')
d.text((40, TY + 52), '方案乙：不重算，退出来的地留成无主。改动面最窄、实现最小；代价是几百块省的图上会慢慢攒出灰色空隙，',
       font=SUB, fill='#1c2a3a')
d.text((40, TY + 76), '而且那块"无主"会同时出现在画布、点选、归属统计与导出图里 —— 需要额外的闸门与提示才不至于变成新的困惑源。',
       font=SMALL, fill='#5a6572')
d.text((40, TY + 106), '第三种折中（图里没画）：往里拖直接拒绝（顶点只能往外扩）—— 最保守，先只解决「切得不够用」那一半，等真用起来再说收缩。',
       font=SMALL, fill='#8a6d00')

img.save(OUT)
print('saved', OUT, os.path.getsize(OUT), 'bytes')
