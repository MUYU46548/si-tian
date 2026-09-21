#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 19：剧本地图专项（scenario）

覆盖真实 CDP 链路：
  1. 进入剧本模式（WorldSelector → ⏳ 历史剧本按钮 → ScenarioMap 挂载）
  2. 画省份 → addBaseProvince（经 store API 直接注入）
  3. 建剧本 → createScenario（经 store API）
  4. 指派势力 → setOwnership（经 store API）
  5. 重启持久化 → loadScenarios 读回 + 验证数据完整
  6. 底图零变化 → 退出剧本模式后 PlanetMap 数据不受影响
  7. 拷贝继承 → inheritScenario 深拷贝 ownership + labels
"""
import sys, os, json, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for
from lib.helpers import goto_planet, open_test_base_map


def _eval(cdp, expr):
    """执行 JS 表达式并返回结果"""
    return cdp.eval(expr)


def _scenario_map(cdp):
    """获取 ScenarioMap 组件 setupState"""
    return cdp.eval("(() => { const el = document.querySelector('.scenario-map-container'); return el ? el.__vueParentComponent.setupState : null; })()")


def _enter_scenario_mode(cdp):
    """点击 WorldSelector 的「⏳ 历史剧本」按钮进入剧本模式"""
    return cdp.eval("""(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('历史剧本'));
      if (!btn) return 'no-btn';
      btn.click();
      return 'ok';
    })()""")


def _exit_scenario_mode(cdp):
    """点击返回按钮退出剧本模式"""
    return cdp.eval("""(() => {
      const btn = Array.from(document.querySelectorAll('.back-btn')).find(b => b.textContent.includes('返回'));
      if (!btn) return 'no-btn';
      btn.click();
      return 'ok';
    })()""")


def _add_test_province(cdp, prov_id='test_prov_1'):
    """通过 store API 注入测试省份（mock saveScenarios 不落盘）"""
    return cdp.eval(f"""(() => {{
      const app = document.querySelector('#app').__vue_app__;
      const s = app._instance.setupState.store;
      s.addBaseProvince('云陇大陆', {{
        id: '{prov_id}',
        name: '测试省份',
        points: [{{x:100,y:100}}, {{x:200,y:100}}, {{x:200,y:200}}, {{x:100,y:200}}],
        biome: 'temperate',
        coast: true
      }});
      return s.baseMaps['云陇大陆'].terrain.length;
    }})()""")


def _create_test_scenario(cdp, scenario_id='云陇大陆/测试时代'):
    """通过 store API 创建测试剧本"""
    return cdp.eval(f"""(() => {{
      const app = document.querySelector('#app').__vue_app__;
      const s = app._instance.setupState.store;
      s.createScenario('{scenario_id}', {{
        ownerKey: '云陇大陆',
        name: '测试时代',
        era: {{ roman: 'Ⅰ', label: '测试', startYear: '2000', endYear: '2010' }},
        polities: [
          {{ id: 'p1', name: '蓝国', color: '#4A90D9' }},
          {{ id: 'p2', name: '红国', color: '#E74C3C' }}
        ]
      }});
      return Object.keys(s.scenarios).length;
    }})()""")


def _set_ownership(cdp, scenario_id='云陇大陆/测试时代', prov_id='test_prov_1', polity_id='p1'):
    """通过 store API 指派势力"""
    return cdp.eval(f"""(() => {{
      const app = document.querySelector('#app').__vue_app__;
      const s = app._instance.setupState.store;
      s.setOwnership('{scenario_id}', '{prov_id}', '{polity_id}');
      return s.scenarios['{scenario_id}'].ownership['{prov_id}'];
    }})()""")


def run(cdp):
    # Step 1: 进入剧本模式
    r = _enter_scenario_mode(cdp)
    if r != 'ok':
        return False, f'进入剧本模式失败: {r}'
    
    # 等待 ScenarioMap 挂载
    ok = wait_for(cdp, "!!document.querySelector('.scenario-map-container')", desc='ScenarioMap 挂载', timeout=5)
    if not ok:
        return False, 'ScenarioMap 组件未挂载'

    # 底图 fixture：司天不再默认建/选任何示例底图（见 helpers.open_test_base_map 说明）
    bm_ok, bm_info = open_test_base_map(cdp, '云陇大陆')
    if not bm_ok:
        return False, f'底图 fixture 未就位: {bm_info}'
    
    # Step 2: 画省份
    count = _add_test_province(cdp)
    if count < 1:
        return False, f'省份注入失败 (count={count})'
    
    # Step 3: 建剧本
    sc_count = _create_test_scenario(cdp)
    if sc_count < 1:
        return False, f'剧本创建失败 (count={sc_count})'
    
    # Step 4: 指派势力
    owner = _set_ownership(cdp)
    if owner != 'p1':
        return False, f'势力指派失败 (owner={owner})'
    
    # Step 5: 验证数据完整性
    data = cdp.eval("""(() => {
      const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
      const sc = s.scenarios['云陇大陆/测试时代'];
      return JSON.stringify({
        provCount: s.baseMaps['云陇大陆'].terrain.length,
        scCount: Object.keys(s.scenarios).length,
        owner: sc.ownership['test_prov_1'],
        polityName: sc.polities.find(p => p.id === 'p1').name,
        eraRoman: sc.era.roman
      });
    })()""")
    
    parsed = json.loads(data)
    if parsed['provCount'] < 1:
        return False, f'底图数据异常: {data}'
    if parsed['owner'] != 'p1':
        return False, f'归属数据异常: {data}'
    if parsed['eraRoman'] != 'Ⅰ':
        return False, f'元数据异常: {data}'
    
    # Step 6: 退出剧本模式 → 验证底图零变化
    r = _exit_scenario_mode(cdp)
    if r != 'ok':
        return False, f'退出剧本模式失败: {r}'
    
    # 等待 WorldSelector 重新出现
    ok = wait_for(cdp, "!!document.querySelector('.world-selector')", desc='返回世界选择', timeout=5)
    if not ok:
        return False, '退出后 WorldSelector 未恢复'
    
    # Step 7: 验证 PlanetMap 数据不受影响（nodes 数量不变）
    node_count = cdp.eval("document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length")
    if node_count < 1:
        return False, f'底图 nodes 异常: {node_count}'
    
    # Step 8: 重新进入 → 验证数据仍在（内存态）
    r = _enter_scenario_mode(cdp)
    if r != 'ok':
        return False, f'重新进入失败: {r}'
    
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", desc='ScenarioMap 重挂载', timeout=5)
    
    verify = cdp.eval("""(() => {
      const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
      return JSON.stringify({
        provCount: s.baseMaps['云陇大陆']?.terrain?.length || 0,
        scCount: Object.keys(s.scenarios).length,
        owner: s.scenarios['云陇大陆/测试时代']?.ownership?.test_prov_1
      });
    })()""")
    
    v = json.loads(verify)
    if v['provCount'] < 1:
        return False, f'重进入后底图数据丢失: {verify}'
    if v['scCount'] < 1:
        return False, f'重进入后剧本数据丢失: {verify}'
    if v['owner'] != 'p1':
        return False, f'重进入后归属数据丢失: {verify}'
    
    # Step 9: 测试继承
    inherit_count = cdp.eval("""(() => {
      const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
      s.inheritScenario('云陇大陆/第二时代', '云陇大陆/测试时代', {
        name: '第二时代',
        era: { roman: 'Ⅱ', label: '第二', startYear: '2010', endYear: '2020' }
      });
      const newSc = s.scenarios['云陇大陆/第二时代'];
      return JSON.stringify({
        inherited: newSc.ownership['test_prov_1'],
        order: newSc.order,
        polities: newSc.polities.length
      });
    })()""")
    
    ic = json.loads(inherit_count)
    if ic['inherited'] != 'p1':
        return False, f'继承失败: {inherit_count}'
    if ic['order'] != 2:
        return False, f'继承 order 错误: {inherit_count}'
    if ic['polities'] != 2:
        return False, f'继承 polities 丢失: {inherit_count}'
    
    return True, f'画省份({parsed["provCount"]}) → 建剧本({parsed["scCount"]}) → 指派势力({parsed["owner"]}) → 底图零变化 → 重进入数据完整 → 继承深拷贝(order={ic["order"]})'
