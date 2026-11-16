#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机演练：**聚落鸟瞰**出图（2026-11-16，建筑地图队列最后一次）

验的是"这个镇子的鸟瞰能给人看"，而不是"按钮能点"：
  1) 点区域地图上的「聚落鸟瞰」→ 走与产品按钮完全相同的路径（`saveExportFile` 只 stub 掉拿 dataUrl）；
  2) 产物 3600×2400，画面里有内容（整幅/中心墨量），上两角是纸色；
  3) **图注条**：左（区域名）/ 中（建筑·道路·镇域·投影·方位）/ 右（指北针＋出处）三段都有近黑的字；
  4) **比例尺**：左下角那块有尺子（图注关掉时同一块必须干净）—— 比例尺不是装饰，是判据；
  5) **反向探针**：关掉道路再出一张、关掉"只有体块"的建筑再出一张，
     两张都必须**只在图面里有差别**（证明道路与体块真的画上去了）。

用法：
  python scripts/tests/drill_settlement_axo.py
"""
import base64
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'lib'))
sys.path.insert(0, os.path.dirname(__file__))

import drill_exterior_3d as D                                   # noqa: E402
import drill_plan_export as P                                   # noqa: E402  复用 PNG 解析
import drill_axonometric as AX                                  # noqa: E402  复用 dark_frac / compare
from lib.cdp import CDP, APP_URL, find_page_ws, skip_onboarding, wait_for, fetch_string  # noqa: E402
from lib.helpers import open_harness_project, ensure_data_ready, ensure_test_building  # noqa: E402

OUT_DIR = os.path.join(D.ROOT, 'build', 'settlement-axo')
BAND_RATIO = 0.115          # 与 axoProps.AXO_SHEET.bandRatio 同口径
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"


def log(msg):
    print(msg, flush=True)


def _j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, str) and v.strip().startswith('{'):
        try:
            return json.loads(v)
        except ValueError:
            return {'raw': v}
    return {'raw': v}


def make_town(cdp, bid):
    """造一个 3 栋 + 1 条路的聚落：一栋有内部图（复用 build_house 那栋），两栋只有体块。"""
    expr = """(() => {
      const s = %s, bid = %s;
      let area = s.nodes.find(n => n.layer === 'area');
      if (!area) {
        const parent = s.nodes.find(n => n.layer === 'planet') || s.nodes.find(n => n.layer === 'city');
        const id = 'fixture_area_' + Date.now();
        s.addNode({ id, name: '用例镇', layer: 'area', layerLabel: '区域',
                    parentId: parent ? parent.id : null, tags: [], sourcePath: '',
                    coordinate: { x: 0, y: 0 } });
        area = s.nodes.find(x => x.id === id);
      }
      // 楼 1：有内部图的那栋，摆到 (6, 8) 米
      const b1 = s.nodes.find(n => n.id === bid);
      if (!b1) return JSON.stringify({ err: 'no-building' });
      b1.parentId = area.id;
      b1.coordinate = { x: 6, y: 8 };
      // 楼 2/3：只有体块（投影图里就是一块平顶方块）
      const plains = [['fixture_plain_wh', '仓库', 24, 9], ['fixture_plain_mill', '磨坊', 16, 26]];
      for (const [id, name, x, y] of plains) {
        let n = s.nodes.find(v => v.id === id);
        if (!n) {
          s.addNode({ id, name, layer: 'building', layerLabel: '建筑', parentId: area.id,
                      tags: [], sourcePath: '', coordinate: { x, y }, draft: true });
        } else {
          n.parentId = area.id;
          n.coordinate = { x, y };
        }
      }
      // 一条主街（3 个点，拐一次：顺带验路面是连续的带子而不是两截）
      const routeId = 'fixture_road_main';
      const list = s.areaRoutes[area.id] || [];
      if (!list.some(r => r.id === routeId)) {
        s.addAreaRoute(area.id, { id: routeId, name: '主街', color: '#F39C12',
                                  points: [{ x: -2, y: 12 }, { x: 14, y: 12 }, { x: 30, y: 16 }] });
      }
      s.selectArea(area);
      const kids = s.nodes.filter(n => n.parentId === area.id && n.layer === 'building');
      return JSON.stringify({ areaId: area.id, level: s.viewLevel, buildings: kids.length });
    })()""" % (STORE, json.dumps(bid))
    return _j(cdp, expr)


def run_export(cdp, tag, opts=None, preset=None):
    """设排障口 / 投影角 → 真实点按钮 → 拿 dataUrl 落盘解析。返回 {path,img}"""
    payload = 'null' if opts is None else json.dumps(opts)
    cdp.eval('window.__SITIAN_SETTLEMENT_OPTS__ = %s' % payload)
    if preset:
        _j(cdp, """(() => {
          const sel = document.querySelector('[data-testid=area-settlement-preset]');
          if (!sel) return JSON.stringify({ ok: false, why: 'no-select' });
          sel.value = %s;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return JSON.stringify({ ok: true, value: sel.value });
        })()""" % json.dumps(preset))
        time.sleep(0.2)
    cdp.eval("""(() => {
      window.__saved = null;
      window.savedName = null;
      window.sitianAPI.saveExportFile = async (o) => {
        window.__saved = o && o.dataUrl;
        window.savedName = o && o.defaultName;
        return { success: true, path: 'stub://' + (o && o.defaultName) };
      };
      return 1;
    })()""")
    time.sleep(0.2)
    clicked = _j(cdp, """(() => {
      const b = document.querySelector('[data-testid=area-settlement-export]');
      if (!b) return JSON.stringify({ ok: false, why: 'no-button' });
      if (b.disabled) return JSON.stringify({ ok: false, why: 'disabled' });
      b.click();
      return JSON.stringify({ ok: true });
    })()""")
    if clicked.get('raw') is not None or clicked.get('ok') is False:
        return {'error': '按钮不可点：%s' % clicked}
    wait_for(cdp, "!!window.__saved", timeout=120, desc='%s 出图完成' % tag)
    total = cdp.eval("window.__saved.length") or 0
    b64 = fetch_string(
        cdp, 'window.__saved.length',
        lambda i, j: 'window.__saved.slice(%d, %d)' % (i, j),
        desc='%s dataUrl' % tag,
    )
    if not isinstance(b64, str) or ',' not in b64:
        return {'error': '%s 拿不到 dataUrl（长度 %s）' % (tag, total)}
    raw = base64.b64decode(b64.split(',', 1)[1])
    path = os.path.join(OUT_DIR, '%s.png' % tag)
    with open(path, 'wb') as f:
        f.write(raw)
    info = P.png_regions(raw)
    if not info.get('ok'):
        return {'error': '%s PNG 解析失败 %s' % (tag, info.get('reason'))}
    return {'path': path, 'img': info}


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    handles = []
    cdp = None
    fails = []
    mock_ready = False
    shots = {}
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
        cdp.eval("""(() => {
          const b = document.querySelector('.recovery-overlay .btn-discard');
          if (b) b.click();
          return 1;
        })()""")
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
        D.build_house(cdp, bid)          # 两层小楼（有内部图的那栋）

        town = make_town(cdp, bid)
        time.sleep(0.8)
        wait_for(cdp, "!!document.querySelector('.area-map-container')", timeout=20, desc='区域视图挂载')
        time.sleep(0.5)
        log('  · 聚落：%s' % town)
        if town.get('level') != 'area':
            fails.append('没能切到区域视图：%s' % town)

        base = run_export(cdp, '01-iso')
        if base.get('error'):
            fails.append(base['error'])
        else:
            shots['01'] = base
        r = run_export(cdp, '02-noroads', {'roads': False})
        if r.get('error'):
            fails.append(r['error'])
        else:
            shots['02'] = r
        r = run_export(cdp, '03-noplain', {'plain': False})
        if r.get('error'):
            fails.append(r['error'])
        else:
            shots['03'] = r
        r = run_export(cdp, '04-nocaption', {'caption': False})
        if r.get('error'):
            fails.append(r['error'])
        else:
            shots['04'] = r
        cdp.eval('window.__SITIAN_SETTLEMENT_OPTS__ = null')
        # ⑤ 投影角：换成二测 2:1 再出一张（下拉走产品自己的 <select>）
        r = run_export(cdp, '05-dimetric', preset='dimetric')
        if r.get('error'):
            fails.append(r['error'])
        else:
            shots['05'] = r

        # ── 判据 ────────────────────────────────────────────────────────
        if '01' in shots:
            info = shots['01']['img']
            w, h = info['w'], info['h']
            ink = info['ink']
            band_top = h - int(round(h * BAND_RATIO))
            whole = ink(0, 0, w, h)
            center = ink(w * 0.25, h * 0.15, w * 0.75, band_top * 0.9)
            # 聚落图的地面会铺满整幅（场地就是一整块），所以不再要求"四角是纸色"——
            # 改判"四角同色且够亮"：黑边 / 空画布 / 整幅跑偏都能被它抓住
            corners = [AX.px_at(info, x, y) for (x, y) in [
                (6, 6), (w - 6, 6), (6, band_top - 6), (w - 6, band_top - 6)]]
            cmin = min(corners)
            cmax = max(corners)
            # 画面里必须有**墨线/阴影**（暗部）：地面是浅色，楼与影子不可能没有暗像素
            lines = AX.dark_frac(info, (0, 0, w, band_top), thr=120)
            band_left = AX.dark_frac(info, (0, band_top, w * 0.34, h))
            band_mid = AX.dark_frac(info, (w * 0.34, band_top, w * 0.82, h))
            band_right = AX.dark_frac(info, (w * 0.82, band_top, w, h))
            # 比例尺：图面左下角那一块（地面板是菱形，这一角通常是空纸）
            bar_box = (0, int(band_top * 0.86), int(w * 0.22), band_top)
            bar_ink = AX.dark_frac(info, bar_box, thr=120)

            if (w, h) != (3600, 2400):
                fails.append('尺寸应为 3600×2400，实际 %s×%s' % (w, h))
            if whole < 0.05:
                fails.append('整幅几乎没有内容（非白占比 %.3f）' % whole)
            if center < 0.20:
                fails.append('画面中间没有聚落（墨量 %.3f）' % center)
            if cmin < 180:
                fails.append('四角里有暗的（最暗 %d）—— 可能整幅跑偏/被切/黑边' % cmin)
            if cmax - cmin > 30:
                fails.append('四角颜色差太多（%d ~ %d）—— 画面可能没铺满' % (cmin, cmax))
            if lines < 0.004:
                fails.append('画面里几乎找不到墨线/阴影（暗部占比 %.4f）' % lines)
            for name, v in (('左（区域名）', band_left), ('中（建筑·道路·镇域·投影·方位）', band_mid),
                            ('右（指北针＋出处）', band_right)):
                if v <= 0.0005:
                    fails.append('图注%s那一段是空的（近黑 %.4f）' % (name, v))
            if bar_ink < 0.004:
                fails.append('图面左下角没有比例尺（近黑 %.4f）' % bar_ink)
            log('  · 01 %dx%d 整幅 %.3f 中心 %.3f 四角 %d~%d 墨线 %.4f 图注 左 %.4f 中 %.4f 右 %.4f 比例尺 %.4f'
                % (w, h, whole, center, cmin, cmax, lines, band_left, band_mid, band_right, bar_ink))

            # 反向探针：关掉图注后，底部与左下角都必须是干净的
            if '04' in shots:
                img4 = shots['04']['img']
                bare_band = AX.dark_frac(img4, (0, band_top, img4['w'], img4['h']), thr=90)
                bare_bar = AX.dark_frac(img4, bar_box, thr=120)
                log('  · 04 关掉图注：底带近黑 %.4f · 左下角 %.4f' % (bare_band, bare_bar))
                if bare_band > 0.001:
                    fails.append('关掉图注后底带仍有近黑（%.4f）' % bare_band)
                if not (bar_ink > bare_bar + 0.002):
                    fails.append('比例尺没画在图上（有 %.4f / 关掉图注后 %.4f）' % (bar_ink, bare_bar))

            # 道路：关掉之后图面要有差别
            if '02' in shots:
                d = AX.compare(info, shots['02']['img'], region=(0, 0, w, band_top))
                log('  · 02 关掉道路：图面差异 %.3f%%' % (d['frac'] * 100))
                if d['frac'] < 0.008:
                    fails.append('道路几乎没画上去（关掉后只差 %.3f%%）' % (d['frac'] * 100))
                if d['frac'] > 0.5:
                    fails.append('关掉道路竟差 %.0f%%（整幅都变了）—— 图面不该跟着重排' % (d['frac'] * 100))
            # 投影角：换二测后整幅都该变（视角变了），且仍然是一张有内容的图
            if '05' in shots:
                d5 = AX.compare(info, shots['05']['img'], region=(0, 0, w, band_top))
                img5 = shots['05']['img']
                c5 = [AX.px_at(img5, x, y) for (x, y) in [
                    (6, 6), (w - 6, 6), (6, band_top - 6), (w - 6, band_top - 6)]]
                lines5 = AX.dark_frac(img5, (0, 0, w, band_top), thr=120)
                log('  · 05 二测 2:1：与等轴测差 %.2f%% · 四角 %d~%d · 墨线 %.4f'
                    % (d5['frac'] * 100, min(c5), max(c5), lines5))
                if d5['frac'] < 0.05:
                    fails.append('换投影角后画面几乎没变（差 %.2f%%）—— 下拉没接上？' % (d5['frac'] * 100))
                if min(c5) < 180:
                    fails.append('二测那张四角有暗的（最暗 %d）—— 可能整幅跑偏被切' % min(c5))
                if lines5 < 0.004:
                    fails.append('二测那张几乎没有墨线（%.4f）' % lines5)

            # 体块：关掉两栋"只有体块"的建筑，差异要明显
            if '03' in shots:
                d = AX.compare(info, shots['03']['img'], region=(0, 0, w, band_top))
                log('  · 03 关掉体块建筑：图面差异 %.3f%%' % (d['frac'] * 100))
                if d['frac'] < 0.02:
                    fails.append('“只有体块”的建筑没画上去（关掉后只差 %.3f%%）' % (d['frac'] * 100))

        if fails:
            log('\n❌ 聚落鸟瞰有问题：')
            for f in fails:
                log('   - ' + f)
            return 1
        log('\n✅ 聚落鸟瞰出图成功：%s' % OUT_DIR)
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
