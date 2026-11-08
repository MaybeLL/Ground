# 开发与冻结交付

取得实现授权，确认仓库、任务修订和归档远端。使用调用方自己的 agent，不要求安装模型 SDK 或 Python runner。

```bash
grounds work start --task "$TASK_ID" --revision-id "$REVISION_ID" --mode external --json
grounds work workspace --run "$RUN_ID" --repo "$CLONE" --json
grounds work register --run "$RUN_ID" --agent "$AGENT_ID" --json
```

`work start` 返回 `workId/runId`；`workspace` 返回独立 `path/branch/base`；`register` 返回 worker `sessionId`。只在返回的目录开发。恢复时先 `work run` / `work show`，复用已登记的运行与会话，不无故重建。

真实执行相关测试并保存输出与退出码。不能把命令未执行、超时或基础设施失败写成通过。提交代码前检查未跟踪文件、用户改动与凭据；只提交获准范围。Git commit 和归档标签 push 都必须在授权内。

```bash
grounds work deliver --run "$RUN_ID" --session "$WORKER_SESSION" \
  --repo "$WORKTREE" --commit "$FULL_COMMIT" --remote "$REMOTE" --declare-stop --json
```

`REMOTE` 必须是本轮实际使用、在其他目录仍可访问的完整远端 URL 或绝对路径，不传仅在当前仓库有效的 `origin` 别名或相对路径。显式 `--remote` 可以覆盖 Task 的默认远端，因此把该参数原值与交付回执一起保存；恢复时缺少这个值应停止并索取原调用记录，不能回退猜测 Task 的远端。

提交中断或显示 `receipt-unavailable` 时，先运行 `grounds work reconcile --run "$RUN_ID"`。Grounds 按已登记的候选提交和附件重新核对回执。若提示发布尚未确认，使用首次交付的操作 ID、提交、远端和附件重试 `work deliver`。

`--declare-stop` 只在工作者实际结束本轮后使用，且仅代表外部停止声明。命令推送不可覆盖的标签并读回确切 commit；失败不能当作交付。检查 `submitted.status/outcome`，再读回 `work run` 的冻结 manifest；迟到提交只可能被记录，不能替换原交付。保存实际 `REMOTE`、返回的完整 `delivery.commit`、`delivery.id/receipt` 和操作 ID。归档的公开标签 ref 是 `refs/tags/grounds/deliveries/<delivery.id>`；将这些固定值用于[独立检出步骤](verify.md)，无需解码 receipt 或读取实现源码。中断后重试须固定原 commit，不再使用可能已变化的 HEAD。

保存 Codex 或 Claude Code JSONL 原文及统一事件时，用 `work import-trace --run ID --session SESSION --provider codex|claude-code --file FILE --digest SHA256`，核对返回的摘要、记录数和转换覆盖。已有持久引用而无本地原文时，显式 `work transcript --run ID --session SESSION --ref REF --digest DIGEST --coverage full|partial|unknown`，只提供真实持久引用与实际摘要，不虚报覆盖率。

## 精化与分支

只有已结束的运行可被精化。修复当前方案：

```bash
grounds work continue --work "$WORK_ID" --expected-head "$OLD_RUN" --mode external --json
grounds work workspace --run "$NEW_RUN" --repo "$CLONE" --json
```

新 worktree 从旧交付的归档 commit 创建，不复用原工作者目录；随后登记新 worker session。默认采用任务最新修订，若不符合本轮意图须显式 `--revision-id`。工作头 CAS 冲突先重读，不绕过。

平行方案使用 `work branch --work ID --refines RUN --mode external`；它不会自动选择工作头。单轮停止用 `work stop --run ID --session SESSION --reason human|abandoned`，取消用 `work cancel --run ID --reason TEXT`；不要把取消请求等同于进程已被终止。无 agent、由人提供代码时可以 `--mode none`，不能冒充已登记的外部工作者。

提交后按已获授权选择[独立验收](verify.md)或报告待验收，不自报 accepted。
