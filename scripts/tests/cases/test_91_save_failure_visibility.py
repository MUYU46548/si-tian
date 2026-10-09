#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 91：保存失败必须**说得出原因**（2026-10-09，暮雨实测反馈）

暮雨原话：「保存失败就是保存失败，我没看到其他内容。只提示红色的保存失败。」

查证出**三个**独立缺陷（不是同一件事）：

  ① **原因在源头就被丢掉**（`geodata.js`）
     `saveStatus='error'` 只表达"失败了"；项目态那条 `syncCanvasToProject` 返回的 `r.error`
     就地丢弃；而且 error 还有 5s TTL 自动回 idle —— 一闪而过等于没提示。

  ② **状态栏只显示了「保存」这件事的一半**（`ScenarioMap.vue`）
     它读 `store.saveStatus`（geodata 侧），而**真正把 .sitian 写进磁盘的是 projectStore**
     （状态写在全局 `useStatusBar` 的 `saveState` 里）。后果：项目落盘失败时这里毫无反应；
     项目态下 geodata 只到 'staged'，这里**永远显示不出「已保存」**。

  ③ 🔴 **`store.saveStatus.value` 恒为 undefined**（真 bug，同一处代码）
     `geodata` 是 Pinia **setup store** → 它 return 的 ref **已被 Pinia 自动解包**
     （同仓反例：`store.slicePoints` 就是普通数组）。所以那个 `span` 的 `:class` 一直是空、
     保存按钮的图标也从不变——这条路径**从来没有反映过真实状态**。

判定：源码闸门（契约）+ CDP 行为（真注入失败态、真读 DOM 文字）。
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json            # noqa: E402
from lib.helpers import ensure_data_ready           # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SM = "document.querySelector('.scenario-map-container')?.__vueParentComponent?.setupState"


def _read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def _code_only(src):
    """剥掉整行注释（`//` `*` `/*` 开头）—— 判据必须只对代码成立。"""
    out = []
    for line in src.split('\n'):
        st = line.strip()
        if st.startswith('//') or st.startswith('*') or st.startswith('/*'):
            continue
        out.append(line)
    return '\n'.join(out)


def source_gates():
    fails, notes = [], []

    g = _code_only(_read('src/renderer/src/store/geodata.js'))
    for needle, label in [
        ("const lastSaveError = ref('')", '失败原因要留在 store 里（不能当场丢）'),
        ('lastSaveError.value = (err && err.message)', 'catch 里记录失败原因'),
        ('lastSaveError.value = r.error', '项目态分支不再丢弃 syncCanvasToProject 的 r.error'),
        ('lastSaveError,', 'lastSaveError 已导出'),
        ("lastSaveError.value = '';", '成功保存时清空（否则失败提示永不消失）'),
    ]:
        if needle not in g:
            fails.append(f'geodata 缺：{label}（`{needle}`）')
    if "if (saveStatus.value === 'error') saveStatus.value = 'idle'" in g:
        fails.append('geodata 的 error 仍有 TTL 自动回 idle（一闪而过 = 没提示）')

    sm = _code_only(_read('src/renderer/src/components/ScenarioMap.vue'))
    for needle, label in [
        ("import { useStatusBarState } from '../composables/useStatusBar'",
         '接全局状态栏（projectStore 的落盘状态在这里）'),
        ('const saveDisplay = computed', '两条保存链合并显示'),
        ('data-testid="scenario-save-status"', '状态栏保存项挂 testid'),
        (':title="saveDisplay.title || saveDisplay.text"', '悬停给完整原因'),
        ("s && s.kind === 'err'", 'saveDisplay 接了 projectStore 的 err'),
        ('unref(store.saveStatus)', '用 unref 读 store（Pinia setup store 会解包 ref）'),
    ]:
        if needle not in sm:
            fails.append(f'ScenarioMap 缺：{label}（`{needle}`）')
    if '> 保存失败</template>' in sm:
        fails.append('状态栏还在用无原因的旧文案「保存失败」')
    if 'store.saveStatus.value' in sm:
        fails.append('ScenarioMap 仍在写 `store.saveStatus.value`（Pinia 已解包 → 恒 undefined）')

    ps = _code_only(_read('src/renderer/src/store/projectStore.js'))
    if 'setSaveState(null);' not in ps:
        fails.append('projectStore 的 TTL 到期没清全局 saveState（底部会永远停在「已保存」）')
    if '`保存失败：${errText' not in ps:
        fails.append('projectStore 的失败文案没有把原因写进 text（只放 title 等于没提示）')

    notes.append('源码闸门 14 项' + ('全过' if not fails else f'缺 {len(fails)} 项'))
    return fails, notes


PROBE_JS = """(() => {
  const sc = __SM__;
  const store = sc.store;
  const sb = sc.sbState;
  const fails = [], notes = {};
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + e + ')' : '')); };
  const read = () => ({ kind: sc.saveDisplay.kind, text: String(sc.saveDisplay.text), title: String(sc.saveDisplay.title || '') });

  // ── 形态探测：Pinia setup store 会 unwrap ref（同仓两种写法都有先例，必须现场确认）──
  const st = store.saveStatus;
  notes.saveStatusShape = (st && typeof st === 'object' && 'value' in st) ? 'ref' : 'unwrapped';
  const setG = (v) => { const x = store.saveStatus; if (x && typeof x === 'object' && 'value' in x) x.value = v; else store.saveStatus = v; };
  const setE = (v) => { const x = store.lastSaveError; if (x && typeof x === 'object' && 'value' in x) x.value = v; else store.lastSaveError = v; };

  sb.saveState = null;
  setG('idle'); setE('');
  notes.baseline = read();
  ok('基线不是错误态', notes.baseline.kind !== 'error', JSON.stringify(notes.baseline));

  // ① 剧本侧失败：原因必须出现在**文字**里（不只 title）
  setE('磁盘被占用（EBUSY）：无法重命名临时文件');
  setG('error');
  const g1 = read();
  notes.geodataErr = g1;
  ok('① 剧本侧失败 → 状态栏变 error', g1.kind === 'error', g1.kind);
  ok('① 文字以「保存失败：」开头', g1.text.indexOf('保存失败：') === 0, g1.text);
  ok('① 失败原因出现在文字里（不是只有四个字）', /EBUSY/.test(g1.text), g1.text);
  ok('① title 给完整原因', /EBUSY/.test(g1.title), g1.title);

  // ② 项目落盘失败优先级更高 —— 那才代表「数据没进磁盘」
  sb.saveState = { kind: 'err', text: '保存失败', title: '写入 E:/x.sitian 失败：EACCES' };
  const g2 = read();
  notes.projectErr = g2;
  ok('② 项目落盘失败时状态栏也是 error', g2.kind === 'error', g2.kind);
  ok('② 项目侧原因压过剧本侧（优先级正确）', /EACCES/.test(g2.text) && !/EBUSY/.test(g2.text), g2.text);

  return JSON.stringify({ fails, notes });
})()"""

READ_DOM_JS = """(() => {
  const el = document.querySelector('[data-testid="scenario-save-status"]');
  if (!el) return JSON.stringify({ fails: ['状态栏没有 scenario-save-status（模板没接上）'] });
  return JSON.stringify({ fails: [], text: el.textContent.trim(), title: el.getAttribute('title') || '' });
})()"""

RESET_JS = """(() => {
  const sc = __SM__;
  const store = sc.store;
  const sb = sc.sbState;
  const setG = (v) => { const x = store.saveStatus; if (x && typeof x === 'object' && 'value' in x) x.value = v; else store.saveStatus = v; };
  const setE = (v) => { const x = store.lastSaveError; if (x && typeof x === 'object' && 'value' in x) x.value = v; else store.lastSaveError = v; };
  sb.saveState = null;
  setG('idle'); setE('');
  return JSON.stringify({ ok: true, kind: sc.saveDisplay.kind });
})()"""


def run(cdp):
    fails = []
    sf, snotes = source_gates()
    fails += sf
    notes = list(snotes)

    ensure_data_ready(cdp)
    r = cdp.eval("""(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('历史剧本'));
      if (!btn) return 'no-btn';
      btn.click();
      return 'ok';
    })()""")
    if r != 'ok':
        return False, f'进入历史剧本失败: {r}'
    try:
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", desc='ScenarioMap 挂载', timeout=20)
    except RuntimeError as e:
        return False, f'ScenarioMap 未挂载：{e}'
    time.sleep(0.8)

    ok, res = eval_json(cdp, PROBE_JS.replace('__SM__', SM))
    if not ok:
        return False, f'探针失败: {res}'
    fails += res.get('fails', [])
    n = res.get('notes', {})

    # DOM 断言：文字必须真的渲染出来（computed 对但模板没接 = 用户照样看不到）
    time.sleep(0.4)
    ok2, dom = eval_json(cdp, READ_DOM_JS)
    if not ok2:
        fails.append(f'读状态栏 DOM 失败：{dom}')
    else:
        fails += dom.get('fails', [])
        n['dom'] = {'text': dom.get('text'), 'title': dom.get('title')}
        if 'EACCES' not in str(dom.get('text', '')):
            fails.append(f'状态栏文字里没有失败原因（DOM 实际：{dom.get("text")}）')

    # 还原（别把后续用例留在错误态）
    eval_json(cdp, RESET_JS.replace('__SM__', SM), required=('ok',))

    notes.append(
        f'store.saveStatus 形态 = {n.get("saveStatusShape")}；'
        f'基线 {json.dumps(n.get("baseline"), ensure_ascii=False)}；'
        f'剧本侧失败 → {json.dumps(n.get("geodataErr"), ensure_ascii=False)}；'
        f'项目侧失败 → {json.dumps(n.get("projectErr"), ensure_ascii=False)}；'
        f'DOM 实际显示「{n.get("dom", {}).get("text")}」'
    )
    return (not fails), ' | '.join(fails) if fails else ' | '.join(notes)
