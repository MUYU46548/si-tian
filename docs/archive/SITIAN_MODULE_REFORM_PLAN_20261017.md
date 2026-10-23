# 司天三大模块深度分析与改造方案（2026-10-17）

> 依据：三个并行代码级扫描（历史剧本 / 宇宙星系 / 行星地图），全部结论带文件路径+行号证据。
> 定位：本文是**改造方案**，回答进度文档 `SITIAN_PROGRESS_AND_GAPS_20261017.md` §3 的五个问题，
> 并按暮雨拍板「优先历史剧本」组织。

---

## 0. 3D 星系参考文件确认

**没丢**。原位置 `C:\Users\muyu\Downloads\司天-3D星系打样-视觉参照.html`，
已归档进仓库 `docs/assets/galaxy-3d-reference.html`（连同 10-14 开发计划
`docs/DEVPLAN_LLM_FEED_AND_GALAXY_3D_20261014.md`）。

内容：Three.js r128 太阳系打样，约 300 行——程序化纹理行星（8 颗，canvas 画的条纹/地球/岩石）+
轨道线 + 恒星光晕 + 土星环 + 地月 + 小行星带 + 3200 粒星空背景 + OrbitControls（拖拽旋转/滚轮缩放）+
HTML 标签投影。暮雨拍板「直接抄」——3D 星系图按这份打样的技术路线（Three.js）做，不另起炉灶。

---

## 1. 现状总览：三个模块的真实差距

### 1.1 历史剧本——数据层已是三个模块里质量最高的，缺的全是 UI

**数据层完备**（这是好消息，改造不用动地基）：
- scenarios/baseMaps 字段稳定完整（era/polities/ownership/changeEvents/labels/markers/slicePoints；
  terrain/heightmap/rivers/routes/burgs/landFeatures）
- 日期/时间轴/切片/EU4 分级标注全部在纯函数层（scenarioDates / scenarioTimeline /
  scenarioSlices / polityLabels 共约 100 个纯函数，无 store 无 IO）
- store 50+ 写口全部走 undo + 写闸门
- 落盘双路径（.sitian 项目文件为主 / 知识库 scenarios.json 为辅）有防静默回退机制（fillMissingOnly）

**真正缺的全部是 UI/接线构件**（缺失清单，每条有证据）：

| # | 缺什么 | 现状证据 |
|---|---|---|
| 1 | 前置选择视图 | WorldSelector.vue:9 按钮无参数 → App.vue:1395 enterScenarioMode 无参数无路由 → 直接挂 ScenarioMap |
| 2 | 剧本卡片组件 | 唯一"列表"是编辑器内侧栏两行文字（ScenarioMap.vue:869-883） |
| 3 | 任意剧本×任意日期→缩略图 | buildMinimapThumb 无 era 参数且组件私有；buildScenarioSVG 有 era/date 但依赖已挂载编辑器 |
| 4 | 钩子文案/封面/强调色字段 | schema 里只有 description/sourceNote（scenarioEditing.js:1096-1097） |
| 5 | 开局态势派生函数 | 只有 scenarioMeta「N 势力 · M 省」；开局版图需 currentOwnerAt 按起始年求值（纯函数已有，没人调） |
| 6 | store 级「当前选中剧本」 | selectedScenario 是组件本地 ref（ScenarioMap.vue:1769），编辑器外拿不到 |
| 7 | 卡片→剧本进入通路 | 入口按钮与 enterScenarioMode 均不接受剧本参数 |

### 1.2 行星地图——工具面接近 FMG，缺的是「政治层」和双向闭环

16 个工具大多能用（绘制省份/区域/标记/道路 A*/智能聚落/文本/簇/高度笔刷/地形笔刷/文化宗教笔刷/
地貌笔刷/河流编辑器/参考图校准/快照/导出），仅 political 是死按钮（只有按钮无 handler）。

结构性断点（按重要性）：

| # | 断点 | 后果 |
|---|---|---|
| 1 | 省份没有政治属性 | 省份只有 name/type/elevation/climate/ecology，没有归属/人口/发展度——EU4 的核心对象缺席 |
| 2 | mapData ↔ baseMaps 单向同步 | 行星图辛苦画的省份进不了剧本；剧本改了不回流行星图 |
| 3 | 行星→区域下钻数据断裂 | AreaMap 是白底+参考图，不继承行星地形与比例；areaZones 与 mapData.regions 是两份无关数据 |
| 4 | .map 导入入口只在 ScenarioMap | 行星空态提示"先导入 .map"指向不可达入口 |
| 5 | 保存语义不诚实 | 项目模式只 staged 推送，UI 显示已保存 |

### 1.3 宇宙星系——表现层有基础，系统层为零

- **表现层已有**：星云/星尘/暗角/LOD/光晕闪烁/凸包势力边界/分类型航道/鹰眼/骨架屏/图层开关/叙事淡化
- **系统层 = 0**（逐项检索）：无时间推进（全 src 只有 3 个 setInterval，全是性能统计/备份/剧本播放）、
  势力字段 `faction` 无任何写入路径（图例对真实库恒为默认色）、无事件系统、
  舰队卡片是静态信息卡（代码注释明写"无策略行为"）、航道只做渲染无成本语义
- **6 个表现层 bug**：GalaxyMap 画布改坐标是死代码（头部提示"拖拽恒星编辑坐标"与实现不符）、
  势力改色不触发重绘、星域位置不持久（环形布局现算、radius:350 硬编码）、
  导出用第三套实现与画布不同源、hitTest 的 domain 分支不可达、右键菜单不检查 editMode

---

## 2. 改造方案（按优先级）

### P0：历史剧本模块（最简单最独立，做好直接可用）

**MVP 定义**：用户点「历史剧本」→ 看到一排剧本卡片（年代+缩略图+钩子文案+开局态势）→
点一张卡 → 直接进入该剧本该年代的地图。这就是 EU4 选剧本界面的对标物。

**改造清单**（按依赖顺序，5 步）：

1. **扩 schema**（scenarioEditing.js）
   - 新字段：`hook`（短钩子文案 1-2 句）、`thumbnail`（可选缓存 dataURL）、`accentColor`（卡片强调色）
   - 管理表单加对应输入框（ScenarioMap.vue:1071-1100）
   - 低风险：新字段可选，旧数据无感

2. **下沉缩略图渲染**（useScenarioExport.js → 独立函数）
   - 把 buildScenarioSVG 的「era/date → SVG」核心逻辑抽成无副作用函数（不依赖已挂载组件）
   - 输入：baseMap + scenario + date → 输出：缩略 SVG/dataURL
   - 按剧本缓存（内存即可，重开重算）
   - 这是最大技术点：buildScenarioSVG 依赖注入多（store/baseMap/timeline/camera）

3. **开局态势派生函数**（新纯函数）
   - 输入：scenario → 输出：开局年 top 势力 / 面积占比 / 构成摘要
   - 复用 currentOwnerAt（scenarioTimeline.js:449 已有，目前只在画布渲染用）
   - 卡片上显示「开局：A 国控制 45% 疆土」

4. **新增 ScenarioPicker.vue（前置选择视图）**
   - App.vue 增加 scenarioMode 状态：'browse' | 'edit'
   - 卡片墙布局：每张卡 = 缩略图 + 罗马数字 + 名称 + 起止年 + 钩子文案 + 开局态势摘要
   - 空态：「尚无剧本，进入编辑器新建」
   - 点卡片 → emit('select', {scenarioId, year}) → enterScenarioMode 带参

5. **打通进入通路**
   - WorldSelector「历史剧本」按钮 → 打开 ScenarioPicker（而非直接进编辑器）
   - ScenarioPicker 选中 → App.enterScenarioMode(scenarioId, initialYear)
   - ScenarioMap onMounted 接收 props，自动调 selectScenarioAt 等价逻辑（切 era + 落起始年 + scenario 视图）
   - 编辑器内保留「返回选择」按钮

**工作量**：约 3-4 个会话（schema 0.5 + 缩略图函数 1 + 态势函数 0.5 + Picker 组件 1 + 接线回归 0.5-1）
**不动什么**：数据落盘层一行不改（.sitian 为主 / scenarios.json 为辅的双路径与 fillMissingOnly
语义有 2026-10-06 静默回退事故的前车之鉴）
**最大风险**：缩略图函数下沉；其余全是增量 UI

**视觉决策已拍板（2026-10-17，依据 `docs/assets/scenario-picker-mockup.{html,png}` 小样）**：
- **缩略图 = 方案 B（Canvas 烘焙）**：地形分层设色 + 势力半透明叠加 + 河流/海岸线，
  信息密度对齐 EU4 剧本封面。小样的方案 A（SVG 矩形拼贴）被否——"对不齐、割裂、像早期自研的粗糙感"。
  性能对策：① 逐张离屏烘 + 每张之间 `yieldToPaint()`（复用剧本铺底的让出方式，进度真的会刷新）；
  ② 首张优先、其余低分辨率占位再高清替换；③ 同一底图共享地形层位图（三个剧本只有势力叠加层不同，
  地形只烘一次）——把 N×(地形+叠加) 降到 1×地形 + N×叠加。
- **沉浸模式照小样形态做**（快捷键 I）：细顶条 + 底部悬浮胶囊 + 右下角小地图；
  **小地图加一个手动显隐按钮**（暮雨要留、有人要收——默认开，按钮记住偏好）。
- **钩子文案 = schema 独立 `hook` 字段**（与 description 分离：description 是长注记、hook 是卡片钩子），
  管理表单加一行「钩子文案（卡片显示，1–2 句）」；卡片两行截断。

### P1：行星地图（先修两个断点，再谈政治层）

按重要性排序：
1. **起步闭环**：.map 导入入口收进行星视图空态（现在提示指向 ScenarioMap）
2. **保存诚实**：项目模式 staged/persisted 差异显示给用户
3. **河流观感**（已知两条根因：流向路由平局打破 + 有结构的推演地形——山脉走向/高原面/裂谷）
4. **省份政治属性 + mapData↔baseMaps 双向**（第二阶段，需先解决数据闭环，否则做了接不上）

MVP 定义：用户从空行星出发，导入 .map 或推演地形 → 河流不劝退 → 画省份 → 放聚落 → 连道路 →
导出 PNG，全程可撤销、重开数据还在。

### P2：宇宙星系（6 个 bug 先修，3D 按既定路线）

1. **6 个表现层 bug**（周级以内）：画布改坐标接通、势力改色重绘、星域位置持久化、
   导出与画布同源、hitTest domain 分支、右键 editMode 门控
2. **真数据进料**（LLM 进料工具是前置，等数据落地）
3. **3D 星系图**（终态，直接抄 Three.js 打样）

**3D 路线**（暮雨拍板"直接抄"）：
- 参考：docs/assets/galaxy-3d-reference.html（Three.js r128）
- **z 坐标策略：先做「渲染派生」**——z 由层级+index 推出（星域分层高度/轨道倾角），
  坐标仍存 2D → 避开 coordinate 39 文件 326 处的改动；用户手动摆的高度暂不持久化
  （若要持久化 z，需升 PROJECT_VERSION + 改 extract-data / projectSchema / geodata 写口全链）
- 替换范围：useCanvasRenderer 的 3D 等价物（保持 focusOn/fitView/requestRender 对外契约，
  ZoomControls/EagleEye/ContextMenu 接口不变）+ 三个视图（4264 行）的绘制/命中重写
- **依赖**：LLM 进料真数据落地——没有真恒星/行星数据，3D 只是换个方式画公式生成的假位置

MVP 定义（展示型）：真数据下钻链路成立（星域→域内→单系→行星），3D 可拖转缩放，
提示与交互一致，导出与画布一致，势力色可区分。

**与《群星》的差距定性**：主体是**系统层**（时间推进/势力/事件/舰队/外交一行都没有），
但"能拿给人看"的短板只是表现层一致性+真数据进料（周级）。若目标是世界观可视化，
不应按群星的系统层立项。

---

## 3. 回答进度文档 §3 的五个问题

1. **三个模块的 MVP 定义** → 已在 §2 各节给出（剧本=卡片墙+点卡进入；行星=空行星到导出 PNG 六步；
   星系=真数据下钻+3D 可交互）
2. **表现还是系统** → 星系：能玩=系统层（另一个量级），能看=表现层（周级）；行星：表现层基本够，
   缺政治层；剧本：全是 UI，数据层已完备
3. **谁是判据** → 建议每个 MVP 定义一条**端到端工作流脚本**（按用户操作路径走，不看源码）——
   这正是进度文档说的「用户视角验收脚本」，剧本模块改造时一并建立
4. **要不要砍** → 剧本先行（暮雨已拍板），行星第二，星系第三；三者不并行
5. **止损线** → 剧本 MVP 3-4 会话内见分晓：卡片墙做出来后用户仍觉得"不能用"，
   说明问题不在视图层（那时再查数据内容质量）

---

## 4. 顺带修掉的技术债（随各模块改造一并做）

| 债 | 随哪个模块修 |
|---|---|
| ScenarioMap.vue 9600+ 行 | 剧本改造时把剧本管理对话框/卡片逻辑外提 |
| test_54 写闸门只查登记不查走 execute | 剧本改造时补写法校验 |
| riverTrace.opts.upsample 死选项 | 行星 P1 顺手删 |
| setupState 不暴露 import 绑定 | 剧本改造时补（缩略图函数需要被用例直接调） |
| 判据体系缺端到端工作流 | 剧本 MVP 验收脚本开个头 |
