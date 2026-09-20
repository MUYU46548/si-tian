#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 33：聚落编辑器 —— 规模 / 人口 / 文化归属（P1-3）

验收点（对应提示词 P1-3 的「验收标准」逐条）：
1. 人口可输入变更（对数滑块 + 数字输入），且写入节点（geodata.json 载荷可见）
2. 聚落图标按人口变化大小（settlementRadius：分级系数 × 手动缩放）
3. 文化下拉可选（planet 级 cultures 列表 + -1 无归属），新建文化后可选并落到 mapdata.json
4. 村庄/城镇/城市有视觉区分（分级阈值 + scale 各不相同）
5. 修改后 undo 正常（一条命令回退）
6. Burg Editor 高级窗口可打开、可改人口/文化/缩放
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for  # noqa: E402
from lib.helpers import ensure_data_ready  # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"


def _j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    ensure_data_ready(cdp)

    # ── 1. 分级 / 滑块 / 半径换算 ───────────────────────────────────────
    calc = _j(cdp, """(async () => {
      const m = await import('/src/utils/settlement.js');
      const t = (p) => m.tierOf(p).key;
      const rt = (p) => m.popToSlider(p);
      const back = [100, 5000, 50000, 500000, 1000000].map(p => m.sliderToPop(rt(p)));
      return JSON.stringify({
        tiers: { _999: t(999), _5000: t(5000), _50000: t(50000), _500000: t(500000) },
        sliderMonotonic: rt(100) === 0 && rt(1000000) === 100 && rt(1000) < rt(10000) && rt(10000) < rt(100000),
        roundTrip: back,
        radii: { hamlet: m.settlementRadius(10, 500), city: m.settlementRadius(10, 500000), none: m.settlementRadius(10, undefined) },
        scales: [...new Set(m.SETTLEMENT_TIERS.map(x => x.scale))].length,
        labels: m.SETTLEMENT_TIERS.map(x => x.label),
      });
    })()""")
    if not isinstance(calc, dict):
        return False, f'聚落工具模块不可用 {calc}'
    tr = calc['tiers']
    if tr['_999'] != 'hamlet' or tr['_5000'] != 'village' or tr['_50000'] != 'town' or tr['_500000'] != 'city':
        return False, f'人口分级阈值不符（<1k 小村庄 / 1k-10k 村庄 / 10k-100k 城镇 / 100k+ 城市）：{tr}'
    if not calc['sliderMonotonic']:
        return False, f'对数滑块映射异常（0↔100 端点或单调性不成立）：{calc}'
    if calc['scales'] < 4:
        return False, f'分级视觉系数不足 4 档（无法视觉区分）：{calc["scales"]}'
    rr = calc['radii']
    # 无人口 → 保持基准半径；城市显著大于基准；小村庄小于基准（同一层级内部也拉开差距）
    if not (rr['city'] > rr['none'] and rr['city'] > rr['hamlet'] and rr['hamlet'] < rr['none']):
        return False, f'图标半径未随人口分级变化：{rr}'

    # ── 2. 选中一个聚落节点，打开详情面板 ────────────────────────────────
    town = _j(cdp, f"""(() => {{
      const s = {STORE};
      const n = s.nodes.find(x => x.layer === 'town') || s.nodes.find(x => x.layer === 'city')
             || s.nodes.find(x => x.layer === 'village');
      if (!n) return JSON.stringify({{ err: 'no-settlement' }});
      s.selectedNode = n;
      return JSON.stringify({{ id: n.id, name: n.name, layer: n.layer }});
    }})()""")
    if not isinstance(town, dict) or 'id' not in town:
        return False, f'数据里找不到聚落节点 {town}'
    time.sleep(0.9)
    # 人口/文化字段在详情面板的「编辑」分页下
    cdp.eval("""(() => {
      const b = Array.from(document.querySelectorAll('.detail-tab-btn')).find(x => x.textContent.trim() === '编辑');
      if (b) b.click();
      return 'ok';
    })()""")
    time.sleep(0.5)
    panel = _j(cdp, """JSON.stringify({
      panel: !!document.querySelector('.detail-panel'),
      popField: !!document.querySelector('[data-testid="settlement-pop-field"]'),
      tier: (document.querySelector('[data-testid="settlement-tier"]') || {}).textContent || '',
      culture: !!document.querySelector('[data-testid="settlement-culture"]'),
      burgBtn: !!document.querySelector('[data-testid="open-burg-editor"]'),
      slider: !!document.querySelector('[data-testid="settlement-pop-slider"]'),
      input: !!document.querySelector('[data-testid="settlement-pop-input"]'),
    })""")
    if not panel.get('panel'):
        return False, '详情面板未打开（store.selectedNode 未驱动面板？）'
    if not (panel.get('popField') and panel.get('slider') and panel.get('input')):
        return False, f'聚落节点缺少人口编辑区：{panel}'
    if not panel.get('culture'):
        return False, f'聚落节点缺少文化归属下拉：{panel}'
    if not panel.get('burgBtn'):
        return False, '缺少 Burg Editor 入口按钮'

    # ── 3. 改人口（数字输入）→ 分级 & 节点字段 & undo ───────────────────
    def set_pop(value):
        return cdp.eval(f"""(() => {{
          const el = document.querySelector('[data-testid="settlement-pop-input"]');
          if (!el) return 'no-input';
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, '{value}');
          el.dispatchEvent(new Event('change', {{ bubbles: true }}));
          return 'ok';
        }})()""")

    if set_pop(500000) != 'ok':
        return False, '人口输入框不可用'
    time.sleep(0.5)
    after = _j(cdp, f"""(() => {{
      const s = {STORE};
      const n = s.nodes.find(x => x.id === '{town["id"]}');
      return JSON.stringify({{
        pop: n.population,
        tierText: (document.querySelector('[data-testid="settlement-tier"]') || {{}}).textContent || '',
      }});
    }})()""")
    if after.get('pop') != 500000:
        return False, f'人口未写入节点：{after}'
    if '城市' not in (after.get('tierText') or ''):
        return False, f'人口改为 50 万后分级文案未变：{after["tierText"]}'

    # 分级影响半径
    radius = _j(cdp, """(async () => {
      const m = await import('/src/utils/settlement.js');
      return JSON.stringify({ base: 7, small: m.settlementRadius(7, 500), big: m.settlementRadius(7, 500000) });
    })()""")
    if not (radius['big'] > radius['small']):
        return False, f'图标半径未按分级变化：{radius}'

    # undo 一条命令回退
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.5)
    undone = _j(cdp, f"""(() => {{
      const s = {STORE};
      const n = s.nodes.find(x => x.id === '{town["id"]}');
      return JSON.stringify({{ pop: n.population === undefined ? null : n.population }});
    }})()""")
    if undone.get('pop') == 500000:
        return False, f'修改人口后 undo 未回退：{undone}'
    _j(cdp, f"(() => {{ {STORE}.redo(); return 'ok'; }})()")
    time.sleep(0.4)

    # ── 4. 文化：新建 + 下拉选择 + 落 mapdata.json ──────────────────────
    # 找聚落所属行星
    pid = _j(cdp, f"""(() => {{
      const s = {STORE};
      let cur = s.nodes.find(x => x.id === '{town["id"]}');
      const seen = new Set();
      while (cur && cur.parentId && !seen.has(cur.parentId)) {{
        seen.add(cur.parentId);
        const p = s.nodes.find(x => x.id === cur.parentId);
        if (!p) break;
        if (p.layer === 'planet') return p.id;
        cur = p;
      }}
      return null;
    }})()""")
    if not pid:
        return False, '取不到聚落所属行星 id'

    # 保存载荷来源：接线后 geodata/mapdata 落盘去向 = 项目文件（harness 已挂好 projectSave 记录 + __probe）

    # 走 UI：点「＋ 新建文化」（真实入口，顺带验证 mapData 懒加载）
    cdp.eval("window.prompt = () => '测试文化';")
    if cdp.eval("(() => { const b = document.querySelector('[data-testid=\"settlement-add-culture\"]'); if (!b) return 'no-btn'; b.click(); return 'ok'; })()") != 'ok':
        return False, '找不到「新建文化」按钮'
    time.sleep(1.0)

    created = _j(cdp, f"""(() => {{
      const s = {STORE};
      const n = s.nodes.find(x => x.id === '{town["id"]}');
      let found = null, key = null;
      for (const k of Object.keys(s.mapData || {{}})) {{
        const list = (s.mapData[k] || {{}}).cultures || [];
        const hit = list.find(c => c.name === '测试文化');
        if (hit) {{ found = hit; key = k; }}
      }}
      return JSON.stringify({{ culture: found, key, nodeCulture: n.cultureId, hasFn: typeof s.addCulture }});
    }})()""")
    if not created.get('culture'):
        return False, f'UI 新建文化失败（store.addCulture={created.get("hasFn")}）：{created}'
    culture_id = created['culture']['id']
    if created.get('nodeCulture') != culture_id:
        return False, f'新建文化后未自动归属到聚落：{created}'
    if not created['culture'].get('color'):
        return False, f'新建文化缺少主色：{created}'

    options = _j(cdp, """JSON.stringify(
      Array.from(document.querySelectorAll('[data-testid="settlement-culture"] option')).map(o => ({ v: o.value, t: o.textContent.trim() })))""")
    if not any(o['t'] == '测试文化' for o in options):
        return False, f'文化下拉未出现新建的文化：{options}'
    if not any(o['v'] == '-1' for o in options):
        return False, f'文化下拉缺少「无归属」(-1) 选项：{options}'

    # 切到「无归属」再切回来（下拉真实可用）
    def set_culture(value):
        return cdp.eval(f"""(() => {{
          const el = document.querySelector('[data-testid="settlement-culture"]');
          if (!el) return 'no-select';
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
          setter.call(el, '{value}');
          el.dispatchEvent(new Event('change', {{ bubbles: true }}));
          return 'ok';
        }})()""")

    if set_culture(-1) != 'ok':
        return False, '文化下拉不可用'
    time.sleep(0.4)
    none_state = _j(cdp, f"""(() => {{
      const s = {STORE};
      const n = s.nodes.find(x => x.id === '{town["id"]}');
      return JSON.stringify({{ cultureId: n.cultureId, swatch: !!document.querySelector('.culture-swatch') }});
    }})()""")
    if none_state.get('cultureId') != -1:
        return False, f'选择「无归属」未写入节点：{none_state}'
    if none_state.get('swatch'):
        return False, '无归属时不应显示文化色块'

    set_culture(culture_id)
    time.sleep(0.5)
    culture_set = _j(cdp, f"""(() => {{
      const s = {STORE};
      const n = s.nodes.find(x => x.id === '{town["id"]}');
      return JSON.stringify({{ nodeCulture: n.cultureId, swatch: !!document.querySelector('.culture-swatch') }});
    }})()""")
    if culture_set.get('nodeCulture') != culture_id:
        return False, f'切回文化未写入节点：{culture_set}'
    if not culture_set.get('swatch'):
        return False, '选中文化后未显示文化主色色块'

    # ── 5. 持久化：项目实体含 population、项目地图含 cultures ───────────
    time.sleep(1.6)
    _j(cdp, "window.__probe.flushProject()")
    persisted = _j(cdp, f"""(() => {{
      const recs = window.__savedProject || [];
      const proj = window.__probe.lastProject();
      const mp = window.__probe.lastMapPayload('{pid}');
      const n = proj ? (proj.entities || {{}})['{town["id"]}'] : null;
      const cs = mp ? ((mp.data.cultures) || []) : [];
      return JSON.stringify({{
        geoN: recs.length, mapN: mp ? recs.length : 0,
        pop: n ? n.population : null,
        cultureId: n ? n.cultureId : null,
        cultures: cs.map(c => c.name),
      }});
    }})()""")
    if persisted.get('geoN', 0) <= 0:
        return False, '改人口后没有触发项目文件落盘'
    if persisted.get('pop') != 500000 or persisted.get('cultureId') != culture_id:
        return False, f'节点人口/文化未进入项目实体：{persisted}'
    if persisted.get('mapN', 0) <= 0 or '测试文化' not in (persisted.get('cultures') or []):
        return False, f'文化列表未进入项目地图载荷：{persisted}'

    # ── 6. Burg Editor 窗口 ────────────────────────────────────────────
    cdp.eval("document.querySelector('[data-testid=\"open-burg-editor\"]').click()")
    time.sleep(0.5)
    burg = _j(cdp, """JSON.stringify({
      open: !!document.querySelector('[data-testid="burg-editor"]'),
      summary: (document.querySelector('[data-testid="burg-summary"]') || {}).textContent || '',
      slider: !!document.querySelector('[data-testid="burg-pop-slider"]'),
      culture: !!document.querySelector('[data-testid="burg-culture"]'),
      size: !!document.querySelector('[data-testid="burg-size-slider"]'),
    })""")
    if not burg.get('open'):
        return False, 'Burg Editor 未打开'
    if not (burg.get('slider') and burg.get('culture') and burg.get('size')):
        return False, f'Burg Editor 缺少控件：{burg}'
    if '城市' not in (burg.get('summary') or ''):
        return False, f'Burg Editor 底部未显示预估分级：{burg["summary"]}'

    # 在 Burg Editor 内改缩放 → 写入 sizeScale
    cdp.eval("""(() => {
      const el = document.querySelector('[data-testid="burg-size-slider"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, '1.5');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()""")
    time.sleep(0.5)
    size_scale = _j(cdp, f"""(() => {{
      const s = {STORE};
      const n = s.nodes.find(x => x.id === '{town["id"]}');
      return JSON.stringify({{ sizeScale: n.sizeScale }});
    }})()""")
    if size_scale.get('sizeScale') != 1.5:
        return False, f'Burg Editor 缩放未写入节点：{size_scale}'

    cdp.eval("document.querySelector('.burg-close').click()")
    time.sleep(0.3)
    if _j(cdp, "(() => !!document.querySelector('[data-testid=\"burg-editor\"]'))()"):
        return False, 'Burg Editor 关闭按钮无效'

    # 收尾：移除测试文化，避免污染
    cdp.eval(f"(() => {{ const s = {STORE}; s.removeCulture('{created['key']}', {culture_id}); return 'ok'; }})()")
    return True, (
        f'聚落编辑器通过：分级阈值正确（{tr["_999"]}/{tr["_5000"]}/{tr["_50000"]}/{tr["_500000"]}），'
        f'4 档视觉系数互不相同、半径 {calc["radii"]["hamlet"]}→{calc["radii"]["city"]}；'
        f'人口写入节点（500000）并随 geodata 载荷落盘，undo/redo 正常；'
        f'文化下拉出现「测试文化」并可选中（节点 cultureId={culture_id}、色块显示、随 mapdata 落盘）；'
        f'Burg Editor 三控件齐全、预估分级「城市」、缩放 1.5 写入节点'
    )
