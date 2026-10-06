#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 44：EU4 式斜线占领渲染（真实画布像素语义断言）

断言的是「语义」不是「没报错」：
  · 易主落定**前**：该省只有旧主色（纯色，无斜线）
  · 易主落定**后**：旧主色与新主色**同时存在**（= 斜线占领，两方本色）
  · 关掉变化图层：只剩新主色
  · 未易主的省：任何时刻都只有自己的势力色

采样方式：按相机变换把省份包围盒换算到画布像素，对像素做「到期望混合色的距离」归类。
"""
import sys, os, json, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json
from lib.helpers import ensure_data_ready, open_test_base_map

SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"

# 复用的像素普查器（注入一次，后续多次调用）
CENSUS = r"""
window.__census = function (provId) {
  const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const cv = document.querySelector('.scenario-canvas-wrap canvas');
  if (!cv) return { err: 'no-canvas' };
  const g = cv.getContext('2d');
  const prov = (sm.baseMap.terrain || []).find(p => p.id === provId);
  if (!prov) return { err: 'no-prov' };
  const tl = sm.timeline, k = sm.tlEra;
  const own = (sc, id) => { const p = (sc.polities || []).find(x => x.id === id); return p ? p.color : '#4a5568'; };
  const oldId = tl.scenarios[k - 1] ? tl.scenarios[k - 1].ownership[provId] : null;
  const newId = tl.scenarios[k].ownership[provId];
  const oldCol = oldId ? own(tl.scenarios[k - 1], oldId) : null;
  const newCol = own(tl.scenarios[k], newId);
  const rgb = h => { h = h.replace('#',''); return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)]; };
  const mix = (a, b, t) => rgb(a).map((v, i) => Math.round(v + (rgb(b)[i] - v) * t));

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of prov.points) {
    const x = p.x !== undefined ? p.x : p[0];
    const y = p.y !== undefined ? p.y : p[1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const sc = sm.cameraScale;
  const x0 = Math.max(0, Math.floor(minX * sc + sm.cameraX));
  const y0 = Math.max(0, Math.floor(minY * sc + sm.cameraY));
  const x1 = Math.min(cv.width,  Math.ceil(maxX * sc + sm.cameraX));
  const y1 = Math.min(cv.height, Math.ceil(maxY * sc + sm.cameraY));
  if (x1 - x0 < 4 || y1 - y0 < 4) {
    return { err: 'off-screen', box: [x0, y0, x1 - x0, y1 - y0], scale: sc,
             cam: [Math.round(sm.cameraX), Math.round(sm.cameraY)] };
  }
  const img = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  // 期望色：底色 = 纯旧主（drawProvinces 未设 globalAlpha）；斜线 = 0.92 新主 + 0.08 底色
  const pureOld = oldCol ? rgb(oldCol) : null;
  const pureNew = rgb(newCol);
  const stripe = oldCol ? mix(oldCol, newCol, 0.92) : pureNew;
  const near = (px, ref, tol) => Math.hypot(px[0]-ref[0], px[1]-ref[1], px[2]-ref[2]) < tol;
  let nOld = 0, nNew = 0, nStripe = 0, nOther = 0;
  for (let i = 0; i < img.length; i += 4) {
    const px = [img[i], img[i+1], img[i+2]];
    if (pureOld && near(px, pureOld, 26)) nOld++;
    else if (near(px, pureNew, 26)) nNew++;
    else if (near(px, stripe, 26)) nStripe++;
    else nOther++;
  }
  return { oldCol, newCol, nOld, nNew, nStripe, nOther,
           box: [x0, y0, x1 - x0, y1 - y0], era: k, year: Math.round(sm.tlYear) };
};
"""


def _enter(cdp):
    r = cdp.eval("""(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('历史剧本'));
      if (!b) return 'no-btn';
      b.click(); return 'ok';
    })()""")
    if r != 'ok':
        return r
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", desc='ScenarioMap 挂载', timeout=8)
    return 'ok'


def _seed_js(cdp):
    """两省两块：甲时代 A1 独占；乙时代 prov_a→B1（不变谱系）/ prov_b→B2（新谱系 → 易主）
    —— 返回 JS 源（判定一律走 eval_json，见 lib/cdp.py 的说明）"""
    return """(() => {
      const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
      for (const k of Object.keys(s.scenarios)) s.removeScenario(k);
      if (!s.baseMaps['云陇大陆']) s.addBaseMap('云陇大陆', { name: '云陇大陆' });
      s.baseMaps['云陇大陆'].terrain.length = 0;
      const mk = (id, x0) => ({ id, name: '',          // 空名 → 不画省名，避免文字像素干扰采样
        points: [{x:x0,y:200},{x:x0+240,y:200},{x:x0+240,y:440},{x:x0,y:440}],
        biome: 'temperate', coast: true });
      ['prov_a','prov_b'].forEach((id, i) => s.addBaseProvince('云陇大陆', mk(id, 300 + i*400)));
      const P = (id, name, color) => ({ id, name, color });
      s.createScenario('云陇大陆/甲时代', {
        ownerKey: '云陇大陆', name: '甲时代', order: 1,
        era: { roman: 'Ⅰ', label: '甲', startYear: '2000', endYear: '2010' },
        polities: [P('A1','甲国','#c23b3b')],
        ownership: { prov_a:'A1', prov_b:'A1' },
      });
      s.createScenario('云陇大陆/乙时代', {
        ownerKey: '云陇大陆', name: '乙时代', order: 2,
        era: { roman: 'Ⅱ', label: '乙', startYear: '2010', endYear: '2020' },
        polities: [P('B1','乙国','#4a90d9'), P('B2','乙南','#e6a23c')],
        ownership: { prov_a:'B1', prov_b:'B2' },
      });
      return JSON.stringify({scenarios: Object.keys(s.scenarios).length});
    })()"""


def _census(cdp, prov):
    """像素普查。`required=None` 是刻意的：`__census` 的**合法**返回里就有 `{err:'no-canvas'|'no-prov'|'off-screen'}`
    （判据是 err 而不是缺字段）。但 JS 抛异常（`__err__`）必须在这里翻成显式的失败 —— 见 lib/cdp.py 的 eval_json 说明。"""
    ok, obj = eval_json(cdp, f"JSON.stringify(window.__census('{prov}'))", required=None,
                        desc=f'像素普查 {prov}')
    if not ok:
        return {'err': f'普查探针失败：{obj}'}
    return obj if isinstance(obj, dict) else {'err': f'普查返回非对象：{obj}'}


def run(cdp):
    ensure_data_ready(cdp)
    r = _enter(cdp)
    if r != 'ok':
        return False, f'进入剧本模式失败: {r}'
    # 底图 fixture：司天不再默认建/选示例底图（见 helpers.open_test_base_map 说明）
    bm_ok, bm_info = open_test_base_map(cdp, '云陇大陆')
    if not bm_ok:
        return False, f'底图 fixture 未就位: {bm_info}'
    seed_ok, seed = eval_json(cdp, _seed_js(cdp), required=('scenarios',), desc='注入 2 省 + 2 剧本')
    if not seed_ok:
        return False, f'数据注入探针失败: {seed}'
    if seed['scenarios'] != 2:
        return False, f'数据注入失败: {seed}'
    cdp.eval(CENSUS)
    time.sleep(0.3)

    # 适屏 + 定位到乙时代
    # 🔴 月日精度（2026-10-05）：游标真源是 `tlDate`（`{y,m,d}` ref），`tlYear` 已降为**只读 computed**
    #    （`dateToYearValue(tlDate)`）。旧写法 `s.tlYear = 2020` 现在只会换来一条 Vue warn：值不变。
    setup_ok, setup = eval_json(cdp, f"""(async () => {{
      const s = {SM};
      s.fitToView();
      s.tlDiffMode = 'eu4';
      s.tlDate = {{ y: 2020, m: null, d: null }};   // 乙时代末年 → prov_b 的易主已落定
      // ⚠️ `tlEra` 是 `watch(tlDate.y)` 的派生（Vue watcher 默认 flush:'pre' = 异步）→
      //    写完 tlDate **立刻**读 tlEra 会拿到旧值（首版实测 era:0）。必须等一个 tick。
      await new Promise(r => setTimeout(r, 80));
      return JSON.stringify({{diffMode: s.tlDiffMode, year: Math.round(s.tlYear), era: s.tlEra}});
    }})()""", required=('diffMode', 'year', 'era'), desc='适屏 + 定位到乙时代')
    if not setup_ok:
        return False, f'定位游标探针失败: {setup}'
    time.sleep(0.5)
    if setup.get('diffMode') != 'eu4':
        return False, f'变化图层未设为 eu4: {setup}'
    if setup.get('year') != 2020 or setup.get('era') != 1:
        return False, f'游标未落到乙时代末年 2020（tlDate 写入无效？）: {setup}'

    pre_ok, pre = eval_json(cdp, f"""(() => {{
      const s = {SM};
      const ev = s.timeline.eraChg[1].lastDate.prov_b;
      return JSON.stringify({{era: s.tlEra, year: Math.round(s.tlYear),
                              changeDate: {{ y: ev.y, m: ev.m, d: ev.d }},
                              explicit: !!ev.explicit, synthesized: !!ev.synthesized,
                              changed: s.timeline.eraChg[1].changed}});
    }})()""", required=('era', 'year', 'changeDate', 'changed'), desc='用例前提')
    if not pre_ok:
        return False, f'前提探针失败: {pre}'
    if pre['era'] != 1:
        return False, f'游标未落在乙时代: {pre}'
    if pre['changed'] != ['prov_b']:
        return False, f'用例前提不成立（应只有 prov_b 易主）: {pre}'
    if not pre['changeDate'].get('y'):
        return False, f'用例前提不成立（prov_b 缺易主日期）: {pre}'

    # ---------- 1. 落定前：只有旧主色 ----------
    # 「落定前」= 查询日期早于**该省最后一条易主日期**（月日精度下是日期比较，不再是「年份 -1」）
    before_ok, before = eval_json(cdp, f"""(() => {{
      const s = {SM};
      const ev = s.timeline.eraChg[1].lastDate.prov_b;
      s.tlDate = {{ y: ev.y - 1, m: null, d: null }};
      return JSON.stringify({{year: Math.round(s.tlYear), changeDate: {{y: ev.y, m: ev.m, d: ev.d}}}});
    }})()""", required=('year', 'changeDate'), desc='落定前定位')
    if not before_ok:
        return False, f'落定前定位探针失败: {before}'
    time.sleep(0.45)
    b = _census(cdp, 'prov_b')
    if b.get('err'):
        return False, f'落定前采样失败: {b}'
    # 此时归属仍是旧主（A1）→ 底色纯旧主，**不应出现任何新主色**
    if b['nOld'] < 200:
        return False, f'落定前应有大量旧主色像素: {b}'
    if b['nNew'] > 40:
        return False, f'落定前不应出现新主色: {b}'

    # ---------- 2. 落定后：旧主底色 + 新主斜线**共存** ----------
    # 注意：斜线以 0.92 不透明度叠上去，像素≈纯新主色，所以「共存」的判据是
    # 旧主色与新主色**同时大量存在**，而不是去找一个中间混合色。
    after_ok, after = eval_json(cdp, f"""(() => {{
      const s = {SM};
      s.tlDate = {{ y: 2020, m: null, d: null }};
      return JSON.stringify({{year: Math.round(s.tlYear)}});
    }})()""", required=('year',), desc='落定后定位')
    if not after_ok:
        return False, f'落定后定位探针失败: {after}'
    time.sleep(0.45)
    a = _census(cdp, 'prov_b')
    if a.get('err'):
        return False, f'落定后采样失败: {a}'
    if a['nOld'] < 100:
        return False, f'落定后底色应仍为旧主色（EU4 占领的关键）: {a}'
    if a['nNew'] < 100:
        return False, f'落定后应出现新主色斜线: {a}'

    # ---------- 3. 未易主的省：任何时刻只有自己的色 ----------
    u = _census(cdp, 'prov_a')
    if u.get('err'):
        return False, f'未易主省采样失败: {u}'
    if u['nNew'] < 200:
        return False, f'未易主省应为其势力纯色（B1 蓝）: {u}'
    if u['nOld'] > 40:
        return False, f'未易主省不应出现旧主色: {u}'

    # ---------- 4. 关掉变化图层：只剩新主色 ----------
    off_ok, off = eval_json(cdp, f"""(() => {{
      const s = {SM};
      s.tlDiffMode = 'off';
      return JSON.stringify({{mode: s.tlDiffMode}});
    }})()""", required=('mode',), desc='关掉变化图层')
    if not off_ok:
        return False, f'关图层探针失败: {off}'
    time.sleep(0.45)
    o = _census(cdp, 'prov_b')
    if o.get('err'):
        return False, f'关图层后采样失败: {o}'
    if o['nNew'] < 200:
        return False, f'关图层后应为新主纯色: {o}'
    if o['nOld'] > 40:
        return False, f'关图层后不应残留旧主底色: {o}'

    # ---------- 5. 白描边模式也能用（同一 API） ----------
    ol_ok, ol = eval_json(cdp, f"""(() => {{
      const s = {SM};
      s.tlDiffMode = 'outline';
      return JSON.stringify({{mode: s.tlDiffMode}});
    }})()""", required=('mode',), desc='白描边模式')
    if not ol_ok:
        return False, f'白描边模式探针失败: {ol}'
    time.sleep(0.4)
    if ol.get('mode') != 'outline':
        return False, f'白描边模式未切到: {ol}'

    return True, (f'落定前(年{before["year"]}) 旧主{b["nOld"]}/新主{b["nNew"]}'
                  f' → 落定后(年{after["year"]}) 旧主{a["nOld"]}+新主{a["nNew"]} 共存（斜线占领）'
                  f' → 未易主省纯色{u["nNew"]}'
                  f' → 关图层后纯新主{o["nNew"]}/旧主{o["nOld"]}'
                  f' → 白描边模式可达')
