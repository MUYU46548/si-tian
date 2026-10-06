// composables/useScenarioExport.js
// 剧本模块的导出/导入：SVG 矢量 / PNG 位图 / scenarios.json 全量数据
//
// SVG 是单一事实来源：PNG 由 SVG 光栅化而来，保证两者永远一致，
// 也不需要复制一遍画布的绘制管线。
import { ref } from 'vue';
import {
  serializeSvg, svgPathD, svgPath, svgRect, svgTextEl, svgCircleEl,
  hatchPatternDef, boundsOf, rasterizeSvg, escXml, stamp,
  // A7：参考底图几何的唯一实现（象限索引 → 90° 步进 / flipH / 宽高互换）
  refImageSvgGroup,
} from '../utils/svgExport';
import {
  currentOwnerRef, isStriped, polityColor, settledCount,
} from '../utils/scenarioTimeline';
import {
  // 多环省份（洞/飞地）+ 「网格派生的环要不要 Chaikin」—— 与画布同一份实现
  provinceRings, ringPointsForRender,
} from '../utils/provinceShape';
import {
  // 配色单一来源（省份色板 / 海域填充与海界 / 陆界）—— 与画布共用一份
  SEA_FILL, SEA_EDGE, BORDER_COLOR,
} from '../utils/scenarioPalette';
import { polityLabelTier, ringAreaCentroid } from '../utils/polityLabels';
// 剧本标签「该写哪些字、写在哪」的唯一判定 —— 画布与 SVG 导出共用
import { collectScenarioLabels } from '../utils/scenarioLabels';
// 逐年切片的帧索引 / 日期体检 / 帧命名（纯函数，画布与导出共用一份判定）
import {
  collectSliceFrames, changeDateStats, sliceFrameName, MAX_SLICE_FRAMES,
} from '../utils/scenarioSlices';
import { formatDate, dateToken } from '../utils/scenarioDates';

const LABEL_COLOR = '#3c4150';

export function useScenarioExport({
  store, baseMap, timeline, currentEra, currentYear, diffMode, provinceNames, layerFlags,
}) {
  const exportStatus = ref('');

  function setStatus(msg, ms = 4000) {
    exportStatus.value = msg;
    if (ms > 0) setTimeout(() => { if (exportStatus.value === msg) exportStatus.value = ''; }, ms);
  }

  // ⚠️ 这里原先有个 `centroid()`（算术平均）只服务省名落点 —— 已删除：
  //    落点改为 `ringAreaCentroid`（面积加权，与画布同口径）。算术平均会把长条省的名字拽偏，
  //    而且两份"形心"实现就是下一个「改一处另一处不变」。

  /**
   * 构建**指定剧本 / 指定日期**的 SVG（省略 era/date/year 时 = 当前时间轴状态）。
   * 画布逻辑与 ScenarioMap.render 对齐：底色 → 省份 → EU4 斜线 → 边界 → 名称 → 标签/标记 → 图例。
   *
   * 🔴 2026-10-02 参数化 `(era, year)`（逐年切片导出要用）：此前它只读注入的
   *    `currentEra`/`currentYear` 两个 ref → 想导出「另一年」只能先改时间轴游标再导出
   *    （批量出帧会边导边动用户的时间轴，且无法并行/回放）。参数化后**帧序列与当前游标无关**。
   *    默认值保持原行为（不传 = 当前），既有调用与用例一行不改。
   * 🔴 2026-10-05 再加 `date`（月日精度）：同一年内 6 月前后归属不同，只给年份
   *    会把「1444-11-11」导成「1444-01-01」的状态（图与时间点不符）。
   *    **`date` 优先，`year` 仅作兼容**（裸年份 = 该年 1 月 1 日）。
   */
  function buildScenarioSVG({ legend = true, title = true, grid = true, era, date: dateOpt, year: yearOpt } = {}) {
    const tl = timeline.value;
    if (!tl || !tl.scenarios.length) throw new Error('没有剧本可导出');
    const k = Number.isInteger(era) ? era : currentEra.value;
    const at = dateOpt
      ? { y: dateOpt.y, m: dateOpt.m ?? null, d: dateOpt.d ?? null }
      : (Number.isFinite(yearOpt) ? { y: yearOpt, m: null, d: null } : currentYear.value);
    if (!(k >= 0 && k < tl.scenarios.length)) throw new Error(`剧本序号超出范围：${k}`);
    const s = tl.scenarios[k];
    const terrain = baseMap.value?.terrain || [];
    if (!terrain.length) throw new Error('当前底图没有省份多边形');

    // 包围盒按**所有环**（含洞/飞地）算：只按主环算会把飞地裁掉一角
    const ringCache = terrain.map((p) => provinceRings(p)
      .map((r) => ({ kind: r.kind, points: ringPointsForRender(r) }))
      .filter((r) => r.points && r.points.length >= 3));
    const polys = ringCache.flat().map((r) => r.points);
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
    // A7：几何统一走 `refImageSvgGroup`（象限索引 → 90° 步进 / flipH / 宽高互换），
    // 与行星侧导出、与画布绘制**同一份实现**；此前这里把 rotation 当弧度换算
    //（`* 180/π`），转 1 次会导出成 57°。
    // ⚠️ 既存事实：剧本侧画布（ScenarioMap）**当前不渲染参考图**，这里导出属"导出的东西
    //    画布上看不见"。保留该能力（底图是用户自备素材，导出带上更有用），但不对齐画布 ——
    //    若日后 ScenarioMap 加上参考图渲染，必须改回"读同一个来源"。
    const refs = baseMap.value?.referenceImages || [];
    for (const r of refs) {
      const g = refImageSvgGroup(r);
      if (g) body.push(g);
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
    // 🔴 2026-10-01「导出与画布同源」三件事：
    //   ① 多环省份要把**所有环**拼进一条 path + `fill-rule="evenodd"` —— 旧实现只画
    //      `prov.points`（主环），洞会被填实、飞地直接丢（画布走 `traceProvincePath` + evenodd）。
    //   ② 海域（`kind === 'sea'`）用 `SEA_FILL` —— 旧实现照样按归属上色/回落灰，
    //      导出图里水陆分不开（画布在 `getProvinceColor` 里**最先**判海域）。
    //   ③ 网格派生的环走 `ringPointsForRender`（与画布同一条 Chaikin 规则）。
    for (let i = 0; i < terrain.length; i++) {
      const prov = terrain[i];
      const rings = ringCache[i];
      if (!rings.length) continue;
      const d = rings.map((r) => svgPathD(r.points, { closed: true })).filter(Boolean).join(' ');
      if (!d) continue;

      // 海域不参与势力归属（海不是谁的领土）→ 画水面，且不参与斜线占领
      if (rings[0].kind === 'sea') {
        body.push(svgPath(d, { fill: SEA_FILL, 'fill-rule': 'evenodd', stroke: 'none' }));
        continue;
      }

      // 与画布同规则：EU4 斜线占领时底色=旧主；其他模式底色=当前实际持有者
      const ref = (diffMode.value === 'eu4' && isStriped(tl, k, prov.id, at))
        ? { owner: tl.scenarios[k - 1].ownership?.[prov.id], era: k - 1 }
        : currentOwnerRef(tl, k, prov.id, at);
      const col = polityColor(tl.scenarios[ref.era], ref.owner);
      body.push(svgPath(d, { fill: col, 'fill-rule': 'evenodd', 'fill-opacity': 0.72, stroke: 'none' }));

      if (diffMode.value === 'eu4' && isStriped(tl, k, prov.id, at)) {
        const newCol = polityColor(s, s.ownership?.[prov.id]);
        if (!hatchIds[newCol]) {
          const r = hatchPatternDef(newCol, { id: `occ-${Object.keys(hatchIds).length}` });
          hatchIds[newCol] = r.id;
          defs.push(r.def);
        }
        body.push(svgPath(d, { fill: `url(#${hatchIds[newCol]})`, 'fill-rule': 'evenodd', stroke: 'none' }));
        body.push(svgPath(d, {
          fill: 'none', stroke: newCol, 'stroke-width': 1.4, 'stroke-linejoin': 'round',
        }));
      } else if (diffMode.value === 'outline' && k > 0 && (tl.eraChg[k]?.changed || []).includes(prov.id)) {
        body.push(svgPath(d, {
          fill: 'none', stroke: '#ffffff', 'stroke-width': 2, 'stroke-linejoin': 'round',
        }));
      }
    }

    // 边界：陆地省界（实线）+ 海域海界（淡虚线 —— 与画布 `SEA_EDGE` 同一约定，水陆一眼可分）
    if (flags.borders !== false) {
      const landDs = [], seaDs = [];
      for (const rings of ringCache) {
        for (const r of rings) {
          const d = svgPathD(r.points, { closed: true });
          if (!d) continue;
          (r.kind === 'sea' ? seaDs : landDs).push(d);
        }
      }
      if (landDs.length) {
        body.push(svgPath(landDs.join(' '), {
          fill: 'none', stroke: BORDER_COLOR, 'stroke-width': 0.6, opacity: 0.6,
        }));
      }
      if (seaDs.length) {
        body.push(svgPath(seaDs.join(' '), {
          fill: 'none', stroke: SEA_EDGE, 'stroke-width': 0.9, 'stroke-dasharray': '6 4', opacity: 0.85,
        }));
      }
    }

    // 省名（跳过无名 / FMG 自动名，避免「(未命名)」「Province 12」刷屏）
    // 落点改用**面积加权形心**（与画布 `ringAreaCentroid` 同口径；算术平均会把长条省的名字拽偏）
    if (flags.labels !== false) {
      for (let i = 0; i < terrain.length; i++) {
        const prov = terrain[i];
        const nm = prov.name || provinceNames.value?.[prov.id];
        if (!nm || /^Province\s*\d*$/i.test(nm) || /^feature_/i.test(nm)) continue;
        const r0 = ringCache[i][0];
        if (!r0 || r0.kind === 'sea') continue;
        const { cx, cy } = ringAreaCentroid(r0.points);
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
        body.push(svgTextEl(cx, cy, nm, {
          fill: LABEL_COLOR, 'font-size': 11, 'font-family': 'Microsoft YaHei, sans-serif',
          'text-anchor': 'middle', 'dominant-baseline': 'middle', opacity: 0.85,
        }));
      }
    }

    // 势力名（A8）：**与画布同一份判定**（`utils/scenarioLabels.js`）——
    // 整图导出等价于画布缩到「全球可见」那一档（`polityLabelTier(1)` → 中档 = 势力名）。
    // 此前 SVG **完全没有这一层**：真实数据 21 个省份名里 20 个是 FMG 的 `Province N`，
    // 会被上面那条过滤器整片跳过 → 导出的图一个字都没有（"拿 SVG 当版图"最致命的一条）。
    const labels = collectScenarioLabels({
      provinces: terrain.map((prov, i) => ({
        id: prov.id, name: prov.name,
        rings: ringCache[i][0] ? [ringCache[i][0]] : [],
      })),
      tier: polityLabelTier(1),
      scale: 1,                                  // SVG 用户空间 = 世界单位（≈ 1 屏幕像素/世界单位）
      ownerRefOf: (pid) => ((diffMode.value === 'eu4' && isStriped(tl, k, pid, at))
        ? { owner: tl.scenarios[k - 1]?.ownership?.[pid], era: k - 1 }
        : currentOwnerRef(tl, k, pid, at)),
      polityOfEra: (era, owner) => tl.scenarios[era]?.polities?.find((p) => p.id === owner) || null,
    });
    for (const lb of labels) {
      if (lb.kind !== 'polity') continue;        // 省名那一层上面单独画（带 FMG 自动名过滤）
      body.push(svgTextEl(lb.x, lb.y, lb.text, {
        fill: '#F7F3E8', 'font-size': 15, 'font-family': 'serif', 'font-weight': 'bold',
        stroke: '#1B2130', 'stroke-width': 3, 'paint-order': 'stroke',
        'text-anchor': 'middle', 'dominant-baseline': 'middle',
      }));
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
      const { settled, total } = settledCount(tl, k, at);
      const lines = [
        `${s.name}`,
        `${tl.years[k].start} ~ ${tl.years[k].end} · 当前 ${formatDate(at)}`,
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
        const o = currentOwnerRef(tl, k, prov.id, at).owner;
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

  // ===== 逐年切片（EU4 式帧序列）=====

  /** 目录名里的日期段：用与帧名同一套 token（负数年 `n` 前缀、无分隔符） */
  function dateSlug(frame) {
    return dateToken(frame?.date || { y: frame?.year, m: null, d: null });
  }

  /**
   * 构建整批切片帧（**不落盘**）：一次把每个「状态真的变了」的年份渲染成一张图。
   *
   * 为什么先整批构建再交给主进程写：主进程只该管「选目录 + 写文件」，渲染与几何
   * 在渲染层做一次就是一份实现。也让用例能拦在 IPC 这一层断言整批内容。
   *
   * @returns {Promise<{files:Array, manifest:Object, stats:Object, warnings:string[]}>}
   */
  async function buildSliceFrames({ png = false, scale = 2, onProgress, slicePoints } = {}) {
    const tl = timeline.value;
    let model;
    try {
      // 帧索引只算一次（与对话框共用同一份判定）；书签帧默认必出 → 必须把切片点传进去，
      // 否则「我在对话框里看到 8 帧、导出来 5 帧」（书签帧被吞）= 同屏两个数字对不上
      model = collectSliceFrames(tl, slicePoints);
    } catch (e) {
      throw new Error(`切片索引失败：${e.message}`);
    }
    const frames = model.frames;
    if (!frames.length) throw new Error('没有可导出的帧（还没有剧本，或剧本没有年代区间）');
    if (frames.length > MAX_SLICE_FRAMES) {
      throw new Error(`需要 ${frames.length} 帧，超过上限 ${MAX_SLICE_FRAMES} —— 先合并/精简剧本，或分批导出`);
    }

    const warnings = [];
    const dates = changeDateStats(tl);
    if (dates.synthesized > 0) {
      warnings.push(`${dates.synthesized}/${dates.total} 个易主日期是**自动铺开的合成值**（未录入真实日期），`
        + '导出的是「按现有剧本推出来的时间轴」，不是史料');
    }
    if (dates.outOfRange.length) {
      warnings.push(`${dates.outOfRange.length} 个易主日期落在本剧本年代区间之外（帧仍会出，但日期本身该修）`);
    }
    if (dates.multiPerProvince.length) {
      warnings.push(`${dates.multiPerProvince.length} 个省在同一个剧本内多次易主 —— 每一次各出一帧`);
    }

    const files = [];
    let size = null;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      if (onProgress) onProgress(i + 1, frames.length, f);
      // 🔴 传 `date`（不是 year）：月日精度下同一年可能有多个帧状态，
      //    只给年份会让「1444-11-11」渲染成「1444-01-01」的状态（图与时间点不符）。
      const built = buildScenarioSVG({ era: f.era, date: f.date, year: f.year });
      if (!size) size = { width: built.width, height: built.height };
      if (png) {
        files.push({ name: sliceFrameName(i, f, 'png'), dataUrl: await rasterizeSvg(built.svg, scale) });
      } else {
        files.push({ name: sliceFrameName(i, f, 'svg'), text: built.svg });
      }
    }

    const s = tl.scenarios[Math.max(0, Math.min(frames[frames.length - 1].era, tl.scenarios.length - 1))];
    const manifest = {
      version: 1,
      kind: 'scenario-slices',
      generatedAt: new Date().toISOString(),
      baseMap: { id: baseMap.value?.id || '', name: baseMap.value?.name || '' },
      format: png ? 'png' : 'svg',
      scale: png ? scale : 1,
      frameSize: size,
      frameCount: frames.length,
      dateStats: {
        total: dates.total, explicit: dates.explicit, synthesized: dates.synthesized,
        outOfRange: dates.outOfRange.length,
      },
      // 每帧「哪一天 / 哪个剧本 / 哪些省易主 / 为什么存在」—— 交给外部 ffmpeg 或做字幕都要它
      frames: frames.map((f, i) => ({
        index: i + 1,
        file: files[i] ? files[i].name : '',
        // 月日精度：日期是主键，year 保留给只认年份的外部工具（ffmpeg 字幕模板等）
        date: { y: f.date?.y ?? f.year, m: f.date?.m ?? null, d: f.date?.d ?? null },
        dateText: formatDate(f.date),
        year: f.year,
        era: f.era,
        eraName: tl.scenarios[f.era]?.name || '',
        kind: f.kind,
        // 帧来源：bookmark（切片点，默认必出）/ era（剧本起点）/ change（易主）
        sources: Array.isArray(f.sources) ? f.sources.slice() : [],
        bookmarkIds: Array.isArray(f.bookmarkIds) ? f.bookmarkIds.slice() : [],
        label: f.label || '',
        changed: f.changed.slice(),
        changedNames: f.changed.map((pid) => provinceNames.value?.[pid] || pid),
        explicitCount: Object.keys(f.explicit || {}).length,
        outOfRange: !!f.outOfRange,
      })),
      warnings,
      scenarioId: s?.id || '',
    };
    return { files, manifest, stats: { ...model.stats, dates }, warnings };
  }

  /**
   * 逐年切片导出（选一次目录 → 批量写 N 帧 + frames.json）。
   * 失败/取消都给可见回音；浏览器回退模式退化为逐个下载（并说明）。
   */
  async function exportSliceFrames({ png = false, scale = 2, slicePoints } = {}) {
    try {
      setStatus('正在生成切片帧…', 0);
      const bundle = await buildSliceFrames({
        png, scale, slicePoints,
        onProgress: (i, n, f) => setStatus(`正在生成第 ${i}/${n} 帧（${formatDate(f.date)}）…`, 0),
      });
      // 目录名用「首个剧本名 + 日期跨度」：一批切片本来就跨多个剧本，
      // 只写某一个剧本名会让人以为这批只覆盖那一代（曾写成 frames[0].era → 甲时代 + 乙时代的帧）
      const first = bundle.manifest.frames[0] || {};
      const last = bundle.manifest.frames[bundle.manifest.frames.length - 1] || {};
      const firstEra = timeline.value.scenarios[first.era || 0];
      const dirName = `sitian-slices-${safeName(firstEra?.name)}`
        + `-${dateSlug(first)}_${dateSlug(last)}-${stamp()}`;

      if (window.sitianAPI?.exportScenarioFrames) {
        setStatus(`正在写入 ${bundle.files.length} 个文件…`, 0);
        const r = await window.sitianAPI.exportScenarioFrames({
          dirName, files: bundle.files, manifest: bundle.manifest,
        });
        if (r?.success) {
          setStatus(`已导出 ${r.count} 帧到 ${r.dir}（含 frames.json 清单，可直接交给 ffmpeg）`, 12000);
        } else if (r?.canceled) {
          setStatus('已取消切片导出', 3000);
        } else {
          setStatus(`切片导出失败：${r?.error || '未知错误'}`, 8000);
        }
        return { ...r, frames: bundle.files.length, warnings: bundle.warnings };
      }

      // 浏览器回退：没有目录写入能力 → 逐个下载
      for (const f of bundle.files) {
        const a = document.createElement('a');
        if (f.text) a.href = URL.createObjectURL(new Blob([f.text], { type: 'image/svg+xml' }));
        else a.href = f.dataUrl;
        a.download = f.name;
        a.click();
        await new Promise((r) => setTimeout(r, 150));
      }
      setStatus(`已逐个下载 ${bundle.files.length} 帧（浏览器回退模式，没有 frames.json）`, 6000);
      return { success: true, frames: bundle.files.length, browserFallback: true, warnings: bundle.warnings };
    } catch (e) {
      setStatus(`切片导出失败：${e.message}`, 8000);
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
    buildSliceFrames,
    exportSliceFrames,
    exportScenarioSVG,
    exportScenarioPNG,
    exportScenariosJson,
    pickScenariosJson,
  };
}
