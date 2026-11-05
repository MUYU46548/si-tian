# 交接：UI/UX 可读性专项 + 发布（2026-11-05 15:45）

> 接手先读这一页，再看 `AGENTS.md` 的“当前红线”。本页只写**当前状态、剩下的活、怎么验、坑在哪**。

## 一、用户这一轮的原话（判据的来源）

1. “**不要再让我看到一大堆乱七八糟的按钮和根本看不懂的文字**。”
2. “现在的分组把原本就紧张的地图观测空间又压扁了一大截，显然不是好主意。”
3. “画图软件千千万，随便抄都行（**别学 PS 同一个按钮位置藏多种按钮还要手动替换**，找起来累死了）。”
4. “**暂不打包，其他内容做完一起打。**” → 现在 main 上有一批未发布改动，**别单独发版**；
   UI 扫尾 + 剧本剩下的活做完再一次性出 0.5.3。

## 二、已完成（今天，全部在 main 上）

| 提交 | 内容 |
|---|---|
| `524a369` | 打包链路真机演练（`npm run test:packaged`）+ 修 3 个只在安装包里现形的缺陷 |
| `c780e2d`/`c4dee26` | 剧本“更多”→ **浮在画布上的工具面板**（5 张卡片两列），17 个纯图标按钮补名字，术语白话 |
| `c2112ad`/`d7302d1` | 行星视图 `.tool-dock` 46px 纯图标 → **104px“图标+名字”**，19 个工具全有名字 + 真机检查脚本 |
| `ec553a2` | 区域视图工具栏：对齐/分布 8 个符号补字、指南针/比例尺补字 |

发布：**v0.5.2 已上线** <https://github.com/MUYU46548/si-tian/releases/tag/v0.5.2>（79,102,647 B，
资产名 ASCII 与 `latest.yml` 一致；0.4.0→0.5.2 需手动装一次）。

## 三、协议：三个视图的“可读性”现在有闸门

| 判据 | 命令 | 期望 |
|---|---|---|
| 剧本视图 | `node scripts/tests/unit/test_toolbar_ux.js` | 5/5（分区标题 ≥4 / 每个按钮有字 / 术语黑名单） |
| 行星视图（源码） | `node scripts/tests/unit/test_toolbar_ux_planet.js` | 4/4（dock 全有名字 / 无文字按钮只允许符号·色块·插值） |
| 行星视图（真机） | `python scripts/tests/tools/shot_planet_ux.py` | 9/9 + 截图 `build/planet-ux/dock.png` |
| 区域视图 | `node scripts/tests/unit/test_toolbar_ux_area.js` | 4/4 |

三张判据都带**负向探针**（删按钮文字 / 塞“落库”必须红），改判据时别把探针删了。

## 四、没做完（按优先级）

### A. UI 扫尾（起点 157 → 现在 110 个纯图标按钮 / 37 组件）

`python build/_count_icon_buttons.py` 可复算（启发式，是**上界**）。

| 组件 | 纯图标 / 全部 | 说明 |
|---|---|---|
| PlanetMap | 21 / 161 | 剩下几乎都是色块 / 关闭 × / 缩放，已有白名单 |
| **ObjectListPanel** | **8 / 9** | 面板里 9 个按钮 8 个只有图标 —— “分不清删还是复制” |
| NodeDetailPanel | 7 / 25 | 同上 |
| AreaMap | 7 / 59 | 色块 + 标记图标选择器（白名单） |
| ScenarioMap | 11 / 138 | 都在浮层里（工具栏已清） |
| SettingsPanel / InteriorView / ClusterPanel / ZoomControls / EagleEye / WorldSelector… | 各 1–5 | 逐个看 |

**下一块建议：ObjectListPanel + NodeDetailPanel（面板里的列表操作）**，做法同前：
补 2–3 字 → 加一张 `test_toolbar_ux_panels.js`（可以把 area 那张拷过来改文件路径与作用域）。
⚠️ 区域视图**还没跑真机截图**：给 `shot_planet_ux.py` 加 `--view area`（选择器换
`.area-map-container` / `.edit-toolbar`，进视图用 `store.selectPlanet()` → `store.selectArea()`）。

### B. 历史剧本（清点在卡 `阶段目标历史剧本做到勉强可用出口判据---1af58f0b`）

25 条里**已做 15 / 剩 10**，P0 三条：

1. **外交只能查不能写** —— `addTimelineEvent/setTimelineEvents` 只存在于 `scenarioEditing.js`，
   `.vue` 里 0 调用者。缺录入表单（最小闭环：改一条关系 → 撤销 → 落盘）。
2. **标记/剧本与笔记没有绑定** —— `scenario/interaction/markers.js` 里 `notePath` 0 命中。
3. **撤销卡顿从未量过** —— 出口判据原文“待量”，`docs/plan` 无读数。

其余 7 条（演绎动画平滑 / 跨组只读总览 / 涂归属 62ms / 三层文字 / 撤销不落盘 / 重导冲突口径 /
外交写与平滑零用例）见那张卡的表格。

### C. 其它在列（非 UI、非剧本）

- 底图卡 A2 两件：同点汇入剩 10 对（要换平面化路由）、面板暴露 `minSourceRise`/`minDrainageArea`。
- 行星图“生成地形”入口（A6）。
- 回归 flake：`test_109` 挂住渲染进程并连锁红 10 条（卡 `回归里-test_109-会挂住渲染进程-6b87942c`）。
  全量回归今天实测 **150/163**，红的另一条是历史遗留，非本轮代码。
- README 特性段落后 12 笔；IMPROVEMENT_BACKLOG 11 条无主。

### D. 打包（用户明确：等全部做完）

UI 扫尾 + 剧本剩下的活收口后：`npm run dist` → `npm run test:packaged`（22 条）→ 列 0.5.3 发布说明
→ tag + Release。**注意**：`package.json` 版本现在还是 `0.5.2`，出 0.5.3 前先 `npm run bump:patch`。

## 五、踩过的坑（改 UI 必读，全部有真机证据）

1. **浮层宽度别用 `100vw`** —— 左边有导航栏，会宽出画布并拉出整页横向滚动条；用 `calc(100% - 24px)`。
2. **列容器里别给分区标题写 `flex-basis:100%`** —— 会变成“高度占满”，几个标题叠成一片文字重影。
3. **`grid-template-columns: auto-fit` 在这里算不出两列**（卡片里有宽行），要显式 `repeat(2, minmax(0,1fr))`。
4. **`.tool-group` / `.line-style-row` 要 `flex-wrap`** —— 一个组十几个按钮时会把面板撑破。
5. **给按钮加文字后，锁死尺寸的样式会裁字**（`.mini-reset` 的 24×24 就是真踩）。
6. **`Page.captureScreenshot` 在宽画布上会超 15s 读超时** —— 用 `fromSurface:false` 才拍得到。
7. **首启浮层顺序**：先关免责声明、再跳新手引导；反过来会再弹一层，截图整页是弹窗。
8. **AST 里 `{{ … }}` 是插值节点（type 5）** —— 判“按钮有没有文字”不认它会把一大片按钮误判成纯图标；
   `格距` 会命中“网**格距**离”，用负向后视 `(?<!网)格距`。
9. **`ScenarioMap.vue` 有 ≤7,000 行闸门** —— 加模板注释会把预算吃掉，样式尽量进 `scenario-map.css`。

## 六、下一步建议顺序

1. 面板类（ObjectListPanel / NodeDetailPanel）补名字 + 一张 `test_toolbar_ux_panels.js`；
2. 给 `shot_planet_ux.py` 加 `--view area` 并把区域视图补一张真机截图；
3. 剧本 P0 三件：**先立 C1/C2 判据**（外交写 / 撤销卡顿时延），再 A1 外交可写、B1 标记绑定；
4. 以上收口后一次性打包 0.5.3（含本页所有 UI 改动）。
