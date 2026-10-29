<a id="explain-the-history-behind-pasted-code"></a>

# 解释粘贴代码的历史背景

用户在普通 Git checkout 粘贴代码或选择源码范围，询问业务背景时使用。用户提供代码和问题，Agent 发现账本身份。保留完整问题，包括对备选方案或业务约束的不确定性。

<a id="locate-and-trace"></a>

## 定位并溯源

先运行交付 Skill 的只读预检。旧 CLI 使用前检查 `trace --help` 可用。不因问题而顺带迁移/初始化用户账本；返回升级/迁移要求时明确报告。

使用当前 checkout。已知路径和行号时：

```bash
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$SOURCE_CLONE" -- trace --path src/refund.ts --start-line 12 --end-line 15
```

否则，用文件写入工具将原始片段保存到私有临时 UTF-8 文件，传其路径。不将源码插入 shell 命令。读完结果后只删除自己创建的临时文件。

```bash
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$SOURCE_CLONE" -- trace --snippet-file "$SNIPPET_FILE"
```

`--at src/refund.ts:12-15` 是简写。Repository 歧义使用 `--repository ID` 或 `--remote NAME`，二者不并用；CLI 验证 clone 身份。只有无法从对话确定时才问目标 checkout。

要求 `patchledger.result.code-history-trace/v1`。位置解析与 Candidate 覆盖分别读取：

- `explicit`/`unique_in_scan`：检查该准确范围的返回 segments。
- `ambiguous`/`incomplete`/`not_found`：用已有上下文缩小文件/范围，或问一个简短位置问题，不选择首条结果。
- `coverage.local_only`：当前未提交新增无已证实 Git 来源；有用时另行解释当前行为。
- `coverage.unexplained`：这些范围未找到历史解释，但可能已提交，不能称为必然未提交。
- `source.index` 表示匹配文件中已暂存和未合并路径。出现 `unresolved_index_conflict` 时，即便可见文本像 HEAD，也不将冲突文件归因到历史需求；请用户先解决冲突再溯源。
- 部分 Candidate 搜索不使已有匹配失效，也不证明唯一性。`--limit` 控制检查数量，范围 1–200；不无限重复同一有界查询。
- 对象缺失、partial clone、合并/重命名歧义、重复对齐和预算耗尽都是证据缺口。未获适当授权，不仅为回答背景问题而 fetch 或修改 checkout。

结果固定起点 commit 和源码 digest。工作树或账本集合冲突时重新 trace，最多重试一次。源码编辑后不复用结果。

<a id="read-the-historical-evidence"></a>

## 读取历史证据

每个相关 segment 使用 `review_argv` 参数数组通过 helper 查询，它选择历史 Candidate 路径/行号。使用 shell 时正确引用可信筛选值，不替换为当前行号。相同查询去重，但保留全部当前范围的映射。

遵循[审阅对话](review-conversation.md)和[固定 Verification 集合协议](verification-set.md)。Review 摘要包含准确绑定的 Issue/Requirement 版本，不以最新 `issue show`/`requirement show` 替代。引用验证者发现前读取相关正文，数量或 standing 不是正文。

解释每个 segment 的证据：

| Origin | 允许的表述 |
|---|---|
| `review_snapshot` | “这是正在审阅的 Candidate 快照。”不证明已提交或部署。 |
| `recorded_delivery` | “根据记录的交付关联及核对后的变更映射……”说明来源和范围。 |
| `unrecorded` | “这个 Candidate 中有相同实现，但历史采用未记录。”理由可作为背景线索，不是确定来源。 |

内容相等（`exact_artifact`/`exact_scope`）不认证作者。证据包含已撤回交付关联时，说明已撤回，并用 `delivery-link show ID` 读取原因；不能凭代码相等恢复关联。多个匹配仍是多种可能。

只有历史 Review 的真实新增/删除行支持行级理由。上下文行、仅文件记录、缺失理由和 Intent Links 保留原有未知语义。删除理由解释移除，不解释最初引入。

直接回答用户问题：当前行为、已记录业务目的、备选方案/约束及证据缺口。作者记录与 Agent 分析分开。历史理由不证明当前渠道限制、调用者/helper/配置行为未变；问题需要时单独溯源关联代码。

<a id="record-a-completed-delivery-when-authorized"></a>

## 获授权后记录已完成交付

这是独立写流程，不自动包含在 trace 中。用户授权 commit 且流程包含关联记录时，使用完整 commit 对象 OID；拒绝 annotated tag 对象 ID。准备好的交付工作树可由 CLI 校验 receipt 并解析 Candidate：

```bash
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke --cwd "$DELIVERY_WORKTREE" -- delivery-link record --commit "$FULL_COMMIT_OID" --expected-version 0
```

普通 clone 明确提供 `--candidate CANDIDATE_ID`。CLI 对比前后变化，只记录完整匹配 Change Units。receipt、Selection、trailer 或结果文本相同本身不足。此命令不执行 Git commit/push/PR/merge。

相同请求重试保留 helper operation ID。完成的记录通过请求身份检查后重放冻结证明，即使 receipt 已删或 Git 历史不可用；新操作仍完整校验。版本冲突读 `delivery-link show LINK_ID` 并核对，不盲目加版本。`delivery-link show LINK_ID --version N` 读取不可变旧版本。明确要求纠正时可用 `delivery-link withdraw LINK_ID --expected-version N --reason TEXT` 撤回并保留历史；同一逻辑键再记录使用当前版本。不同 Candidate/commit 是不同键。不仅因出现后继关联就撤回另一关联。

契约：[code-history.schema.json](../../../references/contracts/v1/code-history.schema.json)。Delivery-link 存储于 schema 14 引入；CLI 0.2.21 要求 schema 18。使用已安装 CLI 当前 schema，迁移只在明确授权后执行。
