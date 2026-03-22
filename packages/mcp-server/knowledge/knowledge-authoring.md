# Knowledge Authoring（STS2 MCP）

## 目标

- 静态知识继续作为 MCP 可查询内容存在。
- AI 可以增量写知识，但必须先记录 observation，再决定是否提升为 canonical knowledge。
- 不要求一开始就有全量原始数据；要求结构稳定、证据可追溯、未知项显式保留。

## 工作流

### 第一步：先查模板

- 用 `sts2_get_knowledge(topic="knowledge-authoring")` 读取本规范。
- 用 `sts2_get_knowledge_topics`、`sts2_list_knowledge_sections` 找到目标 domain 和目标 section。

### 第二步：先记 observation

- 用 `sts2_record_observation` 记录一条原始观察。
- observation 允许不完整，但必须带 `source_type`、`confidence` 和尽可能具体的来源。
- 推荐 `source_type`：
- `observed`：来自 MCP 实时状态、战斗画面、事件选项、桥接日志。
- `journaled`：来自 run journal 或人工复盘记录。
- `inferred`：基于多条观察的保守推断。
- `external`：来自外部攻略或社区资料。

### 第三步：再读 observation 汇总

- 用 `sts2_list_observation_entities` 查有哪些实体已经有记录。
- 用 `sts2_read_observation_entity` 读某个实体的 observation log。
- 在 evidence 不足时，不要把结论直接写进 canonical knowledge。

### 第四步：最后才提升到 canonical knowledge

- 只有当一条结论至少被当前 observation 支撑到 `medium` 以上置信度时，才考虑进入 canonical knowledge。
- canonical knowledge 应优先写“可决策内容”，而不是追求字段全量。
- 不确定的项目留在 `Unknowns`，不要补空想字段。

## 全局规则

### 必须区分四类信息

- `Snapshot`：当前已知的简要事实。
- `Decision`：对上层最有用的拿牌、路线、作战或选项建议。
- `Evidence`：这条内容基于什么来源。
- `Unknowns`：还不知道什么，或者哪些地方只有弱证据。

### 不要把推断写成事实

- 来自一次观测的结论，默认只够写 `Snapshot` 或 `Evidence`。
- 来自多次重复验证的结论，才能写进 `Decision`。
- 外部攻略和实战观察冲突时，优先保留冲突说明，不要强行选边。

### Heading 必须稳定

- domain 顶层 heading 固定。
- 实体二级 heading 固定为 `## Card: <Name>` / `## Relic: <Name>` / `## Event: <Name>` / `## Enemy: <Name>`。
- 同类小节名称固定，不要一会儿写“适用情况”，一会儿写“什么时候拿”。

## Domain 模板

## Cards

### Heading Skeleton

```md
## Card: <Name>

### Snapshot
### Decision
### Synergies
### Anti-Synergies
### Evidence
### Unknowns
```

### Required Intent

- `Snapshot` 写当前可确认的定位，例如 role、cost、speed、target。
- `Decision` 写 `pick_when / skip_when / upgrade_priority`。
- `Synergies` 和 `Anti-Synergies` 写构筑联动，而不是只复述卡面。
- `Evidence` 写来源和置信度。
- `Unknowns` 保留升级差值、未验证交互、条件触发等未证实信息。

## Relics

### Heading Skeleton

```md
## Relic: <Name>

### Snapshot
### Decision
### Synergies
### Risks
### Evidence
### Unknowns
```

### Required Intent

- `Snapshot` 写遗物属于 tempo、economy、cycle、scaling 哪一类。
- `Decision` 写 `strong_when / weaker_when / route_impact / shop_impact`。
- `Synergies` 优先写路线、能量、抽牌、删牌、爆发窗口联动。
- `Risks` 写容易被高估的场景。

## Events

### Heading Skeleton

```md
## Event: <Name>

### Snapshot
### Decision
### Options
### Outcomes
### Risks
### Evidence
### Unknowns
```

### Required Intent

- `Snapshot` 写事件大类，例如 tradeoff、gamble、transform、divination。
- `Decision` 写 `choose_when / avoid_when`。
- `Options` 写每个可见选项的规则和适用条件。
- `Outcomes` 只写已知结果池，不要脑补完整概率表。
- `Unknowns` 保留未知奖池、隐藏惩罚、触发条件。

## Enemies

### Heading Skeleton

```md
## Enemy: <Name>

### Snapshot
### Decision
### Patterns
### Counters
### Risks
### Evidence
### Unknowns
```

### Required Intent

- `Snapshot` 写普通怪 / 精英 / Boss、threat model、危险窗口。
- `Decision` 写 `priority / answer_types / danger_window`。
- `Patterns` 写已知 intent、阶段、成长方式。
- `Counters` 写真正有效的解法类型，而不是泛泛而谈。
- `Unknowns` 保留完整 move cycle、隐藏机制、未证实阶段条件。

## Observation 模板

### Observation Entry Minimum

每条 observation 至少要回答：

1. 我看到了什么。
2. 我是通过什么工具或来源看到的。
3. 我有多确定。
4. 它支持的是哪一类结论。

### Observation Example

```md
## 2026-03-20T10:00:00Z | observed | medium

- source_tool: sts2_get_state
- state_version: 123456
- note: Card 葬送 当前显示为 1 energy, 3 star, single target, effect 30 damage.
- implication: supports Card: 葬送 > Snapshot
```

## Promotion 规则

- 单条 `observed` + `medium`：
  只够写 `Snapshot`
- 多条重复 `observed` + 一致：
  可以进入 `Decision`
- `inferred`：
  默认只进 `Risks` 或 `Unknowns` 附近，不直接当结论
- `external`：
  进入 `Evidence`，除非被本地 observation 复核

## 反模式

- 直接让 AI 凭印象补完整字段。
- 把 observation、推断、攻略摘录混成一个段落。
- 不保留 `Unknowns`，强行写满模板。
- heading 名称漂移，导致 `search/slice` 难以稳定命中。
