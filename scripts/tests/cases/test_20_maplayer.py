#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 20：FMG .map 底图图层解析专项（P1-T1/T2/T3/T5 的数据地基）

覆盖目标（回归「硬编码行号」这一类错误）：
  1. .map 段位移鲁棒性：SVG 段行数变化后，biomes/cultures/religions/provinces/burgs/rivers/routes
     仍要按内容结构被正确识别（旧实现写死 lines[160]/[165]，位移后取到 zones / cells.good）
  2. grid 级数组（h/temp/prec）按 grid 锚点 + 位置解析，长度与网格点数一致
  3. 省份几何来自 provincesBody 的 path，文化/宗教通过 province → burg → culture 落到省份上
  4. 河流/道路几何来自 SVG 已渲染 path，索引与 rivers[]/routes[] 元数据对应

不依赖真实 4MB .map（测试仓库不落大文件）：在页面里用 JS 拼一份结构等价的合成 .map。
"""
import json


SYNTH_BUILDER_JS = r"""
() => {
  const L = [];
  L[0] = '1.151.2|File can be loaded|2026-9-10|1';
  L[1] = 'km|4|square|m|2|°C';
  L[2] = JSON.stringify({ latT: 0, latN: 0, latS: 0, lonT: 0, lonW: 0, lonE: 0 });
  L[3] = JSON.stringify([
    { i: 0, name: 'Marine', color: '#466eab', habitability: 0 },
    { i: 1, name: 'Testforest', color: '#33aa33', habitability: 6 },
  ]);
  L[4] = JSON.stringify([{ id: 0, name: 'note0', legend: 'x' }]);
  L[5] = [
    '<svg id="map" data-layer="map" width="100" height="100" version="1.1" xmlns="http://www.w3.org/2000/svg">',
    '<g id="featurePaths">',
    '<path d="M0,0L30,0 30,30 0,30Z" id="feature_1"/>',
    '</g>',
    '<g id="textPaths"><path id="textPath_1" d="M1,1L2,2"/></g>',
    '<!-- padding 1 -->',
    '<!-- padding 2 -->',
    '<mask id="land"><use href="#feature_1" data-f="1" fill="white"/></mask>',
    '<g id="provincesBody">',
    '<path d="M0,0L30,0 30,30 0,30Z" id="province1"/>',
    '</g>',
    '<g id="rivers"><path id="river1" d="M5,5L10,10L15,15"/></g>',
    '<g id="roads"><path id="route0" d="M5,5L10,5L15,10"/></g>',
    '<g id="trails"><path id="route1" d="M1,1L2,2L3,3"/></g>',
    '</svg>',
  ].join('\n');
  L[6] = JSON.stringify({
    spacing: 10, cellsX: 3, cellsY: 3, boundary: [], cellsDesired: 9,
    points: [[5, 5], [15, 5], [25, 5], [5, 15], [15, 15], [25, 15], [5, 25], [15, 25], [25, 25]],
  });
  L[7] = '5,25,5,25,60,25,5,25,5';
  L[8] = '0,0,0,0,10,0,0,0,0';
  L[9] = '1,1,1,1,2,1,1,1,1';
  L[10] = '0,0,0,0,1,0,0,0,0';
  L[11] = '-5,0,5,10,-10,10,5,0,-5';
  L[12] = JSON.stringify([0, { i: 1, type: 'island', land: true, cells: 9, firstCell: 0 }]);
  L[30] = JSON.stringify([0, { i: 1, state: 1, burg: 1, name: 'Testprov', formName: 'Earldom' }]);
  L[13] = JSON.stringify([
    { i: 0, name: 'Wildlands', base: 1, origins: [null], type: 'Generic' },
    { i: 1, name: 'Testfolk', base: 32, center: 5, color: '#ff0000', type: 'River', expansionism: 1.6, origins: [0] },
  ]);
  L[29] = JSON.stringify([
    { i: 0, name: 'No religion', origins: null },
    { i: 1, name: 'Testfolk Spirits', type: 'Folk', form: 'Animism', culture: 1, center: 5, color: '#ff0000', origins: [0] },
  ]);
  L[14] = JSON.stringify([
    { i: 0, name: 'Neutral' },
    { i: 1, name: 'Testia', color: '#00ff00', capital: 1, neighbors: [], cells: 9 },
  ]);
  L[15] = JSON.stringify([
    0,
    { i: 1, name: 'Testcap', x: 15, y: 15, cell: 1, capital: 1, population: 10, state: 1, culture: 1, feature: 1, group: 'capital' },
  ]);
  L[32] = JSON.stringify([{ i: 1, name: 'Testriver', type: 'River', width: 0.3, discharge: 100, cells: [1, 2] }]);
  L[37] = JSON.stringify([
    { i: 0, group: 'roads', name: 'Test road', feature: 1, points: [[5, 5], [10, 5], [15, 10]] },
    { i: 1, group: 'trails', name: 'Test trail', feature: 1, points: [[1, 1], [2, 2], [3, 3]] },
  ]);
  for (let i = 16; i <= 52; i++) {
    if (L[i] === undefined) L[i] = '';
  }
  return L.join('\r\n') + '\r\n';
}
"""

SYNTH_JS = r"""
async () => {
  const mod = await import('/src/utils/azgaar-parser.js');
  const build = """ + SYNTH_BUILDER_JS + """;
  const parsed = mod.parseMapFile(build());

  const prov = parsed.terrain[0] || {};
  return JSON.stringify({
    provinces: parsed.terrain.length,
    heightCells: parsed.heightmap.h.length,
    gridPoints: parsed.heightmap.grid.points.length,
    gridSpacing: parsed.heightmap.grid.spacing,
    hMax: Math.max.apply(null, parsed.heightmap.h),
    tempMin: Math.min.apply(null, parsed.heightmap.temp),
    precMax: Math.max.apply(null, parsed.heightmap.prec),
    cultures: parsed.cultures.length,
    religions: parsed.religions.length,
    biomes: parsed.biomes.length,
    states: parsed.states.length,
    rivers: parsed.rivers.length,
    riverPoints: (parsed.rivers[0] || {}).points ? parsed.rivers[0].points.length : 0,
    riverName: (parsed.rivers[0] || {}).name,
    routes: parsed.routes.length,
    routeGroups: parsed.routes.map(r => r.group).sort().join(','),
    provName: prov.name,
    provCulture: prov.culture,
    provCultureColor: prov.cultureColor,
    provReligion: prov.religion,
    provReligionColor: prov.religionColor,
    provState: prov.stateName,
    provBurg: prov.burgId,
    provPoints: (prov.points || []).length,
    ownershipKeys: Object.keys(parsed.ownership).length,
    warnings: parsed.warnings.length,
  });
}
"""


UI_JS = r"""
(async () => { try {
  const mod = await import('/src/utils/azgaar-parser.js');
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  // 用同一份合成 .map 建底图（与解析专项共用结构）
  const f = """ + SYNTH_BUILDER_JS + """;
  const parsed = mod.parseMapFile(f());
  const json = mod.buildScenariosJson(parsed, 'TestMap', '当前');
  const store = document.querySelector('#app').__vue_app__._instance.setupState.store;
  store.importFromScenariosJson(json);

  const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('历史剧本'));
  if (!btn) return JSON.stringify({ error: 'no-scenario-btn' });
  btn.click();
  await wait(700);
  const host = document.querySelector('.scenario-map-container');
  if (!host) return JSON.stringify({ error: 'no-scenario-map' });
  const st = host.__vueParentComponent.setupState;
  st.baseMapKey = 'TestMap';
  await wait(300);

  const canvas = document.querySelector('.scenario-canvas-wrap canvas');
  const rect = canvas.getBoundingClientRect();
  const click = (wx, wy, shift) => canvas.dispatchEvent(new MouseEvent('click', {
    clientX: rect.left + wx, clientY: rect.top + wy, shiftKey: !!shift, bubbles: true, button: 0,
  }));
  const world = () => (st.drawPoints || []).map(p => ({ x: p.x, y: p.y }));

  // 视图标定为 1:1，世界坐标 = 屏幕坐标（便于断言）
  st.cameraScale = 1;
  st.cameraX = 0;
  st.cameraY = 0;
  st.snapToEdgeEnabled = true;
  st.snapToGridEnabled = true;
  st.render();

  const out = {};

  // P0-T3 回归：网格吸附（(140,90) → (150,100)）
  st.setTool('draw');
  click(140, 90);
  out.gridPoint = world()[0] || null;

  // P0-T2 验收：靠近省份边界（province1 的上边 y=0）时吸附到边界
  st.setTool('draw');
  click(15, 4);
  out.edgePoint = world()[0] || null;

  // P0-T2 验收：Shift 临时禁用吸附（点应保持原坐标）
  st.setTool('draw');
  click(15, 4, true);
  out.shiftPoint = world()[0] || null;

  // 远离任何边界时不应发生边界吸附（回落到网格）
  st.setTool('draw');
  click(240, 190);
  out.farPoint = world()[0] || null;

  // P0-T1 验收：绘制新省份自动生成 1/3 切线控制点
  st.setTool('draw');
  click(60, 60);
  click(180, 60);
  click(180, 180);
  canvas.dispatchEvent(new MouseEvent('dblclick', { clientX: rect.left + 180, clientY: rect.top + 180, bubbles: true }));
  await wait(120);
  const bm = st.baseMap;
  const np = bm.terrain[bm.terrain.length - 1] || { points: [] };
  const p0 = np.points[0] || {};
  out.bezier = {
    total: bm.terrain.length,
    name: np.name,
    pts: np.points.length,
    controlOut: p0.controlOut || null,
    controlIn: p0.controlIn || null,
    allHaveControls: np.points.length > 2 && np.points.every(p => p.controlOut && p.controlIn),
    // 验收：控制点 = 相邻顶点连线的 1/3（三个顶点的三角，p0 的前一点是 p2、后一点是 p1）
    expectOut: np.points.length === 3
      ? { x: (np.points[1].x - np.points[2].x) / 3, y: (np.points[1].y - np.points[2].y) / 3 }
      : null,
  };

  // Alt 临时直线：切断控制点渲染后像素应发生变化
  st.tool = 'select';
  st.colorMode = 'default';
  st.rasterLayer = 'none';
  st.selectedProvince = np;
  st.render();
  const g = canvas.getContext('2d');
  const snap = () => new Uint8ClampedArray(g.getImageData(0, 0, canvas.width, canvas.height).data);
  const before = snap();
  const altDown = new KeyboardEvent('keydown', { key: 'Alt', bubbles: true });
  window.dispatchEvent(altDown);
  st.render();
  const after = snap();
  let dAlt = 0;
  for (let i = 0; i < before.length; i += 4) {
    if (Math.abs(before[i] - after[i]) > 10 || Math.abs(before[i + 1] - after[i + 1]) > 10 || Math.abs(before[i + 2] - after[i + 2]) > 10) dAlt++;
  }
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', bubbles: true }));
  st.render();
  out.altDiff = dAlt;

  return JSON.stringify(out);
} catch (e) { return JSON.stringify({ error: 'JS: ' + String((e && e.stack) || e) }); } })()
"""


def _as_json(raw, phase):
    """cdp.eval 返回异常时是 {'__err__': ...} 字典，这里统一报错"""
    if isinstance(raw, dict):
        return None, f'{phase}阶段 JS 异常: {raw.get("__err__", raw)}'
    if not raw:
        return None, f'{phase}阶段无返回'
    try:
        return json.loads(raw), None
    except Exception as e:
        return None, f'{phase}阶段返回非 JSON: {str(raw)[:200]} ({e})'


def run(cdp):
    # cdp.eval 内部已开 awaitPromise + returnByValue，这里直接传 async IIFE 表达式
    raw = cdp.eval("(async () => { const f = " + SYNTH_JS + "; return await f(); })()")
    d, err = _as_json(raw, '解析')
    if err:
        return False, err

    checks = [
        ('省份数=1（来自 provincesBody path）', d['provinces'] == 1, d['provinces']),
        ('省份顶点数=4', d['provPoints'] == 4, d['provPoints']),
        ('grid 网格点数=9', d['gridPoints'] == 9, d['gridPoints']),
        ('grid spacing=10', d['gridSpacing'] == 10, d['gridSpacing']),
        ('高度数组长度=9', d['heightCells'] == 9, d['heightCells']),
        ('高度最大值=60', d['hMax'] == 60, d['hMax']),
        ('温度最小值=-10', d['tempMin'] == -10, d['tempMin']),
        ('降水最大值=10', d['precMax'] == 10, d['precMax']),
        ('biomes 段（位移后仍识别）=2', d['biomes'] == 2, d['biomes']),
        ('cultures 段（位移后仍识别）=2', d['cultures'] == 2, d['cultures']),
        ('religions 段（位移后仍识别）=2', d['religions'] == 2, d['religions']),
        ('states 段=2', d['states'] == 2, d['states']),
        ('河流几何=1', d['rivers'] == 1, d['rivers']),
        ('河流折线点=3', d['riverPoints'] == 3, d['riverPoints']),
        ('河流元数据名称=Testriver', d['riverName'] == 'Testriver', d['riverName']),
        ('道路几何=2', d['routes'] == 2, d['routes']),
        ('道路分组=roads,trails', d['routeGroups'] == 'roads,trails', d['routeGroups']),
        ('省名=Testprov', d['provName'] == 'Testprov', d['provName']),
        ('省文化=Testfolk（province→burg→culture）', d['provCulture'] == 'Testfolk', d['provCulture']),
        ('省文化色=#ff0000', d['provCultureColor'] == '#ff0000', d['provCultureColor']),
        ('省宗教=Testfolk Spirits', d['provReligion'] == 'Testfolk Spirits', d['provReligion']),
        ('省宗教色=#ff0000', d['provReligionColor'] == '#ff0000', d['provReligionColor']),
        ('省势力名=Testia', d['provState'] == 'Testia', d['provState']),
        ('省关联城镇=1', d['provBurg'] == 1, d['provBurg']),
        ('势力归属表=1 条', d['ownershipKeys'] == 1, d['ownershipKeys']),
    ]
    bad = [c for c in checks if not c[1]]
    if bad:
        detail = '；'.join(f'{n} → {v}' for n, _, v in bad)
        return False, f'解析阶段 {len(checks) - len(bad)}/{len(checks)} 通过，失败：{detail}'

    # ── 阶段 2：地图交互行为（P0-T1 贝塞尔 / P0-T2 海岸线吸附 / P0-T3 网格吸附回归）──
    raw_ui = cdp.eval(UI_JS)
    u, err = _as_json(raw_ui, '交互')
    if err:
        return False, err
    if u.get('error'):
        return False, f'UI 阶段页面错误: {u["error"]}'

    gp = u.get('gridPoint') or {}
    ep = u.get('edgePoint') or {}
    sp = u.get('shiftPoint') or {}
    fp = u.get('farPoint') or {}
    bz = u.get('bezier') or {}
    co = bz.get('controlOut') or {}
    exp = bz.get('expectOut') or {}

    ui_checks = [
        ('P0-T3 网格吸附 (140,90)→(150,100)',
         abs(gp.get('x', 0) - 150) < 0.01 and abs(gp.get('y', 0) - 100) < 0.01, gp),
        ('P0-T2 边界吸附 (15,4)→(15,0)',
         abs(ep.get('x', -1) - 15) < 0.5 and abs(ep.get('y', -1)) < 0.5, ep),
        ('P0-T2 Shift 禁用吸附（保持 (15,4)）',
         abs(sp.get('x', 0) - 15) < 0.01 and abs(sp.get('y', 0) - 4) < 0.01, sp),
        ('P0-T2 远离边界不吸附（网格 (250,200)）',
         abs(fp.get('x', 0) - 250) < 0.01 and abs(fp.get('y', 0) - 200) < 0.01, fp),
        ('P0-T1 新省份已入库(共 2 个)', bz.get('total') == 2, bz.get('total')),
        ('P0-T1 三个顶点全带切线', bool(bz.get('allHaveControls')), bz.get('allHaveControls')),
        ('P0-T1 控制点 = 相邻顶点连线 1/3',
         abs(co.get('x', 0) - exp.get('x', 0)) < 0.01 and abs(co.get('y', 0) - exp.get('y', 0)) < 0.01,
         f'实际 {co} / 期望 {exp}'),
        ('P0-T1 Alt 临时直线生效（像素差分>0）', u.get('altDiff', 0) > 0, u.get('altDiff')),
    ]
    bad_ui = [c for c in ui_checks if not c[1]]
    if bad_ui:
        return False, 'UI 阶段失败：' + '；'.join(f'{n} → {v}' for n, _, v in bad_ui)

    return True, (
        f'解析 {len(checks)}/{len(checks)} + 交互 {len(ui_checks)}/{len(ui_checks)} 全通过：'
        f'段位移后仍正确识别 cultures/religions/provinces/rivers/routes；'
        f'高度 {d["hMax"]} / 温度 {d["tempMin"]}°C / 降水 {d["precMax"]}；'
        f'网格吸附 {gp}、边界吸附 {ep}、Shift 旁路 {sp}；贝塞尔控制点 {co}'
    )
