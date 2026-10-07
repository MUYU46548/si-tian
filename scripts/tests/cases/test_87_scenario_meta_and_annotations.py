#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 87：剧本元信息可编辑 + 标注/标记可删除（两个"零调用死入口"接活）

来源：2026-10-07 复查「历史剧本模块到底能不能用」时，把 `scenarioEditing.js` 的 66 个导出
逐个对产品侧引用数了一遍，抓出三个**零调用的死入口**：

  🔴 `updateScenario`             —— 剧本的 名称 / 罗马数字 / 时代标签 / **起止年**
                                     建完就改不了：年份填错只能「删剧本重建」，
                                     而重建会连带丢掉 ownership / changeEvents / 标注 / 标记。
  ⚠️ `removeScenarioLabel`        —— 地名「只能加不能删」（只有一次性的撤销兜底）
  ⚠️ `removeScenarioMarker`       —— 标记同上

这类"声明了却没接 UI"的缺口在本项目已出过三次（`clearOwnership`、`batchSetOwnership`、本批），
所以本轮不只接活，还立一条**反向探针**（下面 f2）：FMG `.map` 导入的标注/标记**没有 id**
（`utils/azgaar-parser.js` 只造 `{x,y,text,size,color}` / `{x,y,name,type}`），
若删除写口按 id 匹配，`undefined === undefined` 会命中同类型的**第一条** ——
「点第 3 条删掉第 1 条」且不报错。故写口必须支持**下标**寻址，且撤销要放回**原位**。

本用例覆盖：
  f0 源码守卫：两个写口已被产品调用；支持「id 或下标」；撤销 splice 回原位；
     `MEMORY_WRITE_CALLSITES` 不许登记它们（走 execute 总闸门，登记了反而说明绕开了）；
     只读灰禁落在新按钮上。
  f1 端到端：走真实 UI（工具栏「剧本管理」→ 编辑 → 改名称/起止年 → 保存）→
     元信息真的变了、**已录内容（ownership / changeEvents / 标注 / 标记）一字未动**；undo 可还原。
  f2 反向探针：删掉**第 3 条（无 id）**必须是第三条消失，第一条照旧在（互为反面）。
  f3 写口有回执、零副作用：不存在的剧本 / 越界下标 → `{ok:false, reason}`，且列表一格不动。
"""

import io
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json  # noqa: E402
from lib.helpers import ensure_data_ready, open_toolbar_more  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
SM = 'src/renderer/src/components/ScenarioMap.vue'
SE = 'src/renderer/src/store/geodataModules/scenarioEditing.js'
WG = 'src/renderer/src/store/writeGate.js'


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
    sm = _code_only(_read(SM))
    se = _code_only(_read(SE))
    wg = _code_only(_read(WG))

    # ① 三个写口必须真的被产品调用（这就是"接活"本身）
    for call, why in (
        ('store.updateScenario(', '剧本元信息编辑没有接到 UI（updateScenario 仍是死入口）'),
        ('store.removeScenarioLabel(', '地名删除没有接到 UI（removeScenarioLabel 仍是死入口）'),
        ('store.removeScenarioMarker(', '标记删除没有接到 UI（removeScenarioMarker 仍是死入口）'),
    ):
        if call not in sm:
            bad.append(why)

    # ② 「id 或下标」双寻址 —— FMG 导入的条目没有 id，只按 id 匹配会误删第一条
    if 'typeof labelRef === \'number\'' not in se:
        bad.append('removeScenarioLabel 不支持下标寻址（无 id 的导入标签会被误删第一条）')
    if 'typeof markerRef === \'number\'' not in se:
        bad.append('removeScenarioMarker 不支持下标寻址（无 id 的导入标记会被误删第一条）')

    # ③ 撤销必须放回**原位**（splice 到 idx）而不是追加到表尾（顺序 = 渲染层叠顺序）
    if 'arr.splice(Math.min(idx, arr.length), 0, oldLabel)' not in se:
        bad.append('删除地名的撤销没有放回原位（改为 push 会让层叠顺序变化）')
    if 'arr.splice(Math.min(idx, arr.length), 0, oldMarker)' not in se:
        bad.append('删除标记的撤销没有放回原位')

    # ④ 这三个写口走的是 execute()（= 内存写总闸门），**不该**登记进 MEMORY_WRITE_CALLSITES
    #    （那条清单是"先改内存、后 execute"需要函数首行守卫的名单；登记了说明有人绕开了 execute）
    for name in ('updateScenario', 'removeScenarioLabel', 'removeScenarioMarker'):
        if name in wg:
            bad.append(f'{name} 被登记进 MEMORY_WRITE_CALLSITES（它走 execute，登记说明绕开了总闸门）')

    # ⑤ 只读灰禁要落在新按钮上（能力说明必须给去处，不能只是禁）
    for anchor in ('data-testid="scenario-edit"', 'data-testid="anno-del"'):
        i = sm.find(anchor)
        if i < 0:
            bad.append(f'找不到 {anchor}（新入口没落地）')
            continue
        seg = sm[i:i + 400]
        if ':disabled="store.isReadOnly"' not in seg:
            bad.append(f'{anchor} 没有只读灰禁')
        if 'readOnlyReason' not in seg:
            bad.append(f'{anchor} 的灰禁没有说明去处（readOnlyReason）')

    # ⑥ 反证：不可把"编辑"做成先把旧剧本删掉再新建（那会丢 ownership/changeEvents）
    if re.search(r'removeScenario\([^)]*\)\s*;\s*[\s\S]{0,200}?createScenario\(', sm):
        bad.append('编辑剧本被实现成"先删后建"（会丢 ownership/changeEvents）')

    if bad:
        return False, '源码守卫失败：' + '；'.join(bad)
    return True, '三个写口已接产品 UI + 支持 id/下标双寻址 + 撤销回原位 + 未绕开总闸门 + 只读灰禁带去处'


# ══════════════════════════════════════════════════════════════════
# 装置：造一个自己的底图 + 剧本（带已录内容），并进入剧本视图
# ══════════════════════════════════════════════════════════════════
SETUP_JS = r"""(async () => {
  const fails = [];
  const s = __STORE__;
  const sc = __SC__;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.confirm = () => true;   // 删除路径都带二次确认；headless 里没人点 → 必须打桩

  const KEY = '__case87basemap__';
  const SID = KEY + '/甲时代';
  window.__t87 = { KEY, SID };

  window.__t87.prevKey = sc.baseMapKey;
  sc.baseMapKey = KEY;
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: '用例87底图' });
  if (s.baseMaps[KEY]) s.baseMaps[KEY].burgs = [];   // 让 markers 派生的聚落路径不干扰本用例

  if (s.scenarios[SID]) s.removeScenario(SID);
  s.createScenario(SID, {
    ownerKey: KEY,
    name: '旧名',
    era: { roman: 'Ⅰ', label: '甲', startYear: '2000', endYear: '2010' },
    description: '原始描述',
    ownership: { p87a: 'pol87' },
    changeEvents: { p87a: [{ y: 2003, m: 6, d: 1, owner: 'pol87' }] },
    // 标注：第 1 条有 id（司天新建的形态），第 2/3 条没有 id（FMG .map 导入的形态）
    labels: [
      { id: 'L87A', x: 10, y: 10, text: '有id地名', size: 12, color: '#3c4150' },
      { x: 20, y: 20, text: '无id地名一', size: 12, color: '#3c4150' },
      { x: 30, y: 30, text: '无id地名二', size: 12, color: '#3c4150' },
    ],
    markers: [
      { id: 'M87A', x: 40, y: 40, name: '有id标记', type: 'capital' },
      { x: 50, y: 50, name: '无id标记', type: 'default' },
    ],
  });
  await wait(320);

  const made = s.getScenario(SID);
  if (!made) return JSON.stringify({ fails: ['造数失败：剧本没进 store'] });
  sc.selectScenario(made);
  await wait(120);

  // 打开「剧本管理」（入口在工具栏「更多」里）
  const btn = document.querySelector('.scenario-toolbar button[title="剧本管理"]');
  if (!btn) return JSON.stringify({ fails: ['工具栏里找不到「剧本管理」入口'] });
  btn.click();
  await wait(320);

  const dlg = document.querySelector('.scenario-manager');
  if (!dlg) fails.push('剧本管理对话框没打开');
  window.__t87.before = {
    labels: JSON.parse(JSON.stringify(made.labels || [])),
    markers: JSON.parse(JSON.stringify(made.markers || [])),
    ownership: JSON.parse(JSON.stringify(made.ownership || {})),
    changeEvents: JSON.parse(JSON.stringify(made.changeEvents || {})),
  };
  return JSON.stringify({ fails, baseMapKey: sc.baseMapKey, rows: document.querySelectorAll('.scenario-item').length });
})()"""


def _setup(cdp):
    # ① 先点「历史剧本」进入剧本视图（工具栏只在剧本视图里存在）
    cdp.eval(
        "(() => { const b = Array.from(document.querySelectorAll('button'))"
        ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()"
    )
    try:
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式挂载')
    except RuntimeError as e:
        return False, f'剧本模式未挂载：{e}'
    time.sleep(1.2)
    # ② 再展开「更多」（「剧本管理」入口在里面；本函数幂等）
    if not open_toolbar_more(cdp):
        return False, '工具栏「更多」没展开（剧本管理入口在里面）'
    ok, res = eval_json(cdp, SETUP_JS.replace('__STORE__', STORE).replace('__SC__', SC),
                        desc='装置：造剧本', required=('fails',))
    if not ok:
        return False, res
    if res['fails']:
        return False, '装置失败：' + '；'.join(res['fails'])
    return True, res


# ══════════════════════════════════════════════════════════════════
# f1 剧本元信息编辑（真实 UI 路径）
# ══════════════════════════════════════════════════════════════════
F1_JS = r"""(async () => {
  const fails = [];
  const notes = {};
  const s = __STORE__;
  const { KEY, SID, before } = window.__t87;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const setInput = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  // ① 点该剧本那一行的「编辑」
  const items = Array.from(document.querySelectorAll('.scenario-item'));
  const mine = items.find((it) => (it.textContent || '').includes('旧名'));
  if (!mine) return JSON.stringify({ fails: ['剧本列表里找不到造的那一条'] });
  const editBtn = mine.querySelector('[data-testid="scenario-edit"]');
  if (!editBtn) return JSON.stringify({ fails: ['剧本条上没有编辑按钮'] });
  editBtn.click();
  await wait(250);

  // ② 表单应被填成该剧本的现值（否则"编辑"是把新建表单当编辑用了）
  const form = document.querySelector('.new-scenario-form');
  if (!form) return JSON.stringify({ fails: ['找不到剧本表单'] });
  const inputs = Array.from(form.querySelectorAll('input'));
  const valOf = (ph) => { const el = inputs.find((x) => (x.placeholder || '').includes(ph)); return el ? el.value : null; };
  const filled = { name: valOf('第一时代'), roman: valOf('Ⅰ'), startYear: valOf('2006'), endYear: valOf('2008') };
  if (filled.name !== '旧名') fails.push('编辑时名称没有回填：' + JSON.stringify(filled));
  if (filled.startYear !== '2000' || filled.endYear !== '2010') fails.push('编辑时起止年没有回填：' + JSON.stringify(filled));
  if (!document.querySelector('[data-testid="scenario-save-edit"]')) fails.push('编辑态没有出现「保存」按钮');

  // ③ 改值 → 保存
  const nameEl = inputs.find((x) => (x.placeholder || '').includes('第一时代'));
  const syEl = inputs.find((x) => (x.placeholder || '').includes('2006'));
  const eyEl = inputs.find((x) => (x.placeholder || '').includes('2008'));
  setInput(nameEl, '新名');
  setInput(syEl, '1990');
  setInput(eyEl, '1995');
  await wait(60);
  document.querySelector('[data-testid="scenario-save-edit"]').click();
  await wait(320);

  const after = s.getScenario(SID);
  if (!after) return JSON.stringify({ fails: ['保存后剧本不见了'] });
  notes.name = after.name;
  notes.era = JSON.parse(JSON.stringify(after.era || {}));
  if (after.name !== '新名') fails.push('名称没改到：' + after.name);
  if (String(after.era.startYear) !== '1990' || String(after.era.endYear) !== '1995') {
    fails.push('起止年没改到：' + JSON.stringify(after.era));
  }
  // ④ 已录内容一字不许动（这是选"改字段"而不是"删了重建"的全部理由）
  if (JSON.stringify(after.ownership) !== JSON.stringify(before.ownership)) {
    fails.push('编辑元信息把省份归属动了：' + JSON.stringify(after.ownership));
  }
  if (JSON.stringify(after.changeEvents) !== JSON.stringify(before.changeEvents)) {
    fails.push('编辑元信息把易主日期动了：' + JSON.stringify(after.changeEvents));
  }
  if (JSON.stringify(after.labels) !== JSON.stringify(before.labels)) fails.push('编辑元信息把标注动了');
  if (JSON.stringify(after.markers) !== JSON.stringify(before.markers)) fails.push('编辑元信息把标记动了');
  // ⑤ 保存后退出编辑态（按钮回到"创建"、且不再是编辑态）
  if (document.querySelector('[data-testid="scenario-save-edit"]')) fails.push('保存后没有退出编辑态');
  if (!document.querySelector('[data-testid="scenario-create"]')) fails.push('保存后没回到「创建」按钮');

  // ⑥ 一条 undo 还原元信息
  s.undo();
  await wait(200);
  const back = s.getScenario(SID);
  notes.afterUndo = back ? { name: back.name, era: JSON.parse(JSON.stringify(back.era || {})) } : null;
  if (!back || back.name !== '旧名') fails.push('undo 没有还原名称：' + JSON.stringify(notes.afterUndo));
  else if (String(back.era.startYear) !== '2000' || String(back.era.endYear) !== '2010') {
    fails.push('undo 没有还原起止年：' + JSON.stringify(back.era));
  }
  s.redo();
  await wait(160);

  return JSON.stringify({ fails, notes });
})()"""


def sub_meta_edit(cdp):
    ok, res = eval_json(cdp, F1_JS.replace('__STORE__', STORE), desc='剧本元信息编辑', required=('fails',))
    if not ok:
        return False, res
    if res['fails']:
        return False, '剧本元信息编辑失败：' + '；'.join(res['fails'])
    n = res.get('notes', {})
    return True, (f"表单回填正确 → 保存后名称/起止年真的变了（{n.get('era')}）；"
                  f"ownership / changeEvents / 标注 / 标记一字未动；undo 复原为 {n.get('afterUndo')}")


# ══════════════════════════════════════════════════════════════════
# f2 反向探针：删「无 id」的第 3 条，必须是第 3 条消失（不是第 1 条）
# ══════════════════════════════════════════════════════════════════
F2_JS = r"""(async () => {
  const fails = [];
  const notes = {};
  const s = __STORE__;
  const { SID } = window.__t87;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.confirm = () => true;

  const texts = () => {
    const rows = Array.from(document.querySelectorAll('[data-testid="anno-label"] .anno-text'));
    return rows.map((r) => r.textContent.trim());
  };
  const textsM = () => {
    const rows = Array.from(document.querySelectorAll('[data-testid="anno-marker"] .anno-text'));
    return rows.map((r) => r.textContent.trim());
  };

  notes.listBefore = texts().concat(textsM());
  if (notes.listBefore.length !== 5) {
    return JSON.stringify({ fails: ['标注/标记清单一共应有 5 行，实际 ' + notes.listBefore.length], notes });
  }

  // ① 删「无id地名二」= 列表里的第 3 行（它没有 id）
  const rows = Array.from(document.querySelectorAll('[data-testid="anno-label"]'));
  const target = rows.find((r) => r.textContent.includes('无id地名二'));
  if (!target) return JSON.stringify({ fails: ['清单里找不到「无id地名二」'], notes });
  target.querySelector('[data-testid="anno-del"]').click();
  await wait(300);

  const afterDel = s.getScenario(SID).labels || [];
  notes.labelsAfter = afterDel.map((l) => l.text);
  if (afterDel.length !== 2) fails.push('删一条后应剩 2 条地名，实际 ' + afterDel.length);
  else if (afterDel[0].text !== '有id地名' || afterDel[1].text !== '无id地名一') {
    fails.push('🔴 删错了：无 id 的条目按下标寻址失败，误删了别的地名 → ' + JSON.stringify(notes.labelsAfter));
  }
  if (texts().length !== 2) fails.push('清单没有随删除刷新：' + JSON.stringify(texts()));

  // ② 删有 id 的标记（走 id 寻址那条路）
  const mrows = Array.from(document.querySelectorAll('[data-testid="anno-marker"]'));
  const mt = mrows.find((r) => r.textContent.includes('有id标记'));
  if (!mt) return JSON.stringify({ fails: ['清单里找不到「有id标记」'], notes });
  mt.querySelector('[data-testid="anno-del"]').click();
  await wait(300);
  const afterM = s.getScenario(SID).markers || [];
  notes.markersAfter = afterM.map((m) => m.name);
  if (afterM.length !== 1 || afterM[0].name !== '无id标记') {
    fails.push('🔴 删标记走 id 寻址失败：' + JSON.stringify(notes.markersAfter));
  }

  // ③ 两条 undo 必须**原位**复原（顺序 = 渲染层叠顺序）
  s.undo(); s.undo();
  await wait(260);
  const sc2 = s.getScenario(SID);
  notes.labelsUndo = (sc2.labels || []).map((l) => l.text);
  notes.markersUndo = (sc2.markers || []).map((m) => m.name);
  if (JSON.stringify(notes.labelsUndo) !== JSON.stringify(['有id地名', '无id地名一', '无id地名二'])) {
    fails.push('🔴 undo 没有原位还原地名顺序：' + JSON.stringify(notes.labelsUndo));
  }
  if (JSON.stringify(notes.markersUndo) !== JSON.stringify(['有id标记', '无id标记'])) {
    fails.push('🔴 undo 没有原位还原标记顺序：' + JSON.stringify(notes.markersUndo));
  }
  return JSON.stringify({ fails, notes });
})()"""


def sub_delete_annotations(cdp):
    ok, res = eval_json(cdp, F2_JS.replace('__STORE__', STORE), desc='标注/标记删除', required=('fails',))
    if not ok:
        return False, res
    if res['fails']:
        return False, '标注/标记删除失败：' + '；'.join(res['fails'])
    n = res.get('notes', {})
    return True, (f"删无 id 的第 3 条 → 剩余 {n.get('labelsAfter')}（第一条照旧在，未误删）；"
                  f"删有 id 标记 → {n.get('markersAfter')}；两条 undo 原位复原为 {n.get('labelsUndo')} / {n.get('markersUndo')}")


# ══════════════════════════════════════════════════════════════════
# f3 写口有回执、零副作用（不许静默 return）
# ══════════════════════════════════════════════════════════════════
F3_JS = r"""(() => {
  const fails = [];
  const s = __STORE__;
  const { SID } = window.__t87;
  const snap = () => JSON.stringify({
    l: s.getScenario(SID).labels, m: s.getScenario(SID).markers,
  });
  const before = snap();

  const r1 = s.removeScenarioLabel('不存在的剧本', 'x');
  if (!r1 || r1.ok !== false || r1.reason !== 'no-scenario') {
    fails.push('不存在的剧本没有回执 no-scenario：' + JSON.stringify(r1));
  }
  const r2 = s.removeScenarioLabel(SID, 999);
  if (!r2 || r2.ok !== false || r2.reason !== 'no-target') {
    fails.push('越界下标没有回执 no-target：' + JSON.stringify(r2));
  }
  const r3 = s.removeScenarioMarker(SID, '不存在的id');
  if (!r3 || r3.ok !== false || r3.reason !== 'no-target') {
    fails.push('不存在的标记 id 没有回执 no-target：' + JSON.stringify(r3));
  }
  const r4 = s.removeScenarioLabel(SID, 0);
  if (!r4 || r4.ok !== true) fails.push('正常删除没有回执 ok:true：' + JSON.stringify(r4));

  const afterFail = snap();
  // 三次失败调用必须是零副作用（只允许第 4 次那次成功删除生效）
  const bL = JSON.parse(before).l, aL = JSON.parse(afterFail).l;
  if (aL.length !== bL.length - 1) fails.push('失败调用产生了副作用：地名 ' + bL.length + ' → ' + aL.length);
  if (JSON.stringify(aL) !== JSON.stringify(bL.slice(1))) {
    fails.push('删的不是第 0 条：' + JSON.stringify(aL.map((x) => x.text)));
  }
  s.undo();
  return JSON.stringify({ fails, sample: { r1, r2, r3, r4 } });
})()"""


def sub_result_contract(cdp):
    ok, res = eval_json(cdp, F3_JS.replace('__STORE__', STORE), desc='写口回执', required=('fails',))
    if not ok:
        return False, res
    if res['fails']:
        return False, '写口回执断言失败：' + '；'.join(res['fails'])
    return True, '不存在剧本 / 越界下标 / 不存在 id 三种情况都给出可读回执且零副作用（不再静默 return）'


# ══════════════════════════════════════════════════════════════════
CLEANUP_JS = r"""(() => {
  const s = __STORE__;
  const t = window.__t87 || {};
  const sc = __SC__;
  try {
    sc.baseMapKey = t.prevKey != null ? t.prevKey : null;
    if (t.SID && s.scenarios[t.SID]) s.removeScenario(t.SID);
    if (t.KEY && s.baseMaps[t.KEY]) delete s.baseMaps[t.KEY];
  } catch (e) { return 'cleanup-err:' + e.message; }
  return 'ok';
})()"""


def run(cdp):
    ensure_data_ready(cdp)
    results = []

    try:
        ok, detail = sub_source_guards(cdp)
    except Exception as e:
        ok, detail = False, f'异常: {e}'
    results.append(('f0 源码守卫', ok, detail))

    setup_ok, setup_detail = _setup(cdp)
    if not setup_ok:
        results.append(('f1 剧本元信息编辑', False, setup_detail))
        results.append(('f2 标注/标记删除', False, setup_detail))
        results.append(('f3 写口回执', False, setup_detail))
    else:
        for name, fn in (('f1 剧本元信息编辑', sub_meta_edit),
                         ('f2 标注/标记删除', sub_delete_annotations),
                         ('f3 写口回执', sub_result_contract)):
            try:
                ok, detail = fn(cdp)
            except Exception as e:
                ok, detail = False, f'异常: {e}'
            results.append((name, ok, detail))
        try:
            cdp.eval(CLEANUP_JS.replace('__STORE__', STORE).replace('__SC__', SC))
        except Exception:
            pass

    failed = [f'{n}: {d}' for n, o, d in results if not o]
    if failed:
        return False, (f'剧本元信息与标注 {len(results) - len(failed)}/{len(results)} 子测试通过；失败：\n    '
                       + '\n    '.join(failed))
    return True, ('剧本元信息与标注 ' + f'{len(results)}/{len(results)} 全通过 — '
                  + '；'.join(d for _, _, d in results))
