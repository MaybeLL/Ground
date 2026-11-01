# 通用 Agent 执行与评测：目标模型 R1

- 日期：2026-11-02。
- 状态：**已确认，待实现**。这是助手按用户授权、依据领域与应用层评审结果对 [0001 决策记录](0001-unified-agent-evaluation.md) 作出的结构修订，变化点记为 D129–D137，用户已于 2026-11-02 确认。生产代码尚未实现。
- 用途：一份可以单独阅读的当前目标模型，与 0001 中旧决策冲突时以本文为准。0001 记录讨论历史与理由；开发时先读本文，再按需回查对应决策。本文不重复已确认的细则，只写结构、职责、不变量和流程。

## 1. 一页结论

R1 保留 0001 的核心方向：通用任务执行在下、评测叠在上；Candidate / Artifact / Trajectory 并列；评分独立于实验；失败、未知与成功严格区分。修订集中在七处：

| # | 原设计的问题 | R1 的做法 | 决策 |
| --- | --- | --- | --- |
| 1 | TaskRun 成功必须全部验收通过（D110），未通过时进入等待继续；评测中被测交付若未通过验收，会停在“等待继续”，评分也无从开始 | TaskRun 携带发起方给定的**完成策略**：开发默认“需验收、未完成则等待”，评测默认“无需验收、未完成则失败”。评测只依据已交付内容评分 | D129 |
| 2 | 交付契约检查、验收记录、GradingRecord 三套相似的评价事实 | 三级检查：TaskType 的确定性**接收校验**；**验收**与**评分**统一为 GradingRecord，用途分 gate / measure；Grade 增加逐条结论形式 | D130 |
| 3 | 验收 Agent 走 AgentExecutionService，Judge 却走 TaskExecution，需要合成 Task，并临时规定 Judge 任务不再验收以免递归 | 验收者与 Judge 都是**评价者执行**，直接使用 AgentExecutionService，不产生 TaskRun | D131 |
| 4 | 资源生命周期按 TaskRun 计（顺序复用、等待暂停、终结回收），却由按单次执行计的 AgentExecutionService 准备 | 新增 **Sandbox** 聚合与 **SandboxProvisioning** 模块：归属者（TaskRun 或 GradingRecord）申请、暂停、释放；执行只凭租约占用 | D132 |
| 5 | TaskRevision 固定 EnvironmentRevision，镜像小修会连带改 Task → 评测项 → 快照 → 实验 | TaskRevision 声明**环境要求**（定义 + 固定或跟随），TaskRun 或 Experiment 记录解析结果 | D133 |
| 6 | 六组对称的“定义 / 修订”各自建模；TaskType 一期就要求可配置和插件注册 | 一套共享的**版本化定义机制**；一期 TaskType 只内置 coding / working | D134、D135 |
| 7 | 受理后在后台推进的模式在三个模块里各写一遍；宿主由谁监管未定；Agent 名额范围前后矛盾 | 一套**受理与驱动**基础设施；按需启动的本地宿主；Agent 名额按宿主统一计数 | D136 |

D137 另收缩一期范围。第 9 节列出所有受影响的旧决策。

## 2. 分层总览

![R1 分层总览](../assets/r1-layers.jpg)

[Mermaid 源](../assets/r1-layers.mmd)

- **入口适配器**只把请求转换成应用调用，不编排步骤。
- **应用层**负责业务编排：调用领域对象进行状态转换，通过端口执行外部动作，协调回执与补偿。
- **领域层**由聚合组成，每个聚合守护自己的不变量，不做 I/O，可以不依赖数据库、容器或模型单独测试。
- **受理与驱动**是应用层共用的基础设施，不承载业务规则（第 7 节）。

## 3. 领域模型

### 3.1 任务运行与资源

![任务运行与资源](../assets/r1-domain-run.jpg)

[Mermaid 源](../assets/r1-domain-run.mmd)

### 3.2 评价与评测

![评价与评测](../assets/r1-domain-eval.jpg)

[Mermaid 源](../assets/r1-domain-eval.mmd)

颜色含义：蓝色为版本化定义，绿色为运行事实，橙色为资源，红色为评价记录。

### 3.3 聚合与不变量

一个聚合内的规则在一次持久化中原子成立；跨聚合的一致性由应用层按回执推进，并在中断后由核对恢复。

| 聚合 | 拥有的状态 | 必须守护的不变量 |
| --- | --- | --- |
| **TaskRun** | 六种状态、完成策略、固定的 TaskRevision 与解析出的环境版本、交付清单历史及当前清单、采用的 gate 记录、取消意图、阻塞原因、任务 Sandbox 引用 | 成功仅当：当前清单已通过接收校验并冻结；所列交付与要求的轨迹均有归档回执；策略要求验收时，所采用 gate 记录绑定同一份清单且全部条目满足；名下没有仍在运行或状态未知的执行。终态不可重开。清单只能整体替换，旧清单保留。取消意图只能在确认停止后转为已取消 |
| **AgentExecution** | 发起方（TaskRun 或 GradingRecord）、角色（worker / evaluator）、AgentRevision、Sandbox 引用、阶段、输出与轨迹归档回执、停止观测、Durable 会话映射 | 执行成功仅当约定输出与轨迹已归档。归档受阻时只能补做归档，不能重新调用模型。恢复沿用原身份。同一时刻只有一个运行拥有者 |
| **Sandbox** | 归属者、Workspace 引用及来源（自建或借用）、EnvironmentInstance 引用、挂载状态、当前占用者、保留意图、暂停事实 | 同一时刻最多一个占用者（承接 D34）。有占用者或停止未知时不得卸载、暂停或释放。只有归属者能暂停、释放或继续。只回收自建资源。准备失败时保留已就绪的 Workspace |
| **EnvironmentInstance** | 依据的 EnvironmentRevision、资源身份、主阶段（已登记 / 准备中 / 可用 / 已暂停 / 释放中 / 已释放）、核对标记 | 状态未知时保留最后已知阶段并阻止新的使用；回收未确认不得标为已释放。占用事实只记录在 Sandbox，不在实例上重复保存 |
| **Workspace** | 复用现有 CodeWorkspaceInstance / Route：配置版本、固定基线、可写 worktree、保留与 pin | 沿用 D109 及现有清理保护，不新建 Workspace 模型 |
| **Candidate / Artifact** | 身份、类型、冻结内容、来源执行 | 提交后不可变；保存重试返回同一引用（D47） |
| **GradingRecord** | 用途（gate / measure）、发起来源、确切目标集合（清单或其中若干项、轨迹）、GraderRevision、实际材料、评价者执行与评价者 Sandbox、评分状态、Grade | Grade 必须符合 GraderRevision 声明的形式与标尺；评分器故障与合法的“无法判定”分开记录；完成后不可改，重评只能新增记录 |
| **EvalRun** | 评测项键、被测 TaskRun、每个评分要求采用的 GradingRecord | 采用规则按 D64；完整性由采用记录派生，不另存一份可变总结 |
| **ExperimentRun** | 重复次数、任务并发数、成员 EvalRun、取消意图 | 只作用于本批次；可靠恢复不新建批次身份 |
| **版本化定义** | Definition 身份 + 不可变 Revision（D134） | 发布后不可改；修改即产生新修订；引用必须指向确切修订 |

不单独成为实体的值：交付清单、完成策略、环境要求、EvaluationCase（快照内的值，带稳定键）、Grade、执行输入。

## 4. TaskRun 与完成策略（D129）

![TaskRun 状态](../assets/r1-taskrun-states.jpg)

[Mermaid 源](../assets/r1-taskrun-states.mmd)

完成策略是发起时给定、随 TaskRun 保存的值对象，包含两项：

| 字段 | 取值 | 含义 |
| --- | --- | --- |
| `acceptance` | `required` / `none` | 成功是否还需要 gate 验收通过 |
| `on_unfinished` | `wait` / `fail` | 本轮执行结束但还不能成功时，进入等待继续，还是直接终结为失败 |

| 发起方 | 默认策略 | 成功的含义 |
| --- | --- | --- |
| 普通任务入口（开发） | `required` + `wait` | 已交付并通过独立验收（保持 D110 / D95） |
| ExperimentExecution（评测样本） | `none` + `fail` | 已形成有效交付并完成归档；质量由 measure 评分表达 |

规则：

- 状态集合与终态语义沿用 D112 / D102，不新增状态。查询结果必须同时显示策略，例如“成功（已验收）”或“成功（已交付）”，避免把两种成功混为一谈。
- `fail` 策略下，单次执行失败或未形成可接收的交付，会直接把 TaskRun 终结为失败；归档受阻或停止状态未知不属于此情形，TaskRun 留在“进行中”并记录阻塞原因，按 D1 / D35 处理。
- 失败原因必须区分 Agent 侧（执行失败、未形成可接收的交付）与基础设施侧（资源准备受阻、宿主故障）。EvalRun 把基础设施失败显示为执行错误，不当作质量结论（原则 6、D57）；是否另发起新的尝试由调用方明确决定，不自动补跑（D66）。
- 评测若关心验收条目是否满足，在评测项里加一个使用内置验收评分器的 measure 评分即可，结果以逐条形式进入 EvalRun，不改变 TaskRun 状态。
- 策略不能在运行中修改。需要换策略，请重新发起一个 TaskRun。

## 5. 三级检查：接收校验、验收、评分（D130）

![三级检查](../assets/r1-checks.jpg)

[Mermaid 源](../assets/r1-checks.mmd)

| 层级 | 归属与机制 | 结果 |
| --- | --- | --- |
| ① 交付接收校验 | TaskType 的确定性规则（D83 / D87 中的契约检查）：结构、必需项、引用可读、与任务的仓库 / 基线一致 | 拒收该清单，或冻结为当前交付。不启动 Agent，也不形成 GradingRecord |
| ② 验收 gate | GradingRecord（用途 gate），使用内置的“独立验收评分器” GraderRevision：由一个评价者 Agent 一次核验全部条目，内部保留盲验 → 固定 → 对照阶段（D115） | Grade 为逐条结论；全部满足才算通过。由 TaskRun 采用，用于成功判定 |
| ③ 评分 measure | GradingRecord（用途 measure），可使用任意规则、测试或 Agent 评分器 | 数值、分类或逐条结论，进入 EvalRun 或独立查询，不改变 TaskRun |

Grade 的形式从两种扩展为三种：数值、分类、**逐条结论**。逐条结论的每一项记录条目 ID、满足 / 未满足 / 无法判定、理由和证据引用。评分器故障仍与质量结论分开（D13）。

由此，现有 Verification 记录迁移为用途 gate 的 GradingRecord；独立验收的体验保持不变：用户无需配置，一次调用，保留逐条报告，不依赖实验。D111 的“清单或契约变化时全部重验”、D116 的“整份清单替换”继续有效。

## 6. 资源：Sandbox（D132）

![Sandbox 状态](../assets/r1-sandbox-states.jpg)

[Mermaid 源](../assets/r1-sandbox-states.mmd)

Sandbox 是一次工作所使用的 Workspace 与 EnvironmentInstance 的组合，挂载关系也在其中。它把 D77、D91、D96、D113、D119、D123 分散描述的规则收进同一个聚合：

- **归属者**：任务 Sandbox 归 TaskRun 所有，生命周期覆盖整个尝试；评价者 Sandbox 归 GradingRecord 所有，评分结束即释放。
- **占用者**：某次 AgentExecution（或测试评分器的一次命令运行）凭租约取得占用，确认停止使用后归还。占用互斥在这里落实。
- **暂停 / 恢复**：只有归属者能发起。TaskRun 进入等待继续时，确认无活动工作后暂停执行容器，Workspace 与依赖服务不动（D113）。
- **释放**：卸载并回收自建实例；Workspace 按保留意图处理，默认保留（D96）；借用的资源只交还。
- **准备受阻**：保留已就绪的 Workspace 与准备进度；TaskRun 按策略进入等待继续或失败（D123）。

Workspace 管理与 Environment 治理两个模块保持 D119 的拆分，但只有 SandboxProvisioning 调用它们。挂载、卸载、暂停的顺序与补偿集中在这一处。

## 7. 应用层

![R1 应用模块](../assets/r1-app-modules.jpg)

[Mermaid 源](../assets/r1-app-modules.mmd)

| 模块 | 调用方表达的意图 | 内部承担 | 明确不做 |
| --- | --- | --- | --- |
| **TaskExecution** | 发起（带策略）、继续、取消、提交交付清单、查询 | 推进 TaskRun 状态；向 SandboxProvisioning 申请、暂停、释放任务 Sandbox；带租约调用 AgentExecutionService；调用 TaskType 接收校验；策略要求时发起 gate 评分 | 不解析 Durable 事件，不执行挂载，不解释质量分数 |
| **AgentExecutionService** | 运行、查询、请求停止、核对、恢复一次执行 | 凭租约占用 Sandbox 并建立工具桥接；驱动 Durable；转换事件并归档轨迹与输出；确认停止；管理宿主级 Agent 名额 | 不创建或回收资源，不判断任务成败 |
| **Grading** | 按 GraderRevision 以 gate 或 measure 用途评价确切目标 | 准备材料；运行规则、测试或 Agent 评分器（后两者申请评价者 Sandbox，Agent 型通过 AgentExecutionService 运行）；校验 Grade；保存记录；内置独立验收评分器 | 不修改 TaskRun，不依赖实验 |
| **ExperimentExecution** | 运行批次、补评、取消、查询结果 | 以评测策略发起 TaskRun；交付后发起 measure 评分；管理任务名额（默认 5）、重复次数与采用规则 | 不复制执行或评分流程 |
| **SandboxProvisioning** | 申请、暂停、恢复、释放、核对 Sandbox | 协调 Workspace 管理与 Environment 治理，封装挂载顺序、所有权与失败补偿；向占用者提供命令与文件桥接 | 不决定资源何时保留或释放，由归属者决定 |
| Workspace 管理 / Environment 治理 | 仅由 SandboxProvisioning 调用 | 沿用 D109 / D121 | — |
| 交付与证据存取 | 保存、读取 Candidate、Artifact、轨迹与证据 | 按类型分端口（D46 / D47） | 不决定任务成败 |

相较 D117，**Verification 模块不再单独存在**：其流程成为 Grading 内置的独立验收评分器，由 TaskExecution 按策略调用。Grading 不再调用 TaskExecution。依赖关系因此成为一张无环图：ExperimentExecution → TaskExecution / Grading → AgentExecutionService / SandboxProvisioning → 治理模块与端口。

### 7.1 评测样本流程

![评测样本流程](../assets/r1-seq-eval.jpg)

[Mermaid 源](../assets/r1-seq-eval.mmd)

### 7.2 开发任务流程（含一次验收不通过）

![开发任务流程](../assets/r1-seq-dev.jpg)

[Mermaid 源](../assets/r1-seq-dev.mmd)

### 7.3 受理与驱动（D136）

TaskExecution、AgentExecutionService 和 ExperimentExecution 都遵循同一模式：持久化请求与意图，立即返回身份，再由后台推进；宿主重启后先核对，等用户明确恢复（D53、D73、D74）。这个模式抽成一套共用基础设施：

- **请求账本**：按请求身份防重，同一身份携带不同输入时报告冲突（D54、D122）。
- **意图记录**：先登记下一步外部动作，再执行，回执与状态转换在同一事务中写入。
- **核对循环**：发现“意图已登记、结果未知”的工作并调用对应模块的核对接口；只核对，不自动恢复执行。
- **宿主监管**：每个数据根一个本地 `grounds` 宿主进程，由 CLI 在首次受理异步工作时按需拉起，没有活动工作时退出。CLI 断开不影响执行。

它不是业务工作流引擎：没有 DSL，不定义业务步骤；各模块仍拥有自己的状态转换。

**并发名额：** Agent 名额由宿主统一计数，默认 20，开发执行、被测执行与评价者执行共用，取代 D56 “仅限一次评测批次”的范围；任务名额由 ExperimentRun 计数，默认 5。

## 8. 版本化定义与环境解析（D133–D135）

**共享版本机制（D134）。** Task、Agent、Grader、Environment、Suite 统一采用：稳定的 Definition 身份 + 不可变 Revision，包含序号、前一修订、内容摘要和发布时的乐观并发检查；各自只定义内容 schema。实现上使用同一组仓储与发布逻辑，不维护五份。现有 WorkspaceConfigurationVersion 保持原样（D109）。

**TaskType（D135）。** 一期只内置 `coding` 与 `working` 两种，用带 `kind` 的联合类型加版本化 schema 表示，类型版本随 Grounds 发布。用户配置类型与开发者注册处理器（D82 / D86）推迟到出现第三种类型的真实需求时再做，届时需保持现有类型版本可读。

**环境要求（D133）。** TaskRevision 不再固定 EnvironmentRevision，而是声明环境要求：

| 选择方式 | 含义 |
| --- | --- |
| `pinned` | 固定某个 EnvironmentRevision，适合严格复现 |
| `follow`（默认） | 跟随某个 EnvironmentDefinition 的最新已发布修订 |

解析时机：普通 TaskRun 在受理时解析，并把结果记录在 TaskRun 上；Experiment 在创建时为每个评测项解析一次，记录为**环境解析表**，作为固定方案的一部分，该实验的所有批次都使用这张表。镜像升级只需新建 Experiment，不必改 Task、评测项或快照。D79 的“实验不直接选择环境”保持不变：解析表由任务声明自动得出，不是另一份可编辑的绑定。

## 9. 一期范围收缩（D137）与旧决策影响

一期暂缓：

- Durable 内部状态先只实现 SQLite，保留 D72 的存储端口；PostgreSQL 与 MySQL 推迟。
- 推迟 TaskType 的配置扩展与插件注册（D135）。
- D68 的通用 Provider 能力矩阵不做。

| 旧决策 | R1 中的处理 |
| --- | --- |
| D37 | 占用从 EnvironmentInstance 的主阶段移到 Sandbox；实例主阶段改为已登记 / 准备中 / 可用 / 已暂停 / 释放中 / 已释放 |
| D56 | Agent 名额从“一次评测批次”改为按宿主统一计数 |
| D72 | 端口保留，一期只交付 SQLite 后端 |
| D80、D117 中 “Grading → TaskExecution” | 由 D131 取代，Judge 直接使用 AgentExecutionService |
| D82、D86 的扩展方式 | 由 D135 推迟 |
| D95、D110 | 作为 `wait` / `required` 策略的规则保留，不再对所有 TaskRun 生效（D129） |
| D103、D104 的验收记录、D115 的独立验收入口 | 统一为用途 gate 的 GradingRecord 与内置独立验收评分器（D130） |
| D119、D120、D123、D127 中的资源准备职责 | 移交 SandboxProvisioning，执行只凭租约（D132） |
| D120、D121 中 TaskRevision 固定 EnvironmentRevision | 改为声明环境要求并解析（D133） |

其余已确认的决策（Candidate / Artifact 并列、清单与重验规则、取消与停止确认、归档优先、单内核选型、并发默认值、结果查询与汇总等）不变。

## 10. 仍需具体设计的事项

- 内置独立验收评分器如何映射现有 VerificationReport 与 VerificationRun 的字段，以及迁移现有 disputed 历史的方式。
- 宿主进程的拉起、锁定与退出协议，以及 CLI 中 Ctrl-C 的语义。
- Sandbox 租约的持久化字段，以及命令与文件工具桥接的端口签名。
- 环境解析表与历史实验的兼容读取方式。
