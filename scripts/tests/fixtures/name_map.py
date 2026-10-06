#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fixture 名 ↔ 真实库名 对照（**单一事实源的下游**，2026-10-06）

为什么要它：
    用例里写的是**合成 fixture 的名字**（`曜川星` / `归岚星域` / `叠翠原` …），而
    `--real-data` 把数据源换成真实知识库 —— 那些名字在真实库里不存在 → 用例集体假红。
    2026-10-06 的定性结论：`--real-data` 的 19 个失败里 **17 个是"写死了 fixture 专名"**。
    于是 `--real-data` 只能做定向体检，当不了全绿闸门。

做法（刻意**不**去改真实数据）：
    本仓 **节点 id == 归一化后的名字**（`utils/normalizeId.js`），所以"把真实数据改名成 fixture 名"
    要级联 9 个容器 + 4 个字典键（见 `store/geodata.js` 的引用清单）—— 风险远高于收益。
    改为**在用例侧解析名字**：harness 把「生成 fixture 时用的改名表」反过来，
    用例用 `A('曜川星')`（Python）/ `__alias('曜川星')`（页面 JS）取"当前数据源里的那个名字"：
      · 合成 fixture 模式 → 原样返回（行为零变化）
      · --real-data 模式 → 返回真实库里的对应名字

表本体在 `make_vault_fixture.py`（唯一实现，那里是对照两份数据的唯一权威），本模块只做反转。
`test_86` 守卫：两者不许漂移，且用例里不许再出现裸的 fixture 专名。
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

# 唯一实现：生成 fixture 时的改名表（真实名 → fixture 名）
from make_vault_fixture import KEY_NAMES, NON_NODE_TERMS  # noqa: E402

# fixture 名 → 真实名（harness 用它把用例里的名字解析到当前数据源）
FIXTURE_TO_REAL = {fake: real for real, fake in KEY_NAMES.items()}
FIXTURE_TO_REAL.update({fake: real for real, fake in NON_NODE_TERMS.items()})

# 用例可能引用的全部 fixture 专名（有真实对应物 = 可解析）
KNOWN_FIXTURE_NAMES = set(FIXTURE_TO_REAL)

__all__ = ['KEY_NAMES', 'NON_NODE_TERMS', 'FIXTURE_TO_REAL', 'KNOWN_FIXTURE_NAMES']
