"""用例 126：描轮廓安全闸门 + 空省标记 + 默认不换主（H1 / D10-D11）。

S0 实测（docs/SITIAN_BREAKPOINT_20261019.md §2.2）：真实底图上一笔描轮廓碰到 12 个省、
清空 3 个，且落笔前没有任何“会影响谁”的预告。本用例守三件事：

  · 影响省数超过上限 → 拒绝（`province-gate`），**零副作用**；
  · 明确允许（allowMany）后才执行；被挖空的省标 `empty:true`，不再出现在目标省下拉里；
  · 一条 undo 把几何与空标记全部还原。
"""
import json
import os

from lib.cdp import eval_json, wait_for

SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))


def source_gates():
    fails = []
    sm = open(os.path.join(ROOT, 'src', 'renderer', 'src', 'components', 'ScenarioMap.vue'), encoding='utf-8').read()
    # 2026-10-31：绘制/交互体已分批搬到 scenario/{layers,interaction}/* —— 判据读合集
    from lib.rsrc import render_src as _rsrc_all
    sm = _rsrc_all()
    pe = open(os.path.join(ROOT, 'src', 'renderer', 'src', 'store', 'geodataModules', 'provinceEditing.js'), encoding='utf-8').read()
    if 'outlineToNeighbor = ref(false)' not in sm:
        fails.append('D10：描轮廓默认应“不换主”（outlineToNeighbor = ref(false)）')
    if 'province-gate' not in sm or 'allowMany: true' not in sm:
        fails.append('D10：组件没有处理 province-gate / allowMany 重试')
    if 'smallCanvasWarned' not in sm:
        fails.append('T10：没有画布过小提示（smallCanvasWarned）')
    if 'maxAffected' not in pe or "rejected: 'province-gate'" not in pe:
        fails.append('D10：store 没有影响省数闸门')
    if 'empty: !patch.points.length' not in pe:
        fails.append('D11：挖空的省没有标 empty')
    return fails


JS_SOURCE_GATES = r"""
(() => {
  const fsFails = [];
  return JSON.stringify({ fails: fsFails });
})()
"""

JS_SETUP = r"""
(async () => {
  const s = __STORE__;
  const sm = __SM__;
  const KEY = 'case126';
  const terrain = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      terrain.push({
        id: `p${row}${col}`, name: `省${row}${col}`, kind: 'land',
        points: [
          { x: col * 100, y: row * 100 },
          { x: col * 100 + 90, y: row * 100 },
          { x: col * 100 + 90, y: row * 100 + 90 },
          { x: col * 100, y: row * 100 + 90 },
        ],
      });
    }
  }
  s.baseMaps = { ...s.baseMaps, [KEY]: { id: KEY, name: '用例126底图', terrain, referenceImages: [] } };
  sm.baseMapKey = KEY;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await new Promise(r => setTimeout(r, 300));
  const ring = [{ x: -5, y: -5 }, { x: 295, y: -5 }, { x: 295, y: 295 }, { x: -5, y: 295 }];
  const before = JSON.stringify(terrain.map(p => p.points));
  const r1 = s.applyProvinceOutline(KEY, ring, { maxShare: 1 });
  const afterReject = JSON.stringify(s.baseMaps[KEY].terrain.map(p => p.points));
  const r2 = s.applyProvinceOutline(KEY, ring, { maxShare: 1, allowMany: true });
  const empties = s.baseMaps[KEY].terrain.filter(p => p.empty).length;
  const options = sm.provinceTargetOptions.length;
  const target = s.baseMaps[KEY].terrain.find(p => p.id === (r2 && r2.targetId));
  const targetPts = target ? target.points.length : -1;
  s.undo();
  const restored = JSON.stringify(s.baseMaps[KEY].terrain.map(p => p.points));
  const emptiesAfterUndo = s.baseMaps[KEY].terrain.filter(p => p.empty).length;
  return JSON.stringify({
    fails: [],
    r1: { rejected: r1 && r1.rejected, affected: r1 && r1.affected },
    r2: { changed: r2 && r2.changed, affected: r2 && r2.affected, targetId: r2 && r2.targetId },
    rejectNoSideEffect: before === afterReject,
    empties, options, targetPts,
    restored: restored === before,
    emptiesAfterUndo,
  });
})()
"""


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
             ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式')
    obj = cdp.eval(JS_SETUP.replace('__STORE__', STORE).replace('__SM__', SM))
    if isinstance(obj, dict) and '__err__' in obj:
        return False, f'JS 异常：{str(obj["__err__"])[:300]}'
    try:
        data = json.loads(obj)
    except Exception:
        return False, f'返回非 JSON：{str(obj)[:300]}'

    fails = []
    fails.extend(source_gates())
    if not (data.get('r1', {}).get('rejected') == 'province-gate'):
        fails.append(f"一描 9 省未被闸门拒绝：{data.get('r1')}")
    if data.get('r1', {}).get('affected') != 9:
        fails.append(f"影响省数不是 9：{data.get('r1')}")
    if not data.get('rejectNoSideEffect'):
        fails.append('拒绝时几何被改了（必须零副作用）')
    if not (data.get('r2', {}).get('changed', 0) > 0):
        fails.append(f"allowMany 后没有执行：{data.get('r2')}")
    if data.get('empties') != 8:
        fails.append(f"空省标记数不是 8：{data.get('empties')}")
    if data.get('options') != 4:
        fails.append(f"目标省下拉没有过滤空省：{data.get('options')}")
    if data.get('targetPts', 0) < 3:
        fails.append(f"目标省没有拿到地（points={data.get('targetPts')}）")
    if not data.get('restored'):
        fails.append('undo 没有还原几何')
    if data.get('emptiesAfterUndo') != 0:
        fails.append(f"undo 后仍有空省标记：{data.get('emptiesAfterUndo')}")

    if fails:
        return False, ' | '.join(fails)
    return True, (f"闸门拒绝 9 省 / allowMany 后执行 / 空省 8 个被标 empty 且下拉只剩 4 / "
                  f"一点 undo 全还原")
