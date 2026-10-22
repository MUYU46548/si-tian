# 事件账本（三刀序列·第一刀）—— 设计与用法

> 2026-10-22。对应施工单 `02-司天-三刀序列.md` 任务一（账本引擎）。
> 本文回答：**数据长什么样、什么语义、怎么问、怎么录、判据在哪、哪些没做**。

## 一、它是什么（以及与既有两层账本的分工）

司天里已有两本「账」，本刀加的是第三本，**三本各管一件事、互不双写**：

| 账本 | 数据位置 | 回答的问题 | 实现 |
|---|---|---|---|
| 省份归属（v1 形） | `scenario.ownership` | 这块地**现在**归谁（本代终态快照） | 缓存 |
| 省份归属（v2 形） | `scenario.initialOwnership` + `scenario.changeEvents` | 某天这块地归谁（可回放） | `utils/scenarioLedgerV2.js` / `utils/scenarioTimeline.js#buildLedger` |
| **事件 / 外交** | `scenario.timelineEvents: [event…]` | **谁和谁、什么事、从哪年到哪年、某天什么关系** | `utils/scenarioEventLedger.js` |

为什么事件不塞进 `changeEvents`：后者的键是省份、值是「归谁」；外交事件的主体是**势力对**。
混在一张表里，回放归属要把非归属事件全部过滤，两边的校验也会互相污染。

## 二、数据形状（落盘值）

```json
{
  "id": "ev3",
  "type": "war",
  "actors": ["pol_jin", "pol_yan_state"],
  "from": { "y": 330, "m": 3, "d": 1 },
  "to":   { "y": 336, "m": 11, "d": 15 },
  "title": "玄澜战争",
  "note": "",
  "data": {}
}
```

- `actors` **有序**：`vassalage`（臣属）与 `independence`（独立）用方向，`actors[0]` = 宗主 / 原主。
- `from` 必填（只录到年也行：`m`/`d` 为 `null` = 该年 1 月 1 日，与全仓日期口径一致）。
- `to` 为空 = 至今。**一次性事件**（和约/独立/记事）忽略 `to`。
- `id` 由 `makeEventId` 按 `ev1/ev2…` 递增分配（确定性，重载后稳定，便于 diff）。

### 事件类型表（`EVENT_TYPES`，唯一出处）

| type | 中文 | 对关系的作用 | 有方向 | 有窗口 |
|---|---|---|---|---|
| `war` | 战争 | `Enemy` 敌对 | 否 | 是 |
| `alliance` | 同盟 | `Ally` 同盟 | 否 | 是 |
| `friendship` | 友好 | `Friendly` 友好 | 否 | 是 |
| `rivalry` | 宿敌 | `Rival` 竞争 | 否 | 是 |
| `vassalage` | 臣属 | `Suzerain` / `Vassal` | **是**（A 为 B 的宗主） | 是 |
| `independence` | 独立 | 归中立（结束臣属） | 是 | 否 |
| `peace` | 和约 | 归中立（结束敌对） | 否 | 否 |
| `custom` | 记事 | 不改关系 | 否 | 是（可空） |

关系词表用 Azgaar 的英文原语（`Neutral/Ally/Friendly/Suspicious/Enemy/Rival/Vassal/Suzerain`），
中文只在 `RELATION_LABELS` 里出现一次 —— 界面、命令行、导出都从这里取，避免两套词。

## 三、时间语义（改之前先读）

1. 事件在 **`[from, to)`** 内生效 —— **终止当日不再生效**。
   「1348-06-01 开战、1352-06-01 停战」→ 停战当天已经不是敌对；同日录一条 `peace` 自然接上。
2. 同一对势力、同一天有多条事件时：**账本里靠后的那条生效**
   （排序按 `from` 稳定排序，同日保持录入顺序）。录入顺序 = 人的意图顺序，重载后不变。
3. 查询是**无状态**的：只看「哪些事件在这一刻生效」，取最后一条。
   战争到期后自动回落到更早的、仍在有效期内的关系（如更早的同盟），没有就中立。
4. 关系是**两两状态**（对称事件两个方向都一样；臣属两个方向分别是宗主/藩属）。

## 四、怎么问（验收用的那句话）

### 命令行（不需要开司天，读项目文件即可）

```bash
# 清点：每代多少事件、体检结果
node scripts/ledger-query.mjs --project <file.sitian> --list

# 问一句：「1350 年，瓯 与 梁 什么关系？」
node scripts/ledger-query.mjs --project <file.sitian> --at 1350 --a 瓯 --b 梁

# 不给双方 → 该时点所有非中立关系 + 仍在生效的事件
node scripts/ledger-query.mjs --project <file.sitian> --at 1350
```

输出例（真实项目副本，事件为演示数据）：

```
剧本：诸侯割据（298 ~ 510）
问：333 时，玄方 与 澜方 什么关系？
答：333 时，玄方 与 澜方：敌对（战争「玄澜战争」，330-03-01 ~ 336-11-15）。
```

### 命令录制（同样一条实现，`--apply` 才写盘）

```bash
node scripts/ledger-query.mjs --project <file.sitian> \
  --add '{"type":"war","a":"玄方","b":"澜方","from":"330-03-01","to":"336-11-15","title":"玄澜战争"}' --apply
# PowerShell 会再剥一层引号 → 用文件：--add @事件.json
```

写盘纪律：默认 dry-run；`--apply` 先备份到 `backups/ledger-events-<ts>/`，
临时文件 + rename 落盘，**读回校验**刚写的事件确实在盘上；有硬错误时拒绝写盘。
⚠️ 跑 `--apply` 前先关闭司天（内存态会把改动盖回去）。

### 程序内（store，供以后的外交表/事件面板直接接）

```js
store.addTimelineEvent(scenarioId, { type, actors, from, to, title, note, data })
store.updateTimelineEvent(scenarioId, eventId, patch)
store.removeTimelineEvent(scenarioId, eventId)
store.setTimelineEvents(scenarioId, drafts)      // 整表替换：全有或全无
store.queryRelationAt(scenarioId, a, b, at)      // → { relation, label, since, until, eventId, text }
store.auditTimelineEvents(scenarioId)            // → { errors, warnings }
```

全部走 `execute()`：只读态被拦、一次调用 = 一条 undo、`saveScenarios()` 统一调度落盘。
**删势力会级联删掉它参与的事件**（回报 `affectedEvents`，一条 undo 全还原）。

## 五、体检（`findConflicts`）

- `error`：事件本身不成立 —— 缺年份 / 起止颠倒 / 未知类型 / 参与方缺失或重复 / id 重复。
- `warning`：可疑 —— 势力 id 不在本代势力表里 / 年份越出剧本区间（跨代允许）/ **同日重叠且阵营相反**
  （`war` 对 `alliance` 这类，按「无序对 + 两条事件」去重）/ 两条完全相同的事件 / 起止同一天（空窗口）。

阵营口径：`Ally/Friendly` 为正向、`Enemy/Rival` 为负向；`Vassal/Suzerain` 是支配关系，
**与战争/同盟可以并存**（藩属也会被宗主拉去打仗），不判冲突。

## 六、判据在哪

- 纯函数层：`scripts/tests/unit/test_scenario_event_ledger.js`（10 组，含判别力反例：
  不重叠的相反事件不许误报、终止后不许谎称「没有记录」、非对称方向不能同词）。
- 接线/往返：`scripts/tests/cases/test_132_event_ledger.py`
  （录入 → 查询 → 冲突 → undo/redo → 项目载荷 → 重载 → 删势力级联 → 收尾）。
- 源码闸门（同用例内）：账本只有一份实现、store 只搬数据、loader 只有一份。

## 七、明确没做（留给后面）

- **外交表 / 事件面板 UI**：账本立住后另出（施工单「悬置」一节）。
- 事件与省份的关联（如「某战役导致某省易主」）：现在两本账各自记录，尚无联动；
  真要做，方向是「事件 → 触发 ownership 变更」，**单向派生**，不双写。
- 事件类型扩展（兴衰/灾荒/王朝更替）：在 `EVENT_TYPES` 里加一行即可，查询/冲突逻辑不用动。
- 图片/附件、多语言文案。
