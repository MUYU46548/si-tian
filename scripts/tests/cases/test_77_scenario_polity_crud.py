#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 77：历史剧本「势力增删 + 省份级联 + 导出同源 + 属性面板写路径」

来源：2026-10-01 只读审计（三路并行）查出的四类问题，暮雨拍板「四块一起做」：
  ① **势力只能改名，不能新建/删除** —— `polities` 只有 Azgaar `.map` 导入一条来路，
     自建底图 + 自建剧本 = `polities: []` → 色板空空、油漆桶点了**静默无反应**；
     删除同样没有 → 错导入的 FMG 国名永久留在地图与谱系里。
  ② 删省份**不级联** `scenarios[*].ownership` / `changeEvents`（键就是省份 id；2026-10-05
     月日精度后旧键 `changeYears` 已由 `utils/scenarioDates.js#normalizeScenarioDates` 读时迁移）
     → 孤儿键看不见却参与 `groupMap` 分组与谱系继承的重叠度 → 「势力继承莫名断裂」。
  ③ SVG 导出**与画布不同源**：只画主环（洞被填实、飞地丢）、海域照样按归属上色、
     没有势力名标签（而真实数据 21 个省份名里 20 个是 `Province N`，会被过滤器跳过）
     → 导出的 SVG 是一张**没有字的色块图**。
  ④ 省份属性面板用 `v-model="selectedProvince.xxx"` **直改 store 活对象**：绕开写闸门、
     每敲一个字符一条 undo、且 `updateBaseProvince` 采集的 `oldProv` 已被污染 →
     **改名/群系/文化/海岸/类型的撤销全是空转**。

本用例覆盖：
  f0 源码守卫：配色单源（`utils/scenarioPalette.js`）、环平滑单源（`ringPointsForRender`）、
     标签判定单源（`utils/scenarioLabels.js`）、导出链不许再直读 `prov.points`、
     属性面板不许再用 `v-model="selectedProvince.x"`、势力增删已接线且删除带级联、
     剧本画布有 DPR 缩放。
  f1 势力 CRUD 行为：自建剧本（零势力）→ `addPolity` → undo/redo → 指派 + 改色 →
     `removePolity` **连带清 ownership/changeEvents**并回报受影响省数 → undo 整体还原 → redo 再清。
  f2 删省级联行为：`removeBaseProvince` 清掉该省在各剧本里的归属与易主日期 + 回报份数，
     undo 把省份与两个键一起还原（**同一条 undo**）。
  f3 导出与画布同源：真导出 SVG，断言 ① 势力名文本进了图（此前完全没有）
     ② 海域填充色 = `SEA_FILL` 且海界是虚线 ③ 多环省份的**洞**也进了 path
     ④ `fill-rule="evenodd"` 在场（洞才会真空）。
  f4 属性面板写路径：模拟下拉 change → store 落值 → **undo 真能还原**（旧实现是空转）。
"""
import sys, os, io, json, re
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json  # noqa: E402
from lib.helpers import ensure_data_ready  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
KEY = '用例77底图'


def _read(rel):
    return io.open(os.path.join(ROOT, rel), encoding='utf-8').read()


def _code_only(src):
    """剥掉注释后再判子串 —— 本仓三次踩到「注释里的字样被当成实现」（test_59/71/75）。"""
    src = re.sub(r'<!--.*?-->', '', src, flags=re.S)
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    return re.sub(r'(?m)//[^\n]*', '', src)


# ══════════════════════════════════════════════════════════════════
# f0 源码守卫
# ══════════════════════════════════════════════════════════════════
def sub_source_guards(cdp):
    bad = []

    pal = _code_only(_read('src/renderer/src/utils/scenarioPalette.js'))
    for sym in ['export const PROVINCE_PALETTE', 'export const SEA_FILL',
                'export const SEA_EDGE', 'export const BORDER_COLOR',
                'export function nextProvinceColor']:
        if sym not in pal:
            bad.append(f'utils/scenarioPalette.js 缺少 {sym}')

    ps = _code_only(_read('src/renderer/src/utils/provinceShape.js'))
    if 'export function ringPointsForRender' not in ps:
        bad.append('provinceShape 缺少 ringPointsForRender（环平滑必须单源）')

    sl = _code_only(_read('src/renderer/src/utils/scenarioLabels.js'))
    if 'export function collectScenarioLabels' not in sl:
        bad.append('utils/scenarioLabels.js 缺少 collectScenarioLabels（标签判定单源）')

    sm = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
    ex = _code_only(_read('src/renderer/src/composables/useScenarioExport.js'))
    se = _read('src/renderer/src/store/geodataModules/scenarioEditing.js')

    if "from '../utils/scenarioPalette'" not in sm:
        bad.append('ScenarioMap 没引 scenarioPalette（海域/色板会出现第二份常量）')
    if "from '../utils/scenarioPalette'" not in ex:
        bad.append('导出链没引 scenarioPalette（导出与画布配色会漂）')
    if 'rgba(74, 118, 158' in sm or 'rgba(74, 118, 158' in ex:
        bad.append('海域填充色又被写成本地字面量（配色单源被破坏）')
    if 'ringPointsForRender' not in ex:
        bad.append('导出链没用 ringPointsForRender（导出与画布的平滑规则不一致）')
    if 'collectScenarioLabels' not in ex:
        bad.append('导出链没接 collectScenarioLabels（导出图会没有势力名）')
    if 'collectScenarioLabels' not in sm:
        bad.append('画布没接 collectScenarioLabels（标签判定又变成两份）')
    if re.search(r'\bprov\.points\b', ex):
        bad.append('导出链仍在直读 prov.points（多环省份的洞/飞地会丢）')
    if re.search(r'v-model="selectedProvince\.', sm):
        bad.append('省份属性面板又用 v-model 直改 store 活对象（绕写闸门 + 撤销空转）')

    for sym in ['data-testid="add-polity"', 'data-testid="polity-delete"',
                'data-testid="polity-color-input"']:
        if sym not in sm:
            bad.append(f'势力色板缺少 {sym}（新建/删除/改色没有落点）')

    for fn in ['function addPolity', 'function removePolity']:
        if fn not in se:
            bad.append(f'scenarioEditing 缺少 {fn}')
    exported = se.split('return {')[-1]
    for fn in ['addPolity', 'removePolity']:
        if fn not in exported:
            bad.append(f'{fn} 没导出到 store 壳（组件拿不到）')

    idx = se.find('function removeBaseProvince')
    seg = se[idx:idx + 3200] if idx >= 0 else ''
    # 🔴 月日精度（2026-10-05）：级联清的第二个键由 `changeYears` 改名 `changeEvents`
    if 'ownership' not in seg or 'changeEvents' not in seg:
        bad.append('removeBaseProvince 没有级联清 ownership/changeEvents（孤儿键会永久随项目往返）')

    if 'devicePixelRatio' not in sm or 'setTransform(canvasDpr' not in sm:
        bad.append('剧本画布没有 DPR 缩放（高分屏下是位图放大 = 发虚）')

    if bad:
        return False, '源码守卫失败：' + '；'.join(bad)
    return True, ('配色/环平滑/标签三处单源 + 导出链不许直读 prov.points + 面板不许 v-model 直改 + '
                  '势力增删接线（删带级联）+ 画布 DPR —— 全部就位')


# ══════════════════════════════════════════════════════════════════
# f1 势力 CRUD（行为 + undo/redo + 级联）
# ══════════════════════════════════════════════════════════════════
CRUD_JS = r"""(async () => {
  const fails = [];
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 150));
  const s = __STORE__;
  const KEY = __KEY__;
  const SC = KEY + '/自建';

  for (const k of Object.keys(s.scenarios)) s.removeScenario(k);
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: KEY });
  s.baseMaps[KEY].terrain.length = 0;
  s.addBaseProvince(KEY, { id: 'p77a', name: '甲省', kind: 'land',
    points: [{x:100,y:100},{x:240,y:100},{x:240,y:240},{x:100,y:240}] });
  s.addBaseProvince(KEY, { id: 'p77b', name: '乙省', kind: 'land',
    points: [{x:300,y:100},{x:440,y:100},{x:440,y:240},{x:300,y:240}] });
  s.createScenario(SC, { ownerKey: KEY, name: '自建', order: 1,
    era: { roman: 'Ⅰ', label: '一', startYear: '1000', endYear: '1100' },
    polities: [], ownership: {} });
  await tick(200);

  ck('起点：自建剧本 polities 为空（正是旧实现的死局）', (s.scenarios[SC].polities || []).length === 0);

  // ① 新建势力
  const r1 = s.addPolity(SC, { name: '甲国' });
  ck('addPolity 成功', !!(r1 && r1.success === true), r1);
  ck('polities 增到 1', (s.scenarios[SC].polities || []).length === 1);
  const p0 = (s.scenarios[SC].polities || [])[0] || {};
  ck('新势力带名字', p0.name === '甲国', p0);
  ck('新势力带自动配色（色板轮转，不是 undefined）', /^#/.test(p0.color || ''), p0.color);
  ck('新势力有本剧本内唯一的 id', !!p0.id && /^pol_/.test(p0.id), p0.id);
  const pid = p0.id;

  // ② 新建是可撤销的
  s.undo();
  ck('undo 撤掉新建', (s.scenarios[SC].polities || []).length === 0);
  s.redo();
  ck('redo 恢复新建', (s.scenarios[SC].polities || []).length === 1);

  // ③ 指派 + 改色（改色此前有 store 能力、无 UI；这里同时守 store 侧）
  // 🔴 月日精度（2026-10-05）：第 4 参是**日期对象** `{y,m,d}` —— 不再接受裸年份
  //    （`scenarioDates.normalizeDate` 对非对象一律 null → 裸年份会被判「日期无法识别」
  //      并且**整条命令被拒**，连 ownership 都不会写；见报告里的源码疑点）。
  s.setOwnership(SC, 'p77a', pid, { y: 1050, m: null, d: null });
  const r2 = s.updatePolity(SC, pid, { color: '#123456' });
  ck('updatePolity 改色落库', !!(r2 && r2.success) && s.scenarios[SC].polities[0].color === '#123456', r2);
  ck('指派写进了 ownership', s.scenarios[SC].ownership['p77a'] === pid);
  // `changeEvents` 不在剧本默认形状里（没写过就没这个键）→ 一律走这个取值口
  const evOf = () => (((s.scenarios[SC].changeEvents || {})['p77a']) || []);
  ck('显式易主日期一并记下（changeEvents；月/日为 null = 只到年）',
     evOf().length === 1 && evOf()[0].y === 1050 && evOf()[0].m === null && evOf()[0].d === null,
     s.scenarios[SC].changeEvents);
  ck('日期事件带 owner（谁在这一天接手）', evOf()[0].owner === pid, evOf());

  // ④ 删除势力：必须连带清反向索引
  const r3 = s.removePolity(SC, pid);
  ck('removePolity 成功', !!(r3 && r3.success === true), r3);
  ck('势力已摘掉', (s.scenarios[SC].polities || []).length === 0);
  ck('受影响省数被点名（UI 二次确认要用它）', r3 && r3.affected === 1, r3);
  ck('ownership 孤儿键已清（不留指向不存在势力的 id）',
     s.scenarios[SC].ownership['p77a'] === undefined, s.scenarios[SC].ownership);
  ck('changeEvents 同步清掉（不留指向已删省份/无主事件的孤儿键）',
     (s.scenarios[SC].changeEvents || {})['p77a'] === undefined, s.scenarios[SC].changeEvents);

  // ⑤ 删除也是一条 undo（整体还原：势力 + 归属 + 日期 一起回来）
  s.undo();
  ck('undo 还原势力', (s.scenarios[SC].polities || []).length === 1
     && s.scenarios[SC].polities[0].id === pid, s.scenarios[SC].polities);
  ck('undo 还原归属', s.scenarios[SC].ownership['p77a'] === pid, s.scenarios[SC].ownership);
  ck('undo 还原易主日期', evOf().length === 1 && evOf()[0].y === 1050,
     (s.scenarios[SC].changeEvents || {})['p77a']);
  s.redo();
  ck('redo 再次清空（两半都清）', (s.scenarios[SC].polities || []).length === 0
     && s.scenarios[SC].ownership['p77a'] === undefined);

  return JSON.stringify({ fails });
})()"""


def sub_polity_crud(cdp):
    ok, res = eval_json(cdp, CRUD_JS.replace('__STORE__', STORE).replace('__KEY__', json.dumps(KEY)),
                        desc='势力 CRUD')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        return False, '势力 CRUD 断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8])
    return True, ('自建剧本（零势力）可新建 → undo/redo → 指派+改色 → 删除连带清 ownership/changeEvents '
                  '并回报受影响省数 → undo 整体还原')


# ══════════════════════════════════════════════════════════════════
# f2 删省级联（一条 undo 里包含省份 + 两个键）
# ══════════════════════════════════════════════════════════════════
CASCADE_JS = r"""(async () => {
  const fails = [];
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const s = __STORE__;
  const KEY = __KEY__;
  const SC = KEY + '/自建';
  const prov = () => (s.baseMaps[KEY].terrain || []).find(p => p.id === 'p77a');

  // 自备前提：一个势力占着 p77a 并带显式易主日期（f1 的结束态是"已删势力"，
  // 不依赖上一步的残留状态 —— 步骤间耦合会让红的是测试自己）
  let pol = (s.scenarios[SC].polities || [])[0];
  if (!pol) { const rp = s.addPolity(SC, { name: '甲国' }); pol = { id: rp.id }; }
  s.setOwnership(SC, 'p77a', pol.id, { y: 1050, m: null, d: null });

  const evOf = () => (((s.scenarios[SC].changeEvents || {})['p77a']) || []);
  ck('前置：省份在册', !!prov());
  ck('前置：该省有归属 + 易主日期', s.scenarios[SC].ownership['p77a'] !== undefined
     && evOf().length === 1 && evOf()[0].y === 1050, s.scenarios[SC].changeEvents);

  const r = s.removeBaseProvince(KEY, 'p77a');
  ck('省份已从 terrain 移除', !prov());
  ck('级联：ownership 键已清', s.scenarios[SC].ownership['p77a'] === undefined, s.scenarios[SC].ownership);
  ck('级联：changeEvents 键已清', (s.scenarios[SC].changeEvents || {})['p77a'] === undefined,
     s.scenarios[SC].changeEvents);
  ck('级联：别的省的归属不受影响', s.scenarios[SC].ownership['p77b'] === undefined);
  ck('回执点名清理了几个剧本', !!(r && r.cascadedScenarios === 1), r);

  s.undo();
  ck('undo 还原省份', !!prov());
  ck('undo 一并还原归属（级联必须同一条 undo）', s.scenarios[SC].ownership['p77a'] !== undefined, s.scenarios[SC].ownership);
  ck('undo 一并还原易主日期', evOf().length === 1 && evOf()[0].y === 1050,
     (s.scenarios[SC].changeEvents || {})['p77a']);

  return JSON.stringify({ fails });
})()"""


def sub_province_cascade(cdp):
    ok, res = eval_json(cdp, CASCADE_JS.replace('__STORE__', STORE).replace('__KEY__', json.dumps(KEY)),
                        desc='删省级联')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        return False, '删省级联断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8])
    return True, '删省份连带清 ownership/changeEvents（各剧本）+ 回报份数；一条 undo 把省份与两个键一起还原'


# ══════════════════════════════════════════════════════════════════
# f3 导出与画布同源（真导出 SVG 文本）
# ══════════════════════════════════════════════════════════════════
EXPORT_JS = r"""(async () => {
  const fails = [];
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 150));
  const s = __STORE__;
  const SM = __SM__;
  const KEY = __KEY__;
  const SC = KEY + '/自建';

  // 底图：一个带**洞**的陆地省 + 一个省 + 一片海域（真实数据当前没有洞/海，用例自造）
  s.baseMaps[KEY].terrain.length = 0;
  s.addBaseProvince(KEY, { id: 'p77ring', name: '环省', kind: 'land',
    points: [{x:100,y:100},{x:400,y:100},{x:400,y:400},{x:100,y:400}],
    extraRings: [{ kind: 'land', points: [{x:200,y:200},{x:300,y:200},{x:300,y:300},{x:200,y:300}] }] });
  s.addBaseProvince(KEY, { id: 'p77b', name: '乙省', kind: 'land',
    points: [{x:500,y:100},{x:700,y:100},{x:700,y:400},{x:500,y:400}] });
  s.addBaseProvince(KEY, { id: 'p77sea', name: '近海', kind: 'sea',
    points: [{x:800,y:100},{x:1000,y:100},{x:1000,y:400},{x:800,y:400}] });

  // 剧本：一个有名有色的势力占着两个陆地省
  for (const k of Object.keys(s.scenarios)) s.removeScenario(k);
  s.createScenario(SC, { ownerKey: KEY, name: '自建', order: 1,
    era: { roman: 'Ⅰ', label: '一', startYear: '1000', endYear: '1100' },
    polities: [{ id: 'X1', name: '甲国', color: '#c23b3b' }],
    ownership: { p77ring: 'X1', p77b: 'X1' } });

  SM.baseMapKey = KEY;
  SM.selectedScenario = s.scenarios[SC];
  SM.tlEra = 0;
  // 🔴 月日精度（2026-10-05）：时间轴游标真源是 `tlDate`（`{y,m,d}`）；
  //    `tlYear` 已是**只读 computed**（写它只会得到一条 Vue 警告，游标纹丝不动）。
  SM.tlDate = { y: 1050, m: null, d: null };
  SM.tlDiffMode = 'off';
  await tick(300);

  window.__LAST_TEXT_EXPORT__ = null;
  await SM.exportScenarioSVG();
  const rec = window.__LAST_TEXT_EXPORT__;
  if (!rec || !rec.text) return JSON.stringify({ fails: ['导出没有走到 saveTextFile（拿不到 SVG 文本）'] });
  const t = rec.text;

  ck('SVG 文档成型', t.startsWith('<?xml') && t.includes('</svg>'));
  // ① 势力名（此前 SVG 完全没有这一层）
  ck('导出图里有势力名「甲国」（旧实现：一个字都没有）', t.includes('甲国'), t.slice(0, 200));
  // ② 海域填充 + 虚线海界（与画布 SEA_FILL / SEA_EDGE 同源）
  ck('海域用 SEA_FILL 填充（水陆一眼可分）', t.includes('rgba(74, 118, 158, 0.42)'), null);
  ck('海界是虚线（stroke-dasharray）', t.includes('stroke-dasharray'));
  // ③ 多环：洞的环也进了 path（洞的起点坐标 200,200 必须在图里）
  ck('多环省份的洞也画出来了', t.includes('M 200 200'), null);
  // ④ evenodd：没有它，洞会被填实
  ck('fill-rule="evenodd" 在场（洞才真空）', t.includes('fill-rule="evenodd"'));
  ck('陆地省界仍在（实线 path）', (t.match(/<path /g) || []).length >= 3, (t.match(/<path /g) || []).length);

  return JSON.stringify({ fails, bytes: t.length });
})()"""


def sub_export_parity(cdp):
    expr = (EXPORT_JS.replace('__STORE__', STORE).replace('__SM__', SM).replace('__KEY__', json.dumps(KEY)))
    ok, res = eval_json(cdp, expr, desc='导出与画布同源')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        return False, '导出同源断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8])
    return True, ('SVG 里有势力名 + 海域 SEA_FILL + 虚线海界 + 多环洞 + evenodd '
                  f'（{res.get("bytes")} 字节）')


# ══════════════════════════════════════════════════════════════════
# f4 省份属性面板：值从事件来、写走 store、undo 真能还原
# ══════════════════════════════════════════════════════════════════
PANEL_JS = r"""(async () => {
  const fails = [];
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 150));
  const s = __STORE__;
  const SM = __SM__;
  const KEY = __KEY__;

  // 前置：环省正在面板里（f3 已把它选中过；这里显式重选，避免依赖上一步状态）
  const prov = (s.baseMaps[KEY].terrain || []).find(p => p.id === 'p77ring');
  if (!prov) return JSON.stringify({ fails: ['前置失败：环省不在 terrain 里'] });
  prov.biome = 'grassland';
  SM.selectedProvince = prov;
  SM.showProps = true;
  await tick(300);

  const sel = document.querySelector('.province-props select');
  if (!sel) return JSON.stringify({ fails: ['省份属性面板没有渲染出群系下拉'] });
  const before = s.baseMaps[KEY].terrain.find(p => p.id === 'p77ring').biome;
  sel.value = 'taiga';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await tick(250);
  const after = s.baseMaps[KEY].terrain.find(p => p.id === 'p77ring').biome;
  ck('下拉 change 真的落到 store', after === 'taiga', { before, after });

  s.undo();
  await tick(200);
  const undone = s.baseMaps[KEY].terrain.find(p => p.id === 'p77ring').biome;
  ck('undo 真能还原群系（旧实现 v-model 先污染 oldProv → 撤销空转）', undone === before, { before, undone });

  return JSON.stringify({ fails });
})()"""


def sub_panel_write_path(cdp):
    expr = (PANEL_JS.replace('__STORE__', STORE).replace('__SM__', SM).replace('__KEY__', json.dumps(KEY)))
    ok, res = eval_json(cdp, expr, desc='属性面板写路径')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        return False, '属性面板断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8])
    return True, '群系下拉 change → store 落值 → undo 真有还原（不是空转）'


def _enter_scenario_mode(cdp):
    """点「历史剧本」进入剧本模式。

    ⚠️ 为什么不是「查一次就点」（2026-10-05 实测踩到）：harness 的 `wait_for` 把
    `cdp.eval` 的 `{'__err__': …}` 当成**真值** —— 应用尚未挂载时表达式抛错会被当作
    「已就绪」，于是探针可能在「文档正在导航 / `#app` 还没 mount」的窗口里跑，
    症状就是 `no-btn`（与用例逻辑无关，且只在 harness 抖动时出现）。
    这里改成**轮询等按钮出现**（最多 ~10s），仍然没有才把现场带回去。
    """
    for _ in range(20):
        r = cdp.eval("""(() => {
          const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
          if (!app || !app._instance) return 'not-ready';
          const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('历史剧本'));
          if (!b) return 'no-btn';
          b.click(); return 'ok';
        })()""")
        if r == 'ok':
            return 'ok'
        if r == 'no-btn':
            break                     # 应用在跑但没有这个按钮 → 真异常，立刻带现场
        time.sleep(0.5)
    r = cdp.eval("""(() => {
      const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
      if (!app || !app._instance) return 'no-btn';
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('历史剧本'));
      if (!b) return 'no-btn';
      b.click(); return 'ok';
    })()""")
    if r == 'ok':
        return 'ok'
    # 查空时**带回现场**（本仓纪律）：只有 'no-btn' 是查不出原因的
    diag = cdp.eval("""(() => {
      const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__;
      const s = app && app._instance ? app._instance.setupState.store : null;
      return JSON.stringify({
        level: s ? s.viewLevel : null,
        nodes: s ? s.nodes.length : -1,
        hasSelector: !!document.querySelector('.world-selector'),
        buttons: Array.from(document.querySelectorAll('button')).slice(0, 14)
          .map(x => (x.textContent || '').trim().slice(0, 12)),
      });
    })()""")
    return f'{r} | 现场: {diag}'


def run(cdp):
    ensure_data_ready(cdp)
    r = _enter_scenario_mode(cdp)
    if r != 'ok':
        return False, f'进入剧本模式失败: {r}'
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", desc='ScenarioMap 挂载', timeout=8)
    cdp.eval("window.confirm = () => true; window.prompt = (m, d) => d;")

    results = []
    for name, fn in (('f0 源码守卫', sub_source_guards),
                     ('f1 势力 CRUD', sub_polity_crud),
                     ('f2 删省级联', sub_province_cascade),
                     ('f3 导出与画布同源', sub_export_parity),
                     ('f4 属性面板写路径', sub_panel_write_path)):
        try:
            ok, detail = fn(cdp)
        except Exception as e:
            ok, detail = False, f'异常: {e}'
        results.append((name, ok, detail))

    failed = [f'{n}: {d}' for n, o, d in results if not o]
    if failed:
        return False, (f'剧本势力/省份/导出 {len(results) - len(failed)}/{len(results)} 子测试通过；失败：\n    '
                       + '\n    '.join(failed))
    return True, ('剧本势力/省份/导出 ' + f'{len(results)}/{len(results)} 全通过 — '
                  + '；'.join(d for _, _, d in results))
