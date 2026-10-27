#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 159：文字层随缩放分层 + 字号自适应（Paradox 式）

背景（2026-10-27，用户点名）：
  「放大清晰显示省份名，缩小只看见势力名称」——这是 EU4/Paradox 的成熟做法。
  我们此前三件事各走各的：
    · 势力名/省名按**可见比例**分档（正确）；
    · 城镇名/河名却按**绝对 cameraScale** 分档 —— 绝对 scale 依赖数据量纲
      （FMG 导入 ≈1.0、合成图 ≈0.2），换一份数据阈值就整体失准；
    · 字号恒定屏幕像素 —— 放大到 6× 时字相对地图越来越小。
  现在统一由 `utils/labelZoom.js` 判定：`ratio = 可见世界宽 / 地图世界宽` →
  close / near / mid / far 四档（**12% 滞回**，滚轮停在阈值上不抖），并给出字号系数。

判据（读真实排布结论 + 真实像素）：
  1. far（ratio≈3）：只剩势力名 —— 没有省名/城镇名/河名；地形注记也不画（开关前后 0 像素差）；
  2. mid（ratio≈1）：整图可见 —— 势力名 + 地形注记，仍没有城镇/河名；
  3. near（ratio≈0.5）：出首都名与河名；
  4. close（ratio≈0.25）：出省名 + 全部城镇名；
  5. 字号系数随放大变大：close 档的同一个标签 style.fontSize > far 档；且 far 档不小于 0.95 倍；
  6. 滞回：从 mid 缩到 ratio≈0.62 不换档（仍 mid），到 ≈0.5 才换 near。
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for                                  # noqa: E402
from lib.helpers import ensure_data_ready                               # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
KEY = '用例159底图'
MAP_W = 580.0          # 省份 40..620（见 seed）→ 地图世界宽


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
      s.addBaseProvince(KEY, { id: 'p159', name: '省159', kind: 'land',
        points: [{x:40,y:40},{x:620,y:40},{x:620,y:560},{x:40,y:560}] }, { checkOverlap: false });
      const bm = s.baseMaps[KEY];
      bm.burgs = [
        { id: 1, name: '首都甲', x: 270, y: 318, capital: 1, group: 'capital', population: 90 },
        { id: 2, name: '大城乙', x: 392, y: 318, capital: 0, population: 80 },
      ];
      // 河道与山系都放在「省形心」附近：close 档视口只有 ~145×54 世界单位，
      // 放远了会被视口裁剪掉，handler 里就查不到它（第一版就栽在这）。
      bm.rivers = [{ id: 'r159', name: '测试河', points: [{x:250,y:300},{x:330,y:296},{x:410,y:300}],
                     discharge: 900, width: 2 }];
      s.createScenario(KEY + '/甲', {
        ownerKey: KEY, name: '甲', order: 1, group: 'default',
        era: { roman: 'Ⅰ', label: '甲', startYear: '2000', endYear: '2010' },
        polities: [{ id: 'P1', name: '甲国', color: '#c23b3b' }],
        ownership: { p159: 'P1' },
      });
      SM.baseMapKey = KEY;
      if (typeof SM.onBaseMapChange === 'function') await SM.onBaseMapChange();
      SM.tlEra = 0; SM.tlDate = { y: 2000, m: null, d: null };
      SM.showPolityLabels = true;
      SM.showPlaceNames = true;
      SM.showBurgs = true;
      SM.showRivers = true;
      SM.showTerrainNames = true;
      await tick(80);
      const res = s.applyTerrainLabels(KEY, [{
        id: 'tl159', kind: 'range', name: '测试山脉',
        points: [{x:255,y:262},{x:330,y:268},{x:405,y:262}], origin: 'user',
      }]);
      await tick(150);
      return JSON.stringify({ ok: !!(res && res.ok), w: 580, cw: SM.cw(), ch: SM.ch() });
    })()"""
    ok, seeded = eval_json(cdp, seed.replace('__STORE__', STORE).replace('__SM__', SM)
                           .replace('__KEY__', json.dumps(KEY)), required=('w',), desc='造图（省/城镇/河/地形注记）')
    if not ok or not seeded.get('ok'):
        return False, f'造数失败：{seeded}'

    probe = r"""(async () => {
      const SM = __SM__, s = __STORE__, KEY = __KEY__, MAPW = __MAPW__;
      const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
      const cv = () => document.querySelector('.scenario-map-container canvas');
      const grab = async () => {
        if (SM.render) SM.render();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        await tick(60);
        const el = cv();
        return el ? el.getContext('2d').getImageData(0, 0, el.width, el.height) : null;
      };
      const diffPx = (a, b) => {
        if (!a || !b) return -1;
        let n = 0;
        for (let i = 0; i < a.data.length; i += 4) {
          const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1])
            + Math.abs(a.data[i + 2] - b.data[i + 2]);
          if (d > 20) n++;
        }
        return n;
      };
      // 用「可见比例」反推相机：ratio = (cw / scale) / MAPW
      const setRatio = async (ratio) => {
        const W = SM.cw(), H = SM.ch();
        SM.cameraScale = W / (ratio * MAPW);
        SM.cameraX = W / 2 - 330 * SM.cameraScale;
        SM.cameraY = H / 2 - 300 * SM.cameraScale;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        await tick(60);
      };
      const snapshot = async (ratio) => {
        await setRatio(ratio);
        const plan = SM.getLabelPlan() || [];
        const kinds = plan.map((p) => p.kind);
        const sizeOf = (k) => {
          const hit = plan.find((p) => p.kind === k);
          return hit && hit.style ? Number(hit.style.fontSize) : null;
        };
        // 地形注记是否真的画出来：只切 `showTerrainNames`，差集里只可能是它
        SM.showTerrainNames = true;
        const on = await grab();
        SM.showTerrainNames = false;
        const off = await grab();
        SM.showTerrainNames = true;
        if (SM.render) SM.render();
        // 应用自己的判定（含滞回状态）——不是测试另算一遍
        const detail = SM.labelDetailNow ? SM.labelDetailNow() : null;
        const lm = await import('/src/utils/labelZoom.js');
        return {
          ratio, scale: SM.cameraScale, kinds,
          appRatio: SM.mapVisibleRatio ? SM.mapVisibleRatio() : null,
          detail, caps: lm.detailCaps(detail), fontScale: SM.labelScaleNow ? SM.labelScaleNow() : null,
          nProvince: kinds.filter((k) => k === 'province').length,
          nPolity: kinds.filter((k) => k === 'polity').length,
          nCapital: kinds.filter((k) => k === 'capital').length,
          nTown: kinds.filter((k) => k === 'town').length,
          nRiver: kinds.filter((k) => k === 'river').length,
          sizePolity: sizeOf('polity'), sizeProvince: sizeOf('province'),
          terrainPx: diffPx(on, off),
        };
      };

      const far = await snapshot(3.0);
      const mid = await snapshot(1.0);
      const near = await snapshot(0.5);
      // ── 滞回（12% 死区）：必须从 near 档**内部**往边界走，才测得到"不换档" ──
      // 0.62 已越过 0.6 的裸阈值，但没到 0.6×1.12=0.672 → 应保持 near（河名不消失）
      const nearKeep = await snapshot(0.62);
      // 0.68 越过 0.672 → 才换 mid
      const toMid = await snapshot(0.68);
      // 反向：0.58 还没到 0.6×0.88=0.528 → 保持 mid；0.5 才回 near
      const midKeep = await snapshot(0.58);
      const backNear = await snapshot(0.5);
      const close = await snapshot(0.25);
      return JSON.stringify({ far, mid, near, close, nearKeep, toMid, midKeep, backNear });
    })()"""
    ok, out = eval_json(cdp, probe.replace('__SM__', SM).replace('__STORE__', STORE)
                        .replace('__KEY__', json.dumps(KEY)).replace('__MAPW__', str(MAP_W)),
                        required=('far',), desc='四个档位 + 滞回')
    if not ok:
        return False, f'档位探测失败：{out}'

    far, mid, near, close = out['far'], out['mid'], out['near'], out['close']
    fails = []

    # ① far：只剩势力名
    if far.get('detail') != 'far':
        fails.append(f"ratio 3.0 应为 far 档（实测 {far.get('detail')}，appRatio={far.get('appRatio')}）")
    if int(far.get('nPolity') or 0) < 1:
        fails.append(f"far 档应有势力名：{far.get('kinds')}")
    for k, name in (('nProvince', '省名'), ('nCapital', '首都名'), ('nTown', '城镇名'), ('nRiver', '河名')):
        if int(far.get(k) or 0) != 0:
            fails.append(f"far 档（缩小）不该有{name}：{far.get('kinds')}")
    if int(far.get('terrainPx') or 0) != 0:
        fails.append(f"far 档不该画地形注记（开关前后差 {far.get('terrainPx')} 像素）")

    # ② mid：势力名 + 地形注记，仍无城镇/河名
    if mid.get('detail') != 'mid':
        fails.append(f"ratio 1.0 应为 mid 档（实测 {mid.get('detail')}，appRatio={mid.get('appRatio')}）")
    if int(mid.get('nPolity') or 0) < 1:
        fails.append(f"mid 档应有势力名：{mid.get('kinds')}")
    if int(mid.get('nRiver') or 0) != 0:
        fails.append(f"mid 档（整图可见）不该标河名：{mid.get('kinds')}")
    if int(mid.get('terrainPx') or 0) < 20:
        fails.append(f"mid 档应画地形注记（差 {mid.get('terrainPx')} 像素）")

    # ③ near：出首都名 + 河名
    if near.get('detail') != 'near':
        fails.append(f"ratio 0.5 应为 near 档（实测 {near.get('detail')}，appRatio={near.get('appRatio')}）")
    if int(near.get('nCapital') or 0) < 1:
        fails.append(f"near 档应出首都名：{near.get('kinds')}")
    if int(near.get('nRiver') or 0) < 1:
        fails.append(f"near 档应出河名：{near.get('kinds')}")
    if int(near.get('nProvince') or 0) != 0:
        fails.append(f"near 档还不该出省名（那是 close 档）：{near.get('kinds')}")

    # ④ close：出省名 + 全部城镇名
    if close.get('detail') != 'close':
        fails.append(f"ratio 0.25 应为 close 档（实测 {close.get('detail')}，appRatio={close.get('appRatio')}）")
    if int(close.get('nProvince') or 0) < 1:
        fails.append(f"close 档应出省名：{close.get('kinds')}")
    if int(close.get('nTown') or 0) < 1:
        fails.append(f"close 档应出全部城镇名：{close.get('kinds')}")

    # ⑤ 字号系数：应用自己的系数随放大变大（比例走 magnitude），且排布里的字号真的跟着变
    k_far = float(far.get('fontScale') or 0)
    k_close = float(close.get('fontScale') or 0)
    if not k_far or not k_close:
        fails.append(f"拿不到字号系数：far={k_far} close={k_close}")
    else:
        if not (k_close > k_far + 1e-6):
            fails.append(f'放大后字号系数应变大：far={k_far} close={k_close}')
        if k_far < 0.95 - 1e-6:
            fails.append(f'缩小档系数不该低于 0.95：{k_far}')
        # 排布里的字号 = 常量 × 系数：用 far 档的势力名反推基准，再看 near 档是否同比例
        sp_far, sp_near = far.get('sizePolity') or 0, near.get('sizePolity') or 0
        if sp_far and sp_near:
            base = sp_far / k_far
            want = base * float(near.get('fontScale') or 0)
            if abs(sp_near - want) > 0.06:
                fails.append(f'排布字号没跟上系数：near 实测 {sp_near}，应为 {want:.2f}（基准 {base:.2f}）')

    # ⑥ 滞回：near 档内走到 0.62 不换档；0.68 才换 mid；再从 mid 0.58 保持、0.5 才回 near
    #    ⚠️ 判据看**档位 + 该档的容量**，不拿"某条河名还在不在"当滞回代理：
    #    河名是最低优先级，字号变大后它会被避让排布挤掉（那是排布正确行为，不是掉档）。
    if out['nearKeep'].get('detail') != 'near' or int((out['nearKeep'].get('caps') or {}).get('rivers', -1)) < 0:
        fails.append(f"滞回失效：near 档内 ratio 0.62 就掉档了（应保持 near，河名档仍开放）："
                     f"detail={out['nearKeep'].get('detail')} caps={out['nearKeep'].get('caps')} kinds={out['nearKeep'].get('kinds')}")
    if out['toMid'].get('detail') != 'mid':
        fails.append(f"ratio 0.68 应换 mid：{out['toMid'].get('detail')}")
    if out['midKeep'].get('detail') != 'mid':
        fails.append(f"滞回失效：mid 档内 ratio 0.58 就换档了：{out['midKeep'].get('detail')}")
    if out['backNear'].get('detail') != 'near':
        fails.append(f"ratio 0.5 应回到 near：{out['backNear'].get('detail')}")

    if fails:
        return False, '；'.join(fails)[:900] + ' | 实测：' + json.dumps(
            {k: {kk: out[k].get(kk) for kk in ('ratio', 'detail', 'kinds', 'terrainPx', 'fontScale')}
             for k in ('far', 'mid', 'near', 'close', 'nearKeep', 'toMid', 'midKeep', 'backNear')},
            ensure_ascii=False)[:800]

    # 可选：四个档位各存一张画布（人眼直接看"缩小只剩势力名 / 放大出省名+城镇名"）
    shot_dir = os.environ.get('SITIAN_SHOT_DIR')
    if shot_dir:
        import base64
        import pathlib
        import time as _t
        from lib.cdp import fetch_string
        for name, ratio in (('far', 3.0), ('mid', 1.0), ('near', 0.5), ('close', 0.25)):
            try:
                cdp.eval(r"""(() => {
                  const SM = %s, W = SM.cw(), H = SM.ch(), R = %s;
                  SM.cameraScale = W / (R * 580);
                  SM.cameraX = W / 2 - 330 * SM.cameraScale;
                  SM.cameraY = H / 2 - 300 * SM.cameraScale;
                  SM.showTerrainNames = true;
                  SM.render();
                  return 'ok';
                })()""" % (SM, ratio))
                _t.sleep(0.4)
                cdp.eval("(() => { const cv = document.querySelector('.scenario-map-container canvas');"
                         " window.__SHOT__ = cv ? cv.toDataURL('image/png') : ''; return 'ok'; })()")
                data_url = fetch_string(
                    cdp,
                    "window.__SHOT__ ? window.__SHOT__.length : -1",
                    lambda i, j: "window.__SHOT__.slice(%d,%d)" % (i, j),
                    chunk=262144, desc='缩放档位画布')
                if isinstance(data_url, str) and data_url.startswith('data:image'):
                    out_dir = pathlib.Path(shot_dir)
                    out_dir.mkdir(parents=True, exist_ok=True)
                    (out_dir / f'zoom-{name}.png').write_bytes(
                        base64.b64decode(data_url.split(',', 1)[-1]))
            except Exception:
                pass

    return True, (f"far(3.0)={far.get('kinds')}（仅势力名，地形注记 0 px）→ mid(1.0) 地形注记 "
                  f"{mid.get('terrainPx')} px → near(0.5) 出河名 → close(0.25) 出省名+城镇名；"
                  f"字号系数 {k_far:.2f} → {k_close:.2f}；"
                  f"滞回：near 内 0.62 不掉档、0.68 才 mid；mid 内 0.58 不换档、0.5 才 near")
