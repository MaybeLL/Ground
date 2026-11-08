# 开发与冻结交付

取得实现授权，确认仓库、任务修订和归档远端。使用调用方自己的 agent，不要求安装模型 SDK 或 Python runner。

```bash
grounds work start --task "$TASK_ID" --revision-id "$REVISION_ID" --mode external --json
grounds work workspace --run "$RUN_ID" --repo "$CLONE" --json
grounds work register --run "$RUN_ID" --agent "$AGENT_ID" --json
```

`work start` 返回 `workId/runId`；`workspace` 返回独立 `path/branch/base`；`register` 返回 worker `sessionId`。只在返回的目录开发。恢复时先 `work run` / `work show`，复用已登记的运行与会话，不无故重建。

仓库用 Dockerfile 定义开发环境时，可以运行 `grounds work build-environment --name NAME --repo PATH --commit FULL_OID`。默认读取该提交中的 `.devcontainer/devcontainer.json`，可用 `--devcontainer` 指定仓库内其他路径。把返回的环境定义绑定到任务，并用修订 ID 固定本轮环境。若构建中断，请用同一操作 ID 和相同输入重试。

多服务环境在同一提交的 devcontainer 配置中填写 `dockerComposeFile` 和执行服务 `service`。宿主需要 Docker Compose。Grounds 将任务目录挂到执行服务的 `workspaceFolder`；依赖可使用项目私有命名卷。保留沙箱时只暂停执行服务，释放沙箱会清理这一项目的容器、网络和数据卷。


外部 Agent 需要任务运行环境时，先运行 `work prepare-sandbox --run RUN --repo PATH`，再用已登记的会话运行 `work sandbox-context --run RUN --session SESSION --json`。返回的 `workspace` 是容器实际挂载的宿主目录。将命令和参数逐项追加到 `argvPrefix` 并直接执行。例如在同一 Docker context 下读取 JSON 结果后运行 `subprocess.run(result["argvPrefix"] + ["npm", "test"], check=True)`。宿主使用该目录里的文件完成交付；代码提交在宿主的 Git 工作树中执行。

单独执行一次任务可用 `grounds work start-run --task "$TASK_ID" --mode external`。用返回的 `runId` 登记会话、交付和查询。要从同一任务已结束的独立尝试继续，在 `start-run` 加 `--refines "$RUN_ID"`；托管模式可用 `--sandbox inherit` 接手原沙箱，或用 `--retention release` 在本轮结束时释放沙箱。

真实执行相关测试并保存输出与退出码。不能把命令未执行、超时或基础设施失败写成通过。提交代码前检查未跟踪文件、用户改动与凭据；只提交获准范围。Git commit 和归档标签 push 都必须在授权内。

```bash
grounds work deliver --run "$RUN_ID" --session "$WORKER_SESSION" \
  --repo "$WORKTREE" --commit "$FULL_COMMIT" --remote "$REMOTE" --declare-stop --json
```

`REMOTE` 必须是本轮实际使用、在其他目录仍可访问的完整远端 URL 或绝对路径，不传仅在当前仓库有效的 `origin` 别名或相对路径。显式 `--remote` 可以覆盖 Task 的默认远端，因此把该参数原值与交付回执一起保存；恢复时缺少这个值应停止并索取原调用记录，不能回退猜测 Task 的远端。

提交中断或显示 `receipt-unavailable` 时，先运行 `grounds work reconcile --run "$RUN_ID"`。Grounds 按已登记的候选提交和附件重新核对回执。若提示发布尚未确认，使用首次交付的操作 ID、提交、远端和附件重试 `work deliver`。

`--declare-stop` 只在工作者实际结束本轮后使用，且仅代表外部停止声明。命令推送不可覆盖的标签并读回确切 commit；失败不能当作交付。检查 `submitted.status/outcome`，再读回 `work run` 的冻结 manifest；迟到提交只可能被记录，不能替换原交付。保存实际 `REMOTE`、返回的完整 `delivery.commit`、`delivery.id/receipt` 和操作 ID。归档的公开标签 ref 是 `refs/tags/grounds/deliveries/<delivery.id>`；将这些固定值用于[独立检出步骤](verify.md)，无需解码 receipt 或读取实现源码。中断后重试须固定原 commit，不再使用可能已变化的 HEAD。

保存 Codex 或 Claude Code JSONL 原文及统一事件时，用 `work import-trace --run ID --session SESSION --provider codex|claude-code --file FILE --digest SHA256`，核对返回的摘要、记录数和转换覆盖。通用会话文件用 `work transcript --run ID --session SESSION --file FILE --digest DIGEST --coverage full|partial|unknown` 保存原文。通过 `work trace --run ID --digest DIGEST --stream raw --chunk 0` 取回。验收请求只自动绑定已核验的归档字节。已有持久引用而无本地原文时，显式 `work transcript --run ID --session SESSION --ref REF --digest DIGEST --coverage full|partial|unknown`，只提供真实持久引用与实际摘要，不虚报覆盖率。

## 精化与分支

只有已结束的运行可被精化。修复当前方案：

```bash
grounds work continue --work "$WORK_ID" --expected-head "$OLD_RUN" --mode external --json
grounds work workspace --run "$NEW_RUN" --repo "$CLONE" --json
```

新 worktree 从旧交付的归档 commit 创建，不复用原工作者目录；随后登记新 worker session。默认采用任务最新修订，若不符合本轮意图须显式 `--revision-id`。工作头 CAS 冲突先重读，不绕过。

平行方案使用 `work branch --work ID --refines RUN --mode external`；它不会自动选择工作头。单轮停止用 `work stop --run ID --session SESSION --reason human|abandoned`，取消用 `work cancel --run ID --reason TEXT`；不要把取消请求等同于进程已被终止。无 agent、由人提供代码时可以 `--mode none`，不能冒充已登记的外部工作者。

提交后按已获授权选择[独立验收](verify.md)或报告待验收，不自报 accepted。
