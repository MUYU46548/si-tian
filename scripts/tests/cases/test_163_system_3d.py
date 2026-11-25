#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 163：星系 3D 观景（2026-10-27 计划 §1，独立一轮交付）

验收判据（与 docs/plan/REMAINING_BACKLOG_20261027.md §1 一一对应）：

  A. **入口**：`SystemDetailView` 头部有“3D 观景”；有 ≥1 颗行星时可用，
     无行星时灰禁且 `title` 说明原因（只读态不禁 —— 3D 是纯查看，不写数据）。
  B. **打开**：点一下 → 出现 3D canvas、无错误面板、渲染在跑（frames 增长），
     three chunk 是**动态加载**的（dev 下按需 import，构建侧由单测 b2 守源码）。
  C. **关闭**：Esc / “返回 2D”都能关；关掉后 3D 根节点消失、画布只剩 2D 那张、
     2D 视图没有重建（canvas 引用不变 = "原样恢复"）。
  D. **资源归零**：每次关闭后 `renderer.info.memory` 的 geometries / textures 都是 0
     —— 这是"遍历 dispose + forceContextLoss"的直接证据。
  E. **反复开关不涨**：连开连关 6 轮，每轮资源都归零、页面 canvas 数不增长。
  F. **E1/E2（2026-10-29）**：点中一颗行星 → 出现操作卡片（类型下拉 + 下钻）；
     改类型 → `node.planetClass` 落库（推断被显式值压过，单测 a4b 守优先级）；
     点“进入行星地图”→ 3D 关闭且 `viewLevel === 'planet'` 且 `currentPlanet` 就是那颗。
     （射线点选本身用真实鼠标坐标不好稳定复现：相机在动、行星在公转 —— 这里只喂"选中态"，
      验证点中之后那两条链。）
  G. **自定义类别（2026-11-25 第六轮）**：卡片“存为类别”→ 类别进项目载荷 + 类型下拉出现
     → 选中后 `node.planetClass` 落库、球面贴图真的换成那套颜色（读贴图像素，不是看截图）
     → 存盘/重开项目后类别与选择都还在（走 mock 的 projectSave/projectOpen 真载荷）
     → 还有天体在用时删除被拒（回执写明原因），改成别的类型后可删、撤销能恢复。

为什么用 store 直接进 system_detail：背包路径（点恒星亮点）已由 test_10 守；
本用例只关心 3D，少一次画布命中就少一处会误红的依赖。

⚠️ 无行星时的灰禁只能靠单测 `test_system3d_scene.js` 的 hasPlanets 判据覆盖 ——
   合成 fixture 里每个恒星系都有行星，现场造一个空系会污染后续用例。
"""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json
from lib.helpers import ensure_case_state  # noqa: E402

ROOT_SEL = '[data-testid="system-3d"]'
CANVAS_SEL = '[data-testid="system-3d-canvas"]'
OPEN_SEL = '[data-testid="system-3d-open"]'

# 每次都从 store 重取实例：组件被卸载后 `__vueParentComponent.exposed` 仍指向旧的 defineExpose 对象
READ_ROOT_JS = r"""(() => {
  const el = document.querySelector('%s');
  if (!el) return JSON.stringify({ root: false });
  const inst = el.__vueParentComponent;
  window.__s3d = inst;              // 关闭后还要读 getStats()
  const ex = (inst && inst.exposed) || {};
  const fn = (inst && inst.setupState && inst.setupState.getStats) || ex.getStats;
  const stats = typeof fn === 'function' ? fn() : null;
  return JSON.stringify({
    root: true,
    hasCanvas: !!document.querySelector('%s'),
    canvases: document.querySelectorAll('canvas').length,
    stats,
    error: (document.querySelector('[data-testid="system-3d-error"]') || {}).textContent || '',
    labels: document.querySelectorAll('.sys3d-label').length,
  });
})()""" % (ROOT_SEL, CANVAS_SEL)

READ_CLOSED_JS = r"""(() => {
  const inst = window.__s3d;
  const ex = (inst && inst.exposed) || {};
  const fn = (inst && inst.setupState && inst.setupState.getStats) || ex.getStats;
  const stats = typeof fn === 'function' ? fn() : null;
  return JSON.stringify({
    root: !!document.querySelector('%s'),
    canvases: document.querySelectorAll('canvas').length,
    twoD: !!document.querySelector('.system-detail-container canvas'),
    stats,
  });
})()""" % ROOT_SEL

ENTER_SYSTEM_JS = r"""(() => {
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const sys = s.nodes.find(n => n.layer === 'galaxy'
    && s.nodes.some(p => p.layer === 'planet' && p.parentId === n.id));
  if (!sys) return JSON.stringify({ ok: false, why: 'no-system-with-planets' });
  s.enterSystemDetail(sys);
  return JSON.stringify({ ok: true, system: sys.id, name: sys.displayName || sys.name });
})()"""

CLICK_OPEN_JS = r"""(() => {
  const b = document.querySelector('%s');
  if (!b) return JSON.stringify({ ok: false, why: 'no-button' });
  const info = { disabled: !!b.disabled, title: b.title || '' };
  if (b.disabled) return JSON.stringify({ ok: false, why: 'disabled', info });
  b.click();
  return JSON.stringify({ ok: true, info });
})()""" % OPEN_SEL

PRESS_ESC_JS = r"""(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }));
  return 'ok';
})()"""

CLICK_CLOSE_JS = r"""(() => {
  const b = document.querySelector('[data-testid="system-3d-close"]');
  if (!b) return 'no-button';
  b.click();
  return 'ok';
})()"""


def open_3d(cdp, timeout=40):
    """点开 3D 并等到 canvas 出现（dev 首次要现编译 three，给足时间）"""
    ok, obj = eval_json(cdp, CLICK_OPEN_JS, required=('ok',), desc='点 3D 观景')
    if not ok:
        return False, str(obj)
    if not obj.get('ok'):
        return False, f"按钮不可用：{obj}"
    if not wait_for(cdp, f"!!document.querySelector('{CANVAS_SEL}')", timeout=timeout, desc='3D canvas 出现'):
        # 区分"加载失败"与"根本没挂载"
        ok2, o2 = eval_json(cdp, READ_ROOT_JS, required=('root',), desc='3D 根节点')
        return False, f'3D canvas 超时未出现：{o2 if ok2 else o2}'
    return True, obj.get('info')


def read_root(cdp):
    ok, obj = eval_json(cdp, READ_ROOT_JS, required=('root',), desc='读 3D 统计')
    return (obj if ok else {'root': False, 'err': str(obj)}), ('' if ok else str(obj))


def close_3d(cdp, how='esc'):
    cdp.eval(PRESS_ESC_JS if how == 'esc' else CLICK_CLOSE_JS)
    if not wait_for(cdp, f"!document.querySelector('{ROOT_SEL}')", timeout=12, desc='3D 关闭'):
        return False, f'{how} 没能关掉 3D'
    return True, ''


def run(cdp):
    ensure_case_state(cdp)

    # ---------- A. 入口 ----------
    ok, info = eval_json(cdp, ENTER_SYSTEM_JS, required=('ok',), desc='进入单恒星系')
    if not ok:
        return False, f'进入 system_detail 失败：{info}'
    if not info.get('ok'):
        return False, f'找不到带行星的恒星系：{info}'
    time.sleep(0.8)

    ok, gate = eval_json(cdp, r"""(() => {
      const b = document.querySelector('%s');
      const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
      return JSON.stringify({
        level: s.viewLevel,
        mounted: !!document.querySelector('.system-detail-container'),
        button: !!b,
        disabled: b ? !!b.disabled : null,
        title: b ? (b.title || '') : '',
        planets: s.currentSystemPlanets.filter(p => p.layer === 'planet').length,
      });
    })()""" % OPEN_SEL, required=('level', 'button'), desc='读入口按钮')
    if not ok:
        return False, f'入口读取失败：{gate}'
    if gate['level'] != 'system_detail' or not gate['mounted']:
        return False, f'没进 system_detail（{gate["level"]}, mounted={gate["mounted"]}）'
    if not gate['button']:
        return False, '头部没有“3D 观景”按钮'
    if gate['planets'] < 1:
        return False, f'该系行星数异常（{gate["planets"]}），用例前提不成立'
    if gate['disabled']:
        return False, f'有 {gate["planets"]} 颗行星时按钮却是灰禁的（title={gate["title"]!r}）'

    canvas_before = cdp.eval("document.querySelector('.system-detail-container canvas') ? '1' : '0'")

    # ---------- B. 打开 ----------
    ok, why = open_3d(cdp)
    if not ok:
        return False, f'打开 3D 失败：{why}'

    time.sleep(1.4)  # 让 rAF 跑几十帧
    root, err = read_root(cdp)
    if err:
        return False, f'读 3D 统计异常：{err}'
    st = root.get('stats') or {}
    if root.get('error'):
        return False, f'3D 报错面板：{root["error"]}'
    if st.get('error'):
        return False, f'3D 内部错误：{st["error"]}'
    if not root.get('hasCanvas') or not root.get('canvases', 0) >= 2:
        return False, f'3D canvas 未挂载（{root.get("canvases")} 张 canvas）'
    if not (st.get('frames') or 0) >= 5:
        return False, f'3D 渲染没在跑（frames={st.get("frames")}）'
    if not (st.get('geometries') or 0) > 0 or not (st.get('textures') or 0) > 0:
        return False, f'资源计数异常（{st.get("geometries")} geo / {st.get("textures")} tex）'
    if not (root.get('labels') or 0) >= 1:
        return False, '没有生成行星名称标签（labels=0）'
    first = {'labels': root.get('labels'), 'frames': st.get('frames'),
             'geometries': st.get('geometries'), 'textures': st.get('textures')}

    # ---------- C/D. 关闭（Esc）+ 资源归零 + 2D 原样 ----------
    ok, why = close_3d(cdp, 'esc')
    if not ok:
        return False, why
    time.sleep(0.25)
    ok, closed = eval_json(cdp, READ_CLOSED_JS, required=('root',), desc='关闭后状态')
    if not ok:
        return False, f'关闭后读取失败：{closed}'
    cst = closed.get('stats') or {}
    mem = cst.get('memoryAtDispose') or {}
    if closed.get('root'):
        return False, 'Esc 之后 3D 根节点还在'
    if not closed.get('twoD'):
        return False, '关掉 3D 后 2D 画布不见了'
    if closed.get('canvases') != 1:
        return False, f'关掉 3D 后页面 canvas 数应为 1，实得 {closed.get("canvases")}'
    if mem.get('geometries') != 0 or mem.get('textures') != 0:
        return False, f'资源没归零：{mem}（遍历 dispose 漏了东西）'
    canvas_after = cdp.eval("document.querySelector('.system-detail-container canvas') ? '1' : '0'")
    if canvas_before != '1' or canvas_after != '1':
        return False, f'2D 画布没恢复（前 {canvas_before} / 后 {canvas_after}）'

    # ---------- E. 反复开关 6 轮（Esc / 按钮交替） ----------
    cycles = []
    for i in range(6):
        ok, why = open_3d(cdp, timeout=25)
        if not ok:
            return False, f'第 {i + 1} 轮打开失败：{why}'
        time.sleep(0.35)
        r, e = read_root(cdp)
        if e:
            return False, f'第 {i + 1} 轮读统计异常：{e}'
        s = r.get('stats') or {}
        if (s.get('frames') or 0) < 2:
            return False, f'第 {i + 1} 轮渲染没跑起来（frames={s.get("frames")}）'
        how = 'esc' if i % 2 == 0 else 'button'
        ok, why = close_3d(cdp, how)
        if not ok:
            return False, f'第 {i + 1} 轮关闭失败（{how}）：{why}'
        time.sleep(0.18)
        ok, c2 = eval_json(cdp, READ_CLOSED_JS, required=('root',), desc=f'第 {i + 1} 轮关闭后')
        if not ok:
            return False, f'第 {i + 1} 轮关闭后读取失败：{c2}'
        cs = c2.get('stats') or {}
        m = cs.get('memoryAtDispose') or {}
        cycles.append({
            'how': how,
            'geometries': m.get('geometries'),
            'textures': m.get('textures'),
            'disposed': cs.get('disposed'),
            'canvases': c2.get('canvases'),
        })
        if c2.get('root'):
            return False, f'第 {i + 1} 轮关掉后根节点还在'
        if c2.get('canvases') != 1:
            return False, f'第 {i + 1} 轮关掉后 canvas 数应为 1，实得 {c2.get("canvases")}'
        if m.get('geometries') != 0 or m.get('textures') != 0:
            return False, f'第 {i + 1} 轮资源没归零：{m}'

    detail = json.dumps({'first': first, 'cycles': cycles}, ensure_ascii=False)

    # ---------- F. E1/E2（2026-10-29）：点中行星 → 改类型落数据 / 下钻到行星地图 ----------
    # 射线点选用真实鼠标坐标不好稳定复现（相机在动、行星在公转），所以这里直接给组件喂
    # 一个"选中态"，只验证**点中之后那两条链**：改类型 → store.planetClass；下钻 → 进行星视图。
    ok, why = open_3d(cdp, timeout=25)
    if not ok:
        return False, f'F 段打开 3D 失败：{why}'
    time.sleep(0.4)
    ok, pick = eval_json(cdp, r""" (async () => {
      const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
      const planet = s.currentSystemPlanets.find((p) => p.layer === 'planet');
      const root = document.querySelector('[data-testid="system-3d"]');
      const pm = root && root.__vueParentComponent && root.__vueParentComponent.setupState;
      if (!planet || !pm) return JSON.stringify({ stage: 'setup', planet: !!planet, pm: !!pm });
      const before = (s.nodes.find((n) => n.id === planet.id) || {}).planetClass || null;
      pm.picked = { id: planet.id, name: planet.displayName || planet.name, classId: 'ocean', kind: 'planet' };
      await new Promise(r => setTimeout(r, 350));
      const out = {
        card: !!document.querySelector('[data-testid="sys3d-card"]'),
        select: !!document.querySelector('[data-testid="sys3d-class"]'),
        drill: !!document.querySelector('[data-testid="sys3d-drill"]'),
        before,
      };
      const sel = document.querySelector('[data-testid="sys3d-class"]');
      if (sel) {
        sel.value = 'arctic';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 450));
      }
      out.saved = (s.nodes.find((n) => n.id === planet.id) || {}).planetClass || null;
      out.label = (document.querySelector('[data-testid="sys3d-card"] .sys3d-card-sub') || {}).textContent || '';
      const drill = document.querySelector('[data-testid="sys3d-drill"]');
      if (drill) drill.click();
      await new Promise(r => setTimeout(r, 700));
      out.level = s.viewLevel;
      out.currentPlanet = s.currentPlanet ? s.currentPlanet.id : null;
      out.rootGone = !document.querySelector('[data-testid="system-3d"]');
      out.want = planet.id;
      return JSON.stringify(out);
    })() """, required=None, desc='3D 选中 → 改类型 / 下钻')
    if not ok or not isinstance(pick, dict):
        return False, f'F 段探针失败：{pick}'
    if pick.get('stage') == 'setup':
        return False, f'F 段装置不齐：{pick}'
    if not (pick.get('card') and pick.get('select') and pick.get('drill')):
        return False, f"F 段点中行星后没有操作卡片：{pick}"
    if pick.get('saved') != 'arctic':
        return False, f"F 段类型没落数据（before={pick.get('before')} saved={pick.get('saved')}）"
    if not pick.get('label'):
        return False, f"F 段卡片没显示类型名：{pick}"
    if pick.get('level') != 'planet' or pick.get('currentPlanet') != pick.get('want'):
        return False, f"F 段下钻没进行星地图：{pick}"
    if not pick.get('rootGone'):
        return False, f"F 段下钻后 3D 没关：{pick}"
    detail += ' | F: 改类型落数据 + 下钻进行星地图'

    # ---------- G. 自定义类别（2026-11-25 第六轮）----------
    # F 段结束停在行星视图（3D 已关）。回恒星系 → 再开 3D，用同一颗行星继续。
    want = pick.get('want')
    ok, back = eval_json(cdp, r"""(() => {
      const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
      const planet = s.nodes.find((n) => n.id === %s);
      const system = planet && s.nodes.find((n) => n.id === planet.parentId);
      if (!planet || !system) return JSON.stringify({ ok: false });
      s.enterSystemDetail(system);
      return JSON.stringify({ ok: true, planet: planet.id });
    })()""" % json.dumps(want), required=('ok',), desc='G 段回到恒星系')
    if not ok or not back.get('ok'):
        return False, f'G 段回不到恒星系：{back}'
    time.sleep(0.8)
    ok, why = open_3d(cdp, timeout=25)
    if not ok:
        return False, f'G 段打开 3D 失败：{why}'
    time.sleep(0.5)

    # G1 存类别 → 下拉出现 → 选中 → 贴图换色 → 删除闸门（全走界面入口）
    ok, g1 = eval_json(cdp, r""" (async () => {
      const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
      const planet = s.nodes.find((n) => n.id === %s);
      const root = document.querySelector('[data-testid="system-3d"]');
      const pm = root && root.__vueParentComponent && root.__vueParentComponent.setupState;
      if (!planet || !pm) return JSON.stringify({ stage: 'setup', planet: !!planet, pm: !!pm });
      const out = { stage: 'g1' };
      pm.picked = {
        id: planet.id,
        name: planet.displayName || planet.name,
        classId: planet.planetClass || 'arctic',
        kind: 'planet',
      };
      await new Promise((r) => setTimeout(r, 380));

      // ① 用拾色器把这颗调成**好认的颜色**（存类别时会被抄进类别定义）
      const color = document.querySelector('[data-testid="sys3d-color-base"]');
      out.colorInput = !!color;
      if (color) {
        color.value = '#ff00ff';
        color.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await new Promise((r) => setTimeout(r, 380));

      // ② 名字 + “存为类别”
      const name = document.querySelector('[data-testid="sys3d-preset-name"]');
      out.nameInput = !!name;
      if (name) {
        name.value = '机检熔金';
        name.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await new Promise((r) => setTimeout(r, 120));
      const saveBtn = document.querySelector('[data-testid="sys3d-class-save"]');
      out.saveBtn = !!saveBtn;
      out.saveDisabled = saveBtn ? !!saveBtn.disabled : null;
      if (saveBtn) saveBtn.click();
      await new Promise((r) => setTimeout(r, 520));

      out.classes = (s.planetClasses || []).map((c) => ({
        id: c.id, label: c.label, base: c.base, kind: c.kind, seed: c.seed,
      }));
      // 落盘链路的**第一段**：画布 → 项目载荷（存盘时 projectStore 拿到的就是它）
      out.payload = (s.exportCanvasToProject().planetClasses || []).map((c) => c.id);
      const sel = document.querySelector('[data-testid="sys3d-class"]');
      out.optionIds = sel ? Array.from(sel.querySelectorAll('option')).map((o) => o.value) : [];
      out.groupLabels = sel ? Array.from(sel.querySelectorAll('optgroup')).map((g) => g.label) : [];

      if (out.classes.length) {
        const cid = out.classes[0].id;
        out.customId = cid;
        sel.value = cid;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 520));
        out.savedClass = (s.nodes.find((n) => n.id === planet.id) || {}).planetClass || null;
        out.subLabel = (document.querySelector('[data-testid="sys3d-card"] .sys3d-card-sub') || {}).textContent || '';

        // ③ 贴图真的换了：读球面贴图 canvas 的像素（不是截图猜颜色）
        const hit = (pm.pickables || []).find((x) => x.body && x.body.id === planet.id);
        const img = hit && hit.mat && hit.mat.map && hit.mat.map.image;
        if (img && typeof img.getContext === 'function') {
          const g = img.getContext('2d');
          const px = g.getImageData(0, 0, img.width, img.height).data;
          let near = 0;
          for (let i = 0; i < px.length; i += 4) {
            if (Math.abs(px[i] - 255) <= 2 && px[i + 1] <= 2 && Math.abs(px[i + 2] - 255) <= 2) near += 1;
          }
          out.magenta = near;
          out.texW = img.width;
          out.texH = img.height;
        }

        // ④ 删除闸门：这个类别正被这颗行星用着 → 必须拒绝，而且回执要写明原因
        const mg = document.querySelector('[data-testid="sys3d-class-manage"]');
        out.manageExists = !!mg;
        if (mg) {
          mg.value = cid;
          mg.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await new Promise((r) => setTimeout(r, 150));
        const del = document.querySelector('[data-testid="sys3d-class-delete"]');
        out.deleteExists = !!del;
        if (del) del.click();
        await new Promise((r) => setTimeout(r, 260));
        out.afterDeleteTry = (s.planetClasses || []).length;
        out.status = (document.querySelector('[data-testid="system-3d-status"]') || {}).textContent || '';
      }
      return JSON.stringify(out);
    })() """ % json.dumps(want), required=None, desc='G1 存为类别 / 选中 / 贴图像素 / 删除闸门')
    if not ok or not isinstance(g1, dict):
        return False, f'G1 探针失败：{g1}'
    if g1.get('stage') == 'setup':
        return False, f'G1 装置不齐：{g1}'
    for key, msg in (
        ('colorInput', 'G1 卡片里没有拾色器'),
        ('nameInput', 'G1 卡片里没有名字输入'),
        ('saveBtn', 'G1 卡片里没有“存为类别”按钮'),
    ):
        if not g1.get(key):
            return False, f'{msg}：{g1}'
    if g1.get('saveDisabled'):
        return False, f"G1 “存为类别”在项目态是灰的：{g1}"
    classes = g1.get('classes') or []
    if len(classes) != 1:
        return False, f"G1 存类别失败（store.planetClasses={classes}）"
    cls = classes[0]
    if cls.get('label') != '机检熔金':
        return False, f"G1 类别名不对：{cls}"
    if cls.get('base') != '#ff00ff':
        return False, f"G1 类别没抄到拾色器的主色：{cls}"
    if cls.get('kind') != 'terra':
        return False, f"G1 类别 kind 不对：{cls}"
    if cls.get('seed') != 'arctic':
        return False, f"G1 类别 seed 没记住祖类别（F 段把它改成了 arctic）：{cls}"
    cid = g1.get('customId')
    if cid not in g1.get('payload', []):
        return False, f"G1 类别没进项目载荷（存盘必丢）：payload={g1.get('payload')}"
    if cid not in g1.get('optionIds', []):
        return False, f"G1 类别没出现在类型下拉里：options={g1.get('optionIds')}"
    if '本项目自定义' not in (g1.get('groupLabels') or []):
        return False, f"G1 类型下拉没有“本项目自定义”分组：{g1.get('groupLabels')}"
    if g1.get('savedClass') != cid:
        return False, f"G1 选中类别后 node.planetClass 没落库：{g1}"
    if '机检熔金' not in (g1.get('subLabel') or ''):
        return False, f"G1 卡片没显示类别名：{g1.get('subLabel')!r}"
    if (g1.get('texW'), g1.get('texH')) != (512, 256):
        return False, f"G1 贴图尺寸异常：{g1.get('texW')}x{g1.get('texH')}"
    if (g1.get('magenta') or 0) < 20000:
        return False, (f"G1 球面贴图没换成类别主色（#ff00ff 像素 {g1.get('magenta')} / 131072）"
                       ' —— 下拉选了但贴图没重建？')
    if not (g1.get('manageExists') and g1.get('deleteExists')):
        return False, f"G1 缺类别库删除入口：{g1}"
    if g1.get('afterDeleteTry') != 1:
        return False, f"G1 还有行星在用的类别被删掉了（数据会丢）：{g1}"
    if '在用' not in (g1.get('status') or ''):
        return False, f"G1 删除被拒但没说明原因：{g1.get('status')!r}"

    # G2 存盘 → 关项目 → 重开：类别与选择必须都回来（真实载荷往返，不靠内存）
    ok, g2 = eval_json(cdp, r""" (async () => {
      const app = document.querySelector('#app').__vue_app__;
      const s = app._instance.setupState.store;
      const { useProjectStore } = await import('/src/store/projectStore.js');
      const { planetClassDef } = await import('/src/utils/planetArt.js');
      const ps = useProjectStore(app.config.globalProperties.$pinia);
      const out = { stage: 'g2', want: %s, cid: %s };
      await window.__probe.flushProject();
      out.fileClasses = ((window.__probe.projectFile() || {}).planetClasses || []).map((c) => c.id);
      const closed = await ps.closeProject();
      out.closed = !!(closed && closed.success);
      out.clearedOnClose = (s.planetClasses || []).length;
      const reopened = await ps.openProject(window.__probe.harnessProjectPath);
      out.reopened = !!(reopened && reopened.success);
      out.classesAfter = (s.planetClasses || []).map((c) => ({ id: c.id, label: c.label, base: c.base }));
      out.planetClassAfter = (s.nodes.find((n) => n.id === out.want) || {}).planetClass || null;
      try { out.defAfter = planetClassDef(out.cid).label; } catch (e) { out.defAfter = 'ERR:' + e; }
      return JSON.stringify(out);
    })() """ % (json.dumps(want), json.dumps(cid)), required=None, desc='G2 存盘 / 关项目 / 重开')
    if not ok or not isinstance(g2, dict):
        return False, f'G2 探针失败：{g2}'
    if cid not in (g2.get('fileClasses') or []):
        return False, f"G2 类别没写进项目文件（flush 后磁盘载荷）：{g2}"
    if not g2.get('closed'):
        return False, f"G2 关项目失败：{g2}"
    if g2.get('clearedOnClose') != 0:
        return False, f"G2 关项目后注册表/状态没清（会串到知识库态）：{g2}"
    if not g2.get('reopened'):
        return False, f"G2 重开项目失败：{g2}"
    if [c.get('id') for c in (g2.get('classesAfter') or [])] != [cid]:
        return False, f"G2 重开后类别没回来：{g2}"
    if g2.get('planetClassAfter') != cid:
        return False, f"G2 重开后行星的类型没回来：{g2}"
    if g2.get('defAfter') != '机检熔金':
        return False, f"G2 重开后渲染层注册表认不出这个类别：{g2}"

    # G3 删除语义：在用 → 拒绝；改成内置类型 → 可删；撤销 → 类别与注册表一起回来
    ok, g3 = eval_json(cdp, r""" (async () => {
      const app = document.querySelector('#app').__vue_app__;
      const s = app._instance.setupState.store;
      const { planetClassDef, getPlanetDisc } = await import('/src/utils/planetArt.js');
      const out = { stage: 'g3', want: %s, cid: %s };
      // 2D 圆盘走同一个类别解析口：注册表里有这个类别，圆盘就必须出得来（不是只给 3D 用）
      const disc = getPlanetDisc(out.cid, 48);
      out.disc = { ok: !!(disc && disc.width === 48), w: disc ? disc.width : null };
      const refused = s.removePlanetClass(out.cid);
      out.refused = !!(refused && refused.ok === false);
      out.refusedReason = (refused && refused.reason) || '';
      out.stillThere = (s.planetClasses || []).some((c) => c.id === out.cid);
      s.updateNode(out.want, { planetClass: 'continental' });
      await new Promise((r) => setTimeout(r, 120));
      const removed = s.removePlanetClass(out.cid);
      out.removed = !!(removed && removed.ok === true);
      out.afterRemove = (s.planetClasses || []).length;
      out.defAfterRemoveId = planetClassDef(out.cid).id;
      s.undo();
      await new Promise((r) => setTimeout(r, 120));
      out.afterUndo = (s.planetClasses || []).length;
      out.defAfterUndo = planetClassDef(out.cid).label;
      return JSON.stringify(out);
    })() """ % (json.dumps(want), json.dumps(cid)), required=None, desc='G3 删除语义 / 撤销')
    if not ok or not isinstance(g3, dict):
        return False, f'G3 探针失败：{g3}'
    if not g3.get('refused') or not g3.get('stillThere'):
        return False, f"G3 在用中的类别没被拒绝删除：{g3}"
    if '在用' not in (g3.get('refusedReason') or ''):
        return False, f"G3 拒绝删除但没说原因：{g3}"
    if not g3.get('removed') or g3.get('afterRemove') != 0:
        return False, f"G3 改成内置类型后仍删不掉：{g3}"
    if g3.get('defAfterRemoveId') != 'continental':
        return False, f"G3 删掉后注册表还认那个类别（会画鬼影）：{g3}"
    if g3.get('afterUndo') != 1 or g3.get('defAfterUndo') != '机检熔金':
        return False, f"G3 撤销后类别/注册表没回来：{g3}"

    detail += (' | G: 存类别→下拉→贴图 #ff00ff→存盘重开→在用拒删/撤销恢复'
               f'（magenta={g1.get("magenta")}px）')

    return True, f'3D 观景：开→渲染→关 6 轮，资源每次归零，2D 未重建 | {detail}'
