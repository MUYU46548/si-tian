#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机验收：省份「归属」在右键菜单 + 右上角详情面板里必须看得见，且能改。

判据（全部读真实 DOM / 真实 store，不读源码）：
  f1 右键一个有主的省 → 菜单里出现「归属：<势力名>」；
  f2 点「省份详情…」→ 右上角面板出现「归属」行且显示同一个名字；
  f3 面板「清成无主」→ store 里 ownership 键消失、changeEvents 里落一条 owner=null；
  f4 右键一个无主的省 → 菜单写「无主」；选一个势力色块后点「设为当前势力」→ ownership 写回。

用法：python scripts/tests/diag_province_detail.py（只用工作副本，跑完还原配置）
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))
CDP_PORT = 9226
DEV_PORT = 5180
APP_CFG = os.path.join(os.environ.get('APPDATA', ''), 'SiTian', 'config.json')
OUT = os.path.join(ROOT, 'docs', 'assets', 'diag-province-detail-20261021')

PICK = r"""
(() => {
  const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const sc = sm.selectedScenario;
  if (!sc) return JSON.stringify({ err: 'no-scenario' });
  const rect = sm.canvas.getBoundingClientRect();
  const out = { owned: null, unowned: null, canvas: [Math.round(rect.width), Math.round(rect.height)],
                ownerCount: 0 };
  for (const p of ((sm.baseMap && sm.baseMap.terrain) || [])) {
    if (!p || !p.points || p.points.length < 3 || p.kind === 'sea') continue;
    let sx = 0, sy = 0;
    for (const q of p.points) { sx += q.x; sy += q.y; }
    const cx = sx / p.points.length, cy = sy / p.points.length;
    // 🔴 用**产品自己的口径**找有主/无主：面板显示的就是它，别拿 selectedScenario.ownership 猜
    const pol = sm.ownerPolityForProvince(p.id);
    const item = { id: p.id, name: p.name, world: [cx, cy], ownerName: pol ? pol.name : null,
                   ownerId: pol ? pol.id : null };
    if (pol) { out.ownerCount++; if (!out.owned) out.owned = item; }
    else if (!out.unowned) out.unowned = item;
    if (out.owned && out.unowned) break;
  }
  return JSON.stringify(out);
})()
"""

FOCUS = r"""
(() => {
  const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const rect = sm.canvas.getBoundingClientRect();
  const p = %s;
  sm.cameraScale = 1;
  sm.cameraX = rect.width / 2 - p.world[0];
  sm.cameraY = rect.height / 2 - p.world[1];
  sm.render();
  return JSON.stringify({ at: [Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2)] });
})()
"""

MENU = r"""
(() => {
  const el = document.querySelector('.context-menu');
  return JSON.stringify({ open: !!el, text: el ? el.innerText : '' });
})()
"""

CLICK_DETAIL = r"""
(() => {
  const it = Array.from(document.querySelectorAll('.context-menu .ctx-item'))
    .find(x => (x.textContent || '').includes('省份详情'));
  if (!it) return JSON.stringify({ err: 'no-detail-item' });
  it.click();
  return JSON.stringify({ ok: true });
})()
"""

PANEL = r"""
(() => {
  const el = document.querySelector('.province-props');
  const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  return JSON.stringify({ open: !!el, text: el ? el.innerText : '',
    name: document.querySelector('.props-name') ? document.querySelector('.props-name').value : null,
    selectedId: sm.selectedProvince && sm.selectedProvince.id,
    menuProvId: sm.contextMenu && sm.contextMenu.provId,
    showProps: sm.showProps,
    ownerNow: (sm.selectedProvincePolity && sm.selectedProvincePolity.name) || null });
})()
"""

STATE = r"""
(() => {
  const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const sc = sm.selectedScenario;
  const id = sm.selectedProvince && sm.selectedProvince.id;
  const own = sc && sc.ownership ? sc.ownership[id] : undefined;
  const ev = (sc && sc.changeEvents && sc.changeEvents[id]) || [];
  return JSON.stringify({ id, owner: own === undefined ? null : own,
    events: ev.map(e => ({ y: e.y, m: e.m, d: e.d, owner: e.owner })) });
})()
"""

CLEAR = r"""
(async () => {
  const b = document.querySelector('[data-testid=province-owner-clear]');
  if (!b) return JSON.stringify({ err: 'no-clear-btn' });
  const dis = b.disabled;
  b.click();
  await new Promise(r => setTimeout(r, 120));
  return JSON.stringify({ clicked: true, disabled: dis });
})()
"""

ASSIGN = r"""
(async () => {
  const b = document.querySelector('[data-testid=province-owner-assign]');
  if (!b) return JSON.stringify({ err: 'no-assign-btn' });
  const dis = b.disabled;
  b.click();
  await new Promise(r => setTimeout(r, 120));
  return JSON.stringify({ clicked: true, disabled: dis });
})()
"""


def wait_http(url, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                return r.status < 500
        except Exception:
            time.sleep(0.4)
    return False


def wait_cdp(port=CDP_PORT, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen('http://127.0.0.1:%d/json/version' % port, timeout=1) as r:
                if r.status < 500:
                    return True
        except Exception:
            time.sleep(0.5)
    return False


def free_port(port):
    subprocess.run(['powershell', '-NoProfile', '-Command',
                    "Get-NetTCPConnection -LocalPort %d -ErrorAction SilentlyContinue | "
                    "ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" % port],
                   capture_output=True, timeout=30)


POINT_FOR = r"""
(() => {
  const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const target = %s;
  const p = ((sm.baseMap && sm.baseMap.terrain) || []).find(x => x && x.id === target);
  if (!p || !p.points || p.points.length < 3) return JSON.stringify({ err: 'no-province' });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of p.points) {
    if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
  }
  // 在包围盒里找一点，用**产品自己的命中函数**确认真的落在该省内（凹形也不会点错）
  let hit = null;
  for (let i = 1; i < 20 && !hit; i++) {
    for (let j = 1; j < 20 && !hit; j++) {
      const x = minX + (maxX - minX) * i / 20;
      const y = minY + (maxY - minY) * j / 20;
      if (sm.findProvinceAt(x, y) && sm.findProvinceAt(x, y).id === target) hit = { x, y };
    }
  }
  if (!hit) return JSON.stringify({ err: 'no-interior-point' });
  const rect = sm.canvas.getBoundingClientRect();
  sm.cameraScale = 1;
  sm.cameraX = rect.width / 2 - hit.x;
  sm.cameraY = rect.height / 2 - hit.y;
  sm.render();
  return JSON.stringify({ world: [hit.x, hit.y],
    at: [Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2)] });
})()
"""


OPEN_MENU = r"""
(async () => {
  const cvs = document.querySelector('.scenario-map-container canvas');
  const x = %d, y = %d;
  const ev = new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: 2,
  });
  cvs.dispatchEvent(ev);
  // 🔴 Vue 的 DOM 更新是异步的：同一 tick 里读 `.context-menu` 永远是 null（本项目老坑）
  await new Promise(r => setTimeout(r, 80));
  const el = document.querySelector('.context-menu');
  return JSON.stringify({ open: !!el, text: el ? el.innerText : '', at: [x, y] });
})()
"""


def open_menu(cdp):
    """在画布中心附近找一个能命中省份的点，打开右键菜单。

    ⚠️ 省的**重心**不一定在多边形内（凹形），所以中心打不开就沿网格试一圈；
    每试一次都读真实 DOM，不是"点了就当打开了"。
    """
    rect = json.loads(cdp.eval(
        "(() => { const c = document.querySelector('.scenario-map-container canvas');"
        " const r = c.getBoundingClientRect();"
        " return JSON.stringify([Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]); })()"))
    # 先关掉上一轮可能还开着的菜单（window 上的 click 监听就是它的关闭入口）
    cdp.eval("(() => { document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));"
             " return 'ok'; })()")
    cx, cy = rect
    offsets = [(0, 0)] + [(dx, dy) for dx in (-60, -30, 0, 30, 60) for dy in (-60, -30, 0, 30, 60)
                          if (dx, dy) != (0, 0)]
    for dx, dy in offsets:
        res = json.loads(cdp.eval(OPEN_MENU % (cx + dx, cy + dy)))
        if res.get('open'):
            return res
    return {'open': False, 'text': ''}


def main():
    cfg_text = open(APP_CFG, encoding='utf-8').read()
    cfg = json.loads(cfg_text)
    real = cfg.get('lastProjectPath', '')
    if not real or not os.path.exists(real):
        print('配置里的 lastProjectPath 不存在：%r' % real)
        return 2
    ts = time.strftime('%Y%m%d-%H%M%S')
    bak = os.path.join(ROOT, 'backups', 'diag-province-' + ts)
    os.makedirs(bak, exist_ok=True)
    shutil.copy2(APP_CFG, os.path.join(bak, 'config.json'))
    work = os.path.join(bak, 'work-copy.sitian')
    shutil.copy2(real, work)

    dev = el = None
    try:
        cfg['lastProjectPath'] = work
        with open(APP_CFG, 'w', encoding='utf-8') as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)

        node = shutil.which('node')
        exe = os.path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
        free_port(DEV_PORT)
        dev = subprocess.Popen([node, os.path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
                                '--config', 'vite.config.js'],
                               cwd=ROOT, stdout=open(os.path.join(bak, 'vite.log'), 'w'),
                               stderr=subprocess.STDOUT)
        if not wait_http('http://localhost:%d/' % DEV_PORT):
            print('vite 没起来，看 %s/vite.log' % bak)
            return 1
        free_port(CDP_PORT)
        env = dict(os.environ)
        env['NODE_ENV'] = 'development'
        env.pop('OPEN_DEVTOOLS', None)
        env.pop('ELECTRON_RUN_AS_NODE', None)
        el = subprocess.Popen([exe, '.', '--remote-debugging-port=%d' % CDP_PORT,
                               '--remote-allow-origins=*'],
                              cwd=ROOT, env=env, stdout=open(os.path.join(bak, 'electron.log'), 'w'),
                              stderr=subprocess.STDOUT)
        if not wait_cdp():
            print('electron CDP 没起来，看 %s/electron.log' % bak)
            return 1

        from lib.cdp import CDP, wait_for
        import run_tests as RT
        cdp = CDP(port=CDP_PORT)
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=90, desc='应用挂载')
        RT.apply_viewport(cdp)
        time.sleep(2.0)
        cdp.eval("window.__errs = []; ['warn','error'].forEach(k => { const o = console[k].bind(console);"
                 " console[k] = (...a) => { try { window.__errs.push(k + ': ' + a.map(String).join(' ')); }"
                 " catch (e) {} o(...a); }; }); 'ok'")

        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find(x => (x.textContent || '').includes('历史剧本'));"
                 " if (b) b.click(); return 'ok'; })()")
        time.sleep(1.5)
        cdp.eval("(() => { const c = document.querySelector('.sp-card'); if (c) c.click();"
                 " return c ? 'ok' : 'none'; })()")
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=30, desc='编辑器')
        time.sleep(1.5)
        cdp.eval("(() => { const b = document.querySelector('.recovery-overlay .btn-discard');"
                 " if (b) { b.click(); return 'dismissed'; } return 'none'; })()")
        time.sleep(1.0)

        pick = json.loads(cdp.eval(PICK))
        print('canvas:', pick.get('canvas'), '有主省数:', pick.get('ownerCount'))
        fails = []
        if not pick.get('owned') or not pick.get('unowned'):
            print('找不到 有主/无主 各一个省：', pick)
            return 1
        print('有主省:', pick['owned']['name'], 'id=', pick['owned']['id'], 'owner=', pick['owned']['ownerName'])
        print('无主省:', pick['unowned']['name'], 'id=', pick['unowned']['id'])

        # ── f1/f2：有主省 ───────────────────────────────────────────────
        pos = json.loads(cdp.eval(POINT_FOR % json.dumps(pick['owned']['id'])))
        menu = json.loads(cdp.eval(OPEN_MENU % (pos['at'][0], pos['at'][1])))
        print('\nf1 右键菜单:', menu['text'].replace('\n', ' | '))
        if '归属' not in menu['text']:
            fails.append('f1 菜单里没有「归属」')
        if pick['owned']['ownerName'] and pick['owned']['ownerName'] not in menu['text']:
            fails.append('f1 菜单里的势力名与当前日期归属不一致（期望 %s）' % pick['owned']['ownerName'])
        detail = json.loads(cdp.eval(CLICK_DETAIL))
        time.sleep(0.35)
        panel = json.loads(cdp.eval(PANEL))
        print('f2 详情面板:', panel)
        if '归属' not in panel['text']:
            fails.append('f2 面板里没有「归属」')
        if panel.get('selectedId') != pick['owned']['id']:
            fails.append('f2 点「省份详情…」后选中的不是菜单那个省：%s != %s'
                         % (panel.get('selectedId'), pick['owned']['id']))
        if not panel.get('name'):
            fails.append('f2 面板标题（省名）是空的')
        if pick['owned']['ownerName'] and pick['owned']['ownerName'] not in menu['text'] + panel['text']:
            fails.append('f1/f2 菜单与面板里都找不到当前归属的势力名')

        # ── f3：清成无主 ───────────────────────────────────────────────
        before = json.loads(cdp.eval(STATE))
        res = json.loads(cdp.eval(CLEAR))
        after = json.loads(cdp.eval(STATE))
        print('\nf3 清成无主:', res, 'owner', before['owner'], '->', after['owner'],
              'events尾:', after['events'][-1] if after['events'] else None)
        if res.get('disabled'):
            fails.append('f3 「清成无主」按钮是 disabled')
        if after['owner'] is not None:
            fails.append('f3 点完之后 ownership 还在')
        if not after['events'] or after['events'][-1].get('owner') is not None:
            fails.append('f3 没有落下 owner=null 的易主事件')
        panel_after = json.loads(cdp.eval(PANEL))
        print('f3 清空后面板 ownerNow =', panel_after.get('ownerNow'))
        if panel_after.get('ownerNow') is not None:
            fails.append('f3 清空后详情面板还显示有主（面板没跟着 store 更新）')

        # ── f4：无主省（同一份数据里找一个真的无主的）───────────────────
        pos2 = json.loads(cdp.eval(POINT_FOR % json.dumps(pick['unowned']['id'])))
        menu2 = json.loads(cdp.eval(OPEN_MENU % (pos2['at'][0], pos2['at'][1])))
        print('\nf4 无主省右键:', menu2['text'].replace('\n', ' | '))
        if '无主' not in menu2['text']:
            fails.append('f4 无主省的菜单没有写「无主」')
        cdp.eval(CLICK_DETAIL)
        time.sleep(0.35)
        panel2 = json.loads(cdp.eval(PANEL))
        print('f4 无主省详情:', panel2)
        if '无主' not in panel2['text']:
            fails.append('f4 无主省详情没有写「无主」')
        # 选第一个势力色块 → 设为当前势力
        cdp.eval("(() => { const b = document.querySelector('.polity-swatch:not(.clear)');"
                 " if (b) b.click(); return b ? 'ok' : 'none'; })()")
        time.sleep(0.3)
        res2 = json.loads(cdp.eval(ASSIGN))
        after2 = json.loads(cdp.eval(STATE))
        print('f4 设为当前势力:', res2, '→ owner =', after2['owner'])
        if res2.get('disabled'):
            fails.append('f4 「设为当前势力」按钮是 disabled（选了色块之后）')
        if not after2['owner']:
            fails.append('f4 点完之后 ownership 还是空')

        os.makedirs(OUT, exist_ok=True)
        with open(os.path.join(OUT, 'result.json'), 'w', encoding='utf-8') as f:
            json.dump({'menu': menu['text'], 'panel': panel['text'],
                       'menu_none': menu2['text'], 'panel_none': panel2['text'],
                       'before': before, 'after': after, 'after2': after2, 'fails': fails},
                      f, ensure_ascii=False, indent=1)
        print('\n==== ' + ('PASS' if not fails else 'FAIL') + ' ====')
        for x in fails:
            print(' -', x)
        print('console warn/error:', cdp.eval("JSON.stringify((window.__errs || []).slice(-8))"))
        return 0 if not fails else 1
    finally:
        if el is not None:
            subprocess.run(['taskkill', '/PID', str(el.pid), '/T', '/F'], capture_output=True)
        if dev is not None:
            subprocess.run(['taskkill', '/PID', str(dev.pid), '/T', '/F'], capture_output=True)
        with open(APP_CFG, 'w', encoding='utf-8') as f:
            f.write(cfg_text)
        print('已还原配置')


if __name__ == '__main__':
    sys.exit(main())
