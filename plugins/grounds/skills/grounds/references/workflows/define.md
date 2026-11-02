# 定义任务

先澄清目标、边界和每一条可独立判断的验收标准。关键业务规则写入任务正文；外链只作证据，不能成为理解需求的唯一入口。尚有会改变实现的歧义时先问用户。发布任务不自动授权开发。

```bash
grounds task create --title "$TITLE" --context "$CONTEXT" \
  --criterion "$CRITERION_1" --criterion "$CRITERION_2" \
  --repo-remote "$REMOTE" --baseline "$BASE_COMMIT" --json
```

`REMOTE` 是用户确认、可归档标签的远端；`BASE_COMMIT` 是本地可解析的确切基线 commit。无代码任务可以省略远端/基线，但 `work workspace` 需要这些信息。核对返回的 `taskId`、`revisionId`、`seq` 和标准 `id`，保存 `operation_id`。

修订时先 `task show` 读回版本；既有标准使用返回的 ID 保持身份：

```bash
grounds task revise --task "$TASK_ID" --expected-seq "$SEQ" \
  --title "$TITLE" --context "$CONTEXT" \
  --criterion "$CRITERION_ID: $REVISED_TEXT" \
  --repo-remote "$REMOTE" --baseline "$BASE_COMMIT" --json
```

修订提交完整的新内容，不是字段 patch；仍需保留的 context、仓库和标准都显式传入。不带 ID 的标准是新增标准；省略的标准不进入新版本。版本冲突先重新读取、由用户意图裁决，不静默覆盖。

```bash
grounds task show --task "$TASK_ID" --revision "$SEQ" --json
```

展示固定版本全文，取得需求确认再开始实现。旧运行仍绑定原版本；创建 refinement 时若要保留特定版本，显式指定 `--revision-id`。暂不使用旧 JSON/Markdown draft、Requirement/Issue 或 HTML 发布流程。
