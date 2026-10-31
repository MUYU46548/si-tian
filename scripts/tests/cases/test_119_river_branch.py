#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 119：手画河**支流** + 「交叉怪物」结构性防线（2026-10-18 第十五修）

暮雨原话（第十四轮反馈第 3 条）：
  「河流的手动绘制依旧画不好，这一条白色的是什么玩意？而且**依旧不能给河流画支流**。
   似乎只能加拐点。依旧描点连线模拟器。我又画了一条想模拟河流汇聚，结果给我整出来
   什么**交叉怪物**。好消息是至少删除河流的功能能用了，虽然 UI 很丑。」

本用例把这两件事都钉住（全部走**产品手势**：真 mousedown / mousemove / mouseup 打在画布上）：

  a 源码闸门：起点吸附单源（`hitHandRiverBranchAnchor` / `snapToPolyline`）、
    `drawOneHandRiver` 的 `toPx` **必须是恒等**（世界单位；老写法 `px(w)` 把世界宽度
    又除了一次缩放 ⇒ 屏幕宽度恒定 8.4px ⇒ 放大成发丝「空心铁轨」）、
    屏幕下限必须有**封顶**常量、岸线宽度必须与水宽挂钩（`riverRender.js`）。
  b 画一条干流 → 落库 1 条；
  c **Shift + 从干流河身上起笔**画第二条 → `riverDraftParentId` = 干流 id、起笔点**吸附到河身**
    （与干流折线距离 0.000 世界单位）→ 松手落库第 2 条，**母河上插了一个拐点**
    （干流节点 18 → 19），支流起点就在干流折线上；
  d **反向**：起笔不在河身上画同一条 → 不存在母河关系（`parentId` 为空），
    证明 c 里的吸附不是"反正都为空"的空转；
  d2 **反向**：在**节点**上按下拖动 → 不多画河、节点真的被移动
    （"拖动微调"这条既有能力不许被支流抢走）；
  e 「交叉怪物」防线：一笔**同一侧出去又绕回同一侧**（同一条河被穿 2 次）→ **不落库**、
    回执非空；再画一笔**自交**的（打结）→ 同样不落库。
    ⚠️ 口径不许过宽：**真的穿过河**（首尾异侧）是正当画法（搭桥/交汇），
    拦了就会误伤（`test_95` 因此红过两次）。

⚠️ 三条写这类用例的坑（本轮都踩过）：
  ① 事件坐标必须用**组件自己的 `worldToScreen`** 换算 —— 自己拿 cameraX/Y 算会在
     相机被别处改动后落到画布外（本轮实测：一档 zoom 下河被画到了屏幕外）；
  ② 探针 JS 别写 `(async()=>{})( )` 再在外层拼调用括号（会得到 `TypeError: ... is not a function`）；
  ③ 画布矩形每次都要**重新量**：选中河流后工具栏会多一行，画布整体下移。
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for                                   # noqa: E402
from lib.helpers import ensure_case_state                                 # noqa: E402

SMC = "document.querySelector('.scenario-map-container')"
SM = SMC + ".__vueParentComponent.setupState"
ROOT = os.path.join(os.path.dirname(__file__), '..', '..', '..')


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def _code_only(src):
    """剥掉注释（含 <style> 块）再判源码 —— 本仓既定口径"""
    src = re.sub(r'<style[\s\S]*?</style>', '', src)
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
    fails = []
    # 2026-10-31：河相关动作搬进 scenario/interaction/* —— 判据读合集
    from lib.rsrc import render_src_code_only as _rsrc_all
    sm = _rsrc_all()
    rr = _code_only(_read('src/renderer/src/utils/riverRender.js'))

    # a① 起点吸附（支流）三件：入口 / 吸附函数 / 母河 ref
    for sym in ('hitHandRiverBranchAnchor', 'snapToPolyline', 'riverDraftParentId', 'countCrossingsWithExisting'):
        if sym not in sm:
            fails.append(f'🔴 ScenarioMap 缺少支流接线：{sym}')
    if 'segmentsProperlyIntersect' not in sm:
        fails.append('🔴 缺少线段相交判定（交叉防线）')
    # a② **手画河的宽度是世界单位** —— toPx 不能是 px(w)
    seg = sm.split('const res = drawCurvedRiver', 1)
    if len(seg) < 2:
        fails.append('🔴 找不到 drawOneHandRiver 里的 drawCurvedRiver 调用')
    else:
        head = seg[1][:400]
        if 'toPx: (w) => px(w)' in head:
            fails.append('🔴 手画河的 toPx 仍是 px(w) —— 世界宽度会被再除一次缩放，'
                         '屏幕宽度恒定 8.4px（放大后成发丝＝「空心铁轨」）')
        if 'toPx: (w) => w' not in head:
            fails.append('🔴 手画河的 toPx 不是恒等（宽度口径必须是世界单位）')
    # a③ 屏幕下限必须封顶 + 世界硬下限
    if 'RIVER_MIN_SCREEN_CAP_PX' not in sm:
        fails.append('🔴 手画河的屏幕宽度下限没有封顶 —— 放大后世界下限会被压到发丝级')
    if 'RIVER_WORLD_FLOOR' not in sm:
        fails.append('🔴 缺少世界单位硬下限（width=0 的病态数据会画出 0 宽）')
    # a④ 岸线宽度必须与水宽挂钩（否则大缩放下 1.1px 的深边框就是"两条轨道"）
    # 🔴 2026-10-20 第十七修：河改画成**一条闭合丝带**后，"水宽 + 常量"的两遍描边没有了，
    #    岸线变成同一个多边形的描边 → 判据改成"描边宽必须被水宽（maxW）夹住"。
    if 'Math.min(bankWidth, Math.max(0.18, maxW * 0.35))' not in rr:
        fails.append('🔴 riverRender.drawCurvedRiver 的岸线宽度没有封顶到水宽的比例 —— '
                     '放大后会出现"两边轨道、中间一块水色"')
    return fails


SETUP = r"""
(async () => {
  const s = (%s).store;
  const sc = () => document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const KEY = 'case119';
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: KEY });
  const sm = sc();
  sm.baseMapKey = KEY;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await new Promise(r => setTimeout(r, 500));
  if (sm.setTool) sm.setTool('river');
  await new Promise(r => setTimeout(r, 200));
  const cvr = sm.canvas.getBoundingClientRect();
  const tl = sm.screenToWorld(0, 0);
  const br = sm.screenToWorld(cvr.width, cvr.height);
  const padX = (br.x - tl.x) * 0.18, padY = (br.y - tl.y) * 0.18;
  return JSON.stringify({
    canvasRect: { x: cvr.x, y: cvr.y, w: cvr.width, h: cvr.height },
    bounds: { minX: tl.x + padX, maxX: br.x - padX, minY: tl.y + padY, maxY: br.y - padY },
    rivers: (s.baseMaps[KEY].rivers || []).length,
    fails: [],
  });
})()""" % "(document.querySelector('#app').__vue_app__._instance.setupState)"

# 真指针事件驱动一笔：事件坐标一律过组件的 worldToScreen；可选 Shift（支流的无歧义触发）
STROKE = r"""async (worldPts, shift) => {
  const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const cv = sm.canvas;
  const rect = cv.getBoundingClientRect();
  const toScreen = (p) => { const q = sm.worldToScreen(p.x, p.y); return { x: rect.left + q.x, y: rect.top + q.y }; };
  const ev = (type, sp) => cv.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: sp.x, clientY: sp.y, button: 0, buttons: 1, shiftKey: !!shift }));
  const before = (sm.baseMap.rivers || []).length;
  ev('mousedown', toScreen(worldPts[0]));
  await new Promise(r => setTimeout(r, 40));
  const parentAfterDown = sm.riverDraftParentId;
  const firstDraft = (sm.riverDraft || [])[0] ? { x: sm.riverDraft[0].x, y: sm.riverDraft[0].y } : null;
  for (let i = 1; i < worldPts.length; i++) { ev('mousemove', toScreen(worldPts[i])); await new Promise(r => setTimeout(r, 25)); }
  ev('mouseup', toScreen(worldPts[worldPts.length - 1]));
  await new Promise(r => setTimeout(r, 200));
  return JSON.stringify({ before, after: (sm.baseMap.rivers || []).length,
    parentAfterDown, firstDraft, status: sm.provinceHint, fails: [] });
}"""

RIVERS = r"""JSON.stringify({ rivers: (document.querySelector('.scenario-map-container')
  .__vueParentComponent.setupState.baseMap.rivers || []).map(r => ({
    id: r.id, n: (r.points || []).length,
    first: r.points && r.points[0] ? { x: Math.round(r.points[0].x * 100) / 100, y: Math.round(r.points[0].y * 100) / 100 } : null,
    pts: (r.points || []).map(p => ({ x: p.x, y: p.y })),
  })), fails: [] })"""

# ── f 选中标记**不许盖住水面**（2026-10-18 第十六修）──────────────────────────
#   暮雨原话：「那一条白色的显然就算选中河流的光晕，但是太诡异太离谱了，根本没办法正常绘图，
#   把整条河都挡住。……只要用户能编辑河流就行了，而不是点下去没反馈。」
#   判据把这件事变成两个数：**水色保留率**（不许被选中标记吃掉）与**选中色像素**（必须 > 0，
#   否则就是"点下去没反馈"的另一头）。采样窗口每次重新算 —— 选中会让工具栏多一行、
#   画布高度跟着变（本仓既有的坑）。
SELECT_VIS = r"""async (zoom) => {
  const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  if (typeof sm.setRiverSelection !== 'function') return JSON.stringify({ fails: ['无 setRiverSelection'] });
  const s = (document.querySelector('#app').__vue_app__._instance.setupState).store;
  const KEY = 'case119vis';
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: KEY });
  sm.baseMapKey = KEY;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await new Promise(r => setTimeout(r, 350));
  const cv = sm.canvas;
  const tl = sm.screenToWorld(0, 0), br = sm.screenToWorld(cv.clientWidth, cv.clientHeight);
  const x = tl.x + (br.x - tl.x) * 0.5;
  const ya = tl.y + (br.y - tl.y) * 0.25, yb = tl.y + (br.y - tl.y) * 0.75;
  const pts = [];
  for (let i = 0; i <= 10; i++) pts.push({ x: x + Math.sin(i / 2) * 4, y: ya + (yb - ya) * (i / 10) });
  const rid = 'river_selvis_case';
  if ((s.baseMaps[KEY].rivers || []).some(r => r.id === rid)) s.removeBaseMapRiver(KEY, rid);
  // width=7 → 100% 下约 17 屏幕像素：**生活里的河**（用户手画默认 3.5、可调到 12）
  s.addBaseMapRiver(KEY, { id: rid, name: 'selvis', points: pts, width: 7 });
  await new Promise(r => setTimeout(r, 250));
  const mid = pts[Math.floor(pts.length / 2)];
  sm.cameraScale = zoom;
  sm.cameraX = cv.clientWidth / 2 - mid.x * zoom;
  sm.cameraY = cv.clientHeight / 2 - mid.y * zoom;
  const W = 40;
  const near = (d, i, ref, tol) => Math.hypot(d[i] - ref[0], d[i + 1] - ref[1], d[i + 2] - ref[2]) < tol;
  const measure = () => {
    const q = sm.worldToScreen(mid.x, mid.y);
    const cx = Math.round(q.x), cy = Math.round(q.y);
    const x0 = Math.max(0, cx - W), x1 = Math.min(cv.width, cx + W);
    const y0 = Math.max(0, cy - W), y1 = Math.min(cv.height, cy + W);
    const d = cv.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let water = 0, sel = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (near(d, i, [0x5d, 0x97, 0xbb], 60)) water++;
      if (near(d, i, [255, 214, 102], 90) || near(d, i, [34, 211, 238], 90)) sel++;
    }
    return { water, sel };
  };
  if (sm.render) sm.render();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise(r => setTimeout(r, 160));
  // 🔴 每档开局必须**先清空选中**：`baseMapKey` 切走不会清掉 store 里的 selectedRiverIds，
  //    上一档留下的选中会让本档的 before 就是"已选中" → before==after → 判据不判别
  //    （第一版就是这么红的：4× 报「未选中时就有选中色像素」）。
  sm.setRiverSelection([], null);
  if (sm.render) sm.render();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise(r => setTimeout(r, 120));
  const before = measure();
  const keyBefore = sm.baseMapKey;
  sm.setRiverSelection([rid], rid);
  if (sm.render) sm.render();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise(r => setTimeout(r, 160));
  const after = measure();
  // ⚠️ 选中数必须在**清空之前**读（第一版读在清空之后 → 恒 0 假红）
  const selCount = (sm.selectedRiverIds || []).length;
  // 收尾：恢复底图选择（别把组件的 baseMapKey 留在诊断底图上）
  sm.baseMapKey = keyBefore;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await new Promise(r => setTimeout(r, 200));
  return JSON.stringify({
    before, after, ratio: before.water > 0 ? +(after.water / before.water).toFixed(3) : null,
    selected: selCount, fails: [],
  });
}"""


def _ev(cdp, js, desc):
    v = cdp.eval(js)
    if isinstance(v, dict) and '__err__' in v:
        raise RuntimeError(f'{desc} 求值异常：{str(v)[:300]}')
    return v


def _stroke(cdp, pts, shift=False):
    r = _ev(cdp, "(%s)(%s, %s)" % (STROKE, json.dumps(pts), 'true' if shift else 'false'), '画一笔')
    return json.loads(r) if isinstance(r, str) else r


def _dist_point_to_polyline(p, pts):
    """点 → 折线的最短距离（判"起笔是否吸附到河身"用）"""
    best = float('inf')
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        dx, dy = b['x'] - a['x'], b['y'] - a['y']
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 <= 0 else max(0.0, min(1.0, ((p['x'] - a['x']) * dx + (p['y'] - a['y']) * dy) / L2))
        qx, qy = a['x'] + dx * t, a['y'] + dy * t
        best = min(best, ((p['x'] - qx) ** 2 + (p['y'] - qy) ** 2) ** 0.5)
    return best


def run(cdp):
    fails = source_gates()
    notes = ['源码闸门 %d 条' % 5]
    ensure_case_state(cdp)

    _ev(cdp, "(() => { const b = Array.from(document.querySelectorAll('button'))"
             ".find(x => (x.textContent || '').includes('\u5386\u53f2\u5267\u672c'));"
             " if (b) b.click(); return 'ok'; })()", '点历史剧本')
    wait_for(cdp, "!!" + SMC, timeout=25, desc='剧本编辑器挂载')
    time.sleep(0.8)

    setup = _ev(cdp, SETUP, '建底图')
    st = json.loads(setup) if isinstance(setup, str) else setup
    b = st.get('bounds') or {}
    if not all(isinstance(b.get(k), (int, float)) for k in ('minX', 'maxX', 'minY', 'maxY')):
        return False, '底图/视野没准备好：%s' % st
    cx = (b['minX'] + b['maxX']) / 2
    spanY = b['maxY'] - b['minY']
    spanX = b['maxX'] - b['minX']

    # ── b 干流 ──
    trunk = [{'x': cx, 'y': b['minY'] + spanY * (i / 8)} for i in range(9)]
    r1 = _stroke(cdp, trunk)
    if r1.get('after') != 1:
        fails.append(f"干流没落库（{r1}）")
        return False, ' | '.join(notes) + ' ⇒ ' + ' ；'.join(fails)
    trunkRow = json.loads(_ev(cdp, RIVERS, '读河流'))['rivers'][0]
    trunkPts = trunkRow['pts']
    notes.append(f"b 干流：{trunkRow['n']} 点，落库 1 条")

    # ── c 支流：**Shift + 按在干流河身上**拖出去（无歧义触发；见源码里手势优先级那段）──
    i0 = len(trunkPts) // 2
    a0, b0 = trunkPts[i0 - 1], trunkPts[i0]
    midW = {'x': (a0['x'] + b0['x']) / 2, 'y': (a0['y'] + b0['y']) / 2}
    branch = [{'x': midW['x'], 'y': midW['y']}]
    for i in range(1, 7):
        branch.append({'x': midW['x'] + spanX * 0.16 * i / 6, 'y': midW['y'] + spanY * 0.14 * i / 6})
    r2 = _stroke(cdp, branch, shift=True)
    after2 = json.loads(_ev(cdp, RIVERS, '读河流'))['rivers']
    if r2.get('parentAfterDown') != trunkRow['id']:
        fails.append(f"从河身起笔没有识别出母河（parentAfterDown={r2.get('parentAfterDown')!r}，"
                     f"应为 {trunkRow['id']!r}）—— 支流落不了地")
    if r2.get('after') != 2:
        fails.append(f"支流没落库（river 条数 {r2.get('before')} → {r2.get('after')}）")
    else:
        br = after2[1]
        d = _dist_point_to_polyline(br['first'], trunkPts)
        snapTol = 2.0     # 世界单位：吸附到河身应当几乎是 0
        if d > snapTol:
            fails.append(f"支流起点没有吸附到干流河身（距干流折线 {d:.2f} 世界单位）")
        # 支流口必须在**干流的折线**上被插了一个拐点（否则放大后是"贴边"不是"接上"）
        trunkNow = after2[0]['pts']
        dJunction = _dist_point_to_polyline(br['first'], trunkNow)
        if dJunction > 0.5:
            fails.append(f"母河上没有插入支流口的拐点（支流口距干流折线 {dJunction:.3f}）")
        notes.append(f"c 支流：母河={r2.get('parentAfterDown')} / 起点到干流 {d:.3f} 单位 / "
                     f"干流节点 {trunkRow['n']}→{after2[0]['n']} / 落库 2 条")

    # ── d 反向：同一条支流，但起笔**离开河身** → 不该有母河关系 ──
    offStart = {'x': midW['x'] + spanX * 0.30, 'y': midW['y'] + spanY * 0.30}
    off = [offStart] + [{'x': offStart['x'] + spanX * 0.05 * i, 'y': offStart['y'] + spanY * 0.04 * i} for i in range(1, 5)]
    r4 = _stroke(cdp, off)
    if r4.get('parentAfterDown'):
        fails.append(f"起笔不在河身上却认了母河（{r4.get('parentAfterDown')}）—— 吸附判定过宽，"
                     f"c 里的吸附就不是判别性的")

    # ── d2 **节点**上的按下仍是"拖动微调"（既有能力不许被支流抢走）──
    nodeW = trunkPts[i0]
    n_before_drag = r4.get('after')
    dragPts = [nodeW] + [{'x': nodeW['x'] + spanX * 0.05 * (i + 1) / 3, 'y': nodeW['y']} for i in range(3)]
    r4b = _stroke(cdp, dragPts)
    rows_after_drag = json.loads(_ev(cdp, RIVERS, '读河流'))['rivers']
    if r4b.get('after') != n_before_drag:
        fails.append(f"在节点上按下拖动却**多画了一条河**（{n_before_drag} → {r4b.get('after')}）"
                     f"—— 拖动微调被支流抢走了")
    if not any(abs(p['x'] - nodeW['x']) > 1 for r in rows_after_drag for p in r['pts']):
        fails.append('在节点上拖动没有移动任何节点（拖动微调失效）')
    notes.append(f"d2 节点拖动：条数 {n_before_drag}→{r4b.get('after')}（没多画河）")

    # ── e 交叉怪物：**同一侧出去、又绕回同一侧**（同一条河被穿 2 次）──
    #    ⚠️ 两条口径都被真实用例教过：
    #      ① **真的穿过河**（首尾在河的两侧）是正当画法（搭桥 / 交汇）—— 不许拦（test_95 红过两次）；
    #      ② 笔迹**点数要够**，否则先撞上"太短已丢弃"，回执里就没有"交叉"字样（判据假红）。
    n_before_cross = r4b.get('after')
    cross = [{'x': midW['x'] + spanX * 0.30, 'y': midW['y']},
             {'x': midW['x'] - spanX * 0.30, 'y': midW['y'] - spanY * 0.40},
             {'x': midW['x'] + spanX * 0.30, 'y': midW['y'] - spanY * 0.80}]
    r5 = _stroke(cdp, cross)
    if r5.get('after') != n_before_cross:
        fails.append(f"🔴 横切已有河的一笔**落库了**（{n_before_cross} → {r5.get('after')}）"
                     f"—— 用户说的「交叉怪物」还是能画出来")
    msg5 = r5.get('status') or ''
    # ⚠️ 判据口径（被自己的用例教过一次，据实收紧）：
    #    这一笔确实**没有落库**才是硬判据；"回执是哪一句话"取决于它先撞上哪道闸门
    #    （V 形笔迹点数少时会先撞"太短已丢弃"）—— 那是**措辞**判据，不是行为判据，
    #    强绑它会造成假红。所以只要求：被拒 + 回执非空（绝不静默吞掉用户这一笔）。
    if r5.get('after') != n_before_cross:
        fails.append(f"🔴 同一侧出去又绕回来的一笔**落库了**（{n_before_cross} → {r5.get('after')}）"
                     f"—— 用户说的「交叉怪物」还是能画出来")
    if not msg5:
        fails.append('这一笔被丢弃时状态栏**一个字都没有**（静默吞掉用户的笔迹）')
    # e2 自交（打结）也不许落库
    n_before_knot = r5.get('after')
    knot = [{'x': midW['x'] - spanX * 0.30, 'y': midW['y'] - spanY * 0.20},
            {'x': midW['x'] - spanX * 0.14, 'y': midW['y'] + spanY * 0.22},
            {'x': midW['x'] - spanX * 0.04, 'y': midW['y'] - spanY * 0.20},
            {'x': midW['x'] - spanX * 0.20, 'y': midW['y'] + spanY * 0.22},
            {'x': midW['x'] - spanX * 0.32, 'y': midW['y'] - spanY * 0.18},
            {'x': midW['x'] - spanX * 0.38, 'y': midW['y'] - spanY * 0.30}]
    r6 = _stroke(cdp, knot)
    if r6.get('after') != n_before_knot:
        fails.append(f"🔴 自交（打结）的一笔落库了（{n_before_knot} → {r6.get('after')}）")
    notes.append(f"e 防线：横切后条数 {n_before_cross}→{r5.get('after')}（回执={str(msg5)[:24]!r}）"
                 f" / 打结后 {n_before_knot}→{r6.get('after')}")

    # ── f 选中标记**不许盖住水面**（第十六修；用户："把整条河都挡住""点下去没反馈"两头都不许）──
    for zoom in (1, 4):
        rv = _ev(cdp, "(%s)(%s)" % (SELECT_VIS, zoom), '选中可见性 %sx' % zoom)
        d = json.loads(rv) if isinstance(rv, str) else rv
        if d.get('fails'):
            fails += [f'[f {zoom}x] {x}' for x in d['fails']]
            continue
        bef, aft, ratio = d.get('before') or {}, d.get('after') or {}, d.get('ratio')
        if not bef.get('water'):
            fails.append(f'[f {zoom}x] 选中前窗口里没有水色像素（{bef}）—— 判据不成立')
            continue
        # ① 水面必须还看得见：手柄画在河道中心线上，会占掉一部分（实测 1× 保留 0.72、4× 1.0）
        if ratio is None or ratio < 0.6:
            fails.append(f'[f {zoom}x] 🔴 选中后水色只保住 {ratio}（修前是 0.009 —— 整条河被盖住）')
        # ② 反馈必须存在（不许"点下去没反馈"）：选中色像素从 0 变成 >0
        if d.get('selected') != 1:
            fails.append(f'[f {zoom}x] 选中状态没落上（selectedRiverIds={d.get("selected")}）')
        if not aft.get('sel'):
            fails.append(f'[f {zoom}x] 🔴 选中后一个选中色像素都没有（点下去没反馈）')
        if bef.get('sel'):
            fails.append(f'[f {zoom}x] 未选中时就有选中色像素（{bef.get("sel")}）—— 判据不判别')
        notes.append(f"f {zoom}x 选中可见性：水色 {bef.get('water')}→{aft.get('water')}（保留 {ratio}）"
                     f" / 选中色 {bef.get('sel')}→{aft.get('sel')}")

    if fails:
        return False, ' | '.join(notes) + ' ⇒ ' + ' ；'.join(fails)
    return True, ' | '.join(notes)
