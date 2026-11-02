# 0002 通用 Agent 执行与评测：实现方案

- 日期：2026-11-02，第二版。第一版（自建沙箱与驱动、Pi Durable 优先）按 [项目愿景](../vision.md) 修订，原稿见本文件的 Git 历史。
- 状态：**提议，待用户确认**。需要拍板的决定见第 11 节。
- 依据：[项目愿景](../vision.md)；[目标模型](0001-target-model.md)（D129–D146）。
- 范围：一期的交付顺序、代码组织、存储、沙箱集成、Agent 接入、迁移与切换、测试方式。本文不改变业务规则。

## 1. 结论

1. **先交付价值 1，再交付价值 2，最后才做托管执行。** 第一个可用版本是“自带 Agent 的契约开发闭环”：用户继续用 Claude Code 或 Codex 开发，Grounds 负责契约、冻结、独立验收和工作线。它复用现有的 skill 工作流与开发 worktree，不需要后台宿主、沙箱或新的 Agent 内核。
2. **价值 2 紧随其后**：从历史开发沉淀评测项、补充评分依据（隐藏测试、参考答案）、用规则或测试评分。这些都可以在没有托管执行的情况下完成。
3. **托管执行放在最后**，用于评测时“换一个 Agent 重跑”。Provider 一期先做命令行 Agent 适配器（Claude Code、Codex 的无界面模式），Pi Durable 作为后续可选的、带恢复能力的 Provider。
4. **沙箱不自建，集成开源实现**：环境定义采用 devcontainer.json，用 devcontainers CLI 构建与启动；生命周期操作（停止、暂停、删除、按标签查询）直接调用 Docker。强隔离后端（microsandbox）作为后续选项。
5. **本地低摩擦是一期目标**：默认使用 SQLite；候选归档只要求把标签推送到远端并读回核对，不再要求配置 ruleset 保护（D147）；`grounds init` 一步完成初始化。
6. 代码组织、存储形态、迁移时沿用 ID、分两次切换，这几项保持第一版的建议。

## 2. 现状与复用

| 现有 | 在新结构中的位置 |
| --- | --- |
| SQL 账本（`sql-*.ts`，schema v23，三种数据库） | 新表并入同一账本，沿用事务、方言与三后端测试夹具 |
| `module.ts`、`cli.ts` 中 DevRun / Candidate / Verification 的命令 | Candidate 的提交与归档逻辑由 coding 任务类型复用；开发闭环切换后，DevRun 与 Verification 的写入口停用 |
| `plugins/grounds/skills/grounds` 的开发与验收工作流 | **外部执行的主要入口**：skill 引导自带 Agent 领取 Workspace、提交清单；协调者拉起全新会话做独立验收。改为调用新的 `work` 命令 |
| `code-workspace*.ts`（配置、缓存、基线、worktree、清理） | Workspace 适配器直接复用；绑定从 Issue / DevRun 改为 Sandbox 归属者 |
| `code-route-docker.ts`、`repository-environment.ts`、`development-image-*.ts` | 第一阶段继续可用；托管执行阶段由 devcontainer 方案逐步替代，旧配置作为兼容格式保留只读 |
| `verification-run.ts`、`submitVerification` 的身份与盲验校验 | 外部评价者的协议阶段与独立性校验直接复用 |
| `evaluation.ts`、`eval-*.ts`、`grounds_eval_*.py` | 评测资产阶段迁移到新结构；Python 协调器与 Codex 采集在退役阶段移除 |

## 3. 交付阶段

![交付阶段](../assets/impl-milestones.jpg)

[Mermaid 源](../assets/impl-milestones.mmd)

| 阶段 | 交付 | 对应愿景 | 完成标准 |
| --- | --- | --- | --- |
| **P0 领域与存储** | `work/domain` 的 9 个聚合（含外部执行登记）；schema v24；仓储；迁移演练 | 基础 | 不变量与竞态测试（取消先后、移交预留、工作头 CAS、失败类别优先级、外部停止声明）；三后端一致性测试 |
| **P1 契约开发闭环（自带 Agent）** | TaskExecution、Work、外部执行的登记与提交、gate 加外部评价者、内置独立验收协议、`work` 命令、skill 改造、v24 数据迁移与切换 | 价值 1 | 用 Claude Code 或 Codex 走完目标模型 §7.2 的流程；迁移前后完整性检查通过；旧的 Candidate、验收与选择记录可读 |
| **P2 本地低摩擦** | 默认 SQLite、归档改为“推送标签加读回核对”（D147）、`grounds init` 一步完成、预编译安装包评估 | 价值 3 | 一台只装了 Node 和 Git 的机器，在 5 分钟内完成首个任务的契约、提交与验收（以实测为准） |
| **P3 评测资产** | 从历史 TaskRun 沉淀评测项；补充评分依据（从被采纳的 Candidate 派生隐藏测试、参考答案）；规则评分与测试评分（命令步骤）；评测集与快照 | 价值 2 | 用一批历史任务生成评测集；对历史交付做测试评分与规则评分；评分记录可追溯到确切材料 |
| **P4 托管执行与沙箱集成** | devcontainer 环境定义与 SandboxProvisioning；命令行 Agent 适配器；AgentExecutionService；后台宿主与驱动 | 价值 2、4 | 在 devcontainer 中用 Claude Code / Codex 的无界面模式重跑一个评测项；3 个任务并发且互不干扰；宿主崩溃后只核对、不重复执行 |
| **P5 实验与对比** | ExperimentExecution、重复次数、批次结果查询与按标尺汇总；迁移旧评测记录 | 价值 2 | 同一评测集分别用两个 Agent 跑一个批次，按 D63–D66 查看对比 |
| **P6 退役** | 删除旧写入路径、Python 协调器与 Codex 采集；旧表只读 | — | 没有新代码引用旧写接口；文档与 skill 同步更新 |

P0 结束后，P1 与 P2 可以并行；P3 只依赖 P1；P4 是第一个需要容器与后台宿主的阶段。每个阶段单独提交 PR，可以独立发布和回退。

## 4. 代码组织

![代码组织](../assets/impl-layout.jpg)

[Mermaid 源](../assets/impl-layout.mmd)

在 `typescript/src/work/` 下分层：

| 目录 | 内容 | 依赖规则 |
| --- | --- | --- |
| `domain/` | 9 个聚合、值对象、版本化定义、失败类别、Grade 校验 | 不 import 其他层、`node:*` 或现有 I/O 模块 |
| `ports/` | 仓储、AgentProvider（含能力声明）、SandboxRuntime、WorkspacePort、DeliveryStore、EvidenceStore、Clock / Ids | 只依赖 domain |
| `application/` | 用例、编排与查询 | 依赖 domain、ports、driver，不依赖 adapters |
| `driver/` | 请求账本、意图、完成事件、核对循环、宿主（P4 才需要） | 依赖 ports |
| `adapters/` | SQL、Workspace、devcontainer 与 Docker、命令行 Agent、交付与证据存取 | 实现 ports，可以复用现有模块 |
| `entry/` | CLI 命令组：work、task、grade、experiment、host | 只调用 application |

领域代码写成纯函数 `decide(state, command) → { state, events }`；`test/work-architecture.test.ts` 静态检查依赖方向。

## 5. 存储

![存储表](../assets/impl-storage.jpg)

[Mermaid 源](../assets/impl-storage.mmd)

保持第一版的设计：每个聚合一张表，需要唯一约束或索引的字段单独成列，其余字段放进带摘要的 JSON；版本化定义共用两张表；请求防重复用 `idempotency_records`；意图与完成事件各建新表；`candidates` 增加 `task_run_id`。外部执行登记作为 TaskRun / GradingRecord 的内部数据保存，不单独建表。会话记录这类证据写入分块 blob。

## 6. 沙箱与环境：集成方案

| 需要 | 采用 | 理由 |
| --- | --- | --- |
| 环境定义 | **devcontainer.json** 标准（附 lockfile 摘要与镜像摘要） | 业界通用，用户仓库常常已有；lockfile 可以固定 feature 版本，有利于复现 |
| 构建与启动 | **devcontainers CLI**（`build`、`up --id-label`、`exec`） | 官方参考实现，可以作为 npm 依赖引入，不需要常驻服务 |
| 生命周期 | **Docker CLI** 按标签查询、暂停、恢复、停止、删除 | devcontainers CLI 还没实现 `stop` / `down`；用标签标识归属，与现有的资源归属校验方式一致 |
| Workspace | 现有的开发 worktree 与只读基线 | 已有实现、测试与清理保护（D109） |
| 强隔离（后续） | microsandbox（本地 microVM，Apache-2.0，带 TS SDK） | 适合不受信任的托管执行；作为 SandboxRuntime 的第二个实现，P4 之后再评估 |

不采用的方案：

| 方案 | 原因 |
| --- | --- |
| container-use | 面向 Agent 的 MCP 服务，自己管理 git 分支，与 Grounds 对 worktree 和分支的所有权冲突；目前还是实验性项目 |
| Docker Sandboxes（`sbx`） | 需要登录 Docker，开源与许可条件有待确认 |
| E2B、Daytona | 以云端为主；Daytona 的开源仓库已于 2026 年 6 月停止维护 |
| AIO Sandbox | 一体化镜像（浏览器、VNC、Jupyter）太重；以后有网页类任务时再考虑 |

**外部执行的隔离**：自带 Agent 运行在宿主上，隔离靠独立的 worktree 加 Agent 自身的沙箱模式。如果任务需要运行时环境（数据库、特定语言版本），Agent 通过 `devcontainer exec` 在该任务的容器中执行命令，多个任务之间互不干扰。

**托管执行**：命令行 Agent 运行在任务的 devcontainer 里，凭据通过环境变量注入，不写入 Workspace。

## 7. Agent 接入

| 方式 | 一期实现 | 能力 |
| --- | --- | --- |
| 外部执行（日常开发） | skill 加 CLI：领取 Workspace、提交清单、声明停止或放弃、导入会话记录（Claude Code、Codex 的会话文件格式） | 不受 Grounds 控制；停止靠声明；会话记录覆盖说明为“外部提供” |
| 托管执行：命令行 Agent 适配器 | 在容器内以无界面模式运行 `claude -p` 或 `codex exec`，采集它们输出的会话文件并转为公共轨迹事件，同时保留原始记录 | 可以停止（停掉容器内进程），**不支持恢复**；中断以 infrastructure 结束 |
| 托管执行：Pi Durable（后续可选） | 作为带恢复能力的 Provider 接入 | 支持恢复原会话；按需评估 |

Provider 用能力声明表达差异（D68），应用层只依赖声明，不按 Agent 名字写分支。

## 8. 本地低摩擦

| 现状 | 一期目标 |
| --- | --- |
| 必须先配置 SQL 台账 | `grounds init` 默认在数据根目录下创建 SQLite，零配置可用；共享数据库仍可选 |
| Candidate 归档必须写入受保护的远端命名空间，无法确认 ruleset 保护时拒绝 | **归档只要求推送标签并读回核对**（D147）：标签推送成功，并读回确认指向确切的提交，才算归档成功，否则拒绝。ruleset 保护等级（受保护、无保护、未知）只作记录；完整性检查时比对远端标签与账本，发现标签丢失或被移动就明确报告 |
| 原生依赖需要编译工具链 | 评估预编译包或替代依赖，以实测数据为准 |
| 需要 Docker | 只有需要运行时环境或托管执行时才需要 |

## 9. 迁移与切换

保持第一版的规则：Issue → Task（kind = coding），DevRun → TaskRun，并沿用原 ID；DevRun 树 → Work（按目标模型第 12 节）；Verification → gate GradingRecord，评价者记为外部执行登记；QA 与评测记录在 P3、P5 迁移。迁移离线进行，前后各跑一次完整性检查；旧表保留只读，到 P6 为止。现有的 Workspace 实例与路线记录保持原格式。

切换分两次：P1 切换开发闭环（旧的 `devrun` 与 `verification` 写命令停用，读命令保留）；P5 切换评测。

## 10. 测试策略

| 层次 | 方法 |
| --- | --- |
| 领域 | 纯函数单元测试，加命令序列的性质测试 |
| 应用 | 伪适配器加故障注入；外部执行的停止声明、迟到提交与取消竞态 |
| 存储 | `test/backends.ts` 三后端一致性测试 |
| 适配器 | 端口契约测试，伪实现与真实实现跑同一组用例；devcontainer 与 Docker 测试沿用 `*-docker.test.ts` 约定 |
| 端到端 | P1：用真实的自带 Agent 走一次开发闭环（单独标注，不计入常规 CI）；P4：在容器里用命令行 Agent 跑模拟任务 |
| 迁移 | 用现有测试夹具构造旧数据，依次检查迁移、完整性、新查询和旧的读命令 |

## 11. 需要确认的决定

| # | 决定 | 推荐 |
| --- | --- | --- |
| 1 | 代码组织 | 新建 `src/work/` 子树，分层并用测试守护依赖方向 |
| 2 | 存储形态 | 每个聚合一张专用表，需要约束的字段单独成列 |
| 3 | 迁移时的 ID | 沿用原 ID |
| 4 | 切换方式 | 开发闭环（P1）与评测（P5）分两次切换，旧写入口停用、读入口保留 |
| 5 | 交付顺序 | 先做价值 1（自带 Agent 的开发闭环），再做价值 2，最后做托管执行 |
| 6 | 托管 Provider | 一期先做命令行 Agent 适配器（Claude Code、Codex 的无界面模式），Pi Durable 后续可选 |
| 7 | 环境与沙箱 | devcontainer.json 加 devcontainers CLI，生命周期操作用 Docker CLI；microsandbox 作为后续的强隔离选项 |
| 8 | 归档要求 | **已由用户决定（D147）**：归档只要求推送标签到远端并读回核对，不要求 ruleset 保护；保护等级只作记录，篡改由完整性检查发现。不提供本地归档模式 |

## 12. 风险

- **外部执行的独立性较弱**：外部评价者的独立性只能靠身份校验加协议约束，无法像托管执行那样隔离材料。应对：记录中如实标注；托管执行就绪后，可以用托管评价者复核。
- **命令行 Agent 的输出格式会变化**：Claude Code、Codex 的会话文件格式不是稳定接口。应对：锁定版本，转换器写契约测试，同时保留原始记录。
- **devcontainers CLI 的缺口**：它还没实现 stop / down，生命周期需要直接调用 Docker。应对：用标签管理资源归属，只回收带 Grounds 标签的资源。
- **归档从“防篡改”降为“可发现篡改”**（D147）：有推送权限的人或 Agent 可以删除或移动未受保护的标签。这是为了降低门槛做的明确取舍；完整性检查必须能发现这类改动，并在结果中注明保护等级。
- **SQLite 重建表的迁移风险**与**旧入口体量大**，同第一版的分析。
