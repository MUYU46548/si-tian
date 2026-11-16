#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机演练：建筑占地派生字段（台账 A21，2026-11-16）

这条字段的价值全在“**不陈旧**”三个字上，而陈旧只会在真机上出现：
纯函数单测算得到 912×662，但算不出“改完墙之后节点上那个字段有没有跟着变”。

判据（全部走产品自己的入口，不直接改字段来造结论）：

  h1 造完两层小楼 → 节点上有 footprint，尺寸与墙一致（900+24 外墙 = 9.24 × 6.74 m）
  h10 只读态探针：把写模式切成 readonly 再刷新 → 一个字段都不许动（自查抓到的真 bug）
  h2 几何没变时再刷新一次 → **同一个对象引用**（没有白换引用，说明字段是新鲜的）
  h3 头部信息条出现“整栋 9.2 × 6.7 m · … ㎡”
  h4 拖一面墙的端点 → 字段与信息条一起变
  h4b 落盘载荷里有这条字段，且数值 / 指纹与节点一致（节点 → 项目实体这条路通）
  h5 一次撤销 → 字段与墙现算逐指纹一致（派生字段跟着墙走，不单独占一条 undo）
  h6 把所有墙删光 → 节点上的 footprint **被删掉**（不留 0×0 占位）
  h7 落盘载荷里该实体没有 footprint（空值不落盘）
  h8 负向探针：手动塞一个假字段（指纹对不上）→ 界面**不显示假数**（现算 9.2，而不是 0.0）
  h9 页面零报错

用法：python scripts/tests/drill_footprint_field.py
（与其它要 5180/9222 的演练互斥）
"""
import json
import os
import sys
import time
import base64

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'lib'))
sys.path.insert(0, os.path.dirname(__file__))

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

import drill_exterior_3d as D                                   # noqa: E402
from lib.cdp import CDP, APP_URL, find_page_ws, skip_onboarding, wait_for  # noqa: E402
from lib.helpers import open_harness_project, ensure_data_ready, ensure_test_building  # noqa: E402


def log(msg):
    print(msg, flush=True)


OUT_DIR = os.path.join(os.getcwd(), 'build', 'footprint-field')


def shot(cdp, name):
    """整页截图（只留证据，不参与判据）。"""
    r = cdp.send('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})
    data = base64.b64decode(r['data'])
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, name + '.png')
    with open(path, 'wb') as f:
        f.write(data)
    return path


def text_of(cdp, sel):
    return cdp.eval(
        "(() => { const el = document.querySelector(%s); return el ? el.textContent.trim() : ''; })()"
        % json.dumps(sel)
    ) or ''


def node_field(cdp, bid):
    """节点上的 footprint（原样返回 JSON；没有则 None）。"""
    expr = """(() => {
      const s = %s;
      const n = (s.nodes || []).find(x => x.id === %s);
      return JSON.stringify({ has: !!(n && n.footprint), fp: (n && n.footprint) || null });
    })()""" % (D.STORE, json.dumps(bid))
    v = cdp.eval(expr)
    try:
        obj = json.loads(v) if isinstance(v, str) else v
    except ValueError:
        return {'has': False, 'fp': None}
    return obj or {'has': False, 'fp': None}


def header_text(cdp):
    return text_of(cdp, '[data-testid=building-footprint]')


def main():
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
        cdp.eval("window.__fpErrs = [];"
                 "window.addEventListener('error', e => window.__fpErrs.push(String(e.message || e)));"
                 "window.addEventListener('unhandledrejection', e => window.__fpErrs.push('rejection: ' + String(e.reason)));"
                 "1")

        log('  · 造两层小楼（900×650，外墙 24，两层）…')
        house = D.build_house(cdp, bid)
        log('    %s' % json.dumps(house, ensure_ascii=False))
        time.sleep(0.8)

        # ── h1 造完就有字段，尺寸与墙一致 ─────────────────────────────
        n1 = node_field(cdp, bid)
        log('  · h1 节点字段：%s' % json.dumps(n1, ensure_ascii=False))
        if not n1.get('has'):
            fails.append('h1 画完墙后节点上仍没有 footprint（派生字段没写回）')
        else:
            fp = n1['fp']
            w, h = float(fp.get('w') or 0), float(fp.get('h') or 0)
            if abs(w - 924) > 2:
                fails.append('h1 长边应约 924cm（900 + 外墙 24），实际 %s' % w)
            if abs(h - 674) > 2:
                fails.append('h1 短边应约 674cm（650 + 外墙 24），实际 %s' % h)
            if not fp.get('stamp'):
                fails.append('h1 字段缺指纹（陈旧检测没有依据）')

        # ── h10 只读态探针：不许改内存（这条是自查抓到的真 bug：isReadOnly 是 computed ref，
        #     老写法 typeof === 'function' 恒为 false → 检查形同虚设）──────────────
        ro = D.eval_json(cdp, """(async () => {
          const s = %s, bid = %s;
          const m = await import('/src/store/writeGate.js');
          const n = (s.nodes || []).find(x => x.id === bid);
          const before = n && n.footprint ? n.footprint.stamp : null;
          if (n) n.footprint = { w: 1, h: 1, area: 1, stamp: 'readonly-probe' };
          m.setWriteMode('readonly', 'drill_footprint_field 只读探针');
          let got = null;
          try { got = s.refreshFootprint(bid); } finally { m.setWriteMode('project', ''); }
          const after = n && n.footprint ? n.footprint.stamp : null;
          // 恢复：回到可写后再刷一次，字段应回到正确值
          const restored = s.refreshFootprint(bid);
          return JSON.stringify({
            before,
            returned: got === null ? 'null' : 'object',
            after,           // 必须仍是 readonly-probe（只读态一个字都没动）
            restoredW: restored ? restored.w : null,
            sameBefore: after === 'readonly-probe',
          });
        })()""" % (D.STORE, json.dumps(bid)))
        log('  · h10 只读探针：%s' % json.dumps(ro, ensure_ascii=False))
        if not ro.get('sameBefore'):
            fails.append('h10 只读态下 refreshFootprint 仍改写了节点字段（内存编辑闸门失效）')
        if ro.get('returned') != 'null':
            fails.append('h10 只读态应返回 null（表示没写），实际 %r' % ro.get('returned'))
        if abs(float(ro.get('restoredW') or 0) - 924) > 2:
            fails.append('h10 回到可写后没恢复出正确字段（w=%s）' % ro.get('restoredW'))

        # ── h2 新鲜：再刷新一次必须返回同一引用 ──────────────────────
        same = D.eval_json(cdp, """(() => {
          const s = %s, bid = %s;
          const n = (s.nodes || []).find(x => x.id === bid);
          const before = n && n.footprint;
          const got = s.refreshFootprint(bid);
          // 存一份墙几何快照，给 h5 比对用（撤销后几何必须一模一样）
          const d = s.interiorData[bid];
          const parts = [];
          for (const f of d.floors) for (const w of (f.walls || [])) {
            if (!w || !w.start || !w.end) continue;
            parts.push([w.id, w.start.x, w.start.y, w.end.x, w.end.y, w.thickness].join(','));
          }
          window.__fpWalls0 = parts.sort().join('|');
          return JSON.stringify({ same: before === got, sameStamp: !!(before && got && before.stamp === got.stamp) });
        })()""" % (D.STORE, json.dumps(bid)))
        log('  · h2 引用未变：%s' % json.dumps(same, ensure_ascii=False))
        if not direct_ok(same):
            fails.append('h2 几何没变时刷新仍换了引用（说明每次都在重算/重写，缓存没起作用）')

        # ── h3 头部信息条 ───────────────────────────────────────────
        t3 = header_text(cdp)
        log('  · h3 信息条：%r' % t3)
        shot(cdp, 'header-924')
        if '整栋' not in t3 or '㎡' not in t3:
            fails.append('h3 头部没有整栋占地信息：%r' % t3)
        elif '9.2' not in t3:
            fails.append('h3 信息条尺寸不对（期望含 9.2 m）：%r' % t3)

        # ── h4 拖端点：字段与信息条一起变 ────────────────────────────
        moved = D.eval_json(cdp, """(() => {
          const s = %s, bid = %s;
          const d = s.interiorData[bid];
          const f = d.floors[0];
          // 找第一层的南墙（y=0 那条），把右端点从 900 拖到 1200
          const w = f.walls.find(x => Math.abs((x.start.y||0)) < 0.01 && Math.abs((x.end.y||0)) < 0.01
                                     && Math.abs((x.start.x||0)) < 0.01 && Math.abs((x.end.x||0) - 900) < 1);
          if (!w) return JSON.stringify({ err: 'no-south-wall', walls: f.walls.map(x => [x.start, x.end]) });
          s.updateWall(bid, f.id, w.id, { end: { x: 1200, y: 0 } });
          const n = (s.nodes || []).find(x => x.id === bid);
          return JSON.stringify({ ok: true, w: n && n.footprint ? n.footprint.w : null });
        })()""" % (D.STORE, json.dumps(bid)))
        time.sleep(0.8)
        n4 = node_field(cdp, bid)
        t4 = header_text(cdp)
        log('  · h4 拖后字段：%s / 信息条 %r' % (json.dumps(n4, ensure_ascii=False), t4))
        shot(cdp, 'header-1224')
        if moved.get('err'):
            fails.append('h4 找不到南墙：%s' % moved.get('err'))
        else:
            w4 = float((n4.get('fp') or {}).get('w') or 0)
            if w4 <= 924:
                fails.append('h4 拖长端点后长边没变（仍 %s）' % w4)
            if '12.' not in t4:
                fails.append('h4 信息条没跟着变：%r' % t4)

        # ── h4b 落盘载荷里有这条字段（正面证据：节点 → 项目实体这条路通）
        payload4 = D.eval_json(cdp, """(() => {
          const s = %s, bid = %s;
          const p = s.exportCanvasToProject();
          const e = p && p.entities ? p.entities[bid] : null;
          return JSON.stringify({
            hasField: !!(e && e.footprint),
            w: e && e.footprint ? e.footprint.w : null,
            stamp: e && e.footprint ? e.footprint.stamp : null,
          });
        })()""" % (D.STORE, json.dumps(bid)))
        node_stamp = (node_field(cdp, bid).get('fp') or {}).get('stamp')
        log('  · h4b 载荷字段：%s（节点 stamp=%s）' % (json.dumps(payload4, ensure_ascii=False), node_stamp))
        if not payload4.get('hasField'):
            fails.append('h4b 有墙时落盘载荷里没有 footprint —— 节点 → 项目实体这条路没接上')
        elif abs(float(payload4.get('w') or 0) - 1224) > 2:
            fails.append('h4b 载荷里的长边不是 1224（实际 %s）' % payload4.get('w'))
        elif payload4.get('stamp') != node_stamp:
            fails.append('h4b 载荷里的 stamp 与节点不一致（%s vs %s）' % (payload4.get('stamp'), node_stamp))

        # ── h5 一次撤销：派生字段必须跟着墙走（不陈旧） ──────────────
        # ⚠️ 不按 Ctrl+Z：页面里 App 与 InteriorView 各挂了一个 keydown 处理，
        #    同一事件可能被撤两步（本 drill 两次跑就得到过"撤 1 步 / 撤 2 步"两种结果）。
        #    这里直接调 store.undo()，只验"撤销之后字段有没有跟着变"。
        before_undo = D.eval_json(cdp, """(() => {
          const s = %s, bid = %s;
          const d = s.interiorData[bid];
          const n = (s.nodes || []).find(x => x.id === bid);
          return JSON.stringify({
            label: s.undoLabel || '',
            walls: d.floors.reduce((k, f) => k + (f.walls || []).length, 0),
            w: n && n.footprint ? n.footprint.w : null,
          });
        })()""" % (D.STORE, json.dumps(bid)))
        # 关键区分：撤销是同步的（`cmd.undo()` 同步跑）→ 立刻读一次，
        # 再等 0.9s 读一次。若立刻对、稍后错 = 撤销后被别的东西覆盖（保存链）；
        # 若立刻就错 = 撤销路径根本没刷新字段。这两种的修法完全不同。
        undo_now = D.eval_json(cdp, """(() => {
          const s = %s, bid = %s;
          s.undo();
          const n = (s.nodes || []).find(x => x.id === bid);
          const d = s.interiorData[bid];
          return JSON.stringify({
            immediateW: n && n.footprint ? n.footprint.w : null,
            immediateStamp: n && n.footprint ? n.footprint.stamp : null,
            walls: d.floors.reduce((k, f) => k + (f.walls || []).length, 0),
            label: s.undoLabel || '',
          });
        })()""" % (D.STORE, json.dumps(bid)))
        log('  · h5 撤销瞬间：%s' % json.dumps(undo_now, ensure_ascii=False))
        time.sleep(0.9)
        # 现算一份（走同一份纯函数），与节点上的字段逐指纹比对 —— 不一致就是"字段陈旧"
        consist = D.eval_json(cdp, """(async () => {
          const s = %s, bid = %s;
          const m = await import('/src/interior/footprintField.js');
          const d = s.interiorData[bid];
          const n = (s.nodes || []).find(x => x.id === bid);
          const cur = m.footprintField(d.floors);
          return JSON.stringify({
            same: !!(cur && n && n.footprint && cur.stamp === n.footprint.stamp
                     && cur.w === n.footprint.w && cur.h === n.footprint.h),
            computedW: cur ? cur.w : null,
            fieldW: n && n.footprint ? n.footprint.w : null,
            walls: d.floors.reduce((k, f) => k + (f.walls || []).length, 0),
            label: s.undoLabel || '',
          });
        })()""" % (D.STORE, json.dumps(bid)))
        t5 = header_text(cdp)
        log('  · h5 撤销前：%s' % json.dumps(before_undo, ensure_ascii=False))
        log('  · h5 撤销后：%s / 信息条 %r' % (json.dumps(consist, ensure_ascii=False), t5))
        if not consist.get('same'):
            fails.append('h5 撤销后节点字段与墙现算不一致（field=%s / computed=%s）—— 派生字段陈旧'
                         % (consist.get('fieldW'), consist.get('computedW')))
        if consist.get('walls') == before_undo.get('walls') and consist.get('fieldW') == before_undo.get('w'):
            fails.append('h5 撤销没有产生任何变化（墙数 %s，尺寸 %s）—— 这条判据在空转'
                         % (consist.get('walls'), consist.get('fieldW')))
        # 信息条必须与字段同一口径（不能出现"信息条 12.2、字段 9.2"这种分裂）
        fp_now = node_field(cdp, bid).get('fp') or {}
        if fp_now.get('w') and '%.1f' % (float(fp_now['w']) / 100) not in t5:
            fails.append('h5 信息条与节点字段不一致：字段 %s cm，信息条 %r' % (fp_now.get('w'), t5))

        w5 = float(fp_now.get('w') or 0)
        if not (w5 > 0):
            fails.append('h5 撤销后字段消失了（应有墙）')

        # 诊断：撤销之后手动刷新一次 —— 若手动能把字段修正，说明 refreshFootprint 本身没问题，
        # 是撤销路径没走到它（下一步就查通知链）。
        manual = D.eval_json(cdp, """(() => {
          const s = %s, bid = %s;
          const n = (s.nodes || []).find(x => x.id === bid);
          const before = n && n.footprint ? n.footprint.w : null;
          const got = s.refreshFootprint(bid);
          return JSON.stringify({ before, after: got ? got.w : null, changed: before !== (got ? got.w : null) });
        })()""" % (D.STORE, json.dumps(bid)))
        log('  · h5 诊断-手动刷新：%s' % json.dumps(manual, ensure_ascii=False))

        # ── h8 负向探针：塞假字段，界面不许显示假数 ─────────────────
        fake = D.eval_json(cdp, """(() => {
          const s = %s, bid = %s;
          const n = (s.nodes || []).find(x => x.id === bid);
          n.footprint = { w: 1, h: 1, area: 1, stamp: 'deadbeef' };
          const iv = document.querySelector('.interior-container').__vueParentComponent.setupState;
          // 等一拍再读 computed（Vue 的 DOM/计算更新是异步的）
          return new Promise(resolve => setTimeout(() => resolve(JSON.stringify({
            text: document.querySelector('[data-testid=building-footprint]') ? document.querySelector('[data-testid=building-footprint]').textContent.trim() : '',
            source: iv.buildingFootprint ? iv.buildingFootprint.source : null,
            w: iv.buildingFootprint ? iv.buildingFootprint.w : null,
          })), 120));
        })()""" % (D.STORE, json.dumps(bid)))
        log('  · h8 假字段：%s' % json.dumps(fake, ensure_ascii=False))
        if '9.2' not in (fake.get('text') or ''):
            fails.append('h8 指纹对不上时界面没现算（读到 %r）—— 假字段被当真了' % fake.get('text'))
        if fake.get('source') != 'computed':
            fails.append('h8 读侧来源应为 computed，实际 %r' % fake.get('source'))

        # ── h6 删光墙：字段被删掉 ───────────────────────────────────
        cleared = D.eval_json(cdp, """(() => {
          const s = %s, bid = %s;
          const d = s.interiorData[bid];
          for (const f of d.floors.slice()) {
            (f.walls || []).slice().forEach(w => s.removeWall(bid, f.id, w.id));
          }
          const n = (s.nodes || []).find(x => x.id === bid);
          return JSON.stringify({ has: !!(n && n.footprint), text: document.querySelector('[data-testid=building-footprint]') ? document.querySelector('[data-testid=building-footprint]').textContent.trim() : '' });
        })()""" % (D.STORE, json.dumps(bid)))
        time.sleep(0.8)
        n6 = node_field(cdp, bid)
        t6 = header_text(cdp)
        log('  · h6 删光墙后字段：%s / 信息条 %r' % (json.dumps(n6, ensure_ascii=False), t6))
        if n6.get('has'):
            fails.append('h6 墙删光后节点上仍留着 footprint（0×0 占位不该落盘）')
        if t6:
            fails.append('h6 没有墙时信息条还显示：%r' % t6)

        # ── h7 落盘载荷里没有该字段 ─────────────────────────────────
        payload = D.eval_json(cdp, """(() => {
          const s = %s, bid = %s;
          const p = s.exportCanvasToProject();
          const e = p && p.entities ? p.entities[bid] : null;
          return JSON.stringify({ hasEntity: !!e, hasField: !!(e && e.footprint) });
        })()""" % (D.STORE, json.dumps(bid)))
        log('  · h7 载荷：%s' % json.dumps(payload, ensure_ascii=False))
        if not payload.get('hasEntity'):
            fails.append('h7 载荷里找不到该建筑实体（导出路径坏了）')
        if payload.get('hasField'):
            fails.append('h7 墙已删光，载荷里仍有 footprint（空值不落盘没接上）')

        # ── h9 页面零报错 ───────────────────────────────────────────
        errs = cdp.eval("(window.__fpErrs || []).slice(0, 5)") or []
        if errs:
            fails.append('h9 页面报错：%s' % errs)

        if fails:
            log('\n[FAIL] A21 占地派生字段没通过：')
            for f in fails:
                log('  - %s' % f)
            return 1
        log('\n[PASS] A21 占地派生字段 11/11 全通过')
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


def direct_ok(same):
    """h2 的返回可能是 dict（eval_json 已解析）—— 统一成布尔。"""
    if isinstance(same, dict):
        return bool(same.get('same'))
    return bool(same)


if __name__ == '__main__':
    sys.exit(main())
