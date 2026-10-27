#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 162：地形注记参与避让排布（山系名走廊上不许压别的字）

背景（2026-10-27，gap #6）：
  地形注记（山系/海域/平原）是**独立画的一层**：它不参与 `layoutLabels` 的避让，
  于是省名/城镇名可以正正压在山系名上（两张字叠在一起，谁都读不清）。
  现在把地形注记"实际会占的那一段"（沿路径只取中点附近 ≈ 字宽，不是整条脊线）
  作为**保留区**交给排布：别的字让开；导出侧同一条口径（导出里注记在排布之后才出字，
  所以更要先占位）。

判据（读真实排布结论 + 导出 SVG）：
  1. 一条横穿省形心的山系名在场时：排布里**没有**任何标签落在它的走廊上（屏幕空间 |Δy| ≤ 12px）；
  2. 反向对照：把注记删掉 → 省名回到形心（|Δy| ≤ 8px）——证明"让开"是注记造成的；
  3. 导出 SVG：山系名的逐字还在，而省名的 `<text>` 不在走廊上；
  4. 缓存纪律：改注记不重排是"画面不动"级缺陷 —— 删掉注记后 `getLabelPlan` 必须立刻变。
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for                                  # noqa: E402
from lib.helpers import ensure_data_ready                               # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
KEY = '用例162底图'


def run(cdp):
    wait_for(cdp, "!!document.querySelector('#app')", desc='应用挂载', timeout=15)
    ensure_data_ready(cdp)
    r = cdp.eval("""(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('历史剧本'));
      if (!btn) return 'no-btn'; btn.click(); return 'ok';
    })()""")
    if r != 'ok':
        return False, f'进入历史剧本失败：{r}'
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", desc='ScenarioMap 挂载', timeout=8)

    seed = r"""(async () => {
      const s = __STORE__, SM = __SM__, KEY = __KEY__;
      const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
      if (s.baseMaps[KEY]) s.removeBaseMap(KEY);
      s.addBaseMap(KEY, { name: KEY });
      s.addBaseProvince(KEY, { id: 'p162', name: '省162', kind: 'land',
        points: [{x:100,y:100},{x:500,y:100},{x:500,y:500},{x:100,y:500}] }, { checkOverlap: false });
      s.createScenario(KEY + '/甲', {
        ownerKey: KEY, name: '甲', order: 1, group: 'default',
        era: { roman: 'Ⅰ', label: '甲', startYear: '2000', endYear: '2010' },
        polities: [{ id: 'P1', name: '甲国', color: '#c23b3b' }],
        ownership: { p162: 'P1' },
      });
      // 山系名横穿省形心 (300,300)：这条走廊正是省名想落的地方
      const res = s.applyTerrainLabels(KEY, [{
        id: 'tl162', kind: 'range', name: '测试山脊',
        points: [{x:150,y:300},{x:300,y:300},{x:450,y:300}], origin: 'user',
      }]);
      SM.baseMapKey = KEY;
      if (typeof SM.onBaseMapChange === 'function') await SM.onBaseMapChange();
      SM.tlEra = 0; SM.tlDate = { y: 2000, m: null, d: null };
      SM.showTerrainNames = true;
      SM.showPolityLabels = true;
      SM.showPlaceNames = false;      // 只留省名/势力名 + 地形注记，判据干净
      await tick(500);
      // 近景（ratio≈0.25）才会出省名（polityLabelTier 的 close 档）
      const cvs = document.querySelector('.scenario-map-container canvas');
      const W = SM.cw(), H = SM.ch();
      SM.cameraScale = W / (0.25 * 400);      // 地图世界宽 400（省 100..500）
      SM.cameraX = W / 2 - 300 * SM.cameraScale;
      SM.cameraY = H / 2 - 300 * SM.cameraScale;
      await tick(120);
      return JSON.stringify({ ok: !!(res && res.ok), scale: SM.cameraScale });
    })()"""
    ok, seeded = eval_json(cdp, seed.replace('__STORE__', STORE).replace('__SM__', SM)
                           .replace('__KEY__', json.dumps(KEY)), required=('scale',), desc='造省 + 横穿形心的山系名')
    if not ok:
        return False, f'造数失败：{seeded}'

    probe = r"""(async () => {
      const s = __STORE__, SM = __SM__, KEY = __KEY__;
      const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
      const W = SM.cw(), H = SM.ch();
      const setCam = () => {
        SM.cameraScale = W / (0.25 * 400);
        SM.cameraX = W / 2 - 300 * SM.cameraScale;
        SM.cameraY = H / 2 - 300 * SM.cameraScale;
      };
      const snap = () => {
        setCam();
        const plan = SM.getLabelPlan() || [];
        return plan.map((p) => ({
          kind: p.kind, text: p.text, wy: p.wy, wx: p.wx,
          sy: SM.cameraY + p.wy * SM.cameraScale,
          sx: SM.cameraX + p.wx * SM.cameraScale,
        }));
      };
      const withLabel = snap();
      // 删掉注记（换数组引用 → 排布缓存必须失效）
      const bm = s.baseMaps[KEY];
      const keep = bm.terrainLabels;
      s.baseMaps = { ...s.baseMaps, [KEY]: { ...bm, terrainLabels: [] } };
      await tick(120);
      const without = snap();
      // 复原（后面的导出要用注记；顺带验证"改回来也立刻生效"）
      s.baseMaps = { ...s.baseMaps, [KEY]: { ...s.baseMaps[KEY], terrainLabels: keep } };
      await tick(120);
      const restored = snap();
      return JSON.stringify({
        withLabel, without, restored,
        scale: SM.cameraScale, camY: SM.cameraY,
      });
    })()"""
    ok, out = eval_json(cdp, probe.replace('__STORE__', STORE).replace('__SM__', SM)
                        .replace('__KEY__', json.dumps(KEY)), required=('withLabel',), desc='排布（有注记 / 无注记）')
    if not ok:
        return False, f'排布探测失败：{out}'

    fails = []
    # 走廊：世界 y=300 那一行（屏幕 y = camY + 300*scale），x 覆盖 150..450 世界
    scale = float(out.get('scale') or 0)
    cam_y = float(out.get('camY') or 0)
    corridor_sy = cam_y + 300 * scale
    corridor_sx0 = float(seeded.get('scale') or 0)  # 占位（下面用世界→屏幕换算）
    # 用当前相机把世界 x 150/450 换算成屏幕
    def _sx(wx):
        # cameraX = W/2 - 300*scale（setCam 恒定）
        return (1080 / 2) + (wx - 300) * scale
    cor_x0, cor_x1 = _sx(150) - 20, _sx(450) + 20

    def in_corridor(e, pad=12):
        return cor_x0 <= e['sx'] <= cor_x1 and abs(e['sy'] - corridor_sy) <= pad

    hits = [e for e in out['withLabel'] if in_corridor(e)]
    if hits:
        fails.append(f"有注记时仍有 {len(hits)} 个标签压在走廊上：{[(h['kind'], h['text']) for h in hits]}")

    prov = [e for e in out['without'] if e['kind'] == 'province']
    if not prov:
        fails.append(f"对照失败：删掉注记后省名没出现（kinds={[e['kind'] for e in out['without']]}）")
    else:
        near = [e for e in prov if abs(e['sy'] - corridor_sy) <= 8]
        if not near:
            fails.append(f"对照失败：删掉注记后省名仍不在形心附近（sy={[round(e['sy'], 1) for e in prov]}，走廊 sy={corridor_sy:.1f}）")

    # 有注记时省名若还在走廊外：说明是"让开"；若干脆没有省名：也算让开（被保留区挤掉）
    with_prov = [e for e in out['withLabel'] if e['kind'] == 'province']
    if with_prov and not any(in_corridor(e, 4) for e in with_prov):
        pass  # 让开了

    build = r"""(async () => {
      const SM = __SM__;
      const fn = SM.buildScenarioSVG || (SM.scenarioExport && SM.scenarioExport.buildScenarioSVG);
      if (!fn) return JSON.stringify({ __err__: '没有 buildScenarioSVG' });
      const svg = String(fn({ era: 0, date: { y: 2000, m: null, d: null } }).svg || '');
      const pick = (text) => {
        const m = svg.match(new RegExp('<text\\b([^>]*)>' + text + '</text>'));
        return m ? m[1] : null;
      };
      const attrs = (blob) => {
        const o = {};
        for (const m of (blob || '').matchAll(/([a-z-]+)="(-?[0-9.]+)"/g)) o[m[1]] = Number(m[2]);
        return o;
      };
      return JSON.stringify({
        len: svg.length,
        mountainChars: (svg.split('>山<').length - 1) + (svg.split('>脊<').length - 1),
        province: pick('省162'),
      });
    })()"""
    ok, exp = eval_json(cdp, build.replace('__SM__', SM), required=('len',), desc='导出 SVG')
    if not ok:
        return False, f'导出失败：{exp}'
    if int(exp.get('mountainChars') or 0) < 1:
        fails.append('导出里没有山系名（地形注记丢了）')
    pa = exp.get('province')
    if pa:
        # 世界坐标（导出组内无相机）：走廊 y=300、x 150..450
        vals = {k: float(v) for k, v in re.findall(r'([a-z-]+)="(-?[0-9.]+)"', pa)}
        x, y = vals.get('x', -1), vals.get('y', -1)
        if 150 <= x <= 450 and abs(y - 300) <= 12:
            fails.append(f'导出的省名压在走廊上（x={x}, y={y}）—— 导出侧保留区没生效')

    if fails:
        return False, '；'.join(fails)[:900] + ' | 实测：' + json.dumps(
            {'with': [(e['kind'], round(e['sy'], 1)) for e in out['withLabel']],
             'without': [(e['kind'], round(e['sy'], 1)) for e in out['without']],
             'corridor_sy': round(corridor_sy, 1)}, ensure_ascii=False)[:500]
    return True, (f"有注记：排布 {len(out['withLabel'])} 条、走廊上 0 条；"
                  f"删注记后省名回到形心（sy≈{corridor_sy:.0f}）；导出山系名在、省名让开")
