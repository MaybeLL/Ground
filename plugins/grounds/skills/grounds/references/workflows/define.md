<a id="define-grounds-work"></a>

# 定义 Grounds 工作契约

将初始请求转为用户确认的 Requirement 和一个或多个可直接执行的 Issue Version。CLI 是持久化状态的权威来源，契约草稿（Contract Draft）是唯一可编辑表示。不得另建需求细化简报，也不向用户暴露面向存储的 create/revise 命令。

<a id="prepare-safely"></a>

## 安全准备

遵循[共享准备协议](../../../../references/preparation.md)，包括账本写入预检。例外是草稿的本地 `draft new/list/show/read/save/edit/resolve/migrate/bind` 和无 `--output` 的 `contract render --workspace NAME`：只检查 CLI 安装和命令能力，不要求数据库预检通过，不因远端数据库不可达或 schema 不兼容阻止本地编辑；这些命令不写账本。本地操作仍须配置账本身份。`draft open` 读取已发布来源、发布和远端查询仍按完整准备协议执行。

1. 发布 Repository、Requirement 和 Issue 时，要求 `GROUNDS_AGENT_ID` 和 `GROUNDS_AGENT_NAME`。遵循可选的 `GROUNDS_CONFIG`，只解析 CLI 的 JSON 返回结构。
2. 使用 `config path`、`config validate`、`db test` 和 `db status` 做只读诊断。在 `init`、`--reconfigure` 或 `db migrate` 前，展示准确的 driver、配置路径、目标数据库、Baseline 策略及变更内容，再取得明确确认。不得暴露 MySQL 密码。
3. 对非交互的空 MySQL 或 PostgreSQL 目标，将该确认转为 `--confirm-initialize`；使用 `--baseline-policy require_override`、准确的 `--tls-mode` 和可选 `--ca-file` 参数。当配置的密码来源是 `environment` 时，MySQL 只通过 `GROUNDS_MYSQL_PASSWORD`、PostgreSQL 只通过 `GROUNDS_POSTGRES_PASSWORD` 提供密码。不得初始化无法识别的非空数据库，也不得仅为通过配置而迁移另一个数据库。
4. 创建和编辑草稿可从任意目录开始，统一保存到数据根 `drafts/<database-id>/<name>/`；发布及依赖代码的分析才要求具有受支持 remote 的 Git clone。发现阶段只检查本地配置；若存在多个 remote，展示不含凭据的选项，询问哪一个是权威来源，不猜测 `origin`、`upstream` 或 `--remote` 值。确认目标并取得刷新授权后，按下文目标预检流程显式刷新，再开始依赖代码现状的需求分析；不能因为尚无刷新授权就沿用缓存引用并继续发布。将选择传给 `draft new/open`；Repository 注册仍通过公共入口或发布事务完成。

CLI 操作通过以下方式调用：

```bash
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$CLONE" -- COMMAND
```

helper 按需提供 JSON 模式、配置、Attribution 和幂等数据。已安装 CLI 若缺少下文所需 Workspace 命令，报告版本不匹配并停止；不得回退到 `quickstart create`、`requirement create/revise` 或 `issue create/revise`。

<a id="open-one-authoring-workspace"></a>

## 创建或打开契约草稿

- 用户使用中文或要求中文审阅材料时，用 `draft new NAME --content-language zh-CN` 创建草稿。已有 Workspace 保持 CLI 管理的结构，以下自然语言字段使用中文：Requirement 的 Summary、Context、Outcomes、Decisions；Issue 的 Summary、Context、Goals、Constraints、Criteria、Guidance。代码标识、命令、路径、专有名称和引用的原始证据保持原样。英文 Markdown 章节标题（如 `# Summary`、`## Goals`）是解析器语法，必须保留。不得原地翻译已发布 Version。
- 新意图使用 `draft new`。在非 Git 目录创建的草稿未绑定仓库；发布前用 `draft bind NAME --remote-url URL --expected-version DIGEST` 显式绑定，并在对应 clone 中核对仓库和基线。已有 Requirement 或 Issue 可先按需读取当前投影，再用 `draft open` 默认准备唯一 JSON draft 与受管的已发布 base。
- 只有 CLI 的选择规则能唯一确定 Workspace 时，才允许它自动选择唯一 Workspace；否则明确传入用户选定的 Workspace。
- 不得手工构造或修复 `.grounds/` 内部文件。manifest、base snapshot、receipt、ID、版本和操作数据均由 CLI 管理。
- JSON 工作区：用 `draft read NAME` 获取 `draft` 与 `version`，编辑 draft 输入后用 `draft save NAME --file DRAFT.json --expected-version DIGEST`。输入文件只作本次命令输入，不作第二份草稿真源；不得直接编辑 `.workspace.json`。用户默认用 `contract render --workspace NAME` 在统一 HTML 页面阅读、按区块编辑并显式保存；`draft edit NAME` 保留为同一实现的兼容入口。
- CLI 保存是显式替换结构化 draft：调整 outcomes/decisions 顺序时，必须同时核对对应 `traces_to` 序号；不能只重排数组而保留改变含义的关联。HTML 排序会维护当前绑定的关联，仍被引用的条目须先处理关联才能删除。
- 历史绑定 Issue 和 Requirement 同时修改时，发布拒绝静默重绑。若要保留历史绑定，先暂存 Issue 改动、仅发布 Requirement，再恢复 Issue 改动单独发布；若要主动重绑，用 `draft open issue ID --bind-requirement current --name NAME` 在独立工作区明确选择当前来源并核对关联，不直接改受管 ID。
- 本地 `new/list/show/read/save/edit/resolve/migrate/bind` 无需数据库连接；保存不发布。摘要冲突时保留自己的改动、读取最新内容后比较并重新保存，不强制覆盖。
- 旧 Markdown 工作区仍编辑 `requirement.md` 和 `issues/*.md`；新建可用 `--format markdown`。只有明确要求转换时才用 `draft migrate NAME`（可先 `--dry-run`），保留 `legacy/` 备份；转换前停止旧 CLI 和外部写入者。迁移不是发布，不自动转换已存在草稿。转换保留解析后的语义与顺序，不保证原文排版和注释的字节级保留；原始字节在备份中，导出 Markdown 仅为只读派生材料，不与 JSON 双向同步。

<a id="clarify-and-model-the-intent"></a>

## 澄清并建模意图

先检查相关仓库文档和代码边界，不询问可以本地查明的信息。只询问证据无法决定的意图、优先级和取舍。

只有不同答案会实质改变业务范围、对外可观察行为、验收标准或用户必须决定的取舍时才提问。常规实现细节依据已有证据和授权解决。剩余问题不再影响契约能否实现和独立评估时，停止提问。

区分用户已确认的要求、从来源查明的事实和 Agent 的推断；会影响契约的推断先在草稿中标明依据与待确认之处，不写成已确认 Decision。若较简单的方案已能满足目标，说明它与复杂方案的实际取舍；不把假想的未来扩展、配置能力或实现偏好升级为强制要求。

需要澄清时，每次回答只提出一个阻塞问题，并等待答案。给出建议答案、依据和主要取舍。优先解决其他问题所依赖的决定。每次答复后重新判断哪些问题已解决或无需再问。先解决上游业务歧义，再询问下游实现契约；除非新证据与之冲突，不重新打开已确认决定。

编写或修订契约前，阅读[自包含契约](../self-contained-contracts.md)。读取相关来源，将每项会改变实现或验收的要求提取到 Workspace，并区分原始遗漏与后续来源变化。外部参考提供证据和来源，不能成为核心规则的唯一说明。

按以下方式建模：

- 一个 Requirement 按顺序记录 Summary、Context、Outcomes、Decisions 和业务级 Open Questions，承载跨 Repository 的稳定业务意图。
- 每个 Repository 专属开发契约创建一个 Issue 草稿，**按 Repository 拆 Issue，不按功能拆**。同一个 Requirement 在同一个 Repository 上只允许一个 Issue：把该仓库的全部改动收进这一个 Issue，用多个 Goal/Constraint 表达不同功能及其 Traces To，而不是为每个功能各建一个 Issue。
- 需要分阶段上线同一个仓库时，用两个 Requirement 表达，各自一个 Issue；不要靠给同一 Requirement 追加第二个 Issue 来分阶段。仅当人已明确确认存在例外，才在发布时使用 `--allow-second-issue-per-repository --override-reason "..."`。
- 不因为仓库级约束就把跨仓库的工作合并或拆分：Issue 仍然是单仓库、单 Baseline 的封存契约。
- 将强制 Requirement Decisions 转为可验证的 Constraints。
- Goals 表达可观察结果，Constraints 表达强制边界，而非实现步骤。每个 Goal/Constraint 至少有一个可独立判断的 Criterion；可选证据建议放在 Guidance。
- Criterion 应让独立验证者能区分符合与违反要求的结果：按需要写清触发条件、预期行为与相关边界。避免仅写“实现完成”“测试通过”或指定函数必须存在；只有实现方式本身是已确认约束时，才将其纳入验收。可选的测试命令和探针放 Guidance，已确认的强制验证要求仍保留为约束；某套测试通过不能替代实际行为要求。
- 只有会实质改变契约时，才检查失败行为、兼容、迁移、安全和性能。
- Decision 详情可选；JSON draft 直接编辑对应字段。仅旧 Markdown 格式保留 `### [decision-N]` 和 `#### Rationale`；本地背景使用 `#### Context`，`#### Details` 下用一个 YAML 代码块承载 `options`、`chosen_option`、`trade_offs`、`consequences`。此嵌入块属于 requirement.md，不是独立契约文件。Option 包含 `key`、`description` 和可选 `benefits`/`costs`；记录 options 时必须选择恰好一个本地 key。Trade-off 包含 `gain`、`sacrifice`、`reason`；Consequence 包含 `kind`（benefit/obligation/risk/limitation）和 `statement`。不得编造备选方案或补造缺失详情。Consequences 是预期效果；强制效果须明确转为带 Criteria 的 Issue Goals/Constraints。
- 保持作者定义的顺序。JSON 使用 `traces_to: [{type, ordinal}]`；仅旧 Requirement Markdown 使用 `[outcome-N]` 和 `[decision-N]` 标记条目。在每个有贡献的 Goal/Constraint 中，添加 `#### Traces To` 列表，引用相关的 `outcome-N` 或 `decision-N`。Intent Links 只在与该 Issue Version 一起发布的 Requirement Version 内精确有效；不得根据措辞相似编造链接。

在 Workspace 记录未解决的不确定性，不编造答案。Requirement 可以发布业务级 Open Questions。Issue 草稿细化时可以暂存 Open Questions 和临时 Assumptions，但它们都不能进入 Issue Version。

及时将已确认结论写入当前 Workspace。简要展示本轮变化与未解决问题，必要时提供完整草稿入口。用户要求局部修改时，说明其对关联契约条目的影响。

### 目标分支与开发位置计划

受管分支开发必须在分析代码前确认 Repository、权威 remote 和最终目标完整 ref。目标可以是团队的某个 release 分支，不能猜 main/master，也不能用当前 checkout 替代目标。在已有刷新授权内执行 definition 阶段的显式目标观察，以成功刷新的具体提交作为本轮代码分析依据，保留 OID、观察时间和来源。没有授权、刷新失败或历史不足时，可继续讨论业务意图和离线编辑草稿，但暂停依赖最新代码的分析及正式发布；记录“未刷新”不等于完成检查。此前同任务同目标的有效确认与刷新授权不重复询问。重新进入一轮依赖代码现状的定义分析时刷新；仅反复读写同一草稿不暗中联网。

用户明确了最终合入分支时，在 JSON draft 的 Issue input（`draft.issues[].input`）中填写 `target_branch: {remote: origin, ref: refs/heads/main}`，旧 Markdown 工作区则写入 Issue frontmatter（仅示例，不能默认照抄）。remote/ref 必须来自用户确认；Workspace 会校验 Repository 身份、完整分支 ref 和 fetch 映射，目标 Issue 的正式发布还须有匹配的发布阶段预检并在显式刷新授权内重新确认目标。离线 dry-run、可达性标记或定义时的旧观察都不能代替发布前检查；不向普通草稿读写命令增加隐式 fetch。此字段属于封存 Issue Version，变更或移除都需新的 Issue Version；不能通过移除字段或旧命令入口绕过既有目标流程的门禁，旧版本没有此字段则不补猜。Baseline 仍保留为契约快照，不因声明目标而自动改写。目标声明和实际可用的同步/门禁能力分开核对，不能仅见声明就认为开发流程已经支持同步。

支持 `devrun plan` 的 CLI 可在发布前预约本机位置；先解析已登记的 Repository，尚未登记时在需求定义授权内使用公共 Repository 注册入口。新建计划通过 helper 调用：

```text
devrun plan --issue-slug READABLE_ISSUE_SLUG --repository REPOSITORY_ID --definition-commit QUALIFIED_DEFINITION_COMMIT --target-remote CONFIRMED_REMOTE --target-branch refs/heads/CONFIRMED_TARGET
```

可明确指定 `--branch grounds/NAME`；不指定时使用返回的受管分支名。只有刷新获授权时加 `--refresh`。helper 固定本次 operation ID；跨调用重试必须保留返回操作身份，不能重新生成计划冒充重试。保存返回的 plan ID（`workspace_id`），展示其绝对 `path`、`branch`、目标、定义提交和观察时间，说明 `git_created:false`、工作树和分支尚未创建。这个 ID 指开发路线，不是 authoring Workspace。计划只存本机，路径不能成为共享 Repository 身份。冲突保留原内容，不自动换位置。若 CLI 无此能力，明确版本限制，不编造计划已登记。

正式开工时按[开发流程](develop.md)完成 start 阶段预检，再把匹配结论交给 `devrun start`；计划本身不是开工许可。核对实际路径/分支与已确认计划相同，首次开发必须采用本次刷新并评估的目标提交作为 base。目标正常前进且契约仍适用时沿用契约，验收前提或业务意图改变时先修订。定义参考提交、发布时观察的目标、实际 base 和每个候选 source commit 各自保留，不覆盖旧版本。

<a id="发布前的适用性判断"></a>

### 发布前的适用性判断

以下命令均通过本文件开头的共享 helper 调用；示例标识替换为实际返回值，不手造观察或评估记录：

```text
preflight observe --phase definition --repository REPOSITORY_ID --target-remote CONFIRMED_REMOTE --target-branch refs/heads/CONFIRMED_TARGET --refresh
preflight observe --phase publish --workspace NAME --expected-version REVIEWED_WORKSPACE_VERSION --refresh
preflight assess --observation OBSERVATION_ID --file ASSESSMENT_JSON
preflight show PREFLIGHT_ID
```

`observe` 返回成功信封仍需检查 `observation.refreshed`、具体 `commit` 和 `failure`；保存了一次失败观察不等于远端刷新成功。发布观察中的 `--expected-version` 是 Workspace 的审阅版本，不是 HTML `content_digest`。`assess` 返回的 `assessment_id` 用于后续 `--preflight` 绑定。

评估文件只包含作者评估输入，不包含服务端分配的观察/评估ID、时间或状态。下面是未完成评估的安全示例，不能原样当作通过结论；`author` 必须与本次 helper 的稳定 Agent 归属一致：

```json
{
  "assessment": "unknown",
  "author": {"kind": "agent", "agent_id": "本轮稳定Agent标识", "display_name": "本轮评估者名称"},
  "rationale": "尚未完成目标变化对需求、约束、验收标准和关键前提的影响检查。",
  "affected": []
}
```

只有完成实际检查后才填写 `applicable` 或 `revision_required` 及真实依据。已封存条目可在 `affected` 使用其真实 `target_type/target_id`、可选 `criterion_id` 与 `note`；未发布草稿尚无条目ID时不伪造ID，在依据中明确草稿位置与影响。CLI 记录作者声明，不替作者证明其结论。

定义阶段、发布阶段和开工阶段不是一次永久通行检查。正式发布前，对本次审阅范围执行 publish 阶段观察，绑定 Workspace 摘要、仓库、目标、拟发布内容和定义参考；尚未发布的新 Issue 同样需要检查，不能拿同仓库某个旧 Issue 的结论替代。`preflight show` 用于回读固定观察、依据和绑定，不会因为查询而把旧观察刷新成最新。

目标未变且输入匹配时，使用 CLI 返回的有效匹配结果继续，不追加人工审批或完整语义评估。目标前进时，Agent 检查新增变化对需求、封存约束、验收标准与关键前提的影响，提交带身份和实质依据的评估；不能按文件交集裁决语义，也不能用裸通过标记代替依据。CLI 只校验完整性和事实绑定，不证明评估正确。

契约仍适用时可以保留真实的定义快照，同时记录本次发布检查的目标提交和依据；需要改契约内容或拟发布基线时先修改草稿、重新生成审阅材料并取得对应确认。`revision_required`、`unknown`、刷新失败或输入错配时停止发布，只询问需要用户解决的具体事项。检查后目标再次变化则重新核对，不能复用过期结论；本地观察不声称锁住远端至 SQL 提交。

<a id="read-only-contract-review"></a>

## 默认使用 HTML 审阅契约

草稿审阅默认调用 `contract render --workspace NAME`，提供本次成功返回的本地会话 URL。页面默认阅读，按语义区块进入编辑，保存成功后回到阅读；保存写入唯一 JSON draft，不表示发布或批准开发。保留前台进程供用户编辑，Ctrl-C 结束服务；重新启动会话读取已保存内容，不承诺保留尚未保存的浏览器内容。helper 直接流式转发首次 JSON，不能等待服务退出才给 URL。

```bash
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$CLONE" -- contract render --workspace "$WORKSPACE"
# 用户明确需要离线、分享快照或当前环境无法保持前台服务时，说明降级后使用静态导出：
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$CLONE" -- contract render --workspace "$WORKSPACE" --output "$REVIEW_DIR"
# 固定历史版本必须显式输出，只读，不提供保存：
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$CLONE" -- contract render --issue "$ISSUE_ID@$ISSUE_VERSION" --output "$REVIEW_DIR"
# HTML 失败且来源可读时保持来源范围，仅切换静态 Markdown：
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$CLONE" -- contract render --workspace "$WORKSPACE" --output "$FALLBACK_DIR" --format markdown
```

活会话返回 `grounds.result.contract-session/v1` 的 `mode/url/version/source/editable`；旧 `draft edit` 保留 `grounds.result.workspace-editor/v2` 与 `command=workspace.edit`。初始 `version` 只是会话启动时的内容，用户在页面保存后必须重新 `draft read NAME`，根据实际已落盘的 `draft/version` 继续审阅、处理反馈和发布。不能把用户确认前的旧版或确认后悄悄变化的新版本当作已批准内容。确认必须对应完整已保存版本，正式发布的 `--expected-version` 使用该版本；若冲突，保留改动、比较差异并重新确认实际变化，不自动强制覆盖。

Agent 按反馈保存后，提示用户在原页面明确重新读取；存在未保存输入时先选择保存、放弃或继续编辑，不能直接覆盖。保存冲突时保留并查看/复制本地输入与磁盘内容，显式重读后重新编辑；保存结果未知时先只读核实，不能自动重试或声称未落盘。服务停止后用同一命令重新启动新会话，先保留尚未保存输入。

静态导出仍返回 `patchledger.result.contract-review/v1` 的 `format/path/content_digest/generated_at/source/source_paths`。使用实际返回路径，不自行拼接。`source.workspace_version` 是该快照的 Workspace 字节摘要；`content_digest` 是页面内容摘要，二者不可混用。固定历史版本不能用当前编辑稿替代；`file://` 页面不能伪装为可保存。输出失败不得改动契约源。

- 固定历史必须显式选择 ID@VERSION；同一 Requirement 身份下可重复 --issue，Requirement-only 不自动包含相关 Issues。不得用 workspace open 制造历史回退；输出目录不可写时只改派生目录，不改来源。
- 草稿范围为指定 Workspace 的 Requirement 和全部 Issue，允许零 Issue；跨仓摘要明确为范围外，历史绑定按本地受管来源完整呈现，不推断或改绑。缺少必要来源时诚实报错。
- 本地 JSON 会话无需数据库连通或 schema 匹配；新建来源、远端查询和发布仍走完整预检。旧 Markdown 的静态阅读保持兼容；交互编辑要求用户显式迁移，不自动转换。
- 提供本轮活会话或重新生成的快照，旧静态副本不会随保存更新。可解析的未决问题、假设和不可达 Baseline 不妨碍讨论，但不代表可发布。
- HTML 失败可明确降级到同范围 Markdown。来源不可得或回退也失败时说明准确错误，不能用旧版本、部分内容冒充成功。

<a id="confirm-and-publish"></a>

## 确认并发布

展示草稿前，执行[自包含契约](../self-contained-contracts.md)中的来源覆盖和脱离来源检查。Issue 与其绑定 Requirement 必须无需打开外部材料就能说明实现和验收义务。允许在已确认范围内仅发布 Requirement，但须保留所有已知核心规则并明确未解决要求；不能为显得完整而创建推测性的 Issues。CLI dry-run 成功只验证结构和状态，不证明语义完整。

发布前，简要展示 Requirement、Issue 拆分、目标合入分支、定义参考提交、本机计划绝对路径/本地分支（尚未创建）、重要 Decisions/Constraints 和剩余问题，取得用户对双方理解正确的明确确认。已确认的本轮内容不重复索要许可；计划失效或需调整时说明具体差异，不能拿另一个成功位置替换原确认。

使用 `draft publish --dry-run` 无写入地执行相同的解析、校验、Baseline 解析、来源过期和发布计划检查。中文工作在 dry-run 与正式发布时都传 `--content-language zh-CN`，阻止变化的 Requirement/Issue 字段中明显为英文的人工文本。必须保留英文时，向用户说明准确字段和原因，再在两次调用都传 `--language-override-reason "..."`。CLI 会记录 override 警告，不翻译或修改来源。不要把校验或计划暴露为额外必经步骤。

只有每个发生变化的 Issue 草稿都满足以下条件，才发布：

- 契约完整可验证，并通过脱离来源检查；
- 每个受影响 Outcome 和强制 Decision 都有 Intent Links；
- Baseline 准确且可解析；目标 Issue 的定义依据来自成功刷新的目标观察，本次发布范围已完成匹配的发布阶段预检；
- 没有 Open Question 或临时 Assumption；
- 将绑定的 Requirement Version 没有阻塞性 Open Question；
- 同一 Requirement 在同一 Repository 上没有其他 Issue（否则 `draft publish` 返回 `REPOSITORY_ISSUE_LIMIT`；按上文拆分指引收进一个 Issue，或用另一个 Requirement 分开表达）。

JSON Workspace 使用 `draft publish NAME --expected-version DIGEST` 提交已审阅内容；目标流程还需传入匹配的 `--preflight` 记录，并用 `--refresh` 明确本次消费时的刷新授权。DIGEST 必须是用户审阅材料的 `source.workspace_version`，不能用页面 `content_digest` 或重新读取后的另一个摘要替换。dry-run 同样绑定该摘要，其离线结构通过不证明新鲜度满足。旧 Markdown 及直接公共发布入口也遵守目标门禁，不能换入口绕过。一次发布原子创建或修订 Requirement 与相关 Issues，失败不留下半发布记录。发布成功只表示契约已封存，不表示开工预检已完成；首次开发仍单独核对当时的目标。用户提前停止或存在未决问题时保留草稿，不发布。

权威 Version 已过期时，不覆盖或静默合并。显式使用 `draft rebase`，报告结构化冲突，由用户或 Agent 解决后通过 `draft resolve NAME --file DRAFT.json --expected-version DIGEST` 保存解决结果，再审阅并重试发布。写入结果不确定时保留 Workspace；保留 pending 固定输入并复用同一幂等操作。没有成功回执不等于没有提交，不能删除 pending 解锁编辑；仅有明确终结且未提交证据时才能显式放弃。

成功后，从结构化输出报告稳定的 Requirement/Issue ID、公开版本号、准确 Baselines、绑定和警告。Workspace 保留为下次修订的干净可编辑基础。给出下一开发动作；除非用户同时授权开发，不启动 DevRun。
