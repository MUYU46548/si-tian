#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 112：河流线宽的**屏幕像素口径**（1× / 2× / 4× 实测，2026-10-17 第三轮）

来历：暮雨实测「选中的河太粗太离谱（放大 4 倍时成了大白虫）」。上一轮把高亮的**增量**
从世界单位 +8 改成屏幕像素 `px(3.5)` —— 但只改了一半：
`baseW = basemapRiverWidthPx(r)` 仍把「屏幕像素数」直接当**世界单位**用（画布此处已
`scale(cameraScale)`），于是高亮在 4× 下仍是 18~19px。同一处 `drawRivers`（地图自带河）
也一直是这么写的，注释却写着「不随缩放变粗」——**注释与实现相反**。

本用例用**像素**判据把它钉死（源码闸门 + 三档实测）：
  a 源码闸门：自带河与高亮的线宽都必须过世界单位换算；自动河侧的换算不许退回。
  b 自带河（未选中）：河色像素的横截面宽度在 1× 与 4× 下应基本相等。
  c 选中高亮：亮芯像素宽度 + 「选中 vs 未选中」差异像素宽度，三档都应基本相等。
  d 反证：把线宽换回世界单位口径时（探针内直接改像素？做不到）→ 这里改为**判据自检**：
    用 4× 下"理论世界单位宽度"算一遍，若它落在实测值附近，说明这条判据抓得住那个 bug。

用法：python scripts/tests/run_tests.py test_112
"""
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from lib.cdp import eval_json, wait_for      # noqa: E402
from lib.helpers import ensure_case_state, open_test_base_map  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SMV = os.path.join(ROOT, 'src', 'renderer', 'src', 'components', 'ScenarioMap.vue')
RRJ = os.path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'riverRender.js')
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"


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


def _read(path):
    with open(path, encoding='utf-8') as f:
        return _code_only(f.read())


def source_gates():
    fails = []
    # 2026-10-31：河流绘制体搬进 scenario/layers/features.js —— 判据把那份源码一起读
    sm = _read(SMV) + '\n' + _read(os.path.join(ROOT, 'src', 'renderer', 'src', 'scenario', 'layers', 'features.js'))
    rr = _read(RRJ)
    # a① 自带河：宽度必须过世界单位换算（不许再直接塞屏幕像素数）
    # 🔴 2026-10-20 第十七修：自带河也改走 `drawCurvedRiver` 丝带，不再自己写字面
    #    `c.lineWidth = ...` —— 判据改成"真的调用了那个换算函数"（换算口径单源）。
    if 'basemapRiverWidthWorld(r, cameraScale.value)' not in sm and 'basemapRiverWidthWorld(r, view.cameraScale)' not in sm:
        fails.append('🔴 drawRivers 没把自带河线宽换算成世界单位 —— 放大后自带河会跟着变粗'
                     '（实测 1× 8px → 4× 19px）')
    # 反证：旧的错写法不许回来
    if 'c.lineWidth = basemapRiverWidthPx(r);' in sm:
        fails.append('🔴 又出现 `c.lineWidth = basemapRiverWidthPx(r)` —— 屏幕像素数当世界单位用')
    # a② 高亮：baseW 也必须是世界单位，且增量仍是 px() 屏幕像素口径
    i = sm.find('function drawSelectedRiverHighlightLayer')
    seg = sm[i:] if i >= 0 else ''
    end = seg.find('\n}\n')          # 只取**本函数**的函数体（否则会连上下一个函数里的 lineWidth）
    if end > 0:
        seg = seg[:end]
    # 🔴 增量必须是屏幕像素口径：**每一条 lineWidth 的取值来源都要经过 `px()`**
    #    （2026-10-17 第五轮多选高亮后，写法变成 `baseW + px(isPrimary ? 3.5 : 2.6)`；
    #     2026-10-18 第十六修后又变成 `const weightWorld = px(RIVER_SEL_WEIGHT_PX); c.lineWidth = weightWorld;`
    #       —— 判据不能在字面上找 `px(3.5)`、也不能要求 `px(` 出现在**赋值那一行**，
    #       否则合法写法一改就假红。口径是"**有没有裸数值线宽**"：RHS 既不是字面数字，
    #       又能在本函数里查到它是 `px(...)` 的结果，就算合规）。
    if 'basemapRiverWidthWorld(r, cameraScale.value)' not in seg and 'basemapRiverWidthWorld(r, view.cameraScale)' not in seg:
        fails.append('🔴 选中高亮的 baseW 不是世界单位（高亮会随缩放变粗 —— 暮雨二测的"太粗"）')
    widths = [ln.strip() for ln in seg.split('\n') if 'lineWidth =' in ln]
    pxVars = set()
    for ln in seg.split('\n'):
        # 2026-10-31：绘制体搬进 layers 后形参化成 `view.px(...)` —— 同一条口径，两种写法都认
        m = re.match(r'\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:view\.)?px\(', ln)
        if m:
            pxVars.add(m.group(1))
    def _is_bare(ln):
        if 'px(' in ln:
            return False
        m = re.search(r'lineWidth\s*=\s*([A-Za-z_$][\w$]*)\s*;', ln)
        if m and m.group(1) in pxVars:
            return False
        # `baseW + …` 这类：基宽是世界单位（上面已单独判过），增量必须已知过 px()
        if re.search(r'lineWidth\s*=\s*[^;]*\+\s*[A-Za-z_$][\w$]*\s*;', ln):
            rhs = ln.split('=', 1)[1]
            inc = re.findall(r'\+\s*([A-Za-z_$][\w$]*)', rhs)
            if inc and all(v in pxVars for v in inc):
                return False
        return True
    bare = [ln for ln in widths if _is_bare(ln)]
    if not widths:
        fails.append('🔴 选中高亮里一条 lineWidth 都没找到（判据失效，需同步本用例）')
    elif bare:
        fails.append('🔴 选中高亮有裸数值线宽（没走 px() 屏幕像素口径，放大后会变粗）：'
                     + ' / '.join(bare[:3]))
    # a③ 自动河侧第八修的换算不许退回（同一能力两个消费者，别只修一边）
    if 'const pxToWorld = 1 / Math.max(1e-6, cameraScale.value || 1);' not in sm:
        fails.append('🔴 自动河网的屏幕像素→世界单位换算没了（第八修的修正被退回）')
    # a④ 纯函数层的换算本身在场（口径单源）
    if 'export function basemapRiverWidthWorld(' not in rr:
        fails.append('🔴 riverRender 里没有 basemapRiverWidthWorld（口径单源）')
    return fails


# 造一张干净底图（纯色陆地）+ 一条宽 1 的河，然后把相机摆到河中点
JS_SETUP = r"""
(async () => {
  const s = __STORE__;
  const el = document.querySelector('.scenario-map-container');
  if (!el) return JSON.stringify({ err: '剧本编辑器没挂载' });
  const sm = el.__vueParentComponent.setupState;
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 80));
  const KEY = 'case112';
  const GX0 = -1200, GY0 = -800, W = 3000, H = 2000;
  const prov = { id: 'land1', name: '陆地', kind: 'land', color: '#7d8a5a',
    points: [{x:GX0,y:GY0},{x:GX0+W,y:GY0},{x:GX0+W,y:GY0+H},{x:GX0,y:GY0+H}] };
  s.baseMaps = { ...s.baseMaps, [KEY]: { id: KEY, name: KEY, terrain: [prov], referenceImages: [],
    rivers: [], routes: [], burgs: [] } };
  sm.baseMapKey = KEY;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await tick(400);
  const rv = { id: 'rv_case112', name: '高亮河', width: 1,
    points: Array.from({ length: 24 }, (_, k) => ({
      x: GX0 + 300 + k * 90, y: GY0 + 900 + Math.sin(k / 2.2) * 120 })) };
  s.baseMaps[KEY].rivers = [rv];
  sm.setTool('select');
  sm.showMinimap = false;
  sm.autoRivers = []; sm.autoRiverSegments = [];
  sm.showRivers = true;
  sm.rasterLayer = 'none';
  sm.selectedRiverId = '';
  await tick(250);
  const cvs = sm.canvas;
  const rc = cvs.getBoundingClientRect();
  const mid = rv.points[12];
  const aim = (scale) => {
    sm.cameraScale = scale;
    sm.cameraX = rc.width / 2 - mid.x * scale;
    sm.cameraY = rc.height / 2 - mid.y * scale;
    sm.render();
  };
  aim(1);
  await tick(250);
  // 渲染用的曲线（与 drawRivers 的 subdiv 一致）—— 量宽度时要在**这条线**上取横截面
  const RR0 = await import('/src/utils/riverRender.js');
  const curve = RR0.catmullRomPoints(rv.points.map((p) => ({ x: p.x, y: p.y })), 2);
  window.__C112 = { sm, rv, cvs, rc, mid, aim, tick, curve };
  return JSON.stringify({ ok: true, canvas: [Math.round(rc.width), Math.round(rc.height)],
    riverWidthPx: RR0.basemapRiverWidthPx(rv), curvePoints: curve.length });
})()
"""

# 未选中：量"河色像素"的横截面宽度（自带河本身，不许随缩放变粗）
JS_RIVER_WIDTH = r"""
(async () => {
  const C = window.__C112, sm = C.sm, cvs = C.cvs, rc = C.rc, rv = C.rv;
  const tick = C.tick;
  const ctx = cvs.getContext('2d');
  const dpr = cvs.width / rc.width;
  const isRiver = (d) => Math.abs(d[2] - 187) < 45 && Math.abs(d[1] - 151) < 45 && Math.abs(d[0] - 93) < 45
    && d[2] > d[1] && d[1] > d[0];
  const widthAt = (wx, wy, nx, ny) => {
    const sx = sm.cameraX + wx * sm.cameraScale, sy = sm.cameraY + wy * sm.cameraScale;
    let n = 0;
    for (let t = -30; t <= 30; t += 1) {
      const X = Math.round((sx + nx * t) * dpr), Y = Math.round((sy + ny * t) * dpr);
      if (X < 0 || Y < 0 || X >= cvs.width || Y >= cvs.height) continue;
      if (isRiver(ctx.getImageData(X, Y, 1, 1).data)) n += 1;
    }
    return n;
  };
  const out = {};
  for (const scale of [1, 2, 4]) {
    C.aim(scale);
    await tick(300);
    // 🔴 2026-10-20 第十七修：自带河现在也过 Catmull-Rom 平滑 + 丝带填充 ——
    //    拿**原始折线**的中点去量，在锐弯处会偏离实际画的曲线（放大后更明显）。
    //    这里改成量**渲染用的那条曲线**（与 drawRivers 同一 subdiv=2），
    //    并且只取**当前视口内**的采样点 —— 放大后曲线大半在画布外，
    //    把"画布外"当成"量不到 0 像素"是假的红（实测 4× 有 4/5 个点在画布外）。
    const CURVE = C.curve;
    const inView = [];
    for (let i = 0; i + 1 < CURVE.length; i++) {
      const a = CURVE[i], b = CURVE[i + 1];
      const sx = sm.cameraX + ((a.x + b.x) / 2) * sm.cameraScale;
      const sy = sm.cameraY + ((a.y + b.y) / 2) * sm.cameraScale;
      if (sx < 40 || sy < 40 || sx > rc.width - 40 || sy > rc.height - 40) continue;
      inView.push(i);
    }
    const picks = [];
    if (inView.length >= 3) {
      for (let k = 0; k < 5; k++) picks.push(inView[Math.floor((inView.length - 1) * k / 4)]);
    }
    const ws = picks.map((i) => {
      const a = CURVE[i], b = CURVE[i + 1];
      const tx = b.x - a.x, ty = b.y - a.y;
      const L = Math.hypot(tx, ty) || 1;
      return widthAt((a.x + b.x) / 2, (a.y + b.y) / 2, -ty / L, tx / L);
    });
    const sorted = ws.slice().sort((x, y) => x - y);
    out['scale' + scale] = { samples: ws, picks, inView: inView.length,
      median: ws.length ? sorted[Math.floor(sorted.length / 2)] : -1,
      echo: sm.cameraScale };
  }
  return JSON.stringify(out);
})()
"""

# 选中后：亮芯像素宽度 + 「选中 vs 未选中」差异宽度
JS_HIGHLIGHT = r"""
(async () => {
  const C = window.__C112, sm = C.sm, cvs = C.cvs, rc = C.rc, rv = C.rv;
  const tick = C.tick;
  const ctx = cvs.getContext('2d');
  const dpr = cvs.width / rc.width;
  // 真鼠标 mousedown（选择工具下按下就判河 —— 第八修三修的口径）
  C.aim(1);
  await tick(300);
  const mid = C.mid;
  const px0 = { x: sm.cameraX + mid.x * sm.cameraScale, y: sm.cameraY + mid.y * sm.cameraScale };
  const mk = (t) => new MouseEvent(t, { clientX: rc.left + px0.x, clientY: rc.top + px0.y,
    button: 0, buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true });
  cvs.dispatchEvent(mk('mousedown'));
  await tick(120);
  cvs.dispatchEvent(mk('mouseup'));
  await tick(200);
  const out = { selected: sm.selectedRiverId, selectedByRealMouse: sm.selectedRiverId === 'rv_case112' };
  if (!out.selectedByRealMouse) return JSON.stringify(out);
  // 🔴 2026-10-18 第十六修：选中标记**不再是"暖白亮芯"** —— 暮雨原话「那一条白色的……把整条河都挡住，
  //    根本没办法正常绘图」。现在标记是**河两侧的暖金/冷青轮廓 + 白/金/青手柄**，水面一个像素不碰。
  //    所以判据必须按**色相**认标记（金 255,214,102 / 青 34,211,238 / 手柄白 248,250,252），
  //    不能再找"亮芯"（那个东西已经被刻意删掉了）。
  const isSel = (d) => {
    const gold = Math.hypot(d[0] - 255, d[1] - 214, d[2] - 102) < 110;
    const cyan = Math.hypot(d[0] - 34, d[1] - 211, d[2] - 238) < 110;
    const white = d[0] >= 225 && d[1] >= 230 && d[2] >= 235;
    return gold || cyan || white;
  };
  const scan = (wx, wy, nx, ny) => {
    const sx = sm.cameraX + wx * sm.cameraScale, sy = sm.cameraY + wy * sm.cameraScale;
    const at = [];
    for (let t = -26; t <= 26; t += 1) {
      at.push([Math.round((sx + nx * t) * dpr), Math.round((sy + ny * t) * dpr)]);
    }
    const grab = () => at.map(([X, Y]) => {
      if (X < 0 || Y < 0 || X >= cvs.width || Y >= cvs.height) return null;
      const d = ctx.getImageData(X, Y, 1, 1).data; return [d[0], d[1], d[2]];
    });
    sm.selectedRiverId = 'rv_case112'; sm.render();
    const on = grab();
    const core = on.filter((d) => d && isSel(d)).length;
    sm.selectedRiverId = ''; sm.render();
    const off = grab();
    sm.selectedRiverId = 'rv_case112'; sm.render();
    let diff = 0;
    for (let i = 0; i < at.length; i++) {
      if (!on[i] || !off[i]) continue;
      const d = Math.abs(on[i][0] - off[i][0]) + Math.abs(on[i][1] - off[i][1]) + Math.abs(on[i][2] - off[i][2]);
      if (d > 10) diff += 1;
    }
    // 水面可读性：选中前后**水色**像素数（选中标记不许把水盖住 —— 第十六修的核心）
    const isWater = (d) => d && Math.hypot(d[0] - 0x5d, d[1] - 0x97, d[2] - 0xbb) < 60;
    sm.selectedRiverId = 'rv_case112'; sm.render();
    const onWater = grab().filter(isWater).length;
    sm.selectedRiverId = ''; sm.render();
    const offWater = grab().filter(isWater).length;
    sm.selectedRiverId = 'rv_case112'; sm.render();
    return { core, diff, onWater, offWater };
  };
  for (const scale of [1, 2, 4]) {
    C.aim(scale);
    await tick(320);
    const cores = [], diffs = [], wsOn = [], wsOff = [];
    for (const i of [10, 11, 12, 13, 14]) {
      const a = rv.points[i], b = rv.points[i + 1];
      const tx = b.x - a.x, ty = b.y - a.y;
      const L = Math.hypot(tx, ty) || 1;
      const r = scan((a.x + b.x) / 2, (a.y + b.y) / 2, -ty / L, tx / L);
      cores.push(r.core); diffs.push(r.diff);
      if (Number.isFinite(r.onWater)) wsOn.push(r.onWater);
      if (Number.isFinite(r.offWater)) wsOff.push(r.offWater);
    }
    const md = (arr) => arr.slice().sort((x, y) => x - y)[Math.floor(arr.length / 2)];
    const sum = (arr) => arr.reduce((a, b) => a + b, 0);
    out['scale' + scale] = { core: cores, coreMedian: md(cores), diff: diffs, diffMedian: md(diffs),
      waterOn: sum(wsOn), waterOff: sum(wsOff),
      waterRatio: sum(wsOff) > 0 ? +(sum(wsOn) / sum(wsOff)).toFixed(3) : null,
      echo: sm.cameraScale };
  }
  return JSON.stringify(out);
})()
"""


def _ev(cdp, js, desc):
    ok, obj = eval_json(cdp, js.replace('__STORE__', STORE), required=None, desc=desc)
    if ok:
        return obj
    return {'__err__': str(obj)}


def _viewport(cdp):
    try:
        cdp.send('Emulation.setDeviceMetricsOverride',
                 {'width': 1280, 'height': 800, 'deviceScaleFactor': 1, 'mobile': False})
    except Exception:
        pass


def run(cdp):
    fails = source_gates()
    notes = []
    ensure_case_state(cdp)
    _viewport(cdp)
    eval_json(cdp, "(() => { const b = Array.from(document.querySelectorAll('button'))"
                   ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()",
              required=None, desc='进剧本模式')
    try:
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式挂载')
    except Exception:
        return False, '剧本模式没挂载；' + ' | '.join(fails)
    time.sleep(1.2)
    ok, info = open_test_base_map(cdp, key='用例底图')
    if not ok:
        notes.append(f'（底图 fixture：{info}）')

    setup = _ev(cdp, JS_SETUP, '造底图 + 河')
    if not isinstance(setup, dict) or setup.get('err') or setup.get('__err__'):
        return False, f'造数据失败：{setup} ‖ ' + ' | '.join(fails)

    # ── b 自带河（未选中）不许随缩放变粗 ──
    rw = _ev(cdp, JS_RIVER_WIDTH, '自带河线宽三档')
    if not isinstance(rw, dict) or rw.get('__err__'):
        fails.append(f'🔴 自带河线宽求值失败：{rw}')
    else:
        m = {k: (rw.get(k) or {}).get('median') for k in ('scale1', 'scale2', 'scale4')}
        notes.append(f"自带河横截面（像素）：1×={m['scale1']} 2×={m['scale2']} 4×={m['scale4']}")
        if not all(isinstance(v, int) and v > 0 for v in m.values()):
            fails.append(f'🔴 自带河在某个缩放下量不到像素（{m}）—— 判据失效或河没画出来')
        else:
            if m['scale4'] > m['scale1'] * 1.6:
                fails.append(f"🔴 自带河随缩放变粗：1× {m['scale1']}px → 4× {m['scale4']}px"
                             '（屏幕像素口径应基本相等；世界单位口径会 ~4 倍）')
            if m['scale1'] > 12 or m['scale4'] > 12:
                fails.append(f'🔴 自带河过粗（1×{m["scale1"]} / 4×{m["scale4"]}px，'
                             '自带河实测应 ~0.7px、本用例 width=1 → 3.6px）')

    # ── c 选中高亮：亮芯 + 差异宽度三档应基本相等 ──
    hl = _ev(cdp, JS_HIGHLIGHT, '选中高亮三档')
    if not isinstance(hl, dict) or hl.get('__err__'):
        fails.append(f'🔴 高亮求值失败：{hl}')
    else:
        if not hl.get('selectedByRealMouse'):
            fails.append(f"🔴 真鼠标按下没选中河（selected={hl.get('selected')}）—— 判据失效")
        else:
            core = {k: (hl.get(k) or {}).get('coreMedian') for k in ('scale1', 'scale2', 'scale4')}
            diff = {k: (hl.get(k) or {}).get('diffMedian') for k in ('scale1', 'scale2', 'scale4')}
            wr = {k: (hl.get(k) or {}).get('waterRatio') for k in ('scale1', 'scale2', 'scale4')}
            notes.append(f"选中标记像素宽（按色相认）：1×={core['scale1']} 2×={core['scale2']} 4×={core['scale4']}px"
                         f"；选中 vs 未选中 差异宽度：1×={diff['scale1']} 2×={diff['scale2']} 4×={diff['scale4']}px"
                         f"；水面保留率：{wr}")
            # 🔴 第十六修：判据从"亮芯宽度"改成"**标记必须看得见** + **水面仍可读**"。
            #    旧判据找的是"暖白亮芯"—— 那正是暮雨说"把整条河都挡住"的那个东西，已刻意删除，
            #    再判它就是在判"退回到被投诉的形态"。
            #    ⚠️ "水面可读"的门槛**随河宽而变**：这条用例的河只有 **3.6 屏幕像素**宽，
            #       而选中标记的最小可用宽度是"两侧各 1.4px 线 + 各 1px 空隙"≈ 5px ——
            #       几何上就注定要占掉一部分（实测保留率 0.42~0.47；修前那个把整条盖住的形态是 **0.009**，
            #       差了 50 倍，判别看的是这个量级差，不是 0.6 这个拍出来的数）。
            #       宽河（test_119 f 段，width=7）实测保留 **0.72~0.82**。
            if not all(isinstance(v, int) and v > 0 for v in core.values()):
                fails.append(f'🔴 选中标记在某个缩放下一个像素都量不到（{core}）—— 点下去没反馈')
            if all(isinstance(v, (int, float)) for v in wr.values()):
                for k, v in wr.items():
                    if v < 0.35:
                        fails.append(f'🔴 {k} 下选中标记把水面盖住了（水色保留率 {v}）—— '
                                     f'第十六修前的形态是 0.009，宽河应 ≥0.6')
                # 反向对照：至少有一档（这里指最宽的那档）必须明显更好，否则"随河宽收窄"没生效
                if wr.get('scale1') is not None and wr['scale1'] < 0.35:
                    fails.append(f"🔴 细河上标记仍几乎盖住水面（{wr['scale1']}）")
            if all(isinstance(v, int) and v > 0 for v in diff.values()):
                if diff['scale4'] > diff['scale1'] * 1.7:
                    fails.append(f"🔴 选中标记随缩放变粗：1× {diff['scale1']}px → 4× {diff['scale4']}px"
                                 '（世界单位口径会 ~4 倍）')
                if diff['scale4'] > 16:
                    fails.append(f"🔴 4× 下选中标记总宽 {diff['scale4']}px 过粗（应 ≈8px）")

    notes.append(f"自带河基准 {setup.get('riverWidthPx')}px（产品公式，width=1）")
    if fails:
        return False, ' | '.join(fails) + ' ‖ ' + ' + '.join(notes)
    return True, ' + '.join(notes)
