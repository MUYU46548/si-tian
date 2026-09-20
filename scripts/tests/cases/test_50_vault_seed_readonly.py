#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 50：决策 1 终态的可用性收尾（Phase 2.5）

终态「无项目 = 只读」翻开后暴露的三个缺口，本用例逐条守：

  a) 只读徽标在**世界/选择视图**也可见（状态栏只在画布视图出现，那里原本没有任何提示），
     title 带能力说明，且点击能到达去处（项目面板）——不是死标。
  b) 「新建并导入知识库内容」：终态下把既有内容带进项目的唯一路径。
     实体树 / 航道 / 地图一并导入，且画布立即切到该项目。
  c) 导入是**一条 undo**（误点可撤销），redo 可恢复。
  d) 项目模式下 `loadMapData` **不回退知识库缓存**（两套事实源的最后一条缝隙）：
     项目里没有的行星图，进视图就是空的，绝不偷偷从知识库读进来（那会被下一次保存写进项目）。
  e) 关闭项目后：徽标回来（重新只读）、知识库读取链路照旧可用（行星图还能看）。
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for  # noqa: E402
from lib.helpers import ensure_data_ready, goto_planet  # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
PINIA = "document.querySelector('#app').__vue_app__.config.globalProperties.$pinia"
PANEL = ".project-panel"


def _j(cdp, expr, tag=''):
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    ensure_data_ready(cdp)

    # harness 已打开基线项目 → 本用例从「无项目（只读）」起步
    closed = _j(cdp, f"""(async () => {{
      const M = await import('/src/store/projectStore.js');
      const W = await import('/src/store/writeGate.js');
      const p = M.useProjectStore({PINIA});
      if (p.isOpen) p.closeProject();
      await new Promise(r => setTimeout(r, 400));
      const s = {STORE};
      return JSON.stringify({{ open: p.isOpen, mode: W.writeMode.value, src: s.canvasSource,
        nodes: s.nodes.length, viewLevel: s.viewLevel }});
    }})()""", 'close-harness')
    if not isinstance(closed, dict) or closed.get('src') != 'vault' or closed.get('nodes', 0) <= 0:
        return False, f'前置失败：关闭基线项目后画布未回到知识库态 {closed}'

    # ── a) 只读徽标（世界视图） ────────────────────────────────────────
    badge = _j(cdp, """(() => {
      const b = document.querySelector('.toolbar-actions .readonly-badge');
      return JSON.stringify({
        exists: !!b,
        text: b ? b.textContent.trim() : null,
        title: b ? b.getAttribute('title') : null,
        statusBarVisible: !!document.querySelector('.status-bar'),
        viewLevel: document.querySelector('#app').__vue_app__._instance.setupState.store.viewLevel,
      });
    })()""", 'badge')
    if not badge.get('exists'):
        return False, f'世界视图没有只读徽标（状态栏此时不可见 = 用户没有任何只读提示）：{badge}'
    if '只读' not in (badge.get('text') or ''):
        return False, f'徽标文案没写清只读：{badge}'
    if '打开项目后即可继续编辑' not in (badge.get('title') or ''):
        return False, f'徽标 title 缺少能力说明：{badge}'
    if badge.get('statusBarVisible'):
        return False, f'前置假设不成立：世界视图本不该有状态栏（此时有，说明用例前提变了）{badge}'
    # 点击去项目面板（去处可达）
    cdp.eval("document.querySelector('.toolbar-actions .readonly-badge').click()")
    time.sleep(1.0)
    if not cdp.eval(f"!!document.querySelector('{PANEL}')"):
        return False, '点只读徽标没有打开项目面板（去处不可达 = 死标）'

    # ── b) 新建并导入知识库内容 ────────────────────────────────────────
    seed_ui = _j(cdp, f"""(() => {{
      const q = (s) => document.querySelector(s);
      const btns = Array.from(document.querySelectorAll('{PANEL} button'));
      const seedBtn = btns.find(b => (b.textContent || '').indexOf('新建并导入知识库内容') >= 0);
      const hint = q('{PANEL} .pp-seed');
      return JSON.stringify({{
        hasBtn: !!seedBtn,
        btnDisabled: seedBtn ? seedBtn.disabled : null,
        hint: hint ? hint.textContent.trim() : null,
        vaultNodes: {STORE}.nodes.length,
      }});
    }})()""", 'seed-ui')
    if not seed_ui.get('hasBtn'):
        return False, '面板缺少「新建并导入知识库内容」入口（终态下无法把知识库内容带进项目）'
    if not seed_ui.get('btnDisabled'):
        return False, f'名称为空时导入口应禁用（避免建出无名项目）：{seed_ui}'
    if str(seed_ui.get('vaultNodes')) not in (seed_ui.get('hint') or ''):
        return False, f'导入口说明必须写清会导入多少内容（能力说明）：{seed_ui}'

    # 填名称 → 点导入口
    cdp.eval(f"""(() => {{
      const inp = document.querySelector('{PANEL} .pp-input');
      inp.value = '导入测试项目';
      inp.dispatchEvent(new Event('input', {{ bubbles: true }}));
      return 'ok';
    }})()""")
    time.sleep(0.2)
    cdp.eval(f"""(() => {{
      const b = Array.from(document.querySelectorAll('{PANEL} button'))
        .find(x => (x.textContent || '').indexOf('新建并导入知识库内容') >= 0);
      b.click();
      return 'ok';
    }})()""")
    time.sleep(2.0)

    seeded = _j(cdp, f"""(async () => {{
      const M = await import('/src/store/projectStore.js');
      const W = await import('/src/store/writeGate.js');
      const p = M.useProjectStore({PINIA});
      const s = {STORE};
      const md = (p.project && p.project.maps && p.project.maps.mapData) || {{}};
      return JSON.stringify({{
        open: p.isOpen, name: p.meta ? p.meta.name : null,
        entities: Object.keys(p.entities || {{}}).length,
        hyperlanes: ((p.project || {{}}).hyperlanes || []).length,
        maps: Object.keys(md).length,
        nodes: s.nodes.length,
        canvasSrc: s.canvasSource,
        mode: W.writeMode.value,
        storeHyperlanes: s.hyperlanes.length,
        tip: (document.querySelector('{PANEL} .pp-tip') || {{}}).textContent || '',
      }});
    }})()""", 'seeded')
    if not seeded.get('open') or seeded.get('canvasSrc') != 'project':
        return False, f'导入口没有建出并打开项目：{seeded}'
    if seeded.get('entities', 0) != seed_ui.get('vaultNodes'):
        return False, f'导入的实体数 ≠ 知识库节点数（{seeded.get("entities")} vs {seed_ui.get("vaultNodes")}）：{seeded}'
    if seeded.get('nodes', 0) != seed_ui.get('vaultNodes'):
        return False, f'导入后画布节点数没跟上（{seeded.get("nodes")}）：{seeded}'
    if seeded.get('hyperlanes', 0) < 1 or seeded.get('storeHyperlanes', 0) != seeded.get('hyperlanes'):
        return False, f'航道没有完整随项目导入/上画布：{seeded}'
    if seeded.get('maps', 0) < 1:
        return False, f'行星图没有随项目导入（懒加载未补齐？）：{seeded}'
    if seeded.get('mode') != 'project':
        return False, f'导入后写模式不是 project：{seeded}'

    # ── c) 导入是一条 undo ────────────────────────────────────────────
    undo_res = _j(cdp, f"""(async () => {{
      const M = await import('/src/store/projectStore.js');
      const U = await import('/src/store/undo.js');
      const p = M.useProjectStore({PINIA});
      const before = {{ ents: Object.keys(p.entities || {{}}).length, label: U.currentLabel ? U.currentLabel() : '' }};
      U.undo();
      await new Promise(r => setTimeout(r, 250));
      const afterUndo = Object.keys(p.entities || {{}}).length;
      U.redo();
      await new Promise(r => setTimeout(r, 250));
      const afterRedo = Object.keys(p.entities || {{}}).length;
      return JSON.stringify({{ before, afterUndo, afterRedo }});
    }})()""", 'undo')
    if undo_res.get('afterUndo') != 0 or undo_res.get('afterRedo') != undo_res.get('before', {}).get('ents'):
        return False, f'导入不是一条可撤销命令（undo→{undo_res.get("afterUndo")} redo→{undo_res.get("afterRedo")}）：{undo_res}'

    # ── d) 项目模式：行星图缺失时**不回退知识库缓存** ──────────────────
    stripped = _j(cdp, f"""(async () => {{
      const M = await import('/src/store/projectStore.js');
      const p = M.useProjectStore({PINIA});
      const s = {STORE};
      const md = JSON.parse(JSON.stringify((p.project.maps || {{}}).mapData || {{}}));
      const keys = Object.keys(md);
      delete md['乐园星'];
      p.project = {{ ...p.project, maps: {{ ...(p.project.maps || {{}}), mapData: md }} }};
      delete s.mapData['乐园星'];              // 画布内存里也清掉，强制走一次 loadMapData
      // 计数桩：知识库缓存读取通道被调用了几次（项目模式下必须是 0）
      window.__getMapDataCalls = 0;
      if (!window.sitianAPI.__getMapDataHooked) {{
        const orig = window.sitianAPI.getMapData;
        window.sitianAPI.getMapData = async (...a) => {{ window.__getMapDataCalls += 1; return orig ? orig(...a) : {{ success: false }}; }};
        window.sitianAPI.__getMapDataHooked = true;
      }}
      return JSON.stringify({{ projectKeys: keys, left: Object.keys(md).length,
        canvasKeys: Object.keys(s.mapData || {{}}), nodes: s.nodes.length }});
    }})()""", 'strip-map')
    if stripped.get('nodes', 0) <= 0:
        return False, f'前置失败：画布节点被清空 {stripped}'
    if stripped.get('left', 0) != 0:
        return False, f'前置失败：项目里的行星图没被清干净 {stripped}'

    r = goto_planet(cdp, '乐园星')
    if r != 'planet':
        return False, f'导航行星失败 ({r})'
    time.sleep(1.2)
    leak = _j(cdp, f"""(() => {{
      const s = {STORE};
      const md = s.mapData['乐园星'];
      return JSON.stringify({{
        ipcCalls: window.__getMapDataCalls || 0,
        hasMap: !!md,
        terrain: md ? (md.terrain || []).length : -1,
        canvasKeys: Object.keys(s.mapData || {{}}),
      }});
    }})()""", 'no-vault-fallback')
    if leak.get('ipcCalls'):
        return False, f'项目模式下仍去读知识库缓存（两套事实源混流）：{leak}'
    if leak.get('hasMap'):
        return False, f'项目里没有的行星图不该凭空出现（说明从别处回填了）：{leak}'

    # ── e) 关闭项目 → 徽标回来 + 知识库读取链路照旧 ────────────────────
    back = _j(cdp, f"""(async () => {{
      const M = await import('/src/store/projectStore.js');
      const W = await import('/src/store/writeGate.js');
      const p = M.useProjectStore({PINIA});
      p.closeProject();
      await new Promise(r => setTimeout(r, 500));
      const s = {STORE};
      return JSON.stringify({{ open: p.isOpen, src: s.canvasSource, mode: W.writeMode.value,
        nodes: s.nodes.length, badge: !!document.querySelector('.toolbar-actions .readonly-badge') }});
    }})()""", 'close')
    if back.get('src') != 'vault' or back.get('nodes', 0) <= 0:
        return False, f'关闭项目后画布没回到知识库工作态：{back}'
    if back.get('mode') != 'readonly' or not back.get('badge'):
        return False, f'关闭项目后应重新只读且徽标可见：{back}'

    r2 = goto_planet(cdp, '乐园星')
    if r2 != 'planet':
        return False, f'关闭项目后导航行星失败 ({r2})'
    time.sleep(1.2)
    vault_read = _j(cdp, f"""(() => {{
      const s = {STORE};
      const md = s.mapData['乐园星'];
      return JSON.stringify({{ hasMap: !!md, terrain: md ? (md.terrain || []).length : -1 }});
    }})()""", 'vault-read')
    if not vault_read.get('hasMap') or vault_read.get('terrain', 0) <= 0:
        return False, f'无项目时知识库行星图仍应可读（只读 ≠ 看不了）：{vault_read}'

    return True, (f'只读徽标在世界视图常驻且可点达项目面板；「新建并导入知识库内容」'
                  f'{seeded.get("entities")} 实体 / {seeded.get("hyperlanes")} 航道 / {seeded.get("maps")} 张行星图，'
                  f'一条 undo 可撤可重做；项目模式缺图不回退知识库（{leak.get("hasMap")}，IPC {leak.get("ipcCalls")} 次）；'
                  f'关闭项目后回到只读且知识库行星图照旧可读（地形 {vault_read.get("terrain")} 块）')
