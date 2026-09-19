#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 49：项目文件 ↔ 画布 接线（Phase 2.4）

用户决策（2026-09-18）：「有项目文件用项目文件；无项目回退 Obsidian」。
本用例守的就是这条决策的**运行时行为**（静态方向不变式在 test_46 里守）：

  a) 无项目时事实源是知识库（canvasSource='vault'，画布有 Obsidian 节点）
  b) 新建/打开项目 → 画布切到项目文件（canvasSource='project'，空项目=空画布）
  c) **项目侧**增删改 → 画布立即跟随（新增补进画布、改名同步、删除同步移除）
  d) **撤销/重做**也要同步画布（否则下一次画布保存会把撤销结果覆盖掉 —— 数据静默回滚）
  e) **画布侧**新增节点 + 保存 → 落进项目实体（画布是用户看到的真相）
  f) 画布侧改坐标 + 保存项目 → 项目文件里该实体的 coordinate 真的更新（不只是内存态）
  g) 已打开项目时 reextract 被明确拒绝（并给出「先关闭项目」的做法）
  h) 关闭项目 → 画布**恢复打开前的知识库工作态**（节点数量回到原值，不会"关掉项目画布就空了"）
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json

APP = "document.querySelector('#app').__vue_app__"
STORE = f"{APP}._instance.setupState.store"

JS = r"""(async () => {
  const fails = [];
  const ck = (label, cond, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); };
  const same = (label, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(label + ' → got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 180));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const btnIn = (s, t) => qa(s).find(b => b.textContent.trim() === t);

  window.__projects = {}; window.__projectCalls = [];

  const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
  const { useProjectStore } = await import('/src/store/projectStore.js');
  const { undo } = await import('/src/store/undo.js');
  const { describeCanvasBridge } = await import('/src/store/canvasBridge.js');
  const store = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const proj = useProjectStore(pinia);

  // ---- a) 无项目：事实源是知识库 ----
  const vaultNodesBefore = store.nodes.length;
  ck('初始画布来自知识库（vault）', store.canvasSource === 'vault', store.canvasSource);
  ck('初始画布有 Obsidian 节点', vaultNodesBefore > 0, vaultNodesBefore);
  ck('画布桥已注册', describeCanvasBridge().attached === true, describeCanvasBridge());

  // ---- b) 新建项目 → 画布切到项目文件 ----
  Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('title') || '').startsWith('项目')).click();
  for (let i = 0; i < 40 && !q('.project-panel'); i++) await tick(100);
  ck('项目面板打开', !!q('.project-panel'));
  if (!q('.project-panel')) return JSON.stringify({ fails: fails, aborted: '面板未渲染' });
  const inp = q('.project-panel .pp-input');
  inp.value = '接线测试项目';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await tick(80);
  btnIn('.project-panel .pp-btn', '新建').click();
  await tick(500);
  same('创建项目后画布事实源=项目', store.canvasSource, 'project');
  same('空项目的画布是空的', store.nodes.length, 0);
  ck('项目已打开', proj.isOpen === true);
  ck('项目实体数为 0', Object.keys(proj.entities).length === 0, Object.keys(proj.entities));

  // ---- c) 项目侧新增 → 画布跟随 ----
  const c1 = proj.createEntity({ name: '接线城', layer: 'world' });
  ck('项目侧创建实体成功', c1.success === true, c1);
  await tick(250);
  ck('画布出现该节点（项目→画布）', store.nodes.some(n => n.id === '接线城'), store.nodes.map(n => n.id));
  const cn = store.nodes.find(n => n.id === '接线城') || {};
  ck('项目实体在画布上是暂存节点（无词条→draft）', cn.draft === true, cn.draft);
  same('画布节点层级正确', cn.layer, 'world');

  // 改名同步
  proj.renameEntity('接线城', '接线城改名');
  await tick(250);
  ck('改名同步到画布', store.nodes.some(n => n.name === '接线城改名'), store.nodes.map(n => n.name));
  ck('id 未变（改名不动 id）', store.nodes.some(n => n.id === '接线城'), store.nodes.map(n => n.id));

  // 删除同步 + 撤销同步
  proj.deleteEntity('接线城');
  await tick(250);
  ck('删除同步到画布', !store.nodes.some(n => n.id === '接线城'), store.nodes.map(n => n.id));
  undo();
  await tick(300);
  ck('撤销后画布恢复该节点（否则会被下一次画布保存覆盖）', store.nodes.some(n => n.id === '接线城'), store.nodes.map(n => n.id));

  // ---- e) 画布侧新增 + 保存 → 落进项目 ----
  store.addNode({ id: '画布地点', name: '画布地点', layer: 'location', parentId: null, tags: [], sourcePath: '', coordinate: { x: 1, y: 2 } });
  await tick(150);
  await store.flushSave();          // 画布防抖保存 → 走项目侧
  await tick(300);
  ck('画布新增的节点进了项目实体（画布→项目）', !!proj.getEntity('画布地点'), Object.keys(proj.entities));

  // ---- f) 画布改坐标 + 保存项目 → 项目文件里真的更新 ----
  store.updateNodePosition('画布地点', 42, 24);
  await tick(120);
  await store.flushSave();
  await tick(250);
  await proj.flushSave();           // 项目写盘（mock 记录到 __projects）
  await tick(300);
  const savedDoc = (window.__projects || {})[proj.filePath] || null;
  ck('项目文件已写盘', !!savedDoc, proj.filePath);
  const savedEntity = savedDoc ? (savedDoc.entities || {})['画布地点'] : null;
  ck('项目文件里有该实体', !!savedEntity, savedDoc ? Object.keys(savedDoc.entities || {}) : null);
  same('项目文件里坐标已更新为画布值', savedEntity ? savedEntity.coordinate : null, { x: 42, y: 24 });

  // ---- f2) 编辑器容器（区域/建筑）也随项目落盘，并在关闭后还原 ----
  store.areaZones = { '接线测试区': [{ id: 'z1', name: '接线测试区', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }] };
  await tick(150);
  store.updateNodePosition('画布地点', 43, 25);   // 触发一次画布保存
  await tick(120);
  await store.flushSave();
  await tick(250);
  await proj.flushSave();
  await tick(300);
  const savedDoc2 = (window.__projects || {})[proj.filePath] || null;
  const editor = savedDoc2 && savedDoc2.maps ? savedDoc2.maps.editor : null;
  ck('项目文件里有编辑器容器（maps.editor）', !!editor, savedDoc2 && Object.keys(savedDoc2.maps || {}));
  ck('区域数据随项目落盘', !!(editor && editor.areaZones && editor.areaZones['接线测试区']),
     editor ? Object.keys(editor.areaZones || {}) : null);

  // ---- g) 项目打开时 reextract 被拒 ----
  const re = await store.reextract();
  ck('已打开项目时重提取被拒绝', re && re.ok === false, re);
  ck('拒绝原因给出可行做法（先关闭项目）', re && String(re.error || '').indexOf('关闭项目') >= 0, re && re.error);

  // ---- h) 关闭项目 → 画布恢复知识库工作态 ----
  proj.closeProject();
  await tick(400);
  same('关闭项目后事实源回到知识库', store.canvasSource, 'vault');
  same('画布节点数恢复为打开前的值', store.nodes.length, vaultNodesBefore);
  ck('项目已关闭', proj.isOpen === false);

  return JSON.stringify({ fails: fails });
})()"""


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    wait_for(cdp, f"{STORE}.nodes.length > 0", timeout=45, desc='地理数据加载')

    ok, res = eval_json(cdp, JS, desc='项目↔画布接线')
    if not ok:
        return False, res
    if res.get('aborted'):
        return False, f'前置步骤失败已中止：{res["aborted"]}'
    fails = res.get('fails') or []
    if fails:
        return False, (f'接线断言失败 {len(fails)} 项：' + '；'.join(fails[:8]))
    return True, ('事实源切换（vault↔project）/ 项目侧增删改同步画布 / 撤销同步画布 / 画布侧新增进项目 / '
                  '坐标与编辑器容器随项目文件落盘 / 项目态拒绝重提取 / 关闭恢复知识库工作态 —— 全部通过')
