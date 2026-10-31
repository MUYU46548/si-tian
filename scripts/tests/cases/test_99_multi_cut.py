#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 99：折线切割「一次切多块」（0.2.6 目标里的第三件）

原先「一次只切一个省」是**刻意的**：跨省连切时，折线两端沿切向延长出来的那一段会替邻居做决定
（误切比多切更坏）。但暮雨的目标是"切四五百块"，一刀一个省太慢，而这条限制其实**可以绕开**：
  · 每个省只取「折线**在它内部**的那一段」（`extractInsideSegment`）→ 延长段只作用于它自己；
  · 单省切分只改 `terrain[idx]` + **表尾追加**新省 ⇒ 既有下标一个都不动，逐个切互不干扰。

本用例守五类判据：
  a 源码闸门（剥注释）：store 单源 + 写口契约已登记 + 每个省仍复用 commitSplit（不许另造一套）
  b 局部段提取：一条竖穿三个省的折线 → 每个省只拿到自己内部那一段（**不是整条线**）
  c 端到端：一条折线穿过 3 个省 → 3 个都被切开（3 → 6 个省）、总面积守恒、
     每个省的原 id 仍在原位（身份不丢）
  d 护栏：横向折线（只贴着一个省走）不误切；穿过太多省 → 明确拒绝并给上限；只读态走契约
  e UI：折线工具的「切开」按钮到位（点一次就切多块）
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for      # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def _code_only(src):
    out, in_block = [], False
    for line in src.split('\n'):
        s = line
        if in_block:
            if '*/' in s:
                s = s.split('*/', 1)[1]
                in_block = False
            else:
                continue
        while '/*' in s:
            before, after = s.split('/*', 1)
            if '*/' in after:
                s = before + after.split('*/', 1)[1]
            else:
                s = before
                in_block = True
                break
        if '//' in s:
            s = s.split('//', 1)[0]
        out.append(s)
    return '\n'.join(out)


def source_gates():
    fails, notes = [], []
    pe = _code_only(_read('src/renderer/src/store/geodataModules/provinceEditing.js'))
    wg = _code_only(_read('src/renderer/src/store/writeGate.js'))

    for needle, label in [
        ('function splitProvincesAlong(', 'store：一次切多块入口'),
        ('function extractInsideSegment(', 'store：折线在某省内部的局部段'),
        ('function provincesCrossedByPolyline(', 'store：判定折线穿过哪些省'),
        ("rejected: 'too-many'", 'store：穿过太多省时明确拒绝（带上限）'),
        ('splitProvinceAlong(key, prov.id', 'store：每个省仍复用单省切分（不另造一套几何）'),
    ]:
        if needle not in pe:
            fails.append(f'源码闸门缺失：{label}（找不到 `{needle}`）')
    if "'splitProvincesAlong'" not in wg:
        fails.append('写口契约缺失：splitProvincesAlong 未登记（只读态必须被拦）')
    # 🔴 组件的折线收口必须真的走多块入口（否则界面说"切开 N 块"、实际只切一块 = 假绿）
    sc = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
    # 2026-10-31：绘制/交互体已分批搬到 scenario/{layers,interaction}/* —— 判据读合集，不再绑文件位置
    from lib.rsrc import render_src_code_only as _rsrc_all
    sc = _rsrc_all()
    if 'store.splitProvincesAlong(' not in sc:
        fails.append('🔴 折线收口没有调用 store.splitProvincesAlong（界面切一块、回执说多块 = 假绿）')
    # 🔴 红线：不许把"整条折线"直接喂给每个省（那正是原先"一次只切一个"要防的事）
    if 'splitProvinceAlong(key, prov.id, pts' in pe:
        fails.append('🔴 把整条折线喂给了每个省 —— 延长段会替邻居做决定（必须用局部段）')

    notes.append('源码闸门 6 项 + 1 条红线' + ('全过' if not fails else f'缺 {len(fails)}'))
    return fails, notes


JS = r""" (async () => {
  const s = __STORE__, sc = __SC__;
  const fails = [], notes = {};
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + e + ')' : '')); };
  const P = window.__provShape;
  window.confirm = () => true;
  const KEY = 'case99';
  const area = (p) => P.provinceNetArea(p);
  const total = () => (s.baseMaps[KEY].terrain || []).reduce((n, p) => n + area(p), 0);

  // 三个竖排相邻方块：各 100×80 = 8000，合计 24000
  const mk = (id, name, y) => ({ id, name, kind: 'land',
    points: [{ x: 0, y }, { x: 100, y }, { x: 100, y: y + 80 }, { x: 0, y: y + 80 }] });
  s.baseMaps = { ...s.baseMaps, [KEY]: { id: KEY, name: '用例99底图', referenceImages: [],
    terrain: [mk('p99a', '上省', 0), mk('p99b', '中省', 80), mk('p99c', '下省', 160)] } };
  sc.baseMapKey = KEY;
  await new Promise((r) => setTimeout(r, 60));
  const base = total();
  ok('构造：三块各 8000，合计 24000', Math.abs(base - 24000) < 1, base);

  // 竖穿三块的折线（x=50，从 y=-20 到 y=260）
  const vertical = [];
  for (let y = -20; y <= 260; y += 20) vertical.push({ x: 50, y });

  // ══ b) 穿省判定（走**回执**，不为测试扩大 store 的公开面）═══════════════════
  // ⚠️ `provincesCrossedByPolyline` / `extractInsideSegment` 是模块**内部**函数，刻意不导出；
  //    它们的正确性由 `splitProvincesAlong` 的回执（crossed / changed / skipped）间接体现。
  {
    const r0 = s.splitProvincesAlong(KEY, vertical, { maxProvinces: 2 });
    ok('b1 折线被判定为穿过三个省（回执 crossed=3）',
       !!(r0 && r0.rejected === 'too-many' && r0.count === 3), JSON.stringify(r0 && { rej: r0.rejected, count: r0.count }));
    ok('b1 上限拒绝时一个省都没动', s.baseMaps[KEY].terrain.length === 3, s.baseMaps[KEY].terrain.length);
  }

  // ══ c) 端到端：一次切三块 ═══════════════════════════════════════════════
  {
    const idsBefore = s.baseMaps[KEY].terrain.map((p) => p.id);
    const r = s.splitProvincesAlong(KEY, vertical);
    ok('c1 一次切多块成功', !!(r && r.ok), JSON.stringify(r && { ok: r.ok, changed: r.changed, rej: r.rejected, msg: r.message }));
    ok('c1 🔴 三个省都被切开（改了 3 个，不是 1 个）', !!(r && r.changed === 3), JSON.stringify(r && r.changed));
    ok('c1 没跳过任何一个', !!(r && (!r.skipped || r.skipped.length === 0)), JSON.stringify(r && r.skipped));
    const T = () => s.baseMaps[KEY].terrain;
    ok('c2 省份数 3 → 6', T().length === 6, T().length);
    ok('c2 🔴 原来的三个 id 都还在（身份不丢 = 时间轴/归属不断线）',
       idsBefore.every((id) => T().some((p) => p.id === id)), JSON.stringify(T().map((p) => p.id)));
    ok('c2 原 id 仍在**原位序号**（前三个）', idsBefore.every((id, i) => T()[i].id === id),
       JSON.stringify(T().map((p) => p.id)));
    ok('c2 新省追加在表尾（后三个）', T().slice(3).every((p) => idsBefore.indexOf(p.id) < 0));
    ok('c3 🔴 总面积守恒（切开不是增减）', Math.abs(total() - base) < 2, Math.round(total()) + ' vs ' + Math.round(base));
    ok('c3 每一块都被切成左右两半（宽度 ≈ 50）',
       T().every((p) => { const b = P.provinceBBox(p); return Math.abs(b.maxX - b.minX - 50) < 1.5; }),
       JSON.stringify(T().map((p) => { const b = P.provinceBBox(p); return [Math.round(b.minX), Math.round(b.maxX)]; })));
    // 回执里如实写明 undo 粒度
    ok('c4 回执写明"每个省一条撤销"', /Ctrl\+Z|撤销/.test((r && r.message) || ''), (r && r.message || '').slice(0, 60));

    // 逐条撤销（3 次）
    s.undo(); s.undo(); s.undo();
    ok('c4 逐条撤销 3 次回到 3 个省', T().length === 3, T().length);
    ok('c4 撤销后面积回到 24000', Math.abs(total() - base) < 1, Math.round(total()));
    s.redo(); s.redo(); s.redo();
    ok('c4 redo 3 次回到 6 个省', T().length === 6, T().length);
    // 复位成 3 个省，供后面的护栏段用
    s.undo(); s.undo(); s.undo();
    ok('c4 复位到 3 个省', T().length === 3, T().length);
    notes.cut = '一条竖折线穿过 3 省 → 3 省变 6 省，面积守恒 ' + Math.round(total());
  }

  // ══ d) 护栏 ═════════════════════════════════════════════════════════════
  {
    const T = () => s.baseMaps[KEY].terrain;
    ok('d0 起点：已复位成 3 个省', T().length === 3, T().length);
    // ⚠️ 必须**按 id** 记，不能按下标：切完中间省后新省追加在表尾，下标会整体错位
    //    （首版用 T()[0]/T()[2] 比，比到的其实是被切的那块 → "邻居被改了"的假红）。
    const ptsOf = (id) => JSON.stringify((T().find((p) => p.id === id) || {}).points);
    const top0 = ptsOf('p99a');
    const bot0 = ptsOf('p99c');

    // 🔴 d1 本用例真正的核心断言：折线**只**横穿中间那块时，上下两块**逐点未动**
    //    （这就是"用局部段而不是整条折线"的意义 —— 两端沿切向延长出去的那一段
    //      如果拿去喂邻居，就会替邻居做决定，把上下两块也切了）。
    // ⚠️ 端点要**避开省界**：y=80 正是上/中两省的交界，落在那儿会让段中点判定同时命中两块
    //    （首版用 y 40→120、中点 80 压在交界上 → 上省被算进 crossed，看起来像"延长段碰了邻居"）。
    const mid = [{ x: 50, y: 40 }, { x: 50, y: 130 }];
    const r1 = s.splitProvincesAlong(KEY, mid);
    ok('d1 只横穿一块时只切一块', !!(r1 && r1.ok && r1.changed === 1), JSON.stringify(r1 && { ok: r1.ok, ch: r1.changed, crossed: r1.crossed }));
    ok('d1 省份数 3 → 4', T().length === 4, T().length);
    ok('d1 🔴 上省与下省逐点未动（延长段没替邻居做决定）',
       ptsOf('p99a') === top0 && ptsOf('p99c') === bot0,
       JSON.stringify({ top: ptsOf('p99a') === top0, bot: ptsOf('p99c') === bot0 }));
    s.undo();
    ok('d1 撤销回到 3 个省', T().length === 3, T().length);

    // d2 点数不足 / 完全没横穿
    const r2 = s.splitProvincesAlong(KEY, [{ x: 50, y: 40 }]);
    ok('d2 折线点数不足 → 明确回执', !!(r2 && r2.ok === false && r2.message), JSON.stringify(r2 && r2.message));
    const r2b = s.splitProvincesAlong(KEY, [{ x: 500, y: 500 }, { x: 560, y: 560 }]);
    ok('d2 完全没横穿任何省 → no-cut（不是静默无反应）',
       !!(r2b && r2b.ok === false && r2b.rejected === 'no-cut'), JSON.stringify(r2b && r2b.rejected));
    ok('d2 数据未动（仍是 3 个省、逐点一致）',
       T().length === 3 && ptsOf('p99a') === top0 && ptsOf('p99c') === bot0);

    // d3 上限闸门（竖穿三块 + 上限 2）
    const r3 = s.splitProvincesAlong(KEY, vertical, { maxProvinces: 2 });
    ok('d3 超过上限 → too-many（并报出穿过了几个）',
       !!(r3 && r3.ok === false && r3.rejected === 'too-many' && r3.count === 3),
       JSON.stringify(r3 && { rej: r3.rejected, count: r3.count }));
    ok('d3 拒绝时一个省都没被切', T().length === 3, T().length);

    // d4 底图不存在
    const r4 = s.splitProvincesAlong('case99-no-such', vertical);
    ok('d4 底图不存在 → 明确回执（不抛）', !!(r4 && r4.ok === false), JSON.stringify(r4 && r4.message));
  }

  // ══ e) UI：折线工具到位 ═════════════════════════════════════════════════
  {
    sc.moreOpen = true;
    await new Promise((r) => setTimeout(r, 80));
    const bar = document.querySelector('.scenario-toolbar');
    const btn = Array.from(bar.querySelectorAll('button')).find((b) => (b.title || '').includes('折线切割'));
    ok('e1 「折线切割」入口在位', !!btn, '按钮不在');
    if (btn) {
      btn.click();
      await new Promise((r) => setTimeout(r, 60));
      ok('e1 点了切到该工具', sc.tool === 'polySplit', String(sc.tool));
      const fin = document.querySelector('[data-testid="polysplit-finish"]');
      ok('e1 「切开」按钮在位（复用它执行多块切分）', !!fin, '按钮不在');
    }
    // 🔴 e2 源码层：收口必须真的走**多块**入口 —— 否则界面说"切开 N 块"而实际只切一块（假绿）
    sc.setTool('select');
  }

  delete s.baseMaps[KEY];
  sc.baseMapKey = Object.keys(s.baseMaps)[0] || '';
  return JSON.stringify({ fails, notes });
})()"""


def run(cdp):
    fails, notes = source_gates()

    cdp.eval(
        "(() => { const b = Array.from(document.querySelectorAll('button'))"
        ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()"
    )
    try:
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式挂载')
    except RuntimeError as e:
        return False, f'剧本模式未挂载：{e}'
    time.sleep(1.5)

    prep = eval_json(cdp, """(async () => {
      const P = await import('/src/utils/provinceShape.js');
      window.__provShape = P;
      return JSON.stringify({ fails: [] });
    })()""", desc='provinceShape 加载')
    if not prep[0]:
        return False, f'provinceShape 模块加载失败：{prep[1]}'

    ok, res = eval_json(cdp, JS.replace('__STORE__', STORE).replace('__SC__', SC), desc='99 主探针')
    if not ok:
        return False, res
    fails += res.get('fails', [])
    n = res.get('notes', {})
    if n.get('cut'):
        notes.append(n['cut'])
    return (not fails), ' | '.join(fails) if fails else ' | '.join(notes)
