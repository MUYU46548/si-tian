# 司天 V1 详细规格（2026-10-19）

> 这份文件不是路线图，是**施工图**。
> 先给“第一个可用切片（约 6 周）”的逐任务规格；剧本/3D/同步给到接口与参考实现，
> 每个模块开工前再展开到同样粒度，不再用“第几周做什么”这种空话。
>
> 原则：**能抄就抄，抄行为、抄数据、抄测试；不抄别人的 DOM 和视觉壳。**
> 所有外部代码以仓库 LICENSE 为准，MIT/ISC/Apache 保留版权声明；GPL/带水印的代码不碰。

---

## 0. 产品硬规则（违反即回滚）

1. **一个主流程最多 5 个主按钮**；其余进「高级」。
2. **没有项目 = 只读**；任何写盘必须过单一写者。
3. **保存诚实**：落盘成功才显示“已保存”；崩溃可恢复。
4. **破坏性操作先预览影响面 + 一条 undo**。
5. **笔记只读**，直到用户显式勾选“写回”并看 diff。
6. **AI 只出提案**，不自动建实体；每条提案必须有原文证据。
7. **同一能力只有一份实现**：画布、导出、河宽、保存文案都不许两套。
8. **画布不许被工具栏挤矮**：新增 UI 用浮层/抽屉，不占画布布局。

---

## 1. 参考实现清单（抄什么 / 不抄什么）

| 功能 | 参考项目（许可证） | 抄什么 | 不抄什么 |
|---|---|---|---|
| 地图数据与生成 | **Azgaar Fantasy Map Generator**（MIT） | `.map` 字段、省份/河流/文化/宗教/道路/城镇的数据结构；高度/群系/河流/文化的生成算法与参数 | 它的 DOM 布局、旧 UI、全局变量写法 |
| 自由笔迹 | **perfect-freehand**（MIT） | `getStroke` / `getStrokePoints`；压感/笔锋；输入点格式 | —— |
| 多边形布尔 | **polygon-clipping**（MIT） | `union/difference/intersection`；MultiPolygon 层数约定 | —— |
| Voronoi 铺底 | **d3-delaunay**（ISC） | `Delaunay.from` + `voronoi.cellPolygon`；边界裁剪 | d3 全家桶 |
| 3D 星图 | **three.js**（MIT） | `OrbitControls`、`Raycaster`、`CSS2DRenderer`、LOD/精灵标签 | 官方 example 的整页布局 |
| Markdown 渲染 | **markdown-it**（MIT） | 插件链、链接/图片 token | Obsidian 私有语法全量模拟 |
| 文件监听 | **chokidar**（MIT） | `add/change/unlink`、忽略规则、防抖 | —— |
| Git 同步 | **isomorphic-git**（MIT） | clone/commit/push/pull、状态矩阵 | 自写 git 协议 |
| WebDAV | **webdav** 客户端（MIT） | PROPFIND/PUT/GET/MKCOL | —— |
| 端到端测试 | **Playwright**（Apache-2.0） | Electron 启动、窗口、截图、trace | 现有自研 CDP 那套脆弱坐标点击 |
| 单元测试 | **Vitest**（MIT） | 纯函数/几何/数据校验 | —— |
| LLM 结构化输出 | OpenAI JSON Schema / Ollama API | `response_format`、`format: json`、流式取消 | 让模型自由写 Markdown 再解析 |
| 剧本 UX | **EU4 / CK3**（只抄交互，不抄代码） | 时间轴、外交表、事件弹窗、地图模式切换 | 任何资源文件/美术 |
| 笔记 UX | **Obsidian**（只抄交互） | 文件树、阅读器、反链、搜索、标签 | 私有代码/同步服务 |

**“抄不明白”的防呆**：每个移植模块必须先写一个**对照测试**——同一输入， upstream 输出 vs 我们的输出，
字段/几何/排序一致才允许合并；不允许“看起来差不多”。

---

## 2. 目录与模块边界（新代码）

```
src/
  main/                      # Electron 主进程
    project/                 # 项目文件：读/写/备份/恢复/锁
    vault/                   # 文件枚举、原文读取、监听、缓存
    llm/                     # provider、密钥、限流、重试
    sync/                    # git/webdav、冲突清单
    export/                  # PNG/SVG/帧序列写盘
  shared/                    # 主/渲染共用：schema、校验、纯函数
    schema/                  # Project/Entity/Map/Scenario/Event...
    geometry/                # 布尔、环、面积、骨架
    stroke/                  # perfect-freehand 封装
  renderer/
    app/                     # 新壳：工作区路由、命令、快捷键
    workspaces/
      vault/                 # 设定库：树/搜索/阅读器/导入提案
      map/                   # 地图：省份/河流/地形/文化/宗教/道路/建筑
      scenario/              # 剧本：时间轴/势力/外交/事件/切片/动画
      space/                 # 星系 2D + 3D
      settings/              # 项目/LLM/同步
    ui/                      # 通用组件：对话框、抽屉、表单、Toast
  tests/
    unit/                    # Vitest
    e2e/                     # Playwright Electron
    fixtures/                # 3 种反例库、200/415 省地图
```

**边界规则**：
- `workspaces/*` 不许互相 import；共享逻辑只能进 `shared/` 或 `app/commands`。
- `main/*` 不 import renderer；通过 preload 的类型化 API 通信。
- 每个 workspace 自带 store；全局只保留 `project`、`selection`、`undo` 三个 store。

---

## 3. 数据契约（先定死，再写 UI）

### 3.1 Project

```ts
type Project = {
  schemaVersion: 2;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  vault: { root: string; profileId: string | null };
  entities: Record<string, Entity>;
  maps: Record<string, MapDoc>;
  scenarios: Record<string, Scenario>;
  assets: Record<string, AssetRef>;
  settings: { theme: 'dark'|'light'; language: 'zh'|'en' };
};
```

### 3.2 Entity

```ts
type Entity = {
  id: string;                 // 稳定 id，不用文件名
  type: string;               // 来自 Vault Profile
  name: string;
  aliases: string[];
  parentId: string | null;
  summary?: string;
  fields: Record<string, unknown>;   // 类型特有字段
  noteRefs: string[];                // vault 相对路径，只读引用
  mapRefs: { mapId: string; featureId: string }[];
  provenance: { sourcePath: string; sourceHash: string; model?: string; promptVersion?: string }[];
};
```

### 3.3 MapDoc（Azgaar 字段裁剪）

```ts
type MapDoc = {
  id: string; name: string;
  width: number; height: number;
  provinces: Province[];       // { id, name, rings, kind, biome, culture, religion, owner? }
  rivers: River[];             // { id, points, width, widthFactors?, parentId? }
  cultures: Culture[]; religions: Religion[];
  routes: Route[]; buildings: Building[];
  layers: Record<string, boolean>;
};
```

### 3.4 Scenario（剧本/外交/事件）

```ts
type Scenario = {
  id: string; name: string;
  era: { startYear: number; endYear: number };
  polities: Polity[];
  ownership: Record<string, string>;              // provinceId -> polityId
  changeEvents: ChangeEvent[];                    // { provinceId, date, owner }
  diplomacy: DiplomaticRelation[];                // { a, b, state, from, to }
  events: WorldEvent[];                           // { id, date, trigger, options, effects }
  slices: SlicePoint[];
};
```

### 3.5 VaultProfile（每个库自己的一套规矩）

```ts
type VaultProfile = {
  version: number;
  language: string;
  entityTypes: { key: string; label: string; examples: string[] }[];
  relationTypes: { key: string; label: string; from: string[]; to: string[] }[];
  noteRolePolicy: { canon: string[]; inWorld: string[]; meta: string[] };
  extraction: { chunkTokens: number; overlap: number; minConfidence: number };
};
```

**校验**：所有写入前过 `shared/schema/validate.ts`；不合法直接拒绝并给字段路径。
**原子写**：temp 文件 → fsync → rename；保留最近 10 份备份；启动检测临时文件。

---

## 4. 第一个可用切片（6 周，逐任务）

> 目标：**打开真实库 → 读/搜笔记 → LLM 单文件夹提案 → 导入底图 → 涂势力 → 选时间 → 导出 PNG。**
> 不含剧本外交/事件/动画/3D/云同步（它们是后续模块，接口已定）。

### 第 1 周：内核 + 项目

| ID | 任务 | 交付 | 验收 | 估时 |
|---|---|---|---|---|
| F1 | 新壳骨架 | `renderer/app` 路由、工作区、命令总线 | 能在四个空工作区间切换，无报错 | 4h |
| F2 | schema + 校验 | `shared/schema/*`、Vitest | 非法 Project 被拒，错误带路径 | 1d |
| F3 | 项目存储 | 原子写、备份、恢复、锁 | 强杀 20 次不丢已保存；100 次重开哈希一致 | 2d |
| F4 | undo/redo | 命令栈，所有写走 `execute` | 写→undo→redo 数据一致 | 1d |
| F5 | preload API | 类型化 `window.sitian`；主/渲染契约 | 单元测试 + 类型检查通过 | 1d |

**第 1 周出口**：新建/打开/保存/崩溃恢复；没有任何地图/剧本 UI。

### 第 2 周：文件层 + 阅读器

| ID | 任务 | 交付 | 验收 | 估时 |
|---|---|---|---|---|
| V1 | 库扫描 | 枚举 `.md`，原文/行号/哈希 | 1,000 篇 <3s；反例库不报错 | 1d |
| V2 | 阅读器 | 原文渲染、图片、行号定位 | 任取 20 篇可读；图片显示 | 1d |
| V3 | 搜索 | 标题/正文/标签全文 | 中文/英文查询；结果定位行 | 1d |
| V4 | 监听 | chokidar 增量 | 改一篇 <1s 更新，不碰地图 | 0.5d |
| V5 | 反例 fixtures | 3 种库 × 20 篇 | 无 frontmatter/乱标题/中英混写都能读 | 0.5d |

**第 2 周出口**：能读、能搜、能看图片；不依赖任何 Markdown 结构。

### 第 3 周：Vault Profile + LLM 提案

| ID | 任务 | 交付 | 验收 | 估时 |
|---|---|---|---|---|
| L1 | Provider | OpenAI-compatible + Ollama；safeStorage | 两家都能返回 JSON；密钥不落日志 | 1d |
| L2 | Profile bootstrap | 抽样 10–20 篇 → 类型/关系提案 → 编辑/批准 | 用户 10 分钟内批准；不批准不能全库 | 2d |
| L3 | 抽取流水线 | 段落/Token 分块、JSON Schema、证据行号 | 20 篇黄金集 precision/recall 有数；无证据字段 0 | 2d |
| L4 | 审阅 UI | 新建/更新/冲突/新类型四类；逐条接受 | 接受才写；写后一条 undo | 2d |
| L5 | 注入/幂等 | 正文当数据、缓存键 | 注入样例 0 实体；重跑提案一致 | 1d |

**第 3 周出口**：单文件夹 20 篇能产出可审阅提案；不自动写。

### 第 4 周：底图 + 渲染 + 命中

| ID | 任务 | 交付 | 验收 | 估时 |
|---|---|---|---|---|
| M1 | `.map` 导入 | 复用 Azgaar 字段；预览省数/包围盒 | 200/415 省导入成功，字段对齐 | 2d |
| M2 | 相机/渲染 | Canvas2D、DPR、缩放/平移、分层 | 200 省拖动 p95 <20ms | 2d |
| M3 | 命中/选中 | 点选省、高亮、属性面板 | 点在洞/飞地/海里结果正确 | 1d |
| M4 | 保存/重开 | 与项目存储接通 | 省数/面积/归属哈希一致 | 1d |

**第 4 周出口**：能导入一张真实底图，选中省份，保存重开不变。

### 第 5 周：涂势力 + 导出

| ID | 任务 | 交付 | 验收 | 估时 |
|---|---|---|---|---|
| P1 | 势力 CRUD | 新建/改名/颜色/删除 | 删除清 ownership；一条 undo | 1d |
| P2 | 涂归属 | 屏幕像素半径、布尔并/差、预览=落库 | 一笔一 undo；空省标 empty 不残留 | 2d |
| P3 | 时间点 | 年份/月日游标；ownership 快照 | 切年份颜色/归属正确 | 1d |
| P4 | 导出 | SVG + PNG，标题/图例/比例尺 | 3680×1752 非空白；连导两次 0px 差 | 1d |

**第 5 周出口**：一张图能从数据到 PNG，全程可撤销。

### 第 6 周：5 步主流程 + 验收

| ID | 任务 | 交付 | 验收 | 估时 |
|---|---|---|---|---|
| W1 | 5 步壳 | 步骤条、下一步/返回、禁用原因 | 主界面 ≤5 主按钮 | 1d |
| W2 | 空态/错误 | 没项目/没底图/没势力/没时间点 | 每步都有可执行提示 | 1d |
| W3 | 端到端 | Playwright Electron | 冷启动 5 分钟完成 PNG | 2d |
| W4 | 真实试用 | 你的真实库/底图 | 连续 3 次无 P0 数据问题 | 1d |

**出口判据（唯一）**：一个没看过司天的人，5 分钟内独立完成一张 PNG；否则切片失败，不加功能。

---

## 5. 后续模块（接口先定，任务后展开）

### 5.1 剧本（外交/事件/切片/动画）

- 数据：`Scenario` 已含 `diplomacy/events/slices`；写入口必须经 `scenario` 命令。
- 屏幕：时间轴底栏 + 地图模式（政治/外交/事件）+ 右侧详情。
- 参考：EU4 的时间轴/外交表；CK3 的事件弹窗。**只抄交互，不抄资源。**
- 任务展开前提：地图切片已稳定，ownership 快照可复现。
- 验收：一个 200 省剧本 300→500 年逐年导出；外交事件改归属可 undo；30 秒动画可生成。

### 5.2 星系 / 3D

- 数据：`Entity` 的 star_system/planet/moon + `space` 模块坐标/轨道。
- 2D 先做：选择/缩放/航道/进入行星；3D 用 three.js，Raycaster 拾取，CSS2D 标签。
- 任务展开前提：2D 数据与地图共用 Entity，禁止第二套事实源。
- 验收：100 恒星系 30fps；点选进入与 2D 一致；3D 关闭不影响功能。

### 5.3 Obsidian 写回 / 双库 / 云

- 写回：`diff → 用户勾选字段 → 备份 → 原子写 → 审计`；冲突进“待裁决”。
- 双库：实体映射表 + 冲突表；不自动合并。
- 云：Git（isomorphic-git）先做；WebDAV 次之；对象存储最后。
- 验收：20 篇写回 diff 正确；冲突不丢任何一方；断网可恢复；仓库有备份。

---

## 6. 测试与证据

- **单元**：schema、几何、河宽、导出 SVG、归属快照。
- **E2E**：Playwright Electron，禁止固定屏幕坐标；一律从 `boundingBox` 算。
- **反例库**：无 frontmatter / 乱标题 / 中英混写 / 同名 / 矛盾。
- **数据安全**：强杀 20 次、断电模拟、100 次保存/重开。
- **性能**：200 省拖动 p95 <20ms；保存不阻塞手势；1,000 篇首扫 <3s。
- **AI**：20 篇黄金集、schema 合法率、证据覆盖、注入、幂等、成本/吞吐。
- **对照测试**：Azgaar 导入字段、perfect-freehand 轮廓、polygon-clipping 面积，和 upstream 对齐。

---

## 7. 预算与止损（写死）

- 每个切片开始前定 **token/时间上限**；到期只验收，不延期。
- 切片失败 → 回滚到上一个可用版本，不把失败代码留在主路径。
- 连续 3 次真实使用无 P0 数据问题，才开下一个模块。
- 写回/云/3D 最后做；基础不稳时做这些，只会放大损失。
- 不再由 agent 宣布“修好了”；只认你当场完成一件事。

---

*本规格先覆盖 6 周切片；剧本/3D/同步在开工前按同样粒度展开任务单，不再用周级空话。*
