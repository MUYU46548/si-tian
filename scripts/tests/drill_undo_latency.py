#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""撤销/重做的**端到端时延**（真机 · 真实项目副本，2026-11-05）

为什么要有这一份（C2）：阶段目标卡的出口判据第 3 条原文是
“无 P0/P1 阻断：…**撤销卡顿仍待量**”—— `docs/plan` 里从来没有一个读数。
此前只量了 `render()` / 平移 / 拖顶点 / 建省松手 / 涂归属落库，**撤销**这条路一次都没数过，
所以“撤销卡不卡”一直是观感争论，不是事实。

口径（用户能感觉到的那一下）：

  ① `sync`        —— 按下 Ctrl+Z 到**撤销命令的 undo 回调跑完**（同步段：账本组撤 + 投影重算，
                     或地形数组换新；这是主线程被占住、用户按什么都没反应的那一段）。
  ② `toNextFrame` —— 按键到**下一帧绘制**。同步段结束后 Vue 还要把改动刷进画布，
                     真正“看见结果”是这一帧。**用户说的卡顿 = 这个数字大**。
  ③ 撤销本身长任务 —— 撤销后 250ms 内最长的主线程长任务（`PerformanceObserver 'longtask'`）。
  ④ 撤销后自动保存 —— 撤销 300ms 后那条自动保存的长任务（`U.saves` 里有它的起点与耗时，
                     单列，不混进 ③；**这一条同样在用户眼前**，所以也有阈值）。
  ⑤ 掉帧数        —— 窗口内 >33.4ms 的帧间隔个数（60Hz 下一帧 16.7ms）。

四类撤销各量一遍（都是用户真会按的动作）：
  A `指派势力`（涂归属一笔 → Ctrl+Z；走账本组撤，`stack:'ledger'`）
  B `编辑省份`（改省份颜色 → Ctrl+Z；走快照，地形数组换新 + 整图重绘）
  C `添加标记`（加一个标记 → Ctrl+Z）
  D 连续撤销（涂 5 笔 → 连按 5 次 Ctrl+Z，看会不会越撤越慢、有没有堆积）

判据（阈值口径见 `--budget-*`，默认即本轮的拍板值）：
  · 前置：单次撤销（A/B/C）窗口的 rAF 必须活着（**中位帧间隔 ≤25ms**、至少 8 帧）。
    不满足 = 这台机器/这个窗口根本没在出帧，数字无效 —— 判“没测到”，不是“通过”。
  · 每条撤销都真的撤销了：`undoLabel` 是期望的那条、数据确实回到原值（读 store 的缓存口径，
    **不是**按日期算的 `ownerPolityForProvince` —— 两者在真实项目里本来就不一定相等，第一版就栽在这）。
  · `sync ≤ 50ms`（与“涂归属”松手同一口径；实测 0.1~2.5ms —— **撤销命令本身一点都不慢**）。
  · `toNextFrame ≤ 150ms`（60Hz 下掉 8 帧以上；实测 57~104ms，>100ms 就是**看得见的一顿**）。
  · 撤销本身长任务 ≤150ms；撤销后自动保存（+300ms）≤200ms。
  · 真实项目只读：跑前/跑后 sha256 一致（全程只在副本上操作、隔离 user-data-dir）。

⚠️ **D（连续撤销）只记录、不设闸门**：连按时每一步都会重排一次保存（剧本 300ms + 项目 800ms
   两层防抖，8MB 项目一次落盘几百 ms），实测会出现 1~3 秒主线程占满 —— 那是保存链的账
   （卡“涂归属松手 62ms / 保存链”），不该用一个时红时绿的阈值把"撤销命令本身很快"这件事糊掉。
   报告里把每一步的读数如实列出，供那张卡使用。

诊断：默认采两段 CPU 样本（A1 与 D 的撤销窗口，落 `profile-*.json` 并在汇总里给 self time 前几名）——
“撤销之后那一下到底花在谁身上”要有函数级的答案，不能只有观感。

用法：
  python scripts/tests/drill_undo_latency.py                 # 用配置里的最近项目
  python scripts/tests/drill_undo_latency.py --project <file.sitian>
  python scripts/tests/drill_undo_latency.py --report-only   # 只出读数，不下结论（定阈值用）

产物：`build/undo-latency/<时间戳>/{result.json, summary.md, electron.log, vite.log}`
⚠️ 会开一个真实 Electron 窗口（约 2~3 分钟）；跑之前别让 `run_tests.py` / 其它演练占着 5180。
"""
import argparse
import hashlib
import json
import os
import socket
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Windows 控制台默认 GBK：一条 ✅/▶ 就会让脚本崩在 UnicodeEncodeError 上
# （那不是断言失败，是压根没开始跑 —— 2026-11-03 实测，见 drill_owner_latency 同处注释）
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8')
    except Exception:
        pass
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

DEV_PORT = 5180
CDP_PORT = 9227          # 9222=Edge 回归 / 9224=行星截图 / 9226=涂归属时延，这里避开
APP_CFG = os.path.join(os.environ.get('APPDATA', ''), 'SiTian', 'config.json')

fails = []


# ══════════════════════════════════════════════════════════════════════════
# 页面侧脚本（全部只读状态 / 走产品自己的入口，不另造钩子）
# ══════════════════════════════════════════════════════════════════════════

# 把 store.undo / redo 包一层计时 + 起一个帧时钟。App 的全局 Ctrl+Z 调的就是 store.undo()。
INSTRUMENT_JS = r"""(async () => {
  const app = document.querySelector('#app').__vue_app__;
  const s = app._instance.setupState.store;
  if (window.__U && window.__U.wraps && window.__U.wraps.length) {
    return JSON.stringify({ ok: true, already: true, wraps: window.__U.wraps });
  }
  const U = { frames: [], marks: [], longtasks: [], wraps: [], longtaskErr: '' };
  window.__U = U;

  // 帧时钟：每帧记 [**回调实际执行时刻**, 与上一帧的真实间隔, vsync 时间戳]。
  // 🔴 为什么不用 rAF 的参数 ts 当"画出来的时刻"：ts 是**这一帧的 vsync 起点**，
  //    主线程被占住时回调照样拿到那个偏早的时间戳（第一版据此算出 8ms，而长任务是 75ms ——
  //    把"卡"读成了"不卡"）。真实手感只能看 performance.now()。
  let last = null;
  const loop = (ts) => {
    const now = performance.now();
    if (last != null) U.frames.push([now, now - last, ts]);
    last = now;
    if (U.frames.length > 4000) U.frames.splice(0, 2000);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // 长任务：同步段之后如果还有别的重活（Vue 刷新 / 自动保存防抖到点），这里会露出来
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) U.longtasks.push([e.startTime, e.duration]);
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { U.longtaskErr = String((e && e.message) || e); }

  const wrap = (name) => {
    const orig = s[name];
    if (typeof orig !== 'function') return;
    s[name] = function () {
      const labelBefore = (s.undoLabel || '') + '';
      const t0 = performance.now();
      try {
        return orig.apply(this, arguments);
      } finally {
        U.marks.push({ kind: name, t0, wall: Date.now(), sync: performance.now() - t0,
                       label: labelBefore, labelAfter: (s.undoLabel || '') + '' });
      }
    };
    U.wraps.push(name);
  };
  wrap('undo');
  wrap('redo');

  const proj = await import('/src/store/projectStore.js').then(({ useProjectStore }) => useProjectStore(app.config.globalProperties.$pinia));

  // 保存链路计时：撤销之后 300ms 会触发剧本保存、800ms 后项目落盘 —— 各占多少要能拆开说，
  // 否则"撤销之后卡一下"会被误记到撤销命令头上（本轮的首要区分点）。
  U.saves = [];
  const timed = (obj, name, kind) => {
    const orig = obj && obj[name];
    if (typeof orig !== 'function') return false;
    obj[name] = function () {
      const t0 = performance.now();
      const p = orig.apply(this, arguments);
      const rec = { kind, t0, sync: performance.now() - t0, total: null };
      U.saves.push(rec);
      if (p && typeof p.then === 'function') {
        p.then(() => { rec.total = performance.now() - t0; }, () => { rec.total = performance.now() - t0; });
      }
      return p;
    };
    return true;
  };
  U.saveWraps = [];
  if (timed(s, 'saveScenarios', 'scenarios')) U.saveWraps.push('saveScenarios');
  if (timed(proj, 'saveProject', 'project')) U.saveWraps.push('saveProject');

  return JSON.stringify({ ok: true, wraps: U.wraps, saveWraps: U.saveWraps,
                          longtask: U.longtaskErr || 'observed',
                          canUndo: !!s.canUndo, undoLabel: (s.undoLabel || '') + '',
                          project: proj.filePath || '', dirty: !!proj.dirty });
})()"""

RESET_JS = r"""(() => {
  const U = window.__U;
  U.frames.length = 0; U.marks.length = 0; U.longtasks.length = 0;
  return JSON.stringify({ ok: true });
})()"""

# 读回一批标记的统计。
#   · `toNextFrame` 取**全量帧表**里 t1 之后的第一个帧（窗口放到 3s）—— 主线程被占住时
#     420ms 窗口里可能一帧都没有，那是"卡住了"，不能被读成 null 就当没事；
#   · `blockedMs` = 到下一帧减去同步段，就是"命令跑完了、画面还没出来"的那一段；
#   · `saves` 把窗口内的保存调用点出来（撤销 300ms 后会触发剧本保存）。
READ_JS = r"""(() => {
  const U = window.__U;
  const r2 = (x) => Math.round(x * 100) / 100;
  const marks = U.marks.map((m) => {
    const t0 = m.t0;
    const t1 = m.t0 + m.sync;
    const near = U.frames.filter((f) => f[0] >= t0 - 200 && f[0] <= t0 + 3000);
    const next = U.frames.find((f) => f[0] > t1) || null;
    const gaps = near.map((f) => r2(f[1]));
    const lt = U.longtasks.filter((e) => e[0] + e[1] >= t0 && e[0] <= t0 + 700);
    const sv = U.saves.filter((x) => x.t0 >= t0 - 50 && x.t0 <= t0 + 900)
      .map((x) => ({ kind: x.kind, at: r2(x.t0 - t0), sync: r2(x.sync),
                     total: x.total == null ? null : r2(x.total) }));
    return {
      kind: m.kind, label: m.label, labelAfter: m.labelAfter, wall: m.wall, t0: m.t0,
      sync: r2(m.sync),
      toNextFrame: next ? r2(next[0] - t0) : null,
      blockedMs: next ? r2(next[0] - t1) : null,
      maxFrameGap: gaps.length ? Math.max.apply(null, gaps) : null,
      gaps,
      frameCount: near.length,
      medianGap: gaps.length ? (function () {
        const s = gaps.slice().sort((a, b) => a - b);
        const n = s.length;
        return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
      })() : null,
      longtasks: lt.map((e) => ({ at: r2(e[0] - t0), dur: r2(e[1]) })),
      longMax: lt.length ? Math.max.apply(null, lt.map((e) => e[1])) : 0,
      saves: sv,
    };
  });
  U.marks = [];
  return JSON.stringify({ ok: true, marks, frameTotal: U.frames.length,
                          longtaskTotal: U.longtasks.length, saveTotal: U.saves.length });
})()"""

# 保存流水线的分段读数（`projectStore.saveProject` 每段都打点，见 `window.__SITIAN_SAVE_LOG__`）。
# 为什么要它：以前只有"这一段里有个长任务"这种页面级读数，只能推测病根；有了分段读数，
# "是快照深拷慢 / 序列化慢 / IPC 慢"一眼可读（卡「撤销连按被保存链拖住」第一步就是这句）。
SAVE_LOG_JS = r"""(() => {
  const log = (window.__SITIAN_SAVE_LOG__ || []).slice(0, 12);
  return JSON.stringify({ ok: true, runs: (window.__SITIAN_SAVE_LOG__ || []).length, log });
})()"""

# 国界几何的成本拆解（撤销卡顿的嫌疑对象）：重建索引 vs 只按归属分拣。
# 直接调产品自己的纯函数（不是另写一份），量出来的就是渲染路径上那一段。
DIAG_JS = r"""(async () => {
  const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const m = await import('/src/utils/vertexSharing.js');
  const terrain = SM.rawTerrain();
  if (!terrain || !terrain.length) return JSON.stringify({ ok: false, why: 'no-terrain' });
  const r = (x) => Math.round(x * 100) / 100;
  let verts = 0;
  for (const p of terrain) {
    verts += (p.points || []).length;
    for (const ring of (p.extraRings || [])) verts += ((ring && ring.points) || []).length;
  }
  const t0 = performance.now();
  const idx = m.buildEdgeIndex(terrain);
  const t1 = performance.now();
  const owners = terrain.map((p) => {
    const o = SM.ownerPolityForProvince(p.id);
    return o ? String(o.id || o) : '';
  });
  const t2 = performance.now();
  const cached = m.edgeIndexFor(terrain);
  const edges = m.buildPolityBordersFromEdges ? m.buildPolityBordersFromEdges(cached, owners) : [];
  const t3 = performance.now();
  return JSON.stringify({ ok: true, provinces: terrain.length, vertices: verts,
    edges: idx.size, borderEdges: edges.length,
    buildIndexMs: r(t1 - t0), ownersMs: r(t2 - t1), classifyMs: r(t3 - t2) });
})()"""

# 这个项目有多大 / 这条剧本走的是账本还是快照 —— 读数必须能对上“量的是什么规模”
INFO_JS = r"""(async () => {
  const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const sc = SM.selectedScenario;
  if (!sc) return JSON.stringify({ ok: false, why: 'no-scenario' });
  const bmKey = sc.ownerKey;
  const bm = (s.baseMaps || {})[bmKey] || null;
  return JSON.stringify({
    ok: true,
    scenario: sc.id, scenarioName: sc.name || '',
    baseMap: bmKey || '',
    provinces: bm ? (bm.terrain || []).length : 0,
    rivers: bm ? (bm.rivers || []).length : 0,
    polities: (sc.polities || []).length,
    scenarios: Object.keys(s.scenarios || {}).length,
    hasLedger: !!(sc.ledger && Array.isArray(sc.ledger.events)),
    ledgerEvents: sc.ledger && sc.ledger.events ? sc.ledger.events.length : 0,
    changeEventProvinces: Object.keys(sc.changeEvents || {}).length,
    markers: (sc.markers || []).length,
    tool: SM.tool,
  });
})()"""

# 铺一笔涂归属：用产品自己的命中函数挑点（重心可能在省外 —— drill_owner_latency 真踩过），
# 交替两个势力，保证每一笔都**真的改了归属**（否则撤销的是一条空命令，测了个寂寞）。
SETUP_STROKE_JS = r"""(async () => {
  const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const sc = SM.selectedScenario;
  if (!sc) return JSON.stringify({ ok: false, why: 'no-scenario' });
  const polities = sc.polities || [];
  if (!polities.length) return JSON.stringify({ ok: false, why: 'no-polity' });
  const k = window.__USTROKE__ || 0;
  window.__USTROKE__ = k + 1;
  const pol = polities[k % Math.min(2, polities.length)] || polities[0];

  // ⚠️ 先切工具再量矩形：切到 ownerBrush 会多出一行笔刷设置，画布高度会变（drill_owner_latency 实测）
  SM.setTool('ownerBrush');
  SM.selectedPolity = pol;
  if (typeof SM.clearOwnerMode !== 'undefined') SM.clearOwnerMode = false;
  if (typeof SM.fitToView === 'function') SM.fitToView();
  SM.render();
  await new Promise((r) => setTimeout(r, 200));

  const cvs = SM.canvas;
  const rect = cvs.getBoundingClientRect();
  let hit = null;
  for (let gy = 1; gy <= 11 && !hit; gy++) {
    for (let gx = 1; gx <= 13 && !hit; gx++) {
      const w = SM.screenToWorld(rect.width * gx / 14, rect.height * gy / 12);
      const p = SM.findProvinceAt(w.x, w.y);
      if (!p || p.kind === 'sea') continue;
      const cur = SM.ownerPolityForProvince(p.id);
      const curId = cur && (cur.id || cur);
      if (curId === pol.id) continue;
      hit = { id: p.id, wx: w.x, wy: w.y, curId: curId || null };
    }
  }
  if (!hit) return JSON.stringify({ ok: false, why: 'no-target-province' });

  const scale = 0.8;
  SM.cameraScale = scale;
  SM.cameraX = rect.width / 2 - hit.wx * scale;
  SM.cameraY = rect.height / 2 - hit.wy * scale;
  SM.render();
  await new Promise((r) => setTimeout(r, 180));

  const wCenter = SM.screenToWorld(rect.width / 2, rect.height / 2);
  const verify = SM.findProvinceAt(wCenter.x, wCenter.y);
  // 🔴 目标**以画布中心命中的那个省为准**（2026-11-05）：这一笔是打在画布中心的，而"居中"这一步
  //    受相机夹取 / 取整影响，扫到的小省会偏出中心点 —— 真机踩过：目标是 `_229`、中心点却落在 `_194`，
  //    于是"相机对准目标省"这条前置判据随机变红（同一份代码两次跑一红一绿）。判据口径改成
  //    "中心点落在哪个省就涂哪个省"，既不会假红，也不放过真的没对准（中心点是海 / 已归目标势力仍报失败）。
  if (!verify || verify.kind === 'sea') {
    return JSON.stringify({ ok: false, why: 'center-is-sea', target: hit.id, verify: verify ? verify.id : null });
  }
  let target = hit;
  if (verify.id !== hit.id) {
    const centerOwner = SM.ownerPolityForProvince(verify.id);
    const centerOwnerId = centerOwner && (centerOwner.id || centerOwner);
    if (centerOwnerId === pol.id) {
      return JSON.stringify({ ok: false, why: 'center-owned-by-target-polity',
                              target: hit.id, verify: verify.id });
    }
    target = { id: verify.id, curId: centerOwnerId || null };
  }
  window.__UPROBE__ = { provinceId: target.id, polityId: pol.id, scenarioId: sc.id,
                        baseMapKey: SM.baseMapKey, beforeOwner: target.curId,
                        scanned: hit.id };
  return JSON.stringify({ ok: true, province: target.id, polity: pol.id,
    verify: verify.id, verifySame: true, scanned: hit.id,
    canvas: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)] });
})()"""

# 真一笔：mousedown → 3 次 mousemove → 松手（与真人笔刷同一条监听路径）
PAINT_JS = r"""(() => {
  const SM = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const cvs = SM.canvas;
  const rect = cvs.getBoundingClientRect();
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);
  const mk = (type, cx, cy) => new MouseEvent(type, {
    clientX: cx, clientY: cy, bubbles: true, cancelable: true, button: 0, buttons: 1,
  });
  const t0 = performance.now();
  cvs.dispatchEvent(mk('mousedown', x, y));
  for (let i = 1; i <= 3; i++) cvs.dispatchEvent(mk('mousemove', x + i * 3, y + i * 2));
  const tUp = performance.now();
  cvs.dispatchEvent(mk('mouseup', x + 9, y + 6));
  const t1 = performance.now();
  return JSON.stringify({ ok: true,
    downMs: Math.round((tUp - t0) * 100) / 100,
    commitMs: Math.round((t1 - tUp) * 100) / 100,
    strokeMs: Math.round((t1 - t0) * 100) / 100,
    tool: SM.tool,
    label: (s.undoLabel || '') + '' });
})()"""

# 改省份颜色（走 updateBaseProvince，与省份面板同一个写口）—— B 类：快照撤销 + 整图重绘
EDIT_GEO_JS = r"""(() => {
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const pr = window.__UPROBE__;
  const sc = s.scenarios[pr.scenarioId];
  if (!sc) return JSON.stringify({ ok: false, why: 'no-scenario' });
  const bm = (s.baseMaps || {})[sc.ownerKey];
  if (!bm) return JSON.stringify({ ok: false, why: 'no-basemap' });
  const prov = (bm.terrain || []).find((p) => p.id === pr.provinceId);
  if (!prov) return JSON.stringify({ ok: false, why: 'no-province' });
  const palette = ['#8a5a44', '#5a7a44', '#445a8a', '#8a7a44'];
  const next = palette.find((c) => c !== prov.color) || '#445a8a';
  window.__UCOLOR__ = { before: prov.color || null, after: next };
  s.updateBaseProvince(sc.ownerKey, pr.provinceId, { color: next });
  return JSON.stringify({ ok: true, baseMap: sc.ownerKey, province: pr.provinceId,
                          before: prov.color || null, after: next,
                          label: (s.undoLabel || '') + '' });
})()"""

# 加一个标记（走 addScenarioMarker）—— C 类：轻量快照撤销
ADD_MARKER_JS = r"""(() => {
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const pr = window.__UPROBE__;
  const sc = s.scenarios[pr.scenarioId];
  if (!sc) return JSON.stringify({ ok: false, why: 'no-scenario' });
  const before = (sc.markers || []).length;
  s.addScenarioMarker(pr.scenarioId, { id: 'undo_probe_' + Date.now(), x: 120, y: 120,
                                       name: '撤销测速标记', type: 'default' });
  const sc2 = s.scenarios[pr.scenarioId];
  return JSON.stringify({ ok: true, before, after: (sc2.markers || []).length,
                          label: (s.undoLabel || '') + '' });
})()"""

# 读内存态（撤销到底有没有真的把值改回去 —— 不能只看 undoLabel）
STATE_JS = r"""(() => {
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const pr = window.__UPROBE__ || {};
  const sc = pr.scenarioId ? s.scenarios[pr.scenarioId] : null;
  const bm = sc ? (s.baseMaps || {})[sc.ownerKey] : null;
  const prov = bm ? (bm.terrain || []).find((p) => p.id === pr.provinceId) : null;
  return JSON.stringify({
    ok: !!sc,
    owner: sc ? ((sc.ownership || {})[pr.provinceId] || null) : null,
    changeEvents: sc ? (((sc.changeEvents || {})[pr.provinceId]) || []).length : -1,
    ledgerEvents: sc && sc.ledger && sc.ledger.events ? sc.ledger.events.length : -1,
    color: prov ? (prov.color || null) : null,
    markers: sc ? (sc.markers || []).length : -1,
    undoLabel: (s.undoLabel || '') + '',
    canUndo: !!s.canUndo, canRedo: !!s.canRedo,
  });
})()"""


# ══════════════════════════════════════════════════════════════════════════
# 壳子（与 drill_owner_latency 同一套：隔离 profile、只碰副本）
# ══════════════════════════════════════════════════════════════════════════

def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def port_open(port):
    s = socket.socket()
    s.settimeout(0.3)
    try:
        return s.connect_ex(('127.0.0.1', port)) == 0
    finally:
        s.close()


def wait_port(port, timeout=120):
    end = time.time() + timeout
    while time.time() < end:
        if port_open(port):
            return True
        time.sleep(0.4)
    return False


def wait_http(url, timeout=120):
    import urllib.request
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    end = time.time() + timeout
    while time.time() < end:
        try:
            with opener.open(url, timeout=1) as r:
                if r.status < 500:
                    return True
        except Exception:
            time.sleep(0.4)
    return False


def ck(name, ok, detail=''):
    print(('  ✅ ' if ok else '  ❌ ') + name + (' — ' + str(detail) if detail else ''), flush=True)
    if not ok:
        fails.append(name + (' — ' + str(detail) if detail else ''))
    return bool(ok)


def ctrl_z(cdp):
    """走真实键盘输入链路（Input.dispatchKeyEvent，Ctrl 的 modifiers 位 = 2）。"""
    for t in ('rawKeyDown', 'keyUp'):
        cdp.send('Input.dispatchKeyEvent', {
            'type': t, 'modifiers': 2, 'key': 'z', 'code': 'KeyZ',
            'windowsVirtualKeyCode': 90, 'nativeVirtualKeyCode': 90,
        })


def dismiss_disclaimer(cdp):
    """首启免责声明（隔离 profile 里一定会弹）—— 按产品自己的路径走完。"""
    r = cdp.eval("""(() => {
      const sc = document.querySelector('[data-testid="disclaimer-scroll"]');
      if (!sc) return 'no-dialog';
      sc.scrollTop = sc.scrollHeight;
      sc.dispatchEvent(new Event('scroll', { bubbles: true }));
      return 'scrolled';
    })()""")
    time.sleep(0.5)
    cdp.eval("""(() => {
      const dlg = document.querySelector('[data-testid="disclaimer-dialog"]');
      const sm = dlg && dlg.__vueParentComponent && dlg.__vueParentComponent.setupState;
      if (sm && 'agreed' in sm) sm.agreed = true;
      return 'agree-set';
    })()""")
    time.sleep(0.4)
    cdp.eval("""(() => {
      const b = document.querySelector('[data-testid="disclaimer-accept"]');
      if (b) b.click();
      return 'ok';
    })()""")
    time.sleep(0.7)
    return r


def handle_disclaimer(cdp):
    """首启免责声明是懒加载组件：挂载后要等一拍才在 DOM 里。
    没弹出（老 profile / 已同意）也算处理完 —— 这一条不该让整份演练红。"""
    from lib.cdp import wait_for
    try:
        wait_for(cdp, "!!document.querySelector('[data-testid=\"disclaimer-dialog\"]')",
                 timeout=8, desc='免责声明')
    except RuntimeError:
        return 'no-dialog'
    return dismiss_disclaimer(cdp)


# ── CPU 采样（把“撤销之后那 100ms 到底花在谁身上”说清）──────────────────────
def profile_start(cdp):
    """开始采样，并返回**页面时钟**（`performance.now()`）。

    🔴 不能拿 `Date.now()` 当窗口坐标：`Profiler.startTime` 与 `performance.now()`
       是同一套单调时钟，混着 `Date.now()` 过滤会一条样本都留不下（第一版窗口里 0 样本）。
    """
    cdp.send('Profiler.enable')
    cdp.send('Profiler.setSamplingInterval', {'interval': 500})
    cdp.send('Profiler.start')
    try:
        return float(cdp.eval('performance.now()'))
    except Exception:
        return None


def profile_stop(cdp, path, topn=12, offset_ms=None, span_ms=None):
    prof = (cdp.send('Profiler.stop') or {}).get('profile') or {}
    try:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(prof, f)
    except Exception as e:                                        # noqa: BLE001
        print(f'  ⚠️ profile 落盘失败：{e}')
    return agg_profile(prof, topn, offset_ms, span_ms)


def agg_profile(prof, topn=12, offset_ms=None, span_ms=None):
    """按 self time 聚合到函数（timeDeltas 单位是微秒）。

    :param offset_ms: 窗口起点（相对采样开始的毫秒数 = 撤销那一刻 − 开始采样那一刻）
    :param span_ms:   窗口长度
    """
    nodes = {n.get('id'): n for n in (prof.get('nodes') or [])}
    samples = prof.get('samples') or []
    deltas = prof.get('timeDeltas') or []
    start_us = prof.get('startTime') or 0
    cur = start_us
    self_us = {}
    covered_us = 0
    for i, sid in enumerate(samples):
        d = deltas[i] if i < len(deltas) else 0
        cur += d
        rel_ms = (cur - start_us) / 1000.0
        if offset_ms is not None and not (offset_ms <= rel_ms <= offset_ms + (span_ms or 220)):
            continue
        self_us[sid] = self_us.get(sid, 0) + d
        covered_us += d
    rows = []
    for sid, us in self_us.items():
        cf = (nodes.get(sid) or {}).get('callFrame') or {}
        url = cf.get('url') or ''
        rows.append({'fn': cf.get('functionName') or '(anonymous)',
                     'file': url.split('/')[-1] if url else '',
                     'line': cf.get('lineNumber'), 'ms': round(us / 1000.0, 1)})
    rows.sort(key=lambda r: -r['ms'])
    return {'totalMs': round(covered_us / 1000.0, 1), 'top': rows[:topn],
            'window': [round(offset_ms, 1), span_ms] if offset_ms is not None else None}


def median(xs):
    ys = sorted(xs)
    if not ys:
        return None
    n = len(ys)
    return round((ys[(n - 1) // 2] if n % 2 else (ys[n // 2 - 1] + ys[n // 2]) / 2) * 100) / 100


def resolve_project(args):
    if args.project:
        return args.project
    try:
        with open(APP_CFG, encoding='utf-8') as f:
            p = (json.load(f) or {}).get('lastProjectPath', '')
        if p and os.path.exists(p):
            return p
    except Exception:
        pass
    # 兜底：文档目录里最大的那个项目（今天真实数据是 1005 省 / 14 段剧本；专名不进仓，见隐私扫描）
    d = os.path.join(os.environ.get('USERPROFILE', ''), 'Documents', 'SiTianProjects')
    cands = []
    if os.path.isdir(d):
        for f in os.listdir(d):
            if f.endswith('.sitian'):
                full = os.path.join(d, f)
                cands.append((os.path.getsize(full), full))
    return max(cands)[1] if cands else ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--project', default='')
    ap.add_argument('--strokes', type=int, default=5, help='A 类（涂归属撤销）笔数')
    ap.add_argument('--geo', type=int, default=3, help='B 类（编辑省份撤销）次数')
    ap.add_argument('--markers', type=int, default=2, help='C 类（标记撤销）次数')
    ap.add_argument('--chain', type=int, default=5, help='D 类连续撤销的步数')
    ap.add_argument('--budget-sync', type=float, default=50.0)
    ap.add_argument('--budget-frame', type=float, default=150.0,
                    help='按键到下一帧的上限（150ms = 60Hz 下掉 8 帧以上；实测 57~104ms）')
    ap.add_argument('--budget-longtask', type=float, default=150.0)
    ap.add_argument('--budget-save', type=float, default=200.0,
                    help='撤销 300ms 后自动保存的长任务上限（用户同样看得见这一顿）')
    ap.add_argument('--budget-chain', type=float, default=200.0,
                    help='连续撤销（D 段）里单段长任务上限；口径来自卡「撤销连按被保存链拖住」：'
                         '任何一段 ≤200ms 且每次都能出帧')
    ap.add_argument('--report-only', action='store_true', help='只出读数、不下结论（定阈值用）')
    ap.add_argument('--no-profile', action='store_true', help='不采 CPU 样本（默认采 A1 与 D）')
    args = ap.parse_args()

    real = resolve_project(args)
    if not real or not os.path.exists(real):
        print(f'  ❌ 找不到真实项目（{real!r}）→ 用 --project <file.sitian> 指定')
        return 2
    for p in (DEV_PORT, CDP_PORT):
        if port_open(p):
            print(f'  ❌ 端口 {p} 已被占用（先停掉正在跑的回归/演练）')
            return 2

    ts = time.strftime('%Y%m%d-%H%M%S')
    out_dir = os.path.join(ROOT, 'build', 'undo-latency', ts)
    os.makedirs(out_dir, exist_ok=True)
    real_sha_before = sha256(real)
    work = os.path.join(out_dir, 'work-copy.sitian')
    shutil.copy2(real, work)

    print('=== 撤销/重做端到端时延 · 真实项目副本 ===')
    print(f'  原项目（只读）：{real}')
    print(f'  sha256 {real_sha_before[:16]}… / {os.path.getsize(real)} 字节')
    print(f'  工作副本：{work}', flush=True)

    import run_tests as RT
    from lib.cdp import CDP, wait_for, eval_json, skip_onboarding

    node = shutil.which('node')
    exe = os.path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    profile = os.path.join(out_dir, 'userdata')
    shutil.rmtree(profile, ignore_errors=True)
    dev = el = None
    result = {}
    try:
        dev = subprocess.Popen([node, os.path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
                                '--config', 'vite.config.js'],
                               cwd=ROOT, stdout=open(os.path.join(out_dir, 'vite.log'), 'w'),
                               stderr=subprocess.STDOUT)
        if not wait_http('http://localhost:%d/' % DEV_PORT):
            print('  ❌ Vite 没起来（看 vite.log）')
            return 1
        env = dict(os.environ)
        env['NODE_ENV'] = 'development'
        env.pop('OPEN_DEVTOOLS', None)
        env.pop('ELECTRON_RUN_AS_NODE', None)
        # 隔离 profile（开关必须在 app 路径之前）+ 不关 GPU：量的是产品默认配置下的手感
        # ⚠️ 三个「别让窗口被判定为不可见」的开关（2026-11-05）：演练是**无人值守**跑的，Electron 窗口
        #    常常被别的窗口盖住；Windows 的原生遮挡检测 + Chromium 的后台节流会把 rAF 停掉，
        #    于是整段窗口"一帧都没有"——那读起来像"产品卡死"，其实是**测量环境**没在出帧
        #    （历史读数里好/坏交替出现、坏的那几次 frameCount 全是 0，就是这件事）。
        el = subprocess.Popen([exe, '--user-data-dir=%s' % profile,
                               '--remote-debugging-port=%d' % CDP_PORT,
                               '--remote-allow-origins=*',
                               '--disable-backgrounding-occluded-windows',
                               '--disable-renderer-backgrounding',
                               '--disable-background-timer-throttling',
                               '--disable-features=CalculateNativeWinOcclusion', '.'],
                              cwd=ROOT, env=env,
                              stdout=open(os.path.join(out_dir, 'electron.log'), 'w'),
                              stderr=subprocess.STDOUT)
        if not wait_port(CDP_PORT):
            print('  ❌ Electron CDP 没起来（看 electron.log）')
            return 1

        cdp = CDP(port=CDP_PORT)
        wait_for(cdp, "document.readyState === 'complete' && !!document.querySelector('.app-layout')",
                 timeout=180, desc='应用挂载')
        RT.apply_viewport(cdp)
        # 🔴 顺序：先免责声明、后新手引导（反过来引导层会再弹一次 —— shot_planet_ux 真踩）
        dis = handle_disclaimer(cdp)
        ck('首启免责声明已处理（有则按产品路径走完）', dis in ('closed', 'no-dialog', 'scrolled'), dis)
        skip_onboarding(cdp)

        opened = eval_json(cdp, """(async () => {
          const app = document.querySelector('#app').__vue_app__;
          const pinia = app.config.globalProperties.$pinia;
          const { useProjectStore } = await import('/src/store/projectStore.js');
          const ps = useProjectStore(pinia);
          const r = await ps.openProject(%s);
          return JSON.stringify({ ok: !!(r && r.success !== false), err: (r && r.error) || '',
                                  filePath: ps.filePath || '' });
        })()""" % json.dumps(work), required=('ok',), desc='打开工作副本')[1]
        ck('打开的是工作副本（不是真实项目）',
           os.path.normcase(str(opened.get('filePath') or '')) == os.path.normcase(work),
           opened.get('filePath'))
        time.sleep(2.0)
        cdp.eval("(() => { const b = document.querySelector('.recovery-overlay .btn-discard');"
                 " if (b) b.click(); return 'ok'; })()")
        time.sleep(0.8)

        # 进剧本编辑器：点导航“历史剧本”→ 点一张剧本卡（与真人同一条路）
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find((x) => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
        try:
            wait_for(cdp, "!!document.querySelector('.sp-card')", timeout=90, desc='剧本卡片墙')
            cdp.eval("(() => { const c = document.querySelector('.sp-card'); if (c) c.click(); return 'ok'; })()")
            entered = True
        except RuntimeError:
            entered = False
        ck('能进入剧本编辑器（卡片墙 → 剧本）', entered)
        if not entered:
            return 1
        wait_for(cdp, "!!document.querySelector('.scenario-map-container canvas')",
                 timeout=90, desc='剧本画布')
        time.sleep(1.5)

        info = eval_json(cdp, INFO_JS, required=('ok',), desc='项目规模')[1]
        print(f"  实测规模：{info.get('scenarios')} 段剧本 / 本剧本 {info.get('provinces')} 省 / "
              f"{info.get('polities')} 势力 / 账本 {info.get('ledgerEvents')} 条"
              f"（hasLedger={info.get('hasLedger')}）", flush=True)
        ck('剧本已选中且底图有省份', bool(info.get('ok')) and int(info.get('provinces') or 0) > 0,
           json.dumps(info, ensure_ascii=False)[:200])

        ins = eval_json(cdp, INSTRUMENT_JS, required=('ok',), desc='装计时器')[1]
        ck('undo/redo 计时器已挂上（App 的 Ctrl+Z 调的就是它）',
           bool(ins.get('ok')) and 'undo' in (ins.get('wraps') or []),
           json.dumps(ins, ensure_ascii=False)[:200])
        if not (ins.get('ok') and 'undo' in (ins.get('wraps') or [])):
            return 1

        diag = eval_json(cdp, DIAG_JS, required=('ok',), desc='国界几何拆账')[1]
        print(f"  国界几何：{diag.get('provinces')} 省 / {diag.get('vertices')} 顶点 → "
              f"{diag.get('edges')} 条共边（国界 {diag.get('borderEdges')} 条）", flush=True)
        print(f"  ↳ 重建索引 {diag.get('buildIndexMs')} ms / 算归属 {diag.get('ownersMs')} ms / "
              f"只分拣 {diag.get('classifyMs')} ms", flush=True)
        ck('国界几何的引用缓存生效（只换归属时走"只分拣"那条路）',
           diag.get('ok') and diag.get('classifyMs') is not None,
           json.dumps(diag, ensure_ascii=False)[:200])

        def reset():
            eval_json(cdp, RESET_JS, required=('ok',), desc='清缓冲')

        def read_marks(tag, expect=1):
            vals = eval_json(cdp, READ_JS, required=('ok', 'marks'), desc='读撤销读数')[1]
            mk = vals.get('marks') or []
            ck(f'{tag}：读到 {len(mk)} 条撤销读数（期望 {expect}）', len(mk) == expect,
               json.dumps(mk, ensure_ascii=False)[:240])
            return mk

        # ── A：涂归属一笔 → Ctrl+Z ─────────────────────────────────────────
        print('\n── A 涂归属一笔撤销 ──', flush=True)
        a_marks = []
        profiles = {}
        for i in range(args.strokes):
            setup = eval_json(cdp, SETUP_STROKE_JS, required=('ok',), desc='铺涂归属场景')[1]
            if not (setup.get('ok') and setup.get('verifySame')):
                ck(f'A{i + 1} 相机对准目标省', False, json.dumps(setup, ensure_ascii=False)[:200])
                break
            # 🔴 撤销的判据必须与写入**同一口径**：写口改的是缓存 `ownership[省]`，
            #    而 `ownerPolityForProvince()` 是**按日期**算的归属（时间轴游标所在年）——
            #    两者在这个项目里本来就不一定相等（第一版拿它当“撤销前”，五条全假红）。
            st0 = eval_json(cdp, STATE_JS, required=('ok',), desc='涂前状态')[1]
            paint = eval_json(cdp, PAINT_JS, required=('ok',), desc='涂一笔')[1]
            st1 = eval_json(cdp, STATE_JS, required=('ok',), desc='涂后状态')[1]
            pid = setup.get('province')
            ck(f'A{i + 1} 这一笔真的改了归属（{pid}: {st0.get("owner")} → {st1.get("owner")}）',
               bool(st1.get('owner')) and st1.get('owner') == setup.get('polity')
               and st1.get('owner') != st0.get('owner'),
               f"stroke {paint.get('strokeMs')}ms / 落笔到松手 {paint.get('commitMs')}ms")
            # 让剧本层 300ms 自动保存防抖**先跑完**，别把保存的长任务算进撤销窗口
            time.sleep(1.3)
            reset()
            perf0 = None
            if i == 0 and not args.no_profile:
                perf0 = profile_start(cdp)
            ctrl_z(cdp)
            time.sleep(0.55)
            got = read_marks(f'A{i + 1} 涂归属撤销', 1)
            if i == 0 and not args.no_profile and got and perf0 is not None:
                profiles['A1'] = profile_stop(cdp, os.path.join(out_dir, 'profile-A1.json'),
                                              offset_ms=(got[0].get('t0') or 0) - perf0, span_ms=220)
            st2 = eval_json(cdp, STATE_JS, required=('ok',), desc='撤销后状态')[1]
            ck(f'A{i + 1} 撤销真的把归属退回去了（缓存 ownership）',
               (st2.get('owner') or None) == (st0.get('owner') or None),
               f"撤销后 owner={st2.get('owner')!r}（撤销前 {st0.get('owner')!r}）")
            if got:
                got[0]['case'] = 'A'
                got[0]['paintMs'] = paint.get('strokeMs')
                a_marks.extend(got)

        # ── B：改省份颜色 → Ctrl+Z ─────────────────────────────────────────
        print('\n── B 编辑省份撤销（快照 + 整图重绘）──', flush=True)
        b_marks = []
        for i in range(args.geo):
            edit = eval_json(cdp, EDIT_GEO_JS, required=('ok',), desc='改省份颜色')[1]
            if not edit.get('ok'):
                ck(f'B{i + 1} 能改省份颜色', False, json.dumps(edit, ensure_ascii=False)[:200])
                break
            ck(f'B{i + 1} 改色落进撤销栈（label={edit.get("label")!r}）',
               '省份' in (edit.get('label') or ''), edit.get('label'))
            time.sleep(1.8)      # updateBaseProvince 自己就同步 saveScenarios（8MB 深拷贝），等它跑完
            reset()
            ctrl_z(cdp)
            time.sleep(0.55)
            got = read_marks(f'B{i + 1} 编辑省份撤销', 1)
            st = eval_json(cdp, STATE_JS, required=('ok',), desc='撤销后颜色')[1]
            ck(f'B{i + 1} 撤销把颜色退回去了',
               (st.get('color') or None) == (edit.get('before') or None),
               f"撤销后 color={st.get('color')!r}（原 {edit.get('before')!r}）")
            if got:
                got[0]['case'] = 'B'
                b_marks.extend(got)

        # ── C：加标记 → Ctrl+Z ──────────────────────────────────────────────
        print('\n── C 添加标记撤销 ──', flush=True)
        c_marks = []
        for i in range(args.markers):
            add = eval_json(cdp, ADD_MARKER_JS, required=('ok',), desc='加标记')[1]
            if not add.get('ok'):
                ck(f'C{i + 1} 能加标记', False, json.dumps(add, ensure_ascii=False)[:200])
                break
            ck(f'C{i + 1} 标记数 +1（{add.get("before")} → {add.get("after")}）',
               int(add.get('after') or 0) == int(add.get('before') or 0) + 1,
               f"label={add.get('label')!r}")
            time.sleep(1.8)      # addScenarioMarker 同步 saveScenarios，等它跑完
            reset()
            ctrl_z(cdp)
            time.sleep(0.55)
            got = read_marks(f'C{i + 1} 标记撤销', 1)
            st = eval_json(cdp, STATE_JS, required=('ok',), desc='撤销后标记数')[1]
            ck(f'C{i + 1} 撤销把标记删掉了', int(st.get('markers') or 0) == int(add.get('before') or 0),
               f"撤销后 markers={st.get('markers')}")
            if got:
                got[0]['case'] = 'C'
                c_marks.extend(got)

        # ── D：连续撤销（会不会越撤越慢 / 有没有堆积）───────────────────────
        print('\n── D 连续撤销 ──', flush=True)
        d_marks = []
        painted = 0
        for i in range(args.chain):
            setup = eval_json(cdp, SETUP_STROKE_JS, required=('ok',), desc='铺第 %d 笔' % (i + 1))[1]
            if not (setup.get('ok') and setup.get('verifySame')):
                break
            eval_json(cdp, PAINT_JS, required=('ok',), desc='涂第 %d 笔' % (i + 1))
            painted += 1
            time.sleep(0.45)
        time.sleep(1.4)
        reset()
        perf0 = None
        if not args.no_profile:
            perf0 = profile_start(cdp)
        for i in range(painted):
            ctrl_z(cdp)
            time.sleep(0.3)
        time.sleep(0.4)
        got = read_marks(f'D 连续撤销 {painted} 步', painted)
        if not args.no_profile and got and perf0 is not None:
            profiles['D'] = profile_stop(cdp, os.path.join(out_dir, 'profile-D.json'),
                                         offset_ms=(got[0].get('t0') or 0) - perf0,
                                         span_ms=300 * len(got) + 400)
        for g in got:
            g['case'] = 'D'
        d_marks.extend(got)

        # 保存链分段读数（活了就打印：连按撤销到底卡在哪一段，一眼可读）
        save_log = eval_json(cdp, SAVE_LOG_JS, required=('ok',), desc='保存链分段读数')[1]

        # ── 汇总与判据 ─────────────────────────────────────────────────────
        all_marks = a_marks + b_marks + c_marks + d_marks
        def pre_save_long(m):
            """撤销**本身**窗口（<250ms）里的最长长任务 —— 300ms 后的是自动保存，单列。"""
            xs = [lt.get('dur') or 0 for lt in (m.get('longtasks') or []) if (lt.get('at') or 0) < 250]
            return max(xs) if xs else 0

        def post_save_long(m):
            xs = [lt.get('dur') or 0 for lt in (m.get('longtasks') or []) if (lt.get('at') or 0) >= 250]
            return max(xs) if xs else 0

        print('\n=== 读数（毫秒）===', flush=True)
        print(f"  {'case':<5}{'label':<12}{'sync':>8}{'到下一帧':>11}{'撤销内长任务':>13}"
              f"{'保存长任务':>12}{'掉帧':>7}{'帧数':>7}", flush=True)
        for m in all_marks:
            print(f"  {m.get('case', '?'):<5}{(m.get('label') or '')[:10]:<12}"
                  f"{m.get('sync'):>8}{str(m.get('toNextFrame')):>11}"
                  f"{pre_save_long(m):>13}{post_save_long(m):>12}"
                  f"{str(sum(1 for g in (m.get('gaps') or []) if g > 33.4)):>7}"
                  f"{str(m.get('frameCount')):>7}", flush=True)

        if save_log and save_log.get('log'):
            print('\n=== 保存链分段（projectStore.saveProject；最近 %d 次）===' % len(save_log['log']),
                  flush=True)
            print(f"  {'label':<10}{'export':>9}{'snapshot':>10}{'push':>8}{'seq':>8}{'ipc':>8}"
                  f"{'总计':>9}{'字节':>10}", flush=True)
            for r in save_log['log']:
                st = r.get('stages') or {}
                print(f"  {(r.get('label') or '')[:8]:<10}{str(st.get('exportCanvas')):>9}"
                      f"{str(st.get('snapshotState')):>10}{str(st.get('pushSnapshot')):>8}"
                      f"{str(st.get('serialize')):>8}{str(st.get('ipc')):>8}"
                      f"{str(r.get('total')):>9}{str(r.get('bytes')):>10}", flush=True)

        if profiles:
            print('\n=== CPU 采样（self time 前 8）===', flush=True)
            for tag, p in profiles.items():
                w = p.get('window')
                win = f'按键后 {w[1]:.0f}ms 窗口' if w else '整段'
                print(f"  · {tag}：{win}里采到 {p.get('totalMs')}ms 忙时", flush=True)
                for r in (p.get('top') or [])[:8]:
                    print(f"      {r.get('ms')}ms  {r.get('fn')}  ({r.get('file')}:{r.get('line')})", flush=True)

        def valid(m):
            g = m.get('gaps') or []
            return len(g) >= 8 and (median(g) or 999) <= 25.0

        # 单次撤销（A/B/C）才要求"窗口里在出帧" —— 连续撤销（D）如果一帧都没有，
        # 那本身就是**结论**（主线程被占满），不能当成"测量无效"吞掉。
        bad_valid = [m for m in (a_marks + b_marks + c_marks) if not valid(m)]
        ck('前置：单次撤销窗口 rAF 在出帧（≥8 帧、中位帧间隔 ≤25ms）',
           not bad_valid,
           f"{len(bad_valid)} 个窗口不合格："
           + json.dumps([{ 'label': m.get('label'), 'frameCount': m.get('frameCount'),
                           'medianGap': median(m.get('gaps') or [])} for m in bad_valid],
                        ensure_ascii=False)[:300])
        if d_marks:
            blind = [m for m in d_marks if not m.get('frameCount')]
            if blind:
                print(f"  · 连续撤销：{len(blind)}/{len(d_marks)} 步的 3 秒窗口里**一帧都没有**"
                      f"（主线程被占满，不是测量失败）", flush=True)

        if args.report_only:
            print('  · --report-only：只出读数，不判阈值', flush=True)
        else:
            for case, marks, cn in (('A 涂归属', a_marks, '指派'),
                                    ('B 编辑省份', b_marks, '编辑省份'),
                                    ('C 标记', c_marks, '添加标记')):
                if not marks:
                    ck(f'{case}：有读数', False, '一条都没有')
                    continue
                worst_sync = max(m.get('sync') or 0 for m in marks)
                worst_frame = max((m.get('toNextFrame') if m.get('toNextFrame') is not None else 0)
                                  for m in marks)
                worst_pre = max(pre_save_long(m) for m in marks)
                worst_save = max(post_save_long(m) for m in marks)
                labels = sorted({m.get('label') or '' for m in marks})
                ck(f'{case}：撤销的是期望的那条命令（{labels}）',
                   all(cn in (lab or '') for lab in labels), labels)
                ck(f'{case}：同步段 ≤ {args.budget_sync:g}ms（最差 {worst_sync}ms）',
                   worst_sync <= args.budget_sync, f'{worst_sync}ms')
                ck(f'{case}：按键到下一帧 ≤ {args.budget_frame:g}ms（最差 {worst_frame}ms）',
                   worst_frame <= args.budget_frame, f'{worst_frame}ms')
                ck(f'{case}：撤销本身无 >{args.budget_longtask:g}ms 长任务（最差 {worst_pre}ms）',
                   worst_pre <= args.budget_longtask, f'{worst_pre}ms')
                ck(f'{case}：撤销 300ms 后的自动保存 ≤{args.budget_save:g}ms（最差 {worst_save}ms）',
                   worst_save <= args.budget_save, f'{worst_save}ms')
            if d_marks:
                # 连续撤销（D 段）以前**不设闸门**：那时瓶颈是"每撤销一次都重排一次保存"，
                # 8MB 项目一次落盘几百 ms，连按就叠成 1~3 秒主线程占满（一帧都不出）。
                # 2026-11-05 保存链改成**分块 + 串行**之后，这里补上闸门（卡里写的验收口径）：
                #   ① 每一步都得真的出帧（以前最坏是 3 秒窗口零帧）；
                #   ② 连续撤销里单段长任务 ≤ --budget-chain（默认 200ms）。
                frames = [(m.get('toNextFrame') if m.get('toNextFrame') is not None else None)
                          for m in d_marks]
                blind = [m for m in d_marks if not m.get('frameCount')]
                worst_chain = max((m.get('longMax') or 0) for m in d_marks)
                print(f'  · D 连续撤销：每步到下一帧 {frames}；'
                      f'长任务 {[m.get("longMax") for m in d_marks]}', flush=True)
                ck('D 连续撤销：每一步都真的撤销了（按到的条数 = 撤销条数）',
                   len(d_marks) == painted and all(m.get('sync') is not None for m in d_marks),
                   f'{len(d_marks)}/{painted} 步')
                ck('D 连续撤销：每一步都出帧（不再出现"整段窗口零帧"）',
                   not blind,
                   f'{len(blind)}/{len(d_marks)} 步零帧：'
                   + json.dumps([{ 'label': m.get('label'), 'frameCount': m.get('frameCount') }
                                 for m in blind], ensure_ascii=False)[:200])
                ck(f'D 连续撤销：没有 >{args.budget_chain:g}ms 的长任务（最差 {worst_chain}ms）',
                   worst_chain <= args.budget_chain, f'{worst_chain}ms')

        # 只读纪律：真实项目一个字节都没动
        sha_after = sha256(real)
        ck('真实项目只读（跑前/跑后 sha256 一致）', sha_after == real_sha_before, f'{sha_after[:16]}…')

        summary = {
            'budgets': {'sync': args.budget_sync, 'frame': args.budget_frame,
                        'longtask': args.budget_longtask, 'save': args.budget_save,
                        'chain': args.budget_chain},
            'median': {
                'sync': median([m.get('sync') or 0 for m in all_marks]),
                'toNextFrame': median([m.get('toNextFrame') for m in all_marks
                                       if m.get('toNextFrame') is not None]),
                'preSaveLong': median([pre_save_long(m) for m in all_marks]),
                'postSaveLong': median([post_save_long(m) for m in all_marks]),
            },
            'saveRuns': (save_log or {}).get('runs'),
            'saveLog': (save_log or {}).get('log') or [],
            'byCase': {c: [m for m in all_marks if m.get('case') == c] for c in ('A', 'B', 'C', 'D')},
            'profiles': {k: {'totalMs': v.get('totalMs'), 'top': v.get('top'),
                             'window': v.get('window')}
                         for k, v in profiles.items()},
        }
        result = {
            'ts': ts, 'realProject': real, 'realSha256': real_sha_before, 'workCopy': work,
            'info': info, 'diag': diag, 'marks': all_marks, 'summary': summary,
            'verdict': {'bad': len(fails), 'fails': fails},
        }
        with open(os.path.join(out_dir, 'result.json'), 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=1)

        md = [f'# 撤销/重做端到端时延 · {ts}', '',
              f"- 真实项目（只读）：`{real}`",
              f'- 工作副本：`{work}`',
              f"- 规模：{info.get('scenarios')} 段剧本 / 本剧本 {info.get('provinces')} 省 / "
              f"{info.get('polities')} 势力 / 账本 {info.get('ledgerEvents')} 条",
              f"- 国界几何：{diag.get('provinces')} 省 / {diag.get('vertices')} 顶点 / "
              f"{diag.get('edges')} 条共边（国界 {diag.get('borderEdges')} 条）→ "
              f"重建索引 **{diag.get('buildIndexMs')} ms** / 算归属 {diag.get('ownersMs')} ms / "
              f"只分拣 **{diag.get('classifyMs')} ms**", '',
              '| 用例 | 命令 | 同步段 | 到下一帧 | 撤销本身长任务 | 300ms 后自动保存 | 掉帧 |',
              '|---|---|---|---|---|---|---|']
        for m in all_marks:
            md.append(f"| {m.get('case')} | {m.get('label')} | {m.get('sync')} ms | "
                      f"{m.get('toNextFrame')} ms | {pre_save_long(m)} ms | "
                      f"{post_save_long(m)} ms | "
                      f"{sum(1 for g in (m.get('gaps') or []) if g > 33.4)} |")
        md += ['', f"- 中位：同步段 {summary['median']['sync']} ms / 到下一帧 "
               f"{summary['median']['toNextFrame']} ms / 撤销本身长任务 "
               f"{summary['median']['preSaveLong']} ms / 300ms 后保存 "
               f"{summary['median']['postSaveLong']} ms",
               f"- 阈值：同步 ≤{args.budget_sync:g}ms / 到下一帧 ≤{args.budget_frame:g}ms / "
               f"撤销本身长任务 ≤{args.budget_longtask:g}ms / 撤销后保存 ≤{args.budget_save:g}ms / "
               f"连续撤销单段 ≤{args.budget_chain:g}ms 且每一步都出帧",
               f'- 真实项目 sha256 跑前后一致：{sha_after == real_sha_before}']
        for tag, p in (summary.get('profiles') or {}).items():
            md.append('')
            w = p.get('window')
            win = f'按键后 {w[1]:.0f}ms 窗口' if w else '整段'
            md.append(f"**CPU 采样 {tag}**（{win}，忙 {p.get('totalMs')}ms，self time 前 6）")
            md.append('')
            md.append('| ms | 函数 | 位置 |')
            md.append('|---|---|---|')
            for r in (p.get('top') or [])[:6]:
                md.append(f"| {r.get('ms')} | `{r.get('fn')}` | {r.get('file')}:{r.get('line')} |")
        if summary.get('saveLog'):
            md.append('')
            md.append(f"**保存链分段**（`projectStore.saveProject`，最近 {len(summary['saveLog'])} 次；单位 ms）")
            md.append('')
            md.append('| 标签 | exportCanvas | snapshotState | pushSnapshot | 序列化(分块) | IPC | 总计 | 字节 | 结果 |')
            md.append('|---|---|---|---|---|---|---|---|---|')
            for r in summary['saveLog']:
                st = r.get('stages') or {}
                md.append(f"| {r.get('label') or ''} | {st.get('exportCanvas')} | "
                          f"{st.get('snapshotState')} | {st.get('pushSnapshot')} | "
                          f"{st.get('serialize')} | {st.get('ipc')} | {r.get('total')} | "
                          f"{r.get('bytes')} | {'成功' if r.get('ok') else '失败：' + str(r.get('error'))} |")
        md += ['', f'结论：**{len(fails)} 项没过**' + ('（--report-only，未判阈值）' if args.report_only else '')]
        with open(os.path.join(out_dir, 'summary.md'), 'w', encoding='utf-8') as f:
            f.write('\n'.join(md) + '\n')
        print('\n' + '\n'.join(md), flush=True)
        print(('  ✅ 撤销时延判据通过' if not fails else f'  🔴 {len(fails)} 项没过'), flush=True)
        return 0 if not fails else 1
    finally:
        if el is not None:
            subprocess.run(['taskkill', '/PID', str(el.pid), '/T', '/F'], capture_output=True)
        if dev is not None:
            subprocess.run(['taskkill', '/PID', str(dev.pid), '/T', '/F'], capture_output=True)
        shutil.rmtree(profile, ignore_errors=True)
        # 备份/会话基线是副本自己的副产物，不留在产物目录里占地方
        for junk in (work + '.backups',):
            shutil.rmtree(junk, ignore_errors=True)
        for junk in (work + '.session-baseline.sitian',):
            try:
                os.remove(junk)
            except Exception:
                pass
        print('  · 隔离 profile 已清理', flush=True)


if __name__ == '__main__':
    code = main()
    if code:
        print('\n🔴 %d 项失败' % len(fails))
        for f in fails:
            print('  - ' + f)
    sys.exit(code)
