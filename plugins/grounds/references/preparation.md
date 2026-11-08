<a id="shared-grounds-preparation"></a>

# CLI 准备与结果处理

直接调用已安装的 `grounds`，不使用 Python 命令包装器、Codex 采集器或自动运行 journal。先检查 `grounds --version` 和当前工作所需的帮助（开发用 `grounds work help --json`）。本开发树的新闭环为 `task / work / grade`；不要用旧业务命令或旧脚本代替缺失的新能力。

## 配置与授权

- `grounds config path --json` 查看配置位置；已有配置用 `grounds db test --json` 核对连接。可用 `--config PATH` 显式选择账本，之后各调用保持一致。
- 未初始化时，向用户说明将创建的配置和数据库；在已有授权范围内执行 `grounds init --non-interactive --json`。不要自动覆盖配置、升级旧数据库或迁移历史目录。
- 使用 `--cwd DIR` 指定代码仓库；命令中出现的 ID、路径、摘要均来自真实回执，不凭猜测填充。
- 只读请求不授权业务写入、启动 agent 或执行测试。独立验收需要主 agent 启动全新子 agent，必须处于用户允许的执行范围内。

## 结构化结果与重试

每条自动化调用加 `--json`。CLI envelope 的 `ok` 表示调用结果，不等于任务验收成功。失败时保留 `error.code`、`retryable` 和 `details`；不得把未知状态解释成空结果。

新闭环的写命令会返回并打印 `operation_id`；保存原始参数及该标识。需要安全重试时传回同一 `--operation-id`，保持参数和提交 commit 不变。不要为了避开冲突换一个 ID，也不要把未知启动结果当作未启动。读回 `work run`、`work show` 或 `grade show` 后决定下一步。

CLI 当前不会验证新结果的全部 JSON schema；按具体命令返回内容核对状态、版本和身份，不能套用旧 Candidate 结果类型。结果与 `grade submit --grade-file` 的输入格式见[分发契约](contracts/v1/README.md)。

## 证据边界

声明、远端归档、独立验收、实际合入和发布是不同事实。外部 agent 的停止仅是声明，不是已核实的进程终止。真实模型未运行、测试被跳过或权限检查失败都要明确报告。

本 skill 不再分发 Python 工具。旧评测、QA 草稿和知识材料流程已退出，不能调用 `eval` 或旧脚本补足尚未实现的新实验能力。
