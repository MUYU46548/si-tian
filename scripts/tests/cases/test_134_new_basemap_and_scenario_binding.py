#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 134：已有底图时也能「新建空底图」+ 新建剧本显示绑定哪张底图（2026-10-22）

用户原话：「连新底图都建不了，是功能缺失」；起因是他新建的剧本还是旧底图
（新建剧本表单不选底图，直接绑**当前**底图，界面上也没写）。

本用例守：
  a 工具栏「空底图」按钮（在「更多」的底图行里）：已有底图时点一下 → 真的多一张**空**底图并切过去；
    一笔 = 一条 undo（undo 收回 / redo 再建），状态栏有回执；
  b 新建剧本表单第一行显示「底图：<当前底图>」，点旁边的「＋ 新建空底图」能当场建一张并绑定；
  c 没有底图时「创建」按钮禁用，直接调 `createNewScenario()` 也会被拦（不生成 ownerKey 为空的孤儿剧本）；
  d 建出来的剧本 ownerKey = 新底图、id 前缀 = 新底图；
  e 源码闸门：三个入口（工具栏 / 空态 / 表单）共用 `createEmptyBaseMap` / `addEmptyBaseMap`，
    只读态有 disabled（不靠点了才拒）。
"""
import json
import os
import time

from lib.cdp import eval_json, wait_for
from lib.helpers import ensure_case_state

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def _source_gates():
    fails = []
    src = open(os.path.join(ROOT, 'src', 'renderer', 'src', 'components', 'ScenarioMap.vue'), encoding='utf-8').read()
    # 2026-10-31：动作体搬进 scenario/interaction/* —— 判据读合集
    from lib.rsrc import render_src as _rsrc_all
    src = _rsrc_all()
    checks = [
        ('data-testid="basemap-add-empty"', '工具栏「空底图」按钮'),
        ('function createEmptyBaseMap(', '建空底图的唯一核心'),
        ('function addEmptyBaseMap(', '建空底图 + 切过去的唯一动作'),
        ('data-testid="new-scenario-basemap"', '新建剧本表单显示绑定底图'),
        ('data-testid="new-scenario-basemap-add"', '表单里的「＋ 新建空底图」出口'),
        ('!store.baseMaps?.[baseMapKey]', '「创建」在无底图/底图已删时禁用'),
        ('新建剧本失败：还没有选中底图', '直接调创建函数也会被拦'),
    ]
    for needle, label in checks:
        if needle not in src:
            fails.append(f'源码闸门缺：{label}（{needle}）')
    if ':disabled="store.isReadOnly"' not in src:
        fails.append('底图「空底图」按钮没有只读禁用')
    return fails


def _state(cdp):
    ok, v = eval_json(cdp, """(() => {
      const s = __STORE__, sm = __SM__;
      return JSON.stringify({
        baseMaps: Object.keys(s.baseMaps || {}),
        current: sm.baseMapKey,
        scenarios: Object.fromEntries(Object.entries(s.scenarios || {}).map(([k, v]) => [k, v.ownerKey || ''])),
        hint: String(sm.provinceHint || ''),
      });
    })()""".replace('__STORE__', STORE).replace('__SM__', SM),
        required=None, desc='读状态')
    return v if ok and isinstance(v, dict) else {'error': v}


def _seed_base(cdp):
    """基线项目不一定有底图 —— 先种一张（否则「已有底图时再加一张」无从谈起）。"""
    st = _state(cdp)
    if st.get('baseMaps'):
        return st
    cdp.eval("""(async () => {
      const s = __STORE__, sm = __SM__;
      s.addBaseMap('用例134底图', { name: '用例134底图' });
      sm.baseMapKey = '用例134底图';
      if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
      return 'ok';
    })()""".replace('__STORE__', STORE).replace('__SM__', SM))
    time.sleep(0.5)
    return _state(cdp)


def _open_more(cdp):
    """「更多」默认收起 —— 底图行（含「空底图」按钮）在它里面。"""
    cdp.eval("""(() => {
      const b = Array.from(document.querySelectorAll('button'))
        .find(x => (x.textContent || '').trim().startsWith('更多'));
      if (b && !b.classList.contains('active')) b.click();
      return 'ok';
    })()""")
    time.sleep(0.35)


def _open_manager(cdp):
    cdp.eval("(() => { const sm = %s; sm.showScenarioManager = true; return 'ok'; })()" % SM)
    wait_for(cdp, "!!document.querySelector('[data-testid=\"scenario-create\"]')", timeout=10, desc='剧本管理对话框')


def _fill_name(cdp, name):
    cdp.eval("""(() => {
      const inp = document.querySelector('.new-scenario-form input');
      if (!inp) return 'no-input';
      inp.value = %s;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()""" % json.dumps(name))
    time.sleep(0.2)


def run(cdp):
    fails = _source_gates()
    ok, info = ensure_case_state(cdp)
    if not ok:
        return False, f'harness 项目未就绪：{info}'
    cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
             ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式')

    before = _seed_base(cdp)
    if not before.get('baseMaps'):
        return False, '种底图失败：基线项目里仍然没有底图'

    # ── a 工具栏「空底图」（更多 → 底图行） ─────────────────────────────────
    _open_more(cdp)
    wait_for(cdp, "!!document.querySelector('[data-testid=\"basemap-add-empty\"]')", timeout=8, desc='空底图按钮')
    ok_btn, btn = eval_json(cdp, """(() => {
      const b = document.querySelector('[data-testid="basemap-add-empty"]');
      return JSON.stringify({ exists: !!b, disabled: !!(b && b.disabled), text: b ? b.textContent.trim() : '' });
    })()""", required=None, desc='空底图按钮')
    if not (isinstance(btn, dict) and btn.get('exists')):
        return False, '工具栏（更多 → 底图行）找不到「空底图」按钮'
    if btn.get('disabled'):
        return False, f"'空底图'按钮被禁用（当前不该是只读态）：{btn}"

    cdp.eval("document.querySelector('[data-testid=\"basemap-add-empty\"]').click()")
    time.sleep(0.7)
    after = _state(cdp)
    new_keys = [k for k in after.get('baseMaps', []) if k not in before['baseMaps']]
    if len(new_keys) != 1:
        fails.append(f"点「空底图」没有建出新底图（{before['baseMaps']} → {after.get('baseMaps')}）：{after.get('hint')}")
        return False, '；'.join(fails)
    tool_key = new_keys[0]
    if after.get('current') != tool_key:
        fails.append(f"新建后没有切到新底图（当前仍是 {after.get('current')}）")
    if '空底图' not in str(after.get('hint')):
        fails.append(f"新建后状态栏没有回执：{after.get('hint')}")
    ok_e, empty = eval_json(cdp, "(() => JSON.stringify({ terrain: (%s.baseMaps[%s].terrain || []).length }))()"
                           % (STORE, json.dumps(tool_key)), required=None, desc='新底图是空的')
    if not (isinstance(empty, dict) and empty.get('terrain') == 0):
        fails.append(f"新底图不是空的：{empty}")

    # 一笔 = 一条 undo；撤销后把选择器收回到一张真实存在的底图
    cdp.eval(f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.3)
    undone = _state(cdp)
    if tool_key in undone.get('baseMaps', []):
        fails.append('撤销后新底图还在（新建底图没有走 undo）')
    cdp.eval("""(async () => {
      const sm = %s;
      sm.baseMapKey = %s;
      if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
      return 'ok';
    })()""" % (SM, json.dumps(before['baseMaps'][0])))
    time.sleep(0.3)
    cdp.eval(f"(() => {{ {STORE}.redo(); return 'ok'; }})()")
    time.sleep(0.3)
    if tool_key not in _state(cdp).get('baseMaps', []):
        fails.append('重做后新底图没回来')

    # ── b/c/d 新建剧本：显示绑定底图 / 表单里建新底图 / ownerKey 正确 ────────
    scn_key = None
    _open_manager(cdp)
    ok_b, bound = eval_json(cdp, """(() => {
      const el = document.querySelector('[data-testid="new-scenario-basemap"]');
      return JSON.stringify(el ? el.innerText.trim() : null);
    })()""", required=None, desc='绑定底图提示')
    ok_add, add_info = eval_json(cdp, """(() => JSON.stringify({
      has: !!document.querySelector('[data-testid="new-scenario-basemap-add"]')
    }))()""", required=None, desc='表单内新建底图按钮')
    has_add = isinstance(add_info, dict) and add_info.get('has')
    if not has_add:
        fails.append('表单里没有「＋ 新建空底图」出口')
    else:
        cdp.eval("document.querySelector('[data-testid=\"new-scenario-basemap-add\"]').click()")
        time.sleep(0.7)
        after_add = _state(cdp)
        scn_keys = [k for k in after_add.get('baseMaps', []) if k not in before['baseMaps'] and k != tool_key]
        if not scn_keys:
            fails.append(f"表单里点「＋ 新建空底图」没有建出新底图：{after_add.get('baseMaps')}")
        else:
            scn_key = scn_keys[0]
            ok_b2, bound2 = eval_json(cdp, """(() => {
              const el = document.querySelector('[data-testid="new-scenario-basemap"]');
              return JSON.stringify(el ? el.innerText.trim() : null);
            })()""", required=None, desc='绑定更新')
            if scn_key not in str(bound2):
                fails.append(f"建完新底图后绑定提示没更新（{bound2}）")

            _fill_name(cdp, '用例134剧本')
            # Vue 的 DOM 更新在事件后的一拍 —— 有界轮询等它变可点（别用固定 sleep 赌）
            try:
                wait_for(cdp, "!document.querySelector('[data-testid=\"scenario-create\"]').disabled",
                         timeout=5, desc='创建按钮可点')
            except Exception:
                pass
            ok_d, dis_info = eval_json(cdp, """(() => JSON.stringify({
              disabled: !!document.querySelector('[data-testid="scenario-create"]').disabled
            }))()""", required=None, desc='创建按钮状态')
            disabled = isinstance(dis_info, dict) and dis_info.get('disabled')
            if disabled:
                ok_diag, diag = eval_json(cdp, """(() => {
                  const sm = %s, s = %s;
                  return JSON.stringify({
                    name: sm.newScenario && sm.newScenario.name,
                    base: sm.baseMapKey,
                    baseExists: !!(s.baseMaps || {})[sm.baseMapKey],
                    manager: sm.showScenarioManager,
                    readOnly: !!s.isReadOnly,
                    writeMode: s.writeMode,
                  });
                })()""" % (SM, STORE), required=None, desc='禁用诊断')
                ok_list, lst = eval_json(cdp, """(() => {
                  const arr = Array.from(document.querySelectorAll('[data-testid="scenario-create"]'));
                  return JSON.stringify(arr.map(el => ({
                    disabled: !!el.disabled,
                    text: el.textContent.trim(),
                    visible: !!(el.offsetWidth || el.offsetHeight),
                    parent: el.closest('.new-scenario-form') ? 'form' : '?',
                  })));
                })()""", required=None, desc='按钮清单')
                fails.append(f"有底图、有名字时「创建」仍被禁用：diag={diag} list={lst}")
            cdp.eval("document.querySelector('[data-testid=\"scenario-create\"]').click()")
            time.sleep(0.5)
            made = _state(cdp)
            new_sc = [k for k in made.get('scenarios', {}) if k not in before.get('scenarios', {})]
            if not new_sc:
                fails.append(f"剧本没有建出来：{made.get('scenarios')}")
            else:
                sid = new_sc[0]
                if made['scenarios'][sid] != scn_key:
                    fails.append(f"新剧本绑的底图不对：ownerKey={made['scenarios'][sid]}，期望 {scn_key}")
                if not sid.startswith(scn_key + '/'):
                    fails.append(f"新剧本 id 前缀不是新底图：{sid}")

    # ── c 没有底图时：按钮禁用 + 直接调函数也拦 ──────────────────────────────
    _open_manager(cdp)
    cdp.eval("(() => { const sm = %s; sm.baseMapKey = ''; return 'ok'; })()" % SM)
    time.sleep(0.2)
    ok_nd, nd_info = eval_json(cdp, """(() => JSON.stringify({
      disabled: !!document.querySelector('[data-testid="scenario-create"]').disabled
    }))()""", required=None, desc='无底图时创建按钮状态')
    no_base_disabled = isinstance(nd_info, dict) and nd_info.get('disabled')
    if not no_base_disabled:
        fails.append('没有底图时「创建」按钮仍可点（会建出孤儿剧本）')
    _fill_name(cdp, '用例134孤儿')
    count_before = len(_state(cdp).get('scenarios', {}))
    cdp.eval("(() => { const sm = %s; sm.createNewScenario(); return 'ok'; })()" % SM)
    time.sleep(0.3)
    count_after = len(_state(cdp).get('scenarios', {}))
    if count_after != count_before:
        fails.append(f"没有底图时直接调 createNewScenario() 竟然建了剧本（{count_before} → {count_after}）")
    if '还没有选中底图' not in str(_state(cdp).get('hint')):
        fails.append(f"没有底图时没有可读回执：{_state(cdp).get('hint')}")

    # 收尾：删掉本用例建的剧本与底图，恢复基线
    cleanup_keys = [k for k in (tool_key, scn_key) if k]
    for k in cleanup_keys:
        eval_json(cdp, """(() => {
          const s = %s;
          Object.keys(s.scenarios || {}).forEach(sid => { if (sid.startsWith(%s)) s.removeScenario(sid); });
          if (s.baseMaps[%s]) s.removeBaseMap(%s);
          return 'ok';
        })()""" % (STORE, json.dumps(k), json.dumps(k), json.dumps(k)), required=None, desc='收尾')
    eval_json(cdp, """(() => {
      const s = %s, sm = %s;
      if (s.baseMaps['用例134底图']) s.removeBaseMap('用例134底图');
      sm.showScenarioManager = false;
      sm.baseMapKey = '';
      return 'ok';
    })()""" % (STORE, SM), required=None, desc='收尾2')
    time.sleep(0.3)

    if fails:
        return False, '；'.join(fails)
    return True, f"工具栏「空底图」建出「{tool_key}」并切换 / 一笔撤销 / 表单内建图并绑定 / 无底图时拦住"
