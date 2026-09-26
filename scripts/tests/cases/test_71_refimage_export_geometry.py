#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 71：A7 —— 参考底图的导出几何（旋转单位 / 翻转 / 宽高互换 / 多图）

`ROADMAP_NEXT` 的 A7 原文只写了一条「导出按弧度换算」；实测把它拆开后是**四处**错，
而且第一处会让整段导出成为**死代码**：

  ① `useFullMapExport` 读的是 `referenceImage.referenceImage` —— 那是 useReferenceImage 返回的
     **computed ref 对象**（不是值），`.width` 恒为 undefined → 分支永不进入
     → **参考图从来没有被导出过**（导出图与实际画布不一致，且不报错）
  ② 只取"当前激活的一张"，而画布画的是**全部**（P2 多图之后导出没跟上）
  ③ 把 `rotation`（**象限索引 0/1/2/3**，画布用 `% 4` 再乘 90°）当弧度换算
     `* 180 / Math.PI` → 转 1 次导出成 57°
  ④ 漏了 `flipH`（水平翻转）与 90/270 的**宽高互换**

本用例守的是"修好之后仍然对"：

  f0 源码守卫：几何**只有一份实现**（`utils/svgExport.refImageSvgGroup`），
     两处导出都引用它；且不许再出现旧的两种错法
  f1 纯函数：象限索引 → 90° 步进；宽高互换；flipH；包围盒含旋转；负数/坏数据安全
  f2 端到端：真在画布上放一张参考图 → 导出 SVG 里的 `<g>/<image>` 几何正确；
     两张图都要出现；测完还原
"""
import sys, os, io, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json  # noqa: E402
from lib.helpers import goto_planet  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def _code_only(src):
    """剥掉行注释/块注释，只留代码行。

    🔴 必须剥：修完之后我在注释里写了「此前读 `referenceImage.referenceImage`」，子串判据立刻把它当违规（本用例第一版就是这么假红的）。
    """
    out, in_block = [], False
    for line in src.splitlines():
        t = line.strip()
        if in_block:
            if '*/' in t:
                in_block = False
            continue
        if t.startswith('/*'):
            if '*/' not in t:
                in_block = True
            continue
        if t.startswith('//') or t.startswith('*'):
            continue
        out.append(line)
    return '\n'.join(out)


def _static_guard():
    problems = []
    p_svg = os.path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'svgExport.js')
    p_full = os.path.join(ROOT, 'src', 'renderer', 'src', 'composables', 'useFullMapExport.js')
    p_scen = os.path.join(ROOT, 'src', 'renderer', 'src', 'composables', 'useScenarioExport.js')
    p_draw = os.path.join(ROOT, 'src', 'renderer', 'src', 'composables', 'planetDrawing.js')

    if not os.path.isfile(p_svg):
        return ['utils/svgExport.js 不存在']
    svg = io.open(p_svg, encoding='utf-8').read()
    for sym in ['refImageSvgGroup', 'refImageWorldBounds']:
        if f'export function {sym}' not in svg:
            problems.append(f'svgExport 缺少 {sym}')

    full = io.open(p_full, encoding='utf-8').read()
    if 'refImageSvgGroup' not in full or 'refImageWorldBounds' not in full:
        problems.append('useFullMapExport 未使用共享的参考图几何')
    full_code = _code_only(full)
    # 旧的两种错法：读 ref 对象、把象限当弧度（**只看代码**，注释里说明旧写法不算）
    if 'referenceImage.referenceImage' in full_code:
        problems.append('useFullMapExport 又去读 referenceImage.referenceImage（computed ref 对象 → 死代码）')
    if '* 180 / Math.PI' in full_code or '* 180/Math.PI' in full_code:
        problems.append('useFullMapExport 又把 rotation（象限索引）当弧度换算')

    scen = io.open(p_scen, encoding='utf-8').read()
    if 'refImageSvgGroup' not in scen:
        problems.append('useScenarioExport 未使用共享的参考图几何')
    scen_code = _code_only(scen)
    if '* 180 / Math.PI' in scen_code or '* 180/Math.PI' in scen_code:
        problems.append('useScenarioExport 又把 rotation（象限索引）当弧度换算')

    # 画布侧的约定仍是一份实现（象限索引 % 4）
    draw = io.open(p_draw, encoding='utf-8').read()
    if 'function drawReferenceImage' not in draw:
        problems.append('planetDrawing 缺少 drawReferenceImage（画布侧实现不见了？）')
    if 'refImg.rotation || 0) % 4' not in draw:
        problems.append('planetDrawing 的参考图旋转约定变了（应是象限索引 % 4）')
    return problems


JS_PURE = r"""(async () => {
  const fails = [];
  const ck = (label, cond, extra) => {
    if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  };
  const M = await import('/src/utils/svgExport.js');
  const { refImageSvgGroup, refImageWorldBounds } = M;
  const base = { dataUrl: 'data:image/png;base64,AAAA', width: 200, height: 100, scale: 1, offsetX: 0, offsetY: 0 };

  const g0 = refImageSvgGroup({ ...base, rotation: 0 });
  ck('f1 rotation=0 → rotate(0)、按原尺寸 200x100 绘制',
     g0.includes('rotate(0)') && g0.includes('width="200" height="100"'), g0);

  const g1 = refImageSvgGroup({ ...base, rotation: 1 });
  // ★ 旧实现 `rotation * 180 / Math.PI` 会得到 57°（1 弧度）
  ck('f1 ★ rotation=1 → rotate(90)（不是 57 —— 象限索引不是弧度）',
     g1.includes('rotate(90)'), g1);
  ck('f1 ★ rotation=1（90°）→ 宽高互换：图占 100x200',
     g1.includes('width="100" height="200"'), g1);

  const g2 = refImageSvgGroup({ ...base, rotation: 2 });
  ck('f1 rotation=2 → rotate(180)、尺寸不换', g2.includes('rotate(180)') && g2.includes('width="200" height="100"'), g2);

  const g3 = refImageSvgGroup({ ...base, rotation: 3, flipH: true });
  ck('f1 rotation=3 → rotate(270) 且宽高互换', g3.includes('rotate(270)') && g3.includes('width="100" height="200"'), g3);
  ck('f1 flipH → 有 scale(-1,1)（在 rotate 之后）',
     /rotate\(270\) scale\(-1,1\)/.test(g3), g3);

  const gNeg = refImageSvgGroup({ ...base, rotation: -1 });
  ck('f1 rotation=-1 → 归一化到 3（rotate(270)），不产生负角度', gNeg.includes('rotate(270)'), gNeg);

  ck('f1 无 dataUrl → 空串（不产出残缺 image 标签）', refImageSvgGroup({ ...base, dataUrl: '' }) === '', null);
  ck('f1 无尺寸 → 空串', refImageSvgGroup({ dataUrl: 'x', width: 0, height: 0 }) === '', null);
  ck('f1 null → 空串（不抛错）', refImageSvgGroup(null) === '', null);

  const bb0 = refImageWorldBounds({ ...base, rotation: 0 });
  const bb1 = refImageWorldBounds({ ...base, rotation: 1 });
  // 200x100 绕中心转 90° → 包围盒变成 100 宽 200 高
  ck('f1 包围盒 rotation=0 → 200x100',
     bb0 && bb0.maxX - bb0.minX === 200 && bb0.maxY - bb0.minY === 100, bb0);
  ck('f1 ★ 包围盒 rotation=1 → 100x200（算错会把旋转过的底图裁掉一角）',
     bb1 && bb1.maxX - bb1.minX === 100 && bb1.maxY - bb1.minY === 200, bb1);
  const bbOff = refImageWorldBounds({ ...base, rotation: 0, offsetX: 500, offsetY: -300 });
  ck('f1 包围盒跟随 offset',
     bbOff && bbOff.minX === 400 && bbOff.maxX === 600 && bbOff.minY === -350 && bbOff.maxY === -250, bbOff);
  return JSON.stringify({ fails });
})()"""


JS_E2E = r"""(async () => {
  const fails = [];
  const notes = [];
  const ck = (label, cond, extra) => {
    if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 200));

  const app = document.querySelector('#app').__vue_app__;
  const store = app._instance.setupState.store;
  const el = document.querySelector('.planet-map-container');
  const inst = el && el.__vueParentComponent;
  const pm = inst && inst.setupState;
  ck('装置：PlanetMap 已挂载', !!(pm && inst), null);
  if (!pm || !inst) return JSON.stringify({ fails, notes });
  const planetId = inst.props?.planet?.id;
  ck('装置：拿到行星 id', !!planetId, null);
  if (!planetId) return JSON.stringify({ fails, notes });

  const md = store.mapData[planetId];
  ck('装置：行星有 mapData', !!md, null);
  if (!md) return JSON.stringify({ fails, notes });

  // 备份 → 测完必须还原（用例不留残留）
  const backupArr = JSON.parse(JSON.stringify(md.referenceImages || []));
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const mk = (id, rot, flip) => ({
    id, dataUrl: PNG, width: 200, height: 100, scale: 1, rotation: rot,
    flipH: !!flip, offsetX: 0, offsetY: 0, opacity: 0.6, locked: false,
  });

  /** 从 SVG 里抽出"参考图组"的几何（<g transform="...rotate(..)"><image .../>） */
  const refGeom = (svg) => {
    const out = [];
    const re = /transform="translate\(([-\d.]+),([-\d.]+)\) rotate\(([-\d.]+)\)( scale\(-1,1\))?">\s*<image x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/g;
    let m;
    while ((m = re.exec(svg))) {
      out.push({ cx: +m[1], cy: +m[2], angle: +m[3], flip: !!m[4], x: +m[5], y: +m[6], w: +m[7], h: +m[8] });
    }
    return out;
  };

  try {
    // ---------- f2 单位/几何 ----------
    md.referenceImages = [mk('ref_a7_a', 1, false)];
    await tick(300);
    let svg = pm.buildFullMapSVG().svg;
    let geoms = refGeom(svg);
    ck('f2 ★ 参考图**真的**出现在导出里（此前读 computed ref → 死代码，一张都没有）',
       geoms.length === 1, { found: geoms.length });
    if (geoms.length === 1) {
      const g = geoms[0];
      ck('f2 ★ rotation=1 → 导出角度 90°（旧代码是 57°）', g.angle === 90, { angle: g.angle });
      ck('f2 ★ rotation=1 → 宽高互换（占 100x200）', g.w === 100 && g.h === 200, { w: g.w, h: g.h });
      ck('f2 居中偏移正确（-w/2, -h/2）', g.x === -50 && g.y === -100, { x: g.x, y: g.y });
      ck('f2 组原点 = 图的世界坐标 offset', g.cx === 0 && g.cy === 0, { cx: g.cx, cy: g.cy });
    }
    notes.push('单图 rotation=1 → ' + JSON.stringify(geoms[0] || null));

    // ---------- f2 翻转 ----------
    md.referenceImages = [mk('ref_a7_a', 0, true)];
    await tick(300);
    geoms = refGeom(pm.buildFullMapSVG().svg);
    ck('f2 ★ flipH 被导出（scale(-1,1)）—— 旧实现完全漏了翻转',
       geoms.length === 1 && geoms[0].flip, { geoms });

    // ---------- f2 多图 ----------
    md.referenceImages = [mk('ref_a7_a', 0, false), mk('ref_a7_b', 2, false)];
    await tick(300);
    geoms = refGeom(pm.buildFullMapSVG().svg);
    ck('f2 ★ 两张参考图都要导出（旧实现只取"当前激活的一张"）',
       geoms.length === 2, { found: geoms.length });
    const angles = geoms.map(g => g.angle).sort((a, b) => a - b);
    ck('f2 两张图各自的角度正确（0 / 180）', JSON.stringify(angles) === '[0,180]', angles);

    // ---------- f2 包围盒随旋转变化（导出画布尺寸） ----------
    // ⚠️ 必须把参考图放到**远离其它元素**的地方：否则总包围盒由地形/区域/标记主导，
    //    旋转参考图完全不改变总边界 → 断言恒等（本用例第一版就这么假红）。
    const far = mk('ref_a7_a', 0, false);
    far.offsetX = 100000; far.offsetY = 100000;
    md.referenceImages = [far];
    await tick(250);
    const r0 = pm.buildFullMapSVG();
    md.referenceImages = [{ ...far, rotation: 1 }];
    await tick(250);
    const r1 = pm.buildFullMapSVG();
    // 200x100 转 90° → 100x200。放在 +100000 处时，图是全局**外侧**边界 →
    // 只有 maxX / maxY 一侧在动 → 变化量 = (200-100)/2 = 50（两侧同时动要图在正中，
    // 但那样 minX/minY 会被地形覆盖，观测不到）。
    const expect = (200 - 100) / 2;
    ck('f2 ★ 旋转 90° 后导出边界随之变化（说明包围盒含旋转，而不是按未旋转尺寸算）',
       (r0.width - r1.width) === expect && (r1.height - r0.height) === expect,
       { r0: { w: r0.width, h: r0.height }, r1: { w: r1.width, h: r1.height }, expect });
  } finally {
    md.referenceImages = JSON.parse(JSON.stringify(backupArr));
    await tick(200);
  }

  // 还原核对：导出里的参考图数量必须回到备份时的数量（用例不留残留）
  const after = refGeom(pm.buildFullMapSVG().svg);
  ck('f2 测完已还原（参考图不留残留）',
     after.length === backupArr.length, { left: after.length, expect: backupArr.length });
  return JSON.stringify({ fails, notes });
})()"""


def run(cdp):
    fails = []

    problems = _static_guard()
    if problems:
        fails.append('f0：' + '；'.join(problems))

    level = goto_planet(cdp)
    if level != 'planet':
        return False, f'导航行星失败: {level}'
    wait_for(cdp, "!!document.querySelector('.planet-map-container')", desc='PlanetMap 挂载', timeout=15)

    ok, res = eval_json(cdp, JS_PURE, desc='参考图 SVG 几何（纯函数）')
    if not ok:
        fails.append(f'f1 求值：{res}')
    elif res.get('fails'):
        fails.extend(['f1：' + str(x) for x in res['fails'][:8]])

    ok2, res2 = eval_json(cdp, JS_E2E, desc='参考图导出（端到端）')
    if not ok2:
        fails.append(f'f2 求值：{res2}')
    elif res2.get('fails'):
        fails.extend(['f2：' + str(x) for x in res2['fails'][:8]])

    notes = (res2.get('notes') or []) if isinstance(res2, dict) else []
    if fails:
        return False, f'A7 断言失败 {len(fails)} 项：' + '；'.join(fails[:10])

    return True, ('参考图几何单源（两处导出共用 refImageSvgGroup）；象限索引 → 90° 步进、宽高互换、flipH、'
                  '包围盒含旋转；导出里真的出现参考图（单图/多图/翻转）'
                  + ('；' + '；'.join(notes) if notes else ''))
