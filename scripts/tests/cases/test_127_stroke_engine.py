"""用例 127：笔迹引擎（perfect-freehand 封装）—— T7 / H1b。

不是“手感截图”，而是四条硬判据：
  · 120 点输入 → 轮廓多边形（>60 点）且没有 NaN；
  · 中心线稳定器输出点数与输入同量级（不把笔迹压没）；
  · 单次 getStroke p95 < 10ms（预览每帧要算一次；真实底图 spike 实测 0.2ms）；
  · 同一轨迹“快/慢”两种采样间距 → 宽度必须能拉开（否则“随速度变宽”是假的）。
"""
import json
import os

from lib.cdp import eval_json, wait_for

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))


def source_gates():
    fails = []
    sm = open(os.path.join(ROOT, 'src', 'renderer', 'src', 'components', 'ScenarioMap.vue'), encoding='utf-8').read()
    if 'river.widthFactors' not in sm or 'widthFactors' not in sm:
        fails.append('T7 收尾：手画河没接 widthFactors（速度→宽度）')
    if 'provBrushWorldRadius' not in sm:
        fails.append('H2：省份笔刷半径没有按屏幕像素换算世界单位')
    if '半径（屏幕像素）' not in sm:
        fails.append('H2：半径 UI 仍标世界单位')
    return fails

JS = r"""
(async () => {
  const fails = [];
  const E = await import('/src/utils/strokeEngine.js');
  const pts = [];
  for (let i = 0; i < 120; i++) {
    const t = i / 119;
    pts.push({ x: 100 + t * 620, y: 150 + Math.sin(t * Math.PI * 2.2) * 70 });
  }
  for (let i = 0; i < 5; i++) E.strokeOutline(pts, { size: 12 });
  const times = [];
  let outline = null;
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    outline = E.strokeOutline(pts, { size: 12, thinning: 0.55, streamline: 0.45, smoothing: 0.5 });
    times.push(performance.now() - t0);
  }
  const sorted = times.slice().sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const smooth = E.smoothStrokePoints(pts, { size: 12, streamline: 0.45 });
  const bad = (outline || []).filter(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y)).length;

  const slow = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }, { x: 6, y: 0 }, { x: 8, y: 0 }];
  const fast = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 40, y: 0 }, { x: 60, y: 0 }, { x: 80, y: 0 }];
  const wSlow = E.widthsBySpeed(slow, { base: 10 });
  const wFast = E.widthsBySpeed(fast, { base: 10 });
  if (!(outline && outline.length > 60)) fails.push(`轮廓点数不足：${outline ? outline.length : 'null'}`);
  if (bad) fails.push(`轮廓含 NaN：${bad}`);
  if (!(smooth && smooth.length >= 60)) fails.push(`稳定器点数不足：${smooth ? smooth.length : 'null'}`);
  if (!(p95 < 10)) fails.push(`getStroke p95 ${p95.toFixed(2)}ms ≥ 10ms`);
  if (!(wFast[0] > wSlow[0])) fails.push(`快/慢宽度没拉开：${wSlow[0]} vs ${wFast[0]}`);
  return JSON.stringify({
    fails,
    outline: outline ? outline.length : 0,
    smooth: smooth ? smooth.length : 0,
    p95: +p95.toFixed(2),
    wSlow: wSlow[0], wFast: wFast[0],
  });
})()
"""


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    ok, obj = eval_json(cdp, JS, required=('fails',), desc='stroke engine')
    if not ok:
        return False, str(obj)[:400]
    fails = source_gates() + (obj.get('fails') or [])
    if fails:
        return False, ' | '.join(fails)
    return True, (f"轮廓 {obj.get('outline')} 点 / 稳定 {obj.get('smooth')} 点 / "
                  f"p95 {obj.get('p95')}ms / 宽度 {obj.get('wSlow')}→{obj.get('wFast')}")
