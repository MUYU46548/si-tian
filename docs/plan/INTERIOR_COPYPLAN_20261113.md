# 建筑内部地图 · 抄写方案（2026-11-13）

> **一句话**：抄 **一家**——`theLodgeBots/open3dFloorplan`（MIT，v0.9.0）。它的 2D 就是 **Canvas 2D 纯函数**，
> 和我们技术栈几乎同构；数据模型、房间自动围合、墙/门窗绘制、出图四件都在一个仓库里。
> Sweet Home 3D 只用来**对照字段完整性**，一行代码都不搬（GPL-2.0）。
> **本文只整理，未动工。**

---

## 一、为什么是这一家

| 项目 | 许可 | 2D 技术 | 差距 | 结论 |
|---|---|---|---|---|
| **theLodgeBots/open3dFloorplan** | **MIT** | **Canvas 2D（纯函数）** | 3D 用 three 0.182，我们是 0.128 | **主抄**：模型 + 房间算法 + 2D 绘制可整块搬 |
| wy51ai/floorplan-3d | MIT | SVG + three | 单 HTML、数据写死在文件里 | 只参考“2D↔3D 实时同步”的做法 |
| Sweet Home 3D | **GPL-2.0** | Java Swing | 语言不同、许可有传染性 | **只对照字段**，不搬代码 |
| NeonPlan 3D | MIT（核心） | TS | 绑 Home Assistant | 只参考“房间派生墙”的反向思路 |

**关键发现**：open3dFloorplan 的 `src/lib/utils/canvasRenderer.ts` 文件头自己写着
“All functions are pure”，参数是 `CanvasState + 数据`，不碰任何框架响应式 —— 这意味着
**它的渲染层可以近乎逐行改成我们的 JS 模块**，不必重写。

---

## 二、数据模型：我们缺的是整整两层

### 现状（`store/geodataModules/interior.js:21-31`）

```js
floors: [{ id, name, level, furniture: [], createdAt }]
```

**没有 walls、没有 rooms、没有门窗、没有楼层高度、没有地板。**
所以“房间模板”只能摆一片家具 —— 程序里没有“房间”这个概念可以画。

### 目标（照抄 `src/lib/models/types.ts`，字段原名不动）

```js
Floor {
  id, name, level,
  walls:      Wall[],
  rooms:      Room[],          // 由墙自动检测，不手画
  doors:      Door[],
  windows:    Window[],
  furniture:  FurnitureItem[],
  stairs:     Stair[],
  columns:    Column[],
  backgroundImage?: BackgroundImage,
  guides:     GuideLine[],
  measurements:   Measurement[],
  annotations:    Annotation[],      // 尺寸标注
  textAnnotations: TextAnnotation[],
  groups:     ElementGroup[],
}

Wall   { id, start:{x,y}, end:{x,y}, thickness, height, color,
         curvePoint?:{x,y},        // 二次贝塞尔弧墙
         texture?, interiorColor?, interiorTexture?, exteriorColor?, exteriorTexture? }

Room   { id, name, walls:string[],   // 墙 id 列表 —— 房间不存多边形！
         floorTexture, area, color?, roomType?, labelOffset? }

Door   { id, wallId, position:0..1, width, height,
         type:'single|double|sliding|french|pocket|bifold',
         swingDirection:'left|right', flipSide:boolean }

Window { id, wallId, position:0..1, width, height, sillHeight,
         type:'standard|fixed|casement|sliding|bay' }

FurnitureItem { id, catalogId, position:{x,y}, rotation,
                scale:{x,y,z}, color?, width?, depth?, height?, material?, locked? }
```

🔴 **最要紧的一条设计**（原方案写错过，已按实测修正）：`Room` 存 **墙 id 列表 + 顶点序 `polygon`**。

最初打算"只存墙 id、多边形每次从墙现算"，理由是避免双源。**实测证明这条路走不通**：
`getRoomPolygon` 在 T 交点处会挑错相邻墙（同一点上挂着三道墙），结果两间房都被绕成外框 ——
画面上表现为"两间房面积都变成 12㎡、标签叠在中心"。顶点顺序**只能由最小环遍历给出**。

所以：检测时把顶点序一起存下；墙一改就重新检测（写口已挂 `floorChangeHook`），因此不会留下双源。
`getRoomPolygon` 仍保留"从墙回拼"的分支，只为兼容没有 `polygon` 的老数据。

### 迁移（老 `.sitian` 里只有 furniture）

**不升 schema 版本，走“只补空”**（沿用 `migrate-vault-attrs` 的纪律）：

1. 读入时：`floor.walls ??= []`、`floor.rooms ??= []`、`floor.doors ??= []` …（缺哪补哪，全是空数组）
2. 已有 `furniture` **一个字段都不动**，坐标尺度不变（现在就是世界单位）
3. 首次进编辑模式时提示一句：“这层还没有墙，先画墙，房间会自动生成”
4. 写盘时整份 `.sitian` 只多几个空数组，实测约 +40 字节/层

---

## 三、核心算法：房间由墙自动围合（直接搬）

来源：`src/lib/utils/roomDetection.ts`，**纯数学、零依赖、约 150 行**，可直接翻成
`src/renderer/src/utils/roomDetection.js`。

### 四步

1. **T 型交点打断**（`splitWallsAtTJunctions`）
   把所有墙端点两两投影到其它墙上，落在线段内部且距离 `< EPSILON(5)` 就打一个断点，
   把一面墙切成若干子段 —— 不打断的话，共享墙的两个房间会被判成一个环。
2. **建图**：端点按 `EPSILON` 聚合为顶点（`findOrAddVertex`），建立邻接表，**每个顶点按角度排序**。
3. **最小环遍历**（leftmost turn）：从每条有向边出发，每次在下一顶点选“相对来向最小的正向转角”，
   一直走到回到起点 → 得到一个最小面（一个房间）。
4. **过滤**：鞋带公式算面积，`area < 1000` 或 `> 10,000,000` 丢掉；墙集合重复的房间丢掉
   （同一组墙围出的面只留一个）。

### 已知局限（搬过来必须改的三处）

| 局限 | 后果 | 改法 |
|---|---|---|
| `for (step = 0; step < 20; step++)` | 超过 20 段的房间（大宅/异形）**检测不出来** | 改成 `edges.length * 2` 动态上限 |
| 只按“同墙集”去重 | 套间（两个房间共用三道墙）可能判重 | 加质心距离判据 |
| `EPSILON = 5`（cm 口径） | 我们的室内尺寸是**世界单位**，量纲不同 | 按楼层尺寸取 `max(0.5, 层对角线 × 0.002)` |

### 我们侧已有的可复用件

- `polygon-clipping@0.15.7`（省份布尔用过）—— 这里用不上，但墙多边形合并可用
- `utils/polygonBool.js` 的注入式写法 —— 房间检测也照这个模式写，方便 Node 单测

---

## 四、2D 渲染：三个技法 + 一条绘制顺序（可整块搬）

来源：`src/lib/utils/canvasRenderer.ts`（纯函数，Canvas 2D）。

### 技法一：墙 = 显式四角多边形，不是粗线

```
n = (-dy, dx)/len                        // 单位法向量
四点 = s+n·t/2, e+n·t/2, e-n·t/2, s-n·t/2   // t = thickness
```
曲线墙（`curvePoint`）：贝塞尔采样 24 段，每段法向偏移，外沿正向 + 内沿反向拼成闭合多边形。

屏幕厚度 `max(thickness * zoom, 4)` —— 缩到再小也看得见 4px。

### 技法二：转角用圆盖，不做斜接

墙与墙各自独立画，转角处按端点坐标聚合，凡是 ≥2 面墙共用的端点，
画一个半径 `max(共享墙厚) * zoom / 2 + 0.5` 的实心圆盖住接缝。
**代价**：这是视觉遮盖不是几何合并，描边在接头处仍可能露一条缝 —— 我们改成“圆盖 + 同色描边”两层。

### 技法三：门窗挖洞 = 先在墙上涂一块背景色矩形

取墙上 `position`(0..1) 处的点与法向量，缺口的沿墙半宽 = `width/2 * zoom`、
法向半宽 = `thickness/2 + 1`，先在墙上盖一块背景色矩形把墙“擦”掉，再画门窗符号。

🔴 **它这里有个坑**：背景色写死 `#fafafa`，换底色/深色模式就露馅。
我们改成 `globalCompositeOperation = 'destination-out'` 真挖洞，或取图层实际底色。

### 绘制顺序（我们的层要按这个排）

```
1 网格（step < 4px 跳过）
2 房间填充 → 地面纹理（zoom < 0.3 跳过）→ 选中虚线 → 名称+面积
3 墙（多边形 → 纹理 overlay → 尺寸标注）
4 墙接头圆盖
5 门 / 窗（挖洞 + 符号）
6 家具（图标/色块）→ 名称
7 楼梯 / 柱
8 参考线 / 测量 / 文字标注 / 尺寸标注
9 吸附点 → 选中手柄（也画在同一 canvas，不用 DOM 浮层）
```

---

## 五、3D：不搬代码，搬思路

- 它用 `three@0.182`，我们是 `^0.128.0` —— **API 有 breaking change，`ThreeViewer` 不能直接搬**。
- 但 3D 本身没有新数据：**墙挤出（thickness × height）+ 家具按 footprint 立盒子**，
  同一份 `Floor` 数据。Sweet Home 3D 也是这么做的（2D↔3D 同源）。
- 我们已经有动态 `import('three')` 的先例（星系 3D 观景），接入点现成。
- **结论：3D 放在最后一刀，且不阻塞前四刀。**

---

## 六、不抄的清单（每条给理由）

| 不抄 | 理由 |
|---|---|
| `static/models/*.glb` 140+ 个家具模型 | 体积（几十 MB）；我们改**矢量图标**（已有 `Icon.vue` + `drawIconOrEmoji`），25 类足够 |
| `dxf-writer` / `jspdf` 导出 | 我们只要 SVG + PNG，`utils/svgExport.js` 已有 |
| Firebase 云同步 / 版本历史面板 | 我们是本地文件应用，`.sitian` 自带快照 |
| SvelteKit 组件（`FloorPlanCanvas.svelte` 等） | 框架不同；只搬 `utils/` 里的纯函数 |
| `roomplanImport`（iOS RoomPlan 扫描） | 无关 |
| Sweet Home 3D 任何代码 | GPL-2.0 传染性，只对照字段 |

---

## 七、分刀（每刀能单独验收；2.5 是复核后补的交互刀）

| 刀 | 内容 | 新增/改动 | 验收 | 能看见什么 |
|---|---|---|---|---|
| **0** | **建筑尺度**（前提，没有它后面全是假数） | 建筑节点加 `footprint{w,h}` + `unitScale`；家具给真实默认尺寸；网格分级；按 footprint 自适应初始缩放 | 造一间 8×6m 小屋与一座 300×200m 宫殿，各自打开都铺满视口、面积数字对得上 | 家具不再是 40×40 的方块 |
| **1** | 数据模型 + 迁移 | `interior.js` 加 8 个数组字段 + 12 个写口扩到墙/房间/门窗；`??=` 补齐 | Node 单测：老文件读入不丢 furniture；新字段可写可读；undo 一条 | 没有画面变化（打地基） |
| **2** | 房间自动围合 | 新增 `utils/roomDetection.js`（纯函数，注入式） | 单测 5 条：矩形 / L 形 / 共享墙两间 / T 交点 / 不闭合不出房间 | 画三面墙 → 不改代码就出现房间名 + 面积 |
| **2.5** | **画墙交互**（第一版漏了，没有这一刀墙画不出来） | 点-点连画 / 端点吸附 / 正交与 45° 约束 / 双击结束 / 拖端点改形状；抄 `alignment.ts` + `canvasInteraction.ts` | 手工演练：画一个 4 面墙闭合的矩形房间，≤10 次点击 | 能自己把一层楼画出来 |
| **3** | 2D 重画 | `InteriorView.vue` 的 `drawFurniture` 前后各加墙层/房间层/门窗层；家具改矢量图标 | 截图对比：白底彩块 → 墙 + 房间填充 + 门窗符号 | **这一刀就是“像样”** |
| **4** | 出图 | 复用 `svgExport.js`，**加图面要素**：比例尺 / 指北 / 图例 / 标题栏 / 房间面积表（抄 `PrintLayout.svelte`） | 导出的图与画布逐像素对拍（同源）；图上四要素齐全 | 一张能贴进设定集的平面图 |
| 5（可选） | 3D | three 0.128 薄渲染器 | 同机位 2D/3D 对照 | 3D 预览 |

**每一刀都可以停。** 第 3 刀做完，这块就已经“能看、能拼”。

---

## 八、风险

| 风险 | 影响 | 处置 |
|---|---|---|
| 房间检测 20 步上限 | 复杂户型漏房间 | 改动态上限，并写进单测（异形 24 边形） |
| `EPSILON` 量纲错配 | 墙吸不上/误吸 | 按楼层对角线取相对值，不用绝对值 5 |
| 门窗挖洞硬编码底色 | 深色底露馅 | 用 `destination-out` |
| 新写口绕过写闸门 | 只读态能改数据 | 每个新写口 `guardWrite(...)` + 一条 `execute()` undo（`writeGate` 现有纪律） |
| `.sitian` 体积 | 每层多几个对象 | 墙按 40 B/面估，一层 30 面 ≈ 1.2KB，可忽略 |
| 3D 版本差 | three 0.182 代码不能直接用 | 第 5 刀单独处理，前四刀不依赖 |

---

## 九、来源（可复查）

- 仓库：`github.com/theLodgeBots/open3dFloorplan`（README 里的 clone 地址）；
  `github.com/CattleD0g/open3dFloorplan` 是同内容镜像。**MIT，v0.9.0，作者 theLodgeStudio**。
- 数据模型：`src/lib/models/types.ts`
- 房间检测：`src/lib/utils/roomDetection.ts`
- 2D 渲染：`src/lib/utils/canvasRenderer.ts`
- 3D：`src/lib/components/viewer3d/ThreeViewer.svelte`（three ^0.182）
- Sweet Home 3D 字段对照：`.sh3d` = ZIP + `Home.xml`，
  `levels / walls(plan line + thickness + height) / rooms(outline + floor/ceiling) / pieceOfFurniture / doorOrWindow / light`，
  2D 与 3D 是同一份 Home 的两种渲染。

---

## 十、补遗：第一版漏掉的七类（2026-11-13 复核）

> 这一节是自查出来的缺口，不是补充说明。**其中 C 与 F 会直接导致返工，必须先处理。**

### A. 数据模型漏了四个概念

| 漏的 | 为什么必须有 | 从哪抄 |
|---|---|---|
| `Floor.elevation`（本层离地高度） | 多层建筑的层高。`level` 只是序号，接不了楼梯也接不了 3D 叠层 | Sweet Home 3D 的 `level elevation`（open3dFloorplan 没有，是它的短板） |
| `Room.ceiling`（天花板材质/高度） | 我写了 `floorTexture` 漏了 ceiling；3D 里天花板是“看进去看不见墙顶”的关键 | Sweet Home 3D `room ceiling` |
| `FloorOpening`（楼层洞口） | 楼梯必须穿过楼板。open3dFloorplan 的 `Stair` 只是个符号，跨层是断的 | NeonPlan 3D（floor openings / cellars） |
| 墙的**连接关系** | Sweet Home 3D 用 `wallAtStart/wallAtEnd` 显式引用；我们和 open3dFloorplan 都靠“端点坐标相等”匹配 → **拖走一面墙，另一面不会跟着走** | 建议：坐标匹配为主 + 一条 `attachedTo` 弱引用，拖动时联动 |

### B. 交互层整层没写（最大的遗漏）

第一版只写了“数据长什么样、画成什么样”，没写**怎么画出来**：

- 画墙：点-点连画、端点吸附到已有墙/顶点、正交与 45° 约束、双击/回车结束、闭合高亮提示
- 编辑：拖端点（联动相邻墙）、拖中段整体平移、改厚度、拉成弧墙
- 对齐辅助线（虚线 + 距离数字）
- 交互状态机（当前工具 / 拖拽上下文 / 多选）
- 快捷键（画墙、门、窗、选择、撤销）

→ 对应 open3dFloorplan 的 `utils/alignment.ts`、`utils/canvasInteraction.ts`、`utils/shortcuts.ts`。
**已补成第 2.5 刀。**

### C. 会红的既有用例（**必须先知道，否则又是一次“红了不知道为什么”**）

`scripts/tests/cases/test_37_interior_view.py:23`：

```python
EXPECT_TEMPLATES = {'bedroom': 4, 'kitchen': 4, 'hall': 7, 'study': 4, 'storage': 4}
```

这是**字面量锁定 5 个房间模板的家具件数**（`ROOM_TEMPLATES` 在 `InteriorView.vue:484`，模板是纯家具清单）。
一旦让模板“带墙”（`walls` + `furniture` 两段），这四个数必然变 → 用例必红。

**处置**：第 3 刀前先把判据从“件数”改成“墙数 + 家具数”，并在用例注释里写明改的理由；
`test_25` / `test_27` 同样复查（它们也读家具集合）。

### D. 出图缺图面要素

“能贴进设定集”不只是导出一张 PNG，还要：**比例尺、指北针、图例、标题栏、房间面积表**。
open3dFloorplan 有 `PrintLayout.svelte` 专门做这件事。**已补进第 4 刀。**

### E. 与主程序的挂接比想象的松（这是好消息，但要说清）

- `InteriorView` 是**受控组件**：`buildingNode` 是 prop（`InteriorView.vue:303`），
  `App.vue` 按 `store.viewLevel === 'interior'` 挂载。**它不自己取 store** → 后期拼接成本低。
- 但 `AreaMap` 上建筑只是一个**节点 marker，没有 footprint** → 内部图是**独立坐标系**，
  不需要和区域图做比例对齐。所以“拼上去”是真的拼，不是几何嵌合。
  → 将来若要把内部图叠进 3D 世界，必须先给建筑加 footprint，这是另一个任务，本期不做。

### F. 许可合规（漏了，会留隐患）

搬 MIT 代码必须在仓库根的 `THIRD_PARTY_NOTICES.md` 登记：
**项目名 / 仓库地址 / 许可 / 版本 v0.9.0 / 搬了哪些文件 / 改动说明**。
`AGENTS.md` 里已有第三方声明纪律，第一版方案一句没提。

### G. 性能：房间检测不能在拖拽中每帧跑

`detectRooms` 有 O(n²) 的端点投影 + 环遍历。几十面墙不成问题，但**拖墙/拖端点时每帧跑会掉帧**。
处置：拖拽中只画墙不检测，**松手（pointerup）才跑一次**，并缓存到“墙数组引用”上
（与 `ringAreaCache` 同一套按引用失效的纪律）。

---

## 十一、尺度：宫殿和小房子同一个编辑器，怎么定口径

> 这是**我该自己先想的**。不问你，直接定，理由在下面。

### 病根不在内部图，在上一层的接口

`AreaMap` 上建筑只是一个节点 marker，**没有 footprint**。于是一栋占地 300×200 米的宫殿
和一间 8×6 米茅屋，在世界里是同一个点、同一个尺寸。内部图各画各的，两者之间**没有任何尺度联系**——
不是“画得小”，是**世界本来就没有尺度**。

### 定三个口径（唯一事实 = 真实厘米）

```js
building = { ...现有字段,
  footprint: { w: 800, h: 600 },   // 世界平面尺寸，厘米。茅屋 800×600，宫殿 30000×20000
  unitScale: 1,                     // 1 世界单位 = ? 厘米。旧数据恒为 1（历史口径），新数据也是 1
}
floor = { ..., elevation: 0 }       // 本层离地高度（cm）
```

**内部数据一律按厘米存**。理由：只有厘米是能和面积、比例尺、3D、真实家具对上的口径；
换成“相对格”则面积是假的、3D 拼不进世界。Sweet Home 3D 也是 cm 口径。

### 旧数据一个字节不动

现有家具默认 `width/height = 40`，那是整数凑的，不是 40 厘米的家具。
迁移策略：`unitScale` 缺省 = 1，旧坐标按原值保留（一张床仍是 40×40 单位），
**只在用户新建建筑/新建家具时用真实尺寸**。旧层想升级，走一条显式的“按真实尺寸重排家具”命令，
不在读入时偷偷换算——那会让所有历史坐标静默变味。

### 极差 37 倍怎么画：按缩放档位隐藏，不是缩小

| 档 | 看得见 | 理由 |
|---|---|---|
| 整栋可见（`zoom × footprint` 铺满视口） | 墙 + 房间填充 + 房间名/面积 | 家具在这一档下小的只有几个像素，画上去就是脏点 |
| 进入房间（`zoom ≥ 1cm = 1px`） | 上述 + 家具 + 门窗符号 | 这一档家具才有意义 |
| 放大（`zoom ≥ 4`） | 上述 + 家具尺寸标注 + 门的开合弧 | 精修 |

判断用**“家具屏幕最小边 < 6px 就整类不画”**，不是硬编码缩放阈值——宫殿和茅屋同一套判据自动分档，
这也是 EU4“缩小时只留势力名”的同一条纪律。

### 网格分级

按当前缩放取 25 / 50 / 100 / 500 cm 四档主网格，**标注永远写真实尺寸**（`3.60 m`）。
不做“格数自适应”，格式塔上一旦网格线和真实尺寸脱钩，用户量的每一个数都是错的。

### 家具真实尺寸（25 类，抄后按常见住宅订正）

床 200×150 / 单人床 200×90 / 衣柜 120×60 / 床头柜 45×40 / 餐桌 140×80 / 椅 45×45 /
沙发 200×85 / 茶几 110×60 / 书桌 140×70 / 灶台 60×60 / 冰箱 70×70 / 浴缸 170×80 /
马桶 38×70 / 洗手台 80×50 / 门 90×200 / 窗 120×140（高） / 楼梯 100×300……

→ 这些数进 `furnitureCatalog`，**新建**用真实值，旧数据保持原值。

### 这一条为什么排第 0 刀

因为它决定后面每一刀的口径：墙厚 24cm 还是 24 单位、面积显示 4.8㎡ 还是 4800、
比例尺 1:100 是真还是假。**先定口径再画，否则第 3 刀画完还要重排一遍。**


