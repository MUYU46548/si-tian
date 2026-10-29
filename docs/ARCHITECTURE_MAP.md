# SiTian 架构地图 (ARCHITECTURE_MAP)

> **用途**：任务开场读一次本文件，替代全仓库盲扫。读完先核对下方锚点（任选 2-3 个），不符以代码为准。
>
> **维护纪律**：
> - 「结构清单」节由 `python scripts/gen_architecture_map.py` 再生成（行数/文件清单 = 快变量，脚本负责）；自检模式 `--check` 只对比不改写。
> - 「职责」列是人工维护的慢变量，再生成时自动保留；新文件出现时补一句职责，删文件时其描述自动消失。
> - 行为规则/陷阱不写在这里，去 AGENTS.md 速查节和 Hermes skill `sitian-development`。
> - 体积红线：全文 ≤200 行。超了先删职责描述的冗余，不删文件行。

## 锚点（2026-09-20 实测）

| 锚点 | 期望值 |
|---|---|
| 结构清单文件数（脚本扫描） | 155 |
| 测试用例数 | 75 |
| store 模块数（geodataModules/） | 6 |
| App.vue 异步面板 | 20 |
| 主进程 IPC handle | 35（含 project-* 8） |
| 版本（package.json） | 0.1.5 |
## 数据流

```
Obsidian vault (E:/图书馆/ROSA/, Markdown 唯一事实源)
  └─ scripts/extract-data.js ──→ E:/图书馆/ROSA/.sitian/geodata.json + mapdata.json (坐标缓存)
       └─ src/main/index.js (IPC: 35 个 handle, 读 vault/写缓存)
            └─ src/preload/index.js (contextBridge → window.sitianAPI)
                 └─ renderer (Vue 3)
                      ├─ App.vue: 七层视图路由 + 面包屑 + 20 个异步面板
                      ├─ store/geodata.js (壳) + store/geodataModules/* (逻辑) + undo.js (历史栈)
                      └─ components/ (按视图层级装配) + composables/ (行星图绘制/交互/编辑器)
```

## 结构清单

<!-- GEN:START -->
| 行数 | 文件 | 职责 |
|---:|---|---|
| 219 | `scripts/add-layer-frontmatter.js` | 给 vault 笔记补 layer frontmatter |
| 234 | `scripts/add-place-type-frontmatter.js` | 给 vault 笔记补 placeType frontmatter |
| 210 | `scripts/audit-coverage.js` | 提取覆盖率审计（只读）：范围内成节点率 + 缺口清单 + 范围外分布，--write-report 落 96 事务管理/ |
| 210 | `scripts/audit-project-size.js` | （待补） |
| 268 | `scripts/audit-reimport-019.mjs` | （待补） |
| 324 | `scripts/clean-cache-junk.js` | .sitian 缓存历史垃圾清理（空名地形 / 空壳底图 / 测试残留节点）：dry-run 报告 + --apply 备份/存档/删除，删除前逐项自检（引用 / 包围盒 / 子节点） |
| 103 | `scripts/emoji_audit.py` | emoji 审计（按文件聚合 + 行号上下文） |
| 1215 | `scripts/extract-data.js` | Obsidian → geodata.json 提取（LAYER_ORDER/增量缓存/UUID/孤儿检测/mergeUserCreatedNodes） |
| 102 | `scripts/gen_architecture_map.py` | 再生成本清单（--check 自检模式） |
| 100 | `scripts/generate-icons.py` | 图标生成 |
| 237 | `scripts/generate_icon.py` | 图标生成 |
| 60 | `scripts/icon_check.py` | 图标一致性校验（引用名是否都在 Icon.vue 中定义） |
| 84 | `scripts/ledger-dryrun.mjs` | （待补） |
| 310 | `scripts/ledger-query.mjs` | 事件账本查询/录入（读 .sitian）：--list 清点、--at/--a/--b 一句话作答、--add [--apply] 先备份后落盘并读回校验 |
| 57 | `scripts/lib/loadRendererUtils.mjs` | 在 Node 里加载渲染层 ESM utils 的 loader（抄到临时目录补 .js 扩展名，跑的仍是仓库源码）；迁移/查询工具共用这一份 |
| 699 | `scripts/lib/vaultClassify.js` | 读料归类纯函数层（第二刀）：整份 frontmatter + 标签 + 结构目录 + 文件名后缀 → 12 类（含待人工），每条带 evidence；空间关系按「显式字段→双链→句式」推断并标 inferred；buildReport/reportToMarkdown 零静默丢失 |
| 410 | `scripts/maint/repair_basemap_data.py` | （待补） |
| 113 | `scripts/migrate-ledger-v2.mjs` | 账本 v2 迁移（默认 dry-run；--apply 先备份 + 写后读回校验）：每代写入 initialOwnership + 物化 changeEvents |
| 180 | `scripts/migrate-mapdata-keys.js` | mapdata.json 旧（无世界前缀）key 清理：dry-run 报告 + --apply 备份/存档/删除 |
| 341 | `scripts/migrate-vault-attrs.js` | **A-1 存量机器属性搬家**（默认 dry-run）：把笔记 frontmatter 的「层级 / 上层挂靠 / 地点类型」搬进 `.sitian`。只补空、不覆盖项目已有值（冲突只报告）、补 parentId 前校验父实体、写前备份 + 反向档；笔记只读。逻辑层 `parseArgs` / `runMigration` 可被用例直调（本仓 node 无法 spawn node） |
| 77 | `scripts/tests/debug_planetmap.py` | PlanetMap 手动诊断脚本 |
| 274 | `scripts/tests/diag_edit_perf.py` | （待补） |
| 158 | `scripts/tests/diag_edit_profile.py` | （待补） |
| 189 | `scripts/tests/diag_ledger_v2.py` | （待补） |
| 232 | `scripts/tests/diag_module_shell.py` | （待补） |
| 361 | `scripts/tests/diag_owner_brush.py` | （待补） |
| 391 | `scripts/tests/diag_province_detail.py` | （待补） |
| 208 | `scripts/tests/diag_river_dup.py` | （待补） |
| 277 | `scripts/tests/diag_river_scan.py` | （待补） |
| 364 | `scripts/tests/diag_t2_save.py` | （待补） |
| 1420 | `scripts/tests/drill_final_acceptance.py` | （待补） |
| 884 | `scripts/tests/drill_p0_first_map.py` | （待补） |
| 341 | `scripts/tests/drill_p1_vertex_marquee.py` | （待补） |
| 295 | `scripts/tests/drill_package_smoke.py` | （待补） |
| 870 | `scripts/tests/drill_quit_flush.py` | （待补） |
| 444 | `scripts/tests/drill_reimport_019.py` | （待补） |
| 427 | `scripts/tests/fixtures/make_vault_fixture.py` | （待补） |
| 161 | `scripts/tests/fixtures/make_vault_fixture_messy.py` | （待补） |
| 39 | `scripts/tests/fixtures/name_map.py` | （待补） |
| 166 | `scripts/tests/lib/cdp.py` | Edge CDP 连接封装（测试基础设施） |
| 531 | `scripts/tests/lib/helpers.py` | 测试公共 helper（世界/行星导航锚定） |
| 163 | `scripts/tests/lib/pngcheck.py` | （待补） |
| 867 | `scripts/tests/run_tests.py` | 测试主控（Edge CDP + mock 注入，用后还原） |
| 99 | `scripts/tests/tools/_audit_unwired.mjs` | （待补） |
| 37 | `scripts/tests/tools/_check_smooth_wired.mjs` | （待补） |
| 8 | `scripts/tests/tools/_crop.py` | （待补） |
| 269 | `scripts/tests/tools/_diag_hollow_river.py` | （待补） |
| 64 | `scripts/tests/tools/_diff_shots.py` | （待补） |
| 90 | `scripts/tests/tools/_fangcun_pipe.mjs` | （待补） |
| 40 | `scripts/tests/tools/_inspect_scenarios.mjs` | （待补） |
| 128 | `scripts/tests/tools/_lab.py` | （待补） |
| 105 | `scripts/tests/tools/_make_brush_gallery.py` | （待补） |
| 200 | `scripts/tests/tools/_probe_1c_area_interior.js` | （待补） |
| 144 | `scripts/tests/tools/_probe_accumulation_compare.mjs` | （待补） |
| 87 | `scripts/tests/tools/_probe_alt_surface.mjs` | （待补） |
| 66 | `scripts/tests/tools/_probe_auto_river_visual.js` | （待补） |
| 238 | `scripts/tests/tools/_probe_baseline_planet_brush.js` | （待补） |
| 125 | `scripts/tests/tools/_probe_baseline_planet_brush.py` | （待补） |
| 218 | `scripts/tests/tools/_probe_baseline_scenario_map.js` | （待补） |
| 42 | `scripts/tests/tools/_probe_basemap_river_ui.js` | （待补） |
| 27 | `scripts/tests/tools/_probe_basemap_source.mjs` | （待补） |
| 63 | `scripts/tests/tools/_probe_bezier_overshoot.js` | （待补） |
| 605 | `scripts/tests/tools/_probe_brush_matrix.py` | （待补） |
| 264 | `scripts/tests/tools/_probe_brush_trails.py` | （待补） |
| 54 | `scripts/tests/tools/_probe_case103_terrain.js` | （待补） |
| 278 | `scripts/tests/tools/_probe_cpu_profile.py` | （待补） |
| 30 | `scripts/tests/tools/_probe_data_sizes.js` | （待补） |
| 39 | `scripts/tests/tools/_probe_endinsea.mjs` | （待补） |
| 51 | `scripts/tests/tools/_probe_fangcun_pipe.mjs` | （待补） |
| 93 | `scripts/tests/tools/_probe_fmg_river_tree.mjs` | （待补） |
| 169 | `scripts/tests/tools/_probe_hotspots_scenario_map.js` | （待补） |
| 100 | `scripts/tests/tools/_probe_ideal_terrain.mjs` | （待补） |
| 60 | `scripts/tests/tools/_probe_import_fidelity.mjs` | （待补） |
| 141 | `scripts/tests/tools/_probe_jank_autoriver.js` | （待补） |
| 228 | `scripts/tests/tools/_probe_jank_real.js` | （待补） |
| 103 | `scripts/tests/tools/_probe_jank_real.py` | （待补） |
| 40 | `scripts/tests/tools/_probe_jank_rescue.py` | （待补） |
| 156 | `scripts/tests/tools/_probe_land_breakdown.js` | （待补） |
| 140 | `scripts/tests/tools/_probe_land_breakdown3.js` | （待补） |
| 84 | `scripts/tests/tools/_probe_land_camera.js` | （待补） |
| 129 | `scripts/tests/tools/_probe_land_clean.js` | （待补） |
| 92 | `scripts/tests/tools/_probe_land_cost.js` | （待补） |
| 200 | `scripts/tests/tools/_probe_land_profile.py` | （待补） |
| 123 | `scripts/tests/tools/_probe_land_readback.js` | （待补） |
| 147 | `scripts/tests/tools/_probe_land_repaint.js` | （待补） |
| 112 | `scripts/tests/tools/_probe_land_sinkoff.js` | （待补） |
| 133 | `scripts/tests/tools/_probe_land_variants.js` | （待补） |
| 135 | `scripts/tests/tools/_probe_least_cost.mjs` | （待补） |
| 75 | `scripts/tests/tools/_probe_map_provinces.mjs` | （待补） |
| 40 | `scripts/tests/tools/_probe_map_segments.mjs` | （待补） |
| 54 | `scripts/tests/tools/_probe_messy_vault.js` | （待补） |
| 125 | `scripts/tests/tools/_probe_module_isolation.py` | （待补） |
| 180 | `scripts/tests/tools/_probe_module_layout.py` | （待补） |
| 94 | `scripts/tests/tools/_probe_one_tool.py` | （待补） |
| 323 | `scripts/tests/tools/_probe_owner_ledger.py` | （待补） |
| 92 | `scripts/tests/tools/_probe_p0_first_map.js` | （待补） |
| 65 | `scripts/tests/tools/_probe_perf.js` | （待补） |
| 92 | `scripts/tests/tools/_probe_phantom.mjs` | （待补） |
| 91 | `scripts/tests/tools/_probe_picker_bleed.py` | （待补） |
| 129 | `scripts/tests/tools/_probe_picker_perf.js` | （待补） |
| 119 | `scripts/tests/tools/_probe_preview_vs_landed.py` | （待补） |
| 408 | `scripts/tests/tools/_probe_rail_widths.py` | （待补） |
| 291 | `scripts/tests/tools/_probe_relief_select.py` | （待补） |
| 276 | `scripts/tests/tools/_probe_relief_trail.py` | （待补） |
| 128 | `scripts/tests/tools/_probe_river_align.mjs` | （待补） |
| 180 | `scripts/tests/tools/_probe_river_branch.py` | （待补） |
| 86 | `scripts/tests/tools/_probe_river_classifier.js` | （待补） |
| 155 | `scripts/tests/tools/_probe_river_edit_perf.py` | （待补） |
| 35 | `scripts/tests/tools/_probe_river_flowdist.js` | （待补） |
| 146 | `scripts/tests/tools/_probe_river_highlight.js` | （待补） |
| 128 | `scripts/tests/tools/_probe_river_reachability.mjs` | （待补） |
| 97 | `scripts/tests/tools/_probe_river_sea_pixels.js` | （待补） |
| 236 | `scripts/tests/tools/_probe_river_selection_visibility.py` | （待补） |
| 118 | `scripts/tests/tools/_probe_river_three_ways.mjs` | （待补） |
| 97 | `scripts/tests/tools/_probe_river_valley.mjs` | （待补） |
| 108 | `scripts/tests/tools/_probe_river_visual.js` | （待补） |
| 40 | `scripts/tests/tools/_probe_river_width.mjs` | （待补） |
| 490 | `scripts/tests/tools/_probe_routing_v2.mjs` | （待补） |
| 99 | `scripts/tests/tools/_probe_save_block.js` | （待补） |
| 60 | `scripts/tests/tools/_probe_save_breakdown_20261019.js` | （待补） |
| 115 | `scripts/tests/tools/_probe_save_gate_20261019.js` | （待补） |
| 107 | `scripts/tests/tools/_probe_save_tick.js` | （待补） |
| 90 | `scripts/tests/tools/_probe_selfbuilt_river.js` | （待补） |
| 69 | `scripts/tests/tools/_probe_setup_keys.py` | （待补） |
| 128 | `scripts/tests/tools/_probe_sink_neighborhood.mjs` | （待补） |
| 154 | `scripts/tests/tools/_probe_stroke_spike.js` | （待补） |
| 108 | `scripts/tests/tools/_probe_terrain_quality.mjs` | （待补） |
| 274 | `scripts/tests/tools/_probe_terrain_structure.mjs` | （待补） |
| 143 | `scripts/tests/tools/_probe_tiebreak.mjs` | （待补） |
| 99 | `scripts/tests/tools/_probe_tree_nav.py` | （待补） |
| 150 | `scripts/tests/tools/_proto_backbone_graft.mjs` | （待补） |
| 254 | `scripts/tests/tools/_proto_downscale.mjs` | （待补） |
| 236 | `scripts/tests/tools/_proto_downscale_threshold.mjs` | （待补） |
| 198 | `scripts/tests/tools/_proto_fill_depressions.mjs` | （待补） |
| 203 | `scripts/tests/tools/_proto_flow_accumulation.mjs` | （待补） |
| 88 | `scripts/tests/tools/_proto_smooth_trace.mjs` | （待补） |
| 86 | `scripts/tests/tools/_proto_upsample.mjs` | （待补） |
| 106 | `scripts/tests/tools/_render_river_compare.mjs` | （待补） |
| 111 | `scripts/tests/tools/_render_terrain_structure.mjs` | （待补） |
| 308 | `scripts/tests/tools/_shot01_handriver_node_dots.js` | （待补） |
| 170 | `scripts/tests/tools/_shot02_autoriver_unpruned.js` | （待补） |
| 125 | `scripts/tests/tools/_shot02b_autoriver_unpruned_zoom.js` | （待补） |
| 117 | `scripts/tests/tools/_shot03_autoriver_pruned.js` | （待补） |
| 110 | `scripts/tests/tools/_shot03b_autoriver_pruned_zoom.js` | （待补） |
| 224 | `scripts/tests/tools/_shot04_autoriver_bend_width.js` | （待补） |
| 216 | `scripts/tests/tools/_shot05_three_rivers_one_color.js` | （待补） |
| 260 | `scripts/tests/tools/_shot06_handriver_preview_taper.js` | （待补） |
| 225 | `scripts/tests/tools/_shot07_handriver_handles.js` | （待补） |
| 70 | `scripts/tests/tools/_shot_basemap_mode.py` | （待补） |
| 165 | `scripts/tests/tools/_shot_owner_and_river_20261020.py` | （待补） |
| 521 | `scripts/tests/tools/_shot_planet_20261017.py` | （待补） |
| 270 | `scripts/tests/tools/_shot_river_eraser_20261018.py` | （待补） |
| 49 | `scripts/tests/tools/_shot_save.js` | （待补） |
| 74 | `scripts/tests/tools/_shot_stats.py` | （待补） |
| 434 | `scripts/tests/tools/_shot_story_20261017.py` | （待补） |
| 331 | `scripts/tests/tools/_shot_story_real_20261017.py` | （待补） |
| 207 | `scripts/tests/tools/alias_fixture_names.py` | （待补） |
| 65 | `scripts/tests/tools/compare_river_opts.py` | （待补） |
| 281 | `scripts/tests/tools/diag_rivers.py` | （待补） |
| 93 | `scripts/tests/tools/dump_river_clip.mjs` | （待补） |
| 50 | `scripts/tests/tools/dump_river_flows.mjs` | （待补） |
| 51 | `scripts/tests/tools/dump_river_network.mjs` | （待补） |
| 122 | `scripts/tests/tools/extract_map_grid.mjs` | （待补） |
| 102 | `scripts/tests/tools/fangcun_pipe.py` | （待补） |
| 92 | `scripts/tests/tools/probe_landmass_frames.mjs` | （待补） |
| 367 | `scripts/tests/tools/render_landmass_preview.mjs` | （待补） |
| 111 | `scripts/tests/tools/sweep_rivers.py` | （待补） |
| 173 | `scripts/tests/unit/test_basemap_identity.js` | （待补） |
| 359 | `scripts/tests/unit/test_basemap_source_backup.js` | （待补） |
| 283 | `scripts/tests/unit/test_brush_province.js` | 笔刷建省几何单测（11 条）：面积 = 2rL+πr²（±10%）、与已有省份交集为 0、环形笔迹保住洞、all-covered / too-thin 拒绝零副作用、确定性、反向探针（判据不空转） |
| 134 | `scripts/tests/unit/test_color_util.js` | （待补） |
| 195 | `scripts/tests/unit/test_culture_derive.js` | （待补） |
| 226 | `scripts/tests/unit/test_disclaimer.js` | （待补） |
| 278 | `scripts/tests/unit/test_entity_status.js` | （待补） |
| 233 | `scripts/tests/unit/test_export_frames.js` | （待补） |
| 168 | `scripts/tests/unit/test_fmg_heightmap.js` | （待补） |
| 184 | `scripts/tests/unit/test_freehand_ring.js` | 自由绘制几何单测：干净/手抖方框、圆、8 字、回勾、一条线、确定性、幂等 |
| 220 | `scripts/tests/unit/test_galaxy_layout.js` | （待补） |
| 186 | `scripts/tests/unit/test_git_credential_store.js` | （待补） |
| 425 | `scripts/tests/unit/test_git_sync.js` | （待补） |
| 209 | `scripts/tests/unit/test_grid_outline.js` | （待补） |
| 214 | `scripts/tests/unit/test_hand_edits.js` | （待补） |
| 225 | `scripts/tests/unit/test_heightmap_access.js` | （待补） |
| 206 | `scripts/tests/unit/test_heightmap_channels.js` | （待补） |
| 433 | `scripts/tests/unit/test_heightmap_resample.js` | （待补） |
| 180 | `scripts/tests/unit/test_interaction_gate.js` | （待补） |
| 121 | `scripts/tests/unit/test_iso_contours.js` | （待补） |
| 182 | `scripts/tests/unit/test_label_layout.js` | （待补） |
| 166 | `scripts/tests/unit/test_label_zoom.js` | （待补） |
| 333 | `scripts/tests/unit/test_landmass.js` | （待补） |
| 509 | `scripts/tests/unit/test_ledger_core.js` | （待补） |
| 368 | `scripts/tests/unit/test_main_module_wiring.js` | Node 单元测试：主进程**模块接线不变式**（index.js 里用到的本地模块导出必须已解构 / 解构了必须真导出）+ config.js 的 loadConfig 读回校验（漏解构只在 IPC 被调用时抛 ReferenceError，启动不报错） |
| 138 | `scripts/tests/unit/test_marker_hit.js` | （待补） |
| 404 | `scripts/tests/unit/test_migrate_attrs.js` | Node 单元测试：A-1 搬家工具的纯函数（认亲归一化 / 只补空 / 冲突不覆盖 / 父实体校验）+ **真落盘端到端**（dry-run 不写、apply 补属性并落备份与反向档、笔记未动）+ 跨实现 `normalizeRelPath` 逐字符一致性守卫 |
| 174 | `scripts/tests/unit/test_note_target.js` | （待补） |
| 197 | `scripts/tests/unit/test_place_types.js` | （待补） |
| 263 | `scripts/tests/unit/test_planet_map_bundle.js` | （待补） |
| 322 | `scripts/tests/unit/test_polity_labels.js` | Node 单元测试：历史剧本势力标注的分级判定 / 面积形心（含退化环不许出 NaN）/ 面积加权聚合 / 文本选择（abbr 无则回落全名、绝不截断）/ 屏上面积门槛，9 条 |
| 265 | `scripts/tests/unit/test_polygon_bool.js` | （待补） |
| 384 | `scripts/tests/unit/test_project_io.js` | Node 单元测试：`.sitian` 路径守卫 / 原子写 / 备份轮转 / 8 个 IPC 通道端到端（CDP 用例的 mock 测不到主进程 I/O） |
| 184 | `scripts/tests/unit/test_project_plain.js` | （待补） |
| 285 | `scripts/tests/unit/test_project_size.js` | （待补） |
| 279 | `scripts/tests/unit/test_province_hit_index.js` | 省份命中索引单测（8 条）：与朴素扫描 3000 点逐点对拍 0 处不一致、压叠取最上层、洞/飞地、空表与 NaN、巨型表路径、按 terrain 引用缓存、500 省性能底价、反向探针（正序必须被抓住） |
| 231 | `scripts/tests/unit/test_province_overlap.js` | （待补） |
| 490 | `scripts/tests/unit/test_province_shape.js` | （待补） |
| 110 | `scripts/tests/unit/test_ridges.js` | （待补） |
| 688 | `scripts/tests/unit/test_river_coastline.js` | （待补） |
| 637 | `scripts/tests/unit/test_river_editor_nodes.js` | （待补） |
| 179 | `scripts/tests/unit/test_river_erase.js` | （待补） |
| 217 | `scripts/tests/unit/test_river_ribbon.js` | （待补） |
| 114 | `scripts/tests/unit/test_river_width_factors.js` | （待补） |
| 90 | `scripts/tests/unit/test_river_widths.js` | （待补） |
| 195 | `scripts/tests/unit/test_save_status_text.js` | （待补） |
| 232 | `scripts/tests/unit/test_scenario_cards.js` | （待补） |
| 497 | `scripts/tests/unit/test_scenario_dates.js` | （待补） |
| 293 | `scripts/tests/unit/test_scenario_event_ledger.js` | 事件账本纯函数单测（10 组）：录入校验、[from,to) 语义、同日多事件、跨年/跨代、非对称关系、冲突去重、纯函数不改入参、文本日期 |
| 155 | `scripts/tests/unit/test_scenario_groups.js` | （待补） |
| 133 | `scripts/tests/unit/test_scenario_ledger.js` | （待补） |
| 143 | `scripts/tests/unit/test_scenario_ledger_v2.js` | （待补） |
| 462 | `scripts/tests/unit/test_scenario_slices.js` | （待补） |
| 124 | `scripts/tests/unit/test_scenario_text_placement.js` | （待补） |
| 188 | `scripts/tests/unit/test_sea_depth.js` | （待补） |
| 256 | `scripts/tests/unit/test_skeleton_index.js` | （待补） |
| 93 | `scripts/tests/unit/test_stroke_math.js` | （待补） |
| 333 | `scripts/tests/unit/test_system3d_scene.js` | （待补） |
| 356 | `scripts/tests/unit/test_terrain_params.js` | （待补） |
| 200 | `scripts/tests/unit/test_terrain_representation.js` | Node 单测：地形表示判定 13 条（空/损坏高度图、覆盖物开合、编辑与笔刷强制显示、**无高度图 → 多边形照旧不透明**＝兼容底线、与 `heightmapAccess.hasGrid` 的口径蕴含关系） |
| 464 | `scripts/tests/unit/test_terrain_structure.js` | （待补） |
| 137 | `scripts/tests/unit/test_text_on_path.js` | （待补） |
| 369 | `scripts/tests/unit/test_undefined_identifiers.js` | （待补） |
| 162 | `scripts/tests/unit/test_user_guide.js` | （待补） |
| 191 | `scripts/tests/unit/test_vault_classify.js` | 读料归类单测：12 类信号、结构优先、零静默丢失守恒、三档空间推断、只读快照、通用提取、输出目录守卫 |
| 160 | `scripts/tests/unit/test_vault_frontmatter_noise.js` | （待补） |
| 188 | `scripts/tests/unit/test_vault_index.js` | 索引单测：walk/增量/候选/containment/搜索/阅读器/附件/接线 |
| 107 | `scripts/tests/unit/test_vault_index_watcher.js` | （待补） |
| 219 | `scripts/tests/unit/test_vault_relink.js` | Node 单元测试：笔记改名断线检测与候选打分（路径归一化 / 最长公共子串 / 推荐线 / 占用过滤 / 异常输入）—— 纯函数层，CDP 用例覆盖不到的判据粒度 |
| 301 | `scripts/tests/unit/test_vertex_sharing.js` | （待补） |
| 347 | `scripts/tests/unit/test_voronoi_batch.js` | （待补） |
| 359 | `scripts/tests/unit/test_vue_ref_unwrap.js` | （待补） |
| 80 | `scripts/tools_migrate_planetdrawing.py` | 一次性迁移工具（planetDrawing 拆分） |
| 59 | `scripts/tools_migrate_planethittest.py` | 一次性迁移工具（planetHitTest 拆分） |
| 197 | `scripts/vault-scan.mjs` | 读料桥命令行（只读）：全库归类 + 待人工清单 + 可选 geodata 试导；输出目录库内拒绝，跑完对比库指纹 |
| 114 | `src/main/config.js` | userData/config.json 读写（VAULT_PATH、closeQuitsApp、windowMode、currentBaseMapKey、lastProjectPath）：loadConfig 必须把每个键**读回内存**（只写不读 = 每次启动丢配置） |
| 141 | `src/main/gitCredentialStore.js` | （待补） |
| 180 | `src/main/handlers/exportFramesHandler.js` | （待补） |
| 653 | `src/main/handlers/gitSyncHandler.js` | （待补） |
| 649 | `src/main/handlers/projectHandler.js` | `.sitian` 项目文件 I/O：原子写 + 旧文件备份轮转 + 8 个 `project-*` IPC（顶层不依赖 electron，供 Node 单元测试） |
| 1121 | `src/main/index.js` | 主进程入口：28 个 IPC handle + 窗口/单实例锁/关闭拦截 |
| 115 | `src/main/noteTarget.js` | （待补） |
| 129 | `src/main/tray.js` | 托盘图标（多分辨率 ico）+ 菜单 |
| 105 | `src/main/updater.js` | electron-updater 自动更新 |
| 285 | `src/main/vault-watcher.js` | Obsidian vault 文件变更监听 |
| 601 | `src/main/vaultIndex.js` | 全库只读索引（D1/D2 + 第二刀归类）：walkMarkdown/增量指纹、条目带 classification（整份 frontmatter 启发归类）、discoverCandidates/classifyReport、containment 读笔记/附件、搜索/解析链接 |
| 79 | `src/main/vaultIndexWatcher.js` | 知识库索引 watcher：文件变更 → 250ms 防抖 → 增量重建索引并通知渲染层 |
| 234 | `src/preload/index.js` | contextBridge 暴露 sitianAPI（版本号读 asar 内 package.json） |
| 2694 | `src/renderer/src/App.vue` | 全局布局 + 七层视图路由 + 面包屑 + 20 个低频面板异步挂载 + 只读徽标（决策 1 终态：世界视图也能看到「只读 · 未打开项目」并可点达项目面板） |
| 722 | `src/renderer/src/components/AboutPanel.vue` | 关于面板 + 检查更新 + 卸载入口 |
| 2640 | `src/renderer/src/components/AreaMap.vue` | 区域地图（行星下钻）：区域多边形/道路/标记/文本/建筑内部入口 |
| 271 | `src/renderer/src/components/BatchImportPanel.vue` | 批量导入面板 |
| 173 | `src/renderer/src/components/BookmarkPanel.vue` | 书签面板 |
| 29 | `src/renderer/src/components/BrandMark.vue` | 品牌标志（土星环系剪影 SVG，几何与 build/icon.svg 同源，fill 走 currentColor 跟随父级） |
| 63 | `src/renderer/src/components/CanvasSkeleton.vue` | 画布加载骨架屏 |
| 235 | `src/renderer/src/components/ChangeLog.vue` | 更新日志面板 |
| 247 | `src/renderer/src/components/ClusterPanel.vue` | 地点簇面板（框选成簇/解散/聚焦） |
| 112 | `src/renderer/src/components/ContextMenu.vue` | 画布右键菜单 |
| 177 | `src/renderer/src/components/DerivePanel.vue` | （待补） |
| 244 | `src/renderer/src/components/DisclaimerDialog.vue` | （待补） |
| 417 | `src/renderer/src/components/EagleEye.vue` | 鹰眼小地图 |
| 516 | `src/renderer/src/components/EntityCreator.vue` | 实体创建向导（C 方案分派式）：表单「名称/层级/父级」+ 层级按父级过滤（CHILD_LAYERS）+ 创建后结果卡片（分派步骤 + 「前往编辑」） |
| 238 | `src/renderer/src/components/FmgPanel.vue` | （待补） |
| 2093 | `src/renderer/src/components/GalaxyMap.vue` | 星域地图：深空风格背景 + 星系聚簇 + 跨星域航道 |
| 552 | `src/renderer/src/components/GitSyncPanel.vue` | （待补） |
| 231 | `src/renderer/src/components/GuidePanel.vue` | （待补） |
| 231 | `src/renderer/src/components/HistoryPanel.vue` | undo 历史面板 |
| 180 | `src/renderer/src/components/Icon.vue` | 内联 SVG 图标组件：模板 `v-if` 分支按名匹配，零外部依赖、继承 currentColor；引用名由 scripts/icon_check.py 校验 |
| 1913 | `src/renderer/src/components/InteriorView.vue` | 建筑内部：楼层切换 + 家具放置 |
| 269 | `src/renderer/src/components/KeyboardShortcuts.vue` | 快捷键说明面板 |
| 425 | `src/renderer/src/components/LandmassPanel.vue` | （待补） |
| 117 | `src/renderer/src/components/LayerPanel.vue` | 图层可见性面板 |
| 2433 | `src/renderer/src/components/NodeDetailPanel.vue` | 节点详情（正文/层级迁移/定位；含 space_marker、fleet_card 伪节点适配） |
| 147 | `src/renderer/src/components/NotePicker.vue` | （待补） |
| 240 | `src/renderer/src/components/NoteReader.vue` | （待补） |
| 171 | `src/renderer/src/components/NoteSearchPanel.vue` | （待补） |
| 391 | `src/renderer/src/components/ObjectListPanel.vue` | 对象列表面板 |
| 307 | `src/renderer/src/components/OnboardingGuide.vue` | 首启引导（含选 Obsidian 库入口） |
| 162 | `src/renderer/src/components/PanelShell.vue` | 面板通用外壳（标题/关闭/拖拽） |
| 4558 | `src/renderer/src/components/PlanetMap.vue` | 行星地图（最大组件）：地形/聚落/批量操作，装配 22 个 composables；**读片段勿整读** |
| 1350 | `src/renderer/src/components/ProjectPanel.vue` | 项目面板：新建（空项目 / **以知识库为基底新建并导入**）/打开/保存/备份/关闭 + 实体树（改名/两段式删除/拖动改父级/父级下拉，全走 undo）+ 快照回滚；只依赖 projectStore + canvasBridge |
| 159 | `src/renderer/src/components/PromptDialog.vue` | 自定义对话框（替代被禁的 prompt()） |
| 266 | `src/renderer/src/components/RecoveryPanel.vue` | 崩溃恢复面板（快照回滚） |
| 41 | `src/renderer/src/components/RichText.vue` | （待补） |
| 499 | `src/renderer/src/components/ScenarioLineagePanel.vue` | P2 势力谱系管理面板：可视化纠正 polity.successorOf / lineage 与显式易主年份（纯展示 + emit，写入交给父级） |
| 14206 | `src/renderer/src/components/ScenarioMap.vue` | 剧本地图全屏工作台：底图省份绘制/拆分合并/顶点编辑（贝塞尔切线手柄 + 海岸线吸附 + 网格吸附）、剧本时间轴与势力染色、FMG .map 数据图层（陆海底色/地形高度/温度/降水栅格 + 河流/道路 + 文化/宗教着色与图例）、城镇图层与右键属性面板、PNG 导出 |
| 405 | `src/renderer/src/components/ScenarioPicker.vue` | （待补） |
| 289 | `src/renderer/src/components/ScenarioSliceExport.vue` | （待补） |
| 511 | `src/renderer/src/components/ScenarioTimeline.vue` | 历史剧本时间轴组件：按年比例/等宽双轴向轨道、游标拖动、时代块点击、键盘导航、播放控制（状态由父级持有，多 v-model 同步） |
| 624 | `src/renderer/src/components/SearchBar.vue` | 全局搜索（store/geodataModules/search.js） |
| 1850 | `src/renderer/src/components/SettingsPanel.vue` | 设置面板（选库/关闭行为/窗口模式） |
| 147 | `src/renderer/src/components/SnapshotPanel.vue` | 版本快照面板 |
| 106 | `src/renderer/src/components/StatusBar.vue` | 状态栏 |
| 859 | `src/renderer/src/components/System3DView.vue` | （待补） |
| 1383 | `src/renderer/src/components/SystemDetailView.vue` | 单恒星系地图：恒星居中 + 轨道 + 邻系箭头 + 太空标记/部队卡片 |
| 917 | `src/renderer/src/components/SystemView.vue` | 域内恒星系总览（真 hyperlanes） |
| 383 | `src/renderer/src/components/TerrainGenPanel.vue` | （待补） |
| 263 | `src/renderer/src/components/TerrainLabelsPanel.vue` | （待补） |
| 128 | `src/renderer/src/components/TreeItem.vue` | 树形导航节点项 |
| 130 | `src/renderer/src/components/TreeNavigation.vue` | 树形导航面板 |
| 407 | `src/renderer/src/components/UpdateNotification.vue` | 更新可用提示 |
| 172 | `src/renderer/src/components/VaultLoreSection.vue` | （待补） |
| 418 | `src/renderer/src/components/WorldSelector.vue` | 世界卡片选择（第一层） |
| 93 | `src/renderer/src/components/ZoomControls.vue` | 缩放控件 |
| 59 | `src/renderer/src/components/ui/button/Button.vue` | （待补） |
| 1 | `src/renderer/src/components/ui/button/index.js` | （待补） |
| 14 | `src/renderer/src/components/ui/card/Card.vue` | （待补） |
| 11 | `src/renderer/src/components/ui/card/CardContent.vue` | （待补） |
| 11 | `src/renderer/src/components/ui/card/CardDescription.vue` | （待补） |
| 11 | `src/renderer/src/components/ui/card/CardHeader.vue` | （待补） |
| 11 | `src/renderer/src/components/ui/card/CardTitle.vue` | （待补） |
| 5 | `src/renderer/src/components/ui/card/index.js` | （待补） |
| 23 | `src/renderer/src/components/ui/dialog/Dialog.vue` | （待补） |
| 14 | `src/renderer/src/components/ui/dialog/DialogClose.vue` | （待补） |
| 77 | `src/renderer/src/components/ui/dialog/DialogContent.vue` | （待补） |
| 12 | `src/renderer/src/components/ui/dialog/DialogDescription.vue` | （待补） |
| 11 | `src/renderer/src/components/ui/dialog/DialogFooter.vue` | （待补） |
| 11 | `src/renderer/src/components/ui/dialog/DialogHeader.vue` | （待补） |
| 16 | `src/renderer/src/components/ui/dialog/DialogOverlay.vue` | （待补） |
| 12 | `src/renderer/src/components/ui/dialog/DialogTitle.vue` | （待补） |
| 14 | `src/renderer/src/components/ui/dialog/DialogTrigger.vue` | （待补） |
| 9 | `src/renderer/src/components/ui/dialog/index.js` | （待补） |
| 2412 | `src/renderer/src/composables/planetDrawing.js` | 行星图 Canvas 绘制全集（createPlanetDrawing getState 工厂） |
| 223 | `src/renderer/src/composables/planetHitTest.js` | 行星图命中检测 |
| 751 | `src/renderer/src/composables/planetInteractions.js` | 行星图交互回调（createPlanetInteractions getState 工厂） |
| 56 | `src/renderer/src/composables/spaceBackground.js` | 深空背景绘制（GalaxyMap 专用） |
| 113 | `src/renderer/src/composables/systemOrbit.js` | 恒星轨道布局计算 |
| 150 | `src/renderer/src/composables/useAutoRegions.js` | 基于 region 子地点凸包自动生成区域边界 + 迷雾 |
| 187 | `src/renderer/src/composables/useBatchArrange.js` | 批量排列（网格/圆形/对齐/分布/移入区域） |
| 120 | `src/renderer/src/composables/useBatchSelection.js` | 多选/框选 + 批量属性应用 |
| 78 | `src/renderer/src/composables/useBookmarks.js` | 书签逻辑 |
| 787 | `src/renderer/src/composables/useCanvasRenderer.js` | 渲染引擎：viewTransform/rAF/拖拽平移模式切换 |
| 181 | `src/renderer/src/composables/useClusterEditor.js` | 地点簇编辑器 |
| 61 | `src/renderer/src/composables/useContextMenu.js` | 右键菜单状态 |
| 66 | `src/renderer/src/composables/useFocusHighlight.js` | 定位高亮（金色脉冲光圈 + 十字） |
| 556 | `src/renderer/src/composables/useFullMapExport.js` | 全图 PNG 导出（离屏 canvas 重绘 + 比例尺） |
| 53 | `src/renderer/src/composables/useInlineEdit.js` | 双击画布文本原位编辑 |
| 102 | `src/renderer/src/composables/useKeyboardShortcuts.js` | 键盘快捷键（方向键微调/Ctrl+CVD/Esc） |
| 94 | `src/renderer/src/composables/useMarkerEditor.js` | 标记属性编辑器 |
| 97 | `src/renderer/src/composables/useNodeNavigation.js` | 节点跳转定位 |
| 78 | `src/renderer/src/composables/useObjectPanel.js` | 对象面板（聚焦/重命名/删除） |
| 34 | `src/renderer/src/composables/usePanelManager.js` | 本地面板单开互斥 + 与 App 层浮层互斥 |
| 186 | `src/renderer/src/composables/usePlanetChannelBrush.js` | （待补） |
| 538 | `src/renderer/src/composables/usePlanetHeightBrush.js` | PlanetMap 高度图笔刷（抬高/降低/平滑 + 生物群系涂抹）：stroke 快照式「一次拖动 = 一条 undo」 |
| 73 | `src/renderer/src/composables/usePromptDialog.js` | 对话框状态（替代 prompt()） |
| 175 | `src/renderer/src/composables/useProvinceBrush.js` | 省份笔刷状态 + 画布渲染（Phase 3）：格用 roundRect+blur 消体素感、省界走缓存（提取+Chaikin 后按版本号复用）；只渲染不改数据 |
| 71 | `src/renderer/src/composables/useProvinceEditor.js` | 省份(地形块)属性编辑器 |
| 116 | `src/renderer/src/composables/useProvinceSplitMerge.js` | 省份拆分（切割线）/合并（凸包） |
| 228 | `src/renderer/src/composables/useReferenceImage.js` | 区域参考图 + 比例尺校准 |
| 50 | `src/renderer/src/composables/useRegionEditor.js` | 区域属性编辑器 |
| 354 | `src/renderer/src/composables/useReliefBrush.js` | 地貌图标散布笔刷（左键散布/右键擦除/滚轮调间距），散布交由 utils/reliefIcons.js，一次拖动 = 一条 undo |
| 92 | `src/renderer/src/composables/useRouteEditor.js` | 路线编辑（描点/虚线/偏移） |
| 82 | `src/renderer/src/composables/useRuler.js` | 标尺/指北针/比例尺（localStorage 持久化） |
| 38 | `src/renderer/src/composables/useSaveDisplay.js` | （待补） |
| 1008 | `src/renderer/src/composables/useScenarioExport.js` | 剧本导出/导入：SVG 矢量图 + PNG（由 SVG 光栅化，两者永远一致）+ scenarios.json 全量数据（含导出前体检与 merge/replace 导入） |
| 59 | `src/renderer/src/composables/useSnapshotPanel.js` | 快照拍摄/恢复/删除 |
| 85 | `src/renderer/src/composables/useStatusBar.js` | 状态栏逻辑 |
| 779 | `src/renderer/src/composables/useTerrainCanvasBrush.js` | 画布地形涂色笔刷：与高度图**同一网格几何**（同格宽同原点），terrainGrid 持久化必须走普通数组 |
| 46 | `src/renderer/src/composables/useTextEditor.js` | 文本标签编辑器 |
| 35 | `src/renderer/src/composables/useTheme.js` | 主题切换 |
| 38 | `src/renderer/src/composables/useZoomControls.js` | 缩放百分比联动 |
| 118 | `src/renderer/src/dev-standalone.js` | DEV-only 浏览器兜底：无 Electron preload 时从 `/dev-data/*.json` 只读装载，写操作一律返回失败（绝不制造「已保存」假象）；生产构建被摇掉 |
| 9 | `src/renderer/src/lib/utils.js` | （待补） |
| 33 | `src/renderer/src/main.js` | renderer 入口 |
| 127 | `src/renderer/src/store/canvasBridge.js` | 画布↔项目文件**唯一接线点**（Phase 2.4）：双向注册表 —— geodata 注册画布适配器（applyProject/releaseProject/refreshEntities/exportCanvas），projectStore 注册入水口（syncFromCanvas）。两个 store 不互相 import（防循环依赖与两套事实源） |
| 2190 | `src/renderer/src/store/geodata.js` | store 壳：defineStore + 装配 6 个 geodataModules + 视图导航 + 项目↔画布接线（画布适配器注册；项目模式下行星图不回退知识库缓存） |
| 241 | `src/renderer/src/store/geodataModules/areaEditing.js` | areaZones/areaReferenceImages 增删改（走 undo） |
| 289 | `src/renderer/src/store/geodataModules/channelBrush.js` | （待补） |
| 318 | `src/renderer/src/store/geodataModules/interior.js` | interiorData 楼层/家具管理 |
| 1111 | `src/renderer/src/store/geodataModules/mapDataEditing.js` | mapData：地形/标记/路线/文本/快照编辑（最大模块） |
| 2648 | `src/renderer/src/store/geodataModules/provinceEditing.js` | 省份「归属标签网格」store 模块（Phase 3）：笔刷/套索一笔一条 undo、删除省份重编号安全（整表快照）、每个写操作先过 guardWrite（只读态零副作用） |
| 4880 | `src/renderer/src/store/geodataModules/scenarioEditing.js` | 剧本数据模块：baseMaps（省份/参考图）与 scenarios（polities/ownership/labels/markers）CRUD + 继承拷贝，全部经 execute 走 undo |
| 186 | `src/renderer/src/store/geodataModules/search.js` | matchNode 搜索匹配 |
| 159 | `src/renderer/src/store/geodataModules/spaceEditing.js` | spaceMarkers/fleetCards/hyperlanes 编辑 |
| 185 | `src/renderer/src/store/layers.js` | 图层可见性栈 |
| 39 | `src/renderer/src/store/panels.js` | App 层浮层互斥 |
| 1123 | `src/renderer/src/store/projectStore.js` | `.sitian` 项目 store：项目 CRUD + 实体 CRUD（走 undo）+ 快照回滚 + **从知识库导入**（createProjectFromVault：先 prepareExport 补齐行星图，再创建项目并播种） |
| 43 | `src/renderer/src/store/quitFlush.js` | （待补） |
| 172 | `src/renderer/src/store/undo.js` | undo/redo 栈（execute 内即调 redo，防双写） |
| 190 | `src/renderer/src/store/vaultIndex.js` | 资料索引 store：状态/候选/读料报告/搜索/阅读/链解析；所有磁盘 I/O 走主进程 vault* IPC |
| 256 | `src/renderer/src/store/writeGate.js` | 单一写闸门：世界观数据落盘写的唯一判定（guardWrite/isReadOnly，三模式 project|legacy|readonly）+ 11 条落盘入口清单 |
| 63 | `src/renderer/src/utils/align.js` | 对齐/分布纯函数 |
| 616 | `src/renderer/src/utils/azgaar-parser.js` | Azgaar FMG .map 解析器：按内容嗅探定位各数据段（不写死行号）、grid 级高度/温度/降水数组、provincesBody/河流/道路 SVG 几何、文化/宗教/势力/城镇定义与 province→burg→culture 映射 |
| 277 | `src/renderer/src/utils/basemapIdentity.js` | （待补） |
| 166 | `src/renderer/src/utils/brushProvince.js` | 笔刷建省的纯几何层（2026-10-22）：笔迹 → 圆盘∪胶囊并集 → **减掉已有省份**（新省只长在空地上，不弹确认框）；拒绝分支零副作用（all-covered / too-thin）；引擎注入式，Node 单测用真 `polygon-clipping` |
| 322 | `src/renderer/src/utils/canvasIcon.js` | Canvas 端矢量图标（Path2D 复刻 Icon.vue 几何 + 旧 emoji 数据回退） |
| 44 | `src/renderer/src/utils/clipboard.js` | 复制/粘贴/克隆 |
| 258 | `src/renderer/src/utils/coastline.js` | （待补） |
| 162 | `src/renderer/src/utils/colorUtil.js` | （待补） |
| 367 | `src/renderer/src/utils/contour.js` | 离散标量场轮廓提取（marching squares 简化版）+ RDP 简化 + 凸包；生物群系/海岸线图层可视化用 |
| 323 | `src/renderer/src/utils/cultureDerive.js` | （待补） |
| 204 | `src/renderer/src/utils/deriveClient.js` | 派生计算的 Worker 客户端：单例生命周期 + 拷贝后再转移（不能转移主线程原数组）+ 防抖合并 + 失败降级同步 |
| 212 | `src/renderer/src/utils/dirtyRect.js` | 笔刷脏矩形追踪：只清脏区 + 裁剪重绘，与全画布重绘逐像素等价（无接缝/残影） |
| 293 | `src/renderer/src/utils/disclaimer.js` | （待补） |
| 112 | `src/renderer/src/utils/entityStatus.js` | （待补） |
| 113 | `src/renderer/src/utils/errorReport.js` | 全局错误捕获 + 主进程落盘 |
| 295 | `src/renderer/src/utils/floodfill.js` | 泛洪填充（地形快速绘制） |
| 418 | `src/renderer/src/utils/fmg/generator.js` | （待补） |
| 187 | `src/renderer/src/utils/fmg/index.js` | （待补） |
| 89 | `src/renderer/src/utils/fmg/lattice.js` | （待补） |
| 71 | `src/renderer/src/utils/fmg/rng.js` | （待补） |
| 258 | `src/renderer/src/utils/fmg/templates.js` | （待补） |
| 195 | `src/renderer/src/utils/freehandRing.js` | 自由绘制闭环净化（第三刀）：自交检测、在自交点切环只留最大一块、面积/填充比闸门；拒绝原因给人话（不造怪多边形、不引布尔库） |
| 279 | `src/renderer/src/utils/galaxyLayout.js` | （待补） |
| 162 | `src/renderer/src/utils/geojson.js` | GeoJSON 导入导出 |
| 484 | `src/renderer/src/utils/geometry.js` | 凸包/多边形拆分合并/点包含判定 |
| 250 | `src/renderer/src/utils/gridOutline.js` | 栅格标签网格 → 平滑矢量闭合轮廓（**纯函数**：CSR 边界走链 + 共线塌缩 + 闭环 RDP + Chaikin；地形涂色/生物群系的反马赛克渲染靠它，回归 test_59 + Node 单测） |
| 104 | `src/renderer/src/utils/gridSpatialIndex.js` | （待补） |
| 252 | `src/renderer/src/utils/handEdits.js` | （待补） |
| 282 | `src/renderer/src/utils/heightMath.js` | 高度/温度/降水/生物群系派生**纯函数**（唯一事实源：主线程与 deriveWorker 共用，禁止在别处复制公式） |
| 44 | `src/renderer/src/utils/heightThumb.js` | （待补） |
| 229 | `src/renderer/src/utils/heightmapAccess.js` | （待补） |
| 105 | `src/renderer/src/utils/heightmapChannels.js` | （待补） |
| 567 | `src/renderer/src/utils/heightmapRaster.js` | 高度图 → 离屏栅格（**M2/A2 跨视图共享**：ScenarioMap 底图图层与 PlanetMap「着色」档位**同一套**色带与构建逻辑；含 `createRasterCache()` 工厂 —— 缓存失效时机由调用方决定，PlanetMap 用内容指纹 `hashLabels`） |
| 387 | `src/renderer/src/utils/heightmapResample.js` | （待补） |
| 41 | `src/renderer/src/utils/iconSvg.js` | 字符串上下文（innerHTML）用的图标 SVG 助手 |
| 141 | `src/renderer/src/utils/interactionGate.js` | （待补） |
| 186 | `src/renderer/src/utils/labelLayout.js` | （待补） |
| 144 | `src/renderer/src/utils/labelOrient.js` | （待补） |
| 531 | `src/renderer/src/utils/labelStyles.js` | 标签样式预设系统：6 种内置预设 + 落盘/导入导出，改动后广播 sitian:label-styles-changed |
| 123 | `src/renderer/src/utils/labelZoom.js` | （待补） |
| 1087 | `src/renderer/src/utils/landmass.js` | （待补） |
| 492 | `src/renderer/src/utils/landmassField.js` | （待补） |
| 69 | `src/renderer/src/utils/landmassRelief.js` | （待补） |
| 71 | `src/renderer/src/utils/mapImportSource.js` | （待补） |
| 197 | `src/renderer/src/utils/mapTextStyles.js` | （待补） |
| 82 | `src/renderer/src/utils/markerHitTest.js` | （待补） |
| 238 | `src/renderer/src/utils/markerTypes.js` | 标记类型注册表（图标+颜色+中文名，可增删/排序/落盘）；旧 5 种类型保留为内置以兼容老地图 |
| 42 | `src/renderer/src/utils/normalizeId.js` | 节点 id 规范化纯函数：scripts/extract-data.js 的**逐字符副本**（三处一致由 test_40 读盘比对） |
| 21 | `src/renderer/src/utils/noteReader.js` | （待补） |
| 79 | `src/renderer/src/utils/placeTypes.js` | （待补） |
| 260 | `src/renderer/src/utils/placement.js` | 智能放置算法（聚落选址 + A* 道路）：必须走空间哈希桶 + 二叉堆，禁双重全表循环（27k 格 = 7 亿次 hypot） |
| 241 | `src/renderer/src/utils/planetArt.js` | （待补） |
| 252 | `src/renderer/src/utils/planetMapBundle.js` | （待补） |
| 241 | `src/renderer/src/utils/polityLabels.js` | **历史剧本势力标注（A8）＝分级判定的唯一实现**（纯函数，Node 可测）：`polityLabelTier(视口可见宽度÷地图宽度)` 三档 province/polity/abbr、`ringAreaCentroid`（鞋带公式，退化环返回有限形心）、`aggregateTerritories`（面积加权质心）、`labelTextFor`（abbr 无则回落全名）、`labelFitsOnScreen` + 两个与用户预设解耦的本地样式；渲染（ScenarioMap）与导出两处共用 |
| 604 | `src/renderer/src/utils/polygonBool.js` | （待补） |
| 197 | `src/renderer/src/utils/polylineSmooth.js` | （待补） |
| 826 | `src/renderer/src/utils/projectSchema.js` | `.sitian` 结构定义 / 校验修复 / 版本迁移 / 就地 diff 快照环形缓冲（纯函数） |
| 309 | `src/renderer/src/utils/provinceGrid.js` | 省份归属标签网格纯函数（Phase 3）：多边形→格归属（面积降序命中即停）、差异边→省界链→Chaikin、笔刷/套索差量、重编号与序列化自愈 |
| 186 | `src/renderer/src/utils/provinceHitIndex.js` | 省份命中的**空间索引**（2026-10-23，第 1 件 1-a）：包围盒 + 均匀网格 + 每省「环/嵌套符号/包围盒」建一次；判定仍只走 pointInProvince（cached 参数），语义与旧 findProvinceAt 逐字节同义；按 terrain 引用缓存（零手工失效点）。实测 20.4ms → 0.18ms/次 |
| 175 | `src/renderer/src/utils/provinceOverlap.js` | （待补） |
| 1088 | `src/renderer/src/utils/provinceShape.js` | （待补） |
| 258 | `src/renderer/src/utils/regionTrace.js` | 区域勾轮廓管线（Phase 2.6）：闭环 RDP 简化（容差随尺寸缩放）+ 离屏 canvas 光栅化校验「落地内 + 不重叠」，通过才落库 |
| 244 | `src/renderer/src/utils/reliefIcons.js` | 地貌图标**确定性**散布（整数哈希定抖动/旋转/尺寸，网格桶防重叠，单次笔刷有上限） |
| 253 | `src/renderer/src/utils/ridges.js` | （待补） |
| 194 | `src/renderer/src/utils/riverChains.js` | （待补） |
| 191 | `src/renderer/src/utils/riverErase.js` | （待补） |
| 1179 | `src/renderer/src/utils/riverRender.js` | （待补） |
| 858 | `src/renderer/src/utils/riverTrace.js` | （待补） |
| 98 | `src/renderer/src/utils/riverWidths.js` | （待补） |
| 252 | `src/renderer/src/utils/rivers.js` | 河流编辑器核心算法：按高度自动排序成从高到低、拖拽禁止「逆流」、节点随存采样高度 |
| 69 | `src/renderer/src/utils/roadStyles.js` | 道路样式预设（官道/道路/山路/小径）：style 优先于旧 route.color/dashed，老数据向后兼容 |
| 84 | `src/renderer/src/utils/routeDensity.js` | （待补） |
| 44 | `src/renderer/src/utils/sampleData.js` | 示例数据 |
| 122 | `src/renderer/src/utils/saveStatusText.js` | （待补） |
| 130 | `src/renderer/src/utils/scenarioCards.js` | （待补） |
| 397 | `src/renderer/src/utils/scenarioDates.js` | （待补） |
| 662 | `src/renderer/src/utils/scenarioEventLedger.js` | 事件账本纯函数层：事件类型表/关系词表、makeEvent 录入校验、sortEvents、[from,to) 生效窗口、relationBetween/relationsAt/describeRelation、findConflicts（重叠相反关系按无序对去重） |
| 123 | `src/renderer/src/utils/scenarioGroups.js` | （待补） |
| 95 | `src/renderer/src/utils/scenarioLabels.js` | （待补） |
| 212 | `src/renderer/src/utils/scenarioLedgerV2.js` | （待补） |
| 48 | `src/renderer/src/utils/scenarioPalette.js` | （待补） |
| 348 | `src/renderer/src/utils/scenarioSlices.js` | （待补） |
| 151 | `src/renderer/src/utils/scenarioTextPlacement.js` | （待补） |
| 325 | `src/renderer/src/utils/scenarioThumb.js` | （待补） |
| 644 | `src/renderer/src/utils/scenarioTimeline.js` | 剧本时间轴纯函数层（无 DOM/store 依赖）：势力谱系按省份重叠度贪心匹配、逐省易主年份、年份↔轨道轴向映射、EU4 斜线占领判定 |
| 412 | `src/renderer/src/utils/seaDepth.js` | （待补） |
| 69 | `src/renderer/src/utils/selectionHandles.js` | 选择框手柄 |
| 104 | `src/renderer/src/utils/settlement.js` | 聚落规模/人口/文化归属：人口对数滑块（100~1e6）+ 分级阈值 + 图标尺寸派生 |
| 73 | `src/renderer/src/utils/smartGuides.js` | 智能参考线 |
| 229 | `src/renderer/src/utils/snap.js` | 网格吸附 |
| 84 | `src/renderer/src/utils/stressTest.js` | 压测数据生成 |
| 51 | `src/renderer/src/utils/strokeEngine.js` | （待补） |
| 97 | `src/renderer/src/utils/strokeMath.js` | （待补） |
| 213 | `src/renderer/src/utils/svgExport.js` | 地图 → SVG 矢量序列化：path 曲线约定同 ScenarioMap 的 `traceShapePath`、斜线 pattern、文档组装与 SVG→PNG 光栅化；**`refImageSvgGroup` / `refImageWorldBounds`（M3/A7）＝参考底图几何的唯一实现**（`rotation` 是象限索引 0..3 → ×90°、90/270 交换宽高、`flipH` 在 rotate 之后；算边界用旋转后包围盒），`useFullMapExport` 与 `useScenarioExport` 两处共用 |
| 228 | `src/renderer/src/utils/system3dScene.js` | （待补） |
| 154 | `src/renderer/src/utils/terrainBrush.js` | 地形笔刷引擎（8 种地形类型）：硬度幂函数衰减 + 快速移动时的速度插值补点 |
| 132 | `src/renderer/src/utils/terrainErosion.js` | （待补） |
| 371 | `src/renderer/src/utils/terrainParams.js` | （待补） |
| 100 | `src/renderer/src/utils/terrainRepresentation.js` | 地形表示判定（**M2/A2 第二步**：`terrain[]` 降为可选覆盖物）—— 纯函数 `hasHeightmapContent` / `resolveTerrainRepresentation`：有高度图 → 高度图是主表示、多边形退为半透明覆盖物；**没有**高度图 → 多边形照旧主表示且不透明（旧地图兼容底线）。**渲染 / 命中 / 导出三处共用同一份**（各写一套 `if` = 又一个双源） |
| 591 | `src/renderer/src/utils/terrainSynthesis.js` | （待补） |
| 39 | `src/renderer/src/utils/textMeasure.js` | 文本宽度测量 |
| 209 | `src/renderer/src/utils/textOnPath.js` | （待补） |
| 245 | `src/renderer/src/utils/textures.js` | 程序化地形纹理 |
| 420 | `src/renderer/src/utils/userGuide.js` | （待补） |
| 137 | `src/renderer/src/utils/vault.js` | 库名解析：obsidian:// URI 的 vault 参数取自主进程配置（禁硬编码） |
| 198 | `src/renderer/src/utils/vaultRelink.js` | 笔记改名「断线检测 + 重连候选打分」（纯函数，Node 可测）：路径归一化 / 最长公共子串 / 单候选打分 / detectBrokenLinks / 理由文案 —— **判定与打分的唯一实现**（只读、确定性、宁可少推不可乱推） |
| 174 | `src/renderer/src/utils/vertexSharing.js` | （待补） |
| 42 | `src/renderer/src/utils/viewport.js` | 由 renderer.viewTransform 反解**视口**世界矩形（小地图遮罩用，必须区别于内容边界） |
| 307 | `src/renderer/src/utils/voronoiBatch.js` | （待补） |
| 59 | `src/renderer/src/workers/deriveWorker.js` | 温度/降水/生物群系派生 Worker：复用 heightMath.deriveLayers 不复制公式（等价性由用例兜住） |
<!-- GEN:END -->

> 测试用例在 `scripts/tests/cases/`（**163** 个，以 `ls scripts/tests/cases/test_*.py | wc -l` 为准），职责见文件名；另有 `scripts/tests/unit/*.js` Node 单测（**71** 个，主进程 I/O 与模块接线 —— CDP 用例里 sitianAPI 是 mock，测不到）。
