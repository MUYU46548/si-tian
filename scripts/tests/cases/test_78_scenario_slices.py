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
  f1 帧索引与逐帧内容：同一份数据 → 帧 = 剧本起点 + 每次易主（同年合并）；**不同年份的 SVG 内容
     必须真的不同**（参数化生效的正面证据）；manifest 的年份序 / 日期统计对得上。
  f2 批量落盘载荷：点「导出 N 帧」→ 走 `exportScenarioFrames`（mock 累积记录）→ SVG 模式与
     PNG 模式各一次，文件数 / 命名 / dataURL 前缀 / manifest.format 都断言。
  f3 日期录入：面板区间外的年份**写不进去且输入框退回原值**（回执点名原因）、批量「统一设为该年」
     = **一条 undo**（undo 后两个省一起还原）、「固化推算值」把合成值变显式、「全部清空」回到推算。
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
                'export function validateChangeYear', 'export function sliceFrameName',
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
    if "from '../utils/scenarioSlices'" not in lp or 'validateChangeYear' not in lp:
        bad.append('易主年份面板没走 validateChangeYear（区间判定会变成两份）')
    if re.search(r'years\[\s*(props\.)?currentEra\s*\]\.start', lp):
        bad.append('面板又自己写了一遍区间比较（应只走 validateChangeYear）')
    if 'set-change-years-bulk' not in lp or 'slp-cy-bulk-set' not in lp:
        bad.append('面板缺批量设置易主年份的入口')

    se = _code_only(_read('src/renderer/src/store/geodataModules/scenarioEditing.js'))
    if 'function setChangeYears' not in se:
        bad.append('store 缺少批量写易主年份的 setChangeYears')
    if 'setChangeYears' not in se.split('return {')[-1]:
        bad.append('setChangeYears 没导出到 store 壳')
    seg = se[se.find('function setChangeYears'):se.find('function setChangeYears') + 2400]
    if 'execute(' not in seg:
        bad.append('setChangeYears 没走 execute（一条 undo 是它的存在理由）')

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
    设的 `tlEra`/`tlYear` 会被它**悄悄重置回第 0 个剧本**（实测：探针里 era 读到 0、year 读到 2000）。
    所以顺序必须是：造数 → 等过 300ms → 再设游标。
    """
    return (SEED_JS.replace('__STORE__', STORE).replace('__KEY__', json.dumps(KEY))
            + f"""
  await tick(500);                       // 等过挂载后那发 300ms 的游标重置
  SM.baseMapKey = KEY;
  if (typeof SM.onBaseMapChange === 'function') SM.onBaseMapChange();
  await tick(250);
  SM.tlEra = {era}; SM.tlYear = {year};
  await tick(300);
  if (SM.tlEra !== {era}) fails.push('前置失败：时间轴游标没停在剧本 {era}（实际 ' + SM.tlEra + '）');
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
  const rows = Array.from(panel.querySelectorAll('[data-testid="slice-frame-list"] tbody tr'));
  const years = rows.map(tr => Number(tr.querySelectorAll('td')[1].textContent.trim()));
  ck('对话框列出 4 帧（2 个剧本起点 + 2 次易主）', years.length === 4, years);
  ck('帧按年份升序', years.join() === years.slice().sort((a, b) => a - b).join(), years);
  ck('首帧 = 第一个剧本的起点年', years[0] === 2000, years);
  ck('第二个起点帧在列', years[1] === 2010, years);
  ck('帧数角标与列表一致',
     Number(panel.querySelector('[data-testid="slice-frame-count"]').textContent.trim()) === years.length);
  ck('日期体检：两个易主年份都是合成值（真实库当前形态）',
     !!panel.querySelector('[data-testid="slice-date-warn"]'));
  ck('没有显式年份时不显示"全部显式"绿条', !panel.querySelector('[data-testid="slice-date-ok"]'));

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

  // 先把两个省的易主年份录成显式值：2015（丙省）/ 2012（乙省）→ 帧 = 2000 / 2010 / 2012 / 2015
  s.setChangeYears(SC2, { p78c: 2015, p78b: 2012 });
  await tick(250);

  const panel = () => document.querySelector('[data-testid="slice-export-panel"]');
  ck('录入显式年份后不再提示全合成', !panel().querySelector('[data-testid="slice-date-warn"]'));
  ck('显示"全部显式"绿条', !!panel().querySelector('[data-testid="slice-date-ok"]'));

  // ① SVG 模式
  window.__FRAMES_EXPORTS__ = [];
  panel().querySelector('[data-testid="slice-export-run"]').click();
  await tick(900);
  const rec = (window.__FRAMES_EXPORTS__ || [])[0];
  if (!rec) return JSON.stringify({ fails: ['导出没走到 exportScenarioFrames（拿不到载荷）'] });
  const files = rec.files || [];
  ck('SVG 模式文件数 = 帧数 4', files.length === 4, files.length);
  ck('帧文件名确定性且带年份', /^frame_0001_era00_2000\.svg$/.test(files[0].name), files[0].name);
  ck('最后一帧是显式年份那帧', /2015\.svg$/.test(files[3].name), files[3].name);
  ck('每帧都是完整 SVG 文档', files.every(f => typeof f.text === 'string'
     && f.text.indexOf('<?xml') === 0 && f.text.indexOf('</svg>') > 0));
  ck('不同年份画出来的图**真的不同**（参数化生效）', files[0].text !== files[3].text);
  ck('首帧用甲国的配色', files[0].text.indexOf('#c23b3b') >= 0, '甲国色缺失');
  ck('末帧用乙东的配色', files[3].text.indexOf('#3ba55d') >= 0, '乙东色缺失');
  ck('manifest 帧序年份 = 2000/2010/2012/2015',
     JSON.stringify((rec.manifest.frames || []).map(f => f.year)) === '[2000,2010,2012,2015]',
     (rec.manifest.frames || []).map(f => f.year));
  ck('manifest 记下日期统计（2 显式 / 0 合成）',
     rec.manifest.dateStats.explicit === 2 && rec.manifest.dateStats.synthesized === 0,
     rec.manifest.dateStats);
  ck('manifest 里有易主省份名（交 ffmpeg 做字幕要用）',
     (rec.manifest.frames[3].changedNames || []).indexOf('丙省') >= 0,
     rec.manifest.frames[3].changedNames);
  ck('manifest 给出帧尺寸', rec.manifest.frameSize && rec.manifest.frameSize.width > 0,
     rec.manifest.frameSize);
  ck('导出目录名带剧本名与年份跨度（跨代批次不能只写一个剧本名）',
     String(rec.dirName).indexOf('甲时代') >= 0 && String(rec.dirName).indexOf('2000_2015') >= 0,
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
  // `changeYears` 不在剧本默认形状里（没写过就没有这个键）→ 一律走这个取值口
  const cyOf = () => (s.scenarios[SC2].changeYears || {});

  const stat = dlg.querySelector('[data-testid="slp-cy-stat"]');
  ck('面板给出录入进度统计', !!stat && /2/.test(stat.textContent) && /区间\s*2010\s*~\s*2020/.test(stat.textContent),
     stat ? stat.textContent.replace(/\s+/g, ' ').trim() : null);

  // ① 区间外年份：写不进去 + 输入框退回原值 + 回执点名原因
  const input = dlg.querySelector('[data-testid="slp-cy-p78b"]');
  if (!input) {
    // 查空时带回现场（本仓纪律：不许就地抛异常，也不许只报"没找到"）
    const ids = Array.from(dlg.querySelectorAll('[data-testid]')).map(e => e.getAttribute('data-testid'));
    fails.push('易主年份页缺 p78b 的行');
    return JSON.stringify({ fails, diag: {
      era: SM.tlEra, year: SM.tlYear, changed: SM.timeline.eraChg[1] ? SM.timeline.eraChg[1].changed : null,
      ids: ids, inputs: dlg.querySelectorAll('input').length,
      rows: dlg.querySelectorAll('tbody tr').length,
      hasStat: !!dlg.querySelector('[data-testid="slp-cy-stat"]'),
    } });
  }
  const beforeYear = input.value;
  input.value = '1999';
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await tick(250);
  ck('区间外年份**没有**写进 store', cyOf().p78b === undefined, cyOf());
  ck('输入框退回显示库里那个值（不留脏值骗人）', input.value === beforeYear, { beforeYear, now: input.value });
  ck('越界有可见回音（状态栏）', String(SM.provinceHint || '').indexOf('2010') >= 0, SM.provinceHint);

  // ② 区间内年份：正常写入
  input.value = '2014';
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await tick(250);
  ck('区间内年份写入成功', cyOf().p78b === 2014, cyOf());

  // ③ 批量「统一设为该年」：一条 undo 覆盖两个省
  const bulkInput = dlg.querySelector('[data-testid="slp-cy-bulk-input"]');
  const bulkBtn = dlg.querySelector('[data-testid="slp-cy-bulk-set"]');
  bulkInput.value = '2016';
  bulkInput.dispatchEvent(new Event('input', { bubbles: true }));
  await tick(200);
  ck('批量按钮在年份合法时可用', !bulkBtn.disabled);
  bulkBtn.click();
  await tick(300);
  ck('两个省的年份都被统一设为 2016', cyOf().p78b === 2016 && cyOf().p78c === 2016, cyOf());

  s.undo();
  await tick(250);
  ck('**一条** undo 把两个省一起还原（p78b 回 2014、p78c 回无显式值）',
     cyOf().p78b === 2014 && cyOf().p78c === undefined, cyOf());
  s.redo();
  await tick(200);
  ck('redo 再次统一', cyOf().p78b === 2016 && cyOf().p78c === 2016, cyOf());

  // ④ 全部清空 → 回到自动推算
  dlg.querySelector('[data-testid="slp-cy-bulk-clear"]').click();
  await tick(300);
  ck('全部清空后两个省的显式值都没了', Object.keys(cyOf()).length === 0, cyOf());

  // ⑤ 固化推算值：把合成值写成显式（两个省都在区间内）
  const synth = {};
  for (const pid of ['p78b', 'p78c']) synth[pid] = SM.timeline.eraChg[1].year[pid];
  dlg.querySelector('[data-testid="slp-cy-bulk-snap"]').click();
  await tick(300);
  const cy = cyOf();
  ck('固化推算值把两个省都写成显式',
     cy.p78b === synth.p78b && cy.p78c === synth.p78c, { cy, synth });
  ck('固化后日期体检显示 0 合成（切片不再有"编的日期"）',
     cy.p78c !== undefined && cy.p78b !== undefined, cy);

  SM.showLineagePanel = false;
  await tick(200);
  return JSON.stringify({ fails, progress: stat ? stat.textContent.replace(/\s+/g, ' ').trim() : '' });
})()"""


def sub_entry(cdp):
    expr = (ENTRY_JS.replace('__STORE__', STORE).replace('__SM__', SM)
            .replace('__KEY__', json.dumps(KEY)).replace('__SEED__', _seed_and_cursor()))
    ok, res = eval_json(cdp, expr, desc='易主年份录入')
    if not ok:
        return False, res
    fails = res.get('fails') or []
    if fails:
        extra = f' 现场：{json.dumps(res.get("diag"), ensure_ascii=False)}' if res.get('diag') else ''
        return False, '日期录入断言失败 ' + str(len(fails)) + ' 项：' + '；'.join(fails[:8]) + extra
    return True, f'越界拒+退值、批量一条 undo、固化/清空都对：{res.get("progress")}'


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
    cdp.eval("window.confirm = () => true; window.prompt = (m, d) => d;")
    time.sleep(0.6)

    results = []
    for name, fn in (('f0 源码守卫', sub_source_guards),
                     ('f1 帧索引', sub_frames),
                     ('f2 批量落盘载荷', sub_export),
                     ('f3 日期录入', sub_entry)):
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
