#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""第 6 件 · 终验自测链（**副本制** + 反向探针 + 读盘判据 + 三张无头截图）

它证明什么（判据顺序 = 用户终验时亲手做的那三步）：
  ① **三步齐**：涂几个省归属 → 拖时间轴看地图随年份变 → 导出切片 PNG（真文件、非空白）
  ② **手感五件**：涂色一笔多格 / 吸管 / 多选批量 / 撤销重做往返 / 标签联动
  ③ **415 省真实项目数据不丢**：逐省 culture·coast·biome·kind·color·顶点指纹；剧本数/势力/
     initialOwnership；未动省的 changeEvents 条数一条不多
  ④ **自测链本身可信**：3 枚反向探针（错一个必红）、读盘判据（把落盘载荷原样写盘再从磁盘读回）、
     三张互不相同的无头截图

为什么用**副本**（副本制）：
  · 真实项目 `C:\\Users\\muyu\\Documents\\SiTianProjects\\绒花计划.sitian` 全程只读 ——
    跑前记录 sha256/size/mtime，跑完三项必须逐字节一致（本脚本最后一条判据）；
  · 所有动作都发生在 `src/renderer/mock-data/real_project.json` 这份副本上（跑完随 mock-data 删除）。

与其它两个演练的分工（**不重复**）：
  · `drill_quit_flush.py` = 真 Electron + dist + 真实项目：判据只有磁盘（退出落盘/强杀）；
  · `drill_p0_first_map.py` = 真实数据副本 + 无头浏览器：画范围 / 时间点 / 导 PNG；
  · **本脚本** = 同一套副本制思路，但覆盖「三步 + 手感五件 + 数据不丢 + 反向探针 + 切片 PNG」，
    并且把落盘载荷**写成真文件再从磁盘读回**（mock 环境里主进程不落盘，所以判据是
    「应用交给保存 IPC 的字节」+「这些字节写盘/读回后仍自洽」；真实磁盘链路由 drill_quit_flush 守）。

用法（**不要传 `--` 开头的参数**：run_tests 顶层会把它们当用例名解析）：
    python scripts/tests/drill_final_acceptance.py
产物：
    build/final-acceptance/ui-1-after-paint.png / ui-2-after-timeline.png / ui-3-after-slice-export.png
    build/final-acceptance/slices/*.png            切片导出的真实 PNG（PNG 1× 两帧）
    build/final-acceptance/roundtrip.sitian        落盘载荷写成的项目文件（读盘判据用）
    build/final-acceptance/report.md               本次判据汇总（给终验看的那一页）
"""
import base64
import copy
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
OUT_DIR = os.path.join(ROOT, 'build', 'final-acceptance')
KEY = 'desite'
SC_PAINT = 'desite/诸侯割据'      # 7 个势力 / 183 条易主 —— 三步用的主场景
SC_SLICE = 'desite/炎太帝国'      # 只有 1 条易主 → 本剧本范围 2 帧（切片 PNG 的落盘判据用它，体量可控）
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
# 数据完整性判据（纯 Python；反向探针直接复用同一份函数 —— 这样才能证明它"抓得住"）
# ══════════════════════════════════════════════════════════════════════════
PROV_KEYS = ('name', 'kind', 'color', 'biome', 'culture', 'coast')


def province_fp(prov):
    """省份指纹：只取**世界观语义字段** + 顶点逐位（`points` 用规范 JSON 再哈希）。
    坐标不是世界观（AGENTS 红线），但顶点是省界形状 —— 形状变了必须能抓到。"""
    pts = []
    for p in (prov.get('points') or []):
        if isinstance(p, dict):
            pts.append([round(float(p.get('x', 0)), 6), round(float(p.get('y', 0)), 6)])
        elif isinstance(p, (list, tuple)) and len(p) >= 2:
            pts.append([round(float(p[0]), 6), round(float(p[1]), 6)])
    ring = hashlib.sha256(json.dumps(pts, separators=(',', ':')).encode('utf-8')).hexdigest()[:16]
    return {
        'keys': {k: prov.get(k) for k in PROV_KEYS},
        'rings': len(prov.get('points') or []),
        'ringHash': ring,
    }


def _change_count(ev):
    """一个省的易主记录条数：`changeEvents[pid]` 可能是数组（多次易主）也可能是单条对象。"""
    if isinstance(ev, list):
        return len(ev)
    return 1 if isinstance(ev, dict) else 0


def data_snapshot(proj):
    """一份项目 → 数据不丢判据用的快照（省份指纹 + 剧本账本计数）。"""
    maps = (proj.get('scenarios') or {}).get('baseMaps') or {}
    bm = maps.get(KEY) or {}
    terrain = bm.get('terrain') or []
    provs = {}
    for p in terrain:
        if p and p.get('id'):
            provs[p['id']] = province_fp(p)
    scs = {}
    for sid, sc in (((proj.get('scenarios') or {}).get('scenarios')) or {}).items():
        ce = sc.get('changeEvents') or {}
        scs[sid] = {
            'name': sc.get('name'),
            'era': sc.get('era'),
            'polities': sorted([p.get('id') for p in (sc.get('polities') or []) if p and p.get('id')]),
            'ownership': len(sc.get('ownership') or {}),
            'initial': len(sc.get('initialOwnership') or {}),
            # ⚠️ 按**省**记条数（不是按 key 数）：同省多次易主会追加到同一个键下，
            #    只数 key 会把"涂一个已有易主记录的省"看漏（第一次跑就踩了：183 == 183）。
            'changesByProv': {pid: _change_count(ev) for pid, ev in ce.items()},
            'changes': sum(_change_count(ev) for ev in ce.values()),
            'timelineEvents': len(sc.get('timelineEvents') or []),
        }
    return {
        'provinceCount': len(terrain),
        'provinceIds': sorted(provs.keys()),
        'provinces': provs,
        'scenarios': scs,
        'baseMapKeys': sorted(maps.keys()),
        'rivers': len(bm.get('rivers') or []),
        'burgs': len(bm.get('burgs') or []),
    }


def compare_snapshots(before, after, touched, touched_scenario=SC_PAINT, expected_provinces=None):
    """逐项对比，返回差异清单（空 = 数据没丢）。

    @param touched 本次真实改动过的省份 id 集合（只允许它们的 changeEvents 变多）
    """
    diffs = []
    exp_n = expected_provinces if expected_provinces is not None else before['provinceCount']
    if after['provinceCount'] != exp_n:
        diffs.append('省份数 %s ≠ %s' % (after['provinceCount'], exp_n))
    if after['provinceIds'] != before['provinceIds']:
        lost = set(before['provinceIds']) - set(after['provinceIds'])
        extra = set(after['provinceIds']) - set(before['provinceIds'])
        diffs.append('省份 id 集合变了（丢 %s / 多 %s）' % (sorted(lost)[:5], sorted(extra)[:5]))
    for pid, b in before['provinces'].items():
        a = after['provinces'].get(pid)
        if not a:
            continue
        for k in ('keys', 'rings', 'ringHash'):
            if a[k] != b[k]:
                diffs.append('省 %s 的 %s 变了' % (pid, k))
                break
    if after['baseMapKeys'] != before['baseMapKeys']:
        diffs.append('底图键变了：%s → %s' % (before['baseMapKeys'], after['baseMapKeys']))
    if after['rivers'] != before['rivers'] or after['burgs'] != before['burgs']:
        diffs.append('河流/城镇数变了：河 %s→%s 镇 %s→%s'
                     % (before['rivers'], after['rivers'], before['burgs'], after['burgs']))
    if sorted(after['scenarios'].keys()) != sorted(before['scenarios'].keys()):
        diffs.append('剧本集合变了')
    for sid, b in before['scenarios'].items():
        a = after['scenarios'].get(sid)
        if not a:
            continue
        for k in ('name', 'era', 'polities', 'initial', 'timelineEvents'):
            if a[k] != b[k]:
                diffs.append('剧本 %s 的 %s 变了（%s → %s）' % (sid, k, b[k], a[k]))
        if sid == touched_scenario:
            # 归属键数允许变（涂到一个原本无主的省 = +1），但最多变本次碰过的省数
            if abs(a['ownership'] - b['ownership']) > len(touched):
                diffs.append('剧本 %s 的 ownership 键数异常（%s → %s）' % (sid, b['ownership'], a['ownership']))
            # 逐省比易主条数：碰过的省各 +1；**没碰过的省一条都不许多**
            for pid, n in b['changesByProv'].items():
                got = a['changesByProv'].get(pid, 0)
                if pid in touched:
                    if got != n + 1:
                        diffs.append('剧本 %s：碰过的省 %s 易主条数 %s ≠ 期望 %s' % (sid, pid, got, n + 1))
                elif got != n:
                    diffs.append('剧本 %s：没碰过的省 %s 易主条数被动了（%s → %s）' % (sid, pid, n, got))
            for pid in a['changesByProv']:
                if pid not in b['changesByProv'] and pid not in touched:
                    diffs.append('剧本 %s：凭空多出省 %s 的易主记录' % (sid, pid))
        else:
            if a['ownership'] != b['ownership']:
                diffs.append('剧本 %s 的 ownership 键数被动了（%s → %s）' % (sid, b['ownership'], a['ownership']))
            if a['changes'] != b['changes']:
                diffs.append('剧本 %s 的 changeEvents 被动了（%s → %s）' % (sid, b['changes'], a['changes']))
    return diffs


# ══════════════════════════════════════════════════════════════════════════
# 几何：找一个"够深"的省内点（凹省/带洞省也安全）
# ══════════════════════════════════════════════════════════════════════════
def _rings(prov):
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


def polyline_clearance(x, y, pts):
    """点到一条折线（河）的最近距离（世界单位）。"""
    best = float('inf')
    for i in range(len(pts) - 1):
        x1, y1 = _xy(pts[i])
        x2, y2 = _xy(pts[i + 1])
        dx, dy = x2 - x1, y2 - y1
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / L2))
        px, py = x1 + t * dx, y1 + t * dy
        d2 = (x - px) ** 2 + (y - py) ** 2
        if d2 < best:
            best = d2
    return best ** 0.5


def river_clearance(x, y, rivers):
    """点到所有河的最近距离 —— 「选择」工具里河**优先于省**（既定口径），
    所以要用 Ctrl+点击选省的点必须离河够远，否则会被河截胡（实测：多选只剩 1 个省）。"""
    best = float('inf')
    for r in rivers or []:
        pts = r.get('points') or []
        if len(pts) >= 2:
            d = polyline_clearance(x, y, pts)
            if d < best:
                best = d
    return best


def _event_year(ev):
    """`changeEvents[pid]` 是**事件列表**（同日多事件/多次易主）—— 取最后一条的年份。"""
    if isinstance(ev, list):
        ev = ev[-1] if ev else None
    if not isinstance(ev, dict):
        return None
    if isinstance(ev.get('date'), dict):
        return ev['date'].get('y')
    return ev.get('y')


def _inside(x, y, rings):
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


def pick_interior_points(terrain, count=3, want=4.0, grid=32):
    """挑 `count` 个**不同省**的深内点（按包围盒降序试；彼此间距 ≥ 60 世界单位，便于一笔跨省）。"""
    others = []
    for p in terrain:
        rgs = _rings(p)
        if rgs:
            others.append((p, rgs, _bbox(rgs[0])))
    cand = sorted((((b[2] - b[0]) * (b[3] - b[1]), p, rgs, b) for p, rgs, b in others),
                  key=lambda t: -t[0])
    out = []
    for area, prov, rgs, bb in cand[:28]:
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
        if not best or best[2] < want:
            continue
        if any(((best[0] - o[1]) ** 2 + (best[1] - o[2]) ** 2) ** 0.5 < 60 for o in out):
            continue
        out.append((prov, best[0], best[1], best[2]))
        if len(out) >= count:
            break
    return out


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
  return JSON.stringify({
    ok: !!(r && r.success === true), error: (r && r.error) || '',
    ms: Date.now() - t0, filePath: proj.filePath, source: store.canvasSource,
    terrain: bm.terrain ? bm.terrain.length : -1,
    baseMapKeys: Object.keys(store.baseMaps || {}),
    scenarioCount: scKeys.length, nodes: store.nodes.length,
    metaName: real.meta && real.meta.name,
  });
})()"""

SETUP_JS = r"""(async () => {
  const fails = [], notes = {};
  const tick = ms => new Promise(r => setTimeout(r, ms || 200));
  const s = __STORE__, SM = __SM__;
  const SC = __SC__;
  SM.baseMapKey = __KEY__;
  if (typeof SM.onBaseMapChange === 'function') await SM.onBaseMapChange();
  await tick(900);
  const ids = SM.timeline.scenarios.map(x => x.id);
  const k = ids.indexOf(SC);
  notes.eraIds = ids; notes.k = k;
  if (k < 0) return JSON.stringify({ fails: ['时间轴里找不到剧本 ' + SC], notes });
  const era = SM.timeline.years[k];
  notes.eraRange = era;
  // 🔴 对比模式钉到 off：`eu4` 模式下**底色归属**取的是旧主（新主画成斜线），
  //    面板的「归属」也按底色口径读旧主 —— 那是既定语义，不是缺陷；
  //    本演练要看的是"归属随时间变化"，所以用标准模式（用户终验时也建议先关对比）。
  SM.tlDiffMode = 'off';
  const yearPaint = Math.round(era.start + (era.end - era.start) * 0.5);
  notes.yearPaint = yearPaint;
  SM.viewMode = 'scenario';
  SM.tlEra = k;
  SM.tlDate = { y: yearPaint, m: null, d: null };
  SM.selectedScenario = s.scenarios[SC];
  await tick(400);
  notes.tlEra = SM.tlEra; notes.tlYear = Math.round(SM.tlYear);
  notes.scenarioId = SM.selectedScenario ? SM.selectedScenario.id : null;
  notes.changeEventsInScenario = Object.keys(s.scenarios[SC].changeEvents || {}).length;
  notes.initOwn = Object.keys(s.scenarios[SC].initialOwnership || {}).length;
  notes.terrainCount = (s.baseMaps[__KEY__].terrain || []).length;
  if (typeof SM.fitToView === 'function') SM.fitToView();
  await tick(700);
  const cv = document.querySelector('.scenario-map-container canvas');
  if (!cv) return JSON.stringify({ fails: ['找不到剧本画布 canvas'], notes });
  const rect = cv.getBoundingClientRect();
  notes.camera = { scale: SM.cameraScale, x: SM.cameraX, y: SM.cameraY };
  notes.canvasRect = { left: rect.left, top: rect.top, w: rect.width, h: rect.height };
  notes.timeline = { min: SM.timeline.minYear, max: SM.timeline.maxYear };
  return JSON.stringify({ fails, notes });
})()"""

# 通用工具（注入到每个探针开头）：屏幕/世界换算、画布指纹、键盘撤销/重做、SVG 图例计数
JS_LIB = r"""
  const tick = ms => new Promise(r => setTimeout(r, ms || 200));
  const cv = document.querySelector('.scenario-map-container canvas');
  // ⚠️ 每次点击都**重新量**画布矩形：状态栏一行字的变化会把画布往下推 20~40px，
  //    用探针开头量到的旧 rect 会点偏（实测：吸管点到"没有省份"）。
  const canvasRect = () => cv.getBoundingClientRect();
  const rect = canvasRect();
  const toScreen = (wx, wy) => ({ x: wx * SM.cameraScale + SM.cameraX, y: wy * SM.cameraScale + SM.cameraY });
  const clickWorld = async (wx, wy, extra) => {
    const p = toScreen(wx, wy);
    const r = canvasRect();
    const mk = t => new MouseEvent(t, Object.assign({
      clientX: r.left + Math.round(p.x), clientY: r.top + Math.round(p.y),
      bubbles: true, cancelable: true, button: 0,
    }, extra || {}));
    cv.dispatchEvent(mk('mousedown')); cv.dispatchEvent(mk('mouseup')); cv.dispatchEvent(mk('click'));
    await tick(350);
  };
  const key = async (k, mods) => {
    window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true }, mods || {})));
    await tick(350);
  };
  const undo = () => key('z', { ctrlKey: true });
  const redo = () => key('y', { ctrlKey: true });
  const canvasHash = () => {
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let h = 5381, n = 0;
    for (let i = 0; i < d.length; i += 4 * 7) {
      h = ((h * 33) ^ d[i]) >>> 0; h = ((h * 33) ^ d[i + 1]) >>> 0; h = ((h * 33) ^ d[i + 2]) >>> 0; n++;
    }
    return h.toString(16) + ':' + n;
  };
  const legendCounts = (dateObj) => {
    const b = SM.scenarioExport && SM.scenarioExport.buildScenarioSVG;
    if (!b) return null;
    const svg = String(b({ date: dateObj, year: dateObj.y }).svg || '');
    const out = {};
    const re = /<text x="[^"]*" y="([0-9.]+)"[^>]*text-anchor="end">(\d+)<\/text>/g;
    let m;
    while ((m = re.exec(svg))) {
      const y = Number(m[1]);
      const i = Math.round((y - 46) / 15);
      if (i >= 0) out[i] = Number(m[2]);
    }
    return { counts: out, bytes: svg.length };
  };
"""

PAINT_JS = r"""(async () => {
  const fails = [], notes = {};
  const s = __STORE__, SM = __SM__;
  const SC = __SC__, TARGET = __TARGET__;
  __LIB__
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
  await tick(300);
  await clickWorld(__WX__, __WY__);
  const sc1 = s.scenarios[SC];
  const after = sc1.ownership || {};
  notes.ownerAfter = after[TARGET] || null;
  notes.ownerAfterName = ((sc1.polities || []).find(p => p.id === notes.ownerAfter) || {}).name || null;
  notes.hint = SM.provinceHint;
  notes.changeEvent = (sc1.changeEvents || {})[TARGET] || null;
  notes.tlYear = Math.round(SM.tlYear);
  // 撤销 → 原主；重做 → 新主（手感件④：往返）
  SM.selectedProvince = (s.baseMaps[__KEY__].terrain || []).find(p => p.id === TARGET) || null;
  await undo();
  notes.afterUndo = (s.scenarios[SC].ownership || {})[TARGET] || null;
  await redo();
  notes.afterRedo = (s.scenarios[SC].ownership || {})[TARGET] || null;
  notes.selPolityAtPaintYear = SM.selectedProvincePolity ? SM.selectedProvincePolity.name : null;
  notes.diag = {
    cam: { x: SM.cameraX, y: SM.cameraY, s: SM.cameraScale },
    rect: { l: rect.left, t: rect.top, w: rect.width, h: rect.height },
    clickScreen: { x: Math.round(toScreen(__WX__, __WY__).x), y: Math.round(toScreen(__WX__, __WY__).y) },
    worldAtClick: toScreen(__WX__, __WY__),
    selId: SM.selectedProvince && SM.selectedProvince.id,
    ownMap: (s.scenarios[SC].ownership || {})[TARGET] || null,
    era: SM.tlEra, date: SM.tlDate,
    viaFn: (typeof SM.ownerPolityForProvince === 'function' && SM.ownerPolityForProvince(TARGET))
      ? SM.ownerPolityForProvince(TARGET).name : null,
    tlIds: SM.timeline.scenarios.map(x => x.id),
    polAtEra: ((SM.timeline.scenarios[SM.tlEra] || {}).polities || []).map(p => p.id + ':' + p.name),
    ref: (typeof SM.currentOwnerRef === 'function')
      ? SM.currentOwnerRef(SM.timeline, SM.tlEra, TARGET, SM.tlDate) : null,
    diffMode: SM.tlDiffMode,
  };
  return JSON.stringify({ fails, notes });
})()"""

BRUSH_JS = r"""(async () => {
  const fails = [], notes = {};
  const s = __STORE__, SM = __SM__;
  const SC = __SC__;
  __LIB__
  const sc = s.scenarios[SC];
  const pid = SM.selectedPolity && SM.selectedPolity.id;
  const before = Object.assign({}, sc.ownership || {});
  // 一笔从 P1 内部拖到 P2 内部：碰到的省都改成当前势力（一笔 = 一条 undo）
  const p1 = toScreen(__WX1__, __WY1__), p2 = toScreen(__WX2__, __WY2__);
  const mk = (t, x, y) => {
    const r = canvasRect();                 // 每次重量（状态栏变化会挪画布）
    return new MouseEvent(t, {
      clientX: r.left + Math.round(x), clientY: r.top + Math.round(y),
      bubbles: true, cancelable: true, button: 0, buttons: t === 'mouseup' ? 0 : 1,
    });
  };
  SM.setTool('ownerBrush');
  await tick(300);
  cv.dispatchEvent(mk('mousedown', p1.x, p1.y));
  const steps = 24;
  for (let i = 1; i <= steps; i++) {
    cv.dispatchEvent(mk('mousemove', p1.x + (p2.x - p1.x) * i / steps, p1.y + (p2.y - p1.y) * i / steps));
    await tick(16);
  }
  cv.dispatchEvent(mk('mouseup', p2.x, p2.y));
  await tick(600);
  const after = s.scenarios[SC].ownership || {};
  const changed = [];
  for (const kk of Object.keys(after)) if ((before[kk] || null) !== (after[kk] || null)) changed.push(kk);
  notes.polity = pid;
  notes.changed = changed;
  notes.hint = SM.provinceHint;
  notes.undoStackLabel = s.undoLabel || null;
  await undo();
  const afterUndo = s.scenarios[SC].ownership || {};
  notes.undoRestoredAll = changed.every(kk => (afterUndo[kk] || null) === (before[kk] || null));
  await redo();
  const afterRedo = s.scenarios[SC].ownership || {};
  notes.redoReappliedAll = changed.every(kk => (afterRedo[kk] || null) === (after[kk] || null));
  // 收尾：撤销这一笔，回到"只涂了 P1"的状态（后面步骤的判据就只依赖 P1）
  await undo();
  notes.leftUndone = changed.every(kk => ((s.scenarios[SC].ownership || {})[kk] || null) === (before[kk] || null));
  return JSON.stringify({ fails, notes });
})()"""

EYEDROP_JS = r"""(async () => {
  const fails = [], notes = {};
  const s = __STORE__, SM = __SM__;
  __LIB__
  SM.setTool('ownerBrush');
  SM.selectedPolity = null;
  SM.provinceHint = '';
  await tick(250);
  const sp = toScreen(__WX__, __WY__);
  notes.diag = {
    cam: { x: SM.cameraX, y: SM.cameraY, s: SM.cameraScale },
    rect: { l: rect.left, t: rect.top, w: rect.width, h: rect.height },
    screen: { x: Math.round(sp.x), y: Math.round(sp.y) },
    worldByProduct: { x: (Math.round(sp.x) - SM.cameraX) / SM.cameraScale, y: (Math.round(sp.y) - SM.cameraY) / SM.cameraScale },
    directHit: (typeof SM.findProvinceAt === 'function')
      ? ((SM.findProvinceAt((Math.round(sp.x) - SM.cameraX) / SM.cameraScale,
                           (Math.round(sp.y) - SM.cameraY) / SM.cameraScale) || {}).id || null) : null,
  };
  await clickWorld(__WX__, __WY__, { altKey: true });
  notes.hint = SM.provinceHint;
  notes.picked = SM.selectedPolity ? { id: SM.selectedPolity.id, name: SM.selectedPolity.name } : null;
  return JSON.stringify({ fails, notes });
})()"""

MULTI_JS = r"""(async () => {
  const fails = [], notes = {};
  const s = __STORE__, SM = __SM__;
  const SC = __SC__, P1 = __P1__, P3 = __P3__;
  __LIB__
  SM.setTool('select');
  SM.clearProvinceSelection();
  // 🔴 城镇图层会截胡省份点选（真实底图 617 个 burg；P0 演练同款处理）：
  //    先关掉，点完再恢复 —— 不关的话 Ctrl+点击会打开"聚落编辑"而不是选省。
  // 🔴 河流同理（选择工具里河**优先于省**，这是既定口径）：点落在河上会去选河。
  const burgBefore = SM.showBurgs;
  const riverBefore = SM.showRivers;
  SM.showBurgs = false;
  SM.showRivers = false;
  await tick(300);
  const own = () => s.scenarios[SC].ownership || {};
  const before = Object.assign({}, own());

  // 屏幕点 → 产品自己的 findProvinceAt 反查：**由产品确认这个点在目标省里**。
  // 为什么不能拿"固定世界点 × 相机"硬算：布局一变（状态栏多一行 / 面板出现）画布矩形
  // 就挪，取整后可能落到隔壁省；实测出现过"点 P1 却选中 P3、点 P3 却选中一条河"。
  const screenFor = (targetId, wx0, wy0) => {
    const base = toScreen(wx0, wy0);
    for (let d = 0; d <= 72; d += 6) {
      for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, -d], [d, -d], [-d, d]]) {
        const sx = Math.round(base.x + dx), sy = Math.round(base.y + dy);
        const r = canvasRect();
        if (sx < 4 || sy < 4 || sx > r.width - 4 || sy > r.height - 4) continue;
        const w = { x: (sx - SM.cameraX) / SM.cameraScale, y: (sy - SM.cameraY) / SM.cameraScale };
        const p = (typeof SM.findProvinceAt === 'function') ? SM.findProvinceAt(w.x, w.y) : null;
        if (p && p.id === targetId) return { sx, sy, dx, dy };
      }
    }
    return null;
  };

  const ctrlClickAt = async (spot) => {
    const r = canvasRect();
    const mk = t => new MouseEvent(t, {
      clientX: r.left + spot.sx, clientY: r.top + spot.sy,
      bubbles: true, cancelable: true, button: 0, ctrlKey: true,
    });
    cv.dispatchEvent(mk('mousedown')); cv.dispatchEvent(mk('mouseup')); cv.dispatchEvent(mk('click'));
    await tick(400);
    return { sel: SM.selectedProvinceIds.slice(), hint: SM.provinceHint };
  };

  /** 反复找一个"产品自己说属于 targetId"的屏幕点并 Ctrl+点击，直到它进了多选集合。 */
  const ctrlClickUntil = async (targetId, wx0, wy0) => {
    const tried = [];
    let bx = wx0, by = wy0;
    for (let attempt = 0; attempt < 6; attempt++) {
      const spot = screenFor(targetId, bx, by);
      if (!spot) return { ok: false, tried };
      const res = await ctrlClickAt(spot);
      const ok = res.sel.includes(targetId);
      tried.push({ spot, ok, sel: res.sel, hint: res.hint });
      if (ok) return { ok: true, spot, tried };
      // 被河截胡 / 点到隔壁：把搜索起点挪开一点再试（河是折线，挪 24px 通常就离开了）
      bx = (spot.sx + 24 - SM.cameraX) / SM.cameraScale;
      by = (spot.sy + 24 - SM.cameraY) / SM.cameraScale;
    }
    return { ok: false, tried };
  };

  const a1 = await ctrlClickUntil(P1, __WX1__, __WY1__);
  notes.click1 = a1;
  const target = SM.selectedPolity && SM.selectedPolity.id;
  // 第二个省不写死：**用产品自己的 findProvinceAt 在画布上找一个"点得中、且能真改归属"的省**。
  // 为什么：真实 415 省地图上固定世界点会受相机/河/城镇影响（实测点 P3 连续 6 次被河截胡），
  // 而"多选两省"要证明的是多选机制本身，不是某一块具体的省。
  let second = null;
  const scan = [];
  const r0 = canvasRect();
  for (let y = 40; y < r0.height - 40 && !second; y += 36) {
    for (let x = 40; x < r0.width - 40 && !second; x += 36) {
      const w = { x: (x - SM.cameraX) / SM.cameraScale, y: (y - SM.cameraY) / SM.cameraScale };
      const p = (typeof SM.findProvinceAt === 'function') ? SM.findProvinceAt(w.x, w.y) : null;
      if (!p || p.id === P1) continue;
      if ((before[p.id] || null) === target) continue;      // 要能真改，否则回执是"没有需要改动"
      scan.push(p.id);
      const res = await ctrlClickAt({ sx: x, sy: y });
      if (res.sel.includes(P1) && res.sel.includes(p.id)) { second = p.id; break; }
    }
  }
  notes.second = second;
  notes.scanned = scan.slice(0, 8);
  notes.selectedIds = SM.selectedProvinceIds.slice();
  const picked = [P1, second].filter(Boolean);
  notes.picked = picked;
  const bar = document.querySelector('[data-testid="province-batch-bar"]');
  notes.bar = !!bar;
  if (bar) {
    notes.barText = bar.textContent.replace(/\s+/g, ' ').trim().slice(0, 80);
    const btn = bar.querySelector('[data-testid="pbb-assign"]');
    if (btn) { btn.click(); await tick(500); }
  }
  const after = own();
  notes.afterOwn = {};
  for (const id of picked) notes.afterOwn[id] = after[id] || null;
  notes.afterP1 = after[P1] || null;
  notes.afterP3 = second ? (after[second] || null) : null;
  notes.hint = SM.provinceHint;
  const changed = picked.some(id => (before[id] || null) !== (after[id] || null));
  // 🔴 只有**真的指派了**才撤销：批量条没出现时按 Ctrl+Z 会撤到上一条命令（实测把"涂色"撤掉，
  //    后面所有年份断言跟着塌）。撤销的前提必须是"这一步产生了新命令"。
  if (changed) {
    await undo();
    const undone = own();
    notes.undoOwn = {};
    for (const id of picked) notes.undoOwn[id] = undone[id] || null;
    notes.undoBackToBefore = picked.every(id => (undone[id] || null) === (before[id] || null));
  } else {
    notes.undoBackToBefore = false;
    notes.undoSkipped = '本步没有产生新命令（未指派成功）→ 不按 Ctrl+Z';
  }
  SM.showBurgs = burgBefore;
  SM.showRivers = riverBefore;
  return JSON.stringify({ fails, notes });
})()"""

TIME_JS = r"""(async () => {
  const fails = [], notes = {};
  const s = __STORE__, SM = __SM__;
  const SC = __SC__, P1 = __P1__;
  __LIB__
  const tl = SM.timeline;
  const era = tl.years[SM.timeline.scenarios.map(x => x.id).indexOf(SC)];
  notes.eraRange = era;
  const drag = async (year) => {
    const root = document.querySelector('[data-testid="scenario-timeline"]');
    const wrap = root.querySelector('.tl-railwrap');
    const rail = root.querySelector('.tl-rail');
    const r = rail.getBoundingClientRect();
    const u = Math.min(0.999, Math.max(0.001, (year - tl.minYear) / Math.max(1, (tl.maxYear - tl.minYear))));
    const mk = (t, x) => new PointerEvent(t, { clientX: x, clientY: r.top + r.height / 2, bubbles: true, pointerId: 1 });
    wrap.dispatchEvent(mk('pointerdown', r.left + r.width * u));
    wrap.dispatchEvent(mk('pointermove', r.left + r.width * u));
    wrap.dispatchEvent(mk('pointerup', r.left + r.width * u));
    await tick(700);
    const prov = (s.baseMaps[__KEY__].terrain || []).find(p => p.id === P1) || null;
    SM.selectedProvince = prov;
    await tick(250);
    // 归属要按**当前日期**算（`currentOwnerRef` 才是时间轴着色/面板读数的同一口径；
    // 直接读 ownership 缓存是"整个剧本的终态"，不随年份变 —— 这正是本步要证明的事）
    const ref = (typeof SM.currentOwnerRef === 'function')
      ? SM.currentOwnerRef(SM.timeline, SM.tlEra, P1, SM.tlDate) : null;
    return {
      want: year, tlYear: Math.round(SM.tlYear), tlEra: SM.tlEra,
      date: { y: SM.tlDate.y, m: SM.tlDate.m, d: SM.tlDate.d },
      ownCache: (s.scenarios[SC].ownership || {})[P1] || null,
      owner: ref ? ref.owner : null,
      ownerEra: ref ? ref.era : null,
      polityName: SM.selectedProvincePolity ? SM.selectedProvincePolity.name : null,
      legend: legendCounts({ y: Math.round(SM.tlYear), m: null, d: null }),
      hash: canvasHash(),
    };
  };
  notes.atStart = await drag(era.start + 2);
  notes.atLate = await drag(era.end - 2);
  notes.atPaint = await drag(__YEARPAINT__);
  notes.distinctCanvas = new Set([notes.atStart.hash, notes.atLate.hash, notes.atPaint.hash]).size;
  return JSON.stringify({ fails, notes });
})()"""

# 切片导出：真 UI（工具栏「更多」→ 切片导出）→ 选范围 → PNG 1× → 载荷
SLICE_OPEN_JS = r"""(async () => {
  const fails = [], notes = {};
  const SM = __SM__;
  __LIB__
  const root = document.querySelector('[data-testid="scenario-timeline"]');
  const rail = root.querySelector('.tl-rail');
  const tl = SM.timeline;
  const wrap = root.querySelector('.tl-railwrap');
  const r = rail.getBoundingClientRect();
  const u = Math.min(0.999, Math.max(0.001, (__YEAR__ - tl.minYear) / Math.max(1, (tl.maxYear - tl.minYear))));
  const mk = (t) => new PointerEvent(t, { clientX: r.left + r.width * u, clientY: r.top + r.height / 2, bubbles: true, pointerId: 1 });
  wrap.dispatchEvent(mk('pointerdown')); wrap.dispatchEvent(mk('pointerup'));
  await tick(700);
  notes.tlYear = Math.round(SM.tlYear);
  notes.tlEra = SM.tlEra;
  notes.scenario = SM.timeline.scenarios[SM.tlEra] ? SM.timeline.scenarios[SM.tlEra].id : null;
  const btn = document.querySelector('[data-testid="open-slice-export"]');
  if (!btn) return JSON.stringify({ fails: ['工具栏「更多」里没有切片导出入口'], notes });
  btn.click();
  await tick(600);
  const panel = document.querySelector('[data-testid="slice-export-panel"]');
  if (!panel) return JSON.stringify({ fails: ['切片导出对话框没打开'], notes });
  const sel = panel.querySelector('[data-testid="slice-scope"]');
  const count = panel.querySelector('[data-testid="slice-frame-count"]');
  const auto = panel.querySelector('[data-testid="slice-scope-auto"]');
  notes.scope = sel ? sel.value : null;
  notes.frameCount = count ? Number(String(count.textContent).trim()) : null;
  notes.autoHint = auto ? auto.textContent.replace(/\s+/g, ' ').trim() : '';
  notes.options = sel ? Array.from(sel.options).map(o => ({ v: o.value, t: o.textContent.trim() })) : [];
  return JSON.stringify({ fails, notes });
})()"""

SLICE_SWITCH_ALL_JS = r"""(async () => {
  try {
    const fails = [], notes = {};
    const SM = __SM__;
    __LIB__
    const panel = document.querySelector('[data-testid="slice-export-panel"]');
    if (!panel) return JSON.stringify({ fails: ['对话框不在了'], notes });
    const sel = panel.querySelector('[data-testid="slice-scope"]');
    if (!sel) return JSON.stringify({ fails: ['没有范围下拉'], notes });
    sel.value = 'all';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await tick(700);
    const count = panel.querySelector('[data-testid="slice-frame-count"]');
    const run = panel.querySelector('[data-testid="slice-export-run"]');
    notes.frameCountAll = count ? Number(String(count.textContent).trim()) : null;
    notes.runDisabled = run ? !!run.disabled : null;
    notes.overLimit = !!panel.querySelector('[data-testid="slice-over-limit"]');
    notes.overLimitText = panel.querySelector('[data-testid="slice-over-limit"]')
      ? panel.querySelector('[data-testid="slice-over-limit"]').textContent.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    // 切回本剧本（导出用）
    sel.value = 'era';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await tick(600);
    notes.frameCountEra = count ? Number(String(count.textContent).trim()) : null;
    notes.scope = sel.value;
    return JSON.stringify({ fails, notes });
  } catch (e) {
    return JSON.stringify({ fails: ['切换范围时抛异常：' + ((e && e.message) || e)], notes: {} });
  }
})()"""

SLICE_RUN_JS = r"""(async () => {
  const fails = [], notes = {};
  const SM = __SM__;
  __LIB__
  const panel = document.querySelector('[data-testid="slice-export-panel"]');
  const pngBox = panel.querySelector('[data-testid="slice-format-png"]');
  if (pngBox && !pngBox.checked) { pngBox.click(); await tick(250); }
  const scaleSel = panel.querySelector('[data-testid="slice-scale"]');
  if (scaleSel) { scaleSel.value = '1'; scaleSel.dispatchEvent(new Event('change', { bubbles: true })); await tick(200); }
  window.__FRAMES_EXPORTS__ = [];
  const run = panel.querySelector('[data-testid="slice-export-run"]');
  if (!run || run.disabled) return JSON.stringify({ fails: ['导出按钮灰着（帧数超限？）'], notes });
  run.click();
  let w = 0;
  while ((window.__FRAMES_EXPORTS__ || []).length === 0 && w < 90000) { await tick(200); w += 200; }
  const rec = (window.__FRAMES_EXPORTS__ || [])[0] || null;
  const m = (rec && rec.manifest) || {};
  notes.waitedMs = w;
  notes.status = SM.exportStatus;
  notes.files = rec ? (rec.files || []).length : 0;
  notes.names = rec ? (rec.files || []).map(f => f.name) : [];
  notes.scope = m.scope || null;
  notes.frameCount = m.frameCount || 0;
  notes.frameSize = m.frameSize || null;
  notes.dirName = rec ? rec.dirName : '';
  notes.dataUrlLens = rec ? (rec.files || []).map(f => String(f.dataUrl || '').length) : [];
  if (!rec) fails.push('导出没走到 exportScenarioFrames');
  return JSON.stringify({ fails, notes });
})()"""

DISK_JS = r"""(() => {
  const p = window.__probe && window.__probe.lastProject();
  if (!p) return JSON.stringify({ has: false, saves: (window.__savedProject || []).length });
  const sc = ((p.scenarios || {}).scenarios || {})['__SC__'];
  const bm = ((p.scenarios || {}).baseMaps || {})['__KEY__'] || {};
  return JSON.stringify({
    has: true, saves: (window.__savedProject || []).length,
    metaName: (p.meta || {}).name || null,
    terrain: bm.terrain ? bm.terrain.length : -1,
    scenarioCount: Object.keys((p.scenarios || {}).scenarios || {}).length,
    changeEvents: sc ? Object.keys(sc.changeEvents || {}).length : -1,
    ownP1: sc ? ((sc.ownership || {})['__P1__'] || null) : '__NO_SCENARIO__',
    savePaths: (window.__savedProject || []).map(x => x && x.filePath),
    jsonLen: (window.__probe.lastProject() ? 1 : 0),
  });
})()"""


def _sub(tpl, **kw):
    out = tpl.replace('__STORE__', STORE).replace('__SM__', SM).replace('__LIB__', JS_LIB)
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


def write_report(path, before_stat, after_stat, evidence, extra_lines):
    lines = ['# 第 6 件 · 终验自测链报告', '',
             '生成时间：%s' % time.strftime('%Y-%m-%d %H:%M:%S'), '',
             '## 真实项目文件（只读，跑完逐字节核对）', '',
             '| 项 | 跑前 | 跑后 |', '|---|---|---|',
             '| size | %d | %d |' % (before_stat['size'], after_stat['size']),
             '| sha256 | `%s` | `%s` |' % (before_stat['sha256'][:16], after_stat['sha256'][:16]),
             '', '## 判据', '']
    for name, ok, detail in R:
        lines.append('- %s **%s**%s' % ('✅' if ok else '❌', name, (' — ' + str(detail)) if detail else ''))
    lines += ['', '## 证据文件', '']
    for f in evidence:
        if os.path.exists(f):
            lines.append('- `%s`（%d B）' % (os.path.relpath(f, ROOT), os.path.getsize(f)))
    if extra_lines:
        lines += ['', '## 说明', ''] + extra_lines
    with open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')


def main():
    print('=== 第 6 件 · 终验自测链（副本制 / 反向探针 / 读盘 / 三张截图）===', flush=True)
    os.makedirs(OUT_DIR, exist_ok=True)

    # ── 0. 前置 ──────────────────────────────────────────────────────────
    bak = rt.INDEX_HTML + '.bak'
    ck('前置：index.html.bak 不存在（有 = 上一轮被中断的半成品 → 不许启动）', not os.path.exists(bak), bak)
    if os.path.exists(bak):
        return 2
    busy = []
    for port in (rt.DEV_PORT, rt.CDP_PORT):
        try:
            raw = subprocess.run(['netstat', '-ano'], capture_output=True, timeout=20).stdout.decode('utf-8', 'replace')
            busy += [l.strip() for l in raw.splitlines() if (':%d' % port) in l and 'LISTENING' in l]
        except Exception:
            pass
    ck('前置：5180/9222 空闲（有回归在跑就不许启动）', not busy, busy[:4])
    if busy:
        return 2
    if not os.path.exists(REAL_PROJECT):
        ck('前置：真实项目文件存在', False, REAL_PROJECT)
        return 2
    before_stat = file_stat(REAL_PROJECT)
    print('  · 真实项目基线：size=%d mtime=%.0f sha256=%s'
          % (before_stat['size'], before_stat['mtime'], before_stat['sha256']), flush=True)

    handles, cdp = [], None
    evidence = []
    try:
        # ── 1. 副本 ─────────────────────────────────────────────────────
        print('\n1/9 注入 mock + 写真实项目副本…', flush=True)
        rt.setup_mock()
        shutil.copy(REAL_PROJECT, REAL_PROJECT_IN_MOCK)
        copy_sha = sha256(REAL_PROJECT_IN_MOCK)
        ck('副本制：副本与真实项目逐字节一致（真实文件只读）', copy_sha == before_stat['sha256'],
           '%s（%d B，sha256 前 8 位 %s）'
           % (os.path.relpath(REAL_PROJECT_IN_MOCK, ROOT), os.path.getsize(REAL_PROJECT_IN_MOCK), copy_sha[:8]))
        with open(REAL_PROJECT_IN_MOCK, encoding='utf-8') as f:
            original = json.load(f)
        snap_before = data_snapshot(original)
        # polity id → 名字（跨代查：真实数据每个剧本的 id 各不相同，标签必须去"所属代"查）
        POLITY_NAMES = {}
        for _sc in ((original.get('scenarios') or {}).get('scenarios') or {}).values():
            for _p in (_sc.get('polities') or []):
                if _p and _p.get('id'):
                    POLITY_NAMES[_p['id']] = _p.get('name')
        print('  · 基线快照：省份 %d / 剧本 %d / 底图 %s / 河 %d / 镇 %d'
              % (snap_before['provinceCount'], len(snap_before['scenarios']),
                 snap_before['baseMapKeys'], snap_before['rivers'], snap_before['burgs']), flush=True)
        ck('基线：desite 省份数 == 415', snap_before['provinceCount'] == 415, snap_before['provinceCount'])
        ck('基线：剧本数 == 13（12 段 desite + 1 段「底图 1/测试」）',
           len(snap_before['scenarios']) == 13, len(snap_before['scenarios']))

        # ── 2. 起服务 ────────────────────────────────────────────────────
        print('2/9 启动 Vite dev + Edge headless…', flush=True)
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

        print('3/9 导航 + 视口 + harness 基线项目（装 __probe 读盘钩子）…', flush=True)
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
        ck('harness 基线项目已打开（__probe 钩子就位）', hok, json.dumps(hinfo, ensure_ascii=False)[:200])

        # ── 3. 打开副本 ──────────────────────────────────────────────────
        print('4/9 打开真实项目副本（走产品自己的 openProject 链路）…', flush=True)
        iok, inj = eval_json(cdp, INJECT_JS.replace('__PATH__', MOCK_PROJECT_PATH).replace('__KEY__', KEY),
                             required=('ok', 'terrain', 'scenarioCount'), desc='注入并打开副本')
        if not iok or inj.get('error') or not inj.get('ok'):
            ck('真实项目副本打开成功', False, json.dumps(inj, ensure_ascii=False)[:400])
            return 1
        ck('openProject 成功（事实源=project，不是知识库）', inj.get('source') == 'project',
           '耗时 %sms / 事实源 %s / 底图 %s / 节点 %s'
           % (inj.get('ms'), inj.get('source'), inj.get('baseMapKeys'), inj.get('nodes')))
        ck('打开后 terrain == 415 省', inj.get('terrain') == 415, inj.get('terrain'))
        ck('打开后剧本数 == 13', inj.get('scenarioCount') == 13, inj.get('scenarioCount'))
        ck('打开的是真实项目（meta.name=绒花计划）', inj.get('metaName') == '绒花计划', inj.get('metaName'))
        ck('打开/保存路径都在副本上（真实项目没被打开）',
           inj.get('filePath') == MOCK_PROJECT_PATH, inj.get('filePath'))

        # ── 4. 进剧本 + 布置 ─────────────────────────────────────────────
        print('5/9 进剧本模式 + 布置（剧本「诸侯割据」，年份取中）…', flush=True)
        r = cdp.eval("""(() => {
          const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('历史剧本'));
          if (!b) return 'no-btn'; b.click(); return 'ok';
        })()""")
        ck('进入剧本模式（点「历史剧本」）', r == 'ok', r)
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=30, desc='ScenarioMap 挂载')
        time.sleep(1.5)
        # ⚠️ 「更多」展开会把画布压矮（实测 633 → 223px），而本演练要在画布上**真点**。
        #    所以先保持收起（切片导出那一步再展开，那时只用对话框、不看画布）。
        cdp.eval("(() => { const SM2 = %s; SM2.moreOpen = false; return 'ok'; })()" % SM)

        sok, sres = eval_json(cdp, _sub(SETUP_JS, KEY=KEY, SC=SC_PAINT),
                              required=('fails', 'notes'), desc='场景布置')
        if not sok or sres['fails']:
            ck('场景布置成功', False, json.dumps(sres, ensure_ascii=False)[:400])
            return 1
        sn = sres['notes']
        cam, cr = sn['camera'], sn['canvasRect']
        year_paint = sn['yearPaint']
        print('  · 剧本 %s 区间 %s~%s；涂色年份 %d；相机 scale=%.4f；画布 %s'
              % (SC_PAINT, sn['eraRange']['start'], sn['eraRange']['end'], year_paint,
                 cam['scale'], json.dumps({k: round(v, 1) for k, v in cr.items()})), flush=True)
        ck('游标落在目标剧本与年份', sn.get('tlEra') == sn['k'] and sn.get('tlYear') == year_paint,
           'tlEra=%s tlYear=%s' % (sn.get('tlEra'), sn.get('tlYear')))
        ck('画布高度够真点（≥400px；「更多」收起后不再被压成 223px）', cr['h'] >= 400,
           json.dumps({k: round(v, 1) for k, v in cr.items()}))

        # 候选深点（多给一些）：再按**屏幕坐标是否落在画布内**筛，最后挑 3 个彼此分得开的
        pts_all = pick_interior_points(original['scenarios']['baseMaps'][KEY]['terrain'], count=28)

        def _scr(wx, wy):
            return wx * cam['scale'] + cam['x'], wy * cam['scale'] + cam['y']

        usable_all = []
        rivers = original['scenarios']['baseMaps'][KEY].get('rivers') or []
        for (prov, wx, wy, clr) in pts_all:
            ssx, ssy = _scr(wx, wy)
            if 30 <= ssx <= cr['w'] - 30 and 30 <= ssy <= cr['h'] - 30:
                usable_all.append((prov, wx, wy, clr, ssx, ssy, river_clearance(wx, wy, rivers)))
        # 「选择」工具里河**优先于省**（既定口径）→ 优先挑离河远的点；实在不够再逐级放宽
        usable = []
        for thr in (80, 60, 40, 25, 12):
            pool = [u for u in usable_all if u[6] >= thr]
            if len(pool) >= 3:
                usable = pool
                river_gate = thr
                break
        if not usable:
            usable = usable_all
            river_gate = 0
        print('  · 画布内候选 %d 个；离河闸门取 %s 世界单位后剩 %d 个'
              % (len(usable_all), river_gate, len(usable)), flush=True)
        chosen = []
        if usable:
            # 先取屏幕上彼此最远的一对（一笔跨省才稳），再补一个离两者都远的
            import itertools
            best = max(itertools.combinations(usable, 2),
                       key=lambda ab: (ab[0][4] - ab[1][4]) ** 2 + (ab[0][5] - ab[1][5]) ** 2)
            chosen = [best[0], best[1]]
            rest = [u for u in usable if u not in chosen]
            if rest:
                chosen.append(max(rest, key=lambda u: min(
                    (u[4] - c[4]) ** 2 + (u[5] - c[5]) ** 2 for c in chosen)))
        if len(chosen) < 3:
            ck('找到 3 个落在画布内的省内深点（涂色/一笔多格/多选各用一处）', False,
               '候选中可用 %d 个（画布 %s）' % (len(usable), json.dumps({k: round(v, 1) for k, v in cr.items()})))
            return 1
        (p1, wx1, wy1, c1, sx1f, sy1f, _r1), \
            (p2, wx2, wy2, c2, sx2f, sy2f, _r2), \
            (p3, wx3, wy3, c3, sx3f, sy3f, _r3) = chosen
        print('  · 三个省内深点（含屏幕坐标）：%s(%.0f,%.0f / 离边界%.1f) / %s(%.0f,%.0f / %.1f) / %s(%.0f,%.0f / %.1f)'
              % (p1['id'], sx1f, sy1f, c1, p2['id'], sx2f, sy2f, c2, p3['id'], sx3f, sy3f, c3), flush=True)
        ck('三个点分属三个不同省', len({p1['id'], p2['id'], p3['id']}) == 3,
           [p1['id'], p2['id'], p3['id']])
        ck('P1→P2 屏幕上隔得够开（一笔跨省；≥150px）',
           ((sx1f - sx2f) ** 2 + (sy1f - sy2f) ** 2) ** 0.5 >= 150,
           '屏幕距离 %.0fpx' % (((sx1f - sx2f) ** 2 + (sy1f - sy2f) ** 2) ** 0.5))

        # 屏幕取整后反算，仍在各自省内（clientX 是 long，会截断）
        def screen_round(wx, wy):
            sx, sy = int(wx * cam['scale'] + cam['x']), int(wy * cam['scale'] + cam['y'])
            return sx, sy, (sx - cam['x']) / cam['scale'], (sy - cam['y']) / cam['scale']
        sx1, sy1, ex1, ey1 = screen_round(wx1, wy1)
        sx2, sy2, ex2, ey2 = screen_round(wx2, wy2)
        sx3, sy3, ex3, ey3 = screen_round(wx3, wy3)
        ck('取整后的三个屏幕点仍落在各自省内部',
           _inside(ex1, ey1, _rings(p1)) and _inside(ex2, ey2, _rings(p2)) and _inside(ex3, ey3, _rings(p3)),
           'P1(%.1f,%.1f) P2(%.1f,%.1f) P3(%.1f,%.1f)' % (ex1, ey1, ex2, ey2, ex3, ey3))

        # ── 5. 三步 1/3：涂归属 + 撤销重做 ──────────────────────────────
        print('6/9 三步①：油漆桶涂一个省 → 撤销/重做往返…', flush=True)
        pok, pres = eval_json(cdp, _sub(PAINT_JS, KEY=KEY, SC=SC_PAINT, TARGET=p1['id'], WX=ex1, WY=ey1),
                              required=('fails', 'notes'), desc='涂归属')
        if not pok:
            ck('涂归属探针可求值', False, pres)
            return 1
        pn = pres['notes']
        ck('① 页面内该省归属变成新势力', pn.get('ownerAfter') == (pn.get('newPolity') or {}).get('id')
           and pn.get('ownerAfter') != pn.get('ownerBefore'),
           '%s：%s(%s) → %s(%s)'
           % (p1['id'], pn.get('ownerBefore'), pn.get('ownerBeforeName'),
              pn.get('ownerAfter'), pn.get('ownerAfterName')))
        ck('② 状态栏点名这次易主', bool(pn.get('hint')) and str(p1.get('name')) in str(pn.get('hint')),
           pn.get('hint'))
        ck('③ 易主日期 = 游标日期（不另造日期）',
           _event_year(pn.get('changeEvent')) == year_paint,
           json.dumps(pn.get('changeEvent'), ensure_ascii=False))
        ck('④ Ctrl+Z 撤销 → 回到原主；Ctrl+Y 重做 → 新主（手感件④：往返）',
           pn.get('afterUndo') == pn.get('ownerBefore') and pn.get('afterRedo') == pn.get('ownerAfter'),
           'undo=%s redo=%s' % (pn.get('afterUndo'), pn.get('afterRedo')))
        ck('⑤ 选中该省时产品读到的归属 = 新势力（面板同一口径）',
           pn.get('selPolityAtPaintYear') == (pn.get('newPolity') or {}).get('name'),
           '%s ｜ diag=%s' % (pn.get('selPolityAtPaintYear'), json.dumps(pn.get('diag'), ensure_ascii=False)))
        time.sleep(2.6)                       # 等自动保存防抖
        shot1 = os.path.join(OUT_DIR, 'ui-1-after-paint.png')
        ok1, i1 = _screenshot(cdp, shot1)
        ck('截图 1（涂完归属，状态栏有回执）', ok1, i1)
        evidence.append(shot1)

        # ── 6. 手感件①②③④：一笔多格 / 吸管 / 多选 / 撤销 ──────────────
        print('7/9 手感五件：一笔多格 / 吸管 / 多选批量…', flush=True)
        bok, bres = eval_json(cdp, _sub(BRUSH_JS, KEY=KEY, SC=SC_PAINT,
                                        WX1=ex1, WY1=ey1, WX2=ex2, WY2=ey2),
                              required=('fails', 'notes'), desc='涂归属一笔多格')
        if not bok:
            ck('一笔多格探针可求值', False, bres)
            return 1
        bn = bres['notes']
        ck('手感①：一笔涂到 ≥2 个省（同一笔、同一势力）',
           len(bn.get('changed') or []) >= 2 and bool(bn.get('polity')),
           '这一笔改了 %s；势力=%s；回执=%s'
           % (bn.get('changed'), bn.get('polity'), bn.get('hint')))
        ck('手感④：这一笔**一条撤销**全部还原，重做全部回来',
           bn.get('undoRestoredAll') is True and bn.get('redoReappliedAll') is True,
           'undo=%s redo=%s / 撤销栈=%s'
           % (bn.get('undoRestoredAll'), bn.get('redoReappliedAll'), bn.get('undoStackLabel')))
        ck('（收尾）这一笔已撤销，只留 P1 一处涂色', bn.get('leftUndone') is True)

        eok, eres = eval_json(cdp, _sub(EYEDROP_JS, WX=ex1, WY=ey1),
                              required=('fails', 'notes'), desc='吸管')
        en = eres['notes'] if eok else {}
        ck('手感②：Alt+点击 = 吸管，选中该省当前势力',
           bool(en.get('picked')) and '吸管' in str(en.get('hint')),
           '%s；%s ｜ diag=%s' % (en.get('picked'), en.get('hint'), json.dumps(en.get('diag'), ensure_ascii=False)))

        mok, mres = eval_json(cdp, _sub(MULTI_JS, SC=SC_PAINT, P1=p1['id'], P3=p3['id'],
                                        WX1=ex1, WY1=ey1, WX3=ex3, WY3=ey3),
                              required=('fails', 'notes'), desc='多选批量指派')
        mn = mres['notes'] if mok else {}
        picked = mn.get('picked') or []
        after_own = mn.get('afterOwn') or {}
        ck('手感③：Ctrl+点击多选 → 批量条 → 指派落库',
           len(picked) == 2 and len(mn.get('selectedIds') or []) >= 2 and mn.get('bar')
           and all(after_own.get(pid) == pn.get('ownerAfter') for pid in picked),
           '选中 %s；批量条=%s；这批归属=%s；回执=%s；第二省=%s'
           % (mn.get('selectedIds'), mn.get('bar'), json.dumps(after_own, ensure_ascii=False),
              mn.get('hint'), mn.get('second')))
        ck('手感④：批量指派**一条撤销**回到指派前（两省都回到原值）',
           mn.get('undoBackToBefore') is True,
           '撤销后=%s' % json.dumps(mn.get('undoOwn'), ensure_ascii=False))

        # ── 7. 三步 2/3：拖时间轴 ────────────────────────────────────────
        print('8/9 三步②：真拖时间轴 → 归属与画面随年份变…', flush=True)
        tok, tres = eval_json(cdp, _sub(TIME_JS, KEY=KEY, SC=SC_PAINT, P1=p1['id'], YEARPAINT=year_paint),
                              required=('fails', 'notes'), desc='拖时间轴')
        if not tok:
            ck('时间轴探针可求值', False, tres)
            return 1
        tn = tres['notes']
        at_s, at_l, at_p = tn['atStart'], tn['atLate'], tn['atPaint']
        print('  · 起点 %s：归属=%s（%s）；末日 %s：归属=%s（%s）；涂色年 %s：归属=%s（%s）'
              % (at_s['tlYear'], at_s['owner'], at_s['polityName'],
                 at_l['tlYear'], at_l['owner'], at_l['polityName'],
                 at_p['tlYear'], at_p['owner'], at_p['polityName']), flush=True)
        ck('拖到剧本起点附近：该省**不是**新主（易主日期 404 尚未落定）',
           at_s['owner'] not in (None, pn.get('ownerAfter')),
           '%s → %s（来源代 %s）' % (at_s['owner'], at_s['polityName'], at_s.get('ownerEra')))
        ck('起点处的标签与归属一致（跨代 polity id 不通用 → 旧主去上一代查）',
           at_s['polityName'] == POLITY_NAMES.get(at_s['owner']),
           'owner=%s 标签=%s 名字表=%s'
           % (at_s['owner'], at_s['polityName'], POLITY_NAMES.get(at_s['owner'])))
        ck('拖到剧本末日附近：该省是**新主**（404 的易主已落定）',
           at_l['owner'] == pn.get('ownerAfter') and at_l['polityName'] == pn.get('ownerAfterName'),
           '%s → %s' % (at_l['owner'], at_l['polityName']))
        ck('拖回涂色年：归属与标签都回到新主（三处一致）',
           at_p['owner'] == pn.get('ownerAfter') and at_p['polityName'] == pn.get('ownerAfterName'),
           '%s → %s' % (at_p['owner'], at_p['polityName']))
        ck('画布真的随年份变（三个年份的像素指纹互不相同）',
           tn.get('distinctCanvas') == 3,
           '起点 %s / 末日 %s / 涂色年 %s'
           % (at_s['hash'], at_l['hash'], at_p['hash']))
        ck('手感⑤：标签联动（面板读到的势力名随年份改口，且每一处都与归属一致）',
           at_s['polityName'] != at_l['polityName']
           and at_l['polityName'] == pn.get('ownerAfterName')
           and at_s['polityName'] == POLITY_NAMES.get(at_s['owner']),
           '%s（%s）→ %s（%s）' % (at_s['polityName'], at_s['owner'], at_l['polityName'], at_l['owner']))
        shot2 = os.path.join(OUT_DIR, 'ui-2-after-timeline.png')
        ok2, i2 = _screenshot(cdp, shot2)
        ck('截图 2（拖完时间轴，年份与归属都变了）', ok2, i2)
        evidence.append(shot2)

        # 到这里画布证据已拍完 → 可以展开「更多」拿切片导出入口（对话框是模态，不再需要画布）
        ck('展开「更多」（切片导出入口在里面）', open_toolbar_more(cdp))
        time.sleep(0.6)

        # ── 8. 三步 3/3：切片 PNG（真实数据 + 真 UI + 真文件） ───────────
        print('9/9 三步③：切片导出（真实 1088 帧 vs 本剧本 2 帧 → 真导 PNG）…', flush=True)
        year_slice = 900                      # 落在「炎太帝国」（793~1396）
        ook, ores = eval_json(cdp, _sub(SLICE_OPEN_JS, YEAR=year_slice),
                              required=('fails', 'notes'), desc='打开切片导出')
        if not ook or ores['fails']:
            ck('切片导出对话框打开', False, json.dumps((ores or {}).get('fails'), ensure_ascii=False))
            return 1
        on = ores['notes']
        ck('拖到「炎太帝国」：当前剧本 = 该段', on.get('scenario') == SC_SLICE,
           '%s（年份 %s）' % (on.get('scenario'), on.get('tlYear')))
        ck('真实数据下**默认范围自动切到「本剧本」**（全部 1088 帧 > 上限 400）',
           on.get('scope') == 'era' and bool(on.get('autoHint')),
           '范围=%s 帧数=%s 提示=%s' % (on.get('scope'), on.get('frameCount'), on.get('autoHint')))
        ck('本剧本（炎太帝国）帧数 == 2（起点 + 唯一一次易主）',
           on.get('frameCount') == 2, on.get('frameCount'))

        aok, ares = eval_json(cdp, _sub(SLICE_SWITCH_ALL_JS),
                              required=('fails', 'notes'), desc='范围切全部/切回')
        if not aok:
            ck('切换范围探针可求值', False, str(ares)[:300])
            an = {}
        else:
            an = ares['notes']
        # ⚠️ 不写死 1088：本次刚在诸侯割据多涂了一个省（多一条易主日期），全部帧数可能 +1。
        #    判据只认"远超上限"，具体数字如实回传。
        ck('切「全部剧本」→ 帧数远超上限、超限警示出现、导出按钮灰',
           int(an.get('frameCountAll') or 0) > 400 and an.get('overLimit') and an.get('runDisabled'),
           '帧数=%s 超限=%s 按钮灰=%s 提示=%s'
           % (an.get('frameCountAll'), an.get('overLimit'), an.get('runDisabled'), an.get('overLimitText')))
        ck('切回「本剧本」→ 帧数回到 2（范围是唯一变量）',
           an.get('frameCountEra') == 2, an.get('frameCountEra'))

        rok, rres = eval_json(cdp, _sub(SLICE_RUN_JS), required=('fails', 'notes'), desc='切片 PNG 导出')
        if not rok:
            ck('切片导出探针可求值', False, str(rres)[:300])
            return 1
        if rres['fails']:
            ck('切片导出执行', False, '；'.join(rres['fails']))
            return 1
        rn = rres['notes']
        ck('真点「导出 2 帧」→ 走到 exportScenarioFrames、载荷范围 = 本剧本',
           rn.get('files') == 2 and (rn.get('scope') or {}).get('mode') == 'era'
           and (rn.get('scope') or {}).get('eraName') == '炎太帝国',
           '文件 %s；范围 %s；耗时 %sms；状态「%s」'
           % (rn.get('names'), rn.get('scope'), rn.get('waitedMs'), rn.get('status')))
        ck('状态栏明说导出了几帧、写到哪', '已导出' in str(rn.get('status')) and '帧' in str(rn.get('status')),
           rn.get('status'))
        # 取回两帧 PNG（真 dataUrl）→ 落盘 → 像素判据
        slice_paths = []
        slices_dir = os.path.join(OUT_DIR, 'slices')
        os.makedirs(slices_dir, exist_ok=True)
        for i in range(int(rn.get('files') or 0)):
            try:
                du = fetch_string(
                    cdp,
                    "((window.__FRAMES_EXPORTS__||[])[0].files[%d]||{}).dataUrl ? String(window.__FRAMES_EXPORTS__[0].files[%d].dataUrl).length : -1" % (i, i),
                    (lambda i: (lambda a, b: "String(window.__FRAMES_EXPORTS__[0].files[%d].dataUrl).slice(%d,%d)" % (i, a, b)))(i),
                    chunk=524288, desc='取回切片帧 %d 的 dataUrl' % i)
            except Exception as e:
                ck('取回第 %d 帧 dataUrl' % i, False, str(e))
                continue
            raw = png.decode_data_url(du)
            name = (rn.get('names') or [])[i] or ('frame_%04d.png' % (i + 1))
            path = os.path.join(slices_dir, name)
            with open(path, 'wb') as f:
                f.write(raw)
            slice_paths.append(path)
        ck('两帧 PNG 都能从 dataUrl 解码并落盘（真文件）', len(slice_paths) == 2,
           [os.path.basename(p) for p in slice_paths])
        if len(slice_paths) == 2:
            imgs = [png.open_png(open(p, 'rb').read()) for p in slice_paths]
            ck('每帧都是合法 PNG 且尺寸一致（= SVG 头 × 倍率 1）',
               all(im.format == 'PNG' for im in imgs) and imgs[0].size == imgs[1].size,
               '尺寸 %s / %s' % (imgs[0].size, imgs[1].size))
            ck('非空白：每帧去重颜色数 ≥ 4',
               all(png.unique_colors(im) >= 4 for im in imgs),
               [png.unique_colors(im) for im in imgs])
            diff, _ = png.diff_pixels(imgs[0], imgs[1])
            ck('两帧画面**真的不同**（同尺寸下逐像素差异 > 0）', diff > 0, '%d px 不同' % diff)
            evidence += slice_paths
            print('  · 切片帧：%s；差异 %d px'
                  % ([os.path.basename(p) for p in slice_paths], diff), flush=True)

        shot3 = os.path.join(OUT_DIR, 'ui-3-after-slice-export.png')
        ok3, i3 = _screenshot(cdp, shot3)
        ck('截图 3（切片导出后的对话框与回执）', ok3, i3)
        evidence.append(shot3)
        hashes = [sha256(p) for p in (shot1, shot2, shot3)]
        ck('三张界面截图互不相同（不是同一张复制三份）', len(set(hashes)) == 3,
           'sha256 前 8 位 %s' % [h[:8] for h in hashes])

        # ── 9. 读盘判据 + 数据不丢 + 反向探针 ────────────────────────────
        print('10/10 数据不丢：落盘载荷 → 写盘 → 从磁盘读回 → 逐省对比…', flush=True)
        time.sleep(2.4)
        cdp.eval("(async () => { await window.__probe.flushProject(); return true; })()")
        time.sleep(1.0)
        dok, disk = eval_json(cdp, DISK_JS.replace('__SC__', SC_PAINT).replace('__KEY__', KEY)
                              .replace('__P1__', p1['id']), required=('has', 'saves'), desc='落盘载荷')
        ck('读盘载荷存在（应用确实把项目交给了保存 IPC）', dok and disk.get('has'),
           '保存次数=%s 路径=%s' % (disk.get('saves'), json.dumps(disk.get('savePaths'), ensure_ascii=False)))
        ck('落盘载荷：meta=绒花计划 / 415 省 / 13 剧本 / 保存路径只在副本',
           disk.get('metaName') == '绒花计划' and disk.get('terrain') == 415
           and disk.get('scenarioCount') == 13
           and all(p == MOCK_PROJECT_PATH for p in (disk.get('savePaths') or [])),
           'meta=%s terrain=%s scenarios=%s paths=%s'
           % (disk.get('metaName'), disk.get('terrain'), disk.get('scenarioCount'),
              json.dumps(disk.get('savePaths'), ensure_ascii=False)))
        ck('落盘载荷里 P1 的归属 = 新主（这次改动确实在盘上）',
           disk.get('ownP1') == pn.get('ownerAfter'),
           '%s vs %s' % (disk.get('ownP1'), pn.get('ownerAfter')))

        # 把载荷原样写成真文件，再从磁盘读回（读盘判据）
        payload_path = os.path.join(OUT_DIR, 'roundtrip.sitian')
        try:
            payload_str = fetch_string(
                cdp,
                "window.__probe.lastProject() ? JSON.stringify(window.__probe.lastProject()).length : -1",
                lambda a, b: "JSON.stringify(window.__probe.lastProject()).slice(%d,%d)" % (a, b),
                chunk=524288, desc='分块取回落盘载荷')
            with open(payload_path, 'w', encoding='utf-8') as f:
                f.write(payload_str)
            with open(payload_path, encoding='utf-8') as f:
                payload = json.load(f)
            ck('落盘载荷写盘后可被 JSON 读回（%d B）' % len(payload_str), True,
               os.path.relpath(payload_path, ROOT))
            evidence.append(payload_path)
        except Exception as e:
            ck('落盘载荷写盘/读回', False, str(e))
            payload = None

        if payload is not None:
            snap_after = data_snapshot(payload)
            touched = {p1['id']}
            diffs = compare_snapshots(snap_before, snap_after, touched)
            ck('415 省数据不丢：逐省语义字段 + 顶点指纹 + 剧本账本计数全一致（只有 P1 多一条易主）',
               not diffs, '；'.join(diffs[:6]) if diffs else
               '省 %d / 剧本 %d / 河 %d / 镇 %d；P1 changeEvents %d → %d'
               % (snap_after['provinceCount'], len(snap_after['scenarios']),
                  snap_after['rivers'], snap_after['burgs'],
                  snap_before['scenarios'][SC_PAINT]['changes'], snap_after['scenarios'][SC_PAINT]['changes']))

            # 反向探针 1：把"碰过的省"从集合里去掉 → 必须报红
            lie = compare_snapshots(snap_before, snap_after, set())
            ck('反向探针 1：假装没改过任何省 → 判据必须报红', bool(lie),
               (lie[:2] if lie else '❌ 没报红（判据是空转的）'))
            # 反向探针 2：偷偷改一个省的 culture（在**快照**上改，模拟"数据被动过"）→ 必须报红
            dirty = copy.deepcopy(snap_after)
            for pid, fp in dirty['provinces'].items():
                if pid != p1['id']:
                    fp['keys']['culture'] = (fp['keys']['culture'] or '') + '__篡改__'
                    break
            dirty_diffs = compare_snapshots(snap_before, dirty, {p1['id']})
            ck('反向探针 2：篡改一个省的 culture → 判据必须点名', bool(dirty_diffs),
               (dirty_diffs[:2] if dirty_diffs else '❌ 没报红'))
            # 反向探针 3：省份数期望值错一个 → 必须报红
            count_lie = compare_snapshots(snap_before, snap_after, {p1['id']}, expected_provinces=414)
            ck('反向探针 3：期望省份数写成 414 → 判据必须报红', bool(count_lie),
               (count_lie[:2] if count_lie else '❌ 没报红'))
            print('  · 快照：省 %d → %d；%s changeEvents %d → %d'
                  % (snap_before['provinceCount'], snap_after['provinceCount'], SC_PAINT,
                     snap_before['scenarios'][SC_PAINT]['changes'],
                     snap_after['scenarios'][SC_PAINT]['changes']), flush=True)

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
        after_stat = file_stat(REAL_PROJECT) if os.path.exists(REAL_PROJECT) else before_stat
        same = (after_stat['sha256'] == before_stat['sha256']
                and after_stat['size'] == before_stat['size'])
        ck('真实项目文件未变（sha256/size 一致 —— 全程只读）', same,
           'size %d→%d sha %s→%s' % (before_stat['size'], after_stat['size'],
                                     before_stat['sha256'][:16], after_stat['sha256'][:16]))
        ck('index.html 已还原（无 .bak 残留）', not os.path.exists(rt.INDEX_HTML + '.bak'))
        ck('mock-data 已删除（副本随之消失；真实项目从未被打开）', not os.path.isdir(rt.MOCK_DATA_DIR))
        try:
            write_report(os.path.join(OUT_DIR, 'report.md'), before_stat, after_stat, evidence,
                         ['本演练用**副本**：真实项目只读（sha256 跑前==跑后）。',
                          '读盘判据 = 应用交给保存 IPC 的载荷 + 该载荷原样写盘/读回自洽；',
                          '真实 Electron 的磁盘链路（退出落盘/强杀）由 `drill_quit_flush.py` 另行守着。'])
        except Exception as e:
            print('  ⚠️ 写报告失败：%s' % e, flush=True)

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
