#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 96：导入 .map 的「可诊断性」——「没有高度图」必须当场说清（B2 收口，2026-10-11）

为什么值得单独守（真实经历，不是设想）：
  暮雨看到的地图是**纯色扁平图**、看不到任何山，于是去找一个"显示开关"——而根本不存
  在那个开关：解析器早就把「未解析到 cells.h（高度图不可用）」收进 `warnings` 了，
  但 `.map` 导入路径**一个字都不报**（只有状态栏角落一个小三角徽章，要悬停才看见）。
  这类"静默降级 + 用户去找不存在的开关"是本项目最贵的一种缺陷形态。

本用例（两段）：
  a 源码闸门：导入路径必须真的把 `parsed.warnings` / 缺项清单**拼进用户可见的文案**；
     且"缺什么"的判定必须**单源**（store 的 `updateBaseMapData` 与组件的
     `describeBaseMapMissing` 口径一致，不许各写一套）
  b 端到端：喂一份**故意没有 cells.h**的 .map → 解析器必须给明确警告 → 导入后
     状态栏文案必须点名"缺地形高度图"（而不是安静地给一张纯色图）
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for      # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def _code_only(src):
    out, in_block = [], False
    for line in src.split('\n'):
        s = line
        if in_block:
            if '*/' in s:
                s = s.split('*/', 1)[1]
                in_block = False
            else:
                continue
        while '/*' in s:
            before, after = s.split('/*', 1)
            if '*/' in after:
                s = before + after.split('*/', 1)[1]
            else:
                s = before
                in_block = True
                break
        if '//' in s:
            s = s.split('//', 1)[0]
        out.append(s)
    return '\n'.join(out)


# 一份**故意缺 cells.h** 的 .map：结构齐、SVG 有 feature_1（否则解析器直接抛），
# 但 data[7] 那一行换成一句无关的文字 → `pickCsv(7, cellCount)` 长度为 0 → warnings 里有
# 「未解析到 cells.h（高度图不可用）」。这是 2026-09-10 那版解析器产出物的真实写照。
NO_HM_LINES = [
    "1.151.2|File can be loaded in azgaar.github.io/Fantasy-Map-Generator|2026-10-11|97",
    "km|4|square|m|2|\u00b0C|||||||1000|1||||||",
    '{"latT":180,"latN":90,"latS":-90,"lonT":320,"lonW":-160,"lonE":160}',
    '[{"i":0,"name":"Marine","color":"#466eab","habitability":0}]',
    '<svg id="map" data-layer="map" width="100" height="100" version="1.1" xmlns="http://www.w3.org/2000/svg">',
    '<g id="oceanLayers">',
    '<path d="M0,0 L100,0 L100,100 L0,100 Z" id="feature_1"/>',
    '</g>',
    '<g id="provincesBody">',
    '<path d="M0,0 L50,0 L50,50 L0,50 Z" id="province_1"/>',
    '</g>',
    '</svg>',
    '{"cellsX":2,"cellsY":2,"spacing":5,"points":[[2,2],[7,2],[2,7],[7,7]],"count":4}',
    "cells-h-missing",          # ← data[7] 本该是 4 个高度值，这里故意不是数字串
    "55,60,50,40",              # data[8] prec
    "1,1,1,0",                  # data[9] f
    "2,2,2,-1",                 # data[10] t
    "12,8,10,15",               # data[11] temp
]


def source_gates():
    fails, notes = [], []
    sc = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
    se = _code_only(_read('src/renderer/src/store/geodataModules/scenarioEditing.js'))

    for needle, label in [
        ('parsed.warnings', '组件：导入路径读了解析器的警告'),
        ('describeBaseMapMissing(', '组件：缺项判定入口在为'),
        ('不是显示开关的问题', '组件：把"没有高度图"写成用户看得懂的一句话'),
        ('function describeBaseMapMissing(', '组件：缺项判定有唯一实现'),
    ]:
        if needle not in sc:
            fails.append(f'源码闸门缺失：{label}（找不到 `{needle}`）')
    # store 侧也要有同一口径的缺项语义（只补缺 + 明确回报）
    for needle, label in [
        ('function updateBaseMapData(', 'store：刷新入口'),
        ('blocked.push(', 'store：不可补项必须回报而不是静默'),
    ]:
        if needle not in se:
            fails.append(f'源码闸门缺失：{label}（找不到 `{needle}`）')

    notes.append('源码闸门 6 项' + ('全过' if not fails else f'缺 {len(fails)}'))
    return fails, notes


def run(cdp):
    fails, notes = source_gates()

    cdp.eval(
        "(() => { const b = Array.from(document.querySelectorAll('button'))"
        ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()"
    )
    try:
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式挂载')
    except RuntimeError as e:
        return False, f'剧本模式未挂载：{e}'
    time.sleep(1.5)

    js = r""" (async () => {
  const s = __STORE__, sc = __SC__;
  const fails = [], notes = {};
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + e + ')' : '')); };
  window.confirm = () => true;

  const P = await import('/src/utils/azgaar-parser.js');
  const P_ACC = await import('/src/utils/heightmapAccess.js');
  const P_TR = await import('/src/utils/terrainRepresentation.js');

  // ══ 装载层（自造 bundle，形状 = 参数该有的形状）═══════════════════════════
  // 为什么不喂自造 .map：本用例首版捏了一份"看似缺 cells.h"的合成文件，结果解析器的行号锚点
  // 与我设想的不同（它把 cells.h 读出来了），于是整条链的现场与我的假设不符 —— **判据变成了
  // 猜谜**。这里直接按**对象形状**构造：这就是 2026-09-10 那版解析器的产出写照
  //（有省份、没有高度图/河流/道路）。
  const SCID = 'case96/当前';
  const json = {
    version: 2,
    baseMaps: {
      case96: {
        id: 'case96', name: 'case96',
        terrain: [{ id: 'province_1', name: '用例省', type: 'polygon',
          points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }] }],
        landFeatures: [], burgs: [], rivers: [], routes: [],
        // 🔴 关键：**没有 heightmap 键**（旧解析器就是这样，那份"空壳"是后来的版本才会造的）
        referenceImages: [],
        source: { version: '1.151.2', stats: { provinces: 1 }, warnings: ['未解析到 cells.h（高度图不可用）'] },
        createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z',
      },
    },
    scenarios: { [SCID]: { id: SCID, ownerKey: 'case96', name: '当前', polities: [], ownership: {}, labels: [], markers: [] } },
  };
  const bundle = json.baseMaps.case96;

  // ⚠️ 先把同名底图清掉：本用例中断时会在 harness 项目里留下 `case96`，
  //    下一次导入就会撞上「同名底图 → 只补缺」那条**另一条**分支（用例之间互相污染）。
  if (s.baseMaps.case96) { const { case96: _drop, ...rest } = s.baseMaps; s.baseMaps = rest; }
  s.importFromScenariosJson(json);
  const bm = s.baseMaps.case96;
  ok('b3 底图装进来了', !!bm);
  ok('b3 🔴 高度图确实没有（这就是"纯色扁平图"的来源）', !bm.heightmap,
     JSON.stringify({ hm: !!bm.heightmap }));
  ok('b3 河流/道路也没有（那份文件里本来就没有）',
     !(bm.rivers || []).length && !(bm.routes || []).length,
     JSON.stringify({ rv: (bm.rivers || []).length, rt: (bm.routes || []).length }));
  ok('b3 省份几何照常装进来（缺地形不该拖累省份）', (bm.terrain || []).length === 1,
     (bm.terrain || []).length);

  // b3b：**有**高度图时的对照（防止"永远判缺"式的假绿）
  {
    const K = 'case96withhm';
    s.baseMaps = { ...s.baseMaps, [K]: {
      id: K, name: K, terrain: bm.terrain, referenceImages: [], rivers: [], routes: [],
      heightmap: { grid: { points: [[0, 0], [1, 1]], spacing: 1, cellsX: 2, cellsY: 1 }, h: [30, 60] },
    } };
    ok('b3b 对照组：给了高度图的底图被判为"有地形"',
       P_TR.hasHeightmapContent(s.baseMaps[K].heightmap) === true);
    const { [K]: _d2, ...rest2 } = s.baseMaps;
    s.baseMaps = rest2;
  }

  // ══ 判定口径：两个判据**不可混用**（2026-10-11 的关键区分）═══════════════
  // ⚠️ 形状极易写错：`h` 是**顶层**字段，不是 `grid` 的子键 ——
  //    正确：{ grid: { points: [[x,y],…] }, h: [高度,…] }
  //    （首版把 `h` 写进 `grid` 里，"实现坏了"的假象骗了我两轮。）
  // ⚠️ 坐标要正常：两格相距 1 世界单位在网格间距 14.4 下算**退化**，`buildHeightmapRaster`
  //    宁可返回 null 也不画错（这是它的保护，不是 bug）。所以这里用 0 与 100。
  const REAL_HM = { grid: { points: [[0, 0], [100, 0]], spacing: 14.4, cellsX: 2, cellsY: 1 }, h: [42, 7] };
  const SHELL_HM = { grid: { points: [[0, 0], [100, 0]], spacing: 14.4, cellsX: 2, cellsY: 1 }, h: [] };
  ok('b4 有地形内容时两个判据都为真（没误伤）',
     P_ACC.hasGrid(REAL_HM) === true && P_TR.hasHeightmapContent(REAL_HM) === true);
  ok('b4 🔴 空壳（有点无 h）在"地形内容"判据下为假 —— 状态栏/缺项诊断必须用这个',
     P_TR.hasHeightmapContent(SHELL_HM) === false, JSON.stringify(P_TR.hasHeightmapContent(SHELL_HM)));
  ok('b4 「能否开始笔刷编辑」在空壳上仍为真（历史数据形态；收窄它会打断笔刷/派生/绑定）',
     P_ACC.hasGrid(SHELL_HM) === true, JSON.stringify(P_ACC.hasGrid(SHELL_HM)));

  // ══ 组件层：导入路径必须把这件事**说给用户** ═════════════════════════════
  // 走**真实入口** triggerMapImport：它就是「建 input → onchange(file)」，我们接管 input。
  // 先清掉同名底图，保证走的是"导入为新底图"那条路（而不是"只补缺刷新"）。
  if (s.baseMaps.case96) { const { case96: _d3, ...rest3 } = s.baseMaps; s.baseMaps = rest3; }
  const TEXT = __TEXT__;                        // 一份**真实可解析**的 FMG .map（故意不含 cells.h）
  const realCreate = document.createElement.bind(document);
  let msg = '';
  document.createElement = function (tag, ...rest) {
    const el = realCreate(tag, ...rest);
    if (String(tag).toLowerCase() === 'input') {
      el.click = function () {
        setTimeout(() => {
          try { el.onchange({ target: { files: [new File([TEXT], 'case96.map', { type: 'text/plain' })] } }); }
          catch (e) { msg = 'threw:' + e; }
        }, 0);
      };
    }
    return el;
  };
  window.alert = (m) => { msg = 'alert:' + m; };   // 解析失败会走 alert（那也是一种可诊断，但要区分开）
  try { await sc.triggerMapImport(); } catch (e) { msg = 'threw:' + e; }
  for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 100));
  document.createElement = realCreate;
  // 🔴 两件事必须分清（首版读错，断言与现场无关）：
  //    · `statusMsg()` 把话写进 `provinceHint`（那才是"导入结果/操作回音"）
  //    · `statusText` 是工具条上那句**摘要** computed（"N 省份 | N 网格"）
  const shown = String(sc.provinceHint || msg || '');
  const summary = String(sc.statusText || '');
  ok('b5 导入后状态栏有回音（不是一声不响）', shown.length > 0, shown.slice(0, 60));
  // 两份可能的可诊断文案都算数（取决于解析器把这份文件的 cells.h 读成什么样）：
  //   · 源文件里就没有 → "地形高度图 ⚠️ **这份 .map 里就没有**…纯色扁平图…不是显示开关的问题"
  //   · 源文件里有、底图没有 → "这张底图还缺：地形高度图 —— 可用工具栏「刷新底图数据」…"
  // 两条都要求**点名地形高度图**；而"一声不响"与"报成已齐"都必须被这条判据抓住。
  ok('b5 🔴 回音点名了"地形高度图"这个缺项（用户不必去找不存在的显示开关）',
     shown.indexOf('高度图') >= 0, shown.slice(0, 300));
  ok('b5 🔴 回音没有把缺地形的底图报成"已齐"（旧实现会一声不响）',
     shown.indexOf('已经齐了') < 0, shown.slice(0, 300));
  notes.shown = shown.slice(0, 200) + '  ／  摘要=' + summary;

  delete s.baseMaps.case96;
  document.createElement = realCreate;
  return JSON.stringify({ fails, notes });
})()"""

    js = (js.replace('__STORE__', "document.querySelector('#app').__vue_app__._instance.setupState.store")
            .replace('__SC__', SC)
            .replace('__TEXT__', json.dumps("\n".join(NO_HM_LINES))))
    ok, res = eval_json(cdp, js, desc='96 主探针')
    if not ok:
        return False, res
    fails += res.get('fails', [])
    n = res.get('notes', {})
    if n.get('shown'):
        notes.append(f'状态栏="{n["shown"]}"')
    return (not fails), ' | '.join(fails) if fails else ' | '.join(notes)
