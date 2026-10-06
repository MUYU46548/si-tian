#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 83：免责声明（首启强制确认 + 随时可查 + UI 基座试点）

来源：`docs/PROPOSAL_DISCLAIMER_AND_UI.md` 方案 A（2026-10-06 定稿落地）。
  ① 条款 13 节，**保留未成年人条款**（暮雨拍板）；
  ② 首启强制确认：滚到底才可勾选 / Esc 不关 / 点遮罩不关 / 「不同意并退出」；
  ③ 「关于 → 免责声明」随时可查，条款升版本后再次要求确认；
  ④ 试点 UI 基座：Tailwind utilities-only（不引 preflight）+ shadcn-vue Button/Dialog/Card。

本用例覆盖：
  g0 源码守卫：preflight 缺席（R1/R2 的根因）、Dialog 就地渲染不 teleport（R7）、
     aria-modal + trapFocus 显式传参、App 挂点在 loadGeodata 之前、引导层守卫、
     harness 基线已播种 ack（否则几十个用例会被阻断层一起挡住）。
  g1 首启阻断：清掉 ack 重载 → 弹窗出现 / role+aria-modal 正确 / 勾选框禁用 /
     未勾选不能同意 / 阻断态没有「关闭」/ 新手引导不同屏。
  g2 强制模式不可绕过：Esc 按下去不关；点遮罩不关。
  g3 滚到底才解锁 → 勾选 → 同意 → 弹窗关闭 + ack 落到 localStorage（ISO 时间戳）。
  g4 已确认后重载不再弹（版本化 ack 真的生效）。
  g5 随时可查：F1 关于面板 → 入口存在 → 点开查看模式（无门槛、有「关闭」）→ Esc 可关。
"""

import io
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for, eval_json  # noqa: E402
from lib.helpers import ensure_data_ready  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
DISCLAIMER_SRC = os.path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'disclaimer.js')
SKIP_FLAG = '__sitian_skip_disclaimer_seed'


def _read(rel):
    return io.open(os.path.join(ROOT, rel), encoding='utf-8').read()


def _code_only(src):
    """剥掉注释后再判子串 —— 本仓四次踩到「注释里的字样被当成实现」。"""
    src = re.sub(r'<!--.*?-->', '', src, flags=re.S)
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    return re.sub(r'(?m)//[^\n]*', '', src)


def ack_key_js():
    """从产品源码解析 ack 键（前缀 + 版本）—— 不在这里写死，见 run_tests.py 同款说明。"""
    src = io.open(DISCLAIMER_SRC, encoding='utf-8').read()
    pre = re.search(r'DISCLAIMER_ACK_KEY\s*=\s*`([^`$]*)\$\{DISCLAIMER_VERSION\}`', src)
    ver = re.search(r"DISCLAIMER_VERSION\s*=\s*'([^']+)'", src)
    assert pre and ver, ' 无法从 disclaimer.js 解析出 ack 键（源码结构变了？）'
    return "'%s' + '%s'" % (pre.group(1), ver.group(1))


# ══════════════════════════════════════════════════════════════════
# g0 源码守卫
# ══════════════════════════════════════════════════════════════════
def sub_source_guards(cdp):
    bad = []

    # ① preflight 必须缺席（R1/R2 的根因）。三个地方都要对：
    #    配置里 corePlugins.preflight=false、CSS 入口没有 @tailwind base/components、
    #    也没有偷偷用 `*` 选择器把复位请回来。
    cfg = _code_only(_read('tailwind.config.js'))
    if 'preflight: false' not in cfg:
        bad.append('tailwind.config.js 没关 preflight（会直接打坏 Markdown 列表与全局行高）')
    # ⚠️ 必须**先剥注释**：本文件头部注释里就写着「绝不加 @tailwind base」以及
    #    `ol,ul{list-style:none}` 的解释 —— 不剥注释，守卫会被自己的注释判红（首版实测）。
    css = _code_only(_read('src/renderer/src/assets/tailwind.css'))
    if '@tailwind base' in css or '@tailwind components' in css:
        bad.append('tailwind.css 里出现了 @tailwind base/components（preflight 会进来）')
    if 'list-style:none' in css.replace(' ', ''):
        bad.append('tailwind.css 里出现了 list-style:none 复位')
    if re.search(r'^\s*\*\s*,\s*::?before', css, flags=re.M):
        bad.append('tailwind.css 里出现了 `*, ::before` 通配复位（等于把 preflight 从后门请回来）')

    # ② Dialog 必须**就地渲染**（R7）：`.theme-*` 是 App 的 scoped 规则，
    #    teleport 到 body 就拿不到 --ui-* 变量 → 组件无色。
    dlg_ui = _code_only(_read('src/renderer/src/components/ui/dialog/DialogContent.vue'))
    if 'DialogPortal' in dlg_ui:
        bad.append('ui/dialog/DialogContent.vue 用了 DialogPortal（teleport 后拿不到司天 token，R7）')
    dd = _code_only(_read('src/renderer/src/components/DisclaimerDialog.vue'))
    if 'DialogPortal' in dd:
        bad.append('DisclaimerDialog.vue 用了 DialogPortal')

    # ③ 真锁模态的两条硬要求：aria-modal 与 trapFocus 必须显式出现
    if 'aria-modal="true"' not in dlg_ui:
        bad.append('DialogContent 没有 aria-modal="true"（reka-ui 只给 role=dialog，本仓此前 0 处）')
    if 'trap-focus' not in dlg_ui:
        bad.append('DialogContent 没有显式传 trap-focus（reka-ui 的 trapFocus 无默认值 → 不传就没有焦点陷阱）')

    # ④ App 挂点顺序：阻断必须在 loadGeodata 之前（否则 splash 淡出后闪一下主界面）
    app = _code_only(_read('src/renderer/src/App.vue'))
    i_ack = app.find('hasAckedDisclaimer()')
    i_load = app.find('await store.loadGeodata();')
    if i_ack < 0:
        bad.append('App.vue 没有调用 hasAckedDisclaimer()（首启阻断没接上）')
    elif i_load > 0 and i_ack > i_load:
        bad.append('App.vue 里免责声明判定在 loadGeodata 之后（首帧会闪一下主界面）')
    if 'isDisclaimerGateOpen' not in app:
        bad.append('App.vue 没有阻断态开关（Esc/F1 吞不掉）')
    if ':dismiss-on-escape="!isGate"' not in dd:
        bad.append('DisclaimerDialog 没把 Esc 关闭关掉（强制模式必须关不了）')

    # ⑤ 引导层守卫：两层浮层同屏 = 声明被盖住
    ob = _code_only(_read('src/renderer/src/components/OnboardingGuide.vue'))
    if '__sitianDisclaimerGate' not in ob:
        bad.append('OnboardingGuide 没有守卫（会与免责声明同屏抢屏）')

    # ⑥ 模板里的挂载位置必须在 .app-layout 内
    if '<disclaimer-dialog' not in app:
        bad.append('App.vue 模板里没有挂 disclaimer-dialog')
    else:
        i_tpl = app.find('<disclaimer-dialog')
        # 🔴 必须 rfind：App.vue 有多处内联 `<template v-if>`，find('</template>') 会命中
        #    工具栏下拉那处（第 45 行左右），把正常挂载点误判成「在模板外」（首版实测踩到）。
        i_end = app.rfind('</template>')
        if not (0 < i_tpl < i_end):
            bad.append('disclaimer-dialog 不在模板内')

    # ⑦ harness 必须播种 ack（否则全部用例被阻断层挡住 → "一起红"的假失败）
    rt = _read('scripts/tests/run_tests.py')
    if '__sitian_skip_disclaimer_seed' not in rt or 'disclaimer_ack_key_expr' not in rt:
        bad.append('run_tests.py 没有播种免责声明 ack（基线会被首启阻断层挡住）')
    if 'io.open(DISCLAIMER_SRC' in rt:
        bad.append('run_tests.py 用了未 import 的 io.open（异常会被 except 吞成 None → 播种静默失效）')

    # ⑧ 文案与组件分离
    if 'DISCLAIMER_FULL' not in dd:
        bad.append('DisclaimerDialog 没从 utils/disclaimer.js 取文案（文案应单一事实源）')

    if bad:
        return False, '源码守卫失败：' + '；'.join(bad)
    return True, ('preflight 缺席 + Dialog 不 teleport + aria-modal/trapFocus 显式 + '
                  '挂点在 loadGeodata 前 + 引导守卫 + harness 播种 ack + 文案单一事实源')


# ══════════════════════════════════════════════════════════════════
# 工具
# ══════════════════════════════════════════════════════════════════
def _viewport(cdp):
    try:
        cdp.send('Emulation.setDeviceMetricsOverride', {
            'width': 1280, 'height': 800, 'deviceScaleFactor': 1, 'mobile': False,
        })
    except Exception:
        pass


def _reload(cdp, timeout=30):
    """重载页面并重设回归视口（override 绑在 page target 上，重载后要重下）。"""
    cdp.navigate()
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='重载', timeout=timeout)
    _viewport(cdp)
    time.sleep(0.5)


DIALOG = "document.querySelector('[data-testid=\\'disclaimer-dialog\\']')"


def _dialog_open(cdp):
    return bool(cdp.eval(f'!!{DIALOG}'))


def _wait_dialog(cdp, want=True, timeout=12):
    wait_for(cdp, f'{"!!" if want else "!"}{DIALOG}', desc=f'免责声明{"出现" if want else "关闭"}',
             timeout=timeout)


# ══════════════════════════════════════════════════════════════════
# g1 首启阻断
# ══════════════════════════════════════════════════════════════════
G1_JS = r"""(() => {
  const fails = [];
  const q = (s) => document.querySelector(s);
  const dlg = q('[data-testid="disclaimer-dialog"]');
  if (!dlg) return JSON.stringify({ fails: ['清掉 ack 重载后，首启免责声明没有弹出'] });
  if (dlg.getAttribute('role') !== 'dialog') fails.push('缺少 role=dialog');
  if (dlg.getAttribute('aria-modal') !== 'true') fails.push('缺少 aria-modal=true（真锁模态的硬指标）');

  const cb = q('[data-testid="disclaimer-ack-checkbox"]');
  if (!cb) fails.push('缺勾选框');
  else if (!cb.disabled) fails.push('还没滚到底，勾选框却是可用的');

  const hint = q('[data-testid="disclaimer-gate-hint"]');
  if (!hint || !/滚动/.test(hint.textContent || '')) fails.push('缺少「请滚动阅读完整条款」提示');

  const acc = q('[data-testid="disclaimer-accept"]');
  if (!acc) fails.push('缺「同意并继续」按钮');
  else if (!acc.disabled) fails.push('还没勾选就能点「同意并继续」');

  if (!q('[data-testid="disclaimer-decline"]')) fails.push('缺「不同意并退出」按钮');
  if (q('[data-testid="disclaimer-close"]')) fails.push('阻断态不应出现「关闭」按钮（可绕过确认）');
  if (q('.onboarding-overlay')) fails.push('新手引导与免责声明同屏（声明会被盖住）');

  // 13 节都渲染出来了
  const secs = document.querySelectorAll('[data-testid^="disclaimer-section-"]').length;
  if (secs !== 13) fails.push(`只渲染了 ${secs} 节条款（应为 13）`);

  // 焦点应被陷阱落在弹窗内
  const ae = document.activeElement;
  if (!ae || !dlg.contains(ae)) fails.push('初始焦点不在弹窗内（焦点陷阱没生效）');

  return JSON.stringify({ fails, secs });
})()"""


def sub_gate_blocks(cdp):
    cdp.eval("sessionStorage.setItem('%s', '1'); localStorage.removeItem(%s); 'ok'" % (SKIP_FLAG, ack_key_js()))
    _reload(cdp)
    _wait_dialog(cdp, True)
    time.sleep(0.4)
    ok, res = eval_json(cdp, G1_JS, desc='首启阻断断言', required=('fails',))
    if not ok:
        return False, res
    if res['fails']:
        return False, '首启阻断断言失败：' + '；'.join(res['fails'])
    return True, f"弹窗阻断 + role=dialog / aria-modal=true + 勾选框禁用 + 13 节渲染 + 焦点在弹窗内"


# ══════════════════════════════════════════════════════════════════
# g2 强制模式不可绕过（Esc / 点遮罩）
# ══════════════════════════════════════════════════════════════════
def sub_cannot_bypass(cdp):
    # Esc：App 的全局 Escape 会 closeAll，reka 的 DismissableLayer 会 dismiss —— 两条都必须在阻断态被按住
    cdp.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape',"
             " keyCode: 27, which: 27, bubbles: true, cancelable: true })); 'ok'")
    time.sleep(0.5)
    if not _dialog_open(cdp):
        return False, '按 Esc 把强制模式的免责声明关掉了（知情同意的证据链断了）'

    # 点遮罩：DismissableLayer 的 pointerdown-outside
    cdp.eval("""(() => {
      const body = document.body;
      for (const t of ['pointerdown', 'pointerup', 'click']) {
        body.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, composed: true,
                                                 pointerType: 'mouse', button: 0 }));
      }
      return 'ok';
    })()""")
    time.sleep(0.5)
    if not _dialog_open(cdp):
        return False, '点遮罩把强制模式的免责声明关掉了'

    # 也不能靠 closeAll / 关面板把阻断层带走
    cdp.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 'ok'")
    time.sleep(0.4)
    if not _dialog_open(cdp):
        return False, '全局 Escape 仍能绕过阻断层'
    return True, 'Esc / 点遮罩 / 全局 Escape 三条路径都关不掉阻断态弹窗'


# ══════════════════════════════════════════════════════════════════
# g3 滚到底 → 勾选 → 同意
# ══════════════════════════════════════════════════════════════════
def sub_scroll_then_accept(cdp):
    key = ack_key_js()
    expr = """(async () => {
      const fails = [];
      const q = (s) => document.querySelector(s);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const sc = q('[data-testid="disclaimer-scroll"]');
      if (!sc) return JSON.stringify({ fails: ['缺滚动容器'] });

      // ① 先只滚一半 —— 不该解锁（"滚到底才可勾选"必须真的按比例判，不能一滚就解锁）
      sc.scrollTop = Math.max(0, Math.floor((sc.scrollHeight - sc.clientHeight) * 0.5));
      sc.dispatchEvent(new Event('scroll'));
      await wait(200);
      let cb = q('[data-testid="disclaimer-ack-checkbox"]');
      if (cb && !cb.disabled) fails.push('只滚到一半就解锁了勾选框（门槛形同虚设）');

      // ② 滚到底 → 解锁
      sc.scrollTop = sc.scrollHeight;
      sc.dispatchEvent(new Event('scroll'));
      await wait(250);
      cb = q('[data-testid="disclaimer-ack-checkbox"]');
      if (!cb) return JSON.stringify({ fails: fails.concat('勾选框消失') });
      if (cb.disabled) {
        fails.push('滚到底后勾选框仍被禁用（readPercent='
          + (q('[data-testid="disclaimer-gate-hint"]') || {}).textContent + '）');
      }

      // ③ 勾选 → 「同意并继续」应解锁
      cb.click();
      await wait(250);
      const acc = q('[data-testid="disclaimer-accept"]');
      if (!acc) return JSON.stringify({ fails: fails.concat('同意按钮消失') });
      if (acc.disabled) fails.push('勾选后「同意并继续」仍禁用');

      // ④ 点同意
      acc.click();
      await wait(500);
      if (q('[data-testid="disclaimer-dialog"]')) fails.push('点了同意弹窗却没关');

      // ⑤ ack 落到 localStorage（ISO 时间戳）
      let raw = null;
      try { raw = localStorage.getItem(%s); } catch (e) { fails.push('读 localStorage 抛错：' + e.message); }
      if (!raw) fails.push('同意后没有写入 ack（下次启动还会弹）');
      else if (Number.isNaN(new Date(raw).getTime())) fails.push('ack 不是合法 ISO 时间戳：' + raw);

      return JSON.stringify({ fails, ack: raw });
    })()""" % key
    ok, res = eval_json(cdp, expr, desc='滚到底-勾选-同意', required=('fails',))
    if not ok:
        return False, res
    if res['fails']:
        return False, '滚到底-勾选-同意断言失败：' + '；'.join(res['fails'])
    return True, f"半程不解锁 / 滚到底解锁 / 勾选后可同意 / 关闭 + ack={res.get('ack')}"


# ══════════════════════════════════════════════════════════════════
# g4 已确认后重载不再弹
# ══════════════════════════════════════════════════════════════════
def sub_no_regate(cdp):
    # 注意：跳过种子开关仍开着 → 页面不会重新播种 ack，所以这里测的正是「产品写下的 ack 生效」
    _reload(cdp)
    ensure_data_ready(cdp)
    time.sleep(1.2)   # 异步组件 chunk 可能稍晚挂载；给足时间再判「没弹」
    if _dialog_open(cdp):
        return False, '已确认后重载仍然弹出了免责声明（ack 没生效）'
    # 反证：把 ack 删掉再重载 → 必须重新弹（证明上面的"没弹"不是断言空转）
    cdp.eval("localStorage.removeItem(%s); 'ok'" % ack_key_js())
    _reload(cdp)
    _wait_dialog(cdp, True, timeout=15)
    return True, '已确认→重载不弹；删掉 ack→重载立刻重弹（反证成立，非空转）'


# ══════════════════════════════════════════════════════════════════
# g5 随时可查（关于面板入口 + 查看模式）
# ══════════════════════════════════════════════════════════════════
def sub_view_mode(cdp):
    # 此时阻断层还开着（g4 末尾把 ack 删了）→ 先同意，回到正常界面
    cdp.eval("""(async () => {
      const q = (s) => document.querySelector(s);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const sc = q('[data-testid="disclaimer-scroll"]');
      if (sc) { sc.scrollTop = sc.scrollHeight; sc.dispatchEvent(new Event('scroll')); await wait(250); }
      const cb = q('[data-testid="disclaimer-ack-checkbox"]');
      if (cb && !cb.disabled) cb.click();
      await wait(200);
      const acc = q('[data-testid="disclaimer-accept"]');
      if (acc && !acc.disabled) acc.click();
      await wait(400);
      return 'ok';
    })()""")
    _wait_dialog(cdp, False)

    # F1 打开关于面板
    cdp.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F1', code: 'F1', keyCode: 112,"
             " which: 112, bubbles: true, cancelable: true })); 'ok'")
    wait_for(cdp, "!!document.querySelector('.about-overlay')", desc='关于面板打开', timeout=8)
    time.sleep(0.5)

    ok, res = eval_json(cdp, """(() => {
      const fails = [];
      const q = (s) => document.querySelector(s);
      const btn = q('[data-testid="about-open-disclaimer"]');
      if (!btn) return JSON.stringify({ fails: ['关于面板里没有免责声明入口'] });
      // shadcn Button 落地的证据：确实带上了 tailwind 工具类
      if (!/inline-flex/.test(btn.className || '')) fails.push('入口按钮不是 shadcn-vue Button（没有工具类）');
      const st = q('[data-testid="about-disclaimer-state"]');
      if (!st) fails.push('缺"当前确认状态"文本');
      else if (!/v\\d+\\.\\d+\\.\\d+/.test(st.textContent || '')) {
        fails.push('确认状态没带条款版本号：' + st.textContent);
      }
      btn.click();
      return JSON.stringify({ fails, state: st ? st.textContent : '' });
    })()""", desc='关于面板入口', required=('fails',))
    if not ok:
        return False, res
    if res['fails']:
        return False, '关于面板入口断言失败：' + '；'.join(res['fails'])

    _wait_dialog(cdp, True)
    time.sleep(0.4)
    ok2, res2 = eval_json(cdp, """(() => {
      const fails = [];
      const q = (s) => document.querySelector(s);
      const dlg = q('[data-testid="disclaimer-dialog"]');
      if (!dlg) return JSON.stringify({ fails: ['点了入口没打开弹窗'] });
      if (!q('[data-testid="disclaimer-close"]')) fails.push('查看模式缺「关闭」按钮');
      if (q('[data-testid="disclaimer-ack-checkbox"]')) fails.push('查看模式不该出现勾选框（已确认过的条款不必再勾）');
      if (q('[data-testid="disclaimer-scroll"]')) {
        // 查看模式仍有全文可读
        if (document.querySelectorAll('[data-testid^="disclaimer-section-"]').length !== 13) {
          fails.push('查看模式没渲染 13 节');
        }
      }
      return JSON.stringify({ fails });
    })()""", desc='查看模式', required=('fails',))
    if not ok2:
        return False, res2
    if res2['fails']:
        return False, '查看模式断言失败：' + '；'.join(res2['fails'])

    # 查看模式 Esc 应可关（与强制模式相反 —— 这是"两种模式必须有区别"的正面证据）
    cdp.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape',"
             " keyCode: 27, which: 27, bubbles: true, cancelable: true })); 'ok'")
    time.sleep(0.6)
    if _dialog_open(cdp):
        return False, '查看模式按 Esc 关不掉（与强制模式都不可关 = 两种模式没区别）'
    cdp.eval("(() => { const b = document.querySelector('.about-overlay .close-btn'); if (b) b.click(); return 'ok'; })()")
    return True, f"关于面板入口（{res.get('state')}）+ 查看模式带关闭 / 无勾选框 / Esc 可关（与强制模式相反）"


# ══════════════════════════════════════════════════════════════════
def run(cdp):
    ensure_data_ready(cdp)
    try:
        results = []
        for name, fn in (('g0 源码守卫', sub_source_guards),
                         ('g1 首启阻断', sub_gate_blocks),
                         ('g2 不可绕过', sub_cannot_bypass),
                         ('g3 滚到底→同意', sub_scroll_then_accept),
                         ('g4 不再重弹', sub_no_regate),
                         ('g5 随时可查', sub_view_mode)):
            try:
                ok, detail = fn(cdp)
            except Exception as e:
                ok, detail = False, f'异常: {e}'
            results.append((name, ok, detail))
    finally:
        # 🔴 必须清干净：跳过种子开关存在 sessionStorage 里，跨导航存活 ——
        #    不清掉的话，**后面每个用例**都会在未确认状态下启动、被阻断层挡住（一起红）。
        try:
            cdp.eval("sessionStorage.removeItem('%s');"
                     " try { localStorage.setItem(%s, '2026-01-01T00:00:00.000Z'); } catch (e) {} 'ok'"
                     % (SKIP_FLAG, ack_key_js()))
        except Exception:
            pass

    failed = [f'{n}: {d}' for n, o, d in results if not o]
    if failed:
        return False, (f'免责声明 {len(results) - len(failed)}/{len(results)} 子测试通过；失败：\n    '
                       + '\n    '.join(failed))
    return True, ('免责声明 ' + f'{len(results)}/{len(results)} 全通过 — '
                  + '；'.join(d for _, _, d in results))
