# 读取结果、选择方案与结束工作

先 `work show --work ID --json` 读取实际 head、运行列表与 conclusion；对需要讨论的 run 读取 `work run`、`grade list` 和具体 `grade show`。引用发现前读取判定与证据，不根据数量、时间或标题猜结论。

多个分支之间的选择必须来自用户意图；不能自动选择最近或评分最好的运行：

```bash
grounds work select --work "$WORK_ID" --run "$CHOSEN_RUN" --expected-head "$OBSERVED_HEAD" --json
```

选择只移动工作头，不改交付或评分历史。头变化冲突应重新读取；当前代码、已归档代码和已验收代码分别判断。新 gate 或新任务版本不追溯改写旧结论。

用户确认结束这条工作线后：

```bash
grounds work close --work "$WORK_ID" --json
```

结束过程可能等待运行/评价者停止；外部停止必须如实声明，不能伪造进程已终止。closed 只保存结束时结论，即使 rejected/failed 也可能结束，并非 accepted 的别名。

## 外部 Git 合入

Grounds 交付回执证明标签在归档时指向确切提交，不证明分支已合并、部署或发布。按用户授权使用 Git 与远端平台工具准备 PR；核对目标分支、确切交付 commit、当前 gate 和差异。目标发生变化时明确风险，不能把不同代码算作已通过的交付。

检查 `archiveIntegrity` 的远端引用与记录 commit；`null` 表示本次未能判定。记录 `ref-changed` 或 `unavailable` 时，分别说明是否还能取得原始对象。

配置的 Git 凭据需能推送交付标签并从同一远端读回。
