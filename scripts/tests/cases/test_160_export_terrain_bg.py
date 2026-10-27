#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 160：导出地形底图（分带设色 + 海深 + 等深线 / 海岸线）—— 「导出 = 你看到的那张图」

背景（2026-10-27）：
  画布早就有地形底图（`rasterLayer=height`：高度分带设色 + 海深渐变 + 山体阴影 +
  等深线 + 海岸线），但 **SVG/PNG 导出一直是政治色块** —— 用户把这张图当"成品地形图"
  导出去看，得到的却是另一张图。这一类不一致在本项目反复吃到教训：不报错，只是少了东西。

口径：
  · 触发条件 = 画布的「地形表示」选的是 height / temp / prec（这三档画布上**省份只描边**）；
  · 底图是栅格 → SVG 里内联 `<image>`（与行星侧导出、参考底图同一手法）；
    等深线 / 海岸线是几何 → 画成矢量 `<path>`（比位图清晰，换分辨率不糊）；
  · 底图模式下**不填省色**（与画布 `drawProvinces({fills:false})` 同一条）；
  · `landsea` / `none` / `landsea` 等政治档 → 导出保持原样（政治图），不受影响。

判据：
  1. `height` 档：SVG 里有内联 PNG（能解码、颜色数 ≥5）且**水域有 ≥2 种蓝**（海深分带）、
     陆地有 ≥2 种色（高度分带）；
  2. 有海岸线 `<path>`（stroke `rgba(44, 92, 122, 0.45)`）；
  3. 没有省份填色（`fill-opacity="0.72"` 不出现）—— 省界仍在；
  4. 反向对照：切回 `landsea`（政治档）→ 没有内联 PNG、省份填色回来了；
  5. 地形注记仍随导出（与 158 一致）：`terrainLabels` 的字还在。
"""
import base64
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for                                  # noqa: E402
from lib.helpers import ensure_data_ready                               # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
KEY = '用例160底图'


def _decode_embedded_png(svg):
    """把 SVG 里第一个内联 PNG 解出来 → (PIL.Image, byte_len)。没有就 (None, 0)。"""
    m = re.search(r'href="data:image/png;base64,([A-Za-z0-9+/=]+)"', svg)
    if not m:
        return None, 0
    raw = base64.b64decode(m.group(1))
    try:
        from PIL import Image
    except Exception:
        return None, len(raw)
    try:
        return Image.open(io.BytesIO(raw)).convert('RGB'), len(raw)
    except Exception:
        return None, len(raw)


def _hsv_buckets(img):
    """水域蓝 / 陆地绿(含黄棕) 去重色数（按 16 级量化，避免抗锯齿把每种颜色都算成新色）。"""
    water, land = set(), set()
    w, h = img.size
    px = img.load()
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            r, g, b = px[x, y]
            q = (r >> 4, g >> 4, b >> 4)
            if b > r + 8 and b >= g:
                water.add(q)
            elif g >= b:
                land.add(q)
    return len(water), len(land)


def run(cdp):
    wait_for(cdp, "!!document.querySelector('#app')", desc='应用挂载', timeout=15)
    ensure_data_ready(cdp)
    r = cdp.eval("""(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('历史剧本'));
      if (!btn) return 'no-btn'; btn.click(); return 'ok';
    })()""")
    if r != 'ok':
        return False, f'进入历史剧本失败：{r}'
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", desc='ScenarioMap 挂载', timeout=8)

    seed = r"""(async () => {
      const s = __STORE__, SM = __SM__, KEY = __KEY__;
      const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
      if (s.baseMaps[KEY]) s.removeBaseMap(KEY);
      s.addBaseMap(KEY, { name: KEY });
      s.addBaseProvince(KEY, { id: 'p160', name: '省160', kind: 'land',
        points: [{x:80,y:80},{x:400,y:80},{x:400,y:400},{x:80,y:400}] }, { checkOverlap: false });
      // 高度图：中间一块高地（分带设色要出多档），四周是海（海深要有分带 + 海岸线）
      const cols = 40, rows = 40, spacing = 10;
      const h = [], points = [];
      for (let r2 = 0; r2 < rows; r2++) {
        for (let c = 0; c < cols; c++) {
          points.push([c * spacing, r2 * spacing]);
          const land = c >= 10 && c <= 30 && r2 >= 10 && r2 <= 30;
          if (!land) { h.push(12); continue; }
          const d2 = (c - 20) * (c - 20) + (r2 - 20) * (r2 - 20);
          h.push(Math.round((45 + 25 * Math.exp(-d2 / 60)) * 100) / 100);
        }
      }
      s.baseMaps[KEY].heightmap = { h: new Float32Array(h), grid: { cellsX: cols, cellsY: rows, spacing, points } };
      s.createScenario(KEY + '/甲', {
        ownerKey: KEY, name: '甲', order: 1, group: 'default',
        era: { roman: 'Ⅰ', label: '甲', startYear: '2000', endYear: '2010' },
        polities: [{ id: 'P1', name: '甲国', color: '#c23b3b' }],
        ownership: { p160: 'P1' },
      });
      SM.baseMapKey = KEY;
      if (typeof SM.onBaseMapChange === 'function') await SM.onBaseMapChange();
      SM.tlEra = 0; SM.tlDate = { y: 2000, m: null, d: null };
      SM.showPlaceNames = false;      // 只留地形 + 省界 + 地形注记，便于数颜色
      SM.rasterLayer = 'height';      // ★ 地形底图档（导出应带上它）
      await tick(120);
      const res = s.applyTerrainLabels(KEY, [{
        id: 'tl160', kind: 'range', name: '测试山脉',
        points: [{x:150,y:200},{x:250,y:180},{x:350,y:200}], origin: 'user',
      }]);
      await tick(200);
      return JSON.stringify({ ok: !!(res && res.ok), hm: h.length });
    })()"""
    ok, seeded = eval_json(cdp, seed.replace('__STORE__', STORE).replace('__SM__', SM)
                           .replace('__KEY__', json.dumps(KEY)), required=('hm',), desc='造地形底图（山 + 海 + 海岸）')
    if not ok or int(seeded.get('hm') or 0) != 1600:
        return False, f'造数失败：{seeded}'

    build = r"""(async () => {
      const SM = __SM__;
      const fn = SM.buildScenarioSVG || (SM.scenarioExport && SM.scenarioExport.buildScenarioSVG);
      if (!fn) return JSON.stringify({ __err__: '没有 buildScenarioSVG' });
      SM.rasterLayer = 'height';
      const terrain = String(fn({ era: 0, date: { y: 2000, m: null, d: null } }).svg || '');
      SM.rasterLayer = 'landsea';
      const plain = String(fn({ era: 0, date: { y: 2000, m: null, d: null } }).svg || '');
      SM.rasterLayer = 'height';
      const count = (svg, s) => (svg.split(s).length - 1);
      return JSON.stringify({
        terrainLen: terrain.length, plainLen: plain.length,
        terrainImgs: count(terrain, '<image'),
        plainImgs: count(plain, '<image'),
        terrainFills: count(terrain, 'fill-opacity="0.72"'),
        plainFills: count(plain, 'fill-opacity="0.72"'),
        terrainCoast: count(terrain, 'rgba(44, 92, 122, 0.45)'),
        plainCoast: count(plain, 'rgba(44, 92, 122, 0.45)'),
        terrainMountain: terrain.indexOf('>测试山脉<') >= 0 || count(terrain, '>山<') > 0,
        terrainBorder: count(terrain, 'stroke="#') > 0,
        svg: terrain,
      });
    })()"""
    ok, out = eval_json(cdp, build.replace('__STORE__', STORE).replace('__SM__', SM)
                        .replace('__KEY__', json.dumps(KEY)),
                        required=('terrainLen', 'svg'), desc='导出（地形档 / 政治档各一次）')
    if not ok:
        return False, f'导出失败：{out}'

    svg = out.get('svg') or ''
    img, bytes_len = _decode_embedded_png(svg)
    fails = []

    # ① 地形档：内联 PNG 存在且是"有内容的彩色图"（分带设色 + 海深）
    if int(out.get('terrainImgs') or 0) < 1:
        fails.append(f"地形档导出没有内联 PNG（imgs={out.get('terrainImgs')}）")
    water_colors = land_colors = 0
    if img is None:
        fails.append(f"内联 PNG 解不出来（bytes={bytes_len}）")
    else:
        water_colors, land_colors = _hsv_buckets(img)
        if bytes_len < 1000:
            fails.append(f'内联 PNG 太小（{bytes_len}B）—— 可能是一张空图')
        if water_colors < 2:
            fails.append(f'海面只有 {water_colors} 种蓝（海深没有分带）')
        if land_colors < 2:
            fails.append(f'陆地只有 {land_colors} 种色（高度没有分带设色）')

    # ② 海岸线是几何（矢量 path），不是位图的一部分
    if int(out.get('terrainCoast') or 0) < 1:
        fails.append('地形档导出没有海岸线 path（stroke rgba(44, 92, 122, 0.45)）')

    # ③ 地形档不填省色（与画布 fills:false 同一条）；省界仍在
    if int(out.get('terrainFills') or 0) != 0:
        fails.append(f"地形档导出仍填了省色（fill-opacity 0.72 出现 {out.get('terrainFills')} 次）")
    if not out.get('terrainBorder'):
        fails.append('地形档导出连省界都没了')

    # ④ 地形注记仍在
    if not out.get('terrainMountain'):
        fails.append('地形档导出丢了地形注记（山系名）')

    # ⑤ 反向对照：政治档（landsea）没有内联底图、省色回来了
    if int(out.get('plainImgs') or 0) != 0:
        fails.append(f"政治档导出不该有内联地形图（imgs={out.get('plainImgs')}）")
    if int(out.get('plainFills') or 0) < 1:
        fails.append('政治档导出应恢复省份填色（fill-opacity 0.72 没出现）')
    if int(out.get('plainCoast') or 0) != 0:
        fails.append('政治档导出不该有海岸线 path')

    if fails:
        return False, '；'.join(fails)[:900] + ' | 实测：' + json.dumps(
            {k: v for k, v in out.items() if k != 'svg'}, ensure_ascii=False)[:600]

    # 可选：把地形档导出件落盘（浏览器直接打开就能人眼核对观感）
    shot_dir = os.environ.get('SITIAN_SHOT_DIR')
    if shot_dir:
        import pathlib
        try:
            out_dir = pathlib.Path(shot_dir)
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / 'terrain-map-export.svg').write_text(svg, encoding='utf-8')
        except Exception:
            pass

    return True, (f"地形档：内联 PNG {bytes_len}B（水域 {water_colors} 种蓝 / 陆地 {land_colors} 种色）"
                  f" + 海岸线 {out.get('terrainCoast')} 处 + 省界在、省色不填 + 地形注记在；"
                  f"政治档：无内联图、省色 {out.get('plainFills')} 处恢复")
