#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成「不听话的库」夹具（S0 / T1-T2 用）。

为什么要它（2026-10-19 规划 §3.1）：
    真实用户的路径和文件名不会按司天的两个硬编码目录摆放。现有测试 fixture 是
    「真实库同构换名」，仍然有 `03 设定/11 地理系统` 与 `01 索引/地理系统索引.md`，
    因此**永远测不出**「换一个乱库会怎样」。本夹具故意反过来：

      · 大量笔记散落在任意目录（中文/空格/深层嵌套）；
      · 一部分没有 frontmatter，一部分只有 tags，一部分用非白名单字段；
      · 有两篇同名 `风岬港.md`（跨目录重名）；
      · 缺 `01 索引/地理系统索引.md`（验证「索引缺失时提取会不会崩」）；
      · 只保留各一个硬编码目录，用来证明「扫到的不是 0，而是只剩这两篇」；
      · 带一张 1×1 PNG 和 `![[图.png]]`，验证阅读器的附件解析。

用法：
    python scripts/tests/fixtures/make_vault_fixture_messy.py            # 生成到 vault-fixture-messy/
    python scripts/tests/fixtures/make_vault_fixture_messy.py --out D:/X
    python scripts/tests/fixtures/make_vault_fixture_messy.py --force    # 覆盖已存在的目录

输出（建议入库；纯文本 + 1 个 1×1 PNG）：
    scripts/tests/fixtures/vault-fixture-messy/
"""
import argparse
import base64
import json
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(HERE, 'vault-fixture-messy')

# 1×1 透明 PNG（不是图片占位，是真的可解码 PNG）
TINY_PNG = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk'
    'YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
)

FILES = {
    # ── Obsidian 库标记：让 validateVaultPath 放行 ─────────────────────────
    '.obsidian/app.json': '{}\n',

    # ── 根目录散装 ────────────────────────────────────────────────────────
    'README.md': '# 这个库没有按任何模板摆放\n\n目录是随手建的。\n',
    '无标题.md': '没有标题、没有 frontmatter，只有一段话。\n',
    '空文件.md': '',

    # ── 人物 / 组织：完全没有 frontmatter 或只有 tags ─────────────────────
    '散装/人物/艾琳.md':
        '# 艾琳\n\n风岬港的灯塔守。与[[老陶]]相识，[[灰塔议会]]的人来找过她。\n',
    '散装/人物/老陶.md':
        '---\ntags:\n  - 人物\n  - 船匠\n---\n\n# 老陶\n\n在[[风岬港]]修船四十年。\n',
    '散装/组织/灰塔议会.md':
        '---\n名称: 灰塔议会\n别名:\n  - 灰塔\n  - 议会\ntags:\n  - 组织\n---\n\n'
        '# 灰塔议会\n\n控制[[风岬港]]的船运。与[[艾琳]]有过交易。\n',
    '散装/组织/无名者.md': '一个连名字都没有的组织。\n',

    # ── 地理：有 frontmatter，但父节点是悬空的 ────────────────────────────
    '地理/北境/北境.md':
        '---\n层级: 区域\n上层区域: "[[潮汐界]]"\n---\n\n# 北境\n\n[[风岬港]]所在的区域。\n',
    '地理/北境/风岬港.md':
        '---\n层级: 城市\n上层区域: "[[北境]]"\n地点类型: 商业\n---\n\n'
        '# 风岬港\n\n北境唯一的深水港。\n',
    # 跨目录重名：提取器只 console.warn，后出现的被忽略
    '别处/风岬港.md':
        '---\n层级: 城市\n地点类型: 军事\n---\n\n# 风岬港（另一份写法）\n\n这是个同名但不同设定的文件。\n',

    # ── 深层嵌套 / 只有 tags ──────────────────────────────────────────────
    'a/b/c/深林.md':
        '---\ntags:\n  - 地点\n  - 森林\n---\n\n# 深林\n\n没有层级字段。\n',
    'a/b/c/深林 副本.md': '# 深林 副本\n\n连 frontmatter 都没有。\n',
    '嵌套/一/二/三/四/五/深处.md':
        '---\n层级: 地点\n---\n\n# 深处\n\n五层目录下面的地点。\n',

    # ── 事件 / 物品 / 年表 / 剪报 ────────────────────────────────────────
    '事件/第三纪元/灰塔之变.md':
        '---\n层级: 事件\n时间: 第三纪元 812 年\n---\n\n'
        '# 灰塔之变\n\n[[灰塔议会]]在那一年分裂。\n',
    '事件/第三纪元/风岬港大火.md':
        '# 风岬港大火\n\n[[风岬港]]的码头烧了三天。\n',
    '物品/遗物/灰塔徽记.md':
        '---\n类别: 遗物\n---\n\n# 灰塔徽记\n\n[[灰塔议会]]的信物。\n',
    '年表/大年表.md':
        '# 大年表\n\n| 年份 | 事件 |\n|---|---|\n| 812 | [[灰塔之变]] |\n| 815 | [[风岬港大火]] |\n',
    '资料收藏/剪贴/一段剪报.md':
        '> 北境的港口今年第三次被封。\n\n没有 frontmatter，也不是地理词条。\n',

    # ── 附件：验证阅读器里的 ![[图.png]] ─────────────────────────────────
    '附件/图.png': TINY_PNG,
    '带附件/地图笔记.md':
        '---\n层级: 地点\n---\n\n# 地图笔记\n\n![[图.png]]\n\n指向[[风岬港]]与[[北境]]。\n',

    # ── 两个硬编码目录各放一篇：证明「不是扫到 0，是只剩这两篇」──────────
    '03 设定/11 地理系统/星域/假星域.md':
        '---\n层级: 星域\n---\n\n# 假星域\n\n唯一落在硬编码目录里的星域。\n',
    '03 设定/02 场景地点/某个地点.md':
        '---\n层级: 设施\n地点类型: 公共\n---\n\n# 某个地点\n\n唯一落在硬编码目录里的地点。\n',

    # ── 像索引但不是索引：验证「缺 01 索引/地理系统索引.md 会怎样」──────
    '01 索引/别的索引.md':
        '# 别的索引\n\n- [[假星域]]\n',

    # ── 非 Markdown 杂项 ────────────────────────────────────────────────
    '说明.txt': '这不是笔记，扫描时应忽略。\n',
}

MANIFEST = {
    'purpose': 'S0/T1-T2：验证「不听话的库」——乱目录、缺 frontmatter、跨目录重名、缺地理系统索引',
    'notesTotal': sum(1 for p in FILES if p.lower().endswith('.md')),
    'expect': {
        'hardcodedScanHits': [
            '03 设定/11 地理系统/星域/假星域.md',
            '03 设定/02 场景地点/某个地点.md',
        ],
        'duplicateBasenames': ['风岬港'],
        'noFrontmatter': [
            'README.md', '无标题.md', '散装/人物/艾琳.md', '散装/组织/无名者.md',
            'a/b/c/深林 副本.md', '事件/第三纪元/风岬港大火.md',
            '资料收藏/剪贴/一段剪报.md',
        ],
        'missingIndexFile': '01 索引/地理系统索引.md',
        'wikilinks': {
            '散装/人物/艾琳.md': ['老陶', '灰塔议会'],
            '带附件/地图笔记.md': ['图.png', '风岬港', '北境'],
        },
        'asset': '附件/图.png',
    },
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=DEFAULT_OUT)
    ap.add_argument('--force', action='store_true')
    args = ap.parse_args()
    out = os.path.abspath(args.out)

    if os.path.exists(out) and os.listdir(out):
        if not args.force:
            raise SystemExit('目标已存在且非空：%s（加 --force 覆盖）' % out)
        shutil.rmtree(out)

    for rel, content in FILES.items():
        full = os.path.join(out, *rel.split('/'))
        os.makedirs(os.path.dirname(full), exist_ok=True)
        mode = 'wb' if isinstance(content, bytes) else 'w'
        kwargs = {} if isinstance(content, bytes) else {'encoding': 'utf-8', 'newline': '\n'}
        with open(full, mode, **kwargs) as f:
            f.write(content)

    with open(os.path.join(out, '_fixture.json'), 'w', encoding='utf-8') as f:
        json.dump(MANIFEST, f, ensure_ascii=False, indent=2)
        f.write('\n')

    print('ok ->', out)
    print('  md =', MANIFEST['notesTotal'], ' files =', len(FILES) + 1)


if __name__ == '__main__':
    main()
