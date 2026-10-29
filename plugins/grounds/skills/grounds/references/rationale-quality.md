<a id="rationale-quality-coaching"></a>

# 理由质量指导

本参考定义 `grounds` 的建议性质量检查，在 Candidate 提交前改善作者说明，不向 CandidateSubmission、Review Trace 或账本增加字段。

<a id="boundary"></a>

## 边界

检查是 Skill 内部对话。CLI 仅负责确定事实和结构校验：

- 每个 Change Unit 有覆盖；
- 每个 `change_ref` 与 Criterion 引用有效；
- Artifact/Change Index 未漂移；
- 没有生成的 `TODO:` 占位。

Skill 不将语义分数变为提交门禁，不把问题传给 CLI，不持久化质量结果。符合 rubric 的理由仍是作者声明；高分不将动机变成客观事实。

<a id="four-dimensions"></a>

## 四个维度

每个 Change Rationale 各维度评分 0–2，仅供建议，不进入 Candidate JSON。

| 维度 | 0 | 1 | 2 |
| --- | --- | --- | --- |
| 具体性 | 泛化或重述 Criterion，缺具体行为/机制。 | 提及行为/机制，但构造、范围或因果步骤部分不明。 | 指出准确变化行为/机制，解释 Change Unit 做了什么。 |
| 因果关联 | 未说明如何服务关联 Criterion。 | 关联可能成立，但主要重述 Criterion 或遗漏重要因果步骤。 | 解释此 Change Unit 到 Criterion 的具体路径，区分局部/全局范围。 |
| 决策信息 | 无真实备选方案、取舍、风险或不确定性。 | 记录其中一项，但泛化、模糊或与变化无关。 | 记录有意义的否决方案或确认不存在方案，以及不明显风险或明确未知。 |
| 来源诚实 | 将未记录动机、方案或验证作为事实。 | 声明有保留，但来源或未知边界不明。 | 说明作者知道并记录了什么、未知什么、哪些须作者确认。 |

建议质量线为 **7/8 或以上**，且具体性、来源诚实都大于零。该线提示改善文案，不是硬门禁。

<a id="coaching-procedure"></a>

## 指导步骤

原生 Candidate 草稿生成后、提交前进行：

1. 阅读准确 Change Unit 范围、`relation`、关联 Criterion 和相关 Goal/Constraint。不用邻近 hunk 或全局说明评分。
2. 检查四个问题是否分别回答：具体行为改了什么、如何服务 Criterion、为何选此机制/取舍、还有什么风险/未知。
3. 总分低于 7/8，或具体性/来源诚实为零时，只问作者一个针对缺失维度的问题，例如“没有此 hunk 会错在哪里？”“选择了什么机制，为什么？”“是否考虑可行替代？”“什么仍可能失败？”
4. 作者修订并确认。Skill 可改善清晰度和组织，但不从源码、commit 文案相似性或 Criterion 推断缺失动机。
5. 理由限定在 Change Unit。一个 hunk 有多个原因时，只有作者确认才解释共同原因，否则保留各自未知，不合并。
6. `generated`/`incidental` 是真实关系，不是逃避方式；仍需简短解释和现有契约要求的有效 Criterion 引用。
7. 修订后重评分，再正常结构检查/提交。不把分数、指导问题、审阅者回答或推断动机加入 submission JSON。

作者不能提供具体动机时，提交满足结构契约的最准确记录说明，告知下游 Review 更具体动机为 `unknown`。备选方案/风险空数组只有作者确认未考虑或未识别时才真实，否则记录相关条目。
