# `src/ledger/` — 剧本归属账本（M1）

> 纯数据层：**不 import** `vue` / `store` / 组件（`scripts/tests/unit/test_ledger_core.js` 的 a6 段读源码守）。
> 判定"某省某天归谁"只有一份实现：`replay.projectOwnership`；`utils/scenarioLedgerV2.deriveFrom` 只是 v2 形状适配器。

## 形状

```
ledger = { ledgerVersion, worldId: 'default', epochId: <剧本 id>, calendar: {yearLength: 360, monthLength: 30},
           events: [ { id, worldId, epochId, day, type, groupId, provenance, payload } ] }
```

- `day` = **该 epoch 内的绝对日**（可负），由 `CalendarConfig` 从 `{y,m,d}` 换算；`calendar` 随项目文件走（换机器不漂）。
- 事件类型：`epoch.baseline`（day 恒 0，**每个 epoch 恰好一条**）/ `province.owner.changed` / `stroke.committed`。
- `groupId` = "一笔/一次操作"的身份，**同一组必须原子地撤/重做**；基线的 `groupId` 为空 —— 结构上就撤不掉。
- `payload.at` = 写口当时给的**月日原形**（`m/d` 可缺省）。只靠 `day` 反推会把"1050 年"变成"1050 年 1 月 1 日"。

## M1 口径：一个剧本 = 一个账本段

真实项目是 13 个独立剧本容器（era 互不重叠），不是一条全局时间轴。
**M1 用 `epochId = 剧本 id`，`worldId` 恒 `default`**；全局统一时间轴留到 M2（只做"段的排序与拼接"，不改事件形状）。

## 真源与缓存（渐进反转，2026-10-24）

`scenario.ledger` 是**真源**；`scenario.ownership` / `changeEvents` / `initialOwnership` 是**投影缓存**，
唯一写者是 `store/geodataModules/scenarioEditing.ownershipCommand()`：

- 账本解释得了缓存（`project(base)` 逐省 == 缓存）→ 编辑后缓存**全部由 `toV2Projection` 现算**；
- 解释不了（改省界/合并/铺底把归属迁移到新省 id 却不写账本；或旧档无日期编辑）→ 退回
  "手算缓存 + 投影对拍上了才入账"。**宁可这一笔不入账，也不写自相矛盾的账**，更不许把缓存里
  那些写口的编辑用投影悄悄盖掉。
- 无日期编辑：不入账（账本按日回放，编不出日期就不写），只写缓存。

## 撤销：两个数据栈，一条操作时序

- **归属类**：一条编辑 = 一个 group。undo = `removeGroup(ledger, groupId)`（整笔摘下），
  redo = `insertGroup` 插回原位；缓存按投影重算。**不碰几何**。
- **几何/河流/道路/剧本元信息**：仍走 `store/undo.js` 的快照闭包。**不碰账本**。
- 两种条目共用 `store/undo.js` 的**一条线性历史**，每条自带 `stack: 'ledger' | 'snapshot'`。
  为什么不是"两个独立栈 + 按最后一次操作分派"：两个栈指针还原不了**交织顺序**
  （几何 A → 归属 B → 几何 C 之后连撤两次，光看"最后一次属哪栈"会退错），单一时序天然正确，
  且历史面板的 `jumpTo` 照旧可用。

## 迁移与核对

- `fromV2Scenario(scenario)`：`initialOwnership` → 一条基线；`changeEvents[i]` → `province.owner.changed`
  （`provenance: import`，合成事件 `migrate` + `payload.synthesized`）
- `verifyMigration` / `scripts/ledger-dryrun.mjs`：**只读**跑一遍回放，与落盘 `ownership` 逐省对拍；
  415 孤本实测 13 段 / 冲突 0 / 11ms。
- `toV2Projection(ledger)`：账本 → v2 缓存（月日取 `payload.at`、合成事件保留、同日收成一条）。

## 键迁移与事件表（2026-10-24 收口）

改省界 / 合并 / 批量铺底 / 删省 / 删势力动的是归属的**键**（省份 id），易主日期面板动的是**事件表**。
两者都必须同时改四处（`ownership` / `initialOwnership` / `changeEvents` / `ledger`），否则
「账本投影 == 缓存」会断，之后这个剧本**再也不进账**（不报错，只是账本停止增长）。唯一实现：

- `remapScenarioOwnership(scenario, {provinceRename, provinceRemove})` —— 改名/删省（无改动返回原引用）
- `forkScenarioProvince(scenario, newId, srcId)` —— 一省拆多省：新省继承归属 + v2 事件 + 账本历史
  （**保留源事件 + 追加副本**，副本换 id —— 第一版写成"改名"，第一次 fork 就把源事件吃了）
- `replaceProvinceEvents(ledger, pid, list)` —— 面板整列表替换该省的显式事件
- `setLedgerBaselineOwner(ledger, pid, owner)` —— 清空显式日期时把基线记成本代当前归属

`ownershipLedgerBase` 另有**自愈**：发现手里账本解释不了缓存时按 v2 事实重建（warn，旧 groupId 失效），
剩余任何没接线的写口最多让账本落后一次，不会永久退化。
