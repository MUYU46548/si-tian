#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 166：地形参数面板的**版面**与盐湖着色（真机；2026-11-08）

为什么要有这一条（今天真实踩到）：
- 我给面板加了两个 6 字标签（河源海拔门槛 / 成河汇水面积），而 `.tgen-row` 的标签列是
  **固定 64px** → 最后两个字被滑杆压住。`test_151` 的 DOM 判据只查“标签文本存在、控件是滑杆”，
  **查不出重叠**；单元测试更查不到。只有截图才看得见。
- 顺手把 int 类字段的显示从 `0.0` 改成 `0`（侵蚀轮数是 0/1/2…，写成小数读起来像滑杆）。

判据（全部真机 DOM / canvas，不看源码）：
  a 面板打得开、14 行（10 个旧参数 + 河网阈值 2 + 侵蚀 2）
  b **标签不许被控件压住**（label 右边界 ≤ 控件左边界；两条 6 字标签就是这条抓出来的）
  c 面板完整在视口内、应用按钮够得着（1280×800 与 1024×720 两个尺寸）
  d int 字段显示成整数（不许 `0.0`）
  e 盐湖 vs 淡水湖：同一批湖格，`saline` 一标，渲染色必须不同（否则“分档”等于没做）

产物：`build/terrain-panel-visual/*.png`（面板 1280 / 面板 1024 / 盐湖对照）；已 gitignore。
"""
import base64
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for   # noqa: E402
from lib.helpers import ensure_case_state   # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
OUT = os.path.join(ROOT, 'build', 'terrain-panel-visual')
os.makedirs(OUT, exist_ok=True)

APP = "document.querySelector('#app').__vue_app__"
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = APP + "._instance.setupState.store"


def _j(raw, label):
    try:
        return json.loads(raw)
    except Exception:
        raise AssertionError(f'{label} 读取失败：{str(raw)[:300]}')


def shot(cdp, name):
    """截屏并**自检不是空白**（headless 下 fromSurface:false 会拍出全白，今天踩过）。"""
    p = os.path.join(OUT, name)
    try:
        from PIL import Image, ImageStat
    except Exception:
        Image = None
    for params in ({'format': 'png'}, {'format': 'png', 'fromSurface': False}):
        try:
            raw = cdp.send('Page.captureScreenshot', params)
        except Exception:
            continue
        data = raw.get('data') if isinstance(raw, dict) else None
        if not data:
            continue
        with open(p, 'wb') as f:
            f.write(base64.b64decode(data))
        if Image is None:
            return p
        try:
            sd = ImageStat.Stat(Image.open(p).convert('L')).stddev[0]
        except Exception:
            return p
        if sd > 4:
            return p
    return None


JS_OPEN = r""" (async () => {
  const s = __STORE__, sm = __SC__;
  const K = 'case166_land';
  const mkRing = (cx, cy, r, n, wobble, seed) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const w = 1 + Math.sin(a * 3 + seed) * wobble + Math.sin(a * 7 + seed * 2) * wobble * 0.5;
      pts.push({ x: cx + Math.cos(a) * r * w, y: cy + Math.sin(a) * r * w * 0.72 });
    }
    return pts;
  };
  const land = { id: 'p1', name: 'A', kind: 'land', color: '#c9a06a', points: mkRing(0, 0, 900, 90, 0.16, 1.2) };
  s.baseMaps = { ...s.baseMaps, [K]: { id: K, name: K, terrain: [land], referenceImages: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } };
  sm.baseMapKey = K;
  if (typeof sm.onBaseMapChange === 'function') sm.onBaseMapChange();
  await new Promise(r => setTimeout(r, 360));
  const t = document.querySelector('.more-toggle');
  if (t) t.click();
  await new Promise(r => setTimeout(r, 160));
  const b = document.querySelector('[data-testid="basemap-terrain-params"]');
  if (!b) return JSON.stringify({ hasBtn: false });
  b.click();
  await new Promise(r => setTimeout(r, 420));
  return JSON.stringify({ hasBtn: true });
})() """.replace('__STORE__', STORE).replace('__SC__', SC)

JS_MEASURE = r""" (() => {
  const panel = document.querySelector('[data-testid="terrain-gen-panel"]');
  if (!panel) return JSON.stringify({ panelOpen: false });
  const r = panel.getBoundingClientRect();
  const applyBtn = panel.querySelector('[data-testid="tgen-apply"]');
  const ar = applyBtn ? applyBtn.getBoundingClientRect() : null;
  const rows = Array.from(panel.querySelectorAll('.tgen-row')).map((row) => {
    const lab = row.querySelector('label');
    const inp = row.querySelector('input, select');
    const val = row.querySelector('.tgen-val');
    if (!lab || !inp) return null;
    const lr = lab.getBoundingClientRect(), ir = inp.getBoundingClientRect();
    return {
      label: (lab.textContent || '').trim(),
      value: val ? (val.textContent || '').trim() : null,
      labelRight: Math.round(lr.right),
      inputLeft: Math.round(ir.left),
      overlap: Math.round(lr.right - ir.left),
      // 🔴 关键尺子：`white-space: nowrap` 的标签**会溢出自己的格子**（盒子宽度被列宽夹住，
      //    文字画在盒子外面 → 压到滑杆上）。所以量 box 重叠是量不到的（第一次就这么假绿），
      //    必须量 **scrollWidth > clientWidth** —— 与行星坞“文字有没有被裁”同一条尺子。
      textClipped: Math.round(lab.scrollWidth - lab.clientWidth),
    };
  }).filter(Boolean);
  return JSON.stringify({
    panelOpen: true,
    rows: rows.length,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    vp: { w: innerWidth, h: innerHeight },
    overflowsViewport: (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth),
    applyInViewport: ar ? (ar.top >= 0 && ar.bottom <= innerHeight) : null,
    overlapping: rows.filter((x) => x.overlap > 0),
    clipped: rows.filter((x) => (x.textClipped || 0) > 1),
    intRows: rows.filter((x) => /轮数|河口|数量/.test(x.label)),
  });
})() """

JS_SALT = r""" (async () => {
  const R = await import('/src/utils/heightmapRaster.js');
  const cols = 46, rows = 26, spacing = 20;
  const pts = [], h = [], prec = [], temp = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      pts.push([i * spacing, j * spacing]);
      h.push(30 + Math.round((18 + 10 * Math.sin(i / 5) * Math.cos(j / 4)) * 100) / 100);
      prec.push(45); temp.push(10);
    }
  }
  const lakeCells = [];
  for (let j = 9; j < 17; j++) for (let i = 16; i < 28; i++) lakeCells.push(j * cols + i);
  const mk = (saline) => ({ h: h.slice(), grid: { points: pts, cellsX: cols, cellsY: rows, spacing }, prec, temp,
    lakes: [saline ? { level: 40, cells: lakeCells.slice(), saline: true, meanPrec: 8 }
      : { level: 40, cells: lakeCells.slice() }] });
  const fresh = R.buildHeightmapRaster(mk(false), 'height', { shade: 1 });
  const salt = R.buildHeightmapRaster(mk(true), 'height', { shade: 1 });
  if (!fresh || !salt) return JSON.stringify({ ok: false });
  // 逐像素比两张栅格：盐湖必须真的被画成另一种颜色
  const cf = fresh.canvas, cs = salt.canvas;
  const df = cf.getContext('2d').getImageData(0, 0, cf.width, cf.height).data;
  const ds = cs.getContext('2d').getImageData(0, 0, cs.width, cs.height).data;
  let diff = 0;
  for (let i = 0; i < Math.min(df.length, ds.length); i += 4) {
    if (df[i] !== ds[i] || df[i + 1] !== ds[i + 1] || df[i + 2] !== ds[i + 2]) diff++;
  }
  // 摆到页面上拍一张（固定 420 宽 ×2 并排，别把视口撑爆）
  const draw = (r, label) => {
    const c = r.canvas, tw = 420, sc = Math.max(1, tw / c.width);
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:inline-block;margin:0 10px;vertical-align:top;';
    const cap = document.createElement('div');
    cap.textContent = label;
    cap.style.cssText = 'color:#e2e8f0;font:16px/1.6 sans-serif;margin-bottom:6px;';
    const cv = document.createElement('canvas');
    cv.width = Math.round(c.width * sc); cv.height = Math.round(c.height * sc);
    const cx = cv.getContext('2d');
    cx.imageSmoothingEnabled = false;
    cx.drawImage(c, 0, 0, cv.width, cv.height);
    wrap.appendChild(cap); wrap.appendChild(cv);
    return wrap;
  };
  const host = document.createElement('div');
  host.id = 'case166-salt';
  host.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483000;background:#0b1220;padding:14px 10px;';
  host.appendChild(draw(fresh, '淡水湖（原先的样子）'));
  host.appendChild(draw(salt, '盐湖 / playa（降水 < 40 且暖）'));
  document.body.appendChild(host);
  await new Promise(r => setTimeout(r, 120));
  return JSON.stringify({ ok: true, diffPixels: diff });
})() """


def run(cdp):
    fails, notes = [], []
    ok, info = ensure_case_state(cdp)
    if not ok:
        return False, f'基线项目未就绪：{info}'
    cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
             ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本视图')
    time.sleep(1.2)

    opened = _j(cdp.eval(JS_OPEN), '打开面板')
    time.sleep(0.4)
    m = _j(cdp.eval(JS_MEASURE), '面板几何')
    if not opened.get('hasBtn') or not m.get('panelOpen'):
        return False, '地形参数面板打不开（入口或浮层丢了）'
    shot(cdp, 'panel-1280.png')

    # a 行数
    if m.get('rows') != 14:
        fails.append(f"🔴 参数行 {m.get('rows')} 个（应为 14：10 个旧参数 + 河网 2 + 侵蚀 2）")
    else:
        notes.append('14 行参数')

    # b 标签不许被控件压住 / 不许被自己的格子裁掉
    if m.get('clipped'):
        bad = '、'.join(f"{x['label']}(溢出 {x['textClipped']}px)" for x in m['clipped'])
        fails.append(f'🔴 标签文字溢出自己的格子（会被滑杆压住/截断）：{bad}'
                     '（`.tgen-row` 标签列用固定宽就会这样，要 max-content）')
    elif m.get('overlapping'):
        bad = '、'.join(f"{x['label']}(压 {x['overlap']}px)" for x in m['overlapping'])
        fails.append(f'🔴 标签被控件压住：{bad}')
    else:
        notes.append('标签零溢出、零重叠')

    # c 视口
    if m.get('overflowsViewport'):
        fails.append(f"🔴 面板超出视口：{m.get('rect')} vs {m.get('vp')}")
    if m.get('applyInViewport') is not True:
        fails.append(f"🔴 “应用所选”不在视口内：{m.get('rect')}")
    else:
        notes.append('面板在视口内 / 应用可达')

    # d int 字段必须显示整数
    for row in m.get('intRows') or []:
        if row.get('value') and '.' in row['value']:
            fails.append(f"🔴 “{row['label']}”显示成小数 {row['value']}（轮数/个数应是整数）")
    if not any('.' in (r.get('value') or '') for r in (m.get('intRows') or [])):
        notes.append('整数参数按整数显示')

    # e 盐湖着色（真栅格逐像素）
    cdp.eval("(() => { const b = document.querySelector('[data-testid=\"tgen-cancel\"]'); if (b) b.click(); return 'ok'; })()")
    time.sleep(0.3)
    salt = _j(cdp.eval(JS_SALT), '盐湖探针')
    time.sleep(0.3)
    shot(cdp, 'salt-vs-fresh.png')
    if not salt.get('ok'):
        fails.append('🔴 盐湖探针失败（buildHeightmapRaster 没出画布）')
    elif (salt.get('diffPixels') or 0) < 50:
        fails.append(f"🔴 盐湖与淡水湖几乎一样（差异像素 {salt.get('diffPixels')}）—— 分档没生效")
    else:
        notes.append(f"盐湖栅格差异 {salt.get('diffPixels')} px")

    # f 窄窗口再来一遍
    cdp.eval("(() => { const h = document.getElementById('case166-salt'); if (h) h.remove(); return 'ok'; })()")
    cdp.send('Emulation.setDeviceMetricsOverride',
             {'width': 1024, 'height': 720, 'deviceScaleFactor': 1, 'mobile': False})
    time.sleep(0.6)
    cdp.eval("(() => { const t = document.querySelector('.more-toggle'); if (t) t.click(); "
             "const b = document.querySelector('[data-testid=\"basemap-terrain-params\"]'); if (b) b.click(); return 'ok'; })()")
    time.sleep(0.6)
    small = _j(cdp.eval(JS_MEASURE), '窄窗口几何')
    shot(cdp, 'panel-1024x720.png')
    cdp.send('Emulation.clearDeviceMetricsOverride')
    time.sleep(0.3)
    if small.get('overflowsViewport'):
        fails.append(f"🔴 1024×720 下面板超出视口：{small.get('rect')} vs {small.get('vp')}")
    if small.get('clipped'):
        bad = '、'.join(f"{x['label']}(溢出 {x['textClipped']}px)" for x in small['clipped'])
        fails.append(f'🔴 1024×720 下标签文字溢出：{bad}')
    elif small.get('overlapping'):
        bad = '、'.join(f"{x['label']}" for x in small['overlapping'])
        fails.append(f'🔴 1024×720 下标签被压住：{bad}')
    if not fails:
        notes.append('1024×720 也在视口内、零重叠')

    return (not fails), ('地形参数面板：' + ' / '.join(notes) + ('' if not fails else ' | ' + ' | '.join(fails)))
