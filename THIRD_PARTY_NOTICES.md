# 第三方代码与许可（THIRD PARTY NOTICES）

司天自身代码为项目私有；下面这些**第三方来源**随仓库分发或改写自第三方，必须保留本页。

---

## 1. 高度图模板（`src/renderer/src/utils/fmg/templates.js`）

```
Copyright 2017-2024 Max Haniyeu (Azgaar)
SPDX-License-Identifier: MIT
Source: Azgaar/Fantasy-Map-Generator @ 67d555b8, src/data/heightmap-templates.ts
经 SP-1025 planet-map/src/core/heightmap/templates.ts 转手，再由本项目移植为 ESM。
```

MIT 许可证全文：

```
MIT License

Copyright (c) 2017-2024 Max Haniyeu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. 高度图模板解释器（`src/renderer/src/utils/fmg/generator.js`）

同 §1 的来源与许可（移植自 `Azgaar/Fantasy-Map-Generator @ 67d555b8` 的
`src/model/physical/heightmap-generator.ts`；改动见文件头：随机改为显式 `rng`、去掉 DOM/logger、
山脊与海槽合成一份实现）。

## 3. 点阵放置（`src/renderer/src/utils/fmg/lattice.js`）

同 §1 的来源与许可（移植自 `src/model/graph/lattice.ts` 的 square 采样分支）。

---

## 本项目**没有**引入的依赖（写在这里防重复评估）

`alea` / `delaunator` / `simplex-noise` 都是 SP-1025 那边的依赖。司天这边：

- 随机数复用仓内既有的 `utils/voronoiBatch.makeRng`（mulberry32），**不再引 alea**；
- 第一步的点阵用规则方阵 + 8 邻居，**没有引 delaunator**（接 Voronoi 时再评估）；
- 粗糙度用仓内既有的值噪声 `landmassField.fbm`，**没有引 simplex-noise**。

如果将来真引了其中任何一个，必须回到本文件补上对应许可与版本。
