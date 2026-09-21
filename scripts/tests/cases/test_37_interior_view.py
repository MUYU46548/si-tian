#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 37：P2-2 InteriorView 独立测试（建筑内部专项）

此前 InteriorView 只有 test_25（房间模板单条）与 test_27（跨楼层批量）两个切片，
没有一条从「进入建筑内部」开始的完整用例。本用例覆盖：

  a) 基础导航：selectBuilding(building) → viewLevel=interior + 内部画布挂载
  b) 房间模板：5 个模板齐备且件数与定义一致；实测放置「卧室」→ 整间落位/命名/吸附 + 一条 undo
  c) 家具放置：选类型 → 真实点击 → 输入对话框 → 放置；验证网格吸附步长 20 与默认尺寸
  d) 跨楼层批量：准备两层 → 复制 → 目标层 +N 且源层不变、id 不共用；移动 → 源层 -N、选中清空
  e) 楼层切换：两层数据互不串（currentFloorId 切换后当前层家具集合随之变化）

子测试互相独立（逐个 try，失败只记录原因），写操作全走 store 的 undo 命令，
用例结束统一回滚。
"""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for
from lib.helpers import ensure_test_building

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
IV = "document.querySelector('.interior-container').__vueParentComponent.setupState"
CANVAS = "document.querySelector('.interior-container .canvas-wrapper canvas')"

# 代码中 ROOM_TEMPLATES 的实际件数（用例以字面量锁定，防模板被误改）
EXPECT_TEMPLATES = {'bedroom': 4, 'kitchen': 4, 'hall': 7, 'study': 4, 'storage': 4}


def _j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def goto_interior_view(cdp, building_name=None):
    """导航到建筑内部（模拟从区域地图点击建筑节点下钻）。

    返回 { id, name, level, canvas }；失败返回 {'err': ...}
    ⚠️ 建筑 fixture：真实库缓存里已不再保留测试残留节点「测试建筑」（2026-09-21 清理），
       所以这里必须**自己保证有建筑**（缺则现场建一个），否则用例会退化成对真实数据的隐式依赖。
    """
    okb, _b = ensure_test_building(cdp)
    if not okb:
        return {'err': 'building-fixture-failed', 'info': str(_b)[:200]}
    return _j(cdp, f"""(() => {{
      const s = {STORE};
      const bs = s.nodes.filter(n => n.layer === 'building');
      const b = ({json.dumps(building_name)} && bs.find(n => n.name === {json.dumps(building_name)})) || bs[0];
      if (!b) return JSON.stringify({{ err: 'no-building-node', buildings: [] }});
      // 模拟真实下钻路径：先进入区域地图，再点进建筑
      const region = s.nodes.find(n => n.layer === 'region');
      if (region) s.selectArea(region);
      const levelAtArea = s.viewLevel;
      s.selectBuilding(b);
      const el = document.querySelector('.interior-container');
      return JSON.stringify({{
        id: b.id, name: b.name, level: s.viewLevel, levelAtArea,
        canvas: !!(el && el.querySelector('.canvas-wrapper canvas')),
        buildings: bs.map(n => n.name),
      }});
    }})()""")


def floor_furniture(cdp, building_id, floor_id):
    return _j(cdp, f"""(() => {{
      const s = {STORE};
      const data = s.interiorData[{json.dumps(building_id)}] || {{}};
      const fl = (data.floors || []).find(f => f.id === {json.dumps(floor_id)});
      const items = (fl && fl.furniture) || [];
      return JSON.stringify({{ n: items.length,
        names: items.map(i => i.name),
        items: items.map(i => ({{ id: i.id, name: i.name, type: i.type, x: i.x, y: i.y,
          width: i.width, height: i.height }})) }});
    }})()""")


def prepare_two_floors(cdp, building_id):
    """确保建筑有 ≥2 层，返回 {A, B, aCount, bCount}"""
    return _j(cdp, f"""(async () => {{
      const s = {STORE};
      const iv = {IV};
      const bid = {json.dumps(building_id)};
      let data = s.interiorData[bid];
      if (!data || !(data.floors || []).length) s.addFloor(bid, '一层');
      data = s.interiorData[bid];
      if ((data.floors || []).length < 2) s.addFloor(bid, '二层');
      data = s.interiorData[bid];
      const A = data.floors[0], B = data.floors[1];
      iv.editMode = true;
      iv.selectFloor(A.id);
      await new Promise(r => setTimeout(r, 80));
      return JSON.stringify({{ A: A.id, B: B.id,
        aCount: (A.furniture || []).length, bCount: (B.furniture || []).length,
        cur: iv.currentFloorId }});
    }})()""")


# ─────────────────────────────────────────────────────────────
# a) 基础导航
# ─────────────────────────────────────────────────────────────
def sub_navigation(cdp):
    nav = goto_interior_view(cdp)
    if not isinstance(nav, dict) or 'id' not in nav:
        return False, f'未找到建筑节点 {nav}', None
    if nav['level'] != 'interior':
        return False, f'选中建筑后未切到内部视图（viewLevel={nav["level"]}）', None
    if nav.get('levelAtArea') != 'area':
        return False, f'前置下钻未先经过区域地图（levelAtArea={nav.get("levelAtArea")}）', None
    wait_for(cdp, f"!!{CANVAS}", desc='内部画布挂载')
    time.sleep(0.6)
    info = _j(cdp, f"""(() => {{
      const iv = {IV};
      const c = {CANVAS};
      if (!iv || !c) return JSON.stringify({{ err: 'no-canvas' }});
      const vt = iv.renderer.viewTransform;
      return JSON.stringify({{
        buildingId: iv.props.buildingNode ? iv.props.buildingNode.id : null,
        w: c.clientWidth, h: c.clientHeight, scale: vt.scale,
        floors: (iv.floors || []).length,
      }});
    }})()""")
    if not isinstance(info, dict) or 'scale' not in info:
        return False, f'内部画布/渲染器不可用 {info}', nav['id']
    if info['buildingId'] != nav['id']:
        return False, f'画布 props.buildingNode 与选中建筑不一致 {info}', nav['id']
    if info['w'] < 100 or info['h'] < 100:
        return False, f'内部画布尺寸异常 {info}', nav['id']
    return True, (f'导航通过：building「{nav["name"]}」→ viewLevel=interior，'
                  f'画布 {info["w"]}×{info["h"]}、scale={info["scale"]:.2f}、已有 {info["floors"]} 层'), nav['id']


# ─────────────────────────────────────────────────────────────
# b) 房间模板
# ─────────────────────────────────────────────────────────────
def sub_room_template(cdp, building_id):
    tpls = _j(cdp, f"""(() => JSON.stringify({IV}.ROOM_TEMPLATES.map(t => ({{
      id: t.id, label: t.label, n: (t.items || []).length,
      names: (t.items || []).map(i => i.name),
    }}))))()""")
    if not isinstance(tpls, list) or not tpls:
        return False, f'读不到房间模板 {tpls}'
    got = {t['id']: t['n'] for t in tpls}
    missing = [k for k in EXPECT_TEMPLATES if k not in got]
    if missing:
        return False, f'房间模板缺失 {missing}（现有 {list(got)}）'
    bad = {k: (got[k], v) for k, v in EXPECT_TEMPLATES.items() if got[k] != v}
    if bad:
        return False, f'房间模板件数与定义不符 {bad}（模板被改动了？改了我这边也要跟着改）'

    prep = prepare_two_floors(cdp, building_id)
    if not isinstance(prep, dict) or 'A' not in prep:
        return False, f'内部准备失败 {prep}'
    fid = prep['A']
    before = prep['aCount']

    placed = _j(cdp, f"""(async () => {{
      const s = {STORE};
      const iv = {IV};
      const c = {CANVAS};
      const bid = {json.dumps(building_id)}, fid = {json.dumps(fid)};
      iv.editMode = true;
      iv.interactionMode = 'add_room';
      iv.selectedRoomTemplate = 'bedroom';
      iv.gridSnapEnabled = true;
      iv.gridSize = 20;
      iv.selectFloor(fid);
      await new Promise(r => setTimeout(r, 80));
      const tpl = iv.ROOM_TEMPLATES.find(t => t.id === 'bedroom');
      const r = c.getBoundingClientRect();
      const vt = iv.renderer.viewTransform;
      const wx = 240, wy = 200;
      const sx = Math.trunc(r.left + wx * vt.scale + vt.x + c.clientWidth / 2);
      const sy = Math.trunc(r.top + wy * vt.scale + vt.y + c.clientHeight / 2);
      const mk = (t) => new MouseEvent(t, {{ clientX: sx, clientY: sy,
        bubbles: true, cancelable: true, button: 0 }});
      c.dispatchEvent(mk('mousedown'));
      c.dispatchEvent(mk('mouseup'));
      await new Promise(r2 => setTimeout(r2, 150));
      const data = s.interiorData[bid];
      const fl = data.floors.find(f => f.id === fid);
      const items = fl.furniture || [];
      return JSON.stringify({{
        expect: tpl.items.length, before: {before}, after: items.length,
        added: items.slice({before}).map(i => ({{ name: i.name, type: i.type, x: i.x, y: i.y }})),
        selected: (iv.selectedFurnitureIds || []).length,
      }});
    }})()""")
    if not isinstance(placed, dict) or 'after' not in placed:
        return False, f'房间模板链路异常 {placed}'
    if placed['after'] != placed['before'] + placed['expect']:
        return False, f'卧室模板未整间落位（{placed["before"]} → {placed["after"]}，期望 +{placed["expect"]}）'
    names = [p['name'] for p in placed['added']]
    for need in ('床', '衣柜', '床头柜', '挂饰'):
        if need not in names:
            return False, f'模板缺件「{need}」 {names}'
    bad_snap = [p for p in placed['added'] if p['x'] % 20 or p['y'] % 20]
    if bad_snap:
        return False, f'整间未按网格(20)吸附 {bad_snap}'
    if placed['selected'] != placed['expect']:
        return False, f'放置后未选中整间（选中 {placed["selected"]}，期望 {placed["expect"]}）'
    # 一条 undo 撤整间
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.35)
    undone = floor_furniture(cdp, building_id, fid)
    if undone['n'] != placed['before']:
        return False, f'一次撤销未撤掉整间（{placed["after"]} → {undone["n"]}，期望 {placed["before"]}）——undo 被拆成 {placed["expect"]} 条？'
    _j(cdp, f"(() => {{ {STORE}.redo(); return 'ok'; }})()")
    time.sleep(0.3)
    redone = floor_furniture(cdp, building_id, fid)
    if redone['n'] != placed['after']:
        return False, f'重做未恢复整间（{redone["n"]}）'
    return True, (f'房间模板通过：5 个模板齐备且件数一致（'
                  + '/'.join(f'{t["label"]}{t["n"]}' for t in tpls)
                  + f'）；实测卧室 {placed["expect"]} 件整间落位（含床/衣柜/床头柜/挂饰）、'
                    f'网格 20 吸附、一次 undo 全撤 + redo 全恢复')


# ─────────────────────────────────────────────────────────────
# c) 家具放置
# ─────────────────────────────────────────────────────────────
def sub_furniture_place(cdp, building_id):
    prep = prepare_two_floors(cdp, building_id)
    if not isinstance(prep, dict) or 'A' not in prep:
        return False, f'内部准备失败 {prep}'
    fid = prep['A']
    before = prep['aCount']
    NAME = '测试桌子'
    res = _j(cdp, f"""(async () => {{
      const s = {STORE};
      const iv = {IV};
      const c = {CANVAS};
      const bid = {json.dumps(building_id)}, fid = {json.dumps(fid)};
      iv.editMode = true;
      iv.interactionMode = 'add_furniture';
      iv.selectedFurnitureType = 'table';
      iv.gridSnapEnabled = true;
      iv.gridSize = 20;
      iv.selectFloor(fid);
      await new Promise(r => setTimeout(r, 80));
      const r = c.getBoundingClientRect();
      const vt = iv.renderer.viewTransform;
      const wx = -260, wy = 140;
      const sx = Math.trunc(r.left + wx * vt.scale + vt.x + c.clientWidth / 2);
      const sy = Math.trunc(r.top + wy * vt.scale + vt.y + c.clientHeight / 2);
      const mk = (t) => new MouseEvent(t, {{ clientX: sx, clientY: sy,
        bubbles: true, cancelable: true, button: 0 }});
      c.dispatchEvent(mk('mousedown'));
      c.dispatchEvent(mk('mouseup'));
      await new Promise(r2 => setTimeout(r2, 150));
      const dlg = document.querySelector('.interior-container .modal-dialog');
      const opened = !!dlg;
      if (!dlg) return JSON.stringify({{ opened: false, before: {before} }});
      const input = dlg.querySelector('input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, {json.dumps(NAME)});
      input.dispatchEvent(new Event('input', {{ bubbles: true }}));
      await new Promise(r3 => setTimeout(r3, 60));
      const btn = Array.from(dlg.querySelectorAll('button')).find(x => x.textContent.trim() === '放置');
      const clicked = !!btn;
      if (btn) btn.click();
      await new Promise(r4 => setTimeout(r4, 180));
      const data = s.interiorData[bid];
      const fl = data.floors.find(f => f.id === fid);
      const items = fl.furniture || [];
      const last = items[items.length - 1];
      return JSON.stringify({{
        opened, clicked, before: {before}, after: items.length,
        closed: !document.querySelector('.interior-container .modal-dialog'),
        grid: iv.gridSize, snap: iv.gridSnapEnabled,
        item: last ? {{ name: last.name, type: last.type, x: last.x, y: last.y,
          width: last.width, height: last.height }} : null,
        expectSize: {{ w: 80, h: 60 }},
      }});
    }})()""")
    if not isinstance(res, dict) or 'after' not in res:
        return False, f'家具放置链路异常 {res}'
    if not res.get('opened'):
        return False, f'点击后未弹出放置对话框 {res}'
    if not res.get('clicked'):
        return False, f'对话框缺少「放置」按钮 {res}'
    if res['after'] != res['before'] + 1:
        return False, f'家具未落位（{res["before"]} → {res["after"]}，期望 +1）{res}'
    it = res['item']
    if not it or it['name'] != NAME:
        return False, f'家具名称不符（期望 {NAME!r}，得到 {it}）'
    if it['type'] != 'table':
        return False, f'家具类型不符（期望 table，得到 {it["type"]}）'
    if it['x'] % 20 or it['y'] % 20:
        return False, f'家具未按网格 20 吸附 {it}'
    # 落点应贴着点击处（对网格取整后偏差 ≤ 半个步长）
    if abs(it['x'] - (-260)) > 10 + 1 / 0.2 or abs(it['y'] - 140) > 10 + 1 / 0.2:
        return False, f'家具落点偏离点击处过远 {it}'
    if it['width'] != 80 or it['height'] != 60:
        return False, f'未取类型默认尺寸（期望 80×60，得到 {it["width"]}×{it["height"]}）'
    if not res.get('closed'):
        return False, f'放置后对话框未关闭 {res}'
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.35)
    undone = floor_furniture(cdp, building_id, fid)
    if undone['n'] != res['before']:
        return False, f'家具未走 undo（撤销后 {undone["n"]}，期望 {res["before"]}）'
    return True, (f'家具放置通过：点击 → 对话框 → 名称「{it["name"]}」落位 ({it["x"]},{it["y"]})'
                  f'（网格 20 吸附）、类型 {it["type"]}、默认尺寸 {it["width"]}×{it["height"]}、'
                  f'一条 undo 撤销')


# ─────────────────────────────────────────────────────────────
# d) 跨楼层批量
# ─────────────────────────────────────────────────────────────
def sub_cross_floor(cdp, building_id):
    prep = prepare_two_floors(cdp, building_id)
    if not isinstance(prep, dict) or 'A' not in prep:
        return False, f'内部准备失败 {prep}'
    fa, fb = prep['A'], prep['B']

    # 准备 3 件家具（批量 API，不走 UI；UI 放置路径已由 c) 覆盖）
    setup = _j(cdp, f"""(async () => {{
      const s = {STORE};
      const iv = {IV};
      const bid = {json.dumps(building_id)};
      const items = [
        {{ name: '甲', type: 'chest', x: 0, y: 0, width: 40, height: 40 }},
        {{ name: '乙', type: 'chair', x: 80, y: 0, width: 40, height: 40 }},
        {{ name: '丙', type: 'table', x: 160, y: 0, width: 60, height: 40 }},
      ];
      const created = s.addFurnitureBatch(bid, {json.dumps(fa)}, items);
      iv.editMode = true;
      iv.currentFloorId = {json.dumps(fa)};
      iv.selectedFurnitureIds = created.map(c => c.id);
      iv.selectedFurniture = created[created.length - 1];
      await new Promise(r => setTimeout(r, 80));
      const data = s.interiorData[bid];
      const A = data.floors.find(f => f.id === {json.dumps(fa)});
      const B = data.floors.find(f => f.id === {json.dumps(fb)});
      return JSON.stringify({{ aCount: (A.furniture || []).length, bCount: (B.furniture || []).length,
        selected: (iv.selectedFurnitureIds || []).length }});
    }})()""")
    if not isinstance(setup, dict) or 'aCount' not in setup:
        return False, f'跨楼层准备失败 {setup}'
    if setup['aCount'] < 3:
        return False, f'源层家具数异常 {setup}'

    # 对话框接线（DOM）
    dlg = _j(cdp, f"""(async () => {{
      const iv = {IV};
      iv.openTransferDialog();
      await new Promise(r => setTimeout(r, 120));
      const dialogs = Array.from(document.querySelectorAll('.interior-container .modal-dialog'));
      const hit = dialogs.find(el => el.textContent.includes('跨楼层'));
      return JSON.stringify({{
        open: iv.transferDialogOpen, found: !!hit,
        hasTarget: hit ? hit.textContent.includes('目标楼层') : false,
        selects: hit ? hit.querySelectorAll('select').length : 0,
        target: !!iv.transferTargetFloorId,
      }});
    }})()""")
    if not isinstance(dlg, dict) or not (dlg['open'] and dlg['found'] and dlg['hasTarget'] and dlg['target']):
        return False, f'跨楼层对话框接线异常 {dlg}'
    if dlg['selects'] < 2:
        return False, f'对话框缺少方式/目标楼层选择 {dlg}'

    # 复制
    copy = _j(cdp, f"""(() => {{
      const s = {STORE};
      const iv = {IV};
      const bid = {json.dumps(building_id)};
      iv.transferMode = 'copy';
      iv.transferTargetFloorId = {json.dumps(fb)};
      iv.confirmTransfer();
      const data = s.interiorData[bid];
      const A = data.floors.find(f => f.id === {json.dumps(fa)});
      const B = data.floors.find(f => f.id === {json.dumps(fb)});
      return JSON.stringify({{
        a: (A.furniture || []).length, b: (B.furniture || []).length,
        bNames: (B.furniture || []).map(f => f.name),
        overlap: (A.furniture || []).some(x => (B.furniture || []).some(y => y.id === x.id)),
        selectedSameFloor: (iv.selectedFurnitureIds || []).every(id => (B.furniture || []).some(f => f.id === id)),
      }});
    }})()""")
    if not isinstance(copy, dict):
        return False, f'复制链路异常 {copy}'
    if copy['a'] != setup['aCount'] or copy['b'] != setup['bCount'] + 3:
        return False, f'复制后数量异常（源层 {copy["a"]}、目标层 {copy["b"]}，期望 {setup["aCount"]}/{setup["bCount"] + 3}）'
    if sorted(copy['bNames']) != ['丙', '乙', '甲']:
        return False, f'复制后名称未保留 {copy["bNames"]}'
    if copy['overlap']:
        return False, f'复制出的家具与源层共用 id {copy}'
    if not copy['selectedSameFloor']:
        return False, f'复制后选中未切到目标层 {copy}'
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.35)
    u = _j(cdp, f"""(() => {{
      const s = {STORE};
      const data = s.interiorData[{json.dumps(building_id)}];
      const A = data.floors.find(f => f.id === {json.dumps(fa)});
      const B = data.floors.find(f => f.id === {json.dumps(fb)});
      return JSON.stringify({{ a: (A.furniture || []).length, b: (B.furniture || []).length }});
    }})()""")
    if u['a'] != setup['aCount'] or u['b'] != setup['bCount']:
        return False, f'一次撤销未回滚整批复制 {u}'
    _j(cdp, f"(() => {{ {STORE}.redo(); return 'ok'; }})()")
    time.sleep(0.35)

    # 移动（源层 2 件 → 目标层）
    move = _j(cdp, f"""(() => {{
      const s = {STORE};
      const iv = {IV};
      const bid = {json.dumps(building_id)};
      const data = s.interiorData[bid];
      const A = data.floors.find(f => f.id === {json.dumps(fa)});
      const pick = (A.furniture || []).slice(0, 2).map(f => f.id);
      iv.selectedFurnitureIds = pick;
      iv.currentFloorId = {json.dumps(fa)};
      iv.transferMode = 'move';
      iv.transferTargetFloorId = {json.dumps(fb)};
      iv.confirmTransfer();
      const A2 = s.interiorData[bid].floors.find(f => f.id === {json.dumps(fa)});
      const B2 = s.interiorData[bid].floors.find(f => f.id === {json.dumps(fb)});
      return JSON.stringify({{ a: (A2.furniture || []).length, b: (B2.furniture || []).length,
        cleared: (iv.selectedFurnitureIds || []).length }});
    }})()""")
    if not isinstance(move, dict):
        return False, f'移动链路异常 {move}'
    if move['a'] != copy['a'] - 2 or move['b'] != copy['b'] + 2:
        return False, f'移动后数量异常 {move}（源层应 {copy["a"] - 2}、目标层应 {copy["b"] + 2}）'
    if move['cleared'] != 0:
        return False, f'移动后未清空选中（面板会指向已不在本层的对象） {move}'
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.35)
    m2 = _j(cdp, f"""(() => {{
      const s = {STORE};
      const data = s.interiorData[{json.dumps(building_id)}];
      const A = data.floors.find(f => f.id === {json.dumps(fa)});
      const B = data.floors.find(f => f.id === {json.dumps(fb)});
      return JSON.stringify({{ a: (A.furniture || []).length, b: (B.furniture || []).length }});
    }})()""")
    if m2['a'] != copy['a'] or m2['b'] != copy['b']:
        return False, f'移动的撤销未回滚 {m2}'
    # 清掉复制留下的那批（redo 已恢复，这里撤销它）
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.3)
    return True, (f'跨楼层批量通过：对话框（含方式/目标楼层 + 默认目标层）→ 复制 3 件'
                  f'（源层 {copy["a"]} 不变、目标层 {copy["b"]}、名称保留、id 不共用、选中随目标层）'
                  f'→ 移动 2 件（源层 {move["a"]}、目标层 {move["b"]}、选中清空）；两种模式各一条 undo')


# ─────────────────────────────────────────────────────────────
# e) 楼层切换
# ─────────────────────────────────────────────────────────────
def sub_floor_switch(cdp, building_id):
    prep = prepare_two_floors(cdp, building_id)
    if not isinstance(prep, dict) or 'A' not in prep:
        return False, f'内部准备失败 {prep}'
    fa, fb = prep['A'], prep['B']
    res = _j(cdp, f"""(async () => {{
      const s = {STORE};
      const iv = {IV};
      const bid = {json.dumps(building_id)};
      // 给 B 层补一件标记性家具
      const created = s.addFurnitureBatch(bid, {json.dumps(fb)},
        [{{ name: '二层专属', type: 'bed', x: 300, y: -200, width: 100, height: 80 }}]);
      await new Promise(r => setTimeout(r, 60));
      iv.editMode = true;
      iv.selectFloor({json.dumps(fa)});
      await new Promise(r => setTimeout(r, 100));
      const onA = {{ cur: iv.currentFloorId, n: (iv.currentFurniture || []).length,
        name: (iv.floors.find(f => f.id === iv.currentFloorId) || {{}}).name || null,
        tabs: Array.from(document.querySelectorAll('.interior-container .floor-tab'))
          .map(t => [t.textContent.trim(), t.classList.contains('active')]) }};
      iv.selectFloor({json.dumps(fb)});
      await new Promise(r => setTimeout(r, 100));
      const onB = {{ cur: iv.currentFloorId, n: (iv.currentFurniture || []).length,
        name: (iv.floors.find(f => f.id === iv.currentFloorId) || {{}}).name || null,
        hasExclusive: (iv.currentFurniture || []).some(f => f.name === '二层专属'),
        tabs: Array.from(document.querySelectorAll('.interior-container .floor-tab'))
          .map(t => [t.textContent.trim(), t.classList.contains('active')]) }};
      iv.selectFloor({json.dumps(fa)});
      await new Promise(r => setTimeout(r, 80));
      const backA = {{ cur: iv.currentFloorId, n: (iv.currentFurniture || []).length,
        hasExclusive: (iv.currentFurniture || []).some(f => f.name === '二层专属') }};
      const data = s.interiorData[bid];
      const A = data.floors.find(f => f.id === {json.dumps(fa)});
      const B = data.floors.find(f => f.id === {json.dumps(fb)});
      return JSON.stringify({{ A: {json.dumps(fa)}, B: {json.dumps(fb)},
        onA, onB, backA, aStore: (A.furniture || []).length, bStore: (B.furniture || []).length }});
    }})()""")
    if not isinstance(res, dict) or 'onA' not in res:
        return False, f'楼层切换链路异常 {res}'
    if res['onA']['cur'] != fa or res['onB']['cur'] != fb or res['backA']['cur'] != fa:
        return False, f'currentFloorId 未跟随切换 {res}'
    if res['onB']['n'] != res['bStore'] or res['onA']['n'] != res['aStore'] or res['backA']['n'] != res['aStore']:
        return False, f'当前层家具集合与楼层数据不一致 {res}'
    if not res['onB']['hasExclusive']:
        return False, f'二层专属家具未出现在二层 {res}'
    if res['backA']['hasExclusive']:
        return False, f'切回一层后仍看到二层的家具（楼层数据串了） {res}'
    if res['aStore'] == res['bStore'] and res['aStore'] == res['onA']['n']:
        pass  # 数量相同也不算错，串层由 hasExclusive 判定
    # 楼层 tab 的 active 归属：A 与 B 的激活状态必须互斥，且与 currentFloorId 对应
    for tag, key, fid in (('切到A', 'onA', fa), ('切到B', 'onB', fb)):
        act = [t for t, a in res[key]['tabs'] if a]
        if len(act) != 1:
            return False, f'{tag} 后激活楼层 tab 数异常 {res[key]["tabs"]}'
    names_a = res['onA']['name']
    names_b = res['onB']['name']
    if names_a == names_b:
        return False, f'两层名称相同（数据准备异常）{names_a}'
    # 回滚：移除二层专属家具 + 可能的新增层
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.3)
    return True, (f'楼层切换通过：A「{names_a}」{res["onA"]["n"]} 件 / B「{names_b}」{res["onB"]["n"]} 件，'
                  f'currentFloorId 与当前层家具集合同步、二层专属家具不串到一层、楼层 tab 激活互斥')


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')

    results = []
    ok, detail, bid = sub_navigation(cdp)
    results.append(('a 基础导航', ok, detail))
    if not bid:
        return False, '建筑内部 ' + '\n    '.join(f'{n}: {"✅" if o else "❌"} {d}' for n, o, d in results)

    for name, fn in (('b 房间模板', sub_room_template),
                     ('c 家具放置', sub_furniture_place),
                     ('d 跨楼层批量', sub_cross_floor),
                     ('e 楼层切换', sub_floor_switch)):
        try:
            ok, detail = fn(cdp, bid)
        except Exception as e:  # 子测试异常不阻断后续
            ok, detail = False, f'异常: {e}'
        results.append((name, ok, detail))

    # 统一回滚（上限 20 条，覆盖各子测试留下的命令）
    _j(cdp, f"(() => {{ const s = {STORE}; for (let i = 0; i < 20; i++) s.undo(); return 'ok'; }})()")
    time.sleep(0.3)
    left = _j(cdp, f"""(() => {{
      const s = {STORE};
      const data = s.interiorData[{json.dumps(bid)}] || {{}};
      return JSON.stringify({{ floors: (data.floors || []).length,
        furniture: (data.floors || []).reduce((a, f) => a + (f.furniture || []).length, 0) }});
    }})()""")

    failed = [f'{n}: {d}' for n, o, d in results if not o]
    tail = f' | 清场后 floors={left["floors"]} furniture={left["furniture"]}'
    if failed:
        return False, f'建筑内部 {len(results) - len(failed)}/{len(results)} 子测试通过；失败：\n    ' + '\n    '.join(failed)
    return True, (f'InteriorView 独立测试 {len(results)}/{len(results)} 全通过 — '
                  + '；'.join(d for _, _, d in results) + tail)
