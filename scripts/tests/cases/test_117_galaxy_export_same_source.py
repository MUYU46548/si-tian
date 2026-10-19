#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 117：**导出 PNG(全图) 与画布同源**（2026-10-18 第十二修）

对应上一轮交接 §6 的第 1 条（也是 ④ 六个 bug 里最后一条）。修前的 `App.vue#handleExportFullPNG`
是**第三套实现**，与画布各写一份，五处不一致且**一条都不报错**：

| # | 修前 | 修后（判据） |
|---|---|---|
| ① 坐标源 | 用 `node.coordinate`；自动布局的星系画在"没人摆过的旧坐标"上；**没有 coordinate 的节点被整块跳过** | 用 `utils/galaxyLayout.js` 的 `layoutDomains` / `layoutGalaxies`（**与画布同一份**）——f1 逐点比对 |
| ② 势力配色 | 按名字哈希 `hsl()` | `resolveDomainColor`（节点 `factionColor` 优先）——f0 源码闸门 + Node `test_galaxy_layout.js` |
| ③ 恒星颜色 | 固定 `#ffd700` | `nodeColor`（星系用势力色）——f2 像素：导出图里 `#ffd700` 必须为 0 |
| ④ 凸包外扩 / 少星系 | 外扩 25、星系数 < 3 **直接 `continue`**（星域凭空消失） | `factionBorders`（外扩 50、不足 3 画正多边形）——Node 单测 d1/d2 |
| ⑤ 航道配色 | 3 类（丢"用户建的"） | `hyperlaneColor`（4 类）——f0 源码闸门 + Node 单测 e1 |

判据手法：**在导出期间插桩 `CanvasRenderingContext2D.prototype.arc`**（记录每个节点圆的圆心与半径），
再把记录到的位置和"用同一份共享函数算出来的期望位置"逐点比对 —— 这是"同源"的直接证据；
另外把导出的 PNG 抓下来做像素检查（证明它真的被画进了图里）。
"""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json
from lib.helpers import view_level  # noqa: E402


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


def _read(rel):
    root = os.path.join(os.path.dirname(__file__), '..', '..', '..')
    with open(os.path.join(root, rel), encoding='utf-8') as f:
        return f.read()


def source_gates():
    """f0：源码闸门 —— 两边都必须 import 共享件，且不许再留第二套"""
    fails, notes = [], []
    app = _code_only(_read('src/renderer/src/App.vue'))
    gm = _code_only(_read('src/renderer/src/components/GalaxyMap.vue'))
    gl = _code_only(_read('src/renderer/src/utils/galaxyLayout.js'))

    if "from './utils/galaxyLayout'" not in app:
        fails.append('🔴 App.vue（导出侧）没有 import 共享布局模块')
    if "from '../utils/galaxyLayout'" not in gm:
        fails.append('🔴 GalaxyMap（画布侧）没有 import 共享布局模块')
    for bad, why in (
        ('convexHullForExport', 'App.vue 里还留着第二套凸包'),
        ('getDomainColorForExport', 'App.vue 里还留着第二套势力配色'),
        ('function getNodeColor(', 'App.vue 里还留着第二套节点配色'),
        ('function convexHull(', 'GalaxyMap 里还留着本地凸包'),
    ):
        src = app if 'App.vue' in why else gm
        if bad in src:
            fails.append(f'🔴 {why}（`{bad}`）')
    for needle, why in (
        ('layoutDomains(', '星域布局'),
        ('layoutGalaxies(', '星系布局'),
        ('factionBorders(', '势力边界（覆盖点/正多边形/凸包外扩）'),
        ('hyperlaneColor(', '航道配色（4 类）'),
        ('nodeColor(', '节点配色（星系用势力色）'),
        ('nodeRadius(', '节点半径'),
        ('STARFIELD', '星云谱（世界坐标固定，两边同一条）'),
    ):
        if needle not in app:
            fails.append(f'🔴 导出没有走共享 {why}（找不到 `{needle}`）')
    if gm.count('hyperlaneColor(h,') < 1:
        fails.append('🔴 画布的航道配色没有走共享 hyperlaneColor（4 类会退化成画布自己一套）')
    for bad in ("color + '", 'const nebulae = ['):
        if bad in gm:
            fails.append(f'🔴 GalaxyMap 里还有旧的写死配色/星云（`{bad}`）')
    for fn in ('export function layoutDomains(', 'export function layoutGalaxies(',
               'export function factionBorders(', 'export function hyperlaneColor(',
               'export function nodeColor(', 'export const STARFIELD'):
        if fn not in gl:
            fails.append(f'🔴 galaxyLayout.js 缺 {fn}')
    notes.append(f'源码闸门 {"全过" if not fails else f"缺 {len(fails)}"}')
    return fails, notes


def js(body):
    """段体包成 async IIFE（`eval_json` 要求返回 **JSON 字符串**）"""
    return "(async () => {\n" + body + "\n})()"


def _probe(cdp, body, desc):
    ok, obj = eval_json(cdp, js(body), desc=desc)
    if not ok:
        return {'fails': [f'探针失败：{obj}']}
    return obj


def run(cdp):
    fails, notes = source_gates()

    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    # 进星域视图（GalaxyMap 挂载 = 画布语义存在；导出本身是全图，但共享的是同一份布局函数）
    from lib.helpers import select_world_with_domains
    select_world_with_domains(cdp)
    time.sleep(0.8)
    if view_level(cdp) != 'domain':
        return False, f'未进入 domain 视图（{view_level(cdp)}）'
    wait_for(cdp, "!!document.querySelector('.galaxy-map-container')", desc='GalaxyMap 挂载')

    # ⚠️ 「导出 PNG (全图)」在工具栏的导出菜单里（默认不挂载）—— 先点开导出面板。
    #    再⚠️：**Vue 的 DOM 更新是异步的**，点完必须等一拍才查得到菜单（本仓踩过多次）
    ok_menu, opened = eval_json(cdp, """(async () => {
      const btn = Array.from(document.querySelectorAll('.toolbar-actions button'))
        .find(b => (b.getAttribute('title') || '') === '导出');
      if (!btn) return JSON.stringify({ fails: ['找不到标题为「导出」的工具栏按钮'], r: 'no-toolbar-btn' });
      btn.click();
      await new Promise(r => setTimeout(r, 0));
      return JSON.stringify({ fails: [], r: document.querySelector('.export-menu') ? 'ok' : 'menu-missing',
        btns: Array.from(document.querySelectorAll('.export-menu button')).map(b => (b.textContent || '').trim()) });
    })()""", desc='打开导出菜单')
    if not ok_menu:
        return False, f'导出菜单探针失败：{opened}'
    if opened.get('r') != 'ok':
        return False, f'导出菜单没打开（{opened}）'
    time.sleep(0.2)

    # ══════════════════════════════════════════════════════════════════════
    # f1 插桩导出：节点圆心必须等于**共享布局**算出来的位置（不是 node.coordinate）
    # ══════════════════════════════════════════════════════════════════════
    r1 = _probe(cdp, """
  const out = { fails: [] };
  const store = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const G = await import('/src/utils/galaxyLayout.js');

  // 先按"共享布局"算期望（与导出内部同一份函数、同一份输入）
  const domainNodes = G.layoutDomains(store.currentWorldDomains, {});
  const galaxyNodes = G.layoutGalaxies(store.galaxies, domainNodes, {});
  const deepNodes = store.nodes.filter(n => n.layer !== 'galaxy' && n.layer !== 'star_domain'
    && n.coordinate && Number.isFinite(n.coordinate.x) && Number.isFinite(n.coordinate.y));
  const expected = [
    ...deepNodes.map(n => ({ id: n.id, x: n.coordinate.x, y: n.coordinate.y, layer: n.layer })),
    ...domainNodes.map(d => ({ id: d.id, x: d.x, y: d.y, layer: 'star_domain' })),
    ...galaxyNodes.map(g => ({ id: g.id, x: g.x, y: g.y, layer: 'galaxy' })),
  ];

  // 插桩：记录所有"节点圆"（半径 >= 5 的 arc）；星尘的半径 <= 1.2，天然被排除
  const proto = CanvasRenderingContext2D.prototype;
  const origArc = proto.arc;
  const arcs = [];
  proto.arc = function (x, y, r, s, e, ccw) {
    if (r >= 5) arcs.push({ x: x, y: y, r: r });
    return origArc.call(this, x, y, r, s, e, ccw);
  };
  // 顺便把导出的 PNG 抓下来（覆盖 createObjectURL / toBlob，拿 blob 转 dataURL）
  // ⚠️ 存到 `window.__exportBlob`：下一段像素判据直接用，**不必再导一次**
  const origCreate = URL.createObjectURL;
  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  let captured = null;
  URL.createObjectURL = function (blob) { captured = blob; window.__exportBlob = blob; return origCreate.call(URL, blob); };
  HTMLCanvasElement.prototype.toBlob = function (cb, type, q) {
    const self = this;
    return origToBlob.call(self, function (blob) { captured = blob; window.__exportBlob = blob; cb(blob); }, type, q);
  };

  let clicked = false;
  try {
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('导出 PNG (全图)'));
    if (!btn) { out.fails.push('找不到「导出 PNG (全图)」按钮'); return JSON.stringify(out); }
    btn.click();
    clicked = true;
    // 导出是"同步绘制 + 异步 toBlob"：图很大（世界包围盒 × dpr2 ≈ 千万像素），
    // PNG 编码可能要好几百毫秒 —— 轮询等它落地（上限 8s），否则下一段拿不到产物
    for (let i = 0; i < 80 && !window.__exportBlob; i++) await new Promise(r => setTimeout(r, 100));
    out.blobMs = null;
  } finally {
    proto.arc = origArc;
    HTMLCanvasElement.prototype.toBlob = origToBlob;
  }
  out.clicked = clicked;
  out.arcCount = arcs.length;
  out.expectedCount = expected.length;

  // 逐点比对：按"最近邻"配对（位置差 <= 0.75 视为同一点）
  const used = new Array(arcs.length).fill(false);
  let matched = 0;
  const missing = [];
  for (const e of expected) {
    let hit = -1;
    for (let i = 0; i < arcs.length; i++) {
      if (used[i]) continue;
      if (Math.abs(arcs[i].x - e.x) <= 0.75 && Math.abs(arcs[i].y - e.y) <= 0.75) { hit = i; break; }
    }
    if (hit >= 0) { used[hit] = true; matched++; } else missing.push(e);
  }
  out.matched = matched;
  out.missing = missing.slice(0, 4);

  // 反向对照：**至少一个**节点的位置必须不等于它自己的 coordinate（否则这条判据分开不出两套实现）
  const differs = expected.filter(e => deepNodes.every(n => n.id !== e.id));
  out.expectNotCoordinate = differs.length;
  if (matched !== expected.length) {
    out.fails.push(`导出画了 ${arcs.length} 个节点圆，与共享布局的 ${expected.length} 个对不上（缺 ${missing.length} 个，`
      + `例：${JSON.stringify(missing.slice(0, 3))}）—— 导出没走同一份布局`);
  }
  // 明确点：某个星域的位置必须等于布局位置、且不等于它的遗留 coordinate
  const d0 = domainNodes[0];
  const raw0 = (store.currentWorldDomains || []).find(d => d.id === d0.id);
  const onRing = arcs.some(a => Math.abs(a.x - d0.x) <= 0.75 && Math.abs(a.y - d0.y) <= 0.75);
  if (!onRing) out.fails.push(`星域 ${d0.id} 没有画在布局位置 (${d0.x.toFixed(1)},${d0.y.toFixed(1)})`);
  if (raw0 && raw0.coordinate && !raw0.userMoved) {
    const atLegacy = arcs.some(a => Math.abs(a.x - raw0.coordinate.x) <= 0.75 && Math.abs(a.y - raw0.coordinate.y) <= 0.75);
    if (atLegacy) out.fails.push(`星域画在了遗留 coordinate (${raw0.coordinate.x},${raw0.coordinate.y}) 上 —— 与画布不同源`);
  }
  // 星系同理（取一个没被手动摆过的）
  const g0 = galaxyNodes.find(g => !g.userMoved) || galaxyNodes[0];
  const rawG = (store.galaxies || []).find(g => g.id === g0.id);
  const gOnLayout = arcs.some(a => Math.abs(a.x - g0.x) <= 0.75 && Math.abs(a.y - g0.y) <= 0.75);
  if (!gOnLayout) out.fails.push(`星系 ${g0.id} 没有画在布局位置 (${g0.x.toFixed(1)},${g0.y.toFixed(1)})`);
  if (rawG && rawG.coordinate && !rawG.userMoved) {
    const atRaw = arcs.some(a => Math.abs(a.x - rawG.coordinate.x) <= 0.75 && Math.abs(a.y - rawG.coordinate.y) <= 0.75);
    if (atRaw) out.fails.push(`星系画在了自己的旧 coordinate 上 —— 与画布不同源`);
  }
  out.domainLayout = { x: Math.round(d0.x), y: Math.round(d0.y) };
  out.galaxyLayout = { x: Math.round(g0.x), y: Math.round(g0.y) };
  return JSON.stringify(out);
""", 'f1 导出插桩')
    if r1.get('fails'):
        fails += [f'[f1 同源] {x}' for x in r1['fails']]
    notes.append(f"f1 同源：节点圆 {r1.get('arcCount')} 个 vs 期望 {r1.get('expectedCount')} 个（对上 {r1.get('matched')}）"
                 f" · 星域布局 {r1.get('domainLayout')} · 星系布局 {r1.get('galaxyLayout')}")

    # ══════════════════════════════════════════════════════════════════════
    # f2 像素：导出图里**不许再有固定金色星系**（#ffd700），且真的画进了图里
    # ══════════════════════════════════════════════════════════════════════
    r2 = _probe(cdp, """
  const out = { fails: [] };
  const store = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const G = await import('/src/utils/galaxyLayout.js');
  const domainNodes = G.layoutDomains(store.currentWorldDomains, {});
  const galaxyNodes = G.layoutGalaxies(store.galaxies, domainNodes, {});

  // 直接复用 f1 抓下来的导出产物（**不再导一次**：导出会关菜单、也要等 toBlob 回调）
  const blob = window.__exportBlob;
  if (!blob) { out.fails.push('f1 没有留下导出产物（window.__exportBlob 为空）'); return JSON.stringify(out); }
  const dataUrl = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
  const img = await new Promise(res => { const i = new Image(); i.onload = () => res(i); i.src = dataUrl; });
  const pc = document.createElement('canvas');
  pc.width = img.width; pc.height = img.height;
  const pctx = pc.getContext('2d');
  pctx.drawImage(img, 0, 0);
  const data = pctx.getImageData(0, 0, img.width, img.height).data;
  const count = (rgb, tol) => {
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - rgb[0]) <= tol && Math.abs(data[i+1] - rgb[1]) <= tol && Math.abs(data[i+2] - rgb[2]) <= tol) n++;
    }
    return n;
  };
  out.size = { w: img.width, h: img.height };
  out.gold = count([255, 215, 0], 6);              // 旧的固定星系色
  // 星系现在的色 = 所属星域的当前色（默认 #6b5b95 / 表内势力色 / 名字哈希 hsl）
  const galColors = new Set(galaxyNodes.map(g => g.factionColor));
  let galPixels = 0;
  for (const c of galColors) {
    const m = /^#([0-9a-f]{6})$/i.exec(String(c));
    if (m) {
      const v = m[1];
      galPixels += count([parseInt(v.slice(0,2),16), parseInt(v.slice(2,4),16), parseInt(v.slice(4,6),16)], 6);
    }
  }
  out.galaxyColorPixels = galPixels;
  out.galaxyColors = [...galColors].slice(0, 3);
  if (out.gold > 0) out.fails.push(`导出图里还有 ${out.gold} 个 #ffd700 像素 —— 星系仍用旧的固定金色（与画布不同源）`);
  if (out.galaxyColorPixels === 0) out.fails.push('导出图里找不到任何星系色像素（星系没被画出来？）');
  if (img.width < 100 || img.height < 100) out.fails.push(`导出位图太小：${img.width}x${img.height}`);
  return JSON.stringify(out);
""", 'f2 导出像素')
    if r2.get('fails'):
        fails += [f'[f2 像素] {x}' for x in r2['fails']]
    notes.append(f"f2 像素：{r2.get('size')} · 金色像素 {r2.get('gold')} · 星系色像素 {r2.get('galaxyColorPixels')} {r2.get('galaxyColors')}")

    if fails:
        return False, ' | '.join(notes) + ' ⇒ ' + ' ；'.join(fails)
    return True, ' | '.join(notes)
