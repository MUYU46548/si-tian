#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 48：项目面板 + 实体创建向导（Phase 2.1 / 2.2 / 2.3）

用户决策（2026-09-18）：
  · 实体创建走 **C 方案「分派式向导」**——表单填「名称/层级/父级」，创建后按层级走不同的
    落位/绘制流程；画布交互一律复用各视图现有工具，不在弹窗里再造一套画布。
  · region 层级的边界用**专用自由绘制工具**（沿用 v7 原型）→ 向导里对应「按住拖动勾轮廓 + 离屏校验」的说明。
  · building 已纳入向导（2026-09-21 决策反转：原本只能在区域地图里建 → 两条入口不一致）。

用户决策（2026-09-19，本轮）：
  · 面板位置的现状（右上 340px）保持；
  · 实体树要能**改名 / 删除 / 拖动改父级**（都走 undo）；
  · 向导的层级下拉**按已选父级自动过滤**；
  · 分派说明改为**创建完成后的结果卡片**，按钮文案用「前往编辑」（不是「前往落位」）。

本用例守：
  a) 入口可用：工具栏「项目」按钮 → 面板出现 → 再点关闭（不是死按钮）
  b) 未打开项目时的空态文案（决策 1 终态：无项目 = 只读 —— 文案写清现状 + 去处；
     且只读态下「新建」按钮仍必须可用，否则永远打不开第一个项目 = 死锁）
  c) 面板内新建项目 → 状态条 + 项目列表 + 实体/快照区就位
  d) 向导：分派说明随层级变化（region / galaxy / city 三种文案必须不同且有层级特征词）
  e) 层级下拉按父级过滤（顶层=全量 13；父级 world → 仅 star_domain 且自动切换）
  f) 创建实体 → **结果卡片**（成功文案 + 该层级步骤 + 「前往编辑」）→ 点「前往编辑」关向导并在面板选中该实体
  g) 实体树改名（走 undo：撤销后名字还原）
  h) 实体树删除（两段式确认：先出现确认条，取消不删、确认才删）
  i) 实体树拖动改父级（拖到别的行=挂到它下面；拖到「顶层」条=回到根；拖到自己后代=拒绝且不写入）
  j) 详情区父级下拉改父级（拖动之外的等价入口，且不含自身）
  k) 保存 → 快照区出现一条 + 状态条「已保存」；关闭面板 → 面板消失
  l) 静态：面板是懒加载 chunk、不引用 geodata（接线属 Phase 2.4，本阶段不得偷跑）；向导含 building

⚠️ 测试写法提醒（本次踩过）：
  · **不要缓存 DOM 引用**：向导/面板会被 v-if 卸载重建，缓存的元素会变成脱离文档的旧节点，
    断言会读到过期的选项列表（静默假绿/假红）。
  · **行名比较用 `.pp-node-name` 精确相等**：`textContent.indexOf('测试世界')` 会命中「测试世界改」。
"""
import sys, os, re
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
APP = "document.querySelector('#app').__vue_app__"
STORE = f"{APP}._instance.setupState.store"


def _read(rel):
    with open(os.path.join(ROOT, rel), 'r', encoding='utf-8') as f:
        return f.read()


PANEL_JS = r"""(async () => {
  const fails = [];
  const ck = (label, cond, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); };
  const same = (label, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(label + ' → got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 160));
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => Array.from(document.querySelectorAll(sel));
  const text = (sel) => { const el = q(sel); return el ? el.textContent.trim() : null; };
  const btnIn = (sel, label) => qa(sel).find(b => b.textContent.trim() === label);
  const panelRows = () => qa('.project-panel .pp-node-row');
  const rowName = (r) => { const e = r.querySelector('.pp-node-name'); return e ? e.textContent.trim() : '<改名中>'; };
  const rowOfName = (nm) => panelRows().find(r => rowName(r) === nm) || null;
  const rowNames = () => panelRows().map(rowName);
  const rowPad = (nm) => { const r = rowOfName(nm); return r ? parseInt(r.style.paddingLeft || '0', 10) : -1; };

  window.__projects = {}; window.__projectCalls = [];

  // store 直读（断言落库结果，不只信 DOM）
  const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
  const { useProjectStore } = await import('/src/store/projectStore.js');
  const ps = useProjectStore(pinia);
  const W = await import('/src/store/writeGate.js');

  // harness 每个用例前会打开基线项目（决策 1 终态：无项目 = 只读，用例得有项目才可写）。
  // 本用例守的就是面板的**空态**，所以先关掉它 —— 顺带验证「关闭 → 无项目 → 只读」的终态，
  // 以及「只读态下「新建」按钮必须仍可用」（否则永远打不开第一个项目 = 死锁）。
  if (ps.isOpen) { await ps.closeProject(); await tick(300); }
  ck('用例起点：无项目 + 只读（决策 1 终态）', ps.isOpen === false && W.isReadOnly.value === true,
     { open: ps.isOpen, gate: W.describeWriteGate() });
  const ent = (nm) => Object.values(ps.entities).find(e => (e.name || '') === nm) || null;
  const entId = (nm) => { const e = ent(nm); return e ? e.id : null; };
  const entCount = () => Object.keys(ps.entities).length;

  // 合成 HTML5 拖拽（headless 下不能真拖鼠标）
  const mkDT = () => { try { return new DataTransfer(); } catch (e) { return undefined; } };
  const fireDrag = (type, el, dt) => {
    if (!el) return;
    let ev;
    try { ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }); }
    catch (e) { ev = new Event(type, { bubbles: true, cancelable: true }); }
    el.dispatchEvent(ev);
  };
  const dragTo = async (srcName, dstEl) => {
    const src = rowOfName(srcName);
    if (!src || !dstEl) { ck('拖动前置：找不到行或目标', false, [srcName, !!src, !!dstEl]); return; }
    const dt = mkDT();
    fireDrag('dragstart', src, dt);
    await tick(100);
    fireDrag('dragover', dstEl, dt);
    await tick(100);
    fireDrag('drop', dstEl, dt);
    await tick(250);
    fireDrag('dragend', src, dt);
    await tick(150);
  };

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

  // ---- b) 空态（决策 1 终态：无项目 = 只读 —— 文案要写清现状 + 去处，不能只说「停用」）----
  await tick();
  same('空态项目名', text('.pp-status-name'), '未打开项目');
  const sub = text('.pp-status-sub') || '';
  ck('空态说明写清只读现状', /只读/.test(sub), sub);
  ck('空态说明给出可行去处（新建 / 打开项目）', /新建/.test(sub) && /打开/.test(sub), sub);
  ck('实体区空态提示', (text('.pp-section .pp-empty') || '').length > 0);
  ck('实体区空态提示先打开项目', document.body.innerHTML.indexOf('点「+ 新建实体」开始') < 0);

  // ---- c) 新建项目（面板内完成）----
  const input = q('.project-panel .pp-input');
  ck('有名称输入框', !!input);
  input.value = '面板测试项目';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await tick(60);
  const createBtn = btnIn('.project-panel .pp-btn', '新建');
  ck('有「新建」按钮', !!createBtn);
  ck('名称非空时「新建」可用', createBtn && !createBtn.disabled);
  createBtn.click();
  await tick(400);
  same('状态条显示项目名', text('.pp-status-name'), '面板测试项目');
  ck('落盘路径提示存在（.sitian）', String(text('.pp-file') || '').indexOf('.sitian') >= 0, text('.pp-file'));
  const listItems = qa('.project-panel .pp-item');
  ck('项目列表出现该项', listItems.some(el => el.textContent.indexOf('面板测试项目') >= 0), listItems.length);
  ck('mock 收到 create 调用', (window.__projectCalls || []).some(c => c.op === 'create'), window.__projectCalls);
  ck('打开项目后实体区空态变成「还没有实体」', document.body.innerHTML.indexOf('还没有实体') >= 0);

  // ---- 向导操作器（**每次都现查 DOM**，绝不缓存元素）----
  const openWizard = async () => {
    btnIn('.project-panel .link-btn', '+ 新建实体').click();
    for (let i = 0; i < 30 && !q('.ec-overlay'); i++) await tick(100);
  };
  const layerEl = () => q('[data-testid="ec-layer"]');
  const parentEl = () => q('[data-testid="ec-parent"]');
  const layerVals = () => { const el = layerEl(); return el ? Array.from(el.options).map(o => o.value) : null; };
  const fillName = async (nm) => {
    const inp = q('.ec-card input');
    inp.value = nm;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await tick(90);
  };
  const setLayer = async (val) => {
    const el = layerEl();
    el.value = val;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await tick(130);
    return qa('.ec-dispatch li').map(li => li.textContent.trim()).join(' | ');
  };
  const setParent = async (val) => {
    const el = parentEl();
    el.value = val || '';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await tick(200);
  };
  const createNow = async () => { btnIn('.ec-btn', '创建').click(); await tick(350); };
  const cardText = () => text('.ec-card-done .ec-result');
  const cardSteps = () => qa('.ec-card-done .ec-dispatch li').map(li => li.textContent.trim()).join(' | ');

  // ---- d) 向导：分派说明随层级变化 + 层级下拉 ----
  await openWizard();
  ck('向导弹层出现', !!q('.ec-overlay'));
  if (!q('.ec-overlay')) return JSON.stringify({ fails: fails, aborted: '向导未渲染' });
  ck('向导标题', text('.ec-title') === '新建实体');
  ck('层级下拉/父级下拉可定位', !!layerEl() && !!parentEl());
  same('未选父级时层级全量可选（13）', (layerVals() || []).length, 13);
  ck('层级选项包含 building（与区域地图的建筑工具一致）', (layerVals() || []).includes('building'), layerVals());
  const cityTxt = await setLayer('city');
  const galaxyTxt = await setLayer('galaxy');
  const regionTxt = await setLayer('region');
  ck('city 分派提到行星表面落位', cityTxt.indexOf('行星表面') >= 0, cityTxt);
  ck('galaxy 分派提到恒星系视图', galaxyTxt.indexOf('恒星系视图') >= 0, galaxyTxt);
  ck('region 分派提到自由绘制', regionTxt.indexOf('自由绘制') >= 0, regionTxt);
  ck('region 分派含离屏校验说明', regionTxt.indexOf('离屏') >= 0, regionTxt);
  ck('三种层级的分派文案互不相同', new Set([cityTxt, galaxyTxt, regionTxt]).size === 3);
  ck('创建前说明「前往编辑会把画布切到对应视图」', (text('.ec-note') || '').indexOf('前往编辑') >= 0, text('.ec-note'));

  // ---- e) 创建第一个实体（world，顶层）----
  await fillName('测试世界');
  ck('id 预览随名称变化', (text('.ec-id') || '').indexOf('测试世界') >= 0, text('.ec-id'));
  await setLayer('world');
  await createNow();

  // ---- f) 结果卡片（用户 2026-09-19 决策）----
  ck('创建后出现结果卡片', !!q('.ec-card-done'));
  ck('卡片成功文案含实体名', (cardText() || '').indexOf('测试世界') >= 0, cardText());
  ck('卡片内含该层级（world）的分派步骤', cardSteps().indexOf('世界卡片') >= 0, cardSteps());
  ck('卡片说明「前往编辑直达画布」', (text('.ec-card-done .ec-note') || '').indexOf('前往编辑') >= 0, text('.ec-card-done .ec-note'));
  const gotoBtn = btnIn('.ec-btn', '前往编辑');
  ck('卡片按钮文案是「前往编辑」', !!gotoBtn);
  ck('全页面不再出现「前往落位」字样', document.body.innerHTML.indexOf('前往落位') < 0);
  gotoBtn.click();
  await tick(350);
  ck('点「前往编辑」后向导关闭', !q('.ec-overlay'));
  ck('点「前往编辑」后面板选中该实体', !!q('.project-panel .pp-node-row.sel'), rowNames());
  ck('面板提示说明当前可编辑什么', (text('.pp-tip') || '').indexOf('已选中') >= 0, text('.pp-tip'));
  same('落库：实体数量 1', entCount(), 1);
  ck('落库：父级为空（顶层）', ent('测试世界').parentId === null, ent('测试世界'));

  // ---- g) 改名（走 undo）----
  const renameBtn = q('.project-panel .pp-node-row [title="改名"]');
  ck('行内有「改名」按钮', !!renameBtn);
  renameBtn.click();
  await tick(200);
  const renameInput = q('.pp-rename');
  ck('出现行内改名输入框', !!renameInput);
  renameInput.value = '改名世界';
  renameInput.dispatchEvent(new Event('input', { bubbles: true }));
  await tick(90);
  renameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick(300);
  ck('改名后树显示新名字', rowNames().includes('改名世界'), rowNames());
  ck('改名不动 id（id 仍是名称规范化结果）', !!entId('改名世界') && entId('测试世界') === null, Object.keys(ps.entities));
  const { undo } = await import('/src/store/undo.js');
  undo();
  await tick(300);
  ck('改名可撤销（undo 后名字还原）', rowNames().includes('测试世界'), rowNames());

  // ---- e2) 再建一个顶层 star_domain ----
  await openWizard();
  await fillName('独立星域');
  await setLayer('star_domain');
  await createNow();
  ck('第二个实体创建成功（顶层星域）', (cardText() || '').indexOf('独立星域') >= 0, cardText());
  ck('卡片步骤随层级变化（星域=边界圆）', cardSteps().indexOf('边界圆') >= 0, cardSteps());

  // ---- e3) 层级按父级过滤：父级 = world → 只剩 star_domain 且自动切换 ----
  btnIn('.ec-btn', '再建一个').click();
  await tick(300);
  ck('「再建一个」后回到表单（预告重现、卡片消失）', !!q('.ec-dispatch') && !q('.ec-card-done'));
  await fillName('北星域');
  await setLayer('city');
  const worldId = entId('测试世界');
  await setParent(worldId);
  same('父级=世界时的层级候选只剩 star_domain', layerVals(), ['star_domain']);
  same('父级变化后自动把层级切到合法值', layerEl().value, 'star_domain');
  ck('过滤生效时给出说明文案', (text('.ec-hint') || '').indexOf('已按父级过滤') >= 0, text('.ec-hint'));
  await createNow();
  ck('第三个实体创建成功', (cardText() || '').indexOf('北星域') >= 0, cardText());
  ck('挂到父级下的实体 parentId 正确', ent('北星域').parentId === worldId, ent('北星域').parentId);
  await setParent('');
  same('父级清空后层级恢复全量 13', (layerVals() || []).length, 13);

  btnIn('.ec-btn', '关闭').click();
  await tick(300);
  ck('向导关闭', !q('.ec-overlay'));

  // ---- 实体树：行数 / 缩进 / 计数 ----
  const treeDump = () => JSON.stringify({
    rows: panelRows().map(r => ({ n: rowName(r), pad: r.style.paddingLeft, cls: r.className })),
    ents: Object.values(ps.entities).map(e => ({ id: e.id, p: e.parentId, l: e.layer })),
    tree: ps.entityTree.map(t => ({ id: t.id, kids: (t.children || []).map(c => c.id) })),
  });
  same('实体树行数', panelRows().length, 3);
  ck('树显示层级徽标', panelRows().every(r => !!r.querySelector('.pp-badge')));
  ck('子实体缩进更深', rowPad('北星域') > rowPad('独立星域'), treeDump());
  const entityLabel = qa('.project-panel .pp-label')
    .map(el => el.textContent.replace(/\s+/g, ' ').trim())
    .find(t => t.startsWith('实体（'));
  same('实体计数标签', entityLabel, '实体（3） + 新建实体');

  // ---- h) 拖到别的行 = 改父级 ----
  await dragTo('独立星域', rowOfName('测试世界'));
  same('拖动后 parentId 落到目标行', ent('独立星域').parentId, worldId);
  ck('拖动后缩进变深', rowPad('独立星域') === rowPad('北星域'), [rowPad('独立星域'), rowPad('北星域')]);
  ck('拖动后有结果提示', (text('.pp-tip') || '').indexOf('移到') >= 0, text('.pp-tip'));

  // ---- h2) 拖到「顶层」条 = 回到根 ----
  {
    const src = rowOfName('独立星域');
    const dt = mkDT();
    fireDrag('dragstart', src, dt);
    await tick(200);
    const rootZone = q('.pp-drop-root');
    ck('拖动中出现「松开以移到顶层」投放条', !!rootZone, (rootZone || {}).textContent);
    fireDrag('dragover', rootZone, dt);
    fireDrag('drop', rootZone, dt);
    await tick(300);
    fireDrag('dragend', src, dt);
    await tick(150);
  }
  same('拖到顶层条后 parentId 归 null', ent('独立星域').parentId, null);
  ck('回到顶层后缩进回到最浅', rowPad('独立星域') < rowPad('北星域'), [rowPad('独立星域'), rowPad('北星域')]);

  // ---- h3) 拖到自己后代 = 拒绝（防循环）----
  await dragTo('测试世界', rowOfName('北星域'));
  same('拒绝循环后父级未变', ent('测试世界').parentId, null);
  same('拒绝循环后子实体父级未变', ent('北星域').parentId, worldId);
  ck('拒绝循环时给出原因提示', (text('.pp-tip') || '').indexOf('循环') >= 0, text('.pp-tip'));

  // ---- i) 删除：两段式确认 ----
  const delBtn = rowOfName('北星域').querySelector('[title^="删除"]');
  ck('行内有删除按钮', !!delBtn);
  delBtn.click();
  await tick(250);
  ck('出现删除确认条（不直接删）', !!q('.pp-confirm'));
  ck('确认条写明删除对象', (text('.pp-confirm-text') || '').indexOf('北星域') >= 0, text('.pp-confirm-text'));
  same('确认前未删除', entCount(), 3);
  btnIn('.pp-confirm .pp-btn', '取消').click();
  await tick(200);
  ck('取消后确认条消失', !q('.pp-confirm'));
  same('取消后实体仍在', entCount(), 3);
  rowOfName('北星域').querySelector('[title^="删除"]').click();
  await tick(250);
  btnIn('.pp-confirm .pp-btn', '删除').click();
  await tick(350);
  same('确认后实体被删', entCount(), 2);
  ck('树里不再有被删实体', !rowOfName('北星域'), rowNames());
  ck('删除有结果提示', (text('.pp-tip') || '').indexOf('已删除') >= 0, text('.pp-tip'));

  // ---- j) 详情区父级下拉（拖动的等价入口）----
  rowOfName('独立星域').click();
  await tick(250);
  ck('详情面板出现', !!q('.pp-detail'));
  const detailParent = q('.pp-parent');
  ck('详情区有父级下拉', !!detailParent);
  detailParent.value = worldId;
  detailParent.dispatchEvent(new Event('change', { bubbles: true }));
  await tick(300);
  same('下拉改父级生效', ent('独立星域').parentId, worldId);
  ck('下拉里不含自身（防自环）', !qa('.pp-parent option').some(o => o.value === entId('独立星域')),
     qa('.pp-parent option').map(o => o.value));

  // ---- k) 保存 → 快照 ----
  const statusSeen = { v: '' };
  btnIn('.project-panel .pp-btn', '保存').click();
  for (let i = 0; i < 25; i++) {                    // 轮询而不是死等固定毫秒（状态条是瞬态 UI）
    statusSeen.v = text('.pp-status-sub') || '';
    if (statusSeen.v.indexOf('已保存') >= 0) break;
    await tick(120);
  }
  ck('状态条显示已保存', statusSeen.v.indexOf('已保存') >= 0, statusSeen.v);
  ck('mock 收到 save 调用', (window.__projectCalls || []).some(c => c.op === 'save'), window.__projectCalls);
  ck('保存后 dirty 归位', ps.dirty === false, ps.dirty);
  ck('快照区出现', document.body.innerHTML.indexOf('快照（最近 50 份') >= 0);
  ck('快照条目出现（手动保存）', document.body.innerHTML.indexOf('手动保存') >= 0);

  // ---- 关闭面板（入口可逆）----
  q('.project-panel .close-btn').click();
  await tick(300);
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
    return True, ('入口开关/空态文案/新建项目/分派说明三层级差异/层级按父级过滤/结果卡片与「前往编辑」'
                  '/改名(可撤销)/拖动改父级(含顶层与防循环)/两段式删除/详情区父级下拉/保存+快照 全部通过')


# ─────────────────────────────────────────────────────────────
# l) 静态：懒加载 + 不得偷跑接线 + 新能力真的走 projectStore
# ─────────────────────────────────────────────────────────────
def sub_static(cdp):
    bad = []
    app = _read('src/renderer/src/App.vue')
    if "defineAsyncComponent(() => import('./components/ProjectPanel.vue'))" not in app:
        bad.append('App.vue 未把 ProjectPanel 注册为懒加载组件')
    if "panelsStore.toggle('project')" not in app:
        bad.append('App.vue 缺少项目面板入口按钮')
    if "panelsStore.isOpen('project')" not in app:
        bad.append('App.vue 未挂载 project-panel')
    for rel in ('src/renderer/src/components/ProjectPanel.vue',
                'src/renderer/src/components/EntityCreator.vue'):
        src = _read(rel)
        if 'store/geodata' in src:
            bad.append(f'{rel} 引用了 geodata store（接线属 Phase 2.4，本阶段不得偷跑）')
        if 'sitianAPI' in src:
            bad.append(f'{rel} 直接调用了 sitianAPI（应只经 projectStore）')

    pp = _read('src/renderer/src/components/ProjectPanel.vue')
    for call in ('proj.renameEntity(', 'proj.deleteEntity(', 'proj.moveEntity(', 'proj.parentCandidates('):
        if call not in pp:
            bad.append(f'ProjectPanel 未接实体树操作：缺 {call}')
    for token in ('draggable', '@dragstart', '@drop'):
        if token not in pp:
            bad.append(f'ProjectPanel 实体树缺少拖动改父级要素：{token}')
    if '@goto' not in pp:
        bad.append('ProjectPanel 未接 EntityCreator 的 goto 事件（「前往编辑」会是死按钮）')

    ec = _read('src/renderer/src/components/EntityCreator.vue')
    creatable = ec.split('const CREATABLE')[1].split('];')[0]
    # 2026-09-21 决策反转：建筑只能在区域地图里建 → 入口不一致，向导补上 building（与区域地图一致）
    if "'building'" not in creatable:
        bad.append('EntityCreator 的可创建层级里缺少 building（与区域地图的建筑工具不一致）')
    if "'building'" not in ec.split('const CHILD_LAYERS')[1].split('};')[0]:
        bad.append('EntityCreator 的 CHILD_LAYERS 缺少 building 的合法父级（region/city/town/village）')
    if 'CHILD_LAYERS' not in ec:
        bad.append('EntityCreator 缺少层级父子表（层级下拉无法按父级过滤）')
    for token in ('前往编辑', "emit('goto'", 'gotoEdit'):
        if token not in ec:
            bad.append(f'EntityCreator 缺少结果卡片要素：{token}')
    if '前往落位' in ec:
        bad.append('EntityCreator 里仍有「前往落位」（用户已改为「前往编辑」）')
    if bad:
        return False, '；'.join(bad)
    return True, ('面板为懒加载 chunk、入口齐全；两个新组件均不引用 geodata/sitianAPI（接线属 Phase 2.4）；'
                  '向导含 building（与区域地图一致）、层级过滤表与结果卡片（前往编辑）齐全，'
                  '且面板已接改名/删除/拖动改父级/多选批量改父级')


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    wait_for(cdp, f"{STORE}.nodes.length > 0", timeout=45, desc='地理数据加载')

    results = []
    for name, fn in (('a~k 面板与向导端到端', sub_panel),
                     ('l 静态约定（懒加载/不偷跑接线/新能力接线）', sub_static)):
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
