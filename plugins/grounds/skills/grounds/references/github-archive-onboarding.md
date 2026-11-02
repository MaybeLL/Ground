# GitHub 代码交付归档

新闭环使用 `work deliver`，不需要旧 Repository 绑定或 Candidate 保护策略文件。

1. 用户确认 GitHub 远端与标签推送授权；使用本机 Git 的 SSH/HTTPS 凭据，不把 token 写入 task、日志或 skill。
2. `task create` 固定 `--repo-remote` 与基线，或交付时显式提供 `--remote`。实际交付仍要核对正确远端，不能凭目录名称猜测。
3. `work deliver --run ID --session SESSION --repo PATH --commit FULL_COMMIT --json` 推送 `refs/tags/grounds/deliveries/<delivery-id>`，随后读回 commit；推送失败、标签冲突或不可读时不算交付。
4. 有 GitHub ruleset 时保证授权身份能创建归档标签。额外的更新/删除保护是运维选择，不是新闭环的强制前提；本 CLI 不自动管理 ruleset，也不承诺管理员无法删除对象。
5. 标签被移动/删除时如实报告完整性问题，不能 force push 来伪造连续历史。中断重试使用原操作 ID、远端与确切 commit。

归档标签 push 不等于推送业务分支或合并 PR。独立验收、合并、部署分别按授权执行。
