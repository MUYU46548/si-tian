# 文档地图（2026-10-31 整理）

> 一句话：**只有 5 份文档是"现在的"，其余都是历史留底，别再照着做。**

## 现在的（会随代码一起提交）

| 文档 | 什么时候看 |
|---|---|
| [../AGENTS.md](../AGENTS.md) | **接手第一份**：项目是什么、常用命令、红线（不能违反的规矩）、归档索引 |
| [plan/PLAN_AUDIT_20261030.md](plan/PLAN_AUDIT_20261030.md) | **施工总依据**：下一阶段做什么、每阶段的"完成"怎么算 |
| [plan/BREAKPOINT_20261030_n1.md](plan/BREAKPOINT_20261030_n1.md) | **中途接手先读**：做到哪、还差什么、怎么继续、踩过的坑 |
| [plan/INTEGRATION_AUDIT_20261030.md](plan/INTEGRATION_AUDIT_20261030.md) | 模块集成审计（哪些模块真的接上了、哪些没用上） |
| [plan/CHASSIS_BASELINE_20261023.md](plan/CHASSIS_BASELINE_20261023.md) | 性能基线读数（改渲染/交互前后对比用） |

参照件（不是施工令，想知道"当时为什么这么定"时才翻）：
`guides/20261023/`（指南包）、`plan/SITIAN_GUIDE_DIGEST_20261023.md`（仓内对账）、
`agents-archive/`（按主题归档的踩坑与决策，共 10 份）。

## 历史的（2026-10-31 全部移入 `archive/`）

被 `plan/PLAN_AUDIT_20261030.md` 取代的规划/交接/清单共 14 份：
`TODO_REMAINING_20261028`、`REMAINING_BACKLOG_20261027`、`NEXT_STAGE_20261025`、`AUDIT_20261025`、
`SP1025_INTEGRATION_ANALYSIS`、`BASEMAP_READINESS_20261025`、`REIMPORT_019_20261025`、
`TEXT_LAYERS_20261025`、`NEXT_ROUND_20261025`，以及 5 份 `HANDOFF_*`。

它们**不再具备施工效力**，只作为"当时怎么想的"的证据。里面的链接已经批量改到新路径。

## 提交规则（重要）

- `docs/**/*.md` **默认全部进 git**（跟代码一起提交、一起推送）。
- 例外（`.gitignore` 里明确排除的）：`docs/assets/`（从真实地图渲出来的截图，含你的数据）、
  `docs/_*`（一次性诊断产物）。这两类只在本地，不会上远端。
- `build/` 下的一切（一次性脚本、试渲染图、像素基线、断点证据）**都不进 git**，只在本地。

## 清理记录

- 2026-10-30：`build/` 一次性脚本与试渲染目录加入 `.gitignore`（只忽略、不删文件）。
- 2026-10-31：14 份过期规划移入 `docs/archive/`；`AGENTS.md` 的"现行规划"从 10-23 指南包
  改为指向 `PLAN_AUDIT_20261030`；新增本文件。
