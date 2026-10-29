<a id="develop-verify-repair-loop"></a>

# 开发—验证—修复闭环

把同一 Issue Version 上的开发、独立验证和契约不变的修复串成一条有上限的链：DevRun 提交 Candidate 后自动独立验证；Verification 明确 rejected 且拒绝原因都是代码缺陷时，自动开启 refinement DevRun 修复，再交给新的验证者。**同一条链最多 3 次独立 Verification（首轮加最多 2 次修复）**，在 qualified、触发停止条件或用完轮次时停止，并总结整个过程。

闭环只是本 Skill 对现有流程的编排。CLI 不新增状态，Grounds 不调度 Agent；每一步仍完整遵循[开发流程](develop.md)和[独立验证流程](verify.md)，本文只补充衔接、停止和总结规则。

<a id="confirm-once-at-start"></a>

## 开发开始时确认一次

开始实现已封存契约、从 rejected Candidate 开启修订，或恢复已有的开放 DevRun，且用户尚未表态时，在 `devrun start` 或继续 `devrun context` 指向的工作前用一个问题确认是否启用闭环，并说明：

- 上限：同一链最多 3 次独立 Verification，即首轮开发加最多 2 次修复；从已有 Candidate 开始时，按[下文](#count-rounds-from-the-ledger)先从账本算出已用次数，告知剩余轮次（已用完则不启用）；
- 每轮都创建新的隔离验证者，验证耗时与 Token 开销会随轮次增加；
- 遇到 inconclusive、需要澄清契约或基础设施阻塞时停止交给人；
- 结束于 qualified 或停止条件，不选择 Candidate、不准备交付，也不清理工作树。

用户在本次请求中已明确要求“开发并自动验证修复”时，复述上述上限即可，不再重复询问。用户拒绝时按原开发流程在提交 Candidate 后停下。确认后保持在本对话内有效；会话中断后在新对话恢复，需要再次确认。

闭环授权只覆盖本链所需操作：目标契约的 `preflight observe/assess/show`（网络刷新仍在已确认的目标及刷新授权内）、`devrun start/prepare/admit`、`candidate submit`、`candidate materialize --mode review`（每轮新验证者使用新建的 review 会话，不复用前几轮的会话目录）、`verification context`、`verification submit`，以及运行不改源码的本地测试。它不授权 `devrun abandon`、`devrun cleanup`、修改或发布契约、Selection、交付准备、commit、push、PR 或合并；这些仍按各自流程单独确认。

<a id="check-host-capability"></a>

## 启动前检查宿主能力

闭环要求宿主能为每轮创建并继续一个新的隔离验证者上下文，见[独立验证流程](verify.md#establish-isolation)。“继续”是盲验冻结后把对照材料交回同一验证者，很多宿主的继续机制与创建机制不同（例如需要后台运行），只看到能创建 Agent 不足以证明可继续。因此在首轮 `devrun start` 前做一次不涉及任何 Grounds 材料的探针：创建一个隔离 Agent 完成简单任务，再继续同一 Agent 一次并确认它保留前一步上下文。探针失败、或宿主没有已知的继续方式时，告知用户并按原流程只开发、在 Candidate 后停下，不启用闭环。中途失去该能力时按阻塞停止。在新对话恢复时，先重新确认闭环，再重新检查该能力。

同一时间只推进一条链，不并行启动其他 DevRun。不检查同级 Candidate，也不跨 Issue Version 延续轮次。受管分支模式可让每个修复 DevRun 复用原开发路线/目录/branch；每轮仍固定一个新 Candidate，旧候选与验证不变。历史 detached 模式保持每轮原协议。送验后的作者暂停不暂停本链独立验证，也不撤销已获授权的缺陷修复；明确并行推进则另按开发流程记录，不能从“启用闭环”推断允许任意并行工作。

<a id="roles-and-isolation"></a>

## 角色与隔离

- **协调者**（当前会话）：执行账本写入、读取 Verification 结果、判定停止条件并写总结。协调者可以亲自开发，也可以把开发交给子 Agent。
- **开发者**：按开发流程实现与提交，Agent 身份稳定。
- **验证者**：每轮一个全新的隔离 Agent，自身 `GROUNDS_AGENT_ID` 与本链所有开发者身份都不同，也不复用前几轮的验证者。只提供当前 Candidate 的盲验材料；不提供前几轮的 Candidate、Verification 报告、开发记录、修复简报、闭环轮次或期望结论。

修复所需的拒绝信息以账本为准：refinement Context 固定父 Candidate、冻结的 Verification 摘要和逐 Criterion Standing，但默认不含完整报告。开发者用 `devrun context DEV_RUN_ID --include-verification VERIFICATION_ID` 展开触发本轮修复的完整报告（每次最多 2 份，只能展开已冻结的报告），从中读取拒绝说明与证据。协调者的修复简报只补充定位与分类，不能代替原报告。

<a id="count-rounds-from-the-ledger"></a>

## 从账本推算轮次

一轮 = 本链一个 Candidate 上已提交的一次独立 Verification。轮次从账本推算，不依赖对话记忆。

先确定链尾：使用对话中已确定的本链最新 Candidate，或用户指定的 Candidate。同一 Issue 存在多个 DevRun/Candidate 而链尾不确定时，用 `candidate list --issue` 列出候选，只问一个简短问题让用户选择；不得为避免提问而选最新 Candidate。再从链尾起用 `candidate show` 沿 `refines_candidate_id` 逐级回溯到没有父 Candidate 的链头，并读取每个 Candidate 的 `standing` 与 Verification 集合（`candidate show` 返回的字段位于 `data.candidate` 下；未修订的 Candidate 没有 `refines_candidate_id`）：

```bash
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$CLONE" -- candidate list --issue ISSUE_ID
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$CLONE" -- candidate show CANDIDATE_ID
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$CLONE" -- verification list --candidate CANDIDATE_ID
```

未提交的验证尝试（验证者失败、handoff 未签出、提交出错）不计入轮次。链上每个 Candidate 应只有一次 Verification；闭环启用前已有的单次人工或其他来源 Verification 同样计入轮次。任一 Candidate 有多次 Verification 或 `standing` 为 `disputed` 时，不自动修复，停止交给人。恢复中断的闭环时先这样重建链和轮次，再从链尾 Candidate 的状态继续：未验证则启动新验证者，rejected 且仍有剩余轮次则重新分类。

<a id="run-each-round"></a>

## 每轮步骤

1. **开发**：首轮按开发流程完成目标预检并使用已确认计划启动 DevRun；后续目标流程通过 `devrun prepare --issue ISSUE_ID --refines-candidate PARENT_ID --brief-file BRIEF` 恢复父成果，按需同步，再对实际输入完成评估和 `devrun admit` 后修复；不能在准备态开始实质开发。受管分支的本机串行修复默认复用原路线。无目标的历史/固定起点流程仍按其原始协议执行。确认返回 Context 指向该父 Candidate、实际路径/branch与预期一致，再用 `devrun context DEV_RUN_ID --include-verification VERIFICATION_ID` 展开上一轮完整报告。原路线缺失或在另一台机器时先按开发流程明确自己的新计划，不能接管路径。实现、正常本地 checkpoint、生成草稿、说明质量指导和提交均按各自已有授权执行；启用本闭环本身不授权 Git commit。自我验证如实填写。
2. **独立验证**：对新 Candidate 完整执行独立验证流程：物化审阅工作树、创建新的验证者、先盲验后对照、签名 handoff，再由协调者提交。
3. **读取结论**：用 `verification show VERIFICATION_ID` 读取完整报告，记录整体结论、各 Criterion 的 final verdict 及说明与证据。再用 `candidate show CANDIDATE_ID` 核对该 Candidate 的 `standing`：它由全部 Verification 推导，可能因闭环外并发提交的报告而与本轮结论不同。
4. **判定**：按下节停止条件决定结束还是开启下一轮修复。

修复简报写明父 Candidate ID、Verification ID、要修复的 Criterion ID 及其被拒绝原因的简要定位，要求：

- 修复缺陷本身，不针对验证者的具体探针、路径或测试数据做特判，不为通过验证削弱测试或断言；
- 保持已 qualified 的 Criterion 不回退，修复后补充针对性的回归检查；
- 契约不变：如发现必须改变目标或标准，停止修复并报告，不在 refinement 中自行扩大或缩小范围。

<a id="stop-conditions"></a>

## 停止条件

每次 Verification 提交后自上而下逐行判断，**采用第一条匹配的行**。前面各行都是停止条件，任一成立都优先于继续修复；只有全部不成立时才到达最后一行。

| 观察到的状态 | 动作 |
| --- | --- |
| 用户中断或改变指令 | 立即停止当前步骤，保留已完成记录。 |
| CLI 错误、物化失败、身份冲突、本地工作树不可用或宿主无法继续隔离验证者 | 按阻塞停止，报告准确错误与状态，不计入轮次；问题解决后可按上节恢复。 |
| Candidate `standing` 与本轮整体结论不一致，或为 `disputed` | 停止交给人：存在闭环之外的 Verification，需人工查看完整集合。 |
| qualified | 停止：本链通过独立验证。不自动选择或交付。 |
| inconclusive | 停止交给人。inconclusive 表示环境或证据不足，不代表代码有缺陷，不自动修复，也不自动重验。 |
| rejected，且已用 3 次 Verification | 停止：轮次用完。 |
| rejected，但存在契约歧义、意图变化、验证者可能误判或环境导致的拒绝，或无法确定是否为代码缺陷 | 停止交给人。契约问题转入[定义需求](define.md)；误判不能靠下一轮覆盖，Verification 只能追加。 |
| rejected，且同一 Criterion 在修复后因相同原因再次被拒绝 | 停止：修复未收敛，交给人判断。修复后出现的新发现不算重复。 |
| rejected，且每个被拒绝的 Criterion 都是可定位的代码缺陷 | 开启下一轮 refinement。 |

拒绝原因的分类由协调者依据报告证据作出，在总结中逐项写明依据。整体 rejected 时同时存在的 inconclusive Criterion 不作为修复目标，写入遗留事项。

<a id="summarize-the-loop"></a>

## 结束时总结

无论因何停止，都输出完整过程总结，内容以账本数据为准：

- **目标**：Issue ID 与版本、Repository、Baseline。
- **逐轮记录**：轮次、DevRun ID、Candidate ID 及其父 Candidate、Verification ID、整体结论及 qualified/rejected/inconclusive 数量、被拒绝的 Criterion 与主要发现、下一轮针对它们做了哪些修复。
- **停止原因**：qualified、inconclusive、结论集合不一致或 disputed、需要澄清契约、疑似误判、修复未收敛、轮次用完、阻塞或用户中断之一，并附判定依据。
- **遗留事项**：仍为 rejected 或 inconclusive 的 Criterion、作者自验中的 `not_verified` 或局限，以及闭环过程中发现但超出契约的问题。
- **本地状态**：各轮 DevRun 受管工作树与审阅工作树的路径，说明均已保留、未清理；清理需另行确认。
- **下一步**：qualified 时建议按[审阅与交付](deliver.md)进行人工 Review 和明确的 Selection；其他情况说明需要人作出的具体判断。不得把 qualified 说成已选择、已合入或已发布。

总结只描述已发生的事实与建议，不执行任何下一步操作。
