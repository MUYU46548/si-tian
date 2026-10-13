#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 101：**从留底恢复底图**（0.2.9，2026-10-13）

来源：2026-10-11 暮雨那句「司天自身没办法备份用户的原始底图文件」催生了 0.2.8 的
「导入 `.map` 时把原文留底」；但那一版**只做了 save + list**，没有入口、也没有"读回来"的通道 ——
留底写在 `<项目>.sitian.backups/basemap-sources/` 里，用户在界面上**够不着**
（只能自己去资源管理器翻目录）。**备份读不回来就不算备份**，所以本轮补齐：
只读通道 `basemap-source-read` + 底图组里的「从留底恢复」入口 + 与「导入 .map」**同一条链**。

判据分三组：
  f0 源码闸门：跨三层的链（组件入口 → 只读 IPC → 主进程注册）都在，且"恢复不重复留底"
  f1 行为：面板列出留底 → 点「用这份恢复」→ 底图真的建起来了 + 状态栏有回音
           🔴 而且**没有再多留一份底**（`saveBaseMapSource` 调用次数 = 0）；
              紧接着用**普通导入**做对照（同一计数器必须变成 1）—— 否则那个 0 是空转
  f2 失败路径：读回失败必须在面板里说话（不静默）；只读态必须拒绝
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json, wait_for          # noqa: E402
from lib.helpers import ensure_data_ready, open_toolbar_more  # noqa: E402

# ⚠️ 复用一个**真实可解析**的 FMG `.map` 文本（test_96 里那份故意不含 cells.h 的）——
#    刻意不另抄一份：两份 .map 夹具迟早会漂移，而这条链关心的只是"原文能不能再走一遍导入"。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_96_import_diagnostics import NO_HM_LINES   # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SC = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"

SRC_RESTORE_NAME = 'restore101'      # 留底文件名 → 底图名（.map 去掉扩展名）


def _code_only(src):
    """剥注释后再做源码闸门（本仓纪律：判据不许被注释里的字符串骗过）。"""
    out, in_block = [], False
    for line in src.splitlines():
        s = line
        if in_block:
            if '*/' in s:
                s = s.split('*/', 1)[1]
                in_block = False
            else:
                continue
        while '/*' in s:
            before, after = s.split('/*', 1)
            if '*/' in after:
                s = before + after.split('*/', 1)[1]
            else:
                s = before
                in_block = True
                break
        if '//' in s:
            s = s.split('//', 1)[0]
        out.append(s)
    return '\n'.join(out)


def source_gates():
    fails, notes = [], []
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
    with open(os.path.join(root, 'src', 'renderer', 'src', 'components', 'ScenarioMap.vue'), encoding='utf-8') as f:
        sc = _code_only(f.read())
    with open(os.path.join(root, 'src', 'preload', 'index.js'), encoding='utf-8') as f:
        pl = _code_only(f.read())
    with open(os.path.join(root, 'src', 'main', 'handlers', 'projectHandler.js'), encoding='utf-8') as f:
        mh = _code_only(f.read())

    for needle, label in [
        ('async function openSourceRestore(', '组件：留底清单入口有唯一实现'),
        ('async function restoreFromSource(', '组件：逐份恢复有唯一实现'),
        ('api.readBaseMapSource(', '组件：真的调用只读读回 IPC'),
        ('api.listBaseMapSources(', '组件：真的调用清单 IPC'),
        # 🔴 这条是"恢复不再重复留底"的**源码依据**：留底那一行被 __fromBackup 分流
        ('file.__fromBackup', '组件：恢复进来的原文不再重复留底（分流标记）'),
        ('backupMapSourceFile(file.name, text)', '组件：普通导入仍然留底（分流没把两侧一起关掉）'),
        ('opts.source', '组件：恢复走的是**同一条**导入链（不是另写一份）'),
        ('store.isReadOnly', '组件：只读态拒绝恢复'),
        ('data-testid="basemap-source-restore"', '组件：工具栏有「从留底恢复」入口'),
        ('data-testid="basemap-source-panel"', '组件：留底面板有唯一容器'),
    ]:
        if needle not in sc:
            fails.append(f'源码闸门缺失：{label}（找不到 `{needle}`）')
    if "invoke('basemap-source-read'" not in pl:
        fails.append('源码闸门缺失：preload 未暴露 basemap-source-read')
    if "ipcMain.handle('basemap-source-read'" not in mh:
        fails.append('源码闸门缺失：主进程未注册 basemap-source-read')
    if 'async function readBaseMapSource(' not in mh:
        fails.append('源码闸门缺失：主进程侧没有 readBaseMapSource 实现')
    notes.append('源码闸门 13 项' + ('全过' if not fails else f'缺 {len(fails)}'))
    return fails, notes


def run(cdp):
    fails, notes = source_gates()

    cdp.eval(
        "(() => { const b = Array.from(document.querySelectorAll('button'))"
        ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()"
    )
    try:
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式挂载')
    except RuntimeError as e:
        return False, f'剧本模式未挂载：{e}'
    time.sleep(1.2)
    # 「底图」那一组在「更多」里（模板 `v-if="moreOpen"`）—— 不展开则按钮**根本不在 DOM**
    open_toolbar_more(cdp)

    js = r""" (async () => {
  const s = __STORE__, sc = __SC__;
  const fails = [], notes = {};
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + JSON.stringify(e) + ')' : '')); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 200));
  window.confirm = () => true;
  const TEXT = __TEXT__;
  const NAME = __NAME__;

  // ── 准备：一份"已经留底"的文件（mock 的 save/list/read 是有状态的）────────────
  if (s.baseMaps[NAME]) { const { [NAME]: _drop, ...rest } = s.baseMaps; s.baseMaps = rest; }
  window.__MOCK_BMSRC = {};
  window.__MOCK_BMSRC[NAME + '.map'] = { text: TEXT, at: Date.now() };

  // 统计「又多留了一份底」的次数（恢复路径必须一次都不调）
  let saveCalls = 0;
  const origSave = window.sitianAPI.saveBaseMapSource;
  window.sitianAPI.saveBaseMapSource = async (p) => { saveCalls++; return origSave(p); };

  // ── f1 入口 → 面板 → 恢复 ────────────────────────────────────────────────
  const btn = document.querySelector('[data-testid="basemap-source-restore"]');
  ok('入口按钮在工具栏里（底图那一组）', !!btn);
  if (btn) {
    btn.click();
    await tick(400);
  }
  const panel = () => document.querySelector('[data-testid="basemap-source-panel"]');
  ok('点开后留底面板出现', !!panel());
  const rows = panel() ? panel().querySelectorAll('.bmsrc-row') : [];
  ok('面板列出了 1 份留底', rows.length === 1, rows.length);
  ok('列表里就是那份文件', !!panel() && panel().textContent.indexOf(NAME + '.map') >= 0,
     panel() ? panel().textContent.slice(0, 120) : '');
  ok('面板给了恢复语义说明（只补缺 / 不动省份）',
     !!panel() && /只补缺/.test(panel().textContent), panel() ? panel().textContent.slice(0, 240) : '');

  const use = panel() ? panel().querySelector('.bmsrc-use') : null;
  ok('每行有「用这份恢复」按钮', !!use);
  if (use) {
    use.click();
    for (let i = 0; i < 40; i++) await tick(100);
  }

  const bm = s.baseMaps[NAME];
  ok('🔴 恢复后底图真的建起来了', !!bm, Object.keys(s.baseMaps).join(','));
  ok('底图的省份来自那份 .map（≥1 块）', !!bm && (bm.terrain || []).length >= 1,
     bm ? (bm.terrain || []).length : null);
  const shown = String(sc.provinceHint || '');
  ok('状态栏有导入回音（走的是同一条链）', /已导入/.test(shown), shown.slice(0, 120));
  ok('🔴 恢复没有再多留一份底（saveBaseMapSource 调用 0 次）', saveCalls === 0, saveCalls);
  const msg = panel() ? String(panel().querySelector('[data-testid="basemap-source-msg"]')?.textContent || '') : '';
  ok('面板回执写了"走完导入链"', /走完导入链/.test(msg), msg.slice(0, 120));

  // ── 对照：**普通导入**必须仍然留底（否则上面的 0 是空转）────────────────────
  {
    const realCreate = document.createElement.bind(document);
    document.createElement = function (tag, ...rest) {
      const el = realCreate(tag, ...rest);
      if (String(tag).toLowerCase() === 'input') {
        el.click = function () {
          setTimeout(() => {
            try { el.onchange({ target: { files: [new File([TEXT], NAME + '-normal.map', { type: 'text/plain' })] } }); }
            catch (e) { /* 由下面的 saveCalls 体现 */ }
          }, 0);
        };
      }
      return el;
    };
    window.alert = () => {};
    try { await sc.triggerMapImport(); } catch (e) { /* 同上 */ }
    for (let i = 0; i < 30; i++) await tick(100);
    document.createElement = realCreate;
    ok('🔴 对照组：普通导入仍然留底（计数从 0 变 1，说明判据不是空转）', saveCalls === 1, saveCalls);
  }

  // ── f2 失败路径：读回失败必须说话 ────────────────────────────────────────
  {
    const origRead = window.sitianAPI.readBaseMapSource;
    window.sitianAPI.readBaseMapSource = async () => ({ success: false, error: '留底文件不存在：ghost.map' });
    await sc.restoreFromSource({ name: 'ghost.map', bytes: 1, mtime: '' });
    const m2 = String(panel() ? (panel().querySelector('[data-testid="basemap-source-msg"]')?.textContent || '') : '');
    ok('读回失败时面板点名原因（不静默）', /读回失败/.test(m2) && /ghost\.map/.test(m2), m2.slice(0, 120));
    window.sitianAPI.readBaseMapSource = origRead;
  }

  // ── f3 只读态：恢复必须被拒（备份读回不改数据，但"导入"是写）────────────────
  {
    const G = await import('/src/store/writeGate.js');
    const before = (s.baseMaps[NAME].terrain || []).length;
    const modeBefore = G.isReadOnly.value ? 'readonly' : 'project';
    G.setWriteMode('readonly', '');
    await sc.restoreFromSource({ name: NAME + '.map', bytes: 1, mtime: '' });
    const m3 = String(panel() ? (panel().querySelector('[data-testid="basemap-source-msg"]')?.textContent || '') : '');
    ok('只读态：恢复被拒且给出原因', /只读/.test(m3), m3.slice(0, 120));
    ok('只读态：省份数一个没变', (s.baseMaps[NAME].terrain || []).length === before, before);
    // 收尾：还原可写（后面的用例还要用 harness 基线项目）
    G.setWriteMode('project', '');
    notes.writeModeRestored = modeBefore + ' → project';
  }

  // 清场（不污染 harness 基线项目）
  window.sitianAPI.saveBaseMapSource = origSave;
  window.__MOCK_BMSRC = {};
  if (s.baseMaps[NAME]) { const { [NAME]: _d2, ...rest2 } = s.baseMaps; s.baseMaps = rest2; }
  if (s.baseMaps[NAME + '-normal']) { const { [NAME + '-normal']: _d3, ...rest3 } = s.baseMaps; s.baseMaps = rest3; }
  return JSON.stringify({ fails, notes });
})()"""

    js = (js.replace('__STORE__', STORE)
            .replace('__SC__', SC)
            .replace('__TEXT__', json.dumps('\n'.join(NO_HM_LINES)))
            .replace('__NAME__', json.dumps(SRC_RESTORE_NAME)))
    ok, res = eval_json(cdp, js, desc='101 主探针')
    if not ok:
        return False, res
    fails += res.get('fails', [])
    n = res.get('notes', {})
    if n.get('writeModeRestored'):
        notes.append(f'写模式还原 {n["writeModeRestored"]}')
    if fails:
        return False, ' | '.join(fails[:8])
    return True, ('留底清单 → 逐份恢复（不重复留底，对照组变 1）→ 读回失败点名 → 只读被拒；'
                  + '；'.join(notes))
