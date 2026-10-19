#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 108：**几何退化不许把整笔编辑炸掉**（2026-10-17，用户真机崩溃）

用户真机报错（原文）：
    `Unable to complete output ring starting at [1057.19…]. Last matching segment found ends at [1186.26…]`
    组件: window.onerror / 堆栈: polygon-clipping → unionMulti → applyRegionToTerrain → applyProvinceLasso
    用户在做的动作：「视图圈选来批量删除」那些画错的测试河流。

🔴 定性：**手画的套索环自交是常态**（人手下笔画不出一条严格简单多边形）。
   `polygon-clipping` 在自交/精度退化的环上会抛 `Unable to complete output ring …`，
   而当时的 `unionMulti` / `intersection` 都是**裸调**引擎 → 异常一路冒到 `window.onerror`，
   用户看到的是"圈选批量删除直接报错"，整笔操作什么也没做成。

本用例守三件事（全部在**纯函数层**，不需要浏览器）：
  a **不许裸调**：`provinceEditing.js` 里对 `polygonClipping` 的 `union/intersection/difference`
     必须走带兜底的包装（`unionMulti` / `robustOp`），不许再出现裸 `polygonClipping.union(...)`。
  b **真的不抛**：给 `unionMulti` 喂一个**自交环**（蝴蝶结），它必须返回一个结果而不是抛异常。
  c **真的降级可观测**：兜底发生时 `onFail` 必须被调用（不静默），
     而且 `robustOp` 的 `snapped` 标记要如实反映"几何被吸附重算过"。

⚠️ 判据必须**量行为**（喂坏数据看会不会抛），不能只查源码里有没有 `try` ——
   源码里有个 try 但 catch 里又抛，源码判据照样绿（本项目踩过这类"看起来修了"）。
"""
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from lib.cdp import eval_json      # noqa: E402  （判定必须走它：`cdp.eval` 抛异常时会被静默吞掉）

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
PE = os.path.join(ROOT, 'src', 'renderer', 'src', 'store', 'geodataModules', 'provinceEditing.js')
PB = os.path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'polygonBool.js')


def _code_only(src):
    """剥注释（判据看代码，不看说明文字）"""
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


# ── 纯函数层的退化实验（在页面里跑，用产品自己的包装层）──────────────────────
# 做法：**注入一个会抛的假引擎**，模拟 `polygon-clipping` 在自交环上的真实行为
#       （`Unable to complete output ring starting at [x, y]…`）。
# 为什么不用真引擎喂自交环：真引擎在不同版本上对自交的容忍度不同，
#   判据会跟着依赖版本漂移。而**我们守的是"包装层扛不扛得住引擎抛"** ——
#   假引擎抛得越凶，这条判据越硬。
JS_DEGENERATE = r"""
(async () => {
  const out = {};
  const pb = await import('/src/utils/polygonBool.js');

  const BOOM = 'Unable to complete output ring starting at [1057.19, 583.58]. ' +
               'Last matching segment found ends at [1186.26, 512.45].';
  // 假引擎：每次都抛（模拟最坏情况）
  const badClip = {
    union() { throw new Error(BOOM); },
    intersection() { throw new Error(BOOM); },
    difference() { throw new Error(BOOM); },
  };
  // 正常几何的假引擎（按"并集把环首尾相接"的最小语义，只要能验证不污染即可）
  const goodRing = [[0,0],[50,0],[50,50],[0,50],[0,0]];
  const goodClip = {
    union() { return [[goodRing]]; },
    intersection() { return [[goodRing]]; },
    difference() { return [[goodRing]]; },
  };

  const box = [[[0,0],[100,0],[100,100],[0,100],[0,0]]];
  const box2 = [[[10,10],[110,10],[110,110],[10,110],[10,10]]];

  // ① unionMulti 扛不扛得住引擎抛
  // ⚠️ 必须传**两个** add：只有一个 add 时 `unionMulti` 走快速路径直接返回它（不调引擎），
  //    那条路本来就不会抛 —— 用它做判据会"空转通过"。
  const fails = [];
  let res = null, threw = null;
  try {
    res = pb.unionMulti(badClip, [], [box, box2], { onFail: (i) => fails.push(i.label) });
  } catch (e) { threw = String(e && e.message || e); }
  out.unionThrew = !!threw;
  out.unionErr = threw;
  out.unionResultIsArray = Array.isArray(res);
  out.unionFailCalls = fails.length;

  // ② 带 base 的并集也要扛得住（同样要两个 add 才逼出引擎调用）
  let threw2 = null;
  let res2 = null;
  const f2 = [];
  try {
    res2 = pb.unionMulti(badClip, [[goodRing]], [box, box2], { onFail: (i) => f2.push(i.label) });
  } catch (e) { threw2 = String(e && e.message || e); }
  out.unionWithBaseThrew = !!threw2;
  // base 在时，全失败必须**退还 base**（宁可少并一块，不许剩空）
  out.unionWithBaseKeptBase = Array.isArray(res2) && res2.length > 0;
  out.unionWithBaseFailCalls = f2.length;

  // ③ robustOp 的兜底语义：失败要回 {multi:null, snapped:true, error}，不许抛
  let robThrew = null, rob = null;
  try { rob = pb.robustOp(badClip, 'union', box); } catch (e) { robThrew = String(e && e.message || e); }
  out.robustThrew = !!robThrew;
  out.robustMultiNull = !!rob && rob.multi === null;
  out.robustSnapped = !!rob && rob.snapped === true;
  out.robustHasError = !!rob && !!rob.error;

  // ④ 正常引擎不许被兜底污染
  const goodFails = [];
  const goodRes = pb.unionMulti(goodClip, [], [box, box2], { onFail: (i) => goodFails.push(i.label) });
  out.goodPoints = pb.countMultiPoints(goodRes);
  out.goodNonEmpty = Array.isArray(goodRes) && goodRes.length > 0;
  out.goodFailCalls = goodFails.length;
  const robGood = pb.robustOp(goodClip, 'union', box);
  out.goodSnapped = !!robGood.snapped;
  out.goodHasMulti = !!robGood.multi;

  return JSON.stringify(out);
})()
"""


def source_gates():
    """a 源码闸门：不许再裸调多边形引擎"""
    fails = []
    pe = _code_only(open(PE, encoding='utf-8').read())
    pb = _code_only(open(PB, encoding='utf-8').read())

    # ① provinceEditing 里对引擎的调用必须是包装过的
    raw_calls = re.findall(r'\bpolygonClipping\.(union|intersection|difference)\s*\(', pe)
    if raw_calls:
        fails.append('🔴 provinceEditing 里仍有**裸调** `polygonClipping.%s(...)`（共 %d 处）'
                     ' —— 几何退化时会抛 `Unable to complete output ring`，整笔编辑炸掉'
                     % (raw_calls[0], len(raw_calls)))

    # ② 包装层必须真的在
    for needle, why in [
        ('export function unionMulti', '并集包装（自交净化 + 逐个并）'),
        ('export function robustOp', '带吸附重算的兜底'),
    ]:
        if needle not in pb:
            fails.append(f'🔴 polygonBool 缺 {why}（找不到 `{needle}`）')

    # ③ unionMulti 必须真的 try（catch 里也必须给结果，不能只记日志）
    m = re.search(r'export function unionMulti[\s\S]*?\n}', pb)
    if not m:
        fails.append('🔴 找不到 unionMulti 函数体（判据失效，需同步更新本用例）')
    else:
        body = m.group(0)
        if 'try' not in body:
            fails.append('🔴 unionMulti 没有 try —— 引擎一抛就冒到 window.onerror')
        if 'onFail' not in body:
            fails.append('🔴 unionMulti 兜底时不回报（`onFail`）—— 静默降级')

    # ④ applyRegionToTerrain 里那两处必须走包装
    if 'unionMulti(polygonClipping' not in pe:
        fails.append('🔴 applyRegionToTerrain 没走 `unionMulti(polygonClipping, …)`')
    if "robustOp(polygonClipping, 'intersection'" not in pe:
        fails.append('🔴 海岸线裁剪那一步的 `intersection` 没走 `robustOp`（会抛）')

    return fails


def run(cdp):
    fails = source_gates()
    notes = ['源码闸门 4 组']

    r = eval_json(cdp, JS_DEGENERATE, required=None, desc='几何退化（注入会抛的假引擎）实验')
    r = r[1] if isinstance(r, tuple) and r[0] else {'err': r}
    if not isinstance(r, dict) or 'unionThrew' not in r:
        fails.append(f'🔴 退化实验求值失败：{r}')
        return False, ' | '.join(fails)

    # ① 核心：引擎抛，包装层不许抛
    if r.get('unionThrew'):
        fails.append(f"🔴 unionMulti 仍把引擎异常抛出去了（{r.get('unionErr')}）—— 用户圈选会再报错")
    if not r.get('unionResultIsArray'):
        fails.append('🔴 unionMulti 失败时没返回数组（应当退还 base / 空数组，不许返回 undefined）')
    # ② 兜底必须可观测（不静默）
    if not r.get('unionFailCalls'):
        fails.append('🔴 引擎抛了但 `onFail` 没被调用 —— 兜底是静默的（用户以为成功）')
    # ③ 带 base 时，全失败必须**保住 base**（宁可少并一块，不许剩空）
    if r.get('unionWithBaseThrew'):
        fails.append('🔴 带 base 的 unionMulti 仍抛异常')
    if not r.get('unionWithBaseKeptBase'):
        fails.append('🔴 带 base 的并集全失败后**把 base 弄丢了** —— 那会凭空删掉用户已有的地')
    # ④ robustOp 语义
    if r.get('robustThrew'):
        fails.append('🔴 robustOp 仍抛异常（它存在的意义就是吞掉引擎异常并降级）')
    if not r.get('robustMultiNull'):
        fails.append('🔴 robustOp 全失败时 `multi` 不是 null （调用方无法区分"算出来是空"与"算不出来"）')
    if not r.get('robustSnapped'):
        fails.append('🔴 robustOp 失败时没标 `snapped: true` —— 调用方不知道几何被降级过')
    if not r.get('robustHasError'):
        fails.append('🔴 robustOp 失败时不带 `error` —— 用户只看到"没反应"，没有原因')
    # ⑤ 正常路径零污染
    # ⚠️ 不断言精确点数：`countMultiPoints` 的计数口径是实现细节，把期望写死会让
    #    用例在"计数实现变了"时假红。这里守的是**兜底有没有污染正常路径**：
    #    有结果、非空、没触发 onFail、没被标成降级。
    if not r.get('goodNonEmpty'):
        fails.append('🔴 正常几何并集返回了空结果 —— 兜底把好数据也弄没了')
    if r.get('goodFailCalls'):
        fails.append('🔴 正常几何也触发了兜底（`onFail`）—— 兜底条件写宽了')
    if r.get('goodSnapped'):
        fails.append('🔴 正常几何被标成"降级/吸附过"（`snapped`）—— 标记口径错了')
    if not r.get('goodHasMulti'):
        fails.append('🔴 正常几何经 robustOp 后没有结果 —— 兜底污染了正常路径')

    notes.append(f"引擎抛={r.get('unionThrew')} / 兜底调用={r.get('unionFailCalls')} / "
                 f"带base仍抛={r.get('unionWithBaseThrew')}(保住base={r.get('unionWithBaseKeptBase')}) / "
                 f"robustOp: null={r.get('robustMultiNull')} snapped={r.get('robustSnapped')} "
                 f"hasErr={r.get('robustHasError')} / 正常路径: 非空={r.get('goodNonEmpty')} "
                 f"兜底={r.get('goodFailCalls')} 吸附={r.get('goodSnapped')} 点数={r.get('goodPoints')}")

    if fails:
        return False, ' | '.join(fails)
    return True, ' + '.join(notes)
