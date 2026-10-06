#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 84：剧本「隐式载入」的优先级 —— 知识库缓存只补缺，不许覆盖项目

来源：2026-10-06 审「历史剧本能不能真用」时读代码抓出的**静默数据毁伤**。

缺陷原貌（修复前）：
  `App.enterScenarioMode()`（点「历史剧本」）无条件
  `sitianAPI.loadScenarios()` → `store.importFromScenariosJson(data)`，
  而后者走的是 `applyScenarioState(data, {fresh:false})` 的**默认合并** `{...旧, ...新}`
  —— **新值赢**。项目态下画布事实源是项目文件，于是：
    ① 库里同名的剧本**整体替换**项目里那一份（用户改过的 ownership / changeEvents /
       势力谱系 / 标注 / 标记全没了）；
    ② 库里同名的**底图**同样被替换（用户在司天里画过的省份、涂过的地形全没了）；
    ③ 紧接着 `saveScenarios()` 把覆盖结果推给项目并落盘 = **不可逆**。
  触发时机还是最坏的那种：**每次启动后第一次点「历史剧本」**（`restoreLastProject` 打开项目、
  WorldSelector 上就摆着那个按钮）。

修法（本用例守的契约）：
  · `applyScenarioState(data, { fillMissingOnly: true })` = **内存里已有的优先，只补缺**；
  · 「同 key 覆盖」保留给**显式**动作（剧本工具栏「导入剧本数据（合并：同 key 覆盖）」）；
  · 无事可补时**保持原引用**（`changed:false`）→ 调用方不再排一次保存，
    避免每次进「历史剧本」都把项目标脏 + 触发写盘与备份轮转。

本用例覆盖：
  f0 源码守卫：隐式载入必须传 `fillMissingOnly`；装载口必须支持该语义且保留「新值赢」的显式分支；
     切片点在补缺语义下不许被塞进来。
  f1 端到端（项目态，反向探针在此）：先造「项目里已编辑过的剧本 + 底图」，再把同名旧值塞进
     知识库桩 → 点「历史剧本」→ 项目值必须**原样活着**，库里独有的剧本必须被补进来，
     且确实读了库（调用计数 = 1，排除「干脆不读」的空转通过）。
  f2 显式导入仍是「新值赢」（证明两种语义没有被合并成一种）。
  f3 无事可补时是纯 no-op（引用不变 + 没有排保存），执行一次 `changed:false`。
"""

import io
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json  # noqa: E402
from lib.helpers import ensure_data_ready  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SE = 'src/renderer/src/store/geodataModules/scenarioEditing.js'
APP = 'src/renderer/src/App.vue'


def _read(rel):
    return io.open(os.path.join(ROOT, rel), encoding='utf-8').read()


def _code_only(src):
    """剥掉注释后再判子串 —— 本仓五次踩到「注释里的字样被当成实现」。"""
    src = re.sub(r'<!--.*?-->', '', src, flags=re.S)
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    return re.sub(r'(?m)//[^\n]*', '', src)


# ══════════════════════════════════════════════════════════════════
# f0 源码守卫
# ══════════════════════════════════════════════════════════════════
def sub_source_guards(cdp):
    bad = []
    app = _code_only(_read(APP))
    se = _code_only(_read(SE))

    # ① 隐式载入必须显式要求「只补缺」
    if 'fillMissingOnly: true' not in app:
        bad.append('App.vue 的隐式载入没有传 fillMissingOnly: true（会覆盖项目里的剧本与底图）')
    m = re.search(r'importFromScenariosJson\(result\.data([^)]*)\)', app)
    if not m or 'fillMissingOnly' not in m.group(1):
        bad.append('enterScenarioMode 调的 importFromScenariosJson 没带 fillMissingOnly')

    # ② 装载口要同时保留三种语义（真值表不许被简化成两种）
    if 'fillMissingOnly = false' not in se:
        bad.append('applyScenarioState 没有 fillMissingOnly 形参')
    if '{ ...scenarios.value, ...migrated }' not in se.replace(' ', ' ').replace('  ', ' '):
        # 允许空白差异：退一步用更宽松的判据
        if not re.search(r'\{\s*\.\.\.scenarios\.value\s*,\s*\.\.\.migrated\s*\}', se):
            bad.append('「新值赢」的显式合并分支被删了（显式导入会被改成补缺）')
    if not re.search(r'importFromScenariosJson\(data,\s*opts\s*=\s*\{\}\)', se):
        bad.append('importFromScenariosJson 没有 opts 透传（调用方无法选语义）')

    # ③ 补缺语义下不许碰切片点（书签的家是项目文件，不是知识库缓存）
    if 'if (!fillMissingOnly) {' not in se:
        bad.append('补缺语义下没有把切片点排除在外')

    # ④ 无事可补必须保持原引用（否则每次进「历史剧本」都会排一次写盘）
    if 'changed: baseMaps.value !== prevBaseMaps' not in se:
        bad.append('applyScenarioState 没有 changed 回报（调用方无法判「要不要排保存」）')
    if "r.changed !== false) saveScenarios();" not in se:
        bad.append('importFromScenariosJson 没有按 changed 决定是否排保存')

    # ⑤ 反证：不许有人把隐式载入改成「干脆不读库」（那会丢掉库里独有的剧本）
    if re.search(r'if\s*\(\s*!?\s*canvasIsProject[^)]*\)\s*\{\s*const result = await window\.sitianAPI\.loadScenarios', app):
        bad.append('隐式载入被改成「项目态直接不读库」（库里独有的剧本就再也进不来了）')

    if bad:
        return False, '源码守卫失败：' + '；'.join(bad)
    return True, ('隐式载入要求只补缺 + 装载口三语义齐备 + 切片点隔离 + changed 回报 + 未退化成"不读库"')


# ══════════════════════════════════════════════════════════════════
# f1 端到端：项目值必须活着，库里独有的必须补进来
# ══════════════════════════════════════════════════════════════════
F1_JS = r"""(async () => {
  const fails = [];
  const s = __STORE__;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ① 造「项目里已编辑过的剧本与底图」—— 走真实装载口（fresh = 打开项目的语义）
  s.applyScenarioState({
    baseMaps: { desite: { name: '项目底图', marker: 'PROJECT', provinces: [{ id: 'p84' }] } },
    scenarios: {
      'desite/甲王朝': {
        id: 'A84', name: '甲王朝', order: 1,
        ownership: { p84: 'ME' },
        changeEvents: { p84: [{ y: 2001, m: 6, d: 1, owner: 'ME' }] },
        marker: 'PROJECT',
      },
    },
  }, { fresh: true });
  await wait(200);

  const projScenarioRef = s.scenarios['desite/甲王朝'];
  const projBaseRef = s.baseMaps.desite;
  if (!projScenarioRef || !projBaseRef) {
    return JSON.stringify({ fails: ['造数失败：项目侧剧本/底图没进内存'] });
  }

  // ② 知识库缓存里放**同名旧值** + 一个项目里没有的剧本 + 一条书签
  window.__scenarioVaultStub = {
    version: 2,
    baseMaps: { desite: { name: '库底图', marker: 'VAULT' } },
    scenarios: {
      'desite/甲王朝': { id: 'A84', name: '甲王朝', order: 1, ownership: { p84: 'OLD' }, marker: 'VAULT' },
      'desite/乙王朝': { id: 'B84', name: '乙王朝', order: 2, ownership: { p84: 'NEW-ONLY-IN-VAULT' }, marker: 'VAULT-ONLY' },
    },
    slicePoints: [{ id: 'sp84', label: '库里的书签', y: 1999, m: null, d: null }],
  };
  window.__scenarioLoadCalls = 0;

  // ③ 点「历史剧本」—— 走的是产品自己的入口，不是直接调函数
  const btn = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').includes('历史剧本'));
  if (!btn) return JSON.stringify({ fails: ['世界选择页上找不到「历史剧本」按钮'] });
  btn.click();
  await wait(900);

  // ④ 断言
  if (window.__scenarioLoadCalls !== 1) {
    fails.push(`知识库读取次数应为 1，实际 ${window.__scenarioLoadCalls}（= 断言空转：根本没读库）`);
  }
  const cur = s.scenarios['desite/甲王朝'];
  if (!cur) fails.push('同名剧本被整条删掉了');
  else {
    if (cur.marker !== 'PROJECT') fails.push(`🔴 项目剧本被知识库覆盖：marker=${cur.marker}`);
    if (!cur.ownership || cur.ownership.p84 !== 'ME') {
      fails.push(`🔴 项目剧本归属被覆盖：${JSON.stringify(cur.ownership)}`);
    }
    const ev = (cur.changeEvents || {}).p84;
    if (!Array.isArray(ev) || !ev.length || ev[0].owner !== 'ME') {
      fails.push(`🔴 项目剧本易主事件被覆盖：${JSON.stringify(ev)}`);
    }
    if (cur !== projScenarioRef) fails.push('同名剧本对象被换掉了（引用变了 = 后续编辑会脱钩）');
  }
  const bm = s.baseMaps.desite;
  if (!bm) fails.push('底图被整条删掉了');
  else {
    if (bm.marker !== 'PROJECT') fails.push(`🔴 项目底图被知识库覆盖：marker=${bm.marker}`);
    if (bm !== projBaseRef) fails.push('底图对象被换掉了');
  }

  const only = s.scenarios['desite/乙王朝'];
  if (!only) fails.push('库里独有的剧本没有被补进来（只补缺退化成"什么都不做"）');
  else if (only.marker !== 'VAULT-ONLY') fails.push(`补进来的剧本内容不对：${only.marker}`);

  const sp = (s.slicePoints || []).find((x) => x.id === 'sp84');
  if (sp) fails.push('知识库缓存里的书签被塞进了项目（切片点是项目级的）');

  return JSON.stringify({ fails, calls: window.__scenarioLoadCalls, keys: Object.keys(s.scenarios) });
})()"""


def sub_project_wins(cdp):
    ensure_data_ready(cdp)
    expr = F1_JS.replace('__STORE__', STORE)
    ok, res = eval_json(cdp, expr, desc='隐式载入优先级', required=('fails',))
    if not ok:
        return False, res
    if res['fails']:
        return False, '隐式载入优先级断言失败：' + '；'.join(res['fails'])
    return True, (f"项目剧本/底图原样存活（引用未换）+ 库里独有的剧本已补入 + 读了库 1 次；"
                  f"当前剧本键 {res.get('keys')}")


# ══════════════════════════════════════════════════════════════════
# f2 显式导入仍是「新值赢」
# ══════════════════════════════════════════════════════════════════
def sub_explicit_still_overwrites(cdp):
    expr = """(async () => {
      const fails = [];
      const s = __STORE__;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const before = s.scenarios['desite/甲王朝'];
      if (!before) return JSON.stringify({ fails: ['上一段之后同名剧本不在了'] });
      // 显式导入（不传 fillMissingOnly）—— 用户明确按下「导入剧本数据（合并：同 key 覆盖）」的语义
      s.importFromScenariosJson({
        scenarios: { 'desite/甲王朝': { id: 'A84', name: '甲王朝', marker: 'EXPLICIT' } },
      });
      await wait(250);
      const after = s.scenarios['desite/甲王朝'];
      if (!after) fails.push('显式导入后同名剧本消失');
      else if (after.marker !== 'EXPLICIT') {
        fails.push(`显式导入没有覆盖：marker=${after.marker}（两种语义被合并成一种了）`);
      }
      return JSON.stringify({ fails, marker: after && after.marker });
    })()""".replace('__STORE__', STORE)
    ok, res = eval_json(cdp, expr, desc='显式导入仍为新值赢', required=('fails',))
    if not ok:
        return False, res
    if res['fails']:
        return False, '显式导入语义断言失败：' + '；'.join(res['fails'])
    return True, f"显式导入仍为「同 key 覆盖」（marker={res.get('marker')}）—— 两种语义确实分开"


# ══════════════════════════════════════════════════════════════════
# f3 无事可补 = 纯 no-op（引用不变 + 不排保存）
# ══════════════════════════════════════════════════════════════════
def sub_noop_when_nothing_missing(cdp):
    expr = """(() => {
      const fails = [];
      const s = __STORE__;
      const scenRef = s.scenarios;
      const baseRef = s.baseMaps;
      // 与内存完全同键的「库」——无事可补
      const r = s.applyScenarioState({
        baseMaps: { desite: { name: '库底图', marker: 'VAULT' } },
        scenarios: { 'desite/甲王朝': { id: 'A84', name: '甲王朝', marker: 'VAULT' } },
      }, { fillMissingOnly: true });
      if (!r || r.ok !== true) fails.push('装载口没返回 ok');
      if (r && r.changed !== false) fails.push('无事可补却报了 changed=true（会白排一次写盘）');
      if (s.scenarios !== scenRef) fails.push('无事可补却换了 scenarios 引用（项目会被标脏）');
      if (s.baseMaps !== baseRef) fails.push('无事可补却换了 baseMaps 引用');
      if (s.scenarios['desite/甲王朝'].marker !== 'EXPLICIT') {
        fails.push('无事可补时值仍被改了：' + s.scenarios['desite/甲王朝'].marker);
      }
      return JSON.stringify({ fails });
    })()""".replace('__STORE__', STORE)
    ok, res = eval_json(cdp, expr, desc='无事可补=no-op', required=('fails',))
    if not ok:
        return False, res
    if res['fails']:
        return False, 'no-op 断言失败：' + '；'.join(res['fails'])
    return True, '无事可补时引用不变、changed=false、值不被改（不会白排写盘）'


# ══════════════════════════════════════════════════════════════════
def run(cdp):
    ensure_data_ready(cdp)
    results = []
    for name, fn in (('f0 源码守卫', sub_source_guards),
                     ('f1 项目值优先', sub_project_wins),
                     ('f2 显式导入仍覆盖', sub_explicit_still_overwrites),
                     ('f3 无事可补=no-op', sub_noop_when_nothing_missing)):
        try:
            ok, detail = fn(cdp)
        except Exception as e:
            ok, detail = False, f'异常: {e}'
        results.append((name, ok, detail))

    failed = [f'{n}: {d}' for n, o, d in results if not o]
    if failed:
        return False, (f'剧本隐式载入优先级 {len(results) - len(failed)}/{len(results)} 子测试通过；失败：\n    '
                       + '\n    '.join(failed))
    return True, ('剧本隐式载入优先级 ' + f'{len(results)}/{len(results)} 全通过 — '
                  + '；'.join(d for _, _, d in results))
