#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 79：省份「压叠闸门」+ 套索面积上限

来源：2026-10-01 收尾时留下的两条未做项 ——
  ① **省份可以互相压叠**：命中原先按 terrain 数组**正序**返回第一个命中的省，而画布是正序
     `fill`（数组靠后的盖在上面）→ 两个省叠在一起时，**点中的是视觉上被压在下面的那个**。
     压叠还会污染归属上色与势力标签的面积加权质心（「名字跑到别人地界里」）。
  ② **套索没有面积上限、也不校验目标省份**：`target = 0`（上方下拉没选）会把圈内整片格子
     **静默擦成无主**；一口吞掉全图也照做（闸门此前只管「点一下」的点击填充）。
  另有一处主线程风险：套索采样点无上限（`mousemove` 每次落一点），圈一大片会有上千点，
  而 `lassoCells` 是 O(bbox 格 × 顶点数)。

本用例覆盖：
  f0 源码守卫：压叠判定单源（`utils/provinceOverlap.js`）、store 只做策略、
     两条建省路径都过闸门、命中改为自顶向下、套索四条闸门齐备。
  f1 纯函数度量：25% 阈值两侧 / 完全覆盖点名 / 洞不计入 / 海也算 / 空表安全。
  f2 store 压叠闸门：压叠 → 拒绝且**零副作用**（terrain 不变 + 没多压一条 undo）→
     带 allowOverlap 重试成功；**空地新省必须照建**（不能误拒）；程序化路径可跳过。
  f3 真鼠标路径：拖一圈压在既有省上 → confirm=false 拒绝 / confirm=true 通过；
     空地那一圈**不问**（证明闸门不是一刀切）；压叠处命中的是最后画上去的那个。
  f4 套索闸门：无目标拒 / 面积闸门拒 / 格数上限拒（阈值可注入）+ 全部零副作用；
     正常小套索照常生效且回报「圈入量」与「轨迹简化」；上千点的轨迹必须被简化。
"""
import io
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json  # noqa: E402
from lib.helpers import ensure_data_ready  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
KEY = '用例79底图'
# 两个相邻省份（紧凑排布，保证在 headless 画布可视范围内）
A_RECT = (100, 100, 300, 300)     # 甲省
B_RECT = (320, 100, 520, 300)     # 乙省


def _read(rel):
    return io.open(os.path.join(ROOT, rel), encoding='utf-8').read()


def _code_only(src):
    """剥掉注释后再判子串 —— 本仓三次踩到「注释里的字样被当成实现」。"""
    src = re.sub(r'<!--.*?-->', '', src, flags=re.S)
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    return re.sub(r'(?m)//[^\n]*', '', src)


# ══════════════════════════════════════════════════════════════════
# f0 源码守卫
# ══════════════════════════════════════════════════════════════════
def sub_source_guards(cdp):
    bad = []

    ov = _code_only(_read('src/renderer/src/utils/provinceOverlap.js'))
    for sym in ['export function measureProvinceOverlap', 'export function describeOverlap',
                'export const OVERLAP_REJECT_RATIO', 'export const OVERLAP_MAX_DIM']:
        if sym not in ov:
            bad.append(f'utils/provinceOverlap.js 缺少 {sym}')
    if 'pointInProvince' not in ov:
        bad.append('压叠度量没走 pointInProvince（多环/洞口径会与画布不一致）')

    se = _code_only(_read('src/renderer/src/store/geodataModules/scenarioEditing.js'))
    if 'measureProvinceOverlap' not in se:
        bad.append('store 的建省路径没接压叠度量')
    if "rejected: 'overlap'" not in se:
        bad.append("建省被压叠拒绝时没有 {rejected:'overlap'} 回执（UI 无法给二次确认）")
    if 'allowOverlap' not in se:
        bad.append('建省没有 allowOverlap 逃生口（用户确认后无法重试）')
    seg = se[se.find('function addBaseProvince'):se.find('function addBaseProvince') + 2600]
    if 'execute(' not in seg:
        bad.append('addBaseProvince 没走 execute（一条 undo 是它的存在理由）')

    pe = _code_only(_read('src/renderer/src/store/geodataModules/provinceEditing.js'))
    for sym in ['LASSO_AREA_SHARE', 'MAX_LASSO_CELLS', 'lassoInsideCount', 'simplifyClosedTrace']:
        if sym not in pe:
            bad.append(f'provinceEditing 缺少 {sym}（套索闸门/简化没接）')
    lasso = pe[pe.find('function applyProvinceLasso'):pe.find('function applyProvinceLasso') + 3200]
    if "rejected: 'no-target'" not in lasso:
        bad.append('套索没校验目标省份（target=0 会把圈内格子静默擦成无主）')
    if 'area-gate' not in lasso or 'too-big' not in lasso:
        bad.append('套索缺面积/格数闸门（与点击填充同一协议）')
    if 'lassoInsideCount' not in lasso:
        bad.append('套索闸门没用 lassoInsideCount（用 lassoCells().length 会漏判「圈给大省」）')

    pg = _code_only(_read('src/renderer/src/utils/provinceGrid.js'))
    if 'export function lassoInsideCount' not in pg:
        bad.append('provinceGrid 缺少只读的 lassoInsideCount')

    sm = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
    if 'i >= 0; i--' not in sm:
        bad.append('findProvinceAt 没有改成自顶向下（点中的仍可能是被压在下面的那个）')
    if 'function addProvinceWithOverlapGate' not in sm:
        bad.append('ScenarioMap 缺少统一的建省落库口 addProvinceWithOverlapGate')
    if sm.count('addProvinceWithOverlapGate(') < 3:
        bad.append('两条建省路径没有都过闸门（描点 / 自由绘制各要一次调用）')
    if 'allowOverlap: true' not in sm:
        bad.append('复制省份没带 allowOverlap（复制是明确动作，且已挪开可见距离）')
    if 'measureProvinceOverlap' in sm:
        bad.append('ScenarioMap 自己调了度量函数（判定必须在 store/纯函数层单源）')
    if 'res.rejected' not in sm:
        bad.append('套索拒绝没有回音分支')

    if bad:
        return False, '源码守卫失败：' + '；'.join(bad)
    return True, ('压叠判定单源 + 建省闸门（两条路径） + 命中自顶向下 + '
                  '套索四闸门（目标/面积/格数/简化） + 拒绝回音')


# ══════════════════════════════════════════════════════════════════
# 公共造数：甲 / 乙两省 + 网格就绪 + 相机固定（屏幕坐标 == 世界坐标）
# ══════════════════════════════════════════════════════════════════
SEED_JS = r"""
  for (const k of Object.keys(s.scenarios || {})) s.removeScenario(k);
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: KEY });
  s.baseMaps[KEY].terrain.length = 0;
  const mk79 = (id, name, r) => ({ id, name, kind: 'land',
    points: [{x:r[0],y:r[1]},{x:r[2],y:r[1]},{x:r[2],y:r[3]},{x:r[0],y:r[3]}] });
  s.addBaseProvince(KEY, mk79('p79a', '甲省', __A__), { checkOverlap: false });
  s.addBaseProvince(KEY, mk79('p79b', '乙省', __B__), { checkOverlap: false });
  SM.baseMapKey = KEY;
  if (typeof SM.onBaseMapChange === 'function') SM.onBaseMapChange();
  s.rebuildProvinceGrid(KEY);
  SM.cameraScale = 1; SM.cameraX = 0; SM.cameraY = 0;   // 屏幕坐标 == 世界坐标
"""


def _seed():
    return (SEED_JS.replace('__STORE__', STORE).replace('__KEY__', json.dumps(KEY))
            .replace('__A__', json.dumps(list(A_RECT))).replace('__B__', json.dumps(list(B_RECT))))


# ══════════════════════════════════════════════════════════════════
# f1 纯函数度量（浏览器里直接 import 源码模块）
# ══════════════════════════════════════════════════════════════════
PURE_JS = r"""(async () => {
  const fails = [];
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const mod = await import('/src/utils/provinceOverlap.js');
  const { measureProvinceOverlap, describeOverlap, OVERLAP_REJECT_RATIO, OVERLAP_MAX_DIM } = mod;
  const rect = (id, name, x0, y0, x1, y1, extra) => ({ id, name, kind: 'land',
    points: [{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}], ...(extra || {}) });
  const a = rect('a', '甲省', 0, 0, 100, 100);

  ck('阈值常量 = 25%', OVERLAP_REJECT_RATIO === 0.25, OVERLAP_REJECT_RATIO);
  ck('采样格上限是常量（性能闸门不靠运气）', OVERLAP_MAX_DIM === 40, OVERLAP_MAX_DIM);
  const far = measureProvinceOverlap(rect('n', '新省', 300, 0, 400, 100), [a]);
  ck('不相交 → 不拦，且采样格数仍是真实值（不能是 0）', far.blocked === false && far.total > 100,
     { blocked: far.blocked, total: far.total });
  const half = measureProvinceOverlap(rect('h', '半压', 0, 0, 200, 100), [a]);
  ck('压一半 → 拦', half.blocked === true, half.ratio);
  ck('压一半 → 比例 ≈ 0.5', near(half.ratio, 0.5, 0.06), half.ratio);
  const light = measureProvinceOverlap(rect('l', '轻压', 0, 0, 500, 100), [a]);
  ck('压 20% → 放（阈值 25% 的另一侧）', light.blocked === false, light.ratio);
  ck('占用者被点名（给用户看的是名字，不是分数）',
     half.offenders.length === 1 && half.offenders[0].name === '甲省', half.offenders);
  ck('文案带百分比与去处', /%/.test(describeOverlap(half)) && describeOverlap(half).length > 20);

  const holed = { id: 'h1', name: '带洞省', kind: 'land',
    points: [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}],
    extraRings: [{ points: [{x:20,y:20},{x:20,y:80},{x:80,y:80},{x:80,y:20}], kind: 'land' }] };
  const inHole = measureProvinceOverlap(rect('n', '洞中', 25, 25, 75, 75), [holed]);
  ck('只压住「洞」不算压叠（洞不是地盘）', inHole.blocked === false, inHole.ratio);

  const sea = rect('s', '近海', 0, 0, 100, 100, { kind: 'sea' });
  const overSea = measureProvinceOverlap(rect('n', '压海', 0, 0, 100, 100), [sea]);
  ck('压在海域上也拦（海也是分区）', overSea.blocked === true && overSea.offenders[0].kind === 'sea',
     overSea.offenders);

  ck('空表 / null / 退化几何都不抛异常',
     measureProvinceOverlap(a, []).blocked === false
     && measureProvinceOverlap(a, null).blocked === false
     && measureProvinceOverlap(null, [a]).blocked === false
     && measureProvinceOverlap([{x:1,y:1},{x:2,y:2}], [a]).blocked === false);
  return JSON.stringify({ fails, notes: { half: half.ratio, light: light.ratio, total: far.total } });
})()"""


def sub_pure(cdp):
    ok, res = eval_json(cdp, PURE_JS, desc='压叠纯函数')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        return False, '压叠度量断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8])
    n = res.get('notes') or {}
    return True, (f'阈值两侧 / 点名 / 洞 / 海 / 空表 全对'
                  f'（半压 {n.get("half"):.2f}、轻压 {n.get("light"):.2f}、{n.get("total")} 格采样）')


# ══════════════════════════════════════════════════════════════════
# f2 store 压叠闸门（零副作用 + 不许误拒）
# ══════════════════════════════════════════════════════════════════
STORE_JS = r"""(async () => {
  const fails = [], notes = {};
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 120));
  const s = __STORE__, SM = __SM__;
  const KEY = __KEY__;
  const seed = () => { __SEED__ };
  const ids = () => (s.baseMaps[KEY] ? s.baseMaps[KEY].terrain.map(p => p.id) : null);
  const mk = (id, name, x0, y0, x1, y1) => ({ id, name, kind: 'land',
    points: [{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}] });
  /** 一直撤销到 terrain 空，返回步数 —— 「有没有多压一条命令」的判据不能靠数单次撤销 */
  const undoStepsToEmpty = () => {
    let steps = 0;
    while (steps < 12 && s.baseMaps[KEY] && (s.baseMaps[KEY].terrain || []).length) { s.undo(); steps++; }
    return steps;
  };

  seed();
  await tick(150);
  ck('前置：两个省在册', JSON.stringify(ids()) === '["p79a","p79b"]', ids());

  // ① 基线：只 seed 时要几步撤空（seed 自己会压几条命令：建底图 / 两个省 / 重建网格）
  const baseSteps = undoStepsToEmpty();
  ck('基线可撤空', ids() !== null && ids().length === 0, ids());

  // ② 复位后再来一次，并插入一次**被压叠拒绝**的创建 → 步数必须一模一样
  seed();
  await tick(150);
  const before = ids();
  const r1 = s.addBaseProvince(KEY, mk('p79dup', '压叠省', 120, 120, 280, 280));
  ck('压叠被拒', !!(r1 && r1.success === false && r1.rejected === 'overlap'), r1);
  ck('回执带上比例与占用者名字', r1.ratio > 0.9 && r1.offenders[0].name === '甲省',
     { ratio: r1.ratio, offenders: r1.offenders });
  ck('拒绝时 terrain 一格没动', JSON.stringify(ids()) === JSON.stringify(before), ids());
  const rejSteps = undoStepsToEmpty();
  notes.undo = { baseSteps, rejSteps, after: ids() };
  ck('被拒的创建没有多压一条 undo（撤空步数与基线一致）', rejSteps === baseSteps, notes.undo);

  // ③ 复位后继续：确认重试 / 空地照建 / 导入跳过
  seed();
  await tick(150);
  const r2 = s.addBaseProvince(KEY, mk('p79dup', '压叠省', 120, 120, 280, 280), { allowOverlap: true });
  ck('allowOverlap 重试成功', !!(r2 && r2.success === true), r2);
  ck('重试后真的进了表', ids().length === 3, ids());
  s.undo();
  ck('重试也是一条 undo', ids().length === 2, ids());

  const r3 = s.addBaseProvince(KEY, mk('p79far', '空地处', 600, 120, 760, 280));
  ck('空地新省照建', !!(r3 && r3.success === true), r3);
  ck('空地新省的重叠比例 = 0', r3.overlap && r3.overlap.blocked === false && r3.overlap.occupied === 0,
     r3.overlap);

  const r4 = s.addBaseProvince(KEY, mk('p79import', '导入省', 120, 120, 280, 280), { checkOverlap: false });
  ck('checkOverlap:false 时直接建（导入路径）', !!(r4 && r4.success === true), r4);
  return JSON.stringify({ fails, notes });
})()"""


def sub_store_gate(cdp):
    expr = (STORE_JS.replace('__STORE__', STORE).replace('__SM__', SM)
            .replace('__KEY__', json.dumps(KEY)).replace('__SEED__', _seed()))
    ok, res = eval_json(cdp, expr, desc='store 压叠闸门')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        extra = f' 现场：{json.dumps(res.get("notes"), ensure_ascii=False)}' if res.get('notes') else ''
        return False, ('store 闸门断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8]) + extra)
    return True, '压叠拒 + 零副作用（栈里没有幽灵命令）+ 确认后放行 + 空地照建 + 导入可跳过'


# ══════════════════════════════════════════════════════════════════
# f3 真鼠标：拖一圈压在既有省上
# ══════════════════════════════════════════════════════════════════
DRAG = r"""
  const canvasEl = document.querySelector('.scenario-map-container canvas');
  const rr = canvasEl.getBoundingClientRect();
  const mk = (t, x, y, extra) => new MouseEvent(t, Object.assign({
    clientX: rr.left + x, clientY: rr.top + y, bubbles: true, cancelable: true, button: 0,
  }, extra || {}));
  // 世界坐标 → 屏幕坐标（跟着**当前相机**走：创建省份后相机可能被改，写死数字会飘）
  const toScreen = (wx, wy) => ({ x: wx * SM.cameraScale + SM.cameraX, y: wy * SM.cameraScale + SM.cameraY });
  const dragWorld = (corners, per = 10) => {
    const pts = [];
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i], b = corners[(i + 1) % corners.length];
      for (let k = 0; k < per; k++) {
        const t = k / per;
        pts.push(toScreen(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t));
      }
    }
    canvasEl.dispatchEvent(mk('mousedown', pts[0].x, pts[0].y));
    for (let i = 1; i < pts.length; i++) canvasEl.dispatchEvent(mk('mousemove', pts[i].x, pts[i].y));
    const last = pts[pts.length - 1];
    canvasEl.dispatchEvent(mk('mouseup', last.x, last.y));
    canvasEl.dispatchEvent(mk('click', last.x, last.y));
  };
"""

UI_JS = r"""(async () => {
  const fails = [], notes = {};
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 150));
  const s = __STORE__, SM = __SM__;
  const KEY = __KEY__;
  __DRAG__
  __SEED__
  SM.setTool('draw');
  await tick(250);
  const ids = () => s.baseMaps[KEY].terrain.map(p => p.id);

  let asked = 0, answer = false;
  window.confirm = () => { asked++; return answer; };
  notes.camera = { scale: SM.cameraScale, x: SM.cameraX, y: SM.cameraY };

  // ① 压在甲省内部画一圈 → confirm=false → 不建
  answer = false; asked = 0;
  dragWorld([[140,140],[260,140],[260,260],[140,260]]);
  await tick(300);
  ck('压叠那圈被拦下（省数没变）', ids().length === 2, ids());
  ck('闸门**问了**用户（不是静默吞掉）', asked === 1, asked);
  ck('取消有回音（状态栏点名压叠）', /压|取消/.test(String(SM.provinceHint || '')), SM.provinceHint);

  // ② 同一圈，confirm=true → 建出来
  answer = true; asked = 0;
  dragWorld([[140,140],[260,140],[260,260],[140,260]]);
  await tick(300);
  ck('确认后建出（省数 +1）', ids().length === 3, ids());
  const topId = ids()[ids().length - 1];

  // ③ 空地那一圈**不该问**（闸门不是一刀切）
  answer = false; asked = 0;
  dragWorld([[600,120],[760,120],[760,280],[600,280]]);
  await tick(300);
  ck('空地照建，且没弹确认', ids().length === 4 && asked === 0, { n: ids().length, asked: asked });

  // ④ 压叠后的命中口径 = 视觉最上层（新省在表尾 = 画在最上面）
  const hit = SM.findProvinceAt(200, 200);
  ck('压叠处命中的是最后画上去的那个（自顶向下）', !!hit && hit.id === topId,
     { hit: hit && hit.id, top: topId });
  // 反向对照：没压叠的乙省照样点得中
  const hitB = SM.findProvinceAt(420, 200);
  ck('没压叠的乙省照样点得中', !!hitB && hitB.id === 'p79b', hitB && hitB.id);
  return JSON.stringify({ fails, notes });
})()"""


def sub_ui(cdp):
    expr = (UI_JS.replace('__STORE__', STORE).replace('__SM__', SM)
            .replace('__KEY__', json.dumps(KEY)).replace('__SEED__', _seed())
            .replace('__DRAG__', DRAG))
    ok, res = eval_json(cdp, expr, desc='真鼠标压叠')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        extra = f' 现场：{json.dumps(res.get("notes"), ensure_ascii=False)}' if res.get('notes') else ''
        return False, ('鼠标路径断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8]) + extra)
    return True, '压叠问人（取消不建 / 确认才建）+ 空地不问 + 命中自顶向下'


# ══════════════════════════════════════════════════════════════════
# f4 套索闸门
# ══════════════════════════════════════════════════════════════════
LASSO_JS = r"""(async () => {
  const fails = [], notes = {};
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 120));
  const s = __STORE__, SM = __SM__;
  const KEY = __KEY__;
  __SEED__
  await tick(150);
  const snap = () => JSON.stringify(s.baseMaps[KEY].provinceLabels.data);
  const box = (x0, y0, x1, y1) => [{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}];
  const gridCells = (() => {
    const g = s.baseMaps[KEY].provinceLabels;
    return g ? g.cols * g.rows : -1;
  })();
  notes.gridCells = gridCells;

  // ① 目标非法：target = 0（上方下拉没选）——旧实现会把圈内整片静默擦成无主
  const before = snap();
  const r0 = s.applyProvinceLasso(KEY, box(330, 110, 510, 290), 0);
  ck('target=0 被拒', !!(r0 && r0.rejected === 'no-target'), r0);
  ck('target=0 时一个格都没改', snap() === before);
  const r0b = s.applyProvinceLasso(KEY, box(330, 110, 510, 290), 9);
  ck('target 越界被拒', !!(r0b && r0b.rejected === 'no-target'), r0b);

  // ② 面积闸门（默认 50%）：一口吞全图
  const r1 = s.applyProvinceLasso(KEY, box(-100000, -100000, 100000, 100000), 1);
  ck('吞全图被拒（area-gate）', !!(r1 && r1.rejected === 'area-gate'), r1);
  ck('拒绝时零副作用', snap() === before);
  ck('拒绝文案给出占比与去处', /%/.test(r1.message || '') && /笔刷/.test(r1.message || ''), r1.message);

  // ③ 两条阈值都可注入（与点击填充同一套 opts 约定，用例才能锁住两侧）
  const r2 = s.applyProvinceLasso(KEY, box(350, 130, 490, 270), 1, '测试', { maxCells: 3 });
  ck('格数上限可注入且生效（too-big）', !!(r2 && r2.rejected === 'too-big'), r2);
  const r3 = s.applyProvinceLasso(KEY, box(350, 130, 490, 270), 1, '测试', { maxShare: 0.0001 });
  ck('面积阈值可注入且生效（area-gate）', !!(r3 && r3.rejected === 'area-gate'), r3);
  ck('两条注入式拒绝都零副作用', snap() === before);

  // ④ 正常小套索：圈住乙省一角划归甲省 → 照常生效 + 回报圈入量
  const r4 = s.applyProvinceLasso(KEY, box(350, 130, 490, 270), 1);
  ck('小套索生效（圈的是乙省的地，划给甲省）', !!(r4 && r4.changed > 0), r4);
  ck('回报圈入格数（闸门判据与「改了几格」分开）', r4 && r4.inside >= r4.changed, r4);
  ck('写回多边形（reprojected > 0）', !!(r4 && r4.reprojected > 0), r4 && r4.reprojected);
  s.undo();
  ck('一条 undo 还原（几何也回滚）', snap() === before);

  // ⑤ 上千点的轨迹必须被简化（否则 O(格 × 顶点) 卡主线程）
  const many = [];
  for (let i = 0; i < 2000; i++) {
    const t = (i / 2000) * Math.PI * 2;
    many.push({ x: 420 + 60 * Math.cos(t), y: 200 + 60 * Math.sin(t) });
  }
  const r5 = s.applyProvinceLasso(KEY, many, 1);
  const simp = (r5 && r5.simplified) || {};
  ck('两千点轨迹被简化后再用', simp.from === 2000 && simp.to < 200, simp);
  ck('简化后仍然生效', !!(r5 && r5.changed > 0), r5);
  return JSON.stringify({ fails, notes: { ...notes, inside: r4 && r4.inside, changed: r4 && r4.changed,
                                          simp: simp, changedMany: r5 && r5.changed } });
})()"""


def sub_lasso(cdp):
    expr = (LASSO_JS.replace('__STORE__', STORE).replace('__SM__', SM)
            .replace('__KEY__', json.dumps(KEY)).replace('__SEED__', _seed()))
    ok, res = eval_json(cdp, expr, desc='套索闸门')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        extra = f' 现场：{json.dumps(res.get("notes"), ensure_ascii=False)}' if res.get('notes') else ''
        return False, ('套索闸门断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8]) + extra)
    n = res.get('notes') or {}
    return True, (f'目标/面积/格数三闸门各自拒绝且零副作用（网格 {n.get("gridCells")} 格）；'
                  f'小套索圈入 {n.get("inside")} 格改 {n.get("changed")} 格；'
                  f'2000 点轨迹简化到 {(n.get("simp") or {}).get("to")} 点（改 {n.get("changedMany")} 格）')


def run(cdp):
    ensure_data_ready(cdp)
    r = cdp.eval("""(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('历史剧本'));
      if (!b) return 'no-btn';
      b.click(); return 'ok';
    })()""")
    if r != 'ok':
        return False, f'进入剧本模式失败: {r}'
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", desc='ScenarioMap 挂载', timeout=8)
    time.sleep(1.2)

    results = []
    for name, fn in (('f0 源码守卫', sub_source_guards),
                     ('f1 压叠度量（纯函数）', sub_pure),
                     ('f2 store 压叠闸门', sub_store_gate),
                     ('f3 真鼠标压叠', sub_ui),
                     ('f4 套索闸门', sub_lasso)):
        try:
            ok, detail = fn(cdp)
        except Exception as e:
            ok, detail = False, f'异常: {e}'
        results.append((name, ok, detail))

    failed = [f'{n}: {d}' for n, o, d in results if not o]
    if failed:
        return False, (f'省份闸门 {len(results) - len(failed)}/{len(results)} 子测试通过；失败：\n    '
                       + '\n    '.join(failed))
    return True, ('省份闸门 ' + f'{len(results)}/{len(results)} 全通过 — '
                  + '；'.join(d for _, _, d in results))
