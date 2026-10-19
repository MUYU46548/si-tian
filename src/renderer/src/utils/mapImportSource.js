// utils/mapImportSource.js — 「拿到一份 .map 之后」的**共用件**（2026-10-17）
//
// 背景：`.map` 导入此前**只有剧本视图**一条入口（`ScenarioMap.triggerMapImport`），
// 而行星视图的空态提示 / 高度笔刷的「无高度图数据：先导入 Azgaar .map」都指向那个
// **当刻看不见、也不在该视图里**的入口 —— 用户按提示找过去必然找不到（暮雨点名要修的
// 「起步闭环」缺口，与剧本侧 0.2.9 修的「提示指向看不见的入口」是同一类问题）。
//
// 现在两个视图都能导入 `.map`。落库的**容器不同**（剧本 → `baseMaps[key]`；行星 → `mapData[pid]`），
// 但那三件与容器无关、且必须两边完全一致的事放在这里 —— 各写一份的代价不是报错，而是
// 「只有一边留了原文 / 只有一边会剥掉日期后缀」这种**静默不一致**（本仓已踩过多次"两份实现"）：
//   ① 文件名 → 底图名（`desite 2026-09-10.map` → `desite`）
//   ② 原文留底（导入的 `.map` 是"能否重新导入"的唯一凭据；留底失败**绝不阻断**导入）
//   ③ 读文件文本（`File.text()`；留底恢复路径用的是内存里的原文，同一个形状）
//
// ⚠️ 这里刻意**不做**解析与落库：解析器是 `utils/azgaar-parser.js`，
//    落库写口分别是 `store` 的 `importFromScenariosJson`（剧本）与 `importPlanetMapBundle`（行星）。

/**
 * `.map` 文件名 → 底图 / 地图名。
 *
 * 两个处理都是**用户导出习惯**逼出来的：FMG 默认导出名带日期（`desite 2026-09-10.map`），
 * 而司天重启后要按名字找回同一张图 —— 留着日期会让"同一张地图"每次导入都变成新的一张。
 * @param {string} fileName
 */
export function mapNameFromFileName(fileName) {
  return String(fileName || '')
    .replace(/\.map$/i, '')
    .replace(/\s*\d{4}-\d{2}-\d{2}.*$/, '')
    .trim();
}

/**
 * 把导入的 `.map` **原文**留一份。
 *
 * 为什么必须留：司天此前只备份自己的项目文件，**从不留用户导入的 `.map`** —— 而那份文件是
 * 「地形 / 河流 / 道路能否重新导入」的**唯一凭据**。真实损失：`desite` 底图建于 2026-09-10，
 * 当时解析器读不出高度图，等想补时唯一来源就是用户自己还留着的那份导出；那份一丢就没救了。
 *
 * 三条纪律（与 `main/handlers/projectHandler.js#saveBaseMapSource` 的契约一致）：
 *   · **原文**（`text` 原样字节，不重编码）—— 改了就不是凭据；
 *   · **绝不阻断导入**：备份失败只在状态栏留一句，导入照走（数据安全功能不该变成新的失败点）；
 *   · **只读态也备份**：这不改世界观数据，只是留素材（与写闸门管辖范围无关）。
 * @returns {Promise<string>} 给状态栏用的一句话（'' = 没备份/无需提）
 */
export async function backupMapSourceFile(fileName, text) {
  const api = window.sitianAPI;
  if (!api?.saveBaseMapSource || !api?.projectCurrentPath) return '';
  try {
    const cur = await api.projectCurrentPath();
    const projectPath = (cur && cur.success && cur.filePath) || '';
    if (!projectPath) return '（未留底图来源：当前没有已落盘的项目文件）';
    const r = await api.saveBaseMapSource({ projectPath, name: fileName, text });
    if (r && r.success) {
      return `；原始 .map 已留底（${(r.bytes / 1048576).toFixed(1)}MB → 项目备份目录的 basemap-sources/）`;
    }
    return `（原始 .map 留底失败：${(r && r.error) || '未知原因'}）`;
  } catch (e) {
    return `（原始 .map 留底失败：${e.message}）`;
  }
}

/**
 * 取一个「文件形状」的文本（选文件 / 从留底恢复两条入口共用）。
 * 留底恢复传进来的对象是 `{ name, text: async () => string }`，与 `File.text()` 同形。
 * @param {{text: () => Promise<string>}} file
 */
export async function readMapSourceText(file) {
  if (!file) return '';
  if (typeof file.text === 'function') return await file.text();
  return '';
}
