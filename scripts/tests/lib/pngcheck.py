#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PNG 像素判据（Pillow）—— 导出类用例与演练脚本**共用一份实现**。

为什么单独立一个模块：`cases/test_100_scenario_png_export.py`（合成 fixture）与
`drill_p0_first_map.py`（真实 415 省项目）要下的像素判据是同一套（合法 PNG / 尺寸 /
非空白 / 势力色 / 文字像素）。两处各写一份就是下一个「改一处另两处不变」——
而且这种偏差**不会报错**，只会让其中一处静默失去判别力。

🔴 全部走 Pillow 的 C 层算子（`ImageChops` / `histogram`）而不是 Python 逐像素循环：
   真实 415 省底图导出的 PNG 是 **3680×1752 ≈ 645 万像素**，解释器逐像素要跑几分钟
   （而 CDP 那侧还等着），用 C 层算子则是亚秒级。

🔴 「势力色」判据为什么要分两种（`count_near` / `count_near_blend`）：
   `useScenarioExport.js` 的省份填充是 `fill-opacity: 0.72`（**半透明**，与背景 `#1a2a3a`
   合成），而图例色块是**不透明**的。所以同一个 `#c23b3b` 在图上有两个完全不同的落点色：
     · 图例色块 / EU4 斜线描边 / 斜线 pattern  → **原色**（`exact`）
     · 省份填充                              → **0.72 合成色**（`blend`）
   只判其中一种都会漏（实测：`#c23b3b` 在 EU4 模式下**只**以合成色出现，原色 0 像素）。
"""
import base64
import io

from PIL import Image, ImageChops

#: 导出 SVG 的背景色（`scenarioPalette.EXPORT_OCEAN`，唯一事实源在 utils/scenarioPalette.js）
#: 2026-10-25 起比画布底色亮一档：近黑海面在成品图里像一块洞（用户实测反馈）。
SVG_BG = (0x24, 0x45, 0x5f)
#: 省份填充不透明度（`svgPath(d, { 'fill-opacity': 0.72 })`，唯一事实源在 useScenarioExport.js）
PROVINCE_FILL_ALPHA = 0.72
#: 省名文字颜色（`PROVINCE_LABEL_STYLE.color`，唯一事实源在 utils/polityLabels.js）
#: 2026-10-25 起与画布同款：白字 + 深色描边，不再是 `#3c4150` 深灰。
LABEL_COLOR = (0xFF, 0xFF, 0xFF)
#: 省名文字不透明度（白字实心填，无 opacity）
LABEL_ALPHA = 1.0


def decode_data_url(data_url):
    """`data:image/png;base64,…` → 原始 PNG 字节。前缀不对直接抛（不猜、不兜底）。"""
    if not isinstance(data_url, str) or not data_url.startswith('data:image/png;base64,'):
        raise ValueError('不是 PNG dataUrl（前缀不符）：%s' % repr(str(data_url)[:64]))
    payload = data_url.split(',', 1)[1]
    if not payload:
        raise ValueError('dataUrl 的 base64 段是空的')
    return base64.b64decode(payload)


def open_png(raw):
    """字节 → PIL.Image（调用方读 `img.format` / `img.size`）。"""
    return Image.open(io.BytesIO(raw))


def rgb(img):
    return img.convert('RGB')


def unique_colors(img):
    """去重颜色数（超过 2^24 时返回 2^24；`getcolors` 返回 None 表示"多于上限"）。"""
    cols = rgb(img).getcolors(maxcolors=1 << 24)
    return len(cols) if cols else (1 << 24)


def _solid(size, color):
    return Image.new('RGB', size, tuple(int(c) for c in color))


def _maxdiff_mask(img, other, tol):
    """逐像素「最大通道差 ≤ tol」的二值掩码（255 = 命中）。

    用 `ImageChops.lighter` 取三通道**最大值**，而不是 `convert('L')` 的亮度加权：
    亮度是凸组合，`L ≤ 8` 并不蕴含"每个通道都 ≤ 8"（实测反例 R=20,G=0,B=0 → L≈6）。
    """
    d = ImageChops.difference(rgb(img), rgb(other))
    r, g, b = d.split()
    m = ImageChops.lighter(ImageChops.lighter(r, g), b)
    return m.point(lambda v: 255 if v <= tol else 0)


def _mask_count(mask):
    """0/255 掩码里命中的像素数（O(1)：读直方图第 255 桶）。"""
    return mask.histogram()[255]


def count_near(img, color, tol=8):
    """逐通道 ±tol 落在 `color` 上的像素数（判"原色"，如图例色块 / 斜线描边）。"""
    r = rgb(img)
    return _mask_count(_maxdiff_mask(r, _solid(r.size, color), tol))


def blend(color, alpha, bg=SVG_BG):
    """`color` 以 alpha 不透明度叠在 bg 上的合成色（与 SVG 的 fill-opacity 同口径）。"""
    return tuple(int(round(alpha * c + (1 - alpha) * b)) for c, b in zip(color, bg))


def count_near_blend(img, color, alpha, bg=SVG_BG, tol=8):
    """`color` 以 alpha 叠在 bg 上的**合成色**附近的像素数（判"省份填充色"）。"""
    return count_near(img, blend(color, alpha, bg), tol)


def count_near_any(img, colors, tol=8):
    """落在 `colors` 里**任一**颜色附近的像素数（取**并集**，不是相加 —— 几个候选色可能互相接近）。"""
    r = rgb(img)
    m = None
    for c in colors:
        mm = _maxdiff_mask(r, _solid(r.size, c), tol)
        m = mm if m is None else ImageChops.lighter(m, mm)
    return _mask_count(m) if m is not None else 0


def name_text_candidates(label=LABEL_COLOR, alpha=LABEL_ALPHA, polity_colors=(),
                        fill_alpha=PROVINCE_FILL_ALPHA, bg=SVG_BG):
    """省名文字**可能**落成的合成色集合（不依赖"关掉标注再导一次"那张对照图）。

    2026-10-25 起省名是**不透明白字 + 深色描边**（与画布同一份 `PROVINCE_LABEL_STYLE`），
    所以 `alpha=1` 时候选集合退化为纯白 —— 本函数仍保留参数，供历史口径/未来改色复用。
    省名画在省份的面积加权形心处（`ringAreaCentroid`），所以它的底子只可能是两种：
      · SVG 背景色本身（40px 外边距 / 无省份覆盖处）；
      · 某个势力的省份填充色 = `fill_alpha * polity_color + (1-fill_alpha) * bg`。
    文字自身带 `opacity: alpha`，于是合成色 = `alpha*label + (1-alpha)*底子`。
    真实 415 省底图的演练脚本没有"对照图"可用时要靠这个判据，所以放在共用模块里。
    """
    out = [blend(label, alpha, bg)]
    for c in polity_colors:
        out.append(blend(label, alpha, blend(c, fill_alpha, bg)))
    return out


def diff_pixels(a, b):
    """两张同尺寸图**逐像素任一通道不同**的像素数 + 该掩码（0/255 L 图）。

    用途：`a` = 有标注导出、`b` = 关掉标注导出 → 差集就是「标注这一层画出来的像素」。
    比"猜一个文字颜色再数"稳得多：文字压在什么底色上是**逐像素精确知道**的。
    """
    ra, rb = rgb(a), rgb(b)
    if ra.size != rb.size:
        raise ValueError('尺寸不一致，无法逐像素比较：%s vs %s' % (ra.size, rb.size))
    d = ImageChops.difference(ra, rb)
    r, g, bb = d.split()
    m = ImageChops.lighter(ImageChops.lighter(r, g), bb)
    return sum(m.histogram()[1:]), m


def label_text_pixels(a, b, label=LABEL_COLOR, alpha=LABEL_ALPHA, tol=8):
    """统计「确实由 **LABEL_COLOR 的省名文字**画出来的」像素数。

    🔴 为什么这个判据是**精确**而不是近似：`b`（关掉标注的那次导出）就是文字底下
       真实的背景（省份填充 / 网格 / 边界 / 背景色全都在），所以期望色
       `alpha*label + (1-alpha)*b` 是逐像素算出来的，不需要假设"文字压在什么颜色上"。
       全不透明覆盖的笔画像素应当落在该期望值 ±tol 内；抗锯齿边缘（覆盖率 < 1）不落，
       所以这个数 ≈ **笔画实心部分**的像素数，是"标注真的画出来了"的强判据。

    再与 `a != b` 的掩码取交集，排除"碰巧落在这个颜色上"的其它图层（网格线 `/243449`
    在 0.55 不透明度下合成 ≈(32,48,66)，离 LABEL 的合成色 (55,62,77) 并不远 —— 不取交集
    就会把网格线也算成文字）。
    """
    ra, rb = rgb(a), rgb(b)
    if ra.size != rb.size:
        raise ValueError('尺寸不一致：%s vs %s' % (ra.size, rb.size))
    expected = Image.blend(_solid(ra.size, label), rb, 1 - alpha)   # label*alpha + b*(1-alpha)
    near = _maxdiff_mask(ra, expected, tol)
    _, dm = diff_pixels(ra, rb)
    dm_bin = dm.point(lambda v: 255 if v > 0 else 0)
    return _mask_count(ImageChops.multiply(near, dm_bin))
