# 司天全量开发计划（V1.0）

> 范围：**四组全做**——剧本（外交/事件/逐年切片/动画）、地图（河流/地形/文化/宗教/道路/建筑内部）、
> Obsidian（写回/双库/云同步）、空间（星系/3D）。
>
> 这份是**施工计划**：有数据契约、工作区规格、逐任务 WBS、验收、团队/工期/风险。
> 估算按“模块化重建 + 复用已验证底层”计；不按“继续修旧 ScenarioMap”计。

---

## 0. 决策摘要

| 项 | 决定 |
|---|---|
| 是否从零重写 | **否**。重写 UI 壳 + 四个工作区；复用项目存储/几何/导出/文件索引。 |
| 是否继续修旧 ScenarioMap | **否**。旧模块只读保留，开关切换，不再加功能。 |
| 数据兼容 | 无历史真实数据，**不背旧格式**；新 schema v2，提供 JSON 导入/导出。 |
| 主流程 | 5 步一张图；其余功能进各自工作区，不挤主流程。 |
| 单人/团队 | 单人 12–14 个月；2–3 人 5–7 个月。 |
| 首个可用切片 | 6 周：读库 + LLM 提案 + 底图 + 涂势力 + 导 PNG。 |
| 最晚做的模块 | 写回 / 云同步 / 3D（最贵、最容易掩盖基础问题）。 |

---

## 1. 产品定义与总验收

### 1.1 产品是什么

一个本地桌面工具：**读 Obsidian 设定 → 画世界地图 → 编排历史剧本 → 导出地图/动画 → 可选写回笔记/同步**。
不是 Obsidian 替代品，不是云端协作平台。

### 1.2 四条主流程（各自独立验收）

1. **设定**：打开库 → 搜索/阅读 → AI 提案 → 确认导入实体。
2. **地图**：导入底图 → 编辑省/河/地形/文化/宗教/道路/建筑 → 保存。
3. **剧本**：建势力 → 涂归属 → 时间轴 → 外交/事件 → 切片/动画。
4. **空间**：星系 2D/3D → 进入行星 → 与地图/设定互相跳转。

### 1.3 总验收（Definition of Done）

- 任一主流程，新用户 **5 分钟内**能完成第一件事（一张图/一条时间线/一个星系视图）；
- 强杀进程 20 次，已保存数据零丢失；
- 四组功能共用同一份实体/地图/时间数据，无第二事实源；
- 所有写操作可 undo；所有落盘有备份/审计；
- 四组各 3 次真实使用无 P0 数据问题。

---

## 2. 技术架构

### 2.1 栈

- Electron 28 + Vue 3 + TypeScript + Vite；
- 状态：Pinia，但每个工作区独立 store；全局只保留 `project` / `selection` / `undo`；
- 2D：Canvas 2D（地图/时间轴/星系 2D）；
- 3D：three.js（仅星图/行星 3D，独立模块）；
- 数据校验：Zod 或自写 schema validator（二选一，先定）；
- 测试：Vitest（纯函数/几何/schema）+ Playwright Electron（E2E）；
- LLM：OpenAI-compatible / Ollama，JSON Schema 输出；
- 同步：isomorphic-git / WebDAV；云对象存储后置。

### 2.2 目录

```
src/
  main/
    project/      # 项目文件：原子写/备份/恢复/锁/审计
    vault/        # 枚举/原文/监听/缓存
    llm/          # provider/密钥/限流/重试/缓存
    sync/         # git/webdav/冲突清单
    export/       # PNG/SVG/帧序列写盘
  shared/
    schema/       # Project/Entity/Map/Scenario/Space/Sync
    geometry/     # 布尔/环/面积/骨架/河宽
    stroke/       # perfect-freehand 封装
    time/         # 日期/切片/区间
  renderer/
    app/          # 新壳：工作区路由、命令、快捷键、Toast
    workspaces/
      vault/      # 设定库
      map/        # 地图 2D
      scenario/   # 剧本
      space/      # 星系 2D/3D
      settings/
    ui/           # 通用组件
  tests/
    unit/ e2e/ fixtures/
```

### 2.3 边界规则

- workspace 之间禁止互相 import；共享逻辑进 `shared/` 或 `app/commands`。
- 主进程不 import renderer；preload 暴露类型化 API。
- 每个 workspace 自带编辑器状态；全局只保留项目、选择、撤销。
- 地图/剧本/星系共用 Entity id；禁止用文件名/坐标当身份。

---

## 3. 参考实现（抄行为/数据/算法，不抄壳）

| 模块 | 参考（许可证） | 抄什么 | 对照测试 |
|---|---|---|---|
| 地图数据/生成 | Azgaar FMG（MIT） | `.map` 字段、省/河/文化/宗教/道路/城镇结构、高度/群系/河流算法 | 同输入字段/几何/排序一致 |
| 笔迹 | perfect-freehand（MIT） | `getStroke/getStrokePoints` | 同点集轮廓点数/范围 |
| 布尔 | polygon-clipping（MIT） | union/difference/intersection | 面积/环数 |
| 铺底 | d3-delaunay（ISC） | Delaunay + Voronoi cell | 单元数/邻接 |
| 3D | three.js（MIT） | OrbitControls/Raycaster/CSS2D/LOD | 拾取/帧率 |
| 笔记 | Obsidian（只抄交互） | 树/阅读器/反链/搜索 | 不适用 |
| Git | isomorphic-git（MIT） | clone/commit/push/pull/status | 状态矩阵 |
| E2E | Playwright（Apache-2.0） | Electron 启动/截图/trace | 不适用 |

**防呆**：每个移植模块先写对照测试；不允许“看起来差不多”。
许可证：MIT/ISC/Apache 保留声明；GPL/带水印代码不碰。

---

## 4. 数据契约

### 4.1 Project

```ts
type Project = {
  schemaVersion: 2;
  id: string;
  name: string;
  createdAt: string; updatedAt: string;
  vault: { root: string; profileId: string | null };
  entities: Record<string, Entity>;
  maps: Record<string, MapDoc>;
  scenarios: Record<string, Scenario>;
  space: SpaceDoc;
  assets: Record<string, AssetRef>;
  settings: Record<string, unknown>;
};
```

### 4.2 Entity

```ts
type Entity = {
  id: string;
  type: string;                 // 来自 VaultProfile
  name: string;
  aliases: string[];
  parentId: string | null;
  summary?: string;
  fields: Record<string, unknown>;
  noteRefs: string[];
  mapRefs: { mapId: string; featureId: string }[];
  provenance: {
    sourcePath: string; sourceHash: string;
    model?: string; promptVersion?: string; profileVersion?: number;
  }[];
};
```

### 4.3 MapDoc

```ts
type MapDoc = {
  id: string; name: string;
  width: number; height: number;
  provinces: Province[];      // { id,name,rings,kind,biome,culture,religion }
  rivers: River[];            // { id,points,width,widthFactors?,parentId? }
  cultures: Culture[]; religions: Religion[];
  routes: Route[]; buildings: Building[];
  layers: Record<string, boolean>;
};
```

### 4.4 Scenario

```ts
type Scenario = {
  id: string; name: string;
  era: { startYear: number; endYear: number };
  polities: Polity[];
  ownership: Record<string, string>;       // provinceId -> polityId
  changeEvents: ChangeEvent[];
  diplomacy: DiplomaticRelation[];
  events: WorldEvent[];
  slices: SlicePoint[];
};
```

### 4.5 Space

```ts
type SpaceDoc = {
  systems: StarSystem[];      // { id, name, position, stars[], planets[] }
  lanes: Lane[];              // { a,b,type }
  camera2D?: { x,y,scale };
  camera3D?: { position,target };
};
```

### 4.6 VaultProfile / AI 提案

```ts
type VaultProfile = {
  version: number; language: string;
  entityTypes: { key: string; label: string; examples: string[] }[];
  relationTypes: { key: string; label: string; from: string[]; to: string[] }[];
  noteRolePolicy: { canon: string[]; inWorld: string[]; meta: string[] };
  extraction: { chunkTokens: number; overlap: number; minConfidence: number };
};

type AIProposal = {
  kind: 'create'|'update'|'conflict'|'new-type';
  entity?: Entity;
  relations?: { subject: string; predicate: string; object: string }[];
  evidence: { path: string; startLine: number; endLine: number; quote: string }[];
  confidence: number;
};
```

**写盘规则**：所有写入过 schema 校验；temp→fsync→rename；保留 10 份备份；启动恢复临时文件。

---

## 5. 工作区 UX 规格

### 5.1 应用壳

- 左侧窄栏：设定库 / 地图 / 剧本 / 星图 / 设置；**不放大工具栏**；
- 顶部项目条：项目名、保存状态、撤销/重做、搜索；
- 主区域同一时间只挂一个 workspace；
- 全局命令面板（Ctrl+K）：跳转/执行命令，不依赖记忆按钮位置。

### 5.2 设定库（Vault）

- 三栏：文件树 | 阅读器 | 大纲/反链/AI 提案；
- 顶部：库路径、索引状态、搜索框、`AI 导入`；
- 阅读器支持任意 Markdown（没有 frontmatter/标题也能读）、图片、双链（有就跳，没有不报错）；
- AI 导入：选文件夹 → 提案列表（新建/更新/冲突/新类型）→ 逐条接受/编辑/拒绝 → 写入项目；
- 笔记只读，直到显式写回。

### 5.3 地图（Map 2D）

- 布局：左图层/工具 | 中画布 | 右属性/选中对象；
- 模式：选择 / 涂归属 / 省界 / 河流 / 地形 / 文化 / 宗教 / 道路 / 建筑；
- 工具参数用**浮层**，不占画布高度；
- 图层面板：省/河/地形/文化/宗教/道路/建筑/标签，独立开关；
- 画布顶部浮动步骤条（不占布局）：导入底图 → 选层 → 编辑 → 保存；
- 导出：PNG/SVG，标题/图例/比例尺。

### 5.4 剧本（Scenario）

- 布局：中地图 | 底时间轴 | 右势力/外交/事件面板；
- 顶部模式：政治 / 外交 / 事件 / 切片；
- 时间轴：年代、年份、切片点、书签；拖动即回放；
- 外交表：条约/联盟/战争/停战/关系值；
- 事件：定义、触发、选项、效果；事件弹窗不改数据直到确认；
- 切片/动画：选年份/切片 → 批量导出 → manifest；GIF/WebM。

### 5.5 星图（Space）

- 2D/3D 切换；2D 先可用；
- 3D：轨道、标签、拾取、LOD、性能降级；
- 点击星系/行星 → 详情/进入行星地图；
- 3D 与 2D 共用 SpaceDoc/Entity，不建第二套。

### 5.6 设置

- 项目、库、LLM provider/密钥、同步、备份、快捷键；
- 所有密钥进 OS safeStorage；不落项目/日志。

---

## 6. AI 语义导入规格

1. **文件层**：只枚举 `.md`，原文/行号/哈希；frontmatter/标题/标签/双链都是弱提示，不假设。
2. **Profile bootstrap**：抽 10–20 篇 → LLM 提议实体类型/关系/文档角色 → 用户编辑批准 → 版本化。
3. **分块**：段落/Token 窗口，10–15% 重叠，保留行号；不按标题。
4. **抽取**：JSON Schema；实体/关系/证据/置信度；无证据字段丢弃。
5. **归并**：别名/同名先规则，冲突 LLM 裁决带证据；矛盾列冲突提案，不自动合并。
6. **审阅**：新建/更新/冲突/新类型；逐条接受；接受才写，一条 undo。
7. **缓存/增量**：`noteHash + profileVersion + promptVersion + model`；只跑改动笔记。
8. **安全**：正文当数据，防提示注入；密钥 safeStorage；本地模型可选。
9. **验收**：3 种反例库 × 20 篇黄金集；precision/recall ≥0.85；schema 100%；无证据 0；注入 0 实体；重跑幂等；成本/吞吐有数。

---

## 7. 写回 / 双库 / 云同步规格

### 7.1 写回

- 只写用户勾选的字段/段落；显示 diff（前/后/行号）；
- 写前备份；原子写；审计（路径/字段/前值/后值/时间/模型）；
- 冲突：笔记在应用外被改 → 不覆盖，进“待裁决”；
- 一键还原最近一次写回。

### 7.2 双库

- 实体映射表：`entityId -> [{vault, path, hash}]`；
- 同一实体多来源；冲突表；不自动合并。

### 7.3 云

- 先 Git（isomorphic-git）；再 WebDAV；对象存储最后；
- 冲突模型：基哈希 + 双方修改 → 冲突文件/待裁决；不做黑盒自动合并；
- 断网/中断可恢复；仓库有备份。

**验收**：20 篇写回 diff 正确；冲突不丢任何一方；断网可恢复；审计可还原。

---

## 8. 全量 WBS

> 估算单位：人日（1 人全职 5 日/周）。任务可并行处已标注。
> 每个任务必须先写验收，再写代码；验收不过不得进入下一任务。

### P0 项目启动（5 人日）

| ID | 任务 | 验收 | 日 |
|---|---|---|---:|
| P0-1 | 仓库/CI/TS strict/lint | CI 绿；类型检查全仓 | 2 |
| P0-2 | ADR：模块边界/数据内核/许可证 | 评审通过 | 1 |
| P0-3 | 测试策略/fixtures 清单 | 3 反例库 + 200/415 地图 | 1 |
| P0-4 | 第三方许可证清单 | MIT/ISC/Apache 声明齐全 | 1 |

### P1 数据内核 + 新壳（20 人日）

| ID | 任务 | 验收 | 日 |
|---|---|---|---:|
| K1 | schema + validator | 非法 Project 拒绝并给路径 | 5 |
| K2 | 项目存储：原子写/备份/恢复/锁 | 强杀 20 次不丢；100 次哈希一致 | 5 |
| K3 | 命令/undo/redo | 所有写走 execute；undo/redo 一致 | 3 |
| K4 | preload 类型化 API | 主/渲染契约测试 | 3 |
| K5 | 新壳/工作区路由/命令面板 | 四工作区切换无报错 | 4 |

### P2 设定库 + LLM（33 人日）

| ID | 任务 | 验收 | 日 |
|---|---|---|---:|
| V1 | 文件枚举/原文/哈希 | 1,000 篇 <3s；反例库不报错 | 3 |
| V2 | 阅读器/图片/行号 | 20 篇可读；图片显示 | 3 |
| V3 | 全文搜索 | 中英查询；定位行 | 3 |
| V4 | chokidar 增量 | 改一篇 <1s | 2 |
| V5 | Profile bootstrap UI | 10 分钟批准；未批不能全库 | 5 |
| V6 | LLM provider/密钥/缓存 | 两家 provider；密钥不落日志 | 4 |
| V7 | 抽取流水线/schema/证据 | 20 篇黄金集有数；无证据 0 | 5 |
| V8 | 审阅 UI/写入口 | 逐条接受；一条 undo | 5 |
| V9 | 注入/幂等/成本 | 注入 0 实体；重跑一致；成本有数 | 3 |

### P3 地图核心（25 人日）

| ID | 任务 | 验收 | 日 |
|---|---|---|---:|
| M1 | `.map`/GeoJSON 导入 | 200/415 省字段对齐 | 5 |
| M2 | 相机/渲染/DPR/分层 | 200 省 p95 <20ms | 4 |
| M3 | 命中/选中/洞/飞地 | 点选正确 | 3 |
| M4 | 属性面板/图层开关 | 改字段可 undo | 3 |
| M5 | 保存/重开 | 省数/面积/归属哈希一致 | 2 |
| M6 | 导出 SVG/PNG（标题/图例/比例尺） | 3680×1752 非空白；两次 0px 差 | 5 |
| M7 | 性能/内存基线 | 200 省拖动/保存有数 | 3 |

### P4 地图图层（35 人日）

| ID | 任务 | 验收 | 日 |
|---|---|---|---:|
| L1 | 省份编辑：画/切/并/描轮廓/顶点 | 一笔一 undo；空省不残留 | 5 |
| L2 | 归属涂/擦/圈/点填 | 屏幕半径；预览=落库 | 4 |
| L3 | 河流：手画/支流/橡皮/宽度 | 预览=落库；断河语义正确 | 5 |
| L4 | 地形：高度/降水/温度/群系 | 笔刷/推演；性能有数 | 6 |
| L5 | 文化/宗教笔刷/扩散 | 逐格/逐省；单独开关 | 5 |
| L6 | 道路：两点/寻路/等级/桥 | 连接聚落；可 undo | 4 |
| L7 | 建筑内部：楼层/房间/家具/门 | 从区域下钻；保存重开一致 | 6 |

### P5 剧本核心（20 人日）

| ID | 任务 | 验收 | 日 |
|---|---|---|---:|
| S1 | 时间轴/年代/年月日 | 拖游标回放；切片点 | 5 |
| S2 | 势力 CRUD/颜色/简称 | 删除清 ownership；undo | 4 |
| S3 | 归属/时间点快照 | 切年颜色正确 | 4 |
| S4 | changeEvents/易主 | 事件驱动归属；可撤销 | 3 |
| S5 | 回放/只读 | 回放不写数据 | 4 |

### P6 外交 + 事件（25 人日）

| ID | 任务 | 验收 | 日 |
|---|---|---|---:|
| D1 | 外交数据/表 | 条约/联盟/战争/停战 | 5 |
| D2 | 事件定义/条件 | schema 校验；可复用 | 5 |
| D3 | 事件效果→归属/外交/标签 | 一条 undo | 5 |
| D4 | 事件弹窗/选项 | 确认后才写 | 4 |
| D5 | 冲突/校验/审计 | 非法事件拒绝 | 3 |
| D6 | 外交/事件导出 | JSON/CSV | 3 |

### P7 切片 + 动画（20 人日）

| ID | 任务 | 验收 | 日 |
|---|---|---|---:|
| A1 | 切片点/年份批量 | 4 帧起；manifest | 3 |
| A2 | PNG/SVG 批量导出 | 命名/目录正确 | 4 |
| A3 | GIF/WebM | 30 秒动画可生成 | 5 |
| A4 | 相机/图例/标题配置 | 帧间一致 | 4 |
| A5 | 回放/性能 | 200 省 30fps 预览 | 4 |

### P8 星系 + 3D（45 人日）

| ID | 任务 | 验收 | 日 |
|---|---|---|---:|
| SP1 | 星系/轨道/航道数据 | 与 Entity 共用 | 4 |
| SP2 | 2D 星系视图 | 选择/缩放/进入行星 | 5 |
| SP3 | 3D 场景/相机/控制 | 100 系统 30fps | 8 |
| SP4 | 拾取/标签/LOD | 点选准确；标签不糊 | 5 |
| SP5 | 性能/降级 | 低端机可关特效 | 5 |
| SP6 | 行星 3D | 地形球/光照；与 2D 一致 | 8 |
| SP7 | 2D/3D/地图互跳 | 数据同源 | 5 |
| SP8 | 3D 资源/许可 | 无版权风险 | 5 |

### P9 写回 + 双库 + 云（35 人日）

| ID | 任务 | 验收 | 日 |
|---|---|---|---:|
| Y1 | 写回 diff/勾选 | 20 篇 diff 正确 | 5 |
| Y2 | 备份/审计/还原 | 一键还原 | 5 |
| Y3 | 双向冲突 | 不丢任何一方 | 6 |
| Y4 | 双库映射 | 同实体多来源 | 5 |
| Y5 | Git 同步 | clone/commit/push/pull | 5 |
| Y6 | WebDAV/对象存储 | 断网/中断可恢复 | 5 |
| Y7 | 冲突 UI/恢复演练 | 冲突可裁决 | 4 |

### P10 集成/发布（25 人日）

| ID | 任务 | 验收 | 日 |
|---|---|---|---:|
| I1 | Playwright E2E 全主流程 | 四流程各 1 条 | 5 |
| I2 | 性能/内存/崩溃 | 预算达标 | 4 |
| I3 | 打包/签名/更新 | 安装包可装 | 3 |
| I4 | 文档/引导/空态 | 新人 5 分钟 | 4 |
| I5 | 真实使用硬化 | 3 次无 P0 | 6 |
| I6 | 发布检查单 | 全绿 | 3 |

**合计**：约 **288 人日**；单人约 **58 周（13 个月）**；3 人并行约 **5–7 个月**（含联调）。

---

## 9. 里程碑（每个都要你验收）

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 | 新壳/项目存储/undo | 强杀不丢；四工作区可切 |
| M1 | 读库/读笔记/搜索 | 3 反例库可读 |
| M2 | LLM 单文件夹提案 | 20 篇黄金集有数；不自动写 |
| M3 | 底图/涂势力/导 PNG | 5 分钟一张图 |
| M4 | 地图全层 | 10 笔不崩；每层可开关 |
| M5 | 剧本核心 | 时间轴回放/易主正确 |
| M6 | 外交/事件 | 事件改归属可 undo |
| M7 | 切片/动画 | 30 秒动画可生成 |
| M8 | 星系 2D/3D | 100 系统 30fps |
| M9 | 写回/双库/云 | 冲突不丢；可还原 |
| M10 | 发布 | 安装包 + 真实使用 |

---

## 10. 测试与质量

- **单元**：schema、几何、河宽、时间、导出、同步补丁。
- **E2E**：Playwright Electron；禁止固定坐标，一律 boundingBox。
- **反例库**：无 frontmatter、乱标题、中英混写、同名、矛盾。
- **数据安全**：强杀 20 次、断电模拟、100 次保存/重开。
- **性能预算**：200 省 p95 <20ms；1,000 篇首扫 <3s；3D 100 系统 30fps。
- **AI**：黄金集、schema、证据、注入、幂等、成本。
- **对照测试**：Azgaar 字段、perfect-freehand 轮廓、polygon-clipping 面积。
- **视觉回归**：关键屏幕截图（不做全页像素，避免脆弱）。

---

## 11. 团队与预算

### 11.1 最低配置

- 1 × 地图/编辑器（Canvas、几何、交互）；
- 1 × 后端/LLM/同步（Electron 主进程、文件、git）；
- 1 × 3D/美术（three.js、星图；可兼职/外包）；
- 你：产品 + 每周 2–3 小时验收。

### 11.2 单人

- 12–14 个月；风险高：UI/3D/同步互相拖；不推荐硬扛全量。

### 11.3 token/费用

- 当前已投入 100 亿 token / 200+ 元；**继续按“全量一次做完”烧，不划算**。
- 每个里程碑设 token/时间上限；到期只验收，不延期。
- LLM 运行成本单独计量：1,000 篇约 1.5M input；先 20 篇试点量单价。

---

## 12. 风险与止损

| 风险 | 概率 | 影响 | 措施 | 止损 |
|---|---|---|---|---|
| LLM 任意写法库准确率不够 | 高 | 高 | 20 篇试点；证据；人工审阅 | 试点不达标 → 退回纯手动导入 |
| 写回丢数据/冲突 | 中 | 极高 | diff/备份/审计/冲突待裁决 | 任一数据丢失 → 停写回 |
| 3D 拖垮进度 | 高 | 中 | 2D 先通；LOD；可关闭 | 超预算 → 3D 降级为 2.5D |
| UI 再次变成工具栏迷宫 | 高 | 高 | 每工作区独立；5 按钮；验收 | 新用户 5 分钟失败 → 回滚 UI |
| 单人 burnout/上下文返工 | 高 | 高 | 模块化；每任务验收；预算 | 连续 3 次返工 → 停 |
| 测试绿但产品不可用 | 高 | 高 | 真实使用验收；不认测试绿 | 3 次真实使用有 P0 → 停功能 |

---

## 13. 执行顺序（前 30 天）

1. **D1–D5**：P0 + K1/K2 骨架（项目能存、能恢复）。
2. **D6–D10**：K3–K5（undo/命令/新壳）。
3. **D11–D15**：V1–V3（扫描/阅读/搜索）。
4. **D16–D20**：V5（Profile bootstrap）+ V6（provider）。
5. **D21–D25**：V7/V8（抽取/审阅，单文件夹 20 篇）。
6. **D26–D30**：M1/M2（底图导入/渲染）起头，准备 5 步壳。

**第 30 天验收**：能打开真实库、读/搜、对 20 篇出提案并审阅；底图能导入显示。做不到就停，不加地图编辑。

---

## 14. 明确的质量底线

- 没有“先上线再补数据安全”；写盘/备份/恢复从第一天做。
- 没有“先做 3D 再补 2D”；2D 不通不做 3D。
- 没有“AI 自动导入”；只做提案。
- 没有“这个功能先塞旧 ScenarioMap”；新功能只进新工作区。
- 没有“测试绿=可用”；每个里程碑你亲手验收。

---

*本计划是施工图，不是承诺；每个任务先写验收再写代码，每个里程碑你验收后才进入下一阶段。*
