<a id="grounds-v1-error-registry"></a>

# Grounds v1 错误登记表

所有错误都符合 [`error.schema.json`](error.schema.json)。`message` 面向人且可变化；Agent 只分支 `code`、`retryable` 和下表列出的稳定 `details`。

| 错误码 | 退出码 | 可重试 | 稳定详情/处理动作 |
|---|---:|---:|---|
| `VALIDATION_ERROR` | 2 | 否 | 可选 `field`, `reason`；修正输入并使用新 operation ID |
| `NOT_FOUND` | 3 | 否 | `resource_type`, 可选 `resource_id` |
| `VERIFICATION_SET_CHANGED` | 4 | 是 | 可选 `resource_id`；丢弃旧游标，从摘要和目录首页重新读取；最多自动重启两次 |
| `LIST_CHANGED` | 4 | 是 | 只读；游标分页的资源列表和 Eval 摘要列表在读取期间账本发生了写入。丢弃旧 `next_cursor`，从首页重新读取 |
| `STATE_CONFLICT` | 4 | 否 | `resource_type`, `resource_id`, 可选 `reason`；重新读取 |
| `AUTH_FAILED` | 4 | 否 | `auth_mode`、`auth_reason`，可选 `exit_status`；历史记录解析用，当前命令面不再产生 |
| `VERSION_CONFLICT` | 4 | 否 | `resource_type`, `resource_id`, `expected_version`, `actual_version`；重新读取并用新 operation ID 决策 |
| `PREDECESSOR_CONFLICT` | 4 | 否 | `resource_type`, `resource_id`, `expected_predecessor_id`, `actual_predecessor_id`；Requirement/Issue 修订或默认 RequirementRevision 绑定已过时，重新读取并用新 operation ID 决策 |
| `IDEMPOTENCY_CONFLICT` | 4 | 否 | `existing_command`, `request_hash`, `existing_request_hash`；不得换内容重试同 ID |
| `SCHEMA_INCOMPATIBLE` | 5 | 否 | `required_version`, `actual_version_text` |
| `MIGRATION_DIRTY` | 5 | 否 | 可选 `reason`；只允许 `db status/migrate` |
| `BRAND_MIGRATION_REQUIRED` | 5 | 否 | 可选 `reason`, `migrate_argv`；按提示显式迁移旧本地状态 |
| `DATABASE_ID_MISMATCH` | 5 | 否 | 可选 `reason`；检查本地 `config.yaml` 与目标数据库 |
| `REPOSITORY_NOT_RESOLVED` | 6 | 否 | 可选 `reason`；注册或进入正确 clone |
| `REPOSITORY_AMBIGUOUS` | 6 | 否 | 可选 `reason`；显式指定 Repository |
| `BASELINE_UNAVAILABLE` | 6 | 否 | 可选 `resource_id`, `reason`；取得 commit 或显式 override |
| `REPOSITORY_ISSUE_LIMIT` | 6 | 否 | `resource_type` 为 `requirement`、`resource_id` 与可选 `reason`；一个 Requirement 在同一 Repository 只能有一个 Issue。把改动收进该 Issue 的 Goals/Constraints，或用另一个 Requirement 分开表达；确需在同一发布里新增第二个 Issue 时由人显式使用 `workspace publish --allow-second-issue-per-repository --override-reason <text>` |
| `WORKTREE_MISMATCH` | 6 | 否 | 可选 `resource_id`, `reason`；切换到正确 Baseline/worktree |
| `ENVIRONMENT_CAPABILITY_UNSUPPORTED` | 1 | 否 | `unmet`：后端无法强制执行的需求名数组（`workspace_write`、`network`、`cpu`、`memory`、`pids`、`ledger_readonly`）；在创建任务实例目录或进程之前拒绝，不降级执行 |
| `ENVIRONMENT_SETUP_FAILED` | 1 | 依故障 | 准备步骤给 `step_index`，诊断保留给 `diagnostic_directory`，Docker 操作给 `operation` 与有界 `diagnostic`；`exit_code` 可选；准备失败不回退 host，保留诊断与不确定现场，先检查原 receipt 再决定重试 |
| `UNSUPPORTED_CANDIDATE_ARTIFACT` | 1 | 否 | `artifact_format`：不再支持的候选格式；可带 `resource_id`。历史 patch-only 的内容读取、恢复及后续开发/验证/选择/交付退出支持范围，不迁移、不转换、不删除历史数据 |
| `ARTIFACT_TOO_LARGE` | 6 | 否 | 可选 `reason` |
| `ARTIFACT_INTEGRITY_ERROR` | 6 | 否 | 可选 `resource_id`, `reason`；不要重试损坏内容 |
| `STORAGE_TRANSIENT` | 7 | 是 | 可选 `retry_after_ms`；复用同 operation ID、同规范请求和 prepared artifact 重试 |
| `INTERNAL` | 1 | 否 | 可选 `reason`；默认不自动重试 |

`VERIFICATION_SET_CHANGED` 与 `LIST_CHANGED` 都是只读集合变化，不使用 operation ID，重试必须从首页开始。业务写只有 `retryable: true` 才授权 Agent 自动使用同 operation ID 重试。CLI 内部可以吸收 bounded busy/deadlock retry；连接断开或提交结果不明而暴露给调用者时统一为 `STORAGE_TRANSIENT`。Conflict 不是 transient retry：调用者重新读取并作出新决定后，必须生成新的 operation ID。

`AUTH_FAILED` 仍在错误码联合与 `error.schema.json` 中，但当前 CLI 的命令面不再产生它（auth 命令族已随 execution 族删除）。历史记录中出现的该码按上表解析：`auth_mode` 为 `chatgpt|api`；`auth_reason` 为 `expired|denied|cancelled|invalid_key|timeout|start_failed|process_failed`。错误只带白名单分类和进程退出码，不回传原始 CLI 输出或凭据。

成功 envelope 的 Requirement 绑定 warning 使用两个稳定 code：显式绑定非终端 Revision 时为 `HISTORICAL_REQUIREMENT_REVISION`；`issue revise` 默认继承旧绑定、但 Requirement 已有新版时为 `REQUIREMENT_REVISION_AVAILABLE`。warning 只报告事实，不改变已经选择的 Revision。

发布 warning 还使用两个稳定 code：同一 Requirement 在同一 Repository 上新增第二个 Issue 并由 `--allow-second-issue-per-repository` 显式接受时为 `SECOND_ISSUE_PER_REPOSITORY_OVERRIDE`；只修订已存在的同仓库多 Issue Requirement 时为 `SECOND_ISSUE_PER_REPOSITORY_EXISTING`。两者都只报告事实，不修改已发布的 Issue 归属。

## Selection

Selection 沿用 `VALIDATION_ERROR`（版本/归属/理由）、`VERSION_CONFLICT`（expected Selection 版本）、`STATE_CONFLICT`（无当前选择）与 `IDEMPOTENCY_CONFLICT`。冲突资源类型可为 `selection`，从未选择时版本为 0、错误定位使用 Issue ID。交付工件问题复用现有 Git/artifact 错误；凭据写入失败为 `WORKTREE_MISMATCH`，reason 包含保留目录。

交付准备错误可含 `target_path` 和 `inspect_argv`；恢复前先运行只读检查。`WORKTREE_MISMATCH` 保留已编辑、无归属、缺失或冲突的准备状态。Selection 版本冲突时不得刷新版本后对旧目录重试。

`code-workspace environment-show` 接受环境 revision UUIDv7，而非环境身份 ID。不存在的 revision（含误传环境身份）返回 `NOT_FOUND`、退出码 3，`details.resource_type=environment_revision` 并携带请求的 `resource_id`；非法 UUID 仍返回 `VALIDATION_ERROR`。

`code-workspace environment-default` 在仓库尚未配置默认环境时返回 `NOT_FOUND`、退出码 3，`details.resource_type=environment_default`，`resource_id` 为查询的仓库 ID。
