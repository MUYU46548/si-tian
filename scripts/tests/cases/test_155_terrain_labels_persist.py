#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 155：地形注记（`terrainLabels`）随项目落盘 / 重开还原

背景（D3 收口，2026-10-27）：
  `test_154` 只验到「面板 → 检测 → 命名 → 落进内存 + 一次 undo」。
  但地形注记住在 `baseMaps[key]` 里 —— 这条链要经过三层才到磁盘：
    ① 画布 → 项目载荷：`exportCanvasToProject()` → `exportScenariosPayload()`（整份 baseMaps 深拷贝）
    ② 项目 → 磁盘：`saveProject()` → `toIpcJson` → 主进程原子写
    ③ 磁盘 → 画布：`openProject()` → `applyProjectToCanvas()` → `applyScenarioState(fresh)`
  其中任何一层若是「按字段白名单重建底图对象」，`terrainLabels` 就会**静默消失**
  （不报错、不告警；重开项目后山系名凭空不见 —— 与「坐标缓存被当事实源」同一类事故）。
  这条用例就是给这条链上闸：**逐字段**比对落盘载荷与重开后的内存态。

判据（全部读真实状态/落盘载荷）：
  1. 经 store 新写口 `applyTerrainLabels` 落 4 条（range×2 / sea / plain，含 1 条 `origin:'user'`）；
     无名与点不足的脏数据被丢弃（归一化在写入口，不在读侧）；
  2. 落盘载荷 `scenarios.baseMaps[key].terrainLabels` 与内存**逐字段一致**（id/kind/name/points/origin）；
  3. `closeProject` → `openProject` 后，内存里的注记仍**逐字段一致**；
  4. 重开后再渲染一次：不抛异常、渲染护栏未暂停、画布有像素（注记真的被画出来）；
  5. 重开后一次 undo 不把注记弄丢（新会话的撤销栈从空开始 —— 乱退会把用户数据退没）。
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for                                  # noqa: E402
from lib.helpers import ensure_case_state                               # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
KEY = '用例155底图'

LABELS = [
    {'id': 'tl_range', 'kind': 'range', 'name': '测试山脉',
     'points': [{'x': 100, 'y': 100}, {'x': 200, 'y': 180}, {'x': 300, 'y': 260}],
     'origin': 'auto'},
    {'id': 'tl_user', 'kind': 'range', 'name': '手绘山脊',
     'points': [{'x': 120, 'y': 320}, {'x': 260, 'y': 380}],
     'origin': 'user'},
    {'id': 'tl_sea', 'kind': 'sea', 'name': '测试海',
     'points': [{'x': 400, 'y': 100}, {'x': 520, 'y': 140}],
     'origin': 'user'},
    {'id': 'tl_plain', 'kind': 'plain', 'name': '测试平原',
     'points': [{'x': 200, 'y': 400}],
     'origin': 'user'},
    # 脏数据：没名字 / 点不够（kind=range 至少要 2 个点）→ 写入口必须丢掉
    {'id': 'tl_noname', 'kind': 'range', 'name': '   ',
     'points': [{'x': 10, 'y': 10}, {'x': 20, 'y': 20}]},
    {'id': 'tl_bad', 'kind': 'range', 'name': '坏几何',
     'points': [{'x': 'a', 'y': 1}]},
]


def run(cdp):
    wait_for(cdp, "!!document.querySelector('#app')", desc='应用挂载', timeout=15)
    ensure_case_state(cdp)
    r = cdp.eval("""(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('历史剧本'));
      if (!btn) return 'no-btn'; btn.click(); return 'ok';
    })()""")
    if r != 'ok':
        return False, f'进入历史剧本失败：{r}'
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", desc='ScenarioMap 挂载', timeout=8)

    # ① 造底图 + 经新写口落 4 条注记（两个脏条目必须被归一化丢掉）
    seed_js = r"""(async () => {
      const s = __STORE__, SM = __SM__, KEY = __KEY__;
      const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
      if (s.baseMaps[KEY]) s.removeBaseMap(KEY);
      s.addBaseMap(KEY, { name: KEY });
      s.addBaseProvince(KEY, { id: 'p155', name: '省155', kind: 'land',
        points: [{x:60,y:60},{x:700,y:60},{x:700,y:620},{x:60,y:620}] }, { checkOverlap: false });
      s.createScenario(KEY + '/甲', {
        ownerKey: KEY, name: '甲', order: 1, group: 'default',
        era: { roman: 'Ⅰ', label: '甲', startYear: '2000', endYear: '2010' },
        polities: [{ id: 'P1', name: '甲国', color: '#c23b3b' }],
        ownership: { p155: 'P1' },
      });
      SM.baseMapKey = KEY;
      if (typeof SM.onBaseMapChange === 'function') await SM.onBaseMapChange();
      SM.tlEra = 0;
      SM.tlDate = { y: 2000, m: null, d: null };
      SM.showTerrainNames = true;
      await tick(80);
      const res = s.applyTerrainLabels(KEY, __LABELS__);
      await tick(120);
      const labels = (s.baseMaps[KEY] || {}).terrainLabels || [];
      let painted = false, renderError = '', paused = false, guardError = '';
      try { SM.render(); } catch (e) { renderError = String((e && e.message) || e); }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await tick(120);
      try {
        const cv = document.querySelector('.scenario-map-container canvas');
        if (cv) {
          const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
          for (let k = 3; k < d.length; k += 4) { if (d[k]) { painted = true; break; } }
        }
      } catch (e) { renderError = renderError || String((e && e.message) || e); }
      paused = !!SM.renderPaused; guardError = String(SM.renderError || '').slice(0, 120);
      return JSON.stringify({
        ok: !!(res && res.ok), count: labels.length, labelKinds: labels.map(l => l.kind),
        labelOrigins: labels.map(l => l.origin), labels: labels,
        painted, renderError, paused, guardError,
      });
    })()"""
    applied_js = (seed_js.replace('__STORE__', STORE).replace('__SM__', SM)
                  .replace('__KEY__', json.dumps(KEY))
                  .replace('__LABELS__', json.dumps(LABELS, ensure_ascii=False)))
    ok, applied = eval_json(cdp, applied_js, required=('count',), desc='落 4 条地形注记')
    if not ok:
        return False, f'造数/落库求值失败：{applied}'
    fails = []
    if not applied.get('ok'):
        fails.append(f"写口拒绝：{applied}")
    if int(applied.get('count') or 0) != 4:
        fails.append(f"应落 4 条（脏数据被丢），实际 {applied.get('count')}：{applied.get('labels')}")
    if applied.get('renderError'):
        fails.append(f"落库后重绘抛异常：{applied.get('renderError')}")
    if applied.get('paused'):
        fails.append(f"渲染护栏已暂停（guardError={applied.get('guardError')}）")
    if not applied.get('painted'):
        fails.append('落库后画布没有像素 —— 注记没画出来')
    want = json.dumps(applied.get('labels') or [], ensure_ascii=False)

    # ② 保存 → 落盘载荷必须逐字段带上
    save_js = r"""(async () => {
      const app = document.querySelector('#app').__vue_app__;
      const ps = (await import('/src/store/projectStore.js')).useProjectStore(app.config.globalProperties.$pinia);
      const KEY = __KEY__;
      const s = __STORE__;
      const fp = ps.filePath;
      const before = JSON.stringify(((s.baseMaps[KEY] || {}).terrainLabels) || []);
      const r = await ps.saveProject({ label: 'case155' });
      const saved = window.__probe.lastProject();
      const bm = ((((saved || {}).scenarios || {}).baseMaps) || {})[KEY] || {};
      const fl = bm.terrainLabels || [];
      return JSON.stringify({
        ok: !!(r && r.success), error: (r && r.error) || '', fp: String(fp || ''),
        before: before, savedCount: fl.length, saved: fl,
        savedNames: fl.map(l => l.name), savedOrigins: fl.map(l => l.origin),
      });
    })()"""
    ok, saved = eval_json(cdp, save_js.replace('__STORE__', STORE).replace('__KEY__', json.dumps(KEY)),
                          required=('ok', 'savedCount'), desc='保存项目')
    if not ok:
        return False, f'保存求值失败：{saved}'
    if not saved.get('ok'):
        fails.append(f"saveProject 失败：{saved.get('error')}")
    if int(saved.get('savedCount') or 0) != 4:
        fails.append(f"落盘载荷里注记条数不对（{saved.get('savedCount')}）：{saved.get('savedNames')}")
    saved_json = json.dumps(saved.get('saved') or [], ensure_ascii=False)
    if saved_json != want:
        fails.append(f'落盘载荷与内存不一致：\n  内存={want[:300]}\n  磁盘={saved_json[:300]}')
    fp = saved.get('fp') or ''
    if not fp:
        fails.append('拿不到项目文件路径（无法验证重开）')

    # ③ 关项目 → 重开：内存态必须原样带回
    reopen_js = r"""(async () => {
      const app = document.querySelector('#app').__vue_app__;
      const ps = (await import('/src/store/projectStore.js')).useProjectStore(app.config.globalProperties.$pinia);
      const KEY = __KEY__, FP = __FP__;
      const s = __STORE__, SM = __SM__;
      const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
      const closed = await ps.closeProject();
      await tick(400);
      const afterClose = (((s.baseMaps[KEY] || {}).terrainLabels) || []).length;
      const opened = await ps.openProject(FP);
      await tick(800);
      const labels = (((s.baseMaps[KEY] || {}).terrainLabels) || []);
      SM.baseMapKey = KEY;
      if (typeof SM.onBaseMapChange === 'function') await SM.onBaseMapChange();
      SM.showTerrainNames = true;
      await tick(150);
      let painted = false, renderError = '', paused = false, guardError = '';
      try { SM.render(); } catch (e) { renderError = String((e && e.message) || e); }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await tick(150);
      try {
        const cv = document.querySelector('.scenario-map-container canvas');
        if (cv) {
          const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
          for (let k = 3; k < d.length; k += 4) { if (d[k]) { painted = true; break; } }
        }
      } catch (e) { renderError = renderError || String((e && e.message) || e); }
      paused = !!SM.renderPaused; guardError = String(SM.renderError || '').slice(0, 120);
      // 新会话的撤销栈必须从空开始：乱退会把刚打开的项目数据退没
      const undoLabel = String(s.undoLabel || '');
      return JSON.stringify({
        closed: !!(closed && closed.success), opened: !!(opened && opened.success),
        openError: (opened && opened.error) || '',
        afterClose: afterClose, count: labels.length, labels: labels,
        painted, renderError, paused, guardError, undoLabel,
        undoDepth: (s.undoStack && s.undoStack.length) || 0,
      });
    })()"""
    ok, reopened = eval_json(cdp, reopen_js.replace('__STORE__', STORE).replace('__SM__', SM)
                            .replace('__KEY__', json.dumps(KEY)).replace('__FP__', json.dumps(fp)),
                            required=('opened', 'count'), desc='关项目后重开')
    if not ok:
        return False, f'重开求值失败：{reopened}'
    if not reopened.get('closed'):
        fails.append('closeProject 失败')
    if not reopened.get('opened'):
        fails.append(f"openProject 失败：{reopened.get('openError')}")
    if int(reopened.get('afterClose') or 0) != 0:
        fails.append(f"关项目后注记应清空（回到知识库态），实际还有 {reopened.get('afterClose')} 条")
    if int(reopened.get('count') or 0) != 4:
        fails.append(f"重开后注记丢了：内存 {reopened.get('count')} 条")
    reopen_json = json.dumps(reopened.get('labels') or [], ensure_ascii=False)
    if reopen_json != want:
        fails.append(f'重开后注记与保存前不一致：\n  保存前={want[:300]}\n  重开后={reopen_json[:300]}')
    if reopened.get('renderError'):
        fails.append(f"重开后重绘抛异常：{reopened.get('renderError')}")
    if reopened.get('paused'):
        fails.append(f"重开后渲染护栏暂停（guardError={reopened.get('guardError')}）")
    if not reopened.get('painted'):
        fails.append('重开后画布没有像素 —— 重开的项目没画出来')

    if fails:
        return False, '；'.join(fails)[:900] + ' | 实测：' + json.dumps(
            {'applied': {k: applied.get(k) for k in ('count', 'labelKinds', 'painted')},
             'saved': {k: saved.get(k) for k in ('savedCount', 'savedNames')},
             'reopened': {k: reopened.get(k) for k in ('count', 'painted', 'undoDepth')}},
            ensure_ascii=False)[:500]
    return True, (f"落 4 条（脏数据已丢）→ 落盘载荷逐字段一致 → 关/开项目后 4 条原样带回"
                  f"（含 origin=auto/user）→ 重开画布有像素、护栏未暂停")
