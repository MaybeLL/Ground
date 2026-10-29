<a id="review-conversation-protocol"></a>

# 审阅对话协议

回答单个不可变 Candidate 的自然语言问题时使用。确定性的 `patchledger.review-trace/v3` 投影是已记录事实的来源；回答是只读呈现，不回写 Grounds。

<a id="keep-intelligence-above-the-cli"></a>

## 将理解能力留在 CLI 之上

用户自然语言问题是 Skill 的对话接口。CLI 只接受确定筛选：Candidate、位置、old/new side、是否包含有界 diff。不把问题传给 `review ask`，不编造 topic/focus 枚举，也不以关键词匹配替代对完整请求的理解。

查询前理解否定句、明确点名的结论和混合意图。一个问题可以同时询问理由、意图、Evidence、Verification；取得范围匹配的 Review 摘要，再读回答各部分所需正文。语言理解可以决定查什么，不能创造事实或因果关系。

<a id="resolve-one-trace"></a>

## 定位一份 trace

只将用户问题的范围转换为 Review 查询：

- review worktree 中省略 Candidate ID，由 sidecar 识别。
- 其他位置使用用户明确给出的 ID，或代码历史 `trace` 返回的 Candidate/位置。保留 trace 的 origin、范围、局限和 delivery-link 状态；`unrecorded` 即便代码相同也只是线索。不猜 ID，不以当前行号替代历史位置。
- `PATH:LINE` 使用 `--at PATH:LINE`；新增/当前代码默认 `new`，删除/修改前代码用 `--side old`。
- 只有文件无行号，用 `--at PATH`，说明回答范围是文件。
- 没有代码位置时查询整个 Candidate，不假装全局说明是行级理由。
- 只有用户明确要求代码分析，或记录不足而明确标注的 Agent 推断能实质帮助时，才加 `--include-diff`。

使用 `review --summary --json`，要求 `patchledger.result.review-summary/v1`、`patchledger.review-summary/v1`、`verification_set.reports_included: false`。遵循[固定 Verification 集合协议](verification-set.md)，使用 `verification list --candidate ID --paged --json` 和 `verification show ID --json`。统计、目录完成、正文完成分别判断；引用发现前读相关正文，总结全部发现前读全部正文。不以最新 Verification 或当前 Issue 替代历史证据。

review worktree 的自动 `review --at` 返回 `WORKTREE_MISMATCH`，表示文件偏离物化 Candidate。不用旧 trace 解释当前行；可显式指定 Candidate 讨论不可变快照，或先检查漂移再恢复自动位置查询。保留本地变化。

<a id="follow-the-causal-chain"></a>

## 沿因果链读取

位置问题从 `trace.location` 开始：

1. 使用理由前先看 `line_status`。只有 `added`/`deleted` 是准确变更行；`context`、`outside_hunks`、`unavailable` 无行级理由。文件范围请求须说明返回 Change Units/理由是文件级。
2. 读取准确匹配位置的 `change_units` 和 `rationales`。
3. 将每个理由的 `target_refs[].id` 解析到 `trace.contract.issue.goals` 或 `constraints` 中完整 Criterion。
4. 从所属 Goal/Constraint，将各 `traces_to` 解析到准确绑定的 `trace.contract.requirement`；`outcome`/`decision` 序号是该 Requirement Version 的 1-based 位置。此连接应标为派生关系。
5. 在 `trace.submission.claims` 定位同一 Criterion，读取作者合规说明和 Evidence。
6. 在每份 `trace.verification_set.verifications[].report.assessments` 定位，保留验证者最终结论、说明、Evidence、Attribution 和分歧。
7. 使用准确历史 `trace.contract.requirement` 和 `trace.contract.issue`，不使用当前 revisions。

`rationale_coverage.status: complete` 只表示结构覆盖：匹配 Change Unit 都有理由绑定，不证明文本解释了用户指出的具体构造。作者只有泛化理由时，说明此边界并将更具体动机标未知。理由质量分数或指导结果属于离线评测或当前 Skill 对话，不属于 Review Trace v3。它们是评测观察，不是账本事实，也不证明作者声明为真。

Candidate 全局问题使用全部理由/Criteria，但保留分组。不因同属一个 Candidate 就制造无关 Change Units 的关系。

<a id="answer-the-question-actually-asked"></a>

## 回答用户实际提出的问题

| 用户意图 | 主要记录字段 |
|---|---|
| 为什么存在这段代码？ | 位置理由、relation、Criterion、作者 Attribution |
| 为什么选此方案？ | 理由与否决方案 |
| 有何风险？ | 理由中的风险，再看相关验证发现 |
| 服务哪个需求？ | Criterion、所属 Goal/Constraint、Intent Links、绑定 Requirement Version 的准确 Outcome/Decision |
| 什么支持声明？ | Criterion claim Evidence，区分观察证据与作者说明 |
| 是否验证？ | 全部相关 Verification、归属、逐 Criterion 最终结论，含争议和 inconclusive |
| 改了什么？ | 匹配 Change Unit/Artifact 事实；只有请求或标注推断需要时才看 diff |

混合问题从同一 trace 回答每项意图，不选一个主题丢掉其他部分。否定句或点名结论先直接回答该措辞，再保留展示冲突/standing 所需其他相关结论。出现 `rejected` 不等于用户要求重排、过滤或丢弃发现。

直接回答保持否定问题的极性。例如用户问“这不是被拒绝了吗？”，且确有 rejected，应回答“是，有一位验证者拒绝了它”，不只给含糊“是”或关键词摘要。点名 Criterion 结论不是 Candidate standing；先解释所问发现，再单独报告完整集合和派生 standing。

存在 `traces_to` 时，按类型和 1-based 序号连接绑定 Requirement Version，回答准确 Outcome/Decision。序号离开该版本无意义，也不是独立实体 ID。所属 Goal/Constraint 无匹配 Intent Link 时，准确关系为 `unknown`，不凭措辞相似推断。

<a id="preserve-provenance-in-the-answer"></a>

## 保留回答来源

先直接回答，再给必要的最短因果链。使用用户语言标注：

- **账本事实**：不可变 Candidate、Artifact、Baseline、历史契约、Attribution 或时间戳。
- **作者声明**：提交说明、Change Rationale、备选方案、风险、合规声明或作者提供 Evidence。
- **验证者发现**：独立 Verification 的观察或判断。
- **派生关系**：按记录计算的位置匹配、Change Unit、有效引用连接、覆盖或 standing。
- **Agent 推断**：未记录为作者意图的源码/diff 分析，另段呈现并说明可能错误。
- **未知**：缺失、未记录、未匹配、不完整或无法可靠回答的信息。

理由表述为“作者记录了……”，不说“原因就是……”。Verification 不将作者动机变成客观事实。

以下情况明确说明：

- `location.match: none`：路径不属 Candidate，不给位置级解释。
- `line_status: context`：只是 hunk 内未变上下文，不附着 hunk 理由。
- 请求行号但 `location.match: file` 且 `line_is_outside_changed_ranges`：文件变了，该行未变，不给行级理由。
- `line_status: unavailable`：只有文件级 Change Unit，行变更未知，不称该行已变。
- `rationale_coverage.status: not_recorded`：历史 Candidate 无代码级理由，不用全局提交说明替代。
- 无匹配 `traces_to`：准确 Outcome/Decision 未知，Issue-to-Requirement 绑定本身不足以确定细粒度关系。
- 点名备选方案不在 `rationales[].alternatives`：未记录，说明后只列实际记录方案。
- old-side 删除行理由解释删除，不证明原代码最初为何存在；无其他记录则历史动机未知。
- 无相关 Verification：说“未记录独立 Verification”，不说“已验证”或“未验证失败”。
- 冲突报告或 disputed standing：展示相关结论，不压成最新一份。
- 无作者 Evidence：区分“未记录证据”与“声明为假”。

记录完全回答问题时不加 Agent 推断。用户明确要求分析时，先给记录答案，再单独给推断。
