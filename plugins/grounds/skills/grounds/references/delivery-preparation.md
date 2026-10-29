<a id="select-and-prepare-grounds-delivery"></a>

# 选择并准备 Grounds 交付

仅在记录用户选择、准备/恢复交付或记录已授权实际交付关联时读取。业务写入前遵循共享准备和写入预检。已有授权持续有效；定位缺失目标，不增加确认门禁。

物化交付前，确认 Candidate、目标路径和出口分支。新受管分支候选固定 source commit；准备时核对该提交和 result-tree。历史 patch-only 候选不支持选择、恢复或交付，不补造 source、不自动转换。新目录要求路径不存在，clone 匹配且 Candidate 的精确基础提交本地可用（历史流程回退 Issue Baseline）。未单独授权不 fetch、commit、push、创建 PR、merge、deploy 或删除保留的工作树。验证 JSON 返回中的 Repository、有效基础、patch、result-tree，报告保留路径/分支和未解决 receipt 状态。Selection/准备不证明实际采用。

交付始终针对选定的固定候选：作者已继续到后续提交时，在独立受管交付目录和出口 branch 准备旧候选，不 reset 原开发分支或默默 push 最新 HEAD。开发现场恰好匹配选定提交时，也只有公共检查确认归属、占用和内容一致才可复用，不能自行编辑 receipt 接管目录。

交付准备前自动运行默认离线的 `candidate replay-check --candidate CANDIDATE_ID --cwd CLONE`（或 `--issue ISSUE_ID --issue-version N`）。`remote_reachability` 为 `unreachable`、`unknown`，或 `artifact_integrity` 为 `inconsistent` 时必须向用户展示三项结论、`reason`/`remote_reason` 与依据（所检查的 ref、`checked_at`、`refs_may_be_stale`）；`unreachable` 只说明新环境可能无法仅凭登记 remote 取得起点提交，不能说成远端一定没有，本机已有该提交时仍可准备交付。只有用户明确要求刷新时才加 `--refresh`：它会对登记 remote 执行 fetch，可更新本 clone 的 remote-tracking refs、`FETCH_HEAD` 与对象库，不是默认动作。检查不修复、不归档源码、不修改账本。

<a id="record-the-users-delivery-choice"></a>

## 记录用户的交付选择

用 `selection show --issue ISSUE_ID --issue-version N` 读取当前 Selection 版本。只有用户指定交付 Candidate 后，才通过共享 helper 调用 `selection set --issue ISSUE_ID --issue-version N --candidate CANDIDATE_ID --expected-version V [--reason TEXT]`。首次选择 V=0。已有明确授权持续有效，不要求用户重复。非 qualified Candidate 必须有真实反映用户决定的原因；缺原因时询问，不编造。展示 `selection.warnings`、standing 和变化的验证集合。版本冲突须重读并核对用户意图，不盲目使用新版本重试。

明确取消时使用 `selection clear`，保持相同 Issue/版本筛选和预期 Selection 版本。它清除当前选择，不表示全部 Candidates 被拒绝。审计使用 `ledger list --subject-type selection --subject-id SELECTION_ID`，不从当前 Candidate 标记推断早先选择。

要求交付已选 Issue 时，先运行 `selection inspect --issue ISSUE_ID --issue-version N --cwd CLONE [--path PATH]`。检查全部返回工作树和当前 Selection；空列表只说明此 clone 无可发现记录，不说明其他机器未准备交付。`resume_preparation` 在已有授权内重试返回 `recommended_argv`；`continue_delivery` 复用现有目录。多个目录合格且意图不明时询问。`review_selection` 先核对用户意图，再在新路径准备当前选择；不得仅为恢复旧目录而刷新预期版本。`inspect_manually`/`prepare_new_path` 保留目录、index、分支，说明原因，先检查再变更。不自动手改本地 registry 或损坏 receipt 来修复。

新准备使用 `selection materialize --issue ISSUE_ID --issue-version N --expected-version V --path NEW_PATH [--branch NAME]`。读取实际选定 Candidate，讨论操作时展示路径/分支；已有交付授权不需要二次确认。受管分支候选的本机准备会刷新契约目标，在创建目录前核对 SQL 固定 source/ref/tree 和 Selection，执行前明确这项 fetch 范围并沿用已有授权；不能以无刷新结果称就绪。目标 advanced 或候选未 qualified 时默认暂停。用户已明确决定这一次继续，才用 `--allow-unverified --reason USER_DECISION`，helper 注入稳定身份与 operation ID，记录绑定 Candidate/source/Selection 版本/观察目标的一次准备例外；重试原操作不能改变绑定，取消或新输入不能挪用它。unknown/rewrite、source 替换、rejected/disputed/inconclusive 不能被这项例外豁免。这只授权本次本机准备，不制造 qualified，也不代办远端合并；pre-MR/最终合入仍执行下面的最新目标门禁。

校验 receipt，说明它固定读取时的选择；后续重选不改变已有目录。receipt 失败时报告保留目录，不宣称成功，不自动删除。用户明确针对 Candidate 时仍可直接 `candidate materialize`，不改变 Selection；这不能绕过受管分支固定 source 与未验证/目标检查，不能把直接物化当成交付门禁已通过。

<a id="record-actual-delivery"></a>

## 记录实际交付

实际 commit 后，若用户交付流程包含关联记录，遵循[代码历史](code-history.md)的 delivery-link 步骤。CLI 可验证准备工作树 receipt 并预填 Candidate，但仍须比较真实 commit。Selection/交付准备本身不授权 delivery-link 写入，也不证明采用。解释源码始终保持只读。

<a id="target-flow-gate-and-landing"></a>

## 目标流程的门禁与落地核对

本节只适用于 `candidate artifact` 返回 `base_commit_source: candidate` 的目标流程；历史与评测流程保持原协议。`selection inspect` 的 ready 仍只指本地交付准备就绪，不代表门禁通过。需同步时转到开发协议的 `devrun sync` / `sync-complete` / `sync-abandon`，不得以手工 reset/rebase 冒充安全同步。

在已有明确的提交、推送与交付授权范围内准备源提交 S。受管分支候选的 S 必须匹配已归档 source，tree 等于 Candidate result-tree，精确逻辑 base 在其历史中；普通多提交和真实 merge 的 parents 保留，不能强制压成单个子提交。历史 patch-only 格式已退役。默认新出口分支和新 MR；新 Candidate 的 S 不是旧源分支后代时，复用旧 MR 必须单独取得授权，并使用固定预期远端 SHA 的 force-with-lease。不得隐式 force push、关闭 MR、清空 Selection 或清理。

取得门禁刷新授权后，用实际远端源分支和固定的 Selection ID/版本执行（下列写命令均通过共享 helper；观察也追加写账本）：

```text
integration observe --candidate CANDIDATE_ID --selection SELECTION_ID --selection-version V --source-remote REMOTE --source-ref refs/heads/SOURCE --source-commit QUALIFIED_S --refresh
integration show RECORD_ID
```

`--source-commit` 是带 sha1:/sha256: 的完整 OID，不是分支名。源与目标必须是同一 Repository 的不同分支。默认不加 `--refresh` 时只读本地跟踪引用并保存观察，consistency 必为 unknown；刷新失败不能使用旧引用放行。每次新观察使用新 operation ID；重试原 operation 只回放原记录，不把旧观察称为新的门禁。

同时呈现 `gate.decision.checks` 的目标/源/Selection、总体 consistency，以及 `gate.verification.current_verification` 的完整集合摘要与 standing、选择时快照和变化。验证状态明确绑定其 `candidate_id`；Selection 已指向其他 Candidate 或没有可比快照时，verification_changed 为 null，而不是“没变化”。ready 只证明观察时工件与选择一致：无报告不能称已验证；当前提交未验证时默认暂停并提示，用户明确决定本次继续才允许例外，不能制造 qualified。验证集合改变、rejected/disputed 或相反报告继续按完整 Review/Selection 协议处理；一次未验证确认不豁免它们。inconsistent/unknown、错误来源、Selection 漂移或目标改写不得按“目标过期”豁免。披露一期无服务端强门禁，刷新到实际合并仍有竞态。

expired 默认回到 refinement、同步、重新生成 Candidate、验证和选择；遇不支持的输入或缺失恢复材料时停下保留现状。只有用户明确选择**这一次**降级合并时，先披露“落地代码未经验证”，再执行：

```text
integration authorize --observation GATE_RECORD_ID --reason USER_DECISION
integration consume --authorization AUTHORIZATION_RECORD_ID
```

authorize 记录用户决定及 Candidate/Selection 版本/S/观察目标四项绑定；consume 在执行外部合并前重新 fetch 两个分支、重核 Selection 后原子消费一次。任一事实变更即停止；成功也不执行 merge。消费后才按原单次授权代办合并，不追加检查计划。consume 结果未知或合并结果未知时，不自动重试合并；先 `integration show AUTHORIZATION_RECORD_ID` 查看 available/consumed，再只读核对托管平台与目标分支。consumed 只证明授权已消费，不证明合并发生或成功。

合并后执行：

```text
integration landing --observation GATE_RECORD_ID --refresh
integration landing --observation GATE_RECORD_ID --commit QUALIFIED_L --provenance user --refresh
```

受管分支候选还传 `--adoption-file ADOPTION.json`，用真实 MR 合并结果或用户明确的采用说明绑定 Repository、目标完整 ref、Candidate、已归档 source 与实际落地提交。例如（所有 ID/OID/ref 均取自本次已核对结果）：

```json
{
  "format": "grounds.adoption-binding/v1",
  "repository_id": "REPOSITORY_ID",
  "candidate_id": "CANDIDATE_ID",
  "source_commit": "QUALIFIED_SOURCE_OID",
  "landed_commit": "QUALIFIED_ACTUAL_LANDING_OID",
  "target_predecessor": "QUALIFIED_ACTUAL_TARGET_BEFORE_UPDATE_OID",
  "target": {"remote": "CONFIRMED_REMOTE", "ref": "refs/heads/CONFIRMED_TARGET"},
  "method": "merge",
  "source": {"kind": "merged_mr", "reference": "VERIFIED_MR_REFERENCE"}
}
```

`method` 按真实方式选择 `ff`、`merge` 或 `squash`；明确的人工作用来源用 `user_confirmation`，不能编造已合入 MR。绑定输入只用于该公共命令，不编辑 Grounds 内部记录。调用使用 `integration landing --observation GATE_RECORD_ID --commit QUALIFIED_L --provenance merge_result --adoption-file ADOPTION.json --refresh`；人工作用来源用 `--provenance user`。`merged_mr` 与 `merge_result`、`user_confirmation` 与 `user` 必须配对；来源错位保持未知。Grounds 核对所提供的已合入 MR 声明和精确 Git 绑定，不联网核验托管平台 MR 状态/签名，提供者须先确认真实 MR 结果与引用。helper 重试会核对该文件字节。

`target_predecessor` 表示实际目标引用本次更新前的 P，须来自同一 `source.kind/reference` 的采用证据。新 FF 输入必须显式提供它并通过固定对象/完整历史/祖先核对；`P → A → L` 的多提交 FF 中，P 不等于 L 的 Git 首父 A。不能用 gate T 或 L.parents[0] 猜 P。merge/squash 可从可信采用方法与真实首父确认，显式不符则标 conflict。旧输入/事件仍可缺字段，读取时保持 unknown，不补写或改旧摘要。

采用事实、`landing.target_predecessor` 证据与 L 归档状态分别读取：P 未知时归档 pending（`actual_target_predecessor_unknown`），冲突时 unknown（`actual_target_predecessor_conflict`）；已核实的 L 不抹去。只有 confirmed P 才能作为归档 base/保留端点与 landing diff 左端。缺/冲突的 landing diff 返回 STATE_CONFLICT；如需补证使用新观察与操作身份，不能覆盖原记录来源。

旧流程仅在新刷新目标 tip 就是 S 时可自动采用 `target_is_source`；否则需要可信 MR 合并结果或用户明确指定 L。新候选继续核对上述绑定、原source完整对象的OID/ordered parents/tree与逻辑base可达，以及目标可核验的第一父历史；缺原source对象/完整历史保持unknown，squash同树或目标单父不豁免。若用户提供的是侧父 S，核对并记录真正的 first-parent 落地 M；不能把 S 本身记作目标落地。另一目标的 MR、未进入本目标历史的同树对象、类似文案或缺失历史都不足以证明采用，保持 adoption_unknown。展示 identity、shape、parent_matches、tree_matches、outcome 和 Verification；采用事实与可做行级追溯的资格分开。

Verification 保留在原 Candidate/source 上。FF/no-ff/squash 后代码树相同只证明内容相同；落地 OID/parents 改变时，Git 编号/历史敏感的验收或构建需要实际落地上下文核对，不能借原报告称这些要求已通过。落地代码改变则明确不在旧报告覆盖内。需求合入所属 release、release 集成测试/部署、稳定回归 master 和后续 release 吸收 master 由团队发布流程各自负责，单候选验收不能代替版本发布。

只有 `delivery_link_eligibility: eligible` 才提供可登记的 `delivery_link_commit`，并在独立的关联授权下走既有 delivery-link 流程。旧 `delivery-link record --commit` 参数使用不带算法前缀的完整 SHA，明确从该 OID 中取出，不换成 HEAD。`no_supported_text_changes` 表示一期不能为仅二进制/模式等非文本工件登记行级 Delivery Link。落地核对和风险决定是独立记录，不预设降级落地一定同树或异树。

<a id="close-out-an-authorized-mr-merge"></a>

## 收尾已授权 MR 合并

只有实际合入所声明目标已核验且采用记录成立后，才在交付收尾询问一次三选项：①清理 worktree、保留本地需求 branch；②worktree 与本地需求 branch 都清理；③两者都保留。只创建 MR 不触发此合入完成询问。未答、取消或选③均保留现场，不因 merge/Selection/Delivery Link 自动删除。只描述本 clone 已知且可确认归属的路径，不推断其他机器现场。

清理前通过 `devrun cleanup --dev-run ID --preview` 展示路径、branch、风险和选项，并核对 `devrun uncommitted`/reconcile。确认具体选择后，在相应删除授权内调用 `devrun cleanup --dev-run ID --choice worktree` 或 `--choice worktree-and-branch`；`keep` 明确保留。旧 DevRun 终态不能证明复用路线闲置；需检查最新归属、当前 HEAD 的独有未归档提交、未提交/ignored 文件、恢复 journal、是否仍被 `env run` 租用，以及他处 checkout 占用。有风险时保留并解释，不以 `--discard-changes` 绕过新路线的档案与占用保护。

选项①保留可恢复的本地 branch；在用户明确继续的授权内，以 `devrun start ISSUE_ID --refines-candidate CANDIDATE_ID` 重新准备原路线，核对仍保留的 branch/path/HEAD，不能先手改内部 marker。选项②只删明确归属且获授权的本机现场；后续继续须重新确认 `devrun plan`，再用 `devrun start ISSUE_ID --parallel-route --plan NEW_PLAN_ID --refines-candidate CANDIDATE_ID` 从固定 Git source 和完整对象恢复自己的新路线，不能复活已清理路径冒充原现场。

历史 SQL patch/契约/报告/采用记录、Candidate 保活 ref、其他路线/审阅/authoring/恢复材料和远程 branch 均不在隐含删除范围。中断先检查公共状态，使用原操作身份重试。用户明确要求的合法手动终态清理仍可在合入之前进行，遵守同样预览、安全边界和原授权；合入完成询问的时机不禁止这个入口。


准备例外重试仍须读取当前完整验收集合与精确Selection/source/目标；旧operation/decision仅为历史审计，不是永恒准备资格。SQL成功但Git创建失败后新增rejected/disputed/inconclusive或绑定变化时，保持现场并拒绝新建；即使后来qualified也不跳过原操作绑定。qualified/equal的新请求不写不需要的例外。已存在目录用`selection inspect`只读核对，不把诊断当重新授权；不要宣称SQL与Git原子完成。
