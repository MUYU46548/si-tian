#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 67：A1/M1b —— 底图高度图**写入**统一走 commitHeightmap

背景（2026-09-25，`docs/A1_DATA_MODEL_DECISION.md`）：
A1 的决策是「**行星的高度图为单一真源，剧本底图按 `planetId` 绑定代理，不复制**」。
M1 已把**读取点**切到 `getHeightmapFor`；本用例守 **M1b = 写入点**。

为什么必须单独守（而不是只跑既有用例）：
  底图侧原本的写入形态是「**整体替换 baseMap 对象**」
  —— `baseMaps.value = { ...baseMaps.value, [k]: { ...baseMap, heightmap: { ...hm, h } } }`。
  这种写法**一写就换引用**，与「共享同一份高度图」天然冲突。绑定行星之后若还这么写，
  就会变成「**读行星那份 / 写自己那份**」：用户以为改了、画布却不变（静默分裂）。
  既有用例（39/19/46）都在**未绑定**路径上跑 → 这个缺陷对它们是隐形的。

覆盖：
  f0 静态守卫（读源码）：5 个写入入口的函数体内都必须出现 `commitHeightmap`，且不得残留
     「整体替换 + heightmap」的旧形态 —— 防有人改回去（漏报型风险，比误报隐蔽得多）
  f1 **未绑定**（底图自持）：写入落在底图自己那份；undo 复原 **且不打 `updatedAt`**
     （与 M1b 之前逐字段一致 —— 原 undo 闭包不写时间戳）
  f2 **绑定行星**：写入落在 `mapData[pid]`（真单源），底图侧不产生副本；undo 复原行星那份
  f3 **R3 绑定字段级联**：`baseMaps[*].planetId` 是「以节点 id 为值」的引用 → `changeNodeId`
     必须级联它。否则行星改名（转正）后绑定悬空，而绑定迁移时底图侧那份 heightmap 已被
     `delete` → 底图表现为「空地图」（数据还在 mapData 里，只是没人指得到）
  f4 **悬空绑定回落**：绑定的行星不存在时，写入必须**回落到底图自身**，绝不静默丢弃
     （`commitHeightmap` 在 2026-09-25 之前是 `if (!planet) return;` = 静默吞掉这次编辑）

不重复覆盖：未绑定态的落盘/像素/派生等价性由 test_39（worker 派生）、test_19（剧本）、
test_46（项目文件）负责。本用例只补 M1b 引入的三条新语义。
"""
import sys, os, re, io, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json  # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"


# ─────────────────────────────────────────────────────────────
# f0 静态守卫：读源码（不启动浏览器也能查 —— 但本用例仍走 CDP，保持一致）
# ─────────────────────────────────────────────────────────────
WRITE_ENTRIES = ['applyHeightBrush', 'applyBiomeBrush', 'applyCultureBrush', 'applyReligionBrush',
                 'deriveAllLayers']


def _static_guard():
    """返回 (problems, n_commit_calls)。problems 为空 = 通过。"""
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    path = os.path.join(root, 'src', 'renderer', 'src', 'store', 'geodataModules', 'scenarioEditing.js')
    src = io.open(path, encoding='utf-8').read()

    problems = []
    for fn in WRITE_ENTRIES:
        m = re.search(r'\n\s*function ' + fn + r'\s*\(', src)
        if not m:
            problems.append(f'源码里找不到 {fn}()')
            continue
        nxt = re.search(r'\n\s*function ', src[m.end():])
        body = src[m.end():m.end() + (nxt.start() if nxt else len(src))]
        if 'commitHeightmap(' not in body:
            problems.append(f'{fn} 的高度图写入未走 commitHeightmap（绑定行星后会写进无人读的副本）')

    # 旧形态残留：「整体替换 baseMap 对象 + 写 heightmap」
    legacy = re.findall(
        r'\[baseMapKey\]:\s*\{\s*\.\.\.(?:baseMaps\.value\[baseMapKey\]|baseMap)\s*,\s*heightmap:', src)
    if legacy:
        problems.append(f'仍有 {len(legacy)} 处旧形态「整体替换 baseMap 对象 + heightmap:」')

    return problems, len(re.findall(r'commitHeightmap\(baseMapKey', src))


JS = r"""(async () => {
  const fails = [];
  const notes = [];
  const ck = (label, cond, extra) => {
    if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 200));
  const sumArr = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };
  const gridCenter = (hm) => {
    const pts = hm.grid.points;
    const p = pts[Math.floor(pts.length / 2)];
    return [Array.isArray(p) ? p[0] : p.x, Array.isArray(p) ? p[1] : p.y];
  };

  const app = document.querySelector('#app').__vue_app__;
  const store = app._instance.setupState.store;
  const nodes = store.nodes;
  ck('装置：store 已就绪（有节点 / 已打开项目）', nodes.length > 0, { nodes: nodes.length });

  // ══════════════════════════════════════════════════════
  // f1 未绑定（底图自持）：写入落底图侧；undo 复原且不打时间戳
  // ══════════════════════════════════════════════════════
  const K1 = 'M1b自持用例底图';
  if (!store.baseMaps[K1]) store.addBaseMap(K1, { name: K1 });
  ck('f1 装置：底图已建立', !!store.baseMaps[K1], { keys: Object.keys(store.baseMaps).length });
  const cr = store.createBaseMapHeightmap(K1);
  ck('f1 可为零绑定底图创建高度图（一等场景，不是兜底）', !!(cr && cr.ok === true), cr);
  const hm1 = store.getHeightmapFor(K1);
  ck('f1 底图持有自己的高度图（未绑定 → self）', !!(hm1 && hm1.grid), null);

  if (hm1 && hm1.grid) {
    await tick(25);                       // 跨毫秒，保证时间戳可比
    const u0 = store.baseMaps[K1].updatedAt;
    const c1 = gridCenter(hm1);
    store.applyHeightBrush(K1, c1[0], c1[1], 60, 50, 'raise');
    const hm1b = store.getHeightmapFor(K1);
    const u1 = store.baseMaps[K1].updatedAt;
    const raised = sumArr(hm1b.h);
    ck('f1 未绑定：写入落在底图自己那份', raised > 0, { sum: raised });
    ck('f1 redo 打了时间戳', u1 !== u0, { before: u0, after: u1 });

    // ⚠️ 必须先跨毫秒：`new Date().toISOString()` 只到毫秒，若 applyHeightBrush 与 undo 落在
    //    同一毫秒，undo 就算打了时间戳也与 redo 相等 → 这条断言变成**恒真**（假绿）。
    //    反向探针实测踩到过：把 touch 去掉后本断言仍然通过。
    await tick(25);
    store.undo();
    const hm1c = store.getHeightmapFor(K1);
    const u2 = store.baseMaps[K1].updatedAt;
    ck('f1 undo 复原高度', sumArr(hm1c.h) === 0, { sum: sumArr(hm1c.h) });
    ck('f1 undo **不打**时间戳（与 M1b 之前逐字段一致）', u2 === u1, { redo: u1, undo: u2 });
    notes.push('f1 自持底图 ' + cr.cellsX + 'x' + cr.cellsY + ' 格，抬升和=' + raised.toFixed(1));
  }

  // ══════════════════════════════════════════════════════
  // f2 绑定行星：读与写都落在行星那份（真单源）
  // ══════════════════════════════════════════════════════
  const mdKeys = Object.keys(store.mapData || {})
    .filter(k => store.mapData[k] && store.mapData[k].heightmap && store.mapData[k].heightmap.grid);
  const pid = mdKeys[0] || null;
  ck('f2 装置：找到带高度图的行星地图', !!pid, { keys: Object.keys(store.mapData || {}).slice(0, 6) });

  if (pid) {
    const K2 = 'M1b绑定用例底图';
    if (!store.baseMaps[K2]) store.addBaseMap(K2, { name: K2 });
    const bind = store.bindBaseMapToPlanet(K2, pid);
    ck('f2 空底图可绑定到已有高度图的行星', !!(bind && bind.ok === true), bind);
    ck('f2 底图侧不再持有 heightmap（绑定期只认行星那份）', !store.baseMaps[K2].heightmap, null);
    ck('f2 绑定字段已记录行星 id', store.getBoundPlanetId(K2) === pid, { bound: store.getBoundPlanetId(K2) });
    const hmRead = store.getHeightmapFor(K2);
    ck('f2 ★ 读取命中行星那一份（同一个对象）', hmRead === store.mapData[pid].heightmap, null);

    if (hmRead && store.mapData[pid].heightmap) {
      const planetHm0 = store.mapData[pid].heightmap;
      const s0 = sumArr(planetHm0.h);
      const n0 = planetHm0.h.length;
      const c2 = gridCenter(planetHm0);
      store.applyHeightBrush(K2, c2[0], c2[1], 120, 50, 'raise');
      const afterH = store.mapData[pid].heightmap.h;
      const s1 = sumArr(afterH);
      ck('f2 ★ 笔刷写入**行星那份**（mapData[pid].heightmap.h 真的变了）',
         s1 > s0, { before: +s0.toFixed(1), after: +s1.toFixed(1) });
      ck('f2 底图侧没有分裂出副本（无第二份数据）', !store.baseMaps[K2].heightmap, null);

      store.undo();
      const s2 = sumArr(store.mapData[pid].heightmap.h);
      // 容差口径（2026-10-07 定性 —— 这是**精度差**，不是"放宽阈值了事"）：
      //   `h` 在真库里带小数（实测 709/26910 个非整数），而笔刷管线把 h 拷进 `Float32Array`
      //   （applyHeightBrush 的 newH / oldH）→ undo 恢复的是「float32 化后的原值」，
      //   与 JSON 里的 float64 原值在双精度下天然不严格相等（实测相对差 6.6e-11）。
      //   fixture 的 h **全是整数**（float32 可精确表示）→ 差值恒 0，故这条在合成数据下一直是 `===`。
      //   真正的「undo 失败」表现为差 ≈ 整笔抬升量（本用例 s1-s0 与 s0 同量级），
      //   比本容差大 10^5 倍以上 —— 容差不会掩盖真缺陷。
      const tol67 = Math.max(1e-6, Math.abs(s0) * 1e-8);
      const d67 = Math.abs(s2 - s0);
      ck('f2 undo 复原行星那份（容差 = float32 拷贝精度）', d67 <= tol67,
         { before: +s0.toFixed(4), after: +s2.toFixed(4),
           diff: +d67.toExponential(2), tol: +tol67.toExponential(2), n: n0 });
      notes.push('f2 绑定行星 ' + pid + '（' + n0 + ' 格）：写入和 ' + s0.toFixed(1) + ' → ' + s1.toFixed(1));
    }

    // R4（2026-09-25）：行星侧「用地形多边形重建高度图」时会波及所有绑定它的剧本，
    // 所以必须能反查「谁绑了这颗行星」，才能把受影响的名字写进提示（否则用户只会看到
    // 「剧本的地形怎么变了」）。
    const boundList = store.getBaseMapsBoundToPlanet(pid) || [];
    ck('f2（R4）能反查「哪些底图绑了这颗行星」（重建提示要点名受影响者）',
       boundList.some(x => x.key === K2), boundList);
  }

  // ══════════════════════════════════════════════════════
  // f3 R3：baseMaps[*].planetId 必须跟随节点改名（值槽级联）
  // ══════════════════════════════════════════════════════
  const pNode = nodes.find(n => n.layer === 'planet');
  ck('f3 装置：找到行星节点', !!pNode, null);
  if (pNode) {
    const K3 = 'M1b级联用例底图';
    const oldPid = pNode.id;
    const newPid = oldPid + '_renamed';
    if (!store.baseMaps[K3]) store.addBaseMap(K3, { name: K3, planetId: oldPid });
    ck('f3 装置：底图带上了绑定字段', store.baseMaps[K3].planetId === oldPid,
       { planetId: store.baseMaps[K3].planetId });

    const rn = store.changeNodeId(oldPid, newPid);
    ck('f3 节点改名成功', !!(rn && rn.success === true), rn);
    ck('f3 ★ 绑定字段跟随改名（否则绑定悬空 → 底图表现为空地图）',
       ((store.baseMaps[K3] || {}).planetId) === newPid,
       { got: (store.baseMaps[K3] || {}).planetId, want: newPid });

    store.undo();
    ck('f3 undo 回填旧 id',
       ((store.baseMaps[K3] || {}).planetId) === oldPid,
       { got: (store.baseMaps[K3] || {}).planetId, want: oldPid });
  }

  // ══════════════════════════════════════════════════════
  // f4 悬空绑定（行星不存在）：写入回落到底图自身，绝不静默丢弃
  // ══════════════════════════════════════════════════════
  const K4 = 'M1b悬空用例底图';
  if (!store.baseMaps[K4]) {
    const pts4 = [];
    for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) pts4.push([c * 14.4, r * 14.4]);
    const n4 = pts4.length;
    store.addBaseMap(K4, {
      name: K4,
      planetId: '__不存在的行星__',
      heightmap: {
        grid: { points: pts4, spacing: 14.4, cellsX: 6, cellsY: 6, count: n4 },
        h: new Float32Array(n4), temp: new Float32Array(n4),
        prec: new Float32Array(n4), biome: new Uint8Array(n4),
      },
    });
  }
  const hm4 = store.getHeightmapFor(K4);
  ck('f4 悬空绑定时回落到自身（仍读到自己那份）', !!(hm4 && hm4.grid), null);
  if (hm4 && hm4.grid) {
    store.applyHeightBrush(K4, 36, 36, 40, 60, 'raise');
    const s4 = sumArr(store.baseMaps[K4].heightmap.h);
    ck('f4 ★ 写入回落到**底图自身**（不静默丢弃这次编辑）', s4 > 0, { sum: +s4.toFixed(1) });
    store.undo();
    ck('f4 undo 复原', sumArr(store.baseMaps[K4].heightmap.h) === 0, null);
  }

  // ══════════════════════════════════════════════════════
  // f6（R2）一星一图：同一颗行星不能被第二张底图绑定
  // ══════════════════════════════════════════════════════
  // 为什么必须挡：两张「历史时期」地图共用一份地形时，在时期 A 涂的山会立刻出现在时期 B 上
  // —— 这类串味不会报错，往往几周后才发现，而那时已经分不清哪一笔是给谁画的。
  if (pid) {
    const K6 = 'M1b一星一图用例底图';
    if (!store.baseMaps[K6]) store.addBaseMap(K6, { name: K6 });
    const b6 = store.bindBaseMapToPlanet(K6, pid);
    ck('f6 ★ 第二张底图绑同一行星被拒（一星一图）',
       !!(b6 && b6.ok === false && b6.conflictKind === 'planet-taken'), b6);
    ck('f6 冲突信息点名占用者', /已被底图/.test((b6 && b6.error) || ''), b6 && b6.error);
    ck('f6 被拒时底图侧没有被写入绑定（零副作用）',
       !(store.baseMaps[K6] || {}).planetId, { planetId: (store.baseMaps[K6] || {}).planetId });
  }

  // ══════════════════════════════════════════════════════
  // f7（P3）切换项目 / 事实源必须清空 undo 栈
  // ══════════════════════════════════════════════════════
  // undo 命令的闭包捕获的是「它当时操作的那个数据对象」。跨项目/跨事实源留着它们，
  // 就会出现「在新项目里 Ctrl+Z，把上一个项目的形状回滚进来」—— 一次无法解释的改动。
  const U = await import('/src/store/undo.js');
  const K7 = 'M1b撤销栈用例底图';
  if (!store.baseMaps[K7]) store.addBaseMap(K7, { name: K7 });
  ck('f7 装置：项目态下栈里有可撤销命令', U.canUndo.value === true, { canUndo: U.canUndo.value });
  const pinia7 = app.config.globalProperties.$pinia;
  const { useProjectStore } = await import('/src/store/projectStore.js');
  const proj7 = useProjectStore(pinia7);
  await proj7.closeProject();
  await tick(500);
  ck('f7 ★ 关闭项目后 undo 栈已清空（否则撤销会跨事实源回滚）',
     U.canUndo.value === false && U.historyLength.value === 0,
     { canUndo: U.canUndo.value, len: U.historyLength.value });

  return JSON.stringify({ fails, notes });
})()"""


def run(cdp):
    fails = []
    notes = []

    # ---- f0 静态守卫 ----
    try:
        problems, n_commit = _static_guard()
    except Exception as e:                                  # 读盘失败不能算通过
        problems, n_commit = [f'源码读取异常：{e}'], 0
    if problems:
        fails.extend(problems)
    # 计数口径：5 个写入入口各 2 处（undo/redo）= 10，外加 createBaseMapHeightmap 的 2 处
    # 与 `function commitHeightmap(` 定义行 1 处 = 13。真正的守卫是上面**按函数体**逐个断言，
    # 计数只是「有人整段删掉」的护栏。
    if n_commit < 12:
        fails.append(f'commitHeightmap(baseMapKey 调用点只有 {n_commit} 处（应为 13：5 入口×2 + 创建入口×2 + 定义行）')

    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    wait_for(cdp, f"{STORE}.nodes.length > 0", timeout=45, desc='地理数据加载')

    ok, res = eval_json(cdp, JS, desc='M1b 写入统一')
    if not ok:
        return False, res
    if isinstance(res, dict):
        fails.extend(res.get('fails') or [])
        notes.extend(res.get('notes') or [])

    if fails:
        return False, f'M1b 断言失败 {len(fails)} 项：' + '；'.join(str(x) for x in fails[:10])
    return True, ('写入统一（5 个写入入口的函数体全部经 commitHeightmap；源码内共 ' + str(n_commit) + ' 处调用）'
                  + ('；' + '；'.join(notes) if notes else ''))
