<a id="fixed-requirement-document"></a>

# 固定需求文档模板

按以下顺序使用章节。标签采用用户语言，保留来源陈述及含义。在内存使用普通 Markdown，再转为 Confluence storage。必要时转义字面 Markdown/HTML 特殊字符，防来源引入宏或破坏表格。不把全文包在代码块，长文本用列表，不截断表格单元格。

1. **需求摘要**：标题来自 `requirement.summary`；说明这是 Grounds 单向发布，导出会替换正文。
2. **背景**：完整 `context`，缺失写“未记录”。
3. **预期结果**：源顺序保留每个 `outcomes`。
4. **决定**：全部 statement 及所给详情：rationale、context、options（key/description/benefits/costs）、chosen option、trade-offs（gain/sacrifice/reason）、consequences（kind/statement）。保留 option key，确保选择明确；空列表写“未记录”。
5. **待澄清问题**：每个问题、阻塞/非阻塞标记及记录的 assumption；假设不是已解决决定。空列表写“未记录”。
6. **Issues**：按 Issue ID 排序以稳定输出。每个包含摘要标题、完整 context、Repository 引用、源顺序的 goals/constraints、constraint rationale、全部 criterion 和对应 target 下全部 guidance；必要时带 target/criterion ID 区分引用，不以数量替代 Criteria。绑定不同 Requirement 版本时显著提示“此 Issue 基于 Requirement vX，本文展示 Requirement vY”。零 Issues 明确说没有已发布 Issues。
7. **来源与版本**：Requirement ID/版本，每个 Issue 一行含 ID/版本及绑定 Requirement ID/版本，UTC 收集时间。它们标识导出版本集合，不保证同步。不编造 Grounds 网页链接。

发布前比对来源数量和陈述，确保 outcomes、decisions/详情、open questions、Issues、goals、constraints、criteria、guidance 全部呈现。可选字段缺失不授权推断内容。不将内部 JSON 返回、board actions、凭据、本地路径或执行报告复制进页面。
