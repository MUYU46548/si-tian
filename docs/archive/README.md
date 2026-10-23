# docs/archive —— 归档文档（历史参考，不是施工依据）

> **为什么有这一层**：指南包 2026-10-23（`docs/guides/20261023/00-…`）要求"文档禁散：不立根目录散件；归档级文档统一挪 `docs/archive/`"。这里是 **2026-10-23 一次性收拢**的旧施工单、各轮交接、专题调研与已落地提案——**只做历史追溯**，不再维护、不再施工。
> **现行口径**：路线与施工序 → `docs/guides/20261023/00-司天-开发指南-20261023.md`；仓内对账与拆解 → `docs/plan/SITIAN_GUIDE_DIGEST_20261023.md`；用户手册 → `docs/SCENARIO_GUIDE.md`。
> **代码/测试里的旧路径引用**：仓库里仍有注释写 `docs/XXX.md`（如 `docs/ROADMAP_NEXT.md`、`docs/SITIAN_V2_BLUEPRINT.md`、`docs/SITIAN_HANDOFF_20261019.md`）。按本表"现名"到本目录找即可，注释不必改（改注释=纯噪音）。

## 迁移映射（2026-10-23）

| 现名（本目录） | 是什么 | 被谁取代 / 为什么归档 |
|---|---|---|
| `SITIAN_HANDOFF_20261017_ROUND3/4/5/6.md`、`SITIAN_HANDOFF_20261018_ROUND7/8/9/10/15/18.md`、`SITIAN_HANDOFF_20261019*.md`、`SITIAN_SESSION_HANDOFF_20261017.md` | 逐轮交接（当时做了什么/踩了什么坑） | 有效结论已进 `AGENTS.md` 与 `docs/agents-archive/`；本包只留历史细节 |
| `SITIAN_PLAN_20261019.md`、`SITIAN_REBUILD_PLAN_20261019.md`、`SITIAN_FULL_DEV_PLAN_20261019.md`、`SITIAN_MODULE_REFORM_PLAN_20261017.md`、`SITIAN_V2_BLUEPRINT.md`、`SITIAN_STATUS_AND_NEXT.md`、`SITIAN_PROGRESS_AND_GAPS_20261017.md` | 各版开发计划/蓝图/状态 | 被 06（中长期计划 v1.2）与 00（2026-10-23 指南）吸收 |
| `SITIAN_BREAKPOINT_20261018.md`、`SITIAN_BREAKPOINT_20261019.md` | 断点复盘（"我修的是我能量到的卡"等） | 病灶账已进 02 手感方案 §二；复盘原文留此 |
| `SITIAN_COST_LEDGER_20261019.md` | 成本账 | 历史 |
| `SITIAN_SPEC_V1.md`、`SITIAN_VAULT_SPEC.md` | 早期规格书（含 vault 提取） | 提取器=烂账，随 M4 重做；读料口径见 `docs/VAULT_BRIDGE.md` |
| `ROADMAP_NEXT.md`、`IMPROVEMENT_BACKLOG.md` | 旧待办清单（大件） | 00 §一 A/B/C 三栏就是新处置；旧清单逐条销或判死 |
| `LEGACY_DATA_INVENTORY.md` | 存量数据清点 | 历史 |
| `PROPOSAL_DISCLAIMER_AND_UI.md` | 免责声明/UI 提案 | 已落地（`test_83`），提案归档 |
| `RELEASE_NOTES_0.1.3.md` | 旧版发布说明 | 历史 |
| `plan/SITIAN_THREE_MODULES_20261020.md` | **三刀序列**（10-22） | 00 §六：序位被 2026-10-23 指南吸收取代（读料桥后移、底盘前置） |
| `AUTO_RIVER_AND_COASTLINE_20261014.md`、`RIVER_ALTERNATIVES/AND_UNFINISHED/FIX6/NODE_EDITING/ROUTING_NEGATIVE_RESULTS/TERRAIN_STRUCTURE/UGLINESS_ROOT_CAUSE/VISUAL_FIX_*.md` | 河流与地形专题（含负面结果） | 结论已进 `docs/agents-archive/map-river-terrain.md`；原文留此防"重新发现" |
| `TERRAIN_RENDER_SMOOTHING_PLAN.md`、`DEVPLAN_LLM_FEED_AND_GALAXY_3D_20261014.md` | 地形平滑 / 星系 3D 提案 | 3D 是终态但排渲染层接口化之后（00 §一 B 栏）；提案留此 |

## 留而不迁（代码/测试注释引用，搬动会制造噪音）

- `docs/SCENARIO_PROVINCE_FIX_PLAN.md`（`provinceEditing.js` 文件头）
- `docs/A1_DATA_MODEL_DECISION.md`（多份 Node 单测/`heightMath.js` 引用）
- `docs/P1_BATCH_BOUNDARY_OPS.md`（`userGuide.js` 引用，且是未做项评估）
- `docs/RIVER_NATURALNESS_AND_RESOLUTION_20261014.md`（`riverTrace.js` / `ScenarioMap.vue` 引用）
- `docs/P0_FIRST_MAP_WALKTHROUGH.md`（M1 终验自测链）
