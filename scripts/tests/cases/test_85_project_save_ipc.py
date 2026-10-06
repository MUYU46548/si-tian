#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 85：项目文件保存的 IPC 边界 —— 载荷必须**可序列化**

来源：2026-10-06 真机演练（`drill_quit_flush.py`）留下的未决项 T2，
      由 `diag_t2_save.py` 在 dev 模式（`NODE_ENV=development`，`_instance` 可用）下定位。

缺陷原貌（修复前）：
  `projectStore.saveProject()` 把 `project.value` **原样**交给 `ipcRenderer.invoke`。
  而 `project.value` 是 Vue 的 deep-reactive 代理 —— `ipcRenderer.invoke` 走 V8 ValueSerializer，
  **遇 Proxy 一律抛 "An object could not be cloned."** → **每一次项目保存都失败**（连空项目也存不下），
  `.sitian` 文件永远停在新建时那个 367 字节空壳。失败只写进 `lastError` + 底部状态栏，
  而 `StatusBar.vue` 的根节点是 `v-if="state.visible"` → **世界选择页（没有画布）里那条提示根本不在 DOM 中**。
  合成的症状就是暮雨那句「导入过、看着有内容、重开是空的」。

为什么 84 个用例全绿却漏了它（本用例存在的理由）：
  CDP 用例的 `window.sitianAPI.projectSave` 是 **mock**，旧实现只做
  `JSON.parse(JSON.stringify(p.project))` —— 而 JSON 往返**恰好能读穿 Vue 代理**，
  于是"载荷不可序列化"这件事在测试里**永远不会发生**。
  所以修复同时**加固了 mock**（真做 `structuredClone`，见 `run_tests.py` 的 MOCK_SCRIPT），
  并由 g0 守住那一步 —— 只要有人把它改回 JSON 往返，本用例立刻红。

覆盖：
  g0 源码守卫：saveProject 的 IPC 实参必须过 `toIpcPlain`（且不许再直接传 `withSnapshot`）；
     `toIpcPlain`/`jsonSafeReplacer` 单一事实源；MOCK 必须真做 `structuredClone`。
  g1 反向探针：mock 的序列化边界**确实生效**（reactive 代理必被拒、纯 JSON 必通过）——
     没有这一段，g2 可能是「空转通过」（边界根本不检查，自然什么都过）。
  g2 端到端：项目态新建实体 → 等 800ms 防抖 → 载荷真的落进项目文件
     （mock 项目文件里出现新实体 + `dirty=false` + `saveStatus='saved'`）。
"""

import io
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import eval_json  # noqa: E402
from lib.helpers import ensure_data_ready  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PROJ = 'src/renderer/src/store/projectStore.js'
SCHEMA = 'src/renderer/src/utils/projectSchema.js'
GEO = 'src/renderer/src/store/geodata.js'
MOCK = 'scripts/tests/run_tests.py'


def _read(rel):
    return io.open(os.path.join(ROOT, rel), encoding='utf-8').read()


def _code_only(src):
    """剥掉注释后再判子串 —— 本仓五次踩到「注释里的字样被当成实现」。"""
    src = re.sub(r'<!--.*?-->', '', src, flags=re.S)
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    return re.sub(r'(?m)//[^\n]*', '', src)


# ══════════════════════════════════════════════════════════════════
# g0 源码守卫
# ══════════════════════════════════════════════════════════════════
def sub_source_guards(cdp):
    bad = []
    proj = _code_only(_read(PROJ))
    schema = _code_only(_read(SCHEMA))
    geo = _code_only(_read(GEO))
    mock = _code_only(_read(MOCK))

    # ① 跨 IPC 的载荷必须过统一下载口
    if not re.search(r'project:\s*toIpcPlain\(', proj):
        bad.append('saveProject 的 IPC 实参没有过 toIpcPlain（Vue 代理会被 IPC 拒掉 → 保存必失败）')
    # ② 反证：不许再回到「直接传项目对象」的旧写法
    if re.search(r'project:\s*withSnapshot\b', proj):
        bad.append('saveProject 又直接把 withSnapshot 交给 IPC 了（代理不可克隆）')

    # ③ 单一事实源：toIpcPlain / jsonSafeReplacer 只在 projectSchema 里实现一份
    if not re.search(r'export function toIpcPlain\(', schema):
        bad.append('projectSchema 没有导出 toIpcPlain（跨 IPC 载荷的统一下载口）')
    if not re.search(r'export function jsonSafeReplacer\(', schema):
        bad.append('projectSchema 没有 jsonSafeReplacer（TypedArray 兜底的单一事实源）')
    if re.search(r'export function jsonSafeReplacer\(', geo):
        bad.append('geodata 又自建了一份 jsonSafeReplacer（会出现"改一处另几处不变"的静默分裂）')
    if 'export { jsonSafeReplacer }' not in geo:
        bad.append('geodata 没有从 projectSchema 再导出 jsonSafeReplacer（App.vue / test_21 会取不到）')

    # ④ mock 必须模拟真实 IPC 边界 —— 这是本用例能发现该缺陷的唯一原因
    if 'structuredClone(p.project || {})' not in mock:
        bad.append('测试 mock 的 projectSave 没有做 structuredClone（JSON 往返能读穿代理 → 缺陷会再次隐形）')

    if bad:
        return False, '源码守卫失败：' + '；'.join(bad)
    return True, ('saveProject 走 toIpcPlain + 单一事实源齐备 + mock 真做 structuredClone')


# ══════════════════════════════════════════════════════════════════
# g1 反向探针：IPC 序列化边界确实生效
# ══════════════════════════════════════════════════════════════════
G1_JS = r"""(async () => {
  const fails = [];
  const app = document.querySelector('#app').__vue_app__;
  const pinia = app.config.globalProperties.$pinia;
  const ps = (await import('/src/store/projectStore.js')).useProjectStore(pinia);
  if (!ps.project) return JSON.stringify({ fails: ['没有打开的项目（harness 未就绪）'] });

  // 探针会往 helpers 的落盘记录里塞两条假载荷 → 先记长度，收尾截回去，别污染后续用例
  const savedLen = (window.__savedProject || []).length;

  // ① 真实缺陷形态：Vue 深响应式代理（= 修复前直接传给 IPC 的东西）必须被拒
  const bad = await window.sitianAPI.projectSave({ filePath: 'probe/reactive.sitian', project: ps.project });
  if (bad && bad.success === true) {
    fails.push('mock 的 IPC 边界没有生效：reactive 代理竟然序列化成功了 → g2 会空转通过');
  }
  // ② 纯 JSON 形态必须通过（证明拒绝不是因为"项目有问题"）
  const plain = JSON.parse(JSON.stringify(ps.project));
  const good = await window.sitianAPI.projectSave({ filePath: 'probe/plain.sitian', project: plain });
  if (!good || good.success !== true) {
    fails.push('纯 JSON 载荷被拒了（边界过严）：' + JSON.stringify(good));
  }

  if (window.__savedProject) window.__savedProject.length = savedLen;
  if (window.__projects) delete window.__projects['probe/plain.sitian'];

  return JSON.stringify({ fails, rejectMsg: bad && bad.error, goodBytes: good && good.bytes });
})()"""


def sub_ipc_boundary_is_real(cdp):
    ok, res = eval_json(cdp, G1_JS, desc='IPC 序列化边界', required=('fails',))
    if not ok:
        return False, res
    if res['fails']:
        return False, 'IPC 边界探针失败：' + '；'.join(res['fails'])
    return True, ('reactive 代理被拒（%s）+ 纯 JSON 通过（%s B）—— 边界真的在检查'
                  % (str(res.get('rejectMsg'))[:40], res.get('goodBytes')))


# ══════════════════════════════════════════════════════════════════
# g2 端到端：自动保存真的把载荷送进项目文件
# ══════════════════════════════════════════════════════════════════
G2_JS = r"""(async () => {
  const fails = [];
  const app = document.querySelector('#app').__vue_app__;
  const pinia = app.config.globalProperties.$pinia;
  const ps = (await import('/src/store/projectStore.js')).useProjectStore(pinia);
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  if (!ps.project) return JSON.stringify({ fails: ['没有打开的项目'] });

  const fp = ps.filePath;
  const fileBefore = (window.__projects || {})[fp] || {};
  const before = Object.keys(fileBefore.entities || {}).length;

  // 走真实项目 CRUD（execute → redo → dirty + scheduleAutoSave）
  const r = ps.createEntities(['用例85节点甲', '用例85节点乙'], { layer: 'world' });
  if (!r || r.success !== true) {
    return JSON.stringify({ fails: ['建实体失败：' + JSON.stringify(r)] });
  }

  // 800ms 防抖 + 落盘余量
  await wait(1800);

  const file = ((window.__projects || {})[fp]) || {};
  const keys = Object.keys(file.entities || {});
  if (keys.length <= before) {
    fails.push(`项目文件没有增长（${before} → ${keys.length}）：自动保存没落到项目文件`);
  }
  if (!keys.includes('用例85节点甲')) fails.push('新建的实体没有出现在项目文件里');
  if (ps.dirty !== false) fails.push('保存完成后 dirty 仍为 true（保存链没走完）');
  if (ps.saveStatus !== 'saved') fails.push('保存状态不是 saved，而是：' + ps.saveStatus);
  if (ps.lastError) fails.push('保存报了错：' + ps.lastError);

  return JSON.stringify({ fails, before, after: keys.length,
                          status: ps.saveStatus, lastError: ps.lastError, filePath: fp });
})()"""


def sub_autosave_reaches_file(cdp):
    ok, res = eval_json(cdp, G2_JS, desc='自动保存落到项目文件', required=('fails',))
    if not ok:
        return False, res
    if res['fails']:
        return False, '端到端断言失败：' + '；'.join(res['fails'])
    return True, ('新建实体后 800ms 防抖落盘成功：项目文件实体 %s → %s，saveStatus=%s，dirty=false'
                  % (res.get('before'), res.get('after'), res.get('status')))


# ══════════════════════════════════════════════════════════════════
def run(cdp):
    ensure_data_ready(cdp)
    results = []
    for name, fn in (('g0 源码守卫', sub_source_guards),
                     ('g1 IPC 边界探针', sub_ipc_boundary_is_real),
                     ('g2 自动保存落盘', sub_autosave_reaches_file)):
        try:
            ok, detail = fn(cdp)
        except Exception as e:
            ok, detail = False, f'异常: {e}'
        results.append((name, ok, detail))

    failed = [f'{n}: {d}' for n, o, d in results if not o]
    if failed:
        return False, (f'项目保存 IPC 边界 {len(results) - len(failed)}/{len(results)} 子测试通过；失败：\n    '
                       + '\n    '.join(failed))
    return True, ('项目保存 IPC 边界 ' + f'{len(results)}/{len(results)} 全通过 — '
                  + '；'.join(d for _, _, d in results))
