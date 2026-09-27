#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 75：笔记改名「断线检测 + 重连」（R15 / A-0）

来源：`IMPROVEMENT_BACKLOG.md` §四 的 R15（2026-09-27 稽核新增）＋ `ROADMAP_NEXT` D5
「搬家线前置 = 断线检测」。症状是**静默**：

  项目态下知识库的 add/unlink 事件被整条拦掉（防两套事实源混流，见 geodata `handleNodeUpdated`）
  → 用户在 Obsidian 里把笔记改名，司天**既不知道也不提示**；下次「导入知识库内容」把新名当
  新实体补进来、旧实体成孤儿（坐标与地图/区域/建筑内部数据留在旧 id 上，用户看到"多一个、少一个"）。

本用例覆盖：
  f0 源码守卫：断线检测与候选打分**只有一份实现**（utils/vaultRelink.js），
     主进程不自己写目录遍历（复用提取器的 listScannedNotes → 口径单源），
     preload / 适配器 / 面板接线齐全，面板不复制打分逻辑。
  f1 端到端：造一个带来源笔记的实体（带坐标 + 地图 + 区域数据）→ 库里改名 →
     查出断线并给出**可读理由**的推荐候选 → 点「重连」→
     **id 不变、坐标与编辑成果全部保留**、来源路径与名字更新 → 一条 undo 全部还原。
  f2 边界：目标笔记已被别的实体占用 → 拒绝（保持一对一）；库里的笔记都在 → 明确回「未发现断线」。
"""
import sys, os, io, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib import helpers as H  # noqa: E402
from lib.cdp import wait_for, eval_json  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

APP = "document.querySelector('#app').__vue_app__"
APP_ST = "document.querySelector('#app').__vue_app__._instance.setupState"


def _read(rel):
    return io.open(os.path.join(ROOT, rel), encoding='utf-8').read()


def _code_only(src):
    """剥掉注释后再做子串判据 —— 修完 bug 之后注释里天然会出现「此前如何如何」的字样，
    纯子串判据会把注释当成违规（test_71 首版踩过）。"""
    out, i, n, in_block = [], 0, len(src), False
    while i < n:
        c = src[i]
        if in_block:
            if c == '*' and i + 1 < n and src[i + 1] == '/':
                in_block, i = False, i + 2
                continue
            out.append('\n' if c == '\n' else ' ')
            i += 1
            continue
        if c == '/' and i + 1 < n and src[i + 1] == '*':
            in_block, i = True, i + 2
            continue
        if c == '/' and i + 1 < n and src[i + 1] == '/':
            while i < n and src[i] != '\n':
                i += 1
            continue
        out.append(c)
        i += 1
    return ''.join(out)


# ══════════════════════════════════════════════════════════════════
# f0 源码守卫
# ══════════════════════════════════════════════════════════════════
def sub_source_guards(cdp):
    bad = []

    relink = _code_only(_read('src/renderer/src/utils/vaultRelink.js'))
    for fn in ['export function detectBrokenLinks', 'export function normalizeRelPath',
               'export function scoreCandidate', 'export function describeCandidate',
               'export function commonSubstrLen']:
        if fn not in relink:
            bad.append(f'utils/vaultRelink.js 缺少 {fn}')

    proj = _code_only(_read('src/renderer/src/store/projectStore.js'))
    if "from '../utils/vaultRelink'" not in proj:
        bad.append('projectStore 没有引用 utils/vaultRelink（检测会变成第二份实现）')
    if 'function scanBrokenLinks' not in proj or 'function relinkEntity' not in proj:
        bad.append('projectStore 缺少 scanBrokenLinks / relinkEntity')

    # 重连必须**保持 id 不变**：id 一变就得做引用级联迁移（9 个容器），而重连的语义是"同一地点换篇笔记"
    seg = proj.split('function relinkEntity')[1][:2600] if 'function relinkEntity' in proj else ''
    if 'changeNodeId' in seg:
        bad.append('relinkEntity 里出现了 changeNodeId —— 重连不该改 id（改 id 就要级联迁移全部编辑成果）')
    if 'id:' not in seg:
        bad.append('relinkEntity 没有显式保留 id')

    main_src = _code_only(_read('src/main/index.js'))
    # 🔴 主进程不得**自己**遍历知识库目录：口径必须复用提取器的 `listScannedNotes`
    #    （两份扫描漂移会让「断线」误报，把正常笔记说成丢了）。
    #    ⚠️ 判据必须收在**这个 handler 的函数体内**（函数级粒度）—— index.js 里另有 2 处
    #    `fs.readdir` 属备份目录/卸载目录，全文件级判据会把它们当成违规（假红）。
    if "ipcMain.handle('list-vault-notes'" not in main_src:
        bad.append('主进程缺少 list-vault-notes 通道')
    else:
        seg = main_src.split("ipcMain.handle('list-vault-notes'")[1].split('ipcMain.handle(')[0]
        if 'readdir' in seg:
            bad.append('list-vault-notes 自己写了目录遍历 —— 必须复用 listScannedNotes（口径单源）')
        if 'listScannedNotes' not in seg:
            bad.append('list-vault-notes 没有调用 listScannedNotes')
    if 'listScannedNotes' not in main_src:
        bad.append('主进程没有从 extract-data 解构 listScannedNotes')

    ext = _code_only(_read('scripts/extract-data.js'))
    if 'function listScannedNotes' not in ext or 'listScannedNotes,' not in ext:
        bad.append('extract-data.js 没有导出 listScannedNotes')
    scan_seg = ext.split('function listScannedNotes')[1][:2200] if 'function listScannedNotes' in ext else ''
    # 复用提取器自己的路径函数与排除表 = 真正的口径单源（而不是在扫描器里再写一遍目录名）
    for token in ['geoSystemPath()', 'locationsPath()', 'SCAN_EXCLUDED_BASENAMES']:
        if token not in scan_seg:
            bad.append(f'listScannedNotes 没有复用提取器的 {token}（口径会漂移）')

    pre = _code_only(_read('src/preload/index.js'))
    if "listVaultNotes:" not in pre or 'list-vault-notes' not in pre:
        bad.append('preload 没有暴露 listVaultNotes')

    geo = _code_only(_read('src/renderer/src/store/geodata.js'))
    if 'async function listVaultNotes' not in geo or 'listVaultNotes,' not in geo:
        bad.append('geodata 适配器没有实现 / 注册 listVaultNotes')
    geo_seg = geo.split('async function listVaultNotes')[1][:1800] if 'async function listVaultNotes' in geo else ''
    if 'notes: []' in geo_seg and 'success: false' in geo_seg:
        pass  # 失败分支必须带 notes: []（调用方判 success，不看空数组）—— 这里只做存在性提示
    else:
        bad.append('listVaultNotes 的失败分支没有给 notes: []（调用方可能把 undefined 当空库）')

    panel = _code_only(_read('src/renderer/src/components/ProjectPanel.vue'))
    if 'describeCandidate' not in panel:
        bad.append('面板没有走 describeCandidate（理由措辞会变成第二套）')
    if 'scoreCandidate' in panel or 'commonSubstrLen' in panel:
        bad.append('面板里复制了打分逻辑 —— 候选打分必须只有 utils/vaultRelink.js 一份')
    for tid in ['check-broken-links', 'broken-list', 'broken-clean']:
        if tid not in panel:
            bad.append(f'面板缺少 data-testid="{tid}"')
    if 'scanBrokenLinks' not in panel:
        bad.append('面板没有调用 proj.scanBrokenLinks')

    if bad:
        return False, '；'.join(bad)
    return True, ('检测/打分单源（utils/vaultRelink.js）；主进程复用提取器扫描口径；'
                  'preload/适配器/面板接线齐全；面板未复制打分逻辑')


# ══════════════════════════════════════════════════════════════════
# f1 / f2 端到端
# ══════════════════════════════════════════════════════════════════
JS = r"""(async () => {
  const fails = [], notes = [];
  const ck = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' → ' + JSON.stringify(e) : '')); };
  const same = (l, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(l + ' → got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); };
  const tick = (ms) => new Promise(r => setTimeout(r, ms || 150));
  const q = (s) => document.querySelector(s);
  const text = (s) => { const e = q(s); return e ? e.textContent.trim() : ''; };

  const APP = __APP__;
  const st = APP._instance.setupState;
  const store = st.store;
  const pinia = APP.config.globalProperties.$pinia;
  const PM = await import('/src/store/projectStore.js');
  const proj = PM.useProjectStore(pinia);

  const DIR = '03 设定/02 场景地点';
  const OLD_PATH = DIR + '/R15旧名.md';
  const NEW_PATH = DIR + '/R15新名.md';

  // 🔴 装置纪律：注入的清单必须**覆盖项目里全部实体的来源笔记**。
  //    首跑踩到过：只注入一条 → 其余 119 个实体（harness 基线项目）全被报成"断线"，
  //    tips 说「发现 120 处断线」，后续断言全被噪声淹没。
  //    真实场景里清单就是整库扫描结果，所以这里按「整库 + 一处改名」构造。
  const noteOf = (p) => ({
    sourcePath: p,
    name: String(p).split('/').pop().replace(/\.md$/i, ''),
    dir: String(p).slice(0, String(p).lastIndexOf('/')),
  });
  const vaultNotesOf = (renameMap = {}) => {
    const out = [], seen = new Set();
    for (const e of Object.values(proj.entities)) {
      const p = e && e.sourcePath;
      if (!p) continue;                      // 用户自建实体没有来源笔记，本就不参与对账
      const q = renameMap[p] || p;
      if (seen.has(q)) continue;
      seen.add(q); out.push(noteOf(q));
    }
    for (const q of Object.values(renameMap)) {
      if (q && !seen.has(q)) { seen.add(q); out.push(noteOf(q)); }
    }
    return out;
  };
  const P = 'r15b_planet', R = 'r15b_region';
  const world = (proj.entityList.find(e => e.layer === 'world')
    || (store.nodes.find(n => n.layer === 'world'))) || null;
  ck('装置：项目里存在世界级实体（作为父级）', !!world, null);
  const worldId = world ? world.id : null;

  // ── 造一个「来自笔记」的实体 + 编辑成果（坐标 / 地图 / 区域）──
  store.addNode({ id: P, name: 'R15旧名', layer: 'planet', parentId: worldId, tags: [],
                  sourcePath: OLD_PATH, coordinate: { x: 33, y: 44 } });
  store.addNode({ id: R, name: 'R15区域', layer: 'region', parentId: P, tags: [],
                  sourcePath: '', coordinate: { x: 1, y: 2 } });
  store.mapData[P] = { terrain: [{ id: 'rt1' }] };
  store.areaZones[R] = [{ id: 'rz1' }];
  if (typeof store.flushSave === 'function') store.flushSave();
  await tick(900);

  ck('装置：项目侧实体带着来源笔记路径（否则断线检测测成空转）',
     !!(proj.entities[P] && proj.entities[P].sourcePath === OLD_PATH),
     proj.entities[P] ? proj.entities[P].sourcePath : null);

  // ── f1 库里改名：旧路径没了，出现新路径 ──
  window.__vaultNotes = vaultNotesOf({ [OLD_PATH]: NEW_PATH });

  const scan = await proj.scanBrokenLinks();
  ck('f1 scanBrokenLinks 成功', !!(scan && scan.success), scan && scan.error);
  const dList = (scan && scan.dangling) || [];
  ck('f1 ★ 检测到断线（旧实现：改名之后什么都不说）', dList.some(d => d.id === P),
     dList.map(d => d.id));
  ck('f1 断线条目带着原路径（用户要知道它原来指向哪）',
     !!(dList.find(d => d.id === P) || {}).sourcePath, dList.find(d => d.id === P));
  const sug = ((scan && scan.suggestions) || {})[P] || [];
  ck('f1 ★ 给出候选', sug.length >= 1, sug.length);
  if (sug.length) {
    ck('f1 ★ 同目录 + 名字相近的候选被标为「推荐」', sug[0].recommended === true, sug[0]);
    ck('f1 候选理由可读（同目录）', (sug[0].reasons || []).join('|').indexOf('同目录') >= 0, sug[0].reasons);
    same('f1 候选指向改名后的那篇笔记', sug[0].sourcePath, NEW_PATH);
  }
  ck('f1 无主清单里出现改名后的新笔记',
     ((scan && scan.unclaimed) || []).some(n => n.sourcePath === NEW_PATH), (scan && scan.unclaimed) || []);

  // ── f1 面板：点「检查笔记改名」→ 看到断线与推荐理由 ──
  const toolBtn = Array.from(document.querySelectorAll('button'))
    .find(b => (b.getAttribute('title') || '').indexOf('.sitian') >= 0);
  ck('装置：工具栏有「项目」入口', !!toolBtn, null);
  if (toolBtn && !q('.project-panel')) {
    toolBtn.click();
    for (let i = 0; i < 40 && !q('.project-panel'); i++) await tick(100);   // 懒加载 chunk
  }
  ck('装置：项目面板已渲染', !!q('.project-panel'), null);
  const scanBtn = q('[data-testid="check-broken-links"]');
  ck('f1 面板有「检查笔记改名」按钮', !!scanBtn, null);
  if (scanBtn) {
    scanBtn.click();
    await tick(400);
    ck('f1 ★ 面板列出这条断线', !!q('[data-testid="broken-' + P + '"]'), null);
    const tip = text('.pp-tip');
    ck('f1 ★ 检查后给了可见结论（不静默）', /断线|未发现/.test(tip), tip);
    const sel = q('[data-testid="relink-select-' + P + '"]');
    ck('f1 断线条目给了候选下拉', !!sel, null);
    if (sel) {
      const optText = Array.from(sel.options).map(o => o.textContent).join('|');
      ck('f1 ★ 候选选项里写着理由（给用户看的是理由，不是分数）', /同目录/.test(optText), optText);
      ck('f1 推荐项被标出来', /推荐/.test(optText), optText);
    }

    // ── 点「重连」 ──
    const relinkBtn = q('[data-testid="relink-' + P + '"]');
    ck('f1 有「重连」按钮', !!relinkBtn, null);
    if (relinkBtn) {
      relinkBtn.click();
      await tick(500);
      const e = proj.entities[P] || {};
      same('f1 ★ 来源路径更新为改名后的笔记', e.sourcePath, NEW_PATH);
      same('f1 ★ id 保持不变（编辑成果全靠它）', e.id, P);
      same('f1 实体名跟笔记名同步', e.name, 'R15新名');
      ck('f1 重连后给了回执（写明保留了什么）', /保留/.test(text('.pp-tip')), text('.pp-tip'));
      ck('f1 重查后该条断线从清单里消失', !q('[data-testid="broken-' + P + '"]'), null);

      // ── 编辑成果必须原样保留（id 不变的自然结果，但要真断言）──
      ck('f1 ★ 地图数据仍在原 id 下', !!(store.mapData[P] && store.mapData[P].terrain), Object.keys(store.mapData));
      ck('f1 ★ 区域数据仍在原 id 下', !!(store.areaZones[R] && store.areaZones[R].length), Object.keys(store.areaZones));
      const node = store.nodes.find(n => n.id === P);
      ck('f1 ★ 画布上节点还在，坐标未动', !!(node && node.coordinate && node.coordinate.x === 33 && node.coordinate.y === 44),
         node ? node.coordinate : null);
      ck('f1 画布节点的名字也同步了', !!(node && node.name === 'R15新名'), node ? node.name : null);

      // ── undo：一条撤销把来源还原（编辑成果仍在）──
      store.undo();
      await tick(400);
      same('f1 ★ 撤销后来源路径回到旧值', (proj.entities[P] || {}).sourcePath, OLD_PATH);
      same('f1 撤销后 id 不变', (proj.entities[P] || {}).id, P);
      ck('f1 撤销后地图数据仍在（重连从未动过编辑成果）', !!store.mapData[P], Object.keys(store.mapData));
      store.redo();
      await tick(400);
      same('f1 重做后又指向新笔记', (proj.entities[P] || {}).sourcePath, NEW_PATH);
    }
  }

  // ── f2 边界 ──
  // f2a 目标笔记已被别的实体占用 → 拒绝（保持一对一）
  // ⚠️ 先把 P 的来源改回旧路径：f1 之后 P 已指向 NEW_PATH，若不还原，
  //    relink(P, NEW_PATH) 会先命中「重连到自己当前的来源」分支 → 测不到占用冲突（首跑踩到）
  proj.updateEntity(P, { sourcePath: OLD_PATH });
  await tick(250);
  ck('装置：P 的来源已还原为旧路径', (proj.entities[P] || {}).sourcePath === OLD_PATH, (proj.entities[P] || {}).sourcePath);

  proj.createEntity({ name: 'R15占位', layer: 'location', parentId: P, sourcePath: NEW_PATH });
  await tick(250);
  const realOther = proj.entityList.find(e => e.name === 'R15占位');
  ck('装置：第二个实体已指向同一篇笔记', !!(realOther && realOther.sourcePath === NEW_PATH), realOther);
  if (realOther) {
    const dup = proj.relinkEntity(P, { sourcePath: NEW_PATH });
    ck('f2 ★ 目标已被占用 → 拒绝重连（否则两个实体抢同一篇笔记）', dup.success === false, dup);
    ck('f2 ★ 拒绝时点名占用者', /已经连到/.test(String(dup.error || '')), dup.error);
    ck('f2 拒绝时不动数据（P 仍指向旧路径）', (proj.entities[P] || {}).sourcePath === OLD_PATH, (proj.entities[P] || {}).sourcePath);
  }
  // f2b 重连到自己当前的来源 → 明确拒绝（不是静默成功）
  const self = proj.relinkEntity(P, { sourcePath: OLD_PATH });
  ck('f2 ★ 重连到自己当前的来源 → 明确拒绝', self.success === false, self);
  // f2c 库里笔记都在 → 明确回「未发现断线」
  window.__vaultNotes = vaultNotesOf();
  const clean = await proj.scanBrokenLinks();
  ck('f2 ★ 笔记都在 → clean=true（且报出对账了几篇）',
     !!(clean && clean.success && clean.clean === true && clean.notes > 0),
     { clean: clean && clean.clean, notes: clean && clean.notes, dangling: ((clean && clean.dangling) || []).length });
  if (scanBtn) {
    const btn2 = q('[data-testid="check-broken-links"]');
    if (btn2) { btn2.click(); await tick(400); }
    ck('f2 ★ 面板给「未发现断线」的正向回音',
       /未发现断线/.test(text('[data-testid="broken-clean"]')), text('[data-testid="broken-clean"]'));
    ck('f2 断线清单区域消失', !q('[data-testid="broken-list"]'), null);
  }
  ck('f2 scanBrokenLinks 在有项目时仍正常', !!(clean && clean.success), clean && clean.error);

  // ── 清理 ──
  window.__vaultNotes = [];
  try { if (realOther) proj.deleteEntity(realOther.id, { cascade: true }); } catch (e) {}
  try { proj.deleteEntity(P, { cascade: true }); } catch (e) {}

  return JSON.stringify({ fails, notes });
})()"""


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    wait_for(cdp, f"{APP_ST}.store.nodes.length > 0", timeout=45, desc='地理数据加载')

    ok, info = H.ensure_case_state(cdp)
    if not ok:
        return False, f'装置失败（harness 项目未打开）：{info.get("error") or info}'

    ok_src, detail_src = sub_source_guards(cdp)
    if not ok_src:
        return False, f'f0 源码守卫失败：{detail_src}'

    js = JS.replace('__APP__', APP)
    ok_js, res = eval_json(cdp, js, desc='断线检测与重连（R15/A-0）')
    if not ok_js:
        return False, res
    if isinstance(res, dict):
        fails = res.get('fails') or []
        if fails:
            return False, f'断言失败 {len(fails)} 项：' + '；'.join(str(x) for x in fails[:10])
        return True, ('f0 检测/打分单源 + 主进程复用提取器扫描口径 + 接线齐全；'
                      'f1 改名 → 断线 → 可读理由的推荐候选 → 重连后 id/坐标/地图/区域数据全保留，一条 undo 还原；'
                      'f2 占用冲突与自我重连被拒、笔记都在时明确回「未发现断线」—— 全部通过')
    return False, f'用例返回值异常：{str(res)[:200]}'
