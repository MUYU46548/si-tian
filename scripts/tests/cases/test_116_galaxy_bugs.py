#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 116：星系/星域视图的四个表现层 bug（2026-10-18 第十修）

对应上一轮交接 §6 的侦查结论（`docs/SITIAN_HANDOFF_20261018_ROUND7.md`）：

  ① **坐标拖拽是死代码**：提示文案写着「拖拽恒星编辑坐标」，但 `onDragStart` 从不返回
     `{mode:'node'}` → `onDragMove/onDragEnd` 里那两条分支**不可达**，`isDraggingMultiple`
     也恒 false。修法 = 照 SystemView 的既有形态补「拖手 / 移动」两个工具，并把链路接通。
  ② **势力改色不重绘、也不落库**：`factionColorOverrides` 既没有 watch 也没有 `requestRender()`，
     而且渲染取色读的是**布局期快照**；更糟的是它拿 `domain.faction` 当键 —— 真实库该值是
     `undefined` → 所有星域共用一个键「undefined」，改一个色 = 改全部。
  ③ **星域不可命中**：`hitTest` 只返回 `galaxy` / `domain-label` / `boundary-vertex`，
     而 `domain-label` 被 `!editMode` 门控 → **编辑模式下星域一个分支都命中不到**，
     连带四处 `type === 'domain'` 全是死代码。
  ④ **右键不看 editMode**：浏览态右键就能弹「创建恒星 / 删除节点 / 删除航道」这些**写操作**。

另外顺手修掉一条**静默**的颜色缺陷（`border.color + '12'` 对 `hsl()` 是非法 CSS，
`fillStyle` 赋值被**静默忽略** → 星域颜色串了且不报错），改走 `utils/colorUtil.js` 的唯一实现。

判据纪律（本仓血泪）：
  · 右键**必须派发真实 `contextmenu`** —— 合成 `click{button:2}` 会绕过真机路径（test_88 的教训）；
  · Vue 的 DOM 更新是**异步**的：点完按钮读 DOM 前要等一拍；
  · 每个断言段都带**反向对照**（同一个操作在没有修复/在另一种工具下必须给出相反结果）。
"""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json
from lib.helpers import A, view_level  # noqa: E402

GM = "document.querySelector('.galaxy-map-container')"
GMST = GM + ".__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"


def _code_only(src):
    """剥掉注释再判源码（判据不许被注释里的字样骗过 —— 本仓既定口径）"""
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


def _read(rel):
    root = os.path.join(os.path.dirname(__file__), '..', '..', '..')
    with open(os.path.join(root, rel), encoding='utf-8') as f:
        return f.read()


def source_gates():
    """f0：源码闸门（实现搬家/退化时最先红，且指出具体位置）"""
    fails, notes = [], []
    gm = _code_only(_read('src/renderer/src/components/GalaxyMap.vue'))
    sv = _code_only(_read('src/renderer/src/components/SystemView.vue'))
    iv = _code_only(_read('src/renderer/src/components/InteriorView.vue'))
    cu = _code_only(_read('src/renderer/src/utils/colorUtil.js'))

    # ① 右键 editMode 门控（三层；system_detail 是既有正确对照）
    for name, src in (('GalaxyMap', gm), ('SystemView', sv)):
        seg = src.split('onContextMenu:', 1)
        if len(seg) < 2:
            fails.append(f'🔴 {name} 找不到 onContextMenu')
            continue
        head = seg[1][:400]
        if 'if (!editMode.value) return;' not in head:
            fails.append(f'🔴 {name}.onContextMenu 没有 editMode 门控 —— 浏览态右键就能写数据（§bug 右键）')
    sdv = _code_only(_read('src/renderer/src/components/SystemDetailView.vue'))
    if 'if (!editMode.value) return;' not in sdv:
        fails.append('🔴 SystemDetailView 的既有门控不见了（它是这条纪律的对照组）')

    # ② 势力改色：必须落库 + 重排 + 重绘，且取色单源
    if 'function setFactionColor(' in gm:
        fails.append('🔴 旧的 setFactionColor 还在（它只写组件局部 ref，不落库不重绘）')
    for needle, why in (
        ('function resolveDomainColor(', '星域取色的单一解析口'),
        ('function commitFactionColor(', '落库口'),
        ('store.updateNode(domain.id, { factionColor: color })', '改色必须落库到节点（否则切走视图就没了）'),
        ('applyStableLayout();', '改色后必须重排（渲染读的是布局期快照）'),
        ('renderer.requestRender();', '改色后必须重绘'),
    ):
        if needle not in gm:
            fails.append(f'🔴 GalaxyMap 缺 {why}（找不到 `{needle}`）')
    if gm.count('color: resolveDomainColor(domain),') < 3:
        # ⚠️ 第十二修后这几句实现搬进了 `utils/galaxyLayout.js`（画布与导出共用同一份）——
        #    **判据跟着实现搬家**（本仓纪律：判据不许留在旧位置变成恒绿/恒红的僵尸）。
        gl = _code_only(_read('src/renderer/src/utils/galaxyLayout.js'))
        if 'factionColor: resolveDomainColor(domain, opts.overrides)' not in gl:
            fails.append('🔴 共享布局的 factionColor 没有走 resolveDomainColor（图例/画布/导出会分裂）')
    if 'factionColor: resolveDomainColor(domain),' not in gm:
        gl = _code_only(_read('src/renderer/src/utils/galaxyLayout.js'))
        if 'factionColor: resolveDomainColor(domain, opts.overrides)' not in gl:
            fails.append('🔴 布局里的 factionColor 没有走 resolveDomainColor')

    # ③ 星域可命中
    seg = gm.split('function hitTest(', 1)
    if len(seg) < 2:
        fails.append('🔴 找不到 hitTest')
    else:
        body = seg[1].split('\nfunction ', 1)[0]
        if "type: 'domain'" not in body:
            fails.append("🔴 hitTest 仍然不返回 type:'domain' —— 星域在编辑模式下点不到（§bug hitTest）")
        if 'pointInPolygon(' not in body:
            fails.append('🔴 hitTest 缺星域多边形判定（pointInPolygon）')

    # ④ 坐标拖拽接通（不许"文案说有、代码没有"）
    for needle, why in (
        ("const interactionMode = ref('pan')", '浏览态拖拽工具的语义 ref'),
        ("mode: 'node'", '返回给渲染器的节点拖拽协议'),
        ('store.beginNodePositionCapture(', '单节点拖动撤销捕获'),
        ('store.endNodePositionCapture(', '单节点拖动收尾'),
        ('store.beginMultiNodePositionCapture(', '多选批量拖动撤销捕获'),
        ('store.endMultiNodePositionCapture(', '多选批量拖动收尾'),
    ):
        if needle not in gm:
            fails.append(f'🔴 GalaxyMap 缺 {why}（找不到 `{needle}`）')
    if 'isDraggingMultiple = true;' not in gm:
        fails.append('🔴 isDraggingMultiple 仍然永远是 false（多选拖动那条分支仍是死代码）')
    if 'data-testid="galaxy-move-tool"' not in gm:
        fails.append('🔴 缺「移动」工具的 data-testid（用例/演练点不到它）')
    if '「移动」工具下拖拽' not in gm:
        fails.append('🔴 提示文案没有说清"移动工具下才能拖"（与实现一致才行）')
    if '拖拽空白处平移 · 拖拽恒星编辑坐标' in gm:
        fails.append('🔴 旧的无条件"拖拽恒星编辑坐标"文案还在（那句话骗人）')

    # ⑤ 颜色拼 alpha 的旧写法必须绝迹（对 hsl 是非法 CSS，会被静默忽略）
    for name, src in (('GalaxyMap', gm), ('InteriorView', iv)):
        if "color + '" in src:
            fails.append(f'🔴 {name} 仍在用字符串拼 alpha（对 hsl 颜色是非法 CSS，会静默沿用上一个颜色）')
        if 'withAlpha(' not in src:
            fails.append(f'🔴 {name} 没有接 withAlpha（唯一实现）')
    if 'export function withAlpha(' not in cu:
        fails.append('🔴 utils/colorUtil.js 缺 withAlpha 实现')

    # ⑥ 星域位置持久化（§bug3）：旧 `coordinate` 不得被无条件采信
    #    ⚠️ 第十二修后这段数学搬进 `utils/galaxyLayout.js#layoutDomains`（画布与导出共用），判据跟着搬家
    glj = _code_only(_read('src/renderer/src/utils/galaxyLayout.js'))
    if 'domain.userMoved || domain.id === opts.draggingId' not in glj:
        fails.append('🔴 共享布局缺「只在 userMoved（或拖动期）才采信星域 coordinate」这道门 '
                     '—— 提取器给每个星域都写了遗留坐标，无条件采信会让老项目一次性全部错位')
    if 'layoutDomains(props.domains' not in gm:
        fails.append('🔴 GalaxyMap 的画布布局没有走共享 layoutDomains（会与导出又分家）')
    if 'let draggingDomainId' not in gm:
        fails.append('🔴 缺 draggingDomainId（拖动期预览开关：不认它，拖动中每帧会被弹回环形）')
    if "hit.type !== 'galaxy' && !isDomainHandle" not in gm:
        fails.append('🔴 移动工具没有接星域（§bug3）—— 星域仍然拖不动')
    if "hit.type === 'domain-label'" not in gm:
        fails.append("🔴 移动工具没把 domain-label 当星域手柄（浏览态拖动正要命中它，否则鼠标落在域中心时拖不动）")
    if '星域位置目前由布局决定、不可拖动' in gm:
        fails.append('🔴 上一轮的「星域不可拖动」回执文案还在（现在能拖了）')

    # ⑦ faction 写入路径（此前**一个写口都没有** → 图例永远同一个默认色）
    if 'function commitFaction(' not in gm:
        fails.append('🔴 缺 commitFaction —— `faction` 字段没有写入路径（图例/画布恒为默认色 #6b5b95）')
    if 'store.updateNode(domain.id, { faction:' not in gm:
        fails.append('🔴 势力名没有走 updateNode 落库（改完切视图就丢，也进不了项目文件）')
    if 'legend-faction-input' not in gm:
        fails.append('🔴 图例里没有势力名输入框（用户没有写入入口 = 能力等于不存在）')

    # ⑧ 势力边界：组件不许再直写 store ref；store 侧写口必须有闸门 + 进契约
    if 'store.domainBorderOverrides[domainId] =' in gm:
        fails.append('🔴 GalaxyMap 仍在直写 store.domainBorderOverrides（无闸门、无 undo）')
    if 'store.setDomainBorderPoints(' not in gm:
        fails.append('🔴 GalaxyMap 没有走 store.setDomainBorderPoints 这个唯一写口')
    gg = _code_only(_read('src/renderer/src/store/geodata.js'))
    for fn in ('removeHyperlane', 'updateHyperlane', 'setDomainBorderPoints'):
        seg = gg.split(f'function {fn}(', 1)
        if len(seg) < 2:
            fails.append(f'🔴 geodata.js 找不到 {fn}')
            continue
        if 'guardWrite(' not in seg[1][:700]:
            fails.append(f'🔴 {fn} 函数首行没有 guardWrite（先改内存后 execute = 静默改内存）')
    wg = _code_only(_read('src/renderer/src/store/writeGate.js'))
    for fn in ('removeHyperlane', 'updateHyperlane', 'setDomainBorderPoints'):
        if f"'{fn}'" not in wg:
            fails.append(f'🔴 writeGate 契约里没登记 {fn}（test_54 的反向扫描会当场红）')

    notes.append(f'源码闸门 {"全过" if not fails else f"缺 {len(fails)}"}')
    return fails, notes


# ── 公共探针片段 ─────────────────────────────────────────────────────────────
JS_METRICS = """
const el = document.querySelector('.galaxy-map-container');
const st = el.__vueParentComponent.setupState;
const c = st.canvas;
const r = c.getBoundingClientRect();
const vt = st.renderer.viewTransform;
const toScreen = (wx, wy) => [wx * vt.scale + vt.x + c.clientWidth / 2, wy * vt.scale + vt.y + c.clientHeight / 2];
const evAt = (sx, sy, type, extra) => new MouseEvent(type, Object.assign({
  clientX: r.left + sx, clientY: r.top + sy, bubbles: true, cancelable: true, button: 0 }, extra || {}));
const menuCount = () => document.querySelectorAll('.sitian-context-menu .menu-item:not(.menu-header)').length;
const tick = () => new Promise(res => setTimeout(res, 0));
const raf2 = () => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
"""


def js(body):
    """把公共片段 + 段体拼成一个 async IIFE，**返回 JSON 字符串**（`eval_json` 的契约）"""
    return ("(async () => {\n" + JS_METRICS + "\n"
            "const __out = await (async () => {\n" + body + "\n})();\n"
            "return JSON.stringify(__out);\n})()")


def _probe(cdp, body, desc):
    """求值并保证"异常 ≠ 通过"（`eval_json` 会拒绝缺 fails 字段的结果）"""
    ok, obj = eval_json(cdp, js(body), desc=desc)
    if not ok:
        return {'fails': [f'探针失败：{obj}']}
    return obj


def run(cdp):
    fails, notes = source_gates()

    # ── 进入星域总览（GalaxyMap）────────────────────────────────────────────
    from lib.helpers import select_world_with_domains
    select_world_with_domains(cdp)
    time.sleep(0.8)
    if view_level(cdp) != 'domain':
        return False, f'未进入 domain 视图（{view_level(cdp)}）'
    wait_for(cdp, f"!!{GM}", desc='GalaxyMap 挂载')
    time.sleep(0.5)

    # ══════════════════════════════════════════════════════════════════════
    # f1 右键（§bug 右键）：浏览态不弹菜单；编辑态弹且带写操作
    # ══════════════════════════════════════════════════════════════════════
    r1 = _probe(cdp, """
  const fails = [];
  const g = st.galaxyNodes[0];
  if (!g) return { fails: ['没有恒星可点'], note: 'no-galaxy' };
  st.renderer.focusOn(g.x, g.y, 1);
  await raf2();
  const vt2 = st.renderer.viewTransform;
  const sx = g.x * vt2.scale + vt2.x + c.clientWidth / 2;
  const sy = g.y * vt2.scale + vt2.y + c.clientHeight / 2;

  // ① 浏览态：真实 contextmenu → 不许弹菜单
  c.dispatchEvent(evAt(sx, sy, 'contextmenu', { button: 2 }));
  await tick();
  const browseMenu = menuCount();
  if (browseMenu !== 0) fails.push(`浏览态右键弹出了 ${browseMenu} 个菜单项 —— 写操作在浏览态可达`);

  // ② 进编辑模式 → 同一次右键必须弹菜单（否则"不许弹"就成了"永远弹不出来"的假修）
  const editBtn = Array.from(el.querySelectorAll('button')).find(b => b.textContent.includes('编辑地图'));
  if (!editBtn) return { fails: ['找不到「编辑地图」按钮'], note: 'no-edit-btn' };
  editBtn.click();
  await tick(); await tick();
  const editing = st.editMode;
  c.dispatchEvent(evAt(sx, sy, 'contextmenu', { button: 2 }));
  await tick();
  const editMenu = menuCount();

  // 收尾：关菜单 + 退出编辑模式
  c.dispatchEvent(evAt(sx + 40, sy + 40, 'mousedown'));
  c.dispatchEvent(evAt(sx + 40, sy + 40, 'mouseup'));
  await tick();
  const afterClose = menuCount();
  if (st.editMode) { const b2 = Array.from(el.querySelectorAll('button')).find(b => b.textContent.includes('完成编辑')); if (b2) b2.click(); }
  await tick();

  if (!editing) fails.push('编辑模式没进去（后半段断言不成立）');
  if (editMenu < 2) fails.push(`编辑态右键只弹出 ${editMenu} 个菜单项（应 ≥2：创建恒星 / 删除节点）`);
  if (afterClose !== 0) fails.push(`点空白后菜单没收起（还有 ${afterClose} 项）`);
  return { fails, browseMenu, editMenu, afterClose, editing };
""", 'f1 右键')
    if r1.get('fails'):
        fails += [f'[f1 右键] {x}' for x in r1['fails']]
    notes.append(f"f1 右键：浏览态 {r1.get('browseMenu')} 项 / 编辑态 {r1.get('editMenu')} 项 / 收起后 {r1.get('afterClose')} 项")

    # ══════════════════════════════════════════════════════════════════════
    # f2 势力改色：画布真的重绘 + 落库 + 一次 undo 复原
    # ══════════════════════════════════════════════════════════════════════
    r2 = _probe(cdp, """
  const fails = [];
  const store = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const domains = (st.props && st.props.domains) || st.domainNodes || [];
  const domain = domains[0];
  if (!domain) return { fails: ['取不到星域（props.domains / domainNodes 都是空）'], keys: Object.keys(st).slice(0, 60) };
  const node = store.nodes.find(n => n.id === domain.id);
  const before = node ? node.factionColor : undefined;
  const pickers = document.querySelectorAll('.legend-color-picker');
  if (!pickers.length) return { fails: ['图例里没有色板'], note: 'no-picker' };
  const picker = pickers[0];

  const g2 = c.getContext('2d');
  const W = c.width, H = c.height;
  const snap = () => Array.from(g2.getImageData(0, 0, W, H).data);
  const diffOf = (a, b) => { let d = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i+1] !== b[i+1] || a[i+2] !== b[i+2]) d++; return d; };
  const a = snap();
  const NEW = '#ff00ff';
  picker.value = NEW;
  picker.dispatchEvent(new Event('input', { bubbles: true }));
  await raf2();
  const midColor = st.resolveDomainColor(st.domainNodes.find(d => d.id === domain.id));
  // 快照必须**在 input 之后、change 之前**读：change 那条路自己会重排，
  // 放在后面读就永远绿（反向验证实测踩到过 —— 判据要打在"预览路径"上）
  const layoutAfterInput = (st.domainNodes.find(d => d.id === domain.id) || {}).factionColor;
  // ① **根因判据：预览路径必须自己重排**。渲染恒星用的 `galaxy.factionColor` 来自布局期副本
  //    （`applyStableLayout` 展开出来的），只改覆盖表或只 `requestRender()` 都会"画布重绘了、
  //    颜色还是旧的"。⚠️ 反向验证实测：把预览里的 `requestRender()` 去掉，像素判据仍然绿
  //    （另有路径会重绘）→ 所以必须有这一条，否则"改色不重绘"的根因没人守。
  if (layoutAfterInput !== NEW) fails.push(`预览后布局快照没跟上（恒星用的就是这份副本）：${layoutAfterInput}`);
  // ① **预览路径必须自己重绘**（只拖色板、还没 `change`）：这一条正是"改色不重绘"的根因所在，
  //    单独判 —— 否则"落库那条路顺带重绘"会把这条判据掩盖成永远绿（实测：去掉预览重绘时
  //    合并判据仍然是绿的 = 没有判别力）。
  const m = snap();
  const diffPreview = diffOf(a, m);
  picker.dispatchEvent(new Event('change', { bubbles: true }));
  await raf2();
  const b = snap();
  const diff = diffOf(a, b);

  const nodeAfter = store.nodes.find(n => n.id === domain.id);
  if (midColor !== NEW) fails.push(`预览色没生效：resolveDomainColor=${midColor}（期望 ${NEW}）`);
  if (diffPreview === 0) fails.push('只拖色板（input）时画布**一个像素都没变** —— 预览不重绘');
  if (diff === 0) fails.push('改色后画布**一个像素都没变** —— 只改了图例（§bug 改色不重绘）');
  if (!nodeAfter || nodeAfter.factionColor !== NEW) fails.push(`颜色没落库：node.factionColor=${nodeAfter && nodeAfter.factionColor}`);

  // 一次 undo 复原（落库走的是一条 update-node）
  store.undo();
  await raf2();
  const nodeUndone = store.nodes.find(n => n.id === domain.id);
  const backOk = (nodeUndone ? nodeUndone.factionColor : undefined) === before;
  if (!backOk) fails.push(`一次 undo 没把颜色还原：${nodeUndone && nodeUndone.factionColor}（期望 ${before}）`);
  return { fails, diff, diffPreview, beforeColor: before === undefined ? '(空)' : before, midColor };
""", 'f2 改色')
    if r2.get('fails'):
        fails += [f'[f2 改色] {x}' for x in r2['fails']]
    notes.append(f"f2 改色：预览变化 {r2.get('diffPreview')} 像素 / 落库后变化 {r2.get('diff')} 像素 / 落库 + undo 复原 {'ok' if not r2.get('fails') else 'FAIL'}")

    # ══════════════════════════════════════════════════════════════════════
    # f3 星域可命中（§bug hitTest）：编辑模式下右键星域 → 菜单含「删除该节点」→ 删除 → 一次 undo 复原
    # ══════════════════════════════════════════════════════════════════════
    r3 = _probe(cdp, """
  const fails = [];
  const store = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const editBtn = Array.from(el.querySelectorAll('button')).find(b => b.textContent.includes('编辑地图'));
  if (!editBtn) return { fails: ['找不到「编辑地图」按钮'] };
  editBtn.click();
  await tick(); await tick();
  if (!st.editMode) return { fails: ['进不了编辑模式'] };

  // 星域边界多边形的重心一定在多边形内（凸包/覆盖点），且远离恒星（恒星的 hit 半径 16）
  const borders = st.computeFactionBorders();
  const border = borders.find(b => b.points && b.points.length >= 3);
  if (!border) return { fails: ['没有星域边界'], note: 'no-border' };
  const wx = border.center.x, wy = border.center.y;

  // ① 命中口径（四个消费方都靠它）
  const hit = st.hitTest(wx, wy);
  const hitType = hit && hit.type;
  const hitId = hit && hit.node && hit.node.id;
  if (hitType !== 'domain') fails.push(`hitTest 在星域重心返回 ${hitType}（期望 domain）—— 星域点不到`);
  if (hitId !== border.domainId) fails.push(`命中到别的节点（${hitId} ≠ ${border.domainId}）`);

  // ② 端到端：真实右键 → 菜单里必须有「删除该节点」
  const vt2 = st.renderer.viewTransform;
  st.renderer.focusOn(wx, wy, 0.6);
  await raf2();
  const vt3 = st.renderer.viewTransform;
  const sx = wx * vt3.scale + vt3.x + c.clientWidth / 2;
  const sy = wy * vt3.scale + vt3.y + c.clientHeight / 2;
  c.dispatchEvent(evAt(sx, sy, 'contextmenu', { button: 2 }));
  await tick();
  const items = Array.from(document.querySelectorAll('.sitian-context-menu .menu-item')).map(d => (d.textContent || '').trim());
  const delItem = Array.from(document.querySelectorAll('.sitian-context-menu .menu-item')).find(d => (d.textContent || '').includes('删除该节点'));
  if (!delItem) fails.push(`编辑态右键星域没有「删除该节点」项：${JSON.stringify(items)}`);

  // ③ 点它 → 节点数 -1 → 一次 undo 复原
  const n0 = store.nodes.length;
  if (delItem) { delItem.click(); await tick(); await tick(); }
  const n1 = store.nodes.length;
  if (n1 >= n0) fails.push(`点了删除但节点数没减（${n0} → ${n1}）`);
  store.undo();
  await tick();
  const n2 = store.nodes.length;
  if (n2 !== n0) fails.push(`一次 undo 没复原节点数（${n0} → ${n1} → ${n2}）`);

  // 收尾：退出编辑模式
  const done = Array.from(el.querySelectorAll('button')).find(b => b.textContent.includes('完成编辑'));
  if (done) done.click();
  await tick();
  return { fails, hitType, items: items.length, n0, n1, n2 };
""", 'f3 星域命中')
    if r3.get('fails'):
        fails += [f'[f3 星域命中] {x}' for x in r3['fails']]
    notes.append(f"f3 星域命中：hitType={r3.get('hitType')} / 菜单项 {r3.get('items')} / 节点数 {r3.get('n0')}→{r3.get('n1')}→{r3.get('n2')}")

    # ══════════════════════════════════════════════════════════════════════
    # f4 坐标拖拽（§bug 死代码）：拖手模式拖不动（对照）；移动工具下能拖、能 undo
    # ══════════════════════════════════════════════════════════════════════
    r4 = _probe(cdp, """
  const fails = [];
  const store = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const g = st.galaxyNodes.find(n => !n.locked) || st.galaxyNodes[0];
  if (!g) return { fails: ['没有可拖的恒星'], note: 'no-galaxy' };
  const coordOf = () => {
    const n = store.nodes.find(x => x.id === g.id);
    return n && n.coordinate ? { x: n.coordinate.x, y: n.coordinate.y, moved: !!n.userMoved } : null;
  };
  // 诊断：把每一步的中间量带回来（屏幕坐标/变换/坐标快照）
  const diag = {};
  const dragOnce = async (dxPx, dyPx, tag) => {
    st.renderer.focusOn(g.x, g.y, 1);
    await raf2();
    const vt2 = st.renderer.viewTransform;
    const sx = g.x * vt2.scale + vt2.x + c.clientWidth / 2;
    const sy = g.y * vt2.scale + vt2.y + c.clientHeight / 2;
    diag[tag] = {
      scale: vt2.scale, tx: vt2.x, ty: vt2.y,
      cw: c.clientWidth, ch: c.clientHeight, rl: r.left, rt: r.top,
      sx: sx, sy: sy, gx: g.x, gy: g.y, mode: st.interactionMode,
      rectW: r.width, rectH: r.height,
    };
    diag[tag].before = coordOf();
    c.dispatchEvent(evAt(sx, sy, 'mousedown'));
    diag[tag].afterDown = coordOf();
    c.dispatchEvent(evAt(sx + dxPx * 0.5, sy + dyPx * 0.5, 'mousemove'));
    diag[tag].afterHalf = coordOf();
    c.dispatchEvent(evAt(sx + dxPx, sy + dyPx, 'mousemove'));
    diag[tag].afterFull = coordOf();
    c.dispatchEvent(evAt(sx + dxPx, sy + dyPx, 'mouseup'));
    await tick(); await tick();
    diag[tag].afterUp = coordOf();
    return vt2.scale;
  };

  // ① 对照：拖手模式（默认）拖拽 → 坐标不许动
  const c0 = coordOf();
  await dragOnce(60, 40, 'pan');
  const c1 = coordOf();
  if (!c0 || !c1) return { fails: ['拿不到节点坐标'] };
  if (c1.x !== c0.x || c1.y !== c0.y) fails.push(`拖手模式下坐标变了（${c0.x},${c0.y} → ${c1.x},${c1.y}）—— 防误触失效`);

  // ② 切「移动」工具 → 同一次拖拽必须改坐标，且 userMoved 为真
  const btn = document.querySelector('[data-testid="galaxy-move-tool"]');
  if (!btn) return { fails: ['找不到「移动」工具按钮'], note: 'no-move-btn' };
  btn.click();
  await tick();
  // ⚠️ 基准必须**先快照**：拖动时 `galaxy.x = wx` 改的就是 `st.galaxyNodes` 里这个对象本身
  //    （第一版拿它当基准 → Δ 恒为 0：判据把自己的测量对象改掉了）
  const gx0 = g.x, gy0 = g.y;
  const scale = await dragOnce(60, 40, 'move');
  const c2 = coordOf();
  // 期望值口径：拖拽把节点的 coordinate 设成"它**画在**的地方 + 位移"。
  // 自动布局的恒星画在**布局坐标**（gx0/gy0）上，而不是旧的 coordinate（那是布局重算时
  // 被覆盖的旧值，例如 (737,31) vs 画出来的 (95.5,-600.4)）。所以位移要对着快照量。
  const dxWorld = c2.x - gx0, dyWorld = c2.y - gy0;
  const wantX = 60 / (scale || 1), wantY = 40 / (scale || 1);
  if (Math.abs(dxWorld) < 1) fails.push(`移动工具下拖了 60px，坐标只动了 ${dxWorld.toFixed(1)} —— 链路还是断的（§bug 死代码）`);
  if (Math.abs(dxWorld - wantX) > Math.max(3, wantX * 0.35)) fails.push(`拖动位移对不上：实测 ${dxWorld.toFixed(1)} vs 期望 ${wantX.toFixed(1)}`);
  if (Math.abs(dyWorld - wantY) > Math.max(3, wantY * 0.35)) fails.push(`纵向位移对不上：实测 ${dyWorld.toFixed(1)} vs 期望 ${wantY.toFixed(1)}`);
  if (!c2.moved) fails.push('userMoved 没置真 —— 布局重算时坐标会被重置');

  // ③ 一次 undo 复原
  store.undo();
  await tick();
  const c3 = coordOf();
  if (c3.x !== c1.x || c3.y !== c1.y) fails.push(`一次 undo 没复原坐标（${c3.x},${c3.y} vs ${c1.x},${c1.y}）`);

  // 收尾：工具切回拖手（后面的用例/段都假定默认）+ 镜头回中
  const panBtn = Array.from(el.querySelectorAll('button')).find(b => (b.textContent || '').trim() === '拖手');
  if (panBtn) panBtn.click();
  await tick();
  return { fails, tool: st.interactionMode, dxWorld, dyWorld, wantX, wantY, scale, diag };
""", 'f4 拖拽')
    if r4.get('fails'):
        fails += [f'[f4 拖拽] {x}' for x in r4['fails']]
    notes.append(f"f4 拖拽：拖手模式不动（对照） / 移动工具 Δ=({r4.get('dxWorld'):.1f},{r4.get('dyWorld'):.1f}) 期望 ({r4.get('wantX'):.1f},{r4.get('wantY'):.1f}) / 收尾工具={r4.get('tool')} / 诊断={json.dumps(r4.get('diag'), ensure_ascii=False)[:900]}"
                 if r4.get('dxWorld') is not None else f"f4 拖拽：{r4.get('note', '未完成')} / 诊断={json.dumps(r4.get('diag'), ensure_ascii=False)[:900]}")

    # ══════════════════════════════════════════════════════════════════════
    # f5 星域位置持久化（§bug3）：遗留 coordinate 不采信 / 拖动写库 + userMoved / 恒星跟着走 / 一条 undo
    # ══════════════════════════════════════════════════════════════════════
    r5 = _probe(cdp, """
  const fails = [];
  const store = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const domainsProp = (st.props && st.props.domains) || [];
  if (st.domainNodes.length < 2) return { fails: ['星域不足 2 个，用例前提不成立'], note: 'few-domains' };
  // ⚠️ 先把布局**规范化**再取基线：前一段（f4）拖动过恒星并撤销，而撤销只改数据、不会自己重排
  //    （组件没有 watch 撤销栈）→ 布局副本里还留着那次的拖动位置。拿它当基线会得出假红（本轮实测踩到）。
  st.applyStableLayout();
  await tick();
  const dn = st.domainNodes[0];
  const raw = domainsProp.find(d => d.id === dn.id) || domainsProp[0];
  const coord = (raw && raw.coordinate) || null;

  // ① 初始布局**不许**采信遗留 coordinate（提取器给每个星域都写了它，但没人摆过）
  const ringR = Math.hypot(dn.x, dn.y);
  if (raw && raw.userMoved) fails.push('前提不成立：这个星域已经带 userMoved（用例假设它是"从未被摆过"的）');
  if (coord && dn.x === coord.x && dn.y === coord.y) {
    fails.push(`初始布局用了遗留 coordinate (${coord.x},${coord.y}) —— 老项目会一次性全部错位`);
  }
  if (Math.abs(ringR - 630) > 60) fails.push(`星域没落在环形布局上（到原点 ${ringR.toFixed(0)}，期望 ≈630）`);

  // ② 移动工具拖星域 → 写 coordinate + userMoved
  const btn = document.querySelector('[data-testid="galaxy-move-tool"]');
  if (!btn) return { fails: ['找不到「移动」工具按钮'] };
  btn.click();
  await tick();
  const gals = st.galaxyNodes.filter(g => g.domainId === dn.id && !g.userMoved);
  const gSnap = gals.length ? { id: gals[0].id, x: gals[0].x, y: gals[0].y, userMoved: !!gals[0].userMoved } : null;
  const x0 = dn.x, y0 = dn.y;
  const nodePre = store.nodes.find(n => n.id === dn.id);
  const preStore = nodePre ? { x: nodePre.coordinate.x, y: nodePre.coordinate.y, moved: !!nodePre.userMoved } : null;
  st.renderer.focusOn(x0, y0, 1);
  await raf2();
  const vt = st.renderer.viewTransform;
  const sx = x0 * vt.scale + vt.x + c.clientWidth / 2;
  const sy = y0 * vt.scale + vt.y + c.clientHeight / 2;
  c.dispatchEvent(evAt(sx, sy, 'mousedown'));
  c.dispatchEvent(evAt(sx + 25, sy + 20, 'mousemove'));
  c.dispatchEvent(evAt(sx + 50, sy + 40, 'mousemove'));
  await tick();
  c.dispatchEvent(evAt(sx + 50, sy + 40, 'mouseup'));
  await tick(); await tick();
  const nodeAfter = store.nodes.find(n => n.id === dn.id);
  const wantX = 50 / (vt.scale || 1), wantY = 40 / (vt.scale || 1);
  if (!nodeAfter) return { fails: ['拿不到星域节点'] };
  if (!nodeAfter.userMoved) fails.push('userMoved 没置真 —— 下一次布局重算会把它弹回环形');
  const dx = nodeAfter.coordinate.x - x0, dy = nodeAfter.coordinate.y - y0;
  if (Math.abs(dx - wantX) > Math.max(4, wantX * 0.35)) fails.push(`星域拖动位移对不上：实测 ${dx.toFixed(1)} 期望 ${wantX.toFixed(1)}`);
  if (Math.abs(dy - wantY) > Math.max(4, wantY * 0.35)) fails.push(`星域拖动纵向位移对不上：实测 ${dy.toFixed(1)} 期望 ${wantY.toFixed(1)}`);

  // ③ 该星域下"没被手动摆过"的恒星要跟着走（整簇移动，不是只挪一个圈）
  let galDx = null, galDiag = null;
  if (gSnap) {
    const g2 = st.galaxyNodes.find(g => g.id === gSnap.id);
    galDx = g2 ? g2.x - gSnap.x : null;
    const nodeG = store.nodes.find(n => n.id === gSnap.id);
    galDiag = {
      pickUserMoved: gSnap.userMoved,
      nowUserMoved: g2 ? !!g2.userMoved : null,
      coord: nodeG ? { ...nodeG.coordinate } : null,
      parentId: nodeG ? nodeG.parentId : null,
      layoutDomainId: g2 ? g2.domainId : null,
      galBefore: { x: gSnap.x, y: gSnap.y },
      galAfter: g2 ? { x: g2.x, y: g2.y } : null,
      domainBefore: { x: x0, y: y0 },
      domainAfter: { x: dn.x, y: dn.y },
      groupSize: st.galaxyNodes.filter(g => g.domainId === dn.id).length,
    };
    if (galDx == null || Math.abs(galDx - wantX) > Math.max(6, wantX * 0.5)) {
      fails.push(`星域的恒星没跟着走：Δx=${galDx == null ? 'null' : galDx.toFixed(1)} 期望 ≈${wantX.toFixed(1)}（诊断 ${JSON.stringify(galDiag)}）`);
    }
  }

  // ④ 布局读回：**再跑一次 applyStableLayout**（等价于切走视图再回来）→ 星域画在保存的坐标上
  st.applyStableLayout();
  await tick();
  const dnBack = st.domainNodes.find(d => d.id === dn.id);
  if (Math.abs(dnBack.x - nodeAfter.coordinate.x) > 0.5 || Math.abs(dnBack.y - nodeAfter.coordinate.y) > 0.5) {
    fails.push(`重排后星域没落在保存的坐标上（${dnBack.x.toFixed(1)},${dnBack.y.toFixed(1)} vs ${nodeAfter.coordinate.x},${nodeAfter.coordinate.y}）`);
  }

  // ⑤ 一次 undo = **回到拖动前的样子**：坐标回到拖动前的 store 值、`userMoved` 一起还原、
  //    重排后星域回到环形位置（否则"撤销之后跳到那个从没显示过的遗留坐标上"）
  store.undo();
  await tick();
  const nodeUndo = store.nodes.find(n => n.id === dn.id);
  if (preStore) {
    if (Math.abs(nodeUndo.coordinate.x - preStore.x) > 0.5 || Math.abs(nodeUndo.coordinate.y - preStore.y) > 0.5) {
      fails.push(`一次 undo 没复原星域坐标（${nodeUndo.coordinate.x},${nodeUndo.coordinate.y} vs ${preStore.x},${preStore.y}）`);
    }
    if (!!nodeUndo.userMoved !== preStore.moved) {
      fails.push(`一次 undo 没把 userMoved 还原（${!!nodeUndo.userMoved} vs ${preStore.moved}）—— 撤销后布局仍按"手动摆过"走，会瞬移到遗留坐标`);
    }
  }
  st.applyStableLayout();
  await tick();
  const dnUndo = st.domainNodes.find(d => d.id === dn.id);
  const ringBack = Math.hypot(dnUndo.x, dnUndo.y);
  if (Math.abs(ringBack - 630) > 60) {
    fails.push(`撤销后重排没回到环形布局（到原点 ${ringBack.toFixed(0)}，期望 ≈630）`);
  }
  // 收尾：工具切回拖手（后续段假定默认）
  const panBtn = Array.from(el.querySelectorAll('button')).find(b => (b.textContent || '').trim() === '拖手');
  if (panBtn) panBtn.click();
  await tick();
  return { fails, ringR, dx, dy, wantX, wantY, galDx, galDiag, ringBack, userMoved: !!nodeAfter.userMoved, coordBefore: coord };
""", 'f5 星域')
    if r5.get('fails'):
        fails += [f'[f5 星域持久化] {x}' for x in r5['fails']]
    notes.append(f"f5 星域：环形 |pos|={r5.get('ringR') and round(r5['ringR'])} / 拖动 Δ=({r5.get('dx') and round(r5['dx'],1)},{r5.get('dy') and round(r5['dy'],1)}) 期望 ({round(r5.get('wantX') or 0,1)},{round(r5.get('wantY') or 0,1)}) / 恒星 Δx={r5.get('galDx') and round(r5['galDx'],1)} / userMoved={r5.get('userMoved')} / 撤销后 |pos|={r5.get('ringBack') and round(r5['ringBack'])}")

    # ══════════════════════════════════════════════════════════════════════
    # f6 faction 写入路径：图例填势力名 → 落库 + 配色真的变了 + 一次 undo 复原
    # ══════════════════════════════════════════════════════════════════════
    r6 = _probe(cdp, """
  const fails = [];
  const store = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const domainsProp = (st.props && st.props.domains) || [];
  const inputs = document.querySelectorAll('.legend-faction-input');
  if (inputs.length < 2 || domainsProp.length < 2) return { fails: ['图例里没有势力输入框或星域不足'], note: 'no-input' };
  const domain = domainsProp[1];
  const before = domain.faction;
  if (before) { return { fails: [`前提不成立：${domain.id} 已经有 faction=${before}`], note: 'has-faction' }; }
  const c2 = c.getContext('2d');
  const snap = () => Array.from(c2.getImageData(0, 0, c.width, c.height).data);
  const diffOf = (a, b) => { let d = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i+1] !== b[i+1] || a[i+2] !== b[i+2]) d++; return d; };
  const colorOf = (id) => st.resolveDomainColor(st.domainNodes.find(x => x.id === id));
  const col0 = colorOf(domain.id);
  const a = snap();
  const inp = inputs[1];
  inp.value = '用例势力甲';
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  await raf2();
  const nodeAfter = store.nodes.find(n => n.id === domain.id);
  const col1 = colorOf(domain.id);
  const diff = diffOf(a, snap());
  if (!nodeAfter) return { fails: ['拿不到星域节点'] };
  if (nodeAfter.faction !== '用例势力甲') fails.push(`势力名没落库：node.faction=${nodeAfter.faction}`);
  if (col0 === col1) fails.push(`写了势力名但配色没变（都是 ${col1}）—— getFactionColor 没接上`);
  if (col1 === '#6b5b95') fails.push('配色仍是"无势力"的默认色 #6b5b95');
  if (!diff) fails.push('画布一个像素都没变');
  store.undo();
  await tick();
  const nodeUndo = store.nodes.find(n => n.id === domain.id);
  if ((nodeUndo.faction || undefined) !== (before || undefined)) {
    fails.push(`一次 undo 没复原 faction（${nodeUndo.faction} vs ${before}）`);
  }
  return { fails, col0, col1, diff, faction: nodeAfter.faction };
""", 'f6 势力写入')
    if r6.get('fails'):
        fails += [f'[f6 势力写入] {x}' for x in r6['fails']]
    notes.append(f"f6 势力写入：{r6.get('col0')} → {r6.get('col1')} / 画布变化 {r6.get('diff')} 像素 / faction={r6.get('faction')}")

    # ══════════════════════════════════════════════════════════════════════
    # f7 势力边界写口：只读零副作用 + 可写时一条 undo 把顶点还原（§第十一修）
    # ══════════════════════════════════════════════════════════════════════
    r7 = _probe(cdp, """
  const fails = [];
  const store = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const G = await import('/src/store/writeGate.js');
  const border = st.computeFactionBorders().find(b => b.points && b.points.length >= 3);
  if (!border) return { fails: ['没有星域边界'], note: 'no-border' };
  const id = border.domainId;
  const pts0 = border.points.map(p => ({ x: p.x, y: p.y }));
  const has = () => Object.prototype.hasOwnProperty.call(store.domainBorderOverrides, id);
  const mode0 = G.writeMode.value;

  // ① 只读态：起始快照（preview）+ 提交都必须被拒，**零副作用**
  G.setWriteMode('readonly', '用例：只读');
  const had0 = has();
  const pre = store.setDomainBorderPoints(id, pts0, { preview: true });
  const com = store.setDomainBorderPoints(id, pts0.map(p => ({ x: p.x + 7, y: p.y })));
  if (pre !== null || com !== null) fails.push('只读态写口没有拒绝（返回值应为 null）');
  if (!had0 && has()) fails.push('只读态竟然写进了 domainBorderOverrides（静默改内存）');
  const undoBefore = store.canUndo;

  // ② 可写态：preview（不压栈）→ 提交（一条 undo）→ 一次 undo 把顶点还原回去
  G.setWriteMode(mode0 === 'readonly' ? 'project' : mode0, '用例：恢复');
  const p1 = store.setDomainBorderPoints(id, pts0, { preview: true });
  if (!p1) fails.push('可写态 preview 被拒了');
  const moved = pts0.map((p, i) => (i === 0 ? { x: p.x + 12, y: p.y + 8 } : { x: p.x, y: p.y }));
  const p2 = store.setDomainBorderPoints(id, moved);
  if (!p2) fails.push('可写态提交被拒了');
  const now = store.domainBorderOverrides[id];
  if (!now || Math.abs(now[0].x - (pts0[0].x + 12)) > 0.5) fails.push('提交后覆盖点没变（写口没生效）');
  store.undo();
  await tick();
  const back = store.domainBorderOverrides[id];
  if (!back) fails.push('一次 undo 把整个覆盖键删了（应回到"拖动前的覆盖点"）');
  else if (Math.abs(back[0].x - pts0[0].x) > 0.5 || Math.abs(back[0].y - pts0[0].y) > 0.5) {
    fails.push(`一次 undo 没把顶点还原（${back[0].x},${back[0].y} vs ${pts0[0].x},${pts0[0].y}）`);
  }
  // 收尾：清掉本次留下的覆盖键（走同一个写口，避免给后面的段留脏数据）
  store.setDomainBorderPoints(id, null);
  await tick();
  void undoBefore;
  return { fails, id, had0, cleared: !has(), mode0 };
""", 'f7 边界写口')
    if r7.get('fails'):
        fails += [f'[f7 边界写口] {x}' for x in r7['fails']]
    notes.append(f"f7 边界写口：只读被拒 + 零副作用（had={r7.get('had0')}）/ 可写一条 undo 还原 / 收尾清键={r7.get('cleared')}")

    if fails:
        return False, ' | '.join(notes) + ' ⇒ ' + ' ；'.join(fails)
    return True, ' | '.join(notes)
