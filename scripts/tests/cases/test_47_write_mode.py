#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 47：单一写闸门（Phase 2 决策 1 的机制）

用户决策（2026-09-18）：默认事实源 = 「有项目文件用项目文件；无项目时回退 Obsidian」，
但**无项目状态下必须只读** —— 禁止一切落盘写操作（不写散文件、不写回 Obsidian）。

为什么需要这道闸门：世界观数据的落盘入口有 11 个（拖拽自动保存、剧本、行星地图、重提取、
库内配置、draft 转正新建 .md、批量导入、清缓存…）。分散判断必漏，且漏了**不报错** ——
用户以为在只读浏览，其实已经写回知识库。所以统一过 `guardWrite()`。

本用例守五件事：
  a) 模块语义：三种模式、默认模式由常量推导（翻默认值时不红）、非法模式被拒、guardWrite 返回值形状
  b) 落盘守卫端到端：只读态下 saveGeodata / saveMapData / saveScenarios / reextract /
     库内配置写入**都不能真正调用 IPC**，且自动保存定时器不起；切回可写后恢复
  c) 只读徽标常驻可见（含「打开项目后即可编辑」的能力说明 —— 能力不减纪律）
  d) projectStore 联动：打开项目 → project 模式；关闭 → 回到无项目默认模式
  e) 源码契约：writeGate 里的 11 条落盘入口清单，标记 guarded 的必须在对应文件里真有守卫
  f) 只读态 UI 灰禁（Phase 2.4）：转正 / 批量导入 / 清缓存 三处入口必须灰禁 + 给出原因
     （只拦不灰禁 = 用户点完才被拒，属坏交互；能力说明必须保留）
"""
import sys, os, json, re
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
APP = "document.querySelector('#app').__vue_app__"
STORE = f"{APP}._instance.setupState.store"


def _j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def _read(rel):
    with open(os.path.join(ROOT, rel), 'r', encoding='utf-8') as f:
        return f.read()


# ─────────────────────────────────────────────────────────────
# a) 模块语义
# ─────────────────────────────────────────────────────────────
GATE_JS = """(async () => {
  const G = await import('/src/store/writeGate.js');
  const fails = [];
  const ck = (label, cond, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); };
  const same = (label, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(label + ' → got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); };

  // 三模式常量
  same('WRITE_MODES', G.WRITE_MODES, ['project', 'legacy', 'readonly']);
  // 「无项目」默认模式由常量推导：用 resetWriteMode()（closeProject 走的同一条路）验证契约，
  // 不能读当前 mode —— 用例跑在 harness 基线项目里，当前 mode 是 'project'。
  G.resetWriteMode();
  same('无项目默认模式由常量推导', G.describeWriteGate().mode, G.READONLY_WITHOUT_PROJECT ? 'readonly' : 'legacy');
  ck('终态：无项目 = 只读', G.READONLY_WITHOUT_PROJECT === true && G.isReadOnly.value === true, G.describeWriteGate());

  // 非法模式被拒且不改状态
  const before = G.describeWriteGate().mode;
  const bad = G.setWriteMode('wirteonly');
  ck('非法模式被拒', bad.ok === false, bad);
  same('非法模式不改状态', G.describeWriteGate().mode, before);

  // guardWrite 返回值形状（三种模式）
  G.setWriteMode('project', '测试：项目');
  const g1 = G.guardWrite('保存');
  ck('project 允许写', g1.ok === true && g1.error === undefined, g1);
  ck('project 非只读', G.isReadOnly.value === false && G.canWrite() === true);
  G.setWriteMode('legacy', '测试：兼容');
  ck('legacy 允许写', G.guardWrite('保存').ok === true);
  G.setWriteMode('readonly', '');
  const g2 = G.guardWrite('保存地理数据');
  ck('readonly 拒绝写', g2.ok === false && g2.readOnly === true, g2);
  ck('拒绝信息含动作名', String(g2.error).indexOf('保存地理数据') >= 0, g2.error);
  ck('拒绝信息含只读说明', String(g2.error).indexOf('只读') >= 0, g2.error);
  ck('readonly → isReadOnly', G.isReadOnly.value === true && G.canWrite() === false);
  ck('默认只读原因含能力说明', G.writeModeReason.value.indexOf('打开项目后即可继续编辑') >= 0, G.writeModeReason.value);
  ck('徽标文案', G.READONLY_BADGE.indexOf('只读') >= 0, G.READONLY_BADGE);

  // setWriteMode 传入原因 → 覆盖默认原因；空原因 → 回落默认
  G.setWriteMode('project', '项目 X');
  same('自定义原因生效', G.writeModeReason.value, '项目 X');
  G.setWriteMode('readonly', '');
  ck('空原因回落默认', G.writeModeReason.value.indexOf('只读') >= 0, G.writeModeReason.value);

  // 落盘入口清单形状
  const list = G.WRITE_CALLSITES;
  ck('清单 11 条', list.length === 11, list.length);
  same('清单 id 连续', list.map(x => x.id), [1,2,3,4,5,6,7,8,9,10,11]);
  ck('每条含 file/marker/what', list.every(x => x.file && x.marker && x.what && typeof x.guarded === 'boolean'));

  G.setWriteMode('project', '用例复位（harness 基线项目已打开）');
  return JSON.stringify({ fails: fails, callsites: list });
})()"""


def sub_module(cdp):
    ok, res = eval_json(cdp, GATE_JS, desc='writeGate')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        return False, f'writeGate 断言失败 {len(fails)} 项：' + '；'.join(fails[:8])
    return True, '三模式语义 / 默认由常量推导 / 非法模式被拒 / 拒绝信息含能力说明 / 11 条入口清单形状正确'


# ─────────────────────────────────────────────────────────────
# b) 落盘守卫端到端（只读态下 IPC 调用次数必须为 0）
# ─────────────────────────────────────────────────────────────
GUARD_JS = """(async () => {
  const G = await import('/src/store/writeGate.js');
  const LS = await import('/src/utils/labelStyles.js');
  const MT = await import('/src/utils/markerTypes.js');
  const s = @STORE@;
  const fails = [];
  const ck = (label, cond, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); };
  const same = (label, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(label + ' → got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); };

  // 计数桩：记录每个 IPC 被真正调用了几次
  const names = ['saveGeodata', 'saveMapData', 'saveScenarios', 'reextractGeodata', 'setSitianConfig'];
  const calls = {};
  for (const n of names) {
    calls[n] = 0;
    const orig = window.sitianAPI[n];
    window.sitianAPI[n] = async (...args) => { calls[n] += 1; return orig ? orig(...args) : { success: true }; };
  }
  const total = () => names.reduce((a, n) => a + calls[n], 0);

  // ---- 只读态：5 条路径全部拒绝，且 IPC 零调用 ----
  G.setWriteMode('readonly', '');
  same('store 暴露只读态', s.isReadOnly, true);
  ck('store 暴露提示文案', String(s.writeBlockedHint).indexOf('只读') >= 0, s.writeBlockedHint);

  const r1 = await s.saveGeodata();
  ck('saveGeodata 被拒', r1 && r1.ok === false && r1.readOnly === true, r1);
  const r2 = await s.saveMapData('__gate_test__', { planetId: '__gate_test__' });
  ck('saveMapData 被拒', r2 && r2.ok === false && r2.readOnly === true, r2);
  const r3 = await s.saveScenarios();
  ck('saveScenarios 被拒', r3 && r3.ok === false && r3.readOnly === true, r3);
  const r4 = await s.reextract();
  ck('reextract 被拒', r4 && r4.ok === false && r4.readOnly === true, r4);
  const beforeCfg = calls.setSitianConfig;
  await LS.saveToVault();
  MT.addMarkerType({ label: '门测试类型', icon: 'flag', color: '#123456' });
  await new Promise(r => setTimeout(r, 80));
  same('库内配置写入被拦（标签预设 + 标记类型）', calls.setSitianConfig, beforeCfg);
  same('只读态下 IPC 总调用次数为 0', total(), 0);

  // 只读态下 scheduleAutoSave 不得起定时器
  s.scheduleAutoSave();
  s.scheduleAutoSaveMap('__gate_test__');
  await new Promise(r => setTimeout(r, 1200));
  same('只读态自动保存未触发 IPC', total(), 0);

  // ---- 切回可写：同样的调用必须真正落盘 ----
  // ⚠️ 决策 1 终态下「无项目」只有只读一条路 → 可写态只能在**已打开项目**时出现
  //    （harness 已打开基线项目，所以 mode 必须与画布事实源一致：'project'）。
  //    'legacy' 只是历史模式，本用例不再用它伪造可写态 —— 那会造出生产不存在的状态。
  G.setWriteMode('project', '');
  const savesBefore = (window.__savedProject || []).length;
  const w1 = await s.saveGeodata();
  ck('可写态 saveGeodata 放行', !(w1 && w1.ok === false), w1);
  same('项目模式：画布保存走项目文件，不再写知识库缓存（无双写）', calls.saveGeodata, 0);
  await window.__probe.flushProject();
  ck('画布保存真的落到项目文件', (window.__savedProject || []).length > savesBefore,
     (window.__savedProject || []).length);
  await LS.saveToVault();
  ck('可写态配置写入放行', calls.setSitianConfig > beforeCfg, calls.setSitianConfig);

  // ---- 只读/可写来回切换（闸门不是单向开关）----
  G.setWriteMode('readonly', '');
  const savesBeforeRo = (window.__savedProject || []).length;
  const r5 = await s.saveGeodata();
  ck('再次只读仍拒绝', r5 && r5.ok === false, r5);
  await new Promise(r => setTimeout(r, 300));
  same('只读态不再新增项目落盘', (window.__savedProject || []).length, savesBeforeRo);
  G.setWriteMode('project', '');

  return JSON.stringify({ fails: fails, calls: calls });
})()""".replace('@STORE@', STORE)


def sub_guard(cdp):
    ok, res = eval_json(cdp, GUARD_JS, desc='落盘守卫')
    if not ok:
        return False, res
    if res.get('aborted'):
        return False, f'落盘守卫前置步骤失败：{res["aborted"]}'
    fails = res.get('fails') or []
    if fails:
        return False, f'落盘守卫断言失败 {len(fails)} 项：' + '；'.join(fails[:8])
    return True, '只读态 5 条落盘路径全拒 + IPC 零调用 + 自动保存不起；切回可写后恢复（来回切换均正确）'


# ─────────────────────────────────────────────────────────────
# c) 只读徽标
# ─────────────────────────────────────────────────────────────
BADGE_JS = """(async () => {
  const G = await import('/src/store/writeGate.js');
  const SB = await import('/src/composables/useStatusBar.js');
  const fails = [];
  const ck = (label, cond, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); };
  const tick = () => new Promise(r => setTimeout(r, 150));

  SB.showStatusBar('测试视图');
  G.setWriteMode('legacy', '');
  await tick();
  ck('可写态无只读徽标', !document.querySelector('.sb-readonly'));
  ck('状态栏已渲染', !!document.querySelector('.status-bar'));

  G.setWriteMode('readonly', '');
  await tick();
  const badge = document.querySelector('.sb-readonly');
  ck('只读态出现徽标', !!badge, document.body.className);
  if (badge) {
    ck('徽标文案含只读', badge.textContent.indexOf('只读') >= 0, badge.textContent.trim());
    ck('徽标 title 含能力说明', String(badge.getAttribute('title')).indexOf('打开项目后即可继续编辑') >= 0, badge.getAttribute('title'));
  }

  G.setWriteMode('legacy', '');
  await tick();
  ck('切回可写后徽标消失', !document.querySelector('.sb-readonly'));
  return JSON.stringify({ fails: fails });
})()"""


def sub_badge(cdp):
    ok, res = eval_json(cdp, BADGE_JS, desc='只读徽标')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        return False, f'只读徽标断言失败 {len(fails)} 项：' + '；'.join(fails[:6])
    return True, '徽标随写模式出现/消失，title 含「打开项目后即可继续编辑」（能力不减）'


# ─────────────────────────────────────────────────────────────
# d) projectStore 联动
# ─────────────────────────────────────────────────────────────
WIRING_JS = """(async () => {
  const app = @APP@;
  const pinia = (app && app.config && app.config.globalProperties) ? app.config.globalProperties.$pinia : null;
  if (!pinia) return JSON.stringify({ err: 'pinia-not-found' });
  const G = await import('/src/store/writeGate.js');
  const M = await import('/src/store/projectStore.js');
  const s = M.useProjectStore(pinia);
  const fails = [];
  const ck = (label, cond, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); };
  const same = (label, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(label + ' → got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); };

  window.__projects = {}; window.__projectCalls = [];
  G.setWriteMode('readonly', '');

  const cr = await s.createProject({ name: 'gate测试项目', dir: 'mock/projects' });
  ck('创建项目成功', cr.success === true, cr);
  if (cr.success !== true) return JSON.stringify({ fails: fails, aborted: 'createProject 失败：' + (cr.error || '') });
  same('打开项目 → project 模式', G.describeWriteGate().mode, 'project');
  ck('project 模式可写', G.canWrite() === true);
  ck('原因含项目名', G.writeModeReason.value.indexOf('gate测试项目') >= 0, G.writeModeReason.value);

  s.closeProject();
  const expect = G.READONLY_WITHOUT_PROJECT ? 'readonly' : 'legacy';
  same('关闭项目 → 回到无项目默认模式', G.describeWriteGate().mode, expect);
  same('默认模式与常量一致', G.describeWriteGate().mode, expect);

  G.setWriteMode('legacy', '');
  return JSON.stringify({ fails: fails, expectedMode: expect });
})()""".replace('@APP@', APP)


def sub_wiring(cdp):
    ok, res = eval_json(cdp, WIRING_JS, desc='projectStore 联动')
    if not ok:
        return False, res
    if res.get('err'):
        return False, f'联动用例环境异常：{res["err"]}'
    if res.get('aborted'):
        return False, f'联动前置步骤失败：{res["aborted"]}'
    fails = res.get('fails') or []
    if fails:
        return False, f'联动断言失败 {len(fails)} 项：' + '；'.join(fails[:6])
    return True, f"打开项目切 project 模式、关闭回落无项目默认模式（当前 {res.get('expectedMode')}）"


# ─────────────────────────────────────────────────────────────
# e) 源码契约：入口清单里标 guarded 的必须真有守卫
# ─────────────────────────────────────────────────────────────
def sub_callsite_contract(cdp):
    ok, res = eval_json(cdp, "(async () => { const G = await import('/src/store/writeGate.js');"
                             " return JSON.stringify(G.WRITE_CALLSITES); })()",
                        required=None, desc='入口清单')
    if not ok:
        return False, res
    if not isinstance(res, list) or not res:
        return False, f'读取入口清单失败（{type(res).__name__}）：{str(res)[:200]}'

    bad = []
    guarded = [x for x in res if x.get('guarded')]
    unguarded = [x for x in res if not x.get('guarded')]

    for item in guarded:
        rel = item['file']
        try:
            src = _read(rel)
        except OSError as e:
            bad.append(f"{rel} 读不到（{e}）")
            continue
        if item['marker'] not in src:
            bad.append(f"{rel} 标了 guarded 但找不到守卫（{item['marker']}｜{item['what']}）")

    # 已守条目覆盖率：geodata.js 至少 4 处（saveGeodata/saveScenarios/saveMapData/reextract）
    geo = _read('src/renderer/src/store/geodata.js')
    n = geo.count('guardWrite(')
    if n < 4:
        bad.append(f'geodata.js 只有 {n} 处 guardWrite（期望 ≥4）')

    # 未守条目不得已经偷偷加了守卫（避免清单与实际不一致）
    for item in unguarded:
        rel = item['file']
        src = _read(rel)
        if item['what'] == 'createObsidianNote' and 'guardWrite(' in src:
            bad.append(f"{rel} 已加守卫但清单仍标未守（清单需同步）")
        if item['what'] == 'clearCoordinateCache' and 'guardWrite(' in src:
            bad.append(f"{rel} 已加守卫但清单仍标未守（清单需同步）")

    if bad:
        return False, '入口清单与源码不一致：' + '；'.join(bad)
    return True, f"清单 {len(res)} 条（已守 {len(guarded)} / 待守 {len(unguarded)}），已守条目在源码中均真存在守卫"


# ─────────────────────────────────────────────────────────────
# f) 只读态 UI 灰禁（Phase 2.4）：只拦不灰禁 = 用户点完才被拒（坏交互）
#    三条落盘入口的按钮必须在只读态灰禁，并给出「打开项目后即可编辑」的原因说明。
# ─────────────────────────────────────────────────────────────
UI_JS = r"""(async () => {
  const fails = [];
  const ck = (label, cond, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 200));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const btnByText = (sel, t) => qa(sel).find(b => (b.textContent || '').indexOf(t) >= 0);

  const W = await import('/src/store/writeGate.js');
  const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
  const { useProjectStore } = await import('/src/store/projectStore.js');
  const proj = useProjectStore(pinia);
  const store = document.querySelector('#app').__vue_app__._instance.setupState.store;

  if (proj.isOpen) proj.closeProject();
  await tick(300);
  W.setWriteMode('readonly', '测试只读');
  await tick(200);
  ck('已切到只读态', W.isReadOnly.value === true, W.writeMode.value);

  // 1) 详情面板：draft 转正
  const draft = store.addNode({ id: '只读灰禁暂存点', name: '只读灰禁暂存点', layer: 'location',
    parentId: null, tags: [], sourcePath: '', draft: true, coordinate: { x: 0, y: 0 } });
  store.selectNode(draft);
  await tick(400);
  const promoteBtn = btnByText('button.action-btn.primary', '创建 Obsidian 笔记');
  ck('详情面板出现转正按钮', !!promoteBtn);
  ck('只读态转正按钮灰禁', !!promoteBtn && promoteBtn.disabled === true, promoteBtn && promoteBtn.disabled);
  ck('灰禁按钮带原因（不是静默失效）', !!promoteBtn && /只读/.test(promoteBtn.getAttribute('title') || ''),
     promoteBtn && promoteBtn.getAttribute('title'));

  // 2) 批量导入面板
  window.dispatchEvent(new CustomEvent('sitian:open-batch-import'));
  await tick(500);
  const importBtn = btnByText('button.btn-primary', '开始导入');
  ck('批量导入面板出现', !!importBtn);
  ck('只读态批量导入按钮灰禁', !!importBtn && importBtn.disabled === true, importBtn && importBtn.disabled);
  ck('批量导入灰禁带原因', !!importBtn && /只读/.test(importBtn.getAttribute('title') || ''),
     importBtn && importBtn.getAttribute('title'));
  const cancelBtn = btnByText('button.btn-secondary', '取消');
  if (cancelBtn) cancelBtn.click();
  await tick(300);

  // 3) 设置面板：清除坐标缓存
  const setBtn = qa('.toolbar-actions button').find(b => b.title === '设置');
  ck('工具栏有设置入口', !!setBtn);
  if (setBtn) setBtn.click();
  await tick(600);
  const clearBtn = qa('.settings-panel button').find(b => (b.textContent || '').indexOf('清除坐标缓存') >= 0);
  ck('设置面板出现清缓存按钮', !!clearBtn);
  ck('只读态清缓存按钮灰禁', !!clearBtn && clearBtn.disabled === true, clearBtn && clearBtn.disabled);
  ck('清缓存灰禁带原因', !!clearBtn && /只读/.test(clearBtn.getAttribute('title') || ''),
     clearBtn && clearBtn.getAttribute('title'));

  // 复位：删掉测试节点、模式回到无项目默认值（页面每个用例后会 reload，这里只是不留脏状态）
  store.removeNode('只读灰禁暂存点');
  W.setWriteMode(W.READONLY_WITHOUT_PROJECT ? 'readonly' : 'legacy', '');
  await tick(200);
  ck('复位后不再只读（无项目默认模式）', W.isReadOnly.value === W.READONLY_WITHOUT_PROJECT,
     { mode: W.writeMode.value, readonly_without_project: W.READONLY_WITHOUT_PROJECT });
  return JSON.stringify({ fails: fails });
})()"""


def sub_readonly_ui(cdp):
    ok, res = eval_json(cdp, UI_JS, desc='只读态 UI 灰禁')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        return False, '只读灰禁断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8])
    return True, '转正 / 批量导入 / 清缓存 三处入口在只读态均灰禁且给出原因说明'


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    wait_for(cdp, f"{STORE}.nodes.length > 0", timeout=45, desc='地理数据加载')

    results = []
    for name, fn in (('a 写闸门语义', sub_module),
                     ('b 落盘守卫端到端', sub_guard),
                     ('c 只读徽标', sub_badge),
                     ('d projectStore 联动', sub_wiring),
                     ('e 入口清单源码契约', sub_callsite_contract),
                     ('f 只读态 UI 灰禁', sub_readonly_ui)):
        try:
            ok, detail = fn(cdp)
        except Exception as e:
            ok, detail = False, f'异常: {e}'
        results.append((name, ok, detail))

    # 用例结束复位（页面会 reload，这里只是礼貌）
    try:
        cdp.eval("(async () => { const G = await import('/src/store/writeGate.js');"
                 " return G.setWriteMode('legacy', '').ok; })()")
    except Exception:
        pass

    failed = [f'{n}: {d}' for n, o, d in results if not o]
    if failed:
        return False, (f'写闸门 {len(results) - len(failed)}/{len(results)} 子测试通过；失败：\n    '
                       + '\n    '.join(failed))
    return True, '写闸门 ' + f'{len(results)}/{len(results)} 全通过 — ' + '；'.join(d for _, _, d in results)
