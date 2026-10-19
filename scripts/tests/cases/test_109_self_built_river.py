#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 109：**司天自己画的地必须能长出河**（2026-10-17，暮雨定的方向）

用户原话（这一条改变了整个方向）：
    「用户甚至不是必须用外部软件导出地图再放进司天做历史剧本的，
      司天自身的编辑能力必须过硬，**不要指望靠用户导出高度数据地图来救河流生成**。」

修之前的产品事实（三条串起来就是一个死结，而且**全都不报错**）：
  ① `generateRivers()` 遇到 `!hasGrid(hm)` 直接返回 `no-heightmap` —— 自建底图**没有河**；
  ② 「建高度图」按钮建出来的是 `new Float32Array(n)`（**全 0**），而海平面是 20
     → 整张图变成**全海平面的平地** → 平地没有坡 → 自动河流**永远是 0 条**；
  ③ 于是「画大陆 → 建高度图 → 点自动河流」这条路走不通，用户被推向外部工具 ——
     而那正是暮雨明确否掉的那条路。

本用例守四件事：
  a **源码闸门**：`generateRivers` 不许再无条件下 `no-heightmap` 拒绝；推演必须接上；
     分量入口必须导出、且 UI 有可发现按钮（`data-testid` + 可见文字）。
  b **推演本身是对的**（纯函数层）：给定一块陆地，推出来的高度场必须
     ① 有真实起伏（不是常数）② 内陆高于海岸 ③ **每一格都排得出去**（无洼地）。
  c **端到端**：自建底图（**完全没有高度图**）→ 点自动河流 → 必须出河，
     且河网必须**真的汇聚**（`segMaxFlow` 远大于 1）。
  d **对照组必须有判别力**：同样的底图，若把高度图换成"全 0 平地"（旧「建高度图」的产物），
     自动河流必须**明显更差/为 0** —— 否则 c 段的绿不能证明推演起了作用。
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from lib.cdp import eval_json, wait_for      # noqa: E402
from lib.helpers import ensure_case_state    # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"

SYN = os.path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'terrainSynthesis.js')
SE = os.path.join(ROOT, 'src', 'renderer', 'src', 'store', 'geodataModules', 'scenarioEditing.js')
SMV = os.path.join(ROOT, 'src', 'renderer', 'src', 'components', 'ScenarioMap.vue')


def _read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()


def _code_only(src):
    """剥注释（判据看代码，不看说明文字）"""
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


def source_gates():
    fails, notes = [], []
    syn = _code_only(_read(SYN))
    se = _code_only(_read(SE))
    smv = _code_only(_read(SMV))

    # a① 推演模块必须是纯函数层、且真的做了"填洼 + 多频段噪声"这两件关键事
    for needle, why in [
        ('export function synthesizeHeightmapFromTerrain', '推演入口'),
        ('function fillDepressions', '洼地填平（没有它就会满地平行流）'),
        ('highFreq', '高频起伏段（没有它水会平行下流）'),
    ]:
        if needle not in syn:
            fails.append(f'🔴 terrainSynthesis 缺 {why}（找不到 `{needle}`）')

    # a② store 里必须"推演后才可能拒绝"，而不是无条件 no-heightmap
    if 'synthesizeHeightmapFromTerrain' not in se:
        fails.append('🔴 generateRivers 没有接推演 —— 自建底图又会直接 `no-heightmap`')
    if 'no-heightmap' in se and 'synthesizeHeightmapFromTerrain' in se:
        # 允许保留字符串（有别的函数在用），但检查它**不再出现在 generateRivers 的拒绝里**
        seg = se[se.index('function generateRivers'):]
        seg = seg[:seg.index('\n  }\n') + 4] if '\n  }\n' in seg else seg[:4000]
        if 'no-heightmap' in seg:
            fails.append('🔴 generateRivers 仍在拒绝 `no-heightmap`（推演没有真正取代它）')
    if 'export' not in se and 'synthesizeBaseMapTerrain' not in se:
        fails.append('🔴 store 没有导出 `synthesizeBaseMapTerrain`（显式落库入口）')

    # a③ UI 可发现性：必须有 data-testid + **可见文字**（只靠图标/ title 不算）
    if 'data-testid="basemap-synthesize-terrain"' not in smv:
        fails.append('🔴 没有「按轮廓生成地形」按钮（`data-testid="basemap-synthesize-terrain"`）')
    if '按轮廓生成地形' not in smv:
        fails.append('🔴 按钮没有**可见文字**（暮雨实测过：只有图标 = 找不到）')

    notes.append(f'源码闸门 6 组{"全过" if not fails else f"缺 {len(fails)}"}')
    return fails, notes


JS_MAKE_BASEMAP = r"""
(async () => {
  const store = __STORE__;
  const KEY = 'case109';
  const mkRing = (cx, cy, r, n, wobble, seed) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const w = 1 + Math.sin(a * 3 + seed) * wobble + Math.sin(a * 7 + seed * 2) * wobble * 0.5;
      pts.push({ x: cx + Math.cos(a) * r * w, y: cy + Math.sin(a) * r * w * 0.72 });
    }
    return pts;
  };
  const a = { id: 'p1', name: 'A', kind: 'land', color: '#c9a06a', points: mkRing(0, 0, 900, 90, 0.16, 1.2) };
  const b = { id: 'p2', name: 'B', kind: 'land', color: '#a8b98a', points: mkRing(600, 380, 330, 50, 0.2, 2.7) };
  store.baseMaps = { ...store.baseMaps, [KEY]: {
    id: KEY, name: KEY, terrain: [a, b], referenceImages: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } };
  const sc = __SC__;
  sc.baseMapKey = KEY;
  if (typeof sc.onBaseMapChange === 'function') sc.onBaseMapChange();
  await new Promise(r => setTimeout(r, 320));
  return JSON.stringify({ ok: true, hasHeightmap: !!store.getHeightmapFor(KEY)?.grid });
})()
"""

# 对照组：造一份"全 0 平地"高度图（旧「建高度图」的产物），验证它确实长不出河
JS_FLAT_CONTRAST = r"""
(async () => {
  const store = __STORE__;
  const KEY = 'case109flat';
  const mkRing = (cx, cy, r, n, wobble, seed) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const w = 1 + Math.sin(a * 3 + seed) * wobble + Math.sin(a * 7 + seed * 2) * wobble * 0.5;
      pts.push({ x: cx + Math.cos(a) * r * w, y: cy + Math.sin(a) * r * w * 0.72 });
    }
    return pts;
  };
  const a = { id: 'p1', name: 'A', kind: 'land', color: '#c9a06a', points: mkRing(0, 0, 900, 90, 0.16, 1.2) };
  // 97x73 全 0 平地（与推演网格同量级，公平对照）
  const cols = 97, rows = 73, sp = 20.5, pts = [], h = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    pts.push([-950 + i * sp, -780 + j * sp]);
    h.push(0);
  }
  store.baseMaps = { ...store.baseMaps, [KEY]: {
    id: KEY, name: KEY, terrain: [a], referenceImages: [],
    heightmap: { h, grid: { points: pts, cellsX: cols, cellsY: rows, spacing: sp } },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } };
  const sc = __SC__;
  sc.baseMapKey = KEY;
  if (typeof sc.onBaseMapChange === 'function') sc.onBaseMapChange();
  await new Promise(r => setTimeout(r, 320));
  const r = store.generateRivers(KEY, {});
  return JSON.stringify({ ok: !!r.ok, rivers: (r.rivers || []).length, segs: (r.segments || []).length,
    segMaxFlow: r.segMaxFlow || 0 });
})()
"""

JS_SYNTH_AND_TRACE = r"""
(async () => {
  const store = __STORE__;
  const KEY = 'case109';
  const sc = __SC__;
  const out = {};

  // ① 自建底图（没有高度图）：自动河流必须**也能跑**（内部临时推演），不许拒绝
  const pre = store.generateRivers(KEY, {});
  out.pre = { ok: !!pre.ok, reason: pre.reason || null, rivers: (pre.rivers || []).length,
    synthesized: !!pre.synthesized };

  // ② 显式「按轮廓生成地形」→ 落库
  const syn = store.synthesizeBaseMapTerrain(KEY);
  out.syn = { ok: !!syn.ok, reason: syn.reason || null, cells: syn.cellCount || 0, spacing: syn.spacing || 0 };
  const hm = store.getHeightmapFor(KEY);
  out.hasHm = !!hm?.grid;
  if (hm && hm.h) {
    let mn = Infinity, mx = -Infinity, land = 0;
    for (const v of hm.h) { if (v < mn) mn = v; if (v > mx) mx = v; if (v >= 20) land++; }
    out.terrain = { min: Math.round(mn), max: Math.round(mx), land, total: hm.h.length };
  }

  // ③ 有地形后再跑：必须出河且**真的汇聚**
  const t0 = performance.now();
  const r = store.generateRivers(KEY, {});
  out.ms = Math.round(performance.now() - t0);
  out.after = { ok: !!r.ok, rivers: (r.rivers || []).length, segs: (r.segments || []).length,
    segMaxFlow: r.segMaxFlow || 0 };
  const lens = (r.rivers || []).map(x => (x.points || []).length).sort((a, b) => b - a);
  out.pathLenMax = lens[0] || 0;
  out.pathLenP50 = lens[Math.floor(lens.length / 2)] || 0;

  // ④ 河链形态（画出来的那个东西）
  try {
    const chains = await import('/src/utils/riverChains.js');
    const gate = sc.riverFlowGate(r.segMaxFlow, r.segments);
    const pruned = sc.pruneRiverNetwork(r.segments, gate);
    const paths = chains.buildRiverPaths(pruned.kept, { minFlow: gate, minLen: 5, maxPaths: 900 });
    out.chains = paths.length;
    const cl = paths.map(p => p.points.length).sort((a, b) => b - a);
    out.chainLenMax = cl[0] || 0;
    out.chainLenP50 = cl[Math.floor(cl.length / 2)] || 0;
  } catch (e) { out.chainErr = String(e).slice(0, 120); }

  sc.autoRivers = r.rivers || [];
  sc.autoRiverSegments = r.segments || [];
  sc.autoRiverMaxFlow = r.segMaxFlow || 0;
  sc.autoRiverDrawn = (r.segments || []).length;
  return JSON.stringify(out);
})()
"""


def _ev(cdp, js, desc):
    r = eval_json(cdp, js, required=None, desc=desc)
    if isinstance(r, tuple) and r[0]:
        return r[1]
    return {'__err__': r}


def run(cdp):
    fails, notes = source_gates()
    ensure_case_state(cdp)
    # 进入剧本模式（`.scenario-map-container` 只在剧本视图里挂载）
    eval_json(cdp,
              "(() => { const b = Array.from(document.querySelectorAll('button'))"
              ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()",
              required=None, desc='点「历史剧本」')
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式挂载')
    time.sleep(1.2)

    mk = _ev(cdp, JS_MAKE_BASEMAP.replace('__STORE__', STORE).replace('__SC__', SC), '造自建底图（无高度图）')
    if not isinstance(mk, dict) or mk.get('__err__') or not mk.get('ok'):
        fails.append(f'🔴 造自建底图失败：{mk}')
        return False, ' | '.join(fails)
    if mk.get('hasHeightmap'):
        fails.append('🔴 这张自建底图不该有高度图（用例前提错了）')

    res = _ev(cdp, JS_SYNTH_AND_TRACE.replace('__STORE__', STORE).replace('__SC__', SC), '推演 + 追踪')
    if not isinstance(res, dict) or res.get('__err__'):
        fails.append(f'🔴 推演/追踪求值失败：{res}')
        return False, ' | '.join(fails)

    # b 推演本身是对的
    ter = res.get('terrain') or {}
    if not res.get('hasHm'):
        fails.append('🔴 「按轮廓生成地形」没有落库（`getHeightmapFor` 仍为空）')
    if (ter.get('max', 0) - ter.get('min', 0)) < 20:
        fails.append(f"🔴 推演出来的地形没有起伏（min={ter.get('min')} / max={ter.get('max')}）—— 平地长不出河")
    if (ter.get('land', 0) or 0) < 100:
        fails.append(f"🔴 推演出来的陆地格太少（{ter.get('land')}）—— 轮廓没被识别")

    # c 端到端：必须出河、且真的汇聚
    after = res.get('after') or {}
    if not after.get('rivers'):
        fails.append('🔴 自建底图上自动河流仍然是 0 条 —— 这正是暮雨否掉的死结')
    if (after.get('segMaxFlow') or 0) < 20:
        fails.append(f"🔴 河网没有真正汇聚（`segMaxFlow={after.get('segMaxFlow')}`，"
                     "应远大于 1；否则只是「每格一根小棍」）")
    if (res.get('chainLenMax') or 0) < 10:
        fails.append(f"🔴 最长河链只有 {res.get('chainLenMax')} 个点 —— 画出来仍是短棍，不是河")

    # d 对照组：全 0 平地必须明显更差（证明 c 的绿是推演的功劳）
    flat = _ev(cdp, JS_FLAT_CONTRAST.replace('__STORE__', STORE).replace('__SC__', SC), '对照：全 0 平地')
    if not isinstance(flat, dict) or flat.get('__err__'):
        fails.append(f'🔴 对照组求值失败：{flat}')
    else:
        if (flat.get('rivers') or 0) >= (after.get('rivers') or 0):
            fails.append(f"🔴 对照组（全 0 平地）出了 {flat.get('rivers')} 条河，"
                         f"不少于推演组的 {after.get('rivers')} 条 —— 判据没有判别力")

    notes.append(
        f"预跑(无高度图)={res.get('pre', {}).get('rivers')} 条(推演={res.get('pre', {}).get('synthesized')}) / "
        f"推演={res.get('syn', {}).get('cells')} 格 格距{res.get('syn', {}).get('spacing')} "
        f"高度 {ter.get('min')}~{ter.get('max')} 陆{ter.get('land')} / "
        f"追踪={res.get('ms')}ms → 河 {after.get('rivers')} 条 段 {after.get('segs')} "
        f"汇流上界 {after.get('segMaxFlow')} 最长路径 {res.get('pathLenMax')} / "
        f"河链 {res.get('chains')} 条 最长 {res.get('chainLenMax')} 中位 {res.get('chainLenP50')} / "
        f"对照(全0平地)={flat.get('rivers') if isinstance(flat, dict) else '?'} 条"
    )
    if fails:
        return False, ' | '.join(fails) + ' ‖ ' + ' + '.join(notes)
    return True, ' + '.join(notes)
