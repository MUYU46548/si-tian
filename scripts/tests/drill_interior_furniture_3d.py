#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机演练：室内 3D 家具体块（A20，2026-11-15）

验的不是“代码里有 furnitureBoxes 这个函数”，是**轴测图里真的能看见家具**：

  1) 两层楼 · 坡顶 → 出“空房间”基线；摆 6 件家具（走 `store.addFurniture`）→ 再出一张：
     两张不许**大面积**不同（家具在室内；封顶时只允许透过半透明窗玻璃看见，实测 0.23%）；
  2) 切“不封顶”→ 有家具 / 移除家具各出一张：家具必须真的画进画面（阈值 0.5%，实测 1.46%），
     且差异不许跑到画面边缘（那就是整幅偏移，不是家具）；
  3) 负向探针：同一参数连出两张必须**逐像素一致**（否则第 2 条的差异不算数）；
  4) 切到“只看一层”（楼层下拉，**不删数据**）→ 空 / 有家具两张比：一层的床/桌/柜/椅
     必须全部看得见（阈值 2%）；统计条必须写“只看 …”；
  5) 顶栏统计出现“6 件家具”；
  6) 柱（A24 余）：放两根 40cm 柱 → 统计出现“2 根柱”、画面多出两根竖柱（阈值 0.8%）；
  7) 手画楼板洞口（A16 余）：切回全部楼层 → 在二层画一个 250×200cm 的洞 →
     统计出现“1 个洞口”、画面多出洞口（阈值 0.3%）。

⚠️ 两层楼的整体轴测里，一层家具被二层楼板压着看不见 —— 这不是 bug（楼板是实体）。
   要看下层就切“只看一层”（A20 余，2026-11-15 补），不用再删楼上。

为什么用“两张图逐像素比”而不是“看一眼像不像”：单张图只能证明“画面里有东西”，
证明不了“那些东西就是刚摆的家具”；同机位 A/B 才能把家具从墙、楼板、阴影里分离出来。

产物：`build/interior-furniture/`（空房间 / 有家具 / 坡顶对照 + diff 热图）。

用法：
  python scripts/tests/drill_interior_furniture_3d.py
"""
import base64
import json
import os
import sys
import time

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'lib'))
sys.path.insert(0, os.path.dirname(__file__))

import drill_exterior_3d as D                                   # noqa: E402  复用起环境/造房子
from lib.cdp import CDP, APP_URL, find_page_ws, skip_onboarding, wait_for, fetch_string  # noqa: E402
from lib.helpers import open_harness_project, ensure_data_ready, ensure_test_building  # noqa: E402

OUT_DIR = os.path.join(D.ROOT, 'build', 'interior-furniture')
# 与 src/renderer/src/interior/floorView.js 的 ALL_FLOORS 同值（下拉里“全部楼层”的 value）
ALL_FLOORS_VALUE = 'all'

# 6 件家具：坐标是平面左上角（cm），房间 900×650，内隔墙在 x=520
FURNITURE = [
    # 一层 · 大厅（x < 520）
    {'type': 'table', 'name': '餐桌', 'x': 120, 'y': 120, 'width': 140, 'height': 80, 'rotation': 0, 'color': '#a0522d'},
    {'type': 'chair', 'name': '椅子', 'x': 150, 'y': 230, 'width': 45, 'height': 45, 'rotation': 0, 'color': '#cd853f'},
    {'type': 'chest', 'name': '书柜', 'x': 40, 'y': 470, 'width': 120, 'height': 60, 'rotation': 0, 'color': '#8b4513'},
    # 一层 · 右房间（x > 520）
    {'type': 'bed', 'name': '床', 'x': 600, 'y': 60, 'width': 200, 'height': 150, 'rotation': 0, 'color': '#4682b4'},
    # 二层（elevation 300）
    {'type': 'wardrobe', 'name': '衣柜', 'x': 80, 'y': 60, 'width': 120, 'height': 60, 'rotation': 0, 'color': '#6b4226'},
    {'type': 'sofa', 'name': '沙发', 'x': 300, 'y': 250, 'width': 200, 'height': 80, 'rotation': 0, 'color': '#6e7f8d'},
]


# 柱（A24 余）：两根 40cm 方柱，放在大厅与右房间中间
COLUMNS = [
    {'x': 260, 'y': 325, 'size': 40},
    {'x': 710, 'y': 325, 'size': 40},
]


def log(msg):
    print(msg, flush=True)


def set_roof(cdp, kind):
    out = D.eval_json(cdp, """(() => {
      const sel = document.querySelector('[data-testid=exterior-roof-kind]');
      if (!sel) return JSON.stringify({ err: 'no-select' });
      sel.value = %s;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return JSON.stringify({ ok: true, value: sel.value });
    })()""" % json.dumps(kind))
    time.sleep(1.0)
    return out


def set_preset(cdp, preset):
    D.eval_json(cdp, """(() => {
      const sel = document.querySelector('[data-testid=exterior-axo-preset]');
      if (!sel) return JSON.stringify({ err: 'no-select' });
      sel.value = %s;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return JSON.stringify({ ok: true });
    })()""" % json.dumps(preset))
    time.sleep(0.3)


def export_axo(cdp, tag):
    """点一次“轴测出图”，把 dataUrl 落盘。返回路径（失败返回 None）。"""
    cdp.eval("window.__saved = null; window.savedName = null; 1")
    cdp.eval("""(() => {
      window.sitianAPI.saveExportFile = async (o) => {
        window.__saved = o && o.dataUrl;
        window.savedName = o && o.defaultName;
        return { success: true, path: 'stub://' + (o && o.defaultName) };
      };
      return 1;
    })()""")
    clicked = D.eval_json(cdp, """(() => {
      const b = document.querySelector('[data-testid=exterior-axo-export]');
      if (!b) return JSON.stringify({ err: 'no-button' });
      if (b.disabled) return JSON.stringify({ err: 'disabled' });
      b.click();
      return JSON.stringify({ ok: true });
    })()""")
    if clicked.get('err'):
        log('   ✗ %s：出图按钮 %s' % (tag, clicked['err']))
        return None
    wait_for(cdp, "!!window.__saved", timeout=90, desc='%s 出图完成' % tag)
    total = cdp.eval("window.__saved.length") or 0
    data_url = fetch_string(
        cdp, 'window.__saved.length',
        lambda i, j: 'window.__saved.slice(%d, %d)' % (i, j),
        desc='%s dataUrl' % tag,
    )
    if not isinstance(data_url, str) or ',' not in data_url:
        log('   ✗ %s：拿不到 dataUrl（长度 %s）' % (tag, total))
        return None
    raw = base64.b64decode(data_url.split(',', 1)[1])
    path = os.path.join(OUT_DIR, '%s.png' % tag)
    with open(path, 'wb') as f:
        f.write(raw)
    log('   · %s → %s（%.0f KB）' % (tag, os.path.basename(path), len(raw) / 1024.0))
    return path


def diff(a_path, b_path, tag):
    """逐像素差：返回 {ratio, maxdiff, bbox, path}"""
    ia = Image.open(a_path).convert('RGB')
    ib = Image.open(b_path).convert('RGB')
    if ia.size != ib.size:
        return {'ok': False, 'reason': 'size-mismatch %s vs %s' % (ia.size, ib.size)}
    a = np.asarray(ia, dtype=np.int16)
    b = np.asarray(ib, dtype=np.int16)
    d = np.abs(a - b).max(axis=2)
    mask = d > 8
    ys, xs = np.nonzero(mask)
    bbox = None
    if len(xs):
        bbox = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
    ratio = float(mask.mean())
    heat = os.path.join(OUT_DIR, 'diff-%s.png' % tag)
    vis = np.zeros_like(a, dtype=np.uint8)
    vis[..., 0] = np.where(mask, 220, 255)
    vis[..., 1] = np.where(mask, 60, 255)
    vis[..., 2] = np.where(mask, 60, 255)
    Image.fromarray(vis).save(heat)
    return {
        'ok': True, 'ratio': ratio, 'maxdiff': int(d.max()),
        'px': int(mask.sum()), 'total': int(mask.size), 'bbox': bbox,
        'size': ia.size, 'heat': heat,
    }


def place_furniture(cdp, bid):
    expr = """(() => {
      const s = %s, bid = %s;
      const d = s.interiorData[bid];
      if (!d || d.floors.length < 2) return JSON.stringify({ err: 'no-two-floors' });
      const items = %s;
      const f1 = d.floors[0].id, f2 = d.floors[1].id;
      const placed = [];
      items.forEach((it, i) => {
        const target = i < 4 ? f1 : f2;
        const added = s.addFurniture(bid, target, it);
        if (added) placed.push(added.id);
      });
      const dd = s.interiorData[bid];
      return JSON.stringify({
        placed: placed.length,
        perFloor: dd.floors.map(f => (f.furniture || []).length),
      });
    })()""" % (D.STORE, json.dumps(bid), json.dumps(FURNITURE))
    return D.eval_json(cdp, expr)


def clear_furniture(cdp, bid):
    expr = """(() => {
      const s = %s, bid = %s;
      const d = s.interiorData[bid];
      if (!d) return JSON.stringify({ err: 'no-data' });
      let removed = 0;
      d.floors.forEach(f => {
        (f.furniture || []).slice().forEach(it => {
          s.removeFurniture(bid, f.id, it.id);
          removed++;
        });
      });
      const dd = s.interiorData[bid];
      return JSON.stringify({ removed, left: dd.floors.map(f => (f.furniture || []).length) });
    })()""" % (D.STORE, json.dumps(bid))
    return D.eval_json(cdp, expr)


def ground_floor_id(cdp, bid):
    """取标高最低那一层的 id（“只看一层”默认看它）。"""
    expr = """(() => {
      const s = %s, bid = %s;
      const d = s.interiorData[bid];
      if (!d || !(d.floors || []).length) return JSON.stringify({ err: 'no-floor' });
      const sorted = d.floors.slice().sort((a, b) => (a.elevation || 0) - (b.elevation || 0));
      return JSON.stringify({ id: sorted[0].id, name: sorted[0].name, elevation: sorted[0].elevation });
    })()""" % (D.STORE, json.dumps(bid))
    return D.eval_json(cdp, expr)


def set_floor_pick(cdp, value):
    """切“楼层”下拉（'all' 或某层 id）。

    ⚠️ 屋顶值必须**等一拍再读**：Vue 的 watch 是异步的（切楼层 → 自动把屋顶设成不封顶），
    在同一次 eval 里读回来永远是旧值 —— 第一版就这么把“自动切屋顶”判成了没生效。
    """
    out = D.eval_json(cdp, """(() => {
      const sel = document.querySelector('[data-testid=exterior-floor-pick]');
      if (!sel) return JSON.stringify({ err: 'no-select' });
      sel.value = %s;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return JSON.stringify({ ok: true, value: sel.value });
    })()""" % json.dumps(value))
    time.sleep(1.0)
    out['roof'] = cdp.eval("(document.querySelector('[data-testid=exterior-roof-kind]')||{}).value || ''")
    out['floorPick'] = cdp.eval("(document.querySelector('[data-testid=exterior-floor-pick]')||{}).value || ''")
    return out


def place_ground_items(cdp, bid):
    """把前 4 件（大厅/卧室那批）摆到最低一层。"""
    expr = """(() => {
      const s = %s, bid = %s;
      const d = s.interiorData[bid];
      if (!d || !(d.floors || []).length) return JSON.stringify({ err: 'no-floor' });
      const sorted = d.floors.slice().sort((a, b) => (a.elevation || 0) - (b.elevation || 0));
      const fid = sorted[0].id;
      const items = %s;
      let placed = 0;
      items.forEach(it => { if (s.addFurniture(bid, fid, it)) placed++; });
      return JSON.stringify({ placed, perFloor: s.interiorData[bid].floors.map(f => (f.furniture || []).length) });
    })()""" % (D.STORE, json.dumps(bid), json.dumps(FURNITURE[:4]))
    return D.eval_json(cdp, expr)


def place_columns(cdp, bid, items):
    """放柱（走产品写口 store.addColumn）。items: [{x, y, size}]"""
    expr = """(() => {
      const s = %s, bid = %s;
      const d = s.interiorData[bid];
      if (!d || !(d.floors || []).length) return JSON.stringify({ err: 'no-floor' });
      const sorted = d.floors.slice().sort((a, b) => (a.elevation || 0) - (b.elevation || 0));
      const fid = sorted[0].id;
      const items = %s;
      let placed = 0;
      items.forEach(it => { if (s.addColumn(bid, fid, it)) placed++; });
      return JSON.stringify({ placed, count: (s.interiorData[bid].floors.find(f => f.id === fid).columns || []).length });
    })()""" % (D.STORE, json.dumps(bid), json.dumps(items))
    return D.eval_json(cdp, expr)


def place_hole(cdp, bid, hole, floor_index=-1):
    """在指定层画一个手画洞口（走产品写口 store.addHole）。floor_index=-1 = 最上层。

    ⚠️ JS 数组没有负索引（`sorted[-1]` 是 undefined，不是末元素）—— 第一版就撞了这个，
    表现是 `no-such-floor`。这里把 -1 翻译成 `sorted.length - 1`。
    """
    idx_expr = 'sorted.length - 1' if floor_index < 0 else str(int(floor_index))
    expr = """(() => {
      const s = %s, bid = %s;
      const d = s.interiorData[bid];
      if (!d || !(d.floors || []).length) return JSON.stringify({ err: 'no-floor' });
      const sorted = d.floors.slice().sort((a, b) => (a.elevation || 0) - (b.elevation || 0));
      const f = sorted[%s];
      if (!f) return JSON.stringify({ err: 'no-such-floor' });
      const created = s.addHole(bid, f.id, %s);
      return JSON.stringify({
        ok: !!created, floor: f.name,
        count: (s.interiorData[bid].floors.find(x => x.id === f.id).holes || []).length,
      });
    })()""" % (D.STORE, json.dumps(bid), idx_expr, json.dumps(hole))
    return D.eval_json(cdp, expr)


def stats_text(cdp):
    return cdp.eval("(document.querySelector('[data-testid=exterior-stats]')||{}).textContent || ''") or ''


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    handles = []
    cdp = None
    fails = []
    mock_ready = False
    try:
        log('  · 注入回归 mock 数据…')
        D.RT.setup_mock()
        mock_ready = True
        D.ensure_vite(handles)
        handles.append(D.start_edge())
        cdp = CDP(ws_url=find_page_ws(D.PORT, prefer_prefix='http://localhost:5180'))
        cdp.send('Page.enable')
        cdp.send('Emulation.setDeviceMetricsOverride', {
            'width': 1440, 'height': 900, 'deviceScaleFactor': 1, 'mobile': False,
        })
        cdp.navigate(APP_URL)
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=45, desc='应用挂载')
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate(APP_URL)
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=45, desc='重载')
        wait_for(cdp, "!document.querySelector('.onboarding-overlay')", timeout=30, desc='引导层')
        cdp.eval("(() => { const b = document.querySelector('.recovery-overlay .btn-discard'); if (b) b.click(); return 1; })()")
        time.sleep(0.3)
        skip_onboarding(cdp)
        ensure_data_ready(cdp)
        ok, info = open_harness_project(cdp)
        if not ok:
            raise RuntimeError('harness 基线项目打不开：%s' % info)
        okb, binfo = ensure_test_building(cdp)
        if not okb:
            raise RuntimeError('建筑 fixture 失败：%s' % binfo)
        bid = binfo['id']
        wait_for(cdp, "!!document.querySelector('.interior-container')", timeout=30, desc='内部视图')
        D.build_house(cdp, bid)

        # 打开外观
        clicked = D.eval_json(cdp, """(() => {
          const b = [...document.querySelectorAll('.exterior-btn, .header-actions button')]
            .find(x => x.textContent.trim() === '外观');
          if (!b) return JSON.stringify({ err: 'no-button' });
          if (b.disabled) return JSON.stringify({ err: 'disabled' });
          b.click();
          return JSON.stringify({ ok: true });
        })()""")
        if clicked.get('err'):
            raise RuntimeError('外观按钮打不开：%s' % clicked)
        wait_for(cdp, "!!document.querySelector('[data-testid=exterior-stats]')", timeout=25, desc='外观统计')
        # 页面报错要**自己挂监听**（与 drill_exterior_3d 同一手法）：
        # 直接读一个没人写过的 `window.__errors` 会永远得到空数组 —— 那是假绿。
        cdp.eval("window.__exErrs = [];"
                 "window.addEventListener('error', e => window.__exErrs.push(String(e.message || e)));"
                 "window.addEventListener('unhandledrejection', e => window.__exErrs.push('rejection: ' + String(e.reason)));"
                 "1")
        time.sleep(1.2)

        set_preset(cdp, 'iso')

        # ① 坡顶 · 空房间（后面“家具不许穿出屋面”的对照基线）
        p_gable_empty = export_axo(cdp, '01-gable-empty')
        stats_empty = stats_text(cdp)
        log('  · 空房间统计：%s' % stats_empty)

        # ② 摆家具（走产品写口 store.addFurniture）
        placed = place_furniture(cdp, bid)
        if placed.get('err'):
            fails.append('摆家具失败：%s' % placed['err'])
        else:
            log('  · 摆了 %s 件（每层 %s）' % (placed.get('placed'), placed.get('perFloor')))
            if placed.get('placed') != len(FURNITURE):
                fails.append('家具件数不对：摆了 %s，期望 %s' % (placed.get('placed'), len(FURNITURE)))
        time.sleep(1.5)
        stats_full = stats_text(cdp)
        log('  · 有家具统计：%s' % stats_full)
        if '%d 件家具' % len(FURNITURE) not in stats_full:
            fails.append('顶栏统计没显示“%d 件家具”：%r' % (len(FURNITURE), stats_full))

        # ③ 坡顶 · 有家具（同一屋顶状态下比：家具在室内，画面应该几乎不变）
        p_gable_full = export_axo(cdp, '02-gable-furniture')

        # ④ 不封顶 · 有家具（从上方看进房间）
        set_roof(cdp, 'none')
        p_noroof_full = export_axo(cdp, '03-noroof-furniture')

        # ⑤ 移除家具 → 不封顶 · 空房间（同一屋顶状态下的对照）
        removed = clear_furniture(cdp, bid)
        if removed.get('err'):
            fails.append('移除家具失败：%s' % removed['err'])
        else:
            log('  · 移除 %s 件（每层剩 %s）' % (removed.get('removed'), removed.get('left')))
        time.sleep(1.5)
        p_noroof_empty = export_axo(cdp, '04-noroof-empty')
        p_noroof_empty2 = export_axo(cdp, '05-noroof-empty-again')

        # ── 判据 1：不封顶下，家具必须真的画进画面 ──
        if p_noroof_empty and p_noroof_full:
            d1 = diff(p_noroof_empty, p_noroof_full, 'noroof-empty-vs-furniture')
            log('  · 家具在图上占：%d 像素（%.3f%%），最大通道差 %d，包围盒 %s'
                % (d1.get('px', -1), 100 * d1.get('ratio', -1), d1.get('maxdiff', -1), d1.get('bbox')))
            if not d1.get('ok'):
                fails.append('空/有家具比对失败：%s' % d1.get('reason'))
            else:
                if d1['ratio'] < 0.005:
                    fails.append('摆了 6 件家具，画面只变了 %.3f%% —— 家具没画进去（阈值 0.5%%）' % (100 * d1['ratio']))
                if d1['maxdiff'] < 40:
                    fails.append('差异最大只有 %d 通道差 —— 不像家具体块，像阴影噪声' % d1['maxdiff'])
                w, h = d1['size']
                bbox = d1['bbox'] or [0, 0, 0, 0]
                if bbox[0] < w * 0.02 or bbox[1] < h * 0.02 or bbox[2] > w * 0.98 or bbox[3] > h * 0.98:
                    fails.append('差异跑到画面边缘（bbox=%s，画幅 %dx%d）—— 像是整幅偏移而不是家具' % (bbox, w, h))

        # ── 判据 2（负向）：坡顶封着时，有家具与没家具不许**大面积**不同 ──
        # ⚠️ 期望值不是 0：一层右墙有两扇窗，玻璃是半透明的（`axoScene` 里 window 走
        #    opacity 0.55），从轴测机位能**透过窗玻璃看见房间里的床** —— 实测 19739 像素
        #    （0.23%），差异像素 B 侧均值 (108,144,170) 正是床的蓝色 #4682b4 被玻璃冲淡的样子。
        #    所以阈值定 0.5%：真正的穿模（家具顶出屋面/墙外）会是一大片（>2%），能分开。
        if p_gable_empty and p_gable_full:
            d2 = diff(p_gable_empty, p_gable_full, 'gable-empty-vs-furniture')
            log('  · 坡顶下差异：%d 像素（%.4f%%）' % (d2.get('px', -1), 100 * d2.get('ratio', -1)))
            if not d2.get('ok'):
                fails.append('坡顶对照比对失败：%s' % d2.get('reason'))
            elif d2['ratio'] > 0.005:
                fails.append('封着屋顶还能看见 %.3f%% 的不同 —— 家具穿出屋面/墙体了（只允许透过窗玻璃看见）'
                             % (100 * d2['ratio']))

        # ── 判据 3（负向）：同一参数连出两张必须一致（否则判据 1 的差异不算数）──
        if p_noroof_empty and p_noroof_empty2:
            d0 = diff(p_noroof_empty, p_noroof_empty2, 'noroof-empty-vs-again')
            log('  · 确定性：差异像素 %d / %d（%.4f%%）'
                % (d0.get('px', -1), d0.get('total', -1), 100 * d0.get('ratio', -1)))
            if not d0.get('ok'):
                fails.append('确定性对照比对失败：%s' % d0.get('reason'))
            elif d0['ratio'] > 0.0002:
                fails.append('同一参数连出两张竟然有 %.4f%% 像素不同（渲染不确定，前面的差异不算数）'
                             % (100 * d0['ratio']))

        # ── 判据 4：切到“只看一层”后，一层的床/桌/柜/椅必须全部看得见 ──
        # 两层楼的整体轴测里一层被二层楼板压着（物理正确），所以要有“只看某一层”。
        # 注意：**不删楼层、不改数据** —— 只是视图过滤（floorView.js 的口径）。
        # 先把屋顶切回坡顶：用来验证“切到只看一层时，屋顶会自动切成不封顶”
        set_roof(cdp, 'gable')
        gf = ground_floor_id(cdp, bid)
        if gf.get('err'):
            fails.append('取一层失败：%s' % gf['err'])
        pick = set_floor_pick(cdp, gf.get('id') or ALL_FLOORS_VALUE)
        log('  · 只看一层：%s（下拉值 %s，屋顶 %s）'
            % (gf.get('name'), pick.get('value'), pick.get('roof')))
        if pick.get('err'):
            fails.append('楼层下拉不可用：%s' % pick['err'])
        if pick.get('roof') != 'none':
            fails.append('切到只看一层后屋顶应自动变成不封顶，实际 %r' % pick.get('roof'))
        stats_single = stats_text(cdp)
        if '只看' not in stats_single:
            fails.append('统计条没写“只看某层”：%r' % stats_single)
        p_single_empty = export_axo(cdp, '06-single-empty')
        gi = place_ground_items(cdp, bid)
        if gi.get('err'):
            fails.append('单层摆家具失败：%s' % gi['err'])
        else:
            log('  · 单层摆了 %s 件（每层 %s）' % (gi.get('placed'), gi.get('perFloor')))
        time.sleep(1.5)
        p_single_full = export_axo(cdp, '07-single-furniture')
        if p_single_empty and p_single_full:
            d3 = diff(p_single_empty, p_single_full, 'single-empty-vs-furniture')
            log('  · 单层：家具占 %d 像素（%.3f%%），最大通道差 %d，包围盒 %s'
                % (d3.get('px', -1), 100 * d3.get('ratio', -1), d3.get('maxdiff', -1), d3.get('bbox')))
            if not d3.get('ok'):
                fails.append('单层比对失败：%s' % d3.get('reason'))
            else:
                if d3['ratio'] < 0.02:
                    fails.append('单层摆了 4 件家具，画面只变了 %.3f%% —— 至少有一件没画出来（阈值 2%%）'
                                 % (100 * d3['ratio']))
                if d3['maxdiff'] < 40:
                    fails.append('单层差异最大只有 %d 通道差 —— 不像家具体块' % d3['maxdiff'])

        # ── 判据 5：柱（A24 余）—— 放两根柱，画面必须多出两根竖柱 ──
        pc = place_columns(cdp, bid, COLUMNS)
        if pc.get('err'):
            fails.append('放柱失败：%s' % pc['err'])
        else:
            log('  · 放了 %s 根柱（本层共 %s 根）' % (pc.get('placed'), pc.get('count')))
            if pc.get('placed') != len(COLUMNS):
                fails.append('柱数量不对：放了 %s，期望 %s' % (pc.get('placed'), len(COLUMNS)))
        time.sleep(1.2)
        stats_cols = stats_text(cdp)
        if '%d 根柱' % len(COLUMNS) not in stats_cols:
            fails.append('顶栏统计没显示“%d 根柱”：%r' % (len(COLUMNS), stats_cols))
        p_single_cols = export_axo(cdp, '08-single-columns')
        if p_single_full and p_single_cols:
            d4 = diff(p_single_full, p_single_cols, 'single-furniture-vs-columns')
            log('  · 柱在图上占：%d 像素（%.3f%%），最大通道差 %d'
                % (d4.get('px', -1), 100 * d4.get('ratio', -1), d4.get('maxdiff', -1)))
            if not d4.get('ok'):
                fails.append('柱比对失败：%s' % d4.get('reason'))
            elif d4['ratio'] < 0.008:
                fails.append('放了两根 40cm 柱，画面只变了 %.3f%% —— 柱没画出来（阈值 0.8%%）'
                             % (100 * d4['ratio']))

        # ── 判据 6：手画楼板洞口（A16 余）──
        # 洞只影响**有楼板**的地方，所以先切回“全部楼层”（单层视图没有楼板）。
        pick_all = set_floor_pick(cdp, ALL_FLOORS_VALUE)
        log('  · 切回全部楼层（下拉值 %s，屋顶 %s）' % (pick_all.get('floorPick'), pick_all.get('roof')))
        p_all_before = export_axo(cdp, '09-all-nohole')
        hh = place_hole(cdp, bid, {'x': 300, 'y': 200, 'w': 250, 'h': 200}, floor_index=-1)
        if hh.get('err'):
            fails.append('画洞口失败：%s' % hh['err'])
        else:
            log('  · 在 %s 画了一个 250×200cm 的洞（该层共 %s 个）' % (hh.get('floor'), hh.get('count')))
        time.sleep(1.2)
        stats_hole = stats_text(cdp)
        if '1 个洞口' not in stats_hole:
            fails.append('顶栏统计没显示“1 个洞口”：%r' % stats_hole)
        p_all_after = export_axo(cdp, '10-all-hole')
        if p_all_before and p_all_after:
            d5 = diff(p_all_before, p_all_after, 'nohole-vs-hole')
            log('  · 洞口在图上占：%d 像素（%.3f%%），最大通道差 %d'
                % (d5.get('px', -1), 100 * d5.get('ratio', -1), d5.get('maxdiff', -1)))
            if not d5.get('ok'):
                fails.append('洞口比对失败：%s' % d5.get('reason'))
            elif d5['ratio'] < 0.003:
                fails.append('画了一个 250×200cm 的洞，画面只变了 %.3f%% —— 楼板没被切（阈值 0.3%%）'
                             % (100 * d5['ratio']))

        # 页面零报错（`__exErrs` 是自己挂的监听，不是读一个没人写的变量）
        errs = cdp.eval("(window.__exErrs || []).slice(0, 5)") or []
        if errs:
            fails.append('页面报错：%s' % errs)

        if fails:
            log('\n❌ 室内 3D 家具没通过：')
            for f in fails:
                log('  - %s' % f)
            return 1
        log('\n✅ 室内 3D 家具体块出图成功：%s' % OUT_DIR)
        return 0
    finally:
        try:
            if cdp:
                cdp.close()
        except Exception:
            pass
        for h in handles[::-1]:
            try:
                h.terminate()
            except Exception:
                pass
        if mock_ready:
            try:
                D.RT.teardown_mock()
            except Exception:
                pass


if __name__ == '__main__':
    sys.exit(main())
