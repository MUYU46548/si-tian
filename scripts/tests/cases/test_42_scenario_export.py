#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 42：剧本模块导出/导入（P0）

覆盖：
  1. 导出 scenarios.json → 经 saveTextFile IPC（mock 记录内容不落盘）→ 校验载荷结构
  2. 导出 SVG 矢量图 → 校验文档结构 / 省份 path / 势力色 / EU4 斜线 pattern
  3. 导出前体检 auditScenariosPayload → 对残缺载荷给出警告
  4. 导入 merge（新增剧本）/ replace（清空后导入）→ 断言数量变化
  5. 两种导入各自只占**一条 undo**，undo 后完全回到导入前
"""
import sys, os, json, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for
from lib.helpers import ensure_data_ready, open_test_base_map

SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"


def _enter(cdp):
    r = cdp.eval("""(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('历史剧本'));
      if (!b) return 'no-btn';
      b.click(); return 'ok';
    })()""")
    if r != 'ok':
        return r
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", desc='ScenarioMap 挂载', timeout=8)
    cdp.eval("window.confirm = () => true;")   # 导出体检/导入确认一律放行
    return 'ok'


def _seed(cdp):
    """2 省 + 2 剧本；乙时代 prov_b 易主（B2 是新谱系）→ eraChg=[['prov_b']]"""
    return cdp.eval("""(() => {
      const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
      for (const k of Object.keys(s.scenarios)) s.removeScenario(k);
      if (!s.baseMaps['德斯特星']) s.addBaseMap('德斯特星', { name: '德斯特星' });
      s.baseMaps['德斯特星'].terrain.length = 0;
      const mk = (id, x0) => ({ id, name: '省' + id.slice(-1).toUpperCase(),
        points: [{x:x0,y:150},{x:x0+140,y:150},{x:x0+140,y:290},{x:x0,y:290}],
        biome: 'temperate', coast: true });
      ['prov_a','prov_b'].forEach((id, i) => s.addBaseProvince('德斯特星', mk(id, 200 + i*200)));
      const P = (id, name, color) => ({ id, name, color });
      s.createScenario('德斯特星/甲时代', {
        ownerKey: '德斯特星', name: '甲时代', order: 1,
        era: { roman: 'Ⅰ', label: '甲', startYear: '2000', endYear: '2010' },
        polities: [P('A1','甲国','#c23b3b')],
        ownership: { prov_a:'A1', prov_b:'A1' },
      });
      s.createScenario('德斯特星/乙时代', {
        ownerKey: '德斯特星', name: '乙时代', order: 2,
        era: { roman: 'Ⅱ', label: '乙', startYear: '2010', endYear: '2020' },
        polities: [P('B1','乙国','#4a90d9'), P('B2','乙南','#e6a23c')],
        ownership: { prov_a:'B1', prov_b:'B2' },
      });
      return Object.keys(s.scenarios).length;
    })()""")


def run(cdp):
    ensure_data_ready(cdp)
    r = _enter(cdp)
    if r != 'ok':
        return False, f'进入剧本模式失败: {r}'
    # 底图 fixture：司天不再默认建/选示例底图（见 helpers.open_test_base_map 说明）
    bm_ok, bm_info = open_test_base_map(cdp, '德斯特星')
    if not bm_ok:
        return False, f'底图 fixture 未就位: {bm_info}'
    n = _seed(cdp)
    if n != 2:
        return False, f'数据注入失败: {n}'
    time.sleep(0.4)

    # ---------- 1. 导出 scenarios.json ----------
    exp = json.loads(cdp.eval(f"""(async () => {{
      const s = {SM};
      window.__LAST_TEXT_EXPORT__ = null;
      s.tlYear = 2010;                       // 落在乙时代起点
      await new Promise(r => setTimeout(r, 60));
      await s.exportScenariosJson({{ scope: 'current' }});
      const rec = window.__LAST_TEXT_EXPORT__;
      if (!rec) return JSON.stringify({{err:'未调用 saveTextFile'}});
      let parsed = null, parseErr = null;
      try {{ parsed = JSON.parse(rec.text); }} catch (e) {{ parseErr = String(e.message); }}
      return JSON.stringify({{
        kind: rec.kind, defaultName: rec.defaultName,
        bytes: rec.text.length, parseErr,
        maps: Object.keys(parsed?.baseMaps || {{}}),
        scenarios: Object.keys(parsed?.scenarios || {{}}),
        hasOwnership: !!parsed?.scenarios?.['德斯特星/乙时代']?.ownership,
        hasVersion: parsed?.version !== undefined,
        status: s.exportStatus,
        changedPerEra: s.timeline.eraChg.map(e => e.changed),
      }});
    }})()"""))
    if exp.get('err'):
        return False, f'JSON 导出未走到 IPC: {exp}'
    if exp['parseErr']:
        return False, f'导出的 JSON 无法解析: {exp["parseErr"]}'
    if exp['kind'] != 'json' or exp['maps'] != ['德斯特星'] or len(exp['scenarios']) != 2:
        return False, f'导出载荷结构不符: {exp}'
    if not exp['hasOwnership'] or not exp['hasVersion']:
        return False, f'导出载荷缺 ownership/version: {exp}'
    if exp['changedPerEra'] != [[], ['prov_b']]:
        return False, f'谱系判定异常: {exp["changedPerEra"]}'
    if not exp['status']:
        return False, '导出后未给出状态提示（静默导出 = 用户以为没导出）'

    # ---------- 2. 导出 SVG（EU4 斜线应落成 <pattern>） ----------
    svg = json.loads(cdp.eval(f"""(async () => {{
      const s = {SM};
      window.__LAST_TEXT_EXPORT__ = null;
      s.tlDiffMode = 'eu4';
      s.tlYear = 2020;                       // 乙时代末年 → prov_b 的易主已落定
      await new Promise(r => setTimeout(r, 60));
      await s.exportScenarioSVG();
      const rec = window.__LAST_TEXT_EXPORT__;
      if (!rec) return JSON.stringify({{err:'未调用 saveTextFile'}});
      const t = rec.text;
      return JSON.stringify({{
        kind: rec.kind, defaultName: rec.defaultName, bytes: t.length,
        isXml: t.startsWith('<?xml'),
        hasSvg: t.includes('<svg'), hasClose: t.includes('</svg>'),
        pathCount: (t.match(/<path /g) || []).length,
        patternCount: (t.match(/<pattern /g) || []).length,
        hatchRef: /fill="url\\(#occ-\\d+\\)"/.test(t),
        colorA: t.includes('#c23b3b'), colorB: t.includes('#4a90d9'), colorC: t.includes('#e6a23c'),
        hasLegend: t.includes('势力'), hasTitle: t.includes('乙时代'),
        stripes: s.timeline.eraChg[1].changed,
      }});
    }})()"""))
    if svg.get('err'):
        return False, f'SVG 导出未走到 IPC: {svg}'
    if not (svg['isXml'] and svg['hasSvg'] and svg['hasClose']):
        return False, f'SVG 文档结构不完整: {svg}'
    if svg['pathCount'] < 2:
        return False, f'SVG 缺省份 path（应有 ≥2）: {svg}'
    if svg['stripes'] != ['prov_b']:
        return False, f'用例前提不成立（应只有 prov_b 易主）: {svg}'
    if svg['patternCount'] < 1 or not svg['hatchRef']:
        return False, f'EU4 斜线未落成 pattern：{svg}'
    if not (svg['colorA'] and svg['colorC']):
        return False, f'SVG 缺势力色（旧主 A1 / 新主 B2 都应出现）: {svg}'
    if not (svg['hasLegend'] and svg['hasTitle']):
        return False, f'SVG 缺标题/图例块（导出物应自解释）: {svg}'

    # ---------- 3. 导出前体检 ----------
    audit = json.loads(cdp.eval(f"""(() => {{
      const s = {SM};
      const bad = s.store.auditScenariosPayload({{
        baseMaps: {{}},
        scenarios: {{ 'x/空剧本': {{ id:'x/空剧本', name:'空剧本', ownerKey:'缺失底图',
                                   polities: [], ownership: {{}}, era: {{}} }} }},
      }});
      const good = s.store.auditScenariosPayload(s.store.exportScenariosPayload('德斯特星'));
      return JSON.stringify({{ badCount: bad.length, bad, goodCount: good.length }});
    }})()"""))
    if audit['badCount'] < 3:
        return False, f'体检未识别残缺载荷: {audit}'
    if audit['goodCount'] != 0:
        return False, f'完整体检不应有警告: {audit}'

    # ---------- 4. 导入 merge（一条 undo） ----------
    merge = json.loads(cdp.eval(f"""(() => {{
      const s = {SM};
      const before = Object.keys(s.store.scenarios).length;
      const payload = {{
        version: 1,
        baseMaps: {{ '德斯特星': s.store.exportScenariosPayload('德斯特星').baseMaps['德斯特星'] }},
        scenarios: {{
          '德斯特星/新增时代': {{ id:'德斯特星/新增时代', ownerKey:'德斯特星', name:'新增时代', order: 3,
            era: {{ roman:'Ⅲ', label:'丙', startYear:'2020', endYear:'2030' }},
            polities: [{{id:'C1',name:'丙国',color:'#5b8c5a'}}],
            ownership: {{ prov_a:'C1', prov_b:'C1' }} }},
        }},
      }};
      const r = s.store.importScenariosPayload(payload, {{ mode:'merge' }});
      const after = Object.keys(s.store.scenarios).length;
      const hasNew = !!s.store.scenarios['德斯特星/新增时代'];
      s.store.undo();
      const afterUndo = Object.keys(s.store.scenarios).length;
      const gone = !s.store.scenarios['德斯特星/新增时代'];
      return JSON.stringify({{before, after, afterUndo, hasNew, gone, r}});
    }})()"""))
    if not (merge['after'] == merge['before'] + 1 == 3 and merge['hasNew']):
        return False, f'merge 导入未新增剧本: {merge}'
    if merge['afterUndo'] != merge['before'] or not merge['gone']:
        return False, f'merge 导入不是一条 undo（undo 后未回滚）: {merge}'

    # ---------- 5. 导入 replace（清空后导入，同样一条 undo） ----------
    rep = json.loads(cdp.eval(f"""(() => {{
      const s = {SM};
      const before = Object.keys(s.store.scenarios).length;
      const payload = {{
        version: 1, baseMaps: {{}},
        scenarios: {{
          '德斯特星/替换时代': {{ id:'德斯特星/替换时代', ownerKey:'德斯特星', name:'替换时代', order: 1,
            era: {{ roman:'Ⅰ', label:'甲', startYear:'1000', endYear:'1100' }},
            polities: [{{id:'Z1',name:'周一',color:'#8e44ad'}}],
            ownership: {{ prov_a:'Z1', prov_b:'Z1' }} }},
        }},
      }};
      const r = s.store.importScenariosPayload(payload, {{ mode:'replace' }});
      const after = Object.keys(s.store.scenarios);
      s.store.undo();
      const restored = Object.keys(s.store.scenarios).length;
      return JSON.stringify({{before, after, restored, r}});
    }})()"""))
    if rep['after'] != ['德斯特星/替换时代']:
        return False, f'replace 导入未整体替换: {rep}'
    if rep['restored'] != rep['before']:
        return False, f'replace 导入不是一条 undo: {rep}'

    return True, (f'JSON 导出({exp["bytes"]}B/{len(exp["scenarios"])}剧本) → SVG 导出'
                  f'({svg["bytes"]}B, {svg["pathCount"]} path, {svg["patternCount"]} 斜线 pattern)'
                  f' → 体检({audit["badCount"]} 警告) → merge +1 且可 undo'
                  f' → replace 整体替换且可 undo')
