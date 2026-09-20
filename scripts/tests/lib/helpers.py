#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
测试辅助函数（阶段 2 回归测试基线）
"""
import json
import time


def ensure_data_ready(cdp, timeout=45):
    """等 mock 数据就绪再断言。

    测试 harness 每个用例后都会重载页面 → 每个用例都是冷启动，而 mock 是异步注入的
    （geodata + 2MB mapdata）。不等就断言会看到空 store，误报成"导航失败/未进入 domain"。
    超时不抛错：让用例自己的断言给出有意义的失败原因。
    """
    from lib.cdp import wait_for  # 局部导入（cdp 不反向依赖 helpers，无循环）
    try:
        wait_for(cdp,
                 "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
                 timeout=timeout, desc='地理数据加载')
    except Exception:
        pass


# ─────────────────────────────────────────────────────────────
# 基线项目（决策 1 终态的回归基线）
#   2026-09-20 起 `READONLY_WITHOUT_PROJECT = true`：无项目 = 只读，任何落盘写都被拒绝。
#   45+ 个用例依赖落盘写（笔刷/道路/河流/剧本/区域/建筑…），所以 harness 在每个用例前
#   **用当前知识库工作态播种一个 mock 项目并打开**（走真实的 projectStore.openProject →
#   geodata.applyProjectToCanvas 链路），让用例跑在生产等价的状态下：
#     事实源 = 项目文件、写模式 = 'project'（可写）、画布内容 = 知识库数据。
#   项目只存在于 `window.__projects`（mock 内存），**不落盘 → 对真实库零污染**。
#   ⚠️ 播种走 `exportCanvasToProject()`（生产同一份转换代码），不是手工造 JSON ——
#      否则「实体 ⇄ 节点」的字段丢失/归一化问题会被 harness 掩盖。
# ─────────────────────────────────────────────────────────────
HARNESS_PROJECT_PATH = 'mock/projects/harness-baseline.sitian'
HARNESS_PROJECT_NAME = 'harness 基线项目'

OPEN_HARNESS_JS = r"""(async () => {
  const app = document.querySelector('#app').__vue_app__;
  if (!app) return JSON.stringify({ ok: false, error: 'no-app' });
  const pinia = app.config.globalProperties.$pinia;
  const store = app._instance.setupState.store;
  const { useProjectStore } = await import('/src/store/projectStore.js');
  const { createEmptyProject } = await import('/src/utils/projectSchema.js');
  const proj = useProjectStore(pinia);
  const filePath = '__PATH__';

  // 记录「项目文件落盘」载荷（projectSave 是项目文件的唯一写 IPC）
  window.__savedProject = window.__savedProject || [];
  if (!window.sitianAPI.__projectSaveHooked) {
    const orig = window.sitianAPI.projectSave;
    window.sitianAPI.projectSave = async (p) => {
      window.__savedProject.push(p);
      return orig ? orig(p) : { success: true, filePath: p && p.filePath };
    };
    window.sitianAPI.__projectSaveHooked = true;
  }

  // 用例可用的探针（读真实落盘内容，不经过业务代码）
  window.__probe = {
    harnessProjectPath: filePath,
    lastProject() {
      const l = window.__savedProject || [];
      return l.length ? (l[l.length - 1] || {}).project || null : null;
    },
    lastMapPayload(planetId) {
      const l = window.__savedProject || [];
      for (let i = l.length - 1; i >= 0; i--) {
        const md = l[i] && l[i].project && l[i].project.maps ? l[i].project.maps.mapData : null;
        if (!md) continue;
        const k = Object.keys(md).find(kk => kk === planetId || kk.endsWith('/' + planetId));
        if (k) return { key: k, data: md[k] };
      }
      return null;
    },
    projectFile() { return (window.__projects || {})[filePath] || null; },
    flushProject: async () => { await proj.flushSave(); await new Promise(r => setTimeout(r, 150)); return true; },
  };

  if (proj.isOpen && store.canvasSource === 'project') {
    return JSON.stringify({ ok: true, skipped: true, nodes: store.nodes.length });
  }
  // 用当前知识库工作态播种项目（实体树 / 航道 / 地图 / 编辑器容器 / 剧本）
  // ⚠️ 先补齐懒加载的行星地图：项目模式下 loadMapData 不再回退知识库缓存
  //    （Phase 2.5 消除两套事实源），漏了这一步用例会看到「项目里没有行星图」。
  if (typeof store.loadAllMapDataForExport === 'function') {
    try { await store.loadAllMapDataForExport(); } catch (e) { console.warn('[harness] 预加载行星地图失败', e); }
  }
  const payload = store.exportCanvasToProject();
  const draft = createEmptyProject({ name: '__NAME__' });
  draft.entities = payload.entities || {};
  draft.hyperlanes = payload.hyperlanes || [];
  draft.maps = payload.maps || {};
  if (payload.scenarios) draft.scenarios = payload.scenarios;
  window.__projects = window.__projects || {};
  window.__projectCalls = window.__projectCalls || [];
  window.__projects[filePath] = JSON.parse(JSON.stringify(draft));
  const r = await proj.openProject(filePath);
  return JSON.stringify({
    ok: !!(r && r.success === true),
    error: (r && r.error) || '',
    seededEntities: Object.keys(draft.entities).length,
    nodes: store.nodes.length,
    hyperlanes: store.hyperlanes.length,
    maps: Object.keys(store.mapData || {}).length,
    source: store.canvasSource,
    filePath: proj.filePath,
  });
})()"""


def open_harness_project(cdp):
    """打开 harness 基线项目（幂等）。返回 (ok, info)。失败不抛错 —— 由用例的断言给出失败原因。"""
    expr = OPEN_HARNESS_JS.replace('__PATH__', HARNESS_PROJECT_PATH).replace('__NAME__', HARNESS_PROJECT_NAME)
    v = cdp.eval(expr)
    if isinstance(v, str) and v.startswith('{'):
        try:
            info = json.loads(v)
        except ValueError:
            return False, {'error': f'harness 项目返回值非 JSON：{v[:200]}'}
        return bool(info.get('ok')), info
    return False, {'error': f'harness 项目求值异常：{str(v)[:200]}'}


def ensure_case_state(cdp):
    """用例开始前的统一状态：数据就绪 + harness 基线项目已打开（写模式 = project）。"""
    ensure_data_ready(cdp)
    return open_harness_project(cdp)


# ─────────────────────────────────────────────────────────────
# 底图 fixture（用例自带，**不依赖产品默认值**）
#   2026-09-20 起司天不再硬编码/凭空注入任何示例底图（曾默认叫「德斯特星」—— 那是暮雨自用剧本名，
#   已按用户决策移除：新项目打开剧本模式就是「还没有底图」）。所以凡需要底图的用例必须自己声明：
#   建一张 + 让 ScenarioMap 选中它。否则 store.baseMaps 为空、组件 baseMapKey 为 ''，
#   时间轴/谱系/像素断言全部会看到空数据（「底图未加载 / eraChg = [] / eras: 0」）。
# ─────────────────────────────────────────────────────────────
OPEN_TEST_BASEMAP_JS = r"""(() => {
  const s = PLACEHOLDER_STORE;
  const KEY = __KEY__;
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: __NAME__ });
  const el = document.querySelector('.scenario-map-container');
  const sm = el && el.__vueParentComponent && el.__vueParentComponent.setupState;
  if (sm) {
    sm.baseMapKey = KEY;
    if (typeof sm.onBaseMapChange === 'function') sm.onBaseMapChange();
  }
  return JSON.stringify({
    exists: !!s.baseMaps[KEY],
    keys: Object.keys(s.baseMaps || {}),
    active: sm ? sm.baseMapKey : null,
  });
})()"""


def open_test_base_map(cdp, key='用例底图', name=None):
    """用例自带的底图 fixture：不存在则创建，并让 ScenarioMap 选中它。

    返回 (ok, info)；ok=False 时 info 里带原因（求值异常 / 未选中）。
    ⚠️ ScenarioMap 未挂载时只建不选（active=None）→ 调用方应确保已进入剧本模式。
    """
    expr = (OPEN_TEST_BASEMAP_JS
            .replace('PLACEHOLDER_STORE',
                     "document.querySelector('#app').__vue_app__._instance.setupState.store")
            .replace('__KEY__', json.dumps(key))
            .replace('__NAME__', json.dumps(name if name is not None else key)))
    v = cdp.eval(expr)
    if isinstance(v, str) and v.startswith('{'):
        try:
            info = json.loads(v)
        except ValueError:
            return False, {'error': f'底图 fixture 返回非 JSON：{v[:200]}'}
        return bool(info.get('exists')) and info.get('active') == key, info
    return False, {'error': f'底图 fixture 求值异常：{str(v)[:200]}'}


def store(cdp):
    """注意：不要序列化整个 Pinia store（proxy 返回空 {}）。用 view_level/node_count 等具体函数"""
    return None


def view_level(cdp):
    return cdp.eval("document.querySelector('#app').__vue_app__._instance.setupState.store.viewLevel")


def node_count(cdp):
    return cdp.eval("document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length")


def planet_map(cdp):
    """获取 PlanetMap 组件 setupState（DOM 最近实例）"""
    return cdp.eval("(() => { const el = document.querySelector('.planet-map-container'); return el ? el.__vueParentComponent.setupState : null; })()")


def goto_planet(cdp, planet_name='乐园星'):
    """直接导航到指定行星地图（世界→星域→星系→行星）。
    自底向上锚定：优先取有星域子节点的世界（避免取到空壳世界如"伏夜提加"，
    否则其 star_domain/galaxy 查找返回 undefined，抛 TypeError）。"""
    ensure_data_ready(cdp)
    expr = f"""(() => {{
      const app = document.querySelector('#app').__vue_app__;
      const s = app._instance.setupState.store;
      const nodes = s.nodes;
      // 找有星域子节点的世界
      let w = nodes.find(n => n.layer === 'world' && nodes.some(c => c.layer === 'star_domain' && c.parentId === n.id));
      if (!w) w = nodes.find(n => n.layer === 'world'); // 兜底
      const d = nodes.find(n => n.layer === 'star_domain' && n.parentId === w.id);
      const g = nodes.find(n => n.layer === 'galaxy' && n.parentId === d.id);
      const p = nodes.find(n => n.name === '{planet_name}' && n.layer === 'planet');
      if (!p) return 'no-planet';
      s.selectWorld(w); s.selectDomain(d); s.selectSystem(g); s.selectPlanet(p);
      return s.viewLevel;
    }})()"""
    return cdp.eval(expr)


def select_world_with_domains(cdp):
    """选中第一个有星域子节点的世界（避免空壳世界），进入 domain 视图。
    返回选中世界的 id；若无满足条件的世界返回第一个 world 的 id。"""
    ensure_data_ready(cdp)
    return cdp.eval("""(() => {
      const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
      const nodes = s.nodes;
      let w = nodes.find(n => n.layer === 'world' && nodes.some(c => c.layer === 'star_domain' && c.parentId === n.id));
      if (!w) w = nodes.find(n => n.layer === 'world');
      if (w) { s.selectWorld(w); return w.id; }
      return 'no-world';
    })()""")


def enter_edit(cdp):
    """进入行星地图编辑模式。

    选择器不依赖图标文本（图标已从 emoji 字形改为 <Icon> 组件）：
    优先用入口按钮的 class，其次按按钮文案「编辑地图」兜底（恒星系/星域视图的
    编辑开关是切换式按钮，文案在「编辑地图 / 完成编辑」之间变化）。
    """
    ensure_data_ready(cdp)
    return cdp.eval("""(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const b = btns.find(x => x.classList.contains('edit-entry-btn'))
             || btns.find(x => (x.textContent || '').includes('编辑地图'));
      if (!b) return 'no-btn';
      b.click();
      return 'ok';
    })()""")


def sample_colors(cdp, count=600):
    """采样画布唯一颜色数（判断渲染内容丰富度）"""
    expr = f"""(() => {{
      const c = document.querySelector('.canvas-wrapper canvas');
      if (!c) return 0;
      const ctx = c.getContext('2d');
      const w = c.width, h = c.height;
      const colors = new Set();
      for (let i = 0; i < {count}; i++) {{
        const x = Math.floor((i * 37) % w);
        const y = Math.floor((i * 61) % h);
        const d = ctx.getImageData(x, y, 1, 1).data;
        if (d[3] > 0) colors.add((d[0] << 16) | (d[1] << 8) | d[2]);
      }}
      return colors.size;
    }})()"""
    return cdp.eval(expr)


def terrain_names(cdp):
    """当前行星地形名称列表"""
    return cdp.eval("(() => { const pm = document.querySelector('.planet-map-container')?.__vueParentComponent.setupState; return pm ? JSON.stringify(pm.currentMapData.terrain.map(t => t.name)) : '[]'; })()")


def terrain_count(cdp):
    return cdp.eval("(() => { const pm = document.querySelector('.planet-map-container')?.__vueParentComponent.setupState; return pm ? pm.currentMapData.terrain.length : -1; })()")


def click_canvas_at_world(cdp, wx, wy, press=True, release=True):
    """在世界坐标 (wx, wy) 处模拟点击（自动转屏幕坐标）"""
    expr = f"""(() => {{
      const pm = document.querySelector('.planet-map-container').__vueParentComponent.setupState;
      const c = document.querySelector('.canvas-wrapper canvas');
      const r = c.getBoundingClientRect();
      const vt = pm.renderer.viewTransform;
      const sx = {wx} * vt.scale + vt.x + c.clientWidth/2;
      const sy = {wy} * vt.scale + vt.y + c.clientHeight/2;
      if (sx < 0 || sx > r.width || sy < 0 || sy > r.height) return 'out-of-view';
      const mk = (x, y, t) => new MouseEvent(t, {{ clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true, button: 0 }});
      {'c.dispatchEvent(mk(sx, sy, "mousedown"));' if press else ''}
      {'c.dispatchEvent(mk(sx, sy, "mouseup"));' if release else ''}
      return JSON.stringify({{ sx, sy }});
    }})()"""
    return cdp.eval(expr)


def confirm_yes(cdp):
    cdp.eval("window.confirm = () => true;")


def confirm_no(cdp):
    cdp.eval("window.confirm = () => false;")


def fit_world(cdp):
    """适屏整个世界（确保世界坐标可见；PlanetMap 的 zoomFit）"""
    return cdp.eval("(() => { const pm = document.querySelector('.planet-map-container')?.__vueParentComponent?.setupState; if (!pm) return 'no-pm'; pm.zoomFit(); return 'ok'; })()")


def set_pm_state(cdp, code):
    """在 PlanetMap setupState 上下文执行 JS 片段（变量 pm 已绑定，code 返回串行化结果）"""
    return cdp.eval(f"(() => {{ const pm = document.querySelector('.planet-map-container')?.__vueParentComponent?.setupState; if (!pm) return 'no-pm'; {code} }})()")


def drag_canvas_polyline(cdp, points, shift=False, ctrl=False):
    """按世界坐标折线拖拽（真实事件链路：mousedown → mousemove×N → mouseup）。

    points: [(x, y), ...]，至少 2 点；首点 mousedown、中间点逐个 mousemove、末点 mousemove+mouseup。
    shift/ctrl: 拖拽全程携带修饰键（框选需要 shift）。
    """
    pts_js = json.dumps(points)
    expr = f"""(() => {{
      const pm = document.querySelector('.planet-map-container')?.__vueParentComponent?.setupState;
      const c = document.querySelector('.canvas-wrapper canvas');
      if (!pm || !c) return 'no-canvas';
      const r = c.getBoundingClientRect();
      const vt = pm.renderer.viewTransform;
      const toSX = wx => wx * vt.scale + vt.x + c.clientWidth / 2;
      const toSY = wy => wy * vt.scale + vt.y + c.clientHeight / 2;
      const mk = (sx, sy, t) => new MouseEvent(t, {{ clientX: r.left + sx, clientY: r.top + sy, bubbles: true, cancelable: true, button: 0, shiftKey: {'true' if shift else 'false'}, ctrlKey: {'true' if ctrl else 'false'} }});
      const pts = {pts_js};
      c.dispatchEvent(mk(toSX(pts[0][0]), toSY(pts[0][1]), 'mousedown'));
      for (let i = 1; i < pts.length; i++) {{
        c.dispatchEvent(mk(toSX(pts[i][0]), toSY(pts[i][1]), 'mousemove'));
      }}
      const last = pts[pts.length - 1];
      c.dispatchEvent(mk(toSX(last[0]), toSY(last[1]), 'mouseup'));
      return 'ok';
    }})()"""
    return cdp.eval(expr)


def dblclick_canvas_at_world(cdp, wx, wy):
    """世界坐标双击（描点模式收尾 / 路线完成）"""
    expr = f"""(() => {{
      const pm = document.querySelector('.planet-map-container')?.__vueParentComponent?.setupState;
      const c = document.querySelector('.canvas-wrapper canvas');
      if (!pm || !c) return 'no-canvas';
      const r = c.getBoundingClientRect();
      const vt = pm.renderer.viewTransform;
      const sx = {wx} * vt.scale + vt.x + c.clientWidth / 2;
      const sy = {wy} * vt.scale + vt.y + c.clientHeight / 2;
      c.dispatchEvent(new MouseEvent('dblclick', {{ clientX: r.left + sx, clientY: r.top + sy, bubbles: true, cancelable: true, button: 0 }}));
      return 'ok';
    }})()"""
    return cdp.eval(expr)


def quantize_world_pts(cdp, pts):
    """把世界坐标点集量化为整数屏幕像素栅格上的精确世界坐标。

    原理：dispatch 的 clientY = rect.top + sy 会被引擎 floor；
    取 K = ceil(rect.top + sy) 并反解 world' = (K - rect.top - ch/2 - vt.y) / scale，
    则 floor(rect.top + sy') == K 恒成立，screenToWorld 还原结果与 world' 严格一致。

    合成 MouseEvent 的 clientX/Y 会被引擎截断为整数像素，zoom=0.2 时 1px 误差
    = 5 世界单位。所有拖拽/点击点先经本函数量化，保证断言可复现。
    （P2：从 test_18 提升为共享工具，供各画布编辑用例复用）
    """
    pts_js = json.dumps(pts)
    expr = f"""(() => {{
      const pm = document.querySelector('.planet-map-container')?.__vueParentComponent?.setupState;
      const c = document.querySelector('.canvas-wrapper canvas');
      if (!pm || !c) return '[]';
      const r = c.getBoundingClientRect();
      const vt = pm.renderer.viewTransform;
      const toSX = wx => wx * vt.scale + vt.x + c.clientWidth / 2;
      const toSY = wy => wy * vt.scale + vt.y + c.clientHeight / 2;
      const fromSX = sx => (sx - c.clientWidth / 2 - vt.x) / vt.scale;
      const fromSY = sy => (sy - c.clientHeight / 2 - vt.y) / vt.scale;
      const pts = {pts_js};
      return JSON.stringify(pts.map(([wx, wy]) => {{
        const kx = Math.ceil(r.left + toSX(wx));
        const ky = Math.ceil(r.top + toSY(wy));
        return [fromSX(kx - r.left), fromSY(ky - r.top)];
      }}));
    }})()"""
    return json.loads(cdp.eval(expr))
