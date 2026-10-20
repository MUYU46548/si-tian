"""用例 130：手画河的「速度→宽度因子」真的写进数据，并被渲染宽度读取。

H2 的 `widthFactors` 首版被 `addBaseMapRiver` / `applyBaseMapRiverEdit` 静默丢掉
（store 只挑 points/width/discharge）—— 暮雨实测「河流没修」的一部分原因就在这里。
本用例守：
  · 两条写口都保留 `widthFactors`（长度/数值原样）；
  · `riverWidthsFor` 在读到时改变头/尾宽度（不是只存不用）。
"""
import json

from lib.cdp import wait_for

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"

JS = r"""
(() => {
  const s = __STORE__, sm = __SM__;
  const KEY = 'case130';
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: KEY });
  s.baseMaps[KEY].terrain = [];
  s.baseMaps[KEY].rivers = [];
  const pts = [{x:0,y:0},{x:50,y:20},{x:100,y:0}];
  const r1 = s.addBaseMapRiver(KEY, { points: pts, width: 3, widthFactors: [0.8, 1, 1.4] });
  const added = s.baseMaps[KEY].rivers.find(r => r.id === r1.id) || {};
  const r2 = s.applyBaseMapRiverEdit(KEY, { adds: [{ points: pts, width: 3, widthFactors: [1, 1.5, 1] }] });
  const added2 = s.baseMaps[KEY].rivers.find(r => r.id === (r2.added || [])[0]) || {};
  const w0 = sm.riverWidthsFor ? sm.riverWidthsFor({ width: 3 }, 3) : null;
  const w1 = sm.riverWidthsFor ? sm.riverWidthsFor({ width: 3, widthFactors: [0.5, 1, 2] }, 3) : null;
  const okFactors = Array.isArray(added.widthFactors) && added.widthFactors.join(',') === '0.8,1,1.4';
  const okFactors2 = Array.isArray(added2.widthFactors) && added2.widthFactors.join(',') === '1,1.5,1';
  const okWidths = !!(w0 && w1 && w1[0] < w0[0] && w1[2] > w0[2]);
  return JSON.stringify({
    fails: [
      okFactors ? null : 'addBaseMapRiver 丢了 widthFactors：' + JSON.stringify(added.widthFactors),
      okFactors2 ? null : 'applyBaseMapRiverEdit 丢了 widthFactors：' + JSON.stringify(added2.widthFactors),
      okWidths ? null : 'riverWidthsFor 没读 widthFactors：' + JSON.stringify({ w0, w1 }),
    ].filter(Boolean),
    factors: added.widthFactors, factors2: added2.widthFactors, w0, w1,
  });
})()
"""


def run(cdp):
    cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
             ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本模式')
    v = cdp.eval(JS.replace('__STORE__', STORE).replace('__SM__', SM))
    if isinstance(v, dict) and '__err__' in v:
        return False, f'JS 异常：{str(v["__err__"])[:300]}'
    try:
        data = json.loads(v)
    except Exception:
        return False, f'返回非 JSON：{str(v)[:300]}'
    if data.get('fails'):
        return False, ' | '.join(data['fails'])
    return True, f"写口保留因子 {data.get('factors')} / {data.get('factors2')}；宽度 {data.get('w0')} → {data.get('w1')}"
