---
name: grounds
description: 使用 Grounds 澄清并实现开发需求、恢复工作、独立验证候选、解释已记录的代码历史、审阅并准备交付，或将需求导出到 Confluence。适用于 Grounds 开发流程和进度查询；评测资产与实验请使用 grounds-eval。
---

# 使用 Grounds 开发与交付

明确用户目的，定位实际工作，并选择下一步已获授权的操作。这是 Grounds 开发与交付工作的入口。自然语言理解由 Agent 负责；CLI 查询只使用确定的筛选条件，不把用户的问题作为命令参数。

正式 Git 工件的远程封存、查询、精确取回与归档中断恢复，结合[候选 Git 归档协议](references/candidate-archive.md)。历史 SQL patch、签名与审计数据保留，但 patch-only 候选的内容读取、恢复及后续使用明确不支持，不迁移或自动转换；归档成功、当前远程可读、验证通过与实际采用分别判断。

## 掌握完整流程

Requirement 需求意图 → 已封存的 Issue Version → 受管开发路线上的 DevRun → 不可变的 Candidate → 独立 Verification → 人工 Review → Selection → 交付准备。

新受管分支模式先确认目标、定义参考提交及本机位置计划，正式开工才创建自己的 worktree/本地 branch。日常 Git checkpoint 只在本机存档；正式新 Git Candidate 固定具体提交并完成受保护远程归档，SQL 保存绑定和业务证据；历史 patch 工件继续按原协议读取。串行修复可沿用原路线，平行方案各有自己的目录/branch。历史 detached、external-directory 和固定起点评测按原边界恢复，不能用新模式接管任意已有目录。

这条链路用于理解流程，不会自动启动流水线；唯一例外是用户在开发开始时确认启用的[开发—验证—修复闭环](references/workflows/auto-repair.md)，它也只串联开发与独立验证，止于人工 Review 之前。审阅问题可以直接从 Candidate 开始；实现修正会开启新的开发路径，意图变化则返回契约编写。旧 Candidate 保留其历史契约。CLI 负责合法的状态转换和持久化；此入口不创建会话、就绪标记或采用记录。

新一轮 DevRun 必须确定 `simple` 或 `container` 模式：显式 `--development-mode` 优先，其次 `GROUNDS_DEVELOPMENT_MODE`，最后配置的 `development.default_mode`；无默认时首次交互选择，非交互缺值报错。`simple` 直接使用当前 CLI 环境（包括平台已提供的容器）；`container` 由 Grounds 管理开发容器。模式写入本轮记录，恢复不重新解析默认值，更换模式须新开一轮。操作与捕获边界见[开发候选](references/workflows/develop.md)。

用户选择多仓库代码上下文、代码 Workspace 或已经存在 `code-workspace` 路线时，使用[代码 Workspace 与路线执行](references/code-workspace.md)；它管理 Issue 实例、固定基线和目标开发路线，与契约草稿 `draft`（`workspace` 为兼容别名） 及旧 `env` 入口分开。先核对已安装命令能力，不把开发树能力当作已发行。

## 先定位，再选择流程

结合用户选定的目标与对话定位工作，但不能据此认定某项操作已经成功。只读取当前请求所需的状态，不枚举整个账本，也不加载所有 Skill。

调用 CLI 前，先阅读[共享准备协议](../../references/preparation.md)，按其中说明解析并导出 helper 根目录，再运行适用预检；已有 JSON 工作区的本地读写和统一 HTML 会话遵循其中的离线例外。

只读查询也通过同一个 helper 调用，由它提供 JSON 返回结构：

```bash
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$CLONE" -- issue show ISSUE_ID
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$CLONE" -- devrun list --issue ISSUE_ID
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$CLONE" -- candidate list --issue ISSUE_ID
```

跨资源查找工作时，先筛选列表，不逐项读取所有详情：`issue list --repository REPOSITORY_ID --status ready`（还支持 `--requirement`、`--has-open-devrun true|false`、`--sort activity`）、`devrun list --state open`、`candidate list --standing unverified --selected false`、`verification list --verdict rejected`。每项已携带所属 Issue/Repository，`issue list` 还包含 `board`；结果中的 `query` 会回显实际筛选条件。这些只是账本投影，不能证明本地 DevRun worktree 存在、交付工作树已准备、代码已合并或软件已发布；不分页的列表仍受 10,000 项或 8 MiB 上限限制。

进度查询与恢复工作时，用 `devrun reconcile --dev-run ID` 解释某个 DevRun 在账本、本机工作树、路线租约与交付目录中是否一致及安全的下一步；用 `devrun uncommitted` 盘点当前 clone 中只存在于本机的未提交改动或被忽略文件。两者只读，不能证明其他机器的状态。受管分支另核对当前 HEAD、逻辑 base、路线归属、固定候选和 continuation；旧候选通过不表示当前 HEAD 通过。仅询问确有歧义的下一步，不能把 `paused` 当作撤销已经获准的独立验证或缺陷修复。

完成状态先于交付建议：`board.status=completed` 与 `next_action=null` 表示该 Issue Version 已登记完成；如实报告依据与验证风险，不再建议准备交付或重新开发。完成/撤销完成及历史补录使用[完成记录](references/completion.md)，列表可用 `--status completed|incomplete`。新版本不继承旧完成，Requirement 汇总只看所选版本关联的最新 Issue Versions。

`board.selection` 表示当前选择；`prepare_delivery` 引导至交付流程，并保留选定的 Candidate 和 Selection 版本。创建另一个交付目录前，先运行 `selection inspect --issue ISSUE_ID --issue-version N --cwd CLONE`（已知路径时加上 `--path`）。根据返回的本地状态和下一步操作，安全重试未完成的准备、复用已就绪工作树，或保留已变化、无效、缺失的工作树以供诊断。Selection 变更或取消后，暂停旧的准备流程。共享看板状态不能证明本地工作树存在或交付已被采用。验证警告发生变化时必须检查，不能自动重新选择。将 `issue show` 的 `board.next_action` 用作导航依据，不能将其视为授权或盲目执行的命令。核对选定的 Issue Version、Repository 和 Baseline。恢复工作前，使用 `devrun context` 并检查本地工作树是否可用；缺失或已移除不代表可以接管另一台机器上的路径，无效状态需要诊断。本文未列出的筛选条件以已安装命令的帮助为准；不得编造命令或修改 `.grounds/` 内部文件。

如果仍有多个可能目标，只问一个简短问题让用户明确选择。不能为避免提问而选择最新 Candidate 或活跃 DevRun。状态无法读取时，应报告未知，不能解释为没有工作。只读进度请求应以状态和建议收尾，不执行后续操作。

## 选择工作流程

| 用户目的与已观察到的状态 | 工作流程 |
| --- | --- |
| 通过问答发现并修复团队文档仓库的知识缺口 | 切换到 [grounds-knowledge-improve](../grounds-knowledge-improve/SKILL.md)，不创建开发契约 |
| 将 Requirement 及其 Issues 发布到现有 Confluence 页面 | [导出到 Confluence](references/workflows/export-confluence.md) |
| 新增、不完整或已变化的业务意图或契约 | [定义需求](references/workflows/define.md) |
| 实现已封存契约、恢复可用的 DevRun，或修订 Candidate | [开发候选](references/workflows/develop.md) |
| 对一个 Candidate 的 Criterion 获取独立评估 | [独立验证](references/workflows/verify.md) |
| 开发开始时已确认：提交后自动独立验证，rejected 时自动修复，最多 3 次 Verification | 先读[开发—验证—修复闭环](references/workflows/auto-repair.md)，再按其要求使用开发与独立验证流程 |
| 解释代码、检查完整 Verification 结果、比较 Candidates，或准备交付 | [审阅与交付](references/workflows/deliver.md) |

只完整阅读选定的工作流程，再读取该流程要求的参考资料。共享准备协议跨阶段持续生效；业务写入前，或配置、版本状态变化时，需要重新检查。评测资产、实验、重评或报告使用 [grounds-eval](../grounds-eval/SKILL.md)，普通开发不要加载评测材料。

对于混合请求，保留用户的每项意图，只按需要串联相应流程。Verification 失败本身不能确定应修改代码还是契约：先检查发现，必要时澄清预期行为。相互冲突的报告仍与当前审阅相关；遵循交付流程的完整 Review Trace 协议，不只选择最新结论。不要仅为准备盲验而读取作者声明。

## GitLab 项目归档接入

需要首次接入、管理员配置引导、批量检查或权限漂移复查时，按 [GitLab 项目归档接入](references/gitlab-archive-onboarding.md) 使用公开 `repository archive-show/check/guide/template/bind`。共享绑定不是授权缓存；日常候选和落地归档重新核验当前项目及两个命名空间，不自动写 ACL 或成员角色。

## 保持授权与隔离边界

合适的下一步不代表已获授权。延续用户已有的授权范围，不重复索要已经给出的许可，同时遵守所选流程中的明确确认要求。发布契约前需要确认双方理解一致；仅要求发布不授权开发。开始开发时按闭环流程确认一次是否自动验证与修复；未确认则开发在提交 Candidate 后停下，确认也不授权 Selection、交付、清理或契约变更。准备交付不授权提交、推送、创建 PR、合并、部署或清理。

加载另一个工作流程是在选择指令，不是函数调用，也不会创建新的 Agent 上下文。独立验证时，遵循验证流程的协调者协议：创建新的验证者，只提供允许的盲验材料，不能提供协调者对话、开发记录、作者声明或凭据。不得通过给开发者 Agent 改名来把自验当成独立验证。宿主无法创建并继续该隔离上下文时，停止自动验证，并按协议提供人工交接。其他阶段不需要仅为切换流程而创建 Agent。

## 契约人工阅读入口

需要用户阅读 Requirement/Issue 时，按[定义需求流程的 HTML 审阅规则](references/workflows/define.md#read-only-contract-review)操作。JSON 草稿默认用 `contract render --workspace NAME` 提供本次本地活会话，支持同页阅读、区块编辑和明确保存；保存后通过 `workspace read` 核对实际 draft/version，再基于该已保存版本确认和发布。已发布固定版本、显式 `--output` 导出及降级快照保持只读，旧 Markdown 需要编辑时显式迁移。服务生命周期、失败/冲突恢复和来源不可得处理均按该流程执行；打开页面、保存或检查通过不代表发布或开发授权。

## 完成阶段后的交接

每个阶段结束后，先检查结构化结果再继续。在对话中保留简短交接：已确认的目标 ID/版本、相关工作树、已完成结果、尚未解决的事实、下一工作流程和剩余授权。这不是持久化实体，不能整份转交给盲验者。

下一步明确且在授权范围内时继续推进；否则明确指出缺少的选择、确认或能力并停止相关操作。区分已完成的工作与建议的下一步，不能因一个阶段结束就宣称整个任务完成。
