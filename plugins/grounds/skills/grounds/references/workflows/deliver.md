<a id="review-compare-and-deliver-grounds-candidates"></a>

# 审阅、比较与交付 Grounds Candidates

使用确定的账本数据支持人工决策。不只依据最新 Verification，也不代用户选择 Candidate。Selection 记录选择，实际采用仍发生在外部。

遵循[共享准备协议](../../../../references/preparation.md)进行只读预检；所选动作需要写入时重新做写入检查。JSON 命令使用共享 helper，下文 Markdown 导出是明确的非 JSON 路径。

<a id="select-only-the-needed-protocol"></a>

## 只选择所需协议

| 用户目的 | 阅读并遵循 |
| --- | --- |
| 无已知 Candidate 时解释粘贴代码或当前位置 | [代码历史](../code-history.md)，再针对每个发现的历史 Candidate/位置使用审阅对话协议 |
| 解释 Candidate 的代码、理由、需求关联或验证 | [审阅对话](../review-conversation.md)，按该协议选择范围与必需证据 |
| 检查已知 Verification 报告或完整集合 | [验证证据](../verification-set.md) |
| 比较同一 Issue Version 的 Candidates | [候选比较](../candidate-comparison.md) |
| 记录/取消选择、准备/恢复交付、记录实际交付关联，或收尾已授权 MR 合并 | [选择与交付准备](../delivery-preparation.md) |
| 说明 Candidate 的规范工件（起点提交 + 账本中完整保存的 patch + result-tree） | 运行 `candidate artifact --candidate ID` 并按返回描述符说明；本地 Git 对象与交付目录都不是工件，patch digest 只用于标识与校验 |
| 导出 Markdown 审阅材料或 PR 描述正文 | 使用下文导出部分 |
| 在本地 review worktree 检查源码 | 使用下文物化部分，再按审阅对话协议回答问题 |

不加载所有协议。混合请求保留全部意图，在进行相应部分时才加载协议。结合对话和确定性查询解析内部 ID，只有目标仍不明确时才询问。只读问题不授权 Selection 或交付变更。保留历史契约及所有相关冲突报告；未读报告不能支持具体发现。普通 Review 材料不能转作盲验输入。

<a id="export-a-review-summary"></a>

## 导出审阅摘要

用户需要 Markdown 审阅材料或 PR 描述正文时，定位 Candidate 后直接请求分阶段导出，不先读取旧的完整 JSON trace：

```bash
"$GROUNDS_BIN" review CANDIDATE_ID --markdown --config "$GROUNDS_CONFIG"
"$GROUNDS_BIN" review --markdown --config "$GROUNDS_CONFIG" --cwd "$REVIEW_WORKTREE"
```

`--markdown` 将可移植的审阅摘要输出到 stdout，不能与 `--json` 合用。摘要包含历史契约、Intent Links、作者理由/声明/证据、完整 Verification 集合、覆盖和来源标签。实现先暂存临时文件，全部报告校验后才输出 stdout；不持久化输出文件、不写账本、不联系代码托管平台。未经用户另外授权，不创建或更新 PR。

<a id="materialize-for-inspection"></a>

## 物化以供检查

检查 Candidate 的请求授权 `candidate materialize CANDIDATE_ID --mode review`。省略 `--path` 时 CLI 在 `<数据根>/repositories/<仓库标识>/reviews/<candidate_id>/<review_session_id>/worktree` 创建本次检查的会话并返回 `review_session_id`；也可显式传 `--path NEW_PATH`，此时目标路径必须不存在。clone 必须匹配且本地已有 Baseline commit。在新工作树中通过 helper 运行不带 ID 的 `review`，验证自动发现 Candidate。检查返回中的 Repository、Baseline、patch 和 result-tree 成功信息，再返回路径。保留已有工作树；未获授权不 fetch 或删除。delivery 模式改用选择/准备协议。

<a id="route-review-feedback"></a>

## 路由审阅反馈

契约不变的反馈进入开发流程，开发简报携带父 Candidate ID 和具体反馈。新 DevRun 使用 `--refines-candidate`；新 Candidate 需要重新验证，不自动选中。利用已有 Candidate 列表/修订链指出后继版本，不静默替换选择。验收标准变化时先进入定义流程并发布新 Issue Version，再开发。不创建跨版本修订链接，也不把新 Version 当作已选中。

## 已实际交付后的登记

先检查精确 Issue Version 的 board。已 completed 时汇报完成依据与真实验证结论，不重复建议准备交付；用户明确要求登记或补录时遵循[完成记录](../completion.md)。完成不等于独立验证，也不执行外部合入或发行。
