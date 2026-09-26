#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 68：M1c —— 剧本地形的「冻结导入 / 跟随行星」双模式

背景（用户决策 2026-09-25）：
  「历史剧本是三大模块中最独立完整的、一次施工永久存档」—— 强行把剧本绑到行星数据上**有风险**：
  跟随 = 共用同一份 → 行星后来怎么改，剧本跟着变。对**当代、与行星同步构建的地图**这是对的；
  对**历史存档剧本**是灾难（存档要的就是冻住）。
  A1 文档最初否掉「复制」方案（理由：复制即双源、漂移必然回归）—— 那条判断在**同步构建**场景
  成立，在**存档**场景恰恰相反。所以最终形态是**两种模式并存、冻结为默认、跟随需显式选择**。

覆盖：
  f1 **冻结导入**：副本独立 —— 与行星**不是同一个对象**（连 h 数组也是副本）；
     在剧本涂山**不影响行星**，行星改地形**不影响剧本**；标注来源；`describeBaseMapTerrain` = frozen
  f2 **跟随**：读取命中行星**同一对象**（真单源）；在剧本涂山**会改到行星**；解绑后底图回到
     「没有地形」且**行星那份不受影响**（这是 R2/M1c 的语义边界）
  f3 **覆盖需确认**：底图已有地形时冻结导入返回 conflict；`force:true` 才覆盖
  f4 **UI**：地形来源控件 / 两个按钮 / 模式标签真实渲染；按钮 title 写清取舍
     （「复制一份」vs「会改到行星」—— 用户看的就是这句话）

设计要点（为什么这样断言）：f1 与 f2 是**互为反面**的一对 ——
同一句「在剧本里涂山」，冻结模式下行星必须**不变**，跟随模式下行星必须**变**。
只测一边等于没测：任何"两边其实是同一份"或"其实从来没接上"的实现都能骗过单边断言。
"""
import sys, os, json, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib import helpers as H  # noqa: E402
from lib.cdp import wait_for, eval_json  # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"

JS = r"""(async () => {
  const fails = [];
  const notes = [];
  const ck = (label, cond, extra) => {
    if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  };
  const same = (label, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(label + ' → got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));
  };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 200));
  const sumArr = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };
  const centerOf = (hm) => {
    const p = hm.grid.points[Math.floor(hm.grid.points.length / 2)];
    return [Array.isArray(p) ? p[0] : p.x, Array.isArray(p) ? p[1] : p.y];
  };

  const store = PLACEHOLDER_STORE;

  // ── 装置：一颗带高度图的行星 ────────────────────────────────────────────
  const pid = Object.keys(store.mapData || {}).find(k =>
    store.mapData[k] && store.mapData[k].heightmap && store.mapData[k].heightmap.grid);
  ck('装置：存在带高度图的行星地图', !!pid, { keys: Object.keys(store.mapData || {}).slice(0, 5) });
  if (!pid) return JSON.stringify({ fails, notes });

  // ══ f1 冻结导入：副本独立 ══════════════════════════════════════════
  const K1 = 'M1c冻结用例底图';
  if (!store.baseMaps[K1]) store.addBaseMap(K1, { name: K1 });
  const r1 = store.importHeightmapFromPlanet(K1, pid, { planetName: '冻结源行星' });
  ck('f1 冻结导入成功', !!(r1 && r1.ok === true), r1);

  const bm1 = store.baseMaps[K1];
  const pHm = store.mapData[pid].heightmap;
  ck('f1 底图拿到了高度图网格', !!(bm1.heightmap && bm1.heightmap.grid), null);
  ck('f1 ★ 与行星那份**不是同一个对象**（副本，而非共享）', bm1.heightmap !== pHm, null);
  ck('f1 ★ h 数组也是独立副本（引用同一个 TypedArray 就等于偷偷绑定了）',
     bm1.heightmap.h !== pHm.h, null);
  ck('f1 标注了冻结来源（纯展示，不是引用）',
     !!(bm1.terrainFrozenFrom && bm1.terrainFrozenFrom.name === '冻结源行星'), bm1.terrainFrozenFrom);
  same('f1 describe = frozen', store.describeBaseMapTerrain(K1).mode, 'frozen');

  const pHmNow = store.mapData[pid].heightmap;
  const c1 = centerOf(bm1.heightmap);
  const pBefore = sumArr(pHmNow.h);
  store.applyHeightBrush(K1, c1[0], c1[1], 140, 50, 'raise');       // 在**剧本**里涂山
  const pAfter = sumArr(store.mapData[pid].heightmap.h);
  ck('f1 ★ 在剧本里涂山 **不影响行星**（这正是「冻结」的全部意义）',
     pAfter === pBefore, { before: +pBefore.toFixed(1), after: +pAfter.toFixed(1) });
  ck('f1 底图自己确实变了（不是"什么也没发生"）',
     sumArr(store.baseMaps[K1].heightmap.h) > pBefore, null);

  const bFrozen0 = sumArr(store.baseMaps[K1].heightmap.h);
  store.mapData[pid].heightmap.h[0] = 99;                            // 直接改**行星**内存
  ck('f1 ★ 反过来：行星改地形 **不影响剧本**（单向不成立 = 其实还是同一份）',
     sumArr(store.baseMaps[K1].heightmap.h) === bFrozen0, null);

  // ══ f2 跟随：共用同一份 ═════════════════════════════════════════════
  const K2 = 'M1c跟随用例底图';
  if (!store.baseMaps[K2]) store.addBaseMap(K2, { name: K2 });
  const r2 = store.bindBaseMapToPlanet(K2, pid);
  ck('f2 跟随成功', !!(r2 && r2.ok === true), r2);
  ck('f2 ★ 跟随态读取命中行星那一份（同一个对象 = 真单源）',
     store.getHeightmapFor(K2) === store.mapData[pid].heightmap, null);
  same('f2 describe = following', store.describeBaseMapTerrain(K2).mode, 'following');

  const c2 = centerOf(store.mapData[pid].heightmap);
  const pBefore2 = sumArr(store.mapData[pid].heightmap.h);
  store.applyHeightBrush(K2, c2[0], c2[1], 140, 50, 'raise');       // 在**剧本**里涂山
  ck('f2 ★ 跟随态：在剧本里涂山 **会改到行星**（与冻结正好相反）',
     sumArr(store.mapData[pid].heightmap.h) > pBefore2, null);

  const pBefore3 = sumArr(store.mapData[pid].heightmap.h);
  store.unbindBaseMap(K2);
  ck('f2 解绑后底图不再持地形', !store.baseMaps[K2].heightmap, null);
  same('f2 describe 解绑后 = empty', store.describeBaseMapTerrain(K2).mode, 'empty');
  ck('f2 ★ 解绑不影响行星那份（解绑不是"把地形带走"）',
     sumArr(store.mapData[pid].heightmap.h) === pBefore3, null);

  // ══ f3 覆盖需确认 ═══════════════════════════════════════════════════
  const r3 = store.importHeightmapFromPlanet(K1, pid, { planetName: '冻结源行星' });
  ck('f3 底图已有地形 → 返回 conflict（由 UI 问一次，不静默覆盖）',
     !!(r3 && r3.conflict === true && r3.conflictKind === 'basemap-has-terrain'), r3);
  const sumBeforeForce = sumArr(store.baseMaps[K1].heightmap.h);
  const r4 = store.importHeightmapFromPlanet(K1, pid, { force: true, planetName: '冻结源行星' });
  ck('f3 force=true 才覆盖', !!(r4 && r4.ok === true), r4);
  ck('f3 覆盖后确实是行星那份的值（内容一致，但仍不是同一对象）',
     sumArr(store.baseMaps[K1].heightmap.h) !== sumBeforeForce
     && store.baseMaps[K1].heightmap !== store.mapData[pid].heightmap, null);

  // ══ f4 UI（真实 DOM） ═══════════════════════════════════════════════
  const box = document.querySelector('[data-testid="basemap-terrain-source"]');
  ck('f4 地形来源控件已渲染', !!box, { scenarioMounted: !!document.querySelector('.scenario-map-container') });
  const fBtn = document.querySelector('[data-testid="basemap-freeze-import"]');
  const bBtn = document.querySelector('[data-testid="basemap-bind-planet"]');
  ck('f4 「冻结导入」按钮存在', !!fBtn, null);
  ck('f4 「跟随」按钮存在', !!bBtn, null);
  ck('f4 模式标签存在', !!document.querySelector('[data-testid="basemap-terrain-mode"]'), null);
  const ft = fBtn ? (fBtn.getAttribute('title') || '') : '';
  const bt = bBtn ? (bBtn.getAttribute('title') || '') : '';
  ck('f4 冻结按钮的说明写了「复制」（用户看的就是这句话）', /复制/.test(ft), ft.slice(0, 80));
  ck('f4 跟随按钮的说明写明了「会改到行星」', /改到行星/.test(bt), bt.slice(0, 80));
  notes.push('UI 模式标签 = ' + (document.querySelector('[data-testid="basemap-terrain-mode"]') || {}).textContent);

  return JSON.stringify({ fails, notes });
})()"""


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    wait_for(cdp, f"{STORE}.nodes.length > 0", timeout=45, desc='地理数据加载')

    # 进入剧本模式（ScenarioMap 懒加载；与 test_52 同一条既有链路）
    entered = cdp.eval("""(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('历史剧本'));
      if (!btn) return 'no-btn';
      btn.click();
      return 'ok';
    })()""")
    if entered != 'ok':
        return False, f'未找到「历史剧本」入口（{entered}）'
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=20, desc='ScenarioMap 挂载')
    time.sleep(1.0)

    # 底图 fixture（司天不再默认建底图；不选中底图则控件 v-if 不渲染）
    bm_ok, bm_info = H.open_test_base_map(cdp, '用例68底图')
    if not bm_ok:
        return False, f'底图 fixture 未就位（scenarios 加载链路没走通）: {bm_info}'
    time.sleep(0.4)

    # ⚠️ 底图选择器与「地形来源」控件都在工具栏的「更多」里（P3 起默认收起）——
    #    不展开的话 DOM 里根本没有这些节点，f4 会整片假红（实测踩到）。
    if not H.open_toolbar_more(cdp):
        return False, '未能展开剧本工具栏「更多」（底图与地形来源控件在里面）'

    ok, res = eval_json(cdp, JS.replace('PLACEHOLDER_STORE', STORE), desc='M1c 地形双模式')
    if not ok:
        return False, res
    if isinstance(res, dict):
        fails = res.get('fails') or []
        if fails:
            return False, f'M1c 断言失败 {len(fails)} 项：' + '；'.join(str(x) for x in fails[:10])
        notes = res.get('notes') or []
        return True, ('冻结（副本独立、双向不串）/ 跟随（真单源、会改到行星）/ 解绑边界 / '
                      '覆盖需确认 / UI 与文案 —— 全部通过'
                      + ('；' + '；'.join(notes) if notes else ''))
    return False, f'用例返回值异常：{str(res)[:200]}'
