# 交接：星系 3D 观景（2026-10-28，`REMAINING_BACKLOG_20261027.md` §1 交付）

> 一句话：`SystemDetailView` 多了「3D 观景」按钮 —— 点开是可旋转/缩放的真实 3D 星系（行星公转、卫星绕行、
> 18 类程序化行星纹理），Esc / 按钮回 2D，**three 只在点开那一刻才下载**，关掉后 WebGL 资源归零。

---

## 1. 交付内容

| 文件 | 作用 |
|---|---|
| `src/renderer/src/components/System3DView.vue` | 3D 视图组件（three 场景 / OrbitControls / 标签投影 / 全量 dispose） |
| `src/renderer/src/utils/system3dScene.js` | **纯函数**适配层：节点 → `{star, bodies[{orbit,size,classId,phase,moons,ring}]}`（无 DOM、无 three） |
| `src/renderer/src/utils/planetArt.js` | 行星美术库：18 类程序化纹理（等距圆柱 256×128）+ 确定性 RNG（源自 SP-1025 `planetArt.ts`，MIT/自研） |
| `src/renderer/src/components/SystemDetailView.vue` | 加「3D 观景」按钮（无行星灰禁）+ `<System3DView v-if="show3d" :spec="spec3d">` |
| `vite.config.js` | `optimizeDeps.include` 预打包 three / OrbitControls（避免 dev 首开触发整页 reload） |
| `package.json` | `three@0.128.0`（钉版本） |
| `scripts/tests/cases/test_163_system_3d.py` | 回归：开→渲染→关 6 轮，每轮资源归零、2D 不重建 |
| `scripts/tests/unit/test_system3d_scene.js` | 12 条 Node 单测（确定性 / 轨道单调 / 卫星挂靠 / 类别映射 / 源码闸门） |

## 2. 口径（改之前先看）

- **依赖钉 0.128.0**：与 SP-1025 一致。0.16x 的灯光/physical 单位会漂观感，升级要重调。
- **three 必须动态加载**：`await import('three')` 只能在 `System3DView.onMounted` 里；
  `defineAsyncComponent(() => import('./System3DView.vue'))`，模板标签写 **`<System3DView>`**（PascalCase）。
- **低配观感**：AA 关 / 无阴影 / `SphereGeometry(…,24,16)` / `MeshLambertMaterial` / 像素比 1.5 封顶 /
  `OrbitControls` 只转不平移 / 每帧 `renderer.info.memory` 同步一次。
- **数据映射**：司天没有群星的 `class` 字段。`planetClassForNode()` 按 tags/名称关键字映射（气态/冰封/沙漠/
  海洋/熔岩/都市/机械…），**认不出就按 id 散列从 10 类宜居里取一款**（同 id 永远同款）；卫星兜底荒芜/冰封。
- **轨道换算**：`orbitRadius3d()` = `7.6 + 每多一圈 +3.3`，2D 公式位 75px 起。改这两个数要同步看截图。

## 3. 踩过的坑（都在 views 归档里写细了）

1. **kebab 标签静默失效**：`<system-3d-view>` → camelize 成 `System3dView`（小写 d）→ 组件解析不到、
   动态 import 被摇掉 → **构建里连 three chunk 都没有**。PascalCase 是硬要求。
2. **three 的 `info.memory` 只在渲染时记账**：构景完读到 0/0，会误判"没分配"，验收要每帧同步。
3. **卫星挂 `mesh` 会跟着行星自转**：正确层级 `pivot(公转) → holder(位置) → mesh(自转)/卫星/环`。
4. **取景余量 ×1.28**：盘面近侧被透视放大，1.04 时最外圈出画。
5. **dev 必须 `optimizeDeps.include`**：否则首开 3D 触发 Vite 依赖发现 → 整页 reload → 闪回 2D。

## 4. 判据与实测

- `python scripts/tests/run_tests.py test_163` ✅
  - 点开：canvas 出现、`frames` 增长、labels 生成、`geometries/textures > 0`；
  - 关闭（Esc 与按钮各 3 次，共 6 轮）：`memoryAtDispose` 的 geometries/textures **每轮都是 0**，
    页面 canvas 数回到 1，2D 画布引用未变。
- `node scripts/tests/unit/test_system3d_scene.js` ✅ 12/12。
- **2D 恢复**：`build/visual-audit/system3d/01-2d.png`（开 3D 前）与 `04-back-2d.png`（关 3D 后）
  逐像素比对 —— 只有工具栏一处按钮态差异（bbox 747,42–792,78），视图区完全一致。
- **构建产物**：`three.module-*.js` 601.28 kB（gzip 153.61 kB）、`OrbitControls-*.js` 11.2 kB、
  `System3DView-*.js` 10.2 kB；`index-*.js` 里搜不到 `WebGLRenderer`（首屏不含 three）。
- **截图**：`build/visual-audit/system3d/`（2D 前 / 3D / 3D 暂停 / 2D 后）。

## 5. 没做（有意留的）

1. **3D 里点行星下钻**：现在是纯观景（不改数据、不导航）。
2. **多恒星系同屏** / 双星互绕可视化：只按主恒星取色，双星不参与光照。
3. **行星类别可编辑**：类别仍由 tags/名称推断，没有「这颗是海洋星球」的显式字段。
   若要落数据，建议加 `node.planetClass`（与 `sizeOverride` 同级，走 `updateNode`）。
4. **纹理缓存常驻**：`planetArt` 的 18 张 canvas 跨开关复用（不清），换来第二次打开瞬时。
   若最后要抠内存，在项目关闭时清一次即可（`__clearTextureCache()` 已留）。
5. **低配降级策略**：目前只有"WebGL 不可用 → 报错面板"，没有自动降帧/减段数。

## 6. 建议下一步

按 `REMAINING_BACKLOG_20261027.md` §6：**阶段 0/1 欠账**（导出海面 / 锁定开关）→ 阶段 2 FMG 生成管线。
3D 若要二期，优先做「行星类别落数据 + 点击下钻」，其次才是纹理分辨率与双星。
