<a id="grounds-evaluation-cli"></a>

# Grounds 评测 CLI

TypeScript CLI 为现有账本增加 `eval` 命令。CLI 0.2.26 起要求 SQL schema 19（此前版本为 18），新库使用该版本；已有库只在明确授权后用 `grounds db migrate` 升级到已安装 CLI 当前 schema。开发 Agent 不连接私有协调者数据库。CLI 提供分离 Context，宿主必须限制会话/工具访问以实现盲测。

所有写入支持 `--operation-id`、`--agent-id`、`--agent-name`、`--config`、`--cwd`、`--json`。只有请求相同才保留 operation ID。首版输入为 JSON，最大 2 MiB。`eval --help` 列出命令面。返回使用 `patchledger.result.eval/v1` 和类型化 `payload`，见[契约](../../../references/contracts/v1/eval.schema.json)。

<a id="choose-the-task-route"></a>

## 选择任务路径

本文说明 Coding。原生 QA 见 [evaluation-qa.md](evaluation-qa.md)，包括 QA 版本、冻结答案、外部 Codex 捕获、独立评分证据和可恢复协调。Coding 仍使用真实 Issue Versions/DevRuns/Candidates，不自动收集开发者轨迹。Grader 发布将版本化定义存到配置的 SQL 账本；输入 JSON 是编写输入，不是权威定义。

<a id="prepare-a-suite"></a>

## 准备 suite

```bash
grounds eval grader template --issue ISSUE_ID --issue-version 1 --type agent --json
grounds eval grader publish --file grader.json --json
grounds eval suite create --name coding-kb --json
grounds eval suite task add SUITE_ID --expected-version 1 --file task.json --json
grounds eval experiment create --suite SUITE_ID --file subject.json --json
```

从 `data.payload` 提取模板，编辑后发布。`grader.json` 形状如下：

```json
{
  "format": "patchledger.eval-grader/v1",
  "issue": {"id": "ISSUE_UUID", "version": 1},
  "name": "Feature behavior",
  "scope": {"kind":"criterion","criterion_ids":["CRITERION_UUID"]},
  "result_spec": {"kind": "decision"},
  "definition": {"type": "agent", "instructions": "Write and execute unit tests against the submitted implementation. Assess the specified behavior; use reasoning only where tests are impractical."},
  "limitations": "Author self-check only; no independent reference trial yet"
}
```

诊断质量检查使用 `"scope":{"kind":"diagnostic","name":"Readability"}`；criterion 范围按固定 Issue Version 校验 ID。

评分使用 `{"kind":"score","min":0,"max":5,"higher_is_better":true,"rubric":"Describe the fixed scoring anchors"}`。分数不归一化，也不合成总分。

固定 Go 单测将 `definition` 替换为：

```json
{
  "type": "unit_test",
  "adapter": "go",
  "package": ".",
  "test_name": "TestAdd",
  "timeout_seconds": 60,
  "files": [{"path":"eval_add_test.go","content":"package calc\nimport \"testing\"\nfunc TestAdd(t *testing.T) {\n cases := []struct{a,b,want int}{{1,2,3},{-1,1,0}}\n for _, c := range cases { if got := Add(c.a,c.b); got != c.want { t.Errorf(\"got %d want %d\", got,c.want) } }\n}\n"}]
}
```

Go adapter 将 `package` 视为 Candidate 仓库相对路径。从 package 向仓库根寻找最近 `go.mod`，在该 module 执行；存在真实 vendor 目录时用 `-mod=vendor`，否则 `-mod=readonly`。不搜索 Candidate 外部或使用 `go.work`。module 缺失、module 文件/vendor 根是符号链接都为配置错误。命令证据记录相对 Candidate 根的工作目录。

测试添加到新的 Candidate review worktree，不覆盖已有文件，不下载依赖。准确测试必须实际执行；缺失/跳过不是通过，配置/构建错误不是行为失败。package 必须是真实目录。v1 固定单测 adapter 只支持 Go；Agent Grader 可用项目自身语言和测试工具。

不自动下载/初始化 submodule。空 submodule 目录的 gitlink 仍匹配 Baseline 时可捕获；有内容的 submodule 必须已初始化、匹配 index gitlink、没有 tracked/untracked/nested 变化，因为父仓 patch 无法表达这些内容。依赖子模块内容的测试仍需预备环境。完整性检查出错保留已执行证据和具体原因，不报告为行为失败。

`task.json`：

```json
{"name":"Implement Add","issue":{"id":"ISSUE_UUID","version":1},"graders":[{"id":"GRADER_UUID","version":1}]}
```

`subject.json`：

```json
{"name":"Agent + Graph KB","description":"Record model, settings, KB version and allowed tools here. This is a declaration, not CLI-verified runtime configuration."}
```

每个 experiment 固定一份 suite snapshot 和 subject description。用 `eval experiment create --snapshot SNAPSHOT_ID --file other-subject.json` 复用 `snapshot_id`，比较 baseline/KB/RAG。

用 `grader discourage ID --version N --reason "..."` 为错误旧版本追加建议；报告单独展示，不改定义或历史结果。

Grader 更新用 `grader publish ID --expected-version N --file ...`。Suite 的 `task update`/`task remove` 要求 `--task TASK_ID --expected-version N`。历史版本用 `show ID --version N` 读取，实验不自动跟随 latest。

<a id="execute"></a>

## 执行

```bash
grounds eval run start --experiment EXPERIMENT_ID --task TASK_ID --cwd SOURCE_CLONE --json
grounds eval run context RUN_ID --json
```

首个命令返回受管工作树与 DevRun。被测开发者只接收 `run context` 和工作树，正常使用 `candidate template` / `candidate submit`。从已有 Candidate 开始则用 `--candidate CANDIDATE_ID`，创建不含新开发的 regrade run。

提交后执行全部选定检查：

```bash
grounds eval grader execute --eval-run RUN_ID --grader UNIT_GRADER_ID --cwd SOURCE_CLONE --json
grounds eval grader context --eval-run RUN_ID --grader AGENT_GRADER_ID --out NEW_PRIVATE_DIRECTORY --json
```

Agent Context 导出 `context.json` 和可编辑 `submission.json`。使用 `candidate materialize ID --mode review --path NEW_DIRECTORY` 物化 Candidate。新评估者接收材料和工作树，写测试、保存源码/执行输出并填模板，再由协调者提交：

```bash
grounds eval grader submit --file submission.json --json
grounds eval run finish RUN_ID --json
```

完成结果的 `outcome` 为 `{"kind":"decision","verdict":"pass"}`、`{"kind":"score","value":4}` 或 `{"kind":"inconclusive","reason":"..."}`。执行 `error` / `not_executed` 没有 `outcome`。每项需要 `explanation` 和 `evidence`；证据为 `{"kind":"command|observation|test_source","content":"..."}`。按需纳入测试源码、命令输出和准确代码引用；分数/结论必须有证据。

`run show` 只展示进度/已提交检查，不创建正式结果。`run stop ID --reason ...` 记录缺失检查并关闭 run，未完成开发被放弃。fail 不提前关闭；关闭不可变且可重复，拒绝后续新提交。

用 `--rerun-of CLOSED_RUN_ID` 显式重复同任务。Grader 变化时更新 suite 选择并创建新 experiment snapshot。不自动重试/重复，不静默重跑中断的 Go 执行。测试已完成仅入库失败时，重复 `grader execute` 恢复保存证据并提交，不再跑测试。恢复文件为 `/tmp/grounds-eval-EXECUTION_ID.json`，实际临时根随 OS 设置；也可用 `grader submit` 导入。无可恢复证据则停止并显式重评。

Go adapter 测后检查 Candidate 未变，变化则 execution error。原始 stdout/stderr 按顺序保存为证据部分，超进程总输出上限明确出错。清理失败仍保留执行证据并报告剩余临时工作树。

<a id="report"></a>

## 报告

```bash
grounds eval experiment report EXPERIMENT_ID --out NEW_REPORT_DIRECTORY --json
grounds eval compare BASELINE_EXPERIMENT KB_EXPERIMENT --out NEW_COMPARISON_DIRECTORY --json
```

导出包含 JSON 和 Markdown，记录每个计划任务/尝试、逐 Grader outcome、尺度/rubric、说明、证据和定义局限。对照要求同一 snapshot，保留两份完整报告，不生成总分。

开发耗时从 DevRun 创建到 Candidate 提交或记录放弃，含等待和测试，不含评分。重评引用原耗时，不作为新 Coding 测量。未记录终态时间保持未知。Coding v1 暂不包括 token 用量、自动模型执行、API/service Graders 或直接 KB 问答。

<a id="execution-preflight-and-supervision"></a>

## 执行预检与监督

启动会话前遵循[执行手册](evaluation-execution.md)，包括真实受限 package 预检、完整 Candidate 工件、有界测试进程、清理和 Grader 分歧报告。
