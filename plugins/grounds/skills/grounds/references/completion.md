# 登记完成与历史补录

完成是精确 Issue Version 的外部交付事实，不是 Selection、代码匹配或独立 Verification。用户明确要求登记时沿用其授权；仅查询进度不能自动登记。先读 `issue show ID --version N` 和 `completion show --issue ID --issue-version N`，核对仓库、目标分支、完成版本与真实依据。

通过共享 helper 调用以下公开入口（帮助可用 `completion --help`）：

```text
completion record --issue ID --issue-version N --expected-version V --file completion.json
completion show --issue ID --issue-version N
completion reopen --issue ID --issue-version N --expected-version V --reason 原因
issue list --status completed
issue list --status incomplete
```

首次 expected-version 为0；后续使用 completion.version，不是 Issue/Selection 版本。已完成记录需先 reopen 再更正，旧事实与操作者保留。重试复用同一操作身份；冲突先回读，不能覆盖他人记录。查询不写入，也不执行合并、推送、npm 发布或部署。

JSON 输入格式 `grounds.issue-completion-input/v1`，字段为：

- `origin`：正常流程为 `workflow`，流程外历史补录为 `historical`。
- `repository_id`：Issue 的 Repository；`target_branch`：完整 `refs/heads/...`，有封存目标时必须一致；`landed_commit`：完整带算法 OID，如 `sha1:` 后40位。
- `adoption_evidence`：`reference` 和 `description`，记录合入/采用依据。
- `release`：已发行时为 `{status:"released",version:"0.20.18",channel:"latest",evidence:{reference:"实际引用",description:"确认依据"}}`；无需发行时为 `{status:"not_applicable",reason:"具体原因"}`。仍待发行不能登记完成。
- `completed_at`：实际完成时间，UTC ISO（含毫秒），不得在未来。
- 可选 `candidate_id`：必须属于同一精确 Issue Version；没有则省略，不能伪造 DevRun/Candidate/Verification。

记录人的身份由 helper 注入。所有输入依据均标为 `asserted_not_checked`：这是用户确认后由记录人提交的外部事实，CLI 不访问链接，也不把用户贴来的工具日志变成自身核验结果。要说明另行进行过的工具检查，引用真实证据并准确叙述检查者/时点；本入口仍不授予工具核验认证。

`board.status=completed` 时 `next_action=null`，不再建议准备交付或开工。仍可读取 Selection 和真实 Verification；unverified/rejected/inconclusive 不因完成变成 qualified。查看关联 Candidate 的当前验证可用 completion show；无候选时不制造验证结论。重新打开后恢复真实 Selection/Candidate/DevRun 派生状态。

新 Issue Version 不继承旧完成；历史版本通过精确 version 回读。Requirement 的 `completion_status` 只汇总其所选版本关联的最新 Issue Versions，非空且全部完成才为 completed；任一未完成为 incomplete；无匹配 Issue 为 no_issues。completed_issue_count 不与全部历史 Candidate/DevRun 计数混算。

旧账本需显式迁移到 schema23；完成表初始为空，不推断旧 selected 已完成。升级、迁移和业务补录分别处理，不能把开发或登记授权扩大为真实数据库迁移授权。
