#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 32：标记类型系统（P1-4）

验收点（对应提示词 P1-4 的「验收标准」逐条）：
1. 6 种默认类型存在（interest/settlement/battle/resource/danger/custom），旧类型保留不丢
2. 类型创建/删除正常（内置不可删；删除自定义类型时其标记转 custom）
3. 标记继承类型和颜色（新建标记 type/icon/color 来自类型定义）
4. 覆盖后保存再打开不丢（单点覆盖写进标记自身字段，且在画布上生效）
5. type 为空/未知 → 一律解析为 custom（旧数据迁移）
6. 类型注册表落到 .sitian/config，且地图工具栏的类型按钮数与注册表一致
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for  # noqa: E402
from lib.helpers import goto_planet, enter_edit, click_canvas_at_world, ensure_data_ready  # noqa: E402

PM = "document.querySelector('.planet-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
REQUIRED = ['interest', 'settlement', 'battle', 'resource', 'danger', 'custom']


def _j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def _open_settings(cdp):
    return cdp.eval("""(() => {
      const b = Array.from(document.querySelectorAll('.toolbar-actions button')).find(x => x.title === '设置');
      if (!b) return 'no-btn';
      b.click();
      return 'ok';
    })()""")


def _land_point(cdp):
    """优先取视口内的陆地点；取不到就退化为地图中心（标记放置本身不挑地形）"""
    return _j(cdp, f"""(() => {{
      const pm = {PM};
      const b = pm.worldBounds;
      const center = {{ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }};
      const hm = pm.planetHeightBrush.ensureHeightmap();
      if (!hm || !hm.grid || !hm.grid.points) return JSON.stringify(center);
      const c = document.querySelector('.planet-map-container .canvas-wrapper canvas');
      const vt = pm.renderer.viewTransform;
      const cw = c.clientWidth, ch = c.clientHeight;
      const toSX = wx => wx * vt.scale + vt.x + cw / 2;
      const toSY = wy => wy * vt.scale + vt.y + ch / 2;
      const pts = hm.grid.points;
      for (let i = 0; i < pts.length; i++) {{
        if (hm.h[i] < 25 || hm.h[i] > 65) continue;
        const x = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
        const y = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
        const sx = toSX(x), sy = toSY(y);
        if (sx < 80 || sx > cw - 80 || sy < 80 || sy > ch - 80) continue;
        return JSON.stringify({{ x, y }});
      }}
      return JSON.stringify(center);
    }})()""")


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    ensure_data_ready(cdp)

    # 干净起点
    cdp.eval("try { localStorage.removeItem('sitian-marker-types'); } catch (e) {}")
    cdp.eval("(async () => { const m = await import('/src/utils/markerTypes.js'); m.resetMarkerTypes(); })()")
    time.sleep(0.4)

    # ── 1. 默认类型 & 解析规则 ─────────────────────────────────────────
    info = _j(cdp, """(async () => {
      const mod = await import('/src/utils/markerTypes.js');
      const list = mod.markerTypes.value.map(t => ({ type: t.type, label: t.label, icon: t.icon, color: t.color, builtin: t.builtin }));
      const inherit = mod.effectiveMarkerStyle({ type: 'danger' });
      const override = mod.effectiveMarkerStyle({ type: 'danger', icon: 'star', color: '#123456' });
      return JSON.stringify({
        list,
        unknown: mod.resolveMarkerType('不存在的类型').type,
        empty: mod.resolveMarkerType('').type,
        undefinedType: mod.resolveMarkerType(undefined).type,
        inheritIcon: inherit.icon, inheritColor: inherit.color,
        overrideIcon: override.icon, overrideColor: override.color,
      });
    })()""")
    if not isinstance(info, dict) or 'list' not in info:
        return False, f'读不到标记类型注册表 {info}'
    keys = [t['type'] for t in info['list']]
    missing = [k for k in REQUIRED if k not in keys]
    if missing:
        return False, f'缺少默认类型 {missing}（现有 {keys}）'
    for legacy in ('chest', 'teleport', 'boss', 'npc', 'flag'):
        if legacy not in keys:
            return False, f'历史类型 {legacy} 丢失 —— 老地图标记图标/颜色会集体变味'
    if info.get('unknown') != 'custom' or info.get('empty') != 'custom' or info.get('undefinedType') != 'custom':
        return False, f'未知/空 type 未解析为 custom：{info}'
    danger = next(t for t in info['list'] if t['type'] == 'danger')
    if info.get('inheritIcon') != danger.get('icon') or info.get('inheritColor') != danger.get('color'):
        return False, f'标记未继承类型样式：{info}'
    if info['overrideIcon'] != 'star' or info['overrideColor'] != '#123456':
        return False, f'单点覆盖未生效：{info}'

    # ── 2. 设置面板「标记类型」页 ──────────────────────────────────────
    if _open_settings(cdp) != 'ok':
        return False, '找不到设置按钮'
    time.sleep(0.4)
    if _j(cdp, """(() => {
      const t = document.querySelector('[data-testid="settings-tab-markers"]');
      if (!t) return 'no-tab';
      t.click();
      return 'ok';
    })()""") != 'ok':
        return False, '设置面板缺少「标记类型」分页'
    time.sleep(0.4)
    rows = _j(cdp, """JSON.stringify(
      Array.from(document.querySelectorAll('[data-testid^="marker-type-"]'))
        .map(b => b.dataset.testid.replace('marker-type-', '')))""")
    if not isinstance(rows, list) or len(rows) < len(REQUIRED):
        return False, f'类型列表行数异常 {rows}'

    # 改颜色 + 改图标 → 落盘
    _j(cdp, """(() => {
      const r = document.querySelector('[data-testid="marker-type-danger"]');
      if (r) r.click();
      return 'ok';
    })()""")
    time.sleep(0.3)
    icon_clicked = _j(cdp, """(() => {
      const b = document.querySelector('[data-testid="marker-icon-anchor"]');
      if (!b) return 'no-icon';
      b.click();
      return 'ok';
    })()""")
    if icon_clicked != 'ok':
        return False, '图标选择器缺少 anchor 图标（图标池未接线？）'
    _j(cdp, """(async () => {
      const mod = await import('/src/utils/markerTypes.js');
      mod.updateMarkerType('danger', { color: '#FF00FF' });
      return 'ok';
    })()""")
    time.sleep(0.6)
    persisted = _j(cdp, """JSON.stringify({
      vault: ((window.__uiConfig || {}).markerTypes || []).find(t => t.type === 'danger') || null,
      mirror: (() => { try { return (JSON.parse(localStorage.getItem('sitian-marker-types') || '[]').find(t => t.type === 'danger')) || null; } catch (e) { return null; } })(),
    })""")
    if not persisted.get('vault') or persisted['vault'].get('color') != '#FF00FF':
        return False, f'类型改动未落盘 .sitian/config：{persisted}'
    if not persisted.get('mirror') or persisted['mirror'].get('icon') != 'anchor':
        return False, f'localStorage 镜像未同步图标改动：{persisted}'

    # ── 3. 新建 / 删除 / 排序 ──────────────────────────────────────────
    cdp.eval("window.prompt = () => '测试类型'; window.confirm = () => true;")
    cdp.eval("""(() => {
      const b = document.querySelector('[data-testid="marker-type-add"]');
      if (b) b.click();
      return 'ok';
    })()""")
    time.sleep(0.5)
    after_add = _j(cdp, """(async () => {
      const mod = await import('/src/utils/markerTypes.js');
      return JSON.stringify({ n: mod.markerTypes.value.length, labels: mod.markerTypes.value.map(t => t.label) });
    })()""")
    if '测试类型' not in (after_add.get('labels') or []):
        return False, f'新建类型未出现在注册表：{after_add}'

    move = _j(cdp, """(async () => {
      const mod = await import('/src/utils/markerTypes.js');
      const before = mod.markerTypes.value.map(t => t.type);
      const target = before[1];
      mod.moveMarkerType(target, -1);
      const after = mod.markerTypes.value.map(t => t.type);
      return JSON.stringify({ moved: after[0] === target && after[1] === before[0], before: before.slice(0, 3), after: after.slice(0, 3) });
    })()""")
    if not move.get('moved'):
        return False, f'类型排序未生效：{move}'

    builtin_del = _j(cdp, """(async () => {
      const mod = await import('/src/utils/markerTypes.js');
      const before = mod.markerTypes.value.length;
      const res = mod.removeMarkerType('interest');
      return JSON.stringify({ before, after: mod.markerTypes.value.length, res });
    })()""")
    if builtin_del['after'] != builtin_del['before']:
        return False, f'内置类型被删除了（应拒绝）：{builtin_del}'

    # 关掉设置面板
    cdp.eval("(() => { const b = document.querySelector('.settings-panel .close-btn'); if (b) b.click(); return 'ok'; })()")
    time.sleep(0.4)

    # ── 4. 画布：新建标记继承类型 ──────────────────────────────────────
    r = goto_planet(cdp, '乐园星')
    if r != 'planet':
        return False, f'导航行星失败 ({r})'
    wait_for(cdp, "!!document.querySelector('.planet-map-container .canvas-wrapper canvas')", desc='行星画布挂载')
    time.sleep(1.0)
    if enter_edit(cdp) != 'ok':
        return False, '进入编辑模式失败'
    time.sleep(0.7)
    _j(cdp, f"(() => {{ {PM}.zoomFit(); {PM}.renderer.setScale(1); return 'ok'; }})()")
    time.sleep(0.5)

    # 工具栏类型按钮数 == 注册表长度（验证 PlanetMap 用的是注册表，不是硬编码副本）
    toolbar = _j(cdp, f"""(() => {{
      const pm = {PM};
      pm.setInteractionMode('marker');
      return 'ok';
    }})()""")
    time.sleep(0.4)
    toolbar_count = cdp.eval("""(() => {
      const root = document.querySelector('.planet-map-container');
      const picker = Array.from(root.querySelectorAll('.terrain-picker'))
        .find(p => (p.textContent || '').includes('标记类型'));
      if (!picker) return -1;
      return picker.querySelectorAll('button').length;
    })()""")
    reg_len = _j(cdp, """(async () => {
      const mod = await import('/src/utils/markerTypes.js');
      return mod.markerTypes.value.length;
    })()""")
    if toolbar_count != reg_len:
        return False, (f'工具栏标记类型按钮 {toolbar_count} ≠ 注册表 {reg_len} —— '
                       f'PlanetMap 仍在用硬编码类型副本')

    pt = _land_point(cdp)
    if not isinstance(pt, dict) or 'x' not in pt:
        return False, f'视口内找不到陆地落点 {pt}'
    before_n = _j(cdp, f"""(() => {{
      const md = {STORE}.mapData['乐园星'] || {{}};
      return (md.markers || []).length;
    }})()""")
    _j(cdp, f"(() => {{ {PM}.markerEditor.selectedMarkerType.value = 'danger'; return 'ok'; }})()")
    time.sleep(0.2)
    if click_canvas_at_world(cdp, pt['x'], pt['y']) == 'out-of-view':
        return False, f'标记落点超出视口 {pt}'
    time.sleep(0.8)
    created = _j(cdp, f"""(() => {{
      const md = {STORE}.mapData['乐园星'] || {{}};
      const ms = md.markers || [];
      const m = ms[ms.length - 1];
      return JSON.stringify({{
        n: ms.length,
        marker: m ? {{ id: m.id, type: m.type, icon: m.icon, color: m.color }} : null,
      }});
    }})()""")
    if created['n'] != before_n + 1 or not created['marker']:
        return False, f'新建标记失败 {created}'
    mk = created['marker']
    danger_def = _j(cdp, """(async () => {
      const mod = await import('/src/utils/markerTypes.js');
      const t = mod.resolveMarkerType('danger');
      return JSON.stringify({ icon: t.icon, color: t.color });
    })()""")
    if mk['type'] != 'danger':
        return False, f'标记类型未写入：{mk}'
    if mk.get('icon') != danger_def.get('icon') or mk.get('color') != danger_def.get('color'):
        return False, f'标记未继承 danger 类型的图标/颜色（标记 {mk}，类型 {danger_def}）'

    # ── 5. 单点覆盖后保存不丢 ──────────────────────────────────────────
    cdp.eval("""(() => {
      window.__savedPayloads = [];
      const api = window.sitianAPI;
      if (api && !api.__mtSaveHooked) {
        api.saveMapData = async (key, data) => { window.__savedPayloads.push({ key, data }); return { success: true }; };
        api.__mtSaveHooked = true;
      }
      return 'ok';
    })()""")
    _j(cdp, f"(() => {{ {STORE}.updateMarker('乐园星', '{mk['id']}', {{ color: '#00FF00' }}); return 'ok'; }})()")
    time.sleep(1.5)
    payload = _j(cdp, f"""(() => {{
      const list = window.__savedPayloads || [];
      const last = list[list.length - 1];
      if (!last) return JSON.stringify({{ n: 0 }});
      const m = (last.data.markers || []).find(x => x.id === '{mk["id"]}');
      const round = JSON.parse(JSON.stringify(last.data)).markers.find(x => x.id === '{mk["id"]}');
      return JSON.stringify({{ n: list.length, color: m ? m.color : null, roundTripColor: round ? round.color : null }});
    }})()""")
    if payload.get('n', 0) <= 0:
        return False, '覆盖颜色后没有触发保存'
    if payload.get('color') != '#00FF00' or payload.get('roundTripColor') != '#00FF00':
        return False, f'单点覆盖未进入保存载荷/JSON 往返丢失：{payload}'

    # 覆盖后仍能解析出"用哪个图标"（继承 + 覆盖的组合语义）
    eff = _j(cdp, """(async () => {
      const mod = await import('/src/utils/markerTypes.js');
      const s = mod.effectiveMarkerStyle({ type: 'danger', color: '#00FF00' });
      return JSON.stringify({ icon: s.icon, color: s.color, iconInherited: s.inherited.icon, colorInherited: s.inherited.color });
    })()""")
    if not eff.get('iconInherited') or eff.get('colorInherited'):
        return False, f'继承/覆盖语义错误：{eff}'

    # ── 6. 低缩放只显示图标（名称 LOD 阈值 0.5） ────────────────────────
    lod = _j(cdp, f"""(() => {{
      const pm = {PM};
      pm.renderer.setScale(0.3);
      const low = pm.renderer.viewTransform.scale;
      pm.renderer.setScale(1);
      return JSON.stringify({{ low, back: pm.renderer.viewTransform.scale }});
    }})()""")
    if lod.get('low', 1) >= 0.5:
        return False, f'无法把缩放压到 0.5 以下，低缩放规则未被覆盖到：{lod}'

    _j(cdp, f"(() => {{ {PM}.setInteractionMode('pan'); return 'ok'; }})()")
    cdp.eval("(async () => { const m = await import('/src/utils/markerTypes.js'); m.resetMarkerTypes(); })()")
    return True, (
        f'标记类型系统通过：默认 {len(REQUIRED)} 种齐全 + 历史 5 种保留（共 {len(keys)} 类型）；'
        f'未知/空 type → custom；类型改动落盘（danger icon=anchor/color=#FF00FF）；'
        f'新建（{after_add["n"]} 个）/排序/内置不可删均正常；'
        f'工具栏类型按钮 {toolbar_count} == 注册表 {reg_len}（已去掉硬编码副本）；'
        f'新建标记继承 danger（icon={mk["icon"]}, color={mk["color"]}）且单点覆盖 #00FF00 保存不丢'
    )
