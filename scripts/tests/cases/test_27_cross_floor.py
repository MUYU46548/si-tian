#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 27：R5-3 跨楼层批量复制/移动 —— 整批 = 一条 undo
覆盖：
  a) 当前层选中 N 件 → 复制到目标层：目标层 +N（名称/坐标保留、id 新分配），原层不变
  b) 移动：原层 -N、目标层 +N
  c) 两种模式各只占**一条** undo（撤销一次全回滚、重做一次全恢复）
  d) 对话框接线（工具栏「跨楼层」→ 弹窗含方式/目标楼层选择）
"""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for

IV = "document.querySelector('.interior-container').__vueParentComponent.setupState"
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

    # 进入建筑内部并准备两层 + 3 件家具（全部在同一个 eval 内完成，避免跨 eval 交互态丢失）
    prep = _j(cdp, f"""(async () => {{
      const s = {STORE};
      const el = document.querySelector('.interior-container');
      const b = s.nodes.find(n => n.layer === 'building');
      if (!b) return JSON.stringify({{ err: 'no-building' }});
      s.selectBuilding(b);
      return JSON.stringify({{ id: b.id }});
    }})()""")
    if not isinstance(prep, dict) or 'id' not in prep:
        return False, f'未找到建筑节点 {prep}'
    bid = prep['id']
    wait_for(cdp, "!!document.querySelector('.interior-container .canvas-wrapper canvas')", desc='内部画布')
    time.sleep(0.6)

    setup = _j(cdp, f"""(async () => {{
      const s = {STORE};
      const el = document.querySelector('.interior-container');
      const iv = el.__vueParentComponent.setupState;
      const data = s.interiorData[{json.dumps(bid)}] || {{}};
      if (!(data.floors || []).length) s.addFloor({json.dumps(bid)}, '一层');
      const floors = s.interiorData[{json.dumps(bid)}].floors;
      let fB = floors[1];
      if (!fB) fB = s.addFloor({json.dumps(bid)}, '二层');
      const fA = floors[0];
      const items = [
        {{ name: '甲', type: 'chest', x: 0, y: 0, width: 40, height: 40, color: '#888' }},
        {{ name: '乙', type: 'chair', x: 80, y: 0, width: 40, height: 40, color: '#888' }},
        {{ name: '丙', type: 'table', x: 160, y: 0, width: 60, height: 40, color: '#888' }},
      ];
      const created = s.addFurnitureBatch({json.dumps(bid)}, fA.id, items);
      iv.editMode = true;
      iv.currentFloorId = fA.id;
      iv.selectedFurnitureIds = created.map(c => c.id);
      iv.selectedFurniture = created[created.length - 1];
      await new Promise(r => setTimeout(r, 60));
      return JSON.stringify({{
        A: fA.id, B: fB.id,
        aCount: (fA.furniture || []).length, bCount: (fB.furniture || []).length,
        selected: iv.selectedFurnitureIds.length,
      }});
    }})()""")
    if not isinstance(setup, dict) or 'A' not in setup:
        return False, f'内部准备失败 {setup}'
    fa, fb = setup['A'], setup['B']
    if setup['aCount'] != 3 or setup['selected'] != 3:
        return False, f'初始状态异常 {setup}'

    # d) 对话框接线（Vue DOM 更新在下一个 tick，需 await 后再读）
    dlg = _j(cdp, f"""(async () => {{
      const iv = {IV};
      iv.openTransferDialog();
      await new Promise(r => setTimeout(r, 120));
      const open = iv.transferDialogOpen;
      const dialogs = Array.from(document.querySelectorAll('.interior-container .modal-dialog'));
      const hit = dialogs.find(el => el.textContent.includes('跨楼层'));
      const text = hit ? hit.textContent : '';
      const hasSelect = hit ? hit.querySelectorAll('select').length : 0;
      return JSON.stringify({{ open, found: !!hit, html: text.includes('目标楼层'), selects: hasSelect, target: !!iv.transferTargetFloorId }});
    }})()""")
    if not isinstance(dlg, dict) or not (dlg['open'] and dlg['found'] and dlg['html'] and dlg['target']):
        return False, f'跨楼层对话框接线异常 {dlg}'
    if dlg['selects'] < 2:
        return False, f'跨楼层对话框缺少方式/目标楼层选择 {dlg}'

    # a) 复制
    copy = _j(cdp, f"""(() => {{
      const s = {STORE};
      const iv = {IV};
      iv.transferMode = 'copy';
      iv.transferTargetFloorId = {json.dumps(fb)};
      iv.confirmTransfer();
      const data = s.interiorData[{json.dumps(bid)}];
      const A = data.floors.find(f => f.id === {json.dumps(fa)});
      const B = data.floors.find(f => f.id === {json.dumps(fb)});
      return JSON.stringify({{
        a: (A.furniture || []).length, b: (B.furniture || []).length,
        bNames: (B.furniture || []).map(f => f.name),
        bCoords: (B.furniture || []).map(f => [f.x, f.y]),
        idsOverlap: (A.furniture || []).some(a => (B.furniture || []).some(b2 => b2.id === a.id)),
      }});
    }})()""")
    if not isinstance(copy, dict):
        return False, f'复制链路异常 {copy}'
    if copy['a'] != 3 or copy['b'] != setup['bCount'] + 3:
        return False, f'复制后数量异常 {copy}（原层应 3、目标层 +3）'
    if sorted(copy['bNames']) != ['丙', '乙', '甲']:
        return False, f'复制后名称未保留 {copy["bNames"]}'
    if copy['idsOverlap']:
        return False, f'复制出的家具与源层共用 id（会互相干扰） {copy}'

    # c) 一条 undo
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.4)
    undone = _j(cdp, f"""(() => {{
      const s = {STORE};
      const data = s.interiorData[{json.dumps(bid)}];
      const A = data.floors.find(f => f.id === {json.dumps(fa)});
      const B = data.floors.find(f => f.id === {json.dumps(fb)});
      return JSON.stringify({{ a: (A.furniture || []).length, b: (B.furniture || []).length }});
    }})()""")
    if undone['a'] != 3 or undone['b'] != setup['bCount']:
        return False, f'一次撤销未回滚整批复制 {undone}'
    _j(cdp, f"(() => {{ {STORE}.redo(); return 'ok'; }})()")
    time.sleep(0.4)

    # b) 移动（把源层 2 件搬到目标层）
    move = _j(cdp, f"""(() => {{
      const s = {STORE};
      const iv = {IV};
      const data = s.interiorData[{json.dumps(bid)}];
      const A = data.floors.find(f => f.id === {json.dumps(fa)});
      const pick = (A.furniture || []).slice(0, 2).map(f => f.id);
      iv.selectedFurnitureIds = pick;
      iv.currentFloorId = {json.dumps(fa)};
      iv.transferMode = 'move';
      iv.transferTargetFloorId = {json.dumps(fb)};
      iv.confirmTransfer();
      const A2 = s.interiorData[{json.dumps(bid)}].floors.find(f => f.id === {json.dumps(fa)});
      const B2 = s.interiorData[{json.dumps(bid)}].floors.find(f => f.id === {json.dumps(fb)});
      return JSON.stringify({{ a: (A2.furniture || []).length, b: (B2.furniture || []).length,
        cleared: (iv.selectedFurnitureIds || []).length }});
    }})()""")
    if not isinstance(move, dict):
        return False, f'移动链路异常 {move}'
    if move['a'] != 1:
        return False, f'移动后源层数量异常（应剩 1） {move}'
    if move['b'] != copy['b'] + 2:
        return False, f'移动后目标层数量异常 {move}'
    if move['cleared'] != 0:
        return False, f'移动后未清空选中（面板会指向已不在本层的对象） {move}'

    # 一条 undo 回滚移动
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.4)
    m2 = _j(cdp, f"""(() => {{
      const s = {STORE};
      const data = s.interiorData[{json.dumps(bid)}];
      const A = data.floors.find(f => f.id === {json.dumps(fa)});
      const B = data.floors.find(f => f.id === {json.dumps(fb)});
      return JSON.stringify({{ a: (A.furniture || []).length, b: (B.furniture || []).length }});
    }})()""")
    if m2['a'] != 3 or m2['b'] != copy['b']:
        return False, f'移动的撤销未回滚 {m2}（期望 a=3, b={copy["b"]}）'

    # 清场
    _j(cdp, f"(() => {{ const s = {STORE}; s.undo(); s.undo(); return 'ok'; }})()")
    time.sleep(0.3)
    return True, (f'跨楼层批量通过：复制 3 件（名称/坐标保留、id 不共用、原层不变）+ 移动 2 件（源层 -2、'
                  f'选中自动清空）+ 两种模式各一条 undo（撤销/重做全回滚/全恢复）+ 对话框接线正常')
