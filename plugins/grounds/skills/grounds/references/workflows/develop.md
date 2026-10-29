<a id="develop-a-grounds-candidate"></a>

# 开发 Grounds Candidate

每个 DevRun 保持隔离。DevRunContext 是完整开发契约；除明确修订外，不检查同级 Candidates。

目标分支与自身基础提交曾随 CLI 0.2.29 发行，TUI 0.2.30 精确配套；该轮按用户授权 unverified 交付，不能称独立验证通过。当前开发树在这套能力上增加目标预检与正式开发准入，不能据历史发行版本推断新门禁已安装或发布。

Issue 带 `target_branch` 时，契约 `baseline` 保留为定义快照，首次正式开发的 `base_commit` 必须是本次刷新并评估的目标提交；仅在目标历史中可达不再足以开工。refinement 先从父 Candidate 恢复成果并按需同步，准备现场不等于正式准入。Context 的 `preflight` 区分 `missing`、`preparing`、`admitted`；CLI/TUI 都不能把缺失或准备态当作通过。成功准入后正常开发修改不逐次触发重新审批，新的恢复/同步导致输入依据变化时再检查。

返回 Context 的 `base_commit` 用于捕获与重建，不能用 `baseline` 替代；`snapshot_relation` 仅提示本地历史关系，不证明目标新鲜或验收前提仍适用。跨基础 refinement 的 Review 将 `upstream_changes` 独立列出，不把它当作者贡献；Candidate 冻结实际基础，旧候选与报告不变。显式刷新只作用于已确认且授权的目标，不隐式 pull/reset 当前开发分支。无目标历史流程与真正固定起点评测保留原语义。公共交付门禁仍按[选择与交付准备](../delivery-preparation.md#target-flow-gate-and-landing)执行，开工准入不是独立验证、选择、合入或发布授权。

<a id="prepare-the-path"></a>

正式新 Git 工件封存和跨机器恢复按[候选 Git 归档协议](../candidate-archive.md)执行。归档提交保留真实 source 历史；历史 patch-only Candidate 已退出内容读取、恢复、修复前身、验证、选择与交付支持范围；遇到旧格式应报告 unsupported，不能自动迁移或转换。

新一轮开发开始前确定模式：用户本轮选择转成 `--development-mode simple|container`，优先于 `GROUNDS_DEVELOPMENT_MODE` 和配置 `development.default_mode`。用户可用 `config set-development-mode --development-mode MODE` 保存后续默认值。非交互调用没有任何来源时应明确报错，Agent 不代用户猜默认值。恢复同一 DevRun 沿用记录模式；旧历史没有记录时保留未知，不补造；新一轮重新选择。

`simple` 使用 CLI 所在的当前环境，无需 Docker 或 Grounds 环境定义；平台容器内同样如此。`container` 使用 Grounds 管理的隔离环境，准备失败不降级为 simple。两者都须遵守相同的契约、准入、候选与验证流程。

## 准备开发路径

遵循[共享准备协议](../../../../references/preparation.md)，包括写入预检。

若用户选择代码 Workspace，或已有 `code-workspace` 实例/路线，先按[代码 Workspace 与路线执行](../code-workspace.md)创建、绑定、准入或恢复。其目录由 `route-show` 返回，不要求下文旧流程的 `local_worktree`，不重复调用 `devrun plan/start`。完成这段准备后仍复用下文的同步、Candidate 捕获和提交协议。

`devrun start` 或恢复已有开放 DevRun 前，若用户尚未表态，按[开发—验证—修复闭环](auto-repair.md#confirm-once-at-start)确认一次是否在提交后自动独立验证并修复。

1. 通过 helper 查询 Issue 详情，确认准确的公开 Issue Version、Repository、Baseline Git OID。内部 Revision ID 不属于此流程。
2. 选择匹配的本地 clone，明确传给 helper 的 `--cwd`；Agent 进程可以从任意位置启动，不必改变当前目录。
3. 首次目标开发先取得 start 阶段成功刷新的观察及适用性结论，再运行 `devrun start ISSUE_ID --plan CONFIRMED_PLAN_ID --base-commit OBSERVED_TARGET_OID --preflight PREFLIGHT_ID --refresh`；拒绝开工时不能留下一个冒充已准入的新现场。读取返回 `local_worktree` 并逐项核对实际路径、`development.branch`、实际 base 与已确认计划，不能将任意位置成功当作计划兑现。目录/分支占用或计划失效时保留内容，展示差异。无计划的历史/固定起点评测仍使用 `<数据根>/repositories/<clone-key>/devruns/` 下的 detached worktree；不能把这条兼容路径当作新分支开工已完成。将 JSON 成功返回结构保存在权限为 `0700` 的临时目录。已有开放 DevRun 使用 `devrun context`；进度查询或不确定状态时先用只读 `devrun reconcile --dev-run DEV_RUN_ID`，它一次性汇总账本、本机工作树、受管执行与交付目录，返回 `overall`、`findings[]` 与只读或需授权的下一步，Agent 据此解释，不自动执行其中任何一步；未识别的本机状态按“需要检查”处理，不当作健康。只有本机 `local_worktree.status` 为 `available` 且目标流程已获得当前有效准入时，才继续实质开发；目录可用不等于门禁通过。`missing`/`preparing` 的预检状态先按返回的缺失项和 `next_commands` 补齐；旧开放 DevRun 只补录本次真实观察和当前输入，不补造原开工或定义历史。目录 `missing`/`removed` 时返回原机器，或为同一 Issue 新建受管路线；`invalid` 时停止并报告原因。不得在另一台机器重建或接管已有 DevRun。
4. 新模式只管理 Grounds 自己创建的目录/branch，不接入任意现有活动目录。原协议的 external-directory 用户保留读取/恢复路径：用户明确在旧协议中选用已有 Codex worktree 或 checkout 时，先运行 `devrun inspect-workspace ISSUE_ID --directory PATH`，核对 Repository、HEAD 和输入摘要；脏输入须明确接受。其 `ownership: external` 与初始输入来源保留，不归功于本 Agent，不 reset/stash/重建、移动或删除。外部目录不支持 refinement materialization；只使用目录，不附着已有 Codex 会话。不能添加 `--plan` 把该目录变成新受管路线。
5. 延续修复先通过 `devrun prepare` 和 `--refines-candidate` 恢复明确的父成果，确认 Context 指向所选父 Candidate，不检查同级 Candidate。准备态只用于恢复和受控同步，不能启动新一轮实质开发、模型执行或提交 Candidate。完成准备后，评估实际恢复输入、父成果和本次目标；输入或冲突处理改变判断依据时重新评估，取得匹配结果后通过 `devrun admit --refresh` 正式准入。没有新目标变化且输入与有效结论匹配时不制造同步或重复评估。本机父 Candidate 的受管分支路线默认复用路径/branch，以新 DevRun 记录本轮，旧 Candidate 和报告不变；独立并行方案显式使用另一个已确认 `--plan` 及 `--parallel-route`。同事恢复使用自己的计划与匹配 clone：Git 工件先按归档协议显式取回固定 source 并校验真实历史；历史 patch-only 工件明确不支持；不能接管另一机器路径。固定对象不可得就停止，不换最新代码；恢复须核对原 source commit、完整 parents 和结果树；运行环境另行准备。依赖 Git 编号/历史的验收材料不足时如实说明。不得另跑 `candidate materialize --mode existing` 覆盖活动目录。

新 target-flow 开工没有已确认计划时直接停止，不静默创建 detached 目录。`--legacy-fixed` 不能使普通目标 Issue 豁免预检、计划或新分支约束；固定评测/历史回放的例外必须由已有固定任务来源或原操作记录识别，不能只相信用户传入的布尔开关。既有 legacy completed/pending operation 的无 plan 重放由 CLI 读取原 SQL/本机 journal 辨认旧模式、固定原契约版本和回执；保持同一 operation，不以新增该开关或新 plan 重造现场。无 target 的历史/固定起点评测保持原语义，不跟随目标自动前移。

所有 CLI 调用使用共享 helper。首次目标开发的观察与评估顺序如下；评估文件格式和依据要求见[发布前的适用性判断](define.md#发布前的适用性判断)，但这里必须使用 start 阶段及精确 Issue Version 的观察，不能拿发布阶段记录替代：

```text
preflight observe --phase start --issue ISSUE_ID --issue-version ISSUE_VERSION --refresh
preflight assess --observation OBSERVATION_ID --file ASSESSMENT_JSON
preflight show PREFLIGHT_ID
```

必须检查 `observation.refreshed`、具体目标提交及失败信息。取得匹配的有效结论后，以它的 `assessment_id` 作为 `PREFLIGHT_ID`，以实际观察的完整 OID 作为 `OBSERVED_TARGET_OID`：

```bash
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$REPOSITORY" -- \
  devrun start ISSUE_ID --plan PLAN_ID --base-commit OBSERVED_TARGET_OID --preflight PREFLIGHT_ID --refresh
```

### 延续开发的准备与准入

新一轮修复先恢复明确父成果；已有开放 DevRun 则使用原 ID，不另造现场：

```text
devrun prepare --issue ISSUE_ID --plan PLAN_ID --refines-candidate PARENT_CANDIDATE_ID
devrun prepare --dev-run EXISTING_DEV_RUN_ID
```

两行是两种入口，不连续执行。准备成功后按需执行下文受控同步并解决冲突，再观察具体 Run 的实际输入，不能拿仅绑定 Issue 的首次开工评估替代：

```text
preflight observe --phase start --dev-run DEV_RUN_ID --refresh
preflight assess --observation OBSERVATION_ID --file ASSESSMENT_JSON
devrun admit --dev-run DEV_RUN_ID --preflight ASSESSMENT_ID --expected-version DEV_RUN_VERSION --expected-head QUALIFIED_CURRENT_HEAD --refresh
```

`--expected-head` 和版本来自本次实际现场及公共上下文，不猜测或沿用同步前的值。观察后 HEAD、index、文件内容、父成果或同步依据变化时，准入拒绝并保留现场，重新检查当前输入后再继续。准入结果只表示本轮可开展开发，不表示候选已通过验证。已完成操作的重试保持原 operation ID，回放历史回执不重新建立工作树或补造许可；是否仍可继续应读取当前上下文。

## 本机简洁模式（默认）

创建 DevRun 后，当前 Agent 直接在返回的 `local_worktree.path` 内开发，沿用用户当前终端的工具环境和 Agent 原生界面。不需要容器、环境定义或认证导入，也不需要再启动一个开发 Agent。Codex 或其他能遵守 Skill/CLI 协议的 Agent 均可走这条路径；这不代表 Grounds 已实现每种 Agent 的受管启动器。

受管分支 worktree 和历史 detached worktree 都只隔离代码目录，不隔离本机进程、端口、权限或全局依赖。沿用终端环境也不等于自动采用当前代码目录；使用既有 external-directory 仍按原协议检查。用户直接观察当前 Agent 的终端/界面；Grounds 保存 DevRun、Candidate 和显式提交的证据，不自动采集整个外部会话，也不为这条路径伪造执行记录。

完成后直接按下文 `candidate template/submit` 路径捕获和提交，无需为记录成果而运行其他命令。遇到未完成或无法解释的状态时，先用 `devrun reconcile` 查看，不能改走普通提交来绕过。

<a id="local-environment-commands"></a>

## 本机环境命令

本节只描述旧 `grounds env` 独立任务入口；共享缓存、固定多仓库基线与受管 Git 的新路线按[代码 Workspace](../code-workspace.md)执行，不能将两套挂载、网络或 Git 权限约定混用。

`grounds env` 提供执行与资源管理。协调者负责契约读取、目标新鲜度、准入、Agent 创建与续接、阶段材料、成果接收、授权推送和 CLI 上报。环境不自行推进业务阶段、追随目标或重跑 Agent。命令用法以当前 `grounds env --help` 和分发机器契约为准：

```text
env up [--workspace DIR] [--definition NAME]
env list
env run ENVIRONMENT_ID --argv-file FILE [--timeout-seconds N]
env cancel RUN_ID
env logs RUN_ID [--tail-bytes N]
env down ENVIRONMENT_ID
```

当前任务仓库没有定义时采用可信 `host`，支持 macOS/Linux；它没有文件、网络或同 UID 进程隔离。无效定义、能力不足及 Docker 准备失败明确报错，不静默切换 host。host 的 `base.setup` 是可信本机执行，其副作用不承诺自动回滚。

Docker 是完整任务 Agent 的隔离路径：协调者用任务式 Agent CLI 运行整个开发或验证 Agent 及其工具子进程；仅将测试命令放进容器不能称 Agent 已隔离。每轮仅有当前 Issue 的一个目标仓库，使用普通独立 Git 仓库和 `.git`，不共享宿主对象库、活动工作树或主账本，不接管 Git 指针。额外上下文只通过明确配置且获准的查询工具取得，不能扩大材料或修改范围。

仓库定义 `.grounds/environments/*.yaml`、构建配方及明确引用的非敏感输入可以版本化。私有凭据、日志、报告交接和控制记录不进入候选树；定义不能把任意私有路径变成捕获输入。准备时固定定义摘要、镜像身份和有效配置，任务内改定义不触发热更新或自动重跑。Docker 默认正常出站联网；显式禁网与在线 Agent 冲突时拒绝。资源默认值与逐项覆盖在准备前校验并可见；超限不自动提额。

凭据声明不是授权；协调者先解析并核对当前任务 Repository ID，再使用宿主对仓库、环境及引用的授权，只注入获准私有副本。同一来源续期由认证组件处理，范围、账号及来源固定；环境不自建刷新协议。任务私有服务按声明创建并等待就绪，共享服务必须显式获准引用，不因任务结束停止或重置。

命令退出不代表开发或整轮验证完成。停止、代码/Git 对象已交接至清理后仍保留的仓库、必要报告已上报或保留重试材料，均须由协调者核对；环境通过安全收尾后才回收本次临时资源。未提交现场、异常 Git、未知终止、交接失败均保留并报告，不自动归位、删除或重跑。日志默认只在受限本机保存，额外产物显式收集。调用方原工作区、宿主凭据、Candidate 保活引用及业务恢复记录不属于环境清理范围。

## 目标分支同步与恢复

目标流程的受管分支及兼容 detached worktree 支持；外部目录、无目标历史流程和固定任务起点的 Eval 不支持。开始开发前在已有授权内按 Issue 封存的 remote/ref 和真实 fetch 映射刷新并完成适用性预检（不猜 origin/main、不更新本地开发分支），首次采用已评估的目标提交开工；历史可达不代替准入。已有 DevRun 开发前和提交 Candidate 前，在已有刷新授权内通过 helper 运行 `devrun sync-status --dev-run ID --refresh`；默认不带 refresh 的查询离线且标记未刷新，不能把本地跟踪引用当作最新远端事实。

发现 advanced 时说明目标 OID、当前 base、契约关系；用户确认后才执行：

```text
devrun sync --dev-run ID --expected-version DEV_RUN_VERSION --expected-head QUALIFIED_OBSERVED_HEAD --target-commit sha1:EXPECTED_T --refresh
devrun sync-show --sync SYNC_ID
devrun sync-complete --sync SYNC_ID --expected-version SYNC_RECORD_VERSION --file DECISIONS_JSON
devrun sync-abandon --sync SYNC_ID --expected-version SYNC_RECORD_VERSION
```

target-commit 必须是完整带算法 OID，和刷新观察一致且是原 base 后代。新受管分支还须传 `sync-status` 返回的 `local_worktree.head` 作为 `--expected-head`，不能用陈旧 HEAD 或分支名替代；旧 pinned 同步不要求且不传此参数。同步要求已提交且没有未完成 Git 操作的输入，保留原 source 与目标的真实 merge parents，完成后目标成为新逻辑 base；用户已手动纳入同一目标的路线可在校验后只前移逻辑 base，不重复制造 merge parent。多次 checkpoint 的新 Candidate patch 仍覆盖该 base 到固定结果的全部需求改动，不把上游变化当作者贡献。sync 使用 DevRun 版本；complete/abandon 使用 **sync 记录版本**。恢复先 show，不猜版本；同次重试保留 operation ID。预约在错误后可能已存在，错误信封的 operation ID 就是 start 的 sync ID，先查询，不另起同步绕过未决记录。无冲突自动完成；有冲突返回 resolving，先解决真实工作树/index 中的冲突，涉及业务取舍先问用户，再显式完成。decisions 文件是 `[{"path":"file","explanation":"采用上游实现及其理由"}]`；每条冲突路径都需要说明，完全采用上游而零差异也必须记录。无冲突的中断恢复可省略 file。同步记录属于作者上下文，只在 Review 展示，不放入盲验。Git 无冲突不免验，旧报告不迁移到新候选。

sync_interrupted 是已知生命周期。文件部分应用时，不重跑应用覆盖后来的编辑：先 reconcile/show，若文件已完整应用可 complete；否则显式 sync-abandon 会先保存现状，再恢复原 base、原始 index 与原始文件内容/权限。恢复过程中再中断，可再次显式放弃，每次保存新编辑。SQL 完成而本地状态未更新时，complete 只收敛状态，不重新应用文件。已完成 SQL 的同步不能反向 abandon；已有完成回执但 SQL 未完成、文件又变化时，不复用旧回执，需明确选择放弃并保留编辑。

恢复材料位于 recovery.directory，包括 raw blob/index、saved_edits 和 displaced 目录；只存在本机，保留供检查，uncommitted 会提醒，普通 cleanup 不删除它们。其他进程的 index.lock 不得删除；控制器死亡后仍保留本机 DevRun 锁60秒孤儿宽限，busy 时使用正常恢复机制而非删锁。同步中不能捕获/提交、清理或 abandon DevRun；先完成或放弃**同步**。路线正被 `env run` 租用（reconcile 的 `route_lease.held` 为 true）时，先等执行结束，或用 `env cancel RUN_ID` 取消；未完成捕获/注释先通过原协议释放。当前不能完整恢复子模块 checkout，含 gitlink 的输入明确拒绝；外部 filter/encoding、特殊文件和硬链接也不支持。失败保留输入，不手改 journal。

目标改写导致 base 不可达时，停止同步/捕获，原工作树保留，以新的可达 base 新建 DevRun，原改动仅作简报。上游改变验收前提时停止并修订契约；普通 base 前移不自动要求新 Issue Version。终态后重取 context，使用新 base/版本，不能沿用同步前模板或把源码 commit 当作同步。

<a id="develop-from-the-context"></a>

## 按上下文开发

- 将 `data.context` 作为 `patchledger.devrun-context/v1` 读取；其他格式停止。
- 只实现封存 Goals/Constraints。Guidance 是非排他的建议。
- 新受管分支模式允许获授权范围内的普通 Git checkpoint；HEAD 正常前进，逻辑 base 不等于直接 parent。日常提交只作本地存档，不自动创建 SQL Candidate。commit、同步/冲突取舍、push、MR/merge 各依其实际授权，开发或送验授权本身不隐含远端操作。历史 detached 与固定起点评测仍要求 HEAD 固定在其有效 base，不 commit/rebase/merge。

### 实现前明确检查方法

读取相关实现与现有测试，将每个 Criterion 对应到可观察结果及适合的检查；可以复用已有测试、静态检查或人工操作，不要求每个 Criterion 单独新建测试。多步骤工作在对话中简述“改动 → 检查”，不另建计划实体或修改封存标准。普通实现选择依据仓库惯例自行决定；发现会改变目标、行为或验收含义的歧义时，指出具体条目与影响，暂停受影响的实现并转回定义流程，不能默选一种解释。

缺陷修复先取得能复现问题的测试或最小检查，再验证修复；无法复现时保留观察缺口，不声称已有回归证据。重构先记录相关行为基线，再检查改后是否保持。对已有失败区分基线问题与本次回归，不通过削弱断言或修改验收预期让检查变绿。

### 以契约约束复杂度与改动范围

- 优先复用现有模式，采用满足当前契约的简单实现。新增抽象、配置项、依赖或通用扩展机制要有当前需求依据，不能只以“以后可能用到”为由增加复杂度；安全、兼容和错误处理等既有义务仍须满足。
- 改动限定在实现和验证契约所必需的范围，包括受影响的调用方与文档；不顺手改写邻近代码、注释、格式或无关模块。必要重构说明它支持哪个目标、为什么现有结构不足；不以行数最少替代正确性或仓库约束。
- 清理本次修改造成的无用导入、变量和函数。既有无关死代码或缺陷只报告，不擅自删除或修复。保留用户及其他任务的改动，不用 reset/stash 或批量清理来缩小差异。

### 自验并检查完整候选差异

运行上述聚焦检查及仓库要求的验证，保存实际命令、退出码和有界输出供 Evidence 使用。检查失败时，在当前开发授权内修复实现并重跑受影响检查；已有通过结果只在后续变化可能使其失效时重验，仓库强制门禁仍须执行。环境或证据不足时记录准确缺口；需要新授权、外部条件或契约变化时暂停相关步骤，不把反复重试当作进展。自验不能替代独立 Verification，也不自动启用跨 Candidate 的验证—修复闭环。

生成 Candidate 前检查实际 base 到当前成果的完整差异，以及待捕获的 tracked/untracked 文件。每处变化应能说明与契约的关系；`supports`、`generated` 或 `incidental` 等说明分类不是纳入无关改动的许可。只移除自己产生且不应进入 Candidate 的临时产物；来源不明或混有其他任务改动时先查明，不能一并捕获或直接删除。最终检查结果与局限填入对应 Criterion 的 `self_verification` 和 Evidence，不把“代码已写完”当作完成验收。

受管分支归档只接受完整的已提交 source commit。dirty tracked/untracked 输入先展示差异，并在本轮已有 commit 授权内完成正常提交；范围不明或未获 commit 授权时保留现场并询问，不自动 stash/reset。未完成 merge/rebase/cherry-pick/revert、unmerged index 或未知 branch 切换先通过对应 Git 恢复流程解决，不能因表面干净就归档。source commit/parents、完整 binary patch/digest、文件清单与 result-tree 固定，source 树须与工件一致；归档重试沿用操作身份，Git/SQL 中断先检查，不能跟随被改写的 Candidate ref。

送验后默认作者暂停推进并等待结果。这个策略不停止已授权独立验证和缺陷修复闭环。只有用户明确要求并行时，以观察到的 HEAD 和 DevRun 版本通过 `devrun continue --dev-run ID --expected-version V --expected-head QUALIFIED_HEAD --policy parallel` 记录；可用 `paused` 恢复暂停。CLI 不能阻止用户从外部终端自行改代码，因此展示时总核对当前 HEAD：旧候选 qualified 不代表后续提交已验证。报告始终绑定固定 Candidate，验证使用独立目录，不读取最新活动文件。

`continue`重试返回的是原operation历史回执，不能把其中parallel当成当前继续许可。当前决定按SQL event_seq顺序；parallel(A)后paused(B)，重试A不得覆盖B。重试后读取`devrun context`的当前本机状态；SQL成功但marker未完成时原operation只能恢复当前最新决定。显示invalid/恢复原因或路线、owner、HEAD、版本不匹配时保留现场并停止其他写入，不手改marker或换operation绕过。expected-version仍表示该DevRun轮次版本，当前许可不从timestamp、branch名或旧回执推断。

<a id="build-the-candidate-draft"></a>

## 生成 Candidate 草稿

中文用户或中文 Issue 的人工 Candidate 文本全部使用中文：全局/目标/Criterion 实现说明、自验方法与结论、Change Rationale、被否决方案和风险。代码符号、路径、命令和原始 Evidence 不变。生成和提交都使用 `--content-language zh-CN`；提交门禁会在写入前提示明显英文文本。不得为通过语言检查改变真实声明。确需英文时说明字段，并传准确的 `--language-override-reason "..."`；CLI 输出 override 警告。

通过 helper 生成包含完整 ID 的可编辑草稿。骨架由原生 CLI 生成，helper 只提取 submission 并写入 mode-0600 文件；Agent 不重建 ID，也不处理模板返回结构：

```bash
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" \
  draft candidate --cwd "$WORKTREE" --dev-run "$DEV_RUN_ID" --output "$SUBMISSION_JSON"
```

中文工作在此草稿命令和下文 `candidate submit` 命令中都加 `--content-language zh-CN`。

只编辑生成的 `patchledger.candidate-submission/v2` 草稿，不能从文字评估重建。原生 CLI 捕获当前受管工作树，并将 Artifact/Change Index 指纹放入 `change_index`。每个 `change_rationales` 条目已有准确 `change_ref`，其 `TODO:` 理由中带路径/范围。替换全部 `TODO:`，选择真实 `relation`（`implements`、`verifies`、`supports`、`generated`、`incidental`），并在 `target_refs` 中填写一个或多个 `{"type": "criterion", "id": CRITERION_ID}` 对象，ID 取自生成 Claims 中的 Criterion；不能直接填 ID 字符串。记录有意义的否决方案和风险；确实没有时才使用空数组。先全局说明 Candidate，再说明每个 Goal/Constraint 和 Criterion。将类型化 Evidence 附到最具体的 Criterion；没有证据时保持空 evidence 数组。Change Unit、目标或 Criterion 缺失、重复、多出或仍有占位时拒绝提交。不编辑 `change_index` 或 `change_refs`；工作树变化影响 patch 后重新生成草稿。

每个 Criterion 保留 `explanation` 作为实现说明，另填 `self_verification`。这是**自我验证（self-verification）**，不是独立 Verification。只有真实检查后才用 `satisfied`、`partially_satisfied`、`not_satisfied` 或 `inconclusive`；记录 `method`、描述结论/局限的 `explanation`，并将支持的类型化观察放入该 Criterion 的 `evidence`。代码审查也可以是检查，不编造测试执行。未检查则用 `not_verified`、说明原因并省略 `method`。历史缺字段表示未记录，不代表成功。不要填目标级状态，CLI 从 Criterion 检查推导计数。不得为提交将真实失败改为成功。

<a id="coach-rationale-quality-before-submission"></a>

## 提交前指导理由质量

填好生成草稿后，阅读[理由质量指导](../rationale-quality.md)。针对准确 Change Units/Criteria 应用四维评分；作者必须确认修订文案。分数仅供建议：不因分数阻止结构合法的提交，不写入 Candidate JSON，不推断缺失动机。作者无法解释选择时保留未知。工作树变化后重新生成草稿，再检查准确覆盖和占位。

<a id="submit-and-retain-results"></a>

## 提交并保留结果

使用 DevRun ID 和准确 Context 版本提交。将 `local_worktree.path` 作为 `--cwd`，让 helper 对实际提交文件计算指纹；Agent 进程不必进入该目录。CLI 也会从 DevRun ID 独立解析同一受管路径：

```bash
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$WORKTREE" -- \
  candidate submit DEV_RUN_ID --file SUBMISSION_JSON --expected-version VERSION
```

helper 只重试可重试的 `STORAGE_TRANSIENT`，复用 operation ID；若按内容推导的工作树 result-tree 指纹变化，拒绝 Candidate 重试。所有冲突重新读取并判断。

成功后删除提交草稿并报告 Candidate ID；失败草稿保留。已确认闭环时，回到[闭环流程](auto-repair.md#run-each-round)继续独立验证；否则在此停下。`devrun abandon` 前先运行 `devrun uncommitted`（或 `devrun reconcile`）并展示该 DevRun 的未提交改动提醒，说明这些改动只存在于本机、账本不可见；再展示 ID/版本与原因，取得明确确认。CLI 在写入前也会通过信封 `warnings` 返回 `DEVRUN_UNCOMMITTED_WORK`，但它不替代你在执行前的展示和用户确认。

外部目录清理只解除 Grounds 引用/租约，保留源码，即便使用 `--discard-changes`。缺失或无效的外部工作树不得重建。

工作树清理是独立、明确的维护操作。提交或 abandon 后不自动执行 `devrun cleanup`。`devrun cleanup` 实际删除受管工作树时，CLI 在账本追加一条 `devrun.worktree_removed` 事件（`facts` 含 `dev_run_id`、`worktree_path`、`discard_changes`、`entry_count`）并在返回中给出同一份 `deletion_summary`；它是带稳定 Agent 身份和幂等 operation ID 的写操作，由 helper 注入。仅 detach 外部目录、工作树已缺失或已移除、以及被拒绝的清理都不写事件；中断后重试会补写同一事件而不重复删除。**Grounds 不提供删除前归档，删除不可恢复**；需要保留内容时，清理前自行归档。清理前先运行 `devrun uncommitted`（或 `devrun reconcile`）并展示终态 DevRun 与未提交改动提醒（只存在于本机、账本不可见），再询问；如果提示会丢失本地变化或忽略文件，先检查并取得明确确认，再用 `--discard-changes` 重试。换机或恢复工作前给出建议时，同样先展示该提醒：本机未提交工作不能跨机器接管，应回到原机器或先捕获/导出。

<a id="implement-review-feedback"></a>

## 实现审阅反馈

Candidate 不可变。验收标准未变时，使用 `--refines-candidate PARENT_ID` 开启新 DevRun，并在 `--exploration-brief` 或 `--brief-file` 中记录明确反馈。提交新 Candidate，保留父版本，不迁移其 Verification/Selection。契约变化时返回定义流程，发布下一 Issue Version。提交后报告父/新 Candidate ID，说明用户可通过交付流程审阅、验证并明确重新选择；已确认闭环时由闭环流程继续独立验证。不创建 Feedback 实体或评论解决状态。
