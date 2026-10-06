#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 86：用例里的 fixture 专名必须**按数据源解析**（`--real-data` 的可用性守卫）

来源：2026-10-06 定性 —— `--real-data` 的 19 个失败里 **17 个是"写死了合成 fixture 的专名"**
（`曜川星` / `曜川星系` / `归岚星域` / `叠翠原` …）。真实库里没有这些名字 → 用例集体假红，
于是 `--real-data` 只能做定向体检，当不了全绿闸门。

修法（本轮落地）：
    用例改写成 `A('曜川星')`（Python 侧）或 `__alias('曜川星')`（页面 JS 文本），
    由 harness 按数据源解析：
      · 合成 fixture 模式 → 恒等（行为零变化）
      · `--real-data`     → 换成真实库里的对应名字（`乐园星` …）
    对照表**唯一实现**在 `fixtures/make_vault_fixture.py` 的 `KEY_NAMES` / `NON_NODE_TERMS`
    （= 当初生成 fixture 时用的改名表），`fixtures/name_map.py` 只做反转。

本用例覆盖：
  g0 无待办 + 表完备：改写器对全部用例已无待办（= 没有裸专名）；每个被引用的名字都在对照表里
     —— 将来新增 fixture 专名却忘了登记，这里立刻红（而不是等 `--real-data` 才红）。
  g1 表一致性 + A() 两态：对照表确实来自生成器；`A()` 在 fixture 模式恒等、真实数据模式解析。
  g2 页面侧：`window.__alias` 存在、fixture 模式下恒等、且解析出的名字真在 store.nodes 里。
  g3 反向探针：把注入的表换掉后 `__alias` 必须跟着变 —— 否则 g2 只是"恒等函数的空转通过"。
"""

import io
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json  # noqa: E402
from lib.helpers import A, ensure_data_ready  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
CASES = os.path.join(ROOT, 'scripts', 'tests', 'cases')
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"

for _p in (os.path.join(ROOT, 'scripts', 'tests', 'tools'),
           os.path.join(ROOT, 'scripts', 'tests', 'fixtures')):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from name_map import FIXTURE_TO_REAL, KNOWN_FIXTURE_NAMES  # noqa: E402
import alias_fixture_names as alias_tool  # noqa: E402


# ══════════════════════════════════════════════════════════════════
# g0 用例里没有裸专名；引用到的名字都在对照表里
# ══════════════════════════════════════════════════════════════════
def _fixture_node_names():
    """合成 fixture 里的**节点名**（= 真实库的换名克隆）。

    判据用它而不是"所有 A()/__alias() 的字面量"：像 `不存在的名字` 这种**探针哨兵**本来就
    不该有真实对应物，不能算缺登记。
    """
    import json
    gd = json.load(io.open(os.path.join(ROOT, 'scripts', 'tests', 'fixtures', 'vault-fixture',
                                        'geodata.json'), encoding='utf-8'))
    return set(n['name'] for n in gd['nodes'])


def sub_no_bare_names(cdp):
    bad, used = [], set()
    fixture_names = _fixture_node_names()
    for fn in sorted(os.listdir(CASES)):
        if not (fn.startswith('test_') and fn.endswith('.py')):
            continue
        if fn == os.path.basename(__file__):
            # 本用例自己**故意**在探针里写裸名字（反向探针要传哨兵/表外名），不参与扫描
            continue
        path = os.path.join(CASES, fn)
        _src, edits, _left = alias_tool.plan_file(path)
        # 改写器只认「ASCII 引号包裹的 fixture 专名」。还有待办 = 又有裸专名写进来了。
        if edits:
            bad.append('%s 还有 %d 处裸专名（应写成 A(...) / __alias(...)）' % (fn, len(edits)))
        # 收集该文件实际引用到的名字，逐个检查是否有真实对应物
        src = io.open(path, encoding='utf-8').read()
        for m in re.finditer(r"\b(?:A|__alias)\((['\"])([^'\"]+)\1\)", src):
            used.add(m.group(2))
    # 只对「确实是 fixture 节点名、却没有真实对应物」报错 —— 那才是"忘登记"
    missing = sorted(n for n in used if n in fixture_names and n not in KNOWN_FIXTURE_NAMES)
    if missing:
        bad.append('这些 fixture 节点名没有"真实库对应名"（需补进 make_vault_fixture.KEY_NAMES）：%s' % missing)
    if bad:
        return False, '专名解析守卫失败：' + '；'.join(bad)
    return True, ('用例里 0 处裸专名（改写器无待办）+ 引用的 %d 个名字全部有真实库对应物' % len(used))


# ══════════════════════════════════════════════════════════════════
# g1 对照表来自生成器；A() 两态行为
# ══════════════════════════════════════════════════════════════════
def sub_table_and_A(cdp):
    import make_vault_fixture as gen
    bad = []
    # ① 单一事实源：name_map 的表就是生成器表的反转（不是另抄一份）
    want = {fake: real for real, fake in gen.KEY_NAMES.items()}
    want.update({fake: real for real, fake in gen.NON_NODE_TERMS.items()})
    if FIXTURE_TO_REAL != want:
        bad.append('name_map.FIXTURE_TO_REAL 与 make_vault_fixture 的改名表不一致（漂移了）')
    # ② A() 两态
    import lib.helpers as H
    keep = H.REAL_DATA
    try:
        H.set_real_data(False)
        if A('曜川星') != '曜川星':
            bad.append('fixture 模式下 A() 不是恒等（会让 85 个用例的行为发生变化）')
        H.set_real_data(True)
        if A('曜川星') != FIXTURE_TO_REAL['曜川星']:
            bad.append('真实数据模式下 A() 没有解析成真实名')
        if A('不存在的名字') != '不存在的名字':
            bad.append('A() 对表外名字应当原样返回（否则会静默改写无关文本）')
    finally:
        H.set_real_data(keep)
    if bad:
        return False, '对照表/A() 守卫失败：' + '；'.join(bad)
    return True, ('表与生成器同源（%d 条）｜fixture 模式恒等｜真实数据模式解析 曜川星→%s｜表外名字原样返回'
                  % (len(FIXTURE_TO_REAL), FIXTURE_TO_REAL.get('曜川星')))


# ══════════════════════════════════════════════════════════════════
# g2 页面侧：__alias 存在、恒等、解析出的名字真在 store 里
# ══════════════════════════════════════════════════════════════════
G2_JS = r"""(async () => {
  const fails = [];
  if (typeof window.__alias !== 'function') {
    return JSON.stringify({ fails: ['window.__alias 未注入（MOCK_SCRIPT 漏了）'] });
  }
  const s = __STORE__;
  const name = '曜川星';
  const table = window.__ALIAS__ || {};
  // 与数据源无关的判据：有表就解析、无表就恒等 —— 两种模式都必须满足。
  // （本用例跑在 --real-data 下时表是非空的，写死"必须恒等"会把守卫自己判红。）
  const expect = table[name] || name;
  if (window.__alias(name) !== expect) {
    fails.push('__alias 未按表解析：期望 ' + expect + '，得到 ' + window.__alias(name));
  }
  const hit = (s.nodes || []).some((n) => n.name === window.__alias(name));
  if (!hit) fails.push('解析出的名字在 store.nodes 里不存在：' + window.__alias(name));
  return JSON.stringify({ fails, alias: window.__alias(name), nodes: (s.nodes || []).length,
                          keys: Object.keys(window.__ALIAS__ || {}).length });
})()"""


def sub_page_alias(cdp):
    ok, res = eval_json(cdp, G2_JS.replace('__STORE__', STORE), desc='页面 __alias', required=('fails',))
    if not ok:
        return False, res
    if res['fails']:
        return False, '页面侧 __alias 断言失败：' + '；'.join(res['fails'])
    return True, ('__alias 已注入且恒等（%s → %s，store 里确有该节点，nodes=%d，注入表 %d 条）'
                  % ('曜川星', res['alias'], res['nodes'], res['keys']))


# ══════════════════════════════════════════════════════════════════
# g3 反向探针：表换了 __alias 必须跟着变
# ══════════════════════════════════════════════════════════════════
G3_JS = r"""(() => {
  const fails = [];
  const orig = window.__ALIAS__;
  try {
    window.__ALIAS__ = { '曜川星': '__不存在的哨兵__' };
    const got = window.__alias('曜川星');
    if (got !== '__不存在的哨兵__') {
      fails.push('__alias 没读 window.__ALIAS__（得到的还是 ' + got + '）→ g2 的"恒等"是空转通过');
    }
    const miss = window.__alias('表外名字');
    if (miss !== '表外名字') fails.push('表外名字被改写了：' + miss);
  } finally {
    window.__ALIAS__ = orig;
  }
  return JSON.stringify({ fails });
})()"""


def sub_reverse_probe(cdp):
    ok, res = eval_json(cdp, G3_JS, desc='__alias 反向探针', required=('fails',))
    if not ok:
        return False, res
    if res['fails']:
        return False, '反向探针失败：' + '；'.join(res['fails'])
    return True, '换掉注入表后 __alias 跟着变、表外名字原样通过 —— 不是恒等函数的空转'


# ══════════════════════════════════════════════════════════════════
def run(cdp):
    ensure_data_ready(cdp)
    results = []
    for name, fn in (('g0 无裸专名 + 表完备', sub_no_bare_names),
                     ('g1 表同源 + A() 两态', sub_table_and_A),
                     ('g2 页面 __alias', sub_page_alias),
                     ('g3 反向探针', sub_reverse_probe)):
        try:
            ok, detail = fn(cdp)
        except Exception as e:
            ok, detail = False, f'异常: {e}'
        results.append((name, ok, detail))

    failed = [f'{n}: {d}' for n, o, d in results if not o]
    if failed:
        return False, (f'fixture 专名解析 {len(results) - len(failed)}/{len(results)} 子测试通过；失败：\n    '
                       + '\n    '.join(failed))
    return True, ('fixture 专名解析 ' + f'{len(results)}/{len(results)} 全通过 — '
                  + '；'.join(d for _, _, d in results))
