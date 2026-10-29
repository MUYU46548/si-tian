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

## 4. `delaunator`（B⑤，2026-10-29 引入，运行时依赖）

```
ISC License

Copyright (c) 2016, Mapbox

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

用途：抖动点阵的 **Delaunay 三角化**（边集 = Voronoi 邻接），替换第一步的 8 邻居
（`utils/fmg/lattice.js#buildVoronoiAdjacency`）。版本见 `package.json`。

---

## 本项目**没有**引入的依赖（写在这里防重复评估）

`alea` / `simplex-noise` 是 SP-1025 那边的依赖，司天这边**没有**引入：

- 随机数复用仓内既有的 `utils/voronoiBatch.makeRng`（mulberry32），**不再引 alea**；
- 粗糙度用仓内既有的值噪声 `landmassField.fbm`，**没有引 simplex-noise**。

（`delaunator` 已在 §4 正式引入。如果将来真引了其它任何一个，必须回到本文件补对应许可与版本。）
