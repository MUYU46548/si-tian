#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 109：**司天自己画的地必须能长出河**（2026-10-17，暮雨定的方向）

用户原话（这一条改变了整个方向）：
    “用户甚至不是必须用外部软件导出地图再放进司天做历史剧本的，
      司天自身的编辑能力必须过硬，**不要指望靠用户导出高度数据地图来救河流生成**。”

修之前的产品事实（三条串起来就是一个死结，而且**全都不报错**）：
  ① `generateRivers()` 遇到 `!hasGrid(hm)` 直接返回 `no-heightmap` —— 自建底图**没有河**；
  ② “建高度图”按钮建出来的是 `new Float32Array(n)`（**全 0**），而海平面是 20
     → 整张图变成**全海平面的平地** → 平地没有坡 → 自动河流**永远是 0 条**；
  ③ 于是“画大陆 → 建高度图 → 点自动河流”这条路走不通，用户被推向外部工具 ——
     而那正是暮雨明确否掉的那条路。

本用例守四件事：
  a **源码闸门**：`generateRivers` 不许再无条件下 `no-heightmap` 拒绝；推演必须接上；
     分量入口必须导出、且 UI 有可发现按钮（`data-testid` + 可见文字）。
  b **推演本身是对的**（纯函数层）：给定一块陆地，推出来的高度场必须
     ① 有真实起伏（不是常数）② 内陆高于海岸 ③ **每一格都排得出去**（无洼地）。
  c **端到端**：自建底图（**完全没有高度图**）→ 点自动河流 → 必须出河，
     且河网必须**真的汇聚**（`segMaxFlow` 远大于 1）。
  d **对照组必须有判别力**：同样的底图，若把高度图换成"全 0 平地"（旧“建高度图”的产物），
     自动河流必须**明显更差/为 0** —— 否则 c 段的绿不能证明推演起了作用。
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from lib.cdp import eval_json, wait_for, stuck_call_stack, StallProbe      # noqa: E402
from lib.helpers import ensure_case_state    # noqa: E402
from lib.rsrc import render_src              # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"

SYN = os.path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'terrainSynthesis.js')
# 工序层（推演 → 排水骨架 → 丘陵 → 填洼 → 湖）：store 现在调它，不再直接调推演
PIPE = os.path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'terrainPipeline.js')
SE = os.path.join(ROOT, 'src', 'renderer', 'src', 'store', 'geodataModules', 'scenarioEditing.js')


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
    pipe = _code_only(_read(PIPE))
    se = _code_only(_read(SE))
    # UI 那一侧：2026-11-07 工具栏九步拆分后，按钮已搬进 `scenario/panels/toolbar/**`。
    # 直接读 ScenarioMap.vue 会假红（搬家当天就是这样红的），所以走 `lib.rsrc` 的**源码合集**
    # —— 它已经把 ScenarioMap + layers + interaction + panels/** + styles 拼成一份。
    smv = _code_only(render_src())

    # a① 推演模块必须是纯函数层、且真的做了"填洼 + 多频段噪声"这两件关键事
    for needle, why in [
        ('export function synthesizeHeightmapFromTerrain', '推演入口'),
        ('export function fillDepressions', '洼地填平（没有它就会满地平行流）'),
        ('highFreq', '高频起伏段（没有它水会平行下流）'),
    ]:
        if needle not in syn:
            fails.append(f'🔴 terrainSynthesis 缺 {why}（找不到 `{needle}`）')

    # a② store 里必须"推演后才可能拒绝"，而不是无条件 no-heightmap
    #    ⚠️ 2026-11-07：入口从 `synthesizeHeightmapFromTerrain` 换成了工序层
    #    `terrainPipeline.synthesizeTerrain`（推演 → 排水骨架 → 丘陵 → 填洼 → 湖）。
    #    闸门跟着代码走、但**不放宽**：要求 store 真的走工序层，且工序层真的还在调推演。
    if 'synthesizeTerrain' not in se:
        fails.append('🔴 generateRivers 没有接推演 —— 自建底图又会直接 `no-heightmap`')
    if 'synthesizeHeightmapFromTerrain' not in pipe:
        fails.append('🔴 工序层 terrainPipeline 没有接推演（`synthesizeHeightmapFromTerrain` 找不到）')
    if 'no-heightmap' in se and 'synthesizeTerrain' in se:
        # 允许保留字符串（有别的函数在用），但检查它**不再出现在 generateRivers 的拒绝里**
        seg = se[se.index('function generateRivers'):]
        seg = seg[:seg.index('\n  }\n') + 4] if '\n  }\n' in seg else seg[:4000]
        if 'no-heightmap' in seg:
            fails.append('🔴 generateRivers 仍在拒绝 `no-heightmap`（推演没有真正取代它）')
    if 'export' not in se and 'synthesizeBaseMapTerrain' not in se:
        fails.append('🔴 store 没有导出 `synthesizeBaseMapTerrain`（显式落库入口）')

    # a③ UI 可发现性：必须有 data-testid + **可见文字**（只靠图标/ title 不算）
    if 'data-testid="basemap-synthesize-terrain"' not in smv:
        fails.append('🔴 没有“按轮廓生成地形”按钮（`data-testid="basemap-synthesize-terrain"`）')
    if '按轮廓生成地形' not in smv:
        fails.append('🔴 按钮没有**可见文字**（暮雨实测过：只有图标 = 找不到）')

    notes.append(f'源码闸门 7 组{"全过" if not fails else f"缺 {len(fails)}"}')
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

# ── 一个异步作业 + 短状态轮询（2026-11-07 改写，本卡）───────────────────────────
# 🔴 旧版把「临时推演 → 显式落库 → 再追踪 → 河链形态 → 全 0 平地对照」全塞进**一次**
#    `Runtime.evaluate(awaitPromise)`。CDP 客户端的读超时固定 15s（lib/cdp.py），整条链一超时
#    就抛 `WebSocketTimeoutException`（Windows 文案 "Connection timed out"），而渲染进程还在算
#    —— 后面 10 条用例的每次求值都排在同一个卡住的进程后面，连锁全红（"到底有没有回归"
#    只能靠翻历史日志分辨）。现在按本仓铁律「先发起、再轮询短句」改写：
#    页面里跑作业并逐阶段写 `window.__T109__`，Python 侧每 0.4s 读一次**标量级状态**；
#    每个阶段自带 performance.now() 读数 —— 真慢的时候能指出是哪一段慢，而不是只剩"超时"。
JS_RUN_ALL = r"""
(() => {
  const store = __STORE__;
  const sc = __SC__;
  if (!store || !sc) return JSON.stringify({ started: false, why: 'no-store-or-sc' });
  const prev = window.__T109__;
  if (prev && prev.state === 'running') return JSON.stringify({ started: false, why: 'already-running' });
  const KEY = 'case109';
  const FLAT = 'case109flat';
  const T = { state: 'running', stage: 'pre-rivers', stages: {}, out: {}, err: null };
  window.__T109__ = T;
  // 心跳：主线程还活着的证据。轮询看这个数在不在涨 ——
  // 用来区分"这一段算得慢"（心跳照涨）与"整页被占死"（心跳停住）。
  T.hb = 0;
  setInterval(() => { T.hb += 1; }, 250);
  const now = () => performance.now();
  const mark = (k, t0) => { T.stages[k] = Math.round(now() - t0); };
  // 每段之间让出一拍：轮询才读得到阶段名（stage 会写成 wait:<哪一段>，卡住的点因此可见）
  const tick = (k) => { T.stage = 'wait:' + k; return new Promise(r => setTimeout(r, 20)); };
  const mkRing = (cx, cy, r, n, wobble, seed) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const w = 1 + Math.sin(a * 3 + seed) * wobble + Math.sin(a * 7 + seed * 2) * wobble * 0.5;
      pts.push({ x: cx + Math.cos(a) * r * w, y: cy + Math.sin(a) * r * w * 0.72 });
    }
    return pts;
  };
  // 🔴 **必须晚一拍再开工**：`(async () => {...})()` 会**同步**跑到第一个 await，
  //    也就是说 ①「临时推演」这段重活仍在**发起那次 evaluate** 里执行 ——
  //    真机实测那样照样把读超时撞满（2026-11-07 第一次改写就是这么红的）。
  //    塞进 setTimeout(…, 0) 之后，发起调用立刻返回，重活只占后续轮询各自的窗口。
  setTimeout(() => {
  (async () => {
    try {
      // ① 自建底图（没有高度图）：自动河流必须**也能跑**（内部临时推演），不许拒绝
      let t0 = now();
      const pre = store.generateRivers(KEY, {});
      mark('preRivers', t0);
      T.out.pre = { ok: !!pre.ok, reason: pre.reason || null, rivers: (pre.rivers || []).length,
        synthesized: !!pre.synthesized };
      await tick('pre-rivers');

      // ② 显式“按轮廓生成地形”→ 落库
      T.stage = 'synthesize';
      t0 = now();
      const syn = store.synthesizeBaseMapTerrain(KEY);
      mark('synthesize', t0);
      T.out.syn = { ok: !!syn.ok, reason: syn.reason || null, cells: syn.cellCount || 0, spacing: syn.spacing || 0 };
      const hm = store.getHeightmapFor(KEY);
      T.out.hasHm = !!hm?.grid;
      if (hm && hm.h) {
        let mn = Infinity, mx = -Infinity, land = 0;
        for (const v of hm.h) { if (v < mn) mn = v; if (v > mx) mx = v; if (v >= 20) land++; }
        T.out.terrain = { min: Math.round(mn), max: Math.round(mx), land, total: hm.h.length };
      }
      // ②c 落库的河几何必须"干净"：非有限坐标就是渲染层卡死的直接原因（2026-11-07 真机抓到的栈
      //    是 weldRiverJunctions 里按格扫的循环 —— 一个 Infinity 让 `gx <= x1` 恒真）。
      const storedRivers = (store.baseMaps[KEY] && store.baseMaps[KEY].rivers) || [];
      let badPts = 0, badRivers = 0, maxAbs = 0;
      for (const rv of storedRivers) {
        let bad = false;
        for (const p of (rv.points || [])) {
          if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { badPts++; bad = true; }
          else maxAbs = Math.max(maxAbs, Math.abs(p.x), Math.abs(p.y));
        }
        if (bad) badRivers++;
      }
      T.out.riverGeom = { rivers: storedRivers.length, badRivers, badPts, maxAbs: Math.round(maxAbs) };

      await tick('synthesize');

      // ②b 生成地形后**立刻存一次盘**。这一步既是判据（"按轮廓生成地形"之后必须能存下去），
      //    也是 2026-11-07 卡死取证的落点：自动保存（800ms 防抖）会在下一段里悄悄开跑，
      //    把它提到**可计时、可 await** 的位置，卡在哪一段就不再靠猜。
      T.stage = 'flush-save';
      t0 = now();
      let flush = null;
      try {
        const PM = await import('/src/store/projectStore.js');
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
        const proj = PM.useProjectStore(pinia);
        flush = await proj.flushSave();
      } catch (e) { flush = { error: String(e && (e.stack || e.message) || e).slice(0, 200) }; }
      mark('flushSave', t0);
      T.out.flush = flush
        ? { success: !!flush.success, skipped: !!flush.skipped, error: flush.error || null,
            bytes: Number.isFinite(flush.bytes) ? flush.bytes : null }
        : null;
      await tick('flush-save');

      // ③ 有地形后再跑：必须出河且**真的汇聚**
      T.stage = 'rivers';
      t0 = now();
      const r = store.generateRivers(KEY, {});
      mark('rivers', t0);
      const after = { ok: !!r.ok, rivers: (r.rivers || []).length, segs: (r.segments || []).length,
        segMaxFlow: r.segMaxFlow || 0 };
      const lens = (r.rivers || []).map(x => (x.points || []).length).sort((a, b) => b - a);
      T.out.after = after;
      T.out.pathLenMax = lens[0] || 0;
      T.out.pathLenP50 = lens[Math.floor(lens.length / 2)] || 0;
      await tick('rivers');

      // ④ 河链形态（画出来的那个东西）
      T.stage = 'chains';
      t0 = now();
      try {
        const chains = await import('/src/utils/riverChains.js');
        const gate = sc.riverFlowGate(r.segMaxFlow, r.segments);
        const pruned = sc.pruneRiverNetwork(r.segments, gate);
        const paths = chains.buildRiverPaths(pruned.kept, { minFlow: gate, minLen: 5, maxPaths: 900 });
        T.out.chains = paths.length;
        const cl = paths.map(p => p.points.length).sort((a, b) => b - a);
        T.out.chainLenMax = cl[0] || 0;
        T.out.chainLenP50 = cl[Math.floor(cl.length / 2)] || 0;
      } catch (e) { T.out.chainErr = String(e).slice(0, 120); }
      mark('chains', t0);
      sc.autoRivers = r.rivers || [];
      sc.autoRiverSegments = r.segments || [];
      sc.autoRiverMaxFlow = r.segMaxFlow || 0;
      sc.autoRiverDrawn = (r.segments || []).length;
      await tick('chains');

      // ⑤ 对照组：造一份“全 0 平地”高度图（旧“建高度图”的产物），验证它确实长不出河
      T.stage = 'flat';
      t0 = now();
      const fa = { id: 'p1', name: 'A', kind: 'land', color: '#c9a06a', points: mkRing(0, 0, 900, 90, 0.16, 1.2) };
      // 97x73 全 0 平地（与推演网格同量级，公平对照）
      const cols = 97, rows = 73, sp = 20.5, pts = [], h = [];
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        pts.push([-950 + i * sp, -780 + j * sp]);
        h.push(0);
      }
      store.baseMaps = { ...store.baseMaps, [FLAT]: {
        id: FLAT, name: FLAT, terrain: [fa], referenceImages: [],
        heightmap: { h, grid: { points: pts, cellsX: cols, cellsY: rows, spacing: sp } },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      } };
      sc.baseMapKey = FLAT;
      if (typeof sc.onBaseMapChange === 'function') sc.onBaseMapChange();
      await new Promise(res => setTimeout(res, 320));
      const fr = store.generateRivers(FLAT, {});
      T.out.flat = { ok: !!fr.ok, rivers: (fr.rivers || []).length, segs: (fr.segments || []).length,
        segMaxFlow: fr.segMaxFlow || 0 };
      mark('flat', t0);

      T.stage = 'done';
      T.state = 'done';
    } catch (e) {
      T.err = String((e && (e.stack || e.message)) || e).slice(0, 400);
      T.state = 'error';
    }
  })();
  }, 0);
  return JSON.stringify({ started: true });
})()
"""


def _ev(cdp, js, desc):
    r = eval_json(cdp, js, required=None, desc=desc)
    if isinstance(r, tuple) and r[0]:
        return r[1]
    return {'__err__': r}


def _stack_hint(probe=None):
    """卡死取证：优先用**提前挂好的**调试器（事后挂是挂不上的，见 StallProbe 说明）。"""
    frames = []
    if probe is not None:
        try:
            frames = probe.pause_and_stack()
        except Exception:
            frames = []
    if not frames:
        try:
            frames = stuck_call_stack()
        except Exception as e:
            return f'取证失败（{e}）'
    if not frames:
        return ('取证失败（挂上调试器后仍没停住 —— 说明那个 100% 单核的循环不是 JS 层的，'
                '或被 debugger 的中断够不到）')
    return ' ← '.join(frames)


def _poll_job(cdp, timeout=240, interval=0.4, read_timeout=3.0, probe=None):
    """轮询 `window.__T109__` 的**短状态**（只回标量），返回终态快照。

    每次求值都是一个极短的表达式 —— 这正是"大动作先发起、再轮询短话"的目的：
    即使某一段同步计算卡住十几秒，Python 侧也不会把**整条链**塞进一次 15s 超时的读。

    🔴 读超时单独调短（3s）：一段重活占住主线程时，这一次读必然超时 —— 那是**"还在算"**，
    不是失败。把 socket 超时临时压到 3s，超时就当"还在跑"再轮询一次
    （CDP 的响应是 FIFO 且按 id 匹配，晚到的那条会被 `send()` 自己丢掉，不会串号）。
    真正的判据是**墙钟上限**和页面里的 `state`，最后再用页面自报的分段读数指认慢在哪。
    """
    try:
        from websocket import WebSocketTimeoutException
    except Exception:                       # 老环境没装 websocket-client（本该走不到）
        WebSocketTimeoutException = ()
    t0 = time.time()
    snap = None
    prev_timeout = None
    expr = ("JSON.stringify(window.__T109__ ? { s: window.__T109__.state, "
            "g: window.__T109__.stage, t: window.__T109__.stages, "
            "h: window.__T109__.hb, o: Object.keys(window.__T109__.out), "
            "rg: (window.__T109__.out && window.__T109__.out.riverGeom) || null, "
            "w: window.__SITIAN_RIVER_WELD__ || null, "
            "e: window.__T109__.err } : null)")
    try:
        prev_timeout = cdp.ws.gettimeout()
        cdp.ws.settimeout(read_timeout)
        while time.time() - t0 < timeout:
            try:
                raw = cdp.eval(expr)
            except WebSocketTimeoutException:
                time.sleep(interval)        # 页面还在算同一段：继续等
                continue
            if isinstance(raw, dict) and '__err__' in raw:
                raise RuntimeError(f'轮询求值异常：{raw["__err__"]}')
            if isinstance(raw, str) and raw != 'null':
                try:
                    snap = json.loads(raw)
                except ValueError:
                    snap = None
                if snap and snap.get('s') in ('done', 'error'):
                    return snap
            time.sleep(interval)
    finally:
        try:
            if prev_timeout is not None:
                cdp.ws.settimeout(prev_timeout)
        except Exception:
            pass
    raise RuntimeError(f'作业 {timeout}s 内没跑完（最后状态 {snap}；'
                       'h=心跳(每 250ms +1，不涨 = 主线程被占死) / o=已写出的结果键 / g=卡在哪一段）'
                       f'｜卡死调用栈：{_stack_hint(probe)}')


def run(cdp):
    fails, notes = source_gates()
    ensure_case_state(cdp)
    # 进入剧本模式（`.scenario-map-container` 只在剧本视图里挂载）
    eval_json(cdp,
              "(() => { const b = Array.from(document.querySelectorAll('button'))"
              ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()",
              required=None, desc='点“历史剧本”')
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式挂载')
    time.sleep(1.2)

    mk = _ev(cdp, JS_MAKE_BASEMAP.replace('__STORE__', STORE).replace('__SC__', SC), '造自建底图（无高度图）')
    if not isinstance(mk, dict) or mk.get('__err__') or not mk.get('ok'):
        fails.append(f'🔴 造自建底图失败：{mk}')
        return False, ' | '.join(fails)
    if mk.get('hasHeightmap'):
        fails.append('🔴 这张自建底图不该有高度图（用例前提错了）')

    # 发起作业 → 轮询短状态（见文件头「一个异步作业 + 短状态轮询」）
    # ⚠️ 调试器必须**在作业开跑之前**挂好：卡死之后再 enable 是挂不上的（StallProbe 说明）。
    probe = StallProbe()
    probe.arm()
    started = _ev(cdp, JS_RUN_ALL.replace('__STORE__', STORE).replace('__SC__', SC), '发起推演作业')
    if not isinstance(started, dict) or started.get('__err__') or not started.get('started'):
        probe.close()
        fails.append(f'🔴 推演作业没发起：{started}')
        return False, ' | '.join(fails)
    t_job = time.time()
    try:
        snap = _poll_job(cdp, timeout=120, probe=probe)
    except Exception as e:
        fails.append(f'🔴 {e}')
        return False, ' | '.join(fails)
    finally:
        probe.close()
    wall = round(time.time() - t_job, 1)
    stages = snap.get('t') or {}
    if snap.get('s') != 'done':
        fails.append(f"🔴 作业在半途报错（停在阶段 {snap.get('g')}）：{snap.get('e')}")
        return False, ' | '.join(fails) + ' ‖ 阶段读数 ' + json.dumps(stages, ensure_ascii=False)

    res = _ev(cdp, "JSON.stringify(window.__T109__.out)", '取作业结果')
    if not isinstance(res, dict) or res.get('__err__'):
        fails.append(f'🔴 作业结果取不回：{res}')
        return False, ' | '.join(fails)

    # b 推演本身是对的
    ter = res.get('terrain') or {}
    if not res.get('hasHm'):
        fails.append('🔴 “按轮廓生成地形”没有落库（`getHeightmapFor` 仍为空）')
    if (ter.get('max', 0) - ter.get('min', 0)) < 20:
        fails.append(f"🔴 推演出来的地形没有起伏（min={ter.get('min')} / max={ter.get('max')}）—— 平地长不出河")
    if (ter.get('land', 0) or 0) < 100:
        fails.append(f"🔴 推演出来的陆地格太少（{ter.get('land')}）—— 轮廓没被识别")

    # b2 生成地形之后必须能**存下去**（"按轮廓生成地形 → 自动保存"是这条链上最脆的一步）
    fl = res.get('flush') or {}
    if not fl:
        fails.append('🔴 生成地形后没拿到保存回执（`flushSave` 没返回）')
    elif not fl.get('success'):
        fails.append(f"🔴 生成地形后保存失败：{fl.get('error')}")

    # b3 落库的河几何必须干净 —— 非有限坐标会让渲染层的按格扫循环变成死循环（真机卡死就是这么来的）
    geom = res.get('riverGeom') or {}
    if (geom.get('badPts') or 0) > 0:
        fails.append(f"🔴 落库的河几何里 {geom.get('badPts')} 个非有限坐标"
                     f"（{geom.get('badRivers')} 条河 / 共 {geom.get('rivers')} 条）—— 渲染层会被拖进死循环")

    # c 端到端：必须出河、且真的汇聚
    after = res.get('after') or {}
    if not after.get('rivers'):
        fails.append('🔴 自建底图上自动河流仍然是 0 条 —— 这正是暮雨否掉的死结')
    if (after.get('segMaxFlow') or 0) < 20:
        fails.append(f"🔴 河网没有真正汇聚（`segMaxFlow={after.get('segMaxFlow')}`，"
                     "应远大于 1；否则只是“每格一根小棍”）")
    if (res.get('chainLenMax') or 0) < 10:
        fails.append(f"🔴 最长河链只有 {res.get('chainLenMax')} 个点 —— 画出来仍是短棍，不是河")

    # d 对照组：全 0 平地必须明显更差（证明 c 的绿是推演的功劳）
    flat = res.get('flat') or {}
    if not flat:
        fails.append('🔴 对照组（全 0 平地）没有结果')
    elif (flat.get('rivers') or 0) >= (after.get('rivers') or 0):
        fails.append(f"🔴 对照组（全 0 平地）出了 {flat.get('rivers')} 条河，"
                     f"不少于推演组的 {after.get('rivers')} 条 —— 判据没有判别力")

    notes.append(
        f"预跑(无高度图)={res.get('pre', {}).get('rivers')} 条(推演={res.get('pre', {}).get('synthesized')}) / "
        f"推演={res.get('syn', {}).get('cells')} 格 格距{res.get('syn', {}).get('spacing')} "
        f"高度 {ter.get('min')}~{ter.get('max')} 陆{ter.get('land')} / "
        f"→ 河 {after.get('rivers')} 条 段 {after.get('segs')} "
        f"汇流上界 {after.get('segMaxFlow')} 最长路径 {res.get('pathLenMax')} / "
        f"河链 {res.get('chains')} 条 最长 {res.get('chainLenMax')} 中位 {res.get('chainLenP50')} / "
        f"对照(全0平地)={flat.get('rivers') if flat else '?'} 条 / "
        f"整链 {wall}s 阶段 {json.dumps(stages, ensure_ascii=False)}"
    )
    if fails:
        return False, ' | '.join(fails) + ' ‖ ' + ' + '.join(notes)
    return True, ' + '.join(notes)
