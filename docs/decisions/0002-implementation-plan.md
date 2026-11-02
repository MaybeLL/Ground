# 0002 通用 Agent 执行与评测：实现方案

- 日期：2026-11-02。
- 状态：**提议，待用户确认**。第 10 节列出需要拍板的决定；未列出的部分是按目标模型推导出的工程安排，按常规评审即可。
- 依据：[目标模型](0001-target-model.md)（D129–D144，已确认）；现有源码结构见第 2 节。
- 范围：一期的代码组织、存储、驱动、适配器、迁移与切换、里程碑与验证方式。本文不改变业务规则；实现中如果发现规则需要调整，回到 0001 记录。

## 1. 结论

1. **在现有仓库中新建 `typescript/src/work/` 子树，按六边形分层**（domain / application / ports / driver / adapters / entry），用一条测试守住依赖方向。现有模块不就地改写，由适配器复用，逐步收敛。
2. **新增 schema v24：为 9 个运行聚合与版本化定义建专用表**。需要唯一约束或索引的字段用列存放，其余放在带摘要的 JSON 中，三种数据库都要支持。现有的 `idempotency_records` 继续作为请求账本，`ledger_events` 继续作为审计流水。
3. **M0 先做技术验证，再写业务代码**：Pi Durable 锁定版本后接入容器工具桥接，验证按执行隔离的 SQLite 存储、Docker 暂停与恢复。不通过就回到 D69 重新选型，避免在不可行的内核上堆业务。
4. **开发闭环（M5）一次性切换**：以“切换时没有运行中的 DevRun”（D114）为前提做离线迁移，迁移时沿用原有 ID。评测闭环（M6）随后单独切换。
5. **迁移是第一个实现决策**：Issue → Task，DevRun → TaskRun 加 Work，Verification → gate GradingRecord，QA 与评测记录 → 新结构。规则见第 7 节。

## 2. 现状与复用

| 现有 | 规模与形态 | 在新结构中的位置 |
| --- | --- | --- |
| SQL 账本（`sql-*.ts`，schema v23） | 关系表承载 Requirement / Issue / DevRun / Candidate / Verification；`eval_records` 与 `runtime_records` 是带版本的 JSON 表；`idempotency_records`、`ledger_events` | 新表并入同一账本；沿用 `Store.write / read` 事务、`SqlDialect` 和三种后端的测试夹具 |
| `module.ts`（2437 行）、`cli.ts`（2345 行） | Requirement / Issue / DevRun / Candidate / Verification 的命令与 CLI | 开发闭环切换后，DevRun 和 Verification 的写入口停用；Candidate 的提交与归档逻辑由 coding 任务类型的适配器复用 |
| `code-workspace*.ts`、`code-route-*.ts` | Workspace 配置、缓存、基线、worktree、Docker 路线、暂停围栏、清理 | 由 `adapters/workspace` 与 `adapters/docker` 包装后复用；把与 Issue / DevRun 的绑定换成 Sandbox 归属者 |
| `candidate-git-archive.ts` 等 | Candidate 的 Git 归档与核对 | coding 交付的存取端口直接复用 |
| `verification-run.ts` | 独立验收的阶段记录 | 映射为评价者 AgentExecution 的协议阶段；内置独立验收评分器复用其阶段约束 |
| `evaluation.ts`、`eval-*.ts`，以及 `plugins/grounds/scripts/grounds_eval_*.py` | Suite / Snapshot / Experiment / Run / Grader / QA；Python 协调器与 Codex 采集 | M6 迁移到新结构；Python 协调器与 Codex 采集在 M7 退役（D69） |
| `env-*.ts` | 共享环境层（`env up / run / down`） | 评测侧的运行资源改由 Sandbox 接管；能复用的 Docker 操作下沉到 `adapters/docker` |
| `typescript/test`（205 个文件，含 `*-docker.test.ts` 与 `backends.ts`） | 单元、CLI 契约、三后端一致性、Docker 集成 | 新测试沿用同一结构与命名 |

## 3. 代码组织

![代码组织](../assets/impl-layout.jpg)

[Mermaid 源](../assets/impl-layout.mmd)

| 目录 | 内容 | 依赖规则 |
| --- | --- | --- |
| `work/domain/` | 9 个聚合、值对象、版本化定义、失败类别、Grade 校验 | 不 import 其他层、`node:*` 或现有 I/O 模块 |
| `work/ports/` | 出站端口接口：仓储、AgentProvider、SandboxRuntime、WorkspacePort、DeliveryStore、EvidenceStore、DurableStateStore、Clock / Ids | 只依赖 domain |
| `work/application/` | 用例与编排，以及查询（验收结论、工作结论、批次结果） | 依赖 domain、ports、driver，不依赖 adapters |
| `work/driver/` | 请求账本、意图、完成事件投递、核对循环、宿主监管 | 依赖 ports |
| `work/adapters/` | SQL 仓储、Durable、Docker、Workspace、交付与证据存取 | 实现 ports，可以复用现有模块 |
| `work/entry/` | CLI 命令组与输出 envelope | 只调用 application |
| `work/composition.ts` | 组合根：读取配置、创建适配器、注入服务 | — |

新增 `test/work-architecture.test.ts`，静态检查 import 图，确保上述依赖规则成立。

**领域实现形态：** 每个聚合写成纯函数 `decide(state, command) → { state, events } | DomainError`，再加 `assertInvariants(state)`。仓储负责按版本比较保存；领域只依据当前状态做判定。这样状态机可以穷举测试，重复和竞态也可以离线模拟。

## 4. 存储

![存储表](../assets/impl-storage.jpg)

[Mermaid 源](../assets/impl-storage.mmd)

- **一张表对应一个聚合**。每张表都有 `id`、`version`、`record_digest` 和 `body_json`；以下内容单独成列，以便加约束和索引：
  - `sandboxes` 的生命周期预留与占用租约（单值，按版本比较）；
  - `experiment_members` 的 `(experiment_run_id, case_key, repeat_index)` 唯一；
  - `task_runs` 的“每个 TaskRun 至多一个 worker”；
  - `works` 的工作头。
- **版本化定义**：Task、Agent、Grader、Environment、Suite 共用 `definitions` 与 `revisions` 两张表，`kind` 区分类型；修订不可变，`(definition_id, seq)` 唯一，摘要覆盖内容。现有 `WorkspaceConfigurationVersion` 保持原样（D109）。
- **命令步骤**作为 `grading_command_steps` 子表，与 GradingRecord 同事务写入，共用 GradingRecord 的版本号。
- **Artifact** 的元数据放在 `artifacts` 表，内容复用分块 blob（与 `eval_blobs` 结构一致，抽出共用实现）；对象存储（S3）作为可选后端，后续再交付（D46）。
- **请求账本**复用 `idempotency_records`（同一身份、不同输入时报告冲突）。**意图**与**完成事件**各建新表；完成事件与子聚合的终结写在同一个事务里。
- **Candidate 关系表**：新增可空的 `task_run_id` 外键，指向 `task_runs`。迁移后 TaskRun 沿用 DevRun 的 ID，因此旧行可以直接回填。`dev_run_id` 改为可空并保留给历史；SQLite 需要重建表，这一步放在 v24 迁移里完成，在三种后端上分别验证。
- **轨迹与 Agent 内部状态不进业务账本**：轨迹经 EvidenceStore 写入分块 blob，账本只存引用与覆盖说明；Durable 的内部状态由 DurableStateStore 按执行隔离保存（一期使用 SQLite 文件，位于数据根目录下，D72）。

## 5. 驱动与宿主

- **受理**：入口用例在一个事务中完成：登记请求身份（请求账本），完成领域状态转换，写入下一步意图，然后返回身份。
- **推进**：宿主进程读取待执行的意图，调用适配器执行外部动作，再在一个事务中写入回执、完成状态转换并登记下一个意图。如果子流程终结，同一事务里还要写入完成事件。
- **投递**：完成事件按“父意图 → 模块处理入口”幂等投递，处理成功后标记已投递；宿主重启后，重新投递尚未投递的事件。
- **核对**：宿主启动时，以及按固定周期，扫描“已登记、结果未知”的意图，调用所属模块的 `reconcile` 接口。核对只确认实际状态，不自动恢复执行（D74）。
- **宿主进程**：`grounds host`，每个数据根一个，用文件锁保证单实例。CLI 首次受理异步工作时，若宿主未运行就拉起它；宿主在没有活动工作且超过空闲期后退出。CLI 的等待只是轮询查询；Ctrl-C 只停止等待，取消必须显式执行（D73）。
- **名额**：Agent 名额由宿主内存中的计数器加持久化的占用记录共同维护，启动时从持久记录恢复，避免进程崩溃后多算或少算。

## 6. 适配器

| 端口 | 一期实现 | 关键验证 |
| --- | --- | --- |
| AgentProvider | Pi Durable，锁定版本。按执行启动独立进程，ExecutionEnv 绑定 Sandbox 的工具桥接，事件转换为公共轨迹事件并保留原始记录 | 不回退到宿主工具；停止确认需同时核对 Durable 进程和容器；同一请求重开不重复调用模型 |
| DurableStateStore | 每个执行一个 SQLite 文件，路径不暴露给任务工具 | 单一拥有者；重开后取回原结果 |
| SandboxRuntime | 复用 `DockerRouteEngine`：创建、挂载、暂停、恢复、查询、回收；命令与文件桥接校验 fencing token | 暂停时依赖服务不动；连接失败不当作已停止 |
| WorkspacePort | 复用 `code-workspace` 的配置、缓存、基线与 worktree；working 类型增加一个可写输出目录 | 清理保护、借用不删除 |
| DeliveryStore | Candidate：现有 Git 归档；Artifact：分块 blob | 同一操作身份重试返回同一个引用（D47） |
| EvidenceStore | 轨迹、原始 Provider 记录、命令输出：分块 blob | 读回内容与摘要一致 |
| 仓储 | SQL，SQLite / PostgreSQL / MySQL | 三后端一致性测试 |

## 7. 迁移与切换

**前提：** 切换时没有运行中的 DevRun（D114）。迁移是离线的一次性 schema 迁移（v23 → v24），开始前先运行完整性检查，结束后再运行一次；旧表保留只读，直到 M7。

| 旧记录 | 新记录 | 规则 |
| --- | --- | --- |
| Issue / IssueRevision | Task / TaskRevision（kind = coding） | 沿用原 ID；目标、约束、验收条目、基线、目标分支转为修订内容；Requirement 内容以固定材料引用保留（D107） |
| DevRun | TaskRun | 沿用原 ID；submitted 且有冻结 Candidate → 已交付，Manifest 的 origin 为 `caller`，带迁移标记；abandoned → 已取消；open → 已取消，原因记为迁移 |
| DevRun 树 | Work | 按目标模型第 12 节划分；只有一个叶子时设为工作头，原因记“迁移默认”；有多个叶子时为 `head-unselected` |
| Candidate | Candidate | 不变；回填 `task_run_id` |
| Verification（含 ultra 质量部分） | gate GradingRecord | 逐条三段直接映射；GraderRevision 记为“旧独立验收（迁移）”；ultra 的质量部分作为附带报告保留 |
| VerificationRun | 评价者 AgentExecution（迁移态） | 记录阶段与协议命令观测，标注轨迹缺失 |
| Selection / Completion / DeliveryLink | 保持不变 | 继续按 Candidate 关联；它们属于业务采纳，不是验收 |
| QA 定义 | TaskRevision（kind = working）加评分绑定 | 公开问题进入任务；参考答案与隐藏标准进入评分绑定 |
| Suite / Snapshot / Experiment / Run / Grader / execution / result | 版本化定义、Experiment、ExperimentRun 成员、GradingRecord | M6 迁移；无法证明批次边界的旧记录保留来源，不伪造批次 |
| `runtime_records` 中的 Workspace 实例与路线 | 保持原格式，作为 Workspace 适配器的存储 | 把绑定从 Issue / DevRun 改为 Sandbox 归属者，旧绑定仍可读 |

**切换顺序：** 先发布同时包含新旧代码的版本（新入口隐藏），在测试数据上演练迁移。正式迁移后，`devrun` 与 `verification` 的写命令返回“已迁移，请使用 work 命令”，读命令继续可用。评测侧在 M6 切换前保持旧路径。

## 8. 里程碑

![里程碑](../assets/impl-milestones.jpg)

[Mermaid 源](../assets/impl-milestones.mmd)

| 里程碑 | 交付 | 完成标准 |
| --- | --- | --- |
| M0 技术验证 | 一次性验证代码（不进入生产路径）与验证报告 | 锁定 Durable 版本；ExecutionEnv 的文件与命令全部经容器桥接；3 个执行并发、各自使用独立 SQLite；SIGKILL 后由新进程接管同一执行且不重复调用模型；Docker 暂停与恢复后容器内状态保留；结论写入 `docs/research/` |
| M1 领域核心 | `work/domain` 与依赖规则测试 | 每个聚合的状态转换与不变量都有测试，覆盖目标模型的竞态规则（取消先后、移交预留、工作头 CAS、失败类别优先级） |
| M2 存储与驱动 | schema v24（新表）、仓储、请求账本、意图、完成事件、核对循环、`grounds host` | 三后端一致性测试通过；用伪适配器模拟宿主在任意步骤崩溃，重启后只核对、不重复执行 |
| M3 Sandbox | SandboxProvisioning 与 Docker / Workspace 适配器 | 申请、暂停、恢复、移交、释放、到期清理的竞态测试；Docker 集成测试；占用者契约与 fencing token 校验 |
| M4 Agent 执行 | AgentExecutionService 与 Durable 适配器、交付与证据存取 | 真实容器加模拟模型的端到端测试：归档失败只补归档；停止状态未知时不释放占用；恢复沿用原身份 |
| M5 开发闭环与切换 | TaskExecution、Work、Grading（gate、内置独立验收评分器）、`work` CLI、v24 数据迁移 | 开发闭环的流程测试（目标模型第 7.2 节的流程图）；迁移演练：迁移前后的完整性检查都通过，旧 Candidate、验收、选择记录可读 |
| M6 评测闭环 | measure 评分（规则、测试、Agent）、ExperimentExecution、批次结果查询、评测记录迁移 | 一个批次混合 coding 与 working 任务、并发数为 3 的重叠验证；D56–D66 的验收目标 |
| M7 退役 | 删除旧的写入路径、Python 协调器与 Codex 采集；旧表改为只读 | 没有新代码引用旧写接口；文档与技能同步更新 |

M1 与 M0 可以并行。M2 之后各里程碑按顺序推进；每个里程碑单独提交 PR，并同步更新 `docs/architecture.md`（届时新建）。

## 9. 测试策略

| 层次 | 方法 |
| --- | --- |
| 领域 | 纯函数单元测试，加生成命令序列的性质测试（不变量在任何序列下都成立） |
| 应用 | 伪适配器加故障注入：在每个外部动作前后崩溃并重启，断言只核对、不重复调用模型、不重复创建 |
| 存储 | `test/backends.ts` 上的三后端一致性测试，覆盖唯一约束与 CAS 冲突 |
| 适配器 | 端口契约测试：同一组用例同时跑伪实现与真实实现；Docker 测试沿用 `*-docker.test.ts` 约定 |
| 端到端 | 两条流程（开发、评测样本）以模拟模型在真实容器中运行；使用真实模型的验证单独标注，不计入常规 CI |
| 迁移 | 由现有测试夹具构造的旧数据，按“迁移 → 完整性检查 → 新查询 → 旧读命令”的顺序断言 |

## 10. 需要确认的决定

| # | 决定 | 推荐 | 其他选项 |
| --- | --- | --- | --- |
| 1 | 代码组织 | 新建 `src/work/` 子树，分层并用测试守护依赖方向 | 继续平铺在 `src/`，只靠文件名前缀区分 |
| 2 | 存储形态 | 每个聚合一张专用表，关键字段成列、其余存 JSON | 全部放进现有 `eval_records` / `runtime_records` 的 JSON 表（无法用数据库约束守护唯一性） |
| 3 | 迁移时的 ID | 沿用原 ID（Issue → Task、DevRun → TaskRun） | 新建 ID 加映射表（引用更清晰，但每个旧引用都要翻译） |
| 4 | 切换方式 | 开发闭环与评测闭环分两次一次性切换，旧写入命令停用、读命令保留 | 新旧并行一段时间（违背 D38“单一权威状态”） |
| 5 | M0 不通过时 | 暂停业务实现，回到 D69 重新评估内核 | 先用简化 Provider 继续，后期再换 |

## 11. 风险

- **Durable API 不稳定**：上游仍是实验性接口，文档与 npm 版本曾不一致。应对：锁定版本，所有调用经适配器，契约测试覆盖所用接口。
- **SQLite 重建表的迁移风险**：`candidates` 的外键调整需要重建表。应对：在迁移演练中覆盖三种后端，迁移前自动备份。
- **`module.ts` 与 `cli.ts` 体量大**：切换时要逐个停用旧写入口。应对：先在 CLI 层统一拦截，再分批删除代码。
- **工作量**：M0–M7 涉及存储、宿主进程、容器与新内核，属于大型重构；每个里程碑都应可以独立发布和回退。
