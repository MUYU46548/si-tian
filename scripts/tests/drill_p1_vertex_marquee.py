#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""P1 顶点编辑「共边联动」在**真实 415 省项目**上的演练（2026-10-13）

为什么必须跑真实数据（而不是再加一个合成用例）：
  方案甲（拖动共边顶点时邻省同位顶点跟着走）的**全部前提**是「相邻省的共边顶点坐标逐位相同」。
  这个前提在网格派生 / 骨架吸附的省份上由构造保证，但暮雨那张 `desite` 底图的省份来自
  **FMG `.map` 的 SVG 路径** —— 相邻两省的共边到底是不是"同一批坐标"，只有量了才知道。
  如果量出来不是（比如差 1e-6 级或压根各画各的），那么这套功能在他真实地图上**根本不生效**，
  必须先告诉他，而不是等他自己拖一下发现"邻省没动"。

另外两条也只有真实规模才试得出来：
  · 415 省 / 2.6 万顶点上建共边索引 + 框选 + 拖动的**耗时**（帧预算）；
  · 拖动之后**其它 414 个省逐点未动**（"不串省"的字面验收）。

跑法：python scripts/tests/drill_p1_vertex_marquee.py
前置：5180/9222 空闲、无 index.html.bak（有别的回归在跑时**不许**启动 —— free_port 会把它打死）。
全程只读真实项目文件；改动全在仓库内，跑完还原。
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))
from lib.cdp import CDP, eval_json, wait_for                      # noqa: E402
from lib.helpers import ensure_data_ready, open_harness_project    # noqa: E402
import run_tests as rt                                            # noqa: E402

# 复用 P0 演练里已经写好、且已被验证过的那几段（**不复制**：两份实现迟早漂移）
_spec = importlib.util.spec_from_file_location(
    'drill_p0_first_map', os.path.join(ROOT, 'scripts', 'tests', 'drill_p0_first_map.py'))
p0 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(p0)

OUT_DIR = os.path.join(ROOT, 'build', 'p1-vertex-marquee')
REPORT = {'checks': [], 'notes': {}}


def ck(name, ok, detail=''):
    REPORT['checks'].append({'name': name, 'ok': bool(ok), 'detail': str(detail)})
    print(('  ✅ ' if ok else '  ❌ ') + name + (('  — ' + str(detail)) if detail else ''), flush=True)
    return bool(ok)


PROBE_JS = r""" (async () => {
  const s = __STORE__, sc = __SM__;
  const fails = [], notes = {};
  const ok = (l, c, e) => { if (!c) fails.push(l + (e !== undefined ? ' (' + JSON.stringify(e) + ')' : '')); };
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
  const V = await import('/src/utils/vertexSharing.js');
  const PShape = await import('/src/utils/provinceShape.js');
  const pts = (p, ringIdx) => {
    const rings = PShape.provinceRings(p);
    const r = rings[ringIdx] || rings[0];
    return (r && r.points) || [];
  };
  const flat = (terrain) => terrain.map((p) => (p.points || []).map((q) => [q.x, q.y]));

  // 压叠闸门会弹窗 → headless 卡死。本演练只量"共边配对 + 联动 + 不串省"，一律放行并计数。
  window.__p1 = { confirmCalls: 0 };
  window.confirm = () => { window.__p1.confirmCalls++; return true; };

  const KEY = __KEY__;
  // 🔴 每次写入都会换 terrain **数组**（setTerrain / updateProvincesBatch 都造新数组）——
  //    首版把 `terrain` 缓存成常量，拖完还去读旧数组，于是"拖动确实改了数据"永远判否（假红）。
  const T = () => s.baseMaps[KEY].terrain;
  const terrain = T();

  // ── 1. 前提核查：真实数据里"两个省的顶点落在同一坐标"到底存不存在 ────────
  const t0 = performance.now();
  const built = V.buildCoincidentIndex(terrain);
  const buildMs = performance.now() - t0;
  const hist = {};
  let sharedClusters = 0, exactClusters = 0;
  for (const arr of built.index.values()) {
    if (arr.length < 2) continue;
    sharedClusters++;
    const xs = arr.map((h) => h.x), ys = arr.map((h) => h.y);
    if (Math.max(...xs) - Math.min(...xs) === 0 && Math.max(...ys) - Math.min(...ys) === 0) exactClusters++;
    hist[arr.length] = (hist[arr.length] || 0) + 1;
  }
  notes.index = { total: built.total, shared: built.shared, buildMs: Math.round(buildMs * 10) / 10,
                  sharedClusters, exactClusters, clustersBySize: hist };

  // ── 2. 挑一个"活动环上有最多共边顶点"的真实省份 ────────────────────────
  let best = null;
  terrain.forEach((prov, provIdx) => {
    const ring = pts(prov, 0);
    if (ring.length < 3) return;
    let n = 0;
    for (let i = 0; i < ring.length; i++) {
      const key = V.vertexKey(ring.points ? 0 : 0, 0);   // 占位（下面用真实坐标重建）
      const k2 = V.vertexKey(ring[i].x, ring[i].y);
      const arr = built.index.get(k2) || [];
      if (arr.some((h) => h.provIdx !== provIdx)) n++;
    }
    if (n >= 2 && (!best || n > best.n)) best = { provIdx, n };
  });
  if (!best) return JSON.stringify({ fails: ['真实数据里找不到"与邻省共边 ≥2 个顶点"的省份 —— 方案甲的前提不成立'], notes });

  const refProv = terrain[best.provIdx];
  const ringPts = pts(refProv, 0);
  const sel = [];
  const keyOf = [];
  for (let i = 0; i < ringPts.length; i++) {
    const k = V.vertexKey(ringPts[i].x, ringPts[i].y);
    const arr = built.index.get(k) || [];
    if (arr.some((h) => h.provIdx !== best.provIdx)) { sel.push(i); keyOf.push(k); }
  }
  const found = V.findLinkedVertices(terrain, { provIdx: best.provIdx, ringIdx: 0 }, sel, built);
  notes.probe = { provId: refProv.id, provName: refProv.name, vertices: ringPts.length,
                  coincident: sel.length, links: found.links.length, linkedProvs: found.provinces.length };
  ok('共边顶点数 ≥ 2', sel.length >= 2, sel.length);
  ok('配对到的同位顶点数 ≥ 2', found.links.length >= 2, found.links.length);

  // ── 3. 框选这批共边顶点 → 拖动（走组件真实入口）────────────────────────
  sc.setTool('vertex');
  sc.selectedProvince = { id: refProv.id };
  sc.activeRingIdx = 0;
  sc.snapToGridEnabled = false;
  sc.snapToEdgeEnabled = false;
  await tick(80);
  sc.vertexSelection = sel.slice();     // 等价于 Shift+框选（手势本身另有 CDP 用例守）

  const before = JSON.stringify(flat(T()));
  const beforeById = new Map(T().map((p) => [p.id, JSON.stringify((p.points || []).map((q) => [q.x, q.y]))]));
  const areaBefore = T().reduce((a, p) => a + PShape.provinceNetArea(p), 0);

  const cv = document.querySelector('.scenario-map-container canvas');
  const rect = cv.getBoundingClientRect();
  const S = (w) => ({ cx: rect.left + w.x * sc.cameraScale + sc.cameraX, cy: rect.top + w.y * sc.cameraScale + sc.cameraY });
  const ev = (t, pt) => new MouseEvent(t, { clientX: pt.cx, clientY: pt.cy, button: 0, bubbles: true, cancelable: true });
  const grab = ringPts[sel[Math.floor(sel.length / 2)]];
  const bb = PShape.provinceBBox(refProv);
  const cx0 = (bb.minX + bb.maxX) / 2, cy0 = (bb.minY + bb.maxY) / 2;
  const inward = { x: grab.x + (cx0 - grab.x) * 0.02, y: grab.y + (cy0 - grab.y) * 0.02 };
  sc.activeVertexIdx = -1;
  const t1 = performance.now();
  cv.dispatchEvent(ev('mousedown', S(grab)));
  cv.dispatchEvent(ev('mousemove', S(inward)));
  cv.dispatchEvent(ev('mouseup', S(inward)));
  await tick(150);
  const dragMs = performance.now() - t1;

  // ── 4. 判据 ────────────────────────────────────────────────────────────
  const after = JSON.stringify(flat(T()));
  ok('拖动确实改了数据', after !== before);
  const movedIds = T().filter((p) => JSON.stringify((p.points || []).map((q) => [q.x, q.y])) !== beforeById.get(p.id)).map((p) => p.id);
  notes.movedProvinces = movedIds.length;
  notes.movedIds = movedIds.slice(0, 8);
  ok('联动省份数 > 1（目标省 + 至少一个邻省）', movedIds.length > 1, movedIds.length);
  ok('🔴 不串省：联动省份数远小于 415（动的只是贴着的那几家）', movedIds.length < 12, movedIds.length);

  // 共边对：真实数据的共享顶点**本来就不是逐位相同**（实测差 ~1e-12，SVG 解析/JSON 往返的尾差），
  // 所以判据不能写"=== 相等"（那是对数据不成立的要求），而要写**"缝没有变大"**：
  //   拖后残差 ≤ max(拖前残差 × 2, 1e-9) —— 1e-9 相对这张 ~600 单位的图是 1e-12 个图宽，
  //   几何上等于零；真正要防的是"缝随拖动越拉越大"。
  const pairs = [];
  for (const l of found.links) {
    const a = pts(T()[best.provIdx], 0)[l.srcVertexIdx];
    const b = pts(T()[l.provIdx], l.ringIdx)[l.vertexIdx];
    const a0 = pts(refProv, 0)[l.srcVertexIdx];
    const b0 = pts(terrain[l.provIdx], l.ringIdx)[l.vertexIdx];
    if (!a || !b || !a0 || !b0) { pairs.push({ missing: l }); continue; }
    const res0 = Math.hypot(a0.x - b0.x, a0.y - b0.y);
    const res1 = Math.hypot(a.x - b.x, a.y - b.y);
    pairs.push({ ref: l.srcVertexIdx, link: l.vertexIdx, res0, res1 });
  }
  notes.pairs = { count: pairs.length, maxResBefore: Math.max.apply(null, pairs.map((p) => p.res0 || 0)),
                  maxResAfter: Math.max.apply(null, pairs.map((p) => p.res1 || 0)) };
  const leaky = pairs.filter((p) => p.res1 === undefined || p.res1 > Math.max((p.res0 || 0) * 2, 1e-9));
  ok('🔴 每一对共边顶点的"缝"都没有变大（真实数据实测：残差 ≤ 1e-9 世界单位）',
     leaky.length === 0, leaky.slice(0, 3));

  const areaAfter = T().reduce((a, p) => a + PShape.provinceNetArea(p), 0);
  notes.area = { before: Math.round(areaBefore), after: Math.round(areaAfter), diff: Math.round((areaAfter - areaBefore) * 100) / 100 };
  ok('全图净面积基本不变（联动是"划分"：A 缩多少 B 就涨多少）',
     Math.abs(areaAfter - areaBefore) <= Math.abs(areaBefore) * 1e-6, JSON.stringify(notes.area));

  // ── 5. 一条 undo 还原 ──────────────────────────────────────────────────
  s.undo();
  await tick(200);
  ok('🔴 一次 Ctrl+Z 把**所有**联动省份一起还原（一次手势 = 一条命令）',
     JSON.stringify(flat(T())) === before);

  notes.timing = { buildMs: Math.round(buildMs * 10) / 10, dragMs: Math.round(dragMs),
                   confirmCalls: window.__p1.confirmCalls, selected: sel.length };
  return JSON.stringify({ fails, notes });
})()"""


def main():
    print('=== P1 顶点编辑：共边联动 @ 真实 415 省项目 ===', flush=True)
    os.makedirs(OUT_DIR, exist_ok=True)

    bak = rt.INDEX_HTML + '.bak'
    if os.path.exists(bak):
        print('  ⛔ 存在 index.html.bak（上一轮中断的半成品）—— 按纪律不启动任何服务，退出', flush=True)
        return 2
    busy = []
    for port in (rt.DEV_PORT, rt.CDP_PORT):
        try:
            raw = subprocess.run(['netstat', '-ano'], capture_output=True, timeout=20).stdout.decode('utf-8', 'replace')
            busy += [l.strip() for l in raw.splitlines() if (':%d' % port) in l and 'LISTENING' in l]
        except Exception:
            pass
    if busy:
        print('  ⛔ 5180/9222 上有别的回归在跑（free_port 会把它打死）—— 退出：%s' % busy[:3], flush=True)
        return 2
    if not os.path.exists(p0.REAL_PROJECT):
        print('  ⛔ 找不到真实项目：' + p0.REAL_PROJECT, flush=True)
        return 2

    before_stat = p0.file_stat(p0.REAL_PROJECT)
    print('  · 真实项目基线：size=%d sha256=%s' % (before_stat['size'], before_stat['sha256']), flush=True)

    handles, cdp = [], None
    try:
        rt.setup_mock()
        shutil.copy(p0.REAL_PROJECT, p0.REAL_PROJECT_IN_MOCK)
        rt.free_port(rt.DEV_PORT)
        dev = subprocess.Popen(['cmd', '/c', 'npm', 'run', 'dev'], cwd=ROOT,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        handles.append(rt.ProcessHandle(dev, 'dev'))
        if not rt.wait_port(rt.DEV_PORT, timeout=120):
            raise RuntimeError('Vite dev server 启动超时')
        rt.free_port(rt.CDP_PORT)
        edge = subprocess.Popen([
            rt.EDGE_EXE, '--headless=new', '--disable-gpu', '--disable-dev-shm-usage',
            '--remote-debugging-port=%d' % rt.CDP_PORT, '--remote-allow-origins=*',
            '--user-data-dir=%s' % os.path.join(ROOT, '.test-edge-profile'),
            '--no-first-run', '--no-default-browser-check',
            '--disable-sync', '--disable-features=SyncConsentUI,SigninCheckoutFlow',
            '--no-sandbox', 'about:blank',
        ])
        handles.append(rt.ProcessHandle(edge, 'edge'))
        if not rt.wait_port(rt.CDP_PORT, timeout=60):
            raise RuntimeError('Edge CDP 启动超时')
        ck('Vite(5180) + Edge(9222) 就绪', True)

        cdp = CDP()
        cdp.send('Page.enable')
        cdp.navigate()
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=90, desc='首次导航')
        rt.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate()
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=90, desc='跳过首启后重载')
        wait_for(cdp, "!document.querySelector('.onboarding-overlay')", timeout=30, desc='引导层关闭')
        ensure_data_ready(cdp, timeout=90)
        hok, hinfo = open_harness_project(cdp)
        ck('harness 基线项目已打开', hok, json.dumps(hinfo, ensure_ascii=False)[:120])

        iok, inj = eval_json(cdp, p0.INJECT_JS.replace('__PATH__', p0.MOCK_PROJECT_PATH).replace('__KEY__', p0.KEY),
                             required=('ok', 'terrain'), desc='注入真实项目')
        ck('真实项目注入成功（terrain=415）', iok and inj.get('terrain') == 415,
           'terrain=%s / %sms' % (inj.get('terrain'), inj.get('ms')) if isinstance(inj, dict) else inj)
        if not iok or inj.get('terrain') != 415:
            return 1

        r = cdp.eval("""(() => {
          const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('历史剧本'));
          if (!b) return 'no-btn'; b.click(); return 'ok';
        })()""")
        ck('进入剧本模式', r == 'ok', r)
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=30, desc='ScenarioMap 挂载')
        time.sleep(1.5)

        with open(p0.REAL_PROJECT, encoding='utf-8') as f:
            real = json.load(f)
        era = real['scenarios']['scenarios'][p0.SC]['era']
        year = int(era['startYear']) + (int(era['endYear']) - int(era['startYear'])) // 2
        sok, sres = eval_json(cdp, p0._sub(p0.SETUP_JS, KEY=p0.KEY, YEAR=year),
                              required=('fails', 'notes'), desc='场景布置')
        ck('场景布置（选中 desite 底图 / 剧本「%s」/ %d 年）' % (p0.SC, year), sok and not sres.get('fails'),
           '；'.join(sres.get('fails', [])) if sok else sres)

        pok, pres = eval_json(cdp, p0._sub(PROBE_JS, SC=p0.SC, KEY=p0.KEY),
                              required=('fails', 'notes'), desc='P1 共边联动探针')
        if not pok:
            ck('P1 探针可求值', False, pres)
            return 1
        n = pres.get('notes', {})
        idx = n.get('index', {})
        ck('真实数据：共边顶点确实存在（方案甲的前提成立）', idx.get('shared', 0) > 0,
           '顶点 %s / 共享 %s / 共享簇 %s（其中逐位相同 %s）/ 索引 %.1fms / 簇规模 %s'
           % (idx.get('total'), idx.get('shared'), idx.get('sharedClusters'), idx.get('exactClusters'),
              idx.get('buildMs', 0), json.dumps(idx.get('clustersBySize', {}), ensure_ascii=False)))
        t = n.get('timing', {})
        ck('选中顶点数（活动环上与邻省共边的顶点）≥ 2', t.get('selected', 0) >= 2, t.get('selected'))
        ck('拖动 + 落库耗时可控（headless 下含整幅重绘，闸门取 < 8000ms）', t.get('dragMs', 99999) < 8000, '%sms' % t.get('dragMs'))
        for f in pres.get('fails', []):
            ck('探针断言：' + f, False)
        if not pres.get('fails'):
            ck('探针全部断言通过', True)
        print('  · 实测：联动省份 %s 个 / 全图净面积 %s / 选中顶点 %s 个'
              % (n.get('movedProvinces'), json.dumps(n.get('area'), ensure_ascii=False), t.get('selected')), flush=True)
        print('  · 探测簇：%s' % json.dumps(n.get('probeCluster'), ensure_ascii=False), flush=True)

        out = os.path.join(OUT_DIR, 'report.json')
        with open(out, 'w', encoding='utf-8') as f:
            json.dump(REPORT, f, ensure_ascii=False, indent=1)
        print('  · 报告：%s' % os.path.relpath(out, ROOT), flush=True)
    finally:
        for h in reversed(handles):
            h.stop()
        # 🔴 `ProcessHandle.stop()` 只终止 `cmd /c npm run dev` 那个外壳，vite 的 node 子进程会**活下来**
        #    （实测：跑完 5180 仍被占 → 下一次演练的前置闸门直接拒绝启动）。所以再按端口清一次 ——
        #    与 run_tests.py 的收尾同一手法（它也是 free_port，不是 kill 自己拉起的那个 PID）。
        for port in (rt.DEV_PORT, rt.CDP_PORT):
            try:
                rt.free_port(port)
            except Exception:
                pass
        try:
            rt.teardown_mock()
        except Exception as e:
            print('  ⚠️ teardown_mock 失败：%s' % e, flush=True)
        if cdp:
            try:
                cdp.close()
            except Exception:
                pass
        after_stat = p0.file_stat(p0.REAL_PROJECT)
        ck('真实项目文件未被改动（sha256 一致）', after_stat['sha256'] == before_stat['sha256'],
           'before=%s after=%s' % (before_stat['sha256'][:12], after_stat['sha256'][:12]))

    failed = [c for c in REPORT['checks'] if not c['ok']]
    print('\n=== 结果: %d/%d ===' % (len(REPORT['checks']) - len(failed), len(REPORT['checks'])), flush=True)
    for c in failed:
        print('  - %s: %s' % (c['name'], c['detail']), flush=True)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
