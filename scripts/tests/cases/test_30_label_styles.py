#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 30：标签样式预设（P0-2 Aesthetic Labels）

验收点（对应提示词 P0-2 的「验收标准」逐条）：
1. 6 种预设可切换，视觉效果明显区分 —— 预设字段两两不同 + 预览画布像素签名随切换变化
2. 自定义样式实时预览 —— 改字号后预览画布立即重绘
3. 预设保存/加载正常，重启后保留 —— 落盘 .sitian/config（mock 记在 window.__uiConfig）
   且 localStorage 镜像在页面重载后仍生效
4. 三视图标签统一走样式系统 —— 行星地图上真实绘出了自定义颜色的标签（端到端像素证据）
5. 地图缩放时标签清晰可读 —— lockScreenSize 开关可写可读
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for  # noqa: E402
from lib.helpers import goto_planet, ensure_data_ready  # noqa: E402

PM = "document.querySelector('.planet-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
MAGENTA = '#FF00FF'


def _j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def _open_settings(cdp):
    return cdp.eval("""(() => {
      const b = Array.from(document.querySelectorAll('.toolbar-actions button'))
        .find(x => x.title === '设置');
      if (!b) return 'no-btn';
      b.click();
      return 'ok';
    })()""")


def _canvas_signature(cdp, selector):
    """采样画布唯一颜色数 + 一个粗指纹（用于判断重绘是否发生）"""
    return _j(cdp, f"""(() => {{
      const c = document.querySelector({json.dumps(selector)});
      if (!c) return JSON.stringify({{ err: 'no-canvas' }});
      const ctx = c.getContext('2d');
      const set = new Set();
      let hash = 0;
      for (let i = 0; i < 1200; i++) {{
        const x = Math.floor((i * 17) % c.width);
        const y = Math.floor((i * 43) % c.height);
        const d = ctx.getImageData(x, y, 1, 1).data;
        const key = (d[0] << 16) | (d[1] << 8) | d[2];
        set.add(key);
        hash = (hash * 31 + key) % 2147483647;
      }}
      return JSON.stringify({{ colors: set.size, hash }});
    }})()""")


def _magenta_pixels(cdp):
    """行星画布上"品红系"像素数（容差判定，抗抗锯齿）：自定义标签颜色的端到端证据"""
    return cdp.eval("""(() => {
      const c = document.querySelector('.planet-map-container .canvas-wrapper canvas');
      if (!c) return -1;
      const ctx = c.getContext('2d');
      const img = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      const step = 2;
      for (let y = 0; y < c.height; y += step) {
        for (let x = 0; x < c.width; x += step) {
          const i = (y * c.width + x) * 4;
          const r = img[i], g = img[i + 1], b = img[i + 2], a = img[i + 3];
          if (a > 180 && r > 200 && g < 90 && b > 200) n++;
        }
      }
      return n;
    })()""")


PRESETS_JS = """(async () => {
  const mod = await import('/src/utils/labelStyles.js');
  const out = {};
  for (const k of ['city','town','village','region','building','custom']) {
    const p = mod.getPreset(k);
    out[k] = {
      fontFamily: p.fontFamily, fontSize: p.fontSize, weight: p.weight, color: p.color,
      stroke: !!p.stroke.enabled, shadow: !!p.shadow.enabled, bg: !!p.background.enabled,
    };
  }
  return JSON.stringify(out);
})()"""


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    ensure_data_ready(cdp)

    # 从干净状态开始（避免上次运行残留的 localStorage 镜像干扰）
    cdp.eval("try { localStorage.removeItem('sitian-label-presets'); } catch (e) {}")
    cdp.eval("(async () => { const m = await import('/src/utils/labelStyles.js'); m.resetAllPresets(); })()")
    time.sleep(0.4)

    # ── 打开设置面板 → 标签样式页 ─────────────────────────────────────
    if _open_settings(cdp) != 'ok':
        return False, '找不到设置按钮'
    time.sleep(0.4)
    if not cdp.eval("!!document.querySelector('.settings-panel')"):
        return False, '设置面板未打开'
    if _j(cdp, """(() => {
      const t = document.querySelector('[data-testid="settings-tab-labels"]');
      if (!t) return 'no-tab';
      t.click();
      return 'ok';
    })()""") != 'ok':
        return False, '设置面板缺少「标签样式」分页'
    time.sleep(0.4)

    # 1. 6 种预设存在
    preset_btns = _j(cdp, """JSON.stringify(
      Array.from(document.querySelectorAll('[data-testid^="label-preset-"]'))
        .map(b => b.dataset.testid.replace('label-preset-', '')))""")
    if not isinstance(preset_btns, list) or len(preset_btns) < 6:
        return False, f'预设按钮不足 6 个：{preset_btns}'
    for need in ('city', 'town', 'village', 'region', 'building', 'custom'):
        if need not in preset_btns:
            return False, f'缺少预设 {need}（现有 {preset_btns}）'

    # 2. 6 种预设字段两两不同（视觉可区分的数据依据）
    presets = _j(cdp, PRESETS_JS)
    if not isinstance(presets, dict) or 'city' not in presets:
        return False, f'读不到预设定义 {presets}'
    sigs = {}
    for k, p in presets.items():
        sig = (p['fontFamily'], p['fontSize'], p['weight'], p['color'], p['stroke'], p['shadow'], p['bg'])
        if sig in sigs:
            return False, f'预设 {k} 与 {sigs[sig]} 完全同款（视觉无法区分）：{sig}'
        sigs[sig] = k

    # 3. 实时预览：切预设 / 改字号都要重绘
    sig_city = _canvas_signature(cdp, '[data-testid="label-preview"]')
    if sig_city.get('colors', 0) < 4:
        return False, f'预览画布几乎是纯色（{sig_city}）—— 预览未渲染'
    _j(cdp, "(() => { document.querySelector('[data-testid=\"label-preset-village\"]').click(); return 'ok'; })()")
    time.sleep(0.35)
    sig_village = _canvas_signature(cdp, '[data-testid="label-preview"]')
    if sig_village.get('hash') == sig_city.get('hash'):
        return False, f'切换到「村庄」预设后预览画布无变化（{sig_city} → {sig_village}）'

    # 改字号（滑块 @input 路径）→ 预览立即重绘
    _j(cdp, """(async () => {
      const mod = await import('/src/utils/labelStyles.js');
      mod.updatePreset('village', { fontSize: 26 }, { persist: false });
      return 'ok';
    })()""")
    time.sleep(0.35)
    sig_bigger = _canvas_signature(cdp, '[data-testid="label-preview"]')
    if sig_bigger.get('hash') == sig_village.get('hash'):
        return False, f'自定义修改后预览未实时刷新（{sig_village} → {sig_bigger}）'

    # 4. 落盘：写 .sitian/config（mock 记在 window.__uiConfig）+ localStorage 镜像
    _j(cdp, f"""(async () => {{
      const mod = await import('/src/utils/labelStyles.js');
      mod.resetAllPresets();
      mod.updatePreset('town', {{ color: '{MAGENTA}', fontSize: 20 }});
      return 'ok';
    }})()""")
    time.sleep(0.6)
    saved = _j(cdp, """JSON.stringify({
      vault: (window.__uiConfig || {}).labelPresets ? ((window.__uiConfig.labelPresets.town || {}).color || null) : null,
      mirror: (() => { try { return JSON.parse(localStorage.getItem('sitian-label-presets') || '{}').town?.color || null; } catch (e) { return null; } })(),
    })""")
    if saved.get('vault') != MAGENTA:
        return False, f'预设未落盘到 .sitian/config（__uiConfig.town.color = {saved.get("vault")}）—— setSitianConfig 未接线'
    if saved.get('mirror') != MAGENTA:
        return False, f'localStorage 镜像未写入（{saved.get("mirror")}）'

    # ── 关闭设置面板 ───────────────────────────────────────────────────
    cdp.eval("(() => { const b = document.querySelector('.settings-panel .close-btn'); if (b) b.click(); return 'ok'; })()")
    time.sleep(0.4)

    # 5. 重启保留：重载页面后 preset 仍是品红（localStorage 镜像 + 异步 IPC 双通道）
    cdp.navigate()
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='重载')
    ensure_data_ready(cdp)
    time.sleep(0.8)
    after_reload = _j(cdp, """(async () => {
      const mod = await import('/src/utils/labelStyles.js');
      return JSON.stringify({ color: mod.getPreset('town').color, size: mod.getPreset('town').fontSize });
    })()""")
    if not isinstance(after_reload, dict) or after_reload.get('color') != MAGENTA:
        return False, f'重载后预设未保留（{after_reload}）—— 持久化失效'

    # 6. 端到端：行星地图上真的用品红画出了城镇标签
    #    注意：标签有 LOD 闸门（s.lodRef > 0.4，需 zoom > 0.7），zoomFit 后 scale 往往很小 → 必须先聚焦放大
    r = goto_planet(cdp, '乐园星')
    if r != 'planet':
        return False, f'导航行星失败 ({r})'
    wait_for(cdp, "!!document.querySelector('.planet-map-container .canvas-wrapper canvas')", desc='行星画布挂载')
    time.sleep(1.0)
    town = _j(cdp, f"""(() => {{
      const s = {STORE};
      const pm = {PM};
      const planetId = pm.currentMapData ? pm.currentMapData.planetId : null;
      const list = (pm.places || s.nodes).filter(n => n.layer === 'town' && n.coordinate && n.coordinate.x !== null
        && (planetId === null || n.parentId === planetId));
      if (!list.length) return JSON.stringify({{ err: 'no-town' }});
      const n = list[0];
      pm.renderer.focusOn(n.coordinate.x, n.coordinate.y, 1.2);
      pm.renderer.requestRender();
      return JSON.stringify({{ name: n.name, x: n.coordinate.x, y: n.coordinate.y, total: list.length }});
    }})()""")
    if not isinstance(town, dict) or 'x' not in town:
        return False, f'该行星上没有城镇节点，无法验证标签渲染 {town}'
    time.sleep(1.4)
    magenta = _magenta_pixels(cdp)
    if not isinstance(magenta, int) or magenta <= 0:
        diag = _j(cdp, f"""(() => {{
          const pm = {PM};
          const names = (pm.places || []).map(p => ({{ n: p.name, l: p.layer, x: p.coordinate?.x, y: p.coordinate?.y }}));
          return JSON.stringify({{
            scale: pm.renderer.viewTransform.scale,
            lodRef: pm.lodRef,
            fast: pm.renderer.isFastMode(),
            named: names.filter(p => p.n).length,
            towns: names.filter(p => p.l === 'town'),
            view: pm.viewBounds,
          }});
        }})()""")
        scratch = _j(cdp, """(async () => {
          const mod = await import('/src/utils/labelStyles.js');
          const c = document.createElement('canvas');
          c.width = 300; c.height = 60;
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#1a2a3a';
          ctx.fillRect(0, 0, 300, 60);
          mod.drawStyledLabel(ctx, '丰竹镇', 150, 30, mod.getPreset('town'), { align: 'center', baseline: 'middle' });
          const d = ctx.getImageData(0, 0, 300, 60).data;
          let n = 0, sample = null;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i] > 200 && d[i + 1] < 90 && d[i + 2] > 200) { n++; if (!sample) sample = [d[i], d[i + 1], d[i + 2]]; }
          }
          return JSON.stringify({ color: mod.getPreset('town').color, scratchMagenta: n, sample });
        })()""")
        return False, (f'行星画布上找不到自定义颜色的标签像素（品红 {magenta}，'
                       f'聚焦城镇「{town["name"]}」@{town["x"]:.0f},{town["y"]:.0f} 后）——'
                       f'诊断={diag} 渲染器自检={scratch}')

    # 7. lockScreenSize 可写可读
    ls = _j(cdp, """(async () => {
      const mod = await import('/src/utils/labelStyles.js');
      mod.updatePreset('town', { lockScreenSize: true });
      const on = mod.getPreset('town').lockScreenSize === true;
      const fake = mod.effectiveFontSize(mod.getPreset('town'), 2);
      mod.updatePreset('town', { lockScreenSize: false });
      return JSON.stringify({ on, lockedSizeAt2x: fake, base: mod.getPreset('town').fontSize });
    })()""")
    if not ls.get('on'):
        return False, f'lockScreenSize 写入失败 {ls}'
    if abs(ls['lockedSizeAt2x'] - ls['base'] / 2) > 0.01:
        return False, f'锁定屏幕像素换算错误（2× 缩放应得 {ls["base"] / 2}，实际 {ls["lockedSizeAt2x"]}）'

    # 收尾：清干净，避免污染后续用例
    cdp.eval("(async () => { const m = await import('/src/utils/labelStyles.js'); m.resetAllPresets(); })()")
    time.sleep(0.3)

    return True, (
        f'标签样式预设通过：6 种预设字段两两不同（{len(sigs)} 个唯一签名）；'
        f'预览画布颜色 {sig_city["colors"]} 种且切预设/改字号都实时重绘；'
        f'自定义样式写入 .sitian/config + localStorage 镜像，重载后保留（town={after_reload["color"]}）；'
        f'行星画布检出 {magenta} 个自定义颜色标签像素（端到端）；lockScreenSize 换算正确'
    )
