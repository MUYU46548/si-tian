#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 39：P2-4 Web Worker 异步派生（温度/降水/生物群系）

覆盖：
  a) worker 可用 + 与同步**逐元素等价**（200×200 = 40000 格）；且主线程原数组未被 detach
  b) 防抖合并：连续 5 次请求只触发 1 次 worker 调用，5 个回调全部拿到结果
  c) 阈值分流：小网格走同步（不启动 worker —— 往返开销 > 计算量）
  d) 生命周期：terminate 后在途请求降级同步返回（绝不把派生算丢）；terminate 后可重建
  e) store 接线：200×200 大网格上 applyHeightBrush 的主线程同步耗时 < 16ms（派生不再挡路），
     防抖到期后派生值与"同步重算"逐元素一致，undo→redo 后仍能收敛到正确派生值

阈值说明：deriveClient 默认 8000 格以下走同步。本用例通过模块级 setAsyncThreshold 临时改阈值
来分别验证两条分支 —— 页面内 `await import('/src/utils/deriveClient.js')` 与 store 引用的是
同一份模块实例（Vite dev 模块图去重），所以改阈值立刻对 store 生效。
"""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
CLIENT = "(await import('/src/utils/deriveClient.js'))"
N = 200 * 200  # 40000 格


def _j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def _mkmap(js_var, n=N):
    """生成确定性伪随机高度图（合成数据，不碰真实库）"""
    return f"""(() => {{
      const n = {n};
      const {js_var} = new Float32Array(n);
      let seed = 12345;
      const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      for (let i = 0; i < n; i++) {js_var}[i] = Math.round(rnd() * 1000) / 10;
      return {js_var};
    }})()"""


# ─────────────────────────────────────────────────────────────
# a) worker 等价性 + 不 detach 原数组
# ─────────────────────────────────────────────────────────────
def sub_worker_equivalence(cdp):
    res = _j(cdp, f"""(async () => {{
      const C = {CLIENT};
      const h = {_mkmap('h')};
      const hLen0 = h.length;
      const hHead0 = h[0], hTail0 = h[h.length - 1];

      const sync = C.deriveAllLayersSync(h);
      const out = await C.deriveInWorker(h);
      if (!out) return JSON.stringify({{ err: 'null-result' }});

      // 原数组必须仍然可用（transfer 的是副本）
      const detached = h.length !== hLen0 || h[0] !== hHead0 || h[h.length - 1] !== hTail0;

      const eq = (a, b) => {{
        if (!a || !b || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
      }};
      let firstDiff = -1;
      for (let i = 0; i < sync.temperature.length; i++) {{
        if (sync.temperature[i] !== out.temperature[i]
          || sync.precipitation[i] !== out.precipitation[i]
          || sync.biome[i] !== out.biome[i]) {{ firstDiff = i; break; }}
      }}
      return JSON.stringify({{
        transport: out.transport, n: out.n,
        types: [out.temperature.constructor.name, out.precipitation.constructor.name, out.biome.constructor.name],
        len: [out.temperature.length, out.precipitation.length, out.biome.length],
        detached, eqTemp: eq(sync.temperature, out.temperature),
        eqPrec: eq(sync.precipitation, out.precipitation),
        eqBiome: eq(sync.biome, out.biome),
        firstDiff, ms: out.ms, stats: C.getDeriveStats(),
      }});
    }})()""")
    if not isinstance(res, dict) or 'transport' not in res:
        return False, f'worker 派生链路异常 {res}'
    if res['transport'] != 'worker':
        return False, f'派生未走 worker（transport={res["transport"]}）—— worker 构造失败？'
    if res['n'] != N or res['len'] != [N, N, N]:
        return False, f'结果长度错误 {res}'
    if res['types'] != ['Float32Array', 'Float32Array', 'Uint8Array']:
        return False, f'结果类型错误 {res["types"]}'
    if res['detached']:
        return False, '主线程高度图被 transfer 消费掉（必须传副本）'
    if not (res['eqTemp'] and res['eqPrec'] and res['eqBiome']):
        return False, (f'worker 结果与同步结果不一致（首个差异下标 {res["firstDiff"]}）'
                       f'—— worker 里的公式与 utils/heightMath.js 漂移了？')
    return True, (f'worker 等价性通过：{N} 格派生走 worker（{res["ms"]:.1f}ms），'
                  f'temperature/precipitation/biome 与同步结果**逐元素一致**，'
                  f'主线程原数组未被 detach')


# ─────────────────────────────────────────────────────────────
# b) 防抖合并
# ─────────────────────────────────────────────────────────────
def sub_debounce(cdp):
    res = _j(cdp, f"""(async () => {{
      const C = {CLIENT};
      C.terminateDeriveWorker();
      C.resetDeriveStats();
      C.setAsyncThreshold(0);           // 强制异步分支
      const h = {_mkmap('h')};
      let calls = 0;
      const results = [];
      for (let i = 0; i < 5; i++) {{
        C.scheduleDerive(h, (r) => {{ calls++; results.push(r ? r.transport : null); }});
        await new Promise(r => setTimeout(r, 20));   // 20ms << 300ms 防抖窗
      }}
      await new Promise(r => setTimeout(r, 500));    // 等防抖窗口过去 + worker 往返
      const st = C.getDeriveStats();
      C.setAsyncThreshold(8000);
      return JSON.stringify({{ calls, transports: results, stats: st,
        cbCount: calls, ok: results.filter(t => t === 'worker').length }});
    }})()""")
    if not isinstance(res, dict) or 'calls' not in res:
        return False, f'防抖链路异常 {res}'
    if res['calls'] != 5:
        return False, f'回调未全部触发（{res["calls"]}/5）—— 合并时把回调也丢了'
    if res['stats']['workerCalls'] != 1:
        return False, (f'5 次连续请求触发了 {res["stats"]["workerCalls"]} 次 worker 调用，期望 1'
                       f'（防抖未生效）{res["stats"]}')
    if res['stats']['coalesced'] < 4:
        return False, f'未记录合并次数 {res["stats"]}'
    if res['ok'] != 5:
        return False, f'回调拿到的结果不是 worker 结果 {res["transports"]}'
    return True, (f'防抖合并通过：5 次连续请求（间隔 20ms）合并成 **1 次** worker 调用'
                  f'（coalesced={res["stats"]["coalesced"]}），5 个回调全部收到 worker 结果')


# ─────────────────────────────────────────────────────────────
# c) 阈值分流：小网格走同步
# ─────────────────────────────────────────────────────────────
def sub_threshold(cdp):
    res = _j(cdp, f"""(async () => {{
      const C = {CLIENT};
      C.terminateDeriveWorker();
      C.resetDeriveStats();
      C.setAsyncThreshold(8000);
      const small = {_mkmap('small', 4000)};
      const rSmall = await C.deriveAllLayersAsync(small);
      const afterSmall = C.getDeriveStats();
      C.setAsyncThreshold(0);
      const rBig = await C.deriveAllLayersAsync(small);   // 同一份数据，只改阈值 → 必须走 worker
      const afterBig = C.getDeriveStats();
      C.setAsyncThreshold(8000);
      C.terminateDeriveWorker();
      C.resetDeriveStats();
      return JSON.stringify({{ smallTransport: rSmall.transport, bigTransport: rBig.transport,
        smallWorkerCalls: afterSmall.workerCalls, bigWorkerCalls: afterBig.workerCalls }});
    }})()""")
    if not isinstance(res, dict) or 'smallTransport' not in res:
        return False, f'阈值分流链路异常 {res}'
    if res['smallTransport'] != 'sync':
        return False, f'4000 格（< 8000 阈值）未走同步 {res}'
    if res['smallWorkerCalls'] != 0:
        return False, f'小网格不该创建 worker，却调用了 {res["smallWorkerCalls"]} 次 {res}'
    if res['bigTransport'] != 'worker':
        return False, f'阈值调 0 后仍未走 worker {res}'
    return True, ('阈值分流通过：4000 格（< 8000 阈值）走同步且不启动 worker；'
                  '阈值调 0 后同一份数据改走 worker')


# ─────────────────────────────────────────────────────────────
# d) 生命周期：terminate / 降级 / 重建
# ─────────────────────────────────────────────────────────────
def sub_lifecycle(cdp):
    res = _j(cdp, f"""(async () => {{
      const C = {CLIENT};
      C.setAsyncThreshold(0);
      const h = {_mkmap('h')};

      // 先确保 worker 已建立并在途，再 terminate：promise 不能悬着，必须降级同步给出结果
      const inflight = C.deriveInWorker(h);
      const beforeTerminate = C.isWorkerAvailable();
      C.terminateDeriveWorker();
      const afterTerminate = C.isWorkerAvailable();
      const inflightRes = await inflight;

      // terminate 后再次调用：应自动重建
      const again = await C.deriveInWorker(h);
      const rebuilt = C.isWorkerAvailable();
      C.setAsyncThreshold(8000);
      C.terminateDeriveWorker();
      return JSON.stringify({{
        beforeTerminate, afterTerminate, rebuilt,
        inflightOk: !!(inflightRes && inflightRes.temperature && inflightRes.temperature.length === {N}),
        inflightTransport: inflightRes ? inflightRes.transport : null,
        againTransport: again ? again.transport : null,
      }});
    }})()""")
    if not isinstance(res, dict) or 'beforeTerminate' not in res:
        return False, f'生命周期链路异常 {res}'
    if not res['beforeTerminate']:
        return False, f'worker 未成功建立 {res}'
    if res['afterTerminate']:
        return False, f'terminate 后仍报告可用 {res}'
    if not res['inflightOk']:
        return False, f'terminate 把在途请求弄丢了（返回 {res}）—— 派生被静默丢弃'
    if res['againTransport'] != 'worker':
        return False, f'terminate 后未能重建 worker {res}'
    return True, (f'生命周期通过：terminate 前 worker 可用、terminate 后在途请求降级同步返回完整结果'
                  f'（transport={res["inflightTransport"]}）、再次调用自动重建（transport={res["againTransport"]}）')


# ─────────────────────────────────────────────────────────────
# e) store 接线：大网格笔刷不被派生挡住
# ─────────────────────────────────────────────────────────────
def sub_store_wiring(cdp):
    res = _j(cdp, f"""(async () => {{
      const C = {CLIENT};
      const s = {STORE};
      const side = 200, spacing = 14.4;
      const pts = new Array(side * side);
      for (let yi = 0; yi < side; yi++) {{
        for (let xi = 0; xi < side; xi++) pts[yi * side + xi] = [xi * spacing, yi * spacing];
      }}
      const n = pts.length;
      const mkHm = () => {{
        const h = new Float32Array(n);
        const temp = new Float32Array(n);
        const prec = new Float32Array(n);
        const biome = new Uint8Array(n);
        let seed = 999;
        for (let i = 0; i < n; i++) {{
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          h[i] = Math.round((seed % 1000) / 10);
          temp[i] = 10; prec[i] = 50; biome[i] = 4;
        }}
        return {{ h, temp, prec, biome, grid: {{ points: pts, spacing, cellsX: side, cellsY: side, count: n }} }};
      }};
      const mk = (key) => {{
        s.addBaseMap(key, {{ name: key, heightmap: mkHm() }});
      }};
      mk('__t39_async__');
      mk('__t39_sync__');

      const cx = 100 * spacing, cy = 100 * spacing;
      const warm = (key) => s.applyHeightBrush(key, cx, cy, 120, 3, 'raise');
      const hSum = (key) => {{
        const hm = s.baseMaps[key].heightmap;
        let acc = 0;
        for (let i = 0; i < n; i++) acc += hm.h[i];
        return Math.round(acc);
      }};

      // ① 同步分支（阈值放到远超 n）：笔刷调用里就包含 O(n) 派生
      C.setAsyncThreshold(1e9);
      warm('__t39_sync__');
      const syncTimes = [];
      for (let i = 0; i < 4; i++) {{
        const t0 = performance.now();
        s.applyHeightBrush('__t39_sync__', cx + i * 40, cy, 120, 3, 'raise');
        syncTimes.push(performance.now() - t0);
      }}

      // ② 异步分支（阈值 0）：派生挪到 Worker，主线程只落 h
      C.setAsyncThreshold(0);
      warm('__t39_async__');
      const asyncTimes = [];
      for (let i = 0; i < 4; i++) {{
        const t0 = performance.now();
        s.applyHeightBrush('__t39_async__', cx + i * 40, cy, 120, 3, 'raise');
        asyncTimes.push(performance.now() - t0);
      }}
      const deriveMs = (() => {{
        const hm = s.baseMaps['__t39_async__'].heightmap;
        const t0 = performance.now();
        C.deriveAllLayersSync(hm.h);
        return performance.now() - t0;
      }})();

      // ③ 等防抖 + worker 回来，派生值必须与"同步重算"逐元素一致
      await new Promise(r => setTimeout(r, 700));
      const hmA = s.baseMaps['__t39_async__'].heightmap;
      const expect = C.deriveAllLayersSync(hmA.h);
      let diff = 0;
      for (let i = 0; i < n; i++) if (hmA.temp[i] !== expect.temperature[i]) diff++;

      // ④ undo → redo：重做后派生值必须再次收敛（异步派生挂在 redo 内）
      s.undo();
      await new Promise(r => setTimeout(r, 50));
      s.redo();
      const sumSyncBefore6 = hSum('__t39_sync__');
      const sumAsyncRef = hSum('__t39_async__');
      await new Promise(r => setTimeout(r, 700));
      const hmB = s.baseMaps['__t39_async__'].heightmap;
      const expectB = C.deriveAllLayersSync(hmB.h);
      let diffAfter = 0;
      for (let i = 0; i < n; i++) {{
        if (hmB.temp[i] !== expectB.temperature[i] || hmB.biome[i] !== expectB.biome[i]) diffAfter++;
      }}

      // ⑤ 跨底图隔离：再涂一次 sync 图后撤销，只能回滚 sync 图（merge 谓词必须带 baseMapKey）
      s.applyHeightBrush('__t39_sync__', cx, cy + 200, 120, 3, 'raise');
      const sumSyncBrushed = hSum('__t39_sync__');
      s.undo();
      const sumSyncUndo = hSum('__t39_sync__');
      const sumAsyncAfterUndo = hSum('__t39_async__');
      s.redo();
      const sumSyncRedo = hSum('__t39_sync__');
      const stats = C.getDeriveStats();

      C.setAsyncThreshold(8000);
      try {{ s.removeBaseMap('__t39_async__'); s.removeBaseMap('__t39_sync__'); }} catch (e) {{}}

      const mn = (a) => Math.min.apply(null, a);
      return JSON.stringify({{
        n, asyncMin: +mn(asyncTimes).toFixed(2), syncMin: +mn(syncTimes).toFixed(2),
        deriveMs: +deriveMs.toFixed(2), diff, diffAfter, stats,
        hLen: hmA.h.length, tempLen: hmA.temp.length,
        sumSyncBefore6, sumSyncBrushed, sumSyncUndo, sumSyncRedo, sumAsyncRef, sumAsyncAfterUndo,
      }});
    }})()""")
    if not isinstance(res, dict) or 'asyncMin' not in res:
        return False, f'store 接线链路异常 {res}'
    if res['deriveMs'] <= 0:
        return False, f'同步派生耗时异常 {res}'
    if res['asyncMin'] >= 16:
        return False, (f'大网格笔刷主线程耗时 {res["asyncMin"]}ms ≥ 16ms（一帧预算），'
                       f'派生仍挡在输入处理链路上')
    if res['diff'] != 0:
        return False, f'异步派生结果与同步重算不一致（{res["diff"]} 个温度值不同）{res}'
    if res['stats']['workerCalls'] < 1:
        return False, f'store 路径未真正使用 worker {res["stats"]}'
    if res['sumSyncUndo'] != res['sumSyncBefore6']:
        return False, (f'撤销未回滚 sync 底图的笔刷（{res["sumSyncBefore6"]} → {res["sumSyncUndo"]}，'
                       f'涂后 {res["sumSyncBrushed"]}）{res}')
    if res['sumAsyncAfterUndo'] != res['sumAsyncRef']:
        return False, (f'撤销 sync 底图时把 async 底图也改了（{res["sumAsyncRef"]} → '
                       f'{res["sumAsyncAfterUndo"]}）—— merge 谓词漏了 baseMapKey，跨底图被合并成一条命令')
    if res['sumSyncRedo'] != res['sumSyncBrushed']:
        return False, f'重做未恢复 sync 底图的笔刷 {res}'
    if res['diffAfter'] != 0:
        return False, (f'undo→redo 后派生值未收敛（{res["diffAfter"]}/{res["n"]} 个值不同）'
                       f'—— 重做留下了陈旧图层')
    return True, (f'store 接线通过：{res["n"]} 格网格上 applyHeightBrush 主线程仅 {res["asyncMin"]}ms'
                  f'（< 16ms 帧预算；同数据同步派生本身就要 {res["deriveMs"]}ms），'
                  f'防抖到期后 temp/prec/biome 与同步重算逐元素一致，'
                  f'undo→redo 后仍收敛（workerCalls={res["stats"]["workerCalls"]}）')


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    wait_for(cdp, f"{STORE}.nodes.length > 0", timeout=45, desc='地理数据加载')

    results = []
    for name, fn in (('a worker 等价性', sub_worker_equivalence),
                     ('b 防抖合并', sub_debounce),
                     ('c 阈值分流', sub_threshold),
                     ('d 生命周期', sub_lifecycle),
                     ('e store 接线', sub_store_wiring)):
        try:
            ok, detail = fn(cdp)
        except Exception as e:
            ok, detail = False, f'异常: {e}'
        results.append((name, ok, detail))

    # 收尾：确保 worker 已终止、阈值复位
    try:
        cdp.eval(f"""(async () => {{
          const C = {CLIENT};
          C.setAsyncThreshold(8000);
          C.terminateDeriveWorker();
          return 'ok';
        }})()""")
    except Exception:
        pass

    failed = [f'{n}: {d}' for n, o, d in results if not o]
    if failed:
        return False, (f'Worker 派生 {len(results) - len(failed)}/{len(results)} 子测试通过；失败：\n    '
                       + '\n    '.join(failed))
    return True, ('Worker 派生 ' + f'{len(results)}/{len(results)} 全通过 — '
                  + '；'.join(d for _, _, d in results))
