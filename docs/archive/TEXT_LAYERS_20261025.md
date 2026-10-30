# 地图文本标注盘点（第一刀，2026-10-25）

> 目标（暮雨）：整个司天所有涉及在地图上标注文本的层，单独做一轮；先保证历史剧本可用。
> 本文件是盘点底稿 + 第一刀记录，不是完成宣告。

## 1. 层清单

| 层 | 画布入口 | 样式来源 | 导出入口 | 状态 |
|---|---|---|---|---|
| 省名 | `ScenarioMap.drawPolityLabels` | `PROVINCE_LABEL_STYLE` | `useScenarioExport` | **已同源** |
| 势力名/简称 | 同上 | `POLITY_LABEL_STYLE` | 同上 | **已同源** |
| 用户地名 | `ScenarioMap.drawLabels` | `mapTextStyles.scenarioLabelTextStyle` | `svgTextAttrsFromStyle` | **第一刀已同源** |
| 标记名 | `ScenarioMap.drawScenarioMarkers` | `mapTextStyles.markerLabelTextStyle` | 同上 | **第一刀已同源** |
| 城镇名（剧本侧） | `ScenarioMap.drawBurgs` | `mapTextStyles.burgLabelTextStyle` | `useScenarioExport`（出版档） | **第二刀已加** |
| 河流名（剧本侧） | `ScenarioMap.drawRivers` | `mapTextStyles.riverLabelTextStyle` | `useScenarioExport`（出版档） | **第二刀已加** |
| 行星侧聚落/地点名 | `composables/planetDrawing.js` | `labelStyles` 预设 | `useFullMapExport` | 部分（未逐层对拍） |
| 区域名 | `AreaMap`（13 处 `fillText`） | `labelStyles` 预设 | `useFullMapExport` | 部分 |
| 区域地名 / 标记名 | `AreaMap` | 各自绘制 | 部分 | 部分 |
| 建筑内部房间/家具名 | `InteriorView`（2 处 `fillText`） | 各自绘制 | 无 | 部分 |
| 图例 / 标题 / 比例尺 | 各画布 | 各自常量 | 各导出 | 样式固定、无用户配置 |

## 2. 第一刀做了什么（2026-10-25）

- 新增 `utils/mapTextStyles.js`：用户地名/标记名的默认色、字号、描边、字体映射单源；
  `svgTextAttrsFromStyle()` 把同一份 style 转 SVG 属性。
- `ScenarioMap.drawLabels` 改走 `drawStyledLabel`（不再裸 `fillText`）：默认浅色字 + 深色描边；
- `ScenarioMap.drawScenarioMarkers` 标记名同样走共享样式（颜色仍跟标记自身色）；
- `useScenarioExport` 的地名/标记名改用同一份 style：
  - 修掉「画布浅字、导出深灰」；
  - 修掉「地名画布左对齐、导出居中」；
  - 修掉「标记名画布在下方、导出在上方 + 写死白色」。
- 用例：`test_148_scenario_text_parity.py`（默认/自定义地名、标记名、源码守卫）。

## 2b. 第二刀（2026-10-25）

- 新增 `utils/scenarioTextPlacement.js`（纯函数）：
  - 城镇名按缩放分级：<1 只标首都；1~2 首都 + 人口前 40；≥2 全部（可见范围内，上限 150）。
  - 河流名：画布 <1.2 不标；1.2~2 流量前 30；≥2 全部（上限 80）。
  - 导出用**出版档**：首都 + 流量前 12 的河（`EXPORT_BURG_TIER` / `EXPORT_RIVER_TIER`）。
  - 河流名落点 = 折线**按长度**的中点，不是顶点数组的中点。
- 画布：`drawBurgs` 加城镇名（首都加粗），`drawRivers` 加河流名；都走 `drawStyledLabel`。
- 导出：同一份分级 + 同一份样式；修掉「617 个城镇名糊满图」。
- **默认关闭**：FMG 导入的城镇/河流名多为英文（Scorcreden/Navarak 等），中文地图上会突然出现；
  画布与导出都受「图层 → 自动地名」开关控制（默认 false），需要时再开。
- 用例：`test_149_scenario_text_tiers`（首都/非首都、前 12 河/无名河、位置、关闭后不出现、源码守卫）；
  `unit/test_scenario_text_placement` 7/7。

## 3. 下一刀（第一轮剩余）

1. **行星 / 区域 / 建筑**：三处仍在各自 `fillText`；统一走 `labelStyles` 预设 + `svgTextAttrsFromStyle`，导出逐层对拍。
2. **重叠避让**：优先级（势力名 > 省名 > 城镇名 > 标记名）+ 简单网格/包围盒避让；先做历史剧本。
3. **用户可调**：地名的 `size/color/stroke` 已有数据字段；补一个「地名/标记名」样式入口（现在只能改单个标签）。
4. **测试**：`test_150`（行星/区域文字层导出对拍）、`test_151`（优先级/避让）。

> 城镇名/河流名的分级已落；行星/区域/建筑文字仍未统一。

> 明确不做（本轮）：把每层文字都做成可拖拽对象；导出逐像素完全一致（允许抗锯齿差异）。

## 4. 阶段结论（2026-10-25）

**历史剧本模块内的文字层已全部同源**：省名、势力名、用户地名、标记名、城镇名、河流名
—— 画布与 SVG/PNG 用同一份样式与分级，`test_148` / `test_149` 守。

**行星 / 区域 / 建筑**的文字层未动：它们属于另外三个模块，按暮雨「先把历史剧本做到勉强可用」的
阶段门，留到历史剧本收口之后再做（不是遗忘，已在本表与方寸卡里记着）。
重叠避让与样式入口也留到那时；本轮历史剧本用「分级 + 数量上限」避免糊图。
