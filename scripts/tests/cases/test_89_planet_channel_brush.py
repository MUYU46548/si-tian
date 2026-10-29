#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 89：A3 —— 行星侧文化 / 宗教逐格笔刷（抬手 diff + 一条 undo + 渲染 + 吸管）

背景（2026-10-08，对应 `docs/ROADMAP_NEXT.md` 的 A3）：
  行星主编辑器此前**没有**文化 / 宗教笔刷（`interactionMode` 只有 height/terrain/relief/river/political），
  渲染侧 `drawCultureReligionRegions` 画的还是 Azgaar 导入的参考数据 —— 用户自己的数据无处可画。
  本轮把剧本侧早就有的文化/宗教涂抹能力按**同一份数据模型**补到行星侧，但**不照抄**剧本侧那种
  「每次 mousemove 都 execute + 靠 merge 合栈」的实现（每次移动全量拷贝通道数组 + 整体替换
  heightmap 对象），改用本项目 `provinceEditing` 已验证的「抬手 diff」：
    涂抹期只改**内存里的通道数组** + 记差量账本 → 抬手把整笔压成**一条** undo 并落盘。

覆盖：
  f0 源码守卫（读源码，不启动浏览器也能查）：
     · `channelBrush.js` 存在，且两个写口（begin/end）都登记在写口契约里、函数体首行都有守卫
     · 渲染侧用同一份调色板实现（`buildChannelPalette`），不另写"通道→颜色"的映射
     · 着色下拉的选项表**只有一处**（`RASTER_KIND_OPTIONS`）—— 写两份必然漂移
     · 交互层（composable）不直接碰 writeGate/undo（数据层与交互层分离）
  f1 纯函数层（页面内 import）：调色板按**位置**（不是 id —— 那些 id 是 Date.now()）；
     `cellColor('culture')` 取到调色板色、无主取底色；`buildHeightmapRaster` 对 culture 档产出 canvas
  f2 数据层：一笔拖动 = **一条** undo（不是每次 mousemove 一条）；撤销回旧值、重做回新值；
     通道数组是 `Uint8Array(grid.points.length)`；redo 打 `updatedAt`、undo 不打
  f3 防静默路径：没 begin 就 apply → 0（不会偷偷写）；空笔画 end → null（不压空 undo）
  f4 吸管：涂完取回该格的值；无网格 / 无归属分别给可读结果而不是 0 假命中
  f5 UI 接线：工具栏两枚按钮存在；切到文化模式后**面板出现**、着色自动切到 culture、
     着色下拉在任一模式下都只有一份（不重复渲染）

不重复覆盖：项目文件的落盘链路（双防抖 + IPC）由 test_46 / test_85 负责，本用例断言
内存真值与撤销粒度；渲染像素对齐由 test_69 负责（同一套栅格实现）。
"""
import sys, os, io, re
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json  # noqa: E402
from lib.helpers import ensure_case_state  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"


def _read(rel):
    return io.open(os.path.join(ROOT, rel), encoding='utf-8').read()


def _function_body(src, fn):
    m = re.search(r'\n\s*(?:async\s+)?function\s+' + fn + r'\s*\(', src)
    if not m:
        return None
    nxt = re.search(r'\n\s*(?:async\s+)?function\s+\w+\s*\(', src[m.end():])
    return src[m.end(): m.end() + (nxt.start() if nxt else len(src))]


def _static_guard():
    """返回 problems 列表；空 = 通过"""
    problems = []
    MOD = 'src/renderer/src/store/geodataModules/channelBrush.js'
    if not os.path.exists(os.path.join(ROOT, MOD)):
        return ['channelBrush.js 不存在']
    gate = _read('src/renderer/src/store/writeGate.js')
    m = re.search(r"file:\s*'" + re.escape(MOD) + r"',\s*fns:\s*\[([^\]]*)\]", gate, re.S)
    if not m:
        problems.append('channelBrush.js 未登记进写口契约（MEMORY_WRITE_CALLSITES）')
        registered = set()
    else:
        registered = set(re.findall(r"'([^']+)'", m.group(1)))
    body_src = _read(MOD)
    for fn in ('beginChannelStroke', 'endChannelStroke'):
        if fn not in registered:
            problems.append(f'{MOD} 的 {fn}() 没登记进写口契约')
        b = _function_body(body_src, fn)
        if b is None:
            problems.append(f'{MOD} 找不到 {fn}()')
        elif 'guardWrite(' not in b:
            problems.append(f'{MOD} 的 {fn}() 首行没有 guardWrite（涂抹期会改内存）')

    # 渲染侧必须复用同一份调色板实现（不另写"通道 → 颜色"）
    draw = _read('src/renderer/src/composables/planetDrawing.js')
    if 'buildChannelPalette' not in draw:
        problems.append('planetDrawing 没有用共享的 buildChannelPalette（会有第二套通道配色）')

    # 着色下拉的选项表只应有一处定义（写两份必然漂移）
    pm = _read('src/renderer/src/components/PlanetMap.vue')
    if 'RASTER_KIND_OPTIONS' not in pm:
        problems.append('PlanetMap 没有 RASTER_KIND_OPTIONS 常量（着色选项表可能写了两份）')
    if re.search(r'<option\s+value="(biome|landsea|height|temp|prec|culture|religion)"', pm):
        problems.append('PlanetMap 仍存在硬编码的着色 <option>（应走 RASTER_KIND_OPTIONS）')

    # 通道数组归一化只应有一处（TypedArray / 普通数组 / {0:..} 三态）
    chan_defs = []
    for dirpath, _dirs, files in os.walk(os.path.join(ROOT, 'src')):
        for f in files:
            if not f.endswith('.js') and not f.endswith('.vue'):
                continue
            p = os.path.join(dirpath, f)
            if 'function normalizeChannel' in io.open(p, encoding='utf-8', errors='ignore').read():
                chan_defs.append(os.path.relpath(p, ROOT).replace('\\', '/'))
    if len(chan_defs) != 1:
        problems.append(f'normalizeChannel 定义处数 = {len(chan_defs)}（应为 1）：{chan_defs}')

    # 交互层不直接碰写闸门/撤销栈（那是数据层的事）
    comp = _read('src/renderer/src/composables/usePlanetChannelBrush.js')
    for bad in ("from '../store/undo'", "store/writeGate", "'../store/undo'"):
        if bad in comp:
            problems.append(f'交互层不应直接依赖 {bad}（数据层与交互层要分离）')

    # ── A6（2026-10-29）：行星侧「生成地形」必须**共用**剧本侧那份实现 ──────────────
    # 判据只有两条：① 推演/写口只有一份（`synthesizeTerrainInto` 是唯一实现，两个薄入口）；
    # ② 面板与工具栏都只是"换 target"，没有第二份推演/第二份参数面板。
    sce = _read('src/renderer/src/store/geodataModules/scenarioEditing.js')
    for anchor in ('function resolveTerrainTarget', 'function synthesizeTerrainInto',
                   'function synthesizePlanetTerrain', 'function previewPlanetTerrainSynthesis'):
        if anchor not in sce:
            problems.append(f'scenarioEditing 缺少 `{anchor}`（行星侧推演应复用同一份实现）')
    if sce.count('function synthesizeTerrainInto') != 1:
        problems.append('synthesizeTerrainInto 定义不唯一（出现了第二份推演实现）')
    panel = _read('src/renderer/src/components/TerrainGenPanel.vue')
    if 'planetId' not in panel or 'store.synthesizePlanetTerrain' not in panel \
            or 'store.previewPlanetTerrainSynthesis' not in panel:
        problems.append('TerrainGenPanel 没接行星目标（应传 planetId → 同一个 store 入口）')
    if 'data-testid="planet-gen-terrain"' not in pm or ':planet-id=' not in pm:
        problems.append('PlanetMap 缺少「生成地形」入口（planet-gen-terrain → TerrainGenPanel :planet-id）')
    # 行星笔刷必须登记手绘格，否则「重生成保留手绘」在行星侧永远保留 0 格
    brush = _read('src/renderer/src/composables/usePlanetHeightBrush.js')
    if 'mergeHandEdits' not in brush:
        problems.append('usePlanetHeightBrush 没登记 handEdits（行星侧手绘锁定是空开关）')
    gate = _read('src/renderer/src/store/writeGate.js')
    if 'synthesizeTerrainInto' not in gate:
        problems.append('writeGate 没登记 synthesizeTerrainInto（生成地形的唯一写口）')
    return problems


JS = r"""(async () => {
  const fails = [];
  const notes = [];
  const ck = (label, cond, extra) => {
    if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 200));

  const app = document.querySelector('#app').__vue_app__;
  const store = app._instance.setupState.store;
  const U = await import('/src/store/undo.js');
  ck('装置：store 已就绪（有节点 / 已打开项目）', store.nodes.length > 0, { nodes: store.nodes.length });

  // ══════════════════════════════════════════════════════
  // f1 纯函数层：调色板按位置、cellColor 取色
  // ══════════════════════════════════════════════════════
  {
    const R = await import('/src/utils/heightmapRaster.js');
    const CH = await import('/src/utils/heightmapChannels.js');
    ck('f1 共享模块导出齐全',
       typeof R.buildChannelPalette === 'function' && typeof R.cellColor === 'function'
       && typeof CH.normalizeChannel === 'function', null);

    // ⚠️ 真实数据里 cultures 的 id 是 Date.now() —— 调色板必须按**位置**编
    const list = [{ id: 1759900000000, color: '#ff0000' }, { id: 1759900000001, color: '#00ff00' }];
    const pal = R.buildChannelPalette(list);
    const near = (rgb, want) => rgb && Math.abs(rgb[0] - want[0]) < 2 && Math.abs(rgb[1] - want[1]) < 2 && Math.abs(rgb[2] - want[2]) < 2;
    ck('f1 ★ 调色板按位置（id 是时间戳也不影响）', near(pal[1], [255, 0, 0]) && near(pal[2], [0, 255, 0]),
       { p1: pal[1], p2: pal[2] });
    ck('f1 调色板下标 0 = 无主底色', !!pal[0] && pal[0].length === 3, pal[0]);

    const hm = {
      h: new Float32Array([10, 30]), culture: new Uint8Array([0, 2]), religion: new Uint8Array([1, 0]),
      temp: new Float32Array([0, 0]), prec: new Float32Array([0, 0]),
      grid: { points: [[0, 0], [10, 0]], spacing: 10, cellsX: 2, cellsY: 1, count: 2 },
    };
    ck('f1 cellColor(culture)：有主取调色板色', near(R.cellColor('culture', 1, hm, pal), [0, 255, 0]),
       R.cellColor('culture', 1, hm, pal));
    ck('f1 cellColor(culture)：无主取底色（不是黑/透明）', near(R.cellColor('culture', 0, hm, pal), pal[0]),
       R.cellColor('culture', 0, hm, pal));
    ck('f1 cellColor(religion)：走另一条通道', near(R.cellColor('religion', 0, hm, pal), [255, 0, 0]),
       R.cellColor('religion', 0, hm, pal));
    const built = R.buildHeightmapRaster(hm, 'culture', { palette: pal });
    ck('f1 buildHeightmapRaster 对 culture 档产出画布', !!(built && built.canvas && built.w > 0), !!built);
    ck('f1 通道档没有数据时不产出画布（不画假色块）',
       R.buildHeightmapRaster({ h: hm.h, grid: hm.grid }, 'culture', { palette: pal }) === null, null);
  }

  // ══════════════════════════════════════════════════════
  // f2 数据层：一笔拖动 = 一条 undo
  // ══════════════════════════════════════════════════════
  const mdKeys = Object.keys(store.mapData || {})
    .filter(k => store.mapData[k] && store.mapData[k].heightmap && store.mapData[k].heightmap.grid);
  const pid = mdKeys[0] || null;
  ck('装置：找到带高度图的行星地图', !!pid, { keys: Object.keys(store.mapData || {}).slice(0, 6) });
  if (!pid) return JSON.stringify({ fails, notes });

  const grid = store.mapData[pid].heightmap.grid;
  const pts = grid.points;
  const center = pts[Math.floor(pts.length / 2)];
  const cx = Array.isArray(center) ? center[0] : center.x;
  const cy = Array.isArray(center) ? center[1] : center.y;
  const sumArr = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };

  // 该行星的文化列表（空则自建一条，走 store 的 CRUD）
  if (!Array.isArray(store.mapData[pid].cultures) || !store.mapData[pid].cultures.length) {
    store.addCulture(pid, { id: Date.now(), name: '用例文化', color: '#ff0000' });
  }
  if (!Array.isArray(store.mapData[pid].religions) || !store.mapData[pid].religions.length) {
    store.addReligion(pid, { id: Date.now(), name: '用例宗教', color: '#0000ff' });
  }
  ck('f2 宗教列表 CRUD 可用（与文化的同一份实现）',
     Array.isArray(store.mapData[pid].religions) && store.mapData[pid].religions.length === 1,
     store.mapData[pid].religions);

  const before = store.readChannel(pid, 'culture') || new Uint8Array(pts.length);
  const h0 = U.historyLength.value;
  const u0 = store.mapData[pid].updatedAt;

  const beg = store.beginChannelStroke(pid, 'culture', { afterWrite: () => {} });
  ck('f2 落笔成功', !!(beg && beg.ok === true), beg);

  // 模拟拖动：**多次** apply（真实一次拖动有几十次 mousemove）
  let touched = 0;
  for (const dx of [-20, -10, 0, 10, 20]) {
    touched += store.applyChannelStroke(pid, 'culture', cx + dx, cy, 60, 0.2, 1);
  }
  ck('f2 涂抹命中若干格', touched > 0, { touched });
  const afterStrokeArr = store.readChannel(pid, 'culture');
  ck('f2 涂抹期就改到内存（不必等抬手）', sumArr(afterStrokeArr) > sumArr(before), null);

  const ended = store.endChannelStroke();
  ck('f2 抬手返回改动格数', !!(ended && ended.changed > 0), ended);

  const dh = U.historyLength.value - h0;
  ck('f2 ★ 一次拖动只压**一条** undo（不是每次 mousemove 一条）', dh === 1, { delta: dh });
  const afterArr = store.readChannel(pid, 'culture');
  ck('f2 通道数组是 Uint8Array 且长度 = 网格点数',
     afterArr instanceof Uint8Array && afterArr.length === pts.length, { len: afterArr && afterArr.length, n: pts.length });
  ck('f2 redo 打了 updatedAt（改动时间可追溯）', store.mapData[pid].updatedAt !== u0, null);

  await tick(30);
  const u1 = store.mapData[pid].updatedAt;
  store.undo();
  const undone = store.readChannel(pid, 'culture');
  ck('f2 ★ 撤销回旧值（逐格相等，不看总和）',
     JSON.stringify(Array.from(undone)) === JSON.stringify(Array.from(before)),
     { before: sumArr(before), undone: sumArr(undone) });
  ck('f2 undo **不打** updatedAt（逐字段与改动前一致）', store.mapData[pid].updatedAt === u1, null);

  store.redo();
  const redone = store.readChannel(pid, 'culture');
  ck('f2 ★ 重做回新值（撤销↔重做往返闭合）',
     JSON.stringify(Array.from(redone)) === JSON.stringify(Array.from(afterArr)), null);
  notes.push('f2 一格文化：' + pts.length + ' 格网格，改 ' + (ended && ended.changed) + ' 格，undo 栈 +' + dh);

  // ══════════════════════════════════════════════════════
  // f3 防静默路径
  // ══════════════════════════════════════════════════════
  {
    const rel0 = store.readChannel(pid, 'religion') || new Uint8Array(pts.length);
    const s3 = sumArr(rel0);
    const n3 = store.applyChannelStroke(pid, 'religion', cx, cy, 60, 0.2, 1);   // 没 begin 就 apply
    ck('f3 ★ 没落笔就涂抹 → 0 格（不会偷偷写内存）', n3 === 0, { touched: n3 });
    const rel1 = store.readChannel(pid, 'religion');
    ck('f3 通道未被改动（零副作用）',
       (rel1 === null ? rel0 : rel1).length === rel0.length && sumArr(rel1 === null ? rel0 : rel1) === s3, null);
    const hBefore = U.historyLength.value;
    ck('f3 空笔画抬手 → null（不压空 undo）', store.endChannelStroke() === null, null);
    ck('f3 ★ 空笔画不改变撤销栈长度', U.historyLength.value === hBefore,
       { before: hBefore, after: U.historyLength.value });
  }

  // ══════════════════════════════════════════════════════
  // f4 吸管（B1）
  // ══════════════════════════════════════════════════════
  {
    const cell = store.pickChannelCell(pid, cx, cy);
    ck('f4 吸管返回落点那一格的各通道值', !!(cell && typeof cell.culture === 'number'), cell);
    ck('f4 ★ 吸管吸到刚涂的那格（值 = 1）', cell && cell.culture === 1, cell && cell.culture);
    ck('f4 吸管是纯读：调用后通道不变', JSON.stringify(Array.from(store.readChannel(pid, 'culture'))) === JSON.stringify(Array.from(redone)), null);
    const far = store.pickChannelCell(pid, 1e9, 1e9);
    ck('f4 远到没有网格 → null（不返回假命中）', far === null, far);
  }

  // ══════════════════════════════════════════════════════
  // f5 UI 接线
  // ══════════════════════════════════════════════════════
  {
    // 先导航到行星地图（工具栏按钮只在 PlanetMap 挂载后才在 DOM 里）——
    // 与 test_69 同一套自底向上锚定，避开空壳世界
    let w = store.nodes.find(n => n.layer === 'world'
      && store.nodes.some(c => c.layer === 'star_domain' && c.parentId === n.id))
      || store.nodes.find(n => n.layer === 'world');
    const d = w && store.nodes.find(n => n.layer === 'star_domain' && n.parentId === w.id);
    const g = d && store.nodes.find(n => n.layer === 'galaxy' && n.parentId === d.id);
    const planetNode = (g && store.nodes.find(n => n.layer === 'planet' && n.parentId === g.id))
      || store.nodes.find(n => n.layer === 'planet');
    ck('f5 装置：找到行星节点', !!planetNode, null);
    if (!planetNode) return JSON.stringify({ fails, notes });
    if (w) store.selectWorld(w);
    if (d) store.selectDomain(d);
    if (g) store.selectSystem(g);
    store.selectPlanet(planetNode);
    await tick(700);

    // 进编辑态（与 test_69 同路径）—— 工具坞只在编辑态渲染，按钮断言必须放在这之后
    const entry = Array.from(document.querySelectorAll('button'))
      .find(x => x.classList.contains('edit-entry-btn') || (x.textContent || '').includes('编辑地图'));
    if (entry) entry.click();
    await tick(500);

    const btnC = document.querySelector('[data-testid="tool-culture"]');
    const btnR = document.querySelector('[data-testid="tool-religion"]');
    ck('f5 ★ 工具栏有文化 / 宗教按钮', !!btnC && !!btnR, { culture: !!btnC, religion: !!btnR });

    const el = document.querySelector('.planet-map-container');
    const pm = el && el.__vueParentComponent && el.__vueParentComponent.setupState;
    ck('f5 装置：PlanetMap 已挂载且暴露 setInteractionMode', !!(pm && typeof pm.setInteractionMode === 'function'), null);
    if (!pm || typeof pm.setInteractionMode !== 'function') return JSON.stringify({ fails, notes });

    // ⚠️ setupState 对顶层 ref **自动解包**：`pm.heightmapRasterKind` 可能已是字符串。
    //    两种形态都兼容（不确定就探 typeof，别写死 `.value`）
    const kindNow = () => (pm.heightmapRasterKind && pm.heightmapRasterKind.value !== undefined
      ? pm.heightmapRasterKind.value : pm.heightmapRasterKind);

    pm.setInteractionMode('culture');
    await tick(400);
    const sel = document.querySelector('[data-testid="channel-value"]');
    ck('f5 ★ 切到文化模式后出现通道下拉（面板真的渲染了）', !!sel, null);
    ck('f5 面板有吸管按钮', !!document.querySelector('[data-testid="channel-picker"]'), null);
    ck('f5 ★ 着色自动切到 culture（否则涂了看不见）', kindNow() === 'culture', kindNow());
    const kinds = document.querySelectorAll('[data-testid="heightmap-raster-kind"]');
    ck('f5 着色下拉在任一模式下只有一份（不重复渲染）', kinds.length === 1, { n: kinds.length });
    if (sel) {
      const vals = Array.from(sel.options).map(o => o.value);
      ck('f5 通道下拉有可选项（空列表会自动建一条）', vals.length >= 1, vals);
    }

    pm.setInteractionMode('religion');
    await tick(400);
    ck('f5 切到宗教模式后着色跟着切', kindNow() === 'religion', kindNow());
    ck('f5 宗教模式下通道下拉仍在（同一份面板）', !!document.querySelector('[data-testid="channel-value"]'), null);
    notes.push('f5 UI：工具栏 2 枚按钮 + 面板 + 吸管 + 着色自动切档均已接线');
  }

  // ══════════════════════════════════════════════════════
  // f6 A6（2026-10-29）：行星侧「生成地形」—— 同一份推演 + 手绘锁定 + 一条 undo
  // ══════════════════════════════════════════════════════
  {
    const md = store.mapData[pid];
    // 生成地形要先有轮廓可推：行星本来没有地貌多边形就先画一块（走 store 唯一写口 = 一条 undo）
    if (!Array.isArray(md.terrain) || !md.terrain.length) {
      const p0 = md.heightmap.grid.points[0];
      const bx = Array.isArray(p0) ? p0[0] : p0.x;
      const by = Array.isArray(p0) ? p0[1] : p0.y;
      store.addTerrainPolygon(pid, {
        id: 'a6-contour', name: '用例轮廓',
        points: [{ x: bx, y: by }, { x: bx + 700, y: by },
                 { x: bx + 700, y: by + 460 }, { x: bx, y: by + 460 }],
      });
      notes.push('f6 装置：行星原本没有轮廓，已补一块');
    }
    ck('f6 装置：行星有轮廓可推', (store.mapData[pid].terrain || []).length > 0,
       (store.mapData[pid].terrain || []).length);

    const pv = store.previewPlanetTerrainSynthesis(pid, { seed: 7 }, { count: 3 });
    ck('f6 ★ 行星候选预览走同一份推演（3 张、有格子）',
       !!(pv && pv.ok) && (pv.candidates || []).length === 3
       && pv.candidates.every(c => c.cols > 0 && c.h && c.h.length > 0),
       pv && (pv.reason || pv.message));

    const hm0 = store.mapData[pid].heightmap;
    const cells0 = hm0 && hm0.grid ? hm0.grid.points.length : 0;
    const r1 = store.synthesizePlanetTerrain(pid, { force: true, params: { seed: 7 } });
    ck('f6 ★ 行星生成地形成功', !!(r1 && r1.ok), r1 && r1.message);
    const hm1 = store.mapData[pid].heightmap;
    const cells1 = hm1 && hm1.grid ? hm1.grid.points.length : 0;
    ck('f6 ★ 高度图落在行星自己那份上（换了对象、格数够）',
       hm1 !== hm0 && cells1 > 300 && hm1.h.length === cells1, { cells0, cells1 });
    ck('f6 回执是「按陆地轮廓生成地形」那一条',
       String((r1 && r1.message) || '').includes('已按陆地轮廓生成地形'),
       r1 && String(r1.message).slice(0, 40));
    ck('f6 genSeed 落库（下次重生成靠它判断同种子）',
       Number.isFinite(hm1.genSeed) && hm1.genSeed === 7, hm1.genSeed);

    // 手绘锁定：扫出 6 个陆格抬高到 77 并登记 → 同种子重生成 → 逐格写回
    const pts1 = hm1.grid.points;
    const picked = [];
    const step = Math.max(1, Math.floor(pts1.length / 600));
    for (let i = 0; i < pts1.length && picked.length < 6; i += step) {
      if (!(hm1.h[i] >= 20)) continue;
      const p = pts1[i];
      const x = Array.isArray(p) ? p[0] : p.x;
      const y = Array.isArray(p) ? p[1] : p.y;
      hm1.h[i] = 77;
      picked.push({ x, y, h: 77 });
    }
    ck('f6 装置：找到 ≥3 个陆格可手绘（否则下面两条是空转）', picked.length >= 3, { picked: picked.length });
    hm1.handEdits = picked;
    const r2 = store.synthesizePlanetTerrain(pid, { force: true, params: { seed: 7 }, keepHandEdits: true });
    const hm2 = store.mapData[pid].heightmap;
    ck('f6 ★ 同种子重生成保留手绘（逐格全中）',
       !!(r2 && r2.ok) && r2.handKept === picked.length && (hm2.handEdits || []).length === picked.length,
       { painted: picked.length, kept: r2 && r2.handKept, stored: (hm2.handEdits || []).length });
    const byKey = new Map();
    for (let i = 0; i < hm2.grid.points.length; i++) {
      const p = hm2.grid.points[i];
      byKey.set(`${Array.isArray(p) ? p[0] : p.x},${Array.isArray(p) ? p[1] : p.y}`, i);
    }
    ck('f6 保留的手绘真的写回了新高度图',
       (hm2.handEdits || []).every(e => {
         const i = byKey.get(`${e.x},${e.y}`);
         return i !== undefined && Math.abs(Number(hm2.h[i]) - 77) < 1e-3;
       }), (hm2.handEdits || []).length);

    const r3 = store.synthesizePlanetTerrain(pid, { force: true, params: { seed: 7 }, keepHandEdits: false });
    const hm3 = store.mapData[pid].heightmap;
    ck('f6 ★ 关掉「保留手绘」→ 一条不留（回执写明）',
       !!(r3 && r3.ok) && r3.handKept === 0 && (hm3.handEdits || []).length === 0
       && String(r3.message || '').includes('未保留'),
       { kept: r3 && r3.handKept, msg: r3 && String(r3.message).slice(-40) });

    // 三次生成 = 三条命令：全撤回去，高度图应回到最初那份
    for (let k = 0; k < 3; k++) { store.undo(); await tick(120); }
    const hmBack = store.mapData[pid].heightmap;
    ck('f6 ★ 生成 = 一条 undo（撤 3 次回到生成前那份）',
       hmBack === hm0 || (hmBack && hm0 && hmBack.grid && hm0.grid
         && hmBack.grid.points.length === cells0),
       { back: hmBack && hmBack.grid && hmBack.grid.points.length, want: cells0 });

    // UI：工具栏入口 + 浮面板真的能开（3 张候选画出来）
    // ⚠️ 「生成地形」在**高度**工具坞里（f5 结尾切到了宗教）—— 先切回来，否则按钮不在 DOM
    const pmEl = document.querySelector('.planet-map-container');
    const pmSetup = pmEl && pmEl.__vueParentComponent && pmEl.__vueParentComponent.setupState;
    if (pmSetup && typeof pmSetup.setInteractionMode === 'function') pmSetup.setInteractionMode('height');
    await tick(400);
    const genBtn = document.querySelector('[data-testid="planet-gen-terrain"]');
    ck('f6 ★ 行星工具栏有「生成地形」入口', !!genBtn, null);
    if (genBtn) {
      genBtn.click();
      await tick(800);
      const wrap = document.querySelector('[data-testid="planet-gen-terrain-wrap"]');
      ck('f6 点入口后浮面板打开', !!wrap, null);
      const cands = document.querySelectorAll('[data-testid^="tgen-cand-"]');
      ck('f6 面板里真的有 3 张候选（同一份 TerrainGenPanel）', cands.length === 3, { n: cands.length });
      const painted = Array.from(cands).map((el) => {
        const c = el.querySelector('canvas');
        if (!c) return false;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
        return false;
      });
      ck('f6 候选缩略图不是空白', painted.length === 3 && painted.every(Boolean), painted);
      const closeBtn = wrap && wrap.querySelector('[data-testid="tgen-cancel"]');
      if (closeBtn) closeBtn.click();
      await tick(200);
      ck('f6 点取消后浮面板收起', !document.querySelector('[data-testid="planet-gen-terrain-wrap"]'), null);
    }
    notes.push('f6 行星生成地形：预览 3 张 / 落库 + 手绘保留 / 关掉即丢 / 3 条 undo 归位 / UI 入口可开');
  }

  return JSON.stringify({ fails, notes });
})()"""


def run(cdp):
    fails = []
    notes = []

    # ---- f0 静态守卫 ----
    try:
        problems = _static_guard()
    except Exception as e:
        problems = [f'源码读取异常：{e}']
    if problems:
        fails.extend(problems)

    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    ok, info = ensure_case_state(cdp)
    if not ok:
        return False, f'harness 基线项目未能打开：{info}'

    ok, res = eval_json(cdp, JS, desc='行星侧文化/宗教笔刷')
    if not ok:
        return False, res
    if isinstance(res, dict):
        fails.extend(res.get('fails') or [])
        notes.extend(res.get('notes') or [])

    if fails:
        return False, f'A3 文化/宗教笔刷断言失败 {len(fails)} 项：' + '；'.join(str(x) for x in fails[:10])
    return True, ('行星侧文化/宗教笔刷（抬手 diff = 一条 undo；吸管；渲染档；UI 接线）'
                  + ('；' + '；'.join(notes) if notes else ''))
