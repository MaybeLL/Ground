<a id="grounds-v1-contracts"></a>

# Grounds v1 契约

`task` 定义和修订带验收标准的任务，`work` 记录执行、冻结交付和当前工作头，`grade` 登记独立评价者、冻结盲评并提交逐项判定。SQLite、MySQL 和 PostgreSQL 共用工作账本协议 2、schema 2。已有协议 2、schema 1 的工作账本通过 `grounds db upgrade --config FILE` 原地增加轨迹存储，保留数据库身份及业务记录。首次运行请用空数据库执行 `grounds init`。旧协议的数据库保留在原位置；选择新的数据库及配置路径即可开始工作。

| 契约 | Schema |
|---|---|
| CLI 成功与错误信封 | [cli-envelope.schema.json](cli-envelope.schema.json) |
| 初始化、诊断、配置、数据库与安装结果 | [command-results.schema.json](command-results.schema.json) |
| Task、Work、Grade 命令结果 | [work-results.schema.json](work-results.schema.json) |
| 外部评价者逐项判定 | [grade-input.schema.json](grade-input.schema.json) |
| <a id="local-config"></a>CLI 配置 | [config.schema.json](config.schema.json) |
| 环境定义与环境命令结果 | [environment-definition.schema.json](environment-definition.schema.json)、[environment.schema.json](environment.schema.json) |
| 错误格式与恢复 | [error.schema.json](error.schema.json)、[错误说明](errors.md) |
| 共用标识与摘要 | [common.schema.json](common.schema.json) |

## 交付归档查询

`work run`、`work show`（当前工作头）、`grade show/list` 的 `archiveIntegrity` 随查询重新读取远端标签。每个 Git 交付保留账本记录的 commit，并显示读回的远端 commit（若存在）。标签一致时为 `intact`；标签移动或删除且能按 OID 核对原始对象时为 `ref-changed`；确认无法取得对象时为 `unavailable`。远端读回或对象探测失败且无法确定时，`status` 为 `null`。这些观察不会修改冻结交付和历史评分。

Git 传输不会返回托管服务的标签保护规则。已核对策略的操作者可在交付时使用 `--protection protected|unprotected --protection-evidence REF` 记录来源；省略时保护等级为 `unknown`。保护记录不参与标签推送、读回及验收判定。

运行 `work repair --run RUN --delivery ID --repo PATH` 会对原提交核对 Git 对象、推送新的修复标签并读回。`work reconcile --run RUN` 核对该运行的未确认修复，只登记已取回并验证的新标签。未推送的意图及其操作 ID 会列在 outstanding 中。每次显式修复以 operation ID 登记，重复请求使用同一标签与已存回执。存在修复时，`archiveIntegrity` 同时展示原观察、修复事实及当前采用的归档身份；精化工作可从已验证的修复回执取回原提交。

## 本机环境（grounds env）

[`environment-definition.schema.json`](environment-definition.schema.json) 定义仓库 YAML 的非敏感声明。单仓库、多变体，`repositories` 最多一项且 path 为 `.`；Docker 必须提供 `base.image` 配方。声明可版本化，凭据声明不构成宿主授权。

`grounds env repository|up|list|show|reconcile|handoff|down|run|cancel|logs|credential-grant|credential-occupancy|service-register` 的结果符合 [`environment.schema.json`](environment.schema.json)，`result_type` 为 `grounds.result.environment/v1`。任务实例（`grounds.environment/v1`）及运行记录（`grounds.environment-run/v1`）保存在本机运行根，不取得真实业务账本。可信 host 支持 macOS/Linux，没有操作系统级文件、网络或进程隔离；Docker 为完整任务 Agent 提供单仓库、独立普通 Git 与私有运行资源。只执行容器内测试不构成 Agent 隔离。

`env` 不依赖 SQL，不承担 TaskRun 业务准入。旧 `--dev-run` 参数和带 `dev_run_id` / `repository_id` 的持久环境禁止执行，旧授权文件不自动转换。调用者负责目标新鲜度、角色/阶段材料、Agent 创建/续接、Git 对象交接和 CLI 上报。环境不自动追随目标、推进验证或重跑 Agent；停止证明、成果交接、安全收尾及业务提交分别判断。能力不足 `ENVIRONMENT_CAPABILITY_UNSUPPORTED`，准备失败 `ENVIRONMENT_SETUP_FAILED`，不静默改用 host。声明及非敏感构建输入可版本化，私有凭据、控制记录、日志和报告 handoff 不进入候选树。配置固定范围与引用，认证组件可在同源同账号内续期；环境不自行刷新或扩权。

### 独立仓库授权

先在实际工作区运行 `grounds env repository --workspace DIR --json`，将 `data.repository` 对象原样填入凭据 grant 或共享服务登记的 `repository` 字段。其结构为 `{git_common_dir, device, inode}`：Git common directory 的规范绝对路径及文件系统设备/inode 字符串。同一仓库的 linked worktree 共享授权，独立 clone、另一个仓库或原路径下重新创建的目录不自动继承。此身份是本机授权范围，不是远端仓库 ID、业务身份或操作系统隔离；不得用任意旧 `repository_id` 替代。更换机器/clone/目录实例后须显式重新授权，不做迁移。

`env credential-grant --grant-file FILE` 仍要求名称、环境、来源文件、账号、认证方式和允许的访问类型；凭据声明不构成授权。授权形状见 `environment.schema.json#/$defs/credentialGrant`。`env service-register --service-file FILE` 仍需固定容器/网络 ID、host、port、kind、name、environment，以及同样的 `repository` 对象，见 `#/$defs/sharedService`。只有仓库、环境、名称和服务种类均匹配时才使用共享服务。查询仓库身份和登记授权不连接远端或打开账本。

准备需要凭据或共享服务的环境时，从工作区实际 Git 元数据解析身份，不接受调用者自报身份。准备期间及每次启动命令前重新核对仓库实例；身份改变或旧绑定出现时，在产生新 run 或启动进程前拒绝。无凭据、无共享服务的独立 host 目录无需是 Git 仓库。Git 配置解析清除外部 `GIT_*` 覆盖；本机拥有者仍可改动文件和授权，检查不提供对恶意同用户进程的强隔离。

旧受管目录旁的 `owner.json` / `state.json`、外部工作区注册预约、旧路线保留标记和损坏私有 Git 指针仍作为拒绝依据；检查覆盖子目录，未知或损坏状态不会授予执行，也不修改这些记录；即使损坏记录的目录不重叠，也必须拒绝。只读查询不会创建注册根目录或更改其权限。host 运行的最终预约检查与 env lease 发布在同一个 `directory-registry` 文件锁内执行，与尚未退役的 DevRun 发布互斥；锁被占用时明确失败，不等待或重试执行命令。此保护不恢复旧 DevRun 执行功能。

### Historical evaluation suites

`suite publish --name NAME --cases-file FILE` creates a suite and its first snapshot. To publish another snapshot supply `--suite ID --expected-seq N`. Each case names a historical run and candidate. Its bindings choose independent graders and optionally a separate frozen source for later corrections or private tests.

```json
[{
  "key": "export",
  "runId": "historical-run",
  "deliveryId": "selected-candidate",
  "bindings": [{
    "key": "exact-output",
    "answerPath": "out.csv",
    "referencePath": "expected.csv",
    "hiddenTestPaths": ["test_export.py"],
    "materialSource": {"runId": "curator-run", "deliveryId": "curated-candidate"}
  }]
}]
```

A binding defaults to the built-in exact-file grader. `grade define-rule --name NAME --rule file-exists --pass present --fail absent` publishes a rule with two ordered categories. Choose `equal-file-bytes` to require a reference answer. Use `--grader ID --expected-seq N` to revise an existing rule. To pin it on a binding, set `grader` to an object containing its `definitionId` (the returned `graderId`) and `revisionId`. File presence needs only `answerPath`. All paths are relative to the frozen Git tree. Each stored material is a regular file of at most 1 MiB. Answer files are hashed as streams. Public views return provenance, visibility and digests.

`suite show --suite ID --revision N` reads an exact snapshot. `suite list` lists suite heads. `suite measure --suite ID --revision N --case KEY --binding KEY --run RUN --delivery ID` evaluates the selected delivery of the same TaskRevision. A single binding can be selected implicitly. Use a new operation ID to recompute and record another measurement. `grade show` reads the resulting grading. See [suite command results](suite-results.schema.json).

For a historical measurement without a suite, use `grade measure --run RUN --delivery ID --grader ID --grader-revision REV --answer-path PATH`. Exact-file comparison additionally requires `--reference-run RUN --reference-delivery ID --reference-path PATH`. The standalone grading records the exact target, grader revision, answer fingerprint and reference source. An absent output in a verified tree uses the rule's failure category. A new operation ID recomputes the result.

### Task environments and sandbox lifecycle

Publish a trusted environment using `work define-environment --name NAME --devcontainer FILE --image-digest sha256:…`. The digest identifies the image in Docker or its registry. Use `--lockfile FILE` to preserve the source lockfile and its digest beside the effective configuration. Build features into the pinned image before publishing it. Configuration accepts JSON with comments. For a revision supply `--environment ID --expected-seq N`. `work environment --environment ID --revision N` returns the frozen sources. Configuration and lockfile are stored in the ledger. Use runtime credential injection for secrets.

Declare `--environment ID` when authoring a task. `work start`, `continue` and `branch` record the resolved revision and its selection source. Use `--environment-revision REVISION_ID` to pin a specific revision of the required definition. External tasks and tasks without an environment remain available on machines without Docker.

`work prepare-sandbox --run RUN --repo PATH` prepares an independent checkout and devcontainer. Docker must have access to the Grounds workspace directory. This version accepts self-contained configurations backed by a prebuilt image. It pins the launch image before startup, freezes the lockfile next to the published config and checks the workspace bind mount in Docker. `work reconcile-sandbox --run RUN` observes an interrupted preparation. `work pause-sandbox` and `work release-sandbox` on terminal runs each take `--run RUN`; their operation IDs are replayable. Closing a work releases its owned containers. [Sandbox results](sandbox-results.schema.json)

### Provider trace archives

`work import-trace --run RUN --session SESSION --provider codex|claude-code --file FILE --digest SHA256` imports exact JSONL bytes from an external worker. The operation receipt includes two content-addressed streams, raw and normalized. Each stream uses 64 KiB chunks. An event identifies its source line (starting at 1) and block position (starting at 0). Unknown records remain available through the raw stream. Records larger than 8 MiB are retained raw and excluded from normalized output.

`work trace --run RUN --digest RAW_DIGEST --stream raw|events --chunk N` returns one verified chunk as base64. Concatenate decoded chunks in ordinal order and compare the stream's SHA-256. Empty streams have zero chunks. Existing transcript references remain readable. [Trace result contracts](trace-results.schema.json)

The trace descriptor counts invalid UTF-8, malformed JSON, oversized records, unmapped records or parts, and parts that cannot be serialized. Each gate freezes the raw and event digests available when it is requested. Later imports only contribute to subsequent requests.

When resuming partially created MySQL evidence tables, the upgrade account must be able to inspect their triggers. Recovery refuses ambiguous objects and leaves the ledger marked in progress.


### 托管编码任务

先通过 `work define-environment` 登记 devcontainer 环境，在任务定义中引用该环境。镜像须包含 Git 及选定的 Agent 命令。使用 `work define-agent --name NAME --provider codex|claude-code` 登记 Agent，可通过 `--model` 固定模型。随后执行 `work start --mode managed --task TASK --agent AGENT --repo PATH`。返回的 runId 可用于 `work managed-status --run RUN` 查询任务状态、Agent 执行阶段、停止证明和已封存的轨迹。

任务要求 Agent 在容器工作区提交修改，最终输出形如 `{"candidate":{"commit":"完整 Git OID"}}` 的 JSON。宿主核实起始提交、候选提交和远端归档回执后记录交付。宿主报告等待恢复时，可执行 `work resume-managed --run RUN` 续接。已开始的模型调用只做状态核对。


托管精化默认在 `work continue` 接手工作头保留的沙箱。使用 `--sandbox fresh` 可从父交付创建新的工作区。`work branch` 默认新建工作区，可用 `--sandbox inherit` 请求接手。接手保留未提交的文件并继承父运行的环境修订。请求的环境与保留沙箱冲突时，可改选新沙箱。父运行的正式交付提交会作为精化输入提供给工作者。失败或已取消的托管父运行没有交付时，显式选择 fresh 会从该父运行原先固定的基线开始。

### 测试评分器

`grade define-test --name NAME --commands FILE --environment ID --environment-revision REV --pass LABEL --fail LABEL` 固定评价者环境与命令。FILE 是按执行顺序排列的 JSON 参数数组，例如 `[["sh","/grounds-grader/check.sh"]]`。测试绑定使用精确 grader 修订，可指定 `hiddenTestPaths`；`answerPath` 供文件规则使用。评价者在独立沙箱中检出冻结提交，隐藏材料以只读方式挂载到 `/grounds-grader`。

`suite measure` 受理后返回 gradingId。`grade test-status --grading ID` 查询宿主观测，`grade resume-test --grading ID` 显式推进尚未启动的命令，`grade cancel --grading ID` 取消。所有命令都确认停止并有退出码后，全部为零取 pass 标签，否则取 fail 标签。无法取得可信退出码时记录 grader_fault；取消优先。评分终结后释放容器和工作区。

`grade show --grading ID` 显示各命令退出码、输出摘要及内容摘要值。每条命令的 stdout、stderr 各保留前 1 MiB，正常收集时同时记录完整字节数，complete 标明是否完整。`grade test-output --grading ID --step N --stream stdout|stderr --chunk N` 按 64 KiB 分块取回选定评分的证据。

### 实验与批次

创建实验时固定套件快照和被测 Agent 修订。每个 case 的任务、评分绑定、Git 基线与发布地址一并固定。环境修订在创建实验时从任务要求解析，后续批次使用同一解析结果。

```bash
grounds experiment define --name comparison --suite SUITE --revision 1 --agent AGENT --agent-revision REV --repo PATH
grounds experiment launch --experiment EXPERIMENT --repeat 2 --concurrency 1
grounds experiment results --batch BATCH
grounds experiment member --batch BATCH --member 'CASE#0'
grounds experiment regrade --batch BATCH --member 'CASE#0' --binding REQUIREMENT
```

`--overrides FILE` 可为不同 case 提供本机仓库路径，格式如 `{"case-a":{"repositoryPath":"../source"}}`。批次默认每项独立执行一次，最多同时运行五个任务。每个样本有独立的 TaskRun，使用宿主的 Agent 名额，终结后释放沙箱。已受理批次通过 `experiment resume --batch BATCH` 显式继续；`experiment cancel --batch BATCH` 关闭该批次的入场入口并传播取消。

`experiment show --experiment EXPERIMENT` 展示方案和各批次概况。批次结果按评分要求、评分器修订与标尺分组。planned 是预期评分数，valid 是已有有效评分数，indeterminate 是合法的无法判定，executionErrors 记录基础设施导致的样本失败。数值平均仅使用有效数值，分类结果保留各类别计数。成员明细给出采用的准确记录、较晚的评分故障及未开展原因。补评保留历史并沿用原成员身份。

### Working 任务、材料与交付

用 `grounds task create --kind working` 创建任务，用可重复的 `--required-output KEY` 和 `--optional-output KEY` 声明输出槽。省略输出槽时，working 任务使用一个必需的 `result` 槽。可通过 `--materials FILE` 传入 JSON 数组，每个条目含 `name`、本地 Git 仓库路径 `repository` 和完整提交 ID `commit`。修订保留上版的任务类型、材料和输出槽，直至显式替换。

`grounds work workspace --run RUN` 返回可写输出目录及各材料快照的只读路径。再次打开会核验材料内容和提交身份。外部 Agent 使用登记的会话保存选定文件，同一个 Artifact 可包含多个文件。读取接口支持按原路径分块读取归档字节。

```sh
grounds work save-artifact --run RUN --session SESSION --slot result --file report.md=./report.md --file data.csv=./data.csv
grounds work artifact --run RUN --artifact ID
grounds work artifact-file --run RUN --artifact ID --path report.md --chunk 0
grounds work submit-artifacts --run RUN --session SESSION --artifact ID
```

Coding 任务有必需附件时，用 `grounds work deliver --run RUN --session SESSION --artifact ID` 在同一份清单中提交 Git Candidate 和附件。每个槽选择一份已保存的产物。托管 worker 同样支持 working 任务和带附件的 coding 任务。运行器把材料仓库只读挂载在 `/grounds-materials/<name>`。Working 容器的当前目录用于写输出，`work prepare-sandbox` 的 `commit` 返回 `null`。Agent 的最终 JSON 以 `artifacts` 数组声明每个槽的文件。例如 `{"artifacts":[{"slot":"result","files":[{"path":"report.txt","source":"summary.txt"}]}]}`。Coding 的同一份声明还须包含 `candidate.commit`。每个托管 Artifact 保存来源 `executionId`，与同一轮的轨迹、冻结输出和交付清单关联。
