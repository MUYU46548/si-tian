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
| 城镇名（剧本侧） | 只有圆点/星级 + 悬停浮层，**不画名字** | — | 不导出 | **缺** |
| 河流名（剧本侧） | `drawRivers` 只画线，**不画名字** | — | 不导出 | **缺** |
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

## 3. 下一刀（第一轮剩余）

1. **城镇名（剧本侧）**：数据在 `baseMap.burgs`；画布只在悬停时给浮层。要加常驻名字（缩放分级 + 避让）并在 SVG/PNG 导出。
2. **河流名（剧本侧）**：`rivers[].name` 有就画；没有就跳过（不臆造）；导出同源。
3. **行星 / 区域 / 建筑**：三处仍在各自 `fillText`；统一走 `labelStyles` 预设 + `svgTextAttrsFromStyle`，导出逐层对拍。
4. **重叠避让**：优先级（势力名 > 省名 > 城镇名 > 标记名）+ 简单网格/包围盒避让；先做历史剧本。
5. **用户可调**：地名的 `size/color/stroke` 已有数据字段；补一个「地名/标记名」样式入口（现在只能改单个标签）。
6. **测试**：`test_149`（行星/区域文字层导出对拍）、`test_150`（优先级/避让）。

> 明确不做（本轮）：把每层文字都做成可拖拽对象；导出逐像素完全一致（允许抗锯齿差异）。
