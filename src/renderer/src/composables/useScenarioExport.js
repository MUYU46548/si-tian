// composables/useScenarioExport.js
// 剧本模块的导出/导入：SVG 矢量 / PNG 位图 / scenarios.json 全量数据
//
// SVG 是单一事实来源：PNG 由 SVG 光栅化而来，保证两者永远一致，
// 也不需要复制一遍画布的绘制管线。
import { ref } from 'vue';
import {
  serializeSvg, svgPathD, svgPath, svgRect, svgTextEl, svgCircleEl, svgImageEl,
  hatchPatternDef, boundsOf, rasterizeSvg, escXml, stamp,
} from '../utils/svgExport';
import {
  currentOwnerRef, isStriped, polityColor, settledCount,
} from '../utils/scenarioTimeline';

const LABEL_COLOR = '#3c4150';
const BORDER_COLOR = '#8d8a82';

export function useScenarioExport({
  store, baseMap, timeline, currentEra, currentYear, diffMode, provinceNames, layerFlags,
}) {
  const exportStatus = ref('');

  function setStatus(msg, ms = 4000) {
    exportStatus.value = msg;
    if (ms > 0) setTimeout(() => { if (exportStatus.value === msg) exportStatus.value = ''; }, ms);
  }

  function centroid(points) {
    let x = 0, y = 0, n = 0;
    for (const p of points || []) {
      const px = p.x !== undefined ? p.x : p[0];
      const py = p.y !== undefined ? p.y : p[1];
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      x += px; y += py; n++;
    }
    return n ? { x: x / n, y: y / n } : null;
  }

  /**
   * 构建当前剧本/年份的 SVG。
   * 画布逻辑与 ScenarioMap.render 对齐：底色 → 省份 → EU4 斜线 → 边界 → 名称 → 标签/标记 → 图例。
   */
  function buildScenarioSVG({ legend = true, title = true, grid = true } = {}) {
    const tl = timeline.value;
    if (!tl || !tl.scenarios.length) throw new Error('没有剧本可导出');
    const k = currentEra.value;
    const year = currentYear.value;
    const s = tl.scenarios[k];
    const terrain = baseMap.value?.terrain || [];
    if (!terrain.length) throw new Error('当前底图没有省份多边形');

    const polys = terrain.map((p) => p.points || []).filter((p) => p.length >= 3);
    const b = boundsOf(polys);
    const pad = 40;
    const W = Math.ceil((b.maxX - b.minX) + pad * 2);
    const H = Math.ceil((b.maxY - b.minY) + pad * 2);
    const tx = -b.minX + pad;
    const ty = -b.minY + pad;

    const flags = layerFlags ? layerFlags() : { labels: true, borders: true };
    const defs = [];
    const body = [];
    const hatchIds = {};

    // 外层平移（世界坐标 → SVG 用户坐标）
    body.push(`<g transform="translate(${Math.round(tx)},${Math.round(ty)})">`);

    // 参考底图（数据 URL 直接内联，SVG 光栅化时无需外部资源）
    const refs = baseMap.value?.referenceImages || [];
    for (const r of refs) {
      if (!r?.dataUrl) continue;
      const w = (r.width || 0) * (r.scale || 1);
      const h = (r.height || 0) * (r.scale || 1);
      if (!w || !h) continue;
      const cx = r.offsetX ?? 0, cy = r.offsetY ?? 0;
      const rot = (r.rotation || 0) * 180 / Math.PI;
      body.push(`<g transform="translate(${Math.round(cx)},${Math.round(cy)}) rotate(${Math.round(rot)}) translate(${Math.round(-w / 2)},${Math.round(-h / 2)})">`);
      body.push(svgImageEl(0, 0, w, h, r.dataUrl, { opacity: r.opacity ?? 0.6 }));
      body.push('</g>');
    }

    // 网格
    if (grid) {
      const step = 100;
      const g = [];
      for (let x = Math.ceil(b.minX / step) * step; x <= b.maxX; x += step) {
        g.push(`M ${x} ${Math.round(b.minY)} L ${x} ${Math.round(b.maxY)}`);
      }
      for (let y = Math.ceil(b.minY / step) * step; y <= b.maxY; y += step) {
        g.push(`M ${Math.round(b.minX)} ${y} L ${Math.round(b.maxX)} ${y}`);
      }
      body.push(svgPath(g.join(' '), {
        fill: 'none', stroke: '#243449', 'stroke-width': 1, opacity: 0.55,
      }));
    }

    // 省份填充 + EU4 斜线占领
    for (const prov of terrain) {
      const pts = prov.points || [];
      if (pts.length < 3) continue;
      const d = svgPathD(pts, { closed: true });
      if (!d) continue;
      // 与画布同规则：EU4 斜线占领时底色=旧主；其他模式底色=当前实际持有者
      const ref = (diffMode.value === 'eu4' && isStriped(tl, k, prov.id, year))
        ? { owner: tl.scenarios[k - 1].ownership?.[prov.id], era: k - 1 }
        : currentOwnerRef(tl, k, prov.id, year);
      const col = polityColor(tl.scenarios[ref.era], ref.owner);
      body.push(svgPath(d, { fill: col, 'fill-opacity': 0.72, stroke: 'none' }));

      if (diffMode.value === 'eu4' && isStriped(tl, k, prov.id, year)) {
        const newCol = polityColor(s, s.ownership?.[prov.id]);
        if (!hatchIds[newCol]) {
          const r = hatchPatternDef(newCol, { id: `occ-${Object.keys(hatchIds).length}` });
          hatchIds[newCol] = r.id;
          defs.push(r.def);
        }
        body.push(svgPath(d, { fill: `url(#${hatchIds[newCol]})`, stroke: 'none' }));
        body.push(svgPath(d, {
          fill: 'none', stroke: newCol, 'stroke-width': 1.4, 'stroke-linejoin': 'round',
        }));
      } else if (diffMode.value === 'outline' && k > 0 && (tl.eraChg[k]?.changed || []).includes(prov.id)) {
        body.push(svgPath(d, {
          fill: 'none', stroke: '#ffffff', 'stroke-width': 2, 'stroke-linejoin': 'round',
        }));
      }
    }

    // 边界
    if (flags.borders !== false) {
      const ds = [];
      for (const prov of terrain) {
        if ((prov.points || []).length < 3) continue;
        ds.push(svgPathD(prov.points, { closed: true }));
      }
      body.push(svgPath(ds.join(' '), {
        fill: 'none', stroke: BORDER_COLOR, 'stroke-width': 0.6, opacity: 0.6,
      }));
    }

    // 省名（跳过无名省份，避免「(未命名)」刷屏）
    if (flags.labels !== false) {
      for (const prov of terrain) {
        const nm = prov.name || provinceNames.value?.[prov.id];
        if (!nm || /^Province\s*\d*$/i.test(nm) || /^feature_/i.test(nm)) continue;
        const c = centroid(prov.points);
        if (!c) continue;
        body.push(svgTextEl(c.x, c.y, nm, {
          fill: LABEL_COLOR, 'font-size': 11, 'font-family': 'Microsoft YaHei, sans-serif',
          'text-anchor': 'middle', 'dominant-baseline': 'middle', opacity: 0.85,
        }));
      }
    }

    // 剧本标签 / 标记
    for (const lb of (s.labels || [])) {
      body.push(svgTextEl(lb.x, lb.y, lb.text || '', {
        fill: lb.color || LABEL_COLOR, 'font-size': lb.size || 12,
        'font-family': 'Microsoft YaHei, sans-serif', 'text-anchor': 'middle',
      }));
    }
    for (const mk of (s.markers || [])) {
      body.push(svgCircleEl(mk.x, mk.y, 4, { fill: mk.color || '#f6ad55', stroke: '#1a2a3a', 'stroke-width': 1 }));
      if (mk.name) {
        body.push(svgTextEl(mk.x, mk.y - 8, mk.name, {
          fill: '#e2e8f0', 'font-size': 10, 'font-family': 'Microsoft YaHei, sans-serif',
          'text-anchor': 'middle',
        }));
      }
    }

    body.push('</g>');

    // 标题块（左上）
    if (title) {
      const { settled, total } = settledCount(tl, k, year);
      const lines = [
        `${s.name}`,
        `${tl.years[k].start} ~ ${tl.years[k].end} · 当前 ${Math.round(year)}`,
        `${baseMap.value?.name || baseMap.value?.id || ''} · ${terrain.length} 省`,
      ];
      if (k > 0) lines.push(`易主 ${settled}/${total} 省已落定`);
      body.push(svgRect(12, 12, 236, 20 + lines.length * 16, {
        fill: 'rgba(15,23,42,0.86)', stroke: '#334155', 'stroke-width': 1, rx: 6,
      }));
      lines.forEach((t, i) => {
        body.push(svgTextEl(24, 32 + i * 16, t, {
          fill: i === 0 ? '#e2e8f0' : '#94a3b8',
          'font-size': i === 0 ? 13 : 10,
          'font-family': 'Microsoft YaHei, sans-serif',
        }));
      });
    }

    // 图例（右上）：势力色 + 省数
    if (legend) {
      const rows = (s.polities || []).filter((p) => p && p.id);
      const occupied = {};
      for (const prov of terrain) {
        // 图例统计的是**当前实际持有者**（斜线占领态下底色是旧主，但归属已转移）
        const o = currentOwnerRef(tl, k, prov.id, year).owner;
        if (o) occupied[o] = (occupied[o] || 0) + 1;
      }
      const lw = 178;
      const lh = 20 + rows.length * 15;
      const lx = W - lw - 12;
      body.push(svgRect(lx, 12, lw, lh, {
        fill: 'rgba(15,23,42,0.86)', stroke: '#334155', 'stroke-width': 1, rx: 6,
      }));
      body.push(svgTextEl(lx + 12, 30, '势力', {
        fill: '#64748b', 'font-size': 10, 'font-family': 'Microsoft YaHei, sans-serif',
      }));
      rows.forEach((p, i) => {
        const y = 46 + i * 15;
        body.push(svgRect(lx + 12, y - 7, 9, 9, { fill: p.color || '#4a5568', rx: 2 }));
        body.push(svgTextEl(lx + 27, y, p.name || p.id, {
          fill: '#cbd5e1', 'font-size': 11, 'font-family': 'Microsoft YaHei, sans-serif',
        }));
        body.push(svgTextEl(W - 20, y, String(occupied[p.id] || 0), {
          fill: '#64748b', 'font-size': 10, 'font-family': 'Microsoft YaHei, sans-serif',
          'text-anchor': 'end',
        }));
      });
    }

    const svg = serializeSvg({ width: W, height: H, background: '#1a2a3a', defs, body });
    return { svg, width: W, height: H };
  }

  function safeName(s) {
    return String(s || 'scenario').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  }

  async function exportScenarioSVG() {
    try {
      const { svg } = buildScenarioSVG();
      const tl = timeline.value;
      const k = currentEra.value;
      const name = `sitian-${safeName(tl.scenarios[k].name)}-${Math.round(currentYear.value)}-${stamp()}.svg`;
      if (window.sitianAPI?.saveTextFile) {
        const r = await window.sitianAPI.saveTextFile({
          text: svg, defaultName: name, kind: 'svg',
        });
        if (r?.success) setStatus(`已导出 SVG：${r.path}`);
        else if (r?.canceled) setStatus('已取消导出', 2000);
        else setStatus(`导出失败：${r?.error || '未知错误'}`);
      } else {
        // 浏览器回退
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        a.download = name;
        a.click();
        setStatus('已下载（浏览器回退模式）', 3000);
      }
      return { success: true };
    } catch (e) {
      setStatus(`导出失败：${e.message}`);
      return { success: false, error: e.message };
    }
  }

  async function exportScenarioPNG(scale = 2) {
    try {
      const { svg } = buildScenarioSVG();
      const dataUrl = await rasterizeSvg(svg, scale);
      const tl = timeline.value;
      const k = currentEra.value;
      const name = `sitian-${safeName(tl.scenarios[k].name)}-${Math.round(currentYear.value)}-${stamp()}.png`;
      if (window.sitianAPI?.saveExportFile) {
        const r = await window.sitianAPI.saveExportFile({ dataUrl, defaultName: name });
        if (r?.success) setStatus(`已导出 PNG：${r.path}`);
        else if (r?.canceled) setStatus('已取消导出', 2000);
        else setStatus(`导出失败：${r?.error || '未知错误'}`);
      } else {
        const a = document.createElement('a');
        a.href = dataUrl; a.download = name; a.click();
        setStatus('已下载（浏览器回退模式）', 3000);
      }
      return { success: true };
    } catch (e) {
      setStatus(`导出失败：${e.message}`);
      return { success: false, error: e.message };
    }
  }

  // ===== scenarios.json =====

  async function exportScenariosJson({ scope = 'current' } = {}) {
    try {
      const ownerKey = scope === 'all' ? null : (baseMap.value?.id || null);
      const payload = store.exportScenariosPayload(ownerKey);
      const warns = store.auditScenariosPayload(payload);
      if (warns.length) {
        const ok = confirm(
          `导出前体检发现 ${warns.length} 项提示：\n\n• ${warns.slice(0, 12).join('\n• ')}` +
          `${warns.length > 12 ? `\n…（还有 ${warns.length - 12} 项）` : ''}\n\n仍要导出吗？`
        );
        if (!ok) { setStatus('已取消导出', 2000); return { success: false, canceled: true }; }
      }
      const text = JSON.stringify(payload, null, 1);
      const name = scope === 'all'
        ? `scenarios-全部-${stamp()}.json`
        : `scenarios-${safeName(ownerKey)}-${stamp()}.json`;
      if (window.sitianAPI?.saveTextFile) {
        const r = await window.sitianAPI.saveTextFile({ text, defaultName: name, kind: 'json' });
        if (r?.success) {
          setStatus(`已导出 ${Object.keys(payload.scenarios).length} 剧本 / ${Object.keys(payload.baseMaps).length} 底图：${r.path}`);
        } else if (r?.canceled) setStatus('已取消导出', 2000);
        else setStatus(`导出失败：${r?.error || '未知错误'}`);
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        a.download = name; a.click();
        setStatus('已下载（浏览器回退模式）', 3000);
      }
      return { success: true, warns };
    } catch (e) {
      setStatus(`导出失败：${e.message}`);
      return { success: false, error: e.message };
    }
  }

  /**
   * 选择本地 scenarios.json 并导入（merge / replace 二选一，默认 merge）。
   * 用隐藏 input 取文件（与 triggerMapImport 一致，不需要额外 IPC）。
   */
  function pickScenariosJson({ mode = 'merge' } = {}) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) { resolve({ success: false, canceled: true }); return; }
        try {
          const text = await file.text();
          let data;
          try {
            data = JSON.parse(text);
          } catch (err) {
            alert(`JSON 解析失败：${err.message}`);
            resolve({ success: false, error: 'JSON 解析失败' });
            return;
          }
          const maps = Object.keys(data.baseMaps || {});
          const scen = Object.keys(data.scenarios || {});
          if (!maps.length && !scen.length) {
            alert('文件里既没有 baseMaps 也没有 scenarios —— 确认是司天导出的 scenarios.json 吗？');
            resolve({ success: false, error: '结构不符' });
            return;
          }
          const modeLabel = mode === 'replace' ? '替换（现有底图/剧本会被清空）' : '合并（同 key 覆盖）';
          const ok = confirm(
            `即将导入「${file.name}」\n\n` +
            `底图 ${maps.length} 个：${maps.slice(0, 6).join('、')}${maps.length > 6 ? '…' : ''}\n` +
            `剧本 ${scen.length} 个\n` +
            `导入方式：${modeLabel}\n\n继续？`
          );
          if (!ok) { resolve({ success: false, canceled: true }); return; }
          const r = store.importScenariosPayload(data, { mode });
          if (!r?.success) {
            alert(`导入失败：${r?.error || '未知错误'}`);
            resolve(r || { success: false });
            return;
          }
          setStatus(`导入完成：+${r.addedMaps} 底图 / +${r.addedScenarios} 新剧本（共 ${r.scenarios} 剧本）`);
          resolve({ ...r, fileName: file.name });
        } catch (err) {
          alert(`导入失败：${err.message}`);
          resolve({ success: false, error: err.message });
        }
      };
      input.click();
    });
  }

  return {
    exportStatus,
    setStatus,
    buildScenarioSVG,
    exportScenarioSVG,
    exportScenarioPNG,
    exportScenariosJson,
    pickScenariosJson,
  };
}
