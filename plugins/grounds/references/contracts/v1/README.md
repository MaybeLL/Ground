<a id="grounds-v1-contracts"></a>

# Grounds v1 契约

CandidateSubmission v1/v2 的 Criterion Claim 支持可选 `self_verification`（自我验证）：`status` 为 satisfied / partially_satisfied / not_satisfied / inconclusive / not_verified，必须填写结论说明 `explanation`；实际检查还须有 `method` 和同条标准的非空 `evidence`，not_verified 不含 method。缺字段表示未记录，不自动补成功。ClaimRecord 的可选 `self_verification_summary` 为逐状态计数，不是独立验证结论。存储需要 schema 15；只读命令不会自动迁移。

本目录是版本化机器契约真源。当前源码要求 SQL schema 23；历史 CLI 0.2.29 要求 schema 20（追加目标分支和 DevRun/Candidate 基础提交）；历史 0.2.26 引入 schema 19 的 ultra 质量评审存储，更早受管执行版本使用 schema 18；新库使用当前 schema，旧库只在获得明确授权后通过 `grounds db migrate` 升级至已安装 CLI 要求的版本。下文 schema 12、14、15 等数字表示相应能力引入的历史版本，不表示当前 CLI 能直接打开这些旧库；只读命令不会自动迁移。

Requirement/Issue 的默认公开 authoring interface 是 `<数据根>/drafts/<账本身份>/` 下的 JSON 契约草稿（`grounds.authoring-workspace/v2`）；人通过 `contract render --workspace NAME` 的统一 HTML 阅读、区块编辑并保存（`workspace edit` 为兼容入口），Agent 通过 `draft read/save` 读写 draft。manifest、base snapshot、pending journal 和回执属于 CLI 管理的本地协议，不直接手改。旧 Markdown 工作区保持兼容，新建时仅由显式 `--format markdown` 选择，迁移使用 `draft migrate`。下列 Requirement/Issue Schema 定义 JSON draft 或旧 Markdown 解析后交给 Work Module 的规范输入，不是独立的公开写命令；JSON 发布须绑定已审阅的 `source.workspace_version` 为 `--expected-version`。

| 契约 | Schema | 方向 |
|---|---|---|
| 本地 JSON authoring Workspace | [`authoring-workspace.schema.json`](authoring-workspace.schema.json) | CLI 管理结构；Agent 只读写 draft |
| 代码 Workspace 配置、实例与路线准备（本开发树，执行禁用） | [`code-workspace.schema.json`](code-workspace.schema.json) | CLI → 调用方；完整快照、固定基线、持久准备占用及可选DevRun关联；准入沿用preflight协议 |
| 服务资源回收（本开发树） | [`service-cleanup.schema.json`](service-cleanup.schema.json) | 已结束实例的服务预览、日志归档和容器/网络回收；保留卷冷导出、独立新卷恢复及启动/目录与可选固定表行数检查历史、本机阶段及未完成尝试显式停止、保留卷清单与只读回收预览、原卷重新导出与固定旧归档比较、已完成恢复卷的新数据冷归档及来源追溯；持久受管禁写service-volume-retire及预览门禁状态；原导出restore_status固定not_verified，数据卷/镜像保留 |
| 固定构建材料与镜像准备（本开发树） | [`repository-image.schema.json`](repository-image.schema.json) | 有界Git材料字节快照、独立离线classic构建、原ID恢复及按输入复用、协作取消、终结失败和临时输入回收；环境可关联preparation_id |
| Repo环境不可变版本（本开发树） | [`repository-environment.schema.json`](repository-environment.schema.json) | Repo关联、固定本地镜像与可选路线私有PostgreSQL；保存不改变默认 |
| Repo环境检查与默认（本开发树） | [`environment-control.schema.json`](environment-control.schema.json) | 固定只读探针历史、显式CAS默认选择；执行保存默认来源与环境快照 |
| 路线容器执行（本开发树） | [`code-execution.schema.json`](code-execution.schema.json) | 固定启动输入 → CLI；执行记录、显式实时观察与前台控制器终态 → 调用方 |
| 本地配置 YAML | [`config.schema.json`](config.schema.json) | 人/CLI → CLI |
| Requirement 规范输入 | [`requirement.schema.json`](requirement.schema.json) | Workspace 解析器 → Work Module |
| Issue 规范输入 | [`issue.schema.json`](issue.schema.json) | Workspace 解析器 → Work Module |
| 原子编写输入（内部） | [`quickstart.schema.json`](quickstart.schema.json) | Work Module 内部兼容 |
| DevRunContext | [`devrun-context.schema.json`](devrun-context.schema.json) | CLI → 开发者 Agent |
| CandidateSubmission | [`candidate-submission.schema.json`](candidate-submission.schema.json) | 开发者 Agent → CLI |
| VerificationContext | [`verification-context.schema.json`](verification-context.schema.json) | CLI → 验证者 |
| VerificationReport | [`verification-report.schema.json`](verification-report.schema.json) | 验证者 → CLI |
| VerificationHandoff | [`verification-handoff.schema.json`](verification-handoff.schema.json) | 验证者 → 协调者 → CLI |
| QualityContext（ultra） | [`quality-context.schema.json`](quality-context.schema.json) | CLI → 质量评审 Agent |
| QualityReviewReport（ultra） | [`quality-review-report.schema.json`](quality-review-report.schema.json) | 质量评审 Agent → CLI |
| QualityReviewHandoff（ultra） | [`quality-review-handoff.schema.json`](quality-review-handoff.schema.json) | 质量评审 Agent → 协调者 → CLI |
| CLI 返回结构 | [`cli-envelope.schema.json`](cli-envelope.schema.json) | CLI → 调用者/幂等重放 |
| 命令结果 | [`command-results.schema.json`](command-results.schema.json) | CLI 成功 `data` |
| 版本化环境声明 | [`environment-definition.schema.json`](environment-definition.schema.json) | `.grounds/environments/<name>.yaml`；仅非敏感声明 |
| 本机环境结果（不写业务账本） | [`environment.schema.json`](environment.schema.json) | `grounds env` 成功 `data`；实例与执行记录只在本机运行时目录 |
| 使用现场候选／本机 QA 草稿 | [`qa-candidate.schema.json`](qa-candidate.schema.json), [`qa-source-index.schema.json`](qa-source-index.schema.json), [`qa-draft.schema.json`](qa-draft.schema.json), [`qa-draft-edit.schema.json`](qa-draft-edit.schema.json), [`qa-draft-result.schema.json`](qa-draft-result.schema.json) | KB 公共交接 → 本机 Grounds CLI/TUI |
| QA 草稿发布目标／固定来源包 | [`qa-draft-target.schema.json`](qa-draft-target.schema.json), [`qa-source-package.schema.json`](qa-source-package.schema.json) | 人工确认 → 既有评测账本/blob |
| 待提取来源线索 | [`source-clue.schema.json`](source-clue.schema.json), [`source-clue-result.schema.json`](source-clue-result.schema.json) | KB 显式交接有界元数据 → 本机 CLI/TUI；不含正文、不创建 QA |
| 评测摘要列表 | [`eval-list.schema.json`](eval-list.schema.json) | `eval KIND list --view summary` `data` |
| 详情/查询结果 | [`query-results.schema.json`](query-results.schema.json) | show/compare/ledger `data` |
| 审阅追溯 | [`query-results.schema.json`](query-results.schema.json) `reviewTrace` | CLI → 人/审阅 Agent |
| 稳定错误 | [`error.schema.json`](error.schema.json), [`errors.md`](errors.md) | CLI 失败 `error` |
| 历史/固定起点盲验对象 | [`blind-subject.schema.json`](blind-subject.schema.json) | CLI 内部稳定 v1 哈希投影 |
| 目标 Candidate 盲验对象 | [`blind-subject-v2.schema.json`](blind-subject-v2.schema.json) | 同时绑定契约快照、目标声明与自身基础 |
| DevRun 可恢复同步 | [`devrun-sync.schema.json`](devrun-sync.schema.json) | CLI 同步状态/记录与 Review 投影 |
| 交付门禁、单次授权与落地 | [`integration.schema.json`](integration.schema.json) | CLI → 调用者；观察/授权/消费/落地追加审计 |
| 目标新鲜度与契约适用性预检 | [`preflight.schema.json`](preflight.schema.json) | `preflight observe/assess/show`、`devrun.admit`、`devrun.show`/`issue.show` 的预检读模型 |

[`common.schema.json`](common.schema.json) 定义共享的 ID、digest、Git OID、Evidence、目标和 Claim 结构。Schema 使用 JSON Schema Draft 2020-12。

独立的 `grounds help --json` 也返回同一 CLI envelope；其 `patchledger.result.help/v1` command result 只包含版本化 usage 摘要，不读取业务数据库。

<a id="local-config"></a>

## 本地配置

`grounds init` 只有在成功连接并把目标识别为兼容账本或明确初始化空数据库之后，才写出符合 [`config.schema.json`](config.schema.json) 的 canonical YAML。已有文件必须通过 `--reconfigure` 才能替换；写入使用同目录临时文件、仅当前用户权限和 atomic rename，失败不能留下部分配置。交互输入与等价 flags 必须生成相同的数据模型，非 TTY、`--json` 和 `--non-interactive` 都禁止 prompt。

`expected_database_id` 是 CLI 在成功连接后 pin 的安全字段，不由用户猜测。Keychain locator 从 driver、host/port/database/username 的规范连接身份派生；配置只记录 `source: keychain`。环境变量模式只记录固定变量名，不记录变量值。

## 解码与规范表示

- JSON 是规范数据模型；允许 YAML 的输入命令先解码为相同 JSON 类型再校验。
- `config.yaml` 最大 64 KiB；其余 UTF-8 输入文件默认最大 2 MiB；使用现场 candidate／source-package JSON 单独有 32 MiB 有界上限，严格 UTF-8／重复 key 校验及来源期限核验；Candidate patch 不属于 CandidateSubmission，使用独立的 32 MiB artifact 限制。
- JSON/YAML 的重复 object key、YAML anchor/alias、merge key、自定义 tag、非字符串 object key，以及非有限数值在进入 Schema 前拒绝。
- 除 Schema 明示外，未知字段和 `null` 都非法。optional 字段以缺省表达，不用 `null`。
- Local config 的 SQLite path 与 MySQL/PostgreSQL optional CA file 必须在 Schema 校验后通过平台路径语义检查；CLI 写出的路径是解析后的绝对路径。密码值不属于 config 数据模型，Keychain locator 由连接身份确定（带引擎 scheme），environment source 对 MySQL 只能引用 `GROUNDS_MYSQL_PASSWORD`、对 PostgreSQL 只能引用 `GROUNDS_POSTGRES_PASSWORD`。
- 字符串按原始 Unicode code points 保存，不做隐式 trim 或 Unicode normalization；空白是否有意义由具体字段约束决定。
- Entity ID 和 operation ID 是完整、lowercase RFC 9562 UUIDv7 字符串。人类短标签不能进入机器契约；Attribution 中的 Agent ID 是调用者命名的稳定 provenance 字符串，不是领域 entity ID。
- SHA-256 写成 lowercase `sha256:<64 hex>`；Git object ID 写成 `sha1:<40 hex>` 或 `sha256:<64 hex>`，不靠长度隐式猜算法。
- Git path 以原始 bytes 的 base64 `path_bytes` 表示，并提供仅用于显示的 `display_path`；业务比较使用 bytes。
- Candidate manifest 的 `display_path` 与 VerificationContext 的 `canonical_remote_at_submission` 都在 Candidate submit 时固化为展示快照；Repository move 或 renderer 变化不能改写它们。它们不参与 blind digest，raw path bytes 与 Repository ID 才是稳定语义。
- 实现必须执行严格 UUIDv7、RFC 3339 UTC timestamp 和 base64 decode 校验；不能假设 JSON Schema validator 会执行 `format` 或 `contentEncoding` annotation。

## 数组语义

Requirement normalized input 中作者定义的 Outcomes 和 Decisions，以及 Issue normalized input 中的 Goals、Constraints、Criteria、Guidance 和 Intent Links，都是有序序列；其 ordinal 会被持久化并进入请求语义。Workspace Markdown 用 `[outcome-N]` / `[decision-N]` 和 `Traces To` 暴露 Intent Link；机器值以 `{type, ordinal}` 表示，ordinal 从 1 开始且只在 Issue Version 精确绑定的 Requirement Version 内解析。Outcome、Decision 和 Intent Link 都是 Revision-owned values，不生成持久 ID；其余机器契约中的 identity-bearing 数组视为集合。Goal、Constraint、Criterion、Claim、Assessment、Evidence digest 和 Verification ID 的业务身份不得重复。JSON Schema 无法表达“恰好等于某个 Context 的 ID 集”，因此 Work Module 还必须检查：

- CandidateSubmission v1/v2 的 Claim target 集恰好覆盖 DevRunContext 的全部 Goal/Constraint；v2 额外携带 Change Index fingerprint 和不可变 Change Rationales。
- 每个 Intent Link 的 type/ordinal 必须解析到绑定 Requirement Version 的现存 Outcome 或 Decision，同一 Goal/Constraint 内不得重复；缺失 link 不得由读取端推断。
- Change Index 由完整 binary/full-index patch 确定性派生：文本变化使用 hunk unit，没有 hunk 的 binary、rename-only、mode-only 等变化使用 file unit。v2 提交的 `patch_digest`/`units_digest` 必须与重新捕获的 Artifact 完全一致。
- CandidateSubmission v2 每个 Change Unit 必须至少被一个 Change Rationale 覆盖；每个 `change_ref` 必须存在，每个 Criterion `target_ref` 必须属于 Candidate 绑定的精确 Issue Version。`generated`、`supports`、`incidental` 等分类也不能绕过说明或 Criterion 关联。
- 一个 Change Index 最多 100,000 个 Change Unit；一个 Submission 最多 10,000 条 Change Rationale、100,000 个累计 Change Unit refs 和 200,000 个累计 Criterion refs。单条 Rationale 最多引用 1,000 个 Change Unit 和 200 个 Criterion。
- 每个 Claim 的 Criterion 集恰好覆盖所属 target 的全部 Criteria；
- VerificationReport 的 target/Criterion 集满足同一规则；
- target type 与 ID 的真实所有者一致；
- ultra 验收（`verification submit --mode ultra`）的 QualityReviewReport 必须恰好覆盖 `rubric_version` 的全部维度各一次；某阶段存在 blocking 发现时该阶段该维度结论必须为 `rejected`，没有 blocking 发现时不得为 `rejected`；blocking 发现必须有 `location`，且 `location.path` 须属于 Candidate 的改动文件（由提交时校验，Schema 只约束形状）；
- ultra 的契约部分与质量部分必须绑定同一 Candidate、result tree 和 blind context digest，开发者、契约验证者、质量评审者的 Agent ID 两两不同，两部分一起写入或都不写入；整体 verdict 取两部分中更保守者；`verification list/show`、Review 与 refinement Context 的 `mode` 为 `normal`（无质量部分，包括所有历史报告）或 `ultra`。Verification 集合 digest 的条目键不因此改变；
- refinement 中每个冻结 Verification 属于父 Candidate，且 ID 不重复。
- DevRunContext、Verification blind Context、blind-subject 投影和 Issue detail 中的 `issue.requirement` 必须等于同一结构内 Requirement 的稳定 `id` 与公开 `version`；
- Issue 创建/修订绑定的 RequirementRevision 必须属于该 Issue 不可变的 Requirement。

集合数组的顺序不影响上述业务语义。Work Module 生成 canonical request 时，按 `(target_type, target_id)`、`criterion_id` 等身份字段 bytewise 排序；Requirement/Issue YAML 的作者序列和 Evidence 顺序原样保留。Context 输出按持久化 ordinal 输出 Requirement 与 Issue 内容，file manifest 按 raw path bytes 排序，其余集合按技术 ID bytewise 排序。

## 结构化 Decision（可选增强）

Requirement `format: 1` 的 Decision 继续接受仅有 `statement` 和可选 `rationale` 的旧输入。共享定义为 `common.schema.json#/$defs/decision`。新增 `context`、`options`、`chosen_option`、`trade_offs`、`consequences` 均可选；缺失字段不补默认值。Options 一旦提供须包含 1–100 项并指定其中一个唯一 key；key 匹配 `[a-z][a-z0-9-]*`，最多 64 字符。域校验额外检查 key 唯一性与 chosen_option 引用，JSON Schema 只检查结构和字段依赖。

所有新增列表按作者顺序保留，最多 100 项。短文本为 1–4096 字符，Decision context 和 Trade-off reason 为 1–16384 字符；旧 rationale 仍允许空串。Consequence kind 为 benefit、obligation、risk 或 limitation，只表达预期，不自动创建验收要求。旧 CLI 不保证能读取增强文件；这些存储字段在 schema 12 引入，现行数据库版本要求与显式迁移规则见本页开头。

旧 Markdown 工作区示例（显式选择旧格式时使用，不是独立 YAML 合同文件）：

````markdown
### [decision-1] 内部通信采用 gRPC

#### Rationale

接口一致性比工具链成本更重要。

#### Context

多个内部服务共享接口契约。

#### Details

```yaml
options:
  - key: rest
    description: REST + JSON
    benefits: [调试直观]
  - key: grpc
    description: gRPC + Protobuf
    benefits: [生成强类型客户端]
    costs: [学习协议工具链]
chosen_option: grpc
trade_offs:
  - gain: 统一类型契约
    sacrifice: 工具链维护成本
    reason: 减少跨服务接口漂移
consequences:
  - kind: obligation
    statement: 维护协议兼容规则
```
````

`Details` 只能包含一个 YAML 代码块及上述四个字段，不接受游离正文；Context 和 Rationale 使用各自小节。决策内容变化通过新的 Requirement Version 发布，Intent Link 仍引用完整的 decision-N。

## Candidate 工件与 Git 对象标识

OID（Object ID）是 Git 对象标识，Grounds 使用 `sha1:` 加 40 位或 `sha256:` 加 64 位十六进制。`base_commit` 引用精确起点提交；`result_tree_oid` 是预期结果树的标识，不是整棵树的序列化内容，也不是工作目录路径。`patch_digest` 是完整 patch 字节的 SHA-256 摘要，不能用摘要代替 patch 重放。

账本保存完整 canonical 二进制 patch、摘要、结果树 OID 和文件清单，不归档整个 Baseline 或 Git 结果树对象库。目标 Candidate 的 `base_commit_source: candidate` 表示自身基础，历史无自身基础对象返回 `issue_version_baseline`。复原需要可得的精确有效基础对象：加载其树，应用 patch，生成树并比较 `result_tree_oid`；不一致即拒绝。恢复范围是捕获的 Git 代码快照，不包括未跟踪且被忽略的文件、数据库或进程状态。经核对和授权可清理物化目录及可再生成的本地副本，不能据此删除账本工件或忽视 Baseline 可得性。字段和 Schema 未因本说明变化。

## 大小与计数限制

- Summary 500 字符；statement/Outcome 4,096；Context/explanation/brief 65,536；rationale 16,384；Evidence command 4,096；单条 Evidence output 65,536。一个 v2 Submission 的全部 rationale/alternative/risk 文本合计最大 1 MiB。
- 每个 RequirementRevision 有 1–100 个 Outcomes 和最多 100 个 Decisions；每个 IssueRevision 最多 100 Goals 和 100 Constraints；每个 target 最多 50 Criteria 与 50 Guidance；每条 Criterion 最多 8 条 Evidence。
- 一个 CandidateSubmission 或 VerificationReport 的全部 UTF-8 Evidence 文本合计最大 1 MiB，即使单字段均未超限也一样。
- DevRunContext 序列化后最大 8 MiB。创建/修订 Issue 时以 canonical remote 的 Schema 最大编码空间预检基础 Context，保证未来至少能创建独立 DevRun；`devrun start` 固化实际 remote 展示快照并对 brief/refinement 后的完整 Context 再检查。refinement 最多冻结 256 个 Verification ID/摘要；超过时拒绝该操作，仍可创建不含 refinement 的独立 DevRun。默认只嵌入 aggregate Criterion Standing，不嵌入完整报告，调用者可从冻结集合中一次显式请求最多 2 份完整报告，但仍受 8 MiB 总上限约束。超限报错，不静默截断。
- blind 与 reconcile VerificationContext 各自序列化后最大 8 MiB。Candidate submit 在提交事务前用固定 RequirementRevision、IssueRevision、Candidate-time canonical remote、artifact manifest/display snapshots 和 CandidateSubmission 预生成两种投影并执行大小门禁；无法保证之后生成 Context 时，以 `ARTIFACT_TOO_LARGE` 拒绝 Candidate，而不是接受一个不能验证的产物。Candidate patch bytes 不内联 Context，仍使用独立的 32 MiB artifact 门禁。
- Requirement detail 整个 JSON 最大 8 MiB，每页最多内联 1,000 个当前 IssueRevision 摘要；全量 aggregate 不按页截断。未返回全部 Issue 时必须给出 `issues_omitted` 和 opaque next cursor，完整 Goal/Constraint 转由 Issue detail 返回。
- Candidate detail 和 Candidate comparison 输出各自最大 8 MiB。detail/compare 最多内联 2,000 个 manifest entries 和 256 个 Verification summaries，同时返回总数、完整集合 digest 与显式 `*_omitted`；Candidate detail 提供 opaque next cursor 分页，Comparison 可转到专用 show/list 命令，不静默假装集合完整。
- Review Trace v3 输出最大 8 MiB，内部遍历全部 Verification 分页并内联每份完整报告；`complete: true` 表示集合完整。超过总大小限制时命令整体失败，不返回看似完整的截断结果。位置查询对 v2 Candidate 返回匹配 Change Unit、作者 Rationale 和 coverage；行查询另以 `line_status` 区分真正 added/deleted 的行、hunk context、hunk 外位置和 file-level 无法定位。历史 v1 Candidate 仍以 `not_recorded` 明示尚无逐变更 rationale。
- Comparison text preview 是原字符串前 2,048 Unicode code points，并同时返回完整 UTF-8 string digest 与 `truncated`；manifest 先按 raw path bytes 排序后取前 2,000，Verification summary 按数据库时间、Verification ID 排序后取前 256。Candidate patch 和显式 pairwise diff 每份最多 inline 1 MiB，状态字段区分未请求、大小省略和 binary。
- Candidate materialization 的 `existing` 模式应用到调用者准备的有效基础 worktree（目标流程取 Candidate base，历史回退 Baseline）；`review` 创建 detached worktree，并在该 worktree 专属 Git metadata 中记录 database/Candidate/artifact identity 供 `grounds review` 自动发现；`delivery` 创建分支 worktree。后两者要求显式目标路径且目标不得已存在，失败时清理本次创建的 worktree 和 Delivery 分支，成功时保留未提交变化。CLI 不自动 commit、push 或创建 PR。

这些跨字段限制由 Work Module 校验，不能仅依赖 Schema。

## Digest 与幂等哈希

规范 JSON 使用 RFC 8785 JSON Canonicalization Scheme 编码为 UTF-8 后计算 SHA-256。

- Evidence digest 对 `{command, exit_code, output?}` 计算；缺省 output 与空字符串不同。
- `blind_context_digest` 对不可变投影计算：无自身基础的历史/固定起点 Candidate 使用 [`blind-subject.schema.json`](blind-subject.schema.json) 的 `patchledger.blind-subject/v1`；目标 Candidate 使用 [`blind-subject-v2.schema.json`](blind-subject-v2.schema.json) 的 `patchledger.blind-subject/v2`。v2 额外固定 `base_commit`，`baseline_oid` 仍绑定契约快照，Issue 投影包含封存 `target_branch`；派生 `snapshot_relation` 和作者同步记录/取舍不进入摘要。normal/ultra 及签名报告共用同一候选摘要，外层 Context/Report/Handoff 格式不因此升级。它只包含 contract/hash version、Candidate/RequirementRevision/IssueRevision/Repository identity、Baseline/result-tree/patch digest、完整 sealed Requirement 与 Issue contract 和以 raw path bytes 表示的 manifest；明确排除后来新增的 RequirementRevision、Candidate-time canonical remote/display snapshots、Attribution、时间、reachability warning、压缩/storage metadata 等展示字段。同一 Candidate 因而能稳定重建该摘要；reconcile Context 和 VerificationReport 必须原样携带它。
- `patchledger.blind-subject/v1` 实际发布过两个载荷版本：早于 2026-09-07 写入的 Candidate 哈希原始 `requirement_revision` 与 context 形状的 `issue_revision`，当前版本哈希公开的 Requirement/Issue version。已存储的 `blind_context_digest` 是不可改写的账本事实，因此校验同时接受这两个已发布载荷；新无自身基础 Candidate 使用当前 v1 载荷，目标 Candidate 使用 v2；历史摘要不重写为新载荷。判定依据与后续更改要求见 ADR-0048。
- 工作领域 operation request hash 的根对象为 `{command, payload, attribution, resolved_inputs, concurrency}`：`payload` 是 Schema 校验后的规范语义；`resolved_inputs` 包含绑定的 RequirementRevision、Repository、Baseline，Candidate submit 还包含已捕获 artifact digest 与目标流程的基础提交；`concurrency` 包含 expected version/predecessor。集合数组先按上一节规则排序，再执行 RFC 8785。
- 数据库级自动重试复用同一规范请求和第一次捕获的 artifact bytes，不重新读取 worktree。

## 目标、同步与交付协议

Issue 的可选 `target_branch:{remote,ref}` 随版本封存，remote 最多 256 字符，ref 必须是完整 `refs/heads/...`；发布另核对 Git remote 身份和 fetch 映射。DevRun/Verification Context 保留 `baseline`，目标流程另带 `base_commit` 与派生 `snapshot_relation`。关系为 ahead/diverged/unrelated/unknown；未知不等于相同，关系不证明验收前提仍适用。跨基础 Review/compare 的 `upstream_changes` 区分基础间变化与作者变更，历史不可得标为 unavailable。

同步结果使用 `patchledger.result.devrun-sync/v1`；status 固定当前基础、目标观察、relation 与全部同步记录。同步记录的 phase 为 reserved/prepared/applying/resolving/completing/abandoning/completed/abandoned；开始使用 DevRun 版本，complete/abandon 使用同步记录版本。恢复固定原 host/directory，保留原始 index/文件、冲突 decisions 与后续编辑，未完成同步阻止捕获/清理。数据形状不证明文件已成功恢复；reconcile/show 与原机器材料仍须核对。

新代码 Workspace 路线沿用上述同步结果，不新增 SQL schema。必须从登记的路线根目录、执行已停止的准备窗口操作；运行/暂停执行和其他未决 Git 请求均不允许同步。Workspace 基线保持固定，路线 base_commit 绑定创建时 initial_base_commit；同步推进 DevRun 当前 base_commit，并使旧准入失效。sync-status 不伪造旧 local_worktree 状态；该可选字段在新路线结果中省略。冲突由可信宿主编辑/暂存后提供完整 decisions，当前容器通道不接同步。恢复目录与原 sync 绑定；终态前保留独占及恢复材料。Candidate、回收和新实例续作沿用候选自己的当前 base，不能替换成上下文的初始基线。

`patchledger.result.integration/v1` 返回追加 record（gate/authorization/consumption/landing）及适用时的 authorization_state。gate 分开核对目标、源提交、Selection 与 Verification；ready 不代表 qualified，离线观察必为 unknown。只有刷新后单独目标前进导致 expired 才允许用户明确接受一次降级，授权绑定固定 Candidate/Selection/源/目标，consume 再刷新核对且只能消费一次，不执行 merge。landing 检查可信身份、首父位置、父提交及树；same_content_different_base 和 merge_landing 不自动取得 exact Delivery Link。详细流程与字段见总设计 §4.4、§11.3、§11.6。

## 目标新鲜度与契约适用性预检

目标流程在定义、发布和开工前使用 `preflight`。`preflight observe --phase definition|publish|start [--refresh]` 记录一次不可变的观察：`start` 绑定 Issue/IssueRevision，`publish` 绑定 reviewed Workspace 版本与目标 Issue 草稿的规范化内容摘要，`definition` 绑定显式 repository/remote/target。`observation.refreshed` 与 `observation.commit` 来自真实 `--refresh`；刷新失败记为 `refresh_failed` 且不带 commit，绝不把本地跟踪引用当成远端最新。`preflight assess --observation ID --file JSON` 记录作者判定（applicable/revision_required/unknown）；记录作者始终是写命令的 Attribution，文件若另带 author 必须与之规范化相等。`preflight show ID` 回读记录。

`data.result_type` 分别为 `grounds.result.preflight-observation/v1`、`grounds.result.preflight-assessment/v1`、`grounds.result.preflight/v1`，`devrun.admit` 返回 `grounds.result.preflight-admission/v1`。两处读模型 `devrun.show` 与 `issue.show` 的 `preflight`/`board.preflight` 只声明 `state`（missing/preparing/admitted）、`code`、`next_commands` 等可操作信息，历史无目标与固定起点流程不出现该字段。所有发布观察均绑定完整规范化 `content_digest`；JSON Workspace 还同时绑定 `scope_digest`（已审阅的 Workspace 版本），两个摘要均须匹配，不能互相替代。旧 Markdown 发布绑定其规范化内容，不伪造 JSON 版本。延续开发的 `observe --phase start --dev-run ID` 另固定实际 HEAD、index/工作树指纹、父成果、Run 版本及同步依据，准入时在本地与SQL围栏内重新核对。结论不证明 Agent 论证正确，也不等同独立验证。

## 派生值与重放

CandidateSubmission 不提交 Candidate ID、artifact bytes、result tree 或 verdict。v2 的 `change_index` 只提交 Artifact/units fingerprint，Change Units 由 CLI 重建而非由作者声明。VerificationReport 也不提交 target/overall verdict：Work Module 由 Criterion verdict 派生，优先级为 `rejected > inconclusive > qualified`。

IdempotencyRecord 保存首次完成命令的整个 `patchledger.cli/v1` success envelope 及其 contract version；同 operation ID、command 和 request hash 的重试通常逐字段重放该结构化结果。`integration consume` 是单次许可消费，已消费后的同操作重试或换 operation ID 再消费均拒绝；未知合并结果须检查实际落地，不能以幂等重放重新合并。诊断日志、stderr 早期 operation ID 提示和人类渲染文本不属于重放结果。

每个公开 success `data` 都有 versioned `result_type` 和 `command` discriminator，并由 `command-results.schema.json` 校验。`workspace.publish` 返回本次发布涉及的 Repository、Requirement 与 Issue 的稳定 ID、公开版本、绑定和 Baseline；`devrun.start/context` 和 `verification.context` 直接在 `data.context` 中嵌入相应版本化 Context，公开的 `devrun.start/context` 还通过 `local_worktree` 报告本机目录的 `available/missing/invalid/removed` 状态，路径只在 available 时出现。`devrun.cleanup` 是无 operation ID、无 Attribution、无 Ledger Event 的本地幂等操作。list 只返回资源摘要，show/compare/ledger 使用 `query-results.schema.json` 的专门结构。Schema 中保留的早期单资源结果只服务 Work Module 内部兼容与历史幂等重放，不代表公开 CLI 命令。Agent 不从人类 label 或 stderr 提取身份。

Schema 只能验证结构。Candidate Claim 是否真实、Verifier 是否真正保持 blind，以及 Attribution 是否可信，都不由这些文件证明。

<a id="review-summary-and-verification-pages"></a>

## Review 摘要与 Verification 分页

`review --summary --json` 返回 `patchledger.result.review-summary/v1`，内含 `patchledger.review-summary/v1` trace。历史 Candidate 事实和作者材料语义不变；`verification_set` 只含 count、digest、standing、verdict_counts、`reports_included: false`，不含正文或 v3 的 `complete: true`。

`verification list --candidate ID --paged --json` 返回 `patchledger.result.verification-page/v1`。用 `--cursor` 继续，每页最多 256 条；不透明游标绑定 Candidate、集合 digest 和排序键。所有页与摘要必须属于同一集合。变化返回可重试 `VERIFICATION_SET_CHANGED`（exit 4），从摘要和首页重新读。`verification show ID --json` 仍是单报告接口，摘要与单报告仍受 8 MiB 限制。

完整 Review v3、默认文本、不分页列表和 Candidate 详情契约不变。`--summary` 与 `--markdown` 冲突；Candidate 专属目录的 `--cursor` 需 `--paged`，后者需 `--candidate`；下文资源列表可单独使用 `--cursor`。Markdown 先暂存固定目录和逐份渲染报告，再输出 stdout，不再要求整体 v3 JSON。完成导出标识固定集合，不表示永远最新。

<a id="cursor-paged-resource-lists"></a>

## 游标分页资源列表

`repository`、`requirement`、`issue`、`devrun`、`candidate` 及不带 `--paged` 的 `verification` `list`，按原方式调用仍返回完整集合。超过 10,000 项或 8 MiB 用 `ARTIFACT_TOO_LARGE` 失败，`reason` 提示分页形式。`--limit N`（1–1000；仅给 `--cursor` 时默认 100）和/或 `--cursor` 切换到同一 `patchledger.result.resource-list/v1` 的分页，含 `page` 对象 `{limit, has_more, sort}`，只有还有条目才带不透明 `next_cursor`。`has_more:false` 为末页，空集合只有一个空页。顺序固定公开：repository/requirement/devrun 用 `id:asc`；issue 默认 `id:asc`，或 `--sort activity` 的 `activity:desc,id:asc`；candidate/verification 用 `created_at:asc,id:asc`（时间按瞬时比较，ID 打破平局）。页面若超 8 MiB 可少于 `limit`，`next_cursor` 从最后保留条目继续。

游标绑定资源类别、准确筛选（如 `--requirement`、`--repository`、`--status`、`--has-open-devrun`、`--issue`、`--issue-version`、`--state`、`--standing`、`--selected`、`--candidate`、`--verdict`）、排序、最后位置和首页读取的账本高水位。其他筛选、不同列表或被改游标为 `VALIDATION_ERROR`（`field: cursor`），无效 `--limit` 为 `VALIDATION_ERROR`（`field: limit`）。首页后任何账本写入使下一页返回可重试 `LIST_CHANGED`，丢弃游标从首页开始。分页不漏/重条目，不跨变化宣称完整，仍校验每条存储行。Verification 专属分页（`--paged --candidate`）和 `ledger list --after` 保持自身游标/语义。

## Selection 协议

`selection.schema.json` 定义当前选择及 show/set/clear 结果；`delivery-worktree.schema.json` 定义本地交付凭据。`selection materialize` 结果包含该凭据、目录、分支和读取时的警告。`board.selection` 与 Candidate show/list/compare 的 `is_selected` 为新增查询字段，历史记录缺省表示未记录，不从其他数据猜测。Candidate/Verification/Review Trace 协议不变，CLI envelope 仍为 v1；数据库 schema 升至 11，通过现有显式迁移和 schema 相等门禁隔离旧客户端。具体行为见 Selection 设计。

`command-results.schema.json` 中 `candidateMaterializeResult.review_session_id`、`verificationContextResult.output_path`、两个 handoff 结果的 `output_path` 与 `devRunWorktreeCleanupResult.deletion_summary` 均为可选字段：只在 review 会话、落盘输出或实际删除受管工作树时出现。

`selection-inspect.schema.json` 定义当前 clone 的交付检查结果。`selection inspect` 只读；`selection materialize` 可安全重试匹配准备。恢复错误可带 `target_path` 和 `inspect_argv`，后者是参数数组，不是 shell 命令。

## 当前代码历史查询

[code-history.schema.json](code-history.schema.json) 定义 `trace` 与 `delivery-link record/show/withdraw` 的结果。来源身份和内容吻合分开返回，包含当前/历史行范围、精确契约版本、可继续读取的 `review_argv`、未解释范围及预算缺口。交付关联需要 schema 14；只读查询不会自动迁移数据库。

`trace.source.index.staged_paths` 与 `unmerged_paths` 描述本次命中文件的暂存/冲突状态；未解决冲突通过 `unresolved_index_conflict` 明确阻止该文件的来源追溯。

<a id="local-environment"></a>

## 本机环境（grounds env）

[`environment-definition.schema.json`](environment-definition.schema.json) 定义仓库 YAML 的非敏感声明。单仓库、多变体，`repositories` 最多一项且 path 为 `.`；Docker 必须提供 `base.image` 配方。声明可版本化，凭据声明不构成宿主授权。

`grounds env up|list|show|reconcile|handoff|down|run|cancel|logs|credential-grant|credential-occupancy|service-register` 的结果符合 [`environment.schema.json`](environment.schema.json)，`result_type` 为 `grounds.result.environment/v1`。任务实例（`grounds.environment/v1`）及运行记录（`grounds.environment-run/v1`）保存在本机运行根，不取得真实业务账本。可信 host 支持 macOS/Linux，没有操作系统级文件、网络或进程隔离；Docker 为完整任务 Agent 提供单仓库、独立普通 Git 与私有运行资源。只执行容器内测试不构成 Agent 隔离。

协调者负责 Repository 身份、授权、目标新鲜度/准入、角色/阶段材料、Agent 创建/续接、Git 对象交接和 CLI 上报。环境不自动追随目标、推进验证或重跑 Agent；停止证明、成果交接、安全收尾及业务提交分别判断。能力不足 `ENVIRONMENT_CAPABILITY_UNSUPPORTED`，准备失败 `ENVIRONMENT_SETUP_FAILED`，不静默改用 host。声明及非敏感构建输入可版本化，私有凭据、控制记录、日志和报告 handoff 不进入候选树。配置固定范围与引用，认证组件可在同源同账号内续期；环境不自行刷新或扩权。

<a id="external-workspaces"></a>

## 正式候选 Git 工件

[candidate-archive.schema.json](candidate-archive.schema.json)独立定义 `grounds.git-commit-artifact/v1` 及其归档 binding、历史 receipt、当前 observation、保护策略证据和固定比较参照。binding 绑定完整远端身份、归档 ref、source、ordered parents、result tree、逻辑 base。历史 receipt 只证明当时的归档检查，不承诺当前远端仍可读。状态 confirmed/missing/conflict/unreadable/incomplete/unknown 与业务 Verification、Selection、采用分别判断。保护证据不代表平台管理员无法破坏配置，仓库和 DB 备份状态分别披露。

新增公开输出使用 `grounds.result.candidate-{archive-status,archive-operation,archive,fetch,restore,lineage,diff}/v1`，继续放入 `patchledger.cli/v1` 信封。`candidate diff` 固定左右提交及用途，target_observation 必须含观察时间并声明 `delivery_ready:false`；unavailable/too_large 不包含伪空 patch。含非 UTF-8 字节且不能无损作为文本展示的 patch 明确不可用，不能用替换字符改写字节后仍称为原 diff。

Git 是新工件的代码真源，DB 保存工件绑定及业务事实；固定 diff 生成规则为 `grounds.canonical-git-diff/v1`。旧 `patchledger.git-full-index-binary-patch/v1` 数据、blind payload、digest、签名和历史幂等结果不重写。patch-only 内容读取、恢复、修复前身、验证、选择、交付及转换归档均明确 `UNSUPPORTED_CANDIDATE_ARTIFACT`，不新增迁移或只读兼容层；历史保留不意味着格式仍受支持。

盲验 `blind-subject` 与 `verification-context` 中既有 `patchledger.git-full-index-binary-patch/v1` 是从受支持 Git 工件派生的 canonical diff 投影格式；保留它以维持固定摘要/签名协议，不表示继续读取或恢复历史 SQL patch-only 候选。

## 外部工作目录

`devrun.inspect-workspace` 返回 `patchledger.result.workspace-input/v1`，含规范目录、dev:ino 身份、baseline_oid、input_digest、result_tree_oid、dirty、changes。路径清单最多 65536 条且序列化 512 KiB。`devrun.start --external-directory` 的脏输入需要当前 input digest。`local_worktree` 增加可选 external ownership、初始 digest/变化路径/result tree；SQL 契约和 Candidate 工件格式不变，本地 journal v3 读取 v2/v1。外部 `devrun.cleanup` 返回 removed=false/external_preserved=true 和 local_worktree.status=removed，仅解除引用，绝不物理删除。

受管/外部 DevRun start 都持共享 directory-registry 锁，在 Git 工作树创建和 SQL 发布前拦截重叠 Workspace owner。新本地租约区分 managed/external，旧无标签租约仍按 external。受管租约 digest 只是本地归属指纹，不是用户接受的输入来源。不重叠受管同级目录仍独立。旧调用者无权威 Store 时保留未知预约，不回收。明确终态 cleanup 移除匹配租约，已确认缺失的受管路径写 removed tombstone，阻止 start 回放复活；此生命周期修正不增加公开字段或 SQL 迁移。


## 实际目标更新前驱

采用绑定可带 `target_predecessor` 完整 OID；字段对旧数据可缺省，新 FF 确认 P 需显式采用来源证据并进行对象/历史/祖先核对。`integration.landing.target_predecessor` 的 state 为 confirmed/unknown/conflict，confirmed 带 commit 和 source（adoption_binding/landing_first_parent）。P 是目标引用更新前驱，FF 多提交时可能不同于 L 的 Git 首父。旧字段缺失按 unknown 解释，不改写旧事件 digest。采用事实与 P 证据、L 归档分开；P 未知/冲突分别返回 landing_archive pending/unknown 和 `actual_target_predecessor_unknown` / `actual_target_predecessor_conflict`，landing diff 为 STATE_CONFLICT。只有 confirmed P 可用于归档 base、retained端点和 landing diff 左端。

统一环境 `up` 可显式绑定 `--input-commit`、`--branch`、`--material-scope development|blind`、`--fixed-inputs-file`；`run` 接收 `--argv-file`、`--timeout-seconds`、`--requires-network` 和重复 `--artifact`。固定输入 `/inputs` 只读；显式产物仅来自 `/output` 的单个常规文件，每个至多 16 MiB，缺失或超限阻止回收。`down` 后 receipt 的 `directory` 保留摘要、日志和收集产物。`handoff` 只保活固定 Git 对象，协调者另行更新业务分支/提交账本。

QA/Coding 新执行适配标识为 `grounds-env/1/docker`；旧 macOS 定义与验证结构可历史读取，新执行需 `backend: docker` 与空 `network_hosts`。QA runner 仅有声明、recipe和显式非敏感build inputs，材料按角色作为固定输入；host 不提供隐藏 Grader 所需隔离。

Docker 实例记录可包含 `engine_id`，运行/停止时按实例核对 以防引擎身份改变后误清理。凭据绑定仅保存 `source_version` 与 `identity_digest` 等摘要，不把账号/token身份原值放入运行记录；`env credential-occupancy` 返回未释放实例对来源文件的占用，供认证侧核对。

该查询是快照，不能单独消除检查后新实例注入的竞争。宿主认证流程应使用 `env-credentials.ts` 的 `acquireCredentialSourceLocks`，在同一来源锁内查询全部关联 grant/实例、核对来源版本并完成显式退出；异步调用结束后在 `finally` 释放锁。准备流程在相同来源锁内复核版本、先发布 `preparing` 占用再注入，凭据回写也使用此锁。不同运行根通过同一目录注册根共享来源锁；使用私有测试注册根的认证组件和任务必须显式使用相同注册根。认证侧不能只按 grant 名称过滤，也不能在终止未知、收尾失败或占用查询失败时删除/吊销来源。历史回写冲突但已安全 `released` 的实例不永久占用。此协议不恢复已退役的 `auth` 命令。

GitLab项目归档接入的闭合结果与绑定格式见 `repository-archive.schema.json`；保护失败诊断扩展见 `candidate-archive.schema.json`。当前实现及权限边界见总设计。

归档错误响应的 `details.operation_id` 指向需恢复的原操作；可选 `phase` 为 prepared / verified / committed / unknown / failed。它们不代表重新提交授权或允许创建新Candidate。

代码Workspace增量（本开发树未发行）：`code-workspace.schema.json`增加end / cleanup-preview / cleanup及实例lifecycle。code_reclaimed仅表示代码worktree全部回收，不包括共享缓存、保活引用、运行材料与服务；详情见仓库总设计 `GROUNDS_DESIGN.md` §11.8。

代码 Workspace 的 `restore` 使用显式 original 上下文：实例 restoration 保存来源实例、Candidate、源提交、归档绑定及原各仓库固定提交/树；路线 restoration 保存 Candidate/源提交，base_commit 保持原目标基线。分配、代码准备与新 DevRun 准入分别执行，不能把历史回放当作新的执行权限。

环境默认增量（本开发树未发行）：environment-check只有passed退出0，其余检查状态退出1；show/default查询读取成功退出0。执行startInput须在image、environment_revision_id、environment_default=true之间三选一，后者一次解析并固定。保存及检查不隐式修改默认；详情见总设计§8.4/§12.6。
