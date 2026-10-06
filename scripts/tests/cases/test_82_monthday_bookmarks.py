#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 82：历史剧本「月日精度 + 切片点书签」

来源：《司天-月日精度与切片书签-执行单-20260510》——
  ① 切片时间点要**由人指定**、可精确到**月日**（EU4 bookmark 式静态切片）；
  ② 时间点要有**名字**、可增删改；
  ③ 旧模型 `changeYears[pid] = 1993`（年单值、一省一剧本最多一次）装不下「同省同年多次易主」；
  ④ 帧文件名要含日期；`frames.json` 每帧要有日期与来源（bookmark / era / change）。

本用例覆盖：
  f0 源码守卫：迁移唯一实现（`utils/scenarioDates.js` 的 normalizeScenarioDates）、
     日期比较唯一实现（`cmpDate`）、旧键**只出现在迁移与注释里**（不许还有第二处读 `changeYears`）、
     日期校验唯一实现（`validateChangeDateInRange`）、store 三个装载口都走 `applyScenarioState`。
  f1 月日精度真的生效（端到端）：同一剧本内 6-1 易主 → 5-31 仍是旧主、6-1 起是新主；
     状态栏日期文本随之变化；旧的「只到年」入库不受影响。
  f2 同省同年多次易主：一省两条事件 → 按日期逐条落定，末主决定最终归属。
  f3 切片点书签 CRUD（各一条 undo）：新增/改名/改日期/删除 + 撤销还原。
  f4 书签帧 ∪ 自动帧：切片对话框里书签帧默认必出、与易主同日只出一帧、来源标记都在。
  f5 导出负载：帧名含日期（`_20150601`），manifest 每帧带 `date` / `sources` / `bookmarkIds`。
  f6 越界日期写不进库：`setChangeEvents` 拒绝并给原因，库里保持原样（零副作用）。
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
KEY = '用例82底图'


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

    # ① 迁移与比较的唯一实现必须都在 scenarioDates.js
    dt = _code_only(_read('src/renderer/src/utils/scenarioDates.js'))
    for sym in ['export function normalizeScenarioDates', 'export function cmpDate',
                'export function normalizeDate', 'export function dateKey',
                'export function dateToken', 'export function lastEventAtOrBefore']:
        if sym not in dt:
            bad.append(f'scenarioDates.js 缺少 {sym}')
    if 'delete next.changeYears' not in dt:
        bad.append('迁移没删旧键（双写 = 第二事实源，迟早漂移）')

    # ② 旧键只允许出现在「迁移实现 + 注释」里：别处出现就是第二处读旧格式
    tl = _code_only(_read('src/renderer/src/utils/scenarioTimeline.js'))
    if 'e.year[' in tl:
        bad.append('scenarioTimeline 仍在读 e.year（年份 map 已删，应读 byProvince/lastDate）')
    if 'changeYears' in tl:
        bad.append('scenarioTimeline 里还在出现 changeYears（应交给 scenarioDates 迁移）')
    sl = _code_only(_read('src/renderer/src/utils/scenarioSlices.js'))
    if 'changeYears' in sl:
        bad.append('scenarioSlices 里还在出现 changeYears（应只认 changeEvents）')

    # ③ 日期校验唯一实现：面板与 store 都走它，不许自己写比较
    if 'export function validateChangeDateInRange' not in sl:
        bad.append('scenarioSlices 缺少 validateChangeDateInRange（日期校验唯一实现）')
    se = _code_only(_read('src/renderer/src/store/geodataModules/scenarioEditing.js'))
    if 'validateChangeDateInRange' not in se:
        bad.append('store 没走 validateChangeDateInRange（会出现第二套区间比较）')
    lp = _code_only(_read('src/renderer/src/components/ScenarioLineagePanel.vue'))
    if 'validateChangeDateInRange' not in lp:
        bad.append('面板没走 validateChangeDateInRange')
    if re.search(r'\.start\s*[<>]=?\s*\w+\.y|\.y\s*[<>]=?\s*\w+\.end', lp):
        bad.append('面板又自己写了一遍区间比较（应只走 validateChangeDateInRange）')

    # ④ 装载口必须走 applyScenarioState（漏一个就有旧格式读不出来的静默失效）
    #    geodata 侧两处：打开项目（applyProjectToCanvas）+ 知识库快照还原（releaseProjectFromCanvas）；
    #    导入侧两处（都在 scenarioEditing 里）：importScenariosPayload + importFromScenariosJson。
    if 'function applyScenarioState' not in se:
        bad.append('store 缺少 applyScenarioState（唯一日期迁移入口）')
    gd = _code_only(_read('src/renderer/src/store/geodata.js'))
    if gd.count('applyScenarioState') < 2:
        bad.append(f'geodata 里 applyScenarioState 只出现 {gd.count("applyScenarioState")} 次'
                   '（打开项目 + 知识库快照还原两处都该走它）')
    if re.search(r'scenarioEditingModule\.scenarios\.value\s*=', gd):
        bad.append('geodata 里还有直接赋值 scenarios.value 的路径（绕过迁移）')
    if se.count('applyScenarioState(') < 2:
        bad.append(f'scenarioEditing 里 applyScenarioState 只在 {se.count("applyScenarioState(")} 处被调用'
                   '（定义 1 + importFromScenariosJson 至少 2 次；导入载荷那条走的是 execute，见注释）')

    # ⑤ 书签 CRUD 与运行时区间判定（区间不落盘）
    for sym in ['function addSlicePoint', 'function renameSlicePoint',
                'function updateSlicePoint', 'function removeSlicePoint']:
        if sym not in se:
            bad.append(f'store 缺少 {sym}')
    if 'slicePoints.value = ' not in se.replace('const slicePoints = ref([])', ''):
        bad.append('书签没有可写通道（只读的话 CRUD 全是空转）')

    # ⑥ 时间轴契约：组件仍是 year:Number（月日只由父级持有），且书签标记有 testid
    st = _code_only(_read('src/renderer/src/components/ScenarioTimeline.vue'))
    if 'slicePoints: { type: Array' not in st:
        bad.append('ScenarioTimeline 没有接收 slice-points')
    if 'tl-bookmark-' not in st:
        bad.append('ScenarioTimeline 没画书签标记')
    if "save-slice-point" not in st:
        bad.append('ScenarioTimeline 没有「存为切片点」入口')

    if bad:
        return False, '源码守卫失败：' + '；'.join(bad)
    return True, ('迁移/比较/校验三处单源 + 三个装载口都走 applyScenarioState + '
                  '书签 CRUD 齐备 + 时间轴契约与标记就位')


# ══════════════════════════════════════════════════════════════════
# 公共造数：**照抄 test_78 f5 那个已实证的谱系形状**
#   甲代 A1 占 p82a + p82b；乙代 B1 占 p82b、B2 占 p82a
#   ⇒ 贪心继承让 **B1 承 A1**（重叠 p82b，且 B1 省多先配对），于是
#     **p82a 是易主省、且它的旧主 A1 有主**（否则「易主日前是旧主」会拿到 undefined = 假断言）。
# 🔴 别自己设计「看起来像易主」的夹具：`computeLineage` 的贪心继承几乎总能把新势力配到旧势力上，
#    于是 `changed` 静默为空、事件根本不会被认出来（本轮为此白跑了 2 轮用例）。
# ══════════════════════════════════════════════════════════════════
SEED_JS = r"""
  for (const k of Object.keys(s.scenarios)) s.removeScenario(k);
  if (s.slicePoints) { for (const p of s.slicePoints.slice()) s.removeSlicePoint(p.id); }
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: KEY });
  s.baseMaps[KEY].terrain.length = 0;
  const mk = (id, name, x0) => ({ id, name, kind: 'land',
    points: [{x:x0,y:100},{x:x0+140,y:100},{x:x0+140,y:300},{x:x0,y:300}] });
  s.addBaseProvince(KEY, mk('p82a', '甲省', 100));
  s.addBaseProvince(KEY, mk('p82b', '乙省', 300));
  s.addBaseProvince(KEY, mk('p82c', '丙省', 500));
  s.createScenario(KEY + '/甲时代', { ownerKey: KEY, name: '甲时代', order: 1,
    era: { roman: 'Ⅰ', label: '甲', startYear: '2000', endYear: '2010' },
    polities: [{ id: 'A1', name: '甲国', color: '#c23b3b' }],
    ownership: { p82a: 'A1', p82b: 'A1' } });
  s.createScenario(KEY + '/乙时代', { ownerKey: KEY, name: '乙时代', order: 2,
    era: { roman: 'Ⅱ', label: '乙', startYear: '2010', endYear: '2020' },
    polities: [{ id: 'B1', name: '乙国', color: '#4a90d9' }, { id: 'B2', name: '乙南', color: '#e6a23c' }],
    ownership: { p82a: 'B2', p82b: 'B1' } });
  window.__FRAMES_EXPORTS__ = [];
"""


def _seed(extra_wait_ms=500):
    """造数 + 等过挂载后那发 300ms 的游标重置。"""
    return (SEED_JS.replace('__KEY__', json.dumps(KEY))
            + f"""
  await tick({extra_wait_ms});                 // ⚠️ 等过挂载后 300ms 的 resetTimelineToStart
  SM.baseMapKey = KEY;
  if (typeof SM.onBaseMapChange === 'function') SM.onBaseMapChange();
  await tick(250);
  if (SM.tlEra !== 1) {{ SM.tlEra = 1; await tick(200); }}
""")


def _expr(js, name):
    # 🔴 归属查询用**产品自己的纯函数**（动态 import 拿），不在用例里重写一份「谁归谁」——
    #    自己写一份判定 = 同义反复：被测代码错了测试照样绿。
    #    路径 `/src/utils/scenarioTimeline.js` 在 Vite dev（root = src/renderer）下可解析。
    # ⚠️ `await import(...)` 必须放在**async IIFE 内部**：`cdp.eval` 求值的是一个**表达式**
    #    （不是 module），顶层 await 会直接 SyntaxError「await is only valid in async functions」。
    #    首版就在这里踩了（6 个子测试全部报同一个 SyntaxError）。
    inject = ("const M = await import('/src/utils/scenarioTimeline.js');"
              " const OWN = (tl, k, pid, at) => M.currentOwnerRef(tl, k, pid, at).owner;")
    body = js.replace('__STORE__', STORE).replace('__SM__', SM).replace('__KEY__', json.dumps(KEY))
    # 把注入语句插到 `(async () => {` 之后的第一行
    marker = '(async () => {'
    idx = body.index(marker) + len(marker)
    return body[:idx] + '\n  ' + inject + body[idx:]


# ══════════════════════════════════════════════════════════════════
# f1 月日精度端到端
# ══════════════════════════════════════════════════════════════════
F1_JS = r"""(async () => {
  const fails = [];
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 150));
  const s = __STORE__, SM = __SM__;
  const KEY = __KEY__;
  const SC = KEY + '/乙时代';
  __SEED__

  const tl = SM.timeline;
  ck('前置：乙时代确实有谱系变化省（changed 非空）',
     (tl.eraChg[1] ? tl.eraChg[1].changed.length : 0) > 0, tl.eraChg[1] ? tl.eraChg[1].changed : null);
  const pid = (tl.eraChg[1] && tl.eraChg[1].changed[0]) || 'p82a';

  // —— 写入 2015-06-01 的显式易主 ——
  const w = s.setChangeEvents(SC, pid, [{ y: 2015, m: 6, d: 1, owner: 'B2' }]);
  ck('写入显式日期成功', w && w.success === true, w);
  await tick(250);

  const ev = ((SM.timeline.eraChg[1] || {}).byProvince || {})[pid] || [];
  ck('事件进入时间轴模型（1 条）', ev.length === 1, ev);
  ck('月日被保留（不是只到年）', ev[0] && ev[0].m === 6 && ev[0].d === 1, ev[0]);
  ck('标记为显式', ev[0] && ev[0].explicit === true, ev[0]);
  ck('日期体检不再把它算作合成值',
     (SM.timeline.stats.explicitChangeEvents || 0) >= 1, SM.timeline.stats);

  // —— 🔴 核心：同一剧本内，5-31 与 6-1 的归属必须相反 ——
  // OWN 由 _expr 注入到本 IIFE 顶部（动态 import 产品的 currentOwnerRef）
  const tlNow = SM.timeline;
  ck('探针拿到了归属查询函数（动态 import 注入）', typeof OWN === 'function');
  if (typeof OWN === 'function') {
    const b = OWN(tlNow, 1, pid, { y: 2015, m: 5, d: 31 });
    const a = OWN(tlNow, 1, pid, { y: 2015, m: 6, d: 1 });
    ck('易主日**前**仍是旧主（甲代的主人）', b !== a && !!b, { before: b, after: a });
    ck('易主日**当天**已是新主', a === 'B2', a);
    ck('易主日之后仍是新主', OWN(tlNow, 1, pid, { y: 2015, m: 8, d: 1 }) === 'B2');
    ck('只给年份 = 1 月 1 日 → 仍算旧主（缺省口径）',
       OWN(tlNow, 1, pid, { y: 2015 }) === b, { y: OWN(tlNow, 1, pid, { y: 2015 }), b });
  }

  // —— 状态栏日期文本：把游标钉到 6-1，文本必须带月日 ——
  SM.tlDate = { y: 2015, m: 6, d: 1 };
  await tick(250);
  const dateEl = document.querySelector('[data-testid="tl-date"]');
  ck('状态栏日期元素在', !!dateEl);
  if (dateEl) {
    const txt = dateEl.textContent.trim();
    ck('状态栏显示到月日（2015-06-01）', txt === '2015-06-01', txt);
  }
  SM.tlDate = { y: 2015, m: null, d: null };
  await tick(200);
  const dateEl2 = document.querySelector('[data-testid="tl-date"]');
  if (dateEl2) {
    ck('只到年时**不**谎报 1 月 1 日（显示 2015）', dateEl2.textContent.trim() === '2015',
       dateEl2.textContent.trim());
  }

  return JSON.stringify({ fails, pid, ev });
})()"""


def sub_monthday(cdp):
    expr = _expr(F1_JS.replace('__SEED__', _seed()), 'f1')
    ok, res = eval_json(cdp, expr, desc='月日精度端到端')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        return False, '月日精度断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8])
    return True, f'月中易主前后归属相反 + 状态栏日期文本随动（省 {res.get("pid")}）'


# ══════════════════════════════════════════════════════════════════
# f2 同省同年多次易主
# ══════════════════════════════════════════════════════════════════
F2_JS = r"""(async () => {
  const fails = [];
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 150));
  const s = __STORE__, SM = __SM__;
  const KEY = __KEY__;
  const SC = KEY + '/乙时代';
  __SEED__

  const tl0 = SM.timeline;
  const pid = (tl0.eraChg[1] && tl0.eraChg[1].changed[0]) || 'p82a';
  const w = s.setChangeEvents(SC, pid, [
    { y: 2015, m: 3, d: 1, owner: 'B2' },
    { y: 2015, m: 9, d: 1, owner: 'B2' },
  ]);
  ck('一次写入两条事件', w && w.success === true && w.changed === 2, w);
  await tick(250);

  const ev = ((SM.timeline.eraChg[1] || {}).byProvince || {})[pid] || [];
  ck('模型里两条事件且按日期升序', ev.length === 2 && ev[0].m === 3 && ev[1].m === 9, ev);
  ck('事件条数统计正确', SM.timeline.stats.changeEvents >= 2, SM.timeline.stats.changeEvents);

  // OWN 由 _expr 注入到本 IIFE 顶部（动态 import 产品纯函数得来），直接用，不要再声明
  if (typeof OWN === 'function') {
    const t = SM.timeline;
    ck('第一条事件**之前**是上一代的主人 A1',
       OWN(t, 1, pid, { y: 2015, m: 2 }) === 'A1', OWN(t, 1, pid, { y: 2015, m: 2 }));
    ck('3 月后是第一条事件的主 B2', OWN(t, 1, pid, { y: 2015, m: 5 }) === 'B2', OWN(t, 1, pid, { y: 2015, m: 5 }));
    ck('9 月后仍是末条事件的主 B2', OWN(t, 1, pid, { y: 2015, m: 10 }) === 'B2', OWN(t, 1, pid, { y: 2015, m: 10 }));
    ck('剧本末尾跟随本剧本归属 B2', OWN(t, 1, pid, { y: 2019 }) === 'B2', OWN(t, 1, pid, { y: 2019 }));
  }

  // 清理：清空该省显式日期（一条命令），回到自动推算
  const c = s.setChangeEvents(SC, pid, null);
  await tick(200);
  ck('清空后没有该省的显式事件',
     (((SM.timeline.eraChg[1] || {}).byProvince || {})[pid] || []).every(e => !e.explicit),
     ((SM.timeline.eraChg[1] || {}).byProvince || {})[pid]);
  ck('清空命令回报成功', c && c.success === true, c);

  return JSON.stringify({ fails, pid, ev });
})()"""


def sub_multi_per_year(cdp):
    expr = _expr(F2_JS.replace('__SEED__', _seed()), 'f2')
    ok, res = eval_json(cdp, expr, desc='同省同年多次易主')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        return False, '多次易主断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8])
    return True, f'一省两条事件按日期逐条生效、末主决定归属（省 {res.get("pid")}）'


# ══════════════════════════════════════════════════════════════════
# f3 切片点书签 CRUD（各一条 undo）
# ══════════════════════════════════════════════════════════════════
F3_JS = r"""(async () => {
  const fails = [];
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 150));
  const s = __STORE__, SM = __SM__;
  const KEY = __KEY__;
  __SEED__

  const list = () => (s.slicePoints || []).map(p => ({ id: p.id, label: p.label, y: p.y, m: p.m, d: p.d }));
  ck('起点：没有书签', list().length === 0, list());

  // ① 新增（月日精度）
  const a = s.addSlicePoint({ y: 2015, m: 6, d: 1 }, '会战');
  await tick(200);
  ck('新增成功并给 id', a && a.success === true && !!a.id, a);
  let L = list();
  ck('新增后 1 条且月日保留', L.length === 1 && L[0].m === 6 && L[0].d === 1, L);
  ck('名字写进去了', L[0].label === '会战', L);

  // ② 第二条：只给年（月日应为 null，不许补 1-1）
  const b = s.addSlicePoint({ y: 2018 }, '');
  await tick(200);
  L = list();
  ck('第二条（只到年）', L.length === 2, L);
  const onlyYear = L.find(p => p.y === 2018);
  ck('只到年的书签月日为 null', onlyYear && onlyYear.m === null && onlyYear.d === null, onlyYear);
  ck('书签按日期升序（2015 在前）', L[0].y === 2015 && L[1].y === 2018, L);

  // ③ 改名
  s.renameSlicePoint(a.id, '甲午会战');
  await tick(200);
  ck('改名生效', list().find(p => p.id === a.id).label === '甲午会战', list());
  s.undo(); await tick(250);
  ck('改名可撤销（回到「会战」）', list().find(p => p.id === a.id).label === '会战', list());
  s.redo(); await tick(200);
  ck('重做回到新名字', list().find(p => p.id === a.id).label === '甲午会战', list());

  // ④ 改日期
  s.updateSlicePoint(a.id, { y: 2015, m: 7, d: 7 });
  await tick(200);
  const moved = list().find(p => p.id === a.id);
  ck('改日期生效（7-7）', moved && moved.m === 7 && moved.d === 7, moved);

  // ⑤ 删除 + 一条 undo 撤回
  const r = s.removeSlicePoint(a.id);
  await tick(200);
  ck('删除成功', r && r.success === true, r);
  ck('删除后只剩 1 条', list().length === 1, list());
  s.undo(); await tick(250);
  L = list();
  ck('**一条** undo 把书签整个还原', L.length === 2 && !!L.find(p => p.id === a.id), L);
  const back = L.find(p => p.id === a.id);
  ck('还原的是删除**之前**那次编辑结果（7-7）', back && back.m === 7 && back.d === 7, back);
  s.redo(); await tick(200);
  ck('重做再次删除', list().length === 1, list());

  // ⑥ sanitize：脏值必须被清洗（不抛异常、不把非对象塞进来）
  const pts = s.sanitizeSlicePoints([{ id: 'x', y: 2019 }, null, { y: 'bad' }, 42]);
  ck('sanitize 丢掉非对象/非法年份，只剩一条', Array.isArray(pts) && pts.length === 1, pts);

  // 清理
  for (const p of (s.slicePoints || []).slice()) s.removeSlicePoint(p.id);
  await tick(200);
  ck('清理后没有书签', list().length === 0, list());

  return JSON.stringify({ fails });
})()"""


def sub_bookmarks(cdp):
    expr = _expr(F3_JS.replace('__SEED__', _seed()), 'f3')
    ok, res = eval_json(cdp, expr, desc='切片点书签 CRUD')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        return False, '书签 CRUD 断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8])
    return True, '新增/改名/改日期/删除各一条 undo，只到年不补月日，脏值被清洗'


# ══════════════════════════════════════════════════════════════════
# f4 书签帧 ∪ 自动帧（对话框）
# ══════════════════════════════════════════════════════════════════
F4_JS = r"""(async () => {
  const fails = [];
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 150));
  const s = __STORE__, SM = __SM__;
  const KEY = __KEY__;
  const SC = KEY + '/乙时代';
  __SEED__

  const tl0 = SM.timeline;
  const pid = (tl0.eraChg[1] && tl0.eraChg[1].changed[0]) || 'p82a';
  // 一个易主日（2015-06-01）+ 两个书签：一个落在**同一天**、一个落在别处
  s.setChangeEvents(SC, pid, [{ y: 2015, m: 6, d: 1, owner: 'B2' }]);
  const sp1 = s.addSlicePoint({ y: 2015, m: 6, d: 1 }, '会战');
  const sp2 = s.addSlicePoint({ y: 2017, m: 2, d: 3 }, '和约');
  await tick(300);

  SM.showSliceExport = true;
  await tick(450);
  const panel = document.querySelector('[data-testid="slice-export-panel"]');
  if (!panel) return JSON.stringify({ fails: ['切片导出对话框没渲染'] });

  const rows = Array.from(panel.querySelectorAll('[data-testid="slice-frame-list"] tbody tr'));
  const dates = rows.map(tr => (tr.querySelector('[data-testid^="slice-frame-date-"]') || {}).textContent || '');
  const kinds = rows.map(tr => tr.getAttribute('data-kind'));
  ck('对话框列出帧', rows.length > 0, rows.length);
  ck('书签 2017-02-03 出帧', dates.includes('2017-02-03'), dates);
  ck('同一天的易主 + 书签只出一帧（2015-06-01 出现一次）',
     dates.filter(d => d === '2015-06-01').length === 1, dates);
  const merged = rows.find(tr => (tr.querySelector('[data-testid^="slice-frame-date-"]') || {}).textContent === '2015-06-01');
  ck('合并帧的 kind = change（有易主）或 mixed（撞上起点）',
     !!merged && (merged.getAttribute('data-kind') === 'change' || merged.getAttribute('data-kind') === 'mixed'),
     merged ? merged.getAttribute('data-kind') : null);
  ck('合并帧的来源里既有切片点也有易主',
     !!merged && /切片点/.test(merged.textContent) && /易主/.test(merged.textContent),
     merged ? merged.textContent.replace(/\s+/g, ' ').trim() : null);
  ck('纯书签帧的来源显示「切片点」', kinds.some((k, i) => k === 'bookmark'), kinds);
  ck('切片点计数角标 = 2',
     Number((panel.querySelector('[data-testid="slice-point-count"]') || {}).textContent) === 2,
     (panel.querySelector('[data-testid="slice-point-count"]') || {}).textContent);

  // 删掉纯书签 → 该帧消失
  s.removeSlicePoint(sp2.id);
  await tick(350);
  const rows2 = Array.from(panel.querySelectorAll('[data-testid="slice-frame-list"] tbody tr'));
  const dates2 = rows2.map(tr => (tr.querySelector('[data-testid^="slice-frame-date-"]') || {}).textContent || '');
  ck('删除书签后 2017-02-03 帧消失', !dates2.includes('2017-02-03'), dates2);
  s.undo(); await tick(350);
  const rows3 = Array.from(panel.querySelectorAll('[data-testid="slice-frame-list"] tbody tr'));
  const dates3 = rows3.map(tr => (tr.querySelector('[data-testid^="slice-frame-date-"]') || {}).textContent || '');
  ck('撤销后该帧回来', dates3.includes('2017-02-03'), dates3);

  SM.showSliceExport = false;
  await tick(200);
  // 清理书签
  for (const p of (s.slicePoints || []).slice()) s.removeSlicePoint(p.id);
  await tick(150);
  return JSON.stringify({ fails, dates: dates3 });
})()"""


def sub_bookmark_frames(cdp):
    expr = _expr(F4_JS.replace('__SEED__', _seed()), 'f4')
    ok, res = eval_json(cdp, expr, desc='书签帧 ∪ 自动帧')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        return False, '书签帧断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8])
    return True, f'书签帧默认必出、同日合并、删改随动（帧日期 {res.get("dates")}）'


# ══════════════════════════════════════════════════════════════════
# f5 导出负载：帧名含日期 + manifest 带日期与来源
# ══════════════════════════════════════════════════════════════════
F5_JS = r"""(async () => {
  const fails = [];
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 150));
  const s = __STORE__, SM = __SM__;
  const KEY = __KEY__;
  const SC = KEY + '/乙时代';
  __SEED__

  const tl0 = SM.timeline;
  const pid = (tl0.eraChg[1] && tl0.eraChg[1].changed[0]) || 'p82a';
  s.setChangeEvents(SC, pid, [{ y: 2015, m: 6, d: 1, owner: 'B2' }]);
  s.addSlicePoint({ y: 2017, m: 2, d: 3 }, '和约');
  await tick(300);

  window.__FRAMES_EXPORTS__ = [];
  SM.showSliceExport = true;
  await tick(400);
  const btn = document.querySelector('[data-testid="slice-export-run"]');
  ck('导出按钮在', !!btn);
  btn.click();
  await tick(900);
  SM.showSliceExport = false;
  await tick(200);

  const calls = window.__FRAMES_EXPORTS__;
  ck('走了 exportScenarioFrames（mock 记录 1 次）', calls.length === 1, calls.length);
  if (calls.length) {
    const { files, manifest } = calls[0];
    const names = files.map(f => f.name);
    ck('帧名含日期段 20150601', names.some(n => n.includes('20150601')), names);
    ck('帧名含日期段 20170203', names.some(n => n.includes('20170203')), names);
    ck('帧名不含 `-`（负数年与路径分隔符都安全）', names.every(n => !n.includes('-')), names);
    ck('manifest 帧数与文件数一致', manifest.frames.length === files.length, manifest.frames.length);
    const fr = manifest.frames.find(f => f.dateText === '2015-06-01');
    ck('manifest 每帧带 date 对象', !!fr && fr.date && fr.date.y === 2015 && fr.date.m === 6 && fr.date.d === 1,
       fr ? fr.date : null);
    ck('manifest 每帧带 sources', !!fr && Array.isArray(fr.sources) && fr.sources.includes('change'),
       fr ? fr.sources : null);
    const bm = manifest.frames.find(f => f.dateText === '2017-02-03');
    ck('书签帧的来源含 bookmark', !!bm && bm.sources.includes('bookmark'), bm ? bm.sources : null);
    ck('书签帧带 bookmarkIds', !!bm && bm.bookmarkIds.length === 1, bm ? bm.bookmarkIds : null);
    ck('书签帧带名字', !!bm && bm.label === '和约', bm ? bm.label : null);
  }

  for (const p of (s.slicePoints || []).slice()) s.removeSlicePoint(p.id);
  await tick(150);
  return JSON.stringify({ fails, names: calls.length ? calls[0].files.map(f => f.name) : [] });
})()"""


def sub_export_payload(cdp):
    expr = _expr(F5_JS.replace('__SEED__', _seed()), 'f5')
    ok, res = eval_json(cdp, expr, desc='切片导出负载')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        return False, '导出负载断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8])
    return True, f'帧名含日期、manifest 带 date/sources/bookmarkIds（{res.get("names")}）'


# ══════════════════════════════════════════════════════════════════
# f6 越界日期零副作用
# ══════════════════════════════════════════════════════════════════
F6_JS = r"""(async () => {
  const fails = [];
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 150));
  const s = __STORE__, SM = __SM__;
  const KEY = __KEY__;
  const SC = KEY + '/乙时代';
  __SEED__

  const tl0 = SM.timeline;
  const pid = (tl0.eraChg[1] && tl0.eraChg[1].changed[0]) || 'p82a';
  const before = JSON.stringify(((s.scenarios[SC] || {}).changeEvents || {}));

  // 越界年（乙时代是 2010~2020）
  const r1 = s.setChangeEvents(SC, pid, [{ y: 1899, m: 1, d: 1, owner: 'B2' }]);
  ck('越界年被拒', r1 && r1.success === false, r1);
  ck('越界年给了原因', !!(r1 && r1.reason), r1);

  // 月日脏值
  const r2 = s.setChangeEvents(SC, pid, [{ y: 2015, m: 13, d: 1, owner: 'B2' }]);
  ck('13 月被拒', r2 && r2.success === false, r2);
  const r3 = s.setChangeEvents(SC, pid, [{ y: 2015, m: 2, d: 30, owner: 'B2' }]);
  ck('平年 2-30 被拒', r3 && r3.success === false, r3);

  await tick(250);
  ck('🔴 三次被拒后库里**一个字节都没变**（零副作用）',
     JSON.stringify(((s.scenarios[SC] || {}).changeEvents || {})) === before,
     { before, after: JSON.stringify(((s.scenarios[SC] || {}).changeEvents || {})) });

  // 批量口也要拒（并回报 rejected，别静默）
  const rb = s.setChangeEventsBulk(SC, { [pid]: { y: 2050, m: 1, d: 1 } });
  await tick(200);
  ck('批量口拒绝越界并回报 rejected',
     rb && rb.rejected && rb.rejected.length === 1, rb);
  ck('批量被拒后库里仍无该省显式事件',
     !((s.scenarios[SC].changeEvents || {})[pid]), (s.scenarios[SC].changeEvents || {})[pid]);

  return JSON.stringify({ fails });
})()"""


def sub_reject_out_of_range(cdp):
    expr = _expr(F6_JS.replace('__SEED__', _seed()), 'f6')
    ok, res = eval_json(cdp, expr, desc='越界日期零副作用')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        return False, '越界拒写断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8])
    return True, '越界年 / 13 月 / 平年 2-30 全部拒写且零副作用，批量口回报 rejected'


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
    # 模态打桩（本仓惯例）：书签新增用 prompt，删除/越界可能用 confirm
    cdp.eval("window.confirm = () => true; window.prompt = (m, d) => d;")
    time.sleep(0.6)

    results = []
    for name, fn in (('f0 源码守卫', sub_source_guards),
                     ('f1 月日精度', sub_monthday),
                     ('f2 同年多次易主', sub_multi_per_year),
                     ('f3 书签 CRUD', sub_bookmarks),
                     ('f4 书签帧', sub_bookmark_frames),
                     ('f5 导出负载', sub_export_payload),
                     ('f6 越界零副作用', sub_reject_out_of_range)):
        try:
            ok, detail = fn(cdp)
        except Exception as e:
            ok, detail = False, f'异常: {e}'
        results.append((name, ok, detail))

    failed = [f'{n}: {d}' for n, o, d in results if not o]
    if failed:
        return False, (f'月日精度与切片书签 {len(results) - len(failed)}/{len(results)} 子测试通过；失败：\n    '
                       + '\n    '.join(failed))
    return True, ('月日精度与切片书签 ' + f'{len(results)}/{len(results)} 全通过 — '
                  + '；'.join(d for _, _, d in results))
