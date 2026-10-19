#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 103：自动河流 —— 渲染不崩、算法是索引版、河口不出海（2026-10-14）

真实来由（暮雨实测，逐条对应用户原话）：
  1. 「试按钮点到了『自动河流』，毫无征兆直接卡住了……一点提示都没有吗？这么卡的操作连确认
     机会都没有吗？`渲染已暂停：Ce.save is not a function 继续渲染`」
     → 两个独立缺陷叠在一起：
       a) **渲染崩溃**：`ScenarioMap.renderFrame` 里画自动河流那一段写的是裸 `ctx.save()`，
          而 `ctx` 是 `ref(null)`（`<script setup>` 只有模板会解包 ref）→
          `ctx.save is not a function`，抛在 renderFrame 里 ⇒ **从那一行起后面全不画**
          （省界/标签/小地图/势力名都没了）+ 3 帧后渲染护栏暂停。
       b) **同步分钟级循环**：旧 `generateRivers` 对每个高地格**全表扫描**找最低邻居。
          真实底图实测量级（26910 格 / 281 源头 / 单点全表 7.46ms）→ 分钟级，主线程全程不响应。
  2. 「河流的界限似乎有问题，有好几条过度延伸到海洋中」
     → 省份轮廓是**后来**按新海岸线重建的，而河里还是那次导入留下的 → 尾巴露在海面上。
     现在导入的河在渲染前裁到当前海岸线（`utils/coastline.js`）。

本用例守**八段**判据（a~e 是主链，f~h 是三段"入口够不够得着 / 开关是不是空的"行为判据）：

  a 源码闸门（**剥注释**后查字符串）：渲染块必须走 `ctx.value`、追踪算法在纯函数层且**不许再有
    全表扫描**、画的是**河网段**（`strokeRiverNetwork`，不是只画代表路径）、陆地判据是
    **掩膜独占**、河流裁海岸线的接线在场、渲染护栏横幅在场、三个控件（源头高度 / 河流来源 /
    平滑）在 DOM 里可达
  b 端到端：造一张斜地形（75×75 格 / spacing 14.4 / 高度沿 x 从 100 递减到 0）→ **真的点画布上
    那颗「自动河流」按钮** → 出河、`renderErrorCount === 0`、渲染没暂停
  c 画布像素（**帧差**，不锁颜色）：把自动河"装上 / 摘掉"各渲一帧再逐像素比 —— 变了多少像素
    就是"用户看得见多少河"（实测真值 12296 个变化像素）。
    🔴 为什么不能数"某个通色值的像素"：河网线宽收到 1.2 屏幕像素后，抗锯齿让线上**没有纯色
       像素** → 通色值口径数到 0 = **假红**（而画布上明明有河）。这是"判据比产品严"的一类错，
       与"判据比产品宽 = 假绿"同一枚硬币的两面。
    🔴 必须用同步口 `renderNow()`：产品第六修给 `render()` 加了**帧合并**（同一帧内 15ms 以内的
       第二次调用被推迟到下一帧 rAF）→ "改数据 → render() → 立刻取像素"会拿到**上一帧**，
       差值恒 0（判据空转）。
  d 性能：同一张图**再点一次**耗时要显著低于旧口径（用耗时上限兜住"又退回全表扫描"）
  e 河口不出海：每条自动河的末端都落在海格里（水只往低处流、追到海就停）
  f 源头高度闸门**够得着**：设 0 → 河数明显变多；设 90 → 明显变少（同数据、同算法，
    只差这一个参数 —— 它若是个摆设，本条必红）
  g 河流来源**三档**（走真下拉控件）：`both / base / auto` 三档画出来的像素必须真的不同；
    再用两条探针河反证「**底图自带河也能被藏掉**」（这是用户「各画各的」的出口）
  h 平滑开关（走真复选框）：勾上后回执必须含「已先平滑地形」、且条数不为 0
    （勾平滑会压低山头 → 必须**同时**降源头闸门，否则用户看到的是"开平滑反而没河了"）

⭐ 判据纪律（本文件反复踩过，所以写在最前面）：**要量 X 在不在，就在"有 X / 无 X"之间做帧差**；
   切换 Y（比如自动河）再拿差值当 X（比如导入河）的证据 = **量错了对象**，那种判据的读数
   与产品好坏无关（⑨ 段原来就犯了这个错，恒红）。
"""
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for      # noqa: E402
from lib.helpers import ensure_case_state, open_test_base_map   # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"

# ⚠️ 这里原来有两枚"自动河描边色"的 RGB 常量（`#3B82F6` 描边 + `#93c5fd` 亮芯）。
#    第五修把自动河对齐到自带河的 `#5d97bb` 之后它们就成了**没人用的死常量**，而且注释还在
#    指着一个早就不存在的口径（`utils/rivers.js` 的 `RIVER_COLOR`）—— 留在文件里只会误导下一个人。
#    现在整条像素判据走**帧差**（对配色一字不敏感），所以这里**不需要**任何颜色常量：
#    颜色口径变化（这正是本项目反复发生的事）不再能把用例弄红。


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def _code_only(src):
    """剥掉 // 与 /* */ 注释（判据必须看代码，不能看注释里的说明文字）"""
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


def _probe_err(obj):
    """探针**求值失败**时把现场取出来（判据红的时候只说 `hits=None` 等于什么都没说）。

    为什么必须有：本用例自己踩过 —— 画布探针里抛了异常，红色回执写着"帧差为 0"，
    真正的原因（哪一步、什么异常、画布多大）全丢了，只能再跑一遍两分钟的用例去猜。
    `_probe_err` 把探针自报的 `stage` / `err` / `stack` 拼进失败文案，让**一次**运行就给结论。
    """
    if not isinstance(obj, dict):
        return f'（探针返回值不是对象：{str(obj)[:200]}）'
    if not (obj.get('err') or obj.get('__err__')):
        return ''
    return (f'｜stage={obj.get("stage")}｜err={obj.get("err") or obj.get("__err__")}'
            f'｜stack={str(obj.get("stack") or "")[:200]}｜W×H={obj.get("W")}×{obj.get("H")}'
            f'｜saved(rivers/segs)={obj.get("savedRivers")}/{obj.get("savedSegs")}'
            f'｜renderNow={"有" if obj.get("hasRenderNow") else "无"}')


def source_gates():
    fails, notes = [], []
    sc = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
    se = _code_only(_read('src/renderer/src/store/geodataModules/scenarioEditing.js'))
    rt = _code_only(_read('src/renderer/src/utils/riverTrace.js'))
    cl = _code_only(_read('src/renderer/src/utils/coastline.js'))

    # ① 渲染块必须走 ctx.value（裸 ctx. 就是 2026-10-14 那次崩溃）
    #    ⚠️ 锚点必须在**改动渲染条件时要一起改**（2026-10-16 第五修这里加上了 `showRiverAuto`
    #       —— 锚点没跟着改会让整个源码闸门报「找不到锚点」，那是**判据失效**不是产品缺陷；
    #       本条只认 `showRiverAuto` 那一版，因为它是当前唯一的渲染门控）。
    #    ⚠️ 2026-10-18 第十八修：锚点前面多了 `!blitted &&`（手势期基帧缓存 —— 贴图帧里这一块
    #       已经画在基帧上了，不能再画第二遍）。锚点改成**不含前缀**的子串：无论前面挂多少
    #       门控，只要这两条语义门在，判据就仍然指向同一个块。
    anchor = 'autoRivers.value.length > 0 && showRiverAuto.value'
    i = sc.find(anchor)
    if i < 0:
        fails.append('源码闸门：找不到自动河流的渲染块锚点（判据失效，需同步更新本用例）')
        body = ''
    else:
        start = sc.index('{', i)
        depth, j = 0, start
        while j < len(sc):
            if sc[j] == '{':
                depth += 1
            elif sc[j] == '}':
                depth -= 1
                if depth == 0:
                    break
            j += 1
        body = sc[start:j + 1]
        # ⚠️ 判据别写成 `(?<![\w.])ctx\.` —— Python 的 `re` **不允许变长 lookbehind**，
        #    会抛 `re.error: look-behind requires fixed-width pattern`；而带这个错的正则若被
        #    try 吞掉，源码闸门就变成**永远静默通过**。
        #    ⚠️ 也别写成 `[^\w.]ctx\.`：`ctx.value.` 里 `ctx` 前面正好是空格（非 \w、非点），
        #    照样命中 → **假红**（本用例自己踩过一次）。判据用计数：裸 `ctx.` 的总次数
        #    必须与 `ctx.value.` 的次数相等（这一段的半截写法只有这一种）。
        #
        #    🔴 2026-10-14 收紧一处**假红**（旧版 `ctx.` 计数把 `strokeRiver(ctx.value, …)`
        #    这种"把解包后的 context 当实参传"的正确写法算成裸 ctx）。前两版判据一次假红
        #    一次假绿，都记在这里：
        #      ① 旧版：数 `ctx.` 与 `ctx.value.` 是否相等 → `ctx.value,` / `ctx.value;` 被误判；
        #      ② 第二版：正则只认"当方法/属性用" → 负向环视写宽了，`ctx.strokeStyle =` 漏掉（假绿）。
        #    现在改成**两步**，每步只负责一件事：
        #      a. 先把**合法的 `ctx.value`** 全部抹掉；
        #      b. 剩下还有 `ctx.` —— 那就是裸 ctx，数量必须为 0。
        #    它对写法不敏感（当实参 / 取出来赋值 / 当方法用，都以 `ctx.value` 开头），
        #    而 `ctx.save(` / `ctx.strokeStyle =` 这种漏写一定留下 `ctx.`。
        _stripped = body.replace('ctx.value', 'ctxV')
        ctx_bare = len(re.findall(r'(^|[^.\w])ctx\.', _stripped, re.M))
        ctx_value_refs = len(re.findall(r'(^|[^.\w])ctx\.value', body, re.M))
        if ctx_bare:
            fails.append(f'🔴 自动河流渲染块里有 {ctx_bare} 处裸 `ctx.`'
                         f'（ref 不解包 → 运行时 `ctx.save is not a function`，整帧后续全不画）'
                         f' [诊断 bare={ctx_bare} value={ctx_value_refs}; '
                         + ' || '.join(l.strip() for l in body.split('\n') if re.search(r'(^|[^.\w])ctx\.', l))
                         + ']')
        # 反向探针：把两种漏写形态喂进判据，必须都被抓到；同时确认"正确写法"不被误判。
        _probe_bad = 'x; ctx.save(); ctx.strokeStyle = "a"; const y = ctx.lineWidth;'
        _probe_good = 'x; ctx.value.save(); strokeRiver(ctx.value, poly); const c = ctx.value;'
        if len(re.findall(r'(^|[^.\w])ctx\.', _probe_bad.replace('ctx.value', 'ctxV'), re.M)) != 3:
            fails.append('裸 ctx 判据的反向探针失效（它抓不到 `ctx.save()` / `ctx.strokeStyle =`）')
        if re.search(r'(^|[^.\w])ctx\.', _probe_good.replace('ctx.value', 'ctxV'), re.M):
            fails.append('裸 ctx 判据的**正向探针**失效（它把正确的 `ctx.value` 用法判成裸 ctx 了）')
        if 'ctx.value.' not in body:
            fails.append('自动河流渲染块没有使用 ctx.value（判据锚点失效）')
        # 🔴 第二个 bug（同一天、同一段）：河流是 `{points, flow}` 对象，不是点数组 ——
        #    写成 `river[0].x` 会首帧抛 `Cannot read properties of undefined (reading 'x')`。
        if re.search(r'(^|[^.\w])river\[0\]\.', body, re.M):
            fails.append('🔴 渲染块仍按"点数组"访问河流（`river[0].x`）—— 现在每条河是 '
                         '`{points, flow}` 对象，取点必须走 `.points`')

    # ② 追踪算法必须在纯函数层，且 store 侧不许再留全表扫描
    if 'traceRivers' not in se:
        fails.append('store 没有调用纯函数 traceRivers（算法单一实现被破坏）')
    if 'for (let j = 0; j < n; j++)' in se:
        fails.append('🔴 store 里仍有 `for (let j = 0; j < n; j++)` 全表扫描（分钟级卡死的根因）')
    if 'function traceRivers' not in rt:
        fails.append('utils/riverTrace.js 里没有 traceRivers（算法层缺失）')
    if '统一' in rt and 'heapPush' not in rt:
        fails.append('riverTrace 没有用优先队列（洪泛口径被改动？）')

    # ③ 河流裁海岸线的接线在场（导入河不许再直接画原始点）
    if 'clipPolylinesToCoast' not in sc or 'buildLandMask' not in sc:
        fails.append('ScenarioMap 没有接上河流的海岸线裁剪（导入河又会画到海里）')
    if 'function clipPolylineToCoast' not in cl or 'function buildLandMask' not in cl:
        fails.append('utils/coastline.js 缺函数（掩膜 / 裁剪）')
    if 'getDisplayRivers()' not in sc:
        fails.append('drawRivers 没有走 getDisplayRivers（裁剪缓存没接上）')

    # ③b 🔴 2026-10-15 第四修的三条接线（都是用户拿截图报的，缺一条就回到老毛病）：
    #     · 树枝状汇聚 → 必须画**河网**（不是只画代表路径）
    #     · 越往下游越宽 → 必须把 `segMaxFlow`（归一化上界）传给画法
    #     · 不伸进海里 → 自动河的段也必须过 `clipSegmentToLand`（与导入河**同一份掩膜**）
    # 🔴 2026-10-17 第八修（用户「支气管模拟器」）：画法从**逐段**升级成**逐链** ——
    #    `strokeRiverNetwork(segments)` 换成 `buildRiverPaths()` + `strokeRiverNetworkAsPaths()`。
    #    为什么必须换：逐段画是"一格一根小棍"，每根独立描边、每根都是直线、段与段之间没有共享几何
    #    → 分叉处像"劈开的三根棍"，结构上不可能连成一条河。判据跟着产品口径改，
    #    但**守的东西不变**：必须有"从河网还原成链"这一步，且链仍要过线宽/裁剪/上界。
    if 'strokeRiverNetwork' not in sc and 'strokeRiverNetworkAsPaths' not in sc:
        fails.append('🔴 ScenarioMap 没有画河网（`strokeRiverNetwork` / `strokeRiverNetworkAsPaths`）—— '
                     '只画代表路径时「树枝状汇聚」结构上画不出来')
    if 'buildRiverPaths' not in sc:
        fails.append('🔴 没有把河网还原成**河链**（`buildRiverPaths`）—— '
                     '逐段画会退回"支气管"观感（一格一根小棍，接不成河）')
    if 'getAutoRiverNetwork' not in sc:
        fails.append('没有 getAutoRiverNetwork（段的裁剪缓存没接上 → 河会伸进海里）')
    if 'clipSegmentToLand' not in sc:
        fails.append('🔴 自动河的段没有裁到海岸线（`clipSegmentToLand`）—— 「过度延伸到海洋」会复发')
    if 'function clipSegmentToLand' not in cl:
        fails.append('utils/coastline.js 缺 clipSegmentToLand（段裁剪实现）')
    if 'maxFlow: autoRiverMaxFlow' not in sc:
        fails.append('🔴 画河网时没有传 `segMaxFlow` —— 线宽退回绝对口径，'
                     '这份地形上只有 1.4 倍变化（用户实测：「并没有越往下游越宽」）')

    # ⑤ 🔴 陆地判据必须是**掩膜独占**（2026-10-16 第五修）
    #    缘由：上一轮这里写的是并集（`mask.lookup(x,y) || heightIsLand(x,y)`），而真实底图实测
    #    （`scripts/tests/tools/_probe_phantom.mjs`，掩膜走产品自己的 buildLandMask）：
    #    **幻影格（高度说陆 / 省份说海）203 格 = 全部格点的 2.04%**，
    #    **145/1710 = 8.5%** 的段至少一端踩在上面 → 这些段在并集下两端都判陆 →
    #    `clipSegmentToLand` **整段跳过裁剪**。实测「两端都判陆」的段数：
    #    并集 **1034** vs 掩膜独占 **854** → **180 段**在并集下"不用裁"，其中相当一部分正是入海的。
    anchor_lc = 'function makeRiverLandCheck(mask)'
    i = sc.find(anchor_lc)
    if i < 0:
        fails.append('源码闸门：找不到 makeRiverLandCheck（陆地判据锚点失效，需同步更新本用例）')
    else:
        # 取到下一个顶层 `function ` 之前（= makeRiverLandCheck 的函数体）
        end = sc.find('\nfunction ', i + 1)
        lc = sc[i:end if end > 0 else len(sc)]
        if 'mask.lookup(x, y) || heightIsLand' in lc or '|| heightIsLand(x, y)' in lc:
            fails.append('🔴 陆地判据退回了**并集**（`mask.lookup || heightIsLand`）—— '
                         '真实底图 203 个幻影格会让 8.5% 的段端点被判为陆、整段跳过裁剪，河又会画进海里')
        if 'if (useMask) return (x, y) => !!mask.lookup(x, y);' not in lc:
            fails.append('🔴 掩膜在时没有**独占**（少了 `if (useMask) return (x, y) => !!mask.lookup(x, y);`）'
                         '—— 高度场的幻影格会重新混进来')
        if 'return heightIsLand;' not in lc:
            fails.append('🔴 掩膜缺席时没有回退到高度场（空底图/还没画省份的底图将生成不出河）')
        # 反向探针：并集写法必须能被上面的判据抓到
        _probe_union = 'if (useMask) { return (x, y) => mask.lookup(x, y) || heightIsLand(x, y); } return heightIsLand;'
        if not ('mask.lookup(x, y) || heightIsLand' in _probe_union):
            fails.append('并集判据的反向探针失效（抓不到并集写法）')

    # ⑥ 🔴 与「地图自带河流」的画法对齐（2026-10-16 第五修）
    #    用户三次报「色差 / 各画各的」。实测自带河 = `#5d97bb` 单遍、屏幕线宽 0.7~2.55px；
    #    上一轮自动河 = `#3B82F6` @0.35 宽×2.4 + 亮芯 → 一眼两套东西。
    rr = _code_only(_read('src/renderer/src/utils/riverRender.js'))
    if "export const BASEMAP_RIVER_COLOR = '#5d97bb'" not in rr:
        fails.append("🔴 riverRender 没有 BASEMAP_RIVER_COLOR = '#5d97bb'（自带河描边色的单一来源）")
    if 'export function basemapRiverWidthPx' not in rr:
        fails.append('🔴 riverRender 没有 basemapRiverWidthPx（自带河线宽公式的单一来源）')
    if 'export function flowToDischargeEquivalent' not in rr:
        fails.append('🔴 riverRender 没有 flowToDischargeEquivalent（flow→自带河 discharge 当量）')
    # 🔴 2026-10-17 第八修：画法改"逐链"后，这两条的**写法**变了，但守的东西一字不变：
    #     · 必须用自带河的颜色（`BASEMAP_RIVER_COLOR`）—— 否则色差复发；
    #     · 线宽必须是**屏幕像素**口径（画布已 `scale(cameraScale)`，所以必须 `/ cameraScale`
    #       换算回世界单位）—— 否则放大后河跟着变粗，比自带河粗一倍以上。
    #    ⚠️ 判据跟着产品口径改，但**不许放宽**：新写法仍然必须同时出现"用那个常量"与"除缩放"。
    if "color: BASEMAP_RIVER_COLOR" not in sc and "strokeStyle: BASEMAP_RIVER_COLOR" not in sc:
        fails.append('🔴 自动河没有用自带河的颜色画（`color: BASEMAP_RIVER_COLOR`）—— 色差会复发')
    if 'widthPx: (seg) =>' not in sc and 'pxToWorld' not in sc:
        fails.append('🔴 自动河没有做**屏幕像素**线宽换算（`widthPx` / `pxToWorld`）—— '
                     '它走世界单位会随缩放变粗，放大后比自带河粗一倍以上（色对齐了粗细仍不对）')
    # 反向探针：换算必须真的**除以相机缩放**（只写个 `pxToWorld` 变量名不算数）
    if 'pxToWorld' in sc and not re.search(r'1\s*/\s*Math\.max\([^)]*cameraScale', sc):
        fails.append('🔴 `pxToWorld` 存在但没有真的除以 `cameraScale` —— 屏幕像素口径是假的')
    if 'drawRivers' in sc and "c.strokeStyle = BASEMAP_RIVER_COLOR" not in sc:
        fails.append('🔴 drawRivers（自带河）没有共用 BASEMAP_RIVER_COLOR —— 两处又各写一份色值')
    if "c.strokeStyle = '#5d97bb'" in sc:
        fails.append("🔴 ScenarioMap 里仍有写死的 '#5d97bb' —— 该走 BASEMAP_RIVER_COLOR 常量")
    if 'const scaleW = r.discharge ?' in sc:
        fails.append('🔴 drawRivers 里仍有自己那份线宽公式（`const scaleW = r.discharge ? …`）'
                     '—— 两处各写一份就会漂移，必须共用 basemapRiverWidthPx')

    # ⑦ 🔴 河流来源开关（2026-10-16 第五修）：实测两套河**不是同一条河**（段到自带河最近距离
    #    中位 18.78 世界单位、只有 10% 在 3 单位内；反向只有 40% 的自带河顶点附近有自动河）
    #    → 既不能悄悄隐藏自带河（丢真实地理），也不能让用户永远看两套（"各画各的"）。
    #    判据要三件：开关在场、**两条渲染路径各自被它门控**、默认值没被改成破坏性的 `auto`。
    if "const riverSource = ref('both')" not in sc:
        fails.append("🔴 找不到 `const riverSource = ref('both')`（默认必须是「两套都画」= 零行为变更）")
    if 'const showRiverBase = computed(' not in sc:
        fails.append('🔴 缺 `showRiverBase`（自带河的门控）')
    if 'const showRiverAuto = computed(' not in sc:
        fails.append('🔴 缺 `showRiverAuto`（自动河的门控）')
    if 'if (showRiverBase.value) drawRivers(ctx.value);' not in sc:
        fails.append('🔴 `drawRivers`（自带河）没有走 `showRiverBase` —— 选「只画自动生成」时自带河藏不掉')
    if 'autoRivers.value.length > 0 && showRiverAuto.value' not in sc:
        fails.append('🔴 自动河没有走 `showRiverAuto` —— 选「只画底图自带」时自动河藏不掉')
    _watch = sc.split('watch([', 1)[1].split('], () => render())', 1)[0] if 'watch([' in sc else ''
    if 'riverSource' not in _watch:
        fails.append('🔴 `riverSource` 没进 render 的 watch 列表 —— 下拉改了画布不会重画（test_69 踩过同一条）')
    if 'data-testid="river-source"' not in sc:
        fails.append('🔴 缺 `data-testid="river-source"`（用例/演练要能点得到它）')
    if '只画底图自带' not in sc or '只画自动生成' not in sc:
        fails.append('🔴 河流来源下拉缺选项文字（只画底图自带 / 只画自动生成）—— 同「入口必须有可见文字」纪律')
    # ⑦b 源头高度闸门**够得着**（2026-10-14 第三轮 + 2026-10-17 第七修补进源码闸门）
    #     为什么它必须同时出现在源码闸门里：行为段测的是"调它条数会变"，而行为段只有在
    #     **控件存在**时才跑得下去；控件被谁挪进「更多」里（本项目真实发生过：用户找不到
    #     分辨率按钮）时，行为段会以"找不到输入"红掉，但那时已经跑完一整套浏览器环境。
    #     源码层先钉住 testid，是让"入口被挪走/改名"这条**最早**被指出，且指出得具体。
    if 'data-testid="river-source-height"' not in sc:
        fails.append('🔴 缺 `data-testid="river-source-height"`（源头高度闸门在 UI 上够不着）—— '
                     '实测它决定条数（默认 60 → 3 条、40 → 67 条），够不着就等于"河本来就少"')

    # ⑧ 🔴 追踪前平滑（2026-10-16）：实测唯一能让河"长出主干"的方向
    #    （最长河 140→270 世界单位）。三条纪律必须同时守：
    #    默认关（零行为变更）、真的把参数传进追踪器、**同时降源头闸门**（否则开了平滑一条河都没有）。
    if 'const riverSmooth = ref(false)' not in sc:
        fails.append('🔴 `riverSmooth` 默认必须是 `false`（零行为变更）')
    if 'data-testid="river-smooth"' not in sc:
        fails.append('🔴 缺 `data-testid="river-smooth"`（用例/演练要能点得到它）')
    if 'smoothRadius: riverSmoothRadius.value' not in sc:
        fails.append('🔴 平滑开关没有把 `smoothRadius` 传给追踪器 —— 勾了等于没勾')
    if 'RIVER_SMOOTH_SOURCE_HEIGHT' not in sc or 'sourceHeight: Math.min(' not in sc:
        fails.append('🔴 勾平滑时没有**同时下调源头高度闸门** —— 平滑压低山头，'
                     '实测 r=3 p=3 会直接 0 条河，用户只会看到"开了平滑反而没河了"')
    if 'if (r.smoothed)' not in sc:
        fails.append('🔴 平滑生效时回执里没有说明（用户无从理解"为什么闸门变成 40 了"）')
    # 追踪器侧：平滑必须在纯函数层、且默认不生效
    rt = _code_only(_read('src/renderer/src/utils/riverTrace.js'))
    if 'smoothHeightmapGrid' not in rt:
        fails.append('🔴 riverTrace 没有接 `smoothHeightmapGrid`（算法必须走产品已有实现，不许另写一份卷积）')
    if 'opts.smoothRadius > 0' not in rt:
        fails.append('🔴 平滑没有"只在传了 smoothRadius 时生效"的门 —— 默认行为会被改掉')
    # ⚠️ 本用例**收尾时按 60 还原**那个输入框，所以"60 就是产品默认"这件事必须有闸门钉住：
    #    常量改了而这里没改 → 用例会把一个**非默认**的闸门留给后面在同一页面里顺序跑的用例
    #    （闸门直接决定条数：60 → 2072 条、40 → 3108 条）。宁可在源码层红。
    if 'export const TRACE_SOURCE_HEIGHT = 60' not in rt:
        fails.append('🔴 `TRACE_SOURCE_HEIGHT` 不再是 60 —— 本用例收尾按 60 还原源头高度输入框，'
                     '常量一改这个还原值就不再是默认值（会把非默认闸门留给后续用例）。'
                     '请同步更新收尾里的 `inp.value = \'60\'`')

    # ④ 渲染护栏必须给出**画布上的**横幅 + 错误原文（用户原话「一点提示都没有吗」）
    if 'render-paused-card' not in sc:
        fails.append('渲染护栏没有画布横幅（状态栏那行不足以让用户看到）')
    if 'data-testid="render-paused-error"' not in sc:
        fails.append('渲染护栏横幅没有展示错误原文')

    # ⚠️ 条数**从源码现算**（本函数里 `fails.append` 的站点数，含各处反向探针）——
    #    手写的数字一定会腐烂：上一版写死"24 项"，而实际站点数早已不是 24
    #    （判据加了、反向探针加了，标签却没人改 → 回执读数是错的）。
    _seg = _code_only(_read('scripts/tests/cases/test_103_auto_rivers.py'))
    _seg = _seg.split('def source_gates(', 1)[1].split('\ndef run(', 1)[0]
    _sites = len(re.findall(r'fails\.append\(', _seg))
    notes.append(f'源码闸门 {_sites} 处断言' + ('全过' if not fails else f'缺 {len(fails)}'))
    return fails, notes


def run(cdp):
    fails, notes = source_gates()

    ok, info = ensure_case_state(cdp)
    if not ok:
        return False, f'用例基线项目未就绪：{info}'

    cdp.eval(
        "(() => { const b = Array.from(document.querySelectorAll('button'))"
        ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()"
    )
    try:
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式挂载')
    except RuntimeError as e:
        return False, f'剧本模式未挂载：{e}'
    time.sleep(1.2)

    key = 'case103'
    ok_bm, info_bm = open_test_base_map(cdp, key, '用例103底图')
    if not ok_bm:
        return False, f'用例底图未就绪：{info_bm}'
    time.sleep(0.6)

    # ── 造数据：新建高度图 + 写入一块"北高南低"的斜地形 ────────────────────────
    setup_js = r""" (async () => {
  const s = __STORE__, sm = __SC__;
  const KEY = __KEY__;
  const out = { ok: false };
  s.createBaseMapHeightmap(KEY);
  const hm = s.getHeightmapFor(KEY);
  if (!hm || !hm.grid || !hm.grid.points) { out.why = 'no-heightmap'; return JSON.stringify(out); }
  const n = hm.h.length;
  const rows = hm.grid.cellsY, cols = hm.grid.cellsX;
  // 上 2/3 是高地（100 → 30），下 1/3 是海（0）—— 保证有源头、也有入海口
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      hm.h[i] = r < rows * 0.66 ? (100 - r * (70 / (rows * 0.66))) : 0;
    }
  }
  s.commitHeightmap(KEY, hm);
  const hm2 = s.getHeightmapFor(KEY);
  out.ok = true;
  out.cells = n; out.cols = cols; out.rows = rows;
  out.land = Array.from(hm2.h).filter(v => v >= 20).length;
  out.sea = Array.from(hm2.h).filter(v => v < 20).length;
  // 打开「更多」工具栏，让「自动河流」按钮真的进 DOM（它是 UI 入口，不能绕过）
  const toggle = document.querySelector('.more-toggle');
  if (toggle) toggle.click();
  await new Promise(r => setTimeout(r, 60));
  out.hasButton = Array.from(document.querySelectorAll('button'))
    .some(b => (b.textContent || '').includes('自动河流'));
  return JSON.stringify(out);
})() """.replace('__STORE__', STORE).replace('__SC__', SC).replace('__KEY__', repr(key))

    r = eval_json(cdp, setup_js, required=None, desc='造地形')
    if not (isinstance(r, tuple) and r[0]):
        return False, f'造地形探针失败：{r[1] if isinstance(r, tuple) else r}'
    r = r[1]
    if not r.get('ok'):
        return False, f'造地形失败：{r}'
    if not r.get('hasButton'):
        fails.append('「自动河流」按钮不在 DOM 里（更多工具栏没打开？）')
    if not r.get('land') or not r.get('sea'):
        return False, f'地形数据不对（land={r.get("land")} sea={r.get("sea")}）'
    notes.append(f"地形 {r['cols']}×{r['rows']}={r['cells']} 格，陆 {r['land']} / 海 {r['sea']}")

    # ── 端到端：点按钮（真 UI）────────────────────────────────────────────────
    click_js = r""" (async () => {
  const sm = __SC__;
  const btn = Array.from(document.querySelectorAll('button'))
    .find(b => (b.textContent || '').includes('自动河流'));
  if (!btn) return JSON.stringify({ clicked: false });
  const t0 = performance.now();
  btn.click();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const dt = performance.now() - t0;
  const rs = sm.autoRivers || [];
  const pts = rs.reduce((a, r2) => a + ((r2 && r2.points) ? r2.points.length : 0), 0);
  return JSON.stringify({
    clicked: true,
    count: rs.length,
    pts,
    withFlow: rs.filter(r2 => r2 && typeof r2.flow === 'number').length,
    withPoints: rs.filter(r2 => r2 && Array.isArray(r2.points)).length,
    ms: Math.round(dt),
    renderPaused: !!sm.renderPaused,
    renderErrorCount: sm.renderErrorCount === undefined ? null : sm.renderErrorCount,
    renderError: String(sm.renderError || ''),
    status: String(sm.provinceHint || ''),
  });
})() """.replace('__SC__', SC)

    got = eval_json(cdp, click_js, required=None, desc='点自动河流')
    if not (isinstance(got, tuple) and got[0]):
        return False, f'点「自动河流」探针失败：{got[1] if isinstance(got, tuple) else got}'
    got = got[1]
    if not got.get('clicked'):
        return False, f'没找到/点不动「自动河流」按钮：{got}'
    notes.append(f"点一次：{got.get('count')} 条 / {got.get('pts')} 点 / {got.get('ms')} ms"
                 f" / 状态栏「{got.get('status')}」")

    if got.get('count', 0) <= 0:
        fails.append('点了「自动河流」一条河都没出（斜地形上必然有源头）')
    if got.get('withPoints', 0) != got.get('count'):
        fails.append(f"有 {got.get('count', 0) - got.get('withPoints', 0)} 条河没有 points 数组"
                     f"（渲染块按 river[0] 取点会首帧崩）")
    if got.get('withFlow', 0) != got.get('count'):
        fails.append(f"有 {got.get('count', 0) - got.get('withFlow', 0)} 条河没有 flow 字段（线宽分级会失效）")
    if got.get('renderPaused'):
        fails.append(f"🔴 渲染被暂停了：{got.get('renderError')}")
    if got.get('renderError') or (got.get('renderErrorCount') or 0) > 0:
        fails.append(f"🔴 渲染抛了异常（这正是 2026-10-14 的崩溃）：{got.get('renderError')}")
    if '生成' not in str(got.get('status', '')) or '条河流' not in str(got.get('status', '')):
        fails.append(f"状态栏没有回执（用户原话「一点提示都没有吗」）：{got.get('status')}")

    # ── 闸门**够得着**（2026-10-14 第三轮；这条是"参数存在但用户碰不到"的守卫）─────
    # 实测背景：这份地形的源头高度闸门恰好决定条数（默认 60 → 3 条；40 → 67 条）。
    # 只报"生成 N 条"而不给读数/旋钮，用户会以为"河就是少的"。
    gate_js = r""" (async () => {
  const sm = __SC__;
  const out = {};
  const inp = document.querySelector('[data-testid="river-source-height"]');
  out.hasInput = !!inp;
  out.initial = inp ? Number(inp.value) : null;
  const status0 = String(sm.provinceHint || '');
  out.statusHasGate = /源头高度/.test(status0);
  // 把闸门拉到 0（最宽松）→ 源头应当**明显变多**（同一份地形、同一套算法）
  if (inp) {
    inp.value = '0';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }
  await new Promise(r => setTimeout(r, 80));
  const btn = Array.from(document.querySelectorAll('button'))
    .find(b => (b.textContent || '').includes('自动河流'));
  if (btn) btn.click();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  out.loose = (sm.autoRivers || []).length;
  out.statusLoose = String(sm.provinceHint || '');
  // 再把闸门拉到 90（最严）→ 源头应当**明显变少**
  if (inp) {
    inp.value = '90';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }
  await new Promise(r => setTimeout(r, 80));
  if (btn) btn.click();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  out.strict = (sm.autoRivers || []).length;
  out.statusStrict = String(sm.provinceHint || '');
  out.renderPaused = !!sm.renderPaused;
  out.renderError = String(sm.renderError || '');
  return JSON.stringify(out);
})() """.replace('__SC__', SC)
    gate = eval_json(cdp, gate_js, required=None, desc='源头高度闸门')
    gate = gate[1] if isinstance(gate, tuple) and gate[0] else {'err': gate}
    if gate.get('err'):
        fails.append(f'闸门探针求值异常：{gate.get("err")}')
    else:
        if not gate.get('hasInput'):
            fails.append('🔴 找不到「源头高度」输入（`river-source-height`）—— 闸门决定条数却够不着，'
                         '用户只会看到"就 3 条河"')
        if not gate.get('statusHasGate'):
            fails.append(f"状态栏回执里没有闸门读数（「源头高度」）：{gate.get('statusLoose')}")
        # 闸门必须**真的**改变出图条数：松 → 多、严 → 少（同输入同算法，只差这一个参数）
        if not (gate.get('loose', 0) > gate.get('strict', 0)):
            fails.append(f"🔴 调闸门没有改变条数（松 {gate.get('loose')} vs 严 {gate.get('strict')}）"
                         f"—— 那个输入框是个摆设")
        else:
            notes.append(f"闸门：源头高度 0 → {gate.get('loose')} 条；90 → {gate.get('strict')} 条")
        if gate.get('renderPaused') or gate.get('renderError'):
            fails.append(f"🔴 调闸门之后渲染异常：{gate.get('renderError')}")
    # 把闸门恢复默认（别把改动留给后面的断言与后续用例）
    cdp.eval("(() => { const i = document.querySelector('[data-testid=\"river-source-height\"]');"
             " if (i) { i.value = '60'; i.dispatchEvent(new Event('input', { bubbles: true })); } return 'ok'; })()")

    # ── 河口不出海：末端必须落在海格里 ────────────────────────────────────────
    ends_js = r""" (() => {
  const s = __STORE__, sm = __SC__;
  const KEY = __KEY__;
  const hm = s.getHeightmapFor(KEY);
  const pts = hm.grid.points, h = hm.h, cols = hm.grid.cellsX, rows = hm.grid.cellsY;
  const sp = hm.grid.spacing || 14.4;
  const p0 = pts[0];
  const x0 = Array.isArray(p0) ? p0[0] : p0.x;
  const y0 = Array.isArray(p0) ? p0[1] : p0.y;
  const cellOf = (x, y) => {
    const ci = Math.round((x - x0) / sp), cj = Math.round((y - y0) / sp);
    if (ci < 0 || ci >= cols || cj < 0 || cj >= rows) return -1;
    return cj * cols + ci;
  };
  let bad = 0, checked = 0;
  for (const riv of (sm.autoRivers || [])) {
    const rp = riv && riv.points;
    if (!rp || rp.length < 2) continue;
    const e = rp[rp.length - 1];
    const i = cellOf(e.x, e.y);
    checked++;
    if (i < 0 || h[i] >= 20) bad++;
  }
  return JSON.stringify({ checked, bad });
})() """.replace('__STORE__', STORE).replace('__SC__', SC).replace('__KEY__', repr(key))
    ends = eval_json(cdp, ends_js, required=None, desc='河口判定')
    ends = ends[1] if isinstance(ends, tuple) and ends[0] else {'bad': -1, 'err': ends}
    if ends.get('bad', -1) != 0:
        fails.append(f"有 {ends.get('bad')} 条河的末端不在海里"
                     f"（追到一半就断了 / 走上坡）：{ends}{_probe_err(ends)}")
    elif not ends.get('checked'):
        # ⚠️ 判据强度：`bad == 0` 也可能是"一条都没检查"（空集合恒真 = 静默假绿）。
        #    先证明**真的量到了东西**，再认那个 0。
        fails.append(f"🔴 没有可判定的河口（checked={ends.get('checked')}）—— "
                     f'"末端都在海里"这条判据是空转的（0 条被检查）')
    else:
        notes.append(f"河口：{ends.get('checked')} 条河的末端**全部**落在海格里"
                     f"（水只往低处流、追到海就停）")

    # ── 画布像素：真的画出来了（2026-10-14 改：按**颜色集合 + 前后差异**判，不锁单一色）──
    # 为什么改：画法从"一条实线"改成**两遍描边**（外层浅色 `#4f93b8` + 内层亮芯 `#9fd0ea`），
    # 锁单一 RGB 会让"改对了观感"反而把用例弄红。判据改成两条都认：
    #   ① 画布上出现河的颜色；② 点按钮**之后**画布真的多了像素（对照点之前）。
    #   🔴 2026-10-16 第五修：颜色口径改了 —— 自动河现在画的是**自带河那个色**（`#5d97bb`），
    #      不再是 `#3B82F6` 描边 + `#93c5fd` 亮芯（那是"三种蓝"与色差的来源）。
    #      ⚠️ 判据必须跟着产品口径走：这里若还数旧色，会出现「明明画了却说画布上没有」的**假红**
    #         （本轮实测就是这样：hits=0，而画布上确实有河）—— 反过来，判据比产品宽又会假绿。
    #   探针返回：自带河色的像素数（`base`）+ 旧两色（`legacy`，正常情况下应为 0）。
    #   🔴 2026-10-17 第六修：判据改成**帧差**（这是"画出来了"的唯一严谨定义）。
    #      两次改法都被实测否定，留档：
    #        ① 原判据：把画布**降采样到 420×300** 再数 `#5d97bb` 的**通色值**像素。
    #           线宽收到 1.2 屏幕像素后，亚像素线经抗锯齿**没有纯色像素** → hits=0 假红
    #           （实测全分辨率下有 12296 个"真的变了"的像素）。
    #        ② 第二版：改成"离河色比离**地形色**近"。实测**地形参考色取错了**
    #           （左下角是画布外的网格 26,42,58，不是地形 201,138,91）→ 半个画布被算成河。
    #           即便取对，这个判据也只会**召回 23%** 的真值像素（抗锯齿把细线摊薄了）。
    #      ⇒ 现在：渲染两次（无河 / 有河）逐像素对比，变了的就是河。
    #        实测召回/精确都是 100%（真值 12296 像素），且对线宽/配色/缩放**全都不敏感** ——
    #        它量的是"用户看得见的变化"，正是这条判据该管的事。
    pix_js = r""" (() => {
  // 🔴 全段包 try/catch 并逐段记 `stage`：判据红的时候必须**带回现场**。
  //    本用例自己踩过：探针里抛了异常 → 读数变成 None → 红的那句话只说"帧差为 0"，
  //    真正的原因（哪一步、什么异常）全丢了，只能再跑一遍两分钟的用例去猜。
  const out = { stage: 'init' };
  try {
  const sm = __SC__;
  const cvs = document.querySelector('.scenario-map-container canvas');
  if (!cvs) { out.err = 'no-canvas'; return JSON.stringify(out); }
  out.W = cvs.width; out.H = cvs.height;
  const c = cvs.getContext('2d');
  if (!c) { out.err = 'no-2d-context'; return JSON.stringify(out); }
  // 🔴 2026-10-17 第六修（产品侧同批改动）：`render()` 现在**做帧合并** —— 同一帧内
  //    （15ms 以内）的第二次调用会推迟到下一帧 rAF，于是"改数据 → render() → 立刻取像素"
  //    会取到**上一帧**（差值恒为 0 → 判据变成空转/假红）。产品给这种"必须立刻出像素"
  //    的调用方留了同步口 `renderNow()`；写成 `typeof` 探测是为了对**没有** renderNow 的
  //    旧版本也成立（那时 render() 本来就是同步的）。
  out.hasRenderNow = (typeof sm.renderNow === 'function');
  const draw = () => { if (out.hasRenderNow) sm.renderNow(); else sm.render(); };
  // 🔴 尺寸必须**在每次快照时现读**，不能用探针开头读的那一份：`renderFrame()` 会按
  //    canvas 的 CSS 尺寸×DPR 重设 `canvas.width/height`，而状态栏文本一变（本用例点一次
  //    自动河流就会写一行很长的回执）画布高度就会变 → 拿旧尺寸去 `getImageData` 会**越界**
  //    （Chrome 对宽/高为 0 的取像素直接抛 `IndexSizeError`）→ 探针变成 "求值异常"、
  //    读数变成 None（本用例第一次跑就是这么红的：判据本身没毛病，探针先炸了）。
  //    两帧尺寸不一致时**明确报错**而不是硬算差值 —— 尺寸不同的帧差没有意义。
  const snap = () => {
    draw();
    const w = cvs.width, h = cvs.height;
    if (!w || !h) return null;
    return { w, h, data: c.getImageData(0, 0, w, h).data.slice() };
  };
  // 把"自动河"关掉拍一张（段也要清 —— 渲染读的是段，不是代表路径）
  const savedR = sm.autoRivers, savedS = sm.autoRiverSegments;
  out.savedRivers = (savedR || []).length; out.savedSegs = (savedS || []).length;
  out.stage = 'clear';
  sm.autoRivers = []; sm.autoRiverSegments = [];
  out.stage = 'snapA';
  const A = snap();
  out.stage = 'restore';
  sm.autoRivers = savedR; sm.autoRiverSegments = savedS;
  out.stage = 'snapB';
  const B = snap();
  if (!A || !B) { out.err = 'canvas-zero-size'; return JSON.stringify(out); }
  if (A.w !== B.w || A.h !== B.h) {
    // 两帧尺寸不同 → 逐像素比对**没有意义**（不是"没画河"，是"画布被改了尺寸"）。
    // 明确报错，绝不返回一个看起来像读数的假数字。
    out.err = 'canvas-resized-between-snaps';
    out.Awh = A.w + 'x' + A.h; out.Bwh = B.w + 'x' + B.h;
    return JSON.stringify(out);
  }
  const Ad = A.data, Bd = B.data;
  // ── 退役色残留（只判"近精确"，松口径只报数）────────────────────────────────
  // 🔴 2026-10-17 第七修：原来这里判的是"离退役色比离河色**近**"（最近邻口径），
  //    而那个口径会**假红**：细河线抗锯齿之后，河色 `#5d97bb` 与浅色地形按 3:7 混出来的
  //    像素完全可能"离旧亮芯更近"。实算一例（浅绿地 168,200,138）：
  //      0.3*(93,151,187) + 0.7*(168,200,138) = (145,185,153)
  //      到旧亮芯 (147,197,253) 的 L1 距离 = 114；到河色 = 120 → **被判成"亮芯残留"**。
  //    也就是说：产品**越是对齐自带河（单遍细线）**，这种混合边像素越多 —— 判据反而越红。
  //    现在改成两档：
  //      · `exact*`（ΔRGB ≤ 12，**近精确**）= 画布上**真的**用了那两枚退役色 —— 这才是判据。
  //        实心亮芯描边会留下成千上万个近精确像素，所以它的**判别力没有丢**；
  //      · `near*`（老口径）只**报数**供诊断，不作判据（它的读数含抗锯齿混合，不可当证据）。
  out.stage = 'scan';
  const RIVER = [0x5d, 0x97, 0xbb];
  const LEGACY_STROKE = [0x3b, 0x82, 0xf6];
  const LEGACY_CORE = [0x93, 0xc5, 0xfd];
  const dist = (r, g, b, t) => Math.abs(r - t[0]) + Math.abs(g - t[1]) + Math.abs(b - t[2]);
  let hits = 0, exactStroke = 0, exactCore = 0, nearStroke = 0, nearCore = 0;
  for (let i = 0; i < Ad.length; i += 4) {
    const dd = Math.abs(Ad[i] - Bd[i]) + Math.abs(Ad[i + 1] - Bd[i + 1]) + Math.abs(Ad[i + 2] - Bd[i + 2]);
    if (dd > 8) {
      hits++;
      const p = [Bd[i], Bd[i + 1], Bd[i + 2]];
      const dRiver = dist(p[0], p[1], p[2], RIVER);
      const dS = dist(p[0], p[1], p[2], LEGACY_STROKE);
      const dC = dist(p[0], p[1], p[2], LEGACY_CORE);
      if (dS <= 12) exactStroke++;
      if (dC <= 12) exactCore++;
      if (dS < dRiver) nearStroke++;
      if (dC < dRiver) nearCore++;
    }
  }
  out.stage = 'done';
  out.W = A.w; out.H = A.h;
  out.base = hits; out.hits = hits;
  out.exactStroke = exactStroke; out.exactCore = exactCore;
  out.nearStroke = nearStroke; out.nearCore = nearCore;
  } catch (e) {
    out.err = String((e && e.message) || e);
    out.stack = String((e && e.stack) || '').split('\n').slice(0, 2).join(' | ').slice(0, 240);
  }
  return JSON.stringify(out);
})() """.replace('__SC__', SC)
    # 先清掉自动河流拍一张"没河"的底图，作为差异对照（否则"有没有画"这条判据是空转）
    # ⚠️ 必须**连段一起清**（渲染读的是段，不是代表路径 —— 只清 autoRivers 是空转，
    #    这正是本条判据以前"0 → 0"假红的原因之一）。
    # ⚠️ 也必须走**同步口** renderNow()：产品第六修改成帧合并之后，`render()` 在同一帧内
    #    的第二次调用会被推迟到下一帧 rAF → 下面的探针取到的还是"有河"那一帧。
    cdp.eval(f"(() => {{ const sm = {SC}; sm.autoRivers = []; sm.autoRiverSegments = [];"
             f" if (typeof sm.renderNow === 'function') sm.renderNow(); else sm.render();"
             f" return 'ok'; }})()")
    time.sleep(0.3)
    before = eval_json(cdp, pix_js, required=None, desc='点之前的画布')
    before = before[1] if isinstance(before, tuple) and before[0] else {'err': before}
    # ⚠️ 「点之前」这一张是**负向对照**：此刻自动河已被清空，探针必须读出 0。
    #    它若不是 0，说明帧差里混进了与自动河无关的变化（判据就没有判别力）。
    notes.append(f"负向对照（清掉自动河后）帧差 {before.get('hits') if isinstance(before, dict) else before}"
                 f"{_probe_err(before)}")
    # 再点一次按钮（真 UI），恢复自动河流
    cdp.eval("""(() => {
  const btn = Array.from(document.querySelectorAll('button'))
    .find(b => (b.textContent || '').includes('自动河流'));
  if (btn) btn.click();
  return 'ok';
})()""")
    time.sleep(0.4)
    pix = eval_json(cdp, pix_js, required=None, desc='画布像素')
    pix = pix[1] if isinstance(pix, tuple) and pix[0] else {'err': pix}
    if not isinstance(pix, dict) or pix.get('hits', 0) <= 0:
        fails.append(f"画布**帧差为 0** —— 点完「自动河流」画布上没有任何变化"
                     f"（hits={pix.get('hits') if isinstance(pix, dict) else pix}）"
                     f"{_probe_err(pix)}"
                     f"—— 没有崩溃却什么都没画（或探针没走同步口 renderNow 拿到了上一帧）")
    else:
        notes.append(f"画布帧差 {pix['hits']} 像素（退役色**近精确**残留：旧描边 #3B82F6 "
                     f"{pix.get('exactStroke')} / 旧亮芯 #93c5fd {pix.get('exactCore')}；"
                     f"松口径近邻计数 {pix.get('nearStroke')}/{pix.get('nearCore')}（含抗锯齿混合，仅诊断）；"
                     f"采样 {pix.get('W')}×{pix.get('H')}；renderNow={'有' if pix.get('hasRenderNow') else '无'}）")
        # 🔴 颜色对齐的**反面判据**：自动河不该再画退役的亮芯色（否则又回到"同一画面三种蓝"）。
        #    ⚠️ 只认**近精确**（ΔRGB ≤ 12）：老口径"离退役色比离河色近"会把抗锯齿混合边
        #       算成亮芯（实算反例见探针里的注释）→ 产品越对齐越红，那是**假红**。
        #       实心亮芯描边会留下成千上万个近精确像素，所以判别力没有丢。
        if pix.get('exactCore', 0) > 0:
            fails.append(f"🔴 画布上仍有亮芯色 #93c5fd 的**近精确**像素（{pix.get('exactCore')} 个）—— "
                         f"自动河又画成两遍高光了，与自带河（单遍实线）不是一套观感")
    # 🔴 负向对照必须为 0：清空自动河之后帧差若不是 0，说明这个探针量的东西**不止是自动河**
    #    （背景在动 / 探针自己改坏了状态）→ 那"帧差 > 0"也就不能证明"河画出来了"。
    if isinstance(before, dict) and before.get('hits'):
        fails.append(f"🔴 负向对照不为 0：清空自动河之后画布仍有 {before.get('hits')} 个像素在变"
                     f"—— 帧差里混进了与自动河无关的变化，判据失去判别力")
    if isinstance(pix, dict) and isinstance(before, dict) and pix.get('hits', 0) <= (before.get('hits') or 0):
        fails.append(f"点了「自动河流」之后画布**没有变化**（{before.get('hits')} → {pix.get('hits')}）"
                     f"{_probe_err(pix)}—— 「找到了颜色的像素」可能是画布上本来就有的东西")

    # ── 树枝状汇聚 + 越往下游越宽 + 不伸进海里（2026-10-15 第四修，用户实测截图）────
    # 三条都是**用户拿截图报的**，所以判据必须是"结构 + 几何 + 线宽"三件，
    # 而不是"点完了没崩"：
    #   ① 树枝状 = 河网**段**（逐格）在场，且比代表路径覆盖得宽（后者只有 12~270 个点）；
    #   ② 越往下游越宽 = **归一化**线宽口径下最细/最粗的比值（旧绝对口径只有 1.4 倍）；
    #   ③ 不伸进海里 = 段的**陆端**必须落在陆地掩膜内（掩膜与导入河同一份）。
    net_js = r""" (() => {
  const sm = __SC__, s = __STORE__;
  const segs = sm.autoRiverSegments || [];
  const maxF = sm.autoRiverMaxFlow || 0;
  const hm = s.getHeightmapFor(sm.baseMapKey);
  // 陆地掩膜：与组件里 `getLandMask()` 同一份实现（省份多边形 + 射线法）
  const rings = [];
  for (const poly of ((sm.baseMap && sm.baseMap.terrain) || [])) {
    if (!poly || poly.kind === 'sea') continue;
    const pts = poly.points || [];
    if (pts.length < 3) continue;
    rings.push(pts.map(p => [Array.isArray(p) ? p[0] : p.x, Array.isArray(p) ? p[1] : p.y]));
  }
  const inRing = (r, x, y) => {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const onLand = (x, y) => rings.some(r => inRing(r, x, y));
  let outside = 0, checked = 0;
  for (const g of segs) {
    // 只判**陆端**：入海段的另一端本来就在海里（那正是要保留的"咬住海面"）
    const pts = g.endInSea ? [[g.x0, g.y0]] : [[g.x0, g.y0], [g.x1, g.y1]];
    for (const [x, y] of pts) { checked++; if (rings.length && !onLand(x, y)) outside++; }
  }
  // 线宽口径：把段汇流量按归一化口径换算一遍，量最细到最粗的比值
  const wOf = (f) => {
    const t = Math.max(0, Math.min(1, (f - 1) / (Math.max(maxF, 2) - 1)));
    return 0.8 + (5.0 - 0.8) * Math.sqrt(t);
  };
  const flows = segs.map(g => g.flow);
  const minF = Math.min(...flows), maxF2 = Math.max(...flows);
  // 代表路径覆盖多少**格**（用格号去重最稳；坐标去重会被浮点坑到）
  const pathCellSet = new Set();
  for (const r of (sm.autoRivers || [])) {
    const rp = (r && r.points) || [];
    for (const p of rp) pathCellSet.add(Math.round(p.x * 100) + ':' + Math.round(p.y * 100));
  }
  return JSON.stringify({
    segs: segs.length, maxFlow: maxF, rings: rings.length,
    checked, outside,
    pathCells: pathCellSet.size,
    minF, maxF2, wMin: +wOf(minF).toFixed(2), wMax: +wOf(maxF2).toFixed(2),
    ratio: +(wOf(maxF2) / wOf(minF)).toFixed(2),
    renderPaused: !!sm.renderPaused, renderError: String(sm.renderError || ''),
  });
})() """.replace('__SC__', SC).replace('__STORE__', STORE)
    net = eval_json(cdp, net_js, required=None, desc='河网/线宽/海岸线')
    net = net[1] if isinstance(net, tuple) and net[0] else {'err': net}
    if net.get('err') or net.get('segs') is None:
        fails.append(f'河网探针求值异常：{net.get("err") or net}')
    else:
        if not net.get('segs'):
            fails.append('🔴 没有河网段（`autoRiverSegments` 为空）—— 「树枝状汇聚」结构上画不出来'
                         '（用户实测原话：「根本画不出复杂的河流汇聚」）')
        else:
            notes.append(f"河网 {net['segs']} 段 / 段汇流量 {net['minF']}~{net['maxF2']}")
        if net.get('ratio', 0) <= 3:
            fails.append(f"🔴 线宽最细/最粗只有 {net.get('ratio')} 倍（要求 >3）—— "
                         f"「越往下游越宽」看不出来（用户实测：「河流并没有越往下游越宽」）")
        else:
            notes.append(f"线宽归一化：{net['wMin']} → {net['wMax']} 世界单位（{net['ratio']}×）")
        if net.get('rings') and net.get('outside', 0) > 0:
            fails.append(f"🔴 有 {net.get('outside')}/{net.get('checked')} 个**陆端**落在陆地掩膜之外 —— "
                         f"河又伸进海里了（用户实测：「依然过度延伸到海洋部分」）")
        elif net.get('rings'):
            notes.append(f"海岸线：{net['checked']} 个陆端全部在陆地内")
        if net.get('renderPaused') or net.get('renderError'):
            fails.append(f"🔴 画河网之后渲染异常：{net.get('renderError')}")

    # ── 河网段与代表路径的**覆盖**（树枝状 vs 几根孤立线的量纲差别）─────────────
    # 真实底图实测：代表路径只有 12~270 个**去重格**，而陆地 2506 格 → 结构上不可能有
    # 树枝状汇聚；段是逐格的（desite 实测 1717 段 / 覆盖 1717 格）。
    # ⚠️ 判据必须是**格**而不是**点**：代表路径每条有 5~6 个点，点数天然可能多于段数
    #    （第一版用了点数 → 假红）。段自带 `cell`（格号），用它去重最稳。
    if isinstance(net, dict) and not net.get('err'):
        segs_n = net.get('segs') or 0
        path_cells = net.get('pathCells') or 0
        if segs_n and path_cells and segs_n <= path_cells:
            fails.append(f"河网段覆盖（{segs_n} 格）没有超过代表路径覆盖（{path_cells} 格）—— "
                         f'段没有起到「逐格河网」的作用（树枝状汇聚结构上画不出来）')
        elif segs_n:
            notes.append(f"覆盖对比：河网 {segs_n} 格 vs 代表路径 {path_cells} 格")

    # ── ⑪ 剪枝强度与**拓扑保留**（2026-10-17 第七修）────────────────────────────
    # 为什么必须单独守：第六修给渲染加了 `pruneRiverNetwork`（只画流量最高的那一档），
    # 而**已落地的三条判据全都对它不敏感** —— "帧差 > 0"、"三档互不相同"、"覆盖 > 代表路径"
    # 在"剪成一堆互不相连的短刺"时照样全绿。产品自己就踩过：格键没量化（浮点坐标做字符串键）
    # → 拓扑补段全匹配不上 → 3750 段只留 **26 段**，画布上"有河但很稀"，**不报错**
    # （见 `riverRender.js:119` 的留档）。
    #
    # 🔴 **本段为什么不能直接调 `pruneRiverNetwork`（这是本轮实测到的硬事实，值得复用）**：
    #    `__vueParentComponent.setupState` **只暴露组件自己的顶层绑定，不暴露 import**。
    #    实测（用仓库里的 `@vue/compiler-sfc` 编译本组件，看 `__returned__` 的 624 个绑定）：
    #      · `riverFlowGate` / `getAutoRiverNetwork` / `autoRiverDrawn` / `autoRiverSegments` /
    #        `screenToWorld` / `render` / `renderNow` → **在里面**；
    #      · `pruneRiverNetwork` / `riverFlowGateByQuantile`（import 进来的）→ **不在**。
    #    所以判据只能落在**暴露出来的产品口径**上：产品自己的闸门函数 + 产品自己报的落笔段数。
    #
    # 三条判据（都用暴露口径，不另写剪枝算法）：
    #   ① 真的剪了、且没剪空：`0 < 落笔 < 总段数`；
    #   ② 剪得不过分：`落笔 ≥ 5%`（12% 是设计值；5% 只用来抓"剪坏了"，不把策略写进用例）；
    #   ③ **上面的段一条都不许丢，而且必须补出"边界层"**：
    #      `落笔 ≥ 强段数`（flow ≥ 闸门的段必须全在）+ `落笔 > 强段数`。
    #      第二条才是真正抓那个历史 bug 的：规则②（"下游被留下就留下"）一旦因为键不匹配失效，
    #      落笔集合就**恰好等于强段集合**（`落笔 == 强段数`）→ 河网碎成短刺而计数看起来"正常"。
    #      ⚠️ 它与暮雨要的"沿下游走必须接到另一条被保留的段"是**同一个谓词的可观测形式**：
    #        "边界层存在" ⟺ "至少有一条弱段的下游是强段且被补进来了"。
    prune_js = r""" (() => {
  const out = { stage: 'init' };
  try {
    const sm = __SC__;
    const segs = sm.autoRiverSegments || [];
    out.segs = segs.length;
    if (!segs.length) { out.err = 'no-segments'; return JSON.stringify(out); }
    if (typeof sm.riverFlowGate !== 'function') {
      out.err = 'no-gate-api'; out.hasGate = (typeof sm.riverFlowGate);
      return JSON.stringify(out);
    }
    if (typeof sm.autoRiverDrawn !== 'number') {
      out.err = 'no-drawn-count';                      // 回执口径的"落笔段数"没暴露
      out.drawnType = (typeof sm.autoRiverDrawn);
      return JSON.stringify(out);
    }
    out.stage = 'gate';
    // 产品自己的闸门（分位口径，`riverFlowGate` 是组件顶层函数 → 暴露）
    const gate = sm.riverFlowGate(sm.autoRiverMaxFlow || 0, segs);
    out.gate = gate;
    let strong = 0;
    for (const s of segs) {
      const f = Number.isFinite(s && s.flow) ? s.flow : 1;
      if (f >= gate) strong++;
    }
    out.strong = strong;
    out.drawn = sm.autoRiverDrawn;                     // 产品自己报的落笔段数（回执里那个 633）
    // 诊断用：下游**流量更低**的段有多少（非单调 = 规则②确实是承重的，剪枝必须补边界层）。
    // 只报数不作判据 —— 判据落在上面 ①②③ 上，避免把剪枝策略写死进用例。
    out.stage = 'mono';
    const q = (v) => Math.round((Number.isFinite(v) ? v : 0) * 100);
    const key = (x, y) => q(x) + ',' + q(y);
    const byStart = new Map();
    for (const s of segs) byStart.set(key(s.x0, s.y0), s);
    let nonMono = 0, terminus = 0;
    for (const s of segs) {
      if (s.endInSea) { terminus++; continue; }
      const down = byStart.get(key(s.x1, s.y1));
      if (!down) { terminus++; continue; }
      const f0 = Number.isFinite(s.flow) ? s.flow : 1;
      const f1 = Number.isFinite(down.flow) ? down.flow : 1;
      if (f1 < f0) nonMono++;
    }
    out.nonMono = nonMono; out.terminus = terminus;
    out.stage = 'done';
  } catch (e) {
    out.err = String((e && e.message) || e);
    out.stack = String((e && e.stack) || '').split('\n').slice(0, 2).join(' | ').slice(0, 240);
  }
  return JSON.stringify(out);
})() """.replace('__SC__', SC)
    prune = eval_json(cdp, prune_js, required=None, desc='剪枝强度')
    prune = prune[1] if isinstance(prune, tuple) and prune[0] else {'err': prune}
    if not isinstance(prune, dict) or prune.get('err'):
        fails.append(f'剪枝探针求值异常{_probe_err(prune)}'
                     f'（若 err 是 no-gate-api / no-drawn-count，那是**判据失效**：'
                     f'产品把 `riverFlowGate` / `autoRiverDrawn` 挪走了，需同步更新本用例）')
    else:
        p_segs = prune.get('segs') or 0
        p_strong = prune.get('strong') or 0
        p_drawn = prune.get('drawn') or 0
        ratio = (p_drawn / p_segs) if p_segs else 0
        notes.append(f"剪枝：落笔 {p_drawn}/{p_segs} 段（{ratio * 100:.1f}%；闸门流量 ≥{prune.get('gate')}，"
                     f"强段 {p_strong}；非单调下游 {prune.get('nonMono')} / 合法尽头 {prune.get('terminus')}）")
        if not (0 < p_drawn < p_segs):
            fails.append(f'🔴 剪枝没生效或把河网剪空了（落笔={p_drawn} / 总段={p_segs}）—— '
                         f'「只画河道」要么没接线、要么剪过头')
        if p_segs and ratio < 0.05:
            fails.append(f'🔴 剪枝过头：只留 {ratio * 100:.1f}% 的段（下界 5%）—— 这正是产品踩过的那个 bug'
                         f'（格键不匹配 → 3750 段只留 26 段），表现是"画布上有河但很稀"，**不报错**')
        if p_strong and p_drawn < p_strong:
            fails.append(f'🔴 有超过闸门的段没被画出来（落笔 {p_drawn} < 强段 {p_strong}）—— '
                         f'剪枝把该留的干流也丢了')
        if p_strong and p_drawn == p_strong:
            fails.append(f'🔴 落笔段数**恰好等于**强段数（{p_strong}）—— 剪枝的规则②（"下游被留下就留下"）'
                         f'没有生效，河网会碎成一堆互不相连的短刺。'
                         f'这正是 `riverRender.js` 留档的那个 bug：格键用浮点坐标做字符串 → '
                         f'匹配不上 → 计数看起来"正常"、画布上却稀。'
                         f'（这一条是"帧差 > 0"永远抓不到的）')

    # ── 性能护栏：再点一次（同一张图）耗时有上限 ──────────────────────────────
    perf_js = r""" (async () => {
  const sm = __SC__;
  const btn = Array.from(document.querySelectorAll('button'))
    .find(b => (b.textContent || '').includes('自动河流'));
  if (!btn) return JSON.stringify({ err: 'no-button' });
  const t0 = performance.now();
  btn.click();
  const dt = performance.now() - t0;
  return JSON.stringify({ ms: Math.round(dt), count: (sm.autoRivers || []).length });
})() """.replace('__SC__', SC)
    perf = eval_json(cdp, perf_js, required=None, desc='性能探针')
    perf = perf[1] if isinstance(perf, tuple) and perf[0] else {'err': perf}
    cap = 8000
    if not isinstance(perf, dict):
        fails.append(f'性能探针求值异常：{perf}')
    elif perf.get('ms', 0) > cap:
        fails.append(f"生成耗时 {perf.get('ms')}ms > {cap}ms（旧全表扫描口径会到分钟级）")
    else:
        notes.append(f"再点一次 {perf.get('ms')} ms（上限 {cap}）")

    # ── ⑧ 🔴 河流来源开关：三个档位必须**真的改变画布**（2026-10-16 第五修）──────────
    # 为什么不能只做源码闸门：这个开关的全部意义是"让用户只留一套河"，
    # 若它只改了 ref 而没门控渲染（或没进 watch → 不重画），源码守卫照样全绿、
    # 用户点下去却什么都没变 —— 那正是本项目最怕的"看起来做了"。
    # 判据用**画布像素**：合成 fixture 的底图自带河为 0 条 →
    #   · `both` / `auto` → 有自动河像素（>0）
    #   · `base`          → 自动河被藏掉 → 河色像素归 0（且与 both 不同）
    rows_js = r""" (() => {
  const sm = __SC__;
  const cvs = document.querySelector('.scenario-map-container canvas');
  if (!cvs) return JSON.stringify({ err: 'no-canvas' });
  const W = cvs.width, H = cvs.height;
  const c = cvs.getContext('2d');
  // 🔴 2026-10-17 第六修：与 `pix_js` 同一口径（**帧差**）——
  //    降采样 + 通色值数不到 1.2px 的细线（实测三档全 0 假红）。
  //    "这一档画了多少河" = 关掉自动河前后**变了多少像素**。
  // ⚠️ 必须走**同步口** `renderNow()`：`render()` 有帧合并（同帧内第二次调用被推迟到下一帧）
  //    → "改数据 → render() → 取像素"会拿到上一帧，帧差恒 0（判据空转）。
  const draw = () => { if (typeof sm.renderNow === 'function') sm.renderNow(); else sm.render(); };
  const snap = () => { draw(); return c.getImageData(0, 0, W, H).data.slice(); };
  const countAuto = () => {
    const savedR = sm.autoRivers, savedS = sm.autoRiverSegments;
    sm.autoRivers = []; sm.autoRiverSegments = [];
    const A = snap();
    sm.autoRivers = savedR; sm.autoRiverSegments = savedS;
    const B = snap();
    let n = 0;
    for (let i = 0; i < A.length; i += 4) {
      if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 8) n++;
    }
    return n;
  };
  const out = {};
  if (!(sm.autoRivers || []).length) return JSON.stringify({ err: 'no-auto-rivers' });
  // ⚠️ 走**真的下拉控件**（`select.value = …` + 派发 change），不要直接赋 `sm.riverSource`：
  //    直接赋 setupState 上的 ref 能不能被脚本侧看见取决于解包口径 —— 那是测试装置的坑
  //    （本轮在「平滑」开关上就踩过一次：直接赋值 → 假红）。真控件才测得准。
  const sel = document.querySelector('[data-testid="river-source"]');
  if (!sel) return JSON.stringify({ err: 'no-river-source-select' });
  const setMode = (m) => {
    sel.value = m;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  };
  for (const mode of ['both', 'base', 'auto']) {
    setMode(mode);
    draw();
    out[mode] = countAuto();
  }
  out.hasSelect = true;
  out.options = Array.from(sel.options).map(o => o.textContent.trim());
  // 收尾恢复默认档（后面的性能段与其它用例都假定"两套都画"）
  setMode('both');
  draw();
  out.backToBoth = countAuto();
  return JSON.stringify(out);
})() """.replace('__SC__', SC)
    rows = eval_json(cdp, rows_js, required=None, desc='河流来源三档像素')
    rows = rows[1] if isinstance(rows, tuple) and rows[0] else {'err': rows}
    if not isinstance(rows, dict) or rows.get('err'):
        fails.append(f'河流来源探针求值异常：{rows.get("err") if isinstance(rows, dict) else rows}'
                     f'{_probe_err(rows)}')
    else:
        both, base, auto = rows.get('both', 0), rows.get('base', 0), rows.get('auto', 0)
        notes.append(f"河流来源三档：both={both} / base={base} / auto={auto} 像素")
        if not rows.get('hasSelect'):
            fails.append('🔴 DOM 里找不到 `[data-testid="river-source"]` —— 开关够不着')
        if auto <= 0:
            fails.append('🔴 档位「只画自动生成」看不到任何河 —— 门控把该画的也藏了')
        if base != 0:
            fails.append(f'🔴 档位「只画底图自带」仍有 {base} 个河色像素（这份底图自带河为 0 条，'
                         f'说明自动河没被藏掉）—— 开关是空的')
        if base == both and auto == both:
            fails.append('🔴 三个档位画出来一模一样 —— 开关没接到渲染上')
        if rows.get('backToBoth', 0) <= 0:
            fails.append('🔴 档位切回「两套都画」后河没回来（门控没还原）')

    # ── ⑨ 🔴 反方向：档位「只画自动生成」必须**真的把底图自带河藏掉** ───────────────
    # 为什么必须单独测这一向：⑧ 那个探针用的合成底图**自带河为 0 条**，
    # 所以它只证明了"自动河能被藏"，**证明不了"自带河能被藏"** ——
    # 而用户抱怨的「各画各的」正是靠**藏掉自带河**来解决的（实测两套是不同水系，
    # 所以只能把选择权交出去，见 `_probe_river_align.mjs`）。
    # 造一条**导入河**（id 不带 `river_` 前缀 → 走 `drawRivers` 那条路径）+ 一条手画河
    # （带前缀 → 走 `drawRiverPaths`），再切档看它们各自在不在。
    hide_js = r""" (async () => {
  const sm = __SC__, s = __STORE__;
  const KEY = sm.baseMapKey;
  const map = s.baseMaps[KEY];
  if (!map) return JSON.stringify({ err: 'no-basemap' });
  const cvs = document.querySelector('.scenario-map-container canvas');
  if (!cvs) return JSON.stringify({ err: 'no-canvas' });
  const sel = document.querySelector('[data-testid="river-source"]');
  if (!sel) return JSON.stringify({ err: 'no-river-source-select' });
  const W = cvs.width, H = cvs.height;
  const c = cvs.getContext('2d');
  const tick = () => new Promise((r) => setTimeout(r, 0));
  // ⚠️ 必须走**同步口** `renderNow()`：产品第六修给 `render()` 加了**帧合并**（同一帧内 15ms
  //    以内的第二次调用被推迟到下一帧 rAF）→ "改数据 → render() → 立刻取像素"会拿到**上一帧**，
  //    差值恒 0（判据空转）。写成 `typeof` 探测是为了对没有 renderNow 的旧版本也成立。
  const draw = () => { if (typeof sm.renderNow === 'function') sm.renderNow(); else sm.render(); };
  // ⚠️ 走**真的下拉控件**（`sel.value = …` + 派发 change）而不是直接赋 `sm.riverSource`：
  //    直接赋 setupState 上的 ref 能不能被脚本侧看见取决于解包口径 —— 那是测试装置的坑
  //    （本项目在「平滑」开关上踩过一次 → 假红），真控件才测得准。
  const setMode = async (m) => {
    sel.value = m;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();      // Vue 的更新是异步的（本仓纪律：改完等一拍）
    draw();            // 再**强制重画**一帧 —— 取像素前必须确认画的是这一档（否则拿到上一帧）
  };
  const snap = () => { draw(); return c.getImageData(0, 0, W, H).data.slice(); };
  // 探针几何用**当前视口**合成。为什么不用固定世界坐标：相机一动探针就跑到屏幕外，
  // 于是"看不见"与"根本没画"分不清（那是假绿，正是本段要排除的那种）。
  const tl = sm.screenToWorld(0, 0);
  const br = sm.screenToWorld(cvs.clientWidth || W, cvs.clientHeight || H);
  const x1 = tl.x + (br.x - tl.x) * 0.25, x2 = tl.x + (br.x - tl.x) * 0.75;
  const y1 = tl.y + (br.y - tl.y) * 0.30, y2 = tl.y + (br.y - tl.y) * 0.70;
  const pts = [{ x: x1, y: y1 }, { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }, { x: x2, y: y2 }];
  const saved = map.rivers ? map.rivers.slice() : [];
  // 两条探针河故意走**两条不同的渲染路径**（这本身就是判据的一部分）：
  //   · `imported_*` → `getDisplayRivers()` → `drawRivers()`（"底图自带河"那条路，**受** `showRiverBase` 门控）
  //   · `river_*`    → `drawRiverPaths()`（手画河那条路，**不受**这个开关管辖）
  const PROBES = [
    { path: 'imported', list: [{ id: 'imported_probe', name: '探针导入河', points: pts, width: 0.26, discharge: 600 }] },
    { path: 'hand', list: [{ id: 'river_probe', name: '探针手画河', points: pts, width: 0.5 }] },
  ];
  const diffPixels = (A, B) => {
    let n = 0;
    for (let i = 0; i < A.length; i += 4) {
      if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 8) n++;
    }
    return n;
  };
  const out = { readings: {}, errs: {} };
  for (const probe of PROBES) {
    for (const mode of ['base', 'both', 'auto']) {
      // 🔴 关键：帧差是在**这条探针河自己**的"装上 / 摘掉"之间做的。
      //    原来的写法是切换 `sm.autoRivers`（= **自动河**）再拿差值当"导入河在不在"的证据 ——
      //    量错了对象：`base` 档下自动河两帧都不画，读数恒为 0，于是断言恒红。
      map.rivers = saved.concat(probe.list);
      await setMode(mode);
      const A = snap();
      // ⚠️ 渲染异常必须**在探针河还装着的时候**抓：`renderNow()` 一旦画成功就把
      //    `renderError` 清回空串（护栏是"连续 3 帧失败才暂停"），下一帧再看就什么都看不到了。
      out.errs[probe.path + '_' + mode] = String(sm.renderError || '');
      map.rivers = saved.slice();
      draw();
      const B = snap();
      out.readings[probe.path + '_' + mode] = diffPixels(A, B);
    }
  }
  // 收尾：还原 `map.rivers` 与 `riverSource`（后面的段与后续用例都假定"两套都画 + 无探针河"）
  map.rivers = saved;
  await setMode('both');
  out.leftProbeRivers = (map.rivers || []).filter(
    (r) => r && /^(imported_probe|river_probe)$/.test(String(r.id || ''))).length;
  out.riversRestored = (map.rivers || []).length === saved.length;
  out.modeAfter = sel.value;
  out.options = Array.from(sel.options).map((o) => o.textContent.trim());
  return JSON.stringify(out);
})() """.replace('__SC__', SC).replace('__STORE__', STORE)
    hide = eval_json(cdp, hide_js, required=None, desc='自带河隐藏')
    hide = hide[1] if isinstance(hide, tuple) and hide[0] else {'err': hide}
    if not isinstance(hide, dict) or hide.get('err'):
        fails.append(f'自带河隐藏探针求值异常：{hide.get("err") if isinstance(hide, dict) else hide}'
                     f'{_probe_err(hide)}')
    else:
        rd = hide.get('readings') or {}
        imp_base = rd.get('imported_base', 0)
        imp_both = rd.get('imported_both', 0)
        imp_auto = rd.get('imported_auto', 0)
        hand_base = rd.get('hand_base', 0)
        hand_auto = rd.get('hand_auto', 0)
        notes.append(f"自带河隐藏（**探针河自己**的帧差像素）：导入河 base={imp_base} / "
                     f"both={imp_both} / auto={imp_auto}；手画河 base={hand_base} / auto={hand_auto}")
        # ④ 渲染护栏：把探针河装进底图之后**不许有渲染异常**。
        #    为什么单列这一条：渲染异常会被产品的护栏 try/catch 吞掉（画布上只是"少画了东西"，
        #    不报错、不崩），所以"看不见那条河"有两种成因 —— 被开关藏了（正确）或**画的时候就抛了**
        #    （缺陷）。不抓这一条，两者会混成一个"读数 0"，判决就成了猜。
        #    实测抓到的真缺陷：`ScenarioMap.riverWidthsFor` 用了 `RIVER_WIDTH_MIN/MAX` 却**没 import**
        #    （它们在 `utils/rivers.js` 里导出）→ 画任何手画河都抛 `ReferenceError`。
        errs = hide.get('errs') or {}
        bad_errs = {k: v for k, v in errs.items() if v}
        if bad_errs:
            fails.append(f'🔴 把探针河装进底图后**渲染抛了异常**（护栏吞掉了，画布只是"少画东西"）：'
                         f'{bad_errs} —— 这不是"被开关藏了"，是画的时候就失败了')
        # ① 校准（**没有这一步，下面的 0 就是空转**）：`base` 档必须看得见那条导入探针河。
        #    若这里就是 0，说明"看不见"的原因与开关无关（探针几何不在视口内 / drawRivers 断了），
        #    此时"auto 档看不见它"什么都证明不了 —— 判据必须自己先证明有判别力。
        if imp_base <= 0:
            fails.append('🔴 校准失败：`base` 档下**导入探针河**一个像素都没画出来'
                         '（探针几何不在视口内，或 `drawRivers` 那条路断了）——'
                         '此时「auto 档看不见它」是**空转**，不能算通过')
        # ② 核心反方向判据：`auto` = 只画自动生成 → **底图自带（导入）河必须被藏掉**。
        #    这是用户「依旧和底图自带河流各画各的」的出口所在。
        if imp_auto > 0:
            fails.append(f'🔴 档位「只画自动生成」仍有 {imp_auto} 个像素属于**底图自带（导入）河** —— '
                         f'自带河没被藏掉，用户的「各画各的」解决不了'
                         f'（判据：把那条探针河装上/摘掉各渲一帧的帧差）')
        if imp_both <= 0:
            fails.append('🔴 `both`（两套都画）档下看不到导入探针河 —— 该档本来就该画它')
        # ③ 另一条渲染路的校准：`river_` 前缀走 `drawRiverPaths`（手画河），
        #    与导入河是**两条不同的渲染路** —— 它若画不出来，说明探针装置本身有问题。
        #    ⚠️ `auto` 档它的读数只**记录不断言**：这个开关名义上管的是"底图自带 vs 自动生成"，
        #       手画河归谁管不属本用例的判据（据实报读数，不替产品下结论）。
        if hand_base <= 0:
            fails.append('🔴 校准失败：`base` 档下**手画探针河**没画出来'
                         '（`river_` 前缀走 `drawRiverPaths`，与导入河不是同一条路）'
                         + (f'｜同时观测到渲染异常：{bad_errs}' if bad_errs else ''))
        # ④ 收尾必须干净：探针河与档位都不能留给后面的段与其它用例
        if not hide.get('riversRestored') or hide.get('leftProbeRivers'):
            fails.append(f"探针河没还原干净（riversRestored={hide.get('riversRestored')} / "
                         f"leftProbeRivers={hide.get('leftProbeRivers')}）—— 会把探针河留给后续用例")
        if hide.get('modeAfter') != 'both':
            fails.append(f"收尾没把河流来源还原成 both（现在是 {hide.get('modeAfter')}）")

    # ── ⑩ 🔴 平滑开关：勾上必须真把参数送进追踪器、且回执里说明闸门被降 ─────────────
    # 为什么必须测行为：源码里出现 `smoothRadius` 字样 ≠ 它被送进去了。
    # 判据取**回执**：面板只在 `r.smoothed` 为真时才写"已先平滑地形…"，
    # 所以那句话在场 = 开关真的穿到了 store → traceRivers → smoothHeightmapGrid。
    smooth_js = r""" (async () => {
  const sm = __SC__;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  // ⚠️ 必须点**真的复选框**，不要直接赋 `sm.riverSmooth`：
  //    同一文件里既有裸 `riverSmooth`（模板）又有 `riverSmooth.value`（脚本），
  //    直接赋值能不能被脚本侧看见取决于 setupState 的解包口径 —— 那是测试装置的坑，
  //    不是产品行为。用真控件 + 等一拍（Vue 的 DOM 更新是异步的，本仓纪律）才测得准。
  const box = document.querySelector('[data-testid="river-smooth"]');
  if (!box) return JSON.stringify({ err: 'no-smooth-checkbox' });
  const btn = Array.from(document.querySelectorAll('button'))
    .find(b => (b.textContent || '').includes('自动河流'));
  if (!btn) return JSON.stringify({ err: 'no-button' });

  const before = { checked: box.checked, h: sm.riverSourceHeight, count: (sm.autoRivers || []).length };
  box.click();
  await tick();
  const afterClick = { checked: box.checked };
  btn.click();
  await tick();
  const on = {
    checked: box.checked,
    h: sm.riverSourceHeight,
    count: (sm.autoRivers || []).length,
    segs: (sm.autoRiverSegments || []).length,
  };
  // 回执 = `provinceHint`（`statusMsg` 写的那个 ref），DOM 里渲染成**若干个** `.draw-hint` 之一。
  // ⚠️ 必须读 `sm.provinceHint` 这个**源头**，不要 `document.querySelector('.draw-hint')`：
  //    同页有多个 `.draw-hint`（吸附提示 / 顶点编辑 / 绘制中 / 拆分…），querySelector 拿的是
  //    **DOM 里第一个**，工具状态一变就读到别的提示条 → 回执判据读到空串而**假红**
  //    （本项目另一条纪律：判据要读"那个数据的来源"，不是"恰好第一个出现在 DOM 里的东西"）。
  //    两个都收：`status` 证明回执内容，`domHints` 证明它**真的渲染给用户看了**。
  const statusOn = String(sm.provinceHint || '');
  const domHintsOn = Array.from(document.querySelectorAll('.draw-hint'))
    .map((e) => e.textContent || '').join(' | ');

  // 关回去再点一次，证明"默认关 = 旧行为"
  box.click();
  await tick();
  btn.click();
  await tick();
  const off = { checked: box.checked, h: sm.riverSourceHeight, count: (sm.autoRivers || []).length };
  const statusOff = String(sm.provinceHint || '');
  const domHintsOff = Array.from(document.querySelectorAll('.draw-hint'))
    .map((e) => e.textContent || '').join(' | ');
  return JSON.stringify({ before, afterClick, on, off, statusOn, domHintsOn, statusOff, domHintsOff });
})() """.replace('__SC__', SC)
    smooth = eval_json(cdp, smooth_js, required=None, desc='平滑开关')
    smooth = smooth[1] if isinstance(smooth, tuple) and smooth[0] else {'err': smooth}
    if not isinstance(smooth, dict) or smooth.get('err'):
        fails.append(f'平滑开关探针求值异常：{smooth.get("err") if isinstance(smooth, dict) else smooth}')
    else:
        hint = str(smooth.get('statusOn') or '')
        hint_off = str(smooth.get('statusOff') or '')
        dom = str(smooth.get('domHintsOn') or '')
        on_c = (smooth.get('on') or {}).get('count', 0)
        off_c = (smooth.get('off') or {}).get('count', 0)
        h_on = (smooth.get('on') or {}).get('h', None)
        notes.append(f"平滑开关：勾上 {on_c} 条（闸门读数 {h_on}）/ 取消 {off_c} 条；"
                     f"回执含「已先平滑地形」={('已先平滑地形' in hint)}")
        if not (smooth.get('afterClick') or {}).get('checked'):
            fails.append('🔴 点了 `[data-testid="river-smooth"]` 之后复选框没变成勾选 —— 控件没接线')
        if '已先平滑地形' not in hint:
            fails.append('🔴 勾上「平滑」后回执里没有「已先平滑地形」—— 开关没有真的传进追踪器'
                         f'（回执：{hint[:140]}）')
        elif '已先平滑地形' not in dom:
            fails.append('🔴 回执里写了「已先平滑地形」，但画布上的状态栏里看不见它'
                         '（`.draw-hint` 里找不到）—— 用户看不到的回执等于没有回执')
        if on_c <= 0:
            fails.append('🔴 勾上平滑后一条河都没有 —— 缺了"同时下调源头闸门"那一步')
        if '闸门按' not in hint:
            fails.append('🔴 回执没有说明闸门被降（用户会以为是数据坏了）')
        if '已先平滑地形' in hint_off:
            fails.append('🔴 取消平滑后回执里仍写着「已先平滑地形」—— 开关关不掉（默认行为被改掉）')
    # ⚠️ 2026-10-17 第七修：这里原来**整段复制了两遍**（同一个探针求值两次、notes 重复、
    #    同一组断言重跑一遍）。重复不等于更严格：探针里那两次 `box.click()` + 生成**有副作用**，
    #    跑第二遍时开关状态已被第一遍拨回，于是同一段判据会给出两套读数 ——
    #    真出红也分不清是哪一遍报的（而它还会把"平滑"的生成开销付两遍）。
    #    故只保留下面这一份（含 `hintOff` 反向检查的那份更全）。

    # ── 收尾：把本用例动过的**页面状态**逐项还原 ─────────────────────────────────
    # 为什么必须逐项还原：`run_tests.py` 是**同一个页面里顺序跑**用例的，ScenarioMap 一直挂着
    # → 本用例改过的组件态会漏给下一个用例。最危险的是 `riverSourceHeight`（源头高度闸门）：
    # 它**直接决定条数**（实测本用例地形：60 → 2072 条 / 40 → 3108 条），
    # ⑩ 勾平滑时会把它降到 40，而产品**只降不升**（那是给用户看的"我替你降了"）→
    # 漏出去就是"另一个用例莫名其妙变红/变绿"。
    #   · 自动河是内存预览（产品明说不会存进项目）→ 清掉；
    #   · 三个控件都走**真控件**还原（下拉 value+change / 复选框 click / 输入框 input），
    #     不直接赋 `sm.*` —— 那正是本文件反复强调的"别赌 setupState 的解包口径"。
    #     ⚠️ 只清 `autoRivers/autoRiverSegments` 这两条**没有控件**的内存预览用的是直接赋值。
    cleanup_js = r""" (async () => {
  const sm = __SC__;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  sm.autoRivers = []; sm.autoRiverSegments = [];   // 内存预览，没有对应控件
  const sel = document.querySelector('[data-testid="river-source"]');
  if (sel && sel.value !== 'both') {
    sel.value = 'both';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const box = document.querySelector('[data-testid="river-smooth"]');
  if (box && box.checked) box.click();
  const inp = document.querySelector('[data-testid="river-source-height"]');
  // 60 = `utils/riverTrace.js` 的 `TRACE_SOURCE_HEIGHT`（源码闸门钉着这个值，改了就红，
  // 免得这里悄悄还原成一个已经不是默认值的数字）
  if (inp && String(inp.value) !== '60') {
    inp.value = '60';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }
  // 渲染护栏：本用例装探针河时可能连撞几帧异常 → 护栏会把整块画布**暂停**，
  // 而暂停态是组件级的，会跟着漏给后面在同一页面里顺序跑的用例（"画布黑掉"那种）。
  // 这里只负责把护栏解除；异常本身由 ⑨ 的断言负责报红，绝不在这里被吞掉。
  if (sm.renderPaused && typeof sm.resumeRender === 'function') sm.resumeRender();
  await tick();
  if (typeof sm.renderNow === 'function') sm.renderNow(); else sm.render();
  return 'ok';
})() """.replace('__SC__', SC)
    cdp.eval(cleanup_js)

    detail = '；'.join(notes + fails)
    return (len(fails) == 0), detail
