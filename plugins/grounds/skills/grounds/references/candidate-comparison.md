<a id="compare-grounds-candidates"></a>

# 比较 Grounds Candidates

只有用户请求 Candidate 比较时才使用本协议，先遵循交付流程和共享准备协议。

<a id="compare-like-with-like"></a>

## 固定比较参照

先检查 `comparison_basis` 的左右提交、用途和生成规则。默认需求 Review 是候选的固定逻辑 base 到 source；跨候选演变可包含上游更新，不能当作作者净贡献。当前远端观察不改写历史 Review 端点。使用 [Git 归档协议](candidate-archive.md)分别解释本机可用、历史回执、当前远端、完整性、验证与采用。

## 比较同类候选

1. 列出目标 Issue Version 的 Candidates，拒绝跨 Issue Version 比较。
2. 对选定 ID 运行 `candidate compare`。只有用户需要源码详情才请求 `--include-patch` 或 `--pairwise`；明确说明省略、二进制和截断状态。
3. 每个 Candidate 运行 `review ID --summary --json`，取得准确历史契约、确定的 Change Units、作者声明/证据/理由、解释覆盖和完整 Verification 集合统计，不含报告正文。按[固定 Verification 集合协议](verification-set.md)取得发现。历史 v1 Candidate 的 `not_recorded` 是真实覆盖缺口，不用推断理由填补。比较摘要或 digest 不能替代 Review Trace。
4. 依次比较：封存契约符合性、Verification Standing 与争议、逐 Criterion 发现、Change Rationale 覆盖/质量、Claim/Evidence 质量、result-tree 等价性、文件/diff 统计、探索/修订链、实质交付风险。
5. 每份历史 Verification 都相关。后来的 qualified 不抹去 rejected 或争议。任何页或报告无法取得时，报告证据集合不完整，不给出确定偏好。

所有 CLI 查询使用结构化 JSON：

```bash
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke -- candidate compare ID_A ID_B
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke -- review --summary ID_A
python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py" invoke -- review --summary ID_A --at src/example.ts:42
```

总结有意义的区别与不确定性；除非用户提供评分，不编造单一数值分数。
