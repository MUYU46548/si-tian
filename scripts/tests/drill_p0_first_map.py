#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""P0「第一张图」真实数据端到端演练（真实 415 省项目 → 画势力范围 → 选时间点 → 导出 PNG）

与 `drill_quit_flush.py` 的分工：
  · `drill_quit_flush.py` = **真 Electron + dist 产物 + 真实项目文件**，判据只有磁盘（数据安全）；
  · 本演练 = **Vite dev + Edge headless + 真实项目数据的副本**，判据是「产品自己的链路 + 像素」。
    为什么不走真 Electron：本演练要读 `__vue_app__._instance.setupState`（Vue 的 `_instance`
    是 **dev-only**；生产构建里是 `null`），而真机演练刻意不碰 store。两条演练互补，不重复。

流程（每一步的结论都带实测数字）：
  1. 前置断言：5180/9222 空闲、无 `index.html.bak`（有 = 上一轮被中断的半成品，**不许启动**）；
     记录真实项目文件的 sha256 / size / mtime（跑完必须一字节未变）。
  2. 复用 `run_tests` 的 `setup_mock`（**只改仓库内 `index.html` 与 `mock-data/`**），
     额外把真实项目 JSON 的**副本**写进 `mock-data/real_project.json`（真实文件只读，绝不写）。
  3. 注入 `window.__projects['mock/projects/real-desite.sitian']` 并 `projectStore.openProject()`
     —— 走**产品自己的**「打开项目 → applyProjectToCanvas → applyScenarioState」链路。
  4. 主动作 1「画一个势力范围」：油漆桶点某个真实省份内部 → 断言 ①页面内 ownership 变了
     ②**读盘载荷**（`__probe.lastProject()`）也变了 ③状态栏点名。
     🔴 点的取法（三条纪律，缺一条就会"点在省外/别的省上"而查不出原因）：
       · 先在世界坐标里找**离边界最远**的内部点（顶点平均/面积形心对凹省可能落在省外）；
       · 再换算成屏幕坐标并**取整** —— `MouseEvent.clientX` 的 IDL 类型是 `long`，
         浏览器会把小数**截断**，所以产品真正收到的是整数像素（≈1.5 世界单位/px）；
       · 用取整后的屏幕坐标**反算**产品将会算出的世界坐标，重新做一次"在目标省内"判定，
         并先用「选择」工具让**产品自己的** `findProvinceAt` 回答命中的是哪个省（不假设）。
  5. 主动作 2「选一个时间点」：同一年代内换年份 → 如实报告导出物有没有变化
     （这份数据的 12 个剧本 `changeEvents` 都是 0，逐年变化可能看不出来 —— 不编造差异）。
  6. 主动作 3「导出一张 PNG」：真鼠标点导出按钮 → 分块取回 dataUrl → 存盘 + Pillow 像素判据；
     另留应用界面截图。
  7. 收尾：`teardown_mock()` 还原 index.html / 删 mock-data / 停掉自己起的进程 / 校验真实文件未变。

用法（**不要传 `--` 开头的参数**：`run_tests` 顶层会把它们当成用例名解析）：
    python scripts/tests/drill_p0_first_map.py
"""
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

import run_tests as rt                                                    # noqa: E402
from lib.cdp import CDP, wait_for, eval_json, fetch_string                # noqa: E402
from lib.helpers import open_harness_project, ensure_data_ready, open_toolbar_more  # noqa: E402
import lib.pngcheck as png                                                # noqa: E402

REAL_PROJECT = r'C:\Users\muyu\Documents\SiTianProjects\绒花计划.sitian'
REAL_PROJECT_IN_MOCK = os.path.join(ROOT, 'src', 'renderer', 'mock-data', 'real_project.json')
MOCK_PROJECT_PATH = 'mock/projects/real-desite.sitian'
OUT_DIR = os.path.join(ROOT, 'build', 'p0-first-map')
KEY = 'desite'
SC = 'desite/诸侯割据'
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"

R = []


def ck(name, ok, detail=''):
    R.append((name, bool(ok), detail))
    print('  %s %s%s' % ('✅' if ok else '❌', name, ('  — ' + str(detail)) if detail != '' else ''), flush=True)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def file_stat(path):
    st = os.stat(path)
    return {'size': st.st_size, 'mtime': st.st_mtime, 'sha256': sha256(path)}


# ══════════════════════════════════════════════════════════════════════════
# 几何（世界坐标）：找一个**离边界最远**的省内点
#   凹多边形的顶点平均会落到省外；面积形心也可能落到省外（L 形省）。
#   所以：包围盒内铺格 → 逐点判「在本省内」且「不在任何别的省内」→ 取离边界最远者。
#   ⚠️ "不在别的省内"必须带包围盒预筛：415 省 × 3136 格点 × 逐环 even-odd ≈ 7.5e7 次内层
#      迭代（分钟级）；预筛后只剩个位数候选省。
# ══════════════════════════════════════════════════════════════════════════
def _rings(prov):
    """省份的所有环（多环/带洞/飞地 —— 与产品 `provinceRings` 同口径，缺字段就只取主环）。"""
    out = []
    main = prov.get('points') or []
    if len(main) >= 3:
        out.append(main)
    for k in ('holes', 'enclaves'):
        for extra in (prov.get(k) or []):
            if isinstance(extra, list) and len(extra) >= 3:
                out.append(extra)
    return out


def _xy(p):
    return (p.get('x'), p.get('y')) if isinstance(p, dict) else (p[0], p[1])


def _inside(x, y, rings):
    """even-odd：环内为真（洞与飞地同口径 —— 与产品 `pointInProvince` 一致）。"""
    inside = False
    for ring in rings:
        n = len(ring)
        for i in range(n):
            x1, y1 = _xy(ring[i])
            x2, y2 = _xy(ring[(i + 1) % n])
            if (y1 > y) != (y2 > y):
                if x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                    inside = not inside
    return inside


def _bbox(pts):
    xs = [_xy(p)[0] for p in pts]
    ys = [_xy(p)[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def _bbox_has(bb, x, y):
    return bb[0] <= x <= bb[2] and bb[1] <= y <= bb[3]


def clearance(x, y, rings):
    """点到最近环边的距离（世界单位）。"""
    best = float('inf')
    for ring in rings:
        n = len(ring)
        for i in range(n):
            x1, y1 = _xy(ring[i])
            x2, y2 = _xy(ring[(i + 1) % n])
            dx, dy = x2 - x1, y2 - y1
            L2 = dx * dx + dy * dy
            t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / L2))
            px, py = x1 + t * dx, y1 + t * dy
            d2 = (x - px) ** 2 + (y - py) ** 2
            if d2 < best:
                best = d2
    return best ** 0.5


def pick_interior_point(terrain, want=6.0, grid=56):
    """返回 (prov, x, y, clearance, 诊断串)。挑包围盒最大的几个省试，取第一个够"深"的点。"""
    others = []
    for p in terrain:
        rgs = _rings(p)
        if rgs:
            others.append((p, rgs, _bbox(rgs[0])))
    cand = [( (b[2] - b[0]) * (b[3] - b[1]), p, rgs, b) for p, rgs, b in others]
    cand.sort(key=lambda t: -t[0])
    for area, prov, rgs, bb in cand[:8]:
        best = None
        for i in range(grid):
            for j in range(grid):
                x = bb[0] + (bb[2] - bb[0]) * (i + 0.5) / grid
                y = bb[1] + (bb[3] - bb[1]) * (j + 0.5) / grid
                if not _inside(x, y, rgs):
                    continue
                if any(op is not prov and _bbox_has(obb, x, y) and _inside(x, y, org)
                       for op, org, obb in others):
                    continue
                d = clearance(x, y, rgs)
                if best is None or d > best[2]:
                    best = (x, y, d)
        if best and best[2] >= want:
            return prov, best[0], best[1], best[2], ('共 %d 个省，按包围盒降序取前 8 个试，取第一个够深的；'
                                                     '格 %d×%d；要求离边界 ≥ %.1f 世界单位'
                                                     % (len(cand), grid, grid, want))
    return None, None, None, 0.0, '找不到足够"深"的省内点（8 个最大省都试过了）'


# ══════════════════════════════════════════════════════════════════════════
# 页面侧探针
# ══════════════════════════════════════════════════════════════════════════
INJECT_JS = r"""(async () => {
  const app = document.querySelector('#app').__vue_app__;
  const pinia = app.config.globalProperties.$pinia;
  const store = app._instance.setupState.store;
  const { useProjectStore } = await import('/src/store/projectStore.js');
  const proj = useProjectStore(pinia);
  let real = null;
  try { real = await (await fetch('/mock-data/real_project.json')).json(); }
  catch (e) { return JSON.stringify({ ok: false, stage: 'fetch', error: String((e && e.message) || e) }); }
  window.__projects = window.__projects || {};
  window.__projects['__PATH__'] = real;
  const t0 = Date.now();
  const r = await proj.openProject('__PATH__');
  await new Promise(x => setTimeout(x, 900));
  const bm = (store.baseMaps || {})['__KEY__'] || {};
  const scKeys = Object.keys(store.scenarios || {});
  const ownCounts = {};
  for (const k of scKeys) ownCounts[k] = Object.keys(store.scenarios[k].ownership || {}).length;
  return JSON.stringify({
    ok: !!(r && r.success === true), error: (r && r.error) || '',
    ms: Date.now() - t0, filePath: proj.filePath, source: store.canvasSource,
    terrain: bm.terrain ? bm.terrain.length : -1,
    baseMapKeys: Object.keys(store.baseMaps || {}),
    scenarioCount: scKeys.length, scKeys, ownCounts, nodes: store.nodes.length,
  });
})()"""

# 场景布置：选底图 → 落年代/年份 → 选中剧本 → 适配视口 → 交回相机参数
SETUP_JS = r"""(async () => {
  const fails = [], notes = {};
  const tick = ms => new Promise(r => setTimeout(r, ms || 200));
  const s = __STORE__, SM = __SM__;
  const SC = __SC__;
  SM.baseMapKey = __KEY__;
  if (typeof SM.onBaseMapChange === 'function') await SM.onBaseMapChange();
  await tick(1000);
  const ids = SM.timeline.scenarios.map(x => x.id);
  const k = ids.indexOf(SC);
  notes.eraIds = ids; notes.k = k;
  if (k < 0) return JSON.stringify({ fails: ['时间轴里找不到剧本 ' + SC], notes });
  notes.eraRange = SM.timeline.years[k];
  SM.viewMode = 'scenario';
  SM.tlEra = k;
  SM.tlDate = { y: __YEAR__, m: null, d: null };
  SM.selectedScenario = s.scenarios[SC];
  await tick(400);
  notes.tlEra = SM.tlEra;
  notes.tlYear = Math.round(SM.tlYear);
  notes.scenarioId = SM.selectedScenario ? SM.selectedScenario.id : null;
  notes.timelineIdAtEra = ids[SM.tlEra];
  notes.eraChgChanged = SM.timeline.eraChg[k] ? SM.timeline.eraChg[k].changed.length : null;
  notes.changeEventsInScenario = Object.keys(s.scenarios[SC].changeEvents || {}).length;
  notes.terrainCount = (s.baseMaps[__KEY__].terrain || []).length;
  if (typeof SM.fitToView === 'function') SM.fitToView();
  await tick(700);
  const cv = document.querySelector('.scenario-map-container canvas');
  if (!cv) return JSON.stringify({ fails: ['找不到剧本画布 canvas'], notes });
  const rect = cv.getBoundingClientRect();
  notes.camera = { scale: SM.cameraScale, x: SM.cameraX, y: SM.cameraY };
  notes.canvasRect = { left: rect.left, top: rect.top, w: rect.width, h: rect.height };
  notes.nodes = s.nodes.length;
  return JSON.stringify({ fails, notes });
})()"""

# 用「选择」工具让**产品自己**回答这个屏幕点命中的是哪个省（走它自己的 findProvinceAt）
#   🔴 为什么要带"再试一次"：`select` 分支**先判城镇**（`findBurgAt` → 命中就开城镇编辑器，
#      根本不选省）。真实底图有 **617 个 burg**，点落在一个城镇上时 `selectedProvince` 会是 null
#      —— 那不是"点歪了"，而是产品的既定优先级。所以：第一发如实记录（含是否被城镇截胡），
#      若被截胡则关掉城镇图层重试一发，两发的结论都带回报告。
SELECT_JS = r"""(async () => {
  const fails = [], notes = {};
  const tick = ms => new Promise(r => setTimeout(r, ms || 200));
  const SM = __SM__;
  const cv = document.querySelector('.scenario-map-container canvas');
  if (!cv) return JSON.stringify({ fails: ['无 canvas'], notes });
  const rect = cv.getBoundingClientRect();
  const sx = __SX__, sy = __SY__;
  notes.canvasRect = { left: rect.left, top: rect.top, w: rect.width, h: rect.height };
  notes.onCanvas = sx >= 0 && sx <= rect.width && sy >= 0 && sy <= rect.height;
  const topEl = document.elementFromPoint(rect.left + sx, rect.top + sy);
  notes.topElement = topEl ? (topEl.tagName + '.' + String(topEl.className || '').slice(0, 48)) : null;
  notes.topIsCanvas = !!topEl && topEl === cv;
  const doClick = async () => {
    SM.setTool('select');
    SM.selectedProvince = null;
    await tick(300);
    const mk = t => new MouseEvent(t, { clientX: rect.left + sx, clientY: rect.top + sy,
                                       bubbles: true, cancelable: true, button: 0 });
    cv.dispatchEvent(mk('mousedown')); cv.dispatchEvent(mk('mouseup')); cv.dispatchEvent(mk('click'));
    await tick(450);
    return { prov: SM.selectedProvince ? SM.selectedProvince.id : null,
             provName: SM.selectedProvince ? SM.selectedProvince.name : null,
             burg: SM.selectedBurg ? (SM.selectedBurg.name || SM.selectedBurg.id) : null,
             showBurgs: SM.showBurgs };
  };
  const a1 = await doClick();
  notes.attempt1 = a1;
  notes.hitProvince = a1.prov;
  notes.hitProvinceName = a1.provName;
  notes.interceptedByBurg = (!a1.prov && a1.burg) ? a1.burg : null;
  if (!a1.prov) {
    SM.showBurgs = false;                     // 关掉城镇图层再试一发（产品自己的选择优先级的反面）
    await tick(300);
    const a2 = await doClick();
    notes.attempt2 = a2;
    if (a2.prov) { notes.hitProvince = a2.prov; notes.hitProvinceName = a2.provName; }
  }
  // 关掉被城镇截胡时弹出来的「聚落编辑」面板 —— 它是个模态，留着会盖住后续截图
  // （留着不算错，但会让证据图看起来像"点歪了"；本仓纪律：证据要能自证）
  if (typeof SM.closeBurgEditor === 'function') SM.closeBurgEditor();
  else SM.burgEditorOpen = false;
  await tick(250);
  notes.burgEditorOpenAfter = !!SM.burgEditorOpen;
  // 产品侧真值：它把这个屏幕点算成了哪个世界坐标
  notes.worldByProduct = { x: (sx - SM.cameraX) / SM.cameraScale, y: (sy - SM.cameraY) / SM.cameraScale };
  return JSON.stringify({ fails, notes });
})()"""

PAINT_JS = r"""(async () => {
  const fails = [], notes = {};
  const tick = ms => new Promise(r => setTimeout(r, ms || 200));
  const s = __STORE__, SM = __SM__;
  const SC = __SC__, TARGET = __TARGET__;
  const cv = document.querySelector('.scenario-map-container canvas');
  if (!cv) return JSON.stringify({ fails: ['无 canvas'], notes });
  const rect = cv.getBoundingClientRect();
  const sx = __SX__, sy = __SY__;
  const sc0 = s.scenarios[SC];
  const before = Object.assign({}, sc0.ownership || {});
  notes.ownerBefore = before[TARGET] || null;
  const oldP = (sc0.polities || []).find(p => p.id === notes.ownerBefore) || null;
  notes.ownerBeforeName = oldP ? oldP.name : null;
  const newP = (sc0.polities || []).find(p => p.id !== notes.ownerBefore) || (sc0.polities || [])[0];
  if (!newP) return JSON.stringify({ fails: ['该剧本没有别的势力可指派'], notes });
  notes.newPolity = { id: newP.id, name: newP.name, color: newP.color };
  SM.selectedPolity = newP;
  SM.setTool('paint');
  SM.provinceHint = '';
  await tick(350);
  const mk = t => new MouseEvent(t, { clientX: rect.left + sx, clientY: rect.top + sy,
                                      bubbles: true, cancelable: true, button: 0 });
  cv.dispatchEvent(mk('mousedown')); cv.dispatchEvent(mk('mouseup')); cv.dispatchEvent(mk('click'));
  await tick(800);
  const sc1 = s.scenarios[SC];
  const after = sc1.ownership || {};
  notes.ownerAfter = after[TARGET] || null;
  notes.ownerAfterName = ((sc1.polities || []).find(p => p.id === notes.ownerAfter) || {}).name || null;
  notes.hint = SM.provinceHint;
  notes.changeEvent = (sc1.changeEvents || {})[TARGET] || null;
  const keys = new Set(Object.keys(before).concat(Object.keys(after)));
  const changed = [];
  for (const kk of keys) if ((before[kk] || null) !== (after[kk] || null)) changed.push([kk, before[kk] || null, after[kk] || null]);
  notes.changed = changed;              // 万一命中的是另一个省 —— 如实带回，不掩饰
  notes.ownedTotal = Object.keys(after).length;
  notes.tlYear = Math.round(SM.tlYear);
  notes.tlEra = SM.tlEra;
  return JSON.stringify({ fails, notes });
})()"""

# 同一年代内换年份：导出物变没变（用产品自己的 buildScenarioSVG 逐字比较）
TIME_JS = r"""(async () => {
  const notes = {};
  const tick = ms => new Promise(r => setTimeout(r, ms || 250));
  const s = __STORE__, SM = __SM__;
  const SC = __SC__;
  const ids = SM.timeline.scenarios.map(x => x.id);
  const k = ids.indexOf(SC);
  notes.eraRange = SM.timeline.years[k];
  notes.eraChgChanged = SM.timeline.eraChg[k] ? SM.timeline.eraChg[k].changed.length : null;
  notes.changeEventsInScenario = Object.keys(s.scenarios[SC].changeEvents || {}).length;
  const build = (SM.scenarioExport && SM.scenarioExport.buildScenarioSVG) || SM.buildScenarioSVG || null;
  notes.hasBuilder = !!build;
  const seen = {};
  for (const y of __YEARS__) {
    SM.tlEra = k; SM.tlDate = { y: y, m: null, d: null };
    await tick(300);
    let svg = '';
    try { svg = build ? String(build().svg || '') : ''; } catch (e) { svg = 'ERR:' + e.message; }
    let h = 5381;                                   // djb2：只判"变没变"，不是安全用途
    for (let i = 0; i < svg.length; i++) h = ((h * 33) ^ svg.charCodeAt(i)) >>> 0;
    seen[y] = { tlYear: Math.round(SM.tlYear), tlEra: SM.tlEra, svgBytes: svg.length, hash: h.toString(16) };
  }
  notes.byYear = seen;
  notes.distinctHashes = Array.from(new Set(Object.values(seen).map(v => v.hash))).length;
  return JSON.stringify({ fails: [], notes });
})()"""

EXPORT_JS = r"""(async () => {
  const fails = [], notes = {};
  const tick = ms => new Promise(r => setTimeout(r, ms || 150));
  const SM = __SM__;
  const btn = document.querySelector('[data-testid="export-png"]');
  if (!btn) {
    return JSON.stringify({ fails: ['导出按钮不在 DOM（工具栏「更多」没展开？）'],
      notes: { more: !!document.querySelector('.toolbar-more'),
               testids: Array.from(document.querySelectorAll('[data-testid]')).map(e => e.getAttribute('data-testid')) } });
  }
  window.__LAST_EXPORT__ = null;
  window.__EXPORT_CALLS__ = 0;
  window.sitianAPI.saveExportFile = async (o) => {
    window.__LAST_EXPORT__ = o; window.__EXPORT_CALLS__++;
    return { success: true, path: 'mock/p0-real.png' };
  };
  SM.exportStatus = '';
  SM.showLabels = __SHOW_LABELS__;
  await tick(350);
  const rc = btn.getBoundingClientRect();
  const cx = rc.left + rc.width / 2, cy = rc.top + rc.height / 2;
  const top = document.elementFromPoint(cx, cy);
  notes.hitTarget = !!top && (top === btn || btn.contains(top));
  notes.btnRect = { x: Math.round(rc.left), y: Math.round(rc.top), w: Math.round(rc.width), h: Math.round(rc.height) };
  const mk = t => new MouseEvent(t, { clientX: cx, clientY: cy, bubbles: true, cancelable: true, button: 0 });
  btn.dispatchEvent(mk('mousedown')); btn.dispatchEvent(mk('mouseup')); btn.dispatchEvent(mk('click'));
  let w = 0;
  while ((!window.__LAST_EXPORT__ || !/已导出 PNG/.test(String(SM.exportStatus || ''))) && w < 90000) {
    await tick(150); w += 150;
  }
  notes.waitedMs = w;
  notes.calls = window.__EXPORT_CALLS__;
  notes.status = SM.exportStatus;
  notes.tlYear = Math.round(SM.tlYear);
  notes.tlEra = SM.tlEra;
  notes.scenarioName = (SM.timeline.scenarios[SM.tlEra] || {}).name || null;
  const du = String((window.__LAST_EXPORT__ || {}).dataUrl || '');
  notes.defaultName = (window.__LAST_EXPORT__ || {}).defaultName;
  notes.dataUrlLen = du.length;
  notes.dataUrlPrefix = du.slice(0, 22);
  if (!du) fails.push('没有 dataUrl（导出没走到 saveExportFile）');
  return JSON.stringify({ fails, notes });
})()"""

SVGHEAD_JS = r"""(() => {
  const SM = __SM__;
  const b = (SM.scenarioExport && SM.scenarioExport.buildScenarioSVG) || SM.buildScenarioSVG;
  if (!b) return JSON.stringify({ err: 'no-builder' });
  const svg = String(b().svg || '');
  const m = svg.match(/width="(\d+)"\s+height="(\d+)"/);
  return JSON.stringify({
    w: m ? Number(m[1]) : -1, h: m ? Number(m[2]) : -1, bytes: svg.length,
    paths: (svg.match(/<path /g) || []).length,
    texts: (svg.match(/<text /g) || []).length,
    patterns: (svg.match(/<pattern /g) || []).length,
    hasTitle: svg.indexOf('诸侯割据') >= 0,
  });
})()"""

DISK_JS = r"""(() => {
  const p = window.__probe && window.__probe.lastProject();
  if (!p) return JSON.stringify({ has: false, saves: (window.__savedProject || []).length });
  const sc = ((p.scenarios || {}).scenarios || {})['__SC__'];
  const bm = ((p.scenarios || {}).baseMaps || {})['__KEY__'] || {};
  return JSON.stringify({
    has: true, saves: (window.__savedProject || []).length,
    owner: sc ? ((sc.ownership || {})['__TARGET__'] || null) : '__NO_SCENARIO__',
    terrain: bm.terrain ? bm.terrain.length : -1,
    scenarioCount: Object.keys((p.scenarios || {}).scenarios || {}).length,
    // 🔴 落盘载荷的 meta.name：真实项目叫「绒花计划」，harness 基线项目叫「harness 基线项目」。
    //    两者实体数都是 120、名字也高度重合（fixture 就是从这份真实项目派生的），
    //    所以**只有 meta.name 能证明打开的是真实项目而不是基线项目**。
    metaName: (p.meta || {}).name || null,
    filePath: window.__probe ? window.__probe.harnessProjectPath : null,
    savePaths: (window.__savedProject || []).map(x => x && x.filePath),
  });
})()"""


def _sub(tpl, **kw):
    """替换 `__STORE__ / __SM__ / __SC__` 与调用方给的占位符。

    🔴 占位符值**一律 `json.dumps`**（传原生 Python 值，别传 JS 源码片段）：
       首版写成"字符串就原样插入"，于是 `KEY='desite'` 注入成裸 `desite` →
       页面报 `ReferenceError: desite is not defined`（一个引号之差，排查要绕一圈）。
    """
    out = tpl.replace('__STORE__', STORE).replace('__SM__', SM).replace('__SC__', json.dumps(SC))
    for k, v in kw.items():
        out = out.replace('__%s__' % k.upper(), json.dumps(v))
    return out


def _screenshot(cdp, path):
    try:
        r = cdp.send('Page.captureScreenshot', {'format': 'png'})
        data = r.get('data')
        if not data:
            return False, 'captureScreenshot 无 data'
        with open(path, 'wb') as f:
            f.write(base64.b64decode(data))
        return True, '%s（%d B）' % (os.path.basename(path), os.path.getsize(path))
    except Exception as e:
        return False, f'截图失败：{e}'


# ══════════════════════════════════════════════════════════════════════════
def main():
    print('=== P0 第一张图：真实 415 省项目端到端演练 ===', flush=True)
    os.makedirs(OUT_DIR, exist_ok=True)

    # ── 1. 前置断言 ──────────────────────────────────────────────────────
    bak = rt.INDEX_HTML + '.bak'
    ck('前置：index.html.bak 不存在（有 = 上一轮被中断的半成品 → 不许启动）', not os.path.exists(bak), bak)
    if os.path.exists(bak):
        print('  ⛔ 存在 index.html.bak —— 按纪律不启动任何 Vite/Edge，直接退出（交给人工处理）', flush=True)
        return 2
    busy = []
    for port in (rt.DEV_PORT, rt.CDP_PORT):
        try:
            raw = subprocess.run(['netstat', '-ano'], capture_output=True, timeout=20).stdout.decode('utf-8', 'replace')
            busy += [l.strip() for l in raw.splitlines() if (':%d' % port) in l and 'LISTENING' in l]
        except Exception:
            pass
    ck('前置：5180/9222 空闲（有回归在跑就不许启动 —— free_port 会把它打死）', not busy, busy[:4])
    if busy:
        return 2
    if not os.path.exists(REAL_PROJECT):
        ck('前置：真实项目文件存在', False, REAL_PROJECT)
        return 2
    before_stat = file_stat(REAL_PROJECT)
    print('  · 真实项目基线：size=%d mtime=%.0f sha256=%s' % (before_stat['size'], before_stat['mtime'], before_stat['sha256']), flush=True)
    print('  · 本演练会改动（全在仓库内，跑完还原）：%s、%s；新增证据：%s'
          % (os.path.relpath(rt.INDEX_HTML, ROOT), os.path.relpath(rt.MOCK_DATA_DIR, ROOT),
             os.path.relpath(OUT_DIR, ROOT)), flush=True)

    handles, cdp = [], None
    try:
        # ── 2. mock + 真实数据副本 ──────────────────────────────────────
        print('\n1/7 注入 mock（setup_mock）+ 写真实项目副本…', flush=True)
        rt.setup_mock()
        shutil.copy(REAL_PROJECT, REAL_PROJECT_IN_MOCK)
        ck('真实项目副本已写入 mock-data（真实文件只读，未触碰）',
           os.path.getsize(REAL_PROJECT_IN_MOCK) == before_stat['size'],
           '%s（%d B）' % (os.path.relpath(REAL_PROJECT_IN_MOCK, ROOT), os.path.getsize(REAL_PROJECT_IN_MOCK)))

        print('2/7 启动 Vite dev + Edge headless…', flush=True)
        rt.free_port(rt.DEV_PORT)
        dev = subprocess.Popen(['cmd', '/c', 'npm', 'run', 'dev'], cwd=ROOT,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        handles.append(rt.ProcessHandle(dev, 'dev'))
        if not rt.wait_port(rt.DEV_PORT, timeout=120):
            raise RuntimeError('Vite dev server 启动超时')
        rt.free_port(rt.CDP_PORT)
        edge = subprocess.Popen([
            rt.EDGE_EXE, '--headless=new', '--disable-gpu', '--disable-dev-shm-usage',
            '--remote-debugging-port=%d' % rt.CDP_PORT, '--remote-allow-origins=*',
            '--user-data-dir=%s' % os.path.join(ROOT, '.test-edge-profile'),
            '--no-first-run', '--no-default-browser-check',
            '--disable-sync', '--disable-features=SyncConsentUI,SigninCheckoutFlow',
            '--no-sandbox', 'about:blank',
        ])
        handles.append(rt.ProcessHandle(edge, 'edge'))
        if not rt.wait_port(rt.CDP_PORT, timeout=60):
            raise RuntimeError('Edge CDP 启动超时')
        ck('Vite(5180) + Edge(9222) 已就绪', True)

        print('3/7 导航 + 视口 + harness 基线项目…', flush=True)
        cdp = CDP()
        cdp.send('Page.enable')
        cdp.navigate()
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=90, desc='首次导航')
        rt.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate()
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=90, desc='跳过首启后重载')
        wait_for(cdp, "!document.querySelector('.onboarding-overlay')", timeout=30, desc='引导层关闭')
        ensure_data_ready(cdp, timeout=90)
        hok, hinfo = open_harness_project(cdp)
        ck('harness 基线项目已打开（装好 __probe 读盘钩子）', hok, json.dumps(hinfo, ensure_ascii=False)[:220])

        # ── 3. 真实项目注入 ─────────────────────────────────────────────
        print('4/7 注入真实项目 → projectStore.openProject…', flush=True)
        iok, inj = eval_json(cdp, INJECT_JS.replace('__PATH__', MOCK_PROJECT_PATH).replace('__KEY__', KEY),
                             required=('ok', 'terrain', 'scenarioCount'), desc='注入真实项目')
        if not iok:
            ck('真实项目注入/打开', False, inj)
            return 1
        if inj.get('error') or not inj.get('ok'):
            ck('真实项目打开成功', False, json.dumps(inj, ensure_ascii=False)[:400])
            return 1
        ck('openProject 成功（走产品自己的 打开→applyProjectToCanvas→applyScenarioState 链路）',
           inj.get('source') == 'project',
           '耗时 %sms / 事实源 %s / 底图 %s / 画布节点 %s'
           % (inj.get('ms'), inj.get('source'), inj.get('baseMapKeys'), inj.get('nodes')))
        ck('desite 底图 terrain == 415 省', inj.get('terrain') == 415, '实测 %s' % inj.get('terrain'))
        ck('剧本数 == 12', inj.get('scenarioCount') == 12,
           '实测 %s：%s' % (inj.get('scenarioCount'), json.dumps(inj.get('scKeys'), ensure_ascii=False)))
        own = inj.get('ownCounts') or {}
        ck('剧本「%s」ownership 条数 == 415' % SC, own.get(SC) == 415, '实测 %s' % own.get(SC))
        ck('12 个剧本 ownership 全是 415 条', all(v == 415 for v in own.values()),
           json.dumps(own, ensure_ascii=False))
        print('  · 实测 ownership 条数/剧本：%s' % json.dumps(own, ensure_ascii=False), flush=True)

        with open(REAL_PROJECT_IN_MOCK, encoding='utf-8') as f:
            real = json.load(f)
        terrain = real['scenarios']['baseMaps'][KEY]['terrain']
        prov, wx, wy, clr, diag = pick_interior_point(terrain)
        if prov is None:
            ck('在真实省份内部找到可用点', False, diag)
            return 1
        print('  · 选定省份 %s（%s）：内部点 (%.2f, %.2f)，离边界 %.2f 世界单位 [%s]'
              % (prov['id'], prov.get('name'), wx, wy, clr, diag), flush=True)

        # ── 4. 进剧本模式 ───────────────────────────────────────────────
        print('5/7 进剧本模式 + 布置场景（选底图/年代/年份/适配视口）…', flush=True)
        r = cdp.eval("""(() => {
          const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('历史剧本'));
          if (!b) return 'no-btn'; b.click(); return 'ok';
        })()""")
        ck('进入剧本模式（点「历史剧本」）', r == 'ok', r)
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=30, desc='ScenarioMap 挂载')
        time.sleep(1.5)
        ck('工具栏「更多」已展开（导出按钮在 v-if="moreOpen" 里）', open_toolbar_more(cdp))

        era = real['scenarios']['scenarios'][SC]['era']
        y0, y1 = int(era['startYear']), int(era['endYear'])
        year = y0 + (y1 - y0) // 2
        print('  · 剧本「%s」年代 %s~%s（roman=%s）→ 取中点年份 %d'
              % (SC, era['startYear'], era['endYear'], era.get('roman'), year), flush=True)
        sok, sres = eval_json(cdp, _sub(SETUP_JS, KEY=KEY, YEAR=int(year)),
                              required=('fails', 'notes'), desc='场景布置')
        if not sok:
            ck('场景布置探针可求值', False, sres)
            return 1
        sn = sres['notes']
        ck('场景布置成功（游标落在目标剧本与年份）',
           not sres['fails'] and sn.get('timelineIdAtEra') == SC and sn.get('tlYear') == year,
           '；'.join(sres['fails']) or 'tlEra=%s tlYear=%s eraScenario=%s 相机=%s'
           % (sn.get('tlEra'), sn.get('tlYear'), sn.get('timelineIdAtEra'), json.dumps(sn.get('camera'))))
        if sres['fails']:
            return 1
        cam, cr = sn['camera'], sn['canvasRect']
        print('  · 相机 scale=%.5f x=%.2f y=%.2f；画布 rect=%s；terrain=%s'
              % (cam['scale'], cam['x'], cam['y'], json.dumps({k: round(v, 1) for k, v in cr.items()}),
                 sn.get('terrainCount')), flush=True)

        # 世界点 → 整数屏幕点 → **反算**产品将会算出的世界点 → 自己再判一次"在目标省内"
        sx_f, sy_f = wx * cam['scale'] + cam['x'], wy * cam['scale'] + cam['y']
        sx, sy = int(sx_f), int(sy_f)                       # clientX 的 IDL 是 long → 截断
        wx_eff = (sx - cam['x']) / cam['scale']
        wy_eff = (sy - cam['y']) / cam['scale']
        rgs = _rings(prov)
        clr_eff = clearance(wx_eff, wy_eff, rgs)
        still_in = _inside(wx_eff, wy_eff, rgs)
        others_hit = [p['id'] for p in terrain
                      if p is not prov and _inside(wx_eff, wy_eff, _rings(p))]
        print('  · 屏幕点取整 (%d, %d)；产品将算出的世界点 (%.2f, %.2f)：在目标省内=%s 离边界=%.2f 世界单位；'
              '同时落在别的省里=%s' % (sx, sy, wx_eff, wy_eff, still_in, clr_eff, others_hit or '无'), flush=True)
        # 证据图 1：布置好之后的剧本视图全景（在点任何东西之前拍 —— 干净、无模态遮挡）
        shot1 = os.path.join(OUT_DIR, 'ui-1-scenario-view.png')
        ok1, i1 = _screenshot(cdp, shot1)
        ck('应用界面截图 1（剧本视图全景，玩家点之前的状态）', ok1, i1)

        # ── 5. 主动作 1：画一个势力范围 ─────────────────────────────────
        print('6/7 主动作 1：油漆桶改一个真实省份的归属…', flush=True)
        qok, qres = eval_json(cdp, _sub(SELECT_JS, SX=int(sx), SY=int(sy)),
                              required=('fails', 'notes'), desc='选择工具命中测试')
        qn = qres['notes'] if qok else {}
        ck('① 用「选择」工具让产品自己回答命中省（不假设）',
           bool(qok) and qn.get('hitProvince') == prov['id'],
           '产品命中 %s（%s）vs 目标 %s（%s）；screen=(%d,%d) 画布内=%s 顶层元素=%s；'
           '第一发 %s；被城镇截胡=%s；第二发（关掉城镇图层）%s'
           % (qn.get('hitProvince'), qn.get('hitProvinceName'), prov['id'], prov.get('name'),
              sx, sy, qn.get('onCanvas'), qn.get('topElement'),
              json.dumps(qn.get('attempt1'), ensure_ascii=False), qn.get('interceptedByBurg'),
              json.dumps(qn.get('attempt2'), ensure_ascii=False)))
        ck('该点落在画布内（未被浮层遮挡）', qn.get('onCanvas') and qn.get('topIsCanvas'),
           'topElement=%s' % qn.get('topElement'))
        ck('取整后的屏幕点仍落在目标省内部（世界点复算）', still_in and not others_hit,
           'world=(%.2f, %.2f) 离边界 %.2f 单位' % (wx_eff, wy_eff, clr_eff))

        pok, pres = eval_json(cdp, _sub(PAINT_JS, SX=int(sx), SY=int(sy), TARGET=prov['id']),
                              required=('fails', 'notes'), desc='主动作1 油漆桶')
        if not pok:
            ck('主动作1 探针可求值', False, pres)
            return 1
        pn = pres['notes']
        if pres['fails']:
            ck('主动作1 探针内部断言', False, '；'.join(pres['fails']))
        ck('② 页面内该省 ownership 变成新势力',
           pn.get('ownerAfter') == (pn.get('newPolity') or {}).get('id')
           and pn.get('ownerAfter') != pn.get('ownerBefore'),
           '省 %s（%s）：%s(%s) → %s(%s)；全表变化 %d 条'
           % (prov['id'], prov.get('name'), pn.get('ownerBefore'), pn.get('ownerBeforeName'),
              pn.get('ownerAfter'), pn.get('ownerAfterName'), len(pn.get('changed') or [])))
        ck('③ 状态栏点名了这次易主', bool(pn.get('hint')) and str(prov.get('name')) in str(pn.get('hint')),
           pn.get('hint'))
        print('  · 归属：%s(%s) → %s(%s)；该省 ownership 总条数 %s；全表变化 %s；易主日期 %s；状态栏「%s」'
              % (pn.get('ownerBefore'), pn.get('ownerBeforeName'), pn.get('ownerAfter'),
                 pn.get('ownerAfterName'), pn.get('ownedTotal'),
                 json.dumps(pn.get('changed'), ensure_ascii=False),
                 json.dumps(pn.get('changeEvent'), ensure_ascii=False), pn.get('hint')), flush=True)

        time.sleep(3.0)                                     # 等自动保存防抖（geodata 800ms + 项目侧一层）
        cdp.eval("(async () => { await window.__probe.flushProject(); return true; })()")
        time.sleep(1.0)
        dok, disk = eval_json(cdp, DISK_JS.replace('__SC__', SC).replace('__TARGET__', prov['id'])
                              .replace('__KEY__', KEY), required=('has', 'saves'), desc='读盘载荷')
        ck('④ 读盘判据：落盘载荷（__probe.lastProject）里该省 ownership 已是新势力',
           dok and disk.get('owner') == (pn.get('newPolity') or {}).get('id'),
           json.dumps(disk, ensure_ascii=False))
        ck('落盘载荷里 desite terrain 仍是 415 省、剧本仍是 12 个',
           disk.get('terrain') == 415 and disk.get('scenarioCount') == 12,
           'terrain=%s scenarios=%s' % (disk.get('terrain'), disk.get('scenarioCount')))
        # 🔴 证明"打开的是真实项目"而不是 harness 基线项目：两者实体数都是 120、名字也高度重合
        #    （fixture 就是从这份真实项目派生的）→ 只有 meta.name 与保存路径能区分。
        ck('打开与落盘的确实是真实项目（meta.name=绒花计划 / 保存路径=real-desite.sitian）',
           disk.get('metaName') == '绒花计划'
           and all(p == MOCK_PROJECT_PATH for p in (disk.get('savePaths') or []))
           and inj.get('filePath') == MOCK_PROJECT_PATH,
           'meta.name=%s filePath=%s 保存次数=%s 保存路径=%s'
           % (disk.get('metaName'), inj.get('filePath'), disk.get('saves'),
              json.dumps(disk.get('savePaths'), ensure_ascii=False)))

        shot2 = os.path.join(OUT_DIR, 'ui-2-after-paint.png')
        ok2, i2 = _screenshot(cdp, shot2)
        ck('应用界面截图 2（改归属之后，状态栏点名易主）', ok2, i2)

        # ── 6. 主动作 2：选一个时间点 ───────────────────────────────────
        print('7/7 主动作 2：同一年代内换年份…', flush=True)
        tok, tres = eval_json(cdp, _sub(TIME_JS, YEARS=[y0, year, y1]),
                              required=('notes',), desc='主动作2 时间点')
        if not tok:
            ck('主动作2 探针可求值', False, tres)
        else:
            tn = tres['notes']
            print('  · 年代区间 %s；eraChg.changed=%s；该剧本 changeEvents 条数=%s'
                  % (json.dumps(tn.get('eraRange'), ensure_ascii=False), tn.get('eraChgChanged'),
                     tn.get('changeEventsInScenario')), flush=True)
            print('  · 各年份导出物：%s' % json.dumps(tn.get('byYear'), ensure_ascii=False), flush=True)
            ck('三个年份都真的写进了游标（tlYear 实测）',
               all(v['tlYear'] == int(y) for y, v in (tn.get('byYear') or {}).items()),
               json.dumps(tn.get('byYear'), ensure_ascii=False))
            ck('主动作2 结论已如实记录（同年代内换年份 → %s）'
               % ('导出物逐字相同' if tn.get('distinctHashes') == 1 else '%d 种结果' % tn.get('distinctHashes')),
               True,
               'distinctHashes=%s；changeEvents=%s；eraChg.changed=%s'
               % (tn.get('distinctHashes'), tn.get('changeEventsInScenario'), tn.get('eraChgChanged')))

        # ── 7. 主动作 3：导出一张 PNG ───────────────────────────────────
        eok, eres = eval_json(cdp, EXPORT_JS.replace('__SM__', SM).replace('__SHOW_LABELS__', 'true'),
                              required=('fails', 'notes'), desc='主动作3 导出 PNG')
        if not eok:
            ck('主动作3 导出探针可求值', False, eres)
            return 1
        en = eres['notes']
        if eres['fails']:
            ck('主动作3 探针内部断言', False, '；'.join(eres['fails']))
        ck('真鼠标点导出按钮 → 恰好一次 IPC → 状态栏「已导出 PNG」',
           en.get('hitTarget') and en.get('calls') == 1 and '已导出 PNG' in str(en.get('status')),
           'hitTarget=%s calls=%s 等待 %sms status=%s' % (en.get('hitTarget'), en.get('calls'),
                                                        en.get('waitedMs'), en.get('status')))
        if not en.get('dataUrlLen'):
            ck('拿到 dataUrl', False, json.dumps(en, ensure_ascii=False)[:400])
            return 1
        try:
            data_url = fetch_string(
                cdp,
                "window.__LAST_EXPORT__ && window.__LAST_EXPORT__.dataUrl ? window.__LAST_EXPORT__.dataUrl.length : -1",
                lambda i, j: "window.__LAST_EXPORT__.dataUrl.slice(%d,%d)" % (i, j),
                chunk=524288, desc='分块取回真实 PNG dataUrl')
        except Exception as e:
            ck('分块取回 dataUrl（分块大小 512KB）', False, str(e))
            return 1
        raw = png.decode_data_url(data_url)
        scen_name = en.get('scenarioName') or SC.split('/')[-1]
        png_path = os.path.join(OUT_DIR, 'desite-%s-%s.png' % (scen_name, en.get('tlYear')))
        with open(png_path, 'wb') as f:
            f.write(raw)
        img = png.open_png(raw)
        hok, head = eval_json(cdp, SVGHEAD_JS.replace('__SM__', SM), required=('w', 'h'), desc='真实 SVG 头')
        expect = (head['w'] * 2, head['h'] * 2) if hok else None
        ck('导出的是合法 PNG', img.format == 'PNG', 'format=%s' % img.format)
        ck('PNG 尺寸 == SVG 头 ×2', expect is not None and img.size == expect,
           'PNG %d×%d vs SVG %s×%s ×2 = %s；dataUrl %d 字符 → 文件 %d B'
           % (img.size[0], img.size[1], head.get('w'), head.get('h'), expect, len(data_url), len(raw)))
        n_unique = png.unique_colors(img)
        ck('非空白：去重颜色数 ≥ 4', n_unique >= 4, '实测 %d 色' % n_unique)
        polities = real['scenarios']['scenarios'][SC]['polities']
        pol_rgb = [tuple(int(p['color'][i:i + 2], 16) for i in (1, 3, 5)) for p in polities if p.get('color')]
        rows = []
        for p, c in zip(polities, pol_rgb):
            rows.append((p['id'], p.get('name'), p['color'],
                         png.count_near(img, c, 8),
                         png.count_near_blend(img, c, png.PROVINCE_FILL_ALPHA, png.SVG_BG, 8)))
        ck('剧本全部 %d 个势力的颜色在图上都有像素' % len(rows), all(e + b > 0 for _, _, _, e, b in rows),
           '；'.join('%s %s %s 原色%d+合成%d' % r for r in rows))
        for r in rows:
            print('  · 势力色 %s %s %s：原色 %d + 0.72合成 %d' % r, flush=True)
        labs = png.name_text_candidates(png.LABEL_COLOR, png.LABEL_ALPHA, pol_rgb)
        text_px = png.count_near_any(img, labs, 8)
        ctrl = png.count_near_any(img, png.name_text_candidates((0, 255, 0), png.LABEL_ALPHA, pol_rgb), 8)
        # 🔴 上面这个判据有已知的假阳性地板（合成 fixture 上实测 ~4.8k 像素来自省界/过渡色）。
        #    所以再导一张**关掉标注**的图，用「两导之差」给出**精确**的标注层像素数。
        text_exact = label_stroke = None
        try:
            e2ok, e2res = eval_json(cdp, EXPORT_JS.replace('__SM__', SM).replace('__SHOW_LABELS__', 'false'),
                                    required=('fails', 'notes'), desc='主动作3b 关标注再导一次')
            if e2ok and e2res['notes'].get('dataUrlLen'):
                du2 = fetch_string(
                    cdp,
                    "window.__LAST_EXPORT__ && window.__LAST_EXPORT__.dataUrl ? window.__LAST_EXPORT__.dataUrl.length : -1",
                    lambda i, j: "window.__LAST_EXPORT__.dataUrl.slice(%d,%d)" % (i, j),
                    chunk=524288, desc='分块取回关标注的 PNG dataUrl')
                img2 = png.open_png(png.decode_data_url(du2))
                text_exact, _ = png.diff_pixels(img, img2)
                label_stroke = png.label_text_pixels(img, img2, png.LABEL_COLOR, png.LABEL_ALPHA, 8)
                ck('精确标注层像素（有/无标注两导之差，同一尺寸）',
                   img2.size == img.size and text_exact > 0,
                   '标注层 %s px、其中 LABEL_COLOR 实心笔画 %s px；关标注图 %d×%d'
                   % (text_exact, label_stroke, img2.size[0], img2.size[1]))
                print('  · 精确标注层像素 %s（其中 LABEL_COLOR 实心笔画 %s）' % (text_exact, label_stroke), flush=True)
            else:
                ck('关标注的第二次导出（用于精确文字像素）', False,
                   json.dumps((e2res or {}).get('notes'), ensure_ascii=False)[:300])
        except Exception as e:
            ck('关标注的第二次导出（用于精确文字像素）', False, '异常：%s' % e)
        ck('含文字像素（省名标注层，415 个「新省份 N」都不过 FMG 过滤器）', text_px > 1000,
           '实测 %d px（判据 = LABEL_COLOR@0.85 叠在已知底子上的合成色，容差 ±8；**有假阳性地板**，'
           '精确值见上一条）；同判据假色对照 #00ff00 = %d px' % (text_px, ctrl))
        ck('SVG 头里带剧本名标题', bool(head.get('hasTitle')), 'hasTitle=%s' % head.get('hasTitle'))
        print('  · 导出 SVG：%s B，%s path / %s text / %s pattern'
              % (head.get('bytes'), head.get('paths'), head.get('texts'), head.get('patterns')), flush=True)
        print('  · PNG 落盘：%s（%d×%d，%d B，%d 色，文字像素 %d）'
              % (png_path, img.size[0], img.size[1], len(raw), n_unique, text_px), flush=True)

        shot3 = os.path.join(OUT_DIR, 'ui-3-after-export.png')
        ok3, i3 = _screenshot(cdp, shot3)
        ck('应用界面截图 3（导出后的状态栏「已导出 PNG」）', ok3, i3)
        # 三张截图必须**互不相同**（否则"三张证据"其实是同一张，等于只有一张）
        sizes = [os.path.getsize(p) for p in (shot1, shot2, shot3)]
        hashes = [sha256(p) for p in (shot1, shot2, shot3)]
        ck('三张界面截图内容互不相同（不是同一张复制三份）', len(set(hashes)) == 3,
           'sha256 前 8 位 %s；字节 %s' % ([h[:8] for h in hashes], sizes))

        # 证据清单
        listing = sorted(f for f in os.listdir(OUT_DIR))
        print('  · 证据目录内容：%s' % json.dumps(listing, ensure_ascii=False), flush=True)
    finally:
        if cdp is not None:
            try:
                cdp.close()
            except Exception:
                pass
        for h in handles:
            h.stop()
        try:
            rt.free_port(rt.DEV_PORT)
            rt.free_port(rt.CDP_PORT)
        except Exception:
            pass
        try:
            rt.teardown_mock()
        except Exception as e:
            print('  ⚠️ teardown_mock 失败：%s' % e, flush=True)
        shutil.rmtree(os.path.join(ROOT, '.test-edge-profile'), ignore_errors=True)
        if os.path.exists(REAL_PROJECT):
            after_stat = file_stat(REAL_PROJECT)
            same = (after_stat['sha256'] == before_stat['sha256']
                    and after_stat['size'] == before_stat['size']
                    and abs(after_stat['mtime'] - before_stat['mtime']) < 1e-6)
            ck('真实项目文件未变（sha256/size/mtime 三项一致）', same,
               'before size=%d sha=%s / after size=%d sha=%s'
               % (before_stat['size'], before_stat['sha256'][:16], after_stat['size'], after_stat['sha256'][:16]))
            print('  · 真实项目：size %d→%d，sha256 %s→%s' % (before_stat['size'], after_stat['size'],
                                                             before_stat['sha256'][:16], after_stat['sha256'][:16]), flush=True)
        ck('index.html 已还原（无 .bak 残留）', not os.path.exists(rt.INDEX_HTML + '.bak'))
        ck('mock-data 已删除（真实项目副本随之消失）', not os.path.isdir(rt.MOCK_DATA_DIR))

    print('\n=== 结果 ===', flush=True)
    for n, o, d in R:
        print('  %s %s%s' % ('✅' if o else '❌', n, ('  — ' + str(d)) if d != '' else ''), flush=True)
    fails = [n for n, o, _ in R if not o]
    print('\n%d/%d 通过' % (len(R) - len(fails), len(R)), flush=True)
    if fails:
        print('失败项:', flush=True)
        for n in fails:
            print('  - %s' % n, flush=True)
        return 1
    print('证据目录: %s' % OUT_DIR, flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
