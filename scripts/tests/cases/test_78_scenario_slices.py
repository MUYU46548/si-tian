#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 78：历史剧本「逐年切片导出 + 易主日期录入」

来源：2026-10-01 收尾时明确留下的未做项 ——
  ① `buildScenarioSVG` 只认注入的 `currentEra`/`currentYear` 两个 ref → 想导「另一年」只能
     先挪时间轴游标再导（批量出帧会边导边动用户的时间轴）；
  ② 保存通道**一次调用弹一个模态框** → 11 帧 = 用户按 11 次「保存」；
  ③ 缺「变化年索引」：真实数据 12 剧本 / 3488 年，按年出帧没人要，按「状态真的变了」才十张出头；
  ④ 🔴 **日期可信度**：`computeEraChanges` 在缺显式值时会在本剧本区间内**均匀铺开**一个合成年份
     （看起来很像真的），真实库显式条目 = 0 —— 切片可以很漂亮，同时日期是编的。
     而且当时的录入 UI **不校验区间**，越界年份照写。

本用例覆盖：
  f0 源码守卫：切片判定单源（`utils/scenarioSlices.js`）、导出链接上它、主进程批量落盘 IPC 三处
     （index.js / preload / handler）齐备、面板不再自己写区间比较、批量写走 store 一条 undo。
  f1 帧索引与逐帧内容：同一份数据 → 帧 = 剧本起点 + 每次易主（同日合并）；**不同日期的 SVG 内容
     必须真的不同**（参数化生效的正面证据）；manifest 的日期序 / 日期统计对得上。
  f2 批量落盘载荷：点「导出 N 帧」→ 走 `exportScenarioFrames`（mock 累积记录）→ SVG 模式与
     PNG 模式各一次，文件数 / 命名 / dataURL 前缀 / manifest.format 都断言。
  f3 日期录入：面板区间外的日期**写不进去且输入框退回原值**（回执点名原因）、批量「统一设为该日」
     = **一条 undo**（undo 后两个省一起还原）、「固化推算值」把合成值变显式、「全部清空」回到推算。
  f4 切片点书签帧（2026-10-05 新增）：`store.addSlicePoint` 建的书签**默认必出帧**、`sources`
     含 `bookmark`、`label` 是给的名字；书签落在易主同一天时**只出一帧**且两个来源标记都在；
     `removeSlicePoint` 后该帧消失、**一条 undo** 把删除撤回（帧回来）。
  f5 月日精度（2026-10-05 新增）：`setChangeEvents` 写入 2015-06-01 → `byProvince` 的 m/d 是 6/1；
     `currentOwnerRef(tl,1,pid,{y:2015,m:5,d:31})` 是**旧主**、`{y:2015,m:6,d:1}` 是**新主**；
     越界日期（1899-01-01）被拒（`success:false`）且库里一个字节没动。

⚠️ 2026-10-05 破坏性数据模型变更：`changeYears[pid] = 1993`（年单值）→
   `changeEvents[pid] = [{y,m,d,owner}, …]`（按日期升序，`m`/`d` 可为 null = 该年 1 月 1 日）。
   本用例全部断言按新模型写；帧名从 `_2000` 变成 `_20000000`（月日缺省补 00）。
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
KEY = '用例78底图'


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

    sl = _code_only(_read('src/renderer/src/utils/scenarioSlices.js'))
    for sym in ['export function collectSliceFrames', 'export function changeDateStats',
                'export function validateChangeDate', 'export function validateChangeDateInRange',
                'export function sliceFrameName',
                'export const MAX_SLICE_FRAMES']:
        if sym not in sl:
            bad.append(f'utils/scenarioSlices.js 缺少 {sym}')

    ex = _code_only(_read('src/renderer/src/composables/useScenarioExport.js'))
    sm = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
    if "from '../utils/scenarioSlices'" not in ex:
        bad.append('导出链没引 scenarioSlices（帧索引会变成第二份实现）')
    for sym in ['collectSliceFrames', 'changeDateStats', 'sliceFrameName']:
        if sym not in ex:
            bad.append(f'导出链没接 {sym}')
    if 'Number.isInteger(era)' not in ex:
        bad.append('buildScenarioSVG 没有参数化 era（只能导"当前那一帧"）')
    for fn in ['function buildSliceFrames', 'function exportSliceFrames']:
        if fn not in ex:
            bad.append(f'导出链缺少 {fn}')
    exported = ex.split('return {')[-1]
    for fn in ['buildSliceFrames', 'exportSliceFrames']:
        if fn not in exported:
            bad.append(f'{fn} 没导出到 composable 返回值（组件拿不到）')

    if 'data-testid="open-slice-export"' not in sm:
        bad.append('工具栏缺切片导出入口（data-testid="open-slice-export"）')
    if 'exportSliceFrames' not in sm:
        bad.append('ScenarioMap 没接 exportSliceFrames')
    if 'scenario-slice-export' not in sm:
        bad.append('ScenarioMap 没挂载切片导出对话框')

    # 日期录入的判定必须来自单源，不许在组件里再写一遍区间比较
    lp = _code_only(_read('src/renderer/src/components/ScenarioLineagePanel.vue'))
    if "from '../utils/scenarioSlices'" not in lp or 'validateChangeDateInRange' not in lp:
        bad.append('易主日期面板没走 validateChangeDateInRange（区间判定会变成两份）')
    if re.search(r'years\[\s*(props\.)?currentEra\s*\]\.start', lp):
        bad.append('面板又自己写了一遍区间比较（应只走 validateChangeDateInRange）')
    if 'set-change-dates-bulk' not in lp or 'slp-cy-bulk-set' not in lp:
        bad.append('面板缺批量设置易主日期的入口')

    se = _code_only(_read('src/renderer/src/store/geodataModules/scenarioEditing.js'))
    if 'function setChangeEventsBulk' not in se:
        bad.append('store 缺少批量写易主日期的 setChangeEventsBulk')
    if 'setChangeEventsBulk' not in se.split('return {')[-1]:
        bad.append('setChangeEventsBulk 没导出到 store 壳')
    # 旧名单入口必须已删除（留着就是第二条写路径，月日会在这条上静默丢掉）
    if re.search(r'\bfunction setChangeYears\b', se):
        bad.append('store 里还留着旧的 setChangeYears（写路径必须单源）')
    seg = se[se.find('function setChangeEventsBulk'):se.find('function setChangeEventsBulk') + 3600]
    if 'execute(' not in seg:
        bad.append('setChangeEventsBulk 没走 execute（一条 undo 是它的存在理由）')

    # 主进程批量落盘：三处必须齐备（handler / IPC / preload）
    h = _read('src/main/handlers/exportFramesHandler.js')
    if 'async function writeFrames' not in h or 'module.exports' not in h:
        bad.append('缺少 handlers/exportFramesHandler.js 的 writeFrames')
    if "require('electron')" in h:
        bad.append('exportFramesHandler 顶层 require 了 electron（Node 单测就覆盖不到了）')
    mi = _read('src/main/index.js')
    if "ipcMain.handle('export-scenario-frames'" not in mi:
        bad.append('主进程缺少 export-scenario-frames 通道')
    if "require('./handlers/exportFramesHandler')" not in mi:
        bad.append('主进程没有接线 exportFramesHandler')
    pl = _read('src/preload/index.js')
    if 'exportScenarioFrames' not in pl:
        bad.append('preload 没暴露 exportScenarioFrames')
    rt = _read('scripts/tests/run_tests.py')
    if 'exportScenarioFrames' not in rt:
        bad.append('harness mock 缺 exportScenarioFrames（用例里会 TypeError）')

    if bad:
        return False, '源码守卫失败：' + '；'.join(bad)
    return True, ('切片判定单源 + 导出链参数化并接线 + 主进程批量落盘三处齐备 + '
                  '面板走同一份区间判定 + store 批量写一条 undo')


# ══════════════════════════════════════════════════════════════════
# 公共造数：甲 2000~2010 占 prov_a；乙 2010~2020 新增 prov_b/prov_c（两省易主 → 4 帧）
# ══════════════════════════════════════════════════════════════════
SEED_JS = r"""
  for (const k of Object.keys(s.scenarios)) s.removeScenario(k);
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: KEY });
  s.baseMaps[KEY].terrain.length = 0;
  const mk = (id, name, x0) => ({ id, name, kind: 'land',
    points: [{x:x0,y:100},{x:x0+140,y:100},{x:x0+140,y:300},{x:x0,y:300}] });
  s.addBaseProvince(KEY, mk('p78a', '甲省', 100));
  s.addBaseProvince(KEY, mk('p78b', '乙省', 300));
  s.addBaseProvince(KEY, mk('p78c', '丙省', 500));
  s.createScenario(KEY + '/甲时代', { ownerKey: KEY, name: '甲时代', order: 1,
    era: { roman: 'Ⅰ', label: '甲', startYear: '2000', endYear: '2010' },
    polities: [{ id: 'A1', name: '甲国', color: '#c23b3b' }],
    ownership: { p78a: 'A1' } });
  s.createScenario(KEY + '/乙时代', { ownerKey: KEY, name: '乙时代', order: 2,
    era: { roman: 'Ⅱ', label: '乙', startYear: '2010', endYear: '2020' },
    polities: [{ id: 'B1', name: '乙国', color: '#4a90d9' }, { id: 'B2', name: '乙南', color: '#e6a23c' },
               { id: 'B3', name: '乙东', color: '#3ba55d' }],
    ownership: { p78a: 'B1', p78b: 'B2', p78c: 'B3' } });
  window.__FRAMES_EXPORTS__ = [];
"""


def _seed_and_cursor(era=1, year=2010):
    """造数 + 把时间轴游标钉到指定剧本。

    ⚠️ ScenarioMap 挂载时除了立刻 `resetTimelineToStart()`，还有一发
    `setTimeout(resetTimelineToStart, 300)`（等 scenarios.json 异步载入）—— 挂载后 300ms 内
    设的游标会被它**悄悄重置回第 0 个剧本**（实测：探针里 era 读到 0、year 读到 2000）。
    所以顺序必须是：造数 → 等过 300ms → 再设游标。

    🔴 2026-10-05：游标真源是 `SM.tlDate`（`{y,m,d}`）。`SM.tlYear` 现在是**只读 computed**
    （`dateToYearValue(tlDate)`）—— 写它只会得到一条 Vue 警告、游标纹丝不动（旧写法会静默
    停在 2000 年而用例照样"过"，因为它的断言只看 `tlEra`）。
    """
    return (SEED_JS.replace('__STORE__', STORE).replace('__KEY__', json.dumps(KEY))
            + f"""
  await tick(500);                       // 等过挂载后那发 300ms 的游标重置
  SM.baseMapKey = KEY;
  if (typeof SM.onBaseMapChange === 'function') SM.onBaseMapChange();
  await tick(250);
  SM.tlDate = {{ y: {year}, m: null, d: null }};
  SM.tlEra = {era};
  await tick(300);
  if (SM.tlEra !== {era}) fails.push('前置失败：时间轴游标没停在剧本 {era}（实际 ' + SM.tlEra + '）');
  if (SM.tlDate.y !== {year}) fails.push('前置失败：游标年份不是 {year}（实际 ' + SM.tlDate.y + '）');
""")


# ══════════════════════════════════════════════════════════════════
# f1 帧索引 + 逐帧内容（参数化生效的正面证据）
# ══════════════════════════════════════════════════════════════════
FRAMES_JS = r"""(async () => {
  const fails = [];
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 150));
  const s = __STORE__, SM = __SM__;
  const KEY = __KEY__;
  __SEED__
  SM.tlDiffMode = 'off';
  SM.selectedScenario = s.scenarios[KEY + '/乙时代'];
  SM.showSliceExport = true;
  await tick(400);

  const panel = document.querySelector('[data-testid="slice-export-panel"]');
  if (!panel) return JSON.stringify({ fails: ['切片导出对话框没渲染（showSliceExport 无效？）'] });

  // —— 帧索引：起点帧（2000/2010）+ 两次易主（合成值 2013 / 2017）——
  // 月日精度后日期列是 `formatDate(f.date)`：只到年的日期显示 '2000'（**不**谎报 2000-01-01）
  const rows = Array.from(panel.querySelectorAll('[data-testid="slice-frame-list"] tbody tr'));
  const texts = rows.map(tr => tr.querySelectorAll('td')[1].textContent.trim());
  const years = texts.map(t => Number(t));
  ck('对话框列出 4 帧（2 个剧本起点 + 2 次易主）', years.length === 4, texts);
  ck('帧按日期升序', years.join() === years.slice().sort((a, b) => a - b).join(), texts);
  ck('首帧 = 第一个剧本的起点年', years[0] === 2000, texts);
  ck('第二个起点帧在列', years[1] === 2010, texts);
  ck('只到年的日期列不谎报 1 月 1 日（显示 2000 而非 2000-01-01）', texts[0] === '2000', texts[0]);
  ck('帧数角标与列表一致',
     Number(panel.querySelector('[data-testid="slice-frame-count"]').textContent.trim()) === years.length);
  ck('日期体检：两个易主日期都是合成值（真实库当前形态）',
     !!panel.querySelector('[data-testid="slice-date-warn"]'));
  ck('没有显式日期时不显示"全部显式"绿条', !panel.querySelector('[data-testid="slice-date-ok"]'));

  SM.showSliceExport = false;
  return JSON.stringify({ fails, years });
})()"""


def sub_frames(cdp):
    expr = (FRAMES_JS.replace('__STORE__', STORE).replace('__SM__', SM)
            .replace('__KEY__', json.dumps(KEY)).replace('__SEED__', _seed_and_cursor()))
    ok, res = eval_json(cdp, expr, desc='切片帧索引')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        return False, '帧索引断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8])
    return True, f'对话框列出 {res.get("years")} 四帧，日期体检提示合成值'


# ══════════════════════════════════════════════════════════════════
# f2 批量落盘载荷（真点按钮 → mock 记录整批）
# ══════════════════════════════════════════════════════════════════
EXPORT_JS = r"""(async () => {
  const fails = [];
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 150));
  const s = __STORE__, SM = __SM__;
  const KEY = __KEY__;
  const SC2 = KEY + '/乙时代';
  __SEED__
  SM.tlDiffMode = 'off';
  SM.selectedScenario = s.scenarios[SC2];
  SM.showSliceExport = true;
  await tick(400);

  // 先把两个省的易主**日期**录成显式值：2015（丙省）/ 2012（乙省）
  // → 帧 = 2000 / 2010 / 2012 / 2015
  // 🔴 月日精度：patch 值是日期对象（`{y,m,d}`）；这里只给年（m/d 缺省 = 1 月 1 日）。
  //    owner 一起给 —— 它是「这一天归谁」的显式记录（不给就会退化成"无主事件"）。
  s.setChangeEventsBulk(SC2, {
    p78c: { y: 2015, m: null, d: null, owner: 'B3' },
    p78b: { y: 2012, m: null, d: null, owner: 'B2' },
  });
  await tick(250);

  const panel = () => document.querySelector('[data-testid="slice-export-panel"]');
  ck('录入显式日期后不再提示全合成', !panel().querySelector('[data-testid="slice-date-warn"]'));
  ck('显示"全部显式"绿条', !!panel().querySelector('[data-testid="slice-date-ok"]'));

  // ① SVG 模式
  window.__FRAMES_EXPORTS__ = [];
  panel().querySelector('[data-testid="slice-export-run"]').click();
  await tick(900);
  const rec = (window.__FRAMES_EXPORTS__ || [])[0];
  if (!rec) return JSON.stringify({ fails: ['导出没走到 exportScenarioFrames（拿不到载荷）'] });
  const files = rec.files || [];
  ck('SVG 模式文件数 = 帧数 4', files.length === 4, files.length);
  // 帧名的日期段 = `dateToken`：年月日补零、月日缺省补 **00**（不是 01 —— 要如实反映"只到年"）
  ck('帧文件名确定性且带年月日（2000 → 20000000）',
     /^frame_0001_era00_20000000\.svg$/.test(files[0].name), files[0].name);
  ck('最后一帧是显式日期那帧（2015 → 20150000）', /20150000\.svg$/.test(files[3].name), files[3].name);
  ck('帧文件名里没有 `-`（负数年与路径分隔符都安全）',
     files.every(f => f.name.indexOf('-') < 0), files.map(f => f.name));
  ck('每帧都是完整 SVG 文档', files.every(f => typeof f.text === 'string'
     && f.text.indexOf('<?xml') === 0 && f.text.indexOf('</svg>') > 0));
  ck('不同日期的图**真的不同**（参数化生效）', files[0].text !== files[3].text);
  ck('首帧用甲国的配色', files[0].text.indexOf('#c23b3b') >= 0, '甲国色缺失');
  ck('末帧用乙东的配色', files[3].text.indexOf('#3ba55d') >= 0, '乙东色缺失');
  ck('manifest 帧序年份 = 2000/2010/2012/2015',
     JSON.stringify((rec.manifest.frames || []).map(f => f.year)) === '[2000,2010,2012,2015]',
     (rec.manifest.frames || []).map(f => f.year));
  ck('manifest 每帧带 date 对象（月日精度：年份不够用了）',
     (rec.manifest.frames || []).every(f => f.date && typeof f.date.y === 'number'
       && 'm' in f.date && 'd' in f.date),
     (rec.manifest.frames || []).map(f => f.date));
  ck('manifest 每帧带 dateText 与 sources',
     (rec.manifest.frames || []).every(f => typeof f.dateText === 'string'
       && Array.isArray(f.sources) && f.sources.length > 0),
     (rec.manifest.frames || []).map(f => ({ t: f.dateText, s: f.sources })));
  ck('manifest 记下日期统计（2 显式 / 0 合成）',
     rec.manifest.dateStats.explicit === 2 && rec.manifest.dateStats.synthesized === 0,
     rec.manifest.dateStats);
  ck('manifest 里有易主省份名（交 ffmpeg 做字幕要用）',
     (rec.manifest.frames[3].changedNames || []).indexOf('丙省') >= 0,
     rec.manifest.frames[3].changedNames);
  ck('manifest 给出帧尺寸', rec.manifest.frameSize && rec.manifest.frameSize.width > 0,
     rec.manifest.frameSize);
  ck('导出目录名带剧本名与**日期**跨度（跨代批次不能只写一个剧本名）',
     String(rec.dirName).indexOf('甲时代') >= 0
     && String(rec.dirName).indexOf('20000000_20150000') >= 0,
     rec.dirName);

  // ② PNG 模式
  const pngBox = panel().querySelector('[data-testid="slice-format-png"]');
  pngBox.click();
  await tick(200);
  window.__FRAMES_EXPORTS__ = [];
  panel().querySelector('[data-testid="slice-export-run"]').click();
  await tick(2500);
  const rec2 = (window.__FRAMES_EXPORTS__ || [])[0];
  if (!rec2) return JSON.stringify({ fails: fails.concat(['PNG 模式没走到 exportScenarioFrames']) });
  ck('PNG 模式文件数 = 帧数', (rec2.files || []).length === 4, (rec2.files || []).length);
  ck('PNG 帧是 dataURL', /^data:image\/png;base64,/.test(rec2.files[0].dataUrl || ''), 
     String(rec2.files[0].dataUrl).slice(0, 24));
  ck('PNG 帧没有 text 字段（两者只能有一个）', rec2.files[0].text === undefined);
  ck('manifest.format = png', rec2.manifest.format === 'png', rec2.manifest.format);
  ck('状态回执可见（对话框里给结论）',
     String(panel().querySelector('[data-testid="slice-status"]').textContent || '').length > 0);

  SM.showSliceExport = false;
  return JSON.stringify({ fails, names: files.map(f => f.name) });
})()"""


def sub_export(cdp):
    expr = (EXPORT_JS.replace('__STORE__', STORE).replace('__SM__', SM)
            .replace('__KEY__', json.dumps(KEY)).replace('__SEED__', _seed_and_cursor()))
    ok, res = eval_json(cdp, expr, desc='切片批量落盘载荷')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        return False, '落盘载荷断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8])
    return True, f'SVG/PNG 两模式各 4 帧，命名 {res.get("names")[0]} … {res.get("names")[-1]}'


# ══════════════════════════════════════════════════════════════════
# f3 日期录入（越界拒 + 批量一条 undo）
# ══════════════════════════════════════════════════════════════════
ENTRY_JS = r"""(async () => {
  const fails = [];
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 200));
  const s = __STORE__, SM = __SM__;
  const KEY = __KEY__;
  const SC2 = KEY + '/乙时代';
  __SEED__
  SM.selectedScenario = s.scenarios[SC2];
  SM.showLineagePanel = true;
  await tick(400);

  const dlg = document.querySelector('[data-testid="lineage-panel"]');
  if (!dlg) return JSON.stringify({ fails: ['谱系面板没渲染'] });
  dlg.querySelector('[data-testid="slp-tab-years"]').click();
  await tick(250);
  // 🔴 `changeEvents` 不在剧本默认形状里（没写过就没有这个键）→ 一律走这个取值口
  const cyOf = () => (s.scenarios[SC2].changeEvents || {});
  const evOf = (pid) => (cyOf()[pid] || []);

  const stat = dlg.querySelector('[data-testid="slp-cy-stat"]');
  ck('面板给出录入进度统计', !!stat && /2/.test(stat.textContent) && /区间\s*2010\s*~\s*2020/.test(stat.textContent),
     stat ? stat.textContent.replace(/\s+/g, ' ').trim() : null);

  // ① 区间外日期：写不进去 + 输入框退回原值 + 回执点名原因
  const input = dlg.querySelector('[data-testid="slp-cy-p78b"]');
  if (!input) {
    // 查空时带回现场（本仓纪律：不许就地抛异常，也不许只报"没找到"）
    const ids = Array.from(dlg.querySelectorAll('[data-testid]')).map(e => e.getAttribute('data-testid'));
    fails.push('易主日期页缺 p78b 的行');
    return JSON.stringify({ fails, diag: {
      era: SM.tlEra, date: SM.tlDate, changed: SM.timeline.eraChg[1] ? SM.timeline.eraChg[1].changed : null,
      ids: ids, inputs: dlg.querySelectorAll('input').length,
      rows: dlg.querySelectorAll('tbody tr').length,
      hasStat: !!dlg.querySelector('[data-testid="slp-cy-stat"]'),
    } });
  }
  const beforeYear = input.value;
  input.value = '1999';
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await tick(250);
  ck('区间外日期**没有**写进 store', cyOf().p78b === undefined, cyOf());
  ck('输入框退回显示库里那个值（不留脏值骗人）', input.value === beforeYear, { beforeYear, now: input.value });
  ck('越界有可见回音（状态栏）', String(SM.provinceHint || '').indexOf('2010') >= 0, SM.provinceHint);

  // ② 区间内年份：正常写入（`m`/`d` 缺省 = 只到年）
  input.value = '2014';
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await tick(250);
  ck('区间内年份写入成功', evOf('p78b').length === 1 && evOf('p78b')[0].y === 2014, cyOf());
  ck('只写年 → 月/日为 null（语义 = 该年 1 月 1 日，不许补成 1-1 假精确）',
     evOf('p78b')[0].m === null && evOf('p78b')[0].d === null, evOf('p78b'));

  // ②' 月/日三格：同一个省的日期可以精确到月日（月日精度是这轮的新能力）
  const mIn = dlg.querySelector('[data-testid="slp-cym-p78b"]');
  const dIn = dlg.querySelector('[data-testid="slp-cyd-p78b"]');
  const eff = () => dlg.querySelector('[data-testid="slp-cyeff-p78b"]');
  ck('面板有月/日输入格（月日精度的落点）', !!mIn && !!dIn);
  mIn.value = '7';
  mIn.dispatchEvent(new Event('change', { bubbles: true }));
  await tick(250);
  ck('写月成功（2014-07）', evOf('p78b')[0].m === 7 && evOf('p78b')[0].y === 2014, evOf('p78b'));
  ck('生效文本显示到月（2014-07）', !!eff() && eff().textContent.trim() === '2014-07',
     eff() ? eff().textContent.trim() : null);
  dIn.value = '15';
  dIn.dispatchEvent(new Event('change', { bubbles: true }));
  await tick(250);
  ck('写日成功（2014-07-15）', evOf('p78b')[0].d === 15 && evOf('p78b')[0].m === 7, evOf('p78b'));
  ck('生效文本显示到日（2014-07-15）', !!eff() && eff().textContent.trim() === '2014-07-15',
     eff() ? eff().textContent.trim() : null);

  // ③ 批量「统一设为该日」：一条 undo 覆盖两个省
  const bulkInput = dlg.querySelector('[data-testid="slp-cy-bulk-input"]');
  const bulkBtn = dlg.querySelector('[data-testid="slp-cy-bulk-set"]');
  bulkInput.value = '2016';
  bulkInput.dispatchEvent(new Event('input', { bubbles: true }));
  await tick(200);
  ck('批量按钮在日期合法时可用', !bulkBtn.disabled);
  bulkBtn.click();
  await tick(300);
  ck('两个省的日期都被统一设为 2016',
     evOf('p78b').length === 1 && evOf('p78b')[0].y === 2016
     && evOf('p78c').length === 1 && evOf('p78c')[0].y === 2016, cyOf());

  s.undo();
  await tick(250);
  ck('**一条** undo 把两个省一起还原（p78b 回 2014-07-15、p78c 回无显式值）',
     evOf('p78b').length === 1 && evOf('p78b')[0].y === 2014
     && evOf('p78b')[0].m === 7 && evOf('p78b')[0].d === 15
     && cyOf().p78c === undefined, cyOf());
  s.redo();
  await tick(200);
  ck('redo 再次统一', evOf('p78b')[0].y === 2016 && evOf('p78c')[0].y === 2016, cyOf());

  // ④ 全部清空 → 回到自动推算
  dlg.querySelector('[data-testid="slp-cy-bulk-clear"]').click();
  await tick(300);
  ck('全部清空后两个省的显式日期都没了', Object.keys(cyOf()).length === 0, cyOf());

  // ⑤ 固化推算值：把合成值写成显式（两个省都在区间内）
  const synth = {};
  for (const pid of ['p78b', 'p78c']) synth[pid] = SM.timeline.eraChg[1].lastDate[pid];
  dlg.querySelector('[data-testid="slp-cy-bulk-snap"]').click();
  await tick(300);
  const cy = cyOf();
  ck('固化推算值把两个省都写成显式',
     !!cy.p78b && !!cy.p78c
     && cy.p78b[0].y === synth.p78b.y && (cy.p78b[0].m ?? null) === (synth.p78b.m ?? null)
     && cy.p78c[0].y === synth.p78c.y, { cy, synth });
  ck('固化后日期体检显示 0 合成（切片不再有"编的日期"）',
     cy.p78c !== undefined && cy.p78b !== undefined, cy);

  SM.showLineagePanel = false;
  await tick(200);
  return JSON.stringify({ fails, progress: stat ? stat.textContent.replace(/\s+/g, ' ').trim() : '' });
})()"""


def sub_entry(cdp):
    expr = (ENTRY_JS.replace('__STORE__', STORE).replace('__SM__', SM)
            .replace('__KEY__', json.dumps(KEY)).replace('__SEED__', _seed_and_cursor()))
    ok, res = eval_json(cdp, expr, desc='易主日期录入')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        extra = f' 现场：{json.dumps(res.get("diag"), ensure_ascii=False)}' if res.get('diag') else ''
        return False, '日期录入断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8]) + extra
    return True, f'越界拒+退值、批量一条 undo、固化/清空都对：{res.get("progress")}'


# ══════════════════════════════════════════════════════════════════
# f4 切片点书签帧（2026-10-05 新增）
#   帧索引走**产品自己的纯函数**（`await import('/src/utils/scenarioSlices.js')`）——
#   用例里重写一份「哪些日期出帧」= 同义反复，判定错了照样绿（本仓纪律）。
# ══════════════════════════════════════════════════════════════════
BOOKMARK_JS = r"""(async () => {
  const fails = [];
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 200));
  const s = __STORE__, SM = __SM__;
  const KEY = __KEY__;
  const SC2 = KEY + '/乙时代';
  __SEED__
  const SL = await import('/src/utils/scenarioSlices.js');

  // 步骤隔离：清掉可能残留的书签
  for (const p of (s.slicePoints || []).slice()) s.removeSlicePoint(p.id);
  await tick(200);

  // 一个易主日（2015-06-01，显式）+ 三个切片点：一个落在**同一天**、两个落在别处
  const w = s.setChangeEvents(SC2, 'p78b', [{ y: 2015, m: 6, d: 1, owner: 'B2' }]);
  ck('前置：显式易主日期写入成功', !!(w && w.success === true), w);
  const spA = s.addSlicePoint({ y: 2015, m: 6, d: 1 }, '会战');    // 与易主**同一天**
  const spB = s.addSlicePoint({ y: 2016, m: 3, d: 15 }, '春分');
  const spC = s.addSlicePoint({ y: 2014, m: 1, d: 1 }, '元旦');
  await tick(300);
  ck('三个切片点都建好了', (s.slicePoints || []).length === 3 && !!spA.id && !!spB.id && !!spC.id,
     (s.slicePoints || []).map(p => p.label));

  const model = SL.collectSliceFrames(SM.timeline, s.slicePoints);
  const frames = model.frames || [];
  const at = (key) => frames.find(f => f.dateKey === key);
  ck('全部帧都带日期键与日期对象（月日精度）',
     frames.length > 0 && frames.every(f => !!f.dateKey && !!f.date && typeof f.date.y === 'number'),
     frames.map(f => f.dateKey));

  // ① 书签帧默认必出，且来源/名字都对
  ck('切片点帧 2016-03-15 在帧里（书签默认必出）', !!at('2016-03-15'), frames.map(f => f.dateKey));
  ck('书签帧的 sources 含 bookmark',
     !!at('2016-03-15') && at('2016-03-15').sources.indexOf('bookmark') >= 0,
     at('2016-03-15') ? at('2016-03-15').sources : null);
  ck('书签帧的 label 是给它的名字（春分）',
     !!at('2016-03-15') && at('2016-03-15').label === '春分',
     at('2016-03-15') ? at('2016-03-15').label : null);
  ck('第二个纯书签帧也在（2014-01-01 元旦）',
     !!at('2014-01-01') && at('2014-01-01').label === '元旦' && at('2014-01-01').kind === 'bookmark',
     at('2014-01-01') ? { label: at('2014-01-01').label, kind: at('2014-01-01').kind } : null);
  ck('书签计数 = 3', model.stats.bookmarkCount === 3, model.stats);

  // ② 书签落在易主同一天 → **只出一帧**，两个来源标记都在
  const sameDay = frames.filter(f => f.dateKey === '2015-06-01');
  ck('书签落在易主同一天时只出一帧', sameDay.length === 1, frames.map(f => f.dateKey));
  ck('合并帧的来源同时含 bookmark 与 change',
     sameDay.length === 1 && sameDay[0].sources.indexOf('bookmark') >= 0
     && sameDay[0].sources.indexOf('change') >= 0, sameDay.length ? sameDay[0].sources : null);
  ck('合并帧的 kind = change（有易主）', sameDay.length === 1 && sameDay[0].kind === 'change',
     sameDay.length ? sameDay[0].kind : null);
  ck('合并帧同时记下书签名与易主省', sameDay.length === 1
     && sameDay[0].label === '会战' && sameDay[0].changed.indexOf('p78b') >= 0,
     sameDay.length ? { label: sameDay[0].label, changed: sameDay[0].changed } : null);

  // ③ 删除书签 → 该帧消失；**一条 undo** 撤回删除（帧回来）
  const del = s.removeSlicePoint(spB.id);
  ck('删除切片点成功', !!(del && del.success === true), del);
  await tick(250);
  const after = SL.collectSliceFrames(SM.timeline, s.slicePoints).frames;
  ck('删掉书签后该帧消失', !after.some(f => f.dateKey === '2016-03-15'), after.map(f => f.dateKey));
  s.undo();
  await tick(250);
  const back = SL.collectSliceFrames(SM.timeline, s.slicePoints).frames;
  const backFrame = back.find(f => f.dateKey === '2016-03-15');
  ck('**一条** undo 把删除撤回（帧回来）', !!backFrame, back.map(f => f.dateKey));
  ck('撤回后名字也回来了（春分）', !!backFrame && backFrame.label === '春分',
     backFrame ? backFrame.label : null);
  s.redo();
  await tick(250);
  ck('重做再次删除该帧', !SL.collectSliceFrames(SM.timeline, s.slicePoints).frames
     .some(f => f.dateKey === '2016-03-15'));

  // ④ UI 同源：对话框帧表的日期必须与纯函数一致（书签帧在对话框里也默认必出）
  SM.showSliceExport = true;
  await tick(450);
  const panel = document.querySelector('[data-testid="slice-export-panel"]');
  if (!panel) return JSON.stringify({ fails: fails.concat(['切片导出对话框没渲染']) });
  const dates = Array.from(panel.querySelectorAll('[data-testid^="slice-frame-date-"]'))
    .map(el => el.textContent.trim());
  const countEl = panel.querySelector('[data-testid="slice-point-count"]');
  ck('对话框给出切片点计数角标（删掉一个后 = 2）', !!countEl && Number(countEl.textContent) === 2,
     countEl ? countEl.textContent : null);
  ck('本次删除已被重做 → 2016-03-15 不该在对话框里',
     dates.indexOf('2016-03-15') < 0, dates);
  ck('对话框帧表含 2015-06-01（同日合并只出现一次）',
     dates.filter(d => d === '2015-06-01').length === 1, dates);
  SM.showSliceExport = false;
  await tick(200);

  // 清理
  for (const p of (s.slicePoints || []).slice()) s.removeSlicePoint(p.id);
  await tick(150);
  return JSON.stringify({ fails, keys: back.map(f => f.dateKey) });
})()"""


def sub_bookmark_frames(cdp):
    expr = (BOOKMARK_JS.replace('__STORE__', STORE).replace('__SM__', SM)
            .replace('__KEY__', json.dumps(KEY)).replace('__SEED__', _seed_and_cursor()))
    ok, res = eval_json(cdp, expr, desc='切片点书签帧')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        return False, '书签帧断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8])
    return True, ('书签帧默认必出（label/sources 都对）、与易主同日合并成一帧、'
                  f'删除帧消失且一条 undo 撤回：{res.get("keys")}')


# ══════════════════════════════════════════════════════════════════
# f5 月日精度端到端（2026-10-05 新增）
#   夹具刻意造成「易主省的**旧主是有主的**」：甲代 A1 占 p78a+p78b，乙代 B1 占 p78b、B2 占 p78a
#   → 贪心继承把 B1 配给 A1（只在 p78b 上重叠），于是 p78a 是真正的易主省（旧主 A1 → 新主 B2）。
#   ⚠️ 若照抄「乙代多变出来的省上一代无人持有」那种形状，旧主是 undefined，
#      「5-31 是旧主」这条断言就退化成「不是新主」，抓不住「6 月前就改归新主」的缺陷。
# ══════════════════════════════════════════════════════════════════
MONTHDAY_JS = r"""(async () => {
  const fails = [];
  const ck = (l, c, x) => { if (!c) fails.push(l + (x !== undefined ? ' → ' + JSON.stringify(x) : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 200));
  const s = __STORE__, SM = __SM__;
  const KEY = __KEY__;
  const SC0 = KEY + '/甲时代', SC1 = KEY + '/乙时代';
  __SEED__
  const TL = await import('/src/utils/scenarioTimeline.js');
  const OWN = (tl, k, pid, at) => TL.currentOwnerRef(tl, k, pid, at).owner;

  // —— 专用夹具（见本节标题注释：旧主必须有主）——
  for (const k of Object.keys(s.scenarios)) s.removeScenario(k);
  s.createScenario(SC0, { ownerKey: KEY, name: '甲时代', order: 1,
    era: { roman: 'Ⅰ', label: '甲', startYear: '2000', endYear: '2010' },
    polities: [{ id: 'A1', name: '甲国', color: '#c23b3b' }],
    ownership: { p78a: 'A1', p78b: 'A1' } });
  s.createScenario(SC1, { ownerKey: KEY, name: '乙时代', order: 2,
    era: { roman: 'Ⅱ', label: '乙', startYear: '2010', endYear: '2020' },
    polities: [{ id: 'B1', name: '乙北', color: '#4a90d9' }, { id: 'B2', name: '乙南', color: '#e6a23c' }],
    ownership: { p78a: 'B2', p78b: 'B1' } });
  await tick(350);
  SM.tlDate = { y: 2015, m: null, d: null };
  SM.tlEra = 1;
  await tick(250);

  const e1 = SM.timeline.eraChg[1];
  ck('前置：乙代确实有易主省（changed 非空）', !!e1 && e1.changed.length > 0, e1 ? e1.changed : null);
  ck('前置：易主省是 p78a（p78b 被贪心继承判成同谱系，不参与易主）',
     !!e1 && e1.changed.indexOf('p78a') >= 0, e1 ? e1.changed : null);
  ck('前置：该省在乙代**有具体的旧主** A1（不是"无主"）',
     OWN(SM.timeline, 1, 'p78a', { y: 2011 }) === 'A1', OWN(SM.timeline, 1, 'p78a', { y: 2011 }));

  // —— 写入 2015-06-01 的显式易主 ——
  const w = s.setChangeEvents(SC1, 'p78a', [{ y: 2015, m: 6, d: 1, owner: 'B2' }]);
  ck('写入显式日期成功', !!(w && w.success === true), w);
  await tick(250);

  const ev = ((SM.timeline.eraChg[1] || {}).byProvince || {})['p78a'] || [];
  ck('事件进入时间轴模型（1 条）', ev.length === 1, ev);
  ck('🔴 byProvince 里的 m/d 是 6/1（月日真的被保留，没被截成年）',
     ev.length === 1 && ev[0].m === 6 && ev[0].d === 1, ev[0]);
  ck('标记为显式（不是合成值）', ev.length === 1 && ev[0].explicit === true, ev[0]);

  // —— 🔴 核心：同一剧本内 5-31 与 6-1 的归属相反 ——
  const tl = SM.timeline;
  const before = OWN(tl, 1, 'p78a', { y: 2015, m: 5, d: 31 });
  const after = OWN(tl, 1, 'p78a', { y: 2015, m: 6, d: 1 });
  ck('易主日**前**（5-31）仍是旧主 A1', before === 'A1', { before, after });
  ck('易主日**当天**（6-1）已是新主 B2', after === 'B2', { before, after });
  ck('易主日之后仍是新主', OWN(tl, 1, 'p78a', { y: 2015, m: 8, d: 1 }) === 'B2',
     OWN(tl, 1, 'p78a', { y: 2015, m: 8, d: 1 }));
  ck('只给年份 2015 = 1 月 1 日 → 仍算旧主（缺省口径与「只到年」一致）',
     OWN(tl, 1, 'p78a', { y: 2015 }) === 'A1', OWN(tl, 1, 'p78a', { y: 2015 }));

  // —— 越界日期：拒 + 零副作用 ——
  const snapshot = JSON.stringify(s.scenarios[SC1].changeEvents || {});
  const bad = s.setChangeEvents(SC1, 'p78a', [{ y: 1899, m: 1, d: 1, owner: 'B2' }]);
  await tick(200);
  ck('越界日期（1899-01-01 ∉ 2010~2020）被拒（success:false）', !!(bad && bad.success === false), bad);
  ck('拒绝时给出原因', !!(bad && bad.reason), bad);
  ck('🔴 被拒后库里**一个字节都没动**（零副作用）',
     JSON.stringify(s.scenarios[SC1].changeEvents || {}) === snapshot,
     { before: snapshot, after: JSON.stringify(s.scenarios[SC1].changeEvents || {}) });
  ck('越界日期也没混进时间轴模型（仍只有那 1 条显式事件）',
     (((SM.timeline.eraChg[1] || {}).byProvince || {})['p78a'] || []).length === 1,
     ((SM.timeline.eraChg[1] || {}).byProvince || {})['p78a']);
  ck('被拒后 5-31 依旧旧主、6-1 依旧新主（拒绝没有把已有数据弄坏）',
     OWN(SM.timeline, 1, 'p78a', { y: 2015, m: 5, d: 31 }) === 'A1'
     && OWN(SM.timeline, 1, 'p78a', { y: 2015, m: 6, d: 1 }) === 'B2');

  return JSON.stringify({ fails, ev });
})()"""


def sub_monthday(cdp):
    expr = (MONTHDAY_JS.replace('__STORE__', STORE).replace('__SM__', SM)
            .replace('__KEY__', json.dumps(KEY)).replace('__SEED__', _seed_and_cursor()))
    ok, res = eval_json(cdp, expr, desc='月日精度')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        return False, '月日精度断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8])
    return True, ('byProvince 保住 6/1、5-31 是旧主 A1 / 6-1 是新主 B2、'
                  f'越界 1899 被拒且零副作用（事件 {res.get("ev")}）')


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
    time.sleep(0.6)

    results = []
    for name, fn in (('f0 源码守卫', sub_source_guards),
                     ('f1 帧索引', sub_frames),
                     ('f2 批量落盘载荷', sub_export),
                     ('f3 日期录入', sub_entry),
                     ('f4 切片点书签帧', sub_bookmark_frames),
                     ('f5 月日精度', sub_monthday)):
        try:
            ok, detail = fn(cdp)
        except Exception as e:
            ok, detail = False, f'异常: {e}'
        results.append((name, ok, detail))

    failed = [f'{n}: {d}' for n, o, d in results if not o]
    if failed:
        return False, (f'逐年切片 {len(results) - len(failed)}/{len(results)} 子测试通过；失败：\n    '
                       + '\n    '.join(failed))
    return True, ('逐年切片 ' + f'{len(results)}/{len(results)} 全通过 — '
                  + '；'.join(d for _, _, d in results))
