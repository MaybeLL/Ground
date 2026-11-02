# 导出固定任务到 Confluence

先明确目标 Task、修订序号、Confluence 页面和写入授权：

```bash
grounds task show --task "$TASK_ID" --revision "$SEQ" --json
```

只根据返回的固定版本导出标题、上下文、标准 ID/全文以及仓库/基线。标明 Task ID、revision ID、seq 和 digest。无对应修订或正文不可读时停止，不用最新版本补位。

使用宿主已有的 Confluence CLI/工具读取目标页面，再按明确授权创建或更新。保留页面其他内容；不要抹去现有用户修改，不把旧运行的评分或作者声明拼进任务规范。无工具、身份、权限或页面冲突时报告原因。

回读写入后的页面，核对正文与固定任务一致。导出成功不表示验收、实际合入或发布完成。这里没有专用导出脚本、旧 Requirement/Issue 模板或自动页面覆盖逻辑。
