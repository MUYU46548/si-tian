#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 76：A-3 中文点选糙版 —— 行内类型下拉 + 只看空白过滤

来源：`docs/ROADMAP_NEXT.md` 线 A 第 4 步（A-3）＋ 2026-09-28 在线审查的三条补刀。
搬家线把「层级 / 上层挂靠 / 地点类型」收进 `.sitian` 之后，**笔记里本来就没写的空白只有这个
界面能填**（报告 ⑥：搬家后给新地点设类型的唯一入口）。

  🔴 实测前提（2026-09-29 拿真 ROSA 缓存跑的值域统计，= 补刀①②的依据）：
     · 已填 75 个全部落在 8 枚举内，**枚举外 0 个** —— 但手写笔记随时可能冒出第 9 种，兜底照做；
     · 类型空白 45 个里 **39 个是宇宙层**（world/star_domain/galaxy/planet，本就不携带该字段），
       聚落 5 个按约定不标 → 真正该填的只有 region/facility/location；
     · parentId 空 9 个里 4 个是 world（本来就该顶层）→ 真孤儿 5 个。
     不分层就过滤 = 用户点开「类型为空」看到 39 行无意义噪音（补刀②）。

本用例覆盖：
  f0 源码守卫：枚举 / 层级 / 选项 / 过滤**单源**在 utils/placeTypes.js（三处组件不许再抄一份
     `['自然', …]`）；行内改类型只走 `proj.updateEntity`（undo + 落 .sitian，不许直接改内存）；
     下拉与过滤器在只读态灰禁且带原因。
  f1 端到端：行内下拉选项 = 8 枚举；**枚举外值「秘境」保留在选项里且被显示出来**（补刀①）→
     真实 change 事件 → 项目实体落值 + 同步画布 + 回执写明「写进 .sitian」→ undo/redo 各一步 →
     **保存载荷里带着 placeType**（落进 .sitian 的等价断言，mock 环境落点 = window.__projects）→
     清空路径同样同步。
  f2 过滤：期望集合在测试里**独立重算**（不 import 被测的 matchesGap —— 那是同义反复）：
     type 只显示地点层级的类型空白且**宇宙层不出现**；parent 只显示非 world 的孤儿且 **world 不出现**；
     any = 并集；all 恢复整树；选项计数与计数条和独立重算一致。
"""
import sys, os, io, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib import helpers as H  # noqa: E402
from lib.cdp import wait_for, eval_json  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

APP = "document.querySelector('#app').__vue_app__"
APP_ST = "document.querySelector('#app').__vue_app__._instance.setupState"


def _read(rel):
    return io.open(os.path.join(ROOT, rel), encoding='utf-8').read()


def _code_only(src):
    """剥掉注释后再做子串判据 —— 本仓已三次踩到「注释里的字样被当成违规」（test_59/71/75）。"""
    out, i, n, in_block = [], 0, len(src), False
    while i < n:
        c = src[i]
        if in_block:
            if c == '*' and i + 1 < n and src[i + 1] == '/':
                in_block, i = False, i + 2
                continue
            out.append('\n' if c == '\n' else ' ')
            i += 1
            continue
        if c == '/' and i + 1 < n and src[i + 1] == '*':
            in_block, i = True, i + 2
            continue
        if c == '/' and i + 1 < n and src[i + 1] == '/':
            while i < n and src[i] != '\n':
                i += 1
            continue
        out.append(c)
        i += 1
    return ''.join(out)


# ══════════════════════════════════════════════════════════════════
# f0 源码守卫
# ══════════════════════════════════════════════════════════════════
def sub_source_guards(cdp):
    bad = []
    ENUM_ARR = "['自然', '宗教'"

    pt = _code_only(_read('src/renderer/src/utils/placeTypes.js'))
    for fn in ['export const PLACE_TYPES', 'export const PLACE_TYPE_LAYERS',
               'export function placeTypeOptions', 'export function showsPlaceTypeControl',
               'export function expectsPlaceType', 'export function missingPlaceType',
               'export function missingParent', 'export function matchesGap',
               'export const GAP_MODES']:
        if fn not in pt:
            bad.append(f'utils/placeTypes.js 缺少 {fn}')

    panel = _code_only(_read('src/renderer/src/components/ProjectPanel.vue'))
    if "from '../utils/placeTypes'" not in panel:
        bad.append('ProjectPanel 没有引用 utils/placeTypes（枚举会变成第二份事实源）')
    if ENUM_ARR in panel:
        bad.append('ProjectPanel 里有内联 8 枚举数组（第二套事实源）')
    if "'place-type-'" not in panel:
        bad.append('面板缺少行内类型下拉的 data-testid（用例与用户都找不到它）')
    if 'data-testid="gap-filter"' not in panel:
        bad.append('面板缺少「只看空白」过滤器 gap-filter')
    if 'function onPlaceTypeChange' not in panel:
        bad.append('面板缺少 onPlaceTypeChange')
    else:
        idx = panel.index('function onPlaceTypeChange')
        seg = panel[idx:idx + 1600]
        # 行内改类型必须走 undo 栈：直接写内存 = 撤不掉，且绕开写闸门（MEMORY_WRITE_CALLSITES 纪律）
        if 'proj.updateEntity' not in seg:
            bad.append('行内改类型没有走 proj.updateEntity（undo 与落盘全丢）')
        if 'entities[' in seg or 'entities.value' in seg:
            bad.append('行内改类型直接改了 entities 内存（绕开 undo 栈）')
    if panel.count(':disabled="isReadOnly"') < 2:
        bad.append('类型下拉 / 过滤器没有在只读态灰禁（:disabled="isReadOnly" 少于 2 处）')
    if 'READONLY_REASON' not in panel:
        bad.append('缺少只读态原因文案 READONLY_REASON（灰禁必须给去处）')

    detail = _code_only(_read('src/renderer/src/components/NodeDetailPanel.vue'))
    if 'placeTypeOptions' not in detail:
        bad.append('详情面板没走 placeTypeOptions —— 枚举外值会被显示成「未设置」')
    if ENUM_ARR in detail:
        bad.append('NodeDetailPanel 里有内联 8 枚举数组')

    geo = _code_only(_read('src/renderer/src/store/geodata.js'))
    if "from '../utils/placeTypes'" not in geo:
        bad.append('geodata 没有引用 utils/placeTypes（搜索筛选会变成第二份枚举）')
    if ENUM_ARR in geo:
        bad.append('geodata 里有内联 8 枚举数组')

    if bad:
        return False, '；'.join(bad)
    return True, ('枚举/层级/选项/过滤单源 utils/placeTypes.js（三处组件均无内联回抄）；'
                  '行内改类型只走 updateEntity（undo + 落盘）；只读态灰禁带原因')


# ══════════════════════════════════════════════════════════════════
# f1 / f2 端到端
# ══════════════════════════════════════════════════════════════════
JS = r"""(async () => {
  const fails = [], notes = [];
  const ck = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' → ' + JSON.stringify(e) : '')); };
  const same = (l, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(l + ' → got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 150));
  const q = (s) => document.querySelector(s);
  const text = (s) => { const e = q(s); return e ? e.textContent.trim() : ''; };

  const APP = __APP__;
  const st = APP._instance.setupState;
  const store = st.store;
  const pinia = APP.config.globalProperties.$pinia;
  const PM = await import('/src/store/projectStore.js');
  const proj = PM.useProjectStore(pinia);

  const PLACE_LAYERS = ['facility', 'location', 'region'];
  const ENUM = ['自然', '宗教', '皇室', '商业', '工业', '居住', '公共', '特殊'];

  // ── 打开项目面板 ──
  const toolBtn = Array.from(document.querySelectorAll('button'))
    .find(b => (b.getAttribute('title') || '').indexOf('.sitian') >= 0);
  ck('装置：工具栏有「项目」入口', !!toolBtn, null);
  if (toolBtn && !q('.project-panel')) {
    toolBtn.click();
    for (let i = 0; i < 40 && !q('.project-panel'); i++) await tick(100);   // 懒加载 chunk
  }
  ck('装置：项目面板已渲染', !!q('.project-panel'), null);

  const rows = () => Array.from(document.querySelectorAll('.project-panel .pp-node-row'));
  const rowIds = () => rows().map(r => r.getAttribute('data-id'));
  const selOf = (id) => q('.project-panel [data-testid="place-type-' + id + '"]');
  const setFilter = async (mode) => {
    const s = q('.project-panel [data-testid="gap-filter"]');
    if (!s) return false;
    s.value = mode;
    s.dispatchEvent(new Event('change'));
    await tick(350);
    return true;
  };
  await setFilter('all');

  // ── 装置：一个类型为空的地点类实体 ──
  const world = proj.entityList.find(e => e.layer === 'world') || null;
  let t = proj.entityList.find(e => e.layer === 'facility' && e.name === 'A3点选测试');
  let created = false;
  if (!t) {
    proj.createEntity({ name: 'A3点选测试', layer: 'facility', parentId: world ? world.id : null });
    await tick(350);
    t = proj.entityList.find(e => e.name === 'A3点选测试');
    created = true;
  }
  ck('装置：地点类实体就位', !!t, null);
  if (t && t.placeType) { proj.updateEntity(t.id, { placeType: null }); await tick(250); }
  const TID = t ? t.id : '';

  // ══════ f1 行内类型下拉 ══════
  if (TID) {
    const sel = selOf(TID);
    ck('f1 ★ 该行有类型下拉（搬家后唯一录入通道）', !!sel, null);
    if (sel) {
      const vals = Array.from(sel.options).map(o => o.value);
      same('f1 空值时选项 = 未设置 + 8 枚举', vals, [''].concat(ENUM));

      // ★ 补刀①：枚举外的现存值必须保留在选项里（笔记手写第 9 种，一打开就吞 = 静默改值）
      proj.updateEntity(TID, { placeType: '秘境' });
      await tick(400);
      const sel2 = selOf(TID);
      ck('f1 下拉在值变化后仍在', !!sel2, null);
      if (sel2) {
        const vals2 = Array.from(sel2.options).map(o => o.value);
        ck('f1 ★ 选项 = 8 枚举 ∪ 当前值（第 9 种出现）', vals2.indexOf('秘境') >= 0, vals2);
        ck('f1 ★ 当前值显示为「秘境」，不是静默空白', sel2.value === '秘境', sel2.value);

        // 用户路径：真实 change 事件（不是直接调函数）
        sel2.value = '宗教';
        sel2.dispatchEvent(new Event('change'));
        await tick(400);
        same('f1 ★ 改下拉 → 项目实体落值', (proj.entities[TID] || {}).placeType, '宗教');
        ck('f1 ★ 回执写明「写入 .sitian + 可撤销」（不静默）',
           /写入 \.sitian/.test(text('.project-panel .pp-tip')) && /撤销/.test(text('.project-panel .pp-tip')),
           text('.project-panel .pp-tip'));
        const node = store.nodes.find(n => n.id === TID);
        ck('f1 ★ 同步到画布节点（图标配色 / 详情面板读它）', !!(node && node.placeType === '宗教'),
           node ? node.placeType : null);

        // undo / redo（一条命令一个值）
        store.undo();
        await tick(400);
        same('f1 ★ 一条 undo 回到上一个值（直接改内存就撤不掉）', (proj.entities[TID] || {}).placeType, '秘境');
        store.redo();
        await tick(400);
        same('f1 redo 回到「宗教」', (proj.entities[TID] || {}).placeType, '宗教');

        // 落盘：保存载荷（mock 环境落点 = window.__projects[filePath]）必须带着 placeType
        const saveRes = await proj.saveProject({ label: 'A-3 验证' });
        ck('f1 保存成功', !!(saveRes && saveRes.success), saveRes && saveRes.error);
        const saved = (window.__projects || {})[proj.filePath];
        const savedPT = saved && saved.entities && saved.entities[TID]
          ? saved.entities[TID].placeType : (saved ? '实体不在载荷里' : '没有保存载荷');
        ck('f1 ★ 落进 .sitian（保存载荷里带着 placeType）', savedPT === '宗教', savedPT);

        // 清空路径：选「未设置」→ 两处同步清掉
        const sel3 = selOf(TID);
        if (sel3) {
          sel3.value = '';
          sel3.dispatchEvent(new Event('change'));
          await tick(400);
          same('f1 清空 → 项目实体回到 null', (proj.entities[TID] || {}).placeType, null);
          const node2 = store.nodes.find(n => n.id === TID);
          ck('f1 清空也同步到画布', !(node2 && node2.placeType), node2 ? node2.placeType : null);
        }
      }
    }
  }

  // ══════ f2 只看空白过滤（期望集合独立重算，不 import 被测实现）══════
  const expIds = (mode) => proj.entityList.filter(e => {
    const typeGap = PLACE_LAYERS.indexOf(e.layer) >= 0 && !e.placeType;
    const parentGap = e.layer !== 'world' && !e.parentId;
    if (mode === 'type') return typeGap;
    if (mode === 'parent') return parentGap;
    if (mode === 'any') return typeGap || parentGap;
    return true;
  }).map(e => e.id).sort();

  const allIds = rowIds().slice().sort();
  same('f2 装置：all 模式显示全部实体（行与实体一一对应）', allIds, expIds('all'));

  const gapSel = q('.project-panel [data-testid="gap-filter"]');
  ck('f2 过滤器存在', !!gapSel, null);

  // 宇宙层噪音样本：真 ROSA 有 39 个（补刀②的动机）
  const noisy = proj.entityList.find(e =>
    PLACE_LAYERS.indexOf(e.layer) < 0 && e.layer !== 'world' && !e.placeType) || null;
  ck('f2 装置：宇宙层里存在类型空白（否则本段测不到噪音）', !!noisy, noisy ? null : proj.entityList.slice(0, 5).map(e => e.layer));

  if (gapSel) {
    // ── type ──
    ck('f2 切到「类型为空」', await setFilter('type'), null);
    const expType = expIds('type');
    same('f2 ★ 类型过滤显示集 = 独立重算的地点层级空白集', rowIds().slice().sort(), expType);
    if (noisy) {
      ck('f2 ★ 宇宙层空白**不出现**在类型过滤里（否则 39 行噪音，过滤器等于没做）',
         rowIds().indexOf(noisy.id) < 0, { noisy: noisy.id, layer: noisy.layer });
    }
    const typeOpt = Array.from(gapSel.options).find(o => o.value === 'type');
    ck('f2 ★ 过滤器选项标出独立重算的计数',
       !!typeOpt && typeOpt.textContent.indexOf('（' + expType.length + '）') >= 0,
       typeOpt ? typeOpt.textContent : null);
    ck('f2 计数条显示「显示 X / Y」',
       text('.project-panel [data-testid="gap-count"]').indexOf('显示 ' + expType.length + ' / ' + allIds.length) >= 0,
       text('.project-panel [data-testid="gap-count"]'));

    // ── parent ──
    ck('f2 切到「挂靠为空」', await setFilter('parent'), null);
    same('f2 ★ 挂靠过滤显示集 = 独立重算的非 world 孤儿集', rowIds().slice().sort(), expIds('parent'));
    const worlds = proj.entityList.filter(e => e.layer === 'world');
    ck('f2 ★ world 不出现在挂靠过滤里（顶层是合法的，实测 9 空里 4 个是 world）',
       worlds.every(w => rowIds().indexOf(w.id) < 0),
       worlds.filter(w => rowIds().indexOf(w.id) >= 0).map(w => w.id));

    // ── any ──
    ck('f2 切到「任一为空」', await setFilter('any'), null);
    same('f2 any = 两类空白的并集', rowIds().slice().sort(), expIds('any'));

    // ── all 还原 ──
    ck('f2 切回「全部」', await setFilter('all'), null);
    same('f2 全部模式恢复整树', rowIds().slice().sort(), expIds('all'));
    ck('f2 all 模式不显示计数条', !q('.project-panel [data-testid="gap-count"]'), null);
  }

  // ── 清理 ──
  if (TID && created) { try { proj.deleteEntity(TID, { cascade: true }); } catch (e) { notes.push('清理失败:' + e); } }
  await setFilter('all');

  return JSON.stringify({ fails, notes });
})()"""


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    wait_for(cdp, f"{APP_ST}.store.nodes.length > 0", timeout=45, desc='地理数据加载')

    ok, info = H.ensure_case_state(cdp)
    if not ok:
        return False, f'装置失败（harness 项目未打开）：{info.get("error") or info}'

    ok_src, detail_src = sub_source_guards(cdp)
    if not ok_src:
        return False, f'f0 源码守卫失败：{detail_src}'

    js = JS.replace('__APP__', APP)
    ok_js, res = eval_json(cdp, js, desc='A-3 中文点选糙版')
    if not ok_js:
        return False, res
    if isinstance(res, dict):
        fails = res.get('fails') or []
        if fails:
            return False, f'断言失败 {len(fails)} 项：' + '；'.join(str(x) for x in fails[:10])
        return True, ('f0 枚举/选项/过滤单源 placeTypes.js + 行内改类型只走 updateEntity + 只读灰禁；'
                      'f1 下拉选项=8枚举∪当前值（秘境不被吞）→ change 落值+同步画布+undo/redo+保存载荷带 placeType；'
                      'f2 四档过滤与独立重算逐一相等，宇宙层噪音与 world 顶层均被豁免 —— 全部通过')
    return False, f'用例返回值异常：{str(res)[:200]}'
