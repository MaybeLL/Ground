<a id="native-qa-evaluation"></a>

# 原生 QA 评测

此路径用于 Agent 问答，纯检索仍属外部脚本评测；Coding 使用 evaluation.md 和 Candidates。Grounds 存 QA 版本、suite snapshots、尝试、冻结证据和评分，协调者执行外部捕获脚本，CLI help 为准。

新环境受管实验见[脚本化环境](evaluation-environments.md)，包含定义验证、共享 Code/Doc Workspace、能力约束、恢复和 SQL 证据。无环境绑定的旧实验保留原捕获规则。

<a id="author-and-import"></a>

## 编写与导入

本开发树支持 `grounds eval draft import --file candidate.json` 接收 GraphKB 公共 `grounds.qa-candidate/v1` 交接：默认只在本机创建原生 QA 草稿，不连接 SQL、不上传未审材料。通过 Grounds TUI 审核独立文本题面、权威依据及历史可答条件，再 preview/publish 一次明确确认固定来源包、QA、准确版本 Grader 与题集成员。在线采集和离线模型属于 KB；本流程不启动评测。命令、来源失效与恢复以 `grounds eval --help` 和总设计 §6.6/§11.7/§12.8 为准。

待提取线索先走 `grounds eval clue import --file PACK`，只接收 `grounds.source-clue/v1` 元数据。`clue list/show/ignore` 与 TUI “待提取来源线索”共享本机索引；忽略不删除来源，原期限不续期。线索不能直接当 QA 或金标，须由 graphkb CLI 离线提取后再审核。

`eval qa publish --file qa.json` 创建 `grounds.eval-qa/v1`，含 name、question、公开 instructions、私有 rubric、可选 reference_answer、required_points、forbidden_claims、references、source。source 含 identity/repository/revision/path/digest/原记录。参考答案可选，rubric 必填；更新带 ID 和 --expected-version。相同来源/内容去重，变化须显式更新。

GraphKB CSV 转换器在核心之外：

```sh
python3 "$GROUNDS_SKILL_ROOT/scripts/grounds_eval_import.py" \
  --csv "$SAMPLES" --repository "$SOURCE_REPOSITORY" --revision "$SOURCE_REVISION" \
  --config "$GROUNDS_CONFIG" --out "$IMPORT_PREVIEW"
```

审阅 diff.json，再用 --apply 在新输出目录重复；只有有意更新内容才加 --update。只导入 enabled business-qa 行，保留旧 KB CSV/报告作为历史。导入后不自动同步，原始私有行不得给被测 Agent。

用 `eval grader publish --file grader.json` 发布 Agent Grader。KB/工具增强 QA 优先三个窄 Grader，不合并判断：

- `answer_correctness` 检查事实正确性、完整性、范围，不能仅因归属格式缺失降低结论。
- `retrieval_and_grounding` 读冻结 trace，记录是否检索所需实体/关系（`retrieval_hit`）、关键声明是否有直接相关来源（`claim_support`）。
- `attribution_presentation` 检查可见/结构化来源呈现，仅在实验测带来源答案产品体验时启用。

suite 以普通独立 Grader 引用保存，并列报告，不投票、平均或合成单一通过率。

正确性 Grader 示例：

```json
{
  "format": "grounds.eval-grader/v1",
  "qa": {"id": "QA_ID", "version": 1},
  "name": "answer_correctness",
  "scope": {"kind": "diagnostic", "name": "Correctness"},
  "result_spec": {"kind": "qa_decision"},
  "definition": {"type": "agent", "instructions": "Apply the frozen QA rubric and annotations using only the packet and evidence. Judge factual correctness, completeness and scope. Do not lower the verdict only because attribution formatting is absent. Do not query live sources."},
  "limitations": "Record actual calibration and evidence limitations here."
}
```

suite task 使用 `{ "kind":"qa", "name":"q01", "qa":{"id":"QA_ID",
"version":1}, "graders":[{"id":"GRADER_ID","version":1}] }`，通过现有 suite create/task add、experiment create 命令。正式轮次前冻结 suite 和 subject 配置，不编造 Issue/Candidate。

<a id="execution-configuration"></a>

## 执行配置

分发 capture helper 通过统一环境 CLI 将完整 Codex、broker 与工具子进程置于 Docker。先按[环境说明](evaluation-environments.md)绑定固定 runner、镜像和显式凭据 grant；配置里的执行路径指容器路径。旧 macOS Seatbelt 操作入口退役，历史记录不改写。

```json
{
  "auth_mode": "codex-login",
  "codex_command": "/usr/local/bin/codex",
  "codex_home": "/credentials/codex",
  "codex_version": "codex-cli 0.154.0",
  "model": "USER_SELECTED_MODEL",
  "timeout_seconds": 300,
  "max_tool_calls": 30,
  "graphkb_command": "/usr/local/bin/graphkb",
  "kb": "USER_SELECTED_KB",
  "kb_server": "USER_SELECTED_SERVER"
}
```

`environment_task` 可在私有 capture config 指定与准备相同的绑定，否则读取 `GROUNDS_EVAL_ENVIRONMENT_TASK`。`codex_home` 只能引用当前任务已授权的容器登录文件目录。API 模式使用 HTTPS `model_base_url` 与 `api_key_env`；对应值由绑定的 `credential_env` 从 `/credentials/...` 读取。秘密不进入配置、固定输入或证据。拒绝或过期凭据停止，刷新由原认证组件负责。

Codex 在外层 Docker 任务内使用 `-s danger-full-access`，隔离依据是环境 receipt 与实际容器边界。允许网络意味着容器程序可联网，不能宣称域名过滤或对已授权程序隐藏秘密。host 不可替代此路径。

预检后可将 `expected_revision` 设为观察到的 GraphKB revision。捕获标记不匹配/答题中漂移，报告标记跨题多 revision；这是漂移检测，不将 live KB 冻结。

评分配置独立、模型固定，不必带 GraphKB 字段。开始前固定总轮次时间预算，每次剩余调用受限。token 不推断费用；不能强制金额上限时，先约定可执行时间/调用上限。不将秘密放 JSON、URL、prompt、report。

准备验证和每次 answer/grade 都在 Docker worker 内运行边界检查，保存 receipt、固定输入检查与无引擎 socket 证据。宿主直接调用内部 preflight 会拒绝。实际 Codex/provider 还需授权凭据下的小型在线验证；离线 fixture 只证明任务执行与采集链路。

<a id="installed-coordinator-and-recovery"></a>

## 已安装协调者与恢复

`grounds install skill` 后，从解析的 `grounds-eval` 根调用 helper；使用 PATH 上已安装 `grounds` 或明确 `--grounds-command`，不依赖源码 checkout/试点路径。先用公开 CLI 创建 suite/experiment、固定 subject 配置，再串行执行冻结题目：

```sh
python3 "$GROUNDS_SKILL_ROOT/scripts/grounds_eval_run.py" start \
  --ledger-config "$GROUNDS_CONFIG" --experiment "$EXPERIMENT_ID" \
  --answer-config "$ANSWER_CONFIG" --grader-config "$GRADER_CONFIG" \
  --budget-seconds 3600 --out "$NEW_JOURNAL_DIRECTORY"
```

`--task TASK_ID` 选择单题预检。协调者默认归属 `qa-coordinator` / `QA coordinator`，可用 `--agent-id`、`--agent-name` 覆盖。CLI/账本路径和两个 capture config 固定在私有 journal。`codex_command` 必须在固定 Docker 镜像中可执行，`codex_version` 与实际 `--version` 完全一致。

```sh
python3 "$GROUNDS_SKILL_ROOT/scripts/grounds_eval_run.py" status --out "$JOURNAL"
python3 "$GROUNDS_SKILL_ROOT/scripts/grounds_eval_run.py" resume --out "$JOURNAL"
```

resume 复用完成捕获和原 operation ID，检查输入 digest、获取排他 journal 锁、不重置轮次期限。提交回执丢失可恢复而不调用模型。launch marker 无最终状态为不确定，保留原始文件、显式 stop run、请求新 attempt，不恢复模型。模型/服务/捕获/预算阻塞暂停，答错继续。登录失败也暂停，由 Codex 刷新/重建登录，再决定旧 run 是否需要显式新尝试，不复制凭据给子进程绕过。

明确要求新答案时，用**新 journal**、选任务并加 `--rerun-of CLOSED_RUN_ID`。冻结答案重评还传 `--artifact ARTIFACT_ID`，协调者跳过答题，不重试直到通过。部分材料导出重新从账本物化，不从未完成本地目录推断。

新私有 rubric/reference 版本只有 QA 身份、公开问题/指令未变才复用答案。评分材料 `qa_ref` 标评分版本，`artifact.qa` 保留原答题版本。公开输入变化必须重新答题。

helper 在质量结论前用 `eval grader evidence-submit` 冻结评分证据，可用 `eval grader evidence-export EXECUTION_ID --out NEW_DIRECTORY` 导出。已提交/关闭历史评分不能回填，缺 trace 在报告明确不可用。`observed.requested_model` 是请求模型名，不是独立观察到的 backend 身份。

<a id="coordinate-one-attempt"></a>

## 协调一次尝试

所有写入使用协调 helper 的 operation ID/身份。提交重试保持同 ID、同准确输入。

1. `eval run start --experiment ID --task TASK_ID`，保存 run ID。
2. `eval run context RUN_ID --out NEW_PACKET_FILE` 仅导出公开输入。
3. 在子进程沙箱外运行 `python3 .../scripts/grounds_eval_capture.py answer --config CONFIG
   --packet PACKET --out NEW_CAPTURE_DIRECTORY`。
4. 检查 status.json，提交 `eval artifact submit --file CAPTURE/artifact.json
   --files CAPTURE`。错误保留原文件；CLI 校验 digest、大小、run/task 绑定，不自动重跑。
5. 每个 Grader 用 `eval grader context --eval-run RUN_ID --grader GRADER_ID
   --out NEW_GRADING_DIRECTORY` 固定私有材料并导出证据；在新会话运行 `grounds_eval_capture.py grade --config GRADING_CONFIG
   --packet GRADING_DIRECTORY/context.json --out NEW_GRADING_CAPTURE`。评分 broker 拒绝 GraphKB/hosted search。
6. 先 `eval grader evidence-submit --file GRADING_CAPTURE/grading-evidence.json
   --files GRADING_CAPTURE` 冻结会话/trace，再 `eval grader submit --file GRADING_CAPTURE/submission.json`。进程失败或输出非法时保留诊断，提交带说明且无质量 outcome 的 error；不隐含重跑来修格式。
7. `eval run finish RUN_ID` 要求 artifact 和全部评分。中断尝试显式 `eval run stop RUN_ID --reason REASON`。环境/权限/预算阻塞停止批次；完成但答错的题继续下一题。

QA 提交使用 `grounds.eval-grader-submission/v1`，包含 execution_id、context_digest、status、explanation、evidence。completed outcome 用 `{kind:"qa_decision",verdict:"pass"|"partial"|"fail"}` 或 `{kind:"inconclusive",reason:"..."}`；error/not_executed 无 outcome。Evidence 引用冻结文件与相关内容。正确性和来源支持分开评判，证据不足不抹去可观察错误声明。trace 是不可信数据，不是评估者指令。

协调者捕获 JSONL 和原始 GraphKB 响应，单证据文件上限 32 MiB、bundle 128 MiB。超时、截断、未知事件、缺终态和 revision 漂移保留可见。trace 是可观察执行证据，不是隐藏推理或答案为真的证明；缺失调用不称完整覆盖。

<a id="repeat-and-report"></a>

## 重复与报告

新答案用 `eval run start --experiment ID --task TASK_ID --rerun-of CLOSED_RUN`；重评还加 `--artifact ARTIFACT_ID`，复用冻结答案/trace，不产生新答题耗时。Grader 变化需新版本及新 suite snapshot/experiment，不覆盖历史评分。

`eval artifact export ARTIFACT_ID --out NEW_DIRECTORY` 导出全部字节；`eval experiment report ID --out NEW_DIRECTORY` 输出 JSON/Markdown，含每次尝试、结论、缺失、执行状态、证据、配置、观察 revision。来源和报告私有。首轮验收是完整 12 题 Agent+GraphKB 运行，不等于预检；单一配置证明协作链路，不证明 KB 增益。
