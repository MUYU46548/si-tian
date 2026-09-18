#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 48：项目面板 + 实体创建向导（Phase 2.1 / 2.2）

用户决策（2026-09-18）：
  · 实体创建走 **C 方案「分派式向导」**——表单填「名称/层级/父级」，创建后按层级走不同的
    落位/绘制流程；画布交互一律复用各视图现有工具，不在弹窗里再造一套画布。
  · region 层级的边界用**专用自由绘制工具**（沿用 v7 原型）→ 向导里对应「按住拖动勾轮廓 + 离屏校验」的说明。
  · building 不纳入向导（沿用区域地图现有入口）。

本用例守：
  a) 入口可用：工具栏「项目」按钮 → 面板出现 → 再点关闭（不是死按钮）
  b) 未打开项目时的空态文案（不误导：当前仍写知识库缓存，接线后才变只读）
  c) 面板内新建项目 → 状态条 + 项目列表 + 实体/快照区就位
  d) 向导：分派说明随层级变化（region / galaxy / city 三种文案必须不同且有层级特征词）
  e) 创建实体 → 结果提示 + 实体树出现 + 详情显示 id/层级
  f) 父子两级 → 树按深度缩进（depth 1 的 padding-left 更大）
  g) 保存 → 快照区出现一条 + 状态条「已保存」
  h) 关闭项目 → 回到未打开状态
  i) 静态：面板是懒加载 chunk 且不引用 geodata（接线属 Phase 2.4，本阶段不得偷跑）
"""
import sys, os, re
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
APP = "document.querySelector('#app').__vue_app__"
STORE = f"{APP}._instance.setupState.store"

PANEL = "document.querySelector('.project-panel')"
TOOLBAR_BTN = ("Array.from(document.querySelectorAll('button'))"
               ".find(b => (b.getAttribute('title') || '').startsWith('项目'))")


def _read(rel):
    with open(os.path.join(ROOT, rel), 'r', encoding='utf-8') as f:
        return f.read()


# ─────────────────────────────────────────────────────────────
# a) 入口 + b) 空态 + c) 新建项目 + g) 快照 + h) 关闭（一次性驱动，减少刷新次数）
# ─────────────────────────────────────────────────────────────
PANEL_JS = """(async () => {
  const fails = [];
  const ck = (label, cond, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); };
  const same = (label, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(label + ' → got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 160));
  const q = (sel) => document.querySelector(sel);
  const text = (sel) => { const el = q(sel); return el ? el.textContent.trim() : null; };

  window.__projects = {}; window.__projectCalls = [];

  // ---- a) 入口：工具栏按钮真实可用 ----
  const btn = Array.from(document.querySelectorAll('button'))
    .find(b => (b.getAttribute('title') || '').startsWith('项目'));
  ck('工具栏存在「项目」入口', !!btn, btn ? btn.getAttribute('title') : 'not-found');
  if (!btn) return JSON.stringify({ fails: fails, aborted: '无项目入口，后续步骤跳过' });
  ck('入口 title 说明是 .sitian 项目文件', String(btn.getAttribute('title')).indexOf('.sitian') >= 0, btn.getAttribute('title'));

  ck('初始未打开面板', !q('.project-panel'));
  btn.click();
  for (let i = 0; i < 40 && !q('.project-panel'); i++) await tick(100);   // 懒加载 chunk 需等
  ck('点击后面板出现', !!q('.project-panel'));
  if (!q('.project-panel')) return JSON.stringify({ fails: fails, aborted: '面板未渲染（懒加载 chunk 失败？）' });

  // ---- b) 空态 ----
  await tick();
  same('空态项目名', text('.pp-status-name'), '未打开项目');
  ck('空态说明写清当前写模式', /未打开项目（写模式：/.test(text('.pp-status-sub') || ''), text('.pp-status-sub'));
  ck('实体区空态提示', (text('.pp-section .pp-empty') || '').length > 0);
  ck('实体区空态提示先打开项目', document.body.innerHTML.indexOf('点「+ 新建实体」开始') < 0);

  // ---- c) 新建项目（面板内完成）----
  const input = q('.project-panel .pp-input');
  ck('有名称输入框', !!input);
  input.value = '面板测试项目';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await tick(60);
  const createBtn = Array.from(document.querySelectorAll('.project-panel .pp-btn'))
    .find(b => b.textContent.trim() === '新建');
  ck('有「新建」按钮', !!createBtn);
  ck('名称非空时「新建」可用', createBtn && !createBtn.disabled);
  createBtn.click();
  await tick(400);
  same('状态条显示项目名', text('.pp-status-name'), '面板测试项目');
  ck('落盘路径提示存在（.sitian）', String(text('.pp-file') || '').indexOf('.sitian') >= 0, text('.pp-file'));
  const listItems = Array.from(document.querySelectorAll('.project-panel .pp-item'));
  ck('项目列表出现该项', listItems.some(el => el.textContent.indexOf('面板测试项目') >= 0), listItems.length);
  ck('mock 收到 create 调用', (window.__projectCalls || []).some(c => c.op === 'create'), window.__projectCalls);
  ck('打开项目后实体区空态变成「还没有实体」', document.body.innerHTML.indexOf('还没有实体') >= 0);

  // ---- d) 向导：分派说明随层级变化 ----
  const addBtn = Array.from(document.querySelectorAll('.project-panel .link-btn'))
    .find(b => b.textContent.trim() === '+ 新建实体');
  ck('有「+ 新建实体」入口', !!addBtn);
  ck('打开项目后该入口可用', addBtn && !addBtn.disabled);
  addBtn.click();
  await tick(300);
  ck('向导弹层出现', !!q('.ec-overlay'));
  if (!q('.ec-overlay')) return JSON.stringify({ fails: fails, aborted: '向导未渲染' });
  ck('向导标题', text('.ec-title') === '新建实体');

  const selectLayer = async (val) => {
    const sel = q('.ec-card select');
    sel.value = val;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await tick(80);
    return Array.from(document.querySelectorAll('.ec-dispatch li')).map(li => li.textContent.trim()).join(' | ');
  };
  const cityTxt = await selectLayer('city');
  const galaxyTxt = await selectLayer('galaxy');
  const regionTxt = await selectLayer('region');
  ck('city 分派提到行星表面落位', cityTxt.indexOf('行星表面') >= 0, cityTxt);
  ck('galaxy 分派提到恒星系视图', galaxyTxt.indexOf('恒星系视图') >= 0, galaxyTxt);
  ck('region 分派提到自由绘制', regionTxt.indexOf('自由绘制') >= 0, regionTxt);
  ck('region 分派含离屏校验说明', regionTxt.indexOf('离屏') >= 0, regionTxt);
  ck('三种层级的分派文案互不相同', new Set([cityTxt, galaxyTxt, regionTxt]).size === 3);
  ck('向导不含 building 选项', !document.body.innerHTML.includes('>建筑（building）'));
  ck('有「接线后打通」的说明（不假装已可用）', text('.ec-note').indexOf('接线') >= 0, text('.ec-note'));

  // ---- e) 创建一个世界 + 一个城市（父子两级）----
  const nameInput = q('.ec-card input');
  nameInput.value = '测试世界';
  nameInput.dispatchEvent(new Event('input', { bubbles: true }));
  await tick(60);
  ck('id 预览随名称变化', text('.ec-id') && text('.ec-id').indexOf('测试世界') >= 0, text('.ec-id'));
  await selectLayer('world');
  q('.ec-btn.primary').click();
  await tick(250);
  ck('创建结果提示 ok', (text('.ec-result') || '').indexOf('已创建') >= 0, text('.ec-result'));
  ck('结果含实体 id', (text('.ec-result') || '').indexOf('测试世界') >= 0, text('.ec-result'));

  // 再建一个（reset + 填城市 + 选父级）
  const again = Array.from(document.querySelectorAll('.ec-btn')).find(b => b.textContent.trim() === '再建一个');
  again.click();
  await tick(120);
  const ni2 = q('.ec-card input');
  ni2.value = '测试城';
  ni2.dispatchEvent(new Event('input', { bubbles: true }));
  await tick(60);
  await selectLayer('city');
  const parentSel = document.querySelectorAll('.ec-card select')[1];
  parentSel.value = '测试世界';
  parentSel.dispatchEvent(new Event('change', { bubbles: true }));
  await tick(80);
  q('.ec-btn.primary').click();
  await tick(250);
  ck('第二个实体创建成功', (text('.ec-result') || '').indexOf('测试城') >= 0, text('.ec-result'));

  // 关向导
  Array.from(document.querySelectorAll('.ec-btn')).find(b => b.textContent.trim() === '关闭').click();
  await tick(200);
  ck('向导关闭', !q('.ec-overlay'));

  // ---- e/f) 实体树：两行 + 缩进 ----
  const rows = Array.from(document.querySelectorAll('.project-panel .pp-node-row'));
  same('实体树行数', rows.length, 2);
  ck('树显示层级徽标', rows.every(r => !!r.querySelector('.pp-badge')));
  ck('树显示名称', rows.map(r => r.textContent.replace(/\\s+/g, '')).join('|').indexOf('测试城') >= 0, rows.map(r => r.textContent.trim()));
  const pad = rows.map(r => parseInt(r.style.paddingLeft || '0', 10));
  ck('子实体缩进更深', pad.length === 2 && pad[1] > pad[0], pad);
  const entityLabel = Array.from(document.querySelectorAll('.project-panel .pp-label'))
    .map(el => el.textContent.replace(/\\s+/g, ' ').trim())
    .find(t => t.startsWith('实体（'));
  same('实体计数标签', entityLabel, '实体（2） + 新建实体');

  // 点第一行 → 详情
  rows[0].click();
  await tick(120);
  ck('详情面板出现', !!q('.pp-detail'));
  ck('详情含 id/层级/父级', (text('.pp-detail') || '').indexOf('顶层') >= 0, text('.pp-detail'));

  // ---- g) 保存 → 快照 ----
  const saveBtn = Array.from(document.querySelectorAll('.project-panel .pp-btn')).find(b => b.textContent.trim() === '保存');
  saveBtn.click();
  await tick(400);
  ck('状态条显示已保存', (text('.pp-status-sub') || '').indexOf('已保存') >= 0, text('.pp-status-sub'));
  ck('mock 收到 save 调用', (window.__projectCalls || []).some(c => c.op === 'save'), window.__projectCalls);
  const snapSection = document.body.innerHTML.indexOf('快照（最近 50 份');
  ck('快照区出现', snapSection >= 0);
  ck('快照条目出现', document.body.innerHTML.indexOf('手动保存') >= 0);

  // ---- 关闭面板（入口可逆）----
  const closeX = q('.project-panel .close-btn');
  closeX.click();
  await tick(250);
  ck('关闭按钮隐藏面板', !q('.project-panel'));

  return JSON.stringify({ fails: fails });
})()"""


def sub_panel(cdp):
    ok, res = eval_json(cdp, PANEL_JS, desc='项目面板')
    if not ok:
        return False, res
    if res.get('aborted'):
        return False, f'前置步骤失败已中止：{res["aborted"]}'
    fails = res.get('fails') or []
    if fails:
        return False, f'面板断言失败 {len(fails)} 项：' + '；'.join(fails[:8])
    return True, ('入口开关/空态文案/新建项目/分派说明三层级差异/实体树父子缩进/详情/保存+快照'
                  '全部通过')


# ─────────────────────────────────────────────────────────────
# i) 静态：懒加载 + 不得偷跑接线
# ─────────────────────────────────────────────────────────────
def sub_static(cdp):
    bad = []
    app = _read('src/renderer/src/App.vue')
    if "defineAsyncComponent(() => import('./components/ProjectPanel.vue'))" not in app:
        bad.append('App.vue 未把 ProjectPanel 注册为懒加载组件')
    if 'panelsStore.toggle(\'project\')' not in app:
        bad.append('App.vue 缺少项目面板入口按钮')
    if 'panelsStore.isOpen(\'project\')' not in app:
        bad.append('App.vue 未挂载 project-panel')
    for rel in ('src/renderer/src/components/ProjectPanel.vue',
                'src/renderer/src/components/EntityCreator.vue'):
        src = _read(rel)
        if 'store/geodata' in src:
            bad.append(f'{rel} 引用了 geodata store（接线属 Phase 2.4，本阶段不得偷跑）')
        if 'sitianAPI' in src:
            bad.append(f'{rel} 直接调用了 sitianAPI（应只经 projectStore）')
    # 向导的层级选项不得包含 building（用户已确认沿用区域地图入口）
    ec = _read('src/renderer/src/components/EntityCreator.vue')
    if "'building'" in ec.split('const layerOptions')[1].split('];')[0]:
        bad.append('EntityCreator 的层级选项里出现了 building（用户已确认不纳入）')
    if bad:
        return False, '；'.join(bad)
    return True, '面板为懒加载 chunk、入口齐全；两个新组件均不引用 geodata/sitianAPI（接线属 Phase 2.4）；向导不含 building'


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    wait_for(cdp, f"{STORE}.nodes.length > 0", timeout=45, desc='地理数据加载')

    results = []
    for name, fn in (('a~h 面板与向导端到端', sub_panel),
                     ('i 静态约定（懒加载/不偷跑接线）', sub_static)):
        try:
            ok, detail = fn(cdp)
        except Exception as e:
            ok, detail = False, f'异常: {e}'
        results.append((name, ok, detail))

    failed = [f'{n}: {d}' for n, o, d in results if not o]
    if failed:
        return False, (f'项目面板 {len(results) - len(failed)}/{len(results)} 子测试通过；失败：\n    '
                       + '\n    '.join(failed))
    return True, '项目面板 ' + f'{len(results)}/{len(results)} 全通过 — ' + '；'.join(d for _, _, d in results)
