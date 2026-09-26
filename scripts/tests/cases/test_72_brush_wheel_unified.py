#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 72：A6 —— 笔刷工具的统一滚轮契约（滚轮=半径 / Shift+滚轮=强度）

`ROADMAP_NEXT` 的 A6：同一个应用两套手感 —— 剧本视图支持「滚轮=半径、Shift+滚轮=强度」
（`ScenarioMap.onWheel`），而行星图只有滑块，滚轮一律走画布缩放。

本用例守两件事：

  f0 源码守卫：`onWrapperWheel` 覆盖 height / terrain / relief 三个笔刷模式，
     且**步进与范围取自滑块自身**（20-300/10、0.5-10/0.5、1-30/1、0-1/0.05）
     —— 滚轮若另立一套数字，就会出现"滚轮能调出滑块调不出的值"这种静默不一致
  f1 行为（真事件）：**上滚增大 / 下滚减小**、Shift 改的是强度而不是半径、
     到边界夹住、非笔刷模式**不拦截**（滚轮仍归画布缩放）

⚠️ 事件必须派发到 `.canvas-wrapper` 并走**捕获阶段**（模板用 `@wheel.capture`）——
   直接改 ref 值会绕过「事件 → 处理器 → ref → 重绘」整条链，抓不到漏接线这类缺陷。
"""
import sys, os, io, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json  # noqa: E402
from lib.helpers import goto_planet, enter_edit  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def _static_guard():
    problems = []
    p = os.path.join(ROOT, 'src', 'renderer', 'src', 'components', 'PlanetMap.vue')
    src = io.open(p, encoding='utf-8').read()

    if 'function onWrapperWheel' not in src:
        return ['PlanetMap 缺少 onWrapperWheel']
    if '@wheel.capture="onWrapperWheel"' not in src:
        problems.append('滚轮没有走捕获阶段（@wheel.capture）→ 同一次滚轮会同时触发画布缩放')

    # 三个笔刷模式都要有自己的分支
    for mode in ["mode === 'height'", "mode === 'terrain'", "mode === 'relief'"]:
        if mode not in src:
            problems.append(f'onWrapperWheel 缺分支：{mode}')

    # 步进/范围必须与滑块一致（写死这几个数就是"滚轮能调出滑块调不出的值"的隐患）
    checks = [
        ('clampStep(b.brushRadius.value, 10, 20, 300)', '高度笔刷半径（滑块 20-300 / step 10）'),
        ('clampStep(b.brushStrength.value, 0.5, 0.5, 10)', '高度笔刷强度（滑块 0.5-10 / step 0.5）'),
        ('clampStep(terrainBrushSize.value, 1, 1, 30)', '地形笔刷大小（滑块 1-30 / step 1）'),
        ('clampStep(terrainBrushHardness.value, 0.05, 0, 1)', '地形笔刷硬度（滑块 0-1 / step 0.05）'),
    ]
    for frag, desc in checks:
        if frag not in src:
            problems.append(f'滚轮步进/范围与滑块不一致：{desc}')

    # 滑块本身仍在（范围是它们的）
    for frag in ['min="20" max="300" step="10"', 'min="0.5" max="10" step="0.5"',
                 'min="1" max="30" step="1"', 'min="0" max="1" step="0.05"']:
        if frag not in src:
            problems.append(f'找不到对应滑块：{frag}')

    if 'brush-wheel-hint' not in src:
        problems.append('缺少滚轮手势提示（用户不知道有这组手势）')
    return problems


JS_MAIN = r"""(async () => {
  const fails = [];
  const notes = [];
  const ck = (label, cond, extra) => {
    if (!cond) fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 120));

  const el = document.querySelector('.planet-map-container');
  const pm = el && el.__vueParentComponent && el.__vueParentComponent.setupState;
  ck('装置：PlanetMap 已挂载', !!pm, null);
  if (!pm) return JSON.stringify({ fails, notes });
  ck('装置：处于编辑模式（滚轮契约只在编辑态生效）', !!pm.editMode, null);
  if (!pm.editMode) return JSON.stringify({ fails, notes });

  const wrap = document.querySelector('.planet-map-container .canvas-wrapper');
  ck('装置：canvas-wrapper 就绪', !!wrap, null);
  if (!wrap) return JSON.stringify({ fails, notes });

  // 真事件：派发到 wrapper（模板绑的是捕获阶段）
  const wheel = async (deltaY, shift) => {
    const r = wrap.getBoundingClientRect();
    wrap.dispatchEvent(new WheelEvent('wheel', {
      deltaY, shiftKey: !!shift, bubbles: true, cancelable: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }));
    await tick(120);
  };

  const HB = pm.planetHeightBrush;
  ck('装置：高度笔刷 ref 可用', !!(HB && HB.brushRadius && HB.brushStrength), null);

  // ---------- f1 高度笔刷：滚轮 = 半径 ----------
  pm.setInteractionMode('height');
  await tick(200);
  const r0 = HB.brushRadius.value;
  await wheel(-100, false);                    // 上滚 → 增大
  const r1 = HB.brushRadius.value;
  ck('f1 ★ 上滚 → 半径增大（步进 10，与滑块一致）', r1 === r0 + 10, { from: r0, to: r1 });
  await wheel(100, false);                     // 下滚 → 减小
  ck('f1 ★ 下滚 → 半径减小回原值', HB.brushRadius.value === r0, { now: HB.brushRadius.value, expect: r0 });

  // Shift：改的是强度，半径不动
  const s0 = HB.brushStrength.value, rKeep = HB.brushRadius.value;
  await wheel(-100, true);
  ck('f1 ★ Shift+滚轮 → 改**强度**（步进 0.5）',
     Math.abs(HB.brushStrength.value - (s0 + 0.5)) < 1e-6, { from: s0, to: HB.brushStrength.value });
  ck('f1 ★ Shift+滚轮**不动**半径', HB.brushRadius.value === rKeep, { now: HB.brushRadius.value, expect: rKeep });
  await wheel(100, true);                      // 还原强度
  ck('f1 Shift+下滚 → 强度回落', Math.abs(HB.brushStrength.value - s0) < 1e-6, { now: HB.brushStrength.value });

  // 边界夹住：连续下滚到下限 20
  for (let i = 0; i < 30; i++) await wheel(100, false);
  ck('f1 ★ 连续下滚夹在下限 20（不会调出滑块范围外）', HB.brushRadius.value === 20, { now: HB.brushRadius.value });
  for (let i = 0; i < 40; i++) await wheel(-100, false);
  ck('f1 ★ 连续上滚夹在上限 300', HB.brushRadius.value === 300, { now: HB.brushRadius.value });
  HB.brushRadius.value = r0;                   // 还原到用例开始时
  await tick(120);

  // ---------- f1 地形笔刷：滚轮 = 大小 / Shift = 硬度 ----------
  pm.setInteractionMode('terrain');
  await tick(200);
  // ⚠️ 这两种取法**不一样**：`planetHeightBrush` 是对象（内部 ref 不解包 → 要 .value）；
  //    `terrainBrushSize` 是组件顶层 ref（setupState 自动解包 → 再加 .value 就是 undefined）
  const t0 = pm.terrainBrushSize;
  await wheel(-100, false);
  ck('f1 地形笔刷：上滚 → 大小 +1 格', pm.terrainBrushSize === t0 + 1, { from: t0, to: pm.terrainBrushSize });
  const h0 = pm.terrainBrushHardness;
  await wheel(-100, true);
  ck('f1 地形笔刷：Shift+滚轮 → 硬度 +0.05',
     Math.abs(pm.terrainBrushHardness - (h0 + 0.05)) < 1e-6,
     { from: h0, to: pm.terrainBrushHardness });
  await wheel(100, false);
  await wheel(100, true);
  notes.push('地形笔刷还原：大小 ' + pm.terrainBrushSize + ' / 硬度 ' + pm.terrainBrushHardness);

  // ---------- f1 非笔刷模式：不拦截（半径不变） ----------
  pm.setInteractionMode('pan');
  await tick(200);
  const pR = HB.brushRadius.value, pS = pm.terrainBrushSize;
  await wheel(-100, false);
  await wheel(-100, true);
  ck('f1 ★ 非笔刷模式（pan）不拦截滚轮：笔刷参数一个都不动',
     HB.brushRadius.value === pR && pm.terrainBrushSize === pS,
     { radius: HB.brushRadius.value, size: pm.terrainBrushSize });

  // 收尾：回到 pan（不留在某个笔刷模式，避免影响后续用例）
  pm.setInteractionMode('pan');
  await tick(150);
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
    if enter_edit(cdp) != 'ok':
        return False, '进入编辑模式失败'
    wait_for(cdp, "!!document.querySelector('.planet-map-container .canvas-wrapper')", desc='画布就绪', timeout=10)

    ok, res = eval_json(cdp, JS_MAIN, desc='滚轮契约')
    if not ok:
        fails.append(f'求值：{res}')
    elif res.get('fails'):
        fails.extend([str(x) for x in res['fails'][:10]])

    notes = (res.get('notes') or []) if isinstance(res, dict) else []
    if fails:
        return False, f'A6 断言失败 {len(fails)} 项：' + '；'.join(fails[:10])

    return True, ('滚轮契约与剧本视图一致（滚轮=半径/大小、Shift+滚轮=强度/硬度、上滚增大）；'
                  '步进与范围取自滑块自身；边界夹住；非笔刷模式不拦截'
                  + ('；' + '；'.join(notes) if notes else ''))
