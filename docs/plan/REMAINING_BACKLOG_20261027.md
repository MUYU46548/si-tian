# 后续未做内容总表（2026-10-27，时间不足暂停点）

> 本轮已完成并提交：SP-1025 集成 **阶段 0（海陆渲染）+ 阶段 1（湖泊 / 地形特征级锁定）**，
> 全量 **162/162 + 70 Node** 绿（提交 `f9f2d3a`）。
> 本表只列**没做的**，按优先级/依赖排序；下次开工照这张表挑，不用重新翻聊天记录。
>
> **2026-10-28 更新**：§1 **星系 3D 观景已交付**（`System3DView.vue` + `utils/system3dScene.js` +
> `utils/planetArt.js`，回归 `test_163` + `unit/test_system3d_scene.js`，全量 **163/163 + 71 Node** 绿）。
> 交接见 [`HANDOFF_20261028_system3d.md`](HANDOFF_20261028_system3d.md)。下面 §1 的内容**保留为历史设计记录**，
> 与实现不完全一致的以代码与交接文档为准。

---

## 0. 优先级一句话

1. **星系 3D 观景** —— 用户 2026-10-27 明确：**必做，一直在计划里，只是一直没排期**。
2. **阶段 2：FMG 生成管线**（模板 / 8k-16k / 气候 / 河网 / 侵蚀）—— 决定新底图的生成质量。
3. **阶段 0/1 的欠账**（导出海面、锁定开关、造陆锁、手绘规模上限）。
4. 地图文字/观感旧账（字体、多行国名、省名占位、地形分辨率）。
5. 之前验收留下的 B1/F1 复核。

---

## 1. 星系 3D 观景（必做）—— ✅ 2026-10-28 已交付

> 实况：three@0.128.0 已装、`SystemDetailView` 头部按钮、`System3DView.vue` 异步组件、
> 18 类程序化纹理、6 轮开关资源归零判据、首屏不含 three。细节见
> [`HANDOFF_20261028_system3d.md`](HANDOFF_20261028_system3d.md) 与 `docs/agents-archive/views.md`。
> 下面这段是最初的设计口径，留作对照（**未做项**已在交接文档末尾单列）。

**目标**：在 `SystemDetailView`（单恒星系）里点「3D 观景」，进入可旋转/缩放的真实 3D 星系；
Esc/关闭回 2D，且不泄漏 WebGL 资源。

**参考实现**：`E:\CODE\CangKu\SP-1025\src\app\components\System3D.vue`（274 行）
+ `src/render/planetArt.ts`（18 类行星纹理，11KB）。
它已经踩过的低配口径可直接抄：AA 关 / 无阴影 / `SphereGeometry(…,24,16)` / `MeshLambertMaterial` /
像素比封顶 1.5 / 关闭即遍历 `dispose()` / `OrbitControls` 阻尼。

**司天侧要做的**：

1. `SystemDetailView.vue` 加「3D 观景」按钮（**只在有 ≥1 颗行星时可用**；只读态也可看）。
2. 用 `defineAsyncComponent` 或 `import('three')` **动态加载**，保证首屏 bundle 不背 three。
3. 数据适配：从 `SystemDetailView` 现有的行星/卫星节点取
   `{ name, class, orbit, size, moons }`；司天没有 `class` 字段，先用
   `layer`（planet/moon）+ `biome`/`color` 映射，缺省 `terran`；轨道半径按现有 2D 轨道距离归一化。
4. 交互：拖拽旋转 / 滚轮缩放（0.5x-6x）/ `P` 暂停 / `Esc` 关闭 / 窗口 resize。
5. 资源纪律：`onBeforeUnmount` + 关闭回调里 `renderer.dispose()`、几何/材质/纹理逐个 dispose；
   连续开关 20 次内存不涨（DevTools Memory 判据）。
6. 纹理：阶段 A 用**纯色/渐变球**（按 node.color）；阶段 B 再搬 `planetArt.ts` 的 18 类纹理，
   MIT/自研归属写进 About。
7. 依赖：`three@0.128.0`（SP-1025 钉死的版本，0.16x 灯光模型会漂观感）+ `@types/three`（dev）。
   ⚠️ 这是司天第一次引 3D 依赖，需在发布说明里写明体积与 GPU 要求。

**判据**：
- 打开 3D：canvas 出现、帧率 ≥30fps（中配）/ ≥15fps（低配）、可旋转缩放、行星公转；
- 关闭：2D 视图原样恢复、无 console WebGL 警告、`renderer.info.memory` 归零；
- 连续开关 20 次内存不涨；
- 首屏 bundle 不含 three（构建产物检查）；
- 只读/无行星时按钮禁用并说明原因。

**风险**：Electron GPU 黑屏（SP-1025 的 IAB rAF 冻结坑，真实 Electron 无此问题，但仍要
`requestAnimationFrame` + 可见性暂停）；three 版本与 Electron 28 的 WebGL 兼容；打包体积。

---

## 2. 阶段 2：FMG 生成管线（最大的剩余块）

**目标**：新建底图时可选「FMG 生成」：14 模板 / 8k-16k / 气候 / 河网 / 湖泊 / 群系，
输出成司天的 `heightmap`（+ 可选 `terrainGrid`），**不替换**现有 415 省矢量底图。

**要搬的**（`SP-1025/planet-map/src/core/`，MIT 头必须保留）：

| 块 | 文件 | 备注 |
|---|---|---|
| 网格 | `graph/lattice.ts` `voronoi.ts` `grid.ts` `pack.ts` | 依赖 `delaunator` |
| 高度 | `heightmap/templates.ts` `generator.ts` | 14 模板 + DSL 执行器 |
| 主入口 | `pipeline.ts` | **必须去掉全局 `Math.random = Alea`**，改显式 `rng` |
| 气候 | `climate/temperature.ts` `precipitation.ts` | 纯函数 |
| 海陆/湖 | `features.ts` `lakes.ts` | 距离场/湖判定 |
| 河网 | `river.ts` | 29KB；输出 pack cell 链 → 要转司天世界坐标折线 |
| 群系 | `biomes.ts` | 13 群系查表 |
| 噪声/工具 | `noise.ts` `utils/*` | `simplex-noise` |
| Worker | `worker/generate.worker.ts` | 改 Vite worker |

**适配层（真正的工作量）**：
1. SP-1025 输出 `PlanetMap{grid,pack,rivers}` → 司天 `heightmap{h,temp,prec,biome,grid{points,spacing,cellsX,cellsY}}`；
   分辨率 8k/16k 高于司天 97×45，需降采样或提升司天栅格（阶段 2 一起做，避免两套分辨率）。
2. `river.ts` 的 pack cell 链 → `rivers[{points,width,discharge}]`；河名仍由司天标签层管。
3. 省界：生成后仍走司天现有 `landmass`/`provinceShape` 铺省；**不要**把 Voronoi cell 当省。
4. 存档：只在「新建底图」时生成一次，转成司天 `heightmap`；不保留 `SerializedMap` 全量结构。
5. 撤销：生成 = 一条 `store.undo`；不要接 SP-1025 的命令栈。

**判据**：同 seed 全层 hash 一致；陆地覆盖率 ±1%；河流零断头；8k <1s / 16k <3s；
生成结果能在剧本底图/行星图正确渲染；415 省项目零影响。

**依赖/许可**：`alea`、`delaunator`、`simplex-noise`；14 个 MIT 头 + `THIRD_PARTY_NOTICES.md`。

---

## 3. 阶段 0/1 的欠账（小而明确）

1. **导出 SVG 的海面**：画布已有浅滩/深度色带，导出仍是平涂 `SEA_FILL`。
   → 把 `OCEAN_DEPTH` 写成 SVG 渐变/内联 PNG，或至少在导出里画浅滩带。
2. **锁定开关**：现在「重生成保留手绘」**总是开**；补一个 checkbox（默认开）+ 关闭时清 `handEdits`。
3. **造陆路径不锁**：`generateLandmass` 是整块新大陆，目前不沿用 `handEdits`；如果要锁，需先定义
   「新大陆与旧手绘坐标怎么对应」。
4. **手绘规模上限**：`handEdits` 随笔画增长，目前无上限/无压缩；大图长时间编辑可能到几万条。
   → 加 LRU/网格抽稀，或改成「按格坐标的 Uint8 掩码 + h 数组」。
5. **行星图无"重生成"**：湖泊/锁定只在剧本底图侧；行星图如果要「重生成保留手绘」，得先有生成入口。
6. **湖泊 UI 细节**：湖泊工具强度滑块无意义（平底固定 18/19），可隐藏；提示文案可再明确"平底"。

---

## 4. 地图文字 / 观感旧账（前几轮留下）

1. **字体**：内嵌一款宋体/文楷（EU4 的味道一半在字）；当前 fallback 系统宋体。
2. **国名多行/沿主轴旋转**：超大国的名字仍单行，会横穿省界。
3. **省名占位**：415 个省全叫「新省份 N」；画布现在会显示，需批量命名/从 Obsidian 导入，
   或加「只显示已命名省」开关。
4. **地形分辨率**：97×45 太粗；阶段 2 的 8k/16k 正好补，或先做 bicubic 上采样。
5. **城镇/道路分级**：城镇已按档节流；道路仍是 496 条在 near 档偏密，按 highway/road/trail 渐显。
6. **海岸带导出**：画布有 5px 浅滩 + 1.1px 海岸线，导出没有（同 §3.1）。

---

## 5. 之前验收的 B1 / F1 复核

- **B1「黑一块白一块」**：本轮已改无主省纸色、陆地色带、阴影区间、海岸浅滩；需要用户再看一眼
  真实项目，确认是否还剩具体哪一块。
- **F1「重开项目直接没」**：副本制「关项目→重开」数据完整；启动恢复失败现在会报原因。
  若用户说的是「重启应用后不恢复」，需要按新告警里的 `reason` 再查一次（`missing` = 文件被移走）。
- **B3「三个都画了没效果」**：剧本侧高度/群系/文化笔刷已自动切可见档；行星侧笔刷写入已实测 +43 格。
  若仍无效果，需要用户给出「哪个工具、哪个视图」。

---

## 6. 建议的下次开工顺序

1. ~~**星系 3D**（用户点名必做；独立、可单轮交付）—— 先纯色球 + 动态 three，纹理二期。~~ **已交付 2026-10-28**
2. **阶段 0/1 欠账**（导出海面、锁定开关）—— 1-2 天，收尾干净。
3. **阶段 2 生成管线**（1-2 周）—— 先 3 模板 + heightmap 输出，再河网/群系。
4. 字体/多行国名/省名占位/地形分辨率（按用户优先级插队）。

---

## 7. 证据与文档

- 分析：[`SP1025_INTEGRATION_ANALYSIS.md`](SP1025_INTEGRATION_ANALYSIS.md)
- 阶段 0+1 交接：[`HANDOFF_20261027_sp1025_stage01.md`](HANDOFF_20261027_sp1025_stage01.md)
- 视觉：`build/visual-audit/`（scenario-fit / planet-satellite / scenario-height-shade）
- SP-1025 参考图：`docs/assets/sp1025-20261027/`
- 本轮提交：`f9f2d3a`
