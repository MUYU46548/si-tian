#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 178：楼梯（2026-11-15，台账 A24 / A16 / A14）

之前能画两层楼，但**没有楼梯、没有楼板洞口、`floor.elevation` 视图不读** ——
一套两层的房子在 3D 里是两块悬空楼板，人走不上去。

本用例守六件事（判据都走 `eval_json`，JS 抛异常 = 直接红，不会静默假绿）：
  a) UI 真的能进楼梯工具：点工具栏「楼梯」按钮 → interactionMode = add_stairs
  b) 两次点击画出一跑（走组件自己的 `handleStairClick`，等价于鼠标点两下）：
     落库 1 部、`steps` 存 0（自动）、级数按层高算成 17
  c) 浮窗能改：级数 12 → 落库 12；撤销一次 → 回自动
  d) 楼板洞口：`stairHolesForFloor` 给上一层 1 个洞，且洞面积 > 梯段投影（罩得住）
  e) 3D 外壳：踏步盒数 = 级数、楼板被切成多块、`stats.stairs = 1`；屋顶「不封顶」时 roof = null
  f) 平面图绘制真能跑（离屏 canvas 调 `drawInteriorFloor`）：stat.stairs = 1，不抛异常
"""
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json                              # noqa: E402
from lib.helpers import ensure_data_ready, ensure_test_building      # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
IV = "document.querySelector('.interior-container').__vueParentComponent.setupState"
EXTERIOR_READY = ("(() => { const v = document.querySelector('[data-testid=exterior-view]');"
                  " if (!v) return false;"
                  " return !!v.querySelector('[data-testid=exterior-canvas]')"
                  " || !!v.querySelector('[data-testid=exterior-fallback]'); })()")


def run(cdp):
    ensure_data_ready(cdp)
    cdp.eval("window.__stairErrs = []; window.addEventListener('error', "
             "e => window.__stairErrs.push(String(e.message || e))); 1")
    okb, binfo = ensure_test_building(cdp)
    if not okb:
        return False, '建筑 fixture 失败：%s' % str(binfo)[:200]
    bid = binfo['id']
    wait_for(cdp, "!!document.querySelector('.interior-container')", timeout=30, desc='内部视图挂载')

    ok, res = eval_json(cdp, """(async () => {
      const fails = [];
      const detail = {};
      const s = %s;
      const iv = %s;
      const bid = %s;

      // ── 准备：两层楼 + 一层画一个 800×600 的房间（楼板要有矩形，才可能被挖洞）──
      let d = s.interiorData[bid] || {};
      if (!(d.floors || []).length) s.addFloor(bid, '一层');
      d = s.interiorData[bid];
      if ((d.floors || []).length < 2) s.addFloor(bid, '二层');
      d = s.interiorData[bid];
      const f1 = d.floors[0];
      const f2 = d.floors[1];
      // 清掉历史残留（墙 / 楼梯都清）
      for (const f of [f1, f2]) {
        (f.walls || []).slice().forEach(w => s.removeWall(bid, f.id, w.id));
        (f.stairs || []).slice().forEach(st => s.removeStair(bid, f.id, st.id));
      }
      iv.editMode = true;
      iv.selectFloor(f1.id);

      const pts = [[-400, -300], [400, -300], [400, 300], [-400, 300]];
      // 两层都画同尺寸的墙：楼板是由墙端点矩形推出来的，上层没墙就没有"楼板"可挖洞
      for (const f of [f1, f2]) {
        for (let i = 0; i < 4; i++) {
          const p0 = pts[i], p1 = pts[(i + 1) %% 4];
          s.addWall(bid, f.id, { start: { x: p0[0], y: p0[1] }, end: { x: p1[0], y: p1[1] }, thickness: 12 });
        }
      }
      // 🔴 Vue 的 DOM 更新是异步的：读完 editMode 立刻查工具栏会查不到（本仓踩过多次）
      const tick = () => new Promise(r => setTimeout(r, 0));
      await tick();
      d = s.interiorData[bid];
      detail.elev = { f1: f1.elevation, f2: f2.elevation };
      if (Math.abs((Number(f2.elevation) || 0) - 300) > 1) {
        fails.push('a0 两层标高不对：期望 0 / 300，实际 ' + f1.elevation + ' / ' + f2.elevation);
      }

      // ── a) 工具栏「楼梯」按钮真的能进工具 ──
      const btns = Array.from(document.querySelectorAll('.edit-toolbar button'));
      const stairBtn = btns.find(b => (b.textContent || '').includes('楼梯'));
      if (!stairBtn) {
        fails.push('a1 编辑工具栏里找不到「楼梯」按钮');
      } else {
        stairBtn.click();
        if (iv.interactionMode !== 'add_stairs') {
          fails.push('a2 点「楼梯」后工具没切过去，实际 ' + iv.interactionMode);
        }
      }
      await tick();
      // A14：本层标高在界面上有读数
      const elevEl = document.querySelector('[data-testid=floor-elevation]');
      if (!elevEl || !(elevEl.textContent || '').includes('地面')) {
        fails.push('a3 楼层条没有显示本层标高（A14 未接进视图）');
      }
      const autoHint = document.querySelector('[data-testid=stair-auto-hint]');
      detail.autoHint = autoHint ? (autoHint.textContent || '').trim() : null;
      if (!autoHint || !/17\\s*级/.test(detail.autoHint || '')) {
        fails.push('a4 楼梯工具里没有显示"自动 17 级"，实际：' + detail.autoHint);
      }

      // ── b) 两次点击画一跑（走组件真实入口）──
      iv.startStairTool();
      await tick();
      iv.handleStairClick(-300, 0);
      iv.handleStairClick(-300, 320);
      await tick();
      d = s.interiorData[bid];
      const f1b = d.floors.find(f => f.id === f1.id);
      const st1 = (f1b.stairs || [])[0];
      detail.stair = st1 ? { start: st1.start, end: st1.end, width: st1.width, steps: st1.steps } : null;
      if (!st1) {
        fails.push('b1 点了两下没有落库楼梯');
        return JSON.stringify({ fails, detail });
      }
      if (st1.steps !== 0) fails.push('b2 新画的楼梯应存 steps=0（自动），实际 ' + st1.steps);
      if (!(st1.width >= 40)) fails.push('b3 梯宽没有落库，实际 ' + st1.width);
      if (iv.stairsDraftStart) fails.push('b4 画完之后草稿起点没有清掉（会连着画第二跑）');
      if (!iv.editingStair || iv.selectedStairId !== st1.id) {
        fails.push('b5 画完没有选中并打开浮窗（用户看不出刚画了什么）');
      }

      // 级数按层高自动算：300 / 17.5 ≈ 17
      const stairsMod = await import('/src/interior/stairs.js');
      const auto = stairsMod.stairStepCount(st1, 300);
      detail.autoSteps = auto;
      if (auto !== 17) fails.push('b6 自动级数应为 17（300cm / 17.5cm），实际 ' + auto);
      if (!document.querySelector('[data-testid=stair-popover]')) {
        fails.push('b7 楼梯浮窗没渲染出来');
      }
      const targetEl = document.querySelector('[data-testid=stair-target]');
      detail.target = targetEl ? (targetEl.textContent || '').trim() : null;
      if (!detail.target || !detail.target.includes('二层') && !detail.target.includes('上一')) {
        fails.push('b8 浮窗没说清"通到哪一层"，实际：' + detail.target);
      }

      // ── c) 浮窗改级数 → 落库；撤销一次 → 回自动 ──
      iv.stairForm.steps = 12;
      iv.saveStairEdit();
      let cur = (s.interiorData[bid].floors.find(f => f.id === f1.id).stairs || [])[0];
      if (!cur || cur.steps !== 12) fails.push('c1 改级数 12 没落库，实际 ' + (cur && cur.steps));
      s.undo();
      cur = (s.interiorData[bid].floors.find(f => f.id === f1.id).stairs || [])[0];
      if (!cur || cur.steps !== 0) fails.push('c2 撤销一次没回到"自动"，实际 ' + (cur && cur.steps));
      detail.stepsAfterUndo = cur && cur.steps;

      // ── d) 楼板洞口（A16）──
      d = s.interiorData[bid];
      const holes = stairsMod.stairHolesForFloor(d.floors, f2.id);
      const fp = stairsMod.stairFootprint(cur);
      const areaOf = (poly) => {
        let sum = 0;
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], b = poly[(i + 1) %% poly.length];
          sum += a.x * b.y - b.x * a.y;
        }
        return Math.abs(sum / 2);
      };
      detail.holes = holes.length;
      detail.holeArea = holes[0] ? Math.round(areaOf(holes[0].poly)) : 0;
      detail.fpArea = Math.round(areaOf(fp.poly));
      if (holes.length !== 1) fails.push('d1 二层楼板应有 1 个洞，实际 ' + holes.length);
      else if (!(detail.holeArea > detail.fpArea)) {
        fails.push('d2 洞口比梯段还小（楼梯会穿楼板）：' + detail.holeArea + ' vs ' + detail.fpArea);
      }

      // ── e) 3D 外壳（A24/A16）──
      const shellMod = await import('/src/interior/buildShell.js');
      const shell = shellMod.buildBuildingShell(d.floors, { roof: { kind: 'flat' } });
      const stepBoxes = shell.boxes.filter(b => b.kind === 'stair');
      const slabs = shell.boxes.filter(b => b.kind === 'slab');
      detail.shell = { steps: stepBoxes.length, slabs: slabs.length, statsStairs: shell.stats.stairs };
      if (stepBoxes.length !== 17) fails.push('e1 3D 踏步盒应为 17（自动级数），实际 ' + stepBoxes.length);
      if (shell.stats.stairs !== 1) fails.push('e2 stats.stairs 应为 1，实际 ' + shell.stats.stairs);
      if (slabs.length < 2) fails.push('e3 楼板没被洞口切碎，实际 ' + slabs.length + ' 块');
      const topY = Math.max(...stepBoxes.map(b => b.cy + b.sy / 2));
      detail.stairTop = Math.round(topY);
      if (Math.abs(topY - 300) > 1e-6) fails.push('e4 最后一级踏面应落在 300cm（二层地面），实际 ' + topY);
      const noRoof = shellMod.buildBuildingShell(d.floors, { roof: { kind: 'none' } });
      if (noRoof.roof !== null) fails.push('e5 屋顶选「不封顶」时仍生成了屋顶');

      // ── f) 平面图绘制真的能跑（抛异常会被 canvas 循环吞掉）──
      const rf = await import('/src/interior/renderFloor.js');
      const cv = document.createElement('canvas');
      cv.width = 800; cv.height = 600;
      let stat = null;
      try {
        stat = rf.drawInteriorFloor(cv.getContext('2d'), d.floors.find(f => f.id === f1.id), {
          zoom: 0.5, theme: 'print', holes,
          stairContext: () => ({ ownElevation: 0, targetElevation: 300 }),
        });
      } catch (err) {
        fails.push('f1 平面图画楼梯抛异常：' + (err && err.message ? err.message : String(err)));
      }
      detail.stat = stat;
      if (stat && stat.stairs !== 1) fails.push('f2 平面图没画楼梯，stat.stairs = ' + stat.stairs);

      // ── g) 删除 + 撤销 ──
      iv.startStairEdit(cur);
      iv.deleteSelectedStair();
      const after = (s.interiorData[bid].floors.find(f => f.id === f1.id).stairs || []).length;
      if (after !== 0) fails.push('g1 删除楼梯后仍有 ' + after + ' 部');
      s.undo();
      const back = (s.interiorData[bid].floors.find(f => f.id === f1.id).stairs || []).length;
      if (back !== 1) fails.push('g2 撤销一次没把楼梯恢复，实际 ' + back);

      // 不清场：Python 侧还要拿这栋两层楼导两张图（平面图 + 3D）做人工复核
      iv.cancelStairEdit();
      iv.editMode = false;
      iv.selectFloor(f1.id);
      return JSON.stringify({ fails, detail });
    })()""" % (STORE, IV, json.dumps(bid)), required=('fails',), desc='楼梯')

    if not ok:
        return False, res
    fails = res.get('fails') or []
    detail = res.get('detail') or {}

    # ── 留证图（不是判据，是给人看的）：平面图 + 真 3D（屋顶设成不封顶）──
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    out_dir = os.path.join(root, 'build', 'interior-stairs')
    os.makedirs(out_dir, exist_ok=True)

    def _save(data_url, name):
        if isinstance(data_url, str) and data_url.startswith('data:image'):
            import base64
            with open(os.path.join(out_dir, name), 'wb') as fh:
                fh.write(base64.b64decode(data_url.split(',', 1)[1]))
            return True
        return False

    def _shot(name):
        """整页截图（3D 只能这样拍：主视口 renderer 是 preserveDrawingBuffer:false，
        `canvas.toDataURL()` 拿回来是一张全黑）。顺带自检不是空白。"""
        import base64
        try:
            raw = cdp.send('Page.captureScreenshot', {'format': 'png'})
            data = raw.get('data') if isinstance(raw, dict) else None
            if not data:
                return False
            with open(os.path.join(out_dir, name), 'wb') as fh:
                fh.write(base64.b64decode(data))
            try:
                from PIL import Image, ImageStat
                sd = ImageStat.Stat(Image.open(os.path.join(out_dir, name)).convert('L')).stddev[0]
                shots['sd_' + name] = round(sd, 1)
            except Exception:
                pass
            return True
        except Exception:
            return False

    shots = {}
    try:
        cdp.eval("new Promise(r => { try { %s.renderer.requestRender(); } catch (e) {} "
                 "requestAnimationFrame(() => requestAnimationFrame(() => r(1))); })" % IV)
        shots['plan'] = _save(
            cdp.eval("document.querySelector('.interior-container canvas').toDataURL('image/png')"),
            'test-178-plan.png')
    except Exception:
        pass
    try:
        # 3D：真起 three、真渲染（屋顶要点成"不封顶"才看得见楼梯与楼板洞口）
        cdp.eval("(() => { %s.showExterior = true; return 1; })()" % IV)
        wait_for(cdp, "!!document.querySelector('[data-testid=exterior-view]')", timeout=15, desc='外观浮层出现')
        wait_for(cdp, EXTERIOR_READY, timeout=25, desc='3D 画布或退路出现')
        cdp.eval("(() => { const sel = document.querySelector('[data-testid=exterior-roof-kind]');"
                 " if (sel) { sel.value = 'none'; sel.dispatchEvent(new Event('change')); } return 1; })()")
        cdp.eval("new Promise(r => setTimeout(r, 900))")
        shots['exterior'] = _shot('test-178-3d.png')
        # 再把机位抬到俯视：默认机位偏低，楼梯与楼板洞口被前墙挡住（取景问题，不是产品缺陷）。
        # 直接操 OrbitControls，拍一张能看内部结构的图给人复核。
        shots['cam'] = cdp.eval("""(() => {
          const el = document.querySelector('[data-testid=exterior-view]');
          const ex = el && el.__vueParentComponent && el.__vueParentComponent.setupState;
          if (!ex || !ex.camera || !ex.controls) return 'no-camera';
          const t = ex.controls.target.clone();
          const d = ex.camera.position.distanceTo(t);
          const dir = new (ex.camera.position.constructor)(0.42, 1.5, 0.62).normalize();
          ex.camera.position.copy(t).addScaledVector(dir, d * 0.95);
          ex.camera.lookAt(t);
          ex.controls.update();
          return 'moved';
        })()""")
        cdp.eval("new Promise(r => setTimeout(r, 600))")
        shots['exterior_top'] = _shot('test-178-3d-top.png')
        shots['stats'] = cdp.eval("(document.querySelector('[data-testid=exterior-stats]') || {}).textContent || ''")
        cdp.eval("(() => { %s.showExterior = false; return 1; })()" % IV)
    except Exception as e:      # noqa: BLE001
        shots['err'] = str(e)[:200]

    # 清场：墙 + 楼梯都删掉（恢复用例前的样子）
    cleanup = ("(() => { const s = %s, bid = %s; const d = s.interiorData[bid] || {};"
               " for (const f of (d.floors || [])) {"
               " (f.walls || []).slice().forEach(w => s.removeWall(bid, f.id, w.id));"
               " (f.stairs || []).slice().forEach(st => s.removeStair(bid, f.id, st.id)); }"
               " return JSON.stringify({ ok: 1 }); })()")
    try:
        cdp.eval(cleanup % (STORE, json.dumps(bid)))
    except Exception:
        pass

    errs = cdp.eval("JSON.stringify(window.__stairErrs || [])")
    if isinstance(errs, str) and errs not in ('[]', ''):
        fails.append('页面错误：' + errs[:300])

    if fails:
        return False, '；'.join(fails) + ' ｜ ' + json.dumps(detail, ensure_ascii=False)[:400]
    return True, json.dumps(detail, ensure_ascii=False)[:400]
