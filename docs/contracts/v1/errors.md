<a id="grounds-v1-error-registry"></a>

# Grounds v1 错误登记表

所有错误都符合 [`error.schema.json`](error.schema.json)。`message` 面向人且可变化；Agent 只分支 `code`、`retryable` 和下表列出的稳定 `details`。

| 错误码 | 退出码 | 可重试 | 稳定详情/处理动作 |
|---|---:|---:|---|
| `VALIDATION_ERROR` | 2 | 否 | 可选 `field`, `reason`；修正输入并使用新 operation ID |
| `NOT_FOUND` | 3 | 否 | 任务、运行或评分记录不存在。检查调用者提供的标识。 |
| `STATE_CONFLICT` | 4 | 否 | 状态或工作头已变化，重新读取当前记录。 |
| `AUTH_FAILED` | 4 | 否 | 提交者无权在当前工作者或评价者会话执行该操作。 |
| `VERSION_CONFLICT` | 4 | 否 | 记录版本已变化，读取当前版本再决定是否执行。 |
| `IDEMPOTENCY_CONFLICT` | 4 | 否 | 同一操作标识绑定了另一请求。核对原始参数和操作回执。 |
| `SCHEMA_INCOMPATIBLE` | 5 | 否 | `required_version`, `actual_version_text` |
| `MIGRATION_DIRTY` | 5 | 否 | 可选 `reason`；选择新的空数据库，保留旧账本 |
| `DATABASE_ID_MISMATCH` | 5 | 否 | 可选 `reason`；检查本地 `config.yaml` 与目标数据库 |
| `BASELINE_UNAVAILABLE` | 6 | 否 | 可选 `resource_id`, `reason`；取得 commit 或显式 override |
| `WORKTREE_MISMATCH` | 6 | 否 | 可选 `resource_id`, `reason`；切换到正确 Baseline/worktree |
| `ENVIRONMENT_CAPABILITY_UNSUPPORTED` | 1 | 否 | `unmet`：后端无法强制执行的需求名数组（`workspace_write`、`network`、`cpu`、`memory`、`pids`、`ledger_readonly`）；在创建任务实例目录或进程之前拒绝，不降级执行 |
| `ENVIRONMENT_SETUP_FAILED` | 1 | 依故障 | 准备步骤给 `step_index`，诊断保留给 `diagnostic_directory`，Docker 操作给 `operation` 与有界 `diagnostic`；`exit_code` 可选；准备失败不回退 host，保留诊断与不确定现场，先检查原 receipt 再决定重试 |
| `ARTIFACT_INTEGRITY_ERROR` | 6 | 否 | 可选 `resource_id`, `reason`；不要重试损坏内容 |
| `STORAGE_TRANSIENT` | 7 | 是 | 可选 `retry_after_ms`；复用同 operation ID、同规范请求和 prepared artifact 重试 |
| `INTERNAL` | 1 | 否 | 可选 `reason`；默认不自动重试 |
