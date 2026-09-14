#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 22：R2 数据完整性四项（代码实证回归）
覆盖：
  a) 搜索覆盖正文 wikilinks（反向链接）—— 只在别人正文里出现的词条名也能被搜到，
     并带「提及」徽标；名称直配优先于提及（两级排序）
  b) 暂存（draft）节点转正入口 —— 详情面板对无 sourcePath 的节点给出
     「创建 Obsidian 笔记」，转正后回填 sourcePath 并切换为「在 Obsidian 中打开」
  c) 库名动态化 —— obsidian:// URI 的 vault 参数取自当前配置库名，不再硬编码 ROSA
  d) mapdata 旧 key 清理的运行时前提 —— saveMapDataImmediate 不得直写无世界前缀 key
     （静态断言：函数体必须经由 saveMapData 前缀化路径，防止旧 key 复活）
"""
import sys, os, time, json
import urllib.parse
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for
from lib.helpers import ensure_data_ready

APP_STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"


def _j(cdp, expr):
    """eval 并解析 JSON 串；异常/非串原样返回（供失败信息）"""
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def do_search(cdp, text):
    cdp.eval(
        "(() => { const i = document.querySelector('.search-input-wrapper input'); "
        f"i.value = {json.dumps(text)}; i.dispatchEvent(new Event('input', {{ bubbles: true }})); return 'ok'; }})()"
    )
    time.sleep(0.8)


def read_results(cdp):
    return _j(cdp, """(() => {
      const items = Array.from(document.querySelectorAll('.result-item'));
      return JSON.stringify(items.map(el => ({
        name: el.querySelector('.result-name') ? el.querySelector('.result-name').textContent.trim() : null,
        mention: !!el.querySelector('.result-mention-badge'),
        current: el.classList.contains('current'),
      })));
    })()""")


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    ensure_data_ready(cdp)

    # ============ a) 搜索覆盖正文 wikilinks ============
    # 「白芝原」不是任何节点的名称，只作为 wikilink 出现在 哈伦的住所 / 卡莉的工作室 正文中
    do_search(cdp, '白芝原')
    res = read_results(cdp)
    if not isinstance(res, list) or len(res) == 0:
        return False, f'wikilink 搜索无结果 {res}'
    names = {r['name'] for r in res}
    if not names.issubset({'哈伦的住所', '卡莉的工作室'}):
        return False, f'wikilink 命中集合异常 {sorted(names)}'
    if not all(r['mention'] for r in res):
        return False, f'wikilink 结果未标记「提及」 {res}'

    # 名称直配优先：搜一个自身即节点名的词，第 1 条（current）必须是直配（无「提及」徽标）
    do_search(cdp, '净土星域')
    res2 = read_results(cdp)
    if not isinstance(res2, list) or len(res2) == 0:
        return False, f'直配搜索无结果 {res2}'
    cur = [r for r in res2 if r['current']]
    if not cur:
        return False, f'无 current 结果 {res2}'
    if cur[0]['name'] != '净土星域':
        return False, f'第 1 条应是名称直配节点 (实际 {cur[0]})'
    if any(r['mention'] for r in cur):
        return False, f'第 1 条不应是「提及」命中 {cur[0]}'
    # 同一查询里，自身即命中的 净土星域 不得被标成提及
    own = [r for r in res2 if r['name'] == '净土星域']
    if own and own[0]['mention']:
        return False, f'名称直配节点被误标为「提及」 {own[0]}'

    # 清空搜索（避免影响后续断言）
    cdp.eval("(() => { const i = document.querySelector('.search-input-wrapper input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()")
    time.sleep(0.3)

    # ============ b) draft 转正入口 ============
    made = _j(cdp, f"""(() => {{
      const s = {APP_STORE};
      const planet = s.nodes.find(n => n.name === '乐园星');
      const id = 'test_draft_' + Date.now();
      s.addNode({{ id, name: '暂存测试地点', layer: 'city', parentId: planet ? planet.id : null,
        tags: [], sourcePath: '', coordinate: {{ x: 10, y: 10 }}, draft: true }});
      const n = s.nodes.find(x => x.id === id);
      if (!n) return JSON.stringify({{ err: 'addNode-failed' }});
      s.selectNode(n);
      return JSON.stringify({{ id, draft: n.draft === true, sourcePath: n.sourcePath }});
    }})()""")
    if not isinstance(made, dict) or 'id' not in made:
        return False, f'创建暂存节点失败 {made}'
    draft_id = made['id']

    wait_for(cdp, "!!document.querySelector('.detail-panel .actions-section-top')", desc='详情面板操作区')
    time.sleep(0.3)
    labels = _j(cdp, """(() => {
      const sec = document.querySelector('.detail-panel .actions-section-top');
      if (!sec) return 'no-section';
      return JSON.stringify(Array.from(sec.querySelectorAll('button')).map(b => b.textContent.trim()));
    })()""")
    if not isinstance(labels, list):
        return False, f'操作区按钮读取失败 {labels}'
    if not any('创建 Obsidian 笔记' in t for t in labels):
        return False, f'暂存节点缺少转正入口 {labels}'
    if any('在 Obsidian 中打开' in t for t in labels):
        return False, f'暂存节点不应显示「在 Obsidian 中打开」（无 sourcePath） {labels}'
    if any('在文件夹中显示' in t for t in labels):
        return False, f'暂存节点不应显示「在文件夹中显示」 {labels}'

    promoted = _j(cdp, f"""(async () => {{
      const sec = document.querySelector('.detail-panel .actions-section-top');
      const btn = Array.from(sec.querySelectorAll('button')).find(b => b.textContent.includes('创建 Obsidian 笔记'));
      if (!btn) return JSON.stringify({{ err: 'no-btn' }});
      btn.click();
      await new Promise(r => setTimeout(r, 300));
      const s = {APP_STORE};
      const n = s.nodes.find(x => x.id === {json.dumps(draft_id)});
      const sec2 = document.querySelector('.detail-panel .actions-section-top');
      return JSON.stringify({{
        sourcePath: n ? n.sourcePath : null,
        draft: n ? n.draft : null,
        labels2: sec2 ? Array.from(sec2.querySelectorAll('button')).map(b => b.textContent.trim()) : [],
      }});
    }})()""")
    if not isinstance(promoted, dict) or 'sourcePath' not in promoted:
        return False, f'转正链路异常 {promoted}'
    if not promoted['sourcePath']:
        return False, f'转正后未回填 sourcePath {promoted}'
    if not any('在 Obsidian 中打开' in t for t in promoted.get('labels2', [])):
        return False, f'转正后按钮未切换为「在 Obsidian 中打开」 {promoted}'

    # ============ c) 库名动态化 ============
    vaultprobe = _j(cdp, f"""(async () => {{
      window.__opened = null;
      const realOpen = window.sitianAPI.openExternal;
      const realVault = window.sitianAPI.getVaultPath;
      window.sitianAPI.openExternal = async (u) => {{ window.__opened = u; return {{ success: true }}; }};
      window.sitianAPI.getVaultPath = async () => 'E:/图书馆/测试库A';
      const s = {APP_STORE};
      const n = s.nodes.find(x => x.name === '乐园星系');
      if (!n || !n.sourcePath) return JSON.stringify({{ err: 'no-node-with-sourcePath' }});
      s.selectNode(n);
      await new Promise(r => setTimeout(r, 150));
      const sec = document.querySelector('.detail-panel .actions-section-top');
      const btn = sec && Array.from(sec.querySelectorAll('button')).find(b => b.textContent.includes('在 Obsidian 中打开'));
      if (!btn) return JSON.stringify({{ err: 'no-open-btn' }});
      btn.click();
      await new Promise(r => setTimeout(r, 150));
      window.sitianAPI.openExternal = realOpen;
      window.sitianAPI.getVaultPath = realVault;
      return JSON.stringify({{ url: window.__opened, path: n.sourcePath }});
    }})()""")
    if not isinstance(vaultprobe, dict) or not vaultprobe.get('url'):
        return False, f'Obsidian 跳转链路异常 {vaultprobe}'
    url = vaultprobe['url']
    if not url.startswith('obsidian://open?'):
        return False, f'URI 形式异常 {url}'
    got_vault = urllib.parse.unquote(url.split('vault=')[1].split('&')[0])
    if got_vault != '测试库A':
        return False, f'URI 的 vault 未跟随当前库名（硬编码？）得到 {got_vault!r} url={url}'

    # ============ d) 旧 key 不复活：saveMapDataImmediate 必须写世界前缀化 key ============
    keycheck = _j(cdp, f"""(async () => {{
      const s = {APP_STORE};
      const pid = '乐园星';
      const expect = s.getMapDataKey(pid);
      const data = await s.loadMapData(pid);
      if (!data) return JSON.stringify({{ err: 'no-mapdata' }});
      const real = window.sitianAPI.saveMapData;
      window.__savedKey = null;
      window.sitianAPI.saveMapData = async (k) => {{ window.__savedKey = k; return {{ success: true }}; }};
      s.saveMapDataImmediate(pid);
      await new Promise(r => setTimeout(r, 150));
      window.sitianAPI.saveMapData = real;
      return JSON.stringify({{ expect, savedKey: window.__savedKey, terrain: (data.terrain || []).length }});
    }})()""")
    if not isinstance(keycheck, dict) or 'expect' not in keycheck:
        return False, f'旧 key 复活检查链路异常 {keycheck}'
    if keycheck['savedKey'] != keycheck['expect']:
        return False, f'saveMapDataImmediate 写盘 key 异常 {keycheck}'
    if '/' not in (keycheck['savedKey'] or ''):
        return False, f'写盘 key 未带世界前缀（会重新制造旧 key） {keycheck}'

    # 清场：撤销转正 + 删除暂存节点
    cdp.eval(f"(() => {{ const s = {APP_STORE}; const n = s.nodes.find(x => x.id === {json.dumps(draft_id)}); if (n) s.removeNode(n.id); s.clearSelection(); return 'clean'; }})()")
    time.sleep(0.3)

    return True, ('搜索覆盖 wikilinks（白芝原→哈伦的住所/卡莉的工作室，带提及徽标）+ 名称直配优先 + '
                  'draft 转正入口与 sourcePath 回填 + obsidian URI 库名动态化（测试库A）+ '
                  f'saveMapDataImmediate 写盘 key={keycheck["savedKey"]}（带世界前缀，旧 key 不复活）全通过')
