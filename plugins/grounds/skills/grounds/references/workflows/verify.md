<a id="verify-a-grounds-candidate"></a>

# 独立验证 Grounds Candidate

保持信任边界：独立验证者必须先形成并记录每项独立评估，再查看提交者的声明、证据或说明。

<a id="choose-the-mode"></a>

## 选择验收模式

每次发起独立验收时确定模式；模式不写进 Issue 契约，也不由开发者选择。

- **normal（默认）**：只做契约验收，即下文的盲验与对照流程，命令与结果与以往完全一致。
- **ultra**：仅在用户明确要求或授权时使用。在契约验收之外，再由另一个独立 Agent 对代码质量评审，两部分合成**一份** Verification 一起入账。契约或质量任一部分不通过，该份 Verification 即不通过；`standing` 仍按全部报告的整体结论派生，例如已有 normal 通过、后来 ultra 不通过时为 `disputed`。ultra 流程见本文末尾“ultra：代码质量评审”一节。

用户没有指明时使用 normal，不为了“更稳妥”自行升级；也不得在 ultra 无法完整执行时降级为 normal 报告。

Candidate `self_verification` 是开发者自我验证，不是本流程的独立 Verification。盲验时隐藏该字段。对照阶段将方法、结论和支持的 Criterion 证据作为作者材料检查，不能将其状态复制为独立结论。历史缺字段表示未记录，不代表成功。

<a id="establish-isolation"></a>

## 建立隔离

Candidate 来自新代码 Workspace 时，仍验证固定候选而非活动开发目录。协调者使用匹配且持有归档对象的 clone 执行以下物化/运行入口；原实例已回收时先按[Git 归档协议](../candidate-archive.md)取回精确成果。不要把整个 Workspace、相关服务基线或共享缓存交给盲验者；开发上下文的读取权限不自动成为盲验材料授权。

1. 遵循[共享准备协议](../../../../references/preparation.md)。协调者记录 Candidate 开发者归属，不将作者声明传给验证者，再通过共享 helper 获取 `verification context CANDIDATE_ID --phase blind`。
2. 从匹配 clone 使用 `candidate materialize CANDIDATE_ID --mode review`（不传 `--path`）创建审阅工作树，不使用 delivery 模式或创建分支。CLI 为这个验证者建立会话目录 `<数据根>/repositories/<仓库标识>/reviews/<candidate_id>/<review_session_id>/`，返回 `review_session_id`，工作树位于其 `worktree` 子目录。**一个验证者一个会话**：每轮验证创建新验证者，就创建新会话；ultra 的契约验收与质量评审是两个验证者，各自 materialize，得到不同的 `review_session_id`，互不共享工作树与材料。盲评/对照 Context 与签名 handoff 写在会话目录内、与 `worktree` 互为兄弟，不要写进工作树：工作树内多出的文件会改变被校验的 result tree。仍可显式传 `--path NEW_PATH`（目标必须不存在），此时不创建会话。不得向验证者提供其他角色或其他轮次的会话目录与材料，也不要把提交草稿、开发记录或账本配置放在邻近目录；审阅工作树的 `.git` 仍指向源 clone，需在交付任务中明确禁止验证者沿其访问 clone 或 `.grounds/`。
3. 启动新的验证者 Agent，只提供盲验 Context、审阅工作树路径、封存契约，以及执行不改源码的本地测试权限。盲验时不提供 Grounds 账本凭据、服务管理员或其他任务的数据库凭据、通用 Grounds 查询工具、开发记录、作者声明、同级 Candidates 或预期结论。
4. 要求验证者自身稳定的 `GROUNDS_AGENT_ID` 和 `GROUNDS_AGENT_NAME`；与已记录开发者归属比较，相同则停止。
5. 宿主无法创建并继续隔离验证者时，停止自动独立验证；保留盲验材料并人工交接，不将开发者自验作为独立 Verification 提交。

**隔离的真实边界。** 目录布局不构成权限隔离。可信 macOS/Linux host 不承诺文件、网络或同 UID 进程隔离；需要材料隔离的任务不能以 host 冒充。选择 Docker 时，必须将完整验证者 Agent 及其工具放入容器，只交付单一候选代码树、该角色/阶段允许的固定材料和私有运行空间；宿主只派发测试不等于验证者在容器中。候选代码、文档和注释完整保留，不为盲验改写树；完整开发历史、Git 提交文案、树外作者报告和自测结论分别处理，盲验不额外交付。查询工具遵循同一边界，不删除或改写原 Git 归档。

外层协调者负责创建、启动、续接原验证者上下文与盲验/对照推进；环境只执行明确请求。阶段间按声明保留必要私有材料，单条命令结束不等于整轮验证结束。所选 Agent CLI 无法续接同一上下文时报告受阻，不以新会话冒充原验证者，不自动重跑盲验。

验证者离线填写报告、固定盲验并生成签名 handoff；协调者通过既有 CLI 提交，验证者不因此获得真实账本配置、凭据或通用查询权。代码由 Git 保存，正式 Verification 由 Grounds 保存；上报失败保留重试材料。执行停止、成果和报告交接以及安全收尾分别核对，环境回收成功不代表验证或提交成功。

协调者执行物化，让盲验者不需要账本访问：

```bash
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$SOURCE_CLONE" -- \
  candidate materialize CANDIDATE_ID --mode review
```

返回的 `data.target_path` 作为 `REVIEW_WORKTREE`，`data.review_session_id` 记为 `REVIEW_SESSION_ID`；会话目录 `REVIEW_SESSION_DIR` 是 `REVIEW_WORKTREE` 的父目录。

<a id="run-record"></a>

### 运行记录（可选但推荐）

`grounds_agent.py invoke -- verification run start CANDIDATE_ID` 把上面几步合并成一条标准准备入口：它为同一 Candidate、result tree、审阅会话与角色物化审阅工作树，写入盲验 Context 与报告骨架到会话目录（与 `worktree/` 同级，不进入被校验的树），并开始一条**验证运行记录**。返回 `data.run_id`、`data.review_session_id` 与 `data.paths.{review_worktree,blind_context,report_skeleton}`。该记录只记阶段与耗时，不产生验收结论，也不改变本流程的任何信任规则；不使用时按上面的分步命令照旧。

运行记录把一次验证的阶段和时间写进账本（复用既有 `runtime_operation` 运行记录，无需 SQL 迁移），供协调者分辨阶段耗时、命令执行与等待，而不必回读整段聊天：

helper 为 `run start` 注入协调者的 Agent 身份；该命令不接受调用者的 operation ID，返回未知或暂时存储失败时也不自动重试创建。先用 `run list --candidate CANDIDATE_ID`、`run show RUN_ID` 核对已记录的会话，再决定如何接续，不能直接创建另一轮。后续 show/list/stage/freeze 等入口使用既有运行身份，不要求宿主配置人的 Git user.name/email，也不接受 helper 追加身份参数。

```bash
GA="python3 ${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py"
$GA invoke --cwd "$SOURCE_CLONE" -- verification run start CANDIDATE_ID   # 也许 --role quality
$GA invoke --cwd "$SOURCE_CLONE" -- verification run show RUN_ID          # 摘要与 next_step
```

- 阶段为 `prepare`/`blind`/`freeze`/`reconcile`/`handoff`/`submit`/`wait`。协调者阶段为 `blind`、`reconcile`、`wait`（其工作不可由 CLI 观测），由协调者用 `verification run stage RUN_ID --stage <S> --state running` 进入、以 `succeeded|failed|blocked|skipped|unknown` 结束；入口自闭环阶段为 `prepare`、`freeze`、`handoff`、`submit`，由各自入口进入并闭合，协调者只能强制记 `failed`/`unknown`，不得直接记 `succeeded` 或 `running`。未进入的阶段不标为完成，也不产生虚假耗时。
- 报告骨架生成后由盲验者填写；冻结前用 `verification run stage RUN_ID --stage blind --state running` 进入盲验、完成后 `--state succeeded`，再用 `verification run freeze RUN_ID --independent-digest sha256:...` 固定独立判断摘要。绑定同一会话的 `verification context --phase reconcile` 会**拒绝**在盲验结束并冻结之前交付对照材料。
- `verification run handoff RUN_ID --report-digest sha256:... --state signed` 记录签名交接；成功经公共接口提交后，`verification run submit RUN_ID --state confirmed --operation-id UUID --verification VERIFICATION_ID` 记录提交，或由绑定同一 Candidate/角色/盲验摘要的 `verification submit` 自动记录。提交结果未知时用 `--state unknown` 保留原操作身份，不要另建运行记录或重复入账。
- 运行记录里的命令只保留入口名与 argv 摘要，不保存原始参数；未经过入口的时间标为未采集，不据此推断验证者在思考或空闲。

获取盲验 Context 时传 `--review-session "$REVIEW_SESSION_ID"`（或用 `--out PATH` 指定文件，二者不能同时使用）：CLI 把 `data.context` 对象单独写入会话目录的固定文件（契约角色 `context-blind-contract.json`，质量角色 `context-blind-quality.json`，对照阶段为 `context-reconcile-*.json`），并在 `data.output_path` 返回路径，把它作为 `BLIND_CONTEXT_JSON`；文件只含 Context 对象，不含整个 CLI 返回结构。不传这两个选项时只打印到 stdout，不落盘。从该盲验 Context 离线生成包含完整评估的可编辑草稿。helper 调用原生 CLI，只提取 report，写入 mode-0600 文件，不使用 Grounds 配置或数据库凭据：

```bash
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" \
  draft verification --cwd "$REVIEW_WORKTREE" --context "$BLIND_CONTEXT_JSON" --output "$VERIFICATION_REPORT_JSON"
```

<a id="blind-phase"></a>

## 盲验阶段

- 中文用户或中文 Issue 的独立、对照和最终说明使用中文；代码标识、命令、原始 Evidence 不变。生成草稿传 `--content-language zh-CN`，`verification handoff` 与 `verification submit` 也传同一参数。语言检查在签名前和入库前执行，不改变报告或先盲验后对照的顺序。确需英文的段落被提示时，说明字段，handoff/submit 都传准确的 `--language-override-reason "..."`；CLI 输出 override 警告。
- 检查物化源码，独立测试每个 Criterion。
- 使用这个固定 Candidate 的独立审阅工作树，不读取开发分支最新文件；作者后续推进不改变本次代码。不能因为 Git 分支复用就向盲验者附带作者 commit 消息、开发记录或其他报告。固定代码树与原 Git 历史分别交付，不因候选已归档就向盲验者开放完整历史；Git 编号/历史敏感的标准需要对应材料，不足时明确 inconclusive，不静默跳过仍称全通过。代码目录不同不能称本机权限/进程也被隔离。
- 只编辑生成草稿，不从文字评估重建。为每个 Criterion 填 `independent.verdict`、说明及类型化真实 Evidence。
- 允许 `qualified`、`rejected`、`inconclusive`，不根据提交者推断结论。
- 获取 reconcile Context 前持久化完整 independent 部分，保存不可变副本或摘要，声明盲验评估已固定；之后对照不能改写。

<a id="reconcile-phase"></a>

## 对照阶段

所有独立部分固定后，协调者获取 `verification context CANDIDATE_ID --phase reconcile --review-session "$REVIEW_SESSION_ID"`，只交给同一个验证者。核对 Candidate ID、result-tree OID、blind-context digest 与盲验完全相同。对照时 Grounds 账本凭据、服务管理员或其他任务数据库凭据和通用 Grounds 查询工具仍不可用。

针对每个 Criterion：

- 将作者声明分类为 `corroborated`、`contradicted` 或 `not_determined`，说明原因。
- 设置 final 结论和说明；与 independent 不同时，说明对照中发现的证据。
- 原 independent 部分逐字保留。

仍有 `TODO:` 或目标/Criterion 覆盖不准确时拒绝 handoff。验证者使用自身稳定 Agent 身份，离线生成签名交接；提取 handoff 对象，不编辑。临时 Ed25519 签名用于发现固定后的变化，不证明自述 Agent ID 背后的真实身份。

```bash
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$REVIEW_WORKTREE" -- \
  verification handoff --file "$VERIFICATION_REPORT_JSON" --review-session "$REVIEW_SESSION_ID" \
  --agent-id "$GROUNDS_AGENT_ID" --agent-name "$GROUNDS_AGENT_NAME"
```

签名后的 handoff 对象写入会话目录的 `handoff-contract.json`，路径在 `data.output_path`，作为 `VERIFICATION_HANDOFF_JSON`。报告草稿 `VERIFICATION_REPORT_JSON` 仍是临时产物，不改变“成功后删除临时 report/envelope”。

只向协调者返回固定的 handoff。协调者使用账本访问提交；该路径不接受验证者凭据或身份覆盖：

```bash
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$SOURCE_CLONE" -- \
  verification submit CANDIDATE_ID --handoff "$VERIFICATION_HANDOFF_JSON"
```

成功后删除临时 report/envelope；失败材料和已提交 handoff 保留以供审计。报告 Verification ID 与派生整体结论，不宣称签名在密码学上证明了验证者独立性。

在[开发—验证—修复闭环](auto-repair.md)中，每轮都按本流程创建新的验证者，不复用前几轮验证者，也不向其提供前几轮报告、修复简报或轮次信息；提交后回到闭环流程判定停止条件。

<a id="ultra-quality-review"></a>

## ultra：代码质量评审

ultra 需要**三个互不相同**的身份：Candidate 开发者、契约验收 Agent、质量评审 Agent，Agent ID 两两不同（CLI 在提交时强制检查）。

**隔离。** 协调者创建两个新的验证者 Agent，按上文“建立隔离”各自物化**独立的**审阅工作树（每个验证者各执行一次 materialize，得到不同的 `review_session_id`，互不共享），并遵守相同的材料边界：

- 契约验收 Agent 完全按上文 normal 流程工作，不获得质量评审的任何内容。
- 质量评审 Agent 只获得质量盲评 Context、审阅工作树路径和封存契约，以及执行不改源码的本地测试权限；不得获得开发记录、作者声明、契约验收的结论或数据库凭据。
- 宿主无法创建并继续**两个**互相隔离的验收 Agent 时，停止自动 ultra 验收并人工交接。不得降级为 normal，也不得由同一个 Agent 兼任两个角色，不得提交只含一部分的结果。

**质量盲评。** 获取质量盲评 Context，并离线生成草稿：

```bash
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$SOURCE_CLONE" -- \
  verification context CANDIDATE_ID --phase blind --role quality --review-session "$QUALITY_REVIEW_SESSION_ID"
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" \
  draft verification --cwd "$REVIEW_WORKTREE" --context "$QUALITY_BLIND_CONTEXT_JSON" --output "$QUALITY_REPORT_JSON"
```

`data.output_path` 是质量盲评 Context 的落盘路径，作为 `QUALITY_BLIND_CONTEXT_JSON`。

`data.context` 的格式为 `patchledger.quality-context/v1`，含固定的质量维度集合（`rubric`，第一版 `grounds.quality-rubric/v1`：`conciseness`、`testability`、`abstraction`、`readability`、`conventions`、`test_quality`）。草稿已列出全部维度，必须逐个维度填写：

- **只评审 Candidate 相对 Baseline 引入的改动**。Baseline 中已存在、本次未触及的问题最多记为 `non_blocking`。
- 每个维度的 `independent` 含结论、说明、`findings` 与类型化 `evidence`；`findings` 每条有 `severity`（`blocking` 或 `non_blocking`）和说明。
- `blocking` 发现必须有 `location`（`path`，可选 `line`），且 `path` 必须是 Candidate 改动的文件；没有代码位置的不是 blocking。
- 某阶段存在 blocking 发现时该阶段该维度必须为 `rejected`；没有 blocking 发现时不得为 `rejected`。改进建议、风格偏好记为 `non_blocking`，不阻止通过。无法判断时用 `inconclusive` 并说明原因。
- 只编辑生成草稿，不从文字评估重建；中文工作使用 `--content-language zh-CN`，规则与 normal 相同。

**固定盲评。** 获取对照 Context 前，计算并保存质量部分 independent 内容的摘要，同时保存不可变副本：

```bash
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$REVIEW_WORKTREE" -- \
  verification independent-digest --file "$QUALITY_REPORT_JSON"
```

契约部分也可用同一命令固定。之后对照阶段不得改写 independent 内容。

**质量对照。** 只把对照 Context 交给同一个质量评审 Agent：

```bash
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$SOURCE_CLONE" -- \
  verification context CANDIDATE_ID --phase reconcile --role quality --review-session "$QUALITY_REVIEW_SESSION_ID"
```

对照 Context 只含相同的身份锚点、作者 `submission_explanation` 与 Change Rationales（旧格式 Candidate 标明 `not_recorded`），不含 Claims、自验或任何验证者结论。质量评审 Agent 据此填写 `reconciliation` 与 `final`，`final` 与 `independent` 结论不同的维度须说明原因；independent 部分逐字保留。

**签名交接。** 质量评审 Agent 用自身稳定的 Agent 身份，以固定的摘要生成签名交接；摘要不一致说明盲评内容在固定后被改动，CLI 会拒绝：

```bash
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$REVIEW_WORKTREE" -- \
  verification handoff --file "$QUALITY_REPORT_JSON" \
  --agent-id "$QUALITY_AGENT_ID" --agent-name "$QUALITY_AGENT_NAME" \
  --independent-digest "$FIXED_INDEPENDENT_DIGEST" --review-session "$QUALITY_REVIEW_SESSION_ID"
```

质量交接写入质量会话目录的 `handoff-quality.json`，`data.output_path` 即 `QUALITY_HANDOFF_JSON`，只向协调者返回交接。质量评审 Agent 的 `QUALITY_REVIEW_SESSION_ID` 来自它自己的 materialize，不与契约验收 Agent 共用。契约验收 Agent 同时按上文生成自己的 `VERIFICATION_HANDOFF_JSON`。

**一次提交。** 协调者收齐两份交接后只提交一次；缺少任一部分、签名无效、两部分绑定的 Candidate/result tree/blind digest 不一致或身份冲突时整体拒绝且不写入：

```bash
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$SOURCE_CLONE" -- \
  verification submit CANDIDATE_ID --mode ultra \
  --handoff "$VERIFICATION_HANDOFF_JSON" --quality-handoff "$QUALITY_HANDOFF_JSON"
```

成功后报告 Verification ID、`mode`、整体结论和 Candidate Standing；整体结论取契约部分与质量部分中更保守者。失败材料和已提交交接保留以供审计。`verification show` 返回契约与质量两部分的完整内容和两方归属，`attribution` 仍表示契约验收者，质量评审者在 `quality.attribution`。
