#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 63：P1 —— 自由绘制＝默认工具 + 落笔建省（空底图可画 / 名字 / 色板轮转 / 骨架吸附 + Shift 旁路）

对应验收行（P1）：
  ① 一圈 → 1 个省（名字 / 颜色正确、1 条 undo）
  ② 空底图上也能直接画（不再需要「新建省份」）
  ③ 吸附后相邻省共享边界顶点序列完全一致（零缝）
  ④ Shift = 旁路吸附（顶点保持用户摆的位置）

手法说明（为什么要这么写）：
  * 自由绘制是**真鼠标**路径（mousedown → mousemove 采样 → mouseup 一笔成型），
    探针不能直接调内部函数（`freeTraceActive` 是组件里的普通 let）。
  * 把相机固定成 scale=1 / (0,0) → **屏幕坐标 == 世界坐标**，于是「共享边」可以直接用
    画布相对坐标构造，阈值（`SNAP_EDGE_THRESHOLD = 10` 世界单位）也换算得明明白白。
  * ④ 与 ③ 用**同一条轨迹**，只差一个 `shiftKey` —— 受控对照，失败时能直接指出是吸附还是别的问题。
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json            # noqa: E402
from lib import helpers as H                        # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def _js(cdp, src):
    """统一走 eval_json（异常 / 非 JSON / 缺 fails 字段 = 失败，绝不静默假绿）。"""
    ok, obj = eval_json(cdp, src)
    if not ok:
        return {'ERR': str(obj)[:400]}
    return obj if isinstance(obj, dict) else {'fails': [], 'notes': obj}


def _palette():
    """从**单一事实源**里取省份色板（2026-10-01 起在 `utils/scenarioPalette.js`）。

    ⚠️ 别在用例里抄一份色板，也别再回组件里找 —— 那条判据会随「单源搬家」假红
    （本仓的守卫要跟着单源的位置走，见 AGENTS.md「导出与画布同源」条目）。
    """
    import re
    src = _read('src/renderer/src/utils/scenarioPalette.js')
    i = src.index('export const PROVINCE_PALETTE = Object.freeze([')
    j = src.index(']', i)
    return re.findall(r"'(#[0-9a-fA-F]{3,8})'", src[i:j])


# ── 源码闸门（剥注释后再判：注释里写着旧实现会自己判自己）────────────────────
def _code_only(src):
    out = []
    for line in src.split('\n'):
        st = line.strip()
        if st.startswith('//') or st.startswith('*') or st.startswith('/*'):
            continue
        out.append(line)
    return '\n'.join(out)


def source_gates():
    fails, notes = [], []
    sc = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
    checks = [
        ("const tool = ref('draw')", '默认工具 = 自由绘制（P1）'),
        # 色板常量已移入 utils/scenarioPalette.js（单源）；组件这边只守「引了它、没抄一份」
        ("from '../utils/scenarioPalette'", '组件引用配色单源（不许再抄一份色板）'),
        ('nextProvinceColor(', '色板轮转函数（来自单源）'),
        ('function commitFreeTrace(pts, shiftKey)', '自由绘制受理 shiftKey'),
        ('const skeleton = shiftKey ? [] : buildSkeleton(', 'Shift = 旁路骨架吸附'),
        ('function focusNewProvince(', '新建后选中 + 名字输入聚焦'),
        ('ref="provNameInput"', '属性面板名字框可聚焦（P1 名字输入）'),
        ('kind: \'land\'', '新省默认 kind=land'),
    ]
    for needle, label in checks:
        if needle not in sc:
            fails.append(f'源码闸门缺失：{label}（找不到 `{needle}`）')
    # 单源那边必须还真的有那份色板（否则「引了单源」是假接线）
    pal = _code_only(_read('src/renderer/src/utils/scenarioPalette.js'))
    if 'export const PROVINCE_PALETTE' not in pal:
        fails.append('源码闸门缺失：配色单源里的省份色板（utils/scenarioPalette.js）')
    if "const PROVINCE_PALETTE = [" in sc:
        fails.append('ScenarioMap 又抄了一份省份色板（单源被破坏）')
    # 旧行为必须消失：新建省份不能再用「弹窗问名字」阻塞画布
    if 'prompt(' in sc.split('function commitFreeTrace')[1].split('function ')[0]:
        fails.append('自由绘制仍在用 prompt 弹窗问名字（P1 改为建完即选中 + 名字框聚焦）')
    notes.append(f'源码闸门 {len(checks)} 项' + ('全过' if not fails else '有缺'))
    # 色板必须至少 6 色（够轮转）
    pal = _palette()
    if len(pal) < 6:
        fails.append(f'色板色数 {len(pal)} < 6')
    return fails, notes, pal


DRAG = r"""
  const canvasEl = document.querySelector('.scenario-map-container canvas');
  const rr = canvasEl.getBoundingClientRect();
  const mk = (t, x, y, extra) => new MouseEvent(t, Object.assign({
    clientX: rr.left + x, clientY: rr.top + y, bubbles: true, cancelable: true, button: 0,
  }, extra || {}));
  // 折线插值拖动（每段 N 个采样点）：真实鼠标事件序列 → mousedown / mousemove… / mouseup
  const dragPath = (corners, shiftKey, per = 10) => {
    const pts = [];
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i], b = corners[(i + 1) % corners.length];
      for (let k = 0; k < per; k++) {
        const t = k / per;
        pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    canvasEl.dispatchEvent(mk('mousedown', pts[0].x, pts[0].y, shiftKey ? { shiftKey: true } : null));
    for (let i = 1; i < pts.length; i++) canvasEl.dispatchEvent(mk('mousemove', pts[i].x, pts[i].y, shiftKey ? { shiftKey: true } : null));
    const last = pts[pts.length - 1];
    canvasEl.dispatchEvent(mk('mouseup', last.x, last.y, shiftKey ? { shiftKey: true } : null));
    // 浏览器在一笔成型之后还会补一发 click —— 手动补，验证它被吞掉（不落描点顶点）
    canvasEl.dispatchEvent(mk('click', last.x, last.y));
  };
"""


def build_probe(pal):
    return f"""(() => {{
  const sc = __SC__, s = __STORE__;
  const fails = [], notes = {{}};
  const ok = (l, c, e) => {{ if (!c) fails.push(l + (e !== undefined ? ' (' + e + ')' : '')); }};
{DRAG}
  const W = canvasEl.clientWidth, H = canvasEl.clientHeight;
  notes.canvas = W + 'x' + H;

  // ── ① 默认工具 + 空底图（删掉全部底图 = 用户刚建完项目的样子）────────────
  ok('默认工具 = 自由绘制', sc.tool === 'draw', sc.tool);
  const had = Object.keys(s.baseMaps || {{}}).length;
  s.baseMaps = {{}};
  sc.baseMapKey = '';
  notes.hadBaseMaps = had;
  ok('已清空底图（构造空底图场景）', Object.keys(s.baseMaps).length === 0);

  // 相机固定成 scale=1 / (0,0) → 屏幕坐标 == 世界坐标
  sc.cameraScale = 1; sc.cameraX = 0; sc.cameraY = 0;

  const x0 = Math.round(W * 0.15), x1 = Math.round(W * 0.35);
  const y0 = Math.round(H * 0.20), y1 = Math.round(H * 0.80);
  const x2 = Math.round(W * 0.70);
  const square = [{{ x: x0, y: y0 }}, {{ x: x1, y: y0 }}, {{ x: x1, y: y1 }}, {{ x: x0, y: y1 }}];

  sc.setTool('draw');
  dragPath(square, false);

  const t1 = (sc.baseMap && sc.baseMap.terrain) || null;
  ok('② 空底图上一圈直接建省', t1 && t1.length === 1, t1 && t1.length);
  ok('空底图被自动懒建', !!sc.baseMapKey, sc.baseMapKey);
  const p1 = t1 && t1[0];
  ok('① 新省名字 = 新省份 1', p1 && p1.name === '新省份 1', p1 && p1.name);
  ok('① 新省颜色 = 色板第 1 色', p1 && p1.color === '{pal[0]}', p1 && p1.color);
  ok('新省 kind = land', p1 && p1.kind === 'land', p1 && p1.kind);
  ok('建完即选中 + 属性面板打开（名字输入）',
     !!sc.selectedProvince && p1 && sc.selectedProvince.id === p1.id && sc.showProps === true);
  ok('一笔成型后紧随的 click 被吞掉（没落描点顶点）',
     !sc.drawPoints || sc.drawPoints.length === 0, sc.drawPoints && sc.drawPoints.length);
  notes.ring1 = p1 ? p1.points.length : 0;

  // ① 1 条 undo：一圈 = 一条撤销
  s.undo();
  const tAfterUndo = (sc.baseMap && sc.baseMap.terrain) || [];
  ok('① 一圈 = 1 条 undo', tAfterUndo.length === 0, tAfterUndo.length);

  // ── ③④ 相邻省：同一条轨迹，只差 Shift（受控对照）──────────────────────
  // 先把「省 1」重新画出来（① 的 undo 已经撤掉了它）
  dragPath(square, false);
  const tBase = (sc.baseMap && sc.baseMap.terrain) || [];
  ok('③ 前置：省 1 已重建', tBase.length === 1, tBase.length);

  const d = 3;   // 轨迹整体内缩 3 世界单位：> 0（不重合）且 < 阈值 10（该被吸走）
  const offRect = [
    {{ x: x1 + d, y: y0 + d }}, {{ x: x1 + d, y: y1 - d }},
    {{ x: x2, y: y1 }}, {{ x: x2, y: y0 }},
  ];
  const key = (q) => (Math.round(q.x * 1000) / 1000) + ',' + (Math.round(q.y * 1000) / 1000);
  const sharedRun = (A, B) => {{
    const kb = new Map(); B.forEach((q, i) => {{ if (!kb.has(key(q))) kb.set(key(q), i); }});
    const hits = []; A.forEach((q, i) => {{ if (kb.has(key(q))) hits.push({{ ia: i, ib: kb.get(key(q)) }}); }});
    if (hits.length < 2) return {{ count: hits.length, contig: false, order: 'none' }};
    const runOk = (idxs, n) => {{
      const sorted = idxs.slice().sort((a, b) => a - b);
      let wraps = 0;
      for (let i = 0; i < sorted.length; i++) {{
        const nx = sorted[(i + 1) % sorted.length];
        if (((sorted[i] + 1) % n) !== nx) wraps++;
      }}
      return wraps <= 1;
    }};
    const orderOk = (() => {{
      const idx = hits.map(h => h.ib).sort((a, b) => a - b);
      const n = B.length;
      let up = 0, down = 0;
      for (let i = 0; i < idx.length - 1; i++) {{ if (((idx[i] + 1) % n) === idx[i + 1]) up++; else if (((idx[i + 1] + 1) % n) === idx[i]) down++; }}
      return up === idx.length - 1 || down === idx.length - 1;
    }})();
    return {{ count: hits.length, contig: runOk(hits.map(h => h.ia), A.length) && runOk(hits.map(h => h.ib), B.length), order: orderOk ? 'consistent' : 'mixed' }};
  }};

  // ③ 不按 Shift → 顶点被吸到相邻省边界上（共用顶点序列）
  dragPath(offRect, false);
  const t2 = (sc.baseMap && sc.baseMap.terrain) || [];
  ok('③ 第二个省已建', t2.length === 2, t2.length);
  const p2 = t2[1];
  ok('② 第二个省颜色 = 色板第 2 色（轮转）', p2 && p2.color === '{pal[1]}', p2 && p2.color);
  ok('② 第二个省名字 = 新省份 2', p2 && p2.name === '新省份 2', p2 && p2.name);
  const run = sharedRun(t2[0].points, p2 ? p2.points : []);
  notes.runNoShift = run;
  ok('③ 吸附后与相邻省共享边界顶点（零缝）', run.count >= 2, '共用 ' + run.count + ' 个顶点');
  ok('③ 共用顶点在两边都是连续的一段', run.contig === true);
  ok('③ 共用顶点顺序一致（同一段边界）', run.order === 'consistent', run.order);

  // ④ 同一条轨迹 + Shift → 不吸附（顶点保持用户摆的位置）
  s.undo();
  const tUndo2 = (sc.baseMap && sc.baseMap.terrain) || [];
  ok('④ 第二个省一条 undo 撤掉', tUndo2.length === 1, tUndo2.length);
  dragPath(offRect, true);
  const t3 = (sc.baseMap && sc.baseMap.terrain) || [];
  ok('④ Shift 后仍建了省', t3.length === 2, t3.length);
  const p3 = t3[1];
  const runShift = sharedRun(t3[0].points, p3 ? p3.points : []);
  notes.runShift = runShift;
  ok('④ Shift = 旁路吸附（不再共用顶点）', runShift.count === 0, '共用 ' + runShift.count + ' 个顶点');
  ok('④ Shift 下顶点数没有被骨架改写（无插入）',
     p3 && p3.points.length >= 3 && p3.points.length <= offRect.length * 2 + 2, p3 && p3.points.length);
  notes.ring2 = p3 ? p3.points.length : 0;

  notes.palette = (sc.PROVINCE_PALETTE || []).join(',');
  notes.terrainLens = [t1 && t1.length, tAfterUndo.length, tBase.length, t2.length, t3.length].join('/');
  notes.colors = [(p1 && p1.color), (p2 && p2.color), (p3 && p3.color)].join(' | ');
  notes.expected = ['{pal[0]}', '{pal[1]}'].join(' | ');
  return JSON.stringify({{ fails, notes }});
}})()"""


def run(cdp):
    fails = []
    sf, snotes, pal = source_gates()
    fails += sf
    notes = list(snotes)

    # 进入历史剧本（底图编辑）
    cdp.eval(
        "(() => { const b = Array.from(document.querySelectorAll('button'))"
        ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()"
    )
    try:
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式挂载')
    except RuntimeError as e:
        return False, f'剧本模式未挂载：{e}'
    time.sleep(1.5)

    res = _js(cdp, build_probe(pal).replace('__SC__', SC).replace('__STORE__', STORE))
    if 'ERR' in res:
        return False, f'P1 探针失败：{res["ERR"]}'
    fails += res.get('fails', [])
    n = res.get('notes', {})
    notes.append(
        f'P1 探针：画布 {n.get("canvas")}（原有底图 {n.get("hadBaseMaps")} 张，已清空）；'
        f'各阶段省数 {n.get("terrainLens")}；新建色 {n.get("colors")}（期望 {n.get("expected")}）；'
        f'省 1 环 {n.get("ring1")} 点；不按 Shift 共用 {n.get("runNoShift", {}).get("count")} 顶点'
        f'（连续={n.get("runNoShift", {}).get("contig")} 顺序={n.get("runNoShift", {}).get("order")}）；'
        f'按 Shift 共用 {n.get("runShift", {}).get("count")} 顶点'
    )
    return (not fails), ' | '.join(fails) if fails else ' | '.join(notes)
