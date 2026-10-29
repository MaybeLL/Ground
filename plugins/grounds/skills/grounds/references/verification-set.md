<a id="read-grounds-verification-evidence"></a>

# 读取 Grounds Verification 证据

审阅或比较需要 Verification 统计/发现时使用本协议。JSON 命令通过共享 helper 调用。

<a id="read-a-fixed-verification-set"></a>

## 读取固定 Verification 集合

当前契约使用 `issue show` / `requirement show`，已知报告用 `verification show ID --json`。审阅历史 Candidate 使用 `review ID --summary --json` 内的准确契约，不以最新 Issue 替代。

1. 读取 `review ID --summary --json`，要求 `patchledger.result.review-summary/v1` 与 `reports_included: false`。统计覆盖完整集合，但正文未读。
2. 读取 `verification list --candidate ID --paged --json`。Candidate ID、数量、standing、各结论计数和 digest 必须匹配摘要。通过 `--cursor NEXT_CURSOR` 读到无游标，每页必须属于同一集合。
3. 核对总数、唯一报告 ID 和 digest。digest 是按返回顺序排列条目的 canonical JSON 数组的 SHA-256，键为 `id`（Verification ID）、`candidate_id`、`overall_verdict`、`created_at`（UTC，去掉小数末尾零）、`attribution`。
4. 用 `verification show REPORT_ID --json` 读取相关正文，核对 Candidate 绑定和条目 ID、结论、时间戳、Attribution。总结全部验证者发现前必须读完全部正文；未读正文不能支持具体发现。
5. `VERIFICATION_SET_CHANGED` 或摘要/页面 digest 不匹配时，从摘要重新开始，最多两次；仍变化则报告并发新增阻止稳定读取。缺失/不匹配报告是失败，不可忽略。目录完成后，后续报告不改变此次固定集合；用 digest 和数量标识。

回答中区分完整集合统计、目录读取完成、正文读取完成。盲验/对照协议单独处理，普通 Review 不能用作盲验输入。

<a id="read-ultra-verifications"></a>

## 读取 ultra 报告

每份报告都带 `mode`：`normal` 只含契约部分；`ultra` 额外含质量部分。目录与 Review Summary 中的条目只给 `mode`、整体结论和（ultra）`quality_verdict`/`quality_attribution`；Verification 集合 digest 的条目键不变，不包含这些字段。

总结验证者发现前，ultra 报告必须用 `verification show REPORT_ID --json` 读完整正文：契约部分在 `report`，质量部分在 `quality`（含每个维度的 independent/reconciliation/final、全部 findings 及代码位置）。整体结论取两部分中更保守者，因此不能只看契约部分就说“契约通过”等于通过。blocking 与 non_blocking 发现要分开呈现。历史报告没有 `mode` 的旧记录读出为 `normal`。
